import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DeliveryMergeDispatchAttempted,
  DeliveryMergeDispatchConfirmed,
  DeliveryMergeIntent,
  RunEvent,
  encodeDeliveryMergeReceiptJson,
  makeRunEvent,
  parseRunId,
  snapshotFromReplay,
} from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { coordinateDeliveryCleanup } from "./delivery-merge-coordinator.js";
import { makeRecordingCleanupResourceAdapter, type CleanupResourceAdapter } from "./delivery-cleanup-resource-coordinator.js";
import { makeRunPaths } from "./paths.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "gaia-cleanup-events-")); roots.push(root);
  const runId = parseRunId("run-1234567890");
  const paths = Effect.runSync(makeRunPaths(runId, { rootDirectory: root }).pipe(Effect.provide(NodePath.layer)));
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.workspace, { recursive: true });
  const binding = { actionId: "merge-1", branchName: "gaia/run-1234567890", decisionSequence: 3, expectedHeadSha: "a".repeat(40), mergeMethod: "merge" as const, payloadDigest: "b".repeat(64), policyDigest: "c".repeat(64), policyVersion: 1 as const, prNumber: 74, prUrl: "https://github.com/cill-i-am/gaia/pull/74", repository: "cill-i-am/gaia" };
  const receipts = [DeliveryMergeIntent.make({ ...binding, state: "intentRecorded" }), DeliveryMergeDispatchAttempted.make({ ...binding, state: "dispatchAttempted" }), DeliveryMergeDispatchConfirmed.make({ ...binding, mergeCommitSha: "d".repeat(40), mergedAt: "2026-07-11T19:00:00.000Z", state: "dispatchConfirmed" })];
  const event = (sequence: number, type: Parameters<typeof makeRunEvent>[0]["type"], payload: Readonly<Record<string, Schema.Json>>) => makeRunEvent({ payload, runId, sequence, timestamp: `2026-07-11T19:00:0${sequence}.000Z`, type });
  const events = [event(1, "RUN_CREATED", { specPath: "spec.md" }), event(2, "DELIVERY_STARTED", { delivery: { baseBranch: "main", baseRevision: "0".repeat(40), headBranch: binding.branchName, mode: "pullRequest", remote: "origin", stage: "waitingForPr" } }), ...receipts.map((receipt, index) => event(index + 3, "DELIVERY_MERGE_RECORDED", { mergeAction: encodeDeliveryMergeReceiptJson(receipt) }))];
  writeFileSync(paths.events, `${events.map((value) => JSON.stringify(Schema.encodeSync(RunEvent)(value))).join("\n")}\n`);
  writeFileSync(paths.snapshots, "");
  writeFileSync(paths.deliveryOwnershipManifest, JSON.stringify({ repositoryCommonDir: path.join(root, ".git"), repositoryRoot: root, token: "private-token", version: 1, workspaceCommonDir: path.join(root, ".git"), workspaceRoot: paths.workspace }));
  return { binding, paths, root, runId };
}

function eventTypes(file: string) { return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> }); }
function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) { return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer))); }

describe("delivery cleanup authoritative run-store integration", () => {
  it("persists provenance before inspection and resumes only the remaining exact resource", async () => {
    const f = fixture();
    const calls: string[] = [];
    let branch = "present" as const;
    const first: CleanupResourceAdapter = {
      inspectWorktree: () => Effect.sync(() => { calls.push("first:inspectWorktree"); return "absent" as const; }),
      removeWorktree: () => Effect.die("must not remove absent worktree"),
      inspectBranch: () => Effect.sync(() => { calls.push("first:inspectBranch"); return branch; }),
      removeBranchCas: () => Effect.sync(() => { calls.push("first:removeBranchCas"); throw new Error("CAS refused"); }),
    };
    await expect(run(coordinateDeliveryCleanup(f.runId, { actionId: "cleanup-1", expectedMergeCommitSha: "d".repeat(40), kind: "retryCleanup" }, { cleanupResourceAdapter: first, rootDirectory: f.root }))).rejects.toBeTruthy();
    const afterFailure = eventTypes(f.paths.events);
    expect(afterFailure.findIndex(({ type }) => type === "DELIVERY_CLEANUP_PROVENANCE_RECORDED")).toBeLessThan(afterFailure.findIndex(({ type }) => type === "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED"));
    expect(afterFailure.some(({ payload }) => (payload["checkpoint"] as { resource?: string; state?: string } | undefined)?.resource === "worktree" && (payload["checkpoint"] as { state?: string }).state === "absenceProven")).toBe(true);

    const restarted = makeRecordingCleanupResourceAdapter({ branch: "present", worktree: "absent" });
    const completed = await run(coordinateDeliveryCleanup(f.runId, { actionId: "cleanup-1", expectedMergeCommitSha: "d".repeat(40), kind: "retryCleanup" }, { cleanupResourceAdapter: restarted.adapter, rootDirectory: f.root }));
    expect(completed.state).toBe("completed");
    expect(restarted.calls).toEqual(["inspectWorktree", "inspectBranch", "removeBranchCas", "inspectBranch"]);
    const replay = snapshotFromReplay(eventTypes(f.paths.events).map((value) => Schema.decodeUnknownSync(RunEvent)(value)));
    expect(replay.state).toBe("completed");
  });

  it("re-proves a completed same action idempotently and rejects a conflicting action", async () => {
    const f = fixture();
    const first = makeRecordingCleanupResourceAdapter({ branch: "absent", worktree: "absent" });
    const action = { actionId: "cleanup-1", expectedMergeCommitSha: "d".repeat(40), kind: "retryCleanup" as const };
    await run(coordinateDeliveryCleanup(f.runId, action, { cleanupResourceAdapter: first.adapter, rootDirectory: f.root }));
    const restarted = makeRecordingCleanupResourceAdapter({ branch: "absent", worktree: "absent" });
    await run(coordinateDeliveryCleanup(f.runId, action, { cleanupResourceAdapter: restarted.adapter, rootDirectory: f.root }));
    expect(restarted.calls).toEqual(["inspectWorktree", "inspectBranch"]);
    await expect(run(coordinateDeliveryCleanup(f.runId, { ...action, actionId: "cleanup-2" }, { cleanupResourceAdapter: restarted.adapter, rootDirectory: f.root }))).rejects.toMatchObject({ code: "DeliveryActionConflict" });
  });
});
