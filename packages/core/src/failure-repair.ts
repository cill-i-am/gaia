import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import { FailureStageSchema } from "./failure-stage.js";
import type { ClaimEvidenceV2 } from "./run-contract-v2.js";
import {
  canonicalV1,
  ContentDigestSchema,
  ProofClaimIdSchema,
  ProofEvidenceIdSchema,
  RunEventSequenceSchema,
  RunRelativeArtifactPathSchema,
} from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";
import {
  VerificationCommandTerminalStatusSchema,
  VerificationReceiptDigestSchema,
  VerificationRequestDigestSchema,
} from "./verification-command.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** Stable identity for one class of failed claim or action. */
export const FailureFingerprintSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  Schema.brand("FailureFingerprint")
);

/** Stable failure classifications currently owned by the repair policy. */
export const FailureTagSchema = Schema.Literals([
  "externalOutcomeUnknown",
  "nonRepairableFailure",
  "verificationClaimFailed",
] as const);

/** Finite policy classification for whether a failed operation can be repaired. */
export const FailureRetryabilitySchema = Schema.Literals([
  "notRepairable",
  "reconciliationRequired",
  "repairable",
] as const);

/** Finite certainty classification for the failed operation outcome. */
export const FailureOutcomeCertaintySchema = Schema.Literals([
  "confirmed",
  "unknown",
] as const);

/** Finite next-action vocabulary for failure handling. */
export const FailureRepairDecisionSchema = Schema.Literals([
  "retry",
  "repair",
  "reconciliation",
  "escalation",
] as const);

/** Exact claim reference owned by one failure digest. */
export class FailureClaimRefV1 extends Schema.Class<FailureClaimRefV1>(
  "FailureClaimRefV1"
)(
  {
    claimId: ProofClaimIdSchema,
    kind: Schema.Literal("claim"),
  },
  strict
) {}

/** Exact action reference owned by one failure digest. */
export class FailureActionRefV1 extends Schema.Class<FailureActionRefV1>(
  "FailureActionRefV1"
)(
  {
    actionId: Schema.NonEmptyString.pipe(
      Schema.check(
        Schema.isMaxLength(200),
        Schema.isPattern(/^[A-Za-z0-9:_-]+$/u)
      )
    ),
    actionKind: Schema.Literal("externalMutation"),
    kind: Schema.Literal("action"),
  },
  strict
) {}

/** Exact failed claim or action reference. */
export const FailureRefV1Schema = Schema.Union([
  FailureClaimRefV1,
  FailureActionRefV1,
]);

/** Compact, typed pointer to safe artifact proof evidence. */
export class FailureEvidenceRefV1 extends Schema.Class<FailureEvidenceRefV1>(
  "FailureEvidenceRefV1"
)(
  {
    artifactPath: RunRelativeArtifactPathSchema,
    contentDigest: ContentDigestSchema,
    evidenceId: ProofEvidenceIdSchema,
    kind: Schema.Literal("artifact-integrity"),
  },
  strict
) {}

/** Allowlisted command identity and receipt pointer for one failed claim. */
export class FailureCommandEvidenceV1 extends Schema.Class<FailureCommandEvidenceV1>(
  "FailureCommandEvidenceV1"
)(
  {
    evidenceId: ProofEvidenceIdSchema,
    kind: Schema.Literal("command"),
    receiptDigest: VerificationReceiptDigestSchema,
    requestDigest: VerificationRequestDigestSchema,
    status: VerificationCommandTerminalStatusSchema,
    terminalSequence: RunEventSequenceSchema,
  },
  strict
) {}

/** Compact safe evidence representation accepted by a failure digest. */
export const FailureEvidenceV1Schema = Schema.Union([
  FailureEvidenceRefV1,
  FailureCommandEvidenceV1,
]);

const parseFailureEvidenceV1 = Schema.decodeUnknownSync(
  FailureEvidenceV1Schema
);

/**
 * Leaves enough room inside the 16 KiB model task-input ceiling for the fixed
 * repair instructions and exact failure binding.
 */
export const FAILURE_REPAIR_EVIDENCE_INPUT_BUDGET_BYTES = 12_000;

/** Render only the allowlisted fields owned by the compact evidence schema. */
export function renderFailureEvidenceV1(
  evidence: typeof FailureEvidenceV1Schema.Type
): ReadonlyArray<string> {
  return evidence.kind === "command"
    ? [
        `Evidence ID: ${evidence.evidenceId}.`,
        `Request digest: ${evidence.requestDigest}.`,
        `Receipt digest: ${evidence.receiptDigest}.`,
        `Command status: ${evidence.status}.`,
        `Terminal sequence: ${evidence.terminalSequence}.`,
      ]
    : [
        `Evidence ID: ${evidence.evidenceId}.`,
        `Artifact path: ${evidence.artifactPath}.`,
        `Content digest: ${evidence.contentDigest}.`,
      ];
}

/**
 * Deterministically project authoritative V2 proof evidence into the bounded
 * safe representation accepted by a failure digest and repair prompt.
 */
export function projectFailureEvidenceV1(
  evidenceEntries: ReadonlyArray<ClaimEvidenceV2>
): ReadonlyArray<typeof FailureEvidenceV1Schema.Type> {
  const projected: Array<typeof FailureEvidenceV1Schema.Type> = [];
  let renderedBytes = 0;
  const offer = (input: unknown) => {
    if (projected.length === 8) return;
    const candidate = parseFailureEvidenceV1(input);
    const candidateBytes =
      utf8ToBytes(renderFailureEvidenceV1(candidate).join("\n")).byteLength + 1;
    if (
      renderedBytes + candidateBytes >
      FAILURE_REPAIR_EVIDENCE_INPUT_BUDGET_BYTES
    )
      return;
    projected.push(candidate);
    renderedBytes += candidateBytes;
  };

  for (const evidence of evidenceEntries) {
    if (evidence.kind === "artifact-integrity") {
      for (const artifact of evidence.artifacts)
        offer({
          artifactPath: artifact.path,
          contentDigest: artifact.contentDigest,
          evidenceId: evidence.evidenceId,
          kind: evidence.kind,
        });
    } else if (evidence.kind === "command")
      offer({
        evidenceId: evidence.evidenceId,
        kind: evidence.kind,
        receiptDigest: evidence.receiptDigest,
        requestDigest: evidence.requestDigest,
        status: evidence.status,
        terminalSequence: evidence.terminalSequence,
      });
    if (projected.length === 8) break;
  }
  return projected;
}

/** Compare a persisted projection with its authoritative V2 proof evidence. */
export function matchesFailureEvidenceProjectionV1(
  evidenceRefs: ReadonlyArray<typeof FailureEvidenceV1Schema.Type>,
  authoritativeEvidence: ReadonlyArray<ClaimEvidenceV2>
): boolean {
  const digest = (value: ReadonlyArray<typeof FailureEvidenceV1Schema.Type>) =>
    bytesToHex(
      sha256(canonicalV1("gaia.failure-evidence-projection.v1", [value]))
    );
  return (
    digest(evidenceRefs) ===
    digest(projectFailureEvidenceV1(authoritativeEvidence))
  );
}

/** Bounded, serializable failure evidence and policy decision. */
export class FailureDigestV1 extends Schema.Class<FailureDigestV1>(
  "FailureDigestV1"
)(
  {
    attempt: Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 2 }))
    ),
    evidenceRefs: Schema.Array(FailureEvidenceV1Schema).pipe(
      Schema.check(Schema.isMaxLength(8))
    ),
    failedRef: FailureRefV1Schema,
    fingerprint: FailureFingerprintSchema,
    maxAttempts: Schema.Literal(2),
    nextSafeAction: FailureRepairDecisionSchema,
    outcomeCertainty: FailureOutcomeCertaintySchema,
    retryability: FailureRetryabilitySchema,
    safeSummary: Schema.Literals([
      "Exact verification claim failed.",
      "External action outcome is unknown.",
      "Failure requires operator escalation.",
    ] as const),
    stage: FailureStageSchema,
    tag: FailureTagSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

const FailureRepairEpisodeKeySchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(96),
    Schema.isPattern(/^failureRepair:[a-f0-9]{64}:[12]$/u)
  )
);
const FailureRepairCodeSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(120),
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9]*$/u)
  )
);
const FailureRepairMessageSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(512))
);
const failureRepairBase = {
  digest: FailureDigestV1,
  episodeKey: FailureRepairEpisodeKeySchema,
  failedProofResultSequence: RunEventSequenceSchema,
  runId: RunIdSchema,
} as const;

/** Durable intent for one bounded failure-repair attempt. */
export class FailureRepairIntent extends Schema.Class<FailureRepairIntent>(
  "FailureRepairIntent"
)(
  {
    ...failureRepairBase,
    state: Schema.Literal("intentRecorded"),
  },
  strict
) {}

/** Durable evidence that one repair provider action is about to be sent. */
export class FailureRepairDispatchAttempted extends Schema.Class<FailureRepairDispatchAttempted>(
  "FailureRepairDispatchAttempted"
)(
  {
    ...failureRepairBase,
    state: Schema.Literal("dispatchAttempted"),
  },
  strict
) {}

/** Durable evidence that the new repair turn reached one completed terminal. */
export class FailureRepairTurnCompleted extends Schema.Class<FailureRepairTurnCompleted>(
  "FailureRepairTurnCompleted"
)(
  {
    ...failureRepairBase,
    state: Schema.Literal("turnCompleted"),
    terminalEventSequence: RunEventSequenceSchema,
  },
  strict
) {}

/** Durable evidence that fresh exact-claim verification passed after repair. */
export class FailureRepairVerified extends Schema.Class<FailureRepairVerified>(
  "FailureRepairVerified"
)(
  {
    ...failureRepairBase,
    proofResultSequence: RunEventSequenceSchema,
    state: Schema.Literal("verified"),
  },
  strict
) {}

/** Terminal evidence that newer authoritative proof already passed the claim. */
export class FailureRepairSuperseded extends Schema.Class<FailureRepairSuperseded>(
  "FailureRepairSuperseded"
)(
  {
    ...failureRepairBase,
    proofResultSequence: RunEventSequenceSchema,
    state: Schema.Literal("superseded"),
  },
  strict
) {}

/** Durable conclusive failure for a repair attempt. */
export class FailureRepairFailed extends Schema.Class<FailureRepairFailed>(
  "FailureRepairFailed"
)(
  {
    ...failureRepairBase,
    code: FailureRepairCodeSchema,
    message: FailureRepairMessageSchema,
    proofResultSequence: Schema.optionalKey(RunEventSequenceSchema),
    state: Schema.Literal("failed"),
  },
  strict
) {}

/** Terminal policy truth for an ambiguous provider action outcome. */
export class FailureOutcomeUnknownPolicyV1 extends Schema.Class<FailureOutcomeUnknownPolicyV1>(
  "FailureOutcomeUnknownPolicyV1"
)(
  {
    nextSafeAction: Schema.Literal("reconciliation"),
    outcomeCertainty: Schema.Literal("unknown"),
    retryability: Schema.Literal("reconciliationRequired"),
    tag: Schema.Literal("externalOutcomeUnknown"),
    version: Schema.Literal(1),
  },
  strict
) {}

/** Canonical terminal policy for an ambiguous provider action outcome. */
export const failureOutcomeUnknownPolicyV1 = FailureOutcomeUnknownPolicyV1.make(
  {
    nextSafeAction: "reconciliation",
    outcomeCertainty: "unknown",
    retryability: "reconciliationRequired",
    tag: "externalOutcomeUnknown",
    version: 1,
  }
);

/** Sticky terminal state for an ambiguous repair provider outcome. */
export class FailureRepairOutcomeUnknown extends Schema.Class<FailureRepairOutcomeUnknown>(
  "FailureRepairOutcomeUnknown"
)(
  {
    ...failureRepairBase,
    code: FailureRepairCodeSchema,
    message: FailureRepairMessageSchema,
    state: Schema.Literal("outcomeUnknown"),
    terminalPolicy: FailureOutcomeUnknownPolicyV1,
  },
  strict
) {}

/** Terminal evidence that the persisted fingerprint budget is exhausted. */
export class FailureRepairExhausted extends Schema.Class<FailureRepairExhausted>(
  "FailureRepairExhausted"
)(
  {
    ...failureRepairBase,
    state: Schema.Literal("exhausted"),
  },
  strict
) {}

/** Durable failure-repair receipt family. */
export const FailureRepairReceiptSchema = Schema.Union([
  FailureRepairIntent,
  FailureRepairDispatchAttempted,
  FailureRepairTurnCompleted,
  FailureRepairVerified,
  FailureRepairSuperseded,
  FailureRepairFailed,
  FailureRepairOutcomeUnknown,
  FailureRepairExhausted,
]);

/** Durable failure-repair receipt. */
export type FailureRepairReceipt = typeof FailureRepairReceiptSchema.Type;

/** Decide from an origin failure digest or terminal unknown-outcome receipt. */
export function decideFailureRepair(
  input: FailureDigestV1 | FailureRepairOutcomeUnknown
): typeof FailureRepairDecisionSchema.Type {
  return "terminalPolicy" in input
    ? input.terminalPolicy.nextSafeAction
    : input.nextSafeAction;
}

const MakeFailureDigestV1InputSchema = Schema.Struct({
  attempt: FailureDigestV1.fields.attempt,
  evidenceRefs: FailureDigestV1.fields.evidenceRefs,
  failedRef: FailureDigestV1.fields.failedRef,
  maxAttempts: FailureDigestV1.fields.maxAttempts,
  outcomeCertainty: FailureDigestV1.fields.outcomeCertainty,
  retryability: FailureDigestV1.fields.retryability,
  stage: FailureDigestV1.fields.stage,
  tag: FailureDigestV1.fields.tag,
});
const decodeMakeFailureDigestV1Input = Schema.decodeUnknownSync(
  MakeFailureDigestV1InputSchema,
  { onExcessProperty: "error" }
);
const decodeFailureDigestV1 = Schema.decodeUnknownSync(FailureDigestV1, {
  onExcessProperty: "error",
});
const decodeFailureRepairReceipt = Schema.decodeUnknownSync(
  FailureRepairReceiptSchema,
  { onExcessProperty: "error" }
);
const parseFailureFingerprint = Schema.decodeUnknownSync(
  FailureFingerprintSchema
);

/** Encode one validated failure digest as plain JSON-safe data. */
export const encodeFailureDigestV1Json = Schema.encodeSync(
  Schema.toCodecJson(FailureDigestV1)
);
export const encodeFailureRepairReceiptJson = Schema.encodeSync(
  Schema.toCodecJson(FailureRepairReceiptSchema)
);

/** Create one self-consistent bounded failure digest from parsed safe fields. */
export function makeFailureDigestV1(
  input: typeof MakeFailureDigestV1InputSchema.Encoded
): FailureDigestV1 {
  const decoded = decodeMakeFailureDigestV1Input(input);
  assertClassification(decoded);
  const nextSafeAction = decideDecodedFailureRepair(decoded);
  const fingerprint = parseFailureFingerprint(
    bytesToHex(
      sha256(
        canonicalV1("gaia.failure-fingerprint.v1", [
          decoded.failedRef,
          decoded.stage,
          decoded.tag,
        ])
      )
    )
  );
  return FailureDigestV1.make({
    ...decoded,
    fingerprint,
    nextSafeAction,
    safeSummary:
      decoded.tag === "verificationClaimFailed"
        ? "Exact verification claim failed."
        : decoded.tag === "externalOutcomeUnknown"
          ? "External action outcome is unknown."
          : "Failure requires operator escalation.",
    version: 1,
  });
}

/** Parse and self-authenticate a persisted failure digest. */
export function parseFailureDigestV1(input: unknown): FailureDigestV1 {
  const decoded = decodeFailureDigestV1(input);
  const expected = makeFailureDigestV1({
    attempt: decoded.attempt,
    evidenceRefs: decoded.evidenceRefs,
    failedRef: decoded.failedRef,
    maxAttempts: decoded.maxAttempts,
    outcomeCertainty: decoded.outcomeCertainty,
    retryability: decoded.retryability,
    stage: decoded.stage,
    tag: decoded.tag,
  });
  if (
    decoded.fingerprint !== expected.fingerprint ||
    decoded.nextSafeAction !== expected.nextSafeAction ||
    decoded.safeSummary !== expected.safeSummary
  )
    throw new Error("Failure digest policy fields failed self-authentication.");
  return decoded;
}

/** Parse and self-authenticate one persisted failure-repair receipt. */
export function parseFailureRepairReceipt(
  input: unknown
): FailureRepairReceipt {
  const decoded = decodeFailureRepairReceipt(input);
  const digest = parseFailureDigestV1(decoded.digest);
  if (
    decoded.episodeKey !==
    `failureRepair:${digest.fingerprint}:${digest.attempt}`
  )
    throw new Error("Failure-repair episode key does not bind its digest.");
  return decoded;
}

/** Enforce the monotonic two-attempt failure-repair lifecycle. */
export function validateFailureRepairTransition(
  previousInput: FailureRepairReceipt | undefined,
  nextInput: FailureRepairReceipt
): void {
  const next = parseFailureRepairReceipt(nextInput);
  if (previousInput === undefined) {
    if (next.state !== "intentRecorded")
      throw new Error("Failure repair must begin with an intent.");
    return;
  }
  const previous = parseFailureRepairReceipt(previousInput);
  if (previous.runId !== next.runId)
    throw new Error("Failure-repair receipts belong to different runs.");

  if (
    previous.state === "failed" &&
    next.state === "intentRecorded" &&
    previous.digest.attempt < previous.digest.maxAttempts &&
    next.digest.attempt === previous.digest.attempt + 1 &&
    previous.digest.fingerprint === next.digest.fingerprint &&
    previous.proofResultSequence !== undefined &&
    next.failedProofResultSequence >= previous.proofResultSequence
  )
    return;

  assertSameFailureRepairAttempt(previous, next);
  const allowed =
    (previous.state === "intentRecorded" &&
      (next.state === "dispatchAttempted" || next.state === "failed")) ||
    (previous.state === "dispatchAttempted" &&
      (next.state === "turnCompleted" || next.state === "outcomeUnknown")) ||
    (previous.state === "turnCompleted" &&
      (next.state === "verified" || next.state === "failed")) ||
    (previous.state === "failed" &&
      next.state === "superseded" &&
      previous.proofResultSequence !== undefined) ||
    (previous.state === "failed" &&
      previous.digest.attempt === previous.digest.maxAttempts &&
      next.state === "exhausted");
  if (!allowed)
    throw new Error(
      `Failure repair cannot transition from ${previous.state} to ${next.state}.`
    );
  if (
    next.state === "turnCompleted" &&
    next.terminalEventSequence <= next.failedProofResultSequence
  )
    throw new Error("Repair terminal evidence must follow the failed proof.");
  if (
    (next.state === "verified" || next.state === "failed") &&
    next.proofResultSequence !== undefined &&
    previous.state === "turnCompleted" &&
    next.proofResultSequence <= previous.terminalEventSequence
  )
    throw new Error("Fresh proof must follow the completed repair turn.");
  if (
    next.state === "superseded" &&
    previous.state === "failed" &&
    previous.proofResultSequence !== undefined &&
    next.proofResultSequence <= previous.proofResultSequence
  )
    throw new Error("Superseding proof must follow the failed repair proof.");
}

function assertClassification(
  input: typeof MakeFailureDigestV1InputSchema.Type
) {
  const consistent =
    (input.tag === "verificationClaimFailed" &&
      input.failedRef.kind === "claim" &&
      input.outcomeCertainty === "confirmed" &&
      input.retryability === "repairable") ||
    (input.tag === "externalOutcomeUnknown" &&
      input.failedRef.kind === "action" &&
      input.outcomeCertainty === "unknown" &&
      input.retryability === "reconciliationRequired") ||
    (input.tag === "nonRepairableFailure" &&
      input.outcomeCertainty === "confirmed" &&
      input.retryability === "notRepairable");
  if (!consistent)
    throw new Error("Failure classification fields are contradictory.");
}

function decideDecodedFailureRepair(
  input: typeof MakeFailureDigestV1InputSchema.Type
): typeof FailureRepairDecisionSchema.Type {
  if (input.outcomeCertainty === "unknown") return "reconciliation";
  return input.retryability === "repairable" ? "repair" : "escalation";
}

function assertSameFailureRepairAttempt(
  previous: FailureRepairReceipt,
  next: FailureRepairReceipt
) {
  if (
    previous.episodeKey !== next.episodeKey ||
    previous.failedProofResultSequence !== next.failedProofResultSequence ||
    JSON.stringify(encodeFailureDigestV1Json(previous.digest)) !==
      JSON.stringify(encodeFailureDigestV1Json(next.digest))
  )
    throw new Error("Failure-repair immutable binding changed.");
}
