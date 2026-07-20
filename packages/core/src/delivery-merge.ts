import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import {
  DeliveryActionIdPublicSchema,
  DeliveryBranchNamePublicSchema,
  DeliveryEvidenceIdPublicSchema,
  DeliveryGitShaPublicSchema,
  DeliveryPositiveIntegerSchema,
  DeliverySha256DigestPublicSchema,
  DeliveryTimestampPublicSchema,
  GitHubCheckFieldPublicSchema,
  GitHubPullRequestUrlPublicSchema,
  GitHubRepositoryPublicSchema,
} from "./delivery-identity.js";
import {
  type DeliveryPublication,
  DeliveryPublicationSchema,
} from "./delivery-publication.js";
import { deriveDeliveryAuthority } from "./delivery-remediation.js";
import { RunEvent } from "./events.js";
import {
  MergeDecisionPayloadDigestSchema,
  parseMergeDecisionV2,
} from "./merge-decision.js";
import {
  parseRunContract,
  parseRunProofResult,
  RunContractDigestSchema,
  RunContractIdSchema,
  RunEventSequenceSchema,
  RunProofResultDigestSchema,
  StructuralDigestSchema,
} from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";

export { DeliveryActionIdSchema } from "./delivery-identity.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Digest = DeliverySha256DigestPublicSchema;
const GitSha = DeliveryGitShaPublicSchema;
const BoundedId = DeliveryActionIdPublicSchema;
const Repository = GitHubRepositoryPublicSchema;
const StableCheckField = GitHubCheckFieldPublicSchema;
const GaiaEvidenceId = DeliveryEvidenceIdPublicSchema;
const BranchName = DeliveryBranchNamePublicSchema;
const PullRequestUrl = GitHubPullRequestUrlPublicSchema;
const Timestamp = DeliveryTimestampPublicSchema;
const PositiveSequence = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1))
);
const PositiveGitHubNumber = DeliveryPositiveIntegerSchema;

export const DeliveryMergeMethodSchema = Schema.Literals([
  "merge",
  "squash",
  "rebase",
] as const);
export type DeliveryMergeMethod = Schema.Schema.Type<
  typeof DeliveryMergeMethodSchema
>;

export const deliveryMergeMethodArguments = {
  merge: ["--merge"],
  rebase: ["--rebase"],
  squash: ["--squash"],
} as const satisfies Record<DeliveryMergeMethod, readonly [string]>;

export class DeliveryRequiredCheckIdentity extends Schema.Class<DeliveryRequiredCheckIdentity>(
  "DeliveryRequiredCheckIdentity"
)(
  {
    appSlug: StableCheckField,
    name: StableCheckField,
    repository: Repository,
    workflow: StableCheckField,
  },
  strict
) {}

export class DeliveryRequiredCheckPolicy extends Schema.Class<DeliveryRequiredCheckPolicy>(
  "DeliveryRequiredCheckPolicy"
)(
  {
    checks: Schema.Array(DeliveryRequiredCheckIdentity).pipe(
      Schema.check(Schema.isMaxLength(20)),
      Schema.check(
        Schema.makeFilter(
          (checks) => {
            const keys = checks.map(requiredCheckKey);
            return (
              keys.length === new Set(keys).size &&
              keys.every((key, index) => index === 0 || keys[index - 1]! < key)
            );
          },
          { identifier: "SortedUniqueRequiredChecks" }
        )
      )
    ),
    requireApprovedReview: Schema.Boolean,
    version: Schema.Literal(1),
  },
  strict
) {}

export class DeliveryMergeReadinessDecision extends Schema.Class<DeliveryMergeReadinessDecision>(
  "DeliveryMergeReadinessDecision"
)(
  {
    actionId: BoundedId,
    approved: Schema.Boolean,
    blockers: Schema.Array(
      Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)))
    ).pipe(Schema.check(Schema.isMaxLength(20))),
    branchName: BranchName,
    headSha: GitSha,
    mergeMethod: DeliveryMergeMethodSchema,
    payloadDigest: Digest,
    policyDigest: Digest,
    policyVersion: Schema.Literal(1),
    prNumber: PositiveGitHubNumber,
    prUrl: PullRequestUrl,
  },
  strict
) {}

export class DeliveryGitHubApprovedReviewSource extends Schema.Class<DeliveryGitHubApprovedReviewSource>(
  "DeliveryGitHubApprovedReviewSource"
)(
  {
    kind: Schema.Literal("githubApproved"),
    reviewDecision: Schema.Literal("APPROVED"),
    version: Schema.Literal(1),
  },
  strict
) {}

export class DeliveryLocalOperatorReviewSource extends Schema.Class<DeliveryLocalOperatorReviewSource>(
  "DeliveryLocalOperatorReviewSource"
)(
  {
    attestationActionId: BoundedId,
    attestationConfirmationSequence: PositiveSequence,
    attestationPayloadDigest: Digest,
    authoritySequence: PositiveSequence,
    gaiaEvidenceDigest: Schema.optionalKey(Digest),
    gaiaEvidenceId: GaiaEvidenceId,
    headSha: GitSha,
    kind: Schema.Literal("localOperatorPairedReview"),
    version: Schema.Literal(1),
  },
  strict
) {}

export class DeliveryReviewApprovalNotRequiredSource extends Schema.Class<DeliveryReviewApprovalNotRequiredSource>(
  "DeliveryReviewApprovalNotRequiredSource"
)(
  {
    kind: Schema.Literal("notRequired"),
    version: Schema.Literal(1),
  },
  strict
) {}

export const DeliveryReviewApprovalSourceSchema = Schema.Union([
  DeliveryGitHubApprovedReviewSource,
  DeliveryLocalOperatorReviewSource,
  DeliveryReviewApprovalNotRequiredSource,
]);
export type DeliveryReviewApprovalSource = Schema.Schema.Type<
  typeof DeliveryReviewApprovalSourceSchema
>;

const readinessDecisionV2Binding = {
  actionId: BoundedId,
  approved: Schema.Boolean,
  approvalSource: Schema.optionalKey(DeliveryReviewApprovalSourceSchema),
  authoritySequence: PositiveSequence,
  blockers: Schema.Array(
    Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)))
  ).pipe(Schema.check(Schema.isMaxLength(20))),
  branchName: BranchName,
  headSha: GitSha,
  mergeMethod: DeliveryMergeMethodSchema,
  policyDigest: Digest,
  policyVersion: Schema.Literal(1),
  prNumber: PositiveGitHubNumber,
  prUrl: PullRequestUrl,
  publicationConfirmationSequence: PositiveSequence,
  publicationOperationId: BoundedId,
  publicationPayloadDigest: Digest,
  repository: Repository,
  runId: RunIdSchema,
  version: Schema.Literal(2),
} as const;

const DeliveryMergeReadinessDecisionV2BindingSchema = Schema.Struct(
  readinessDecisionV2Binding
);
export type DeliveryMergeReadinessDecisionV2Binding = Schema.Schema.Type<
  typeof DeliveryMergeReadinessDecisionV2BindingSchema
>;

function readinessApprovalSourceCanonicalPayload(
  source: DeliveryReviewApprovalSource | undefined
) {
  if (source === undefined) return "none";
  if (source.kind === "githubApproved")
    return canonicalFields([
      source.kind,
      source.reviewDecision,
      String(source.version),
    ]);
  if (source.kind === "notRequired")
    return canonicalFields([source.kind, String(source.version)]);
  return canonicalFields([
    source.kind,
    source.attestationActionId,
    source.attestationPayloadDigest,
    String(source.attestationConfirmationSequence),
    String(source.authoritySequence),
    source.headSha,
    source.gaiaEvidenceId,
    source.gaiaEvidenceDigest ?? "",
    String(source.version),
  ]);
}

export function deliveryMergeReadinessDecisionV2CanonicalPayload(
  binding: DeliveryMergeReadinessDecisionV2Binding
) {
  return canonicalFields([
    "gaia.delivery.merge-readiness.v2",
    binding.actionId,
    binding.runId,
    binding.publicationOperationId,
    binding.publicationPayloadDigest,
    String(binding.publicationConfirmationSequence),
    String(binding.authoritySequence),
    binding.repository,
    String(binding.prNumber),
    binding.prUrl,
    binding.branchName,
    binding.headSha,
    binding.mergeMethod,
    binding.policyDigest,
    String(binding.policyVersion),
    binding.approved ? "approved" : "denied",
    ...binding.blockers,
    readinessApprovalSourceCanonicalPayload(binding.approvalSource),
    String(binding.version),
  ]);
}

export function deliveryMergeReadinessDecisionV2PayloadDigest(
  binding: DeliveryMergeReadinessDecisionV2Binding
) {
  return sha256Hex(deliveryMergeReadinessDecisionV2CanonicalPayload(binding));
}

export class DeliveryMergeReadinessDecisionV2 extends Schema.Class<DeliveryMergeReadinessDecisionV2>(
  "DeliveryMergeReadinessDecisionV2"
)(
  {
    ...readinessDecisionV2Binding,
    payloadDigest: Digest,
  },
  strict
) {}

const readinessDecisionV3Binding = {
  ...readinessDecisionV2Binding,
  contentAuthoritySequence: RunEventSequenceSchema,
  contractDigest: RunContractDigestSchema,
  contractId: RunContractIdSchema,
  evidenceReviewSequence: RunEventSequenceSchema,
  mergeDecisionPayloadDigest: MergeDecisionPayloadDigestSchema,
  mergeDecisionSequence: PositiveSequence,
  observedTargetDigest: StructuralDigestSchema,
  proofAggregate: Schema.Literal("verified"),
  proofResultDigest: RunProofResultDigestSchema,
  proofResultSequence: RunEventSequenceSchema,
  version: Schema.Literal(3),
} as const;

const DeliveryMergeReadinessDecisionV3BindingSchema = Schema.Struct(
  readinessDecisionV3Binding
);
export type DeliveryMergeReadinessDecisionV3Binding = Schema.Schema.Type<
  typeof DeliveryMergeReadinessDecisionV3BindingSchema
>;

export function deliveryMergeReadinessDecisionV3CanonicalPayload(
  binding: DeliveryMergeReadinessDecisionV3Binding
) {
  return canonicalFields([
    "gaia.delivery.merge-readiness.v3",
    binding.actionId,
    binding.runId,
    binding.publicationOperationId,
    binding.publicationPayloadDigest,
    String(binding.publicationConfirmationSequence),
    String(binding.authoritySequence),
    binding.repository,
    String(binding.prNumber),
    binding.prUrl,
    binding.branchName,
    binding.headSha,
    binding.mergeMethod,
    binding.policyDigest,
    String(binding.policyVersion),
    binding.approved ? "approved" : "denied",
    ...binding.blockers,
    readinessApprovalSourceCanonicalPayload(binding.approvalSource),
    String(binding.mergeDecisionSequence),
    binding.mergeDecisionPayloadDigest,
    binding.contractId,
    binding.contractDigest,
    binding.proofResultDigest,
    String(binding.proofResultSequence),
    binding.proofAggregate,
    binding.observedTargetDigest,
    String(binding.contentAuthoritySequence),
    String(binding.evidenceReviewSequence),
    String(binding.version),
  ]);
}

export function deliveryMergeReadinessDecisionV3PayloadDigest(
  binding: DeliveryMergeReadinessDecisionV3Binding
) {
  return sha256Hex(deliveryMergeReadinessDecisionV3CanonicalPayload(binding));
}

export class DeliveryMergeReadinessDecisionV3 extends Schema.Class<DeliveryMergeReadinessDecisionV3>(
  "DeliveryMergeReadinessDecisionV3"
)(
  {
    ...readinessDecisionV3Binding,
    payloadDigest: Digest,
  },
  strict
) {}

export const DeliveryMergeReadinessDecisionSchema = Schema.Union([
  DeliveryMergeReadinessDecision,
  DeliveryMergeReadinessDecisionV2,
  DeliveryMergeReadinessDecisionV3,
]);
export type DeliveryMergeReadinessDecisionReceipt = Schema.Schema.Type<
  typeof DeliveryMergeReadinessDecisionSchema
>;
export const parseDeliveryMergeReadinessDecision = Schema.decodeUnknownSync(
  DeliveryMergeReadinessDecisionSchema
);
const DeliveryMergeReadinessDecisionJson = Schema.toCodecJson(
  DeliveryMergeReadinessDecisionSchema
);
export const encodeDeliveryMergeReadinessDecisionJson = Schema.encodeSync(
  DeliveryMergeReadinessDecisionJson
);

function canonicalFields(fields: ReadonlyArray<string>) {
  return fields
    .map((field) => {
      if (!field.isWellFormed())
        throw new Error(
          "Canonical delivery fields must contain well-formed Unicode."
        );
      return `${field.length}:${field}`;
    })
    .join("|");
}

function sha256Hex(payload: string) {
  return Array.from(sha256(utf8ToBytes(payload)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

const DeliveryAuthorityAssertionInputSchema = Schema.Struct({
  enclosingRunId: RunIdSchema,
  eventSequence: PositiveSequence,
  events: Schema.Array(RunEvent),
  publication: DeliveryPublicationSchema,
  repository: Repository,
});

export function assertDeliveryMergeReadinessDecisionAuthority(
  decision: DeliveryMergeReadinessDecisionReceipt,
  input: Schema.Schema.Type<typeof DeliveryAuthorityAssertionInputSchema>
) {
  // Versions 1 and 2 are retained as decode-only historical receipts.
  if (
    !(decision instanceof DeliveryMergeReadinessDecisionV2) &&
    !(decision instanceof DeliveryMergeReadinessDecisionV3)
  )
    return;
  if (input.publication.state !== "confirmed")
    throw new Error("Merge readiness requires a confirmed publication.");
  const authority = deriveDeliveryAuthority(
    input.publication,
    input.events,
    input.eventSequence - 1
  );
  if (
    decision.runId !== input.enclosingRunId ||
    decision.publicationOperationId !== input.publication.operationId ||
    decision.publicationPayloadDigest !== input.publication.payloadDigest ||
    decision.publicationConfirmationSequence !==
      authority.publicationConfirmationSequence ||
    decision.authoritySequence !== authority.authoritySequence ||
    decision.repository !== input.repository ||
    decision.prNumber !== input.publication.prNumber ||
    decision.prUrl !== input.publication.prUrl ||
    decision.branchName !== input.publication.branchName ||
    decision.headSha !== authority.headSha
  ) {
    throw new Error(
      "Merge readiness decision does not match the current delivery authority."
    );
  }
  const expectedPayloadDigest =
    decision instanceof DeliveryMergeReadinessDecisionV3
      ? deliveryMergeReadinessDecisionV3PayloadDigest(decision)
      : deliveryMergeReadinessDecisionV2PayloadDigest(decision);
  if (decision.payloadDigest !== expectedPayloadDigest) {
    throw new Error("Merge readiness decision payload digest is invalid.");
  }
  if (decision instanceof DeliveryMergeReadinessDecisionV3) {
    const priorEvents = input.events.filter(
      ({ sequence }) => sequence < input.eventSequence
    );
    const mergeDecisionEvent = priorEvents.findLast(
      ({ type }) => type === "MERGE_DECISION_RECORDED"
    );
    if (
      mergeDecisionEvent?.type !== "MERGE_DECISION_RECORDED" ||
      mergeDecisionEvent.sequence !== decision.mergeDecisionSequence
    )
      throw new Error(
        "Merge readiness V3 does not bind the latest prior merge decision."
      );
    const mergeDecision = parseMergeDecisionV2(
      mergeDecisionEvent.payload["decision"]
    );
    const recordedProof =
      mergeDecision.proof.kind === "contract" &&
      mergeDecision.proof.result.kind === "recorded"
        ? mergeDecision.proof.result
        : undefined;
    const contractEvent = priorEvents.find(
      ({ type }) => type === "RUN_CONTRACT_RECORDED"
    );
    const latestProofEvent = priorEvents.findLast(
      ({ type }) => type === "RUN_PROOF_RESULT_RECORDED"
    );
    if (
      contractEvent?.type !== "RUN_CONTRACT_RECORDED" ||
      latestProofEvent?.type !== "RUN_PROOF_RESULT_RECORDED"
    )
      throw new Error("Merge readiness V3 requires current run proof.");
    const contract = parseRunContract(contractEvent.payload["contract"]);
    const proof = parseRunProofResult(
      latestProofEvent.payload["result"],
      contract
    );
    const contentAuthoritySequence = Math.max(
      1,
      ...priorEvents.flatMap((event) =>
        event.type === "WORKER_COMPLETED" ||
        event.type === "WORKER_CONTINUATION_RECORDED" ||
        event.type === "DELIVERY_REMEDIATION_RECORDED"
          ? [event.sequence]
          : []
      )
    );
    const evidenceReviewSequence = priorEvents.findLast(
      ({ payload, type }) =>
        type === "REVIEW_COMPLETED" && payload["phase"] === "evidence"
    )?.sequence;
    if (
      mergeDecision.status !== "approved" ||
      mergeDecision.nextAction !== "ready-to-merge" ||
      mergeDecision.payloadDigest !== decision.mergeDecisionPayloadDigest ||
      recordedProof === undefined ||
      recordedProof.aggregate !== "verified" ||
      mergeDecision.proof.kind !== "contract" ||
      mergeDecision.proof.contractId !== decision.contractId ||
      mergeDecision.proof.contractDigest !== decision.contractDigest ||
      recordedProof.resultDigest !== decision.proofResultDigest ||
      recordedProof.sequence !== decision.proofResultSequence ||
      recordedProof.observedTargetDigest !== decision.observedTargetDigest ||
      mergeDecision.contentAuthoritySequence !==
        decision.contentAuthoritySequence ||
      mergeDecision.evidenceReviewSequence !==
        decision.evidenceReviewSequence ||
      mergeDecision.publicationConfirmationSequence !==
        decision.publicationConfirmationSequence ||
      proof.aggregate !== "verified" ||
      proof.contractId !== decision.contractId ||
      proof.contractDigest !== decision.contractDigest ||
      proof.resultDigest !== decision.proofResultDigest ||
      proof.recordedBy.sequence !== decision.proofResultSequence ||
      proof.observedTargetDigest !== decision.observedTargetDigest ||
      contentAuthoritySequence !== decision.contentAuthoritySequence ||
      evidenceReviewSequence !== decision.evidenceReviewSequence
    )
      throw new Error(
        "Merge readiness V3 proof-bound merge decision is stale."
      );
  }
  if (decision.approved !== (decision.blockers.length === 0)) {
    throw new Error("Merge readiness approval and blockers are inconsistent.");
  }
  if (!decision.approved) {
    if (decision.approvalSource !== undefined)
      throw new Error(
        "Denied merge readiness cannot claim an approval source."
      );
    return;
  }
  if (decision.approvalSource === undefined)
    throw new Error("Approved merge readiness requires an approval source.");
  if (decision.approvalSource.kind !== "localOperatorPairedReview") return;
  const source = decision.approvalSource;
  const attestationEvent = input.events.find(
    ({ sequence }) => sequence === source.attestationConfirmationSequence
  );
  if (
    attestationEvent?.type !== "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED" ||
    attestationEvent.sequence >= input.eventSequence
  ) {
    throw new Error(
      "Merge readiness local approval source is not a prior attestation confirmation."
    );
  }
  const attestation = parseDeliveryLocalReviewAttestationReceipt(
    attestationEvent.payload["attestation"]
  );
  if (
    attestation.state !== "confirmed" ||
    attestation.actionId !== source.attestationActionId ||
    attestation.attestationPayloadDigest !== source.attestationPayloadDigest ||
    attestation.authoritySequence !== source.authoritySequence ||
    attestation.headSha !== source.headSha ||
    attestation.gaiaEvidenceId !== source.gaiaEvidenceId ||
    attestation.gaiaEvidenceDigest !== source.gaiaEvidenceDigest ||
    attestation.authoritySequence !== authority.authoritySequence ||
    attestation.headSha !== authority.headSha
  ) {
    throw new Error(
      "Merge readiness local approval source binding is invalid."
    );
  }
}

export function requiredCheckKey(
  check: Schema.Schema.Type<typeof DeliveryRequiredCheckIdentity>
) {
  return [check.repository, check.workflow, check.name, check.appSlug]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}

export function deliveryRequiredCheckPolicyCanonicalPayload(
  policy: Schema.Schema.Type<typeof DeliveryRequiredCheckPolicy>
) {
  const entries = policy.checks.map(requiredCheckKey);
  return `v${policy.version}|review:${policy.requireApprovedReview ? "1" : "0"}|${entries.map((entry) => `${entry.length}:${entry}`).join("|")}`;
}

const mergeBinding = {
  actionId: BoundedId,
  branchName: BranchName,
  decisionSequence: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  expectedHeadSha: GitSha,
  mergeMethod: DeliveryMergeMethodSchema,
  payloadDigest: Digest,
  policyDigest: Digest,
  policyVersion: Schema.Literal(1),
  prNumber: PositiveGitHubNumber,
  prUrl: PullRequestUrl,
  repository: Repository,
} as const;

export class DeliveryMergeIntent extends Schema.Class<DeliveryMergeIntent>(
  "DeliveryMergeIntent"
)(
  {
    ...mergeBinding,
    state: Schema.Literal("intentRecorded"),
  },
  strict
) {}
export class DeliveryMergeDispatchAttempted extends Schema.Class<DeliveryMergeDispatchAttempted>(
  "DeliveryMergeDispatchAttempted"
)(
  {
    ...mergeBinding,
    state: Schema.Literal("dispatchAttempted"),
  },
  strict
) {}
export class DeliveryMergeDispatchConfirmed extends Schema.Class<DeliveryMergeDispatchConfirmed>(
  "DeliveryMergeDispatchConfirmed"
)(
  {
    ...mergeBinding,
    mergeCommitSha: GitSha,
    mergedAt: Timestamp,
    state: Schema.Literal("dispatchConfirmed"),
  },
  strict
) {}
export class DeliveryMergeTerminalFailure extends Schema.Class<DeliveryMergeTerminalFailure>(
  "DeliveryMergeTerminalFailure"
)(
  {
    ...mergeBinding,
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
    state: Schema.Literals(["dispatchFailed", "outcomeUnknown"] as const),
  },
  strict
) {}

export const DeliveryMergeReceiptSchema = Schema.Union([
  DeliveryMergeIntent,
  DeliveryMergeDispatchAttempted,
  DeliveryMergeDispatchConfirmed,
  DeliveryMergeTerminalFailure,
]);
export type DeliveryMergeReceipt = Schema.Schema.Type<
  typeof DeliveryMergeReceiptSchema
>;
export const parseDeliveryMergeReceipt = Schema.decodeUnknownSync(
  DeliveryMergeReceiptSchema
);
const DeliveryMergeReceiptJson = Schema.toCodecJson(DeliveryMergeReceiptSchema);
export const encodeDeliveryMergeReceiptJson = Schema.encodeSync(
  DeliveryMergeReceiptJson
);

const readyForReviewCanonicalBinding = {
  actionId: BoundedId,
  branchName: BranchName,
  expectedHeadSha: GitSha,
  prNumber: PositiveGitHubNumber,
  prUrl: PullRequestUrl,
  publicationOperationId: BoundedId,
  publicationPayloadDigest: Digest,
  repository: Repository,
  runId: RunIdSchema,
  version: Schema.Literal(1),
} as const;

const readyForReviewBinding = {
  ...readyForReviewCanonicalBinding,
  payloadDigest: Digest,
} as const;

const DeliveryPullRequestReadyBindingSchema = Schema.Struct(
  readyForReviewCanonicalBinding
);
export type DeliveryPullRequestReadyBinding = Schema.Schema.Type<
  typeof DeliveryPullRequestReadyBindingSchema
>;
const DeliveryPullRequestReadyAuthorityInputSchema = Schema.Struct({
  branchName: BranchName,
  expectedHeadSha: GitSha,
  prNumber: PositiveGitHubNumber,
  prUrl: PullRequestUrl,
  publicationOperationId: BoundedId,
  publicationPayloadDigest: Digest,
  repository: Repository,
  runId: RunIdSchema,
});
type DeliveryPullRequestReadyAuthorityInput = Schema.Schema.Type<
  typeof DeliveryPullRequestReadyAuthorityInputSchema
>;

/** Canonical, domain-separated binding for one owned ready-for-review action. */
export function deliveryPullRequestReadyCanonicalPayload(
  binding: DeliveryPullRequestReadyBinding
) {
  const fields = [
    binding.actionId,
    binding.runId,
    binding.publicationOperationId,
    binding.publicationPayloadDigest,
    binding.repository,
    String(binding.prNumber),
    binding.prUrl,
    binding.branchName,
    binding.expectedHeadSha,
  ];
  return ["gaia.delivery.mark-ready.v1", ...fields]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}

export function deliveryPullRequestReadyPayloadDigest(
  binding: DeliveryPullRequestReadyBinding
) {
  return Array.from(
    sha256(utf8ToBytes(deliveryPullRequestReadyCanonicalPayload(binding))),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}

export function assertDeliveryPullRequestReadyAuthority(
  receipt: DeliveryPullRequestReadyReceipt,
  expected: DeliveryPullRequestReadyAuthorityInput
) {
  if (receipt.runId !== expected.runId) {
    throw new Error(
      "Ready-for-review action does not match its enclosing run."
    );
  }
  if (
    receipt.branchName !== expected.branchName ||
    receipt.expectedHeadSha !== expected.expectedHeadSha ||
    receipt.prNumber !== expected.prNumber ||
    receipt.prUrl !== expected.prUrl ||
    receipt.publicationOperationId !== expected.publicationOperationId ||
    receipt.publicationPayloadDigest !== expected.publicationPayloadDigest ||
    receipt.repository !== expected.repository
  ) {
    throw new Error(
      "Ready-for-review action does not match the confirmed publication."
    );
  }
  if (
    receipt.payloadDigest !== deliveryPullRequestReadyPayloadDigest(receipt)
  ) {
    throw new Error("Ready-for-review action digest is invalid.");
  }
}

export class DeliveryPullRequestReadyIntent extends Schema.Class<DeliveryPullRequestReadyIntent>(
  "DeliveryPullRequestReadyIntent"
)(
  {
    ...readyForReviewBinding,
    state: Schema.Literal("intentRecorded"),
  },
  strict
) {}

export class DeliveryPullRequestReadyDispatchAttempted extends Schema.Class<DeliveryPullRequestReadyDispatchAttempted>(
  "DeliveryPullRequestReadyDispatchAttempted"
)(
  {
    ...readyForReviewBinding,
    state: Schema.Literal("dispatchAttempted"),
  },
  strict
) {}

export class DeliveryPullRequestReadyConfirmedWithoutDispatch extends Schema.Class<DeliveryPullRequestReadyConfirmedWithoutDispatch>(
  "DeliveryPullRequestReadyConfirmedWithoutDispatch"
)(
  {
    ...readyForReviewBinding,
    draft: Schema.Literal(false),
    state: Schema.Literal("confirmedWithoutDispatch"),
  },
  strict
) {}

export class DeliveryPullRequestReadyDispatchConfirmed extends Schema.Class<DeliveryPullRequestReadyDispatchConfirmed>(
  "DeliveryPullRequestReadyDispatchConfirmed"
)(
  {
    ...readyForReviewBinding,
    draft: Schema.Literal(false),
    state: Schema.Literal("dispatchConfirmed"),
  },
  strict
) {}

export class DeliveryPullRequestReadyTerminalFailure extends Schema.Class<DeliveryPullRequestReadyTerminalFailure>(
  "DeliveryPullRequestReadyTerminalFailure"
)(
  {
    ...readyForReviewBinding,
    code: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(160))),
    message: Schema.NonEmptyString.pipe(
      Schema.check(Schema.isMaxLength(1_024))
    ),
    state: Schema.Literals(["dispatchFailed", "outcomeUnknown"] as const),
  },
  strict
) {}

export const DeliveryPullRequestReadyReceiptSchema = Schema.Union([
  DeliveryPullRequestReadyIntent,
  DeliveryPullRequestReadyDispatchAttempted,
  DeliveryPullRequestReadyConfirmedWithoutDispatch,
  DeliveryPullRequestReadyDispatchConfirmed,
  DeliveryPullRequestReadyTerminalFailure,
]);
export type DeliveryPullRequestReadyReceipt = Schema.Schema.Type<
  typeof DeliveryPullRequestReadyReceiptSchema
>;
export const parseDeliveryPullRequestReadyReceipt = Schema.decodeUnknownSync(
  DeliveryPullRequestReadyReceiptSchema
);
const DeliveryPullRequestReadyReceiptJson = Schema.toCodecJson(
  DeliveryPullRequestReadyReceiptSchema
);
export const encodeDeliveryPullRequestReadyReceiptJson = Schema.encodeSync(
  DeliveryPullRequestReadyReceiptJson
);

const localReviewAttestationCanonicalBinding = {
  actionId: BoundedId,
  authority: Schema.Literal("localOperator"),
  authoritySequence: PositiveSequence,
  branchName: BranchName,
  decision: Schema.Literal("approved"),
  gaiaEvidenceDigest: Schema.optionalKey(Digest),
  gaiaEvidenceId: GaiaEvidenceId,
  headSha: GitSha,
  prNumber: PositiveGitHubNumber,
  prUrl: PullRequestUrl,
  publicationConfirmationSequence: PositiveSequence,
  publicationOperationId: BoundedId,
  publicationPayloadDigest: Digest,
  readyConfirmationActionId: BoundedId,
  readyConfirmationPayloadDigest: Digest,
  readyConfirmationSequence: PositiveSequence,
  repository: Repository,
  runId: RunIdSchema,
  version: Schema.Literal(1),
} as const;

const localReviewAttestationBinding = {
  ...localReviewAttestationCanonicalBinding,
  attestationPayloadDigest: Digest,
} as const;

const DeliveryLocalReviewAttestationBindingSchema = Schema.Struct(
  localReviewAttestationCanonicalBinding
);
export type DeliveryLocalReviewAttestationBinding = Schema.Schema.Type<
  typeof DeliveryLocalReviewAttestationBindingSchema
>;

/** Canonical Gaia action binding. This digest does not verify external evidence content. */
export function deliveryLocalReviewAttestationCanonicalPayload(
  binding: DeliveryLocalReviewAttestationBinding
) {
  const fields = [
    binding.actionId,
    binding.runId,
    binding.authority,
    binding.decision,
    binding.publicationOperationId,
    binding.publicationPayloadDigest,
    String(binding.publicationConfirmationSequence),
    String(binding.authoritySequence),
    binding.repository,
    String(binding.prNumber),
    binding.prUrl,
    binding.branchName,
    binding.headSha,
    binding.readyConfirmationActionId,
    binding.readyConfirmationPayloadDigest,
    String(binding.readyConfirmationSequence),
    binding.gaiaEvidenceId,
    binding.gaiaEvidenceDigest ?? "",
    String(binding.version),
  ];
  return ["gaia.delivery.local-paired-review-attestation.v1", ...fields]
    .map((field) => `${field.length}:${field}`)
    .join("|");
}

export function deliveryLocalReviewAttestationPayloadDigest(
  binding: DeliveryLocalReviewAttestationBinding
) {
  return Array.from(
    sha256(
      utf8ToBytes(deliveryLocalReviewAttestationCanonicalPayload(binding))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}

export class DeliveryLocalReviewAttestationIntent extends Schema.Class<DeliveryLocalReviewAttestationIntent>(
  "DeliveryLocalReviewAttestationIntent"
)(
  {
    ...localReviewAttestationBinding,
    state: Schema.Literal("intentRecorded"),
  },
  strict
) {}

export class DeliveryLocalReviewAttestationConfirmed extends Schema.Class<DeliveryLocalReviewAttestationConfirmed>(
  "DeliveryLocalReviewAttestationConfirmed"
)(
  {
    ...localReviewAttestationBinding,
    state: Schema.Literal("confirmed"),
  },
  strict
) {}

export class DeliveryLocalReviewAttestationFailed extends Schema.Class<DeliveryLocalReviewAttestationFailed>(
  "DeliveryLocalReviewAttestationFailed"
)(
  {
    ...localReviewAttestationBinding,
    code: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(160))),
    message: Schema.NonEmptyString.pipe(
      Schema.check(Schema.isMaxLength(1_024))
    ),
    state: Schema.Literal("failed"),
  },
  strict
) {}

export const DeliveryLocalReviewAttestationReceiptSchema = Schema.Union([
  DeliveryLocalReviewAttestationIntent,
  DeliveryLocalReviewAttestationConfirmed,
  DeliveryLocalReviewAttestationFailed,
]);
export type DeliveryLocalReviewAttestationReceipt = Schema.Schema.Type<
  typeof DeliveryLocalReviewAttestationReceiptSchema
>;
export const parseDeliveryLocalReviewAttestationReceipt =
  Schema.decodeUnknownSync(DeliveryLocalReviewAttestationReceiptSchema);
const DeliveryLocalReviewAttestationReceiptJson = Schema.toCodecJson(
  DeliveryLocalReviewAttestationReceiptSchema
);
export const encodeDeliveryLocalReviewAttestationReceiptJson =
  Schema.encodeSync(DeliveryLocalReviewAttestationReceiptJson);

export function assertDeliveryLocalReviewAttestationAuthority(
  receipt: DeliveryLocalReviewAttestationReceipt,
  input: Schema.Schema.Type<typeof DeliveryAuthorityAssertionInputSchema>
) {
  if (input.publication.state !== "confirmed")
    throw new Error(
      "Local review attestation requires a confirmed publication."
    );
  if (receipt.runId !== input.enclosingRunId) {
    throw new Error(
      "Local review attestation does not match its enclosing run."
    );
  }
  const authority = deriveDeliveryAuthority(
    input.publication,
    input.events,
    input.eventSequence - 1
  );
  if (
    receipt.publicationOperationId !== input.publication.operationId ||
    receipt.publicationPayloadDigest !== input.publication.payloadDigest ||
    receipt.publicationConfirmationSequence !==
      authority.publicationConfirmationSequence ||
    receipt.authoritySequence !== authority.authoritySequence ||
    receipt.repository !== input.repository ||
    receipt.prNumber !== input.publication.prNumber ||
    receipt.prUrl !== input.publication.prUrl ||
    receipt.branchName !== input.publication.branchName ||
    receipt.headSha !== authority.headSha
  ) {
    throw new Error(
      "Local review attestation does not match the confirmed delivery authority."
    );
  }
  const readyEvent = input.events.find(
    ({ sequence }) => sequence === receipt.readyConfirmationSequence
  );
  if (
    readyEvent?.type !== "DELIVERY_PR_READY_RECORDED" ||
    readyEvent.sequence >= input.eventSequence ||
    readyEvent.sequence <= authority.authoritySequence
  ) {
    throw new Error(
      "Local review attestation requires a post-authority ready confirmation."
    );
  }
  const ready = parseDeliveryPullRequestReadyReceipt(
    readyEvent.payload["readyForReviewAction"]
  );
  if (
    (ready.state !== "confirmedWithoutDispatch" &&
      ready.state !== "dispatchConfirmed") ||
    ready.actionId !== receipt.readyConfirmationActionId ||
    ready.payloadDigest !== receipt.readyConfirmationPayloadDigest ||
    ready.runId !== receipt.runId ||
    ready.publicationOperationId !== receipt.publicationOperationId ||
    ready.publicationPayloadDigest !== receipt.publicationPayloadDigest ||
    ready.repository !== receipt.repository ||
    ready.prNumber !== receipt.prNumber ||
    ready.prUrl !== receipt.prUrl ||
    ready.branchName !== receipt.branchName ||
    ready.expectedHeadSha !== receipt.headSha
  ) {
    throw new Error(
      "Local review attestation ready confirmation binding is invalid."
    );
  }
  if (
    receipt.attestationPayloadDigest !==
    deliveryLocalReviewAttestationPayloadDigest(receipt)
  ) {
    throw new Error("Local review attestation payload digest is invalid.");
  }
  return authority;
}

const CurrentDeliveryLocalReviewAttestationInputSchema = Schema.Struct({
  publication: DeliveryPublicationSchema,
  repository: Repository,
  runId: RunIdSchema,
});

export function currentDeliveryLocalReviewAttestation(
  events: ReadonlyArray<RunEvent>,
  input: typeof CurrentDeliveryLocalReviewAttestationInputSchema.Type
) {
  if (input.publication.state !== "confirmed")
    throw new Error(
      "Current local review attestation requires a confirmed publication."
    );
  const publication = input.publication;
  const authority = deriveDeliveryAuthority(publication, events);
  const histories = deriveDeliveryLocalReviewAttestationHistories(
    events.flatMap((event) =>
      event.type === "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED"
        ? [
            {
              receipt: parseDeliveryLocalReviewAttestationReceipt(
                event.payload["attestation"]
              ),
              sequence: event.sequence,
            },
          ]
        : []
    )
  );
  const current = histories.histories.filter(
    ({ latest, latestSequence }) =>
      latest.state === "confirmed" &&
      latest.runId === input.runId &&
      latest.publicationOperationId === publication.operationId &&
      latest.publicationPayloadDigest === publication.payloadDigest &&
      latest.publicationConfirmationSequence ===
        authority.publicationConfirmationSequence &&
      latest.authoritySequence === authority.authoritySequence &&
      latest.repository === input.repository &&
      latest.prNumber === publication.prNumber &&
      latest.prUrl === publication.prUrl &&
      latest.branchName === publication.branchName &&
      latest.headSha === authority.headSha &&
      latest.readyConfirmationSequence > authority.authoritySequence &&
      latestSequence >= latest.readyConfirmationSequence
  );
  if (current.length > 1)
    throw new Error(
      "Only one current local review attestation may be confirmed."
    );
  return current[0];
}

export const DeliveryCleanupResourceStateSchema = Schema.Literals([
  "present",
  "absent",
] as const);
const cleanupBase = {
  actionId: BoundedId,
  branchName: BranchName,
  mergeCommitSha: GitSha,
  ownershipDigest: Digest,
} as const;
export class DeliveryCleanupRequired extends Schema.Class<DeliveryCleanupRequired>(
  "DeliveryCleanupRequired"
)(
  {
    ...cleanupBase,
    branch: DeliveryCleanupResourceStateSchema,
    state: Schema.Literal("cleanupRequired"),
    worktree: DeliveryCleanupResourceStateSchema,
  },
  strict
) {}
export class DeliveryCleanupCompleted extends Schema.Class<DeliveryCleanupCompleted>(
  "DeliveryCleanupCompleted"
)(
  {
    ...cleanupBase,
    branch: Schema.Literal("absent"),
    state: Schema.Literal("completed"),
    worktree: Schema.Literal("absent"),
  },
  strict
) {}
export const DeliveryCleanupReceiptSchema = Schema.Union([
  DeliveryCleanupRequired,
  DeliveryCleanupCompleted,
]);
export const parseDeliveryCleanupReceipt = Schema.decodeUnknownSync(
  DeliveryCleanupReceiptSchema
);
const DeliveryCleanupReceiptJson = Schema.toCodecJson(
  DeliveryCleanupReceiptSchema
);
export const encodeDeliveryCleanupReceiptJson = Schema.encodeSync(
  DeliveryCleanupReceiptJson
);

export type DeliveryCleanupActionReceipt = Schema.Schema.Type<
  typeof DeliveryCleanupReceiptSchema
>;

const DeliveryMergeReceiptEventSchema = Schema.Struct({
  receipt: DeliveryMergeReceiptSchema,
  sequence: PositiveSequence,
});
type DeliveryMergeReceiptEvent = Schema.Schema.Type<
  typeof DeliveryMergeReceiptEventSchema
>;
const DeliveryCleanupReceiptEventSchema = Schema.Struct({
  receipt: DeliveryCleanupReceiptSchema,
  sequence: PositiveSequence,
});
type DeliveryCleanupReceiptEvent = Schema.Schema.Type<
  typeof DeliveryCleanupReceiptEventSchema
>;
const DeliveryPullRequestReadyReceiptEventSchema = Schema.Struct({
  receipt: DeliveryPullRequestReadyReceiptSchema,
  sequence: PositiveSequence,
});
type DeliveryPullRequestReadyReceiptEvent = Schema.Schema.Type<
  typeof DeliveryPullRequestReadyReceiptEventSchema
>;
const DeliveryLocalReviewAttestationReceiptEventSchema = Schema.Struct({
  receipt: DeliveryLocalReviewAttestationReceiptSchema,
  sequence: PositiveSequence,
});
type DeliveryLocalReviewAttestationReceiptEvent = Schema.Schema.Type<
  typeof DeliveryLocalReviewAttestationReceiptEventSchema
>;

const DeliveryMergeActionHistorySchema = Schema.Struct({
  actionId: BoundedId,
  latest: DeliveryMergeReceiptSchema,
  latestSequence: PositiveSequence,
  receipts: Schema.Array(DeliveryMergeReceiptEventSchema),
});
export type DeliveryMergeActionHistory = Schema.Schema.Type<
  typeof DeliveryMergeActionHistorySchema
>;
const DeliveryCleanupActionHistorySchema = Schema.Struct({
  actionId: BoundedId,
  latest: DeliveryCleanupReceiptSchema,
  latestSequence: PositiveSequence,
  receipts: Schema.Array(DeliveryCleanupReceiptEventSchema),
});
export type DeliveryCleanupActionHistory = Schema.Schema.Type<
  typeof DeliveryCleanupActionHistorySchema
>;
const DeliveryPullRequestReadyActionHistorySchema = Schema.Struct({
  actionId: BoundedId,
  latest: DeliveryPullRequestReadyReceiptSchema,
  latestSequence: PositiveSequence,
  receipts: Schema.Array(DeliveryPullRequestReadyReceiptEventSchema),
});
export type DeliveryPullRequestReadyActionHistory = Schema.Schema.Type<
  typeof DeliveryPullRequestReadyActionHistorySchema
>;
const DeliveryLocalReviewAttestationActionHistorySchema = Schema.Struct({
  actionId: BoundedId,
  latest: DeliveryLocalReviewAttestationReceiptSchema,
  latestSequence: PositiveSequence,
  receipts: Schema.Array(DeliveryLocalReviewAttestationReceiptEventSchema),
});
export type DeliveryLocalReviewAttestationActionHistory = Schema.Schema.Type<
  typeof DeliveryLocalReviewAttestationActionHistorySchema
>;

export function deriveDeliveryLocalReviewAttestationHistories(
  events: ReadonlyArray<DeliveryLocalReviewAttestationReceiptEvent>
) {
  const histories = new Map<
    string,
    DeliveryLocalReviewAttestationActionHistory
  >();
  for (const event of events) {
    const previous = histories.get(event.receipt.actionId);
    if (previous === undefined) {
      const active = [...histories.values()].find(
        ({ latest }) => latest.state === "intentRecorded"
      );
      if (active !== undefined) {
        throw new Error(
          "An unresolved local review attestation cannot be superseded."
        );
      }
    }
    validateDeliveryLocalReviewAttestationTransition(
      previous?.latest,
      event.receipt
    );
    if (event.receipt.state === "confirmed") {
      const confirmed = event.receipt;
      if (
        [...histories.values()].some(
          ({ actionId, latest }) =>
            actionId !== confirmed.actionId &&
            latest.state === "confirmed" &&
            sameDeliveryLocalReviewAttestationGeneration(latest, confirmed)
        )
      ) {
        throw new Error(
          "Only one local review attestation may confirm the same delivery authority."
        );
      }
    }
    histories.set(event.receipt.actionId, {
      actionId: event.receipt.actionId,
      latest: event.receipt,
      latestSequence: event.sequence,
      receipts: [...(previous?.receipts ?? []), event],
    });
  }
  const ordered = [...histories.values()].sort(
    (left, right) =>
      left.latestSequence - right.latestSequence ||
      left.actionId.localeCompare(right.actionId)
  );
  const active = ordered.filter(
    ({ latest }) => latest.state === "intentRecorded"
  );
  if (active.length > 1)
    throw new Error("Only one local review attestation may be active.");
  return { active: active[0], histories: ordered, latest: ordered.at(-1) };
}

function sameDeliveryLocalReviewAttestationGeneration(
  left: DeliveryLocalReviewAttestationConfirmed,
  right: DeliveryLocalReviewAttestationConfirmed
) {
  return (
    left.runId === right.runId &&
    left.publicationOperationId === right.publicationOperationId &&
    left.publicationPayloadDigest === right.publicationPayloadDigest &&
    left.publicationConfirmationSequence ===
      right.publicationConfirmationSequence &&
    left.authoritySequence === right.authoritySequence &&
    left.repository === right.repository &&
    left.prNumber === right.prNumber &&
    left.prUrl === right.prUrl &&
    left.branchName === right.branchName &&
    left.headSha === right.headSha &&
    left.decision === right.decision &&
    left.authority === right.authority &&
    left.version === right.version
  );
}

export function deriveDeliveryPullRequestReadyActionHistories(
  events: ReadonlyArray<DeliveryPullRequestReadyReceiptEvent>
) {
  const histories = new Map<string, DeliveryPullRequestReadyActionHistory>();
  for (const event of events) {
    const previous = histories.get(event.receipt.actionId);
    if (previous === undefined) {
      const active = [...histories.values()].find(({ latest }) =>
        isActiveReadyForReviewState(latest.state)
      );
      if (active !== undefined) {
        throw new Error(
          "An unresolved ready-for-review action cannot be superseded."
        );
      }
    }
    validateDeliveryPullRequestReadyTransition(previous?.latest, event.receipt);
    histories.set(event.receipt.actionId, {
      actionId: event.receipt.actionId,
      latest: event.receipt,
      latestSequence: event.sequence,
      receipts: [...(previous?.receipts ?? []), event],
    });
  }
  const ordered = [...histories.values()].sort(
    (left, right) =>
      left.latestSequence - right.latestSequence ||
      left.actionId.localeCompare(right.actionId)
  );
  const active = ordered.filter(({ latest }) =>
    isActiveReadyForReviewState(latest.state)
  );
  if (active.length > 1)
    throw new Error("Only one ready-for-review action may be active.");
  return { active: active[0], histories: ordered, latest: ordered.at(-1) };
}

export function deriveDeliveryMergeActionHistories(
  events: ReadonlyArray<DeliveryMergeReceiptEvent>
) {
  const histories = new Map<string, DeliveryMergeActionHistory>();
  for (const event of events) {
    const previous = histories.get(event.receipt.actionId);
    validateDeliveryMergeActionTransition(previous?.latest, event.receipt);
    histories.set(event.receipt.actionId, {
      actionId: event.receipt.actionId,
      latest: event.receipt,
      latestSequence: event.sequence,
      receipts: [...(previous?.receipts ?? []), event],
    });
  }
  const ordered = [...histories.values()].sort(
    (left, right) =>
      left.latestSequence - right.latestSequence ||
      left.actionId.localeCompare(right.actionId)
  );
  const active = ordered.filter(
    ({ latest }) =>
      latest.state === "intentRecorded" ||
      latest.state === "dispatchAttempted" ||
      latest.state === "outcomeUnknown"
  );
  if (active.length > 1)
    throw new Error("Only one merge action may be active.");
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const next = ordered[index]!;
    if (
      previous.latest.state !== "dispatchFailed" ||
      next.latest.decisionSequence <= previous.latest.decisionSequence
    )
      throw new Error(
        "A newer merge action requires conclusive failure and a newer readiness decision."
      );
  }
  return { active: active[0], histories: ordered, latest: ordered.at(-1) };
}

export function deriveDeliveryCleanupActionHistories(
  events: ReadonlyArray<DeliveryCleanupReceiptEvent>
) {
  const histories = new Map<string, DeliveryCleanupActionHistory>();
  for (const event of events) {
    const previous = histories.get(event.receipt.actionId);
    if (previous !== undefined) {
      if (
        previous.latest.branchName !== event.receipt.branchName ||
        previous.latest.mergeCommitSha !== event.receipt.mergeCommitSha ||
        previous.latest.ownershipDigest !== event.receipt.ownershipDigest
      )
        throw new Error("Cleanup action binding changed.");
      if (
        previous.latest.state === "completed" &&
        event.receipt.state !== "completed"
      )
        throw new Error("Completed cleanup cannot regress.");
      if (
        previous.latest.worktree === "absent" &&
        event.receipt.worktree !== "absent"
      )
        throw new Error("Proven worktree absence cannot regress.");
      if (
        previous.latest.branch === "absent" &&
        event.receipt.branch !== "absent"
      )
        throw new Error("Proven branch absence cannot regress.");
    }
    histories.set(event.receipt.actionId, {
      actionId: event.receipt.actionId,
      latest: event.receipt,
      latestSequence: event.sequence,
      receipts: [...(previous?.receipts ?? []), event],
    });
  }
  const ordered = [...histories.values()].sort(
    (left, right) =>
      left.latestSequence - right.latestSequence ||
      left.actionId.localeCompare(right.actionId)
  );
  const active = ordered.filter(({ latest }) => latest.state !== "completed");
  if (active.length > 1)
    throw new Error("Only one cleanup action may be active.");
  return { active: active[0], histories: ordered, latest: ordered.at(-1) };
}

const DeliveryMergeActionHistoriesSchema = Schema.Struct({
  active: Schema.UndefinedOr(DeliveryMergeActionHistorySchema),
  histories: Schema.Array(DeliveryMergeActionHistorySchema),
  latest: Schema.UndefinedOr(DeliveryMergeActionHistorySchema),
});
const DeliveryCleanupActionHistoriesSchema = Schema.Struct({
  active: Schema.UndefinedOr(DeliveryCleanupActionHistorySchema),
  histories: Schema.Array(DeliveryCleanupActionHistorySchema),
  latest: Schema.UndefinedOr(DeliveryCleanupActionHistorySchema),
});
const DeliveryPullRequestReadyActionHistoriesSchema = Schema.Struct({
  active: Schema.UndefinedOr(DeliveryPullRequestReadyActionHistorySchema),
  histories: Schema.Array(DeliveryPullRequestReadyActionHistorySchema),
  latest: Schema.UndefinedOr(DeliveryPullRequestReadyActionHistorySchema),
});
const DeliveryLocalReviewAttestationActionHistoriesSchema = Schema.Struct({
  active: Schema.UndefinedOr(DeliveryLocalReviewAttestationActionHistorySchema),
  histories: Schema.Array(DeliveryLocalReviewAttestationActionHistorySchema),
  latest: Schema.UndefinedOr(DeliveryLocalReviewAttestationActionHistorySchema),
});
const DeliveryActionAuditSummaryInputSchema = Schema.Struct({
  cleanup: DeliveryCleanupActionHistoriesSchema,
  localReviewAttestation: Schema.optionalKey(
    DeliveryLocalReviewAttestationActionHistoriesSchema
  ),
  merge: DeliveryMergeActionHistoriesSchema,
  readyForReview: Schema.optionalKey(
    DeliveryPullRequestReadyActionHistoriesSchema
  ),
});
type DeliveryActionAuditSummaryInput = Schema.Schema.Type<
  typeof DeliveryActionAuditSummaryInputSchema
>;

export function deliveryActionAuditSummary(
  input: DeliveryActionAuditSummaryInput,
  limit = 20
) {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  return {
    cleanup: input.cleanup.histories
      .slice(-safeLimit)
      .map(({ actionId, latest, latestSequence }) => ({
        actionId,
        latestSequence,
        state: latest.state,
      })),
    localReviewAttestation: (input.localReviewAttestation?.histories ?? [])
      .slice(-safeLimit)
      .map(({ actionId, latest, latestSequence }) => ({
        actionId,
        latestSequence,
        state: latest.state,
      })),
    merge: input.merge.histories
      .slice(-safeLimit)
      .map(({ actionId, latest, latestSequence }) => ({
        actionId,
        latestSequence,
        state: latest.state,
      })),
    readyForReview: (input.readyForReview?.histories ?? [])
      .slice(-safeLimit)
      .map(({ actionId, latest, latestSequence }) => ({
        actionId,
        latestSequence,
        state: latest.state,
      })),
  };
}

function validateDeliveryLocalReviewAttestationTransition(
  previous: DeliveryLocalReviewAttestationReceipt | undefined,
  next: DeliveryLocalReviewAttestationReceipt
) {
  if (previous === undefined) {
    if (next.state !== "intentRecorded")
      throw new Error("Local review attestation must begin with intent.");
    return;
  }
  const binding = [
    "actionId",
    "attestationPayloadDigest",
    "authority",
    "authoritySequence",
    "branchName",
    "decision",
    "gaiaEvidenceDigest",
    "gaiaEvidenceId",
    "headSha",
    "prNumber",
    "prUrl",
    "publicationConfirmationSequence",
    "publicationOperationId",
    "publicationPayloadDigest",
    "readyConfirmationActionId",
    "readyConfirmationPayloadDigest",
    "readyConfirmationSequence",
    "repository",
    "runId",
    "version",
  ] as const;
  if (binding.some((key) => previous[key] !== next[key])) {
    throw new Error("Local review attestation binding changed.");
  }
  if (previous.state === next.state) return;
  if (
    previous.state === "intentRecorded" &&
    (next.state === "confirmed" || next.state === "failed")
  )
    return;
  throw new Error(
    `Illegal local review attestation transition ${previous.state} -> ${next.state}.`
  );
}

function validateDeliveryMergeActionTransition(
  previous: DeliveryMergeReceipt | undefined,
  next: DeliveryMergeReceipt
) {
  if (previous === undefined) {
    if (next.state !== "intentRecorded")
      throw new Error("Merge action must begin with intent.");
    return;
  }
  const binding = [
    "actionId",
    "branchName",
    "decisionSequence",
    "expectedHeadSha",
    "mergeMethod",
    "payloadDigest",
    "policyDigest",
    "policyVersion",
    "prNumber",
    "prUrl",
    "repository",
  ] as const;
  if (binding.some((key) => previous[key] !== next[key]))
    throw new Error("Merge action binding changed.");
  if (previous.state === next.state) return;
  if (previous.state === "intentRecorded" && next.state === "dispatchAttempted")
    return;
  if (
    previous.state === "dispatchAttempted" &&
    (next.state === "dispatchConfirmed" ||
      next.state === "dispatchFailed" ||
      next.state === "outcomeUnknown")
  )
    return;
  if (previous.state === "outcomeUnknown" && next.state === "dispatchConfirmed")
    return;
  throw new Error(
    `Illegal merge action transition ${previous.state} -> ${next.state}.`
  );
}

function validateDeliveryPullRequestReadyTransition(
  previous: DeliveryPullRequestReadyReceipt | undefined,
  next: DeliveryPullRequestReadyReceipt
) {
  if (previous === undefined) {
    if (next.state !== "intentRecorded") {
      throw new Error("Ready-for-review action must begin with intent.");
    }
    return;
  }
  const binding = [
    "actionId",
    "branchName",
    "expectedHeadSha",
    "payloadDigest",
    "prNumber",
    "prUrl",
    "publicationOperationId",
    "publicationPayloadDigest",
    "repository",
    "runId",
    "version",
  ] as const;
  if (binding.some((key) => previous[key] !== next[key])) {
    throw new Error("Ready-for-review action binding changed.");
  }
  if (previous.state === next.state) return;
  if (
    previous.state === "intentRecorded" &&
    (next.state === "dispatchAttempted" ||
      next.state === "confirmedWithoutDispatch")
  )
    return;
  if (
    previous.state === "dispatchAttempted" &&
    (next.state === "dispatchConfirmed" ||
      next.state === "dispatchFailed" ||
      next.state === "outcomeUnknown")
  )
    return;
  if (
    (previous.state === "outcomeUnknown" ||
      previous.state === "dispatchFailed") &&
    next.state === "dispatchConfirmed"
  )
    return;
  throw new Error(
    `Illegal ready-for-review action transition ${previous.state} -> ${next.state}.`
  );
}

function isActiveReadyForReviewState(
  state: DeliveryPullRequestReadyReceipt["state"]
) {
  return (
    state === "intentRecorded" ||
    state === "dispatchAttempted" ||
    state === "outcomeUnknown"
  );
}

export function deriveDeliveryActionHistoriesFromEvents(
  events: ReadonlyArray<RunEvent>
) {
  return {
    cleanup: deriveDeliveryCleanupActionHistories(
      events.flatMap((event) =>
        event.type === "DELIVERY_CLEANUP_RECORDED"
          ? [
              {
                receipt: parseDeliveryCleanupReceipt(event.payload["cleanup"]),
                sequence: event.sequence,
              },
            ]
          : []
      )
    ),
    localReviewAttestation: deriveDeliveryLocalReviewAttestationHistories(
      events.flatMap((event) =>
        event.type === "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED"
          ? [
              {
                receipt: parseDeliveryLocalReviewAttestationReceipt(
                  event.payload["attestation"]
                ),
                sequence: event.sequence,
              },
            ]
          : []
      )
    ),
    merge: deriveDeliveryMergeActionHistories(
      events.flatMap((event) =>
        event.type === "DELIVERY_MERGE_RECORDED"
          ? [
              {
                receipt: parseDeliveryMergeReceipt(
                  event.payload["mergeAction"]
                ),
                sequence: event.sequence,
              },
            ]
          : []
      )
    ),
    readyForReview: deriveDeliveryPullRequestReadyActionHistories(
      events.flatMap((event) =>
        event.type === "DELIVERY_PR_READY_RECORDED"
          ? [
              {
                receipt: parseDeliveryPullRequestReadyReceipt(
                  event.payload["readyForReviewAction"]
                ),
                sequence: event.sequence,
              },
            ]
          : []
      )
    ),
  };
}
