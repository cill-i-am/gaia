import {
  HealthResponse,
  LocalGaiaServerApi,
  LocalRunApiBadRequest,
  LocalRunApiConflict,
  LocalRunApiInternalServerError,
  LocalRunApiMethodNotAllowed,
  LocalRunApiNotFound,
  LocalRunApiUnprocessable,
  LocalRunArtifactSuccessEnvelope,
  LocalRunDetailSuccessEnvelope,
  LocalRunEventsSuccessEnvelope,
  LocalRunListPartialEnvelope,
  LocalRunListSuccessEnvelope,
  type LocalRunApiError,
  LocalRunReadDiagnosticDto,
} from "@gaia/core";
import type { LocalRunReadDiagnostic } from "@gaia/runtime/run-read-api";
import {
  listLocalRuns,
  readLocalRun,
  readLocalRunArtifact,
  readLocalRunEvents,
} from "@gaia/runtime/run-read-api";
import { Cause, Context, Effect, FileSystem, Layer, Path } from "effect";
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
  serverMetadataFromAddress,
  type LocalServerIdentity,
} from "./discovery.js";

export class LocalServerConfig extends Context.Service<LocalServerConfig, LocalServerIdentity>()(
  "@gaia/server/LocalServerConfig",
) {}

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
          const runs = yield* listLocalRuns({
            rootDirectory: identity.rootDirectory,
          }).pipe(Effect.mapError((error) => internalApiError(error)));
          if (runs.diagnostics.length === 0) {
            return LocalRunListSuccessEnvelope.make({
              data: runs,
              status: "success",
            });
          }

          return LocalRunListPartialEnvelope.make({
            data: runs,
            diagnostics: runs.diagnostics,
            status: "partial",
          });
        }),
      )
      .handle("createRun", () =>
        Effect.fail(
          methodNotAllowedApiError({
            code: "MethodNotAllowed",
            message: "Local Gaia API is read-only in GAIA-12.",
            recoverable: false,
          }),
        ),
      )
      .handle("getRun", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* LocalServerConfig;
          const exit = yield* Effect.exit(
            readLocalRun(params.runId, {
              rootDirectory: identity.rootDirectory,
            }),
          );
          if (exit._tag === "Success") {
            return LocalRunDetailSuccessEnvelope.make({
              data: exit.value,
              status: "success",
            });
          }

          return yield* Effect.fail(readApiErrorFromCause(exit.cause));
        }),
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
      .handle("streamRunEvents", () =>
        Effect.fail(
          methodNotAllowedApiError({
            code: "MethodNotAllowed",
            message: "Event streaming is a contract placeholder for a later Gaia slice.",
            recoverable: false,
          }),
        ),
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
            return LocalRunArtifactSuccessEnvelope.make({
              data: exit.value,
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
): Layer.Layer<
  never,
  never,
  | FileSystem.FileSystem
  | Path.Path
  | HttpServer.HttpServer
  | HttpPlatform
  | Generator
> {
  return HttpRouter.serve(LocalGaiaServerApiLayer, {
    disableListenLog: true,
    disableLogger: true,
    middleware: structuredServerErrors,
  }).pipe(
    Layer.provide(Layer.succeed(LocalServerConfig)(identity)),
  );
}

function structuredServerErrors<E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  return HttpEffect.withPreResponseHandler(effect, (request, response) => {
    if (request.method !== "GET") {
      return errorJsonResponse(
        methodNotAllowedApiError({
          code: "MethodNotAllowed",
          message: "Local Gaia API is read-only in GAIA-12.",
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
      return errorJsonResponse(
        apiError({
          code: "InvalidRunId",
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

function statusForApiError(error: LocalRunApiError) {
  switch (error.error.code) {
    case "InvalidRunId":
      return 400;
    case "ArtifactNotAllowed":
    case "ArtifactNotFound":
    case "EndpointNotFound":
    case "RunNotFound":
      return 404;
    case "MethodNotAllowed":
      return 405;
    case "ActiveRunConflict":
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
    case "InvalidRunId":
      return LocalRunApiBadRequest.make({
        error: { ...diagnostic, code: "InvalidRunId" },
        status: "error",
      });
    case "ArtifactNotAllowed":
      return LocalRunApiNotFound.make({
        error: { ...diagnostic, code: "ArtifactNotAllowed" },
        status: "error",
      });
    case "ArtifactNotFound":
      return LocalRunApiNotFound.make({
        error: { ...diagnostic, code: "ArtifactNotFound" },
        status: "error",
      });
    case "EndpointNotFound":
      return LocalRunApiNotFound.make({
        error: { ...diagnostic, code: "EndpointNotFound" },
        status: "error",
      });
    case "RunNotFound":
      return LocalRunApiNotFound.make({
        error: { ...diagnostic, code: "RunNotFound" },
        status: "error",
      });
    case "InvalidRunDirectory":
      return LocalRunApiUnprocessable.make({
        error: { ...diagnostic, code: "InvalidRunDirectory" },
        status: "error",
      });
    case "RunHasNoEvents":
      return LocalRunApiUnprocessable.make({
        error: { ...diagnostic, code: "RunHasNoEvents" },
        status: "error",
      });
    case "RunUnreadable":
      return LocalRunApiUnprocessable.make({
        error: { ...diagnostic, code: "RunUnreadable" },
        status: "error",
      });
    case "ActiveRunConflict":
    case "InternalServerError":
    case "MethodNotAllowed":
      return internalApiError(diagnostic);
  }
}

function methodNotAllowedApiError(
  diagnostic: MethodNotAllowedDiagnostic,
): typeof LocalRunApiMethodNotAllowed.Type {
  return LocalRunApiMethodNotAllowed.make({
    error: { ...diagnostic, code: "MethodNotAllowed" },
    status: "error",
  });
}

function apiError(
  diagnostic: ApiDiagnostic,
): LocalRunApiError {
  switch (diagnostic.code) {
    case "InvalidRunId":
      return LocalRunApiBadRequest.make({
        error: { ...diagnostic, code: "InvalidRunId" },
        status: "error",
      });
    case "ArtifactNotAllowed":
      return LocalRunApiNotFound.make({
        error: { ...diagnostic, code: "ArtifactNotAllowed" },
        status: "error",
      });
    case "ArtifactNotFound":
      return LocalRunApiNotFound.make({
        error: { ...diagnostic, code: "ArtifactNotFound" },
        status: "error",
      });
    case "EndpointNotFound":
      return LocalRunApiNotFound.make({
        error: { ...diagnostic, code: "EndpointNotFound" },
        status: "error",
      });
    case "RunNotFound":
      return LocalRunApiNotFound.make({
        error: { ...diagnostic, code: "RunNotFound" },
        status: "error",
      });
    case "MethodNotAllowed":
      return LocalRunApiMethodNotAllowed.make({
        error: { ...diagnostic, code: "MethodNotAllowed" },
        status: "error",
      });
    case "ActiveRunConflict":
      return LocalRunApiConflict.make({
        error: { ...diagnostic, code: "ActiveRunConflict" },
        status: "error",
      });
    case "InvalidRunDirectory":
      return LocalRunApiUnprocessable.make({
        error: { ...diagnostic, code: "InvalidRunDirectory" },
        status: "error",
      });
    case "RunHasNoEvents":
      return LocalRunApiUnprocessable.make({
        error: { ...diagnostic, code: "RunHasNoEvents" },
        status: "error",
      });
    case "RunUnreadable":
      return LocalRunApiUnprocessable.make({
        error: { ...diagnostic, code: "RunUnreadable" },
        status: "error",
      });
    case "InternalServerError":
      return LocalRunApiInternalServerError.make({
        error: { ...diagnostic, code: "InternalServerError" },
        status: "error",
      });
  }

  return LocalRunApiInternalServerError.make({
    error: {
      code: "InternalServerError",
      message: diagnostic.message,
      recoverable: false,
    },
    status: "error",
  });
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

type ApiDiagnostic = typeof LocalRunReadDiagnosticDto.Type;
type MethodNotAllowedDiagnostic =
  (typeof LocalRunApiMethodNotAllowed.Type)["error"];
type LocalRunReadApiError =
  | typeof LocalRunApiBadRequest.Type
  | typeof LocalRunApiNotFound.Type
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
    error: {
      code: "InternalServerError",
      message,
      recoverable: false,
    },
    status: "error",
  });
}
