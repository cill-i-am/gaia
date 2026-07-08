import type {
  DashboardArtifactId,
  DashboardEvent,
  DashboardRun,
  RunNode,
  RunReplayState,
} from "@/run-canvas-model";
import type { RunCompareModel } from "@/run-compare-model";

export type ProvenanceAvailability =
  | "supported"
  | "unavailable"
  | "unsupported";

export type ProvenanceSourceKind =
  | "api-field"
  | "artifact"
  | "derived"
  | "event"
  | "unavailable"
  | "unsupported";

export type ProvenanceSourceTarget =
  | {
      readonly type: "artifact";
      readonly artifactId: DashboardArtifactId;
    }
  | {
      readonly type: "event";
      readonly eventId: string;
    }
  | {
      readonly type: "raw";
      readonly path: string;
    };

export type ProvenanceSource = {
  readonly detail: string;
  readonly kind: ProvenanceSourceKind;
  readonly label: string;
  readonly target: ProvenanceSourceTarget | undefined;
};

export type ProvenanceClaim = {
  readonly availability: ProvenanceAvailability;
  readonly id: string;
  readonly label: string;
  readonly sources: ReadonlyArray<ProvenanceSource>;
  readonly value: string;
};

export type EvidenceProvenanceModel = {
  readonly claims: ReadonlyArray<ProvenanceClaim>;
  readonly supportedCount: number;
  readonly unavailableCount: number;
  readonly unsupportedCount: number;
};

export function buildEvidenceProvenanceModel(input: {
  readonly relatedEvents: ReadonlyArray<DashboardEvent>;
  readonly replayState: RunReplayState;
  readonly runCompare: RunCompareModel;
  readonly selectedNode: RunNode;
  readonly selectedRun: DashboardRun;
}): EvidenceProvenanceModel {
  const claims = [
    nodeStatusClaim(input.selectedNode, input.relatedEvents),
    eventCountClaim(input.selectedNode, input.relatedEvents, input.selectedRun),
    artifactCountClaim(input.selectedNode),
    replayReachabilityClaim(
      input.selectedNode,
      input.relatedEvents,
      input.replayState,
    ),
    evidenceSnippetClaim(input.selectedNode),
    ...runSignalClaims(input.selectedRun),
    runCompareClaim(input.runCompare),
    threadIdentityClaim(input.selectedNode),
  ].filter(isPresent);

  return {
    claims,
    supportedCount: claims.filter(
      (claim) => claim.availability === "supported",
    ).length,
    unavailableCount: claims.filter(
      (claim) => claim.availability === "unavailable",
    ).length,
    unsupportedCount: claims.filter(
      (claim) => claim.availability === "unsupported",
    ).length,
  };
}

function nodeStatusClaim(
  node: RunNode,
  relatedEvents: ReadonlyArray<DashboardEvent>,
): ProvenanceClaim {
  const sources = [
    apiSource({
      detail: "Status is carried from public run detail or derived from loaded public events for this node.",
      label: "Dashboard model",
      path: `nodes.${node.id}.status`,
    }),
    ...relatedEvents.slice(0, 3).map(eventSource),
  ];

  return {
    availability: "supported",
    id: `node-status:${node.id}`,
    label: node.role === "orchestrator" ? "Run status" : "Node status",
    sources,
    value: node.status,
  };
}

function eventCountClaim(
  node: RunNode,
  relatedEvents: ReadonlyArray<DashboardEvent>,
  run: DashboardRun,
): ProvenanceClaim {
  const eventSources =
    relatedEvents.length > 0
      ? relatedEvents.slice(0, 4).map(eventSource)
      : [
          unavailableSource(
            "No related ordered events are exposed for this claim.",
          ),
        ];

  return {
    availability: relatedEvents.length > 0 ? "supported" : "unavailable",
    id: `event-count:${node.id}`,
    label: "Event count",
    sources: [
      apiSource({
        detail: "Loaded through GET /runs/:runId/events and reconciled with live stream events when available.",
        label: "Public events API",
        path: `runs.${run.id}.events`,
      }),
      ...eventSources,
    ],
    value: `${relatedEvents.length} related / ${run.events.length} loaded`,
  };
}

function artifactCountClaim(node: RunNode): ProvenanceClaim {
  const sources =
    node.artifacts.length > 0
      ? node.artifacts.map(artifactSource)
      : [
          unavailableSource(
            "No allowlisted artifacts are attached to this visible claim.",
          ),
        ];

  return {
    availability: node.artifacts.length > 0 ? "supported" : "unavailable",
    id: `artifact-count:${node.id}`,
    label: "Artifact count",
    sources,
    value: `${node.artifacts.length} exposed`,
  };
}

function replayReachabilityClaim(
  node: RunNode,
  relatedEvents: ReadonlyArray<DashboardEvent>,
  replayState: RunReplayState,
): ProvenanceClaim {
  const visibleRelatedEvents = relatedEvents.filter((event) =>
    replayState.visibleEventIds.includes(event.id),
  );
  const isReached =
    relatedEvents.length === 0 || visibleRelatedEvents.length > 0;
  const currentEventSource =
    replayState.currentStep === undefined
      ? unavailableSource("No active replay event is selected.")
      : eventSource(replayState.currentStep.event);

  return {
    availability:
      replayState.currentStep === undefined ? "unavailable" : "supported",
    id: `replay:${node.id}`,
    label: "Replay reachability",
    sources: [currentEventSource],
    value: isReached ? "Reached" : "Ahead",
  };
}

function evidenceSnippetClaim(node: RunNode): ProvenanceClaim {
  if (node.evidence.length === 0) {
    return {
      availability: "unavailable",
      id: `evidence-snippets:${node.id}`,
      label: "Evidence snippets",
      sources: [
        unavailableSource(
          "The current dashboard model has no evidence notes for this node.",
        ),
      ],
      value: "No evidence notes",
    };
  }

  return {
    availability: "supported",
    id: `evidence-snippets:${node.id}`,
    label: "Evidence snippets",
    sources: node.evidence.slice(0, 3).map((item) =>
      derivedSource({
        detail: item,
        label: "Visible evidence note",
        path: `nodes.${node.id}.evidence`,
      }),
    ),
    value: `${node.evidence.length} visible notes`,
  };
}

function runSignalClaims(run: DashboardRun): ReadonlyArray<ProvenanceClaim> {
  return [
    signalClaim({
      artifactIds: ["report", "report-json"],
      eventTypes: ["REPORT_COMPLETED"],
      id: "report-signal",
      label: "Report signal",
      run,
      unavailableDetail:
        "No report artifact or report completion event is exposed for this run.",
    }),
    signalClaim({
      artifactIds: ["verification-result"],
      eventTypes: ["VERIFICATION_COMPLETED"],
      id: "check-signal",
      label: "Check signal",
      run,
      unavailableDetail:
        "No verification artifact or verification completion event is exposed for this run.",
    }),
    signalClaim({
      artifactIds: ["plan-review", "evidence-review", "reviewer-findings"],
      eventTypes: ["REVIEW_COMPLETED"],
      id: "review-signal",
      label: "Review signal",
      run,
      unavailableDetail:
        "No review artifact or review completion event is exposed for this run.",
    }),
  ];
}

function signalClaim(input: {
  readonly artifactIds: ReadonlyArray<DashboardArtifactId>;
  readonly eventTypes: ReadonlyArray<string>;
  readonly id: string;
  readonly label: string;
  readonly run: DashboardRun;
  readonly unavailableDetail: string;
}): ProvenanceClaim {
  const matchingArtifacts = [
    ...new Set(
      input.run.nodes
        .flatMap((node) => node.artifacts)
        .filter((artifactId) => input.artifactIds.includes(artifactId)),
    ),
  ];
  const matchingEvents = input.run.events.filter((event) =>
    input.eventTypes.includes(event.type),
  );
  const sources = [
    ...matchingEvents.map(eventSource),
    ...matchingArtifacts.map(artifactSource),
  ];

  if (sources.length === 0) {
    return {
      availability: "unavailable",
      id: input.id,
      label: input.label,
      sources: [unavailableSource(input.unavailableDetail)],
      value: "Unavailable",
    };
  }

  return {
    availability: "supported",
    id: input.id,
    label: input.label,
    sources,
    value: "Available",
  };
}

function runCompareClaim(runCompare: RunCompareModel): ProvenanceClaim {
  if (runCompare.primary === undefined || runCompare.comparison === undefined) {
    return {
      availability: "unavailable",
      id: "run-compare",
      label: "Run compare summary",
      sources: [
        unavailableSource(
          "Two loaded public run summaries are required before comparison claims can be proven.",
        ),
      ],
      value: "Unavailable",
    };
  }

  return {
    availability:
      runCompare.missingData.length === 0 ? "supported" : "unavailable",
    id: "run-compare",
    label: "Run compare summary",
    sources: [
      derivedSource({
        detail:
          "Comparison is derived from public run summaries plus loaded event lists for the selected primary and comparison runs.",
        label: "Compare model",
        path: "runCompare.metrics",
      }),
      ...runCompare.missingData.slice(0, 3).map((item) =>
        unavailableSource(item),
      ),
    ],
    value: runCompare.summary,
  };
}

function threadIdentityClaim(node: RunNode): ProvenanceClaim | undefined {
  if (node.id !== "relationship:thread-identity") {
    return undefined;
  }

  return {
    availability: "unsupported",
    id: "thread-identity",
    label: "Thread identity",
    sources: [
      unsupportedSource(
        "The public API does not expose Codex thread IDs, private relationships, or hidden reasoning.",
      ),
    ],
    value: "Unsupported by current public API",
  };
}

function eventSource(event: DashboardEvent): ProvenanceSource {
  return {
    detail: `Sequence ${event.sequence} from GET /runs/:runId/events.`,
    kind: "event",
    label: event.label,
    target: {
      eventId: event.id,
      type: "event",
    },
  };
}

function artifactSource(artifactId: DashboardArtifactId): ProvenanceSource {
  return {
    detail: `Allowlisted artifact read through GET /runs/:runId/artifacts/${artifactId}.`,
    kind: "artifact",
    label: artifactLabel(artifactId),
    target: {
      artifactId,
      type: "artifact",
    },
  };
}

function apiSource(input: {
  readonly detail: string;
  readonly label: string;
  readonly path: string;
}): ProvenanceSource {
  return {
    detail: input.detail,
    kind: "api-field",
    label: input.label,
    target: {
      path: input.path,
      type: "raw",
    },
  };
}

function derivedSource(input: {
  readonly detail: string;
  readonly label: string;
  readonly path: string;
}): ProvenanceSource {
  return {
    detail: input.detail,
    kind: "derived",
    label: input.label,
    target: {
      path: input.path,
      type: "raw",
    },
  };
}

function unavailableSource(detail: string): ProvenanceSource {
  return {
    detail,
    kind: "unavailable",
    label: "Unavailable",
    target: undefined,
  };
}

function unsupportedSource(detail: string): ProvenanceSource {
  return {
    detail,
    kind: "unsupported",
    label: "Unsupported",
    target: undefined,
  };
}

function artifactLabel(artifactId: string) {
  return artifactId
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
