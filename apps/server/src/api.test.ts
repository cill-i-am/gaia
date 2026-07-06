import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
  runSpecFile,
} from "@gaia/runtime";
import type { ServerWorkflowOptions } from "@gaia/runtime/server-workflows";
import {
  acceptServerRun,
  continueServerRun,
} from "@gaia/runtime/server-workflows";
import { Deferred, Effect, FileSystem, Layer, Schema } from "effect";
import {
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

    it.effect("serves logical artifacts through JSON envelopes only", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Serve artifacts.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const response = yield* HttpClient.get(
          `/runs/${summary.runId}/artifacts/report-json`,
        ).pipe(Effect.provide(testServerLayer(cwd)));
        const inputResponse = yield* HttpClient.get(
          `/runs/${summary.runId}/artifacts/input`,
        ).pipe(Effect.provide(testServerLayer(cwd)));
        const body = yield* responseJsonObject(response);
        const inputBody = yield* responseJsonObject(inputResponse);
        const data = getObject(body, "data");
        const inputData = getObject(inputBody, "data");

        assert.strictEqual(response.status, 200);
        assert.strictEqual(inputResponse.status, 200);
        assert.strictEqual(getString(data, "artifactName"), "report-json");
        assert.strictEqual(getString(data, "contentType"), "application/json");
        assert.include(getString(data, "body"), summary.runId);
        assert.strictEqual(getString(inputData, "artifactName"), "input");
        assert.strictEqual(getString(inputData, "contentType"), "text/markdown");
      }),
    );

    it.effect("streams a server-created run from replayed events to terminal close", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptServerRun({
          specMarkdown: "Stream this server run to completion.\n",
        }, {
          rootDirectory: cwd,
        });

        yield* continueServerRun(accepted.runId, { rootDirectory: cwd });
        const response = yield* HttpClient.get(
          `/runs/${accepted.runId}/events/stream`,
        ).pipe(Effect.provide(testServerLayer(cwd)));
        const text = yield* response.text;
        const events = parseSseDataEvents(text);
        const firstEvent = events[0];
        const lastEvent = events.at(-1);

        assert.strictEqual(response.status, 200);
        if (firstEvent === undefined || lastEvent === undefined) {
          assert.fail("Expected stream to emit run events.");
        }

        assert.strictEqual(getString(firstEvent, "type"), "RUN_CREATED");
        assert.strictEqual(getString(lastEvent, "type"), "REPORT_COMPLETED");
        assert.deepEqual(
          events.map((event) => getNumber(event, "sequence")),
          Array.from({ length: events.length }, (_, index) => index + 1),
        );
      }),
      20_000,
    );

    it.effect("accepts Markdown content durably before returning", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const layer = testServerLayer(cwd);
        const response = yield* postCreateRun(
          layer,
          "Create through the local server.\n",
        );
        const body = yield* responseJsonObject(response);
        const runId = getString(body, "runId");
        const events = yield* HttpClient.get(`/runs/${runId}/events`).pipe(
          Effect.provide(layer),
        );
        const eventsBody = yield* responseJsonObject(events);
        const eventItems = getArray(getObject(eventsBody, "data"), "events");
        const firstEvent = getObjectFromArray(eventItems, 0);

        assert.strictEqual(response.status, 202);
        assert.strictEqual(getString(body, "status"), "accepted");
        assert.strictEqual(getString(firstEvent, "type"), "RUN_CREATED");
        assert.strictEqual(getString(getObject(firstEvent, "payload"), "source"), "server");
      }),
      20_000,
    );

    it.effect("returns typed 400 for invalid Markdown content", () =>
      Effect.gen(function* () {
        const response = yield* postCreateRun(testServerLayer("."), "   ");
        const body = yield* responseJsonObject(response);
        const error = getObject(body, "error");

        assert.strictEqual(response.status, 400);
        assert.strictEqual(getString(error, "code"), "InvalidSpec");
      }),
    );

    it.effect("rejects path-bearing and unknown create request shapes", () =>
      Effect.gen(function* () {
        const layer = testServerLayer(".");
        const pathBearing = yield* createRunRequestFromPayload({
          browserEvidenceTargetUrl: "http://127.0.0.1:3000",
          codexHarness: { command: "codex" },
          processHarness: { command: "node", args: ["harness.mjs"] },
          profile: "dogfood",
          skillManifestSource: "skills.json",
          specMarkdown: "Only Markdown content is accepted here.\n",
          workspaceSource: ".",
        }).pipe(Effect.provide(layer));
        const unknownOptions = yield* createRunRequestFromPayload({
          options: { workspaceSource: "." },
          specMarkdown: "Unknown option bags are rejected too.\n",
        }).pipe(Effect.provide(layer));
        const pathBearingBody = yield* responseJsonObject(pathBearing);
        const unknownOptionsBody = yield* responseJsonObject(unknownOptions);
        const pathBearingError = getObject(pathBearingBody, "error");
        const unknownOptionsError = getObject(unknownOptionsBody, "error");

        assert.strictEqual(pathBearing.status, 400);
        assert.strictEqual(getString(pathBearingError, "code"), "InvalidRequest");
        assert.strictEqual(unknownOptions.status, 400);
        assert.strictEqual(getString(unknownOptionsError, "code"), "InvalidRequest");
      }),
    );

    it.effect("returns typed 409 while a server-created run is active", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const release = yield* Deferred.make<void>();
        const layer = testServerLayer(cwd, {
          reviewer: pausingReviewer(release),
        });

        const responses = yield* Effect.all(
          [
            createRunRequest("Keep this run active.\n"),
            createRunRequest("Conflict with active run.\n"),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(layer));
        const first = responses.find((response) => response.status === 202);
        const second = responses.find((response) => response.status === 409);

        if (first === undefined || second === undefined) {
          assert.fail("Expected one accepted response and one conflict response.");
        }

        const body = yield* responseJsonObject(second);
        const error = getObject(body, "error");

        assert.strictEqual(first.status, 202);
        assert.strictEqual(second.status, 409);
        assert.strictEqual(getString(error, "code"), "ActiveRunConflict");

        yield* Deferred.succeed(release, undefined);
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
        const unknownArtifact = yield* HttpClient.get(
          "/runs/run-V7kP9sQ2xY/artifacts/report.json",
        ).pipe(Effect.provide(layer));
        const post = yield* HttpClientRequest.post("/runs").pipe(
          HttpClient.execute,
          Effect.provide(layer),
        );
        const put = yield* HttpClientRequest.put("/runs/not-a-run").pipe(
          HttpClient.execute,
          Effect.provide(layer),
        );
        const head = yield* HttpClientRequest.head("/runs").pipe(
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
        const unknownArtifactBody = yield* responseJsonObject(
          unknownArtifact,
          "unknown artifact",
        );
        const postBody = yield* responseJsonObject(post, "post runs");
        const putBody = yield* responseJsonObject(put, "put run");
        const malformedPathBody = yield* responseJsonObject(
          malformedPath,
          "malformed path",
        );
        const badRunError = getObject(badRunBody, "error");
        const badArtifactError = getObject(badArtifactBody, "error");
        const unknownArtifactError = getObject(unknownArtifactBody, "error");
        const postError = getObject(postBody, "error");
        const putError = getObject(putBody, "error");
        const malformedPathError = getObject(malformedPathBody, "error");

        assert.strictEqual(badRun.status, 400);
        assert.strictEqual(getString(badRunError, "code"), "InvalidRunId");
        assert.strictEqual(badArtifact.status, 404);
        assert.strictEqual(getString(badArtifactError, "code"), "ArtifactNotAllowed");
        assert.strictEqual(unknownArtifact.status, 404);
        assert.strictEqual(
          getString(unknownArtifactError, "code"),
          "ArtifactNotAllowed",
        );
        assert.strictEqual(post.status, 400);
        assert.strictEqual(getString(postError, "code"), "InvalidRequest");
        assert.strictEqual(put.status, 405);
        assert.strictEqual(getString(putError, "code"), "MethodNotAllowed");
        assert.strictEqual(head.status, 405);
        assert.strictEqual(malformedPath.status, 404);
        assert.strictEqual(getString(malformedPathError, "code"), "EndpointNotFound");
      }),
    );
  });
});

function testServerLayer(
  rootDirectory: string,
  workflowOptions: ServerWorkflowOptions = {},
) {
  return makeLocalGaiaServerLayer(testIdentity(rootDirectory), workflowOptions).pipe(
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

function parseSseDataEvents(
  text: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return text
    .trim()
    .split(/\r?\n\r?\n/u)
    .flatMap((block) => {
      const dataLines = block
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());

      if (dataLines.length === 0) {
        return [];
      }

      const parsed: unknown = JSON.parse(dataLines.join("\n"));
      if (!isJsonObject(parsed)) {
        throw new Error(
          `Expected SSE data event to be an object: ${dataLines.join("\n")}.`,
        );
      }

      return [parsed];
    });
}

function postCreateRun(
  layer: ReturnType<typeof testServerLayer>,
  specMarkdown: string,
) {
  return createRunRequest(specMarkdown).pipe(Effect.provide(layer));
}

function createRunRequest(specMarkdown: string) {
  return createRunRequestFromPayload({ specMarkdown });
}

function createRunRequestFromPayload(payload: unknown) {
  return HttpClientRequest.post("/runs").pipe(
    HttpClientRequest.bodyJsonUnsafe(payload),
    HttpClient.execute,
  );
}

function pausingReviewer(release: Deferred.Deferred<void>): GaiaReviewer {
  const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
    "pausing-server-reviewer",
  );

  return {
    name: reviewerName,
    run: (request) =>
      Effect.gen(function* () {
        if (request.phase === "plan") {
          yield* Deferred.await(release);
        }

        return ReviewResult.make({
          findings: [],
          phase: request.phase,
          resultPath:
            request.phase === "plan"
              ? "plan-review.json"
              : "evidence-review.json",
          reviewerName,
          runId: request.runId,
          status: "approved",
          summary: `Pausing reviewer approved ${request.phase}.`,
        });
      }),
  };
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
