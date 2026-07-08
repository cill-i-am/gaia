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
    ]);
    expect(model.nodes.map((node) => node.kind)).toEqual([
      "workItem",
      "agent",
      "agent",
      "agent",
    ]);
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
        source: "agent:agent-orchestrator",
        target: "work-item:work-root",
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
    ]);
  });

  it("keeps artifacts and activity as references on agent nodes", () => {
    const model = buildFactoryCanvasModel(factoryGraphFixture());
    const worker = model.nodes.find((node) => node.id === "agent:agent-worker");

    expect(worker).toMatchObject({
      artifactCount: 2,
      artifactIds: ["artifact-plan", "artifact-summary"],
      latestActivityId: "activity-worker",
      role: "worker",
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
    expect(model.diagnostics).toEqual([
      {
        code: "FactoryGraphNotFound",
        message: "Factory graph projection is unavailable.",
        recoverable: true,
      },
      {
        code: "FactoryGraphEmpty",
        message: "Factory graph has no work item or agent topology nodes.",
        recoverable: true,
      },
    ]);
  });
});

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
    ],
    diagnostics: [],
    edges: [
      {
        id: "edge-owns",
        sourceId: "agent-orchestrator",
        targetId: "work-root",
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
