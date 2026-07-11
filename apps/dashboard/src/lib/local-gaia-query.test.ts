import { expect, it, describe } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { Effect, Layer } from "effect";
import { createEffectQuery } from "effect-query";
import { FetchHttpClient } from "effect/unstable/http";

import {
  defaultLocalGaiaServerUrl,
  getFactoryArtifactFromDashboardGaiaClient,
  getFactoryGraphFromDashboardGaiaClient,
  getFactoryRunActivityFromDashboardGaiaClient,
  getFactoryAgentActivityFromDashboardGaiaClient,
  actOnAgentSessionFromDashboardGaiaClient,
  getAgentSessionFromDashboardGaiaClient,
  getRunArtifactFromDashboardGaiaClient,
  getRunFromDashboardGaiaClient,
  listFactoryArtifactsFromDashboardGaiaClient,
  listRunsFromDashboardGaiaClient,
} from "@/lib/local-gaia-client";
import { testFactoryExecution } from "@/test-factory-execution";
import {
  localGaiaCreateRunMutationOptions,
  localGaiaFactoryAgentActivityQueryOptions,
  localGaiaFactoryArtifactQueryOptions,
  localGaiaFactoryArtifactsQueryOptions,
  localGaiaFactoryGraphQueryOptions,
  localGaiaFactoryRunActivityQueryOptions,
  localGaiaHealthQueryOptions,
  localGaiaAgentSessionActionMutationOptions,
  localGaiaAgentSessionQueryOptions,
  localGaiaQueryKeys,
  localGaiaRunArtifactQueryOptions,
  localGaiaRunQueryOptions,
  localGaiaRunsQueryOptions,
} from "@/lib/local-gaia-query";

describe("local Gaia query options", () => {
  it("keeps browser dashboard requests on the same-origin proxy path", () => {
    expect(defaultLocalGaiaServerUrl).toBe("/gaia-api");
  });

  it("constructs stable TanStack Query options through effect-query", () => {
    const health = localGaiaHealthQueryOptions({
      serverUrl: "http://127.0.0.1:4321",
    });
    const runs = localGaiaRunsQueryOptions({
      serverUrl: "http://127.0.0.1:4321",
    });
    const artifact = localGaiaRunArtifactQueryOptions({
      artifactId: "report",
      runId: "run-1234567890",
      serverUrl: "http://127.0.0.1:4321",
    });
    const graph = localGaiaFactoryGraphQueryOptions({
      runId: "run-1234567890",
      serverUrl: "http://127.0.0.1:4321",
    });
    const runActivity = localGaiaFactoryRunActivityQueryOptions({
      runId: "run-1234567890",
      serverUrl: "http://127.0.0.1:4321",
    });
    const agentActivity = localGaiaFactoryAgentActivityQueryOptions({
      agentId: "agent-worker",
      runId: "run-1234567890",
      serverUrl: "http://127.0.0.1:4321",
    });
    const artifactCatalog = localGaiaFactoryArtifactsQueryOptions({
      runId: "run-1234567890",
      serverUrl: "http://127.0.0.1:4321",
    });
    const factoryArtifact = localGaiaFactoryArtifactQueryOptions({
      artifactId: "artifact-plan",
      runId: "run-1234567890",
      serverUrl: "http://127.0.0.1:4321",
    });
    const agentSession = localGaiaAgentSessionQueryOptions({
      agentId: "agent-worker",
      runId: "run-1234567890",
      serverUrl: "http://127.0.0.1:4321",
    });

    expect(health.queryKey).toEqual(localGaiaQueryKeys.health());
    expect(runs.queryKey).toEqual(localGaiaQueryKeys.runs());
    expect(artifact.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "artifact",
      "report",
    ]);
    expect(graph.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "factory-graph",
    ]);
    expect(runActivity.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "activity",
    ]);
    expect(agentActivity.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "agents",
      "agent-worker",
      "activity",
    ]);
    expect(artifactCatalog.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "artifacts",
    ]);
    expect(factoryArtifact.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "artifacts",
      "artifact-plan",
    ]);
    expect(agentSession.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "agents",
      "agent-worker",
      "session",
    ]);
    expect(artifact.enabled).toBe(true);
    expect(graph.enabled).toBe(true);
    expect(runActivity.enabled).toBe(true);
    expect(agentActivity.enabled).toBe(true);
    expect(artifactCatalog.enabled).toBe(true);
    expect(factoryArtifact.enabled).toBe(true);
    expect(agentSession.enabled).toBe(true);
    expect(typeof health.queryFn).toBe("function");
    expect(typeof runs.queryFn).toBe("function");
  });

  it("disables factory query options until identifiers parse", () => {
    const graph = localGaiaFactoryGraphQueryOptions({
      runId: "",
      serverUrl: "http://127.0.0.1:4321",
    });
    const agentActivity = localGaiaFactoryAgentActivityQueryOptions({
      agentId: "",
      runId: "run-1234567890",
      serverUrl: "http://127.0.0.1:4321",
    });
    const agentSession = localGaiaAgentSessionQueryOptions({
      agentId: "",
      runId: "run-1234567890",
      serverUrl: "http://127.0.0.1:4321",
    });

    expect(graph.enabled).toBe(false);
    expect(graph.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "invalid-run-id",
      "factory-graph",
    ]);
    expect(agentActivity.enabled).toBe(false);
    expect(agentActivity.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "agents",
      "invalid-agent-id",
      "activity",
    ]);
    expect(agentSession.enabled).toBe(false);
    expect(agentSession.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "agents",
      "invalid-agent-id",
      "session",
    ]);
  });

  it("decodes run lists through the shared HttpApi contract", async () => {
    const requests: Array<string> = [];
    const result = await Effect.runPromise(
      listRunsFromDashboardGaiaClient({
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(
        Effect.provide(
          recordingFetchLayer(requests, () =>
            jsonResponse({
              data: { diagnostics: [], runs: [] },
              status: "success",
            }),
          ),
        ),
      ),
    );

    expect(result.data.runs).toEqual([]);
    expect(requests).toEqual(["GET http://127.0.0.1:4321/runs"]);
  });

  it("maps declared API failures into a tagged dashboard query error", async () => {
    const error = await Effect.runPromise(
      getRunFromDashboardGaiaClient({
        runId: "run-1234567890",
        serverUrl: "http://127.0.0.1:4321",
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
              { status: 404 },
            ),
          ),
        ),
        Effect.flip,
      ),
    );

    expect(error._tag).toBe("DashboardGaiaApiError");
    if (error._tag === "DashboardGaiaApiError") {
      expect(error.error.status).toBe(404);
      expect(error.error.code).toBe("RunNotFound");
      expect(error.error.message).toBe("Run was not found.");
    }
  });

  it("reads factory graph, activity, artifact catalog, and artifact body resources", async () => {
    const requests: Array<string> = [];
    const result = await Effect.runPromise(
      Effect.all({
        activity: getFactoryRunActivityFromDashboardGaiaClient({
          runId: "run-1234567890",
          serverUrl: "http://127.0.0.1:4321",
        }),
        agentActivity: getFactoryAgentActivityFromDashboardGaiaClient({
          agentId: "agent-worker",
          runId: "run-1234567890",
          serverUrl: "http://127.0.0.1:4321",
        }),
        artifact: getFactoryArtifactFromDashboardGaiaClient({
          artifactId: "artifact-plan",
          runId: "run-1234567890",
          serverUrl: "http://127.0.0.1:4321",
        }),
        artifacts: listFactoryArtifactsFromDashboardGaiaClient({
          runId: "run-1234567890",
          serverUrl: "http://127.0.0.1:4321",
        }),
        graph: getFactoryGraphFromDashboardGaiaClient({
          runId: "run-1234567890",
          serverUrl: "http://127.0.0.1:4321",
        }),
      }).pipe(
        Effect.provide(
          recordingFetchLayer(requests, (request) => {
            switch (request.url) {
              case "http://127.0.0.1:4321/runs/run-1234567890/factory-graph":
                return jsonResponse(factoryGraphEnvelope);
              case "http://127.0.0.1:4321/runs/run-1234567890/activity":
              case "http://127.0.0.1:4321/runs/run-1234567890/agents/agent-worker/activity":
                return jsonResponse(activityEnvelope);
              case "http://127.0.0.1:4321/runs/run-1234567890/artifacts":
                return jsonResponse(artifactListEnvelope);
              case "http://127.0.0.1:4321/runs/run-1234567890/artifacts/artifact-plan":
                return jsonResponse(artifactBodyEnvelope);
              default:
                return jsonResponse(
                  {
                    code: "EndpointNotFound",
                    message: "Unexpected test URL.",
                    recoverable: false,
                    status: 404,
                  },
                  { status: 404 },
                );
            }
          }),
        ),
      ),
    );

    expect(requests).toEqual([
      "GET http://127.0.0.1:4321/runs/run-1234567890/activity",
      "GET http://127.0.0.1:4321/runs/run-1234567890/agents/agent-worker/activity",
      "GET http://127.0.0.1:4321/runs/run-1234567890/artifacts/artifact-plan",
      "GET http://127.0.0.1:4321/runs/run-1234567890/artifacts",
      "GET http://127.0.0.1:4321/runs/run-1234567890/factory-graph",
    ]);
    expect(result.graph.data.agents[0]?.id).toBe("agent-worker");
    expect(result.activity.data.activities[0]?.activityId).toBe(
      "activity-worker",
    );
    expect(result.agentActivity.data.activities[0]?.agentId).toBe(
      "agent-worker",
    );
    expect(result.artifacts.data.artifacts[0]?.artifactId).toBe(
      "artifact-plan",
    );
    expect(result.artifact.data.body).toContain("Plan body");
  });

  it("reads agent session snapshots and posts finite operator actions through LocalGaiaServerApi", async () => {
    const requests: Array<string> = [];
    const bodies: Array<unknown> = [];
    const result = await Effect.runPromise(
      Effect.all({
        action: actOnAgentSessionFromDashboardGaiaClient({
          action: {
            actionId: "action-steer-1",
            kind: "steer",
            sessionId: "session-run-1234567890",
            text: "Focus on the failing dashboard test.",
            turnId: "turn-1",
          },
          agentId: "agent-worker",
          runId: "run-1234567890",
          serverUrl: "http://127.0.0.1:4321",
        }),
        session: getAgentSessionFromDashboardGaiaClient({
          agentId: "agent-worker",
          runId: "run-1234567890",
          serverUrl: "http://127.0.0.1:4321",
        }),
      }).pipe(
        Effect.provide(
          recordingFetchLayer(requests, async (request) => {
            if (request.method === "POST") {
              bodies.push(await request.json());
              return jsonResponse(agentActionEnvelope);
            }
            return jsonResponse(agentSessionEnvelope);
          }),
        ),
      ),
    );

    expect(requests).toEqual([
      "POST http://127.0.0.1:4321/runs/run-1234567890/agents/agent-worker/session/actions",
      "GET http://127.0.0.1:4321/runs/run-1234567890/agents/agent-worker/session",
    ]);
    expect(bodies).toEqual([
      {
        actionId: "action-steer-1",
        kind: "steer",
        sessionId: "session-run-1234567890",
        text: "Focus on the failing dashboard test.",
        turnId: "turn-1",
      },
    ]);
    expect(result.session.data.state).toBe("running");
    expect(result.action.data.state).toBe("dispatchConfirmed");
  });

  it("maps factory client API failures into a tagged dashboard query error", async () => {
    const error = await Effect.runPromise(
      getFactoryAgentActivityFromDashboardGaiaClient({
        agentId: "missing-agent",
        runId: "run-1234567890",
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(
        Effect.provide(
          recordingFetchLayer([], () =>
            jsonResponse(
              {
                code: "FactoryAgentNotFound",
                message: "Factory agent was not found.",
                pathSegment: "missing-agent",
                recoverable: false,
                runId: "run-1234567890",
                status: 404,
              },
              { status: 404 },
            ),
          ),
        ),
        Effect.flip,
      ),
    );

    expect(error._tag).toBe("DashboardGaiaApiError");
    if (error._tag === "DashboardGaiaApiError") {
      expect(error.error.status).toBe(404);
      expect(error.error.code).toBe("FactoryAgentNotFound");
    }
  });

  it("reads allowlisted artifacts through the shared HttpApi contract", async () => {
    const requests: Array<string> = [];
    const result = await Effect.runPromise(
      getRunArtifactFromDashboardGaiaClient({
        artifactId: "report",
        runId: "run-1234567890",
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(
        Effect.provide(
          recordingFetchLayer(requests, () =>
            jsonResponse({
              data: {
                artifactId: "report",
                body: "# Report\n\nAll checks passed.\n",
                contentType: "text/markdown",
                runId: "run-1234567890",
              },
              status: "success",
            }),
          ),
        ),
      ),
    );

    expect(requests).toEqual([
      "GET http://127.0.0.1:4321/runs/run-1234567890/artifacts/report",
    ]);
    expect(result.data.artifactName).toBe("report");
    expect(result.data.body).toContain("All checks passed.");
  });

  it("rejects empty artifact identifiers before issuing a request", async () => {
    const requests: Array<string> = [];
    const error = await Effect.runPromise(
      getRunArtifactFromDashboardGaiaClient({
        artifactId: "",
        runId: "run-1234567890",
        serverUrl: "http://127.0.0.1:4321",
      }).pipe(
        Effect.provide(
          recordingFetchLayer(requests, () =>
            jsonResponse({
              data: {
                artifactName: "report",
                body: "",
                contentType: "text/plain",
                runId: "run-1234567890",
              },
              status: "success",
            }),
          ),
        ),
        Effect.flip,
      ),
    );

    expect(requests).toEqual([]);
    expect(error._tag).toBe("DashboardGaiaParameterError");
    if (error._tag === "DashboardGaiaParameterError") {
      expect(error.parameter).toBe("artifactId");
    }
  });

  it("surfaces typed client failures through effect-query and TanStack Query", async () => {
    const effectQuery = createEffectQuery(
      recordingFetchLayer([], () =>
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
      ),
    );

    const queryClient = new QueryClient();
    await queryClient
      .fetchQuery(
        effectQuery.queryOptions({
          queryKey: localGaiaQueryKeys.run("run-1234567890"),
          queryFn: () =>
            getRunFromDashboardGaiaClient({
              runId: "run-1234567890",
              serverUrl: "http://127.0.0.1:4321",
            }),
          retry: false,
        }),
      )
      .then(
        () => {
          throw new Error("Expected fetchQuery to fail.");
        },
        (error: unknown) => {
          expect(effectQueryFailure(error)?._tag).toBe("DashboardGaiaApiError");
        },
      );
  });

  it("creates issue-delivery runs through the exported effect-query mutation options", async () => {
    const requests: Array<string> = [];
    const bodies: Array<unknown> = [];
    const createRunInput = {
      description: "# Mutation proof\n\nRun the focused test.\n",
      title: "Mutation proof",
    };
    const createRunResponse = {
      acceptedAt: "2026-07-07T00:00:00.000Z",
      runId: "run-1234567890",
      status: "accepted",
      urls: {
        activity: "/runs/run-1234567890/activity",
        artifacts: "/runs/run-1234567890/artifacts",
        factoryGraph: "/runs/run-1234567890/factory-graph",
        run: "/runs/run-1234567890",
      },
    };
    const effectQuery = createEffectQuery(
      recordingFetchLayer(requests, async (request) => {
        const body: unknown = await request.json();
        bodies.push(body);
        return jsonResponse(createRunResponse, { status: 202 });
      }),
    );
    const mutation = localGaiaCreateRunMutationOptions(
      {
        serverUrl: "http://127.0.0.1:4321",
      },
      effectQuery,
    );

    expect(typeof mutation.mutationFn).toBe("function");
    if (mutation.mutationFn === undefined) {
      throw new Error("Expected create-run mutationFn to be defined.");
    }

    const result = await mutation.mutationFn(createRunInput, {
      client: new QueryClient(),
      meta: undefined,
    });

    expect(requests).toEqual(["POST http://127.0.0.1:4321/runs"]);
    expect(bodies).toEqual([
      {
        delivery: { mode: "local" },
        execution: { harnessProfileId: "codexAppServer" },
        workflow: "issueDelivery",
        workItem: {
          description: createRunInput.description,
          kind: "issue",
          title: createRunInput.title,
        },
      },
    ]);
    expect(result).toEqual(createRunResponse);
  });

  it("creates agent session action mutations with stable keys", async () => {
    const requests: Array<string> = [];
    const bodies: Array<unknown> = [];
    const effectQuery = createEffectQuery(
      recordingFetchLayer(requests, async (request) => {
        bodies.push(await request.json());
        return jsonResponse(agentActionEnvelope);
      }),
    );
    const mutation = localGaiaAgentSessionActionMutationOptions(
      {
        agentId: "agent-worker",
        runId: "run-1234567890",
        serverUrl: "http://127.0.0.1:4321",
      },
      effectQuery,
    );

    expect(mutation.mutationKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "agents",
      "agent-worker",
      "session",
      "action",
    ]);
    if (mutation.mutationFn === undefined) {
      throw new Error("Expected agent-session mutationFn to be defined.");
    }

    await mutation.mutationFn(
      {
        actionId: "action-interrupt-1",
        kind: "interrupt",
        sessionId: "session-run-1234567890",
        turnId: "turn-1",
      },
      { client: new QueryClient(), meta: undefined },
    );

    expect(requests).toEqual([
      "POST http://127.0.0.1:4321/runs/run-1234567890/agents/agent-worker/session/actions",
    ]);
    expect(bodies).toEqual([
      {
        actionId: "action-interrupt-1",
        kind: "interrupt",
        sessionId: "session-run-1234567890",
        turnId: "turn-1",
      },
    ]);
  });
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

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function effectQueryFailure(error: unknown) {
  if (typeof error !== "object" || error === null || !("failure" in error)) {
    return undefined;
  }

  const failure = error.failure;
  if (typeof failure === "object" && failure !== null && "_tag" in failure) {
    return failure;
  }

  return undefined;
}

const factoryGraphEnvelope = {
  data: {
    agents: [
      {
        artifactCount: 1,
        id: "agent-worker",
        role: "worker",
        state: "running",
        title: "Worker",
        workItemId: "work-root",
      },
    ],
    diagnostics: [],
    edges: [],
    execution: testFactoryExecution,
    linkedArtifacts: [
      {
        artifactId: "artifact-plan",
        contentType: "text/markdown",
        createdAt: "2026-07-08T12:00:00.000Z",
        kind: "plan",
        label: "Worker plan",
        ownerAgentId: "agent-worker",
        visibility: "run",
      },
    ],
    runId: "run-1234567890",
    version: 1,
    workflow: "issueDelivery",
    workItems: [
      {
        externalRefs: [],
        id: "work-root",
        kind: "issue",
        title: "FactoryGraph dashboard model",
      },
    ],
  },
  status: "success",
} as const;

const activityEnvelope = {
  data: {
    activities: [
      {
        activityId: "activity-worker",
        agentId: "agent-worker",
        artifactIds: ["artifact-plan"],
        kind: "worker.progress",
        label: "Worker produced a plan",
        runId: "run-1234567890",
        sequence: 1,
        state: "running",
        timestamp: "2026-07-08T12:00:00.000Z",
        workItemId: "work-root",
      },
    ],
    runId: "run-1234567890",
  },
  status: "success",
} as const;

const artifactListEnvelope = {
  data: {
    artifacts: [
      {
        artifactId: "artifact-plan",
        contentType: "text/markdown",
        createdAt: "2026-07-08T12:00:00.000Z",
        kind: "plan",
        label: "Worker plan",
        ownerAgentId: "agent-worker",
        visibility: "run",
      },
    ],
    runId: "run-1234567890",
  },
  status: "success",
} as const;

const artifactBodyEnvelope = {
  data: {
    artifactId: "artifact-plan",
    body: "# Plan body\n",
    contentType: "text/markdown",
    runId: "run-1234567890",
  },
  status: "success",
} as const;

const sessionCapabilities = {
  approvals: ["command", "fileChange", "permission", "userInput", "mcpElicitation"],
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: true,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: true,
  usageReporting: true,
  userQuestions: true,
} as const;

const agentSessionEnvelope = {
  data: {
    agentId: "agent-worker",
    capabilities: sessionCapabilities,
    eventSequence: 7,
    items: [
      {
        itemId: "item-message-1",
        kind: "message",
        phase: "commentary",
        status: "completed",
        text: "I am updating the Agent Inspector.",
        turnId: "turn-1",
      },
    ],
    pendingInteractions: [],
    recovered: false,
    resolvedInteractions: [],
    runId: "run-1234567890",
    sessionId: "session-run-1234567890",
    state: "running",
    turns: [{ status: "running", turnId: "turn-1" }],
  },
  status: "success",
} as const;

const agentActionEnvelope = {
  data: {
    actionId: "action-steer-1",
    agentId: "agent-worker",
    eventSequence: 8,
    payloadDigest:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    runId: "run-1234567890",
    sessionId: "session-run-1234567890",
    state: "dispatchConfirmed",
  },
  status: "success",
} as const;
