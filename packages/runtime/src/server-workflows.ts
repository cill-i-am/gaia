import {
  DeliveryFeedbackTrustPolicyV1,
  deliveryFeedbackRequiresApprovedReview,
  type DeliveryMergeActionRequest,
  type DeliveryEvaluateMergeReadinessActionRequest,
  type DeliveryRetryCleanupActionRequest,
  type DeliveryRemediationActivationActionRequest,
  parseMarkdownSpec,
  HarnessExecutionSelection,
  parseHarnessEvent,
  parseHarnessSessionId,
  parseDeliveryPublication,
  parseRunId,
  encodeWorkerContinuationReceiptJson,
  parseWorkerContinuationAction,
  parseWorkerContinuationReceipt,
  parseWorkerRecoveryReceipt,
  ResolvedHarnessExecution,
  snapshotFromReplay,
  type WorkerContinuationAction,
  type WorkerContinuationReceipt,
  type GaiaFailure,
  type WorkerRecoveryAction,
  type WorkerRecoveryReceipt,
  type RunEvent,
  type RunId,
  type RunState,
} from "@gaia/core";
import { customAlphabet } from "nanoid";
import { Effect, FileSystem, Option, Path, Schema, type Duration } from "effect";
import { createHash } from "node:crypto";
import { appendEvent, loadRun } from "./event-store.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import {
  HarnessProfileNotFoundError,
  issueDeliveryWorkerHarnessCapabilities,
  type HarnessProviderRegistry,
} from "./harness-provider-registry.js";
import {
  HarnessCapabilityMismatchError,
  HarnessDetectionError,
  HarnessIncompatibleError,
  HarnessUnavailableError,
} from "./harness-session.js";
import {
  writeInitialFactoryRunIndexes,
  type FactoryRunCreateInput,
} from "./factory-run-store.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import type { ReviewerRunOptions } from "./reviewer.js";
import { withRunStoreLock } from "./run-store-lock.js";
import {
  continueAcceptedRun,
  type CommandSummary,
  type WorkerContinuationState,
} from "./workflows.js";
import { interactiveSessionHarness } from "./interactive-harness.js";
import type { LiveHarnessSessionCoordinator } from "./agent-session-runtime.js";
import { readPrivateWorkerRecoveryTurn } from "./worker-recovery.js";
import {
  localDirectoryWorkspaceSource,
  type WorkspaceSource,
} from "./workspace.js";
import {
  parseDeliveryProvenance,
  prepareDeliveryWorktree,
  resolveDeliveryGitHubRepository,
  resolveDeliveryProvenance,
  type DeliveryAcceptanceProvenancePolicyV1,
  type DeliveryProvenance,
  type GitDeliveryCommandRunner,
} from "./git-delivery.js";
import {
  publishReadyDeliveryRun,
  retryFailedDeliveryPublication,
} from "./delivery-publication.js";
import type { GitHubCommandRunner } from "./github-publisher.js";
import {
  continueDeliveryRemediation,
  defaultDeliveryFeedbackTrustPolicy,
  type DeliveryPullRequestReader,
} from "./delivery-remediation-coordinator.js";
import type { DeliveryFeedbackSmokeAuthorization } from "./github-pull-request-provider.js";
import {
  coordinateDeliveryCleanup,
  coordinateDeliveryMerge,
  coordinateDeliveryMergeReadiness,
  makeGitHubFreshMergeStateReader,
  requiredCheckPolicyFromTrustPolicy,
} from "./delivery-merge-coordinator.js";

const nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
  10,
);

export type ServerWorkflowOptions = RunStorageOptions & ReviewerRunOptions & {
  readonly deliveryAcceptanceProvenancePolicy?: DeliveryAcceptanceProvenancePolicyV1;
  readonly deliveryMergeActivator?: DeliveryMergeActionHandler;
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
  readonly workspaceSource?: WorkspaceSource;
  readonly workerRecoveryActivator?: (runId: string, action: WorkerRecoveryAction) => Effect.Effect<WorkerRecoveryReceipt, unknown, FileSystem.FileSystem | Path.Path>;
  readonly workerContinuationRunner?: (runId: string, options: ServerWorkflowOptions) => Effect.Effect<CommandSummary, unknown, FileSystem.FileSystem | Path.Path>;
};

export function actOnWorkerRecovery(runId: string, action: WorkerRecoveryAction, options: ServerWorkflowOptions) {
  return options.workerRecoveryActivator === undefined
    ? Effect.fail(makeRuntimeError({ code: "DeliveryActionFailed", message: "Worker recovery is unavailable.", recoverable: false }))
    : options.workerRecoveryActivator(runId, action);
}

export function actOnWorkerContinuation(
  runIdInput: string,
  actionInput: WorkerContinuationAction,
  options: ServerWorkflowOptions = {},
) {
  return withRunStoreLock(
    options,
    actOnWorkerContinuationUnlocked(runIdInput, actionInput, options),
    {
      nextSafeAction:
        "Refresh delivery state before retrying the audited worker continuation action.",
      operation: "Gaia audited worker continuation action",
    },
  ).pipe(Effect.mapError(toServerWorkflowError("DeliveryActionFailed")));
}

function actOnWorkerContinuationUnlocked(
  runIdInput: string,
  actionInput: WorkerContinuationAction,
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    const runId = yield* parseRunIdEffect(runIdInput);
    const action = parseWorkerContinuationAction(actionInput);
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);
    const prior = latestWorkerContinuationReceipt(loaded.events);
    const epochSequence = prior?.workerEvidenceEpochSequence ?? action.expectedCurrentSequence + 1;
    const base = {
      actionId: action.actionId,
      expectedContaminatedReadySequence: action.expectedContaminatedReadySequence,
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
      if (prior.state === "resumeAttempted" || prior.state === "followUpAttempted") {
        return yield* recordWorkerContinuationReceipt(runId, paths, {
          ...prior,
          code: "WorkerContinuationOutcomeUnknown",
          message: "A prior audited continuation attempt has no durable terminal receipt.",
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
      (options.workerContinuationRunner ?? continueServerRunWorkerOnly)(runId, options),
    );
    if (continued._tag === "Failure") {
      return yield* recordWorkerContinuationReceipt(runId, paths, {
        ...base,
        code: "WorkerContinuationFailed",
        message: "Audited worker continuation failed before fresh worker evidence completed.",
        state: "failed",
      });
    }
    const refreshed = yield* loadRun(paths);
    const hasFreshWorkerCompletion = refreshed.events.some(
      ({ sequence, type }) => type === "WORKER_COMPLETED" && sequence > epochSequence,
    );
    if (!hasFreshWorkerCompletion) {
      return yield* recordWorkerContinuationReceipt(runId, paths, {
        ...base,
        code: "WorkerContinuationNoFreshWorkerCompletion",
        message: "Audited worker continuation did not produce fresh worker evidence.",
        state: "failed",
      });
    }
    return yield* recordWorkerContinuationReceipt(runId, paths, {
      ...base,
      state: "workerCompleted",
    });
  });
}

export type DeliveryMergeActionHandler = (
  runId: string,
  action: DeliveryMergeActionRequest | DeliveryRetryCleanupActionRequest | DeliveryEvaluateMergeReadinessActionRequest,
  options: ServerWorkflowOptions,
) => Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>;

export function actOnDeliveryMerge(
  runIdInput: string,
  action: DeliveryMergeActionRequest | DeliveryRetryCleanupActionRequest | DeliveryEvaluateMergeReadinessActionRequest,
  options: ServerWorkflowOptions = {},
) {
  return Effect.gen(function* () {
    const runId = yield* parseRunIdEffect(runIdInput);
    const trustPolicy = options.deliveryFeedbackTrustPolicy ?? defaultDeliveryFeedbackTrustPolicy("unknown/unknown");
    const coordinatorOptions = {
      ...(options.deliveryPublicationCommandRunner === undefined ? {} : { commandRunner: options.deliveryPublicationCommandRunner }),
      ...(options.deliveryFeedbackTrustPolicy === undefined ? {} : { requiredCheckPolicy: requiredCheckPolicyFromTrustPolicy(trustPolicy) }),
      rootDirectory: options.rootDirectory ?? ".",
    };
    return action.kind === "merge"
      ? yield* coordinateDeliveryMerge(runId, action, coordinatorOptions)
      : action.kind === "evaluateMergeReadiness"
        ? yield* coordinateDeliveryMergeReadiness(runId, action, coordinatorOptions)
        : yield* coordinateDeliveryCleanup(runId, action, coordinatorOptions);
  });
}

export type DeliveryRemediationActionHandler = (
  runId: string,
  action: DeliveryRemediationActivationActionRequest,
  options: ServerWorkflowOptions,
) => Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path>;

const encodeResolvedHarnessExecution = Schema.encodeSync(
  ResolvedHarnessExecution,
);
const decodeHarnessExecutionSelection = Schema.decodeUnknownSync(
  HarnessExecutionSelection,
);
const decodeResolvedHarnessExecution = Schema.decodeUnknownSync(
  ResolvedHarnessExecution,
);

export type ServerRunAcceptance = {
  readonly acceptedAt: string;
  readonly eventSequence: number;
  readonly runDirectory: string;
  readonly runId: RunId;
};

export type ServerRunReconciliation = {
  readonly reconciledRunIds: ReadonlyArray<RunId>;
  readonly resumableRunIds: ReadonlyArray<RunId>;
};

export function acceptServerRun(
  input: {
    readonly specMarkdown: string;
    readonly title?: string | undefined;
  },
  options: ServerWorkflowOptions = {},
) {
  return withRunStoreLock(
    options,
    acceptServerRunUnlocked(input, options),
    {
      nextSafeAction:
        "Wait for the active Gaia server run acceptance to finish, then retry.",
      operation: "Gaia server run acceptance",
    },
  ).pipe(Effect.mapError(toServerWorkflowError("ServerRunAcceptFailed")));
}

export function acceptFactoryRun(
  input: FactoryRunCreateInput,
  options: ServerWorkflowOptions = {},
) {
  return withRunStoreLock(
    options,
    acceptFactoryRunUnlocked(input, options),
    {
      nextSafeAction:
        "Wait for the active Gaia factory run acceptance to finish, then retry.",
      operation: "Gaia factory run acceptance",
    },
  ).pipe(Effect.mapError(toServerWorkflowError("FactoryRunAcceptFailed")));
}

function acceptServerRunUnlocked(
  input: {
    readonly specMarkdown: string;
    readonly title?: string | undefined;
  },
  options: ServerWorkflowOptions,
): Effect.Effect<
  ServerRunAcceptance,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    yield* parseServerSpec(input);

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
        }),
      ),
    );
    yield* fs.writeFileString(paths.input, input.specMarkdown).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunAcceptFailed",
          message: "Gaia server could not persist the accepted run input.",
          recoverable: true,
        }),
      ),
    );
    yield* fs.writeFileString(paths.latest, runId).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunAcceptFailed",
          message: "Gaia server could not update the latest-run pointer.",
          recoverable: true,
        }),
      ),
    );
    const { event } = yield* appendEvent(runId, paths, {
      payload: { source: "server", specPath: "input.md" },
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
            }),
      ),
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
  options: ServerWorkflowOptions,
): Effect.Effect<
  ServerRunAcceptance,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    yield* parseServerSpec({
      specMarkdown: input.workItem.description,
      title: input.workItem.title,
    });

    const registry = options.harnessProviderRegistry;
    if (registry === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessProviderRegistryMissing",
          message: "No harness provider registry is available for this run.",
          recoverable: true,
        }),
      );
    }
    const resolved = yield* registry
      .resolve(
        input.execution,
        issueDeliveryWorkerHarnessCapabilities,
      )
      .pipe(Effect.mapError(harnessAcceptanceError));

    const runId = yield* generateRunId;
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;
    const delivery = yield* acceptedDeliveryProvenance(
      runId,
      input.delivery ?? { mode: "local" },
      options,
    );
    const deliveryFeedbackTrustPolicy = delivery.mode === "pullRequest"
      ? yield* acceptedDeliveryFeedbackTrustPolicy(delivery, options)
      : undefined;

    yield* fs.makeDirectory(paths.root, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunAcceptFailed",
          message: "Gaia server could not create the accepted factory run directory.",
          recoverable: true,
        }),
      ),
    );
    yield* fs.writeFileString(paths.input, input.workItem.description).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunAcceptFailed",
          message: "Gaia server could not persist the accepted factory run input.",
          recoverable: true,
        }),
      ),
    );
    yield* fs.writeFileString(paths.latest, runId).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunAcceptFailed",
          message: "Gaia server could not update the latest-run pointer.",
          recoverable: true,
        }),
      ),
    );
    const { event } = yield* appendEvent(runId, paths, {
      payload: {
        execution: {
          resolved: encodeResolvedHarnessExecution(resolved.execution),
          selection: {
            harnessProfileId: input.execution.harnessProfileId,
          },
        },
        delivery,
        ...(deliveryFeedbackTrustPolicy === undefined ? {} : {
          deliveryFeedbackTrustPolicy: Schema.encodeSync(DeliveryFeedbackTrustPolicyV1)(deliveryFeedbackTrustPolicy),
        }),
        source: "server",
        specPath: "input.md",
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
            }),
      ),
    );

    yield* writeInitialFactoryRunIndexes({
      paths,
      runId,
    }).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRunProjectionWriteFailed",
          message: "Gaia server could not write initial factory run projections.",
          recoverable: true,
        }),
      ),
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
  runIdInput: string,
  options: ServerWorkflowOptions = {},
): Effect.Effect<
  CommandSummary,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return withRunStoreLock(
    options,
    continueServerRunUnlocked(runIdInput, options),
    {
      nextSafeAction:
        "Wait for the active Gaia server run continuation to finish, then retry.",
      operation: "Gaia server run continuation",
    },
  ).pipe(Effect.mapError(toServerWorkflowError("ServerRunContinuationFailed")));
}

function continueServerRunUnlocked(
  runIdInput: string,
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    const runId = yield* parseRunIdEffect(runIdInput);
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunUnreadable",
          message: `Gaia server could not read accepted run ${runId}.`,
          recoverable: true,
        }),
      ),
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
        }),
      );
    }

    const snapshot = snapshotFromReplay(loaded.events);
    if (snapshot.state === "completed" || snapshot.state === "failed") {
      return {
        reportPath: snapshot.state === "completed" ? paths.reportMarkdown : undefined,
        runDirectory: paths.root,
        runId,
        state: snapshot.state,
        status: snapshot.state,
      } satisfies CommandSummary;
    }

    if (
      firstEvent.payload["workflow"] === "issueDelivery" &&
      isDeliveryPublicationReady(loaded.events)
    ) {
      return yield* continueDeliveryPublication(runId, paths, options);
    }

    const fs = yield* FileSystem.FileSystem;
    const specMarkdown = yield* fs.readFileString(paths.input).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunInputUnreadable",
          message: `Gaia server could not read accepted input for ${runId}.`,
          recoverable: true,
        }),
      ),
    );
    const spec = yield* parseServerSpec({
      specMarkdown,
      title: runId,
    });

    const summary = yield* Effect.gen(function* () {
      const continuationOptions =
        firstEvent.payload["workflow"] === "issueDelivery"
          ? yield* factoryContinuationOptions(firstEvent, loaded.events, options)
          : options;
      return yield* continueAcceptedRun(
        runId,
        paths,
        spec,
        continuationOptions,
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
            }),
      ),
      Effect.catchTag("GaiaRuntimeError", (error) =>
        failServerRunIfNeeded(runId, paths, "runningWorker", error),
      ),
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

function continueServerRunWorkerOnly(
  runIdInput: string,
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    const runId = yield* parseRunIdEffect(runIdInput);
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunUnreadable",
          message: `Gaia server could not read accepted run ${runId}.`,
          recoverable: true,
        }),
      ),
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
        }),
      );
    }
    if (firstEvent.payload["workflow"] !== "issueDelivery") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryActionConflict",
          message: "Audited worker continuation is only available for issue delivery runs.",
          recoverable: false,
        }),
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const specMarkdown = yield* fs.readFileString(paths.input).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "ServerRunInputUnreadable",
          message: `Gaia server could not read accepted input for ${runId}.`,
          recoverable: true,
        }),
      ),
    );
    const spec = yield* parseServerSpec({
      specMarkdown,
      title: runId,
    });

    return yield* Effect.gen(function* () {
      const continuationOptions = yield* factoryContinuationOptions(
        firstEvent,
        loaded.events,
        options,
      );
      return yield* continueAcceptedRun(
        runId,
        paths,
        spec,
        continuationOptions,
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
            }),
      ),
      Effect.catchTag("GaiaRuntimeError", (error) =>
        failServerRunIfNeeded(runId, paths, "runningWorker", error),
      ),
    );
  });
}

export function actOnDeliveryPublication(
  runIdInput: string,
  action: {
    readonly expectedEventSequence: number;
    readonly kind: "reconcile" | "retry";
  },
  options: ServerWorkflowOptions = {},
) {
  return withRunStoreLock(
    options,
    Effect.gen(function* () {
      const runId = yield* parseRunIdEffect(runIdInput);
      const paths = yield* makeRunPaths(runId, options);
      const loaded = yield* loadRun(paths);
      const lastSequence = loaded.events.at(-1)?.sequence ?? 0;
      if (lastSequence !== action.expectedEventSequence) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "DeliveryActionConflict",
            message: "Delivery state changed before the recovery action was accepted.",
            recoverable: true,
          }),
        );
      }
      const snapshot = snapshotFromReplay(loaded.events);
      const delivery = snapshot.context["delivery"];
      const publicationValue =
        delivery !== null && typeof delivery === "object" && !Array.isArray(delivery)
          ? Object.getOwnPropertyDescriptor(delivery, "publication")?.value
          : undefined;
      const publication =
        publicationValue === undefined
          ? undefined
          : parseDeliveryPublication(publicationValue);
      if (
        publication === undefined ||
        (action.kind === "reconcile" && publication.state !== "outcomeUnknown") ||
        (action.kind === "retry" &&
          (publication.state !== "failed" || !publication.recoverable))
      ) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "DeliveryActionConflict",
            message: "The requested recovery action is not valid for current delivery state.",
            recoverable: true,
          }),
        );
      }
      const publicationOptions = deliveryPublicationOptions(options);
      return action.kind === "reconcile"
        ? yield* (options.deliveryPublisher ?? publishReadyDeliveryRun)(
            runId,
            publicationOptions,
          )
        : yield* (options.deliveryRetryPublisher ?? retryFailedDeliveryPublication)(
            runId,
            publicationOptions,
          );
    }),
    {
      nextSafeAction: "Refresh delivery state before retrying the recovery action.",
      operation: "Gaia delivery recovery action",
    },
  ).pipe(Effect.mapError(toServerWorkflowError("DeliveryActionFailed")));
}

/** Activate one exact controlled comment through the existing delivery coordinator. */
export function actOnDeliveryRemediation(
  runIdInput: string,
  action: DeliveryRemediationActivationActionRequest,
  options: ServerWorkflowOptions = {},
) {
  return withRunStoreLock(
    options,
    Effect.gen(function* () {
      const runId = yield* parseRunIdEffect(runIdInput);
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
    },
  ).pipe(Effect.mapError(toServerWorkflowError("DeliveryActionFailed")));
}

function continueDeliveryPublication(
  runId: RunId,
  paths: RunPaths,
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    yield* (options.deliveryPublisher ?? publishReadyDeliveryRun)(
      runId,
      deliveryPublicationOptions(options),
    );
    if (options.deliveryObservationEnabled === true) {
      yield* continueDeliveryRemediationLoop(runId, options);
    }
    return {
      reportPath: paths.reportMarkdown,
      runDirectory: paths.root,
      runId,
      state: "delivering",
      status: "running",
    } satisfies CommandSummary;
  });
}

function latestWorkerContinuationReceipt(events: ReadonlyArray<RunEvent>) {
  return [...events].reverse().flatMap((event) => {
    if (event.type !== "WORKER_CONTINUATION_RECORDED") return [];
    return [parseWorkerContinuationReceipt(event.payload["continuation"])];
  })[0];
}

function recordWorkerContinuationReceipt(
  runId: RunId,
  paths: RunPaths,
  receipt: WorkerContinuationReceipt,
) {
  return appendEvent(runId, paths, {
    payload: { continuation: encodeWorkerContinuationReceiptJson(receipt) },
    type: "WORKER_CONTINUATION_RECORDED",
  }).pipe(Effect.as(receipt));
}

function assertWorkerContinuationReplay(
  prior: WorkerContinuationReceipt,
  expected: Omit<WorkerContinuationReceipt, "code" | "message" | "state">,
) {
  if (JSON.stringify(workerContinuationBinding(prior)) !== JSON.stringify(expected)) {
    return Effect.fail(makeRuntimeError({
      code: "DeliveryActionConflict",
      message: "Another audited worker continuation action is already authoritative.",
      recoverable: false,
    }));
  }
  return Effect.void;
}

function workerContinuationBinding(
  receipt: Omit<WorkerContinuationReceipt, "code" | "message" | "state">,
) {
  return {
    actionId: receipt.actionId,
    expectedContaminatedReadySequence: receipt.expectedContaminatedReadySequence,
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

function assertWorkerContinuationEligibility(
  events: ReadonlyArray<RunEvent>,
  action: WorkerContinuationAction,
) {
  return Effect.gen(function* () {
    const currentSequence = events.at(-1)?.sequence ?? 0;
    if (currentSequence !== action.expectedCurrentSequence) {
      return yield* Effect.fail(makeRuntimeError({
        code: "DeliveryActionConflict",
        message: "Delivery state changed before audited worker continuation was accepted.",
        recoverable: true,
      }));
    }
    if (action.expectedFailedRecoverySequence !== action.expectedCurrentSequence) {
      return yield* Effect.fail(
        workerContinuationConflict("Audited continuation requires the current failed recovery receipt."),
      );
    }
    const firstEvent = events[0];
    const delivery = firstEvent === undefined
      ? undefined
      : yield* parseAcceptedDelivery(firstEvent.payload["delivery"]);
    if (
      delivery?.mode !== "pullRequest" ||
      action.expectedDeliveryProvenanceDigest !==
        deliveryProvenanceDigest(delivery.provenance)
    ) {
      return yield* Effect.fail(
        workerContinuationConflict("Audited continuation requires the accepted delivery provenance."),
      );
    }
    const failedRecoveryEvent = events.find(
      (event) => event.sequence === action.expectedFailedRecoverySequence,
    );
    if (failedRecoveryEvent?.type !== "WORKER_RECOVERY_RECORDED") {
      return yield* Effect.fail(
        workerContinuationConflict("Audited continuation requires the exact failed recovery receipt."),
      );
    }
    const failedRecovery = parseWorkerRecoveryReceipt(failedRecoveryEvent.payload["recovery"]);
    if (
      failedRecovery.state !== "failed" ||
      failedRecovery.code !== "WorkerRecoveryContinuationFailed" ||
      failedRecovery.actionId !== action.expectedRecoveryActionId ||
      failedRecovery.expectedSessionId !== action.expectedSessionId ||
      failedRecovery.harnessProfileId !== action.harnessProfileId ||
      failedRecovery.nativeTurnIdDigest === undefined
    ) {
      return yield* Effect.fail(
        workerContinuationConflict("Audited continuation requires the exact failed interrupted recovery checkpoint."),
      );
    }
    const readyEvent = events.find(
      (event) => event.sequence === action.expectedContaminatedReadySequence,
    );
    if (readyEvent?.type !== "DELIVERY_READY_TO_PUBLISH") {
      return yield* Effect.fail(
        workerContinuationConflict("Audited continuation requires the contaminated ready boundary."),
      );
    }
    if (
      events.some(isDeliveryPublicationEvent) ||
      events.some(({ type }) =>
        type === "GITHUB_PR_LOOP_RECORDED" ||
        type === "GITHUB_CHECKS_RECORDED" ||
        type === "GITHUB_FEEDBACK_RECORDED"
      )
    ) {
      return yield* Effect.fail(
        workerContinuationConflict("Audited continuation is unavailable after publication or pull-request evidence exists."),
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
    .update([
      "gaia-worker-continuation-delivery-provenance-v1",
      provenance.baseBranch,
      provenance.baseRevision,
      provenance.headBranch,
      provenance.remote,
    ].join("\0"))
    .digest("hex");
}

function continueDeliveryRemediationLoop(
  runId: RunId,
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    const maxAttempts = Math.min(
      20,
      Math.max(1, options.deliveryObservationMaxAttempts ?? 6),
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
        remediation?.state === "failed" && !remediation.recoverable ||
        remediation?.attempt === 2 && remediation.state === "confirmed" ||
        result.observation.blockers.some(({ kind }) =>
          kind === "operatorReviewRequired" ||
          kind === "budgetExhausted" ||
          kind === "mergeConflict" ||
          kind === "expectedHeadChanged"
        )
      ) {
        return result;
      }
      if (attempt < maxAttempts) {
        yield* Effect.sleep(options.deliveryObservationPollInterval ?? "10 seconds");
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
  const workerEvidenceEpochSequence = latestWorkerContinuationEpochSequence(events) ?? 0;
  return events.some(
    ({ sequence, type }) =>
      sequence > workerEvidenceEpochSequence &&
      (type === "DELIVERY_READY_TO_PUBLISH" ||
      type === "DELIVERY_PUBLICATION_INTENT_RECORDED" ||
      type === "DELIVERY_PUBLICATION_ATTEMPTED" ||
      type === "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN"),
  );
}

export function reconcileInterruptedServerRuns(
  options: ServerWorkflowOptions = {},
) {
  return withRunStoreLock(
    options,
    reconcileInterruptedServerRunsUnlocked(options),
    {
      nextSafeAction:
        "Wait for local Gaia server startup reconciliation to finish, then retry.",
      operation: "Gaia server startup reconciliation",
    },
  ).pipe(Effect.mapError(toServerWorkflowError("ServerRunReconcileFailed")));
}

function reconcileInterruptedServerRunsUnlocked(
  options: ServerWorkflowOptions,
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
      if (snapshot.state === "completed" || snapshot.state === "failed") {
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
          failureStageFromRunState(snapshot.state),
        ),
        type: "RUN_FAILED",
      });
      reconciledRunIds.push(runId);
    }

    return { reconciledRunIds, resumableRunIds } satisfies ServerRunReconciliation;
  });
}

function parseServerSpec(input: {
  readonly specMarkdown: string;
  readonly title?: string | undefined;
}) {
  return Effect.try({
    try: () => parseMarkdownSpec(input.specMarkdown, input.title ?? "server-run"),
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
  error: GaiaRuntimeError,
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

function failurePayload(
  error: GaiaRuntimeError,
  stage: GaiaFailure["stage"],
) {
  return {
    code: error.code,
    message: error.message,
    recoverable: error.recoverable,
    stage,
  };
}

function failureStageFromRunState(
  state: Exclude<RunState, "completed" | "failed">,
): GaiaFailure["stage"] {
  switch (state) {
    case "created":
      return "creating";
    case "delivering":
    case "preparingWorkspace":
      return "preparingWorkspace";
    case "runningWorker":
      return "runningWorker";
    case "verifying":
      return "verifying";
    case "reporting":
      return "reporting";
  }
}

function parseRunIdEffect(input: string) {
  return Effect.try({
    try: () => parseRunId(input),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidRunId",
        message: `Invalid Gaia run id '${input}'.`,
        recoverable: false,
      }),
  });
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
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    if (options.deliveryFeedbackTrustPolicy !== undefined) {
      return yield* Effect.try({
        try: () => Schema.decodeUnknownSync(DeliveryFeedbackTrustPolicyV1)(
          options.deliveryFeedbackTrustPolicy,
        ),
        catch: (cause) => makeRuntimeError({
          cause,
          code: "DeliveryFeedbackTrustPolicyInvalid",
          message: "Accepted delivery feedback trust policy is invalid.",
          recoverable: false,
        }),
      });
    }
    const repository = yield* resolveDeliveryGitHubRepository({
      rootDirectory: options.rootDirectory ?? ".",
      ...(options.deliveryGitCommandRunner === undefined
        ? {}
        : { commandRunner: options.deliveryGitCommandRunner }),
    }, provenance.remote);
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
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const paths = yield* makeRunPaths(firstEvent.runId, options);
    const delivery = yield* parseAcceptedDelivery(firstEvent.payload["delivery"]);
    if (delivery.mode === "pullRequest") {
      yield* assertAcceptedDeliveryProvenancePolicy(delivery.provenance, options.deliveryAcceptanceProvenancePolicy);
      const feedbackTrustPolicy = yield* acceptedRunDeliveryFeedbackTrustPolicy(
        firstEvent,
        delivery.provenance,
        options,
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
                DeliveryFeedbackTrustPolicyV1,
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
          jsonObjectField(execution, "resolved"),
        ),
        selection: decodeHarnessExecutionSelection(
          jsonObjectField(execution, "selection"),
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
          message: "Accepted run harness selection does not match its resolution.",
          recoverable: false,
        }),
      );
    }
    const commonOptions = {
      ...options,
      ...(delivery.mode === "pullRequest"
        ? { deliveryProvenance: delivery.provenance }
        : {}),
      ...(delivery.mode === "local"
        ? { workspaceSource: options.workspaceSource ?? localDirectoryWorkspaceSource(rootDirectory) }
        : {}),
    };
    const sessionEvents = issueDeliveryWorkerSessionEvents(
      firstEvent.runId,
      events,
    );
    if (
      sessionEvents.some(
        (event) =>
          event.kind === "sessionStarted" &&
          event.provider.providerId !==
            acceptedExecution.resolved.provider.providerId,
      )
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessSessionProviderMismatch",
          message:
            "Persisted harness session does not match the accepted provider.",
          recoverable: false,
        }),
      );
    }
    const continuationState = issueDeliveryWorkerContinuationState(
      events,
      sessionEvents,
    );
    if (continuationState === "invalid") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessWorkerCompletionMismatch",
          message: "Persisted worker completion has no canonical completed turn.",
          recoverable: false,
        }),
      );
    }
    if (continuationState === "completed") {
      return {
        ...commonOptions,
        workerContinuationState: continuationState,
      };
    }
    if (continuationState === "terminal") {
      return {
        ...commonOptions,
        workerContinuationState: continuationState,
        workerHarness: interactiveSessionHarness({
          rootDirectory,
          ...(options.sessionCoordinator === undefined ? {} : { sessionCoordinator: options.sessionCoordinator }),
        }),
      };
    }

    const registry = options.harnessProviderRegistry;
    if (registry === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessProviderRegistryMissing",
          message: "No harness provider registry is available for this run.",
          recoverable: true,
        }),
      );
    }
    const resolved = yield* registry
      .resolve(
        acceptedExecution.selection,
        issueDeliveryWorkerHarnessCapabilities,
      )
      .pipe(Effect.mapError(harnessAcceptanceError));
    if (
      JSON.stringify(encodeResolvedHarnessExecution(resolved.execution)) !==
      JSON.stringify(encodeResolvedHarnessExecution(acceptedExecution.resolved))
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "HarnessExecutionResolutionChanged",
          message: "Resolved harness execution changed after run acceptance.",
          recoverable: false,
        }),
      );
    }
    const recovery = [...events].reverse().flatMap((event) => {
      if (event.type !== "WORKER_RECOVERY_RECORDED") return [];
      const receipt = parseWorkerRecoveryReceipt(event.payload["recovery"]);
      return receipt.state === "dispatchConfirmed" ? [receipt] : [];
    })[0];
    const expectedNativeTurnId = recovery === undefined
      ? undefined
      : yield* readPrivateWorkerRecoveryTurn(paths.root, recovery.nativeTurnIdDigest);
    return {
      ...commonOptions,
      workerContinuationState: continuationState,
      workerHarness: interactiveSessionHarness({
        ...(expectedNativeTurnId === undefined ? {} : { expectedNativeTurnId }),
        provider: resolved.provider,
        rootDirectory,
        ...(options.sessionCoordinator === undefined ? {} : { sessionCoordinator: options.sessionCoordinator }),
      }),
    };
  });
}

function acceptedRunDeliveryFeedbackTrustPolicy(
  firstEvent: RunEvent,
  provenance: DeliveryProvenance,
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    const persisted = firstEvent.payload["deliveryFeedbackTrustPolicy"];
    const { deliveryFeedbackTrustPolicy: _requestedPolicy, ...legacyOptions } = options;
    const accepted = persisted === undefined
      ? yield* acceptedDeliveryFeedbackTrustPolicy(provenance, legacyOptions)
      : yield* Effect.try({
          try: () => Schema.decodeUnknownSync(DeliveryFeedbackTrustPolicyV1)(persisted),
          catch: (cause) => makeRuntimeError({
            cause,
            code: "DeliveryFeedbackTrustPolicyInvalid",
            message: "Accepted delivery feedback trust policy is invalid.",
            recoverable: false,
          }),
        });
    if (
      options.deliveryFeedbackTrustPolicy !== undefined &&
      canonicalDeliveryFeedbackTrustPolicy(options.deliveryFeedbackTrustPolicy) !== canonicalDeliveryFeedbackTrustPolicy(accepted)
    ) {
      return yield* Effect.fail(makeRuntimeError({
        code: "DeliveryFeedbackTrustPolicyChanged",
        message: "Delivery feedback trust policy changed after run acceptance.",
        recoverable: false,
      }));
    }
    return accepted;
  });
}

function canonicalDeliveryFeedbackTrustPolicy(policy: DeliveryFeedbackTrustPolicyV1) {
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
  delivery: { readonly mode: "local" | "pullRequest" },
  options: ServerWorkflowOptions,
) {
  return Effect.gen(function* () {
    if (delivery.mode === "local") {
      return { mode: "local" as const };
    }
    const rootDirectory = options.rootDirectory ?? ".";
    return yield* resolveDeliveryProvenance(runId, {
      rootDirectory,
      ...(options.deliveryGitCommandRunner === undefined
        ? {}
        : { commandRunner: options.deliveryGitCommandRunner }),
    }, options.deliveryAcceptanceProvenancePolicy);
  });
}

function assertAcceptedDeliveryProvenancePolicy(
  provenance: DeliveryProvenance,
  requested: DeliveryAcceptanceProvenancePolicyV1 | undefined,
) {
  if (requested === undefined) return Effect.void;
  return requested.remote === provenance.remote && requested.baseBranch === provenance.baseBranch && requested.headBranch === provenance.headBranch
    ? Effect.void
    : Effect.fail(makeRuntimeError({
        code: "DeliveryProvenancePolicyChanged",
        message: "Delivery provenance policy changed after run acceptance.",
        recoverable: false,
      }));
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
        }),
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
        }),
      );
    }
    const provenance = parseDeliveryProvenance(delivery).pipe(Option.getOrUndefined);
    if (provenance === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryWorktreeIdentityMismatch",
          message: "Accepted pull-request delivery provenance is missing or invalid.",
          recoverable: false,
        }),
      );
    }
    return { mode: "pullRequest", provenance } as const;
  });
}

/** Replay table: no session -> start, live session -> resume, first terminal -> own it. */
function issueDeliveryWorkerContinuationState(
  events: ReadonlyArray<RunEvent>,
  sessionEvents: ReadonlyArray<ReturnType<typeof parseHarnessEvent>>,
): WorkerContinuationState | "invalid" {
  const recoverySequence = [...events].reverse().find((event) =>
    event.type === "WORKER_RECOVERY_RECORDED" &&
    parseWorkerRecoveryReceipt(event.payload["recovery"]).state === "dispatchConfirmed"
  )?.sequence;
  const continuationEpochSequence = latestWorkerContinuationEpochSequence(events);
  const evidenceEpochSequence = Math.max(
    recoverySequence ?? 0,
    continuationEpochSequence ?? 0,
  );
  const relevantSessionEvents = evidenceEpochSequence === 0
    ? sessionEvents
    : events.filter((event) => event.sequence > evidenceEpochSequence && event.type === "HARNESS_SESSION_EVENT_RECORDED").map((event) => parseHarnessEvent(event.payload.event));
  const workerCompletionPersisted = events.some(
    ({ sequence, type }) => type === "WORKER_COMPLETED" && sequence > evidenceEpochSequence,
  );
  const terminal = relevantSessionEvents.find(
    ({ kind }) => kind === "turnCompleted" || kind === "sessionFailed",
  );
  if (terminal === undefined) {
    if (workerCompletionPersisted) return "invalid";
    return recoverySequence !== undefined || relevantSessionEvents.length > 0 ? "resume" : "start";
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

function latestWorkerContinuationEpochSequence(events: ReadonlyArray<RunEvent>) {
  return [...events].reverse().flatMap((event) => {
    if (event.type !== "WORKER_CONTINUATION_RECORDED") return [];
    const continuation = parseWorkerContinuationReceipt(event.payload["continuation"]);
    return [continuation.workerEvidenceEpochSequence];
  })[0];
}

function issueDeliveryWorkerSessionEvents(
  runId: RunId,
  events: ReadonlyArray<RunEvent>,
) {
  const sessionId = parseHarnessSessionId(`session-${runId}`);
  return events.flatMap((event) => {
    if (event.type !== "HARNESS_SESSION_EVENT_RECORDED") return [];
    const harnessEvent = parseHarnessEvent(event.payload.event);
    return harnessEvent.sessionId === sessionId ? [harnessEvent] : [];
  });
}

function jsonObjectField(value: Schema.Json | undefined, field: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}
