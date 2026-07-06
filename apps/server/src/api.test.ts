import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { runSpecFile } from "@gaia/runtime";
import { readLocalRun, readLocalRunEvents } from "@gaia/runtime/run-read-api";
import { Effect, FileSystem, Layer } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import { makeLocalGaiaServerLayer } from "./api.js";
import type { LocalServerIdentity } from "./discovery.js";

describe("local run api http boundary", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("returns health with workspace identity", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const response = yield* HttpClient.get("/health").pipe(
          Effect.provide(testServerLayer(cwd)),
        );
        const body = yield* responseJsonObject(response);

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(body, "status"), "ok");
        assert.strictEqual(getString(body, "workspaceRoot"), cwd);
        assert.strictEqual(getString(body, "host"), "127.0.0.1");
        assert.strictEqual(getNumber(body, "version"), 1);
        assert.isAbove(getNumber(body, "port"), 0);
      }),
    );

    it.effect("returns run summaries with partial diagnostics", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Serve runs.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        yield* fs.makeDirectory(`${cwd}/.gaia/runs/run-not-valid`);

        const response = yield* HttpClient.get("/runs").pipe(
          Effect.provide(testServerLayer(cwd)),
        );
        const body = yield* responseJsonObject(response);
        const data = getObject(body, "data");
        const runs = getArray(data, "runs");
        const firstRun = getObjectFromArray(runs, 0);
        const diagnostics = getArray(body, "diagnostics");
        const firstDiagnostic = getObjectFromArray(diagnostics, 0);

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(body, "status"), "partial");
        assert.strictEqual(getString(firstRun, "runId"), summary.runId);
        assert.strictEqual(getString(firstDiagnostic, "code"), "InvalidRunDirectory");
      }),
    );

    it.effect("returns run detail and event envelopes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Serve events.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const layer = testServerLayer(cwd);
        const detailResponse = yield* HttpClient.get(`/runs/${summary.runId}`).pipe(
          Effect.provide(layer),
        );
        const eventsResponse = yield* HttpClient.get(
          `/runs/${summary.runId}/events`,
        ).pipe(Effect.provide(layer));
        const detail = yield* responseJsonObject(detailResponse);
        const events = yield* responseJsonObject(eventsResponse);
        const detailData = getObject(detail, "data");
        const eventsData = getObject(events, "data");
        const eventItems = getArray(eventsData, "events");

        assert.strictEqual(detailResponse.status, 200);
        assert.strictEqual(eventsResponse.status, 200);
        assert.strictEqual(getString(detailData, "runId"), summary.runId);
        assert.strictEqual(getString(eventsData, "runId"), summary.runId);
        assert.strictEqual(eventItems.length, getNumber(detailData, "eventCount"));
      }),
    );

    it.effect("serves allowlisted artifacts through JSON envelopes only", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Serve artifacts.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const response = yield* HttpClient.get(
          `/runs/${summary.runId}/artifacts/report.json`,
        ).pipe(Effect.provide(testServerLayer(cwd)));
        const body = yield* responseJsonObject(response);
        const data = getObject(body, "data");

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(data, "artifactName"), "report.json");
        assert.strictEqual(getString(data, "contentType"), "application/json");
        assert.include(getString(data, "body"), summary.runId);
      }),
    );

    it.effect("accepts markdown content and completes a default server run asynchronously", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        yield* Effect.gen(function* () {
          const response = yield* postRun({
            specMarkdown: "---\ntitle: API run\n---\n\nRun through HTTP.\n",
          });
          const body = yield* responseJsonObject(response);
          const runId = getString(body, "runId");
          const inputExists = yield* fs.exists(
            `${cwd}/.gaia/runs/${runId}/input.md`,
          );
          const inputMarkdown = yield* fs.readFileString(
            `${cwd}/.gaia/runs/${runId}/input.md`,
          );
          const acceptedEvents = yield* readLocalRunEvents(runId, {
            rootDirectory: cwd,
          });
          const firstEvent = acceptedEvents.events[0];

          assert.strictEqual(response.status, 202);
          assert.strictEqual(getString(body, "status"), "accepted");
          assert.isTrue(inputExists);
          assert.strictEqual(inputMarkdown, "---\ntitle: API run\n---\n\nRun through HTTP.\n");
          assert.strictEqual(firstEvent?.type, "RUN_CREATED");
          assert.strictEqual(firstEvent?.payload["source"], "server");
          assert.strictEqual(firstEvent?.payload["specPath"], "input.md");

          const completed = yield* waitForCompletedRun(cwd, runId);
          assert.strictEqual(completed.latestEventType, "REPORT_COMPLETED");
        }).pipe(Effect.provide(testServerLayer(cwd)));
      }),
      20_000,
    );

    it.effect("rejects invalid create payloads with typed 400 errors", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });

        const response = yield* postRun({ specMarkdown: "" }).pipe(
          Effect.provide(testServerLayer(cwd)),
        );
        const body = yield* responseJsonObject(response);
        const error = getObject(body, "error");

        assert.strictEqual(response.status, 400);
        assert.strictEqual(getString(error, "code"), "InvalidRunSpec");
      }),
    );

    it.effect("rejects path-bearing and unknown create request options", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const layer = testServerLayer(cwd);

        const responses = yield* Effect.all([
          postRun({
            specMarkdown: "Attempt workspace option.\n",
            workspaceSource: ".",
          }),
          postRun({
            specMarkdown: "Attempt profile option.\n",
            profile: "frontend",
          }),
          postRun({
            specMarkdown: "Attempt browser option.\n",
            browserEvidenceTargetUrl: "http://127.0.0.1:3000",
          }),
          postRun({
            specMarkdown: "Attempt harness option.\n",
            processHarness: { command: "node" },
          }),
          postRun({
            specMarkdown: "Attempt skill manifest option.\n",
            skillManifest: "skills.json",
          }),
          postRun({
            specMarkdown: "Attempt unknown option bag.\n",
            options: { workspaceSource: "." },
          }),
        ]).pipe(Effect.provide(layer));

        for (const response of responses) {
          const body = yield* responseJsonObject(response);
          const error = getObject(body, "error");

          assert.strictEqual(response.status, 400);
          assert.strictEqual(getString(error, "code"), "InvalidRunSpec");
        }
      }),
    );

    it.effect("returns typed 409 while a server-created run is active", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const layer = testServerLayer(cwd);

        const responses = yield* Effect.all(
          [
            postRun({ specMarkdown: "First server run.\n" }),
            postRun({ specMarkdown: "Second server run.\n" }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(layer));
        const statuses = responses.map((response) => response.status).sort();
        const conflict = responses.find((response) => response.status === 409);
        if (conflict === undefined) {
          throw new Error(`Expected one conflict, got statuses ${statuses.join(", ")}.`);
        }

        const body = yield* responseJsonObject(conflict);
        const error = getObject(body, "error");

        assert.deepEqual(statuses, [202, 409]);
        assert.strictEqual(getString(error, "code"), "ActiveRunConflict");
      }),
      20_000,
    );

    it.effect("rejects malformed ids, path-like artifacts, and mutation methods", () =>
      Effect.gen(function* () {
        const layer = testServerLayer(".");
        const badRun = yield* HttpClient.get("/runs/not-a-run").pipe(
          Effect.provide(layer),
        );
        const badArtifact = yield* HttpClient.get(
          "/runs/run-V7kP9sQ2xY/artifacts/..%2Fevents.jsonl",
        ).pipe(Effect.provide(layer));
        const post = yield* HttpClientRequest.post("/runs").pipe(
          HttpClient.execute,
          Effect.provide(layer),
        );
        const put = yield* HttpClientRequest.put("/runs/not-a-run").pipe(
          HttpClient.execute,
          Effect.provide(layer),
        );
        const malformedPath = yield* HttpClient.get("/runs/%E0%A4%A").pipe(
          Effect.provide(layer),
        );
        const badRunBody = yield* responseJsonObject(badRun, "bad run");
        const badArtifactBody = yield* responseJsonObject(
          badArtifact,
          "bad artifact",
        );
        const postBody = yield* responseJsonObject(post, "post runs");
        const putBody = yield* responseJsonObject(put, "put run");
        const malformedPathBody = yield* responseJsonObject(
          malformedPath,
          "malformed path",
        );
        const badRunError = getObject(badRunBody, "error");
        const badArtifactError = getObject(badArtifactBody, "error");
        const putError = getObject(putBody, "error");
        const malformedPathError = getObject(malformedPathBody, "error");

        assert.strictEqual(badRun.status, 400);
        assert.strictEqual(getString(badRunError, "code"), "InvalidRunId");
        assert.strictEqual(badArtifact.status, 404);
        assert.strictEqual(getString(badArtifactError, "code"), "ArtifactNotAllowed");
        assert.strictEqual(post.status, 400);
        assert.strictEqual(put.status, 405);
        assert.strictEqual(getString(putError, "code"), "MethodNotAllowed");
        assert.strictEqual(malformedPath.status, 404);
        assert.strictEqual(getString(malformedPathError, "code"), "EndpointNotFound");
      }),
    );
  });
});

function postRun(payload: Readonly<Record<string, unknown>>) {
  return HttpClient.post("/runs", { body: HttpBody.jsonUnsafe(payload) });
}

function waitForCompletedRun(rootDirectory: string, runId: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = yield* readLocalRun(runId, { rootDirectory });
      if (run.status === "completed") {
        return run;
      }

      yield* realSleep(10);
    }

    throw new Error(`Run ${runId} did not complete before the timeout.`);
  });
}

function realSleep(milliseconds: number) {
  return Effect.promise<void>(
    () => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  );
}

function testServerLayer(rootDirectory: string) {
  return makeLocalGaiaServerLayer(testIdentity(rootDirectory)).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
}

function testIdentity(rootDirectory: string): LocalServerIdentity {
  return {
    host: "127.0.0.1",
    pid: process.pid,
    rootDirectory,
    serverId: "srv_test",
    startedAt: "2026-07-06T00:00:00.000Z",
  };
}

function responseJsonObject(
  response: HttpClientResponse.HttpClientResponse,
  label = "response",
) {
  return response.json.pipe(
    Effect.flatMap((parsed) => {
      if (isJsonObject(parsed)) {
        return Effect.succeed(parsed);
      }

      return Effect.fail(
        new Error(
          `${label} JSON was not an object at status ${response.status}: ${JSON.stringify(parsed)}.`,
        ),
      );
    }),
  );
}

function getObject(
  input: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = input[key];
  if (isJsonObject(value)) {
    return value;
  }

  throw new Error(`Expected ${key} to be an object.`);
}

function getArray(
  input: Readonly<Record<string, unknown>>,
  key: string,
): ReadonlyArray<unknown> {
  const value = input[key];
  if (Array.isArray(value)) {
    return value;
  }

  throw new Error(`Expected ${key} to be an array.`);
}

function getObjectFromArray(
  input: ReadonlyArray<unknown>,
  index: number,
): Readonly<Record<string, unknown>> {
  const value = input[index];
  if (isJsonObject(value)) {
    return value;
  }

  throw new Error(`Expected array item ${index} to be an object.`);
}

function getString(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Expected ${key} to be a string.`);
}

function getNumber(input: Readonly<Record<string, unknown>>, key: string): number {
  const value = input[key];
  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Expected ${key} to be a number.`);
}

function isJsonObject(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
