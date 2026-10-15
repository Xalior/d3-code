import * as NodeBuffer from "node:buffer";

import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { VcsProcessExitError } from "@t3tools/contracts";
import { splitNullSeparatedGitStdoutPaths } from "./GitVcsDriverCore.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

/**
 * Submodule-aware checkpoints.
 *
 * A submodule keeps its files in its own repository, so a superproject checkpoint tree records
 * one gitlink commit for the whole of it. A turn that edits a file inside a submodule therefore
 * leaves no trace in the superproject diff at all, and a turn that commits inside one leaves a
 * `Subproject commit` line instead of the change. The operations here visit each submodule
 * working tree separately so both cases show the files themselves.
 *
 * `GitVcsDriver.ts` owns the workspace-level half of every checkpoint operation and calls into
 * this module afterwards. Nothing here replaces what that file does; it only reaches the
 * repositories that file never enters.
 */

/**
 * How many levels of submodule a checkpoint follows.
 *
 * Every level costs a full `git add -A` in each repository it reaches, and a deeply nested
 * workspace makes that ruinous: one measured workspace holds 628 submodule working trees
 * five levels down, where following all of them turns a sub-second capture into minutes.
 * One level covers the submodules a workspace is normally edited through, and anything
 * deeper keeps the old behaviour: its gitlink commit is recorded, its files are not.
 */
const CHECKPOINT_SUBMODULE_MAX_DEPTH = 1;

// The same limits `GitVcsDriver.ts` puts on checkpoint capture. Keep the two in step.
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_RECOVERY_MAX_CANDIDATES = 64;
const CHECKPOINT_RECOVERY_TIMEOUT = "5 seconds";

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
  /**
   * The git config arguments the root driver puts in front of every command that
   * writes a checkpoint, so its objects and refs reach the disk before they are
   * published. Submodule checkpoints must not be less durable than the root's.
   */
  readonly durableWrite: ReadonlyArray<string>;
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

export const make = ({ execute, durableWrite }: CheckpointSubmodulesDeps) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const vcsProcess = yield* VcsProcess.VcsProcess;

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

    const hasHeadCommit = (cwd: string, env?: NodeJS.ProcessEnv) =>
      execute({
        operation: "GitVcsDriver.checkpoints.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
        ...(env !== undefined ? { env } : {}),
      }).pipe(Effect.map((result) => result.exitCode === 0));

    const resolveGitCommonDir = (cwd: string) =>
      Effect.gen(function* () {
        const result = yield* execute({
          operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
          cwd,
          args: ["rev-parse", "--git-common-dir"],
        });
        const gitCommonDir = result.stdout.trim();
        return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
      });

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
    ): ReadonlyArray<string> => {
      const directChildren = submoduleRepos.filter((repo) => repo.parentCwd === repoCwd);
      if (directChildren.length === 0) {
        return [];
      }
      return ["--", ".", ...directChildren.map((repo) => `:(exclude)${repo.relativePath}`)];
    };

    /**
     * Writes one checkpoint commit for a single repository.
     *
     * This mirrors the body of `checkpoints.captureCheckpoint` in `GitVcsDriver.ts`, which does
     * the same work for the workspace root. Keep the two in step.
     */
    const captureCheckpointTree = Effect.fn("GitVcsDriver.checkpoints.captureCheckpointTree")(
      function* (cwd: string, checkpointRef: string) {
        const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
        const indexConfig = [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "sparse.expectFilesOutsideOfPatterns=false",
        ];
        const gitCommonDir = yield* resolveGitCommonDir(cwd);
        const indexId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
        const tempIndexPath = path.join(gitCommonDir, `t3-checkpoint-index-${indexId}`);
        const commitEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_INDEX_FILE: tempIndexPath,
          GIT_AUTHOR_NAME: "T3 Code",
          GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
          GIT_COMMITTER_NAME: "T3 Code",
          GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
        };

        // Forced process termination can leave Git's private index lock behind.
        const cleanupTempIndex = Effect.forEach(
          [tempIndexPath, `${tempIndexPath}.lock`],
          (indexFile) => fileSystem.remove(indexFile, { force: true }).pipe(Effect.ignore),
          { discard: true },
        );

        yield* Effect.gen(function* () {
          const headExists = yield* hasHeadCommit(cwd);
          const sparseConfig = yield* execute({
            operation,
            cwd: cwd,
            args: ["config", "--bool", "core.sparseCheckout"],
            allowNonZeroExit: true,
          });
          let sparseCheckout = sparseConfig.stdout.trim() === "true";
          if (sparseCheckout) {
            const help = yield* execute({
              operation,
              cwd: cwd,
              args: ["add", "-h"],
              allowNonZeroExit: true,
            });
            sparseCheckout = /--(?:\[no-\])?sparse\b/.test(`${help.stdout}${help.stderr}`);
          }
          if (headExists) {
            const reusedIndex = yield* Effect.gen(function* () {
              const indexPath = yield* execute({
                operation,
                cwd: cwd,
                args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
              });
              const { mtime } = yield* fileSystem.stat(indexPath.stdout.trim());
              if (Option.isNone(mtime)) return false;
              // Stay below the source timestamp even if Date rounded up, preserving Git's racy check.
              const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
              if (indexTime <= 0) return false;
              yield* fileSystem.copyFile(indexPath.stdout.trim(), tempIndexPath);
              // Retain stat data only where the copied index already matches HEAD.
              yield* execute({
                operation,
                cwd: cwd,
                args: [...indexConfig, "read-tree", "--reset", "HEAD"],
                env: commitEnv,
              });
              // read-tree can rewrite the index, so restore its racy timestamp afterward.
              yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
              let specialFlags = false;
              let recordStart = true;
              let skipped = false;
              let skippedRecord: number[] = [];
              const skippedPaths: string[] = [];
              yield* vcsProcess.run({
                operation,
                command: "git",
                cwd: cwd,
                args: [...indexConfig, "ls-files", "--full-name", "--sparse", "-v", "-z"],
                env: commitEnv,
                maxOutputBytes: 4_096,
                outputMode: "truncate",
                // Inspect every tag; retain only skipped file paths for checking sparse rules.
                onStdoutChunk: (chunk) => {
                  for (const byte of chunk) {
                    if (recordStart) skipped = byte === 83;
                    if (skipped && sparseCheckout) {
                      if (byte !== 0) skippedRecord.push(byte);
                      else {
                        if (skippedRecord.at(-1) !== 47) {
                          const name = Buffer.from(skippedRecord).subarray(2);
                          if (!NodeBuffer.isUtf8(name)) specialFlags = true;
                          else skippedPaths.push(name.toString("utf8"));
                        }
                        skippedRecord = [];
                      }
                    }
                    if (
                      recordStart &&
                      ((byte >= 97 && byte <= 122) || (!sparseCheckout && byte === 83))
                    ) {
                      specialFlags = true;
                    }
                    recordStart = byte === 0;
                  }
                },
              });
              if (skippedPaths.length > 0 && !specialFlags) {
                const selected = yield* execute({
                  operation,
                  cwd: cwd,
                  args: [...indexConfig, "sparse-checkout", "check-rules", "-z"],
                  stdin: skippedPaths.join("\0") + "\0",
                  env: commitEnv,
                  maxOutputBytes: 1,
                  outputMode: "truncate",
                });
                // Any selected skipped file has a manual flag, not a sparse exclusion.
                specialFlags = selected.stdout.length > 0 || selected.stdoutTruncated;
              }
              // Sparse Git clears skip-worktree for present files. Manual flags still need a reset.
              return !specialFlags;
            }).pipe(Effect.orElseSucceed(() => false));
            if (!reusedIndex) {
              if (sparseCheckout) {
                const cone = yield* execute({
                  operation,
                  cwd: cwd,
                  args: ["config", "--bool", "core.sparseCheckoutCone"],
                  allowNonZeroExit: true,
                });
                // Rebuilding a non-cone index loses exclusions; do not publish false deletions.
                if (cone.stdout.trim() !== "true") {
                  return yield* new VcsProcessExitError({
                    operation,
                    command: "git read-tree",
                    cwd: cwd,
                    exitCode: 1,
                    detail: "Cannot rebuild a checkpoint index for non-cone sparse checkout.",
                  });
                }
              }
              yield* cleanupTempIndex;
              yield* execute({
                operation,
                cwd: cwd,
                // A fresh sparse index represents excluded directories without marking them deleted.
                args: sparseCheckout
                  ? [...indexConfig, "-c", "index.sparse=true", "read-tree", "--reset", "HEAD"]
                  : ["read-tree", "HEAD"],
                env: commitEnv,
              });
            }
          }

          const stageFiles = (exclusions: ReadonlyArray<string>) =>
            execute({
              operation,
              cwd: cwd,
              // Preserve absent skipped entries, but capture present nonignored files outside the cone.
              args: [
                ...indexConfig,
                ...durableWrite,
                "add",
                ...(sparseCheckout ? ["--sparse"] : []),
                "-A",
                "--",
                ".",
                ...exclusions,
              ],
              env: commitEnv,
            });
          yield* stageFiles([]).pipe(
            Effect.catchTags({
              VcsProcessExitError: (error) =>
                Effect.gen(function* () {
                  // Git cannot stage an embedded repository until it has a commit. Discover these
                  // only after staging fails so ordinary checkpoints do not need another file scan.
                  const untracked = yield* execute({
                    operation,
                    cwd: cwd,
                    args: ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
                    env: commitEnv,
                    maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
                  });
                  if (untracked.stdoutTruncated) return yield* error;
                  const candidates = splitNullSeparatedGitStdoutPaths(untracked).filter((entry) =>
                    entry.endsWith("/"),
                  );
                  // Refuse excessive recovery work before probing any nested repositories.
                  if (candidates.length > CHECKPOINT_RECOVERY_MAX_CANDIDATES) return yield* error;
                  // Discover each child's repository instead of inheriting the server's Git bindings.
                  const nestedRepoEnv: NodeJS.ProcessEnv = {
                    ...process.env,
                    GIT_DIR: undefined,
                    GIT_WORK_TREE: undefined,
                    GIT_COMMON_DIR: undefined,
                    GIT_INDEX_FILE: undefined,
                    GIT_OBJECT_DIRECTORY: undefined,
                    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
                  };
                  const exclusions: Array<string> = [];
                  for (const entry of candidates) {
                    const nestedCwd = path.join(cwd, entry);
                    if (
                      (yield* fileSystem
                        .exists(path.join(nestedCwd, ".git"))
                        .pipe(Effect.mapError(() => error))) &&
                      !(yield* hasHeadCommit(nestedCwd, nestedRepoEnv))
                    ) {
                      exclusions.push(`:(exclude,literal)${entry}`);
                    }
                  }
                  if (exclusions.length === 0) return yield* error;
                  return yield* stageFiles(exclusions);
                }).pipe(
                  // One budget covers discovery, queued Git admission, probes, and the staging retry.
                  Effect.timeoutOrElse({
                    duration: CHECKPOINT_RECOVERY_TIMEOUT,
                    orElse: () => Effect.fail(error),
                  }),
                ),
            }),
          );

          const writeTreeResult = yield* execute({
            operation,
            cwd: cwd,
            args: [...indexConfig, ...durableWrite, "write-tree"],
            env: commitEnv,
          });
          const treeOid = writeTreeResult.stdout.trim();
          if (treeOid.length === 0) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git write-tree",
              cwd: cwd,
              exitCode: 0,
              detail: "git write-tree returned an empty tree oid.",
            });
          }

          const message = `t3 checkpoint ref=${checkpointRef}`;
          const commitTreeResult = yield* execute({
            operation,
            cwd: cwd,
            args: [...durableWrite, "commit-tree", treeOid, "-m", message],
            env: commitEnv,
          });
          const commitOid = commitTreeResult.stdout.trim();
          if (commitOid.length === 0) {
            return yield* new VcsProcessExitError({
              operation,
              command: "git commit-tree",
              cwd: cwd,
              exitCode: 0,
              detail: "git commit-tree returned an empty commit oid.",
            });
          }

          yield* execute({
            operation,
            cwd: cwd,
            args: [...durableWrite, "update-ref", checkpointRef, commitOid],
          });
        }).pipe(Effect.ensuring(cleanupTempIndex));
      },
    );

    /**
     * Rewinds a single repository to a checkpoint commit.
     *
     * This mirrors the body of `checkpoints.restoreCheckpoint` in `GitVcsDriver.ts`, which does
     * the same work for the workspace root. Keep the two in step.
     */
    const restoreCheckpointTree = Effect.fn("GitVcsDriver.checkpoints.restoreCheckpointTree")(
      function* (cwd: string, treeCommitOid: string) {
        const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";
        const tracked = yield* execute({
          operation,
          cwd: cwd,
          args: ["ls-files", "--cached", `--with-tree=${treeCommitOid}`, "-z", "--", "."],
        });
        // An empty index and checkpoint have nothing for git restore's pathspec to match.
        if (tracked.stdout.length > 0) {
          yield* execute({
            operation,
            cwd: cwd,
            args: ["restore", "--source", treeCommitOid, "--worktree", "--staged", "--", "."],
          });
        }
        // Restoring away the last tracked file can remove a nested workspace directory.
        yield* fileSystem.makeDirectory(cwd, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new VcsProcessExitError({
                operation,
                command: "git restore",
                cwd: cwd,
                exitCode: 0,
                detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
              }),
          ),
        );
        const cleaned = yield* execute({
          operation,
          cwd: cwd,
          args: ["clean", "-fd", "--", "."],
          allowNonZeroExit: true,
        });
        if (cleaned.exitCode !== 0) {
          // Git can remove every child, then fail trying to remove './' itself.
          const emptiedWorkspace =
            cleaned.exitCode === 1 &&
            /^warning: failed to remove \.\/: [^\n]+$/.test(cleaned.stderr.trim()) &&
            (yield* fileSystem.readDirectory(cwd).pipe(
              Effect.map((entries) => entries.length === 0),
              Effect.orElseSucceed(() => false),
            ));
          if (!emptiedWorkspace)
            return yield* new VcsProcessExitError({
              operation,
              command: "git clean",
              cwd: cwd,
              exitCode: cleaned.exitCode,
              detail: cleaned.stderr.trim() || "Could not clean the checkpoint workspace.",
            });
        }

        const headExists = yield* hasHeadCommit(cwd);
        if (headExists) {
          yield* execute({
            operation,
            cwd: cwd,
            args: ["reset", "--quiet", "--", "."],
          });
        }
      },
    );

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
     * Captures a checkpoint in every submodule of a workspace.
     *
     * A submodule that refuses to capture loses its file-level diff for this turn. The
     * superproject checkpoint is already written and still worth keeping, so warn and go on.
     */
    const captureCheckpoints = Effect.fn("GitVcsDriver.checkpoints.captureSubmoduleCheckpoints")(
      function* (workspaceCwd: string, checkpointRef: string) {
        const submoduleRepos = yield* listRepos(workspaceCwd);
        yield* Effect.forEach(
          submoduleRepos,
          (repo) =>
            captureCheckpointTree(repo.cwd, checkpointRef).pipe(
              Effect.tapError((error) =>
                Effect.logWarning("checkpoint capture skipped a submodule", {
                  workspaceCwd,
                  submodulePath: repo.prefix,
                  detail: error.message,
                }),
              ),
              Effect.orElseSucceed(() => undefined),
            ),
          { discard: true },
        );
      },
    );

    /**
     * Rewinds every submodule of a workspace to its own checkpoint.
     *
     * The superproject restore rewinds the gitlink in its index and leaves the submodule's own
     * files untouched, so each submodule rewinds from the checkpoint captured in it. A submodule
     * with no checkpoint of its own is left exactly as it is.
     */
    const restoreCheckpoints = Effect.fn("GitVcsDriver.checkpoints.restoreSubmoduleCheckpoints")(
      function* (workspaceCwd: string, checkpointRef: string) {
        const submoduleRepos = yield* listRepos(workspaceCwd);
        yield* Effect.forEach(
          submoduleRepos,
          (repo) =>
            Effect.gen(function* () {
              const submoduleCommitOid = yield* resolveCheckpointCommit(repo.cwd, checkpointRef);
              if (!submoduleCommitOid) {
                return;
              }
              yield* restoreCheckpointTree(repo.cwd, submoduleCommitOid);
            }).pipe(
              Effect.tapError((error) =>
                Effect.logWarning("checkpoint restore skipped a submodule", {
                  workspaceCwd,
                  submodulePath: repo.prefix,
                  detail: error.message,
                }),
              ),
              Effect.orElseSucceed(() => undefined),
            ),
          { discard: true },
        );
      },
    );

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

    /**
     * Deletes checkpoint refs from every submodule of a workspace.
     *
     * Every repository the capture wrote a ref into has to be swept, or a submodule keeps the
     * checkpoint commits of threads that are long gone alive. The workspace root is not touched
     * here; `GitVcsDriver.ts` has already swept it.
     */
    const deleteCheckpointRefs = Effect.fn(
      "GitVcsDriver.checkpoints.deleteSubmoduleCheckpointRefs",
    )(function* (workspaceCwd: string, checkpointRefs: ReadonlyArray<string>) {
      const submoduleRepos = yield* listRepos(workspaceCwd).pipe(
        Effect.orElseSucceed((): ReadonlyArray<CheckpointSubmoduleRepo> => []),
      );

      yield* Effect.forEach(
        submoduleRepos,
        (repo) =>
          Effect.forEach(
            checkpointRefs,
            (checkpointRef) =>
              execute({
                operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
                cwd: repo.cwd,
                args: ["update-ref", "-d", checkpointRef],
                allowNonZeroExit: true,
              }).pipe(Effect.orElseSucceed(() => undefined)),
            { discard: true },
          ),
        { discard: true },
      );
    });

    return {
      listRepos,
      excludeArgs,
      captureCheckpoints,
      restoreCheckpoints,
      appendPatches,
      deleteCheckpointRefs,
    } as const;
  });
