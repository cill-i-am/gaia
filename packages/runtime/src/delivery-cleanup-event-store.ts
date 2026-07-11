import type { RunId } from "@gaia/core";
import { Effect } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { appendEvent, loadRun } from "./event-store.js";
import {
  encodeDeliveryCleanupOwnershipProvenanceJson,
  encodeDeliveryCleanupResourceCheckpointJson,
  DeliveryCleanupResourceCheckpointV1,
  parseDeliveryCleanupOwnershipProvenance,
  parseDeliveryCleanupResourceCheckpoint,
  type DeliveryCleanupOwnershipProvenanceV1,
} from "./delivery-cleanup-provenance.js";
import type { CleanupCheckpointStore, CleanupResourceCheckpoint } from "./delivery-cleanup-resource-coordinator.js";
import type { RunPaths } from "./paths.js";
import { makeRuntimeError } from "./errors.js";

export function recordOrValidateCleanupProvenance(runId: RunId, paths: RunPaths, expected: DeliveryCleanupOwnershipProvenanceV1) {
  return Effect.gen(function* () {
    const loaded = yield* loadRun(paths);
    const recorded = loaded.events
      .filter(({ type }) => type === "DELIVERY_CLEANUP_PROVENANCE_RECORDED")
      .map((event) => parseDeliveryCleanupOwnershipProvenance(event.payload["provenance"]));
    if (recorded.length === 0) {
      yield* appendEvent(runId, paths, { payload: { provenance: encodeDeliveryCleanupOwnershipProvenanceJson(expected) }, type: "DELIVERY_CLEANUP_PROVENANCE_RECORDED" });
      return expected;
    }
    const match = recorded.find(({ actionId }) => actionId === expected.actionId);
    if (match === undefined || match.payloadDigest !== expected.payloadDigest || JSON.stringify(match) !== JSON.stringify(expected)) {
      return yield* Effect.fail(makeRuntimeError({ code: "DeliveryActionConflict", message: "Cleanup action conflicts with durable private provenance.", recoverable: true }));
    }
    if (recorded.some(({ actionId, payloadDigest }) => actionId !== expected.actionId || payloadDigest !== expected.payloadDigest)) {
      return yield* Effect.fail(makeRuntimeError({ code: "DeliveryActionConflict", message: "Another cleanup action is already authoritative.", recoverable: true }));
    }
    return match;
  });
}

export function makeEventCleanupCheckpointStore(runId: RunId, paths: RunPaths): CleanupCheckpointStore {
  return {
    append: (checkpoint) => appendEvent(runId, paths, {
      payload: { checkpoint: encodeDeliveryCleanupResourceCheckpointJson(DeliveryCleanupResourceCheckpointV1.make({ ...checkpoint, version: 1 })) },
      type: "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED",
    }).pipe(Effect.asVoid, Effect.provide(NodeFileSystem.layer)),
    read: () => loadRun(paths).pipe(Effect.map(({ events }) => events.flatMap((event) => event.type === "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED"
      ? [parseDeliveryCleanupResourceCheckpoint(event.payload["checkpoint"]) satisfies CleanupResourceCheckpoint]
      : [])), Effect.provide(NodeFileSystem.layer)),
  };
}
