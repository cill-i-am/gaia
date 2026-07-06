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
  readonly artifacts: ReadonlyArray<string>;
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

export type LocalRunArtifact = {
  readonly artifactName: string;
  readonly body: string;
  readonly contentType: LocalRunArtifactContentType;
  readonly runId: RunId;
};

type ArtifactDefinition = {
  readonly contentType: LocalRunArtifactContentType;
  readonly path: (paths: RunPaths) => string;
};

const artifactDefinitions: Readonly<Record<string, ArtifactDefinition>> = {
  "browser-evidence.json": {
    contentType: "application/json",
    path: (paths) => paths.browserEvidence,
  },
  "ci-watch-state.json": {
    contentType: "application/json",
    path: (paths) => paths.ciWatchState,
  },
  "codex-harness-progress.json": {
    contentType: "application/json",
    path: (paths) => paths.codexHarnessProgress,
  },
  "dogfood-retrospective.json": {
    contentType: "application/json",
    path: (paths) => paths.dogfoodRetrospective,
  },
  "evidence-review.json": {
    contentType: "application/json",
    path: (paths) => paths.evidenceReviewResult,
  },
  "evidence-review.md": {
    contentType: "text/markdown",
    path: (paths) => paths.evidenceReviewMarkdown,
  },
  "evidence-reviewer-session.json": {
    contentType: "application/json",
    path: (paths) => paths.evidenceReviewerSession,
  },
  "github-feedback.json": {
    contentType: "application/json",
    path: (paths) => paths.githubFeedback,
  },
  "github-pr-comment.md": {
    contentType: "text/markdown",
    path: (paths) => paths.githubPrComment,
  },
  "linear-issue-graph.json": {
    contentType: "application/json",
    path: (paths) => paths.linearIssueGraph,
  },
  "merge-decision.json": {
    contentType: "application/json",
    path: (paths) => paths.mergeDecision,
  },
  "plan-review.json": {
    contentType: "application/json",
    path: (paths) => paths.planReviewResult,
  },
  "plan-review.md": {
    contentType: "text/markdown",
    path: (paths) => paths.planReviewMarkdown,
  },
  "plan-reviewer-session.json": {
    contentType: "application/json",
    path: (paths) => paths.planReviewerSession,
  },
  "preview-deployment.json": {
    contentType: "application/json",
    path: (paths) => paths.previewDeployment,
  },
  "pr-loop-state.json": {
    contentType: "application/json",
    path: (paths) => paths.prLoopState,
  },
  "remediation-spec.md": {
    contentType: "text/markdown",
    path: (paths) => paths.githubRemediationSpec,
  },
  "report.json": {
    contentType: "application/json",
    path: (paths) => paths.reportJson,
  },
  "report.md": {
    contentType: "text/markdown",
    path: (paths) => paths.reportMarkdown,
  },
  "run-profile.json": {
    contentType: "application/json",
    path: (paths) => paths.runProfile,
  },
  "skill-bundle.json": {
    contentType: "application/json",
    path: (paths) => paths.skillBundle,
  },
  "skill-manifest.json": {
    contentType: "application/json",
    path: (paths) => paths.skillManifest,
  },
  "verification-result.json": {
    contentType: "application/json",
    path: (paths) => paths.verificationResult,
  },
  "verification.log": {
    contentType: "text/plain",
    path: (paths) => paths.verificationLog,
  },
  "worker-plan.json": {
    contentType: "application/json",
    path: (paths) => paths.workerPlanResult,
  },
  "worker-plan.md": {
    contentType: "text/markdown",
    path: (paths) => paths.workerPlanMarkdown,
  },
  "worker-result.json": {
    contentType: "application/json",
    path: (paths) => paths.workerResult,
  },
  "worker.log": {
    contentType: "text/plain",
    path: (paths) => paths.workerLog,
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
    const definition = artifactDefinitions[artifactName];
    if (definition === undefined) {
      return yield* Effect.fail({
        artifactName,
        code: "ArtifactNotAllowed",
        message: "Artifact is not allowlisted for local API reads.",
        recoverable: false,
        runId,
      } satisfies LocalRunReadDiagnostic);
    }

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
      artifactName,
      body,
      contentType: definition.contentType,
      runId,
    } satisfies LocalRunArtifact;
  });
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
    const artifacts: Array<string> = [];
    for (const [artifactName, definition] of Object.entries(artifactDefinitions)) {
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
