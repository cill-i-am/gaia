import {
  parseRunId,
  snapshotFromReplay,
  type RunEvent,
  type RunId,
  type RunState,
} from "@gaia/core";
import { Cause, Effect, FileSystem } from "effect";
import { loadRun } from "./event-store.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";

export type LocalRunReadDiagnosticCode =
  | "ArtifactNotAllowed"
  | "ArtifactNotFound"
  | "InvalidRunDirectory"
  | "InvalidRunId"
  | "RunHasNoEvents"
  | "RunNotFound"
  | "RunUnreadable";

export type LocalRunReadDiagnostic = {
  readonly artifactName?: string;
  readonly code: LocalRunReadDiagnosticCode;
  readonly message: string;
  readonly pathSegment?: string;
  readonly recoverable: boolean;
  readonly runId?: RunId;
};

export type LocalRunStatus = "completed" | "failed" | "running";

export type LocalRunSummary = {
  readonly artifacts: ReadonlyArray<LocalRunArtifactId>;
  readonly createdAt: string;
  readonly eventCount: number;
  readonly latestEventType: RunEvent["type"];
  readonly runId: RunId;
  readonly state: RunState;
  readonly status: LocalRunStatus;
  readonly updatedAt: string;
};

export type LocalRunDetail = LocalRunSummary;

export type LocalRunList = {
  readonly diagnostics: ReadonlyArray<LocalRunReadDiagnostic>;
  readonly runs: ReadonlyArray<LocalRunSummary>;
};

export type LocalRunEvents = {
  readonly events: ReadonlyArray<RunEvent>;
  readonly runId: RunId;
};

export type LocalRunArtifactContentType =
  | "application/json"
  | "text/markdown"
  | "text/plain";

export type LocalRunArtifactId =
  | "input"
  | "worker-plan"
  | "plan-review"
  | "worker-log"
  | "worker-result"
  | "verification-result"
  | "evidence-review"
  | "report"
  | "report-json"
  | "events"
  | "snapshots";

const localRunArtifactIds: ReadonlyArray<LocalRunArtifactId> = [
  "input",
  "worker-plan",
  "plan-review",
  "worker-log",
  "worker-result",
  "verification-result",
  "evidence-review",
  "report",
  "report-json",
  "events",
  "snapshots",
];

export type LocalRunArtifact = {
  readonly artifactName: LocalRunArtifactId;
  readonly body: string;
  readonly contentType: LocalRunArtifactContentType;
  readonly runId: RunId;
};

type ArtifactDefinition = {
  readonly contentType: LocalRunArtifactContentType;
  readonly path: (paths: RunPaths) => string;
};

const artifactDefinitions: Readonly<Record<LocalRunArtifactId, ArtifactDefinition>> = {
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
  "plan-review": {
    contentType: "application/json",
    path: (paths) => paths.planReviewResult,
  },
  report: {
    contentType: "text/markdown",
    path: (paths) => paths.reportMarkdown,
  },
  "report-json": {
    contentType: "application/json",
    path: (paths) => paths.reportJson,
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
      return { diagnostics: [], runs: [] } satisfies LocalRunList;
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

    return { diagnostics, runs } satisfies LocalRunList;
  });
}

export function readLocalRun(runIdInput: string, options: RunStorageOptions = {}) {
  return Effect.gen(function* () {
    const runId = yield* parseRequestedRunId(runIdInput);
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

    const snapshot = snapshotFromReplay(loadedExit.value.events);
    const firstEvent = loadedExit.value.events[0];
    const latestEvent = loadedExit.value.events.at(-1);
    if (firstEvent === undefined || latestEvent === undefined) {
      return yield* Effect.fail(noEventsDiagnostic(runId));
    }

    const artifacts = yield* existingArtifacts(paths);
    return {
      artifacts,
      createdAt: firstEvent.timestamp,
      eventCount: loadedExit.value.events.length,
      latestEventType: latestEvent.type,
      runId,
      state: snapshot.state,
      status: statusFromState(snapshot.state),
      updatedAt: latestEvent.timestamp,
    } satisfies LocalRunDetail;
  });
}

export function readLocalRunEvents(
  runIdInput: string,
  options: RunStorageOptions = {},
) {
  return Effect.gen(function* () {
    const runId = yield* parseRequestedRunId(runIdInput);
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

    return {
      events: loadedExit.value.events,
      runId,
    } satisfies LocalRunEvents;
  });
}

export function readLocalRunArtifact(
  runIdInput: string,
  artifactName: string,
  options: RunStorageOptions = {},
) {
  return Effect.gen(function* () {
    const runId = yield* parseRequestedRunId(runIdInput);
    const artifactId = parseArtifactId(artifactName);
    if (artifactId._tag === "Failure") {
      return yield* Effect.fail({
        artifactName,
        code: "ArtifactNotAllowed",
        message: "Artifact is not allowlisted for local API reads.",
        recoverable: false,
        runId,
      } satisfies LocalRunReadDiagnostic);
    }

    const definition = artifactDefinitions[artifactId.artifactId];
    yield* readLocalRun(runId, options);
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* makeRunPaths(runId, options);
    const artifactPath = definition.path(paths);
    const exists = yield* fs.exists(artifactPath);
    if (!exists) {
      return yield* Effect.fail({
        artifactName,
        code: "ArtifactNotFound",
        message: "Artifact does not exist for this run.",
        recoverable: false,
        runId,
      } satisfies LocalRunReadDiagnostic);
    }

    const body = yield* fs.readFileString(artifactPath);
    return {
      artifactName: artifactId.artifactId,
      body,
      contentType: definition.contentType,
      runId,
    } satisfies LocalRunArtifact;
  });
}

type ParsedArtifactId =
  | { readonly _tag: "Failure" }
  | { readonly _tag: "Success"; readonly artifactId: LocalRunArtifactId };

function parseArtifactId(input: string): ParsedArtifactId {
  switch (input) {
    case "input":
    case "worker-plan":
    case "plan-review":
    case "worker-log":
    case "worker-result":
    case "verification-result":
    case "evidence-review":
    case "report":
    case "report-json":
    case "events":
    case "snapshots":
      return { _tag: "Success", artifactId: input };
  }

  return { _tag: "Failure" };
}

function parseRequestedRunId(runIdInput: string) {
  return Effect.try({
    try: () => parseRunId(runIdInput),
    catch: () =>
      ({
        code: "InvalidRunId",
        message: "Requested run id is not a valid Gaia run id.",
        pathSegment: runIdInput,
        recoverable: false,
      }) satisfies LocalRunReadDiagnostic,
  });
}

type ParsedRunDirectoryName =
  | { readonly _tag: "Failure"; readonly diagnostic: LocalRunReadDiagnostic }
  | { readonly _tag: "Success"; readonly runId: RunId };

function parseRunDirectoryName(pathSegment: string): ParsedRunDirectoryName {
  try {
    return { _tag: "Success", runId: parseRunId(pathSegment) };
  } catch {
    return {
      _tag: "Failure",
      diagnostic: {
        code: "InvalidRunDirectory",
        message: "Run directory name is not a valid Gaia run id.",
        pathSegment,
        recoverable: false,
      } satisfies LocalRunReadDiagnostic,
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
      const definition = artifactDefinitions[artifactName];
      const exists = yield* fs.exists(definition.path(paths));
      if (exists) {
        artifacts.push(artifactName);
      }
    }

    return artifacts.sort();
  });
}

function noEventsDiagnostic(runId: RunId): LocalRunReadDiagnostic {
  return {
    code: "RunHasNoEvents",
    message: "Run has no events.jsonl records.",
    recoverable: false,
    runId,
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

function diagnosticFromCause(
  cause: Cause.Cause<unknown>,
  runId: RunId,
): LocalRunReadDiagnostic {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason) && isReadDiagnostic(reason.error)) {
      return reason.error;
    }
  }

  return readFailureDiagnostic(runId);
}

function isReadDiagnostic(input: unknown): input is LocalRunReadDiagnostic {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    "message" in input &&
    "recoverable" in input
  );
}

function runNotFoundDiagnostic(runId: RunId): LocalRunReadDiagnostic {
  return {
    code: "RunNotFound",
    message: "Run directory does not exist.",
    recoverable: false,
    runId,
  };
}
