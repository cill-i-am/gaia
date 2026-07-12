import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { parseWorkerRecoveryAction, parseWorkerRecoveryReceipt, WorkerRecoveryFailureEvidence, workerRecoveryProjection } from "./worker-recovery.js";

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
});
