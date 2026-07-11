import {
  DeliveryMergeDispatchAttempted,
  DeliveryMergeDispatchConfirmed,
  DeliveryMergeIntent,
  DeliveryMergeTerminalFailure,
  DeliveryCleanupCompleted,
  DeliveryCleanupRequired,
  DeliveryMergeReadinessDecision,
  DeliveryRequiredCheckPolicy,
  DeliveryFeedbackTrustPolicyV1,
  deliveryRequiredCheckPolicyCanonicalPayload,
  deliveryFeedbackRequiresApprovedReview,
  encodeDeliveryMergeReceiptJson,
  encodeDeliveryCleanupReceiptJson,
  encodeDeliveryMergeReadinessDecisionJson,
  parseDeliveryMergeReceipt,
  parseDeliveryMergeReadinessDecision,
  parseDeliveryPublication,
  snapshotFromReplay,
  deriveDeliveryActionHistoriesFromEvents,
  type DeliveryMergeActionRequest,
  type DeliveryEvaluateMergeReadinessActionRequest,
  type DeliveryRetryCleanupActionRequest,
  type DeliveryMergeReceipt,
  type RunId,
} from "@gaia/core";
import { createHash } from "node:crypto";
import { Cause, Effect, FileSystem, Option, Schema } from "effect";
import { appendEvent, loadRun } from "./event-store.js";
import { makeRuntimeError } from "./errors.js";
import { makeRunPaths, type RunPaths, type RunStorageOptions } from "./paths.js";
import { DeliveryMergeConclusivelyRejected, invokeGitHubDeliveryMerge, validateRequiredChecks, type RequiredCheckFact } from "./delivery-merge-provider.js";
import type { GitHubCommandRunner } from "./github-publisher.js";
import { withRunStoreLock } from "./run-store-lock.js";
import { readGitHubPullRequest } from "./github-pull-request-provider.js";
import { nodeGitHubCommandRunner } from "./github-publisher.js";
import { coordinateBranchCleanup, coordinateWorktreeCleanup, type CleanupResourceAdapter } from "./delivery-cleanup-resource-coordinator.js";
import { deliveryCleanupOwnershipPayloadDigest, DeliveryCleanupOwnershipProvenanceV1 } from "./delivery-cleanup-provenance.js";
import { makeEventCleanupCheckpointStore, recordOrValidateCleanupProvenance } from "./delivery-cleanup-event-store.js";
import { makeGitCleanupResourceAdapter } from "./git-cleanup-resource-adapter.js";

export type FreshMergeState = {
  readonly branchName: string;
  readonly checks: ReadonlyArray<RequiredCheckFact>;
  readonly draft: boolean;
  readonly feedbackBlockers: number;
  readonly headSha: string;
  readonly mergeCommitSha?: string;
  readonly mergeability: "conflicting" | "mergeable" | "unknown";
  readonly mergedAt?: string;
  readonly state: "closed" | "merged" | "open";
  readonly supportedMethods: ReadonlyArray<"merge" | "rebase" | "squash">;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly repository: string;
  readonly reviewDecision?: string;
  readonly unresolvedActionableThreads: number;
};

export type DeliveryMergeCoordinatorOptions = RunStorageOptions & {
  readonly cleanupResourceAdapter?: CleanupResourceAdapter;
  readonly commandRunner?: GitHubCommandRunner;
  readonly freshStateReader?: (input: { readonly prNumber: number; readonly repository: string }) => Effect.Effect<FreshMergeState, unknown>;
  readonly requiredCheckPolicy?: typeof DeliveryRequiredCheckPolicy.Type;
};

export function requiredCheckPolicyFromTrustPolicy(trust: DeliveryFeedbackTrustPolicyV1) {
  const checks = trust.trustedChecks.map((check) => ({ ...check })).sort((left, right) =>
    [left.repository, left.workflow, left.name, left.appSlug].join("\0").localeCompare([right.repository, right.workflow, right.name, right.appSlug].join("\0"))
  );
  return DeliveryRequiredCheckPolicy.make({ checks, requireApprovedReview: deliveryFeedbackRequiresApprovedReview(trust), version: 1 });
}

export function makeGitHubFreshMergeStateReader(input: { readonly commandRunner?: GitHubCommandRunner; readonly rootDirectory: string; readonly trustPolicy: DeliveryFeedbackTrustPolicyV1 }) {
  return (target: { readonly prNumber: number; readonly repository: string }) => Effect.gen(function* () {
    const commandRunner = input.commandRunner ?? nodeGitHubCommandRunner;
    const read = yield* readGitHubPullRequest({ commandRunner, prNumber: target.prNumber, repository: target.repository, rootDirectory: input.rootDirectory, trustPolicy: input.trustPolicy });
    const view = yield* commandRunner({ args: ["pr", "view", String(target.prNumber), "--repo", target.repository, "--json", "headRefName,headRefOid,isDraft,mergeable,reviewDecision,state,mergedAt,mergeCommit,url"], command: "gh", cwd: input.rootDirectory });
    const repo = yield* commandRunner({ args: ["repo", "view", target.repository, "--json", "mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed"], command: "gh", cwd: input.rootDirectory });
    if (view.exitCode !== 0 || repo.exitCode !== 0) return yield* Effect.fail(makeRuntimeError({ code: "DeliveryMergeReadFailed", message: "GitHub merge state is unavailable.", recoverable: true }));
    const detail = JSON.parse(view.stdout) as { headRefName: string; headRefOid: string; isDraft: boolean; mergeable: string; reviewDecision?: string | null; state: string; mergedAt?: string | null; mergeCommit?: { oid?: string } | null; url: string };
    const capability = JSON.parse(repo.stdout) as { mergeCommitAllowed: boolean; rebaseMergeAllowed: boolean; squashMergeAllowed: boolean };
    const methods = [...(capability.mergeCommitAllowed ? ["merge" as const] : []), ...(capability.rebaseMergeAllowed ? ["rebase" as const] : []), ...(capability.squashMergeAllowed ? ["squash" as const] : [])];
    return {
      branchName: detail.headRefName,
      checks: read.observation.checks.map((check) => ({ appSlug: check.appSlug, headSha: read.observation.headSha, name: check.name, repository: target.repository, state: check.state === "passing" ? "passing" as const : check.state === "pending" ? "pending" as const : "failed" as const, workflow: check.workflow })),
      draft: detail.isDraft,
      feedbackBlockers: read.observation.blockers.length,
      headSha: detail.headRefOid,
      ...(detail.mergeCommit?.oid === undefined ? {} : { mergeCommitSha: detail.mergeCommit.oid }),
      mergeability: detail.mergeable === "MERGEABLE" ? "mergeable" as const : detail.mergeable === "CONFLICTING" ? "conflicting" as const : "unknown" as const,
      ...(detail.mergedAt == null ? {} : { mergedAt: detail.mergedAt }),
      prNumber: target.prNumber,
      prUrl: detail.url,
      repository: target.repository,
      ...(detail.reviewDecision == null ? {} : { reviewDecision: detail.reviewDecision }),
      state: detail.state === "OPEN" ? "open" as const : detail.state === "MERGED" ? "merged" as const : "closed" as const,
      supportedMethods: methods,
      unresolvedActionableThreads: read.observation.feedback.filter((item) => item.kind === "thread" && item.classification === "actionable").length,
    } satisfies FreshMergeState;
  });
}

export function coordinateDeliveryMerge(
  runId: RunId,
  action: DeliveryMergeActionRequest,
  options: DeliveryMergeCoordinatorOptions,
) {
  return withRunStoreLock(options, Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);
    const delivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      snapshotFromReplay(loaded.events).context["delivery"],
    );
    const publication = parseDeliveryPublication(delivery["publication"]);
    if (publication.state !== "confirmed") return yield* conflict("Owned pull request is not confirmed.");
    const repository = repositoryFromPrUrl(publication.prUrl);
    const histories = deriveDeliveryActionHistoriesFromEvents(loaded.events);
    const previous = histories.merge.latest?.latest;
    const trust = Schema.decodeUnknownSync(DeliveryFeedbackTrustPolicyV1)(delivery["feedbackTrustPolicy"]);
    const policy = requiredCheckPolicyFromTrustPolicy(trust);
    const stateReader = options.freshStateReader ?? makeGitHubFreshMergeStateReader({ ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }), rootDirectory: options.rootDirectory ?? ".", trustPolicy: trust });
    if (options.requiredCheckPolicy !== undefined && deliveryRequiredCheckPolicyCanonicalPayload(options.requiredCheckPolicy) !== deliveryRequiredCheckPolicyCanonicalPayload(policy)) return yield* conflict("Process required-check policy drifted from persisted run authority.");
    const policyDigest = hash(deliveryRequiredCheckPolicyCanonicalPayload(policy));
    if (action.expectedPolicyDigest !== policyDigest) return yield* conflict("Required-check policy changed.");
    if (action.expectedBranchName !== publication.branchName) return yield* conflict("Owned branch changed from the confirmed action tuple.");
    const binding = {
      actionId: action.actionId,
      branchName: publication.branchName,
      decisionSequence: action.expectedDecisionSequence,
      expectedHeadSha: action.expectedHeadSha,
      mergeMethod: action.mergeMethod,
      payloadDigest: hash([action.actionId, runId, publication.prUrl, action.expectedBranchName, action.expectedHeadSha, String(action.expectedDecisionSequence), action.mergeMethod, policyDigest].join("\0")),
      policyDigest,
      policyVersion: 1 as const,
      prNumber: publication.prNumber,
      prUrl: publication.prUrl,
      repository,
    };
    const readinessEvents = loaded.events.filter(({ type }) => type === "DELIVERY_MERGE_READINESS_RECORDED");
    const decisionEvent = readinessEvents.at(-1);
    if (decisionEvent?.sequence !== action.expectedDecisionSequence) {
      return yield* conflict("The merge action does not target the latest readiness decision.");
    }
    if (decisionEvent?.type !== "DELIVERY_MERGE_READINESS_RECORDED") {
      return yield* conflict("The authoritative readiness decision is missing or stale.");
    }
    const decision = parseDeliveryMergeReadinessDecision(decisionEvent.payload["decision"]);
    const decisionDigest = hash([decision.actionId, runId, decision.prUrl, decision.branchName, decision.mergeMethod, decision.policyDigest].join("\0"));
    if (
      !decision.approved ||
      decision.payloadDigest !== decisionDigest ||
      decision.branchName !== binding.branchName ||
      decision.headSha !== binding.expectedHeadSha ||
      decision.mergeMethod !== binding.mergeMethod ||
      decision.policyDigest !== binding.policyDigest ||
      decision.policyVersion !== binding.policyVersion ||
      decision.prNumber !== binding.prNumber ||
      decision.prUrl !== binding.prUrl
    ) return yield* conflict("The merge action does not match the approved readiness decision.");
    if (previous !== undefined) {
      if (previous.state === "dispatchAttempted" || previous.state === "outcomeUnknown") {
        assertSameBinding(previous, binding);
        return yield* reconcile(runId, paths, previous, { ...options, freshStateReader: stateReader });
      }
      if (previous.state === "dispatchConfirmed") {
        assertSameBinding(previous, binding);
        return previous;
      }
      if (previous.state === "dispatchFailed") {
        if (previous.actionId === binding.actionId) {
          assertSameBinding(previous, binding);
          return previous;
        }
        if (binding.decisionSequence <= previous.decisionSequence) return yield* conflict("A new merge action requires a newer readiness decision.");
      } else {
        assertSameBinding(previous, binding);
      }
    }
    const fresh = yield* stateReader({ prNumber: publication.prNumber, repository }).pipe(
      Effect.mapError(() => makeRuntimeError({ code: "DeliveryMergeReadFailed", message: "Fresh GitHub state could not be verified.", recoverable: true })),
    );
    validateFresh(fresh, publication.branchName, action, policy);
    const intent = previous?.state === "intentRecorded"
      ? previous
      : DeliveryMergeIntent.make({ ...binding, state: "intentRecorded" });
    if (previous?.state !== "intentRecorded") yield* appendMerge(runId, paths, intent);
    const attempted = DeliveryMergeDispatchAttempted.make({ ...binding, state: "dispatchAttempted" });
    yield* appendMerge(runId, paths, attempted);
    yield* appendEvent(runId, paths, { payload: { checkpoint: { actionId: binding.actionId, payloadDigest: binding.payloadDigest, state: "attemptRecorded", version: 1 } }, type: "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED" });
    // Ephemeral permission: only this uninterrupted stack that appended attempted invokes.
    const dispatch = yield* Effect.exit(invokeGitHubDeliveryMerge({ cwd: paths.workspace, expectedHeadSha: action.expectedHeadSha, method: action.mergeMethod, prUrl: publication.prUrl, repository }, options.commandRunner));
    if (dispatch._tag === "Failure") {
      const failure = Option.getOrUndefined(Cause.findErrorOption(dispatch.cause));
      const rejected = failure instanceof DeliveryMergeConclusivelyRejected ? failure : undefined;
      const terminal = DeliveryMergeTerminalFailure.make({ ...binding, code: rejected === undefined ? "DeliveryMergeOutcomeUnknown" : "DeliveryMergeRejected", message: rejected === undefined ? "Provider invocation may have been accepted; reconciliation is required." : rejected.message, state: rejected === undefined ? "outcomeUnknown" : "dispatchFailed" });
      yield* appendMerge(runId, paths, terminal);
      return terminal;
    }
    return yield* reconcile(runId, paths, attempted, { ...options, freshStateReader: stateReader });
  }), {
    operation: "Gaia exact-head merge action",
    nextSafeAction: "Refresh delivery state; replayed attempts reconcile without redispatch.",
  });
}

export function coordinateDeliveryMergeReadiness(runId: RunId, action: DeliveryEvaluateMergeReadinessActionRequest, options: DeliveryMergeCoordinatorOptions) {
  return withRunStoreLock(options, Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);
    const replay = snapshotFromReplay(loaded.events);
    if (replay.state !== "delivering") return yield* conflict("Merge readiness requires a delivering pull-request run.");
    const delivery = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(replay.context["delivery"]);
    const publication = parseDeliveryPublication(delivery["publication"]);
    if (publication.state !== "confirmed") return yield* conflict("Merge readiness requires a confirmed owned pull request.");
    const trust = Schema.decodeUnknownSync(DeliveryFeedbackTrustPolicyV1)(delivery["feedbackTrustPolicy"]);
    const policy = requiredCheckPolicyFromTrustPolicy(trust);
    const policyDigest = hash(deliveryRequiredCheckPolicyCanonicalPayload(policy));
    const repository = repositoryFromPrUrl(publication.prUrl);
    const readinessDigest = hash([action.actionId, runId, publication.prUrl, publication.branchName, action.mergeMethod, policyDigest].join("\0"));
    const prior = loaded.events
      .filter(({ type }) => type === "DELIVERY_MERGE_READINESS_RECORDED")
      .map((event) => parseDeliveryMergeReadinessDecision(event.payload["decision"]))
      .find((decision) => decision.actionId === action.actionId);
    if (prior !== undefined) {
      if (prior.payloadDigest !== readinessDigest) return yield* conflict("Readiness action ID conflicts with a changed immutable tuple.");
      return prior;
    }
    const reader = options.freshStateReader ?? makeGitHubFreshMergeStateReader({ ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }), rootDirectory: options.rootDirectory ?? ".", trustPolicy: trust });
    const fresh = yield* reader({ prNumber: publication.prNumber, repository }).pipe(Effect.mapError(() => makeRuntimeError({ code: "DeliveryMergeReadFailed", message: "Fresh GitHub readiness evidence is unavailable.", recoverable: true })));
    const blockers = freshBlockers(fresh, publication.branchName, action.mergeMethod, policy);
    const decision = DeliveryMergeReadinessDecision.make({ actionId: action.actionId, approved: blockers.length === 0, blockers, branchName: publication.branchName, headSha: fresh.headSha, mergeMethod: action.mergeMethod, payloadDigest: readinessDigest, policyDigest, policyVersion: 1, prNumber: publication.prNumber, prUrl: publication.prUrl });
    yield* appendEvent(runId, paths, { payload: { decision: encodeDeliveryMergeReadinessDecisionJson(decision) }, type: "DELIVERY_MERGE_READINESS_RECORDED" });
    return decision;
  }), { operation: "Gaia merge readiness decision", nextSafeAction: "Refresh the latest readiness decision before any merge action." });
}

export function coordinateDeliveryCleanup(runId: RunId, action: DeliveryRetryCleanupActionRequest, options: DeliveryMergeCoordinatorOptions) {
  return withRunStoreLock(options, Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);
    const histories = deriveDeliveryActionHistoriesFromEvents(loaded.events);
    const merge = histories.merge.latest?.latest;
    if (merge === undefined) return yield* conflict("Confirmed merge history is unavailable.");
    if (merge.state !== "dispatchConfirmed" || merge.mergeCommitSha !== action.expectedMergeCommitSha) return yield* conflict("Cleanup action does not match the confirmed merge receipt.");
    const ownershipDigest = hash([runId, merge.branchName, merge.expectedHeadSha, merge.mergeCommitSha].join("\0"));
    const fs = yield* FileSystem.FileSystem;
    const manifest = Schema.decodeUnknownSync(Schema.Struct({ repositoryCommonDir: Schema.NonEmptyString, repositoryRoot: Schema.NonEmptyString, token: Schema.NonEmptyString, version: Schema.Literal(1), workspaceCommonDir: Schema.NonEmptyString, workspaceRoot: Schema.NonEmptyString }))(JSON.parse(yield* fs.readFileString(paths.deliveryOwnershipManifest)));
    const provenanceBase = {
      actionId: action.actionId, branchRef: `refs/heads/${merge.branchName}`, expectedBranchOid: merge.expectedHeadSha,
      mergeCommitSha: merge.mergeCommitSha, ownershipDigest, ownershipToken: manifest.token,
      repositoryCommonDir: manifest.repositoryCommonDir, repositoryRoot: manifest.repositoryRoot, runId,
      version: 1 as const, worktreeCommonDir: manifest.workspaceCommonDir, worktreePath: manifest.workspaceRoot,
    };
    const provenance = DeliveryCleanupOwnershipProvenanceV1.make({ ...provenanceBase, payloadDigest: deliveryCleanupOwnershipPayloadDigest(provenanceBase) });
    yield* recordOrValidateCleanupProvenance(runId, paths, provenance);
    const checkpointStore = makeEventCleanupCheckpointStore(runId, paths);
    const adapter = options.cleanupResourceAdapter ?? makeGitCleanupResourceAdapter();
    const worktreeResult = yield* Effect.exit(coordinateWorktreeCleanup({ adapter, checkpointStore, provenance }));
    const branchResult = worktreeResult._tag === "Success"
      ? yield* Effect.exit(coordinateBranchCleanup({ adapter, checkpointStore, provenance }))
      : undefined;
    if (worktreeResult._tag === "Failure" || branchResult?._tag === "Failure") {
      const checkpoints = yield* checkpointStore.read();
      const absent = (resource: "branch" | "worktree") => checkpoints.some((checkpoint) => checkpoint.resource === resource && checkpoint.state === "absenceProven");
      const partial = DeliveryCleanupRequired.make({ actionId: action.actionId, branch: absent("branch") ? "absent" : "present", branchName: merge.branchName, mergeCommitSha: merge.mergeCommitSha, ownershipDigest, state: "cleanupRequired", worktree: absent("worktree") ? "absent" : "present" });
      yield* appendEvent(runId, paths, { payload: { cleanup: encodeDeliveryCleanupReceiptJson(partial) }, type: "DELIVERY_CLEANUP_RECORDED" });
      if (worktreeResult._tag === "Failure") return yield* Effect.fail(worktreeResult.cause);
      if (branchResult?._tag === "Failure") return yield* Effect.fail(branchResult.cause);
      return yield* Effect.die("Unreachable cleanup failure state.");
    }
    const completed = DeliveryCleanupCompleted.make({ actionId: action.actionId, branch: "absent", branchName: merge.branchName, mergeCommitSha: merge.mergeCommitSha, ownershipDigest, state: "completed", worktree: "absent" });
    yield* appendEvent(runId, paths, { payload: { cleanup: encodeDeliveryCleanupReceiptJson(completed) }, type: "DELIVERY_CLEANUP_RECORDED" });
    return completed;
  }), { operation: "Gaia owned delivery cleanup", nextSafeAction: "Refresh cleanup state and retry only the exact remaining owned resource." });
}

function reconcile(runId: RunId, paths: RunPaths, previous: DeliveryMergeReceipt, options: DeliveryMergeCoordinatorOptions) {
  return Effect.gen(function* () {
    const fresh = yield* options.freshStateReader!({ prNumber: previous.prNumber, repository: previous.repository }).pipe(Effect.mapError(() => makeRuntimeError({ code: "DeliveryMergeReconciliationFailed", message: "Merge outcome remains unknown.", recoverable: true })));
    if (
      fresh.repository === previous.repository &&
      fresh.prNumber === previous.prNumber &&
      fresh.prUrl === previous.prUrl &&
      fresh.branchName === previous.branchName &&
      fresh.headSha === previous.expectedHeadSha &&
      fresh.state === "merged" &&
      fresh.mergeCommitSha !== undefined &&
      fresh.mergedAt !== undefined
    ) {
      const confirmed = DeliveryMergeDispatchConfirmed.make({ ...previous, mergeCommitSha: fresh.mergeCommitSha, mergedAt: fresh.mergedAt, state: "dispatchConfirmed" });
      yield* appendMerge(runId, paths, confirmed);
      return confirmed;
    }
    const unknown = DeliveryMergeTerminalFailure.make({ ...previous, code: "DeliveryMergeOutcomeUnknown", message: "GitHub does not yet prove the exact merge receipt.", state: "outcomeUnknown" });
    if (previous.state !== "outcomeUnknown") yield* appendMerge(runId, paths, unknown);
    return unknown;
  });
}

function appendMerge(runId: RunId, paths: RunPaths, receipt: DeliveryMergeReceipt) {
  return appendEvent(runId, paths, { payload: { mergeAction: encodeDeliveryMergeReceiptJson(receipt) }, type: "DELIVERY_MERGE_RECORDED" });
}
function validateFresh(fresh: FreshMergeState, branch: string, action: DeliveryMergeActionRequest, policy: typeof DeliveryRequiredCheckPolicy.Type) {
  if (fresh.prUrl !== action.expectedPrUrl || fresh.headSha !== action.expectedHeadSha || freshBlockers(fresh, branch, action.mergeMethod, policy).length > 0) throw makeRuntimeError({ code: "DeliveryMergePreconditionFailed", message: "Fresh GitHub state does not satisfy the approved exact-head decision.", recoverable: true });
}
function freshBlockers(fresh: FreshMergeState, branch: string, method: "merge" | "rebase" | "squash", policy: typeof DeliveryRequiredCheckPolicy.Type) {
  const blockers: string[] = [];
  if (fresh.branchName !== branch) blockers.push("Owned branch changed.");
  if (fresh.state !== "open" || fresh.mergedAt !== undefined || fresh.mergeCommitSha !== undefined) blockers.push("Pull request is not open and unmerged.");
  if (fresh.draft) blockers.push("Pull request is draft.");
  if (!fresh.supportedMethods.includes(method)) blockers.push("Selected merge method is unavailable.");
  if (fresh.mergeability !== "mergeable") blockers.push("Mergeability is not mergeable.");
  if (fresh.unresolvedActionableThreads !== 0) blockers.push("Actionable review threads remain unresolved.");
  if (fresh.feedbackBlockers !== 0) blockers.push("Trusted feedback evaluation remains blocked or ambiguous.");
  if (fresh.reviewDecision === "CHANGES_REQUESTED") blockers.push("Review changes are requested.");
  else if (policy.requireApprovedReview && fresh.reviewDecision !== "APPROVED") blockers.push("Required review approval is absent.");
  else if (!policy.requireApprovedReview && fresh.reviewDecision !== undefined && fresh.reviewDecision !== "APPROVED" && fresh.reviewDecision !== "REVIEW_REQUIRED") blockers.push("Review state is ambiguous or unsupported.");
  if (!validateRequiredChecks(policy.checks, fresh.checks, fresh.headSha)) blockers.push("Required checks are incomplete or unsuccessful.");
  return blockers;
}
function assertSameBinding(previous: DeliveryMergeReceipt, binding: Omit<DeliveryMergeReceipt, "state">) {
  if (previous.actionId !== binding.actionId || previous.payloadDigest !== binding.payloadDigest) throw makeRuntimeError({ code: "DeliveryActionConflict", message: "Merge action ID conflicts with a different immutable tuple.", recoverable: true });
}
function repositoryFromPrUrl(url: string) { const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//u.exec(url); if (match?.[1] === undefined) throw new Error("Invalid owned PR URL."); return match[1]; }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function conflict(message: string) { return Effect.fail(makeRuntimeError({ code: "DeliveryActionConflict", message, recoverable: true })); }
