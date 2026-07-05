import { parseRunId } from "@gaia/core";
import { Effect } from "effect";
import { makeRuntimeError } from "./errors.js";
import { makeRunPaths, type RunStorageOptions } from "./paths.js";
import type { CommandSummary } from "./workflows.js";
import type {
  LocalRunDetail,
  LocalRunList,
  LocalRunReadDiagnostic,
  LocalRunSummary,
} from "./run-read-api.js";

export type ServerReadOptions = RunStorageOptions & {
  readonly fetch?: typeof fetch;
  readonly serverUrl: string;
};

type ApiEnvelope<T> =
  | {
      readonly data: T;
      readonly status: "success";
    }
  | {
      readonly data: T;
      readonly diagnostics: ReadonlyArray<LocalRunReadDiagnostic>;
      readonly status: "partial";
    }
  | {
      readonly error: LocalRunReadDiagnostic;
      readonly status: "error";
    };

export function listRunsFromServer(options: ServerReadOptions) {
  return Effect.gen(function* () {
    const envelope = yield* requestServer<LocalRunList>(options, "/runs");
    if (envelope.status === "error") {
      return yield* Effect.fail(apiDiagnosticToRuntimeError(envelope.error));
    }

    const summaries: Array<CommandSummary> = [];
    for (const run of envelope.data.runs) {
      summaries.push(yield* commandSummaryFromLocalRun(run, options));
    }

    return summaries;
  });
}

export function statusRunFromServer(
  runIdInput: string | undefined,
  options: ServerReadOptions,
) {
  return Effect.gen(function* () {
    if (runIdInput === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ServerRunIdRequired",
          message:
            "Server-backed status requires a run id because the local API has no latest-run endpoint. Rerun without --server-url to use the direct runtime path.",
          recoverable: true,
        }),
      );
    }

    const envelope = yield* requestServer<LocalRunDetail>(
      options,
      `/runs/${encodeURIComponent(runIdInput)}`,
    );
    if (envelope.status === "error") {
      return yield* Effect.fail(apiDiagnosticToRuntimeError(envelope.error));
    }

    return yield* commandSummaryFromLocalRun(envelope.data, options);
  });
}

function requestServer<T>(options: ServerReadOptions, pathname: string) {
  return Effect.gen(function* () {
    const url = yield* parseServerUrl(options.serverUrl, pathname);
    const fetcher = options.fetch ?? fetch;
    const response = yield* Effect.tryPromise({
      try: () => fetcher(url),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "ServerUnavailable",
          message: `Could not read Gaia runs from local server at ${options.serverUrl}. Start the server or rerun without --server-url to use the direct runtime path.`,
          recoverable: true,
        }),
    });
    const parsed = yield* Effect.tryPromise({
      try: async () => JSON.parse(await response.text()) as unknown,
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "ServerResponseInvalid",
          message: `Local server at ${options.serverUrl} returned non-JSON read data. Rerun without --server-url to use the direct runtime path.`,
          recoverable: true,
        }),
    });
    const envelope = yield* decodeEnvelope<T>(parsed, options.serverUrl);

    if (!response.ok && envelope.status !== "error") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ServerReadFailed",
          message: `Local server at ${options.serverUrl} returned HTTP ${response.status}. Rerun without --server-url to use the direct runtime path.`,
          recoverable: true,
        }),
      );
    }

    return envelope;
  });
}

function parseServerUrl(serverUrl: string, pathname: string) {
  return Effect.try({
    try: () => {
      const url = new URL(serverUrl);
      url.pathname = `${url.pathname.replace(/\/$/u, "")}${pathname}`;
      return url;
    },
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidServerUrl",
        message: `Server URL is not valid: ${serverUrl}`,
        recoverable: true,
      }),
  });
}

function decodeEnvelope<T>(input: unknown, serverUrl: string) {
  if (!isRecord(input) || typeof input.status !== "string") {
    return Effect.fail(invalidEnvelopeError(serverUrl));
  }

  if (input.status === "success" || input.status === "partial") {
    if (!("data" in input)) {
      return Effect.fail(invalidEnvelopeError(serverUrl));
    }

    return Effect.succeed(input as ApiEnvelope<T>);
  }

  if (input.status === "error" && isRecord(input.error)) {
    const error = input.error;
    if (
      typeof error.code === "string" &&
      typeof error.message === "string" &&
      typeof error.recoverable === "boolean"
    ) {
      return Effect.succeed(input as ApiEnvelope<T>);
    }
  }

  return Effect.fail(invalidEnvelopeError(serverUrl));
}

function invalidEnvelopeError(serverUrl: string) {
  return makeRuntimeError({
    code: "ServerResponseInvalid",
    message: `Local server at ${serverUrl} returned an invalid read envelope. Rerun without --server-url to use the direct runtime path.`,
    recoverable: true,
  });
}

function apiDiagnosticToRuntimeError(diagnostic: LocalRunReadDiagnostic) {
  return makeRuntimeError({
    code: diagnostic.code,
    message: `${diagnostic.message} Rerun without --server-url to use the direct runtime path.`,
    recoverable: diagnostic.recoverable,
  });
}

function commandSummaryFromLocalRun(
  run: LocalRunSummary,
  options: RunStorageOptions,
) {
  return Effect.gen(function* () {
    const runId = yield* parseServerRunId(run.runId);
    const paths = yield* makeRunPaths(runId, options);
    return {
      reportPath: run.state === "completed" ? paths.reportMarkdown : undefined,
      runDirectory: paths.root,
      runId,
      state: run.state,
      status: run.status,
    } satisfies CommandSummary;
  });
}

function parseServerRunId(runId: unknown) {
  return Effect.try({
    try: () => parseRunId(runId),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "ServerResponseInvalid",
        message:
          "Local server returned a run with an invalid Gaia run id. Rerun without --server-url to use the direct runtime path.",
        recoverable: true,
      }),
  });
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
