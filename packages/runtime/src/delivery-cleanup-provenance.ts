import { createHash } from "node:crypto";
import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)));
const GitSha = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)));
const PrivatePath = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(4_096)));
const BoundedId = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)));

/** Private cleanup authority. Never export this shape through LocalGaiaServerApi. */
export class DeliveryCleanupOwnershipProvenanceV1 extends Schema.Class<DeliveryCleanupOwnershipProvenanceV1>("DeliveryCleanupOwnershipProvenanceV1")({
  actionId: BoundedId,
  branchRef: Schema.String.pipe(Schema.check(Schema.isPattern(/^refs\/heads\/[A-Za-z0-9._/-]+$/u))),
  expectedBranchOid: GitSha,
  mergeCommitSha: GitSha,
  ownershipDigest: Digest,
  ownershipToken: BoundedId,
  payloadDigest: Digest,
  repositoryCommonDir: PrivatePath,
  repositoryRoot: PrivatePath,
  runId: BoundedId,
  version: Schema.Literal(1),
  worktreeCommonDir: PrivatePath,
  worktreePath: PrivatePath,
}, strict) {}

export const parseDeliveryCleanupOwnershipProvenance = Schema.decodeUnknownSync(DeliveryCleanupOwnershipProvenanceV1);
const ProvenanceJson = Schema.toCodecJson(DeliveryCleanupOwnershipProvenanceV1);
export const encodeDeliveryCleanupOwnershipProvenanceJson = Schema.encodeSync(ProvenanceJson);

export function deliveryCleanupOwnershipPayloadDigest(input: Omit<typeof DeliveryCleanupOwnershipProvenanceV1.Type, "payloadDigest">) {
  return createHash("sha256").update([
    "gaia-cleanup-ownership-v1",
    input.runId,
    input.actionId,
    input.ownershipDigest,
    input.repositoryCommonDir,
    input.repositoryRoot,
    input.worktreeCommonDir,
    input.worktreePath,
    input.ownershipToken,
    input.branchRef,
    input.expectedBranchOid,
    input.mergeCommitSha,
  ].map((value) => `${value.length}:${value}`).join("|")).digest("hex");
}

export const DeliveryMergeProviderCheckpointStateSchema = Schema.Literals(["attemptRecorded", "reconciliationRequired"] as const);
export class DeliveryMergeProviderCheckpointV1 extends Schema.Class<DeliveryMergeProviderCheckpointV1>("DeliveryMergeProviderCheckpointV1")({
  actionId: BoundedId,
  payloadDigest: Digest,
  state: DeliveryMergeProviderCheckpointStateSchema,
  version: Schema.Literal(1),
}, strict) {}

export const DeliveryCleanupResourceSchema = Schema.Literals(["branch", "worktree"] as const);
export const DeliveryCleanupResourceCheckpointStateSchema = Schema.Literals(["inspectedAbsent", "inspectedPresent", "removalAttempted", "absenceProven"] as const);
export class DeliveryCleanupResourceCheckpointV1 extends Schema.Class<DeliveryCleanupResourceCheckpointV1>("DeliveryCleanupResourceCheckpointV1")({
  actionId: BoundedId,
  payloadDigest: Digest,
  resource: DeliveryCleanupResourceSchema,
  state: DeliveryCleanupResourceCheckpointStateSchema,
  version: Schema.Literal(1),
}, strict) {}
export const parseDeliveryCleanupResourceCheckpoint = Schema.decodeUnknownSync(DeliveryCleanupResourceCheckpointV1);
const CheckpointJson = Schema.toCodecJson(DeliveryCleanupResourceCheckpointV1);
export const encodeDeliveryCleanupResourceCheckpointJson = Schema.encodeSync(CheckpointJson);

export function deriveCleanupResourceProofs(checkpoints: ReadonlyArray<typeof DeliveryCleanupResourceCheckpointV1.Type>) {
  const result = { branch: false, worktree: false };
  for (const checkpoint of checkpoints) {
    if (checkpoint.payloadDigest !== checkpoints[0]?.payloadDigest || checkpoint.actionId !== checkpoints[0]?.actionId) throw new Error("Cleanup checkpoint binding changed.");
    if (checkpoint.state === "absenceProven") result[checkpoint.resource] = true;
  }
  return result;
}
