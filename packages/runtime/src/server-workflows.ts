import { createHash } from "node:crypto";

import {
  AcceptedRunInputCheckpointRefV1,
  type AcceptedRunInputCheckpointV1,
  canonicalV1,
  ClaimVerificationCommandStartV1,
  ClaimVerificationGenerationStartedV1,
  ClaimVerificationSandboxCreatedV1,
  CreateRunRequest,
  CommandStartOutcomeUnknownReconciled,
  CreatedWithoutCommandStartReconciled,
  DeliveryFeedbackTrustPolicyV1,
  deliveryFeedbackRequiresApprovedReview,
  type DeliveryMergeActionRequest,
  type DeliveryAttestPairedReviewActionRequest,
  type DeliveryMarkReadyForReviewActionRequest,
  type DeliveryEvaluateMergeReadinessActionRequest,
  type DeliveryRetryCleanupActionRequest,
  type DeliveryRemediationActivationActionRequest,
  parseMarkdownSpec,
  parseRunControlEventPayload,
  parseSpecDigest,
  HarnessExecutionSelection,
  ModelInvocationEpisodeStartV1,
  ModelInvocationObservationV1,
  parseHarnessEvent,
  parseHarnessSessionId,
  parseDeliveryPublication,
  parseAnyRunProofResult,
  parseVerificationActionRequest,
  parseVerificationCommandReceipt,
  parseVerificationReconciliationReceipt,
  encodeVerificationReconciliationReceiptJson,
  PostPublicationGenerationRecorded,
  parseRunId,
  encodeWorkerContinuationReceiptJson,
  encodeWorkerCorrelationReconciliationReceiptJson,
  encodeWorkerDesktopOriginCorrelationReceiptJson,
  parseWorkerContinuationAction,
  parseWorkerContinuationReceipt,
  parseWorkerCorrelationReconciliationAction,
  parseWorkerCorrelationReconciliationReceipt,
  parseWorkerDesktopOriginCorrelationAction,
  parseWorkerDesktopOriginCorrelationReceipt,
  parseWorkerRecoveryReceipt,
  ResolvedHarnessExecution,
  makeAcceptedRunInputCheckpointV1,
  resolveAcceptedRunInputCheckpoint,
  RunIdSchema,
  snapshotFromReplay,
  resolveModelInvocationEpisodes,
  type WorkerContinuationAction,
  type WorkerContinuationReceipt,
  type WorkerCorrelationReconciliationAction,
  type WorkerCorrelationReconciliationReceipt,
  type WorkerDesktopOriginCorrelationAction,
  type WorkerDesktopOriginCorrelationReceipt,
  type GaiaFailure,
  type WorkerRecoveryAction,
  type WorkerRecoveryReceipt,
  WorkerEnvironmentEpochComparisonDto,
  RunEvent,
  RunProofProjectionSchema,
  type RunId,
  type RunContractV2,
  type VerificationActionRequest,
  VerificationRequestDigestSchema,
  VerificationActionIdempotentReplay,
  type RunState,
  WorkerRecoveryActionIdSchema,
} from "@gaia/core";
import {
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  type Duration,
} from "effect";
import { customAlphabet } from "nanoid";

import {
  commitAcceptedRunInputCheckpointNoReplace,
  decodeAcceptedRunInputSemantics,
  loadAcceptedRunInputCheckpoint,
  type AcceptedRunInputSemanticsV1,
} from "./accepted-run-input.js";
import type { LiveHarnessSessionCoordinator } from "./agent-session-runtime.js";
import { makeCodexHarnessConfig } from "./codex-harness.js";
import {
  coordinateDeliveryCleanup,
  coordinateDeliveryMerge,
  coordinateDeliveryMergeReadiness,
  makeGitHubFreshMergeStateReader,
  requiredCheckPolicyFromTrustPolicy,
} from "./delivery-merge-coordinator.js";
import {
  publishReadyDeliveryRun,
  retryFailedDeliveryPublication,
} from "./delivery-publication.js";
import { coordinateDeliveryPullRequestReady } from "./delivery-ready-for-review-coordinator.js";
import {
  continueDeliveryRemediation,
  defaultDeliveryFeedbackTrustPolicy,
  type DeliveryPullRequestReader,
} from "./delivery-remediation-coordinator.js";
import { coordinateDeliveryLocalReviewAttestation } from "./delivery-review-attestation-coordinator.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import { appendEvent, loadRun, readEvents } from "./event-store.js";
import {
  writeInitialFactoryRunIndexes,
  type FactoryRunCreateInput,
} from "./factory-run-store.js";
import {
  parseDeliveryProvenance,
  prepareDeliveryWorktree,
  resolveDeliveryGitHubRepository,
  resolveDeliveryProvenance,
  type DeliveryAcceptanceProvenancePolicyV1,
  type DeliveryProvenance,
  type GitDeliveryCommandRunner,
} from "./git-delivery.js";
import type { GitHubCommandRunner } from "./github-publisher.js";
import type { DeliveryFeedbackSmokeAuthorization } from "./github-pull-request-provider.js";
import {
  HarnessProfileNotFoundError,
  HarnessEnvironmentAssignmentError,
  issueDeliveryWorkerHarnessCapabilities,
  type HarnessProviderRegistry,
  type ResolvedHarnessProvider,
} from "./harness-provider-registry.js";
import {
  HarnessCapabilityMismatchError,
  HarnessDetectionError,
  HarnessIncompatibleError,
  HarnessUnavailableError,
} from "./harness-session.js";
import { makeProcessHarnessConfig } from "./harness.js";
import { interactiveSessionHarness } from "./interactive-harness.js";
import {
  assertFactoryRunAcceptanceSecretSafe,
  commitDerivedAppModelInvocationEpisode,
  loadModelInvocationPair,
  prepareServerRunAcceptance,
  decodeCodexBatchSemanticConfig,
  decodeProcessHarnessSemanticConfig,
  prepareSkillInstaller,
  PreparedServerRunAcceptanceV1,
  type PreparedSpecRunAcceptanceV1,
} from "./model-invocation.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  RuntimePathSchema,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import type { ReviewerRunOptions } from "./reviewer.js";
import { loadRunContract } from "./run-contract.js";
import { reconcileRunControlExpiryWithinLease } from "./run-control-runtime.js";
import { withRunStoreLock } from "./run-store-lock.js";
import { recordRunProofResult, type VerificationServices } from "./verifier.js";
import {
  readPrivateWorkerCorrelationFollowUpCheckpoint,
  readPrivateWorkerRecoveryCheckpoint,
} from "./worker-recovery.js";
import {
  continueAcceptedRun,
  readHarnessEnvironmentReceipt,
  type CommandSummary,
  type WorkerContinuationState,
  type WorkflowOptions,
} from "./workflows.js";
import { observeWorkspaceStructuralDigest } from "./workspace-snapshot.js";
import {
  localDirectoryWorkspaceSource,
  type WorkspaceSource,
} from "./workspace.js";

const nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
  10
);

export type ServerWorkflowOptions = WorkflowOptions &
  ReviewerRunOptions & {
    readonly deliveryAcceptanceProvenancePolicy?: DeliveryAcceptanceProvenancePolicyV1;
    readonly deliveryMergeActivator?: DeliveryMergeActionHandler;
    readonly deliveryReadyForReviewActivator?: DeliveryReadyForReviewActionHandler;
    readonly deliveryLocalReviewAttestationActivator?: DeliveryLocalReviewAttestationActionHandler;
    readonly deliveryRemediationActivator?: DeliveryRemediationActionHandler;
    readonly deliveryGitCommandRunner?: GitDeliveryCommandRunner;
    readonly deliveryPublicationCommandRunner?: GitHubCommandRunner;
    readonly deliveryPublisher?: typeof publishReadyDeliveryRun;
    readonly deliveryObservationEnabled?: boolean;
    readonly deliveryObservationMaxAttempts?: number;
    readonly deliveryObservationPollInterval?: Duration.Input;
    readonly deliveryFeedbackAuthorization?: DeliveryFeedbackSmokeAuthorization;
    readonly deliveryFeedbackTrustPolicy?: DeliveryFeedbackTrustPolicyV1;
    readonly deliveryPullRequestReader?: DeliveryPullRequestReader;
    readonly deliveryRetryPublisher?: typeof retryFailedDeliveryPublication;
    readonly harnessProviderRegistry?: HarnessProviderRegistry;
    readonly sessionCoordinator?: LiveHarnessSessionCoordinator;
    readonly verificationServices?: VerificationServices;
    readonly workspaceSource?: WorkspaceSource;
    readonly workerRecoveryActivator?: (
      runId: RunId,
      action: WorkerRecoveryAction
    ) => Effect.Effect<
      WorkerRecoveryReceipt,
      unknown,
      FileSystem.FileSystem | Path.Path
    >;
    readonly workerContinuationRunner?: (
      runId: RunId,
      options: ServerWorkflowOptions
    ) => Effect.Effect<
      CommandSummary,
      unknown,
      FileSystem.FileSystem | Path.Path
    >;
    readonly workerCorrelationReconciler?: WorkerCorrelationReconciler;
    readonly workerCorrelationFollowUpDispatcher?: WorkerCorrelationFollowUpDispatcher;
    readonly workerCorrelationRunner?: (
      runId: RunId,
      options: ServerWorkflowOptions
    ) => Effect.Effect<
      CommandSummary,
      unknown,
      FileSystem.FileSystem | Path.Path
    >;
    readonly workerDesktopOriginCorrelationReconciler?: WorkerDesktopOriginCorrelationReconciler;
    readonly workerDesktopOriginCorrelationFollowUpDispatcher?: WorkerDesktopOriginCorrelationFollowUpDispatcher;
    readonly workerDesktopOriginCorrelationRunner?: (
      runId: RunId,
      options: ServerWorkflowOptions
    ) => Effect.Effect<
      CommandSummary,
      unknown,
      FileSystem.FileSystem | Path.Path
    >;
  };

export type WorkerCorrelationReconciliationInput = {
  readonly action: WorkerCorrelationReconciliationAction;
  readonly clientInputId: string;
  readonly events: ReadonlyArray<RunEvent>;
  readonly followUpText: string;
  readonly paths: RunPaths;
  readonly runId: RunId;
};

export type WorkerCorrelationReconciler = (
  input: WorkerCorrelationReconciliationInput
) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;

export type WorkerCorrelationFollowUpDispatcher = (
  input: WorkerCorrelationReconciliationInput
) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;

export type WorkerDesktopOriginCorrelationInput = {
  readonly action: WorkerDesktopOriginCorrelationAction;
  readonly clientInputId: string;
  readonly events: ReadonlyArray<RunEvent>;
  readonly followUpText: string;
  readonly paths: RunPaths;
  readonly runId: RunId;
};

export type WorkerDesktopOriginCorrelationReconciler = (
  input: WorkerDesktopOriginCorrelationInput
) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;

export type WorkerDesktopOriginCorrelationFollowUpDispatcher = (
  input: WorkerDesktopOriginCorrelationInput
) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;

export function actOnWorkerRecovery(
  runId: RunId,
  action: WorkerRecoveryAction,
  options: ServerWorkflowOptions
) {
  return options.workerRecoveryActivator === undefined
    ? Effect.fail(
        makeRuntimeError({
          code: "DeliveryActionFailed",
          message: "Worker recovery is unavailable.",
          recoverable: false,
        })
      )
    : options.workerRecoveryActivator(runId, action);
}

export function actOnWorkerContinuation(
  runId: RunId,
  actionInput: WorkerContinuationAction,
  options: ServerWorkflowOptions = {}
) {
  return withRunStoreLock(
    options,
    actOnWorkerContinuationUnlocked(runId, actionInput, options),
    {
      nextSafeAction:
        "Refresh delivery state before retrying the audited worker continuation action.",
      operation: "Gaia audited worker continuation action",
    }
  ).pipe(Effect.mapError(toServerWorkflowError("DeliveryActionFailed")));
}

function actOnWorkerContinuationUnlocked(
  runId: RunId,
  actionInput: WorkerContinuationAction,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    const action = parseWorkerContinuationAction(actionInput);
    const preparedContinuation = yield* prepareAcceptedServerContinuation(
      runId,
      options
    );
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);
    const prior = latestWorkerContinuationReceipt(loaded.events);
    const epochSequence =
      prior?.workerEvidenceEpochSequence ?? action.expectedCurrentSequence + 1;
    const base = {
      actionId: action.actionId,
      expectedContaminatedReadySequence:
        action.expectedContaminatedReadySequence,
      expectedCurrentSequence: action.expectedCurrentSequence,
      expectedDeliveryProvenanceDigest: action.expectedDeliveryProvenanceDigest,
      expectedFailedRecoverySequence: action.expectedFailedRecoverySequence,
      expectedRecoveryActionId: action.expectedRecoveryActionId,
      expectedSessionId: action.expectedSessionId,
      harnessProfileId: action.harnessProfileId,
      maxAttempts: 1 as const,
      workerEvidenceEpochSequence: epochSequence,
    };

    if (prior !== undefined) {
      yield* assertWorkerContinuationReplay(prior, base);
      if (
        prior.state === "resumeAttempted" ||
        prior.state === "followUpAttempted"
      ) {
        return yield* recordWorkerContinuationReceipt(runId, paths, {
          ...prior,
          code: "WorkerContinuationOutcomeUnknown",
          message:
            "A prior audited continuation attempt has no durable terminal receipt.",
          state: "outcomeUnknown",
        });
      }
      if (prior.state !== "intentRecorded") {
        return prior;
      }
    } else {
      yield* assertWorkerContinuationEligibility(loaded.events, action);
      yield* recordWorkerContinuationReceipt(runId, paths, {
        ...base,
        state: "intentRecorded",
      });
    }

    yield* recordWorkerContinuationReceipt(runId, paths, {
      ...base,
      state: "resumeAttempted",
    });
    const continued = yield* Effect.exit(
      options.workerContinuationRunner === undefined
        ? continueServerRunWorkerOnly(runId, options, preparedContinuation)
        : options.workerContinuationRunner(runId, options)
    );
    if (continued._tag === "Failure") {
      return yield* recordWorkerContinuationReceipt(runId, paths, {
        ...base,
        code: "WorkerContinuationFailed",
        message:
          "Audited worker continuation failed before fresh worker evidence completed.",
        state: "failed",
      });
    }
    const refreshed = yield* loadRun(paths);
    const hasFreshWorkerCompletion = refreshed.events.some(
      ({ sequence, type }) =>
        type === "WORKER_COMPLETED" && sequence > epochSequence
    );
    if (!hasFreshWorkerCompletion) {
      return yield* recordWorkerContinuationReceipt(runId, paths, {
        ...base,
        code: "WorkerContinuationNoFreshWorkerCompletion",
        message:
          "Audited worker continuation did not produce fresh worker evidence.",
        state: "failed",
      });
    }
    return yield* recordWorkerContinuationReceipt(runId, paths, {
      ...base,
      state: "workerCompleted",
    });
  });
}

export function actOnWorkerCorrelationReconciliation(
  runId: RunId,
  actionInput: WorkerCorrelationReconciliationAction,
  options: ServerWorkflowOptions = {}
) {
  return withRunStoreLock(
    options,
    actOnWorkerCorrelationReconciliationUnlocked(runId, actionInput, options),
    {
      nextSafeAction:
        "Refresh delivery state before retrying the audited worker correlation reconciliation action.",
      operation: "Gaia audited worker correlation reconciliation action",
    }
  ).pipe(Effect.mapError(toServerWorkflowError("DeliveryActionFailed")));
}

function actOnWorkerCorrelationReconciliationUnlocked(
  runId: RunId,
  actionInput: WorkerCorrelationReconciliationAction,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    const action = parseWorkerCorrelationReconciliationAction(actionInput);
    const preparedContinuation = yield* prepareAcceptedServerContinuation(
      runId,
      options
    );
    if (
      options.workerCorrelationReconciler === undefined ||
      options.workerCorrelationFollowUpDispatcher === undefined
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryActionFailed",
          message: "Worker correlation reconciliation is unavailable.",
          recoverable: false,
        })
      );
    }
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);
    const prior = latestWorkerCorrelationReconciliationReceipt(loaded.events);
    const epochSequence =
      prior?.workerEvidenceEpochSequence ?? action.expectedCurrentSequence + 1;
    const base = {
      actionId: action.actionId,
      expectedContaminatedReadySequence:
        action.expectedContaminatedReadySequence,
      expectedContinuationActionId: action.expectedContinuationActionId,
      expectedCurrentSequence: action.expectedCurrentSequence,
      expectedDeliveryProvenanceDigest: action.expectedDeliveryProvenanceDigest,
      expectedFailedContinuationSequence:
        action.expectedFailedContinuationSequence,
      expectedFailedRecoverySequence: action.expectedFailedRecoverySequence,
      expectedNativeTurnIdDigest: action.expectedNativeTurnIdDigest,
      expectedRecoveryActionId: action.expectedRecoveryActionId,
      expectedSessionId: action.expectedSessionId,
      harnessProfileId: action.harnessProfileId,
      maxAttempts: 1 as const,
      workerEvidenceEpochSequence: epochSequence,
    };
    const episodeKey = `workerCorrelation:${action.actionId}`;
    const resolution = resolveModelInvocationEpisodes(loaded.events);
    let modelInvocationEpisode =
      resolution.protocol === "legacyAbsent"
        ? undefined
        : resolution.episodes.find(
            ({ start }) => start.episodeKey === episodeKey
          )?.start;

    if (prior !== undefined) {
      yield* assertWorkerCorrelationReconciliationReplay(prior, base);
      if (
        prior.state === "correlationAttempted" ||
        prior.state === "followUpAttempted"
      ) {
        return yield* recordWorkerCorrelationReconciliationReceipt(
          runId,
          paths,
          {
            ...prior,
            code: "WorkerCorrelationOutcomeUnknown",
            message:
              "A prior audited correlation reconciliation attempt has no durable terminal receipt.",
            state: "outcomeUnknown",
          }
        );
      }
      if (
        prior.state === "failed" ||
        prior.state === "outcomeUnknown" ||
        prior.state === "workerCompleted"
      ) {
        return prior;
      }
    } else {
      yield* assertWorkerCorrelationReconciliationEligibility(
        loaded.events,
        action
      );
      modelInvocationEpisode = yield* commitDerivedAppModelInvocationEpisode({
        episodeKey,
        episodeRole: "workerCorrelation",
        events: loaded.events,
        paths,
        runId,
        taskInput: workerCorrelationFollowUpText,
      });
      yield* recordWorkerCorrelationReconciliationReceipt(
        runId,
        paths,
        { ...base, state: "intentRecorded" },
        modelInvocationEpisode
      );
    }

    if (resolution.protocol === "v1" && modelInvocationEpisode === undefined)
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ModelInvocationEpisodeMissing",
          message:
            "The authoritative worker correlation input manifest is missing.",
          recoverable: false,
        })
      );
    const modelInput =
      modelInvocationEpisode === undefined
        ? undefined
        : yield* loadModelInvocationPair(paths, modelInvocationEpisode);
    const input = {
      action,
      clientInputId: workerCorrelationFollowUpClientInputId(
        runId,
        action.actionId
      ),
      events: loaded.events,
      followUpText: modelInput?.rendered.text ?? workerCorrelationFollowUpText,
      paths,
      runId,
    } satisfies WorkerCorrelationReconciliationInput;

    if (prior === undefined || prior.state === "intentRecorded") {
      yield* recordWorkerCorrelationReconciliationReceipt(runId, paths, {
        ...base,
        state: "correlationAttempted",
      });
      const reconciled = yield* Effect.exit(
        options.workerCorrelationReconciler(input)
      );
      if (reconciled._tag === "Failure") {
        return yield* recordWorkerCorrelationReconciliationReceipt(
          runId,
          paths,
          {
            ...base,
            code: "WorkerCorrelationReconciliationFailed",
            message:
              "Audited worker correlation reconciliation failed before the private checkpoint was durably confirmed.",
            state: "failed",
          }
        );
      }
      yield* recordWorkerCorrelationReconciliationReceipt(runId, paths, {
        ...base,
        state: "correlationConfirmed",
      });
    }

    if (
      prior === undefined ||
      prior.state === "intentRecorded" ||
      prior.state === "correlationConfirmed"
    ) {
      yield* recordWorkerCorrelationReconciliationReceipt(runId, paths, {
        ...base,
        state: "followUpAttempted",
      });
      const dispatched = yield* Effect.exit(
        options.workerCorrelationFollowUpDispatcher(input)
      );
      if (dispatched._tag === "Failure") {
        return yield* recordWorkerCorrelationReconciliationReceipt(
          runId,
          paths,
          {
            ...base,
            code: "WorkerCorrelationFollowUpOutcomeUnknown",
            message:
              "Audited worker correlation follow-up acceptance could not be confirmed.",
            state: "outcomeUnknown",
          }
        );
      }
      yield* recordWorkerCorrelationReconciliationReceipt(
        runId,
        paths,
        { ...base, state: "followUpConfirmed" },
        undefined,
        modelInvocationEpisode === undefined
          ? undefined
          : ModelInvocationObservationV1.make({
              episodeKey,
              kind: "offered",
              source: "codexAppServerTransport",
              trust: "high",
              version: 1,
            })
      );
    }

    const runner =
      options.workerCorrelationRunner ?? options.workerContinuationRunner;
    const continued = yield* Effect.exit(
      runner === undefined
        ? continueServerRunWorkerOnly(runId, options, preparedContinuation)
        : runner(runId, options)
    );
    if (continued._tag === "Failure") {
      return yield* recordWorkerCorrelationReconciliationReceipt(runId, paths, {
        ...base,
        code: "WorkerCorrelationContinuationFailed",
        message:
          "Audited worker correlation reconciliation failed before fresh worker evidence completed.",
        state: "failed",
      });
    }
    const refreshed = yield* loadRun(paths);
    const hasFreshWorkerCompletion = refreshed.events.some(
      ({ sequence, type }) =>
        type === "WORKER_COMPLETED" && sequence > epochSequence
    );
    if (!hasFreshWorkerCompletion) {
      return yield* recordWorkerCorrelationReconciliationReceipt(runId, paths, {
        ...base,
        code: "WorkerCorrelationNoFreshWorkerCompletion",
        message:
          "Audited worker correlation reconciliation did not produce fresh worker evidence.",
        state: "failed",
      });
    }
    return yield* recordWorkerCorrelationReconciliationReceipt(runId, paths, {
      ...base,
      state: "workerCompleted",
    });
  });
}

export function actOnWorkerDesktopOriginCorrelation(
  runId: RunId,
  actionInput: WorkerDesktopOriginCorrelationAction,
  options: ServerWorkflowOptions = {}
) {
  return withRunStoreLock(
    options,
    actOnWorkerDesktopOriginCorrelationUnlocked(runId, actionInput, options),
    {
      nextSafeAction:
        "Refresh delivery state before retrying the audited Desktop-origin correlation action.",
      operation: "Gaia audited Desktop-origin correlation action",
    }
  ).pipe(Effect.mapError(toServerWorkflowError("DeliveryActionFailed")));
}

function actOnWorkerDesktopOriginCorrelationUnlocked(
  runId: RunId,
  actionInput: WorkerDesktopOriginCorrelationAction,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    const action = parseWorkerDesktopOriginCorrelationAction(actionInput);
    const preparedContinuation = yield* prepareAcceptedServerContinuation(
      runId,
      options
    );
    if (
      options.workerDesktopOriginCorrelationReconciler === undefined ||
      options.workerDesktopOriginCorrelationFollowUpDispatcher === undefined
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryActionFailed",
          message:
            "Worker Desktop-origin correlation reconciliation is unavailable.",
          recoverable: false,
        })
      );
    }
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);
    const prior = latestWorkerDesktopOriginCorrelationReceipt(loaded.events);
    const epochSequence =
      prior?.workerEvidenceEpochSequence ?? action.expectedCurrentSequence + 1;
    const base = {
      actionId: action.actionId,
      expectedContaminatedReadySequence:
        action.expectedContaminatedReadySequence,
      expectedContinuationActionId: action.expectedContinuationActionId,
      expectedCorrelationActionId: action.expectedCorrelationActionId,
      expectedCurrentSequence: action.expectedCurrentSequence,
      expectedDeliveryProvenanceDigest: action.expectedDeliveryProvenanceDigest,
      expectedFailedContinuationSequence:
        action.expectedFailedContinuationSequence,
      expectedFailedCorrelationSequence:
        action.expectedFailedCorrelationSequence,
      expectedFailedRecoverySequence: action.expectedFailedRecoverySequence,
      expectedNativeTurnIdDigest: action.expectedNativeTurnIdDigest,
      expectedRecoveryActionId: action.expectedRecoveryActionId,
      expectedSessionId: action.expectedSessionId,
      harnessProfileId: action.harnessProfileId,
      maxAttempts: 1 as const,
      workerEvidenceEpochSequence: epochSequence,
    };
    const episodeKey = `workerDesktopOriginCorrelation:${action.actionId}`;
    const resolution = resolveModelInvocationEpisodes(loaded.events);
    let modelInvocationEpisode =
      resolution.protocol === "legacyAbsent"
        ? undefined
        : resolution.episodes.find(
            ({ start }) => start.episodeKey === episodeKey
          )?.start;

    if (prior !== undefined) {
      yield* assertWorkerDesktopOriginCorrelationReplay(prior, base);
      if (
        prior.state === "sourceCorrelationAttempted" ||
        prior.state === "followUpAttempted"
      ) {
        return yield* recordWorkerDesktopOriginCorrelationReceipt(
          runId,
          paths,
          {
            ...prior,
            code: "WorkerDesktopOriginCorrelationOutcomeUnknown",
            message:
              "A prior audited Desktop-origin correlation attempt has no durable terminal receipt.",
            state: "outcomeUnknown",
          }
        );
      }
      if (
        prior.state === "failed" ||
        prior.state === "outcomeUnknown" ||
        prior.state === "workerCompleted"
      ) {
        return prior;
      }
    } else {
      yield* assertWorkerDesktopOriginCorrelationEligibility(
        loaded.events,
        action
      );
      modelInvocationEpisode = yield* commitDerivedAppModelInvocationEpisode({
        episodeKey,
        episodeRole: "workerDesktopOriginCorrelation",
        events: loaded.events,
        paths,
        runId,
        taskInput: workerCorrelationFollowUpText,
      });
      yield* recordWorkerDesktopOriginCorrelationReceipt(
        runId,
        paths,
        { ...base, state: "intentRecorded" },
        modelInvocationEpisode
      );
    }

    if (resolution.protocol === "v1" && modelInvocationEpisode === undefined)
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ModelInvocationEpisodeMissing",
          message:
            "The authoritative Desktop-origin correlation input manifest is missing.",
          recoverable: false,
        })
      );
    const modelInput =
      modelInvocationEpisode === undefined
        ? undefined
        : yield* loadModelInvocationPair(paths, modelInvocationEpisode);
    const input = {
      action,
      clientInputId: workerCorrelationFollowUpClientInputId(
        runId,
        action.actionId
      ),
      events: loaded.events,
      followUpText: modelInput?.rendered.text ?? workerCorrelationFollowUpText,
      paths,
      runId,
    } satisfies WorkerDesktopOriginCorrelationInput;

    if (prior === undefined || prior.state === "intentRecorded") {
      yield* recordWorkerDesktopOriginCorrelationReceipt(runId, paths, {
        ...base,
        state: "sourceCorrelationAttempted",
      });
      const reconciled = yield* Effect.exit(
        options.workerDesktopOriginCorrelationReconciler(input)
      );
      if (reconciled._tag === "Failure") {
        return yield* recordWorkerDesktopOriginCorrelationReceipt(
          runId,
          paths,
          {
            ...base,
            code: "WorkerDesktopOriginCorrelationFailed",
            message:
              "Audited Desktop-origin correlation failed before the private checkpoint was durably confirmed.",
            state: "failed",
          }
        );
      }
      yield* recordWorkerDesktopOriginCorrelationReceipt(runId, paths, {
        ...base,
        state: "sourceCorrelationConfirmed",
      });
    }

    if (
      prior === undefined ||
      prior.state === "intentRecorded" ||
      prior.state === "sourceCorrelationConfirmed"
    ) {
      yield* recordWorkerDesktopOriginCorrelationReceipt(runId, paths, {
        ...base,
        state: "followUpAttempted",
      });
      const dispatched = yield* Effect.exit(
        options.workerDesktopOriginCorrelationFollowUpDispatcher(input)
      );
      if (dispatched._tag === "Failure") {
        return yield* recordWorkerDesktopOriginCorrelationReceipt(
          runId,
          paths,
          {
            ...base,
            code: "WorkerDesktopOriginCorrelationFollowUpOutcomeUnknown",
            message:
              "Audited Desktop-origin correlation follow-up acceptance could not be confirmed.",
            state: "outcomeUnknown",
          }
        );
      }
      yield* recordWorkerDesktopOriginCorrelationReceipt(
        runId,
        paths,
        { ...base, state: "followUpConfirmed" },
        undefined,
        modelInvocationEpisode === undefined
          ? undefined
          : ModelInvocationObservationV1.make({
              episodeKey,
              kind: "offered",
              source: "codexAppServerTransport",
              trust: "high",
              version: 1,
            })
      );
    }

    const runner =
      options.workerDesktopOriginCorrelationRunner ??
      options.workerCorrelationRunner ??
      options.workerContinuationRunner;
    const continued = yield* Effect.exit(
      runner === undefined
        ? continueServerRunWorkerOnly(runId, options, preparedContinuation)
        : runner(runId, options)
    );
    if (continued._tag === "Failure") {
      return yield* recordWorkerDesktopOriginCorrelationReceipt(runId, paths, {
        ...base,
        code: "WorkerDesktopOriginCorrelationContinuationFailed",
        message:
          "Audited Desktop-origin correlation failed before fresh worker evidence completed.",
        state: "failed",
      });
    }
    const refreshed = yield* loadRun(paths);
    const hasFreshWorkerCompletion = refreshed.events.some(
      ({ sequence, type }) =>
        type === "WORKER_COMPLETED" && sequence > epochSequence
    );
    if (!hasFreshWorkerCompletion) {
      return yield* recordWorkerDesktopOriginCorrelationReceipt(runId, paths, {
        ...base,
        code: "WorkerDesktopOriginCorrelationNoFreshWorkerCompletion",
        message:
          "Audited Desktop-origin correlation did not produce fresh worker evidence.",
        state: "failed",
      });
    }
    return yield* recordWorkerDesktopOriginCorrelationReceipt(runId, paths, {
      ...base,
      state: "workerCompleted",
    });
  });
}

export type DeliveryMergeActionHandler = (
  runId: RunId,
  action:
    | DeliveryMergeActionRequest
    | DeliveryRetryCleanupActionRequest
    | DeliveryEvaluateMergeReadinessActionRequest,
  options: ServerWorkflowOptions
) => Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>;

export type DeliveryReadyForReviewActionHandler = (
  runId: RunId,
  action: DeliveryMarkReadyForReviewActionRequest,
  options: ServerWorkflowOptions
) => Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>;

export type DeliveryLocalReviewAttestationActionHandler = (
  runId: RunId,
  action: DeliveryAttestPairedReviewActionRequest,
  options: ServerWorkflowOptions
) => Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>;

export function actOnDeliveryReadyForReview(
  runId: RunId,
  action: DeliveryMarkReadyForReviewActionRequest,
  options: ServerWorkflowOptions = {}
) {
  return Effect.gen(function* () {
    return yield* coordinateDeliveryPullRequestReady(runId, action, {
      ...(options.deliveryPublicationCommandRunner === undefined
        ? {}
        : { commandRunner: options.deliveryPublicationCommandRunner }),
      rootDirectory: options.rootDirectory ?? ".",
    });
  });
}

export function actOnDeliveryLocalReviewAttestation(
  runId: RunId,
  action: DeliveryAttestPairedReviewActionRequest,
  options: ServerWorkflowOptions = {}
) {
  return Effect.gen(function* () {
    return yield* coordinateDeliveryLocalReviewAttestation(runId, action, {
      ...(options.deliveryPublicationCommandRunner === undefined
        ? {}
        : { commandRunner: options.deliveryPublicationCommandRunner }),
      rootDirectory: options.rootDirectory ?? ".",
    });
  });
}

export function actOnDeliveryMerge(
  runId: RunId,
  action:
    | DeliveryMergeActionRequest
    | DeliveryRetryCleanupActionRequest
    | DeliveryEvaluateMergeReadinessActionRequest,
  options: ServerWorkflowOptions = {}
) {
  return Effect.gen(function* () {
    const trustPolicy =
      options.deliveryFeedbackTrustPolicy ??
      defaultDeliveryFeedbackTrustPolicy("unknown/unknown");
    const coordinatorOptions = {
      ...(options.deliveryPublicationCommandRunner === undefined
        ? {}
        : { commandRunner: options.deliveryPublicationCommandRunner }),
      ...(options.deliveryFeedbackTrustPolicy === undefined
        ? {}
        : {
            requiredCheckPolicy:
              requiredCheckPolicyFromTrustPolicy(trustPolicy),
          }),
      rootDirectory: options.rootDirectory ?? ".",
    };
    return action.kind === "merge"
      ? yield* coordinateDeliveryMerge(runId, action, coordinatorOptions)
      : action.kind === "evaluateMergeReadiness"
        ? yield* coordinateDeliveryMergeReadiness(
            runId,
            action,
            coordinatorOptions
          )
        : yield* coordinateDeliveryCleanup(runId, action, coordinatorOptions);
  });
}

export type DeliveryRemediationActionHandler = (
  runId: RunId,
  action: DeliveryRemediationActivationActionRequest,
  options: ServerWorkflowOptions
) => Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>;

const encodeResolvedHarnessExecution = Schema.encodeSync(
  ResolvedHarnessExecution
);
const decodeHarnessExecutionSelection = Schema.decodeUnknownSync(
  HarnessExecutionSelection
);
const decodeResolvedHarnessExecution = Schema.decodeUnknownSync(
  ResolvedHarnessExecution
);
const decodeWorkerEnvironmentEpochComparison = Schema.decodeUnknownSync(
  WorkerEnvironmentEpochComparisonDto
);

/** Project comparison state only from accepted assignment and completed authority. */
export function readWorkerEnvironmentEpochComparison(
  paths: RunPaths,
  options: { readonly requireProviderNativeToolInventory?: boolean } = {}
) {
  return Effect.gen(function* () {
    const events = yield* readEvents(paths);
    const created = events[0];
    const executionInput =
      created?.type === "RUN_CREATED"
        ? created.payload["execution"]
        : undefined;
    const resolvedInput =
      typeof executionInput === "object" && executionInput !== null
        ? Reflect.get(executionInput, "resolved")
        : undefined;
    const resolved = Option.getOrUndefined(
      Schema.decodeUnknownOption(ResolvedHarnessExecution)(resolvedInput)
    );
    if (resolved?.environmentAssignment === undefined)
      return decodeWorkerEnvironmentEpochComparison({
        limitations: ["acceptedEnvironmentAssignmentMissing"],
        state: "missing",
        version: 1,
      });
    const latestStarted = [...events]
      .reverse()
      .find(({ type }) => type === "WORKER_STARTED");
    const latestCompleted = [...events]
      .reverse()
      .find(({ type }) => type === "WORKER_COMPLETED");
    if (
      latestCompleted === undefined ||
      (latestStarted !== undefined &&
        latestStarted.sequence > latestCompleted.sequence)
    )
      return decodeWorkerEnvironmentEpochComparison({
        limitations: ["authoritativeReceiptMissing"],
        state: "incomplete",
        version: 1,
      });
    const receiptRef = latestCompleted.payload["harnessEnvironmentReceipt"];
    if (receiptRef === undefined)
      return decodeWorkerEnvironmentEpochComparison({
        limitations: ["authoritativeReceiptMissing"],
        state: "incomplete",
        version: 1,
      });
    const receiptExit = yield* Effect.exit(
      readHarnessEnvironmentReceipt(paths, events, receiptRef)
    );
    if (receiptExit._tag === "Failure")
      return decodeWorkerEnvironmentEpochComparison({
        limitations: ["authoritativeReceiptInvalid"],
        state: "incomplete",
        version: 1,
      });
    if (options.requireProviderNativeToolInventory === true)
      return decodeWorkerEnvironmentEpochComparison({
        limitations: [
          "providerNativeToolInventoryNotExposed",
          "providerNativeToolInventoryRequired",
        ],
        state: "nonComparable",
        version: 1,
      });
    return decodeWorkerEnvironmentEpochComparison({
      limitations: ["providerNativeToolInventoryNotExposed"],
      state: "completeComparable",
      structuralDigest: receiptExit.value.receipt.structuralDigest,
      version: 1,
    });
  });
}

const ServerRunAcceptanceSchema = Schema.Struct({
  acceptedAt: RunEvent.fields.timestamp,
  eventSequence: RunEvent.fields.sequence,
  runDirectory: RuntimePathSchema,
  runId: RunIdSchema,
});
const ServerRunReconciliationSchema = Schema.Struct({
  reconciledRunIds: Schema.Array(RunIdSchema),
  resumableRunIds: Schema.Array(RunIdSchema),
});
const ServerRunSpecInputSchema = Schema.Struct({
  specMarkdown: Schema.String,
  title: Schema.optionalKey(Schema.UndefinedOr(Schema.String)),
});
const DeliveryPublicationActionSchema = Schema.Struct({
  expectedEventSequence: RunEvent.fields.sequence,
  kind: Schema.Literals(["reconcile", "retry"]),
});
const parseServerRunSpecInput = Schema.decodeUnknownSync(
  ServerRunSpecInputSchema
);
const parseDeliveryPublicationAction = Schema.decodeUnknownSync(
  DeliveryPublicationActionSchema
);

export type ServerRunAcceptance = typeof ServerRunAcceptanceSchema.Type;
export type ServerRunReconciliation = typeof ServerRunReconciliationSchema.Type;
type ServerRunSpecInput = typeof ServerRunSpecInputSchema.Type;
type DeliveryPublicationAction = typeof DeliveryPublicationActionSchema.Type;

export function acceptServerRun(
  input: typeof ServerRunSpecInputSchema.Encoded,
  options: ServerWorkflowOptions = {}
) {
  return Effect.try({
    try: () => parseServerRunSpecInput(input),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidSpec",
        message: "The server run request is invalid.",
        recoverable: false,
      }),
  }).pipe(
    Effect.flatMap((acceptedInput) =>
      prepareServerRunAcceptance(acceptedInput, options)
    ),
    Effect.flatMap((prepared) =>
      withRunStoreLock(options, acceptServerRunUnlocked(prepared, options), {
        nextSafeAction:
          "Wait for the active Gaia server run acceptance to finish, then retry.",
        operation: "Gaia server run acceptance",
      })
    ),
    Effect.mapError(toServerWorkflowError("ServerRunAcceptFailed"))
  );
}

export function acceptFactoryRun(
  input: FactoryRunCreateInput,
  options: ServerWorkflowOptions = {}
) {
  return prepareFactoryRunAcceptance(input, options).pipe(
    Effect.flatMap((prepared) => acceptPreparedFactoryRun(prepared, options)),
    Effect.mapError(toServerWorkflowError("FactoryRunAcceptFailed"))
  );
}

export class PreparedFactoryRunAcceptanceV1 extends Schema.Class<PreparedFactoryRunAcceptanceV1>(
  "PreparedFactoryRunAcceptanceV1"
)({
  input: CreateRunRequest,
  preparedSpec: PreparedServerRunAcceptanceV1,
  resolvedExecution: ResolvedHarnessExecution,
}) {}

export function prepareFactoryRunAcceptance(
  input: FactoryRunCreateInput,
  options: ServerWorkflowOptions = {}
) {
  return assertFactoryRunAcceptanceSecretSafe(input).pipe(
    Effect.flatMap(() =>
      prepareServerRunAcceptance(
        {
          specMarkdown: input.workItem.description,
          title: input.workItem.title,
        },
        {
          ...options,
          workspaceSource:
            options.workspaceSource ??
            localDirectoryWorkspaceSource(options.rootDirectory ?? "."),
        }
      )
    ),
    Effect.flatMap((preparedSpec) => {
      const registry = options.harnessProviderRegistry;
      if (registry === undefined)
        return Effect.fail(
          makeRuntimeError({
            code: "HarnessProviderRegistryMissing",
            message: "No harness provider registry is available for this run.",
            recoverable: true,
          })
        );
      return registry
        .resolve(input.execution, issueDeliveryWorkerHarnessCapabilities)
        .pipe(
          Effect.mapError(harnessAcceptanceError),
          Effect.map(
            (resolved) =>
              ({
                input,
                preparedSpec,
                resolvedExecution: resolved.execution,
              }) satisfies PreparedFactoryRunAcceptanceV1
          )
        );
    })
  );
}

export function acceptPreparedFactoryRun(
  prepared: PreparedFactoryRunAcceptanceV1,
  options: ServerWorkflowOptions = {}
) {
  return withRunStoreLock(
    options,
    acceptFactoryRunUnlocked(
      prepared.input,
      prepared.preparedSpec,
      prepared.resolvedExecution,
      options
    ),
    {
      nextSafeAction:
        "Wait for the active Gaia factory run acceptance to finish, then retry.",
      operation: "Gaia factory run acceptance",
    }
  );
}

function acceptServerRunUnlocked(
  prepared: PreparedServerRunAcceptanceV1,
  options: ServerWorkflowOptions
): Effect.Effect<
  ServerRunAcceptance,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const { input, spec } = prepared;
    const runId = yield* generateRunId;
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;

    yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunAcceptFailed",
          message: "Gaia server could not create the accepted run directory.",
          recoverable: true,
        })
      )
    );
    const checkpoint = makeAcceptedRunInputCheckpointV1({
      acceptanceKind: "server",
      acceptedSemantics: JSON.parse(
        JSON.stringify({
          browserEvidenceRequirement: prepared.browserEvidenceRequirement,
          ...(prepared.explicitBrowserEvidenceTargetUrl === undefined
            ? {}
            : {
                browserEvidenceTargetUrl:
                  prepared.explicitBrowserEvidenceTargetUrl,
              }),
          ...(prepared.codexHarness === undefined
            ? {}
            : { codexHarness: prepared.codexHarness }),
          installer: prepared.installer,
          ...(prepared.processHarness === undefined
            ? {}
            : { processHarness: prepared.processHarness }),
          profile: prepared.runProfile,
          skills: prepared.skillManifest,
          source: "server",
          workspaceSource: prepared.workspaceSource,
        })
      ),
      runId,
      spec: {
        body: spec.body,
        bodyDigest: createHash("sha256").update(spec.body).digest("hex"),
        byteLength: Buffer.byteLength(spec.body, "utf8"),
        title: spec.title,
      },
      version: 1,
    });
    const checkpointRef = yield* commitAcceptedRunInputCheckpointNoReplace(
      paths,
      checkpoint
    );
    yield* fs.writeFileString(paths.input, input.specMarkdown).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunAcceptFailed",
          message: "Gaia server could not persist the accepted run input.",
          recoverable: true,
        })
      )
    );
    yield* fs.writeFileString(paths.latest, runId).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunAcceptFailed",
          message: "Gaia server could not update the latest-run pointer.",
          recoverable: true,
        })
      )
    );
    const { event } = yield* appendEvent(runId, paths, {
      payload: {
        acceptedInputCheckpoint: Schema.encodeSync(
          AcceptedRunInputCheckpointRefV1
        )(checkpointRef),
        modelInvocationProtocol: "v1",
        source: "server",
        specPath: "input.md",
      },
      type: "RUN_CREATED",
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof GaiaRuntimeError
          ? cause
          : makeRuntimeError({
              cause,
              code: "ServerRunAcceptFailed",
              message: "Gaia server could not append RUN_CREATED.",
              recoverable: true,
            })
      )
    );

    return {
      acceptedAt: event.timestamp,
      eventSequence: event.sequence,
      runDirectory: paths.root,
      runId,
    } satisfies ServerRunAcceptance;
  });
}

function acceptFactoryRunUnlocked(
  input: FactoryRunCreateInput,
  preparedSpec: PreparedServerRunAcceptanceV1,
  acceptedExecution: ResolvedHarnessExecution,
  options: ServerWorkflowOptions
): Effect.Effect<
  ServerRunAcceptance,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const runId = yield* generateRunId;
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;
    const delivery = yield* acceptedDeliveryProvenance(
      runId,
      input.delivery ?? { mode: "local" },
      options
    );
    const deliveryFeedbackTrustPolicy =
      delivery.mode === "pullRequest"
        ? yield* acceptedDeliveryFeedbackTrustPolicy(delivery, options)
        : undefined;

    yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunAcceptFailed",
          message:
            "Gaia server could not create the accepted factory run directory.",
          recoverable: true,
        })
      )
    );
    const eventProjection = {
      execution: {
        resolved: encodeResolvedHarnessExecution(acceptedExecution),
        selection: { harnessProfileId: input.execution.harnessProfileId },
      },
      delivery,
      ...(deliveryFeedbackTrustPolicy === undefined
        ? {}
        : {
            deliveryFeedbackTrustPolicy: Schema.encodeSync(
              DeliveryFeedbackTrustPolicyV1
            )(deliveryFeedbackTrustPolicy),
          }),
      workflow: input.workflow,
      workItem: {
        description: input.workItem.description,
        ...(input.workItem.externalRefs === undefined
          ? {}
          : {
              externalRefs: input.workItem.externalRefs.map((ref) => ({
                id: ref.id,
                provider: ref.provider,
                ...(ref.url === undefined ? {} : { url: ref.url }),
              })),
            }),
        kind: input.workItem.kind,
        title: input.workItem.title,
      },
    };
    const checkpoint = makeAcceptedRunInputCheckpointV1({
      acceptanceKind: "factory",
      acceptedSemantics: JSON.parse(
        JSON.stringify({
          ...eventProjection,
          browserEvidenceRequirement: preparedSpec.browserEvidenceRequirement,
          ...(preparedSpec.explicitBrowserEvidenceTargetUrl === undefined
            ? {}
            : {
                browserEvidenceTargetUrl:
                  preparedSpec.explicitBrowserEvidenceTargetUrl,
              }),
          ...(preparedSpec.codexHarness === undefined
            ? {}
            : { codexHarness: preparedSpec.codexHarness }),
          installer: preparedSpec.installer,
          ...(preparedSpec.processHarness === undefined
            ? {}
            : { processHarness: preparedSpec.processHarness }),
          profile: preparedSpec.runProfile,
          skills: preparedSpec.skillManifest,
          source: "server",
          workspaceSource: preparedSpec.workspaceSource,
        })
      ),
      runId,
      spec: {
        body: preparedSpec.spec.body,
        bodyDigest: createHash("sha256")
          .update(preparedSpec.spec.body)
          .digest("hex"),
        byteLength: Buffer.byteLength(preparedSpec.spec.body, "utf8"),
        title: preparedSpec.spec.title,
      },
      version: 1,
    });
    const checkpointRef = yield* commitAcceptedRunInputCheckpointNoReplace(
      paths,
      checkpoint
    );
    yield* fs.writeFileString(paths.input, input.workItem.description).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunAcceptFailed",
          message:
            "Gaia server could not persist the accepted factory run input.",
          recoverable: true,
        })
      )
    );
    yield* fs.writeFileString(paths.latest, runId).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunAcceptFailed",
          message: "Gaia server could not update the latest-run pointer.",
          recoverable: true,
        })
      )
    );
    const { event } = yield* appendEvent(runId, paths, {
      payload: {
        acceptedInputCheckpoint: Schema.encodeSync(
          AcceptedRunInputCheckpointRefV1
        )(checkpointRef),
        ...eventProjection,
        modelInvocationProtocol: "v1",
        source: "server",
        specPath: "input.md",
      },
      type: "RUN_CREATED",
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof GaiaRuntimeError
          ? cause
          : makeRuntimeError({
              cause,
              code: "FactoryRunAcceptFailed",
              message: "Gaia server could not append factory RUN_CREATED.",
              recoverable: true,
            })
      )
    );

    yield* writeInitialFactoryRunIndexes({
      paths,
      runId,
    }).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunProjectionWriteFailed",
          message:
            "Gaia server could not write initial factory run projections.",
          recoverable: true,
        })
      )
    );

    return {
      acceptedAt: event.timestamp,
      eventSequence: event.sequence,
      runDirectory: paths.root,
      runId,
    } satisfies ServerRunAcceptance;
  });
}

export function continueServerRun(
  runId: RunId,
  options: ServerWorkflowOptions = {}
): Effect.Effect<
  CommandSummary,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  const lockFailure = {
    nextSafeAction:
      "Wait for the active Gaia server run continuation to finish, then retry.",
    operation: "Gaia server run continuation",
  } as const;
  return prepareAcceptedServerContinuation(runId, options).pipe(
    Effect.mapError(toServerWorkflowError("ServerRunContinuationFailed")),
    Effect.matchEffect({
      onFailure: (error) =>
        withRunStoreLock(
          options,
          Effect.gen(function* () {
            const paths = yield* makeRunPaths(runId, options);
            return yield* failServerRunIfNeeded(
              runId,
              paths,
              "runningWorker",
              error
            );
          }),
          lockFailure
        ),
      onSuccess: (prepared) =>
        withRunStoreLock(
          options,
          continueServerRunUnlocked(runId, options, prepared),
          lockFailure
        ),
    }),
    Effect.mapError(toServerWorkflowError("ServerRunContinuationFailed"))
  );
}

type PreparedAcceptedServerContinuation = {
  readonly checkpoint?: AcceptedRunInputCheckpointV1;
  readonly resolvedFactoryProvider?: ResolvedHarnessProvider;
  readonly runControlOutcomeUnknown?: true;
  readonly semantics?: AcceptedRunInputSemanticsV1;
};

function prepareAcceptedServerContinuation(
  runId: RunId,
  options: ServerWorkflowOptions
): Effect.Effect<
  PreparedAcceptedServerContinuation,
  unknown,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);
    if (hasStickyRunControlAmbiguity(loaded.events))
      return { runControlOutcomeUnknown: true };
    const resolution = yield* Effect.try({
      try: () => resolveAcceptedRunInputCheckpoint(loaded.events),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "AcceptedRunInputCheckpointRefInvalid",
          message: "The accepted input checkpoint event reference is invalid.",
          recoverable: false,
        }),
    });
    if (resolution.kind === "legacyAbsent") return {};
    const checkpoint = yield* loadAcceptedRunInputCheckpoint(
      paths,
      resolution.ref
    );
    if (checkpoint.payload.runId !== runId)
      return yield* Effect.fail(
        makeRuntimeError({
          code: "AcceptedRunInputCheckpointBindingMismatch",
          message: "The accepted input checkpoint belongs to another run.",
          recoverable: false,
        })
      );
    const semantics = yield* Effect.try({
      try: () => decodeAcceptedRunInputSemantics(checkpoint),
      catch: (cause) =>
        acceptedRunCapabilityMismatch(
          "The accepted input checkpoint semantics are invalid.",
          cause
        ),
    });
    yield* assertCurrentAcceptedSemantics(semantics, options);
    const firstEvent = loaded.events[0];
    if (firstEvent === undefined || firstEvent.type !== "RUN_CREATED")
      return yield* Effect.fail(
        acceptedRunCapabilityMismatch(
          "The accepted input checkpoint has no authoritative run owner."
        )
      );
    yield* assertCheckpointEventProjection(checkpoint, semantics, firstEvent);
    const sessionEvents = issueDeliveryWorkerSessionEvents(
      runId,
      loaded.events
    );
    const runState = snapshotFromReplay(loaded.events).state;
    const continuationState = issueDeliveryWorkerContinuationState(
      loaded.events,
      sessionEvents
    );
    const resolvedFactoryProvider =
      checkpoint.payload.acceptanceKind === "factory" &&
      runState !== "waitingForHuman" &&
      runState !== "paused" &&
      runState !== "cancelled" &&
      continuationState !== "completed" &&
      continuationState !== "terminal"
        ? yield* resolveAcceptedFactoryProvider(semantics, options)
        : undefined;
    return {
      checkpoint,
      ...(resolvedFactoryProvider === undefined
        ? {}
        : { resolvedFactoryProvider }),
      semantics,
    };
  });
}

function acceptedRunCapabilityMismatch(message: string, cause?: unknown) {
  return makeRuntimeError({
    cause,
    code: "AcceptedRunCapabilityMismatch",
    message,
    recoverable: false,
  });
}

const decodeSemanticJson = Schema.decodeUnknownSync(Schema.Json);

function semanticEqual(left: unknown, right: unknown) {
  if (left === undefined || right === undefined) return left === right;
  try {
    const decodedLeft = decodeSemanticJson(left);
    const decodedRight = decodeSemanticJson(right);
    return Buffer.from(
      canonicalV1("gaia.accepted-run-semantic-comparison.v1", [decodedLeft])
    ).equals(
      Buffer.from(
        canonicalV1("gaia.accepted-run-semantic-comparison.v1", [decodedRight])
      )
    );
  } catch {
    return false;
  }
}

function assertCurrentAcceptedSemantics(
  accepted: AcceptedRunInputSemanticsV1,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    const currentCodex = yield* Effect.try({
      try: () => decodeCodexBatchSemanticConfig(options.codexHarness),
      catch: (cause) =>
        acceptedRunCapabilityMismatch(
          "Current Codex semantics do not match the accepted run.",
          cause
        ),
    });
    const currentProcess = yield* Effect.try({
      try: () => decodeProcessHarnessSemanticConfig(options.processHarness),
      catch: (cause) =>
        acceptedRunCapabilityMismatch(
          "Current process semantics do not match the accepted run.",
          cause
        ),
    });
    const currentInstaller =
      options.skillInstaller?.command === undefined
        ? undefined
        : yield* Effect.try({
            try: () =>
              prepareSkillInstaller(options.skillInstaller, accepted.skills),
            catch: (cause) =>
              acceptedRunCapabilityMismatch(
                "Current installer semantics do not match the accepted run.",
                cause
              ),
          });
    const candidates: ReadonlyArray<readonly [unknown, unknown]> = [
      [currentCodex, accepted.codexHarness],
      [currentProcess, accepted.processHarness],
      [currentInstaller, accepted.installer],
      [options.workspaceSource, accepted.workspaceSource],
      [options.browserEvidenceRequirement, accepted.browserEvidenceRequirement],
      [options.browserEvidenceTargetUrl, accepted.browserEvidenceTargetUrl],
    ];
    for (const [current, expected] of candidates) {
      if (current !== undefined && !semanticEqual(current, expected))
        return yield* Effect.fail(
          acceptedRunCapabilityMismatch(
            "Current run semantics do not match the accepted checkpoint."
          )
        );
    }
  });
}

function assertCheckpointEventProjection(
  checkpoint: AcceptedRunInputCheckpointV1,
  semantics: AcceptedRunInputSemanticsV1,
  firstEvent: RunEvent
) {
  return Effect.gen(function* () {
    if (firstEvent.runId !== checkpoint.payload.runId)
      return yield* Effect.fail(
        acceptedRunCapabilityMismatch(
          "The accepted checkpoint and RUN_CREATED event bind different runs."
        )
      );
    if (checkpoint.payload.acceptanceKind !== "factory") return;
    for (const [field, expected] of [
      ["delivery", semantics.delivery],
      ["deliveryFeedbackTrustPolicy", semantics.deliveryFeedbackTrustPolicy],
      ["execution", semantics.execution],
      ["workflow", semantics.workflow],
      ["workItem", semantics.workItem],
    ] as const) {
      if (!semanticEqual(firstEvent.payload[field], expected))
        return yield* Effect.fail(
          acceptedRunCapabilityMismatch(
            "The accepted checkpoint disagrees with RUN_CREATED."
          )
        );
    }
  });
}

function resolveAcceptedFactoryProvider(
  semantics: AcceptedRunInputSemanticsV1,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    const registry = options.harnessProviderRegistry;
    if (registry === undefined)
      return yield* Effect.fail(
        acceptedRunCapabilityMismatch(
          "The accepted factory provider capability is unavailable."
        )
      );
    const execution = semantics.execution;
    const accepted = yield* Effect.try({
      try: () => ({
        resolved: decodeResolvedHarnessExecution(
          jsonObjectField(execution, "resolved")
        ),
        selection: decodeHarnessExecutionSelection(
          jsonObjectField(execution, "selection")
        ),
      }),
      catch: (cause) =>
        acceptedRunCapabilityMismatch(
          "The accepted factory provider binding is invalid.",
          cause
        ),
    });
    const resolved = yield* registry
      .resolve(accepted.selection, issueDeliveryWorkerHarnessCapabilities)
      .pipe(
        Effect.mapError((cause) =>
          acceptedRunCapabilityMismatch(
            "The accepted factory provider capability changed.",
            cause
          )
        )
      );
    if (
      !semanticEqual(
        encodeResolvedHarnessExecution(resolved.execution),
        encodeResolvedHarnessExecution(accepted.resolved)
      )
    )
      return yield* Effect.fail(
        acceptedRunCapabilityMismatch(
          "The accepted factory provider capability changed."
        )
      );
    return resolved;
  });
}

function continueServerRunUnlocked(
  runId: RunId,
  options: ServerWorkflowOptions,
  prepared: PreparedAcceptedServerContinuation
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunUnreadable",
          message: `Gaia server could not read accepted run ${runId}.`,
          recoverable: true,
        })
      )
    );
    const firstEvent = loaded.events[0];
    if (
      firstEvent === undefined ||
      firstEvent.type !== "RUN_CREATED" ||
      firstEvent.payload["source"] !== "server"
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotServerCreated",
          message: `Run ${runId} was not accepted by the local Gaia server.`,
          recoverable: false,
        })
      );
    }

    if (
      prepared.runControlOutcomeUnknown === true ||
      hasStickyRunControlAmbiguity(loaded.events)
    )
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunControlOutcomeUnknown",
          message:
            "The durable run-control outcome is unknown; automatic continuation is forbidden.",
          recoverable: false,
        })
      );

    const snapshot = snapshotFromReplay(loaded.events);
    if (
      snapshot.state === "waitingForHuman" ||
      snapshot.state === "paused" ||
      snapshot.state === "cancelled" ||
      snapshot.state === "completed" ||
      snapshot.state === "failed"
    ) {
      const proofAggregate = proofAggregateFromSnapshot(
        snapshot.context["runProof"]
      );
      return {
        reportPath:
          snapshot.state === "completed" ? paths.reportMarkdown : undefined,
        runDirectory: paths.root,
        runId,
        ...(proofAggregate === undefined ? {} : { proofAggregate }),
        state: snapshot.state,
        status:
          snapshot.state === "cancelled"
            ? "cancelled"
            : snapshot.state === "completed" || snapshot.state === "failed"
              ? snapshot.state
              : "running",
      } satisfies CommandSummary;
    }

    if (
      firstEvent.payload["workflow"] === "issueDelivery" &&
      isDeliveryPublicationReady(loaded.events)
    ) {
      return yield* continueDeliveryPublication(runId, paths, options);
    }

    const resolution = yield* Effect.try({
      try: () => resolveAcceptedRunInputCheckpoint(loaded.events),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "AcceptedRunInputCheckpointRefInvalid",
          message: "The accepted input checkpoint event reference is invalid.",
          recoverable: false,
        }),
    });
    let spec: ReturnType<typeof parseMarkdownSpec>;
    if (resolution.kind === "v1") {
      if (prepared.checkpoint === undefined)
        return yield* Effect.fail(
          makeRuntimeError({
            code: "AcceptedRunInputCheckpointBindingMismatch",
            message:
              "The accepted input checkpoint changed during continuation.",
            recoverable: false,
          })
        );
      const checkpoint = yield* loadAcceptedRunInputCheckpoint(
        paths,
        resolution.ref
      );
      if (
        checkpoint.checkpointId !== prepared.checkpoint.checkpointId ||
        checkpoint.checkpointDigest !== prepared.checkpoint.checkpointDigest
      )
        return yield* Effect.fail(
          makeRuntimeError({
            code: "AcceptedRunInputCheckpointBindingMismatch",
            message:
              "The accepted input checkpoint changed during continuation.",
            recoverable: false,
          })
        );
      spec = yield* parseServerSpec({
        specMarkdown: checkpoint.payload.spec.body,
        title: checkpoint.payload.spec.title,
      });
    } else {
      const fs = yield* FileSystem.FileSystem;
      const specMarkdown = yield* fs.readFileString(paths.input).pipe(
        Effect.mapError((cause) =>
          makeRuntimeError({
            cause,
            code: "ServerRunInputUnreadable",
            message: `Gaia server could not read accepted input for ${runId}.`,
            recoverable: true,
          })
        )
      );
      spec = yield* parseServerSpec({ specMarkdown, title: runId });
    }

    const summary = yield* Effect.gen(function* () {
      const acceptedOptions =
        prepared.semantics === undefined
          ? options
          : workflowOptionsFromAcceptedSemantics(prepared.semantics, options);
      const preparedAcceptance =
        prepared.checkpoint === undefined || prepared.semantics === undefined
          ? undefined
          : preparedAcceptanceFromCheckpoint(
              prepared.checkpoint,
              prepared.semantics,
              spec
            );
      const continuationOptions =
        firstEvent.payload["workflow"] === "issueDelivery"
          ? yield* factoryContinuationOptions(
              firstEvent,
              loaded.events,
              acceptedOptions,
              prepared.resolvedFactoryProvider
            )
          : acceptedOptions;
      return yield* continueAcceptedRun(
        runId,
        paths,
        spec,
        continuationOptions,
        preparedAcceptance
      );
    }).pipe(
      Effect.mapError((error) =>
        error instanceof GaiaRuntimeError
          ? error
          : makeRuntimeError({
              cause: error,
              code: "ServerRunContinuationFailed",
              message: `Gaia server could not continue accepted run ${runId}.`,
              recoverable: true,
            })
      ),
      Effect.catchTag("GaiaRuntimeError", (error) =>
        failServerRunIfNeeded(runId, paths, "runningWorker", error)
      )
    );
    if (
      firstEvent.payload["workflow"] === "issueDelivery" &&
      summary.state === "delivering"
    ) {
      const refreshed = yield* loadRun(paths);
      if (isDeliveryPublicationReady(refreshed.events)) {
        return yield* continueDeliveryPublication(runId, paths, options);
      }
    }
    return summary;
  });
}

function workflowOptionsFromAcceptedSemantics(
  accepted: AcceptedRunInputSemanticsV1,
  options: ServerWorkflowOptions
): ServerWorkflowOptions {
  const {
    browserEvidenceRequirement: _browserEvidenceRequirement,
    browserEvidenceTargetUrl: _browserEvidenceTargetUrl,
    codexHarness: currentCodex,
    processHarness: _processHarness,
    runProfileSource: _runProfileSource,
    skillInstaller: currentInstaller,
    skillManifestSource: _skillManifestSource,
    workspaceSource: _workspaceSource,
    ...capabilities
  } = options;
  const codexHarness =
    accepted.codexHarness === undefined
      ? undefined
      : {
          ...(currentCodex?.commandRunner === undefined
            ? {}
            : { commandRunner: currentCodex.commandRunner }),
          config: makeCodexHarnessConfig({
            command: accepted.codexHarness.command,
            extraArgs: accepted.codexHarness.extraArgs,
            ...(accepted.codexHarness.model === undefined
              ? {}
              : { model: accepted.codexHarness.model }),
            ...(accepted.codexHarness.profile === undefined
              ? {}
              : { profile: accepted.codexHarness.profile }),
            sandbox: accepted.codexHarness.sandbox,
            timeoutMs: accepted.codexHarness.timeoutMs,
          }),
        };
  return {
    ...capabilities,
    browserEvidenceRequirement: accepted.browserEvidenceRequirement,
    ...(accepted.browserEvidenceTargetUrl === undefined
      ? {}
      : { browserEvidenceTargetUrl: accepted.browserEvidenceTargetUrl }),
    ...(codexHarness === undefined ? {} : { codexHarness }),
    ...(accepted.processHarness === undefined
      ? {}
      : {
          processHarness: makeProcessHarnessConfig(
            accepted.processHarness.command,
            accepted.processHarness.args
          ),
        }),
    skillInstaller: {
      command: accepted.installer.command,
      ...(currentInstaller?.commandRunner === undefined
        ? {}
        : { commandRunner: currentInstaller.commandRunner }),
    },
    workspaceSource: accepted.workspaceSource,
  };
}

function preparedAcceptanceFromCheckpoint(
  checkpoint: AcceptedRunInputCheckpointV1,
  accepted: AcceptedRunInputSemanticsV1,
  spec: ReturnType<typeof parseMarkdownSpec>
): PreparedSpecRunAcceptanceV1 {
  return {
    browserEvidenceRequirement: accepted.browserEvidenceRequirement,
    ...(accepted.browserEvidenceTargetUrl === undefined
      ? {}
      : {
          explicitBrowserEvidenceTargetUrl: accepted.browserEvidenceTargetUrl,
        }),
    ...(accepted.codexHarness === undefined
      ? {}
      : { codexHarness: accepted.codexHarness }),
    input: checkpoint.payload.spec.body,
    installer: accepted.installer,
    ...(accepted.processHarness === undefined
      ? {}
      : { processHarness: accepted.processHarness }),
    runProfile: accepted.profile,
    skillManifest: accepted.skills,
    spec,
    specDigest: parseSpecDigest(checkpoint.payload.spec.bodyDigest),
    specPath: Schema.decodeUnknownSync(RuntimePathSchema)("input.md"),
    workspaceSource: accepted.workspaceSource,
  };
}

function continueServerRunWorkerOnly(
  runId: RunId,
  options: ServerWorkflowOptions,
  preparedInput?: PreparedAcceptedServerContinuation
) {
  return Effect.gen(function* () {
    const prepared =
      preparedInput ??
      (yield* prepareAcceptedServerContinuation(runId, options));
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunUnreadable",
          message: `Gaia server could not read accepted run ${runId}.`,
          recoverable: true,
        })
      )
    );
    const firstEvent = loaded.events[0];
    if (
      firstEvent === undefined ||
      firstEvent.type !== "RUN_CREATED" ||
      firstEvent.payload["source"] !== "server"
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotServerCreated",
          message: `Run ${runId} was not accepted by the local Gaia server.`,
          recoverable: false,
        })
      );
    }
    if (firstEvent.payload["workflow"] !== "issueDelivery") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryActionConflict",
          message:
            "Audited worker continuation is only available for issue delivery runs.",
          recoverable: false,
        })
      );
    }
    const resolution = yield* Effect.try({
      try: () => resolveAcceptedRunInputCheckpoint(loaded.events),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "AcceptedRunInputCheckpointRefInvalid",
          message: "The accepted input checkpoint event reference is invalid.",
          recoverable: false,
        }),
    });
    const spec =
      resolution.kind === "v1"
        ? yield* Effect.gen(function* () {
            if (
              prepared.checkpoint === undefined ||
              prepared.semantics === undefined ||
              resolution.ref.checkpointId !==
                prepared.checkpoint.checkpointId ||
              resolution.ref.checkpointDigest !==
                prepared.checkpoint.checkpointDigest
            )
              return yield* Effect.fail(
                makeRuntimeError({
                  code: "AcceptedRunInputCheckpointBindingMismatch",
                  message:
                    "The accepted input checkpoint changed during audited continuation.",
                  recoverable: false,
                })
              );
            return yield* parseServerSpec({
              specMarkdown: prepared.checkpoint.payload.spec.body,
              title: prepared.checkpoint.payload.spec.title,
            });
          })
        : yield* Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const specMarkdown = yield* fs.readFileString(paths.input).pipe(
              Effect.mapError((cause) =>
                makeRuntimeError({
                  cause,
                  code: "ServerRunInputUnreadable",
                  message: `Gaia server could not read accepted input for ${runId}.`,
                  recoverable: true,
                })
              )
            );
            return yield* parseServerSpec({ specMarkdown, title: runId });
          });

    return yield* Effect.gen(function* () {
      const acceptedOptions =
        prepared.semantics === undefined
          ? options
          : workflowOptionsFromAcceptedSemantics(prepared.semantics, options);
      const continuationOptions = yield* factoryContinuationOptions(
        firstEvent,
        loaded.events,
        acceptedOptions,
        prepared.resolvedFactoryProvider
      );
      return yield* continueAcceptedRun(
        runId,
        paths,
        spec,
        continuationOptions,
        prepared.checkpoint === undefined || prepared.semantics === undefined
          ? undefined
          : preparedAcceptanceFromCheckpoint(
              prepared.checkpoint,
              prepared.semantics,
              spec
            )
      );
    }).pipe(
      Effect.mapError((error) =>
        error instanceof GaiaRuntimeError
          ? error
          : makeRuntimeError({
              cause: error,
              code: "ServerRunContinuationFailed",
              message: `Gaia server could not continue accepted run ${runId}.`,
              recoverable: true,
            })
      ),
      Effect.catchTag("GaiaRuntimeError", (error) =>
        failServerRunIfNeeded(runId, paths, "runningWorker", error)
      )
    );
  });
}

/** Execute exactly one public verification action under the server-workflow lock. */
export function actOnRunVerification(
  runId: RunId,
  actionInput: VerificationActionRequest,
  options: ServerWorkflowOptions = {}
) {
  return withRunStoreLock(
    options,
    Effect.scoped(actOnRunVerificationUnlocked(runId, actionInput, options)),
    {
      nextSafeAction:
        "Refresh the exact run authority before retrying verification.",
      operation: "Gaia claim verification action",
    }
  ).pipe(Effect.mapError(toServerWorkflowError("VerificationProviderFailure")));
}

function actOnRunVerificationUnlocked(
  runId: RunId,
  actionInput: VerificationActionRequest,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    const action = yield* Effect.try({
      try: () => parseVerificationActionRequest(actionInput),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "VerificationActionInvalidRequest",
          message: "Verification action input is invalid.",
          recoverable: false,
        }),
    });
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);
    const contract = yield* loadRunContract(paths, runId);
    if (contract.version !== 2)
      return yield* verificationFailure(
        "VerificationActionUnsupportedPhase",
        "Public verification actions require a V2 run contract."
      );
    const actionRequestDigest = verificationActionRequestDigest(action);
    const prior = priorVerificationActionResult(
      runId,
      action,
      actionRequestDigest,
      contract,
      loaded.events
    );
    if (prior.kind === "conflict")
      return yield* verificationFailure(
        "VerificationActionIdempotencyConflict",
        "The verification action ID is already bound to different input."
      );
    if (prior.kind === "replay") return prior.result;
    if (prior.kind === "incomplete")
      return yield* verificationFailure(
        "VerificationCreatedWithoutCommandStart",
        "A prior verification action has no reconstructable terminal result."
      );

    const latestSequence = loaded.events.at(-1)?.sequence ?? 0;
    const contentAuthoritySequence = verificationContentAuthoritySequence(
      loaded.events
    );
    if (
      latestSequence !== action.expectedEventSequence ||
      contract.contractDigest !== action.expectedContractDigest ||
      contentAuthoritySequence !== action.expectedContentAuthoritySequence
    )
      return yield* verificationFailure(
        "VerificationActionStaleAuthority",
        "Verification action authority is stale."
      );

    if (action.kind === "startPostPublicationGeneration") {
      if (contract.targetDigest !== action.expectedTargetDigest)
        return yield* verificationFailure(
          "VerificationActionStaleAuthority",
          "Verification target digest changed before action acceptance."
        );
      const observed = yield* observeWorkspaceStructuralDigest(paths.workspace);
      if (observed.digest !== contract.targetDigest)
        return yield* verificationFailure(
          "VerificationActionStaleAuthority",
          "Disposable workspace no longer matches the immutable target."
        );
      const publicationEvent = loaded.events.find(
        (event) => event.sequence === action.expectedPublicationSequence
      );
      if (publicationEvent?.type !== "DELIVERY_PUBLICATION_CONFIRMED")
        return yield* verificationFailure(
          "VerificationActionUnsupportedPhase",
          "Post-publication verification requires exact confirmed publication."
        );
      const publication = parseDeliveryPublication(
        publicationEvent.payload["publication"]
      );
      if (
        publication.state !== "confirmed" ||
        publication.headSha !== action.expectedHeadSha
      )
        return yield* verificationFailure(
          "VerificationActionStaleAuthority",
          "Published exact-head authority changed before verification."
        );
      const result = yield* recordRunProofResult(runId, paths, {
        actionId: action.actionId,
        actionRequestDigest,
        expectedHeadSha: action.expectedHeadSha,
        phase: "postPublication",
        ...(options.verificationServices === undefined
          ? {}
          : { verificationServices: options.verificationServices }),
      });
      if (result.version !== 2)
        return yield* verificationFailure(
          "VerificationActionUnsupportedPhase",
          "Post-publication action produced a legacy proof result."
        );
      const generationSequence = latestGenerationSequenceForAction(
        yield* loadRun(paths),
        action.actionId
      );
      return PostPublicationGenerationRecorded.make({
        actionId: action.actionId,
        actionRequestDigest,
        aggregate: result.aggregate,
        currentContentAuthoritySequence: contentAuthoritySequence,
        expectedContentAuthoritySequence:
          action.expectedContentAuthoritySequence,
        generationSequence,
        headSha: action.expectedHeadSha,
        kind: "postPublicationGenerationRecorded",
        proofResultDigest: result.resultDigest,
        proofResultSequence: result.recordedBy.sequence,
        publicationSequence: action.expectedPublicationSequence,
        replayed: false,
        runId,
        targetDigest: action.expectedTargetDigest,
      });
    }

    if (options.verificationServices === undefined)
      return yield* verificationFailure(
        "VerificationProviderFailure",
        "Verification reconciliation provider is unavailable."
      );
    const priorIdentity = yield* Effect.try({
      try: () =>
        exactVerificationReconciliationPrior(
          action,
          contract.contractDigest,
          loaded.events
        ),
      catch: (cause) =>
        cause instanceof GaiaRuntimeError
          ? cause
          : makeRuntimeError({
              cause,
              code: "VerificationActionUnsupportedReconciliation",
              message: "Verification reconciliation prior is invalid.",
              recoverable: false,
            }),
    });
    const receipt = yield* options.verificationServices.executor.reconcile({
      actionId: action.actionId,
      claimId: action.claimId,
      contractDigest: contract.contractDigest,
      executionEvidenceIdentityDigest:
        action.expectedExecutionEvidenceIdentityDigest,
      generationSequence: action.priorGenerationSequence,
      priorSequence: priorIdentity.sequence,
      reason: action.prior.kind,
      runId,
      sandboxName: action.expectedSandboxName,
      sandboxUuid: action.expectedSandboxUuid,
    });
    const recorded = yield* appendEvent(runId, paths, {
      payload: {
        actionRequestDigest,
        reconciliation: encodeVerificationReconciliationReceiptJson(receipt),
      },
      type: "CLAIM_VERIFICATION_RECONCILIATION_RECORDED",
    });
    const common = {
      actionId: action.actionId,
      actionRequestDigest,
      claimId: action.claimId,
      generationSequence: action.priorGenerationSequence,
      reconciliationReceipt: parseVerificationReconciliationReceipt(receipt),
      reconciliationSequence: recorded.event.sequence,
      replayed: false as const,
      runId,
    };
    return action.prior.kind === "createdWithoutCommandStart"
      ? CreatedWithoutCommandStartReconciled.make({
          ...common,
          kind: "createdWithoutCommandStartReconciled",
          sandboxCreatedSequence: priorIdentity.sequence,
        })
      : CommandStartOutcomeUnknownReconciled.make({
          ...common,
          commandStartSequence: priorIdentity.sequence,
          kind: "commandStartOutcomeUnknownReconciled",
        });
  });
}

export function actOnDeliveryPublication(
  runId: RunId,
  actionInput: typeof DeliveryPublicationActionSchema.Encoded,
  options: ServerWorkflowOptions = {}
) {
  const action: DeliveryPublicationAction =
    parseDeliveryPublicationAction(actionInput);
  return withRunStoreLock(
    options,
    Effect.gen(function* () {
      const paths = yield* makeRunPaths(runId, options);
      const loaded = yield* loadRun(paths);
      const lastSequence = loaded.events.at(-1)?.sequence ?? 0;
      if (lastSequence !== action.expectedEventSequence) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "DeliveryActionConflict",
            message:
              "Delivery state changed before the recovery action was accepted.",
            recoverable: true,
          })
        );
      }
      const snapshot = snapshotFromReplay(loaded.events);
      const delivery = snapshot.context["delivery"];
      const publicationValue =
        delivery !== null &&
        typeof delivery === "object" &&
        !Array.isArray(delivery)
          ? Object.getOwnPropertyDescriptor(delivery, "publication")?.value
          : undefined;
      const publication =
        publicationValue === undefined
          ? undefined
          : parseDeliveryPublication(publicationValue);
      if (
        publication === undefined ||
        (action.kind === "reconcile" &&
          publication.state !== "outcomeUnknown") ||
        (action.kind === "retry" &&
          (publication.state !== "failed" || !publication.recoverable))
      ) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "DeliveryActionConflict",
            message:
              "The requested recovery action is not valid for current delivery state.",
            recoverable: true,
          })
        );
      }
      const publicationOptions = deliveryPublicationOptions(options);
      return action.kind === "reconcile"
        ? yield* (options.deliveryPublisher ?? publishReadyDeliveryRun)(
            runId,
            publicationOptions
          )
        : yield* (
            options.deliveryRetryPublisher ?? retryFailedDeliveryPublication
          )(runId, publicationOptions);
    }),
    {
      nextSafeAction:
        "Refresh delivery state before retrying the recovery action.",
      operation: "Gaia delivery recovery action",
    }
  ).pipe(Effect.mapError(toServerWorkflowError("DeliveryActionFailed")));
}

/** Activate one exact controlled comment through the existing delivery coordinator. */
export function actOnDeliveryRemediation(
  runId: RunId,
  action: DeliveryRemediationActivationActionRequest,
  options: ServerWorkflowOptions = {}
) {
  return withRunStoreLock(
    options,
    Effect.gen(function* () {
      return yield* continueDeliveryRemediation(runId, {
        activationRequest: action,
        ...(options.deliveryPublicationCommandRunner === undefined
          ? {}
          : { commandRunner: options.deliveryPublicationCommandRunner }),
        ...(options.deliveryGitCommandRunner === undefined
          ? {}
          : { deliveryGitCommandRunner: options.deliveryGitCommandRunner }),
        ...(options.deliveryPullRequestReader === undefined
          ? {}
          : { pullRequestReader: options.deliveryPullRequestReader }),
        ...(options.deliveryFeedbackTrustPolicy === undefined
          ? {}
          : { trustPolicy: options.deliveryFeedbackTrustPolicy }),
        ...(options.harnessProviderRegistry === undefined
          ? {}
          : { harnessProviderRegistry: options.harnessProviderRegistry }),
        rootDirectory: options.rootDirectory ?? ".",
        ...(options.sessionCoordinator === undefined
          ? {}
          : { sessionCoordinator: options.sessionCoordinator }),
        verificationOptions: options,
      });
    }),
    {
      nextSafeAction:
        "Wait for the active delivery action to finish, then refresh before retrying.",
      operation: "Gaia controlled remediation activation",
    }
  ).pipe(Effect.mapError(toServerWorkflowError("DeliveryActionFailed")));
}

function continueDeliveryPublication(
  runId: RunId,
  paths: RunPaths,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    yield* (options.deliveryPublisher ?? publishReadyDeliveryRun)(
      runId,
      deliveryPublicationOptions(options)
    );
    if (options.deliveryObservationEnabled === true) {
      yield* continueDeliveryRemediationLoop(runId, options);
    }
    const loaded = yield* loadRun(paths);
    const snapshot = snapshotFromReplay(loaded.events);
    const proofAggregate = proofAggregateFromSnapshot(
      snapshot.context["runProof"]
    );
    return {
      reportPath: paths.reportMarkdown,
      runDirectory: paths.root,
      runId,
      ...(proofAggregate === undefined ? {} : { proofAggregate }),
      state: "delivering",
      status: "running",
    } satisfies CommandSummary;
  });
}

function proofAggregateFromSnapshot(input: unknown) {
  const proof = Schema.decodeUnknownOption(RunProofProjectionSchema)(input);
  return Option.isSome(proof) ? proof.value.aggregate : undefined;
}

function latestWorkerContinuationReceipt(events: ReadonlyArray<RunEvent>) {
  return [...events].reverse().flatMap((event) => {
    if (event.type !== "WORKER_CONTINUATION_RECORDED") return [];
    return [parseWorkerContinuationReceipt(event.payload["continuation"])];
  })[0];
}

function latestWorkerCorrelationReconciliationReceipt(
  events: ReadonlyArray<RunEvent>
) {
  return [...events].reverse().flatMap((event) => {
    if (event.type !== "WORKER_CORRELATION_RECONCILIATION_RECORDED") return [];
    return [
      parseWorkerCorrelationReconciliationReceipt(
        event.payload["reconciliation"]
      ),
    ];
  })[0];
}

function latestWorkerDesktopOriginCorrelationReceipt(
  events: ReadonlyArray<RunEvent>
) {
  return [...events].reverse().flatMap((event) => {
    if (event.type !== "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED") return [];
    return [
      parseWorkerDesktopOriginCorrelationReceipt(
        event.payload["desktopOriginCorrelation"]
      ),
    ];
  })[0];
}

function recordWorkerContinuationReceipt(
  runId: RunId,
  paths: RunPaths,
  receipt: WorkerContinuationReceipt
) {
  return appendEvent(runId, paths, {
    payload: { continuation: encodeWorkerContinuationReceiptJson(receipt) },
    type: "WORKER_CONTINUATION_RECORDED",
  }).pipe(Effect.as(receipt));
}

function recordWorkerCorrelationReconciliationReceipt(
  runId: RunId,
  paths: RunPaths,
  receipt: WorkerCorrelationReconciliationReceipt,
  modelInvocationEpisode?: ModelInvocationEpisodeStartV1,
  modelInvocationObservation?: ModelInvocationObservationV1
) {
  return appendEvent(runId, paths, {
    payload: {
      reconciliation: encodeWorkerCorrelationReconciliationReceiptJson(receipt),
      ...(modelInvocationEpisode === undefined
        ? {}
        : {
            modelInvocationEpisode: Schema.encodeSync(
              ModelInvocationEpisodeStartV1
            )(modelInvocationEpisode),
          }),
      ...(modelInvocationObservation === undefined
        ? {}
        : {
            modelInvocationObservation: Schema.encodeSync(
              ModelInvocationObservationV1
            )(modelInvocationObservation),
          }),
    },
    type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
  }).pipe(Effect.as(receipt));
}

function recordWorkerDesktopOriginCorrelationReceipt(
  runId: RunId,
  paths: RunPaths,
  receipt: WorkerDesktopOriginCorrelationReceipt,
  modelInvocationEpisode?: ModelInvocationEpisodeStartV1,
  modelInvocationObservation?: ModelInvocationObservationV1
) {
  return appendEvent(runId, paths, {
    payload: {
      desktopOriginCorrelation:
        encodeWorkerDesktopOriginCorrelationReceiptJson(receipt),
      ...(modelInvocationEpisode === undefined
        ? {}
        : {
            modelInvocationEpisode: Schema.encodeSync(
              ModelInvocationEpisodeStartV1
            )(modelInvocationEpisode),
          }),
      ...(modelInvocationObservation === undefined
        ? {}
        : {
            modelInvocationObservation: Schema.encodeSync(
              ModelInvocationObservationV1
            )(modelInvocationObservation),
          }),
    },
    type: "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED",
  }).pipe(Effect.as(receipt));
}

function assertWorkerContinuationReplay(
  prior: WorkerContinuationReceipt,
  expected: Omit<WorkerContinuationReceipt, "code" | "message" | "state">
) {
  if (
    JSON.stringify(workerContinuationBinding(prior)) !==
    JSON.stringify(expected)
  ) {
    return Effect.fail(
      makeRuntimeError({
        code: "DeliveryActionConflict",
        message:
          "Another audited worker continuation action is already authoritative.",
        recoverable: false,
      })
    );
  }
  return Effect.void;
}

function assertWorkerCorrelationReconciliationReplay(
  prior: WorkerCorrelationReconciliationReceipt,
  expected: Omit<
    WorkerCorrelationReconciliationReceipt,
    "code" | "message" | "state"
  >
) {
  if (
    JSON.stringify(workerCorrelationReconciliationBinding(prior)) !==
    JSON.stringify(expected)
  ) {
    return Effect.fail(
      makeRuntimeError({
        code: "DeliveryActionConflict",
        message:
          "Another audited worker correlation reconciliation action is already authoritative.",
        recoverable: false,
      })
    );
  }
  return Effect.void;
}

function assertWorkerDesktopOriginCorrelationReplay(
  prior: WorkerDesktopOriginCorrelationReceipt,
  expected: Omit<
    WorkerDesktopOriginCorrelationReceipt,
    "code" | "message" | "state"
  >
) {
  if (
    JSON.stringify(workerDesktopOriginCorrelationBinding(prior)) !==
    JSON.stringify(expected)
  ) {
    return Effect.fail(
      makeRuntimeError({
        code: "DeliveryActionConflict",
        message:
          "Another audited Desktop-origin correlation action is already authoritative.",
        recoverable: false,
      })
    );
  }
  return Effect.void;
}

function workerContinuationBinding(
  receipt: Omit<WorkerContinuationReceipt, "code" | "message" | "state">
) {
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
  receipt: Omit<
    WorkerCorrelationReconciliationReceipt,
    "code" | "message" | "state"
  >
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

function workerDesktopOriginCorrelationBinding(
  receipt: Omit<
    WorkerDesktopOriginCorrelationReceipt,
    "code" | "message" | "state"
  >
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

function assertWorkerContinuationEligibility(
  events: ReadonlyArray<RunEvent>,
  action: WorkerContinuationAction
) {
  return Effect.gen(function* () {
    const currentSequence = events.at(-1)?.sequence ?? 0;
    if (currentSequence !== action.expectedCurrentSequence) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryActionConflict",
          message:
            "Delivery state changed before audited worker continuation was accepted.",
          recoverable: true,
        })
      );
    }
    if (
      action.expectedFailedRecoverySequence !== action.expectedCurrentSequence
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited continuation requires the current failed recovery receipt."
        )
      );
    }
    const firstEvent = events[0];
    const delivery =
      firstEvent === undefined
        ? undefined
        : yield* parseAcceptedDelivery(firstEvent.payload["delivery"]);
    if (
      delivery?.mode !== "pullRequest" ||
      action.expectedDeliveryProvenanceDigest !==
        deliveryProvenanceDigest(delivery.provenance)
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited continuation requires the accepted delivery provenance."
        )
      );
    }
    const failedRecoveryEvent = events.find(
      (event) => event.sequence === action.expectedFailedRecoverySequence
    );
    if (failedRecoveryEvent?.type !== "WORKER_RECOVERY_RECORDED") {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited continuation requires the exact failed recovery receipt."
        )
      );
    }
    const failedRecovery = parseWorkerRecoveryReceipt(
      failedRecoveryEvent.payload["recovery"]
    );
    if (
      failedRecovery.state !== "failed" ||
      failedRecovery.code !== "WorkerRecoveryContinuationFailed" ||
      failedRecovery.actionId !== action.expectedRecoveryActionId ||
      failedRecovery.expectedSessionId !== action.expectedSessionId ||
      failedRecovery.harnessProfileId !== action.harnessProfileId ||
      failedRecovery.nativeTurnIdDigest === undefined
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited continuation requires the exact failed interrupted recovery checkpoint."
        )
      );
    }
    const readyEvent = events.find(
      (event) => event.sequence === action.expectedContaminatedReadySequence
    );
    if (readyEvent?.type !== "DELIVERY_READY_TO_PUBLISH") {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited continuation requires the contaminated ready boundary."
        )
      );
    }
    if (
      events.some(isDeliveryPublicationEvent) ||
      events.some(
        ({ type }) =>
          type === "GITHUB_PR_LOOP_RECORDED" ||
          type === "GITHUB_CHECKS_RECORDED" ||
          type === "GITHUB_FEEDBACK_RECORDED"
      )
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited continuation is unavailable after publication or pull-request evidence exists."
        )
      );
    }
  });
}

function assertWorkerCorrelationReconciliationEligibility(
  events: ReadonlyArray<RunEvent>,
  action: WorkerCorrelationReconciliationAction
) {
  return Effect.gen(function* () {
    const currentSequence = events.at(-1)?.sequence ?? 0;
    if (currentSequence !== action.expectedCurrentSequence) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryActionConflict",
          message:
            "Delivery state changed before audited worker correlation reconciliation was accepted.",
          recoverable: true,
        })
      );
    }
    if (
      action.expectedFailedContinuationSequence !==
      action.expectedCurrentSequence
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited correlation reconciliation requires the current failed continuation receipt."
        )
      );
    }
    const firstEvent = events[0];
    const delivery =
      firstEvent === undefined
        ? undefined
        : yield* parseAcceptedDelivery(firstEvent.payload["delivery"]);
    if (
      delivery?.mode !== "pullRequest" ||
      action.expectedDeliveryProvenanceDigest !==
        deliveryProvenanceDigest(delivery.provenance)
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited correlation reconciliation requires the accepted delivery provenance."
        )
      );
    }
    const failedRecoveryEvent = events.find(
      (event) => event.sequence === action.expectedFailedRecoverySequence
    );
    if (failedRecoveryEvent?.type !== "WORKER_RECOVERY_RECORDED") {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited correlation reconciliation requires the exact failed recovery receipt."
        )
      );
    }
    const failedRecovery = parseWorkerRecoveryReceipt(
      failedRecoveryEvent.payload["recovery"]
    );
    if (
      failedRecovery.state !== "failed" ||
      failedRecovery.code !== "WorkerRecoveryContinuationFailed" ||
      failedRecovery.actionId !== action.expectedRecoveryActionId ||
      failedRecovery.expectedSessionId !== action.expectedSessionId ||
      failedRecovery.harnessProfileId !== action.harnessProfileId ||
      failedRecovery.nativeTurnIdDigest !== action.expectedNativeTurnIdDigest
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited correlation reconciliation requires the exact failed interrupted recovery checkpoint."
        )
      );
    }
    const failedContinuationEvent = events.find(
      (event) => event.sequence === action.expectedFailedContinuationSequence
    );
    if (failedContinuationEvent?.type !== "WORKER_CONTINUATION_RECORDED") {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited correlation reconciliation requires the exact failed audited continuation receipt."
        )
      );
    }
    const failedContinuation = parseWorkerContinuationReceipt(
      failedContinuationEvent.payload["continuation"]
    );
    if (
      failedContinuation.state !== "failed" ||
      failedContinuation.actionId !== action.expectedContinuationActionId ||
      failedContinuation.expectedContaminatedReadySequence !==
        action.expectedContaminatedReadySequence ||
      failedContinuation.expectedDeliveryProvenanceDigest !==
        action.expectedDeliveryProvenanceDigest ||
      failedContinuation.expectedFailedRecoverySequence !==
        action.expectedFailedRecoverySequence ||
      failedContinuation.expectedRecoveryActionId !==
        action.expectedRecoveryActionId ||
      failedContinuation.expectedSessionId !== action.expectedSessionId ||
      failedContinuation.harnessProfileId !== action.harnessProfileId
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited correlation reconciliation requires the exact failed continuation binding."
        )
      );
    }
    const readyEvent = events.find(
      (event) => event.sequence === action.expectedContaminatedReadySequence
    );
    if (readyEvent?.type !== "DELIVERY_READY_TO_PUBLISH") {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited correlation reconciliation requires the contaminated ready boundary."
        )
      );
    }
    if (
      events.some(isDeliveryPublicationEvent) ||
      events.some(
        ({ type }) =>
          type === "GITHUB_PR_LOOP_RECORDED" ||
          type === "GITHUB_CHECKS_RECORDED" ||
          type === "GITHUB_FEEDBACK_RECORDED"
      )
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited correlation reconciliation is unavailable after publication or pull-request evidence exists."
        )
      );
    }
  });
}

function assertWorkerDesktopOriginCorrelationEligibility(
  events: ReadonlyArray<RunEvent>,
  action: WorkerDesktopOriginCorrelationAction
) {
  return Effect.gen(function* () {
    const currentSequence = events.at(-1)?.sequence ?? 0;
    if (currentSequence !== action.expectedCurrentSequence) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryActionConflict",
          message:
            "Delivery state changed before audited Desktop-origin correlation was accepted.",
          recoverable: true,
        })
      );
    }
    if (
      action.expectedFailedCorrelationSequence !==
      action.expectedCurrentSequence
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited Desktop-origin correlation requires the current failed source-classification receipt."
        )
      );
    }
    const firstEvent = events[0];
    const delivery =
      firstEvent === undefined
        ? undefined
        : yield* parseAcceptedDelivery(firstEvent.payload["delivery"]);
    if (
      delivery?.mode !== "pullRequest" ||
      action.expectedDeliveryProvenanceDigest !==
        deliveryProvenanceDigest(delivery.provenance)
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited Desktop-origin correlation requires the accepted delivery provenance."
        )
      );
    }
    const failedRecoveryEvent = events.find(
      (event) => event.sequence === action.expectedFailedRecoverySequence
    );
    if (failedRecoveryEvent?.type !== "WORKER_RECOVERY_RECORDED") {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited Desktop-origin correlation requires the exact failed recovery receipt."
        )
      );
    }
    const failedRecovery = parseWorkerRecoveryReceipt(
      failedRecoveryEvent.payload["recovery"]
    );
    if (
      failedRecovery.state !== "failed" ||
      failedRecovery.code !== "WorkerRecoveryContinuationFailed" ||
      failedRecovery.actionId !== action.expectedRecoveryActionId ||
      failedRecovery.expectedSessionId !== action.expectedSessionId ||
      failedRecovery.harnessProfileId !== action.harnessProfileId ||
      failedRecovery.nativeTurnIdDigest !== action.expectedNativeTurnIdDigest
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited Desktop-origin correlation requires the exact failed interrupted recovery checkpoint."
        )
      );
    }
    const failedContinuationEvent = events.find(
      (event) => event.sequence === action.expectedFailedContinuationSequence
    );
    if (failedContinuationEvent?.type !== "WORKER_CONTINUATION_RECORDED") {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited Desktop-origin correlation requires the exact failed audited continuation receipt."
        )
      );
    }
    const failedContinuation = parseWorkerContinuationReceipt(
      failedContinuationEvent.payload["continuation"]
    );
    if (
      failedContinuation.state !== "failed" ||
      failedContinuation.actionId !== action.expectedContinuationActionId ||
      failedContinuation.expectedContaminatedReadySequence !==
        action.expectedContaminatedReadySequence ||
      failedContinuation.expectedDeliveryProvenanceDigest !==
        action.expectedDeliveryProvenanceDigest ||
      failedContinuation.expectedFailedRecoverySequence !==
        action.expectedFailedRecoverySequence ||
      failedContinuation.expectedRecoveryActionId !==
        action.expectedRecoveryActionId ||
      failedContinuation.expectedSessionId !== action.expectedSessionId ||
      failedContinuation.harnessProfileId !== action.harnessProfileId
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited Desktop-origin correlation requires the exact failed continuation binding."
        )
      );
    }
    const failedCorrelationEvent = events.find(
      (event) => event.sequence === action.expectedFailedCorrelationSequence
    );
    if (
      failedCorrelationEvent?.type !==
      "WORKER_CORRELATION_RECONCILIATION_RECORDED"
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited Desktop-origin correlation requires the exact failed source-classification receipt."
        )
      );
    }
    const failedCorrelation = parseWorkerCorrelationReconciliationReceipt(
      failedCorrelationEvent.payload["reconciliation"]
    );
    if (
      failedCorrelation.state !== "failed" ||
      failedCorrelation.code !== "WorkerCorrelationReconciliationFailed" ||
      failedCorrelation.actionId !== action.expectedCorrelationActionId ||
      failedCorrelation.expectedContaminatedReadySequence !==
        action.expectedContaminatedReadySequence ||
      failedCorrelation.expectedContinuationActionId !==
        action.expectedContinuationActionId ||
      failedCorrelation.expectedDeliveryProvenanceDigest !==
        action.expectedDeliveryProvenanceDigest ||
      failedCorrelation.expectedFailedContinuationSequence !==
        action.expectedFailedContinuationSequence ||
      failedCorrelation.expectedFailedRecoverySequence !==
        action.expectedFailedRecoverySequence ||
      failedCorrelation.expectedNativeTurnIdDigest !==
        action.expectedNativeTurnIdDigest ||
      failedCorrelation.expectedRecoveryActionId !==
        action.expectedRecoveryActionId ||
      failedCorrelation.expectedSessionId !== action.expectedSessionId ||
      failedCorrelation.harnessProfileId !== action.harnessProfileId
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited Desktop-origin correlation requires the exact failed source-classification binding."
        )
      );
    }
    const readyEvent = events.find(
      (event) => event.sequence === action.expectedContaminatedReadySequence
    );
    if (readyEvent?.type !== "DELIVERY_READY_TO_PUBLISH") {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited Desktop-origin correlation requires the contaminated ready boundary."
        )
      );
    }
    if (
      events.some(isDeliveryPublicationEvent) ||
      events.some(
        ({ type }) =>
          type === "GITHUB_PR_LOOP_RECORDED" ||
          type === "GITHUB_CHECKS_RECORDED" ||
          type === "GITHUB_FEEDBACK_RECORDED"
      )
    ) {
      return yield* Effect.fail(
        workerContinuationConflict(
          "Audited Desktop-origin correlation is unavailable after publication or pull-request evidence exists."
        )
      );
    }
  });
}

function workerContinuationConflict(message: string) {
  return makeRuntimeError({
    code: "DeliveryActionConflict",
    message,
    recoverable: false,
  });
}

const workerCorrelationFollowUpText =
  "Continue the interrupted worker recovery from the audited checkpoint. Do not restart the run, publish, merge, or change recovery policy.";

function workerCorrelationFollowUpClientInputId(
  runId: RunId,
  actionId: typeof WorkerRecoveryActionIdSchema.Type
) {
  const digest = createHash("sha256")
    .update(
      ["gaia-worker-correlation-follow-up-v1", runId, actionId].join("\0")
    )
    .digest("hex");
  return `gaia-worker-correlation:${digest}`;
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

function deliveryProvenanceDigest(provenance: DeliveryProvenance) {
  return createHash("sha256")
    .update(
      [
        "gaia-worker-continuation-delivery-provenance-v1",
        provenance.baseBranch,
        provenance.baseRevision,
        provenance.headBranch,
        provenance.remote,
      ].join("\0")
    )
    .digest("hex");
}

function continueDeliveryRemediationLoop(
  runId: RunId,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    const maxAttempts = Math.min(
      20,
      Math.max(1, options.deliveryObservationMaxAttempts ?? 6)
    );
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = yield* continueDeliveryRemediation(runId, {
        ...(options.deliveryFeedbackAuthorization === undefined
          ? {}
          : { authorization: options.deliveryFeedbackAuthorization }),
        ...(options.deliveryPublicationCommandRunner === undefined
          ? {}
          : { commandRunner: options.deliveryPublicationCommandRunner }),
        ...(options.deliveryGitCommandRunner === undefined
          ? {}
          : { deliveryGitCommandRunner: options.deliveryGitCommandRunner }),
        ...(options.deliveryPullRequestReader === undefined
          ? {}
          : { pullRequestReader: options.deliveryPullRequestReader }),
        ...(options.deliveryFeedbackTrustPolicy === undefined
          ? {}
          : { trustPolicy: options.deliveryFeedbackTrustPolicy }),
        ...(options.harnessProviderRegistry === undefined
          ? {}
          : { harnessProviderRegistry: options.harnessProviderRegistry }),
        rootDirectory: options.rootDirectory ?? ".",
        ...(options.sessionCoordinator === undefined
          ? {}
          : { sessionCoordinator: options.sessionCoordinator }),
        verificationOptions: options,
      });
      const remediation = result.remediation;
      if (
        result.observation.status === "ready" ||
        remediation?.state === "outcomeUnknown" ||
        (remediation?.state === "failed" && !remediation.recoverable) ||
        (remediation?.attempt === 2 && remediation.state === "confirmed") ||
        result.observation.blockers.some(
          ({ kind }) =>
            kind === "operatorReviewRequired" ||
            kind === "budgetExhausted" ||
            kind === "mergeConflict" ||
            kind === "expectedHeadChanged"
        )
      ) {
        return result;
      }
      if (attempt < maxAttempts) {
        yield* Effect.sleep(
          options.deliveryObservationPollInterval ?? "10 seconds"
        );
      }
    }
    return undefined;
  });
}

function deliveryPublicationOptions(options: ServerWorkflowOptions) {
  return {
    rootDirectory: options.rootDirectory ?? ".",
    ...(options.deliveryGitCommandRunner === undefined
      ? {}
      : { deliveryGitCommandRunner: options.deliveryGitCommandRunner }),
    ...(options.deliveryPublicationCommandRunner === undefined
      ? {}
      : { commandRunner: options.deliveryPublicationCommandRunner }),
  };
}

function isDeliveryPublicationReady(events: ReadonlyArray<RunEvent>) {
  const workerEvidenceEpochSequence =
    latestWorkerContinuationEpochSequence(events) ?? 0;
  return events.some(
    ({ sequence, type }) =>
      sequence > workerEvidenceEpochSequence &&
      (type === "DELIVERY_READY_TO_PUBLISH" ||
        type === "DELIVERY_PUBLICATION_INTENT_RECORDED" ||
        type === "DELIVERY_PUBLICATION_ATTEMPTED" ||
        type === "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN")
  );
}

export function reconcileInterruptedServerRuns(
  options: ServerWorkflowOptions = {}
) {
  return withRunStoreLock(
    options,
    reconcileInterruptedServerRunsUnlocked(options),
    {
      nextSafeAction:
        "Wait for local Gaia server startup reconciliation to finish, then retry.",
      operation: "Gaia server startup reconciliation",
    }
  ).pipe(Effect.mapError(toServerWorkflowError("ServerRunReconcileFailed")));
}

function reconcileInterruptedServerRunsUnlocked(
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);
    const exists = yield* fs.exists(store.runsRoot);
    if (!exists) {
      return {
        reconciledRunIds: [],
        resumableRunIds: [],
      } satisfies ServerRunReconciliation;
    }

    const entries = yield* fs.readDirectory(store.runsRoot);
    const reconciledRunIds: Array<RunId> = [];
    const resumableRunIds: Array<RunId> = [];

    for (const entry of entries.filter((item) => item.startsWith("run-"))) {
      const runId = parseRunIdSafely(entry);
      if (runId === undefined) {
        continue;
      }

      const paths = yield* makeRunPaths(runId, options);
      const loadedExit = yield* Effect.exit(loadRun(paths));
      if (loadedExit._tag === "Failure") {
        continue;
      }

      const firstEvent = loadedExit.value.events[0];
      if (
        firstEvent === undefined ||
        firstEvent.type !== "RUN_CREATED" ||
        firstEvent.payload["source"] !== "server"
      ) {
        continue;
      }

      const snapshot = snapshotFromReplay(loadedExit.value.events);
      if (hasStickyRunControlAmbiguity(loadedExit.value.events)) {
        continue;
      }
      if (snapshot.state === "waitingForHuman" || snapshot.state === "paused") {
        yield* reconcileRunControlExpiryWithinLease(runId, options);
        continue;
      }
      if (
        snapshot.state === "completed" ||
        snapshot.state === "failed" ||
        snapshot.state === "cancelled"
      ) {
        continue;
      }

      if (firstEvent.payload["workflow"] === "issueDelivery") {
        reconciledRunIds.push(runId);
        resumableRunIds.push(runId);
        continue;
      }

      yield* appendEvent(runId, paths, {
        payload: failurePayload(
          makeRuntimeError({
            code: "ServerExecutionInterrupted",
            message:
              "Server process stopped before completing the accepted run.",
            recoverable: true,
          }),
          failureStageFromRunState(snapshot.state)
        ),
        type: "RUN_FAILED",
      });
      reconciledRunIds.push(runId);
    }

    return {
      reconciledRunIds,
      resumableRunIds,
    } satisfies ServerRunReconciliation;
  });
}

function hasStickyRunControlAmbiguity(events: ReadonlyArray<RunEvent>) {
  const phases = new Map<string, RunEvent["type"]>();
  for (const event of events) {
    if (
      event.type !== "RUN_CONTROL_INTENT_RECORDED" &&
      event.type !== "RUN_CONTROL_ATTEMPTED" &&
      event.type !== "RUN_CONTROL_CONFIRMED" &&
      event.type !== "RUN_CONTROL_FAILED" &&
      event.type !== "RUN_CONTROL_OUTCOME_UNKNOWN"
    )
      continue;
    const control = parseRunControlEventPayload(event.payload["control"]);
    phases.set(control.actionId, event.type);
  }
  return [...phases.values()].some(
    (phase) =>
      phase === "RUN_CONTROL_ATTEMPTED" ||
      phase === "RUN_CONTROL_OUTCOME_UNKNOWN"
  );
}

function parseServerSpec(input: ServerRunSpecInput) {
  return Effect.try({
    try: () =>
      parseMarkdownSpec(input.specMarkdown, input.title ?? "server-run"),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidSpec",
        message: "Spec markdown could not be parsed.",
        recoverable: false,
      }),
  });
}

function failServerRunIfNeeded(
  runId: RunId,
  paths: RunPaths,
  stage: GaiaFailure["stage"],
  error: GaiaRuntimeError
) {
  return Effect.gen(function* () {
    const loadedExit = yield* Effect.exit(loadRun(paths));
    if (loadedExit._tag === "Success") {
      const snapshot = snapshotFromReplay(loadedExit.value.events);
      if (snapshot.state === "failed") {
        return yield* Effect.fail(error);
      }
    }

    yield* appendEvent(runId, paths, {
      payload: failurePayload(error, stage),
      type: "RUN_FAILED",
    });
    return yield* Effect.fail(error);
  });
}

function failurePayload(error: GaiaRuntimeError, stage: GaiaFailure["stage"]) {
  return {
    code: error.code,
    message: error.message,
    recoverable: error.recoverable,
    stage,
  };
}

function failureStageFromRunState(
  state: Exclude<RunState, "completed" | "failed">
): GaiaFailure["stage"] {
  switch (state) {
    case "created":
      return "creating";
    case "delivering":
    case "preparingWorkspace":
      return "preparingWorkspace";
    case "runningWorker":
    case "waitingForHuman":
    case "paused":
    case "cancelled":
      return "runningWorker";
    case "verifying":
      return "verifying";
    case "reporting":
      return "reporting";
  }
}

function parseRunIdSafely(input: string): RunId | undefined {
  try {
    return parseRunId(input);
  } catch {
    return undefined;
  }
}

const generateRunId = Effect.sync(() => parseRunId(`run-${nanoid()}`));

function toServerWorkflowError(code: string) {
  return (error: unknown) =>
    error instanceof GaiaRuntimeError
      ? error
      : makeRuntimeError({
          cause: error,
          code,
          message: "Gaia server workflow failed.",
          recoverable: true,
        });
}

function harnessAcceptanceError(error: unknown): GaiaRuntimeError {
  if (error instanceof HarnessEnvironmentAssignmentError) {
    return makeRuntimeError({
      code: "HarnessEnvironmentAssignmentUnavailable",
      message: "The production harness environment assignment is unavailable.",
      recoverable: false,
    });
  }
  if (error instanceof HarnessProfileNotFoundError) {
    return makeRuntimeError({
      code: "HarnessProfileNotFound",
      message: "The selected harness profile is not registered.",
      recoverable: false,
    });
  }
  if (error instanceof HarnessCapabilityMismatchError) {
    return makeRuntimeError({
      code: "HarnessCapabilityMismatch",
      message: "The selected harness provider lacks required capabilities.",
      recoverable: false,
    });
  }
  if (error instanceof HarnessIncompatibleError) {
    return makeRuntimeError({
      code: "HarnessIncompatible",
      message: "The selected harness provider version is incompatible.",
      recoverable: false,
    });
  }
  if (error instanceof HarnessUnavailableError) {
    return makeRuntimeError({
      code:
        error.state === "authenticationRequired"
          ? "HarnessAuthenticationRequired"
          : "HarnessUnavailable",
      message:
        error.state === "authenticationRequired"
          ? "The selected harness provider requires authentication."
          : "The selected harness provider is unavailable.",
      recoverable: true,
    });
  }
  if (error instanceof HarnessDetectionError) {
    return makeRuntimeError({
      code: "HarnessUnavailable",
      message: "The selected harness provider could not be detected.",
      recoverable: true,
    });
  }
  return makeRuntimeError({
    code: "HarnessUnavailable",
    message: "The selected harness provider could not be accepted.",
    recoverable: true,
  });
}

function acceptedDeliveryFeedbackTrustPolicy(
  provenance: DeliveryProvenance,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    if (options.deliveryFeedbackTrustPolicy !== undefined) {
      return yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(DeliveryFeedbackTrustPolicyV1)(
            options.deliveryFeedbackTrustPolicy
          ),
        catch: (cause) =>
          makeRuntimeError({
            cause,
            code: "DeliveryFeedbackTrustPolicyInvalid",
            message: "Accepted delivery feedback trust policy is invalid.",
            recoverable: false,
          }),
      });
    }
    const repository = yield* resolveDeliveryGitHubRepository(
      {
        rootDirectory: options.rootDirectory ?? ".",
        ...(options.deliveryGitCommandRunner === undefined
          ? {}
          : { commandRunner: options.deliveryGitCommandRunner }),
      },
      provenance.remote
    );
    return repository === undefined
      ? DeliveryFeedbackTrustPolicyV1.make({
          allowPullRequestAuthor: false,
          trustedChecks: [],
          trustedHumanLogins: [],
          version: 1,
        })
      : defaultDeliveryFeedbackTrustPolicy(repository);
  });
}

function factoryContinuationOptions(
  firstEvent: RunEvent,
  events: ReadonlyArray<RunEvent>,
  options: ServerWorkflowOptions,
  acceptedProvider?: ResolvedHarnessProvider
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const paths = yield* makeRunPaths(firstEvent.runId, options);
    const delivery = yield* parseAcceptedDelivery(
      firstEvent.payload["delivery"]
    );
    if (delivery.mode === "pullRequest") {
      yield* assertAcceptedDeliveryProvenancePolicy(
        delivery.provenance,
        options.deliveryAcceptanceProvenancePolicy
      );
      const feedbackTrustPolicy = yield* acceptedRunDeliveryFeedbackTrustPolicy(
        firstEvent,
        delivery.provenance,
        options
      );
      yield* prepareDeliveryWorktree({
        options: {
          rootDirectory,
          ...(options.deliveryGitCommandRunner === undefined
            ? {}
            : { commandRunner: options.deliveryGitCommandRunner }),
        },
        paths,
        provenance: delivery.provenance,
      });
      if (!events.some(({ type }) => type === "DELIVERY_STARTED")) {
        yield* appendEvent(firstEvent.runId, paths, {
          payload: {
            delivery: {
              ...delivery.provenance,
              feedbackTrustPolicy: Schema.encodeSync(
                DeliveryFeedbackTrustPolicyV1
              )(feedbackTrustPolicy),
              mode: "pullRequest",
              stage: "delivering",
            },
          },
          type: "DELIVERY_STARTED",
        });
      }
    }
    const execution = firstEvent.payload["execution"];
    const acceptedExecution = yield* Effect.try({
      try: () => ({
        resolved: decodeResolvedHarnessExecution(
          jsonObjectField(execution, "resolved")
        ),
        selection: decodeHarnessExecutionSelection(
          jsonObjectField(execution, "selection")
        ),
      }),
      catch: () =>
        makeRuntimeError({
          code: "HarnessExecutionSelectionUnreadable",
          message: "Accepted run harness execution is missing or corrupt.",
          recoverable: false,
        }),
    });
    if (
      acceptedExecution.selection.harnessProfileId !==
      acceptedExecution.resolved.harnessProfileId
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessExecutionSelectionMismatch",
          message:
            "Accepted run harness selection does not match its resolution.",
          recoverable: false,
        })
      );
    }
    const commonOptions = {
      ...options,
      ...(delivery.mode === "pullRequest"
        ? { deliveryProvenance: delivery.provenance }
        : {}),
      ...(delivery.mode === "local"
        ? {
            workspaceSource:
              options.workspaceSource ??
              localDirectoryWorkspaceSource(rootDirectory),
          }
        : {}),
    };
    const sessionEvents = issueDeliveryWorkerSessionEvents(
      firstEvent.runId,
      events
    );
    if (
      sessionEvents.some(
        (event) =>
          event.kind === "sessionStarted" &&
          event.provider.providerId !==
            acceptedExecution.resolved.provider.providerId
      )
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessSessionProviderMismatch",
          message:
            "Persisted harness session does not match the accepted provider.",
          recoverable: false,
        })
      );
    }
    const continuationState = issueDeliveryWorkerContinuationState(
      events,
      sessionEvents
    );
    if (continuationState === "invalid") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessWorkerCompletionMismatch",
          message:
            "Persisted worker completion has no canonical completed turn.",
          recoverable: false,
        })
      );
    }
    if (continuationState === "completed") {
      return {
        ...commonOptions,
        workerContinuationState: continuationState,
      };
    }
    if (
      continuationState === "terminal" &&
      acceptedExecution.resolved.environmentAssignment === undefined
    ) {
      return {
        ...commonOptions,
        workerContinuationState: continuationState,
        workerHarness: interactiveSessionHarness({
          rootDirectory,
          ...(options.sessionCoordinator === undefined
            ? {}
            : { sessionCoordinator: options.sessionCoordinator }),
        }),
      };
    }

    const registry = options.harnessProviderRegistry;
    if (acceptedProvider === undefined && registry === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessProviderRegistryMissing",
          message: "No harness provider registry is available for this run.",
          recoverable: true,
        })
      );
    }
    const resolved =
      acceptedProvider ??
      (yield* registry!
        .resolve(
          acceptedExecution.selection,
          issueDeliveryWorkerHarnessCapabilities
        )
        .pipe(Effect.mapError(harnessAcceptanceError)));
    if (
      JSON.stringify(encodeResolvedHarnessExecution(resolved.execution)) !==
      JSON.stringify(encodeResolvedHarnessExecution(acceptedExecution.resolved))
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessExecutionResolutionChanged",
          message: "Resolved harness execution changed after run acceptance.",
          recoverable: false,
        })
      );
    }
    const latestRunFailureSequence = [...events]
      .reverse()
      .find(({ type }) => type === "RUN_FAILED")?.sequence;
    const recovery = [...events].reverse().flatMap((event) => {
      if (event.type !== "WORKER_RECOVERY_RECORDED") return [];
      const receipt = parseWorkerRecoveryReceipt(event.payload["recovery"]);
      return receipt.state === "dispatchConfirmed" &&
        (latestRunFailureSequence === undefined ||
          receipt.expectedFailureSequence === latestRunFailureSequence)
        ? [receipt]
        : [];
    })[0];
    const latestCorrelation =
      latestWorkerCorrelationReconciliationReceipt(events);
    const expectedCheckpoint =
      latestCorrelation?.state === "followUpConfirmed" ||
      latestCorrelation?.state === "workerCompleted"
        ? yield* readPrivateWorkerCorrelationFollowUpCheckpoint(paths.root)
        : recovery === undefined
          ? undefined
          : yield* readPrivateWorkerRecoveryCheckpoint(
              paths.root,
              recovery.nativeTurnIdDigest,
              recovery
            );
    return {
      ...commonOptions,
      workerContinuationState:
        continuationState === "terminal" ? "resume" : continuationState,
      workerHarness: interactiveSessionHarness({
        ...(expectedCheckpoint === undefined ? {} : { expectedCheckpoint }),
        provider: resolved.provider,
        ...(resolved.launchObservation === undefined
          ? {}
          : { launchObservation: resolved.launchObservation }),
        rootDirectory,
        ...(options.sessionCoordinator === undefined
          ? {}
          : { sessionCoordinator: options.sessionCoordinator }),
      }),
    };
  });
}

function acceptedRunDeliveryFeedbackTrustPolicy(
  firstEvent: RunEvent,
  provenance: DeliveryProvenance,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    const persisted = firstEvent.payload["deliveryFeedbackTrustPolicy"];
    const { deliveryFeedbackTrustPolicy: _requestedPolicy, ...legacyOptions } =
      options;
    const accepted =
      persisted === undefined
        ? yield* acceptedDeliveryFeedbackTrustPolicy(provenance, legacyOptions)
        : yield* Effect.try({
            try: () =>
              Schema.decodeUnknownSync(DeliveryFeedbackTrustPolicyV1)(
                persisted
              ),
            catch: (cause) =>
              makeRuntimeError({
                cause,
                code: "DeliveryFeedbackTrustPolicyInvalid",
                message: "Accepted delivery feedback trust policy is invalid.",
                recoverable: false,
              }),
          });
    if (
      options.deliveryFeedbackTrustPolicy !== undefined &&
      canonicalDeliveryFeedbackTrustPolicy(
        options.deliveryFeedbackTrustPolicy
      ) !== canonicalDeliveryFeedbackTrustPolicy(accepted)
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryFeedbackTrustPolicyChanged",
          message:
            "Delivery feedback trust policy changed after run acceptance.",
          recoverable: false,
        })
      );
    }
    return accepted;
  });
}

function canonicalDeliveryFeedbackTrustPolicy(
  policy: DeliveryFeedbackTrustPolicyV1
) {
  return JSON.stringify({
    allowPullRequestAuthor: policy.allowPullRequestAuthor,
    requireApprovedReview: deliveryFeedbackRequiresApprovedReview(policy),
    trustedChecks: policy.trustedChecks,
    trustedHumanLogins: policy.trustedHumanLogins,
    version: policy.version,
  });
}

function acceptedDeliveryProvenance(
  runId: RunId,
  delivery: NonNullable<FactoryRunCreateInput["delivery"]>,
  options: ServerWorkflowOptions
) {
  return Effect.gen(function* () {
    if (delivery.mode === "local") {
      return { mode: "local" as const };
    }
    const rootDirectory = options.rootDirectory ?? ".";
    return yield* resolveDeliveryProvenance(
      runId,
      {
        rootDirectory,
        ...(options.deliveryGitCommandRunner === undefined
          ? {}
          : { commandRunner: options.deliveryGitCommandRunner }),
      },
      options.deliveryAcceptanceProvenancePolicy
    );
  });
}

function assertAcceptedDeliveryProvenancePolicy(
  provenance: DeliveryProvenance,
  requested: DeliveryAcceptanceProvenancePolicyV1 | undefined
) {
  if (requested === undefined) return Effect.void;
  return requested.remote === provenance.remote &&
    requested.baseBranch === provenance.baseBranch &&
    requested.headBranch === provenance.headBranch
    ? Effect.void
    : Effect.fail(
        makeRuntimeError({
          code: "DeliveryProvenancePolicyChanged",
          message: "Delivery provenance policy changed after run acceptance.",
          recoverable: false,
        })
      );
}

function parseAcceptedDelivery(value: Schema.Json | undefined) {
  return Effect.gen(function* () {
    if (value === undefined) return { mode: "local" } as const;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryPolicyInvalid",
          message: "Accepted delivery policy is invalid.",
          recoverable: false,
        })
      );
    }
    const delivery = value as Record<string, Schema.Json>;
    const mode = delivery["mode"];
    if (mode === "local") return { mode: "local" } as const;
    if (mode !== "pullRequest") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryPolicyInvalid",
          message: "Accepted delivery policy is invalid.",
          recoverable: false,
        })
      );
    }
    const provenance = parseDeliveryProvenance(delivery).pipe(
      Option.getOrUndefined
    );
    if (provenance === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryWorktreeIdentityMismatch",
          message:
            "Accepted pull-request delivery provenance is missing or invalid.",
          recoverable: false,
        })
      );
    }
    return { mode: "pullRequest", provenance } as const;
  });
}

/** Replay table: no session -> start, live session -> resume, first terminal -> own it. */
function issueDeliveryWorkerContinuationState(
  events: ReadonlyArray<RunEvent>,
  sessionEvents: ReadonlyArray<ReturnType<typeof parseHarnessEvent>>
): WorkerContinuationState | "invalid" {
  const recoverySequence = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "WORKER_RECOVERY_RECORDED" &&
        parseWorkerRecoveryReceipt(event.payload["recovery"]).state ===
          "dispatchConfirmed"
    )?.sequence;
  const continuationEpochSequence =
    latestWorkerContinuationEpochSequence(events);
  const evidenceEpochSequence = Math.max(
    recoverySequence ?? 0,
    continuationEpochSequence ?? 0
  );
  const relevantSessionEvents =
    evidenceEpochSequence === 0
      ? sessionEvents
      : events
          .filter(
            (event) =>
              event.sequence > evidenceEpochSequence &&
              event.type === "HARNESS_SESSION_EVENT_RECORDED"
          )
          .map((event) => parseHarnessEvent(event.payload.event));
  const workerCompletionPersisted = events.some(
    ({ sequence, type }) =>
      type === "WORKER_COMPLETED" && sequence > evidenceEpochSequence
  );
  const terminal = relevantSessionEvents.find(
    ({ kind }) => kind === "turnCompleted" || kind === "sessionFailed"
  );
  if (terminal === undefined) {
    if (workerCompletionPersisted) return "invalid";
    return recoverySequence !== undefined || relevantSessionEvents.length > 0
      ? "resume"
      : "start";
  }
  if (
    terminal.kind === "turnCompleted" &&
    terminal.status === "completed" &&
    workerCompletionPersisted
  ) {
    return "completed";
  }
  return "terminal";
}

function latestWorkerContinuationEpochSequence(
  events: ReadonlyArray<RunEvent>
) {
  return [...events].reverse().flatMap((event) => {
    if (event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED") {
      const desktopOriginCorrelation =
        parseWorkerDesktopOriginCorrelationReceipt(
          event.payload["desktopOriginCorrelation"]
        );
      return [desktopOriginCorrelation.workerEvidenceEpochSequence];
    }
    if (event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED") {
      const reconciliation = parseWorkerCorrelationReconciliationReceipt(
        event.payload["reconciliation"]
      );
      return [reconciliation.workerEvidenceEpochSequence];
    }
    if (event.type === "WORKER_CONTINUATION_RECORDED") {
      const continuation = parseWorkerContinuationReceipt(
        event.payload["continuation"]
      );
      return [continuation.workerEvidenceEpochSequence];
    }
    return [];
  })[0];
}

function issueDeliveryWorkerSessionEvents(
  runId: RunId,
  events: ReadonlyArray<RunEvent>
) {
  const sessionId = parseHarnessSessionId(`session-${runId}`);
  return events.flatMap((event) => {
    if (event.type !== "HARNESS_SESSION_EVENT_RECORDED") return [];
    const harnessEvent = parseHarnessEvent(event.payload.event);
    return harnessEvent.sessionId === sessionId ? [harnessEvent] : [];
  });
}

function jsonObjectField(
  value: Schema.Json | undefined,
  field: string
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}

function verificationActionRequestDigest(action: VerificationActionRequest) {
  return Schema.decodeUnknownSync(VerificationRequestDigestSchema)(
    createHash("sha256")
      .update(canonicalV1("gaia.verification-action-request.v1", [action]))
      .digest("hex")
  );
}

function verificationResponseDigest(input: unknown) {
  return Schema.decodeUnknownSync(VerificationRequestDigestSchema)(
    createHash("sha256")
      .update(canonicalV1("gaia.verification-action-response.v1", [input]))
      .digest("hex")
  );
}

function verificationContentAuthoritySequence(events: ReadonlyArray<RunEvent>) {
  const sequence = [...events]
    .reverse()
    .find(({ type }) =>
      [
        "WORKER_COMPLETED",
        "WORKER_CONTINUATION_RECORDED",
        "DELIVERY_REMEDIATION_RECORDED",
      ].includes(type)
    )?.sequence;
  if (sequence === undefined)
    throw new Error("Verification requires durable content authority.");
  return sequence;
}

function latestGenerationSequenceForAction(
  loaded: { readonly events: ReadonlyArray<RunEvent> },
  actionId: string
) {
  const event = [...loaded.events].reverse().find((candidate) => {
    if (candidate.type !== "CLAIM_VERIFICATION_GENERATION_STARTED")
      return false;
    const generation = Schema.decodeUnknownSync(
      ClaimVerificationGenerationStartedV1
    )(candidate.payload["generation"]);
    return generation.actionId === actionId;
  });
  if (event === undefined)
    throw new Error("Verification generation was not durably recorded.");
  return event.sequence;
}

function priorVerificationActionResult(
  runId: RunId,
  action: VerificationActionRequest,
  actionRequestDigest: typeof VerificationRequestDigestSchema.Type,
  contract: RunContractV2,
  events: ReadonlyArray<RunEvent>
):
  | { readonly kind: "new" }
  | { readonly kind: "conflict" }
  | { readonly kind: "incomplete" }
  | {
      readonly kind: "replay";
      readonly result: InstanceType<typeof VerificationActionIdempotentReplay>;
    } {
  const generationEvent = events.find((candidate) => {
    if (candidate.type !== "CLAIM_VERIFICATION_GENERATION_STARTED")
      return false;
    return (
      Schema.decodeUnknownSync(ClaimVerificationGenerationStartedV1)(
        candidate.payload["generation"]
      ).actionId === action.actionId
    );
  });
  const reconciliationEvent = events.find((candidate) => {
    if (candidate.type !== "CLAIM_VERIFICATION_RECONCILIATION_RECORDED")
      return false;
    return (
      parseVerificationReconciliationReceipt(
        candidate.payload["reconciliation"]
      ).actionId === action.actionId
    );
  });
  if (generationEvent === undefined && reconciliationEvent === undefined)
    return { kind: "new" };
  if (generationEvent !== undefined) {
    const generation = Schema.decodeUnknownSync(
      ClaimVerificationGenerationStartedV1
    )(generationEvent.payload["generation"]);
    if (
      generation.actionRequestDigest !== actionRequestDigest ||
      action.kind !== "startPostPublicationGeneration"
    )
      return { kind: "conflict" };
    const proofEvent = events.find(
      (candidate) =>
        candidate.type === "RUN_PROOF_RESULT_RECORDED" &&
        candidate.sequence > generationEvent.sequence &&
        jsonObjectField(candidate.payload["verificationAction"], "actionId") ===
          action.actionId
    );
    if (proofEvent === undefined) return { kind: "incomplete" };
    const proof = parseAnyRunProofResult(
      proofEvent.payload["result"],
      contract
    );
    if (proof.version !== 2) return { kind: "conflict" };
    const original = PostPublicationGenerationRecorded.make({
      actionId: action.actionId,
      actionRequestDigest,
      aggregate: proof.aggregate,
      currentContentAuthoritySequence: action.expectedContentAuthoritySequence,
      expectedContentAuthoritySequence: action.expectedContentAuthoritySequence,
      generationSequence: generationEvent.sequence,
      headSha: action.expectedHeadSha,
      kind: "postPublicationGenerationRecorded",
      proofResultDigest: proof.resultDigest,
      proofResultSequence: proof.recordedBy.sequence,
      publicationSequence: action.expectedPublicationSequence,
      replayed: false,
      runId,
      targetDigest: action.expectedTargetDigest,
    });
    return {
      kind: "replay",
      result: VerificationActionIdempotentReplay.make({
        actionId: action.actionId,
        actionRequestDigest,
        kind: "idempotentReplay",
        originalKind: original.kind,
        originalResponseDigest: verificationResponseDigest(original),
        originalResult: original,
        replayed: true,
        runId,
      }),
    };
  }
  const reconciliation = parseVerificationReconciliationReceipt(
    reconciliationEvent!.payload["reconciliation"]
  );
  if (
    action.kind !== "reconcileOutcomeUnknown" ||
    reconciliationEvent!.payload["actionRequestDigest"] !== actionRequestDigest
  )
    return { kind: "conflict" };
  const common = {
    actionId: action.actionId,
    actionRequestDigest,
    claimId: action.claimId,
    generationSequence: action.priorGenerationSequence,
    reconciliationReceipt: reconciliation,
    reconciliationSequence: reconciliationEvent!.sequence,
    replayed: false as const,
    runId,
  };
  const original =
    action.prior.kind === "createdWithoutCommandStart"
      ? CreatedWithoutCommandStartReconciled.make({
          ...common,
          kind: "createdWithoutCommandStartReconciled",
          sandboxCreatedSequence: action.prior.priorSandboxCreatedSequence,
        })
      : CommandStartOutcomeUnknownReconciled.make({
          ...common,
          commandStartSequence: action.prior.priorCommandStartSequence,
          kind: "commandStartOutcomeUnknownReconciled",
        });
  return {
    kind: "replay",
    result: VerificationActionIdempotentReplay.make({
      actionId: action.actionId,
      actionRequestDigest,
      kind: "idempotentReplay",
      originalKind: original.kind,
      originalResponseDigest: verificationResponseDigest(original),
      originalResult: original,
      replayed: true,
      runId,
    }),
  };
}

function exactVerificationReconciliationPrior(
  action: Extract<
    VerificationActionRequest,
    { readonly kind: "reconcileOutcomeUnknown" }
  >,
  contractDigest: string,
  events: ReadonlyArray<RunEvent>
) {
  const generationEvent = events.find(
    (event) => event.sequence === action.priorGenerationSequence
  );
  if (generationEvent?.type !== "CLAIM_VERIFICATION_GENERATION_STARTED")
    throw makeRuntimeError({
      code: "VerificationActionUnsupportedReconciliation",
      message: "Reconciliation generation identity is absent.",
      recoverable: false,
    });
  const generation = Schema.decodeUnknownSync(
    ClaimVerificationGenerationStartedV1
  )(generationEvent.payload["generation"]);
  if (
    generation.contractDigest !== contractDigest ||
    generation.executionEvidenceIdentityDigest !==
      action.expectedExecutionEvidenceIdentityDigest ||
    !generation.claimIds.some((claimId) => claimId === action.claimId)
  )
    throw makeRuntimeError({
      code: "VerificationActionUnsupportedReconciliation",
      message: "Reconciliation generation binding is stale or mismatched.",
      recoverable: false,
    });
  const sequence =
    action.prior.kind === "createdWithoutCommandStart"
      ? action.prior.priorSandboxCreatedSequence
      : action.prior.priorCommandStartSequence;
  const prior = events.find((event) => event.sequence === sequence);
  const identity =
    action.prior.kind === "createdWithoutCommandStart" &&
    prior?.type === "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED"
      ? Schema.decodeUnknownSync(ClaimVerificationSandboxCreatedV1)(
          prior.payload["sandboxCreated"]
        )
      : action.prior.kind === "commandStartOutcomeUnknown" &&
          prior?.type === "CLAIM_VERIFICATION_COMMAND_START_RECORDED"
        ? Schema.decodeUnknownSync(ClaimVerificationCommandStartV1)(
            prior.payload["commandStart"]
          )
        : undefined;
  if (
    identity === undefined ||
    identity.claimId !== action.claimId ||
    identity.sandboxName !== action.expectedSandboxName ||
    identity.sandboxUuid !== action.expectedSandboxUuid ||
    identity.executionEvidenceIdentityDigest !==
      action.expectedExecutionEvidenceIdentityDigest
  )
    throw makeRuntimeError({
      code: "VerificationActionUnsupportedReconciliation",
      message: "Reconciliation prior identity is not exact.",
      recoverable: false,
    });
  if (
    action.prior.kind === "createdWithoutCommandStart" &&
    events.some((event) => {
      if (event.type !== "CLAIM_VERIFICATION_COMMAND_START_RECORDED")
        return false;
      const start = Schema.decodeUnknownSync(ClaimVerificationCommandStartV1)(
        event.payload["commandStart"]
      );
      return (
        start.generationSequence === action.priorGenerationSequence &&
        start.claimId === action.claimId &&
        start.sandboxCreatedSequence === sequence
      );
    })
  )
    throw makeRuntimeError({
      code: "VerificationActionUnsupportedReconciliation",
      message:
        "Created-without-command-start reconciliation cannot replace an existing command start.",
      recoverable: false,
    });
  if (
    events.some(
      (event) =>
        event.type === "CLAIM_VERIFICATION_COMMAND_RECORDED" &&
        parseVerificationCommandReceipt(event.payload["receipt"])
          .commandStartSequence === sequence
    )
  )
    throw makeRuntimeError({
      code: "VerificationActionUnsupportedReconciliation",
      message: "Reconciliation cannot replace an existing terminal receipt.",
      recoverable: false,
    });
  if (
    events.some((event) => {
      if (event.type !== "CLAIM_VERIFICATION_RECONCILIATION_RECORDED")
        return false;
      const receipt = parseVerificationReconciliationReceipt(
        event.payload["reconciliation"]
      );
      return (
        receipt.generationSequence === action.priorGenerationSequence &&
        receipt.claimId === action.claimId
      );
    })
  )
    throw makeRuntimeError({
      code: "VerificationActionUnsupportedReconciliation",
      message: "Verification prior has already been reconciled.",
      recoverable: false,
    });
  return { sequence };
}

function verificationFailure(code: string, message: string) {
  return Effect.fail(makeRuntimeError({ code, message, recoverable: false }));
}
