import {
  FactoryActivityDto,
  FactoryAgentDto,
  FactoryArtifactDto,
  FactoryGraphDto,
  FactoryWorkItemDto,
  RunId,
  RunIdSchema,
} from "@gaia/core";
import { Schema } from "effect";

import {
  FactoryCanvasNodeSchema,
  type FactoryCanvasNode,
} from "@/factory-canvas-model";

export const InspectorResourceStatusSchema = Schema.Literals([
  "loading",
  "ready",
  "unavailable",
  "error",
] as const);

export type InspectorResource<T> =
  | { readonly status: "loading"; readonly message: string }
  | { readonly status: "ready"; readonly data: ReadonlyArray<T> }
  | {
      readonly status: "unavailable" | "error";
      readonly message: string;
    };

export const InspectorNoticeStatusSchema = Schema.Literals([
  "loading",
  "unavailable",
  "error",
] as const);

export const InspectorNoticeSchema = Schema.Struct({
  message: Schema.String,
  status: InspectorNoticeStatusSchema,
  title: Schema.String,
});

export type InspectorNotice = typeof InspectorNoticeSchema.Type;

const makeInspectorResourceSchema = <A>(dataSchema: Schema.Schema<A>) =>
  Schema.Union([
    Schema.Struct({
      message: Schema.String,
      status: Schema.Literal("loading"),
    }),
    Schema.Struct({
      data: Schema.Array(dataSchema),
      status: Schema.Literal("ready"),
    }),
    Schema.Struct({
      message: Schema.String,
      status: Schema.Literals(["unavailable", "error"] as const),
    }),
  ]);

export const FactoryActivityInspectorResourceSchema =
  makeInspectorResourceSchema(FactoryActivityDto);
export const FactoryArtifactInspectorResourceSchema =
  makeInspectorResourceSchema(FactoryArtifactDto);

export type FactoryActivityInspectorResource =
  typeof FactoryActivityInspectorResourceSchema.Type;
export type FactoryArtifactInspectorResource =
  typeof FactoryArtifactInspectorResourceSchema.Type;

export const SelectedNodeEmptyInspectorModelSchema = Schema.Struct({
  kind: Schema.Literal("empty"),
  message: Schema.String,
  reason: Schema.Literals(["loading", "no-run", "no-selection"] as const),
  title: Schema.String,
});

export const SelectedNodeAgentInspectorModelSchema = Schema.Struct({
  activity: Schema.Array(FactoryActivityDto),
  activityStatus: InspectorResourceStatusSchema,
  agent: FactoryAgentDto,
  artifactStatus: InspectorResourceStatusSchema,
  artifacts: Schema.Array(FactoryArtifactDto),
  kind: Schema.Literal("agent"),
  node: FactoryCanvasNodeSchema,
  notices: Schema.Array(InspectorNoticeSchema),
  queryAvailable: Schema.Literal(false),
});

export const SelectedNodeWorkItemInspectorModelSchema = Schema.Struct({
  activity: Schema.Array(FactoryActivityDto),
  activityStatus: InspectorResourceStatusSchema,
  agents: Schema.Array(FactoryAgentDto),
  artifactStatus: InspectorResourceStatusSchema,
  artifacts: Schema.Array(FactoryArtifactDto),
  kind: Schema.Literal("workItem"),
  node: FactoryCanvasNodeSchema,
  notices: Schema.Array(InspectorNoticeSchema),
  queryAvailable: Schema.Literal(false),
  workItem: FactoryWorkItemDto,
});

export const SelectedNodeInspectorModelSchema = Schema.Union([
  SelectedNodeEmptyInspectorModelSchema,
  SelectedNodeAgentInspectorModelSchema,
  SelectedNodeWorkItemInspectorModelSchema,
]);

export type SelectedNodeInspectorModel =
  typeof SelectedNodeInspectorModelSchema.Type;

export function buildSelectedNodeInspectorModel(input: {
  readonly activity: InspectorResource<typeof FactoryActivityDto.Type>;
  readonly artifactCatalog: InspectorResource<typeof FactoryArtifactDto.Type>;
  readonly graph: typeof FactoryGraphDto.Type | undefined;
  readonly graphIsLoading: boolean;
  readonly selectedNode: FactoryCanvasNode | undefined;
  readonly selectedRunId: typeof RunIdSchema.Type | undefined;
}): SelectedNodeInspectorModel {
  if (input.selectedRunId === undefined) {
    return {
      kind: "empty",
      message:
        "Select a local run to inspect FactoryGraph work items, agents, activity, and artifacts.",
      reason: "no-run",
      title: "No run selected",
    };
  }

  if (input.graphIsLoading) {
    return {
      kind: "empty",
      message: "FactoryGraph topology is loading from LocalGaiaServerApi.",
      reason: "loading",
      title: "Loading selected run",
    };
  }

  if (input.selectedNode === undefined) {
    return {
      kind: "empty",
      message:
        "Select a work item or agent node on the canvas to inspect its public evidence.",
      reason: "no-selection",
      title: "No node selected",
    };
  }

  if (input.graph === undefined) {
    return {
      kind: "empty",
      message:
        "FactoryGraph topology is unavailable for the selected run, so node evidence cannot be scoped.",
      reason: "no-selection",
      title: "FactoryGraph unavailable",
    };
  }

  const activity = activityData(input.activity);
  const artifactCatalog = artifactData(input.artifactCatalog);
  const notices = resourceNotices({
    activity: input.activity,
    artifactCatalog: input.artifactCatalog,
  });

  if (input.selectedNode.kind === "agent") {
    const agent = input.graph.agents.find(
      (candidate) => candidate.id === input.selectedNode?.rawId
    );

    if (agent === undefined) {
      return unavailableSelection(
        "Agent unavailable",
        "The selected agent is no longer present in the public FactoryGraph."
      );
    }

    return {
      activity: scopedAgentActivity(activity, agent.id),
      activityStatus: input.activity.status,
      agent,
      artifactStatus: input.artifactCatalog.status,
      artifacts: agentOwnedArtifacts(artifactCatalog, agent.id),
      kind: "agent",
      node: input.selectedNode,
      notices,
      queryAvailable: false,
    };
  }

  const workItem = input.graph.workItems.find(
    (candidate) => candidate.id === input.selectedNode?.rawId
  );

  if (workItem === undefined) {
    return unavailableSelection(
      "Work item unavailable",
      "The selected work item is no longer present in the public FactoryGraph."
    );
  }

  const agents = input.graph.agents.filter(
    (agent) => agent.workItemId === workItem.id
  );
  const workItemActivity = activity.filter(
    (entry) => entry.workItemId === workItem.id
  );

  return {
    activity: workItemActivity,
    activityStatus: input.activity.status,
    agents,
    artifactStatus: input.artifactCatalog.status,
    artifacts: workItemArtifacts({
      activities: workItemActivity,
      agents,
      artifacts: artifactCatalog,
    }),
    kind: "workItem",
    node: input.selectedNode,
    notices,
    queryAvailable: false,
    workItem,
  };
}

function unavailableSelection(
  title: string,
  message: string
): SelectedNodeInspectorModel {
  return {
    kind: "empty",
    message,
    reason: "no-selection",
    title,
  };
}

function activityData(
  resource: InspectorResource<typeof FactoryActivityDto.Type>
) {
  return resource.status === "ready" ? resource.data : [];
}

function artifactData(
  resource: InspectorResource<typeof FactoryArtifactDto.Type>
) {
  return resource.status === "ready" ? resource.data : [];
}

function resourceNotices(input: {
  readonly activity: InspectorResource<typeof FactoryActivityDto.Type>;
  readonly artifactCatalog: InspectorResource<typeof FactoryArtifactDto.Type>;
}) {
  return [
    resourceNotice("Activity", input.activity),
    resourceNotice("Artifacts", input.artifactCatalog),
  ].filter(isPresent);
}

function resourceNotice<T>(
  label: string,
  resource: InspectorResource<T>
): InspectorNotice | undefined {
  if (resource.status === "ready") {
    return undefined;
  }

  return {
    message: resource.message,
    status: resource.status,
    title:
      resource.status === "loading"
        ? `${label} loading`
        : `${label} unavailable`,
  };
}

function scopedAgentActivity(
  activities: ReadonlyArray<typeof FactoryActivityDto.Type>,
  agentId: typeof FactoryAgentDto.Type.id
) {
  return activities.filter((activity) => activity.agentId === agentId);
}

function agentOwnedArtifacts(
  artifacts: ReadonlyArray<typeof FactoryArtifactDto.Type>,
  agentId: typeof FactoryAgentDto.Type.id
) {
  return artifacts.filter((artifact) => artifact.ownerAgentId === agentId);
}

function workItemArtifacts(input: {
  readonly activities: ReadonlyArray<typeof FactoryActivityDto.Type>;
  readonly agents: ReadonlyArray<typeof FactoryAgentDto.Type>;
  readonly artifacts: ReadonlyArray<typeof FactoryArtifactDto.Type>;
}) {
  const linkedArtifactIds = new Set(
    input.activities.flatMap((activity) => activity.artifactIds)
  );
  const agentIds = new Set(input.agents.map((agent) => agent.id));

  return input.artifacts.filter(
    (artifact) =>
      agentIds.has(artifact.ownerAgentId) ||
      linkedArtifactIds.has(artifact.artifactId)
  );
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
