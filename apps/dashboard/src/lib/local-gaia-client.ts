import {
  CreateRunRequest,
  FactoryArtifactIdSchema,
  FactoryRunDetailDto,
  FactoryRunSummaryDto,
  LocalGaiaServerApi,
  LocalRunApiErrorEnvelope,
  LocalRunArtifactSuccessEnvelope,
  LocalRunDetailSuccessEnvelope,
  LocalRunListSuccessEnvelope,
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

const decodeLocalRunListSuccess = Schema.decodeUnknownEffect(
  LocalRunListSuccessEnvelope,
);
const decodeLocalRunDetailSuccess = Schema.decodeUnknownEffect(
  LocalRunDetailSuccessEnvelope,
);
const decodeLocalRunArtifactSuccess = Schema.decodeUnknownEffect(
  LocalRunArtifactSuccessEnvelope,
);

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
    Effect.gen(function* () {
      const response = yield* client.runs.listRuns(undefined);
      return yield* decodeLocalRunListSuccess({
        data: {
          diagnostics: response.data.diagnostics,
          runs: response.data.runs.map(legacyRunSummaryFromFactoryRun),
        },
        status: "success",
      });
    }),
  );
}

export function getRunFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      const response = yield* client.runs.getRun({ params: { runId } });
      return yield* decodeLocalRunDetailSuccess({
        data: legacyRunSummaryFromFactoryRun(response.data),
        status: "success",
      });
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
      }).pipe(
        Effect.flatMap((response) =>
          decodeLocalRunArtifactSuccess({
            data: {
              artifactName: response.data.artifactId,
              body: response.data.body,
              contentType: response.data.contentType,
              runId: response.data.runId,
            },
            status: "success",
          }).pipe(
            Effect.mapError((cause) => parameterError("artifactId", cause)),
          ),
        ),
      );
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
        workflow: "issueDelivery",
        workItem: {
          description: config.specMarkdown,
          kind: "issue",
          title: config.title ?? "Dashboard issue delivery run",
        },
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
  return Schema.decodeUnknownEffect(FactoryArtifactIdSchema)(input).pipe(
    Effect.mapError((cause) => parameterError("artifactId", cause)),
  );
}

function legacyRunSummaryFromFactoryRun(
  run: typeof FactoryRunSummaryDto.Type | typeof FactoryRunDetailDto.Type,
) {
  return {
    artifacts: [],
    createdAt: run.createdAt,
    eventCount: run.counts.activity,
    latestEventType: legacyEventTypeFromFactoryState(run.state),
    runId: run.runId,
    state: legacyRunStateFromFactoryState(run.state),
    status: legacyStatusFromFactoryState(run.state),
    updatedAt: run.updatedAt,
  };
}

function legacyStatusFromFactoryState(state: typeof FactoryRunSummaryDto.Type.state) {
  switch (state) {
    case "succeeded":
      return "completed";
    case "canceled":
    case "failed":
      return "failed";
    case "blocked":
    case "pending":
    case "running":
    case "unknown":
      return "running";
  }
}

function legacyRunStateFromFactoryState(
  state: typeof FactoryRunSummaryDto.Type.state,
) {
  switch (state) {
    case "succeeded":
      return "completed";
    case "canceled":
    case "failed":
      return "failed";
    case "blocked":
    case "running":
      return "runningWorker";
    case "pending":
    case "unknown":
      return "created";
  }
}

function legacyEventTypeFromFactoryState(
  state: typeof FactoryRunSummaryDto.Type.state,
) {
  switch (state) {
    case "succeeded":
      return "REPORT_COMPLETED";
    case "canceled":
    case "failed":
      return "RUN_FAILED";
    case "blocked":
    case "running":
      return "WORKER_STARTED";
    case "pending":
    case "unknown":
      return "RUN_CREATED";
  }
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
