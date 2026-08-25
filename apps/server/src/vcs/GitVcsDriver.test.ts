import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/t3-index",
      },
      appendTruncationMarker: true,
    });

    assert.deepStrictEqual(observedEnv, {
      GIT_INDEX_FILE: "/tmp/t3-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

const checkpointRef = (name: string) => CheckpointRef.make(`refs/t3/checkpoints/test/${name}`);

const initRepo = (cwd: string) =>
  Effect.gen(function* () {
    yield* runGit(cwd, ["init"]);
    yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test"]);
  });

const commitAll = (cwd: string, message: string) =>
  Effect.gen(function* () {
    yield* runGit(cwd, ["add", "-A"]);
    yield* runGit(cwd, ["commit", "-m", message]);
  });

const writeFileAt = (absolutePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  });

/**
 * A superproject with one initialised submodule, both holding a first commit. The submodule's
 * origin is a third repository so `git submodule add` has a URL to clone from.
 */
const makeSuperprojectWithSubmodule = Effect.fn("makeSuperprojectWithSubmodule")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-submodule-" });

  const originPath = path.join(root, "origin");
  yield* fileSystem.makeDirectory(originPath, { recursive: true });
  yield* initRepo(originPath);
  yield* writeFileAt(path.join(originPath, "library.ts"), "export const value = 1;\n");
  yield* commitAll(originPath, "origin: initial");

  const superprojectPath = path.join(root, "superproject");
  yield* fileSystem.makeDirectory(superprojectPath, { recursive: true });
  yield* initRepo(superprojectPath);
  yield* writeFileAt(path.join(superprojectPath, "app.ts"), "export const app = 1;\n");
  yield* commitAll(superprojectPath, "superproject: initial");
  yield* runGit(superprojectPath, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    originPath,
    "vendor/library",
  ]);
  yield* commitAll(superprojectPath, "superproject: add submodule");

  return {
    superprojectPath,
    submodulePath: path.join(superprojectPath, "vendor", "library"),
  };
});

const checkpointsOf = Effect.gen(function* () {
  const driver = yield* VcsDriver.VcsDriver;
  assert.isDefined(driver.checkpoints);
  return driver.checkpoints;
});

it.effect("checkpoint diff carries uncommitted submodule edits as file changes", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const checkpoints = yield* checkpointsOf;
    const { superprojectPath, submodulePath } = yield* makeSuperprojectWithSubmodule();

    yield* checkpoints.captureCheckpoint({
      cwd: superprojectPath,
      checkpointRef: checkpointRef("turn/0"),
    });

    yield* writeFileAt(path.join(submodulePath, "library.ts"), "export const value = 2;\n");
    yield* writeFileAt(path.join(submodulePath, "added.ts"), "export const added = true;\n");
    yield* writeFileAt(path.join(superprojectPath, "app.ts"), "export const app = 2;\n");

    yield* checkpoints.captureCheckpoint({
      cwd: superprojectPath,
      checkpointRef: checkpointRef("turn/1"),
    });

    const diff = yield* checkpoints.diffCheckpoints({
      cwd: superprojectPath,
      fromCheckpointRef: checkpointRef("turn/0"),
      toCheckpointRef: checkpointRef("turn/1"),
      ignoreWhitespace: false,
    });

    assert.include(diff, "diff --git a/app.ts b/app.ts");
    assert.include(diff, "diff --git a/vendor/library/library.ts b/vendor/library/library.ts");
    assert.include(diff, "diff --git a/vendor/library/added.ts b/vendor/library/added.ts");
    assert.include(diff, "-export const value = 1;");
    assert.include(diff, "+export const value = 2;");
  }).pipe(Effect.provide(GitContractLayer)),
);

it.effect("checkpoint diff shows submodule file changes instead of the gitlink commit", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const checkpoints = yield* checkpointsOf;
    const { superprojectPath, submodulePath } = yield* makeSuperprojectWithSubmodule();

    yield* checkpoints.captureCheckpoint({
      cwd: superprojectPath,
      checkpointRef: checkpointRef("turn/0"),
    });

    yield* writeFileAt(path.join(submodulePath, "library.ts"), "export const value = 3;\n");
    yield* commitAll(submodulePath, "library: bump value");

    yield* checkpoints.captureCheckpoint({
      cwd: superprojectPath,
      checkpointRef: checkpointRef("turn/1"),
    });

    const diff = yield* checkpoints.diffCheckpoints({
      cwd: superprojectPath,
      fromCheckpointRef: checkpointRef("turn/0"),
      toCheckpointRef: checkpointRef("turn/1"),
      ignoreWhitespace: false,
    });

    assert.include(diff, "diff --git a/vendor/library/library.ts b/vendor/library/library.ts");
    assert.include(diff, "+export const value = 3;");
    assert.notInclude(diff, "Subproject commit");
  }).pipe(Effect.provide(GitContractLayer)),
);

it.effect("checkpoint restore rewinds submodule files, and deleting sweeps submodule refs", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const checkpoints = yield* checkpointsOf;
    const { superprojectPath, submodulePath } = yield* makeSuperprojectWithSubmodule();

    yield* checkpoints.captureCheckpoint({
      cwd: superprojectPath,
      checkpointRef: checkpointRef("turn/0"),
    });

    yield* writeFileAt(path.join(submodulePath, "library.ts"), "export const value = 4;\n");

    assert.isTrue(
      yield* checkpoints.restoreCheckpoint({
        cwd: superprojectPath,
        checkpointRef: checkpointRef("turn/0"),
      }),
    );
    assert.equal(
      yield* fileSystem.readFileString(path.join(submodulePath, "library.ts")),
      "export const value = 1;\n",
    );

    yield* checkpoints.deleteCheckpointRefs({
      cwd: superprojectPath,
      checkpointRefs: [checkpointRef("turn/0")],
    });

    const submoduleRefs = yield* Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      return yield* driver.execute({
        operation: "GitVcsDriver.test.listRefs",
        cwd: submodulePath,
        args: ["for-each-ref", "--format=%(refname)", "refs/t3"],
      });
    });
    assert.equal(submoduleRefs.stdout.trim(), "");
  }).pipe(Effect.provide(GitContractLayer)),
);

it.effect("checkpoint diff keeps a renamed submodule file under its submodule path", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const checkpoints = yield* checkpointsOf;
    const { superprojectPath, submodulePath } = yield* makeSuperprojectWithSubmodule();

    yield* checkpoints.captureCheckpoint({
      cwd: superprojectPath,
      checkpointRef: checkpointRef("turn/0"),
    });

    yield* writeFileAt(path.join(submodulePath, "renamed.ts"), "export const value = 1;\n");
    yield* fileSystem.remove(path.join(submodulePath, "library.ts"));

    yield* checkpoints.captureCheckpoint({
      cwd: superprojectPath,
      checkpointRef: checkpointRef("turn/1"),
    });

    const diff = yield* checkpoints.diffCheckpoints({
      cwd: superprojectPath,
      fromCheckpointRef: checkpointRef("turn/0"),
      toCheckpointRef: checkpointRef("turn/1"),
      ignoreWhitespace: false,
    });

    // Git writes `rename from`/`rename to` relative to the submodule, and readers trust
    // those lines over the header, so the rename has to arrive as a delete and an add.
    assert.notInclude(diff, "rename from");
    assert.include(diff, "diff --git a/vendor/library/library.ts b/vendor/library/library.ts");
    assert.include(diff, "diff --git a/vendor/library/renamed.ts b/vendor/library/renamed.ts");
  }).pipe(Effect.provide(GitContractLayer)),
);
