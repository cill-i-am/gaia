import type {
  LocalRunApiErrorEnvelope,
  LocalRunSummaryDto,
} from "@gaia/core";
import { RunIdSchema } from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildRunConsoleState,
  reconcileSelectedRunId,
  selectedRunFromConsoleState,
} from "@/run-console-model";

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
      serverUrl: "/gaia-api",
    });

    expect(state.health).toBe("online");
    expect(state.runs).toHaveLength(2);
    expect(state.runs[0]).toMatchObject({
      id: "run-1234567890",
      latestEventLabel: "Worker Started",
      specHint: "Markdown input artifact available",
      stateLabel: "Running Worker",
      statusLabel: "Running",
      terminalLabel: "Active",
      title: "run-1234567890",
    });
    expect(state.runs[1]).toMatchObject({
      id: "run-abcdefghij",
      terminalLabel: "Terminal",
    });
    expect(reconcileSelectedRunId(undefined, state.runs)).toBe(
      "run-1234567890",
    );
    expect(reconcileSelectedRunId("run-abcdefghij", state.runs)).toBe(
      "run-abcdefghij",
    );
    expect(reconcileSelectedRunId("run-missing000", state.runs)).toBe(
      "run-1234567890",
    );
    expect(
      selectedRunFromConsoleState("run-abcdefghij", state.runs)?.status,
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
      serverUrl: "/gaia-api",
    });

    expect(state.health).toBe("online");
    expect(state.isEmpty).toBe(true);
    expect(state.isError).toBe(false);
    expect(state.message).toBe("0 runs loaded through LocalGaiaServerApi.");
    expect(reconcileSelectedRunId("run-1234567890", state.runs)).toBeUndefined();
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
      serverUrl: "/gaia-api",
    });

    expect(state.health).toBe("offline");
    expect(state.isError).toBe(true);
    expect(state.message).toBe("RunStoreLocked: Run store is locked.");
  });
});

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
