import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, layer } from "@effect/vitest";
import { runSpecFile } from "@gaia/runtime";
import { Effect, FileSystem, Layer } from "effect";
import {
  HttpBody,
  HttpClient,
  type HttpClientResponse,
} from "effect/unstable/http";
import { makeLocalGaiaServerLayer } from "./api.js";

describe("local Gaia server HttpApi boundary", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("serves health with workspace identity through NodeHttpServer", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const response = yield* request(cwd, HttpClient.get("/health"));
        const body = yield* responseJsonObject(response);
        const server = getObject(body, "server");

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(body, "status"), "ok");
        assert.strictEqual(getString(server, "workspaceRoot"), cwd);
        assert.strictEqual(getString(server, "gaiaRoot"), `${cwd}/.gaia`);
        assert.strictEqual(getString(server, "host"), "127.0.0.1");
        assert.isAbove(getNumber(server, "port"), 0);
        assert.include(getString(server, "url"), "http://127.0.0.1:");
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

        const response = yield* request(cwd, HttpClient.get("/runs"));
        const body = yield* responseJsonObject(response);
        const data = getObject(body, "data");
        const runs = getArray(data, "runs");
        const firstRun = getObjectFromArray(runs, 0);
        const diagnostics = getArray(body, "diagnostics");
        const firstDiagnostic = getObjectFromArray(diagnostics, 0);

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(body, "status"), "partial");
        assert.strictEqual(getString(firstRun, "runId"), summary.runId);
        assert.strictEqual(
          getString(firstDiagnostic, "code"),
          "InvalidRunDirectory",
        );
      }),
    );

    it.effect("returns run detail and event envelopes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Serve events.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const detailResponse = yield* request(
          cwd,
          HttpClient.get(`/runs/${summary.runId}`),
        );
        const eventsResponse = yield* request(
          cwd,
          HttpClient.get(`/runs/${summary.runId}/events`),
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
        assert.strictEqual(
          eventItems.length,
          getNumber(detailData, "eventCount"),
        );
      }),
    );

    it.effect("serves allowlisted artifacts through JSON envelopes only", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Serve artifacts.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const response = yield* request(
          cwd,
          HttpClient.get(`/runs/${summary.runId}/artifacts/report.json`),
        );
        const body = yield* responseJsonObject(response);
        const data = getObject(body, "data");

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(data, "artifactName"), "report.json");
        assert.strictEqual(getString(data, "contentType"), "application/json");
        assert.include(getString(data, "body"), summary.runId);
      }),
    );

    it.effect(
      "rejects malformed ids, path-like artifacts, and future mutations/streams",
      () =>
        Effect.gen(function* () {
          const badRun = yield* request(".", HttpClient.get("/runs/not-a-run"));
          const badArtifact = yield* request(
            ".",
            HttpClient.get("/runs/run-V7kP9sQ2xY/artifacts/..%2Fevents.jsonl"),
          );
          const post = yield* request(
            ".",
            HttpClient.post("/runs", {
              body: HttpBody.jsonUnsafe({
                specMarkdown: "Not implemented here.",
              }),
            }),
          );
          const stream = yield* request(
            ".",
            HttpClient.get("/runs/run-V7kP9sQ2xY/events/stream"),
          );
          const unknown = yield* request(".", HttpClient.get("/not-found"));
          const badRunBody = yield* responseJsonObject(badRun);
          const badArtifactBody = yield* responseJsonObject(badArtifact);
          const postBody = yield* responseJsonObject(post);
          const streamBody = yield* responseJsonObject(stream);
          const unknownBody = yield* responseJsonObject(unknown);
          const badRunError = getObject(badRunBody, "error");
          const badArtifactError = getObject(badArtifactBody, "error");
          const postError = getObject(postBody, "error");
          const streamError = getObject(streamBody, "error");
          const unknownError = getObject(unknownBody, "error");

          assert.strictEqual(badRun.status, 400);
          assert.strictEqual(getString(badRunError, "code"), "InvalidRunId");
          assert.strictEqual(badArtifact.status, 404);
          assert.strictEqual(
            getString(badArtifactError, "code"),
            "ArtifactNotAllowed",
          );
          assert.strictEqual(post.status, 405);
          assert.strictEqual(getString(postError, "code"), "MethodNotAllowed");
          assert.strictEqual(stream.status, 405);
          assert.strictEqual(
            getString(streamError, "code"),
            "MethodNotAllowed",
          );
          assert.strictEqual(unknown.status, 404);
          assert.strictEqual(
            getString(unknownError, "code"),
            "EndpointNotFound",
          );
        }),
    );
  });
});

function request<E, R>(
  rootDirectory: string,
  effect: Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    E,
    R | HttpClient.HttpClient
  >,
) {
  return effect.pipe(Effect.provide(testServerLayer(rootDirectory)));
}

function testServerLayer(rootDirectory: string) {
  return makeLocalGaiaServerLayer({
    rootDirectory,
    serverId: "srv_test",
    startedAt: "2026-07-06T10:00:00.000Z",
  }).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
}

function responseJsonObject(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(
    Effect.flatMap((parsed) => {
      if (isJsonObject(parsed)) {
        return Effect.succeed(parsed);
      }

      return Effect.fail(new Error("Response JSON was not an object."));
    }),
    Effect.mapError(() => new Error("Response was not JSON.")),
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
