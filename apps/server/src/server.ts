import { NodeServices } from "@effect/platform-node";
import {
  listReadableRuns,
  publicRunDiagnostic,
  readRunArtifact,
  readRunDetail,
  readRunEventLog,
  type RunReadDiagnostic,
} from "@gaia/runtime";
import { Effect, Exit, FileSystem, Option, Path } from "effect";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export type GaiaApiOptions = {
  readonly host?: string;
  readonly port?: number;
  readonly rootDirectory?: string;
};

type ApiEnvelope<T> =
  | { readonly status: "success"; readonly data: T }
  | {
      readonly status: "partial";
      readonly data: T;
      readonly diagnostics: ReadonlyArray<RunReadDiagnostic>;
    }
  | { readonly status: "error"; readonly error: RunReadDiagnostic };

export type GaiaApiHttpResponse = {
  readonly body: ApiEnvelope<unknown>;
  readonly statusCode: number;
};

const defaultHost = "127.0.0.1";

export function createGaiaApiServer(options: GaiaApiOptions = {}): Server {
  return createServer((request, response) => {
    void handleIncomingRequest(request, response, options);
  });
}

export function listenGaiaApi(options: GaiaApiOptions = {}) {
  return Effect.tryPromise({
    try: () => new Promise<Server>((resolve, reject) => {
      const server = createGaiaApiServer(options);
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(options.port ?? 0, options.host ?? defaultHost, () => {
        server.off("error", onError);
        resolve(server);
      });
    }),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });
}

async function handleIncomingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: GaiaApiOptions,
) {
  const result = await handleGaiaApiRequest(
    request.method ?? "GET",
    request.url ?? "/",
    options,
  );
  writeJson(response, result.statusCode, result.body);
}

export async function handleGaiaApiRequest(
  method: string,
  requestUrl: string,
  options: GaiaApiOptions = {},
): Promise<GaiaApiHttpResponse> {
  if (method !== "GET") {
    return {
      body: {
        error: {
          code: "MethodNotAllowed",
          message: "Only GET requests are supported.",
          pathSegment: "",
          recoverable: false,
        },
        status: "error",
      } satisfies ApiEnvelope<never>,
      statusCode: 405,
    };
  }

  const url = new URL(requestUrl, "http://127.0.0.1");
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 1 && segments[0] === "runs") {
    const result = await runEffect(listReadableRuns(readOptions(options)));
    return {
      body: result.diagnostics.length === 0
        ? { status: "success" as const, data: { runs: result.runs } }
        : {
            status: "partial" as const,
            data: { runs: result.runs },
            diagnostics: result.diagnostics,
          },
      statusCode: 200,
    };
  }

  if (segments.length >= 2 && segments[0] === "runs") {
    const runId = decodePathSegment(segments[1] ?? "");

    if (segments.length === 2) {
      return await effectResponse(
        runId,
        readRunDetail(runId, readOptions(options)),
        200,
      );
    }

    if (segments.length === 3 && segments[2] === "events") {
      return await effectResponse(
        runId,
        readRunEventLog(runId, readOptions(options)),
        200,
      );
    }

    if (segments.length === 4 && segments[2] === "artifacts") {
      const artifactName = decodePathSegment(segments[3] ?? "");
      return await effectResponse(
        runId,
        readRunArtifact(runId, artifactName, readOptions(options)),
        200,
      );
    }
  }

  return {
    body: {
      error: {
        code: "NotFound",
        message: "No local Gaia API route matched the request.",
        pathSegment: "",
        recoverable: false,
      },
      status: "error",
    } satisfies ApiEnvelope<never>,
    statusCode: 404,
  };
}

async function effectResponse<T>(
  runId: string,
  effect: Effect.Effect<T, unknown, FileSystem.FileSystem | Path.Path>,
  successStatus: number,
): Promise<GaiaApiHttpResponse> {
  const result = await runEffect(Effect.exit(effect));
  if (Exit.isSuccess(result)) {
    return {
      body: {
        data: result.value,
        status: "success",
      } satisfies ApiEnvelope<T>,
      statusCode: successStatus,
    };
  }

  const error = Exit.findErrorOption(result);
  const diagnostic = publicRunDiagnostic(
    Option.isSome(error) ? error.value : undefined,
    runId,
    runId,
  );
  return {
    body: {
      error: diagnostic,
      status: "error",
    } satisfies ApiEnvelope<never>,
    statusCode: statusFromDiagnostic(diagnostic),
  };
}

function runEffect<T>(
  effect: Effect.Effect<T, unknown, FileSystem.FileSystem | Path.Path>,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
}

function readOptions(options: GaiaApiOptions) {
  return options.rootDirectory === undefined
    ? {}
    : { rootDirectory: options.rootDirectory };
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function statusFromDiagnostic(diagnostic: RunReadDiagnostic) {
  switch (diagnostic.code) {
    case "InvalidRunId":
    case "ArtifactNotAllowlisted":
      return 400;
    case "ArtifactNotFound":
    case "RunHasNoEvents":
      return 404;
    default:
      return 500;
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}
