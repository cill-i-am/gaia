import {
  CreateRunAcceptedResponse,
  CreateRunRequest,
  codexAppServerExecutionSelection,
  FactoryArtifactBodyDto,
  FactoryRunDetailDto,
  FactoryRunSummaryDto,
  LocalRunApiErrorEnvelope,
  LocalRunArtifactDto,
  LocalRunEventsDto,
  type LocalGaiaServerUrl,
  type RunId,
  RunIdSchema,
  ServerMetadata,
} from "@gaia/core";
import {
  makeRunPaths,
  makeRunStorePaths,
  makeRuntimeError,
  type CommandSummary,
  type LocalRunArtifact,
  type LocalRunEvents,
  type LocalRunSummary,
} from "@gaia/runtime";
import { Cause, Effect, FileSystem, Option, Predicate, Schema } from "effect";
import { HttpClient, HttpClientError } from "effect/unstable/http";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRunFromLocalServerProtocol,
  evaluateMergeReadinessFromLocalServerProtocol,
  getRunArtifactFromLocalServerProtocol,
  getRunEventsFromLocalServerProtocol,
  getRunFromLocalServerProtocol,
  healthFromLocalServerProtocol,
  listRunsFromLocalServerProtocol,
  LocalGaiaServerProtocolClientLive,
  type LocalGaiaServerProtocolError,
} from "./local-server-protocol-client.js";

const autostartWaitAttempts = 50;
const autostartWaitDelay = "100 millis";
const decodeRunId = Schema.decodeUnknownSync(RunIdSchema);
const decodeLocalRunArtifact = Schema.decodeUnknownSync(LocalRunArtifactDto);
const decodeServerMetadata = Schema.decodeUnknownSync(ServerMetadata);

export type ServerRunAcceptedSummary =
  typeof CreateRunAcceptedResponse.Type & {
    readonly serverUrl: LocalGaiaServerUrl;
  };

export function evaluateMergeReadinessFromServer(input: {
  readonly actionId: string;
  readonly mergeMethod: "merge" | "rebase" | "squash";
  readonly runId: RunId;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return requestServer({
    dataName: "merge readiness decision",
    effect: evaluateMergeReadinessFromLocalServerProtocol({
      payload: { actionId: input.actionId, kind: "evaluateMergeReadiness", mergeMethod: input.mergeMethod },
      runId: input.runId,
      serverUrl: input.serverUrl,
    }),
    serverUrl: input.serverUrl,
  });
}

export function listRunsFromServer(input: {
  readonly rootDirectory: string;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return Effect.gen(function* () {
    const response = yield* requestServer({
      dataName: "run list",
      effect: listRunsFromLocalServerProtocol({
        serverUrl: input.serverUrl,
      }),
      serverUrl: input.serverUrl,
    });
    const list = response.data;
    const summaries: Array<CommandSummary> = [];
    for (const run of list.runs) {
      summaries.push(yield* commandSummaryFromLocalRun(run, input.rootDirectory));
    }

    return summaries;
  });
}

export function statusRunFromServer(input: {
  readonly rootDirectory: string;
  readonly runId?: RunId;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return Effect.gen(function* () {
    const runId =
      input.runId ?? (yield* latestRunIdFromPointer(input.rootDirectory));
    const response = yield* requestServer({
      dataName: "run status",
      effect: getRunFromLocalServerProtocol({
        runId,
        serverUrl: input.serverUrl,
      }),
      serverUrl: input.serverUrl,
    });

    return yield* commandSummaryFromLocalRun(response.data, input.rootDirectory);
  });
}

export function readLocalRunEventsFromServer(input: {
  readonly runId: RunId;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return requestServer({
    dataName: "run events",
    effect: getRunEventsFromLocalServerProtocol({
      runId: input.runId,
      serverUrl: input.serverUrl,
    }),
    serverUrl: input.serverUrl,
  }).pipe(Effect.map((response) => toLocalRunEvents(response.data)));
}

export function readLocalRunArtifactFromServer(input: {
  readonly artifactName: string;
  readonly runId: RunId;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return requestServer({
    dataName: "run artifact",
    effect: getRunArtifactFromLocalServerProtocol({
      artifactName: input.artifactName,
      runId: input.runId,
      serverUrl: input.serverUrl,
    }),
    serverUrl: input.serverUrl,
  }).pipe(Effect.map((response) => toLocalRunArtifact(response.data)));
}

export function createRunFromServer(input: {
  readonly rootDirectory: string;
  readonly serverUrl: LocalGaiaServerUrl;
  readonly specPath: string;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const specMarkdown = yield* fs.readFileString(input.specPath).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "SpecReadFailed",
          message: `Gaia could not read spec file ${input.specPath}.`,
          recoverable: false,
        }),
      ),
    );
    const payload = yield* CreateRunRequest.makeEffect({
      delivery: { mode: "local" },
      execution: codexAppServerExecutionSelection,
      workflow: "issueDelivery",
      workItem: {
        description: specMarkdown,
        kind: "issue",
        title: path.basename(input.specPath),
      },
    }).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "LocalRunApiInvalidResponse",
          message: "Local Gaia API returned invalid create run request data.",
          recoverable: false,
        }),
      ),
    );
    const accepted = yield* requestServer({
      dataName: "create run response",
      effect: createRunFromLocalServerProtocol({
        payload,
        serverUrl: input.serverUrl,
      }),
      serverUrl: input.serverUrl,
    });

    return {
      ...accepted,
      serverUrl: input.serverUrl,
    } satisfies ServerRunAcceptedSummary;
  });
}

export function ensureLocalServer(input: {
  readonly rootDirectory: string;
}) {
  return Effect.gen(function* () {
    const rootDirectory = yield* canonicalRoot(input.rootDirectory);
    const existing = yield* readUsableMetadata(rootDirectory);
    if (existing !== undefined) {
      return existing.url;
    }

    const lock = yield* acquireAutostartLock(rootDirectory);
    try {
      const afterLock = yield* readUsableMetadata(rootDirectory);
      if (afterLock !== undefined) {
        return afterLock.url;
      }

      const diagnostic = yield* rejectedServerMetadataDiagnostic(rootDirectory);
      if (diagnostic !== undefined) {
        yield* appendServerLog(rootDirectory, diagnostic);
      }

      const startedProcess = yield* startLocalServerProcess(rootDirectory);
      const started = yield* waitForUsableMetadata(rootDirectory, startedProcess).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => stopStartedProcess(startedProcess)).pipe(
              Effect.flatMap(() => Effect.fail(error)),
            ),
          onSuccess: Effect.succeed,
        }),
      );
      startedProcess.child.unref();
      return started.url;
    } finally {
      yield* lock.release;
    }
  });
}

function latestRunIdFromPointer(rootDirectory: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths({ rootDirectory });
    const exists = yield* fs.exists(store.latest);
    if (!exists) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "NoRunsFound",
          message: "No Gaia runs found through the local server.",
          recoverable: false,
        }),
      );
    }

    const latest = (yield* fs.readFileString(store.latest)).trim();
    return yield* decodeServerData(latest, decodeRunId, "latest run id");
  });
}

function requestServer<A>(input: {
  readonly dataName: string;
  readonly effect: Effect.Effect<
    A,
    LocalGaiaServerProtocolError,
    HttpClient.HttpClient
  >;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return input.effect.pipe(
    Effect.provide(LocalGaiaServerProtocolClientLive),
    Effect.mapError((error) =>
      runtimeErrorFromProtocolFailure(error, input.serverUrl, input.dataName),
    ),
  );
}

type StartedServerProcess = {
  readonly child: ChildProcess;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly error: () => unknown | undefined;
};

type AutostartLock = {
  readonly release: Effect.Effect<void>;
};

function acquireAutostartLock(rootDirectory: string) {
  return Effect.gen(function* () {
    const paths = yield* serverPaths(rootDirectory);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(paths.gaiaRoot, { recursive: true });

    for (let attempt = 0; attempt < autostartWaitAttempts; attempt += 1) {
      const existing = yield* readUsableMetadata(rootDirectory);
      if (existing !== undefined) {
        return {
          release: Effect.void,
        } satisfies AutostartLock;
      }

      const lock = tryAcquireAutostartLock(paths.serverStartLock);
      if (lock !== undefined) {
        return lock;
      }

      yield* Effect.sleep(autostartWaitDelay);
    }

    return yield* Effect.fail(
      makeRuntimeError({
        code: "LocalServerStartLocked",
        message: "Another Gaia local server autostart did not finish in time.",
        recoverable: true,
      }),
    );
  });
}

function tryAcquireAutostartLock(lockPath: string): AutostartLock | undefined {
  try {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    return {
      release: Effect.sync(() => {
        try {
          unlinkSync(lockPath);
        } catch {
          // The lock is best-effort process coordination and may already be gone.
        }
      }),
    };
  } catch {
    return undefined;
  }
}

function runtimeErrorFromProtocolFailure(
  error: LocalGaiaServerProtocolError,
  serverUrl: LocalGaiaServerUrl,
  dataName: string,
) {
  const apiError = Schema.decodeUnknownOption(LocalRunApiErrorEnvelope)(error);
  if (Option.isSome(apiError)) {
    return runtimeErrorFromDiagnostic(apiError.value);
  }

  if (HttpClientError.isHttpClientError(error) || Cause.isTimeoutError(error)) {
    return makeRuntimeError({
      cause: error,
      code: "LocalRunApiUnavailable",
      message: `Local Gaia API server is unavailable at ${serverUrl}. Direct runtime reads remain available without --server.`,
      recoverable: true,
    });
  }

  if (isProtocolParameterError(error)) {
    return runtimeErrorFromParameterFailure(error);
  }

  return makeRuntimeError({
    cause: error,
    code: "LocalRunApiInvalidResponse",
    message: `Local Gaia API returned invalid ${dataName} data.`,
    recoverable: false,
  });
}

function isProtocolParameterError(
  error: LocalGaiaServerProtocolError,
): error is Extract<
  LocalGaiaServerProtocolError,
  { readonly _tag: "LocalGaiaServerProtocolParameterError" }
> {
  return (
    Predicate.hasProperty(error, "_tag") &&
    error._tag === "LocalGaiaServerProtocolParameterError"
  );
}

function runtimeErrorFromParameterFailure(
  error: Extract<
    LocalGaiaServerProtocolError,
    { readonly _tag: "LocalGaiaServerProtocolParameterError" }
  >,
) {
  return makeRuntimeError({
    cause: error.cause,
    code: "ArtifactNotAllowed",
    message: "Artifact is not allowlisted for local API reads.",
    recoverable: false,
  });
}

function decodeServerData<A>(
  input: unknown,
  decode: (value: unknown) => A,
  dataName: string,
) {
  return Effect.try({
    try: () => decode(input),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "LocalRunApiInvalidResponse",
        message: `Local Gaia API returned invalid ${dataName} data.`,
        recoverable: false,
      }),
  });
}

function commandSummaryFromLocalRun(
  run: typeof FactoryRunSummaryDto.Type | typeof FactoryRunDetailDto.Type,
  rootDirectory: string,
) {
  return Effect.gen(function* () {
    const summary = toLocalRunSummary(run);
    const paths = yield* makeRunPaths(summary.runId, { rootDirectory });
    return {
      reportPath:
        summary.status === "completed" ? paths.reportMarkdown : undefined,
      runDirectory: paths.root,
      runId: summary.runId,
      state: summary.state,
      status: summary.status,
    } satisfies CommandSummary;
  });
}

function toLocalRunSummary(
  input: typeof FactoryRunSummaryDto.Type | typeof FactoryRunDetailDto.Type,
) {
  return {
    artifacts: [],
    createdAt: input.createdAt,
    eventCount: input.counts.activity,
    latestEventType: legacyEventTypeFromFactoryState(input.state),
    runId: input.runId,
    state: legacyRunStateFromFactoryState(input.state),
    status: legacyStatusFromFactoryState(input.state),
    updatedAt: input.updatedAt,
  } satisfies LocalRunSummary;
}

function toLocalRunEvents(input: typeof LocalRunEventsDto.Type) {
  return {
    events: input.events,
    runId: input.runId,
  } satisfies LocalRunEvents;
}

function toLocalRunArtifact(input: typeof FactoryArtifactBodyDto.Type) {
  const artifact = decodeLocalRunArtifact({
    artifactName: input.artifactId,
    body: input.body,
    contentType: input.contentType,
    runId: input.runId,
  });

  return {
    artifactName: artifact.artifactName,
    body: artifact.body,
    contentType: artifact.contentType,
    runId: artifact.runId,
  } satisfies LocalRunArtifact;
}

function legacyStatusFromFactoryState(state: typeof FactoryRunSummaryDto.Type.state) {
  switch (state) {
    case "succeeded":
      return "completed";
    case "canceled":
    case "failed":
      return "failed";
    case "blocked":
    case "pending":
    case "running":
    case "unknown":
      return "running";
  }
}

function legacyRunStateFromFactoryState(
  state: typeof FactoryRunSummaryDto.Type.state,
) {
  switch (state) {
    case "succeeded":
      return "completed";
    case "canceled":
    case "failed":
      return "failed";
    case "blocked":
    case "running":
      return "runningWorker";
    case "pending":
    case "unknown":
      return "created";
  }
}

function legacyEventTypeFromFactoryState(
  state: typeof FactoryRunSummaryDto.Type.state,
) {
  switch (state) {
    case "succeeded":
      return "REPORT_COMPLETED";
    case "canceled":
    case "failed":
      return "RUN_FAILED";
    case "blocked":
    case "running":
      return "WORKER_STARTED";
    case "pending":
    case "unknown":
      return "RUN_CREATED";
  }
}

function runtimeErrorFromDiagnostic(
  diagnostic: typeof LocalRunApiErrorEnvelope.Type,
) {
  return makeRuntimeError({
    code: diagnostic.code,
    message: diagnostic.message,
    recoverable: diagnostic.recoverable,
  });
}

function readUsableMetadata(rootDirectory: string) {
  return Effect.gen(function* () {
    const metadata = yield* readServerMetadata(rootDirectory);
    if (metadata === undefined) {
      return undefined;
    }

    const currentRoot = yield* canonicalRoot(rootDirectory);
    const metadataRoot = yield* canonicalRoot(metadata.workspaceRoot);
    const expectedUrl = trustedMetadataUrl(metadata);
    if (expectedUrl === undefined) {
      return undefined;
    }

    const health = yield* probeServerHealth(metadata).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const healthRoot =
      health === undefined ? undefined : yield* canonicalRoot(health.workspaceRoot);
    if (
      health === undefined ||
      health.serverId !== metadata.serverId ||
      health.url !== expectedUrl ||
      healthRoot !== currentRoot ||
      metadataRoot !== currentRoot
    ) {
      return undefined;
    }

    return metadata;
  });
}

function rejectedServerMetadataDiagnostic(rootDirectory: string) {
  return Effect.gen(function* () {
    const metadata = yield* readServerMetadata(rootDirectory);
    if (metadata === undefined) {
      return undefined;
    }

    const currentRoot = yield* canonicalRoot(rootDirectory);
    const metadataRoot = yield* canonicalRoot(metadata.workspaceRoot);
    const summary = serverMetadataSummary(metadata);
    const timestamp = new Date().toISOString();
    const expectedUrl = trustedMetadataUrl(metadata);
    if (expectedUrl === undefined) {
      return `${timestamp} discarding untrusted local server metadata ${summary}; expected loopback url from host/port; starting replacement server`;
    }

    if (metadataRoot !== currentRoot) {
      return `${timestamp} discarding wrong-root local server metadata ${summary} expectedWorkspaceRoot=${rootDirectory}; starting replacement server`;
    }

    const health = yield* probeServerHealth(metadata).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (health === undefined) {
      return `${timestamp} discarding stale local server metadata ${summary}; health probe failed; starting replacement server`;
    }

    const healthRoot = yield* canonicalRoot(health.workspaceRoot);
    if (healthRoot !== currentRoot) {
      return `${timestamp} discarding wrong-root local server metadata ${summary} healthWorkspaceRoot=${health.workspaceRoot} expectedWorkspaceRoot=${rootDirectory}; starting replacement server`;
    }

    if (health.serverId !== metadata.serverId || health.url !== expectedUrl) {
      return `${timestamp} discarding stale local server metadata ${summary} healthServerId=${health.serverId} healthUrl=${health.url}; starting replacement server`;
    }

    return undefined;
  });
}

function readServerMetadata(rootDirectory: string) {
  return Effect.gen(function* () {
    const paths = yield* serverPaths(rootDirectory);
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(paths.serverJson);
    if (!exists) {
      return undefined;
    }

    return yield* fs.readFileString(paths.serverJson).pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: () => decodeServerMetadata(JSON.parse(text)),
          catch: () => undefined,
        }),
      ),
    );
  });
}

function appendServerLog(rootDirectory: string, line: string) {
  return Effect.gen(function* () {
    const paths = yield* serverPaths(rootDirectory);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(paths.gaiaRoot, { recursive: true });
    yield* fs.writeFileString(paths.serverLog, `${line}\n`, { flag: "a" });
  });
}

function serverMetadataSummary(metadata: ServerMetadata) {
  return `serverId=${metadata.serverId} pid=${metadata.pid} url=${metadata.url} workspaceRoot=${metadata.workspaceRoot}`;
}

function probeServerHealth(metadata: ServerMetadata) {
  return Effect.gen(function* () {
    const serverUrl = trustedMetadataUrl(metadata);
    if (serverUrl === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "LocalRunApiUnavailable",
          message: "Local Gaia server metadata did not describe a loopback server.",
          recoverable: true,
        }),
      );
    }

    return yield* requestServer({
      dataName: "health response",
      effect: healthFromLocalServerProtocol({ serverUrl }),
      serverUrl,
    });
  });
}

function startLocalServerProcess(rootDirectory: string) {
  return Effect.gen(function* () {
    const paths = yield* serverPaths(rootDirectory);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(paths.gaiaRoot, { recursive: true });
    return yield* Effect.try({
      try: () => {
        const logFd = openSync(paths.serverLog, "a");
        try {
          const command = serverProcessCommand(rootDirectory);
          let error: unknown | undefined;
          const child = spawn(command.command, command.args, {
            cwd: rootDirectory,
            detached: true,
            env: serverProcessEnv(),
            stdio: ["ignore", logFd, logFd],
          });
          child.on("error", (cause) => {
            error = cause;
          });
          return {
            args: command.args,
            child,
            command: command.command,
            error: () => error,
          } satisfies StartedServerProcess;
        } finally {
          closeSync(logFd);
        }
      },
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "LocalServerStartFailed",
          message: "Gaia could not start the local server for --server mode.",
          recoverable: true,
        }),
    });
  });
}

function waitForUsableMetadata(
  rootDirectory: string,
  startedProcess?: StartedServerProcess,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < autostartWaitAttempts; attempt += 1) {
      if (startedProcess !== undefined) {
        const error = startedProcess.error();
        if (error !== undefined) {
          return yield* Effect.fail(serverStartFailed(error));
        }

        if (
          startedProcess.child.exitCode !== null ||
          startedProcess.child.signalCode !== null
        ) {
          return yield* Effect.fail(
            serverStartFailed(
              new Error(
                `Local server process exited before readiness. exitCode=${startedProcess.child.exitCode ?? "none"} signal=${startedProcess.child.signalCode ?? "none"}`,
              ),
            ),
          );
        }
      }

      const metadata = yield* readUsableMetadata(rootDirectory);
      if (metadata !== undefined) {
        return metadata;
      }

      yield* Effect.sleep(autostartWaitDelay);
    }

    return yield* Effect.fail(
      makeRuntimeError({
        code: "LocalServerStartTimeout",
        message: "Gaia local server did not become ready for --server mode.",
        recoverable: true,
      }),
    );
  });
}

function serverPaths(rootDirectory: string) {
  return makeRunStorePaths({ rootDirectory }).pipe(
    Effect.map((paths) => ({
      gaiaRoot: paths.gaiaRoot,
      serverJson: path.join(paths.gaiaRoot, "server.json"),
      serverLog: path.join(paths.gaiaRoot, "server.log"),
      serverStartLock: path.join(paths.gaiaRoot, "server-start.lock"),
    })),
  );
}

function serverProcessCommand(rootDirectory: string) {
  const modulePath = fileURLToPath(import.meta.url);
  const workspaceMarker = `${path.sep}apps${path.sep}cli${path.sep}`;
  const markerIndex = modulePath.indexOf(workspaceMarker);
  if (markerIndex >= 0) {
    const repoRoot = modulePath.slice(0, markerIndex);
    return {
      args: [
        path.join(repoRoot, "apps", "server", "src", "main.ts"),
        "--root",
        rootDirectory,
        ...(process.env["VITEST"] === undefined ? [] : ["--test-harness"]),
      ],
      command: path.join(
        repoRoot,
        "apps",
        "server",
        "node_modules",
        ".bin",
        "tsx",
      ),
    };
  }

  return {
    args: ["--root", rootDirectory],
    command: "gaia-server",
  };
}

function canonicalRoot(rootDirectory: string) {
  return Effect.tryPromise({
    try: () => realpath(rootDirectory),
    catch: () => path.resolve(rootDirectory),
  });
}

function trustedMetadataUrl(metadata: ServerMetadata) {
  if (metadata.host !== "127.0.0.1") {
    return undefined;
  }

  const expected = `http://${metadata.host}:${metadata.port}`;
  try {
    const parsed = new URL(metadata.url);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== metadata.host ||
      Number(parsed.port) !== metadata.port ||
      parsed.pathname !== "/" ||
      metadata.url !== expected
    ) {
      return undefined;
    }

    return metadata.url;
  } catch {
    return undefined;
  }
}

function serverStartFailed(cause: unknown) {
  return makeRuntimeError({
    cause,
    code: "LocalServerStartFailed",
    message: "Gaia could not start the local server for --server mode.",
    recoverable: true,
  });
}

function stopStartedProcess(startedProcess: StartedServerProcess) {
  try {
    startedProcess.child.kill("SIGTERM");
  } catch {
    // The process may already have exited before startup cleanup runs.
  }
}

function serverProcessEnv() {
  const entries = [
    "COREPACK_HOME",
    "HOME",
    "NO_COLOR",
    "PATH",
    "PNPM_HOME",
    "TMP",
    "TMPDIR",
    "TEMP",
    "TERM",
  ].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  return Object.fromEntries(entries);
}
