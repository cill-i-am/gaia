import {
  DeliveryActionIdSchema,
  DeliverySha256DigestPublicSchema,
  RunEvent,
} from "@gaia/core";
import { Schema } from "effect";

const decodeDeliveryActionId = Schema.decodeUnknownSync(DeliveryActionIdSchema);

const MergeDecisionIdentityInputSchema = Schema.Struct({
  payloadDigest: DeliverySha256DigestPublicSchema,
  sequence: RunEvent.fields.sequence,
});

export function createReadinessActionId(): typeof DeliveryActionIdSchema.Type {
  return decodeDeliveryActionId(`readiness-${crypto.randomUUID()}`);
}

export function mergeDecisionIdentity(
  input: typeof MergeDecisionIdentityInputSchema.Type
): typeof DeliveryActionIdSchema.Type {
  return decodeDeliveryActionId(
    `merge-${input.payloadDigest}-${input.sequence}`
  );
}
