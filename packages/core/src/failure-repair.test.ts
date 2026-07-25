import { assert, describe, it } from "@effect/vitest";

import { parseRunEvent } from "./events.js";
import {
  decideFailureRepair,
  encodeFailureDigestV1Json,
  FailureRepairDispatchAttempted,
  FailureRepairExhausted,
  FailureRepairFailed,
  FailureRepairIntent,
  FailureRepairOutcomeUnknown,
  FailureRepairSuperseded,
  FailureRepairTurnCompleted,
  FailureRepairVerified,
  makeFailureDigestV1,
  parseFailureDigestV1,
  validateFailureRepairTransition,
} from "./failure-repair.js";
import { parseRunEventSequence } from "./run-contract.js";
import { parseRunId } from "./run-id.js";

const claimId = `proof-claim:sha256:${"a".repeat(64)}`;
const evidenceId = `proof-evidence:sha256:${"b".repeat(64)}`;
const runId = parseRunId("run-1234567890");

describe("failure repair contracts", () => {
  it("keys a confirmed exact-claim failure by a deterministic fingerprint and selects repair", () => {
    const first = makeFailureDigestV1({
      attempt: 1,
      evidenceRefs: [
        {
          artifactPath: "verification/claim-command.json",
          contentDigest: "c".repeat(64),
          evidenceId,
          kind: "command",
        },
      ],
      failedRef: { claimId, kind: "claim" },
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });
    const second = makeFailureDigestV1({
      attempt: 2,
      evidenceRefs: first.evidenceRefs,
      failedRef: first.failedRef,
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });

    assert.strictEqual(first.fingerprint, second.fingerprint);
    assert.strictEqual(decideFailureRepair(first), "repair");
    assert.strictEqual(first.nextSafeAction, "repair");
    assert.strictEqual(first.safeSummary, "Exact verification claim failed.");
  });

  it("routes every current failure class without selecting retry", () => {
    const repair = makeFailureDigestV1({
      attempt: 1,
      evidenceRefs: [],
      failedRef: { claimId, kind: "claim" },
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });
    const exhausted = makeFailureDigestV1({
      attempt: 2,
      evidenceRefs: repair.evidenceRefs,
      failedRef: repair.failedRef,
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });
    const reconcile = makeFailureDigestV1({
      attempt: 1,
      evidenceRefs: [],
      failedRef: {
        actionId: "provider-action-1234567890",
        actionKind: "externalMutation",
        kind: "action",
      },
      maxAttempts: 2,
      outcomeCertainty: "unknown",
      retryability: "reconciliationRequired",
      stage: "verifying",
      tag: "externalOutcomeUnknown",
    });
    const escalate = makeFailureDigestV1({
      attempt: 1,
      evidenceRefs: [],
      failedRef: { claimId, kind: "claim" },
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "notRepairable",
      stage: "verifying",
      tag: "nonRepairableFailure",
    });
    const decisions = [repair, exhausted, reconcile, escalate].map(
      decideFailureRepair
    );

    assert.deepEqual(decisions, [
      "repair",
      "repair",
      "reconciliation",
      "escalation",
    ]);
    assert.notInclude(decisions, "retry");
  });

  it("keeps encoded repair context bounded and rejects raw secret-bearing input", () => {
    const secret = "provider-token-super-secret";
    const digest = makeFailureDigestV1({
      attempt: 1,
      evidenceRefs: [
        {
          artifactPath: "verification/claim-command.json",
          contentDigest: "c".repeat(64),
          evidenceId,
          kind: "command",
        },
      ],
      failedRef: { claimId, kind: "claim" },
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });
    const encoded = encodeFailureDigestV1Json(digest);
    const evidence = digest.evidenceRefs[0];
    if (evidence === undefined) throw new Error("Missing evidence fixture.");

    assert.notInclude(JSON.stringify(encoded), secret);
    assert.throws(() =>
      parseFailureDigestV1({
        ...digest,
        rawSource: { stderr: secret },
      })
    );
    assert.throws(() =>
      parseFailureDigestV1({
        ...digest,
        evidenceRefs: Array.from({ length: 9 }, () => evidence),
      })
    );
  });

  it("persists two monotonic repair attempts and makes unknown/exhausted outcomes terminal", () => {
    const digest = makeFailureDigestV1({
      attempt: 1,
      evidenceRefs: [],
      failedRef: { claimId, kind: "claim" },
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });
    const common = {
      digest,
      episodeKey: `failureRepair:${digest.fingerprint}:1`,
      failedProofResultSequence: parseRunEventSequence(5),
      runId,
    };
    const intent = FailureRepairIntent.make({
      ...common,
      state: "intentRecorded",
    });
    const attempted = FailureRepairDispatchAttempted.make({
      ...common,
      state: "dispatchAttempted",
    });
    const completed = FailureRepairTurnCompleted.make({
      ...common,
      state: "turnCompleted",
      terminalEventSequence: parseRunEventSequence(9),
    });
    const failed = FailureRepairFailed.make({
      ...common,
      code: "RepairVerificationFailed",
      message: "Exact claim still failed.",
      proofResultSequence: parseRunEventSequence(10),
      state: "failed",
    });
    const secondDigest = makeFailureDigestV1({
      attempt: 2,
      evidenceRefs: [],
      failedRef: digest.failedRef,
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });
    const secondCommon = {
      ...common,
      digest: secondDigest,
      episodeKey: `failureRepair:${secondDigest.fingerprint}:2`,
      failedProofResultSequence: parseRunEventSequence(10),
    };
    const secondIntent = FailureRepairIntent.make({
      ...secondCommon,
      state: "intentRecorded",
    });
    const secondAttempted = FailureRepairDispatchAttempted.make({
      ...secondCommon,
      state: "dispatchAttempted",
    });
    const secondCompleted = FailureRepairTurnCompleted.make({
      ...secondCommon,
      state: "turnCompleted",
      terminalEventSequence: parseRunEventSequence(14),
    });
    const secondFailed = FailureRepairFailed.make({
      ...secondCommon,
      code: "RepairVerificationFailed",
      message: "Exact claim still failed.",
      proofResultSequence: parseRunEventSequence(15),
      state: "failed",
    });
    const exhausted = FailureRepairExhausted.make({
      ...secondCommon,
      state: "exhausted",
    });
    const verified = FailureRepairVerified.make({
      ...common,
      proofResultSequence: parseRunEventSequence(10),
      state: "verified",
    });
    const unknown = FailureRepairOutcomeUnknown.make({
      ...common,
      code: "RepairDispatchOutcomeUnknown",
      message: "Repair dispatch outcome is unknown.",
      state: "outcomeUnknown",
    });
    const superseded = FailureRepairSuperseded.make({
      ...common,
      proofResultSequence: parseRunEventSequence(11),
      state: "superseded",
    });

    assert.doesNotThrow(() =>
      validateFailureRepairTransition(undefined, intent)
    );
    assert.doesNotThrow(() =>
      validateFailureRepairTransition(intent, attempted)
    );
    assert.doesNotThrow(() =>
      validateFailureRepairTransition(attempted, completed)
    );
    assert.doesNotThrow(() =>
      validateFailureRepairTransition(completed, failed)
    );
    assert.doesNotThrow(() =>
      validateFailureRepairTransition(failed, secondIntent)
    );
    assert.doesNotThrow(() =>
      validateFailureRepairTransition(secondIntent, secondAttempted)
    );
    assert.doesNotThrow(() =>
      validateFailureRepairTransition(secondAttempted, secondCompleted)
    );
    assert.doesNotThrow(() =>
      validateFailureRepairTransition(secondCompleted, secondFailed)
    );
    assert.doesNotThrow(() =>
      validateFailureRepairTransition(secondFailed, exhausted)
    );
    assert.doesNotThrow(() =>
      validateFailureRepairTransition(attempted, unknown)
    );
    assert.doesNotThrow(() =>
      validateFailureRepairTransition(failed, superseded)
    );
    assert.throws(() => validateFailureRepairTransition(unknown, completed));
    assert.throws(() =>
      validateFailureRepairTransition(superseded, secondIntent)
    );
    assert.throws(() =>
      validateFailureRepairTransition(exhausted, secondIntent)
    );
    assert.throws(() =>
      validateFailureRepairTransition(verified, secondIntent)
    );
  });

  it("accepts only a run-bound failure-repair receipt in the authoritative event", () => {
    const digest = makeFailureDigestV1({
      attempt: 1,
      evidenceRefs: [],
      failedRef: { claimId, kind: "claim" },
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });
    const failureRepair = FailureRepairIntent.make({
      digest,
      episodeKey: `failureRepair:${digest.fingerprint}:1`,
      failedProofResultSequence: parseRunEventSequence(5),
      runId,
      state: "intentRecorded",
    });
    const event = {
      payload: { failureRepair },
      runId,
      sequence: parseRunEventSequence(6),
      timestamp: "2026-07-25T12:30:00.000Z",
      type: "FAILURE_REPAIR_RECORDED",
      version: 1,
    };

    assert.doesNotThrow(() => parseRunEvent(event));
    assert.throws(() =>
      parseRunEvent({
        ...event,
        payload: {
          failureRepair: {
            ...failureRepair,
            runId: parseRunId("run-0987654321"),
          },
        },
      })
    );
  });
});
