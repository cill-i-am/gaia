import { createEffectQuery } from "effect-query";
import {
  FactoryAgentIdSchema,
  FactoryArtifactIdSchema,
  RunIdSchema,
} from "@gaia/core";
import { Option, Schema } from "effect";

import {
  DashboardGaiaFetchClientLive,
  createRunFromDashboardGaiaClient,
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
  artifact: (input: { readonly artifactId: string; readonly runId: string }) =>
    [
      ...localGaiaQueryKeys.run(input.runId),
      "artifact",
      input.artifactId,
    ] as const,
  factoryAgentActivity: (input: {
    readonly agentId: string;
    readonly runId: string;
  }) =>
    [
      ...localGaiaQueryKeys.run(input.runId),
      "agents",
      input.agentId,
      "activity",
    ] as const,
  factoryArtifact: (input: {
    readonly artifactId: string;
    readonly runId: string;
  }) =>
    [
      ...localGaiaQueryKeys.factoryArtifacts(input.runId),
      input.artifactId,
    ] as const,
  factoryArtifacts: (runId: string) =>
    [...localGaiaQueryKeys.run(runId), "artifacts"] as const,
  factoryGraph: (runId: string) =>
    [...localGaiaQueryKeys.run(runId), "factory-graph"] as const,
  factoryRunActivity: (runId: string) =>
    [...localGaiaQueryKeys.run(runId), "activity"] as const,
  health: () => [...localGaiaQueryKeys.all, "health"] as const,
  run: (runId: string) =>
    [...localGaiaQueryKeys.runs(), "detail", runId] as const,
  runEvents: (runId: string) =>
    [...localGaiaQueryKeys.run(runId), "events"] as const,
  runs: () => [...localGaiaQueryKeys.all, "runs"] as const,
};

const localGaiaEffectQuery = createEffectQuery(DashboardGaiaFetchClientLive);
type LocalGaiaEffectQuery = typeof localGaiaEffectQuery;

export function localGaiaHealthQueryOptions(
  config: DashboardGaiaClientConfig,
) {
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
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  return localGaiaEffectQuery.queryOptions({
    enabled: config.runId.length > 0,
    queryKey: localGaiaQueryKeys.run(config.runId),
    queryFn: () => getRunFromDashboardGaiaClient(config),
    retry: false,
  });
}

export function localGaiaRunEventsQueryOptions(
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  return localGaiaEffectQuery.queryOptions({
    enabled: config.runId.length > 0,
    queryKey: localGaiaQueryKeys.runEvents(config.runId),
    queryFn: () => getRunEventsFromDashboardGaiaClient(config),
    retry: false,
  });
}

export function localGaiaRunArtifactQueryOptions(
  config: DashboardGaiaClientConfig & {
    readonly artifactId: string;
    readonly runId: string;
  },
) {
  return localGaiaEffectQuery.queryOptions({
    enabled: config.runId.length > 0 && config.artifactId.length > 0,
    queryKey: localGaiaQueryKeys.artifact(config),
    queryFn: () => getRunArtifactFromDashboardGaiaClient(config),
    retry: false,
  });
}

export function localGaiaFactoryGraphQueryOptions(
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  const runId = parseRunId(config.runId);
  return localGaiaEffectQuery.queryOptions({
    enabled: Option.isSome(runId),
    queryKey: localGaiaQueryKeys.factoryGraph(
      Option.getOrElse(runId, () => "invalid-run-id"),
    ),
    queryFn: () => getFactoryGraphFromDashboardGaiaClient(config),
    retry: false,
  });
}

export function localGaiaFactoryRunActivityQueryOptions(
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  const runId = parseRunId(config.runId);
  return localGaiaEffectQuery.queryOptions({
    enabled: Option.isSome(runId),
    queryKey: localGaiaQueryKeys.factoryRunActivity(
      Option.getOrElse(runId, () => "invalid-run-id"),
    ),
    queryFn: () => getFactoryRunActivityFromDashboardGaiaClient(config),
    retry: false,
  });
}

export function localGaiaFactoryAgentActivityQueryOptions(
  config: DashboardGaiaClientConfig & {
    readonly agentId: string;
    readonly runId: string;
  },
) {
  const agentId = parseAgentId(config.agentId);
  const runId = parseRunId(config.runId);
  return localGaiaEffectQuery.queryOptions({
    enabled: Option.isSome(runId) && Option.isSome(agentId),
    queryKey: localGaiaQueryKeys.factoryAgentActivity({
      agentId: Option.getOrElse(agentId, () => "invalid-agent-id"),
      runId: Option.getOrElse(runId, () => "invalid-run-id"),
    }),
    queryFn: () => getFactoryAgentActivityFromDashboardGaiaClient(config),
    retry: false,
  });
}

export function localGaiaFactoryArtifactsQueryOptions(
  config: DashboardGaiaClientConfig & { readonly runId: string },
) {
  const runId = parseRunId(config.runId);
  return localGaiaEffectQuery.queryOptions({
    enabled: Option.isSome(runId),
    queryKey: localGaiaQueryKeys.factoryArtifacts(
      Option.getOrElse(runId, () => "invalid-run-id"),
    ),
    queryFn: () => listFactoryArtifactsFromDashboardGaiaClient(config),
    retry: false,
  });
}

export function localGaiaFactoryArtifactQueryOptions(
  config: DashboardGaiaClientConfig & {
    readonly artifactId: string;
    readonly runId: string;
  },
) {
  const artifactId = parseArtifactId(config.artifactId);
  const runId = parseRunId(config.runId);
  return localGaiaEffectQuery.queryOptions({
    enabled: Option.isSome(runId) && Option.isSome(artifactId),
    queryKey: localGaiaQueryKeys.factoryArtifact({
      artifactId: Option.getOrElse(artifactId, () => "invalid-artifact-id"),
      runId: Option.getOrElse(runId, () => "invalid-run-id"),
    }),
    queryFn: () => getFactoryArtifactFromDashboardGaiaClient(config),
    retry: false,
  });
}

export function localGaiaCreateRunMutationOptions(
  config: DashboardGaiaClientConfig,
  effectQuery: LocalGaiaEffectQuery = localGaiaEffectQuery,
) {
  return effectQuery.mutationOptions({
    mutationKey: [...localGaiaQueryKeys.all, "create-run"] as const,
    mutationFn: (input: {
      readonly specMarkdown: string;
      readonly title?: string;
    }) =>
      createRunFromDashboardGaiaClient({ ...config, ...input }),
  });
}

function parseAgentId(input: string) {
  return Schema.decodeUnknownOption(FactoryAgentIdSchema)(input);
}

function parseArtifactId(input: string) {
  return Schema.decodeUnknownOption(FactoryArtifactIdSchema)(input);
}

function parseRunId(input: string) {
  return Schema.decodeUnknownOption(RunIdSchema)(input);
}
