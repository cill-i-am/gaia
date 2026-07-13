import {
  DeliveryPublicationConfirmedDto,
  DeliveryPullRequestObservation,
  DeliveryPullRequestReadyDispatchAttempted,
  DeliveryPullRequestReadyTerminalFailure,
  DeliverySnapshotDto,
  parseRunId,
} from "@gaia/core";
import { describe, expect, it } from "vitest";

import { readyForReviewAction } from "./dashboard-shell";

const runId = parseRunId("run-7777777777");
const publication = DeliveryPublicationConfirmedDto.make({
  branchName: "gaia/run-7777777777",
  commitSha: "a".repeat(40),
  draft: true as const,
  prNumber: 91,
  prUrl: "https://github.com/cill-i-am/gaia/pull/91",
  state: "confirmed" as const,
});
const observation = DeliveryPullRequestObservation.make({
  blockers: [],
  branchName: publication.branchName,
  checks: [],
  draft: true,
  feedback: [],
  headSha: publication.commitSha,
  mergeability: "mergeable",
  observedAt: "2026-07-13T08:00:00.000Z",
  prNumber: publication.prNumber,
  prUrl: publication.prUrl,
  repository: "cill-i-am/gaia",
  snapshotDigest: "b".repeat(64),
  status: "waiting",
  version: 1,
});

describe("ready-for-review dashboard action", () => {
  it("rejects a deliberate first action without an exact public observation", () => {
    const snapshot = DeliverySnapshotDto.make({
      authoritativeHeadSha: publication.commitSha,
      eventSequence: 10,
      mode: "pullRequest",
      publication,
      recoveryActions: [],
      runId,
      stage: "waitingForPr",
      status: "waitingForPr",
    });

    expect(() => readyForReviewAction(snapshot)).toThrow(
      "Exact current draft pull-request observation is required"
    );
  });

  it("creates the observed exact tuple for a deliberate first action", () => {
    const snapshot = DeliverySnapshotDto.make({
      authoritativeHeadSha: publication.commitSha,
      eventSequence: 10,
      mode: "pullRequest",
      observation,
      publication,
      recoveryActions: [],
      runId,
      stage: "waitingForPr",
      status: "waitingForPr",
    });

    expect(readyForReviewAction(snapshot)).toMatchObject({
      expectedBranchName: publication.branchName,
      expectedHeadSha: publication.commitSha,
      expectedPrNumber: publication.prNumber,
      expectedPrUrl: publication.prUrl,
      kind: "markReadyForReview",
    });
    expect(readyForReviewAction(snapshot).actionId).toMatch(
      /^ready-[0-9a-f-]{36}$/u
    );
  });

  for (const [name, changedObservation] of [
    ["branch", { ...observation, branchName: "gaia/unrelated" }],
    ["draft state", { ...observation, draft: false }],
    ["head", { ...observation, headSha: "b".repeat(40) }],
    ["pull request number", { ...observation, prNumber: 92 }],
    [
      "pull request URL",
      { ...observation, prUrl: "https://github.com/cill-i-am/gaia/pull/92" },
    ],
    ["repository", { ...observation, repository: "cill-i-am/unrelated" }],
  ] as const) {
    it(`rejects a first action when the latest observation has a different ${name}`, () => {
      const snapshot = DeliverySnapshotDto.make({
        authoritativeHeadSha: publication.commitSha,
        eventSequence: 10,
        mode: "pullRequest",
        observation: DeliveryPullRequestObservation.make(changedObservation),
        publication,
        recoveryActions: [],
        runId,
        stage: "waitingForPr",
        status: "waitingForPr",
      });

      expect(() => readyForReviewAction(snapshot)).toThrow(
        "Exact current draft pull-request observation is required"
      );
    });
  }

  it("reuses the authoritative failed action ID and tuple for reconciliation", () => {
    const failed = DeliveryPullRequestReadyTerminalFailure.make({
      actionId: "ready-authoritative-1",
      branchName: publication.branchName,
      code: "DeliveryReadyRejected",
      expectedHeadSha: "b".repeat(40),
      message: "GitHub conclusively rejected the ready-for-review action.",
      payloadDigest: "c".repeat(64),
      prNumber: publication.prNumber,
      prUrl: publication.prUrl,
      publicationOperationId: "delivery:run-7777777777:1",
      publicationPayloadDigest: "d".repeat(64),
      repository: "cill-i-am/gaia",
      runId,
      state: "dispatchFailed" as const,
      version: 1 as const,
    });
    const snapshot = DeliverySnapshotDto.make({
      authoritativeHeadSha: failed.expectedHeadSha,
      eventSequence: 13,
      latestReadyForReviewAction: failed,
      mode: "pullRequest",
      publication,
      recoveryActions: [],
      runId,
      stage: "waitingForPr",
      status: "waitingForPr",
    });

    expect(readyForReviewAction(snapshot)).toMatchObject({
      actionId: failed.actionId,
      expectedBranchName: failed.branchName,
      expectedHeadSha: failed.expectedHeadSha,
      expectedPrNumber: failed.prNumber,
      expectedPrUrl: failed.prUrl,
    });
  });

  it("reuses the authoritative active action ID and tuple without an observation", () => {
    const active = DeliveryPullRequestReadyDispatchAttempted.make({
      actionId: "ready-authoritative-active",
      branchName: publication.branchName,
      expectedHeadSha: publication.commitSha,
      payloadDigest: "c".repeat(64),
      prNumber: publication.prNumber,
      prUrl: publication.prUrl,
      publicationOperationId: "delivery:run-7777777777:1",
      publicationPayloadDigest: "d".repeat(64),
      repository: "cill-i-am/gaia",
      runId,
      state: "dispatchAttempted",
      version: 1,
    });
    const snapshot = DeliverySnapshotDto.make({
      activeReadyForReviewAction: active,
      authoritativeHeadSha: active.expectedHeadSha,
      eventSequence: 12,
      latestReadyForReviewAction: active,
      mode: "pullRequest",
      publication,
      recoveryActions: [],
      runId,
      stage: "waitingForPr",
      status: "waitingForPr",
    });

    expect(readyForReviewAction(snapshot)).toMatchObject({
      actionId: active.actionId,
      expectedBranchName: active.branchName,
      expectedHeadSha: active.expectedHeadSha,
      expectedPrNumber: active.prNumber,
      expectedPrUrl: active.prUrl,
    });
  });

  it("uses the remediated authoritative head while publication remains immutable", () => {
    const authoritativeHeadSha = "b".repeat(40);
    const snapshot = DeliverySnapshotDto.make({
      authoritativeHeadSha,
      eventSequence: 20,
      mode: "pullRequest",
      observation: DeliveryPullRequestObservation.make({
        ...observation,
        headSha: authoritativeHeadSha,
      }),
      publication,
      recoveryActions: [],
      runId,
      stage: "waitingForPr",
      status: "waitingForPr",
    });

    expect(readyForReviewAction(snapshot)).toMatchObject({
      expectedHeadSha: authoritativeHeadSha,
    });
  });

  it("does not reuse a stale terminal action after the authoritative head advances", () => {
    const stale = DeliveryPullRequestReadyTerminalFailure.make({
      actionId: "ready-stale-1",
      branchName: publication.branchName,
      code: "DeliveryReadyRejected",
      expectedHeadSha: publication.commitSha,
      message: "GitHub conclusively rejected the ready-for-review action.",
      payloadDigest: "c".repeat(64),
      prNumber: publication.prNumber,
      prUrl: publication.prUrl,
      publicationOperationId: "delivery:run-7777777777:1",
      publicationPayloadDigest: "d".repeat(64),
      repository: "cill-i-am/gaia",
      runId,
      state: "dispatchFailed",
      version: 1,
    });
    const snapshot = DeliverySnapshotDto.make({
      authoritativeHeadSha: "b".repeat(40),
      eventSequence: 20,
      latestReadyForReviewAction: stale,
      mode: "pullRequest",
      publication,
      recoveryActions: [],
      runId,
      stage: "waitingForPr",
      status: "waitingForPr",
    });

    expect(() => readyForReviewAction(snapshot)).toThrow(
      "Exact current draft pull-request observation is required"
    );
  });
});
