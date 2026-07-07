import { parseRunId, type RunId } from "@gaia/core";
import { Cause, Effect, FileSystem, Path, Ref } from "effect";
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
  readonly diagnosticsByRunId: ReadonlyMap<RunId, LocalRunReadDiagnostic>;
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
    diagnosticsByRunId: indexDiagnosticsByRunId(list.diagnostics),
    runsById: new Map(list.runs.map((run) => [run.runId, run])),
  };
}

function indexDiagnosticsByRunId(
  diagnostics: ReadonlyArray<LocalRunReadDiagnostic>,
): ReadonlyMap<RunId, LocalRunReadDiagnostic> {
  const byRunId = new Map<RunId, LocalRunReadDiagnostic>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.runId !== undefined) {
      byRunId.set(diagnostic.runId, diagnostic);
    }
  }

  return byRunId;
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
      const diagnostic = current.diagnosticsByRunId.get(runId);
      if (diagnostic !== undefined) {
        return yield* Effect.fail(diagnostic);
      }

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
      yield* Ref.update(snapshot, (current) =>
        storeSuccessfulRun(current, parsed, exit.value),
      );
      return;
    }

    const diagnostic = diagnosticFromCause(exit.cause, parsed);
    yield* Ref.update(snapshot, (current) => {
      if (diagnostic.code === "RunNotFound") {
        return removeRun(current, parsed);
      }

      return storeRunDiagnostic(removeRun(current, parsed), diagnostic);
    });
  });
}

function storeSuccessfulRun(
  snapshot: LocalRunIndexSnapshot,
  runId: RunId,
  run: LocalRunSummary,
): LocalRunIndexSnapshot {
  const diagnosticsByRunId = new Map(snapshot.diagnosticsByRunId);
  diagnosticsByRunId.delete(runId);
  return {
    diagnostics: removeRunDiagnostic(snapshot.diagnostics, runId),
    diagnosticsByRunId,
    runsById: new Map(snapshot.runsById).set(runId, run),
  };
}

function removeRun(
  snapshot: LocalRunIndexSnapshot,
  runId: RunId,
): LocalRunIndexSnapshot {
  const runsById = new Map(snapshot.runsById);
  runsById.delete(runId);
  const diagnosticsByRunId = new Map(snapshot.diagnosticsByRunId);
  diagnosticsByRunId.delete(runId);
  return {
    diagnostics: removeRunDiagnostic(snapshot.diagnostics, runId),
    diagnosticsByRunId,
    runsById,
  };
}

function storeRunDiagnostic(
  snapshot: LocalRunIndexSnapshot,
  diagnostic: LocalRunReadDiagnostic,
): LocalRunIndexSnapshot {
  if (diagnostic.runId === undefined) {
    return snapshot;
  }

  const diagnosticsByRunId = new Map(snapshot.diagnosticsByRunId);
  diagnosticsByRunId.set(diagnostic.runId, diagnostic);
  return {
    ...snapshot,
    diagnostics: [
      ...removeRunDiagnostic(snapshot.diagnostics, diagnostic.runId),
      diagnostic,
    ],
    diagnosticsByRunId,
  };
}

function removeRunDiagnostic(
  diagnostics: ReadonlyArray<LocalRunReadDiagnostic>,
  runId: RunId,
): ReadonlyArray<LocalRunReadDiagnostic> {
  return diagnostics.filter((diagnostic) => diagnostic.runId !== runId);
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

function diagnosticFromCause(
  cause: Cause.Cause<unknown>,
  runId: RunId,
): LocalRunReadDiagnostic {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && isReadDiagnostic(reason.error)) {
      return reason.error;
    }
  }

  return {
    code: "RunUnreadable",
    message: "Run could not be read from events.jsonl.",
    recoverable: false,
    runId,
  };
}

function isReadDiagnostic(input: unknown): input is LocalRunReadDiagnostic {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    "message" in input &&
    "recoverable" in input
  );
}
