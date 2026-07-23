import {
  RunControlActionIdSchema,
  RunControlCheckpointDigestSchema,
  RunControlRequestDigestSchema,
  FactoryAgentIdSchema,
  parseRunControlAuthorityId,
  parseHarnessInteractionId,
  parseHarnessProviderId,
  parseHarnessSessionId,
  parseHarnessQuestionId,
  parseLocalGaiaServerUrl,
  parseRunId,
} from "@gaia/core";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import * as dashboardClient from "@/lib/local-gaia-client";

const runId = parseRunId("run-148client1");
const serverUrl = parseLocalGaiaServerUrl("http://127.0.0.1:4321");

describe("local Gaia run-control client", () => {
  it("uses the bounded GET and POST contract without returning a hidden response", async () => {
    const getRunControl = Reflect.get(
      dashboardClient,
      "getRunControlFromDashboardGaiaClient"
    );
    const actOnRunControl = Reflect.get(
      dashboardClient,
      "actOnRunControlFromDashboardGaiaClient"
    );

    expect(getRunControl).toBeTypeOf("function");
    expect(actOnRunControl).toBeTypeOf("function");

    const requests: Array<string> = [];
    const bodies: Array<unknown> = [];
    const action = {
      actionId: Schema.decodeUnknownSync(RunControlActionIdSchema)(
        "dashboard-control-action"
      ),
      authorityId: parseRunControlAuthorityId("authority-local"),
      checkpointDigest: Schema.decodeUnknownSync(
        RunControlCheckpointDigestSchema
      )("a".repeat(64)),
      expectedEventSequence: 7,
      interactionId: parseHarnessInteractionId("interaction-dashboard"),
      operation: "resolveInteraction" as const,
      providerId: parseHarnessProviderId("fake"),
      requestDigest: Schema.decodeUnknownSync(RunControlRequestDigestSchema)(
        "b".repeat(64)
      ),
      response: {
        answers: [
          {
            answers: ["EPHEMERAL_SECRET"],
            questionId: parseHarnessQuestionId("question-1"),
          },
        ],
        kind: "userInput" as const,
      },
      runId,
      sessionId: parseHarnessSessionId("session-dashboard"),
      workerAgentId:
        Schema.decodeUnknownSync(FactoryAgentIdSchema)("agent-worker"),
      workerStartedSequence: 3,
    };
    const layer = recordingFetchLayer(requests, bodies, (request) =>
      request.method === "GET"
        ? jsonResponse({
            actionTarget: {
              authorityId: action.authorityId,
              checkpointDigest: action.checkpointDigest,
              expectedEventSequence: action.expectedEventSequence,
              interactionId: action.interactionId,
              providerId: action.providerId,
              requestDigest: action.requestDigest,
              sessionId: action.sessionId,
              workerAgentId: action.workerAgentId,
              workerStartedSequence: action.workerStartedSequence,
            },
            allowedActions: ["resolveInteraction", "pause", "cancel"],
            expired: false,
            runId,
            state: "waitingForHuman",
          })
        : jsonResponse({
            actionBindingDigest: "c".repeat(64),
            actionId: action.actionId,
            duplicate: false,
            operation: action.operation,
            runId,
            state: "confirmed",
          })
    );

    const snapshot = await Effect.runPromise(
      getRunControl({ runId, serverUrl }).pipe(Effect.provide(layer))
    );
    const receipt = await Effect.runPromise(
      actOnRunControl({ action, runId, serverUrl }).pipe(Effect.provide(layer))
    );

    expect(snapshot.allowedActions).toContain("resolveInteraction");
    expect(receipt).not.toHaveProperty("response");
    expect(requests).toEqual([
      "GET http://127.0.0.1:4321/runs/run-148client1/control",
      "POST http://127.0.0.1:4321/runs/run-148client1/control/actions",
    ]);
    expect(JSON.stringify(bodies[0])).toContain("EPHEMERAL_SECRET");
    expect(JSON.stringify(receipt)).not.toContain("EPHEMERAL_SECRET");
  });
});

function recordingFetchLayer(
  requests: Array<string>,
  bodies: Array<unknown>,
  respond: (request: Request) => Response
) {
  const recordingFetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "POST") bodies.push(await request.json());
    return respond(request);
  };
  return Layer.provide(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, recordingFetch)
  );
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
