import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  parseWorkspaceRelativePath,
  type WorkspaceRelativePath,
} from "@gaia/core";
import { Effect, FileSystem } from "effect";

import { GaiaRuntimeError } from "./errors.js";
import {
  productOnlyWorkspaceDiff,
  readWorkspaceSnapshot,
  snapshotWorkspace,
  type WorkspaceSnapshot,
  writeWorkspaceSnapshot,
} from "./workspace-snapshot.js";

describe("workspace snapshot persistence", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("round-trips persisted workspace-relative paths", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({
          prefix: "gaia-workspace-snapshot-",
        });
        const snapshotPath = `${cwd}/snapshot.json`;
        const generatedPath = parseWorkspaceRelativePath(".gaia");
        const productPath = parseWorkspaceRelativePath("src/index.ts");
        const snapshot: WorkspaceSnapshot = {
          generatedPathSummaries: new Map([
            [
              generatedPath,
              {
                digest: "generated-digest",
                fileCount: 2,
                path: generatedPath,
                reason: "generated state",
              },
            ],
          ]),
          productFileDigests: new Map([[productPath, "product-digest"]]),
        };

        yield* writeWorkspaceSnapshot(snapshotPath, snapshot);
        const persisted = yield* readWorkspaceSnapshot(snapshotPath);

        assert.deepEqual(
          [...persisted.generatedPathSummaries.entries()],
          [...snapshot.generatedPathSummaries.entries()]
        );
        assert.deepEqual(
          [...persisted.productFileDigests.entries()],
          [...snapshot.productFileDigests.entries()]
        );

        const workspaceDiff = productOnlyWorkspaceDiff(["src/index.ts"]);
        expectWorkspaceRelativePath(first(workspaceDiff.productChangedPaths));
      })
    );

    it.effect(
      "rejects persisted workspace snapshot paths that escape the workspace",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-snapshot-",
          });
          const snapshotPath = `${cwd}/snapshot.json`;
          yield* fs.writeFileString(
            snapshotPath,
            `${JSON.stringify({
              generatedPaths: [],
              productFiles: [{ digest: "digest", path: "../secret.ts" }],
              version: 1,
            })}\n`
          );

          const failure = yield* Effect.flip(
            readWorkspaceSnapshot(snapshotPath)
          );

          assert.strictEqual(failure.code, "WorkspaceSnapshotReadFailed");
          assert.include(
            failure.message,
            "workspace snapshot contains invalid persisted paths"
          );
        })
    );

    it.effect("classifies invalid write-side snapshots as write failures", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({
          prefix: "gaia-workspace-snapshot-",
        });
        const snapshotPath = `${cwd}/snapshot.json`;
        const snapshot: WorkspaceSnapshot = {
          generatedPathSummaries: new Map(),
          productFileDigests: new Map([
            [parseWorkspaceRelativePath("src/index.ts"), ""],
          ]),
        };

        const failure = yield* Effect.flip(
          writeWorkspaceSnapshot(snapshotPath, snapshot)
        );

        assert.strictEqual(failure.code, "WorkspaceSnapshotWriteFailed");
        assert.include(
          failure.message,
          "workspace snapshot contains invalid persisted paths"
        );
      })
    );

    it.effect(
      "classifies platform read failures as snapshot read failures",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-snapshot-",
          });
          const failure = yield* Effect.flip(
            readWorkspaceSnapshot(`${cwd}/missing/snapshot.json`)
          );

          assert.strictEqual(failure.code, "WorkspaceSnapshotReadFailed");
          assert.include(failure.message, "could not read workspace snapshot");
        })
    );

    it.effect(
      "classifies platform write failures as snapshot write failures",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-snapshot-",
          });
          const snapshotPath = `${cwd}/snapshot-directory`;
          const productPath = parseWorkspaceRelativePath("src/index.ts");
          const snapshot: WorkspaceSnapshot = {
            generatedPathSummaries: new Map(),
            productFileDigests: new Map([[productPath, "digest"]]),
          };
          yield* fs.makeDirectory(snapshotPath);

          const failure = yield* Effect.flip(
            writeWorkspaceSnapshot(snapshotPath, snapshot)
          );

          assert.strictEqual(failure.code, "WorkspaceSnapshotWriteFailed");
          assert.include(failure.message, "could not write workspace snapshot");
        })
    );

    it.effect(
      "returns typed snapshot failures for invalid workspace entry paths",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-snapshot-",
          });
          yield* fs.writeFileString(`${cwd}/src\\feature.ts`, "invalid path\n");

          const failure = yield* Effect.flip(snapshotWorkspace(cwd));

          if (!(failure instanceof GaiaRuntimeError)) {
            assert.fail(
              "Expected invalid workspace entry path to fail with GaiaRuntimeError."
            );
            return;
          }

          assert.strictEqual(failure.code, "WorkspaceSnapshotReadFailed");
          assert.strictEqual(
            failure.message,
            "Gaia workspace snapshot contains a path that is not a valid workspace-relative path."
          );
        })
    );

    it.effect(
      "rejects workspace entries whose canonical path escapes the workspace",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-snapshot-",
          });
          const outside = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-snapshot-outside-",
          });
          yield* fs.writeFileString(`${outside}/secret.ts`, "outside\n");
          yield* fs.symlink(outside, `${cwd}/linked-outside`);

          const failure = yield* Effect.flip(snapshotWorkspace(cwd));

          if (!(failure instanceof GaiaRuntimeError)) {
            assert.fail(
              "Expected escaping workspace entry path to fail with GaiaRuntimeError."
            );
            return;
          }

          assert.strictEqual(failure.code, "WorkspaceSnapshotReadFailed");
          assert.strictEqual(
            failure.message,
            "Gaia workspace snapshot contains an entry outside the workspace root."
          );
        })
    );
  });
});

function first<T>(values: ReadonlyArray<T>) {
  const [value] = values;
  if (value === undefined) {
    assert.fail("Expected at least one workspace path.");
  }

  return value;
}

function expectWorkspaceRelativePath(_path: WorkspaceRelativePath) {
  return undefined;
}
