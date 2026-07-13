import type {
  LocalRunApiErrorEnvelope,
  LocalRunReadDiagnosticDto,
  LocalRunSummaryDto,
  LocalGaiaServerUrl,
  RunId,
} from "@gaia/core";

import type { DashboardGaiaClientError } from "@/lib/local-gaia-client";

export type RunConsoleHealth =
  | "checking"
  | "offline"
  | "online"
  | "reconnecting"
  | "stale";

export type RunConsoleRun = {
  readonly artifactCount: number;
  readonly createdAt: string;
  readonly eventCount: number;
  readonly hasError: boolean;
  readonly id: RunId;
  readonly isTerminal: boolean;
  readonly latestEventLabel: string;
  readonly specHint: string | undefined;
  readonly stateLabel: string;
  readonly status: typeof LocalRunSummaryDto.Type.status;
  readonly statusLabel: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly updatedAtLabel: string;
};

export type RunConsoleState = {
  readonly diagnostics: ReadonlyArray<typeof LocalRunReadDiagnosticDto.Type>;
  readonly hasStaleData: boolean;
  readonly health: RunConsoleHealth;
  readonly isEmpty: boolean;
  readonly isError: boolean;
  readonly isLoading: boolean;
  readonly message: string;
  readonly runs: ReadonlyArray<RunConsoleRun>;
  readonly serverUrl: LocalGaiaServerUrl;
};

export function buildRunConsoleState(input: {
  readonly healthError: unknown;
  readonly healthFetching?: boolean;
  readonly healthPending: boolean;
  readonly healthStatus: string | undefined;
  readonly runs: ReadonlyArray<typeof LocalRunSummaryDto.Type>;
  readonly runsDiagnostics: ReadonlyArray<
    typeof LocalRunReadDiagnosticDto.Type
  >;
  readonly runsError: unknown;
  readonly runsFetching?: boolean;
  readonly runsPending: boolean;
  readonly serverUrl: LocalGaiaServerUrl;
}): RunConsoleState {
  const runs = input.runs.map(toRunConsoleRun);
  const failure = dashboardQueryFailure(input.healthError ?? input.runsError);
  const hasStaleData = runs.length > 0 && failure !== undefined;
  const health = healthFromQuerySnapshot({
    failure,
    hasRuns: runs.length > 0,
    healthFetching: input.healthFetching ?? false,
    healthPending: input.healthPending,
    healthStatus: input.healthStatus,
    runsFetching: input.runsFetching ?? false,
    runsPending: input.runsPending,
  });
  const isLoading = input.healthPending || input.runsPending;
  const isError =
    !hasStaleData && (failure !== undefined || health === "offline");

  return {
    diagnostics: input.runsDiagnostics,
    hasStaleData,
    health,
    isEmpty:
      !isLoading &&
      !isError &&
      runs.length === 0 &&
      input.runsDiagnostics.length === 0,
    isError,
    isLoading,
    message: connectionMessage({
      failure,
      hasStaleData,
      healthStatus: input.healthStatus,
      isFetching:
        (input.healthFetching ?? false) || (input.runsFetching ?? false),
      partialDiagnosticCount: input.runsDiagnostics.length,
      runCount: runs.length,
    }),
    runs,
    serverUrl: input.serverUrl,
  };
}

export function reconcileSelectedRunId(
  selectedRunId: RunId | undefined,
  runs: ReadonlyArray<RunConsoleRun>
) {
  if (
    selectedRunId !== undefined &&
    runs.some((run) => run.id === selectedRunId)
  ) {
    return selectedRunId;
  }

  return runs[0]?.id;
}

export function selectedRunFromConsoleState(
  selectedRunId: RunId | undefined,
  runs: ReadonlyArray<RunConsoleRun>
) {
  return runs.find((run) => run.id === selectedRunId);
}

export function dashboardQueryFailure(
  error: unknown
): DashboardGaiaClientError | undefined {
  if (typeof error !== "object" || error === null || !("failure" in error)) {
    return undefined;
  }

  const failure = error.failure;
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    failure._tag.startsWith("DashboardGaia")
  ) {
    return failure as DashboardGaiaClientError;
  }

  return undefined;
}

function toRunConsoleRun(run: typeof LocalRunSummaryDto.Type): RunConsoleRun {
  const hasError =
    run.status === "failed" || run.latestEventType === "RUN_FAILED";

  return {
    artifactCount: run.artifacts.length,
    createdAt: run.createdAt,
    eventCount: run.eventCount,
    hasError,
    id: run.runId,
    isTerminal: run.status !== "running",
    latestEventLabel: eventTypeLabel(run.latestEventType),
    specHint: run.artifacts.includes("input")
      ? "Input artifact available"
      : undefined,
    stateLabel: stateLabel(run.state),
    status: run.status,
    statusLabel: statusLabel(run.status),
    title: run.runId,
    updatedAt: run.updatedAt,
    updatedAtLabel: timeLabel(run.updatedAt),
  };
}

function healthFromQuerySnapshot(input: {
  readonly failure: DashboardGaiaClientError | undefined;
  readonly hasRuns: boolean;
  readonly healthFetching: boolean;
  readonly healthPending: boolean;
  readonly healthStatus: string | undefined;
  readonly runsFetching: boolean;
  readonly runsPending: boolean;
}) {
  if (input.failure !== undefined && input.hasRuns) {
    return "stale";
  }

  if (input.healthStatus === "ok") {
    if (input.healthFetching || input.runsFetching) {
      return "reconnecting";
    }

    return "online";
  }

  if (input.healthPending || input.runsPending) {
    return "checking";
  }

  return "offline";
}

function connectionMessage(input: {
  readonly failure: DashboardGaiaClientError | undefined;
  readonly hasStaleData: boolean;
  readonly healthStatus: string | undefined;
  readonly isFetching: boolean;
  readonly partialDiagnosticCount: number;
  readonly runCount: number;
}) {
  if (input.hasStaleData && input.failure !== undefined) {
    return `Showing ${runCountLabel(input.runCount, "cached")}; latest refresh failed: ${failureSummary(input.failure)}`;
  }

  if (input.healthStatus === "ok") {
    if (input.isFetching && input.runCount > 0) {
      return `Refreshing local server; showing ${runCountLabel(input.runCount, "cached")}.`;
    }

    if (input.partialDiagnosticCount > 0) {
      return `${runCountLabel(input.runCount)} loaded with ${diagnosticCountLabel(input.partialDiagnosticCount)}.`;
    }

    return `${input.runCount} runs loaded through LocalGaiaServerApi.`;
  }

  if (input.failure?._tag === "DashboardGaiaApiError") {
    return apiErrorMessage(input.failure.error);
  }

  if (input.failure?._tag === "DashboardGaiaHttpClientError") {
    return "Local server is not reachable.";
  }

  if (input.failure?._tag === "DashboardGaiaTimeoutError") {
    return "Local server request timed out.";
  }

  return "Checking local server.";
}

function runCountLabel(count: number, modifier?: string) {
  const noun = count === 1 ? "run" : "runs";
  return modifier === undefined
    ? `${count} ${noun}`
    : `${count} ${modifier} ${noun}`;
}

function diagnosticCountLabel(count: number) {
  return count === 1 ? "1 diagnostic" : `${count} diagnostics`;
}

function failureSummary(failure: DashboardGaiaClientError) {
  if (failure._tag === "DashboardGaiaApiError") {
    return apiErrorMessage(failure.error);
  }

  if (failure._tag === "DashboardGaiaTimeoutError") {
    return "request timed out.";
  }

  if (failure._tag === "DashboardGaiaHttpClientError") {
    return "server is not reachable.";
  }

  if (failure._tag === "DashboardGaiaParameterError") {
    return `invalid ${failure.parameter} parameter.`;
  }

  return "unexpected dashboard client error.";
}

function apiErrorMessage(error: typeof LocalRunApiErrorEnvelope.Type) {
  return `${error.code}: ${error.message}`;
}

function eventTypeLabel(eventType: string) {
  return eventType
    .toLowerCase()
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function stateLabel(state: string) {
  return state
    .replace(/[A-Z]/gu, (match) => ` ${match}`)
    .replace(/^./u, (match) => match.toUpperCase());
}

function statusLabel(status: string) {
  return `${status[0]?.toUpperCase() ?? ""}${status.slice(1)}`;
}

function timeLabel(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
