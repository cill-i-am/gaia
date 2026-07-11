import {
  parseMarkdownSpec,
  HarnessExecutionSelection,
  parseHarnessEvent,
  parseHarnessSessionId,
  parseRunId,
  ResolvedHarnessExecution,
  snapshotFromReplay,
  type GaiaFailure,
  type RunEvent,
  type RunId,
  type RunState,
} from "@gaia/core";
import { customAlphabet } from "nanoid";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { appendEvent, loadRun } from "./event-store.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import {
  HarnessProfileNotFoundError,
  issueDeliveryWorkerHarnessCapabilities,
  type HarnessProviderRegistry,
} from "./harness-provider-registry.js";
import {
  HarnessCapabilityMismatchError,
  HarnessDetectionError,
  HarnessIncompatibleError,
  HarnessUnavailableError,
} from "./harness-session.js";
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
import {
  continueAcceptedRun,
  type CommandSummary,
  type WorkerContinuationState,
} from "./workflows.js";
import { interactiveSessionHarness } from "./interactive-harness.js";
import type { LiveHarnessSessionCoordinator } from "./agent-session-runtime.js";
import {
  localDirectoryWorkspaceSource,
  type WorkspaceSource,
} from "./workspace.js";
import {
  isGitRepository,
  parseDeliveryProvenance,
  prepareDeliveryWorktree,
  resolveDeliveryProvenance,
  type DeliveryProvenance,
  type GitDeliveryCommandRunner,
} from "./git-delivery.js";

const nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
  10,
);

export type ServerWorkflowOptions = RunStorageOptions & ReviewerRunOptions & {
  readonly deliveryGitCommandRunner?: GitDeliveryCommandRunner;
  readonly harnessProviderRegistry?: HarnessProviderRegistry;
  readonly sessionCoordinator?: LiveHarnessSessionCoordinator;
  readonly workspaceSource?: WorkspaceSource;
};

const encodeResolvedHarnessExecution = Schema.encodeSync(
  ResolvedHarnessExecution,
);
const decodeHarnessExecutionSelection = Schema.decodeUnknownSync(
  HarnessExecutionSelection,
);
const decodeResolvedHarnessExecution = Schema.decodeUnknownSync(
  ResolvedHarnessExecution,
);

export type ServerRunAcceptance = {
  readonly acceptedAt: string;
  readonly eventSequence: number;
  readonly runDirectory: string;
  readonly runId: RunId;
};

export type ServerRunReconciliation = {
  readonly reconciledRunIds: ReadonlyArray<RunId>;
  readonly resumableRunIds: ReadonlyArray<RunId>;
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

    const registry = options.harnessProviderRegistry;
    if (registry === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessProviderRegistryMissing",
          message: "No harness provider registry is available for this run.",
          recoverable: true,
        }),
      );
    }
    const resolved = yield* registry
      .resolve(
        input.execution,
        issueDeliveryWorkerHarnessCapabilities,
      )
      .pipe(Effect.mapError(harnessAcceptanceError));

    const runId = yield* generateRunId;
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;
    const delivery = yield* acceptedDeliveryProvenance(runId, options);

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
        execution: {
          resolved: encodeResolvedHarnessExecution(resolved.execution),
          selection: {
            harnessProfileId: input.execution.harnessProfileId,
          },
        },
        ...(delivery === undefined ? {} : { delivery }),
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

    return yield* Effect.gen(function* () {
      const continuationOptions =
        firstEvent.payload["workflow"] === "issueDelivery"
          ? yield* factoryContinuationOptions(firstEvent, loaded.events, options)
          : options;
      return yield* continueAcceptedRun(
        runId,
        paths,
        spec,
        continuationOptions,
      );
    }).pipe(
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
      return {
        reconciledRunIds: [],
        resumableRunIds: [],
      } satisfies ServerRunReconciliation;
    }

    const entries = yield* fs.readDirectory(store.runsRoot);
    const reconciledRunIds: Array<RunId> = [];
    const resumableRunIds: Array<RunId> = [];

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

      if (firstEvent.payload["workflow"] === "issueDelivery") {
        reconciledRunIds.push(runId);
        resumableRunIds.push(runId);
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

    return { reconciledRunIds, resumableRunIds } satisfies ServerRunReconciliation;
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
    case "delivering":
    case "preparingWorkspace":
      return "preparingWorkspace";
    case "runningWorker":
      return "runningWorker";
    case "verifying":
      return "verifying";
    case "reporting":
    case "readyToPublish":
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

function harnessAcceptanceError(error: unknown): GaiaRuntimeError {
  if (error instanceof HarnessProfileNotFoundError) {
    return makeRuntimeError({
      code: "HarnessProfileNotFound",
      message: "The selected harness profile is not registered.",
      recoverable: false,
    });
  }
  if (error instanceof HarnessCapabilityMismatchError) {
    return makeRuntimeError({
      code: "HarnessCapabilityMismatch",
      message: "The selected harness provider lacks required capabilities.",
      recoverable: false,
    });
  }
  if (error instanceof HarnessIncompatibleError) {
    return makeRuntimeError({
      code: "HarnessIncompatible",
      message: "The selected harness provider version is incompatible.",
      recoverable: false,
    });
  }
  if (error instanceof HarnessUnavailableError) {
    return makeRuntimeError({
      code:
        error.state === "authenticationRequired"
          ? "HarnessAuthenticationRequired"
          : "HarnessUnavailable",
      message:
        error.state === "authenticationRequired"
          ? "The selected harness provider requires authentication."
          : "The selected harness provider is unavailable.",
      recoverable: true,
    });
  }
  if (error instanceof HarnessDetectionError) {
    return makeRuntimeError({
      code: "HarnessUnavailable",
      message: "The selected harness provider could not be detected.",
      recoverable: true,
    });
  }
  return makeRuntimeError({
    code: "HarnessUnavailable",
    message: "The selected harness provider could not be accepted.",
    recoverable: true,
  });
}

function factoryContinuationOptions(
  firstEvent: RunEvent,
  events: ReadonlyArray<RunEvent>,
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const paths = yield* makeRunPaths(firstEvent.runId, options);
    const delivery = parseDeliveryProvenance(firstEvent.payload["delivery"]).pipe(
      Option.getOrUndefined,
    );
    if (delivery !== undefined) {
      yield* prepareDeliveryWorktree({
        options: {
          rootDirectory,
          ...(options.deliveryGitCommandRunner === undefined
            ? {}
            : { commandRunner: options.deliveryGitCommandRunner }),
        },
        paths,
        provenance: delivery,
      });
      if (!events.some(({ type }) => type === "DELIVERY_STARTED")) {
        yield* appendEvent(firstEvent.runId, paths, {
          payload: {
            delivery: {
              ...delivery,
              status: "delivering",
            },
          },
          type: "DELIVERY_STARTED",
        });
      }
    }
    const execution = firstEvent.payload["execution"];
    const acceptedExecution = yield* Effect.try({
      try: () => ({
        resolved: decodeResolvedHarnessExecution(
          jsonObjectField(execution, "resolved"),
        ),
        selection: decodeHarnessExecutionSelection(
          jsonObjectField(execution, "selection"),
        ),
      }),
      catch: () =>
        makeRuntimeError({
          code: "HarnessExecutionSelectionUnreadable",
          message: "Accepted run harness execution is missing or corrupt.",
          recoverable: false,
        }),
    });
    if (
      acceptedExecution.selection.harnessProfileId !==
      acceptedExecution.resolved.harnessProfileId
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessExecutionSelectionMismatch",
          message: "Accepted run harness selection does not match its resolution.",
          recoverable: false,
        }),
      );
    }
    const commonOptions = {
      ...options,
      ...(delivery === undefined ? {} : { deliveryProvenance: delivery }),
      ...(delivery === undefined
        ? { workspaceSource: options.workspaceSource ?? localDirectoryWorkspaceSource(rootDirectory) }
        : {}),
    };
    const sessionEvents = issueDeliveryWorkerSessionEvents(
      firstEvent.runId,
      events,
    );
    if (
      sessionEvents.some(
        (event) =>
          event.kind === "sessionStarted" &&
          event.provider.providerId !==
            acceptedExecution.resolved.provider.providerId,
      )
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessSessionProviderMismatch",
          message:
            "Persisted harness session does not match the accepted provider.",
          recoverable: false,
        }),
      );
    }
    const continuationState = issueDeliveryWorkerContinuationState(
      events,
      sessionEvents,
    );
    if (continuationState === "invalid") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessWorkerCompletionMismatch",
          message: "Persisted worker completion has no canonical completed turn.",
          recoverable: false,
        }),
      );
    }
    if (continuationState === "completed") {
      return {
        ...commonOptions,
        workerContinuationState: continuationState,
      };
    }
    if (continuationState === "terminal") {
      return {
        ...commonOptions,
        workerContinuationState: continuationState,
        workerHarness: interactiveSessionHarness({
          rootDirectory,
          ...(options.sessionCoordinator === undefined ? {} : { sessionCoordinator: options.sessionCoordinator }),
        }),
      };
    }

    const registry = options.harnessProviderRegistry;
    if (registry === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessProviderRegistryMissing",
          message: "No harness provider registry is available for this run.",
          recoverable: true,
        }),
      );
    }
    const resolved = yield* registry
      .resolve(
        acceptedExecution.selection,
        issueDeliveryWorkerHarnessCapabilities,
      )
      .pipe(Effect.mapError(harnessAcceptanceError));
    if (
      JSON.stringify(encodeResolvedHarnessExecution(resolved.execution)) !==
      JSON.stringify(encodeResolvedHarnessExecution(acceptedExecution.resolved))
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessExecutionResolutionChanged",
          message: "Resolved harness execution changed after run acceptance.",
          recoverable: false,
        }),
      );
    }
    return {
      ...commonOptions,
      workerContinuationState: continuationState,
      workerHarness: interactiveSessionHarness({
        provider: resolved.provider,
        rootDirectory,
        ...(options.sessionCoordinator === undefined ? {} : { sessionCoordinator: options.sessionCoordinator }),
      }),
    };
  });
}

function acceptedDeliveryProvenance(runId: RunId, options: ServerWorkflowOptions) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const isRepo = yield* isGitRepository({
      rootDirectory,
      ...(options.deliveryGitCommandRunner === undefined
        ? {}
        : { commandRunner: options.deliveryGitCommandRunner }),
    });
    if (!isRepo) return undefined;
    return yield* resolveDeliveryProvenance(runId, {
      rootDirectory,
      ...(options.deliveryGitCommandRunner === undefined
        ? {}
        : { commandRunner: options.deliveryGitCommandRunner }),
    });
  });
}

/** Replay table: no session -> start, live session -> resume, first terminal -> own it. */
function issueDeliveryWorkerContinuationState(
  events: ReadonlyArray<RunEvent>,
  sessionEvents: ReadonlyArray<ReturnType<typeof parseHarnessEvent>>,
): WorkerContinuationState | "invalid" {
  const workerCompletionPersisted = events.some(
    ({ type }) => type === "WORKER_COMPLETED",
  );
  const terminal = sessionEvents.find(
    ({ kind }) => kind === "turnCompleted" || kind === "sessionFailed",
  );
  if (terminal === undefined) {
    if (workerCompletionPersisted) return "invalid";
    return sessionEvents.length === 0 ? "start" : "resume";
  }
  if (
    terminal.kind === "turnCompleted" &&
    terminal.status === "completed" &&
    workerCompletionPersisted
  ) {
    return "completed";
  }
  return "terminal";
}

function issueDeliveryWorkerSessionEvents(
  runId: RunId,
  events: ReadonlyArray<RunEvent>,
) {
  const sessionId = parseHarnessSessionId(`session-${runId}`);
  return events.flatMap((event) => {
    if (event.type !== "HARNESS_SESSION_EVENT_RECORDED") return [];
    const harnessEvent = parseHarnessEvent(event.payload.event);
    return harnessEvent.sessionId === sessionId ? [harnessEvent] : [];
  });
}

function jsonObjectField(value: Schema.Json | undefined, field: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}
