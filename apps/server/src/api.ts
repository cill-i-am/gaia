import {
  CreateRunAcceptedResponse,
  FactoryArtifactBodyDto,
  FactoryArtifactSuccessEnvelope,
  FactoryRunDetailDto,
  FactoryRunDetailSuccessEnvelope,
  FactoryRunListDto,
  FactoryRunListSuccessEnvelope,
  FactoryRunSummaryDto,
  HealthResponse,
  LocalGaiaServerApi,
  LocalRunApiBadRequest,
  LocalRunApiConflict,
  LocalRunApiInternalServerError,
  LocalRunApiErrorEnvelope,
  LocalRunApiMethodNotAllowed,
  LocalRunApiNotFound,
  LocalRunApiUnprocessable,
  LocalRunEventsSuccessEnvelope,
  type LocalRunApiError,
  LocalRunReadDiagnosticDto,
  type RunEvent,
} from "@gaia/core";
import type {
  LocalRunArtifact,
  LocalRunList,
  LocalRunReadDiagnostic,
  LocalRunSummary,
} from "@gaia/runtime/run-read-api";
import {
  readLocalRunArtifact,
  readLocalRunEvents,
} from "@gaia/runtime/run-read-api";
import {
  GaiaRuntimeError,
  makeLocalRunReadIndex,
  type LocalRunReadIndex,
} from "@gaia/runtime";
import { Cause, Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect";
import type { Generator } from "effect/unstable/http/Etag";
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform";
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  acceptServerRun,
  continueServerRun,
  type ServerRunAcceptance,
  type ServerWorkflowOptions,
} from "@gaia/runtime/server-workflows";
import {
  appendServerLog,
  serverMetadataFromAddress,
  type LocalServerIdentity,
} from "./discovery.js";
import {
  ActiveServerRunConflict,
  makeServerRunRegistry,
  type ServerRunReservation,
  type ServerRunRegistryService,
} from "./server-state.js";

type LocalServerConfigValue = LocalServerIdentity & {
  readonly runIndex: LocalRunReadIndex;
  readonly runRegistry: ServerRunRegistryService;
  readonly workflowOptions: ServerWorkflowOptions;
};

export class LocalServerConfig extends Context.Service<
  LocalServerConfig,
  LocalServerConfigValue
>()("@gaia/server/LocalServerConfig") {}

const decodeFactoryRunSummary = Schema.decodeUnknownSync(FactoryRunSummaryDto);
const decodeFactoryRunDetail = Schema.decodeUnknownSync(FactoryRunDetailDto);
const decodeFactoryRunList = Schema.decodeUnknownSync(FactoryRunListDto);
const decodeFactoryArtifactBody = Schema.decodeUnknownSync(FactoryArtifactBodyDto);

export const HealthLive = HttpApiBuilder.group(
  LocalGaiaServerApi,
  "health",
  (handlers) =>
    handlers.handle("health", () =>
      Effect.gen(function* () {
        const identity = yield* LocalServerConfig;
        const server = yield* HttpServer.HttpServer;
        const metadata = yield* serverMetadataFromAddress(
          identity,
          server.address,
        ).pipe(Effect.mapError((error) => internalApiError(error)));
        return HealthResponse.make({
          ...metadata,
          status: "ok",
        });
      }),
    ),
);

export const RunsLive = HttpApiBuilder.group(
  LocalGaiaServerApi,
  "runs",
  (handlers) =>
    handlers
      .handle("listRuns", () =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          yield* identity.runIndex.rebuild.pipe(
            Effect.mapError((error) => internalApiError(error)),
          );
          const runs = yield* identity.runIndex.list;
          return FactoryRunListSuccessEnvelope.make({
            data: factoryRunListFromLocalRuns(runs),
            status: "success",
          });
        }),
      )
      .handle("createRun", ({ payload }) =>
        Effect.gen(function* () {
          if (payload === undefined) {
            return yield* Effect.fail(
              createApiError({
                code: "InvalidRequest",
                message: "Create run requests must include a JSON body.",
                recoverable: false,
              }),
            );
          }

          const identity = yield* LocalServerConfig;
          const reservation = yield* identity.runRegistry.reserveCreate.pipe(
            Effect.mapError((error) => activeRunConflictApiError(error)),
          );
          const acceptedExit = yield* Effect.exit(
            acceptServerRun({
              specMarkdown: payload.workItem.description,
              title: payload.workItem.title,
            }, {
              ...identity.workflowOptions,
              rootDirectory: identity.rootDirectory,
            }),
          );

          if (acceptedExit._tag === "Failure") {
            yield* reservation.rollback;
            return yield* Effect.fail(apiErrorFromCause(acceptedExit.cause));
          }

          const accepted = acceptedExit.value;
          yield* identity.runIndex.refreshRun(accepted.runId);
          yield* reservation.markAccepted(accepted.runId);
          yield* forkServerContinuation({
            accepted,
            identity,
            reservation,
          });

          return CreateRunAcceptedResponse.make({
            acceptedAt: accepted.acceptedAt,
            runId: accepted.runId,
            status: "accepted",
            urls: {
              activity: `/runs/${accepted.runId}/activity`,
              artifacts: `/runs/${accepted.runId}/artifacts`,
              factoryGraph: `/runs/${accepted.runId}/factory-graph`,
              run: `/runs/${accepted.runId}`,
            },
          });
        }),
      )
      .handle("getRun", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          yield* identity.runIndex.refreshRun(params.runId);
          const exit = yield* Effect.exit(
            identity.runIndex.read(params.runId),
          );
          if (exit._tag === "Success") {
            return FactoryRunDetailSuccessEnvelope.make({
              data: factoryRunDetailFromLocalRun(exit.value),
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      )
      .handle("getFactoryGraph", () =>
        Effect.fail(
          LocalRunApiNotFound.make({
            code: "FactoryGraphNotFound",
            message:
              "Factory graph projection is not available until the runtime projection slice is implemented.",
            recoverable: true,
            status: 404,
          }),
        ),
      )
      .handle("getRunActivity", () =>
        Effect.fail(
          LocalRunApiNotFound.make({
            code: "EndpointNotFound",
            message:
              "Factory activity projection is not available until the runtime projection slice is implemented.",
            recoverable: true,
            status: 404,
          }),
        ),
      )
      .handle("getAgentActivity", ({ params }) =>
        Effect.fail(
          LocalRunApiNotFound.make({
            code: "FactoryAgentNotFound",
            message:
              "Factory agent activity projection is not available until the runtime projection slice is implemented.",
            pathSegment: params.agentId,
            recoverable: true,
            runId: params.runId,
            status: 404,
          }),
        ),
      )
      .handle("listRunArtifacts", ({ params }) =>
        Effect.fail(
          LocalRunApiNotFound.make({
            code: "EndpointNotFound",
            message:
              "Factory artifact catalog is not available until the runtime projection slice is implemented.",
            recoverable: true,
            runId: params.runId,
            status: 404,
          }),
        ),
      )
      .handle("getRunEvents", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(
            readLocalRunEvents(params.runId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (exit._tag === "Success") {
            return LocalRunEventsSuccessEnvelope.make({
              data: exit.value,
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      )
      .handle("streamRunEvents", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const initialRead = yield* Effect.exit(
            readLocalRunEvents(params.runId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (initialRead._tag === "Failure") {
            return yield* Effect.fail(readApiErrorFromCause(initialRead.cause));
          }

          const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
          return streamRunEvents({
            rootDirectory: identity.rootDirectory,
            runId: params.runId,
          }).pipe(Stream.provideContext(context));
        }),
      )
      .handle("getRunArtifact", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(
            readLocalRunArtifact(params.runId, params.artifactId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (exit._tag === "Success") {
            return FactoryArtifactSuccessEnvelope.make({
              data: factoryArtifactBodyFromLocalArtifact(exit.value),
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
      ),
);

export const LocalGaiaServerApiLayer = HttpApiBuilder.layer(LocalGaiaServerApi).pipe(
  Layer.provide(HealthLive),
  Layer.provide(RunsLive),
);

export function makeLocalGaiaServerLayer(
  identity: LocalServerIdentity,
  workflowOptions: ServerWorkflowOptions = {},
): Layer.Layer<
  never,
  unknown,
  | FileSystem.FileSystem
  | Path.Path
  | HttpServer.HttpServer
  | HttpPlatform
  | Generator
> {
  const configLayer = Layer.effect(
    LocalServerConfig,
    Effect.gen(function* () {
      const runIndex = yield* makeLocalRunReadIndex({
        rootDirectory: identity.rootDirectory,
      });
      const runRegistry = yield* makeServerRunRegistry();
      return {
        ...identity,
        runIndex,
        runRegistry,
        workflowOptions,
      } satisfies LocalServerConfigValue;
    }),
  );

  return HttpRouter.serve(LocalGaiaServerApiLayer, {
    disableListenLog: true,
    disableLogger: true,
    middleware: structuredServerErrors,
  }).pipe(
    Layer.provide(configLayer),
  );
}

function factoryRunListFromLocalRuns(
  runs: LocalRunList,
): typeof FactoryRunListDto.Type {
  return decodeFactoryRunList({
    diagnostics: runs.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      recoverable: diagnostic.recoverable,
      ...(diagnostic.pathSegment === undefined
        ? {}
        : { sourceId: diagnostic.pathSegment }),
    })),
    runs: runs.runs.map(factoryRunSummaryFromLocalRun),
  });
}

function factoryRunDetailFromLocalRun(
  run: LocalRunSummary,
): typeof FactoryRunDetailDto.Type {
  return decodeFactoryRunDetail({
    ...factoryRunSummaryFromLocalRun(run),
    urls: {
      activity: `/runs/${run.runId}/activity`,
      artifacts: `/runs/${run.runId}/artifacts`,
      factoryGraph: `/runs/${run.runId}/factory-graph`,
      run: `/runs/${run.runId}`,
    },
  });
}

function factoryRunSummaryFromLocalRun(
  run: LocalRunSummary,
): typeof FactoryRunSummaryDto.Type {
  return decodeFactoryRunSummary({
    counts: {
      activity: run.eventCount,
      agents: 0,
      artifacts: run.artifacts.length,
      workItems: 1,
    },
    createdAt: run.createdAt,
    rootWorkItem: {
      id: `work-item-${run.runId}`,
      kind: "issue",
      title: `Run ${run.runId}`,
    },
    runId: run.runId,
    state: factoryAgentStateFromLocalStatus(run.status),
    updatedAt: run.updatedAt,
    workflow: "issueDelivery",
  });
}

function factoryArtifactBodyFromLocalArtifact(
  artifact: LocalRunArtifact,
): typeof FactoryArtifactBodyDto.Type {
  return decodeFactoryArtifactBody({
    artifactId: artifact.artifactName,
    body: artifact.body,
    contentType: artifact.contentType,
    runId: artifact.runId,
  });
}

function factoryAgentStateFromLocalStatus(
  status: LocalRunSummary["status"],
) {
  switch (status) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "running":
      return "running";
  }
}

function structuredServerErrors<E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return HttpEffect.withPreResponseHandler(effect, (request, response) => {
    if (!isAllowedMethod(request.method, request.url)) {
      return errorJsonResponse(
        methodNotAllowedApiError({
          code: "MethodNotAllowed",
          message: "Local Gaia API method is not supported for this endpoint.",
          recoverable: false,
        }),
      );
    }

    if (!isEmptyResponse(response)) {
      return Effect.succeed(response);
    }

    if (response.status === 404) {
      return errorJsonResponse(
        apiError({
          code: "EndpointNotFound",
          message: "Local Gaia API endpoint was not found.",
          recoverable: false,
        }),
      );
    }

    if (response.status === 400) {
      const path = pathnameFromUrl(request.url);
      if (isArtifactReadPath(path)) {
        return errorJsonResponse(
          apiError({
            code: "ArtifactNotAllowed",
            message: "Artifact is not allowlisted for local API reads.",
            recoverable: false,
          }),
        );
      }

      return errorJsonResponse(
        apiError({
          code:
            request.method === "GET" && path.startsWith("/runs/")
              ? "InvalidRunId"
              : "InvalidRequest",
          message: "Local Gaia API request could not be parsed.",
          recoverable: false,
        }),
      );
    }

    return Effect.succeed(response);
  });
}

function errorJsonResponse(error: LocalRunApiError) {
  return HttpServerResponse.json(error, {
    status: statusForApiError(error),
  }).pipe(Effect.orDie);
}

function isEmptyResponse(response: HttpServerResponse.HttpServerResponse) {
  return response.body._tag === "Empty";
}

function isAllowedMethod(method: string, url: string) {
  if (method === "GET") {
    return true;
  }

  return method === "POST" && pathnameFromUrl(url) === "/runs";
}

function pathnameFromUrl(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function isArtifactReadPath(path: string) {
  return /^\/runs\/[^/]+\/artifacts\/[^/]+$/u.test(path);
}

function statusForApiError(error: LocalRunApiError) {
  return error.status;
}

function statusForDiagnostic(diagnostic: ApiDiagnostic) {
  switch (diagnostic.code) {
    case "InvalidRunId":
    case "InvalidRequest":
    case "InvalidSpec":
      return 400;
    case "ArtifactNotAllowed":
    case "ArtifactNotFound":
    case "EndpointNotFound":
    case "FactoryAgentNotFound":
    case "FactoryGraphNotFound":
    case "RunNotFound":
      return 404;
    case "MethodNotAllowed":
      return 405;
    case "ActiveRunConflict":
    case "RunStoreLocked":
      return 409;
    case "InvalidRunDirectory":
    case "RunHasNoEvents":
    case "RunUnreadable":
      return 422;
    case "InternalServerError":
      return 500;
  }
}

function readApiErrorFromCause(cause: Cause.Cause<unknown>): LocalRunReadApiError {
  return readApiError(causeToDiagnostic(cause));
}

function apiErrorFromCause(cause: Cause.Cause<unknown>): LocalRunCreateApiError {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      if (reason.error instanceof GaiaRuntimeError) {
        return apiErrorFromRuntimeError(reason.error);
      }

      if (isApiDiagnostic(reason.error)) {
        return createApiError(reason.error);
      }
    }
  }

  return internalApiError(cause);
}

function causeToDiagnostic(cause: Cause.Cause<unknown>): ApiDiagnostic {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && isRuntimeDiagnostic(reason.error)) {
      return reason.error;
    }

    if (Cause.isDieReason(reason)) {
      return {
        code: "InternalServerError",
        message: "Local Gaia API request failed.",
        recoverable: false,
      };
    }
  }

  return {
    code: "RunUnreadable",
    message: "Run could not be read from events.jsonl.",
    recoverable: false,
  };
}

function readApiError(diagnostic: ApiDiagnostic): LocalRunReadApiError {
  switch (diagnostic.code) {
    case "InvalidRequest":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRequest",
        status: 400,
      });
    case "InvalidRunId":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRunId",
        status: 400,
      });
    case "InvalidSpec":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidSpec",
        status: 400,
      });
    case "ArtifactNotAllowed":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "ArtifactNotAllowed",
        status: 404,
      });
    case "ArtifactNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "ArtifactNotFound",
        status: 404,
      });
    case "EndpointNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "EndpointNotFound",
        status: 404,
      });
    case "FactoryAgentNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "FactoryAgentNotFound",
        status: 404,
      });
    case "FactoryGraphNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "FactoryGraphNotFound",
        status: 404,
      });
    case "RunNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "RunNotFound",
        status: 404,
      });
    case "InvalidRunDirectory":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "InvalidRunDirectory",
        status: 422,
      });
    case "RunHasNoEvents":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunHasNoEvents",
        status: 422,
      });
    case "RunUnreadable":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunUnreadable",
        status: 422,
      });
    case "ActiveRunConflict":
    case "RunStoreLocked":
    case "InternalServerError":
    case "MethodNotAllowed":
      return internalApiError(diagnostic);
  }
}

function methodNotAllowedApiError(
  diagnostic: MethodNotAllowedDiagnostic,
): typeof LocalRunApiMethodNotAllowed.Type {
  return LocalRunApiMethodNotAllowed.make({
    ...diagnostic,
    code: "MethodNotAllowed",
    status: 405,
  });
}

function apiError(
  diagnostic: ApiDiagnostic,
): LocalRunApiError {
  switch (diagnostic.code) {
    case "InvalidRequest":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRequest",
        status: 400,
      });
    case "InvalidRunId":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRunId",
        status: 400,
      });
    case "InvalidSpec":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidSpec",
        status: 400,
      });
    case "ArtifactNotAllowed":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "ArtifactNotAllowed",
        status: 404,
      });
    case "ArtifactNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "ArtifactNotFound",
        status: 404,
      });
    case "EndpointNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "EndpointNotFound",
        status: 404,
      });
    case "FactoryAgentNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "FactoryAgentNotFound",
        status: 404,
      });
    case "FactoryGraphNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "FactoryGraphNotFound",
        status: 404,
      });
    case "RunNotFound":
      return LocalRunApiNotFound.make({
        ...diagnostic,
        code: "RunNotFound",
        status: 404,
      });
    case "MethodNotAllowed":
      return LocalRunApiMethodNotAllowed.make({
        ...diagnostic,
        code: "MethodNotAllowed",
        status: 405,
      });
    case "ActiveRunConflict":
      return LocalRunApiConflict.make({
        ...diagnostic,
        code: "ActiveRunConflict",
        status: 409,
      });
    case "RunStoreLocked":
      return LocalRunApiConflict.make({
        ...diagnostic,
        code: "RunStoreLocked",
        status: 409,
      });
    case "InvalidRunDirectory":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "InvalidRunDirectory",
        status: 422,
      });
    case "RunHasNoEvents":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunHasNoEvents",
        status: 422,
      });
    case "RunUnreadable":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunUnreadable",
        status: 422,
      });
    case "InternalServerError":
      return LocalRunApiInternalServerError.make({
        ...diagnostic,
        code: "InternalServerError",
        status: 500,
      });
  }

  return LocalRunApiInternalServerError.make({
    code: "InternalServerError",
    message: diagnostic.message,
    recoverable: false,
    status: 500,
  });
}

function createApiError(diagnostic: ApiDiagnostic): LocalRunCreateApiError {
  switch (diagnostic.code) {
    case "InvalidRequest":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRequest",
        status: 400,
      });
    case "InvalidRunId":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidRunId",
        status: 400,
      });
    case "InvalidSpec":
      return LocalRunApiBadRequest.make({
        ...diagnostic,
        code: "InvalidSpec",
        status: 400,
      });
    case "MethodNotAllowed":
      return methodNotAllowedApiError({
        ...diagnostic,
        code: "MethodNotAllowed",
      });
    case "ActiveRunConflict":
      return LocalRunApiConflict.make({
        ...diagnostic,
        code: "ActiveRunConflict",
        status: 409,
      });
    case "RunStoreLocked":
      return LocalRunApiConflict.make({
        ...diagnostic,
        code: "RunStoreLocked",
        status: 409,
      });
    case "InvalidRunDirectory":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "InvalidRunDirectory",
        status: 422,
      });
    case "RunHasNoEvents":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunHasNoEvents",
        status: 422,
      });
    case "RunUnreadable":
      return LocalRunApiUnprocessable.make({
        ...diagnostic,
        code: "RunUnreadable",
        status: 422,
      });
    case "ArtifactNotAllowed":
    case "ArtifactNotFound":
    case "EndpointNotFound":
    case "FactoryAgentNotFound":
    case "FactoryGraphNotFound":
    case "RunNotFound":
    case "InternalServerError":
      return internalApiError(diagnostic);
  }
}

function apiErrorFromRuntimeError(error: GaiaRuntimeError): LocalRunCreateApiError {
  switch (error.code) {
    case "InvalidSpec":
      return createApiError({
        code: "InvalidSpec",
        message: error.message,
        recoverable: error.recoverable,
      });
    case "RunStoreLocked":
      return createApiError({
        code: "RunStoreLocked",
        message: error.message,
        recoverable: error.recoverable,
      });
    default:
      return internalApiError(error);
  }
}

function activeRunConflictApiError(
  error: ActiveServerRunConflict,
): typeof LocalRunApiConflict.Type {
  return LocalRunApiConflict.make({
    code: "ActiveRunConflict",
    message: error.message,
    recoverable: error.recoverable,
    status: 409,
  });
}

function forkServerContinuation(input: {
  readonly accepted: ServerRunAcceptance;
  readonly identity: LocalServerConfigValue;
  readonly reservation: ServerRunReservation;
}) {
  return continueServerRun(input.accepted.runId, {
    ...input.identity.workflowOptions,
    rootDirectory: input.identity.rootDirectory,
  }).pipe(
    Effect.tapError((error) =>
      appendServerLog(
        input.identity.rootDirectory,
        `${new Date().toISOString()} ${input.identity.serverId} run ${input.accepted.runId} failed ${error.code}`,
      ).pipe(Effect.ignore),
    ),
    Effect.ensuring(
      input.identity.runIndex.refreshRun(input.accepted.runId).pipe(Effect.ignore),
    ),
    Effect.ensuring(input.reservation.clear),
    Effect.matchEffect({
      onFailure: () => Effect.void,
      onSuccess: () => Effect.void,
    }),
    Effect.forkDetach,
    Effect.asVoid,
  );
}

type EventStreamState = {
  readonly done: boolean;
  readonly nextSequence: number;
  readonly rootDirectory: string;
  readonly runId: string;
};

function streamRunEvents(input: {
  readonly rootDirectory: string;
  readonly runId: string;
}) {
  return Stream.unfold(
    {
      done: false,
      nextSequence: 1,
      rootDirectory: input.rootDirectory,
      runId: input.runId,
    } satisfies EventStreamState,
    readNextStreamEvent,
  );
}

function readNextStreamEvent(
  state: EventStreamState,
): Effect.Effect<
  readonly [RunEvent, EventStreamState] | undefined,
  typeof LocalRunApiErrorEnvelope.Type,
  FileSystem.FileSystem | Path.Path
> {
  if (state.done) {
    return Effect.succeed(undefined);
  }

  return Effect.gen(function* () {
    const events = yield* readLocalRunEvents(state.runId, {
      rootDirectory: state.rootDirectory,
    }).pipe(
      Effect.mapError((error: unknown) => streamApiError(error)),
    );
    const event = events.events.find(
      (candidate) => candidate.sequence === state.nextSequence,
    );

    if (event === undefined) {
      yield* Effect.sleep("50 millis");
      return yield* readNextStreamEvent(state);
    }

    const next: readonly [RunEvent, EventStreamState] = [
      event,
      {
        ...state,
        done: isTerminalRunEvent(event),
        nextSequence: event.sequence + 1,
      },
    ];

    return next;
  });
}

function streamApiError(error: unknown): typeof LocalRunApiErrorEnvelope.Type {
  const diagnostic = isRuntimeDiagnostic(error)
    ? LocalRunReadDiagnosticDto.make(error)
    : LocalRunReadDiagnosticDto.make({
        code: "InternalServerError",
        message: "Local Gaia event stream failed.",
        recoverable: false,
      });

  return LocalRunApiErrorEnvelope.make({
    ...diagnostic,
    status: statusForDiagnostic(diagnostic),
  });
}

function isTerminalRunEvent(event: RunEvent) {
  return event.type === "REPORT_COMPLETED" || event.type === "RUN_FAILED";
}

function isRuntimeDiagnostic(input: unknown): input is LocalRunReadDiagnostic {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    "message" in input &&
    "recoverable" in input
  );
}

function isApiDiagnostic(input: unknown): input is ApiDiagnostic {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    "message" in input &&
    "recoverable" in input
  );
}

type ApiDiagnostic = typeof LocalRunReadDiagnosticDto.Type;
type MethodNotAllowedDiagnostic = Omit<
  typeof LocalRunApiMethodNotAllowed.Type,
  "status"
>;
type LocalRunReadApiError =
  | typeof LocalRunApiBadRequest.Type
  | typeof LocalRunApiNotFound.Type
  | typeof LocalRunApiUnprocessable.Type
  | typeof LocalRunApiInternalServerError.Type;
type LocalRunCreateApiError =
  | typeof LocalRunApiBadRequest.Type
  | typeof LocalRunApiMethodNotAllowed.Type
  | typeof LocalRunApiConflict.Type
  | typeof LocalRunApiUnprocessable.Type
  | typeof LocalRunApiInternalServerError.Type;

function internalApiError(error: unknown): typeof LocalRunApiInternalServerError.Type {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Local Gaia API request failed.";

  return LocalRunApiInternalServerError.make({
    code: "InternalServerError",
    message,
    recoverable: false,
    status: 500,
  });
}
