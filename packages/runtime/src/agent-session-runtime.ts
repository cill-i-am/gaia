import { createHash } from "node:crypto";

import {
  AgentActionReceiptDto,
  AgentSessionSnapshotDto,
  AgentSessionUpdateDto,
  FactoryAgentIdSchema,
  HarnessInteractionResolutionSchema,
  parseHarnessEvent,
  replayHarnessSession,
  type AgentOperatorActionRequest,
  type HarnessEvent,
  type RunEvent,
  type RunId,
} from "@gaia/core";
import { Effect, Option, Schema, Stream } from "effect";

import { makeRuntimeError } from "./errors.js";
import {
  appendHarnessSessionEventWithinSerialization,
  readEvents,
  subscribeRunEventFeed,
  withRunEventSerialization,
} from "./event-store.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import { HarnessInput, type HarnessSession } from "./harness-session.js";
import { makeRunPaths, type RunStorageOptions } from "./paths.js";

type LiveSessionIdentity = {
  readonly agentId: string;
  readonly runId: RunId;
  readonly sessionId: string;
};
type LiveEntry = LiveSessionIdentity & { readonly session: HarnessSession };
type RegisteredLiveEntry = LiveEntry & { readonly generation: number };
type StoredLiveEntry = RegisteredLiveEntry & { readonly lease: symbol };

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
          sessions.set(entryKey, { ...entry, generation, lease });
          return { entryKey, lease } as const;
        }),
        ({ entryKey, lease }) =>
          Effect.sync(() => {
            if (sessions.get(entryKey)?.lease === lease)
              sessions.delete(entryKey);
          })
      ).pipe(Effect.asVoid),
    shutdown: Effect.sync(() => sessions.clear()),
  };
}

export function readAgentSessionSnapshot(
  runId: RunId,
  agentId: string,
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
  agentId: string,
  afterSequence: number | undefined,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    yield* expectRuntime(() => requireWorkerAgent(agentId));
    const paths = yield* makeRunPaths(runId, options);
    const subscription = yield* subscribeRunEventFeed(paths);
    if (
      afterSequence !== undefined &&
      (!Number.isInteger(afterSequence) || afterSequence < 1)
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "InvalidRequest",
          message: "Agent stream cursor must be a positive Gaia sequence.",
          recoverable: false,
        })
      );
    }
    if (afterSequence !== undefined && afterSequence > subscription.highWater) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "AgentStreamCursorConflict",
          message: "Agent stream cursor is ahead of authoritative run history.",
          recoverable: true,
        })
      );
    }
    const cursor = afterSequence ?? 0;
    const backlogEvents = subscription.backlog.filter(
      (event) =>
        event.sequence > cursor && event.sequence <= subscription.highWater
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

export function dispatchAgentSessionAction(input: {
  readonly action: AgentOperatorActionRequest;
  readonly agentId: string;
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
        const intent = yield* appendHarnessSessionEventWithinSerialization(
          input.runId,
          paths,
          { ...binding, kind: "operatorActionIntentRecorded" }
        );
        yield* appendHarnessSessionEventWithinSerialization(
          input.runId,
          paths,
          { ...binding, kind: "operatorActionDispatchAttempted" }
        );
        return { intentSequence: intent.event.sequence, snapshot } as const;
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
    const dispatchExit = yield* Effect.exit(
      dispatchToSession(live.session, input.action)
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
          { ...binding, kind: "operatorActionDispatchConfirmed" }
        );
        if (isInteractionAction(input.action)) {
          yield* appendHarnessSessionEventWithinSerialization(
            input.runId,
            paths,
            {
              kind: "interactionResolved",
              resolution: resolutionFromAction(input.action),
              sessionId: input.action.sessionId,
            }
          );
        }
        return AgentActionReceiptDto.make({
          actionId: input.action.actionId,
          agentId: Schema.decodeUnknownSync(FactoryAgentIdSchema)(
            input.agentId
          ),
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
  agentId: string,
  events: ReadonlyArray<RunEvent>
) {
  const sessionId = `session-${runId}`;
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
  const snapshot = replayHarnessSession(
    events,
    Schema.decodeUnknownSync(
      Schema.NonEmptyString.pipe(Schema.brand("HarnessSessionId"))
    )(sessionId)
  );
  return AgentSessionSnapshotDto.make({
    agentId: Schema.decodeUnknownSync(FactoryAgentIdSchema)(agentId),
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
  agentId: string,
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
  agentId: string,
  history: ReadonlyArray<RunEvent>,
  event: RunEvent,
  terminalHistory: ReadonlyArray<RunEvent> = history
) {
  if (event.type !== "HARNESS_SESSION_EVENT_RECORDED") return undefined;
  const harnessEvent = parseHarnessEvent(event.payload.event);
  if (harnessEvent.sessionId !== `session-${runId}`) return undefined;
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

function requireWorkerAgent(agentId: string) {
  if (agentId !== issueDeliveryAgentIds.worker)
    throw makeRuntimeError({
      code: "FactoryAgentNotFound",
      message: "The selected agent does not own an interactive session.",
      recoverable: false,
    });
}

function actionBinding(
  agentId: string,
  action: AgentOperatorActionRequest,
  payloadDigest: string
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
  agentId: string,
  action: AgentOperatorActionRequest
) {
  return createHash("sha256")
    .update(canonicalJson(actionDigestBinding(runId, agentId, action)))
    .digest("hex");
}

function actionDigestBinding(
  runId: RunId,
  agentId: string,
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
        decision: action.decision,
        interactionId: action.interactionId,
      };
    case "userInput":
      return {
        ...base,
        answerShape: action.answers
          .map(({ answers, questionId }) => ({
            answerCount: answers.length,
            questionId,
          }))
          .toSorted((left, right) =>
            left.questionId.localeCompare(right.questionId)
          ),
        interactionId: action.interactionId,
      };
    case "mcpElicitation":
      return {
        ...base,
        action: action.action,
        contentProvided: action.content !== undefined,
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
  const last = audits.at(-1)!;
  const state =
    last.parsed.kind === "operatorActionDispatchConfirmed"
      ? "dispatchConfirmed"
      : last.parsed.kind === "operatorActionDispatchFailed"
        ? "dispatchFailed"
        : "outcomeUnknown";
  return AgentActionReceiptDto.make({
    actionId: binding.actionId,
    agentId: Schema.decodeUnknownSync(FactoryAgentIdSchema)(binding.agentId),
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
  action: AgentOperatorActionRequest
): Effect.Effect<void, unknown> {
  switch (action.kind) {
    case "followUp":
      return session.send(HarnessInput.make({ text: action.text }));
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
        onSome: (steer) => steer(HarnessInput.make({ text: action.text })),
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
        onSome: (interrupt) => interrupt,
      });
    case "approval":
      return session.resolveInteraction({
        actionId: action.actionId,
        decision: action.decision,
        interactionId: action.interactionId,
        kind: "approval",
      });
    case "userInput":
      return session.resolveInteraction({
        actionId: action.actionId,
        answers: action.answers,
        interactionId: action.interactionId,
        kind: "userInput",
      });
    case "mcpElicitation":
      return session.resolveInteraction({
        actionId: action.actionId,
        action: action.action,
        ...(action.content === undefined ? {} : { content: action.content }),
        interactionId: action.interactionId,
        kind: "mcpElicitation",
      });
  }
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
  const resolvedAt = new Date().toISOString();
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
}
