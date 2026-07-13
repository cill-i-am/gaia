import {
  CreateRunRequest,
  DeliveryEvaluateMergeReadinessActionRequest,
  FactoryArtifactIdSchema,
  LocalGaiaServerApi,
  type LocalGaiaServerUrl,
  type LocalRunApiError,
  type RunId,
} from "@gaia/core";
import { Cause, Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const fetchTimeoutMs = 2_000;

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
export function listRunsFromLocalServerProtocol(input: {
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.runs.listRuns(undefined)
  );
}

/**
 * Reads one local server run summary through the shared `LocalGaiaServerApi` contract.
 */
export function getRunFromLocalServerProtocol(input: {
  readonly runId: RunId;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.runs.getRun({ params: { runId: input.runId } })
  );
}

/**
 * Reads one local server run's events through the shared `LocalGaiaServerApi` contract.
 */
export function getRunEventsFromLocalServerProtocol(input: {
  readonly runId: RunId;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.runs.getRunEvents({ params: { runId: input.runId } })
  );
}

/**
 * Reads an allowlisted logical run artifact through the shared API contract.
 */
export function getRunArtifactFromLocalServerProtocol(input: {
  readonly artifactName: string;
  readonly runId: RunId;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    Effect.gen(function* () {
      const artifactId = yield* decodeArtifactIdParameter(input.artifactName);
      return yield* client.runs.getRunArtifact({
        params: {
          artifactId,
          runId: input.runId,
        },
      });
    })
  );
}

/**
 * Creates a local server run from an already parsed create-run request payload.
 */
export function createRunFromLocalServerProtocol(input: {
  readonly payload: typeof CreateRunRequest.Type;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.runs.createRun({ payload: input.payload })
  );
}

export function evaluateMergeReadinessFromLocalServerProtocol(input: {
  readonly payload: typeof DeliveryEvaluateMergeReadinessActionRequest.Type;
  readonly runId: RunId;
  readonly serverUrl: LocalGaiaServerUrl;
}) {
  return withLocalGaiaServerClient(input.serverUrl, (client) =>
    client.runs.actOnDelivery({
      params: { runId: input.runId },
      payload: DeliveryEvaluateMergeReadinessActionRequest.make(input.payload),
    })
  );
}

/**
 * Reads local server health through the shared `LocalGaiaServerApi` contract.
 */
export function healthFromLocalServerProtocol(input: {
  readonly serverUrl: LocalGaiaServerUrl;
}) {
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
  return Schema.decodeUnknownEffect(FactoryArtifactIdSchema)(input).pipe(
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
