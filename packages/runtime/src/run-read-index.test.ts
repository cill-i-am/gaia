import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { makeLocalRunReadIndex } from "./run-read-index.js";
import { makeRunStorePaths } from "./paths.js";
import { readLocalRun } from "./run-read-api.js";
import { acceptServerRun, continueServerRun } from "./server-workflows.js";
import { runSpecFile } from "./workflows.js";

describe("local run read index", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("rebuilds deterministically and refreshes runs without rescanning list", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-run-index-" });
        const firstSpec = `${cwd}/first.md`;
        const secondSpec = `${cwd}/second.md`;
        yield* fs.writeFileString(firstSpec, "First indexed run.\n");
        const first = yield* runSpecFile(firstSpec, { rootDirectory: cwd });
        const index = yield* makeLocalRunReadIndex({ rootDirectory: cwd });

        yield* fs.writeFileString(secondSpec, "Second direct run.\n");
        const second = yield* runSpecFile(secondSpec, { rootDirectory: cwd });
        const staleList = yield* index.list;

        assert.deepEqual(
          staleList.runs.map((run) => run.runId),
          [first.runId],
        );

        yield* index.refreshRun(second.runId);
        const refreshedList = yield* index.list;
        const refreshedDetail = yield* index.read(second.runId);
        const directDetail = yield* readLocalRun(second.runId, { rootDirectory: cwd });

        assert.deepEqual(
          refreshedList.runs.map((run) => run.runId),
          [second.runId, first.runId].sort().reverse(),
        );
        assert.deepEqual(refreshedDetail, directDetail);
      }),
    );

    it.effect("keeps startup diagnostics for bad run directories", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-run-index-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Indexed diagnostics.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        yield* fs.makeDirectory(`${store.runsRoot}/run-not-valid`);
        yield* fs.makeDirectory(`${store.runsRoot}/run-L84-kMhLY8`);

        const index = yield* makeLocalRunReadIndex({ rootDirectory: cwd });
        const list = yield* index.list;

        assert.deepEqual(
          list.runs.map((run) => run.runId),
          [summary.runId],
        );
        assert.deepEqual(
          list.diagnostics.map((diagnostic) => diagnostic.code).sort(),
          ["InvalidRunDirectory", "RunHasNoEvents"],
        );
      }),
    );

    it.effect("preserves parseable bad-run diagnostics for detail reads", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-run-index-" });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        yield* fs.makeDirectory(`${store.runsRoot}/run-L84-kMhLY8`, {
          recursive: true,
        });

        const index = yield* makeLocalRunReadIndex({ rootDirectory: cwd });
        const diagnostic = yield* Effect.flip(index.read("run-L84-kMhLY8"));

        assert.strictEqual(diagnostic.code, "RunHasNoEvents");
        assert.strictEqual(
          diagnostic.message,
          "Run has no events.jsonl records.",
        );
        assert.strictEqual(diagnostic.recoverable, false);
        assert.strictEqual(diagnostic.runId, "run-L84-kMhLY8");
      }),
    );

    it.effect("removes stale indexed runs when a targeted refresh finds them missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-run-index-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Delete this indexed run.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        const index = yield* makeLocalRunReadIndex({ rootDirectory: cwd });

        yield* fs.remove(`${store.runsRoot}/${summary.runId}`, { recursive: true });
        yield* index.refreshRun(summary.runId);
        const list = yield* index.list;
        const missing = yield* Effect.flip(index.read(summary.runId));
        const directMissing = yield* Effect.flip(
          readLocalRun(summary.runId, { rootDirectory: cwd }),
        );

        assert.deepEqual(list.runs, []);
        assert.deepEqual(missing, directMissing);
      }),
    );

    it.effect("refreshes terminal server workflow projections from events.jsonl", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-run-index-" });
        const accepted = yield* acceptServerRun(
          { specMarkdown: "Refresh this server run.\n" },
          { rootDirectory: cwd },
        );
        const index = yield* makeLocalRunReadIndex({ rootDirectory: cwd });
        const acceptedDetail = yield* index.read(accepted.runId);

        yield* continueServerRun(accepted.runId, { rootDirectory: cwd });
        const staleDetail = yield* index.read(accepted.runId);
        yield* index.refreshRun(accepted.runId);
        const refreshedDetail = yield* index.read(accepted.runId);
        const directDetail = yield* readLocalRun(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(acceptedDetail.latestEventType, "RUN_CREATED");
        assert.strictEqual(staleDetail.latestEventType, "RUN_CREATED");
        assert.strictEqual(refreshedDetail.latestEventType, "REPORT_COMPLETED");
        assert.deepEqual(refreshedDetail, directDetail);
      }),
    );
  });
});
