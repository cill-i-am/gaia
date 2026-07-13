import * as Schema from "effect/Schema";

import { RunIdSchema } from "./run-id.js";

const PositiveIntegerSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1)
);

const NonNegativeIntegerSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
);

export const DogfoodFindingCategorySchema = Schema.Literals([
  "boundary-contract",
  "evidence-noise",
  "observability",
  "operator-workflow",
  "plan-quality",
  "verification",
] as const);

/** Normalized category for a Gaia dogfood finding. */
export type DogfoodFindingCategory = typeof DogfoodFindingCategorySchema.Type;

export const DogfoodFindingSeveritySchema = Schema.Literals([
  "info",
  "warning",
  "blocker",
] as const);

/** Operator impact of a Gaia dogfood finding. */
export type DogfoodFindingSeverity = typeof DogfoodFindingSeveritySchema.Type;

export class DogfoodFindingSource extends Schema.Class<DogfoodFindingSource>(
  "DogfoodFindingSource"
)({
  artifactPath: Schema.optionalKey(Schema.NonEmptyString),
  eventType: Schema.optionalKey(Schema.NonEmptyString),
  label: Schema.NonEmptyString,
  pullRequest: Schema.optionalKey(Schema.String),
  runId: RunIdSchema,
  url: Schema.optionalKey(Schema.String),
}) {}

export class LinearCandidateIssue extends Schema.Class<LinearCandidateIssue>(
  "LinearCandidateIssue"
)({
  acceptanceCriteria: Schema.Array(Schema.NonEmptyString),
  bodyMarkdown: Schema.NonEmptyString,
  category: DogfoodFindingCategorySchema,
  goal: Schema.NonEmptyString,
  sourceEvidence: Schema.Array(DogfoodFindingSource),
  title: Schema.NonEmptyString,
}) {}

export class DogfoodFinding extends Schema.Class<DogfoodFinding>(
  "DogfoodFinding"
)({
  category: DogfoodFindingCategorySchema,
  candidateIssue: Schema.optionalKey(LinearCandidateIssue),
  occurrenceCount: PositiveIntegerSchema,
  lesson: Schema.NonEmptyString,
  severity: DogfoodFindingSeveritySchema,
  sources: Schema.Array(DogfoodFindingSource),
  summary: Schema.NonEmptyString,
}) {}

export class DogfoodRetrospective extends Schema.Class<DogfoodRetrospective>(
  "DogfoodRetrospective"
)({
  artifactPath: Schema.NonEmptyString,
  candidateIssueCount: NonNegativeIntegerSchema,
  generatedAt: Schema.NonEmptyString,
  highSignalFindingCount: NonNegativeIntegerSchema,
  findings: Schema.Array(DogfoodFinding),
  lessons: Schema.Array(Schema.NonEmptyString),
  linearCandidates: Schema.Array(LinearCandidateIssue),
  runId: RunIdSchema,
  sourceArtifactPaths: Schema.Array(Schema.NonEmptyString),
  status: Schema.Literals(["clean", "findings"] as const),
  summary: Schema.NonEmptyString,
  version: Schema.Literal(1),
}) {}

export const parseDogfoodRetrospective =
  Schema.decodeUnknownSync(DogfoodRetrospective);
