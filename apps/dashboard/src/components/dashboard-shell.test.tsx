// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  FactoryActivityDto,
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
} from "@gaia/core";
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

import { DashboardShell } from "@/components/dashboard-shell";
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
    createRunError: undefined,
    createRunInputs: [],
    createRunPromise: undefined,
    eventsByRunId: {},
    healthError: undefined,
    runs: [],
    runsDiagnostics: [],
    runsError: undefined,
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

    expect(await screen.findAllByText("Refactor dashboard canvas")).not.toHaveLength(0);
    expect(await screen.findAllByText("Issue orchestrator")).not.toHaveLength(0);
    expect(await screen.findAllByText("Worker")).not.toHaveLength(0);
    expect(await screen.findAllByText("Reviewer")).not.toHaveLength(0);
    expect(await screen.findAllByText("Tester")).not.toHaveLength(0);
    expect(await screen.findAllByText("CI watcher")).not.toHaveLength(0);
    expect(screen.queryByText("Run root")).toBeNull();
    expect(screen.queryByText("Worker lane")).toBeNull();
    expect(screen.queryByTestId("event-strip-event-1")).toBeNull();
    expect(screen.queryByTestId("run-replay-scrubber")).toBeNull();
    expect(screen.queryByTestId("run-compare-panel")).toBeNull();
    expect(screen.queryByTestId("source-detail-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Provenance" })).toBeNull();
    expect(screen.getAllByText("No node selected")).not.toHaveLength(0);
    expect(screen.getByTestId("command-rail-footer").textContent).toContain(
      "/gaia-api",
    );

    const workerNode = view.container.querySelector('[data-id="agent:agent-worker"]');
    if (workerNode === null) {
      throw new Error("Expected a worker FactoryGraph node.");
    }
    fireEvent.click(workerNode);

    await waitFor(() => {
      expect(screen.getAllByText("Worker produced code summary")).not.toHaveLength(0);
      expect(screen.getAllByText("Code summary")).not.toHaveLength(0);
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
    expect(secondRow.textContent).toContain("run-2222222222");
    expect(secondRow.textContent).toContain("Completed");
    expect(secondRow.textContent).toContain("Report Completed");
    expect(screen.getByTestId("selected-run-title").textContent).toBe(
      "run-1111111111",
    );
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(screen.getByTestId("run-replay-current-event").textContent).toBe(
      "#2 · 2026-07-07T12:01:00.000Z",
    );
    expect(await screen.findAllByText("Refactor dashboard canvas")).not.toHaveLength(0);
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
        "#1 · 2026-07-07T12:00:00.000Z",
      );
      expect(
        firstElement(screen.getAllByTestId("event-strip-event-1")).textContent,
      ).toContain("Replay point");
      expect(screen.getAllByText("Replay point")).not.toHaveLength(0);
    });

    fireEvent.click(secondRow);

    await waitFor(() => {
      expect(screen.getByTestId("selected-run-title").textContent).toBe(
        "run-2222222222",
      );
      expect(screen.queryByTestId("run-replay-current-event")).toBeNull();
    });
  });

  it("opens source detail on demand without replacing the selected-node inspector", async () => {
    const runId = parseRunId("run-1212121212");
    const view = renderDashboardWithQueries({
      eventsByRunId: {
        [runId]: [
          makeRunEvent({
            payload: { specPath: "input.md" },
            runId,
            sequence: 1,
            timestamp: "2026-07-07T12:00:00.000Z",
            type: "RUN_CREATED",
          }),
          makeRunEvent({
            payload: { workerResultPath: "worker-result.md" },
            runId,
            sequence: 2,
            timestamp: "2026-07-07T12:01:00.000Z",
            type: "WORKER_COMPLETED",
          }),
          makeRunEvent({
            runId,
            sequence: 3,
            timestamp: "2026-07-07T12:02:00.000Z",
            type: "VERIFICATION_COMPLETED",
          }),
          makeRunEvent({
            payload: { reportPath: "report.md" },
            runId,
            sequence: 4,
            timestamp: "2026-07-07T12:03:00.000Z",
            type: "REPORT_COMPLETED",
          }),
        ],
      },
      runs: [
        localRunSummary({
          artifacts: [
            "input",
            "worker-plan",
            "worker-result",
            "verification-result",
            "report",
            "report-json",
          ],
          eventCount: 4,
          latestEventType: "REPORT_COMPLETED",
          runId,
          state: "completed",
          status: "completed",
        }),
      ],
    });

    await screen.findByTestId("selected-run-title");
    expect(screen.queryByTestId("source-detail-panel")).toBeNull();

    fireEvent.click(screen.getByTestId("source-detail-toggle"));

    expect(await screen.findByTestId("source-detail-panel")).toBeTruthy();
    expect(screen.queryByTestId("run-canvas-provenance-callout")).toBeNull();
    expect(await screen.findAllByText("Worker")).not.toHaveLength(0);

    const workerNode = view.container.querySelector('[data-id="agent:agent-worker"]');
    if (workerNode === null) {
      throw new Error("Expected a worker FactoryGraph node.");
    }
    fireEvent.click(workerNode);

    const sourcePanel = await screen.findByTestId("source-detail-panel");
    expect(sourcePanel.textContent).toContain(
      "GET /runs/run-1212121212/factory-graph",
    );
    expect(
      screen.getByTestId("source-detail-selected-node").textContent,
    ).toContain("agent:agent-worker");
    expect(
      screen.getByTestId("source-detail-activity").textContent,
    ).toContain("/agents/agent-worker/activity");

    fireEvent.click(screen.getByRole("button", { name: "Close command mode" }));

    await waitFor(() => {
      expect(screen.queryByTestId("source-detail-panel")).toBeNull();
      expect(screen.getAllByText("Worker produced code summary")).not.toHaveLength(0);
    });

    expect(
      screen.queryByTestId("evidence-provenance-panel"),
    ).toBeNull();
    expect(screen.getAllByText("Worker produced code summary")).not.toHaveLength(0);

    fireEvent.click(screen.getByTestId("source-detail-toggle"));
    expect(
      await screen.findByTestId("source-detail-panel"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close command mode" }));

    await waitFor(() =>
      expect(screen.queryByTestId("source-detail-panel")).toBeNull(),
    );

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

  it("closes the live event stream after a terminal Gaia event", async () => {
    const eventSource = installMockEventSource();
    const runId = parseRunId("run-3333333333");
    renderDashboardWithQueries({
      eventsByRunId: {
        [runId]: [
          makeRunEvent({
            runId,
            sequence: 1,
            timestamp: "2026-07-07T12:00:00.000Z",
            type: "RUN_CREATED",
          }),
        ],
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

    expect(eventSource.instances).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));

    await waitFor(() => {
      expect(eventSource.instances).toHaveLength(1);
    });

    const source = firstElement(eventSource.instances);
    act(() => {
      source.onopen?.(new Event("open"));
      source.onmessage?.({
        data: JSON.stringify(
          makeRunEvent({
            payload: { reportPath: "report.md" },
            runId,
            sequence: 2,
            timestamp: "2026-07-07T12:01:00.000Z",
            type: "REPORT_COMPLETED",
          }),
        ),
      } as MessageEvent<string>);
    });

    await waitFor(() => {
      expect(source.close).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText("Report Completed")).not.toHaveLength(0);
      expect(screen.getAllByText("Closed")).not.toHaveLength(0);
    });
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

    fireEvent.click(screen.getByRole("button", { name: "Close command mode" }));

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
    expect(screen.getByTestId("run-console-server-message").textContent).toBe(
      "0 runs loaded through LocalGaiaServerApi.",
    );
    expect(screen.getByTestId("selected-run-title").textContent).toBe(
      "No local run selected",
    );
  });

  it("creates an issue-delivery run from the command rail and selects the refreshed run", async () => {
    renderDashboardWithQueries({ runs: [] });

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
      expect(
        (
          screen.getByRole("button", {
            name: "Create run",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
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
    expect(screen.getByTestId("run-console-server-message").textContent).toBe(
      "InternalServerError: Local API failed.",
    );
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
      expect(screen.getByTestId("command-rail-footer").textContent).toContain(
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

  it("surfaces partial run-list diagnostics beside valid runs", async () => {
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

    const diagnostics = await screen.findByTestId("run-console-diagnostics");

    expect(diagnostics.textContent).toContain("Run index diagnostics");
    expect(diagnostics.textContent).toContain("InvalidRunDirectory");
    expect(diagnostics.textContent).toContain("run-not-valid");
    expect(diagnostics.textContent).toContain("RunHasNoEvents");
    expect(diagnostics.textContent).toContain("run-L84-kMhLY8");
    expect(screen.getByTestId("run-console-server-message").textContent).toBe(
      "1 run loaded with 2 diagnostics.",
    );
    expect(screen.getByTestId("run-console-row-run-8888888888")).toBeTruthy();
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
  queryFixture.eventsByRunId = input.eventsByRunId ?? {};
  queryFixture.healthError = input.healthError;
  queryFixture.runs = input.runs;
  queryFixture.runsDiagnostics = input.runsDiagnostics ?? [];
  queryFixture.runsError = input.runsError;

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
  }

  return {
    activitiesByRunId,
    agentActivitiesByRunId,
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

function factoryGraph(input: {
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
    agents: [
      {
        artifactCount: 0,
        id: orchestratorId,
        role: "orchestrator",
        state: "running",
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
        state: "succeeded",
        subState: "code summary ready",
        title: "Worker",
        workItemId: rootWorkItemId,
      },
      {
        artifactCount: 0,
        id: reviewerId,
        parentAgentId: input.workerId,
        role: "reviewer",
        state: "pending",
        subState: "waiting for worker evidence",
        title: "Reviewer",
        workItemId: rootWorkItemId,
      },
      {
        artifactCount: 0,
        id: testerId,
        parentAgentId: reviewerId,
        role: "tester",
        state: "pending",
        subState: "browser verification queued",
        title: "Tester",
        workItemId: rootWorkItemId,
      },
      {
        artifactCount: 0,
        id: ciWatcherId,
        parentAgentId: testerId,
        role: "ciWatcher",
        state: "unknown",
        subState: "CI evidence unavailable",
        title: "CI watcher",
        workItemId: rootWorkItemId,
      },
    ],
    diagnostics: [],
    edges: [
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

type MockEventSourceInstance = {
  readonly close: ReturnType<typeof vi.fn>;
  readonly url: string;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onopen: ((event: Event) => void) | null;
};

function installMockEventSource() {
  const instances: Array<MockEventSourceInstance> = [];

  class TestEventSource implements MockEventSourceInstance {
    readonly close = vi.fn();
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;

    constructor(readonly url: string) {
      instances.push(this);
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
