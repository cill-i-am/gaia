import { createHash } from "node:crypto";

import {
  CreateRunRequest,
  deriveDeliveryCleanupActionHistories,
  FactoryActivityListDto,
  FactoryAgentRoleSchema,
  FactoryArtifactDto,
  FactoryArtifactBodyDto,
  FactoryArtifactIdSchema,
  FactoryArtifactListDto,
  FactoryGraphDiagnosticDto,
  FactoryGraphDto,
  RunIdSchema,
  parseLocalRunArtifactName,
  parseLocalRunReadDiagnostic,
  parseDeliveryRemediation,
  parseDeliveryMergeReceipt,
  parseDeliveryMergeReadinessDecision,
  parseDeliveryCleanupReceipt,
  parseHarnessEvent,
  parseRunProofResult,
  RunProofProjectionV1Schema,
  ResolvedHarnessExecution,
  RunEvent,
  snapshotFromReplay,
  type EventType,
  type FactoryActivityId,
  type FactoryAgentId,
  type FactoryAgentRole,
  type FactoryAgentState,
  type FactoryArtifactId,
  type FactoryArtifactKind,
  type LocalRunReadDiagnostic,
  type RunId,
} from "@gaia/core";
import { Effect, FileSystem, Option, Schema } from "effect";

import {
  issueDeliveryAgentIds,
  issueDeliveryAgentParentIds,
  issueDeliveryRootWorkItemId,
  issueDeliveryWorkflow,
} from "./factory-workflows.js";
import {
  makeRunPaths,
  RunPathsSchema,
  type RunPaths,
  type RunStorageOptions,
  type RuntimePath,
} from "./paths.js";
import {
  canonicalRunContractBody,
  canonicalRunProofResultBody,
  synchronizeEventOwnedRunProjections,
} from "./run-contract.js";

export type FactoryRunCreateInput = typeof CreateRunRequest.Type;
class FactoryGraphProjectionSchema extends Schema.Class<FactoryGraphProjectionSchema>(
  "FactoryGraphProjection"
)({
  ...FactoryGraphDto.from.fields,
}) {}
class FactoryActivityIndexSchema extends Schema.Class<FactoryActivityIndexSchema>(
  "FactoryActivityIndex"
)({
  ...FactoryActivityListDto.fields,
}) {}
class FactoryArtifactIndexSchema extends Schema.Class<FactoryArtifactIndexSchema>(
  "FactoryArtifactIndex"
)({
  ...FactoryArtifactListDto.fields,
}) {}
class FactoryArtifactBodySchema extends Schema.Class<FactoryArtifactBodySchema>(
  "FactoryArtifactBody"
)({
  ...FactoryArtifactBodyDto.fields,
}) {}

export type FactoryGraphProjection = FactoryGraphProjectionSchema;
export type FactoryActivityIndex = FactoryActivityIndexSchema;
export type FactoryArtifactIndex = FactoryArtifactIndexSchema;
export type FactoryArtifactBody = FactoryArtifactBodySchema;

class FactoryProjectionIndexesSchema extends Schema.Class<FactoryProjectionIndexesSchema>(
  "FactoryProjectionIndexes"
)({
  activity: FactoryActivityIndexSchema,
  artifacts: FactoryArtifactIndexSchema,
  graph: FactoryGraphProjectionSchema,
}) {}

export type FactoryProjectionIndexes = FactoryProjectionIndexesSchema;

type FactoryProjectionDiagnostic = Schema.Schema.Type<
  typeof FactoryGraphDiagnosticDto
>;
type FactoryProjectionDiagnosticCode =
  (typeof FactoryGraphDiagnosticDto.Type)["code"];
type FactoryProjectionDiagnosticSourceId = NonNullable<
  (typeof FactoryGraphDiagnosticDto.Type)["sourceId"]
>;

const StoredIndexFailureKindSchema = Schema.Literals([
  "decode",
  "parse",
  "read",
]);
type StoredIndexFailureKind = Schema.Schema.Type<
  typeof StoredIndexFailureKindSchema
>;

const StoredIndexMissingSchema = Schema.Struct({
  _tag: Schema.Literal("missing"),
  diagnostic: FactoryGraphDiagnosticDto,
});
const StoredIndexStaleSchema = Schema.Struct({
  _tag: Schema.Literal("stale"),
  diagnostic: FactoryGraphDiagnosticDto,
});
const StoredIndexUnreadableSchema = Schema.Struct({
  _tag: Schema.Literal("unreadable"),
  diagnostic: FactoryGraphDiagnosticDto,
  failureKind: StoredIndexFailureKindSchema,
});
const FactoryGraphStoredIndexReadSchema = Schema.Union([
  StoredIndexMissingSchema,
  StoredIndexStaleSchema,
  StoredIndexUnreadableSchema,
  Schema.Struct({ _tag: Schema.Literal("valid"), value: FactoryGraphDto }),
]);
const FactoryActivityStoredIndexReadSchema = Schema.Union([
  StoredIndexMissingSchema,
  StoredIndexStaleSchema,
  StoredIndexUnreadableSchema,
  Schema.Struct({
    _tag: Schema.Literal("valid"),
    value: FactoryActivityListDto,
  }),
]);
const FactoryArtifactStoredIndexReadSchema = Schema.Union([
  StoredIndexMissingSchema,
  StoredIndexStaleSchema,
  StoredIndexUnreadableSchema,
  Schema.Struct({
    _tag: Schema.Literal("valid"),
    value: FactoryArtifactListDto,
  }),
]);

type StoredIndexUnreadable = typeof StoredIndexUnreadableSchema.Type;

const FactoryArtifactOwnerRoleSchema = Schema.Literals(
  FactoryAgentRoleSchema.literals.filter(
    (role) => role !== "researcher" && role !== "unknown"
  )
);

const FactoryArtifactDefinitionDataSchema = Schema.Struct({
  artifactId: FactoryArtifactIdSchema,
  contentType: FactoryArtifactBodyDto.fields.contentType,
  eventType: RunEvent.fields.type,
  kind: FactoryArtifactDto.fields.kind,
  label: FactoryArtifactDto.fields.label,
  ownerRole: FactoryArtifactOwnerRoleSchema,
});

type FactoryArtifactDefinition = Schema.Schema.Type<
  typeof FactoryArtifactDefinitionDataSchema
> & {
  readonly path: (paths: RunPaths) => RuntimePath;
};

const WriteInitialFactoryRunIndexesInputSchema = Schema.Struct({
  paths: RunPathsSchema,
  runId: RunIdSchema,
});
const RebuildFactoryRunIndexesFromPathsInputSchema = Schema.Struct({
  additionalDiagnostics: Schema.Array(FactoryGraphDiagnosticDto),
  paths: RunPathsSchema,
  runId: RunIdSchema,
});
const StoredFactoryIndexesSchema = Schema.Struct({
  activity: FactoryActivityStoredIndexReadSchema,
  artifacts: FactoryArtifactStoredIndexReadSchema,
  graph: FactoryGraphStoredIndexReadSchema,
});
const FactoryProjectionEnvelopeV2Schema = Schema.Struct({
  kind: Schema.Literals(["activity", "artifacts", "graph"] as const),
  sourceEventsDigest: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
  ),
  sourceEventCount: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  sourceLastEventSequence: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  value: Schema.Unknown,
  version: Schema.Literal(2),
});
type FactoryProjectionEnvelopeKind =
  typeof FactoryProjectionEnvelopeV2Schema.Type.kind;
const BuildFactoryGraphInputSchema = Schema.Struct({
  activity: FactoryActivityListDto,
  artifacts: Schema.Array(FactoryArtifactDto),
  createInput: CreateRunRequest,
  diagnostics: Schema.Array(FactoryGraphDiagnosticDto),
  events: Schema.Array(RunEvent),
  resolvedExecution: ResolvedHarnessExecution,
  runId: RunIdSchema,
});
const BuildActivityIndexInputSchema = Schema.Struct({
  artifacts: Schema.Array(FactoryArtifactDto),
  events: Schema.Array(RunEvent),
  runId: RunIdSchema,
});
const CollectFactoryArtifactsInputSchema = Schema.Struct({
  events: Schema.Array(RunEvent),
  paths: RunPathsSchema,
  runId: RunIdSchema,
});

const decodeCreateRunRequest = Schema.decodeUnknownSync(CreateRunRequest);
const decodeResolvedHarnessExecution = Schema.decodeUnknownSync(
  ResolvedHarnessExecution
);
const decodeFactoryArtifactId = Schema.decodeUnknownSync(
  FactoryArtifactIdSchema
);
const decodeFactoryAgentId = Schema.decodeUnknownSync(
  FactoryArtifactDto.fields.ownerAgentId
);
const decodeRunEventTimestamp = Schema.decodeUnknownSync(
  RunEvent.fields.timestamp
);
const decodeFactoryGraph = Schema.decodeUnknownSync(FactoryGraphDto);
const encodeFactoryGraph = Schema.encodeSync(FactoryGraphDto);
const decodeActivityIndex = Schema.decodeUnknownSync(FactoryActivityListDto);
const encodeActivityIndex = Schema.encodeSync(FactoryActivityListDto);
const decodeArtifactIndex = Schema.decodeUnknownSync(FactoryArtifactListDto);
const encodeArtifactIndex = Schema.encodeSync(FactoryArtifactListDto);
const decodeFactoryArtifactBody = Schema.decodeUnknownSync(
  FactoryArtifactBodyDto
);

const factoryArtifactDefinitions: ReadonlyArray<FactoryArtifactDefinition> = [
  {
    artifactId: decodeFactoryArtifactId("worker-plan"),
    contentType: "application/json",
    eventType: "WORKER_STARTED",
    kind: "plan",
    label: "Worker plan",
    ownerRole: "worker",
    path: (paths) => paths.workerPlanResult,
  },
  {
    artifactId: decodeFactoryArtifactId("worker-plan-markdown"),
    contentType: "text/markdown",
    eventType: "WORKER_STARTED",
    kind: "plan",
    label: "Worker plan markdown",
    ownerRole: "worker",
    path: (paths) => paths.workerPlanMarkdown,
  },
  {
    artifactId: decodeFactoryArtifactId("worker-log"),
    contentType: "text/plain",
    eventType: "WORKER_COMPLETED",
    kind: "log",
    label: "Worker log",
    ownerRole: "worker",
    path: (paths) => paths.workerLog,
  },
  {
    artifactId: decodeFactoryArtifactId("worker-result"),
    contentType: "application/json",
    eventType: "WORKER_COMPLETED",
    kind: "codeSummary",
    label: "Worker result",
    ownerRole: "worker",
    path: (paths) => paths.workerResult,
  },
  {
    artifactId: decodeFactoryArtifactId("plan-review"),
    contentType: "application/json",
    eventType: "REVIEW_COMPLETED",
    kind: "review",
    label: "Plan review",
    ownerRole: "reviewer",
    path: (paths) => paths.planReviewResult,
  },
  {
    artifactId: decodeFactoryArtifactId("reviewer-findings"),
    contentType: "application/json",
    eventType: "REVIEW_COMPLETED",
    kind: "review",
    label: "Reviewer findings",
    ownerRole: "reviewer",
    path: (paths) => paths.reviewerFindings,
  },
  {
    artifactId: decodeFactoryArtifactId("evidence-review"),
    contentType: "application/json",
    eventType: "REVIEW_COMPLETED",
    kind: "review",
    label: "Evidence review",
    ownerRole: "reviewer",
    path: (paths) => paths.evidenceReviewResult,
  },
  {
    artifactId: decodeFactoryArtifactId("run-contract"),
    contentType: "application/json",
    eventType: "RUN_CONTRACT_RECORDED",
    kind: "custom",
    label: "Run contract",
    ownerRole: "orchestrator",
    path: (paths) => paths.runContract,
  },
  {
    artifactId: decodeFactoryArtifactId("verification-result"),
    contentType: "application/json",
    eventType: "RUN_PROOF_RESULT_RECORDED",
    kind: "testReport",
    label: "Run proof result",
    ownerRole: "tester",
    path: (paths) => paths.verificationResult,
  },
  {
    artifactId: decodeFactoryArtifactId("browser-evidence"),
    contentType: "application/json",
    eventType: "BROWSER_EVIDENCE_RECORDED",
    kind: "browserEvidence",
    label: "Browser evidence",
    ownerRole: "tester",
    path: (paths) => paths.browserEvidence,
  },
  {
    artifactId: decodeFactoryArtifactId("report"),
    contentType: "text/markdown",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Run report",
    ownerRole: "orchestrator",
    path: (paths) => paths.reportMarkdown,
  },
  {
    artifactId: decodeFactoryArtifactId("report-json"),
    contentType: "application/json",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Run report JSON",
    ownerRole: "orchestrator",
    path: (paths) => paths.reportJson,
  },
  {
    artifactId: decodeFactoryArtifactId("factory-retro"),
    contentType: "application/json",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Factory retrospective",
    ownerRole: "orchestrator",
    path: (paths) => paths.factoryRetroJson,
  },
  {
    artifactId: decodeFactoryArtifactId("factory-retro-markdown"),
    contentType: "text/markdown",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Factory retrospective markdown",
    ownerRole: "orchestrator",
    path: (paths) => paths.factoryRetroMarkdown,
  },
  {
    artifactId: decodeFactoryArtifactId("factory-scorecard"),
    contentType: "application/json",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Factory scorecard",
    ownerRole: "orchestrator",
    path: (paths) => paths.factoryScorecardJson,
  },
  {
    artifactId: decodeFactoryArtifactId("factory-scorecard-markdown"),
    contentType: "text/markdown",
    eventType: "REPORT_COMPLETED",
    kind: "runReport",
    label: "Factory scorecard markdown",
    ownerRole: "orchestrator",
    path: (paths) => paths.factoryScorecardMarkdown,
  },
];

export function writeInitialFactoryRunIndexes(
  input: Schema.Schema.Type<typeof WriteInitialFactoryRunIndexesInputSchema>
) {
  return rebuildFactoryRunIndexesFromPaths({
    additionalDiagnostics: [],
    paths: input.paths,
    runId: input.runId,
  });
}

export function readFactoryRunIndexes(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;
    const runExists = yield* fs.exists(paths.root);
    if (!runExists) {
      return yield* Effect.fail(runNotFoundDiagnostic(runId));
    }

    const synchronizedExit = yield* Effect.exit(
      synchronizeEventOwnedRunProjections(paths, runId)
    );
    if (synchronizedExit._tag === "Failure") {
      return yield* Effect.fail(readFailureDiagnostic(runId));
    }
    if (synchronizedExit.value.events.length === 0) {
      return yield* Effect.fail(noEventsDiagnostic(runId));
    }
    const latestSnapshot = snapshotFromReplay(synchronizedExit.value.events);

    const stored = yield* readStoredIndexes(
      paths,
      synchronizedExit.value.events,
      latestSnapshot.state === "completed" &&
        deriveDeliveryCleanupActionHistories(
          synchronizedExit.value.events.flatMap((event) =>
            event.type === "DELIVERY_CLEANUP_RECORDED"
              ? [
                  {
                    receipt: parseDeliveryCleanupReceipt(
                      event.payload["cleanup"]
                    ),
                    sequence: event.sequence,
                  },
                ]
              : []
          )
        ).latest?.latest.state === "completed"
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
  options: RunStorageOptions = {}
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
  artifactIdInput: FactoryArtifactId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const indexes = yield* readFactoryRunIndexes(runId, options);
    const artifact = indexes.artifacts.artifacts.find(
      (candidate) => candidate.artifactId === artifactIdInput
    );
    if (artifact === undefined) {
      return yield* Effect.fail(
        parseLocalRunReadDiagnostic({
          artifactName: parseLocalRunArtifactName(artifactIdInput),
          code: "ArtifactNotFound",
          message: "Factory artifact does not exist for this run.",
          recoverable: false,
          runId: indexes.graph.runId,
        })
      );
    }

    const definition = factoryArtifactDefinitions.find(
      (candidate) => candidate.artifactId === artifactIdInput
    );
    if (definition === undefined) {
      return yield* Effect.fail(
        parseLocalRunReadDiagnostic({
          artifactName: parseLocalRunArtifactName(artifactIdInput),
          code: "ArtifactNotFound",
          message: "Factory artifact body is not readable by the runtime.",
          recoverable: false,
          runId: indexes.graph.runId,
        })
      );
    }

    const paths = yield* makeRunPaths(indexes.graph.runId, options);
    const synchronized = yield* synchronizeEventOwnedRunProjections(
      paths,
      indexes.graph.runId
    );
    const eventOwnedBody =
      artifactIdInput === "run-contract" && synchronized.contract !== undefined
        ? canonicalRunContractBody(synchronized.contract)
        : artifactIdInput === "verification-result" &&
            synchronized.proofResult !== undefined
          ? canonicalRunProofResultBody(synchronized.proofResult)
          : undefined;
    if (eventOwnedBody !== undefined)
      return decodeFactoryArtifactBody({
        artifactId: artifact.artifactId,
        body: eventOwnedBody,
        contentType: artifact.contentType,
        runId: indexes.graph.runId,
      });
    const fs = yield* FileSystem.FileSystem;
    const bodyExit = yield* Effect.exit(
      fs.readFileString(definition.path(paths))
    );
    if (bodyExit._tag === "Failure") {
      return yield* Effect.fail(
        parseLocalRunReadDiagnostic({
          artifactName: parseLocalRunArtifactName(artifactIdInput),
          code: "ArtifactNotFound",
          message: "Factory artifact body could not be read for this run.",
          recoverable: false,
          runId: indexes.graph.runId,
        })
      );
    }

    return decodeFactoryArtifactBody({
      artifactId: artifact.artifactId,
      body: bodyExit.value,
      contentType: artifact.contentType,
      runId: indexes.graph.runId,
    });
  });
}

function rebuildFactoryRunIndexesFromPaths(
  input: Schema.Schema.Type<typeof RebuildFactoryRunIndexesFromPathsInputSchema>
) {
  return Effect.gen(function* () {
    const synchronizedExit = yield* Effect.exit(
      synchronizeEventOwnedRunProjections(input.paths, input.runId)
    );
    if (synchronizedExit._tag === "Failure") {
      return yield* Effect.fail(readFailureDiagnostic(input.runId));
    }
    if (synchronizedExit.value.events.length === 0) {
      return yield* Effect.fail(noEventsDiagnostic(input.runId));
    }

    const createInput = yield* parseFactoryCreateInput(
      synchronizedExit.value.events
    );
    const resolvedExecution = yield* parseFactoryResolvedExecution(
      synchronizedExit.value.events
    );
    const artifactResult = yield* collectFactoryArtifacts({
      events: synchronizedExit.value.events,
      paths: input.paths,
      runId: input.runId,
    });
    const artifactIndex = decodeArtifactIndex({
      artifacts: artifactResult.artifacts,
      runId: input.runId,
    });
    const activity = buildActivityIndex({
      artifacts: artifactIndex.artifacts,
      events: synchronizedExit.value.events,
      runId: input.runId,
    });
    const graph = buildFactoryGraph({
      activity,
      artifacts: artifactIndex.artifacts,
      createInput,
      diagnostics: [
        ...input.additionalDiagnostics,
        ...artifactResult.diagnostics,
      ],
      events: synchronizedExit.value.events,
      resolvedExecution,
      runId: input.runId,
    });

    yield* writeProjectionIndexes(
      input.paths,
      { activity, artifacts: artifactIndex, graph },
      synchronizedExit.value.events
    );
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
  terminalDeliveryCleanupCompleted: boolean
) {
  return Effect.gen(function* () {
    const graph = yield* readStoredJson(
      paths.factoryGraph,
      decodeFactoryGraph,
      FactoryGraphStoredIndexReadSchema,
      "FactoryGraphIndexInvalid",
      "factory-graph.json",
      "graph",
      events
    );
    const activity = yield* readStoredJson(
      paths.factoryActivityIndex,
      decodeActivityIndex,
      FactoryActivityStoredIndexReadSchema,
      "FactoryActivityIndexInvalid",
      "activity-index.json",
      "activity",
      events
    );
    const artifacts = yield* readStoredJson(
      paths.factoryArtifactsIndex,
      decodeArtifactIndex,
      FactoryArtifactStoredIndexReadSchema,
      "FactoryArtifactIndexInvalid",
      "artifacts/index.json",
      "artifacts",
      events
    );

    return {
      activity: markActivityStale(
        markRunIdMismatch(activity, events[0]?.runId, "activity-index.json"),
        events.length
      ),
      artifacts: markRunIdMismatch(
        artifacts,
        events[0]?.runId,
        "artifacts/index.json"
      ),
      graph: markTerminalDeliveryGraphStale(
        markRunIdMismatch(graph, events[0]?.runId, "factory-graph.json"),
        terminalDeliveryCleanupCompleted
      ),
    };
  });
}

function readStoredJson<
  Value,
  StoredIndexSchema extends Schema.ConstraintDecoder<unknown>,
>(
  path: RuntimePath,
  decode: (input: unknown) => Value,
  storedIndexSchema: StoredIndexSchema,
  invalidCode: FactoryProjectionDiagnosticCode,
  sourceId: FactoryProjectionDiagnosticSourceId,
  expectedKind: FactoryProjectionEnvelopeKind,
  events: ReadonlyArray<RunEvent>
): Effect.Effect<StoredIndexSchema["Type"], never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const parseStoredIndex = Schema.decodeUnknownSync(storedIndexSchema);
    const fs = yield* FileSystem.FileSystem;
    const existsExit = yield* Effect.exit(fs.exists(path));
    if (existsExit._tag === "Failure") {
      return parseStoredIndex(
        unreadableIndexDiagnostic(
          sourceId,
          "FactoryProjectionIndexUnreadable",
          "read"
        )
      );
    }
    const exists = existsExit.value;
    if (!exists) {
      return parseStoredIndex({
        _tag: "missing",
        diagnostic: {
          code: "FactoryProjectionIndexMissing",
          message: `${sourceId} is missing and was rebuilt from events.jsonl.`,
          recoverable: true,
          sourceId,
        },
      });
    }

    const textExit = yield* Effect.exit(fs.readFileString(path));
    if (textExit._tag === "Failure") {
      return parseStoredIndex(
        unreadableIndexDiagnostic(
          sourceId,
          "FactoryProjectionIndexUnreadable",
          "read"
        )
      );
    }

    try {
      const parsed = JSON.parse(textExit.value);
      const envelope = Schema.decodeUnknownOption(
        FactoryProjectionEnvelopeV2Schema
      )(parsed);
      const expectedSequence = events.at(-1)?.sequence;
      if (
        Option.isNone(envelope) ||
        envelope.value.kind !== expectedKind ||
        envelope.value.sourceEventCount !== events.length ||
        envelope.value.sourceLastEventSequence !== expectedSequence ||
        envelope.value.sourceEventsDigest !== sourceEventsDigest(events)
      )
        return parseStoredIndex({
          _tag: "stale",
          diagnostic: {
            code: "FactoryProjectionIndexStale",
            message: `${sourceId} used a stale projection envelope and was rebuilt from events.jsonl.`,
            recoverable: true,
            sourceId,
          },
        });
      try {
        return parseStoredIndex({
          _tag: "valid",
          value: decode(envelope.value.value),
        });
      } catch {
        return parseStoredIndex(
          unreadableIndexDiagnostic(sourceId, invalidCode, "decode")
        );
      }
    } catch {
      return parseStoredIndex(
        unreadableIndexDiagnostic(sourceId, invalidCode, "parse")
      );
    }
  });
}

function markActivityStale(
  read: typeof FactoryActivityStoredIndexReadSchema.Type,
  eventCount: number
): typeof FactoryActivityStoredIndexReadSchema.Type {
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
  read: typeof FactoryGraphStoredIndexReadSchema.Type,
  terminalDeliveryCleanupCompleted: boolean
): typeof FactoryGraphStoredIndexReadSchema.Type {
  if (!terminalDeliveryCleanupCompleted) {
    return read;
  }

  if (read._tag === "unreadable" && read.failureKind === "decode") {
    return terminalDeliveryGraphStaleDiagnostic();
  }

  if (read._tag !== "valid") {
    return read;
  }

  const orchestrators = read.value.agents.filter(
    ({ role }) => role === "orchestrator"
  );
  const ciWatchers = read.value.agents.filter(
    ({ role }) => role === "ciWatcher"
  );
  const settled =
    orchestrators.length === 1 &&
    orchestrators[0]?.id === issueDeliveryAgentIds.orchestrator &&
    orchestrators[0].state === "succeeded" &&
    ciWatchers.length === 1 &&
    ciWatchers[0]?.id === issueDeliveryAgentIds.ciWatcher &&
    ciWatchers[0].state === "succeeded";
  if (settled) return read;

  return terminalDeliveryGraphStaleDiagnostic();
}

function terminalDeliveryGraphStaleDiagnostic(): typeof FactoryGraphStoredIndexReadSchema.Type {
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

function markRunIdMismatch(
  read: typeof FactoryGraphStoredIndexReadSchema.Type,
  runId: RunId | undefined,
  sourceId: FactoryProjectionDiagnosticSourceId
): typeof FactoryGraphStoredIndexReadSchema.Type;
function markRunIdMismatch(
  read: typeof FactoryActivityStoredIndexReadSchema.Type,
  runId: RunId | undefined,
  sourceId: FactoryProjectionDiagnosticSourceId
): typeof FactoryActivityStoredIndexReadSchema.Type;
function markRunIdMismatch(
  read: typeof FactoryArtifactStoredIndexReadSchema.Type,
  runId: RunId | undefined,
  sourceId: FactoryProjectionDiagnosticSourceId
): typeof FactoryArtifactStoredIndexReadSchema.Type;
function markRunIdMismatch(
  read:
    | typeof FactoryGraphStoredIndexReadSchema.Type
    | typeof FactoryActivityStoredIndexReadSchema.Type
    | typeof FactoryArtifactStoredIndexReadSchema.Type,
  runId: RunId | undefined,
  sourceId: FactoryProjectionDiagnosticSourceId
):
  | typeof FactoryGraphStoredIndexReadSchema.Type
  | typeof FactoryActivityStoredIndexReadSchema.Type
  | typeof FactoryArtifactStoredIndexReadSchema.Type {
  if (
    read._tag !== "valid" ||
    runId === undefined ||
    read.value.runId === runId
  ) {
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
  sourceId: FactoryProjectionDiagnosticSourceId,
  code: FactoryProjectionDiagnosticCode,
  failureKind: StoredIndexFailureKind
): StoredIndexUnreadable {
  return {
    _tag: "unreadable",
    diagnostic: {
      code,
      message: `${sourceId} could not be parsed and was rebuilt from events.jsonl.`,
      recoverable: true,
      sourceId,
    },
    failureKind,
  };
}

function storedDiagnostics(
  input: Schema.Schema.Type<typeof StoredFactoryIndexesSchema>
): ReadonlyArray<FactoryProjectionDiagnostic> {
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
  events: ReadonlyArray<RunEvent>
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(paths.factoryArtifactsDirectory, {
      recursive: true,
    });
    yield* fs.writeFileString(
      paths.factoryGraph,
      `${JSON.stringify(projectionEnvelope("graph", encodeFactoryGraph(indexes.graph), events), null, 2)}\n`
    );
    yield* fs.writeFileString(
      paths.factoryActivityIndex,
      `${JSON.stringify(projectionEnvelope("activity", encodeActivityIndex(indexes.activity), events), null, 2)}\n`
    );
    yield* fs.writeFileString(
      paths.factoryArtifactsIndex,
      `${JSON.stringify(projectionEnvelope("artifacts", encodeArtifactIndex(indexes.artifacts), events), null, 2)}\n`
    );
  });
}

function projectionEnvelope(
  kind: FactoryProjectionEnvelopeKind,
  value: unknown,
  events: ReadonlyArray<RunEvent>
) {
  const last = events.at(-1);
  if (last === undefined)
    throw new Error("Factory projections require at least one source event.");
  return {
    kind,
    sourceEventCount: events.length,
    sourceLastEventSequence: last.sequence,
    sourceEventsDigest: sourceEventsDigest(events),
    value,
    version: 2 as const,
  };
}

function sourceEventsDigest(events: ReadonlyArray<RunEvent>) {
  const encoded = events.map((event) => Schema.encodeSync(RunEvent)(event));
  return createHash("sha256")
    .update("gaia.factory-projection-source-events.v1\0")
    .update(JSON.stringify(encoded))
    .digest("hex");
}

function parseFactoryCreateInput(
  events: ReadonlyArray<RunEvent>
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
      })
    );
  } catch {
    return Effect.fail(
      parseLocalRunReadDiagnostic({
        code: "FactoryGraphNotFound",
        message:
          "Run does not contain factory workflow metadata in its authoritative RUN_CREATED event.",
        recoverable: false,
        runId: first.runId,
      })
    );
  }
}

function parseFactoryResolvedExecution(
  events: ReadonlyArray<RunEvent>
): Effect.Effect<typeof ResolvedHarnessExecution.Type, LocalRunReadDiagnostic> {
  const first = events[0];
  if (first === undefined) {
    return Effect.fail(noEventsDiagnostic(undefined));
  }
  try {
    return Effect.succeed(
      decodeResolvedHarnessExecution(
        jsonObjectField(first.payload["execution"], "resolved")
      )
    );
  } catch {
    return Effect.fail(
      parseLocalRunReadDiagnostic({
        code: "FactoryGraphNotFound",
        message:
          "Run does not contain resolved harness execution metadata in its authoritative RUN_CREATED event.",
        recoverable: false,
        runId: first.runId,
      })
    );
  }
}

function jsonObjectField(
  value: Schema.Json | undefined,
  field: string
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

function buildFactoryGraph(
  input: Schema.Schema.Type<typeof BuildFactoryGraphInputSchema>
): FactoryGraphProjection {
  const agentStates = agentStatesFromEvents(input.events);
  const latestActivityByAgent = latestActivityIdByAgent(
    input.activity.activities
  );
  const artifactCounts = artifactCountByOwner(input.artifacts);
  const workItemId = issueDeliveryRootWorkItemId;
  const replay = snapshotFromReplay(input.events);
  const proof = Schema.decodeUnknownOption(RunProofProjectionV1Schema)(
    replay.context["runProof"]
  );
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

  const diagnostics: Array<FactoryProjectionDiagnostic> = [
    ...input.diagnostics,
  ];
  if ((agentStates.get("ciWatcher") ?? "unknown") === "unknown") {
    diagnostics.push({
      code: "FactoryCiWatcherUnavailable",
      message:
        "CI watcher state is unavailable until PR/check evidence is recorded.",
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
    ...(proof._tag === "Some" ? { proofAggregate: proof.value.aggregate } : {}),
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

function buildActivityIndex(
  input: Schema.Schema.Type<typeof BuildActivityIndexInputSchema>
): FactoryActivityIndex {
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
  events: ReadonlyArray<RunEvent>
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
  event: RunEvent
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
              : "failed"
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
    case "RUN_PROOF_RESULT_RECORDED":
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
        parseDeliveryRemediation(event.payload["remediation"]).state ===
          "failed"
          ? "failed"
          : "running"
      );
      return;
    case "DELIVERY_MERGE_READINESS_RECORDED":
      parseDeliveryMergeReadinessDecision(event.payload["decision"]);
      states.set("ciWatcher", "running");
      return;
    case "DELIVERY_MERGE_RECORDED": {
      const state = parseDeliveryMergeReceipt(
        event.payload["mergeAction"]
      ).state;
      states.set(
        "orchestrator",
        state === "dispatchFailed"
          ? "failed"
          : state === "dispatchConfirmed"
            ? "blocked"
            : "running"
      );
      return;
    }
    case "DELIVERY_CLEANUP_RECORDED": {
      const state = parseDeliveryCleanupReceipt(event.payload["cleanup"]).state;
      states.set(
        "orchestrator",
        state === "completed" ? "succeeded" : "blocked"
      );
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
    case "RUN_CONTRACT_RECORDED":
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
    case "RUN_CONTRACT_RECORDED":
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
    case "RUN_PROOF_RESULT_RECORDED":
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
    case "RUN_CONTRACT_RECORDED":
      return "contractRecorded";
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
      return "completed-unverified";
    case "RUN_PROOF_RESULT_RECORDED": {
      return parseRunProofResult(event.payload["result"]).aggregate;
    }
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
    case "RUN_CONTRACT_RECORDED":
      return "Run contract recorded";
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
      return "Legacy verification recorded (unverified)";
    case "RUN_PROOF_RESULT_RECORDED":
      return "Run proof result recorded";
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
  activities: ReadonlyArray<FactoryActivityIndex["activities"][number]>
): ReadonlyMap<FactoryAgentId, FactoryActivityId> {
  const latest = new Map<FactoryAgentId, FactoryActivityId>();
  for (const activity of activities) {
    if (activity.agentId !== undefined) {
      latest.set(activity.agentId, activity.activityId);
    }
  }

  return latest;
}

function artifactCountByOwner(
  artifacts: ReadonlyArray<FactoryArtifactIndex["artifacts"][number]>
): ReadonlyMap<FactoryAgentId, number> {
  const counts = new Map<FactoryAgentId, number>();
  for (const artifact of artifacts) {
    counts.set(
      artifact.ownerAgentId,
      (counts.get(artifact.ownerAgentId) ?? 0) + 1
    );
  }

  return counts;
}

function artifactsByEventType(
  artifacts: ReadonlyArray<FactoryArtifactIndex["artifacts"][number]>
): ReadonlyMap<EventType, ReadonlyArray<FactoryArtifactId>> {
  const byId = new Map<FactoryArtifactId, FactoryArtifactDefinition>(
    factoryArtifactDefinitions.map((definition) => [
      definition.artifactId,
      definition,
    ])
  );
  const byEvent = new Map<EventType, Array<FactoryArtifactId>>();
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

function collectFactoryArtifacts(
  input: Schema.Schema.Type<typeof CollectFactoryArtifactsInputSchema>
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const artifacts = [];
    const diagnostics: Array<FactoryProjectionDiagnostic> = [];
    for (const definition of factoryArtifactDefinitions) {
      const existsExit = yield* Effect.exit(
        fs.exists(definition.path(input.paths))
      );
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
        label:
          definition.artifactId === "verification-result" &&
          input.events.some(({ type }) => type === "VERIFICATION_COMPLETED") &&
          !input.events.some(({ type }) => type === "RUN_PROOF_RESULT_RECORDED")
            ? "Legacy verification artifact (unverified)"
            : definition.label,
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
  events: ReadonlyArray<RunEvent>
): typeof RunEvent.fields.timestamp.Type {
  return (
    events.find(
      (event) =>
        event.type === definition.eventType ||
        (definition.artifactId === "verification-result" &&
          event.type === "VERIFICATION_COMPLETED")
    )?.timestamp ??
    events.at(-1)?.timestamp ??
    decodeRunEventTimestamp(new Date(0).toISOString())
  );
}

function agentIdForRole(role: FactoryAgentRole): FactoryAgentId {
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
      return decodeFactoryAgentId(`agent-${role}`);
  }
}

function parentAgentIdForRole(
  role: FactoryAgentRole
): FactoryAgentId | undefined {
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
  return parseLocalRunReadDiagnostic({
    code: "RunNotFound",
    message: "Run directory does not exist.",
    recoverable: false,
    runId,
  });
}

function noEventsDiagnostic(runId: RunId | undefined): LocalRunReadDiagnostic {
  return parseLocalRunReadDiagnostic({
    code: "RunHasNoEvents",
    message: "Run has no events.jsonl records.",
    recoverable: false,
    ...(runId === undefined ? {} : { runId }),
  });
}

function readFailureDiagnostic(runId: RunId): LocalRunReadDiagnostic {
  return parseLocalRunReadDiagnostic({
    code: "RunUnreadable",
    message: "Run could not be read from events.jsonl.",
    recoverable: false,
    runId,
  });
}
