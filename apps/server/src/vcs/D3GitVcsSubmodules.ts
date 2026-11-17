import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type * as VcsDriver from "./VcsDriver.ts";

/**
 * Submodule-aware checkpoint diffs. A superproject tree records one gitlink per submodule, so
 * edits inside one are invisible to its diff. `GitVcsDriver.ts` captures, restores and deletes
 * a checkpoint ref in each submodule; these operations diff each submodule between its own
 * refs and append the result to the workspace diff.
 */

/**
 * How many levels of submodule a checkpoint diff follows. Deeper submodules show in the diff
 * as a gitlink change only.
 */
const CHECKPOINT_SUBMODULE_MAX_DEPTH = 1;

/**
 * Mirrors `CHECKPOINT_DIFF_MAX_OUTPUT_BYTES` in `GitVcsDriver.ts`, so a submodule diff is held
 * to the same ceiling as the workspace diff it is concatenated with.
 */
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

/**
 * A submodule working tree a checkpoint has to visit in its own right.
 *
 * `prefix` is the path from the workspace root down to this working tree, with a trailing
 * slash, in the forward-slash form Git writes into a patch header. `parentCwd` is the
 * repository whose gitlink points here.
 */
export interface CheckpointSubmoduleRepo {
  readonly cwd: string;
  readonly relativePath: string;
  readonly prefix: string;
  readonly parentCwd: string;
}

export interface CheckpointSubmodulesDeps {
  readonly execute: VcsDriver.VcsDriver["Service"]["execute"];
}

/**
 * Rewrites `git diff --numstat -z` output so every path starts with `prefix`. A record is
 * `added\tdeleted\tpath` terminated by NUL. Rename records never occur here because submodule
 * diffs run with `--no-renames`.
 */
function prefixNumstatPaths(numstat: string, prefix: string): string {
  return numstat
    .split("\0")
    .map((record) => {
      const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
      return counts ? `${counts[0]}${prefix}${record.slice(counts[0].length)}` : record;
    })
    .join("\0");
}

export const make = Effect.fn("D3GitVcsSubmodules.make")(function* ({
  execute,
}: CheckpointSubmodulesDeps) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const declaredSubmodulePaths = Effect.fn("GitVcsDriver.checkpoints.declaredSubmodulePaths")(
    function* (cwd: string) {
      const hasGitmodules = yield* fileSystem
        .exists(path.join(cwd, ".gitmodules"))
        .pipe(Effect.orElseSucceed(() => false));
      if (!hasGitmodules) {
        return [] as ReadonlyArray<string>;
      }

      const result = yield* execute({
        operation: "GitVcsDriver.checkpoints.declaredSubmodulePaths",
        cwd,
        args: ["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\..+\\.path$"],
        allowNonZeroExit: true,
      });
      if (result.exitCode !== 0) {
        return [] as ReadonlyArray<string>;
      }

      // `git config -z` writes one `key\nvalue` record per NUL, so the value is whatever
      // follows the first newline and needs no unquoting.
      const submodulePaths: string[] = [];
      for (const record of result.stdout.split("\0")) {
        const separator = record.indexOf("\n");
        if (separator < 0) {
          continue;
        }
        const submodulePath = record.slice(separator + 1);
        if (submodulePath.length === 0 || submodulePath.startsWith("/")) {
          continue;
        }
        if (submodulePath.split("/").some((segment) => segment === "..")) {
          continue;
        }
        submodulePaths.push(submodulePath.replace(/\/+$/, ""));
      }
      return submodulePaths as ReadonlyArray<string>;
    },
  );

  /**
   * Every submodule working tree under a workspace, nearest level first.
   *
   * A nested repository that no `.gitmodules` declares is absent on purpose: `git add` in the
   * superproject never captured it either, and it is usually somebody else's checkout that
   * happens to sit in the tree.
   */
  const listRepos = Effect.fn("GitVcsDriver.checkpoints.listSubmoduleRepos")(function* (
    workspaceCwd: string,
  ) {
    const discovered: CheckpointSubmoduleRepo[] = [];
    let frontier: ReadonlyArray<{ readonly cwd: string; readonly prefix: string }> = [
      { cwd: workspaceCwd, prefix: "" },
    ];

    for (let depth = 0; depth < CHECKPOINT_SUBMODULE_MAX_DEPTH && frontier.length > 0; depth++) {
      const nextFrontier: Array<{ readonly cwd: string; readonly prefix: string }> = [];
      for (const parent of frontier) {
        const submodulePaths = yield* declaredSubmodulePaths(parent.cwd).pipe(
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
        for (const relativePath of submodulePaths) {
          const submoduleCwd = path.join(parent.cwd, relativePath);
          // An uninitialised submodule is an empty directory with no `.git` and nothing to
          // capture. Its gitlink stays in the parent diff, which is all there is to say.
          const isInitialised = yield* fileSystem
            .exists(path.join(submoduleCwd, ".git"))
            .pipe(Effect.orElseSucceed(() => false));
          if (!isInitialised) {
            continue;
          }
          const repo: CheckpointSubmoduleRepo = {
            cwd: submoduleCwd,
            relativePath,
            prefix: `${parent.prefix}${relativePath}/`,
            parentCwd: parent.cwd,
          };
          discovered.push(repo);
          nextFrontier.push({ cwd: repo.cwd, prefix: repo.prefix });
        }
      }
      frontier = nextFrontier;
    }

    return discovered as ReadonlyArray<CheckpointSubmoduleRepo>;
  });

  /**
   * Pathspecs that drop the submodules handled separately, so no gitlink is reported twice.
   *
   * A repository with no submodule of its own gets no pathspec at all, which leaves its diff
   * exactly as it was before checkpoints followed submodules.
   */
  const excludeArgs = (
    repoCwd: string,
    submoduleRepos: ReadonlyArray<CheckpointSubmoduleRepo>,
    filePaths?: ReadonlyArray<string>,
  ): ReadonlyArray<string> => {
    const directChildren = submoduleRepos.filter((repo) => repo.parentCwd === repoCwd);
    if (directChildren.length === 0) {
      return [];
    }
    const excludes = directChildren.map((repo) => `:(exclude)${repo.relativePath}`);
    // A caller that names its own files has already written the `--` and the paths.
    return filePaths ? excludes : ["--", ".", ...excludes];
  };

  /**
   * The `git diff` arguments a submodule patch is built from.
   *
   * This mirrors the inline argument list in `checkpoints.diffCheckpoints` in
   * `GitVcsDriver.ts`, with the submodule's path from the workspace root pushed into the patch
   * header prefixes in place of upstream's bare `a/` and `b/`. Keep the two in step.
   */
  const submodulePatchArgs = (
    input: VcsDriver.VcsDiffCheckpointsInput,
    sourceRevision: string,
    targetRevision: string,
    prefix: string,
  ): ReadonlyArray<string> => [
    "diff",
    ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    `--src-prefix=a/${prefix}`,
    `--dst-prefix=b/${prefix}`,
    ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
    sourceRevision,
    targetRevision,
  ];

  /**
   * The workspace patch with each submodule's own patch concatenated onto it.
   *
   * Each submodule diffs against its own pair of checkpoints, with the path from the workspace
   * root pushed into the patch header. The result concatenates into one patch whose paths are
   * all workspace-relative, which is what every reader downstream expects.
   */
  const appendPatches = Effect.fn("GitVcsDriver.checkpoints.appendSubmodulePatches")(function* (
    input: VcsDriver.VcsDiffCheckpointsInput,
    submoduleRepos: ReadonlyArray<CheckpointSubmoduleRepo>,
    workspacePatch: string,
  ) {
    const submodulePatches = yield* Effect.forEach(submoduleRepos, (repo) =>
      Effect.gen(function* () {
        const fromCommit = yield* resolveCheckpointCommit(repo.cwd, input.fromCheckpointRef);
        const toCommit = yield* resolveCheckpointCommit(repo.cwd, input.toCheckpointRef);
        // Both ends have to exist: a thread that started before this submodule was
        // checkpointed has no baseline to compare against, and inventing one would report
        // the whole submodule as new.
        if (!fromCommit || !toCommit) {
          return "";
        }

        const submoduleResult = yield* execute({
          operation: "GitVcsDriver.checkpoints.diffCheckpoints",
          cwd: repo.cwd,
          args: [
            ...submodulePatchArgs(input, fromCommit, toCommit, repo.prefix),
            // Git writes `rename from`/`rename to` relative to the repository it ran in,
            // and no prefix option reaches those two lines. A reader that trusts them
            // would file a renamed submodule file at the workspace root. Reporting the
            // rename as a delete and an add keeps every path in the patch correct.
            "--no-renames",
            ...excludeArgs(repo.cwd, submoduleRepos),
          ],
          allowNonZeroExit: true,
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: input.format === "numstat" ? "error" : "truncate",
        });
        if (submoduleResult.exitCode !== 0) {
          return "";
        }
        // A numstat record carries its path in the body, where no prefix option reaches, so
        // the submodule's path from the workspace root is pushed onto each record here.
        return input.format === "numstat"
          ? prefixNumstatPaths(submoduleResult.stdout, repo.prefix)
          : submoduleResult.stdout;
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("checkpoint diff skipped a submodule", {
            workspaceCwd: input.cwd,
            submodulePath: repo.prefix,
            detail: error.message,
          }),
        ),
        Effect.orElseSucceed(() => ""),
      ),
    );

    const patches = [workspacePatch, ...submodulePatches].filter((patch) => patch.length > 0);
    // numstat records are NUL-terminated already; a newline between chunks would hide the
    // record that follows it from the reader.
    return input.format === "numstat"
      ? patches.join("")
      : patches.map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`)).join("");
  });

  return {
    listRepos,
    excludeArgs,
    appendPatches,
  } as const;
});
