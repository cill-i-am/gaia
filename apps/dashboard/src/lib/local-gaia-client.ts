import {
  AgentOperatorActionRequestSchema,
  AgentSessionSnapshotSuccessEnvelope,
  AgentSessionSseEventIdSchema,
  AgentSessionUpdateDto,
  CreateRunRequest,
  DeliverySnapshotSuccessEnvelope,
  DeliverySnapshotDto,
  DeliveryActionRequestSchema,
  codexAppServerExecutionSelection,
  FactoryActivitySuccessEnvelope,
  FactoryArtifactListSuccessEnvelope,
  FactoryArtifactSuccessEnvelope,
  FactoryGraphSuccessEnvelope,
  makeAgentSessionSseEventId,
  FactoryRunDetailDto,
  FactoryRunSummaryDto,
  LocalGaiaServerApi,
  LocalRunApiErrorEnvelope,
  LocalRunArtifactSuccessEnvelope,
  LocalRunDetailSuccessEnvelope,
  LocalRunListSuccessEnvelope,
  parseLocalGaiaServerUrl,
  type FactoryAgentId,
  type FactoryArtifactId,
  type LocalGaiaServerUrl,
  type RunId,
} from "@gaia/core";
import { Cause, Effect, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

const fetchTimeoutMs = 2_000;

export const defaultLocalGaiaServerUrl = parseLocalGaiaServerUrl("/gaia-api");

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
      readonly parameter:
        | "action"
        | "agentId"
        | "artifactId"
        | "createRun"
        | "deliveryAction";
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
  readonly serverUrl: LocalGaiaServerUrl;
};

export const DashboardGaiaFetchClientLive = FetchHttpClient.layer;

const decodeLocalRunListSuccess = Schema.decodeUnknownEffect(
  LocalRunListSuccessEnvelope
);
const decodeLocalRunDetailSuccess = Schema.decodeUnknownEffect(
  LocalRunDetailSuccessEnvelope
);
const decodeLocalRunArtifactSuccess = Schema.decodeUnknownEffect(
  LocalRunArtifactSuccessEnvelope
);
const decodeFactoryGraphSuccess = Schema.decodeUnknownEffect(
  FactoryGraphSuccessEnvelope
);
const decodeFactoryActivitySuccess = Schema.decodeUnknownEffect(
  FactoryActivitySuccessEnvelope
);
const decodeFactoryArtifactListSuccess = Schema.decodeUnknownEffect(
  FactoryArtifactListSuccessEnvelope
);
const decodeFactoryArtifactSuccess = Schema.decodeUnknownEffect(
  FactoryArtifactSuccessEnvelope
);
const decodeDeliverySnapshotSuccess = Schema.decodeUnknownEffect(
  DeliverySnapshotSuccessEnvelope
);
const decodeAgentSessionSnapshotSuccess = Schema.decodeUnknownEffect(
  AgentSessionSnapshotSuccessEnvelope
);
const decodeAgentSessionUpdate = Schema.decodeUnknownSync(
  AgentSessionUpdateDto
);
const decodeAgentSessionSseEventId = Schema.decodeUnknownSync(
  AgentSessionSseEventIdSchema
);
const decodeDeliverySnapshot = Schema.decodeUnknownSync(DeliverySnapshotDto);

export function healthFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig
) {
  return withDashboardGaiaClient(config, (client) =>
    client.health.health(undefined)
  );
}

export function listRunsFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig
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
    })
  );
}

export function getRunFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: RunId }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const response = yield* client.runs.getRun({
        params: { runId: config.runId },
      });
      return yield* decodeLocalRunDetailSuccess({
        data: legacyRunSummaryFromFactoryRun(response.data),
        status: "success",
      });
    })
  );
}

export function getRunEventsFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: RunId }
) {
  return withDashboardGaiaClient(config, (client) =>
    client.runs.getRunEvents({ params: { runId: config.runId } })
  );
}

export function getFactoryGraphFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: RunId }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const response = yield* client.runs.getFactoryGraph({
        params: { runId: config.runId },
      });
      return yield* decodeFactoryGraphSuccess(response);
    })
  );
}

export function getFactoryRunActivityFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: RunId }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const response = yield* client.runs.getRunActivity({
        params: { runId: config.runId },
      });
      return yield* decodeFactoryActivitySuccess(response);
    })
  );
}

export function getDeliverySnapshotFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: RunId }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const response = yield* client.runs.getDeliverySnapshot({
        params: { runId: config.runId },
      });
      return yield* decodeDeliverySnapshotSuccess(response);
    })
  );
}

export function actOnDeliveryFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly action: unknown;
    readonly runId: RunId;
  }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const params = { runId: config.runId };
      const payload = yield* Schema.decodeUnknownEffect(
        DeliveryActionRequestSchema
      )(config.action).pipe(
        Effect.mapError((cause) => parameterError("deliveryAction", cause))
      );
      switch (payload.kind) {
        case "activateRemediation":
          return yield* client.runs.actOnDelivery({ params, payload });
        case "markReadyForReview":
          return yield* client.runs.actOnDelivery({ params, payload });
        case "attestPairedReviewApproval":
          return yield* client.runs.actOnDelivery({ params, payload });
        case "merge":
          return yield* client.runs.actOnDelivery({ params, payload });
        case "evaluateMergeReadiness":
          return yield* client.runs.actOnDelivery({ params, payload });
        case "retryCleanup":
          return yield* client.runs.actOnDelivery({ params, payload });
        case "continueInterruptedWorkerRecovery":
          return yield* client.runs.actOnDelivery({ params, payload });
        case "reconcileInterruptedWorkerCorrelation":
          return yield* client.runs.actOnDelivery({ params, payload });
        case "reconcileDesktopOriginatedWorkerCorrelation":
          return yield* client.runs.actOnDelivery({ params, payload });
        case "reconcile":
        case "retry":
          return yield* client.runs.actOnDelivery({ params, payload });
      }
    })
  );
}

export function getFactoryAgentActivityFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly agentId: FactoryAgentId;
    readonly runId: RunId;
  }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const response = yield* client.runs.getAgentActivity({
        params: { agentId: config.agentId, runId: config.runId },
      });
      return yield* decodeFactoryActivitySuccess(response);
    })
  );
}

export function getAgentSessionFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly agentId: FactoryAgentId;
    readonly runId: RunId;
  }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      return yield* client.runs
        .getAgentSession({
          params: { agentId: config.agentId, runId: config.runId },
        })
        .pipe(Effect.flatMap(decodeAgentSessionSnapshotSuccess));
    })
  );
}

export function actOnAgentSessionFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly action: unknown;
    readonly agentId: FactoryAgentId;
    readonly runId: RunId;
  }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeUnknownEffect(
        AgentOperatorActionRequestSchema
      )(config.action).pipe(
        Effect.mapError((cause) => parameterError("action", cause))
      );
      const params = { agentId: config.agentId, runId: config.runId };
      switch (payload.kind) {
        case "followUp":
          return yield* client.runs.actOnAgentSession({ params, payload });
        case "steer":
          return yield* client.runs.actOnAgentSession({ params, payload });
        case "interrupt":
          return yield* client.runs.actOnAgentSession({ params, payload });
        case "approval":
          return yield* client.runs.actOnAgentSession({ params, payload });
        case "userInput":
          return yield* client.runs.actOnAgentSession({ params, payload });
        case "mcpElicitation":
          return yield* client.runs.actOnAgentSession({ params, payload });
      }
    })
  );
}

export type AgentSessionEventSource = {
  addEventListener(
    event: "agent-session-update",
    listener: (event: {
      readonly data: string;
      readonly lastEventId: string;
    }) => void
  ): void;
  close(): void;
  onerror: ((event: unknown) => void) | null;
  onmessage:
    | ((event: { readonly data: string; readonly lastEventId: string }) => void)
    | null;
  removeEventListener(
    event: "agent-session-update",
    listener: (event: {
      readonly data: string;
      readonly lastEventId: string;
    }) => void
  ): void;
};

export type DeliverySnapshotEventSource = {
  addEventListener(
    event: "delivery-update",
    listener: (event: {
      readonly data: string;
      readonly lastEventId: string;
    }) => void
  ): void;
  close(): void;
  onerror: ((event: unknown) => void) | null;
  onmessage:
    | ((event: { readonly data: string; readonly lastEventId: string }) => void)
    | null;
  removeEventListener(
    event: "delivery-update",
    listener: (event: {
      readonly data: string;
      readonly lastEventId: string;
    }) => void
  ): void;
};

/** Browser-owned delivery SSE lifecycle for one selected run. */
export function openDeliverySnapshotEventSource(
  config: DashboardGaiaClientConfig & {
    readonly afterSequence?: number;
    readonly runId: RunId;
  },
  handlers: {
    readonly onError: (error: unknown) => void;
    readonly onUpdate: (update: typeof DeliverySnapshotDto.Type) => void;
  },
  create: (url: string) => DeliverySnapshotEventSource = (url) =>
    new EventSource(url) as DeliverySnapshotEventSource
) {
  const query =
    config.afterSequence === undefined
      ? ""
      : `?afterSequence=${encodeURIComponent(String(config.afterSequence))}`;
  const baseUrl = normalizedServerUrl(config.serverUrl).replace(/\/$/u, "");
  const source = create(
    `${baseUrl}/runs/${encodeURIComponent(config.runId)}/delivery/stream${query}`
  );
  const onDeliveryUpdate = (event: {
    readonly data: string;
    readonly lastEventId: string;
  }) => {
    try {
      const update = decodeDeliverySnapshot(JSON.parse(event.data));
      if (
        event.lastEventId !== "" &&
        String(update.eventSequence) !== event.lastEventId
      )
        throw new Error(
          "Gaia SSE event ID does not match its normalized sequence."
        );
      handlers.onUpdate(update);
    } catch (error) {
      close();
      handlers.onError(error);
    }
  };
  const close = () => {
    source.removeEventListener("delivery-update", onDeliveryUpdate);
    source.close();
  };
  source.addEventListener("delivery-update", onDeliveryUpdate);
  source.onerror = handlers.onError;
  return { close };
}

/** Browser-owned SSE lifecycle. The caller closes on run/agent change or unmount. */
export function openAgentSessionEventSource(
  config: DashboardGaiaClientConfig & {
    readonly afterSequence?: number;
    readonly agentId: FactoryAgentId;
    readonly runId: RunId;
  },
  handlers: {
    readonly onError: (error: unknown) => void;
    readonly onUpdate: (update: typeof AgentSessionUpdateDto.Type) => void;
  },
  create: (url: string) => AgentSessionEventSource = (url) =>
    new EventSource(url) as AgentSessionEventSource
) {
  const query =
    config.afterSequence === undefined
      ? ""
      : `?afterSequence=${encodeURIComponent(String(config.afterSequence))}`;
  const baseUrl = normalizedServerUrl(config.serverUrl).replace(/\/$/u, "");
  const source = create(
    `${baseUrl}/runs/${encodeURIComponent(config.runId)}/agents/${encodeURIComponent(config.agentId)}/session/stream${query}`
  );
  const onSessionUpdate = (event: {
    readonly data: string;
    readonly lastEventId: string;
  }) => {
    try {
      const update = decodeAgentSessionUpdate(JSON.parse(event.data));
      if (
        event.lastEventId !== "" &&
        makeAgentSessionSseEventId(update.eventSequence) !==
          decodeAgentSessionSseEventId(event.lastEventId)
      )
        throw new Error(
          "Gaia SSE event ID does not match its normalized sequence."
        );
      handlers.onUpdate(update);
    } catch (error) {
      close();
      handlers.onError(error);
    }
  };
  const close = () => {
    source.removeEventListener("agent-session-update", onSessionUpdate);
    source.close();
  };
  source.addEventListener("agent-session-update", onSessionUpdate);
  source.onerror = handlers.onError;
  return { close };
}

export function listFactoryArtifactsFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & { readonly runId: RunId }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const response = yield* client.runs.listRunArtifacts({
        params: { runId: config.runId },
      });
      return yield* decodeFactoryArtifactListSuccess(response);
    })
  );
}

export function getFactoryArtifactFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly artifactId: FactoryArtifactId;
    readonly runId: RunId;
  }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const response = yield* client.runs.getRunArtifact({
        params: {
          artifactId: config.artifactId,
          runId: config.runId,
        },
      });
      return yield* decodeFactoryArtifactSuccess(response);
    })
  );
}

export function getRunArtifactFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly artifactId: FactoryArtifactId;
    readonly runId: RunId;
  }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      return yield* client.runs
        .getRunArtifact({
          params: {
            artifactId: config.artifactId,
            runId: config.runId,
          },
        })
        .pipe(
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
              Effect.mapError((cause) => parameterError("artifactId", cause))
            )
          )
        );
    })
  );
}

export function createRunFromDashboardGaiaClient(
  config: DashboardGaiaClientConfig & {
    readonly deliveryMode: "local" | "pullRequest";
    readonly description: string;
    readonly title: string;
  }
) {
  return withDashboardGaiaClient(config, (client) =>
    Effect.gen(function* () {
      const payload = yield* CreateRunRequest.makeEffect({
        delivery: { mode: config.deliveryMode },
        execution: codexAppServerExecutionSelection,
        workflow: "issueDelivery",
        workItem: {
          description: config.description,
          kind: "issue",
          title: config.title,
        },
      }).pipe(Effect.mapError((cause) => parameterError("createRun", cause)));

      return yield* client.runs.createRun({ payload });
    })
  );
}

function withDashboardGaiaClient<A, E, R>(
  config: DashboardGaiaClientConfig,
  useClient: (
    client: HttpApiClient.ForApi<typeof LocalGaiaServerApi>
  ) => Effect.Effect<A, E, R>
): Effect.Effect<A, DashboardGaiaClientError, R | HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpApiClient.make(LocalGaiaServerApi, {
      baseUrl: normalizedServerUrl(config.serverUrl),
    });
    return yield* useClient(client);
  }).pipe(
    Effect.timeout(`${fetchTimeoutMs} millis`),
    Effect.mapError(toDashboardGaiaClientError)
  );
}

function legacyRunSummaryFromFactoryRun(
  run: typeof FactoryRunSummaryDto.Type | typeof FactoryRunDetailDto.Type
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

function legacyStatusFromFactoryState(
  state: typeof FactoryRunSummaryDto.Type.state
) {
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
  state: typeof FactoryRunSummaryDto.Type.state
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
  state: typeof FactoryRunSummaryDto.Type.state
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
  parameter:
    | "action"
    | "agentId"
    | "artifactId"
    | "createRun"
    | "deliveryAction",
  cause: Schema.SchemaError
): DashboardGaiaClientError {
  return {
    _tag: "DashboardGaiaParameterError",
    cause,
    parameter,
  };
}

function toDashboardGaiaClientError(error: unknown): DashboardGaiaClientError {
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
  error: unknown
): error is DashboardGaiaClientError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string" &&
    error._tag.startsWith("DashboardGaia")
  );
}

function normalizedServerUrl(serverUrl: LocalGaiaServerUrl) {
  return serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`;
}
