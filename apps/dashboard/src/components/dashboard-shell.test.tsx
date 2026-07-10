// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  FactoryActivityDto,
  AgentActionReceiptDto,
  AgentSessionSnapshotDto,
  FactoryArtifactBodyDto,
  FactoryArtifactDto,
  FactoryGraphDto,
  LocalRunApiErrorEnvelope,
  LocalRunArtifactDto,
  LocalRunReadDiagnosticDto,
  LocalRunSummaryDto,
} from "@gaia/core";
import {
  FactoryActivityIdSchema,
  FactoryAgentIdSchema,
  FactoryArtifactIdSchema,
  FactoryWorkItemIdSchema,
  RunIdSchema,
  makeRunEvent,
  parseHarnessActionId,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseWorkspaceRelativePath,
} from "@gaia/core";
import { testFactoryExecution } from "@/test-factory-execution";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DashboardShell,
  factoryFlowEdgeClassName,
  shouldAnimateFactoryEdge,
} from "@/components/dashboard-shell";
import type { DashboardGaiaClientError } from "@/lib/local-gaia-client";

type CreateRunAcceptedFixture = {
  readonly acceptedAt: string;
  readonly runId: string;
  readonly status: "accepted";
  readonly urls: {
    readonly activity: string;
    readonly artifacts: string;
    readonly factoryGraph: string;
    readonly run: string;
  };
};

type FactoryAgentState = (typeof FactoryGraphDto.Type)["agents"][number]["state"];
type FactoryGraphAgent = (typeof FactoryGraphDto.Type)["agents"][number];
type FactoryGraphEdge = (typeof FactoryGraphDto.Type)["edges"][number];

const queryFixture = vi.hoisted(
  (): {
    artifactsByRunId: Record<string, Record<string, unknown>>;
    factoryActivitiesByRunId: Record<string, ReadonlyArray<unknown>>;
    factoryActivityErrorsByRunId: Record<string, unknown>;
    factoryAgentActivitiesByRunId: Record<string, Record<string, ReadonlyArray<unknown>>>;
    factoryArtifactBodyRequests: Array<{
      readonly artifactId: string;
      readonly runId: string;
    }>;
    factoryArtifactBodyErrorsByRunId: Record<string, Record<string, unknown>>;
    factoryArtifactBodiesByRunId: Record<string, Record<string, unknown>>;
    factoryArtifactErrorsByRunId: Record<string, unknown>;
    factoryArtifactsByRunId: Record<string, ReadonlyArray<unknown>>;
    factoryGraphsByRunId: Record<string, unknown>;
    agentSessionActionInputs: Array<{
      readonly action: unknown;
      readonly agentId: string;
      readonly runId: string;
    }>;
    agentSessionsByRunId: Record<string, Record<string, unknown>>;
    createRunError: unknown;
    createRunInputs: Array<{
      readonly description: string;
      readonly title: string;
    }>;
    createRunPromise: Promise<CreateRunAcceptedFixture> | undefined;
    eventsByRunId: Record<string, ReadonlyArray<unknown>>;
    healthError?: unknown;
    runs: ReadonlyArray<unknown>;
    runsDiagnostics: ReadonlyArray<unknown>;
    runsError?: unknown;
    runsRequestCount: number;
  } => ({
    artifactsByRunId: {},
    factoryActivitiesByRunId: {},
    factoryActivityErrorsByRunId: {},
    factoryAgentActivitiesByRunId: {},
    factoryArtifactBodyRequests: [],
    factoryArtifactBodyErrorsByRunId: {},
    factoryArtifactBodiesByRunId: {},
    factoryArtifactErrorsByRunId: {},
    factoryArtifactsByRunId: {},
    factoryGraphsByRunId: {},
    agentSessionActionInputs: [],
    agentSessionsByRunId: {},
    createRunError: undefined,
    createRunInputs: [],
    createRunPromise: undefined,
    eventsByRunId: {},
    healthError: undefined,
    runs: [],
    runsDiagnostics: [],
    runsError: undefined,
    runsRequestCount: 0,
  }),
);

vi.mock("@/lib/local-gaia-query", () => ({
  localGaiaCreateRunMutationOptions: () => ({
    mutationFn: async (input: {
      readonly description: string;
      readonly title: string;
    }) => {
      queryFixture.createRunInputs.push(input);
      if (queryFixture.createRunError !== undefined) {
        return Promise.reject({ failure: queryFixture.createRunError });
      }

      const result =
        queryFixture.createRunPromise === undefined
          ? {
              acceptedAt: "2026-07-09T00:00:00.000Z",
              runId: "run-9999999999",
              status: "accepted" as const,
              urls: {
                activity: "/runs/run-9999999999/activity",
                artifacts: "/runs/run-9999999999/artifacts",
                factoryGraph: "/runs/run-9999999999/factory-graph",
                run: "/runs/run-9999999999",
              },
            }
          : await queryFixture.createRunPromise;

      queryFixture.runs = [
        {
          artifacts: [],
          createdAt: result.acceptedAt,
          eventCount: 0,
          latestEventType: "RUN_CREATED",
          runId: result.runId,
          state: "created",
          status: "running",
          updatedAt: result.acceptedAt,
        },
        ...queryFixture.runs,
      ];

      return result;
    },
    mutationKey: ["local-gaia", "create-run"] as const,
  }),
  localGaiaHealthQueryOptions: () => ({
    queryFn: () => {
      if (queryFixture.healthError !== undefined) {
        return Promise.reject({ failure: queryFixture.healthError });
      }

      return Promise.resolve({
        gaiaRoot: "/tmp/gaia",
        host: "127.0.0.1",
        pid: 12345,
        port: 8765,
        serverId: "srv_test",
        startedAt: "2026-07-07T12:00:00.000Z",
        status: "ok",
        updatedAt: "2026-07-07T12:00:00.000Z",
        url: "http://127.0.0.1:8765",
        version: 1,
        workspaceRoot: "/tmp/gaia",
      });
    },
    queryKey: ["local-gaia", "health"] as const,
    retry: false,
  }),
  localGaiaRunsQueryOptions: () => ({
    queryFn: () => {
      queryFixture.runsRequestCount += 1;
      if (queryFixture.runsError !== undefined) {
        return Promise.reject({ failure: queryFixture.runsError });
      }

      return Promise.resolve({
        data: {
          diagnostics: queryFixture.runsDiagnostics,
          runs: queryFixture.runs,
        },
        diagnostics: queryFixture.runsDiagnostics,
        status:
          queryFixture.runsDiagnostics.length > 0 ? "partial" : "success",
      });
    },
    queryKey: ["local-gaia", "runs"] as const,
    retry: false,
  }),
  localGaiaRunQueryOptions: (config: { readonly runId: string }) => ({
    enabled: config.runId.length > 0,
    queryFn: () => {
      const run = queryFixture.runs.find(
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          "runId" in candidate &&
          candidate.runId === config.runId,
      );

      return Promise.resolve({
        data: run,
        status: "success",
      });
    },
    queryKey: ["local-gaia", "runs", "detail", config.runId] as const,
    retry: false,
  }),
  localGaiaRunEventsQueryOptions: (config: { readonly runId: string }) => ({
    enabled: config.runId.length > 0,
    queryFn: () =>
      Promise.resolve({
        data: {
          events: queryFixture.eventsByRunId[config.runId] ?? [],
          runId: config.runId,
        },
        status: "success",
      }),
    queryKey: ["local-gaia", "runs", "detail", config.runId, "events"] as const,
    retry: false,
  }),
  localGaiaRunArtifactQueryOptions: (config: {
    readonly artifactId: string;
    readonly runId: string;
  }) => ({
    enabled: config.runId.length > 0 && config.artifactId.length > 0,
    queryFn: () => {
      const artifact = queryFixture.artifactsByRunId[config.runId]?.[
        config.artifactId
      ] ?? {
        artifactName: config.artifactId,
        body: `${config.artifactId} artifact body`,
        contentType: "text/plain",
        runId: config.runId,
      };

      return Promise.resolve({
        data: artifact,
        status: "success",
      });
    },
    queryKey: [
      "local-gaia",
      "runs",
      "detail",
      config.runId,
      "artifact",
      config.artifactId,
    ] as const,
    retry: false,
  }),
  localGaiaFactoryGraphQueryOptions: (config: { readonly runId: string }) => ({
    enabled: config.runId.length > 0,
    queryFn: () =>
      Promise.resolve({
        data: queryFixture.factoryGraphsByRunId[config.runId],
        status: "success",
      }),
    queryKey: [
      "local-gaia",
      "runs",
      "detail",
      config.runId,
      "factory-graph",
    ] as const,
    retry: false,
  }),
  localGaiaFactoryRunActivityQueryOptions: (config: {
    readonly runId: string;
  }) => ({
    enabled: config.runId.length > 0,
    queryFn: () => {
      const error = queryFixture.factoryActivityErrorsByRunId[config.runId];
      if (error !== undefined) {
        return Promise.reject({ failure: error });
      }

      return Promise.resolve({
        data: {
          activities: queryFixture.factoryActivitiesByRunId[config.runId] ?? [],
          runId: config.runId,
        },
        status: "success",
      });
    },
    queryKey: ["local-gaia", "runs", "detail", config.runId, "activity"] as const,
    retry: false,
  }),
  localGaiaFactoryAgentActivityQueryOptions: (config: {
    readonly agentId: string;
    readonly runId: string;
  }) => ({
    enabled: config.runId.length > 0 && config.agentId.length > 0,
    queryFn: () =>
      Promise.resolve({
        data: {
          activities:
            queryFixture.factoryAgentActivitiesByRunId[config.runId]?.[
              config.agentId
            ] ?? [],
          runId: config.runId,
        },
        status: "success",
      }),
    queryKey: [
      "local-gaia",
      "runs",
      "detail",
      config.runId,
      "agents",
      config.agentId,
      "activity",
    ] as const,
    retry: false,
  }),
  localGaiaAgentSessionQueryOptions: (config: {
    readonly agentId: string;
    readonly runId: string;
  }) => ({
    enabled: config.runId.length > 0 && config.agentId.length > 0,
    queryFn: () =>
      Promise.resolve({
        data:
          queryFixture.agentSessionsByRunId[config.runId]?.[config.agentId] ??
          undefined,
        status: "success",
      }),
    queryKey: [
      "local-gaia",
      "runs",
      "detail",
      config.runId,
      "agents",
      config.agentId,
      "session",
    ] as const,
    retry: false,
  }),
  localGaiaAgentSessionActionMutationOptions: (config: {
    readonly agentId: string;
    readonly runId: string;
  }) => ({
    mutationFn: async (action: unknown) => {
      queryFixture.agentSessionActionInputs.push({
        action,
        agentId: config.agentId,
        runId: config.runId,
      });
      return {
        data: agentActionReceipt({
          actionId:
            typeof action === "object" &&
            action !== null &&
            "actionId" in action &&
            typeof action.actionId === "string"
              ? parseHarnessActionId(action.actionId)
              : parseHarnessActionId("action-fixture"),
          agentId: agentId(config.agentId),
          runId: parseRunId(config.runId),
        }),
        status: "success",
      };
    },
    mutationKey: [
      "local-gaia",
      "runs",
      "detail",
      config.runId,
      "agents",
      config.agentId,
      "session",
      "action",
    ] as const,
  }),
  localGaiaFactoryArtifactsQueryOptions: (config: {
    readonly runId: string;
  }) => ({
    enabled: config.runId.length > 0,
    queryFn: () => {
      const error = queryFixture.factoryArtifactErrorsByRunId[config.runId];
      if (error !== undefined) {
        return Promise.reject({ failure: error });
      }

      return Promise.resolve({
        data: {
          artifacts: queryFixture.factoryArtifactsByRunId[config.runId] ?? [],
          runId: config.runId,
        },
        status: "success",
      });
    },
    queryKey: ["local-gaia", "runs", "detail", config.runId, "artifacts"] as const,
    retry: false,
  }),
  localGaiaFactoryArtifactQueryOptions: (config: {
    readonly artifactId: string;
    readonly runId: string;
  }) => ({
    enabled: config.runId.length > 0 && config.artifactId.length > 0,
    queryFn: () => {
      queryFixture.factoryArtifactBodyRequests.push({
        artifactId: config.artifactId,
        runId: config.runId,
      });
      const error = queryFixture.factoryArtifactBodyErrorsByRunId[
        config.runId
      ]?.[config.artifactId];
      if (error !== undefined) {
        return Promise.reject({ failure: error });
      }

      return Promise.resolve({
        data: queryFixture.factoryArtifactBodiesByRunId[config.runId]?.[
          config.artifactId
        ] ?? {
          artifactId: config.artifactId,
          body: `${config.artifactId} factory artifact body`,
          contentType: "text/markdown",
          runId: config.runId,
        },
        status: "success",
      });
    },
    queryKey: [
      "local-gaia",
      "runs",
      "detail",
      config.runId,
      "artifacts",
      config.artifactId,
    ] as const,
    retry: false,
  }),
}));

beforeEach(() => {
  installBrowserApiPolyfills();
});

afterEach(() => {
  cleanup();
  delete (globalThis as { EventSource?: unknown }).EventSource;
  delete (window as { EventSource?: unknown }).EventSource;
});

describe("DashboardShell Run Console", () => {
  it("renders FactoryGraph topology and agent evidence from public factory reads", async () => {
    const runId = parseRunId("run-9090909090");
    const workerId = agentId("agent-worker");
    const artifactId = artifactIdValue("artifact-summary");
    const view = renderDashboardWithQueries({
      factoryActivitiesByRunId: {
        [runId]: [
          factoryActivity({
            activityId: activityId("activity-root"),
            label: "Issue delivery graph created",
            runId,
            workItemId: workItemId("work-root"),
          }),
        ],
      },
      factoryAgentActivitiesByRunId: {
        [runId]: {
          [workerId]: [
            factoryActivity({
              activityId: activityId("activity-worker"),
              agentId: workerId,
              artifactIds: [artifactId],
              label: "Worker produced code summary",
              runId,
            }),
          ],
        },
      },
      factoryArtifactBodiesByRunId: {
        [runId]: {
          [artifactId]: factoryArtifactBody({
            artifactId,
            body: "Worker summary body from the factory artifact endpoint.",
            runId,
          }),
        },
      },
      factoryArtifactsByRunId: {
        [runId]: [
          factoryArtifact({
            artifactId,
            label: "Code summary",
            ownerAgentId: workerId,
          }),
        ],
      },
      factoryGraphsByRunId: {
        [runId]: factoryGraph({
          runId,
          workerArtifactId: artifactId,
          workerId,
        }),
      },
      runs: [
        localRunSummary({
          artifacts: [],
          eventCount: 0,
          latestEventType: "RUN_CREATED",
          runId,
          state: "runningWorker",
          status: "running",
        }),
      ],
    });

    await screen.findByTestId("selected-run-title");

    expect(screen.getByRole("heading", { name: "GAIA" }).className).toContain(
      "gaia-logo-wordmark",
    );
    expect(await screen.findAllByText("Issue orchestrator")).not.toHaveLength(0);
    expect(await screen.findAllByText("Worker")).not.toHaveLength(0);
    expect(await screen.findAllByText("Reviewer")).not.toHaveLength(0);
    expect(await screen.findAllByText("Tester")).not.toHaveLength(0);
    expect(await screen.findAllByText("CI watcher")).not.toHaveLength(0);
    expect(screen.queryByText("Run Canvas")).toBeNull();
    expect(
      screen.queryByText("FactoryGraph topology for the selected run"),
    ).toBeNull();
    expect(screen.queryByText("6 nodes")).toBeNull();
    expect(screen.queryByText("Run root")).toBeNull();
    expect(screen.queryByText("Worker lane")).toBeNull();
    expect(screen.queryByTestId("event-strip-event-1")).toBeNull();
    expect(screen.queryByTestId("run-replay-scrubber")).toBeNull();
    expect(screen.queryByTestId("run-compare-panel")).toBeNull();
    expect(screen.queryByTestId("source-detail-panel")).toBeNull();
    expect(screen.queryByTestId("issue-delivery-intake-form")).toBeNull();
    expect(screen.getByRole("button", { name: "New run" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Provenance" })).toBeNull();
    expect(screen.queryByText("No node selected")).toBeNull();
    expect(screen.queryByTestId("evidence-studio-panel")).toBeNull();
    expect(screen.getByTestId("command-rail-footer").textContent).toContain(
      "/gaia-api",
    );
    expect(screen.getByTestId("mobile-workspace-canvas").className).toContain(
      "h-[30rem]",
    );
    expect(view.container.querySelector('[data-id^="work-item:"]')).toBeNull();

    const workerNode = view.container.querySelector('[data-id="agent:agent-worker"]');
    if (workerNode === null) {
      throw new Error("Expected a worker FactoryGraph node.");
    }
    expect(workerNode.getAttribute("class")).toContain("h-36");
    expect(workerNode.getAttribute("class")).toContain("w-80");
    expect(workerNode.querySelector('[data-slot="card"]')).not.toBeNull();
    expect(workerNode.textContent).toContain("implements changes");
    expect(workerNode.textContent).not.toContain("Activity linked");
    expect(workerNode.textContent).not.toContain("activities");
    const workerNodeIconClassName =
      workerNode.querySelector("svg")?.parentElement?.getAttribute("class") ?? "";
    expect(workerNodeIconClassName).toContain("border-border");
    expect(workerNodeIconClassName).not.toMatch(
      /rose|amber|sky|cyan|emerald|indigo/,
    );
    fireEvent.click(workerNode);

    await waitFor(() => {
      expect(screen.getAllByText("Worker produced code summary")).not.toHaveLength(0);
      expect(screen.getAllByText("Code summary")).not.toHaveLength(0);
      expect(screen.getByTestId("agent-inspector-panel").getAttribute("data-slot")).toBe(
        "sheet-content",
      );
      const summaryIconClassName =
        screen
          .getByTestId("agent-inspector-panel")
          .querySelector('[data-slot="factory-evidence-summary-icon"]')
          ?.getAttribute("class") ?? "";
      expect(summaryIconClassName).toContain("border-border");
      expect(summaryIconClassName).not.toMatch(
        /rose|amber|sky|cyan|emerald|indigo/,
      );
    });
    expect(screen.getByTestId("agent-inspector-panel").textContent).not.toContain(
      "Role:",
    );
    expect(screen.getByTestId("agent-inspector-panel").textContent).not.toContain(
      "State:",
    );
    expect(screen.getByTestId("agent-inspector-panel").textContent).not.toContain(
      "Work item:",
    );
    expect(screen.getByTestId("agent-inspector-panel").textContent).toContain(
      "Operator note",
    );
    expect(screen.getByTestId("agent-inspector-panel").textContent).toContain(
      "Agent Inspector",
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Session",
      "Activity",
      "Artifacts",
    ]);
    expect(screen.getByTestId("agent-inspector-panel").textContent).not.toContain(
      "Query",
    );

    for (const artifactsTab of screen.getAllByRole("tab", {
      name: "Artifacts",
    })) {
      fireEvent.pointerDown(artifactsTab);
      fireEvent.mouseDown(artifactsTab);
      fireEvent.mouseUp(artifactsTab);
      fireEvent.click(artifactsTab);
    }
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Code summary" })).not.toHaveLength(0);
      expect(screen.getAllByText("Select an artifact")).not.toHaveLength(0);
    });
    expect(queryFixture.factoryArtifactBodyRequests).toEqual([]);

    fireEvent.click(firstElement(screen.getAllByRole("button", { name: "Code summary" })));

    await waitFor(() => {
      expect(screen.getAllByText("Worker summary body from the factory artifact endpoint.")).not.toHaveLength(0);
    });
    expect(queryFixture.factoryArtifactBodyRequests).toContainEqual({
      artifactId,
      runId,
    });

    fireEvent.click(firstElement(screen.getAllByRole("button", { name: "Close Agent Inspector" })));

    await waitFor(() => {
      expect(screen.queryByTestId("agent-inspector-panel")).toBeNull();
      expect(screen.queryByText("Worker produced code summary")).toBeNull();
    });

    fireEvent.click(workerNode);

    await waitFor(() => {
      expect(screen.getByTestId("agent-inspector-panel").textContent).toContain(
        "Worker produced code summary",
      );
    });
  });

  it("renders live Agent Inspector controls and finite pending interaction actions", async () => {
    installMockEventSource();
    const runId = parseRunId("run-7070707070");
    const workerId = agentId("agent-worker");
    const view = renderDashboardWithQueries({
      agentSessionsByRunId: {
        [runId]: {
          [workerId]: agentSessionSnapshot({
            agentId: workerId,
            pendingInteractions: [
              {
                allowedDecisions: ["approve", "decline"],
                command: "pnpm check",
                interactionId: parseHarnessInteractionId("interaction-command"),
                itemId: parseHarnessItemId("item-command-approval"),
                kind: "commandApproval",
                requestedAt: "2026-07-10T21:11:00.000Z",
                turnId: parseHarnessTurnId("turn-1"),
                workspacePath: parseWorkspaceRelativePath("."),
              },
            ],
            runId,
          }),
        },
      },
      runs: [
        localRunSummary({
          runId,
          state: "runningWorker",
          status: "running",
        }),
      ],
    });

    await screen.findByTestId("selected-run-title");
    const workerNode = await waitFor(() => {
      const node = view.container.querySelector('[data-id="agent:agent-worker"]');
      if (node === null) {
        throw new Error("Expected a worker FactoryGraph node.");
      }
      return node;
    });
    fireEvent.click(workerNode);

    await waitFor(() => {
      expect(screen.getByTestId("agent-inspector-panel").textContent).toContain(
        "Agent Inspector",
      );
      expect(screen.getByTestId("agent-inspector-panel").textContent).toContain(
        "Command approval",
      );
    });

    const composer = screen.getByPlaceholderText("Steer the active turn");
    fireEvent.change(composer, {
      target: { value: "Keep the Inspector local-api only." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send steer" }));
    fireEvent.click(screen.getByRole("button", { name: "Interrupt turn" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve command approval" }));

    await waitFor(() => {
      expect(queryFixture.agentSessionActionInputs).toHaveLength(3);
    });
    expect(queryFixture.agentSessionActionInputs.map((input) => input.action)).toEqual([
      expect.objectContaining({
        kind: "steer",
        sessionId: "session-run-7070707070",
        text: "Keep the Inspector local-api only.",
        turnId: "turn-1",
      }),
      expect.objectContaining({
        kind: "interrupt",
        sessionId: "session-run-7070707070",
        turnId: "turn-1",
      }),
      expect.objectContaining({
        decision: "approve",
        interactionId: "interaction-command",
        kind: "approval",
        sessionId: "session-run-7070707070",
      }),
    ]);
    expect(screen.queryByRole("button", { name: "Approve for session command approval" })).toBeNull();
  });

  it("keeps the cached agent session snapshot after closing and reselecting Inspector", async () => {
    installMockEventSource();
    const runId = parseRunId("run-7070707071");
    const workerId = agentId("agent-worker");
    const view = renderDashboardWithQueries({
      agentSessionsByRunId: {
        [runId]: {
          [workerId]: agentSessionSnapshot({
            agentId: workerId,
            pendingInteractions: [
              {
                allowedDecisions: ["approve", "decline"],
                command: "pnpm check",
                interactionId: parseHarnessInteractionId("interaction-command"),
                itemId: parseHarnessItemId("item-command-approval"),
                kind: "commandApproval",
                requestedAt: "2026-07-10T21:11:00.000Z",
                turnId: parseHarnessTurnId("turn-1"),
                workspacePath: parseWorkspaceRelativePath("."),
              },
            ],
            runId,
            state: "waitingForOperator",
          }),
        },
      },
      runs: [
        localRunSummary({
          runId,
          state: "runningWorker",
          status: "running",
        }),
      ],
    });

    await screen.findByTestId("selected-run-title");
    const workerNode = await waitFor(() => {
      const node = view.container.querySelector('[data-id="agent:agent-worker"]');
      if (node === null) {
        throw new Error("Expected a worker FactoryGraph node.");
      }
      return node;
    });

    fireEvent.click(workerNode);
    await waitFor(() => {
      expect(screen.getByTestId("agent-inspector-panel").textContent).toContain(
        "Command approval",
      );
    });

    fireEvent.click(firstElement(screen.getAllByRole("button", { name: "Close Agent Inspector" })));
    await waitFor(() => {
      expect(screen.queryByTestId("agent-inspector-panel")).toBeNull();
    });

    fireEvent.click(workerNode);
    await waitFor(() => {
      expect(screen.getByTestId("agent-inspector-panel").textContent).toContain(
        "Command approval",
      );
    });
    expect(screen.getByTestId("agent-inspector-panel").textContent).not.toContain(
      "Agent session is connecting.",
    );
  });

  it("animates FactoryGraph edges only when connected work is running", () => {
    expect(shouldAnimateFactoryEdge("running", "succeeded")).toBe(true);
    expect(shouldAnimateFactoryEdge("succeeded", "running")).toBe(true);
    expect(shouldAnimateFactoryEdge("succeeded", "succeeded")).toBe(false);
    expect(shouldAnimateFactoryEdge("succeeded", "unknown")).toBe(false);
    expect(shouldAnimateFactoryEdge("unknown", undefined)).toBe(false);
  });

  it("styles FactoryGraph connectors by selected path and active work", () => {
    expect(
      factoryFlowEdgeClassName({
        animated: false,
        hasSelectedNode: false,
        selectedPath: false,
      }),
    ).toBe("factory-flow-edge");
    expect(
      factoryFlowEdgeClassName({
        animated: false,
        hasSelectedNode: true,
        selectedPath: false,
      }),
    ).toContain("factory-flow-edge-unselected");
    expect(
      factoryFlowEdgeClassName({
        animated: false,
        hasSelectedNode: true,
        selectedPath: true,
      }),
    ).toContain("factory-flow-edge-selected");
    expect(
      factoryFlowEdgeClassName({
        animated: true,
        hasSelectedNode: true,
        selectedPath: true,
      }),
    ).toContain("factory-flow-edge-active");
  });

  it("renders duplicate-role branches and preserves selected agent handoff", async () => {
    const runId = parseRunId("run-5353535353");
    const orchestratorId = agentId("agent-orchestrator");
    const workerAId = agentId("agent-worker-a");
    const workerBId = agentId("agent-worker-b");
    const reviewerId = agentId("agent-reviewer");
    const workerBArtifactId = artifactIdValue("artifact-worker-b-summary");
    const view = renderDashboardWithQueries({
      factoryAgentActivitiesByRunId: {
        [runId]: {
          [workerBId]: [
            factoryActivity({
              activityId: activityId("activity-worker-b"),
              agentId: workerBId,
              artifactIds: [workerBArtifactId],
              label: "Worker B produced implementation summary",
              runId,
            }),
          ],
        },
      },
      factoryArtifactsByRunId: {
        [runId]: [
          factoryArtifact({
            artifactId: workerBArtifactId,
            label: "Worker B summary",
            ownerAgentId: workerBId,
          }),
        ],
      },
      factoryGraphsByRunId: {
        [runId]: factoryGraph({
          agents: [
            {
              artifactCount: 0,
              id: orchestratorId,
              role: "orchestrator",
              state: "running",
              subState: "coordinating duplicate workers",
              title: "Issue orchestrator",
              workItemId: workItemId("work-root"),
            },
            {
              artifactCount: 0,
              id: workerAId,
              parentAgentId: orchestratorId,
              role: "worker",
              state: "running",
              subState: "implementing first branch",
              title: "Worker A",
              workItemId: workItemId("work-root"),
            },
            {
              artifactCount: 1,
              id: workerBId,
              parentAgentId: orchestratorId,
              role: "worker",
              state: "running",
              subState: "implementing second branch",
              title: "Worker B",
              workItemId: workItemId("work-root"),
            },
            {
              artifactCount: 0,
              id: reviewerId,
              parentAgentId: workerAId,
              role: "reviewer",
              state: "pending",
              subState: "waiting for both worker branches",
              title: "Reviewer",
              workItemId: workItemId("work-root"),
            },
          ],
          edges: [
            factoryGraphEdge(
              "edge-spawned-a",
              "agent-orchestrator",
              "agent-worker-a",
              "spawned",
            ),
            factoryGraphEdge(
              "edge-spawned-b",
              "agent-orchestrator",
              "agent-worker-b",
              "spawned",
            ),
            factoryGraphEdge(
              "edge-reviewed-a",
              "agent-worker-a",
              "agent-reviewer",
              "reviewed",
            ),
            factoryGraphEdge(
              "edge-reviewed-b",
              "agent-worker-b",
              "agent-reviewer",
              "reviewed",
            ),
          ],
          linkedArtifacts: [
            factoryArtifact({
              artifactId: workerBArtifactId,
              label: "Worker B summary",
              ownerAgentId: workerBId,
            }),
          ],
          runId,
          workerArtifactId: workerBArtifactId,
          workerId: workerBId,
        }),
      },
      runs: [
        localRunSummary({
          runId,
          state: "runningWorker",
          status: "running",
        }),
      ],
    });

    await screen.findByTestId("selected-run-title");
    expect(await screen.findAllByText("Worker A")).not.toHaveLength(0);
    expect(await screen.findAllByText("Worker B")).not.toHaveLength(0);
    expect(view.container.querySelector('[data-id^="work-item:"]')).toBeNull();

    const workerBNode = view.container.querySelector(
      '[data-id="agent:agent-worker-b"]',
    );
    if (workerBNode === null) {
      throw new Error("Expected duplicate worker FactoryGraph node.");
    }

    fireEvent.click(workerBNode);

    await waitFor(() => {
      expect(workerBNode.getAttribute("class")).toContain("ring-2");
      expect(
        screen.getAllByText("Worker B produced implementation summary"),
      ).not.toHaveLength(0);
      expect(
        screen.getByTestId("agent-inspector-panel").getAttribute("data-slot"),
      ).toBe("sheet-content");
    });
  });

  it("uses selected FactoryGraph artifacts instead of a misleading zero artifact rail count", async () => {
    const runId = parseRunId("run-1515151515");
    const workerId = agentId("agent-worker");
    const orchestratorId = agentId("agent-orchestrator");
    const graphArtifacts = Array.from({ length: 12 }, (_, index) => {
      const artifactNumber = index + 1;

      return factoryArtifact({
        artifactId: artifactIdValue(`artifact-factory-${artifactNumber}`),
        label: `Factory artifact ${artifactNumber}`,
        ownerAgentId: index < 4 ? workerId : orchestratorId,
      });
    });
    const workerArtifactId = firstElement(graphArtifacts).artifactId;
    const view = renderDashboardWithQueries({
      factoryArtifactsByRunId: {
        [runId]: graphArtifacts,
      },
      factoryGraphsByRunId: {
        [runId]: factoryGraph({
          linkedArtifacts: graphArtifacts,
          runId,
          workerArtifactCount: 4,
          workerArtifactId,
          workerId,
        }),
      },
      runs: [
        localRunSummary({
          artifacts: [],
          eventCount: 3,
          latestEventType: "RUN_CREATED",
          runId,
          state: "runningWorker",
          status: "running",
        }),
      ],
    });

    const row = await screen.findByTestId("run-console-row-run-1515151515");

    await waitFor(() => {
      expect(row.textContent).toContain("12 graph artifacts");
      expect(row.textContent).not.toContain("0 artifacts");
    });

    const workerNode = view.container.querySelector('[data-id="agent:agent-worker"]');
    if (workerNode === null) {
      throw new Error("Expected a worker FactoryGraph node.");
    }
    fireEvent.click(workerNode);

    for (const artifactsTab of screen.getAllByRole("tab", {
      name: "Artifacts",
    })) {
      fireEvent.pointerDown(artifactsTab);
      fireEvent.mouseDown(artifactsTab);
      fireEvent.mouseUp(artifactsTab);
      fireEvent.click(artifactsTab);
    }

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: "Factory artifact 4" }),
      ).not.toHaveLength(0);
      expect(
        screen.queryByRole("button", { name: "Factory artifact 5" }),
      ).toBeNull();
    });
  });

  it("shows typed artifact body failures without reading hidden files", async () => {
    const runId = parseRunId("run-9191919191");
    const workerId = agentId("agent-worker");
    const artifactId = artifactIdValue("artifact-summary");
    const view = renderDashboardWithQueries({
      factoryArtifactBodyErrorsByRunId: {
        [runId]: {
          [artifactId]: {
            _tag: "DashboardGaiaApiError",
            error: localRunApiError({
              code: "ArtifactNotFound",
              message: "Factory artifact was not found.",
              status: 404,
            }),
          },
        },
      },
      factoryArtifactsByRunId: {
        [runId]: [
          factoryArtifact({
            artifactId,
            label: "Code summary",
            ownerAgentId: workerId,
          }),
        ],
      },
      factoryGraphsByRunId: {
        [runId]: factoryGraph({
          runId,
          workerArtifactId: artifactId,
          workerId,
        }),
      },
      runs: [
        localRunSummary({
          runId,
          state: "runningWorker",
          status: "running",
        }),
      ],
    });

    await screen.findByTestId("selected-run-title");
    await screen.findAllByText("Worker");
    const workerNode = await waitFor(() => {
      const node = view.container.querySelector('[data-id="agent:agent-worker"]');
      if (node === null) {
        throw new Error("Expected a worker FactoryGraph node.");
      }
      return node;
    });
    fireEvent.click(workerNode);

    for (const artifactsTab of screen.getAllByRole("tab", {
      name: "Artifacts",
    })) {
      fireEvent.click(artifactsTab);
    }
    fireEvent.click(
      firstElement(screen.getAllByRole("button", { name: "Code summary" })),
    );

    const error = await screen.findAllByTestId("evidence-artifact-error");
    expect(firstElement(error).textContent).toContain(
      "ArtifactNotFound: Factory artifact was not found.",
    );
    expect(queryFixture.factoryArtifactBodyRequests).toContainEqual({
      artifactId,
      runId,
    });
  });

  it("shows artifact catalog unavailability for a selected agent", async () => {
    const runId = parseRunId("run-9292929292");
    const view = renderDashboardWithQueries({
      factoryArtifactErrorsByRunId: {
        [runId]: {
          _tag: "DashboardGaiaApiError",
          error: localRunApiError({
            code: "InternalServerError",
            message: "Artifact catalog could not be read.",
            status: 500,
          }),
        },
      },
      runs: [
        localRunSummary({
          runId,
          state: "runningWorker",
          status: "running",
        }),
      ],
    });

    await screen.findByTestId("selected-run-title");
    await screen.findAllByText("Worker");
    const workerNode = await waitFor(() => {
      const node = view.container.querySelector('[data-id="agent:agent-worker"]');
      if (node === null) {
        throw new Error("Expected a worker FactoryGraph node.");
      }
      return node;
    });
    fireEvent.click(workerNode);

    await waitFor(() => {
      expect(
        screen
          .getAllByTestId("factory-diagnostic-callout")
          .some((callout) =>
            callout.textContent?.includes("Artifacts unavailable"),
          ),
      ).toBe(true);
      expect(
        screen
          .getAllByTestId("factory-diagnostic-callout")
          .some((callout) =>
            callout.textContent?.includes(
              "InternalServerError: Artifact catalog could not be read.",
            ),
          ),
      ).toBe(true);
    });
  });

  it("renders selected agent activity when run activity fails", async () => {
    const runId = parseRunId("run-9393939393");
    const workerId = agentId("agent-worker");
    const view = renderDashboardWithQueries({
      factoryActivityErrorsByRunId: {
        [runId]: {
          _tag: "DashboardGaiaApiError",
          error: localRunApiError({
            code: "InternalServerError",
            message: "Run activity could not be read.",
            status: 500,
          }),
        },
      },
      factoryAgentActivitiesByRunId: {
        [runId]: {
          [workerId]: [
            factoryActivity({
              activityId: activityId("activity-worker-independent"),
              agentId: workerId,
              label: "Worker activity remains available",
              runId,
            }),
          ],
        },
      },
      runs: [
        localRunSummary({
          runId,
          state: "runningWorker",
          status: "running",
        }),
      ],
    });

    await screen.findByTestId("selected-run-title");
    await screen.findAllByText("Worker");
    const workerNode = await waitFor(() => {
      const node = view.container.querySelector('[data-id="agent:agent-worker"]');
      if (node === null) {
        throw new Error("Expected a worker FactoryGraph node.");
      }
      return node;
    });
    fireEvent.click(workerNode);

    await waitFor(() => {
      expect(screen.getAllByText("Worker activity remains available")).not.toHaveLength(0);
      expect(screen.queryByText("Run activity could not be read.")).toBeNull();
      expect(screen.queryByText("Agent activity could not be loaded.")).toBeNull();
    });
  });

  it("renders duplicate review activity labels without React key warnings", async () => {
    const consoleErrors = captureConsoleErrors();
    const runId = parseRunId("run-9494949494");
    const reviewerId = agentId("agent-reviewer");
    const workerId = agentId("agent-worker");
    const workerArtifactId = artifactIdValue("artifact-summary");
    const reviewActivities = [
      factoryActivity({
        activityId: activityId("activity-review-plan-started"),
        agentId: reviewerId,
        kind: "REVIEW_STARTED",
        label: "Review started",
        runId,
        sequence: 3,
        state: "running",
        subState: "plan",
        timestamp: "2026-07-08T12:02:00.000Z",
      }),
      factoryActivity({
        activityId: activityId("activity-review-plan-completed"),
        agentId: reviewerId,
        kind: "REVIEW_COMPLETED",
        label: "Review completed",
        runId,
        sequence: 4,
        state: "succeeded",
        subState: "plan",
        timestamp: "2026-07-08T12:03:00.000Z",
      }),
      factoryActivity({
        activityId: activityId("activity-review-evidence-started"),
        agentId: reviewerId,
        kind: "REVIEW_STARTED",
        label: "Review started",
        runId,
        sequence: 9,
        state: "running",
        subState: "evidence",
        timestamp: "2026-07-08T12:08:00.000Z",
      }),
      factoryActivity({
        activityId: activityId("activity-review-evidence-completed"),
        agentId: reviewerId,
        kind: "REVIEW_COMPLETED",
        label: "Review completed",
        runId,
        sequence: 10,
        state: "succeeded",
        subState: "evidence",
        timestamp: "2026-07-08T12:09:00.000Z",
      }),
    ];
    try {
      const view = renderDashboardWithQueries({
        factoryAgentActivitiesByRunId: {
          [runId]: {
            [reviewerId]: reviewActivities,
          },
        },
        factoryActivitiesByRunId: {
          [runId]: reviewActivities,
        },
        factoryGraphsByRunId: {
          [runId]: factoryGraph({
            runId,
            workerArtifactId,
            workerId,
          }),
        },
        runs: [
          localRunSummary({
            eventCount: 12,
            latestEventType: "REPORT_COMPLETED",
            runId,
            state: "completed",
            status: "completed",
          }),
        ],
      });
      await screen.findByTestId("selected-run-title");
      const reviewerNode = await waitFor(() => {
        const node = view.container.querySelector(
          '[data-id="agent:agent-reviewer"]',
        );
        if (node === null) {
          throw new Error("Expected a reviewer FactoryGraph node.");
        }

        return node;
      });
      fireEvent.click(reviewerNode);

      for (const activityTab of screen.getAllByRole("tab", {
        name: "Activity",
      })) {
        fireEvent.pointerDown(activityTab);
        fireEvent.mouseDown(activityTab);
        fireEvent.mouseUp(activityTab);
        fireEvent.click(activityTab);
      }

      await waitFor(() => {
        expect(screen.getAllByText("Review started")).toHaveLength(2);
        expect(screen.getAllByText("Review completed")).toHaveLength(2);
      });
      expect(consoleErrors.messages).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "Encountered two children with the same key",
          ),
        ]),
      );
    } finally {
      consoleErrors.restore();
    }
  });

  it("renders typed runs data and updates selected run state on row click", async () => {
    const firstRunId = parseRunId("run-1111111111");
    const secondRunId = parseRunId("run-2222222222");
    const view = renderDashboardWithQueries({
      artifactsByRunId: {
        [firstRunId]: {
          input: localRunArtifact({
            artifactName: "input",
            body: "# Smoke spec\n\nRun the fake harness.\n",
            runId: firstRunId,
          }),
          "worker-plan": localRunArtifact({
            artifactName: "worker-plan",
            body: "Worker plan body from the allowlisted API.",
            runId: firstRunId,
          }),
        },
      },
      eventsByRunId: {
        [firstRunId]: [
          makeRunEvent({
            payload: { specPath: "input.md" },
            runId: firstRunId,
            sequence: 1,
            timestamp: "2026-07-07T12:00:00.000Z",
            type: "RUN_CREATED",
          }),
          makeRunEvent({
            runId: firstRunId,
            sequence: 2,
            timestamp: "2026-07-07T12:01:00.000Z",
            type: "WORKER_STARTED",
          }),
        ],
      },
      runs: [
        localRunSummary({
          runId: firstRunId,
          status: "running",
          state: "runningWorker",
          latestEventType: "WORKER_STARTED",
          eventCount: 5,
          updatedAt: "2026-07-07T12:30:00.000Z",
        }),
        localRunSummary({
          runId: secondRunId,
          status: "completed",
          state: "completed",
          latestEventType: "REPORT_COMPLETED",
          eventCount: 12,
          updatedAt: "2026-07-07T12:35:00.000Z",
        }),
      ],
    });

    const firstRow = await screen.findByTestId(
      "run-console-row-run-1111111111",
    );
    const secondRow = await screen.findByTestId(
      "run-console-row-run-2222222222",
    );

    expect(firstRow.textContent).toContain("run-1111111111");
    expect(firstRow.textContent).toContain("Running");
    expect(firstRow.textContent).toContain("Worker Started");
    expect(firstRow.textContent).toContain("Input artifact available");
    expect(secondRow.textContent).toContain("run-2222222222");
    expect(secondRow.textContent).toContain("Completed");
    expect(secondRow.textContent).toContain("Report Completed");
    expect(secondRow.textContent).not.toContain(
      "Spec title not exposed by local API",
    );
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.getByTestId("selected-run-title").textContent).toBe(
      "run-1111111111",
    );
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(
      screen.queryByText(
        "Opened on demand; the FactoryGraph canvas remains the primary workspace.",
      ),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Close replay" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close replay" }));
    await waitFor(() => {
      expect(screen.queryByTestId("run-replay-scrubber")).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(screen.getByTestId("run-replay-current-event").textContent).toBe(
      "Event #2",
    );
    const replayScrubber = screen.getByTestId("run-replay-scrubber");
    expect(screen.getByTestId("run-replay-playback-toggle")).toHaveProperty(
      "ariaLabel",
      "Play replay from beginning",
    );
    expect(replayScrubber.textContent).not.toContain("ordered events");
    expect(replayScrubber.textContent).not.toContain("artifacts reached");
    fireEvent.click(screen.getByTestId("run-replay-playback-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("run-replay-current-event").textContent).toBe(
        "Event #1",
      );
    });
    fireEvent.click(screen.getByTestId("run-replay-playback-toggle"));
    expect(await screen.findAllByText("Issue orchestrator")).not.toHaveLength(0);
    expect(screen.queryByText("Refactor dashboard canvas")).toBeNull();
    const workerLabels = await screen.findAllByText("Worker");
    expect(workerLabels).not.toHaveLength(0);
    expect(screen.queryByText("Run root")).toBeNull();

    const workerNode = view.container.querySelector('[data-id="agent:agent-worker"]');
    if (workerNode === null) {
      throw new Error("Expected a worker FactoryGraph node.");
    }

    fireEvent.click(workerNode);

    await waitFor(() => {
      expect(screen.getAllByText("Worker produced code summary")).not.toHaveLength(0);
    });
    for (const artifactsTab of screen.getAllByRole("tab", {
      name: "Artifacts",
    })) {
      fireEvent.pointerDown(artifactsTab);
      fireEvent.mouseDown(artifactsTab);
      fireEvent.mouseUp(artifactsTab);
      fireEvent.click(artifactsTab);
    }
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: "Code summary" }),
      ).not.toHaveLength(0);
    });
    fireEvent.click(
      firstElement(screen.getAllByRole("button", { name: "Code summary" })),
    );

    await waitFor(() => {
      expect(
        screen.getAllByText("artifact-summary factory artifact body"),
      ).not.toHaveLength(0);
    });

    fireEvent.change(screen.getByTestId("run-replay-range"), {
      target: { value: "0" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("run-replay-current-event").textContent).toBe(
        "Event #1",
      );
      expect(
        firstElement(screen.getAllByTestId("event-strip-event-1")).textContent,
      ).toContain("Replay");
      expect(screen.getAllByText("Replay")).not.toHaveLength(0);
    });

    fireEvent.click(secondRow);

    await waitFor(() => {
      expect(screen.getByTestId("selected-run-title").textContent).toBe(
        "run-2222222222",
      );
      expect(screen.queryByTestId("run-replay-current-event")).toBeNull();
    });
  });

  it("keeps Run Console search and row copy public, compact, and filterable", async () => {
    const view = renderDashboardWithQueries({
      runs: [
        localRunSummary({
          artifacts: ["input"],
          eventCount: 1,
          latestEventType: "WORKER_STARTED",
          runId: parseRunId("run-search0001"),
          state: "runningWorker",
          status: "running",
        }),
        localRunSummary({
          artifacts: [],
          eventCount: 1,
          latestEventType: "RUN_FAILED",
          runId: parseRunId("run-search0002"),
          state: "failed",
          status: "failed",
        }),
      ],
    });

    const searchInput = await screen.findByLabelText("Search runs");
    const searchIcon = view.container.querySelector(
      '[data-testid="run-console-search-icon"]',
    );
    expect(searchIcon?.getAttribute("class")).toContain("size-4");
    expect(searchInput.getAttribute("class")).toContain("h-8");

    const firstRow = await screen.findByTestId(
      "run-console-row-run-search0001",
    );
    const secondRow = await screen.findByTestId(
      "run-console-row-run-search0002",
    );

    expect(firstRow.textContent).toContain("Input artifact available");
    expect(
      secondRow.textContent,
    ).not.toContain("Spec title not exposed by local API");
    expect(secondRow.textContent).toContain("Failed");
    expect(screen.queryByText("Terminal")).toBeNull();

    fireEvent.change(searchInput, {
      target: { value: "spec title not exposed" },
    });

    expect(await screen.findByTestId("run-console-filter-empty")).toBeTruthy();
    expect(screen.queryByTestId("run-console-row-run-search0001")).toBeNull();
    expect(screen.queryByTestId("run-console-row-run-search0002")).toBeNull();

    fireEvent.change(searchInput, { target: { value: "failed" } });

    await waitFor(() => {
      expect(screen.getByTestId("run-console-row-run-search0002")).toBeTruthy();
      expect(screen.queryByTestId("run-console-row-run-search0001")).toBeNull();
    });
  });

  it("keeps source details inside Agent Inspector instead of a top-level source mode", async () => {
    const runId = parseRunId("run-1212121212");
    const view = renderDashboardWithQueries({
      runs: [
        localRunSummary({
          eventCount: 4,
          latestEventType: "REPORT_COMPLETED",
          runId,
          state: "completed",
          status: "completed",
        }),
      ],
    });

    await screen.findByTestId("selected-run-title");

    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(screen.queryByTestId("source-detail-panel")).toBeNull();
    expect(await screen.findAllByText("Worker")).not.toHaveLength(0);

    const workerNode = view.container.querySelector('[data-id="agent:agent-worker"]');
    if (workerNode === null) {
      throw new Error("Expected a worker FactoryGraph node.");
    }
    fireEvent.click(workerNode);

    await waitFor(() => {
      expect(screen.getAllByText("Worker produced code summary")).not.toHaveLength(0);
    });

    for (const artifactsTab of screen.getAllByRole("tab", {
      name: "Artifacts",
    })) {
      fireEvent.pointerDown(artifactsTab);
      fireEvent.mouseDown(artifactsTab);
      fireEvent.mouseUp(artifactsTab);
      fireEvent.click(artifactsTab);
    }
    fireEvent.click(
      firstElement(screen.getAllByRole("button", { name: "Code summary" })),
    );
    await waitFor(() => {
      expect(
        firstElement(screen.getAllByTestId("evidence-artifact-content"))
          .textContent,
      ).toContain("artifact-summary factory artifact body");
    });
  });

  it("refreshes a selected active run to terminal state from the live stream", async () => {
    const eventSource = installMockEventSource();
    const runId = parseRunId("run-3333333333");
    const createdEvent = makeRunEvent({
      runId,
      sequence: 1,
      timestamp: "2026-07-07T12:00:00.000Z",
      type: "RUN_CREATED",
    });
    const terminalEvent = makeRunEvent({
      payload: { reportPath: "report.md" },
      runId,
      sequence: 2,
      timestamp: "2026-07-07T12:01:00.000Z",
      type: "REPORT_COMPLETED",
    });
    renderDashboardWithQueries({
      eventsByRunId: {
        [runId]: [createdEvent],
      },
      runs: [
        localRunSummary({
          artifacts: ["input", "report"],
          eventCount: 1,
          latestEventType: "RUN_CREATED",
          runId,
          state: "runningWorker",
          status: "running",
        }),
      ],
    });

    await waitFor(() => {
      expect(eventSource.instances).toHaveLength(1);
    });

    const source = firstElement(eventSource.instances);
    act(() => {
      source.onopen?.(new Event("open"));
    });

    expect(queryFixture.runsRequestCount).toBe(1);
    expect(screen.getByTestId("run-console-row-run-3333333333").textContent).toContain(
      "Running",
    );
    expect(screen.getByTestId("run-console-row-run-3333333333").textContent).toContain(
      "1 event",
    );

    act(() => {
      queryFixture.eventsByRunId[runId] = [createdEvent, terminalEvent];
      queryFixture.runs = [
        localRunSummary({
          artifacts: ["input", "report"],
          eventCount: 2,
          latestEventType: "REPORT_COMPLETED",
          runId,
          state: "completed",
          status: "completed",
          updatedAt: "2026-07-07T12:01:00.000Z",
        }),
      ];
      source.onmessage?.({
        data: JSON.stringify(terminalEvent),
      } as MessageEvent<string>);
    });

    await waitFor(() => {
      expect(screen.getByTestId("run-console-row-run-3333333333").textContent).toContain(
        "Completed",
      );
      expect(screen.getByTestId("run-console-row-run-3333333333").textContent).toContain(
        "Report Completed",
      );
      expect(screen.getByTestId("run-console-row-run-3333333333").textContent).toContain(
        "2 events",
      );
      expect(screen.getAllByText("Report Completed")).not.toHaveLength(0);
    });
    expect(queryFixture.runsRequestCount).toBe(2);
    expect(eventSource.instances).toHaveLength(1);
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe to the live stream for already terminal runs", async () => {
    const eventSource = installMockEventSource();
    const runId = parseRunId("run-3434343434");
    renderDashboardWithQueries({
      runs: [
        localRunSummary({
          eventCount: 2,
          latestEventType: "REPORT_COMPLETED",
          runId,
          state: "completed",
          status: "completed",
        }),
      ],
    });

    await screen.findByTestId("run-console-row-run-3434343434");

    expect(eventSource.instances).toHaveLength(0);
  });

  it("compares two runs while comparison selection keeps the primary canvas selected", async () => {
    const firstRunId = parseRunId("run-4444444444");
    const secondRunId = parseRunId("run-5555555555");
    const thirdRunId = parseRunId("run-6666666666");
    renderDashboardWithQueries({
      eventsByRunId: {
        [firstRunId]: [
          makeRunEvent({
            runId: firstRunId,
            sequence: 1,
            timestamp: "2026-07-07T12:00:00.000Z",
            type: "RUN_CREATED",
          }),
          makeRunEvent({
            payload: { workerResultPath: "worker-result.md" },
            runId: firstRunId,
            sequence: 2,
            timestamp: "2026-07-07T12:01:00.000Z",
            type: "WORKER_COMPLETED",
          }),
          makeRunEvent({
            payload: { phase: "evidence" },
            runId: firstRunId,
            sequence: 3,
            timestamp: "2026-07-07T12:02:00.000Z",
            type: "REVIEW_COMPLETED",
          }),
          makeRunEvent({
            runId: firstRunId,
            sequence: 4,
            timestamp: "2026-07-07T12:03:00.000Z",
            type: "VERIFICATION_COMPLETED",
          }),
          makeRunEvent({
            runId: firstRunId,
            sequence: 5,
            timestamp: "2026-07-07T12:05:00.000Z",
            type: "REPORT_COMPLETED",
          }),
        ],
        [secondRunId]: [
          makeRunEvent({
            runId: secondRunId,
            sequence: 1,
            timestamp: "2026-07-07T12:00:00.000Z",
            type: "RUN_CREATED",
          }),
          makeRunEvent({
            payload: { failure: { message: "Harness failed" } },
            runId: secondRunId,
            sequence: 2,
            timestamp: "2026-07-07T12:04:00.000Z",
            type: "RUN_FAILED",
          }),
        ],
        [thirdRunId]: [
          makeRunEvent({
            runId: thirdRunId,
            sequence: 1,
            timestamp: "2026-07-07T12:10:00.000Z",
            type: "RUN_CREATED",
          }),
        ],
      },
      runs: [
        localRunSummary({
          artifacts: [
            "input",
            "worker-result",
            "evidence-review",
            "verification-result",
            "report",
            "report-json",
          ],
          eventCount: 5,
          latestEventType: "REPORT_COMPLETED",
          runId: firstRunId,
          state: "completed",
          status: "completed",
          updatedAt: "2026-07-07T12:05:00.000Z",
        }),
        localRunSummary({
          artifacts: ["input", "worker-log"],
          eventCount: 2,
          latestEventType: "RUN_FAILED",
          runId: secondRunId,
          state: "failed",
          status: "failed",
          updatedAt: "2026-07-07T12:04:00.000Z",
        }),
        localRunSummary({
          artifacts: [],
          eventCount: 3,
          latestEventType: "RUN_CREATED",
          runId: thirdRunId,
          state: "created",
          status: "running",
          updatedAt: "2026-07-07T12:10:30.000Z",
        }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    await waitFor(() => {
      expect(screen.getByTestId("run-compare-panel").textContent).toContain(
        "key differences",
      );
    });

    const primarySelect = screen.getByTestId(
      "run-compare-primary-select",
    ) as HTMLSelectElement;
    const comparisonSelect = screen.getByTestId(
      "run-compare-comparison-select",
    ) as HTMLSelectElement;

    expect(primarySelect.value).toBe("run-4444444444");
    expect(comparisonSelect.value).toBe("run-5555555555");
    const statusMetric = await screen.findByTestId(
      "run-compare-metric-status",
    );
    expect(statusMetric.textContent).toContain("Completed");
    expect(statusMetric.textContent).toContain("Failed");
    expect(screen.getByTestId("run-compare-artifact-delta").textContent).toContain(
      "Primary only",
    );
    expect(screen.getByTestId("run-compare-missing-data").textContent).toContain(
      "Comparison: check outcome unavailable",
    );
    expect(screen.getByTestId("selected-run-title").textContent).toBe(
      "run-4444444444",
    );

    fireEvent.change(comparisonSelect, {
      target: { value: "run-6666666666" },
    });

    await waitFor(() => {
      expect(
        (
          screen.getByTestId(
            "run-compare-comparison-select",
          ) as HTMLSelectElement
        ).value,
      ).toBe("run-6666666666");
      expect(screen.getByTestId("selected-run-title").textContent).toBe(
        "run-4444444444",
      );
      expect(screen.getByTestId("run-compare-missing-data").textContent).toContain(
        "Comparison: 3 events reported, 1 loaded",
      );
      expect(screen.getByTestId("run-compare-missing-data").textContent).toContain(
        "Comparison: no artifacts exposed",
      );
      expect(screen.getByTestId("run-compare-missing-data").textContent).toContain(
        "Comparison: report outcome unavailable",
      );
      expect(screen.getByTestId("run-compare-missing-data").textContent).toContain(
        "Comparison: check outcome unavailable",
      );
      expect(screen.getByTestId("run-compare-missing-data").textContent).toContain(
        "Comparison: review outcome unavailable",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Close compare" }));

    await waitFor(() => {
      expect(screen.queryByTestId("run-compare-panel")).toBeNull();
      expect(screen.getByTestId("selected-run-title").textContent).toBe(
        "run-4444444444",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    const reopenedPrimarySelect = await screen.findByTestId(
      "run-compare-primary-select",
    );

    fireEvent.change(reopenedPrimarySelect, {
      target: { value: "run-5555555555" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("selected-run-title").textContent).toBe(
        "run-5555555555",
      );
      expect(screen.queryByTestId("run-compare-panel")).toBeNull();
    });
  });

  it("renders the online empty state from typed runs data", async () => {
    renderDashboardWithQueries({ runs: [] });

    const empty = await screen.findByTestId("run-console-empty");

    expect(empty.textContent).toContain("No local runs");
    expect(screen.getByTestId("run-console-server-status").textContent).toContain(
      "/gaia-api",
    );
    expect(screen.getByLabelText("Server status: /gaia-api online")).toBeTruthy();
    expect(screen.getByTestId("run-console-server-status").textContent).not.toContain(
      "online",
    );
    expect(screen.queryByTestId("run-console-server-message")).toBeNull();
    expect(screen.getByTestId("selected-run-title").textContent).toBe(
      "No local run selected",
    );
  });

  it("creates an issue-delivery run from the command rail and selects the refreshed run", async () => {
    renderDashboardWithQueries({ runs: [] });

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    fireEvent.change(await screen.findByLabelText("Issue title"), {
      target: { value: "  Ship dashboard intake  " },
    });
    fireEvent.change(screen.getByLabelText("Issue description"), {
      target: {
        value:
          "  Add a command-rail intake and select the created factory run.  ",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create run" }));

    await waitFor(() => {
      expect(queryFixture.createRunInputs).toEqual([
        {
          description:
            "Add a command-rail intake and select the created factory run.",
          title: "Ship dashboard intake",
        },
      ]);
      expect(
        screen.getByTestId("run-console-row-run-9999999999"),
      ).toBeTruthy();
      expect(screen.getByTestId("selected-run-title").textContent).toBe(
        "run-9999999999",
      );
    });
  });

  it("validates issue-delivery intake before creating a run", async () => {
    renderDashboardWithQueries({ runs: [] });

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    fireEvent.submit(await screen.findByTestId("issue-delivery-intake-form"));

    expect(queryFixture.createRunInputs).toEqual([]);
    expect(screen.getByText("Enter an issue title.")).toBeTruthy();
    expect(screen.getByText("Enter an issue description.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Create run" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("disables duplicate issue-delivery submissions while create-run is pending", async () => {
    const createRun = deferred<CreateRunAcceptedFixture>();
    renderDashboardWithQueries({
      createRunPromise: createRun.promise,
      runs: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    fireEvent.change(await screen.findByLabelText("Issue title"), {
      target: { value: "Pending intake" },
    });
    fireEvent.change(screen.getByLabelText("Issue description"), {
      target: { value: "Keep duplicate submissions disabled." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create run" }));

    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "Creating run",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });
    expect(queryFixture.createRunInputs).toHaveLength(1);

    createRun.resolve({
      acceptedAt: "2026-07-09T00:01:00.000Z",
      runId: "run-1010101010",
      status: "accepted",
      urls: {
        activity: "/runs/run-1010101010/activity",
        artifacts: "/runs/run-1010101010/artifacts",
        factoryGraph: "/runs/run-1010101010/factory-graph",
        run: "/runs/run-1010101010",
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("selected-run-title").textContent).toBe(
        "run-1010101010",
      );
      expect(screen.queryByTestId("issue-delivery-intake-form")).toBeNull();
    });
  });

  it("renders typed create-run failures without adding fake runs", async () => {
    renderDashboardWithQueries({
      createRunError: {
        _tag: "DashboardGaiaApiError",
        error: localRunApiError({
          code: "InvalidRequest",
          message: "Issue title is already in use.",
          status: 400,
        }),
      },
      runs: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    fireEvent.change(await screen.findByLabelText("Issue title"), {
      target: { value: "Duplicate issue" },
    });
    fireEvent.change(screen.getByLabelText("Issue description"), {
      target: { value: "This should surface the typed API failure." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create run" }));

    const error = await screen.findByTestId("issue-delivery-intake-error");
    expect(error.textContent).toContain(
      "InvalidRequest: Issue title is already in use.",
    );
    expect(screen.queryByTestId("run-console-row-run-9999999999")).toBeNull();
  });

  it("renders typed API errors as the offline error state", async () => {
    renderDashboardWithQueries({
      healthError: {
        _tag: "DashboardGaiaApiError",
        error: localRunApiError({
          code: "InternalServerError",
          message: "Local API failed.",
          status: 500,
        }),
      },
      runs: [],
    });

    const error = await screen.findByTestId("run-console-error");

    expect(error.textContent).toContain("Local server unavailable");
    expect(error.textContent).toContain(
      "InternalServerError: Local API failed.",
    );
    expect(screen.getByLabelText("Server status: /gaia-api offline")).toBeTruthy();
    expect(screen.getByTestId("run-console-server-status").textContent).not.toContain(
      "offline",
    );
    expect(screen.queryByTestId("run-console-server-message")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    expect(screen.getByTestId("issue-delivery-intake-offline").textContent).toContain(
      "Local server unavailable",
    );
    expect(
      (screen.getByRole("button", { name: "Create run" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("preserves visible runs and marks them stale after a refresh failure", async () => {
    const runId = parseRunId("run-7777777777");
    renderDashboardWithQueries({
      runs: [
        localRunSummary({
          eventCount: 3,
          latestEventType: "WORKER_STARTED",
          runId,
          state: "runningWorker",
          status: "running",
        }),
      ],
    });

    expect(
      await screen.findByTestId("run-console-row-run-7777777777"),
    ).toBeTruthy();

    queryFixture.healthError = {
      _tag: "DashboardGaiaHttpClientError",
      error: {},
    };
    fireEvent.click(screen.getByRole("button", { name: "Refresh local runs" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Server status: /gaia-api stale")).toBeTruthy();
      expect(screen.getByTestId("command-rail-footer").textContent).not.toContain(
        "stale",
      );
      expect(screen.getByTestId("run-console-stale-data").textContent).toContain(
        "Cached run data is being preserved",
      );
      expect(
        screen.getByTestId("run-console-row-run-7777777777").textContent,
      ).toContain("Worker Started");
      expect(screen.queryByTestId("run-console-error")).toBeNull();
    });
  });

  it("keeps partial run-list diagnostics out of the normal run list", async () => {
    const runId = parseRunId("run-8888888888");
    renderDashboardWithQueries({
      runs: [
        localRunSummary({
          eventCount: 12,
          latestEventType: "REPORT_COMPLETED",
          runId,
          state: "completed",
          status: "completed",
        }),
      ],
      runsDiagnostics: [
        localRunDiagnostic({
          code: "InvalidRunDirectory",
          message: "Run directory name is invalid.",
          pathSegment: "run-not-valid",
        }),
        localRunDiagnostic({
          code: "RunHasNoEvents",
          message: "Run has no events.jsonl entries.",
          runId: parseRunId("run-L84-kMhLY8"),
        }),
      ],
    });

    expect(
      await screen.findByTestId("run-console-row-run-8888888888"),
    ).toBeTruthy();
    expect(screen.queryByTestId("run-console-diagnostics")).toBeNull();
    expect(screen.queryByTestId("run-console-server-message")).toBeNull();
    expect(screen.getByTestId("command-rail-footer").textContent).not.toContain(
      "diagnostics",
    );
  });

  it("shows diagnostics even when no valid runs can be listed", async () => {
    renderDashboardWithQueries({
      runs: [],
      runsDiagnostics: [
        localRunDiagnostic({
          code: "InvalidRunDirectory",
          message: "Run directory name is invalid.",
          pathSegment: "run-not-valid",
        }),
      ],
    });

    const diagnostics = await screen.findByTestId("run-console-diagnostics");

    expect(diagnostics.textContent).toContain("InvalidRunDirectory");
    expect(diagnostics.textContent).toContain("run-not-valid");
    expect(screen.getByTestId("run-console-diagnostic-empty").textContent).toContain(
      "No valid local runs",
    );
    expect(screen.queryByTestId("run-console-empty")).toBeNull();
  });
});

function renderDashboardWithQueries(input: {
  readonly artifactsByRunId?: Record<
    string,
    Record<string, typeof LocalRunArtifactDto.Type>
  >;
  readonly eventsByRunId?: Record<string, ReadonlyArray<unknown>>;
  readonly factoryActivitiesByRunId?: Record<string, ReadonlyArray<typeof FactoryActivityDto.Type>>;
  readonly factoryActivityErrorsByRunId?: Record<
    string,
    DashboardGaiaClientError
  >;
  readonly factoryAgentActivitiesByRunId?: Record<
    string,
    Record<string, ReadonlyArray<typeof FactoryActivityDto.Type>>
  >;
  readonly factoryArtifactBodyErrorsByRunId?: Record<
    string,
    Record<string, DashboardGaiaClientError>
  >;
  readonly factoryArtifactBodiesByRunId?: Record<
    string,
    Record<string, typeof FactoryArtifactBodyDto.Type>
  >;
  readonly factoryArtifactErrorsByRunId?: Record<
    string,
    DashboardGaiaClientError
  >;
  readonly factoryArtifactsByRunId?: Record<string, ReadonlyArray<typeof FactoryArtifactDto.Type>>;
  readonly factoryGraphsByRunId?: Record<string, typeof FactoryGraphDto.Type>;
  readonly agentSessionsByRunId?: Record<
    string,
    Record<string, typeof AgentSessionSnapshotDto.Type>
  >;
  readonly createRunError?: DashboardGaiaClientError;
  readonly createRunPromise?: Promise<CreateRunAcceptedFixture>;
  readonly healthError?: DashboardGaiaClientError;
  readonly runs: ReadonlyArray<typeof LocalRunSummaryDto.Type>;
  readonly runsDiagnostics?: ReadonlyArray<
    typeof LocalRunReadDiagnosticDto.Type
  >;
  readonly runsError?: DashboardGaiaClientError;
}) {
  queryFixture.artifactsByRunId = input.artifactsByRunId ?? {};
  queryFixture.createRunError = input.createRunError;
  queryFixture.createRunInputs = [];
  queryFixture.createRunPromise = input.createRunPromise;
  queryFixture.factoryArtifactBodyRequests = [];
  queryFixture.factoryArtifactBodyErrorsByRunId =
    input.factoryArtifactBodyErrorsByRunId ?? {};
  const defaultFactoryData = defaultFactoryDataForRuns(input.runs);
  queryFixture.factoryActivitiesByRunId =
    input.factoryActivitiesByRunId ?? defaultFactoryData.activitiesByRunId;
  queryFixture.factoryActivityErrorsByRunId =
    input.factoryActivityErrorsByRunId ?? {};
  queryFixture.factoryAgentActivitiesByRunId =
    input.factoryAgentActivitiesByRunId ??
    defaultFactoryData.agentActivitiesByRunId;
  queryFixture.factoryArtifactBodiesByRunId =
    input.factoryArtifactBodiesByRunId ??
    defaultFactoryData.artifactBodiesByRunId;
  queryFixture.factoryArtifactsByRunId =
    input.factoryArtifactsByRunId ?? defaultFactoryData.artifactsByRunId;
  queryFixture.factoryArtifactErrorsByRunId =
    input.factoryArtifactErrorsByRunId ?? {};
  queryFixture.factoryGraphsByRunId =
    input.factoryGraphsByRunId ?? defaultFactoryData.graphsByRunId;
  queryFixture.agentSessionActionInputs = [];
  queryFixture.agentSessionsByRunId =
    input.agentSessionsByRunId ?? defaultFactoryData.agentSessionsByRunId;
  queryFixture.eventsByRunId = input.eventsByRunId ?? {};
  queryFixture.healthError = input.healthError;
  queryFixture.runs = input.runs;
  queryFixture.runsDiagnostics = input.runsDiagnostics ?? [];
  queryFixture.runsError = input.runsError;
  queryFixture.runsRequestCount = 0;

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <DashboardShell />
    </QueryClientProvider>,
  );
}

function localRunSummary(
  input: Partial<typeof LocalRunSummaryDto.Type> & {
    readonly runId: typeof LocalRunSummaryDto.Type.runId;
  },
): typeof LocalRunSummaryDto.Type {
  return {
    artifacts: ["input", "worker-plan"],
    createdAt: "2026-07-07T12:00:00.000Z",
    eventCount: 4,
    latestEventType: "RUN_CREATED",
    state: "created",
    status: "running",
    updatedAt: "2026-07-07T12:00:00.000Z",
    ...input,
  };
}

function localRunArtifact(
  input: Partial<typeof LocalRunArtifactDto.Type> & {
    readonly artifactName: typeof LocalRunArtifactDto.Type.artifactName;
    readonly runId: typeof LocalRunArtifactDto.Type.runId;
  },
): typeof LocalRunArtifactDto.Type {
  return {
    body: `${input.artifactName} artifact body`,
    contentType: "text/markdown",
    ...input,
  };
}

function localRunApiError(
  input: Partial<typeof LocalRunApiErrorEnvelope.Type>,
): typeof LocalRunApiErrorEnvelope.Type {
  return {
    code: "InternalServerError",
    message: "Local API failed.",
    recoverable: false,
    status: 500,
    ...input,
  };
}

function localRunDiagnostic(
  input: Partial<typeof LocalRunReadDiagnosticDto.Type>,
): typeof LocalRunReadDiagnosticDto.Type {
  return {
    code: "RunUnreadable",
    message: "Run could not be read.",
    recoverable: true,
    ...input,
  };
}

function parseRunId(value: string): typeof RunIdSchema.Type {
  return Schema.decodeUnknownSync(RunIdSchema)(value);
}

function defaultFactoryDataForRuns(
  runs: ReadonlyArray<typeof LocalRunSummaryDto.Type>,
) {
  const workerId = agentId("agent-worker");
  const workerArtifactId = artifactIdValue("artifact-summary");
  const activitiesByRunId: Record<string, ReadonlyArray<typeof FactoryActivityDto.Type>> =
    {};
  const agentActivitiesByRunId: Record<
    string,
    Record<string, ReadonlyArray<typeof FactoryActivityDto.Type>>
  > = {};
  const artifactBodiesByRunId: Record<
    string,
    Record<string, typeof FactoryArtifactBodyDto.Type>
  > = {};
  const artifactsByRunId: Record<string, ReadonlyArray<typeof FactoryArtifactDto.Type>> =
    {};
  const graphsByRunId: Record<string, typeof FactoryGraphDto.Type> = {};
  const agentSessionsByRunId: Record<
    string,
    Record<string, typeof AgentSessionSnapshotDto.Type>
  > = {};

  for (const run of runs) {
    activitiesByRunId[run.runId] = [
      factoryActivity({
        activityId: activityId("activity-root"),
        label: "FactoryGraph topology available",
        runId: run.runId,
        workItemId: workItemId("work-root"),
      }),
    ];
    agentActivitiesByRunId[run.runId] = {
      [workerId]: [
        factoryActivity({
          activityId: activityId("activity-worker"),
          agentId: workerId,
          artifactIds: [workerArtifactId],
          label: "Worker produced code summary",
          runId: run.runId,
        }),
      ],
    };
    artifactBodiesByRunId[run.runId] = {
      [workerArtifactId]: factoryArtifactBody({
        artifactId: workerArtifactId,
        body: "artifact-summary factory artifact body",
        runId: run.runId,
      }),
    };
    artifactsByRunId[run.runId] = [
      factoryArtifact({
        artifactId: workerArtifactId,
        label: "Code summary",
        ownerAgentId: workerId,
      }),
    ];
    graphsByRunId[run.runId] = factoryGraph({
      runId: run.runId,
      workerArtifactId,
      workerId,
    });
    agentSessionsByRunId[run.runId] = {
      [workerId]: agentSessionSnapshot({
        agentId: workerId,
        runId: run.runId,
      }),
    };
  }

  return {
    activitiesByRunId,
    agentActivitiesByRunId,
    agentSessionsByRunId,
    artifactBodiesByRunId,
    artifactsByRunId,
    graphsByRunId,
  };
}

function activityId(value: string): typeof FactoryActivityDto.Type.activityId {
  return Schema.decodeUnknownSync(FactoryActivityIdSchema)(value);
}

function agentId(value: string): typeof FactoryAgentIdSchema.Type {
  return Schema.decodeUnknownSync(FactoryAgentIdSchema)(value);
}

function artifactIdValue(value: string): typeof FactoryArtifactIdSchema.Type {
  return Schema.decodeUnknownSync(FactoryArtifactIdSchema)(value);
}

function workItemId(value: string): typeof FactoryWorkItemIdSchema.Type {
  return Schema.decodeUnknownSync(FactoryWorkItemIdSchema)(value);
}

function factoryActivity(
  input: Partial<typeof FactoryActivityDto.Type> & {
    readonly activityId: typeof FactoryActivityDto.Type.activityId;
    readonly label: string;
    readonly runId: typeof RunIdSchema.Type;
  },
): typeof FactoryActivityDto.Type {
  return {
    artifactIds: [],
    kind: "factory.activity",
    sequence: 1,
    state: "running",
    timestamp: "2026-07-08T12:00:00.000Z",
    ...input,
    activityId: input.activityId,
    label: input.label,
    runId: input.runId,
  };
}

function factoryArtifact(
  input: Partial<typeof FactoryArtifactDto.Type> & {
    readonly artifactId: typeof FactoryArtifactDto.Type.artifactId;
    readonly label: string;
    readonly ownerAgentId: typeof FactoryArtifactDto.Type.ownerAgentId;
  },
): typeof FactoryArtifactDto.Type {
  return {
    contentType: "text/markdown",
    createdAt: "2026-07-08T12:01:00.000Z",
    kind: "codeSummary",
    visibility: "run",
    ...input,
    artifactId: input.artifactId,
    label: input.label,
    ownerAgentId: input.ownerAgentId,
  };
}

function factoryArtifactBody(
  input: Partial<typeof FactoryArtifactBodyDto.Type> & {
    readonly artifactId: typeof FactoryArtifactBodyDto.Type.artifactId;
    readonly body: string;
    readonly runId: typeof RunIdSchema.Type;
  },
): typeof FactoryArtifactBodyDto.Type {
  return {
    contentType: "text/markdown",
    ...input,
    artifactId: input.artifactId,
    body: input.body,
    runId: input.runId,
  };
}

function agentSessionSnapshot(
  input: Partial<typeof AgentSessionSnapshotDto.Type> & {
    readonly agentId: typeof AgentSessionSnapshotDto.Type.agentId;
    readonly runId: typeof AgentSessionSnapshotDto.Type.runId;
  },
): typeof AgentSessionSnapshotDto.Type {
  const { agentId: inputAgentId, runId: inputRunId, ...overrides } = input;
  return {
    agentId: inputAgentId,
    capabilities: {
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
    },
    eventSequence: 6,
    items: [
      {
        itemId: parseHarnessItemId("item-message-1"),
        kind: "message",
        phase: "commentary",
        status: "completed",
        text: "I am working through the Agent Inspector.",
        turnId: parseHarnessTurnId("turn-1"),
      },
      {
        itemId: parseHarnessItemId("item-plan-1"),
        kind: "plan",
        status: "completed",
        steps: [
          { status: "completed", step: "Read the public session projection" },
          { status: "inProgress", step: "Wire Inspector controls" },
        ],
        turnId: parseHarnessTurnId("turn-1"),
      },
    ],
    pendingInteractions: [],
    recovered: false,
    resolvedInteractions: [],
    runId: inputRunId,
    sessionId: parseHarnessSessionId(`session-${inputRunId}`),
    state: "running",
    turns: [{ status: "running", turnId: parseHarnessTurnId("turn-1") }],
    ...overrides,
  };
}

function agentActionReceipt(
  input: Partial<typeof AgentActionReceiptDto.Type> & {
    readonly actionId: typeof AgentActionReceiptDto.Type.actionId;
    readonly agentId: typeof AgentActionReceiptDto.Type.agentId;
    readonly runId: typeof AgentActionReceiptDto.Type.runId;
  },
): typeof AgentActionReceiptDto.Type {
  const {
    actionId: inputActionId,
    agentId: inputAgentId,
    runId: inputRunId,
    ...overrides
  } = input;
  return {
    actionId: inputActionId,
    agentId: inputAgentId,
    eventSequence: 9,
    payloadDigest:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    runId: inputRunId,
    sessionId: parseHarnessSessionId(`session-${inputRunId}`),
    state: "dispatchConfirmed",
    ...overrides,
  };
}

function factoryGraph(input: {
  readonly agentStates?: {
    readonly ciWatcher?: FactoryAgentState;
    readonly orchestrator?: FactoryAgentState;
    readonly reviewer?: FactoryAgentState;
    readonly tester?: FactoryAgentState;
    readonly worker?: FactoryAgentState;
  };
  readonly agents?: ReadonlyArray<FactoryGraphAgent>;
  readonly edges?: ReadonlyArray<FactoryGraphEdge>;
  readonly linkedArtifacts?: ReadonlyArray<typeof FactoryArtifactDto.Type>;
  readonly runId: typeof RunIdSchema.Type;
  readonly workerArtifactCount?: number;
  readonly workerArtifactId: typeof FactoryArtifactDto.Type.artifactId;
  readonly workerId: typeof FactoryArtifactDto.Type.ownerAgentId;
}): typeof FactoryGraphDto.Type {
  const rootWorkItemId = workItemId("work-root");
  const orchestratorId = agentId("agent-orchestrator");
  const reviewerId = agentId("agent-reviewer");
  const testerId = agentId("agent-tester");
  const ciWatcherId = agentId("agent-ci-watcher");

  return {
    agents: input.agents ?? [
      {
        artifactCount: 0,
        id: orchestratorId,
        role: "orchestrator",
        state: input.agentStates?.orchestrator ?? "running",
        subState: "coordinating issue delivery",
        title: "Issue orchestrator",
        workItemId: rootWorkItemId,
      },
      {
        artifactCount: input.workerArtifactCount ?? 1,
        id: input.workerId,
        latestActivityId: activityId("activity-worker"),
        parentAgentId: orchestratorId,
        role: "worker",
        state: input.agentStates?.worker ?? "succeeded",
        subState: "code summary ready",
        title: "Worker",
        workItemId: rootWorkItemId,
      },
      {
        artifactCount: 0,
        id: reviewerId,
        parentAgentId: input.workerId,
        role: "reviewer",
        state: input.agentStates?.reviewer ?? "pending",
        subState: "waiting for worker evidence",
        title: "Reviewer",
        workItemId: rootWorkItemId,
      },
      {
        artifactCount: 0,
        id: testerId,
        parentAgentId: reviewerId,
        role: "tester",
        state: input.agentStates?.tester ?? "pending",
        subState: "browser verification queued",
        title: "Tester",
        workItemId: rootWorkItemId,
      },
      {
        artifactCount: 0,
        id: ciWatcherId,
        parentAgentId: testerId,
        role: "ciWatcher",
        state: input.agentStates?.ciWatcher ?? "unknown",
        subState: "CI evidence unavailable",
        title: "CI watcher",
        workItemId: rootWorkItemId,
      },
    ],
    execution: testFactoryExecution,
    diagnostics: [],
    edges: input.edges ?? [
      {
        id: "edge-owns",
        sourceId: "work-root",
        targetId: "agent-orchestrator",
        type: "owns",
      },
      {
        id: "edge-spawned",
        sourceId: "agent-orchestrator",
        targetId: "agent-worker",
        type: "spawned",
      },
      {
        id: "edge-reviewed",
        sourceId: "agent-worker",
        targetId: "agent-reviewer",
        type: "reviewed",
      },
      {
        id: "edge-tested",
        sourceId: "agent-reviewer",
        targetId: "agent-tester",
        type: "tested",
      },
      {
        id: "edge-watched",
        sourceId: "agent-tester",
        targetId: "agent-ci-watcher",
        type: "watched",
      },
      {
        id: "edge-produced",
        sourceId: "agent-worker",
        targetId: input.workerArtifactId,
        type: "produced",
      },
    ],
    linkedArtifacts: [
      ...(input.linkedArtifacts ?? [
        factoryArtifact({
          artifactId: input.workerArtifactId,
          label: "Code summary",
          ownerAgentId: input.workerId,
        }),
      ]),
    ],
    runId: input.runId,
    version: 1,
    workflow: "issueDelivery",
    workItems: [
      {
        description: "Replace legacy event-node canvas with FactoryGraph topology.",
        externalRefs: [],
        id: rootWorkItemId,
        kind: "issue",
        title: "Refactor dashboard canvas",
      },
    ],
  };
}

function factoryGraphEdge(
  id: string,
  sourceId: string,
  targetId: string,
  type: FactoryGraphEdge["type"],
): FactoryGraphEdge {
  return {
    id,
    sourceId,
    targetId,
    type,
  };
}

type MockEventSourceInstance = {
  addEventListener: (
    event: string,
    listener: (event: MessageEvent<string>) => void,
  ) => void;
  readonly close: ReturnType<typeof vi.fn>;
  dispatchEventSourceEvent: (event: string, message: MessageEvent<string>) => void;
  listenerCount: (event: string) => number;
  readonly url: string;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onopen: ((event: Event) => void) | null;
  removeEventListener: (
    event: string,
    listener: (event: MessageEvent<string>) => void,
  ) => void;
};

function installMockEventSource() {
  const instances: Array<MockEventSourceInstance> = [];

  class TestEventSource implements MockEventSourceInstance {
    readonly close = vi.fn();
    readonly #listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;

    constructor(readonly url: string) {
      instances.push(this);
    }

    addEventListener(
      event: string,
      listener: (message: MessageEvent<string>) => void,
    ) {
      const listeners = this.#listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.#listeners.set(event, listeners);
    }

    dispatchEventSourceEvent(event: string, message: MessageEvent<string>) {
      for (const listener of this.#listeners.get(event) ?? []) {
        listener(message);
      }
    }

    listenerCount(event: string) {
      return this.#listeners.get(event)?.size ?? 0;
    }

    removeEventListener(
      event: string,
      listener: (message: MessageEvent<string>) => void,
    ) {
      this.#listeners.get(event)?.delete(listener);
    }
  }

  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: TestEventSource as unknown as typeof EventSource,
    writable: true,
  });
  Object.defineProperty(window, "EventSource", {
    configurable: true,
    value: TestEventSource as unknown as typeof EventSource,
    writable: true,
  });

  return { instances };
}

function firstElement<T>(items: ReadonlyArray<T>): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("Expected at least one item.");
  }

  return item;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

function captureConsoleErrors() {
  const originalError = console.error;
  const messages: Array<string> = [];
  console.error = (...args: Array<unknown>) => {
    messages.push(args.map(String).join(" "));
  };

  return {
    messages,
    restore: () => {
      console.error = originalError;
    },
  };
}

function installBrowserApiPolyfills() {
  class TestResizeObserver implements ResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  }

  globalThis.ResizeObserver = TestResizeObserver;
  window.ResizeObserver = TestResizeObserver;
  if (!("getAnimations" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
  }
  window.matchMedia = (query) => ({
    addEventListener() {},
    addListener() {},
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener() {},
    removeListener() {},
  });
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  Object.defineProperty(window, "EventSource", {
    configurable: true,
    value: undefined,
    writable: true,
  });
}
