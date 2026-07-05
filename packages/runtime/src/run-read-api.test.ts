import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import {
  listLocalRuns,
  readLocalRun,
  readLocalRunArtifact,
  readLocalRunEvents,
} from "./run-read-api.js";
import { listRunsFromServer, statusRunFromServer } from "./server-read-client.js";
import { makeRunStorePaths } from "./paths.js";
import { listRuns, runSpecFile, statusRun } from "./workflows.js";
import { GaiaRuntimeError } from "./errors.js";

describe("local run read api", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("lists valid runs with diagnostics for malformed run directories", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-read-api-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Expose read model.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        yield* fs.makeDirectory(`${store.runsRoot}/run-not-valid`);
        yield* fs.makeDirectory(`${store.runsRoot}/run-L84-kMhLY8`);

        const result = yield* listLocalRuns({ rootDirectory: cwd });

        assert.deepEqual(
          result.runs.map((run) => run.runId),
          [summary.runId],
        );
        assert.strictEqual(result.diagnostics.length, 2);
        assert.deepInclude(result.diagnostics, {
          code: "InvalidRunDirectory",
          message: "Run directory name is not a valid Gaia run id.",
          pathSegment: "run-not-valid",
          recoverable: false,
        });
        const emptyRunDiagnostic = result.diagnostics.find(
          (diagnostic) => diagnostic.code === "RunHasNoEvents",
        );
        assert.strictEqual(
          emptyRunDiagnostic?.message,
          "Run has no events.jsonl records.",
        );
        assert.strictEqual(emptyRunDiagnostic?.runId, "run-L84-kMhLY8");
      }),
    );

    it.effect("reads one run and its event envelope from events.jsonl", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-read-api-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Read one run.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const run = yield* readLocalRun(summary.runId, { rootDirectory: cwd });
        const events = yield* readLocalRunEvents(summary.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(run.runId, summary.runId);
        assert.strictEqual(run.status, "completed");
        assert.isAbove(run.eventCount, 0);
        assert.include(run.artifacts, "report.json");
        assert.strictEqual(events.runId, summary.runId);
        assert.strictEqual(events.events.length, run.eventCount);
        assert.strictEqual(events.events[0]?.type, "RUN_CREATED");
      }),
    );

    it.effect("fails a malformed requested run with a constrained diagnostic", () =>
      Effect.gen(function* () {
        const diagnostic = yield* Effect.flip(
          readLocalRun("not-a-run-id", { rootDirectory: "." }),
        );

        assert.deepEqual(diagnostic, {
          code: "InvalidRunId",
          message: "Requested run id is not a valid Gaia run id.",
          pathSegment: "not-a-run-id",
          recoverable: false,
        });
      }),
    );

    it.effect("reads allowlisted text artifacts and rejects arbitrary paths", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-read-api-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Read artifacts.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const report = yield* readLocalRunArtifact(
          summary.runId,
          "report.json",
          { rootDirectory: cwd },
        );
        const rejected = yield* Effect.flip(
          readLocalRunArtifact(summary.runId, "../events.jsonl", {
            rootDirectory: cwd,
          }),
        );

        assert.strictEqual(report.artifactName, "report.json");
        assert.strictEqual(report.contentType, "application/json");
        assert.include(report.body, summary.runId);
        assert.deepEqual(rejected, {
          artifactName: "../events.jsonl",
          code: "ArtifactNotAllowed",
          message: "Artifact is not allowlisted for local API reads.",
          recoverable: false,
          runId: summary.runId,
        });
      }),
    );

    it.effect("matches direct run list and status summaries through server envelopes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-read-api-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Read through server.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const directList = yield* listRuns({ rootDirectory: cwd });
        const directStatus = yield* statusRun(summary.runId, {
          rootDirectory: cwd,
        });
        const runList = yield* listLocalRuns({ rootDirectory: cwd });
        const runDetail = yield* readLocalRun(summary.runId, {
          rootDirectory: cwd,
        });
        const fetcher = envelopeFetch({
          "/runs": { data: runList, status: "success" },
          [`/runs/${summary.runId}`]: { data: runDetail, status: "success" },
        });

        const serverList = yield* listRunsFromServer({
          fetch: fetcher,
          rootDirectory: cwd,
          serverUrl: "http://127.0.0.1:8787",
        });
        const serverStatus = yield* statusRunFromServer(summary.runId, {
          fetch: fetcher,
          rootDirectory: cwd,
          serverUrl: "http://127.0.0.1:8787",
        });

        assert.deepEqual(serverList, directList);
        assert.deepEqual(serverStatus, directStatus);
      }),
    );

    it.effect("fails clearly when the opted-in server is unavailable", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          listRunsFromServer({
            fetch: () => Promise.reject(new Error("connection refused")),
            rootDirectory: ".",
            serverUrl: "http://127.0.0.1:9",
          }),
        );

        assert.instanceOf(error, GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "ServerUnavailable");
          assert.isTrue(error.recoverable);
          assert.include(error.message, "without --server-url");
          assert.include(error.message, "direct runtime path");
        }
      }),
    );

    it.effect("fails recoverably when server run data has an invalid run id", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          listRunsFromServer({
            fetch: envelopeFetch({
              "/runs": {
                data: {
                  diagnostics: [],
                  runs: [
                    {
                      artifacts: [],
                      createdAt: "2026-01-01T00:00:00.000Z",
                      eventCount: 1,
                      latestEventType: "RUN_COMPLETED",
                      runId: "not-a-run-id",
                      state: "completed",
                      status: "completed",
                      updatedAt: "2026-01-01T00:00:00.000Z",
                    },
                  ],
                },
                status: "success",
              },
            }),
            rootDirectory: ".",
            serverUrl: "http://127.0.0.1:8787",
          }),
        );

        assert.instanceOf(error, GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "ServerResponseInvalid");
          assert.isTrue(error.recoverable);
          assert.include(error.message, "invalid Gaia run id");
          assert.include(error.message, "without --server-url");
        }
      }),
    );
  });
});

function envelopeFetch(
  envelopes: Readonly<Record<string, unknown>>,
): typeof fetch {
  return async (input) => {
    const url = new URL(input.toString());
    const envelope = envelopes[url.pathname];
    if (envelope === undefined) {
      return new Response(
        JSON.stringify({
          error: {
            code: "EndpointNotFound",
            message: "Endpoint does not exist.",
            recoverable: false,
          },
          status: "error",
        }),
        { status: 404 },
      );
    }

    return new Response(JSON.stringify(envelope), {
      headers: { "content-type": "application/json; charset=utf-8" },
      status: 200,
    });
  };
}
