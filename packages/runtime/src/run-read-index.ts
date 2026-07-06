import { parseRunId, type RunId } from "@gaia/core";
import { Effect, FileSystem, Path, Ref } from "effect";
import type { RunStorageOptions } from "./paths.js";
import {
  listLocalRuns,
  readLocalRun,
  type LocalRunDetail,
  type LocalRunList,
  type LocalRunReadDiagnostic,
  type LocalRunSummary,
} from "./run-read-api.js";

export type LocalRunReadIndex = {
  readonly list: Effect.Effect<LocalRunList>;
  readonly read: (
    runIdInput: string,
  ) => Effect.Effect<LocalRunDetail, LocalRunReadDiagnostic>;
  readonly rebuild: Effect.Effect<
    void,
    unknown,
    FileSystem.FileSystem | Path.Path
  >;
  readonly refreshRun: (
    runIdInput: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
};

type LocalRunIndexSnapshot = {
  readonly diagnostics: ReadonlyArray<LocalRunReadDiagnostic>;
  readonly runsById: ReadonlyMap<RunId, LocalRunSummary>;
};

export function makeLocalRunReadIndex(
  options: RunStorageOptions = {},
): Effect.Effect<
  LocalRunReadIndex,
  unknown,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const initial = yield* rebuildLocalRunIndexSnapshot(options);
    const snapshot = yield* Ref.make(initial);

    return {
      list: Ref.get(snapshot).pipe(Effect.map(listFromSnapshot)),
      read: (runIdInput) => readIndexedRun(snapshot, runIdInput),
      rebuild: rebuildLocalRunIndexSnapshot(options).pipe(
        Effect.flatMap((next) => Ref.set(snapshot, next)),
      ),
      refreshRun: (runIdInput) => refreshIndexedRun(snapshot, runIdInput, options),
    } satisfies LocalRunReadIndex;
  });
}

function rebuildLocalRunIndexSnapshot(options: RunStorageOptions) {
  return listLocalRuns(options).pipe(Effect.map(snapshotFromList));
}

function snapshotFromList(list: LocalRunList): LocalRunIndexSnapshot {
  return {
    diagnostics: list.diagnostics,
    runsById: new Map(list.runs.map((run) => [run.runId, run])),
  };
}

function listFromSnapshot(snapshot: LocalRunIndexSnapshot): LocalRunList {
  return {
    diagnostics: snapshot.diagnostics,
    runs: [...snapshot.runsById.values()].sort(compareRunsDescending),
  };
}

function compareRunsDescending(left: LocalRunSummary, right: LocalRunSummary) {
  if (left.runId < right.runId) {
    return 1;
  }

  if (left.runId > right.runId) {
    return -1;
  }

  return 0;
}

function readIndexedRun(
  snapshot: Ref.Ref<LocalRunIndexSnapshot>,
  runIdInput: string,
) {
  return Effect.gen(function* () {
    const runId = yield* parseRequestedRunId(runIdInput);
    const current = yield* Ref.get(snapshot);
    const run = current.runsById.get(runId);
    if (run === undefined) {
      return yield* Effect.fail(runNotFoundDiagnostic(runId));
    }

    return run;
  });
}

function refreshIndexedRun(
  snapshot: Ref.Ref<LocalRunIndexSnapshot>,
  runIdInput: string,
  options: RunStorageOptions,
) {
  return Effect.gen(function* () {
    const parsed = parseRunIdSafely(runIdInput);
    if (parsed === undefined) {
      return;
    }

    const exit = yield* Effect.exit(readLocalRun(parsed, options));
    if (exit._tag === "Success") {
      yield* Ref.update(snapshot, (current) => ({
        ...current,
        runsById: new Map(current.runsById).set(parsed, exit.value),
      }));
      return;
    }

    yield* Ref.update(snapshot, (current) => {
      if (!current.runsById.has(parsed)) {
        return current;
      }

      const runsById = new Map(current.runsById);
      runsById.delete(parsed);
      return {
        ...current,
        runsById,
      };
    });
  });
}

function parseRequestedRunId(
  runIdInput: string,
): Effect.Effect<RunId, LocalRunReadDiagnostic> {
  return Effect.try({
    try: () => parseRunId(runIdInput),
    catch: () => invalidRunIdDiagnostic(runIdInput),
  });
}

function parseRunIdSafely(input: string): RunId | undefined {
  try {
    return parseRunId(input);
  } catch {
    return undefined;
  }
}

function runNotFoundDiagnostic(runId: RunId): LocalRunReadDiagnostic {
  return {
    code: "RunNotFound",
    message: "Run directory does not exist.",
    recoverable: false,
    runId,
  };
}

function invalidRunIdDiagnostic(pathSegment: string): LocalRunReadDiagnostic {
  return {
    code: "InvalidRunId",
    message: "Requested run id is not a valid Gaia run id.",
    pathSegment,
    recoverable: false,
  };
}
