import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { DeliveryCleanupOwnershipProvenanceV1 } from "./delivery-cleanup-provenance.js";
import {
  coordinateBranchCleanup,
  coordinateWorktreeCleanup,
  makeInMemoryCleanupCheckpointStore,
  makeRecordingCleanupResourceAdapter,
  type CleanupWorktreeBoundary,
} from "./delivery-cleanup-resource-coordinator.js";

const provenance = DeliveryCleanupOwnershipProvenanceV1.make({
  actionId: "cleanup-1",
  branchRef: "refs/heads/gaia/run-1234567890",
  expectedBranchOid: "a".repeat(40),
  mergeCommitSha: "b".repeat(40),
  ownershipDigest: "c".repeat(64),
  ownershipToken: "private-token",
  payloadDigest: "d".repeat(64),
  repositoryCommonDir: "/private/repo/.git",
  repositoryRoot: "/private/repo",
  runId: "run-1234567890",
  version: 1,
  worktreeCommonDir: "/private/repo/.git",
  worktreePath: "/private/run/workspace",
});

describe("delivery branch cleanup coordinator", () => {
  it("persists present through freshly proven absent in order", async () => {
    const recording = makeRecordingCleanupResourceAdapter();
    const memory = makeInMemoryCleanupCheckpointStore();
    await Effect.runPromise(
      coordinateBranchCleanup({
        adapter: recording.adapter,
        checkpointStore: memory.store,
        provenance,
      })
    );
    expect(recording.calls).toEqual([
      "inspectBranch",
      "removeBranchCas",
      "inspectBranch",
    ]);
    expect(memory.checkpoints.map(({ state }) => state)).toEqual([
      "inspectedPresent",
      "removalAttempted",
      "inspectedAbsent",
      "absenceProven",
    ]);
  });

  for (const boundary of [
    "afterBranchInspection",
    "afterBranchInspectionCheckpoint",
    "afterBranchRemoval",
    "afterBranchRemovalCheckpoint",
    "afterBranchPostInspection",
    "afterBranchAbsentCheckpoint",
  ] as const) {
    it(`restarts from authoritative branch facts after ${boundary}`, async () => {
      const recording = makeRecordingCleanupResourceAdapter();
      const memory = makeInMemoryCleanupCheckpointStore();
      expect(
        (
          await Effect.runPromiseExit(
            coordinateBranchCleanup({
              adapter: recording.adapter,
              checkpointStore: memory.store,
              crashAfter: boundary,
              provenance,
            })
          )
        )._tag
      ).toBe("Failure");
      await Effect.runPromise(
        coordinateBranchCleanup({
          adapter: recording.adapter,
          checkpointStore: memory.store,
          provenance,
        })
      );
      expect(recording.state().branch).toBe("absent");
      expect(
        memory.checkpoints.some(
          ({ resource, state }) =>
            resource === "branch" && state === "absenceProven"
        )
      ).toBe(true);
    });
  }

  it("does not treat a branch removal attempt as absence", async () => {
    const recording = makeRecordingCleanupResourceAdapter({
      branch: "present",
    });
    const memory = makeInMemoryCleanupCheckpointStore([
      {
        actionId: provenance.actionId,
        payloadDigest: provenance.payloadDigest,
        resource: "branch",
        state: "removalAttempted",
      },
    ]);
    await Effect.runPromise(
      coordinateBranchCleanup({
        adapter: recording.adapter,
        checkpointStore: memory.store,
        provenance,
      })
    );
    expect(recording.calls[0]).toBe("inspectBranch");
    expect(recording.state().branch).toBe("absent");
  });
});

describe("delivery cleanup resource coordinator", () => {
  it("persists present, attempted, post-inspected absent, and proven absent in order", async () => {
    const recording = makeRecordingCleanupResourceAdapter();
    const memory = makeInMemoryCleanupCheckpointStore();
    await Effect.runPromise(
      coordinateWorktreeCleanup({
        adapter: recording.adapter,
        checkpointStore: memory.store,
        provenance,
      })
    );
    expect(recording.calls).toEqual([
      "inspectWorktree",
      "removeWorktree",
      "inspectWorktree",
    ]);
    expect(memory.checkpoints.map(({ state }) => state)).toEqual([
      "inspectedPresent",
      "removalAttempted",
      "inspectedAbsent",
      "absenceProven",
    ]);
  });

  for (const boundary of [
    "afterWorktreeInspection",
    "afterInspectionCheckpoint",
    "afterRemoval",
    "afterRemovalCheckpoint",
    "afterPostInspection",
    "afterAbsentCheckpoint",
  ] as const satisfies ReadonlyArray<CleanupWorktreeBoundary>) {
    it(`restarts from authoritative facts after ${boundary}`, async () => {
      const recording = makeRecordingCleanupResourceAdapter();
      const memory = makeInMemoryCleanupCheckpointStore();
      const crashed = await Effect.runPromiseExit(
        coordinateWorktreeCleanup({
          adapter: recording.adapter,
          checkpointStore: memory.store,
          crashAfter: boundary,
          provenance,
        })
      );
      expect(crashed._tag).toBe("Failure");
      await Effect.runPromise(
        coordinateWorktreeCleanup({
          adapter: recording.adapter,
          checkpointStore: memory.store,
          provenance,
        })
      );
      expect(recording.state().worktree).toBe("absent");
      expect(
        memory.checkpoints.some(({ state }) => state === "absenceProven")
      ).toBe(true);
    });
  }

  it("does not treat a removal-attempt checkpoint as absence", async () => {
    const recording = makeRecordingCleanupResourceAdapter({
      worktree: "present",
    });
    const memory = makeInMemoryCleanupCheckpointStore([
      {
        actionId: provenance.actionId,
        payloadDigest: provenance.payloadDigest,
        resource: "worktree",
        state: "removalAttempted",
      },
    ]);
    await Effect.runPromise(
      coordinateWorktreeCleanup({
        adapter: recording.adapter,
        checkpointStore: memory.store,
        provenance,
      })
    );
    expect(recording.calls[0]).toBe("inspectWorktree");
    expect(recording.state().worktree).toBe("absent");
  });

  it("rejects checkpoint history from a conflicting action digest", () => {
    const recording = makeRecordingCleanupResourceAdapter();
    const memory = makeInMemoryCleanupCheckpointStore([
      {
        actionId: provenance.actionId,
        payloadDigest: "e".repeat(64),
        resource: "worktree",
        state: "removalAttempted",
      },
    ]);
    expect(() =>
      Effect.runSync(
        coordinateWorktreeCleanup({
          adapter: recording.adapter,
          checkpointStore: memory.store,
          provenance,
        })
      )
    ).toThrow("binding changed");
  });
});
