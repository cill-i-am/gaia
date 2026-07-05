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
  listRunsFromServer,
  localDirectoryWorkspaceSource,
  localRunProfileSource,
  localSkillManifestSource,
  makeCodexReviewer,
  makeCodexReviewerConfig,
  makeCodexHarnessConfig,
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
  runSpecFile,
  statusRun,
  statusRunFromServer,
  watchGitHubChecks,
  watchGitHubFeedback,
} from "@gaia/runtime";
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
    "Opt into read-only CLI data from a running local Gaia API server.",
  ),
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
        runSpecFile(
          resolveInvocationPath(specFile),
          workflowOptions({
            harness,
            harnessArgs: harnessArg,
            harnessCommand,
            codexArgs: codexArg,
            codexCommand,
            codexModel,
            codexProfile,
            codexSandbox,
            codexTimeoutMs,
            browserEvidenceRequirement: requireBrowserEvidence
              ? "required"
              : undefined,
            browserEvidenceTargetUrl: browserRunTargetUrl,
            runProfile,
            skillManifest,
            reviewer,
            workspaceSource,
          }),
        ),
        json,
        renderSummary,
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
  serverUrl,
}).pipe(
  Command.withDescription("Show the latest run status or a specific run status."),
  Command.withHandler(({ json, runId, serverUrl }) =>
    renderEffect(
      serverReadEffect(
        serverUrl,
        (url) =>
          statusRunFromServer(Option.getOrUndefined(runId), serverReadOptions(url)),
        () => statusRun(Option.getOrUndefined(runId), workflowOptions()),
      ),
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

const list = Command.make("list", { json, serverUrl }).pipe(
  Command.withDescription("List known Gaia runs."),
  Command.withHandler(({ json, serverUrl }) =>
    renderEffect(
      serverReadEffect(
        serverUrl,
        (url) => listRunsFromServer(serverReadOptions(url)),
        () => listRuns(workflowOptions()),
      ),
      json,
      renderRunList,
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

const cli = Command.make("gaia").pipe(
  Command.withDescription("Gaia software-factory control plane prototype."),
  Command.withSubcommands([
    run,
    doctorCommand,
    resume,
    status,
    list,
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

function serverReadOptions(serverUrl: string) {
  return {
    rootDirectory: invocationRoot(),
    serverUrl,
  };
}

function serverReadEffect<A>(
  serverUrl: Option.Option<string>,
  fromServer: (serverUrl: string) => Effect.Effect<A, unknown, NodeServices.NodeServices>,
  direct: () => Effect.Effect<A, unknown, NodeServices.NodeServices>,
) {
  return Option.isSome(serverUrl) ? fromServer(serverUrl.value) : direct();
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

  return {
    code: "UnexpectedFailure",
    message: "Gaia command failed.",
    recoverable: false,
    status: "failed",
  };
}

function renderFailure(failure: FailureOutput) {
  return [
    `Gaia command failed: ${failure.message}`,
    `code: ${failure.code}`,
    `recoverable: ${failure.recoverable}`,
  ].join("\n");
}

function renderSummary(summary: CommandSummary) {
  const reportLine =
    summary.reportPath === undefined ? undefined : `report: ${summary.reportPath}`;
  const lines = [
    `${summary.status === "completed" ? "completed" : summary.status}: ${summary.runId}`,
    `state: ${summary.state}`,
    `run: ${summary.runDirectory}`,
  ];

  return reportLine === undefined ? lines.join("\n") : [...lines, reportLine].join("\n");
}

function renderRunList(summaries: ReadonlyArray<CommandSummary>) {
  if (summaries.length === 0) {
    return "No Gaia runs found.";
  }

  return summaries
    .map((summary) => `${summary.runId} ${summary.status} ${summary.state}`)
    .join("\n");
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
  return [
    `opened: ${summary.prUrl}`,
    `run: ${summary.runId}`,
    `branch: ${summary.branchName}`,
    `base: ${summary.baseBranch}`,
    `evidence: ${summary.evidencePath}`,
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
  return [
    "preview: github-pr",
    `mode: ${summary.mode}`,
    `run: ${summary.runId}`,
    `branch: ${summary.branchName}`,
    `base: ${summary.baseBranch}`,
    `remote: ${summary.remoteName}`,
    `source changes: ${summary.sourceChanges}`,
    `evidence: ${summary.evidencePath}`,
    "commands:",
    ...summary.commands.map((command) => `- ${formatCommand(command)}`),
  ].join("\n");
}

function renderGitHubChecksSummary(summary: GitHubChecksSummary) {
  const lines = [
    `checks: ${summary.status}`,
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
    `checks: ${record.status}`,
    `run: ${record.runId}`,
    `pr: ${record.pr}`,
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
    `ci watch: ${summary.status}`,
    `run: ${summary.runId}`,
    `pr: ${summary.pr}`,
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
    `run: ${summary.runId}`,
    `pr: ${summary.pr}`,
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
    `run: ${summary.runId}`,
    `pr: ${summary.pr}`,
    `next action: ${summary.nextAction}`,
    `state: ${summary.statePath}`,
    `checks: ${summary.checksStatus} (${summary.checksPath})`,
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
