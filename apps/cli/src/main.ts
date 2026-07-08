#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  BrowserEvidenceRecord,
  BrowserEvidenceRequirement,
  CommandSummary,
  DoctorSummary,
  GitHubChecksRecord,
  GitHubChecksSummary,
  GitHubCiWatchSummary,
  GitHubPrFeedbackSummary,
  GitHubPrCommentSummary,
  GitHubPrLoopSummary,
  GitHubRemediationSpecSummary,
  LinearIssueGraphSummary,
  MergeDecisionSummary,
  GitHubPublishPreflightSummary,
  GitHubPublishPreview,
  GitHubPrSummary,
  LocalRunArtifact,
  LocalRunEvents,
  LocalRunReadDiagnostic,
  WorkspacePrQualityGate,
  WorkspacePrQualityGateItem,
} from "@gaia/runtime";
import {
  GaiaRuntimeError,
  collectBrowserEvidence,
  commentGitHubPullRequest,
  coordinateGitHubPrLoop,
  createGitHubRemediationSpec,
  doctor,
  inspectGitHubChecks,
  listRuns,
  localDirectoryWorkspaceSource,
  localRunProfileSource,
  localSkillManifestSource,
  makeCodexReviewer,
  makeCodexReviewerConfig,
  makeCodexHarnessConfig,
  makeRuntimeError,
  makeProcessHarnessConfig,
  parseHarnessName,
  preflightGitHubPublish,
  previewGitHubPublish,
  publishRunToGitHub,
  publishWorkspaceRunToGitHub,
  recordLinearIssueGraph,
  recordMergeDecision,
  recordGitHubChecks,
  resumeRun,
  readLocalRunArtifact,
  readLocalRunEvents,
  runSpecFile,
  statusRun,
  watchGitHubChecks,
  watchGitHubFeedback,
} from "@gaia/runtime";
import { runLocalGaiaServer } from "@gaia/server";
import {
  createRunFromServer,
  ensureLocalServer,
  readLocalRunArtifactFromServer,
  readLocalRunEventsFromServer,
  listRunsFromServer,
  statusRunFromServer,
  type ServerRunAcceptedSummary,
} from "./server-read-client.js";
import path from "node:path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

type FailureOutput = {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly status: "failed";
};

const specFile = Argument.string("spec-file");
const linearIssueGraphFile = Argument.string("linear-issue-graph-file");
const runId = Argument.string("run-id");
const pullRequest = Argument.string("pull-request");
const artifactName = Argument.string("artifact-name");
const optionalRunId = runId.pipe(Argument.optional);
const optionalPullRequest = pullRequest.pipe(Argument.optional);
const browserTargetUrl = Flag.string("url").pipe(
  Flag.withDescription("HTTP or HTTPS URL to capture browser evidence from."),
);
const browserRunTargetUrl = Flag.string("browser-url").pipe(
  Flag.withDescription(
    "HTTP or HTTPS URL to capture during a run before evidence review.",
  ),
  Flag.optional,
);
const requireBrowserEvidence = Flag.boolean("require-browser-evidence").pipe(
  Flag.withDescription(
    "Fail the run unless browser evidence is captured successfully.",
  ),
);
const json = Flag.boolean("json").pipe(
  Flag.withDescription("Write a machine-readable JSON response."),
);
const serverUrl = Flag.string("server-url").pipe(
  Flag.withDescription(
    "Opt into read-only CLI reads through an already-running local Gaia API server.",
  ),
  Flag.optional,
);
const serverMode = Flag.boolean("server").pipe(
  Flag.withDescription(
    "Opt into the workspace local Gaia server, autostarting it when needed.",
  ),
);
const serverPort = Flag.string("port").pipe(
  Flag.withDescription("Bind the foreground local Gaia server to an explicit loopback port."),
  Flag.optional,
);
const workspaceSource = Flag.string("workspace-source").pipe(
  Flag.withDescription("Copy a local directory into the run workspace."),
  Flag.optional,
);
const skillManifest = Flag.string("skill-manifest").pipe(
  Flag.withDescription("Record a JSON skill manifest as run evidence."),
  Flag.optional,
);
const runProfile = Flag.string("profile").pipe(
  Flag.withDescription(
    "Select a run profile by name from profiles/<name>.json, or pass a JSON file path.",
  ),
  Flag.optional,
);
const baseBranch = Flag.string("base").pipe(
  Flag.withDescription("Base branch for a Gaia GitHub pull request."),
  Flag.optional,
);
const workspacePreview = Flag.boolean("workspace").pipe(
  Flag.withDescription("Preview a workspace-change PR instead of evidence-only PR."),
);
const waitForTerminal = Flag.boolean("wait").pipe(
  Flag.withDescription("Poll until GitHub checks are no longer pending."),
);
const harness = Flag.string("harness").pipe(
  Flag.withDescription("Select the worker harness adapter."),
  Flag.optional,
);
const reviewer = Flag.string("reviewer").pipe(
  Flag.withDescription(
    "Select the reviewer adapter. Supported values: deterministic, codex.",
  ),
  Flag.optional,
);
const harnessCommand = Flag.string("harness-command").pipe(
  Flag.withDescription("Executable command for the process harness."),
  Flag.optional,
);
const harnessArg = Flag.string("harness-arg").pipe(
  Flag.withDescription("Argument for the process harness command. Repeatable."),
  Flag.atLeast(0),
);
const codexCommand = Flag.string("codex-command").pipe(
  Flag.withDescription("Codex executable command for the Codex harness."),
  Flag.optional,
);
const codexArg = Flag.string("codex-arg").pipe(
  Flag.withDescription("Extra argument for `codex exec`. Repeatable."),
  Flag.atLeast(0),
);
const codexModel = Flag.string("codex-model").pipe(
  Flag.withDescription("Model passed to `codex exec --model`."),
  Flag.optional,
);
const codexProfile = Flag.string("codex-profile").pipe(
  Flag.withDescription("Codex profile passed to `codex exec --profile`."),
  Flag.optional,
);
const codexSandbox = Flag.string("codex-sandbox").pipe(
  Flag.withDescription(
    "Codex sandbox mode. Supported values: read-only, workspace-write.",
  ),
  Flag.optional,
);
const codexTimeoutMs = Flag.string("codex-timeout-ms").pipe(
  Flag.withDescription("Maximum Codex command runtime in milliseconds."),
  Flag.optional,
);

const run = Command.make("run", {
  browserRunTargetUrl,
  codexArg,
  codexCommand,
  codexModel,
  codexProfile,
  codexSandbox,
  codexTimeoutMs,
  harness,
  harnessArg,
  harnessCommand,
  json,
  requireBrowserEvidence,
  reviewer,
  runProfile,
  serverMode,
  skillManifest,
  specFile,
  workspaceSource,
}).pipe(
  Command.withDescription("Start a new Gaia run from a Markdown spec."),
  Command.withHandler(
    ({
      browserRunTargetUrl,
      harness,
      harnessArg,
      harnessCommand,
      json,
      requireBrowserEvidence,
      reviewer,
      runProfile,
      serverMode,
      skillManifest,
      specFile,
      workspaceSource,
      codexArg,
      codexCommand,
      codexModel,
      codexProfile,
      codexSandbox,
      codexTimeoutMs,
    }) =>
      renderEffect(
        runCommand({
          browserRunTargetUrl,
          codexArg,
          codexCommand,
          codexModel,
          codexProfile,
          codexSandbox,
          codexTimeoutMs,
          harness,
          harnessArg,
          harnessCommand,
          requireBrowserEvidence,
          reviewer,
          runProfile,
          serverMode,
          skillManifest,
          specFile,
          workspaceSource,
        }),
        json,
        renderRunCommandSummary,
      ),
  ),
);

const resume = Command.make("resume", { json, runId }).pipe(
  Command.withDescription("Replay and validate an existing Gaia run."),
  Command.withHandler(({ json, runId }) =>
    renderEffect(resumeRun(runId, workflowOptions()), json, renderSummary),
  ),
);

const status = Command.make("status", {
  json,
  runId: optionalRunId,
  serverMode,
  serverUrl,
}).pipe(
  Command.withDescription("Show the latest run status or a specific run status."),
  Command.withHandler(({ json, runId, serverMode, serverUrl }) =>
    renderEffect(
      readStatus({
        ...serverUrlInput(Option.getOrUndefined(serverUrl)),
        ...(Option.isSome(runId) ? { runId: runId.value } : {}),
        serverMode,
      }),
      json,
      renderSummary,
    ),
  ),
);

const doctorCommand = Command.make("doctor", { json }).pipe(
  Command.withDescription("Inspect local Gaia prerequisites."),
  Command.withHandler(({ json }) =>
    renderEffect(
      doctor({ rootDirectory: invocationRoot() }),
      json,
      renderDoctorSummary,
    ),
  ),
);

const list = Command.make("list", { json, serverMode, serverUrl }).pipe(
  Command.withDescription("List known Gaia runs."),
  Command.withHandler(({ json, serverMode, serverUrl }) =>
    renderEffect(
      readList({
        ...serverUrlInput(Option.getOrUndefined(serverUrl)),
        serverMode,
      }),
      json,
      renderRunList,
    ),
  ),
);

const events = Command.make("events", { json, runId, serverMode, serverUrl }).pipe(
  Command.withDescription("Read a Gaia run's event log."),
  Command.withHandler(({ json, runId, serverMode, serverUrl }) =>
    renderEffect(
      readEvents({
        ...serverUrlInput(Option.getOrUndefined(serverUrl)),
        runId,
        serverMode,
      }),
      json,
      renderRunEvents,
    ),
  ),
);

const artifact = Command.make("artifact", {
  runId,
  artifactName,
  json,
  serverUrl,
}).pipe(
  Command.withDescription("Read an allowlisted Gaia run artifact."),
  Command.withHandler(({ artifactName, json, runId, serverUrl }) =>
    renderEffect(
      readArtifact({
        ...serverUrlInput(Option.getOrUndefined(serverUrl)),
        artifactName,
        runId,
      }),
      json,
      renderRunArtifact,
    ),
  ),
);

const publishPr = Command.make("publish-pr", { baseBranch, json, runId }).pipe(
  Command.withDescription("Publish a completed Gaia run as a draft GitHub PR."),
  Command.withHandler(({ baseBranch, json, runId }) =>
    renderEffect(
      publishRunToGitHub(runId, githubPublishOptions({ baseBranch })),
      json,
      renderGitHubPrSummary,
    ),
  ),
);

const preflightGithub = Command.make("preflight-github", {
  baseBranch,
  json,
  runId,
}).pipe(
  Command.withDescription("Check whether a completed Gaia run can publish to GitHub."),
  Command.withHandler(({ baseBranch, json, runId }) =>
    renderEffect(
      preflightGitHubPublish(runId, githubPublishOptions({ baseBranch })),
      json,
      renderGitHubPreflightSummary,
    ),
  ),
);

const previewPr = Command.make("preview-pr", {
  baseBranch,
  json,
  runId,
  workspacePreview,
}).pipe(
  Command.withDescription("Preview the GitHub PR commands Gaia would run."),
  Command.withHandler(({ baseBranch, json, runId, workspacePreview }) =>
    renderEffect(
      previewGitHubPublish(runId, {
        ...githubPublishOptions({ baseBranch }),
        mode: workspacePreview ? "workspace" : "evidence",
      }),
      json,
      renderGitHubPublishPreview,
    ),
  ),
);

const publishWorkspacePr = Command.make("publish-workspace-pr", {
  baseBranch,
  json,
  runId,
}).pipe(
  Command.withDescription(
    "Publish completed Gaia workspace changes as a draft GitHub PR.",
  ),
  Command.withHandler(({ baseBranch, json, runId }) =>
    renderEffect(
      publishWorkspaceRunToGitHub(runId, githubPublishOptions({ baseBranch })),
      json,
      renderGitHubPrSummary,
    ),
  ),
);

const prChecks = Command.make("pr-checks", { json, pullRequest }).pipe(
  Command.withDescription("Inspect GitHub checks for a pull request."),
  Command.withHandler(({ json, pullRequest }) =>
    renderEffect(
      inspectGitHubChecks(pullRequest, { rootDirectory: invocationRoot() }),
      json,
      renderGitHubChecksSummary,
    ),
  ),
);

const checks = Command.make("checks", {
  runId,
  pullRequest,
  json,
  waitForTerminal,
}).pipe(
  Command.withDescription("Record GitHub check evidence against a Gaia run."),
  Command.withHandler(({ json, pullRequest, runId, waitForTerminal }) =>
    renderEffect(
      recordGitHubChecks(runId, pullRequest, {
        rootDirectory: invocationRoot(),
        waitForTerminal,
      }),
      json,
      renderGitHubChecksRecord,
    ),
  ),
);

const watchCi = Command.make("watch-ci", {
  json,
  runId,
  pullRequest: optionalPullRequest,
}).pipe(
  Command.withDescription(
    "Resume or start a bounded GitHub CI watcher for a Gaia run.",
  ),
  Command.withHandler(({ json, pullRequest, runId }) =>
    renderEffect(
      watchGitHubChecks(runId, {
        rootDirectory: invocationRoot(),
        ...(Option.isSome(pullRequest)
          ? { pullRequest: pullRequest.value }
          : {}),
      }),
      json,
      renderGitHubCiWatchSummary,
    ),
  ),
);

const watchPrFeedback = Command.make("watch-pr-feedback", {
  json,
  runId,
  pullRequest,
}).pipe(
  Command.withDescription(
    "Record human GitHub pull request feedback against a Gaia run.",
  ),
  Command.withHandler(({ json, pullRequest, runId }) =>
    renderEffect(
      watchGitHubFeedback(runId, pullRequest, {
        rootDirectory: invocationRoot(),
      }),
      json,
      renderGitHubPrFeedbackSummary,
    ),
  ),
);

const prLoop = Command.make("pr-loop", {
  json,
  runId,
  pullRequest,
}).pipe(
  Command.withDescription(
    "Record CI and review feedback, then recommend the next PR-loop action.",
  ),
  Command.withHandler(({ json, pullRequest, runId }) =>
    renderEffect(
      coordinateGitHubPrLoop(runId, pullRequest, {
        rootDirectory: invocationRoot(),
      }),
      json,
      renderGitHubPrLoopSummary,
    ),
  ),
);

const planRemediation = Command.make("plan-remediation", {
  json,
  runId,
}).pipe(
  Command.withDescription(
    "Create a follow-up remediation spec from a blocked PR-loop state.",
  ),
  Command.withHandler(({ json, runId }) =>
    renderEffect(
      createGitHubRemediationSpec(runId, {
        rootDirectory: invocationRoot(),
      }),
      json,
      renderGitHubRemediationSpecSummary,
    ),
  ),
);

const commentPr = Command.make("comment-pr", {
  json,
  runId,
  pullRequest,
}).pipe(
  Command.withDescription(
    "Publish a timestamped Gaia evidence comment to a GitHub PR.",
  ),
  Command.withHandler(({ json, pullRequest, runId }) =>
    renderEffect(
      commentGitHubPullRequest(runId, pullRequest, {
        rootDirectory: invocationRoot(),
      }),
      json,
      renderGitHubPrCommentSummary,
    ),
  ),
);

const linearIssue = Command.make("linear-issue", {
  json,
  runId,
  linearIssueGraphFile,
}).pipe(
  Command.withDescription(
    "Record a Linear issue graph JSON snapshot against a Gaia run.",
  ),
  Command.withHandler(({ json, linearIssueGraphFile, runId }) =>
    renderEffect(
      recordLinearIssueGraph(
        runId,
        resolveInvocationPath(linearIssueGraphFile),
        {
          rootDirectory: invocationRoot(),
        },
      ),
      json,
      renderLinearIssueGraphSummary,
    ),
  ),
);

const mergeDecision = Command.make("merge-decision", {
  json,
  runId,
}).pipe(
  Command.withDescription(
    "Record Gaia's explicit merge decision for a completed run.",
  ),
  Command.withHandler(({ json, runId }) =>
    renderEffect(
      recordMergeDecision(runId, {
        rootDirectory: invocationRoot(),
      }),
      json,
      renderMergeDecisionSummary,
    ),
  ),
);

const collectBrowserEvidenceCommand = Command.make("collect-browser-evidence", {
  browserTargetUrl,
  json,
  runId,
}).pipe(
  Command.withDescription("Collect screenshot and console evidence for a completed run."),
  Command.withHandler(({ browserTargetUrl, json, runId }) =>
    renderEffect(
      collectBrowserEvidence(runId, browserTargetUrl, {
        rootDirectory: invocationRoot(),
      }),
      json,
      renderBrowserEvidenceRecord,
    ),
  ),
);

const serverCommand = Command.make("server", { port: serverPort }).pipe(
  Command.withDescription("Start the local Gaia API server in the foreground."),
  Command.withHandler(({ port }) =>
    renderEffect(
      parseServerPortFlag(port).pipe(
        Effect.flatMap((parsedPort) =>
          runLocalGaiaServer({
            rootDirectory: invocationRoot(),
            ...(parsedPort === undefined ? {} : { port: parsedPort }),
          }),
        ),
      ),
      false,
      () => "",
    ),
  ),
);

const cli = Command.make("gaia").pipe(
  Command.withDescription("Gaia software-factory control plane prototype."),
  Command.withSubcommands([
    run,
    doctorCommand,
    resume,
    status,
    list,
    events,
    artifact,
    serverCommand,
    collectBrowserEvidenceCommand,
    preflightGithub,
    previewPr,
    publishPr,
    publishWorkspacePr,
    prChecks,
    checks,
    watchCi,
    watchPrFeedback,
    prLoop,
    planRemediation,
    commentPr,
    linearIssue,
    mergeDecision,
  ]),
);

const command = Command.run(cli, { version: "0.1.0" });

function invocationRoot() {
  return process.env["INIT_CWD"] ?? process.cwd();
}

function workflowOptions(
  input: Readonly<{
    codexArgs?: ReadonlyArray<string>;
    codexCommand?: Option.Option<string>;
    codexModel?: Option.Option<string>;
    codexProfile?: Option.Option<string>;
    codexSandbox?: Option.Option<string>;
    codexTimeoutMs?: Option.Option<string>;
    browserEvidenceRequirement?: BrowserEvidenceRequirement | undefined;
    browserEvidenceTargetUrl?: Option.Option<string>;
    harness?: Option.Option<string>;
    harnessArgs?: ReadonlyArray<string>;
    harnessCommand?: Option.Option<string>;
    reviewer?: Option.Option<string>;
    runProfile?: Option.Option<string>;
    skillManifest?: Option.Option<string>;
    workspaceSource?: Option.Option<string>;
  }> = {},
) {
  const rootDirectory = invocationRoot();
  const workspaceSource = Option.map(
    input.workspaceSource ?? Option.none(),
    (source) => localDirectoryWorkspaceSource(resolveInvocationPath(source)),
  );
  const harnessName = Option.map(
    input.harness ?? Option.none(),
    parseHarnessName,
  );
  const harnessNameValue = Option.getOrUndefined(input.harness ?? Option.none());
  const codexHarness =
    harnessNameValue === "codex"
      ? {
          config: makeCodexHarnessConfig({
            command: Option.getOrUndefined(input.codexCommand ?? Option.none()),
            extraArgs: input.codexArgs ?? [],
            model: Option.getOrUndefined(input.codexModel ?? Option.none()),
            profile: Option.getOrUndefined(input.codexProfile ?? Option.none()),
            sandbox: Option.getOrUndefined(input.codexSandbox ?? Option.none()),
            timeoutMs: Option.getOrUndefined(
              input.codexTimeoutMs ?? Option.none(),
            ),
          }),
        }
      : undefined;
  const reviewer = makeReviewer({
    codexCommand: input.codexCommand,
    codexModel: input.codexModel,
    codexProfile: input.codexProfile,
    codexTimeoutMs: input.codexTimeoutMs,
    reviewer: input.reviewer,
  });
  const processHarness = Option.map(
    input.harnessCommand ?? Option.none(),
    (command) => makeProcessHarnessConfig(command, input.harnessArgs ?? []),
  );
  const skillManifestSource = Option.map(
    input.skillManifest ?? Option.none(),
    (source) => localSkillManifestSource(resolveInvocationPath(source)),
  );
  const runProfileSource = Option.map(
    input.runProfile ?? Option.none(),
    (source) => localRunProfileSource(resolveRunProfilePath(source)),
  );
  const browserEvidenceTargetUrl = input.browserEvidenceTargetUrl ?? Option.none();

  return {
    rootDirectory,
    ...(input.browserEvidenceRequirement === undefined
      ? {}
      : { browserEvidenceRequirement: input.browserEvidenceRequirement }),
    ...(Option.isSome(browserEvidenceTargetUrl)
      ? { browserEvidenceTargetUrl: browserEvidenceTargetUrl.value }
      : {}),
    ...(Option.isSome(workspaceSource)
      ? { workspaceSource: workspaceSource.value }
      : {}),
    ...(Option.isSome(harnessName) ? { harnessName: harnessName.value } : {}),
    ...(codexHarness === undefined ? {} : { codexHarness }),
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(Option.isSome(processHarness)
      ? { processHarness: processHarness.value }
      : {}),
    ...(Option.isSome(skillManifestSource)
      ? { skillManifestSource: skillManifestSource.value }
      : {}),
    ...(Option.isSome(runProfileSource)
      ? { runProfileSource: runProfileSource.value }
      : {}),
  };
}

function makeReviewer(
  input: Readonly<{
    codexCommand?: Option.Option<string> | undefined;
    codexModel?: Option.Option<string> | undefined;
    codexProfile?: Option.Option<string> | undefined;
    codexTimeoutMs?: Option.Option<string> | undefined;
    reviewer?: Option.Option<string> | undefined;
  }>,
) {
  const reviewerName = Option.getOrUndefined(input.reviewer ?? Option.none());

  if (reviewerName === undefined || reviewerName === "deterministic") {
    return undefined;
  }

  if (reviewerName === "codex") {
    return makeCodexReviewer({
      config: makeCodexReviewerConfig({
        command: Option.getOrUndefined(input.codexCommand ?? Option.none()),
        model: Option.getOrUndefined(input.codexModel ?? Option.none()),
        profile: Option.getOrUndefined(input.codexProfile ?? Option.none()),
        timeoutMs: Option.getOrUndefined(input.codexTimeoutMs ?? Option.none()),
      }),
    });
  }

  throw new Error(
    `Unknown reviewer '${reviewerName}'. Supported reviewers: deterministic, codex.`,
  );
}

function githubPublishOptions(
  input: Readonly<{
    baseBranch?: Option.Option<string>;
  }> = {},
) {
  const rootDirectory = invocationRoot();
  const baseBranch = Option.map(input.baseBranch ?? Option.none(), (branch) =>
    branch.trim(),
  );

  return {
    rootDirectory,
    ...(Option.isSome(baseBranch) ? { baseBranch: baseBranch.value } : {}),
  };
}

function resolveInvocationPath(input: string) {
  return path.resolve(invocationRoot(), input);
}

function resolveRunProfilePath(input: string) {
  return /^[A-Za-z0-9_-]+$/u.test(input)
    ? resolveInvocationPath(path.join("profiles", `${input}.json`))
    : resolveInvocationPath(input);
}

function serverUrlInput(serverUrl: string | undefined) {
  return serverUrl === undefined ? {} : { serverUrl };
}

function parseServerPortFlag(
  port: Option.Option<string>,
): Effect.Effect<number | undefined, GaiaRuntimeError> {
  if (Option.isNone(port)) {
    return Effect.succeed<number | undefined>(undefined);
  }

  if (!/^\d+$/u.test(port.value)) {
    return Effect.fail(
      makeRuntimeError({
        code: "InvalidServerPort",
        message: `Invalid local server port: ${port.value}`,
        recoverable: false,
      }),
    );
  }

  const parsed = Number(port.value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    return Effect.fail(
      makeRuntimeError({
        code: "InvalidServerPort",
        message: `Invalid local server port: ${port.value}`,
        recoverable: false,
      }),
    );
  }

  return Effect.succeed<number | undefined>(parsed);
}

type RunCommandSummary = CommandSummary | ServerRunAcceptedSummary;

function runCommand(input: {
  readonly browserRunTargetUrl: Option.Option<string>;
  readonly codexArg: ReadonlyArray<string>;
  readonly codexCommand: Option.Option<string>;
  readonly codexModel: Option.Option<string>;
  readonly codexProfile: Option.Option<string>;
  readonly codexSandbox: Option.Option<string>;
  readonly codexTimeoutMs: Option.Option<string>;
  readonly harness: Option.Option<string>;
  readonly harnessArg: ReadonlyArray<string>;
  readonly harnessCommand: Option.Option<string>;
  readonly requireBrowserEvidence: boolean;
  readonly reviewer: Option.Option<string>;
  readonly runProfile: Option.Option<string>;
  readonly serverMode: boolean;
  readonly skillManifest: Option.Option<string>;
  readonly specFile: string;
  readonly workspaceSource: Option.Option<string>;
}) {
  const specPath = resolveInvocationPath(input.specFile);
  if (input.serverMode) {
    return Effect.gen(function* () {
      yield* validateServerRunOptions(input);
      const serverUrl = yield* serverUrlFor({ serverMode: true });
      return yield* createRunFromServer({
        rootDirectory: invocationRoot(),
        serverUrl,
        specPath,
      });
    });
  }

  return runSpecFile(
    specPath,
    workflowOptions({
      harness: input.harness,
      harnessArgs: input.harnessArg,
      harnessCommand: input.harnessCommand,
      codexArgs: input.codexArg,
      codexCommand: input.codexCommand,
      codexModel: input.codexModel,
      codexProfile: input.codexProfile,
      codexSandbox: input.codexSandbox,
      codexTimeoutMs: input.codexTimeoutMs,
      browserEvidenceRequirement: input.requireBrowserEvidence
        ? "required"
        : undefined,
      browserEvidenceTargetUrl: input.browserRunTargetUrl,
      runProfile: input.runProfile,
      skillManifest: input.skillManifest,
      reviewer: input.reviewer,
      workspaceSource: input.workspaceSource,
    }),
  );
}

function validateServerRunOptions(input: {
  readonly browserRunTargetUrl: Option.Option<string>;
  readonly codexArg: ReadonlyArray<string>;
  readonly codexCommand: Option.Option<string>;
  readonly codexModel: Option.Option<string>;
  readonly codexProfile: Option.Option<string>;
  readonly codexSandbox: Option.Option<string>;
  readonly codexTimeoutMs: Option.Option<string>;
  readonly harness: Option.Option<string>;
  readonly harnessArg: ReadonlyArray<string>;
  readonly harnessCommand: Option.Option<string>;
  readonly requireBrowserEvidence: boolean;
  readonly reviewer: Option.Option<string>;
  readonly runProfile: Option.Option<string>;
  readonly skillManifest: Option.Option<string>;
  readonly workspaceSource: Option.Option<string>;
}) {
  const unsupported = [
    optionName(input.browserRunTargetUrl, "--browser-url"),
    optionName(input.codexCommand, "--codex-command"),
    optionName(input.codexModel, "--codex-model"),
    optionName(input.codexProfile, "--codex-profile"),
    optionName(input.codexSandbox, "--codex-sandbox"),
    optionName(input.codexTimeoutMs, "--codex-timeout-ms"),
    optionName(input.harness, "--harness"),
    optionName(input.harnessCommand, "--harness-command"),
    optionName(input.reviewer, "--reviewer"),
    optionName(input.runProfile, "--profile"),
    optionName(input.skillManifest, "--skill-manifest"),
    optionName(input.workspaceSource, "--workspace-source"),
    input.codexArg.length > 0 ? "--codex-arg" : undefined,
    input.harnessArg.length > 0 ? "--harness-arg" : undefined,
    input.requireBrowserEvidence ? "--require-browser-evidence" : undefined,
  ].filter((name): name is string => name !== undefined);

  if (unsupported.length === 0) {
    return Effect.void;
  }

  return Effect.fail(
    makeRuntimeError({
      code: "UnsupportedServerRunOption",
      message: `--server run mode only accepts a Markdown spec path and --json in this slice. Unsupported flags: ${unsupported.join(", ")}.`,
      recoverable: false,
    }),
  );
}

function optionName(option: Option.Option<string>, name: string) {
  return Option.isSome(option) ? name : undefined;
}

function readStatus(input: {
  readonly runId?: string;
  readonly serverMode: boolean;
  readonly serverUrl?: string;
}) {
  if (!input.serverMode && input.serverUrl === undefined) {
    return statusRun(input.runId, workflowOptions());
  }

  return serverUrlFor(input).pipe(
    Effect.flatMap((serverUrl) =>
      statusRunFromServer({
        rootDirectory: invocationRoot(),
        serverUrl,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
      }),
    ),
  );
}

function readList(input: { readonly serverMode: boolean; readonly serverUrl?: string }) {
  if (!input.serverMode && input.serverUrl === undefined) {
    return listRuns(workflowOptions());
  }

  return serverUrlFor(input).pipe(
    Effect.flatMap((serverUrl) =>
      listRunsFromServer({
        rootDirectory: invocationRoot(),
        serverUrl,
      }),
    ),
  );
}

function readEvents(input: {
  readonly runId: string;
  readonly serverMode: boolean;
  readonly serverUrl?: string;
}) {
  if (!input.serverMode && input.serverUrl === undefined) {
    return readLocalRunEvents(input.runId, workflowOptions());
  }

  return serverUrlFor(input).pipe(
    Effect.flatMap((serverUrl) =>
      readLocalRunEventsFromServer({
        runId: input.runId,
        serverUrl,
      }),
    ),
  );
}

function readArtifact(input: {
  readonly artifactName: string;
  readonly runId: string;
  readonly serverUrl?: string;
}) {
  if (input.serverUrl === undefined) {
    return readLocalRunArtifact(
      input.runId,
      input.artifactName,
      workflowOptions(),
    );
  }

  return readLocalRunArtifactFromServer({
    artifactName: input.artifactName,
    runId: input.runId,
    serverUrl: input.serverUrl,
  });
}

function serverUrlFor(input: {
  readonly serverMode: boolean;
  readonly serverUrl?: string;
}) {
  if (input.serverUrl !== undefined) {
    return Effect.succeed(input.serverUrl);
  }

  if (input.serverMode) {
    return ensureLocalServer({ rootDirectory: invocationRoot() });
  }

  return Effect.fail(
    makeRuntimeError({
      code: "ServerModeDisabled",
      message: "Server mode was not requested.",
      recoverable: false,
    }),
  );
}

function renderEffect<A>(
  effect: Effect.Effect<A, unknown, NodeServices.NodeServices>,
  json: boolean,
  renderSuccess: (value: A) => string,
) {
  return effect.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.gen(function* () {
          const failure = failureOutput(error);
          yield* Console.log(
            json ? JSON.stringify(failure, null, 2) : renderFailure(failure),
          );
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }),
      onSuccess: (value) =>
        Console.log(
          json ? JSON.stringify(value, null, 2) : renderSuccess(value),
        ),
    }),
  );
}

function failureOutput(error: unknown): FailureOutput {
  if (error instanceof GaiaRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      status: "failed",
    };
  }

  if (error instanceof Error) {
    return {
      code: "UnexpectedFailure",
      message: error.message,
      recoverable: false,
      status: "failed",
    };
  }

  if (isLocalRunReadDiagnostic(error)) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      status: "failed",
    };
  }

  return {
    code: "UnexpectedFailure",
    message: "Gaia command failed.",
    recoverable: false,
    status: "failed",
  };
}

function isLocalRunReadDiagnostic(
  input: unknown,
): input is LocalRunReadDiagnostic {
  return (
    typeof input === "object" &&
    input !== null &&
    "code" in input &&
    typeof input.code === "string" &&
    "message" in input &&
    typeof input.message === "string" &&
    "recoverable" in input &&
    typeof input.recoverable === "boolean"
  );
}

function renderFailure(failure: FailureOutput) {
  return [
    `Gaia command failed: ${failure.message}`,
    `code: ${failure.code}`,
    `recoverable: ${failure.recoverable}`,
  ].join("\n");
}

function renderSummary(summary: CommandSummary) {
  const harnessProgressLine =
    summary.harnessProgressPath === undefined
      ? undefined
      : `harness progress: ${summary.harnessProgressPath}`;
  const reportLine =
    summary.reportPath === undefined ? undefined : `report: ${summary.reportPath}`;
  const lines = [
    `${summary.status === "completed" ? "completed" : summary.status}: ${summary.runId}`,
    `state: ${summary.state}`,
    `run: ${summary.runDirectory}`,
  ];

  return [...lines, harnessProgressLine, reportLine]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderRunCommandSummary(summary: RunCommandSummary) {
  if (summary.status === "accepted") {
    return renderServerRunAccepted(summary);
  }

  return renderSummary(summary);
}

function renderServerRunAccepted(summary: ServerRunAcceptedSummary) {
  return [
    `accepted: ${summary.runId}`,
    `server: ${summary.serverUrl}`,
    `run: ${summary.urls.run}`,
    `activity: ${summary.urls.activity}`,
  ].join("\n");
}

function renderRunList(summaries: ReadonlyArray<CommandSummary>) {
  if (summaries.length === 0) {
    return "No Gaia runs found.";
  }

  return summaries
    .map((summary) => `${summary.runId} ${summary.status} ${summary.state}`)
    .join("\n");
}

function renderRunEvents(events: LocalRunEvents) {
  if (events.events.length === 0) {
    return `events: ${events.runId}\ncount: 0`;
  }

  return [
    `events: ${events.runId}`,
    `count: ${events.events.length}`,
    ...events.events.map((event) => `${event.timestamp} ${event.type}`),
  ].join("\n");
}

function renderRunArtifact(artifact: LocalRunArtifact) {
  return artifact.body;
}

function renderDoctorSummary(summary: DoctorSummary) {
  return [
    `doctor: ${summary.status}`,
    ...summary.checks.map(
      (check) => `- ${check.name}: ${check.status} - ${check.detail}`,
    ),
  ].join("\n");
}

function renderBrowserEvidenceRecord(record: BrowserEvidenceRecord) {
  const lines = [
    `browser evidence: ${record.status}`,
    `run: ${record.runId}`,
    `target: ${record.targetUrl}`,
    `evidence: ${record.evidencePath}`,
    `pages: ${record.pages.length}`,
  ];

  if (record.pages.length === 0) {
    return lines.join("\n");
  }

  return [
    ...lines,
    ...record.pages.flatMap((page) => [
      `- ${page.url}`,
      ...page.screenshots.map(
        (screenshot) => `  screenshot: ${screenshot.path}`,
      ),
      `  console: ${page.consoleMessages.length}`,
    ]),
  ].join("\n");
}

function renderGitHubPrSummary(summary: GitHubPrSummary) {
  const gateLines =
    summary.workspaceGate === undefined
      ? []
      : renderWorkspacePrQualityGateLines(summary.workspaceGate);

  return [
    `opened: ${summary.prUrl}`,
    `run: ${summary.runId}`,
    `branch: ${summary.branchName}`,
    `base: ${summary.baseBranch}`,
    `evidence: ${summary.evidencePath}`,
    ...gateLines,
  ].join("\n");
}

function renderGitHubPreflightSummary(summary: GitHubPublishPreflightSummary) {
  return [
    "preflight: passed",
    `run: ${summary.runId}`,
    `remote: ${summary.remoteName}`,
    `base: ${summary.baseBranch}`,
    `current branch: ${summary.currentBranch}`,
    ...summary.checks.map((check) => `- ${check.name}: ${check.status}`),
  ].join("\n");
}

function renderGitHubPublishPreview(summary: GitHubPublishPreview) {
  const gateLines =
    summary.workspaceGate === undefined
      ? []
      : renderWorkspacePrQualityGateLines(summary.workspaceGate);

  return [
    "preview: github-pr",
    `mode: ${summary.mode}`,
    `run: ${summary.runId}`,
    `branch: ${summary.branchName}`,
    `base: ${summary.baseBranch}`,
    `remote: ${summary.remoteName}`,
    `source changes: ${summary.sourceChanges}`,
    `evidence: ${summary.evidencePath}`,
    ...gateLines,
    "commands:",
    ...summary.commands.map((command) => `- ${formatCommand(command)}`),
  ].join("\n");
}

function renderWorkspacePrQualityGateLines(gate: WorkspacePrQualityGate) {
  return [
    `quality gate: ${gate.status}`,
    `quality gate artifact: ${gate.artifactPath}`,
    `quality gate items: ${gate.failItemCount} fail, ${gate.warnItemCount} warn`,
    ...gate.items.map(formatWorkspacePrQualityGateItem),
  ];
}

function formatWorkspacePrQualityGateItem(item: WorkspacePrQualityGateItem) {
  const changedFiles =
    item.changedFiles.length === 0 ? "none" : item.changedFiles.join(", ");

  return `- ${item.severity}: ${changedFiles} - ${item.reason} remediation: ${item.remediation}`;
}

function renderGitHubChecksSummary(summary: GitHubChecksSummary) {
  const lines = [
    `checks: ${formatGitHubChecksStatus(summary.status)}`,
    `outcome: ${gitHubChecksOutcome(summary.status)}`,
    `pr: ${summary.pr}`,
    `count: ${summary.checks.length}`,
  ];

  if (summary.checks.length === 0) {
    return lines.join("\n");
  }

  return [
    ...lines,
    ...summary.checks.map(
      (check) => `- ${check.name}: ${check.state}`,
    ),
  ].join("\n");
}

function renderGitHubChecksRecord(record: GitHubChecksRecord) {
  const lines = [
    `checks: ${formatGitHubChecksStatus(record.status)}`,
    `outcome: ${gitHubChecksOutcome(record.status)}`,
    `run: ${record.runId}`,
    `pr: ${record.pr}`,
    ...(record.headSha === undefined ? [] : [`head: ${record.headSha}`]),
    `attempts: ${record.attempts}`,
    `terminal: ${record.terminal}`,
    `snapshot: ${record.snapshotPath}`,
    `watch state: ${record.watchStatePath}`,
  ];

  if (record.checks.length === 0) {
    return lines.join("\n");
  }

  return [
    ...lines,
    ...record.checks.map(
      (check) => `- ${check.name}: ${check.state}`,
    ),
  ].join("\n");
}

function renderGitHubCiWatchSummary(summary: GitHubCiWatchSummary) {
  const lines = [
    `ci watch: ${formatGitHubChecksStatus(summary.status)}`,
    `outcome: ${gitHubChecksOutcome(summary.status)}`,
    `run: ${summary.runId}`,
    `pr: ${summary.pr}`,
    ...(summary.headSha === undefined ? [] : [`head: ${summary.headSha}`]),
    `source: ${summary.source}`,
    `attempts: ${summary.attempts}`,
    `terminal: ${summary.terminal}`,
    `next action: ${summary.nextAction}`,
    `snapshot: ${summary.snapshotPath}`,
    `watch state: ${summary.watchStatePath}`,
  ];

  if (summary.checks.length === 0) {
    return lines.join("\n");
  }

  return [
    ...lines,
    "checks:",
    ...summary.checks.map(formatCheckRun),
  ].join("\n");
}

function renderGitHubPrFeedbackSummary(summary: GitHubPrFeedbackSummary) {
  const reviewDecision =
    summary.reviewDecision === undefined
      ? "unknown"
      : summary.reviewDecision;
  const lines = [
    `pr feedback: ${summary.status}`,
    `outcome: ${gitHubFeedbackOutcome(summary.status)}`,
    `run: ${summary.runId}`,
    `pr: ${summary.pr}`,
    ...(summary.headSha === undefined ? [] : [`head: ${summary.headSha}`]),
    `next action: ${summary.nextAction}`,
    `feedback: ${summary.feedbackPath}`,
    `review decision: ${reviewDecision}`,
    `comments: ${summary.commentCount}`,
    `reviews: ${summary.reviewCount}`,
    `review requests: ${summary.reviewRequestCount}`,
  ];

  if (summary.comments.length === 0 && summary.latestReviews.length === 0) {
    return lines.join("\n");
  }

  return [
    ...lines,
    ...formatGitHubFeedbackComments(summary.comments),
    ...formatGitHubFeedbackReviews(summary.latestReviews),
  ].join("\n");
}

function renderGitHubPrLoopSummary(summary: GitHubPrLoopSummary) {
  const lines = [
    `pr loop: ${summary.status}`,
    `outcome: ${gitHubPrLoopOutcome(summary)}`,
    `run: ${summary.runId}`,
    `pr: ${summary.pr}`,
    ...(summary.headSha === undefined ? [] : [`head: ${summary.headSha}`]),
    `next action: ${summary.nextAction}`,
    `state: ${summary.statePath}`,
    `checks: ${formatGitHubChecksStatus(summary.checksStatus)} (${summary.checksPath})`,
    `feedback: ${summary.feedbackStatus} (${summary.feedbackPath})`,
    `blockers: ${summary.blockerCount}`,
  ];

  if (summary.blockers.length === 0) {
    return lines.join("\n");
  }

  return [
    ...lines,
    ...summary.blockers.map(
      (blocker) =>
        `- ${blocker.kind}: ${blocker.action} - ${blocker.summary}`,
    ),
  ].join("\n");
}

function gitHubChecksOutcome(status: GitHubChecksSummary["status"]) {
  return formatGitHubChecksStatus(status);
}

function formatGitHubChecksStatus(status: GitHubChecksSummary["status"]) {
  switch (status) {
    case "failing":
      return "failing";
    case "green":
      return "green";
    case "no-checks-configured":
      return "no checks configured";
    case "pending":
      return "pending";
    case "provider-unavailable":
      return "provider unavailable";
  }
}

function gitHubFeedbackOutcome(status: GitHubPrFeedbackSummary["status"]) {
  switch (status) {
    case "awaiting-review":
      return "awaiting-review";
    case "changes-requested":
    case "comments":
      return "blocked";
    case "clear":
      return "green";
  }
}

function gitHubPrLoopOutcome(summary: GitHubPrLoopSummary) {
  if (summary.checksStatus === "failing") {
    return "failing";
  }

  if (summary.checksStatus === "provider-unavailable") {
    return "provider unavailable";
  }

  if (
    summary.feedbackStatus === "changes-requested" ||
    summary.feedbackStatus === "comments"
  ) {
    return "blocked";
  }

  if (summary.feedbackStatus === "awaiting-review") {
    return "awaiting-review";
  }

  if (summary.checksStatus === "no-checks-configured") {
    return "no checks configured";
  }

  if (summary.status === "ready") {
    return "green";
  }

  return "waiting";
}

function renderGitHubPrCommentSummary(summary: GitHubPrCommentSummary) {
  const commentUrl =
    summary.commentUrl === undefined ? "unknown" : summary.commentUrl;

  return [
    `pr comment: ${summary.status}`,
    `run: ${summary.runId}`,
    `pr: ${summary.pr}`,
    `comment body: ${summary.commentPath}`,
    `comment url: ${commentUrl}`,
  ].join("\n");
}

function renderGitHubRemediationSpecSummary(
  summary: GitHubRemediationSpecSummary,
) {
  const lines = [
    `remediation spec: ${summary.status}`,
    `run: ${summary.runId}`,
    `pr: ${summary.pr}`,
    `next action: ${summary.nextAction}`,
    `spec: ${summary.specPath}`,
    `pr loop: ${summary.prLoopPath}`,
    `blockers: ${summary.blockerCount}`,
  ];

  return [
    ...lines,
    ...summary.blockers.map(
      (blocker) =>
        `- ${blocker.kind}: ${blocker.action} - ${blocker.summary}`,
    ),
  ].join("\n");
}

function renderLinearIssueGraphSummary(summary: LinearIssueGraphSummary) {
  const issueUrl = summary.issueUrl === undefined ? "unknown" : summary.issueUrl;

  return [
    `linear issue: ${summary.issueIdentifier}`,
    `run: ${summary.runId}`,
    `title: ${summary.issueTitle}`,
    `url: ${issueUrl}`,
    `graph: ${summary.graphPath}`,
    `source: ${summary.sourcePath}`,
    `blocked by: ${summary.blockedByCount}`,
    `blocks: ${summary.blocksCount}`,
  ].join("\n");
}

function renderMergeDecisionSummary(summary: MergeDecisionSummary) {
  const pr = summary.pr === undefined ? "unknown" : summary.pr;
  const lines = [
    `merge decision: ${summary.status}`,
    `run: ${summary.runId}`,
    `pr: ${pr}`,
    `next action: ${summary.nextAction}`,
    `decision: ${summary.decisionPath}`,
    `blockers: ${summary.blockerCount}`,
  ];

  if (summary.blockers.length === 0) {
    return lines.join("\n");
  }

  return [
    ...lines,
    ...summary.blockers.map(
      (blocker) =>
        `- ${blocker.kind}: ${blocker.action} - ${blocker.summary}`,
    ),
  ].join("\n");
}

function formatGitHubFeedbackComments(
  comments: GitHubPrFeedbackSummary["comments"],
) {
  if (comments.length === 0) {
    return [];
  }

  return [
    "comments:",
    ...comments.map((comment) => {
      const author =
        comment.authorLogin === undefined ? "unknown" : comment.authorLogin;
      const url = comment.url === undefined ? "" : ` ${comment.url}`;
      return `- ${author}: ${firstLine(comment.body)}${url}`;
    }),
  ];
}

function formatGitHubFeedbackReviews(
  reviews: GitHubPrFeedbackSummary["latestReviews"],
) {
  if (reviews.length === 0) {
    return [];
  }

  return [
    "latest reviews:",
    ...reviews.map((review) => {
      const author =
        review.authorLogin === undefined ? "unknown" : review.authorLogin;
      const url = review.url === undefined ? "" : ` ${review.url}`;
      return `- ${author}: ${review.state}${url}`;
    }),
  ];
}

function firstLine(input: string) {
  return input.split(/\r?\n/u)[0] ?? "";
}

function formatCheckRun(check: GitHubCiWatchSummary["checks"][number]) {
  const workflow =
    check.workflow === undefined ? "" : ` (${check.workflow})`;
  const link = check.link === undefined ? "" : ` ${check.link}`;

  return `- ${check.name}: ${check.state}${workflow}${link}`;
}

function formatCommand(
  command: GitHubPublishPreview["commands"][number],
) {
  return [command.command, ...command.args.map(formatCommandArgument)].join(" ");
}

function formatCommandArgument(argument: string) {
  return /^[A-Za-z0-9_./:=@-]+$/u.test(argument)
    ? argument
    : JSON.stringify(argument);
}

command.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
