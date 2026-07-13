import * as Schema from "effect/Schema";

import { FactoryLaneRoleSchema } from "./factory-delegation.js";
import { RunIdSchema } from "./run-id.js";

export const FactoryLaneScorecardCheckStatusSchema = Schema.Literals([
  "green",
  "failing",
  "pending",
  "no-checks-configured",
  "provider-unavailable",
] as const);

export type FactoryLaneScorecardCheckStatus =
  typeof FactoryLaneScorecardCheckStatusSchema.Type;

export const FactoryLaneScorecardComparisonWaitStatusSchema = Schema.Literals([
  "valid",
  "missing",
  "not-required",
  "failed",
] as const);

export type FactoryLaneScorecardComparisonWaitStatus =
  typeof FactoryLaneScorecardComparisonWaitStatusSchema.Type;

export const FactoryLaneScorecardCriterionSchema = Schema.Literals([
  "correctness",
  "scope-adherence",
  "simplicity",
  "test-evidence",
  "production-readiness",
  "diff-risk",
  "dogfood-signal",
] as const);

export type FactoryLaneScorecardCriterion =
  typeof FactoryLaneScorecardCriterionSchema.Type;

export const FactoryLaneScorecardCriterionClassificationSchema =
  Schema.Literals([
    "strong",
    "adequate",
    "weak",
    "risk",
    "low",
    "medium",
    "high",
    "unknown",
  ] as const);

export type FactoryLaneScorecardCriterionClassification =
  typeof FactoryLaneScorecardCriterionClassificationSchema.Type;

export const FactoryLaneScorecardImplementationAcceptanceStatusSchema =
  Schema.Literals([
    "accepted",
    "acceptable-with-tradeoffs",
    "fallback",
    "not-accepted",
    "unknown",
  ] as const);

export type FactoryLaneScorecardImplementationAcceptanceStatus =
  typeof FactoryLaneScorecardImplementationAcceptanceStatusSchema.Type;

export const FactoryLaneScorecardFactoryLearningSignalStatusSchema =
  Schema.Literals(["strong", "moderate", "weak", "none", "negative"] as const);

export type FactoryLaneScorecardFactoryLearningSignalStatus =
  typeof FactoryLaneScorecardFactoryLearningSignalStatusSchema.Type;

export class FactoryLaneScorecardSourceLink extends Schema.Class<FactoryLaneScorecardSourceLink>(
  "FactoryLaneScorecardSourceLink"
)({
  artifactPath: Schema.optionalKey(Schema.NonEmptyString),
  label: Schema.NonEmptyString,
  url: Schema.optionalKey(Schema.String),
}) {}

export class FactoryLaneScorecardVerificationEvidence extends Schema.Class<FactoryLaneScorecardVerificationEvidence>(
  "FactoryLaneScorecardVerificationEvidence"
)({
  command: Schema.NonEmptyString,
  path: Schema.optionalKey(Schema.NonEmptyString),
  result: Schema.NonEmptyString,
}) {}

export class FactoryLaneScorecardCriterionAssessment extends Schema.Class<FactoryLaneScorecardCriterionAssessment>(
  "FactoryLaneScorecardCriterionAssessment"
)({
  classification: FactoryLaneScorecardCriterionClassificationSchema,
  criterion: FactoryLaneScorecardCriterionSchema,
  evidence: Schema.Array(Schema.NonEmptyString),
  summary: Schema.NonEmptyString,
}) {}

export class FactoryLaneScorecardImplementationAcceptance extends Schema.Class<FactoryLaneScorecardImplementationAcceptance>(
  "FactoryLaneScorecardImplementationAcceptance"
)({
  status: FactoryLaneScorecardImplementationAcceptanceStatusSchema,
  summary: Schema.NonEmptyString,
}) {}

export class FactoryLaneScorecardFactoryLearningSignal extends Schema.Class<FactoryLaneScorecardFactoryLearningSignal>(
  "FactoryLaneScorecardFactoryLearningSignal"
)({
  evidence: Schema.Array(Schema.NonEmptyString),
  status: FactoryLaneScorecardFactoryLearningSignalStatusSchema,
  summary: Schema.NonEmptyString,
}) {}

export class FactoryLaneScorecardLane extends Schema.Class<FactoryLaneScorecardLane>(
  "FactoryLaneScorecardLane"
)({
  checkStatus: FactoryLaneScorecardCheckStatusSchema,
  comparisonWaitStatus: FactoryLaneScorecardComparisonWaitStatusSchema,
  criteria: Schema.Array(FactoryLaneScorecardCriterionAssessment),
  factoryLearningSignal: FactoryLaneScorecardFactoryLearningSignal,
  headSha: Schema.optionalKey(Schema.NonEmptyString),
  implementationAcceptance: FactoryLaneScorecardImplementationAcceptance,
  label: Schema.NonEmptyString,
  laneId: Schema.NonEmptyString,
  localVerification: Schema.Array(FactoryLaneScorecardVerificationEvidence),
  pullRequest: Schema.optionalKey(Schema.NonEmptyString),
  role: FactoryLaneRoleSchema,
  sourceLinks: Schema.Array(FactoryLaneScorecardSourceLink),
  tradeoffs: Schema.Array(Schema.NonEmptyString),
}) {}

export class FactoryLaneScorecardPreferredLane extends Schema.Class<FactoryLaneScorecardPreferredLane>(
  "FactoryLaneScorecardPreferredLane"
)({
  laneId: Schema.NonEmptyString,
  rationale: Schema.NonEmptyString,
  tradeoffsPreserved: Schema.Array(Schema.NonEmptyString),
}) {}

/** Inspectable A/B lane comparison artifact for orchestrator decisions. */
export class FactoryLaneScorecard extends Schema.Class<FactoryLaneScorecard>(
  "FactoryLaneScorecard"
)({
  artifactPath: Schema.NonEmptyString,
  comparisonSummary: Schema.NonEmptyString,
  generatedAt: Schema.NonEmptyString,
  lanes: Schema.Array(FactoryLaneScorecardLane),
  markdown: Schema.NonEmptyString,
  markdownPath: Schema.NonEmptyString,
  notes: Schema.Array(Schema.NonEmptyString),
  preferredLane: Schema.optionalKey(FactoryLaneScorecardPreferredLane),
  recommendationSummary: Schema.NonEmptyString,
  runId: RunIdSchema,
  version: Schema.Literal(1),
}) {}

export const parseFactoryLaneScorecard =
  Schema.decodeUnknownSync(FactoryLaneScorecard);
export const parseFactoryLaneScorecardLane = Schema.decodeUnknownSync(
  FactoryLaneScorecardLane
);
