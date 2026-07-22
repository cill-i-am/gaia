import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  FactoryActivityDto,
  FactoryActivityIdSchema,
  FactoryAgentDto,
  FactoryAgentIdSchema,
  FactoryArtifactDto,
  FactoryArtifactSchema,
  FactoryArtifactIdSchema,
  FactoryEdgeIdSchema,
  FactoryExternalRefDto,
  FactoryExternalRefUrlSchema,
  FactoryGraphDto,
  FactoryRelationshipTypeSchema,
  FactoryWorkItemIdSchema,
  FactoryWorkflowDefinitionDto,
  IssueDeliveryWorkflowDefinition,
  LegacyFactoryArtifactIngress,
  type FactoryGraphNodeId,
} from "./factory-graph.js";
import {
  HarnessActionIdSchema,
  HarnessInteractionIdSchema,
  HarnessSessionIdSchema,
} from "./harness-session.js";
import { RunIdSchema } from "./run-id.js";

const acceptGraphNodeId = (nodeId: FactoryGraphNodeId) => nodeId;

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
          availability: "available",
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

  it("compounds only legal FactoryGraph node identifiers into edge endpoints", () => {
    const workItemId = Schema.decodeUnknownSync(FactoryWorkItemIdSchema)(
      "work-item-root"
    );
    const agentId =
      Schema.decodeUnknownSync(FactoryAgentIdSchema)("agent-worker");
    const artifactId = Schema.decodeUnknownSync(FactoryArtifactIdSchema)(
      "artifact-worker-plan"
    );
    const edgeId =
      Schema.decodeUnknownSync(FactoryEdgeIdSchema)("edge-root-worker");
    const activityId = Schema.decodeUnknownSync(FactoryActivityIdSchema)(
      "activity-worker"
    );
    const runId = Schema.decodeUnknownSync(RunIdSchema)("run-1234567890");
    const sessionId = Schema.decodeUnknownSync(HarnessSessionIdSchema)(
      "session-run-1234567890"
    );
    const actionId = Schema.decodeUnknownSync(HarnessActionIdSchema)(
      "action-steer"
    );
    const interactionId = Schema.decodeUnknownSync(HarnessInteractionIdSchema)(
      "interaction-approval"
    );
    const rawString = "agent-worker";

    assert.strictEqual(acceptGraphNodeId(workItemId), workItemId);
    assert.strictEqual(acceptGraphNodeId(agentId), agentId);
    assert.strictEqual(acceptGraphNodeId(artifactId), artifactId);
    // @ts-expect-error raw strings are not parsed graph node identities.
    acceptGraphNodeId(rawString);
    // @ts-expect-error edge IDs are not graph node endpoints.
    acceptGraphNodeId(edgeId);
    // @ts-expect-error activity IDs are not graph node endpoints.
    acceptGraphNodeId(activityId);
    // @ts-expect-error run IDs are not graph node endpoints.
    acceptGraphNodeId(runId);
    // @ts-expect-error harness session IDs are not graph node endpoints.
    acceptGraphNodeId(sessionId);
    // @ts-expect-error harness action IDs are not graph node endpoints.
    acceptGraphNodeId(actionId);
    // @ts-expect-error harness interaction IDs are not graph node endpoints.
    acceptGraphNodeId(interactionId);
  });

  it("rejects FactoryGraph edges whose endpoints are absent or ambiguous", () => {
    const decodeFactoryGraph = Schema.decodeUnknownSync(FactoryGraphDto);
    const validGraph = serializableFactoryGraph();

    assert.doesNotThrow(() => decodeFactoryGraph(validGraph));
    assert.throws(() =>
      decodeFactoryGraph({
        ...validGraph,
        edges: [
          {
            id: "edge-missing",
            sourceId: "work-item-root",
            targetId: "agent-missing",
            type: "owns",
          },
        ],
      })
    );
    assert.throws(() =>
      decodeFactoryGraph({
        ...validGraph,
        linkedArtifacts: [
          {
            artifactId: "agent-orchestrator",
            contentType: "text/markdown",
            createdAt: "2026-07-08T18:00:00.000Z",
            kind: "plan",
            label: "Duplicate node",
            ownerAgentId: "agent-orchestrator",
            visibility: "run",
          },
        ],
      })
    );
    assert.throws(() =>
      decodeFactoryGraph({
        ...validGraph,
        linkedArtifacts: [
          {
            ...validGraph.linkedArtifacts[0],
            ownerAgentId: "agent-missing",
          },
        ],
      })
    );
  });

  it("brands external references with exact HTTP(S) URL semantics", () => {
    const decodeExternalRef = Schema.decodeUnknownSync(FactoryExternalRefDto);
    const decodeUrl = Schema.decodeUnknownSync(FactoryExternalRefUrlSchema);

    const url = decodeUrl("https://linear.app/tskr/issue/GAIA-65");
    assert.strictEqual(url, "https://linear.app/tskr/issue/GAIA-65");
    assert.strictEqual(
      decodeExternalRef({
        id: "GAIA-65",
        provider: "linear",
        url,
      }).url,
      url
    );
    for (const rejected of [
      "not-a-url",
      "/relative",
      "//linear.app/tskr/issue/GAIA-65",
      "ftp://linear.app/tskr/issue/GAIA-65",
      " https://linear.app/tskr/issue/GAIA-65",
      "https://linear.app/tskr/issue/GAIA-65 ",
      "https://linear.app\\tskr\\issue\\GAIA-65",
    ]) {
      assert.throws(() => decodeUrl(rejected));
    }
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
      })
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(FactoryRelationshipTypeSchema)("blocks")
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(FactoryArtifactDto)({
        artifactId: "artifact-plan",
        contentType: "text/plain",
        createdAt: "2026-07-08T18:00:00.000Z",
        kind: "trace",
        label: "Trace",
        ownerAgentId: "agent-worker",
        visibility: "run",
      })
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
      })
    );
  });

  it("defines the issueDelivery workflow as typed code", () => {
    const definition = Schema.decodeUnknownSync(FactoryWorkflowDefinitionDto)(
      IssueDeliveryWorkflowDefinition
    );

    assert.strictEqual(definition.workflow, "issueDelivery");
    assert.strictEqual(definition.rootWorkItemKind, "issue");
    assert.deepEqual(
      definition.agentRoles.map((agent) => agent.role),
      ["orchestrator", "worker", "reviewer", "tester", "ciWatcher"]
    );
    assert.deepEqual(
      definition.relationships.map((relationship) => relationship.type),
      ["owns", "spawned", "reviewed", "tested", "watched"]
    );
  });
});

function serializableFactoryGraph() {
  return {
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
      {
        id: "edge-orchestrator-produced-plan",
        sourceId: "agent-orchestrator",
        targetId: "artifact-worker-plan",
        type: "produced",
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
        availability: "available",
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
  };
}

describe("FactoryArtifact legacy ingress", () => {
  it("defaults only pre-manifest wire artifacts and re-encodes availability", () => {
    const legacy = {
      artifactId: "artifact-worker-plan",
      contentType: "text/markdown",
      createdAt: "2026-07-08T18:00:00.000Z",
      kind: "plan",
      label: "Worker plan",
      ownerAgentId: "agent-orchestrator",
      visibility: "run",
    } as const;
    const decoded = Schema.decodeUnknownSync(LegacyFactoryArtifactIngress)(
      legacy
    );
    assert.strictEqual(decoded.availability, "available");
    assert.strictEqual(
      Schema.encodeSync(LegacyFactoryArtifactIngress)(decoded).availability,
      "available"
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(LegacyFactoryArtifactIngress)({
        ...legacy,
        customKind: "modelContextManifest",
        kind: "custom",
      })
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(FactoryArtifactSchema)({
        ...legacy,
        availability: "unavailable",
      })
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(FactoryArtifactSchema)({
        ...legacy,
        availability: "available",
        diagnostic: {
          code: "ArtifactBodyMissing",
          message: "Referenced body is missing.",
          recoverable: false,
        },
      })
    );
  });
});
