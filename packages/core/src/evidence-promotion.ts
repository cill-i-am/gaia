import * as Schema from "effect/Schema";

import {
  DeliveryGitShaPublicSchema,
  DeliveryGitShaSchema,
  GitHubChecksStatusSchema,
  GitHubPrFeedbackStatusSchema,
  GitHubPullRequestSelectorPublicSchema,
  GitHubPullRequestSelectorSchema,
  GitHubPullRequestUrlPublicSchema,
  GitHubPullRequestUrlSchema,
} from "./delivery-identity.js";
import { RunReportArtifactPathSchema } from "./report.js";
import { DogfoodRetrospective } from "./retrospective.js";
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

const EvidencePromotionVerificationStatusSchema = Schema.Literals([
  "passed",
  "skipped",
] as const);
const parseEvidencePromotionVerificationStatus = Schema.decodeUnknownSync(
  EvidencePromotionVerificationStatusSchema
);

const EvidencePromotionDogfoodStatusSchema = Schema.Union([
  DogfoodRetrospective.fields.status,
  Schema.Literal("skipped"),
]);
const parseEvidencePromotionDogfoodStatus = Schema.decodeUnknownSync(
  EvidencePromotionDogfoodStatusSchema
);
const parseEvidencePromotionChecksStatus = Schema.decodeUnknownSync(
  GitHubChecksStatusSchema
);
const parseEvidencePromotionFeedbackStatus = Schema.decodeUnknownSync(
  GitHubPrFeedbackStatusSchema
);

const PromotedEvidenceItemFields = {
  label: Schema.NonEmptyString,
  path: Schema.optionalKey(RunReportArtifactPathSchema.schema),
  status: EvidencePromotionStatusSchema,
  summary: Schema.NonEmptyString,
};

const PromotedEvidenceItemInputSchema = Schema.Struct(
  PromotedEvidenceItemFields
);

export class PromotedEvidenceItem extends Schema.Class<PromotedEvidenceItem>(
  "PromotedEvidenceItem"
)(PromotedEvidenceItemFields) {
  declare readonly path?: typeof RunReportArtifactPathSchema.Type;

  constructor(
    input: Schema.Schema.Type<typeof PromotedEvidenceItemInputSchema>,
    options?: Schema.MakeOptions
  ) {
    super(
      {
        ...input,
        ...(input.path === undefined
          ? {}
          : { path: RunReportArtifactPathSchema.make(input.path, options) }),
      },
      options
    );
  }
}

const EvidencePromotionReportPathsFields = {
  dogfoodRetrospectivePath: Schema.optionalKey(
    RunReportArtifactPathSchema.schema
  ),
  reportJsonPath: Schema.optionalKey(RunReportArtifactPathSchema.schema),
  reportMarkdownPath: Schema.optionalKey(RunReportArtifactPathSchema.schema),
  workerPlanPath: Schema.optionalKey(RunReportArtifactPathSchema.schema),
};

const EvidencePromotionReportPathsInputSchema = Schema.Struct(
  EvidencePromotionReportPathsFields
);

export class EvidencePromotionReportPaths extends Schema.Class<EvidencePromotionReportPaths>(
  "EvidencePromotionReportPaths"
)(EvidencePromotionReportPathsFields) {
  declare readonly dogfoodRetrospectivePath?: typeof RunReportArtifactPathSchema.Type;
  declare readonly reportJsonPath?: typeof RunReportArtifactPathSchema.Type;
  declare readonly reportMarkdownPath?: typeof RunReportArtifactPathSchema.Type;
  declare readonly workerPlanPath?: typeof RunReportArtifactPathSchema.Type;

  constructor(
    input: Schema.Schema.Type<
      typeof EvidencePromotionReportPathsInputSchema
    > = {},
    options?: Schema.MakeOptions
  ) {
    super(
      {
        ...(input.dogfoodRetrospectivePath === undefined
          ? {}
          : {
              dogfoodRetrospectivePath: RunReportArtifactPathSchema.make(
                input.dogfoodRetrospectivePath,
                options
              ),
            }),
        ...(input.reportJsonPath === undefined
          ? {}
          : {
              reportJsonPath: RunReportArtifactPathSchema.make(
                input.reportJsonPath,
                options
              ),
            }),
        ...(input.reportMarkdownPath === undefined
          ? {}
          : {
              reportMarkdownPath: RunReportArtifactPathSchema.make(
                input.reportMarkdownPath,
                options
              ),
            }),
        ...(input.workerPlanPath === undefined
          ? {}
          : {
              workerPlanPath: RunReportArtifactPathSchema.make(
                input.workerPlanPath,
                options
              ),
            }),
      },
      options
    );
  }
}

const EvidencePromotionVerificationSummaryFields = {
  checkedArtifacts: Schema.Array(RunReportArtifactPathSchema.schema),
  path: Schema.optionalKey(RunReportArtifactPathSchema.schema),
  status: Schema.NonEmptyString,
};

const EvidencePromotionVerificationSummaryInputSchema = Schema.Struct(
  EvidencePromotionVerificationSummaryFields
);

export class EvidencePromotionVerificationSummary extends Schema.Class<EvidencePromotionVerificationSummary>(
  "EvidencePromotionVerificationSummary"
)(EvidencePromotionVerificationSummaryFields) {
  declare readonly checkedArtifacts: ReadonlyArray<
    typeof RunReportArtifactPathSchema.Type
  >;
  declare readonly path?: typeof RunReportArtifactPathSchema.Type;
  declare readonly status: typeof EvidencePromotionVerificationStatusSchema.Type;

  constructor(
    input: Schema.Schema.Type<
      typeof EvidencePromotionVerificationSummaryInputSchema
    >,
    options?: Schema.MakeOptions
  ) {
    super(
      {
        checkedArtifacts: input.checkedArtifacts.map((artifactPath) =>
          RunReportArtifactPathSchema.make(artifactPath, options)
        ),
        ...(input.path === undefined
          ? {}
          : {
              path: RunReportArtifactPathSchema.make(input.path, options),
            }),
        status: parseEvidencePromotionVerificationStatus(input.status),
      },
      options
    );
  }
}

const EvidencePromotionPullRequestSummaryFields = {
  artifactPaths: Schema.Array(RunReportArtifactPathSchema.schema),
  checksStatus: Schema.optionalKey(Schema.NonEmptyString),
  feedbackStatus: Schema.optionalKey(Schema.NonEmptyString),
  headSha: Schema.optionalKey(DeliveryGitShaPublicSchema),
  pr: Schema.optionalKey(GitHubPullRequestSelectorPublicSchema),
  status: EvidencePromotionStatusSchema,
  summary: Schema.NonEmptyString,
  url: Schema.optionalKey(GitHubPullRequestUrlPublicSchema),
};

const EvidencePromotionPullRequestSummaryInputSchema = Schema.Struct(
  EvidencePromotionPullRequestSummaryFields
);

export class EvidencePromotionPullRequestSummary extends Schema.Class<EvidencePromotionPullRequestSummary>(
  "EvidencePromotionPullRequestSummary"
)(EvidencePromotionPullRequestSummaryFields) {
  declare readonly artifactPaths: ReadonlyArray<
    typeof RunReportArtifactPathSchema.Type
  >;
  declare readonly checksStatus?: typeof GitHubChecksStatusSchema.Type;
  declare readonly feedbackStatus?: typeof GitHubPrFeedbackStatusSchema.Type;
  declare readonly headSha?: typeof DeliveryGitShaSchema.Type;
  declare readonly pr?: typeof GitHubPullRequestSelectorSchema.Type;
  declare readonly url?: typeof GitHubPullRequestUrlSchema.Type;

  constructor(
    input: Schema.Schema.Type<
      typeof EvidencePromotionPullRequestSummaryInputSchema
    >,
    options?: Schema.MakeOptions
  ) {
    super(
      {
        artifactPaths: input.artifactPaths.map((artifactPath) =>
          RunReportArtifactPathSchema.make(artifactPath, options)
        ),
        ...(input.checksStatus === undefined
          ? {}
          : {
              checksStatus: parseEvidencePromotionChecksStatus(
                input.checksStatus
              ),
            }),
        ...(input.feedbackStatus === undefined
          ? {}
          : {
              feedbackStatus: parseEvidencePromotionFeedbackStatus(
                input.feedbackStatus
              ),
            }),
        ...(input.headSha === undefined
          ? {}
          : {
              headSha: DeliveryGitShaSchema.make(input.headSha, options),
            }),
        ...(input.pr === undefined
          ? {}
          : {
              pr: GitHubPullRequestSelectorSchema.make(input.pr, options),
            }),
        status: input.status,
        summary: input.summary,
        ...(input.url === undefined
          ? {}
          : {
              url: GitHubPullRequestUrlSchema.make(input.url, options),
            }),
      },
      options
    );
  }
}

const EvidencePromotionDogfoodSummaryFields = {
  artifactPath: Schema.optionalKey(RunReportArtifactPathSchema.schema),
  findingCount: NonNegativeIntegerSchema,
  status: Schema.NonEmptyString,
  summary: Schema.NonEmptyString,
};

const EvidencePromotionDogfoodSummaryInputSchema = Schema.Struct(
  EvidencePromotionDogfoodSummaryFields
);

export class EvidencePromotionDogfoodSummary extends Schema.Class<EvidencePromotionDogfoodSummary>(
  "EvidencePromotionDogfoodSummary"
)(EvidencePromotionDogfoodSummaryFields) {
  declare readonly artifactPath?: typeof RunReportArtifactPathSchema.Type;
  declare readonly status: typeof EvidencePromotionDogfoodStatusSchema.Type;

  constructor(
    input: Schema.Schema.Type<
      typeof EvidencePromotionDogfoodSummaryInputSchema
    >,
    options?: Schema.MakeOptions
  ) {
    super(
      {
        ...(input.artifactPath === undefined
          ? {}
          : {
              artifactPath: RunReportArtifactPathSchema.make(
                input.artifactPath,
                options
              ),
            }),
        findingCount: input.findingCount,
        status: parseEvidencePromotionDogfoodStatus(input.status),
        summary: input.summary,
      },
      options
    );
  }
}

const EvidencePromotionFields = {
  artifactPath: RunReportArtifactPathSchema,
  cleanupStatus: EvidencePromotionCleanupStatusSchema,
  dogfood: EvidencePromotionDogfoodSummary,
  generatedAt: Schema.NonEmptyString,
  markdown: Schema.NonEmptyString,
  markdownPath: RunReportArtifactPathSchema,
  promotionStatus: EvidencePromotionStatusSchema,
  pullRequest: EvidencePromotionPullRequestSummary,
  reportPaths: EvidencePromotionReportPaths,
  runId: RunIdSchema,
  selectedEvidence: Schema.Array(PromotedEvidenceItem),
  verification: EvidencePromotionVerificationSummary,
  version: Schema.Literal(1),
};

const MakeEvidencePromotionInputSchema = Schema.Struct({
  ...EvidencePromotionFields,
  artifactPath: Schema.toEncoded(RunReportArtifactPathSchema),
  markdownPath: Schema.toEncoded(RunReportArtifactPathSchema),
});

/** JSON-safe selected evidence summary intended for Linear or PR text. */
export class EvidencePromotion extends Schema.Class<EvidencePromotion>(
  "EvidencePromotion"
)(EvidencePromotionFields) {
  /** Decode raw promotion fields into a schema-owned evidence value. */
  static override make(
    input: Schema.Schema.Type<typeof MakeEvidencePromotionInputSchema>,
    options?: Schema.MakeOptions
  ): EvidencePromotion {
    if (options?.disableChecks === true) {
      return new EvidencePromotion(
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
    return parseEvidencePromotion(input, options?.parseOptions);
  }
}

export const parseEvidencePromotion =
  Schema.decodeUnknownSync(EvidencePromotion);
