import {
  DeliveryActionIdPublicSchema,
  DeliverySha256DigestPublicSchema,
} from "@gaia/core";
import { Effect, Schema } from "effect";

import {
  DeliveryCleanupOwnershipProvenanceV1,
  DeliveryCleanupResourceCheckpointStateSchema,
  DeliveryCleanupResourceSchema,
} from "./delivery-cleanup-provenance.js";

export const CleanupResourceInspectionSchema = Schema.Literals([
  "absent",
  "present",
] as const);

export type CleanupResourceInspection =
  typeof CleanupResourceInspectionSchema.Type;

const CleanupInspectResourceSchema = Schema.declare<
  (
    provenance: DeliveryCleanupOwnershipProvenanceV1
  ) => Effect.Effect<CleanupResourceInspection, unknown>
>(
  (
    input
  ): input is (
    provenance: DeliveryCleanupOwnershipProvenanceV1
  ) => Effect.Effect<CleanupResourceInspection, unknown> =>
    typeof input === "function"
);

const CleanupRemoveResourceSchema = Schema.declare<
  (
    provenance: DeliveryCleanupOwnershipProvenanceV1
  ) => Effect.Effect<void, unknown>
>(
  (
    input
  ): input is (
    provenance: DeliveryCleanupOwnershipProvenanceV1
  ) => Effect.Effect<void, unknown> => typeof input === "function"
);

/** The complete GAIA-93 cleanup mutation boundary. */
export const CleanupResourceAdapterSchema = Schema.Struct({
  inspectBranch: CleanupInspectResourceSchema,
  inspectWorktree: CleanupInspectResourceSchema,
  removeBranchCas: CleanupRemoveResourceSchema,
  removeWorktree: CleanupRemoveResourceSchema,
});

export type CleanupResourceAdapter = typeof CleanupResourceAdapterSchema.Type;

export const CleanupResourceCheckpointSchema = Schema.Struct({
  actionId: DeliveryActionIdPublicSchema,
  payloadDigest: DeliverySha256DigestPublicSchema,
  resource: DeliveryCleanupResourceSchema,
  state: DeliveryCleanupResourceCheckpointStateSchema,
});

export type CleanupResourceCheckpoint =
  typeof CleanupResourceCheckpointSchema.Type;

export const CleanupWorktreeBoundarySchema = Schema.Literals([
  "afterAbsentCheckpoint",
  "afterInspectionCheckpoint",
  "afterPostInspection",
  "afterRemoval",
  "afterRemovalCheckpoint",
  "afterWorktreeInspection",
] as const);

export type CleanupWorktreeBoundary = typeof CleanupWorktreeBoundarySchema.Type;

export const CleanupBranchBoundarySchema = Schema.Literals([
  "afterBranchAbsentCheckpoint",
  "afterBranchInspection",
  "afterBranchInspectionCheckpoint",
  "afterBranchPostInspection",
  "afterBranchRemoval",
  "afterBranchRemovalCheckpoint",
] as const);

export type CleanupBranchBoundary = typeof CleanupBranchBoundarySchema.Type;

export class CleanupCrashInjected extends Schema.TaggedErrorClass<CleanupCrashInjected>()(
  "CleanupCrashInjected",
  {
    boundary: Schema.Union([
      CleanupWorktreeBoundarySchema,
      CleanupBranchBoundarySchema,
    ]),
  }
) {}

const CleanupCheckpointAppendSchema = Schema.declare<
  (checkpoint: CleanupResourceCheckpoint) => Effect.Effect<void, unknown>
>(
  (
    input
  ): input is (
    checkpoint: CleanupResourceCheckpoint
  ) => Effect.Effect<void, unknown> => typeof input === "function"
);

const CleanupCheckpointReadSchema = Schema.declare<
  () => Effect.Effect<ReadonlyArray<CleanupResourceCheckpoint>, unknown>
>(
  (
    input
  ): input is () => Effect.Effect<
    ReadonlyArray<CleanupResourceCheckpoint>,
    unknown
  > => typeof input === "function"
);

export const CleanupCheckpointStoreSchema = Schema.Struct({
  append: CleanupCheckpointAppendSchema,
  read: CleanupCheckpointReadSchema,
});

export type CleanupCheckpointStore = typeof CleanupCheckpointStoreSchema.Type;

const CoordinateWorktreeCleanupInputSchema = Schema.Struct({
  adapter: CleanupResourceAdapterSchema,
  checkpointStore: CleanupCheckpointStoreSchema,
  crashAfter: Schema.optionalKey(CleanupWorktreeBoundarySchema),
  provenance: DeliveryCleanupOwnershipProvenanceV1,
});

const CoordinateBranchCleanupInputSchema = Schema.Struct({
  adapter: CleanupResourceAdapterSchema,
  checkpointStore: CleanupCheckpointStoreSchema,
  crashAfter: Schema.optionalKey(CleanupBranchBoundarySchema),
  provenance: DeliveryCleanupOwnershipProvenanceV1,
});

const RecordingCleanupInitialStateSchema = Schema.Struct({
  branch: Schema.optionalKey(CleanupResourceInspectionSchema),
  worktree: Schema.optionalKey(CleanupResourceInspectionSchema),
});

type RecordingCleanupInitialState =
  typeof RecordingCleanupInitialStateSchema.Type;

/** Coordinate one worktree resource solely through live facts plus durable checkpoints. */
export function coordinateWorktreeCleanup(
  input: typeof CoordinateWorktreeCleanupInputSchema.Type
) {
  const checkpoint = (state: CleanupResourceCheckpoint["state"]) =>
    input.checkpointStore.append({
      actionId: input.provenance.actionId,
      payloadDigest: input.provenance.payloadDigest,
      resource: "worktree",
      state,
    });
  const crash = (boundary: CleanupWorktreeBoundary) =>
    input.crashAfter === boundary
      ? Effect.fail(CleanupCrashInjected.make({ boundary }))
      : Effect.void;

  return Effect.gen(function* () {
    const history = yield* input.checkpointStore.read();
    assertCheckpointBinding(history, input.provenance);
    if (
      history.some(
        ({ resource, state }) =>
          resource === "worktree" && state === "absenceProven"
      )
    ) {
      const fresh = yield* input.adapter.inspectWorktree(input.provenance);
      if (fresh !== "absent")
        return yield* Effect.fail(
          new Error("Previously absent owned worktree reappeared.")
        );
      yield* checkpoint("inspectedAbsent");
      yield* checkpoint("absenceProven");
      return "absent" as const;
    }

    const initial = yield* input.adapter.inspectWorktree(input.provenance);
    yield* crash("afterWorktreeInspection");
    yield* checkpoint(
      initial === "present" ? "inspectedPresent" : "inspectedAbsent"
    );
    yield* crash("afterInspectionCheckpoint");
    if (initial === "absent") {
      yield* checkpoint("absenceProven");
      yield* crash("afterAbsentCheckpoint");
      return "absent" as const;
    }

    yield* input.adapter.removeWorktree(input.provenance);
    yield* crash("afterRemoval");
    yield* checkpoint("removalAttempted");
    yield* crash("afterRemovalCheckpoint");
    const after = yield* input.adapter.inspectWorktree(input.provenance);
    yield* crash("afterPostInspection");
    yield* checkpoint(
      after === "absent" ? "inspectedAbsent" : "inspectedPresent"
    );
    if (after !== "absent") return "present" as const;
    yield* checkpoint("absenceProven");
    yield* crash("afterAbsentCheckpoint");
    return "absent" as const;
  });
}

export function coordinateBranchCleanup(
  input: typeof CoordinateBranchCleanupInputSchema.Type
) {
  const checkpoint = (state: CleanupResourceCheckpoint["state"]) =>
    input.checkpointStore.append({
      actionId: input.provenance.actionId,
      payloadDigest: input.provenance.payloadDigest,
      resource: "branch",
      state,
    });
  const crash = (boundary: CleanupBranchBoundary) =>
    input.crashAfter === boundary
      ? Effect.fail(CleanupCrashInjected.make({ boundary }))
      : Effect.void;
  return Effect.gen(function* () {
    const history = yield* input.checkpointStore.read();
    assertCheckpointBinding(history, input.provenance);
    if (
      history.some(
        ({ resource, state }) =>
          resource === "branch" && state === "absenceProven"
      )
    ) {
      const fresh = yield* input.adapter.inspectBranch(input.provenance);
      if (fresh !== "absent")
        return yield* Effect.fail(
          new Error("Previously absent owned branch reappeared.")
        );
      yield* checkpoint("inspectedAbsent");
      yield* checkpoint("absenceProven");
      return "absent" as const;
    }
    const initial = yield* input.adapter.inspectBranch(input.provenance);
    yield* crash("afterBranchInspection");
    yield* checkpoint(
      initial === "present" ? "inspectedPresent" : "inspectedAbsent"
    );
    yield* crash("afterBranchInspectionCheckpoint");
    if (initial === "absent") {
      yield* checkpoint("absenceProven");
      yield* crash("afterBranchAbsentCheckpoint");
      return "absent" as const;
    }
    yield* input.adapter.removeBranchCas(input.provenance);
    yield* crash("afterBranchRemoval");
    yield* checkpoint("removalAttempted");
    yield* crash("afterBranchRemovalCheckpoint");
    const after = yield* input.adapter.inspectBranch(input.provenance);
    yield* crash("afterBranchPostInspection");
    yield* checkpoint(
      after === "absent" ? "inspectedAbsent" : "inspectedPresent"
    );
    if (after !== "absent") return "present" as const;
    yield* checkpoint("absenceProven");
    yield* crash("afterBranchAbsentCheckpoint");
    return "absent" as const;
  });
}

function assertCheckpointBinding(
  history: ReadonlyArray<CleanupResourceCheckpoint>,
  provenance: DeliveryCleanupOwnershipProvenanceV1
) {
  if (
    history.some(
      (checkpoint) =>
        checkpoint.actionId !== provenance.actionId ||
        checkpoint.payloadDigest !== provenance.payloadDigest
    )
  ) {
    throw new Error("Cleanup checkpoint binding changed.");
  }
}

export function makeRecordingCleanupResourceAdapter(
  initial: RecordingCleanupInitialState = {}
) {
  let branch = initial.branch ?? "present";
  let worktree = initial.worktree ?? "present";
  const calls: string[] = [];
  const adapter: CleanupResourceAdapter = {
    inspectBranch: () =>
      Effect.sync(() => {
        calls.push("inspectBranch");
        return branch;
      }),
    inspectWorktree: () =>
      Effect.sync(() => {
        calls.push("inspectWorktree");
        return worktree;
      }),
    removeBranchCas: () =>
      Effect.sync(() => {
        calls.push("removeBranchCas");
        branch = "absent";
      }),
    removeWorktree: () =>
      Effect.sync(() => {
        calls.push("removeWorktree");
        worktree = "absent";
      }),
  };
  return { adapter, calls, state: () => ({ branch, worktree }) };
}

export function makeInMemoryCleanupCheckpointStore(
  seed: ReadonlyArray<CleanupResourceCheckpoint> = []
) {
  const checkpoints = [...seed];
  const store: CleanupCheckpointStore = {
    append: (checkpoint) =>
      Effect.sync(() => {
        checkpoints.push(checkpoint);
      }),
    read: () => Effect.succeed(checkpoints),
  };
  return { checkpoints, store };
}
