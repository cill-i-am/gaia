import {
  FactoryAgentIdSchema,
  FactoryArtifactIdSchema,
  parseLocalGaiaServerUrl,
  parseRunControlAction,
  parseRunId,
} from "@gaia/core";
import { QueryClient } from "@tanstack/react-query";
import { Effect, Layer, Schema } from "effect";
import { createEffectQuery } from "effect-query";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, it, describe } from "vitest";

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
import {
  DashboardRunControlActionMutationRequestIdSchema,
  localGaiaCreateRunMutationOptions,
  localGaiaDeliveryActionMutationOptions,
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
  localGaiaRunControlActionMutationOptions,
  localGaiaRunControlQueryOptions,
  localGaiaRunQueryOptions,
  localGaiaRunsQueryOptions,
} from "@/lib/local-gaia-query";
import { testFactoryExecution } from "@/test-factory-execution";

const runId = parseRunId("run-1234567890");
const serverUrl = parseLocalGaiaServerUrl("http://127.0.0.1:4321");
const agentWorkerId =
  Schema.decodeUnknownSync(FactoryAgentIdSchema)("agent-worker");
const missingAgentId =
  Schema.decodeUnknownSync(FactoryAgentIdSchema)("missing-agent");
const decodeDashboardRunControlActionMutationRequestId =
  Schema.decodeUnknownSync(DashboardRunControlActionMutationRequestIdSchema);
const artifactPlanId = Schema.decodeUnknownSync(FactoryArtifactIdSchema)(
  "artifact-plan"
);
const reportArtifactId = Schema.decodeUnknownSync(FactoryArtifactIdSchema)(
  "report"
);

describe("local Gaia query options", () => {
  it("keeps browser dashboard requests on the same-origin proxy path", () => {
    expect(defaultLocalGaiaServerUrl).toBe("/gaia-api");
  });

  it("constructs stable TanStack Query options through effect-query", () => {
    const health = localGaiaHealthQueryOptions({
      serverUrl,
    });
    const runs = localGaiaRunsQueryOptions({
      serverUrl,
    });
    const artifact = localGaiaRunArtifactQueryOptions({
      artifactId: "report",
      runId,
      serverUrl,
    });
    const graph = localGaiaFactoryGraphQueryOptions({
      runId,
      serverUrl,
    });
    const runActivity = localGaiaFactoryRunActivityQueryOptions({
      runId,
      serverUrl,
    });
    const agentActivity = localGaiaFactoryAgentActivityQueryOptions({
      agentId: "agent-worker",
      runId,
      serverUrl,
    });
    const artifactCatalog = localGaiaFactoryArtifactsQueryOptions({
      runId,
      serverUrl,
    });
    const factoryArtifact = localGaiaFactoryArtifactQueryOptions({
      artifactId: "artifact-plan",
      runId,
      serverUrl,
    });
    const agentSession = localGaiaAgentSessionQueryOptions({
      agentId: "agent-worker",
      runId,
      serverUrl,
    });
    const runControl = localGaiaRunControlQueryOptions({
      runId,
      serverUrl,
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
    expect(runControl.queryKey).toEqual([
      "local-gaia",
      "runs",
      "detail",
      "run-1234567890",
      "control",
    ]);
    expect(artifact.enabled).toBe(true);
    expect(graph.enabled).toBe(true);
    expect(runActivity.enabled).toBe(true);
    expect(agentActivity.enabled).toBe(true);
    expect(artifactCatalog.enabled).toBe(true);
    expect(factoryArtifact.enabled).toBe(true);
    expect(agentSession.enabled).toBe(true);
    expect(runControl.enabled).toBe(true);
    expect(typeof health.queryFn).toBe("function");
    expect(typeof runs.queryFn).toBe("function");
  });

  it("makes unselected run queries non-executable without fabricating an identity", async () => {
    const requests: Array<string> = [];
    const effectQuery = createEffectQuery(
      recordingFetchLayer(requests, () =>
        jsonResponse({ data: factoryGraphEnvelope.data, status: "success" })
      )
    );
    const graph = localGaiaFactoryGraphQueryOptions({
      runId: undefined,
      serverUrl,
    });
    const agentActivity = localGaiaFactoryAgentActivityQueryOptions({
      agentId: "",
      runId,
      serverUrl,
    });
    const agentSession = localGaiaAgentSessionQueryOptions({
      agentId: "",
      runId,
      serverUrl,
    });

    expect(graph.enabled).toBe(false);
    expect(graph.queryKey).toEqual([
      "local-gaia",
      "runs",
      "unselected",
      "factory-graph",
    ]);
    const queryClient = new QueryClient();
    const unselected = localGaiaFactoryGraphQueryOptions(
      {
        runId: undefined,
        serverUrl,
      },
      effectQuery
    );
    await expect(queryClient.fetchQuery(unselected)).rejects.toThrow(
      "data is undefined"
    );
    expect(requests).toEqual([]);
    expect(agentActivity.enabled).toBe(false);
    expect(agentActivity.queryKey).toEqual([
      "local-gaia",
      "runs",
      "unselected",
      "factory-agent-activity",
    ]);
    expect(agentSession.enabled).toBe(false);
    expect(agentSession.queryKey).toEqual([
      "local-gaia",
      "runs",
      "unselected",
      "agent-session",
    ]);
  });

  it("decodes run lists through the shared HttpApi contract", async () => {
    const requests: Array<string> = [];
    const result = await Effect.runPromise(
      listRunsFromDashboardGaiaClient({
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
      )
    );

    expect(result.data.runs).toEqual([]);
    expect(requests).toEqual(["GET http://127.0.0.1:4321/runs"]);
  });

  it("preserves the worker epoch and cancelled terminal state through the legacy dashboard run model", async () => {
    const epoch = {
      limitations: ["providerNativeToolInventoryNotExposed"],
      state: "completeComparable",
      structuralDigest: "a".repeat(64),
      version: 1,
    } as const;
    const result = await Effect.runPromise(
      listRunsFromDashboardGaiaClient({ serverUrl }).pipe(
        Effect.provide(
          recordingFetchLayer([], () =>
            jsonResponse({
              data: {
                diagnostics: [],
                runs: [
                  {
                    counts: {
                      activity: 1,
                      agents: 1,
                      artifacts: 0,
                      workItems: 1,
                    },
                    createdAt: "2026-07-22T11:20:00.000Z",
                    rootWorkItem: {
                      id: "work-root",
                      kind: "issue",
                      title: "GAIA-147",
                    },
                    runId,
                    state: "running",
                    updatedAt: "2026-07-22T11:21:00.000Z",
                    workerEnvironmentEpoch: epoch,
                    workflow: "issueDelivery",
                  },
                  {
                    counts: {
                      activity: 2,
                      agents: 1,
                      artifacts: 0,
                      workItems: 1,
                    },
                    createdAt: "2026-07-22T11:20:00.000Z",
                    rootWorkItem: {
                      id: "work-cancelled",
                      kind: "issue",
                      title: "GAIA-148",
                    },
                    runId: "run-148cancel1",
                    state: "canceled",
                    updatedAt: "2026-07-22T11:22:00.000Z",
                    workerEnvironmentEpoch: epoch,
                    workflow: "issueDelivery",
                  },
                ],
              },
              status: "success",
            })
          )
        )
      )
    );

    expect(result.data.runs[0]?.workerEnvironmentEpoch).toEqual(epoch);
    expect(result.data.runs[1]).toMatchObject({
      state: "cancelled",
      status: "cancelled",
    });
  });

  it("maps declared API failures into a tagged dashboard query error", async () => {
    const error = await Effect.runPromise(
      getRunFromDashboardGaiaClient({
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
                runId,
                status: 404,
              },
              { status: 404 }
            )
          )
        ),
        Effect.flip
      )
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
          runId,
          serverUrl,
        }),
        agentActivity: getFactoryAgentActivityFromDashboardGaiaClient({
          agentId: agentWorkerId,
          runId,
          serverUrl,
        }),
        artifact: getFactoryArtifactFromDashboardGaiaClient({
          artifactId: artifactPlanId,
          runId,
          serverUrl,
        }),
        artifacts: listFactoryArtifactsFromDashboardGaiaClient({
          runId,
          serverUrl,
        }),
        graph: getFactoryGraphFromDashboardGaiaClient({
          runId,
          serverUrl,
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
                  { status: 404 }
                );
            }
          })
        )
      )
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
      "activity-worker"
    );
    expect(result.agentActivity.data.activities[0]?.agentId).toBe(
      "agent-worker"
    );
    expect(result.artifacts.data.artifacts[0]?.artifactId).toBe(
      "artifact-plan"
    );
    expect(result.artifacts.data.artifacts[0]?.availability).toBe("available");
    expect(result.artifacts.data.artifacts[1]?.availability).toBe(
      "unavailable"
    );
    expect(result.artifacts.data.artifacts[1]?.diagnostic?.code).toBe(
      "ArtifactBodyMissing"
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
          agentId: agentWorkerId,
          runId,
          serverUrl,
        }),
        session: getAgentSessionFromDashboardGaiaClient({
          agentId: agentWorkerId,
          runId,
          serverUrl,
        }),
      }).pipe(
        Effect.provide(
          recordingFetchLayer(requests, async (request) => {
            if (request.method === "POST") {
              bodies.push(await request.json());
              return jsonResponse(agentActionEnvelope);
            }
            return jsonResponse(agentSessionEnvelope);
          })
        )
      )
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
        agentId: missingAgentId,
        runId,
        serverUrl,
      }).pipe(
        Effect.provide(
          recordingFetchLayer([], () =>
            jsonResponse(
              {
                code: "FactoryAgentNotFound",
                message: "Factory agent was not found.",
                pathSegment: "missing-agent",
                recoverable: false,
                runId,
                status: 404,
              },
              { status: 404 }
            )
          )
        ),
        Effect.flip
      )
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
        artifactId: reportArtifactId,
        runId,
        serverUrl,
      }).pipe(
        Effect.provide(
          recordingFetchLayer(requests, () =>
            jsonResponse({
              data: {
                artifactId: "report",
                body: "# Report\n\nAll checks passed.\n",
                contentType: "text/markdown",
                runId,
              },
              status: "success",
            })
          )
        )
      )
    );

    expect(requests).toEqual([
      "GET http://127.0.0.1:4321/runs/run-1234567890/artifacts/report",
    ]);
    expect(result.data.artifactName).toBe("report");
    expect(result.data.body).toContain("All checks passed.");
  });

  it("keeps empty artifact identifiers non-executable at the query boundary", () => {
    const query = localGaiaRunArtifactQueryOptions({
      artifactId: "",
      runId,
      serverUrl,
    });

    expect(query.enabled).toBe(false);
    expect(query.queryKey).toEqual([
      "local-gaia",
      "runs",
      "unselected",
      "run-artifact",
    ]);
  });

  it("surfaces typed client failures through effect-query and TanStack Query", async () => {
    const effectQuery = createEffectQuery(
      recordingFetchLayer([], () =>
        jsonResponse(
          {
            code: "RunNotFound",
            message: "Run was not found.",
            recoverable: false,
            runId,
            status: 404,
          },
          { status: 404 }
        )
      )
    );

    const queryClient = new QueryClient();
    await queryClient
      .fetchQuery(
        effectQuery.queryOptions({
          queryKey: localGaiaQueryKeys.run(runId),
          queryFn: () =>
            getRunFromDashboardGaiaClient({
              runId,
              serverUrl,
            }),
          retry: false,
        })
      )
      .then(
        () => {
          throw new Error("Expected fetchQuery to fail.");
        },
        (error: unknown) => {
          expect(effectQueryFailure(error)?._tag).toBe("DashboardGaiaApiError");
        }
      );
  });

  it("creates issue-delivery runs through the exported effect-query mutation options", async () => {
    const requests: Array<string> = [];
    const bodies: Array<unknown> = [];
    const createRunInput = {
      deliveryMode: "pullRequest" as const,
      description: "# Mutation proof\n\nRun the focused test.\n",
      title: "Mutation proof",
    };
    const createRunResponse = {
      acceptedAt: "2026-07-07T00:00:00.000Z",
      runId,
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
      })
    );
    const mutation = localGaiaCreateRunMutationOptions(
      {
        serverUrl,
      },
      effectQuery
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
        delivery: { mode: "pullRequest" },
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

  it("returns schema rejected mutation input through the dashboard parameter error channel", async () => {
    const requests: Array<string> = [];
    const effectQuery = createEffectQuery(
      recordingFetchLayer(requests, () =>
        jsonResponse({ data: factoryGraphEnvelope.data, status: "success" })
      )
    );
    const mutation = localGaiaCreateRunMutationOptions(
      {
        serverUrl,
      },
      effectQuery
    );
    if (mutation.mutationFn === undefined) {
      throw new Error("Expected create-run mutationFn to be defined.");
    }

    await mutation
      .mutationFn(
        {
          deliveryMode: "remote",
          description: "# Invalid mode",
          title: "Invalid mode",
        },
        { client: new QueryClient(), meta: undefined }
      )
      .then(
        () => {
          throw new Error("Expected mutation to fail.");
        },
        (error: unknown) => {
          expect(effectQueryFailure(error)?._tag).toBe(
            "DashboardGaiaParameterError"
          );
        }
      );
    expect(requests).toEqual([]);
  });

  it("sends strict delivery recovery actions through the typed API client", async () => {
    const requests: Array<string> = [];
    const bodies: Array<unknown> = [];
    const effectQuery = createEffectQuery(
      recordingFetchLayer(requests, async (request) => {
        bodies.push(await request.json());
        return jsonResponse({
          data: {
            eventSequence: 10,
            mode: "pullRequest",
            provenance: {
              baseBranch: "main",
              baseRevision: "a".repeat(40),
              headBranch: "gaia/run-1234567890",
              remote: "origin",
            },
            recoveryActions: [],
            runId,
            stage: "publishing",
            status: "publishing",
          },
          status: "success",
        });
      })
    );
    const mutation = localGaiaDeliveryActionMutationOptions(
      { serverUrl },
      effectQuery
    );
    if (mutation.mutationFn === undefined) {
      throw new Error("Expected delivery action mutationFn to be defined.");
    }

    await mutation.mutationFn(
      {
        action: { expectedEventSequence: 9, kind: "reconcile" },
        runId,
      },
      { client: new QueryClient(), meta: undefined }
    );

    expect(requests).toEqual([
      "POST http://127.0.0.1:4321/runs/run-1234567890/delivery/actions",
    ]);
    expect(bodies).toEqual([{ expectedEventSequence: 9, kind: "reconcile" }]);
  });

  it("creates agent session action mutations with stable keys", async () => {
    const requests: Array<string> = [];
    const bodies: Array<unknown> = [];
    const effectQuery = createEffectQuery(
      recordingFetchLayer(requests, async (request) => {
        bodies.push(await request.json());
        return jsonResponse(agentActionEnvelope);
      })
    );
    const mutation = localGaiaAgentSessionActionMutationOptions(
      { serverUrl },
      effectQuery
    );

    expect(mutation.mutationKey).toEqual([
      "local-gaia",
      "agent-session",
      "action",
    ]);
    if (mutation.mutationFn === undefined) {
      throw new Error("Expected agent-session mutationFn to be defined.");
    }

    await mutation.mutationFn(
      {
        action: {
          actionId: "action-interrupt-1",
          kind: "interrupt",
          sessionId: "session-run-1234567890",
          turnId: "turn-1",
        },
        agentId: agentWorkerId,
        runId,
      },
      { client: new QueryClient(), meta: undefined }
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

  it("keeps hidden run-control responses out of mutation cache on success and failure", async () => {
    const requests: Array<string> = [];
    const retained = new Map<string, ReturnType<typeof hiddenInput>>();
    let failProvider = false;
    const effectQuery = createEffectQuery(
      recordingFetchLayer(requests, async () => {
        expect(retained.size).toBe(0);
        return failProvider
          ? Promise.reject(new TypeError("The dashboard server is offline."))
          : jsonResponse({
              actionBindingDigest: "c".repeat(64),
              actionId: "action-dashboard-hidden-response",
              duplicate: false,
              operation: "resolveInteraction",
              runId,
              state: "confirmed",
            });
      })
    );
    const queryClient = new QueryClient();
    function hiddenInput(answer: string) {
      return {
        action: parseRunControlAction({
          actionId: "action-dashboard-hidden-response",
          authorityId: "authority-local",
          checkpointDigest: "a".repeat(64),
          expectedEventSequence: 7,
          interactionId: "interaction-question",
          operation: "resolveInteraction",
          providerId: "fake",
          requestDigest: "b".repeat(64),
          response: {
            answers: [
              {
                answers: [answer],
                questionId: "question-hidden",
              },
            ],
            kind: "userInput",
          },
          runId,
          sessionId: `session-${runId}`,
          workerAgentId: agentWorkerId,
          workerStartedSequence: 3,
        }),
        runId,
      };
    }
    const options = localGaiaRunControlActionMutationOptions(
      { serverUrl },
      ({ requestId }) => {
        const input = retained.get(requestId);
        retained.delete(requestId);
        if (input === undefined) throw new Error("Missing hidden input.");
        return input;
      },
      effectQuery
    );

    const successCanary = "MUTATION_CACHE_SUCCESS_SECRET";
    const successRequestId = decodeDashboardRunControlActionMutationRequestId(
      globalThis.crypto.randomUUID()
    );
    retained.set(successRequestId, hiddenInput(successCanary));
    const success = queryClient.getMutationCache().build(queryClient, options);
    await success.execute({ requestId: successRequestId });

    failProvider = true;
    const failureCanary = "MUTATION_CACHE_FAILURE_SECRET";
    const failureRequestId = decodeDashboardRunControlActionMutationRequestId(
      globalThis.crypto.randomUUID()
    );
    retained.set(failureRequestId, hiddenInput(failureCanary));
    const failure = queryClient.getMutationCache().build(queryClient, options);
    await expect(
      failure.execute({ requestId: failureRequestId })
    ).rejects.toBeDefined();

    expect(retained.size).toBe(0);
    const mutationCache = JSON.stringify(
      queryClient.getMutationCache().getAll()
    );
    expect(mutationCache).not.toContain(successCanary);
    expect(mutationCache).not.toContain(failureCanary);
    expect(mutationCache).not.toContain("question-hidden");
    expect(requests).toHaveLength(2);
  });
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
        availability: "available",
        artifactId: "artifact-plan",
        contentType: "text/markdown",
        createdAt: "2026-07-08T12:00:00.000Z",
        kind: "plan",
        label: "Worker plan",
        ownerAgentId: "agent-worker",
        visibility: "run",
      },
    ],
    runId,
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
        runId,
        sequence: 1,
        state: "running",
        timestamp: "2026-07-08T12:00:00.000Z",
        workItemId: "work-root",
      },
    ],
    runId,
  },
  status: "success",
} as const;

const artifactListEnvelope = {
  data: {
    artifacts: [
      {
        availability: "available",
        artifactId: "artifact-plan",
        contentType: "text/markdown",
        createdAt: "2026-07-08T12:00:00.000Z",
        kind: "plan",
        label: "Worker plan",
        ownerAgentId: "agent-worker",
        visibility: "run",
      },
      {
        availability: "unavailable",
        artifactId: "artifact-missing",
        contentType: "text/markdown",
        createdAt: "2026-07-08T12:00:00.000Z",
        diagnostic: {
          code: "ArtifactBodyMissing",
          message: "The event-referenced artifact body is missing.",
          recoverable: false,
        },
        kind: "plan",
        label: "Missing worker plan",
        ownerAgentId: "agent-worker",
        visibility: "run",
      },
    ],
    runId,
  },
  status: "success",
} as const;

const artifactBodyEnvelope = {
  data: {
    artifactId: "artifact-plan",
    body: "# Plan body\n",
    contentType: "text/markdown",
    runId,
  },
  status: "success",
} as const;

const sessionCapabilities = {
  approvals: [
    "command",
    "fileChange",
    "permission",
    "userInput",
    "mcpElicitation",
  ],
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
    runId,
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
    runId,
    sessionId: "session-run-1234567890",
    state: "dispatchConfirmed",
  },
  status: "success",
} as const;
