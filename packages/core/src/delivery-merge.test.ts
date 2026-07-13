import { createHash } from "node:crypto";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DeliveryCleanupCompleted,
  DeliveryCleanupRequired,
  DeliveryMergeDispatchAttempted,
  DeliveryMergeDispatchConfirmed,
  DeliveryMergeIntent,
  DeliveryMergeReadinessDecision,
  DeliveryPullRequestReadyConfirmedWithoutDispatch,
  DeliveryPullRequestReadyDispatchAttempted,
  DeliveryPullRequestReadyIntent,
  DeliveryPullRequestReadyTerminalFailure,
  DeliveryRequiredCheckPolicy,
  deliveryPullRequestReadyCanonicalPayload,
  deliveryMergeMethodArguments,
  deliveryRequiredCheckPolicyCanonicalPayload,
  parseDeliveryCleanupReceipt,
  parseDeliveryMergeReceipt,
  parseDeliveryPullRequestReadyReceipt,
  encodeDeliveryCleanupReceiptJson,
  encodeDeliveryMergeReadinessDecisionJson,
  encodeDeliveryMergeReceiptJson,
  encodeDeliveryPullRequestReadyReceiptJson,
  deriveDeliveryMergeActionHistories,
  deriveDeliveryPullRequestReadyActionHistories,
  deriveDeliveryCleanupActionHistories,
  deliveryActionAuditSummary,
} from "./delivery-merge.js";
import {
  DeliveryPublicationConfirmed,
  encodeDeliveryPublicationJson,
} from "./delivery-publication.js";
import {
  DeliveryRemediationCommitAttempted,
  DeliveryRemediationConfirmed,
  DeliveryRemediationDispatchAttempted,
  DeliveryRemediationFailed,
  DeliveryRemediationIntent,
  DeliveryRemediationPushAttempted,
  DeliveryRemediationTurnCompleted,
  DeliveryRemediationVerified,
  deriveAuthoritativeDeliveryHeadSha,
  encodeDeliveryRemediationJson,
  parseDeliveryFeedbackId,
} from "./delivery-remediation.js";
import { makeRunEvent } from "./events.js";
import { snapshotFromReplay } from "./machine.js";
import { parseRunId } from "./run-id.js";

const check = {
  appSlug: "github-actions",
  name: "test",
  repository: "cill-i-am/gaia",
  workflow: "CI",
};

function readyReplayEvents(
  overrides: Partial<{
    readonly actionId: string;
    readonly branchName: string;
    readonly expectedHeadSha: string;
    readonly payloadDigest: string;
    readonly prNumber: number;
    readonly prUrl: string;
    readonly publicationOperationId: string;
    readonly publicationPayloadDigest: string;
    readonly repository: string;
    readonly runId: ReturnType<typeof parseRunId>;
  }> = {}
) {
  const enclosingRunId = parseRunId("run-1234567890");
  const publication = DeliveryPublicationConfirmed.make({
    baseBranch: "main",
    baseRevision: "0".repeat(40),
    branchName: "gaia/run-1234567890",
    commitMessage: "feat: delivery",
    commitSha: "a".repeat(40),
    commitTimestamp: "2026-07-11T19:00:00.000Z",
    digestVersion: 1,
    draft: true,
    headSha: "a".repeat(40),
    operationId: "publish-run-1234567890-1",
    payloadDigest: "c".repeat(64),
    prNumber: 74,
    prUrl: "https://github.com/cill-i-am/gaia/pull/74",
    sourcePaths: ["feature.ts"],
    state: "confirmed",
    treeSha: "2".repeat(40),
  });
  const bindingBase = {
    actionId: overrides.actionId ?? "ready-1",
    branchName: overrides.branchName ?? publication.branchName,
    expectedHeadSha: overrides.expectedHeadSha ?? publication.headSha,
    prNumber: overrides.prNumber ?? publication.prNumber,
    prUrl: overrides.prUrl ?? publication.prUrl,
    publicationOperationId:
      overrides.publicationOperationId ?? publication.operationId,
    publicationPayloadDigest:
      overrides.publicationPayloadDigest ?? publication.payloadDigest,
    repository: overrides.repository ?? "cill-i-am/gaia",
    runId: overrides.runId ?? enclosingRunId,
    version: 1 as const,
  };
  const binding = {
    ...bindingBase,
    payloadDigest:
      overrides.payloadDigest ??
      createHash("sha256")
        .update(deliveryPullRequestReadyCanonicalPayload(bindingBase))
        .digest("hex"),
  };
  const intent = DeliveryPullRequestReadyIntent.make({
    ...binding,
    state: "intentRecorded",
  });
  const confirmed = DeliveryPullRequestReadyConfirmedWithoutDispatch.make({
    ...binding,
    draft: false,
    state: "confirmedWithoutDispatch",
  });
  const event = (
    sequence: number,
    type: Parameters<typeof makeRunEvent>[0]["type"],
    payload: Readonly<Record<string, Schema.Json>>
  ) =>
    makeRunEvent({
      payload,
      runId: enclosingRunId,
      sequence,
      timestamp: `2026-07-11T19:00:0${sequence}.000Z`,
      type,
    });
  return {
    events: [
      event(1, "RUN_CREATED", { specPath: "spec.md" }),
      event(2, "DELIVERY_STARTED", {
        delivery: {
          baseBranch: "main",
          baseRevision: "0".repeat(40),
          headBranch: publication.branchName,
          mode: "pullRequest",
          publication: encodeDeliveryPublicationJson(publication),
          remote: "origin",
          stage: "waitingForPr",
        },
      }),
      event(3, "DELIVERY_PR_READY_RECORDED", {
        readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(intent),
      }),
      event(4, "DELIVERY_PR_READY_RECORDED", {
        readyForReviewAction:
          encodeDeliveryPullRequestReadyReceiptJson(confirmed),
      }),
    ],
    publication,
  };
}

function confirmedRemediation(expectedHeadSha: string, commitSha: string) {
  const base = {
    attempt: 1 as const,
    commitTimestamp: "2026-07-11T19:00:00.000Z",
    expectedHeadSha,
    feedbackDigest: "e".repeat(64),
    feedbackIds: [
      parseDeliveryFeedbackId(`feedback-comment-${"f".repeat(64)}`),
    ],
    inputId: "remediation-run-1234567890-1",
    operationId: "remediation:run-1234567890:1",
  };
  const intent = DeliveryRemediationIntent.make({
    ...base,
    state: "intentRecorded",
  });
  const attempted = DeliveryRemediationDispatchAttempted.make({
    ...base,
    state: "dispatchAttempted",
  });
  const turnCompleted = DeliveryRemediationTurnCompleted.make({
    ...base,
    state: "turnCompleted",
  });
  const verified = DeliveryRemediationVerified.make({
    ...base,
    state: "verified",
  });
  const commitAttempted = DeliveryRemediationCommitAttempted.make({
    ...base,
    commitSha,
    state: "commitAttempted",
  });
  const pushAttempted = DeliveryRemediationPushAttempted.make({
    ...base,
    commitSha,
    state: "pushAttempted",
  });
  const confirmed = DeliveryRemediationConfirmed.make({
    ...base,
    commitSha,
    state: "confirmed",
  });
  return [
    intent,
    attempted,
    turnCompleted,
    verified,
    commitAttempted,
    pushAttempted,
    confirmed,
  ] as const;
}

describe("delivery merge contracts", () => {
  it("maps every supported method to exactly one provider flag", () => {
    expect(deliveryMergeMethodArguments).toEqual({
      merge: ["--merge"],
      rebase: ["--rebase"],
      squash: ["--squash"],
    });
  });

  it("requires sorted unique bounded required-check identities and stable digesting", () => {
    const decode = Schema.decodeUnknownSync(DeliveryRequiredCheckPolicy);
    const policy = decode({
      checks: [check],
      requireApprovedReview: true,
      version: 1,
    });
    expect(deliveryRequiredCheckPolicyCanonicalPayload(policy)).toContain(
      "cill-i-am/gaia"
    );
    expect(() =>
      decode({
        checks: [check, check],
        requireApprovedReview: true,
        version: 1,
      })
    ).toThrow();
  });

  it("binds method and policy into strict durable receipts", () => {
    const base = {
      actionId: "action-1",
      branchName: "gaia/run-1234567890",
      decisionSequence: 9,
      expectedHeadSha: "a".repeat(40),
      mergeMethod: "merge",
      payloadDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      policyVersion: 1,
      prNumber: 74,
      prUrl: "https://github.com/cill-i-am/gaia/pull/74",
      repository: "cill-i-am/gaia",
      state: "intentRecorded",
    };
    expect(parseDeliveryMergeReceipt(base).state).toBe("intentRecorded");
    expect(() =>
      parseDeliveryMergeReceipt({ ...base, mergeMethod: "fast-forward" })
    ).toThrow();
    expect(() =>
      parseDeliveryMergeReceipt({ ...base, unexpected: true })
    ).toThrow();
  });

  it("binds ready-for-review intent to the confirmed publication generation", () => {
    const binding = {
      actionId: "ready-1",
      branchName: "gaia/run-1234567890",
      expectedHeadSha: "a".repeat(40),
      payloadDigest: "b".repeat(64),
      prNumber: 74,
      prUrl: "https://github.com/cill-i-am/gaia/pull/74",
      publicationOperationId: "publish-run-1234567890-1",
      publicationPayloadDigest: "c".repeat(64),
      repository: "cill-i-am/gaia",
      runId: parseRunId("run-1234567890"),
      version: 1 as const,
    };
    const canonical = deliveryPullRequestReadyCanonicalPayload(binding);
    expect(canonical).toContain("gaia.delivery.mark-ready.v1");
    expect(canonical).toContain(
      `${binding.publicationOperationId.length}:${binding.publicationOperationId}`
    );

    const intent = DeliveryPullRequestReadyIntent.make({
      ...binding,
      state: "intentRecorded",
    });
    const confirmed = DeliveryPullRequestReadyConfirmedWithoutDispatch.make({
      ...binding,
      draft: false,
      state: "confirmedWithoutDispatch",
    });
    const history = deriveDeliveryPullRequestReadyActionHistories([
      { receipt: intent, sequence: 4 },
      { receipt: confirmed, sequence: 5 },
    ]);
    expect(history.latest?.latest.state).toBe("confirmedWithoutDispatch");
    expect(history.active).toBeUndefined();
    expect(() =>
      deriveDeliveryPullRequestReadyActionHistories([
        { receipt: intent, sequence: 4 },
        {
          receipt: DeliveryPullRequestReadyConfirmedWithoutDispatch.make({
            ...confirmed,
            publicationPayloadDigest: "d".repeat(64),
          }),
          sequence: 5,
        },
      ])
    ).toThrow("Ready-for-review action binding changed");
  });

  it("replays ready-for-review receipts without rewriting draft publication history", () => {
    const { events } = readyReplayEvents();
    const snapshot = snapshotFromReplay(events);
    expect(snapshot.context["delivery"]).toMatchObject({
      publication: { draft: true, state: "confirmed" },
      readyForReviewAction: { draft: false, state: "confirmedWithoutDispatch" },
    });
  });

  it("replays a publication-bound ready receipt on the confirmed remediation head", () => {
    const runId = parseRunId("run-1234567890");
    const { publication } = readyReplayEvents();
    const remediatedHead = "b".repeat(40);
    const remediations = confirmedRemediation(
      publication.headSha,
      remediatedHead
    );
    const bindingBase = {
      actionId: "ready-remediated-1",
      branchName: publication.branchName,
      expectedHeadSha: remediatedHead,
      prNumber: publication.prNumber,
      prUrl: publication.prUrl,
      publicationOperationId: publication.operationId,
      publicationPayloadDigest: publication.payloadDigest,
      repository: "cill-i-am/gaia",
      runId,
      version: 1 as const,
    };
    const binding = {
      ...bindingBase,
      payloadDigest: createHash("sha256")
        .update(deliveryPullRequestReadyCanonicalPayload(bindingBase))
        .digest("hex"),
    };
    const event = (
      sequence: number,
      type: Parameters<typeof makeRunEvent>[0]["type"],
      payload: Readonly<Record<string, Schema.Json>>
    ) =>
      makeRunEvent({
        payload,
        runId,
        sequence,
        timestamp: `2026-07-11T19:00:${String(sequence).padStart(2, "0")}.000Z`,
        type,
      });
    const events = [
      event(1, "RUN_CREATED", { specPath: "spec.md" }),
      event(2, "DELIVERY_STARTED", {
        delivery: {
          baseBranch: "main",
          baseRevision: "0".repeat(40),
          headBranch: publication.branchName,
          mode: "pullRequest",
          publication: encodeDeliveryPublicationJson(publication),
          remote: "origin",
          stage: "waitingForPr",
        },
      }),
      ...remediations.map((remediation, index) =>
        event(index + 3, "DELIVERY_REMEDIATION_RECORDED", {
          remediation: encodeDeliveryRemediationJson(remediation),
        })
      ),
      event(10, "DELIVERY_PR_READY_RECORDED", {
        readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(
          DeliveryPullRequestReadyIntent.make({
            ...binding,
            state: "intentRecorded",
          })
        ),
      }),
      event(11, "DELIVERY_PR_READY_RECORDED", {
        readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(
          DeliveryPullRequestReadyConfirmedWithoutDispatch.make({
            ...binding,
            draft: false,
            state: "confirmedWithoutDispatch",
          })
        ),
      }),
    ];

    expect(snapshotFromReplay(events).context["delivery"]).toMatchObject({
      publication: { headSha: publication.headSha },
      readyForReviewAction: {
        expectedHeadSha: remediatedHead,
        state: "confirmedWithoutDispatch",
      },
      remediation: { commitSha: remediatedHead, state: "confirmed" },
    });
  });

  it("keeps a historical ready receipt valid after a later confirmed remediation", () => {
    const { events, publication } = readyReplayEvents();
    const remediatedHead = "b".repeat(40);
    const remediations = confirmedRemediation(
      publication.headSha,
      remediatedHead
    );
    const nextEvents = [
      ...events,
      ...remediations.map((remediation, index) =>
        makeRunEvent({
          payload: { remediation: encodeDeliveryRemediationJson(remediation) },
          runId: events[0]!.runId,
          sequence: events.length + index + 1,
          timestamp: `2026-07-11T19:01:${String(index).padStart(2, "0")}.000Z`,
          type: "DELIVERY_REMEDIATION_RECORDED",
        })
      ),
    ];

    expect(() => snapshotFromReplay(nextEvents)).not.toThrow();
    expect(deriveAuthoritativeDeliveryHeadSha(publication, nextEvents)).toBe(
      remediatedHead
    );
  });

  it("does not advance beyond a confirmed head for a later in-flight or failed remediation", () => {
    const { events, publication } = readyReplayEvents();
    const remediatedHead = "b".repeat(40);
    const first = confirmedRemediation(publication.headSha, remediatedHead);
    const secondBase = {
      attempt: 2 as const,
      commitTimestamp: "2026-07-11T19:02:00.000Z",
      expectedHeadSha: remediatedHead,
      feedbackDigest: "a".repeat(64),
      feedbackIds: [
        parseDeliveryFeedbackId(`feedback-comment-${"b".repeat(64)}`),
      ],
      inputId: "remediation-run-1234567890-2",
      operationId: "remediation:run-1234567890:2",
    };
    const secondIntent = DeliveryRemediationIntent.make({
      ...secondBase,
      state: "intentRecorded",
    });
    const secondAttempted = DeliveryRemediationDispatchAttempted.make({
      ...secondBase,
      state: "dispatchAttempted",
    });
    const secondFailed = DeliveryRemediationFailed.make({
      ...secondBase,
      code: "ProviderRejected",
      message: "The second attempt failed conclusively.",
      recoverable: true,
      state: "failed",
    });
    const event = (sequence: number, remediation: Schema.Json) =>
      makeRunEvent({
        payload: { remediation },
        runId: events[0]!.runId,
        sequence,
        timestamp: `2026-07-11T19:02:${String(sequence).padStart(2, "0")}.000Z`,
        type: "DELIVERY_REMEDIATION_RECORDED",
      });
    const base = [
      ...events.slice(0, 2),
      ...first.map((remediation, index) =>
        event(index + 3, encodeDeliveryRemediationJson(remediation))
      ),
    ];
    const inFlight = [
      ...base,
      event(10, encodeDeliveryRemediationJson(secondIntent)),
      event(11, encodeDeliveryRemediationJson(secondAttempted)),
    ];
    const failed = [
      ...inFlight,
      event(12, encodeDeliveryRemediationJson(secondFailed)),
    ];

    expect(snapshotFromReplay(inFlight).context["delivery"]).toMatchObject({
      remediation: { attempt: 2, state: "dispatchAttempted" },
    });
    expect(deriveAuthoritativeDeliveryHeadSha(publication, inFlight)).toBe(
      remediatedHead
    );
    expect(deriveAuthoritativeDeliveryHeadSha(publication, failed)).toBe(
      remediatedHead
    );
  });

  it("rejects a stale publication-head ready receipt recorded after confirmed remediation", () => {
    const runId = parseRunId("run-1234567890");
    const { publication } = readyReplayEvents();
    const remediations = confirmedRemediation(
      publication.headSha,
      "b".repeat(40)
    );
    const stale = readyReplayEvents().events.slice(2);
    const event = (
      sequence: number,
      type: Parameters<typeof makeRunEvent>[0]["type"],
      payload: Readonly<Record<string, Schema.Json>>
    ) =>
      makeRunEvent({
        payload,
        runId,
        sequence,
        timestamp: `2026-07-11T19:03:${String(sequence).padStart(2, "0")}.000Z`,
        type,
      });
    const events = [
      event(1, "RUN_CREATED", { specPath: "spec.md" }),
      event(2, "DELIVERY_STARTED", {
        delivery: {
          baseBranch: "main",
          baseRevision: "0".repeat(40),
          headBranch: publication.branchName,
          mode: "pullRequest",
          publication: encodeDeliveryPublicationJson(publication),
          remote: "origin",
          stage: "waitingForPr",
        },
      }),
      ...remediations.map((remediation, index) =>
        event(index + 3, "DELIVERY_REMEDIATION_RECORDED", {
          remediation: encodeDeliveryRemediationJson(remediation),
        })
      ),
      ...stale.map((ready, index) =>
        event(index + 10, ready.type, ready.payload)
      ),
    ];

    expect(() => snapshotFromReplay(events)).toThrow(
      "Ready-for-review action does not match the confirmed publication"
    );
  });

  it.each(["intentRecorded", "dispatchAttempted", "outcomeUnknown"] as const)(
    "rejects confirmed remediation after unresolved ready state %s",
    (readyState) => {
      const { events, publication } = readyReplayEvents();
      const intent = parseDeliveryPullRequestReadyReceipt(
        events[2]!.payload["readyForReviewAction"]
      );
      const attempted = DeliveryPullRequestReadyDispatchAttempted.make({
        ...intent,
        state: "dispatchAttempted",
      });
      const readyEvents =
        readyState === "intentRecorded"
          ? events.slice(0, 3)
          : readyState === "dispatchAttempted"
            ? [
                ...events.slice(0, 3),
                makeRunEvent({
                  payload: {
                    readyForReviewAction:
                      encodeDeliveryPullRequestReadyReceiptJson(attempted),
                  },
                  runId: events[0]!.runId,
                  sequence: 4,
                  timestamp: "2026-07-11T19:04:04.000Z",
                  type: "DELIVERY_PR_READY_RECORDED",
                }),
              ]
            : [
                ...events.slice(0, 3),
                makeRunEvent({
                  payload: {
                    readyForReviewAction:
                      encodeDeliveryPullRequestReadyReceiptJson(attempted),
                  },
                  runId: events[0]!.runId,
                  sequence: 4,
                  timestamp: "2026-07-11T19:04:04.000Z",
                  type: "DELIVERY_PR_READY_RECORDED",
                }),
                makeRunEvent({
                  payload: {
                    readyForReviewAction:
                      encodeDeliveryPullRequestReadyReceiptJson(
                        DeliveryPullRequestReadyTerminalFailure.make({
                          ...attempted,
                          code: "DeliveryReadyOutcomeUnknown",
                          message: "Outcome is unknown.",
                          state: "outcomeUnknown",
                        })
                      ),
                  },
                  runId: events[0]!.runId,
                  sequence: 5,
                  timestamp: "2026-07-11T19:04:05.000Z",
                  type: "DELIVERY_PR_READY_RECORDED",
                }),
              ];
      const remediations = confirmedRemediation(
        publication.headSha,
        "b".repeat(40)
      );
      const next = [
        ...readyEvents,
        ...remediations.map((remediation, index) =>
          makeRunEvent({
            payload: {
              remediation: encodeDeliveryRemediationJson(remediation),
            },
            runId: events[0]!.runId,
            sequence: readyEvents.length + index + 1,
            timestamp: `2026-07-11T19:05:${String(index).padStart(2, "0")}.000Z`,
            type: "DELIVERY_REMEDIATION_RECORDED",
          })
        ),
      ];

      expect(() => snapshotFromReplay(next)).toThrow(
        "Confirmed remediation cannot supersede an unresolved ready-for-review action"
      );
    }
  );

  it("rejects a canonically hashed ready receipt from a different enclosing run", () => {
    const { events } = readyReplayEvents({
      runId: parseRunId("run-wrong12345"),
    });
    expect(() => snapshotFromReplay(events)).toThrow(
      "Ready-for-review action does not match its enclosing run"
    );
  });

  it.each([
    [
      "publication operation",
      { publicationOperationId: "publish-run-1234567890-2" },
    ],
    ["publication digest", { publicationPayloadDigest: "d".repeat(64) }],
    ["repository", { repository: "cill-i-am/other" }],
    ["PR number", { prNumber: 75 }],
    ["PR URL", { prUrl: "https://github.com/cill-i-am/gaia/pull/75" }],
    ["branch", { branchName: "gaia/run-other1234" }],
    ["head", { expectedHeadSha: "d".repeat(40) }],
  ] as const)(
    "rejects ready replay with a mismatched %s",
    (_name, overrides) => {
      const { events } = readyReplayEvents(overrides);
      expect(() => snapshotFromReplay(events)).toThrow(
        "Ready-for-review action does not match the confirmed publication"
      );
    }
  );

  it("rejects ready replay when the canonical digest does not recompute", () => {
    const { events } = readyReplayEvents({ payloadDigest: "f".repeat(64) });
    expect(() => snapshotFromReplay(events)).toThrow(
      "Ready-for-review action digest is invalid"
    );
  });

  it("only completes cleanup when both exact resources are absent", () => {
    const base = {
      actionId: "cleanup-1",
      branchName: "gaia/run-1234567890",
      mergeCommitSha: "a".repeat(40),
      ownershipDigest: "b".repeat(64),
    };
    expect(
      parseDeliveryCleanupReceipt({
        ...base,
        branch: "absent",
        state: "completed",
        worktree: "absent",
      }).state
    ).toBe("completed");
    expect(
      parseDeliveryCleanupReceipt({
        ...base,
        branch: "present",
        state: "cleanupRequired",
        worktree: "absent",
      }).state
    ).toBe("cleanupRequired");
    expect(() =>
      parseDeliveryCleanupReceipt({
        ...base,
        branch: "present",
        state: "completed",
        worktree: "absent",
      })
    ).toThrow();
  });

  it("keeps pull-request delivery non-terminal until exact merge and both-resource cleanup", () => {
    const runId = parseRunId("run-1234567890");
    const binding = {
      actionId: "merge-1",
      branchName: "gaia/run-1234567890",
      decisionSequence: 3,
      expectedHeadSha: "a".repeat(40),
      mergeMethod: "merge" as const,
      payloadDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      policyVersion: 1 as const,
      prNumber: 74,
      prUrl: "https://github.com/cill-i-am/gaia/pull/74",
      repository: "cill-i-am/gaia",
    };
    const decision = DeliveryMergeReadinessDecision.make({
      actionId: "readiness-1",
      approved: true,
      blockers: [],
      branchName: binding.branchName,
      headSha: binding.expectedHeadSha,
      mergeMethod: "merge",
      payloadDigest: "f".repeat(64),
      policyDigest: binding.policyDigest,
      policyVersion: 1,
      prNumber: 74,
      prUrl: binding.prUrl,
    });
    const intent = DeliveryMergeIntent.make({
      ...binding,
      state: "intentRecorded",
    });
    const attempted = DeliveryMergeDispatchAttempted.make({
      ...binding,
      state: "dispatchAttempted",
    });
    const confirmed = DeliveryMergeDispatchConfirmed.make({
      ...binding,
      mergeCommitSha: "d".repeat(40),
      mergedAt: "2026-07-11T19:00:00.000Z",
      state: "dispatchConfirmed",
    });
    const event = (
      sequence: number,
      type: Parameters<typeof makeRunEvent>[0]["type"],
      payload: Readonly<Record<string, Schema.Json>>
    ) =>
      makeRunEvent({
        payload,
        runId,
        sequence,
        timestamp: `2026-07-11T19:00:0${sequence}.000Z`,
        type,
      });
    const base = [
      event(1, "RUN_CREATED", { specPath: "spec.md" }),
      event(2, "DELIVERY_STARTED", {
        delivery: {
          baseBranch: "main",
          baseRevision: "0".repeat(40),
          headBranch: binding.branchName,
          mode: "pullRequest",
          remote: "origin",
          stage: "waitingForPr",
        },
      }),
      event(3, "DELIVERY_MERGE_READINESS_RECORDED", {
        decision: encodeDeliveryMergeReadinessDecisionJson(decision),
      }),
      event(4, "DELIVERY_MERGE_RECORDED", {
        mergeAction: encodeDeliveryMergeReceiptJson(intent),
      }),
      event(5, "DELIVERY_MERGE_RECORDED", {
        mergeAction: encodeDeliveryMergeReceiptJson(attempted),
      }),
      event(6, "DELIVERY_MERGE_RECORDED", {
        mergeAction: encodeDeliveryMergeReceiptJson(confirmed),
      }),
    ];
    expect(snapshotFromReplay(base).state).toBe("delivering");
    const partial = DeliveryCleanupRequired.make({
      actionId: "cleanup-1",
      branch: "present",
      branchName: binding.branchName,
      mergeCommitSha: confirmed.mergeCommitSha,
      ownershipDigest: "e".repeat(64),
      state: "cleanupRequired",
      worktree: "absent",
    });
    const partialEvents = [
      ...base,
      event(7, "DELIVERY_CLEANUP_RECORDED", {
        cleanup: encodeDeliveryCleanupReceiptJson(partial),
      }),
    ];
    expect(snapshotFromReplay(partialEvents).state).toBe("delivering");
    const complete = DeliveryCleanupCompleted.make({
      actionId: "cleanup-1",
      branch: "absent",
      branchName: binding.branchName,
      mergeCommitSha: confirmed.mergeCommitSha,
      ownershipDigest: "e".repeat(64),
      state: "completed",
      worktree: "absent",
    });
    expect(
      snapshotFromReplay([
        ...partialEvents,
        event(8, "DELIVERY_CLEANUP_RECORDED", {
          cleanup: encodeDeliveryCleanupReceiptJson(complete),
        }),
      ]).state
    ).toBe("completed");
  });

  it("derives immutable interleaved action histories with deterministic active and bounded audit", () => {
    const binding = {
      actionId: "merge-1",
      branchName: "gaia/run-1234567890",
      decisionSequence: 3,
      expectedHeadSha: "a".repeat(40),
      mergeMethod: "merge" as const,
      payloadDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      policyVersion: 1 as const,
      prNumber: 74,
      prUrl: "https://github.com/cill-i-am/gaia/pull/74",
      repository: "cill-i-am/gaia",
    };
    const intent = DeliveryMergeIntent.make({
      ...binding,
      state: "intentRecorded",
    });
    const attempted = DeliveryMergeDispatchAttempted.make({
      ...binding,
      state: "dispatchAttempted",
    });
    const failed = parseDeliveryMergeReceipt({
      ...binding,
      code: "rejected",
      message: "rejected",
      state: "dispatchFailed",
    });
    const next = DeliveryMergeIntent.make({
      ...binding,
      actionId: "merge-2",
      decisionSequence: 9,
      payloadDigest: "d".repeat(64),
      state: "intentRecorded",
    });
    const merge = deriveDeliveryMergeActionHistories([
      { receipt: intent, sequence: 4 },
      { receipt: attempted, sequence: 5 },
      { receipt: failed, sequence: 6 },
      { receipt: next, sequence: 10 },
    ]);
    expect(merge.histories).toHaveLength(2);
    expect(merge.latest?.actionId).toBe("merge-2");
    expect(merge.active?.actionId).toBe("merge-2");
    expect(merge.histories[0]?.receipts).toHaveLength(3);
    expect(() =>
      deriveDeliveryMergeActionHistories([
        { receipt: intent, sequence: 4 },
        {
          receipt: DeliveryMergeDispatchAttempted.make({
            ...binding,
            payloadDigest: "e".repeat(64),
            state: "dispatchAttempted",
          }),
          sequence: 5,
        },
      ])
    ).toThrow();
    const cleanup = deriveDeliveryCleanupActionHistories([]);
    expect(deliveryActionAuditSummary({ cleanup, merge }, 1).merge).toEqual([
      { actionId: "merge-2", latestSequence: 10, state: "intentRecorded" },
    ]);
  });
});
