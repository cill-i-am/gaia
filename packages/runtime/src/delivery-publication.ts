import {
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationFailed,
  DeliveryPublicationIntent,
  DeliveryPublicationOutcomeUnknown,
  encodeDeliveryPublicationJson,
  parseDeliveryPublication,
  snapshotFromReplay,
  type DeliveryPublication,
  type RunEvent,
  type RunId,
} from "@gaia/core";
import { createHash } from "node:crypto";
import { Effect, FileSystem, Option, Schema } from "effect";
import { appendEvent, readEvents } from "./event-store.js";
import {
  inspectDeliveryWorktreeOwnership,
  type DeliveryProvenance,
  type GitDeliveryCommandRunner,
} from "./git-delivery.js";
import {
  nodeGitHubCommandRunner,
  parseGitHubDraftPullRequestViewsJson,
  type CommandExecutionResult,
  type GitHubDraftPullRequestView,
  type GitHubCommandRunner,
} from "./github-publisher.js";
import { HarnessRunResult } from "./harness.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import { makeRunPaths, type RunPaths, type RunStorageOptions } from "./paths.js";
import { evaluateWorkspacePrQualityGate } from "./workspace-pr-gate.js";

const digestVersion = 1 as const;
const deliveryAuthorName = "Gaia Delivery";
const deliveryAuthorEmail = "delivery@gaia.local";
const generatedRoots = new Set([
  ".gaia",
  ".turbo",
  "coverage",
  "dist",
  "gaia-runs",
  "node_modules",
]);
const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const parseHarnessRunResultJson = Schema.decodeUnknownSync(HarnessRunResultJson);

export type DeliveryPublicationOptions = RunStorageOptions & {
  readonly commandRunner?: GitHubCommandRunner;
  readonly deliveryGitCommandRunner?: GitDeliveryCommandRunner;
};

/** Commit, push, and reconcile one verified run-owned delivery draft PR. */
export function publishReadyDeliveryRun(
  runId: RunId,
  options: DeliveryPublicationOptions = {},
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const runner = options.commandRunner ?? nodeGitHubCommandRunner;
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    const events = yield* readEvents(paths);
    const snapshot = snapshotFromReplay(events);
    const delivery = yield* parseDelivery(snapshot.context["delivery"]);
    const provenance = yield* parseProvenance(delivery, runId);
    const existing = optionalPublication(delivery["publication"]);

    if (existing?.state === "confirmed") return existing;
    if (existing?.state === "failed") {
      return existing;
    }
    const candidateHead =
      existing?.state === "intentRecorded"
        ? yield* optionalLocalBranchHead(paths, existing.branchName, runner)
        : undefined;

    const expectedHeads = [
      provenance.baseRevision,
      ...(existing !== undefined && "commitSha" in existing && existing.commitSha !== undefined
        ? [existing.commitSha]
        : []),
      ...(candidateHead === undefined ? [] : [candidateHead]),
    ];
    yield* inspectDeliveryWorktreeOwnership({
      expectedHeads,
      options: {
        rootDirectory,
        ...(options.deliveryGitCommandRunner === undefined
          ? {}
          : { commandRunner: options.deliveryGitCommandRunner }),
      },
      paths,
      provenance,
    });
    const repository = yield* githubRepositorySelector(
      paths,
      provenance,
      runner,
    );

    if (existing?.state === "outcomeUnknown") {
      return yield* reconcileUnknownPublication(
        runId,
        paths,
        provenance,
        repository,
        existing,
        runner,
      );
    }

    let attempted: DeliveryPublicationAttempted;
    if (existing?.state === "attempted") {
      const verified = yield* verifyCommit(
        paths,
        provenance,
        existing,
        existing.commitSha,
        runner,
      );
      if (verified.treeSha !== existing.treeSha) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "DeliveryCommitIdentityMismatch",
            message: "The persisted delivery tree no longer matches its commit.",
            recoverable: false,
          }),
        );
      }
      attempted = existing;
    } else {
      let intentOrFailure: DeliveryPublicationIntent | DeliveryPublicationFailed;
      if (existing?.state === "intentRecorded") {
        if (existing.treeSha === undefined) {
          const sourcePaths = yield* verifiedSourcePaths(
            runId,
            paths,
            provenance,
            runner,
          );
          if (
            JSON.stringify(sourcePaths) !==
            JSON.stringify(existing.sourcePaths)
          ) {
            return yield* recordFailedFromIntent(runId, paths, existing, {
              code: "DeliveryDiffMismatch",
              message: "The verified delivery diff changed after intent.",
              recoverable: false,
              step: "validation",
            });
          }
          intentOrFailure = yield* preflightPublicationTarget(
            runId,
            paths,
            provenance,
            repository,
            existing,
            runner,
          );
        } else {
          intentOrFailure = existing;
        }
      } else {
        intentOrFailure = yield* createIntent(
          runId,
          paths,
          provenance,
          repository,
          runner,
          events,
        );
      }
      if (intentOrFailure.state === "failed") return intentOrFailure;
      const intent = intentOrFailure;
      attempted = yield* ensureCommit(
        runId,
        paths,
        provenance,
        intent,
        runner,
      );
      yield* appendPublication(runId, paths, attempted);
    }
    return yield* publishRemoteAndPullRequest(
      runId,
      paths,
      provenance,
      repository,
      attempted,
      runner,
    );
  });
}

/** Start one explicit retry after a definitive recoverable publication failure. */
export function retryFailedDeliveryPublication(
  runId: RunId,
  options: DeliveryPublicationOptions = {},
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const runner = options.commandRunner ?? nodeGitHubCommandRunner;
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    const events = yield* readEvents(paths);
    const snapshot = snapshotFromReplay(events);
    const delivery = yield* parseDelivery(snapshot.context["delivery"]);
    const provenance = yield* parseProvenance(delivery, runId);
    const existing = optionalPublication(delivery["publication"]);

    if (existing === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryPublicationRetryUnavailable",
          message: "The run has no failed delivery publication to retry.",
          recoverable: false,
        }),
      );
    }
    if (existing.state === "confirmed") return existing;
    if (existing.state === "outcomeUnknown" || existing.state === "attempted") {
      return yield* publishReadyDeliveryRun(runId, options);
    }
    if (existing.state !== "failed" || !existing.recoverable) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryPublicationRetryUnavailable",
          message: "The delivery publication is not safely retryable.",
          recoverable: false,
        }),
      );
    }
    yield* requireHistoricalPublicationGates(events);

    if (existing.commitSha === undefined || existing.treeSha === undefined) {
      yield* inspectDeliveryWorktreeOwnership({
        expectedHeads: [provenance.baseRevision],
        options: {
          rootDirectory,
          ...(options.deliveryGitCommandRunner === undefined
            ? {}
            : { commandRunner: options.deliveryGitCommandRunner }),
        },
        paths,
        provenance,
      });
      const repository = yield* githubRepositorySelector(
        paths,
        provenance,
        runner,
      );
      const sourcePaths = yield* verifiedSourcePaths(
        runId,
        paths,
        provenance,
        runner,
      );
      const operationId = nextPublicationOperationId(runId, events);
      const commitTimestamp = new Date(
        Math.floor(Date.now() / 1000) * 1000,
      ).toISOString();
      const intentInput = {
        baseBranch: provenance.baseBranch,
        baseRevision: provenance.baseRevision,
        branchName: provenance.headBranch,
        commitMessage: `feat: deliver ${runId}`,
        commitTimestamp,
        digestVersion,
        operationId,
        runId,
        sourcePaths,
      } as const;
      const intent = DeliveryPublicationIntent.make({
        ...intentInput,
        payloadDigest: structuralDigest(intentInput),
        state: "intentRecorded",
      });
      yield* appendPublication(runId, paths, intent);
      const target = yield* preflightPublicationTarget(
        runId,
        paths,
        provenance,
        repository,
        intent,
        runner,
      );
      if (target.state === "failed") return target;
      const attempted = yield* ensureCommit(
        runId,
        paths,
        provenance,
        target,
        runner,
      );
      yield* appendPublication(runId, paths, attempted);
      return yield* publishRemoteAndPullRequest(
        runId,
        paths,
        provenance,
        repository,
        attempted,
        runner,
      );
    }

    yield* inspectDeliveryWorktreeOwnership({
      expectedHeads: [provenance.baseRevision, existing.commitSha],
      options: {
        rootDirectory,
        ...(options.deliveryGitCommandRunner === undefined
          ? {}
          : { commandRunner: options.deliveryGitCommandRunner }),
      },
      paths,
      provenance,
    });
    const repository = yield* githubRepositorySelector(
      paths,
      provenance,
      runner,
    );
    const sourcePaths = yield* verifiedSourcePaths(
      runId,
      paths,
      provenance,
      runner,
    );
    if (JSON.stringify(sourcePaths) !== JSON.stringify(existing.sourcePaths)) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryDiffMismatch",
          message: "The verified delivery diff changed before publication retry.",
          recoverable: false,
        }),
      );
    }
    const verified = yield* verifyCommit(
      paths,
      provenance,
      existing,
      existing.commitSha,
      runner,
    );
    if (verified.treeSha !== existing.treeSha) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryCommitIdentityMismatch",
          message: "The retry commit no longer matches its durable receipt.",
          recoverable: false,
        }),
      );
    }
    const remote = yield* remoteBranchHead(paths, provenance, runner);
    if (remote !== undefined && remote !== existing.commitSha) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryRemoteBranchConflict",
          message: "The remote delivery branch changed before retry.",
          recoverable: false,
        }),
      );
    }
    const pullRequests = yield* readPullRequests(
      paths,
      repository,
      existing,
      runner,
    );
    if (pullRequests.length > 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryPullRequestConflict",
          message: "A pull request appeared before retry reconciliation.",
          recoverable: false,
        }),
      );
    }

    const operationId = nextPublicationOperationId(runId, events);
    const retryIntentInput = {
      baseBranch: existing.baseBranch,
      baseRevision: existing.baseRevision,
      branchName: existing.branchName,
      commitMessage: existing.commitMessage,
      commitTimestamp: existing.commitTimestamp,
      digestVersion,
      operationId,
      runId,
      sourcePaths: existing.sourcePaths,
    } as const;
    const intent = DeliveryPublicationIntent.make({
      ...retryIntentInput,
      payloadDigest: structuralDigest(retryIntentInput),
      state: "intentRecorded",
      treeSha: existing.treeSha,
    });
    const attempted = DeliveryPublicationAttempted.make({
      ...intent,
      commitSha: existing.commitSha,
      state: "attempted",
      treeSha: existing.treeSha,
    });
    yield* appendPublication(runId, paths, intent);
    yield* appendPublication(runId, paths, attempted);
    return yield* publishRemoteAndPullRequest(
      runId,
      paths,
      provenance,
      repository,
      attempted,
      runner,
    );
  });
}

function createIntent(
  runId: RunId,
  paths: RunPaths,
  provenance: DeliveryProvenance,
  repository: string,
  runner: GitHubCommandRunner,
  events: ReadonlyArray<RunEvent>,
) {
  return Effect.gen(function* () {
    yield* requireAuthoritativePublicationGates(events);
    const sourcePaths = yield* verifiedSourcePaths(
      runId,
      paths,
      provenance,
      runner,
    );
    const operationId = nextPublicationOperationId(runId, events);
    const commitTimestamp = new Date(
      Math.floor(Date.now() / 1000) * 1000,
    ).toISOString();
    const commitMessage = `feat: deliver ${runId}`;
    const payloadDigest = structuralDigest({
      baseBranch: provenance.baseBranch,
      baseRevision: provenance.baseRevision,
      branchName: provenance.headBranch,
      commitMessage,
      commitTimestamp,
      digestVersion,
      operationId,
      runId,
      sourcePaths,
    });
    const intent = DeliveryPublicationIntent.make({
      baseBranch: provenance.baseBranch,
      baseRevision: provenance.baseRevision,
      branchName: provenance.headBranch,
      commitMessage,
      commitTimestamp,
      digestVersion,
      operationId,
      payloadDigest,
      sourcePaths,
      state: "intentRecorded",
    });
    yield* appendPublication(runId, paths, intent);
    return yield* preflightPublicationTarget(
      runId,
      paths,
      provenance,
      repository,
      intent,
      runner,
    );
  });
}

function preflightPublicationTarget(
  runId: RunId,
  paths: RunPaths,
  provenance: DeliveryProvenance,
  repository: string,
  intent: DeliveryPublicationIntent,
  runner: GitHubCommandRunner,
) {
  return Effect.gen(function* () {
    const remoteExit = yield* Effect.exit(
      remoteBranchHead(paths, provenance, runner),
    );
    if (remoteExit._tag === "Failure") {
      return yield* recordFailedFromIntent(runId, paths, intent, {
        code: "DeliveryPublicationTargetUnreadable",
        message: "Gaia could not read the remote publication target.",
        recoverable: true,
        step: "reconciliation",
      });
    }
    const remote = remoteExit.value;
    if (remote !== undefined) {
      return yield* recordFailedFromIntent(runId, paths, intent, {
        code: "DeliveryRemoteBranchConflict",
        message: "The deterministic delivery branch already exists remotely.",
        recoverable: false,
        step: "validation",
      });
    }
    const pullRequestsExit = yield* Effect.exit(
      readPullRequests(paths, repository, intent, runner),
    );
    if (pullRequestsExit._tag === "Failure") {
      return yield* recordFailedFromIntent(runId, paths, intent, {
        code: "DeliveryPublicationTargetUnreadable",
        message: "Gaia could not read the pull-request publication target.",
        recoverable: true,
        step: "reconciliation",
      });
    }
    const pullRequests = pullRequestsExit.value;
    if (pullRequests.length > 0) {
      return yield* recordFailedFromIntent(runId, paths, intent, {
        code: "DeliveryPullRequestConflict",
        message: "A pull request already exists for the deterministic delivery branch.",
        recoverable: false,
        step: "validation",
      });
    }
    return intent;
  });
}

function verifiedSourcePaths(
  runId: RunId,
  paths: RunPaths,
  provenance: DeliveryProvenance,
  runner: GitHubCommandRunner,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parsed = yield* parseJsonFile(fs, paths.workerResult);
    const result = yield* parseEffect(() => parseHarnessRunResultJson(parsed), {
      code: "DeliveryWorkerResultInvalid",
      message: "The delivery worker result is missing or invalid.",
    });
    if (result.runId !== runId) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryWorkerResultInvalid",
          message: "The delivery worker result belongs to a different run.",
          recoverable: false,
        }),
      );
    }
    const gate = yield* evaluateWorkspacePrQualityGate(result.runId, paths);
    if (gate.status !== "passed" || result.workspaceDiff === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryQualityGateFailed",
          message: "The workspace pull-request quality gate did not pass.",
          recoverable: true,
        }),
      );
    }
    const harnessPaths = new Set(
      result.outputArtifacts.flatMap((artifact) =>
        artifact.startsWith("workspace/")
          ? [artifact.slice("workspace/".length)]
          : [],
      ),
    );
    const declared = uniqueSorted(
      result.workspaceDiff.productChangedPaths.filter(
        (path) => !isExcluded(path, harnessPaths),
      ),
    );
    if (declared.length === 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryNoSourceChanges",
          message: "The verified delivery contains no publishable source changes.",
          recoverable: false,
        }),
      );
    }
    yield* parseDeliveryGitPaths(() => declared.forEach(requireSafeGitPath));
    const tracked = yield* runRequired(runner, paths.workspace, "git", [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      provenance.baseRevision,
      "--",
    ]);
    const untracked = yield* runRequired(runner, paths.workspace, "git", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const actual = yield* parseDeliveryGitPaths(() => {
      const parsed = uniqueSorted([
        ...parseNameStatusZ(tracked.stdout),
        ...parsePathListZ(untracked.stdout),
      ]);
      parsed.forEach(requireSafeGitPath);
      return parsed;
    });
    const unexpected = actual.filter(
      (path) => !declared.includes(path) && !isExcluded(path, harnessPaths),
    );
    const missing = declared.filter((path) => !actual.includes(path));
    if (unexpected.length > 0 || missing.length > 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryDiffMismatch",
          message: "The actual git diff does not match the verified source paths.",
          recoverable: false,
        }),
      );
    }
    return declared;
  });
}

function ensureCommit(
  runId: RunId,
  paths: RunPaths,
  provenance: DeliveryProvenance,
  intent: DeliveryPublicationIntent,
  runner: GitHubCommandRunner,
) {
  return Effect.gen(function* () {
    const branchRef = `refs/heads/${intent.branchName}`;
    const existingBranch = yield* runCommand(runner, paths.workspace, "git", [
      "show-ref",
      "--verify",
      "--quiet",
      branchRef,
    ]);
    if (existingBranch.exitCode === 0) {
      const branchHead = (
        yield* runRequired(runner, paths.workspace, "git", [
          "rev-parse",
          branchRef,
        ])
      ).stdout.trim();
      if (branchHead !== provenance.baseRevision) {
        if (intent.treeSha === undefined) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "DeliveryCommitIdentityMismatch",
              message: "The persisted delivery intent has no prepared tree.",
              recoverable: false,
            }),
          );
        }
        const verified = yield* verifyCommit(
          paths,
          provenance,
          intent,
          branchHead,
          runner,
        );
        return DeliveryPublicationAttempted.make({
          ...intent,
          commitSha: branchHead,
          state: "attempted",
          treeSha: verified.treeSha,
        });
      }
      yield* runRequired(runner, paths.workspace, "git", [
        "switch",
        intent.branchName,
      ]);
    } else if (existingBranch.exitCode === 1) {
      yield* runRequired(runner, paths.workspace, "git", [
        "switch",
        "-c",
        intent.branchName,
        provenance.baseRevision,
      ]);
    } else {
      return yield* Effect.fail(commandFailed("git show-ref"));
    }

    const cachedBefore = yield* cachedPaths(paths, provenance, runner);
    if (cachedBefore.length === 0) {
      yield* runRequired(runner, paths.workspace, "git", [
        "add",
        "-A",
        "--",
        ...intent.sourcePaths,
      ]);
    }
    const cachedAfter = yield* cachedPaths(paths, provenance, runner);
    if (JSON.stringify(cachedAfter) !== JSON.stringify(intent.sourcePaths)) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryIndexMismatch",
          message: "The git index does not contain exactly the approved source paths.",
          recoverable: false,
        }),
      );
    }
    const preparedTreeSha = (
      yield* runRequired(runner, paths.workspace, "git", ["write-tree"])
    ).stdout.trim();
    if (!/^[a-f0-9]{40}$/u.test(preparedTreeSha)) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryCommitIdentityMismatch",
          message: "Git did not return a valid prepared delivery tree.",
          recoverable: false,
        }),
      );
    }
    if (
      intent.treeSha !== undefined &&
      intent.treeSha !== preparedTreeSha
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryCommitIdentityMismatch",
          message: "The staged delivery tree changed after durable intent.",
          recoverable: false,
        }),
      );
    }
    const preparedIntent =
      intent.treeSha === undefined
        ? DeliveryPublicationIntent.make({
            ...intent,
            treeSha: preparedTreeSha,
          })
        : intent;
    if (intent.treeSha === undefined) {
      yield* appendPublication(runId, paths, preparedIntent);
    }

    const commitEnvironment = {
      GIT_AUTHOR_DATE: preparedIntent.commitTimestamp,
      GIT_AUTHOR_EMAIL: deliveryAuthorEmail,
      GIT_AUTHOR_NAME: deliveryAuthorName,
      GIT_COMMITTER_DATE: preparedIntent.commitTimestamp,
      GIT_COMMITTER_EMAIL: deliveryAuthorEmail,
      GIT_COMMITTER_NAME: deliveryAuthorName,
    };
    yield* runRequired(
      runner,
      paths.workspace,
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--no-gpg-sign",
        "-m",
        preparedIntent.commitMessage,
      ],
      commitEnvironment,
    );
    const commitSha = (
      yield* runRequired(runner, paths.workspace, "git", ["rev-parse", "HEAD"])
    ).stdout.trim();
    const verified = yield* verifyCommit(
      paths,
      provenance,
      preparedIntent,
      commitSha,
      runner,
    );
    return DeliveryPublicationAttempted.make({
      ...preparedIntent,
      commitSha,
      state: "attempted",
      treeSha: verified.treeSha,
    });
  });
}

function cachedPaths(
  paths: RunPaths,
  provenance: DeliveryProvenance,
  runner: GitHubCommandRunner,
) {
  return runRequired(runner, paths.workspace, "git", [
    "diff",
    "--cached",
    "--name-status",
    "-z",
    provenance.baseRevision,
    "--",
  ]).pipe(
    Effect.flatMap(({ stdout }) =>
      parseDeliveryGitPaths(() => uniqueSorted(parseNameStatusZ(stdout))),
    ),
  );
}

function verifyCommit(
  paths: RunPaths,
  provenance: DeliveryProvenance,
  intent: PublicationCommitIdentity,
  commitSha: string,
  runner: GitHubCommandRunner,
) {
  return Effect.gen(function* () {
    const inspected = yield* runRequired(runner, paths.workspace, "git", [
      "show",
      "-s",
      "--format=%P%x00%T%x00%B%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI",
      commitSha,
    ]);
    const fields = inspected.stdout.split("\0");
    if (
      fields.length !== 9 ||
      fields[0] !== provenance.baseRevision ||
      intent.treeSha === undefined ||
      fields[1] !== intent.treeSha ||
      fields[2] !== `${intent.commitMessage}\n` ||
      fields[3] !== deliveryAuthorName ||
      fields[4] !== deliveryAuthorEmail ||
      !sameTimestamp(fields[5], intent.commitTimestamp) ||
      fields[6] !== deliveryAuthorName ||
      fields[7] !== deliveryAuthorEmail ||
      !sameTimestamp(fields[8], intent.commitTimestamp)
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryCommitIdentityMismatch",
          message: "The delivery commit does not match its durable intent.",
          recoverable: false,
        }),
      );
    }
    const treeSha = fields[1];
    if (treeSha === undefined || !/^[a-f0-9]{40}$/u.test(treeSha)) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryCommitIdentityMismatch",
          message: "The delivery commit tree could not be verified.",
          recoverable: false,
        }),
      );
    }
    const commitDiff = yield* runRequired(runner, paths.workspace, "git", [
      "diff-tree",
      "--no-commit-id",
      "--name-status",
      "-z",
      "-r",
      "--find-renames",
      commitSha,
      "--",
    ]);
    const commitPaths = yield* parseDeliveryGitPaths(() =>
      uniqueSorted(parseNameStatusZ(commitDiff.stdout)),
    );
    if (JSON.stringify(commitPaths) !== JSON.stringify(intent.sourcePaths)) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryCommitIdentityMismatch",
          message: "The delivery commit contains paths outside durable intent.",
          recoverable: false,
        }),
      );
    }
    return { treeSha };
  });
}

type PublicationCommitIdentity = PublicationMarkerInput & {
  readonly baseBranch: string;
  readonly baseRevision: string;
  readonly commitMessage: string;
  readonly commitTimestamp: string;
  readonly sourcePaths: ReadonlyArray<string>;
  readonly treeSha?: string;
};

function optionalLocalBranchHead(
  paths: RunPaths,
  branchName: string,
  runner: GitHubCommandRunner,
) {
  return Effect.gen(function* () {
    const ref = `refs/heads/${branchName}`;
    const exists = yield* runCommand(runner, paths.workspace, "git", [
      "show-ref",
      "--verify",
      "--quiet",
      ref,
    ]);
    if (exists.exitCode === 1) return undefined;
    if (exists.exitCode !== 0) {
      return yield* Effect.fail(commandFailed("git show-ref"));
    }
    return (
      yield* runRequired(runner, paths.workspace, "git", ["rev-parse", ref])
    ).stdout.trim();
  });
}

function requireAuthoritativePublicationGates(
  events: ReadonlyArray<{ readonly payload?: Readonly<Record<string, unknown>>; readonly type: string }>,
) {
  const historical = historicalPublicationGates(events);
  const ready = events.at(-1)?.type === "DELIVERY_READY_TO_PUBLISH";
  if (!historical || !ready) {
    return Effect.fail(
      makeRuntimeError({
        code: "DeliveryNotReadyToPublish",
        message:
          "Publication requires authoritative verification, evidence review, and ready-to-publish state.",
        recoverable: false,
      }),
    );
  }
  return Effect.void;
}

function requireHistoricalPublicationGates(
  events: ReadonlyArray<{
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly type: string;
  }>,
) {
  return historicalPublicationGates(events)
    ? Effect.void
    : Effect.fail(
        makeRuntimeError({
          code: "DeliveryNotReadyToPublish",
          message:
            "Publication retry requires authoritative verification, evidence review, and ready history.",
          recoverable: false,
        }),
      );
}

function historicalPublicationGates(
  events: ReadonlyArray<{
    readonly payload?: Readonly<Record<string, unknown>>;
    readonly type: string;
  }>,
) {
  return events.some(({ type }) => type === "VERIFICATION_COMPLETED") &&
    events.some(
      ({ payload, type }) =>
        type === "REVIEW_COMPLETED" && payload?.["phase"] === "evidence",
    ) &&
    events.some(({ type }) => type === "DELIVERY_READY_TO_PUBLISH");
}

function publishRemoteAndPullRequest(
  runId: RunId,
  paths: RunPaths,
  provenance: DeliveryProvenance,
  repository: string,
  attempted: DeliveryPublicationAttempted,
  runner: GitHubCommandRunner,
) {
  return Effect.gen(function* () {
    const bodyPreparation = yield* writePullRequestBody(paths, runId, attempted).pipe(
      Effect.map(() => ({ _tag: "Ready" }) as const),
      Effect.catchTag("GaiaRuntimeError", (error) =>
        Effect.succeed({ _tag: "Failed", error } as const),
      ),
    );
    if (bodyPreparation._tag === "Failed") {
      return yield* recordFailed(runId, paths, attempted, {
        code: bodyPreparation.error.code,
        message: bodyPreparation.error.message,
        recoverable: bodyPreparation.error.recoverable,
        step: "validation",
      });
    }
    let remote = yield* observeRemoteHead(paths, provenance, runner);
    if (remote._tag === "Unavailable") {
      return yield* recordUnknown(runId, paths, attempted, "push");
    }
    if (remote.head === undefined) {
      const unknown = yield* recordUnknown(runId, paths, attempted, "push");
      yield* runCommand(runner, paths.workspace, "git", [
        "push",
        "--porcelain",
        `--force-with-lease=refs/heads/${attempted.branchName}:`,
        provenance.remote,
        `HEAD:refs/heads/${attempted.branchName}`,
      ]).pipe(Effect.exit);
      remote = yield* observeRemoteHead(paths, provenance, runner);
      if (remote._tag === "Unavailable") {
        return unknown;
      }
      if (remote.head === attempted.commitSha) {
        yield* appendPublication(runId, paths, attempted);
      }
    }
    if (remote.head !== attempted.commitSha) {
      return yield* recordFailed(runId, paths, attempted, {
        code: "DeliveryRemoteBranchConflict",
        message:
          remote.head === undefined
            ? "The delivery push was conclusively not accepted."
            : "The remote delivery branch changed unexpectedly.",
        recoverable: remote.head === undefined,
        step: "push",
      });
    }

    let pullRequestsExit = yield* Effect.exit(
      readPullRequests(paths, repository, attempted, runner),
    );
    if (pullRequestsExit._tag === "Failure") {
      return yield* recordUnknown(runId, paths, attempted, "reconciliation");
    }
    let pullRequests = pullRequestsExit.value;
    if (pullRequests.length === 0) {
      const unknown = yield* recordUnknown(
        runId,
        paths,
        attempted,
        "pullRequest",
      );
      yield* runCommand(runner, paths.workspace, "gh", [
        "pr",
        "create",
        "--repo",
        repository,
        "--draft",
        "--base",
        attempted.baseBranch,
        "--head",
        attempted.branchName,
        "--title",
        `Gaia delivery ${runId}`,
        "--body-file",
        paths.deliveryPullRequestBody,
      ]).pipe(Effect.exit);
      pullRequestsExit = yield* Effect.exit(
        readPullRequests(paths, repository, attempted, runner),
      );
      if (pullRequestsExit._tag === "Failure") {
        return unknown;
      }
      pullRequests = pullRequestsExit.value;
      if (pullRequests.length === 0) {
        return unknown;
      }
    }
    const owned = requireOwnedPullRequest(pullRequests, attempted);
    if (Option.isNone(owned)) {
      return yield* recordFailed(runId, paths, attempted, {
        code: "DeliveryPullRequestConflict",
        message: "GitHub pull-request state does not match Gaia ownership.",
        recoverable: false,
        step: "pullRequest",
      });
    }
    const pullRequest = owned.value;
    const confirmed = DeliveryPublicationConfirmed.make({
      ...attempted,
      draft: true,
      headSha: attempted.commitSha,
      prNumber: pullRequest.number,
      prUrl: pullRequest.url,
      state: "confirmed",
    });
    yield* appendPublication(runId, paths, confirmed);
    return confirmed;
  });
}

function reconcileUnknownPublication(
  runId: RunId,
  paths: RunPaths,
  provenance: DeliveryProvenance,
  repository: string,
  unknown: DeliveryPublicationOutcomeUnknown,
  runner: GitHubCommandRunner,
) {
  return Effect.gen(function* () {
    if (unknown.commitSha === undefined || unknown.treeSha === undefined) {
      return yield* recordFailedFromUnknown(runId, paths, unknown, {
        code: "DeliveryPublicationReceiptInvalid",
        message: "The ambiguous publication receipt is missing commit identity.",
        recoverable: false,
        step: "reconciliation",
      });
    }
    const remote = yield* observeRemoteHead(paths, provenance, runner);
    if (remote._tag === "Unavailable") return unknown;
    const pullRequestsExit = yield* Effect.exit(
      readPullRequests(paths, repository, unknown, runner),
    );
    if (pullRequestsExit._tag === "Failure") return unknown;
    const pullRequests = pullRequestsExit.value;
    if (remote.head === unknown.commitSha) {
      const attempted = DeliveryPublicationAttempted.make({
        ...unknown,
        commitSha: unknown.commitSha,
        state: "attempted",
        treeSha: unknown.treeSha,
      });
      const owned = requireOwnedPullRequest(pullRequests, attempted);
      if (Option.isSome(owned)) {
        const confirmed = DeliveryPublicationConfirmed.make({
          ...attempted,
          draft: true,
          headSha: attempted.commitSha,
          prNumber: owned.value.number,
          prUrl: owned.value.url,
          state: "confirmed",
        });
        yield* appendPublication(runId, paths, confirmed);
        return confirmed;
      }
      if (pullRequests.length === 0) {
        return yield* recordFailedFromUnknown(runId, paths, unknown, {
          code:
            unknown.step === "push"
              ? "DeliveryPullRequestNotStarted"
              : "DeliveryPullRequestNotCreated",
          message:
            unknown.step === "push"
              ? "Exact reconciliation proved the push succeeded and no pull request mutation started."
              : "Exact reconciliation proved the draft pull request was not created.",
          recoverable: true,
          step: "pullRequest",
        });
      }
    }
    if (remote.head === undefined && pullRequests.length === 0) {
      return yield* recordFailedFromUnknown(runId, paths, unknown, {
        code: "DeliveryPushNotAccepted",
        message:
          "Exact reconciliation proved the delivery push was not accepted.",
        recoverable: true,
        step: "push",
      });
    }
    return yield* recordFailedFromUnknown(runId, paths, unknown, {
      code: "DeliveryPublicationOwnershipConflict",
      message: "External publication state conflicts with Gaia ownership.",
      recoverable: false,
      step: "reconciliation",
    });
  });
}

function readPullRequests(
  paths: RunPaths,
  repository: string,
  publication: PublicationMarkerInput,
  runner: GitHubCommandRunner,
) {
  return Effect.gen(function* () {
    const result = yield* runRequired(runner, paths.workspace, "gh", [
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      publication.branchName,
      "--state",
      "all",
      "--json",
      "number,url,isDraft,state,headRefName,headRefOid,baseRefName,body",
    ]);
    return yield* parseEffect(
      () => parseGitHubDraftPullRequestViewsJson(result.stdout),
      {
      code: "DeliveryPullRequestReadInvalid",
      message: "GitHub pull-request output did not match Gaia's schema.",
      },
    );
  });
}

function requireOwnedPullRequest(
  pullRequests: ReadonlyArray<GitHubDraftPullRequestView>,
  publication: DeliveryPublicationAttempted,
) {
  if (pullRequests.length !== 1) return Option.none();
  const pullRequest = pullRequests[0];
  if (
    pullRequest === undefined ||
    pullRequest.baseRefName !== publication.baseBranch ||
    pullRequest.headRefName !== publication.branchName ||
    pullRequest.headRefOid !== publication.commitSha ||
    pullRequest.state !== "OPEN" ||
    !pullRequest.isDraft ||
    !pullRequest.body.includes(publicationMarker(publication))
  ) {
    return Option.none();
  }
  return Option.some(pullRequest);
}

function writePullRequestBody(
  paths: RunPaths,
  runId: RunId,
  publication: DeliveryPublicationAttempted,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lines = publication.sourcePaths.map(
      (path) => `- ${markdownCodeSpan(JSON.stringify(path))}`,
    );
    const body = [
      publicationMarker(publication),
      `## Gaia delivery ${runId}`,
      "",
      `Base: \`${publication.baseBranch}\` at \`${publication.baseRevision}\``,
      `Head: \`${publication.branchName}\` at \`${publication.commitSha}\``,
      "",
      "### Verified source paths",
      "",
      ...lines,
      "",
      "Generated run state and harness-only outputs are excluded.",
      "",
    ].join("\n");
    if (Buffer.byteLength(body, "utf8") > 32_000) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryPullRequestBodyTooLarge",
          message: "The safe delivery pull-request body exceeds its size limit.",
          recoverable: false,
        }),
      );
    }
    yield* fs.writeFileString(paths.deliveryPullRequestBody, body).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "DeliveryPullRequestBodyWriteFailed",
          message: "Gaia could not persist the safe pull-request body.",
          recoverable: true,
        }),
      ),
    );
  });
}

function markdownCodeSpan(value: string) {
  let longestBacktickRun = 0;
  for (const match of value.matchAll(/`+/gu)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  }
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence} ${value} ${fence}`;
}

function publicationMarker(publication: PublicationMarkerInput) {
  return `<!-- gaia-delivery:v1 run-branch=${publication.branchName} operation=${publication.operationId} digest=${publication.payloadDigest} -->`;
}

type PublicationMarkerInput = {
  readonly branchName: string;
  readonly operationId: string;
  readonly payloadDigest: string;
};

function githubRepositorySelector(
  paths: RunPaths,
  provenance: DeliveryProvenance,
  runner: GitHubCommandRunner,
) {
  return Effect.gen(function* () {
    const remote = yield* runRequired(runner, paths.workspace, "git", [
      "remote",
      "get-url",
      provenance.remote,
    ]);
    return yield* parseEffect(
      () => parseGitHubRepositorySelector(remote.stdout.trim()),
      {
        code: "DeliveryGitHubRepositoryInvalid",
        message: "The accepted delivery remote is not an owned GitHub repository.",
      },
    );
  });
}

function parseGitHubRepositorySelector(remote: string) {
  const scp = remote.includes("://")
    ? null
    : /^(?:[^@\s/:]+@)?([^\s/:]+):([^\s?#]+)$/u.exec(remote);
  let host: string;
  let repositoryPath: string;
  if (scp !== null) {
    host = scp[1] ?? "";
    repositoryPath = scp[2] ?? "";
  } else {
    const url = new URL(remote);
    if (
      !["git:", "http:", "https:", "ssh:"].includes(url.protocol) ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error("Unsupported GitHub remote URL.");
    }
    host = url.hostname;
    repositoryPath = url.pathname.replace(/^\//u, "");
  }
  const segments = repositoryPath.split("/");
  const owner = segments[0];
  const repository = segments[1]?.replace(/\.git$/u, "");
  if (
    host.toLowerCase() !== "github.com" ||
    segments.length !== 2 ||
    owner === undefined ||
    repository === undefined ||
    !/^[A-Za-z0-9_.-]+$/u.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(repository)
  ) {
    throw new Error("Unsupported GitHub repository identity.");
  }
  return `github.com/${owner}/${repository}`;
}

function observeRemoteHead(
  paths: RunPaths,
  provenance: DeliveryProvenance,
  runner: GitHubCommandRunner,
) {
  return Effect.exit(remoteBranchHead(paths, provenance, runner)).pipe(
    Effect.map((exit) =>
      exit._tag === "Failure"
        ? ({ _tag: "Unavailable" } as const)
        : ({ _tag: "Available", head: exit.value } as const),
    ),
  );
}

function remoteBranchHead(
  paths: RunPaths,
  provenance: DeliveryProvenance,
  runner: GitHubCommandRunner,
) {
  return Effect.gen(function* () {
    const result = yield* runRequired(runner, paths.workspace, "git", [
      "ls-remote",
      "--heads",
      provenance.remote,
      `refs/heads/${provenance.headBranch}`,
    ]);
    const output = result.stdout.trim();
    if (output.length === 0) return undefined;
    const lines = output.split("\n");
    if (lines.length !== 1) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryRemoteBranchReadInvalid",
          message: "The remote branch observation was ambiguous.",
          recoverable: true,
        }),
      );
    }
    const [sha, ref] = lines[0]?.split(/\s+/u) ?? [];
    if (
      sha === undefined ||
      !/^[a-f0-9]{40}$/u.test(sha) ||
      ref !== `refs/heads/${provenance.headBranch}`
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryRemoteBranchReadInvalid",
          message: "The remote branch observation was invalid.",
          recoverable: true,
        }),
      );
    }
    return sha;
  });
}

function recordFailed(
  runId: RunId,
  paths: RunPaths,
  attempted: DeliveryPublicationAttempted,
  failure: {
    readonly code: string;
    readonly message: string;
    readonly recoverable: boolean;
    readonly step: DeliveryPublicationFailed["step"];
  },
) {
  return Effect.gen(function* () {
    const failed = DeliveryPublicationFailed.make({
      ...attempted,
      ...failure,
      state: "failed",
    });
    yield* appendPublication(runId, paths, failed);
    return failed;
  });
}

function recordFailedFromIntent(
  runId: RunId,
  paths: RunPaths,
  intent: DeliveryPublicationIntent,
  failure: {
    readonly code: string;
    readonly message: string;
    readonly recoverable: boolean;
    readonly step: DeliveryPublicationFailed["step"];
  },
) {
  return Effect.gen(function* () {
    const failed = DeliveryPublicationFailed.make({
      ...intent,
      ...failure,
      state: "failed",
    });
    yield* appendPublication(runId, paths, failed);
    return failed;
  });
}

function recordUnknown(
  runId: RunId,
  paths: RunPaths,
  attempted: DeliveryPublicationAttempted,
  step: DeliveryPublicationOutcomeUnknown["step"],
) {
  return Effect.gen(function* () {
    const unknown = DeliveryPublicationOutcomeUnknown.make({
      ...attempted,
      code: "DeliveryPublicationOutcomeUnknown",
      message:
        "Gaia could not confirm the external publication outcome and will not repeat the mutation.",
      recoverable: true,
      state: "outcomeUnknown",
      step,
    });
    yield* appendPublication(runId, paths, unknown);
    return unknown;
  });
}

function recordFailedFromUnknown(
  runId: RunId,
  paths: RunPaths,
  unknown: DeliveryPublicationOutcomeUnknown,
  failure: {
    readonly code: string;
    readonly message: string;
    readonly recoverable: boolean;
    readonly step: DeliveryPublicationFailed["step"];
  },
) {
  return Effect.gen(function* () {
    const failed = DeliveryPublicationFailed.make({
      ...unknown,
      ...failure,
      state: "failed",
    });
    yield* appendPublication(runId, paths, failed);
    return failed;
  });
}

function appendPublication(
  runId: RunId,
  paths: RunPaths,
  publication: DeliveryPublication,
) {
  const type = publicationEventType(publication);
  return appendEvent(runId, paths, {
    payload: { publication: encodeDeliveryPublicationJson(publication) },
    type,
  });
}

function publicationEventType(publication: DeliveryPublication) {
  switch (publication.state) {
    case "intentRecorded":
      return "DELIVERY_PUBLICATION_INTENT_RECORDED" as const;
    case "attempted":
      return "DELIVERY_PUBLICATION_ATTEMPTED" as const;
    case "confirmed":
      return "DELIVERY_PUBLICATION_CONFIRMED" as const;
    case "failed":
      return "DELIVERY_PUBLICATION_FAILED" as const;
    case "outcomeUnknown":
      return "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN" as const;
  }
}

function optionalPublication(value: unknown) {
  if (value === undefined) return undefined;
  return parseDeliveryPublication(value);
}

function nextPublicationOperationId(
  runId: RunId,
  events: ReadonlyArray<RunEvent>,
) {
  const operationIds = new Set(
    events.flatMap((event) => {
      if (event.type !== "DELIVERY_PUBLICATION_INTENT_RECORDED") return [];
      const publication = parseDeliveryPublication(event.payload["publication"]);
      return [publication.operationId];
    }),
  );
  return `publish-${runId}-${operationIds.size + 1}`;
}

function parseProvenance(
  delivery: Record<string, Schema.Json>,
  runId: RunId,
) {
  return Effect.gen(function* () {
    const provenance = yield* parseEffect(
      () =>
        Schema.decodeUnknownSync(
          Schema.Struct({
            baseBranch: Schema.NonEmptyString,
            baseRevision: Schema.String.pipe(
              Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
            ),
            headBranch: Schema.NonEmptyString,
            mode: Schema.Literal("pullRequest"),
            remote: Schema.NonEmptyString,
          }),
        )(delivery),
      {
        code: "DeliveryPolicyInvalid",
        message: "Accepted pull-request delivery provenance is invalid.",
      },
    );
    if (
      provenance.baseBranch !== "main" ||
      provenance.headBranch !== `gaia/${runId}` ||
      provenance.remote !== "origin"
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryPolicyInvalid",
          message: "Accepted delivery provenance is not Gaia-owned policy.",
          recoverable: false,
        }),
      );
    }
    return provenance;
  });
}

function parseDelivery(value: unknown) {
  return parseEffect(
    () => Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(value),
    {
      code: "DeliveryPolicyInvalid",
      message: "The authoritative delivery projection is invalid.",
    },
  );
}

function parseJsonFile(fs: FileSystem.FileSystem, path: string) {
  return fs.readFileString(path).pipe(
    Effect.flatMap((text) =>
      parseEffect(() => JSON.parse(text), {
        code: "DeliveryArtifactJsonInvalid",
        message: "A required delivery artifact was not valid JSON.",
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof GaiaRuntimeError
        ? cause
        : makeRuntimeError({
            cause,
            code: "DeliveryArtifactUnreadable",
            message: "A required delivery artifact could not be read.",
            recoverable: true,
          }),
    ),
  );
}

function parseEffect<A>(
  parse: () => A,
  error: { readonly code: string; readonly message: string },
) {
  return Effect.try({
    try: parse,
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: error.code,
        message: error.message,
        recoverable: false,
      }),
  });
}

function parseDeliveryGitPaths<A>(parse: () => A) {
  return Effect.try({
    try: parse,
    catch: (cause) =>
      cause instanceof GaiaRuntimeError
        ? cause
        : makeRuntimeError({
            cause,
            code: "DeliveryGitPathOutputInvalid",
            message: "Git path output could not be parsed safely.",
            recoverable: false,
          }),
  });
}

function runCommand(
  runner: GitHubCommandRunner,
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) {
  return runner({ args, command, cwd, ...(env === undefined ? {} : { env }) });
}

function runRequired(
  runner: GitHubCommandRunner,
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) {
  return Effect.gen(function* () {
    const result = yield* runCommand(runner, cwd, command, args, env);
    if (result.exitCode !== 0) {
      return yield* Effect.fail(commandFailed(`${command} ${args[0] ?? ""}`));
    }
    return result;
  });
}

function commandFailed(operation: string) {
  return makeRuntimeError({
    code: "DeliveryCommandFailed",
    message: `${operation} failed during delivery publication.`,
    recoverable: true,
  });
}

function parseNameStatusZ(input: string) {
  const fields = nulFields(input);
  const paths: Array<string> = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index];
    index += 1;
    if (status === undefined || !/^[A-Z][0-9]*$/u.test(status)) {
      throw makeRuntimeError({
        code: "DeliveryGitPathOutputInvalid",
        message: "Git returned malformed NUL-delimited path status output.",
        recoverable: false,
      });
    }
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
      const path = fields[index];
      index += 1;
      if (path === undefined) {
        throw makeRuntimeError({
          code: "DeliveryGitPathOutputInvalid",
          message: "Git returned incomplete NUL-delimited path status output.",
          recoverable: false,
        });
      }
      paths.push(path);
    }
  }
  return paths;
}

function parsePathListZ(input: string) {
  return nulFields(input);
}

function nulFields(input: string) {
  if (input.length === 0) return [];
  if (!input.endsWith("\0")) {
    throw makeRuntimeError({
      code: "DeliveryGitPathOutputInvalid",
      message: "Git path output was not NUL-terminated.",
      recoverable: false,
    });
  }
  return input.slice(0, -1).split("\0");
}

function requireSafeGitPath(path: string) {
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw makeRuntimeError({
      code: "DeliveryGitPathUnsafe",
      message: "A delivery path is not a safe normalized relative git path.",
      recoverable: false,
    });
  }
}

function isExcluded(path: string, harnessPaths: ReadonlySet<string>) {
  return harnessPaths.has(path) ||
    path.split("/").some((segment) => generatedRoots.has(segment));
}

function uniqueSorted(values: ReadonlyArray<string>) {
  return [...new Set(values)].toSorted();
}

function structuralDigest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameTimestamp(left: string | undefined, right: string) {
  return left !== undefined &&
    new Date(left.trim()).getTime() === new Date(right).getTime();
}
