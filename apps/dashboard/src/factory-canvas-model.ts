import type {
  FactoryActivityDto,
  FactoryAgentRole,
  FactoryAgentState,
  FactoryGraphDiagnosticDto,
  FactoryGraphDto,
  FactoryRelationshipType,
  FactoryWorkItemKind,
} from "@gaia/core";
import { IssueDeliveryWorkflowDefinition } from "@gaia/core";

export type FactoryCanvasNodeKind = "agent" | "workItem";
export type FactoryCanvasLane =
  | "ci"
  | "implementation"
  | "orchestration"
  | "research"
  | "review"
  | "unknown"
  | "verification"
  | "work";

export type FactoryCanvasNode = {
  readonly activityCount: number;
  readonly id: string;
  readonly artifactCount: number;
  readonly artifactIds: ReadonlyArray<string>;
  readonly kind: FactoryCanvasNodeKind;
  readonly lane: FactoryCanvasLane;
  readonly label: string;
  readonly latestActivityId: string | undefined;
  readonly rawId: string;
  readonly role: FactoryAgentRole | undefined;
  readonly state: FactoryAgentState | undefined;
  readonly summary: string;
  readonly type: FactoryWorkItemKind | FactoryAgentRole;
  readonly position: {
    readonly x: number;
    readonly y: number;
  };
};

export type FactoryCanvasEdge = {
  readonly id: string;
  readonly label: FactoryRelationshipType;
  readonly source: string;
  readonly target: string;
};

export type FactoryCanvasModel = {
  readonly diagnostics: ReadonlyArray<typeof FactoryGraphDiagnosticDto.Type>;
  readonly edges: ReadonlyArray<FactoryCanvasEdge>;
  readonly id: string;
  readonly nodes: ReadonlyArray<FactoryCanvasNode>;
  readonly title: string;
  readonly workflow: typeof FactoryGraphDto.Type.workflow;
};

const issueDeliveryRoleLayout = {
  ciWatcher: { lane: "ci", order: 5, x: 1300, y: 0 },
  orchestrator: { lane: "orchestration", order: 1, x: 260, y: 0 },
  researcher: { lane: "research", order: 6, x: 260, y: 180 },
  reviewer: { lane: "review", order: 3, x: 780, y: 0 },
  tester: { lane: "verification", order: 4, x: 1040, y: 0 },
  unknown: { lane: "unknown", order: 90, x: 260, y: 360 },
  worker: { lane: "implementation", order: 2, x: 520, y: 0 },
} satisfies Record<
  FactoryAgentRole,
  {
    readonly lane: FactoryCanvasLane;
    readonly order: number;
    readonly x: number;
    readonly y: number;
  }
>;

type IssueDeliveryExpectedEdgeEndpoint =
  | { readonly kind: "agentRole"; readonly role: FactoryAgentRole }
  | { readonly kind: "workItem" };

const issueDeliveryExpectedEdges: ReadonlyArray<{
  readonly source: IssueDeliveryExpectedEdgeEndpoint;
  readonly target: IssueDeliveryExpectedEdgeEndpoint;
  readonly type: FactoryRelationshipType;
}> = [
  {
    source: { kind: "workItem" as const },
    target: { kind: "agentRole" as const, role: "orchestrator" as const },
    type: "owns" as const,
  },
  {
    source: { kind: "agentRole" as const, role: "orchestrator" as const },
    target: { kind: "agentRole" as const, role: "worker" as const },
    type: "spawned" as const,
  },
  {
    source: { kind: "agentRole" as const, role: "worker" as const },
    target: { kind: "agentRole" as const, role: "reviewer" as const },
    type: "reviewed" as const,
  },
  {
    source: { kind: "agentRole" as const, role: "reviewer" as const },
    target: { kind: "agentRole" as const, role: "tester" as const },
    type: "tested" as const,
  },
  {
    source: { kind: "agentRole" as const, role: "tester" as const },
    target: { kind: "agentRole" as const, role: "ciWatcher" as const },
    type: "watched" as const,
  },
];

export function buildFactoryCanvasModel(
  graph: typeof FactoryGraphDto.Type,
  options: {
    readonly activities?: ReadonlyArray<typeof FactoryActivityDto.Type>;
  } = {},
): FactoryCanvasModel {
  const activities = options.activities ?? [];
  const workItems = [...graph.workItems].sort((left, right) =>
    String(left.id).localeCompare(String(right.id)),
  );
  const agents = [...graph.agents].sort((left, right) => {
    const orderDelta =
      issueDeliveryRoleLayout[left.role].order -
      issueDeliveryRoleLayout[right.role].order;

    return orderDelta === 0
      ? String(left.id).localeCompare(String(right.id))
      : orderDelta;
  });

  const nodes = [
    ...workItems.map((workItem, index) => {
      const scopedActivities = activities.filter(
        (activity) => activity.workItemId === workItem.id,
      );
      const artifactIds = activityArtifactIds(scopedActivities);

      return {
        activityCount: scopedActivities.length,
        id: workItemNodeId(workItem.id),
        artifactCount: artifactIds.length,
        artifactIds,
        kind: "workItem" as const,
        lane: "work" as const,
        label: workItem.title,
        latestActivityId: latestActivityId(scopedActivities),
        rawId: workItem.id,
        role: undefined,
        state: undefined,
        summary: workItem.description ?? `${workItem.kind} work item`,
        type: workItem.kind,
        position: { x: 0, y: index * 180 },
      };
    }),
    ...agents.map((agent, index) => {
      const scopedActivities = activities.filter(
        (activity) => activity.agentId === agent.id,
      );
      const linkedArtifactIds = graph.linkedArtifacts
        .filter((artifact) => artifact.ownerAgentId === agent.id)
        .map((artifact) => String(artifact.artifactId));
      const artifactIds = uniqueStrings([
        ...linkedArtifactIds,
        ...activityArtifactIds(scopedActivities),
      ]);
      const layout = issueDeliveryRoleLayout[agent.role];
      const duplicateRoleOffset = agents
        .slice(0, index)
        .filter((candidate) => candidate.role === agent.role).length;

      return {
        activityCount: scopedActivities.length,
        id: agentNodeId(agent.id),
        artifactCount: Math.max(agent.artifactCount, artifactIds.length),
        artifactIds,
        kind: "agent" as const,
        lane: layout.lane,
        label: agent.title,
        latestActivityId:
          agent.latestActivityId ?? latestActivityId(scopedActivities),
        rawId: agent.id,
        role: agent.role,
        state: agent.state,
        summary: agent.subState ?? `${agent.role} is ${agent.state}`,
        type: agent.role,
        position: {
          x: layout.x,
          y: layout.y + duplicateRoleOffset * 150,
        },
      };
    }),
  ] satisfies ReadonlyArray<FactoryCanvasNode>;
  const canvasNodeIds = new Set<string>(nodes.map((node) => node.rawId));
  const edges = graph.edges
    .filter(
      (edge) =>
        canvasNodeIds.has(edge.sourceId) && canvasNodeIds.has(edge.targetId),
    )
    .map((edge) => ({
      id: `edge:${edge.id}`,
      label: edge.type,
      source: canvasNodeId(edge.sourceId, graph),
      target: canvasNodeId(edge.targetId, graph),
    }));

  return {
    diagnostics: diagnosticsForGraph(graph, nodes),
    edges,
    id: graph.runId,
    nodes,
    title: graph.workItems[0]?.title ?? graph.runId,
    workflow: graph.workflow,
  };
}

function diagnosticsForGraph(
  graph: typeof FactoryGraphDto.Type,
  nodes: ReadonlyArray<FactoryCanvasNode>,
) {
  const diagnostics = [...graph.diagnostics];

  if (nodes.length === 0) {
    diagnostics.push({
      code: "FactoryGraphEmpty",
      message: "Factory graph has no work item or agent topology nodes.",
      recoverable: true,
    });
  }

  if (graph.workflow === "issueDelivery") {
    diagnostics.push(...issueDeliveryDiagnostics(graph));
  }

  return diagnostics;
}

function issueDeliveryDiagnostics(
  graph: typeof FactoryGraphDto.Type,
): ReadonlyArray<typeof FactoryGraphDiagnosticDto.Type> {
  const diagnostics: Array<typeof FactoryGraphDiagnosticDto.Type> = [];
  const rootWorkItem = graph.workItems.find(
    (workItem) => workItem.kind === "issue",
  );
  const agentByRole = new Map<FactoryAgentRole, (typeof graph.agents)[number]>();

  for (const agent of graph.agents) {
    if (!agentByRole.has(agent.role)) {
      agentByRole.set(agent.role, agent);
    }
  }

  if (rootWorkItem === undefined) {
    diagnostics.push({
      code: "FactoryGraphRootIssueUnavailable",
      message: "Issue-delivery topology is missing its root issue work item.",
      recoverable: true,
    });
  }

  for (const definition of IssueDeliveryWorkflowDefinition.agentRoles) {
    if (!agentByRole.has(definition.role)) {
      diagnostics.push({
        code: "FactoryGraphRoleUnavailable",
        message: `${definition.title} is unavailable in the public FactoryGraph.`,
        recoverable: true,
        sourceId: definition.role,
      });
    }
  }

  for (const agent of graph.agents) {
    if (agent.role === "unknown") {
      diagnostics.push({
        code: "FactoryGraphUnknownRole",
        message: `${agent.title} has an unknown public FactoryGraph role.`,
        recoverable: true,
        sourceId: agent.id,
      });
    }
  }

  for (const expectedEdge of issueDeliveryExpectedEdges) {
    const sourceId =
      expectedEdge.source.kind === "workItem"
        ? rootWorkItem?.id
        : agentByRole.get(expectedEdge.source.role)?.id;
    const targetId =
      expectedEdge.target.kind === "workItem"
        ? rootWorkItem?.id
        : agentByRole.get(expectedEdge.target.role)?.id;

    if (sourceId === undefined || targetId === undefined) {
      continue;
    }

    const hasRelationship = graph.edges.some(
      (edge) =>
        edge.sourceId === sourceId &&
        edge.targetId === targetId &&
        edge.type === expectedEdge.type,
    );

    if (!hasRelationship) {
      diagnostics.push({
        code: "FactoryGraphRelationshipUnavailable",
        message: `Expected ${expectedEdge.type} relationship is unavailable between ${sourceId} and ${targetId}.`,
        recoverable: true,
        sourceId: `${sourceId}->${targetId}`,
      });
    }
  }

  return diagnostics;
}

function activityArtifactIds(
  activities: ReadonlyArray<typeof FactoryActivityDto.Type>,
) {
  return uniqueStrings(
    activities.flatMap((activity) =>
      activity.artifactIds.map((artifactId) => String(artifactId)),
    ),
  );
}

function latestActivityId(
  activities: ReadonlyArray<typeof FactoryActivityDto.Type>,
) {
  return [...activities].sort((left, right) => right.sequence - left.sequence)[0]
    ?.activityId;
}

function uniqueStrings(values: ReadonlyArray<string>) {
  return [...new Set(values)];
}

function canvasNodeId(rawId: string, graph: typeof FactoryGraphDto.Type) {
  return graph.workItems.some((workItem) => workItem.id === rawId)
    ? workItemNodeId(rawId)
    : agentNodeId(rawId);
}

function agentNodeId(id: string) {
  return `agent:${id}`;
}

function workItemNodeId(id: string) {
  return `work-item:${id}`;
}
