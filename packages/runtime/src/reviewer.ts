import {
  ReviewPhaseSchema,
  RunIdSchema,
  type ReviewPhase,
} from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { HarnessRunResult } from "./harness.js";
import { VerificationResult } from "./verifier.js";
import { parseWorkerPlanJson } from "./worker-plan.js";
import { WorkspacePreparationResult } from "./workspace.js";
import { changedPaths, snapshotWorkspace } from "./workspace-snapshot.js";

export const ReviewerNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("ReviewerName"),
);

export type ReviewerName = typeof ReviewerNameSchema.Type;

export const defaultReviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
  "deterministic-reviewer",
);

export class ReviewFinding extends Schema.Class<ReviewFinding>(
  "ReviewFinding",
)({
  message: Schema.NonEmptyString,
  severity: Schema.Literals(["info", "warning", "blocker"] as const),
}) {}

export class ReviewResult extends Schema.Class<ReviewResult>("ReviewResult")({
  findings: Schema.Array(ReviewFinding),
  phase: ReviewPhaseSchema,
  resultPath: Schema.NonEmptyString,
  reviewerName: ReviewerNameSchema,
  runId: RunIdSchema,
  status: Schema.Literals(["approved", "blocked"] as const),
  summary: Schema.NonEmptyString,
}) {}

export class ReviewRunRequest extends Schema.Class<ReviewRunRequest>(
  "ReviewRunRequest",
)({
  markdownPath: Schema.NonEmptyString,
  phase: ReviewPhaseSchema,
  resultPath: Schema.NonEmptyString,
  runId: RunIdSchema,
  specBody: Schema.NonEmptyString,
  specTitle: Schema.NonEmptyString,
  verificationResultPath: Schema.NonEmptyString,
  workerPlanPath: Schema.NonEmptyString,
  workerResultPath: Schema.NonEmptyString,
  workspaceManifestPath: Schema.NonEmptyString,
  workspacePath: Schema.NonEmptyString,
}) {}

export type GaiaReviewer = {
  readonly name: ReviewerName;
  readonly run: (
    request: ReviewRunRequest,
  ) => Effect.Effect<
    ReviewResult,
    GaiaRuntimeError,
    FileSystem.FileSystem | Path.Path
  >;
};

export type ReviewerRunOptions = {
  readonly reviewer?: GaiaReviewer;
};

const ReviewResultJson = Schema.toCodecJson(ReviewResult);
const encodeReviewResult = Schema.encodeSync(ReviewResultJson);
const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const parseHarnessRunResultJson = Schema.decodeUnknownSync(HarnessRunResultJson);
const VerificationResultJson = Schema.toCodecJson(VerificationResult);
const parseVerificationResultJson = Schema.decodeUnknownSync(
  VerificationResultJson,
);
const WorkspacePreparationResultJson = Schema.toCodecJson(
  WorkspacePreparationResult,
);
const parseWorkspacePreparationResultJson = Schema.decodeUnknownSync(
  WorkspacePreparationResultJson,
);

export function runReviewer(
  request: ReviewRunRequest,
  options: ReviewerRunOptions = {},
): Effect.Effect<
  ReviewResult,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const reviewer = options.reviewer ?? deterministicReviewer;
    const beforeWorkspace = yield* snapshotWorkspace(request.workspacePath).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ReviewerWorkspaceSnapshotFailed",
          message: "Reviewer could not snapshot the workspace before review.",
          recoverable: true,
        }),
      ),
    );
    const result = yield* reviewer.run(request);
    const afterWorkspace = yield* snapshotWorkspace(request.workspacePath).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ReviewerWorkspaceSnapshotFailed",
          message: "Reviewer could not snapshot the workspace after review.",
          recoverable: true,
        }),
      ),
    );

    yield* requireReviewerDidNotMutateWorkspace(
      beforeWorkspace,
      afterWorkspace,
      reviewer,
    );

    yield* writeReviewArtifacts(request, result);
    return result;
  });
}

const deterministicReviewer: GaiaReviewer = {
  name: defaultReviewerName,
  run: (request) =>
    request.phase === "plan" ? reviewPlan(request) : reviewEvidence(request),
};

function requireReviewerDidNotMutateWorkspace(
  beforeWorkspace: ReadonlyMap<string, string>,
  afterWorkspace: ReadonlyMap<string, string>,
  reviewer: GaiaReviewer,
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
    }),
  );
}

function reviewPlan(request: ReviewRunRequest) {
  return Effect.gen(function* () {
    const workspaceManifest = yield* decodeJsonArtifact(
      request.workspaceManifestPath,
      parseWorkspacePreparationResultJson,
      "WorkspaceManifest",
    );
    const workerPlan = yield* decodeJsonArtifact(
      request.workerPlanPath,
      parseWorkerPlanJson,
      "WorkerPlan",
    );

    return ReviewResult.make({
      findings: [
        ReviewFinding.make({
          message: `Reviewed "${request.specTitle}" before worker execution with ${workerPlan.harnessName}.`,
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

function reviewEvidence(request: ReviewRunRequest) {
  return Effect.gen(function* () {
    const harnessResult = yield* decodeJsonArtifact(
      request.workerResultPath,
      parseHarnessRunResultJson,
      "HarnessRunResult",
    );
    const verificationResult = yield* decodeJsonArtifact(
      request.verificationResultPath,
      parseVerificationResultJson,
      "VerificationResult",
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

function decodeJsonArtifact<T>(
  path: string,
  parse: (input: unknown) => T,
  artifactName: string,
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
          }),
        ),
      ),
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

function writeReviewArtifacts(
  request: ReviewRunRequest,
  result: ReviewResult,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(request.markdownPath, markdownReview(result));
    yield* fs.writeFileString(
      request.resultPath,
      `${JSON.stringify(encodeReviewResult(result), null, 2)}\n`,
    );
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "ReviewArtifactWriteFailed",
          message: `Reviewer could not write ${request.phase} review artifacts.`,
          recoverable: true,
        }),
      ),
    ),
  );
}

function markdownReview(result: ReviewResult) {
  const findings = result.findings
    .map((finding) => `- ${finding.severity}: ${finding.message}`)
    .join("\n");

  return `# Gaia ${reviewPhaseLabel(result.phase)} Review

Status: ${result.status}
Reviewer: ${result.reviewerName}

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
