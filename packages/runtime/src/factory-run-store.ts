import {
  CreateRunRequest,
  deriveDeliveryCleanupActionHistories,
  FactoryActivityListDto,
  FactoryArtifactBodyDto,
  FactoryArtifactIdSchema,
  FactoryArtifactListDto,
  FactoryGraphDto,
  parseDeliveryRemediation,
  parseDeliveryMergeReceipt,
  parseDeliveryMergeReadinessDecision,
  parseDeliveryCleanupReceipt,
  parseHarnessEvent,
  ResolvedHarnessExecution,
  type EventType,
  type FactoryAgentRole,
  type FactoryAgentState,
  type FactoryArtifactId,
  type FactoryArtifactKind,
  type RunEvent,
  type RunId,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import { loadRun } from "./event-store.js";
import {
  issueDeliveryAgentIds,
  issueDeliveryAgentParentIds,
  issueDeliveryRootWorkItemId,
  issueDeliveryWorkflow,
} from "./factory-workflows.js";
import {
  makeRunPaths,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import type { LocalRunReadDiagnostic } from "./run-read-api.js";

export type FactoryRunCreateInput = typeof CreateRunRequest.Type;
export type FactoryGraphProjection = typeof FactoryGraphDto.Type;
export type FactoryActivityIndex = typeof FactoryActivityListDto.Type;
export type FactoryArtifactIndex = typeof FactoryArtifactListDto.Type;
export type FactoryArtifactBody = typeof FactoryArtifactBodyDto.Type;

export type FactoryProjectionIndexes = {
  readonly activity: FactoryActivityIndex;
  readonly artifacts: FactoryArtifactIndex;
  readonly graph: FactoryGraphProjection;
};

type FactoryProjectionDiagnostic = typeof FactoryGraphDto.Type["diagnostics"][number];

type StoredIndexRead<A> =
  | { readonly _tag: "missing"; readonly diagnostic: FactoryProjectionDiagnostic }
  | { readonly _tag: "stale"; readonly diagnostic: FactoryProjectionDiagnostic }
  | { readonly _tag: "unreadable"; readonly diagnostic: FactoryProjectionDiagnostic }
  | { readonly _tag: "valid"; readonly value: A };

type FactoryArtifactDefinition = {
  readonly artifactId: FactoryArtifactId;
  readonly contentType: typeof FactoryArtifactBodyDto.Type["contentType"];
  readonly eventType: EventType;
  readonly kind: FactoryArtifactKind;
  readonly label: string;
  readonly ownerRole: Extract<
    FactoryAgentRole,
    "ciWatcher" | "orchestrator" | "reviewer" | "tester" | "worker"
  >;
  readonly path: (paths: RunPaths) => string;
};

type FactoryArtifactDefinitionInput = Omit<
  FactoryArtifactDefinition,
  "artifactId"
> & {
  readonly artifactId: string;
};

const decodeCreateRunRequest = Schema.decodeUnknownSync(CreateRunRequest);
const decodeResolvedHarnessExecution = Schema.decodeUnknownSync(
  ResolvedHarnessExecution,
);
const decodeFactoryArtifactId = Schema.decodeUnknownSync(FactoryArtifactIdSchema);
const decodeFactoryGraph = Schema.decodeUnknownSync(FactoryGraphDto);
const encodeFactoryGraph = Schema.encodeSync(FactoryGraphDto);
const decodeActivityIndex = Schema.decodeUnknownSync(FactoryActivityListDto);
const encodeActivityIndex = Schema.encodeSync(FactoryActivityListDto);
const decodeArtifactIndex = Schema.decodeUnknownSync(FactoryArtifactListDto);
const encodeArtifactIndex = Schema.encodeSync(FactoryArtifactListDto);
const decodeFactoryArtifactBody = Schema.decodeUnknownSync(FactoryArtifactBodyDto);

const factoryArtifactDefinitionInputs: ReadonlyArray<FactoryArtifactDefinitionInput> = [
  {
    artifactId: "worker-plan",
    contentType: "application/json",
    eventType: "WORKER_STARTED",
    kind: "plan",
    label: "Worker plan",
    ownerRole: "worker",
    path: (paths) => paths.workerPlanResult,
  },
  {
    artifactId: "worker-plan-markdown",
    contentType: "text/markdown",
    eventType: "WORKER_STARTED",
    kind: "plan",
    label: "Worker plan markdown",
    ownerRole: "worker",
    path: (paths) => paths.workerPlanMarkdown,
  },
  {
    artifactId: "worker-log",
    contentType: "text/plain",
    eventType: "WORKER_COMPLETED",
    kind: "log",
    label: "Worker log",
    ownerRole: "worker",
    path: (paths) => paths.workerLog,
  },
  {
    artifactId: "worker-result",
    contentType: "application/json",
    eventType: "WORKER_COMPLETED",
    kind: "codeSummary",
    label: "Worker result",
    ownerRole: "worker",
    path: (paths) => paths.workerResult,
  },
  {
    artifactId: "plan-review",
    contentType: "application/json",
    eventType: "REVIEW_COMPLETED",
    kind: "review",
    label: "Plan review",
    ownerRole: "reviewer",
    path: (paths) => paths.planReviewResult,
  },
  {
    artifactId: "reviewer-findings",
    contentType: "application/json",
    eventType: "REVIEW_COMPLETED",
    kind: "review",
    label: "Reviewer findings",
    ownerRole: "reviewer",
    path: (paths) => paths.reviewerFindings,
  },
  {
    artifactId: "evidence-review",
    contentType: "application/json",
    eventType: "REVIEW_COMPLETED",
    kind: "review",
    label: "Evidence review",
    ownerRole: "reviewer",
    path: (paths) => paths.evidenceReviewResult,
  },
  {
    artifactId: "verification-result",
    contentType: "application/json",
    eventType: "VERIFICATION_COMPLETED",
    kind: "testReport",
    label: "Verification result",
    ownerRole: "tester",
    path: (paths) => paths.verificationResult,
  },
  {
    artifactId: "browser-evidence",
    contentType: "application/json",
    eventType: "BROWSER_EVIDENCE_RECORDED",
    kind: "browserEvidence",
    label: "Browser evidence",
    ownerRole: "tester",
    path: (paths) => paths.browserEvidence,
  },
  {
    artifactId: "report",
    contentType: "text/markdown",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Run report",
    ownerRole: "orchestrator",
    path: (paths) => paths.reportMarkdown,
  },
  {
    artifactId: "report-json",
    contentType: "application/json",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Run report JSON",
    ownerRole: "orchestrator",
    path: (paths) => paths.reportJson,
  },
  {
    artifactId: "factory-retro",
    contentType: "application/json",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Factory retrospective",
    ownerRole: "orchestrator",
    path: (paths) => paths.factoryRetroJson,
  },
  {
    artifactId: "factory-retro-markdown",
    contentType: "text/markdown",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Factory retrospective markdown",
    ownerRole: "orchestrator",
    path: (paths) => paths.factoryRetroMarkdown,
  },
  {
    artifactId: "factory-scorecard",
    contentType: "application/json",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Factory scorecard",
    ownerRole: "orchestrator",
    path: (paths) => paths.factoryScorecardJson,
  },
  {
    artifactId: "factory-scorecard-markdown",
    contentType: "text/markdown",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Factory scorecard markdown",
    ownerRole: "orchestrator",
    path: (paths) => paths.factoryScorecardMarkdown,
  },
];

const factoryArtifactDefinitions: ReadonlyArray<FactoryArtifactDefinition> =
  factoryArtifactDefinitionInputs.map(makeFactoryArtifactDefinition);

function makeFactoryArtifactDefinition(
  definition: FactoryArtifactDefinitionInput,
): FactoryArtifactDefinition {
  return {
    ...definition,
    artifactId: decodeFactoryArtifactId(definition.artifactId),
  };
}

export function writeInitialFactoryRunIndexes(input: {
  readonly paths: RunPaths;
  readonly runId: RunId;
}) {
  return rebuildFactoryRunIndexesFromPaths({
    additionalDiagnostics: [],
    paths: input.paths,
    runId: input.runId,
  });
}

export function readFactoryRunIndexes(
  runId: RunId,
  options: RunStorageOptions = {},
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;
    const runExists = yield* fs.exists(paths.root);
    if (!runExists) {
      return yield* Effect.fail(runNotFoundDiagnostic(runId));
    }

    const loadedExit = yield* Effect.exit(loadRun(paths));
    if (loadedExit._tag === "Failure") {
      return yield* Effect.fail(readFailureDiagnostic(runId));
    }
    if (loadedExit.value.events.length === 0) {
      return yield* Effect.fail(noEventsDiagnostic(runId));
    }

    const stored = yield* readStoredIndexes(
      paths,
      loadedExit.value.events,
      loadedExit.value.latestSnapshot?.state === "completed" &&
        deriveDeliveryCleanupActionHistories(
          loadedExit.value.events.flatMap((event) =>
            event.type === "DELIVERY_CLEANUP_RECORDED"
              ? [{ receipt: parseDeliveryCleanupReceipt(event.payload["cleanup"]), sequence: event.sequence }]
              : [],
          ),
        ).latest?.latest.state === "completed",
    );
    if (
      stored.graph._tag === "valid" &&
      stored.activity._tag === "valid" &&
      stored.artifacts._tag === "valid"
    ) {
      return {
        activity: stored.activity.value,
        artifacts: stored.artifacts.value,
        graph: stored.graph.value,
      } satisfies FactoryProjectionIndexes;
    }

    return yield* rebuildFactoryRunIndexesFromPaths({
      additionalDiagnostics: storedDiagnostics(stored),
      paths,
      runId,
    });
  });
}

export function rebuildFactoryRunIndexes(
  runId: RunId,
  options: RunStorageOptions = {},
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    return yield* rebuildFactoryRunIndexesFromPaths({
      additionalDiagnostics: [],
      paths,
      runId,
    });
  });
}

export function readFactoryArtifactBodyFromIndex(
  runId: RunId,
  artifactIdInput: string,
  options: RunStorageOptions = {},
) {
  return Effect.gen(function* () {
    const indexes = yield* readFactoryRunIndexes(runId, options);
    const artifact = indexes.artifacts.artifacts.find(
      (candidate) => candidate.artifactId === artifactIdInput,
    );
    if (artifact === undefined) {
      return yield* Effect.fail({
        artifactName: artifactIdInput,
        code: "ArtifactNotFound",
        message: "Factory artifact does not exist for this run.",
        recoverable: false,
        runId: indexes.graph.runId,
      } satisfies LocalRunReadDiagnostic);
    }

    const definition = factoryArtifactDefinitions.find(
      (candidate) => candidate.artifactId === artifactIdInput,
    );
    if (definition === undefined) {
      return yield* Effect.fail({
        artifactName: artifactIdInput,
        code: "ArtifactNotFound",
        message: "Factory artifact body is not readable by the runtime.",
        recoverable: false,
        runId: indexes.graph.runId,
      } satisfies LocalRunReadDiagnostic);
    }

    const paths = yield* makeRunPaths(indexes.graph.runId, options);
    const fs = yield* FileSystem.FileSystem;
    const bodyExit = yield* Effect.exit(fs.readFileString(definition.path(paths)));
    if (bodyExit._tag === "Failure") {
      return yield* Effect.fail({
        artifactName: artifactIdInput,
        code: "ArtifactNotFound",
        message: "Factory artifact body could not be read for this run.",
        recoverable: false,
        runId: indexes.graph.runId,
      } satisfies LocalRunReadDiagnostic);
    }

    return decodeFactoryArtifactBody({
      artifactId: artifact.artifactId,
      body: bodyExit.value,
      contentType: artifact.contentType,
      runId: indexes.graph.runId,
    });
  });
}

function rebuildFactoryRunIndexesFromPaths(input: {
  readonly additionalDiagnostics: ReadonlyArray<FactoryProjectionDiagnostic>;
  readonly paths: RunPaths;
  readonly runId: RunId;
}) {
  return Effect.gen(function* () {
    const loadedExit = yield* Effect.exit(loadRun(input.paths));
    if (loadedExit._tag === "Failure") {
      return yield* Effect.fail(readFailureDiagnostic(input.runId));
    }
    if (loadedExit.value.events.length === 0) {
      return yield* Effect.fail(noEventsDiagnostic(input.runId));
    }

    const createInput = yield* parseFactoryCreateInput(loadedExit.value.events);
    const resolvedExecution = yield* parseFactoryResolvedExecution(
      loadedExit.value.events,
    );
    const artifactResult = yield* collectFactoryArtifacts({
      events: loadedExit.value.events,
      paths: input.paths,
      runId: input.runId,
    });
    const artifactIndex = decodeArtifactIndex({
      artifacts: artifactResult.artifacts,
      runId: input.runId,
    });
    const activity = buildActivityIndex({
      artifacts: artifactIndex.artifacts,
      events: loadedExit.value.events,
      runId: input.runId,
    });
    const graph = buildFactoryGraph({
      activity,
      artifacts: artifactIndex.artifacts,
      createInput,
      diagnostics: [...input.additionalDiagnostics, ...artifactResult.diagnostics],
      events: loadedExit.value.events,
      resolvedExecution,
      runId: input.runId,
    });

    yield* writeProjectionIndexes(input.paths, {
      activity,
      artifacts: artifactIndex,
      graph,
    });
    return {
      activity,
      artifacts: artifactIndex,
      graph,
    } satisfies FactoryProjectionIndexes;
  });
}

function readStoredIndexes(
  paths: RunPaths,
  events: ReadonlyArray<RunEvent>,
  terminalDeliveryCleanupCompleted: boolean,
) {
  return Effect.gen(function* () {
    const graph = yield* readStoredJson(
      paths.factoryGraph,
      decodeFactoryGraph,
      "FactoryGraphIndexInvalid",
      "factory-graph.json",
    );
    const activity = yield* readStoredJson(
      paths.factoryActivityIndex,
      decodeActivityIndex,
      "FactoryActivityIndexInvalid",
      "activity-index.json",
    );
    const artifacts = yield* readStoredJson(
      paths.factoryArtifactsIndex,
      decodeArtifactIndex,
      "FactoryArtifactIndexInvalid",
      "artifacts/index.json",
    );

    return {
      activity: markActivityStale(
        markRunIdMismatch(activity, events[0]?.runId, "activity-index.json"),
        events.length,
      ),
      artifacts: markRunIdMismatch(
        artifacts,
        events[0]?.runId,
        "artifacts/index.json",
      ),
      graph: markTerminalDeliveryGraphStale(
        markRunIdMismatch(graph, events[0]?.runId, "factory-graph.json"),
        terminalDeliveryCleanupCompleted,
      ),
    };
  });
}

function readStoredJson<A>(
  path: string,
  decode: (input: unknown) => A,
  invalidCode: string,
  sourceId: string,
): Effect.Effect<StoredIndexRead<A>, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existsExit = yield* Effect.exit(fs.exists(path));
    if (existsExit._tag === "Failure") {
      return unreadableIndexDiagnostic(sourceId, "FactoryProjectionIndexUnreadable");
    }
    const exists = existsExit.value;
    if (!exists) {
      return {
        _tag: "missing",
        diagnostic: {
          code: "FactoryProjectionIndexMissing",
          message: `${sourceId} is missing and was rebuilt from events.jsonl.`,
          recoverable: true,
          sourceId,
        },
      };
    }

    const textExit = yield* Effect.exit(fs.readFileString(path));
    if (textExit._tag === "Failure") {
      return unreadableIndexDiagnostic(sourceId, "FactoryProjectionIndexUnreadable");
    }

    try {
      return { _tag: "valid", value: decode(JSON.parse(textExit.value)) };
    } catch {
      return unreadableIndexDiagnostic(sourceId, invalidCode);
    }
  });
}

function markActivityStale(
  read: StoredIndexRead<FactoryActivityIndex>,
  eventCount: number,
): StoredIndexRead<FactoryActivityIndex> {
  if (read._tag !== "valid" || read.value.activities.length === eventCount) {
    return read;
  }

  return {
    _tag: "stale",
    diagnostic: {
      code: "FactoryActivityIndexStale",
      message:
        "activity-index.json did not match events.jsonl and was rebuilt.",
      recoverable: true,
      sourceId: "activity-index.json",
    },
  };
}

function markTerminalDeliveryGraphStale(
  read: StoredIndexRead<FactoryGraphProjection>,
  terminalDeliveryCleanupCompleted: boolean,
): StoredIndexRead<FactoryGraphProjection> {
  if (read._tag !== "valid" || !terminalDeliveryCleanupCompleted) {
    return read;
  }

  const orchestrators = read.value.agents.filter(
    ({ role }) => role === "orchestrator",
  );
  const ciWatchers = read.value.agents.filter(
    ({ role }) => role === "ciWatcher",
  );
  const settled =
    orchestrators.length === 1 &&
    orchestrators[0]?.id === issueDeliveryAgentIds.orchestrator &&
    orchestrators[0].state === "succeeded" &&
    ciWatchers.length === 1 &&
    ciWatchers[0]?.id === issueDeliveryAgentIds.ciWatcher &&
    ciWatchers[0].state === "succeeded";
  if (settled) return read;

  return {
    _tag: "stale",
    diagnostic: {
      code: "FactoryProjectionIndexStale",
      message:
        "factory-graph.json conflicted with terminal delivery cleanup and was rebuilt from events.jsonl.",
      recoverable: true,
      sourceId: "factory-graph.json",
    },
  };
}

function markRunIdMismatch<A extends { readonly runId: RunId }>(
  read: StoredIndexRead<A>,
  runId: RunId | undefined,
  sourceId: string,
): StoredIndexRead<A> {
  if (read._tag !== "valid" || runId === undefined || read.value.runId === runId) {
    return read;
  }

  return {
    _tag: "stale",
    diagnostic: {
      code: "FactoryProjectionIndexStale",
      message: `${sourceId} belonged to another run and was rebuilt from events.jsonl.`,
      recoverable: true,
      sourceId,
    },
  };
}

function unreadableIndexDiagnostic(
  sourceId: string,
  code: string,
): StoredIndexRead<never> {
  return {
    _tag: "unreadable",
    diagnostic: {
      code,
      message: `${sourceId} could not be parsed and was rebuilt from events.jsonl.`,
      recoverable: true,
      sourceId,
    },
  };
}

function storedDiagnostics(input: {
  readonly activity: StoredIndexRead<FactoryActivityIndex>;
  readonly artifacts: StoredIndexRead<FactoryArtifactIndex>;
  readonly graph: StoredIndexRead<FactoryGraphProjection>;
}): ReadonlyArray<FactoryProjectionDiagnostic> {
  const diagnostics: Array<FactoryProjectionDiagnostic> = [];
  for (const read of [input.graph, input.activity, input.artifacts]) {
    if (read._tag !== "valid") {
      diagnostics.push(read.diagnostic);
    }
  }

  return diagnostics;
}

function writeProjectionIndexes(
  paths: RunPaths,
  indexes: FactoryProjectionIndexes,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(paths.factoryArtifactsDirectory, { recursive: true });
    yield* fs.writeFileString(
      paths.factoryGraph,
      `${JSON.stringify(encodeFactoryGraph(indexes.graph), null, 2)}\n`,
    );
    yield* fs.writeFileString(
      paths.factoryActivityIndex,
      `${JSON.stringify(encodeActivityIndex(indexes.activity), null, 2)}\n`,
    );
    yield* fs.writeFileString(
      paths.factoryArtifactsIndex,
      `${JSON.stringify(encodeArtifactIndex(indexes.artifacts), null, 2)}\n`,
    );
  });
}

function parseFactoryCreateInput(
  events: ReadonlyArray<RunEvent>,
): Effect.Effect<FactoryRunCreateInput, LocalRunReadDiagnostic> {
  const first = events[0];
  if (first === undefined) {
    return Effect.fail(noEventsDiagnostic(undefined));
  }

  try {
    return Effect.succeed(
      decodeCreateRunRequest({
        ...(first.payload["delivery"] === undefined
          ? { delivery: { mode: "local" } }
          : { delivery: publicDeliveryFromPayload(first.payload["delivery"]) }),
        execution: jsonObjectField(first.payload["execution"], "selection"),
        workflow: first.payload["workflow"],
        workItem: first.payload["workItem"],
      }),
    );
  } catch {
    return Effect.fail({
      code: "FactoryGraphNotFound",
      message:
        "Run does not contain factory workflow metadata in its authoritative RUN_CREATED event.",
      recoverable: false,
      runId: first.runId,
    } satisfies LocalRunReadDiagnostic);
  }
}

function parseFactoryResolvedExecution(
  events: ReadonlyArray<RunEvent>,
): Effect.Effect<typeof ResolvedHarnessExecution.Type, LocalRunReadDiagnostic> {
  const first = events[0];
  if (first === undefined) {
    return Effect.fail(noEventsDiagnostic(undefined));
  }
  try {
    return Effect.succeed(
      decodeResolvedHarnessExecution(
        jsonObjectField(first.payload["execution"], "resolved"),
      ),
    );
  } catch {
    return Effect.fail({
      code: "FactoryGraphNotFound",
      message:
        "Run does not contain resolved harness execution metadata in its authoritative RUN_CREATED event.",
      recoverable: false,
      runId: first.runId,
    } satisfies LocalRunReadDiagnostic);
  }
}

function jsonObjectField(
  value: Schema.Json | undefined,
  field: string,
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}

function publicDeliveryFromPayload(value: Schema.Json | undefined) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { mode: "local" };
  }
  const mode = Object.getOwnPropertyDescriptor(value, "mode")?.value;
  if (mode === "local" || mode === "pullRequest") {
    return { mode };
  }
  return { mode: "local" };
}

function buildFactoryGraph(input: {
  readonly activity: FactoryActivityIndex;
  readonly artifacts: ReadonlyArray<FactoryArtifactIndex["artifacts"][number]>;
  readonly createInput: FactoryRunCreateInput;
  readonly diagnostics: ReadonlyArray<FactoryProjectionDiagnostic>;
  readonly events: ReadonlyArray<RunEvent>;
  readonly resolvedExecution: typeof ResolvedHarnessExecution.Type;
  readonly runId: RunId;
}): FactoryGraphProjection {
  const agentStates = agentStatesFromEvents(input.events);
  const latestActivityByAgent = latestActivityIdByAgent(input.activity.activities);
  const artifactCounts = artifactCountByOwner(input.artifacts);
  const workItemId = issueDeliveryRootWorkItemId;
  const agents = issueDeliveryWorkflow.agentRoles.map((definition) => {
    const id = agentIdForRole(definition.role);
    const parentAgentId = parentAgentIdForRole(definition.role);
    return {
      artifactCount: artifactCounts.get(id) ?? 0,
      id,
      ...(latestActivityByAgent.get(id) === undefined
        ? {}
        : { latestActivityId: latestActivityByAgent.get(id) }),
      ...(parentAgentId === undefined ? {} : { parentAgentId }),
      role: definition.role,
      state: agentStates.get(definition.role) ?? "unknown",
      title: definition.title,
      workItemId,
    };
  });

  const diagnostics: Array<FactoryProjectionDiagnostic> = [...input.diagnostics];
  if ((agentStates.get("ciWatcher") ?? "unknown") === "unknown") {
    diagnostics.push({
      code: "FactoryCiWatcherUnavailable",
      message: "CI watcher state is unavailable until PR/check evidence is recorded.",
      recoverable: true,
    });
  }

  return decodeFactoryGraph({
    agents,
    diagnostics,
    edges: [
      {
        id: "edge-root-owns-orchestrator",
        sourceId: workItemId,
        targetId: issueDeliveryAgentIds.orchestrator,
        type: "owns",
      },
      {
        id: "edge-orchestrator-spawned-worker",
        sourceId: issueDeliveryAgentIds.orchestrator,
        targetId: issueDeliveryAgentIds.worker,
        type: "spawned",
      },
      {
        id: "edge-worker-reviewed-reviewer",
        sourceId: issueDeliveryAgentIds.worker,
        targetId: issueDeliveryAgentIds.reviewer,
        type: "reviewed",
      },
      {
        id: "edge-reviewer-tested-tester",
        sourceId: issueDeliveryAgentIds.reviewer,
        targetId: issueDeliveryAgentIds.tester,
        type: "tested",
      },
      {
        id: "edge-tester-watched-ci-watcher",
        sourceId: issueDeliveryAgentIds.tester,
        targetId: issueDeliveryAgentIds.ciWatcher,
        type: "watched",
      },
    ],
    execution: input.resolvedExecution,
    linkedArtifacts: input.artifacts,
    runId: input.runId,
    version: 1,
    workflow: input.createInput.workflow,
    workItems: [
      {
        description: input.createInput.workItem.description,
        externalRefs: input.createInput.workItem.externalRefs ?? [],
        id: workItemId,
        kind: input.createInput.workItem.kind,
        title: input.createInput.workItem.title,
      },
    ],
  });
}

function buildActivityIndex(input: {
  readonly artifacts: ReadonlyArray<FactoryArtifactIndex["artifacts"][number]>;
  readonly events: ReadonlyArray<RunEvent>;
  readonly runId: RunId;
}): FactoryActivityIndex {
  const artifactsByEvent = artifactsByEventType(input.artifacts);
  const states = new Map<FactoryAgentRole, FactoryAgentState>([
    ["orchestrator", "running"],
    ["worker", "pending"],
    ["reviewer", "pending"],
    ["tester", "pending"],
    ["ciWatcher", "unknown"],
  ]);
  const activities = input.events.map((event) => {
    updateStatesForEvent(states, event);
    const role = roleForEvent(event);
    const agentId = role === undefined ? undefined : agentIdForRole(role);
    const artifactIds = artifactsByEvent.get(event.type) ?? [];
    const subState = subStateForEvent(event);
    return {
      activityId: `activity-${event.sequence}`,
      artifactIds,
      kind: event.type,
      label: activityLabel(event),
      runId: input.runId,
      sequence: event.sequence,
      state: role === undefined ? "unknown" : (states.get(role) ?? "unknown"),
      timestamp: event.timestamp,
      workItemId: issueDeliveryRootWorkItemId,
      ...(agentId === undefined ? {} : { agentId }),
      ...(subState === undefined ? {} : { subState }),
    };
  });

  return decodeActivityIndex({
    activities,
    runId: input.runId,
  });
}

function agentStatesFromEvents(
  events: ReadonlyArray<RunEvent>,
): ReadonlyMap<FactoryAgentRole, FactoryAgentState> {
  const states = new Map<FactoryAgentRole, FactoryAgentState>([
    ["orchestrator", "running"],
    ["worker", "pending"],
    ["reviewer", "pending"],
    ["tester", "pending"],
    ["ciWatcher", "unknown"],
  ]);
  for (const event of events) {
    updateStatesForEvent(states, event);
  }

  return states;
}

function updateStatesForEvent(
  states: Map<FactoryAgentRole, FactoryAgentState>,
  event: RunEvent,
) {
    switch (event.type) {
    case "DELIVERY_STARTED":
      states.set("orchestrator", "running");
      return;
    case "RUN_CREATED":
    case "WORKSPACE_PREPARED":
      states.set("orchestrator", "running");
      return;
    case "REVIEW_STARTED":
      states.set("reviewer", "running");
      return;
    case "REVIEW_COMPLETED":
      states.set("reviewer", "succeeded");
      return;
    case "WORKER_STARTED":
      states.set("worker", "running");
      return;
    case "WORKER_COMPLETED":
      states.set("worker", "succeeded");
      return;
    case "HARNESS_SESSION_EVENT_RECORDED": {
      const harnessEvent = parseHarnessEvent(event.payload.event);
      if (harnessEvent.kind === "sessionFailed") {
        states.set("worker", "failed");
      } else if (harnessEvent.kind === "turnCompleted") {
        states.set(
          "worker",
          harnessEvent.status === "completed"
            ? "succeeded"
            : harnessEvent.status === "interrupted"
              ? "canceled"
              : "failed",
        );
      } else {
        states.set("worker", "running");
      }
      return;
    }
    case "VERIFICATION_STARTED":
      states.set("tester", "running");
      return;
    case "VERIFICATION_COMPLETED":
      states.set("tester", "succeeded");
      return;
    case "GITHUB_CHECKS_RECORDED":
    case "GITHUB_FEEDBACK_RECORDED":
    case "GITHUB_PR_LOOP_RECORDED":
    case "GITHUB_PR_COMMENT_RECORDED":
    case "GITHUB_REMEDIATION_SPEC_RECORDED":
      states.set("ciWatcher", "succeeded");
      return;
    case "REPORT_COMPLETED":
      states.set("orchestrator", "succeeded");
      return;
    case "DELIVERY_READY_TO_PUBLISH":
      states.set("orchestrator", "blocked");
      return;
    case "DELIVERY_PUBLICATION_INTENT_RECORDED":
    case "DELIVERY_PUBLICATION_ATTEMPTED":
      states.set("orchestrator", "running");
      return;
    case "DELIVERY_PUBLICATION_CONFIRMED":
    case "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN":
      states.set("orchestrator", "blocked");
      return;
    case "DELIVERY_PUBLICATION_FAILED":
      states.set("orchestrator", "failed");
      return;
    case "DELIVERY_REMEDIATION_RECORDED":
      states.set(
        "ciWatcher",
        parseDeliveryRemediation(event.payload["remediation"]).state === "failed"
          ? "failed"
          : "running",
      );
      return;
    case "DELIVERY_MERGE_READINESS_RECORDED":
      parseDeliveryMergeReadinessDecision(event.payload["decision"]);
      states.set("ciWatcher", "running");
      return;
    case "DELIVERY_MERGE_RECORDED": {
      const state = parseDeliveryMergeReceipt(event.payload["mergeAction"]).state;
      states.set("orchestrator", state === "dispatchFailed" ? "failed" : state === "dispatchConfirmed" ? "blocked" : "running");
      return;
    }
    case "DELIVERY_CLEANUP_RECORDED": {
      const state = parseDeliveryCleanupReceipt(event.payload["cleanup"]).state;
      states.set("orchestrator", state === "completed" ? "succeeded" : "blocked");
      if (state === "completed") states.set("ciWatcher", "succeeded");
      return;
    }
    case "DELIVERY_CLEANUP_PROVENANCE_RECORDED":
    case "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED":
    case "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED":
    case "WORKER_CONTINUATION_RECORDED":
    case "WORKER_CORRELATION_RECONCILIATION_RECORDED":
    case "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED":
      states.set("orchestrator", "running");
      return;
    case "RUN_FAILED":
      states.set("orchestrator", "failed");
      states.set(roleFromFailureStage(event.payload["stage"]), "failed");
      return;
    case "BROWSER_EVIDENCE_RECORDED":
    case "LINEAR_ISSUE_GRAPH_RECORDED":
    case "MERGE_DECISION_RECORDED":
    case "PREVIEW_DEPLOYMENT_RECORDED":
    case "REPORT_STARTED":
      return;
  }
}

function roleFromFailureStage(stage: unknown): FactoryAgentRole {
  switch (stage) {
    case "runningWorker":
      return "worker";
    case "reviewing":
      return "reviewer";
    case "verifying":
      return "tester";
    case "creating":
    case "preparingWorkspace":
    case "reporting":
    case "replaying":
    default:
      return "orchestrator";
  }
}

function roleForEvent(event: RunEvent): FactoryAgentRole | undefined {
  switch (event.type) {
    case "RUN_CREATED":
    case "DELIVERY_STARTED":
    case "WORKSPACE_PREPARED":
    case "REPORT_STARTED":
    case "REPORT_COMPLETED":
    case "DELIVERY_READY_TO_PUBLISH":
    case "DELIVERY_PUBLICATION_INTENT_RECORDED":
    case "DELIVERY_PUBLICATION_ATTEMPTED":
    case "DELIVERY_PUBLICATION_CONFIRMED":
    case "DELIVERY_PUBLICATION_FAILED":
    case "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN":
    case "DELIVERY_REMEDIATION_RECORDED":
    case "DELIVERY_PR_READY_RECORDED":
    case "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED":
    case "DELIVERY_MERGE_READINESS_RECORDED":
    case "DELIVERY_MERGE_RECORDED":
    case "DELIVERY_CLEANUP_RECORDED":
    case "DELIVERY_CLEANUP_PROVENANCE_RECORDED":
    case "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED":
    case "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED":
    case "WORKER_CONTINUATION_RECORDED":
    case "WORKER_CORRELATION_RECONCILIATION_RECORDED":
    case "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED":
      return "orchestrator";
    case "RUN_FAILED":
      return roleFromFailureStage(event.payload["stage"]);
    case "WORKER_STARTED":
    case "WORKER_COMPLETED":
    case "WORKER_RECOVERY_RECORDED":
    case "HARNESS_SESSION_EVENT_RECORDED":
      return "worker";
    case "REVIEW_STARTED":
    case "REVIEW_COMPLETED":
      return "reviewer";
    case "BROWSER_EVIDENCE_RECORDED":
    case "VERIFICATION_STARTED":
    case "VERIFICATION_COMPLETED":
      return "tester";
    case "GITHUB_CHECKS_RECORDED":
    case "GITHUB_FEEDBACK_RECORDED":
    case "GITHUB_PR_LOOP_RECORDED":
    case "GITHUB_PR_COMMENT_RECORDED":
    case "GITHUB_REMEDIATION_SPEC_RECORDED":
      return "ciWatcher";
    case "LINEAR_ISSUE_GRAPH_RECORDED":
    case "MERGE_DECISION_RECORDED":
    case "PREVIEW_DEPLOYMENT_RECORDED":
      return undefined;
  }
}

function subStateForEvent(event: RunEvent): string | undefined {
  switch (event.type) {
    case "DELIVERY_STARTED":
      return "delivering";
    case "DELIVERY_READY_TO_PUBLISH":
      return "readyToPublish";
    case "DELIVERY_PUBLICATION_INTENT_RECORDED":
    case "DELIVERY_PUBLICATION_ATTEMPTED":
      return "publishing";
    case "DELIVERY_PUBLICATION_CONFIRMED":
      return "waitingForPr";
    case "DELIVERY_PUBLICATION_FAILED":
      return "publicationFailed";
    case "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN":
      return "publicationOutcomeUnknown";
    case "DELIVERY_REMEDIATION_RECORDED":
      return "remediation";
    case "DELIVERY_PR_READY_RECORDED":
      return "readyForReview";
    case "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED":
      return "localReviewAttestation";
    case "DELIVERY_MERGE_READINESS_RECORDED":
      return "awaitingMerge";
    case "DELIVERY_MERGE_RECORDED":
      return "merging";
    case "DELIVERY_CLEANUP_RECORDED":
      return "cleanup";
    case "DELIVERY_CLEANUP_PROVENANCE_RECORDED":
    case "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED":
    case "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED":
      return "checkpoint";
    case "WORKER_RECOVERY_RECORDED":
      return "workerRecovery";
    case "WORKER_CONTINUATION_RECORDED":
      return "workerContinuation";
    case "WORKER_CORRELATION_RECONCILIATION_RECORDED":
      return "workerCorrelation";
    case "RUN_CREATED":
      return "accepted";
    case "WORKSPACE_PREPARED":
      return "workspacePrepared";
    case "REVIEW_STARTED":
    case "REVIEW_COMPLETED":
      return typeof event.payload["phase"] === "string"
        ? event.payload["phase"]
        : undefined;
    case "WORKER_STARTED":
      return "running";
    case "WORKER_COMPLETED":
      return "completed";
    case "VERIFICATION_STARTED":
      return "verifying";
    case "VERIFICATION_COMPLETED":
      return "verified";
    case "REPORT_STARTED":
      return "reporting";
    case "REPORT_COMPLETED":
      return "reported";
    case "RUN_FAILED":
      return typeof event.payload["stage"] === "string"
        ? event.payload["stage"]
        : "failed";
    case "HARNESS_SESSION_EVENT_RECORDED": {
      const harnessEvent = parseHarnessEvent(event.payload.event);
      if (harnessEvent.kind === "sessionStateChanged") {
        return harnessEvent.state;
      }
      if (harnessEvent.kind === "turnCompleted") {
        return harnessEvent.status;
      }
      return harnessEvent.kind;
    }
    default:
      return undefined;
  }
}

function activityLabel(event: RunEvent): string {
  switch (event.type) {
    case "DELIVERY_STARTED":
      return "Delivery started";
    case "DELIVERY_READY_TO_PUBLISH":
      return "Ready to publish";
    case "DELIVERY_PUBLICATION_INTENT_RECORDED":
      return "Publication intent recorded";
    case "DELIVERY_PUBLICATION_ATTEMPTED":
      return "Publication attempted";
    case "DELIVERY_PUBLICATION_CONFIRMED":
      return "Draft pull request confirmed";
    case "DELIVERY_PUBLICATION_FAILED":
      return "Publication failed";
    case "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN":
      return "Publication outcome unknown";
    case "DELIVERY_REMEDIATION_RECORDED":
      return "Delivery remediation updated";
    case "DELIVERY_PR_READY_RECORDED":
      return "Pull request ready-for-review updated";
    case "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED":
      return "Local paired-review attestation updated";
    case "DELIVERY_MERGE_READINESS_RECORDED":
      return "Delivery merge readiness recorded";
    case "DELIVERY_MERGE_RECORDED":
      return "Delivery merge updated";
    case "DELIVERY_CLEANUP_RECORDED":
      return "Delivery cleanup updated";
    case "DELIVERY_CLEANUP_PROVENANCE_RECORDED":
      return "Private cleanup provenance recorded";
    case "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED":
      return "Cleanup resource checkpoint recorded";
    case "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED":
      return "Merge provider checkpoint recorded";
    case "RUN_CREATED":
      return "Factory run accepted";
    case "WORKSPACE_PREPARED":
      return "Workspace prepared";
    case "REVIEW_STARTED":
      return "Review started";
    case "REVIEW_COMPLETED":
      return "Review completed";
    case "WORKER_STARTED":
      return "Worker started";
    case "WORKER_COMPLETED":
      return "Worker completed";
    case "WORKER_RECOVERY_RECORDED":
      return "Worker recovery updated";
    case "WORKER_CONTINUATION_RECORDED":
      return "Audited worker continuation updated";
    case "WORKER_CORRELATION_RECONCILIATION_RECORDED":
      return "Audited worker correlation reconciliation updated";
    case "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED":
      return "Audited Desktop-origin worker correlation updated";
    case "VERIFICATION_STARTED":
      return "Verification started";
    case "VERIFICATION_COMPLETED":
      return "Verification completed";
    case "BROWSER_EVIDENCE_RECORDED":
      return "Browser evidence recorded";
    case "PREVIEW_DEPLOYMENT_RECORDED":
      return "Preview deployment recorded";
    case "REPORT_STARTED":
      return "Report started";
    case "REPORT_COMPLETED":
      return "Report completed";
    case "GITHUB_CHECKS_RECORDED":
      return "GitHub checks recorded";
    case "GITHUB_FEEDBACK_RECORDED":
      return "GitHub feedback recorded";
    case "GITHUB_PR_LOOP_RECORDED":
      return "GitHub PR loop recorded";
    case "GITHUB_PR_COMMENT_RECORDED":
      return "GitHub PR comment recorded";
    case "GITHUB_REMEDIATION_SPEC_RECORDED":
      return "GitHub remediation spec recorded";
    case "LINEAR_ISSUE_GRAPH_RECORDED":
      return "Linear issue graph recorded";
    case "MERGE_DECISION_RECORDED":
      return "Merge decision recorded";
    case "HARNESS_SESSION_EVENT_RECORDED":
      return harnessActivityLabel(parseHarnessEvent(event.payload.event));
    case "RUN_FAILED":
      return "Factory run failed";
  }
}

function harnessActivityLabel(event: ReturnType<typeof parseHarnessEvent>) {
  switch (event.kind) {
    case "sessionStarted":
      return "Harness session started";
    case "sessionStateChanged":
      return "Harness session state changed";
    case "turnStarted":
      return "Harness worker turn started";
    case "itemDeltaRecorded":
    case "itemUpserted":
      return "Harness worker output updated";
    case "interactionRequested":
      return "Harness interaction requested";
    case "interactionResolved":
      return "Harness interaction resolved";
    case "interactionCancelled":
      return "Harness interaction canceled";
    case "turnCompleted":
      return `Harness worker turn ${event.status}`;
    case "sessionRecovered":
      return "Harness session recovered";
    case "sessionFailed":
      return "Harness session failed";
    case "operatorActionIntentRecorded":
      return "Operator action recorded";
    case "operatorActionDispatchAttempted":
      return "Operator action dispatched";
    case "operatorActionDispatchConfirmed":
      return "Operator action confirmed";
    case "operatorActionDispatchFailed":
      return "Operator action failed";
  }
}

function latestActivityIdByAgent(
  activities: ReadonlyArray<FactoryActivityIndex["activities"][number]>,
): ReadonlyMap<string, string> {
  const latest = new Map<string, string>();
  for (const activity of activities) {
    if (activity.agentId !== undefined) {
      latest.set(activity.agentId, activity.activityId);
    }
  }

  return latest;
}

function artifactCountByOwner(
  artifacts: ReadonlyArray<FactoryArtifactIndex["artifacts"][number]>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    counts.set(artifact.ownerAgentId, (counts.get(artifact.ownerAgentId) ?? 0) + 1);
  }

  return counts;
}

function artifactsByEventType(
  artifacts: ReadonlyArray<FactoryArtifactIndex["artifacts"][number]>,
): ReadonlyMap<EventType, ReadonlyArray<string>> {
  const byId = new Map<string, FactoryArtifactDefinition>(
    factoryArtifactDefinitions.map((definition) => [
      definition.artifactId,
      definition,
    ]),
  );
  const byEvent = new Map<EventType, Array<string>>();
  for (const artifact of artifacts) {
    const definition = byId.get(artifact.artifactId);
    if (definition === undefined) {
      continue;
    }

    const current = byEvent.get(definition.eventType) ?? [];
    current.push(artifact.artifactId);
    byEvent.set(definition.eventType, current);
  }

  return byEvent;
}

function collectFactoryArtifacts(input: {
  readonly events: ReadonlyArray<RunEvent>;
  readonly paths: RunPaths;
  readonly runId: RunId;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const artifacts = [];
    const diagnostics: Array<FactoryProjectionDiagnostic> = [];
    for (const definition of factoryArtifactDefinitions) {
      const existsExit = yield* Effect.exit(fs.exists(definition.path(input.paths)));
      if (existsExit._tag === "Failure") {
        diagnostics.push({
          code: "FactoryArtifactAvailabilityUnknown",
          message: `${definition.artifactId} artifact availability could not be checked while rebuilding the artifact index.`,
          recoverable: true,
          sourceId: definition.artifactId,
        });
        continue;
      }
      const exists = existsExit.value;
      if (!exists) {
        continue;
      }

      artifacts.push({
        artifactId: definition.artifactId,
        contentType: definition.contentType,
        createdAt: createdAtForArtifact(definition, input.events),
        kind: definition.kind,
        label: definition.label,
        ownerAgentId: agentIdForRole(definition.ownerRole),
        visibility: "run",
      });
    }

    return {
      artifacts: decodeArtifactIndex({
        artifacts,
        runId: input.runId,
      }).artifacts,
      diagnostics,
    };
  });
}

function createdAtForArtifact(
  definition: FactoryArtifactDefinition,
  events: ReadonlyArray<RunEvent>,
): string {
  return (
    events.find((event) => event.type === definition.eventType)?.timestamp ??
    events.at(-1)?.timestamp ??
    new Date(0).toISOString()
  );
}

function agentIdForRole(role: FactoryAgentRole): string {
  switch (role) {
    case "orchestrator":
      return issueDeliveryAgentIds.orchestrator;
    case "worker":
      return issueDeliveryAgentIds.worker;
    case "reviewer":
      return issueDeliveryAgentIds.reviewer;
    case "tester":
      return issueDeliveryAgentIds.tester;
    case "ciWatcher":
      return issueDeliveryAgentIds.ciWatcher;
    case "researcher":
    case "unknown":
      return `agent-${role}`;
  }
}

function parentAgentIdForRole(role: FactoryAgentRole): string | undefined {
  switch (role) {
    case "orchestrator":
      return issueDeliveryAgentParentIds.orchestrator;
    case "worker":
      return issueDeliveryAgentParentIds.worker;
    case "reviewer":
      return issueDeliveryAgentParentIds.reviewer;
    case "tester":
      return issueDeliveryAgentParentIds.tester;
    case "ciWatcher":
      return issueDeliveryAgentParentIds.ciWatcher;
    case "researcher":
    case "unknown":
      return undefined;
  }
}

function runNotFoundDiagnostic(runId: RunId): LocalRunReadDiagnostic {
  return {
    code: "RunNotFound",
    message: "Run directory does not exist.",
    recoverable: false,
    runId,
  };
}

function noEventsDiagnostic(runId: RunId | undefined): LocalRunReadDiagnostic {
  return {
    code: "RunHasNoEvents",
    message: "Run has no events.jsonl records.",
    recoverable: false,
    ...(runId === undefined ? {} : { runId }),
  };
}

function readFailureDiagnostic(runId: RunId): LocalRunReadDiagnostic {
  return {
    code: "RunUnreadable",
    message: "Run could not be read from events.jsonl.",
    recoverable: false,
    runId,
  };
}
