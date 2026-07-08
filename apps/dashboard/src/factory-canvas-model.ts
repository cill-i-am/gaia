import type {
  FactoryAgentRole,
  FactoryAgentState,
  FactoryGraphDiagnosticDto,
  FactoryGraphDto,
  FactoryRelationshipType,
  FactoryWorkItemKind,
} from "@gaia/core";

export type FactoryCanvasNodeKind = "agent" | "workItem";

export type FactoryCanvasNode = {
  readonly id: string;
  readonly artifactCount: number;
  readonly artifactIds: ReadonlyArray<string>;
  readonly kind: FactoryCanvasNodeKind;
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

export function buildFactoryCanvasModel(
  graph: typeof FactoryGraphDto.Type,
): FactoryCanvasModel {
  const nodes = [
    ...graph.workItems.map((workItem, index) => ({
      id: workItemNodeId(workItem.id),
      artifactCount: 0,
      artifactIds: [],
      kind: "workItem" as const,
      label: workItem.title,
      latestActivityId: undefined,
      rawId: workItem.id,
      role: undefined,
      state: undefined,
      summary: workItem.description ?? `${workItem.kind} work item`,
      type: workItem.kind,
      position: { x: 0, y: index * 160 },
    })),
    ...graph.agents.map((agent, index) => {
      const artifactIds = graph.linkedArtifacts
        .filter((artifact) => artifact.ownerAgentId === agent.id)
        .map((artifact) => artifact.artifactId);

      return {
        id: agentNodeId(agent.id),
        artifactCount: agent.artifactCount,
        artifactIds,
        kind: "agent" as const,
        label: agent.title,
        latestActivityId: agent.latestActivityId,
        rawId: agent.id,
        role: agent.role,
        state: agent.state,
        summary: agent.subState ?? `${agent.role} is ${agent.state}`,
        type: agent.role,
        position: {
          x: 340 + (index % 3) * 280,
          y: Math.floor(index / 3) * 160,
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
  if (nodes.length > 0) {
    return graph.diagnostics;
  }

  return [
    ...graph.diagnostics,
    {
      code: "FactoryGraphEmpty",
      message: "Factory graph has no work item or agent topology nodes.",
      recoverable: true,
    },
  ];
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
