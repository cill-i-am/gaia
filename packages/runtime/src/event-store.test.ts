import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { parseRunId } from "@gaia/core";
import { Effect, FileSystem } from "effect";

import { GaiaRuntimeError } from "./errors.js";
import { readEvents } from "./event-store.js";
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
  });
});
