import { ReviewPhaseSchema, RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { RunRelativeArtifactPathSchema, RuntimePathSchema } from "./paths.js";

export const ReviewerNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("ReviewerName")
);

export type ReviewerName = typeof ReviewerNameSchema.Type;

export const ReviewerSessionAdapterKindSchema = Schema.Literals([
  "codex-cli",
  "custom",
  "deterministic",
] as const);

export type ReviewerSessionAdapterKind =
  typeof ReviewerSessionAdapterKindSchema.Type;

export const ReviewerSessionKindSchema = Schema.Literals([
  "cli",
  "local",
  "visible",
] as const);

export type ReviewerSessionKind = typeof ReviewerSessionKindSchema.Type;

export const ReviewerSessionDecisionStatusSchema = Schema.Literals([
  "approved",
  "blocked",
] as const);

export type ReviewerSessionDecisionStatus =
  typeof ReviewerSessionDecisionStatusSchema.Type;

export class ReviewerSessionEvidence extends Schema.Class<ReviewerSessionEvidence>(
  "ReviewerSessionEvidence"
)({
  adapterKind: ReviewerSessionAdapterKindSchema,
  command: Schema.optionalKey(Schema.NonEmptyString),
  cwd: Schema.optionalKey(RuntimePathSchema),
  decisionStatus: ReviewerSessionDecisionStatusSchema,
  evidencePath: RunRelativeArtifactPathSchema,
  logPath: Schema.optionalKey(RunRelativeArtifactPathSchema),
  phase: ReviewPhaseSchema,
  resultPath: RunRelativeArtifactPathSchema,
  reviewPath: RunRelativeArtifactPathSchema,
  reviewerName: ReviewerNameSchema,
  runId: RunIdSchema,
  sessionId: Schema.optionalKey(Schema.NonEmptyString),
  sessionKind: ReviewerSessionKindSchema,
  transcriptPath: Schema.optionalKey(RunRelativeArtifactPathSchema),
  version: Schema.Literal(1),
}) {
  static override make(input: unknown): ReviewerSessionEvidence {
    return decodeReviewerSessionEvidence(input);
  }
}

const decodeReviewerSessionEvidence = Schema.decodeUnknownSync(
  ReviewerSessionEvidence
);

const ReviewerSessionEvidenceJson = Schema.toCodecJson(ReviewerSessionEvidence);
export const encodeReviewerSessionEvidenceJson = Schema.encodeSync(
  ReviewerSessionEvidenceJson
);

export const parseReviewerSessionEvidenceJson = Schema.decodeUnknownSync(
  ReviewerSessionEvidenceJson
);

const WriteReviewerSessionEvidenceInputSchema = Schema.Struct({
  evidence: ReviewerSessionEvidence,
  path: RuntimePathSchema,
});

export function writeReviewerSessionEvidence(
  input: typeof WriteReviewerSessionEvidenceInputSchema.Type
): Effect.Effect<
  ReviewerSessionEvidence,
  GaiaRuntimeError,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      input.path,
      `${JSON.stringify(encodeReviewerSessionEvidenceJson(input.evidence), null, 2)}\n`
    );

    return input.evidence;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "ReviewerSessionEvidenceWriteFailed",
          message:
            "Gaia could not write the reviewer session evidence artifact.",
          recoverable: true,
        })
      )
    )
  );
}
