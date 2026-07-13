import { DeliveryPublicationConfirmedDto, DeliveryPullRequestReadyTerminalFailure, DeliverySnapshotDto, parseRunId } from "@gaia/core";
import { describe, expect, it, vi } from "vitest";
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

describe("ready-for-review dashboard action", () => {
  it("creates one exact visible tuple for a deliberate first action", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
    const snapshot = DeliverySnapshotDto.make({
      eventSequence: 10,
      mode: "pullRequest",
      publication,
      recoveryActions: [],
      runId,
      stage: "waitingForPr",
      status: "waitingForPr",
    });

    expect(readyForReviewAction(snapshot)).toEqual({
      actionId: "ready-11111111-1111-4111-8111-111111111111",
      expectedBranchName: publication.branchName,
      expectedHeadSha: publication.commitSha,
      expectedPrNumber: publication.prNumber,
      expectedPrUrl: publication.prUrl,
      kind: "markReadyForReview",
    });
  });

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
});
