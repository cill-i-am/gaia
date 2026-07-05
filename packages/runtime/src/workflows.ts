import {
  GaiaFailure,
  parseMarkdownSpec,
  parseRunId,
  snapshotFromReplay,
  type ReviewPhase,
  type RunId,
  type RunState,
} from "@gaia/core";
import { customAlphabet } from "nanoid";
import { Effect, FileSystem, Path, type Schema } from "effect";
import { appendEvent, loadRun } from "./event-store.js";
import { writeEmptyBrowserEvidence } from "./browser-evidence.js";
import type { CodexHarnessOptions } from "./codex-harness.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import {
  HarnessRunRequest,
  defaultHarnessName,
  runHarness,
  type HarnessName,
  type ProcessHarnessConfig,
} from "./harness.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  runRelative,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import {
  ReviewRunRequest,
  defaultReviewerName,
  runReviewer,
  type ReviewerRunOptions,
} from "./reviewer.js";
import { writeReport } from "./report-writer.js";
import { withRunStoreLock } from "./run-store-lock.js";
import {
  writeSkillManifest,
  type SkillManifestSource,
} from "./skill-manifest.js";
import { verifyHarnessOutput } from "./verifier.js";
import { writeWorkerPlan } from "./worker-plan.js";
import {
  emptyWorkspaceSource,
  prepareWorkspace,
  type WorkspaceSource,
} from "./workspace.js";

const nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
  10,
);

export type CommandSummary = {
  readonly reportPath: string | undefined;
  readonly runDirectory: string;
  readonly runId: RunId;
  readonly state: RunState;
  readonly status: "completed" | "failed" | "running";
};

export type WorkflowOptions = RunStorageOptions & ReviewerRunOptions & {
  readonly codexHarness?: CodexHarnessOptions;
  readonly harnessName?: HarnessName;
  readonly processHarness?: ProcessHarnessConfig;
  readonly skillManifestSource?: SkillManifestSource;
  readonly workspaceSource?: WorkspaceSource;
};

export function runSpecFile(specPath: string, options: WorkflowOptions = {}) {
  return withRunStoreLock(options, runSpecFileUnlocked(specPath, options));
}

function runSpecFileUnlocked(specPath: string, options: WorkflowOptions) {
  return Effect.gen(function* () {
    const runId = yield* generateRunId;
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const input = yield* fs.readFileString(specPath);
    const fallbackTitle = path.basename(specPath, path.extname(specPath));
    const spec = yield* parseSpec(input, fallbackTitle);
    yield* fs.makeDirectory(paths.root, { recursive: true });
    yield* fs.writeFileString(paths.input, input);
    yield* fs.writeFileString(paths.latest, runId);

    yield* appendEvent(runId, paths, {
      payload: { specPath: "input.md" },
      type: "RUN_CREATED",
    });
    const workspace = yield* prepareWorkspace(
      paths,
      options.workspaceSource ?? emptyWorkspaceSource(),
    );
    yield* appendEvent(runId, paths, {
      payload: {
        copiedFiles: workspace.copiedFiles,
        workspaceManifestPath: workspace.manifestPath,
        workspacePath: workspace.workspacePath,
        workspaceSource: workspace.source,
      },
      type: "WORKSPACE_PREPARED",
    });
    const skillManifest = yield* writeSkillManifest({
      paths,
      ...(options.skillManifestSource === undefined
        ? {}
        : { source: options.skillManifestSource }),
    }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "preparingWorkspace", error),
      ),
    );
    yield* writeEmptyBrowserEvidence({ paths }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "preparingWorkspace", error),
      ),
    );
    const harnessName = options.harnessName ?? defaultHarnessName;
    yield* writeWorkerPlan({ harnessName, paths, runId, spec }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "reviewing", error),
      ),
    );
    yield* runReviewPhase(runId, paths, spec, "plan", options);
    yield* appendEvent(runId, paths, {
      payload: { harnessName },
      type: "WORKER_STARTED",
    });
    const harnessOptions = {
      ...(options.codexHarness === undefined
        ? {}
        : { codexHarness: options.codexHarness }),
      ...(options.processHarness === undefined
        ? {}
        : { processHarness: options.processHarness }),
    };
    const harnessResult = yield* runHarness(
      HarnessRunRequest.make({
        harnessName,
        runId,
        specBody: spec.body,
        specTitle: spec.title,
        workerLogPath: paths.workerLog,
        workerResultPath: paths.workerResult,
        workspaceOutputPath: paths.workspaceOutput,
        workspacePath: paths.workspace,
      }),
      harnessOptions,
    ).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "runningWorker", error),
      ),
    );
    yield* appendEvent(runId, paths, {
      payload: {
        harnessName: harnessResult.harnessName,
        outputArtifacts: harnessResult.outputArtifacts,
        workerResultPath: harnessResult.resultPath,
      },
      type: "WORKER_COMPLETED",
    });
    yield* appendEvent(runId, paths, { type: "VERIFICATION_STARTED" });
    yield* verifyHarnessOutput(runId, paths).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "verifying", error),
      ),
    );
    yield* appendEvent(runId, paths, {
      payload: { verificationResultPath: "verification-result.json" },
      type: "VERIFICATION_COMPLETED",
    });
    yield* runReviewPhase(runId, paths, spec, "evidence", options);
    yield* appendEvent(runId, paths, { type: "REPORT_STARTED" });
    yield* writeReport({ paths, runId, skillManifest, spec });
    const { snapshot } = yield* appendEvent(runId, paths, {
      payload: { reportPath: "report.md" },
      type: "REPORT_COMPLETED",
    });

    return {
      reportPath: paths.reportMarkdown,
      runDirectory: paths.root,
      runId,
      state: snapshot.state,
      status: "completed",
    } satisfies CommandSummary;
  });
}

export function resumeRun(runIdInput: string, options: WorkflowOptions = {}) {
  return Effect.gen(function* () {
    const runId = yield* parseRunIdEffect(runIdInput);
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);

    if (loaded.events.length === 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunHasNoEvents",
          message: `Run ${runId} has no events to resume.`,
          recoverable: false,
        }),
      );
    }

    const snapshot = snapshotFromReplay(loaded.events);
    if (snapshot.state === "completed") {
      return {
        reportPath: paths.reportMarkdown,
        runDirectory: paths.root,
        runId,
        state: snapshot.state,
        status: "completed",
      } satisfies CommandSummary;
    }

    return yield* Effect.fail(
      makeRuntimeError({
        code: "ResumeIncompletePrototype",
        message:
          "Prototype 1 can resume completed runs and validate logs, but cannot continue partial live work yet.",
        recoverable: false,
      }),
    );
  });
}

export function statusRun(
  runIdInput?: string,
  options: WorkflowOptions = {},
) {
  return Effect.gen(function* () {
    const runId =
      runIdInput === undefined
        ? yield* latestRunId(options)
        : yield* parseRunIdEffect(runIdInput);
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);

    if (loaded.events.length === 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunHasNoEvents",
          message: `Run ${runId} has no events.`,
          recoverable: false,
        }),
      );
    }

    const snapshot = snapshotFromReplay(loaded.events);
    return {
      reportPath:
        snapshot.state === "completed" ? paths.reportMarkdown : undefined,
      runDirectory: paths.root,
      runId,
      state: snapshot.state,
      status: statusFromState(snapshot.state),
    } satisfies CommandSummary;
  });
}

export function listRuns(options: WorkflowOptions = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);
    const exists = yield* fs.exists(store.runsRoot);
    if (!exists) {
      return [];
    }

    const entries = yield* fs.readDirectory(store.runsRoot);
    const runIds = entries
      .filter((entry) => entry.startsWith("run-"))
      .sort()
      .reverse()
      .map((entry) => parseRunId(entry));

    const summaries: Array<CommandSummary> = [];
    for (const runId of runIds) {
      const paths = yield* makeRunPaths(runId, options);
      const hasEvents = yield* fs.exists(paths.events);
      if (hasEvents) {
        summaries.push(yield* statusRun(runId, options));
      }
    }

    return summaries;
  });
}

const generateRunId = Effect.sync(() => parseRunId(`run-${nanoid()}`));

function latestRunId(options: WorkflowOptions) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);
    const exists = yield* fs.exists(store.latest);
    if (!exists) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "NoRunsFound",
          message: "No Gaia latest-run pointer found.",
          recoverable: false,
        }),
      );
    }

    const latest = (yield* fs.readFileString(store.latest)).trim();
    return yield* parseRunIdEffect(latest);
  });
}

function parseSpec(input: string, fallbackTitle: string) {
  return Effect.try({
    try: () => parseMarkdownSpec(input, fallbackTitle),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidSpec",
        message: "Spec markdown could not be parsed.",
        recoverable: false,
      }),
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

function recordRunFailure(
  runId: RunId,
  paths: RunPaths,
  stage: GaiaFailure["stage"],
  error: GaiaRuntimeError,
) {
  return Effect.gen(function* () {
    yield* appendEvent(runId, paths, {
      payload: failureToEventPayload(error, stage),
      type: "RUN_FAILED",
    });

    return yield* Effect.fail(error);
  });
}

function runReviewPhase(
  runId: RunId,
  paths: RunPaths,
  spec: ReturnType<typeof parseMarkdownSpec>,
  phase: ReviewPhase,
  options: ReviewerRunOptions,
) {
  return Effect.gen(function* () {
    const reviewPaths = reviewPathsForPhase(paths, phase);
    const reviewerName = reviewerNameFromOptions(options);
    yield* appendEvent(runId, paths, {
      payload: {
        phase,
        reviewerName,
      },
      type: "REVIEW_STARTED",
    });
    const review = yield* runReviewer(
      ReviewRunRequest.make({
        markdownPath: reviewPaths.markdown,
        phase,
        resultPath: reviewPaths.result,
        runId,
        sessionEvidencePath: reviewPaths.sessionEvidence,
        specBody: spec.body,
        specTitle: spec.title,
        verificationResultPath: paths.verificationResult,
        workerPlanPath: paths.workerPlanResult,
        workerResultPath: paths.workerResult,
        workspaceManifestPath: paths.workspaceManifest,
        workspacePath: paths.workspace,
      }),
      options,
    ).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "reviewing", error),
      ),
    );

    yield* appendEvent(runId, paths, {
      payload: {
        phase: review.phase,
        resultPath: review.resultPath,
        reviewPath: runRelative(paths, reviewPaths.markdown),
        reviewerSessionEvidencePath: runRelative(
          paths,
          reviewPaths.sessionEvidence,
        ),
        reviewerName: review.reviewerName,
        status: review.status,
      },
      type: "REVIEW_COMPLETED",
    });

    if (review.status === "blocked") {
      return yield* recordRunFailure(
        runId,
        paths,
        "reviewing",
        makeRuntimeError({
          code: "ReviewBlocked",
          message: `${review.phase} review blocked the run: ${review.summary}`,
          recoverable: true,
        }),
      );
    }

    return review;
  });
}

function reviewerNameFromOptions(options: ReviewerRunOptions) {
  return options.reviewer?.name ?? defaultReviewerName;
}

function reviewPathsForPhase(paths: RunPaths, phase: ReviewPhase) {
  switch (phase) {
    case "plan":
      return {
        markdown: paths.planReviewMarkdown,
        result: paths.planReviewResult,
        sessionEvidence: paths.planReviewerSession,
      };
    case "evidence":
      return {
        markdown: paths.evidenceReviewMarkdown,
        result: paths.evidenceReviewResult,
        sessionEvidence: paths.evidenceReviewerSession,
      };
  }
}

function statusFromState(state: RunState): CommandSummary["status"] {
  switch (state) {
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    case "created":
    case "preparingWorkspace":
    case "runningWorker":
    case "verifying":
    case "reporting":
      return "running";
  }
}

export function failureToEventPayload(
  error: GaiaRuntimeError,
  stage: GaiaFailure["stage"],
): Readonly<Record<string, Schema.Json>> {
  const failure = GaiaFailure.make({
    code: error.code,
    message: error.message,
    recoverable: error.recoverable,
    stage,
  });

  return {
    code: failure.code,
    message: failure.message,
    recoverable: failure.recoverable,
    stage: failure.stage,
  };
}
