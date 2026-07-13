import {
  FactoryActivityDto,
  FactoryActivityIdSchema,
  FactoryAgentIdSchema,
  FactoryArtifactIdSchema,
  FactoryGraphDto,
  FactoryWorkItemIdSchema,
  RunIdSchema,
} from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildSelectedNodeInspectorModel,
  type InspectorResource,
} from "@/selected-node-inspector-model";
import type { FactoryCanvasNode } from "@/factory-canvas-model";
import { testFactoryExecution } from "@/test-factory-execution";

describe("selected node inspector model", () => {
  it("represents no-run, loading, and no-selection states honestly", () => {
    expect(
      buildSelectedNodeInspectorModel({
        activity: ready([]),
        artifactCatalog: ready([]),
        graph: undefined,
        graphIsLoading: false,
        selectedNode: undefined,
        selectedRunId: undefined,
      }),
    ).toMatchObject({
      kind: "empty",
      reason: "no-run",
      title: "No run selected",
    });

    expect(
      buildSelectedNodeInspectorModel({
        activity: ready([]),
        artifactCatalog: ready([]),
        graph: undefined,
        graphIsLoading: true,
        selectedNode: undefined,
        selectedRunId: runId("run-1234567890"),
      }),
    ).toMatchObject({
      kind: "empty",
      reason: "loading",
      title: "Loading selected run",
    });

    expect(
      buildSelectedNodeInspectorModel({
        activity: ready([]),
        artifactCatalog: ready([]),
        graph: graphFixture(),
        graphIsLoading: false,
        selectedNode: undefined,
        selectedRunId: runId("run-1234567890"),
      }),
    ).toMatchObject({
      kind: "empty",
      reason: "no-selection",
      title: "No node selected",
    });
  });

  it("uses agent activity and catalog ownership for selected agent evidence", () => {
    const graph = graphFixture();
    const model = buildSelectedNodeInspectorModel({
      activity: ready([
        activityFixture({
          activityId: "activity-worker",
          agentId: "agent-worker",
          artifactIds: ["artifact-worker-summary"],
          label: "Worker wrote summary",
        }),
        activityFixture({
          activityId: "activity-reviewer",
          agentId: "agent-reviewer",
          artifactIds: ["artifact-review"],
          label: "Reviewer activity should stay out",
          sequence: 2,
        }),
      ]),
      artifactCatalog: ready([
        artifactFixture({
          artifactId: "artifact-worker-summary",
          label: "Worker summary",
          ownerAgentId: "agent-worker",
        }),
        artifactFixture({
          artifactId: "artifact-review",
          label: "Review",
          ownerAgentId: "agent-reviewer",
        }),
      ]),
      graph,
      graphIsLoading: false,
      selectedNode: agentNode(),
      selectedRunId: runId("run-1234567890"),
    });

    expect(model.kind).toBe("agent");
    if (model.kind !== "agent") {
      throw new Error("Expected agent model.");
    }

    expect(model.agent.id).toBe("agent-worker");
    expect(model.activity.map((entry) => entry.label)).toEqual([
      "Worker wrote summary",
    ]);
    expect(model.artifacts.map((artifact) => artifact.label)).toEqual([
      "Worker summary",
    ]);
    expect(model.queryAvailable).toBe(false);
  });

  it("uses run activity, linked agents, and public artifact ownership for work items", () => {
    const model = buildSelectedNodeInspectorModel({
      activity: ready([
        activityFixture({
          activityId: "activity-root",
          artifactIds: ["artifact-root-plan"],
          label: "Issue planning started",
          workItemId: "work-root",
        }),
        activityFixture({
          activityId: "activity-other",
          label: "Other issue activity",
          sequence: 2,
          workItemId: "work-other",
        }),
      ]),
      artifactCatalog: ready([
        artifactFixture({
          artifactId: "artifact-root-plan",
          label: "Root plan",
          ownerAgentId: "agent-orchestrator",
        }),
        artifactFixture({
          artifactId: "artifact-worker-summary",
          label: "Worker summary",
          ownerAgentId: "agent-worker",
        }),
        artifactFixture({
          artifactId: "artifact-other",
          label: "Other work item artifact",
          ownerAgentId: "agent-other",
        }),
      ]),
      graph: graphFixture(),
      graphIsLoading: false,
      selectedNode: workItemNode(),
      selectedRunId: runId("run-1234567890"),
    });

    expect(model.kind).toBe("workItem");
    if (model.kind !== "workItem") {
      throw new Error("Expected work item model.");
    }

    expect(model.workItem.id).toBe("work-root");
    expect(model.agents.map((agent) => agent.id)).toEqual([
      "agent-orchestrator",
      "agent-worker",
      "agent-reviewer",
    ]);
    expect(model.activity.map((entry) => entry.label)).toEqual([
      "Issue planning started",
    ]);
    expect(model.artifacts.map((artifact) => artifact.label)).toEqual([
      "Root plan",
      "Worker summary",
    ]);
  });

  it("keeps typed loading, unavailable, and error resource states visible", () => {
    const loading = buildSelectedNodeInspectorModel({
      activity: {
        message: "Agent activity is loading.",
        status: "loading",
      },
      artifactCatalog: ready([]),
      graph: graphFixture(),
      graphIsLoading: false,
      selectedNode: agentNode(),
      selectedRunId: runId("run-1234567890"),
    });

    expect(loading.kind).toBe("agent");
    if (loading.kind !== "agent") {
      throw new Error("Expected loading agent model.");
    }
    expect(loading.activityStatus).toBe("loading");
    expect(loading.notices).toContainEqual({
      message: "Agent activity is loading.",
      status: "loading",
      title: "Activity loading",
    });

    const failed = buildSelectedNodeInspectorModel({
      activity: {
        message: "FactoryAgentNotFound: Factory agent was not found.",
        status: "error",
      },
      artifactCatalog: {
        message: "Artifact catalog could not be loaded.",
        status: "unavailable",
      },
      graph: graphFixture(),
      graphIsLoading: false,
      selectedNode: agentNode(),
      selectedRunId: runId("run-1234567890"),
    });

    expect(failed.kind).toBe("agent");
    if (failed.kind !== "agent") {
      throw new Error("Expected failed agent model.");
    }
    expect(failed.activity).toEqual([]);
    expect(failed.artifacts).toEqual([]);
    expect(failed.activityStatus).toBe("error");
    expect(failed.artifactStatus).toBe("unavailable");
    expect(failed.notices.map((notice) => notice.title)).toEqual([
      "Activity unavailable",
      "Artifacts unavailable",
    ]);
  });
});

function ready<T>(data: ReadonlyArray<T>): InspectorResource<T> {
  return { data, status: "ready" };
}

function graphFixture(): typeof FactoryGraphDto.Type {
  return FactoryGraphDto.make({
    execution: testFactoryExecution,
    agents: [
      {
        artifactCount: 1,
        id: agentId("agent-orchestrator"),
        role: "orchestrator",
        state: "running",
        subState: "coordinating",
        title: "Issue orchestrator",
        workItemId: workItemId("work-root"),
      },
      {
        artifactCount: 1,
        id: agentId("agent-worker"),
        parentAgentId: agentId("agent-orchestrator"),
        role: "worker",
        state: "succeeded",
        subState: "summary ready",
        title: "Worker",
        workItemId: workItemId("work-root"),
      },
      {
        artifactCount: 1,
        id: agentId("agent-reviewer"),
        parentAgentId: agentId("agent-worker"),
        role: "reviewer",
        state: "pending",
        title: "Reviewer",
        workItemId: workItemId("work-root"),
      },
      {
        artifactCount: 1,
        id: agentId("agent-other"),
        role: "worker",
        state: "running",
        title: "Other worker",
        workItemId: workItemId("work-other"),
      },
    ],
    diagnostics: [],
    edges: [],
    linkedArtifacts: [],
    runId: runId("run-1234567890"),
    version: 1,
    workflow: "issueDelivery",
    workItems: [
      {
        externalRefs: [],
        id: workItemId("work-root"),
        kind: "issue",
        title: "Root issue",
      },
      {
        externalRefs: [],
        id: workItemId("work-other"),
        kind: "issue",
        title: "Other issue",
      },
    ],
  });
}

function agentNode(): FactoryCanvasNode {
  return {
    activityCount: 1,
    artifactCount: 1,
    artifactIds: ["artifact-worker-summary"],
    id: "agent:agent-worker",
    kind: "agent",
    label: "Worker",
    lane: "implementation",
    latestActivityId: "activity-worker",
    position: { x: 520, y: 0 },
    rawId: "agent-worker",
    role: "worker",
    state: "succeeded",
    summary: "summary ready",
    type: "worker",
  };
}

function workItemNode(): FactoryCanvasNode {
  return {
    activityCount: 1,
    artifactCount: 1,
    artifactIds: ["artifact-root-plan"],
    id: "work-item:work-root",
    kind: "workItem",
    label: "Root issue",
    lane: "work",
    latestActivityId: "activity-root",
    position: { x: 0, y: 0 },
    rawId: "work-root",
    role: undefined,
    state: undefined,
    summary: "issue work item",
    type: "issue",
  };
}

function activityFixture(input: {
  readonly activityId: string;
  readonly agentId?: string;
  readonly artifactIds?: ReadonlyArray<string>;
  readonly label: string;
  readonly sequence?: number;
  readonly workItemId?: string;
}): typeof FactoryActivityDto.Type {
  return {
    activityId: activityId(input.activityId),
    artifactIds: (input.artifactIds ?? []).map(artifactId),
    kind: "factory.activity",
    label: input.label,
    runId: runId("run-1234567890"),
    sequence: input.sequence ?? 1,
    state: "running",
    timestamp: "2026-07-08T12:00:00.000Z",
    ...(input.agentId === undefined
      ? {}
      : { agentId: agentId(input.agentId) }),
    ...(input.workItemId === undefined
      ? {}
      : { workItemId: workItemId(input.workItemId) }),
  };
}

function artifactFixture(input: {
  readonly artifactId: string;
  readonly label: string;
  readonly ownerAgentId: string;
}) {
  return {
    artifactId: artifactId(input.artifactId),
    contentType: "text/markdown" as const,
    createdAt: "2026-07-08T12:00:00.000Z",
    kind: "codeSummary" as const,
    label: input.label,
    ownerAgentId: agentId(input.ownerAgentId),
    visibility: "run" as const,
  };
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
