import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  CreateRunRequest,
  LocalRunApiErrorEnvelope,
  parseLocalGaiaServerUrl,
  parseRunId,
  VerificationActionRequestSchema,
} from "@gaia/core";
import { GaiaRuntimeError } from "@gaia/runtime";
import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import {
  createRunFromLocalServerProtocol,
  actOnVerificationFromLocalServerProtocol,
  evaluateMergeReadinessFromLocalServerProtocol,
  getRunFromLocalServerProtocol,
  listRunsFromLocalServerProtocol,
} from "./local-server-protocol-client.js";
import { readLocalRunArtifactFromServer } from "./server-read-client.js";

describe("local server protocol client", () => {
  const runId = parseRunId("run-1234567890");
  const serverUrl = parseLocalGaiaServerUrl("http://127.0.0.1:4321");
  const trailingSlashServerUrl = parseLocalGaiaServerUrl(
    "http://127.0.0.1:4321/"
  );

  it.effect(
    "decodes run lists through the Effect fetch-backed HttpApi client",
    () =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const result = yield* listRunsFromLocalServerProtocol({
          serverUrl,
        }).pipe(
          Effect.provide(
            recordingFetchLayer(requests, () =>
              jsonResponse({
                data: { diagnostics: [], runs: [] },
                status: "success",
              })
            )
          )
        );

        assert.deepEqual(result.data.runs, []);
        assert.deepEqual(requests, ["GET http://127.0.0.1:4321/runs"]);
      })
  );

  it.effect(
    "encodes create requests from the shared LocalGaiaServerApi contract",
    () =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const bodies: Array<unknown> = [];
        const payload = yield* CreateRunRequest.makeEffect({
          delivery: { mode: "local" },
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
          serverUrl: trailingSlashServerUrl,
        }).pipe(
          Effect.provide(
            recordingFetchLayer(requests, async (request) => {
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
                { status: 202 }
              );
            })
          )
        );

        assert.strictEqual(result.runId, "run-1234567890");
        assert.deepEqual(requests, ["POST http://127.0.0.1:4321/runs"]);
        assert.deepEqual(bodies, [
          {
            delivery: { mode: "local" },
            execution: { harnessProfileId: "codexAppServer" },
            workflow: "issueDelivery",
            workItem: {
              description: "Create through the typed client.\n",
              kind: "issue",
              title: "Typed client request",
            },
          },
        ]);
      })
  );

  it.effect("surfaces declared API errors as typed decoded failures", () =>
    Effect.gen(function* () {
      const error = yield* getRunFromLocalServerProtocol({
        runId,
        serverUrl,
      }).pipe(
        Effect.provide(
          recordingFetchLayer([], () =>
            jsonResponse(
              {
                code: "RunNotFound",
                message: "Run was not found.",
                recoverable: false,
                runId: "run-1234567890",
                status: 404,
              },
              { status: 404 }
            )
          )
        ),
        Effect.flip
      );
      const decoded = Schema.decodeUnknownOption(LocalRunApiErrorEnvelope)(
        error
      );

      if (Option.isNone(decoded)) {
        assert.fail("Expected a decoded LocalRunApiErrorEnvelope.");
      }

      assert.strictEqual(decoded.value.status, 404);
      assert.strictEqual(decoded.value.code, "RunNotFound");
      assert.strictEqual(decoded.value.message, "Run was not found.");
    })
  );

  for (const method of ["merge", "squash", "rebase"] as const) {
    it.effect(
      `sends the exact ${method} readiness action through the public contract`,
      () =>
        Effect.gen(function* () {
          const requests: string[] = [];
          const bodies: unknown[] = [];
          const result = yield* evaluateMergeReadinessFromLocalServerProtocol({
            payload: {
              actionId: `readiness-${method}`,
              kind: "evaluateMergeReadiness",
              mergeMethod: method,
            },
            runId,
            serverUrl,
          }).pipe(
            Effect.provide(
              recordingFetchLayer(requests, async (request) => {
                bodies.push(JSON.parse(await request.text()));
                return jsonResponse({
                  data: {
                    actionAudit: { cleanup: [], merge: [], readyForReview: [] },
                    eventSequence: 9,
                    mode: "pullRequest",
                    recoveryActions: [],
                    runId: "run-1234567890",
                    stage: "delivering",
                    status: "delivering",
                  },
                  status: "success",
                });
              })
            )
          );
          assert.strictEqual(result.data.runId, "run-1234567890");
          assert.deepEqual(requests, [
            "POST http://127.0.0.1:4321/runs/run-1234567890/delivery/actions",
          ]);
          assert.deepEqual(bodies, [
            {
              actionId: `readiness-${method}`,
              kind: "evaluateMergeReadiness",
              mergeMethod: method,
            },
          ]);
        })
    );
  }

  it.effect(
    "serializes one exact verification action without client policy",
    () =>
      Effect.gen(function* () {
        const requests: string[] = [];
        const bodies: unknown[] = [];
        const payload = Schema.decodeUnknownSync(
          VerificationActionRequestSchema
        )({
          actionId: "verify-post-1",
          expectedContentAuthoritySequence: 6,
          expectedContractDigest: "1".repeat(64),
          expectedEventSequence: 12,
          expectedHeadSha: "2".repeat(40),
          expectedPublicationSequence: 11,
          expectedTargetDigest: "3".repeat(64),
          kind: "startPostPublicationGeneration",
        });
        const result = yield* actOnVerificationFromLocalServerProtocol({
          payload,
          runId,
          serverUrl,
        }).pipe(
          Effect.provide(
            recordingFetchLayer(requests, async (request) => {
              bodies.push(JSON.parse(await request.text()));
              return jsonResponse({
                data: {
                  actionId: "verify-post-1",
                  actionRequestDigest: "4".repeat(64),
                  aggregate: "verified",
                  currentContentAuthoritySequence: 6,
                  expectedContentAuthoritySequence: 6,
                  generationSequence: 13,
                  headSha: "2".repeat(40),
                  kind: "postPublicationGenerationRecorded",
                  proofResultDigest: "5".repeat(64),
                  proofResultSequence: 14,
                  publicationSequence: 11,
                  replayed: false,
                  runId: "run-1234567890",
                  targetDigest: "3".repeat(64),
                },
                status: "success",
              });
            })
          )
        );
        assert.strictEqual(
          result.data.kind,
          "postPublicationGenerationRecorded"
        );
        assert.deepEqual(requests, [
          "POST http://127.0.0.1:4321/runs/run-1234567890/verification/actions",
        ]);
        assert.deepEqual(bodies, [JSON.parse(JSON.stringify(payload))]);
      })
  );

  it.effect("rejects traversal artifact parameters before transport", () =>
    Effect.gen(function* () {
      const invalidArtifact = yield* readLocalRunArtifactFromServer({
        artifactName: "../events.jsonl",
        runId,
        serverUrl,
      }).pipe(Effect.flip);

      assert.instanceOf(invalidArtifact, GaiaRuntimeError);
      if (!(invalidArtifact instanceof GaiaRuntimeError)) {
        assert.fail("Expected Gaia runtime errors.");
      }

      assert.strictEqual(invalidArtifact.code, "ArtifactNotAllowed");
      assert.strictEqual(
        invalidArtifact.message,
        "Artifact is not allowlisted for local API reads."
      );
      assert.strictEqual(invalidArtifact.recoverable, false);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

function recordingFetchLayer(
  requests: Array<string>,
  respond: (request: Request) => Response | Promise<Response>
) {
  const recordingFetch: typeof globalThis.fetch = (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(`${request.method} ${request.url}`);
    return Promise.resolve(respond(request));
  };

  return Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, recordingFetch)
  );
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}
