import {
  DeliveryPullRequestReadyConfirmedWithoutDispatch,
  DeliveryPullRequestReadyDispatchAttempted,
  DeliveryPullRequestReadyDispatchConfirmed,
  DeliveryPullRequestReadyIntent,
  DeliveryPullRequestReadyTerminalFailure,
  assertDeliveryPullRequestReadyAuthority,
  deliveryPullRequestReadyPayloadDigest,
  deriveDeliveryActionHistoriesFromEvents,
  encodeDeliveryPullRequestReadyReceiptJson,
  parseDeliveryPublication,
  snapshotFromReplay,
  type DeliveryMarkReadyForReviewActionRequest,
  type DeliveryPullRequestReadyReceipt,
  type RunId,
} from "@gaia/core";
import { Cause, Effect, Option, Schema } from "effect";
import {
  DeliveryReadyForReviewConclusivelyRejected,
  invokeGitHubReadyForReview,
  type DeliveryReadyForReviewProviderInput,
} from "./delivery-merge-provider.js";
import { appendEvent, readEvents } from "./event-store.js";
import { makeRuntimeError } from "./errors.js";
import { nodeGitHubCommandRunner, type GitHubCommandRunner } from "./github-publisher.js";
import { makeRunPaths, type RunPaths, type RunStorageOptions } from "./paths.js";
import { withRunStoreLock } from "./run-store-lock.js";

export type FreshReadyForReviewState = {
  readonly branchName: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly mergeCommitSha?: string;
  readonly mergedAt?: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly repository: string;
  readonly state: "closed" | "merged" | "open";
};

export type DeliveryReadyForReviewCoordinatorOptions = RunStorageOptions & {
  readonly commandRunner?: GitHubCommandRunner;
  readonly freshStateReader?: (input: {
    readonly prNumber: number;
    readonly repository: string;
  }) => Effect.Effect<FreshReadyForReviewState, unknown>;
  readonly readyForReviewProvider?: (
    input: DeliveryReadyForReviewProviderInput,
  ) => Effect.Effect<void, unknown>;
};

const GitHubReadyView = Schema.Struct({
  headRefName: Schema.NonEmptyString,
  headRefOid: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u))),
  isDraft: Schema.Boolean,
  mergeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.optional(Schema.String) })),
  mergedAt: Schema.NullOr(Schema.String),
  state: Schema.String,
  url: Schema.String,
});

export function makeGitHubFreshReadyForReviewStateReader(input: {
  readonly commandRunner?: GitHubCommandRunner;
  readonly rootDirectory: string;
}) {
  return (target: { readonly prNumber: number; readonly repository: string }) => Effect.gen(function* () {
    const commandRunner = input.commandRunner ?? nodeGitHubCommandRunner;
    const result = yield* commandRunner({
      args: ["pr", "view", String(target.prNumber), "--repo", target.repository, "--json", "headRefName,headRefOid,isDraft,state,mergedAt,mergeCommit,url"],
      command: "gh",
      cwd: input.rootDirectory,
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(readyReadError());
    }
    const detail = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(GitHubReadyView)(JSON.parse(result.stdout)),
      catch: () => readyReadError(),
    });
    return {
      branchName: detail.headRefName,
      draft: detail.isDraft,
      headSha: detail.headRefOid,
      ...(detail.mergeCommit?.oid === undefined ? {} : { mergeCommitSha: detail.mergeCommit.oid }),
      ...(detail.mergedAt === null ? {} : { mergedAt: detail.mergedAt }),
      prNumber: target.prNumber,
      prUrl: detail.url,
      repository: target.repository,
      state: detail.state === "OPEN" ? "open" as const : detail.state === "MERGED" ? "merged" as const : "closed" as const,
    } satisfies FreshReadyForReviewState;
  });
}

export function coordinateDeliveryPullRequestReady(
  runId: RunId,
  action: DeliveryMarkReadyForReviewActionRequest,
  options: DeliveryReadyForReviewCoordinatorOptions,
) {
  return withRunStoreLock(options, Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const events = yield* readEvents(paths).pipe(
      Effect.catchCause(() => conflict("Ready-for-review history is invalid for the current run authority.")),
    );
    const replay = snapshotFromReplay(events);
    if (replay.state !== "delivering") return yield* conflict("Ready-for-review requires a delivering pull-request run.");
    const delivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(replay.context["delivery"]);
    const publication = parseDeliveryPublication(delivery["publication"]);
    if (publication.state !== "confirmed") return yield* conflict("Ready-for-review requires a confirmed owned pull request.");
    const repository = repositoryFromPrUrl(publication.prUrl);
    if (
      action.expectedBranchName !== publication.branchName ||
      action.expectedHeadSha !== publication.headSha ||
      action.expectedPrNumber !== publication.prNumber ||
      action.expectedPrUrl !== publication.prUrl
    ) return yield* conflict("Ready-for-review action does not match the confirmed owned pull request.");

    const bindingBase = {
      actionId: action.actionId,
      branchName: action.expectedBranchName,
      expectedHeadSha: action.expectedHeadSha,
      prNumber: action.expectedPrNumber,
      prUrl: action.expectedPrUrl,
      publicationOperationId: publication.operationId,
      publicationPayloadDigest: publication.payloadDigest,
      repository,
      runId,
      version: 1 as const,
    };
    const binding = {
      ...bindingBase,
      payloadDigest: deliveryPullRequestReadyPayloadDigest(bindingBase),
    };
    const authority = {
      branchName: publication.branchName,
      expectedHeadSha: publication.headSha,
      prNumber: publication.prNumber,
      prUrl: publication.prUrl,
      publicationOperationId: publication.operationId,
      publicationPayloadDigest: publication.payloadDigest,
      repository,
      runId,
    };
    const histories = validateReadyHistories(events, authority);
    const previous = histories.latest?.latest;
    if (previous !== undefined && previous.actionId === action.actionId) assertSameReadyBinding(previous, binding);
    if (histories.active !== undefined && histories.active.actionId !== action.actionId) {
      return yield* conflict("An unresolved ready-for-review action cannot be superseded.");
    }
    if (previous !== undefined && previous.actionId !== action.actionId && isConfirmed(previous) && sameReadyTarget(previous, binding)) {
      return yield* conflict("The current publication and head already have an authoritative ready confirmation.");
    }
    if (previous?.actionId === action.actionId && isConfirmed(previous)) return previous;

    const reader = options.freshStateReader ?? makeGitHubFreshReadyForReviewStateReader({
      ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
      rootDirectory: options.rootDirectory ?? ".",
    });
    if (previous?.actionId === action.actionId && (previous.state === "dispatchAttempted" || previous.state === "outcomeUnknown" || previous.state === "dispatchFailed")) {
      return yield* reconcileReady(runId, paths, previous, reader);
    }

    const preRead = yield* reader({ prNumber: binding.prNumber, repository }).pipe(
      Effect.mapError(() => readyReadError()),
    );
    if (!isExactReadyState(preRead, binding)) return yield* conflict("Fresh pull request identity does not match the exact ready-for-review action.");
    const intent = previous?.state === "intentRecorded"
      ? previous
      : DeliveryPullRequestReadyIntent.make({ ...binding, state: "intentRecorded" });
    if (previous?.state !== "intentRecorded") yield* appendReady(runId, paths, intent);
    if (!preRead.draft) {
      const confirmed = DeliveryPullRequestReadyConfirmedWithoutDispatch.make({ ...binding, draft: false, state: "confirmedWithoutDispatch" });
      yield* appendReady(runId, paths, confirmed);
      return confirmed;
    }

    const attempted = DeliveryPullRequestReadyDispatchAttempted.make({ ...binding, state: "dispatchAttempted" });
    yield* appendReady(runId, paths, attempted);
    // Ephemeral permission: only this uninterrupted stack that persisted attempted may invoke.
    const provider = options.readyForReviewProvider ?? ((providerInput) => invokeGitHubReadyForReview(providerInput, options.commandRunner));
    const outcome = yield* Effect.exit(provider({ cwd: paths.workspace, prUrl: binding.prUrl, repository }));
    const postRead = yield* Effect.exit(reader({ prNumber: binding.prNumber, repository }));
    if (postRead._tag === "Success" && isExactReadyState(postRead.value, binding) && !postRead.value.draft) {
      const confirmed = DeliveryPullRequestReadyDispatchConfirmed.make({ ...binding, draft: false, state: "dispatchConfirmed" });
      yield* appendReady(runId, paths, confirmed);
      return confirmed;
    }
    const providerError = outcome._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(outcome.cause)) : undefined;
    if (
      providerError instanceof DeliveryReadyForReviewConclusivelyRejected &&
      postRead._tag === "Success" &&
      isExactReadyState(postRead.value, binding) &&
      postRead.value.draft
    ) {
      const failed = DeliveryPullRequestReadyTerminalFailure.make({ ...binding, code: "DeliveryReadyRejected", message: "GitHub conclusively rejected the ready-for-review action.", state: "dispatchFailed" });
      yield* appendReady(runId, paths, failed);
      return failed;
    }
    const unknown = readyUnknown(binding);
    yield* appendReady(runId, paths, unknown);
    return unknown;
  }), {
    operation: "Gaia exact pull-request ready-for-review action",
    nextSafeAction: "Refresh the exact pull request; attempted actions reconcile without redispatch.",
  });
}

export function requireExactReadyForReviewConfirmation(
  events: Parameters<typeof deriveDeliveryActionHistoriesFromEvents>[0],
  input: {
    readonly branchName: string;
    readonly expectedHeadSha: string;
    readonly prNumber: number;
    readonly prUrl: string;
    readonly publicationOperationId: string;
    readonly publicationPayloadDigest: string;
    readonly repository: string;
    readonly runId: string;
  },
) {
  const histories = validateReadyHistories(events, input);
  const latest = histories.latest?.latest;
  if (histories.active !== undefined || latest === undefined || !isConfirmed(latest) || !sameReadyTarget(latest, input)) {
    throw makeRuntimeError({ code: "DeliveryActionConflict", message: "Exact current-head ready-for-review confirmation is required.", recoverable: true });
  }
  return latest;
}

function validateReadyHistories(
  events: Parameters<typeof deriveDeliveryActionHistoriesFromEvents>[0],
  expected: Parameters<typeof assertDeliveryPullRequestReadyAuthority>[1],
) {
  const histories = deriveDeliveryActionHistoriesFromEvents(events).readyForReview;
  for (const history of histories.histories) {
    for (const { receipt } of history.receipts) {
      try {
        assertDeliveryPullRequestReadyAuthority(receipt, expected);
      } catch {
        throw makeRuntimeError({ code: "DeliveryActionConflict", message: "Ready-for-review action binding is invalid for the confirmed publication generation.", recoverable: true });
      }
    }
  }
  return histories;
}

function reconcileReady(
  runId: RunId,
  paths: RunPaths,
  previous: DeliveryPullRequestReadyReceipt,
  reader: NonNullable<DeliveryReadyForReviewCoordinatorOptions["freshStateReader"]>,
) {
  return Effect.gen(function* () {
    const read = yield* Effect.exit(reader({ prNumber: previous.prNumber, repository: previous.repository }));
    if (read._tag === "Success" && isExactReadyState(read.value, previous) && !read.value.draft) {
      const confirmed = DeliveryPullRequestReadyDispatchConfirmed.make({ ...previous, draft: false, state: "dispatchConfirmed" });
      yield* appendReady(runId, paths, confirmed);
      return confirmed;
    }
    if (previous.state === "dispatchFailed") return previous;
    const unknown = readyUnknown(previous);
    if (previous.state !== "outcomeUnknown") yield* appendReady(runId, paths, unknown);
    return unknown;
  });
}

function appendReady(runId: RunId, paths: RunPaths, receipt: DeliveryPullRequestReadyReceipt) {
  return appendEvent(runId, paths, {
    payload: { readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(receipt) },
    type: "DELIVERY_PR_READY_RECORDED",
  });
}

function readyUnknown(binding: Omit<DeliveryPullRequestReadyReceipt, "state">) {
  return DeliveryPullRequestReadyTerminalFailure.make({
    ...binding,
    code: "DeliveryReadyOutcomeUnknown",
    message: "Fresh provider state did not confirm the exact ready-for-review action.",
    state: "outcomeUnknown",
  });
}

function isExactReadyState(fresh: FreshReadyForReviewState, binding: {
  readonly branchName: string;
  readonly expectedHeadSha: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly repository: string;
}) {
  return fresh.repository === binding.repository &&
    fresh.prNumber === binding.prNumber &&
    fresh.prUrl === binding.prUrl &&
    fresh.branchName === binding.branchName &&
    fresh.headSha === binding.expectedHeadSha &&
    fresh.state === "open" &&
    fresh.mergedAt === undefined &&
    fresh.mergeCommitSha === undefined;
}

function isConfirmed(receipt: DeliveryPullRequestReadyReceipt) {
  return receipt.state === "confirmedWithoutDispatch" || receipt.state === "dispatchConfirmed";
}

function sameReadyTarget(left: {
  readonly branchName: string;
  readonly expectedHeadSha: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly publicationOperationId: string;
  readonly publicationPayloadDigest: string;
  readonly repository: string;
  readonly runId: string;
}, right: {
  readonly branchName: string;
  readonly expectedHeadSha: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly publicationOperationId: string;
  readonly publicationPayloadDigest: string;
  readonly repository: string;
  readonly runId: string;
}) {
  return left.branchName === right.branchName && left.expectedHeadSha === right.expectedHeadSha &&
    left.prNumber === right.prNumber && left.prUrl === right.prUrl &&
    left.publicationOperationId === right.publicationOperationId &&
    left.publicationPayloadDigest === right.publicationPayloadDigest && left.repository === right.repository &&
    left.runId === right.runId;
}

function assertSameReadyBinding(previous: DeliveryPullRequestReadyReceipt, binding: {
  readonly payloadDigest: string;
}) {
  if (previous.payloadDigest !== binding.payloadDigest) {
    throw makeRuntimeError({ code: "DeliveryActionConflict", message: "Ready-for-review action ID conflicts with a different immutable tuple.", recoverable: true });
  }
}

function repositoryFromPrUrl(url: string) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//u.exec(url);
  if (match?.[1] === undefined) throw new Error("Invalid owned PR URL.");
  return match[1];
}

function conflict(message: string) {
  return Effect.fail(makeRuntimeError({ code: "DeliveryActionConflict", message, recoverable: true }));
}

function readyReadError() {
  return makeRuntimeError({ code: "DeliveryReadyReadFailed", message: "Fresh GitHub ready-for-review state is unavailable.", recoverable: true });
}
