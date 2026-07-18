import {
  makeHarnessRunEvent,
  makeRunEvent,
  parseHarnessEvent,
  parseRunEvent,
  projectHarnessEvents,
  replayRunEvents,
  snapshotFromReplay,
  EventTypeSchema,
  type EventType,
  type HarnessEvent,
  type HarnessSessionId,
  RunEvent,
  type RunId,
  RunSnapshot,
} from "@gaia/core";
import {
  Effect,
  FileSystem,
  PartitionedSemaphore,
  Queue,
  Schema,
  Stream,
} from "effect";

import { makeRuntimeError } from "./errors.js";
import type { RunPaths, RuntimePath } from "./paths.js";

const AppendEventTypeSchema = EventTypeSchema.pipe(
  Schema.refine(
    (
      eventType
    ): eventType is Exclude<EventType, "HARNESS_SESSION_EVENT_RECORDED"> =>
      eventType !== "HARNESS_SESSION_EVENT_RECORDED"
  )
);

class AppendEventInputSchema extends Schema.Class<AppendEventInputSchema>(
  "AppendEventInput"
)({
  payload: Schema.optionalKey(RunEvent.fields.payload),
  type: AppendEventTypeSchema,
}) {}

export type AppendEventInput = AppendEventInputSchema;

class LoadedRunStateSchema extends Schema.Class<LoadedRunStateSchema>(
  "LoadedRunState"
)({
  events: Schema.Array(RunEvent),
  latestSnapshot: Schema.UndefinedOr(RunSnapshot),
}) {}

export type LoadedRunState = LoadedRunStateSchema;

const parseAppendEventInput = Schema.decodeUnknownSync(AppendEventInputSchema);
const parseEventType = Schema.decodeUnknownSync(EventTypeSchema);

type RunSubscriber = {
  overflowed: boolean;
  readonly queue: Queue.Queue<RunEvent>;
};
const runEventSemaphore = PartitionedSemaphore.makeUnsafe<RuntimePath>({
  permits: 1,
});
const runSubscribers = new Map<RuntimePath, Set<RunSubscriber>>();

/** Serialize sequence allocation, persistence, validation, and publication per run log. */
export function withRunEventSerialization<A, E, R>(
  paths: RunPaths,
  effect: Effect.Effect<A, E, R>
) {
  return runEventSemaphore.withPermits(paths.events, 1)(effect);
}

export function appendEvent(
  runId: RunId,
  paths: RunPaths,
  input: AppendEventInput
) {
  return withRunEventSerialization(
    paths,
    appendEventWithinSerialization(runId, paths, input)
  );
}

export function appendEventWithinSerialization(
  runId: RunId,
  paths: RunPaths,
  input: AppendEventInput
) {
  return Effect.gen(function* () {
    const eventType = parseEventType(input.type);
    if (eventType === "HARNESS_SESSION_EVENT_RECORDED") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "UnsafeHarnessEventAppend",
          message:
            "Harness session events must use the finite appendHarnessSessionEvent path.",
          recoverable: false,
        })
      );
    }
    const parsedInput = parseAppendEventInput(input);
    const existingEvents = yield* readEvents(paths);
    const sequence = existingEvents.length + 1;
    const timestamp = new Date().toISOString();
    const event =
      parsedInput.payload === undefined
        ? makeRunEvent({
            runId,
            sequence,
            timestamp,
            type: parsedInput.type,
          })
        : makeRunEvent({
            payload: parsedInput.payload,
            runId,
            sequence,
            timestamp,
            type: parsedInput.type,
          });
    const events = [...existingEvents, event];
    const snapshot = snapshotFromReplay(events);

    yield* appendJsonLine(paths.events, Schema.encodeSync(RunEvent)(event));
    yield* appendJsonLine(
      paths.snapshots,
      Schema.encodeSync(RunSnapshot)(snapshot)
    );

    yield* publishRunEvent(paths, event);
    return { event, snapshot };
  }).pipe(Effect.uninterruptible);
}

/** Append one finite, bounded provider-neutral harness event to events.jsonl. */
export function appendHarnessSessionEvent(
  runId: RunId,
  paths: RunPaths,
  input: HarnessEvent
) {
  return withRunEventSerialization(
    paths,
    appendHarnessSessionEventWithinSerialization(runId, paths, input)
  );
}

/** Append while the caller already owns the per-run serialization permit. */
export function appendHarnessSessionEventWithinSerialization(
  runId: RunId,
  paths: RunPaths,
  input: HarnessEvent
) {
  return Effect.gen(function* () {
    const existingEvents = yield* readEvents(paths);
    const parsed = parseHarnessEvent(input);
    const event = makeHarnessRunEvent({
      event: parsed,
      runId,
      sequence: existingEvents.length + 1,
      timestamp: new Date().toISOString(),
    });
    validateHarnessEventHistories([...existingEvents, event]);
    const snapshot = snapshotFromReplay([...existingEvents, event]);

    yield* appendJsonLine(paths.events, Schema.encodeSync(RunEvent)(event));
    yield* appendJsonLine(
      paths.snapshots,
      Schema.encodeSync(RunSnapshot)(snapshot)
    );
    yield* publishRunEvent(paths, event);
    return { event, snapshot };
  }).pipe(Effect.uninterruptible);
}

/** Subscriber-first atomic snapshot used for gap-free backlog/live handoff. */
export function subscribeRunEventFeed(paths: RunPaths, capacity = 256) {
  return Effect.acquireRelease(
    withRunEventSerialization(
      paths,
      Effect.gen(function* () {
        const queue = yield* Queue.dropping<RunEvent>(capacity);
        const subscriber: RunSubscriber = { overflowed: false, queue };
        const subscribers =
          runSubscribers.get(paths.events) ?? new Set<RunSubscriber>();
        subscribers.add(subscriber);
        runSubscribers.set(paths.events, subscribers);
        const backlog = yield* readEvents(paths);
        return {
          backlog,
          highWater: backlog.at(-1)?.sequence ?? 0,
          live: Stream.fromQueue(queue).pipe(
            Stream.concat(
              Stream.fromEffect(
                Effect.suspend(() =>
                  subscriber.overflowed
                    ? Effect.fail(
                        makeRuntimeError({
                          code: "RunEventFeedOverflow",
                          message:
                            "Run event subscriber exceeded its bounded capacity.",
                          recoverable: true,
                        })
                      )
                    : Effect.void
                )
              ).pipe(Stream.drain)
            )
          ),
          subscriber,
        };
      })
    ),
    ({ subscriber }) =>
      withRunEventSerialization(
        paths,
        Effect.gen(function* () {
          const subscribers = runSubscribers.get(paths.events);
          subscribers?.delete(subscriber);
          if (subscribers?.size === 0) runSubscribers.delete(paths.events);
          yield* Queue.shutdown(subscriber.queue);
        })
      )
  ).pipe(
    Effect.map(({ subscriber: _subscriber, ...subscription }) => subscription)
  );
}

function publishRunEvent(paths: RunPaths, event: RunEvent) {
  return Effect.gen(function* () {
    for (const subscriber of runSubscribers.get(paths.events) ?? []) {
      const accepted = yield* Queue.offer(subscriber.queue, event);
      if (!accepted) {
        subscriber.overflowed = true;
        yield* Queue.shutdown(subscriber.queue);
      }
    }
  });
}

export function loadRun(
  paths: RunPaths
): Effect.Effect<LoadedRunState, unknown, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const events = yield* readEvents(paths);
    const latestSnapshot =
      events.length === 0 ? undefined : snapshotFromReplay(events);

    return { events, latestSnapshot };
  });
}

export function readEvents(paths: RunPaths) {
  return Effect.gen(function* () {
    const text = yield* readOptionalFile(paths.events);
    if (text === undefined || text.trim().length === 0) {
      return [];
    }

    const lines = text.trimEnd().split(/\r?\n/u);
    const events: Array<RunEvent> = [];
    let expectedSequence = 1;

    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;
      const parsed = yield* parseEventLine(
        yield* parseJsonLine(line, lineNumber),
        lineNumber
      );

      if (parsed.sequence !== expectedSequence) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "InvalidEventSequence",
            message: `Event sequence mismatch at line ${index + 1}.`,
            recoverable: false,
          })
        );
      }

      events.push(parsed);
      expectedSequence += 1;
    }

    validateHarnessEventHistories(events);
    replayRunEvents(events);
    return events;
  });
}

function validateHarnessEventHistories(events: ReadonlyArray<RunEvent>): void {
  const eventsBySession = new Map<HarnessSessionId, Array<HarnessEvent>>();
  for (const event of events) {
    if (event.type !== "HARNESS_SESSION_EVENT_RECORDED") continue;
    const harnessEvent = parseHarnessEvent(event.payload.event);
    const sessionEvents = eventsBySession.get(harnessEvent.sessionId);
    if (sessionEvents === undefined) {
      eventsBySession.set(harnessEvent.sessionId, [harnessEvent]);
    } else {
      sessionEvents.push(harnessEvent);
    }
  }
  for (const [sessionId, sessionEvents] of eventsBySession) {
    projectHarnessEvents(sessionEvents, sessionId);
  }
}

function appendJsonLine(path: RuntimePath, value: unknown) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(path, `${JSON.stringify(value)}\n`, {
      flag: "a",
    });
  });
}

function readOptionalFile(path: RuntimePath) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path);
    if (!exists) {
      return undefined;
    }

    return yield* fs.readFileString(path);
  });
}

function parseJsonLine(
  line: string,
  lineNumber: number
): Effect.Effect<unknown, ReturnType<typeof makeRuntimeError>> {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidJsonLine",
        message: `Invalid JSON in events.jsonl at line ${lineNumber}.`,
        recoverable: false,
      }),
    try: () => JSON.parse(line),
  });
}

function parseEventLine(input: unknown, lineNumber: number) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidEventLine",
        message: `Invalid event record in events.jsonl at line ${lineNumber}.`,
        recoverable: false,
      }),
    try: () => parseRunEvent(input),
  });
}
