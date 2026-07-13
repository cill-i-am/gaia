import { createHash } from "node:crypto";
import { parseHarnessEvent, parseWorkerRecoveryReceipt, encodeWorkerRecoveryReceiptJson, type RunId, type WorkerRecoveryAction, type WorkerRecoveryReceipt } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { appendEvent, loadRun } from "./event-store.js";
import { makeRuntimeError } from "./errors.js";
import { makeRunPaths, type RunPaths } from "./paths.js";
import { withRunStoreLock } from "./run-store-lock.js";

export type WorkerRecoveryThreadStatus = "active" | "idle" | "notLoaded" | "systemError" | "unknown";
export type WorkerRecoveryThreadState = { readonly status: WorkerRecoveryThreadStatus; readonly threadId: string };

export type WorkerRecoveryProvider = {
  readonly listModels: () => Effect.Effect<ReadonlyArray<{ readonly hidden: boolean; readonly id: string }>, unknown>;
  readonly readThread: (threadId: string) => Effect.Effect<WorkerRecoveryThreadState, unknown>;
  readonly resumeThread: (threadId: string) => Effect.Effect<WorkerRecoveryThreadState, unknown>;
  readonly startTurn: (input: { readonly model: string; readonly threadId: string }) => Effect.Effect<{ readonly turnId: string }, unknown>;
};

export type WorkerRecoveryWorkspaceValidation = void | {
  readonly trackedPayloadDigest: string;
  readonly trackedPayloadEntryCount: number;
};

type TrackedPayloadBinding = {
  readonly trackedPayloadDigest: string;
  readonly trackedPayloadEntryCount: number;
};

const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)));
const PrivateWorkerRecoveryTurn = Schema.Struct({
  actionId: Schema.NonEmptyString,
  expectedFailureSequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  expectedSessionId: Schema.NonEmptyString,
  harnessProfileId: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  payloadDigest: Digest,
  turnId: Schema.NonEmptyString,
  version: Schema.Literal(2),
});
const PrivateWorkerCorrelationFollowUpTurn = Schema.Struct({ turnId: Schema.NonEmptyString, version: Schema.Literal(1) });
type WorkerRecoveryCheckpointBinding = Pick<WorkerRecoveryReceipt, "actionId" | "expectedFailureSequence" | "expectedSessionId" | "harnessProfileId" | "model" | "payloadDigest">;

export function recoverWorkerSession(runId: RunId, action: WorkerRecoveryAction, input: {
  readonly appendRecoveryEvent?: typeof appendEvent;
  readonly nativeThreadId: string;
  readonly provider: WorkerRecoveryProvider;
  readonly rootDirectory?: string;
  readonly validateWorkspace: (workspacePath: string, expectedHead: string) => Effect.Effect<WorkerRecoveryWorkspaceValidation, unknown, FileSystem.FileSystem | Path.Path>;
}) {
  return withRunStoreLock(input, Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, input);
    const recordReceipt = (receipt: WorkerRecoveryReceipt) => record(
      runId,
      paths,
      receipt,
      input.appendRecoveryEvent ?? appendEvent,
    );
    const loaded = yield* loadRun(paths);
    const payloadDigest = digest(action);
    const prior = latestReceiptForFailure(loaded.events, action.expectedFailureSequence);
    if (prior !== undefined && (prior.actionId !== action.actionId || prior.payloadDigest !== payloadDigest)) return yield* conflict("Another worker recovery action is already authoritative.");
    if (prior?.state === "dispatchAttempted") return yield* recordReceipt({ ...prior, code: "WorkerRecoveryOutcomeUnknown", message: "A prior dispatch has no durable native turn receipt.", state: "outcomeUnknown" });
    if (prior?.state === "dispatchConfirmed" || prior?.state === "failed" || prior?.state === "outcomeUnknown") return prior;
    if (prior === undefined && hasUnresolvedEarlierGeneration(loaded.events, action.expectedFailureSequence)) return yield* conflict("A prior worker recovery generation is not terminal.");
    assertEligible(loaded.events, action, payloadDigest);
    const accepted = loaded.events[0]?.payload["delivery"] as { baseRevision?: unknown } | undefined;
    const expectedHead = typeof accepted?.baseRevision === "string" ? accepted.baseRevision : undefined;
    if (expectedHead === undefined) return yield* conflict("Accepted delivery base is unavailable.");
    const initialValidation = prior === undefined
      ? yield* Effect.exit(input.validateWorkspace(paths.workspace, expectedHead))
      : undefined;
    if (prior === undefined) {
      if (initialValidation?._tag === "Failure") return yield* conflict("Retained delivery worktree identity changed.");
    }
    const expectedTrackedPayload = prior === undefined
      ? initialValidation?._tag === "Success"
        ? trackedPayloadFromValidation(initialValidation.value)
        : undefined
      : trackedPayloadFromReceipt(prior);
    const models = yield* input.provider.listModels().pipe(Effect.mapError(() => failure("WorkerRecoveryModelCatalogUnavailable", "Codex model catalog is unavailable.")));
    if (!models.some((model) => model.id === action.model && !model.hidden)) return yield* failure("WorkerRecoveryModelUnavailable", "The explicitly selected Codex model is unavailable.");
    const base = { ...action, attempt: 1 as const, maxAttempts: 1 as const, payloadDigest, ...trackedPayloadReceiptFields(expectedTrackedPayload) };
    if (prior === undefined) {
      yield* recordReceipt({ ...base, state: "intentRecorded" }).pipe(
        Effect.mapError(() => failure("WorkerRecoveryIntentPersistenceFailed", "Worker recovery intent could not be persisted.")),
      );
    }
    const preflight = yield* Effect.exit(Effect.gen(function* () {
      yield* validateTrackedWorkspace(input, paths.workspace, expectedHead, expectedTrackedPayload);
      const resumed = yield* input.provider.resumeThread(input.nativeThreadId);
      const read = yield* input.provider.readThread(input.nativeThreadId);
      if (!isSafeRecoveryThreadState(input.nativeThreadId, resumed) || !isSafeRecoveryThreadState(input.nativeThreadId, read)) return yield* Effect.fail(new Error("thread mismatch"));
      yield* validateTrackedWorkspace(input, paths.workspace, expectedHead, expectedTrackedPayload);
    }));
    if (preflight._tag === "Failure") return yield* recordReceipt({ ...base, code: "WorkerRecoveryPreflightFailed", message: "Worker recovery preflight failed conclusively.", state: "failed" });
    if (prior?.state !== "preflightConfirmed") yield* recordReceipt({ ...base, state: "preflightConfirmed" });
    yield* recordReceipt({ ...base, state: "dispatchAttempted" });
    const started = yield* Effect.exit(input.provider.startTurn({ model: action.model, threadId: input.nativeThreadId }));
    if (started._tag === "Failure") {
      return yield* recordReceipt({ ...base, code: "WorkerRecoveryOutcomeUnknown", message: "Codex turn dispatch outcome is unknown.", state: "outcomeUnknown" });
    }
    const checkpoint = yield* writePrivateTurnCheckpoint(paths.root, started.value.turnId, base).pipe(Effect.exit);
    if (checkpoint._tag === "Failure") return yield* recordReceipt({ ...base, code: "WorkerRecoveryOutcomeUnknown", message: "Codex returned a turn but its private receipt was not durable.", state: "outcomeUnknown" });
    return yield* recordReceipt({ ...base, nativeTurnIdDigest: digest(started.value.turnId), state: "dispatchConfirmed" });
  }));
}

function isSafeRecoveryThreadState(expectedThreadId: string, state: WorkerRecoveryThreadState) {
  return state.threadId === expectedThreadId && (state.status === "idle" || state.status === "notLoaded" || state.status === "systemError");
}

function assertEligible(events: ReadonlyArray<{ readonly payload: Record<string, unknown>; readonly sequence: number; readonly type: string }>, action: WorkerRecoveryAction, payloadDigest: string) {
  const failure = events.find((event) => event.sequence === action.expectedFailureSequence);
  const failureIndex = events.findIndex((event) => event.sequence === action.expectedFailureSequence);
  const session = failureIndex > 0 ? events[failureIndex - 1] : undefined;
  const harness = session === undefined ? undefined : parseHarnessEvent(session.payload["event"]);
  const createdExecution = events[0]?.payload["execution"] as { selection?: { harnessProfileId?: unknown } } | undefined;
  const suffix = failureIndex < 0 ? [] : events.slice(failureIndex + 1);
  const suffixIsSameRecoveryGeneration = suffix.every((event) => isSameRecoveryGenerationReceipt(event, action, payloadDigest));
  if (!suffixIsSameRecoveryGeneration || failure?.type !== "RUN_FAILED" || failure.sequence !== action.expectedFailureSequence || failure.payload["recoverable"] !== true || failure.payload["stage"] !== "runningWorker" || session?.type !== "HARNESS_SESSION_EVENT_RECORDED" || harness?.kind !== "sessionFailed" || harness.failure.kind !== "providerFailure" || !harness.failure.recoverable || harness.sessionId !== action.expectedSessionId || createdExecution?.selection?.harnessProfileId !== action.harnessProfileId) throw makeRuntimeError({ code: "DeliveryActionConflict", message: "Run is not eligible for worker recovery.", recoverable: false });
}

function isSameRecoveryGenerationReceipt(
  event: { readonly payload: Record<string, unknown>; readonly type: string },
  action: WorkerRecoveryAction,
  payloadDigest: string,
) {
  if (event.type !== "WORKER_RECOVERY_RECORDED") return false;
  const receipt = parseWorkerRecoveryReceipt(event.payload["recovery"]);
  return receipt.actionId === action.actionId &&
    receipt.expectedFailureSequence === action.expectedFailureSequence &&
    receipt.payloadDigest === payloadDigest;
}

function latestReceiptForFailure(events: ReadonlyArray<{ readonly payload: Record<string, unknown>; readonly type: string }>, expectedFailureSequence: number) {
  const event = [...events].reverse().find(({ payload, type }) => {
    if (type !== "WORKER_RECOVERY_RECORDED") return false;
    const receipt = parseWorkerRecoveryReceipt(payload["recovery"]);
    return receipt.expectedFailureSequence === expectedFailureSequence;
  });
  return event === undefined ? undefined : parseWorkerRecoveryReceipt(event.payload["recovery"]);
}
function hasUnresolvedEarlierGeneration(events: ReadonlyArray<{ readonly payload: Record<string, unknown>; readonly type: string }>, expectedFailureSequence: number) {
  const latestByFailure = new Map<number, WorkerRecoveryReceipt>();
  for (const event of events) {
    if (event.type !== "WORKER_RECOVERY_RECORDED") continue;
    const receipt = parseWorkerRecoveryReceipt(event.payload["recovery"]);
    latestByFailure.set(receipt.expectedFailureSequence, receipt);
  }
  return [...latestByFailure.values()].some((receipt) => receipt.expectedFailureSequence < expectedFailureSequence && !isRecoveryGenerationTerminal(receipt));
}
function isRecoveryGenerationTerminal(receipt: WorkerRecoveryReceipt) {
  return receipt.state === "dispatchConfirmed" || receipt.state === "failed" || receipt.state === "outcomeUnknown";
}
function digest(value: unknown) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function conflict(message: string) { return Effect.fail(makeRuntimeError({ code: "DeliveryActionConflict", message, recoverable: false })); }
function failure(code: string, message: string) { return makeRuntimeError({ code, message, recoverable: false }); }
function trackedPayloadFromReceipt(receipt: WorkerRecoveryReceipt): TrackedPayloadBinding | undefined {
  if (receipt.trackedPayloadDigest === undefined && receipt.trackedPayloadEntryCount === undefined) return undefined;
  if (receipt.trackedPayloadDigest === undefined || receipt.trackedPayloadEntryCount === undefined) return undefined;
  return {
    trackedPayloadDigest: receipt.trackedPayloadDigest,
    trackedPayloadEntryCount: receipt.trackedPayloadEntryCount,
  };
}
function trackedPayloadFromValidation(validation: WorkerRecoveryWorkspaceValidation | undefined): TrackedPayloadBinding | undefined {
  if (validation === undefined) return undefined;
  if (typeof validation !== "object") return undefined;
  if (!/^[a-f0-9]{64}$/u.test(validation.trackedPayloadDigest) || !Number.isSafeInteger(validation.trackedPayloadEntryCount) || validation.trackedPayloadEntryCount < 0) return undefined;
  return {
    trackedPayloadDigest: validation.trackedPayloadDigest,
    trackedPayloadEntryCount: validation.trackedPayloadEntryCount,
  };
}
function trackedPayloadReceiptFields(binding: TrackedPayloadBinding | undefined) {
  return binding === undefined
    ? {}
    : {
      trackedPayloadDigest: binding.trackedPayloadDigest,
      trackedPayloadEntryCount: binding.trackedPayloadEntryCount,
    };
}
function validateTrackedWorkspace(input: {
  readonly validateWorkspace: (workspacePath: string, expectedHead: string) => Effect.Effect<WorkerRecoveryWorkspaceValidation, unknown, FileSystem.FileSystem | Path.Path>;
}, workspacePath: string, expectedHead: string, expected: TrackedPayloadBinding | undefined) {
  return Effect.gen(function* () {
    const actual = trackedPayloadFromValidation(yield* input.validateWorkspace(workspacePath, expectedHead));
    if (!sameTrackedPayloadBinding(actual, expected)) return yield* Effect.fail(new Error("tracked payload drift"));
  });
}
function sameTrackedPayloadBinding(left: TrackedPayloadBinding | undefined, right: TrackedPayloadBinding | undefined) {
  if (left === undefined || right === undefined) return left === right;
  return left.trackedPayloadDigest === right.trackedPayloadDigest &&
    left.trackedPayloadEntryCount === right.trackedPayloadEntryCount;
}
function record(runId: RunId, paths: RunPaths, receipt: WorkerRecoveryReceipt, appendRecoveryEvent: typeof appendEvent) {
  return appendRecoveryEvent(runId, paths, { payload: { recovery: encodeWorkerRecoveryReceiptJson(receipt) }, type: "WORKER_RECOVERY_RECORDED" }).pipe(Effect.as(receipt));
}
function writePrivateTurnCheckpoint(runRoot: string, turnId: string, binding: WorkerRecoveryCheckpointBinding) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(runRoot, ".worker-recovery-turn.json"), JSON.stringify({ ...binding, turnId, version: 2 }));
  });
}

export function readPrivateWorkerRecoveryTurn(runRoot: string, expectedDigest: string, binding: WorkerRecoveryCheckpointBinding) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs.readFileString(path.join(runRoot, ".worker-recovery-turn.json"));
    const checkpoint = yield* Schema.decodeUnknownEffect(PrivateWorkerRecoveryTurn)(JSON.parse(raw));
    if (digest(checkpoint.turnId) !== expectedDigest) return yield* Effect.fail(new Error("Worker recovery turn checkpoint digest mismatch."));
    if (checkpoint.actionId !== binding.actionId || checkpoint.expectedFailureSequence !== binding.expectedFailureSequence || checkpoint.expectedSessionId !== binding.expectedSessionId || checkpoint.harnessProfileId !== binding.harnessProfileId || checkpoint.model !== binding.model || checkpoint.payloadDigest !== binding.payloadDigest) return yield* Effect.fail(new Error("Worker recovery turn checkpoint binding mismatch."));
    return checkpoint.turnId;
  }).pipe(Effect.mapError((cause) => makeRuntimeError({ cause, code: "WorkerRecoveryTurnCheckpointInvalid", message: "The exact recovered native turn checkpoint is missing or invalid.", recoverable: false })));
}

export function writePrivateWorkerCorrelationFollowUpTurn(runRoot: string, turnId: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(runRoot, ".worker-correlation-follow-up-turn.json"), JSON.stringify({ turnId, version: 1 }));
  }).pipe(Effect.mapError((cause) => makeRuntimeError({ cause, code: "WorkerCorrelationFollowUpCheckpointInvalid", message: "The accepted worker correlation follow-up checkpoint could not be persisted.", recoverable: false })));
}

export function readPrivateWorkerCorrelationFollowUpTurn(runRoot: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs.readFileString(path.join(runRoot, ".worker-correlation-follow-up-turn.json"));
    const checkpoint = yield* Schema.decodeUnknownEffect(PrivateWorkerCorrelationFollowUpTurn)(JSON.parse(raw));
    return checkpoint.turnId;
  }).pipe(Effect.mapError((cause) => makeRuntimeError({ cause, code: "WorkerCorrelationFollowUpCheckpointInvalid", message: "The accepted worker correlation follow-up checkpoint is missing or invalid.", recoverable: false })));
}
