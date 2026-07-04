import { RunIdSchema, type RunId } from "@gaia/core";
import { Duration, Effect, FileSystem, Path, Schedule, Schema } from "effect";
import { execFile } from "node:child_process";
import { appendEvent, readEvents } from "./event-store.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { HarnessRunResult } from "./harness.js";
import {
  makeRunPaths,
  runRelative,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import { copyWorkspaceDirectoryContents } from "./workspace.js";
import { statusRun } from "./workflows.js";

const commandMaxBufferBytes = 10 * 1024 * 1024;
const defaultRemoteName = "origin";
const defaultBaseBranch = "main";
const defaultGitHubCheckPollAttempts = 30;
const defaultGitHubCheckPollInterval = "5 seconds";
const workspaceArtifactPrefix = "workspace/";

const GitHubCheckPollAttemptCountSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("GitHubCheckPollAttemptCount"));

type GitHubCheckPollAttemptCount =
  typeof GitHubCheckPollAttemptCountSchema.Type;

const parseGitHubCheckPollAttemptCount = Schema.decodeUnknownSync(
  GitHubCheckPollAttemptCountSchema,
);

export const GitHubPullRequestSelectorSchema = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubPullRequestSelector"),
);

export type GitHubPullRequestSelector =
  typeof GitHubPullRequestSelectorSchema.Type;

export const parseGitHubPullRequestSelector = Schema.decodeUnknownSync(
  GitHubPullRequestSelectorSchema,
);

export const GitHubChecksStatusSchema = Schema.Literals([
  "no-checks",
  "pending",
  "passed",
  "failed",
] as const);

export type GitHubChecksStatus = typeof GitHubChecksStatusSchema.Type;

export class GitHubCheckRun extends Schema.Class<GitHubCheckRun>(
  "GitHubCheckRun",
)({
  link: Schema.optionalKey(Schema.String),
  name: Schema.NonEmptyString,
  state: Schema.NonEmptyString,
  workflow: Schema.optionalKey(Schema.String),
}) {}

export class GitHubChecksSummary extends Schema.Class<GitHubChecksSummary>(
  "GitHubChecksSummary",
)({
  checks: Schema.Array(GitHubCheckRun),
  pr: GitHubPullRequestSelectorSchema,
  status: GitHubChecksStatusSchema,
}) {}

export class GitHubChecksSnapshot extends Schema.Class<GitHubChecksSnapshot>(
  "GitHubChecksSnapshot",
)({
  attempts: GitHubCheckPollAttemptCountSchema,
  checks: Schema.Array(GitHubCheckRun),
  observedAt: Schema.NonEmptyString,
  pr: GitHubPullRequestSelectorSchema,
  runId: RunIdSchema,
  status: GitHubChecksStatusSchema,
  terminal: Schema.Boolean,
}) {}

export class GitHubChecksRecord extends Schema.Class<GitHubChecksRecord>(
  "GitHubChecksRecord",
)({
  attempts: GitHubCheckPollAttemptCountSchema,
  checks: Schema.Array(GitHubCheckRun),
  observedAt: Schema.NonEmptyString,
  pr: GitHubPullRequestSelectorSchema,
  runId: RunIdSchema,
  snapshotPath: Schema.NonEmptyString,
  status: GitHubChecksStatusSchema,
  terminal: Schema.Boolean,
}) {}

export class GitHubPrSummary extends Schema.Class<GitHubPrSummary>(
  "GitHubPrSummary",
)({
  baseBranch: Schema.NonEmptyString,
  branchName: Schema.NonEmptyString,
  evidencePath: Schema.NonEmptyString,
  prUrl: Schema.NonEmptyString,
  runId: RunIdSchema,
  status: Schema.Literal("opened"),
}) {}

const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const parseHarnessRunResultJson = Schema.decodeUnknownSync(
  HarnessRunResultJson,
);

export type CommandExecutionResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

export type GitHubCommandInput = {
  readonly args: ReadonlyArray<string>;
  readonly command: string;
  readonly cwd: string;
};

export type GitHubCommandRunner = (
  input: GitHubCommandInput,
) => Effect.Effect<CommandExecutionResult, GaiaRuntimeError>;

export type GitHubPublishOptions = RunStorageOptions & {
  readonly baseBranch?: string;
  readonly commandRunner?: GitHubCommandRunner;
  readonly remoteName?: string;
};

export type GitHubCheckRecordOptions = RunStorageOptions & {
  readonly commandRunner?: GitHubCommandRunner;
  readonly maxAttempts?: number;
  readonly pollInterval?: Duration.Input;
  readonly waitForTerminal?: boolean;
};

class GitHubChecksPending extends Schema.TaggedErrorClass<GitHubChecksPending>()(
  "GitHubChecksPending",
  {
    attempts: GitHubCheckPollAttemptCountSchema,
    summary: GitHubChecksSummary,
  },
) {}

const nodeCommandRunner: GitHubCommandRunner = (input) =>
  Effect.tryPromise({
    try: () =>
      new Promise<CommandExecutionResult>((resolve, reject) => {
        execFile(input.command, [...input.args], {
          cwd: input.cwd,
          maxBuffer: commandMaxBufferBytes,
        }, (error, stdout, stderr) => {
          if (error !== null && error.code === undefined) {
            reject(error);
            return;
          }

          resolve({
            exitCode: normalizeExitCode(error?.code),
            stderr: String(stderr),
            stdout: String(stdout),
          });
        });
      }),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "GitHubCommandFailed",
        message: `${input.command} ${input.args.join(" ")} failed.`,
        recoverable: true,
      }),
  });

export function publishRunToGitHub(
  runIdInput: string,
  options: GitHubPublishOptions = {},
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const baseBranch = options.baseBranch ?? defaultBaseBranch;
    const remoteName = options.remoteName ?? defaultRemoteName;
    const runner = options.commandRunner ?? nodeCommandRunner;
    const summary = yield* statusRun(runIdInput, { rootDirectory });

    if (summary.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${summary.runId} must be completed before opening a PR.`,
          recoverable: false,
        }),
      );
    }

    yield* requireCleanWorktree(runner, rootDirectory);
    const currentBranch = yield* currentGitBranch(runner, rootDirectory);
    const branchName = `gaia/${summary.runId}`;
    const paths = yield* makeRunPaths(summary.runId, { rootDirectory });

    const prUrl = yield* Effect.gen(function* () {
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "fetch",
        remoteName,
        baseBranch,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "checkout",
        "-B",
        branchName,
        `${remoteName}/${baseBranch}`,
      ]);
      const evidencePath = yield* writePullRequestEvidence(
        summary.runId,
        rootDirectory,
      );
      yield* copyRunArtifacts(paths, evidencePath);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "add",
        `gaia-runs/${summary.runId}`,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "commit",
        "-m",
        `chore: add gaia evidence for ${summary.runId}`,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "push",
        "--force-with-lease",
        "-u",
        remoteName,
        branchName,
      ]);
      const pr = yield* runRequiredCommand(runner, rootDirectory, "gh", [
        "pr",
        "create",
        "--draft",
        "--base",
        baseBranch,
        "--head",
        branchName,
        "--title",
        `Gaia run ${summary.runId}`,
        "--body-file",
        `${evidencePath}/README.md`,
      ]);

      return yield* parsePullRequestUrl(pr.stdout);
    }).pipe(
      Effect.ensuring(
        runRequiredCommand(runner, rootDirectory, "git", [
          "checkout",
          currentBranch,
        ]).pipe(Effect.ignore),
      ),
    );

    return GitHubPrSummary.make({
      baseBranch,
      branchName,
      evidencePath: `gaia-runs/${summary.runId}`,
      prUrl,
      runId: summary.runId,
      status: "opened",
    });
  });
}

/** Publish a completed Gaia run workspace as a draft GitHub pull request. */
export function publishWorkspaceRunToGitHub(
  runIdInput: string,
  options: GitHubPublishOptions = {},
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const baseBranch = options.baseBranch ?? defaultBaseBranch;
    const remoteName = options.remoteName ?? defaultRemoteName;
    const runner = options.commandRunner ?? nodeCommandRunner;
    const summary = yield* statusRun(runIdInput, { rootDirectory });

    if (summary.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${summary.runId} must be completed before opening a workspace PR.`,
          recoverable: false,
        }),
      );
    }

    yield* requireCleanWorktree(runner, rootDirectory);
    const currentBranch = yield* currentGitBranch(runner, rootDirectory);
    const branchName = `gaia/${summary.runId}-workspace`;
    const paths = yield* makeRunPaths(summary.runId, { rootDirectory });

    const prUrl = yield* Effect.gen(function* () {
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "fetch",
        remoteName,
        baseBranch,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "checkout",
        "-B",
        branchName,
        `${remoteName}/${baseBranch}`,
      ]);

      yield* applyRunWorkspace(paths, rootDirectory);
      yield* stageWorkspaceChanges(runner, rootDirectory, summary.runId);

      const evidencePath = yield* writePullRequestEvidence(
        summary.runId,
        rootDirectory,
      );
      yield* copyRunArtifacts(paths, evidencePath);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "add",
        `gaia-runs/${summary.runId}`,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "commit",
        "-m",
        `feat: apply gaia workspace for ${summary.runId}`,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "push",
        "--force-with-lease",
        "-u",
        remoteName,
        branchName,
      ]);
      const pr = yield* runRequiredCommand(runner, rootDirectory, "gh", [
        "pr",
        "create",
        "--draft",
        "--base",
        baseBranch,
        "--head",
        branchName,
        "--title",
        `Gaia workspace run ${summary.runId}`,
        "--body-file",
        `${evidencePath}/README.md`,
      ]);

      return yield* parsePullRequestUrl(pr.stdout);
    }).pipe(
      Effect.ensuring(
        runRequiredCommand(runner, rootDirectory, "git", [
          "checkout",
          currentBranch,
        ]).pipe(Effect.ignore),
      ),
    );

    return GitHubPrSummary.make({
      baseBranch,
      branchName,
      evidencePath: `gaia-runs/${summary.runId}`,
      prUrl,
      runId: summary.runId,
      status: "opened",
    });
  });
}

export function inspectGitHubChecks(
  prInput: string,
  options: GitHubPublishOptions = {},
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const runner = options.commandRunner ?? nodeCommandRunner;
    const pr = yield* parseGitHubPullRequestSelectorEffect(prInput);
    const result = yield* runCommand(runner, rootDirectory, "gh", [
      "pr",
      "checks",
      pr,
      "--json",
      "name,state,workflow,link",
    ]);

    if (result.exitCode !== 0 && isNoChecksOutput(result)) {
      return GitHubChecksSummary.make({
        checks: [],
        pr,
        status: "no-checks",
      });
    }

    const checks = yield* parseGitHubChecks(result);
    return GitHubChecksSummary.make({
      checks,
      pr,
      status: classifyChecks(checks),
    });
  });
}

export function recordGitHubChecks(
  runIdInput: string,
  prInput: string,
  options: GitHubCheckRecordOptions = {},
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const runner = options.commandRunner ?? nodeCommandRunner;
    const run = yield* statusRun(runIdInput, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before recording GitHub checks.`,
          recoverable: false,
        }),
      );
    }

    const attempts = yield* parseGitHubCheckPollAttemptCountEffect(
      options.maxAttempts ?? defaultGitHubCheckPollAttempts,
    );
    const observed = options.waitForTerminal === true
      ? yield* waitForTerminalGitHubChecks(prInput, {
          attempts,
          pollInterval: options.pollInterval ?? defaultGitHubCheckPollInterval,
          rootDirectory,
          runner,
        })
      : {
          attempts: parseGitHubCheckPollAttemptCount(1),
          summary: yield* inspectGitHubChecks(prInput, {
            commandRunner: runner,
            rootDirectory,
          }),
        };
    const paths = yield* makeRunPaths(run.runId, { rootDirectory });
    const recorded = yield* writeGitHubChecksSnapshot(paths, {
      attempts: observed.attempts,
      runId: run.runId,
      summary: observed.summary,
    });
    const checksPath = runRelative(paths, recorded.snapshotPath);

    yield* appendEvent(run.runId, paths, {
      payload: {
        attempts: recorded.attempts,
        checksPath,
        pullRequest: recorded.pr,
        status: recorded.status,
        terminal: recorded.terminal,
      },
      type: "GITHUB_CHECKS_RECORDED",
    });

    return recorded;
  });
}

function applyRunWorkspace(paths: RunPaths, rootDirectory: string) {
  return Effect.gen(function* () {
    const skippedRelativePaths = yield* readWorkspaceArtifactRelativePaths(paths);
    yield* copyWorkspaceDirectoryContents(paths.workspace, rootDirectory, {
      deleteExtraneous: true,
      skippedRelativePaths,
    });
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "WorkspacePrApplyFailed",
          message: "Gaia could not apply the run workspace to the PR branch.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function readWorkspaceArtifactRelativePaths(paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rawResult = yield* fs.readFileString(paths.workerResult).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "WorkspaceArtifactReadFailed",
            message: "Gaia could not read the harness artifact manifest.",
            recoverable: true,
          }),
        ),
      ),
    );
    const parsedJson = yield* Effect.try({
      try: (): unknown => JSON.parse(rawResult),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "WorkspaceArtifactJsonInvalid",
          message: "Harness artifact manifest was not valid JSON.",
          recoverable: true,
        }),
    });
    const result = yield* Effect.try({
      try: () => parseHarnessRunResultJson(parsedJson),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "WorkspaceArtifactManifestInvalid",
          message:
            "Harness artifact manifest did not match Gaia's run result schema.",
          recoverable: true,
        }),
    });
    const relativePaths = new Set<string>();

    for (const artifact of result.outputArtifacts) {
      if (!artifact.startsWith(workspaceArtifactPrefix)) {
        continue;
      }

      const relativePath = artifact.slice(workspaceArtifactPrefix.length);
      if (relativePath.length > 0) {
        relativePaths.add(relativePath);
      }
    }

    return relativePaths;
  });
}

function stageWorkspaceChanges(
  runner: GitHubCommandRunner,
  rootDirectory: string,
  runId: RunId,
) {
  return Effect.gen(function* () {
    const excludedEvidencePath = `:!gaia-runs/${runId}`;
    yield* runRequiredCommand(runner, rootDirectory, "git", [
      "add",
      "--all",
      "--",
      ".",
      ":!.gaia",
      excludedEvidencePath,
    ]);
    const diff = yield* runCommand(runner, rootDirectory, "git", [
      "diff",
      "--cached",
      "--quiet",
      "--",
      ".",
      ":!.gaia",
      excludedEvidencePath,
    ]);

    if (diff.exitCode === 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "WorkspacePrNoChanges",
          message:
            "Gaia run workspace has no source changes to publish. Use publish-pr for evidence-only PRs.",
          recoverable: false,
        }),
      );
    }

    if (diff.exitCode !== 1) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitHubCommandFailed",
          message: "git diff --cached --quiet failed.",
          recoverable: true,
        }),
      );
    }
  });
}

function runCommand(
  runner: GitHubCommandRunner,
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  return runner({ args, command, cwd });
}

function runRequiredCommand(
  runner: GitHubCommandRunner,
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  return Effect.gen(function* () {
    const result = yield* runCommand(runner, cwd, command, args);

    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitHubCommandFailed",
          message: `${command} ${args.join(" ")} failed.`,
          recoverable: true,
        }),
      );
    }

    return result;
  });
}

function requireCleanWorktree(
  runner: GitHubCommandRunner,
  rootDirectory: string,
) {
  return Effect.gen(function* () {
    const result = yield* runRequiredCommand(runner, rootDirectory, "git", [
      "status",
      "--porcelain",
    ]);

    if (result.stdout.trim().length > 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitWorktreeDirty",
          message: "Git worktree must be clean before Gaia opens a PR.",
          recoverable: false,
        }),
      );
    }
  });
}

function currentGitBranch(
  runner: GitHubCommandRunner,
  rootDirectory: string,
) {
  return Effect.gen(function* () {
    const result = yield* runRequiredCommand(runner, rootDirectory, "git", [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    const branch = result.stdout.trim();

    if (branch.length === 0 || branch === "HEAD") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitBranchUnavailable",
          message: "Gaia cannot open a PR from a detached HEAD.",
          recoverable: false,
        }),
      );
    }

    return branch;
  });
}

function writePullRequestEvidence(runId: RunId, rootDirectory: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const evidencePath = path.join(rootDirectory, "gaia-runs", runId);
    const exists = yield* fs.exists(evidencePath);
    if (exists) {
      yield* fs.remove(evidencePath, { recursive: true });
    }

    yield* fs.makeDirectory(evidencePath, { recursive: true });
    return evidencePath;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "PullRequestEvidencePrepareFailed",
          message: "Gaia could not prepare the PR evidence directory.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function copyRunArtifacts(
  paths: RunPaths,
  evidencePath: string,
) {
  const artifacts = [
    ["input.md", "input.md"],
    ["report.md", "README.md"],
    ["report.json", "report.json"],
    ["worker-plan.md", "worker-plan.md"],
    ["plan-review.md", "plan-review.md"],
    ["worker-result.json", "worker-result.json"],
    ["verification-result.json", "verification-result.json"],
    ["evidence-review.md", "evidence-review.md"],
    ["workspace/output.txt", "workspace-output.txt"],
  ] as const;

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    for (const [source, destination] of artifacts) {
      yield* fs.copyFile(
        path.join(paths.root, source),
        path.join(evidencePath, destination),
      );
    }
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "PullRequestEvidenceCopyFailed",
          message: "Gaia could not copy run evidence into the PR branch.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function parsePullRequestUrl(input: string) {
  const url = input.trim();
  if (url.length === 0) {
    return Effect.fail(
      makeRuntimeError({
        code: "PullRequestUrlMissing",
        message: "GitHub CLI did not return a pull request URL.",
        recoverable: true,
      }),
    );
  }

  return Effect.succeed(url);
}

function parseGitHubPullRequestSelectorEffect(input: string) {
  return Effect.try({
    try: () => parseGitHubPullRequestSelector(input),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidGitHubPullRequestSelector",
        message: "GitHub pull request selector must not be empty.",
        recoverable: false,
      }),
  });
}

function parseGitHubCheckPollAttemptCountEffect(input: number) {
  return Effect.try({
    try: () => parseGitHubCheckPollAttemptCount(input),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidGitHubCheckPollAttempts",
        message: "GitHub check polling attempts must be a positive integer.",
        recoverable: false,
      }),
  });
}

function waitForTerminalGitHubChecks(
  prInput: string,
  input: Readonly<{
    attempts: GitHubCheckPollAttemptCount;
    pollInterval: Duration.Input;
    rootDirectory: string;
    runner: GitHubCommandRunner;
  }>,
) {
  let attempt = 0;
  const inspectTerminal = Effect.gen(function* () {
    attempt += 1;
    const attempts = parseGitHubCheckPollAttemptCount(attempt);
    const summary = yield* inspectGitHubChecks(prInput, {
      commandRunner: input.runner,
      rootDirectory: input.rootDirectory,
    });

    if (isTerminalGitHubChecksStatus(summary.status)) {
      return { attempts, summary };
    }

    return yield* Effect.fail(
      GitHubChecksPending.make({ attempts, summary }),
    );
  });

  return inspectTerminal.pipe(
    Effect.retry({
      schedule: Schedule.spaced(input.pollInterval),
      times: input.attempts - 1,
    }),
    Effect.catchTag("GitHubChecksPending", (pending) =>
      Effect.succeed({
        attempts: pending.attempts,
        summary: pending.summary,
      }),
    ),
  );
}

function writeGitHubChecksSnapshot(
  paths: RunPaths,
  input: Readonly<{
    attempts: GitHubCheckPollAttemptCount;
    runId: RunId;
    summary: GitHubChecksSummary;
  }>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const events = yield* readEvents(paths);
    const nextSequence = events.length + 1;
    const snapshotPath = path.join(
      paths.githubChecks,
      `checks-${nextSequence}.json`,
    );
    const observedAt = new Date().toISOString();
    const snapshot = GitHubChecksSnapshot.make({
      attempts: input.attempts,
      checks: input.summary.checks,
      observedAt,
      pr: input.summary.pr,
      runId: input.runId,
      status: input.summary.status,
      terminal: isTerminalGitHubChecksStatus(input.summary.status),
    });

    yield* fs.makeDirectory(paths.githubChecks, { recursive: true });
    yield* fs.writeFileString(
      snapshotPath,
      `${JSON.stringify(Schema.encodeSync(GitHubChecksSnapshot)(snapshot), null, 2)}\n`,
    );

    return GitHubChecksRecord.make({
      attempts: snapshot.attempts,
      checks: snapshot.checks,
      observedAt: snapshot.observedAt,
      pr: snapshot.pr,
      runId: snapshot.runId,
      snapshotPath,
      status: snapshot.status,
      terminal: snapshot.terminal,
    });
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubChecksSnapshotWriteFailed",
          message: "Gaia could not write GitHub check evidence.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function isNoChecksOutput(result: CommandExecutionResult) {
  const output = `${result.stdout}\n${result.stderr}`;
  return output.includes("no checks reported");
}

function parseGitHubChecks(result: CommandExecutionResult) {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(result.stdout),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubChecksJsonInvalid",
          message: "GitHub checks output was not valid JSON.",
          recoverable: true,
        }),
    });

    const checks = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Schema.Array(GitHubCheckRun))(parsed),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubChecksInvalid",
          message: "GitHub checks output did not match Gaia's check schema.",
          recoverable: true,
        }),
    });

    return checks;
  });
}

function classifyChecks(
  checks: ReadonlyArray<GitHubCheckRun>,
): GitHubChecksStatus {
  if (checks.length === 0) {
    return "no-checks";
  }

  if (checks.some((check) => isPendingCheckState(check.state))) {
    return "pending";
  }

  if (checks.every((check) => isPassingCheckState(check.state))) {
    return "passed";
  }

  return "failed";
}

function isTerminalGitHubChecksStatus(status: GitHubChecksStatus) {
  return status !== "pending";
}

function isPendingCheckState(state: string) {
  return pendingCheckStates.has(normalizeCheckState(state));
}

function isPassingCheckState(state: string) {
  return passingCheckStates.has(normalizeCheckState(state));
}

function normalizeCheckState(state: string) {
  return state.trim().toLowerCase().replaceAll("_", "-");
}

const pendingCheckStates = new Set([
  "expected",
  "in-progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);

const passingCheckStates = new Set([
  "neutral",
  "passed",
  "skipped",
  "success",
]);

function normalizeExitCode(code: string | number | null | undefined) {
  if (typeof code === "number") {
    return code;
  }

  if (typeof code === "string") {
    const parsed = Number.parseInt(code, 10);
    return Number.isInteger(parsed) ? parsed : 1;
  }

  return 0;
}
