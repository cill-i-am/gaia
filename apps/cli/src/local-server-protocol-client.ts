import {
  CreateRunRequest,
  DeliveryEvaluateMergeReadinessActionRequest,
  FactoryArtifactIdSchema,
  LocalGaiaServerApi,
  LocalGaiaServerUrlSchema,
  LocalRunReadArtifactIdSchema,
  type LocalGaiaServerUrl,
  type LocalRunApiError,
  RunIdSchema,
  type VerificationActionRequest,
} from "@gaia/core";
import { Cause, Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const fetchTimeoutMs = 2_000;

const LocalServerUrlInputSchema = Schema.Struct({
  serverUrl: LocalGaiaServerUrlSchema,
});
const LocalServerRunInputSchema = Schema.Struct({
  runId: RunIdSchema,
  serverUrl: LocalGaiaServerUrlSchema,
});
const LocalServerArtifactInputSchema = Schema.Struct({
  artifactName: Schema.String,
  runId: RunIdSchema,
  serverUrl: LocalGaiaServerUrlSchema,
});
const LocalServerCreateRunInputSchema = Schema.Struct({
  payload: CreateRunRequest,
  serverUrl: LocalGaiaServerUrlSchema,
});
const LocalServerMergeReadinessInputSchema = Schema.Struct({
  payload: DeliveryEvaluateMergeReadinessActionRequest,
  runId: RunIdSchema,
  serverUrl: LocalGaiaServerUrlSchema,
});

/**
 * Expected failures surfaced by the local Gaia generated protocol client.
 */
export type LocalGaiaServerProtocolError =
  | LocalRunApiError
  | LocalGaiaServerProtocolParameterError
  | Schema.SchemaError
  | HttpClientError.HttpClientError
  | Cause.TimeoutError;

/**
 * A schema failure for a URL path parameter before the request is sent.
 */
export type LocalGaiaServerProtocolParameterError = {
  readonly _tag: "LocalGaiaServerProtocolParameterError";
  readonly cause: Schema.SchemaError;
  readonly parameter: "artifactId";
};

/**
 * Provides the local Gaia protocol client's HTTP transport through platform fetch.
 */
export const LocalGaiaServerProtocolClientLive = FetchHttpClient.layer;

/**
 * Reads the local server run list through the shared `LocalGaiaServerApi` contract.
 */
export function listRunsFromLocalServerProtocol(
  input: typeof LocalServerUrlInputSchema.Type
) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.runs.listRuns(undefined)
  );
}

/**
 * Reads one local server run summary through the shared `LocalGaiaServerApi` contract.
 */
export function getRunFromLocalServerProtocol(
  input: typeof LocalServerRunInputSchema.Type
) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.runs.getRun({ params: { runId: input.runId } })
  );
}

/**
 * Reads one local server run's events through the shared `LocalGaiaServerApi` contract.
 */
export function getRunEventsFromLocalServerProtocol(
  input: typeof LocalServerRunInputSchema.Type
) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.runs.getRunEvents({ params: { runId: input.runId } })
  );
}

/**
 * Reads an allowlisted logical run artifact through the shared API contract.
 */
export function getRunArtifactFromLocalServerProtocol(
  input: typeof LocalServerArtifactInputSchema.Type
) {
  return Effect.gen(function* () {
    const artifactId = yield* decodeArtifactIdParameter(input.artifactName);
    return yield* withLocalGaiaServerClient(input.serverUrl, (client) =>
      client.runs.getRunArtifact({
        params: {
          artifactId,
          runId: input.runId,
        },
      })
    );
  });
}

/**
 * Creates a local server run from an already parsed create-run request payload.
 */
export function createRunFromLocalServerProtocol(
  input: typeof LocalServerCreateRunInputSchema.Type
) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.runs.createRun({ payload: input.payload })
  );
}

export function evaluateMergeReadinessFromLocalServerProtocol(
  input: typeof LocalServerMergeReadinessInputSchema.Type
) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.runs.actOnDelivery({
      params: { runId: input.runId },
      payload: DeliveryEvaluateMergeReadinessActionRequest.make(input.payload),
    })
  );
}

/** Send one already-parsed verification action through the shared protocol. */
export function actOnVerificationFromLocalServerProtocol(input: {
  readonly payload: VerificationActionRequest;
  readonly runId: typeof RunIdSchema.Type;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    input.payload.kind === "startPostPublicationGeneration"
      ? client.runs.actOnRunVerification({
          params: { runId: input.runId },
          payload: input.payload,
        })
      : client.runs.actOnRunVerification({
          params: { runId: input.runId },
          payload: input.payload,
        })
  );
}

/**
 * Reads local server health through the shared `LocalGaiaServerApi` contract.
 */
export function healthFromLocalServerProtocol(
  input: typeof LocalServerUrlInputSchema.Type
) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.health.health(undefined)
  );
}

function withLocalGaiaServerClient<A, E, R>(
  serverUrl: LocalGaiaServerUrl,
  useClient: (
    client: HttpApiClient.ForApi<typeof LocalGaiaServerApi>
  ) => Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E | LocalGaiaServerProtocolError,
  R | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const client = yield* HttpApiClient.make(LocalGaiaServerApi, {
      baseUrl: normalizedServerUrl(serverUrl),
    });
    return yield* useClient(client);
  }).pipe(Effect.timeout(`${fetchTimeoutMs} millis`));
}

function decodeArtifactIdParameter(input: string) {
  return Schema.decodeUnknownEffect(LocalRunReadArtifactIdSchema)(input).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FactoryArtifactIdSchema)),
    Effect.mapError((cause) => protocolParameterError("artifactId", cause))
  );
}

function protocolParameterError(
  parameter: LocalGaiaServerProtocolParameterError["parameter"],
  cause: Schema.SchemaError
): LocalGaiaServerProtocolParameterError {
  return {
    _tag: "LocalGaiaServerProtocolParameterError",
    cause,
    parameter,
  };
}

function normalizedServerUrl(serverUrl: LocalGaiaServerUrl) {
  return serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`;
}
