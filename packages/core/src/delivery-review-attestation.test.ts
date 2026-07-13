import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DeliveryLocalReviewAttestationIntent,
  DeliveryLocalReviewAttestationConfirmed,
  DeliveryLocalReviewAttestationFailed,
  DeliveryLocalOperatorReviewSource,
  DeliveryMergeReadinessDecisionV2,
  DeliveryPullRequestReadyConfirmedWithoutDispatch,
  DeliveryPullRequestReadyIntent,
  deliveryLocalReviewAttestationCanonicalPayload,
  deliveryLocalReviewAttestationPayloadDigest,
  deliveryMergeReadinessDecisionV2PayloadDigest,
  deliveryPullRequestReadyPayloadDigest,
  currentDeliveryLocalReviewAttestation,
  deriveDeliveryLocalReviewAttestationHistories,
  encodeDeliveryLocalReviewAttestationReceiptJson,
  encodeDeliveryMergeReadinessDecisionJson,
  encodeDeliveryPullRequestReadyReceiptJson,
  parseDeliveryLocalReviewAttestationReceipt,
  parseDeliveryMergeReadinessDecision,
} from "./delivery-merge.js";
import {
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationIntent,
  encodeDeliveryPublicationJson,
} from "./delivery-publication.js";
import {
  DeliveryRemediationConfirmed,
  DeliveryRemediationCommitAttempted,
  DeliveryRemediationDispatchAttempted,
  DeliveryRemediationFailed,
  DeliveryRemediationIntent,
  DeliveryRemediationPushAttempted,
  DeliveryRemediationTurnCompleted,
  DeliveryRemediationVerified,
  deriveDeliveryAuthority,
  encodeDeliveryRemediationJson,
  parseDeliveryFeedbackId,
} from "./delivery-remediation.js";
import { makeRunEvent } from "./events.js";
import { snapshotFromReplay } from "./machine.js";
import { parseRunId } from "./run-id.js";

const binding = {
  actionId: "attest-1",
  authority: "localOperator" as const,
  authoritySequence: 12,
  branchName: "gaia/run-1234567890",
  decision: "approved" as const,
  gaiaEvidenceDigest: "e".repeat(64),
  gaiaEvidenceId: "evidence-0123456789abcdef",
  headSha: "a".repeat(40),
  prNumber: 74,
  prUrl: "https://github.com/cill-i-am/gaia/pull/74",
  publicationConfirmationSequence: 5,
  publicationOperationId: "publish-run-1234567890-1",
  publicationPayloadDigest: "b".repeat(64),
  readyConfirmationActionId: "ready-1",
  readyConfirmationPayloadDigest: "c".repeat(64),
  readyConfirmationSequence: 14,
  repository: "cill-i-am/gaia",
  runId: parseRunId("run-1234567890"),
  version: 1 as const,
};

describe("local operator paired-review attestation contracts", () => {
  it("strictly binds a Gaia-owned evidence identity into a domain-separated payload digest", () => {
    const canonical = deliveryLocalReviewAttestationCanonicalPayload(binding);
    const receipt = DeliveryLocalReviewAttestationIntent.make({
      ...binding,
      attestationPayloadDigest:
        deliveryLocalReviewAttestationPayloadDigest(binding),
      state: "intentRecorded",
    });

    expect(canonical).toContain(
      "gaia.delivery.local-paired-review-attestation.v1"
    );
    expect(parseDeliveryLocalReviewAttestationReceipt(receipt)).toEqual(
      receipt
    );
    expect(receipt.attestationPayloadDigest).toHaveLength(64);
    expect(() =>
      parseDeliveryLocalReviewAttestationReceipt({
        ...receipt,
        gaiaEvidenceId: "linear:comment:provider-id",
      })
    ).toThrow();
    expect(() =>
      parseDeliveryLocalReviewAttestationReceipt({
        ...receipt,
        gaiaEvidenceDigest: "not-a-digest",
      })
    ).toThrow();
    expect(() =>
      parseDeliveryLocalReviewAttestationReceipt({
        ...receipt,
        reviewText: "approved",
      })
    ).toThrow();
  });

  it("records a strict exact-authority approval source in V2 readiness decisions", () => {
    const source = DeliveryLocalOperatorReviewSource.make({
      attestationActionId: binding.actionId,
      attestationConfirmationSequence: 16,
      attestationPayloadDigest: "d".repeat(64),
      authoritySequence: binding.authoritySequence,
      gaiaEvidenceDigest: binding.gaiaEvidenceDigest,
      gaiaEvidenceId: binding.gaiaEvidenceId,
      headSha: binding.headSha,
      kind: "localOperatorPairedReview" as const,
      version: 1 as const,
    });
    const decisionBinding = {
      actionId: "readiness-2",
      approved: true,
      approvalSource: source,
      authoritySequence: binding.authoritySequence,
      blockers: [],
      branchName: binding.branchName,
      headSha: binding.headSha,
      mergeMethod: "merge" as const,
      policyDigest: "a".repeat(64),
      policyVersion: 1 as const,
      prNumber: binding.prNumber,
      prUrl: binding.prUrl,
      publicationConfirmationSequence: binding.publicationConfirmationSequence,
      publicationOperationId: binding.publicationOperationId,
      publicationPayloadDigest: binding.publicationPayloadDigest,
      repository: binding.repository,
      runId: binding.runId,
      version: 2 as const,
    };
    const decision = DeliveryMergeReadinessDecisionV2.make({
      ...decisionBinding,
      payloadDigest:
        deliveryMergeReadinessDecisionV2PayloadDigest(decisionBinding),
    });

    expect(parseDeliveryMergeReadinessDecision(decision)).toEqual(decision);
    expect(decision.payloadDigest).toHaveLength(64);
    expect(() =>
      parseDeliveryMergeReadinessDecision({
        ...decision,
        approvalSource: { ...source, reviewerIdentity: "cill-i-am" },
      })
    ).toThrow();
    expect(() =>
      parseDeliveryMergeReadinessDecision({
        ...decision,
        runId: "run-wrong00000",
      })
    ).not.toThrow();
    expect(() =>
      parseDeliveryMergeReadinessDecision({
        ...decision,
        externalEvidenceUrl: "https://linear.app/example",
      })
    ).toThrow();
  });

  it("advances authority only for publication confirmation and confirmed remediation", () => {
    const runId = parseRunId("run-1234567890");
    const publicationBase = {
      baseBranch: "main",
      baseRevision: "0".repeat(40),
      branchName: binding.branchName,
      commitMessage: "feat: delivery",
      commitTimestamp: "2026-07-11T19:00:00.000Z",
      digestVersion: 1 as const,
      operationId: binding.publicationOperationId,
      payloadDigest: binding.publicationPayloadDigest,
      sourcePaths: ["feature.ts"],
      treeSha: "2".repeat(40),
    };
    const publication = DeliveryPublicationConfirmed.make({
      ...publicationBase,
      commitSha: "a".repeat(40),
      draft: true,
      headSha: "a".repeat(40),
      prNumber: binding.prNumber,
      prUrl: binding.prUrl,
      state: "confirmed",
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
        timestamp: `2026-07-11T19:00:${String(sequence).padStart(2, "0")}.000Z`,
        type,
      });
    const publicationEvents = [
      event(1, "DELIVERY_PUBLICATION_INTENT_RECORDED", {
        publication: encodeDeliveryPublicationJson(
          DeliveryPublicationIntent.make({
            ...publicationBase,
            state: "intentRecorded",
          })
        ),
      }),
      event(2, "DELIVERY_PUBLICATION_ATTEMPTED", {
        publication: encodeDeliveryPublicationJson(
          DeliveryPublicationAttempted.make({
            ...publicationBase,
            commitSha: publication.commitSha,
            state: "attempted",
          })
        ),
      }),
      event(3, "DELIVERY_PUBLICATION_CONFIRMED", {
        publication: encodeDeliveryPublicationJson(publication),
      }),
    ];
    const remediationBase = {
      attempt: 1 as const,
      commitTimestamp: "2026-07-11T19:01:00.000Z",
      expectedHeadSha: publication.headSha,
      feedbackDigest: "d".repeat(64),
      feedbackIds: [
        parseDeliveryFeedbackId(`feedback-comment-${"f".repeat(64)}`),
      ],
      inputId: "remediation-run-1234567890-1",
      operationId: "remediation:run-1234567890:1",
    };
    const intent = DeliveryRemediationIntent.make({
      ...remediationBase,
      state: "intentRecorded",
    });
    const attempted = DeliveryRemediationDispatchAttempted.make({
      ...remediationBase,
      state: "dispatchAttempted",
    });
    const failed = DeliveryRemediationFailed.make({
      ...remediationBase,
      code: "Rejected",
      message: "failed",
      recoverable: true,
      state: "failed",
    });
    const failedEvents = [
      ...publicationEvents,
      event(4, "DELIVERY_REMEDIATION_RECORDED", {
        remediation: encodeDeliveryRemediationJson(intent),
      }),
      event(5, "DELIVERY_REMEDIATION_RECORDED", {
        remediation: encodeDeliveryRemediationJson(attempted),
      }),
      event(6, "DELIVERY_REMEDIATION_RECORDED", {
        remediation: encodeDeliveryRemediationJson(failed),
      }),
    ];
    expect(deriveDeliveryAuthority(publication, failedEvents)).toEqual({
      authoritySequence: 3,
      headSha: publication.headSha,
      publicationConfirmationSequence: 3,
    });

    const confirmed = DeliveryRemediationConfirmed.make({
      ...remediationBase,
      commitSha: "b".repeat(40),
      state: "confirmed",
    });
    const confirmedEvents = [
      ...publicationEvents,
      event(4, "DELIVERY_REMEDIATION_RECORDED", {
        remediation: encodeDeliveryRemediationJson(intent),
      }),
      event(5, "DELIVERY_REMEDIATION_RECORDED", {
        remediation: encodeDeliveryRemediationJson(attempted),
      }),
      event(6, "DELIVERY_REMEDIATION_RECORDED", {
        remediation: encodeDeliveryRemediationJson(confirmed),
      }),
    ];
    expect(deriveDeliveryAuthority(publication, confirmedEvents)).toEqual({
      authoritySequence: 6,
      headSha: confirmed.commitSha,
      publicationConfirmationSequence: 3,
    });
  });

  it("keeps one monotone idempotent attestation history per immutable action tuple", () => {
    const attestationPayloadDigest =
      deliveryLocalReviewAttestationPayloadDigest(binding);
    const intent = DeliveryLocalReviewAttestationIntent.make({
      ...binding,
      attestationPayloadDigest,
      state: "intentRecorded",
    });
    const confirmed = DeliveryLocalReviewAttestationConfirmed.make({
      ...binding,
      attestationPayloadDigest,
      state: "confirmed",
    });
    const history = deriveDeliveryLocalReviewAttestationHistories([
      { receipt: intent, sequence: 15 },
      { receipt: confirmed, sequence: 16 },
    ]);

    expect(history.active).toBeUndefined();
    expect(history.latest).toMatchObject({
      actionId: binding.actionId,
      latest: { state: "confirmed" },
    });
    expect(() =>
      deriveDeliveryLocalReviewAttestationHistories([
        { receipt: intent, sequence: 15 },
        {
          receipt: DeliveryLocalReviewAttestationConfirmed.make({
            ...confirmed,
            headSha: "f".repeat(40),
          }),
          sequence: 16,
        },
      ])
    ).toThrow("Local review attestation binding changed");
    expect(() =>
      deriveDeliveryLocalReviewAttestationHistories([
        { receipt: intent, sequence: 15 },
        {
          receipt: DeliveryLocalReviewAttestationIntent.make({
            ...intent,
            actionId: "attest-2",
          }),
          sequence: 16,
        },
      ])
    ).toThrow("An unresolved local review attestation cannot be superseded");
    expect(() =>
      deriveDeliveryLocalReviewAttestationHistories([
        { receipt: confirmed, sequence: 16 },
      ])
    ).toThrow("Local review attestation must begin with intent");

    const failed = DeliveryLocalReviewAttestationFailed.make({
      ...binding,
      attestationPayloadDigest,
      code: "PullRequestClosed",
      message: "The pull request is closed.",
      state: "failed",
    });
    expect(
      deriveDeliveryLocalReviewAttestationHistories([
        { receipt: intent, sequence: 15 },
        { receipt: failed, sequence: 16 },
      ]).latest?.latest.state
    ).toBe("failed");
  });

  it("replays a local attestation only when publication, authority, and post-authority ready confirmation are exact", () => {
    const runId = parseRunId("run-1234567890");
    const publicationBase = {
      baseBranch: "main",
      baseRevision: "0".repeat(40),
      branchName: binding.branchName,
      commitMessage: "feat: delivery",
      commitTimestamp: "2026-07-11T19:00:00.000Z",
      digestVersion: 1 as const,
      operationId: binding.publicationOperationId,
      payloadDigest: binding.publicationPayloadDigest,
      sourcePaths: ["feature.ts"],
      treeSha: "2".repeat(40),
    };
    const publication = DeliveryPublicationConfirmed.make({
      ...publicationBase,
      commitSha: binding.headSha,
      draft: true,
      headSha: binding.headSha,
      prNumber: binding.prNumber,
      prUrl: binding.prUrl,
      state: "confirmed",
    });
    const readyBase = {
      actionId: binding.readyConfirmationActionId,
      branchName: binding.branchName,
      expectedHeadSha: binding.headSha,
      prNumber: binding.prNumber,
      prUrl: binding.prUrl,
      publicationOperationId: binding.publicationOperationId,
      publicationPayloadDigest: binding.publicationPayloadDigest,
      repository: binding.repository,
      runId,
      version: 1 as const,
    };
    const ready = {
      ...readyBase,
      payloadDigest: deliveryPullRequestReadyPayloadDigest(readyBase),
    };
    const attestationBase = {
      ...binding,
      authoritySequence: 5,
      publicationConfirmationSequence: 5,
      readyConfirmationPayloadDigest: ready.payloadDigest,
      readyConfirmationSequence: 7,
    };
    const attestation = {
      ...attestationBase,
      attestationPayloadDigest:
        deliveryLocalReviewAttestationPayloadDigest(attestationBase),
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
          headBranch: binding.branchName,
          mode: "pullRequest",
          remote: "origin",
          stage: "readyToPublish",
        },
      }),
      event(3, "DELIVERY_PUBLICATION_INTENT_RECORDED", {
        publication: encodeDeliveryPublicationJson(
          DeliveryPublicationIntent.make({
            ...publicationBase,
            state: "intentRecorded",
          })
        ),
      }),
      event(4, "DELIVERY_PUBLICATION_ATTEMPTED", {
        publication: encodeDeliveryPublicationJson(
          DeliveryPublicationAttempted.make({
            ...publicationBase,
            commitSha: binding.headSha,
            state: "attempted",
          })
        ),
      }),
      event(5, "DELIVERY_PUBLICATION_CONFIRMED", {
        publication: encodeDeliveryPublicationJson(publication),
      }),
      event(6, "DELIVERY_PR_READY_RECORDED", {
        readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(
          DeliveryPullRequestReadyIntent.make({
            ...ready,
            state: "intentRecorded",
          })
        ),
      }),
      event(7, "DELIVERY_PR_READY_RECORDED", {
        readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(
          DeliveryPullRequestReadyConfirmedWithoutDispatch.make({
            ...ready,
            draft: false,
            state: "confirmedWithoutDispatch",
          })
        ),
      }),
      event(8, "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED", {
        attestation: encodeDeliveryLocalReviewAttestationReceiptJson(
          DeliveryLocalReviewAttestationIntent.make({
            ...attestation,
            state: "intentRecorded",
          })
        ),
      }),
      event(9, "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED", {
        attestation: encodeDeliveryLocalReviewAttestationReceiptJson(
          DeliveryLocalReviewAttestationConfirmed.make({
            ...attestation,
            state: "confirmed",
          })
        ),
      }),
    ];

    expect(() => snapshotFromReplay(events)).not.toThrow();
    const readyBBase = {
      ...readyBase,
      actionId: "ready-2",
    };
    const readyB = {
      ...readyBBase,
      payloadDigest: deliveryPullRequestReadyPayloadDigest(readyBBase),
    };
    const duplicateBase = {
      ...attestationBase,
      actionId: "attest-duplicate",
      gaiaEvidenceId: "evidence-fedcba9876543210",
      readyConfirmationActionId: readyB.actionId,
      readyConfirmationPayloadDigest: readyB.payloadDigest,
      readyConfirmationSequence: 11,
    };
    const duplicate = {
      ...duplicateBase,
      attestationPayloadDigest:
        deliveryLocalReviewAttestationPayloadDigest(duplicateBase),
    };
    const duplicateEvents = [
      ...events,
      event(10, "DELIVERY_PR_READY_RECORDED", {
        readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(
          DeliveryPullRequestReadyIntent.make({
            ...readyB,
            state: "intentRecorded",
          })
        ),
      }),
      event(11, "DELIVERY_PR_READY_RECORDED", {
        readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(
          DeliveryPullRequestReadyConfirmedWithoutDispatch.make({
            ...readyB,
            draft: false,
            state: "confirmedWithoutDispatch",
          })
        ),
      }),
      event(12, "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED", {
        attestation: encodeDeliveryLocalReviewAttestationReceiptJson(
          DeliveryLocalReviewAttestationIntent.make({
            ...duplicate,
            state: "intentRecorded",
          })
        ),
      }),
      event(13, "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED", {
        attestation: encodeDeliveryLocalReviewAttestationReceiptJson(
          DeliveryLocalReviewAttestationConfirmed.make({
            ...duplicate,
            state: "confirmed",
          })
        ),
      }),
    ];
    expect(() =>
      deriveDeliveryLocalReviewAttestationHistories(
        duplicateEvents.flatMap((candidate) =>
          candidate.type === "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED"
            ? [
                {
                  receipt: parseDeliveryLocalReviewAttestationReceipt(
                    candidate.payload["attestation"]
                  ),
                  sequence: candidate.sequence,
                },
              ]
            : []
        )
      )
    ).toThrow(
      "Only one local review attestation may confirm the same delivery authority"
    );
    expect(() => snapshotFromReplay(duplicateEvents)).toThrow(
      "Only one local review attestation may confirm the same delivery authority"
    );
    const wrongDigest = [
      ...events.slice(0, 8),
      event(9, "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED", {
        attestation: encodeDeliveryLocalReviewAttestationReceiptJson(
          DeliveryLocalReviewAttestationConfirmed.make({
            ...attestation,
            attestationPayloadDigest: "f".repeat(64),
            state: "confirmed",
          })
        ),
      }),
    ];
    expect(() => snapshotFromReplay(wrongDigest)).toThrow();

    const source = DeliveryLocalOperatorReviewSource.make({
      attestationActionId: attestation.actionId,
      attestationConfirmationSequence: 9,
      attestationPayloadDigest: attestation.attestationPayloadDigest,
      authoritySequence: attestation.authoritySequence,
      gaiaEvidenceDigest: attestation.gaiaEvidenceDigest,
      gaiaEvidenceId: attestation.gaiaEvidenceId,
      headSha: attestation.headSha,
      kind: "localOperatorPairedReview",
      version: 1,
    });
    const decisionBase = {
      actionId: "readiness-attested-1",
      approved: true,
      approvalSource: source,
      authoritySequence: 5,
      blockers: [],
      branchName: binding.branchName,
      headSha: binding.headSha,
      mergeMethod: "merge" as const,
      policyDigest: "a".repeat(64),
      policyVersion: 1 as const,
      prNumber: binding.prNumber,
      prUrl: binding.prUrl,
      publicationConfirmationSequence: 5,
      publicationOperationId: binding.publicationOperationId,
      publicationPayloadDigest: binding.publicationPayloadDigest,
      repository: binding.repository,
      runId,
      version: 2 as const,
    };
    const decision = DeliveryMergeReadinessDecisionV2.make({
      ...decisionBase,
      payloadDigest:
        deliveryMergeReadinessDecisionV2PayloadDigest(decisionBase),
    });
    const withDecision = [
      ...events,
      event(10, "DELIVERY_MERGE_READINESS_RECORDED", {
        decision: encodeDeliveryMergeReadinessDecisionJson(decision),
      }),
    ];
    expect(() => snapshotFromReplay(withDecision)).not.toThrow();
    expect(() =>
      snapshotFromReplay([
        ...events,
        event(10, "DELIVERY_MERGE_READINESS_RECORDED", {
          decision: encodeDeliveryMergeReadinessDecisionJson(
            DeliveryMergeReadinessDecisionV2.make({
              ...decision,
              runId: parseRunId("run-wrong12345"),
            })
          ),
        }),
      ])
    ).toThrow("current delivery authority");
    expect(() =>
      snapshotFromReplay([
        ...events,
        event(10, "DELIVERY_MERGE_READINESS_RECORDED", {
          decision: encodeDeliveryMergeReadinessDecisionJson(
            DeliveryMergeReadinessDecisionV2.make({
              ...decision,
              payloadDigest: "0".repeat(64),
            })
          ),
        }),
      ])
    ).toThrow("payload digest");

    const remediationBase = {
      attempt: 1 as const,
      commitTimestamp: "2026-07-11T19:02:00.000Z",
      expectedHeadSha: publication.headSha,
      feedbackDigest: "d".repeat(64),
      feedbackIds: [
        parseDeliveryFeedbackId(`feedback-comment-${"f".repeat(64)}`),
      ],
      inputId: "remediation-run-1234567890-1",
      operationId: "remediation:run-1234567890:1",
    };
    const remediatedHead = "b".repeat(40);
    const remediations = [
      DeliveryRemediationIntent.make({
        ...remediationBase,
        state: "intentRecorded",
      }),
      DeliveryRemediationDispatchAttempted.make({
        ...remediationBase,
        state: "dispatchAttempted",
      }),
      DeliveryRemediationTurnCompleted.make({
        ...remediationBase,
        state: "turnCompleted",
      }),
      DeliveryRemediationVerified.make({
        ...remediationBase,
        state: "verified",
      }),
      DeliveryRemediationCommitAttempted.make({
        ...remediationBase,
        commitSha: remediatedHead,
        state: "commitAttempted",
      }),
      DeliveryRemediationPushAttempted.make({
        ...remediationBase,
        commitSha: remediatedHead,
        state: "pushAttempted",
      }),
      DeliveryRemediationConfirmed.make({
        ...remediationBase,
        commitSha: remediatedHead,
        state: "confirmed",
      }),
    ];
    const laterRemediation = [
      ...events,
      ...remediations.map((remediation, index) =>
        event(10 + index, "DELIVERY_REMEDIATION_RECORDED", {
          remediation: encodeDeliveryRemediationJson(remediation),
        })
      ),
    ];
    expect(() => snapshotFromReplay(laterRemediation)).not.toThrow();
    expect(
      currentDeliveryLocalReviewAttestation(laterRemediation, {
        publication,
        repository: binding.repository,
        runId,
      })
    ).toBeUndefined();
  });
});
