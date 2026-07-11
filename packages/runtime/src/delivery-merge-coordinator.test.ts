import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { NodePath, NodeServices } from "@effect/platform-node";
import {
  DeliveryFeedbackTrustPolicyV1,
  DeliveryMergeDispatchAttempted,
  DeliveryMergeIntent,
  DeliveryMergeReadinessDecision,
  DeliveryMergeTerminalFailure,
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationIntent,
  RunEvent,
  deliveryRequiredCheckPolicyCanonicalPayload,
  encodeDeliveryMergeReadinessDecisionJson,
  encodeDeliveryMergeReceiptJson,
  encodeDeliveryPublicationJson,
  makeRunEvent,
  parseRunId,
} from "@gaia/core";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDeliveryFeedbackTrustPolicy } from "./delivery-remediation-coordinator.js";
import { coordinateDeliveryMerge, coordinateDeliveryMergeReadiness, requiredCheckPolicyFromTrustPolicy, type FreshMergeState } from "./delivery-merge-coordinator.js";
import { makeRunPaths } from "./paths.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

function fixture(state: "attempted" | "checkpoint" | "unknown") {
  const root = mkdtempSync(path.join(tmpdir(), "gaia-merge-restart-")); roots.push(root);
  const runId = parseRunId("run-1234567890");
  const paths = Effect.runSync(makeRunPaths(runId, { rootDirectory: root }).pipe(Effect.provide(NodePath.layer)));
  mkdirSync(paths.root, { recursive: true }); writeFileSync(paths.snapshots, "");
  const trust = defaultDeliveryFeedbackTrustPolicy("cill-i-am/gaia");
  const policyDigest = createHash("sha256").update(deliveryRequiredCheckPolicyCanonicalPayload(requiredCheckPolicyFromTrustPolicy(trust))).digest("hex");
  const publicationBase = { baseBranch: "main", baseRevision: "0".repeat(40), branchName: "gaia/run-1234567890", commitMessage: "feat: delivery", commitTimestamp: "2026-07-11T19:00:00.000Z", digestVersion: 1 as const, operationId: "delivery:run-1234567890:1", payloadDigest: "1".repeat(64), sourcePaths: ["feature.ts"], treeSha: "2".repeat(40) };
  const pubIntent = DeliveryPublicationIntent.make({ ...publicationBase, state: "intentRecorded" });
  const pubAttempt = DeliveryPublicationAttempted.make({ ...publicationBase, commitSha: "a".repeat(40), state: "attempted" });
  const publication = DeliveryPublicationConfirmed.make({ ...pubAttempt, draft: true, headSha: "a".repeat(40), prNumber: 74, prUrl: "https://github.com/cill-i-am/gaia/pull/74", state: "confirmed" });
  const binding = { actionId: "merge-1", branchName: publication.branchName, decisionSequence: 6, expectedHeadSha: publication.headSha, mergeMethod: "merge" as const, payloadDigest: createHash("sha256").update(["merge-1", runId, publication.prUrl, publication.branchName, publication.headSha, "6", "merge", policyDigest].join("\0")).digest("hex"), policyDigest, policyVersion: 1 as const, prNumber: 74, prUrl: publication.prUrl, repository: "cill-i-am/gaia" };
  const decision = DeliveryMergeReadinessDecision.make({ actionId: "readiness-1", approved: true, blockers: [], branchName: binding.branchName, headSha: binding.expectedHeadSha, mergeMethod: binding.mergeMethod, payloadDigest: createHash("sha256").update(["readiness-1", runId, binding.prUrl, binding.branchName, binding.mergeMethod, policyDigest].join("\0")).digest("hex"), policyDigest, policyVersion: 1, prNumber: 74, prUrl: binding.prUrl });
  const intent = DeliveryMergeIntent.make({ ...binding, state: "intentRecorded" });
  const attempted = DeliveryMergeDispatchAttempted.make({ ...binding, state: "dispatchAttempted" });
  const event = (sequence: number, type: Parameters<typeof makeRunEvent>[0]["type"], payload: Readonly<Record<string, Schema.Json>>) => makeRunEvent({ payload, runId, sequence, timestamp: `2026-07-11T19:00:${String(sequence).padStart(2, "0")}.000Z`, type });
  const events = [
    event(1, "RUN_CREATED", { specPath: "spec.md" }),
    event(2, "DELIVERY_STARTED", { delivery: { baseBranch: "main", baseRevision: "0".repeat(40), feedbackTrustPolicy: Schema.encodeSync(DeliveryFeedbackTrustPolicyV1)(trust), headBranch: publication.branchName, mode: "pullRequest", remote: "origin", stage: "delivering" } }),
    event(3, "DELIVERY_PUBLICATION_INTENT_RECORDED", { publication: encodeDeliveryPublicationJson(pubIntent) }),
    event(4, "DELIVERY_PUBLICATION_ATTEMPTED", { publication: encodeDeliveryPublicationJson(pubAttempt) }),
    event(5, "DELIVERY_PUBLICATION_CONFIRMED", { publication: encodeDeliveryPublicationJson(publication) }),
    event(6, "DELIVERY_MERGE_READINESS_RECORDED", { decision: encodeDeliveryMergeReadinessDecisionJson(decision) }),
    event(7, "DELIVERY_MERGE_RECORDED", { mergeAction: encodeDeliveryMergeReceiptJson(intent) }),
    event(8, "DELIVERY_MERGE_RECORDED", { mergeAction: encodeDeliveryMergeReceiptJson(attempted) }),
    ...(state === "checkpoint" ? [event(9, "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED", { checkpoint: { actionId: binding.actionId, payloadDigest: binding.payloadDigest, state: "attemptRecorded", version: 1 } })] : []),
    ...(state === "unknown" ? [event(9, "DELIVERY_MERGE_RECORDED", { mergeAction: encodeDeliveryMergeReceiptJson(DeliveryMergeTerminalFailure.make({ ...binding, code: "DeliveryMergeOutcomeUnknown", message: "ambiguous", state: "outcomeUnknown" })) })] : []),
  ];
  writeFileSync(paths.events, `${events.map((value) => JSON.stringify(Schema.encodeSync(RunEvent)(value))).join("\n")}\n`);
  const action = { actionId: binding.actionId, expectedBranchName: binding.branchName, expectedDecisionSequence: 6, expectedHeadSha: binding.expectedHeadSha, expectedPolicyDigest: policyDigest, expectedPrUrl: binding.prUrl, kind: "merge" as const, mergeMethod: "merge" as const };
  return { action, binding, root, runId };
}

const merged = (binding: ReturnType<typeof fixture>["binding"]): FreshMergeState => ({ branchName: binding.branchName, checks: [], draft: false, headSha: binding.expectedHeadSha, mergeCommitSha: "d".repeat(40), mergeability: "mergeable", mergedAt: "2026-07-11T20:00:00.000Z", prNumber: binding.prNumber, prUrl: binding.prUrl, repository: binding.repository, reviewDecision: "APPROVED", state: "merged", supportedMethods: ["merge"], unresolvedActionableThreads: 0 });

describe("delivery merge reconstructed coordinator", () => {
  it("replays identical readiness action without reread and rejects changed method", async () => {
    const f = fixture("attempted"); let reads = 0;
    const options = { freshStateReader: () => Effect.sync(() => { reads += 1; return merged(f.binding); }), rootDirectory: f.root };
    const replay = await Effect.runPromise(coordinateDeliveryMergeReadiness(f.runId, { actionId: "readiness-1", kind: "evaluateMergeReadiness", mergeMethod: "merge" }, options).pipe(Effect.provide(NodeServices.layer)));
    expect(replay.actionId).toBe("readiness-1"); expect(reads).toBe(0);
    await expect(Effect.runPromise(coordinateDeliveryMergeReadiness(f.runId, { actionId: "readiness-1", kind: "evaluateMergeReadiness", mergeMethod: "rebase" }, options).pipe(Effect.provide(NodeServices.layer)))).rejects.toMatchObject({ code: "DeliveryActionConflict" });
    expect(reads).toBe(0);
  });
  for (const state of ["attempted", "checkpoint", "unknown"] as const) {
    it(`reconciles ${state} with zero provider redispatch`, async () => {
      const f = fixture(state); let providerCalls = 0; let reconciliationCalls = 0;
      const receipt = await Effect.runPromise(coordinateDeliveryMerge(f.runId, f.action, { commandRunner: () => Effect.sync(() => { providerCalls += 1; return { exitCode: 0, stderr: "", stdout: "" }; }), freshStateReader: () => Effect.sync(() => { reconciliationCalls += 1; return merged(f.binding); }), rootDirectory: f.root }).pipe(Effect.provide(NodeServices.layer)));
      expect(receipt.state).toBe("dispatchConfirmed"); expect(providerCalls).toBe(0); expect(reconciliationCalls).toBe(1);
    });
  }

  it("serializes concurrent duplicate replay without provider invocation", async () => {
    const f = fixture("unknown"); let providerCalls = 0; let reconciliationCalls = 0;
    const options = { commandRunner: () => Effect.sync(() => { providerCalls += 1; return { exitCode: 0, stderr: "", stdout: "" }; }), freshStateReader: () => Effect.sync(() => { reconciliationCalls += 1; return merged(f.binding); }), rootDirectory: f.root };
    const results = await Promise.allSettled([Effect.runPromise(coordinateDeliveryMerge(f.runId, f.action, options).pipe(Effect.provide(NodeServices.layer))), Effect.runPromise(coordinateDeliveryMerge(f.runId, f.action, options).pipe(Effect.provide(NodeServices.layer)))]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(providerCalls).toBe(0); expect(reconciliationCalls).toBe(1);
  });

  it("retains outcome unknown when fresh exact state cannot prove acceptance or rejection", async () => {
    const f = fixture("checkpoint"); let providerCalls = 0; let reconciliationCalls = 0;
    const { mergeCommitSha: _mergeCommitSha, mergedAt: _mergedAt, ...fresh } = merged(f.binding);
    const open = { ...fresh, state: "open" as const };
    const receipt = await Effect.runPromise(coordinateDeliveryMerge(f.runId, f.action, { commandRunner: () => Effect.sync(() => { providerCalls += 1; return { exitCode: 0, stderr: "", stdout: "" }; }), freshStateReader: () => Effect.sync(() => { reconciliationCalls += 1; return open; }), rootDirectory: f.root }).pipe(Effect.provide(NodeServices.layer)));
    expect(receipt.state).toBe("outcomeUnknown"); expect(providerCalls).toBe(0); expect(reconciliationCalls).toBe(1);
  });
});
