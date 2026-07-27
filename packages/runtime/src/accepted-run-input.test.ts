import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import {
  makeAcceptedRunInputCheckpointV1,
  parseMarkdownSpec,
  parseRunId,
} from "@gaia/core";
import { Effect, FileSystem } from "effect";

import {
  commitAcceptedRunInputCheckpointNoReplace,
  encodeAcceptedRunInputCheckpointBody,
  loadAcceptedRunInputCheckpoint,
  reconstructAcceptedRunSpec,
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

    it("reconstructs the exact accepted V2 RunSpec from the checkpoint", () => {
      const accepted = parseMarkdownSpec(
        readFileSync(
          new URL(
            "../../../examples/specs/claim-verification-v2.md",
            import.meta.url
          ),
          "utf8"
        ),
        "fallback"
      );

      assert.deepEqual(
        reconstructAcceptedRunSpec(makeCheckpoint(accepted)),
        accepted
      );
    });

    it("keeps the fixed accepted checkpoint body bound", () => {
      const checkpoint = makeAcceptedRunInputCheckpointV1({
        ...makeCheckpoint().payload,
        acceptedSemantics: {
          padding: "x".repeat(131_072),
          profile: { name: "default" },
        },
      });

      let error: unknown;
      try {
        encodeAcceptedRunInputCheckpointBody(checkpoint);
      } catch (cause) {
        error = cause;
      }
      assert.instanceOf(error, GaiaRuntimeError);
      if (error instanceof GaiaRuntimeError)
        assert.strictEqual(error.code, "AcceptedRunInputCheckpointTooLarge");
    });

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

function makeCheckpoint(
  spec = parseMarkdownSpec("Implement the accepted slice.", "Accepted slice")
) {
  const { body } = spec;
  return makeAcceptedRunInputCheckpointV1({
    acceptanceKind: "server",
    acceptedSemantics: { profile: { name: "default" } },
    runId,
    spec: {
      body,
      bodyDigest: createHash("sha256").update(body).digest("hex"),
      byteLength: Buffer.byteLength(body, "utf8"),
      title: spec.title,
      ...(spec.verification === undefined
        ? {}
        : { verification: spec.verification }),
    },
    version: 1,
  });
}
