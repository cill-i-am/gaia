import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  encodeRunContractJson,
  makeRunContract,
  parseRunId,
  workspaceStructuralDigestV1,
} from "@gaia/core";
import { Effect, FileSystem } from "effect";

import { GaiaRuntimeError } from "./errors.js";
import { loadRun, readEvents } from "./event-store.js";
import { makeRunPaths } from "./paths.js";

describe("event store persistence paths", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "reports invalid events.jsonl records through the typed error channel",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-",
          });
          const runId = parseRunId("run-EventPath1");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(paths.events, "{ not json\n");

          const failure = yield* Effect.flip(readEvents(paths));

          assert.instanceOf(failure, GaiaRuntimeError);
          assert.strictEqual(failure.code, "InvalidJsonLine");
          assert.include(failure.message, "events.jsonl at line 1");
          assert.notInclude(failure.message, cwd);
        })
    );

    it.effect(
      "reports schema-invalid events.jsonl records through the typed error channel",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-",
          });
          const runId = parseRunId("run-EventPath2");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(
            paths.events,
            `${JSON.stringify({ type: "RUN_CREATED" })}\n`
          );

          const failure = yield* Effect.flip(readEvents(paths));

          assert.instanceOf(failure, GaiaRuntimeError);
          assert.strictEqual(failure.code, "InvalidEventLine");
          assert.include(failure.message, "events.jsonl at line 1");
          assert.notInclude(failure.message, cwd);
        })
    );

    it.effect(
      "loads literal historical JSONL as no-contract completed-unverified and ignores stale snapshots",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-legacy-",
          });
          const runId = parseRunId("run-LegacyJs01");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const line = (
            sequence: number,
            type: string,
            payload: Readonly<Record<string, unknown>> = {}
          ) =>
            JSON.stringify({
              payload,
              runId,
              sequence,
              timestamp: `2026-07-19T12:00:0${sequence}.000Z`,
              type,
              version: 1,
            });
          yield* fs.writeFileString(
            paths.events,
            `${[
              line(1, "RUN_CREATED", { specPath: "input.md" }),
              line(2, "WORKSPACE_PREPARED", { workspacePath: "workspace" }),
              line(3, "WORKER_STARTED"),
              line(4, "WORKER_COMPLETED", {
                workerResultPath: "worker-result.json",
              }),
              line(5, "VERIFICATION_STARTED"),
              line(6, "VERIFICATION_COMPLETED", {
                verificationResultPath: "verification-result.json",
              }),
              line(7, "REPORT_STARTED"),
              line(8, "REPORT_COMPLETED", { reportPath: "report.md" }),
            ].join("\n")}\n`
          );
          yield* fs.writeFileString(
            paths.snapshots,
            '{"context":{"verification":"verified"},"version":1}\n'
          );

          const events = yield* readEvents(paths);
          const loaded = yield* loadRun(paths);

          assert.strictEqual(events.length, 8);
          assert.strictEqual(loaded.latestSnapshot?.state, "completed");
          assert.deepInclude(loaded.latestSnapshot?.context["runProof"], {
            aggregate: "completed-unverified",
            kind: "no-contract",
          });
        })
    );

    it.effect(
      "reports literal mixed legacy and contract proof history through the typed channel",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-event-store-mixed-",
          });
          const runId = parseRunId("run-MixedJson1");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const digest = workspaceStructuralDigestV1({
            entries: [],
            version: 1,
          });
          const contract = makeRunContract({
            acceptedOutcomes: [],
            baseDigest: digest,
            baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
            nonGoals: [],
            proofClaims: [],
            runId,
            stopConditions: [],
            targetDigest: digest,
            targetIdentity: {
              kind: "unversionedWorkspace",
              workspacePath: ".",
            },
          });
          const line = (
            sequence: number,
            type: string,
            payload: Readonly<Record<string, unknown>> = {}
          ) =>
            JSON.stringify({
              payload,
              runId,
              sequence,
              timestamp: `2026-07-20T08:00:0${sequence}.000Z`,
              type,
              version: 1,
            });
          yield* fs.writeFileString(
            paths.events,
            `${[
              line(1, "RUN_CREATED", { specPath: "input.md" }),
              line(2, "RUN_CONTRACT_RECORDED", {
                contract: encodeRunContractJson(contract),
              }),
              line(3, "WORKSPACE_PREPARED", { workspacePath: "workspace" }),
              line(4, "WORKER_STARTED"),
              line(5, "WORKER_COMPLETED", {
                workerResultPath: "worker-result.json",
              }),
              line(6, "VERIFICATION_STARTED"),
              line(7, "VERIFICATION_COMPLETED", {
                verificationResultPath: "verification-result.json",
              }),
            ].join("\n")}\n`
          );

          const failures = [
            yield* Effect.flip(readEvents(paths)),
            yield* Effect.flip(loadRun(paths)),
          ];
          for (const failure of failures) {
            assert.instanceOf(failure, GaiaRuntimeError);
            assert.strictEqual(failure.code, "InvalidRunEventHistory");
          }
        })
    );
  });
});
