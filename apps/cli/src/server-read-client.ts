import {
  CreateRunAcceptedResponse,
  CreateRunRequest,
  EventTypeSchema,
  HealthResponse,
  LocalRunApiErrorStatusSchema,
  LocalRunArtifactIdSchema,
  LocalRunReadDiagnosticCodeSchema,
  RunEvent,
  RunIdSchema,
  RunStateSchema,
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
import { Effect, FileSystem, Schema } from "effect";
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fetchTimeoutMs = 2_000;
const autostartWaitAttempts = 50;
const autostartWaitDelay = "100 millis";

const LocalRunStatusSchema = Schema.Literals([
  "completed",
  "failed",
  "running",
] as const);
const LocalRunArtifactContentTypeSchema = Schema.Literals([
  "application/json",
  "text/markdown",
  "text/plain",
] as const);

class LocalRunReadDiagnosticDto extends Schema.Class<LocalRunReadDiagnosticDto>(
  "LocalRunReadDiagnosticDto",
)({
  artifactName: Schema.optionalKey(Schema.String),
  code: LocalRunReadDiagnosticCodeSchema,
  message: Schema.String,
  pathSegment: Schema.optionalKey(Schema.String),
  recoverable: Schema.Boolean,
  runId: Schema.optionalKey(RunIdSchema),
}) {}

class LocalRunApiErrorDto extends Schema.Class<LocalRunApiErrorDto>(
  "LocalRunApiErrorDto",
)({
  artifactName: Schema.optionalKey(Schema.String),
  code: LocalRunReadDiagnosticCodeSchema,
  message: Schema.String,
  pathSegment: Schema.optionalKey(Schema.String),
  recoverable: Schema.Boolean,
  runId: Schema.optionalKey(RunIdSchema),
  status: LocalRunApiErrorStatusSchema,
}) {}

class LocalRunSummaryDto extends Schema.Class<LocalRunSummaryDto>(
  "LocalRunSummaryDto",
)({
  artifacts: Schema.Array(LocalRunArtifactIdSchema),
  createdAt: Schema.String,
  eventCount: Schema.Number,
  latestEventType: EventTypeSchema,
  runId: RunIdSchema,
  state: RunStateSchema,
  status: LocalRunStatusSchema,
  updatedAt: Schema.String,
}) {}

class LocalRunListDto extends Schema.Class<LocalRunListDto>("LocalRunListDto")({
  diagnostics: Schema.Array(LocalRunReadDiagnosticDto),
  runs: Schema.Array(LocalRunSummaryDto),
}) {}

class LocalRunEventsDto extends Schema.Class<LocalRunEventsDto>(
  "LocalRunEventsDto",
)({
  events: Schema.Array(RunEvent),
  runId: RunIdSchema,
}) {}

class LocalRunArtifactDto extends Schema.Class<LocalRunArtifactDto>(
  "LocalRunArtifactDto",
)({
  artifactName: LocalRunArtifactIdSchema,
  body: Schema.String,
  contentType: LocalRunArtifactContentTypeSchema,
  runId: RunIdSchema,
}) {}

const decodeJsonObject = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Unknown),
);
const decodeLocalRunList = Schema.decodeUnknownSync(LocalRunListDto);
const decodeLocalRunSummary = Schema.decodeUnknownSync(LocalRunSummaryDto);
const decodeLocalRunEvents = Schema.decodeUnknownSync(LocalRunEventsDto);
const decodeLocalRunArtifact = Schema.decodeUnknownSync(LocalRunArtifactDto);
const decodeLocalRunApiError = Schema.decodeUnknownSync(LocalRunApiErrorDto);
const decodeCreateRunRequest = Schema.decodeUnknownSync(CreateRunRequest);
const decodeCreateRunAcceptedResponse = Schema.decodeUnknownSync(
  CreateRunAcceptedResponse,
);
const decodeHealthResponse = Schema.decodeUnknownSync(HealthResponse);
const decodeRunId = Schema.decodeUnknownSync(RunIdSchema);
const decodeServerMetadata = Schema.decodeUnknownSync(ServerMetadata);

export type ServerRunAcceptedSummary =
  typeof CreateRunAcceptedResponse.Type & {
    readonly serverUrl: string;
  };

type ParsedServerEnvelope =
  | {
      readonly data: unknown;
      readonly status: "partial" | "success";
    }
  | {
      readonly error: LocalRunApiErrorDto;
      readonly status: "error";
    };

export function listRunsFromServer(input: {
  readonly rootDirectory: string;
  readonly serverUrl: string;
}) {
  return Effect.gen(function* () {
    const list = yield* getServerData({
      dataName: "run list",
      decode: decodeLocalRunList,
      path: "/runs",
      serverUrl: input.serverUrl,
    });
    const summaries: Array<CommandSummary> = [];
    for (const run of list.runs) {
      summaries.push(yield* commandSummaryFromLocalRun(run, input.rootDirectory));
    }

    return summaries;
  });
}

export function statusRunFromServer(input: {
  readonly rootDirectory: string;
  readonly runId?: string;
  readonly serverUrl: string;
}) {
  return Effect.gen(function* () {
    const runId =
      input.runId ?? (yield* latestRunIdFromPointer(input.rootDirectory));
    const run = yield* getServerData({
      dataName: "run status",
      decode: decodeLocalRunSummary,
      path: `/runs/${encodeURIComponent(runId)}`,
      serverUrl: input.serverUrl,
    });

    return yield* commandSummaryFromLocalRun(run, input.rootDirectory);
  });
}

export function readLocalRunEventsFromServer(input: {
  readonly runId: string;
  readonly serverUrl: string;
}) {
  return getServerData({
    dataName: "run events",
    decode: (value) => toLocalRunEvents(decodeLocalRunEvents(value)),
    path: `/runs/${encodeURIComponent(input.runId)}/events`,
    serverUrl: input.serverUrl,
  });
}

export function readLocalRunArtifactFromServer(input: {
  readonly artifactName: string;
  readonly runId: string;
  readonly serverUrl: string;
}) {
  return getServerData({
    dataName: "run artifact",
    decode: (value) => toLocalRunArtifact(decodeLocalRunArtifact(value)),
    path: `/runs/${encodeURIComponent(input.runId)}/artifacts/${encodeURIComponent(input.artifactName)}`,
    serverUrl: input.serverUrl,
  });
}

export function createRunFromServer(input: {
  readonly rootDirectory: string;
  readonly serverUrl: string;
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
    const payload = yield* decodeServerData(
      { specMarkdown },
      decodeCreateRunRequest,
      "create run request",
    );
    const accepted = yield* postServerJson({
      dataName: "create run response",
      decode: decodeCreateRunAcceptedResponse,
      payload,
      path: "/runs",
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

function getServerData<A>(input: {
  readonly dataName: string;
  readonly decode: (value: unknown) => A;
  readonly path: string;
  readonly serverUrl: string;
}) {
  return Effect.gen(function* () {
    const response = yield* fetchServerJson(input.serverUrl, input.path);
    const envelope = yield* parseEnvelope(response, input.dataName);
    if (envelope.status === "error") {
      return yield* Effect.fail(runtimeErrorFromDiagnostic(envelope.error));
    }

    return yield* decodeServerData(envelope.data, input.decode, input.dataName);
  });
}

function fetchServerJson(serverUrl: string, pathname: string) {
  return fetchServerJsonResponse({
    method: "GET",
    path: pathname,
    serverUrl,
  }).pipe(
    Effect.map((response) => response.body),
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

function postServerJson<A>(input: {
  readonly dataName: string;
  readonly decode: (value: unknown) => A;
  readonly path: string;
  readonly payload: unknown;
  readonly serverUrl: string;
}) {
  return Effect.gen(function* () {
    const response = yield* fetchServerJsonResponse({
      body: JSON.stringify(input.payload),
      method: "POST",
      path: input.path,
      serverUrl: input.serverUrl,
    });
    if (!response.ok) {
      const error = yield* decodeServerData(
        response.body,
        decodeLocalRunApiError,
        "create run error",
      );
      return yield* Effect.fail(runtimeErrorFromDiagnostic(error));
    }

    return yield* decodeServerData(response.body, input.decode, input.dataName);
  });
}

function fetchServerJsonResponse(input: {
  readonly body?: string | undefined;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly serverUrl: string;
}) {
  return Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
      const init =
        input.body === undefined
          ? { method: input.method, signal: controller.signal }
          : {
              body: input.body,
              headers: { "content-type": "application/json" },
              method: input.method,
              signal: controller.signal,
            };
      try {
        const response = await fetch(serverEndpoint(input.serverUrl, input.path), init);
        return {
          body: await response.json(),
          ok: response.ok,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "LocalRunApiUnavailable",
        message: `Local Gaia API server is unavailable at ${input.serverUrl}. Direct runtime reads remain available without --server.`,
        recoverable: true,
      }),
  });
}

function parseEnvelope(
  input: unknown,
  dataName: string,
): Effect.Effect<ParsedServerEnvelope, ReturnType<typeof makeRuntimeError>> {
  return Effect.try({
    try: () => {
      const envelope = decodeJsonObject(input);
      const status = envelope["status"];
      if (status === "success" || status === "partial") {
        return {
          data: envelope["data"],
          status,
        };
      }

      if (typeof status === "number") {
        return {
          error: decodeLocalRunApiError(envelope),
          status: "error",
        };
      }

      throw new Error("Envelope status is missing or invalid.");
    },
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "LocalRunApiInvalidResponse",
        message: `Local Gaia API returned an invalid ${dataName} envelope.`,
        recoverable: false,
      }),
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
  run: LocalRunSummaryDto,
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

function toLocalRunSummary(input: LocalRunSummaryDto) {
  return {
    artifacts: input.artifacts,
    createdAt: input.createdAt,
    eventCount: input.eventCount,
    latestEventType: input.latestEventType,
    runId: input.runId,
    state: input.state,
    status: input.status,
    updatedAt: input.updatedAt,
  } satisfies LocalRunSummary;
}

function toLocalRunEvents(input: LocalRunEventsDto) {
  return {
    events: input.events,
    runId: input.runId,
  } satisfies LocalRunEvents;
}

function toLocalRunArtifact(input: LocalRunArtifactDto) {
  return {
    artifactName: input.artifactName,
    body: input.body,
    contentType: input.contentType,
    runId: input.runId,
  } satisfies LocalRunArtifact;
}

function runtimeErrorFromDiagnostic(diagnostic: LocalRunApiErrorDto) {
  return makeRuntimeError({
    code: diagnostic.code,
    message: diagnostic.message,
    recoverable: diagnostic.recoverable,
  });
}

function serverEndpoint(serverUrl: string, pathname: string) {
  const url = new URL(pathname, normalizedServerUrl(serverUrl));
  return url.toString();
}

function normalizedServerUrl(serverUrl: string) {
  return serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`;
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
    if (expectedUrl === undefined || metadata.url !== expectedUrl) {
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

    const response = yield* fetchServerJsonResponse({
      method: "GET",
      path: "/health",
      serverUrl,
    });
    if (!response.ok) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "LocalRunApiUnavailable",
          message: `Local Gaia API server is unavailable at ${serverUrl}.`,
          recoverable: true,
        }),
      );
    }

    return yield* decodeServerData(
      response.body,
      decodeHealthResponse,
      "health response",
    );
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
        "--dir",
        repoRoot,
        "--filter",
        "@gaia/server",
        "dev",
        "--",
        "--root",
        rootDirectory,
      ],
      command: "pnpm",
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
      parsed.pathname !== "/"
    ) {
      return undefined;
    }

    return expected;
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
