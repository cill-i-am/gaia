import {
  LocalRunReadArtifactIdSchema,
  LocalRunReadSummarySchema,
  RunEvent,
  parseRunControlEventPayload,
} from "@gaia/core";
import { Schema } from "effect";

export const RunStatusSchema = Schema.Literals([
  "running",
  "reviewing",
  "blocked",
  "cancelled",
  "complete",
] as const);

export type RunStatus = typeof RunStatusSchema.Type;

export const EvidenceTabSchema = Schema.Literals([
  "summary",
  "events",
  "artifacts",
  "raw",
] as const);

export type EvidenceTab = typeof EvidenceTabSchema.Type;

export const DashboardArtifactIdSchema = LocalRunReadArtifactIdSchema;

export type DashboardArtifactId = typeof DashboardArtifactIdSchema.Type;

export const RunCanvasNodeIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("RunCanvasNodeId")
);

export type RunCanvasNodeId = typeof RunCanvasNodeIdSchema.Type;

export const RunCanvasEdgeIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("RunCanvasEdgeId")
);

export type RunCanvasEdgeId = typeof RunCanvasEdgeIdSchema.Type;

export const DashboardRunIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("DashboardRunId")
);

export type DashboardRunId = typeof DashboardRunIdSchema.Type;

export const RunNodeRoleSchema = Schema.Literals([
  "orchestrator",
  "worker",
  "reviewer",
  "spec",
  "event",
  "artifact",
  "unknown",
] as const);

export type RunNodeRole = typeof RunNodeRoleSchema.Type;

const RunNodePositionSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

export const DashboardEventSchema = Schema.Struct({
  artifactHints: Schema.Array(DashboardArtifactIdSchema),
  id: RunCanvasNodeIdSchema,
  label: Schema.String,
  payload: RunEvent.fields.payload,
  sequence: RunEvent.fields.sequence,
  time: Schema.String,
  timestamp: RunEvent.fields.timestamp,
  tone: RunStatusSchema,
  type: RunEvent.fields.type,
});

class DashboardEventTypeSchema extends Schema.Class<DashboardEventTypeSchema>(
  "DashboardEventType"
)(DashboardEventSchema.fields) {}

export type DashboardEvent = DashboardEventTypeSchema;

export const RunNodeSchema = Schema.Struct({
  artifacts: Schema.Array(DashboardArtifactIdSchema),
  eventIds: Schema.Array(RunCanvasNodeIdSchema),
  evidence: Schema.Array(Schema.String),
  id: RunCanvasNodeIdSchema,
  label: Schema.String,
  position: RunNodePositionSchema,
  raw: Schema.Unknown,
  role: RunNodeRoleSchema,
  status: RunStatusSchema,
  summary: Schema.String,
});

export type RunNode = typeof RunNodeSchema.Type;

export const RunEdgeSchema = Schema.Struct({
  id: RunCanvasEdgeIdSchema,
  label: Schema.String,
  source: RunCanvasNodeIdSchema,
  target: RunCanvasNodeIdSchema,
});

export type RunEdge = typeof RunEdgeSchema.Type;

const DashboardRunUpdatedAtSchema = Schema.Union([
  LocalRunReadSummarySchema.fields.updatedAt,
  Schema.Literal(""),
]);

export const DashboardRunSchema = Schema.Struct({
  branch: Schema.String,
  edges: Schema.Array(RunEdgeSchema),
  events: Schema.Array(DashboardEventSchema),
  id: DashboardRunIdSchema,
  nodes: Schema.Array(RunNodeSchema),
  proofAggregate: Schema.optionalKey(
    LocalRunReadSummarySchema.fields.proofAggregate
  ),
  status: RunStatusSchema,
  title: Schema.String,
  updatedAt: DashboardRunUpdatedAtSchema,
});

class DashboardRunTypeSchema extends Schema.Class<DashboardRunTypeSchema>(
  "DashboardRunType"
)(DashboardRunSchema.fields) {}

export type DashboardRun = DashboardRunTypeSchema;

export const RunReplayStepSchema = Schema.Struct({
  event: DashboardEventSchema,
  index: Schema.Number,
  label: Schema.String,
  progressLabel: Schema.String,
});

class RunReplayStepTypeSchema extends Schema.Class<RunReplayStepTypeSchema>(
  "RunReplayStepType"
)(RunReplayStepSchema.fields) {}

export type RunReplayStep = RunReplayStepTypeSchema;

export const RunReplayStateSchema = Schema.Struct({
  activeEventId: Schema.optional(RunCanvasNodeIdSchema),
  activeSequence: Schema.optional(RunEvent.fields.sequence),
  currentIndex: Schema.Number,
  currentStep: Schema.optional(RunReplayStepSchema),
  futureEventIds: Schema.Array(RunCanvasNodeIdSchema),
  progressPercent: Schema.Number,
  steps: Schema.Array(RunReplayStepSchema),
  visibleArtifactIds: Schema.Array(DashboardArtifactIdSchema),
  visibleEventIds: Schema.Array(RunCanvasNodeIdSchema),
});

class RunReplayStateTypeSchema extends Schema.Class<RunReplayStateTypeSchema>(
  "RunReplayStateType"
)(RunReplayStateSchema.fields) {}

export type RunReplayState = RunReplayStateTypeSchema;

type LocalRunSummary = typeof LocalRunReadSummarySchema.Type;

const decodeDashboardArtifactId = Schema.decodeUnknownSync(
  DashboardArtifactIdSchema
);
const decodeRunCanvasNodeId = Schema.decodeUnknownSync(RunCanvasNodeIdSchema);
const decodeRunCanvasEdgeId = Schema.decodeUnknownSync(RunCanvasEdgeIdSchema);
const decodeDashboardRunId = Schema.decodeUnknownSync(DashboardRunIdSchema);

const artifactIds = Object.freeze({
  evidencePromotion: decodeDashboardArtifactId("evidence-promotion"),
  evidencePromotionMarkdown: decodeDashboardArtifactId(
    "evidence-promotion-markdown"
  ),
  evidenceReview: decodeDashboardArtifactId("evidence-review"),
  events: decodeDashboardArtifactId("events"),
  factoryRetro: decodeDashboardArtifactId("factory-retro"),
  factoryRetroMarkdown: decodeDashboardArtifactId("factory-retro-markdown"),
  factoryScorecard: decodeDashboardArtifactId("factory-scorecard"),
  factoryScorecardMarkdown: decodeDashboardArtifactId(
    "factory-scorecard-markdown"
  ),
  input: decodeDashboardArtifactId("input"),
  planReview: decodeDashboardArtifactId("plan-review"),
  report: decodeDashboardArtifactId("report"),
  reportJson: decodeDashboardArtifactId("report-json"),
  reviewerFindings: decodeDashboardArtifactId("reviewer-findings"),
  runContract: decodeDashboardArtifactId("run-contract"),
  snapshots: decodeDashboardArtifactId("snapshots"),
  verificationResult: decodeDashboardArtifactId("verification-result"),
  workerLog: decodeDashboardArtifactId("worker-log"),
  workerPlan: decodeDashboardArtifactId("worker-plan"),
  workerResult: decodeDashboardArtifactId("worker-result"),
});

const BuildRunCanvasModelInputSchema = Schema.Struct({
  events: Schema.Array(RunEvent),
  run: Schema.UndefinedOr(LocalRunReadSummarySchema),
});

const BuildRunReplayStateInputSchema = Schema.Struct({
  requestedIndex: Schema.UndefinedOr(Schema.Number),
  run: DashboardRunSchema,
});

const MergeRunEventsInputSchema = Schema.Struct({
  historical: Schema.Array(RunEvent),
  live: Schema.Array(RunEvent),
});

export function buildRunCanvasModel(
  input: typeof BuildRunCanvasModelInputSchema.Type
): DashboardRun {
  if (input.run === undefined) {
    return emptyRunCanvasModel();
  }

  const nodes: Array<RunNode> = [];
  const edges: Array<RunEdge> = [];
  const rootId = decodeRunCanvasNodeId(`run:${input.run.runId}`);
  const status = runStatus(input.run.status);

  nodes.push({
    id: rootId,
    label: "Run root",
    role: "orchestrator",
    status,
    summary: `${input.run.runId} is ${input.run.status} in ${stateLabel(
      input.run.state
    )}. The canvas is derived from public run detail, ordered events, and exposed artifact names.`,
    evidence: [
      `${input.run.eventCount} events reported by LocalGaiaServerApi`,
      `${input.run.artifacts.length} allowlisted artifacts exposed`,
      "Codex thread identities are not exposed by the current API.",
    ],
    eventIds: input.events.map(eventNodeId),
    artifacts: input.run.artifacts,
    raw: {
      run: input.run,
    },
    position: { x: 0, y: 190 },
  });

  const laneNodes = supportedLaneNodes(input.run, input.events);
  for (const node of laneNodes) {
    nodes.push(node);
    edges.push({
      id: decodeRunCanvasEdgeId(`${rootId}->${node.id}`),
      source: rootId,
      target: node.id,
      label: node.role === "unknown" ? "unavailable" : "supports",
    });
  }

  const eventNodes = input.events.map((event, index) =>
    eventNode(event, index)
  );
  nodes.push(...eventNodes);
  if (eventNodes[0] !== undefined) {
    edges.push({
      id: decodeRunCanvasEdgeId(`${rootId}->${eventNodes[0].id}`),
      source: rootId,
      target: eventNodes[0].id,
      label: "starts",
    });
  }
  for (let index = 1; index < eventNodes.length; index += 1) {
    const previous = eventNodes[index - 1];
    const next = eventNodes[index];
    if (previous !== undefined && next !== undefined) {
      edges.push({
        id: decodeRunCanvasEdgeId(`${previous.id}->${next.id}`),
        source: previous.id,
        target: next.id,
        label: "then",
      });
    }
  }

  const proofAggregate = input.run.proofAggregate;
  const artifactNodes = input.run.artifacts.map((artifact, index) =>
    artifactNode(artifact, index, status, input.events, proofAggregate)
  );
  nodes.push(...artifactNodes);
  for (const node of artifactNodes) {
    const source = artifactSource(node.artifacts[0], input.events, rootId);
    edges.push({
      id: decodeRunCanvasEdgeId(`${source}->${node.id}`),
      source,
      target: node.id,
      label: "evidence",
    });
  }

  return {
    id: decodeDashboardRunId(input.run.runId),
    title: input.run.runId,
    status,
    branch: "Local run",
    updatedAt: input.run.updatedAt,
    ...(input.run.proofAggregate === undefined
      ? {}
      : { proofAggregate: input.run.proofAggregate }),
    nodes,
    edges,
    events: input.events.map(toDashboardEvent),
  };
}

export function buildRunReplayState(
  input: typeof BuildRunReplayStateInputSchema.Type
): RunReplayState {
  const steps = input.run.events.map((event, index) => ({
    event,
    index,
    label: `${event.sequence}: ${event.label}`,
    progressLabel: `Step ${index + 1} of ${input.run.events.length}`,
  }));

  if (steps.length === 0) {
    return {
      activeEventId: undefined,
      activeSequence: undefined,
      currentIndex: 0,
      currentStep: undefined,
      futureEventIds: [],
      progressPercent: 0,
      steps,
      visibleArtifactIds: [],
      visibleEventIds: [],
    };
  }

  const currentIndex =
    input.requestedIndex === undefined
      ? steps.length - 1
      : clampIndex(input.requestedIndex, steps.length - 1);
  const currentStep = steps[currentIndex];
  const visibleSteps = steps.slice(0, currentIndex + 1);
  const futureSteps = steps.slice(currentIndex + 1);
  const visibleArtifactIds = new Set<DashboardArtifactId>();

  for (const step of visibleSteps) {
    for (const artifactId of step.event.artifactHints) {
      visibleArtifactIds.add(artifactId);
    }
  }

  return {
    activeEventId: currentStep?.event.id,
    activeSequence: currentStep?.event.sequence,
    currentIndex,
    currentStep,
    futureEventIds: futureSteps.map((step) => step.event.id),
    progressPercent:
      steps.length === 1 ? 100 : (currentIndex / (steps.length - 1)) * 100,
    steps,
    visibleArtifactIds: [...visibleArtifactIds],
    visibleEventIds: visibleSteps.map((step) => step.event.id),
  };
}

export function getInitialNode(run: DashboardRun): RunNode | undefined {
  return run.nodes[0];
}

export function eventsForNode(
  run: DashboardRun,
  node: RunNode
): ReadonlyArray<DashboardEvent> {
  if (node.role === "orchestrator") {
    return run.events;
  }

  const eventIds = new Set(node.eventIds);
  return run.events.filter((event) => eventIds.has(event.id));
}

export function mergeRunEvents(
  input: typeof MergeRunEventsInputSchema.Type
): ReadonlyArray<RunEvent> {
  const eventsByIdentity = new Map<string, RunEvent>();

  for (const event of [...input.historical, ...input.live]) {
    eventsByIdentity.set(eventIdentity(event), event);
  }

  return [...eventsByIdentity.values()].sort((left, right) => {
    const sequenceDelta = left.sequence - right.sequence;
    if (sequenceDelta !== 0) {
      return sequenceDelta;
    }

    return left.timestamp.localeCompare(right.timestamp);
  });
}

export function isTerminalRunEvent(event: RunEvent): boolean {
  if (event.type === "REPORT_COMPLETED" || event.type === "RUN_FAILED")
    return true;
  if (event.type !== "RUN_CONTROL_CONFIRMED") return false;
  try {
    return (
      parseRunControlEventPayload(event.payload["control"]).operation ===
      "cancel"
    );
  } catch {
    return false;
  }
}

export function eventTypeLabel(eventType: string) {
  if (eventType === "VERIFICATION_COMPLETED")
    return "Legacy Verification Recorded (Unverified)";
  return eventType
    .toLowerCase()
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function stateLabel(state: string) {
  return state
    .replace(/[A-Z]/gu, (match) => ` ${match}`)
    .replace(/^./u, (match) => match.toUpperCase());
}

function clampIndex(index: number, maxIndex: number) {
  if (!Number.isFinite(index)) {
    return maxIndex;
  }

  return Math.min(Math.max(Math.trunc(index), 0), maxIndex);
}

function emptyRunCanvasModel(): DashboardRun {
  return {
    id: decodeDashboardRunId("no-run-selected"),
    title: "No local run selected",
    status: "blocked",
    branch: "Local run",
    updatedAt: "",
    nodes: [],
    edges: [],
    events: [],
  };
}

function supportedLaneNodes(
  run: LocalRunSummary,
  events: ReadonlyArray<RunEvent>
): ReadonlyArray<RunNode> {
  const nodes: Array<RunNode> = [];
  const artifactSet = new Set(run.artifacts);
  const eventTypes = new Set(events.map((event) => event.type));

  if (artifactSet.has(artifactIds.input)) {
    nodes.push({
      id: decodeRunCanvasNodeId("lane:spec"),
      label: "Input spec",
      role: "spec",
      status: "complete",
      summary:
        "The public API exposes an input artifact for this run. Full spec text stays behind the allowlisted artifact read.",
      evidence: [
        "Artifact: input",
        "Relationship source: public artifact list",
      ],
      eventIds: events
        .filter((event) =>
          eventArtifactHints(event).includes(artifactIds.input)
        )
        .map(eventNodeId),
      artifacts: [artifactIds.input],
      raw: {
        artifactId: artifactIds.input,
        relationshipSource: "public artifact list",
      },
      position: { x: 320, y: 30 },
    });
  }

  if (
    eventTypes.has("WORKER_STARTED") ||
    eventTypes.has("WORKER_COMPLETED") ||
    artifactSet.has(artifactIds.workerPlan) ||
    artifactSet.has(artifactIds.workerResult)
  ) {
    nodes.push({
      id: decodeRunCanvasNodeId("lane:worker"),
      label: "Worker lane",
      role: "worker",
      status:
        run.status === "cancelled"
          ? "cancelled"
          : eventTypes.has("WORKER_COMPLETED")
            ? "complete"
            : "running",
      summary:
        "Worker activity is inferred from durable worker events and worker artifacts. No private thread identity is exposed.",
      evidence: matchingEventLabels(events, "WORKER"),
      eventIds: matchingEventIds(events, "WORKER"),
      artifacts: run.artifacts.filter((artifact) =>
        artifact.startsWith("worker")
      ),
      raw: {
        relationshipSource: "public worker events and artifacts",
      },
      position: { x: 320, y: 170 },
    });
  }

  if (
    eventTypes.has("REVIEW_STARTED") ||
    eventTypes.has("REVIEW_COMPLETED") ||
    artifactSet.has(artifactIds.planReview) ||
    artifactSet.has(artifactIds.evidenceReview) ||
    artifactSet.has(artifactIds.reviewerFindings)
  ) {
    nodes.push({
      id: decodeRunCanvasNodeId("lane:reviewer"),
      label: "Reviewer lane",
      role: "reviewer",
      status: eventTypes.has("REVIEW_COMPLETED") ? "complete" : "reviewing",
      summary:
        "Reviewer activity is inferred from review events and review artifacts. Reviewer/spec thread relationships are unavailable in the current API.",
      evidence: matchingEventLabels(events, "REVIEW"),
      eventIds: matchingEventIds(events, "REVIEW"),
      artifacts: run.artifacts.filter((artifact) =>
        artifact.includes("review")
      ),
      raw: {
        relationshipSource: "public review events and artifacts",
      },
      position: { x: 320, y: 310 },
    });
  }

  nodes.push({
    id: decodeRunCanvasNodeId("relationship:thread-identity"),
    label: "Thread identities unavailable",
    role: "unknown",
    status: "blocked",
    summary:
      "The current public API exposes run events and artifacts, not Codex thread IDs, private relationships, or chain-of-thought.",
    evidence: ["API gap: thread identity and pair metadata are not exposed"],
    eventIds: [],
    artifacts: [],
    raw: {
      unavailable: ["thread IDs", "private relationships", "chain-of-thought"],
    },
    position: { x: 320, y: 430 },
  });

  return nodes;
}

function matchingEventLabels(
  events: ReadonlyArray<RunEvent>,
  prefix: string
): ReadonlyArray<string> {
  const labels = events
    .filter((event) => event.type.startsWith(prefix))
    .map((event) => `${event.sequence}: ${eventTypeLabel(event.type)}`);

  return labels.length > 0 ? labels : ["No matching event recorded"];
}

function matchingEventIds(
  events: ReadonlyArray<RunEvent>,
  prefix: string
): ReadonlyArray<RunCanvasNodeId> {
  return events
    .filter((event) => event.type.startsWith(prefix))
    .map(eventNodeId);
}

function eventNode(event: RunEvent, index: number): RunNode {
  const column = Math.floor(index / 6);
  const row = index % 6;

  return {
    id: eventNodeId(event),
    label: eventTypeLabel(event.type),
    role: "event",
    status: eventStatus(event),
    summary: `Event ${event.sequence} was recorded at ${event.timestamp}.`,
    evidence: eventEvidence(event),
    eventIds: [eventNodeId(event)],
    artifacts: eventArtifactHints(event),
    raw: event,
    position: { x: 650 + column * 250, y: 30 + row * 86 },
  };
}

function artifactNode(
  artifact: DashboardArtifactId,
  index: number,
  status: RunStatus,
  events: ReadonlyArray<RunEvent>,
  proofAggregate: LocalRunSummary["proofAggregate"]
): RunNode {
  const column = Math.floor(index / 8);
  const row = index % 8;
  const eventIds = events
    .filter((event) => eventArtifactHints(event).includes(artifact))
    .map(eventNodeId);

  return {
    id: decodeRunCanvasNodeId(`artifact:${artifact}`),
    label: artifactLabel(artifact, events, proofAggregate),
    role: "artifact",
    status,
    summary: `${artifact} is exposed through the allowlisted local artifact API for this run.`,
    evidence: [`GET /runs/:runId/artifacts/${artifact}`],
    eventIds,
    artifacts: [artifact],
    raw: {
      artifactId: artifact,
      eventIds,
    },
    position: { x: 1_170 + column * 250, y: 30 + row * 66 },
  };
}

function artifactSource(
  artifact: DashboardArtifactId | undefined,
  events: ReadonlyArray<RunEvent>,
  fallback: RunCanvasNodeId
) {
  if (artifact === undefined) {
    return fallback;
  }

  const source = events.find((event) =>
    eventArtifactHints(event).includes(artifact)
  );

  return source === undefined ? fallback : eventNodeId(source);
}

function eventArtifactHints(
  event: RunEvent
): ReadonlyArray<DashboardArtifactId> {
  switch (event.type) {
    case "RUN_CREATED":
      return [artifactIds.input];
    case "WORKER_STARTED":
      return [artifactIds.workerPlan];
    case "RUN_CONTRACT_RECORDED":
      return [artifactIds.runContract];
    case "WORKER_COMPLETED":
      return [artifactIds.workerLog, artifactIds.workerResult];
    case "REVIEW_COMPLETED":
      return event.payload["phase"] === "plan"
        ? [artifactIds.planReview]
        : [artifactIds.evidenceReview, artifactIds.reviewerFindings];
    case "VERIFICATION_COMPLETED":
    case "RUN_PROOF_RESULT_RECORDED":
      return [artifactIds.verificationResult];
    case "REPORT_COMPLETED":
      return [artifactIds.report, artifactIds.reportJson];
    default:
      return [];
  }
}

function eventEvidence(event: RunEvent): ReadonlyArray<string> {
  const payloadKeys = Object.keys(event.payload);
  return [
    `Sequence ${event.sequence}`,
    payloadKeys.length === 0
      ? "No public payload fields"
      : `Payload fields: ${payloadKeys.join(", ")}`,
  ];
}

function eventNodeId(event: RunEvent): RunCanvasNodeId {
  return decodeRunCanvasNodeId(
    `event:${event.sequence}:${event.type}:${event.timestamp}`
  );
}

function eventIdentity(event: RunEvent) {
  return `${event.sequence}:${event.type}:${event.timestamp}`;
}

function toDashboardEvent(event: RunEvent): DashboardEvent {
  return {
    id: eventNodeId(event),
    artifactHints: eventArtifactHints(event),
    payload: event.payload,
    sequence: event.sequence,
    timestamp: event.timestamp,
    time: timeLabel(event.timestamp),
    label: eventTypeLabel(event.type),
    tone: eventStatus(event),
    type: event.type,
  };
}

function eventStatus(event: RunEvent): RunStatus {
  if (event.type === "RUN_FAILED") {
    return "blocked";
  }

  if (event.type === "REVIEW_STARTED") {
    return "reviewing";
  }

  if (event.type.endsWith("_STARTED")) {
    return "running";
  }

  return "complete";
}

function runStatus(status: LocalRunSummary["status"]): RunStatus {
  if (status === "cancelled") {
    return "cancelled";
  }
  if (status === "failed") {
    return "blocked";
  }

  if (status === "completed") {
    return "complete";
  }

  return "running";
}

function artifactLabel(
  artifact: string,
  events: ReadonlyArray<RunEvent>,
  proofAggregate: LocalRunSummary["proofAggregate"]
) {
  if (artifact === "verification-result") {
    if (events.some((event) => event.type === "RUN_PROOF_RESULT_RECORDED"))
      return "Run Proof Result";
    if (events.some((event) => event.type === "VERIFICATION_COMPLETED"))
      return "Legacy Verification Artifact (Unverified)";
    if (proofAggregate !== undefined) return "Run Proof Result";
    return "Verification Artifact (Unverified)";
  }
  return artifact
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function timeLabel(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
