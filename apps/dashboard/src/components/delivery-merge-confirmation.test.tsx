import {
  DeliveryMergeDispatchConfirmed,
  DeliverySnapshotDto,
  parseRunId,
} from "@gaia/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deliveryRecoveryAction } from "./dashboard-shell";
import { DeliveryMergeConfirmation } from "./delivery-merge-confirmation";

describe("DeliveryMergeConfirmation", () => {
  afterEach(cleanup);
  it("shows the exact destructive tuple before dispatch", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <DeliveryMergeConfirmation
        actionId="merge-action-1"
        branch="gaia/run-1234567890"
        decisionSequence={42}
        disabled={false}
        headSha={"a".repeat(40)}
        method="squash"
        onConfirm={onConfirm}
        pending={false}
        prUrl="https://github.com/cill-i-am/gaia/pull/74"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
    expect(await screen.findByText("Confirm exact-head merge")).toBeTruthy();
    expect(screen.getByText("gaia/run-1234567890")).toBeTruthy();
    expect(screen.getByText("a".repeat(40))).toBeTruthy();
    expect(screen.getByText("Sequence 42")).toBeTruthy();
    expect(screen.getByText("merge-action-1")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm squash merge" })
    );
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("cannot open when readiness is server-disabled", () => {
    render(
      <DeliveryMergeConfirmation
        actionId="merge-action-1"
        branch="gaia/run-1234567890"
        decisionSequence={42}
        disabled
        headSha={"a".repeat(40)}
        method="merge"
        onConfirm={async () => undefined}
        pending={false}
        prUrl="https://github.com/cill-i-am/gaia/pull/74"
      />
    );
    expect(
      screen
        .getByRole("button", { name: "Merge pull request" })
        .hasAttribute("disabled")
    ).toBe(true);
  });

  it("constructs the first cleanup action from the confirmed merge projection", () => {
    const merge = DeliveryMergeDispatchConfirmed.make({
      actionId: "merge-1",
      branchName: "gaia/run-1234567890",
      decisionSequence: 9,
      expectedHeadSha: "a".repeat(40),
      mergeCommitSha: "b".repeat(40),
      mergeMethod: "merge",
      mergedAt: "2026-07-11T20:00:00.000Z",
      payloadDigest: "c".repeat(64),
      policyDigest: "d".repeat(64),
      policyVersion: 1,
      prNumber: 93,
      prUrl: "https://github.com/cill-i-am/gaia/pull/93",
      repository: "cill-i-am/gaia",
      state: "dispatchConfirmed",
    });
    const snapshot = DeliverySnapshotDto.make({
      actionAudit: { cleanup: [], merge: [], readyForReview: [] },
      eventSequence: 10,
      latestMergeAction: merge,
      mode: "pullRequest",
      recoveryActions: ["retryCleanup"],
      runId: parseRunId("run-1234567890"),
      stage: "cleanupRequired",
      status: "cleanupRequired",
    });
    expect(deliveryRecoveryAction(snapshot, "retryCleanup")).toEqual({
      actionId: "cleanup-merge-1",
      expectedMergeCommitSha: "b".repeat(40),
      kind: "retryCleanup",
    });
  });

  it("keeps a rejected confirmation open and suppresses duplicate submits", async () => {
    let reject!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((_resolve, rejectPromise) => {
          reject = () => rejectPromise(new Error("conflict"));
        })
    );
    render(
      <DeliveryMergeConfirmation
        actionId="merge-action-1"
        branch="gaia/run-1234567890"
        decisionSequence={42}
        disabled={false}
        error="Readiness changed; evaluate again."
        headSha={"a".repeat(40)}
        method="merge"
        onConfirm={onConfirm}
        pending={false}
        prUrl="https://github.com/cill-i-am/gaia/pull/74"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
    const confirm = await screen.findByRole("button", {
      name: "Confirm merge merge",
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    reject();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Readiness changed; evaluate again."
    );
    expect(screen.getByTestId("delivery-merge-confirmation")).toBeTruthy();
  });
});
// @vitest-environment jsdom
