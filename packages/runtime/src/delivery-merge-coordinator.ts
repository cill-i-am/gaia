import { createHash } from "node:crypto";

import {
  DeliveryBranchNamePublicSchema,
  DeliveryMergeDispatchAttempted,
  DeliveryMergeDispatchConfirmed,
  DeliveryMergeIntent,
  DeliveryMergeTerminalFailure,
  DeliveryCleanupCompleted,
  DeliveryCleanupRequired,
  DeliveryGitShaPublicSchema,
  DeliveryMergeReadinessDecision,
  DeliveryMergeReadinessDecisionV2,
  DeliveryMergeReadinessDecisionV3,
  DeliveryGitHubApprovedReviewSource,
  DeliveryLocalOperatorReviewSource,
  DeliveryReviewApprovalNotRequiredSource,
  DeliveryRequiredCheckPolicy,
  DeliveryFeedbackTrustPolicyV1,
  DeliverySha256DigestPublicSchema,
  DeliveryTimestampPublicSchema,
  deliveryRequiredCheckPolicyCanonicalPayload,
  deliveryMergeReadinessDecisionV2PayloadDigest,
  deliveryMergeReadinessDecisionV3PayloadDigest,
  deliveryFeedbackRequiresApprovedReview,
  encodeDeliveryMergeReceiptJson,
  encodeDeliveryCleanupReceiptJson,
  encodeDeliveryMergeReadinessDecisionJson,
  GitHubPullRequestUrlPublicSchema,
  GitHubRepositoryPublicSchema,
  parseDeliveryMergeReceipt,
  parseDeliveryMergeReadinessDecision,
  parseMergeDecisionV2,
  RunProofProjectionV1Schema,
  parseDeliveryPublication,
  snapshotFromReplay,
  deriveDeliveryActionHistoriesFromEvents,
  deriveAuthoritativeDeliveryHeadSha,
  deriveDeliveryAuthority,
  currentDeliveryLocalReviewAttestation,
  RunIdSchema,
  type DeliveryReviewApprovalSource,
  type DeliveryMergeActionRequest,
  type DeliveryEvaluateMergeReadinessActionRequest,
  type DeliveryRetryCleanupActionRequest,
  type DeliveryMergeReceipt,
  type RunId,
} from "@gaia/core";
import { Cause, Effect, FileSystem, Option, Schema } from "effect";

import {
  makeEventCleanupCheckpointStore,
  recordOrValidateCleanupProvenance,
} from "./delivery-cleanup-event-store.js";
import {
  deliveryCleanupOwnershipPayloadDigest,
  DeliveryCleanupOwnershipProvenanceV1,
} from "./delivery-cleanup-provenance.js";
import {
  coordinateBranchCleanup,
  coordinateWorktreeCleanup,
  CleanupResourceAdapterSchema,
  type CleanupResourceAdapter,
} from "./delivery-cleanup-resource-coordinator.js";
import {
  DeliveryMergeConclusivelyRejected,
  invokeGitHubDeliveryMerge,
  RequiredCheckFactSchema,
  validateRequiredChecks,
  type RequiredCheckFact,
} from "./delivery-merge-provider.js";
import { requireExactReadyForReviewConfirmation } from "./delivery-ready-for-review-coordinator.js";
import { makeRuntimeError } from "./errors.js";
import { appendEvent, loadRun, readEvents } from "./event-store.js";
import { makeGitCleanupResourceAdapter } from "./git-cleanup-resource-adapter.js";
import type { GitHubCommandRunner } from "./github-publisher.js";
import { nodeGitHubCommandRunner } from "./github-publisher.js";
import { readGitHubPullRequest } from "./github-pull-request-provider.js";
import {
  makeRunPaths,
  type RunPaths,
  type RunStorageOptions,
  RuntimePathTextSchema,
} from "./paths.js";
import { withRunStoreLock } from "./run-store-lock.js";
import { observeWorkspaceStructuralDigest } from "./workspace-snapshot.js";

const DeliveryMergeMethodSchema = Schema.Literals([
  "merge",
  "rebase",
  "squash",
] as const);
const FreshMergeReviewDecisionSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(120))
);
const FreshMergeNonNegativeIntegerSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0))
);

export class FreshMergeState extends Schema.Class<FreshMergeState>(
  "FreshMergeState"
)({
  branchName: DeliveryBranchNamePublicSchema,
  checks: Schema.Array(RequiredCheckFactSchema),
  draft: Schema.Boolean,
  feedbackBlockers: FreshMergeNonNegativeIntegerSchema,
  headSha: DeliveryGitShaPublicSchema,
  mergeCommitSha: Schema.optionalKey(DeliveryGitShaPublicSchema),
  mergeability: Schema.Literals([
    "conflicting",
    "mergeable",
    "unknown",
  ] as const),
  mergedAt: Schema.optionalKey(DeliveryTimestampPublicSchema),
  prNumber: Schema.Int,
  prUrl: GitHubPullRequestUrlPublicSchema,
  repository: GitHubRepositoryPublicSchema,
  reviewDecision: Schema.optionalKey(FreshMergeReviewDecisionSchema),
  state: Schema.Literals(["closed", "merged", "open"] as const),
  supportedMethods: Schema.Array(DeliveryMergeMethodSchema),
  unresolvedActionableThreads: FreshMergeNonNegativeIntegerSchema,
}) {}

const FreshMergeTargetSchema = Schema.Struct({
  prNumber: Schema.Int,
  repository: GitHubRepositoryPublicSchema,
});

type FreshMergeTarget = typeof FreshMergeTargetSchema.Type;

type FreshMergeStateReader = (
  input: FreshMergeTarget
) => Effect.Effect<FreshMergeState, unknown>;

const FreshMergeStateReaderSchema = Schema.declare<FreshMergeStateReader>(
  (input): input is FreshMergeStateReader => typeof input === "function"
);

const GitHubCommandRunnerSchema = Schema.declare<GitHubCommandRunner>(
  (input): input is GitHubCommandRunner => typeof input === "function"
);

const DeliveryMergeCoordinatorOptionFieldsSchema = Schema.Struct({
  cleanupResourceAdapter: Schema.optionalKey(CleanupResourceAdapterSchema),
  commandRunner: Schema.optionalKey(GitHubCommandRunnerSchema),
  freshStateReader: Schema.optionalKey(FreshMergeStateReaderSchema),
  requiredCheckPolicy: Schema.optionalKey(DeliveryRequiredCheckPolicy),
});

type DeliveryMergeCoordinatorOptionFields =
  typeof DeliveryMergeCoordinatorOptionFieldsSchema.Type;

export type DeliveryMergeCoordinatorOptions = RunStorageOptions &
  DeliveryMergeCoordinatorOptionFields;

export function requiredCheckPolicyFromTrustPolicy(
  trust: DeliveryFeedbackTrustPolicyV1
) {
  const checks = trust.trustedChecks
    .map((check) => ({ ...check }))
    .sort((left, right) =>
      [left.repository, left.workflow, left.name, left.appSlug]
        .join("\0")
        .localeCompare(
          [right.repository, right.workflow, right.name, right.appSlug].join(
            "\0"
          )
        )
    );
  return DeliveryRequiredCheckPolicy.make({
    checks,
    requireApprovedReview: deliveryFeedbackRequiresApprovedReview(trust),
    version: 1,
  });
}

const GitHubMergeViewSchema = Schema.Struct({
  headRefName: DeliveryBranchNamePublicSchema,
  headRefOid: DeliveryGitShaPublicSchema,
  isDraft: Schema.Boolean,
  mergeable: Schema.Literals(["CONFLICTING", "MERGEABLE", "UNKNOWN"] as const),
  mergeCommit: Schema.NullOr(
    Schema.Struct({ oid: Schema.optionalKey(DeliveryGitShaPublicSchema) })
  ),
  mergedAt: Schema.NullOr(DeliveryTimestampPublicSchema),
  reviewDecision: Schema.optionalKey(
    Schema.NullOr(FreshMergeReviewDecisionSchema)
  ),
  state: Schema.Literals(["CLOSED", "MERGED", "OPEN"] as const),
  url: GitHubPullRequestUrlPublicSchema,
});

const GitHubMergeCapabilitySchema = Schema.Struct({
  mergeCommitAllowed: Schema.Boolean,
  rebaseMergeAllowed: Schema.Boolean,
  squashMergeAllowed: Schema.Boolean,
});

const GitHubFreshMergeStateReaderInputSchema = Schema.Struct({
  commandRunner: Schema.optionalKey(GitHubCommandRunnerSchema),
  rootDirectory: RuntimePathTextSchema,
  trustPolicy: DeliveryFeedbackTrustPolicyV1,
});

export function makeGitHubFreshMergeStateReader(
  input: typeof GitHubFreshMergeStateReaderInputSchema.Type
) {
  return (target: FreshMergeTarget) =>
    Effect.gen(function* () {
      const commandRunner = input.commandRunner ?? nodeGitHubCommandRunner;
      const read = yield* readGitHubPullRequest({
        commandRunner,
        prNumber: target.prNumber,
        repository: target.repository,
        rootDirectory: input.rootDirectory,
        trustPolicy: input.trustPolicy,
      });
      const view = yield* commandRunner({
        args: [
          "pr",
          "view",
          String(target.prNumber),
          "--repo",
          target.repository,
          "--json",
          "headRefName,headRefOid,isDraft,mergeable,reviewDecision,state,mergedAt,mergeCommit,url",
        ],
        command: "gh",
        cwd: input.rootDirectory,
      });
      const repo = yield* commandRunner({
        args: [
          "repo",
          "view",
          target.repository,
          "--json",
          "mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed",
        ],
        command: "gh",
        cwd: input.rootDirectory,
      });
      if (view.exitCode !== 0 || repo.exitCode !== 0)
        return yield* Effect.fail(
          makeRuntimeError({
            code: "DeliveryMergeReadFailed",
            message: "GitHub merge state is unavailable.",
            recoverable: true,
          })
        );
      const detail = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(GitHubMergeViewSchema)(
            JSON.parse(view.stdout)
          ),
        catch: (cause) =>
          makeRuntimeError({
            cause,
            code: "DeliveryMergeReadInvalid",
            message: "GitHub merge state did not match Gaia's schema.",
            recoverable: true,
          }),
      });
      const capability = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(GitHubMergeCapabilitySchema)(
            JSON.parse(repo.stdout)
          ),
        catch: (cause) =>
          makeRuntimeError({
            cause,
            code: "DeliveryMergeCapabilityInvalid",
            message:
              "GitHub repository merge capability output did not match Gaia's schema.",
            recoverable: true,
          }),
      });
      const methods = [
        ...(capability.mergeCommitAllowed ? ["merge" as const] : []),
        ...(capability.rebaseMergeAllowed ? ["rebase" as const] : []),
        ...(capability.squashMergeAllowed ? ["squash" as const] : []),
      ];
      const reviewDecision = normalizeGitHubReviewDecision(
        detail.reviewDecision
      );
      return FreshMergeState.make({
        branchName: detail.headRefName,
        checks: read.observation.checks.map((check) => ({
          appSlug: check.appSlug,
          headSha: read.observation.headSha,
          name: check.name,
          repository: target.repository,
          state:
            check.state === "passing"
              ? "passing"
              : check.state === "pending"
                ? "pending"
                : "failed",
          workflow: check.workflow,
        })),
        draft: detail.isDraft,
        feedbackBlockers: read.observation.blockers.length,
        headSha: detail.headRefOid,
        ...(detail.mergeCommit?.oid === undefined
          ? {}
          : { mergeCommitSha: detail.mergeCommit.oid }),
        mergeability:
          detail.mergeable === "MERGEABLE"
            ? "mergeable"
            : detail.mergeable === "CONFLICTING"
              ? "conflicting"
              : "unknown",
        ...(detail.mergedAt == null ? {} : { mergedAt: detail.mergedAt }),
        prNumber: target.prNumber,
        prUrl: detail.url,
        repository: target.repository,
        ...(reviewDecision === undefined ? {} : { reviewDecision }),
        state:
          detail.state === "OPEN"
            ? "open"
            : detail.state === "MERGED"
              ? "merged"
              : "closed",
        supportedMethods: methods,
        unresolvedActionableThreads: read.observation.feedback.filter(
          (item) =>
            item.kind === "thread" && item.classification === "actionable"
        ).length,
      });
    });
}

/** GitHub represents an absent aggregate review decision as either null or an empty string. */
const GitHubReviewDecisionInputSchema = Schema.UndefinedOr(
  Schema.NullOr(FreshMergeReviewDecisionSchema)
);

export function normalizeGitHubReviewDecision(
  value: typeof GitHubReviewDecisionInputSchema.Type
) {
  return value == null || value === "" ? undefined : value;
}

const MergeReviewApprovalPublicationSchema = Schema.declare<
  Parameters<typeof currentDeliveryLocalReviewAttestation>[1]["publication"]
>(
  (
    input
  ): input is Parameters<
    typeof currentDeliveryLocalReviewAttestation
  >[1]["publication"] => typeof input === "object" && input !== null
);

const ReviewApprovalSourceInputSchema = Schema.Struct({
  publication: MergeReviewApprovalPublicationSchema,
  repository: GitHubRepositoryPublicSchema,
  runId: RunIdSchema,
});

const MergeHashInputSchema = Schema.String;

export function coordinateDeliveryMerge(
  runId: RunId,
  action: DeliveryMergeActionRequest,
  options: DeliveryMergeCoordinatorOptions
) {
  return withRunStoreLock(
    options,
    Effect.gen(function* () {
      const paths = yield* makeRunPaths(runId, options);
      const events = yield* readEvents(paths).pipe(
        Effect.catchCause(() =>
          conflict("Delivery history is invalid for the current run authority.")
        )
      );
      const delivery = Schema.decodeUnknownSync(
        Schema.Record(Schema.String, Schema.Json)
      )(snapshotFromReplay(events).context["delivery"]);
      const publication = parseDeliveryPublication(delivery["publication"]);
      if (publication.state !== "confirmed")
        return yield* conflict("Owned pull request is not confirmed.");
      const authoritativeHeadSha = deriveAuthoritativeDeliveryHeadSha(
        publication,
        events
      );
      const repository = repositoryFromPrUrl(publication.prUrl);
      if (
        action.expectedBranchName !== publication.branchName ||
        action.expectedHeadSha !== authoritativeHeadSha ||
        action.expectedPrUrl !== publication.prUrl
      )
        return yield* conflict(
          "Merge action does not match the authoritative current pull-request head."
        );
      requireExactReadyForReviewConfirmation(events, {
        branchName: publication.branchName,
        expectedHeadSha: authoritativeHeadSha,
        prNumber: publication.prNumber,
        prUrl: publication.prUrl,
        publicationOperationId: publication.operationId,
        publicationPayloadDigest: publication.payloadDigest,
        repository,
        runId,
      });
      const histories = deriveDeliveryActionHistoriesFromEvents(events);
      const previous = histories.merge.latest?.latest;
      const trust = Schema.decodeUnknownSync(DeliveryFeedbackTrustPolicyV1)(
        delivery["feedbackTrustPolicy"]
      );
      const policy = requiredCheckPolicyFromTrustPolicy(trust);
      const stateReader =
        options.freshStateReader ??
        makeGitHubFreshMergeStateReader({
          ...(options.commandRunner === undefined
            ? {}
            : { commandRunner: options.commandRunner }),
          rootDirectory: options.rootDirectory ?? ".",
          trustPolicy: trust,
        });
      if (
        options.requiredCheckPolicy !== undefined &&
        deliveryRequiredCheckPolicyCanonicalPayload(
          options.requiredCheckPolicy
        ) !== deliveryRequiredCheckPolicyCanonicalPayload(policy)
      )
        return yield* conflict(
          "Process required-check policy drifted from persisted run authority."
        );
      const policyDigest = hash(
        deliveryRequiredCheckPolicyCanonicalPayload(policy)
      );
      if (action.expectedPolicyDigest !== policyDigest)
        return yield* conflict("Required-check policy changed.");
      const binding = {
        actionId: action.actionId,
        branchName: publication.branchName,
        decisionSequence: action.expectedDecisionSequence,
        expectedHeadSha: action.expectedHeadSha,
        mergeMethod: action.mergeMethod,
        payloadDigest: hash(
          [
            action.actionId,
            runId,
            publication.prUrl,
            action.expectedBranchName,
            action.expectedHeadSha,
            String(action.expectedDecisionSequence),
            action.mergeMethod,
            policyDigest,
          ].join("\0")
        ),
        policyDigest,
        policyVersion: 1 as const,
        prNumber: publication.prNumber,
        prUrl: publication.prUrl,
        repository,
      };
      const readinessEvents = events.filter(
        ({ type }) => type === "DELIVERY_MERGE_READINESS_RECORDED"
      );
      const decisionEvent = readinessEvents.at(-1);
      if (decisionEvent?.sequence !== action.expectedDecisionSequence) {
        return yield* conflict(
          "The merge action does not target the latest readiness decision."
        );
      }
      if (decisionEvent?.type !== "DELIVERY_MERGE_READINESS_RECORDED") {
        return yield* conflict(
          "The authoritative readiness decision is missing or stale."
        );
      }
      const decision = parseDeliveryMergeReadinessDecision(
        decisionEvent.payload["decision"]
      );
      if (!(decision instanceof DeliveryMergeReadinessDecisionV3))
        return yield* conflict(
          "Legacy merge readiness decisions are decode-only and cannot authorize merge dispatch."
        );
      const currentAuthority = deriveDeliveryAuthority(publication, events);
      if (
        decision.runId !== runId ||
        decision.publicationOperationId !== publication.operationId ||
        decision.publicationPayloadDigest !== publication.payloadDigest ||
        decision.publicationConfirmationSequence !==
          currentAuthority.publicationConfirmationSequence ||
        decision.authoritySequence !== currentAuthority.authoritySequence ||
        decision.repository !== repository ||
        decision.headSha !== currentAuthority.headSha
      )
        return yield* conflict(
          "The readiness decision is stale for the current delivery authority."
        );
      const currentMergeDecisionEvent = events.findLast(
        (event) => event.type === "MERGE_DECISION_RECORDED"
      );
      if (
        currentMergeDecisionEvent?.sequence !==
          decision.mergeDecisionSequence ||
        currentMergeDecisionEvent.payload["decision"] === undefined ||
        parseMergeDecisionV2(currentMergeDecisionEvent.payload["decision"])
          .payloadDigest !== decision.mergeDecisionPayloadDigest
      )
        return yield* conflict(
          "The readiness decision is stale for the latest proof-bound merge decision."
        );
      const dispatchObserved = yield* observeWorkspaceStructuralDigest(
        paths.workspace
      );
      if (
        dispatchObserved.digest !== decision.proofBinding.observedTargetDigest
      )
        return yield* conflict(
          "The readiness decision proof is stale for the current workspace."
        );
      if (decision.approvalSource?.kind === "localOperatorPairedReview") {
        const currentAttestation = currentDeliveryLocalReviewAttestation(
          events,
          { publication, repository, runId }
        );
        if (
          currentAttestation?.latest.state !== "confirmed" ||
          currentAttestation.latest.actionId !==
            decision.approvalSource.attestationActionId ||
          currentAttestation.latest.attestationPayloadDigest !==
            decision.approvalSource.attestationPayloadDigest ||
          currentAttestation.latestSequence !==
            decision.approvalSource.attestationConfirmationSequence
        )
          return yield* conflict(
            "The readiness decision local approval source is no longer current."
          );
      }
      const decisionDigest = hash(
        [
          decision.actionId,
          runId,
          decision.prUrl,
          decision.branchName,
          decision.mergeMethod,
          decision.policyDigest,
        ].join("\0")
      );
      if (
        !decision.approved ||
        (decision instanceof DeliveryMergeReadinessDecision
          ? decision.payloadDigest !== decisionDigest
          : false) ||
        decision.branchName !== binding.branchName ||
        decision.headSha !== binding.expectedHeadSha ||
        decision.mergeMethod !== binding.mergeMethod ||
        decision.policyDigest !== binding.policyDigest ||
        decision.policyVersion !== binding.policyVersion ||
        decision.prNumber !== binding.prNumber ||
        decision.prUrl !== binding.prUrl
      )
        return yield* conflict(
          "The merge action does not match the approved readiness decision."
        );
      if (previous !== undefined) {
        if (
          previous.state === "dispatchAttempted" ||
          previous.state === "outcomeUnknown"
        ) {
          assertSameBinding(previous, binding);
          return yield* reconcile(runId, paths, previous, {
            ...options,
            freshStateReader: stateReader,
          });
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
          if (binding.decisionSequence <= previous.decisionSequence)
            return yield* conflict(
              "A new merge action requires a newer readiness decision."
            );
        } else {
          assertSameBinding(previous, binding);
        }
      }
      const fresh = yield* stateReader({
        prNumber: publication.prNumber,
        repository,
      }).pipe(
        Effect.mapError(() =>
          makeRuntimeError({
            code: "DeliveryMergeReadFailed",
            message: "Fresh GitHub state could not be verified.",
            recoverable: true,
          })
        )
      );
      validateFresh(
        fresh,
        publication.branchName,
        action,
        policy,
        decision.approvalSource
      );
      const intent =
        previous?.state === "intentRecorded"
          ? previous
          : DeliveryMergeIntent.make({ ...binding, state: "intentRecorded" });
      if (previous?.state !== "intentRecorded")
        yield* appendMerge(runId, paths, intent);
      const attempted = DeliveryMergeDispatchAttempted.make({
        ...binding,
        state: "dispatchAttempted",
      });
      yield* appendMerge(runId, paths, attempted);
      yield* appendEvent(runId, paths, {
        payload: {
          checkpoint: {
            actionId: binding.actionId,
            payloadDigest: binding.payloadDigest,
            state: "attemptRecorded",
            version: 1,
          },
        },
        type: "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED",
      });
      // Ephemeral permission: only this uninterrupted stack that appended attempted invokes.
      const dispatch = yield* Effect.exit(
        invokeGitHubDeliveryMerge(
          {
            cwd: paths.workspace,
            expectedHeadSha: action.expectedHeadSha,
            method: action.mergeMethod,
            prUrl: publication.prUrl,
            repository,
          },
          options.commandRunner
        )
      );
      if (dispatch._tag === "Failure") {
        const failure = Option.getOrUndefined(
          Cause.findErrorOption(dispatch.cause)
        );
        const rejected =
          failure instanceof DeliveryMergeConclusivelyRejected
            ? failure
            : undefined;
        const terminal = DeliveryMergeTerminalFailure.make({
          ...binding,
          code:
            rejected === undefined
              ? "DeliveryMergeOutcomeUnknown"
              : "DeliveryMergeRejected",
          message:
            rejected === undefined
              ? "Provider invocation may have been accepted; reconciliation is required."
              : rejected.message,
          state: rejected === undefined ? "outcomeUnknown" : "dispatchFailed",
        });
        yield* appendMerge(runId, paths, terminal);
        return terminal;
      }
      return yield* reconcile(runId, paths, attempted, {
        ...options,
        freshStateReader: stateReader,
      });
    }),
    {
      operation: "Gaia exact-head merge action",
      nextSafeAction:
        "Refresh delivery state; replayed attempts reconcile without redispatch.",
    }
  );
}

export function coordinateDeliveryMergeReadiness(
  runId: RunId,
  action: DeliveryEvaluateMergeReadinessActionRequest,
  options: DeliveryMergeCoordinatorOptions
) {
  return withRunStoreLock(
    options,
    Effect.gen(function* () {
      const paths = yield* makeRunPaths(runId, options);
      const events = yield* readEvents(paths).pipe(
        Effect.catchCause(() =>
          conflict("Delivery history is invalid for the current run authority.")
        )
      );
      const replay = snapshotFromReplay(events);
      if (replay.state !== "delivering")
        return yield* conflict(
          "Merge readiness requires a delivering pull-request run."
        );
      const delivery = Schema.decodeUnknownSync(
        Schema.Record(Schema.String, Schema.Json)
      )(replay.context["delivery"]);
      const publicationValue = delivery["publication"];
      if (publicationValue === undefined)
        return yield* conflict(
          "Merge readiness requires a confirmed owned pull request."
        );
      const publication = parseDeliveryPublication(publicationValue);
      if (publication.state !== "confirmed")
        return yield* conflict(
          "Merge readiness requires a confirmed owned pull request."
        );
      const authority = deriveDeliveryAuthority(publication, events);
      const authoritativeHeadSha = authority.headSha;
      const trust = Schema.decodeUnknownSync(DeliveryFeedbackTrustPolicyV1)(
        delivery["feedbackTrustPolicy"]
      );
      const policy = requiredCheckPolicyFromTrustPolicy(trust);
      const policyDigest = hash(
        deliveryRequiredCheckPolicyCanonicalPayload(policy)
      );
      const repository = repositoryFromPrUrl(publication.prUrl);
      const mergeDecisionEvent = events.findLast(
        (event) => event.type === "MERGE_DECISION_RECORDED"
      );
      if (mergeDecisionEvent === undefined)
        return yield* conflict(
          "Merge readiness requires a current proof-bound MergeDecisionV2."
        );
      const mergeDecision = yield* Effect.try({
        try: () => parseMergeDecisionV2(mergeDecisionEvent.payload["decision"]),
        catch: () =>
          makeRuntimeError({
            code: "DeliveryMergeDecisionInvalid",
            message: "Latest merge decision is legacy, invalid, or stale.",
            recoverable: false,
          }),
      });
      if (
        mergeDecision.status !== "approved" ||
        mergeDecision.nextAction !== "ready-to-merge" ||
        mergeDecision.proofBinding === undefined
      )
        return yield* conflict(
          "Merge readiness requires an approved proof-bound MergeDecisionV2."
        );
      const proof = Schema.decodeUnknownOption(RunProofProjectionV1Schema)(
        replay.context["runProof"]
      );
      const proofResult =
        Option.isSome(proof) && proof.value.kind === "contract"
          ? proof.value.latestResult
          : undefined;
      const contentAuthoritySequence = Math.max(
        1,
        ...events
          .filter(
            ({ type }) =>
              type === "WORKER_COMPLETED" ||
              type === "DELIVERY_REMEDIATION_RECORDED"
          )
          .map(({ sequence }) => sequence)
      );
      const evidenceReviewSequence = events.findLast(
        ({ payload, type }) =>
          type === "REVIEW_COMPLETED" && payload["phase"] === "evidence"
      )?.sequence;
      const observed = yield* observeWorkspaceStructuralDigest(paths.workspace);
      if (
        proofResult?.aggregate !== "verified" ||
        proofResult.observedTargetDigest !== observed.digest ||
        mergeDecision.contentAuthoritySequence !== contentAuthoritySequence ||
        mergeDecision.evidenceReviewSequence !== evidenceReviewSequence ||
        evidenceReviewSequence === undefined ||
        evidenceReviewSequence <= proofResult.recordedBy.sequence ||
        mergeDecision.publicationConfirmationSequence !==
          authority.publicationConfirmationSequence ||
        mergeDecision.proofBinding.contractId !== proofResult.contractId ||
        mergeDecision.proofBinding.contractDigest !==
          proofResult.contractDigest ||
        mergeDecision.proofBinding.proofResultDigest !==
          proofResult.resultDigest ||
        mergeDecision.proofBinding.proofResultSequence !==
          proofResult.recordedBy.sequence ||
        mergeDecision.proofBinding.observedTargetDigest !==
          proofResult.observedTargetDigest
      )
        return yield* conflict(
          "MergeDecisionV2 is stale for the current proof, content, review, or publication authority."
        );
      const prior = events
        .filter(({ type }) => type === "DELIVERY_MERGE_READINESS_RECORDED")
        .map((event) =>
          parseDeliveryMergeReadinessDecision(event.payload["decision"])
        )
        .find((decision) => decision.actionId === action.actionId);
      if (prior !== undefined) {
        if (!(prior instanceof DeliveryMergeReadinessDecisionV3))
          return yield* conflict(
            "Legacy merge readiness decisions are decode-only and fail closed."
          );
        if (
          prior.runId !== runId ||
          prior.publicationOperationId !== publication.operationId ||
          prior.publicationPayloadDigest !== publication.payloadDigest ||
          prior.publicationConfirmationSequence !==
            authority.publicationConfirmationSequence ||
          prior.authoritySequence !== authority.authoritySequence ||
          prior.repository !== repository ||
          prior.prNumber !== publication.prNumber ||
          prior.prUrl !== publication.prUrl ||
          prior.branchName !== publication.branchName ||
          prior.mergeMethod !== action.mergeMethod ||
          prior.policyDigest !== policyDigest ||
          prior.mergeDecisionSequence !== mergeDecisionEvent.sequence ||
          prior.mergeDecisionPayloadDigest !== mergeDecision.payloadDigest ||
          prior.proofBinding.contractId !==
            mergeDecision.proofBinding.contractId ||
          prior.proofBinding.contractDigest !==
            mergeDecision.proofBinding.contractDigest ||
          prior.proofBinding.proofResultDigest !==
            mergeDecision.proofBinding.proofResultDigest ||
          prior.proofBinding.proofResultSequence !==
            mergeDecision.proofBinding.proofResultSequence ||
          prior.proofBinding.observedTargetDigest !==
            mergeDecision.proofBinding.observedTargetDigest
        )
          return yield* conflict(
            "Readiness action ID conflicts with a changed immutable tuple."
          );
        if (prior.headSha !== authoritativeHeadSha)
          return yield* conflict(
            "The prior readiness decision does not target the authoritative current head."
          );
        requireExactReadyForReviewConfirmation(events, {
          branchName: publication.branchName,
          expectedHeadSha: authoritativeHeadSha,
          prNumber: publication.prNumber,
          prUrl: publication.prUrl,
          publicationOperationId: publication.operationId,
          publicationPayloadDigest: publication.payloadDigest,
          repository,
          runId,
        });
        return prior;
      }
      requireExactReadyForReviewConfirmation(events, {
        branchName: publication.branchName,
        expectedHeadSha: authoritativeHeadSha,
        prNumber: publication.prNumber,
        prUrl: publication.prUrl,
        publicationOperationId: publication.operationId,
        publicationPayloadDigest: publication.payloadDigest,
        repository,
        runId,
      });
      const reader =
        options.freshStateReader ??
        makeGitHubFreshMergeStateReader({
          ...(options.commandRunner === undefined
            ? {}
            : { commandRunner: options.commandRunner }),
          rootDirectory: options.rootDirectory ?? ".",
          trustPolicy: trust,
        });
      const fresh = yield* reader({
        prNumber: publication.prNumber,
        repository,
      }).pipe(
        Effect.mapError(() =>
          makeRuntimeError({
            code: "DeliveryMergeReadFailed",
            message: "Fresh GitHub readiness evidence is unavailable.",
            recoverable: true,
          })
        )
      );
      if (
        fresh.branchName !== publication.branchName ||
        fresh.headSha !== authoritativeHeadSha ||
        fresh.prNumber !== publication.prNumber ||
        fresh.prUrl !== publication.prUrl ||
        fresh.repository !== repository
      )
        return yield* conflict(
          "Fresh readiness evidence does not match the authoritative current pull-request head."
        );
      const approvalSource = resolveReviewApprovalSource(
        fresh,
        policy,
        events,
        { publication, repository, runId }
      );
      const blockers = freshBlockers(
        fresh,
        publication.branchName,
        action.mergeMethod,
        policy,
        approvalSource
      );
      const decisionBase = {
        actionId: action.actionId,
        approved: blockers.length === 0,
        ...(blockers.length === 0 && approvalSource !== undefined
          ? { approvalSource }
          : {}),
        authoritySequence: authority.authoritySequence,
        blockers,
        branchName: publication.branchName,
        headSha: fresh.headSha,
        mergeMethod: action.mergeMethod,
        policyDigest,
        policyVersion: 1 as const,
        prNumber: publication.prNumber,
        prUrl: publication.prUrl,
        publicationConfirmationSequence:
          authority.publicationConfirmationSequence,
        publicationOperationId: publication.operationId,
        publicationPayloadDigest: publication.payloadDigest,
        repository,
        runId,
        mergeDecisionPayloadDigest: mergeDecision.payloadDigest,
        mergeDecisionSequence: mergeDecisionEvent.sequence,
        proofBinding: mergeDecision.proofBinding,
        version: 3 as const,
      };
      const decision = DeliveryMergeReadinessDecisionV3.make({
        ...decisionBase,
        payloadDigest:
          deliveryMergeReadinessDecisionV3PayloadDigest(decisionBase),
      });
      yield* appendEvent(runId, paths, {
        payload: {
          decision: encodeDeliveryMergeReadinessDecisionJson(decision),
        },
        type: "DELIVERY_MERGE_READINESS_RECORDED",
      });
      return decision;
    }),
    {
      operation: "Gaia merge readiness decision",
      nextSafeAction:
        "Refresh the latest readiness decision before any merge action.",
    }
  );
}

export function coordinateDeliveryCleanup(
  runId: RunId,
  action: DeliveryRetryCleanupActionRequest,
  options: DeliveryMergeCoordinatorOptions
) {
  return withRunStoreLock(
    options,
    Effect.gen(function* () {
      const paths = yield* makeRunPaths(runId, options);
      const loaded = yield* loadRun(paths);
      const histories = deriveDeliveryActionHistoriesFromEvents(loaded.events);
      const merge = histories.merge.latest?.latest;
      if (merge === undefined)
        return yield* conflict("Confirmed merge history is unavailable.");
      if (
        merge.state !== "dispatchConfirmed" ||
        merge.mergeCommitSha !== action.expectedMergeCommitSha
      )
        return yield* conflict(
          "Cleanup action does not match the confirmed merge receipt."
        );
      const ownershipDigest = hash(
        [
          runId,
          merge.branchName,
          merge.expectedHeadSha,
          merge.mergeCommitSha,
        ].join("\0")
      );
      const fs = yield* FileSystem.FileSystem;
      const manifest = Schema.decodeUnknownSync(
        Schema.Struct({
          repositoryCommonDir: Schema.NonEmptyString,
          repositoryRoot: Schema.NonEmptyString,
          token: Schema.NonEmptyString,
          version: Schema.Literal(1),
          workspaceCommonDir: Schema.NonEmptyString,
          workspaceRoot: Schema.NonEmptyString,
        })
      )(JSON.parse(yield* fs.readFileString(paths.deliveryOwnershipManifest)));
      const provenanceBase = {
        actionId: action.actionId,
        branchRef: `refs/heads/${merge.branchName}`,
        expectedBranchOid: merge.expectedHeadSha,
        mergeCommitSha: merge.mergeCommitSha,
        ownershipDigest,
        ownershipToken: manifest.token,
        repositoryCommonDir: manifest.repositoryCommonDir,
        repositoryRoot: manifest.repositoryRoot,
        runId,
        version: 1 as const,
        worktreeCommonDir: manifest.workspaceCommonDir,
        worktreePath: manifest.workspaceRoot,
      };
      const provenance = DeliveryCleanupOwnershipProvenanceV1.make({
        ...provenanceBase,
        payloadDigest: deliveryCleanupOwnershipPayloadDigest(provenanceBase),
      });
      yield* recordOrValidateCleanupProvenance(runId, paths, provenance);
      const checkpointStore = makeEventCleanupCheckpointStore(runId, paths);
      const adapter =
        options.cleanupResourceAdapter ?? makeGitCleanupResourceAdapter();
      const worktreeResult = yield* Effect.exit(
        coordinateWorktreeCleanup({ adapter, checkpointStore, provenance })
      );
      const branchResult =
        worktreeResult._tag === "Success"
          ? yield* Effect.exit(
              coordinateBranchCleanup({ adapter, checkpointStore, provenance })
            )
          : undefined;
      if (
        worktreeResult._tag === "Failure" ||
        branchResult?._tag === "Failure"
      ) {
        const checkpoints = yield* checkpointStore.read();
        const absent = (resource: "branch" | "worktree") =>
          checkpoints.some(
            (checkpoint) =>
              checkpoint.resource === resource &&
              checkpoint.state === "absenceProven"
          );
        const partial = DeliveryCleanupRequired.make({
          actionId: action.actionId,
          branch: absent("branch") ? "absent" : "present",
          branchName: merge.branchName,
          mergeCommitSha: merge.mergeCommitSha,
          ownershipDigest,
          state: "cleanupRequired",
          worktree: absent("worktree") ? "absent" : "present",
        });
        yield* appendEvent(runId, paths, {
          payload: { cleanup: encodeDeliveryCleanupReceiptJson(partial) },
          type: "DELIVERY_CLEANUP_RECORDED",
        });
        if (worktreeResult._tag === "Failure")
          return yield* Effect.fail(worktreeResult.cause);
        if (branchResult?._tag === "Failure")
          return yield* Effect.fail(branchResult.cause);
        return yield* Effect.die("Unreachable cleanup failure state.");
      }
      const completed = DeliveryCleanupCompleted.make({
        actionId: action.actionId,
        branch: "absent",
        branchName: merge.branchName,
        mergeCommitSha: merge.mergeCommitSha,
        ownershipDigest,
        state: "completed",
        worktree: "absent",
      });
      yield* appendEvent(runId, paths, {
        payload: { cleanup: encodeDeliveryCleanupReceiptJson(completed) },
        type: "DELIVERY_CLEANUP_RECORDED",
      });
      return completed;
    }),
    {
      operation: "Gaia owned delivery cleanup",
      nextSafeAction:
        "Refresh cleanup state and retry only the exact remaining owned resource.",
    }
  );
}

function reconcile(
  runId: RunId,
  paths: RunPaths,
  previous: DeliveryMergeReceipt,
  options: DeliveryMergeCoordinatorOptions
) {
  return Effect.gen(function* () {
    const fresh = yield* options.freshStateReader!({
      prNumber: previous.prNumber,
      repository: previous.repository,
    }).pipe(
      Effect.mapError(() =>
        makeRuntimeError({
          code: "DeliveryMergeReconciliationFailed",
          message: "Merge outcome remains unknown.",
          recoverable: true,
        })
      )
    );
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
      const confirmed = DeliveryMergeDispatchConfirmed.make({
        ...previous,
        mergeCommitSha: fresh.mergeCommitSha,
        mergedAt: fresh.mergedAt,
        state: "dispatchConfirmed",
      });
      yield* appendMerge(runId, paths, confirmed);
      return confirmed;
    }
    const unknown = DeliveryMergeTerminalFailure.make({
      ...previous,
      code: "DeliveryMergeOutcomeUnknown",
      message: "GitHub does not yet prove the exact merge receipt.",
      state: "outcomeUnknown",
    });
    if (previous.state !== "outcomeUnknown")
      yield* appendMerge(runId, paths, unknown);
    return unknown;
  });
}

function appendMerge(
  runId: RunId,
  paths: RunPaths,
  receipt: DeliveryMergeReceipt
) {
  return appendEvent(runId, paths, {
    payload: { mergeAction: encodeDeliveryMergeReceiptJson(receipt) },
    type: "DELIVERY_MERGE_RECORDED",
  });
}
function validateFresh(
  fresh: FreshMergeState,
  branch: typeof DeliveryBranchNamePublicSchema.Type,
  action: DeliveryMergeActionRequest,
  policy: typeof DeliveryRequiredCheckPolicy.Type,
  approvalSource?: DeliveryReviewApprovalSource
) {
  if (
    fresh.prUrl !== action.expectedPrUrl ||
    fresh.headSha !== action.expectedHeadSha ||
    freshBlockers(fresh, branch, action.mergeMethod, policy, approvalSource)
      .length > 0
  )
    throw makeRuntimeError({
      code: "DeliveryMergePreconditionFailed",
      message:
        "Fresh GitHub state does not satisfy the approved exact-head decision.",
      recoverable: true,
    });
}
function freshBlockers(
  fresh: FreshMergeState,
  branch: typeof DeliveryBranchNamePublicSchema.Type,
  method: typeof DeliveryMergeMethodSchema.Type,
  policy: typeof DeliveryRequiredCheckPolicy.Type,
  approvalSource?: DeliveryReviewApprovalSource
) {
  const blockers: string[] = [];
  if (fresh.branchName !== branch) blockers.push("Owned branch changed.");
  if (
    fresh.state !== "open" ||
    fresh.mergedAt !== undefined ||
    fresh.mergeCommitSha !== undefined
  )
    blockers.push("Pull request is not open and unmerged.");
  if (fresh.draft) blockers.push("Pull request is draft.");
  if (!fresh.supportedMethods.includes(method))
    blockers.push("Selected merge method is unavailable.");
  if (fresh.mergeability !== "mergeable")
    blockers.push("Mergeability is not mergeable.");
  if (fresh.unresolvedActionableThreads !== 0)
    blockers.push("Actionable review threads remain unresolved.");
  if (fresh.feedbackBlockers !== 0)
    blockers.push("Trusted feedback evaluation remains blocked or ambiguous.");
  if (fresh.reviewDecision === "CHANGES_REQUESTED")
    blockers.push("Review changes are requested.");
  else if (
    fresh.reviewDecision !== undefined &&
    fresh.reviewDecision !== "APPROVED" &&
    fresh.reviewDecision !== "REVIEW_REQUIRED"
  )
    blockers.push("Review state is ambiguous or unsupported.");
  else if (
    policy.requireApprovedReview &&
    fresh.reviewDecision !== "APPROVED" &&
    approvalSource?.kind !== "localOperatorPairedReview"
  )
    blockers.push("Required review approval is absent.");
  if (!validateRequiredChecks(policy.checks, fresh.checks, fresh.headSha))
    blockers.push("Required checks are incomplete or unsuccessful.");
  return blockers;
}

function resolveReviewApprovalSource(
  fresh: FreshMergeState,
  policy: typeof DeliveryRequiredCheckPolicy.Type,
  events: Parameters<typeof currentDeliveryLocalReviewAttestation>[0],
  input: typeof ReviewApprovalSourceInputSchema.Type
): DeliveryReviewApprovalSource | undefined {
  if (fresh.reviewDecision === "CHANGES_REQUESTED") return undefined;
  if (fresh.reviewDecision === "APPROVED") {
    return DeliveryGitHubApprovedReviewSource.make({
      kind: "githubApproved",
      reviewDecision: "APPROVED",
      version: 1,
    });
  }
  if (
    fresh.reviewDecision !== undefined &&
    fresh.reviewDecision !== "REVIEW_REQUIRED"
  )
    return undefined;
  if (!policy.requireApprovedReview)
    return DeliveryReviewApprovalNotRequiredSource.make({
      kind: "notRequired",
      version: 1,
    });
  const attestation = currentDeliveryLocalReviewAttestation(events, input);
  if (attestation?.latest.state !== "confirmed") return undefined;
  return DeliveryLocalOperatorReviewSource.make({
    attestationActionId: attestation.latest.actionId,
    attestationConfirmationSequence: attestation.latestSequence,
    attestationPayloadDigest: attestation.latest.attestationPayloadDigest,
    authoritySequence: attestation.latest.authoritySequence,
    ...(attestation.latest.gaiaEvidenceDigest === undefined
      ? {}
      : { gaiaEvidenceDigest: attestation.latest.gaiaEvidenceDigest }),
    gaiaEvidenceId: attestation.latest.gaiaEvidenceId,
    headSha: attestation.latest.headSha,
    kind: "localOperatorPairedReview",
    version: 1,
  });
}
function assertSameBinding(
  previous: DeliveryMergeReceipt,
  binding: Omit<DeliveryMergeReceipt, "state">
) {
  if (
    previous.actionId !== binding.actionId ||
    previous.payloadDigest !== binding.payloadDigest
  )
    throw makeRuntimeError({
      code: "DeliveryActionConflict",
      message: "Merge action ID conflicts with a different immutable tuple.",
      recoverable: true,
    });
}
function repositoryFromPrUrl(
  url: typeof GitHubPullRequestUrlPublicSchema.Type
) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//u.exec(url);
  if (match?.[1] === undefined) throw new Error("Invalid owned PR URL.");
  return Schema.decodeUnknownSync(GitHubRepositoryPublicSchema)(match[1]);
}
function hash(value: typeof MergeHashInputSchema.Type) {
  return createHash("sha256").update(value).digest("hex");
}
function conflict(message: string) {
  return Effect.fail(
    makeRuntimeError({
      code: "DeliveryActionConflict",
      message,
      recoverable: true,
    })
  );
}
