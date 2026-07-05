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
import { Effect, FileSystem, Path, Schema } from "effect";
import { appendEvent, loadRun } from "./event-store.js";
import {
  browserEvidenceRecord,
  failedBrowserEvidence,
  parseBrowserEvidenceTargetUrl,
  playwrightBrowserEvidenceCollector,
  writeBrowserEvidence,
  writeEmptyBrowserEvidence,
  type BrowserEvidenceCollector,
  type BrowserEvidenceRecord,
  type BrowserEvidenceTargetUrl,
} from "./browser-evidence.js";
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
import {
  resolveRunProfile,
  writeRunProfile,
  type BrowserEvidenceRequirement,
  type RunProfileSource,
} from "./run-profile.js";
import {
  availablePreviewDeployment,
  previewDeploymentRecord,
  writeEmptyPreviewDeployment,
  writePreviewDeployment,
} from "./preview-deployment.js";
import { withRunStoreLock } from "./run-store-lock.js";
import {
  writeSkillManifest,
  type SkillManifestSource,
} from "./skill-manifest.js";
import {
  resolvedSkillPaths,
  writeSkillBundle,
  type SkillInstallerOptions,
} from "./skill-bundle.js";
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
  readonly browserEvidenceCollector?: BrowserEvidenceCollector;
  readonly browserEvidenceRequirement?: BrowserEvidenceRequirement;
  readonly browserEvidenceTargetUrl?: string;
  readonly codexHarness?: CodexHarnessOptions;
  readonly harnessName?: HarnessName;
  readonly processHarness?: ProcessHarnessConfig;
  readonly skillInstaller?: SkillInstallerOptions;
  readonly skillManifestSource?: SkillManifestSource;
  readonly runProfileSource?: RunProfileSource;
  readonly workspaceSource?: WorkspaceSource;
};

export type BrowserEvidenceCollectionOptions = RunStorageOptions & {
  readonly browserEvidenceCollector?: BrowserEvidenceCollector;
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
    const runProfile = yield* resolveRunProfile(options.runProfileSource);
    const browserEvidenceRequirement =
      options.browserEvidenceRequirement ??
      runProfile.checks.browserEvidence;
    const explicitBrowserEvidenceTargetUrl =
      options.browserEvidenceTargetUrl === undefined
        ? undefined
        : yield* parseBrowserEvidenceTargetUrlEffect(
            options.browserEvidenceTargetUrl,
          );
    yield* fs.makeDirectory(paths.root, { recursive: true });
    yield* fs.writeFileString(paths.input, input);
    yield* fs.writeFileString(paths.latest, runId);
    yield* writeRunProfile({ paths, profile: runProfile }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "creating", error),
      ),
    );

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
    const skillBundle = yield* writeSkillBundle({
      manifest: skillManifest,
      paths,
      ...(options.skillInstaller === undefined
        ? {}
        : { installer: options.skillInstaller }),
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
    yield* writeEmptyPreviewDeployment({ paths }).pipe(
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
        resolvedSkillPaths: [...resolvedSkillPaths(skillBundle)],
        runId,
        skillBundlePath: paths.skillBundle,
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
    const previewDeploymentTargetUrl = harnessResult.previewDeploymentUrl;
    yield* appendEvent(runId, paths, {
      payload: {
        ...(harnessResult.browserTargetUrl === undefined
          ? {}
          : { browserTargetUrl: harnessResult.browserTargetUrl }),
        harnessName: harnessResult.harnessName,
        outputArtifacts: harnessResult.outputArtifacts,
        ...(previewDeploymentTargetUrl === undefined
          ? {}
          : { previewDeploymentUrl: previewDeploymentTargetUrl }),
        workerResultPath: harnessResult.resultPath,
      },
      type: "WORKER_COMPLETED",
    });
    if (previewDeploymentTargetUrl !== undefined) {
      yield* recordPreviewDeployment(
        runId,
        paths,
        previewDeploymentTargetUrl,
      ).pipe(
        Effect.catchTag("GaiaRuntimeError", (error) =>
          recordRunFailure(runId, paths, "runningWorker", error),
        ),
      );
    }
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
    const browserEvidenceTargetUrl = selectBrowserEvidenceTargetUrl({
      explicitTargetUrl: explicitBrowserEvidenceTargetUrl,
      harnessTargetUrl: harnessResult.browserTargetUrl,
      previewDeploymentTargetUrl,
      profileTargetUrl: runProfile.browser?.targetUrl,
    });
    if (
      browserEvidenceRequirement === "required" &&
      browserEvidenceTargetUrl === undefined
    ) {
      return yield* recordRunFailure(
        runId,
        paths,
        "reporting",
        browserEvidenceTargetRequiredError(),
      );
    }
    if (browserEvidenceTargetUrl !== undefined) {
      const browserEvidenceRecord = yield* recordBrowserEvidence(
        runId,
        paths,
        browserEvidenceTargetUrl,
        options,
      ).pipe(
        Effect.catchTag("GaiaRuntimeError", (error) =>
          recordRunFailure(runId, paths, "reporting", error),
        ),
      );
      yield* requireBrowserEvidencePolicy(
        browserEvidenceRecord,
        browserEvidenceRequirement,
      ).pipe(
        Effect.catchTag("GaiaRuntimeError", (error) =>
          recordRunFailure(runId, paths, "reporting", error),
        ),
      );
    }
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

function selectBrowserEvidenceTargetUrl(input: {
  readonly explicitTargetUrl?: BrowserEvidenceTargetUrl | undefined;
  readonly harnessTargetUrl?: BrowserEvidenceTargetUrl | undefined;
  readonly previewDeploymentTargetUrl?: BrowserEvidenceTargetUrl | undefined;
  readonly profileTargetUrl?: BrowserEvidenceTargetUrl | undefined;
}) {
  return (
    input.explicitTargetUrl ??
    input.profileTargetUrl ??
    input.previewDeploymentTargetUrl ??
    input.harnessTargetUrl
  );
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

export function collectBrowserEvidence(
  runIdInput: string,
  targetUrlInput: string,
  options: BrowserEvidenceCollectionOptions = {},
) {
  return withRunStoreLock(
    options,
    collectBrowserEvidenceUnlocked(runIdInput, targetUrlInput, options),
  );
}

function collectBrowserEvidenceUnlocked(
  runIdInput: string,
  targetUrlInput: string,
  options: BrowserEvidenceCollectionOptions,
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const targetUrl = yield* parseBrowserEvidenceTargetUrlEffect(targetUrlInput);
    const run = yield* statusRun(runIdInput, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before collecting browser evidence.`,
          recoverable: false,
        }),
      );
    }

    const paths = yield* makeRunPaths(run.runId, { rootDirectory });
    return yield* recordBrowserEvidence(run.runId, paths, targetUrl, options);
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

function recordBrowserEvidence(
  runId: RunId,
  paths: RunPaths,
  targetUrl: BrowserEvidenceTargetUrl,
  options: Readonly<{
    readonly browserEvidenceCollector?: BrowserEvidenceCollector;
  }>,
) {
  return Effect.gen(function* () {
    const collector =
      options.browserEvidenceCollector ?? playwrightBrowserEvidenceCollector;
    const captured = yield* collector({ paths, targetUrl }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        Effect.succeed(
          failedBrowserEvidence({
            message: error.message,
            targetUrl,
          }),
        ),
      ),
    );
    const evidence = yield* writeBrowserEvidence({ evidence: captured, paths });
    const record = browserEvidenceRecord({
      evidence,
      paths,
      runId,
      targetUrl,
    });

    yield* appendEvent(runId, paths, {
      payload: {
        evidencePath: runRelative(paths, paths.browserEvidence),
        status: record.status,
        targetUrl,
      },
      type: "BROWSER_EVIDENCE_RECORDED",
    });

    return record;
  });
}

function recordPreviewDeployment(
  runId: RunId,
  paths: RunPaths,
  targetUrl: BrowserEvidenceTargetUrl,
) {
  return Effect.gen(function* () {
    const deployment = yield* writePreviewDeployment({
      deployment: availablePreviewDeployment({ url: targetUrl }),
      paths,
    });
    const record = previewDeploymentRecord({
      deployment,
      paths,
      runId,
    });

    yield* appendEvent(runId, paths, {
      payload: {
        deploymentPath: record.deploymentPath,
        status: record.status,
        ...(record.url === undefined ? {} : { url: record.url }),
      },
      type: "PREVIEW_DEPLOYMENT_RECORDED",
    });

    return record;
  });
}

function requireBrowserEvidencePolicy(
  record: BrowserEvidenceRecord,
  requirement: BrowserEvidenceRequirement,
): Effect.Effect<void, GaiaRuntimeError> {
  if (requirement === "optional" || record.status === "collected") {
    return Effect.void;
  }

  return Effect.fail(
    makeRuntimeError({
      code: "RequiredBrowserEvidenceFailed",
      message: `Browser evidence is required for this run, but capture status was '${record.status}'.`,
      recoverable: true,
    }),
  );
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
        browserEvidencePath: paths.browserEvidence,
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

function parseBrowserEvidenceTargetUrlEffect(input: string) {
  return Effect.try({
    try: () => parseBrowserEvidenceTargetUrl(input),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "BrowserEvidenceTargetUrlInvalid",
        message: `Browser evidence target URL '${input}' must be a valid HTTP or HTTPS URL.`,
        recoverable: false,
      }),
  });
}

function browserEvidenceTargetRequiredError() {
  return makeRuntimeError({
    code: "BrowserEvidenceTargetRequired",
    message:
      "Browser evidence is required for this run, but no browser target URL was provided or discovered.",
    recoverable: false,
  });
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
