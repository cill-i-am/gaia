import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
);
const GitShaSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
);
const OperationIdSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9:_-]+$/u)),
  Schema.check(Schema.isMaxLength(160)),
);
const SafePathSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(1_024)),
  Schema.check(
    Schema.makeFilter((path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/[\u0000-\u001f\u007f]/u.test(path) &&
      path.split("/").every(
        (segment) => segment.length > 0 && segment !== "." && segment !== "..",
      )
    ),
  ),
);
const CommitMessageSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(240)),
  Schema.check(Schema.isPattern(/^[^\r\n]+$/u)),
);
const TimestampSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  ),
);
const PullRequestUrlSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*$/u,
    ),
  ),
);
const PositiveIntegerSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
);

export const DeliveryPublicationStateSchema = Schema.Literals([
  "intentRecorded",
  "attempted",
  "confirmed",
  "failed",
  "outcomeUnknown",
] as const);

export const DeliveryPublicationFailureStepSchema = Schema.Literals([
  "validation",
  "commit",
  "push",
  "pullRequest",
  "reconciliation",
] as const);

const publicationIntentFields = {
  baseBranch: Schema.NonEmptyString,
  baseRevision: GitShaSchema,
  branchName: Schema.NonEmptyString,
  commitMessage: CommitMessageSchema,
  commitTimestamp: TimestampSchema,
  digestVersion: Schema.Literal(1),
  operationId: OperationIdSchema,
  payloadDigest: DigestSchema,
  sourcePaths: Schema.Array(SafePathSchema).pipe(
    Schema.check(Schema.isMaxLength(2_000)),
  ),
  treeSha: Schema.optionalKey(GitShaSchema),
} as const;

const publicationAttemptFields = {
  ...publicationIntentFields,
  commitSha: GitShaSchema,
  treeSha: GitShaSchema,
} as const;

/** Durable publication intent recorded before local git mutation. */
export class DeliveryPublicationIntent extends Schema.Class<DeliveryPublicationIntent>(
  "DeliveryPublicationIntent",
)({
  ...publicationIntentFields,
  state: Schema.Literal("intentRecorded"),
}, strict) {}

/** Durable publication attempt recorded before remote mutation. */
export class DeliveryPublicationAttempted extends Schema.Class<DeliveryPublicationAttempted>(
  "DeliveryPublicationAttempted",
)({
  ...publicationAttemptFields,
  state: Schema.Literal("attempted"),
}, strict) {}

/** Confirmed owned draft pull request identity. */
export class DeliveryPublicationConfirmed extends Schema.Class<DeliveryPublicationConfirmed>(
  "DeliveryPublicationConfirmed",
)({
  ...publicationAttemptFields,
  draft: Schema.Literal(true),
  headSha: GitShaSchema,
  prNumber: PositiveIntegerSchema,
  prUrl: PullRequestUrlSchema,
  state: Schema.Literal("confirmed"),
}, strict) {}

const publicationFailureFields = {
  ...publicationIntentFields,
  code: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(160))),
  commitSha: Schema.optionalKey(GitShaSchema),
  message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1_024))),
  recoverable: Schema.Boolean,
  step: DeliveryPublicationFailureStepSchema,
  treeSha: Schema.optionalKey(GitShaSchema),
} as const;

/** Definitive publication failure with no ambiguous external outcome. */
export class DeliveryPublicationFailed extends Schema.Class<DeliveryPublicationFailed>(
  "DeliveryPublicationFailed",
)({
  ...publicationFailureFields,
  state: Schema.Literal("failed"),
}, strict) {}

/** Publication attempt whose external outcome cannot yet be proven. */
export class DeliveryPublicationOutcomeUnknown extends Schema.Class<DeliveryPublicationOutcomeUnknown>(
  "DeliveryPublicationOutcomeUnknown",
)({
  ...publicationFailureFields,
  state: Schema.Literal("outcomeUnknown"),
}, strict) {}

export const DeliveryPublicationSchema = Schema.Union([
  DeliveryPublicationIntent,
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationFailed,
  DeliveryPublicationOutcomeUnknown,
]);

/** Durable finite publication state reconstructed from Gaia events. */
export type DeliveryPublication = typeof DeliveryPublicationSchema.Type;

/** Parse an untrusted persisted publication payload. */
export const parseDeliveryPublication = Schema.decodeUnknownSync(
  DeliveryPublicationSchema,
);

const DeliveryPublicationJson = Schema.toCodecJson(DeliveryPublicationSchema);

/** Encode publication state as a plain JSON value for run snapshots. */
export const encodeDeliveryPublicationJson = Schema.encodeSync(
  DeliveryPublicationJson,
);
