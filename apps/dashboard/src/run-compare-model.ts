import type { LocalRunSummaryDto, RunEvent, RunId } from "@gaia/core";

export type RunCompareSignal = {
  readonly label: string;
  readonly state: "available" | "failed" | "missing";
};

export type RunCompareSide = {
  readonly artifactCountLabel: string;
  readonly artifactNames: ReadonlyArray<string>;
  readonly checkSignal: RunCompareSignal;
  readonly createdAtLabel: string;
  readonly durationLabel: string;
  readonly eventCountLabel: string;
  readonly lifecycleLabel: string;
  readonly missingData: ReadonlyArray<string>;
  readonly reportSignal: RunCompareSignal;
  readonly reviewSignal: RunCompareSignal;
  readonly runId: RunId;
  readonly statusLabel: string;
  readonly updatedAtLabel: string;
};

export type RunCompareMetric = {
  readonly comparisonValue: string;
  readonly isDifferent: boolean;
  readonly label: string;
  readonly primaryValue: string;
};

export type RunCompareModel = {
  readonly artifactDelta: {
    readonly comparisonOnly: ReadonlyArray<string>;
    readonly primaryOnly: ReadonlyArray<string>;
    readonly shared: ReadonlyArray<string>;
  };
  readonly comparison: RunCompareSide | undefined;
  readonly differenceCount: number;
  readonly metrics: ReadonlyArray<RunCompareMetric>;
  readonly missingData: ReadonlyArray<string>;
  readonly primary: RunCompareSide | undefined;
  readonly summary: string;
};

type LocalRunSummary = typeof LocalRunSummaryDto.Type;

export function buildRunCompareModel(input: {
  readonly comparisonEvents: ReadonlyArray<RunEvent>;
  readonly comparisonRun: LocalRunSummary | undefined;
  readonly primaryEvents: ReadonlyArray<RunEvent>;
  readonly primaryRun: LocalRunSummary | undefined;
}): RunCompareModel {
  const primary = toCompareSide(input.primaryRun, input.primaryEvents);
  const comparison = toCompareSide(
    input.comparisonRun,
    input.comparisonEvents,
  );

  if (primary === undefined || comparison === undefined) {
    return {
      artifactDelta: {
        comparisonOnly: [],
        primaryOnly: [],
        shared: [],
      },
      comparison,
      differenceCount: 0,
      metrics: [],
      missingData: [
        primary === undefined ? "Primary run unavailable" : undefined,
        comparison === undefined ? "Comparison run unavailable" : undefined,
      ].filter(isPresent),
      primary,
      summary: "Choose two local runs to compare.",
    };
  }

  const metrics = compareMetrics(primary, comparison);
  const artifactDelta = compareArtifacts(
    primary.artifactNames,
    comparison.artifactNames,
  );
  const differenceCount = metrics.filter((metric) => metric.isDifferent).length;
  const missingData = [
    ...primary.missingData.map((item) => `Primary: ${item}`),
    ...comparison.missingData.map((item) => `Comparison: ${item}`),
  ];

  return {
    artifactDelta,
    comparison,
    differenceCount,
    metrics,
    missingData,
    primary,
    summary:
      differenceCount === 0
        ? "No key differences detected in public run data."
        : `${differenceCount} key differences detected in public run data.`,
  };
}

function toCompareSide(
  run: LocalRunSummary | undefined,
  events: ReadonlyArray<RunEvent>,
): RunCompareSide | undefined {
  if (run === undefined) {
    return undefined;
  }

  const reportSignal = reportSignalFor(run, events);
  const checkSignal = checkSignalFor(run, events);
  const reviewSignal = reviewSignalFor(run, events);
  const durationLabel = durationBetween(run.createdAt, run.updatedAt);
  const missingData: Array<string> = [];

  if (run.eventCount > 0 && events.length === 0) {
    missingData.push("ordered events unavailable");
  } else if (run.eventCount !== events.length) {
    missingData.push(
      `${run.eventCount} events reported, ${events.length} loaded`,
    );
  }

  if (run.artifacts.length === 0) {
    missingData.push("no artifacts exposed");
  }

  if (reportSignal.state === "missing") {
    missingData.push("report outcome unavailable");
  }

  if (checkSignal.state === "missing") {
    missingData.push("check outcome unavailable");
  }

  if (reviewSignal.state === "missing") {
    missingData.push("review outcome unavailable");
  }

  if (durationLabel === "Unavailable") {
    missingData.push("duration unavailable");
  }

  return {
    artifactCountLabel: `${run.artifacts.length} exposed`,
    artifactNames: run.artifacts,
    checkSignal,
    createdAtLabel: timestampLabel(run.createdAt),
    durationLabel,
    eventCountLabel: `${run.eventCount} reported / ${events.length} loaded`,
    lifecycleLabel: stateLabel(run.state),
    missingData,
    reportSignal,
    reviewSignal,
    runId: run.runId,
    statusLabel: statusLabel(run.status),
    updatedAtLabel: timestampLabel(run.updatedAt),
  };
}

function compareMetrics(
  primary: RunCompareSide,
  comparison: RunCompareSide,
): ReadonlyArray<RunCompareMetric> {
  return [
    metric("Status", primary.statusLabel, comparison.statusLabel),
    metric("Lifecycle", primary.lifecycleLabel, comparison.lifecycleLabel),
    metric("Events", primary.eventCountLabel, comparison.eventCountLabel),
    metric("Artifacts", primary.artifactCountLabel, comparison.artifactCountLabel),
    metric("Report", primary.reportSignal.label, comparison.reportSignal.label),
    metric("Checks", primary.checkSignal.label, comparison.checkSignal.label),
    metric("Review", primary.reviewSignal.label, comparison.reviewSignal.label),
    metric("Duration", primary.durationLabel, comparison.durationLabel),
    metric("Created", primary.createdAtLabel, comparison.createdAtLabel),
    metric("Updated", primary.updatedAtLabel, comparison.updatedAtLabel),
  ];
}

function metric(
  label: string,
  primaryValue: string,
  comparisonValue: string,
): RunCompareMetric {
  return {
    comparisonValue,
    isDifferent: primaryValue !== comparisonValue,
    label,
    primaryValue,
  };
}

function compareArtifacts(
  primaryArtifacts: ReadonlyArray<string>,
  comparisonArtifacts: ReadonlyArray<string>,
) {
  const primary = new Set(primaryArtifacts);
  const comparison = new Set(comparisonArtifacts);

  return {
    comparisonOnly: comparisonArtifacts.filter((artifact) => !primary.has(artifact)),
    primaryOnly: primaryArtifacts.filter((artifact) => !comparison.has(artifact)),
    shared: primaryArtifacts.filter((artifact) => comparison.has(artifact)),
  };
}

function reportSignalFor(
  run: LocalRunSummary,
  events: ReadonlyArray<RunEvent>,
): RunCompareSignal {
  if (run.status === "failed" || events.some((event) => event.type === "RUN_FAILED")) {
    return {
      label: "Run failed",
      state: "failed",
    };
  }

  if (
    run.artifacts.includes("report") ||
    run.artifacts.includes("report-json") ||
    events.some((event) => event.type === "REPORT_COMPLETED")
  ) {
    return {
      label: "Report available",
      state: "available",
    };
  }

  return {
    label: "Report unavailable",
    state: "missing",
  };
}

function checkSignalFor(
  run: LocalRunSummary,
  events: ReadonlyArray<RunEvent>,
): RunCompareSignal {
  if (
    run.artifacts.includes("verification-result") ||
    events.some((event) => event.type === "VERIFICATION_COMPLETED")
  ) {
    return {
      label: "Checks available",
      state: "available",
    };
  }

  return {
    label: "Checks unavailable",
    state: "missing",
  };
}

function reviewSignalFor(
  run: LocalRunSummary,
  events: ReadonlyArray<RunEvent>,
): RunCompareSignal {
  if (
    run.artifacts.some((artifact) => artifact.includes("review")) ||
    events.some((event) => event.type === "REVIEW_COMPLETED")
  ) {
    return {
      label: "Review evidence available",
      state: "available",
    };
  }

  return {
    label: "Review unavailable",
    state: "missing",
  };
}

function durationBetween(createdAt: string, updatedAt: string) {
  const created = new Date(createdAt).getTime();
  const updated = new Date(updatedAt).getTime();

  if (
    Number.isNaN(created) ||
    Number.isNaN(updated) ||
    updated < created
  ) {
    return "Unavailable";
  }

  const durationMs = updated - created;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function statusLabel(status: string) {
  return `${status[0]?.toUpperCase() ?? ""}${status.slice(1)}`;
}

function stateLabel(state: string) {
  return state
    .replace(/[A-Z]/gu, (match) => ` ${match}`)
    .replace(/^./u, (match) => match.toUpperCase());
}

function timestampLabel(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Unavailable";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
