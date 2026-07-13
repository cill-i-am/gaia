import { Schema, SchemaGetter } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";
import { EventTypeSchema, RunEvent, RunStateSchema } from "./events.js";
import {
  FactoryActivityListDto,
  FactoryAgentIdSchema,
  FactoryArtifactBodyDto,
  FactoryArtifactIdSchema,
  FactoryArtifactListDto,
  FactoryExternalRefDto,
  FactoryGraphDto,
  FactoryRunDetailDto,
  FactoryRunListDto,
  FactoryRunSummaryDto,
  FactoryWorkflowIdSchema,
} from "./factory-graph.js";
import { RunIdSchema } from "./run-id.js";
import { HarnessExecutionSelection } from "./harness-execution.js";
import {
  WorkerContinuationAction,
  WorkerContinuationReceiptSchema,
  WorkerCorrelationReconciliationAction,
  WorkerCorrelationReconciliationReceiptSchema,
  WorkerDesktopOriginCorrelationAction,
  WorkerDesktopOriginCorrelationReceiptSchema,
  WorkerRecoveryAction,
  WorkerRecoveryReceiptSchema,
} from "./worker-recovery.js";
import {
  AgentActionSuccessEnvelope,
  AgentOperatorActionRequestSchema,
  AgentSessionSnapshotSuccessEnvelope,
  AgentSessionSseEventSchema,
  AgentSessionUpdateDto,
} from "./agent-session-api.js";
import {
  DeliveryFeedbackIdSchema,
  DeliveryPullRequestObservation,
  DeliveryRemediationSchema,
} from "./delivery-remediation.js";
import { DeliveryActionIdSchema, DeliveryCleanupReceiptSchema, DeliveryLocalReviewAttestationReceiptSchema, DeliveryMergeMethodSchema, DeliveryMergeReadinessDecisionSchema, DeliveryMergeReceiptSchema, DeliveryPullRequestReadyReceiptSchema } from "./delivery-merge.js";

export const LocalRunReadDiagnosticCodeSchema = Schema.Literals([
  "ActiveRunConflict",
  "AgentActionConflict",
  "AgentSessionUnavailable",
  "AgentStreamCursorConflict",
  "DeliveryActionConflict",
  "DeliveryStreamCursorConflict",
  "ArtifactNotAllowed",
  "ArtifactNotFound",
  "EndpointNotFound",
  "FactoryAgentNotFound",
  "FactoryGraphNotFound",
  "HarnessAuthenticationRequired",
  "HarnessCapabilityMismatch",
  "HarnessIncompatible",
  "HarnessProfileNotFound",
  "HarnessUnavailable",
  "InvalidRunDirectory",
  "InvalidRunId",
  "InvalidRequest",
  "InvalidSpec",
  "InternalServerError",
  "MethodNotAllowed",
  "RunStoreLocked",
  "RunHasNoEvents",
  "RunNotFound",
  "RunUnreadable",
  "WorkerRecoveryCorrelationUnavailable",
  "WorkerRecoveryIntentPersistenceFailed",
  "WorkerRecoveryModelCatalogUnavailable",
  "WorkerRecoveryModelUnavailable",
] as const);

const BadRequestDiagnosticCodeSchema = Schema.Literals([
  "InvalidRequest",
  "InvalidRunId",
  "InvalidSpec",
] as const);
const NotFoundDiagnosticCodeSchema = Schema.Literals([
  "ArtifactNotAllowed",
  "ArtifactNotFound",
  "EndpointNotFound",
  "FactoryAgentNotFound",
  "FactoryGraphNotFound",
  "RunNotFound",
] as const);
const MethodNotAllowedDiagnosticCodeSchema = Schema.Literals([
  "MethodNotAllowed",
] as const);
const ConflictDiagnosticCodeSchema = Schema.Literals([
  "ActiveRunConflict",
  "AgentActionConflict",
  "AgentStreamCursorConflict",
  "DeliveryActionConflict",
  "DeliveryStreamCursorConflict",
  "RunStoreLocked",
] as const);
const UnprocessableDiagnosticCodeSchema = Schema.Literals([
  "HarnessAuthenticationRequired",
  "HarnessCapabilityMismatch",
  "HarnessIncompatible",
  "HarnessProfileNotFound",
  "HarnessUnavailable",
  "AgentSessionUnavailable",
  "InvalidRunDirectory",
  "RunHasNoEvents",
  "RunUnreadable",
  "WorkerRecoveryCorrelationUnavailable",
  "WorkerRecoveryModelCatalogUnavailable",
  "WorkerRecoveryModelUnavailable",
] as const);
const InternalServerDiagnosticCodeSchema = Schema.Literals([
  "InternalServerError",
  "WorkerRecoveryIntentPersistenceFailed",
] as const);

export const LocalRunApiErrorStatusSchema = Schema.Literals([
  400,
  404,
  405,
  409,
  422,
  500,
] as const);

const diagnosticFields = {
  artifactName: Schema.optionalKey(Schema.String),
  message: Schema.NonEmptyString,
  pathSegment: Schema.optionalKey(Schema.String),
  recoverable: Schema.Boolean,
  runId: Schema.optionalKey(RunIdSchema),
};

export const ServerHostSchema = Schema.Literal("127.0.0.1");

/** Legacy local run status retained for existing non-product dashboard consumers. */
export const LocalRunStatusSchema = Schema.Literals([
  "completed",
  "failed",
  "runningWorker",
  "workerRecoveryPending",
  "workerRecoveryDispatching",
  "workerRecoveryFailed",
  "workerRecoveryOutcomeUnknown",
  "running",
] as const);

/** Legacy artifact content types retained for existing non-product dashboard consumers. */
export const LocalRunArtifactContentTypeSchema = Schema.Literals([
  "application/json",
  "text/markdown",
  "text/plain",
] as const);

/** Legacy artifact identifiers retained for existing non-product dashboard consumers. */
export const LocalRunArtifactIdSchema = Schema.Literals([
  "input",
  "worker-plan",
  "reviewer-findings",
  "plan-review",
  "worker-log",
  "worker-result",
  "verification-result",
  "evidence-review",
  "evidence-promotion",
  "evidence-promotion-markdown",
  "factory-retro",
  "factory-retro-markdown",
  "factory-scorecard",
  "factory-scorecard-markdown",
  "report",
  "report-json",
  "events",
  "snapshots",
] as const).annotate({ identifier: "LocalRunArtifactId" });

export class LocalRunReadDiagnosticDto extends Schema.Class<LocalRunReadDiagnosticDto>(
  "LocalRunReadDiagnosticDto",
)({
  artifactName: Schema.optionalKey(Schema.String),
  code: LocalRunReadDiagnosticCodeSchema,
  message: Schema.NonEmptyString,
  pathSegment: Schema.optionalKey(Schema.String),
  recoverable: Schema.Boolean,
  runId: Schema.optionalKey(RunIdSchema),
}) {}

/** Legacy run summary retained until downstream dashboard/server slices migrate. */
export class LocalRunSummaryDto extends Schema.Class<LocalRunSummaryDto>(
  "LocalRunSummaryDto",
)({
  artifacts: Schema.Array(LocalRunArtifactIdSchema),
  createdAt: Schema.NonEmptyString,
  eventCount: Schema.Number.pipe(
    Schema.check(Schema.isInt({ identifier: "EventCount" })),
  ),
  latestEventType: EventTypeSchema,
  runId: RunIdSchema,
  state: RunStateSchema,
  status: LocalRunStatusSchema,
  updatedAt: Schema.NonEmptyString,
}) {}

/** Legacy run list retained until downstream dashboard/server slices migrate. */
export class LocalRunListDto extends Schema.Class<LocalRunListDto>(
  "LocalRunListDto",
)({
  diagnostics: Schema.Array(LocalRunReadDiagnosticDto),
  runs: Schema.Array(LocalRunSummaryDto),
}) {}

/** Legacy internal event read retained but excluded from product OpenAPI. */
export class LocalRunEventsDto extends Schema.Class<LocalRunEventsDto>(
  "LocalRunEventsDto",
)({
  events: Schema.Array(RunEvent),
  runId: RunIdSchema,
}) {}

/** Legacy artifact body retained until first-class artifact metadata is wired downstream. */
export class LocalRunArtifactDto extends Schema.Class<LocalRunArtifactDto>(
  "LocalRunArtifactDto",
)({
  artifactName: LocalRunArtifactIdSchema,
  body: Schema.String,
  contentType: LocalRunArtifactContentTypeSchema,
  runId: RunIdSchema,
}) {}

export class LocalRunListSuccessEnvelope extends Schema.Class<LocalRunListSuccessEnvelope>(
  "LocalRunListSuccessEnvelope",
)({
  data: LocalRunListDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunListPartialEnvelope extends Schema.Class<LocalRunListPartialEnvelope>(
  "LocalRunListPartialEnvelope",
)({
  data: LocalRunListDto,
  diagnostics: Schema.Array(LocalRunReadDiagnosticDto),
  status: Schema.Literal("partial"),
}) {}

export class LocalRunDetailSuccessEnvelope extends Schema.Class<LocalRunDetailSuccessEnvelope>(
  "LocalRunDetailSuccessEnvelope",
)({
  data: LocalRunSummaryDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryRunListSuccessEnvelope extends Schema.Class<FactoryRunListSuccessEnvelope>(
  "FactoryRunListSuccessEnvelope",
)({
  data: FactoryRunListDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryRunDetailSuccessEnvelope extends Schema.Class<FactoryRunDetailSuccessEnvelope>(
  "FactoryRunDetailSuccessEnvelope",
)({
  data: FactoryRunDetailDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryGraphSuccessEnvelope extends Schema.Class<FactoryGraphSuccessEnvelope>(
  "FactoryGraphSuccessEnvelope",
)({
  data: FactoryGraphDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryActivitySuccessEnvelope extends Schema.Class<FactoryActivitySuccessEnvelope>(
  "FactoryActivitySuccessEnvelope",
)({
  data: FactoryActivityListDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryArtifactListSuccessEnvelope extends Schema.Class<FactoryArtifactListSuccessEnvelope>(
  "FactoryArtifactListSuccessEnvelope",
)({
  data: FactoryArtifactListDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunArtifactSuccessEnvelope extends Schema.Class<LocalRunArtifactSuccessEnvelope>(
  "LocalRunArtifactSuccessEnvelope",
)({
  data: LocalRunArtifactDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryArtifactSuccessEnvelope extends Schema.Class<FactoryArtifactSuccessEnvelope>(
  "FactoryArtifactSuccessEnvelope",
)({
  data: FactoryArtifactBodyDto,
  status: Schema.Literal("success"),
}) {}

export const DeliveryModeSchema = Schema.Literals([
  "local",
  "pullRequest",
] as const);

export const DeliveryStatusSchema = Schema.Literals([
  "unavailable",
  "delivering",
  "readyToPublish",
  "publishing",
  "waitingForPr",
  "remediating",
  "remediationFailed",
  "remediationOutcomeUnknown",
  "awaitingMerge",
  "merging",
  "mergeReconciliationRequired",
  "cleanupRequired",
  "completed",
  "publicationFailed",
  "publicationOutcomeUnknown",
  "failed",
  "runningWorker",
  "workerRecoveryPending",
  "workerRecoveryDispatching",
  "workerRecoveryFailed",
  "workerRecoveryOutcomeUnknown",
  "workerContinuationPending",
  "workerContinuationRunning",
  "workerContinuationFailed",
  "workerContinuationOutcomeUnknown",
  "workerCorrelationPending",
  "workerCorrelationRunning",
  "workerCorrelationFailed",
  "workerCorrelationOutcomeUnknown",
] as const);

export const DeliveryRecoveryActionKindSchema = Schema.Literals([
  "reconcile",
  "retry",
] as const);
export const DeliveryPublicRecoveryActionKindSchema = Schema.Literals(["reconcile", "retry", "reconcileMerge", "retryCleanup", "retryWorkerRecovery"] as const);

const EventSequenceSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt({ identifier: "EventSequence" })),
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
);
const DeliveryActionDigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
);
const DeliveryActionGitShaSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
);
const DeliveryActionLoginSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u),
  ),
);
const DeliveryActionRepositorySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
  Schema.check(Schema.isMaxLength(200)),
);

export class DeliveryRecoveryActionRequest extends Schema.Class<DeliveryRecoveryActionRequest>(
  "DeliveryRecoveryActionRequest",
)({
  expectedEventSequence: EventSequenceSchema,
  kind: DeliveryRecoveryActionKindSchema,
}, { parseOptions: { onExcessProperty: "error" } }) {}

export const DeliveryRecoveryActionRequestSchema = DeliveryRecoveryActionRequest;

/** Exact operator-approved request for one controlled feedback activation. */
export class DeliveryRemediationActivationActionRequest extends Schema.Class<DeliveryRemediationActivationActionRequest>(
  "DeliveryRemediationActivationActionRequest",
)({
  actionIdempotencyKey: Schema.NonEmptyString.pipe(
    Schema.check(Schema.isPattern(/^[A-Za-z0-9:_-]+$/u)),
    Schema.check(Schema.isMaxLength(200)),
  ),
  actorLogin: DeliveryActionLoginSchema,
  actorType: Schema.Literal("User"),
  authorAssociation: Schema.Literals(["COLLABORATOR", "MEMBER", "OWNER"] as const),
  authorizationDigest: DeliveryActionDigestSchema,
  commentDatabaseId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[1-9]\d*$/u)),
    Schema.check(Schema.isMaxLength(30)),
  ),
  contentDigest: DeliveryActionDigestSchema,
  expectedEventSequence: EventSequenceSchema,
  feedbackId: DeliveryFeedbackIdSchema,
  headSha: DeliveryActionGitShaSchema,
  kind: Schema.Literal("activateRemediation"),
  marker: Schema.Literal("<!-- gaia-remediation-request:v1 -->"),
  prNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  repository: DeliveryActionRepositorySchema,
}, { parseOptions: { onExcessProperty: "error" } }) {}

export class DeliveryMergeActionRequest extends Schema.Class<DeliveryMergeActionRequest>(
  "DeliveryMergeActionRequest",
)({
  actionId: DeliveryActionIdSchema,
  expectedBranchName: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(240))),
  expectedDecisionSequence: EventSequenceSchema,
  expectedHeadSha: DeliveryActionGitShaSchema,
  expectedPolicyDigest: DeliveryActionDigestSchema,
  expectedPrUrl: Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*$/u))),
  kind: Schema.Literal("merge"),
  mergeMethod: DeliveryMergeMethodSchema,
}, { parseOptions: { onExcessProperty: "error" } }) {}

export class DeliveryMarkReadyForReviewActionRequest extends Schema.Class<DeliveryMarkReadyForReviewActionRequest>(
  "DeliveryMarkReadyForReviewActionRequest",
)({
  actionId: DeliveryActionIdSchema,
  expectedBranchName: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(240))),
  expectedHeadSha: DeliveryActionGitShaSchema,
  expectedPrNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  expectedPrUrl: Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*$/u))),
  kind: Schema.Literal("markReadyForReview"),
}, { parseOptions: { onExcessProperty: "error" } }) {}

export class DeliveryEvaluateMergeReadinessActionRequest extends Schema.Class<DeliveryEvaluateMergeReadinessActionRequest>("DeliveryEvaluateMergeReadinessActionRequest")({
  actionId: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
  kind: Schema.Literal("evaluateMergeReadiness"),
  mergeMethod: DeliveryMergeMethodSchema,
}, { parseOptions: { onExcessProperty: "error" } }) {}

export class DeliveryAttestPairedReviewActionRequest extends Schema.Class<DeliveryAttestPairedReviewActionRequest>(
  "DeliveryAttestPairedReviewActionRequest",
)({
  actionId: DeliveryActionIdSchema,
  decision: Schema.Literal("approved"),
  expectedBranchName: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(240))),
  expectedHeadSha: DeliveryActionGitShaSchema,
  expectedPrNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  expectedPrUrl: Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*$/u))),
  gaiaEvidenceDigest: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)))),
  kind: Schema.Literal("attestPairedReviewApproval"),
}, { parseOptions: { onExcessProperty: "error" } }) {}

export class DeliveryRetryCleanupActionRequest extends Schema.Class<DeliveryRetryCleanupActionRequest>(
  "DeliveryRetryCleanupActionRequest",
)({
  actionId: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
  expectedMergeCommitSha: DeliveryActionGitShaSchema,
  kind: Schema.Literal("retryCleanup"),
}, { parseOptions: { onExcessProperty: "error" } }) {}

export const DeliveryActionRequestSchema = Schema.Union([
  DeliveryRecoveryActionRequest,
  WorkerContinuationAction,
  WorkerCorrelationReconciliationAction,
  WorkerDesktopOriginCorrelationAction,
  DeliveryRemediationActivationActionRequest,
  DeliveryMarkReadyForReviewActionRequest,
  DeliveryAttestPairedReviewActionRequest,
  DeliveryEvaluateMergeReadinessActionRequest,
  DeliveryMergeActionRequest,
  DeliveryRetryCleanupActionRequest,
]);
export type DeliveryActionRequest = typeof DeliveryActionRequestSchema.Type;

const publicPublicationBase = {
  branchName: Schema.NonEmptyString.pipe(
    Schema.check(Schema.isMaxLength(240)),
    Schema.check(Schema.isPattern(/^gaia\/run-[A-Za-z0-9_-]{10}$/u)),
  ),
} as const;
const PublicGitShaSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
);
const PublicPullRequestUrlSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*$/u,
    ),
  ),
);

export class DeliveryPublicationIntentDto extends Schema.Class<DeliveryPublicationIntentDto>(
  "DeliveryPublicationIntentDto",
)({
  ...publicPublicationBase,
  state: Schema.Literal("intentRecorded"),
}, { parseOptions: { onExcessProperty: "error" } }) {}

export class DeliveryPublicationAttemptedDto extends Schema.Class<DeliveryPublicationAttemptedDto>(
  "DeliveryPublicationAttemptedDto",
)({
  ...publicPublicationBase,
  commitSha: PublicGitShaSchema,
  state: Schema.Literal("attempted"),
}, { parseOptions: { onExcessProperty: "error" } }) {}

export class DeliveryPublicationConfirmedDto extends Schema.Class<DeliveryPublicationConfirmedDto>(
  "DeliveryPublicationConfirmedDto",
)({
  ...publicPublicationBase,
  commitSha: PublicGitShaSchema,
  draft: Schema.Literal(true),
  prNumber: Schema.Int,
  prUrl: PublicPullRequestUrlSchema,
  state: Schema.Literal("confirmed"),
}, { parseOptions: { onExcessProperty: "error" } }) {}

export class DeliveryPublicationFailureDto extends Schema.Class<DeliveryPublicationFailureDto>(
  "DeliveryPublicationFailureDto",
)({
  ...publicPublicationBase,
  code: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(160))),
  commitSha: Schema.optionalKey(PublicGitShaSchema),
  message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1_024))),
  recoverable: Schema.Boolean,
  state: Schema.Literals(["failed", "outcomeUnknown"] as const),
  step: Schema.Literals([
    "validation",
    "commit",
    "push",
    "pullRequest",
    "reconciliation",
  ] as const),
}, { parseOptions: { onExcessProperty: "error" } }) {}

export const DeliveryPublicationDto = Schema.Union([
  DeliveryPublicationIntentDto,
  DeliveryPublicationAttemptedDto,
  DeliveryPublicationConfirmedDto,
  DeliveryPublicationFailureDto,
]).annotate({ identifier: "DeliveryPublicationDto" });

export type DeliveryPublicationDto = typeof DeliveryPublicationDto.Type;

export class DeliveryProvenanceDto extends Schema.Class<DeliveryProvenanceDto>(
  "DeliveryProvenanceDto",
)({
  baseBranch: Schema.NonEmptyString,
  baseRevision: Schema.NonEmptyString,
  headBranch: Schema.NonEmptyString,
  remote: Schema.NonEmptyString,
}) {}

export class DeliverySnapshotDto extends Schema.Class<DeliverySnapshotDto>(
  "DeliverySnapshotDto",
)({
  authoritativeHeadSha: Schema.optionalKey(PublicGitShaSchema),
  eventSequence: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "EventSequence" }))),
  mode: DeliveryModeSchema,
  provenance: Schema.optionalKey(DeliveryProvenanceDto),
  observation: Schema.optionalKey(DeliveryPullRequestObservation),
  publication: Schema.optionalKey(DeliveryPublicationDto),
  remediation: Schema.optionalKey(DeliveryRemediationSchema),
  activeMergeAction: Schema.optionalKey(DeliveryMergeReceiptSchema),
  latestMergeAction: Schema.optionalKey(DeliveryMergeReceiptSchema),
  activeReadyForReviewAction: Schema.optionalKey(DeliveryPullRequestReadyReceiptSchema),
  latestReadyForReviewAction: Schema.optionalKey(DeliveryPullRequestReadyReceiptSchema),
  activeLocalReviewAttestation: Schema.optionalKey(DeliveryLocalReviewAttestationReceiptSchema),
  latestLocalReviewAttestation: Schema.optionalKey(DeliveryLocalReviewAttestationReceiptSchema),
  mergeDecision: Schema.optionalKey(DeliveryMergeReadinessDecisionSchema),
  mergeDecisionSequence: Schema.optionalKey(EventSequenceSchema),
  activeCleanupAction: Schema.optionalKey(DeliveryCleanupReceiptSchema),
  latestCleanupAction: Schema.optionalKey(DeliveryCleanupReceiptSchema),
  actionAudit: Schema.optionalKey(Schema.Struct({
    cleanup: Schema.Array(Schema.Struct({ actionId: Schema.NonEmptyString, latestSequence: EventSequenceSchema, state: Schema.NonEmptyString })).pipe(Schema.check(Schema.isMaxLength(20))),
    localReviewAttestation: Schema.optionalKey(Schema.Array(Schema.Struct({ actionId: Schema.NonEmptyString, latestSequence: EventSequenceSchema, state: Schema.NonEmptyString })).pipe(Schema.check(Schema.isMaxLength(20)))),
    merge: Schema.Array(Schema.Struct({ actionId: Schema.NonEmptyString, latestSequence: EventSequenceSchema, state: Schema.NonEmptyString })).pipe(Schema.check(Schema.isMaxLength(20))),
    readyForReview: Schema.Array(Schema.Struct({ actionId: Schema.NonEmptyString, latestSequence: EventSequenceSchema, state: Schema.NonEmptyString })).pipe(Schema.check(Schema.isMaxLength(20))),
  })),
  remediationRearmSequence: Schema.optionalKey(
    Schema.Number.pipe(
      Schema.check(Schema.isInt({ identifier: "EventSequence" })),
      Schema.check(Schema.isGreaterThanOrEqualTo(1)),
    ),
  ),
  recoveryActions: Schema.Array(DeliveryPublicRecoveryActionKindSchema),
  runId: RunIdSchema,
  stage: DeliveryStatusSchema,
  status: DeliveryStatusSchema,
  workerContinuation: Schema.optionalKey(WorkerContinuationReceiptSchema),
  workerCorrelationReconciliation: Schema.optionalKey(WorkerCorrelationReconciliationReceiptSchema),
  workerDesktopOriginCorrelation: Schema.optionalKey(WorkerDesktopOriginCorrelationReceiptSchema),
  workerRecovery: Schema.optionalKey(WorkerRecoveryReceiptSchema),
}) {}

export class DeliverySnapshotSuccessEnvelope extends Schema.Class<DeliverySnapshotSuccessEnvelope>(
  "DeliverySnapshotSuccessEnvelope",
)({
  data: DeliverySnapshotDto,
  status: Schema.Literal("success"),
}) {}

export class WorkerRecoverySuccessEnvelope extends Schema.Class<WorkerRecoverySuccessEnvelope>("WorkerRecoverySuccessEnvelope")({
  data: WorkerRecoveryReceiptSchema,
  status: Schema.Literal("success"),
}) {}

export const DeliverySnapshotSseEventSchema = Schema.Struct({
  data: Schema.fromJsonString(DeliverySnapshotDto),
  event: Schema.Literal("delivery-update"),
  id: Schema.String,
});

export class LocalRunEventsSuccessEnvelope extends Schema.Class<LocalRunEventsSuccessEnvelope>(
  "LocalRunEventsSuccessEnvelope",
)({
  data: LocalRunEventsDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunApiErrorEnvelope extends Schema.Class<LocalRunApiErrorEnvelope>(
  "LocalRunApiErrorEnvelope",
)({
  ...diagnosticFields,
  code: LocalRunReadDiagnosticCodeSchema,
  status: LocalRunApiErrorStatusSchema,
}) {}

export class LocalRunApiBadRequest extends Schema.Class<LocalRunApiBadRequest>(
  "LocalRunApiBadRequest",
)({
  ...diagnosticFields,
  code: BadRequestDiagnosticCodeSchema,
  status: Schema.Literal(400),
}) {}

export class LocalRunApiNotFound extends Schema.Class<LocalRunApiNotFound>(
  "LocalRunApiNotFound",
)({
  ...diagnosticFields,
  code: NotFoundDiagnosticCodeSchema,
  status: Schema.Literal(404),
}) {}

export class LocalRunApiMethodNotAllowed extends Schema.Class<LocalRunApiMethodNotAllowed>(
  "LocalRunApiMethodNotAllowed",
)({
  ...diagnosticFields,
  code: MethodNotAllowedDiagnosticCodeSchema,
  status: Schema.Literal(405),
}) {}

export class LocalRunApiConflict extends Schema.Class<LocalRunApiConflict>(
  "LocalRunApiConflict",
)({
  ...diagnosticFields,
  code: ConflictDiagnosticCodeSchema,
  status: Schema.Literal(409),
}) {}

export class LocalRunApiUnprocessable extends Schema.Class<LocalRunApiUnprocessable>(
  "LocalRunApiUnprocessable",
)({
  ...diagnosticFields,
  code: UnprocessableDiagnosticCodeSchema,
  status: Schema.Literal(422),
}) {}

export class LocalRunApiInternalServerError extends Schema.Class<LocalRunApiInternalServerError>(
  "LocalRunApiInternalServerError",
)({
  ...diagnosticFields,
  code: InternalServerDiagnosticCodeSchema,
  status: Schema.Literal(500),
}) {}

export const LocalRunListResponse = Schema.Union([
  LocalRunListSuccessEnvelope,
  LocalRunListPartialEnvelope,
]);

export const LocalRunApiBadRequestResponse =
  LocalRunApiBadRequest.pipe(HttpApiSchema.status(400));
export const LocalRunApiNotFoundResponse =
  LocalRunApiNotFound.pipe(HttpApiSchema.status(404));
export const LocalRunApiMethodNotAllowedResponse =
  LocalRunApiMethodNotAllowed.pipe(HttpApiSchema.status(405));
export const LocalRunApiConflictResponse =
  LocalRunApiConflict.pipe(HttpApiSchema.status(409));
export const LocalRunApiUnprocessableResponse =
  LocalRunApiUnprocessable.pipe(HttpApiSchema.status(422));
export const LocalRunApiInternalServerErrorResponse =
  LocalRunApiInternalServerError.pipe(HttpApiSchema.status(500));

export const LocalRunReadErrorResponse = [
  LocalRunApiBadRequestResponse,
  LocalRunApiNotFoundResponse,
  LocalRunApiUnprocessableResponse,
  LocalRunApiInternalServerErrorResponse,
] as const;

export const LocalRunStreamErrorResponse = [
  LocalRunApiBadRequestResponse,
  LocalRunApiNotFoundResponse,
  LocalRunApiMethodNotAllowedResponse,
  LocalRunApiUnprocessableResponse,
  LocalRunApiInternalServerErrorResponse,
] as const;

export const LocalRunCreateErrorResponse = [
  LocalRunApiBadRequestResponse,
  LocalRunApiMethodNotAllowedResponse,
  LocalRunApiConflictResponse,
  LocalRunApiUnprocessableResponse,
  LocalRunApiInternalServerErrorResponse,
] as const;

export const LocalRunInternalErrorResponse = [
  LocalRunApiInternalServerErrorResponse,
] as const;

export class ServerMetadata extends Schema.Class<ServerMetadata>(
  "ServerMetadata",
)({
  gaiaRoot: Schema.NonEmptyString,
  host: ServerHostSchema,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Pid" }))),
  port: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Port" }))),
  serverId: Schema.NonEmptyString,
  startedAt: Schema.NonEmptyString,
  updatedAt: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  version: Schema.Literal(1),
  workspaceRoot: Schema.NonEmptyString,
}) {}

export class HealthResponse extends Schema.Class<HealthResponse>(
  "HealthResponse",
)({
  gaiaRoot: Schema.NonEmptyString,
  host: ServerHostSchema,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Pid" }))),
  port: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Port" }))),
  serverId: Schema.NonEmptyString,
  startedAt: Schema.NonEmptyString,
  status: Schema.Literal("ok"),
  updatedAt: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  version: Schema.Literal(1),
  workspaceRoot: Schema.NonEmptyString,
}) {}

/** Work item body for the fresh issue delivery run create command. */
export class CreateRunIssueWorkItemRequest extends Schema.Class<CreateRunIssueWorkItemRequest>(
  "CreateRunIssueWorkItemRequest",
)({
  description: Schema.NonEmptyString,
  externalRefs: Schema.optionalKey(Schema.Array(FactoryExternalRefDto)),
  kind: Schema.Literal("issue"),
  title: Schema.NonEmptyString,
}, {
  parseOptions: { onExcessProperty: "error" },
}) {}

export const CreateRunLocalDeliveryRequest = Schema.Struct({
  mode: Schema.Literal("local"),
}).pipe(
  Schema.decode({
    decode: SchemaGetter.transform(strictDeliveryRequestKeys),
    encode: SchemaGetter.transform(strictDeliveryRequestKeys),
  }),
);

export const CreateRunPullRequestDeliveryRequest = Schema.Struct({
  mode: Schema.Literal("pullRequest"),
}).pipe(
  Schema.decode({
    decode: SchemaGetter.transform(strictDeliveryRequestKeys),
    encode: SchemaGetter.transform(strictDeliveryRequestKeys),
  }),
);

export const CreateRunDeliveryRequest = Schema.Union([
  CreateRunLocalDeliveryRequest,
  CreateRunPullRequestDeliveryRequest,
]);

function strictDeliveryRequestKeys<T extends { readonly mode: "local" | "pullRequest" }>(
  value: T,
) {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "mode") {
    throw new Error("Delivery request only accepts a mode field.");
  }
  return value;
}

/** Fresh factory-run create body for the issueDelivery workflow. */
export class CreateRunRequest extends Schema.Class<CreateRunRequest>(
  "CreateRunRequest",
)({
  delivery: Schema.optionalKey(CreateRunDeliveryRequest),
  execution: HarnessExecutionSelection,
  workflow: FactoryWorkflowIdSchema,
  workItem: CreateRunIssueWorkItemRequest,
}, {
  parseOptions: { onExcessProperty: "error" },
}) {}

export class CreateRunAcceptedResponse extends Schema.Class<CreateRunAcceptedResponse>(
  "CreateRunAcceptedResponse",
)({
  acceptedAt: Schema.NonEmptyString,
  runId: RunIdSchema,
  status: Schema.Literal("accepted"),
  urls: Schema.Struct({
    activity: Schema.NonEmptyString,
    artifacts: Schema.NonEmptyString,
    factoryGraph: Schema.NonEmptyString,
    run: Schema.NonEmptyString,
  }),
}) {}

export const RunEventStreamResponse = HttpApiSchema.StreamSse({
  data: RunEvent,
  error: LocalRunApiErrorEnvelope,
});

export const AgentSessionStreamResponse = HttpApiSchema.StreamSse({
  events: AgentSessionSseEventSchema,
  error: LocalRunApiErrorEnvelope,
});

export const DeliverySnapshotStreamResponse = HttpApiSchema.StreamSse({
  events: DeliverySnapshotSseEventSchema,
  error: LocalRunApiErrorEnvelope,
});

export const HealthGroup = HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("health", "/health", {
    error: LocalRunInternalErrorResponse,
    success: HealthResponse,
  }),
);

export const RunsGroup = HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.get("listRuns", "/runs", {
      error: LocalRunInternalErrorResponse,
      success: FactoryRunListSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.post("createRun", "/runs", {
      error: LocalRunCreateErrorResponse,
      payload: [CreateRunRequest, HttpApiSchema.NoContent],
      success: CreateRunAcceptedResponse.pipe(HttpApiSchema.status(202)),
    }),
  )
  .add(
    HttpApiEndpoint.get("getRun", "/runs/:runId", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryRunDetailSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("getFactoryGraph", "/runs/:runId/factory-graph", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryGraphSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunEvents", "/runs/:runId/events", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: LocalRunEventsSuccessEnvelope,
    }).annotate(OpenApi.Exclude, true),
  )
  .add(
    HttpApiEndpoint.get("streamRunEvents", "/runs/:runId/events/stream", {
      error: LocalRunStreamErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: RunEventStreamResponse,
    }).annotate(OpenApi.Exclude, true),
  )
  .add(
    HttpApiEndpoint.get("getRunActivity", "/runs/:runId/activity", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryActivitySuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("getDeliverySnapshot", "/runs/:runId/delivery", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: DeliverySnapshotSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("streamDeliverySnapshot", "/runs/:runId/delivery/stream", {
      error: [...LocalRunStreamErrorResponse, LocalRunApiConflictResponse],
      params: {
        runId: RunIdSchema,
      },
      query: { afterSequence: Schema.optionalKey(Schema.NumberFromString) },
      success: DeliverySnapshotStreamResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("actOnDelivery", "/runs/:runId/delivery/actions", {
      error: [...LocalRunReadErrorResponse, LocalRunApiConflictResponse],
      params: { runId: RunIdSchema },
      payload: DeliveryActionRequestSchema,
      success: DeliverySnapshotSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.post("recoverWorker", "/runs/:runId/recovery/actions", {
      error: [...LocalRunReadErrorResponse, LocalRunApiConflictResponse],
      params: { runId: RunIdSchema },
      payload: WorkerRecoveryAction,
      success: WorkerRecoverySuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("getAgentActivity", "/runs/:runId/agents/:agentId/activity", {
      error: LocalRunReadErrorResponse,
      params: {
        agentId: FactoryAgentIdSchema,
        runId: RunIdSchema,
      },
      success: FactoryActivitySuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("getAgentSession", "/runs/:runId/agents/:agentId/session", {
      error: LocalRunReadErrorResponse,
      params: { agentId: FactoryAgentIdSchema, runId: RunIdSchema },
      success: AgentSessionSnapshotSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("streamAgentSession", "/runs/:runId/agents/:agentId/session/stream", {
      error: [...LocalRunStreamErrorResponse, LocalRunApiConflictResponse],
      params: { agentId: FactoryAgentIdSchema, runId: RunIdSchema },
      query: { afterSequence: Schema.optionalKey(Schema.NumberFromString) },
      success: AgentSessionStreamResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("actOnAgentSession", "/runs/:runId/agents/:agentId/session/actions", {
      error: [...LocalRunReadErrorResponse, LocalRunApiConflictResponse],
      params: { agentId: FactoryAgentIdSchema, runId: RunIdSchema },
      payload: AgentOperatorActionRequestSchema,
      success: AgentActionSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("listRunArtifacts", "/runs/:runId/artifacts", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryArtifactListSuccessEnvelope,
    }),
  )
  .add(
    HttpApiEndpoint.get("getRunArtifact", "/runs/:runId/artifacts/:artifactId", {
      error: LocalRunReadErrorResponse,
      params: {
        artifactId: FactoryArtifactIdSchema,
        runId: RunIdSchema,
      },
      success: FactoryArtifactSuccessEnvelope,
    }),
  );

export const LocalGaiaServerApi = HttpApi.make("LocalGaiaServerApi")
  .add(HealthGroup)
  .add(RunsGroup)
  .annotate(OpenApi.Title, "Local Gaia Server API")
  .annotate(OpenApi.Version, "0.1.0")
  .annotate(
    OpenApi.Description,
    "Local loopback Gaia server contract for workspace health and run reads.",
  );

export const LocalGaiaServerOpenApi = OpenApi.fromApi(LocalGaiaServerApi);

export type LocalRunApiError =
  | typeof LocalRunApiBadRequest.Type
  | typeof LocalRunApiNotFound.Type
  | typeof LocalRunApiMethodNotAllowed.Type
  | typeof LocalRunApiConflict.Type
  | typeof LocalRunApiUnprocessable.Type
  | typeof LocalRunApiInternalServerError.Type;
