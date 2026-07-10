import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  FactoryActivityDto,
  FactoryAgentDto,
  FactoryArtifactDto,
  FactoryGraphDto,
  FactoryRelationshipTypeSchema,
  FactoryWorkflowDefinitionDto,
  IssueDeliveryWorkflowDefinition,
} from "./factory-graph.js";

describe("FactoryGraph core contracts", () => {
  it("parses a serializable issue delivery factory graph", () => {
    const decodeFactoryGraph = Schema.decodeUnknownSync(FactoryGraphDto);

    const graph = decodeFactoryGraph({
      agents: [
        {
          artifactCount: 1,
          id: "agent-orchestrator",
          role: "orchestrator",
          state: "running",
          title: "Issue orchestrator",
          workItemId: "work-item-root",
        },
      ],
      diagnostics: [],
      edges: [
        {
          id: "edge-root-owns-orchestrator",
          sourceId: "work-item-root",
          targetId: "agent-orchestrator",
          type: "owns",
        },
      ],
      execution: {
        capabilities: {
          approvals: [],
          fileChangeEvents: true,
          interruption: true,
          resumableSessions: true,
          review: false,
          steering: false,
          streamingMessages: true,
          structuredOutput: false,
          subagents: false,
          toolEvents: false,
          usageReporting: false,
          userQuestions: false,
        },
        executionMode: "local",
        harnessProfileId: "codexAppServer",
        provider: {
          displayName: "Codex App Server",
          executionModes: ["local"],
          providerId: "codex-app-server",
        },
        version: "0.137.0",
      },
      linkedArtifacts: [
        {
          artifactId: "artifact-worker-plan",
          contentType: "text/markdown",
          createdAt: "2026-07-08T18:00:00.000Z",
          kind: "plan",
          label: "Worker plan",
          ownerAgentId: "agent-orchestrator",
          visibility: "run",
        },
      ],
      runId: "run-abcdefghij",
      version: 1,
      workflow: "issueDelivery",
      workItems: [
        {
          externalRefs: [
            {
              id: "GAIA-65",
              provider: "linear",
              url: "https://linear.app/tskr/issue/GAIA-65",
            },
          ],
          id: "work-item-root",
          kind: "issue",
          title: "Define FactoryGraph contracts",
        },
      ],
    });

    assert.strictEqual(graph.workflow, "issueDelivery");
    assert.strictEqual(graph.workItems[0]?.kind, "issue");
    assert.strictEqual(graph.agents[0]?.role, "orchestrator");
    assert.strictEqual(graph.edges[0]?.type, "owns");
    assert.strictEqual(graph.linkedArtifacts[0]?.kind, "plan");
  });

  it("rejects unknown finite variant values", () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(FactoryAgentDto)({
        artifactCount: 0,
        id: "agent-worker",
        role: "coder",
        state: "running",
        title: "Worker",
        workItemId: "work-item-root",
      }),
    );
    assert.throws(() => Schema.decodeUnknownSync(FactoryRelationshipTypeSchema)("blocks"));
    assert.throws(() =>
      Schema.decodeUnknownSync(FactoryArtifactDto)({
        artifactId: "artifact-plan",
        contentType: "text/plain",
        createdAt: "2026-07-08T18:00:00.000Z",
        kind: "trace",
        label: "Trace",
        ownerAgentId: "agent-worker",
        visibility: "run",
      }),
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(FactoryActivityDto)({
        activityId: "activity-1",
        artifactIds: [],
        kind: "worker.started",
        label: "Worker started",
        runId: "run-abcdefghij",
        sequence: 1,
        state: "waiting",
        timestamp: "2026-07-08T18:00:00.000Z",
      }),
    );
  });

  it("defines the issueDelivery workflow as typed code", () => {
    const definition = Schema.decodeUnknownSync(FactoryWorkflowDefinitionDto)(
      IssueDeliveryWorkflowDefinition,
    );

    assert.strictEqual(definition.workflow, "issueDelivery");
    assert.strictEqual(definition.rootWorkItemKind, "issue");
    assert.deepEqual(
      definition.agentRoles.map((agent) => agent.role),
      ["orchestrator", "worker", "reviewer", "tester", "ciWatcher"],
    );
    assert.deepEqual(
      definition.relationships.map((relationship) => relationship.type),
      ["owns", "spawned", "reviewed", "tested", "watched"],
    );
  });
});
