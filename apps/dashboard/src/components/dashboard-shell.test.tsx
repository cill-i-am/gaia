// @vitest-environment jsdom

import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type {
  LocalRunApiErrorEnvelope,
  LocalRunSummaryDto,
} from "@gaia/core";
import { RunIdSchema, makeRunEvent } from "@gaia/core";
import {
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

const queryFixture = vi.hoisted((): {
  eventsByRunId: Record<string, ReadonlyArray<unknown>>;
  healthError?: unknown;
  runs: ReadonlyArray<unknown>;
} => ({
  eventsByRunId: {},
  healthError: undefined,
  runs: [],
}));

vi.mock("@/lib/local-gaia-query", () => ({
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
    queryFn: () =>
      Promise.resolve({
        data: {
          diagnostics: [],
          runs: queryFixture.runs,
        },
        status: "success",
      }),
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
    queryKey: [
      "local-gaia",
      "runs",
      "detail",
      config.runId,
      "events",
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
  it("renders typed runs data and updates selected run state on row click", async () => {
    const firstRunId = parseRunId("run-1111111111");
    const secondRunId = parseRunId("run-2222222222");
    renderDashboardWithQueries({
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
    expect(await screen.findAllByText("Run root")).not.toHaveLength(0);
    const workerLabels = await screen.findAllByText("Worker lane");
    expect(workerLabels).not.toHaveLength(0);
    expect(screen.getAllByText("Thread identities unavailable")).not.toHaveLength(
      0,
    );

    const workerLabel = workerLabels[0];
    if (workerLabel === undefined) {
      throw new Error("Expected a worker lane node.");
    }

    fireEvent.click(workerLabel);

    await waitFor(() => {
      expect(
        screen.getAllByText(
          "Worker activity is inferred from durable worker events and worker artifacts. No private thread identity is exposed.",
        ),
      ).not.toHaveLength(0);
    });

    fireEvent.click(secondRow);

    await waitFor(() => {
      expect(screen.getByTestId("selected-run-title").textContent).toBe(
        "run-2222222222",
      );
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
    expect(error.textContent).toContain("InternalServerError: Local API failed.");
    expect(screen.getByTestId("run-console-server-message").textContent).toBe(
      "InternalServerError: Local API failed.",
    );
  });
});

function renderDashboardWithQueries(input: {
  readonly eventsByRunId?: Record<string, ReadonlyArray<unknown>>;
  readonly healthError?: DashboardGaiaClientError;
  readonly runs: ReadonlyArray<typeof LocalRunSummaryDto.Type>;
}) {
  queryFixture.eventsByRunId = input.eventsByRunId ?? {};
  queryFixture.healthError = input.healthError;
  queryFixture.runs = input.runs;

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

function parseRunId(value: string): typeof RunIdSchema.Type {
  return Schema.decodeUnknownSync(RunIdSchema)(value);
}

function installBrowserApiPolyfills() {
  class TestResizeObserver implements ResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  }

  globalThis.ResizeObserver = TestResizeObserver;
  window.ResizeObserver = TestResizeObserver;
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
}
