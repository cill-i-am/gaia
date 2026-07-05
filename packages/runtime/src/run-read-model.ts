import {
  parseRunId,
  snapshotFromReplay,
  type RunEvent,
  type RunId,
  type RunState,
} from "@gaia/core";
import { Effect, Exit, FileSystem, Option, Path, Schema } from "effect";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import { readEvents } from "./event-store.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";

export type RunReadDiagnostic = {
  readonly code: string;
  readonly message: string;
  readonly pathSegment: string;
  readonly recoverable: boolean;
  readonly runId?: string;
};

export type RunReadSummary = {
  readonly eventCount: number;
  readonly lastEventAt: string;
  readonly reportPath?: string;
  readonly runDirectory: string;
  readonly runId: RunId;
  readonly state: RunState;
};

export type RunListReadResult = {
  readonly diagnostics: ReadonlyArray<RunReadDiagnostic>;
  readonly runs: ReadonlyArray<RunReadSummary>;
};

export type RunReadDetail = RunReadSummary & {
  readonly latestEvent: RunEvent;
};

export type RunEventsReadResult = {
  readonly events: ReadonlyArray<RunEvent>;
  readonly runId: RunId;
};

export type RunArtifactReadResult = {
  readonly artifactName: RunArtifactName;
  readonly content: Schema.Json;
  readonly contentType: "application/json" | "text/plain; charset=utf-8";
  readonly encoding: "json" | "text";
  readonly runId: RunId;
};

const artifactReaders = {
  "browser-evidence.json": (paths: RunPaths) => paths.browserEvidence,
  "evidence-review.json": (paths: RunPaths) => paths.evidenceReviewResult,
  "evidence-review.md": (paths: RunPaths) => paths.evidenceReviewMarkdown,
  "evidence-reviewer-session.json": (paths: RunPaths) =>
    paths.evidenceReviewerSession,
  "github-feedback.json": (paths: RunPaths) => paths.githubFeedback,
  "github-pr-comment.md": (paths: RunPaths) => paths.githubPrComment,
  "input.md": (paths: RunPaths) => paths.input,
  "linear-issue-graph.json": (paths: RunPaths) => paths.linearIssueGraph,
  "merge-decision.json": (paths: RunPaths) => paths.mergeDecision,
  "plan-review.json": (paths: RunPaths) => paths.planReviewResult,
  "plan-review.md": (paths: RunPaths) => paths.planReviewMarkdown,
  "plan-reviewer-session.json": (paths: RunPaths) => paths.planReviewerSession,
  "preview-deployment.json": (paths: RunPaths) => paths.previewDeployment,
  "pr-loop-state.json": (paths: RunPaths) => paths.prLoopState,
  "remediation-spec.md": (paths: RunPaths) => paths.githubRemediationSpec,
  "report.json": (paths: RunPaths) => paths.reportJson,
  "report.md": (paths: RunPaths) => paths.reportMarkdown,
  "run-profile.json": (paths: RunPaths) => paths.runProfile,
  "skill-bundle.json": (paths: RunPaths) => paths.skillBundle,
  "skill-manifest.json": (paths: RunPaths) => paths.skillManifest,
  "verification-result.json": (paths: RunPaths) => paths.verificationResult,
  "worker-plan.json": (paths: RunPaths) => paths.workerPlanResult,
  "worker-plan.md": (paths: RunPaths) => paths.workerPlanMarkdown,
  "worker-result.json": (paths: RunPaths) => paths.workerResult,
  "workspace-manifest.json": (paths: RunPaths) => paths.workspaceManifest,
} as const;

export type RunArtifactName = keyof typeof artifactReaders;

type RunReadRequirements = FileSystem.FileSystem | Path.Path;

export function listReadableRuns(
  options: RunStorageOptions = {},
): Effect.Effect<RunListReadResult, unknown, RunReadRequirements> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);
    const exists = yield* fs.exists(store.runsRoot);
    if (!exists) {
      return { diagnostics: [], runs: [] } satisfies RunListReadResult;
    }

    const entries = (yield* fs.readDirectory(store.runsRoot))
      .filter((entry) => entry.startsWith("run-"))
      .sort()
      .reverse();
    const diagnostics: Array<RunReadDiagnostic> = [];
    const runs: Array<RunReadSummary> = [];

    for (const entry of entries) {
      const runId = parseRunIdForRead(entry);
      if (runId._tag === "Invalid") {
        diagnostics.push({
          code: "InvalidRunDirectory",
          message: "Run directory name is not a valid Gaia run id.",
          pathSegment: entry,
          recoverable: true,
        });
        continue;
      }

      const summary = yield* Effect.exit(readRunSummary(runId.runId, options));
      if (Exit.isSuccess(summary)) {
        runs.push(summary.value);
      } else {
        const error = Exit.findErrorOption(summary);
        diagnostics.push(
          publicRunDiagnostic(
            Option.isSome(error) ? error.value : undefined,
            entry,
            runId.runId,
          ),
        );
      }
    }

    return { diagnostics, runs } satisfies RunListReadResult;
  });
}

export function readRunDetail(
  runIdInput: string,
  options: RunStorageOptions = {},
): Effect.Effect<RunReadDetail, unknown, RunReadRequirements> {
  return Effect.gen(function* () {
    const runId = yield* parseRunIdEffect(runIdInput);
    const summary = yield* readRunSummary(runId, options);
    const paths = yield* makeRunPaths(runId, options);
    const events = yield* readEvents(paths);
    const latestEvent = events.at(-1);

    if (latestEvent === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunHasNoEvents",
          message: `Run ${runId} has no events.`,
          recoverable: false,
        }),
      );
    }

    return { ...summary, latestEvent } satisfies RunReadDetail;
  });
}

export function readRunEventLog(
  runIdInput: string,
  options: RunStorageOptions = {},
): Effect.Effect<RunEventsReadResult, unknown, RunReadRequirements> {
  return Effect.gen(function* () {
    const runId = yield* parseRunIdEffect(runIdInput);
    const paths = yield* makeRunPaths(runId, options);
    const events = yield* readEvents(paths);
    if (events.length === 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunHasNoEvents",
          message: `Run ${runId} has no events.`,
          recoverable: false,
        }),
      );
    }

    return { events, runId } satisfies RunEventsReadResult;
  });
}

export function readRunArtifact(
  runIdInput: string,
  artifactNameInput: string,
  options: RunStorageOptions = {},
): Effect.Effect<RunArtifactReadResult, unknown, RunReadRequirements> {
  return Effect.gen(function* () {
    const runId = yield* parseRunIdEffect(runIdInput);
    const artifactName = yield* parseArtifactNameEffect(artifactNameInput);
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;
    const artifactPath = artifactReaders[artifactName](paths);
    const exists = yield* fs.exists(artifactPath);
    if (!exists) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ArtifactNotFound",
          message: `Artifact '${artifactName}' was not found for run ${runId}.`,
          recoverable: false,
        }),
      );
    }

    const text = yield* fs.readFileString(artifactPath);
    if (artifactName.endsWith(".json")) {
      return {
        artifactName,
        content: parseJsonArtifact(text, artifactName),
        contentType: "application/json",
        encoding: "json",
        runId,
      } satisfies RunArtifactReadResult;
    }

    return {
      artifactName,
      content: text,
      contentType: "text/plain; charset=utf-8",
      encoding: "text",
      runId,
    } satisfies RunArtifactReadResult;
  });
}

export function publicRunDiagnostic(
  error: unknown,
  pathSegment: string,
  runId?: string,
): RunReadDiagnostic {
  if (error instanceof GaiaRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      pathSegment,
      recoverable: error.recoverable,
      ...(runId === undefined ? {} : { runId }),
    };
  }

  return {
    code: "RunReadFailed",
    message: "Gaia could not read this run.",
    pathSegment,
    recoverable: true,
    ...(runId === undefined ? {} : { runId }),
  };
}

function readRunSummary(
  runId: RunId,
  options: RunStorageOptions,
): Effect.Effect<RunReadSummary, unknown, RunReadRequirements> {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const events = yield* readEvents(paths);
    const latestEvent = events.at(-1);

    if (latestEvent === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunHasNoEvents",
          message: `Run ${runId} has no events.`,
          recoverable: false,
        }),
      );
    }

    const snapshot = snapshotFromReplay(events);
    return {
      eventCount: events.length,
      lastEventAt: latestEvent.timestamp,
      ...(snapshot.state === "completed" ? { reportPath: paths.reportMarkdown } : {}),
      runDirectory: paths.root,
      runId,
      state: snapshot.state,
    } satisfies RunReadSummary;
  });
}

function parseRunIdEffect(input: string) {
  return Effect.try({
    try: () => parseRunId(input),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidRunId",
        message: `Invalid Gaia run id '${input}'.`,
        recoverable: false,
      }),
  });
}

function parseRunIdForRead(input: string) {
  try {
    return { _tag: "Valid" as const, runId: parseRunId(input) };
  } catch {
    return { _tag: "Invalid" as const };
  }
}

function parseArtifactNameEffect(input: string) {
  return Effect.try({
    try: () => {
      if (
        input.includes("/") ||
        input.includes("\\") ||
        input === "." ||
        input === ".." ||
        !(input in artifactReaders)
      ) {
        throw new Error("Artifact is not allowlisted.");
      }

      return input as RunArtifactName;
    },
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "ArtifactNotAllowlisted",
        message: `Artifact '${input}' is not available through the local API.`,
        recoverable: false,
      }),
  });
}

function parseJsonArtifact(text: string, artifactName: string): Schema.Json {
  try {
    return JSON.parse(text) as Schema.Json;
  } catch (cause) {
    throw makeRuntimeError({
      cause,
      code: "InvalidArtifactJson",
      message: `Artifact '${artifactName}' is not valid JSON.`,
      recoverable: false,
    });
  }
}
