import { NodePath, NodeServices } from "@effect/platform-node";
import {
  DeliveryFeedbackTrustPolicyV1,
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationIntent,
  RunEvent,
  encodeDeliveryPublicationJson,
  makeRunEvent,
  parseDeliveryLocalReviewAttestationReceipt,
  parseRunId,
} from "@gaia/core";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDeliveryFeedbackTrustPolicy } from "./delivery-remediation-coordinator.js";
import { coordinateDeliveryPullRequestReady, type FreshReadyForReviewState } from "./delivery-ready-for-review-coordinator.js";
import { coordinateDeliveryLocalReviewAttestation } from "./delivery-review-attestation-coordinator.js";
import { makeRunPaths } from "./paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "gaia-review-attestation-"));
  roots.push(root);
  const runId = parseRunId("run-attest1234");
  const paths = Effect.runSync(makeRunPaths(runId, { rootDirectory: root }).pipe(Effect.provide(NodePath.layer)));
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.snapshots, "");
  const publicationBase = {
    baseBranch: "main",
    baseRevision: "0".repeat(40),
    branchName: "gaia/run-attest1234",
    commitMessage: "feat: delivery",
    commitTimestamp: "2026-07-13T10:00:00.000Z",
    digestVersion: 1 as const,
    operationId: "delivery:run-attest1234:1",
    payloadDigest: "1".repeat(64),
    sourcePaths: ["feature.ts"],
    treeSha: "2".repeat(40),
  };
  const attempt = DeliveryPublicationAttempted.make({ ...publicationBase, commitSha: "a".repeat(40), state: "attempted" });
  const publication = DeliveryPublicationConfirmed.make({ ...attempt, draft: true, headSha: attempt.commitSha, prNumber: 74, prUrl: "https://github.com/cill-i-am/gaia/pull/74", state: "confirmed" });
  const trust = defaultDeliveryFeedbackTrustPolicy("cill-i-am/gaia");
  const event = (sequence: number, type: Parameters<typeof makeRunEvent>[0]["type"], payload: Readonly<Record<string, Schema.Json>>) =>
    makeRunEvent({ payload, runId, sequence, timestamp: `2026-07-13T10:00:${String(sequence).padStart(2, "0")}.000Z`, type });
  const events = [
    event(1, "RUN_CREATED", { specPath: "spec.md" }),
    event(2, "DELIVERY_STARTED", { delivery: { baseBranch: "main", baseRevision: publication.baseRevision, feedbackTrustPolicy: Schema.encodeSync(DeliveryFeedbackTrustPolicyV1)(trust), headBranch: publication.branchName, mode: "pullRequest", remote: "origin", stage: "delivering" } }),
    event(3, "DELIVERY_PUBLICATION_INTENT_RECORDED", { publication: encodeDeliveryPublicationJson(DeliveryPublicationIntent.make({ ...publicationBase, state: "intentRecorded" })) }),
    event(4, "DELIVERY_PUBLICATION_ATTEMPTED", { publication: encodeDeliveryPublicationJson(attempt) }),
    event(5, "DELIVERY_PUBLICATION_CONFIRMED", { publication: encodeDeliveryPublicationJson(publication) }),
  ];
  writeFileSync(paths.events, `${events.map((value) => JSON.stringify(Schema.encodeSync(RunEvent)(value))).join("\n")}\n`);
  const fresh: FreshReadyForReviewState = { branchName: publication.branchName, draft: false, headSha: publication.headSha, prNumber: publication.prNumber, prUrl: publication.prUrl, repository: "cill-i-am/gaia", state: "open" };
  return { fresh, paths, publication, root, runId };
}

function attestationReceipts(f: ReturnType<typeof fixture>) {
  return readFileSync(f.paths.events, "utf8").trim().split("\n")
    .map((line) => Schema.decodeUnknownSync(RunEvent)(JSON.parse(line)))
    .filter(({ type }) => type === "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED")
    .map(({ payload }) => parseDeliveryLocalReviewAttestationReceipt(payload["attestation"]));
}

async function ready(f: ReturnType<typeof fixture>) {
  return Effect.runPromise(coordinateDeliveryPullRequestReady(f.runId, {
    actionId: "ready-attest-1",
    expectedBranchName: f.publication.branchName,
    expectedHeadSha: f.publication.headSha,
    expectedPrNumber: f.publication.prNumber,
    expectedPrUrl: f.publication.prUrl,
    kind: "markReadyForReview",
  }, { freshStateReader: () => Effect.succeed(f.fresh), rootDirectory: f.root }).pipe(Effect.provide(NodeServices.layer)));
}

describe("local operator paired-review attestation coordinator", () => {
  it("records intent then confirms an exact open current-head action without provider mutation", async () => {
    const f = fixture();
    await ready(f);
    let reads = 0;
    const result = await Effect.runPromise(coordinateDeliveryLocalReviewAttestation(f.runId, {
      actionId: "attestation-action-1",
      decision: "approved",
      expectedBranchName: f.publication.branchName,
      expectedHeadSha: f.publication.headSha,
      expectedPrNumber: f.publication.prNumber,
      expectedPrUrl: f.publication.prUrl,
      gaiaEvidenceDigest: "e".repeat(64),
      kind: "attestPairedReviewApproval",
    }, { freshStateReader: () => Effect.sync(() => { reads += 1; return f.fresh; }), rootDirectory: f.root }).pipe(Effect.provide(NodeServices.layer)));

    expect(result).toMatchObject({ actionId: "attestation-action-1", authority: "localOperator", decision: "approved", headSha: f.publication.headSha, state: "confirmed" });
    expect(result.gaiaEvidenceId).toMatch(/^evidence-[A-Za-z0-9_-]{16,120}$/u);
    expect(reads).toBe(1);
    expect(attestationReceipts(f).map(({ state }) => state)).toEqual(["intentRecorded", "confirmed"]);
    const persisted = readFileSync(f.paths.events, "utf8");
    expect(persisted).not.toContain("linear.app");
    expect(persisted).not.toContain("reviewerIdentity");
    expect(persisted).not.toContain("reviewText");
    expect(persisted).not.toContain("sessionId");
  });

  it("keeps intent active when the mandatory fresh read is unavailable and resumes the same ID", async () => {
    const f = fixture();
    await ready(f);
    const action = { actionId: "attestation-action-1", decision: "approved" as const, expectedBranchName: f.publication.branchName, expectedHeadSha: f.publication.headSha, expectedPrNumber: f.publication.prNumber, expectedPrUrl: f.publication.prUrl, kind: "attestPairedReviewApproval" as const };
    await expect(Effect.runPromise(coordinateDeliveryLocalReviewAttestation(f.runId, action, { freshStateReader: () => Effect.fail("offline"), rootDirectory: f.root }).pipe(Effect.provide(NodeServices.layer)))).rejects.toMatchObject({ code: "DeliveryReviewAttestationReadFailed" });
    expect(attestationReceipts(f).map(({ state }) => state)).toEqual(["intentRecorded"]);

    const result = await Effect.runPromise(coordinateDeliveryLocalReviewAttestation(f.runId, action, { freshStateReader: () => Effect.succeed(f.fresh), rootDirectory: f.root }).pipe(Effect.provide(NodeServices.layer)));
    expect(result.state).toBe("confirmed");
    expect(attestationReceipts(f)[0]?.gaiaEvidenceId).toBe(result.gaiaEvidenceId);
  });

  it("admits one concurrent duplicate and lets the lock-conflicted request retry idempotently", async () => {
    const f = fixture();
    await ready(f);
    let reads = 0;
    const action = { actionId: "attestation-concurrent-1", decision: "approved" as const, expectedBranchName: f.publication.branchName, expectedHeadSha: f.publication.headSha, expectedPrNumber: f.publication.prNumber, expectedPrUrl: f.publication.prUrl, kind: "attestPairedReviewApproval" as const };
    const invoke = () => Effect.runPromise(coordinateDeliveryLocalReviewAttestation(f.runId, action, { freshStateReader: () => Effect.sync(() => { reads += 1; return f.fresh; }), rootDirectory: f.root }).pipe(Effect.provide(NodeServices.layer)));

    const concurrent = await Promise.allSettled([invoke(), invoke()]);
    const fulfilled = concurrent.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof invoke>>> => result.status === "fulfilled");
    const rejected = concurrent.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const replay = await invoke();

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.state).toBe("confirmed");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "RunStoreLocked" });
    expect(replay.state).toBe("confirmed");
    expect(reads).toBe(1);
    expect(attestationReceipts(f).map(({ state }) => state)).toEqual(["intentRecorded", "confirmed"]);
  });

  it.each([
    ["closed", { state: "closed" as const }],
    ["merged", { state: "merged" as const, mergedAt: "2026-07-13T10:10:00.000Z", mergeCommitSha: "b".repeat(40) }],
  ])("records terminal failure when the exact pull request is %s", async (_name, override) => {
    const f = fixture();
    await ready(f);
    const result = await Effect.runPromise(coordinateDeliveryLocalReviewAttestation(f.runId, { actionId: "attestation-action-1", decision: "approved", expectedBranchName: f.publication.branchName, expectedHeadSha: f.publication.headSha, expectedPrNumber: f.publication.prNumber, expectedPrUrl: f.publication.prUrl, kind: "attestPairedReviewApproval" }, { freshStateReader: () => Effect.succeed({ ...f.fresh, ...override }), rootDirectory: f.root }).pipe(Effect.provide(NodeServices.layer)));
    expect(result).toMatchObject({ code: "DeliveryReviewAttestationPullRequestUnavailable", state: "failed" });
  });
});
