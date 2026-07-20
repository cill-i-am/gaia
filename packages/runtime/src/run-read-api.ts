import {
  LocalRunPathSegmentSchema,
  LocalRunArtifactContentTypeSchema,
  LocalRunReadArtifactIdSchema,
  LocalRunReadDiagnosticSchema,
  LocalRunReadSummarySchema,
  localRunArtifactIds,
  parseLocalRunArtifact,
  parseLocalRunArtifactName,
  parseLocalRunEvents,
  parseLocalRunList,
  parseLocalRunReadDiagnostic,
  parseRunId,
  RunIdSchema,
  RunProofProjectionV1Schema,
  snapshotFromReplay,
  type LocalRunArtifactContentType,
  type LocalRunArtifactId,
  type LocalRunReadDiagnostic,
  type LocalRunStatus,
  type LocalRunSummary,
  type RunId,
  type RunState,
} from "@gaia/core";
import { Cause, Effect, FileSystem, Option, Schema } from "effect";

import { loadRun } from "./event-store.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  type RunPaths,
  type RunStorageOptions,
  type RuntimePath,
} from "./paths.js";
import {
  canonicalRunContractBody,
  canonicalRunProofResultBody,
  synchronizeEventOwnedRunProjections,
} from "./run-contract.js";

const decodeLocalRunArtifactId = Schema.decodeUnknownOption(
  LocalRunReadArtifactIdSchema
);
const decodeLocalRunDiagnostic = Schema.decodeUnknownOption(
  LocalRunReadDiagnosticSchema
);
const decodeLocalRunSummary = Schema.decodeUnknownOption(
  LocalRunReadSummarySchema
);
const encodeLocalRunArtifactId = Schema.encodeSync(
  LocalRunReadArtifactIdSchema
);

const ArtifactDefinitionDataSchema = Schema.Struct({
  contentType: LocalRunArtifactContentTypeSchema,
});

type ArtifactDefinition = Schema.Schema.Type<
  typeof ArtifactDefinitionDataSchema
> & {
  readonly path: (paths: RunPaths) => RuntimePath;
};

const artifactDefinitions: Readonly<
  Record<typeof LocalRunReadArtifactIdSchema.Encoded, ArtifactDefinition>
> = {
  "evidence-review": {
    contentType: "application/json",
    path: (paths) => paths.evidenceReviewResult,
  },
  events: {
    contentType: "application/json",
    path: (paths) => paths.events,
  },
  input: {
    contentType: "text/markdown",
    path: (paths) => paths.input,
  },
  "evidence-promotion": {
    contentType: "application/json",
    path: (paths) => paths.evidencePromotionJson,
  },
  "evidence-promotion-markdown": {
    contentType: "text/markdown",
    path: (paths) => paths.evidencePromotionMarkdown,
  },
  "factory-retro": {
    contentType: "application/json",
    path: (paths) => paths.factoryRetroJson,
  },
  "factory-retro-markdown": {
    contentType: "text/markdown",
    path: (paths) => paths.factoryRetroMarkdown,
  },
  "factory-scorecard": {
    contentType: "application/json",
    path: (paths) => paths.factoryScorecardJson,
  },
  "factory-scorecard-markdown": {
    contentType: "text/markdown",
    path: (paths) => paths.factoryScorecardMarkdown,
  },
  "plan-review": {
    contentType: "application/json",
    path: (paths) => paths.planReviewResult,
  },
  report: {
    contentType: "text/markdown",
    path: (paths) => paths.reportMarkdown,
  },
  "run-contract": {
    contentType: "application/json",
    path: (paths) => paths.runContract,
  },
  "report-json": {
    contentType: "application/json",
    path: (paths) => paths.reportJson,
  },
  "reviewer-findings": {
    contentType: "application/json",
    path: (paths) => paths.reviewerFindings,
  },
  snapshots: {
    contentType: "application/json",
    path: (paths) => paths.snapshots,
  },
  "verification-result": {
    contentType: "application/json",
    path: (paths) => paths.verificationResult,
  },
  "worker-log": {
    contentType: "text/plain",
    path: (paths) => paths.workerLog,
  },
  "worker-plan": {
    contentType: "application/json",
    path: (paths) => paths.workerPlanResult,
  },
  "worker-result": {
    contentType: "application/json",
    path: (paths) => paths.workerResult,
  },
};

export function listLocalRuns(options: RunStorageOptions = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);
    const exists = yield* fs.exists(store.runsRoot);
    if (!exists) {
      return parseLocalRunList({ diagnostics: [], runs: [] });
    }

    const entries = (yield* fs.readDirectory(store.runsRoot))
      .filter((entry) => entry.startsWith("run-"))
      .sort()
      .reverse();
    const diagnostics: Array<LocalRunReadDiagnostic> = [];
    const runs: Array<LocalRunSummary> = [];

    for (const entry of entries) {
      const runId = parseRunDirectoryName(entry);
      if (runId._tag === "Failure") {
        diagnostics.push(runId.diagnostic);
        continue;
      }

      const exit = yield* Effect.exit(readLocalRun(runId.runId, options));
      if (exit._tag === "Success") {
        runs.push(exit.value);
      } else {
        diagnostics.push(diagnosticFromCause(exit.cause, runId.runId));
      }
    }

    return parseLocalRunList({ diagnostics, runs });
  });
}

export function readLocalRun(runId: RunId, options: RunStorageOptions = {}) {
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

    const snapshot = snapshotFromReplay(synchronizedExit.value.events);
    const firstEvent = synchronizedExit.value.events[0];
    const latestEvent = synchronizedExit.value.events.at(-1);
    if (firstEvent === undefined || latestEvent === undefined) {
      return yield* Effect.fail(noEventsDiagnostic(runId));
    }

    const artifacts = yield* existingArtifacts(paths);
    const proofAggregate = proofAggregateFromSnapshot(
      snapshot.context["runProof"]
    );
    const summary = decodeLocalRunSummary({
      artifacts,
      createdAt: firstEvent.timestamp,
      eventCount: synchronizedExit.value.events.length,
      latestEventType: latestEvent.type,
      ...(proofAggregate === undefined ? {} : { proofAggregate }),
      runId,
      state: snapshot.state,
      status: statusFromState(snapshot.state),
      updatedAt: latestEvent.timestamp,
    });
    if (Option.isNone(summary)) {
      return yield* Effect.fail(readFailureDiagnostic(runId));
    }

    return summary.value;
  });
}

function proofAggregateFromSnapshot(input: unknown) {
  const proof = Schema.decodeUnknownOption(RunProofProjectionV1Schema)(input);
  return Option.isSome(proof) ? proof.value.aggregate : undefined;
}

export function readLocalRunEvents(
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

    const loadedExit = yield* Effect.exit(loadRun(paths));
    if (loadedExit._tag === "Failure") {
      return yield* Effect.fail(readFailureDiagnostic(runId));
    }

    if (loadedExit.value.events.length === 0) {
      return yield* Effect.fail(noEventsDiagnostic(runId));
    }

    return parseLocalRunEvents({
      events: loadedExit.value.events,
      runId,
    });
  });
}

export function readLocalRunArtifact(
  runId: RunId,
  artifactName: string,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const attemptedArtifactName = parseLocalRunArtifactName(artifactName);
    const artifactId = decodeLocalRunArtifactId(artifactName);
    if (Option.isNone(artifactId)) {
      return yield* Effect.fail(
        parseLocalRunReadDiagnostic({
          artifactName: attemptedArtifactName,
          code: "ArtifactNotAllowed",
          message: "Artifact is not allowlisted for local API reads.",
          recoverable: false,
          runId,
        })
      );
    }

    const definition =
      artifactDefinitions[encodeLocalRunArtifactId(artifactId.value)];
    yield* readLocalRun(runId, options);
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* makeRunPaths(runId, options);
    const synchronized = yield* synchronizeEventOwnedRunProjections(
      paths,
      runId
    );
    const eventOwnedBody =
      artifactId.value === "run-contract" && synchronized.contract !== undefined
        ? canonicalRunContractBody(synchronized.contract)
        : artifactId.value === "verification-result" &&
            synchronized.proofResult !== undefined
          ? canonicalRunProofResultBody(synchronized.proofResult)
          : undefined;
    if (eventOwnedBody !== undefined)
      return parseLocalRunArtifact({
        artifactName: artifactId.value,
        body: eventOwnedBody,
        contentType: definition.contentType,
        runId,
      });
    const artifactPath = definition.path(paths);
    const exists = yield* fs.exists(artifactPath);
    if (!exists) {
      return yield* Effect.fail(
        parseLocalRunReadDiagnostic({
          artifactName: attemptedArtifactName,
          code: "ArtifactNotFound",
          message: "Artifact does not exist for this run.",
          recoverable: false,
          runId,
        })
      );
    }

    const body = yield* fs.readFileString(artifactPath);
    return parseLocalRunArtifact({
      artifactName: artifactId.value,
      body,
      contentType: definition.contentType,
      runId,
    });
  });
}

const ParsedRunDirectoryNameSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Failure"),
    diagnostic: LocalRunReadDiagnosticSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Success"),
    runId: RunIdSchema,
  }),
]);

type ParsedRunDirectoryName = Schema.Schema.Type<
  typeof ParsedRunDirectoryNameSchema
>;

function parseRunDirectoryName(pathSegment: string): ParsedRunDirectoryName {
  const decodedPathSegment = Schema.decodeUnknownOption(
    LocalRunPathSegmentSchema
  )(pathSegment);
  if (Option.isNone(decodedPathSegment)) {
    return {
      _tag: "Failure",
      diagnostic: parseLocalRunReadDiagnostic({
        code: "InvalidRunDirectory",
        message: "Run directory name is not a valid Gaia run id.",
        recoverable: false,
      }),
    };
  }

  try {
    return { _tag: "Success", runId: parseRunId(pathSegment) };
  } catch {
    return {
      _tag: "Failure",
      diagnostic: parseLocalRunReadDiagnostic({
        code: "InvalidRunDirectory",
        message: "Run directory name is not a valid Gaia run id.",
        pathSegment: decodedPathSegment.value,
        recoverable: false,
      }),
    };
  }
}

function statusFromState(state: RunState): LocalRunStatus {
  if (state === "completed") {
    return "completed";
  }

  if (state === "failed") {
    return "failed";
  }

  return "running";
}

function existingArtifacts(paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const artifacts: Array<LocalRunArtifactId> = [];
    for (const artifactName of localRunArtifactIds) {
      const definition =
        artifactDefinitions[encodeLocalRunArtifactId(artifactName)];
      const exists = yield* fs.exists(definition.path(paths));
      if (exists) {
        artifacts.push(artifactName);
      }
    }

    return artifacts.sort();
  });
}

function noEventsDiagnostic(runId: RunId): LocalRunReadDiagnostic {
  return parseLocalRunReadDiagnostic({
    code: "RunHasNoEvents",
    message: "Run has no events.jsonl records.",
    recoverable: false,
    runId,
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

function diagnosticFromCause(
  cause: Cause.Cause<unknown>,
  runId: RunId
): LocalRunReadDiagnostic {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      const diagnostic = decodeLocalRunDiagnostic(reason.error);
      if (Option.isSome(diagnostic)) {
        return diagnostic.value;
      }
    }
  }

  return readFailureDiagnostic(runId);
}

function runNotFoundDiagnostic(runId: RunId): LocalRunReadDiagnostic {
  return parseLocalRunReadDiagnostic({
    code: "RunNotFound",
    message: "Run directory does not exist.",
    recoverable: false,
    runId,
  });
}
