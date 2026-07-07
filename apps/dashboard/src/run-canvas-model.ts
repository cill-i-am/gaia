import type {
  LocalRunArtifactIdSchema,
  LocalRunSummaryDto,
  RunEvent,
} from "@gaia/core";

export type RunStatus = "running" | "reviewing" | "blocked" | "complete";

export type EvidenceTab = "summary" | "events" | "artifacts" | "raw";

export type DashboardArtifactId = typeof LocalRunArtifactIdSchema.Type;

export type RunNodeRole =
  | "orchestrator"
  | "worker"
  | "reviewer"
  | "spec"
  | "event"
  | "artifact"
  | "unknown";

export type DashboardEvent = {
  readonly id: string;
  readonly artifactHints: ReadonlyArray<DashboardArtifactId>;
  readonly payload: typeof RunEvent.Type.payload;
  readonly sequence: number;
  readonly time: string;
  readonly timestamp: string;
  readonly label: string;
  readonly tone: RunStatus;
  readonly type: typeof RunEvent.Type.type;
};

export type RunNode = {
  readonly id: string;
  readonly label: string;
  readonly role: RunNodeRole;
  readonly status: RunStatus;
  readonly summary: string;
  readonly evidence: ReadonlyArray<string>;
  readonly eventIds: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<DashboardArtifactId>;
  readonly raw: unknown;
  readonly position: {
    readonly x: number;
    readonly y: number;
  };
};

export type RunEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string;
};

export type DashboardRun = {
  readonly id: string;
  readonly title: string;
  readonly status: RunStatus;
  readonly branch: string;
  readonly updatedAt: string;
  readonly nodes: ReadonlyArray<RunNode>;
  readonly edges: ReadonlyArray<RunEdge>;
  readonly events: ReadonlyArray<DashboardEvent>;
};

export function buildRunCanvasModel(input: {
  readonly events: ReadonlyArray<RunEvent>;
  readonly run: typeof LocalRunSummaryDto.Type | undefined;
}): DashboardRun {
  if (input.run === undefined) {
    return emptyRunCanvasModel();
  }

  const nodes: Array<RunNode> = [];
  const edges: Array<RunEdge> = [];
  const rootId = `run:${input.run.runId}`;
  const status = runStatus(input.run.status);

  nodes.push({
    id: rootId,
    label: "Run root",
    role: "orchestrator",
    status,
    summary: `${input.run.runId} is ${input.run.status} in ${stateLabel(
      input.run.state,
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
      id: `${rootId}->${node.id}`,
      source: rootId,
      target: node.id,
      label: node.role === "unknown" ? "unavailable" : "supports",
    });
  }

  const eventNodes = input.events.map((event, index) =>
    eventNode(event, index),
  );
  nodes.push(...eventNodes);
  if (eventNodes[0] !== undefined) {
    edges.push({
      id: `${rootId}->${eventNodes[0].id}`,
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
        id: `${previous.id}->${next.id}`,
        source: previous.id,
        target: next.id,
        label: "then",
      });
    }
  }

  const artifactNodes = input.run.artifacts.map((artifact, index) =>
    artifactNode(artifact, index, status, input.events),
  );
  nodes.push(...artifactNodes);
  for (const node of artifactNodes) {
    const source = artifactSource(node.artifacts[0], input.events, rootId);
    edges.push({
      id: `${source}->${node.id}`,
      source,
      target: node.id,
      label: "evidence",
    });
  }

  return {
    id: input.run.runId,
    title: input.run.runId,
    status,
    branch: "Local run",
    updatedAt: input.run.updatedAt,
    nodes,
    edges,
    events: input.events.map(toDashboardEvent),
  };
}

export function getInitialNode(run: DashboardRun): RunNode | undefined {
  return run.nodes[0];
}

export function eventsForNode(
  run: DashboardRun,
  node: RunNode,
): ReadonlyArray<DashboardEvent> {
  if (node.role === "orchestrator") {
    return run.events;
  }

  const eventIds = new Set(node.eventIds);
  return run.events.filter((event) => eventIds.has(event.id));
}

export function mergeRunEvents(input: {
  readonly historical: ReadonlyArray<RunEvent>;
  readonly live: ReadonlyArray<RunEvent>;
}): ReadonlyArray<RunEvent> {
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
  return event.type === "REPORT_COMPLETED" || event.type === "RUN_FAILED";
}

export function eventTypeLabel(eventType: string) {
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

function emptyRunCanvasModel(): DashboardRun {
  return {
    id: "no-run-selected",
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
  run: typeof LocalRunSummaryDto.Type,
  events: ReadonlyArray<RunEvent>,
): ReadonlyArray<RunNode> {
  const nodes: Array<RunNode> = [];
  const artifactSet = new Set(run.artifacts);
  const eventTypes = new Set(events.map((event) => event.type));

  if (artifactSet.has("input")) {
    nodes.push({
      id: "lane:spec",
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
        .filter((event) => eventArtifactHints(event).includes("input"))
        .map(eventNodeId),
      artifacts: ["input"],
      raw: {
        artifactId: "input",
        relationshipSource: "public artifact list",
      },
      position: { x: 320, y: 30 },
    });
  }

  if (
    eventTypes.has("WORKER_STARTED") ||
    eventTypes.has("WORKER_COMPLETED") ||
    artifactSet.has("worker-plan") ||
    artifactSet.has("worker-result")
  ) {
    nodes.push({
      id: "lane:worker",
      label: "Worker lane",
      role: "worker",
      status: eventTypes.has("WORKER_COMPLETED") ? "complete" : "running",
      summary:
        "Worker activity is inferred from durable worker events and worker artifacts. No private thread identity is exposed.",
      evidence: matchingEventLabels(events, "WORKER"),
      eventIds: matchingEventIds(events, "WORKER"),
      artifacts: run.artifacts.filter((artifact) =>
        artifact.startsWith("worker"),
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
    artifactSet.has("plan-review") ||
    artifactSet.has("evidence-review") ||
    artifactSet.has("reviewer-findings")
  ) {
    nodes.push({
      id: "lane:reviewer",
      label: "Reviewer lane",
      role: "reviewer",
      status: eventTypes.has("REVIEW_COMPLETED") ? "complete" : "reviewing",
      summary:
        "Reviewer activity is inferred from review events and review artifacts. Reviewer/spec thread relationships are unavailable in the current API.",
      evidence: matchingEventLabels(events, "REVIEW"),
      eventIds: matchingEventIds(events, "REVIEW"),
      artifacts: run.artifacts.filter((artifact) =>
        artifact.includes("review"),
      ),
      raw: {
        relationshipSource: "public review events and artifacts",
      },
      position: { x: 320, y: 310 },
    });
  }

  nodes.push({
    id: "relationship:thread-identity",
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
  prefix: string,
): ReadonlyArray<string> {
  const labels = events
    .filter((event) => event.type.startsWith(prefix))
    .map((event) => `${event.sequence}: ${eventTypeLabel(event.type)}`);

  return labels.length > 0 ? labels : ["No matching event recorded"];
}

function matchingEventIds(
  events: ReadonlyArray<RunEvent>,
  prefix: string,
): ReadonlyArray<string> {
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
): RunNode {
  const column = Math.floor(index / 8);
  const row = index % 8;
  const eventIds = events
    .filter((event) => eventArtifactHints(event).includes(artifact))
    .map(eventNodeId);

  return {
    id: `artifact:${artifact}`,
    label: artifactLabel(artifact),
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
  fallback: string,
) {
  if (artifact === undefined) {
    return fallback;
  }

  const source = events.find((event) =>
    eventArtifactHints(event).includes(artifact),
  );

  return source === undefined ? fallback : eventNodeId(source);
}

function eventArtifactHints(
  event: RunEvent,
): ReadonlyArray<DashboardArtifactId> {
  switch (event.type) {
    case "RUN_CREATED":
      return ["input"];
    case "WORKER_STARTED":
      return ["worker-plan"];
    case "WORKER_COMPLETED":
      return ["worker-log", "worker-result"];
    case "REVIEW_COMPLETED":
      return event.payload["phase"] === "plan"
        ? ["plan-review"]
        : ["evidence-review", "reviewer-findings"];
    case "VERIFICATION_COMPLETED":
      return ["verification-result"];
    case "REPORT_COMPLETED":
      return ["report", "report-json"];
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

function eventNodeId(event: RunEvent) {
  return `event:${event.sequence}:${event.type}`;
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

function runStatus(status: typeof LocalRunSummaryDto.Type.status): RunStatus {
  if (status === "failed") {
    return "blocked";
  }

  if (status === "completed") {
    return "complete";
  }

  return "running";
}

function artifactLabel(artifact: string) {
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
