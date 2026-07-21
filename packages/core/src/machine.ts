import * as Schema from "effect/Schema";
import { assign, createActor, setup } from "xstate";

import {
  DeliveryCleanupReceiptSchema,
  encodeDeliveryCleanupReceiptJson,
  encodeDeliveryMergeReceiptJson,
  parseDeliveryCleanupReceipt,
  parseDeliveryMergeReceipt,
  parseDeliveryMergeReadinessDecision,
  encodeDeliveryMergeReadinessDecisionJson,
  type DeliveryMergeReceipt,
  DeliveryMergeReadinessDecisionSchema,
  DeliveryMergeReceiptSchema,
  deriveDeliveryMergeActionHistories,
  deriveDeliveryCleanupActionHistories,
  deriveDeliveryPullRequestReadyActionHistories,
  assertDeliveryPullRequestReadyAuthority,
  encodeDeliveryPullRequestReadyReceiptJson,
  parseDeliveryPullRequestReadyReceipt,
  type DeliveryPullRequestReadyReceipt,
  DeliveryPullRequestReadyReceiptSchema,
  deriveDeliveryLocalReviewAttestationHistories,
  assertDeliveryLocalReviewAttestationAuthority,
  assertDeliveryMergeReadinessDecisionAuthority,
  DeliveryMergeReadinessDecisionV2,
  DeliveryMergeReadinessDecisionV3,
  DeliveryLocalReviewAttestationReceiptSchema,
  parseDeliveryLocalReviewAttestationReceipt,
} from "./delivery-merge.js";
import {
  DeliveryPublicationSchema,
  encodeDeliveryPublicationJson,
  parseDeliveryPublication,
  type DeliveryPublication,
} from "./delivery-publication.js";
import {
  DeliveryPullRequestObservation,
  DeliveryRemediationSchema,
  encodeDeliveryPullRequestObservationJson,
  encodeDeliveryRemediationJson,
  deriveAuthoritativeDeliveryHeadSha,
  parseDeliveryPullRequestObservation,
  parseDeliveryRemediation,
  validateDeliveryRemediationTransition,
  type DeliveryRemediation,
} from "./delivery-remediation.js";
import {
  FailureStageSchema,
  GaiaFailure,
  ReviewPhaseSchema,
  type RunEvent,
  RunSnapshot,
  type RunState,
  RunStateSchema,
} from "./events.js";
import {
  parseMergeDecisionV2,
  type MergeDecisionV2,
} from "./merge-decision.js";
import {
  parseAnyRunContract,
  parseAnyRunProofResult,
  parseAnyRunProofResultEnvelope,
  RunContractSchema,
  RunProofProjectionSchema,
  RunProofResultSchema,
  type RunContract,
  type RunProofResult,
} from "./run-contract-v2.js";
import {
  parseRunContract,
  parseRunEventSequence,
  parseRunProofResult,
  parseRunProofResultEnvelope,
  parseRunRelativeArtifactPath,
  ProofClaimIdSchema,
  RunContractDigestSchema,
  RunContractV1,
  RunEventSequenceSchema,
  RunProofResultV1,
} from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";
import {
  ClaimVerificationCommandStartV1,
  ClaimVerificationCreateIntentV1,
  ClaimVerificationGenerationStartedV1,
  ClaimVerificationReuseReceiptV1,
  ClaimVerificationSandboxCreatedV1,
  VerificationIdentityDigestSchema,
  VerificationReceiptDigestSchema,
  VerificationSourceKeySchema,
  makeVerificationCommandRequestDigest,
  parseVerificationCommandReceipt,
  parseVerificationReconciliationReceipt,
} from "./verification-command.js";
import {
  encodeWorkerContinuationReceiptJson,
  encodeWorkerCorrelationReconciliationReceiptJson,
  encodeWorkerDesktopOriginCorrelationReceiptJson,
  parseWorkerContinuationReceipt,
  parseWorkerCorrelationReconciliationReceipt,
  parseWorkerDesktopOriginCorrelationReceipt,
  parseWorkerRecoveryReceipt,
  workerContinuationProjection,
  workerCorrelationReconciliationProjection,
  workerDesktopOriginCorrelationProjection,
  type WorkerContinuationReceipt,
  WorkerContinuationReceiptSchema,
  type WorkerCorrelationReconciliationReceipt,
  WorkerCorrelationReconciliationReceiptSchema,
  type WorkerDesktopOriginCorrelationReceipt,
  WorkerDesktopOriginCorrelationReceiptSchema,
  type WorkerRecoveryReceipt,
  WorkerRecoveryReceiptSchema,
} from "./worker-recovery.js";

const RunMachinePathSchema = Schema.String.pipe(Schema.brand("RunMachinePath"));
const RunMachineUrlSchema = Schema.String.pipe(Schema.brand("RunMachineUrl"));
const RunMachineStatusSchema = Schema.String.pipe(
  Schema.brand("RunMachineStatus")
);
const RunMachineIdentifierSchema = Schema.String.pipe(
  Schema.brand("RunMachineIdentifier")
);
const RunMachineActionTextSchema = Schema.String.pipe(
  Schema.brand("RunMachineActionText")
);
const RunMachineDeliverySchema = Schema.Record(Schema.String, Schema.Json);
const DeliveryPullRequestReadyReplayActionsSchema = Schema.Array(
  Schema.Struct({
    receipt: DeliveryPullRequestReadyReceiptSchema,
    sequence: Schema.Number,
  })
).pipe(Schema.mutable);
const DeliveryLocalReviewAttestationReplayActionsSchema = Schema.Array(
  Schema.Struct({
    receipt: DeliveryLocalReviewAttestationReceiptSchema,
    sequence: Schema.Number,
  })
).pipe(Schema.mutable);
const DeliveryMergeReplayActionsSchema = Schema.Array(
  Schema.Struct({
    receipt: DeliveryMergeReceiptSchema,
    sequence: Schema.Number,
  })
).pipe(Schema.mutable);
const DeliveryCleanupReplayActionsSchema = Schema.Array(
  Schema.Struct({
    receipt: DeliveryCleanupReceiptSchema,
    sequence: Schema.Number,
  })
).pipe(Schema.mutable);

const ClaimVerificationReplayIdentitySchema = Schema.Struct({
  claimId: ProofClaimIdSchema,
  contractDigest: RunContractDigestSchema,
  executionEvidenceIdentityDigest: VerificationIdentityDigestSchema,
  generationSequence: RunEventSequenceSchema,
});
type ClaimVerificationReplayIdentity = Schema.Schema.Type<
  typeof ClaimVerificationReplayIdentitySchema
>;
const ClaimVerificationReplayStateSchema = Schema.Struct({
  ...ClaimVerificationReplayIdentitySchema.fields,
  commandStart: Schema.mutableKey(
    Schema.optionalKey(ClaimVerificationCommandStartV1)
  ),
  commandStartSequence: Schema.mutableKey(
    Schema.optionalKey(RunEventSequenceSchema)
  ),
  createIntent: Schema.mutableKey(
    Schema.optionalKey(ClaimVerificationCreateIntentV1)
  ),
  createIntentSequence: Schema.mutableKey(
    Schema.optionalKey(RunEventSequenceSchema)
  ),
  reconciliationSequence: Schema.mutableKey(
    Schema.optionalKey(RunEventSequenceSchema)
  ),
  receiptDigest: Schema.mutableKey(
    Schema.optionalKey(VerificationReceiptDigestSchema)
  ),
  sandboxCreated: Schema.mutableKey(
    Schema.optionalKey(ClaimVerificationSandboxCreatedV1)
  ),
  sandboxCreatedSequence: Schema.mutableKey(
    Schema.optionalKey(RunEventSequenceSchema)
  ),
  terminalSequence: Schema.mutableKey(
    Schema.optionalKey(RunEventSequenceSchema)
  ),
});
type ClaimVerificationReplayState = Schema.Schema.Type<
  typeof ClaimVerificationReplayStateSchema
>;

export const RunMachineContextSchema = Schema.Struct({
  browserEvidencePath: Schema.UndefinedOr(RunMachinePathSchema),
  browserEvidenceStatus: Schema.UndefinedOr(RunMachineStatusSchema),
  browserEvidenceTargetUrl: Schema.UndefinedOr(RunMachineUrlSchema),
  delivery: Schema.UndefinedOr(RunMachineDeliverySchema),
  evidenceReviewPath: Schema.UndefinedOr(RunMachinePathSchema),
  failure: Schema.UndefinedOr(GaiaFailure),
  githubChecksPath: Schema.UndefinedOr(RunMachinePathSchema),
  githubChecksStatus: Schema.UndefinedOr(RunMachineStatusSchema),
  githubFeedbackCommentCount: Schema.UndefinedOr(Schema.Number),
  githubFeedbackNextAction: Schema.UndefinedOr(RunMachineActionTextSchema),
  githubFeedbackPath: Schema.UndefinedOr(RunMachinePathSchema),
  githubFeedbackReviewCount: Schema.UndefinedOr(Schema.Number),
  githubFeedbackReviewRequestCount: Schema.UndefinedOr(Schema.Number),
  githubFeedbackStatus: Schema.UndefinedOr(RunMachineStatusSchema),
  githubPrCommentPath: Schema.UndefinedOr(RunMachinePathSchema),
  githubPrCommentUrl: Schema.UndefinedOr(RunMachineUrlSchema),
  githubPrLoopBlockerCount: Schema.UndefinedOr(Schema.Number),
  githubPrLoopNextAction: Schema.UndefinedOr(RunMachineActionTextSchema),
  githubPrLoopPath: Schema.UndefinedOr(RunMachinePathSchema),
  githubPrLoopStatus: Schema.UndefinedOr(RunMachineStatusSchema),
  githubPullRequest: Schema.UndefinedOr(RunMachineIdentifierSchema),
  githubRemediationBlockerCount: Schema.UndefinedOr(Schema.Number),
  githubRemediationNextAction: Schema.UndefinedOr(RunMachineActionTextSchema),
  githubRemediationSpecPath: Schema.UndefinedOr(RunMachinePathSchema),
  githubWatchStatePath: Schema.UndefinedOr(RunMachinePathSchema),
  lastEventSequence: Schema.Number,
  evidenceReviewerSessionPath: Schema.UndefinedOr(RunMachinePathSchema),
  linearBlockedByCount: Schema.UndefinedOr(Schema.Number),
  linearBlocksCount: Schema.UndefinedOr(Schema.Number),
  linearIssueGraphPath: Schema.UndefinedOr(RunMachinePathSchema),
  linearIssueIdentifier: Schema.UndefinedOr(RunMachineIdentifierSchema),
  linearIssueUrl: Schema.UndefinedOr(RunMachineUrlSchema),
  mergeDecisionBlockerCount: Schema.UndefinedOr(Schema.Number),
  mergeDecisionNextAction: Schema.UndefinedOr(RunMachineActionTextSchema),
  mergeDecisionPath: Schema.UndefinedOr(RunMachinePathSchema),
  mergeDecisionStatus: Schema.UndefinedOr(RunMachineStatusSchema),
  planReviewPath: Schema.UndefinedOr(RunMachinePathSchema),
  planReviewerSessionPath: Schema.UndefinedOr(RunMachinePathSchema),
  previewDeploymentPath: Schema.UndefinedOr(RunMachinePathSchema),
  previewDeploymentStatus: Schema.UndefinedOr(RunMachineStatusSchema),
  previewDeploymentUrl: Schema.UndefinedOr(RunMachineUrlSchema),
  reportPath: Schema.UndefinedOr(RunMachinePathSchema),
  runProof: Schema.UndefinedOr(RunProofProjectionSchema),
  runId: Schema.UndefinedOr(RunIdSchema),
  specPath: Schema.UndefinedOr(RunMachinePathSchema),
  verificationResultPath: Schema.UndefinedOr(RunMachinePathSchema),
  workerResultPath: Schema.UndefinedOr(RunMachinePathSchema),
  workspacePath: Schema.UndefinedOr(RunMachinePathSchema),
});

export const parseRunMachineContext = Schema.decodeUnknownSync(
  RunMachineContextSchema
);
export type RunMachineContext = ReturnType<typeof parseRunMachineContext>;

const DeliveryPublicationMachineEventTypeSchema = Schema.Union([
  Schema.Literal("DELIVERY_PUBLICATION_INTENT_RECORDED"),
  Schema.Literal("DELIVERY_PUBLICATION_ATTEMPTED"),
  Schema.Literal("DELIVERY_PUBLICATION_CONFIRMED"),
  Schema.Literal("DELIVERY_PUBLICATION_FAILED"),
  Schema.Literal("DELIVERY_PUBLICATION_OUTCOME_UNKNOWN"),
]);

const DeliveryCheckpointMachineEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("DELIVERY_CLEANUP_PROVENANCE_RECORDED"),
  }),
  Schema.Struct({
    type: Schema.Literal("DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED"),
  }),
  Schema.Struct({
    type: Schema.Literal("DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED"),
  }),
]);

export const RunMachineEventSchema = Schema.Union([
  Schema.Struct({
    runId: RunIdSchema,
    specPath: RunMachinePathSchema,
    type: Schema.Literal("RUN_CREATED"),
  }),
  Schema.Struct({
    contract: RunContractSchema,
    type: Schema.Literal("RUN_CONTRACT_RECORDED"),
  }),
  Schema.Struct({
    delivery: RunMachineDeliverySchema,
    type: Schema.Literal("DELIVERY_STARTED"),
  }),
  Schema.Struct({
    delivery: RunMachineDeliverySchema,
    reportPath: Schema.UndefinedOr(RunMachinePathSchema),
    type: Schema.Literal("DELIVERY_READY_TO_PUBLISH"),
  }),
  Schema.Struct({
    publication: DeliveryPublicationSchema,
    type: DeliveryPublicationMachineEventTypeSchema,
  }),
  Schema.Struct({
    eventSequence: Schema.Number,
    remediation: DeliveryRemediationSchema,
    type: Schema.Literal("DELIVERY_REMEDIATION_RECORDED"),
  }),
  Schema.Struct({
    readyForReviewAction: DeliveryPullRequestReadyReceiptSchema,
    type: Schema.Literal("DELIVERY_PR_READY_RECORDED"),
  }),
  Schema.Struct({
    attestation: DeliveryLocalReviewAttestationReceiptSchema,
    type: Schema.Literal("DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED"),
  }),
  Schema.Struct({
    mergeAction: DeliveryMergeReceiptSchema,
    type: Schema.Literal("DELIVERY_MERGE_RECORDED"),
  }),
  Schema.Struct({
    decision: DeliveryMergeReadinessDecisionSchema,
    eventSequence: Schema.Number,
    type: Schema.Literal("DELIVERY_MERGE_READINESS_RECORDED"),
  }),
  Schema.Struct({
    cleanup: DeliveryCleanupReceiptSchema,
    type: Schema.Literal("DELIVERY_CLEANUP_RECORDED"),
  }),
  DeliveryCheckpointMachineEventSchema,
  Schema.Struct({
    type: Schema.Literal("WORKSPACE_PREPARED"),
    workspacePath: RunMachinePathSchema,
  }),
  Schema.Struct({ type: Schema.Literal("REVIEW_STARTED") }),
  Schema.Struct({
    phase: ReviewPhaseSchema,
    reviewPath: RunMachinePathSchema,
    reviewerSessionEvidencePath: Schema.optionalKey(RunMachinePathSchema),
    type: Schema.Literal("REVIEW_COMPLETED"),
  }),
  Schema.Struct({ type: Schema.Literal("WORKER_STARTED") }),
  Schema.Struct({
    type: Schema.Literal("WORKER_COMPLETED"),
    workerResultPath: RunMachinePathSchema,
  }),
  Schema.Struct({
    deploymentPath: RunMachinePathSchema,
    status: RunMachineStatusSchema,
    type: Schema.Literal("PREVIEW_DEPLOYMENT_RECORDED"),
    url: Schema.optionalKey(RunMachineUrlSchema),
  }),
  Schema.Struct({ type: Schema.Literal("VERIFICATION_STARTED") }),
  Schema.Struct({
    type: Schema.Literals([
      "CLAIM_VERIFICATION_GENERATION_STARTED",
      "CLAIM_VERIFICATION_CREATE_INTENT_RECORDED",
      "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED",
      "CLAIM_VERIFICATION_COMMAND_START_RECORDED",
      "CLAIM_VERIFICATION_COMMAND_RECORDED",
      "CLAIM_VERIFICATION_REUSE_RECORDED",
      "CLAIM_VERIFICATION_RECONCILIATION_RECORDED",
    ] as const),
  }),
  Schema.Struct({
    runId: RunIdSchema,
    sequence: Schema.Number,
    type: Schema.Literal("VERIFICATION_COMPLETED"),
    verificationResultPath: RunMachinePathSchema,
  }),
  Schema.Struct({
    result: RunProofResultSchema,
    verificationResultPath: RunMachinePathSchema,
    type: Schema.Literal("RUN_PROOF_RESULT_RECORDED"),
  }),
  Schema.Struct({
    evidenceKind: Schema.optionalKey(Schema.Literal("page")),
    evidencePath: RunMachinePathSchema,
    evidenceSelector: Schema.optionalKey(VerificationSourceKeySchema),
    status: RunMachineStatusSchema,
    targetUrl: RunMachineUrlSchema,
    type: Schema.Literal("BROWSER_EVIDENCE_RECORDED"),
  }),
  Schema.Struct({ type: Schema.Literal("REPORT_STARTED") }),
  Schema.Struct({
    reportPath: RunMachinePathSchema,
    type: Schema.Literal("REPORT_COMPLETED"),
  }),
  Schema.Struct({
    checksPath: RunMachinePathSchema,
    pullRequest: RunMachineIdentifierSchema,
    status: RunMachineStatusSchema,
    type: Schema.Literal("GITHUB_CHECKS_RECORDED"),
    watchStatePath: Schema.optionalKey(RunMachinePathSchema),
  }),
  Schema.Struct({
    commentCount: Schema.Number,
    feedbackPath: RunMachinePathSchema,
    nextAction: RunMachineActionTextSchema,
    pullRequest: RunMachineIdentifierSchema,
    reviewCount: Schema.Number,
    reviewRequestCount: Schema.Number,
    status: RunMachineStatusSchema,
    type: Schema.Literal("GITHUB_FEEDBACK_RECORDED"),
  }),
  Schema.Struct({
    blockerCount: Schema.Number,
    nextAction: RunMachineActionTextSchema,
    observation: Schema.optionalKey(DeliveryPullRequestObservation),
    prLoopPath: RunMachinePathSchema,
    pullRequest: RunMachineIdentifierSchema,
    status: RunMachineStatusSchema,
    type: Schema.Literal("GITHUB_PR_LOOP_RECORDED"),
  }),
  Schema.Struct({
    commentPath: RunMachinePathSchema,
    commentUrl: Schema.optionalKey(RunMachineUrlSchema),
    pullRequest: RunMachineIdentifierSchema,
    type: Schema.Literal("GITHUB_PR_COMMENT_RECORDED"),
  }),
  Schema.Struct({
    blockerCount: Schema.Number,
    nextAction: RunMachineActionTextSchema,
    pullRequest: RunMachineIdentifierSchema,
    remediationSpecPath: RunMachinePathSchema,
    type: Schema.Literal("GITHUB_REMEDIATION_SPEC_RECORDED"),
  }),
  Schema.Struct({
    blockedByCount: Schema.Number,
    blocksCount: Schema.Number,
    issueGraphPath: RunMachinePathSchema,
    issueIdentifier: RunMachineIdentifierSchema,
    issueUrl: Schema.optionalKey(RunMachineUrlSchema),
    type: Schema.Literal("LINEAR_ISSUE_GRAPH_RECORDED"),
  }),
  Schema.Struct({
    blockerCount: Schema.Number,
    mergeDecisionPath: RunMachinePathSchema,
    nextAction: RunMachineActionTextSchema,
    pullRequest: Schema.optionalKey(RunMachineIdentifierSchema),
    status: RunMachineStatusSchema,
    type: Schema.Literal("MERGE_DECISION_RECORDED"),
  }),
  Schema.Struct({ type: Schema.Literal("HARNESS_SESSION_EVENT_RECORDED") }),
  Schema.Struct({
    recovery: WorkerRecoveryReceiptSchema,
    type: Schema.Literal("WORKER_RECOVERY_RECORDED"),
  }),
  Schema.Struct({
    continuation: WorkerContinuationReceiptSchema,
    type: Schema.Literal("WORKER_CONTINUATION_RECORDED"),
  }),
  Schema.Struct({
    reconciliation: WorkerCorrelationReconciliationReceiptSchema,
    type: Schema.Literal("WORKER_CORRELATION_RECONCILIATION_RECORDED"),
  }),
  Schema.Struct({
    desktopOriginCorrelation: WorkerDesktopOriginCorrelationReceiptSchema,
    type: Schema.Literal("WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED"),
  }),
  Schema.Struct({
    failure: GaiaFailure,
    type: Schema.Literal("RUN_FAILED"),
  }),
]);

export const parseRunMachineEvent = Schema.decodeUnknownSync(
  RunMachineEventSchema
);

const initialContext = parseRunMachineContext({
  browserEvidencePath: undefined,
  browserEvidenceStatus: undefined,
  browserEvidenceTargetUrl: undefined,
  delivery: undefined,
  evidenceReviewPath: undefined,
  failure: undefined,
  githubChecksPath: undefined,
  githubChecksStatus: undefined,
  githubFeedbackCommentCount: undefined,
  githubFeedbackNextAction: undefined,
  githubFeedbackPath: undefined,
  githubFeedbackReviewCount: undefined,
  githubFeedbackReviewRequestCount: undefined,
  githubFeedbackStatus: undefined,
  githubPrCommentPath: undefined,
  githubPrCommentUrl: undefined,
  githubPrLoopBlockerCount: undefined,
  githubPrLoopNextAction: undefined,
  githubPrLoopPath: undefined,
  githubPrLoopStatus: undefined,
  githubPullRequest: undefined,
  githubRemediationBlockerCount: undefined,
  githubRemediationNextAction: undefined,
  githubRemediationSpecPath: undefined,
  githubWatchStatePath: undefined,
  lastEventSequence: 0,
  evidenceReviewerSessionPath: undefined,
  linearBlockedByCount: undefined,
  linearBlocksCount: undefined,
  linearIssueGraphPath: undefined,
  linearIssueIdentifier: undefined,
  linearIssueUrl: undefined,
  mergeDecisionBlockerCount: undefined,
  mergeDecisionNextAction: undefined,
  mergeDecisionPath: undefined,
  mergeDecisionStatus: undefined,
  planReviewPath: undefined,
  planReviewerSessionPath: undefined,
  previewDeploymentPath: undefined,
  previewDeploymentStatus: undefined,
  previewDeploymentUrl: undefined,
  reportPath: undefined,
  runProof: undefined,
  runId: undefined,
  specPath: undefined,
  verificationResultPath: undefined,
  workerResultPath: undefined,
  workspacePath: undefined,
});

type RunMachineActionParams = {
  readonly recordBrowserEvidence: undefined;
  readonly recordDelivery: undefined;
  readonly recordDeliveryCleanup: undefined;
  readonly recordDeliveryMerge: undefined;
  readonly recordDeliveryMergeReadiness: undefined;
  readonly recordDeliveryPublication: undefined;
  readonly recordDeliveryPullRequestReady: undefined;
  readonly recordDeliveryReadyToPublish: undefined;
  readonly recordDeliveryRemediation: undefined;
  readonly recordFailure: undefined;
  readonly recordGitHubChecks: undefined;
  readonly recordGitHubFeedback: undefined;
  readonly recordGitHubPrComment: undefined;
  readonly recordGitHubPrLoop: undefined;
  readonly recordGitHubRemediationSpec: undefined;
  readonly recordLinearIssueGraph: undefined;
  readonly recordMergeDecision: undefined;
  readonly recordPreviewDeployment: undefined;
  readonly recordReportCompleted: undefined;
  readonly recordReviewCompleted: undefined;
  readonly recordRunContract: undefined;
  readonly recordRunCreated: undefined;
  readonly recordRunProofResult: undefined;
  readonly recordVerificationCompleted: undefined;
  readonly recordWorkerCompleted: undefined;
  readonly recordWorkerContinuation: undefined;
  readonly recordWorkerCorrelationReconciliation: undefined;
  readonly recordWorkerDesktopOriginCorrelation: undefined;
  readonly recordWorkspacePrepared: undefined;
};

type RunMachineGuardParams = {
  readonly cleanupCompleted: undefined;
  readonly workerContinuationFailed: undefined;
  readonly workerContinuationRunning: undefined;
  readonly workerCorrelationFailed: undefined;
  readonly workerCorrelationRunning: undefined;
  readonly workerDesktopOriginCorrelationFailed: undefined;
  readonly workerDesktopOriginCorrelationRunning: undefined;
  readonly workerRecoveryConfirmed: undefined;
};

const runMachineSetup = setup<
  RunMachineContext,
  Schema.Schema.Type<typeof RunMachineEventSchema>,
  Record<never, never>,
  Record<never, string>,
  RunMachineActionParams,
  RunMachineGuardParams
>({});

export const runMachine = runMachineSetup
  .createMachine({
    context: initialContext,
    id: "gaia-run",
    initial: "created",
    states: {
      completed: {
        on: {
          WORKER_CONTINUATION_RECORDED: [
            {
              actions: "recordWorkerContinuation",
              guard: "workerContinuationRunning",
              target: "runningWorker",
            },
            {
              actions: "recordWorkerContinuation",
              guard: "workerContinuationFailed",
              target: "failed",
            },
            { actions: "recordWorkerContinuation", target: "delivering" },
          ],
          WORKER_CORRELATION_RECONCILIATION_RECORDED: [
            {
              actions: "recordWorkerCorrelationReconciliation",
              guard: "workerCorrelationRunning",
              target: "runningWorker",
            },
            {
              actions: "recordWorkerCorrelationReconciliation",
              guard: "workerCorrelationFailed",
              target: "failed",
            },
            {
              actions: "recordWorkerCorrelationReconciliation",
              target: "delivering",
            },
          ],
          WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED: [
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              guard: "workerDesktopOriginCorrelationRunning",
              target: "runningWorker",
            },
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              guard: "workerDesktopOriginCorrelationFailed",
              target: "failed",
            },
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              target: "delivering",
            },
          ],
          BROWSER_EVIDENCE_RECORDED: {
            actions: "recordBrowserEvidence",
          },
          GITHUB_CHECKS_RECORDED: {
            actions: "recordGitHubChecks",
          },
          GITHUB_FEEDBACK_RECORDED: {
            actions: "recordGitHubFeedback",
          },
          GITHUB_PR_LOOP_RECORDED: {
            actions: "recordGitHubPrLoop",
          },
          GITHUB_PR_COMMENT_RECORDED: {
            actions: "recordGitHubPrComment",
          },
          GITHUB_REMEDIATION_SPEC_RECORDED: {
            actions: "recordGitHubRemediationSpec",
          },
          LINEAR_ISSUE_GRAPH_RECORDED: {
            actions: "recordLinearIssueGraph",
          },
          MERGE_DECISION_RECORDED: {
            actions: "recordMergeDecision",
          },
          PREVIEW_DEPLOYMENT_RECORDED: {
            actions: "recordPreviewDeployment",
          },
          RUN_FAILED: {
            actions: "recordFailure",
            target: "failed",
          },
        },
      },
      created: {
        on: {
          RUN_CREATED: {
            actions: "recordRunCreated",
            target: "preparingWorkspace",
          },
          RUN_FAILED: {
            actions: "recordFailure",
            target: "failed",
          },
          WORKER_CORRELATION_RECONCILIATION_RECORDED: [
            {
              actions: "recordWorkerCorrelationReconciliation",
              guard: "workerCorrelationFailed",
              target: "failed",
            },
            { actions: "recordWorkerCorrelationReconciliation" },
          ],
          WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED: [
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              guard: "workerDesktopOriginCorrelationFailed",
              target: "failed",
            },
            { actions: "recordWorkerDesktopOriginCorrelation" },
          ],
        },
      },
      failed: {
        on: {
          WORKER_CONTINUATION_RECORDED: [
            {
              actions: "recordWorkerContinuation",
              guard: "workerContinuationRunning",
              target: "runningWorker",
            },
            {
              actions: "recordWorkerContinuation",
              guard: "workerContinuationFailed",
            },
            { actions: "recordWorkerContinuation", target: "delivering" },
          ],
          WORKER_CORRELATION_RECONCILIATION_RECORDED: [
            {
              actions: "recordWorkerCorrelationReconciliation",
              guard: "workerCorrelationRunning",
              target: "runningWorker",
            },
            {
              actions: "recordWorkerCorrelationReconciliation",
              guard: "workerCorrelationFailed",
            },
            {
              actions: "recordWorkerCorrelationReconciliation",
              target: "delivering",
            },
          ],
          WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED: [
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              guard: "workerDesktopOriginCorrelationRunning",
              target: "runningWorker",
            },
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              guard: "workerDesktopOriginCorrelationFailed",
            },
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              target: "delivering",
            },
          ],
          WORKER_RECOVERY_RECORDED: [
            { guard: "workerRecoveryConfirmed", target: "runningWorker" },
            {},
          ],
        },
      },
      delivering: {
        on: {
          CLAIM_VERIFICATION_GENERATION_STARTED: {},
          CLAIM_VERIFICATION_CREATE_INTENT_RECORDED: {},
          CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED: {},
          CLAIM_VERIFICATION_COMMAND_START_RECORDED: {},
          CLAIM_VERIFICATION_COMMAND_RECORDED: {},
          CLAIM_VERIFICATION_REUSE_RECORDED: {},
          CLAIM_VERIFICATION_RECONCILIATION_RECORDED: {},
          RUN_CONTRACT_RECORDED: {
            actions: "recordRunContract",
          },
          RUN_PROOF_RESULT_RECORDED: {
            actions: "recordRunProofResult",
          },
          BROWSER_EVIDENCE_RECORDED: {
            actions: "recordBrowserEvidence",
          },
          GITHUB_CHECKS_RECORDED: {
            actions: "recordGitHubChecks",
          },
          GITHUB_FEEDBACK_RECORDED: {
            actions: "recordGitHubFeedback",
          },
          GITHUB_PR_LOOP_RECORDED: {
            actions: "recordGitHubPrLoop",
          },
          MERGE_DECISION_RECORDED: {
            actions: "recordMergeDecision",
          },
          REVIEW_COMPLETED: {
            actions: "recordReviewCompleted",
          },
          REVIEW_STARTED: {},
          DELIVERY_PUBLICATION_ATTEMPTED: {
            actions: "recordDeliveryPublication",
          },
          DELIVERY_PUBLICATION_CONFIRMED: {
            actions: "recordDeliveryPublication",
          },
          DELIVERY_PUBLICATION_FAILED: {
            actions: "recordDeliveryPublication",
          },
          DELIVERY_PUBLICATION_INTENT_RECORDED: {
            actions: "recordDeliveryPublication",
          },
          DELIVERY_PUBLICATION_OUTCOME_UNKNOWN: {
            actions: "recordDeliveryPublication",
          },
          DELIVERY_REMEDIATION_RECORDED: {
            actions: "recordDeliveryRemediation",
          },
          DELIVERY_PR_READY_RECORDED: {
            actions: "recordDeliveryPullRequestReady",
          },
          DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED: {},
          WORKER_CONTINUATION_RECORDED: [
            {
              actions: "recordWorkerContinuation",
              guard: "workerContinuationRunning",
              target: "runningWorker",
            },
            {
              actions: "recordWorkerContinuation",
              guard: "workerContinuationFailed",
              target: "failed",
            },
            { actions: "recordWorkerContinuation" },
          ],
          WORKER_CORRELATION_RECONCILIATION_RECORDED: [
            {
              actions: "recordWorkerCorrelationReconciliation",
              guard: "workerCorrelationRunning",
              target: "runningWorker",
            },
            {
              actions: "recordWorkerCorrelationReconciliation",
              guard: "workerCorrelationFailed",
              target: "failed",
            },
            { actions: "recordWorkerCorrelationReconciliation" },
          ],
          WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED: [
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              guard: "workerDesktopOriginCorrelationRunning",
              target: "runningWorker",
            },
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              guard: "workerDesktopOriginCorrelationFailed",
              target: "failed",
            },
            { actions: "recordWorkerDesktopOriginCorrelation" },
          ],
          DELIVERY_MERGE_RECORDED: { actions: "recordDeliveryMerge" },
          DELIVERY_MERGE_READINESS_RECORDED: {
            actions: "recordDeliveryMergeReadiness",
          },
          DELIVERY_CLEANUP_RECORDED: [
            {
              actions: "recordDeliveryCleanup",
              guard: "cleanupCompleted",
              target: "completed",
            },
            { actions: "recordDeliveryCleanup" },
          ],
          RUN_FAILED: {
            actions: "recordFailure",
            target: "failed",
          },
          VERIFICATION_COMPLETED: {
            actions: "recordVerificationCompleted",
          },
          VERIFICATION_STARTED: {},
          WORKSPACE_PREPARED: {
            actions: "recordWorkspacePrepared",
            target: "runningWorker",
          },
        },
      },
      preparingWorkspace: {
        on: {
          RUN_CONTRACT_RECORDED: {
            actions: "recordRunContract",
          },
          DELIVERY_STARTED: {
            actions: "recordDelivery",
            target: "delivering",
          },
          RUN_FAILED: {
            actions: "recordFailure",
            target: "failed",
          },
          WORKSPACE_PREPARED: {
            actions: "recordWorkspacePrepared",
            target: "runningWorker",
          },
        },
      },
      reporting: {
        on: {
          BROWSER_EVIDENCE_RECORDED: {
            actions: "recordBrowserEvidence",
          },
          DELIVERY_READY_TO_PUBLISH: {
            actions: "recordDeliveryReadyToPublish",
            target: "delivering",
          },
          PREVIEW_DEPLOYMENT_RECORDED: {
            actions: "recordPreviewDeployment",
          },
          REPORT_STARTED: {},
          REPORT_COMPLETED: {
            actions: "recordReportCompleted",
            target: "completed",
          },
          REVIEW_COMPLETED: {
            actions: "recordReviewCompleted",
          },
          REVIEW_STARTED: {},
          RUN_FAILED: {
            actions: "recordFailure",
            target: "failed",
          },
        },
      },
      runningWorker: {
        on: {
          RUN_FAILED: {
            actions: "recordFailure",
            target: "failed",
          },
          REVIEW_COMPLETED: {
            actions: "recordReviewCompleted",
          },
          REVIEW_STARTED: {},
          PREVIEW_DEPLOYMENT_RECORDED: {
            actions: "recordPreviewDeployment",
          },
          WORKER_COMPLETED: {
            actions: "recordWorkerCompleted",
            target: "verifying",
          },
          WORKER_STARTED: {},
          WORKER_CONTINUATION_RECORDED: [
            {
              actions: "recordWorkerContinuation",
              guard: "workerContinuationFailed",
              target: "failed",
            },
            { actions: "recordWorkerContinuation" },
          ],
          WORKER_CORRELATION_RECONCILIATION_RECORDED: [
            {
              actions: "recordWorkerCorrelationReconciliation",
              guard: "workerCorrelationFailed",
              target: "failed",
            },
            { actions: "recordWorkerCorrelationReconciliation" },
          ],
          WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED: [
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              guard: "workerDesktopOriginCorrelationFailed",
              target: "failed",
            },
            { actions: "recordWorkerDesktopOriginCorrelation" },
          ],
        },
      },
      verifying: {
        on: {
          CLAIM_VERIFICATION_GENERATION_STARTED: {},
          CLAIM_VERIFICATION_CREATE_INTENT_RECORDED: {},
          CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED: {},
          CLAIM_VERIFICATION_COMMAND_START_RECORDED: {},
          CLAIM_VERIFICATION_COMMAND_RECORDED: {},
          CLAIM_VERIFICATION_REUSE_RECORDED: {},
          CLAIM_VERIFICATION_RECONCILIATION_RECORDED: {},
          PREVIEW_DEPLOYMENT_RECORDED: {
            actions: "recordPreviewDeployment",
          },
          RUN_FAILED: {
            actions: "recordFailure",
            target: "failed",
          },
          VERIFICATION_COMPLETED: {
            actions: "recordVerificationCompleted",
            target: "reporting",
          },
          RUN_PROOF_RESULT_RECORDED: {
            actions: "recordRunProofResult",
            target: "reporting",
          },
          VERIFICATION_STARTED: {},
          WORKER_CORRELATION_RECONCILIATION_RECORDED: [
            {
              actions: "recordWorkerCorrelationReconciliation",
              guard: "workerCorrelationFailed",
              target: "failed",
            },
            { actions: "recordWorkerCorrelationReconciliation" },
          ],
          WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED: [
            {
              actions: "recordWorkerDesktopOriginCorrelation",
              guard: "workerDesktopOriginCorrelationFailed",
              target: "failed",
            },
            { actions: "recordWorkerDesktopOriginCorrelation" },
          ],
        },
      },
    },
  })
  .provide({
    actions: {
      recordBrowserEvidence: assign({
        browserEvidencePath: ({ event }) =>
          event.type === "BROWSER_EVIDENCE_RECORDED"
            ? event.evidencePath
            : undefined,
        browserEvidenceStatus: ({ event }) =>
          event.type === "BROWSER_EVIDENCE_RECORDED" ? event.status : undefined,
        browserEvidenceTargetUrl: ({ event }) =>
          event.type === "BROWSER_EVIDENCE_RECORDED"
            ? event.targetUrl
            : undefined,
      }),
      recordFailure: assign({
        failure: ({ event }) =>
          event.type === "RUN_FAILED" ? event.failure : undefined,
      }),
      recordDelivery: assign({
        delivery: ({ event }) =>
          event.type === "DELIVERY_STARTED" ||
          event.type === "DELIVERY_READY_TO_PUBLISH"
            ? event.delivery
            : undefined,
      }),
      recordGitHubChecks: assign({
        githubChecksPath: ({ event }) =>
          event.type === "GITHUB_CHECKS_RECORDED"
            ? event.checksPath
            : undefined,
        githubChecksStatus: ({ event }) =>
          event.type === "GITHUB_CHECKS_RECORDED" ? event.status : undefined,
        githubPullRequest: ({ event }) =>
          event.type === "GITHUB_CHECKS_RECORDED"
            ? event.pullRequest
            : undefined,
        githubWatchStatePath: ({ context, event }) =>
          event.type === "GITHUB_CHECKS_RECORDED" &&
          event.watchStatePath !== undefined
            ? event.watchStatePath
            : context.githubWatchStatePath,
      }),
      recordDeliveryReadyToPublish: assign({
        delivery: ({ context, event }) =>
          event.type === "DELIVERY_READY_TO_PUBLISH"
            ? deliveryReadyToPublish(context.delivery, event.delivery)
            : context.delivery,
        reportPath: ({ event }) =>
          event.type === "DELIVERY_READY_TO_PUBLISH"
            ? event.reportPath
            : undefined,
      }),
      recordDeliveryPublication: assign({
        delivery: ({ context, event }) =>
          event.type === "DELIVERY_PUBLICATION_INTENT_RECORDED" ||
          event.type === "DELIVERY_PUBLICATION_ATTEMPTED" ||
          event.type === "DELIVERY_PUBLICATION_CONFIRMED" ||
          event.type === "DELIVERY_PUBLICATION_FAILED" ||
          event.type === "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN"
            ? deliveryWithPublication(context.delivery, event.publication)
            : context.delivery,
      }),
      recordDeliveryRemediation: assign({
        delivery: ({ context, event }) =>
          event.type === "DELIVERY_REMEDIATION_RECORDED"
            ? deliveryWithRemediation(
                context.delivery,
                event.remediation,
                event.eventSequence
              )
            : context.delivery,
      }),
      recordDeliveryMerge: assign({
        delivery: ({ context, event }) =>
          event.type === "DELIVERY_MERGE_RECORDED"
            ? deliveryWithMerge(context.delivery, event.mergeAction)
            : context.delivery,
      }),
      recordDeliveryPullRequestReady: assign({
        delivery: ({ context, event }) =>
          event.type === "DELIVERY_PR_READY_RECORDED"
            ? deliveryWithPullRequestReady(
                context.delivery,
                event.readyForReviewAction
              )
            : context.delivery,
      }),
      recordWorkerContinuation: assign({
        delivery: ({ context, event }) =>
          event.type === "WORKER_CONTINUATION_RECORDED"
            ? deliveryWithWorkerContinuation(
                context.delivery,
                event.continuation
              )
            : context.delivery,
        evidenceReviewPath: ({ context, event }) =>
          event.type === "WORKER_CONTINUATION_RECORDED" &&
          event.continuation.state === "intentRecorded"
            ? undefined
            : context.evidenceReviewPath,
        reportPath: ({ context, event }) =>
          event.type === "WORKER_CONTINUATION_RECORDED" &&
          event.continuation.state === "intentRecorded"
            ? undefined
            : context.reportPath,
        verificationResultPath: ({ context, event }) =>
          event.type === "WORKER_CONTINUATION_RECORDED" &&
          event.continuation.state === "intentRecorded"
            ? undefined
            : context.verificationResultPath,
        workerResultPath: ({ context, event }) =>
          event.type === "WORKER_CONTINUATION_RECORDED" &&
          event.continuation.state === "intentRecorded"
            ? undefined
            : context.workerResultPath,
      }),
      recordWorkerCorrelationReconciliation: assign({
        delivery: ({ context, event }) =>
          event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED"
            ? deliveryWithWorkerCorrelationReconciliation(
                context.delivery,
                event.reconciliation
              )
            : context.delivery,
        evidenceReviewPath: ({ context, event }) =>
          event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED" &&
          event.reconciliation.state === "intentRecorded"
            ? undefined
            : context.evidenceReviewPath,
        reportPath: ({ context, event }) =>
          event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED" &&
          event.reconciliation.state === "intentRecorded"
            ? undefined
            : context.reportPath,
        verificationResultPath: ({ context, event }) =>
          event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED" &&
          event.reconciliation.state === "intentRecorded"
            ? undefined
            : context.verificationResultPath,
        workerResultPath: ({ context, event }) =>
          event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED" &&
          event.reconciliation.state === "intentRecorded"
            ? undefined
            : context.workerResultPath,
      }),
      recordWorkerDesktopOriginCorrelation: assign({
        delivery: ({ context, event }) =>
          event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED"
            ? deliveryWithWorkerDesktopOriginCorrelation(
                context.delivery,
                event.desktopOriginCorrelation
              )
            : context.delivery,
        evidenceReviewPath: ({ context, event }) =>
          event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED" &&
          event.desktopOriginCorrelation.state === "intentRecorded"
            ? undefined
            : context.evidenceReviewPath,
        reportPath: ({ context, event }) =>
          event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED" &&
          event.desktopOriginCorrelation.state === "intentRecorded"
            ? undefined
            : context.reportPath,
        verificationResultPath: ({ context, event }) =>
          event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED" &&
          event.desktopOriginCorrelation.state === "intentRecorded"
            ? undefined
            : context.verificationResultPath,
        workerResultPath: ({ context, event }) =>
          event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED" &&
          event.desktopOriginCorrelation.state === "intentRecorded"
            ? undefined
            : context.workerResultPath,
      }),
      recordDeliveryMergeReadiness: assign({
        delivery: ({ context, event }) =>
          event.type === "DELIVERY_MERGE_READINESS_RECORDED" &&
          context.delivery !== undefined
            ? {
                ...context.delivery,
                mergeDecision: encodeDeliveryMergeReadinessDecisionJson(
                  event.decision
                ),
                mergeDecisionSequence: event.eventSequence,
                stage: event.decision.approved
                  ? "awaitingMerge"
                  : "waitingForPr",
              }
            : context.delivery,
      }),
      recordDeliveryCleanup: assign({
        delivery: ({ context, event }) =>
          event.type === "DELIVERY_CLEANUP_RECORDED"
            ? deliveryWithCleanup(context.delivery, event.cleanup)
            : context.delivery,
      }),
      recordGitHubFeedback: assign({
        githubFeedbackCommentCount: ({ event }) =>
          event.type === "GITHUB_FEEDBACK_RECORDED"
            ? event.commentCount
            : undefined,
        githubFeedbackNextAction: ({ event }) =>
          event.type === "GITHUB_FEEDBACK_RECORDED"
            ? event.nextAction
            : undefined,
        githubFeedbackPath: ({ event }) =>
          event.type === "GITHUB_FEEDBACK_RECORDED"
            ? event.feedbackPath
            : undefined,
        githubFeedbackReviewCount: ({ event }) =>
          event.type === "GITHUB_FEEDBACK_RECORDED"
            ? event.reviewCount
            : undefined,
        githubFeedbackReviewRequestCount: ({ event }) =>
          event.type === "GITHUB_FEEDBACK_RECORDED"
            ? event.reviewRequestCount
            : undefined,
        githubFeedbackStatus: ({ event }) =>
          event.type === "GITHUB_FEEDBACK_RECORDED" ? event.status : undefined,
        githubPullRequest: ({ event }) =>
          event.type === "GITHUB_FEEDBACK_RECORDED"
            ? event.pullRequest
            : undefined,
      }),
      recordGitHubPrLoop: assign({
        delivery: ({ context, event }) =>
          event.type === "GITHUB_PR_LOOP_RECORDED" &&
          event.observation !== undefined
            ? deliveryWithPullRequestObservation(
                context.delivery,
                event.observation
              )
            : context.delivery,
        githubPrLoopBlockerCount: ({ event }) =>
          event.type === "GITHUB_PR_LOOP_RECORDED"
            ? event.blockerCount
            : undefined,
        githubPrLoopNextAction: ({ event }) =>
          event.type === "GITHUB_PR_LOOP_RECORDED"
            ? event.nextAction
            : undefined,
        githubPrLoopPath: ({ event }) =>
          event.type === "GITHUB_PR_LOOP_RECORDED"
            ? event.prLoopPath
            : undefined,
        githubPrLoopStatus: ({ event }) =>
          event.type === "GITHUB_PR_LOOP_RECORDED" ? event.status : undefined,
        githubPullRequest: ({ event }) =>
          event.type === "GITHUB_PR_LOOP_RECORDED"
            ? event.pullRequest
            : undefined,
      }),
      recordGitHubPrComment: assign({
        githubPrCommentPath: ({ event }) =>
          event.type === "GITHUB_PR_COMMENT_RECORDED"
            ? event.commentPath
            : undefined,
        githubPrCommentUrl: ({ event }) =>
          event.type === "GITHUB_PR_COMMENT_RECORDED"
            ? event.commentUrl
            : undefined,
        githubPullRequest: ({ event }) =>
          event.type === "GITHUB_PR_COMMENT_RECORDED"
            ? event.pullRequest
            : undefined,
      }),
      recordGitHubRemediationSpec: assign({
        githubRemediationBlockerCount: ({ event }) =>
          event.type === "GITHUB_REMEDIATION_SPEC_RECORDED"
            ? event.blockerCount
            : undefined,
        githubPullRequest: ({ event }) =>
          event.type === "GITHUB_REMEDIATION_SPEC_RECORDED"
            ? event.pullRequest
            : undefined,
        githubRemediationNextAction: ({ event }) =>
          event.type === "GITHUB_REMEDIATION_SPEC_RECORDED"
            ? event.nextAction
            : undefined,
        githubRemediationSpecPath: ({ event }) =>
          event.type === "GITHUB_REMEDIATION_SPEC_RECORDED"
            ? event.remediationSpecPath
            : undefined,
      }),
      recordLinearIssueGraph: assign({
        linearBlockedByCount: ({ event }) =>
          event.type === "LINEAR_ISSUE_GRAPH_RECORDED"
            ? event.blockedByCount
            : undefined,
        linearBlocksCount: ({ event }) =>
          event.type === "LINEAR_ISSUE_GRAPH_RECORDED"
            ? event.blocksCount
            : undefined,
        linearIssueGraphPath: ({ event }) =>
          event.type === "LINEAR_ISSUE_GRAPH_RECORDED"
            ? event.issueGraphPath
            : undefined,
        linearIssueIdentifier: ({ event }) =>
          event.type === "LINEAR_ISSUE_GRAPH_RECORDED"
            ? event.issueIdentifier
            : undefined,
        linearIssueUrl: ({ event }) =>
          event.type === "LINEAR_ISSUE_GRAPH_RECORDED"
            ? event.issueUrl
            : undefined,
      }),
      recordMergeDecision: assign({
        githubPullRequest: ({ context, event }) =>
          event.type === "MERGE_DECISION_RECORDED" &&
          event.pullRequest !== undefined
            ? event.pullRequest
            : context.githubPullRequest,
        mergeDecisionBlockerCount: ({ event }) =>
          event.type === "MERGE_DECISION_RECORDED"
            ? event.blockerCount
            : undefined,
        mergeDecisionNextAction: ({ event }) =>
          event.type === "MERGE_DECISION_RECORDED"
            ? event.nextAction
            : undefined,
        mergeDecisionPath: ({ event }) =>
          event.type === "MERGE_DECISION_RECORDED"
            ? event.mergeDecisionPath
            : undefined,
        mergeDecisionStatus: ({ event }) =>
          event.type === "MERGE_DECISION_RECORDED" ? event.status : undefined,
      }),
      recordPreviewDeployment: assign({
        previewDeploymentPath: ({ event }) =>
          event.type === "PREVIEW_DEPLOYMENT_RECORDED"
            ? event.deploymentPath
            : undefined,
        previewDeploymentStatus: ({ event }) =>
          event.type === "PREVIEW_DEPLOYMENT_RECORDED"
            ? event.status
            : undefined,
        previewDeploymentUrl: ({ event }) =>
          event.type === "PREVIEW_DEPLOYMENT_RECORDED" ? event.url : undefined,
      }),
      recordReportCompleted: assign({
        reportPath: ({ event }) =>
          event.type === "REPORT_COMPLETED" ? event.reportPath : undefined,
      }),
      recordRunCreated: assign({
        runId: ({ event }) =>
          event.type === "RUN_CREATED" ? event.runId : undefined,
        specPath: ({ event }) =>
          event.type === "RUN_CREATED" ? event.specPath : undefined,
      }),
      recordReviewCompleted: assign({
        evidenceReviewPath: ({ context, event }) =>
          event.type === "REVIEW_COMPLETED" && event.phase === "evidence"
            ? event.reviewPath
            : context.evidenceReviewPath,
        evidenceReviewerSessionPath: ({ context, event }) =>
          event.type === "REVIEW_COMPLETED" &&
          event.phase === "evidence" &&
          event.reviewerSessionEvidencePath !== undefined
            ? event.reviewerSessionEvidencePath
            : context.evidenceReviewerSessionPath,
        planReviewPath: ({ context, event }) =>
          event.type === "REVIEW_COMPLETED" && event.phase === "plan"
            ? event.reviewPath
            : context.planReviewPath,
        planReviewerSessionPath: ({ context, event }) =>
          event.type === "REVIEW_COMPLETED" &&
          event.phase === "plan" &&
          event.reviewerSessionEvidencePath !== undefined
            ? event.reviewerSessionEvidencePath
            : context.planReviewerSessionPath,
      }),
      recordVerificationCompleted: assign({
        runProof: ({ event }) =>
          event.type === "VERIFICATION_COMPLETED"
            ? {
                aggregate: "completed-unverified",
                kind: "no-contract",
                legacyVerification: {
                  recordedBy: {
                    runId: event.runId,
                    sequence: parseRunEventSequence(event.sequence),
                    type: "VERIFICATION_COMPLETED",
                  },
                  resultPath: parseRunRelativeArtifactPath(
                    event.verificationResultPath
                  ),
                },
                version: 1,
              }
            : undefined,
        verificationResultPath: ({ event }) =>
          event.type === "VERIFICATION_COMPLETED"
            ? event.verificationResultPath
            : undefined,
      }),
      recordRunContract: assign({
        runProof: ({ event }) => {
          if (event.type !== "RUN_CONTRACT_RECORDED") return undefined;
          return event.contract.version === 1
            ? {
                aggregate: "completed-unverified" as const,
                contract: event.contract,
                kind: "contract" as const,
                version: 1 as const,
              }
            : {
                aggregate: "completed-unverified" as const,
                contract: event.contract,
                kind: "contract" as const,
                version: 2 as const,
              };
        },
      }),
      recordRunProofResult: assign({
        runProof: ({ context, event }) => {
          if (
            event.type !== "RUN_PROOF_RESULT_RECORDED" ||
            context.runProof?.kind !== "contract"
          )
            return context.runProof;
          if (event.result.version === 1 && context.runProof.version === 1)
            return {
              aggregate: event.result.aggregate,
              contract: context.runProof.contract,
              kind: "contract" as const,
              latestResult: event.result,
              version: 1 as const,
            };
          if (event.result.version === 2 && context.runProof.version === 2)
            return {
              aggregate: event.result.aggregate,
              contract: context.runProof.contract,
              kind: "contract" as const,
              latestResult: event.result,
              version: 2 as const,
            };
          return context.runProof;
        },
        verificationResultPath: ({ event }) =>
          event.type === "RUN_PROOF_RESULT_RECORDED"
            ? event.verificationResultPath
            : undefined,
      }),
      recordWorkerCompleted: assign({
        workerResultPath: ({ event }) =>
          event.type === "WORKER_COMPLETED"
            ? event.workerResultPath
            : undefined,
      }),
      recordWorkspacePrepared: assign({
        workspacePath: ({ event }) =>
          event.type === "WORKSPACE_PREPARED" ? event.workspacePath : undefined,
      }),
    },
    guards: {
      workerRecoveryConfirmed: ({ event }) =>
        event.type === "WORKER_RECOVERY_RECORDED" &&
        event.recovery.state === "dispatchConfirmed",
      workerContinuationFailed: ({ event }) =>
        event.type === "WORKER_CONTINUATION_RECORDED" &&
        (event.continuation.state === "failed" ||
          event.continuation.state === "outcomeUnknown"),
      workerContinuationRunning: ({ event }) =>
        event.type === "WORKER_CONTINUATION_RECORDED" &&
        (event.continuation.state === "resumeAttempted" ||
          event.continuation.state === "resumeConfirmed" ||
          event.continuation.state === "followUpAttempted" ||
          event.continuation.state === "followUpConfirmed"),
      workerCorrelationFailed: ({ event }) =>
        event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED" &&
        (event.reconciliation.state === "failed" ||
          event.reconciliation.state === "outcomeUnknown"),
      workerCorrelationRunning: ({ event }) =>
        event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED" &&
        (event.reconciliation.state === "correlationAttempted" ||
          event.reconciliation.state === "correlationConfirmed" ||
          event.reconciliation.state === "followUpAttempted" ||
          event.reconciliation.state === "followUpConfirmed"),
      workerDesktopOriginCorrelationFailed: ({ event }) =>
        event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED" &&
        (event.desktopOriginCorrelation.state === "failed" ||
          event.desktopOriginCorrelation.state === "outcomeUnknown"),
      workerDesktopOriginCorrelationRunning: ({ event }) =>
        event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED" &&
        (event.desktopOriginCorrelation.state ===
          "sourceCorrelationAttempted" ||
          event.desktopOriginCorrelation.state ===
            "sourceCorrelationConfirmed" ||
          event.desktopOriginCorrelation.state === "followUpAttempted" ||
          event.desktopOriginCorrelation.state === "followUpConfirmed"),
      cleanupCompleted: ({ event }) =>
        event.type === "DELIVERY_CLEANUP_RECORDED" &&
        event.cleanup.state === "completed",
    },
  });

export function replayRunEvents(events: ReadonlyArray<RunEvent>) {
  const actor = createActor(runMachine).start();
  let expectedSequence = 1;
  let historyRunId: RunEvent["runId"] | undefined;
  let publication: DeliveryPublication | undefined;
  let remediation: DeliveryRemediation | undefined;
  const readyForReviewActions: typeof DeliveryPullRequestReadyReplayActionsSchema.Type =
    [];
  const localReviewAttestations: typeof DeliveryLocalReviewAttestationReplayActionsSchema.Type =
    [];
  const mergeActions: typeof DeliveryMergeReplayActionsSchema.Type = [];
  const cleanupActions: typeof DeliveryCleanupReplayActionsSchema.Type = [];
  let runContract: RunContract | undefined;
  let latestProofResult: RunProofResult | undefined;
  let contentAuthoritySequence = 1;
  let evidenceReviewSequence: number | undefined;
  let publicationConfirmationSequence: number | undefined;
  let legacyVerificationSequence: number | undefined;
  let sawLegacyVerification = false;
  let sawProofVocabulary = false;
  let crossedWorkerExecutionBoundary = false;
  const claimVerification = new Map<string, ClaimVerificationReplayState>();

  for (const event of events) {
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Invalid event sequence: expected ${expectedSequence}, received ${event.sequence}.`
      );
    }
    if (historyRunId === undefined) {
      if (event.type !== "RUN_CREATED")
        throw new Error("Run history must begin with RUN_CREATED.");
      historyRunId = event.runId;
    } else if (event.runId !== historyRunId) {
      throw new Error("Run history events must all belong to a single run.");
    }

    if (event.type === "RUN_CONTRACT_RECORDED") {
      if (
        sawLegacyVerification ||
        sawProofVocabulary ||
        runContract !== undefined
      )
        throw new Error(
          "Run history cannot mix, replace, or duplicate the immutable run contract."
        );
      const state = actor.getSnapshot().value;
      if (
        crossedWorkerExecutionBoundary ||
        (state !== "preparingWorkspace" && state !== "delivering")
      )
        throw new Error(
          "The immutable run contract must be recorded before worker execution begins."
        );
      runContract = parseAnyRunContract(event.payload["contract"]);
      sawProofVocabulary = true;
    }
    if (event.type === "RUN_PROOF_RESULT_RECORDED") {
      const state = actor.getSnapshot().value;
      if (sawLegacyVerification || runContract === undefined)
        throw new Error(
          "Run-proof results require one earlier immutable contract and cannot mix with legacy verification."
        );
      if (
        !crossedWorkerExecutionBoundary ||
        (state !== "verifying" && state !== "delivering")
      )
        throw new Error(
          "Run-proof results require a worker execution boundary and a legal verification state."
        );
      const nextProofResult = parseAnyRunProofResult(
        event.payload["result"],
        runContract
      );
      if (nextProofResult.recordedBy.sequence !== event.sequence)
        throw new Error(
          "Run-proof result does not bind its authoritative event sequence."
        );
      if (
        nextProofResult.version === 2 &&
        nextProofResult.contentAuthoritySequence !== contentAuthoritySequence
      )
        throw new Error(
          "V2 run-proof result does not bind the current content authority."
        );
      latestProofResult = nextProofResult;
      sawProofVocabulary = true;
    }
    if (event.type === "VERIFICATION_COMPLETED") {
      if (sawProofVocabulary)
        throw new Error(
          "Run history cannot mix legacy verification with contract-bound proof."
        );
      sawLegacyVerification = true;
      legacyVerificationSequence = event.sequence;
    }
    applyClaimVerificationReplay(
      event,
      runContract,
      claimVerification,
      contentAuthoritySequence
    );
    if (event.type === "MERGE_DECISION_RECORDED") {
      const isV2 = event.payload["decision"] !== undefined;
      const state = actor.getSnapshot().value;
      if (isV2) {
        const decision = parseMergeDecisionV2(event.payload["decision"]);
        if (decision.runId !== event.runId)
          throw new Error(
            "MergeDecisionV2 does not belong to its enclosing run."
          );
        if (state !== "delivering")
          throw new Error("MergeDecisionV2 is legal only while delivering.");
        assertMergeDecisionProofDescription(decision, {
          latestProofResult,
          legacyVerificationSequence,
          runContract,
        });
        assertApprovedMergeDecisionReplayAuthority(decision, {
          contentAuthoritySequence,
          evidenceReviewSequence,
          latestProofResult,
          publicationConfirmationSequence,
        });
      } else if (state !== "completed") {
        throw new Error(
          "Legacy merge decisions are legal only in completed history."
        );
      }
    }

    if (isDeliveryPublicationEvent(event)) {
      const next = parseDeliveryPublication(event.payload["publication"]);
      assertPublicationDeliveryIdentity(
        actor.getSnapshot().context.delivery,
        next
      );
      validatePublicationTransition(publication, next);
      publication = next;
      if (event.type === "DELIVERY_PUBLICATION_CONFIRMED")
        publicationConfirmationSequence = event.sequence;
    }
    if (event.type === "DELIVERY_REMEDIATION_RECORDED") {
      const next = parseDeliveryRemediation(event.payload["remediation"]);
      if (actor.getSnapshot().context.delivery?.["mode"] !== "pullRequest") {
        throw new Error(
          "Remediation requires accepted pull-request delivery state."
        );
      }
      validateDeliveryRemediationTransition(remediation, next);
      if (
        next.state === "confirmed" &&
        deriveDeliveryPullRequestReadyActionHistories(readyForReviewActions)
          .active !== undefined
      ) {
        throw new Error(
          "Confirmed remediation cannot supersede an unresolved ready-for-review action."
        );
      }
      if (
        next.state === "confirmed" &&
        deriveDeliveryLocalReviewAttestationHistories(localReviewAttestations)
          .active !== undefined
      ) {
        throw new Error(
          "Confirmed remediation cannot supersede an unresolved local review attestation."
        );
      }
      remediation = next;
      contentAuthoritySequence = event.sequence;
    }
    if (event.type === "WORKER_COMPLETED")
      contentAuthoritySequence = event.sequence;
    if (event.type === "WORKER_CONTINUATION_RECORDED")
      contentAuthoritySequence = event.sequence;
    if (
      event.type === "REVIEW_COMPLETED" &&
      event.payload["phase"] === "evidence"
    )
      evidenceReviewSequence = event.sequence;
    if (event.type === "DELIVERY_PR_READY_RECORDED") {
      const next = parseDeliveryPullRequestReadyReceipt(
        event.payload["readyForReviewAction"]
      );
      const delivery = actor.getSnapshot().context.delivery;
      if (delivery?.["mode"] !== "pullRequest")
        throw new Error(
          "Ready-for-review action requires accepted pull-request delivery state."
        );
      const confirmedPublication = parseDeliveryPublication(
        delivery["publication"]
      );
      if (confirmedPublication.state !== "confirmed")
        throw new Error(
          "Ready-for-review action requires a confirmed publication."
        );
      const repositoryMatch =
        /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//u.exec(
          confirmedPublication.prUrl
        );
      if (repositoryMatch?.[1] === undefined)
        throw new Error(
          "Confirmed publication has an invalid pull-request URL."
        );
      assertDeliveryPullRequestReadyAuthority(next, {
        branchName: confirmedPublication.branchName,
        expectedHeadSha: deriveAuthoritativeDeliveryHeadSha(
          confirmedPublication,
          events,
          event.sequence - 1
        ),
        prNumber: confirmedPublication.prNumber,
        prUrl: confirmedPublication.prUrl,
        publicationOperationId: confirmedPublication.operationId,
        publicationPayloadDigest: confirmedPublication.payloadDigest,
        repository: repositoryMatch[1],
        runId: event.runId,
      });
      if (next.runId !== events[0]?.runId)
        throw new Error(
          "Ready-for-review action does not match its enclosing run."
        );
      readyForReviewActions.push({ receipt: next, sequence: event.sequence });
      deriveDeliveryPullRequestReadyActionHistories(readyForReviewActions);
    }
    if (event.type === "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED") {
      const next = parseDeliveryLocalReviewAttestationReceipt(
        event.payload["attestation"]
      );
      const delivery = actor.getSnapshot().context.delivery;
      if (delivery?.["mode"] !== "pullRequest")
        throw new Error(
          "Local review attestation requires accepted pull-request delivery state."
        );
      const confirmedPublication = parseDeliveryPublication(
        delivery["publication"]
      );
      if (confirmedPublication.state !== "confirmed")
        throw new Error(
          "Local review attestation requires a confirmed publication."
        );
      const repositoryMatch =
        /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//u.exec(
          confirmedPublication.prUrl
        );
      if (repositoryMatch?.[1] === undefined)
        throw new Error(
          "Confirmed publication has an invalid pull-request URL."
        );
      assertDeliveryLocalReviewAttestationAuthority(next, {
        enclosingRunId: event.runId,
        eventSequence: event.sequence,
        events,
        publication: confirmedPublication,
        repository: repositoryMatch[1],
      });
      localReviewAttestations.push({ receipt: next, sequence: event.sequence });
      deriveDeliveryLocalReviewAttestationHistories(localReviewAttestations);
    }
    if (event.type === "DELIVERY_MERGE_READINESS_RECORDED") {
      const decision = parseDeliveryMergeReadinessDecision(
        event.payload["decision"]
      );
      if (
        decision instanceof DeliveryMergeReadinessDecisionV2 ||
        decision instanceof DeliveryMergeReadinessDecisionV3
      ) {
        const delivery = actor.getSnapshot().context.delivery;
        if (delivery?.["mode"] !== "pullRequest")
          throw new Error(
            "Merge readiness requires accepted pull-request delivery state."
          );
        const confirmedPublication = parseDeliveryPublication(
          delivery["publication"]
        );
        if (confirmedPublication.state !== "confirmed")
          throw new Error("Merge readiness requires a confirmed publication.");
        const repositoryMatch =
          /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//u.exec(
            confirmedPublication.prUrl
          );
        if (repositoryMatch?.[1] === undefined)
          throw new Error(
            "Confirmed publication has an invalid pull-request URL."
          );
        assertDeliveryMergeReadinessDecisionAuthority(decision, {
          enclosingRunId: event.runId,
          eventSequence: event.sequence,
          events,
          publication: confirmedPublication,
          repository: repositoryMatch[1],
        });
      }
    }
    if (event.type === "DELIVERY_MERGE_RECORDED") {
      const next = parseDeliveryMergeReceipt(event.payload["mergeAction"]);
      mergeActions.push({ receipt: next, sequence: event.sequence });
      deriveDeliveryMergeActionHistories(mergeActions);
    }
    if (event.type === "DELIVERY_CLEANUP_RECORDED") {
      if (
        deriveDeliveryMergeActionHistories(mergeActions).latest?.latest
          .state !== "dispatchConfirmed"
      )
        throw new Error("Cleanup requires a confirmed merge.");
      cleanupActions.push({
        receipt: parseDeliveryCleanupReceipt(event.payload["cleanup"]),
        sequence: event.sequence,
      });
      deriveDeliveryCleanupActionHistories(cleanupActions);
    }
    if (event.type === "WORKER_CONTINUATION_RECORDED") {
      const previousValue =
        actor.getSnapshot().context.delivery?.["workerContinuation"];
      if (previousValue !== undefined) {
        assertWorkerContinuationTransition(
          parseWorkerContinuationReceipt(previousValue),
          parseWorkerContinuationReceipt(event.payload["continuation"])
        );
      }
    }
    if (event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED") {
      const previousValue =
        actor.getSnapshot().context.delivery?.[
          "workerCorrelationReconciliation"
        ];
      if (previousValue !== undefined) {
        assertWorkerCorrelationReconciliationTransition(
          parseWorkerCorrelationReconciliationReceipt(previousValue),
          parseWorkerCorrelationReconciliationReceipt(
            event.payload["reconciliation"]
          )
        );
      }
    }
    if (event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED") {
      const previousValue =
        actor.getSnapshot().context.delivery?.[
          "workerDesktopOriginCorrelation"
        ];
      if (previousValue !== undefined) {
        assertWorkerDesktopOriginCorrelationTransition(
          parseWorkerDesktopOriginCorrelationReceipt(previousValue),
          parseWorkerDesktopOriginCorrelationReceipt(
            event.payload["desktopOriginCorrelation"]
          )
        );
      }
    }

    actor.send(toMachineEvent(event));
    if (
      event.type === "WORKSPACE_PREPARED" ||
      event.type === "WORKER_STARTED" ||
      event.type === "WORKER_COMPLETED" ||
      event.type === "WORKER_CONTINUATION_RECORDED" ||
      event.type === "WORKER_RECOVERY_RECORDED" ||
      event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED" ||
      event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED" ||
      event.type === "HARNESS_SESSION_EVENT_RECORDED"
    )
      crossedWorkerExecutionBoundary = true;
    expectedSequence += 1;
  }

  return actor.getSnapshot();
}

function applyClaimVerificationReplay(
  event: RunEvent,
  contract: RunContract | undefined,
  states: Map<string, ClaimVerificationReplayState>,
  contentAuthoritySequence: number
) {
  const key = (
    generationSequence: typeof RunEventSequenceSchema.Type,
    claimId: typeof ProofClaimIdSchema.Type
  ) => `${generationSequence}:${claimId}`;
  const requireV2CommandClaim = (claimId: typeof ProofClaimIdSchema.Type) => {
    if (contract?.version !== 2)
      throw new Error(
        "Claim-verification lifecycle requires a V2 run contract."
      );
    const claim = contract.proofClaims.find(
      (entry) => entry.claimId === claimId
    );
    if (claim?.kind !== "command")
      throw new Error(
        "Claim-verification lifecycle must bind a command claim."
      );
    return claim;
  };
  switch (event.type) {
    case "CLAIM_VERIFICATION_GENERATION_STARTED": {
      if (contract?.version !== 2)
        throw new Error(
          "Claim-verification generation requires a V2 contract."
        );
      const generation = Schema.decodeUnknownSync(
        ClaimVerificationGenerationStartedV1
      )(event.payload["generation"]);
      if (generation.contractDigest !== contract.contractDigest)
        throw new Error(
          "Claim-verification generation binds a stale contract."
        );
      if (generation.contentAuthoritySequence !== contentAuthoritySequence)
        throw new Error(
          "Claim-verification generation binds stale content authority."
        );
      if (new Set(generation.claimIds).size !== generation.claimIds.length)
        throw new Error("Claim-verification generation repeats a claim.");
      for (const claimId of generation.claimIds) {
        requireV2CommandClaim(claimId);
        const stateKey = key(event.sequence, claimId);
        if (states.has(stateKey))
          throw new Error("Claim-verification generation is duplicated.");
        states.set(stateKey, {
          claimId,
          contractDigest: generation.contractDigest,
          executionEvidenceIdentityDigest:
            generation.executionEvidenceIdentityDigest,
          generationSequence: event.sequence,
        });
      }
      return;
    }
    case "CLAIM_VERIFICATION_CREATE_INTENT_RECORDED": {
      const intent = Schema.decodeUnknownSync(ClaimVerificationCreateIntentV1)(
        event.payload["createIntent"]
      );
      const state = requireClaimVerificationState(states, intent);
      if (state.createIntent !== undefined)
        throw new Error("Claim-verification create intent is duplicated.");
      state.createIntent = intent;
      state.createIntentSequence = event.sequence;
      return;
    }
    case "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED": {
      const created = Schema.decodeUnknownSync(
        ClaimVerificationSandboxCreatedV1
      )(event.payload["sandboxCreated"]);
      const state = requireClaimVerificationState(states, created);
      if (
        state.createIntent === undefined ||
        state.createIntentSequence !== created.createIntentSequence ||
        state.createIntent.sandboxName !== created.sandboxName ||
        state.sandboxCreated !== undefined
      )
        throw new Error("Sandbox-created evidence has no exact create intent.");
      state.sandboxCreated = created;
      state.sandboxCreatedSequence = event.sequence;
      return;
    }
    case "CLAIM_VERIFICATION_COMMAND_START_RECORDED": {
      const start = Schema.decodeUnknownSync(ClaimVerificationCommandStartV1)(
        event.payload["commandStart"]
      );
      const state = requireClaimVerificationState(states, start);
      if (
        state.sandboxCreated === undefined ||
        state.sandboxCreatedSequence !== start.sandboxCreatedSequence ||
        state.sandboxCreated.sandboxName !== start.sandboxName ||
        state.sandboxCreated.sandboxUuid !== start.sandboxUuid ||
        state.commandStart !== undefined ||
        state.terminalSequence !== undefined
      )
        throw new Error("Command start has no exact sandbox-created prefix.");
      state.commandStart = start;
      state.commandStartSequence = event.sequence;
      return;
    }
    case "CLAIM_VERIFICATION_COMMAND_RECORDED": {
      const receipt = parseVerificationCommandReceipt(event.payload["receipt"]);
      const state = requireClaimVerificationState(states, receipt);
      const claim = requireV2CommandClaim(receipt.claimId);
      if (
        state.commandStart === undefined ||
        state.reconciliationSequence !== undefined ||
        state.commandStartSequence !== receipt.commandStartSequence ||
        state.commandStart.requestDigest !== receipt.requestDigest ||
        state.commandStart.sandboxName !== receipt.sandboxName ||
        state.commandStart.sandboxUuid !== receipt.sandboxUuid ||
        receipt.contractId !== contract!.contractId ||
        receipt.targetDigest !== contract!.targetDigest ||
        receipt.requestDigest !==
          makeVerificationCommandRequestDigest(claim.command) ||
        receipt.terminalSequence !== event.sequence ||
        state.terminalSequence !== undefined
      )
        throw new Error("Command receipt does not bind one unresolved start.");
      state.terminalSequence = event.sequence;
      state.receiptDigest = receipt.receiptDigest;
      return;
    }
    case "CLAIM_VERIFICATION_REUSE_RECORDED": {
      const reuse = Schema.decodeUnknownSync(ClaimVerificationReuseReceiptV1)(
        event.payload["reuse"]
      );
      const state = requireClaimVerificationState(states, reuse);
      const original = [...states.values()].find(
        (entry) =>
          entry.claimId === reuse.claimId &&
          entry.contractDigest === reuse.contractDigest &&
          entry.executionEvidenceIdentityDigest ===
            reuse.executionEvidenceIdentityDigest &&
          entry.commandStartSequence === reuse.originalCommandStartSequence &&
          entry.terminalSequence === reuse.originalTerminalSequence &&
          entry.receiptDigest === reuse.receiptDigest
      );
      if (
        original === undefined ||
        state.terminalSequence !== undefined ||
        state.reconciliationSequence !== undefined
      )
        throw new Error("Claim-verification reuse has no exact prior receipt.");
      state.terminalSequence = event.sequence;
      return;
    }
    case "CLAIM_VERIFICATION_RECONCILIATION_RECORDED": {
      const receipt = parseVerificationReconciliationReceipt(
        event.payload["reconciliation"]
      );
      const state = requireClaimVerificationState(states, receipt);
      const prefixMatches =
        receipt.reason === "createdWithoutCommandStart"
          ? state.sandboxCreated !== undefined &&
            state.commandStart === undefined &&
            state.sandboxCreatedSequence === receipt.priorSequence &&
            state.sandboxCreated.sandboxName === receipt.sandboxName &&
            state.sandboxCreated.sandboxUuid === receipt.sandboxUuid
          : state.commandStart !== undefined &&
            state.commandStartSequence === receipt.priorSequence &&
            state.commandStart.sandboxName === receipt.sandboxName &&
            state.commandStart.sandboxUuid === receipt.sandboxUuid &&
            state.terminalSequence === undefined;
      if (
        !prefixMatches ||
        state.reconciliationSequence !== undefined ||
        state.terminalSequence !== undefined
      )
        throw new Error(
          "Claim-verification reconciliation prior is not exact."
        );
      state.reconciliationSequence = event.sequence;
      state.terminalSequence = event.sequence;
      return;
    }
  }
}

function requireClaimVerificationState(
  states: ReadonlyMap<string, ClaimVerificationReplayState>,
  identity: ClaimVerificationReplayIdentity
) {
  const state = states.get(
    `${identity.generationSequence}:${identity.claimId}`
  );
  if (
    state === undefined ||
    state.contractDigest !== identity.contractDigest ||
    state.executionEvidenceIdentityDigest !==
      identity.executionEvidenceIdentityDigest
  )
    throw new Error("Claim-verification evidence is rebound or orphaned.");
  return state;
}

function assertMergeDecisionProofDescription(
  decision: MergeDecisionV2,
  authority: {
    readonly latestProofResult: RunProofResult | undefined;
    readonly legacyVerificationSequence: number | undefined;
    readonly runContract: RunContract | undefined;
  }
) {
  if (authority.runContract === undefined) {
    if (
      decision.proof.kind !== "noContract" ||
      decision.proof.legacyVerificationSequence !==
        authority.legacyVerificationSequence
    )
      throw new Error(
        "MergeDecisionV2 proof description does not match no-contract history."
      );
    return;
  }

  if (
    decision.proof.kind !== "contract" ||
    decision.proof.contractId !== authority.runContract.contractId ||
    decision.proof.contractDigest !== authority.runContract.contractDigest
  )
    throw new Error(
      "MergeDecisionV2 proof description does not match the run contract."
    );

  const result = authority.latestProofResult;
  if (result === undefined) {
    if (decision.proof.result.kind !== "missing")
      throw new Error(
        "MergeDecisionV2 proof description invents a missing run result."
      );
    return;
  }

  if (
    decision.proof.result.kind !== "recorded" ||
    decision.proof.result.sequence !== result.recordedBy.sequence ||
    decision.proof.result.resultDigest !== result.resultDigest ||
    decision.proof.result.aggregate !== result.aggregate ||
    decision.proof.result.observedTargetDigest !== result.observedTargetDigest
  )
    throw new Error(
      "MergeDecisionV2 proof description does not match the latest run result."
    );
}

function assertApprovedMergeDecisionReplayAuthority(
  decision: MergeDecisionV2,
  authority: {
    readonly contentAuthoritySequence: number;
    readonly evidenceReviewSequence: number | undefined;
    readonly latestProofResult: RunProofResult | undefined;
    readonly publicationConfirmationSequence: number | undefined;
  }
) {
  if (decision.status !== "approved") return;

  const proof = authority.latestProofResult;
  const proofDescription = decision.proof;
  const contractProof =
    proofDescription.kind === "contract" ? proofDescription : undefined;
  const recorded =
    contractProof?.result.kind === "recorded"
      ? contractProof.result
      : undefined;
  if (
    proof === undefined ||
    proof.aggregate !== "verified" ||
    recorded === undefined ||
    decision.contentAuthoritySequence !== authority.contentAuthoritySequence ||
    proof.recordedBy.sequence < authority.contentAuthoritySequence ||
    decision.evidenceReviewSequence === undefined ||
    decision.evidenceReviewSequence !== authority.evidenceReviewSequence ||
    decision.evidenceReviewSequence <= proof.recordedBy.sequence ||
    decision.publicationConfirmationSequence === undefined ||
    decision.publicationConfirmationSequence !==
      authority.publicationConfirmationSequence ||
    contractProof === undefined ||
    contractProof.contractId !== proof.contractId ||
    contractProof.contractDigest !== proof.contractDigest ||
    recorded.resultDigest !== proof.resultDigest ||
    recorded.sequence !== proof.recordedBy.sequence ||
    recorded.observedTargetDigest !== proof.observedTargetDigest
  )
    throw new Error(
      "Approved MergeDecisionV2 replay authority does not match proof, review, content, and publication events."
    );
}

function isDeliveryPublicationEvent(event: RunEvent) {
  return (
    event.type === "DELIVERY_PUBLICATION_INTENT_RECORDED" ||
    event.type === "DELIVERY_PUBLICATION_ATTEMPTED" ||
    event.type === "DELIVERY_PUBLICATION_CONFIRMED" ||
    event.type === "DELIVERY_PUBLICATION_FAILED" ||
    event.type === "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN"
  );
}

export function snapshotFromReplay(
  events: ReadonlyArray<RunEvent>
): RunSnapshot {
  const replayed = replayRunEvents(events);
  const latest = events.at(-1);

  if (latest === undefined) {
    throw new Error("Cannot create a snapshot from an empty event log.");
  }

  return RunSnapshot.make({
    context: snapshotContext(replayed.context),
    eventSequence: latest.sequence,
    runId: latest.runId,
    state: stateValueToRunState(replayed.value),
    timestamp: latest.timestamp,
    version: 1,
  });
}

function toMachineEvent(
  event: RunEvent
): Schema.Schema.Type<typeof RunMachineEventSchema> {
  return parseRunMachineEvent(toMachineEventInput(event));
}

function toMachineEventInput(event: RunEvent) {
  switch (event.type) {
    case "BROWSER_EVIDENCE_RECORDED":
      return {
        ...(getOptionalStringPayload(event, "evidenceKind") === undefined
          ? {}
          : {
              evidenceKind: getOptionalStringPayload(event, "evidenceKind"),
            }),
        evidencePath: getStringPayload(event, "evidencePath"),
        ...(getOptionalStringPayload(event, "evidenceSelector") === undefined
          ? {}
          : {
              evidenceSelector: getOptionalStringPayload(
                event,
                "evidenceSelector"
              ),
            }),
        status: getStringPayload(event, "status"),
        targetUrl: getStringPayload(event, "targetUrl"),
        type: event.type,
      };
    case "DELIVERY_READY_TO_PUBLISH":
      return {
        delivery: getJsonObjectPayload(event, "delivery"),
        reportPath: getOptionalStringPayload(event, "reportPath"),
        type: event.type,
      };
    case "DELIVERY_STARTED":
      return {
        delivery: getJsonObjectPayload(event, "delivery"),
        type: event.type,
      };
    case "DELIVERY_PUBLICATION_INTENT_RECORDED":
    case "DELIVERY_PUBLICATION_ATTEMPTED":
    case "DELIVERY_PUBLICATION_CONFIRMED":
    case "DELIVERY_PUBLICATION_FAILED":
    case "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN":
      return {
        publication: parseDeliveryPublication(event.payload["publication"]),
        type: event.type,
      };
    case "DELIVERY_REMEDIATION_RECORDED":
      return {
        eventSequence: event.sequence,
        remediation: parseDeliveryRemediation(event.payload["remediation"]),
        type: event.type,
      };
    case "DELIVERY_PR_READY_RECORDED":
      return {
        readyForReviewAction: parseDeliveryPullRequestReadyReceipt(
          event.payload["readyForReviewAction"]
        ),
        type: event.type,
      };
    case "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED":
      return {
        attestation: parseDeliveryLocalReviewAttestationReceipt(
          event.payload["attestation"]
        ),
        type: event.type,
      };
    case "DELIVERY_MERGE_RECORDED":
      return {
        mergeAction: parseDeliveryMergeReceipt(event.payload["mergeAction"]),
        type: event.type,
      };
    case "DELIVERY_MERGE_READINESS_RECORDED":
      return {
        decision: parseDeliveryMergeReadinessDecision(
          event.payload["decision"]
        ),
        eventSequence: event.sequence,
        type: event.type,
      };
    case "DELIVERY_CLEANUP_RECORDED":
      return {
        cleanup: parseDeliveryCleanupReceipt(event.payload["cleanup"]),
        type: event.type,
      };
    case "DELIVERY_CLEANUP_PROVENANCE_RECORDED":
    case "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED":
    case "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED":
      return { type: event.type };
    case "GITHUB_CHECKS_RECORDED":
      const watchStatePath = getOptionalStringPayload(event, "watchStatePath");
      return {
        checksPath: getStringPayload(event, "checksPath"),
        pullRequest: getStringPayload(event, "pullRequest"),
        status: normalizeGitHubChecksStatus(getStringPayload(event, "status")),
        type: event.type,
        ...(watchStatePath === undefined ? {} : { watchStatePath }),
      };
    case "GITHUB_FEEDBACK_RECORDED":
      return {
        commentCount: getNumberPayload(event, "commentCount"),
        feedbackPath: getStringPayload(event, "feedbackPath"),
        nextAction: getStringPayload(event, "nextAction"),
        pullRequest: getStringPayload(event, "pullRequest"),
        reviewCount: getNumberPayload(event, "reviewCount"),
        reviewRequestCount: getNumberPayload(event, "reviewRequestCount"),
        status: getStringPayload(event, "status"),
        type: event.type,
      };
    case "GITHUB_PR_LOOP_RECORDED":
      const observationValue = event.payload["observation"];
      const observation =
        observationValue === undefined
          ? undefined
          : parseDeliveryPullRequestObservation(observationValue);
      return {
        blockerCount: getNumberPayload(event, "blockerCount"),
        nextAction: getStringPayload(event, "nextAction"),
        ...(observation === undefined ? {} : { observation }),
        prLoopPath: getStringPayload(event, "prLoopPath"),
        pullRequest: getStringPayload(event, "pullRequest"),
        status: getStringPayload(event, "status"),
        type: event.type,
      };
    case "GITHUB_PR_COMMENT_RECORDED":
      const commentUrl = getOptionalStringPayload(event, "commentUrl");
      return {
        commentPath: getStringPayload(event, "commentPath"),
        pullRequest: getStringPayload(event, "pullRequest"),
        type: event.type,
        ...(commentUrl === undefined ? {} : { commentUrl }),
      };
    case "GITHUB_REMEDIATION_SPEC_RECORDED":
      return {
        blockerCount: getNumberPayload(event, "blockerCount"),
        nextAction: getStringPayload(event, "nextAction"),
        pullRequest: getStringPayload(event, "pullRequest"),
        remediationSpecPath: getStringPayload(event, "remediationSpecPath"),
        type: event.type,
      };
    case "LINEAR_ISSUE_GRAPH_RECORDED":
      const issueUrl = getOptionalStringPayload(event, "issueUrl");
      return {
        blockedByCount: getNumberPayload(event, "blockedByCount"),
        blocksCount: getNumberPayload(event, "blocksCount"),
        issueGraphPath: getStringPayload(event, "issueGraphPath"),
        issueIdentifier: getStringPayload(event, "issueIdentifier"),
        type: event.type,
        ...(issueUrl === undefined ? {} : { issueUrl }),
      };
    case "MERGE_DECISION_RECORDED":
      const currentDecision =
        event.payload["decision"] === undefined
          ? undefined
          : parseMergeDecisionV2(event.payload["decision"]);
      const pullRequest =
        currentDecision?.pr ?? getOptionalStringPayload(event, "pullRequest");
      return {
        blockerCount:
          currentDecision?.blockerCount ??
          getNumberPayload(event, "blockerCount"),
        mergeDecisionPath: getStringPayload(event, "mergeDecisionPath"),
        nextAction:
          currentDecision?.nextAction ?? getStringPayload(event, "nextAction"),
        status: currentDecision?.status ?? getStringPayload(event, "status"),
        type: event.type,
        ...(pullRequest === undefined ? {} : { pullRequest }),
      };
    case "PREVIEW_DEPLOYMENT_RECORDED":
      const url = getOptionalStringPayload(event, "url");
      return {
        deploymentPath: getStringPayload(event, "deploymentPath"),
        status: getStringPayload(event, "status"),
        type: event.type,
        ...(url === undefined ? {} : { url }),
      };
    case "REPORT_COMPLETED":
      return {
        reportPath: getStringPayload(event, "reportPath"),
        type: event.type,
      };
    case "REPORT_STARTED":
    case "REVIEW_STARTED":
    case "VERIFICATION_STARTED":
    case "WORKER_STARTED":
    case "CLAIM_VERIFICATION_GENERATION_STARTED":
    case "CLAIM_VERIFICATION_CREATE_INTENT_RECORDED":
    case "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED":
    case "CLAIM_VERIFICATION_COMMAND_START_RECORDED":
    case "CLAIM_VERIFICATION_COMMAND_RECORDED":
    case "CLAIM_VERIFICATION_REUSE_RECORDED":
    case "CLAIM_VERIFICATION_RECONCILIATION_RECORDED":
      return { type: event.type };
    case "HARNESS_SESSION_EVENT_RECORDED":
      return { type: event.type };
    case "WORKER_RECOVERY_RECORDED":
      return {
        recovery: parseWorkerRecoveryReceipt(event.payload["recovery"]),
        type: event.type,
      };
    case "WORKER_CONTINUATION_RECORDED":
      return {
        continuation: parseWorkerContinuationReceipt(
          event.payload["continuation"]
        ),
        type: event.type,
      };
    case "WORKER_CORRELATION_RECONCILIATION_RECORDED":
      return {
        reconciliation: parseWorkerCorrelationReconciliationReceipt(
          event.payload["reconciliation"]
        ),
        type: event.type,
      };
    case "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED":
      return {
        desktopOriginCorrelation: parseWorkerDesktopOriginCorrelationReceipt(
          event.payload["desktopOriginCorrelation"]
        ),
        type: event.type,
      };
    case "REVIEW_COMPLETED":
      const reviewerSessionEvidencePath = getOptionalStringPayload(
        event,
        "reviewerSessionEvidencePath"
      );
      return {
        phase: getReviewPhasePayload(event, "phase"),
        reviewPath: getStringPayload(event, "reviewPath"),
        type: event.type,
        ...(reviewerSessionEvidencePath === undefined
          ? {}
          : { reviewerSessionEvidencePath }),
      };
    case "RUN_CREATED":
      return {
        runId: event.runId,
        specPath: getStringPayload(event, "specPath"),
        type: event.type,
      };
    case "RUN_CONTRACT_RECORDED":
      return {
        contract: parseAnyRunContract(event.payload["contract"]),
        type: event.type,
      };
    case "RUN_PROOF_RESULT_RECORDED":
      return {
        result: parseAnyRunProofResultEnvelope(event.payload["result"]),
        type: event.type,
        verificationResultPath: getStringPayload(
          event,
          "verificationResultPath"
        ),
      };
    case "RUN_FAILED":
      return {
        failure: GaiaFailure.make({
          code: getStringPayload(event, "code"),
          message: getStringPayload(event, "message"),
          recoverable: getBooleanPayload(event, "recoverable"),
          stage: getFailureStagePayload(event, "stage"),
        }),
        type: event.type,
      };
    case "VERIFICATION_COMPLETED":
      return {
        runId: event.runId,
        sequence: event.sequence,
        type: event.type,
        verificationResultPath: getStringPayload(
          event,
          "verificationResultPath"
        ),
      };
    case "WORKER_COMPLETED":
      return {
        type: event.type,
        workerResultPath: getStringPayload(event, "workerResultPath"),
      };
    case "WORKSPACE_PREPARED":
      return {
        type: event.type,
        workspacePath: getStringPayload(event, "workspacePath"),
      };
  }
}

function normalizeGitHubChecksStatus(status: string): string {
  switch (status) {
    case "failed":
      return "failing";
    case "no-checks":
      return "no-checks-configured";
    case "passed":
      return "green";
    default:
      return status;
  }
}

function deliveryWithPublication(
  delivery: Record<string, Schema.Json> | undefined,
  publication: DeliveryPublication
): Record<string, Schema.Json> {
  assertPublicationDeliveryIdentity(delivery, publication);
  if (delivery === undefined) {
    throw new Error(
      "Publication requires accepted pull-request delivery state."
    );
  }
  if (
    delivery["workerEvidenceEpochSequence"] !== undefined &&
    delivery["stage"] !== "readyToPublish"
  ) {
    throw new Error(
      "Publication requires fresh post-continuation ready evidence."
    );
  }

  const previousValue = delivery["publication"];
  const previous =
    previousValue === undefined
      ? undefined
      : parseDeliveryPublication(previousValue);
  validatePublicationTransition(previous, publication);

  return {
    ...delivery,
    publication: encodeDeliveryPublicationJson(publication),
    stage: publicationStage(publication),
  };
}

function deliveryWithWorkerContinuation(
  delivery: Record<string, Schema.Json> | undefined,
  continuation: WorkerContinuationReceipt
): Record<string, Schema.Json> {
  if (delivery === undefined || delivery["mode"] !== "pullRequest") {
    throw new Error(
      "Worker continuation requires accepted pull-request delivery state."
    );
  }
  const previousValue = delivery["workerContinuation"];
  const previous =
    previousValue === undefined
      ? undefined
      : parseWorkerContinuationReceipt(previousValue);
  assertWorkerContinuationTransition(previous, continuation);
  const stage = workerContinuationProjection(continuation);
  const priorStage = delivery["stage"];
  const nextStage =
    stage ?? (typeof priorStage === "string" ? priorStage : undefined);
  if (nextStage === undefined) {
    throw new Error("Worker continuation requires an existing delivery stage.");
  }
  return {
    ...delivery,
    stage: nextStage,
    workerContinuation: encodeWorkerContinuationReceiptJson(continuation),
    workerEvidenceEpochSequence: continuation.workerEvidenceEpochSequence,
  };
}

function deliveryWithWorkerCorrelationReconciliation(
  delivery: Record<string, Schema.Json> | undefined,
  reconciliation: WorkerCorrelationReconciliationReceipt
): Record<string, Schema.Json> {
  if (delivery === undefined || delivery["mode"] !== "pullRequest") {
    throw new Error(
      "Worker correlation reconciliation requires accepted pull-request delivery state."
    );
  }
  const previousValue = delivery["workerCorrelationReconciliation"];
  const previous =
    previousValue === undefined
      ? undefined
      : parseWorkerCorrelationReconciliationReceipt(previousValue);
  assertWorkerCorrelationReconciliationTransition(previous, reconciliation);
  const stage = workerCorrelationReconciliationProjection(reconciliation);
  const priorStage = delivery["stage"];
  const nextStage =
    stage ?? (typeof priorStage === "string" ? priorStage : undefined);
  if (nextStage === undefined) {
    throw new Error(
      "Worker correlation reconciliation requires an existing delivery stage."
    );
  }
  return {
    ...delivery,
    stage: nextStage,
    workerCorrelationReconciliation:
      encodeWorkerCorrelationReconciliationReceiptJson(reconciliation),
    workerEvidenceEpochSequence: reconciliation.workerEvidenceEpochSequence,
  };
}

function deliveryWithWorkerDesktopOriginCorrelation(
  delivery: Record<string, Schema.Json> | undefined,
  desktopOriginCorrelation: WorkerDesktopOriginCorrelationReceipt
): Record<string, Schema.Json> {
  if (delivery === undefined || delivery["mode"] !== "pullRequest") {
    throw new Error(
      "Worker desktop-origin correlation requires accepted pull-request delivery state."
    );
  }
  const previousValue = delivery["workerDesktopOriginCorrelation"];
  const previous =
    previousValue === undefined
      ? undefined
      : parseWorkerDesktopOriginCorrelationReceipt(previousValue);
  assertWorkerDesktopOriginCorrelationTransition(
    previous,
    desktopOriginCorrelation
  );
  const stage = workerDesktopOriginCorrelationProjection(
    desktopOriginCorrelation
  );
  const priorStage = delivery["stage"];
  const nextStage =
    stage ?? (typeof priorStage === "string" ? priorStage : undefined);
  if (nextStage === undefined) {
    throw new Error(
      "Worker desktop-origin correlation requires an existing delivery stage."
    );
  }
  return {
    ...delivery,
    stage: nextStage,
    workerDesktopOriginCorrelation:
      encodeWorkerDesktopOriginCorrelationReceiptJson(desktopOriginCorrelation),
    workerEvidenceEpochSequence:
      desktopOriginCorrelation.workerEvidenceEpochSequence,
  };
}

function assertWorkerContinuationTransition(
  previous: WorkerContinuationReceipt | undefined,
  next: WorkerContinuationReceipt
) {
  if (previous === undefined) {
    if (next.state !== "intentRecorded") {
      throw new Error(
        "Worker continuation must record intent before continuation work."
      );
    }
    return;
  }
  if (
    JSON.stringify(workerContinuationBinding(previous)) !==
    JSON.stringify(workerContinuationBinding(next))
  ) {
    throw new Error(
      "Worker continuation action is already bound to different immutable input."
    );
  }
  const previousRank = workerContinuationStateRank(previous.state);
  const nextRank = workerContinuationStateRank(next.state);
  if (
    previousRank === undefined ||
    nextRank === undefined ||
    nextRank < previousRank
  ) {
    throw new Error("Worker continuation cannot move backward.");
  }
  if (
    (previous.state === "failed" ||
      previous.state === "outcomeUnknown" ||
      previous.state === "workerCompleted") &&
    previous.state !== next.state
  ) {
    throw new Error("Terminal worker continuation state cannot change.");
  }
}

function assertWorkerCorrelationReconciliationTransition(
  previous: WorkerCorrelationReconciliationReceipt | undefined,
  next: WorkerCorrelationReconciliationReceipt
) {
  if (previous === undefined) {
    if (next.state !== "intentRecorded") {
      throw new Error(
        "Worker correlation reconciliation must record intent before continuation work."
      );
    }
    return;
  }
  if (
    JSON.stringify(workerCorrelationReconciliationBinding(previous)) !==
    JSON.stringify(workerCorrelationReconciliationBinding(next))
  ) {
    throw new Error(
      "Worker correlation reconciliation action is already bound to different immutable input."
    );
  }
  if (
    !isLegalWorkerCorrelationReconciliationTransition(
      previous.state,
      next.state
    )
  ) {
    throw new Error(
      `Worker correlation reconciliation cannot transition from ${previous.state} to ${next.state}.`
    );
  }
}

function workerContinuationBinding(receipt: WorkerContinuationReceipt) {
  return {
    actionId: receipt.actionId,
    expectedContaminatedReadySequence:
      receipt.expectedContaminatedReadySequence,
    expectedCurrentSequence: receipt.expectedCurrentSequence,
    expectedDeliveryProvenanceDigest: receipt.expectedDeliveryProvenanceDigest,
    expectedFailedRecoverySequence: receipt.expectedFailedRecoverySequence,
    expectedRecoveryActionId: receipt.expectedRecoveryActionId,
    expectedSessionId: receipt.expectedSessionId,
    harnessProfileId: receipt.harnessProfileId,
    maxAttempts: receipt.maxAttempts,
    workerEvidenceEpochSequence: receipt.workerEvidenceEpochSequence,
  };
}

function workerCorrelationReconciliationBinding(
  receipt: WorkerCorrelationReconciliationReceipt
) {
  return {
    actionId: receipt.actionId,
    expectedContaminatedReadySequence:
      receipt.expectedContaminatedReadySequence,
    expectedContinuationActionId: receipt.expectedContinuationActionId,
    expectedCurrentSequence: receipt.expectedCurrentSequence,
    expectedDeliveryProvenanceDigest: receipt.expectedDeliveryProvenanceDigest,
    expectedFailedContinuationSequence:
      receipt.expectedFailedContinuationSequence,
    expectedFailedRecoverySequence: receipt.expectedFailedRecoverySequence,
    expectedNativeTurnIdDigest: receipt.expectedNativeTurnIdDigest,
    expectedRecoveryActionId: receipt.expectedRecoveryActionId,
    expectedSessionId: receipt.expectedSessionId,
    harnessProfileId: receipt.harnessProfileId,
    maxAttempts: receipt.maxAttempts,
    workerEvidenceEpochSequence: receipt.workerEvidenceEpochSequence,
  };
}

function assertWorkerDesktopOriginCorrelationTransition(
  previous: WorkerDesktopOriginCorrelationReceipt | undefined,
  next: WorkerDesktopOriginCorrelationReceipt
) {
  if (previous === undefined) {
    if (next.state !== "intentRecorded") {
      throw new Error(
        "Worker desktop-origin correlation must record intent before continuation work."
      );
    }
    return;
  }
  if (
    JSON.stringify(workerDesktopOriginCorrelationBinding(previous)) !==
    JSON.stringify(workerDesktopOriginCorrelationBinding(next))
  ) {
    throw new Error(
      "Worker desktop-origin correlation action is already bound to different immutable input."
    );
  }
  if (
    !isLegalWorkerDesktopOriginCorrelationTransition(previous.state, next.state)
  ) {
    throw new Error(
      `Worker desktop-origin correlation cannot transition from ${previous.state} to ${next.state}.`
    );
  }
}

function workerDesktopOriginCorrelationBinding(
  receipt: WorkerDesktopOriginCorrelationReceipt
) {
  return {
    actionId: receipt.actionId,
    expectedContaminatedReadySequence:
      receipt.expectedContaminatedReadySequence,
    expectedContinuationActionId: receipt.expectedContinuationActionId,
    expectedCorrelationActionId: receipt.expectedCorrelationActionId,
    expectedCurrentSequence: receipt.expectedCurrentSequence,
    expectedDeliveryProvenanceDigest: receipt.expectedDeliveryProvenanceDigest,
    expectedFailedContinuationSequence:
      receipt.expectedFailedContinuationSequence,
    expectedFailedCorrelationSequence:
      receipt.expectedFailedCorrelationSequence,
    expectedFailedRecoverySequence: receipt.expectedFailedRecoverySequence,
    expectedNativeTurnIdDigest: receipt.expectedNativeTurnIdDigest,
    expectedRecoveryActionId: receipt.expectedRecoveryActionId,
    expectedSessionId: receipt.expectedSessionId,
    harnessProfileId: receipt.harnessProfileId,
    maxAttempts: receipt.maxAttempts,
    workerEvidenceEpochSequence: receipt.workerEvidenceEpochSequence,
  };
}

function workerContinuationStateRank(
  state: WorkerContinuationReceipt["state"]
) {
  switch (state) {
    case "intentRecorded":
      return 0;
    case "resumeAttempted":
      return 1;
    case "resumeConfirmed":
      return 2;
    case "followUpAttempted":
      return 3;
    case "followUpConfirmed":
      return 4;
    case "workerCompleted":
    case "failed":
    case "outcomeUnknown":
      return 5;
  }
}

function isLegalWorkerCorrelationReconciliationTransition(
  previous: WorkerCorrelationReconciliationReceipt["state"],
  next: WorkerCorrelationReconciliationReceipt["state"]
) {
  switch (previous) {
    case "intentRecorded":
      return next === "correlationAttempted";
    case "correlationAttempted":
      return (
        next === "correlationConfirmed" ||
        next === "failed" ||
        next === "outcomeUnknown"
      );
    case "correlationConfirmed":
      return next === "followUpAttempted";
    case "followUpAttempted":
      return next === "followUpConfirmed" || next === "outcomeUnknown";
    case "followUpConfirmed":
      return next === "workerCompleted" || next === "failed";
    case "failed":
    case "outcomeUnknown":
    case "workerCompleted":
      return false;
  }
}

function isLegalWorkerDesktopOriginCorrelationTransition(
  previous: WorkerDesktopOriginCorrelationReceipt["state"],
  next: WorkerDesktopOriginCorrelationReceipt["state"]
) {
  switch (previous) {
    case "intentRecorded":
      return next === "sourceCorrelationAttempted";
    case "sourceCorrelationAttempted":
      return (
        next === "sourceCorrelationConfirmed" ||
        next === "failed" ||
        next === "outcomeUnknown"
      );
    case "sourceCorrelationConfirmed":
      return next === "followUpAttempted";
    case "followUpAttempted":
      return next === "followUpConfirmed" || next === "outcomeUnknown";
    case "followUpConfirmed":
      return next === "workerCompleted" || next === "failed";
    case "failed":
    case "outcomeUnknown":
    case "workerCompleted":
      return false;
  }
}

function deliveryWithMerge(
  delivery: Record<string, Schema.Json> | undefined,
  mergeAction: DeliveryMergeReceipt
): Record<string, Schema.Json> {
  if (delivery?.["mode"] !== "pullRequest")
    throw new Error("Merge requires pull-request delivery.");
  return {
    ...delivery,
    stage:
      mergeAction.state === "dispatchConfirmed"
        ? "cleanupRequired"
        : mergeAction.state === "outcomeUnknown"
          ? "mergeReconciliationRequired"
          : mergeAction.state === "dispatchFailed"
            ? "awaitingMerge"
            : "merging",
  };
}

function deliveryWithCleanup(
  delivery: Record<string, Schema.Json> | undefined,
  cleanup: ReturnType<typeof parseDeliveryCleanupReceipt>
): Record<string, Schema.Json> {
  if (delivery?.["mode"] !== "pullRequest")
    throw new Error("Cleanup requires pull-request delivery.");
  return {
    ...delivery,
    stage: cleanup.state === "completed" ? "completed" : "cleanupRequired",
  };
}

function deliveryReadyToPublish(
  delivery: Record<string, Schema.Json> | undefined,
  ready: Record<string, Schema.Json>
): Record<string, Schema.Json> {
  if (delivery === undefined || delivery["mode"] !== "pullRequest") {
    throw new Error(
      "Ready publication requires accepted pull-request delivery state."
    );
  }
  if (
    ready["mode"] !== "pullRequest" ||
    ready["stage"] !== "readyToPublish" ||
    delivery["baseBranch"] !== ready["baseBranch"] ||
    delivery["baseRevision"] !== ready["baseRevision"] ||
    delivery["headBranch"] !== ready["headBranch"] ||
    delivery["remote"] !== ready["remote"]
  ) {
    throw new Error(
      "Ready publication identity does not match accepted delivery state."
    );
  }
  return { ...delivery, stage: "readyToPublish" };
}

function assertPublicationDeliveryIdentity(
  delivery: Record<string, Schema.Json> | undefined,
  publication: DeliveryPublication
) {
  if (delivery === undefined || delivery["mode"] !== "pullRequest") {
    throw new Error(
      "Publication requires accepted pull-request delivery state."
    );
  }
  if (
    delivery["baseBranch"] !== publication.baseBranch ||
    delivery["baseRevision"] !== publication.baseRevision ||
    delivery["headBranch"] !== publication.branchName
  ) {
    throw new Error(
      "Publication identity does not match accepted delivery provenance."
    );
  }
}

function validatePublicationTransition(
  previous: DeliveryPublication | undefined,
  next: DeliveryPublication
) {
  if (previous === undefined) {
    if (next.state !== "intentRecorded") {
      throw new Error("Publication must record intent before mutation.");
    }
    return;
  }

  if (next.state === "intentRecorded") {
    if (
      previous.state === "intentRecorded" &&
      previous.operationId === next.operationId
    ) {
      assertPublicationBinding(previous, next);
      if (previous.treeSha !== undefined && previous.treeSha !== next.treeSha) {
        throw new Error("Publication intent changed its prepared tree.");
      }
      return;
    }
    if (
      previous.state !== "failed" ||
      previous.operationId === next.operationId
    ) {
      throw new Error(
        "Publication intent cannot replace an active operation ID."
      );
    }
    return;
  }

  assertPublicationBinding(previous, next);
  assertMonotonicPublicationIdentity(previous, next);
  switch (next.state) {
    case "attempted":
      if (
        previous.state !== "intentRecorded" &&
        previous.state !== "outcomeUnknown"
      ) {
        throw new Error("Publication attempt requires matching intent.");
      }
      if (previous.treeSha === undefined || previous.treeSha !== next.treeSha) {
        throw new Error("Publication attempt changed the prepared tree.");
      }
      return;
    case "confirmed":
      if (
        previous.state !== "attempted" &&
        previous.state !== "outcomeUnknown"
      ) {
        throw new Error(
          "Publication confirmation requires an attempted operation."
        );
      }
      if (
        "commitSha" in previous &&
        previous.commitSha !== undefined &&
        previous.commitSha !== next.commitSha
      ) {
        throw new Error("Publication confirmation changed the owned commit.");
      }
      return;
    case "failed":
    case "outcomeUnknown":
      if (
        previous.state !== "intentRecorded" &&
        previous.state !== "attempted" &&
        previous.state !== "outcomeUnknown"
      ) {
        throw new Error("Publication outcome has no active operation.");
      }
      return;
  }
}

function assertPublicationBinding(
  previous: DeliveryPublication,
  next: DeliveryPublication
) {
  const previousBinding = publicationBinding(previous);
  const nextBinding = publicationBinding(next);
  if (JSON.stringify(previousBinding) !== JSON.stringify(nextBinding)) {
    throw new Error(
      "Publication operation ID is already bound to different immutable input."
    );
  }
}

function assertMonotonicPublicationIdentity(
  previous: DeliveryPublication,
  next: DeliveryPublication
) {
  if (previous.treeSha !== undefined && next.treeSha !== previous.treeSha) {
    throw new Error("Publication changed or discarded its known treeSha.");
  }
  const previousCommit =
    "commitSha" in previous ? previous.commitSha : undefined;
  const nextCommit = "commitSha" in next ? next.commitSha : undefined;
  if (previousCommit !== undefined && nextCommit !== previousCommit) {
    throw new Error("Publication changed or discarded its known commitSha.");
  }
}

function publicationBinding(publication: DeliveryPublication) {
  return {
    baseBranch: publication.baseBranch,
    baseRevision: publication.baseRevision,
    branchName: publication.branchName,
    commitMessage: publication.commitMessage,
    commitTimestamp: publication.commitTimestamp,
    digestVersion: publication.digestVersion,
    operationId: publication.operationId,
    payloadDigest: publication.payloadDigest,
    sourcePaths: publication.sourcePaths,
  };
}

function publicationStage(publication: DeliveryPublication) {
  switch (publication.state) {
    case "intentRecorded":
    case "attempted":
      return "publishing";
    case "confirmed":
      return "waitingForPr";
    case "failed":
      return "publicationFailed";
    case "outcomeUnknown":
      return "publicationOutcomeUnknown";
  }
}

function deliveryWithRemediation(
  delivery: Record<string, Schema.Json> | undefined,
  remediation: DeliveryRemediation,
  eventSequence: number
): Record<string, Schema.Json> {
  if (delivery === undefined || delivery["mode"] !== "pullRequest") {
    throw new Error(
      "Remediation requires accepted pull-request delivery state."
    );
  }
  const previousValue = delivery["remediation"];
  const previous =
    previousValue === undefined
      ? undefined
      : parseDeliveryRemediation(previousValue);
  validateDeliveryRemediationTransition(previous, remediation);
  const priorRearm = delivery["remediationRearmSequence"];
  const remediationRearmSequence =
    remediation.state === "intentRecorded" ? eventSequence : priorRearm;
  if (
    typeof remediationRearmSequence !== "number" ||
    !Number.isInteger(remediationRearmSequence) ||
    remediationRearmSequence < 1
  ) {
    throw new Error(
      "Remediation is missing its authoritative re-arm sequence."
    );
  }
  return {
    ...delivery,
    remediation: encodeDeliveryRemediationJson(remediation),
    remediationRearmSequence,
    stage: remediationStage(remediation),
  };
}

function deliveryWithPullRequestReady(
  delivery: Record<string, Schema.Json> | undefined,
  readyForReviewAction: DeliveryPullRequestReadyReceipt
): Record<string, Schema.Json> {
  if (delivery === undefined || delivery["mode"] !== "pullRequest") {
    throw new Error(
      "Ready-for-review action requires accepted pull-request delivery state."
    );
  }
  return {
    ...delivery,
    readyForReviewAction:
      encodeDeliveryPullRequestReadyReceiptJson(readyForReviewAction),
  };
}

function remediationStage(remediation: DeliveryRemediation) {
  switch (remediation.state) {
    case "intentRecorded":
    case "dispatchAttempted":
    case "turnCompleted":
    case "verified":
    case "commitAttempted":
    case "pushAttempted":
      return "remediating";
    case "confirmed":
      return "waitingForPr";
    case "failed":
      return "remediationFailed";
    case "outcomeUnknown":
      return "remediationOutcomeUnknown";
  }
}

function deliveryWithPullRequestObservation(
  delivery: Record<string, Schema.Json> | undefined,
  observation: DeliveryPullRequestObservation
): Record<string, Schema.Json> {
  if (delivery === undefined || delivery["mode"] !== "pullRequest") {
    throw new Error(
      "Pull-request observation requires accepted delivery state."
    );
  }
  const publicationValue = delivery["publication"];
  if (publicationValue === undefined) {
    throw new Error("Pull-request observation requires confirmed publication.");
  }
  const publication = parseDeliveryPublication(publicationValue);
  if (publication.state !== "confirmed") {
    throw new Error("Pull-request observation requires confirmed publication.");
  }
  const url =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)$/u.exec(
      publication.prUrl
    );
  const remediationValue = delivery["remediation"];
  const remediation =
    remediationValue === undefined
      ? undefined
      : parseDeliveryRemediation(remediationValue);
  const allowedHeads = new Set([
    publication.commitSha,
    ...(remediation !== undefined && "commitSha" in remediation
      ? [remediation.commitSha]
      : []),
  ]);
  if (
    url?.[1] === undefined ||
    url[2] === undefined ||
    observation.repository !== `${url[1]}/${url[2]}` ||
    observation.prNumber !== publication.prNumber ||
    observation.prUrl !== publication.prUrl ||
    !allowedHeads.has(observation.headSha)
  ) {
    throw new Error("Pull-request observation changed its confirmed identity.");
  }
  return {
    ...delivery,
    observation: encodeDeliveryPullRequestObservationJson(observation),
  };
}

function getStringPayload(event: RunEvent, key: string): string {
  const value = event.payload[key];
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Event ${event.type} is missing string payload '${key}'.`);
}

function getBooleanPayload(event: RunEvent, key: string): boolean {
  const value = event.payload[key];
  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`Event ${event.type} is missing boolean payload '${key}'.`);
}

function getNumberPayload(event: RunEvent, key: string): number {
  const value = event.payload[key];
  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Event ${event.type} is missing number payload '${key}'.`);
}

function getOptionalStringPayload(
  event: RunEvent,
  key: string
): string | undefined {
  const value = event.payload[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Event ${event.type} has invalid string payload '${key}'.`);
}

function getJsonObjectPayload(
  event: RunEvent,
  key: string
): Record<string, Schema.Json> {
  const value = event.payload[key];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // SAFETY: Array and null are excluded above; Schema.Json object values are string-keyed JSON records.
    return value as Record<string, Schema.Json>;
  }

  throw new Error(`Event ${event.type} is missing object payload '${key}'.`);
}

function getFailureStagePayload(event: RunEvent, key: string) {
  const value = getStringPayload(event, key);
  return Schema.decodeUnknownSync(FailureStageSchema)(value);
}

function getReviewPhasePayload(event: RunEvent, key: string) {
  const value = getStringPayload(event, key);
  return Schema.decodeUnknownSync(ReviewPhaseSchema)(value);
}

function snapshotContext(
  context: RunMachineContext
): Readonly<Record<string, Schema.Json>> {
  const output: Record<string, Schema.Json> = {};

  if (context.browserEvidencePath !== undefined) {
    output.browserEvidencePath = context.browserEvidencePath;
  }
  if (context.browserEvidenceStatus !== undefined) {
    output.browserEvidenceStatus = context.browserEvidenceStatus;
  }
  if (context.browserEvidenceTargetUrl !== undefined) {
    output.browserEvidenceTargetUrl = context.browserEvidenceTargetUrl;
  }
  if (context.evidenceReviewPath !== undefined) {
    output.evidenceReviewPath = context.evidenceReviewPath;
  }
  if (context.delivery !== undefined) {
    output.delivery = context.delivery;
  }
  if (context.runProof !== undefined) {
    output.runProof = Schema.encodeSync(RunProofProjectionSchema)(
      Schema.decodeUnknownSync(RunProofProjectionSchema)(context.runProof)
    );
  }
  if (context.githubChecksPath !== undefined) {
    output.githubChecksPath = context.githubChecksPath;
  }
  if (context.githubChecksStatus !== undefined) {
    output.githubChecksStatus = context.githubChecksStatus;
  }
  if (context.githubFeedbackCommentCount !== undefined) {
    output.githubFeedbackCommentCount = context.githubFeedbackCommentCount;
  }
  if (context.githubFeedbackNextAction !== undefined) {
    output.githubFeedbackNextAction = context.githubFeedbackNextAction;
  }
  if (context.githubFeedbackPath !== undefined) {
    output.githubFeedbackPath = context.githubFeedbackPath;
  }
  if (context.githubFeedbackReviewCount !== undefined) {
    output.githubFeedbackReviewCount = context.githubFeedbackReviewCount;
  }
  if (context.githubFeedbackReviewRequestCount !== undefined) {
    output.githubFeedbackReviewRequestCount =
      context.githubFeedbackReviewRequestCount;
  }
  if (context.githubFeedbackStatus !== undefined) {
    output.githubFeedbackStatus = context.githubFeedbackStatus;
  }
  if (context.githubPrCommentPath !== undefined) {
    output.githubPrCommentPath = context.githubPrCommentPath;
  }
  if (context.githubPrCommentUrl !== undefined) {
    output.githubPrCommentUrl = context.githubPrCommentUrl;
  }
  if (context.githubPrLoopBlockerCount !== undefined) {
    output.githubPrLoopBlockerCount = context.githubPrLoopBlockerCount;
  }
  if (context.githubPrLoopNextAction !== undefined) {
    output.githubPrLoopNextAction = context.githubPrLoopNextAction;
  }
  if (context.githubPrLoopPath !== undefined) {
    output.githubPrLoopPath = context.githubPrLoopPath;
  }
  if (context.githubPrLoopStatus !== undefined) {
    output.githubPrLoopStatus = context.githubPrLoopStatus;
  }
  if (context.githubPullRequest !== undefined) {
    output.githubPullRequest = context.githubPullRequest;
  }
  if (context.githubRemediationBlockerCount !== undefined) {
    output.githubRemediationBlockerCount =
      context.githubRemediationBlockerCount;
  }
  if (context.githubRemediationNextAction !== undefined) {
    output.githubRemediationNextAction = context.githubRemediationNextAction;
  }
  if (context.githubRemediationSpecPath !== undefined) {
    output.githubRemediationSpecPath = context.githubRemediationSpecPath;
  }
  if (context.githubWatchStatePath !== undefined) {
    output.githubWatchStatePath = context.githubWatchStatePath;
  }
  if (context.linearBlockedByCount !== undefined) {
    output.linearBlockedByCount = context.linearBlockedByCount;
  }
  if (context.linearBlocksCount !== undefined) {
    output.linearBlocksCount = context.linearBlocksCount;
  }
  if (context.linearIssueGraphPath !== undefined) {
    output.linearIssueGraphPath = context.linearIssueGraphPath;
  }
  if (context.linearIssueIdentifier !== undefined) {
    output.linearIssueIdentifier = context.linearIssueIdentifier;
  }
  if (context.linearIssueUrl !== undefined) {
    output.linearIssueUrl = context.linearIssueUrl;
  }
  if (context.mergeDecisionBlockerCount !== undefined) {
    output.mergeDecisionBlockerCount = context.mergeDecisionBlockerCount;
  }
  if (context.mergeDecisionNextAction !== undefined) {
    output.mergeDecisionNextAction = context.mergeDecisionNextAction;
  }
  if (context.mergeDecisionPath !== undefined) {
    output.mergeDecisionPath = context.mergeDecisionPath;
  }
  if (context.mergeDecisionStatus !== undefined) {
    output.mergeDecisionStatus = context.mergeDecisionStatus;
  }
  if (context.planReviewPath !== undefined) {
    output.planReviewPath = context.planReviewPath;
  }
  if (context.previewDeploymentPath !== undefined) {
    output.previewDeploymentPath = context.previewDeploymentPath;
  }
  if (context.previewDeploymentStatus !== undefined) {
    output.previewDeploymentStatus = context.previewDeploymentStatus;
  }
  if (context.previewDeploymentUrl !== undefined) {
    output.previewDeploymentUrl = context.previewDeploymentUrl;
  }
  if (context.evidenceReviewerSessionPath !== undefined) {
    output.evidenceReviewerSessionPath = context.evidenceReviewerSessionPath;
  }
  if (context.planReviewerSessionPath !== undefined) {
    output.planReviewerSessionPath = context.planReviewerSessionPath;
  }
  if (context.reportPath !== undefined) {
    output.reportPath = context.reportPath;
  }
  if (context.runId !== undefined) {
    output.runId = context.runId;
  }
  if (context.specPath !== undefined) {
    output.specPath = context.specPath;
  }
  if (context.verificationResultPath !== undefined) {
    output.verificationResultPath = context.verificationResultPath;
  }
  if (context.workerResultPath !== undefined) {
    output.workerResultPath = context.workerResultPath;
  }
  if (context.workspacePath !== undefined) {
    output.workspacePath = context.workspacePath;
  }

  return output;
}

function stateValueToRunState(value: unknown): RunState {
  return Schema.decodeUnknownSync(RunStateSchema)(value);
}
