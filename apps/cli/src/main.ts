#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  CommandSummary,
  GitHubChecksRecord,
  GitHubChecksSummary,
  GitHubPublishPreflightSummary,
  GitHubPublishPreview,
  GitHubPrSummary,
} from "@gaia/runtime";
import {
  GaiaRuntimeError,
  inspectGitHubChecks,
  listRuns,
  localDirectoryWorkspaceSource,
  localSkillManifestSource,
  makeProcessHarnessConfig,
  parseHarnessName,
  preflightGitHubPublish,
  previewGitHubPublish,
  publishRunToGitHub,
  publishWorkspaceRunToGitHub,
  recordGitHubChecks,
  resumeRun,
  runSpecFile,
  statusRun,
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
const runId = Argument.string("run-id");
const pullRequest = Argument.string("pull-request");
const optionalRunId = runId.pipe(Argument.optional);
const json = Flag.boolean("json").pipe(
  Flag.withDescription("Write a machine-readable JSON response."),
);
const workspaceSource = Flag.string("workspace-source").pipe(
  Flag.withDescription("Copy a local directory into the run workspace."),
  Flag.optional,
);
const skillManifest = Flag.string("skill-manifest").pipe(
  Flag.withDescription("Record a JSON skill manifest as run evidence."),
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
const harnessCommand = Flag.string("harness-command").pipe(
  Flag.withDescription("Executable command for the process harness."),
  Flag.optional,
);
const harnessArg = Flag.string("harness-arg").pipe(
  Flag.withDescription("Argument for the process harness command. Repeatable."),
  Flag.atLeast(0),
);

const run = Command.make("run", {
  harness,
  harnessArg,
  harnessCommand,
  json,
  skillManifest,
  specFile,
  workspaceSource,
}).pipe(
  Command.withDescription("Start a new Gaia run from a Markdown spec."),
  Command.withHandler(
    ({
      harness,
      harnessArg,
      harnessCommand,
      json,
      skillManifest,
      specFile,
      workspaceSource,
    }) =>
      renderEffect(
        runSpecFile(
          resolveInvocationPath(specFile),
          workflowOptions({
            harness,
            harnessArgs: harnessArg,
            harnessCommand,
            skillManifest,
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

const status = Command.make("status", { json, runId: optionalRunId }).pipe(
  Command.withDescription("Show the latest run status or a specific run status."),
  Command.withHandler(({ json, runId }) =>
    renderEffect(
      statusRun(Option.getOrUndefined(runId), workflowOptions()),
      json,
      renderSummary,
    ),
  ),
);

const list = Command.make("list", { json }).pipe(
  Command.withDescription("List known Gaia runs."),
  Command.withHandler(({ json }) =>
    renderEffect(listRuns(workflowOptions()), json, renderRunList),
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

const cli = Command.make("gaia").pipe(
  Command.withDescription("Gaia software-factory control plane prototype."),
  Command.withSubcommands([
    run,
    resume,
    status,
    list,
    preflightGithub,
    previewPr,
    publishPr,
    publishWorkspacePr,
    prChecks,
    checks,
  ]),
);

const command = Command.run(cli, { version: "0.1.0" });

function invocationRoot() {
  return process.env["INIT_CWD"] ?? process.cwd();
}

function workflowOptions(
  input: Readonly<{
    harness?: Option.Option<string>;
    harnessArgs?: ReadonlyArray<string>;
    harnessCommand?: Option.Option<string>;
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
  const processHarness = Option.map(
    input.harnessCommand ?? Option.none(),
    (command) => makeProcessHarnessConfig(command, input.harnessArgs ?? []),
  );
  const skillManifestSource = Option.map(
    input.skillManifest ?? Option.none(),
    (source) => localSkillManifestSource(resolveInvocationPath(source)),
  );

  return {
    rootDirectory,
    ...(Option.isSome(workspaceSource)
      ? { workspaceSource: workspaceSource.value }
      : {}),
    ...(Option.isSome(harnessName) ? { harnessName: harnessName.value } : {}),
    ...(Option.isSome(processHarness)
      ? { processHarness: processHarness.value }
      : {}),
    ...(Option.isSome(skillManifestSource)
      ? { skillManifestSource: skillManifestSource.value }
      : {}),
  };
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
