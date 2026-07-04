import {
  GaiaFailure,
  parseMarkdownSpec,
  parseRunId,
  snapshotFromReplay,
  type RunId,
  type RunState,
} from "@gaia/core";
import { customAlphabet } from "nanoid";
import { Effect, FileSystem, Path, type Schema } from "effect";
import { appendEvent, loadRun } from "./event-store.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import { runFakeWorker } from "./fake-worker.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import { writeReport } from "./report-writer.js";
import { verifyFakeWorkerOutput } from "./verifier.js";
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

export type WorkflowOptions = RunStorageOptions & {
  readonly workspaceSource?: WorkspaceSource;
};

export function runSpecFile(specPath: string, options: WorkflowOptions = {}) {
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
    yield* appendEvent(runId, paths, { type: "WORKER_STARTED" });
    yield* runFakeWorker(runId, paths);
    yield* appendEvent(runId, paths, {
      payload: { workerResultPath: "worker-result.json" },
      type: "WORKER_COMPLETED",
    });
    yield* appendEvent(runId, paths, { type: "VERIFICATION_STARTED" });
    yield* verifyFakeWorkerOutput(runId, paths).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "verifying", error),
      ),
    );
    yield* appendEvent(runId, paths, {
      payload: { verificationResultPath: "verification-result.json" },
      type: "VERIFICATION_COMPLETED",
    });
    yield* appendEvent(runId, paths, { type: "REPORT_STARTED" });
    yield* writeReport({ paths, runId, spec });
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
      summaries.push(yield* statusRun(runId, options));
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
