import { Data, Effect } from "effect";

import type { DeliveryCleanupOwnershipProvenanceV1 } from "./delivery-cleanup-provenance.js";

export type CleanupResourceInspection = "absent" | "present";

/** The complete GAIA-93 cleanup mutation boundary. */
export interface CleanupResourceAdapter {
  readonly inspectWorktree: (
    provenance: DeliveryCleanupOwnershipProvenanceV1
  ) => Effect.Effect<CleanupResourceInspection, unknown>;
  readonly removeWorktree: (
    provenance: DeliveryCleanupOwnershipProvenanceV1
  ) => Effect.Effect<void, unknown>;
  readonly inspectBranch: (
    provenance: DeliveryCleanupOwnershipProvenanceV1
  ) => Effect.Effect<CleanupResourceInspection, unknown>;
  readonly removeBranchCas: (
    provenance: DeliveryCleanupOwnershipProvenanceV1
  ) => Effect.Effect<void, unknown>;
}

export type CleanupResourceCheckpoint = {
  readonly actionId: string;
  readonly payloadDigest: string;
  readonly resource: "branch" | "worktree";
  readonly state:
    | "absenceProven"
    | "inspectedAbsent"
    | "inspectedPresent"
    | "removalAttempted";
};

export type CleanupWorktreeBoundary =
  | "afterAbsentCheckpoint"
  | "afterInspectionCheckpoint"
  | "afterPostInspection"
  | "afterRemoval"
  | "afterRemovalCheckpoint"
  | "afterWorktreeInspection";
export type CleanupBranchBoundary =
  | "afterBranchAbsentCheckpoint"
  | "afterBranchInspection"
  | "afterBranchInspectionCheckpoint"
  | "afterBranchPostInspection"
  | "afterBranchRemoval"
  | "afterBranchRemovalCheckpoint";

export class CleanupCrashInjected extends Data.TaggedError(
  "CleanupCrashInjected"
)<{
  readonly boundary: CleanupWorktreeBoundary | CleanupBranchBoundary;
}> {}

export type CleanupCheckpointStore = {
  readonly append: (
    checkpoint: CleanupResourceCheckpoint
  ) => Effect.Effect<void, unknown>;
  readonly read: () => Effect.Effect<
    ReadonlyArray<CleanupResourceCheckpoint>,
    unknown
  >;
};

/** Coordinate one worktree resource solely through live facts plus durable checkpoints. */
export function coordinateWorktreeCleanup(input: {
  readonly adapter: CleanupResourceAdapter;
  readonly checkpointStore: CleanupCheckpointStore;
  readonly crashAfter?: CleanupWorktreeBoundary;
  readonly provenance: DeliveryCleanupOwnershipProvenanceV1;
}) {
  const checkpoint = (state: CleanupResourceCheckpoint["state"]) =>
    input.checkpointStore.append({
      actionId: input.provenance.actionId,
      payloadDigest: input.provenance.payloadDigest,
      resource: "worktree",
      state,
    });
  const crash = (boundary: CleanupWorktreeBoundary) =>
    input.crashAfter === boundary
      ? Effect.fail(new CleanupCrashInjected({ boundary }))
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

export function coordinateBranchCleanup(input: {
  readonly adapter: CleanupResourceAdapter;
  readonly checkpointStore: CleanupCheckpointStore;
  readonly crashAfter?: CleanupBranchBoundary;
  readonly provenance: DeliveryCleanupOwnershipProvenanceV1;
}) {
  const checkpoint = (state: CleanupResourceCheckpoint["state"]) =>
    input.checkpointStore.append({
      actionId: input.provenance.actionId,
      payloadDigest: input.provenance.payloadDigest,
      resource: "branch",
      state,
    });
  const crash = (boundary: CleanupBranchBoundary) =>
    input.crashAfter === boundary
      ? Effect.fail(new CleanupCrashInjected({ boundary }))
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
  initial: {
    readonly branch?: CleanupResourceInspection;
    readonly worktree?: CleanupResourceInspection;
  } = {}
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
