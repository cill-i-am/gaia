import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import type { RunEvent } from "./events.js";
import {
  parseFailureRepairReceipt,
  type FailureRepairReceipt,
} from "./failure-repair.js";
import { canonicalV1, RunEventSequenceSchema } from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const LowerSha256Schema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
);
const BoundedIdentifierSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(192),
    Schema.isPattern(/^[A-Za-z0-9@][A-Za-z0-9._@/:-]*$/u)
  )
);
const ReviewedTextSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(768)),
  Schema.brand("FactoryLessonReviewedText")
);
const TimestampSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  )
);

export const FactoryLessonCandidateDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("FactoryLessonCandidateDigest")
);
export const FactoryLessonProjectionDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("FactoryLessonProjectionDigest")
);
export const FactoryLessonReviewDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("FactoryLessonReviewDigest")
);
export const FactoryLessonAttestationDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("FactoryLessonAttestationDigest")
);
export const FactoryLessonSelectionDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("FactoryLessonSelectionDigest")
);
export const FactoryLessonIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^lesson1_[a-f0-9]{64}$/u)),
  Schema.brand("FactoryLessonId")
);
export const FactoryLessonReviewerRefSchema = BoundedIdentifierSchema.pipe(
  Schema.brand("FactoryLessonReviewerRef")
);
export const FactoryLessonOwnerRefSchema = BoundedIdentifierSchema.pipe(
  Schema.brand("FactoryLessonOwnerRef")
);

export const FACTORY_LESSON_REVIEWED_FIELDS_V1 = [
  "compactLesson",
  "expectedEffect",
  "retirementCondition",
] as const;
export const MAXIMUM_RECORDED_FACTORY_LESSON_OMISSIONS_V1 = 1_024;

export class FactoryLessonApplicabilityV1 extends Schema.Class<FactoryLessonApplicabilityV1>(
  "FactoryLessonApplicabilityV1"
)(
  {
    episodeRole: Schema.Literal("workerInitial"),
    version: Schema.Literal(1),
  },
  strict
) {}

const lessonFields = {
  applicability: FactoryLessonApplicabilityV1,
  carryingCostOwner: FactoryLessonOwnerRefSchema,
  compactLesson: ReviewedTextSchema,
  durableOwner: FactoryLessonOwnerRefSchema,
  durableOwnerDigest: LowerSha256Schema,
  durableOwnerVersion: BoundedIdentifierSchema,
  expectedEffect: ReviewedTextSchema,
  retirementCondition: ReviewedTextSchema,
  version: Schema.Literal(1),
} as const;

export class FactoryLessonCandidateV1 extends Schema.Class<FactoryLessonCandidateV1>(
  "FactoryLessonCandidateV1"
)(
  {
    candidateDigest: FactoryLessonCandidateDigestSchema,
    ...lessonFields,
  },
  strict
) {}

export class FactoryLessonProjectionV1 extends Schema.Class<FactoryLessonProjectionV1>(
  "FactoryLessonProjectionV1"
)(
  {
    candidateDigest: FactoryLessonCandidateDigestSchema,
    ...lessonFields,
    lessonId: FactoryLessonIdSchema,
    projectionDigest: FactoryLessonProjectionDigestSchema,
  },
  strict
) {}

export class NoRawTelemetryAttestationV1 extends Schema.Class<NoRawTelemetryAttestationV1>(
  "NoRawTelemetryAttestationV1"
)(
  {
    attestationDigest: FactoryLessonAttestationDigestSchema,
    candidateDigest: FactoryLessonCandidateDigestSchema,
    conclusion: Schema.Literal("containsNoRawTelemetry"),
    reviewedFields: Schema.Tuple([
      Schema.Literal("compactLesson"),
      Schema.Literal("expectedEffect"),
      Schema.Literal("retirementCondition"),
    ]),
    reviewerRef: FactoryLessonReviewerRefSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

export class FactoryLessonFailureSourceV1 extends Schema.Class<FactoryLessonFailureSourceV1>(
  "FactoryLessonFailureSourceV1"
)(
  {
    eventSequence: RunEventSequenceSchema,
    failureFingerprint: LowerSha256Schema,
    runId: RunIdSchema,
    type: Schema.Literal("FAILURE_REPAIR_RECORDED"),
    version: Schema.Literal(1),
  },
  strict
) {}

const acceptedReviewFields = {
  attestation: NoRawTelemetryAttestationV1,
  candidateDigest: FactoryLessonCandidateDigestSchema,
  decision: Schema.Literal("accepted"),
  projection: FactoryLessonProjectionV1,
  reviewDigest: FactoryLessonReviewDigestSchema,
  source: FactoryLessonFailureSourceV1,
  version: Schema.Literal(1),
} as const;

export class FactoryLessonAcceptedReviewV1 extends Schema.Class<FactoryLessonAcceptedReviewV1>(
  "FactoryLessonAcceptedReviewV1"
)(acceptedReviewFields, strict) {}

const rejectedReasonSchema = Schema.Literals([
  "carryingCostUnowned",
  "duplicatesExistingIntent",
  "insufficientEvidence",
] as const);
const deferredReasonSchema = Schema.Literals([
  "awaitingApplicabilityEvidence",
  "awaitingRetirementOwner",
  "promotionDeferred",
] as const);

export class FactoryLessonRejectedReviewV1 extends Schema.Class<FactoryLessonRejectedReviewV1>(
  "FactoryLessonRejectedReviewV1"
)(
  {
    candidateDigest: FactoryLessonCandidateDigestSchema,
    decision: Schema.Literal("rejected"),
    reason: rejectedReasonSchema,
    reviewDigest: FactoryLessonReviewDigestSchema,
    reviewerRef: FactoryLessonReviewerRefSchema,
    source: FactoryLessonFailureSourceV1,
    version: Schema.Literal(1),
  },
  strict
) {}

export class FactoryLessonDeferredReviewV1 extends Schema.Class<FactoryLessonDeferredReviewV1>(
  "FactoryLessonDeferredReviewV1"
)(
  {
    candidateDigest: FactoryLessonCandidateDigestSchema,
    decision: Schema.Literal("deferred"),
    reason: deferredReasonSchema,
    reviewDigest: FactoryLessonReviewDigestSchema,
    reviewerRef: FactoryLessonReviewerRefSchema,
    source: FactoryLessonFailureSourceV1,
    version: Schema.Literal(1),
  },
  strict
) {}

export class FactoryLessonProjectionRefV1 extends Schema.Class<FactoryLessonProjectionRefV1>(
  "FactoryLessonProjectionRefV1"
)(
  {
    lessonId: FactoryLessonIdSchema,
    projectionDigest: FactoryLessonProjectionDigestSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

export class FactoryLessonRetirementEvidenceV1 extends Schema.Class<FactoryLessonRetirementEvidenceV1>(
  "FactoryLessonRetirementEvidenceV1"
)(
  {
    kind: Schema.Literals(["linearComment", "ownerMigration", "test"] as const),
    ref: BoundedIdentifierSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

export class FactoryLessonSupersededReviewV1 extends Schema.Class<FactoryLessonSupersededReviewV1>(
  "FactoryLessonSupersededReviewV1"
)(
  {
    decision: Schema.Literal("superseded"),
    lessonId: FactoryLessonIdSchema,
    replacement: FactoryLessonProjectionRefV1,
    reviewDigest: FactoryLessonReviewDigestSchema,
    reviewerRef: FactoryLessonReviewerRefSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

export class FactoryLessonRetiredReviewV1 extends Schema.Class<FactoryLessonRetiredReviewV1>(
  "FactoryLessonRetiredReviewV1"
)(
  {
    decision: Schema.Literal("retired"),
    lessonId: FactoryLessonIdSchema,
    retirementEvidence: FactoryLessonRetirementEvidenceV1,
    reviewDigest: FactoryLessonReviewDigestSchema,
    reviewerRef: FactoryLessonReviewerRefSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

export const FactoryLessonReviewReceiptV1 = Schema.Union([
  FactoryLessonAcceptedReviewV1,
  FactoryLessonRejectedReviewV1,
  FactoryLessonDeferredReviewV1,
  FactoryLessonSupersededReviewV1,
  FactoryLessonRetiredReviewV1,
]);
export type FactoryLessonReviewReceiptV1 =
  typeof FactoryLessonReviewReceiptV1.Type;

const AcceptedReviewInput = Schema.Struct({
  attestation: NoRawTelemetryAttestationV1,
  candidate: FactoryLessonCandidateV1,
  decision: Schema.Literal("accepted"),
  source: FactoryLessonFailureSourceV1,
});
const RejectedReviewInput = Schema.Struct({
  candidateDigest: FactoryLessonCandidateDigestSchema,
  decision: Schema.Literal("rejected"),
  reason: rejectedReasonSchema,
  reviewerRef: FactoryLessonReviewerRefSchema,
  source: FactoryLessonFailureSourceV1,
});
const DeferredReviewInput = Schema.Struct({
  candidateDigest: FactoryLessonCandidateDigestSchema,
  decision: Schema.Literal("deferred"),
  reason: deferredReasonSchema,
  reviewerRef: FactoryLessonReviewerRefSchema,
  source: FactoryLessonFailureSourceV1,
});
const SupersededReviewInput = Schema.Struct({
  decision: Schema.Literal("superseded"),
  lessonId: FactoryLessonIdSchema,
  replacement: FactoryLessonProjectionRefV1,
  reviewerRef: FactoryLessonReviewerRefSchema,
});
const RetiredReviewInput = Schema.Struct({
  decision: Schema.Literal("retired"),
  lessonId: FactoryLessonIdSchema,
  retirementEvidence: FactoryLessonRetirementEvidenceV1,
  reviewerRef: FactoryLessonReviewerRefSchema,
});
export const FactoryLessonReviewInputV1 = Schema.Union([
  AcceptedReviewInput,
  RejectedReviewInput,
  DeferredReviewInput,
  SupersededReviewInput,
  RetiredReviewInput,
]);

const decodeCandidate = Schema.decodeUnknownSync(FactoryLessonCandidateV1);
const encodeCandidate = Schema.encodeSync(FactoryLessonCandidateV1);
const decodeProjection = Schema.decodeUnknownSync(FactoryLessonProjectionV1);
const encodeProjection = Schema.encodeSync(FactoryLessonProjectionV1);
const decodeAttestation = Schema.decodeUnknownSync(NoRawTelemetryAttestationV1);
const encodeAttestation = Schema.encodeSync(NoRawTelemetryAttestationV1);
const decodeReview = Schema.decodeUnknownSync(FactoryLessonReviewReceiptV1);
const encodeReview = Schema.encodeSync(FactoryLessonReviewReceiptV1);
const decodeReviewInput = Schema.decodeUnknownSync(FactoryLessonReviewInputV1, {
  onExcessProperty: "error",
});
const parseCandidateDigest = Schema.decodeUnknownSync(
  FactoryLessonCandidateDigestSchema
);
const parseProjectionDigest = Schema.decodeUnknownSync(
  FactoryLessonProjectionDigestSchema
);
const parseAttestationDigest = Schema.decodeUnknownSync(
  FactoryLessonAttestationDigestSchema
);
const parseReviewDigest = Schema.decodeUnknownSync(
  FactoryLessonReviewDigestSchema
);
const parseLessonId = Schema.decodeUnknownSync(FactoryLessonIdSchema);
const parseSelectionDigest = Schema.decodeUnknownSync(
  FactoryLessonSelectionDigestSchema
);

function digest(domain: string, value: unknown) {
  return bytesToHex(sha256(canonicalV1(domain, [value])));
}

function assertReviewedText(
  value: typeof ReviewedTextSchema.Type,
  field: (typeof FACTORY_LESSON_REVIEWED_FIELDS_V1)[number]
) {
  if (
    !value.isWellFormed() ||
    utf8ToBytes(value).byteLength > 768 ||
    /[\r\n]/u.test(value)
  )
    throw new Error(
      `Factory lesson ${field} must be well-formed, one-line, bounded reviewed text.`
    );
}

function candidateBody(
  input: Omit<typeof FactoryLessonCandidateV1.Type, "candidateDigest">
) {
  return {
    applicability: input.applicability,
    carryingCostOwner: input.carryingCostOwner,
    compactLesson: input.compactLesson,
    durableOwner: input.durableOwner,
    durableOwnerDigest: input.durableOwnerDigest,
    durableOwnerVersion: input.durableOwnerVersion,
    expectedEffect: input.expectedEffect,
    retirementCondition: input.retirementCondition,
    version: input.version,
  };
}

export function makeFactoryLessonCandidateV1(
  input: Omit<typeof FactoryLessonCandidateV1.Encoded, "candidateDigest">
) {
  const decoded = Schema.decodeUnknownSync(Schema.Struct(lessonFields), {
    onExcessProperty: "error",
  })(input);
  for (const field of FACTORY_LESSON_REVIEWED_FIELDS_V1)
    assertReviewedText(decoded[field], field);
  return decodeCandidate({
    ...decoded,
    candidateDigest: parseCandidateDigest(
      digest("gaia.factory-lesson-candidate.v1", decoded)
    ),
  });
}

export function parseFactoryLessonCandidateV1(input: unknown) {
  const candidate = decodeCandidate(input);
  const expected = makeFactoryLessonCandidateV1(candidateBody(candidate));
  if (candidate.candidateDigest !== expected.candidateDigest)
    throw new Error("Factory lesson candidate failed self-authentication.");
  return candidate;
}

export function makeNoRawTelemetryAttestationV1(input: {
  readonly candidateDigest: typeof FactoryLessonCandidateDigestSchema.Encoded;
  readonly reviewerRef: typeof FactoryLessonReviewerRefSchema.Encoded;
}) {
  const body = {
    candidateDigest: parseCandidateDigest(input.candidateDigest),
    conclusion: "containsNoRawTelemetry" as const,
    reviewedFields: FACTORY_LESSON_REVIEWED_FIELDS_V1,
    reviewerRef: Schema.decodeUnknownSync(FactoryLessonReviewerRefSchema)(
      input.reviewerRef
    ),
    version: 1 as const,
  };
  return decodeAttestation({
    ...body,
    attestationDigest: parseAttestationDigest(
      digest("gaia.factory-lesson-no-raw-telemetry-attestation.v1", body)
    ),
  });
}

export function parseNoRawTelemetryAttestationV1(input: unknown) {
  const attestation = decodeAttestation(input);
  const expected = makeNoRawTelemetryAttestationV1(attestation);
  if (attestation.attestationDigest !== expected.attestationDigest)
    throw new Error(
      "Factory lesson no-raw-telemetry attestation failed self-authentication."
    );
  return attestation;
}

function makeProjection(
  candidateInput: FactoryLessonCandidateV1,
  attestationInput: NoRawTelemetryAttestationV1
) {
  const candidate = parseFactoryLessonCandidateV1(candidateInput);
  const attestation = parseNoRawTelemetryAttestationV1(attestationInput);
  if (attestation.candidateDigest !== candidate.candidateDigest)
    throw new Error("Factory lesson attestation belongs to another candidate.");
  const body = {
    ...candidateBody(candidate),
    candidateDigest: candidate.candidateDigest,
  };
  const projectionDigest = parseProjectionDigest(
    digest("gaia.factory-lesson-projection.v1", body)
  );
  return decodeProjection({
    ...body,
    lessonId: parseLessonId(`lesson1_${projectionDigest}`),
    projectionDigest,
  });
}

export function parseFactoryLessonProjectionV1(input: unknown) {
  const projection = decodeProjection(input);
  const candidate = parseFactoryLessonCandidateV1({
    ...candidateBody(projection),
    candidateDigest: projection.candidateDigest,
  });
  const body = {
    ...candidateBody(candidate),
    candidateDigest: candidate.candidateDigest,
  };
  const projectionDigest = parseProjectionDigest(
    digest("gaia.factory-lesson-projection.v1", body)
  );
  if (
    projection.projectionDigest !== projectionDigest ||
    projection.lessonId !== `lesson1_${projectionDigest}`
  )
    throw new Error("Factory lesson projection failed self-authentication.");
  return projection;
}

function reviewDigest(input: unknown) {
  return parseReviewDigest(
    digest("gaia.factory-lesson-review-receipt.v1", input)
  );
}

export function makeFactoryLessonReviewReceiptV1(
  input: typeof FactoryLessonReviewInputV1.Encoded
): FactoryLessonReviewReceiptV1 {
  const decoded = decodeReviewInput(input);
  if (decoded.decision === "accepted") {
    const candidate = parseFactoryLessonCandidateV1(decoded.candidate);
    const attestation = parseNoRawTelemetryAttestationV1(decoded.attestation);
    const projection = makeProjection(candidate, attestation);
    const body = {
      attestation: encodeAttestation(attestation),
      candidateDigest: candidate.candidateDigest,
      decision: decoded.decision,
      projection: encodeProjection(projection),
      source: decoded.source,
      version: 1 as const,
    };
    return decodeReview({ ...body, reviewDigest: reviewDigest(body) });
  }
  const body =
    decoded.decision === "rejected" || decoded.decision === "deferred"
      ? {
          candidateDigest: decoded.candidateDigest,
          decision: decoded.decision,
          reason: decoded.reason,
          reviewerRef: decoded.reviewerRef,
          source: decoded.source,
          version: 1 as const,
        }
      : decoded.decision === "superseded"
        ? {
            decision: decoded.decision,
            lessonId: decoded.lessonId,
            replacement: decoded.replacement,
            reviewerRef: decoded.reviewerRef,
            version: 1 as const,
          }
        : {
            decision: decoded.decision,
            lessonId: decoded.lessonId,
            retirementEvidence: decoded.retirementEvidence,
            reviewerRef: decoded.reviewerRef,
            version: 1 as const,
          };
  return decodeReview({ ...body, reviewDigest: reviewDigest(body) });
}

export function parseFactoryLessonReviewReceiptV1(input: unknown) {
  const receipt = decodeReview(input);
  let expected: FactoryLessonReviewReceiptV1;
  if (receipt.decision === "accepted")
    expected = makeFactoryLessonReviewReceiptV1({
      attestation: receipt.attestation,
      candidate: {
        ...candidateBody(receipt.projection),
        candidateDigest: receipt.projection.candidateDigest,
      },
      decision: receipt.decision,
      source: receipt.source,
    });
  else if (receipt.decision === "rejected")
    expected = makeFactoryLessonReviewReceiptV1({
      candidateDigest: receipt.candidateDigest,
      decision: receipt.decision,
      reason: receipt.reason,
      reviewerRef: receipt.reviewerRef,
      source: receipt.source,
    });
  else if (receipt.decision === "deferred")
    expected = makeFactoryLessonReviewReceiptV1({
      candidateDigest: receipt.candidateDigest,
      decision: receipt.decision,
      reason: receipt.reason,
      reviewerRef: receipt.reviewerRef,
      source: receipt.source,
    });
  else if (receipt.decision === "superseded")
    expected = makeFactoryLessonReviewReceiptV1({
      decision: receipt.decision,
      lessonId: receipt.lessonId,
      replacement: receipt.replacement,
      reviewerRef: receipt.reviewerRef,
    });
  else
    expected = makeFactoryLessonReviewReceiptV1({
      decision: receipt.decision,
      lessonId: receipt.lessonId,
      retirementEvidence: receipt.retirementEvidence,
      reviewerRef: receipt.reviewerRef,
    });
  if (
    receipt.reviewDigest !== expected.reviewDigest ||
    JSON.stringify(encodeReview(receipt)) !==
      JSON.stringify(encodeReview(expected))
  )
    throw new Error(
      "Factory lesson review receipt failed self-authentication."
    );
  return receipt;
}

export class FactoryLessonActiveV1 extends Schema.Class<FactoryLessonActiveV1>(
  "FactoryLessonActiveV1"
)(
  {
    acceptedAt: TimestampSchema,
    acceptedEventSequence: RunEventSequenceSchema,
    projection: FactoryLessonProjectionV1,
    sourceRunId: RunIdSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

export class FactoryLessonHistoryEntryV1 extends Schema.Class<FactoryLessonHistoryEntryV1>(
  "FactoryLessonHistoryEntryV1"
)(
  {
    eventSequence: RunEventSequenceSchema,
    eventTimestamp: TimestampSchema,
    receipt: FactoryLessonReviewReceiptV1,
    reviewDigest: FactoryLessonReviewDigestSchema,
    runId: RunIdSchema,
    state: Schema.Literals([
      "accepted",
      "rejected",
      "deferred",
      "superseded",
      "retired",
    ] as const),
    version: Schema.Literal(1),
  },
  strict
) {}

export class FactoryLessonReadModelV1 extends Schema.Class<FactoryLessonReadModelV1>(
  "FactoryLessonReadModelV1"
)(
  {
    active: Schema.Array(FactoryLessonActiveV1),
    history: Schema.Array(FactoryLessonHistoryEntryV1),
    version: Schema.Literal(1),
  },
  strict
) {}

function sourceKey(
  runId: typeof RunIdSchema.Type,
  sequence: typeof RunEventSequenceSchema.Type
) {
  return `${runId}\0${sequence}`;
}

function durableOwnerIdentity(projection: FactoryLessonProjectionV1) {
  return [
    projection.durableOwner,
    projection.durableOwnerVersion,
    projection.durableOwnerDigest,
  ].join("\0");
}

function validateFactoryLessonSelectionAgainstActive(
  event: RunEvent,
  active: ReadonlyMap<string, FactoryLessonActiveV1>,
  runCreatedAtById: ReadonlyMap<string, string>
) {
  const rawSelection = event.payload["factoryLessonContextSelection"];
  if (rawSelection === undefined) return;
  const selection = parseFactoryLessonContextSelectionV1(rawSelection);
  const targetCreatedAt = runCreatedAtById.get(selection.targetRunId);
  if (targetCreatedAt === undefined)
    throw new Error(
      "Factory lesson selection is missing its target run creation authority."
    );
  const eligible = [...active.values()].filter(
    ({ acceptedAt, sourceRunId }) =>
      acceptedAt < targetCreatedAt && sourceRunId !== event.runId
  );
  if (selection.eligibleLessonCount !== eligible.length)
    throw new Error(
      "Factory lesson selection does not bind the active accepted lesson set."
    );
  const eligibleById = new Map(
    eligible.map(({ projection }) => [projection.lessonId, projection])
  );
  for (const lesson of [
    ...selection.lessons,
    ...selection.omitted.map(({ lesson }) => lesson),
  ]) {
    const projection = eligibleById.get(lesson.lessonId);
    if (
      projection === undefined ||
      projection.projectionDigest !== lesson.projectionDigest
    )
      throw new Error(
        "Factory lesson selection references a lesson that was not active and accepted."
      );
  }
}

function projectFactoryLessonsInternal(
  events: ReadonlyArray<RunEvent>,
  validateSelections: boolean
): FactoryLessonReadModelV1 {
  const failureSources = new Map<string, FailureRepairReceipt>();
  const active = new Map<string, FactoryLessonActiveV1>();
  const candidateStates = new Map<
    string,
    "accepted" | "rejected" | "deferred"
  >();
  const runCreatedAtById = new Map<string, string>();
  const history: Array<FactoryLessonHistoryEntryV1> = [];

  for (const event of events) {
    if (event.type === "RUN_CREATED")
      runCreatedAtById.set(event.runId, event.timestamp);
    if (validateSelections)
      validateFactoryLessonSelectionAgainstActive(
        event,
        active,
        runCreatedAtById
      );
    if (event.type === "FAILURE_REPAIR_RECORDED") {
      failureSources.set(
        sourceKey(event.runId, event.sequence),
        parseFailureRepairReceipt(event.payload["failureRepair"])
      );
      continue;
    }
    if (event.type !== "FACTORY_LESSON_REVIEW_RECORDED") continue;
    const receipt = parseFactoryLessonReviewReceiptV1(
      event.payload["factoryLessonReview"]
    );
    if (
      receipt.decision === "accepted" ||
      receipt.decision === "rejected" ||
      receipt.decision === "deferred"
    ) {
      const source = failureSources.get(
        sourceKey(receipt.source.runId, receipt.source.eventSequence)
      );
      if (
        source === undefined ||
        receipt.source.runId !== event.runId ||
        source.digest.fingerprint !== receipt.source.failureFingerprint
      )
        throw new Error(
          "Factory lesson review does not bind exact prior failure-repair source evidence."
        );
      const priorState = candidateStates.get(receipt.candidateDigest);
      const legalInitialOrDeferredResolution =
        priorState === undefined ||
        (priorState === "deferred" &&
          (receipt.decision === "accepted" || receipt.decision === "rejected"));
      if (!legalInitialOrDeferredResolution)
        throw new Error(
          "Factory lesson candidate review violates its finite disposition lifecycle."
        );
      candidateStates.set(receipt.candidateDigest, receipt.decision);
      if (receipt.decision === "accepted") {
        const projection = parseFactoryLessonProjectionV1(receipt.projection);
        if (active.has(projection.lessonId))
          throw new Error("Factory lesson acceptance is duplicated.");
        const ownerIdentity = durableOwnerIdentity(projection);
        if (
          [...active.values()].some(
            ({ projection: existing }) =>
              durableOwnerIdentity(existing) === ownerIdentity
          )
        )
          throw new Error(
            "Factory lesson acceptance duplicates an active durable owner identity."
          );
        active.set(
          projection.lessonId,
          FactoryLessonActiveV1.make({
            acceptedAt: event.timestamp,
            acceptedEventSequence: event.sequence,
            projection,
            sourceRunId: event.runId,
            version: 1,
          })
        );
      }
    } else if (receipt.decision === "superseded") {
      const replacement = active.get(receipt.replacement.lessonId);
      if (
        receipt.lessonId === receipt.replacement.lessonId ||
        !active.has(receipt.lessonId) ||
        replacement === undefined ||
        replacement.projection.projectionDigest !==
          receipt.replacement.projectionDigest
      )
        throw new Error(
          "Factory lesson supersession must bind two distinct active lessons."
        );
      active.delete(receipt.lessonId);
    } else {
      if (!active.has(receipt.lessonId))
        throw new Error(
          "Factory lesson retirement must bind an active lesson."
        );
      active.delete(receipt.lessonId);
    }
    history.push(
      FactoryLessonHistoryEntryV1.make({
        eventSequence: event.sequence,
        eventTimestamp: event.timestamp,
        receipt,
        reviewDigest: receipt.reviewDigest,
        runId: event.runId,
        state: receipt.decision,
        version: 1,
      })
    );
  }

  return FactoryLessonReadModelV1.make({
    active: [...active.values()].sort((left, right) =>
      left.projection.lessonId.localeCompare(right.projection.lessonId)
    ),
    history,
    version: 1,
  });
}

/** Derive active lessons and complete review history only from authoritative events. */
export function projectFactoryLessons(
  events: ReadonlyArray<RunEvent>
): FactoryLessonReadModelV1 {
  return projectFactoryLessonsInternal(events, true);
}

/**
 * Validate the run-local review facts available to ordinary run replay.
 * Global supersession and retirement references are intentionally resolved by
 * projectFactoryLessons after the runtime has gathered every authoritative log.
 */
export function validateFactoryLessonRunReviewEvents(
  events: ReadonlyArray<RunEvent>
) {
  return projectFactoryLessonsInternal(
    events.filter((event) => {
      if (event.type !== "FACTORY_LESSON_REVIEW_RECORDED") return true;
      const receipt = parseFactoryLessonReviewReceiptV1(
        event.payload["factoryLessonReview"]
      );
      return (
        receipt.decision === "accepted" ||
        receipt.decision === "rejected" ||
        receipt.decision === "deferred"
      );
    }),
    false
  );
}

export class FactoryLessonOmissionV1 extends Schema.Class<FactoryLessonOmissionV1>(
  "FactoryLessonOmissionV1"
)(
  {
    lesson: FactoryLessonProjectionRefV1,
    reason: Schema.Literals(["contentRefLimit", "renderBudget"] as const),
    version: Schema.Literal(1),
  },
  strict
) {}

export class FactoryLessonContextSelectionV1 extends Schema.Class<FactoryLessonContextSelectionV1>(
  "FactoryLessonContextSelectionV1"
)(
  {
    baseRenderedBytes: Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 16_384 }))
    ),
    contextContentDigest: LowerSha256Schema,
    episodeRole: Schema.Literal("workerInitial"),
    finalRenderedBytes: Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 16_384 }))
    ),
    eligibleLessonCount: Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(0))
    ),
    lessons: Schema.Array(FactoryLessonProjectionRefV1).pipe(
      Schema.check(Schema.isMaxLength(64))
    ),
    maximumRenderedBytes: Schema.Literal(16_384),
    omitted: Schema.Array(FactoryLessonOmissionV1).pipe(
      Schema.check(
        Schema.isMaxLength(MAXIMUM_RECORDED_FACTORY_LESSON_OMISSIONS_V1)
      )
    ),
    omittedLessonCount: Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(0))
    ),
    selectionDigest: FactoryLessonSelectionDigestSchema,
    targetRunId: RunIdSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

const decodeSelection = Schema.decodeUnknownSync(
  FactoryLessonContextSelectionV1
);
const encodeSelection = Schema.encodeSync(FactoryLessonContextSelectionV1);

class FactoryLessonContextSelectionInputV1 extends Schema.Class<FactoryLessonContextSelectionInputV1>(
  "FactoryLessonContextSelectionInputV1"
)(
  {
    baseRenderedBytes: FactoryLessonContextSelectionV1.fields.baseRenderedBytes,
    contextContentDigest:
      FactoryLessonContextSelectionV1.fields.contextContentDigest,
    finalRenderedBytes:
      FactoryLessonContextSelectionV1.fields.finalRenderedBytes,
    eligibleLessonCount:
      FactoryLessonContextSelectionV1.fields.eligibleLessonCount,
    lessons: FactoryLessonContextSelectionV1.fields.lessons,
    maximumRenderedBytes:
      FactoryLessonContextSelectionV1.fields.maximumRenderedBytes,
    omitted: FactoryLessonContextSelectionV1.fields.omitted,
    omittedLessonCount:
      FactoryLessonContextSelectionV1.fields.omittedLessonCount,
    targetRunId: FactoryLessonContextSelectionV1.fields.targetRunId,
  },
  strict
) {}

const decodeSelectionInput = Schema.decodeUnknownSync(
  FactoryLessonContextSelectionInputV1,
  { onExcessProperty: "error" }
);

export function makeFactoryLessonContextSelectionV1(
  input: typeof FactoryLessonContextSelectionInputV1.Encoded
) {
  const decoded = decodeSelectionInput(input);
  const body = {
    baseRenderedBytes: decoded.baseRenderedBytes,
    contextContentDigest: decoded.contextContentDigest,
    episodeRole: "workerInitial" as const,
    eligibleLessonCount: decoded.eligibleLessonCount,
    finalRenderedBytes: decoded.finalRenderedBytes,
    lessons: decoded.lessons,
    maximumRenderedBytes: decoded.maximumRenderedBytes,
    omitted: decoded.omitted,
    omittedLessonCount: decoded.omittedLessonCount,
    targetRunId: decoded.targetRunId,
    version: 1 as const,
  };
  const referencedLessonIds = [
    ...body.lessons.map(({ lessonId }) => lessonId),
    ...body.omitted.map(({ lesson }) => lesson.lessonId),
  ];
  if (
    body.lessons.length + body.omittedLessonCount !==
      body.eligibleLessonCount ||
    body.omitted.length !==
      Math.min(
        body.omittedLessonCount,
        MAXIMUM_RECORDED_FACTORY_LESSON_OMISSIONS_V1
      ) ||
    new Set(referencedLessonIds).size !== referencedLessonIds.length
  )
    throw new Error(
      "Factory lesson context selection has inconsistent bounded evidence."
    );
  return decodeSelection({
    ...body,
    selectionDigest: parseSelectionDigest(
      digest("gaia.factory-lesson-context-selection.v1", body)
    ),
  });
}

export function parseFactoryLessonContextSelectionV1(input: unknown) {
  const selection = decodeSelection(input);
  const expected = makeFactoryLessonContextSelectionV1({
    baseRenderedBytes: selection.baseRenderedBytes,
    contextContentDigest: selection.contextContentDigest,
    eligibleLessonCount: selection.eligibleLessonCount,
    finalRenderedBytes: selection.finalRenderedBytes,
    lessons: selection.lessons,
    maximumRenderedBytes: selection.maximumRenderedBytes,
    omitted: selection.omitted,
    omittedLessonCount: selection.omittedLessonCount,
    targetRunId: selection.targetRunId,
  });
  if (
    selection.selectionDigest !== expected.selectionDigest ||
    JSON.stringify(encodeSelection(selection)) !==
      JSON.stringify(encodeSelection(expected))
  )
    throw new Error(
      "Factory lesson context selection failed self-authentication."
    );
  return selection;
}
