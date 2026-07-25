import { createHash } from "node:crypto";

import {
  AgentActionReceiptDto,
  AgentSessionEventSequenceSchema,
  AgentSessionSnapshotDto,
  AgentSessionUpdateDto,
  FactoryAgentIdSchema,
  HarnessInteractionResolutionSchema,
  HarnessSessionIdSchema,
  ModelInvocationObservationV1,
  RunIdSchema,
  parseHarnessSessionId,
  parseHarnessEvent,
  parseRunControlEventPayload,
  replayHarnessSession,
  type AgentSessionCursor,
  type AgentSessionEventSequence,
  type AgentOperatorActionRequest,
  type FactoryAgentId,
  type HarnessEvent,
  type HarnessSessionId,
  type RunEvent,
  type RunId,
} from "@gaia/core";
import { Clock, Deferred, Effect, Option, Schema, Stream } from "effect";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import {
  appendHarnessSessionEventWithinSerialization,
  readEvents,
  subscribeRunEventFeed,
  withRunEventSerialization,
} from "./event-store.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import {
  HarnessInput,
  type HarnessActionTransportWitness,
  type HarnessSession,
} from "./harness-session.js";
import {
  commitDerivedAppModelInvocationEpisode,
  loadModelInvocationPair,
} from "./model-invocation.js";
import {
  makeRunPaths,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import { withRunStoreLock } from "./run-store-lock.js";

const decodeAgentSessionEventSequence = Schema.decodeUnknownSync(
  AgentSessionEventSequenceSchema
);

function prepareOperatorInputEpisode(input: {
  readonly action: AgentOperatorActionRequest;
  readonly events: ReadonlyArray<RunEvent>;
  readonly paths: RunPaths;
  readonly runId: RunId;
}) {
  if (input.action.kind !== "followUp" && input.action.kind !== "steer")
    return Effect.succeed(undefined);
  const action = input.action;
  return commitDerivedAppModelInvocationEpisode({
    episodeKey: `${
      action.kind === "followUp" ? "operatorFollowUp" : "operatorSteer"
    }:${action.actionId}`,
    episodeRole:
      action.kind === "followUp" ? "operatorFollowUp" : "operatorSteer",
    events: input.events,
    paths: input.paths,
    runId: input.runId,
    taskInput: action.text,
  });
}

const LiveSessionIdentitySchema = Schema.Struct({
  agentId: FactoryAgentIdSchema,
  runId: RunIdSchema,
  sessionId: HarnessSessionIdSchema,
});
type LiveSessionIdentity = typeof LiveSessionIdentitySchema.Type;
type LiveEntry = LiveSessionIdentity & { readonly session: HarnessSession };
type RegisteredLiveEntry = LiveEntry & { readonly generation: number };
type StoredLiveEntry = RegisteredLiveEntry & {
  readonly closing: boolean;
  readonly drained: Deferred.Deferred<void>;
  readonly lease: symbol;
  readonly pinCount: number;
};

export type LiveHarnessSessionCoordinator = ReturnType<
  typeof makeLiveHarnessSessionCoordinator
>;

/** Scoped registry of provider-neutral handles only. */
export function makeLiveHarnessSessionCoordinator() {
  const sessions = new Map<string, StoredLiveEntry>();
  const key = (input: LiveSessionIdentity) =>
    `${input.runId}\0${input.agentId}\0${input.sessionId}`;
  return {
    get: (identity: LiveSessionIdentity) =>
      Effect.sync(() => {
        const stored = sessions.get(key(identity));
        if (stored === undefined) return undefined;
        const { lease: _lease, ...entry } = stored;
        return entry;
      }),
    register: (entry: LiveEntry & { readonly generation?: number }) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const entryKey = key(entry);
          const generation = entry.generation ?? 1;
          const existing = sessions.get(entryKey);
          if (existing !== undefined) {
            return yield* Effect.fail(
              makeRuntimeError({
                code: "AgentSessionAlreadyLive",
                message: "The agent session already has a live handle.",
                recoverable: false,
              })
            );
          }
          const lease = Symbol(entryKey);
          const drained = yield* Deferred.make<void>();
          sessions.set(entryKey, {
            ...entry,
            closing: false,
            drained,
            generation,
            lease,
            pinCount: 0,
          });
          return { entryKey, lease } as const;
        }),
        ({ entryKey, lease }) =>
          Effect.gen(function* () {
            const drained = yield* Effect.sync(() => {
              const stored = sessions.get(entryKey);
              if (stored?.lease !== lease) return undefined;
              const closing = { ...stored, closing: true };
              sessions.set(entryKey, closing);
              return closing.pinCount === 0 ? undefined : closing.drained;
            });
            if (drained !== undefined) yield* Deferred.await(drained);
            yield* Effect.sync(() => {
              if (sessions.get(entryKey)?.lease === lease)
                sessions.delete(entryKey);
            });
          })
      ).pipe(Effect.asVoid),
    shutdown: Effect.gen(function* () {
      const closing = yield* Effect.sync(() =>
        Array.from(sessions.entries(), ([entryKey, stored]) => {
          const entry = { ...stored, closing: true };
          sessions.set(entryKey, entry);
          return {
            drained: entry.pinCount === 0 ? undefined : entry.drained,
            entryKey,
            lease: entry.lease,
          };
        })
      );
      yield* Effect.forEach(closing, ({ drained }) =>
        drained === undefined ? Effect.void : Deferred.await(drained)
      );
      yield* Effect.sync(() => {
        for (const { entryKey, lease } of closing) {
          if (sessions.get(entryKey)?.lease === lease)
            sessions.delete(entryKey);
        }
      });
    }),
    use: <A, E, R>(
      identity: LiveSessionIdentity,
      effect: (entry: RegisteredLiveEntry) => Effect.Effect<A, E, R>
    ): Effect.Effect<Option.Option<A>, E, R> => {
      const acquire = Effect.sync(() => {
        const entryKey = key(identity);
        const stored = sessions.get(entryKey);
        if (stored === undefined || stored.closing) return Option.none();
        const pinned = { ...stored, pinCount: stored.pinCount + 1 };
        sessions.set(entryKey, pinned);
        const {
          closing: _closing,
          drained: _drained,
          lease,
          pinCount: _pinCount,
          ...entry
        } = pinned;
        return Option.some({ entry, entryKey, lease });
      });
      return Effect.acquireUseRelease(
        acquire,
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: ({ entry }) => effect(entry).pipe(Effect.map(Option.some)),
        }),
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ entryKey, lease }) =>
            Effect.gen(function* () {
              const drained = yield* Effect.sync(() => {
                const stored = sessions.get(entryKey);
                if (stored?.lease !== lease) return undefined;
                const unpinned = {
                  ...stored,
                  pinCount: stored.pinCount - 1,
                };
                sessions.set(entryKey, unpinned);
                return unpinned.closing && unpinned.pinCount === 0
                  ? unpinned.drained
                  : undefined;
              });
              if (drained !== undefined)
                yield* Deferred.succeed(drained, undefined);
            }),
        })
      );
    },
  };
}

export function readAgentSessionSnapshot(
  runId: RunId,
  agentId: FactoryAgentId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    yield* expectRuntime(() => requireWorkerAgent(agentId));
    const paths = yield* makeRunPaths(runId, options);
    const events = yield* readEvents(paths);
    return yield* expectRuntime(() => publicSnapshot(runId, agentId, events));
  });
}

export function streamAgentSessionUpdates(
  runId: RunId,
  agentId: FactoryAgentId,
  afterSequence: AgentSessionCursor,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const cursor = yield* decodeAgentSessionCursor(afterSequence);
    yield* expectRuntime(() => requireWorkerAgent(agentId));
    const paths = yield* makeRunPaths(runId, options);
    const subscription = yield* subscribeRunEventFeed(paths);
    if (cursor !== undefined && cursor > subscription.highWater) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "AgentStreamCursorConflict",
          message: "Agent stream cursor is ahead of authoritative run history.",
          recoverable: true,
        })
      );
    }
    const lastSeenSequence = cursor ?? 0;
    const backlogEvents = subscription.backlog.filter(
      (event) =>
        event.sequence > lastSeenSequence &&
        event.sequence <= subscription.highWater
    );
    const backlog = updatesFromEvents(
      runId,
      agentId,
      subscription.backlog,
      backlogEvents
    );
    const live = subscription.live.pipe(
      Stream.filter((event) => event.sequence > subscription.highWater),
      Stream.mapAccum(
        () => subscription.backlog,
        (history, event) => {
          const next = [...history, event];
          const update = updateFromRunEvent(runId, agentId, next, event);
          return [next, update === undefined ? [] : [update]] as const;
        }
      )
    );
    return Stream.fromIterable(backlog).pipe(
      Stream.concat(live),
      Stream.takeUntil((update) => update.terminal)
    );
  });
}

function decodeAgentSessionCursor(
  afterSequence: AgentSessionCursor
): Effect.Effect<AgentSessionEventSequence | undefined, GaiaRuntimeError> {
  if (afterSequence === undefined) return Effect.succeed(undefined);

  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidRequest",
        message: "Agent stream cursor must be a positive Gaia sequence.",
        recoverable: false,
      }),
    try: () => decodeAgentSessionEventSequence(afterSequence),
  });
}

export function dispatchAgentSessionAction(input: {
  readonly action: AgentOperatorActionRequest;
  readonly agentId: FactoryAgentId;
  readonly coordinator: LiveHarnessSessionCoordinator;
  readonly options?: RunStorageOptions;
  readonly runId: RunId;
}) {
  return withRunStoreLock(
    input.options ?? {},
    dispatchAgentSessionActionWithinLease(input),
    {
      nextSafeAction:
        "Refresh the agent session before retrying the audited operator action.",
      operation: "Gaia agent session action",
    }
  );
}

function dispatchAgentSessionActionWithinLease(input: {
  readonly action: AgentOperatorActionRequest;
  readonly agentId: FactoryAgentId;
  readonly coordinator: LiveHarnessSessionCoordinator;
  readonly options?: RunStorageOptions;
  readonly runId: RunId;
}) {
  return Effect.gen(function* () {
    yield* expectRuntime(() => requireWorkerAgent(input.agentId));
    const paths = yield* makeRunPaths(input.runId, input.options ?? {});
    const digest = actionDigest(input.runId, input.agentId, input.action);
    const binding = actionBinding(input.agentId, input.action, digest);
    const prepared = yield* withRunEventSerialization(
      paths,
      Effect.gen(function* () {
        const events = yield* readEvents(paths);
        const existing = yield* expectRuntime(() =>
          existingReceipt(events, input.runId, binding)
        );
        if (existing !== undefined) return { existing } as const;
        const snapshot = yield* expectRuntime(() =>
          publicSnapshot(input.runId, input.agentId, events)
        );
        yield* expectRuntime(() =>
          validateAction(snapshot, input.action, events)
        );
        const modelInvocationEpisode = yield* prepareOperatorInputEpisode({
          action: input.action,
          events,
          paths,
          runId: input.runId,
        });
        const intent = yield* appendHarnessSessionEventWithinSerialization(
          input.runId,
          paths,
          { ...binding, kind: "operatorActionIntentRecorded" },
          modelInvocationEpisode
        );
        yield* appendHarnessSessionEventWithinSerialization(
          input.runId,
          paths,
          { ...binding, kind: "operatorActionDispatchAttempted" }
        );
        return {
          intentSequence: intent.event.sequence,
          modelInvocationEpisode,
          snapshot,
        } as const;
      })
    );
    if ("existing" in prepared) return prepared.existing;

    const live = yield* input.coordinator.get({
      agentId: input.agentId,
      runId: input.runId,
      sessionId: input.action.sessionId,
    });
    if (live === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "AgentActionConflict",
          message:
            "The durable action outcome is unknown because no matching live session is available.",
          recoverable: true,
        })
      );
    }
    const recordedInput =
      prepared.modelInvocationEpisode === undefined
        ? undefined
        : (yield* loadModelInvocationPair(
            paths,
            prepared.modelInvocationEpisode
          )).rendered.text;
    const dispatchExit = yield* Effect.exit(
      dispatchToSession(live.session, input.action, recordedInput)
    );
    if (dispatchExit._tag === "Failure") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "AgentActionConflict",
          message:
            "The provider action outcome is unknown and will not be redispatched.",
          recoverable: true,
        })
      );
    }
    return yield* withRunEventSerialization(
      paths,
      Effect.gen(function* () {
        const confirmed = yield* appendHarnessSessionEventWithinSerialization(
          input.runId,
          paths,
          { ...binding, kind: "operatorActionDispatchConfirmed" },
          undefined,
          prepared.modelInvocationEpisode === undefined ||
            dispatchExit.value?.kind !== "codexAppServerTransportOffered"
            ? undefined
            : ModelInvocationObservationV1.make({
                episodeKey: prepared.modelInvocationEpisode.episodeKey,
                kind: "offered",
                source: "codexAppServerTransport",
                trust: "high",
                version: 1,
              })
        );
        if (isInteractionAction(input.action)) {
          yield* appendHarnessSessionEventWithinSerialization(
            input.runId,
            paths,
            {
              kind: "interactionResolved",
              resolution: yield* resolutionFromAction(input.action),
              sessionId: input.action.sessionId,
            }
          );
        }
        return AgentActionReceiptDto.make({
          actionId: input.action.actionId,
          agentId: input.agentId,
          eventSequence: confirmed.event.sequence,
          payloadDigest: digest,
          runId: input.runId,
          sessionId: input.action.sessionId,
          state: "dispatchConfirmed",
        });
      })
    );
  });
}

function expectRuntime<A>(evaluate: () => A) {
  return Effect.try({
    catch: (error) => error,
    try: evaluate,
  });
}

function publicSnapshot(
  runId: RunId,
  agentId: FactoryAgentId,
  events: ReadonlyArray<RunEvent>
) {
  const sessionId = sessionIdForRun(runId);
  const sessionEvents = events.filter(
    (event) =>
      event.type === "HARNESS_SESSION_EVENT_RECORDED" &&
      parseHarnessEvent(event.payload.event).sessionId === sessionId
  );
  if (sessionEvents.length === 0)
    throw makeRuntimeError({
      code: "AgentSessionUnavailable",
      message: "The selected agent has no session projection.",
      recoverable: true,
    });
  const snapshot = replayHarnessSession(events, sessionId);
  return AgentSessionSnapshotDto.make({
    agentId,
    capabilities: snapshot.capabilities,
    eventSequence: events.at(-1)?.sequence ?? 1,
    items: snapshot.items,
    pendingInteractions: snapshot.pendingInteractions,
    recovered: snapshot.recovered,
    resolvedInteractions: snapshot.resolvedInteractions,
    runId,
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    turns: snapshot.turns,
  });
}

function updatesFromEvents(
  runId: RunId,
  agentId: FactoryAgentId,
  history: ReadonlyArray<RunEvent>,
  candidates: ReadonlyArray<RunEvent>
) {
  return candidates.flatMap((event) => {
    const prefix = history.slice(0, event.sequence);
    const update = updateFromRunEvent(runId, agentId, prefix, event, history);
    return update === undefined ? [] : [update];
  });
}

function updateFromRunEvent(
  runId: RunId,
  agentId: FactoryAgentId,
  history: ReadonlyArray<RunEvent>,
  event: RunEvent,
  terminalHistory: ReadonlyArray<RunEvent> = history
) {
  if (event.type === "RUN_CONTROL_CONFIRMED") {
    const control = parseRunControlEventPayload(event.payload["control"]);
    if (
      control.workerAgentId !== agentId ||
      control.sessionId !== sessionIdForRun(runId) ||
      (control.operation !== "cancel" && control.operation !== "resume")
    ) {
      return undefined;
    }
    const snapshot = publicSnapshot(runId, agentId, history);
    return AgentSessionUpdateDto.make({
      agentId: snapshot.agentId,
      eventSequence: event.sequence,
      runId,
      sessionId: snapshot.sessionId,
      snapshot,
      terminal: control.operation === "cancel",
    });
  }
  if (event.type !== "HARNESS_SESSION_EVENT_RECORDED") return undefined;
  const harnessEvent = parseHarnessEvent(event.payload.event);
  if (harnessEvent.sessionId !== sessionIdForRun(runId)) return undefined;
  const snapshot = publicSnapshot(runId, agentId, history);
  return AgentSessionUpdateDto.make({
    agentId: snapshot.agentId,
    eventSequence: event.sequence,
    runId,
    sessionId: snapshot.sessionId,
    snapshot,
    terminal:
      isTerminal(harnessEvent) &&
      !hasLaterRecoveryForTerminalFailure(
        terminalHistory,
        event.sequence,
        harnessEvent
      ),
  });
}

function isTerminal(event: HarnessEvent) {
  return (
    event.kind === "sessionFailed" ||
    event.kind === "turnCompleted" ||
    (event.kind === "sessionStateChanged" &&
      isTerminalSessionState(event.state))
  );
}

function hasLaterRecoveryForTerminalFailure(
  history: ReadonlyArray<RunEvent>,
  sequence: number,
  event: HarnessEvent
) {
  if (
    event.kind !== "sessionFailed" ||
    event.failure.kind !== "providerFailure" ||
    event.failure.recoverable !== true
  ) {
    return false;
  }
  return history.some((candidate) => {
    if (
      candidate.sequence <= sequence ||
      candidate.type !== "HARNESS_SESSION_EVENT_RECORDED"
    ) {
      return false;
    }
    const parsed = parseHarnessEvent(candidate.payload.event);
    return (
      parsed.sessionId === event.sessionId && parsed.kind === "sessionRecovered"
    );
  });
}

function isTerminalSessionState(
  state: Extract<
    HarnessEvent,
    { readonly kind: "sessionStateChanged" }
  >["state"]
) {
  return (
    state === "completed" || state === "interrupted" || state === "unavailable"
  );
}

function requireWorkerAgent(agentId: FactoryAgentId) {
  if (agentId !== issueDeliveryAgentIds.worker)
    throw makeRuntimeError({
      code: "FactoryAgentNotFound",
      message: "The selected agent does not own an interactive session.",
      recoverable: false,
    });
}

function actionBinding(
  agentId: FactoryAgentId,
  action: AgentOperatorActionRequest,
  payloadDigest: AgentActionReceiptDto["payloadDigest"]
) {
  return {
    actionId: action.actionId,
    actionKind: action.kind,
    agentId,
    payloadDigest,
    sessionId: action.sessionId,
    ...(action.kind === "followUp"
      ? {}
      : {
          targetId:
            action.kind === "steer" || action.kind === "interrupt"
              ? action.turnId
              : action.interactionId,
        }),
  } as const;
}

function actionDigest(
  runId: RunId,
  agentId: FactoryAgentId,
  action: AgentOperatorActionRequest
) {
  return createHash("sha256")
    .update(canonicalJson(actionDigestBinding(runId, agentId, action)))
    .digest("hex");
}

function actionDigestBinding(
  runId: RunId,
  agentId: FactoryAgentId,
  action: AgentOperatorActionRequest
) {
  const base = {
    actionId: action.actionId,
    agentId,
    kind: action.kind,
    runId,
    sessionId: action.sessionId,
  };
  switch (action.kind) {
    case "followUp":
      return base;
    case "steer":
    case "interrupt":
      return { ...base, turnId: action.turnId };
    case "approval":
      return {
        ...base,
        interactionId: action.interactionId,
      };
    case "userInput":
      return {
        ...base,
        interactionId: action.interactionId,
      };
    case "mcpElicitation":
      return {
        ...base,
        action: action.action,
        interactionId: action.interactionId,
      };
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function existingReceipt(
  events: ReadonlyArray<RunEvent>,
  runId: RunId,
  binding: ReturnType<typeof actionBinding>
) {
  const audits = events.flatMap((event) => {
    if (event.type !== "HARNESS_SESSION_EVENT_RECORDED") return [];
    const parsed = parseHarnessEvent(event.payload.event);
    return "actionId" in parsed && parsed.actionId === binding.actionId
      ? [{ event, parsed }]
      : [];
  });
  if (audits.length === 0) return undefined;
  const first = audits[0]?.parsed;
  if (
    first === undefined ||
    first.payloadDigest !== binding.payloadDigest ||
    first.agentId !== binding.agentId ||
    first.sessionId !== binding.sessionId ||
    first.actionKind !== binding.actionKind ||
    first.targetId !== binding.targetId
  )
    throw makeRuntimeError({
      code: "AgentActionConflict",
      message: "Action ID is already bound to a different immutable action.",
      recoverable: false,
    });
  if (
    binding.actionKind === "approval" ||
    binding.actionKind === "userInput" ||
    binding.actionKind === "mcpElicitation"
  )
    throw makeRuntimeError({
      code: "ResolutionReplayNotComparable",
      message:
        "The hidden interaction response is single-use and cannot be compared or redispatched. Read the current run control state.",
      recoverable: false,
    });
  const last = audits.at(-1)!;
  const state =
    last.parsed.kind === "operatorActionDispatchConfirmed"
      ? "dispatchConfirmed"
      : last.parsed.kind === "operatorActionDispatchFailed"
        ? "dispatchFailed"
        : "outcomeUnknown";
  return AgentActionReceiptDto.make({
    actionId: binding.actionId,
    agentId: binding.agentId,
    eventSequence: last.event.sequence,
    payloadDigest: binding.payloadDigest,
    runId,
    sessionId: binding.sessionId,
    state,
  });
}

function validateAction(
  snapshot: AgentSessionSnapshotDto,
  action: AgentOperatorActionRequest,
  events: ReadonlyArray<RunEvent>
) {
  if (snapshot.sessionId !== action.sessionId)
    throw makeRuntimeError({
      code: "AgentActionConflict",
      message: "Action session does not belong to the selected agent.",
      recoverable: false,
    });
  const activeTurn = snapshot.turns.find(
    (turn) => turn.status === "running" || turn.status === "waitingForOperator"
  );
  if (action.kind === "followUp") {
    if (!snapshot.capabilities.resumableSessions || activeTurn !== undefined)
      throw makeRuntimeError({
        code: "AgentActionConflict",
        message:
          "Follow-up is unavailable while a turn is active or the session is not resumable.",
        recoverable: false,
      });
    return;
  }
  if (action.kind === "steer" || action.kind === "interrupt") {
    const supported =
      action.kind === "steer"
        ? snapshot.capabilities.steering
        : snapshot.capabilities.interruption;
    if (!supported || activeTurn?.turnId !== action.turnId)
      throw makeRuntimeError({
        code: "AgentActionConflict",
        message: "Action does not target the active supported turn.",
        recoverable: false,
      });
    return;
  }
  const pending = snapshot.pendingInteractions.find(
    (candidate) => candidate.interactionId === action.interactionId
  );
  if (pending === undefined)
    throw makeRuntimeError({
      code: "AgentActionConflict",
      message: "Interaction is stale, unknown, or already resolved.",
      recoverable: false,
    });
  const competing = events.some(
    (event) =>
      event.type === "HARNESS_SESSION_EVENT_RECORDED" &&
      (() => {
        const parsed = parseHarnessEvent(event.payload.event);
        return (
          "targetId" in parsed &&
          parsed.targetId === action.interactionId &&
          parsed.actionId !== action.actionId &&
          parsed.kind !== "operatorActionDispatchFailed"
        );
      })()
  );
  if (competing)
    throw makeRuntimeError({
      code: "AgentActionConflict",
      message: "Another action already owns this interaction.",
      recoverable: false,
    });
  if (action.kind === "approval") {
    if (
      !("allowedDecisions" in pending) ||
      !pending.allowedDecisions.includes(action.decision)
    )
      throw makeRuntimeError({
        code: "AgentActionConflict",
        message: "Approval decision is not allowed by the pending interaction.",
        recoverable: false,
      });
    return;
  }
  if (action.kind === "userInput") {
    if (
      pending.kind !== "userInput" ||
      !snapshot.capabilities.userQuestions ||
      !snapshot.capabilities.approvals.includes("userInput")
    )
      throw makeRuntimeError({
        code: "AgentActionConflict",
        message: "User input is not supported by this pending interaction.",
        recoverable: false,
      });
    const expected = pending.questions
      .map(({ questionId }) => questionId)
      .toSorted();
    const actual = action.answers
      .map(({ questionId }) => questionId)
      .toSorted();
    if (
      new Set(actual).size !== actual.length ||
      JSON.stringify(actual) !== JSON.stringify(expected)
    )
      throw makeRuntimeError({
        code: "AgentActionConflict",
        message:
          "User input answers must match every pending question exactly once.",
        recoverable: false,
      });
    return;
  }
  if (
    pending.kind !== "mcpElicitation" ||
    !snapshot.capabilities.approvals.includes("mcpElicitation")
  )
    throw makeRuntimeError({
      code: "AgentActionConflict",
      message: "MCP elicitation is not supported by this pending interaction.",
      recoverable: false,
    });
}

function dispatchToSession(
  session: HarnessSession,
  action: AgentOperatorActionRequest,
  recordedInput: string | undefined
): Effect.Effect<HarnessActionTransportWitness | undefined, unknown> {
  switch (action.kind) {
    case "followUp":
      return session.send(
        HarnessInput.make({ text: recordedInput ?? action.text })
      );
    case "steer":
      return Option.match(session.steer, {
        onNone: () =>
          Effect.fail(
            makeRuntimeError({
              code: "AgentSessionUnavailable",
              message: "Steering handle is unavailable.",
              recoverable: true,
            })
          ),
        onSome: (steer) =>
          steer(HarnessInput.make({ text: recordedInput ?? action.text })),
      });
    case "interrupt":
      return Option.match(session.interrupt, {
        onNone: () =>
          Effect.fail(
            makeRuntimeError({
              code: "AgentSessionUnavailable",
              message: "Interrupt handle is unavailable.",
              recoverable: true,
            })
          ),
        onSome: (interrupt) => interrupt.pipe(Effect.as(undefined)),
      });
    case "approval":
      return session
        .resolveInteraction({
          actionId: action.actionId,
          decision: action.decision,
          interactionId: action.interactionId,
          kind: "approval",
        })
        .pipe(Effect.as(undefined));
    case "userInput":
      return session
        .resolveInteraction({
          actionId: action.actionId,
          answers: action.answers,
          interactionId: action.interactionId,
          kind: "userInput",
        })
        .pipe(Effect.as(undefined));
    case "mcpElicitation":
      return session
        .resolveInteraction({
          actionId: action.actionId,
          action: action.action,
          ...(action.content === undefined ? {} : { content: action.content }),
          interactionId: action.interactionId,
          kind: "mcpElicitation",
        })
        .pipe(Effect.as(undefined));
  }
}

function sessionIdForRun(runId: RunId): HarnessSessionId {
  return parseHarnessSessionId(`session-${runId}`);
}

function isInteractionAction(
  action: AgentOperatorActionRequest
): action is Extract<
  AgentOperatorActionRequest,
  { kind: "approval" | "userInput" | "mcpElicitation" }
> {
  return (
    action.kind === "approval" ||
    action.kind === "userInput" ||
    action.kind === "mcpElicitation"
  );
}

function resolutionFromAction(
  action: Extract<
    AgentOperatorActionRequest,
    { kind: "approval" | "userInput" | "mcpElicitation" }
  >
) {
  return Effect.gen(function* () {
    const resolvedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    return Schema.decodeUnknownSync(HarnessInteractionResolutionSchema)(
      action.kind === "approval"
        ? {
            actionId: action.actionId,
            decision: action.decision,
            interactionId: action.interactionId,
            kind: "approval",
            resolvedAt,
          }
        : action.kind === "userInput"
          ? {
              actionId: action.actionId,
              decision: "submit",
              interactionId: action.interactionId,
              kind: "userInput",
              resolvedAt,
            }
          : {
              actionId: action.actionId,
              decision: action.action,
              interactionId: action.interactionId,
              kind: "mcpElicitation",
              resolvedAt,
            }
    );
  });
}
