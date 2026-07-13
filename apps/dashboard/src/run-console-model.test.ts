import type {
  LocalRunApiErrorEnvelope,
  LocalRunReadDiagnosticDto,
  LocalRunSummaryDto,
} from "@gaia/core";
import { parseLocalGaiaServerUrl, RunIdSchema } from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildRunConsoleState,
  reconcileSelectedRunId,
  selectedRunFromConsoleState,
} from "@/run-console-model";

const serverUrl = parseLocalGaiaServerUrl("/gaia-api");

describe("run console model", () => {
  it("builds selectable local API run rows and preserves selection", () => {
    const firstRun = localRunSummary({
      runId: parseRunId("run-1234567890"),
      status: "running",
      state: "runningWorker",
      latestEventType: "WORKER_STARTED",
      updatedAt: "2026-07-07T12:30:00.000Z",
    });
    const secondRun = localRunSummary({
      artifacts: [],
      runId: parseRunId("run-abcdefghij"),
      status: "completed",
      state: "completed",
      latestEventType: "REPORT_COMPLETED",
      updatedAt: "2026-07-07T12:35:00.000Z",
    });
    const state = buildRunConsoleState({
      healthError: undefined,
      healthPending: false,
      healthStatus: "ok",
      runs: [firstRun, secondRun],
      runsDiagnostics: [],
      runsError: undefined,
      runsPending: false,
      serverUrl,
    });

    expect(state.health).toBe("online");
    expect(state.runs).toHaveLength(2);
    expect(state.runs[0]).toMatchObject({
      id: "run-1234567890",
      latestEventLabel: "Worker Started",
      specHint: "Input artifact available",
      stateLabel: "Running Worker",
      statusLabel: "Running",
      title: "run-1234567890",
    });
    expect(state.runs[1]).toMatchObject({
      id: "run-abcdefghij",
      specHint: undefined,
      statusLabel: "Completed",
    });
    expect(reconcileSelectedRunId(undefined, state.runs)).toBe(
      "run-1234567890"
    );
    expect(
      reconcileSelectedRunId(parseRunId("run-abcdefghij"), state.runs)
    ).toBe("run-abcdefghij");
    expect(
      reconcileSelectedRunId(parseRunId("run-missing000"), state.runs)
    ).toBe("run-1234567890");
    expect(
      selectedRunFromConsoleState(parseRunId("run-abcdefghij"), state.runs)
        ?.status
    ).toBe("completed");
  });

  it("reports an online empty state when the typed API has no runs", () => {
    const state = buildRunConsoleState({
      healthError: undefined,
      healthPending: false,
      healthStatus: "ok",
      runs: [],
      runsDiagnostics: [],
      runsError: undefined,
      runsPending: false,
      serverUrl,
    });

    expect(state.health).toBe("online");
    expect(state.isEmpty).toBe(true);
    expect(state.isError).toBe(false);
    expect(state.message).toBe("0 runs loaded through LocalGaiaServerApi.");
    expect(
      reconcileSelectedRunId(parseRunId("run-1234567890"), state.runs)
    ).toBeUndefined();
  });

  it("labels failed runs by public status without terminality copy", () => {
    const state = buildRunConsoleState({
      healthError: undefined,
      healthPending: false,
      healthStatus: "ok",
      runs: [
        localRunSummary({
          artifacts: [],
          runId: parseRunId("run-failed0000"),
          status: "failed",
          state: "failed",
          latestEventType: "RUN_FAILED",
        }),
      ],
      runsDiagnostics: [],
      runsError: undefined,
      runsPending: false,
      serverUrl,
    });

    expect(state.runs[0]).toMatchObject({
      hasError: true,
      specHint: undefined,
      statusLabel: "Failed",
    });
  });

  it("keeps loading distinct from empty and offline states", () => {
    const state = buildRunConsoleState({
      healthError: undefined,
      healthPending: true,
      healthStatus: undefined,
      runs: [],
      runsDiagnostics: [],
      runsError: undefined,
      runsPending: true,
      serverUrl,
    });

    expect(state.health).toBe("checking");
    expect(state.isLoading).toBe(true);
    expect(state.isEmpty).toBe(false);
    expect(state.isError).toBe(false);
    expect(state.message).toBe("Checking local server.");
  });

  it("marks cached runs as reconnecting while a refresh is in flight", () => {
    const state = buildRunConsoleState({
      healthError: undefined,
      healthFetching: true,
      healthPending: false,
      healthStatus: "ok",
      runs: [
        localRunSummary({
          runId: parseRunId("run-1234567890"),
          status: "completed",
          state: "completed",
          latestEventType: "REPORT_COMPLETED",
        }),
      ],
      runsDiagnostics: [],
      runsError: undefined,
      runsFetching: true,
      runsPending: false,
      serverUrl,
    });

    expect(state.health).toBe("reconnecting");
    expect(state.hasStaleData).toBe(false);
    expect(state.isError).toBe(false);
    expect(state.message).toBe(
      "Refreshing local server; showing 1 cached run."
    );
  });

  it("preserves cached runs while clearly marking stale refresh failures", () => {
    const state = buildRunConsoleState({
      healthError: {
        failure: {
          _tag: "DashboardGaiaHttpClientError",
          error: {},
        },
      },
      healthPending: false,
      healthStatus: "ok",
      runs: [
        localRunSummary({
          runId: parseRunId("run-1234567890"),
          status: "running",
          state: "runningWorker",
          latestEventType: "WORKER_STARTED",
        }),
      ],
      runsDiagnostics: [],
      runsError: undefined,
      runsPending: false,
      serverUrl,
    });

    expect(state.health).toBe("stale");
    expect(state.hasStaleData).toBe(true);
    expect(state.isError).toBe(false);
    expect(state.runs).toHaveLength(1);
    expect(state.message).toBe(
      "Showing 1 cached run; latest refresh failed: server is not reachable."
    );
  });

  it("reports partial run diagnostics without hiding valid runs", () => {
    const state = buildRunConsoleState({
      healthError: undefined,
      healthPending: false,
      healthStatus: "ok",
      runs: [
        localRunSummary({
          runId: parseRunId("run-1234567890"),
          status: "completed",
          state: "completed",
          latestEventType: "REPORT_COMPLETED",
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
      runsError: undefined,
      runsPending: false,
      serverUrl,
    });

    expect(state.health).toBe("online");
    expect(state.isError).toBe(false);
    expect(state.diagnostics).toHaveLength(2);
    expect(state.message).toBe("1 run loaded with 2 diagnostics.");
  });

  it("keeps malformed-only partial diagnostics out of the empty state", () => {
    const state = buildRunConsoleState({
      healthError: undefined,
      healthPending: false,
      healthStatus: "ok",
      runs: [],
      runsDiagnostics: [
        localRunDiagnostic({
          code: "InvalidRunDirectory",
          message: "Run directory name is invalid.",
          pathSegment: "run-not-valid",
        }),
      ],
      runsError: undefined,
      runsPending: false,
      serverUrl,
    });

    expect(state.health).toBe("online");
    expect(state.isEmpty).toBe(false);
    expect(state.diagnostics).toHaveLength(1);
    expect(state.message).toBe("0 runs loaded with 1 diagnostic.");
  });

  it("surfaces typed local API errors as error-state copy", () => {
    const state = buildRunConsoleState({
      healthError: undefined,
      healthPending: false,
      healthStatus: undefined,
      runs: [],
      runsDiagnostics: [],
      runsError: {
        failure: {
          _tag: "DashboardGaiaApiError",
          error: localRunApiError({
            code: "RunStoreLocked",
            message: "Run store is locked.",
            status: 409,
          }),
        },
      },
      runsPending: false,
      serverUrl,
    });

    expect(state.health).toBe("offline");
    expect(state.isError).toBe(true);
    expect(state.message).toBe("RunStoreLocked: Run store is locked.");
  });
});

function localRunSummary(
  input: Partial<typeof LocalRunSummaryDto.Type> & {
    readonly runId: typeof LocalRunSummaryDto.Type.runId;
  }
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
  input: Partial<typeof LocalRunApiErrorEnvelope.Type>
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
  input: Partial<typeof LocalRunReadDiagnosticDto.Type>
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
