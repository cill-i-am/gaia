import { createHash } from "node:crypto";

import {
  parseHarnessEvent,
  parseWorkerRecoveryDigest,
  parseWorkerRecoveryReceipt,
  DeliveryGitShaPublicSchema,
  encodeWorkerRecoveryReceiptJson,
  HarnessExecutionSelection,
  HarnessProfileIdSchema,
  HarnessSessionIdSchema,
  type RunEvent,
  type RunId,
  type WorkerRecoveryAction,
  type WorkerRecoveryDigest,
  WorkerRecoveryActionIdSchema,
  WorkerRecoveryDigestSchema,
  WorkerRecoveryModelIdSchema,
  type WorkerRecoveryReceipt,
} from "@gaia/core";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { makeRuntimeError } from "./errors.js";
import { appendEvent, loadRun } from "./event-store.js";
import {
  HarnessCheckpointTokenSchema,
  type HarnessCheckpointToken,
} from "./harness-session.js";
import { makeRunPaths, type RunPaths } from "./paths.js";
import { withRunStoreLock } from "./run-store-lock.js";

export const WorkerRecoveryThreadStatusSchema = Schema.Literals([
  "active",
  "idle",
  "notLoaded",
  "systemError",
  "unknown",
] as const);
export type WorkerRecoveryThreadStatus =
  typeof WorkerRecoveryThreadStatusSchema.Type;

export class WorkerRecoveryThreadState extends Schema.Class<WorkerRecoveryThreadState>(
  "WorkerRecoveryThreadState"
)(
  { status: WorkerRecoveryThreadStatusSchema },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class WorkerRecoveryModel extends Schema.Class<WorkerRecoveryModel>(
  "WorkerRecoveryModel"
)(
  { hidden: Schema.Boolean, id: WorkerRecoveryModelIdSchema },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export const WorkerRecoveryModelCatalogSchema =
  Schema.Array(WorkerRecoveryModel);
export type WorkerRecoveryModelCatalog =
  typeof WorkerRecoveryModelCatalogSchema.Type;

export class WorkerRecoveryStartTurn extends Schema.Class<WorkerRecoveryStartTurn>(
  "WorkerRecoveryStartTurn"
)(
  { model: WorkerRecoveryModelIdSchema },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class WorkerRecoveryTurnStarted extends Schema.Class<WorkerRecoveryTurnStarted>(
  "WorkerRecoveryTurnStarted"
)(
  {
    checkpoint: HarnessCheckpointTokenSchema,
    nativeTurnIdDigest: WorkerRecoveryDigestSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class WorkerRecoveryProviderError extends Schema.TaggedErrorClass<WorkerRecoveryProviderError>()(
  "WorkerRecoveryProviderError",
  {
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    operation: Schema.Literals([
      "listModels",
      "readThread",
      "resumeThread",
      "startTurn",
    ] as const),
  }
) {}

export type WorkerRecoveryProvider = {
  readonly listModels: () => Effect.Effect<
    WorkerRecoveryModelCatalog,
    WorkerRecoveryProviderError
  >;
  readonly readThread: () => Effect.Effect<
    WorkerRecoveryThreadState,
    WorkerRecoveryProviderError
  >;
  readonly resumeThread: () => Effect.Effect<
    WorkerRecoveryThreadState,
    WorkerRecoveryProviderError
  >;
  readonly startTurn: (
    input: WorkerRecoveryStartTurn
  ) => Effect.Effect<WorkerRecoveryTurnStarted, WorkerRecoveryProviderError>;
};

export class WorkerRecoveryWorkspaceValidation extends Schema.Class<WorkerRecoveryWorkspaceValidation>(
  "WorkerRecoveryWorkspaceValidation"
)(
  {
    trackedPayloadDigest: WorkerRecoveryDigestSchema,
    trackedPayloadEntryCount: Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(0))
    ),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}
export class WorkerRecoveryWorkspaceValidationError extends Schema.TaggedErrorClass<WorkerRecoveryWorkspaceValidationError>()(
  "WorkerRecoveryWorkspaceValidationError",
  {
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    operation: Schema.Literal("validateWorkspace"),
  }
) {}
export const WorkerRecoveryWorkspaceValidationResultSchema = Schema.Union([
  Schema.Void,
  WorkerRecoveryWorkspaceValidation,
]);
export type WorkerRecoveryWorkspaceValidationResult =
  typeof WorkerRecoveryWorkspaceValidationResultSchema.Type;

/** Serializable run-storage configuration for worker recovery. */
export class WorkerRecoveryConfig extends Schema.Class<WorkerRecoveryConfig>(
  "WorkerRecoveryConfig"
)(
  { rootDirectory: Schema.optionalKey(Schema.NonEmptyString) },
  { parseOptions: { onExcessProperty: "error" } }
) {}

const decodeWorkerRecoveryConfig =
  Schema.decodeUnknownSync(WorkerRecoveryConfig);
const AcceptedWorkerRecoveryExecutionSchema = Schema.Struct({
  selection: HarnessExecutionSelection,
});
const AcceptedWorkerRecoveryDeliverySchema = Schema.Struct({
  baseRevision: DeliveryGitShaPublicSchema,
});
const decodeAcceptedWorkerRecoveryExecution = Schema.decodeUnknownOption(
  AcceptedWorkerRecoveryExecutionSchema
);
const decodeAcceptedWorkerRecoveryDelivery = Schema.decodeUnknownOption(
  AcceptedWorkerRecoveryDeliverySchema
);

type TrackedPayloadBinding = WorkerRecoveryWorkspaceValidation;

class PrivateWorkerRecoveryCheckpoint extends Schema.Class<PrivateWorkerRecoveryCheckpoint>(
  "PrivateWorkerRecoveryCheckpoint"
)(
  {
    actionId: WorkerRecoveryActionIdSchema,
    checkpoint: HarnessCheckpointTokenSchema,
    expectedFailureSequence: Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(1))
    ),
    expectedSessionId: HarnessSessionIdSchema,
    harnessProfileId: HarnessProfileIdSchema,
    model: WorkerRecoveryModelIdSchema,
    nativeTurnIdDigest: WorkerRecoveryDigestSchema,
    payloadDigest: WorkerRecoveryDigestSchema,
    version: Schema.Literal(3),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}
class PrivateWorkerCorrelationFollowUpTurn extends Schema.Class<PrivateWorkerCorrelationFollowUpTurn>(
  "PrivateWorkerCorrelationFollowUpTurn"
)(
  {
    checkpoint: HarnessCheckpointTokenSchema,
    version: Schema.Literal(2),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}
const PrivateWorkerRecoveryCheckpointJson = Schema.toCodecJson(
  PrivateWorkerRecoveryCheckpoint
);
const PrivateWorkerCorrelationFollowUpTurnJson = Schema.toCodecJson(
  PrivateWorkerCorrelationFollowUpTurn
);
const encodePrivateWorkerRecoveryCheckpoint = Schema.encodeSync(
  PrivateWorkerRecoveryCheckpointJson
);
const encodePrivateWorkerCorrelationFollowUpTurn = Schema.encodeSync(
  PrivateWorkerCorrelationFollowUpTurnJson
);
type WorkerRecoveryCheckpointBinding = Pick<
  WorkerRecoveryReceipt,
  | "actionId"
  | "expectedFailureSequence"
  | "expectedSessionId"
  | "harnessProfileId"
  | "model"
  | "payloadDigest"
>;

export function recoverWorkerSession(
  runId: RunId,
  action: WorkerRecoveryAction,
  input: WorkerRecoveryConfig & {
    readonly appendRecoveryEvent?: typeof appendEvent;
    readonly provider: WorkerRecoveryProvider;
    readonly validateWorkspace: (
      workspacePath: string,
      expectedHead: string
    ) => Effect.Effect<
      WorkerRecoveryWorkspaceValidationResult,
      WorkerRecoveryWorkspaceValidationError,
      FileSystem.FileSystem | Path.Path
    >;
  }
) {
  const config = decodeWorkerRecoveryConfig({
    rootDirectory: input.rootDirectory,
  });
  return withRunStoreLock(
    config,
    Effect.gen(function* () {
      const paths = yield* makeRunPaths(runId, config);
      const recordReceipt = (receipt: WorkerRecoveryReceipt) =>
        record(runId, paths, receipt, input.appendRecoveryEvent ?? appendEvent);
      const loaded = yield* loadRun(paths);
      const payloadDigest = digest(action);
      const prior = latestReceiptForFailure(
        loaded.events,
        action.expectedFailureSequence
      );
      if (
        prior !== undefined &&
        (prior.actionId !== action.actionId ||
          prior.payloadDigest !== payloadDigest)
      )
        return yield* conflict(
          "Another worker recovery action is already authoritative."
        );
      if (prior?.state === "dispatchAttempted")
        return yield* recordReceipt({
          ...prior,
          code: "WorkerRecoveryOutcomeUnknown",
          message: "A prior dispatch has no durable native turn receipt.",
          state: "outcomeUnknown",
        });
      if (
        prior?.state === "dispatchConfirmed" ||
        prior?.state === "failed" ||
        prior?.state === "outcomeUnknown"
      )
        return prior;
      if (
        prior === undefined &&
        hasUnresolvedEarlierGeneration(
          loaded.events,
          action.expectedFailureSequence
        )
      )
        return yield* conflict(
          "A prior worker recovery generation is not terminal."
        );
      assertEligible(loaded.events, action, payloadDigest);
      const accepted = decodeAcceptedWorkerRecoveryDelivery(
        loaded.events[0]?.payload["delivery"]
      );
      const expectedHead = Option.getOrUndefined(accepted)?.baseRevision;
      if (expectedHead === undefined)
        return yield* conflict("Accepted delivery base is unavailable.");
      const initialValidation =
        prior === undefined
          ? yield* Effect.exit(
              input.validateWorkspace(paths.workspace, expectedHead)
            )
          : undefined;
      if (prior === undefined) {
        if (initialValidation?._tag === "Failure")
          return yield* conflict(
            "Retained delivery worktree identity changed."
          );
      }
      const expectedTrackedPayload =
        prior === undefined
          ? initialValidation?._tag === "Success"
            ? trackedPayloadFromValidation(initialValidation.value)
            : undefined
          : trackedPayloadFromReceipt(prior);
      const models = yield* input.provider
        .listModels()
        .pipe(
          Effect.mapError(() =>
            failure(
              "WorkerRecoveryModelCatalogUnavailable",
              "Codex model catalog is unavailable."
            )
          )
        );
      if (!models.some((model) => model.id === action.model && !model.hidden))
        return yield* failure(
          "WorkerRecoveryModelUnavailable",
          "The explicitly selected Codex model is unavailable."
        );
      const base = {
        ...action,
        attempt: 1 as const,
        maxAttempts: 1 as const,
        payloadDigest,
        ...trackedPayloadReceiptFields(expectedTrackedPayload),
      };
      if (prior === undefined) {
        yield* recordReceipt({ ...base, state: "intentRecorded" }).pipe(
          Effect.mapError(() =>
            failure(
              "WorkerRecoveryIntentPersistenceFailed",
              "Worker recovery intent could not be persisted."
            )
          )
        );
      }
      const preflight = yield* Effect.exit(
        Effect.gen(function* () {
          yield* validateTrackedWorkspace(
            input,
            paths.workspace,
            expectedHead,
            expectedTrackedPayload
          );
          const resumed = yield* input.provider.resumeThread();
          const read = yield* input.provider.readThread();
          if (
            !isSafeRecoveryThreadState(resumed) ||
            !isSafeRecoveryThreadState(read)
          )
            return yield* Effect.fail(new Error("thread mismatch"));
          yield* validateTrackedWorkspace(
            input,
            paths.workspace,
            expectedHead,
            expectedTrackedPayload
          );
        })
      );
      if (preflight._tag === "Failure")
        return yield* recordReceipt({
          ...base,
          code: "WorkerRecoveryPreflightFailed",
          message: "Worker recovery preflight failed conclusively.",
          state: "failed",
        });
      if (prior?.state !== "preflightConfirmed")
        yield* recordReceipt({ ...base, state: "preflightConfirmed" });
      yield* recordReceipt({ ...base, state: "dispatchAttempted" });
      const started = yield* Effect.exit(
        input.provider.startTurn(
          WorkerRecoveryStartTurn.make({ model: action.model })
        )
      );
      if (started._tag === "Failure") {
        return yield* recordReceipt({
          ...base,
          code: "WorkerRecoveryOutcomeUnknown",
          message: "Codex turn dispatch outcome is unknown.",
          state: "outcomeUnknown",
        });
      }
      const checkpoint = yield* writePrivateTurnCheckpoint(
        paths.root,
        started.value,
        base
      ).pipe(Effect.exit);
      if (checkpoint._tag === "Failure")
        return yield* recordReceipt({
          ...base,
          code: "WorkerRecoveryOutcomeUnknown",
          message:
            "Codex returned a turn but its private receipt was not durable.",
          state: "outcomeUnknown",
        });
      return yield* recordReceipt({
        ...base,
        nativeTurnIdDigest: started.value.nativeTurnIdDigest,
        state: "dispatchConfirmed",
      });
    })
  );
}

function isSafeRecoveryThreadState(state: WorkerRecoveryThreadState) {
  return (
    state.status === "idle" ||
    state.status === "notLoaded" ||
    state.status === "systemError"
  );
}

function assertEligible(
  events: ReadonlyArray<RunEvent>,
  action: WorkerRecoveryAction,
  payloadDigest: WorkerRecoveryDigest
) {
  const failure = events.find(
    (event) => event.sequence === action.expectedFailureSequence
  );
  const failureIndex = events.findIndex(
    (event) => event.sequence === action.expectedFailureSequence
  );
  const session = failureIndex > 0 ? events[failureIndex - 1] : undefined;
  const harness =
    session === undefined
      ? undefined
      : parseHarnessEvent(session.payload["event"]);
  const createdExecution = decodeAcceptedWorkerRecoveryExecution(
    events[0]?.payload["execution"]
  );
  const suffix = failureIndex < 0 ? [] : events.slice(failureIndex + 1);
  const suffixIsSameRecoveryGeneration = suffix.every((event) =>
    isSameRecoveryGenerationReceipt(event, action, payloadDigest)
  );
  if (
    !suffixIsSameRecoveryGeneration ||
    failure?.type !== "RUN_FAILED" ||
    failure.sequence !== action.expectedFailureSequence ||
    failure.payload["recoverable"] !== true ||
    failure.payload["stage"] !== "runningWorker" ||
    session?.type !== "HARNESS_SESSION_EVENT_RECORDED" ||
    harness?.kind !== "sessionFailed" ||
    harness.failure.kind !== "providerFailure" ||
    !harness.failure.recoverable ||
    harness.sessionId !== action.expectedSessionId ||
    Option.getOrUndefined(createdExecution)?.selection.harnessProfileId !==
      action.harnessProfileId
  )
    throw makeRuntimeError({
      code: "DeliveryActionConflict",
      message: "Run is not eligible for worker recovery.",
      recoverable: false,
    });
}

function isSameRecoveryGenerationReceipt(
  event: RunEvent,
  action: WorkerRecoveryAction,
  payloadDigest: WorkerRecoveryDigest
) {
  if (event.type !== "WORKER_RECOVERY_RECORDED") return false;
  const receipt = parseWorkerRecoveryReceipt(event.payload["recovery"]);
  return (
    receipt.actionId === action.actionId &&
    receipt.expectedFailureSequence === action.expectedFailureSequence &&
    receipt.payloadDigest === payloadDigest
  );
}

function latestReceiptForFailure(
  events: ReadonlyArray<RunEvent>,
  expectedFailureSequence: number
) {
  const event = [...events].reverse().find(({ payload, type }) => {
    if (type !== "WORKER_RECOVERY_RECORDED") return false;
    const receipt = parseWorkerRecoveryReceipt(payload["recovery"]);
    return receipt.expectedFailureSequence === expectedFailureSequence;
  });
  return event === undefined
    ? undefined
    : parseWorkerRecoveryReceipt(event.payload["recovery"]);
}
function hasUnresolvedEarlierGeneration(
  events: ReadonlyArray<RunEvent>,
  expectedFailureSequence: number
) {
  const latestByFailure = new Map<number, WorkerRecoveryReceipt>();
  for (const event of events) {
    if (event.type !== "WORKER_RECOVERY_RECORDED") continue;
    const receipt = parseWorkerRecoveryReceipt(event.payload["recovery"]);
    latestByFailure.set(receipt.expectedFailureSequence, receipt);
  }
  return [...latestByFailure.values()].some(
    (receipt) =>
      receipt.expectedFailureSequence < expectedFailureSequence &&
      !isRecoveryGenerationTerminal(receipt)
  );
}
function isRecoveryGenerationTerminal(receipt: WorkerRecoveryReceipt) {
  return (
    receipt.state === "dispatchConfirmed" ||
    receipt.state === "failed" ||
    receipt.state === "outcomeUnknown"
  );
}
function digest(value: unknown): WorkerRecoveryDigest {
  return parseWorkerRecoveryDigest(
    createHash("sha256")
      .update(typeof value === "string" ? value : JSON.stringify(value))
      .digest("hex")
  );
}
function conflict(message: string) {
  return Effect.fail(
    makeRuntimeError({
      code: "DeliveryActionConflict",
      message,
      recoverable: false,
    })
  );
}
function failure(code: string, message: string) {
  return makeRuntimeError({ code, message, recoverable: false });
}
function trackedPayloadFromReceipt(
  receipt: WorkerRecoveryReceipt
): TrackedPayloadBinding | undefined {
  if (
    receipt.trackedPayloadDigest === undefined &&
    receipt.trackedPayloadEntryCount === undefined
  )
    return undefined;
  if (
    receipt.trackedPayloadDigest === undefined ||
    receipt.trackedPayloadEntryCount === undefined
  )
    return undefined;
  return {
    trackedPayloadDigest: receipt.trackedPayloadDigest,
    trackedPayloadEntryCount: receipt.trackedPayloadEntryCount,
  };
}
function trackedPayloadFromValidation(
  validation: WorkerRecoveryWorkspaceValidationResult | undefined
): TrackedPayloadBinding | undefined {
  if (validation === undefined) return undefined;
  const decoded = Schema.decodeUnknownOption(WorkerRecoveryWorkspaceValidation)(
    validation
  );
  return Option.isNone(decoded) ? undefined : decoded.value;
}
function trackedPayloadReceiptFields(
  binding: TrackedPayloadBinding | undefined
) {
  return binding === undefined
    ? {}
    : {
        trackedPayloadDigest: binding.trackedPayloadDigest,
        trackedPayloadEntryCount: binding.trackedPayloadEntryCount,
      };
}
function validateTrackedWorkspace(
  input: {
    readonly validateWorkspace: (
      workspacePath: string,
      expectedHead: string
    ) => Effect.Effect<
      WorkerRecoveryWorkspaceValidationResult,
      WorkerRecoveryWorkspaceValidationError,
      FileSystem.FileSystem | Path.Path
    >;
  },
  workspacePath: string,
  expectedHead: string,
  expected: TrackedPayloadBinding | undefined
) {
  return Effect.gen(function* () {
    const actual = trackedPayloadFromValidation(
      yield* input.validateWorkspace(workspacePath, expectedHead)
    );
    if (!sameTrackedPayloadBinding(actual, expected))
      return yield* Effect.fail(new Error("tracked payload drift"));
  });
}
function sameTrackedPayloadBinding(
  left: TrackedPayloadBinding | undefined,
  right: TrackedPayloadBinding | undefined
) {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.trackedPayloadDigest === right.trackedPayloadDigest &&
    left.trackedPayloadEntryCount === right.trackedPayloadEntryCount
  );
}
function record(
  runId: RunId,
  paths: RunPaths,
  receipt: WorkerRecoveryReceipt,
  appendRecoveryEvent: typeof appendEvent
) {
  return appendRecoveryEvent(runId, paths, {
    payload: { recovery: encodeWorkerRecoveryReceiptJson(receipt) },
    type: "WORKER_RECOVERY_RECORDED",
  }).pipe(Effect.as(receipt));
}
function writePrivateTurnCheckpoint(
  runRoot: string,
  result: WorkerRecoveryTurnStarted,
  binding: WorkerRecoveryCheckpointBinding
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(runRoot, ".worker-recovery-turn.json"),
      JSON.stringify(
        encodePrivateWorkerRecoveryCheckpoint(
          PrivateWorkerRecoveryCheckpoint.make({
            ...binding,
            ...result,
            version: 3,
          })
        )
      )
    );
  });
}

export function readPrivateWorkerRecoveryCheckpoint(
  runRoot: string,
  expectedDigest: WorkerRecoveryDigest,
  binding: WorkerRecoveryCheckpointBinding
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs.readFileString(
      path.join(runRoot, ".worker-recovery-turn.json")
    );
    const checkpoint = yield* Schema.decodeUnknownEffect(
      PrivateWorkerRecoveryCheckpointJson
    )(JSON.parse(raw));
    if (checkpoint.nativeTurnIdDigest !== expectedDigest)
      return yield* Effect.fail(
        new Error("Worker recovery turn checkpoint digest mismatch.")
      );
    if (
      checkpoint.actionId !== binding.actionId ||
      checkpoint.expectedFailureSequence !== binding.expectedFailureSequence ||
      checkpoint.expectedSessionId !== binding.expectedSessionId ||
      checkpoint.harnessProfileId !== binding.harnessProfileId ||
      checkpoint.model !== binding.model ||
      checkpoint.payloadDigest !== binding.payloadDigest
    )
      return yield* Effect.fail(
        new Error("Worker recovery turn checkpoint binding mismatch.")
      );
    return checkpoint.checkpoint;
  }).pipe(
    Effect.mapError((cause) =>
      makeRuntimeError({
        cause,
        code: "WorkerRecoveryTurnCheckpointInvalid",
        message:
          "The exact recovered native turn checkpoint is missing or invalid.",
        recoverable: false,
      })
    )
  );
}

export function writePrivateWorkerCorrelationFollowUpCheckpoint(
  runRoot: string,
  checkpoint: HarnessCheckpointToken
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(runRoot, ".worker-correlation-follow-up-turn.json"),
      JSON.stringify(
        encodePrivateWorkerCorrelationFollowUpTurn(
          PrivateWorkerCorrelationFollowUpTurn.make({
            checkpoint,
            version: 2,
          })
        )
      )
    );
  }).pipe(
    Effect.mapError((cause) =>
      makeRuntimeError({
        cause,
        code: "WorkerCorrelationFollowUpCheckpointInvalid",
        message:
          "The accepted worker correlation follow-up checkpoint could not be persisted.",
        recoverable: false,
      })
    )
  );
}

export function readPrivateWorkerCorrelationFollowUpCheckpoint(
  runRoot: string
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fs.readFileString(
      path.join(runRoot, ".worker-correlation-follow-up-turn.json")
    );
    const checkpoint = yield* Schema.decodeUnknownEffect(
      PrivateWorkerCorrelationFollowUpTurnJson
    )(JSON.parse(raw));
    return checkpoint.checkpoint;
  }).pipe(
    Effect.mapError((cause) =>
      makeRuntimeError({
        cause,
        code: "WorkerCorrelationFollowUpCheckpointInvalid",
        message:
          "The accepted worker correlation follow-up checkpoint is missing or invalid.",
        recoverable: false,
      })
    )
  );
}
