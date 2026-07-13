import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { makeRunEvent, parseRunId, snapshotFromReplay } from "./index.js";
import {
  encodeWorkerContinuationReceiptJson,
  encodeWorkerCorrelationReconciliationReceiptJson,
  encodeWorkerDesktopOriginCorrelationReceiptJson,
  parseWorkerContinuationAction,
  parseWorkerContinuationReceipt,
  parseWorkerCorrelationReconciliationAction,
  parseWorkerCorrelationReconciliationReceipt,
  parseWorkerDesktopOriginCorrelationReceipt,
  parseWorkerRecoveryAction,
  parseWorkerRecoveryReceipt,
  WorkerRecoveryFailureEvidence,
  workerContinuationProjection,
  workerCorrelationReconciliationProjection,
  workerDesktopOriginCorrelationProjection,
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

  it("strictly parses audited correlation reconciliation actions without provider-native material", () => {
    const reconciliation = {
      actionId: "reconcile-correlation-1",
      expectedContaminatedReadySequence: 6,
      expectedContinuationActionId: "continue-recovery-1",
      expectedCurrentSequence: 9,
      expectedDeliveryProvenanceDigest: "c".repeat(64),
      expectedFailedContinuationSequence: 9,
      expectedFailedRecoverySequence: 8,
      expectedNativeTurnIdDigest: "b".repeat(64),
      expectedRecoveryActionId: "recover-1",
      expectedSessionId: "session-run-OzzhMsXsBb",
      harnessProfileId: "codexAppServer",
      kind: "reconcileInterruptedWorkerCorrelation",
    } as const;

    expect(parseWorkerCorrelationReconciliationAction(reconciliation)).toEqual(reconciliation);
    expect(() => parseWorkerCorrelationReconciliationAction({ ...reconciliation, nativeTurnId: "turn-123" })).toThrow();
    expect(() => parseWorkerCorrelationReconciliationAction({ ...reconciliation, nativeThreadId: "thread-123" })).toThrow();
    expect(() => parseWorkerCorrelationReconciliationAction({ ...reconciliation, protocol: "codex" })).toThrow();
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

  it("rejects continuation replay when only the delivery provenance digest drifts", () => {
    const runId = parseRunId("run-xwcFbNNdfY");
    const intentEvents = [
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
    const stable = snapshotFromReplay(intentEvents);
    const stableDelivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(stable.context.delivery);

    expect(stable.state).toBe("delivering");
    expect(stableDelivery["stage"]).toBe("workerContinuationPending");
    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        makeRunEvent({
          payload: {
            continuation: encodeWorkerContinuationReceiptJson(parseWorkerContinuationReceipt({
              actionId: "continue-recovery-1",
              expectedContaminatedReadySequence: 6,
              expectedCurrentSequence: 8,
              expectedDeliveryProvenanceDigest: "d".repeat(64),
              expectedFailedRecoverySequence: 8,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: "session-run-OzzhMsXsBb",
              harnessProfileId: "codexAppServer",
              maxAttempts: 1,
              state: "resumeAttempted",
              workerEvidenceEpochSequence: 9,
            })),
          },
          runId,
          sequence: 10,
          timestamp: "2026-07-11T08:00:03.000Z",
          type: "WORKER_CONTINUATION_RECORDED",
        }),
      ])
    ).toThrow("Worker continuation action is already bound to different immutable input.");
  });

  it("creates an authoritative worker epoch for correlation reconciliation and rejects checkpoint digest drift", () => {
    const runId = parseRunId("run-xwcFbNNdfY");
    const intentEvents = eligibleCorrelationEvents(runId);
    const snapshot = snapshotFromReplay(intentEvents);
    const delivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(snapshot.context.delivery);
    const reconciliation = parseWorkerCorrelationReconciliationReceipt(delivery["workerCorrelationReconciliation"]);

    expect(snapshot.state).toBe("delivering");
    expect(delivery["stage"]).toBe("workerCorrelationPending");
    expect(delivery["workerEvidenceEpochSequence"]).toBe(11);
    expect(workerCorrelationReconciliationProjection(reconciliation)).toBe("workerCorrelationPending");
    expect(delivery["publication"]).toBeUndefined();

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        makeRunEvent({
          payload: {
            reconciliation: encodeWorkerCorrelationReconciliationReceiptJson(parseWorkerCorrelationReconciliationReceipt({
              actionId: "reconcile-correlation-1",
              expectedContaminatedReadySequence: 6,
              expectedContinuationActionId: "continue-recovery-1",
              expectedCurrentSequence: 10,
              expectedDeliveryProvenanceDigest: "c".repeat(64),
              expectedFailedContinuationSequence: 10,
              expectedFailedRecoverySequence: 8,
              expectedNativeTurnIdDigest: "d".repeat(64),
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: "session-run-OzzhMsXsBb",
              harnessProfileId: "codexAppServer",
              maxAttempts: 1,
              state: "correlationAttempted",
              workerEvidenceEpochSequence: 11,
            })),
          },
          runId,
          sequence: 12,
          timestamp: "2026-07-11T08:00:04.000Z",
          type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
        }),
      ])
    ).toThrow("Worker correlation reconciliation action is already bound to different immutable input.");
  });

  it("replays legal correlation reconciliation phases only in durable order", () => {
    const runId = parseRunId("run-xwcFbNNdfY");
    const intentEvents = eligibleCorrelationEvents(runId);
    const legalEvents = [
      ...intentEvents,
      correlationReconciliationEvent(runId, 12, "correlationAttempted"),
      correlationReconciliationEvent(runId, 13, "correlationConfirmed"),
      correlationReconciliationEvent(runId, 14, "followUpAttempted"),
      correlationReconciliationEvent(runId, 15, "followUpConfirmed"),
      correlationReconciliationEvent(runId, 16, "workerCompleted"),
    ];

    const snapshot = snapshotFromReplay(legalEvents);
    const delivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(snapshot.context.delivery);
    const reconciliation = parseWorkerCorrelationReconciliationReceipt(delivery["workerCorrelationReconciliation"]);

    expect(reconciliation.state).toBe("workerCompleted");
    expect(delivery["workerEvidenceEpochSequence"]).toBe(11);
  });

  it("rejects skipped or out-of-order correlation reconciliation phases", () => {
    const runId = parseRunId("run-xwcFbNNdfY");
    const intentEvents = eligibleCorrelationEvents(runId);

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        correlationReconciliationEvent(runId, 12, "followUpConfirmed"),
      ])
    ).toThrow("Worker correlation reconciliation cannot transition from intentRecorded to followUpConfirmed.");

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        correlationReconciliationEvent(runId, 12, "correlationAttempted"),
        correlationReconciliationEvent(runId, 13, "followUpAttempted"),
      ])
    ).toThrow("Worker correlation reconciliation cannot transition from correlationAttempted to followUpAttempted.");

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        correlationReconciliationEvent(runId, 12, "correlationAttempted"),
        correlationReconciliationEvent(runId, 13, "correlationConfirmed"),
        correlationReconciliationEvent(runId, 14, "correlationAttempted"),
      ])
    ).toThrow("Worker correlation reconciliation cannot transition from correlationConfirmed to correlationAttempted.");
  });

  it("preserves only runtime-produced terminal correlation reconciliation edges", () => {
    const runId = parseRunId("run-xwcFbNNdfY");
    const intentEvents = eligibleCorrelationEvents(runId);

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        correlationReconciliationEvent(runId, 12, "correlationAttempted"),
        terminalCorrelationReconciliationEvent(runId, 13, "failed"),
      ])
    ).not.toThrow();

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        correlationReconciliationEvent(runId, 12, "correlationAttempted"),
        correlationReconciliationEvent(runId, 13, "correlationConfirmed"),
        correlationReconciliationEvent(runId, 14, "followUpAttempted"),
        terminalCorrelationReconciliationEvent(runId, 15, "outcomeUnknown"),
      ])
    ).not.toThrow();

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        correlationReconciliationEvent(runId, 12, "correlationAttempted"),
        correlationReconciliationEvent(runId, 13, "correlationConfirmed"),
        correlationReconciliationEvent(runId, 14, "followUpAttempted"),
        correlationReconciliationEvent(runId, 15, "followUpConfirmed"),
        terminalCorrelationReconciliationEvent(runId, 16, "failed"),
      ])
    ).not.toThrow();

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        correlationReconciliationEvent(runId, 12, "correlationAttempted"),
        correlationReconciliationEvent(runId, 13, "correlationConfirmed"),
        terminalCorrelationReconciliationEvent(runId, 14, "outcomeUnknown"),
      ])
    ).toThrow("Worker correlation reconciliation cannot transition from correlationConfirmed to outcomeUnknown.");
  });

  it("records a distinct desktop-origin correlation epoch after terminal source-classification failure", () => {
    const runId = parseRunId("run-xwcFbNNdfY");
    const intentEvents = [
      ...failedCorrelationEvents(runId),
      desktopOriginCorrelationEvent(runId, 14, "intentRecorded"),
    ];
    const snapshot = snapshotFromReplay(intentEvents);
    const delivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(snapshot.context.delivery);
    const prior = parseWorkerCorrelationReconciliationReceipt(delivery["workerCorrelationReconciliation"]);
    const desktop = parseWorkerDesktopOriginCorrelationReceipt(delivery["workerDesktopOriginCorrelation"]);

    expect(snapshot.state).toBe("delivering");
    expect(prior.state).toBe("failed");
    expect(prior.actionId).toBe("reconcile-correlation-1");
    expect(desktop.state).toBe("intentRecorded");
    expect(delivery["stage"]).toBe("workerCorrelationPending");
    expect(delivery["workerEvidenceEpochSequence"]).toBe(14);
    expect(workerDesktopOriginCorrelationProjection(desktop)).toBe("workerCorrelationPending");

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        makeRunEvent({
          payload: {
            desktopOriginCorrelation: encodeWorkerDesktopOriginCorrelationReceiptJson(parseWorkerDesktopOriginCorrelationReceipt({
              ...desktopOriginCorrelationBase,
              expectedFailedCorrelationSequence: 12,
              state: "sourceCorrelationAttempted",
            })),
          },
          runId,
          sequence: 15,
          timestamp: "2026-07-11T08:00:15.000Z",
          type: "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED",
        }),
      ])
    ).toThrow("Worker desktop-origin correlation action is already bound to different immutable input.");
  });

  it("replays legal Desktop-origin correlation phases only in durable order", () => {
    const runId = parseRunId("run-xwcFbNNdfY");
    const intentEvents = [
      ...failedCorrelationEvents(runId),
      desktopOriginCorrelationEvent(runId, 14, "intentRecorded"),
    ];
    const legalEvents = [
      ...intentEvents,
      desktopOriginCorrelationEvent(runId, 15, "sourceCorrelationAttempted"),
      desktopOriginCorrelationEvent(runId, 16, "sourceCorrelationConfirmed"),
      desktopOriginCorrelationEvent(runId, 17, "followUpAttempted"),
      desktopOriginCorrelationEvent(runId, 18, "followUpConfirmed"),
      desktopOriginCorrelationEvent(runId, 19, "workerCompleted"),
    ];

    const snapshot = snapshotFromReplay(legalEvents);
    const delivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(snapshot.context.delivery);
    const desktop = parseWorkerDesktopOriginCorrelationReceipt(delivery["workerDesktopOriginCorrelation"]);

    expect(desktop.state).toBe("workerCompleted");
    expect(delivery["workerEvidenceEpochSequence"]).toBe(14);
  });

  it("rejects skipped or out-of-order Desktop-origin correlation phases", () => {
    const runId = parseRunId("run-xwcFbNNdfY");
    const intentEvents = [
      ...failedCorrelationEvents(runId),
      desktopOriginCorrelationEvent(runId, 14, "intentRecorded"),
    ];

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        desktopOriginCorrelationEvent(runId, 15, "followUpConfirmed"),
      ])
    ).toThrow("Worker desktop-origin correlation cannot transition from intentRecorded to followUpConfirmed.");

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        desktopOriginCorrelationEvent(runId, 15, "sourceCorrelationAttempted"),
        desktopOriginCorrelationEvent(runId, 16, "followUpAttempted"),
      ])
    ).toThrow("Worker desktop-origin correlation cannot transition from sourceCorrelationAttempted to followUpAttempted.");

    expect(() =>
      snapshotFromReplay([
        ...intentEvents,
        desktopOriginCorrelationEvent(runId, 15, "sourceCorrelationAttempted"),
        desktopOriginCorrelationEvent(runId, 16, "sourceCorrelationConfirmed"),
        terminalDesktopOriginCorrelationEvent(runId, 17, "outcomeUnknown"),
      ])
    ).toThrow("Worker desktop-origin correlation cannot transition from sourceCorrelationConfirmed to outcomeUnknown.");
  });
});

function desktopOriginCorrelationEvent(
  runId: ReturnType<typeof parseRunId>,
  sequence: number,
  state: "intentRecorded" | "sourceCorrelationAttempted" | "sourceCorrelationConfirmed" | "followUpAttempted" | "followUpConfirmed" | "workerCompleted",
) {
  return makeRunEvent({
    payload: {
      desktopOriginCorrelation: encodeWorkerDesktopOriginCorrelationReceiptJson(parseWorkerDesktopOriginCorrelationReceipt({
        ...desktopOriginCorrelationBase,
        state,
      })),
    },
    runId,
    sequence,
    timestamp: `2026-07-11T08:00:${sequence}.000Z`,
    type: "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED",
  });
}

function terminalDesktopOriginCorrelationEvent(
  runId: ReturnType<typeof parseRunId>,
  sequence: number,
  state: "failed" | "outcomeUnknown",
) {
  return makeRunEvent({
    payload: {
      desktopOriginCorrelation: encodeWorkerDesktopOriginCorrelationReceiptJson(parseWorkerDesktopOriginCorrelationReceipt({
        ...desktopOriginCorrelationBase,
        code: state === "failed"
          ? "WorkerDesktopOriginCorrelationFailed"
          : "WorkerDesktopOriginCorrelationOutcomeUnknown",
        message: state === "failed"
          ? "Audited Desktop-origin correlation failed."
          : "Audited Desktop-origin correlation outcome is unknown.",
        state,
      })),
    },
    runId,
    sequence,
    timestamp: `2026-07-11T08:00:${sequence}.000Z`,
    type: "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED",
  });
}

const desktopOriginCorrelationBase = {
  actionId: "reconcile-desktop-origin-1",
  expectedContaminatedReadySequence: 6,
  expectedContinuationActionId: "continue-recovery-1",
  expectedCorrelationActionId: "reconcile-correlation-1",
  expectedCurrentSequence: 13,
  expectedDeliveryProvenanceDigest: "c".repeat(64),
  expectedFailedContinuationSequence: 10,
  expectedFailedCorrelationSequence: 13,
  expectedFailedRecoverySequence: 8,
  expectedNativeTurnIdDigest: "b".repeat(64),
  expectedRecoveryActionId: "recover-1",
  expectedSessionId: "session-run-OzzhMsXsBb",
  harnessProfileId: "codexAppServer",
  maxAttempts: 1 as const,
  workerEvidenceEpochSequence: 14,
} as const;

function failedCorrelationEvents(runId: ReturnType<typeof parseRunId>) {
  return [
    ...eligibleCorrelationEvents(runId),
    correlationReconciliationEvent(runId, 12, "correlationAttempted"),
    terminalCorrelationReconciliationEvent(runId, 13, "failed"),
  ];
}

function correlationReconciliationEvent(
  runId: ReturnType<typeof parseRunId>,
  sequence: number,
  state: "correlationAttempted" | "correlationConfirmed" | "followUpAttempted" | "followUpConfirmed" | "workerCompleted",
) {
  return makeRunEvent({
    payload: {
      reconciliation: encodeWorkerCorrelationReconciliationReceiptJson(parseWorkerCorrelationReconciliationReceipt({
        ...correlationReconciliationBase,
        state,
      })),
    },
    runId,
    sequence,
    timestamp: `2026-07-11T08:00:${sequence}.000Z`,
    type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
  });
}

function terminalCorrelationReconciliationEvent(
  runId: ReturnType<typeof parseRunId>,
  sequence: number,
  state: "failed" | "outcomeUnknown",
) {
  return makeRunEvent({
    payload: {
      reconciliation: encodeWorkerCorrelationReconciliationReceiptJson(parseWorkerCorrelationReconciliationReceipt({
        ...correlationReconciliationBase,
        code: state === "failed"
          ? "WorkerCorrelationReconciliationFailed"
          : "WorkerCorrelationOutcomeUnknown",
        message: state === "failed"
          ? "Audited worker correlation reconciliation failed."
          : "Audited worker correlation reconciliation outcome is unknown.",
        state,
      })),
    },
    runId,
    sequence,
    timestamp: `2026-07-11T08:00:${sequence}.000Z`,
    type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
  });
}

const correlationReconciliationBase = {
  actionId: "reconcile-correlation-1",
  expectedContaminatedReadySequence: 6,
  expectedContinuationActionId: "continue-recovery-1",
  expectedCurrentSequence: 10,
  expectedDeliveryProvenanceDigest: "c".repeat(64),
  expectedFailedContinuationSequence: 10,
  expectedFailedRecoverySequence: 8,
  expectedNativeTurnIdDigest: "b".repeat(64),
  expectedRecoveryActionId: "recover-1",
  expectedSessionId: "session-run-OzzhMsXsBb",
  harnessProfileId: "codexAppServer",
  maxAttempts: 1 as const,
  workerEvidenceEpochSequence: 11,
} as const;

function eligibleCorrelationEvents(runId: ReturnType<typeof parseRunId>) {
  return [
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
          state: "failed",
          code: "HarnessCorrelationUnavailable",
          message: "The interrupted checkpoint correlation is unavailable.",
          workerEvidenceEpochSequence: 9,
        })),
      },
      runId,
      sequence: 10,
      timestamp: "2026-07-11T08:00:02.500Z",
      type: "WORKER_CONTINUATION_RECORDED",
    }),
    makeRunEvent({
      payload: {
        reconciliation: encodeWorkerCorrelationReconciliationReceiptJson(parseWorkerCorrelationReconciliationReceipt({
          actionId: "reconcile-correlation-1",
          expectedContaminatedReadySequence: 6,
          expectedContinuationActionId: "continue-recovery-1",
          expectedCurrentSequence: 10,
          expectedDeliveryProvenanceDigest: "c".repeat(64),
          expectedFailedContinuationSequence: 10,
          expectedFailedRecoverySequence: 8,
          expectedNativeTurnIdDigest: "b".repeat(64),
          expectedRecoveryActionId: "recover-1",
          expectedSessionId: "session-run-OzzhMsXsBb",
          harnessProfileId: "codexAppServer",
          maxAttempts: 1,
          state: "intentRecorded",
          workerEvidenceEpochSequence: 11,
        })),
      },
      runId,
      sequence: 11,
      timestamp: "2026-07-11T08:00:03.000Z",
      type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
    }),
  ];
}

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
