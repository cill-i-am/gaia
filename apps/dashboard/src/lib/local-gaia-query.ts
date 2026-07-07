import { createEffectQuery } from "effect-query";

import {
  DashboardGaiaFetchClientLive,
  createRunFromDashboardGaiaClient,
  getRunArtifactFromDashboardGaiaClient,
  getRunEventsFromDashboardGaiaClient,
  getRunFromDashboardGaiaClient,
  healthFromDashboardGaiaClient,
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
  health: () => [...localGaiaQueryKeys.all, "health"] as const,
  run: (runId: string) =>
    [...localGaiaQueryKeys.runs(), "detail", runId] as const,
  runEvents: (runId: string) =>
    [...localGaiaQueryKeys.run(runId), "events"] as const,
  runs: () => [...localGaiaQueryKeys.all, "runs"] as const,
};

const localGaiaEffectQuery = createEffectQuery(DashboardGaiaFetchClientLive);

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

export function localGaiaCreateRunMutationOptions(
  config: DashboardGaiaClientConfig,
) {
  return localGaiaEffectQuery.mutationOptions({
    mutationKey: [...localGaiaQueryKeys.all, "create-run"] as const,
    mutationFn: (input: {
      readonly specMarkdown: string;
      readonly title?: string;
    }) =>
      createRunFromDashboardGaiaClient({ ...config, ...input }),
  });
}
