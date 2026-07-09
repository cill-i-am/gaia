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

type FactoryGraphAgent = (typeof FactoryGraphDto.Type)["agents"][number];

const factoryCanvasRowGap = 224;
const factoryCanvasColumnGap = 80;
const factoryCanvasNodeWidth = 320;
const factoryCanvasColumnStep =
  factoryCanvasNodeWidth + factoryCanvasColumnGap;

const issueDeliveryRoleLayout = {
  ciWatcher: { fallbackDepth: 4, lane: "ci", order: 5 },
  orchestrator: { fallbackDepth: 0, lane: "orchestration", order: 1 },
  researcher: { fallbackDepth: 5, lane: "research", order: 6 },
  reviewer: { fallbackDepth: 2, lane: "review", order: 3 },
  tester: { fallbackDepth: 3, lane: "verification", order: 4 },
  unknown: { fallbackDepth: 6, lane: "unknown", order: 90 },
  worker: { fallbackDepth: 1, lane: "implementation", order: 2 },
} satisfies Record<
  FactoryAgentRole,
  {
    readonly fallbackDepth: number;
    readonly lane: FactoryCanvasLane;
    readonly order: number;
  }
>;

type IssueDeliveryExpectedEdgeEndpoint = {
  readonly kind: "agentRole";
  readonly role: FactoryAgentRole;
};

const issueDeliveryExpectedEdges: ReadonlyArray<{
  readonly source: IssueDeliveryExpectedEdgeEndpoint;
  readonly target: IssueDeliveryExpectedEdgeEndpoint;
  readonly type: FactoryRelationshipType;
}> = [
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
  const agents = [...graph.agents].sort(compareAgents);
  const positionByAgentId = layoutFactoryAgents({
    agents,
    edges: graph.edges,
  });

  const nodes = agents.map((agent, index) => {
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
    const position = positionByAgentId.get(agent.id) ?? {
      x: index * factoryCanvasColumnStep,
      y: layout.fallbackDepth * factoryCanvasRowGap,
    };

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
      position,
    };
  }) satisfies ReadonlyArray<FactoryCanvasNode>;
  const canvasNodeIds = new Set<string>(nodes.map((node) => node.rawId));
  const edges = graph.edges
    .filter(
      (edge) =>
        canvasNodeIds.has(edge.sourceId) && canvasNodeIds.has(edge.targetId),
    )
    .map((edge) => ({
      id: `edge:${edge.id}`,
      label: edge.type,
      source: agentNodeId(edge.sourceId),
      target: agentNodeId(edge.targetId),
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
      message: "Factory graph has no agent topology nodes.",
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
    const sourceId = agentByRole.get(expectedEdge.source.role)?.id;
    const targetId = agentByRole.get(expectedEdge.target.role)?.id;

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

function agentNodeId(id: string) {
  return `agent:${id}`;
}

function layoutFactoryAgents(input: {
  readonly agents: ReadonlyArray<FactoryGraphAgent>;
  readonly edges: typeof FactoryGraphDto.Type.edges;
}): ReadonlyMap<string, FactoryCanvasNode["position"]> {
  const agentIds = new Set(input.agents.map((agent) => agent.id));
  const links = layoutLinks({
    agentIds,
    agents: input.agents,
    edges: input.edges,
  });
  const depthByAgentId = compactDepths(
    layoutDepths({ agents: input.agents, links }),
  );
  const maxDepth = Math.max(0, ...depthByAgentId.values());
  const positions = new Map<string, FactoryCanvasNode["position"]>();

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const layerAgents = input.agents.filter(
      (agent) => depthByAgentId.get(agent.id) === depth,
    );
    if (layerAgents.length === 0) {
      continue;
    }

    const desiredPositions = layerDesiredPositions({
      agents: layerAgents,
      links,
      positions,
    });

    for (const position of placeLayer(desiredPositions)) {
      positions.set(position.agent.id, {
        x: position.x,
        y: depth * factoryCanvasRowGap,
      });
    }
  }

  return positions;
}

type LayoutLink = {
  readonly sourceId: string;
  readonly targetId: string;
};

function layoutLinks(input: {
  readonly agentIds: ReadonlySet<string>;
  readonly agents: ReadonlyArray<FactoryGraphAgent>;
  readonly edges: typeof FactoryGraphDto.Type.edges;
}): ReadonlyArray<LayoutLink> {
  const linksById = new Map<string, LayoutLink>();

  for (const edge of input.edges) {
    if (
      edge.sourceId === edge.targetId ||
      !input.agentIds.has(edge.sourceId) ||
      !input.agentIds.has(edge.targetId)
    ) {
      continue;
    }

    linksById.set(`${edge.sourceId}->${edge.targetId}`, {
      sourceId: edge.sourceId,
      targetId: edge.targetId,
    });
  }

  for (const agent of input.agents) {
    if (
      agent.parentAgentId === undefined ||
      agent.parentAgentId === agent.id ||
      !input.agentIds.has(agent.parentAgentId)
    ) {
      continue;
    }

    const linkId = `${agent.parentAgentId}->${agent.id}`;
    if (!linksById.has(linkId)) {
      linksById.set(linkId, {
        sourceId: agent.parentAgentId,
        targetId: agent.id,
      });
    }
  }

  return [...linksById.values()].sort((left, right) =>
    layoutLinkSortKey(left).localeCompare(layoutLinkSortKey(right)),
  );
}

function layoutDepths(input: {
  readonly agents: ReadonlyArray<FactoryGraphAgent>;
  readonly links: ReadonlyArray<LayoutLink>;
}): ReadonlyMap<string, number> {
  const agentById = new Map<string, FactoryGraphAgent>(
    input.agents.map((agent) => [agent.id, agent]),
  );
  const incomingCount = new Map<string, number>(
    input.agents.map((agent) => [agent.id, 0]),
  );
  const childrenByAgentId = new Map<string, Array<string>>();
  const depthByAgentId = new Map<string, number>();

  for (const agent of input.agents) {
    const hasIncoming = input.links.some((link) => link.targetId === agent.id);
    depthByAgentId.set(
      agent.id,
      hasIncoming ? 0 : issueDeliveryRoleLayout[agent.role].fallbackDepth,
    );
  }

  for (const link of input.links) {
    incomingCount.set(link.targetId, (incomingCount.get(link.targetId) ?? 0) + 1);
    const children = childrenByAgentId.get(link.sourceId) ?? [];
    children.push(link.targetId);
    childrenByAgentId.set(link.sourceId, children);
  }

  const queue = input.agents
    .filter((agent) => (incomingCount.get(agent.id) ?? 0) === 0)
    .sort(compareAgents);

  while (queue.length > 0) {
    const agent = queue.shift();
    if (agent === undefined) {
      continue;
    }

    const sourceDepth =
      depthByAgentId.get(agent.id) ??
      issueDeliveryRoleLayout[agent.role].fallbackDepth;
    const children = (childrenByAgentId.get(agent.id) ?? []).sort((left, right) =>
      compareAgentsById(agentById, left, right),
    );

    for (const childId of children) {
      const child = agentById.get(childId);
      if (child === undefined) {
        continue;
      }

      depthByAgentId.set(
        childId,
        Math.max(depthByAgentId.get(childId) ?? 0, sourceDepth + 1),
      );
      const nextIncomingCount = (incomingCount.get(childId) ?? 0) - 1;
      incomingCount.set(childId, nextIncomingCount);
      if (nextIncomingCount === 0) {
        queue.push(child);
        queue.sort(compareAgents);
      }
    }
  }

  const maxSettledDepth = Math.max(0, ...depthByAgentId.values());
  for (const agent of input.agents) {
    if ((incomingCount.get(agent.id) ?? 0) > 0) {
      depthByAgentId.set(
        agent.id,
        maxSettledDepth + issueDeliveryRoleLayout[agent.role].fallbackDepth + 1,
      );
    }
  }

  return depthByAgentId;
}

function compactDepths(
  depthByAgentId: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const compactDepthByRawDepth = new Map(
    [...new Set(depthByAgentId.values())]
      .sort((left, right) => left - right)
      .map((depth, index) => [depth, index]),
  );

  return new Map(
    [...depthByAgentId.entries()].map(([agentId, depth]) => [
      agentId,
      compactDepthByRawDepth.get(depth) ?? depth,
    ]),
  );
}

type LayerDesiredPosition = {
  readonly agent: FactoryGraphAgent;
  readonly desiredX: number;
};

function layerDesiredPositions(input: {
  readonly agents: ReadonlyArray<FactoryGraphAgent>;
  readonly links: ReadonlyArray<LayoutLink>;
  readonly positions: ReadonlyMap<string, FactoryCanvasNode["position"]>;
}): ReadonlyArray<LayerDesiredPosition> {
  const parentIdsByAgentId = new Map<string, Array<string>>();

  for (const link of input.links) {
    const parentIds = parentIdsByAgentId.get(link.targetId) ?? [];
    parentIds.push(link.sourceId);
    parentIdsByAgentId.set(link.targetId, parentIds);
  }

  return input.agents
    .map((agent, index) => {
      const parentXs = (parentIdsByAgentId.get(agent.id) ?? []).flatMap(
        (parentId) => {
          const position = input.positions.get(parentId);

          return position === undefined ? [] : [position.x];
        },
      );

      return {
        agent,
        desiredX:
          parentXs.length === 0
            ? centeredLayerX(input.agents.length, index)
            : average(parentXs),
      };
    })
    .sort((left, right) => {
      const desiredDelta = left.desiredX - right.desiredX;
      if (desiredDelta !== 0) {
        return desiredDelta;
      }

      return compareAgents(left.agent, right.agent);
    });
}

function placeLayer(
  desiredPositions: ReadonlyArray<LayerDesiredPosition>,
): ReadonlyArray<LayerDesiredPosition & { readonly x: number }> {
  const placed: Array<LayerDesiredPosition & { readonly x: number }> = [];
  let previousX: number | undefined;

  for (const position of desiredPositions) {
    const minimumX =
      previousX === undefined
        ? position.desiredX
        : previousX + factoryCanvasColumnStep;
    const x = Math.max(position.desiredX, minimumX);

    placed.push({
      ...position,
      x,
    });
    previousX = x;
  }

  const shift =
    average(desiredPositions.map((position) => position.desiredX)) -
    average(placed.map((position) => position.x));

  return placed.map((position) => ({
    ...position,
    x: position.x + shift,
  }));
}

function centeredLayerX(count: number, index: number) {
  return (index - (count - 1) / 2) * factoryCanvasColumnStep;
}

function average(values: ReadonlyArray<number>) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function compareAgents(left: FactoryGraphAgent, right: FactoryGraphAgent) {
  const orderDelta =
    issueDeliveryRoleLayout[left.role].order -
    issueDeliveryRoleLayout[right.role].order;

  return orderDelta === 0
    ? String(left.id).localeCompare(String(right.id))
    : orderDelta;
}

function compareAgentsById(
  agentById: ReadonlyMap<string, FactoryGraphAgent>,
  leftId: string,
  rightId: string,
) {
  const left = agentById.get(leftId);
  const right = agentById.get(rightId);

  if (left === undefined || right === undefined) {
    return leftId.localeCompare(rightId);
  }

  return compareAgents(left, right);
}

function layoutLinkSortKey(link: LayoutLink) {
  return `${link.sourceId}->${link.targetId}`;
}
