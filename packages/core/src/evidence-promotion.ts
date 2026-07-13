import * as Schema from "effect/Schema";

import { RunIdSchema } from "./run-id.js";

const NonNegativeIntegerSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
);

export const EvidencePromotionStatusSchema = Schema.Literals([
  "promoted",
  "pending-promotion",
  "skipped",
] as const);

/** Promotion state for selected run evidence. */
export type EvidencePromotionStatus = typeof EvidencePromotionStatusSchema.Type;

export const EvidencePromotionCleanupStatusSchema = Schema.Literals([
  "completed",
  "not-completed",
] as const);

/** Whether raw generated Gaia run state has already been cleaned up. */
export type EvidencePromotionCleanupStatus =
  typeof EvidencePromotionCleanupStatusSchema.Type;

export class PromotedEvidenceItem extends Schema.Class<PromotedEvidenceItem>(
  "PromotedEvidenceItem"
)({
  label: Schema.NonEmptyString,
  path: Schema.optionalKey(Schema.NonEmptyString),
  status: EvidencePromotionStatusSchema,
  summary: Schema.NonEmptyString,
}) {}

export class EvidencePromotionReportPaths extends Schema.Class<EvidencePromotionReportPaths>(
  "EvidencePromotionReportPaths"
)({
  dogfoodRetrospectivePath: Schema.optionalKey(Schema.NonEmptyString),
  reportJsonPath: Schema.optionalKey(Schema.NonEmptyString),
  reportMarkdownPath: Schema.optionalKey(Schema.NonEmptyString),
  workerPlanPath: Schema.optionalKey(Schema.NonEmptyString),
}) {}

export class EvidencePromotionVerificationSummary extends Schema.Class<EvidencePromotionVerificationSummary>(
  "EvidencePromotionVerificationSummary"
)({
  checkedArtifacts: Schema.Array(Schema.NonEmptyString),
  path: Schema.optionalKey(Schema.NonEmptyString),
  status: Schema.NonEmptyString,
}) {}

export class EvidencePromotionPullRequestSummary extends Schema.Class<EvidencePromotionPullRequestSummary>(
  "EvidencePromotionPullRequestSummary"
)({
  artifactPaths: Schema.Array(Schema.NonEmptyString),
  checksStatus: Schema.optionalKey(Schema.NonEmptyString),
  feedbackStatus: Schema.optionalKey(Schema.NonEmptyString),
  headSha: Schema.optionalKey(Schema.NonEmptyString),
  pr: Schema.optionalKey(Schema.NonEmptyString),
  status: EvidencePromotionStatusSchema,
  summary: Schema.NonEmptyString,
  url: Schema.optionalKey(Schema.String),
}) {}

export class EvidencePromotionDogfoodSummary extends Schema.Class<EvidencePromotionDogfoodSummary>(
  "EvidencePromotionDogfoodSummary"
)({
  artifactPath: Schema.optionalKey(Schema.NonEmptyString),
  findingCount: NonNegativeIntegerSchema,
  status: Schema.NonEmptyString,
  summary: Schema.NonEmptyString,
}) {}

/** JSON-safe selected evidence summary intended for Linear or PR text. */
export class EvidencePromotion extends Schema.Class<EvidencePromotion>(
  "EvidencePromotion"
)({
  artifactPath: Schema.NonEmptyString,
  cleanupStatus: EvidencePromotionCleanupStatusSchema,
  dogfood: EvidencePromotionDogfoodSummary,
  generatedAt: Schema.NonEmptyString,
  markdown: Schema.NonEmptyString,
  markdownPath: Schema.NonEmptyString,
  promotionStatus: EvidencePromotionStatusSchema,
  pullRequest: EvidencePromotionPullRequestSummary,
  reportPaths: EvidencePromotionReportPaths,
  runId: RunIdSchema,
  selectedEvidence: Schema.Array(PromotedEvidenceItem),
  verification: EvidencePromotionVerificationSummary,
  version: Schema.Literal(1),
}) {}

export const parseEvidencePromotion =
  Schema.decodeUnknownSync(EvidencePromotion);
