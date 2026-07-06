import {
  EventTypeSchema,
  CreateRunAcceptedResponse,
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
  GaiaRuntimeError,
  makeRunPaths,
  makeRuntimeError,
  type CommandSummary,
  type LocalRunArtifact,
  type LocalRunEvents,
  type LocalRunSummary,
} from "@gaia/runtime";
import { Effect, Schema } from "effect";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { realpath, rm, readFile } from "node:fs/promises";
import path from "node:path";

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
const decodeCreateRunAccepted = Schema.decodeUnknownSync(CreateRunAcceptedResponse);
const decodeHealthResponse = Schema.decodeUnknownSync(HealthResponse);
const decodeServerMetadata = Schema.decodeUnknownSync(ServerMetadata);

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

export function ensureServerModeUrl(input: { readonly rootDirectory: string }) {
  return Effect.gen(function* () {
    const reusable = yield* reusableServerUrl(input.rootDirectory);
    if (reusable !== undefined) {
      return reusable;
    }

    yield* removeServerMetadata(input.rootDirectory);
    yield* startBackgroundServer(input.rootDirectory);
    return yield* waitForReusableServer(input.rootDirectory);
  });
}

export function createRunFromServer(input: {
  readonly rootDirectory: string;
  readonly serverUrl: string;
  readonly specPath: string;
}) {
  return Effect.gen(function* () {
    const fs = yield* Effect.tryPromise({
      try: () => readFile(input.specPath, "utf8"),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "SpecReadFailed",
          message: `Could not read spec file ${input.specPath}.`,
          recoverable: false,
        }),
    });
    const response = yield* postServerJson(input.serverUrl, "/runs", {
      specMarkdown: fs,
      title: path.basename(input.specPath),
    });
    const accepted = yield* decodeServerData(
      response,
      decodeCreateRunAccepted,
      "run acceptance",
    );
    const paths = yield* makeRunPaths(accepted.runId, {
      rootDirectory: input.rootDirectory,
    });

    return {
      reportPath: undefined,
      runDirectory: paths.root,
      runId: accepted.runId,
      state: "created",
      status: "running",
    } satisfies CommandSummary;
  });
}

export function statusRunFromServer(input: {
  readonly rootDirectory: string;
  readonly runId?: string;
  readonly serverUrl: string;
}) {
  return Effect.gen(function* () {
    const runId = input.runId ?? (yield* latestServerRunId(input.serverUrl));
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

function latestServerRunId(serverUrl: string) {
  return Effect.gen(function* () {
    const list = yield* getServerData({
      dataName: "run list",
      decode: decodeLocalRunList,
      path: "/runs",
      serverUrl,
    });
    const first = list.runs[0];
    if (first === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "NoRunsFound",
          message: "No Gaia runs found through the local server.",
          recoverable: false,
        }),
      );
    }

    return first.runId;
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
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(serverEndpoint(serverUrl, pathname));
      return await response.json();
    },
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "LocalRunApiUnavailable",
        message: `Local Gaia API server is unavailable at ${serverUrl}. Direct runtime reads remain available without --server-url.`,
        recoverable: true,
      }),
  });
}

function postServerJson(
  serverUrl: string,
  pathname: string,
  payload: Readonly<Record<string, unknown>>,
) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(serverEndpoint(serverUrl, pathname), {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const parsed: unknown = await response.json();
      if (response.ok) {
        return parsed;
      }

      const diagnostic = decodeLocalRunApiError(parsed);
      throw runtimeErrorFromDiagnostic(diagnostic);
    },
    catch: (cause) =>
      cause instanceof GaiaRuntimeError
        ? cause
        : makeRuntimeError({
            cause,
            code: "LocalRunApiUnavailable",
            message: `Local Gaia API server is unavailable at ${serverUrl}. Direct runtime reads remain available without --server.`,
            recoverable: true,
          }),
  });
}

function reusableServerUrl(rootDirectory: string) {
  return Effect.gen(function* () {
    const metadata = yield* readServerMetadata(rootDirectory).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (metadata === undefined) {
      return undefined;
    }

    const health = yield* fetchServerHealth(metadata.url).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const sameRoot =
      health === undefined
        ? false
        : yield* sameWorkspaceRoot(health.workspaceRoot, rootDirectory);
    if (
      health === undefined ||
      health.serverId !== metadata.serverId ||
      !sameRoot
    ) {
      return undefined;
    }

    return metadata.url;
  });
}

function waitForReusableServer(rootDirectory: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const reusable = yield* reusableServerUrl(rootDirectory);
      if (reusable !== undefined) {
        return reusable;
      }
      yield* Effect.sleep("100 millis");
    }

    return yield* Effect.fail(
      makeRuntimeError({
        code: "LocalRunApiUnavailable",
        message:
          "Local Gaia API server did not become ready after auto-start.",
        recoverable: true,
      }),
    );
  });
}

function readServerMetadata(rootDirectory: string) {
  return Effect.tryPromise({
    try: async () => {
      const text = await readFile(serverJsonPath(rootDirectory), "utf8");
      return decodeServerMetadata(JSON.parse(text));
    },
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "LocalRunApiInvalidResponse",
        message: "Local Gaia server metadata is missing or invalid.",
        recoverable: true,
      }),
  });
}

function fetchServerHealth(serverUrl: string) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(serverEndpoint(serverUrl, "/health"));
      const parsed: unknown = await response.json();
      return decodeHealthResponse(parsed);
    },
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "LocalRunApiUnavailable",
        message: `Local Gaia API server is unavailable at ${serverUrl}. Direct runtime reads remain available without --server.`,
        recoverable: true,
      }),
  });
}

function removeServerMetadata(rootDirectory: string) {
  return Effect.tryPromise({
    try: () => rm(serverJsonPath(rootDirectory), { force: true }),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "LocalRunApiInvalidResponse",
        message: "Could not replace stale local Gaia server metadata.",
        recoverable: true,
      }),
  });
}

function startBackgroundServer(rootDirectory: string) {
  return Effect.try({
    try: () => {
      const gaiaRoot = path.join(rootDirectory, ".gaia");
      mkdirSync(gaiaRoot, { recursive: true });
      const logFd = openSync(serverLogPath(rootDirectory), "a");
      try {
        const child = spawn(
          "pnpm",
          [
            "--dir",
            gaiaRepoRoot(),
            "--filter",
            "@gaia/server",
            "dev",
            "--root",
            rootDirectory,
          ],
          {
            cwd: rootDirectory,
            detached: true,
            env: {
              ...process.env,
              INIT_CWD: rootDirectory,
            },
            stdio: ["ignore", logFd, logFd],
          },
        );
        child.on("error", () => undefined);
        child.unref();
      } finally {
        closeSync(logFd);
      }
    },
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "LocalRunApiUnavailable",
        message: "Could not auto-start the local Gaia API server.",
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

function serverJsonPath(rootDirectory: string) {
  return path.join(rootDirectory, ".gaia", "server.json");
}

function serverLogPath(rootDirectory: string) {
  return path.join(rootDirectory, ".gaia", "server.log");
}

function sameWorkspaceRoot(left: string, right: string) {
  return Effect.promise(async () => {
    try {
      const [leftReal, rightReal] = await Promise.all([
        realpath(left),
        realpath(right),
      ]);
      return leftReal === rightReal;
    } catch {
      return path.resolve(left) === path.resolve(right);
    }
  });
}

function gaiaRepoRoot() {
  return path.resolve(new URL("../../..", import.meta.url).pathname);
}
