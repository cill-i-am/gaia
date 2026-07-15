import { ReviewPhaseSchema, RunIdSchema, type ReviewPhase } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";

import { parseBrowserEvidenceJson } from "./browser-evidence.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { HarnessRunResult } from "./harness.js";
import {
  RunRelativeArtifactPathSchema,
  RuntimePathSchema,
  type RuntimePath,
} from "./paths.js";
import {
  ReviewerSessionEvidence,
  writeReviewerSessionEvidence,
  type ReviewerSessionAdapterKind,
  type ReviewerSessionKind,
} from "./reviewer-session-evidence.js";
import { VerificationResult } from "./verifier.js";
import { parseWorkerPlanJson } from "./worker-plan.js";
import {
  changedPaths,
  snapshotWorkspace,
  type WorkspaceDiffSummary,
  type WorkspaceSnapshot,
} from "./workspace-snapshot.js";
import { WorkspacePreparationResult } from "./workspace.js";

export const ReviewerNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("ReviewerName")
);

export type ReviewerName = typeof ReviewerNameSchema.Type;

export const defaultReviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
  "deterministic-reviewer"
);

export class ReviewFinding extends Schema.Class<ReviewFinding>("ReviewFinding")(
  {
    message: Schema.NonEmptyString,
    severity: Schema.Literals(["info", "warning", "blocker"] as const),
  }
) {}

export class ReviewResult extends Schema.Class<ReviewResult>("ReviewResult")({
  findings: Schema.Array(ReviewFinding),
  phase: ReviewPhaseSchema,
  resultPath: RunRelativeArtifactPathSchema,
  reviewerName: ReviewerNameSchema,
  runId: RunIdSchema,
  sessionEvidence: Schema.optionalKey(ReviewerSessionEvidence),
  status: Schema.Literals(["approved", "blocked"] as const),
  summary: Schema.NonEmptyString,
}) {
  static override make(input: unknown): ReviewResult {
    return decodeReviewResult(input);
  }
}

export class ReviewRunRequest extends Schema.Class<ReviewRunRequest>(
  "ReviewRunRequest"
)({
  browserEvidencePath: RuntimePathSchema,
  markdownPath: RuntimePathSchema,
  phase: ReviewPhaseSchema,
  resultPath: RuntimePathSchema,
  runId: RunIdSchema,
  sessionEvidencePath: RuntimePathSchema,
  specBody: Schema.NonEmptyString,
  specTitle: Schema.NonEmptyString,
  verificationResultPath: RuntimePathSchema,
  workerPlanPath: RuntimePathSchema,
  workerResultPath: RuntimePathSchema,
  workspaceManifestPath: RuntimePathSchema,
  workspacePath: RuntimePathSchema,
}) {}

export type GaiaReviewer = {
  readonly adapterKind?: ReviewerSessionAdapterKind;
  readonly name: ReviewerName;
  readonly run: (
    request: ReviewRunRequest
  ) => Effect.Effect<
    ReviewResult,
    GaiaRuntimeError,
    FileSystem.FileSystem | Path.Path
  >;
  readonly sessionKind?: ReviewerSessionKind;
};

export type ReviewerRunOptions = {
  readonly reviewer?: GaiaReviewer;
};

const ReviewResultJson = Schema.toCodecJson(ReviewResult);
const decodeReviewResult = Schema.decodeUnknownSync(ReviewResult);
const encodeReviewResult = Schema.encodeSync(ReviewResultJson);
const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const parseHarnessRunResultJson =
  Schema.decodeUnknownSync(HarnessRunResultJson);
const VerificationResultJson = Schema.toCodecJson(VerificationResult);
const parseVerificationResultJson = Schema.decodeUnknownSync(
  VerificationResultJson
);
const WorkspacePreparationResultJson = Schema.toCodecJson(
  WorkspacePreparationResult
);
const parseWorkspacePreparationResultJson = Schema.decodeUnknownSync(
  WorkspacePreparationResultJson
);

export function runReviewer(
  request: ReviewRunRequest,
  options: ReviewerRunOptions = {}
): Effect.Effect<
  ReviewResult,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const reviewer = options.reviewer ?? deterministicReviewer;
    const beforeWorkspace = yield* snapshotWorkspace(
      request.workspacePath
    ).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ReviewerWorkspaceSnapshotFailed",
          message: "Reviewer could not snapshot the workspace before review.",
          recoverable: true,
        })
      )
    );
    const result = yield* reviewer.run(request);
    const afterWorkspace = yield* snapshotWorkspace(request.workspacePath).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ReviewerWorkspaceSnapshotFailed",
          message: "Reviewer could not snapshot the workspace after review.",
          recoverable: true,
        })
      )
    );

    yield* requireReviewerDidNotMutateWorkspace(
      beforeWorkspace,
      afterWorkspace,
      reviewer
    );

    const sessionEvidence =
      result.sessionEvidence ??
      makeDefaultReviewerSessionEvidence(request, result, reviewer, path);
    const resultWithSessionEvidence = withSessionEvidence(
      result,
      sessionEvidence
    );

    yield* writeReviewerSessionEvidence({
      evidence: sessionEvidence,
      path: request.sessionEvidencePath,
    });
    yield* writeReviewArtifacts(request, resultWithSessionEvidence);
    return resultWithSessionEvidence;
  });
}

const deterministicReviewer: GaiaReviewer = {
  adapterKind: "deterministic",
  name: defaultReviewerName,
  run: (request) =>
    request.phase === "plan" ? reviewPlan(request) : reviewEvidence(request),
  sessionKind: "local",
};

function requireReviewerDidNotMutateWorkspace(
  beforeWorkspace: WorkspaceSnapshot,
  afterWorkspace: WorkspaceSnapshot,
  reviewer: GaiaReviewer
) {
  const mutatedPaths = changedPaths(beforeWorkspace, afterWorkspace);

  if (mutatedPaths.length === 0) {
    return Effect.void;
  }

  return Effect.fail(
    makeRuntimeError({
      code: "ReviewerWorkspaceMutated",
      message: `Reviewer '${reviewer.name}' mutated workspace path(s): ${mutatedPaths.join(", ")}.`,
      recoverable: true,
    })
  );
}

function reviewPlan(request: ReviewRunRequest) {
  return Effect.gen(function* () {
    const workspaceManifest = yield* decodeJsonArtifact(
      request.workspaceManifestPath,
      parseWorkspacePreparationResultJson,
      "WorkspaceManifest"
    );
    const workerPlan = yield* decodeJsonArtifact(
      request.workerPlanPath,
      parseWorkerPlanJson,
      "WorkerPlan"
    );

    return ReviewResult.make({
      findings: [
        ReviewFinding.make({
          message: `Reviewed "${request.specTitle}" before worker execution with ${workerPlan.harnessName}.`,
          severity: "info",
        }),
        ReviewFinding.make({
          message: [
            `Plan includes ${countLabel(workerPlan.acceptanceCriteria.length, "acceptance criterion", "acceptance criteria")},`,
            `${countLabel(workerPlan.nonGoals.length, "non-goal", "non-goals")},`,
            `${countLabel(workerPlan.likelyTouchedSurfaces.length, "likely touched surface", "likely touched surfaces")},`,
            `${countLabel(workerPlan.verificationChecks.length, "verification check", "verification checks")},`,
            `and ${countLabel(workerPlan.stopConditions.length, "stop condition", "stop conditions")}.`,
          ].join(" "),
          severity: "info",
        }),
        ReviewFinding.make({
          message: `Workspace source is ${workspaceManifest.source}.`,
          severity: "info",
        }),
      ],
      phase: "plan",
      resultPath: "plan-review.json",
      reviewerName: defaultReviewerName,
      runId: request.runId,
      status: "approved",
      summary: "Plan review approved the spec and workspace contract.",
    });
  });
}

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function reviewEvidence(request: ReviewRunRequest) {
  return Effect.gen(function* () {
    const browserEvidence = yield* decodeJsonArtifact(
      request.browserEvidencePath,
      parseBrowserEvidenceJson,
      "BrowserEvidence"
    );
    const harnessResult = yield* decodeJsonArtifact(
      request.workerResultPath,
      parseHarnessRunResultJson,
      "HarnessRunResult"
    );
    const verificationResult = yield* decodeJsonArtifact(
      request.verificationResultPath,
      parseVerificationResultJson,
      "VerificationResult"
    );

    return ReviewResult.make({
      findings: [
        ReviewFinding.make({
          message: `Harness ${harnessResult.harnessName} completed with ${harnessResult.outputArtifacts.length} artifact(s).`,
          severity: "info",
        }),
        ReviewFinding.make({
          message: `Verification ${verificationResult.status} for ${verificationResult.checkedArtifacts.length} artifact(s).`,
          severity: "info",
        }),
        ReviewFinding.make({
          message: `Browser evidence ${browserEvidence.status} for ${browserEvidence.pages.length} page(s).`,
          severity: browserEvidence.status === "failed" ? "warning" : "info",
        }),
        ...workspaceDiffFindings(harnessResult.workspaceDiff),
      ],
      phase: "evidence",
      resultPath: "evidence-review.json",
      reviewerName: defaultReviewerName,
      runId: request.runId,
      status: "approved",
      summary: "Evidence review approved worker and verification artifacts.",
    });
  });
}

function workspaceDiffFindings(
  workspaceDiff: WorkspaceDiffSummary | undefined
) {
  if (workspaceDiff === undefined) {
    return [];
  }

  const findings = [
    ReviewFinding.make({
      message: `Workspace product changes (${workspaceDiff.productChangedPathCount}): ${formatPathPreview(workspaceDiff.productChangedPaths)}.`,
      severity: "info",
    }),
  ];

  if (workspaceDiff.omittedGeneratedPathCount > 0) {
    findings.push(
      ReviewFinding.make({
        message: `Generated workspace paths omitted from product diff evidence (${workspaceDiff.omittedGeneratedPathCount}): ${formatGeneratedPathSummaries(workspaceDiff)}.`,
        severity: "info",
      })
    );
  }

  return findings;
}

function formatPathPreview(paths: ReadonlyArray<string>) {
  if (paths.length === 0) {
    return "none";
  }

  const previewLimit = 20;
  const preview = paths.slice(0, previewLimit).join(", ");
  const remainingCount = paths.length - previewLimit;

  return remainingCount > 0
    ? `${preview}, and ${remainingCount} more`
    : preview;
}

function formatGeneratedPathSummaries(workspaceDiff: WorkspaceDiffSummary) {
  return workspaceDiff.omittedGeneratedPaths
    .map(
      (entry) =>
        `${entry.path} (${entry.changedFileCount} file(s); ${entry.reason})`
    )
    .join("; ");
}

function decodeJsonArtifact<T>(
  path: RuntimePath,
  parse: (input: unknown) => T,
  artifactName: string
): Effect.Effect<T, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "ReviewArtifactReadFailed",
            message: `Reviewer could not read ${artifactName}.`,
            recoverable: true,
          })
        )
      )
    );
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "ReviewArtifactJsonInvalid",
          message: `Reviewer found invalid JSON in ${artifactName}.`,
          recoverable: true,
        }),
    });

    return yield* Effect.try({
      try: () => parse(parsed),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "ReviewArtifactInvalid",
          message: `Reviewer found invalid ${artifactName}.`,
          recoverable: true,
        }),
    });
  });
}

function writeReviewArtifacts(request: ReviewRunRequest, result: ReviewResult) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(request.markdownPath, markdownReview(result));
    yield* fs.writeFileString(
      request.resultPath,
      `${JSON.stringify(encodeReviewResult(result), null, 2)}\n`
    );
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "ReviewArtifactWriteFailed",
          message: `Reviewer could not write ${request.phase} review artifacts.`,
          recoverable: true,
        })
      )
    )
  );
}

function makeDefaultReviewerSessionEvidence(
  request: ReviewRunRequest,
  result: ReviewResult,
  reviewer: GaiaReviewer,
  path: Path.Path
) {
  return ReviewerSessionEvidence.make({
    adapterKind: reviewer.adapterKind ?? "custom",
    decisionStatus: result.status,
    evidencePath: path.basename(request.sessionEvidencePath),
    phase: result.phase,
    resultPath: result.resultPath,
    reviewPath: path.basename(request.markdownPath),
    reviewerName: reviewer.name,
    runId: result.runId,
    sessionKind: reviewer.sessionKind ?? "local",
    version: 1,
  });
}

function withSessionEvidence(
  result: ReviewResult,
  sessionEvidence: ReviewerSessionEvidence
) {
  return ReviewResult.make({
    findings: result.findings,
    phase: result.phase,
    resultPath: result.resultPath,
    reviewerName: result.reviewerName,
    runId: result.runId,
    sessionEvidence,
    status: result.status,
    summary: result.summary,
  });
}

function markdownReview(result: ReviewResult) {
  const findings = result.findings
    .map((finding) => `- ${finding.severity}: ${finding.message}`)
    .join("\n");
  const sessionEvidence =
    result.sessionEvidence === undefined
      ? "Session Evidence: not recorded"
      : `Session Evidence: ${result.sessionEvidence.evidencePath}`;

  return `# Gaia ${reviewPhaseLabel(result.phase)} Review

Status: ${result.status}
Reviewer: ${result.reviewerName}
${sessionEvidence}

## Summary

${result.summary}

## Findings

${findings}
`;
}

function reviewPhaseLabel(phase: ReviewPhase) {
  switch (phase) {
    case "plan":
      return "Plan";
    case "evidence":
      return "Evidence";
  }
}
