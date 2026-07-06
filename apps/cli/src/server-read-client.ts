import {
  EventTypeSchema,
  RunEvent,
  RunIdSchema,
  RunStateSchema,
} from "@gaia/core";
import {
  makeRunPaths,
  makeRuntimeError,
  type CommandSummary,
  type LocalRunArtifact,
  type LocalRunEvents,
  type LocalRunReadDiagnostic,
  type LocalRunSummary,
} from "@gaia/runtime";
import { Effect, Schema } from "effect";

const LocalRunReadDiagnosticCodeSchema = Schema.Literals([
    "ArtifactNotAllowed",
    "ArtifactNotFound",
    "InvalidRunDirectory",
    "InvalidRunId",
    "RunHasNoEvents",
    "RunNotFound",
    "RunUnreadable",
  ] as const);
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

class LocalRunSummaryDto extends Schema.Class<LocalRunSummaryDto>(
  "LocalRunSummaryDto",
)({
  artifacts: Schema.Array(Schema.String),
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
  artifactName: Schema.String,
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
const decodeLocalRunDiagnostic = Schema.decodeUnknownSync(
  LocalRunReadDiagnosticDto,
);

type ParsedServerEnvelope =
  | {
      readonly data: unknown;
      readonly status: "partial" | "success";
    }
  | {
      readonly error: LocalRunReadDiagnostic;
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

      if (status === "error") {
        return {
          error: toLocalRunDiagnostic(decodeLocalRunDiagnostic(envelope["error"])),
          status,
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
      ...(summary.artifacts.includes("codex-harness-progress.json")
        ? { harnessProgressPath: paths.codexHarnessProgress }
        : {}),
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

function toLocalRunDiagnostic(
  input: LocalRunReadDiagnosticDto,
): LocalRunReadDiagnostic {
  return {
    ...(input.artifactName === undefined
      ? {}
      : { artifactName: input.artifactName }),
    code: input.code,
    message: input.message,
    ...(input.pathSegment === undefined
      ? {}
      : { pathSegment: input.pathSegment }),
    recoverable: input.recoverable,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  };
}

function runtimeErrorFromDiagnostic(diagnostic: LocalRunReadDiagnostic) {
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
