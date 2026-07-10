import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  CreateRunRequest,
  LocalRunApiErrorEnvelope,
} from "@gaia/core";
import { GaiaRuntimeError } from "@gaia/runtime";
import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  createRunFromLocalServerProtocol,
  getRunFromLocalServerProtocol,
  listRunsFromLocalServerProtocol,
} from "./local-server-protocol-client.js";
import {
  readLocalRunArtifactFromServer,
  statusRunFromServer,
} from "./server-read-client.js";

describe("local server protocol client", () => {
  it.effect("decodes run lists through the Effect fetch-backed HttpApi client", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const result = yield* listRunsFromLocalServerProtocol({
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(
        Effect.provide(recordingFetchLayer(requests, () =>
          jsonResponse({
            data: { diagnostics: [], runs: [] },
            status: "success",
          }),
        )),
      );

      assert.deepEqual(result.data.runs, []);
      assert.deepEqual(requests, ["GET http://127.0.0.1:4321/runs"]);
    }),
  );

  it.effect("encodes create requests from the shared LocalGaiaServerApi contract", () =>
    Effect.gen(function* () {
      const requests: Array<string> = [];
      const bodies: Array<unknown> = [];
      const payload = yield* CreateRunRequest.makeEffect({
        execution: codexAppServerExecutionSelection,
        workflow: "issueDelivery",
        workItem: {
          description: "Create through the typed client.\n",
          kind: "issue",
          title: "Typed client request",
        },
      });
      const result = yield* createRunFromLocalServerProtocol({
        payload,
        serverUrl: "http://127.0.0.1:4321/",
      }).pipe(
        Effect.provide(recordingFetchLayer(requests, async (request) => {
          const body: unknown = JSON.parse(await request.text());
          bodies.push(body);
          return jsonResponse(
            {
              acceptedAt: "2026-07-06T00:00:00.000Z",
              runId: "run-1234567890",
              status: "accepted",
              urls: {
                activity: "/runs/run-1234567890/activity",
                artifacts: "/runs/run-1234567890/artifacts",
                factoryGraph: "/runs/run-1234567890/factory-graph",
                run: "/runs/run-1234567890",
              },
            },
            { status: 202 },
          );
        })),
      );

      assert.strictEqual(result.runId, "run-1234567890");
      assert.deepEqual(requests, ["POST http://127.0.0.1:4321/runs"]);
      assert.deepEqual(bodies, [
        {
          execution: { harnessProfileId: "codexAppServer" },
          workflow: "issueDelivery",
          workItem: {
            description: "Create through the typed client.\n",
            kind: "issue",
            title: "Typed client request",
          },
        },
      ]);
    }),
  );

  it.effect("surfaces declared API errors as typed decoded failures", () =>
    Effect.gen(function* () {
      const error = yield* getRunFromLocalServerProtocol({
        runId: "run-1234567890",
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(
        Effect.provide(recordingFetchLayer([], () =>
          jsonResponse(
            {
              code: "RunNotFound",
              message: "Run was not found.",
              recoverable: false,
              runId: "run-1234567890",
              status: 404,
            },
            { status: 404 },
          ),
        )),
        Effect.flip,
      );
      const decoded = Schema.decodeUnknownOption(LocalRunApiErrorEnvelope)(error);

      if (Option.isNone(decoded)) {
        assert.fail("Expected a decoded LocalRunApiErrorEnvelope.");
      }

      assert.strictEqual(decoded.value.status, 404);
      assert.strictEqual(decoded.value.code, "RunNotFound");
      assert.strictEqual(decoded.value.message, "Run was not found.");
    }),
  );

  it.effect("maps invalid client-side path parameters to runtime diagnostics", () =>
    Effect.gen(function* () {
      const invalidRunId = yield* statusRunFromServer({
        rootDirectory: ".",
        runId: "not-a-run",
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(Effect.flip);
      const invalidArtifact = yield* readLocalRunArtifactFromServer({
        artifactName: "",
        runId: "run-1234567890",
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(Effect.flip);

      assert.instanceOf(invalidRunId, GaiaRuntimeError);
      assert.instanceOf(invalidArtifact, GaiaRuntimeError);
      if (
        !(invalidRunId instanceof GaiaRuntimeError) ||
        !(invalidArtifact instanceof GaiaRuntimeError)
      ) {
        assert.fail("Expected Gaia runtime errors.");
      }

      assert.strictEqual(invalidRunId.code, "InvalidRunId");
      assert.strictEqual(invalidRunId.recoverable, false);
      assert.strictEqual(invalidArtifact.code, "ArtifactNotAllowed");
      assert.strictEqual(invalidArtifact.recoverable, false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

function recordingFetchLayer(
  requests: Array<string>,
  respond: (request: Request) => Response | Promise<Response>,
) {
  const recordingFetch: typeof globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(`${request.method} ${request.url}`);
    return Promise.resolve(respond(request));
  };

  return Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, recordingFetch),
  );
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}
