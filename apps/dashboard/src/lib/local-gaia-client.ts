import {
  AgentOperatorActionRequestSchema,
  AgentSessionSnapshotSuccessEnvelope,
  AgentSessionUpdateDto,
  CreateRunRequest,
  codexAppServerExecutionSelection,
  FactoryActivitySuccessEnvelope,
  FactoryAgentIdSchema,
  FactoryArtifactListSuccessEnvelope,
  FactoryArtifactIdSchema,
  FactoryArtifactSuccessEnvelope,
  FactoryGraphSuccessEnvelope,
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
      readonly parameter: "action" | "agentId" | "artifactId" | "createRun" | "runId";
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
const decodeFactoryGraphSuccess = Schema.decodeUnknownEffect(
  FactoryGraphSuccessEnvelope,
);
const decodeFactoryActivitySuccess = Schema.decodeUnknownEffect(
  FactoryActivitySuccessEnvelope,
);
const decodeFactoryArtifactListSuccess = Schema.decodeUnknownEffect(
  FactoryArtifactListSuccessEnvelope,
);
const decodeFactoryArtifactSuccess = Schema.decodeUnknownEffect(
  FactoryArtifactSuccessEnvelope,
);
const decodeAgentSessionSnapshotSuccess = Schema.decodeUnknownEffect(
  AgentSessionSnapshotSuccessEnvelope,
);
const decodeAgentSessionUpdate = Schema.decodeUnknownSync(AgentSessionUpdateDto);

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

export function getFactoryGraphFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      const response = yield* client.runs.getFactoryGraph({
        params: { runId },
      });
      return yield* decodeFactoryGraphSuccess(response);
    }),
  );
}

export function getFactoryRunActivityFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      const response = yield* client.runs.getRunActivity({
        params: { runId },
      });
      return yield* decodeFactoryActivitySuccess(response);
    }),
  );
}

export function getFactoryAgentActivityFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly agentId: string;
    readonly runId: string;
  },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      const agentId = yield* decodeAgentIdParameter(config.agentId);
      const response = yield* client.runs.getAgentActivity({
        params: { agentId, runId },
      });
      return yield* decodeFactoryActivitySuccess(response);
    }),
  );
}

export function getAgentSessionFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly agentId: string; readonly runId: string },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      const agentId = yield* decodeAgentIdParameter(config.agentId);
      return yield* client.runs.getAgentSession({ params: { agentId, runId } }).pipe(Effect.flatMap(decodeAgentSessionSnapshotSuccess));
    }),
  );
}

export function actOnAgentSessionFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly action: unknown; readonly agentId: string; readonly runId: string },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      const agentId = yield* decodeAgentIdParameter(config.agentId);
      const payload = yield* Schema.decodeUnknownEffect(AgentOperatorActionRequestSchema)(config.action).pipe(Effect.mapError((cause) => parameterError("action", cause)));
      const params = { agentId, runId };
      switch (payload.kind) {
        case "followUp": return yield* client.runs.actOnAgentSession({ params, payload });
        case "steer": return yield* client.runs.actOnAgentSession({ params, payload });
        case "interrupt": return yield* client.runs.actOnAgentSession({ params, payload });
        case "approval": return yield* client.runs.actOnAgentSession({ params, payload });
        case "userInput": return yield* client.runs.actOnAgentSession({ params, payload });
        case "mcpElicitation": return yield* client.runs.actOnAgentSession({ params, payload });
      }
    }),
  );
}

export type AgentSessionEventSource = {
  close(): void;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: string; readonly lastEventId: string }) => void) | null;
};

/** Browser-owned SSE lifecycle. The caller closes on run/agent change or unmount. */
export function openAgentSessionEventSource(
  config: DashboardGaiaClientConfig & { readonly afterSequence?: number; readonly agentId: string; readonly runId: string },
  handlers: { readonly onError: (error: unknown) => void; readonly onUpdate: (update: typeof AgentSessionUpdateDto.Type) => void },
  create: (url: string) => AgentSessionEventSource = (url) => new EventSource(url) as AgentSessionEventSource,
) {
  const query = config.afterSequence === undefined ? "" : `?afterSequence=${encodeURIComponent(String(config.afterSequence))}`;
  const baseUrl = normalizedServerUrl(config.serverUrl).replace(/\/$/u, "");
  const source = create(`${baseUrl}/runs/${encodeURIComponent(config.runId)}/agents/${encodeURIComponent(config.agentId)}/session/stream${query}`);
  source.onmessage = (event) => {
    try {
      const update = decodeAgentSessionUpdate(JSON.parse(event.data));
      if (event.lastEventId !== "" && String(update.eventSequence) !== event.lastEventId) throw new Error("Gaia SSE event ID does not match its normalized sequence.");
      handlers.onUpdate(update);
    } catch (error) {
      source.close();
      handlers.onError(error);
    }
  };
  source.onerror = handlers.onError;
  return { close: () => source.close() };
}

export function listFactoryArtifactsFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      const response = yield* client.runs.listRunArtifacts({
        params: { runId },
      });
      return yield* decodeFactoryArtifactListSuccess(response);
    }),
  );
}

export function getFactoryArtifactFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly artifactId: string;
    readonly runId: string;
  },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const runId = yield* decodeRunIdParameter(config.runId);
      const artifactId = yield* decodeArtifactIdParameter(config.artifactId);
      const response = yield* client.runs.getRunArtifact({
        params: {
          artifactId,
          runId,
        },
      });
      return yield* decodeFactoryArtifactSuccess(response);
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
    readonly description: string;
    readonly title: string;
  },
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const payload = yield* CreateRunRequest.makeEffect({
        execution: codexAppServerExecutionSelection,
        workflow: "issueDelivery",
        workItem: {
          description: config.description,
          kind: "issue",
          title: config.title,
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

function decodeAgentIdParameter(input: string) {
  return Schema.decodeUnknownEffect(FactoryAgentIdSchema)(input).pipe(
    Effect.mapError((cause) => parameterError("agentId", cause)),
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
  parameter: "action" | "agentId" | "artifactId" | "createRun" | "runId",
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
