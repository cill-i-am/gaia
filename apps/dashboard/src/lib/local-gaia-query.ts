import {
  FactoryAgentIdSchema,
  FactoryArtifactIdSchema,
  type RunId,
} from "@gaia/core";
import { skipToken } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { createEffectQuery } from "effect-query";

import {
  DashboardGaiaFetchClientLive,
  actOnAgentSessionFromDashboardGaiaClient,
  actOnDeliveryFromDashboardGaiaClient,
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
  healthFromDashboardGaiaClient,
  listFactoryArtifactsFromDashboardGaiaClient,
  listRunsFromDashboardGaiaClient,
  type DashboardGaiaClientConfig,
} from "@/lib/local-gaia-client";

export const localGaiaQueryKeys = {
  all: ["local-gaia"] as const,
  artifact: (input: { readonly artifactId: string; readonly runId: RunId }) =>
    [
      ...localGaiaQueryKeys.run(input.runId),
      "artifact",
      input.artifactId,
    ] as const,
  factoryAgentActivity: (input: {
    readonly agentId: string;
    readonly runId: RunId;
  }) =>
    [
      ...localGaiaQueryKeys.run(input.runId),
      "agents",
      input.agentId,
      "activity",
    ] as const,
  agentSession: (input: { readonly agentId: string; readonly runId: RunId }) =>
    [
      ...localGaiaQueryKeys.run(input.runId),
      "agents",
      input.agentId,
      "session",
    ] as const,
  agentSessionAction: (input: {
    readonly agentId: string;
    readonly runId: RunId;
  }) => [...localGaiaQueryKeys.agentSession(input), "action"] as const,
  factoryArtifact: (input: {
    readonly artifactId: string;
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
  runs: () => [...localGaiaQueryKeys.all, "runs"] as const,
  unselected: (resource: string) =>
    [...localGaiaQueryKeys.runs(), "unselected", resource] as const,
};

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
  config: DashboardGaiaClientConfig & { readonly runId: RunId | undefined }
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
  config: DashboardGaiaClientConfig & { readonly runId: RunId | undefined }
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

export function localGaiaRunArtifactQueryOptions(
  config: DashboardGaiaClientConfig & {
    readonly artifactId: string;
    readonly runId: RunId | undefined;
  }
) {
  const runId = config.runId;
  const enabled = runId !== undefined && config.artifactId.length > 0;
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("run-artifact")
        : localGaiaQueryKeys.artifact({ artifactId: config.artifactId, runId }),
    queryFn:
      !enabled || runId === undefined
        ? skipToken
        : () => getRunArtifactFromDashboardGaiaClient({ ...config, runId }),
    retry: false,
  });
}

export function localGaiaFactoryGraphQueryOptions(
  config: DashboardGaiaClientConfig & { readonly runId: RunId | undefined },
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
  config: DashboardGaiaClientConfig & { readonly runId: RunId | undefined }
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
  config: DashboardGaiaClientConfig & { readonly runId: RunId | undefined }
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
  config: DashboardGaiaClientConfig & {
    readonly agentId: string;
    readonly runId: RunId | undefined;
  }
) {
  const agentId = parseAgentId(config.agentId);
  const runId = config.runId;
  const enabled = runId !== undefined && Option.isSome(agentId);
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("factory-agent-activity")
        : localGaiaQueryKeys.factoryAgentActivity({
            agentId: Option.getOrElse(agentId, () => "invalid-agent-id"),
            runId,
          }),
    queryFn:
      !enabled || runId === undefined
        ? skipToken
        : () =>
            getFactoryAgentActivityFromDashboardGaiaClient({
              ...config,
              runId,
            }),
    retry: false,
  });
}

export function localGaiaAgentSessionQueryOptions(
  config: DashboardGaiaClientConfig & {
    readonly agentId: string;
    readonly runId: RunId | undefined;
  }
) {
  const agentId = parseAgentId(config.agentId);
  const runId = config.runId;
  const enabled = runId !== undefined && Option.isSome(agentId);
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("agent-session")
        : localGaiaQueryKeys.agentSession({
            agentId: Option.getOrElse(agentId, () => "invalid-agent-id"),
            runId,
          }),
    queryFn:
      !enabled || runId === undefined
        ? skipToken
        : () => getAgentSessionFromDashboardGaiaClient({ ...config, runId }),
    retry: false,
  });
}

export function localGaiaFactoryArtifactsQueryOptions(
  config: DashboardGaiaClientConfig & { readonly runId: RunId | undefined }
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
  config: DashboardGaiaClientConfig & {
    readonly artifactId: string;
    readonly runId: RunId | undefined;
  }
) {
  const artifactId = parseArtifactId(config.artifactId);
  const runId = config.runId;
  const enabled = runId !== undefined && Option.isSome(artifactId);
  return localGaiaEffectQuery.queryOptions({
    queryKey:
      runId === undefined
        ? localGaiaQueryKeys.unselected("factory-artifact")
        : localGaiaQueryKeys.factoryArtifact({
            artifactId: Option.getOrElse(
              artifactId,
              () => "invalid-artifact-id"
            ),
            runId,
          }),
    queryFn:
      !enabled || runId === undefined
        ? skipToken
        : () => getFactoryArtifactFromDashboardGaiaClient({ ...config, runId }),
    retry: false,
  });
}

export function localGaiaCreateRunMutationOptions(
  config: DashboardGaiaClientConfig,
  effectQuery: LocalGaiaEffectQuery = localGaiaEffectQuery
) {
  return effectQuery.mutationOptions({
    mutationKey: [...localGaiaQueryKeys.all, "create-run"] as const,
    mutationFn: (input: {
      readonly deliveryMode: "local" | "pullRequest";
      readonly description: string;
      readonly title: string;
    }) => createRunFromDashboardGaiaClient({ ...config, ...input }),
  });
}

export function localGaiaDeliveryActionMutationOptions(
  config: DashboardGaiaClientConfig,
  effectQuery: LocalGaiaEffectQuery = localGaiaEffectQuery
) {
  return effectQuery.mutationOptions({
    mutationKey: [...localGaiaQueryKeys.all, "delivery", "action"] as const,
    mutationFn: (input: { readonly action: unknown; readonly runId: RunId }) =>
      actOnDeliveryFromDashboardGaiaClient({ ...config, ...input }),
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
    mutationFn: (input: {
      readonly action: unknown;
      readonly agentId: string;
      readonly runId: RunId;
    }) => actOnAgentSessionFromDashboardGaiaClient({ ...config, ...input }),
  });
}

function parseAgentId(input: string) {
  return Schema.decodeUnknownOption(FactoryAgentIdSchema)(input);
}

function parseArtifactId(input: string) {
  return Schema.decodeUnknownOption(FactoryArtifactIdSchema)(input);
}
