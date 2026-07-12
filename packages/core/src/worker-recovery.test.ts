import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { makeRunEvent, parseRunId, snapshotFromReplay } from "./index.js";
import {
  encodeWorkerContinuationReceiptJson,
  parseWorkerContinuationAction,
  parseWorkerContinuationReceipt,
  parseWorkerRecoveryAction,
  parseWorkerRecoveryReceipt,
  WorkerRecoveryFailureEvidence,
  workerContinuationProjection,
  workerRecoveryProjection,
} from "./worker-recovery.js";

const action = {
  actionId: "recover-1",
  expectedFailureSequence: 15,
  expectedSessionId: "session-run-OzzhMsXsBb",
  harnessProfileId: "codexAppServer",
  kind: "retryRecoverableWorkerFailure",
  model: "gpt-5.4",
} as const;

describe("worker recovery contracts", () => {
  it("strictly parses the exact one-attempt action", () => {
    expect(parseWorkerRecoveryAction(action)).toEqual(action);
    expect(() => parseWorkerRecoveryAction({ ...action, extra: true })).toThrow();
  });

  it("keeps pending and dispatching distinct from a confirmed worker", () => {
    const base = { ...action, attempt: 1 as const, maxAttempts: 1 as const, payloadDigest: "a".repeat(64) };
    expect(workerRecoveryProjection(parseWorkerRecoveryReceipt({ ...base, state: "intentRecorded" }))).toBe("workerRecoveryPending");
    expect(workerRecoveryProjection(parseWorkerRecoveryReceipt({ ...base, state: "dispatchAttempted" }))).toBe("workerRecoveryDispatching");
    expect(workerRecoveryProjection(parseWorkerRecoveryReceipt({ ...base, nativeTurnIdDigest: "b".repeat(64), state: "dispatchConfirmed" }))).toBe("runningWorker");
    expect(workerRecoveryProjection(parseWorkerRecoveryReceipt({ ...base, code: "WorkerRecoveryOutcomeUnknown", message: "Ambiguous provider outcome.", state: "outcomeUnknown" }))).toBe("workerRecoveryOutcomeUnknown");
  });

  it("strictly limits public failure evidence to finite safe fields", () => {
    const evidence = {
      actionId: "recover-1",
      code: "WorkerRecoveryModelUnavailable",
      runId: "run-OzzhMsXsBb",
      stage: "modelSelection",
      status: 422,
      timestamp: "2026-07-12T08:00:00.000Z",
    } as const;
    expect(Schema.decodeUnknownSync(WorkerRecoveryFailureEvidence)(evidence)).toEqual(evidence);
    expect(() => Schema.decodeUnknownSync(WorkerRecoveryFailureEvidence)({ ...evidence, rawCause: "secret" })).toThrow();
    expect(() => Schema.decodeUnknownSync(WorkerRecoveryFailureEvidence)({ ...evidence, code: "ArbitraryCode" })).toThrow();
  });

  it("strictly parses audited continuation actions without provider-native checkpoint material", () => {
    const continuation = {
      actionId: "continue-recovery-1",
      expectedContaminatedReadySequence: 6,
      expectedCurrentSequence: 9,
      expectedDeliveryProvenanceDigest: "c".repeat(64),
      expectedFailedRecoverySequence: 8,
      expectedRecoveryActionId: "recover-1",
      expectedSessionId: "session-run-OzzhMsXsBb",
      harnessProfileId: "codexAppServer",
      kind: "continueInterruptedWorkerRecovery",
    } as const;

    expect(parseWorkerContinuationAction(continuation)).toEqual(continuation);
    expect(() => parseWorkerContinuationAction({ ...continuation, nativeTurnId: "turn-123" })).toThrow();
    expect(() => parseWorkerContinuationAction({ ...continuation, nativeTurnIdDigest: "a".repeat(64) })).toThrow();
    expect(() => parseWorkerContinuationAction({ ...continuation, protocol: "codex" })).toThrow();
  });

  it("quarantines stale ready evidence behind a new authoritative worker epoch", () => {
    const runId = parseRunId("run-xwcFbNNdfY");
    const events = [
      ...readyToPublishEvents(runId),
      makeRunEvent({
        payload: {
          recovery: {
            ...action,
            attempt: 1,
            maxAttempts: 1,
            nativeTurnIdDigest: "b".repeat(64),
            payloadDigest: "a".repeat(64),
            state: "dispatchConfirmed",
          },
        },
        runId,
        sequence: 7,
        timestamp: "2026-07-11T08:00:00.000Z",
        type: "WORKER_RECOVERY_RECORDED",
      }),
      makeRunEvent({
        payload: {
          recovery: {
            ...action,
            attempt: 1,
            code: "WorkerRecoveryContinuationFailed",
            maxAttempts: 1,
            message: "The checkpoint turn was interrupted after zero product changes.",
            nativeTurnIdDigest: "b".repeat(64),
            payloadDigest: "a".repeat(64),
            state: "failed",
          },
        },
        runId,
        sequence: 8,
        timestamp: "2026-07-11T08:00:01.000Z",
        type: "WORKER_RECOVERY_RECORDED",
      }),
      makeRunEvent({
        payload: {
          continuation: encodeWorkerContinuationReceiptJson(parseWorkerContinuationReceipt({
            actionId: "continue-recovery-1",
            expectedContaminatedReadySequence: 6,
            expectedCurrentSequence: 8,
            expectedDeliveryProvenanceDigest: "c".repeat(64),
            expectedFailedRecoverySequence: 8,
            expectedRecoveryActionId: "recover-1",
            expectedSessionId: "session-run-OzzhMsXsBb",
            harnessProfileId: "codexAppServer",
            maxAttempts: 1,
            state: "intentRecorded",
            workerEvidenceEpochSequence: 9,
          })),
        },
        runId,
        sequence: 9,
        timestamp: "2026-07-11T08:00:02.000Z",
        type: "WORKER_CONTINUATION_RECORDED",
      }),
    ];

    const snapshot = snapshotFromReplay(events);
    const delivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(snapshot.context.delivery);
    const continuation = parseWorkerContinuationReceipt(delivery["workerContinuation"]);

    expect(snapshot.state).toBe("delivering");
    expect(delivery["stage"]).toBe("workerContinuationPending");
    expect(delivery["workerEvidenceEpochSequence"]).toBe(9);
    expect(continuation.state).toBe("intentRecorded");
    expect(workerContinuationProjection(continuation)).toBe("workerContinuationPending");
    expect(delivery["publication"]).toBeUndefined();
  });
});

function readyToPublishEvents(runId: ReturnType<typeof parseRunId>) {
  const delivery = {
    baseBranch: "main",
    baseRevision: "a".repeat(40),
    headBranch: `gaia/${runId}`,
    mode: "pullRequest",
    remote: "origin",
  };
  return [
    makeRunEvent({
      payload: { specPath: "input.md" },
      runId,
      sequence: 1,
      timestamp: "2026-07-11T07:59:54.000Z",
      type: "RUN_CREATED",
    }),
    makeRunEvent({
      payload: { delivery: { ...delivery, stage: "delivering" } },
      runId,
      sequence: 2,
      timestamp: "2026-07-11T07:59:55.000Z",
      type: "DELIVERY_STARTED",
    }),
    makeRunEvent({
      payload: { workspacePath: "workspace" },
      runId,
      sequence: 3,
      timestamp: "2026-07-11T07:59:56.000Z",
      type: "WORKSPACE_PREPARED",
    }),
    makeRunEvent({
      payload: { workerResultPath: "worker-result.json" },
      runId,
      sequence: 4,
      timestamp: "2026-07-11T07:59:57.000Z",
      type: "WORKER_COMPLETED",
    }),
    makeRunEvent({
      payload: { verificationResultPath: "verification-result.json" },
      runId,
      sequence: 5,
      timestamp: "2026-07-11T07:59:58.000Z",
      type: "VERIFICATION_COMPLETED",
    }),
    makeRunEvent({
      payload: {
        delivery: { ...delivery, stage: "readyToPublish" },
        reportPath: "report.md",
      },
      runId,
      sequence: 6,
      timestamp: "2026-07-11T07:59:59.000Z",
      type: "DELIVERY_READY_TO_PUBLISH",
    }),
  ];
}
