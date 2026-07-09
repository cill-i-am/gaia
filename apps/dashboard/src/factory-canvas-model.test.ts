import {
  FactoryActivityIdSchema,
  FactoryAgentIdSchema,
  FactoryArtifactIdSchema,
  FactoryGraphDto,
  FactoryWorkItemIdSchema,
  RunIdSchema,
} from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { buildFactoryCanvasModel } from "@/factory-canvas-model";

describe("factory canvas model", () => {
  it("projects FactoryGraph topology into work item and agent nodes only", () => {
    const graph = factoryGraphFixture();
    const model = buildFactoryCanvasModel(graph);

    expect(model.id).toBe("run-1234567890");
    expect(model.nodes.map((node) => node.id)).toEqual([
      "work-item:work-root",
      "agent:agent-orchestrator",
      "agent:agent-worker",
      "agent:agent-reviewer",
      "agent:agent-tester",
      "agent:agent-ci-watcher",
    ]);
    expect(model.nodes.map((node) => node.kind)).toEqual([
      "workItem",
      "agent",
      "agent",
      "agent",
      "agent",
      "agent",
    ]);
    expect(model.nodes.map((node) => node.lane)).toEqual([
      "work",
      "orchestration",
      "implementation",
      "review",
      "verification",
      "ci",
    ]);
    expect(model.diagnostics).toEqual([]);
    expect(model.nodes.some((node) => node.id.startsWith("artifact:"))).toBe(
      false,
    );
    expect(model.nodes.some((node) => node.id.startsWith("event:"))).toBe(
      false,
    );
    expect(model.edges).toEqual([
      {
        id: "edge:edge-owns",
        label: "owns",
        source: "work-item:work-root",
        target: "agent:agent-orchestrator",
      },
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
  });

  it("keeps artifacts and activity as references on agent nodes", () => {
    const model = buildFactoryCanvasModel(factoryGraphFixture(), {
      activities: factoryActivitiesFixture(),
    });
    const worker = model.nodes.find((node) => node.id === "agent:agent-worker");
    const workItem = model.nodes.find((node) => node.id === "work-item:work-root");

    expect(worker).toMatchObject({
      activityCount: 1,
      artifactCount: 2,
      artifactIds: ["artifact-plan", "artifact-summary"],
      latestActivityId: "activity-worker",
      role: "worker",
    });
    expect(workItem).toMatchObject({
      activityCount: 1,
      artifactCount: 1,
      artifactIds: ["artifact-plan"],
      latestActivityId: "activity-root",
    });
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
        linkedArtifacts: [],
        runId: runId("run-empty00000"),
        version: 1,
        workflow: "issueDelivery",
        workItems: [],
      }),
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
      diagnostics: [],
      edges: [
        {
          id: "edge-owns",
          sourceId: "work-root",
          targetId: "agent-orchestrator",
          type: "owns",
        },
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
      "work-item:work-root",
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

function factoryGraphFixture(): typeof FactoryGraphDto.Type {
  return FactoryGraphDto.make({
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
      {
        id: "edge-owns",
        sourceId: "work-root",
        targetId: "agent-orchestrator",
        type: "owns",
      },
      {
        id: "edge-spawned",
        sourceId: "agent-orchestrator",
        targetId: "agent-worker",
        type: "spawned",
      },
      {
        id: "edge-reviewed",
        sourceId: "agent-worker",
        targetId: "agent-reviewer",
        type: "reviewed",
      },
      {
        id: "edge-tested",
        sourceId: "agent-reviewer",
        targetId: "agent-tester",
        type: "tested",
      },
      {
        id: "edge-watched",
        sourceId: "agent-tester",
        targetId: "agent-ci-watcher",
        type: "watched",
      },
      {
        id: "edge-produced",
        sourceId: "agent-worker",
        targetId: "artifact-plan",
        type: "produced",
      },
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
  });
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

function runId(value: string) {
  return Schema.decodeUnknownSync(RunIdSchema)(value);
}

function workItemId(value: string) {
  return Schema.decodeUnknownSync(FactoryWorkItemIdSchema)(value);
}
