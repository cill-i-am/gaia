import { RunIdSchema, type RunId } from "@gaia/core";
import { Duration, Effect, FileSystem, Path, Schedule, Schema } from "effect";
import { execFile } from "node:child_process";
import { appendEvent, readEvents } from "./event-store.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { writeDogfoodRetrospective } from "./dogfood-retrospective.js";
import { HarnessRunResult } from "./harness.js";
import {
  makeRunPaths,
  runRelative,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import { withRunStoreLock } from "./run-store-lock.js";
import { copyWorkspaceDirectoryContents } from "./workspace.js";
import {
  evaluateWorkspacePrQualityGate,
  WorkspacePrQualityGate,
} from "./workspace-pr-gate.js";
import { statusRun } from "./workflows.js";

const commandMaxBufferBytes = 10 * 1024 * 1024;
const defaultRemoteName = "origin";
const defaultBaseBranch = "main";
const defaultGitHubCheckPollAttempts = 30;
const defaultGitHubCheckPollInterval = "5 seconds";
const workspaceArtifactPrefix = "workspace/";

export const GitHubPreflightCheckNameSchema = Schema.Literals([
  "run-completed",
  "git-repository",
  "clean-worktree",
  "current-branch",
  "remote-configured",
  "base-branch",
  "base-synchronized",
  "github-auth",
] as const);

export type GitHubPreflightCheckName =
  typeof GitHubPreflightCheckNameSchema.Type;

export const GitHubPublishModeSchema = Schema.Literals([
  "evidence",
  "workspace",
] as const);

export type GitHubPublishMode = typeof GitHubPublishModeSchema.Type;

const GitHubPublishSourceChangeClaimSchema = Schema.Literals([
  "evidence-only",
  "workspace-required",
] as const);

const GitHubCheckPollAttemptCountSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
).pipe(Schema.brand("GitHubCheckPollAttemptCount"));

type GitHubCheckPollAttemptCount =
  typeof GitHubCheckPollAttemptCountSchema.Type;

const GitHubFeedbackCountSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("GitHubFeedbackCount"));

type GitHubFeedbackCount = typeof GitHubFeedbackCountSchema.Type;

const parseGitHubFeedbackCount = Schema.decodeUnknownSync(
  GitHubFeedbackCountSchema,
);

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

const GitHubPrHeadShaSchema = Schema.NonEmptyString.pipe(
  Schema.brand("GitHubPrHeadSha"),
);

type GitHubPrHeadSha = typeof GitHubPrHeadShaSchema.Type;

export const GitHubChecksStatusSchema = Schema.Literals([
  "no-checks",
  "pending",
  "passed",
  "failed",
] as const);

export type GitHubChecksStatus = typeof GitHubChecksStatusSchema.Type;

export const GitHubPrFeedbackStatusSchema = Schema.Literals([
  "awaiting-review",
  "changes-requested",
  "clear",
  "comments",
] as const);

/** GitHub PR human-feedback status recorded for a Gaia run. */
export type GitHubPrFeedbackStatus =
  typeof GitHubPrFeedbackStatusSchema.Type;

export const GitHubPrFeedbackNextActionSchema = Schema.Literals([
  "address-review-comments",
  "await-review",
  "complete",
  "respond-to-comments",
] as const);

/** Next operator or agent action recommended by the PR feedback watcher. */
export type GitHubPrFeedbackNextAction =
  typeof GitHubPrFeedbackNextActionSchema.Type;

export class GitHubCheckRun extends Schema.Class<GitHubCheckRun>(
  "GitHubCheckRun",
)({
  link: Schema.optionalKey(Schema.String),
  name: Schema.NonEmptyString,
  state: Schema.NonEmptyString,
  workflow: Schema.optionalKey(Schema.String),
}) {}

export class GitHubPrFeedbackComment extends Schema.Class<GitHubPrFeedbackComment>(
  "GitHubPrFeedbackComment",
)({
  authorLogin: Schema.optionalKey(Schema.String),
  body: Schema.String,
  createdAt: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
}) {}

export class GitHubPrFeedbackReview extends Schema.Class<GitHubPrFeedbackReview>(
  "GitHubPrFeedbackReview",
)({
  authorLogin: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  state: Schema.NonEmptyString,
  submittedAt: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
}) {}

export class GitHubPrFeedback extends Schema.Class<GitHubPrFeedback>(
  "GitHubPrFeedback",
)({
  commentCount: GitHubFeedbackCountSchema,
  comments: Schema.Array(GitHubPrFeedbackComment),
  headSha: Schema.optionalKey(GitHubPrHeadShaSchema),
  latestReviews: Schema.Array(GitHubPrFeedbackReview),
  nextAction: GitHubPrFeedbackNextActionSchema,
  notes: Schema.Array(Schema.String),
  pr: GitHubPullRequestSelectorSchema,
  reviewCount: GitHubFeedbackCountSchema,
  reviewDecision: Schema.optionalKey(Schema.String),
  reviewRequestCount: GitHubFeedbackCountSchema,
  status: GitHubPrFeedbackStatusSchema,
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  version: Schema.Literal(1),
}) {}

export class GitHubPrFeedbackSummary extends Schema.Class<GitHubPrFeedbackSummary>(
  "GitHubPrFeedbackSummary",
)({
  commentCount: GitHubFeedbackCountSchema,
  comments: Schema.Array(GitHubPrFeedbackComment),
  feedbackPath: Schema.NonEmptyString,
  headSha: Schema.optionalKey(GitHubPrHeadShaSchema),
  latestReviews: Schema.Array(GitHubPrFeedbackReview),
  nextAction: GitHubPrFeedbackNextActionSchema,
  notes: Schema.Array(Schema.String),
  pr: GitHubPullRequestSelectorSchema,
  reviewCount: GitHubFeedbackCountSchema,
  reviewDecision: Schema.optionalKey(Schema.String),
  reviewRequestCount: GitHubFeedbackCountSchema,
  runId: RunIdSchema,
  status: GitHubPrFeedbackStatusSchema,
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
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
  headSha: Schema.optionalKey(GitHubPrHeadShaSchema),
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
  headSha: Schema.optionalKey(GitHubPrHeadShaSchema),
  observedAt: Schema.NonEmptyString,
  pr: GitHubPullRequestSelectorSchema,
  runId: RunIdSchema,
  snapshotPath: Schema.NonEmptyString,
  status: GitHubChecksStatusSchema,
  terminal: Schema.Boolean,
  watchStatePath: Schema.NonEmptyString,
}) {}

export const GitHubCiWatchNextActionSchema = Schema.Literals([
  "complete",
  "fix-failed-checks",
  "poll-again",
] as const);

/** Next operator or agent action recommended by the CI watcher. */
export type GitHubCiWatchNextAction =
  typeof GitHubCiWatchNextActionSchema.Type;

export class GitHubCiWatchState extends Schema.Class<GitHubCiWatchState>(
  "GitHubCiWatchState",
)({
  attempts: GitHubCheckPollAttemptCountSchema,
  headSha: Schema.optionalKey(GitHubPrHeadShaSchema),
  lastSnapshotPath: Schema.NonEmptyString,
  lastStatus: GitHubChecksStatusSchema,
  nextAction: GitHubCiWatchNextActionSchema,
  pr: GitHubPullRequestSelectorSchema,
  runId: RunIdSchema,
  terminal: Schema.Boolean,
  updatedAt: Schema.NonEmptyString,
  version: Schema.Literal(1),
}) {}

export const GitHubCiWatchResultSourceSchema = Schema.Literals([
  "already-terminal",
  "recorded",
] as const);

/** Whether a CI watch summary came from a new snapshot or stored terminal state. */
export type GitHubCiWatchResultSource =
  typeof GitHubCiWatchResultSourceSchema.Type;

/** Agent-facing summary returned by the resumable GitHub CI watcher. */
export class GitHubCiWatchSummary extends Schema.Class<GitHubCiWatchSummary>(
  "GitHubCiWatchSummary",
)({
  attempts: GitHubCheckPollAttemptCountSchema,
  checks: Schema.Array(GitHubCheckRun),
  failedChecks: Schema.Array(GitHubCheckRun),
  headSha: Schema.optionalKey(GitHubPrHeadShaSchema),
  nextAction: GitHubCiWatchNextActionSchema,
  pendingChecks: Schema.Array(GitHubCheckRun),
  pr: GitHubPullRequestSelectorSchema,
  runId: RunIdSchema,
  snapshotPath: Schema.NonEmptyString,
  source: GitHubCiWatchResultSourceSchema,
  status: GitHubChecksStatusSchema,
  terminal: Schema.Boolean,
  watchStatePath: Schema.NonEmptyString,
}) {}

export const GitHubPrLoopStatusSchema = Schema.Literals([
  "blocked",
  "ready",
  "waiting",
] as const);

/** Combined CI and human-feedback state for a GitHub PR loop. */
export type GitHubPrLoopStatus = typeof GitHubPrLoopStatusSchema.Type;

export const GitHubPrLoopNextActionSchema = Schema.Literals([
  "address-review-comments",
  "await-review",
  "fix-failed-checks",
  "ready-for-merge-decision",
  "respond-to-comments",
  "wait-for-ci",
] as const);

/** Next operator or agent action recommended by the combined PR-loop watcher. */
export type GitHubPrLoopNextAction =
  typeof GitHubPrLoopNextActionSchema.Type;

export const GitHubPrLoopBlockerKindSchema = Schema.Literals([
  "awaiting-review",
  "changes-requested",
  "failed-checks",
  "pending-checks",
  "pr-comments",
] as const);

/** Why a PR loop is not ready for a merge decision. */
export type GitHubPrLoopBlockerKind =
  typeof GitHubPrLoopBlockerKindSchema.Type;

export class GitHubPrLoopBlocker extends Schema.Class<GitHubPrLoopBlocker>(
  "GitHubPrLoopBlocker",
)({
  action: GitHubPrLoopNextActionSchema,
  kind: GitHubPrLoopBlockerKindSchema,
  summary: Schema.NonEmptyString,
}) {}

export class GitHubPrLoopState extends Schema.Class<GitHubPrLoopState>(
  "GitHubPrLoopState",
)({
  blockerCount: GitHubFeedbackCountSchema,
  blockers: Schema.Array(GitHubPrLoopBlocker),
  checksPath: Schema.NonEmptyString,
  checksStatus: GitHubChecksStatusSchema,
  feedbackPath: Schema.NonEmptyString,
  feedbackStatus: GitHubPrFeedbackStatusSchema,
  headSha: Schema.optionalKey(GitHubPrHeadShaSchema),
  nextAction: GitHubPrLoopNextActionSchema,
  observedAt: Schema.NonEmptyString,
  pr: GitHubPullRequestSelectorSchema,
  runId: RunIdSchema,
  status: GitHubPrLoopStatusSchema,
  version: Schema.Literal(1),
}) {}

export class GitHubPrLoopSummary extends Schema.Class<GitHubPrLoopSummary>(
  "GitHubPrLoopSummary",
)({
  blockerCount: GitHubFeedbackCountSchema,
  blockers: Schema.Array(GitHubPrLoopBlocker),
  checksPath: Schema.NonEmptyString,
  checksStatus: GitHubChecksStatusSchema,
  feedbackPath: Schema.NonEmptyString,
  feedbackStatus: GitHubPrFeedbackStatusSchema,
  headSha: Schema.optionalKey(GitHubPrHeadShaSchema),
  nextAction: GitHubPrLoopNextActionSchema,
  pr: GitHubPullRequestSelectorSchema,
  runId: RunIdSchema,
  statePath: Schema.NonEmptyString,
  status: GitHubPrLoopStatusSchema,
}) {}

export class GitHubPrCommentSummary extends Schema.Class<GitHubPrCommentSummary>(
  "GitHubPrCommentSummary",
)({
  commentPath: Schema.NonEmptyString,
  commentUrl: Schema.optionalKey(Schema.String),
  pr: GitHubPullRequestSelectorSchema,
  runId: RunIdSchema,
  status: Schema.Literal("posted"),
}) {}

export class GitHubRemediationSpecSummary extends Schema.Class<GitHubRemediationSpecSummary>(
  "GitHubRemediationSpecSummary",
)({
  blockerCount: GitHubFeedbackCountSchema,
  blockers: Schema.Array(GitHubPrLoopBlocker),
  nextAction: GitHubPrLoopNextActionSchema,
  pr: GitHubPullRequestSelectorSchema,
  prLoopPath: Schema.NonEmptyString,
  runId: RunIdSchema,
  specPath: Schema.NonEmptyString,
  status: Schema.Literal("created"),
  title: Schema.NonEmptyString,
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
  workspaceGate: Schema.optionalKey(WorkspacePrQualityGate),
}) {}

export class GitHubPreflightCheck extends Schema.Class<GitHubPreflightCheck>(
  "GitHubPreflightCheck",
)({
  name: GitHubPreflightCheckNameSchema,
  status: Schema.Literal("passed"),
}) {}

export class GitHubPublishPreflightSummary extends Schema.Class<GitHubPublishPreflightSummary>(
  "GitHubPublishPreflightSummary",
)({
  baseBranch: Schema.NonEmptyString,
  checks: Schema.Array(GitHubPreflightCheck),
  currentBranch: Schema.NonEmptyString,
  remoteName: Schema.NonEmptyString,
  runId: RunIdSchema,
  status: Schema.Literal("passed"),
}) {}

export class GitHubPublishPreviewCommand extends Schema.Class<GitHubPublishPreviewCommand>(
  "GitHubPublishPreviewCommand",
)({
  args: Schema.Array(Schema.String),
  command: Schema.NonEmptyString,
}) {}

export class GitHubPublishPreview extends Schema.Class<GitHubPublishPreview>(
  "GitHubPublishPreview",
)({
  baseBranch: Schema.NonEmptyString,
  branchName: Schema.NonEmptyString,
  commands: Schema.Array(GitHubPublishPreviewCommand),
  currentBranch: Schema.NonEmptyString,
  evidencePath: Schema.NonEmptyString,
  mode: GitHubPublishModeSchema,
  remoteName: Schema.NonEmptyString,
  runId: RunIdSchema,
  sourceChanges: GitHubPublishSourceChangeClaimSchema,
  status: Schema.Literal("preview"),
  workspaceGate: Schema.optionalKey(WorkspacePrQualityGate),
}) {}

class GitHubPrViewAuthor extends Schema.Class<GitHubPrViewAuthor>(
  "GitHubPrViewAuthor",
)({
  login: Schema.optionalKey(Schema.String),
}) {}

class GitHubPrViewComment extends Schema.Class<GitHubPrViewComment>(
  "GitHubPrViewComment",
)({
  author: Schema.optionalKey(Schema.NullOr(GitHubPrViewAuthor)),
  body: Schema.String,
  createdAt: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
}) {}

class GitHubPrViewReview extends Schema.Class<GitHubPrViewReview>(
  "GitHubPrViewReview",
)({
  author: Schema.optionalKey(Schema.NullOr(GitHubPrViewAuthor)),
  body: Schema.optionalKey(Schema.String),
  state: Schema.NonEmptyString,
  submittedAt: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
}) {}

class GitHubPrFeedbackView extends Schema.Class<GitHubPrFeedbackView>(
  "GitHubPrFeedbackView",
)({
  comments: Schema.Array(GitHubPrViewComment),
  headRefOid: Schema.optionalKey(GitHubPrHeadShaSchema),
  isDraft: Schema.Boolean,
  latestReviews: Schema.Array(GitHubPrViewReview),
  reviewDecision: Schema.NullOr(Schema.String),
  reviewRequests: Schema.Array(Schema.Unknown),
  title: Schema.String,
  url: Schema.String,
}) {}

class GitHubPrHeadView extends Schema.Class<GitHubPrHeadView>(
  "GitHubPrHeadView",
)({
  headRefOid: GitHubPrHeadShaSchema,
}) {}

const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const parseHarnessRunResultJson = Schema.decodeUnknownSync(
  HarnessRunResultJson,
);
const GitHubPrFeedbackJson = Schema.toCodecJson(GitHubPrFeedback);
const encodeGitHubPrFeedbackJson = Schema.encodeSync(GitHubPrFeedbackJson);
export const parseGitHubPrFeedbackJson =
  Schema.decodeUnknownSync(GitHubPrFeedbackJson);
const GitHubChecksSnapshotJson = Schema.toCodecJson(GitHubChecksSnapshot);
const encodeGitHubChecksSnapshotJson = Schema.encodeSync(
  GitHubChecksSnapshotJson,
);
const parseGitHubChecksSnapshotJson = Schema.decodeUnknownSync(
  GitHubChecksSnapshotJson,
);
const GitHubCiWatchStateJson = Schema.toCodecJson(GitHubCiWatchState);
const encodeGitHubCiWatchStateJson = Schema.encodeSync(GitHubCiWatchStateJson);
export const parseGitHubCiWatchStateJson =
  Schema.decodeUnknownSync(GitHubCiWatchStateJson);
const GitHubPrLoopStateJson = Schema.toCodecJson(GitHubPrLoopState);
const encodeGitHubPrLoopStateJson = Schema.encodeSync(GitHubPrLoopStateJson);
export const parseGitHubPrLoopStateJson =
  Schema.decodeUnknownSync(GitHubPrLoopStateJson);

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

export type GitHubPublishPreviewOptions = GitHubPublishOptions & {
  readonly mode?: GitHubPublishMode;
};

export type GitHubCheckRecordOptions = RunStorageOptions & {
  readonly commandRunner?: GitHubCommandRunner;
  readonly maxAttempts?: number;
  readonly pollInterval?: Duration.Input;
  readonly waitForTerminal?: boolean;
};

/** Options for starting or resuming a bounded GitHub CI watch. */
export type GitHubCiWatchOptions = GitHubCheckRecordOptions & {
  readonly pullRequest?: string;
};

/** Options for recording human GitHub PR feedback for a completed run. */
export type GitHubPrFeedbackOptions = RunStorageOptions & {
  readonly commandRunner?: GitHubCommandRunner;
};

/** Options for recording combined CI and human PR feedback. */
export type GitHubPrLoopOptions = RunStorageOptions & {
  readonly commandRunner?: GitHubCommandRunner;
};

/** Options for publishing a Gaia evidence comment to a GitHub PR. */
export type GitHubPrCommentOptions = RunStorageOptions & {
  readonly commandRunner?: GitHubCommandRunner;
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

/** Verify that a completed run can be published to GitHub without mutating git. */
export function preflightGitHubPublish(
  runIdInput: string,
  options: GitHubPublishOptions = {},
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const baseBranch = options.baseBranch ?? defaultBaseBranch;
    const remoteName = options.remoteName ?? defaultRemoteName;
    const runner = options.commandRunner ?? nodeCommandRunner;
    const run = yield* statusRun(runIdInput, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before GitHub publish preflight can pass.`,
          recoverable: false,
        }),
      );
    }

    yield* requireGitRepository(runner, rootDirectory);
    yield* requireCleanWorktree(runner, rootDirectory);
    const currentBranch = yield* currentGitBranch(runner, rootDirectory);
    yield* requireRemote(runner, rootDirectory, remoteName);
    const remoteBaseHead = yield* remoteBaseBranchHead(
      runner,
      rootDirectory,
      remoteName,
      baseBranch,
    );
    const localHead = yield* currentGitHead(runner, rootDirectory);
    yield* requireLocalHeadMatchesRemoteBase({
      baseBranch,
      localHead,
      remoteBaseHead,
      remoteName,
    });
    yield* requireGitHubAuth(runner, rootDirectory);

    return GitHubPublishPreflightSummary.make({
      baseBranch,
      checks: [
        preflightCheck("run-completed"),
        preflightCheck("git-repository"),
        preflightCheck("clean-worktree"),
        preflightCheck("current-branch"),
        preflightCheck("remote-configured"),
        preflightCheck("base-branch"),
        preflightCheck("base-synchronized"),
        preflightCheck("github-auth"),
      ],
      currentBranch,
      remoteName,
      runId: run.runId,
      status: "passed",
    });
  });
}

/** Build a read-only preview of the GitHub PR commands Gaia would run. */
export function previewGitHubPublish(
  runIdInput: string,
  options: GitHubPublishPreviewOptions = {},
) {
  return Effect.gen(function* () {
    const mode = options.mode ?? "evidence";
    const preflight = yield* preflightGitHubPublish(runIdInput, options);
    const branchName =
      mode === "workspace"
        ? `gaia/${preflight.runId}-workspace`
        : `gaia/${preflight.runId}`;
    const evidencePath = `gaia-runs/${preflight.runId}`;
    const paths = yield* makeRunPaths(preflight.runId, {
      rootDirectory: options.rootDirectory ?? ".",
    });
    const workspaceGate =
      mode === "workspace"
        ? yield* evaluateWorkspacePrQualityGate(preflight.runId, paths)
        : undefined;

    return GitHubPublishPreview.make({
      baseBranch: preflight.baseBranch,
      branchName,
      commands: publishPreviewCommands({
        branchName,
        evidencePath,
        mode,
        preflight,
      }),
      currentBranch: preflight.currentBranch,
      evidencePath,
      mode,
      remoteName: preflight.remoteName,
      runId: preflight.runId,
      sourceChanges:
        mode === "workspace" ? "workspace-required" : "evidence-only",
      status: "preview",
      ...(workspaceGate === undefined ? {} : { workspaceGate }),
    });
  });
}

export function publishRunToGitHub(
  runIdInput: string,
  options: GitHubPublishOptions = {},
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const runner = options.commandRunner ?? nodeCommandRunner;
    const preflight = yield* preflightGitHubPublish(runIdInput, options);
    const branchName = `gaia/${preflight.runId}`;
    const paths = yield* makeRunPaths(preflight.runId, { rootDirectory });

    const prUrl = yield* Effect.gen(function* () {
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "fetch",
        preflight.remoteName,
        preflight.baseBranch,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "checkout",
        "-B",
        branchName,
        `${preflight.remoteName}/${preflight.baseBranch}`,
      ]);
      const evidencePath = yield* writePullRequestEvidence(
        preflight.runId,
        rootDirectory,
      );
      yield* copyRunArtifacts(paths, evidencePath);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "add",
        `gaia-runs/${preflight.runId}`,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "commit",
        "-m",
        `chore: add gaia evidence for ${preflight.runId}`,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "push",
        "--force-with-lease",
        "-u",
        preflight.remoteName,
        branchName,
      ]);
      const pr = yield* runRequiredCommand(runner, rootDirectory, "gh", [
        "pr",
        "create",
        "--draft",
        "--base",
        preflight.baseBranch,
        "--head",
        branchName,
        "--title",
        `Gaia run ${preflight.runId}`,
        "--body-file",
        `${evidencePath}/README.md`,
      ]);

      return yield* parsePullRequestUrl(pr.stdout);
    }).pipe(
      Effect.ensuring(
        runRequiredCommand(runner, rootDirectory, "git", [
          "checkout",
          preflight.currentBranch,
        ]).pipe(Effect.ignore),
      ),
    );

    return GitHubPrSummary.make({
      baseBranch: preflight.baseBranch,
      branchName,
      evidencePath: `gaia-runs/${preflight.runId}`,
      prUrl,
      runId: preflight.runId,
      status: "opened",
    });
  });
}

function publishPreviewCommands(input: Readonly<{
  branchName: string;
  evidencePath: string;
  mode: GitHubPublishMode;
  preflight: GitHubPublishPreflightSummary;
}>): ReadonlyArray<GitHubPublishPreviewCommand> {
  const commitMessage =
    input.mode === "workspace"
      ? `feat: apply gaia workspace for ${input.preflight.runId}`
      : `chore: add gaia evidence for ${input.preflight.runId}`;
  const prTitle =
    input.mode === "workspace"
      ? `Gaia workspace run ${input.preflight.runId}`
      : `Gaia run ${input.preflight.runId}`;

  return [
    previewCommand("git", [
      "fetch",
      input.preflight.remoteName,
      input.preflight.baseBranch,
    ]),
    previewCommand("git", [
      "checkout",
      "-B",
      input.branchName,
      `${input.preflight.remoteName}/${input.preflight.baseBranch}`,
    ]),
    ...(input.mode === "workspace"
      ? [
          previewCommand("git", [
            "add",
            "--all",
            "--",
            ".",
          ]),
          previewCommand("git", [
            "diff",
            "--cached",
            "--quiet",
            "--",
            ".",
          ]),
        ]
      : []),
    previewCommand("git", ["add", input.evidencePath]),
    previewCommand("git", ["commit", "-m", commitMessage]),
    previewCommand("git", [
      "push",
      "--force-with-lease",
      "-u",
      input.preflight.remoteName,
      input.branchName,
    ]),
    previewCommand("gh", [
      "pr",
      "create",
      "--draft",
      "--base",
      input.preflight.baseBranch,
      "--head",
      input.branchName,
      "--title",
      prTitle,
      "--body-file",
      `${input.evidencePath}/README.md`,
    ]),
    previewCommand("git", ["checkout", input.preflight.currentBranch]),
  ];
}

function previewCommand(
  command: string,
  args: ReadonlyArray<string>,
): GitHubPublishPreviewCommand {
  return GitHubPublishPreviewCommand.make({ args, command });
}

/** Publish a completed Gaia run workspace as a draft GitHub pull request. */
export function publishWorkspaceRunToGitHub(
  runIdInput: string,
  options: GitHubPublishOptions = {},
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const runner = options.commandRunner ?? nodeCommandRunner;
    const preflight = yield* preflightGitHubPublish(runIdInput, options);
    const branchName = `gaia/${preflight.runId}-workspace`;
    const paths = yield* makeRunPaths(preflight.runId, { rootDirectory });
    const workspaceGate = yield* evaluateWorkspacePrQualityGate(
      preflight.runId,
      paths,
    );
    yield* writeDogfoodRetrospective(preflight.runId, paths);

    yield* requireWorkspacePrQualityGatePassed(workspaceGate);

    const prUrl = yield* Effect.gen(function* () {
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "fetch",
        preflight.remoteName,
        preflight.baseBranch,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "checkout",
        "-B",
        branchName,
        `${preflight.remoteName}/${preflight.baseBranch}`,
      ]);

      yield* applyRunWorkspace(paths, rootDirectory);
      yield* stageWorkspaceChanges(runner, rootDirectory);

      const evidencePath = yield* writePullRequestEvidence(
        preflight.runId,
        rootDirectory,
      );
      yield* copyRunArtifacts(paths, evidencePath);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "add",
        `gaia-runs/${preflight.runId}`,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "commit",
        "-m",
        `feat: apply gaia workspace for ${preflight.runId}`,
      ]);
      yield* runRequiredCommand(runner, rootDirectory, "git", [
        "push",
        "--force-with-lease",
        "-u",
        preflight.remoteName,
        branchName,
      ]);
      const pr = yield* runRequiredCommand(runner, rootDirectory, "gh", [
        "pr",
        "create",
        "--draft",
        "--base",
        preflight.baseBranch,
        "--head",
        branchName,
        "--title",
        `Gaia workspace run ${preflight.runId}`,
        "--body-file",
        `${evidencePath}/README.md`,
      ]);

      return yield* parsePullRequestUrl(pr.stdout);
    }).pipe(
      Effect.ensuring(
        runRequiredCommand(runner, rootDirectory, "git", [
          "checkout",
          preflight.currentBranch,
        ]).pipe(Effect.ignore),
      ),
    );

    return GitHubPrSummary.make({
      baseBranch: preflight.baseBranch,
      branchName,
      evidencePath: `gaia-runs/${preflight.runId}`,
      prUrl,
      runId: preflight.runId,
      status: "opened",
      workspaceGate,
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
  return withRunStoreLock(
    options,
    recordGitHubChecksUnlocked(runIdInput, prInput, options),
    {
      nextSafeAction: `Wait for the active command to finish, then rerun pnpm gaia pr-loop ${runIdInput} ${prInput} to serialize check and feedback evidence.`,
      operation: "GitHub check evidence recording",
    },
  );
}

/** Resume or start a bounded CI watch for a completed Gaia run. */
export function watchGitHubChecks(
  runIdInput: string,
  options: GitHubCiWatchOptions = {},
) {
  return withRunStoreLock(
    options,
    watchGitHubChecksUnlocked(runIdInput, options),
    {
      nextSafeAction:
        options.pullRequest === undefined
          ? `Wait for the active command to finish, then rerun pnpm gaia watch-ci ${runIdInput}.`
          : `Wait for the active command to finish, then rerun pnpm gaia pr-loop ${runIdInput} ${options.pullRequest} to serialize check and feedback evidence.`,
      operation: "GitHub CI watch",
    },
  );
}

/** Record human GitHub PR feedback for a completed Gaia run. */
export function watchGitHubFeedback(
  runIdInput: string,
  prInput: string,
  options: GitHubPrFeedbackOptions = {},
) {
  return withRunStoreLock(
    options,
    watchGitHubFeedbackUnlocked(runIdInput, prInput, options),
    {
      nextSafeAction: `Wait for the active command to finish, then rerun pnpm gaia pr-loop ${runIdInput} ${prInput} to serialize check and feedback evidence.`,
      operation: "GitHub PR feedback watch",
    },
  );
}

/** Record CI and review feedback once, then recommend the next PR-loop action. */
export function coordinateGitHubPrLoop(
  runIdInput: string,
  prInput: string,
  options: GitHubPrLoopOptions = {},
) {
  return withRunStoreLock(
    options,
    coordinateGitHubPrLoopUnlocked(runIdInput, prInput, options),
    {
      nextSafeAction: `Wait for the active command to finish, then rerun pnpm gaia pr-loop ${runIdInput} ${prInput}.`,
      operation: "GitHub PR-loop evidence coordination",
    },
  );
}

/** Create a follow-up remediation spec from a blocked GitHub PR loop. */
export function createGitHubRemediationSpec(
  runIdInput: string,
  options: RunStorageOptions = {},
) {
  return withRunStoreLock(
    options,
    createGitHubRemediationSpecUnlocked(runIdInput, options),
    {
      nextSafeAction: `Wait for the active command to finish, then rerun pnpm gaia plan-remediation ${runIdInput}.`,
      operation: "GitHub PR-loop remediation planning",
    },
  );
}

/** Publish a timestamped Gaia evidence comment to a GitHub pull request. */
export function commentGitHubPullRequest(
  runIdInput: string,
  prInput: string,
  options: GitHubPrCommentOptions = {},
) {
  return withRunStoreLock(
    options,
    commentGitHubPullRequestUnlocked(runIdInput, prInput, options),
    {
      nextSafeAction: `Wait for the active command to finish, then rerun pnpm gaia comment-pr ${runIdInput} ${prInput}.`,
      operation: "GitHub PR evidence comment publishing",
    },
  );
}

function recordGitHubChecksUnlocked(
  runIdInput: string,
  prInput: string,
  options: GitHubCheckRecordOptions,
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

    const pr = yield* parseGitHubPullRequestSelectorEffect(prInput);
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
          summary: yield* inspectGitHubChecks(pr, {
            commandRunner: runner,
            rootDirectory,
          }),
        };
    const paths = yield* makeRunPaths(run.runId, { rootDirectory });
    const headSha = yield* readOptionalGitHubPullRequestHeadSha(pr, {
      rootDirectory,
      runner,
    });
    const reusable = yield* findReusableGitHubChecksRecord(paths, {
      headSha,
      summary: observed.summary,
    });

    if (reusable !== undefined) {
      return reusable;
    }

    const recorded = yield* writeGitHubChecksSnapshot(paths, {
      attempts: observed.attempts,
      headSha,
      runId: run.runId,
      summary: observed.summary,
    });
    yield* writeGitHubCiWatchState(paths, recorded);
    const checksPath = runRelative(paths, recorded.snapshotPath);
    const watchStatePath = runRelative(paths, paths.ciWatchState);

    yield* appendEvent(run.runId, paths, {
      payload: {
        attempts: recorded.attempts,
        checksPath,
        ...(recorded.headSha === undefined ? {} : { headSha: recorded.headSha }),
        pullRequest: recorded.pr,
        status: recorded.status,
        terminal: recorded.terminal,
        watchStatePath,
      },
      type: "GITHUB_CHECKS_RECORDED",
    });

    return recorded;
  });
}

function watchGitHubFeedbackUnlocked(
  runIdInput: string,
  prInput: string,
  options: GitHubPrFeedbackOptions,
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const runner = options.commandRunner ?? nodeCommandRunner;
    const run = yield* statusRun(runIdInput, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before watching GitHub PR feedback.`,
          recoverable: false,
        }),
      );
    }

    const pr = yield* parseGitHubPullRequestSelectorEffect(prInput);
    const view = yield* inspectGitHubFeedback(pr, {
      commandRunner: runner,
      rootDirectory,
    });
    const paths = yield* makeRunPaths(run.runId, { rootDirectory });
    const feedback = makeGitHubPrFeedback(pr, view);
    const reusable = yield* findReusableGitHubPrFeedback(
      paths,
      feedback,
      run.runId,
    );

    if (reusable !== undefined) {
      return reusable;
    }

    yield* writeGitHubPrFeedback(paths, feedback);

    const feedbackPath = runRelative(paths, paths.githubFeedback);

    yield* appendEvent(run.runId, paths, {
      payload: {
        commentCount: feedback.commentCount,
        feedbackPath,
        ...(feedback.headSha === undefined ? {} : { headSha: feedback.headSha }),
        nextAction: feedback.nextAction,
        pullRequest: feedback.pr,
        reviewCount: feedback.reviewCount,
        reviewRequestCount: feedback.reviewRequestCount,
        status: feedback.status,
      },
      type: "GITHUB_FEEDBACK_RECORDED",
    });

    return gitHubPrFeedbackSummaryFromFeedback(paths, feedback, run.runId);
  });
}

function coordinateGitHubPrLoopUnlocked(
  runIdInput: string,
  prInput: string,
  options: GitHubPrLoopOptions,
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const runner = options.commandRunner ?? nodeCommandRunner;
    const run = yield* statusRun(runIdInput, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before coordinating the GitHub PR loop.`,
          recoverable: false,
        }),
      );
    }

    const checks = yield* recordGitHubChecksUnlocked(run.runId, prInput, {
      commandRunner: runner,
      rootDirectory,
      waitForTerminal: false,
    });
    const feedback = yield* watchGitHubFeedbackUnlocked(run.runId, prInput, {
      commandRunner: runner,
      rootDirectory,
    });
    yield* requireMatchingGitHubPrHead(checks, feedback);
    const paths = yield* makeRunPaths(run.runId, { rootDirectory });
    const state = makeGitHubPrLoopState({ checks, feedback, paths });
    const reusable = yield* findReusableGitHubPrLoopState(paths, state);

    if (reusable !== undefined) {
      return reusable;
    }

    yield* writeGitHubPrLoopState(paths, state);

    const statePath = runRelative(paths, paths.prLoopState);

    yield* appendEvent(run.runId, paths, {
      payload: {
        blockerCount: state.blockerCount,
        ...(state.headSha === undefined ? {} : { headSha: state.headSha }),
        nextAction: state.nextAction,
        prLoopPath: statePath,
        pullRequest: state.pr,
        status: state.status,
      },
      type: "GITHUB_PR_LOOP_RECORDED",
    });
    yield* writeDogfoodRetrospective(run.runId, paths);

    return gitHubPrLoopSummaryFromState(paths, state);
  });
}

function createGitHubRemediationSpecUnlocked(
  runIdInput: string,
  options: RunStorageOptions,
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const run = yield* statusRun(runIdInput, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before creating a remediation spec.`,
          recoverable: false,
        }),
      );
    }

    const paths = yield* makeRunPaths(run.runId, { rootDirectory });
    const prLoop = yield* readGitHubPrLoopState(paths);

    if (prLoop.status !== "blocked") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitHubPrLoopNotBlocked",
          message: `Run ${run.runId} has PR-loop status '${prLoop.status}', so there is no remediation spec to create.`,
          recoverable: false,
        }),
      );
    }

    const title = `Remediate GitHub PR ${prLoop.pr}`;
    yield* writeGitHubRemediationSpec(paths, {
      body: gitHubRemediationSpecMarkdown({ prLoop, title }),
    });

    const remediationSpecPath = runRelative(paths, paths.githubRemediationSpec);
    const prLoopPath = runRelative(paths, paths.prLoopState);

    yield* appendEvent(run.runId, paths, {
      payload: {
        blockerCount: prLoop.blockerCount,
        nextAction: prLoop.nextAction,
        pullRequest: prLoop.pr,
        remediationSpecPath,
      },
      type: "GITHUB_REMEDIATION_SPEC_RECORDED",
    });

    return GitHubRemediationSpecSummary.make({
      blockerCount: prLoop.blockerCount,
      blockers: prLoop.blockers,
      nextAction: prLoop.nextAction,
      pr: prLoop.pr,
      prLoopPath,
      runId: prLoop.runId,
      specPath: paths.githubRemediationSpec,
      status: "created",
      title,
    });
  });
}

function commentGitHubPullRequestUnlocked(
  runIdInput: string,
  prInput: string,
  options: GitHubPrCommentOptions,
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const runner = options.commandRunner ?? nodeCommandRunner;
    const run = yield* statusRun(runIdInput, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before Gaia can comment on a pull request.`,
          recoverable: false,
        }),
      );
    }

    const pr = yield* parseGitHubPullRequestSelectorEffect(prInput);
    const paths = yield* makeRunPaths(run.runId, { rootDirectory });
    const commentBody = yield* gitHubPrCommentMarkdown({
      paths,
      pr,
      runId: run.runId,
    });

    yield* writeGitHubPrComment(paths, { body: commentBody });
    yield* requireGitRepository(runner, rootDirectory);
    yield* requireGitHubAuth(runner, rootDirectory);
    const result = yield* runRequiredCommand(runner, rootDirectory, "gh", [
      "pr",
      "comment",
      pr,
      "--body-file",
      paths.githubPrComment,
    ]);
    const commentUrl = optionalTrimmedString(result.stdout);
    const commentPath = runRelative(paths, paths.githubPrComment);

    yield* appendEvent(run.runId, paths, {
      payload: {
        commentPath,
        pullRequest: pr,
        ...(commentUrl === undefined ? {} : { commentUrl }),
      },
      type: "GITHUB_PR_COMMENT_RECORDED",
    });

    return GitHubPrCommentSummary.make({
      commentPath: paths.githubPrComment,
      ...(commentUrl === undefined ? {} : { commentUrl }),
      pr,
      runId: run.runId,
      status: "posted",
    });
  });
}

function inspectGitHubFeedback(
  pr: GitHubPullRequestSelector,
  options: Readonly<{
    commandRunner: GitHubCommandRunner;
    rootDirectory: string;
  }>,
) {
  return Effect.gen(function* () {
    const result = yield* runRequiredCommand(
      options.commandRunner,
      options.rootDirectory,
      "gh",
      [
        "pr",
        "view",
        pr,
        "--json",
        "comments,headRefOid,isDraft,latestReviews,reviewDecision,reviewRequests,title,url",
      ],
    );

    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(result.stdout),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubFeedbackJsonInvalid",
          message: "GitHub PR feedback output was not valid JSON.",
          recoverable: true,
        }),
    });

    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(GitHubPrFeedbackView)(parsed),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubFeedbackInvalid",
          message: "GitHub PR feedback output did not match Gaia's schema.",
          recoverable: true,
        }),
    });
  });
}

function watchGitHubChecksUnlocked(
  runIdInput: string,
  options: GitHubCiWatchOptions,
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const run = yield* statusRun(runIdInput, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before watching GitHub checks.`,
          recoverable: false,
        }),
      );
    }

    const paths = yield* makeRunPaths(run.runId, { rootDirectory });
    const storedWatchState = yield* readOptionalGitHubCiWatchState(paths);
    const requestedPr = options.pullRequest === undefined
      ? undefined
      : yield* parseGitHubPullRequestSelectorEffect(options.pullRequest);

    if (
      requestedPr === undefined &&
      storedWatchState !== undefined &&
      storedWatchState.terminal
    ) {
      const snapshot = yield* readGitHubChecksSnapshot(
        paths,
        storedWatchState.lastSnapshotPath,
      );

      return ciWatchSummaryFromSnapshot({
        paths,
        snapshot,
        source: "already-terminal",
        state: storedWatchState,
      });
    }

    const pr = requestedPr ?? storedWatchState?.pr;

    if (pr === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitHubCiWatchStateMissing",
          message:
            "Gaia cannot resume CI watching because this run has no ci-watch-state.json yet. Pass a pull request selector to start the watch.",
          recoverable: false,
        }),
      );
    }

    if (
      requestedPr !== undefined &&
      storedWatchState !== undefined &&
      storedWatchState.terminal &&
      storedWatchState.pr === requestedPr
    ) {
      const headSha = yield* readOptionalGitHubPullRequestHeadSha(requestedPr, {
        rootDirectory,
        runner: options.commandRunner ?? nodeCommandRunner,
      });

      if (headSha !== undefined && storedWatchState.headSha === headSha) {
        const snapshot = yield* readGitHubChecksSnapshot(
          paths,
          storedWatchState.lastSnapshotPath,
        );

        return ciWatchSummaryFromSnapshot({
          paths,
          snapshot,
          source: "already-terminal",
          state: storedWatchState,
        });
      }
    }

    const record = yield* recordGitHubChecksUnlocked(
      run.runId,
      pr,
      gitHubCheckRecordOptionsForWatch(rootDirectory, options),
    );

    return ciWatchSummaryFromRecord(record, "recorded");
  });
}

function gitHubCheckRecordOptionsForWatch(
  rootDirectory: string,
  options: GitHubCiWatchOptions,
): GitHubCheckRecordOptions {
  return {
    rootDirectory,
    waitForTerminal: true,
    ...(options.commandRunner === undefined
      ? {}
      : { commandRunner: options.commandRunner }),
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
    ...(options.pollInterval === undefined
      ? {}
      : { pollInterval: options.pollInterval }),
  };
}

function makeGitHubPrFeedback(
  pr: GitHubPullRequestSelector,
  view: GitHubPrFeedbackView,
) {
  const comments = view.comments.map(normalizeGitHubComment);
  const latestReviews = view.latestReviews.map(normalizeGitHubReview);
  const status = classifyGitHubFeedback(view);
  const nextAction = nextActionForGitHubFeedbackStatus(status);

  return GitHubPrFeedback.make({
    commentCount: parseGitHubFeedbackCount(comments.length),
    comments,
    ...(view.headRefOid === undefined ? {} : { headSha: view.headRefOid }),
    latestReviews,
    nextAction,
    notes: [
      "GitHub CLI pr view does not expose unresolved review-thread state. Gaia records latest reviews, PR comments, and requested-reviewer count.",
    ],
    pr,
    reviewCount: parseGitHubFeedbackCount(latestReviews.length),
    ...(view.reviewDecision === null
      ? {}
      : { reviewDecision: view.reviewDecision }),
    reviewRequestCount: parseGitHubFeedbackCount(view.reviewRequests.length),
    status,
    title: view.title,
    url: view.url,
    version: 1,
  });
}

function normalizeGitHubComment(
  comment: GitHubPrViewComment,
): GitHubPrFeedbackComment {
  return GitHubPrFeedbackComment.make({
    ...(comment.author?.login === undefined
      ? {}
      : { authorLogin: comment.author.login }),
    body: comment.body,
    ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
    ...(comment.url === undefined ? {} : { url: comment.url }),
  });
}

function normalizeGitHubReview(
  review: GitHubPrViewReview,
): GitHubPrFeedbackReview {
  return GitHubPrFeedbackReview.make({
    ...(review.author?.login === undefined
      ? {}
      : { authorLogin: review.author.login }),
    ...(review.body === undefined ? {} : { body: review.body }),
    state: review.state,
    ...(review.submittedAt === undefined
      ? {}
      : { submittedAt: review.submittedAt }),
    ...(review.url === undefined ? {} : { url: review.url }),
  });
}

function writeGitHubPrFeedback(
  paths: RunPaths,
  feedback: GitHubPrFeedback,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      paths.githubFeedback,
      `${JSON.stringify(encodeGitHubPrFeedbackJson(feedback), null, 2)}\n`,
    );
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubFeedbackWriteFailed",
          message: "Gaia could not write GitHub PR feedback evidence.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function findReusableGitHubPrFeedback(
  paths: RunPaths,
  feedback: GitHubPrFeedback,
  runId: RunId,
) {
  return Effect.gen(function* () {
    if (feedback.headSha === undefined) {
      return undefined;
    }

    const stored = yield* readOptionalGitHubPrFeedback(paths);

    if (
      stored === undefined ||
      !sameGitHubPrFeedback(stored, feedback)
    ) {
      return undefined;
    }

    return gitHubPrFeedbackSummaryFromFeedback(paths, stored, runId);
  });
}

function readOptionalGitHubPrFeedback(paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(paths.githubFeedback);

    if (!exists) {
      return undefined;
    }

    const contents = yield* fs.readFileString(paths.githubFeedback);
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubFeedbackJsonInvalid",
          message: "GitHub PR feedback evidence was not valid JSON.",
          recoverable: true,
        }),
    });

    return yield* Effect.try({
      try: () => parseGitHubPrFeedbackJson(parsed),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubFeedbackInvalid",
          message: "GitHub PR feedback evidence did not match Gaia's schema.",
          recoverable: true,
        }),
    });
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubFeedbackReadFailed",
          message: "Gaia could not read GitHub PR feedback evidence.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function gitHubPrFeedbackSummaryFromFeedback(
  paths: RunPaths,
  feedback: GitHubPrFeedback,
  runId: RunId,
) {
  return GitHubPrFeedbackSummary.make({
    commentCount: feedback.commentCount,
    comments: feedback.comments,
    feedbackPath: paths.githubFeedback,
    ...(feedback.headSha === undefined ? {} : { headSha: feedback.headSha }),
    latestReviews: feedback.latestReviews,
    nextAction: feedback.nextAction,
    notes: feedback.notes,
    pr: feedback.pr,
    reviewCount: feedback.reviewCount,
    ...(feedback.reviewDecision === undefined
      ? {}
      : { reviewDecision: feedback.reviewDecision }),
    reviewRequestCount: feedback.reviewRequestCount,
    runId,
    status: feedback.status,
    ...(feedback.title === undefined ? {} : { title: feedback.title }),
    ...(feedback.url === undefined ? {} : { url: feedback.url }),
  });
}

function sameGitHubPrFeedback(
  left: GitHubPrFeedback,
  right: GitHubPrFeedback,
) {
  return (
    left.headSha !== undefined &&
    left.headSha === right.headSha &&
    left.pr === right.pr &&
    left.status === right.status &&
    left.nextAction === right.nextAction &&
    left.commentCount === right.commentCount &&
    left.reviewCount === right.reviewCount &&
    left.reviewRequestCount === right.reviewRequestCount &&
    left.reviewDecision === right.reviewDecision &&
    left.title === right.title &&
    left.url === right.url &&
    stableJson(left.comments) === stableJson(right.comments) &&
    stableJson(left.latestReviews) === stableJson(right.latestReviews)
  );
}

function makeGitHubPrLoopState(
  input: Readonly<{
    checks: GitHubChecksRecord;
    feedback: GitHubPrFeedbackSummary;
    paths: RunPaths;
  }>,
) {
  const blockers = gitHubPrLoopBlockers(input.checks, input.feedback);
  const firstBlocker = blockers.at(0);
  const nextAction =
    firstBlocker === undefined
      ? "ready-for-merge-decision"
      : firstBlocker.action;

  return GitHubPrLoopState.make({
    blockerCount: parseGitHubFeedbackCount(blockers.length),
    blockers,
    checksPath: runRelative(input.paths, input.checks.snapshotPath),
    checksStatus: input.checks.status,
    feedbackPath: runRelative(input.paths, input.feedback.feedbackPath),
    feedbackStatus: input.feedback.status,
    ...(input.feedback.headSha === undefined
      ? input.checks.headSha === undefined
        ? {}
        : { headSha: input.checks.headSha }
      : { headSha: input.feedback.headSha }),
    nextAction,
    observedAt: new Date().toISOString(),
    pr: input.feedback.pr,
    runId: input.feedback.runId,
    status: gitHubPrLoopStatus(blockers),
    version: 1,
  });
}

function requireMatchingGitHubPrHead(
  checks: GitHubChecksRecord,
  feedback: GitHubPrFeedbackSummary,
) {
  if (
    checks.headSha === undefined ||
    feedback.headSha === undefined ||
    checks.headSha === feedback.headSha
  ) {
    return Effect.void;
  }

  return Effect.fail(
    makeRuntimeError({
      code: "GitHubPrHeadMismatch",
      message:
        "GitHub PR checks and feedback were observed from different head SHAs. Rerun the PR-loop command so Gaia records one coherent PR state.",
      recoverable: true,
    }),
  );
}

function gitHubPrLoopBlockers(
  checks: GitHubChecksRecord,
  feedback: GitHubPrFeedbackSummary,
) {
  const blockers: Array<GitHubPrLoopBlocker> = [];

  if (feedback.status === "changes-requested") {
    blockers.push(
      GitHubPrLoopBlocker.make({
        action: "address-review-comments",
        kind: "changes-requested",
        summary: "GitHub review requested changes.",
      }),
    );
  }

  if (checks.status === "failed") {
    blockers.push(
      GitHubPrLoopBlocker.make({
        action: "fix-failed-checks",
        kind: "failed-checks",
        summary: `${failedChecks(checks.checks).length} check(s) failed.`,
      }),
    );
  }

  if (feedback.status === "comments") {
    blockers.push(
      GitHubPrLoopBlocker.make({
        action: "respond-to-comments",
        kind: "pr-comments",
        summary: `${feedback.commentCount} PR comment(s) need response.`,
      }),
    );
  }

  if (checks.status === "pending") {
    blockers.push(
      GitHubPrLoopBlocker.make({
        action: "wait-for-ci",
        kind: "pending-checks",
        summary: `${pendingChecks(checks.checks).length} check(s) pending.`,
      }),
    );
  }

  if (feedback.status === "awaiting-review") {
    blockers.push(
      GitHubPrLoopBlocker.make({
        action: "await-review",
        kind: "awaiting-review",
        summary: "PR is waiting for review.",
      }),
    );
  }

  return blockers;
}

function gitHubPrLoopStatus(
  blockers: ReadonlyArray<GitHubPrLoopBlocker>,
): GitHubPrLoopStatus {
  if (blockers.length === 0) {
    return "ready";
  }

  if (
    blockers.some(
      (blocker) =>
        blocker.kind === "changes-requested" ||
        blocker.kind === "failed-checks" ||
        blocker.kind === "pr-comments",
    )
  ) {
    return "blocked";
  }

  return "waiting";
}

function writeGitHubPrLoopState(
  paths: RunPaths,
  state: GitHubPrLoopState,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      paths.prLoopState,
      `${JSON.stringify(encodeGitHubPrLoopStateJson(state), null, 2)}\n`,
    );
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubPrLoopStateWriteFailed",
          message: "Gaia could not write GitHub PR loop state.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function findReusableGitHubPrLoopState(
  paths: RunPaths,
  state: GitHubPrLoopState,
) {
  return Effect.gen(function* () {
    if (state.headSha === undefined) {
      return undefined;
    }

    const stored = yield* readOptionalGitHubPrLoopState(paths);

    if (stored === undefined || !sameGitHubPrLoopState(stored, state)) {
      return undefined;
    }

    return gitHubPrLoopSummaryFromState(paths, stored);
  });
}

function gitHubPrLoopSummaryFromState(
  paths: RunPaths,
  state: GitHubPrLoopState,
) {
  return GitHubPrLoopSummary.make({
    blockerCount: state.blockerCount,
    blockers: state.blockers,
    checksPath: state.checksPath,
    checksStatus: state.checksStatus,
    feedbackPath: state.feedbackPath,
    feedbackStatus: state.feedbackStatus,
    ...(state.headSha === undefined ? {} : { headSha: state.headSha }),
    nextAction: state.nextAction,
    pr: state.pr,
    runId: state.runId,
    statePath: paths.prLoopState,
    status: state.status,
  });
}

function sameGitHubPrLoopState(
  left: GitHubPrLoopState,
  right: GitHubPrLoopState,
) {
  return (
    left.headSha !== undefined &&
    left.headSha === right.headSha &&
    left.pr === right.pr &&
    left.runId === right.runId &&
    left.status === right.status &&
    left.nextAction === right.nextAction &&
    left.blockerCount === right.blockerCount &&
    left.checksPath === right.checksPath &&
    left.checksStatus === right.checksStatus &&
    left.feedbackPath === right.feedbackPath &&
    left.feedbackStatus === right.feedbackStatus &&
    stableJson(left.blockers) === stableJson(right.blockers)
  );
}

function readGitHubPrLoopState(paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(paths.prLoopState);

    if (!exists) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitHubPrLoopStateMissing",
          message: "Gaia could not find pr-loop-state.json for this run.",
          recoverable: false,
        }),
      );
    }

    const contents = yield* fs.readFileString(paths.prLoopState);
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubPrLoopStateJsonInvalid",
          message: "GitHub PR loop state was not valid JSON.",
          recoverable: true,
        }),
    });

    return yield* Effect.try({
      try: () => parseGitHubPrLoopStateJson(parsed),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubPrLoopStateInvalid",
          message: "GitHub PR loop state did not match Gaia's schema.",
          recoverable: true,
        }),
    });
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubPrLoopStateReadFailed",
          message: "Gaia could not read GitHub PR loop state.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function readOptionalGitHubPrLoopState(paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(paths.prLoopState);
    return exists ? yield* readGitHubPrLoopState(paths) : undefined;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubPrLoopStateReadFailed",
          message: "Gaia could not read GitHub PR loop state.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function writeGitHubRemediationSpec(
  paths: RunPaths,
  input: Readonly<{ body: string }>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(paths.githubRemediationSpec, input.body);
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubRemediationSpecWriteFailed",
          message: "Gaia could not write the GitHub remediation spec.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function gitHubPrCommentMarkdown(
  input: Readonly<{
    paths: RunPaths;
    pr: GitHubPullRequestSelector;
    runId: RunId;
  }>,
) {
  return Effect.gen(function* () {
    const artifacts = yield* gitHubPrCommentArtifacts(input.paths, input.runId);
    const prLoop = yield* readOptionalGitHubPrLoopState(input.paths);
    const prLoopLines =
      prLoop === undefined
        ? []
        : [
            `PR-loop status: \`${prLoop.status}\``,
            `Next action: \`${prLoop.nextAction}\``,
            `Blockers: \`${prLoop.blockerCount}\``,
          ];

    return [
      `<!-- gaia:evidence-comment run-id=${input.runId} -->`,
      "",
      `## Gaia evidence for \`${input.runId}\``,
      "",
      `GitHub PR: \`${input.pr}\``,
      `Posted: ${new Date().toISOString()}`,
      ...prLoopLines,
      "",
      "This is a timestamped Gaia evidence comment. Rerunning the command posts a new comment for the latest observation.",
      "",
      "### Evidence artifacts",
      "",
      "If this PR branch contains Gaia evidence, inspect:",
      "",
      ...artifacts.map(
        (artifact) => `- ${artifact.label}: \`${artifact.path}\``,
      ),
      "",
      "Gaia has not approved, merged, or resolved review feedback with this comment.",
      "",
    ].join("\n");
  });
}

function gitHubPrCommentArtifacts(paths: RunPaths, runId: RunId) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const evidenceRoot = `gaia-runs/${runId}`;
    const optionalArtifacts = [
      {
        exists: yield* fs.exists(paths.githubChecks),
        label: "GitHub check snapshots",
        path: `${evidenceRoot}/github-checks/`,
      },
      {
        exists: yield* fs.exists(paths.githubFeedback),
        label: "GitHub PR feedback",
        path: `${evidenceRoot}/github-feedback.json`,
      },
      {
        exists: yield* fs.exists(paths.prLoopState),
        label: "PR-loop state",
        path: `${evidenceRoot}/pr-loop-state.json`,
      },
      {
        exists: yield* fs.exists(paths.dogfoodRetrospective),
        label: "Dogfood retrospective",
        path: `${evidenceRoot}/dogfood-retrospective.json`,
      },
      {
        exists: yield* fs.exists(paths.evidencePromotionJson),
        label: "Evidence promotion",
        path: `${evidenceRoot}/evidence-promotion.json`,
      },
      {
        exists: yield* fs.exists(paths.evidencePromotionMarkdown),
        label: "Evidence promotion Markdown",
        path: `${evidenceRoot}/evidence-promotion.md`,
      },
      {
        exists: yield* fs.exists(paths.githubRemediationSpec),
        label: "Remediation spec",
        path: `${evidenceRoot}/remediation-spec.md`,
      },
      {
        exists: yield* fs.exists(paths.browserEvidence),
        label: "Browser evidence",
        path: `${evidenceRoot}/browser-evidence.json`,
      },
    ];

    return [
      { label: "Run report", path: `${evidenceRoot}/report.md` },
      { label: "Machine report", path: `${evidenceRoot}/report.json` },
      ...optionalArtifacts
        .filter((artifact) => artifact.exists)
        .map((artifact) => ({
          label: artifact.label,
          path: artifact.path,
        })),
    ];
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubPrCommentArtifactReadFailed",
          message: "Gaia could not inspect run artifacts for the PR comment.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function writeGitHubPrComment(
  paths: RunPaths,
  input: Readonly<{ body: string }>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(paths.githubPrComment, input.body);
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubPrCommentWriteFailed",
          message: "Gaia could not write the GitHub PR comment body.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function optionalTrimmedString(input: string) {
  const trimmed = input.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function gitHubRemediationSpecMarkdown(
  input: Readonly<{
    prLoop: GitHubPrLoopState;
    title: string;
  }>,
) {
  const blockerLines = input.prLoop.blockers
    .map(formatGitHubRemediationBlocker)
    .join("\n");

  return [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    `Original Gaia run: \`${input.prLoop.runId}\``,
    `GitHub PR: \`${input.prLoop.pr}\``,
    "PR-loop state: `pr-loop-state.json`",
    `Next action: \`${input.prLoop.nextAction}\``,
    "",
    "## Goal",
    "",
    "Resolve the actionable blockers recorded by Gaia's PR-loop coordinator.",
    "Keep the fix narrow, preserve the existing PR, and do not merge.",
    "",
    "## Blockers",
    "",
    blockerLines,
    "",
    "## Evidence To Inspect",
    "",
    "- `pr-loop-state.json` for the ordered blocker summary.",
    "- `github-feedback.json` for review comments, latest reviews, and review decision.",
    "- `github-checks/` for the recorded check snapshot.",
    "- `report.md` and `worker-result.json` for the original run context.",
    "",
    "## Constraints",
    "",
    "- Make the smallest source change that addresses the blockers.",
    "- Treat frontend or generated checks as evidence, not as security proof.",
    "- Keep errors and uncertainty visible in the final report.",
    "- Do not auto-merge, force-push over unrelated work, or hide review feedback.",
    "",
    "## Done When",
    "",
    "- The blockers have a direct code or documentation response.",
    "- Relevant tests or checks have been run.",
    "- A follow-up PR-loop pass can record a new state.",
    "",
  ].join("\n");
}

function formatGitHubRemediationBlocker(blocker: GitHubPrLoopBlocker) {
  return `- \`${blocker.kind}\` -> \`${blocker.action}\`: ${blocker.summary}`;
}

function classifyGitHubFeedback(
  view: GitHubPrFeedbackView,
): GitHubPrFeedbackStatus {
  if (
    view.reviewDecision === "CHANGES_REQUESTED" ||
    view.latestReviews.some((review) => isChangesRequestedReview(review.state))
  ) {
    return "changes-requested";
  }

  if (view.comments.length > 0) {
    return "comments";
  }

  if (
    view.isDraft ||
    view.reviewDecision === "REVIEW_REQUIRED" ||
    view.reviewRequests.length > 0
  ) {
    return "awaiting-review";
  }

  return "clear";
}

function nextActionForGitHubFeedbackStatus(
  status: GitHubPrFeedbackStatus,
): GitHubPrFeedbackNextAction {
  switch (status) {
    case "awaiting-review":
      return "await-review";
    case "changes-requested":
      return "address-review-comments";
    case "comments":
      return "respond-to-comments";
    case "clear":
      return "complete";
  }
}

function isChangesRequestedReview(state: string) {
  return normalizeGitHubReviewState(state) === "changes-requested";
}

function normalizeGitHubReviewState(state: string) {
  return state.trim().toLowerCase().replaceAll("_", "-");
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

function requireWorkspacePrQualityGatePassed(
  gate: WorkspacePrQualityGate,
) {
  if (gate.status === "passed") {
    return Effect.void;
  }

  return Effect.fail(
    makeRuntimeError({
      code: "WorkspacePrQualityGateFailed",
      message: workspacePrQualityGateFailureMessage(gate),
      recoverable: false,
    }),
  );
}

function workspacePrQualityGateFailureMessage(gate: WorkspacePrQualityGate) {
  const failedItems = gate.items.filter((item) => item.severity === "fail");
  const preview = failedItems.slice(0, 3).map(formatWorkspacePrGateFailure);
  const remaining = failedItems.length - preview.length;
  const remainingLine =
    remaining > 0 ? ` ${remaining} additional fail item(s) omitted.` : "";

  return [
    `Workspace PR quality gate failed with ${gate.failItemCount} fail item(s).`,
    ...preview,
    `Inspect ${gate.artifactPath} for the full gate result.`,
    remainingLine.trim(),
  ]
    .filter((line) => line.length > 0)
    .join(" ");
}

function formatWorkspacePrGateFailure(
  item: WorkspacePrQualityGate["items"][number],
) {
  const files =
    item.changedFiles.length === 0 ? "unknown files" : item.changedFiles.join(", ");

  return `${item.severity}: ${files} - ${item.reason} Remediation: ${item.remediation}`;
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
) {
  return Effect.gen(function* () {
    yield* runRequiredCommand(runner, rootDirectory, "git", [
      "add",
      "--all",
      "--",
      ".",
    ]);
    const diff = yield* runCommand(runner, rootDirectory, "git", [
      "diff",
      "--cached",
      "--quiet",
      "--",
      ".",
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

function runRequiredPreflightCommand(
  runner: GitHubCommandRunner,
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  error: Readonly<{
    code: string;
    message: string;
  }>,
) {
  return Effect.gen(function* () {
    const result = yield* runCommand(runner, cwd, command, args);

    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: error.code,
          message: error.message,
          recoverable: true,
        }),
      );
    }

    return result;
  });
}

function preflightCheck(
  name: GitHubPreflightCheckName,
): GitHubPreflightCheck {
  return GitHubPreflightCheck.make({ name, status: "passed" });
}

function requireGitRepository(
  runner: GitHubCommandRunner,
  rootDirectory: string,
) {
  return Effect.gen(function* () {
    const result = yield* runRequiredPreflightCommand(
      runner,
      rootDirectory,
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      {
        code: "GitRepositoryUnavailable",
        message: "Gaia GitHub publishing must run inside a git worktree.",
      },
    );

    if (result.stdout.trim() !== "true") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitRepositoryUnavailable",
          message: "Gaia GitHub publishing must run inside a git worktree.",
          recoverable: true,
        }),
      );
    }
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

function requireRemote(
  runner: GitHubCommandRunner,
  rootDirectory: string,
  remoteName: string,
) {
  return runRequiredPreflightCommand(
    runner,
    rootDirectory,
    "git",
    ["remote", "get-url", remoteName],
    {
      code: "GitRemoteUnavailable",
      message: `Git remote '${remoteName}' is not configured.`,
    },
  );
}

function remoteBaseBranchHead(
  runner: GitHubCommandRunner,
  rootDirectory: string,
  remoteName: string,
  baseBranch: string,
) {
  return Effect.gen(function* () {
    const result = yield* runRequiredPreflightCommand(
      runner,
      rootDirectory,
      "git",
      ["ls-remote", "--exit-code", remoteName, `refs/heads/${baseBranch}`],
      {
        code: "GitBaseBranchUnavailable",
        message: `Git remote '${remoteName}' does not expose base branch '${baseBranch}'.`,
      },
    );
    const head = result.stdout.trim().split(/\s+/u)[0];

    if (head === undefined || head.length === 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitBaseBranchUnavailable",
          message: `Git remote '${remoteName}' did not report a commit for base branch '${baseBranch}'.`,
          recoverable: true,
        }),
      );
    }

    return head;
  });
}

function requireGitHubAuth(
  runner: GitHubCommandRunner,
  rootDirectory: string,
) {
  return runRequiredPreflightCommand(
    runner,
    rootDirectory,
    "gh",
    ["auth", "status"],
    {
      code: "GitHubAuthUnavailable",
      message: "GitHub CLI authentication is not available.",
    },
  );
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

function currentGitHead(
  runner: GitHubCommandRunner,
  rootDirectory: string,
) {
  return Effect.gen(function* () {
    const result = yield* runRequiredCommand(runner, rootDirectory, "git", [
      "rev-parse",
      "HEAD",
    ]);
    const head = result.stdout.trim();

    if (head.length === 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitHeadUnavailable",
          message: "Gaia cannot identify the current git HEAD.",
          recoverable: false,
        }),
      );
    }

    return head;
  });
}

function requireLocalHeadMatchesRemoteBase(input: {
  readonly baseBranch: string;
  readonly localHead: string;
  readonly remoteBaseHead: string;
  readonly remoteName: string;
}) {
  if (input.localHead === input.remoteBaseHead) {
    return Effect.void;
  }

  return Effect.fail(
    makeRuntimeError({
      code: "GitBaseBranchOutOfSync",
      message: `Local HEAD must match '${input.remoteName}/${input.baseBranch}' before Gaia opens a PR.`,
      recoverable: false,
    }),
  );
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
    ["dogfood-retrospective.json", "dogfood-retrospective.json"],
    ["run-profile.json", "run-profile.json"],
    ["browser-evidence.json", "browser-evidence.json"],
    ["preview-deployment.json", "preview-deployment.json"],
    ["skill-manifest.json", "skill-manifest.json"],
    ["skill-bundle.json", "skill-bundle.json"],
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

    const hasBrowserScreenshots = yield* fs.exists(paths.browserScreenshots);
    if (hasBrowserScreenshots) {
      yield* copyWorkspaceDirectoryContents(
        paths.browserScreenshots,
        path.join(evidencePath, "browser"),
      );
    }

    const hasGitHubFeedback = yield* fs.exists(paths.githubFeedback);
    if (hasGitHubFeedback) {
      yield* fs.copyFile(
        paths.githubFeedback,
        path.join(evidencePath, "github-feedback.json"),
      );
    }

    const hasWorkspacePrGate = yield* fs.exists(paths.workspacePrGate);
    if (hasWorkspacePrGate) {
      yield* fs.copyFile(
        paths.workspacePrGate,
        path.join(evidencePath, "workspace-pr-gate.json"),
      );
    }

    const hasEvidencePromotion = yield* fs.exists(paths.evidencePromotionJson);
    if (hasEvidencePromotion) {
      yield* fs.copyFile(
        paths.evidencePromotionJson,
        path.join(evidencePath, "evidence-promotion.json"),
      );
    }

    const hasEvidencePromotionMarkdown = yield* fs.exists(
      paths.evidencePromotionMarkdown,
    );
    if (hasEvidencePromotionMarkdown) {
      yield* fs.copyFile(
        paths.evidencePromotionMarkdown,
        path.join(evidencePath, "evidence-promotion.md"),
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

function readOptionalGitHubPullRequestHeadSha(
  pr: GitHubPullRequestSelector,
  options: Readonly<{
    rootDirectory: string;
    runner: GitHubCommandRunner;
  }>,
): Effect.Effect<GitHubPrHeadSha | undefined, never> {
  return Effect.gen(function* () {
    const result = yield* runCommand(
      options.runner,
      options.rootDirectory,
      "gh",
      ["pr", "view", pr, "--json", "headRefOid"],
    );

    if (result.exitCode !== 0) {
      return undefined;
    }

    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(result.stdout),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubPrHeadJsonInvalid",
          message: "GitHub PR head output was not valid JSON.",
          recoverable: true,
        }),
    });
    const view = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(GitHubPrHeadView)(parsed),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubPrHeadInvalid",
          message: "GitHub PR head output did not match Gaia's schema.",
          recoverable: true,
        }),
    });

    return view.headRefOid;
  }).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(undefined),
      onSuccess: (headSha) => Effect.succeed(headSha),
    }),
  );
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
    headSha: GitHubPrHeadSha | undefined;
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
      ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
      observedAt,
      pr: input.summary.pr,
      runId: input.runId,
      status: input.summary.status,
      terminal: isTerminalGitHubChecksStatus(input.summary.status),
    });

    yield* fs.makeDirectory(paths.githubChecks, { recursive: true });
    yield* fs.writeFileString(
      snapshotPath,
      `${JSON.stringify(encodeGitHubChecksSnapshotJson(snapshot), null, 2)}\n`,
    );

    return GitHubChecksRecord.make({
      attempts: snapshot.attempts,
      checks: snapshot.checks,
      ...(snapshot.headSha === undefined ? {} : { headSha: snapshot.headSha }),
      observedAt: snapshot.observedAt,
      pr: snapshot.pr,
      runId: snapshot.runId,
      snapshotPath,
      status: snapshot.status,
      terminal: snapshot.terminal,
      watchStatePath: paths.ciWatchState,
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

function readGitHubChecksSnapshot(
  paths: RunPaths,
  snapshotPath: string,
): Effect.Effect<GitHubChecksSnapshot, GaiaRuntimeError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const resolvedSnapshotPath = yield* resolveRunArtifactPath(
      paths,
      snapshotPath,
    );
    const contents = yield* fs.readFileString(resolvedSnapshotPath);
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubChecksSnapshotJsonInvalid",
          message: "GitHub check snapshot was not valid JSON.",
          recoverable: true,
        }),
    });

    return yield* Effect.try({
      try: () => parseGitHubChecksSnapshotJson(parsed),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubChecksSnapshotInvalid",
          message: "GitHub check snapshot did not match Gaia's schema.",
          recoverable: true,
        }),
    });
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubChecksSnapshotReadFailed",
          message: "Gaia could not read GitHub check snapshot evidence.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function writeGitHubCiWatchState(
  paths: RunPaths,
  record: GitHubChecksRecord,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const state = GitHubCiWatchState.make({
      attempts: record.attempts,
      ...(record.headSha === undefined ? {} : { headSha: record.headSha }),
      lastSnapshotPath: runRelative(paths, record.snapshotPath),
      lastStatus: record.status,
      nextAction: nextActionForGitHubChecksStatus(record.status),
      pr: record.pr,
      runId: record.runId,
      terminal: record.terminal,
      updatedAt: record.observedAt,
      version: 1,
    });

    yield* fs.writeFileString(
      paths.ciWatchState,
      `${JSON.stringify(encodeGitHubCiWatchStateJson(state), null, 2)}\n`,
    );

    return { path: paths.ciWatchState, state };
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubCiWatchStateWriteFailed",
          message: "Gaia could not write GitHub CI watch state.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function readOptionalGitHubCiWatchState(
  paths: RunPaths,
): Effect.Effect<GitHubCiWatchState | undefined, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(paths.ciWatchState);
    if (!exists) {
      return undefined;
    }

    const contents = yield* fs.readFileString(paths.ciWatchState);
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubCiWatchStateJsonInvalid",
          message: "GitHub CI watch state was not valid JSON.",
          recoverable: true,
        }),
    });

    return yield* Effect.try({
      try: () => parseGitHubCiWatchStateJson(parsed),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "GitHubCiWatchStateInvalid",
          message: "GitHub CI watch state did not match Gaia's schema.",
          recoverable: true,
        }),
    });
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "GitHubCiWatchStateReadFailed",
          message: "Gaia could not read GitHub CI watch state.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function findReusableGitHubChecksRecord(
  paths: RunPaths,
  input: Readonly<{
    headSha: GitHubPrHeadSha | undefined;
    summary: GitHubChecksSummary;
  }>,
) {
  return Effect.gen(function* () {
    if (input.headSha === undefined) {
      return undefined;
    }

    const storedWatchState = yield* readOptionalGitHubCiWatchState(paths);

    if (
      storedWatchState === undefined ||
      storedWatchState.headSha !== input.headSha ||
      storedWatchState.pr !== input.summary.pr
    ) {
      return undefined;
    }

    const snapshot = yield* readGitHubChecksSnapshot(
      paths,
      storedWatchState.lastSnapshotPath,
    );

    if (!sameGitHubChecksSnapshot(snapshot, input.summary, input.headSha)) {
      return undefined;
    }

    const snapshotPath = yield* resolveRunArtifactPath(
      paths,
      storedWatchState.lastSnapshotPath,
    );

    return GitHubChecksRecord.make({
      attempts: snapshot.attempts,
      checks: snapshot.checks,
      ...(snapshot.headSha === undefined ? {} : { headSha: snapshot.headSha }),
      observedAt: snapshot.observedAt,
      pr: snapshot.pr,
      runId: snapshot.runId,
      snapshotPath,
      status: snapshot.status,
      terminal: snapshot.terminal,
      watchStatePath: paths.ciWatchState,
    });
  });
}

function sameGitHubChecksSnapshot(
  snapshot: GitHubChecksSnapshot,
  summary: GitHubChecksSummary,
  headSha: GitHubPrHeadSha,
) {
  return (
    snapshot.headSha === headSha &&
    snapshot.pr === summary.pr &&
    snapshot.status === summary.status &&
    stableJson(snapshot.checks) === stableJson(summary.checks)
  );
}

function resolveRunArtifactPath(paths: RunPaths, artifactPath: string) {
  return Effect.gen(function* () {
    if (artifactPath.startsWith(`${paths.root}/`)) {
      return artifactPath;
    }

    const path = yield* Path.Path;
    return path.join(paths.root, artifactPath);
  });
}

function ciWatchSummaryFromRecord(
  record: GitHubChecksRecord,
  source: GitHubCiWatchResultSource,
) {
  return GitHubCiWatchSummary.make({
    attempts: record.attempts,
    checks: record.checks,
    failedChecks: failedChecks(record.checks),
    ...(record.headSha === undefined ? {} : { headSha: record.headSha }),
    nextAction: nextActionForGitHubChecksStatus(record.status),
    pendingChecks: pendingChecks(record.checks),
    pr: record.pr,
    runId: record.runId,
    snapshotPath: record.snapshotPath,
    source,
    status: record.status,
    terminal: record.terminal,
    watchStatePath: record.watchStatePath,
  });
}

function ciWatchSummaryFromSnapshot(input: Readonly<{
  paths: RunPaths;
  snapshot: GitHubChecksSnapshot;
  source: GitHubCiWatchResultSource;
  state: GitHubCiWatchState;
}>) {
  return GitHubCiWatchSummary.make({
    attempts: input.snapshot.attempts,
    checks: input.snapshot.checks,
    failedChecks: failedChecks(input.snapshot.checks),
    ...(input.snapshot.headSha === undefined
      ? {}
      : { headSha: input.snapshot.headSha }),
    nextAction: input.state.nextAction,
    pendingChecks: pendingChecks(input.snapshot.checks),
    pr: input.snapshot.pr,
    runId: input.snapshot.runId,
    snapshotPath: input.state.lastSnapshotPath,
    source: input.source,
    status: input.snapshot.status,
    terminal: input.snapshot.terminal,
    watchStatePath: runRelative(input.paths, input.paths.ciWatchState),
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

function isTerminalGitHubChecksStatus(status: GitHubChecksStatus) {
  return status !== "pending";
}

function nextActionForGitHubChecksStatus(
  status: GitHubChecksStatus,
): GitHubCiWatchNextAction {
  switch (status) {
    case "failed":
      return "fix-failed-checks";
    case "pending":
      return "poll-again";
    case "no-checks":
    case "passed":
      return "complete";
  }
}

function failedChecks(checks: ReadonlyArray<GitHubCheckRun>) {
  return checks.filter(
    (check) =>
      !isPendingCheckState(check.state) && !isPassingCheckState(check.state),
  );
}

function pendingChecks(checks: ReadonlyArray<GitHubCheckRun>) {
  return checks.filter((check) => isPendingCheckState(check.state));
}

function stableJson(input: unknown) {
  return JSON.stringify(input);
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
