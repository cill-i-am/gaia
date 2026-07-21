import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { makeAcceptedRunInputCheckpointV1, parseRunId } from "@gaia/core";
import { Effect, FileSystem } from "effect";

import {
  commitAcceptedRunInputCheckpointNoReplace,
  loadAcceptedRunInputCheckpoint,
} from "./accepted-run-input.js";
import { GaiaRuntimeError } from "./errors.js";
import { makeRunPaths } from "./paths.js";

const runId = parseRunId("run-1234567890");

describe("accepted run input persistence", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "commits a strict no-replace checkpoint and reloads the exact body",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-checkpoint-",
          });
          const paths = yield* makeRunPaths(runId, { rootDirectory: root });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const checkpoint = makeCheckpoint();
          const ref = yield* commitAcceptedRunInputCheckpointNoReplace(
            paths,
            checkpoint
          );
          assert.deepEqual(
            yield* loadAcceptedRunInputCheckpoint(paths, ref),
            checkpoint
          );
        })
    );

    it.effect(
      "never replaces an occupied final file, directory, or symlink",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          for (const occupied of ["file", "directory", "symlink"] as const) {
            const root = yield* fs.makeTempDirectory({
              prefix: `gaia-checkpoint-${occupied}-`,
            });
            const paths = yield* makeRunPaths(runId, { rootDirectory: root });
            yield* fs.makeDirectory(paths.root, { recursive: true });
            if (occupied === "file")
              yield* fs.writeFileString(paths.acceptedRunInput, "sentinel");
            else if (occupied === "directory")
              yield* fs.makeDirectory(paths.acceptedRunInput);
            else {
              const target = `${paths.root}/target`;
              yield* fs.writeFileString(target, "sentinel");
              yield* fs.symlink(target, paths.acceptedRunInput);
            }
            const error = yield* Effect.flip(
              commitAcceptedRunInputCheckpointNoReplace(paths, makeCheckpoint())
            );
            assert.instanceOf(error, GaiaRuntimeError);
            if (error instanceof GaiaRuntimeError)
              assert.strictEqual(
                error.code,
                "AcceptedRunInputCheckpointConflict"
              );
          }
        })
    );

    it.effect(
      "fails typed when an event-referenced body is missing or corrupt",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-checkpoint-",
          });
          const paths = yield* makeRunPaths(runId, { rootDirectory: root });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const ref = yield* commitAcceptedRunInputCheckpointNoReplace(
            paths,
            makeCheckpoint()
          );
          yield* fs.writeFileString(paths.acceptedRunInput, "corrupt\n");
          const error = yield* Effect.flip(
            loadAcceptedRunInputCheckpoint(paths, ref)
          );
          assert.instanceOf(error, GaiaRuntimeError);
          if (error instanceof GaiaRuntimeError)
            assert.strictEqual(error.code, "AcceptedRunInputCheckpointCorrupt");
        })
    );
  });
});

function makeCheckpoint() {
  const body = "Implement the accepted slice.";
  return makeAcceptedRunInputCheckpointV1({
    acceptanceKind: "server",
    acceptedSemantics: { profile: { name: "default" } },
    runId,
    spec: {
      body,
      bodyDigest:
        "2219cd63710b19dd3d1266b727f3dfb3bbbc5c6e7860a4874a6b6864e52985a4",
      byteLength: 29,
      title: "Accepted slice",
    },
    version: 1,
  });
}
