import {
  WorkerEnvironmentEpochComparisonDto,
  compareWorkerEnvironmentEpochs,
  LocalRunReadArtifactIdSchema,
  RunEvent,
  RunIdSchema,
  LocalRunSummaryDto,
} from "@gaia/core";
import { Schema } from "effect";

export const RunCompareSignalStateSchema = Schema.Literals([
  "available",
  "blocked",
  "failed",
  "missing",
] as const);

export const RunCompareSignalSchema = Schema.Struct({
  label: Schema.String,
  state: RunCompareSignalStateSchema,
});

export type RunCompareSignal = typeof RunCompareSignalSchema.Type;

export const RunCompareSideSchema = Schema.Struct({
  artifactCountLabel: Schema.String,
  artifactNames: Schema.Array(LocalRunReadArtifactIdSchema),
  checkSignal: RunCompareSignalSchema,
  createdAtLabel: Schema.String,
  durationLabel: Schema.String,
  eventCountLabel: Schema.String,
  lifecycleLabel: Schema.String,
  missingData: Schema.Array(Schema.String),
  reportSignal: RunCompareSignalSchema,
  reviewSignal: RunCompareSignalSchema,
  runId: RunIdSchema,
  statusLabel: Schema.String,
  updatedAtLabel: Schema.String,
  workerEnvironmentEpoch: Schema.optionalKey(
    WorkerEnvironmentEpochComparisonDto
  ),
  workerEnvironmentEpochLabel: Schema.String,
});

export type RunCompareSide = typeof RunCompareSideSchema.Type;

export const RunCompareMetricSchema = Schema.Struct({
  comparisonValue: Schema.String,
  isDifferent: Schema.Boolean,
  label: Schema.String,
  primaryValue: Schema.String,
});

export type RunCompareMetric = typeof RunCompareMetricSchema.Type;

export const RunCompareArtifactDeltaSchema = Schema.Struct({
  comparisonOnly: Schema.Array(LocalRunReadArtifactIdSchema),
  primaryOnly: Schema.Array(LocalRunReadArtifactIdSchema),
  shared: Schema.Array(LocalRunReadArtifactIdSchema),
});

export const RunCompareModelSchema = Schema.Struct({
  artifactDelta: RunCompareArtifactDeltaSchema,
  comparison: Schema.optional(RunCompareSideSchema),
  differenceCount: Schema.Number,
  metrics: Schema.Array(RunCompareMetricSchema),
  missingData: Schema.Array(Schema.String),
  primary: Schema.optional(RunCompareSideSchema),
  summary: Schema.String,
});

export type RunCompareModel = typeof RunCompareModelSchema.Type;

type LocalRunSummary = typeof LocalRunSummaryDto.Type;

const decodeRunCompareArtifactId = Schema.decodeUnknownSync(
  LocalRunReadArtifactIdSchema
);
const compareArtifactIds = Object.freeze({
  evidenceReview: decodeRunCompareArtifactId("evidence-review"),
  planReview: decodeRunCompareArtifactId("plan-review"),
  report: decodeRunCompareArtifactId("report"),
  reportJson: decodeRunCompareArtifactId("report-json"),
  reviewerFindings: decodeRunCompareArtifactId("reviewer-findings"),
  verificationResult: decodeRunCompareArtifactId("verification-result"),
});

const BuildRunCompareModelInputSchema = Schema.Struct({
  comparisonEvents: Schema.Array(RunEvent),
  comparisonRun: Schema.UndefinedOr(LocalRunSummaryDto),
  primaryEvents: Schema.Array(RunEvent),
  primaryRun: Schema.UndefinedOr(LocalRunSummaryDto),
});

export function buildRunCompareModel(
  input: typeof BuildRunCompareModelInputSchema.Type
): RunCompareModel {
  const primary = toCompareSide(input.primaryRun, input.primaryEvents);
  const comparison = toCompareSide(input.comparisonRun, input.comparisonEvents);

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
    comparison.artifactNames
  );
  const differenceCount = metrics.filter((metric) => metric.isDifferent).length;
  const missingData = [
    ...primary.missingData.map((item) => `Primary: ${item}`),
    ...comparison.missingData.map((item) => `Comparison: ${item}`),
  ];
  const environmentComparison = compareWorkerEnvironmentEpochs(
    primary.workerEnvironmentEpoch,
    comparison.workerEnvironmentEpoch
  );
  const environmentRefusal = environmentEquivalenceRefusal(
    environmentComparison.reason
  );
  if (environmentRefusal !== undefined) missingData.push(environmentRefusal);

  return {
    artifactDelta,
    comparison,
    differenceCount,
    metrics,
    missingData,
    primary,
    summary:
      environmentRefusal !== undefined
        ? `${environmentRefusal} ${differenceCount} key differences detected in public run data.`
        : differenceCount === 0
          ? "No key differences detected in public run data."
          : `${differenceCount} key differences detected in public run data.`,
  };
}

function toCompareSide(
  run: LocalRunSummary | undefined,
  events: ReadonlyArray<RunEvent>
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
      `${run.eventCount} events reported, ${events.length} loaded`
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

  if (
    run.workerEnvironmentEpoch === undefined ||
    run.workerEnvironmentEpoch.state !== "completeComparable"
  ) {
    missingData.push(
      "worker environment epoch equivalence refused because comparable evidence is unavailable"
    );
  }

  return {
    artifactCountLabel: `${run.artifacts.length} exposed`,
    artifactNames: run.artifacts.map((artifact) =>
      decodeRunCompareArtifactId(artifact)
    ),
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
    ...(run.workerEnvironmentEpoch === undefined
      ? {}
      : { workerEnvironmentEpoch: run.workerEnvironmentEpoch }),
    workerEnvironmentEpochLabel: environmentEpochLabel(
      run.workerEnvironmentEpoch
    ),
  };
}

function environmentEquivalenceRefusal(
  reason: ReturnType<typeof compareWorkerEnvironmentEpochs>["reason"]
) {
  switch (reason) {
    case "missingEvidence":
      return "Worker environment epoch equivalence refused: evidence is missing.";
    case "incompleteEvidence":
      return "Worker environment epoch equivalence refused: evidence is incomplete.";
    case "nonComparableEvidence":
      return "Worker environment epoch equivalence refused: policy marks evidence non-comparable.";
    case "differentStructuralDigest":
    case "matchingCompleteStructuralDigest":
      return undefined;
  }
}

function compareMetrics(
  primary: RunCompareSide,
  comparison: RunCompareSide
): ReadonlyArray<RunCompareMetric> {
  const environmentComparison = compareWorkerEnvironmentEpochs(
    primary.workerEnvironmentEpoch,
    comparison.workerEnvironmentEpoch
  );
  return [
    metric("Status", primary.statusLabel, comparison.statusLabel),
    metric("Lifecycle", primary.lifecycleLabel, comparison.lifecycleLabel),
    metric("Events", primary.eventCountLabel, comparison.eventCountLabel),
    metric(
      "Artifacts",
      primary.artifactCountLabel,
      comparison.artifactCountLabel
    ),
    metric("Report", primary.reportSignal.label, comparison.reportSignal.label),
    metric("Checks", primary.checkSignal.label, comparison.checkSignal.label),
    metric("Review", primary.reviewSignal.label, comparison.reviewSignal.label),
    metric("Duration", primary.durationLabel, comparison.durationLabel),
    metric("Created", primary.createdAtLabel, comparison.createdAtLabel),
    metric("Updated", primary.updatedAtLabel, comparison.updatedAtLabel),
    {
      ...metric(
        "Worker environment",
        primary.workerEnvironmentEpochLabel,
        comparison.workerEnvironmentEpochLabel
      ),
      isDifferent: !environmentComparison.equivalent,
    },
  ];
}

function environmentEpochLabel(
  epoch: typeof WorkerEnvironmentEpochComparisonDto.Type | undefined
) {
  if (epoch === undefined) return "Unavailable";
  switch (epoch.state) {
    case "completeComparable":
      return `Complete ${epoch.structuralDigest.slice(0, 12)}`;
    case "incomplete":
      return "Incomplete";
    case "missing":
      return "Missing";
    case "nonComparable":
      return "Non-comparable";
  }
}

function metric(
  label: string,
  primaryValue: string,
  comparisonValue: string
): RunCompareMetric {
  return {
    comparisonValue,
    isDifferent: primaryValue !== comparisonValue,
    label,
    primaryValue,
  };
}

function compareArtifacts(
  primaryArtifacts: ReadonlyArray<typeof LocalRunReadArtifactIdSchema.Type>,
  comparisonArtifacts: ReadonlyArray<typeof LocalRunReadArtifactIdSchema.Type>
) {
  const primary = new Set(primaryArtifacts);
  const comparison = new Set(comparisonArtifacts);

  return {
    comparisonOnly: comparisonArtifacts.filter(
      (artifact) => !primary.has(artifact)
    ),
    primaryOnly: primaryArtifacts.filter(
      (artifact) => !comparison.has(artifact)
    ),
    shared: primaryArtifacts.filter((artifact) => comparison.has(artifact)),
  };
}

function reportSignalFor(
  run: LocalRunSummary,
  events: ReadonlyArray<RunEvent>
): RunCompareSignal {
  if (
    run.status === "failed" ||
    events.some((event) => event.type === "RUN_FAILED")
  ) {
    return {
      label: "Run failed",
      state: "failed",
    };
  }

  if (
    run.artifacts.includes(compareArtifactIds.report) ||
    run.artifacts.includes(compareArtifactIds.reportJson) ||
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
  events: ReadonlyArray<RunEvent>
): RunCompareSignal {
  if (run.proofAggregate !== undefined) {
    const state =
      run.proofAggregate === "verified"
        ? "available"
        : run.proofAggregate === "verification-failed"
          ? "failed"
          : "blocked";
    return {
      label: `Run proof: ${run.proofAggregate}`,
      state,
    };
  }
  if (
    run.artifacts.includes(compareArtifactIds.verificationResult) ||
    events.some(
      (event) =>
        event.type === "VERIFICATION_COMPLETED" ||
        event.type === "RUN_PROOF_RESULT_RECORDED"
    )
  ) {
    return {
      label: "Run proof result recorded; verification unknown",
      state: "missing",
    };
  }

  return {
    label: "Checks unavailable",
    state: "missing",
  };
}

function reviewSignalFor(
  run: LocalRunSummary,
  events: ReadonlyArray<RunEvent>
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

  if (Number.isNaN(created) || Number.isNaN(updated) || updated < created) {
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
