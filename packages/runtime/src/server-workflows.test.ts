import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { parseRunEvent } from "@gaia/core";
import { Effect, FileSystem } from "effect";
import {
  acceptServerRun,
  continueServerRun,
  reconcileInterruptedServerRuns,
} from "./server-workflows.js";
import { readLocalRun, readLocalRunEvents } from "./run-read-api.js";

describe("server workflow runtime", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("durably accepts markdown content before continuation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-runtime-" });

        const accepted = yield* acceptServerRun({
          rootDirectory: cwd,
          specMarkdown: "---\ntitle: Server run\n---\n\nDo server work.\n",
        });
        const input = yield* fs.readFileString(`${accepted.runDirectory}/input.md`);
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const detail = yield* readLocalRun(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(accepted.status, "accepted");
        assert.strictEqual(input, "---\ntitle: Server run\n---\n\nDo server work.\n");
        assert.strictEqual(events.events.length, 1);
        assert.strictEqual(events.events[0]?.type, "RUN_CREATED");
        assert.strictEqual(events.events[0]?.payload["source"], "server");
        assert.strictEqual(events.events[0]?.payload["specPath"], "input.md");
        assert.strictEqual(detail.state, "preparingWorkspace");
        assert.strictEqual(detail.status, "running");
      }),
    );

    it.effect("continues an accepted server run through the deterministic workflow", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-runtime-" });
        const accepted = yield* acceptServerRun({
          rootDirectory: cwd,
          specMarkdown: "Run through the server continuation.\n",
        });

        const completed = yield* continueServerRun(accepted.runId, {
          rootDirectory: cwd,
        });
        const detail = yield* readLocalRun(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(completed.status, "completed");
        assert.strictEqual(completed.runId, accepted.runId);
        assert.strictEqual(detail.state, "completed");
        assert.strictEqual(detail.latestEventType, "REPORT_COMPLETED");
      }),
    );

    it.effect("appends RUN_FAILED for expected continuation failures", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-runtime-" });
        const accepted = yield* acceptServerRun({
          rootDirectory: cwd,
          specMarkdown: "This input will disappear before continuation.\n",
        });
        yield* fs.remove(`${accepted.runDirectory}/input.md`);

        const exit = yield* Effect.exit(
          continueServerRun(accepted.runId, { rootDirectory: cwd }),
        );
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const lastEvent = events.events.at(-1);

        assert.strictEqual(exit._tag, "Failure");
        assert.strictEqual(lastEvent?.type, "RUN_FAILED");
        assert.strictEqual(lastEvent?.payload["code"], "ServerRunInputMissing");
        assert.strictEqual(lastEvent?.payload["stage"], "preparingWorkspace");
      }),
    );

    it.effect("marks unfinished accepted server runs interrupted on startup reconciliation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-runtime-" });
        const accepted = yield* acceptServerRun({
          rootDirectory: cwd,
          specMarkdown: "Interrupted server run.\n",
        });

        const reconciled = yield* reconcileInterruptedServerRuns({
          rootDirectory: cwd,
        });
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const failed = events.events.at(-1);

        assert.deepEqual(reconciled, [accepted.runId]);
        assert.strictEqual(failed?.type, "RUN_FAILED");
        assert.strictEqual(failed?.payload["code"], "ServerExecutionInterrupted");
        assert.strictEqual(failed?.payload["recoverable"], true);
      }),
    );

    it.effect("does not reconcile direct CLI-created unfinished runs", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-runtime-" });
        const accepted = yield* acceptServerRun({
          rootDirectory: cwd,
          specMarkdown: "Direct marker rewrite.\n",
        });
        const eventText = yield* fs.readFileString(
          `${accepted.runDirectory}/events.jsonl`,
        );
        const event = parseRunEvent(JSON.parse(eventText.trim()));
        const directEvent = {
          ...event,
          payload: {
            specPath: "input.md",
          },
        };
        yield* fs.writeFileString(
          `${accepted.runDirectory}/events.jsonl`,
          `${JSON.stringify(directEvent)}\n`,
        );

        const reconciled = yield* reconcileInterruptedServerRuns({
          rootDirectory: cwd,
        });
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.deepEqual(reconciled, []);
        assert.strictEqual(events.events.length, 1);
      }),
    );
  });
});
