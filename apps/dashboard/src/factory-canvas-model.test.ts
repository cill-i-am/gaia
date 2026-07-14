import {
  FactoryActivityIdSchema,
  FactoryAgentIdSchema,
  FactoryArtifactIdSchema,
  FactoryEdgeIdSchema,
  FactoryGraphNodeIdSchema,
  FactoryGraphDto,
  FactoryWorkItemIdSchema,
  RunIdSchema,
} from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  FactoryCanvasModelSchema,
  buildFactoryCanvasModel,
} from "@/factory-canvas-model";
import { testFactoryExecution } from "@/test-factory-execution";

describe("factory canvas model", () => {
  it("projects FactoryGraph topology into agent nodes only", () => {
    const graph = factoryGraphFixture();
    const model = buildFactoryCanvasModel(graph);

    expect(model.id).toBe("run-1234567890");
    expect(model.nodes.map((node) => node.id)).toEqual([
      "agent:agent-orchestrator",
      "agent:agent-worker",
      "agent:agent-reviewer",
      "agent:agent-tester",
      "agent:agent-ci-watcher",
    ]);
    expect(model.nodes.map((node) => node.kind)).toEqual([
      "agent",
      "agent",
      "agent",
      "agent",
      "agent",
    ]);
    expect(model.nodes.map((node) => node.lane)).toEqual([
      "orchestration",
      "implementation",
      "review",
      "verification",
      "ci",
    ]);
    expect(model.nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 224 },
      { x: 0, y: 448 },
      { x: 0, y: 672 },
      { x: 0, y: 896 },
    ]);
    expect(model.diagnostics).toEqual([]);
    expect(model.nodes.some((node) => node.id.startsWith("artifact:"))).toBe(
      false
    );
    expect(model.nodes.some((node) => node.id.startsWith("event:"))).toBe(
      false
    );
    expect(model.nodes.some((node) => node.id.startsWith("work-item:"))).toBe(
      false
    );
    expect(model.edges).toEqual([
      {
        id: "edge:edge-spawned",
        label: "spawned",
        source: "agent:agent-orchestrator",
        target: "agent:agent-worker",
      },
      {
        id: "edge:edge-reviewed",
        label: "reviewed",
        source: "agent:agent-worker",
        target: "agent:agent-reviewer",
      },
      {
        id: "edge:edge-tested",
        label: "tested",
        source: "agent:agent-reviewer",
        target: "agent:agent-tester",
      },
      {
        id: "edge:edge-watched",
        label: "watched",
        source: "agent:agent-tester",
        target: "agent:agent-ci-watcher",
      },
    ]);
    expect(Schema.decodeUnknownSync(FactoryCanvasModelSchema)(model)).toEqual(
      model
    );
  });

  it("keeps artifacts and activity as references on agent nodes", () => {
    const model = buildFactoryCanvasModel(factoryGraphFixture(), {
      activities: factoryActivitiesFixture(),
    });
    const worker = model.nodes.find((node) => node.id === "agent:agent-worker");
    const orchestrator = model.nodes.find(
      (node) => node.id === "agent:agent-orchestrator"
    );

    expect(worker).toMatchObject({
      activityCount: 1,
      artifactCount: 2,
      artifactIds: ["artifact-plan", "artifact-summary"],
      latestActivityId: "activity-worker",
      role: "worker",
    });
    expect(orchestrator).toMatchObject({
      activityCount: 1,
      artifactCount: 1,
      artifactIds: ["artifact-plan"],
      latestActivityId: "activity-root",
    });
  });

  it("uses operator copy instead of generated role-state grammar when sub-state is absent", () => {
    const model = buildFactoryCanvasModel(factoryGraphFixture());
    const worker = model.nodes.find((node) => node.id === "agent:agent-worker");

    expect(worker?.summary).toBe("Worker succeeded");
    expect(worker?.summary).not.toBe("worker is succeeded");
  });

  it("surfaces empty and unavailable graph diagnostics without inventing nodes", () => {
    const model = buildFactoryCanvasModel(
      FactoryGraphDto.make({
        agents: [],
        diagnostics: [
          {
            code: "FactoryGraphNotFound",
            message: "Factory graph projection is unavailable.",
            recoverable: true,
          },
        ],
        edges: [],
        execution: testFactoryExecution,
        linkedArtifacts: [],
        runId: runId("run-empty00000"),
        version: 1,
        workflow: "issueDelivery",
        workItems: [],
      })
    );

    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "FactoryGraphNotFound",
      "FactoryGraphEmpty",
      "FactoryGraphRootIssueUnavailable",
      "FactoryGraphRoleUnavailable",
      "FactoryGraphRoleUnavailable",
      "FactoryGraphRoleUnavailable",
      "FactoryGraphRoleUnavailable",
      "FactoryGraphRoleUnavailable",
    ]);
  });

  it("keeps sparse graphs sparse and reports missing role relationships", () => {
    const graph = FactoryGraphDto.make({
      agents: [
        {
          artifactCount: 0,
          id: agentId("agent-orchestrator"),
          role: "orchestrator",
          state: "running",
          title: "Issue orchestrator",
          workItemId: workItemId("work-root"),
        },
        {
          artifactCount: 0,
          id: agentId("agent-worker"),
          parentAgentId: agentId("agent-orchestrator"),
          role: "worker",
          state: "pending",
          title: "Worker",
          workItemId: workItemId("work-root"),
        },
      ],
      execution: testFactoryExecution,
      diagnostics: [],
      edges: [
        factoryEdge("edge-owns", "work-root", "agent-orchestrator", "owns"),
      ],
      linkedArtifacts: [],
      runId: runId("run-sparse0000"),
      version: 1,
      workflow: "issueDelivery",
      workItems: [
        {
          externalRefs: [],
          id: workItemId("work-root"),
          kind: "issue",
          title: "Sparse issue",
        },
      ],
    });
    const model = buildFactoryCanvasModel(graph);

    expect(model.nodes.map((node) => node.id)).toEqual([
      "agent:agent-orchestrator",
      "agent:agent-worker",
    ]);
    expect(model.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "FactoryGraphRoleUnavailable",
      "FactoryGraphRoleUnavailable",
      "FactoryGraphRoleUnavailable",
      "FactoryGraphRelationshipUnavailable",
    ]);
  });

  it("lays out duplicate role branches without node overlap", () => {
    const graph = factoryGraphFixture({
      agents: [
        factoryAgent({
          id: "agent-orchestrator",
          role: "orchestrator",
          state: "running",
          title: "Issue orchestrator",
        }),
        factoryAgent({
          id: "agent-worker-a",
          parentAgentId: "agent-orchestrator",
          role: "worker",
          state: "running",
          title: "Worker A",
        }),
        factoryAgent({
          id: "agent-worker-b",
          parentAgentId: "agent-orchestrator",
          role: "worker",
          state: "running",
          title: "Worker B",
        }),
        factoryAgent({
          id: "agent-worker-c",
          parentAgentId: "agent-orchestrator",
          role: "worker",
          state: "running",
          title: "Worker C",
        }),
        factoryAgent({
          id: "agent-researcher",
          parentAgentId: "agent-orchestrator",
          role: "researcher",
          state: "succeeded",
          title: "Researcher",
        }),
        factoryAgent({
          id: "agent-reviewer-a",
          parentAgentId: "agent-worker-a",
          role: "reviewer",
          state: "pending",
          title: "Reviewer A",
        }),
        factoryAgent({
          id: "agent-reviewer-b",
          parentAgentId: "agent-worker-c",
          role: "reviewer",
          state: "pending",
          title: "Reviewer B",
        }),
        factoryAgent({
          id: "agent-tester",
          parentAgentId: "agent-reviewer-a",
          role: "tester",
          state: "pending",
          title: "Tester",
        }),
        factoryAgent({
          id: "agent-ci-watcher",
          parentAgentId: "agent-tester",
          role: "ciWatcher",
          state: "unknown",
          title: "CI watcher",
        }),
      ],
      edges: [
        factoryEdge(
          "edge-spawned-a",
          "agent-orchestrator",
          "agent-worker-a",
          "spawned"
        ),
        factoryEdge(
          "edge-spawned-b",
          "agent-orchestrator",
          "agent-worker-b",
          "spawned"
        ),
        factoryEdge(
          "edge-spawned-c",
          "agent-orchestrator",
          "agent-worker-c",
          "spawned"
        ),
        factoryEdge(
          "edge-supports-research",
          "agent-orchestrator",
          "agent-researcher",
          "supports"
        ),
        factoryEdge(
          "edge-reviewed-a",
          "agent-worker-a",
          "agent-reviewer-a",
          "reviewed"
        ),
        factoryEdge(
          "edge-reviewed-b",
          "agent-worker-b",
          "agent-reviewer-a",
          "reviewed"
        ),
        factoryEdge(
          "edge-reviewed-c",
          "agent-worker-c",
          "agent-reviewer-b",
          "reviewed"
        ),
        factoryEdge(
          "edge-tested-a",
          "agent-reviewer-a",
          "agent-tester",
          "tested"
        ),
        factoryEdge(
          "edge-tested-b",
          "agent-reviewer-b",
          "agent-tester",
          "tested"
        ),
        factoryEdge(
          "edge-watched",
          "agent-tester",
          "agent-ci-watcher",
          "watched"
        ),
      ],
      linkedArtifacts: [],
    });
    const model = buildFactoryCanvasModel(graph);
    const positionByRawId = positionsByRawId(model.nodes);

    expectNoNodeOverlap(model.nodes);
    expect(positionById(positionByRawId, "agent-worker-a")?.y).toBe(
      positionById(positionByRawId, "agent-worker-b")?.y
    );
    expect(positionById(positionByRawId, "agent-worker-b")?.y).toBe(
      positionById(positionByRawId, "agent-worker-c")?.y
    );
    expectHorizontalGap(positionByRawId, "agent-worker-a", "agent-worker-b");
    expectHorizontalGap(positionByRawId, "agent-worker-b", "agent-worker-c");
    expect(
      positionById(positionByRawId, "agent-reviewer-a")?.y
    ).toBeGreaterThan(
      positionById(positionByRawId, "agent-worker-a")?.y ??
        Number.POSITIVE_INFINITY
    );
    expect(positionById(positionByRawId, "agent-tester")?.x).toBeGreaterThan(
      Math.min(
        positionById(positionByRawId, "agent-reviewer-a")?.x ?? 0,
        positionById(positionByRawId, "agent-reviewer-b")?.x ?? 0
      )
    );
    expect(positionById(positionByRawId, "agent-tester")?.x).toBeLessThan(
      Math.max(
        positionById(positionByRawId, "agent-reviewer-a")?.x ?? 0,
        positionById(positionByRawId, "agent-reviewer-b")?.x ?? 0
      )
    );
    for (const edge of model.edges) {
      const source = model.nodes.find((node) => node.id === edge.source);
      const target = model.nodes.find((node) => node.id === edge.target);

      expect(target?.position.y).toBeGreaterThan(
        source?.position.y ?? Number.POSITIVE_INFINITY
      );
    }
  });

  it("keeps sparse unknown-role topology stable without fake edges", () => {
    const graph = factoryGraphFixture({
      agents: [
        factoryAgent({
          id: "agent-orchestrator",
          role: "orchestrator",
          state: "running",
          title: "Issue orchestrator",
        }),
        factoryAgent({
          id: "agent-worker",
          parentAgentId: "agent-orchestrator",
          role: "worker",
          state: "pending",
          title: "Worker",
        }),
        factoryAgent({
          id: "agent-unknown-a",
          role: "unknown",
          state: "unknown",
          title: "Unknown lane A",
        }),
        factoryAgent({
          id: "agent-unknown-b",
          role: "unknown",
          state: "unknown",
          title: "Unknown lane B",
        }),
      ],
      edges: [
        factoryEdge("edge-owns", "work-root", "agent-orchestrator", "owns"),
      ],
      linkedArtifacts: [],
    });
    const model = buildFactoryCanvasModel(graph);
    const positionByRawId = positionsByRawId(model.nodes);

    expect(model.edges).toEqual([]);
    expectNoNodeOverlap(model.nodes);
    expect(positionById(positionByRawId, "agent-worker")?.y).toBeGreaterThan(
      positionById(positionByRawId, "agent-orchestrator")?.y ??
        Number.POSITIVE_INFINITY
    );
    expect(positionById(positionByRawId, "agent-unknown-a")?.y).toBe(
      positionById(positionByRawId, "agent-unknown-b")?.y
    );
    expect(positionById(positionByRawId, "agent-unknown-a")?.y).toBeLessThan(
      700
    );
    expectHorizontalGap(positionByRawId, "agent-unknown-a", "agent-unknown-b");
  });
});

function factoryActivitiesFixture() {
  return [
    {
      activityId: activityId("activity-root"),
      agentId: agentId("agent-orchestrator"),
      artifactIds: [artifactId("artifact-plan")],
      kind: "planning",
      label: "Issue delivery planning started",
      runId: runId("run-1234567890"),
      sequence: 1,
      state: "running" as const,
      timestamp: "2026-07-08T12:00:00.000Z",
      workItemId: workItemId("work-root"),
    },
    {
      activityId: activityId("activity-worker"),
      agentId: agentId("agent-worker"),
      artifactIds: [artifactId("artifact-summary")],
      kind: "implementation",
      label: "Worker produced code summary",
      runId: runId("run-1234567890"),
      sequence: 2,
      state: "succeeded" as const,
      timestamp: "2026-07-08T12:01:00.000Z",
    },
  ];
}

function factoryAgent(input: {
  readonly artifactCount?: number;
  readonly id: string;
  readonly latestActivityId?: string;
  readonly parentAgentId?: string;
  readonly role: (typeof FactoryGraphDto.Type.agents)[number]["role"];
  readonly state: (typeof FactoryGraphDto.Type.agents)[number]["state"];
  readonly title: string;
}) {
  return {
    artifactCount: input.artifactCount ?? 0,
    id: agentId(input.id),
    ...(input.latestActivityId === undefined
      ? {}
      : { latestActivityId: activityId(input.latestActivityId) }),
    ...(input.parentAgentId === undefined
      ? {}
      : { parentAgentId: agentId(input.parentAgentId) }),
    role: input.role,
    state: input.state,
    title: input.title,
    workItemId: workItemId("work-root"),
  };
}

function factoryEdge(
  id: string,
  sourceId: string,
  targetId: string,
  type: (typeof FactoryGraphDto.Type.edges)[number]["type"]
) {
  return {
    id: edgeId(id),
    sourceId: graphNodeId(sourceId),
    targetId: graphNodeId(targetId),
    type,
  };
}

function factoryGraphFixture(
  input: Partial<typeof FactoryGraphDto.Type> = {}
): typeof FactoryGraphDto.Type {
  return FactoryGraphDto.make({
    execution: testFactoryExecution,
    agents: [
      {
        artifactCount: 0,
        id: agentId("agent-orchestrator"),
        role: "orchestrator",
        state: "running",
        title: "Issue orchestrator",
        workItemId: workItemId("work-root"),
      },
      {
        artifactCount: 2,
        id: agentId("agent-worker"),
        latestActivityId: activityId("activity-worker"),
        parentAgentId: agentId("agent-orchestrator"),
        role: "worker",
        state: "succeeded",
        title: "Worker",
        workItemId: workItemId("work-root"),
      },
      {
        artifactCount: 1,
        id: agentId("agent-reviewer"),
        parentAgentId: agentId("agent-orchestrator"),
        role: "reviewer",
        state: "running",
        title: "Reviewer",
        workItemId: workItemId("work-root"),
      },
      {
        artifactCount: 0,
        id: agentId("agent-tester"),
        parentAgentId: agentId("agent-reviewer"),
        role: "tester",
        state: "pending",
        title: "Tester",
        workItemId: workItemId("work-root"),
      },
      {
        artifactCount: 0,
        id: agentId("agent-ci-watcher"),
        parentAgentId: agentId("agent-tester"),
        role: "ciWatcher",
        state: "unknown",
        title: "CI watcher",
        workItemId: workItemId("work-root"),
      },
    ],
    diagnostics: [],
    edges: [
      factoryEdge("edge-owns", "work-root", "agent-orchestrator", "owns"),
      factoryEdge(
        "edge-spawned",
        "agent-orchestrator",
        "agent-worker",
        "spawned"
      ),
      factoryEdge(
        "edge-reviewed",
        "agent-worker",
        "agent-reviewer",
        "reviewed"
      ),
      factoryEdge("edge-tested", "agent-reviewer", "agent-tester", "tested"),
      factoryEdge(
        "edge-watched",
        "agent-tester",
        "agent-ci-watcher",
        "watched"
      ),
      factoryEdge("edge-produced", "agent-worker", "artifact-plan", "produced"),
    ],
    linkedArtifacts: [
      {
        artifactId: artifactId("artifact-plan"),
        contentType: "text/markdown",
        createdAt: "2026-07-08T12:00:00.000Z",
        kind: "plan",
        label: "Worker plan",
        ownerAgentId: agentId("agent-worker"),
        visibility: "run",
      },
      {
        artifactId: artifactId("artifact-summary"),
        contentType: "text/markdown",
        createdAt: "2026-07-08T12:01:00.000Z",
        kind: "codeSummary",
        label: "Code summary",
        ownerAgentId: agentId("agent-worker"),
        visibility: "run",
      },
      {
        artifactId: artifactId("artifact-review"),
        contentType: "text/markdown",
        createdAt: "2026-07-08T12:02:00.000Z",
        kind: "review",
        label: "Review",
        ownerAgentId: agentId("agent-reviewer"),
        visibility: "run",
      },
    ],
    runId: runId("run-1234567890"),
    version: 1,
    workflow: "issueDelivery",
    workItems: [
      {
        externalRefs: [],
        id: workItemId("work-root"),
        kind: "issue",
        title: "Add dashboard FactoryGraph model",
      },
    ],
    ...input,
  });
}

function positionsByRawId(
  nodes: ReturnType<typeof buildFactoryCanvasModel>["nodes"]
) {
  return new Map(nodes.map((node) => [node.rawId, node.position]));
}

function positionById(
  positions: ReturnType<typeof positionsByRawId>,
  rawId: string
) {
  return positions.get(graphNodeId(rawId));
}

function expectHorizontalGap(
  positions: ReturnType<typeof positionsByRawId>,
  leftId: string,
  rightId: string
) {
  const left = positionById(positions, leftId);
  const right = positionById(positions, rightId);

  expect(left).toBeDefined();
  expect(right).toBeDefined();
  expect(Math.abs((right?.x ?? 0) - (left?.x ?? 0))).toBeGreaterThanOrEqual(
    400
  );
}

function expectNoNodeOverlap(
  nodes: ReturnType<typeof buildFactoryCanvasModel>["nodes"]
) {
  const boxes = nodes.map((node) => ({
    bottom: node.position.y + 144,
    id: node.id,
    left: node.position.x,
    right: node.position.x + 320,
    top: node.position.y,
  }));

  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < boxes.length;
      rightIndex += 1
    ) {
      const left = boxes[leftIndex];
      const right = boxes[rightIndex];
      if (left === undefined || right === undefined) {
        continue;
      }

      expect(
        left.right <= right.left ||
          right.right <= left.left ||
          left.bottom <= right.top ||
          right.bottom <= left.top,
        `${left.id} should not overlap ${right.id}`
      ).toBe(true);
    }
  }
}

function activityId(value: string) {
  return Schema.decodeUnknownSync(FactoryActivityIdSchema)(value);
}

function agentId(value: string) {
  return Schema.decodeUnknownSync(FactoryAgentIdSchema)(value);
}

function artifactId(value: string) {
  return Schema.decodeUnknownSync(FactoryArtifactIdSchema)(value);
}

function edgeId(value: string) {
  return Schema.decodeUnknownSync(FactoryEdgeIdSchema)(value);
}

function graphNodeId(value: string) {
  return Schema.decodeUnknownSync(FactoryGraphNodeIdSchema)(value);
}

function runId(value: string) {
  return Schema.decodeUnknownSync(RunIdSchema)(value);
}

function workItemId(value: string) {
  return Schema.decodeUnknownSync(FactoryWorkItemIdSchema)(value);
}
