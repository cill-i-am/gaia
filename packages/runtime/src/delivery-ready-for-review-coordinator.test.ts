import { NodePath, NodeServices } from "@effect/platform-node";
import {
  DeliveryFeedbackTrustPolicyV1,
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationIntent,
  DeliveryPullRequestReadyDispatchAttempted,
  DeliveryPullRequestReadyIntent,
  DeliveryPullRequestReadyTerminalFailure,
  RunEvent,
  deliveryPullRequestReadyCanonicalPayload,
  encodeDeliveryPublicationJson,
  encodeDeliveryPullRequestReadyReceiptJson,
  makeRunEvent,
  parseDeliveryPullRequestReadyReceipt,
  parseRunId,
} from "@gaia/core";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDeliveryFeedbackTrustPolicy } from "./delivery-remediation-coordinator.js";
import { DeliveryReadyForReviewConclusivelyRejected } from "./delivery-merge-provider.js";
import {
  coordinateDeliveryPullRequestReady,
  type FreshReadyForReviewState,
} from "./delivery-ready-for-review-coordinator.js";
import { makeRunPaths } from "./paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(prior?: "attempted" | "failed" | "intent" | "unknown") {
  const root = mkdtempSync(path.join(tmpdir(), "gaia-ready-action-"));
  roots.push(root);
  const runId = parseRunId("run-ready12345");
  const paths = Effect.runSync(makeRunPaths(runId, { rootDirectory: root }).pipe(Effect.provide(NodePath.layer)));
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.snapshots, "");
  const trust = defaultDeliveryFeedbackTrustPolicy("cill-i-am/gaia");
  const publicationBase = {
    baseBranch: "main",
    baseRevision: "0".repeat(40),
    branchName: "gaia/run-ready12345",
    commitMessage: "feat: delivery",
    commitTimestamp: "2026-07-13T07:00:00.000Z",
    digestVersion: 1 as const,
    operationId: "delivery:run-ready12345:1",
    payloadDigest: "1".repeat(64),
    sourcePaths: ["feature.ts"],
    treeSha: "2".repeat(40),
  };
  const pubIntent = DeliveryPublicationIntent.make({ ...publicationBase, state: "intentRecorded" });
  const pubAttempt = DeliveryPublicationAttempted.make({ ...publicationBase, commitSha: "a".repeat(40), state: "attempted" });
  const publication = DeliveryPublicationConfirmed.make({
    ...pubAttempt,
    draft: true,
    headSha: "a".repeat(40),
    prNumber: 74,
    prUrl: "https://github.com/cill-i-am/gaia/pull/74",
    state: "confirmed",
  });
  const action = {
    actionId: "ready-action-1",
    expectedBranchName: publication.branchName,
    expectedHeadSha: publication.headSha,
    expectedPrNumber: publication.prNumber,
    expectedPrUrl: publication.prUrl,
    kind: "markReadyForReview" as const,
  };
  const bindingBase = {
    actionId: action.actionId,
    branchName: action.expectedBranchName,
    expectedHeadSha: action.expectedHeadSha,
    prNumber: action.expectedPrNumber,
    prUrl: action.expectedPrUrl,
    publicationOperationId: publication.operationId,
    publicationPayloadDigest: publication.payloadDigest,
    repository: "cill-i-am/gaia",
    runId,
    version: 1 as const,
  };
  const binding = {
    ...bindingBase,
    payloadDigest: createHash("sha256").update(deliveryPullRequestReadyCanonicalPayload(bindingBase)).digest("hex"),
  };
  const event = (sequence: number, type: Parameters<typeof makeRunEvent>[0]["type"], payload: Readonly<Record<string, Schema.Json>>) =>
    makeRunEvent({ payload, runId, sequence, timestamp: `2026-07-13T07:00:${String(sequence).padStart(2, "0")}.000Z`, type });
  const intent = DeliveryPullRequestReadyIntent.make({ ...binding, state: "intentRecorded" });
  const events = [
    event(1, "RUN_CREATED", { specPath: "spec.md" }),
    event(2, "DELIVERY_STARTED", { delivery: { baseBranch: "main", baseRevision: "0".repeat(40), feedbackTrustPolicy: Schema.encodeSync(DeliveryFeedbackTrustPolicyV1)(trust), headBranch: publication.branchName, mode: "pullRequest", remote: "origin", stage: "delivering" } }),
    event(3, "DELIVERY_PUBLICATION_INTENT_RECORDED", { publication: encodeDeliveryPublicationJson(pubIntent) }),
    event(4, "DELIVERY_PUBLICATION_ATTEMPTED", { publication: encodeDeliveryPublicationJson(pubAttempt) }),
    event(5, "DELIVERY_PUBLICATION_CONFIRMED", { publication: encodeDeliveryPublicationJson(publication) }),
    ...(prior === undefined ? [] : [event(6, "DELIVERY_PR_READY_RECORDED", { readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(intent) })]),
    ...((prior === "attempted" || prior === "unknown" || prior === "failed") ? [event(7, "DELIVERY_PR_READY_RECORDED", { readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(DeliveryPullRequestReadyDispatchAttempted.make({ ...binding, state: "dispatchAttempted" })) })] : []),
    ...(prior === "unknown" || prior === "failed" ? [event(8, "DELIVERY_PR_READY_RECORDED", { readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(DeliveryPullRequestReadyTerminalFailure.make({ ...binding, code: prior === "failed" ? "DeliveryReadyRejected" : "DeliveryReadyOutcomeUnknown", message: "Fresh provider state did not confirm the action.", state: prior === "failed" ? "dispatchFailed" : "outcomeUnknown" })) })] : []),
  ];
  writeFileSync(paths.events, `${events.map((value) => JSON.stringify(Schema.encodeSync(RunEvent)(value))).join("\n")}\n`);
  return { action, binding, paths, publication, root, runId };
}

const fresh = (f: ReturnType<typeof fixture>, draft: boolean): FreshReadyForReviewState => ({
  branchName: f.action.expectedBranchName,
  draft,
  headSha: f.action.expectedHeadSha,
  prNumber: f.action.expectedPrNumber,
  prUrl: f.action.expectedPrUrl,
  repository: "cill-i-am/gaia",
  state: "open",
});

function receipts(f: ReturnType<typeof fixture>) {
  return readFileSync(f.paths.events, "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(RunEvent)(JSON.parse(line)))
    .filter(({ type }) => type === "DELIVERY_PR_READY_RECORDED")
    .map(({ payload }) => parseDeliveryPullRequestReadyReceipt(payload["readyForReviewAction"]));
}

describe("owned pull request ready-for-review coordinator", () => {
  it("binds the confirmed publication generation and confirms only after an exact post-read", async () => {
    const f = fixture();
    let providerCalls = 0;
    let reads = 0;
    const result = await Effect.runPromise(coordinateDeliveryPullRequestReady(f.runId, f.action, {
      freshStateReader: () => Effect.sync(() => fresh(f, reads++ === 0)),
      readyForReviewProvider: () => Effect.sync(() => { providerCalls += 1; }),
      rootDirectory: f.root,
    }).pipe(Effect.provide(NodeServices.layer)));

    expect(result.state).toBe("dispatchConfirmed");
    expect(providerCalls).toBe(1);
    expect(reads).toBe(2);
    expect(receipts(f).map(({ state }) => state)).toEqual(["intentRecorded", "dispatchAttempted", "dispatchConfirmed"]);
    expect(result.publicationOperationId).toBe(f.publication.operationId);
    expect(result.publicationPayloadDigest).toBe(f.publication.payloadDigest);
    expect(result.payloadDigest).toBe(f.binding.payloadDigest);
  });

  it("records legal intent and confirms an already-ready exact PR without dispatch", async () => {
    const f = fixture();
    let providerCalls = 0;
    const result = await Effect.runPromise(coordinateDeliveryPullRequestReady(f.runId, f.action, {
      freshStateReader: () => Effect.succeed(fresh(f, false)),
      readyForReviewProvider: () => Effect.sync(() => { providerCalls += 1; }),
      rootDirectory: f.root,
    }).pipe(Effect.provide(NodeServices.layer)));

    expect(result.state).toBe("confirmedWithoutDispatch");
    expect(providerCalls).toBe(0);
    expect(receipts(f).map(({ state }) => state)).toEqual(["intentRecorded", "confirmedWithoutDispatch"]);
  });

  for (const prior of ["attempted", "unknown", "failed"] as const) {
    it(`reconciles ${prior} read-only and never redispatches`, async () => {
      const f = fixture(prior);
      let providerCalls = 0;
      const result = await Effect.runPromise(coordinateDeliveryPullRequestReady(f.runId, f.action, {
        freshStateReader: () => Effect.succeed(fresh(f, false)),
        readyForReviewProvider: () => Effect.sync(() => { providerCalls += 1; }),
        rootDirectory: f.root,
      }).pipe(Effect.provide(NodeServices.layer)));

      expect(result.state).toBe("dispatchConfirmed");
      expect(providerCalls).toBe(0);
    });
  }

  it("keeps a conclusive failure stable when read-only reconciliation still proves exact draft", async () => {
    const f = fixture("failed");
    let providerCalls = 0;
    const result = await Effect.runPromise(coordinateDeliveryPullRequestReady(f.runId, f.action, {
      freshStateReader: () => Effect.succeed(fresh(f, true)),
      readyForReviewProvider: () => Effect.sync(() => { providerCalls += 1; }),
      rootDirectory: f.root,
    }).pipe(Effect.provide(NodeServices.layer)));

    expect(result.state).toBe("dispatchFailed");
    expect(providerCalls).toBe(0);
    expect(receipts(f).map(({ state }) => state)).toEqual(["intentRecorded", "dispatchAttempted", "dispatchFailed"]);
  });

  it("records outcome unknown when the mandatory post-read drifts", async () => {
    const f = fixture();
    let reads = 0;
    const result = await Effect.runPromise(coordinateDeliveryPullRequestReady(f.runId, f.action, {
      freshStateReader: () => Effect.sync(() => reads++ === 0 ? fresh(f, true) : { ...fresh(f, false), headSha: "b".repeat(40) }),
      readyForReviewProvider: () => Effect.void,
      rootDirectory: f.root,
    }).pipe(Effect.provide(NodeServices.layer)));

    expect(result.state).toBe("outcomeUnknown");
    expect(receipts(f).at(-1)).toMatchObject({ code: "DeliveryReadyOutcomeUnknown", state: "outcomeUnknown" });
  });

  it("records conclusive failure only when the post-read proves the exact PR remains draft", async () => {
    const f = fixture();
    const result = await Effect.runPromise(coordinateDeliveryPullRequestReady(f.runId, f.action, {
      freshStateReader: () => Effect.succeed(fresh(f, true)),
      readyForReviewProvider: () => Effect.fail(new DeliveryReadyForReviewConclusivelyRejected({ message: "hostile-provider-detail" })),
      rootDirectory: f.root,
    }).pipe(Effect.provide(NodeServices.layer)));

    expect(result).toMatchObject({ code: "DeliveryReadyRejected", state: "dispatchFailed" });
    expect(JSON.stringify(result)).not.toContain("hostile-provider-detail");
  });

  it("rejects a corrupted canonical digest during replay before any provider access", async () => {
    const f = fixture("intent");
    const body = readFileSync(f.paths.events, "utf8").replace(f.binding.payloadDigest, "f".repeat(64));
    writeFileSync(f.paths.events, body);
    let providerCalls = 0;
    await expect(Effect.runPromise(coordinateDeliveryPullRequestReady(f.runId, f.action, {
      freshStateReader: () => Effect.die("reader must not run"),
      readyForReviewProvider: () => Effect.sync(() => { providerCalls += 1; }),
      rootDirectory: f.root,
    }).pipe(Effect.provide(NodeServices.layer)))).rejects.toMatchObject({ code: "DeliveryActionConflict" });
    expect(providerCalls).toBe(0);
  });

  it("rejects a changed visible tuple before intent or provider invocation", async () => {
    const f = fixture();
    let providerCalls = 0;
    await expect(Effect.runPromise(coordinateDeliveryPullRequestReady(f.runId, f.action, {
      freshStateReader: () => Effect.succeed({ ...fresh(f, true), headSha: "b".repeat(40) }),
      readyForReviewProvider: () => Effect.sync(() => { providerCalls += 1; }),
      rootDirectory: f.root,
    }).pipe(Effect.provide(NodeServices.layer)))).rejects.toMatchObject({ code: "DeliveryActionConflict" });
    expect(providerCalls).toBe(0);
    expect(receipts(f)).toEqual([]);
  });
});
