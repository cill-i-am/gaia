import {
  CreateRunRequest,
  LocalGaiaServerApi,
  LocalRunApiErrorEnvelope,
  LocalRunArtifactIdSchema,
  RunIdSchema,
} from "@gaia/core";
import { Cause, Effect, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const fetchTimeoutMs = 2_000;

export const defaultLocalGaiaServerUrl = "/gaia-api";

export type DashboardGaiaClientError =
  | {
      readonly _tag: "DashboardGaiaApiError";
      readonly error: typeof LocalRunApiErrorEnvelope.Type;
    }
  | {
      readonly _tag: "DashboardGaiaHttpClientError";
      readonly error: HttpClientError.HttpClientError;
    }
  | {
      readonly _tag: "DashboardGaiaParameterError";
      readonly cause: Schema.SchemaError;
      readonly parameter: "artifactId" | "createRun" | "runId";
    }
  | {
      readonly _tag: "DashboardGaiaTimeoutError";
      readonly cause: Cause.TimeoutError;
    }
  | {
      readonly _tag: "DashboardGaiaUnexpectedError";
      readonly cause: unknown;
    };

export type DashboardGaiaClientConfig = {
  readonly serverUrl: string;
};

export const DashboardGaiaFetchClientLive = FetchHttpClient.layer;

export function healthFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig,
) {
  return withDashboardGaiaClient(config, (client) =>
    client.health.health(undefined),
  );
}

export function listRunsFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig,
) {
  return withDashboardGaiaClient(config, (client) =>
    client.runs.listRuns(undefined),
  );
}

export function getRunFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      return yield* client.runs.getRun({ params: { runId } });
    }),
  );
}

export function getRunEventsFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      return yield* client.runs.getRunEvents({ params: { runId } });
    }),
  );
}

export function getRunArtifactFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly artifactId: string;
    readonly runId: string;
  },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      const artifactId = yield* decodeArtifactIdParameter(config.artifactId);
      return yield* client.runs.getRunArtifact({
        params: {
          artifactId,
          runId,
        },
      });
    }),
  );
}

export function createRunFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly specMarkdown: string;
    readonly title?: string;
  },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const payload = yield* CreateRunRequest.makeEffect({
        specMarkdown: config.specMarkdown,
        ...(config.title === undefined ? {} : { title: config.title }),
      }).pipe(
        Effect.mapError((cause) =>
          parameterError("createRun", cause),
        ),
      );

      return yield* client.runs.createRun({ payload });
    }),
  );
}

function withDashboardGaiaClient<A, E, R>(
  config: DashboardGaiaClientConfig,
  useClient: (
    client: HttpApiClient.ForApi<typeof LocalGaiaServerApi>,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  DashboardGaiaClientError,
  R | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const client = yield* HttpApiClient.make(LocalGaiaServerApi, {
      baseUrl: normalizedServerUrl(config.serverUrl),
    });
    return yield* useClient(client);
  }).pipe(
    Effect.timeout(`${fetchTimeoutMs} millis`),
    Effect.mapError(toDashboardGaiaClientError),
  );
}

function decodeRunIdParameter(input: string) {
  return Schema.decodeUnknownEffect(RunIdSchema)(input).pipe(
    Effect.mapError((cause) => parameterError("runId", cause)),
  );
}

function decodeArtifactIdParameter(input: string) {
  return Schema.decodeUnknownEffect(LocalRunArtifactIdSchema)(input).pipe(
    Effect.mapError((cause) => parameterError("artifactId", cause)),
  );
}

function parameterError(
  parameter: "artifactId" | "createRun" | "runId",
  cause: Schema.SchemaError,
): DashboardGaiaClientError {
  return {
    _tag: "DashboardGaiaParameterError",
    cause,
    parameter,
  };
}

function toDashboardGaiaClientError(
  error: unknown,
): DashboardGaiaClientError {
  if (isDashboardGaiaClientError(error)) {
    return error;
  }

  const apiError = Schema.decodeUnknownOption(LocalRunApiErrorEnvelope)(error);
  if (Option.isSome(apiError)) {
    return {
      _tag: "DashboardGaiaApiError",
      error: apiError.value,
    };
  }

  if (HttpClientError.isHttpClientError(error)) {
    return {
      _tag: "DashboardGaiaHttpClientError",
      error,
    };
  }

  if (Cause.isTimeoutError(error)) {
    return {
      _tag: "DashboardGaiaTimeoutError",
      cause: error,
    };
  }

  return {
    _tag: "DashboardGaiaUnexpectedError",
    cause: error,
  };
}

function isDashboardGaiaClientError(
  error: unknown,
): error is DashboardGaiaClientError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    error._tag.startsWith("DashboardGaia")
  );
}

function normalizedServerUrl(serverUrl: string) {
  return serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`;
}
