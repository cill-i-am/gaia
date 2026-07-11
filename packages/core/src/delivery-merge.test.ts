import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  DeliveryCleanupCompleted,
  DeliveryCleanupRequired,
  DeliveryMergeDispatchAttempted,
  DeliveryMergeDispatchConfirmed,
  DeliveryMergeIntent,
  DeliveryMergeReadinessDecision,
  DeliveryRequiredCheckPolicy,
  deliveryMergeMethodArguments,
  deliveryRequiredCheckPolicyCanonicalPayload,
  parseDeliveryCleanupReceipt,
  parseDeliveryMergeReceipt,
  encodeDeliveryCleanupReceiptJson,
  encodeDeliveryMergeReadinessDecisionJson,
  encodeDeliveryMergeReceiptJson,
  deriveDeliveryMergeActionHistories,
  deriveDeliveryCleanupActionHistories,
  deliveryActionAuditSummary,
} from "./delivery-merge.js";
import { makeRunEvent } from "./events.js";
import { snapshotFromReplay } from "./machine.js";
import { parseRunId } from "./run-id.js";

const check = { appSlug: "github-actions", name: "test", repository: "cill-i-am/gaia", workflow: "CI" };

describe("delivery merge contracts", () => {
  it("maps every supported method to exactly one provider flag", () => {
    expect(deliveryMergeMethodArguments).toEqual({ merge: ["--merge"], rebase: ["--rebase"], squash: ["--squash"] });
  });

  it("requires sorted unique bounded required-check identities and stable digesting", () => {
    const decode = Schema.decodeUnknownSync(DeliveryRequiredCheckPolicy);
    const policy = decode({ checks: [check], requireApprovedReview: true, version: 1 });
    expect(deliveryRequiredCheckPolicyCanonicalPayload(policy)).toContain("cill-i-am/gaia");
    expect(() => decode({ checks: [check, check], requireApprovedReview: true, version: 1 })).toThrow();
  });

  it("binds method and policy into strict durable receipts", () => {
    const base = { actionId: "action-1", branchName: "gaia/run-1234567890", decisionSequence: 9, expectedHeadSha: "a".repeat(40), mergeMethod: "merge", payloadDigest: "b".repeat(64), policyDigest: "c".repeat(64), policyVersion: 1, prNumber: 74, prUrl: "https://github.com/cill-i-am/gaia/pull/74", repository: "cill-i-am/gaia", state: "intentRecorded" };
    expect(parseDeliveryMergeReceipt(base).state).toBe("intentRecorded");
    expect(() => parseDeliveryMergeReceipt({ ...base, mergeMethod: "fast-forward" })).toThrow();
    expect(() => parseDeliveryMergeReceipt({ ...base, unexpected: true })).toThrow();
  });

  it("only completes cleanup when both exact resources are absent", () => {
    const base = { actionId: "cleanup-1", branchName: "gaia/run-1234567890", mergeCommitSha: "a".repeat(40), ownershipDigest: "b".repeat(64) };
    expect(parseDeliveryCleanupReceipt({ ...base, branch: "absent", state: "completed", worktree: "absent" }).state).toBe("completed");
    expect(parseDeliveryCleanupReceipt({ ...base, branch: "present", state: "cleanupRequired", worktree: "absent" }).state).toBe("cleanupRequired");
    expect(() => parseDeliveryCleanupReceipt({ ...base, branch: "present", state: "completed", worktree: "absent" })).toThrow();
  });

  it("keeps pull-request delivery non-terminal until exact merge and both-resource cleanup", () => {
    const runId = parseRunId("run-1234567890");
    const binding = { actionId: "merge-1", branchName: "gaia/run-1234567890", decisionSequence: 3, expectedHeadSha: "a".repeat(40), mergeMethod: "merge" as const, payloadDigest: "b".repeat(64), policyDigest: "c".repeat(64), policyVersion: 1 as const, prNumber: 74, prUrl: "https://github.com/cill-i-am/gaia/pull/74", repository: "cill-i-am/gaia" };
    const decision = DeliveryMergeReadinessDecision.make({ actionId: "readiness-1", approved: true, blockers: [], branchName: binding.branchName, headSha: binding.expectedHeadSha, mergeMethod: "merge", payloadDigest: "f".repeat(64), policyDigest: binding.policyDigest, policyVersion: 1, prNumber: 74, prUrl: binding.prUrl });
    const intent = DeliveryMergeIntent.make({ ...binding, state: "intentRecorded" });
    const attempted = DeliveryMergeDispatchAttempted.make({ ...binding, state: "dispatchAttempted" });
    const confirmed = DeliveryMergeDispatchConfirmed.make({ ...binding, mergeCommitSha: "d".repeat(40), mergedAt: "2026-07-11T19:00:00.000Z", state: "dispatchConfirmed" });
    const event = (sequence: number, type: Parameters<typeof makeRunEvent>[0]["type"], payload: Readonly<Record<string, Schema.Json>>) => makeRunEvent({ payload, runId, sequence, timestamp: `2026-07-11T19:00:0${sequence}.000Z`, type });
    const base = [event(1, "RUN_CREATED", { specPath: "spec.md" }), event(2, "DELIVERY_STARTED", { delivery: { baseBranch: "main", baseRevision: "0".repeat(40), headBranch: binding.branchName, mode: "pullRequest", remote: "origin", stage: "waitingForPr" } }), event(3, "DELIVERY_MERGE_READINESS_RECORDED", { decision: encodeDeliveryMergeReadinessDecisionJson(decision) }), event(4, "DELIVERY_MERGE_RECORDED", { mergeAction: encodeDeliveryMergeReceiptJson(intent) }), event(5, "DELIVERY_MERGE_RECORDED", { mergeAction: encodeDeliveryMergeReceiptJson(attempted) }), event(6, "DELIVERY_MERGE_RECORDED", { mergeAction: encodeDeliveryMergeReceiptJson(confirmed) })];
    expect(snapshotFromReplay(base).state).toBe("delivering");
    const partial = DeliveryCleanupRequired.make({ actionId: "cleanup-1", branch: "present", branchName: binding.branchName, mergeCommitSha: confirmed.mergeCommitSha, ownershipDigest: "e".repeat(64), state: "cleanupRequired", worktree: "absent" });
    const partialEvents = [...base, event(7, "DELIVERY_CLEANUP_RECORDED", { cleanup: encodeDeliveryCleanupReceiptJson(partial) })];
    expect(snapshotFromReplay(partialEvents).state).toBe("delivering");
    const complete = DeliveryCleanupCompleted.make({ actionId: "cleanup-1", branch: "absent", branchName: binding.branchName, mergeCommitSha: confirmed.mergeCommitSha, ownershipDigest: "e".repeat(64), state: "completed", worktree: "absent" });
    expect(snapshotFromReplay([...partialEvents, event(8, "DELIVERY_CLEANUP_RECORDED", { cleanup: encodeDeliveryCleanupReceiptJson(complete) })]).state).toBe("completed");
  });

  it("derives immutable interleaved action histories with deterministic active and bounded audit", () => {
    const binding = { actionId: "merge-1", branchName: "gaia/run-1234567890", decisionSequence: 3, expectedHeadSha: "a".repeat(40), mergeMethod: "merge" as const, payloadDigest: "b".repeat(64), policyDigest: "c".repeat(64), policyVersion: 1 as const, prNumber: 74, prUrl: "https://github.com/cill-i-am/gaia/pull/74", repository: "cill-i-am/gaia" };
    const intent = DeliveryMergeIntent.make({ ...binding, state: "intentRecorded" });
    const attempted = DeliveryMergeDispatchAttempted.make({ ...binding, state: "dispatchAttempted" });
    const failed = parseDeliveryMergeReceipt({ ...binding, code: "rejected", message: "rejected", state: "dispatchFailed" });
    const next = DeliveryMergeIntent.make({ ...binding, actionId: "merge-2", decisionSequence: 9, payloadDigest: "d".repeat(64), state: "intentRecorded" });
    const merge = deriveDeliveryMergeActionHistories([{ receipt: intent, sequence: 4 }, { receipt: attempted, sequence: 5 }, { receipt: failed, sequence: 6 }, { receipt: next, sequence: 10 }]);
    expect(merge.histories).toHaveLength(2);
    expect(merge.latest?.actionId).toBe("merge-2");
    expect(merge.active?.actionId).toBe("merge-2");
    expect(merge.histories[0]?.receipts).toHaveLength(3);
    expect(() => deriveDeliveryMergeActionHistories([{ receipt: intent, sequence: 4 }, { receipt: DeliveryMergeDispatchAttempted.make({ ...binding, payloadDigest: "e".repeat(64), state: "dispatchAttempted" }), sequence: 5 }])).toThrow();
    const cleanup = deriveDeliveryCleanupActionHistories([]);
    expect(deliveryActionAuditSummary({ cleanup, merge }, 1).merge).toEqual([{ actionId: "merge-2", latestSequence: 10, state: "intentRecorded" }]);
  });
});
