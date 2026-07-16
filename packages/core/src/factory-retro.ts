import * as Schema from "effect/Schema";

import {
  EvidencePromotionCleanupStatusSchema,
  EvidencePromotionStatusSchema,
  PromotedEvidenceItem,
} from "./evidence-promotion.js";
import { RunReportArtifactPathSchema } from "./report.js";
import { RunIdSchema } from "./run-id.js";

export const FactoryRetroEntrySourceSchema = Schema.Literals([
  "observed",
  "inferred",
  "operator-note",
] as const);

/** Distinguishes observed run evidence from inferred or operator-supplied notes. */
export type FactoryRetroEntrySource = typeof FactoryRetroEntrySourceSchema.Type;

export class FactoryRetroEntry extends Schema.Class<FactoryRetroEntry>(
  "FactoryRetroEntry"
)({
  artifactPath: Schema.optionalKey(Schema.NonEmptyString),
  source: FactoryRetroEntrySourceSchema,
  summary: Schema.NonEmptyString,
}) {}

export class FactoryRetroSourceLink extends Schema.Class<FactoryRetroSourceLink>(
  "FactoryRetroSourceLink"
)({
  artifactPath: Schema.optionalKey(Schema.NonEmptyString),
  label: Schema.NonEmptyString,
  url: Schema.optionalKey(Schema.String),
}) {}

const FactoryRetroFields = {
  artifactPath: RunReportArtifactPathSchema,
  cleanupStatus: EvidencePromotionCleanupStatusSchema,
  generatedAt: Schema.NonEmptyString,
  helped: Schema.Array(FactoryRetroEntry),
  markdown: Schema.NonEmptyString,
  markdownPath: RunReportArtifactPathSchema,
  missed: Schema.Array(FactoryRetroEntry),
  misled: Schema.Array(FactoryRetroEntry),
  promotedEvidence: Schema.Array(PromotedEvidenceItem),
  promotionStatus: EvidencePromotionStatusSchema,
  recommendedNextFactoryImprovement: Schema.NonEmptyString,
  runId: RunIdSchema,
  sourceLinks: Schema.Array(FactoryRetroSourceLink),
  status: Schema.Literals(["clean", "findings"] as const),
  version: Schema.Literal(1),
};

const MakeFactoryRetroInputSchema = Schema.Struct({
  ...FactoryRetroFields,
  artifactPath: Schema.toEncoded(RunReportArtifactPathSchema),
  markdownPath: Schema.toEncoded(RunReportArtifactPathSchema),
});

/** Copy-ready dogfood retrospective shaped for operator handoff. */
export class FactoryRetro extends Schema.Class<FactoryRetro>("FactoryRetro")(
  FactoryRetroFields
) {
  /** Decode raw retrospective fields into a schema-owned factory retro. */
  static override make(
    input: Schema.Schema.Type<typeof MakeFactoryRetroInputSchema>,
    options?: Schema.MakeOptions
  ): FactoryRetro {
    if (options?.disableChecks === true) {
      return new FactoryRetro(
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
    return parseFactoryRetro(input, options?.parseOptions);
  }
}

export const parseFactoryRetro = Schema.decodeUnknownSync(FactoryRetro);
