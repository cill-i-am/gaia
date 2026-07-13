import { ReviewPhaseSchema, RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";

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
  cwd: Schema.optionalKey(Schema.NonEmptyString),
  decisionStatus: ReviewerSessionDecisionStatusSchema,
  evidencePath: Schema.NonEmptyString,
  logPath: Schema.optionalKey(Schema.NonEmptyString),
  phase: ReviewPhaseSchema,
  resultPath: Schema.NonEmptyString,
  reviewPath: Schema.NonEmptyString,
  reviewerName: Schema.NonEmptyString,
  runId: RunIdSchema,
  sessionId: Schema.optionalKey(Schema.NonEmptyString),
  sessionKind: ReviewerSessionKindSchema,
  transcriptPath: Schema.optionalKey(Schema.NonEmptyString),
  version: Schema.Literal(1),
}) {}

const ReviewerSessionEvidenceJson = Schema.toCodecJson(ReviewerSessionEvidence);
const encodeReviewerSessionEvidenceJson = Schema.encodeSync(
  ReviewerSessionEvidenceJson
);

export const parseReviewerSessionEvidenceJson = Schema.decodeUnknownSync(
  ReviewerSessionEvidenceJson
);

export function writeReviewerSessionEvidence(input: {
  readonly evidence: ReviewerSessionEvidence;
  readonly path: string;
}): Effect.Effect<
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
