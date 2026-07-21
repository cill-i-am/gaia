import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  parseWorkspaceRelativePath,
  workspaceStructuralDigestV1,
  type WorkspaceRelativePath,
} from "@gaia/core";
import { Effect, FileSystem } from "effect";

import { GaiaRuntimeError } from "./errors.js";
import {
  productOnlyWorkspaceDiff,
  observeVerificationWorkspaceStructuralDigest,
  observeWorkspaceStructuralDigest,
  parseWorkspaceStructuralFileIdentity,
  readWorkspaceSnapshot,
  snapshotWorkspace,
  type WorkspaceSnapshot,
  writeWorkspaceSnapshot,
  type WorkspaceStructuralFileIdentity,
  type WorkspaceStructuralObserver,
} from "./workspace-snapshot.js";

const stableIdentity = parseWorkspaceStructuralFileIdentity({
  ctimeNs: "10",
  dev: "1",
  ino: "2",
  kind: "regular-file",
  mtimeNs: "9",
  nlink: "1",
  size: "1",
});

const fakeStructuralObserver = (
  change: Record<string, unknown> = {},
  target: "afterHandle" | "finalPath" = "afterHandle"
): WorkspaceStructuralObserver => ({
  enumerate: async () => ["src/a.ts"],
  readFile: async () => ({
    afterHandle:
      target === "afterHandle"
        ? parseWorkspaceStructuralFileIdentity({ ...stableIdentity, ...change })
        : stableIdentity,
    beforeHandle: stableIdentity,
    beforePath: stableIdentity,
    bytes: new TextEncoder().encode("a"),
    finalPath:
      target === "finalPath"
        ? parseWorkspaceStructuralFileIdentity({ ...stableIdentity, ...change })
        : stableIdentity,
  }),
});

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

describe("workspace structural observation", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "rejects a symlink even when its name is excluded from product snapshots",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-verification-observation-",
          });
          const outside = yield* fs.makeTempDirectory({
            prefix: "gaia-verification-observation-outside-",
          });
          yield* fs.symlink(outside, `${cwd}/node_modules`);

          const failure = yield* Effect.flip(
            observeVerificationWorkspaceStructuralDigest(cwd)
          );

          assert.strictEqual(
            failure.code,
            "WorkspaceStructuralObservationChanged"
          );
          assert.include(failure.message, "unsupported symlink");
        })
    );

    it.effect("enforces deterministic entry and byte bounds", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({
          prefix: "gaia-verification-observation-",
        });
        yield* fs.writeFileString(`${cwd}/a.txt`, "abc");
        yield* fs.writeFileString(`${cwd}/b.txt`, "def");

        const entryFailure = yield* Effect.flip(
          observeVerificationWorkspaceStructuralDigest(cwd, { maxEntries: 1 })
        );
        const fileFailure = yield* Effect.flip(
          observeVerificationWorkspaceStructuralDigest(cwd, {
            maxFileBytes: 2,
          })
        );
        const totalFailure = yield* Effect.flip(
          observeVerificationWorkspaceStructuralDigest(cwd, {
            maxTotalBytes: 5,
          })
        );

        assert.strictEqual(
          entryFailure.code,
          "WorkspaceStructuralObservationFailed"
        );
        assert.strictEqual(
          fileFailure.code,
          "WorkspaceStructuralObservationFailed"
        );
        assert.strictEqual(
          totalFailure.code,
          "WorkspaceStructuralObservationFailed"
        );
      })
    );

    it.effect("records the explicit non-atomic observation limitation", () =>
      Effect.gen(function* () {
        const observed = yield* observeWorkspaceStructuralDigest(".", {
          observer: fakeStructuralObserver(),
        });

        assert.strictEqual(
          observed.digest,
          workspaceStructuralDigestV1(observed.manifest)
        );
        assert.deepEqual(observed.receipt.proofLimitations, [
          "not-an-atomic-filesystem-snapshot",
          "metadata-stable-concurrent-rewrite-may-be-undetected",
        ]);
      })
    );

    it.effect("fails on a changed path set", () =>
      Effect.gen(function* () {
        let enumeration = 0;
        const observer: WorkspaceStructuralObserver = {
          ...fakeStructuralObserver(),
          enumerate: async () =>
            enumeration++ === 0 ? ["src/a.ts"] : ["src/a.ts", "src/b.ts"],
        };
        const failure = yield* Effect.flip(
          observeWorkspaceStructuralDigest(".", { observer })
        );
        assert.strictEqual(
          failure.code,
          "WorkspaceStructuralObservationChanged"
        );
      })
    );

    for (const [label, change, target] of [
      ["identity", { ino: "3" }, "afterHandle"],
      ["kind", { kind: "symlink" }, "finalPath"],
      ["size", { size: "2" }, "afterHandle"],
      ["mtime", { mtimeNs: "11" }, "afterHandle"],
      ["ctime", { ctimeNs: "12" }, "afterHandle"],
      ["link count", { nlink: "2" }, "afterHandle"],
    ] as const) {
      it.effect(`fails on observable ${label} drift`, () =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            observeWorkspaceStructuralDigest(".", {
              observer: fakeStructuralObserver(change, target),
            })
          );
          assert.strictEqual(
            failure.code,
            "WorkspaceStructuralObservationChanged"
          );
        })
      );
    }

    it.effect(
      "does not pretend to detect a metadata-stable same-size rewrite",
      () =>
        Effect.gen(function* () {
          const observer = fakeStructuralObserver();
          const rewritten: WorkspaceStructuralObserver = {
            ...observer,
            readFile: async (...args) => ({
              ...(await observer.readFile(...args)),
              bytes: new TextEncoder().encode("b"),
            }),
          };
          const observed = yield* observeWorkspaceStructuralDigest(".", {
            observer: rewritten,
          });

          assert.strictEqual(
            observed.digest,
            workspaceStructuralDigestV1(observed.manifest)
          );
          assert.include(
            observed.receipt.proofLimitations,
            "metadata-stable-concurrent-rewrite-may-be-undetected"
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
