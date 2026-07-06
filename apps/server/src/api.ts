import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApiBadRequest,
  ApiConflict,
  ApiInternalServerError,
  ApiMethodNotAllowed,
  ApiNotFound,
  HealthResponse,
  LocalGaiaServerApi,
  LocalRunArtifact,
  LocalRunArtifactSuccess,
  LocalRunDetailSuccess,
  LocalRunEvents,
  LocalRunEventsSuccess,
  LocalRunList,
  LocalRunListPartial,
  LocalRunListSuccess,
  LocalRunReadDiagnostic,
  LocalRunSummary,
  type LocalRunReadDiagnosticCodeSchema,
} from "@gaia/core";
import {
  listLocalRuns,
  readLocalRun,
  readLocalRunArtifact,
  readLocalRunEvents,
  type LocalRunArtifact as RuntimeLocalRunArtifact,
  type LocalRunEvents as RuntimeLocalRunEvents,
  type LocalRunReadDiagnostic as RuntimeLocalRunReadDiagnostic,
  type LocalRunSummary as RuntimeLocalRunSummary,
} from "@gaia/runtime";
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { serverMetadata, type LocalGaiaServerConfig } from "./discovery.js";

type ApiErrorResponse =
  | ApiBadRequest
  | ApiConflict
  | ApiInternalServerError
  | ApiMethodNotAllowed
  | ApiNotFound;

function makeHealthLive(config: LocalGaiaServerConfig) {
  return HttpApiBuilder.group(
    LocalGaiaServerApi,
    "health",
    (handlers) =>
      handlers.handle("health", () =>
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          return HealthResponse.make({
            server: serverMetadata(config, server),
            status: "ok",
          });
        })),
  );
}

function makeRunsLive(config: LocalGaiaServerConfig) {
  return HttpApiBuilder.group(LocalGaiaServerApi, "runs", (handlers) =>
    handlers
      .handle("listRuns", () =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            listLocalRuns({
              rootDirectory: config.rootDirectory,
            }),
          );
          if (exit._tag === "Failure") {
            return yield* Effect.fail(apiErrorFromCause(exit.cause));
          }

          const runs = exit.value;
          const data = LocalRunList.make({
            diagnostics: runs.diagnostics.map(localRunReadDiagnostic),
            runs: runs.runs.map(localRunSummary),
          });

          if (runs.diagnostics.length === 0) {
            return LocalRunListSuccess.make({ data, status: "success" });
          }

          return LocalRunListPartial.make({
            data,
            diagnostics: data.diagnostics,
            status: "partial",
          });
        }))
      .handle("createRun", () =>
        Effect.fail(
          ApiMethodNotAllowed.make({
            error: LocalRunReadDiagnostic.make({
              code: "MethodNotAllowed",
              message: "Run creation is not implemented in this server slice.",
              recoverable: false,
            }),
            status: "error",
          }),
        ))
      .handle("getRun", ({ params }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            readLocalRun(params.runId, { rootDirectory: config.rootDirectory }),
          );

          if (exit._tag === "Success") {
            return LocalRunDetailSuccess.make({
              data: localRunSummary(exit.value),
              status: "success",
            });
          }

          return yield* Effect.fail(apiErrorFromCause(exit.cause));
        }))
      .handle("getRunEvents", ({ params }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            readLocalRunEvents(params.runId, {
              rootDirectory: config.rootDirectory,
            }),
          );

          if (exit._tag === "Success") {
            return LocalRunEventsSuccess.make({
              data: localRunEvents(exit.value),
              status: "success",
            });
          }

          return yield* Effect.fail(apiErrorFromCause(exit.cause));
        }))
      .handle("streamRunEvents", () =>
        Effect.fail(
          ApiMethodNotAllowed.make({
            error: LocalRunReadDiagnostic.make({
              code: "MethodNotAllowed",
              message: "Event streaming is not implemented in this server slice.",
              recoverable: false,
            }),
            status: "error",
          }),
        ))
      .handle("getArtifact", ({ params }) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            readLocalRunArtifact(params.runId, params.artifactId, {
              rootDirectory: config.rootDirectory,
            }),
          );

          if (exit._tag === "Success") {
            return LocalRunArtifactSuccess.make({
              data: localRunArtifact(exit.value),
              status: "success",
            });
          }

          return yield* Effect.fail(apiErrorFromCause(exit.cause));
        })),
  );
}

export function makeLocalGaiaServerLayer(config: LocalGaiaServerConfig) {
  const handlers = Layer.mergeAll(makeHealthLive(config), makeRunsLive(config));
  const api = Layer.mergeAll(
    HttpApiBuilder.layer(LocalGaiaServerApi).pipe(Layer.provide(handlers)),
    makeNotFoundLive(),
  );

  return HttpRouter.serve(api, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(Layer.provide(NodeServices.layer));
}

function makeNotFoundLive() {
  return HttpRouter.add("*", "/*", endpointNotFoundResponse());
}

function endpointNotFoundResponse() {
  return HttpServerResponse.jsonUnsafe(
    ApiNotFound.make({
      error: LocalRunReadDiagnostic.make({
        code: "EndpointNotFound",
        message: "Endpoint does not exist.",
        recoverable: false,
      }),
      status: "error",
    }),
    { status: 404 },
  );
}

function localRunSummary(run: RuntimeLocalRunSummary) {
  return LocalRunSummary.make({
    artifacts: [...run.artifacts],
    createdAt: run.createdAt,
    eventCount: run.eventCount,
    latestEventType: run.latestEventType,
    runId: run.runId,
    state: run.state,
    status: run.status,
    updatedAt: run.updatedAt,
  });
}

function localRunEvents(events: RuntimeLocalRunEvents) {
  return LocalRunEvents.make({
    events: [...events.events],
    runId: events.runId,
  });
}

function localRunArtifact(artifact: RuntimeLocalRunArtifact) {
  return LocalRunArtifact.make({
    artifactName: artifact.artifactName,
    body: artifact.body,
    contentType: artifact.contentType,
    runId: artifact.runId,
  });
}

function localRunReadDiagnostic(diagnostic: RuntimeLocalRunReadDiagnostic) {
  return LocalRunReadDiagnostic.make({
    ...(diagnostic.artifactName === undefined
      ? {}
      : { artifactName: diagnostic.artifactName }),
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.pathSegment === undefined
      ? {}
      : { pathSegment: diagnostic.pathSegment }),
    recoverable: diagnostic.recoverable,
    ...(diagnostic.runId === undefined ? {} : { runId: diagnostic.runId }),
  });
}

function apiErrorFromCause(cause: Cause.Cause<unknown>): ApiErrorResponse {
  return apiErrorFromDiagnostic(diagnosticFromCause(cause));
}

function diagnosticFromCause(cause: Cause.Cause<unknown>) {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && isRuntimeDiagnostic(reason.error)) {
      return localRunReadDiagnostic(reason.error);
    }
  }

  return LocalRunReadDiagnostic.make({
    code: "RunUnreadable",
    message: "Run could not be read from events.jsonl.",
    recoverable: false,
  });
}

function apiErrorFromDiagnostic(diagnostic: LocalRunReadDiagnostic): ApiErrorResponse {
  if (diagnostic.code === "InvalidRunId") {
    return ApiBadRequest.make({ error: diagnostic, status: "error" });
  }

  if (
    diagnostic.code === "ArtifactNotAllowed" ||
    diagnostic.code === "ArtifactNotFound" ||
    diagnostic.code === "EndpointNotFound" ||
    diagnostic.code === "RunNotFound"
  ) {
    return ApiNotFound.make({ error: diagnostic, status: "error" });
  }

  if (diagnostic.code === "MethodNotAllowed") {
    return ApiMethodNotAllowed.make({ error: diagnostic, status: "error" });
  }

  return ApiInternalServerError.make({ error: diagnostic, status: "error" });
}

function isRuntimeDiagnostic(
  input: unknown,
): input is RuntimeLocalRunReadDiagnostic {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  if (
    !("code" in input) ||
    !("message" in input) ||
    !("recoverable" in input)
  ) {
    return false;
  }

  return (
    isDiagnosticCode(input.code) &&
    typeof input.message === "string" &&
    typeof input.recoverable === "boolean"
  );
}

function isDiagnosticCode(
  code: unknown,
): code is typeof LocalRunReadDiagnosticCodeSchema.Type {
  return (
    code === "ArtifactNotAllowed" ||
    code === "ArtifactNotFound" ||
    code === "InvalidRunDirectory" ||
    code === "InvalidRunId" ||
    code === "RunHasNoEvents" ||
    code === "RunNotFound" ||
    code === "RunUnreadable"
  );
}
