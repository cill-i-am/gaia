import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as Schema from "effect/Schema";

import {
  GitHubPullRequestSelectorPublicSchema,
  DeliveryTimestampPublicSchema,
} from "./delivery-identity.js";
import {
  RunContractDigestSchema,
  RunContractIdSchema,
  RunContractIdV2Schema,
  RunEventSequenceSchema,
  RunProofResultDigestSchema,
  RunRelativeArtifactPathSchema,
  RunVerificationAggregateSchema,
  StructuralDigestSchema,
} from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const MergeDecisionPayloadDigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  Schema.brand("MergeDecisionPayloadDigest")
);

export const MergeDecisionStatusSchema = Schema.Literals([
  "approved",
  "blocked",
] as const);
export const MergeDecisionNextActionSchema = Schema.Literals([
  "ready-to-merge",
  "resolve-blockers",
] as const);
export const MergeDecisionBlockerKindSchema = Schema.Literals([
  "browser-evidence-failed",
  "browser-evidence-missing",
  "pr-loop-not-ready",
  "reviewer-blocked",
  "reviewer-evidence-missing",
  "run-contract-missing",
  "run-proof-result-missing",
  "run-proof-not-verified",
  "run-proof-stale",
  "evidence-review-stale",
  "delivery-publication-missing",
] as const);

export class MergeDecisionBlockerV2 extends Schema.Class<MergeDecisionBlockerV2>(
  "MergeDecisionBlockerV2"
)(
  {
    action: Schema.NonEmptyString,
    artifactPath: Schema.optionalKey(RunRelativeArtifactPathSchema),
    kind: MergeDecisionBlockerKindSchema,
    summary: Schema.NonEmptyString,
  },
  strict
) {}

export class MergeDecisionNoContractProofV2 extends Schema.Class<MergeDecisionNoContractProofV2>(
  "MergeDecisionNoContractProofV2"
)(
  {
    aggregate: Schema.Literal("completed-unverified"),
    kind: Schema.Literal("noContract"),
    legacyVerificationSequence: Schema.optionalKey(RunEventSequenceSchema),
  },
  strict
) {}

export class MergeDecisionMissingProofResultV2 extends Schema.Class<MergeDecisionMissingProofResultV2>(
  "MergeDecisionMissingProofResultV2"
)({ kind: Schema.Literal("missing") }, strict) {}

export class MergeDecisionRecordedProofResultV2 extends Schema.Class<MergeDecisionRecordedProofResultV2>(
  "MergeDecisionRecordedProofResultV2"
)(
  {
    aggregate: RunVerificationAggregateSchema,
    kind: Schema.Literal("recorded"),
    observedTargetDigest: StructuralDigestSchema,
    resultDigest: RunProofResultDigestSchema,
    sequence: RunEventSequenceSchema,
  },
  strict
) {}

export const MergeDecisionContractProofResultV2Schema = Schema.Union([
  MergeDecisionMissingProofResultV2,
  MergeDecisionRecordedProofResultV2,
]);
export type MergeDecisionContractProofResultV2 =
  typeof MergeDecisionContractProofResultV2Schema.Type;

export class MergeDecisionContractProofV2 extends Schema.Class<MergeDecisionContractProofV2>(
  "MergeDecisionContractProofV2"
)(
  {
    contractDigest: RunContractDigestSchema,
    contractId: Schema.Union([RunContractIdSchema, RunContractIdV2Schema]),
    kind: Schema.Literal("contract"),
    result: MergeDecisionContractProofResultV2Schema,
  },
  strict
) {}

export const MergeDecisionProofV2Schema = Schema.Union([
  MergeDecisionNoContractProofV2,
  MergeDecisionContractProofV2,
]);
export type MergeDecisionProofV2 = typeof MergeDecisionProofV2Schema.Type;

const fields = {
  blockerCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  blockers: Schema.Array(MergeDecisionBlockerV2),
  contentAuthoritySequence: RunEventSequenceSchema,
  decidedAt: DeliveryTimestampPublicSchema,
  evidenceReviewPath: RunRelativeArtifactPathSchema,
  evidenceReviewSequence: Schema.optionalKey(RunEventSequenceSchema),
  evidenceReviewerSessionPath: RunRelativeArtifactPathSchema,
  nextAction: MergeDecisionNextActionSchema,
  planReviewPath: RunRelativeArtifactPathSchema,
  planReviewerSessionPath: RunRelativeArtifactPathSchema,
  pr: Schema.optionalKey(GitHubPullRequestSelectorPublicSchema),
  proof: MergeDecisionProofV2Schema,
  publicationConfirmationSequence: Schema.optionalKey(RunEventSequenceSchema),
  runId: RunIdSchema,
  runProfilePath: RunRelativeArtifactPathSchema,
  status: MergeDecisionStatusSchema,
  version: Schema.Literal(2),
} as const;

const MergeDecisionV2BindingSchema = Schema.Struct(fields);
export type MergeDecisionV2Binding = typeof MergeDecisionV2BindingSchema.Type;

export class MergeDecisionV2 extends Schema.Class<MergeDecisionV2>(
  "MergeDecisionV2"
)(
  {
    ...fields,
    payloadDigest: MergeDecisionPayloadDigestSchema,
  },
  strict
) {}

const decode = Schema.decodeUnknownSync(MergeDecisionV2);
const parseDigest = Schema.decodeUnknownSync(MergeDecisionPayloadDigestSchema);

export function mergeDecisionV2PayloadDigest(input: MergeDecisionV2Binding) {
  return parseDigest(
    bytesToHex(
      sha256(
        utf8ToBytes(
          `gaia.merge-decision.v2\0${canonicalMergeDecisionBinding(input)}`
        )
      )
    )
  );
}

export function makeMergeDecisionV2(input: MergeDecisionV2Binding) {
  if (input.proof === undefined)
    throw new Error("MergeDecisionV2 requires a typed proof description.");
  return parseMergeDecisionV2({
    ...input,
    payloadDigest: mergeDecisionV2PayloadDigest(input),
  });
}

export function parseMergeDecisionV2(input: unknown): MergeDecisionV2 {
  const decision = decode(input);
  if (decision.blockerCount !== decision.blockers.length)
    throw new Error("MergeDecisionV2 blocker count does not match blockers.");
  const keys = decision.blockers.map(blockerKey);
  if (
    keys.some(
      (key, index) => index > 0 && compareUtf8(keys[index - 1]!, key) >= 0
    )
  )
    throw new Error("MergeDecisionV2 blockers must be canonical and unique.");
  if (
    (decision.status === "approved") !==
      (decision.nextAction === "ready-to-merge") ||
    (decision.status === "approved") !== (decision.blockers.length === 0) ||
    (decision.status === "approved" &&
      (decision.proof.kind !== "contract" ||
        decision.proof.result.kind !== "recorded" ||
        decision.proof.result.aggregate !== "verified" ||
        decision.evidenceReviewSequence === undefined ||
        decision.publicationConfirmationSequence === undefined))
  )
    throw new Error("MergeDecisionV2 approval fields are inconsistent.");
  if (
    decision.proof.kind === "contract" &&
    decision.proof.contractId !== `run-contract:${decision.runId}:v1` &&
    decision.proof.contractId !== `run-contract:${decision.runId}:v2`
  )
    throw new Error(
      "MergeDecisionV2 proof contract does not belong to its run."
    );
  if (decision.payloadDigest !== mergeDecisionV2PayloadDigest(decision))
    throw new Error("MergeDecisionV2 payload digest does not match.");
  return decision;
}

export const encodeMergeDecisionV2Json = Schema.encodeSync(
  Schema.toCodecJson(MergeDecisionV2)
);
export const parseMergeDecisionV2Json = (input: unknown) =>
  parseMergeDecisionV2(
    Schema.decodeUnknownSync(Schema.toCodecJson(MergeDecisionV2))(input)
  );

export function sortMergeDecisionBlockersV2(
  blockers: readonly MergeDecisionBlockerV2[]
) {
  return blockers.toSorted((left, right) =>
    compareUtf8(blockerKey(left), blockerKey(right))
  );
}

function blockerKey(blocker: MergeDecisionBlockerV2) {
  return [
    blocker.kind,
    blocker.artifactPath ?? "",
    blocker.summary,
    blocker.action,
  ].join("\0");
}

function canonicalMergeDecisionBinding(input: MergeDecisionV2Binding) {
  return canonicalFields([
    String(input.blockerCount),
    ...input.blockers.flatMap((blocker) => [
      blocker.kind,
      blocker.artifactPath ?? "",
      blocker.summary,
      blocker.action,
    ]),
    String(input.contentAuthoritySequence),
    input.decidedAt,
    input.evidenceReviewPath,
    String(input.evidenceReviewSequence ?? ""),
    input.evidenceReviewerSessionPath,
    input.nextAction,
    input.planReviewPath,
    input.planReviewerSessionPath,
    input.pr ?? "",
    ...proofCanonicalFields(input.proof),
    String(input.publicationConfirmationSequence ?? ""),
    input.runId,
    input.runProfilePath,
    input.status,
    String(input.version),
  ]);
}

function proofCanonicalFields(proof: MergeDecisionProofV2) {
  if (proof.kind === "noContract")
    return [
      proof.kind,
      proof.aggregate,
      String(proof.legacyVerificationSequence ?? ""),
    ];
  if (proof.result.kind === "missing")
    return [proof.kind, proof.contractId, proof.contractDigest, "missing"];
  return [
    proof.kind,
    proof.contractId,
    proof.contractDigest,
    proof.result.kind,
    String(proof.result.sequence),
    proof.result.resultDigest,
    proof.result.aggregate,
    proof.result.observedTargetDigest,
  ];
}

function canonicalFields(fields: readonly string[]) {
  return fields
    .map((field) => {
      if (!field.isWellFormed())
        throw new Error(
          "Merge decision canonical fields must be well-formed Unicode."
        );
      const bytes = utf8ToBytes(field);
      return `${bytes.length}:${field}`;
    })
    .join("|");
}

function compareUtf8(left: string, right: string) {
  if (!left.isWellFormed() || !right.isWellFormed())
    throw new Error(
      "Merge decision canonical fields must be well-formed Unicode."
    );
  const a = utf8ToBytes(left);
  const b = utf8ToBytes(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}
