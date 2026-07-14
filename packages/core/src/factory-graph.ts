import { Schema } from "effect";

import { ResolvedHarnessExecution } from "./harness-execution.js";
import { RunIdSchema } from "./run-id.js";

const NonNegativeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt({ identifier: "NonNegativeInteger" })),
  Schema.check(Schema.isGreaterThanOrEqualTo(0))
);

/** Factory workflow identifiers supported by the typed-code command center. */
export const FactoryWorkflowIdSchema = Schema.Literals([
  "issueDelivery",
] as const).annotate({ identifier: "FactoryWorkflowId" });

/** A supported factory workflow identifier. */
export type FactoryWorkflowId = typeof FactoryWorkflowIdSchema.Type;

/** Gaia-owned work item kinds that can appear in a factory graph. */
export const FactoryWorkItemKindSchema = Schema.Literals([
  "initiative",
  "project",
  "issue",
  "task",
] as const).annotate({ identifier: "FactoryWorkItemKind" });

/** A Gaia-owned work item kind. */
export type FactoryWorkItemKind = typeof FactoryWorkItemKindSchema.Type;

/** Agent roles available to factory workflow definitions and run graphs. */
export const FactoryAgentRoleSchema = Schema.Literals([
  "orchestrator",
  "worker",
  "reviewer",
  "tester",
  "ciWatcher",
  "researcher",
  "unknown",
] as const).annotate({ identifier: "FactoryAgentRole" });

/** A role for an agent that performs factory work. */
export type FactoryAgentRole = typeof FactoryAgentRoleSchema.Type;

/** Shared lifecycle state for every factory agent role. */
export const FactoryAgentStateSchema = Schema.Literals([
  "pending",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "canceled",
  "unknown",
] as const).annotate({ identifier: "FactoryAgentState" });

/** A shared lifecycle state for a factory agent. */
export type FactoryAgentState = typeof FactoryAgentStateSchema.Type;

/** Relationships used to connect work items, agents, and artifacts. */
export const FactoryRelationshipTypeSchema = Schema.Literals([
  "contains",
  "owns",
  "spawned",
  "assigned",
  "produced",
  "reviewed",
  "tested",
  "watched",
  "supports",
  "dependsOn",
] as const).annotate({ identifier: "FactoryRelationshipType" });

/** A supported edge relationship in a factory graph. */
export type FactoryRelationshipType = typeof FactoryRelationshipTypeSchema.Type;

/** Known artifact kinds, with `custom` reserved for named extension kinds. */
export const FactoryArtifactKindSchema = Schema.Literals([
  "plan",
  "patch",
  "codeSummary",
  "review",
  "testReport",
  "browserEvidence",
  "screenshot",
  "ciReport",
  "log",
  "runReport",
  "custom",
] as const).annotate({ identifier: "FactoryArtifactKind" });

/** A known factory artifact kind. */
export type FactoryArtifactKind = typeof FactoryArtifactKindSchema.Type;

/** Content types supported by factory artifact body reads. */
export const FactoryArtifactContentTypeSchema = Schema.Literals([
  "application/json",
  "text/markdown",
  "text/plain",
] as const).annotate({ identifier: "FactoryArtifactContentType" });

/** A supported factory artifact body content type. */
export type FactoryArtifactContentType =
  typeof FactoryArtifactContentTypeSchema.Type;

/** A parsed factory work item identifier. */
export const FactoryGraphNodeIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("FactoryGraphNodeId")
).annotate({ identifier: "FactoryGraphNodeId" });

/** A parsed factory graph node identifier. */
export type FactoryGraphNodeId = typeof FactoryGraphNodeIdSchema.Type;

/** A parsed factory work item identifier. */
export const FactoryWorkItemIdSchema = FactoryGraphNodeIdSchema.pipe(
  Schema.brand("FactoryWorkItemId")
).annotate({ identifier: "FactoryWorkItemId" });

/** A parsed factory work item identifier. */
export type FactoryWorkItemId = typeof FactoryWorkItemIdSchema.Type;

/** A parsed factory agent identifier. */
export const FactoryAgentIdSchema = FactoryGraphNodeIdSchema.pipe(
  Schema.brand("FactoryAgentId")
).annotate({ identifier: "FactoryAgentId" });

/** A parsed factory agent identifier. */
export type FactoryAgentId = typeof FactoryAgentIdSchema.Type;

/** A parsed factory artifact identifier. */
export const FactoryArtifactIdSchema = FactoryGraphNodeIdSchema.pipe(
  Schema.brand("FactoryArtifactId")
).annotate({ identifier: "FactoryArtifactId" });

/** A parsed factory artifact identifier. */
export type FactoryArtifactId = typeof FactoryArtifactIdSchema.Type;

/** A parsed factory activity identifier. */
export const FactoryActivityIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("FactoryActivityId")
).annotate({ identifier: "FactoryActivityId" });

/** A parsed factory activity identifier. */
export type FactoryActivityId = typeof FactoryActivityIdSchema.Type;

/** A parsed factory edge identifier. */
export const FactoryEdgeIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("FactoryEdgeId")
).annotate({ identifier: "FactoryEdgeId" });

/** A parsed factory edge identifier. */
export type FactoryEdgeId = typeof FactoryEdgeIdSchema.Type;

/** A parsed external reference identifier. */
export const FactoryExternalRefIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("FactoryExternalRefId")
).annotate({ identifier: "FactoryExternalRefId" });

/** A parsed external reference identifier. */
export type FactoryExternalRefId = typeof FactoryExternalRefIdSchema.Type;

/** A parsed external reference provider identifier. */
export const FactoryExternalRefProviderSchema = Schema.NonEmptyString.pipe(
  Schema.brand("FactoryExternalRefProvider")
).annotate({ identifier: "FactoryExternalRefProvider" });

/** A parsed external reference provider identifier. */
export type FactoryExternalRefProvider =
  typeof FactoryExternalRefProviderSchema.Type;

/** A source-exact absolute HTTP(S) external reference URL. */
export const FactoryExternalRefUrlSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter(isExactHttpUrl, {
      expected: "an absolute http(s) URL without whitespace or backslashes",
    })
  ),
  Schema.brand("FactoryExternalRefUrl")
).annotate({ identifier: "FactoryExternalRefUrl" });

/** A source-exact absolute HTTP(S) external reference URL. */
export type FactoryExternalRefUrl = typeof FactoryExternalRefUrlSchema.Type;

/** External system reference attached to a Gaia-owned work item. */
export class FactoryExternalRefDto extends Schema.Class<FactoryExternalRefDto>(
  "FactoryExternalRefDto"
)({
  id: FactoryExternalRefIdSchema,
  provider: FactoryExternalRefProviderSchema,
  url: Schema.optionalKey(FactoryExternalRefUrlSchema),
}) {}

/** Gaia-owned work item shown in the public factory graph. */
export class FactoryWorkItemDto extends Schema.Class<FactoryWorkItemDto>(
  "FactoryWorkItemDto"
)({
  description: Schema.optionalKey(Schema.String),
  externalRefs: Schema.Array(FactoryExternalRefDto),
  id: FactoryWorkItemIdSchema,
  kind: FactoryWorkItemKindSchema,
  parentWorkItemId: Schema.optionalKey(FactoryWorkItemIdSchema),
  title: Schema.NonEmptyString,
}) {}

/** Agent node in a factory graph, including orchestrators. */
export class FactoryAgentDto extends Schema.Class<FactoryAgentDto>(
  "FactoryAgentDto"
)({
  artifactCount: NonNegativeInteger,
  id: FactoryAgentIdSchema,
  latestActivityId: Schema.optionalKey(FactoryActivityIdSchema),
  parentAgentId: Schema.optionalKey(FactoryAgentIdSchema),
  role: FactoryAgentRoleSchema,
  state: FactoryAgentStateSchema,
  subState: Schema.optionalKey(Schema.NonEmptyString),
  title: Schema.NonEmptyString,
  workItemId: FactoryWorkItemIdSchema,
}) {}

/** Directed relationship between factory graph nodes. */
export class FactoryEdgeDto extends Schema.Class<FactoryEdgeDto>(
  "FactoryEdgeDto"
)({
  id: FactoryEdgeIdSchema,
  sourceId: FactoryGraphNodeIdSchema,
  targetId: FactoryGraphNodeIdSchema,
  type: FactoryRelationshipTypeSchema,
}) {}

/** First-class artifact metadata linked to a factory run. */
export class FactoryArtifactDto extends Schema.Class<FactoryArtifactDto>(
  "FactoryArtifactDto"
)({
  artifactId: FactoryArtifactIdSchema,
  contentType: FactoryArtifactContentTypeSchema,
  createdAt: Schema.NonEmptyString,
  customKind: Schema.optionalKey(Schema.NonEmptyString),
  kind: FactoryArtifactKindSchema,
  label: Schema.NonEmptyString,
  ownerAgentId: FactoryAgentIdSchema,
  visibility: Schema.Literal("run"),
}) {}

/** Public body returned for a factory artifact read. */
export class FactoryArtifactBodyDto extends Schema.Class<FactoryArtifactBodyDto>(
  "FactoryArtifactBodyDto"
)({
  artifactId: FactoryArtifactIdSchema,
  body: Schema.String,
  contentType: FactoryArtifactContentTypeSchema,
  runId: RunIdSchema,
}) {}

/** User-facing activity entry for a run or agent-scoped activity feed. */
export class FactoryActivityDto extends Schema.Class<FactoryActivityDto>(
  "FactoryActivityDto"
)({
  activityId: FactoryActivityIdSchema,
  agentId: Schema.optionalKey(FactoryAgentIdSchema),
  artifactIds: Schema.Array(FactoryArtifactIdSchema),
  kind: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  runId: RunIdSchema,
  sequence: NonNegativeInteger,
  state: FactoryAgentStateSchema,
  subState: Schema.optionalKey(Schema.NonEmptyString),
  timestamp: Schema.NonEmptyString,
  workItemId: Schema.optionalKey(FactoryWorkItemIdSchema),
}) {}

/** Diagnostic attached to a rebuildable factory graph projection. */
export class FactoryGraphDiagnosticDto extends Schema.Class<FactoryGraphDiagnosticDto>(
  "FactoryGraphDiagnosticDto"
)({
  code: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  recoverable: Schema.Boolean,
  sourceId: Schema.optionalKey(Schema.NonEmptyString),
}) {}

/** Public topology projection for a Gaia factory run. */
class FactoryGraphDtoBase extends Schema.Class<FactoryGraphDtoBase>(
  "FactoryGraphDto"
)({
  agents: Schema.Array(FactoryAgentDto),
  diagnostics: Schema.Array(FactoryGraphDiagnosticDto),
  edges: Schema.Array(FactoryEdgeDto),
  execution: ResolvedHarnessExecution,
  linkedArtifacts: Schema.Array(FactoryArtifactDto),
  runId: RunIdSchema,
  version: Schema.Literal(1),
  workflow: FactoryWorkflowIdSchema,
  workItems: Schema.Array(FactoryWorkItemDto),
}) {}

export const FactoryGraphDto = FactoryGraphDtoBase.pipe(
  Schema.check(Schema.makeFilter(validateFactoryGraph))
);

/** Compact work item shape used in run list/detail responses. */
export class FactoryRootWorkItemSummaryDto extends Schema.Class<FactoryRootWorkItemSummaryDto>(
  "FactoryRootWorkItemSummaryDto"
)({
  id: FactoryWorkItemIdSchema,
  kind: FactoryWorkItemKindSchema,
  title: Schema.NonEmptyString,
}) {}

function isExactHttpUrl(value: string): boolean {
  if (value.trim() !== value || /[\s\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function validateFactoryGraph(
  graph: typeof FactoryGraphDtoBase.Type
): undefined | ReadonlyArray<Schema.FilterIssue> {
  const issues: Array<Schema.FilterIssue> = [];
  const nodeCounts = new Map<FactoryGraphNodeId, number>();
  const agentIds = new Set<FactoryAgentId>();
  const addNode = (nodeId: FactoryGraphNodeId) => {
    nodeCounts.set(nodeId, (nodeCounts.get(nodeId) ?? 0) + 1);
  };

  for (const item of graph.workItems) {
    addNode(item.id);
  }
  for (const agent of graph.agents) {
    agentIds.add(agent.id);
    addNode(agent.id);
  }
  for (const artifact of graph.linkedArtifacts) {
    addNode(artifact.artifactId);
  }

  for (const [nodeId, count] of nodeCounts) {
    if (count > 1) {
      issues.push(`FactoryGraph node id is ambiguous: ${nodeId}.`);
    }
  }
  graph.edges.forEach((edge, index) => {
    if ((nodeCounts.get(edge.sourceId) ?? 0) !== 1) {
      issues.push({
        issue: "FactoryGraph edge sourceId must name exactly one graph node.",
        path: ["edges", index, "sourceId"],
      });
    }
    if ((nodeCounts.get(edge.targetId) ?? 0) !== 1) {
      issues.push({
        issue: "FactoryGraph edge targetId must name exactly one graph node.",
        path: ["edges", index, "targetId"],
      });
    }
  });
  graph.linkedArtifacts.forEach((artifact, index) => {
    if (!agentIds.has(artifact.ownerAgentId)) {
      issues.push({
        issue: "FactoryGraph artifact ownerAgentId must name an agent node.",
        path: ["linkedArtifacts", index, "ownerAgentId"],
      });
    }
  });

  return issues.length === 0 ? undefined : issues;
}

/** Compact active or terminal agent shape used in run list/detail responses. */
export class FactoryRunAgentSummaryDto extends Schema.Class<FactoryRunAgentSummaryDto>(
  "FactoryRunAgentSummaryDto"
)({
  id: FactoryAgentIdSchema,
  role: FactoryAgentRoleSchema,
  state: FactoryAgentStateSchema,
  subState: Schema.optionalKey(Schema.NonEmptyString),
  title: Schema.NonEmptyString,
}) {}

/** Count summary for a factory run projection. */
export class FactoryRunCountsDto extends Schema.Class<FactoryRunCountsDto>(
  "FactoryRunCountsDto"
)({
  activity: NonNegativeInteger,
  agents: NonNegativeInteger,
  artifacts: NonNegativeInteger,
  workItems: NonNegativeInteger,
}) {}

/** Factory-aware run summary for list responses. */
export class FactoryRunSummaryDto extends Schema.Class<FactoryRunSummaryDto>(
  "FactoryRunSummaryDto"
)({
  activeAgent: Schema.optionalKey(FactoryRunAgentSummaryDto),
  counts: FactoryRunCountsDto,
  createdAt: Schema.NonEmptyString,
  rootWorkItem: FactoryRootWorkItemSummaryDto,
  runId: RunIdSchema,
  state: FactoryAgentStateSchema,
  updatedAt: Schema.NonEmptyString,
  workflow: FactoryWorkflowIdSchema,
}) {}

/** Factory-aware run detail metadata; full topology lives on the graph endpoint. */
export class FactoryRunDetailDto extends Schema.Class<FactoryRunDetailDto>(
  "FactoryRunDetailDto"
)({
  activeAgent: Schema.optionalKey(FactoryRunAgentSummaryDto),
  counts: FactoryRunCountsDto,
  createdAt: Schema.NonEmptyString,
  execution: ResolvedHarnessExecution,
  rootWorkItem: FactoryRootWorkItemSummaryDto,
  runId: RunIdSchema,
  state: FactoryAgentStateSchema,
  updatedAt: Schema.NonEmptyString,
  urls: Schema.Struct({
    activity: Schema.NonEmptyString,
    artifacts: Schema.NonEmptyString,
    factoryGraph: Schema.NonEmptyString,
    run: Schema.NonEmptyString,
  }),
  workflow: FactoryWorkflowIdSchema,
}) {}

/** Collection response data for factory run lists. */
export class FactoryRunListDto extends Schema.Class<FactoryRunListDto>(
  "FactoryRunListDto"
)({
  diagnostics: Schema.Array(FactoryGraphDiagnosticDto),
  runs: Schema.Array(FactoryRunSummaryDto),
}) {}

/** Activity collection for a run or a single agent in a run. */
export class FactoryActivityListDto extends Schema.Class<FactoryActivityListDto>(
  "FactoryActivityListDto"
)({
  activities: Schema.Array(FactoryActivityDto),
  runId: RunIdSchema,
}) {}

/** Artifact metadata collection for a run. */
export class FactoryArtifactListDto extends Schema.Class<FactoryArtifactListDto>(
  "FactoryArtifactListDto"
)({
  artifacts: Schema.Array(FactoryArtifactDto),
  runId: RunIdSchema,
}) {}

/** Agent step inside a typed-code workflow definition. */
export class FactoryWorkflowAgentDefinitionDto extends Schema.Class<FactoryWorkflowAgentDefinitionDto>(
  "FactoryWorkflowAgentDefinitionDto"
)({
  role: FactoryAgentRoleSchema,
  title: Schema.NonEmptyString,
}) {}

/** Relationship step inside a typed-code workflow definition. */
export class FactoryWorkflowRelationshipDefinitionDto extends Schema.Class<FactoryWorkflowRelationshipDefinitionDto>(
  "FactoryWorkflowRelationshipDefinitionDto"
)({
  sourceRole: FactoryAgentRoleSchema,
  targetRole: FactoryAgentRoleSchema,
  type: FactoryRelationshipTypeSchema,
}) {}

/** Typed-code workflow definition contract for phase-one factory runs. */
export class FactoryWorkflowDefinitionDto extends Schema.Class<FactoryWorkflowDefinitionDto>(
  "FactoryWorkflowDefinitionDto"
)({
  agentRoles: Schema.Array(FactoryWorkflowAgentDefinitionDto),
  expectedArtifactKinds: Schema.Array(FactoryArtifactKindSchema),
  relationships: Schema.Array(FactoryWorkflowRelationshipDefinitionDto),
  rootWorkItemKind: Schema.Literal("issue"),
  workflow: FactoryWorkflowIdSchema,
}) {}

/** The phase-one typed-code issue delivery workflow definition. */
export const IssueDeliveryWorkflowDefinition =
  FactoryWorkflowDefinitionDto.make({
    agentRoles: [
      { role: "orchestrator", title: "Issue orchestrator" },
      { role: "worker", title: "Worker" },
      { role: "reviewer", title: "Reviewer" },
      { role: "tester", title: "Tester" },
      { role: "ciWatcher", title: "CI watcher" },
    ],
    expectedArtifactKinds: [
      "plan",
      "patch",
      "codeSummary",
      "review",
      "testReport",
      "browserEvidence",
      "screenshot",
      "ciReport",
      "log",
      "runReport",
    ],
    relationships: [
      {
        sourceRole: "orchestrator",
        targetRole: "orchestrator",
        type: "owns",
      },
      { sourceRole: "orchestrator", targetRole: "worker", type: "spawned" },
      { sourceRole: "worker", targetRole: "reviewer", type: "reviewed" },
      { sourceRole: "reviewer", targetRole: "tester", type: "tested" },
      { sourceRole: "tester", targetRole: "ciWatcher", type: "watched" },
    ],
    rootWorkItemKind: "issue",
    workflow: "issueDelivery",
  });
