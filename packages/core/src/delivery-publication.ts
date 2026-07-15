import { Schema } from "effect";

import {
  DeliveryBranchNamePublicSchema,
  DeliveryCommitMessagePublicSchema,
  DeliveryGitObjectIdPublicSchema,
  DeliveryGitShaPublicSchema,
  DeliveryOperationIdPublicSchema,
  DeliveryPositiveIntegerSchema,
  DeliveryOwnedBranchNamePublicSchema,
  DeliverySha256DigestPublicSchema,
  DeliverySourcePathPublicSchema,
  DeliveryTimestampPublicSchema,
  GitHubPullRequestUrlPublicSchema,
} from "./delivery-identity.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

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
  baseBranch: DeliveryBranchNamePublicSchema,
  baseRevision: DeliveryGitShaPublicSchema,
  branchName: DeliveryOwnedBranchNamePublicSchema,
  commitMessage: DeliveryCommitMessagePublicSchema,
  commitTimestamp: DeliveryTimestampPublicSchema,
  digestVersion: Schema.Literal(1),
  operationId: DeliveryOperationIdPublicSchema,
  payloadDigest: DeliverySha256DigestPublicSchema,
  sourcePaths: Schema.Array(DeliverySourcePathPublicSchema).pipe(
    Schema.check(Schema.isMaxLength(2_000))
  ),
  treeSha: Schema.optionalKey(DeliveryGitObjectIdPublicSchema),
} as const;

const publicationAttemptFields = {
  ...publicationIntentFields,
  commitSha: DeliveryGitShaPublicSchema,
  treeSha: DeliveryGitObjectIdPublicSchema,
} as const;

/** Durable publication intent recorded before local git mutation. */
export class DeliveryPublicationIntent extends Schema.Class<DeliveryPublicationIntent>(
  "DeliveryPublicationIntent"
)(
  {
    ...publicationIntentFields,
    state: Schema.Literal("intentRecorded"),
  },
  strict
) {}

/** Durable publication attempt recorded before remote mutation. */
export class DeliveryPublicationAttempted extends Schema.Class<DeliveryPublicationAttempted>(
  "DeliveryPublicationAttempted"
)(
  {
    ...publicationAttemptFields,
    state: Schema.Literal("attempted"),
  },
  strict
) {}

/** Confirmed owned draft pull request identity. */
export class DeliveryPublicationConfirmed extends Schema.Class<DeliveryPublicationConfirmed>(
  "DeliveryPublicationConfirmed"
)(
  {
    ...publicationAttemptFields,
    draft: Schema.Literal(true),
    headSha: DeliveryGitShaPublicSchema,
    prNumber: DeliveryPositiveIntegerSchema,
    prUrl: GitHubPullRequestUrlPublicSchema,
    state: Schema.Literal("confirmed"),
  },
  strict
) {}

const publicationFailureFields = {
  ...publicationIntentFields,
  code: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(160))),
  commitSha: Schema.optionalKey(DeliveryGitShaPublicSchema),
  message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1_024))),
  recoverable: Schema.Boolean,
  step: DeliveryPublicationFailureStepSchema,
  treeSha: Schema.optionalKey(DeliveryGitObjectIdPublicSchema),
} as const;

/** Definitive publication failure with no ambiguous external outcome. */
export class DeliveryPublicationFailed extends Schema.Class<DeliveryPublicationFailed>(
  "DeliveryPublicationFailed"
)(
  {
    ...publicationFailureFields,
    state: Schema.Literal("failed"),
  },
  strict
) {}

/** Publication attempt whose external outcome cannot yet be proven. */
export class DeliveryPublicationOutcomeUnknown extends Schema.Class<DeliveryPublicationOutcomeUnknown>(
  "DeliveryPublicationOutcomeUnknown"
)(
  {
    ...publicationFailureFields,
    state: Schema.Literal("outcomeUnknown"),
  },
  strict
) {}

export const DeliveryPublicationSchema = Schema.Union([
  DeliveryPublicationIntent,
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationFailed,
  DeliveryPublicationOutcomeUnknown,
] as const);

/** Durable finite publication state reconstructed from Gaia events. */
export type DeliveryPublication =
  | typeof DeliveryPublicationIntent.Type
  | typeof DeliveryPublicationAttempted.Type
  | typeof DeliveryPublicationConfirmed.Type
  | typeof DeliveryPublicationFailed.Type
  | typeof DeliveryPublicationOutcomeUnknown.Type;

/** Parse an untrusted persisted publication payload. */
export const parseDeliveryPublication = Schema.decodeUnknownSync(
  DeliveryPublicationSchema
);

const DeliveryPublicationJson = Schema.toCodecJson(DeliveryPublicationSchema);

/** Encode publication state as a plain JSON value for run snapshots. */
export const encodeDeliveryPublicationJson = Schema.encodeSync(
  DeliveryPublicationJson
);
