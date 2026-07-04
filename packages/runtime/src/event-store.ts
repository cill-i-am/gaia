import {
  makeRunEvent,
  parseRunEvent,
  parseRunSnapshot,
  replayRunEvents,
  snapshotFromReplay,
  type EventType,
  RunEvent,
  type RunId,
  RunSnapshot,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import { makeRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";

export type AppendEventInput = {
  readonly payload?: Readonly<Record<string, Schema.Json>>;
  readonly type: EventType;
};

export type LoadedRunState = {
  readonly events: ReadonlyArray<RunEvent>;
  readonly latestSnapshot: RunSnapshot | undefined;
};

export function appendEvent(
  runId: RunId,
  paths: RunPaths,
  input: AppendEventInput,
) {
  return Effect.gen(function* () {
    const existingEvents = yield* readEvents(paths);
    const sequence = existingEvents.length + 1;
    const timestamp = new Date().toISOString();
    const event =
      input.payload === undefined
        ? makeRunEvent({
            runId,
            sequence,
            timestamp,
            type: input.type,
          })
        : makeRunEvent({
            payload: input.payload,
            runId,
            sequence,
            timestamp,
            type: input.type,
          });
    const events = [...existingEvents, event];
    const snapshot = snapshotFromReplay(events);

    yield* appendJsonLine(paths.events, Schema.encodeSync(RunEvent)(event));
    yield* appendJsonLine(
      paths.snapshots,
      Schema.encodeSync(RunSnapshot)(snapshot),
    );

    return { event, snapshot };
  });
}

export function loadRun(
  paths: RunPaths,
): Effect.Effect<LoadedRunState, unknown, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const events = yield* readEvents(paths);
    const latestSnapshot = yield* readLatestSnapshot(paths);

    if (events.length > 0 && latestSnapshot !== undefined) {
      const replayed = snapshotFromReplay(events);
      if (
        replayed.eventSequence !== latestSnapshot.eventSequence ||
        replayed.state !== latestSnapshot.state
      ) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "SnapshotReplayMismatch",
            message: "Latest snapshot does not match replayed event log.",
            recoverable: false,
          }),
        );
      }
    }

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
      const parsed = parseRunEvent(parseJsonLine(line, paths.events, index + 1));

      if (parsed.sequence !== expectedSequence) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "InvalidEventSequence",
            message: `Event sequence mismatch at line ${index + 1}.`,
            recoverable: false,
          }),
        );
      }

      events.push(parsed);
      expectedSequence += 1;
    }

    replayRunEvents(events);
    return events;
  });
}

function readLatestSnapshot(paths: RunPaths) {
  return Effect.gen(function* () {
    const text = yield* readOptionalFile(paths.snapshots);
    if (text === undefined || text.trim().length === 0) {
      return undefined;
    }

    const lines = text.trimEnd().split(/\r?\n/u);
    const latestLine = lines.at(-1);
    if (latestLine === undefined) {
      return undefined;
    }

    return parseRunSnapshot(
      parseJsonLine(latestLine, paths.snapshots, lines.length),
    );
  });
}

function appendJsonLine(path: string, value: unknown) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(path, `${JSON.stringify(value)}\n`, {
      flag: "a",
    });
  });
}

function readOptionalFile(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path);
    if (!exists) {
      return undefined;
    }

    return yield* fs.readFileString(path);
  });
}

function parseJsonLine(line: string, path: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch (cause) {
    throw makeRuntimeError({
      cause,
      code: "InvalidJsonLine",
      message: `Invalid JSON in ${path} at line ${lineNumber}.`,
      recoverable: false,
    });
  }
}
