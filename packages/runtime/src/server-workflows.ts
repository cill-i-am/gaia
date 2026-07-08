import {
  parseMarkdownSpec,
  parseRunId,
  snapshotFromReplay,
  type GaiaFailure,
  type RunId,
  type RunState,
} from "@gaia/core";
import { customAlphabet } from "nanoid";
import { Effect, FileSystem, Path } from "effect";
import { appendEvent, loadRun } from "./event-store.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import {
  writeInitialFactoryRunIndexes,
  type FactoryRunCreateInput,
} from "./factory-run-store.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import type { ReviewerRunOptions } from "./reviewer.js";
import { withRunStoreLock } from "./run-store-lock.js";
import { continueAcceptedRun, type CommandSummary } from "./workflows.js";

const nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
  10,
);

export type ServerWorkflowOptions = RunStorageOptions & ReviewerRunOptions;

export type ServerRunAcceptance = {
  readonly acceptedAt: string;
  readonly eventSequence: number;
  readonly runDirectory: string;
  readonly runId: RunId;
};

export type ServerRunReconciliation = {
  readonly reconciledRunIds: ReadonlyArray<RunId>;
};

export function acceptServerRun(
  input: {
    readonly specMarkdown: string;
    readonly title?: string | undefined;
  },
  options: ServerWorkflowOptions = {},
) {
  return withRunStoreLock(
    options,
    acceptServerRunUnlocked(input, options),
    {
      nextSafeAction:
        "Wait for the active Gaia server run acceptance to finish, then retry.",
      operation: "Gaia server run acceptance",
    },
  ).pipe(Effect.mapError(toServerWorkflowError("ServerRunAcceptFailed")));
}

export function acceptFactoryRun(
  input: FactoryRunCreateInput,
  options: ServerWorkflowOptions = {},
) {
  return withRunStoreLock(
    options,
    acceptFactoryRunUnlocked(input, options),
    {
      nextSafeAction:
        "Wait for the active Gaia factory run acceptance to finish, then retry.",
      operation: "Gaia factory run acceptance",
    },
  ).pipe(Effect.mapError(toServerWorkflowError("FactoryRunAcceptFailed")));
}

function acceptServerRunUnlocked(
  input: {
    readonly specMarkdown: string;
    readonly title?: string | undefined;
  },
  options: ServerWorkflowOptions,
): Effect.Effect<
  ServerRunAcceptance,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    yield* parseServerSpec(input);

    const runId = yield* generateRunId;
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;

    yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunAcceptFailed",
          message: "Gaia server could not create the accepted run directory.",
          recoverable: true,
        }),
      ),
    );
    yield* fs.writeFileString(paths.input, input.specMarkdown).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunAcceptFailed",
          message: "Gaia server could not persist the accepted run input.",
          recoverable: true,
        }),
      ),
    );
    yield* fs.writeFileString(paths.latest, runId).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunAcceptFailed",
          message: "Gaia server could not update the latest-run pointer.",
          recoverable: true,
        }),
      ),
    );
    const { event } = yield* appendEvent(runId, paths, {
      payload: { source: "server", specPath: "input.md" },
      type: "RUN_CREATED",
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof GaiaRuntimeError
          ? cause
          : makeRuntimeError({
              cause,
              code: "ServerRunAcceptFailed",
              message: "Gaia server could not append RUN_CREATED.",
              recoverable: true,
            }),
      ),
    );

    return {
      acceptedAt: event.timestamp,
      eventSequence: event.sequence,
      runDirectory: paths.root,
      runId,
    } satisfies ServerRunAcceptance;
  });
}

function acceptFactoryRunUnlocked(
  input: FactoryRunCreateInput,
  options: ServerWorkflowOptions,
): Effect.Effect<
  ServerRunAcceptance,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    yield* parseServerSpec({
      specMarkdown: input.workItem.description,
      title: input.workItem.title,
    });

    const runId = yield* generateRunId;
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;

    yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunAcceptFailed",
          message: "Gaia server could not create the accepted factory run directory.",
          recoverable: true,
        }),
      ),
    );
    yield* fs.writeFileString(paths.input, input.workItem.description).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunAcceptFailed",
          message: "Gaia server could not persist the accepted factory run input.",
          recoverable: true,
        }),
      ),
    );
    yield* fs.writeFileString(paths.latest, runId).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunAcceptFailed",
          message: "Gaia server could not update the latest-run pointer.",
          recoverable: true,
        }),
      ),
    );
    const { event } = yield* appendEvent(runId, paths, {
      payload: {
        source: "server",
        specPath: "input.md",
        workflow: input.workflow,
        workItem: {
          description: input.workItem.description,
          ...(input.workItem.externalRefs === undefined
            ? {}
            : {
                externalRefs: input.workItem.externalRefs.map((ref) => ({
                  id: ref.id,
                  provider: ref.provider,
                  ...(ref.url === undefined ? {} : { url: ref.url }),
                })),
              }),
          kind: input.workItem.kind,
          title: input.workItem.title,
        },
      },
      type: "RUN_CREATED",
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof GaiaRuntimeError
          ? cause
          : makeRuntimeError({
              cause,
              code: "FactoryRunAcceptFailed",
              message: "Gaia server could not append factory RUN_CREATED.",
              recoverable: true,
            }),
      ),
    );

    yield* writeInitialFactoryRunIndexes({
      paths,
      runId,
    }).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunProjectionWriteFailed",
          message: "Gaia server could not write initial factory run projections.",
          recoverable: true,
        }),
      ),
    );

    return {
      acceptedAt: event.timestamp,
      eventSequence: event.sequence,
      runDirectory: paths.root,
      runId,
    } satisfies ServerRunAcceptance;
  });
}

export function continueServerRun(
  runIdInput: string,
  options: ServerWorkflowOptions = {},
): Effect.Effect<
  CommandSummary,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return withRunStoreLock(
    options,
    continueServerRunUnlocked(runIdInput, options),
    {
      nextSafeAction:
        "Wait for the active Gaia server run continuation to finish, then retry.",
      operation: "Gaia server run continuation",
    },
  ).pipe(Effect.mapError(toServerWorkflowError("ServerRunContinuationFailed")));
}

function continueServerRunUnlocked(
  runIdInput: string,
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    const runId = yield* parseRunIdEffect(runIdInput);
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunUnreadable",
          message: `Gaia server could not read accepted run ${runId}.`,
          recoverable: true,
        }),
      ),
    );
    const firstEvent = loaded.events[0];
    if (
      firstEvent === undefined ||
      firstEvent.type !== "RUN_CREATED" ||
      firstEvent.payload["source"] !== "server"
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotServerCreated",
          message: `Run ${runId} was not accepted by the local Gaia server.`,
          recoverable: false,
        }),
      );
    }

    const snapshot = snapshotFromReplay(loaded.events);
    if (snapshot.state === "completed" || snapshot.state === "failed") {
      return {
        reportPath: snapshot.state === "completed" ? paths.reportMarkdown : undefined,
        runDirectory: paths.root,
        runId,
        state: snapshot.state,
        status: snapshot.state,
      } satisfies CommandSummary;
    }

    const fs = yield* FileSystem.FileSystem;
    const specMarkdown = yield* fs.readFileString(paths.input).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunInputUnreadable",
          message: `Gaia server could not read accepted input for ${runId}.`,
          recoverable: true,
        }),
      ),
    );
    const spec = yield* parseServerSpec({
      specMarkdown,
      title: runId,
    });

    return yield* continueAcceptedRun(runId, paths, spec, options).pipe(
      Effect.mapError((error) =>
        error instanceof GaiaRuntimeError
          ? error
          : makeRuntimeError({
              cause: error,
              code: "ServerRunContinuationFailed",
              message: `Gaia server could not continue accepted run ${runId}.`,
              recoverable: true,
            }),
      ),
      Effect.catchTag("GaiaRuntimeError", (error) =>
        failServerRunIfNeeded(runId, paths, "runningWorker", error),
      ),
    );
  });
}

export function reconcileInterruptedServerRuns(
  options: ServerWorkflowOptions = {},
) {
  return withRunStoreLock(
    options,
    reconcileInterruptedServerRunsUnlocked(options),
    {
      nextSafeAction:
        "Wait for local Gaia server startup reconciliation to finish, then retry.",
      operation: "Gaia server startup reconciliation",
    },
  ).pipe(Effect.mapError(toServerWorkflowError("ServerRunReconcileFailed")));
}

function reconcileInterruptedServerRunsUnlocked(
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);
    const exists = yield* fs.exists(store.runsRoot);
    if (!exists) {
      return { reconciledRunIds: [] } satisfies ServerRunReconciliation;
    }

    const entries = yield* fs.readDirectory(store.runsRoot);
    const reconciledRunIds: Array<RunId> = [];

    for (const entry of entries.filter((item) => item.startsWith("run-"))) {
      const runId = parseRunIdSafely(entry);
      if (runId === undefined) {
        continue;
      }

      const paths = yield* makeRunPaths(runId, options);
      const loadedExit = yield* Effect.exit(loadRun(paths));
      if (loadedExit._tag === "Failure") {
        continue;
      }

      const firstEvent = loadedExit.value.events[0];
      if (
        firstEvent === undefined ||
        firstEvent.type !== "RUN_CREATED" ||
        firstEvent.payload["source"] !== "server"
      ) {
        continue;
      }

      const snapshot = snapshotFromReplay(loadedExit.value.events);
      if (snapshot.state === "completed" || snapshot.state === "failed") {
        continue;
      }

      yield* appendEvent(runId, paths, {
        payload: failurePayload(
          makeRuntimeError({
            code: "ServerExecutionInterrupted",
            message:
              "Server process stopped before completing the accepted run.",
            recoverable: true,
          }),
          failureStageFromRunState(snapshot.state),
        ),
        type: "RUN_FAILED",
      });
      reconciledRunIds.push(runId);
    }

    return { reconciledRunIds } satisfies ServerRunReconciliation;
  });
}

function parseServerSpec(input: {
  readonly specMarkdown: string;
  readonly title?: string | undefined;
}) {
  return Effect.try({
    try: () => parseMarkdownSpec(input.specMarkdown, input.title ?? "server-run"),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidSpec",
        message: "Spec markdown could not be parsed.",
        recoverable: false,
      }),
  });
}

function failServerRunIfNeeded(
  runId: RunId,
  paths: RunPaths,
  stage: GaiaFailure["stage"],
  error: GaiaRuntimeError,
) {
  return Effect.gen(function* () {
    const loadedExit = yield* Effect.exit(loadRun(paths));
    if (loadedExit._tag === "Success") {
      const snapshot = snapshotFromReplay(loadedExit.value.events);
      if (snapshot.state === "failed") {
        return yield* Effect.fail(error);
      }
    }

    yield* appendEvent(runId, paths, {
      payload: failurePayload(error, stage),
      type: "RUN_FAILED",
    });
    return yield* Effect.fail(error);
  });
}

function failurePayload(
  error: GaiaRuntimeError,
  stage: GaiaFailure["stage"],
) {
  return {
    code: error.code,
    message: error.message,
    recoverable: error.recoverable,
    stage,
  };
}

function failureStageFromRunState(
  state: Exclude<RunState, "completed" | "failed">,
): GaiaFailure["stage"] {
  switch (state) {
    case "created":
      return "creating";
    case "preparingWorkspace":
      return "preparingWorkspace";
    case "runningWorker":
      return "runningWorker";
    case "verifying":
      return "verifying";
    case "reporting":
      return "reporting";
  }
}

function parseRunIdEffect(input: string) {
  return Effect.try({
    try: () => parseRunId(input),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidRunId",
        message: `Invalid Gaia run id '${input}'.`,
        recoverable: false,
      }),
  });
}

function parseRunIdSafely(input: string): RunId | undefined {
  try {
    return parseRunId(input);
  } catch {
    return undefined;
  }
}

const generateRunId = Effect.sync(() => parseRunId(`run-${nanoid()}`));

function toServerWorkflowError(code: string) {
  return (error: unknown) =>
    error instanceof GaiaRuntimeError
      ? error
      : makeRuntimeError({
          cause: error,
          code,
          message: "Gaia server workflow failed.",
          recoverable: true,
        });
}
