import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  DeliveryFeedbackTrustPolicyV1,
  DeliveryRemediationCommitAttempted,
  DeliveryRemediationConfirmed,
  DeliveryRemediationDispatchAttempted,
  DeliveryRemediationFailed,
  DeliveryRemediationIntent,
  DeliveryRemediationPushAttempted,
  DeliveryRemediationTurnCompleted,
  DeliveryRemediationVerified,
  encodeDeliveryRemediationJson,
  parseDeliveryFeedbackId,
  parseDeliveryFeedbackTrustPolicy,
  validateDeliveryRemediationTransition,
} from "./delivery-remediation.js";
import { makeRunEvent } from "./events.js";
import { snapshotFromReplay } from "./machine.js";
import { parseRunId } from "./run-id.js";

const oldHead = "1".repeat(40);
const newHead = "2".repeat(40);
const digest = "a".repeat(64);
const commitTimestamp = "2026-07-11T11:00:00.000Z";
const feedbackId = parseDeliveryFeedbackId(
  `feedback-comment-${"f".repeat(64)}`,
);

describe("delivery remediation contracts", () => {
  it("parses an immutable empty-by-default human trust policy", () => {
    const policy = parseDeliveryFeedbackTrustPolicy({
      allowPullRequestAuthor: false,
      trustedChecks: [
        {
          appSlug: "github-actions",
          name: "gaia-pr-ci",
          repository: "cill-i-am/gaia",
          workflow: "Gaia PR CI",
        },
      ],
      trustedHumanLogins: [],
      version: 1,
    });

    assert.instanceOf(policy, DeliveryFeedbackTrustPolicyV1);
    assert.deepEqual(policy.trustedHumanLogins, []);
    assert.throws(() =>
      parseDeliveryFeedbackTrustPolicy({
        ...policy,
        unexpected: true,
      }),
    );
  });

  it("accepts only stable opaque public feedback ids", () => {
    assert.match(feedbackId, /^feedback-comment-[a-f0-9]{64}$/u);
    assert.notInclude(feedbackId, "12345");
    assert.throws(() => parseDeliveryFeedbackId("feedback-comment-12345"));
  });

  it("accepts one monotonic remediation operation through confirmation", () => {
    const intent = DeliveryRemediationIntent.make({
      attempt: 1,
      commitTimestamp,
      expectedHeadSha: oldHead,
      feedbackDigest: digest,
      feedbackIds: [feedbackId],
      inputId: "remediation-run-1234567890-1",
      operationId: "remediation:run-1234567890:1",
      state: "intentRecorded",
    });
    const attempted = DeliveryRemediationDispatchAttempted.make({
      ...intent,
      state: "dispatchAttempted",
    });
    const turnCompleted = DeliveryRemediationTurnCompleted.make({
      ...attempted,
      state: "turnCompleted",
    });
    const verified = DeliveryRemediationVerified.make({
      ...turnCompleted,
      state: "verified",
    });
    const commitAttempted = DeliveryRemediationCommitAttempted.make({
      ...verified,
      commitSha: newHead,
      state: "commitAttempted",
    });
    const pushAttempted = DeliveryRemediationPushAttempted.make({
      ...commitAttempted,
      state: "pushAttempted",
    });
    const confirmed = DeliveryRemediationConfirmed.make({
      ...pushAttempted,
      state: "confirmed",
    });

    assert.doesNotThrow(() =>
      validateDeliveryRemediationTransition(undefined, intent),
    );
    assert.doesNotThrow(() =>
      validateDeliveryRemediationTransition(intent, attempted),
    );
    assert.doesNotThrow(() =>
      validateDeliveryRemediationTransition(attempted, turnCompleted),
    );
    assert.doesNotThrow(() =>
      validateDeliveryRemediationTransition(turnCompleted, verified),
    );
    assert.doesNotThrow(() =>
      validateDeliveryRemediationTransition(verified, commitAttempted),
    );
    assert.doesNotThrow(() =>
      validateDeliveryRemediationTransition(commitAttempted, pushAttempted),
    );
    assert.doesNotThrow(() =>
      validateDeliveryRemediationTransition(pushAttempted, confirmed),
    );
    const secondIntent = DeliveryRemediationIntent.make({
      attempt: 2,
      commitTimestamp,
      expectedHeadSha: newHead,
      feedbackDigest: "b".repeat(64),
      feedbackIds: [feedbackId],
      inputId: "remediation-run-1234567890-2",
      operationId: "remediation:run-1234567890:2",
      state: "intentRecorded",
    });
    assert.doesNotThrow(() =>
      validateDeliveryRemediationTransition(confirmed, secondIntent),
    );
    assert.throws(() =>
      validateDeliveryRemediationTransition(
        confirmed,
        DeliveryRemediationIntent.make({
          ...secondIntent,
          feedbackDigest: confirmed.feedbackDigest,
        }),
      ),
    );
  });

  it("rejects a third attempt and immutable binding changes", () => {
    assert.throws(() =>
      DeliveryRemediationIntent.make({
        attempt: 3,
        commitTimestamp,
        expectedHeadSha: oldHead,
        feedbackDigest: digest,
        feedbackIds: [feedbackId],
        inputId: "remediation-run-1234567890-3",
        operationId: "remediation:run-1234567890:3",
        state: "intentRecorded",
      }),
    );

    const intent = DeliveryRemediationIntent.make({
      attempt: 1,
      commitTimestamp,
      expectedHeadSha: oldHead,
      feedbackDigest: digest,
      feedbackIds: [feedbackId],
      inputId: "remediation-run-1234567890-1",
      operationId: "remediation:run-1234567890:1",
      state: "intentRecorded",
    });
    const changed = DeliveryRemediationDispatchAttempted.make({
      ...intent,
      feedbackDigest: "b".repeat(64),
      state: "dispatchAttempted",
    });

    assert.throws(() => validateDeliveryRemediationTransition(intent, changed));
  });

  it("rejects reusing a one-shot authorization digest for a new attempt", () => {
    const authorizationDigest = "c".repeat(64);
    const intent = DeliveryRemediationIntent.make({
      attempt: 1,
      authorizationDigest,
      commitTimestamp,
      expectedHeadSha: oldHead,
      feedbackDigest: digest,
      feedbackIds: [feedbackId],
      inputId: "remediation-run-1234567890-1",
      operationId: "remediation:run-1234567890:1",
      state: "intentRecorded",
    });
    const failed = DeliveryRemediationFailed.make({
      ...intent,
      code: "VerificationFailed",
      message: "The first attempt failed conclusively.",
      recoverable: true,
      state: "failed",
    });
    const reused = DeliveryRemediationIntent.make({
      ...intent,
      attempt: 2,
      inputId: "remediation-run-1234567890-2",
      operationId: "remediation:run-1234567890:2",
    });

    assert.doesNotThrow(() => validateDeliveryRemediationTransition(intent, failed));
    assert.throws(() => validateDeliveryRemediationTransition(failed, reused));
  });

  it("replays remediation and exposes the intent sequence as the re-arm cursor", () => {
    const runId = parseRunId("run-1234567890");
    const intent = DeliveryRemediationIntent.make({
      attempt: 1,
      commitTimestamp,
      expectedHeadSha: oldHead,
      feedbackDigest: digest,
      feedbackIds: [feedbackId],
      inputId: "remediation-run-1234567890-1",
      operationId: "remediation:run-1234567890:1",
      state: "intentRecorded",
    });
    const snapshot = snapshotFromReplay([
      makeRunEvent({
        runId,
        sequence: 1,
        timestamp: "2026-07-11T11:00:00.000Z",
        type: "RUN_CREATED",
        payload: { specPath: "spec.md" },
      }),
      makeRunEvent({
        runId,
        sequence: 2,
        timestamp: "2026-07-11T11:00:01.000Z",
        type: "DELIVERY_STARTED",
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: oldHead,
            headBranch: `gaia/${runId}`,
            mode: "pullRequest",
            remote: "origin",
            stage: "waitingForPr",
          },
        },
      }),
      makeRunEvent({
        runId,
        sequence: 3,
        timestamp: "2026-07-11T11:00:02.000Z",
        type: "DELIVERY_REMEDIATION_RECORDED",
        payload: { remediation: encodeDeliveryRemediationJson(intent) },
      }),
    ]);
    const delivery = Schema.decodeUnknownSync(
      Schema.Record(Schema.String, Schema.Json),
    )(snapshot.context.delivery);
    assert.strictEqual(delivery["stage"], "remediating");
    assert.strictEqual(delivery["remediationRearmSequence"], 3);
    assert.deepEqual(delivery["remediation"], encodeDeliveryRemediationJson(intent));
  });
});
