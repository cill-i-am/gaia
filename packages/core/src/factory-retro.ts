import * as Schema from "effect/Schema";

import {
  EvidencePromotionCleanupStatusSchema,
  EvidencePromotionStatusSchema,
  PromotedEvidenceItem,
} from "./evidence-promotion.js";
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

/** Copy-ready dogfood retrospective shaped for operator handoff. */
export class FactoryRetro extends Schema.Class<FactoryRetro>("FactoryRetro")({
  artifactPath: Schema.NonEmptyString,
  cleanupStatus: EvidencePromotionCleanupStatusSchema,
  generatedAt: Schema.NonEmptyString,
  helped: Schema.Array(FactoryRetroEntry),
  markdown: Schema.NonEmptyString,
  markdownPath: Schema.NonEmptyString,
  missed: Schema.Array(FactoryRetroEntry),
  misled: Schema.Array(FactoryRetroEntry),
  promotedEvidence: Schema.Array(PromotedEvidenceItem),
  promotionStatus: EvidencePromotionStatusSchema,
  recommendedNextFactoryImprovement: Schema.NonEmptyString,
  runId: RunIdSchema,
  sourceLinks: Schema.Array(FactoryRetroSourceLink),
  status: Schema.Literals(["clean", "findings"] as const),
  version: Schema.Literal(1),
}) {}

export const parseFactoryRetro = Schema.decodeUnknownSync(FactoryRetro);
