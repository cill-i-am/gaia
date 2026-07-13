import * as Schema from "effect/Schema";
import { assign, createActor, createMachine } from "xstate";

import {
  encodeDeliveryCleanupReceiptJson,
  encodeDeliveryMergeReceiptJson,
  parseDeliveryCleanupReceipt,
  parseDeliveryMergeReceipt,
  parseDeliveryMergeReadinessDecision,
  encodeDeliveryMergeReadinessDecisionJson,
  type DeliveryMergeReceipt,
  deriveDeliveryMergeActionHistories,
  deriveDeliveryCleanupActionHistories,
  deriveDeliveryPullRequestReadyActionHistories,
  assertDeliveryPullRequestReadyAuthority,
  encodeDeliveryPullRequestReadyReceiptJson,
  parseDeliveryPullRequestReadyReceipt,
  type DeliveryPullRequestReadyReceipt,
  deriveDeliveryLocalReviewAttestationHistories,
  assertDeliveryLocalReviewAttestationAuthority,
  assertDeliveryMergeReadinessDecisionAuthority,
  DeliveryMergeReadinessDecisionV2,
  parseDeliveryLocalReviewAttestationReceipt,
  type DeliveryLocalReviewAttestationReceipt,
} from "./delivery-merge.js";
import {
  encodeDeliveryPublicationJson,
  parseDeliveryPublication,
  type DeliveryPublication,
} from "./delivery-publication.js";
import {
  encodeDeliveryPullRequestObservationJson,
  encodeDeliveryRemediationJson,
  deriveAuthoritativeDeliveryHeadSha,
  parseDeliveryPullRequestObservation,
  parseDeliveryRemediation,
  validateDeliveryRemediationTransition,
  type DeliveryPullRequestObservation,
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
import type { RunId } from "./run-id.js";
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
  type WorkerCorrelationReconciliationReceipt,
  type WorkerDesktopOriginCorrelationReceipt,
  type WorkerRecoveryReceipt,
} from "./worker-recovery.js";

export type RunMachineContext = {
  readonly browserEvidencePath: string | undefined;
  readonly browserEvidenceStatus: string | undefined;
  readonly browserEvidenceTargetUrl: string | undefined;
  readonly delivery: Record<string, Schema.Json> | undefined;
  readonly evidenceReviewPath: string | undefined;
  readonly failure: GaiaFailure | undefined;
  readonly githubChecksPath: string | undefined;
  readonly githubChecksStatus: string | undefined;
  readonly githubFeedbackCommentCount: number | undefined;
  readonly githubFeedbackNextAction: string | undefined;
  readonly githubFeedbackPath: string | undefined;
  readonly githubFeedbackReviewCount: number | undefined;
  readonly githubFeedbackReviewRequestCount: number | undefined;
  readonly githubFeedbackStatus: string | undefined;
  readonly githubPrCommentPath: string | undefined;
  readonly githubPrCommentUrl: string | undefined;
  readonly githubPrLoopBlockerCount: number | undefined;
  readonly githubPrLoopNextAction: string | undefined;
  readonly githubPrLoopPath: string | undefined;
  readonly githubPrLoopStatus: string | undefined;
  readonly githubPullRequest: string | undefined;
  readonly githubRemediationBlockerCount: number | undefined;
  readonly githubRemediationNextAction: string | undefined;
  readonly githubRemediationSpecPath: string | undefined;
  readonly githubWatchStatePath: string | undefined;
  readonly lastEventSequence: number;
  readonly evidenceReviewerSessionPath: string | undefined;
  readonly linearBlockedByCount: number | undefined;
  readonly linearBlocksCount: number | undefined;
  readonly linearIssueGraphPath: string | undefined;
  readonly linearIssueIdentifier: string | undefined;
  readonly linearIssueUrl: string | undefined;
  readonly mergeDecisionBlockerCount: number | undefined;
  readonly mergeDecisionNextAction: string | undefined;
  readonly mergeDecisionPath: string | undefined;
  readonly mergeDecisionStatus: string | undefined;
  readonly planReviewPath: string | undefined;
  readonly planReviewerSessionPath: string | undefined;
  readonly previewDeploymentPath: string | undefined;
  readonly previewDeploymentStatus: string | undefined;
  readonly previewDeploymentUrl: string | undefined;
  readonly reportPath: string | undefined;
  readonly runId: RunId | undefined;
  readonly specPath: string | undefined;
  readonly verificationResultPath: string | undefined;
  readonly workerResultPath: string | undefined;
  readonly workspacePath: string | undefined;
};

export type RunMachineEvent =
  | {
      readonly type: "RUN_CREATED";
      readonly runId: RunId;
      readonly specPath: string;
    }
  | {
      readonly type: "DELIVERY_STARTED";
      readonly delivery: Record<string, Schema.Json>;
    }
  | {
      readonly type: "DELIVERY_READY_TO_PUBLISH";
      readonly delivery: Record<string, Schema.Json>;
      readonly reportPath: string | undefined;
    }
  | {
      readonly type:
        | "DELIVERY_PUBLICATION_INTENT_RECORDED"
        | "DELIVERY_PUBLICATION_ATTEMPTED"
        | "DELIVERY_PUBLICATION_CONFIRMED"
        | "DELIVERY_PUBLICATION_FAILED"
        | "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN";
      readonly publication: DeliveryPublication;
    }
  | {
      readonly eventSequence: number;
      readonly remediation: DeliveryRemediation;
      readonly type: "DELIVERY_REMEDIATION_RECORDED";
    }
  | {
      readonly type: "DELIVERY_PR_READY_RECORDED";
      readonly readyForReviewAction: DeliveryPullRequestReadyReceipt;
    }
  | {
      readonly type: "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED";
      readonly attestation: DeliveryLocalReviewAttestationReceipt;
    }
  | {
      readonly type: "DELIVERY_MERGE_RECORDED";
      readonly mergeAction: DeliveryMergeReceipt;
    }
  | {
      readonly type: "DELIVERY_MERGE_READINESS_RECORDED";
      readonly decision: ReturnType<typeof parseDeliveryMergeReadinessDecision>;
      readonly eventSequence: number;
    }
  | {
      readonly type: "DELIVERY_CLEANUP_RECORDED";
      readonly cleanup: ReturnType<typeof parseDeliveryCleanupReceipt>;
    }
  | {
      readonly type:
        | "DELIVERY_CLEANUP_PROVENANCE_RECORDED"
        | "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED"
        | "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED";
    }
  | { readonly type: "WORKSPACE_PREPARED"; readonly workspacePath: string }
  | { readonly type: "REVIEW_STARTED" }
  | {
      readonly type: "REVIEW_COMPLETED";
      readonly phase: typeof ReviewPhaseSchema.Type;
      readonly reviewPath: string;
      readonly reviewerSessionEvidencePath?: string;
    }
  | { readonly type: "WORKER_STARTED" }
  | { readonly type: "WORKER_COMPLETED"; readonly workerResultPath: string }
  | {
      readonly type: "PREVIEW_DEPLOYMENT_RECORDED";
      readonly deploymentPath: string;
      readonly status: string;
      readonly url?: string;
    }
  | { readonly type: "VERIFICATION_STARTED" }
  | {
      readonly type: "VERIFICATION_COMPLETED";
      readonly verificationResultPath: string;
    }
  | {
      readonly type: "BROWSER_EVIDENCE_RECORDED";
      readonly evidencePath: string;
      readonly status: string;
      readonly targetUrl: string;
    }
  | { readonly type: "REPORT_STARTED" }
  | { readonly type: "REPORT_COMPLETED"; readonly reportPath: string }
  | {
      readonly type: "GITHUB_CHECKS_RECORDED";
      readonly checksPath: string;
      readonly pullRequest: string;
      readonly status: string;
      readonly watchStatePath?: string;
    }
  | {
      readonly type: "GITHUB_FEEDBACK_RECORDED";
      readonly commentCount: number;
      readonly feedbackPath: string;
      readonly nextAction: string;
      readonly pullRequest: string;
      readonly reviewCount: number;
      readonly reviewRequestCount: number;
      readonly status: string;
    }
  | {
      readonly type: "GITHUB_PR_LOOP_RECORDED";
      readonly blockerCount: number;
      readonly nextAction: string;
      readonly observation?: DeliveryPullRequestObservation;
      readonly prLoopPath: string;
      readonly pullRequest: string;
      readonly status: string;
    }
  | {
      readonly type: "GITHUB_PR_COMMENT_RECORDED";
      readonly commentPath: string;
      readonly commentUrl?: string;
      readonly pullRequest: string;
    }
  | {
      readonly type: "GITHUB_REMEDIATION_SPEC_RECORDED";
      readonly blockerCount: number;
      readonly nextAction: string;
      readonly pullRequest: string;
      readonly remediationSpecPath: string;
    }
  | {
      readonly type: "LINEAR_ISSUE_GRAPH_RECORDED";
      readonly blockedByCount: number;
      readonly blocksCount: number;
      readonly issueGraphPath: string;
      readonly issueIdentifier: string;
      readonly issueUrl?: string;
    }
  | {
      readonly type: "MERGE_DECISION_RECORDED";
      readonly blockerCount: number;
      readonly mergeDecisionPath: string;
      readonly nextAction: string;
      readonly pullRequest?: string;
      readonly status: string;
    }
  | { readonly type: "HARNESS_SESSION_EVENT_RECORDED" }
  | {
      readonly type: "WORKER_RECOVERY_RECORDED";
      readonly recovery: WorkerRecoveryReceipt;
    }
  | {
      readonly continuation: WorkerContinuationReceipt;
      readonly type: "WORKER_CONTINUATION_RECORDED";
    }
  | {
      readonly reconciliation: WorkerCorrelationReconciliationReceipt;
      readonly type: "WORKER_CORRELATION_RECONCILIATION_RECORDED";
    }
  | {
      readonly desktopOriginCorrelation: WorkerDesktopOriginCorrelationReceipt;
      readonly type: "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED";
    }
  | { readonly type: "RUN_FAILED"; readonly failure: GaiaFailure };

const initialContext: RunMachineContext = {
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
  runId: undefined,
  specPath: undefined,
  verificationResultPath: undefined,
  workerResultPath: undefined,
  workspacePath: undefined,
};

export const runMachine = createMachine({
  types: {} as {
    context: RunMachineContext;
    events: RunMachineEvent;
  },
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
}).provide({
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
        event.type === "GITHUB_CHECKS_RECORDED" ? event.checksPath : undefined,
      githubChecksStatus: ({ event }) =>
        event.type === "GITHUB_CHECKS_RECORDED" ? event.status : undefined,
      githubPullRequest: ({ event }) =>
        event.type === "GITHUB_CHECKS_RECORDED" ? event.pullRequest : undefined,
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
          ? deliveryWithWorkerContinuation(context.delivery, event.continuation)
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
              stage: event.decision.approved ? "awaitingMerge" : "waitingForPr",
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
        event.type === "GITHUB_PR_LOOP_RECORDED" ? event.nextAction : undefined,
      githubPrLoopPath: ({ event }) =>
        event.type === "GITHUB_PR_LOOP_RECORDED" ? event.prLoopPath : undefined,
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
        event.type === "MERGE_DECISION_RECORDED" ? event.nextAction : undefined,
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
        event.type === "PREVIEW_DEPLOYMENT_RECORDED" ? event.status : undefined,
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
      verificationResultPath: ({ event }) =>
        event.type === "VERIFICATION_COMPLETED"
          ? event.verificationResultPath
          : undefined,
    }),
    recordWorkerCompleted: assign({
      workerResultPath: ({ event }) =>
        event.type === "WORKER_COMPLETED" ? event.workerResultPath : undefined,
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
      (event.desktopOriginCorrelation.state === "sourceCorrelationAttempted" ||
        event.desktopOriginCorrelation.state === "sourceCorrelationConfirmed" ||
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
  let publication: DeliveryPublication | undefined;
  let remediation: DeliveryRemediation | undefined;
  const readyForReviewActions: Array<{
    receipt: DeliveryPullRequestReadyReceipt;
    sequence: number;
  }> = [];
  const localReviewAttestations: Array<{
    receipt: DeliveryLocalReviewAttestationReceipt;
    sequence: number;
  }> = [];
  const mergeActions: Array<{
    receipt: DeliveryMergeReceipt;
    sequence: number;
  }> = [];
  const cleanupActions: Array<{
    receipt: ReturnType<typeof parseDeliveryCleanupReceipt>;
    sequence: number;
  }> = [];

  for (const event of events) {
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Invalid event sequence: expected ${expectedSequence}, received ${event.sequence}.`
      );
    }

    if (isDeliveryPublicationEvent(event)) {
      const next = parseDeliveryPublication(event.payload["publication"]);
      assertPublicationDeliveryIdentity(
        actor.getSnapshot().context.delivery,
        next
      );
      validatePublicationTransition(publication, next);
      publication = next;
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
    }
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
      if (decision instanceof DeliveryMergeReadinessDecisionV2) {
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
    expectedSequence += 1;
  }

  return actor.getSnapshot();
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

function toMachineEvent(event: RunEvent): RunMachineEvent {
  switch (event.type) {
    case "BROWSER_EVIDENCE_RECORDED":
      return {
        evidencePath: getStringPayload(event, "evidencePath"),
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
      const pullRequest = getOptionalStringPayload(event, "pullRequest");
      return {
        blockerCount: getNumberPayload(event, "blockerCount"),
        mergeDecisionPath: getStringPayload(event, "mergeDecisionPath"),
        nextAction: getStringPayload(event, "nextAction"),
        status: getStringPayload(event, "status"),
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
