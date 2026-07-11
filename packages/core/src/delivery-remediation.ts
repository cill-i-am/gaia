import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
);
const GitShaSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
);
const RepositorySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
  Schema.check(Schema.isMaxLength(200)),
);
const LoginSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u)),
);
const BoundedIdSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9:_-]+$/u)),
  Schema.check(Schema.isMaxLength(200)),
);
const AttemptSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.check(Schema.isLessThanOrEqualTo(2)),
);

/** Human-feedback trust classes carried from the GitHub boundary. */
export const DeliveryFeedbackClassificationSchema = Schema.Literals([
  "actionable",
  "informational",
  "untrusted",
] as const);

/** Human-feedback source classes normalized by Gaia. */
export const DeliveryFeedbackKindSchema = Schema.Literals([
  "comment",
  "review",
  "thread",
] as const);

/** Public opaque feedback identifier with no provider-native identity. */
export const DeliveryFeedbackIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^feedback-(?:check|comment|review|thread)-[a-f0-9]{64}$/u),
  ),
  Schema.brand("DeliveryFeedbackId"),
);

/** A parsed opaque feedback identifier. */
export type DeliveryFeedbackId = typeof DeliveryFeedbackIdSchema.Type;

/** Parse an untrusted public feedback identifier. */
export const parseDeliveryFeedbackId = Schema.decodeUnknownSync(
  DeliveryFeedbackIdSchema,
);

/** Exact hosted-check identity allowed to trigger source remediation. */
export class DeliveryTrustedCheckV1 extends Schema.Class<DeliveryTrustedCheckV1>(
  "DeliveryTrustedCheckV1",
)({
  appSlug: Schema.Literal("github-actions"),
  name: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
  repository: RepositorySchema,
  workflow: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
}, strict) {}

/** Immutable, server-owned actor and check policy for one delivery run. */
export class DeliveryFeedbackTrustPolicyV1 extends Schema.Class<DeliveryFeedbackTrustPolicyV1>(
  "DeliveryFeedbackTrustPolicyV1",
)({
  allowPullRequestAuthor: Schema.Boolean,
  requireApprovedReview: Schema.optionalKey(Schema.Boolean),
  trustedChecks: Schema.Array(DeliveryTrustedCheckV1).pipe(
    Schema.check(Schema.isMaxLength(20)),
  ),
  trustedHumanLogins: Schema.Array(LoginSchema).pipe(
    Schema.check(Schema.isMaxLength(20)),
  ),
  version: Schema.Literal(1),
}, strict) {}

/** Parse an untrusted persisted feedback trust policy. */
export const parseDeliveryFeedbackTrustPolicy = Schema.decodeUnknownSync(
  DeliveryFeedbackTrustPolicyV1,
);

/** Legacy policies are strict; only an explicitly persisted false relaxes approval. */
export function deliveryFeedbackRequiresApprovedReview(
  policy: DeliveryFeedbackTrustPolicyV1,
): boolean {
  return policy.requireApprovedReview !== false;
}

/** Finite normalized state for one hosted pull-request check. */
export const DeliveryCheckStateSchema = Schema.Literals([
  "failing",
  "passing",
  "pending",
] as const);

/** Privacy-safe hosted-check fact persisted in Gaia history. */
export class DeliveryCheckObservation extends Schema.Class<DeliveryCheckObservation>(
  "DeliveryCheckObservation",
)({
  appSlug: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(100))),
  classification: DeliveryFeedbackClassificationSchema,
  link: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(2_048)))),
  name: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
  state: DeliveryCheckStateSchema,
  workflow: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
}, strict) {}

/** Repository association supplied by GitHub for a feedback actor. */
export const DeliveryAuthorAssociationSchema = Schema.Literals([
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN",
  "MEMBER",
  "NONE",
  "OWNER",
] as const);

/** Privacy-safe feedback fact persisted without the untrusted review body. */
export class DeliveryFeedbackObservation extends Schema.Class<DeliveryFeedbackObservation>(
  "DeliveryFeedbackObservation",
)({
  actorLogin: Schema.optionalKey(LoginSchema),
  authorAssociation: Schema.optionalKey(DeliveryAuthorAssociationSchema),
  classification: DeliveryFeedbackClassificationSchema,
  contentDigest: DigestSchema,
  id: DeliveryFeedbackIdSchema,
  kind: DeliveryFeedbackKindSchema,
  path: Schema.optionalKey(
    Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1_024))),
  ),
  url: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(2_048))),
  ),
}, strict) {}

/** Finite delivery-loop blocker vocabulary exposed to server clients. */
export const DeliveryBlockerKindSchema = Schema.Literals([
  "actionableFeedback",
  "budgetExhausted",
  "draftPullRequest",
  "expectedHeadChanged",
  "failedCheck",
  "feedbackTruncated",
  "mergeConflict",
  "mergeabilityUnknown",
  "missingHostedChecks",
  "operatorReviewRequired",
  "pendingCheck",
  "providerUnavailable",
  "remediationOutcomeUnknown",
  "sessionUnavailable",
  "verificationFailed",
] as const);

/** One bounded operator-visible reason delivery cannot advance. */
export class DeliveryBlocker extends Schema.Class<DeliveryBlocker>(
  "DeliveryBlocker",
)({
  feedbackIds: Schema.Array(DeliveryFeedbackIdSchema).pipe(
    Schema.check(Schema.isMaxLength(20)),
  ),
  kind: DeliveryBlockerKindSchema,
  summary: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(500))),
}, strict) {}

/** Finite normalized pull-request observation state. */
export const DeliveryPullRequestStatusSchema = Schema.Literals([
  "blocked",
  "ready",
  "waiting",
] as const);

/** Authoritative, bounded, privacy-safe observation of one owned pull request. */
export class DeliveryPullRequestObservation extends Schema.Class<DeliveryPullRequestObservation>(
  "DeliveryPullRequestObservation",
)({
  blockers: Schema.Array(DeliveryBlocker).pipe(
    Schema.check(Schema.isMaxLength(100)),
  ),
  checks: Schema.Array(DeliveryCheckObservation).pipe(
    Schema.check(Schema.isMaxLength(100)),
  ),
  draft: Schema.Boolean,
  feedback: Schema.Array(DeliveryFeedbackObservation).pipe(
    Schema.check(Schema.isMaxLength(100)),
  ),
  headSha: GitShaSchema,
  mergeability: Schema.Literals(["conflicting", "mergeable", "unknown"] as const),
  observedAt: Schema.String.pipe(Schema.check(Schema.isMaxLength(100))),
  prNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  prUrl: Schema.String.pipe(Schema.check(Schema.isMaxLength(2_048))),
  repository: RepositorySchema,
  reviewDecision: Schema.optionalKey(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(100))),
  ),
  snapshotDigest: DigestSchema,
  status: DeliveryPullRequestStatusSchema,
  version: Schema.Literal(1),
}, strict) {}

/** Parse an untrusted persisted pull-request observation. */
export const parseDeliveryPullRequestObservation = Schema.decodeUnknownSync(
  DeliveryPullRequestObservation,
);

const DeliveryPullRequestObservationJson = Schema.toCodecJson(
  DeliveryPullRequestObservation,
);

/** Encode a pull-request observation as plain JSON for Gaia events. */
export const encodeDeliveryPullRequestObservationJson = Schema.encodeSync(
  DeliveryPullRequestObservationJson,
);

const remediationBindingFields = {
  activationActionDigest: Schema.optionalKey(DigestSchema),
  activationPredecessorDigest: Schema.optionalKey(DigestSchema),
  activationReceiptDigest: Schema.optionalKey(DigestSchema),
  attempt: AttemptSchema,
  authorizationDigest: Schema.optionalKey(DigestSchema),
  commitTimestamp: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u)),
  ),
  expectedHeadSha: GitShaSchema,
  feedbackDigest: DigestSchema,
  feedbackIds: Schema.Array(DeliveryFeedbackIdSchema).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(20)),
  ),
  inputId: BoundedIdSchema,
  operationId: BoundedIdSchema,
} as const;

/** Durable reservation before a remediation may resume or mutate a session. */
export class DeliveryRemediationIntent extends Schema.Class<DeliveryRemediationIntent>(
  "DeliveryRemediationIntent",
)({
  ...remediationBindingFields,
  state: Schema.Literal("intentRecorded"),
}, strict) {}

/** Durable receipt written before provider input dispatch. */
export class DeliveryRemediationDispatchAttempted extends Schema.Class<DeliveryRemediationDispatchAttempted>(
  "DeliveryRemediationDispatchAttempted",
)({
  ...remediationBindingFields,
  state: Schema.Literal("dispatchAttempted"),
}, strict) {}

/** Provider turn completed and is ready for Gaia-owned verification. */
export class DeliveryRemediationTurnCompleted extends Schema.Class<DeliveryRemediationTurnCompleted>(
  "DeliveryRemediationTurnCompleted",
)({
  ...remediationBindingFields,
  state: Schema.Literal("turnCompleted"),
}, strict) {}

/** Remediation diff passed the accepted run verification policy. */
export class DeliveryRemediationVerified extends Schema.Class<DeliveryRemediationVerified>(
  "DeliveryRemediationVerified",
)({
  ...remediationBindingFields,
  state: Schema.Literal("verified"),
}, strict) {}

/** Deterministic follow-up commit exists locally over the expected old head. */
export class DeliveryRemediationCommitAttempted extends Schema.Class<DeliveryRemediationCommitAttempted>(
  "DeliveryRemediationCommitAttempted",
)({
  ...remediationBindingFields,
  commitSha: GitShaSchema,
  state: Schema.Literal("commitAttempted"),
}, strict) {}

/** Durable receipt written before the lease-bound remote push. */
export class DeliveryRemediationPushAttempted extends Schema.Class<DeliveryRemediationPushAttempted>(
  "DeliveryRemediationPushAttempted",
)({
  ...remediationBindingFields,
  commitSha: GitShaSchema,
  state: Schema.Literal("pushAttempted"),
}, strict) {}

/** GitHub confirmed the owned pull request at the remediation commit. */
export class DeliveryRemediationConfirmed extends Schema.Class<DeliveryRemediationConfirmed>(
  "DeliveryRemediationConfirmed",
)({
  ...remediationBindingFields,
  commitSha: GitShaSchema,
  state: Schema.Literal("confirmed"),
}, strict) {}

const remediationFailureFields = {
  ...remediationBindingFields,
  code: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(160))),
  message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1_024))),
  recoverable: Schema.Boolean,
} as const;

/** Conclusive typed remediation failure. */
export class DeliveryRemediationFailed extends Schema.Class<DeliveryRemediationFailed>(
  "DeliveryRemediationFailed",
)({
  ...remediationFailureFields,
  state: Schema.Literal("failed"),
}, strict) {}

/** Remediation mutation whose external outcome cannot be proven. */
export class DeliveryRemediationOutcomeUnknown extends Schema.Class<DeliveryRemediationOutcomeUnknown>(
  "DeliveryRemediationOutcomeUnknown",
)({
  ...remediationFailureFields,
  state: Schema.Literal("outcomeUnknown"),
}, strict) {}

/** Finite durable remediation state reconstructed from Gaia events. */
export const DeliveryRemediationSchema = Schema.Union([
  DeliveryRemediationIntent,
  DeliveryRemediationDispatchAttempted,
  DeliveryRemediationTurnCompleted,
  DeliveryRemediationVerified,
  DeliveryRemediationCommitAttempted,
  DeliveryRemediationPushAttempted,
  DeliveryRemediationConfirmed,
  DeliveryRemediationFailed,
  DeliveryRemediationOutcomeUnknown,
]);

/** One decoded durable remediation receipt. */
export type DeliveryRemediation = typeof DeliveryRemediationSchema.Type;

/** Parse an untrusted persisted remediation receipt. */
export const parseDeliveryRemediation = Schema.decodeUnknownSync(
  DeliveryRemediationSchema,
);

const DeliveryRemediationJson = Schema.toCodecJson(DeliveryRemediationSchema);

/** Encode remediation state as plain JSON for run events and snapshots. */
export const encodeDeliveryRemediationJson = Schema.encodeSync(
  DeliveryRemediationJson,
);

/** Enforce operation binding, legal progression, and the two-attempt budget. */
export function validateDeliveryRemediationTransition(
  previous: DeliveryRemediation | undefined,
  next: DeliveryRemediation,
): void {
  if (previous === undefined) {
    if (next.state !== "intentRecorded" || next.attempt !== 1) {
      throw new Error("Remediation must begin with attempt-one intent.");
    }
    return;
  }

  if (next.state === "intentRecorded") {
    if (
      (previous.state !== "confirmed" && previous.state !== "failed") ||
      previous.state === "failed" && !previous.recoverable ||
      next.attempt !== previous.attempt + 1 ||
      next.operationId === previous.operationId ||
      next.inputId === previous.inputId ||
      (next.authorizationDigest !== undefined &&
        next.authorizationDigest === previous.authorizationDigest) ||
      previous.state === "confirmed" &&
        (next.expectedHeadSha !== previous.commitSha ||
          next.feedbackDigest === previous.feedbackDigest)
    ) {
      throw new Error("A new remediation attempt requires a terminal prior attempt.");
    }
    return;
  }

  if (!sameRemediationBinding(previous, next)) {
    throw new Error("Remediation operation changed its immutable binding.");
  }

  const expected = nextStates.get(previous.state);
  if (expected === undefined || !expected.has(next.state)) {
    throw new Error(`Illegal remediation transition: ${previous.state} -> ${next.state}.`);
  }
}

const nextStates = new Map<DeliveryRemediation["state"], ReadonlySet<DeliveryRemediation["state"]>>([
  ["intentRecorded", new Set(["dispatchAttempted", "failed"])],
  ["dispatchAttempted", new Set(["turnCompleted", "failed", "outcomeUnknown"])],
  ["turnCompleted", new Set(["verified", "failed"])],
  ["verified", new Set(["commitAttempted", "failed"])],
  ["commitAttempted", new Set(["pushAttempted", "failed"])],
  ["pushAttempted", new Set(["confirmed", "failed", "outcomeUnknown"])],
]);

function sameRemediationBinding(
  left: DeliveryRemediation,
  right: DeliveryRemediation,
): boolean {
  return (
    left.activationActionDigest === right.activationActionDigest &&
    left.activationPredecessorDigest === right.activationPredecessorDigest &&
    left.activationReceiptDigest === right.activationReceiptDigest &&
    left.attempt === right.attempt &&
    left.authorizationDigest === right.authorizationDigest &&
    left.expectedHeadSha === right.expectedHeadSha &&
    left.feedbackDigest === right.feedbackDigest &&
    JSON.stringify(left.feedbackIds) === JSON.stringify(right.feedbackIds) &&
    left.inputId === right.inputId &&
    left.operationId === right.operationId
  );
}
