import * as Schema from "effect/Schema";

import { FactoryLaneRoleSchema } from "./factory-delegation.js";
import { RunReportArtifactPathSchema } from "./report.js";
import { RunIdSchema } from "./run-id.js";

const FactoryLaneScorecardCommandSchema = Schema.NonEmptyString.pipe(
  Schema.brand("FactoryLaneScorecardCommand")
);
const FactoryLaneScorecardLaneIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("FactoryLaneScorecardLaneId")
);

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

const FactoryLaneScorecardVerificationEvidenceFields = {
  command: FactoryLaneScorecardCommandSchema,
  path: Schema.optionalKey(Schema.NonEmptyString),
  result: Schema.NonEmptyString,
};

const MakeFactoryLaneScorecardVerificationEvidenceInputSchema = Schema.Struct({
  ...FactoryLaneScorecardVerificationEvidenceFields,
  command: Schema.toEncoded(FactoryLaneScorecardCommandSchema),
});

export class FactoryLaneScorecardVerificationEvidence extends Schema.Class<FactoryLaneScorecardVerificationEvidence>(
  "FactoryLaneScorecardVerificationEvidence"
)(FactoryLaneScorecardVerificationEvidenceFields) {
  /** Decode raw verification fields into schema-owned scorecard evidence. */
  static override make(
    input: Schema.Schema.Type<
      typeof MakeFactoryLaneScorecardVerificationEvidenceInputSchema
    >,
    options?: Schema.MakeOptions
  ): FactoryLaneScorecardVerificationEvidence {
    if (options?.disableChecks === true) {
      return new FactoryLaneScorecardVerificationEvidence(
        {
          ...input,
          command: FactoryLaneScorecardCommandSchema.make(
            input.command,
            options
          ),
        },
        options
      );
    }
    return parseFactoryLaneScorecardVerificationEvidence(
      input,
      options?.parseOptions
    );
  }
}

const parseFactoryLaneScorecardVerificationEvidence = Schema.decodeUnknownSync(
  FactoryLaneScorecardVerificationEvidence
);

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

const FactoryLaneScorecardLaneFields = {
  checkStatus: FactoryLaneScorecardCheckStatusSchema,
  comparisonWaitStatus: FactoryLaneScorecardComparisonWaitStatusSchema,
  criteria: Schema.Array(FactoryLaneScorecardCriterionAssessment),
  factoryLearningSignal: FactoryLaneScorecardFactoryLearningSignal,
  headSha: Schema.optionalKey(Schema.NonEmptyString),
  implementationAcceptance: FactoryLaneScorecardImplementationAcceptance,
  label: Schema.NonEmptyString,
  laneId: FactoryLaneScorecardLaneIdSchema,
  localVerification: Schema.Array(FactoryLaneScorecardVerificationEvidence),
  pullRequest: Schema.optionalKey(Schema.NonEmptyString),
  role: FactoryLaneRoleSchema,
  sourceLinks: Schema.Array(FactoryLaneScorecardSourceLink),
  tradeoffs: Schema.Array(Schema.NonEmptyString),
};

const MakeFactoryLaneScorecardLaneInputSchema = Schema.Struct({
  ...FactoryLaneScorecardLaneFields,
  laneId: Schema.toEncoded(FactoryLaneScorecardLaneIdSchema),
});

export class FactoryLaneScorecardLane extends Schema.Class<FactoryLaneScorecardLane>(
  "FactoryLaneScorecardLane"
)(FactoryLaneScorecardLaneFields) {
  /** Decode raw lane fields into a schema-owned scorecard lane. */
  static override make(
    input: Schema.Schema.Type<typeof MakeFactoryLaneScorecardLaneInputSchema>,
    options?: Schema.MakeOptions
  ): FactoryLaneScorecardLane {
    if (options?.disableChecks === true) {
      return new FactoryLaneScorecardLane(
        {
          ...input,
          laneId: FactoryLaneScorecardLaneIdSchema.make(input.laneId, options),
        },
        options
      );
    }
    return parseFactoryLaneScorecardLane(input, options?.parseOptions);
  }
}

const FactoryLaneScorecardPreferredLaneFields = {
  laneId: FactoryLaneScorecardLaneIdSchema,
  rationale: Schema.NonEmptyString,
  tradeoffsPreserved: Schema.Array(Schema.NonEmptyString),
};

const MakeFactoryLaneScorecardPreferredLaneInputSchema = Schema.Struct({
  ...FactoryLaneScorecardPreferredLaneFields,
  laneId: Schema.toEncoded(FactoryLaneScorecardLaneIdSchema),
});

export class FactoryLaneScorecardPreferredLane extends Schema.Class<FactoryLaneScorecardPreferredLane>(
  "FactoryLaneScorecardPreferredLane"
)(FactoryLaneScorecardPreferredLaneFields) {
  /** Decode raw recommendation fields into a schema-owned preferred lane. */
  static override make(
    input: Schema.Schema.Type<
      typeof MakeFactoryLaneScorecardPreferredLaneInputSchema
    >,
    options?: Schema.MakeOptions
  ): FactoryLaneScorecardPreferredLane {
    if (options?.disableChecks === true) {
      return new FactoryLaneScorecardPreferredLane(
        {
          ...input,
          laneId: FactoryLaneScorecardLaneIdSchema.make(input.laneId, options),
        },
        options
      );
    }
    return parseFactoryLaneScorecardPreferredLane(input, options?.parseOptions);
  }
}

const parseFactoryLaneScorecardPreferredLane = Schema.decodeUnknownSync(
  FactoryLaneScorecardPreferredLane
);

const FactoryLaneScorecardFields = {
  artifactPath: RunReportArtifactPathSchema,
  comparisonSummary: Schema.NonEmptyString,
  generatedAt: Schema.NonEmptyString,
  lanes: Schema.Array(FactoryLaneScorecardLane),
  markdown: Schema.NonEmptyString,
  markdownPath: RunReportArtifactPathSchema,
  notes: Schema.Array(Schema.NonEmptyString),
  preferredLane: Schema.optionalKey(FactoryLaneScorecardPreferredLane),
  recommendationSummary: Schema.NonEmptyString,
  runId: RunIdSchema,
  version: Schema.Literal(1),
};

const MakeFactoryLaneScorecardInputSchema = Schema.Struct({
  ...FactoryLaneScorecardFields,
  artifactPath: Schema.toEncoded(RunReportArtifactPathSchema),
  markdownPath: Schema.toEncoded(RunReportArtifactPathSchema),
});

/** Inspectable A/B lane comparison artifact for orchestrator decisions. */
export class FactoryLaneScorecard extends Schema.Class<FactoryLaneScorecard>(
  "FactoryLaneScorecard"
)(FactoryLaneScorecardFields) {
  /** Decode raw scorecard fields into a schema-owned comparison artifact. */
  static override make(
    input: Schema.Schema.Type<typeof MakeFactoryLaneScorecardInputSchema>,
    options?: Schema.MakeOptions
  ): FactoryLaneScorecard {
    if (options?.disableChecks === true) {
      return new FactoryLaneScorecard(
        {
          ...input,
          artifactPath: RunReportArtifactPathSchema.make(
            input.artifactPath,
            options
          ),
          markdownPath: RunReportArtifactPathSchema.make(
            input.markdownPath,
            options
          ),
        },
        options
      );
    }
    return parseFactoryLaneScorecard(input, options?.parseOptions);
  }
}

export const parseFactoryLaneScorecard =
  Schema.decodeUnknownSync(FactoryLaneScorecard);
export const parseFactoryLaneScorecardLane = Schema.decodeUnknownSync(
  FactoryLaneScorecardLane
);
