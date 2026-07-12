import { createHash } from "node:crypto";
import { parseHarnessEvent, parseRunId, parseWorkerRecoveryReceipt, encodeWorkerRecoveryReceiptJson, type WorkerRecoveryAction, type WorkerRecoveryReceipt } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { appendEvent, loadRun } from "./event-store.js";
import { makeRuntimeError } from "./errors.js";
import { makeRunPaths, type RunPaths } from "./paths.js";
import { withRunStoreLock } from "./run-store-lock.js";

export type WorkerRecoveryProvider = {
  readonly listModels: () => Effect.Effect<ReadonlyArray<{ readonly hidden: boolean; readonly id: string }>, unknown>;
  readonly readThread: (threadId: string) => Effect.Effect<{ readonly active: boolean; readonly systemError: boolean; readonly threadId: string }, unknown>;
  readonly resumeThread: (threadId: string) => Effect.Effect<{ readonly threadId: string }, unknown>;
  readonly startTurn: (input: { readonly model: string; readonly threadId: string }) => Effect.Effect<{ readonly turnId: string }, unknown>;
};

const PrivateWorkerRecoveryTurn = Schema.Struct({ turnId: Schema.NonEmptyString, version: Schema.Literal(1) });

export function recoverWorkerSession(runIdInput: string, action: WorkerRecoveryAction, input: {
  readonly appendRecoveryEvent?: typeof appendEvent;
  readonly nativeThreadId: string;
  readonly provider: WorkerRecoveryProvider;
  readonly rootDirectory?: string;
  readonly validateWorkspace: (workspacePath: string, expectedHead: string) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;
}) {
  return withRunStoreLock(input, Effect.gen(function* () {
    const runId = parseRunId(runIdInput);
    const paths = yield* makeRunPaths(runId, input);
    const recordReceipt = (receipt: WorkerRecoveryReceipt) => record(
      runId,
      paths,
      receipt,
      input.appendRecoveryEvent ?? appendEvent,
    );
    const loaded = yield* loadRun(paths);
    const prior = latestReceipt(loaded.events);
    const payloadDigest = digest(action);
    if (prior !== undefined && (prior.actionId !== action.actionId || prior.payloadDigest !== payloadDigest)) return yield* conflict("Another worker recovery action is already authoritative.");
    if (prior?.state === "dispatchAttempted") return yield* recordReceipt({ ...prior, code: "WorkerRecoveryOutcomeUnknown", message: "A prior dispatch has no durable native turn receipt.", state: "outcomeUnknown" });
    if (prior?.state === "dispatchConfirmed" || prior?.state === "failed" || prior?.state === "outcomeUnknown") return prior;
    assertEligible(loaded.events, action);
    const accepted = loaded.events[0]?.payload["delivery"] as { baseRevision?: unknown } | undefined;
    const expectedHead = typeof accepted?.baseRevision === "string" ? accepted.baseRevision : undefined;
    if (expectedHead === undefined) return yield* conflict("Accepted delivery base is unavailable.");
    if (prior === undefined) {
      const identity = yield* Effect.exit(input.validateWorkspace(paths.workspace, expectedHead));
      if (identity._tag === "Failure") return yield* conflict("Retained delivery worktree identity changed.");
    }
    const models = yield* input.provider.listModels().pipe(Effect.mapError(() => failure("WorkerRecoveryModelCatalogUnavailable", "Codex model catalog is unavailable.")));
    if (!models.some((model) => model.id === action.model && !model.hidden)) return yield* failure("WorkerRecoveryModelUnavailable", "The explicitly selected Codex model is unavailable.");
    const base = { ...action, attempt: 1 as const, maxAttempts: 1 as const, payloadDigest };
    if (prior === undefined) {
      yield* recordReceipt({ ...base, state: "intentRecorded" }).pipe(
        Effect.mapError(() => failure("WorkerRecoveryIntentPersistenceFailed", "Worker recovery intent could not be persisted.")),
      );
    }
    const preflight = yield* Effect.exit(Effect.gen(function* () {
      yield* input.validateWorkspace(paths.workspace, expectedHead);
      const resumed = yield* input.provider.resumeThread(input.nativeThreadId);
      const read = yield* input.provider.readThread(input.nativeThreadId);
      if (resumed.threadId !== input.nativeThreadId || read.threadId !== input.nativeThreadId || read.active || !read.systemError) return yield* Effect.fail(new Error("thread mismatch"));
      yield* input.validateWorkspace(paths.workspace, expectedHead);
    }));
    if (preflight._tag === "Failure") return yield* recordReceipt({ ...base, code: "WorkerRecoveryPreflightFailed", message: "Worker recovery preflight failed conclusively.", state: "failed" });
    if (prior?.state !== "preflightConfirmed") yield* recordReceipt({ ...base, state: "preflightConfirmed" });
    yield* recordReceipt({ ...base, state: "dispatchAttempted" });
    const started = yield* Effect.exit(input.provider.startTurn({ model: action.model, threadId: input.nativeThreadId }));
    if (started._tag === "Failure") {
      return yield* recordReceipt({ ...base, code: "WorkerRecoveryOutcomeUnknown", message: "Codex turn dispatch outcome is unknown.", state: "outcomeUnknown" });
    }
    const checkpoint = yield* writePrivateTurnCheckpoint(paths.root, started.value.turnId).pipe(Effect.exit);
    if (checkpoint._tag === "Failure") return yield* recordReceipt({ ...base, code: "WorkerRecoveryOutcomeUnknown", message: "Codex returned a turn but its private receipt was not durable.", state: "outcomeUnknown" });
    return yield* recordReceipt({ ...base, nativeTurnIdDigest: digest(started.value.turnId), state: "dispatchConfirmed" });
  }));
}

function assertEligible(events: ReadonlyArray<{ readonly payload: Record<string, unknown>; readonly sequence: number; readonly type: string }>, action: WorkerRecoveryAction) {
  const failure = events.find((event) => event.sequence === action.expectedFailureSequence);
  const failureIndex = events.findIndex((event) => event.sequence === action.expectedFailureSequence);
  const session = failureIndex > 0 ? events[failureIndex - 1] : undefined;
  const harness = session === undefined ? undefined : parseHarnessEvent(session.payload["event"]);
  const createdExecution = events[0]?.payload["execution"] as { selection?: { harnessProfileId?: unknown } } | undefined;
  if (failureIndex !== events.length - 1 || failure?.type !== "RUN_FAILED" || failure.sequence !== action.expectedFailureSequence || failure.payload["recoverable"] !== true || failure.payload["stage"] !== "runningWorker" || session?.type !== "HARNESS_SESSION_EVENT_RECORDED" || harness?.kind !== "sessionFailed" || harness.failure.kind !== "providerFailure" || !harness.failure.recoverable || harness.sessionId !== action.expectedSessionId || createdExecution?.selection?.harnessProfileId !== action.harnessProfileId) throw makeRuntimeError({ code: "DeliveryActionConflict", message: "Run is not eligible for worker recovery.", recoverable: false });
}

function latestReceipt(events: ReadonlyArray<{ readonly payload: Record<string, unknown>; readonly type: string }>) {
  const event = [...events].reverse().find(({ type }) => type === "WORKER_RECOVERY_RECORDED");
  return event === undefined ? undefined : parseWorkerRecoveryReceipt(event.payload["recovery"]);
}
function digest(value: unknown) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function conflict(message: string) { return Effect.fail(makeRuntimeError({ code: "DeliveryActionConflict", message, recoverable: false })); }
function failure(code: string, message: string) { return makeRuntimeError({ code, message, recoverable: false }); }
function record(runId: ReturnType<typeof parseRunId>, paths: RunPaths, receipt: WorkerRecoveryReceipt, appendRecoveryEvent: typeof appendEvent) {
  return appendRecoveryEvent(runId, paths, { payload: { recovery: encodeWorkerRecoveryReceiptJson(receipt) }, type: "WORKER_RECOVERY_RECORDED" }).pipe(Effect.as(receipt));
}
function writePrivateTurnCheckpoint(runRoot: string, turnId: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(runRoot, ".worker-recovery-turn.json"), JSON.stringify({ turnId, version: 1 }));
  });
}

export function readPrivateWorkerRecoveryTurn(runRoot: string, expectedDigest: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs.readFileString(path.join(runRoot, ".worker-recovery-turn.json"));
    const checkpoint = yield* Schema.decodeUnknownEffect(PrivateWorkerRecoveryTurn)(JSON.parse(raw));
    if (digest(checkpoint.turnId) !== expectedDigest) return yield* Effect.fail(new Error("Worker recovery turn checkpoint digest mismatch."));
    return checkpoint.turnId;
  }).pipe(Effect.mapError((cause) => makeRuntimeError({ cause, code: "WorkerRecoveryTurnCheckpointInvalid", message: "The exact recovered native turn checkpoint is missing or invalid.", recoverable: false })));
}
