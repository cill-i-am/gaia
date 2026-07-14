import {
  DeliveryActionIdSchema,
  DeliveryMergeReadinessDecisionSchema,
  DeliverySnapshotDto,
} from "@gaia/core";
import { Schema } from "effect";

const decodeDeliveryActionId = Schema.decodeUnknownSync(DeliveryActionIdSchema);

type DeliveryMergeReadinessDecision =
  typeof DeliveryMergeReadinessDecisionSchema.Type;
type DeliveryMergeDecisionSequence = NonNullable<
  typeof DeliverySnapshotDto.Type.mergeDecisionSequence
>;

export function createReadinessActionId(): typeof DeliveryActionIdSchema.Type {
  return decodeDeliveryActionId(`readiness-${crypto.randomUUID()}`);
}

export function mergeDecisionIdentity(input: {
  readonly payloadDigest: DeliveryMergeReadinessDecision["payloadDigest"];
  readonly sequence: DeliveryMergeDecisionSequence;
}): typeof DeliveryActionIdSchema.Type {
  return decodeDeliveryActionId(
    `merge-${input.payloadDigest}-${input.sequence}`
  );
}
