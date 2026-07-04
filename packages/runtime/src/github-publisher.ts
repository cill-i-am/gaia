import { RunIdSchema, type RunId } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { makeRunPaths, type RunPaths, type RunStorageOptions } from "./paths.js";
import { statusRun } from "./workflows.js";

const execFileAsync = promisify(execFile);
const commandMaxBufferBytes = 10 * 1024 * 1024;
const defaultRemoteName = "origin";
const defaultBaseBranch = "main";

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
      execFileAsync(input.command, [...input.args], {
        cwd: input.cwd,
        maxBuffer: commandMaxBufferBytes,
      }),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "GitHubCommandFailed",
        message: `${input.command} ${input.args.join(" ")} failed.`,
        recoverable: true,
      }),
  }).pipe(
    Effect.map((result) => ({
      stderr: String(result.stderr),
      stdout: String(result.stdout),
    })),
  );

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
      yield* runCommand(runner, rootDirectory, "git", [
        "fetch",
        remoteName,
        baseBranch,
      ]);
      yield* runCommand(runner, rootDirectory, "git", [
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
      yield* runCommand(runner, rootDirectory, "git", [
        "add",
        `gaia-runs/${summary.runId}`,
      ]);
      yield* runCommand(runner, rootDirectory, "git", [
        "commit",
        "-m",
        `chore: add gaia evidence for ${summary.runId}`,
      ]);
      yield* runCommand(runner, rootDirectory, "git", [
        "push",
        "--force-with-lease",
        "-u",
        remoteName,
        branchName,
      ]);
      const pr = yield* runCommand(runner, rootDirectory, "gh", [
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
        runCommand(runner, rootDirectory, "git", [
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

function runCommand(
  runner: GitHubCommandRunner,
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  return runner({ args, command, cwd });
}

function requireCleanWorktree(
  runner: GitHubCommandRunner,
  rootDirectory: string,
) {
  return Effect.gen(function* () {
    const result = yield* runCommand(runner, rootDirectory, "git", [
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
    const result = yield* runCommand(runner, rootDirectory, "git", [
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
