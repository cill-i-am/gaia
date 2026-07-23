import nodePath from "node:path";

import {
  HarnessExecutionSelection,
  ResolvedHarnessExecution,
  RunControlEventPayload,
  RunControlActionTarget,
  RunControlReceipt,
  RunControlSnapshot,
  makeRunControlActionBindingDigest,
  parseHarnessActionId,
  parseRunControlAuthorityId,
  parseHarnessEvent,
  parseRunControlEventPayload,
  parseRunHumanWaitCheckpoint,
  parseWorkspaceRelativePath,
  replayHarnessSession,
  snapshotFromReplay,
  type HarnessCapabilities,
  type RunControlAction,
  type RunControlOperation,
  type RunEvent,
  type RunId,
} from "@gaia/core";
import { Clock, Effect, Option, PartitionedSemaphore, Schema } from "effect";

import type { LiveHarnessSessionCoordinator } from "./agent-session-runtime.js";
import { makeRuntimeError } from "./errors.js";
import {
  appendEventWithinSerialization,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import type { HarnessProviderRegistry } from "./harness-provider-registry.js";
import {
  resumeHarnessSession,
  type HarnessSession,
} from "./harness-session.js";
import {
  makeRunPaths,
  parseRunStorageRootInput,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import { withRunStoreLock } from "./run-store-lock.js";

export type RunControlRuntimeOptions = RunStorageOptions & {
  readonly harnessProviderRegistry?: HarnessProviderRegistry;
  readonly sessionCoordinator?: LiveHarnessSessionCoordinator;
};

const encodeControl = Schema.encodeSync(RunControlEventPayload);
const decodeSelection = Schema.decodeUnknownSync(HarnessExecutionSelection);
const decodeExecution = Schema.decodeUnknownSync(ResolvedHarnessExecution);
const encodeExecution = Schema.encodeSync(ResolvedHarnessExecution);
const runControlActionSemaphore = PartitionedSemaphore.makeUnsafe<
  RunPaths["events"]
>({ permits: 1 });

/** Project durable run control exclusively from authoritative run events. */
export function readRunControlSnapshot(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const events = yield* readEvents(paths);
    const now = yield* Clock.currentTimeMillis;
    return yield* expectRuntime(() => projectSnapshot(runId, events, now));
  });
}

/** Append one due expiry marker. Repeated reconciliation is a no-op. */
export function reconcileRunControlExpiry(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return withRunStoreLock(
    options,
    reconcileRunControlExpiryWithinLease(runId, options),
    {
      nextSafeAction: "Read the run control snapshot before retrying expiry.",
      operation: "Gaia run control expiry",
    }
  );
}

/** Store-lock-held expiry reconciliation used by server startup. */
export function reconcileRunControlExpiryWithinLease(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    return yield* withRunEventSerialization(
      paths,
      Effect.gen(function* () {
        const events = yield* readEvents(paths);
        const now = yield* Clock.currentTimeMillis;
        const projected = yield* expectRuntime(() =>
          projectSnapshot(runId, events, now)
        );
        const checkpoint = projected.pendingCheckpoint;
        if (
          checkpoint === undefined ||
          events.some(({ type }) => type === "RUN_INTERACTION_EXPIRED") ||
          checkpoint.expiresAt === undefined ||
          now < Date.parse(checkpoint.expiresAt)
        )
          return projected;
        yield* appendEventWithinSerialization(runId, paths, {
          payload: { checkpointDigest: checkpoint.checkpointDigest },
          type: "RUN_INTERACTION_EXPIRED",
        });
        const updated = yield* readEvents(paths);
        return yield* expectRuntime(() => projectSnapshot(runId, updated, now));
      })
    );
  });
}

/** Execute one durable, value-safe run control action. */
export function dispatchRunControlAction(input: {
  readonly action: RunControlAction;
  readonly options?: RunControlRuntimeOptions;
  readonly runId: RunId;
}) {
  const options = input.options ?? {};
  const actionEffect = Effect.gen(function* () {
    const paths = yield* makeRunPaths(input.runId, options);
    return yield* runControlActionSemaphore.withPermits(
      paths.events,
      1
    )(
      withRunEventSerialization(
        paths,
        Effect.gen(function* () {
          const events = yield* readEvents(paths);
          const prepared = yield* prepareAction(
            input.runId,
            input.action,
            events
          );
          if (prepared._tag === "duplicate") return prepared.duplicate;
          if (prepared._tag === "failed") {
            yield* appendControlFailure(input.runId, paths, prepared);
            return yield* Effect.fail(prepared.error);
          }
          yield* appendControlIntent(input.runId, paths, prepared.control);

          const providerDispatch = yield* Effect.exit(
            prepareProviderDispatch(prepared, input.action, options)
          );
          if (providerDispatch._tag === "Failure") {
            const error = conflict(
              "unsupportedProviderOperation",
              "The accepted provider cannot prepare this durable operation."
            );
            yield* appendControlFailed(input.runId, paths, prepared.control, {
              diagnostic:
                "The provider operation failed deterministically before dispatch.",
            });
            return yield* Effect.fail(error);
          }

          yield* appendControlAttempted(input.runId, paths, prepared.control);

          const outcome = yield* Effect.exit(
            Effect.scoped(providerDispatch.value)
          );
          if (outcome._tag === "Failure") {
            yield* appendEventWithinSerialization(input.runId, paths, {
              payload: {
                control: encodeControl(
                  RunControlEventPayload.make({
                    ...prepared.control,
                    diagnostic:
                      "Provider action outcome is unknown; automatic redispatch is forbidden.",
                    recordedAt: new Date(
                      yield* Clock.currentTimeMillis
                    ).toISOString(),
                  })
                ),
              },
              type: "RUN_CONTROL_OUTCOME_UNKNOWN",
            });
            return yield* Effect.fail(
              conflict(
                "outcomeUnknown",
                "The provider action outcome is unknown and will not be redispatched."
              )
            );
          }

          yield* appendEventWithinSerialization(input.runId, paths, {
            payload: {
              control: encodeControl(
                RunControlEventPayload.make({
                  ...prepared.control,
                  recordedAt: new Date(
                    yield* Clock.currentTimeMillis
                  ).toISOString(),
                  witness: outcome.value,
                })
              ),
            },
            type: "RUN_CONTROL_CONFIRMED",
          });
          return RunControlReceipt.make({
            actionBindingDigest: prepared.control.actionBindingDigest,
            actionId: input.action.actionId,
            duplicate: false,
            operation: input.action.operation,
            runId: input.runId,
            state: "confirmed",
          });
        })
      )
    );
  });
  const leaseContext = {
    nextSafeAction: "Read the run control snapshot before retrying the action.",
    operation: "Gaia run control action",
  } as const;
  const coordinator = options.sessionCoordinator;
  if (
    coordinator === undefined ||
    (input.action.operation !== "pause" && input.action.operation !== "cancel")
  )
    return withRunStoreLock(options, actionEffect, leaseContext);

  return coordinator
    .use(
      {
        agentId: input.action.workerAgentId,
        runId: input.runId,
        sessionId: input.action.sessionId,
      },
      () => actionEffect
    )
    .pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => withRunStoreLock(options, actionEffect, leaseContext),
          onSome: Effect.succeed,
        })
      )
    );
}

function prepareAction(
  runId: RunId,
  action: RunControlAction,
  events: ReadonlyArray<RunEvent>
) {
  return Effect.gen(function* () {
    if (action.runId !== runId)
      return yield* Effect.fail(
        conflict("changedDigest", "Run binding changed.")
      );
    const now = yield* Clock.currentTimeMillis;
    const snapshot = yield* expectRuntime(() =>
      projectSnapshot(runId, events, now)
    );
    if (hasStickyRunControlAmbiguity(events))
      return yield* Effect.fail(
        conflict(
          "outcomeUnknown",
          "A provider action outcome remains unknown and forbids redispatch."
        )
      );
    const claims = resolutionClaims(events, action.interactionId);
    if (action.operation === "resolveInteraction" && claims.length > 0) {
      const first = claims[0]!;
      if (first.actionId !== action.actionId)
        return yield* Effect.fail(
          conflict(
            "resolutionAlreadyClaimed",
            "This interaction is already claimed by another action."
          )
        );
      const digest = bindingDigest(action);
      if (first.actionBindingDigest !== digest)
        return yield* Effect.fail(
          conflict("changedDigest", "The action structural binding changed.")
        );
      return yield* Effect.fail(
        conflict(
          "resolutionReplayNotComparable",
          "The hidden response is single-use and cannot be compared or redispatched."
        )
      );
    }

    const digest = bindingDigest(action);
    const sameAction = controlEvents(events).filter(
      ({ control }) => control.actionId === action.actionId
    );
    if (sameAction.length > 0) {
      const first = sameAction[0]!.control;
      const last = sameAction.at(-1)!;
      if (first.actionBindingDigest !== digest)
        return yield* Effect.fail(
          conflict("changedDigest", "The action structural binding changed.")
        );
      if (
        action.operation === "resolveInteraction" &&
        last.event.type === "RUN_CONTROL_FAILED"
      )
        return yield* Effect.fail(
          conflict(
            "unsupportedProviderOperation",
            "The accepted provider does not support this durable operation."
          )
        );
      if (action.operation === "resolveInteraction")
        return yield* Effect.fail(
          conflict(
            "resolutionReplayNotComparable",
            "The hidden response is single-use and cannot be compared or redispatched."
          )
        );
      if (last.event.type === "RUN_CONTROL_OUTCOME_UNKNOWN")
        return yield* Effect.fail(
          conflict("outcomeUnknown", "The action outcome remains unknown.")
        );
      const state =
        last.event.type === "RUN_CONTROL_CONFIRMED" ? "confirmed" : "failed";
      return {
        _tag: "duplicate" as const,
        duplicate: RunControlReceipt.make({
          actionBindingDigest: digest,
          actionId: action.actionId,
          duplicate: true,
          operation: action.operation,
          runId,
          state,
        }),
      } as const;
    }

    const capabilities = yield* validateBinding(action, snapshot, events);
    yield* validateResolutionResponse(action, events);
    const supported = supportsOperation(capabilities, action.operation);
    const control = controlPayload(action, snapshot, digest, supported);
    if (!supported)
      return {
        _tag: "failed" as const,
        control,
        error: conflict(
          "unsupportedProviderOperation",
          "The accepted provider does not support this durable operation."
        ),
      } as const;
    return {
      _tag: "prepared" as const,
      control,
      state: snapshot.state,
    } as const;
  });
}

function validateResolutionResponse(
  action: RunControlAction,
  events: ReadonlyArray<RunEvent>
) {
  if (action.operation !== "resolveInteraction") return Effect.void;
  return expectRuntime(() => {
    const pending = replayHarnessSession(
      events,
      action.sessionId
    ).pendingInteractions.find(
      ({ interactionId }) => interactionId === action.interactionId
    );
    if (pending === undefined)
      throw conflict(
        "stale",
        "The pending interaction is stale, unknown, or already resolved."
      );
    switch (pending.kind) {
      case "commandApproval":
      case "fileChangeApproval":
      case "permissionApproval":
        if (
          action.response.kind !== "approval" ||
          !pending.allowedDecisions.includes(action.response.decision)
        )
          throw conflict(
            "stale",
            "The response is incompatible with the pending interaction."
          );
        return;
      case "userInput": {
        if (action.response.kind !== "userInput")
          throw conflict(
            "stale",
            "The response is incompatible with the pending interaction."
          );
        const expected = pending.questions
          .map(({ questionId }) => questionId)
          .toSorted();
        const actual = action.response.answers
          .map(({ questionId }) => questionId)
          .toSorted();
        if (
          new Set(actual).size !== actual.length ||
          JSON.stringify(actual) !== JSON.stringify(expected)
        )
          throw conflict(
            "stale",
            "The response is incompatible with the pending interaction."
          );
        return;
      }
      case "mcpElicitation":
        if (action.response.kind !== "mcpElicitation")
          throw conflict(
            "stale",
            "The response is incompatible with the pending interaction."
          );
    }
  });
}

function appendControlFailure(
  runId: RunId,
  paths: RunPaths,
  prepared: {
    readonly _tag: "failed";
    readonly control: RunControlEventPayload;
    readonly error: ReturnType<typeof conflict>;
  }
) {
  return Effect.gen(function* () {
    yield* appendControlIntent(runId, paths, prepared.control);
    yield* appendControlFailed(runId, paths, prepared.control, {
      diagnostic:
        "The accepted provider does not support this durable operation.",
    });
    return prepared;
  });
}

const PreparedRunControlAttemptSchema = Schema.Struct({
  _tag: Schema.Literal("prepared"),
  control: RunControlEventPayload,
  state: RunControlSnapshot.fields.state,
});

function appendControlIntent(
  runId: RunId,
  paths: RunPaths,
  control: RunControlEventPayload
) {
  return Effect.gen(function* () {
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* appendEventWithinSerialization(runId, paths, {
      payload: {
        control: encodeControl(
          RunControlEventPayload.make({
            ...control,
            recordedAt,
          })
        ),
      },
      type: "RUN_CONTROL_INTENT_RECORDED",
    });
  });
}

function appendControlAttempted(
  runId: RunId,
  paths: RunPaths,
  control: RunControlEventPayload
) {
  return Effect.gen(function* () {
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* appendEventWithinSerialization(runId, paths, {
      payload: {
        control: encodeControl(
          RunControlEventPayload.make({
            ...control,
            recordedAt,
          })
        ),
      },
      type: "RUN_CONTROL_ATTEMPTED",
    });
  });
}

function appendControlFailed(
  runId: RunId,
  paths: RunPaths,
  control: RunControlEventPayload,
  input: { readonly diagnostic: string }
) {
  return Effect.gen(function* () {
    yield* appendEventWithinSerialization(runId, paths, {
      payload: {
        control: encodeControl(
          RunControlEventPayload.make({
            ...control,
            diagnostic: input.diagnostic,
            recordedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          })
        ),
      },
      type: "RUN_CONTROL_FAILED",
    });
  });
}

function prepareProviderDispatch(
  prepared: {
    readonly control: RunControlEventPayload;
    readonly state: RunControlSnapshot["state"];
  },
  action: RunControlAction,
  options: RunControlRuntimeOptions
) {
  if (
    (action.operation === "pause" || action.operation === "cancel") &&
    prepared.state !== "runningWorker"
  )
    return Effect.succeed(Effect.succeed("releasedWithoutProvider"));
  if (
    action.operation === "resume" &&
    prepared.control.restoreState === "waitingForHuman"
  )
    return Effect.succeed(Effect.succeed("releasedWithoutProvider"));
  if (action.operation === "resume")
    return prepareAcceptedSessionResume(action, options).pipe(
      Effect.as(Effect.succeed("releasedWithoutProvider"))
    );

  if (action.operation === "pause" || action.operation === "cancel") {
    const coordinator = options.sessionCoordinator;
    if (coordinator === undefined)
      return Effect.fail(new Error("A live session is unavailable."));
    return coordinator
      .get({
        agentId: prepared.control.workerAgentId,
        runId: action.runId,
        sessionId: action.sessionId,
      })
      .pipe(
        Effect.flatMap((live) => {
          if (live === undefined)
            return Effect.fail(new Error("A live session is unavailable."));
          return Option.match(live.session.interrupt, {
            onNone: () => Effect.fail(new Error("Interrupt is unavailable.")),
            onSome: (interrupt) =>
              Effect.succeed(interrupt.pipe(Effect.as("providerInterrupted"))),
          });
        })
      );
  }

  return prepareAcceptedSessionResume(action, options).pipe(
    Effect.map((resume) =>
      resumeHarnessSession(resume).pipe(
        Effect.flatMap((session) =>
          session.resolveInteraction({
            actionId: parseHarnessActionId(action.actionId),
            interactionId: action.interactionId!,
            ...action.response,
          })
        ),
        Effect.as("providerAccepted")
      )
    )
  );
}

function prepareAcceptedSessionResume(
  action: RunControlAction,
  options: RunControlRuntimeOptions
) {
  return Effect.gen(function* () {
    const registry = options.harnessProviderRegistry;
    if (registry === undefined)
      return yield* Effect.fail(new Error("Provider registry is unavailable."));
    const paths = yield* makeRunPaths(action.runId, options);
    const events = yield* readEvents(paths);
    const first = events[0];
    if (first?.type !== "RUN_CREATED")
      return yield* Effect.fail(
        new Error("Accepted execution is unavailable.")
      );
    const execution = first.payload["execution"];
    if (
      execution === null ||
      typeof execution !== "object" ||
      Array.isArray(execution)
    )
      return yield* Effect.fail(new Error("Accepted execution is corrupt."));
    const accepted = yield* Effect.try({
      catch: () => new Error("Accepted execution is corrupt."),
      try: () => ({
        resolved: decodeExecution(Reflect.get(execution, "resolved")),
        selection: decodeSelection(Reflect.get(execution, "selection")),
      }),
    });
    const required =
      action.operation === "resolveInteraction"
        ? (["durableInteractionResolution"] as const)
        : action.operation === "resume"
          ? (["durablePause"] as const)
          : ([] as const);
    const resolved = yield* registry.resolve(accepted.selection, required);
    if (
      JSON.stringify(encodeExecution(resolved.execution)) !==
        JSON.stringify(encodeExecution(accepted.resolved)) ||
      resolved.execution.provider.providerId !== action.providerId
    )
      return yield* Effect.fail(
        new Error("Accepted provider execution changed after run acceptance.")
      );
    const rootDirectory =
      options.rootDirectory ?? parseRunStorageRootInput(".");
    return {
      provider: resolved.provider,
      request: {
        sessionId: action.sessionId,
        workspacePath: parseWorkspaceRelativePath(
          nodePath.relative(rootDirectory, paths.workspace)
        ),
      },
      requiredCapabilities: required,
    } as const;
  });
}

function validateBinding(
  action: RunControlAction,
  snapshot: RunControlSnapshot,
  events: ReadonlyArray<RunEvent>
) {
  return Effect.gen(function* () {
    if (
      snapshot.state === "completed" ||
      snapshot.state === "failed" ||
      snapshot.state === "cancelled"
    )
      return yield* Effect.fail(conflict("terminal", "Run is terminal."));
    if (
      snapshot.actionTarget === undefined ||
      action.authorityId !== snapshot.actionTarget.authorityId
    )
      return yield* Effect.fail(
        conflict("wrongAuthority", "The action authority is not authorized.")
      );
    const checkpoint = snapshot.pendingCheckpoint;
    const workerStarted = [...events]
      .reverse()
      .find(({ type }) => type === "WORKER_STARTED")?.sequence;
    const session = latestSessionStart(events);
    const expected =
      checkpoint?.expectedEventSequence ?? events.at(-1)?.sequence;
    if (
      workerStarted === undefined ||
      session === undefined ||
      action.workerStartedSequence !== workerStarted ||
      action.workerAgentId !==
        (checkpoint?.workerAgentId ?? issueDeliveryAgentIds.worker) ||
      action.providerId !== session.provider.providerId ||
      action.sessionId !== session.sessionId ||
      action.expectedEventSequence !== expected ||
      action.checkpointDigest !== checkpoint?.checkpointDigest ||
      action.requestDigest !== checkpoint?.requestDigest ||
      action.interactionId !== checkpoint?.interactionId
    )
      return yield* Effect.fail(
        conflict("stale", "The action does not match the current checkpoint.")
      );
    if (snapshot.expired && action.operation !== "cancel")
      return yield* Effect.fail(
        conflict("expired", "The pending interaction has expired.")
      );
    if (!operationMatchesState(action.operation, snapshot.state))
      return yield* Effect.fail(
        conflict("stale", "The action is stale for the current run state.")
      );
    return session.capabilities;
  });
}

function controlPayload(
  action: RunControlAction,
  snapshot: RunControlSnapshot,
  actionBindingDigest: ReturnType<typeof bindingDigest>,
  resolutionClaimed: boolean
) {
  const checkpoint = snapshot.pendingCheckpoint;
  return RunControlEventPayload.make({
    actionBindingDigest,
    actionId: action.actionId,
    authorityId: action.authorityId,
    ...(action.checkpointDigest === undefined
      ? {}
      : { checkpointDigest: action.checkpointDigest }),
    expectedEventSequence: action.expectedEventSequence,
    ...(action.interactionId === undefined
      ? {}
      : { interactionId: action.interactionId }),
    operation: action.operation,
    providerId: action.providerId,
    ...(action.requestDigest === undefined
      ? {}
      : { requestDigest: action.requestDigest }),
    ...(action.operation === "resolveInteraction" && resolutionClaimed
      ? {
          resolutionClaimed: true as const,
          resolutionIdentityMode: "singleUseValueOpaque" as const,
        }
      : {}),
    ...((action.operation === "pause" || action.operation === "resume") &&
    (snapshot.state === "paused" || snapshot.state === "waitingForHuman")
      ? {
          restoreState:
            snapshot.state === "paused"
              ? ((snapshot.pendingCheckpoint?.restoreState ??
                  "runningWorker") as "runningWorker" | "waitingForHuman")
              : ("waitingForHuman" as const),
        }
      : action.operation === "pause"
        ? { restoreState: "runningWorker" as const }
        : {}),
    sessionId: action.sessionId,
    workerAgentId: action.workerAgentId,
    workerStartedSequence: action.workerStartedSequence,
  });
}

function supportsOperation(
  capabilities: HarnessCapabilities,
  operation: RunControlOperation
) {
  return operation === "resolveInteraction"
    ? capabilities.durableInteractionResolution === true
    : operation === "cancel"
      ? capabilities.durableCancellation === true
      : capabilities.durablePause === true;
}

function bindingDigest(action: RunControlAction) {
  return makeRunControlActionBindingDigest({
    actionId: action.actionId,
    authorityId: action.authorityId,
    ...(action.checkpointDigest === undefined
      ? {}
      : { checkpointDigest: action.checkpointDigest }),
    expectedEventSequence: action.expectedEventSequence,
    ...(action.interactionId === undefined
      ? {}
      : { interactionId: action.interactionId }),
    operation: action.operation,
    providerId: action.providerId,
    ...(action.requestDigest === undefined
      ? {}
      : { requestDigest: action.requestDigest }),
    runId: action.runId,
    sessionId: action.sessionId,
    workerAgentId: action.workerAgentId,
    workerStartedSequence: action.workerStartedSequence,
  });
}

function projectSnapshot(
  runId: RunId,
  events: ReadonlyArray<RunEvent>,
  now: number
) {
  if (events.length === 0)
    throw makeRuntimeError({
      code: "runNotFound",
      message: "Run does not exist.",
    });
  const replayed = snapshotFromReplay(events);
  if (
    replayed.state !== "runningWorker" &&
    replayed.state !== "waitingForHuman" &&
    replayed.state !== "paused" &&
    replayed.state !== "cancelled" &&
    replayed.state !== "completed" &&
    replayed.state !== "failed"
  )
    throw makeRuntimeError({
      code: "stale",
      message: "Run control is unavailable in the current lifecycle state.",
    });
  const control = replayed.context["runControl"];
  const checkpoint =
    control !== null && typeof control === "object" && !Array.isArray(control)
      ? Reflect.get(control, "checkpoint")
      : undefined;
  const pendingCheckpoint =
    checkpoint === undefined
      ? undefined
      : parseRunHumanWaitCheckpoint(checkpoint);
  const storedExpired =
    control !== null && typeof control === "object" && !Array.isArray(control)
      ? Reflect.get(control, "expired") === true
      : false;
  const expired =
    storedExpired ||
    (pendingCheckpoint?.expiresAt !== undefined &&
      now >= Date.parse(pendingCheckpoint.expiresAt));
  const capabilities = latestSessionStart(events)?.capabilities;
  const session = latestSessionStart(events);
  const workerStartedSequence = [...events]
    .reverse()
    .find(({ type }) => type === "WORKER_STARTED")?.sequence;
  const actionTarget =
    session === undefined || workerStartedSequence === undefined
      ? undefined
      : RunControlActionTarget.make({
          authorityId:
            pendingCheckpoint?.resolverAuthorityId ??
            parseRunControlAuthorityId("local-gaia-server"),
          ...(pendingCheckpoint?.checkpointDigest === undefined
            ? {}
            : { checkpointDigest: pendingCheckpoint.checkpointDigest }),
          expectedEventSequence:
            pendingCheckpoint?.expectedEventSequence ?? events.at(-1)!.sequence,
          ...(pendingCheckpoint?.interactionId === undefined
            ? {}
            : { interactionId: pendingCheckpoint.interactionId }),
          providerId: session.provider.providerId,
          ...(pendingCheckpoint?.requestDigest === undefined
            ? {}
            : { requestDigest: pendingCheckpoint.requestDigest }),
          sessionId: session.sessionId,
          workerAgentId:
            pendingCheckpoint?.workerAgentId ?? issueDeliveryAgentIds.worker,
          workerStartedSequence,
        });
  const active = controlEvents(events).at(-1);
  const stickyAmbiguity = hasStickyRunControlAmbiguity(events);
  const activeReceipt =
    active === undefined
      ? undefined
      : RunControlReceipt.make({
          actionBindingDigest: active.control.actionBindingDigest,
          actionId: active.control.actionId,
          duplicate: false,
          operation: active.control.operation,
          runId,
          state:
            active.event.type === "RUN_CONTROL_CONFIRMED"
              ? "confirmed"
              : active.event.type === "RUN_CONTROL_FAILED"
                ? "failed"
                : "outcomeUnknown",
        });
  return RunControlSnapshot.make({
    ...(activeReceipt === undefined ? {} : { activeReceipt }),
    ...(actionTarget === undefined ? {} : { actionTarget }),
    allowedActions: stickyAmbiguity
      ? []
      : allowedActions(replayed.state, expired, capabilities),
    expired,
    ...(pendingCheckpoint === undefined ? {} : { pendingCheckpoint }),
    runId,
    state: replayed.state,
  });
}

function operationMatchesState(
  operation: RunControlOperation,
  state: RunControlSnapshot["state"]
) {
  switch (operation) {
    case "resolveInteraction":
      return state === "waitingForHuman";
    case "pause":
      return state === "runningWorker" || state === "waitingForHuman";
    case "resume":
      return state === "paused";
    case "cancel":
      return (
        state !== "cancelled" && state !== "completed" && state !== "failed"
      );
  }
}

function allowedActions(
  state: RunControlSnapshot["state"],
  expired: boolean,
  capabilities: HarnessCapabilities | undefined
): ReadonlyArray<RunControlOperation> {
  if (state === "cancelled" || state === "completed" || state === "failed")
    return [];
  if (expired) return capabilities?.durableCancellation ? ["cancel"] : [];
  if (state === "waitingForHuman")
    return [
      ...(capabilities?.durableInteractionResolution
        ? (["resolveInteraction"] as const)
        : []),
      ...(capabilities?.durablePause ? (["pause"] as const) : []),
      ...(capabilities?.durableCancellation ? (["cancel"] as const) : []),
    ];
  if (state === "paused")
    return [
      ...(capabilities?.durablePause ? (["resume"] as const) : []),
      ...(capabilities?.durableCancellation ? (["cancel"] as const) : []),
    ];
  return [
    ...(capabilities?.durablePause ? (["pause"] as const) : []),
    ...(capabilities?.durableCancellation ? (["cancel"] as const) : []),
  ];
}

function latestSessionStart(events: ReadonlyArray<RunEvent>) {
  return [...events].reverse().flatMap((event) => {
    if (event.type !== "HARNESS_SESSION_EVENT_RECORDED") return [];
    const parsed = parseHarnessEvent(event.payload["event"]);
    return parsed.kind === "sessionStarted" ? [parsed] : [];
  })[0];
}

function controlEvents(events: ReadonlyArray<RunEvent>) {
  return events.flatMap((event) =>
    event.type === "RUN_CONTROL_INTENT_RECORDED" ||
    event.type === "RUN_CONTROL_ATTEMPTED" ||
    event.type === "RUN_CONTROL_CONFIRMED" ||
    event.type === "RUN_CONTROL_FAILED" ||
    event.type === "RUN_CONTROL_OUTCOME_UNKNOWN"
      ? [
          {
            control: parseRunControlEventPayload(event.payload["control"]),
            event,
          },
        ]
      : []
  );
}

function hasStickyRunControlAmbiguity(events: ReadonlyArray<RunEvent>) {
  const phases = new Map<string, RunEvent["type"]>();
  for (const { control, event } of controlEvents(events))
    phases.set(control.actionId, event.type);
  return [...phases.values()].some(
    (phase) =>
      phase === "RUN_CONTROL_ATTEMPTED" ||
      phase === "RUN_CONTROL_OUTCOME_UNKNOWN"
  );
}

function resolutionClaims(
  events: ReadonlyArray<RunEvent>,
  interactionId: RunControlAction["interactionId"]
) {
  return controlEvents(events)
    .filter(
      ({ control, event }) =>
        event.type === "RUN_CONTROL_INTENT_RECORDED" &&
        control.operation === "resolveInteraction" &&
        control.interactionId === interactionId &&
        control.resolutionClaimed === true
    )
    .map(({ control }) => control);
}

function conflict(code: string, message: string) {
  return makeRuntimeError({ code, message, recoverable: false });
}

function expectRuntime<A>(evaluate: () => A) {
  return Effect.try({
    catch: (cause) =>
      cause instanceof Error && "code" in cause
        ? cause
        : makeRuntimeError({
            cause,
            code: "corruptRunHistory",
            message: "Run control history is corrupt.",
          }),
    try: evaluate,
  });
}
