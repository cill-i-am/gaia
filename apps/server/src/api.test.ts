import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { runSpecFile } from "@gaia/runtime";
import { handleLocalRunApiRequest } from "./api.js";

describe("local run api http boundary", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("returns run summaries with partial diagnostics", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Serve runs.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        yield* fs.makeDirectory(`${cwd}/.gaia/runs/run-not-valid`);

        const response = yield* handleLocalRunApiRequest(
          new Request("http://127.0.0.1/runs"),
          { rootDirectory: cwd },
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

        const detailResponse = yield* handleLocalRunApiRequest(
          new Request(`http://127.0.0.1/runs/${summary.runId}`),
          { rootDirectory: cwd },
        );
        const eventsResponse = yield* handleLocalRunApiRequest(
          new Request(`http://127.0.0.1/runs/${summary.runId}/events`),
          { rootDirectory: cwd },
        );
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

        const response = yield* handleLocalRunApiRequest(
          new Request(`http://127.0.0.1/runs/${summary.runId}/artifacts/report.json`),
          { rootDirectory: cwd },
        );
        const body = yield* responseJsonObject(response);
        const data = getObject(body, "data");

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(data, "artifactName"), "report.json");
        assert.strictEqual(getString(data, "contentType"), "application/json");
        assert.include(getString(data, "body"), summary.runId);
      }),
    );

    it.effect("rejects malformed ids, path-like artifacts, and mutation methods", () =>
      Effect.gen(function* () {
        const badRun = yield* handleLocalRunApiRequest(
          new Request("http://127.0.0.1/runs/not-a-run"),
          { rootDirectory: "." },
        );
        const badArtifact = yield* handleLocalRunApiRequest(
          new Request("http://127.0.0.1/runs/run-V7kP9sQ2xY/artifacts/..%2Fevents.jsonl"),
          { rootDirectory: "." },
        );
        const post = yield* handleLocalRunApiRequest(
          new Request("http://127.0.0.1/runs", { method: "POST" }),
          { rootDirectory: "." },
        );
        const malformedPath = yield* handleLocalRunApiRequest(
          new Request("http://127.0.0.1/runs/%E0%A4%A"),
          { rootDirectory: "." },
        );
        const badRunBody = yield* responseJsonObject(badRun);
        const badArtifactBody = yield* responseJsonObject(badArtifact);
        const postBody = yield* responseJsonObject(post);
        const malformedPathBody = yield* responseJsonObject(malformedPath);
        const badRunError = getObject(badRunBody, "error");
        const badArtifactError = getObject(badArtifactBody, "error");
        const postError = getObject(postBody, "error");
        const malformedPathError = getObject(malformedPathBody, "error");

        assert.strictEqual(badRun.status, 400);
        assert.strictEqual(getString(badRunError, "code"), "InvalidRunId");
        assert.strictEqual(badArtifact.status, 404);
        assert.strictEqual(getString(badArtifactError, "code"), "ArtifactNotAllowed");
        assert.strictEqual(post.status, 405);
        assert.strictEqual(getString(postError, "code"), "MethodNotAllowed");
        assert.strictEqual(malformedPath.status, 404);
        assert.strictEqual(getString(malformedPathError, "code"), "EndpointNotFound");
      }),
    );
  });
});

function responseJsonObject(response: Response) {
  return Effect.tryPromise({
    try: async () => {
      const parsed: unknown = JSON.parse(await response.text());
      if (isJsonObject(parsed)) {
        return parsed;
      }

      throw new Error("Response JSON was not an object.");
    },
    catch: () => new Error("Response was not JSON."),
  });
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
