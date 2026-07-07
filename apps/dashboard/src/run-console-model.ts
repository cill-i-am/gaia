import type {
  LocalRunApiErrorEnvelope,
  LocalRunReadDiagnosticDto,
  LocalRunSummaryDto,
} from "@gaia/core";

import type { DashboardGaiaClientError } from "@/lib/local-gaia-client";

export type RunConsoleHealth = "checking" | "offline" | "online";

export type RunConsoleRun = {
  readonly artifactCount: number;
  readonly createdAt: string;
  readonly eventCount: number;
  readonly hasError: boolean;
  readonly id: string;
  readonly isTerminal: boolean;
  readonly latestEventLabel: string;
  readonly specHint: string;
  readonly stateLabel: string;
  readonly status: typeof LocalRunSummaryDto.Type.status;
  readonly statusLabel: string;
  readonly terminalLabel: "Active" | "Error" | "Terminal";
  readonly title: string;
  readonly updatedAt: string;
  readonly updatedAtLabel: string;
};

export type RunConsoleState = {
  readonly diagnostics: ReadonlyArray<typeof LocalRunReadDiagnosticDto.Type>;
  readonly health: RunConsoleHealth;
  readonly isEmpty: boolean;
  readonly isError: boolean;
  readonly isLoading: boolean;
  readonly message: string;
  readonly runs: ReadonlyArray<RunConsoleRun>;
  readonly serverUrl: string;
};

export function buildRunConsoleState(input: {
  readonly healthError: unknown;
  readonly healthPending: boolean;
  readonly healthStatus: string | undefined;
  readonly runs: ReadonlyArray<typeof LocalRunSummaryDto.Type>;
  readonly runsDiagnostics: ReadonlyArray<typeof LocalRunReadDiagnosticDto.Type>;
  readonly runsError: unknown;
  readonly runsPending: boolean;
  readonly serverUrl: string;
}): RunConsoleState {
  const runs = input.runs.map(toRunConsoleRun);
  const health = healthFromQuerySnapshot(input);
  const isLoading = input.healthPending || input.runsPending;
  const failure = dashboardQueryFailure(input.healthError ?? input.runsError);
  const isError = failure !== undefined || health === "offline";

  return {
    diagnostics: input.runsDiagnostics,
    health,
    isEmpty: !isLoading && !isError && runs.length === 0,
    isError,
    isLoading,
    message: connectionMessage({
      failure,
      healthStatus: input.healthStatus,
      runCount: runs.length,
    }),
    runs,
    serverUrl: input.serverUrl,
  };
}

export function reconcileSelectedRunId(
  selectedRunId: string | undefined,
  runs: ReadonlyArray<RunConsoleRun>,
) {
  if (selectedRunId !== undefined && runs.some((run) => run.id === selectedRunId)) {
    return selectedRunId;
  }

  return runs[0]?.id;
}

export function selectedRunFromConsoleState(
  selectedRunId: string | undefined,
  runs: ReadonlyArray<RunConsoleRun>,
) {
  return runs.find((run) => run.id === selectedRunId);
}

export function dashboardQueryFailure(
  error: unknown,
): DashboardGaiaClientError | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("failure" in error)
  ) {
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

function toRunConsoleRun(
  run: typeof LocalRunSummaryDto.Type,
): RunConsoleRun {
  const hasError = run.status === "failed" || run.latestEventType === "RUN_FAILED";

  return {
    artifactCount: run.artifacts.length,
    createdAt: run.createdAt,
    eventCount: run.eventCount,
    hasError,
    id: run.runId,
    isTerminal: run.status !== "running",
    latestEventLabel: eventTypeLabel(run.latestEventType),
    specHint: run.artifacts.includes("input")
      ? "Markdown input artifact available"
      : "Spec title not exposed by local API",
    stateLabel: stateLabel(run.state),
    status: run.status,
    statusLabel: statusLabel(run.status),
    terminalLabel: hasError
      ? "Error"
      : run.status === "running"
        ? "Active"
        : "Terminal",
    title: run.runId,
    updatedAt: run.updatedAt,
    updatedAtLabel: timeLabel(run.updatedAt),
  };
}

function healthFromQuerySnapshot(input: {
  readonly healthPending: boolean;
  readonly healthStatus: string | undefined;
  readonly runsPending: boolean;
}) {
  if (input.healthStatus === "ok") {
    return "online";
  }

  if (input.healthPending || input.runsPending) {
    return "checking";
  }

  return "offline";
}

function connectionMessage(input: {
  readonly failure: DashboardGaiaClientError | undefined;
  readonly healthStatus: string | undefined;
  readonly runCount: number;
}) {
  if (input.healthStatus === "ok") {
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
