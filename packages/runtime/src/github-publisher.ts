import { RunIdSchema, type RunId } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { execFile } from "node:child_process";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { makeRunPaths, type RunPaths, type RunStorageOptions } from "./paths.js";
import { statusRun } from "./workflows.js";

const commandMaxBufferBytes = 10 * 1024 * 1024;
const defaultRemoteName = "origin";
const defaultBaseBranch = "main";

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
