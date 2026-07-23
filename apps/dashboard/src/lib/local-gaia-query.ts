import {
  AgentOperatorActionRequestSchema,
  DeliveryActionRequestSchema,
  DeliveryModeSchema,
  FactoryAgentIdSchema,
  FactoryArtifactIdSchema,
  RunIdSchema,
  RunControlActionSchema,
  type FactoryAgentId,
  type FactoryArtifactId,
  type RunId,
} from "@gaia/core";
import { skipToken } from "@tanstack/react-query";
import { Effect, Option, Schema } from "effect";
import { createEffectQuery } from "effect-query";

import {
  DashboardGaiaFetchClientLive,
  actOnAgentSessionFromDashboardGaiaClient,
  actOnDeliveryFromDashboardGaiaClient,
  actOnRunControlFromDashboardGaiaClient,
  createRunFromDashboardGaiaClient,
  getAgentSessionFromDashboardGaiaClient,
  getDeliverySnapshotFromDashboardGaiaClient,
  getFactoryAgentActivityFromDashboardGaiaClient,
  getFactoryArtifactFromDashboardGaiaClient,
  getFactoryGraphFromDashboardGaiaClient,
  getFactoryRunActivityFromDashboardGaiaClient,
  getRunArtifactFromDashboardGaiaClient,
  getRunEventsFromDashboardGaiaClient,
  getRunFromDashboardGaiaClient,
  getRunControlFromDashboardGaiaClient,
  healthFromDashboardGaiaClient,
  listFactoryArtifactsFromDashboardGaiaClient,
  listRunsFromDashboardGaiaClient,
  DashboardGaiaClientConfigSchema,
  type DashboardGaiaClientConfig,
  type DashboardGaiaClientError,
} from "@/lib/local-gaia-client";

export const localGaiaQueryKeys = {
  all: ["local-gaia"] as const,
  artifact: (input: {
    readonly artifactId: FactoryArtifactId;
    readonly runId: RunId;
  }) =>
    [
      ...localGaiaQueryKeys.run(input.runId),
      "artifact",
      input.artifactId,
    ] as const,
  factoryAgentActivity: (input: {
    readonly agentId: FactoryAgentId;
    readonly runId: RunId;
  }) =>
    [
      ...localGaiaQueryKeys.run(input.runId),
      "agents",
      input.agentId,
      "activity",
    ] as const,
  agentSession: (input: {
    readonly agentId: FactoryAgentId;
    readonly runId: RunId;
  }) =>
    [
      ...localGaiaQueryKeys.run(input.runId),
      "agents",
      input.agentId,
      "session",
    ] as const,
  agentSessionAction: (input: {
    readonly agentId: FactoryAgentId;
    readonly runId: RunId;
  }) => [...localGaiaQueryKeys.agentSession(input), "action"] as const,
  factoryArtifact: (input: {
    readonly artifactId: FactoryArtifactId;
    readonly runId: RunId;
  }) =>
    [
      ...localGaiaQueryKeys.factoryArtifacts(input.runId),
      input.artifactId,
    ] as const,
  factoryArtifacts: (runId: RunId) =>
    [...localGaiaQueryKeys.run(runId), "artifacts"] as const,
  factoryGraph: (runId: RunId) =>
    [...localGaiaQueryKeys.run(runId), "factory-graph"] as const,
  factoryRunActivity: (runId: RunId) =>
    [...localGaiaQueryKeys.run(runId), "activity"] as const,
  delivery: (runId: RunId) =>
    [...localGaiaQueryKeys.run(runId), "delivery"] as const,
  deliveryAction: (runId: RunId) =>
    [...localGaiaQueryKeys.delivery(runId), "action"] as const,
  health: () => [...localGaiaQueryKeys.all, "health"] as const,
  run: (runId: RunId) =>
    [...localGaiaQueryKeys.runs(), "detail", runId] as const,
  runEvents: (runId: RunId) =>
    [...localGaiaQueryKeys.run(runId), "events"] as const,
  runControl: (runId: RunId) =>
    [...localGaiaQueryKeys.run(runId), "control"] as const,
  runControlAction: (runId: RunId) =>
    [...localGaiaQueryKeys.runControl(runId), "action"] as const,
  runs: () => [...localGaiaQueryKeys.all, "runs"] as const,
  unselected: (resource: string) =>
    [...localGaiaQueryKeys.runs(), "unselected", resource] as const,
};

export const DashboardCreateRunInputSchema = Schema.Struct({
  deliveryMode: DeliveryModeSchema,
  description: Schema.String,
  title: Schema.String,
});

export type DashboardCreateRunInput = typeof DashboardCreateRunInputSchema.Type;

export const DashboardDeliveryActionMutationInputSchema = Schema.Struct({
  action: DeliveryActionRequestSchema,
  runId: RunIdSchema,
});

class DashboardDeliveryActionMutationInputType extends Schema.Class<DashboardDeliveryActionMutationInputType>(
  "DashboardDeliveryActionMutationInputType"
)(DashboardDeliveryActionMutationInputSchema.fields) {}

export type DashboardDeliveryActionMutationInput =
  DashboardDeliveryActionMutationInputType;

export const DashboardAgentSessionActionMutationInputSchema = Schema.Struct({
  action: AgentOperatorActionRequestSchema,
  agentId: FactoryAgentIdSchema,
  runId: RunIdSchema,
});

export type DashboardAgentSessionActionMutationInput =
  typeof DashboardAgentSessionActionMutationInputSchema.Type;

export const DashboardRunControlActionMutationInputSchema = Schema.Struct({
  action: RunControlActionSchema,
  runId: RunIdSchema,
});

class DashboardRunControlActionMutationInputType extends Schema.Class<DashboardRunControlActionMutationInputType>(
  "DashboardRunControlActionMutationInputType"
)(DashboardRunControlActionMutationInputSchema.fields) {}

export type DashboardRunControlActionMutationInput =
  DashboardRunControlActionMutationInputType;

export const DashboardRunControlActionMutationRequestIdSchema =
  Schema.String.pipe(
    Schema.brand("DashboardRunControlActionMutationRequestId")
  );

const DashboardRunControlActionMutationRequestSchema = Schema.Struct({
  requestId: DashboardRunControlActionMutationRequestIdSchema,
});

export type DashboardRunControlActionMutationRequest =
  typeof DashboardRunControlActionMutationRequestSchema.Type;

export type DashboardRunControlActionMutationInputConsumer = (
  request: DashboardRunControlActionMutationRequest
) => DashboardRunControlActionMutationInput;

const DashboardOptionalRunQueryConfigSchema = Schema.Struct({
  ...DashboardGaiaClientConfigSchema.fields,
  runId: Schema.UndefinedOr(RunIdSchema),
});

const DashboardOptionalArtifactQueryConfigSchema = Schema.Struct({
  ...DashboardOptionalRunQueryConfigSchema.fields,
  artifactId: Schema.toEncoded(FactoryArtifactIdSchema),
});

const DashboardOptionalAgentQueryConfigSchema = Schema.Struct({
  ...DashboardOptionalRunQueryConfigSchema.fields,
  agentId: Schema.toEncoded(FactoryAgentIdSchema),
});

type DashboardGaiaParameter = Extract<
  DashboardGaiaClientError,
  { readonly _tag: "DashboardGaiaParameterError" }
>["parameter"];

const decodeDashboardCreateRunInput = Schema.decodeUnknownEffect(
  DashboardCreateRunInputSchema
);
const decodeDashboardDeliveryActionMutationInput = Schema.decodeUnknownEffect(
  DashboardDeliveryActionMutationInputSchema
);
const decodeDashboardAgentSessionActionMutationInput =
  Schema.decodeUnknownEffect(DashboardAgentSessionActionMutationInputSchema);
const decodeDashboardRunControlActionMutationInput = Schema.decodeUnknownEffect(
  DashboardRunControlActionMutationInputSchema
);
const decodeDashboardRunControlActionMutationRequest =
  Schema.decodeUnknownEffect(DashboardRunControlActionMutationRequestSchema);

function dashboardMutationInputError(
  parameter: DashboardGaiaParameter,
  cause: Schema.SchemaError
): DashboardGaiaClientError {
  return {
    _tag: "DashboardGaiaParameterError",
    cause,
    parameter,
  };
}

const localGaiaEffectQuery = createEffectQuery(DashboardGaiaFetchClientLive);
type LocalGaiaEffectQuery = typeof localGaiaEffectQuery;

export function localGaiaHealthQueryOptions(config: DashboardGaiaClientConfig) {
  return localGaiaEffectQuery.queryOptions({
    queryKey: localGaiaQueryKeys.health(),
    queryFn: () => healthFromDashboardGaiaClient(config),
    retry: false,
  });
}

export function localGaiaRunsQueryOptions(config: DashboardGaiaClientConfig) {
  return localGaiaEffectQuery.queryOptions({
    queryKey: localGaiaQueryKeys.runs(),
    queryFn: () => listRunsFromDashboardGaiaClient(config),
    retry: false,
  });
}

export function localGaiaRunQueryOptions(
  config: typeof DashboardOptionalRunQueryConfigSchema.Type
) {
  const runId = config.runId;
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("run")
        : localGaiaQueryKeys.run(runId),
    queryFn:
      runId === undefined
        ? skipToken
        : () => getRunFromDashboardGaiaClient({ ...config, runId }),
    retry: false,
  });
}

export function localGaiaRunEventsQueryOptions(
  config: typeof DashboardOptionalRunQueryConfigSchema.Type
) {
  const runId = config.runId;
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("run-events")
        : localGaiaQueryKeys.runEvents(runId),
    queryFn:
      runId === undefined
        ? skipToken
        : () => getRunEventsFromDashboardGaiaClient({ ...config, runId }),
    retry: false,
  });
}

export function localGaiaRunControlQueryOptions(
  config: typeof DashboardOptionalRunQueryConfigSchema.Type
) {
  const runId = config.runId;
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("run-control")
        : localGaiaQueryKeys.runControl(runId),
    queryFn:
      runId === undefined
        ? skipToken
        : () => getRunControlFromDashboardGaiaClient({ ...config, runId }),
    retry: false,
  });
}

export function localGaiaRunArtifactQueryOptions(
  config: typeof DashboardOptionalArtifactQueryConfigSchema.Type
) {
  const runId = config.runId;
  const parsedArtifactId = Option.getOrUndefined(
    parseArtifactId(config.artifactId)
  );
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined || parsedArtifactId === undefined
        ? localGaiaQueryKeys.unselected("run-artifact")
        : localGaiaQueryKeys.artifact({
            artifactId: parsedArtifactId,
            runId,
          }),
    queryFn:
      runId === undefined || parsedArtifactId === undefined
        ? skipToken
        : () =>
            getRunArtifactFromDashboardGaiaClient({
              ...config,
              artifactId: parsedArtifactId,
              runId,
            }),
    retry: false,
  });
}

export function localGaiaFactoryGraphQueryOptions(
  config: typeof DashboardOptionalRunQueryConfigSchema.Type,
  effectQuery: LocalGaiaEffectQuery = localGaiaEffectQuery
) {
  const runId = config.runId;
  return effectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("factory-graph")
        : localGaiaQueryKeys.factoryGraph(runId),
    queryFn:
      runId === undefined
        ? skipToken
        : () => getFactoryGraphFromDashboardGaiaClient({ ...config, runId }),
    retry: false,
  });
}

export function localGaiaFactoryRunActivityQueryOptions(
  config: typeof DashboardOptionalRunQueryConfigSchema.Type
) {
  const runId = config.runId;
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("factory-run-activity")
        : localGaiaQueryKeys.factoryRunActivity(runId),
    queryFn:
      runId === undefined
        ? skipToken
        : () =>
            getFactoryRunActivityFromDashboardGaiaClient({ ...config, runId }),
    retry: false,
  });
}

export function localGaiaDeliveryQueryOptions(
  config: typeof DashboardOptionalRunQueryConfigSchema.Type
) {
  const runId = config.runId;
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("delivery")
        : localGaiaQueryKeys.delivery(runId),
    queryFn:
      runId === undefined
        ? skipToken
        : () =>
            getDeliverySnapshotFromDashboardGaiaClient({ ...config, runId }),
    retry: false,
  });
}

export function localGaiaFactoryAgentActivityQueryOptions(
  config: typeof DashboardOptionalAgentQueryConfigSchema.Type
) {
  const parsedAgentId = Option.getOrUndefined(parseAgentId(config.agentId));
  const runId = config.runId;
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined || parsedAgentId === undefined
        ? localGaiaQueryKeys.unselected("factory-agent-activity")
        : localGaiaQueryKeys.factoryAgentActivity({
            agentId: parsedAgentId,
            runId,
          }),
    queryFn:
      runId === undefined || parsedAgentId === undefined
        ? skipToken
        : () =>
            getFactoryAgentActivityFromDashboardGaiaClient({
              ...config,
              agentId: parsedAgentId,
              runId,
            }),
    retry: false,
  });
}

export function localGaiaAgentSessionQueryOptions(
  config: typeof DashboardOptionalAgentQueryConfigSchema.Type
) {
  const parsedAgentId = Option.getOrUndefined(parseAgentId(config.agentId));
  const runId = config.runId;
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined || parsedAgentId === undefined
        ? localGaiaQueryKeys.unselected("agent-session")
        : localGaiaQueryKeys.agentSession({
            agentId: parsedAgentId,
            runId,
          }),
    queryFn:
      runId === undefined || parsedAgentId === undefined
        ? skipToken
        : () =>
            getAgentSessionFromDashboardGaiaClient({
              ...config,
              agentId: parsedAgentId,
              runId,
            }),
    retry: false,
  });
}

export function localGaiaFactoryArtifactsQueryOptions(
  config: typeof DashboardOptionalRunQueryConfigSchema.Type
) {
  const runId = config.runId;
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("factory-artifacts")
        : localGaiaQueryKeys.factoryArtifacts(runId),
    queryFn:
      runId === undefined
        ? skipToken
        : () =>
            listFactoryArtifactsFromDashboardGaiaClient({ ...config, runId }),
    retry: false,
  });
}

export function localGaiaFactoryArtifactQueryOptions(
  config: typeof DashboardOptionalArtifactQueryConfigSchema.Type
) {
  const parsedArtifactId = Option.getOrUndefined(
    parseArtifactId(config.artifactId)
  );
  const runId = config.runId;
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined || parsedArtifactId === undefined
        ? localGaiaQueryKeys.unselected("factory-artifact")
        : localGaiaQueryKeys.factoryArtifact({
            artifactId: parsedArtifactId,
            runId,
          }),
    queryFn:
      runId === undefined || parsedArtifactId === undefined
        ? skipToken
        : () =>
            getFactoryArtifactFromDashboardGaiaClient({
              ...config,
              artifactId: parsedArtifactId,
              runId,
            }),
    retry: false,
  });
}

export function localGaiaCreateRunMutationOptions(
  config: DashboardGaiaClientConfig,
  effectQuery: LocalGaiaEffectQuery = localGaiaEffectQuery
) {
  return effectQuery.mutationOptions({
    mutationKey: [...localGaiaQueryKeys.all, "create-run"] as const,
    mutationFn: (input: unknown) =>
      Effect.gen(function* () {
        const parsedInput = yield* decodeDashboardCreateRunInput(input).pipe(
          Effect.mapError((cause) =>
            dashboardMutationInputError("createRun", cause)
          )
        );
        return yield* createRunFromDashboardGaiaClient({
          ...config,
          ...parsedInput,
        });
      }),
  });
}

export function localGaiaDeliveryActionMutationOptions(
  config: DashboardGaiaClientConfig,
  effectQuery: LocalGaiaEffectQuery = localGaiaEffectQuery
) {
  return effectQuery.mutationOptions({
    mutationKey: [...localGaiaQueryKeys.all, "delivery", "action"] as const,
    mutationFn: (input: unknown) =>
      Effect.gen(function* () {
        const parsedInput = yield* decodeDashboardDeliveryActionMutationInput(
          input
        ).pipe(
          Effect.mapError((cause) =>
            dashboardMutationInputError("deliveryAction", cause)
          )
        );
        return yield* actOnDeliveryFromDashboardGaiaClient({
          ...config,
          ...parsedInput,
        });
      }),
  });
}

export function localGaiaAgentSessionActionMutationOptions(
  config: DashboardGaiaClientConfig,
  effectQuery: LocalGaiaEffectQuery = localGaiaEffectQuery
) {
  return effectQuery.mutationOptions({
    mutationKey: [
      ...localGaiaQueryKeys.all,
      "agent-session",
      "action",
    ] as const,
    mutationFn: (input: unknown) =>
      Effect.gen(function* () {
        const parsedInput =
          yield* decodeDashboardAgentSessionActionMutationInput(input).pipe(
            Effect.mapError((cause) =>
              dashboardMutationInputError("action", cause)
            )
          );
        return yield* actOnAgentSessionFromDashboardGaiaClient({
          ...config,
          ...parsedInput,
        });
      }),
  });
}

export function localGaiaRunControlActionMutationOptions(
  config: DashboardGaiaClientConfig,
  consumeInput: DashboardRunControlActionMutationInputConsumer,
  effectQuery: LocalGaiaEffectQuery = localGaiaEffectQuery
) {
  return effectQuery.mutationOptions({
    mutationKey: [...localGaiaQueryKeys.all, "run-control", "action"] as const,
    mutationFn: (input: unknown) =>
      Effect.gen(function* () {
        const request = yield* decodeDashboardRunControlActionMutationRequest(
          input
        ).pipe(
          Effect.mapError((cause) =>
            dashboardMutationInputError("runControlAction", cause)
          )
        );
        const consumedInput = yield* Effect.try({
          catch: (cause): DashboardGaiaClientError => ({
            _tag: "DashboardGaiaUnexpectedError",
            cause,
          }),
          try: () => consumeInput(request),
        });
        const parsedInput = yield* decodeDashboardRunControlActionMutationInput(
          consumedInput
        ).pipe(
          Effect.mapError((cause) =>
            dashboardMutationInputError("runControlAction", cause)
          )
        );
        return yield* actOnRunControlFromDashboardGaiaClient({
          ...config,
          ...parsedInput,
        }).pipe(
          Effect.mapError(
            (error): DashboardGaiaClientError =>
              error._tag === "DashboardGaiaHttpClientError"
                ? {
                    _tag: "DashboardGaiaUnexpectedError",
                    cause: "Run-control transport failed.",
                  }
                : error
          )
        );
      }),
  });
}

function parseAgentId(input: string) {
  return Schema.decodeUnknownOption(FactoryAgentIdSchema)(input);
}

function parseArtifactId(input: string) {
  return Schema.decodeUnknownOption(FactoryArtifactIdSchema)(input);
}
