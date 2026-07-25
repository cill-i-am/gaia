import { Schema, SchemaGetter } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";

import {
  AgentActionSuccessEnvelope,
  AgentOperatorActionRequestSchema,
  AgentSessionCursorSchema,
  AgentSessionSnapshotSuccessEnvelope,
  AgentSessionSseEventSchema,
  AgentSessionUpdateDto,
} from "./agent-session-api.js";
import {
  DeliveryActionIdPublicSchema,
  DeliveryBranchNamePublicSchema,
  DeliveryGitShaPublicSchema,
  DeliveryOwnedBranchNamePublicSchema,
  DeliveryPositiveIntegerSchema,
  DeliveryRemoteNamePublicSchema,
  DeliverySha256DigestPublicSchema,
  DeliveryTimestampPublicSchema,
  GitHubDatabaseIdPublicSchema,
  GitHubLoginPublicSchema,
  GitHubPullRequestUrlPublicSchema,
  GitHubRepositoryPublicSchema,
} from "./delivery-identity.js";
import {
  DeliveryCleanupReceiptSchema,
  DeliveryLocalReviewAttestationReceiptSchema,
  DeliveryMergeMethodSchema,
  DeliveryMergeReadinessDecisionSchema,
  DeliveryMergeReceiptSchema,
  DeliveryPullRequestReadyReceiptSchema,
} from "./delivery-merge.js";
import {
  DeliveryFeedbackIdSchema,
  DeliveryPullRequestObservation,
  DeliveryRemediationSchema,
} from "./delivery-remediation.js";
import { EventTypeSchema, RunEvent, RunStateSchema } from "./events.js";
import {
  FactoryActivityListDto,
  FactoryAgentIdSchema,
  FactoryArtifactAvailabilitySchema,
  FactoryArtifactBodyDto,
  FactoryArtifactIdSchema,
  FactoryArtifactListDto,
  FactoryExternalRefDto,
  FactoryGraphDto,
  FactoryRunDetailDto,
  FactoryRunListDto,
  FactoryRunSummaryDto,
  FactoryWorkflowIdSchema,
  ModelManifestArtifactDiagnosticDto,
  ModelManifestArtifactDiagnosticCodeSchema,
} from "./factory-graph.js";
import {
  HarnessExecutionSelection,
  WorkerEnvironmentEpochComparisonDto,
} from "./harness-execution.js";
import { LocalGaiaServerUrlSchema } from "./local-gaia-server-url.js";
import {
  ModelInvocationEpisodeRoleSchema,
  ModelManifestArtifactIdSchema,
} from "./model-invocation.js";
import {
  RunEventSequenceSchema,
  RunProofResultDigestSchema,
  RunVerificationAggregateSchema,
  StructuralDigestSchema,
} from "./run-contract.js";
import {
  RunControlActionSchema,
  RunControlReceipt,
  RunControlSnapshot,
} from "./run-control.js";
import { RunIdSchema } from "./run-id.js";
import {
  VerificationIdentityDigestSchema,
  VerificationReconciliationReceiptV1,
  VerificationRequestDigestSchema,
  VerificationSandboxNameSchema,
  VerificationSandboxUuidSchema,
} from "./verification-command.js";
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

export const LocalRunReadDiagnosticCodeSchema = Schema.Literals([
  ...ModelManifestArtifactDiagnosticCodeSchema.literals,
  "ArtifactNotAllowed",
  "ArtifactNotFound",
  "FactoryAgentNotFound",
  "FactoryGraphNotFound",
  "InvalidRunDirectory",
  "InvalidRunId",
  "RunHasNoEvents",
  "RunNotFound",
  "RunUnreadable",
] as const);

export type LocalRunReadDiagnosticCode =
  typeof LocalRunReadDiagnosticCodeSchema.Type;

const LocalRunApiAdditionalDiagnosticCodeSchema = Schema.Literals([
  "ActiveRunConflict",
  "AgentActionConflict",
  "AgentSessionUnavailable",
  "AgentStreamCursorConflict",
  "DeliveryActionConflict",
  "DeliveryStreamCursorConflict",
  "EndpointNotFound",
  "HarnessAuthenticationRequired",
  "HarnessCapabilityMismatch",
  "HarnessIncompatible",
  "HarnessProfileNotFound",
  "HarnessUnavailable",
  "InvalidRequest",
  "InvalidSpec",
  "InternalServerError",
  "MethodNotAllowed",
  "RunStoreLocked",
  "RunControlChangedDigest",
  "RunControlExpired",
  "RunControlOutcomeUnknown",
  "RunControlResolutionAlreadyClaimed",
  "RunControlResolutionReplayNotComparable",
  "RunControlStale",
  "RunControlTerminal",
  "RunControlUnsupportedProviderOperation",
  "RunControlWrongAuthority",
  "WorkerRecoveryCorrelationUnavailable",
  "WorkerRecoveryIntentPersistenceFailed",
  "WorkerRecoveryModelCatalogUnavailable",
  "WorkerRecoveryModelUnavailable",
  "VerificationActionInvalidRequest",
  "VerificationActionIdempotencyConflict",
  "VerificationActionStaleAuthority",
  "VerificationCreatedWithoutCommandStart",
  "VerificationActionUnsupportedPhase",
  "VerificationActionUnsupportedReconciliation",
  "VerificationProviderFailure",
  "VerificationPersistenceFailure",
] as const);

export const LocalRunApiDiagnosticCodeSchema = Schema.Literals([
  ...LocalRunReadDiagnosticCodeSchema.literals,
  ...LocalRunApiAdditionalDiagnosticCodeSchema.literals,
] as const);

const BadRequestDiagnosticCodeSchema = Schema.Literals([
  "InvalidRequest",
  "InvalidRunId",
  "InvalidSpec",
  "VerificationActionInvalidRequest",
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
  "RunControlChangedDigest",
  "RunControlExpired",
  "RunControlOutcomeUnknown",
  "RunControlResolutionAlreadyClaimed",
  "RunControlResolutionReplayNotComparable",
  "RunControlStale",
  "RunControlTerminal",
  "VerificationActionIdempotencyConflict",
  "VerificationActionStaleAuthority",
  "VerificationCreatedWithoutCommandStart",
] as const);
const UnprocessableDiagnosticCodeSchema = Schema.Literals([
  ...ModelManifestArtifactDiagnosticCodeSchema.literals,
  "HarnessAuthenticationRequired",
  "HarnessCapabilityMismatch",
  "HarnessIncompatible",
  "HarnessProfileNotFound",
  "HarnessUnavailable",
  "AgentSessionUnavailable",
  "InvalidRunDirectory",
  "RunHasNoEvents",
  "RunUnreadable",
  "RunControlUnsupportedProviderOperation",
  "WorkerRecoveryCorrelationUnavailable",
  "WorkerRecoveryModelCatalogUnavailable",
  "WorkerRecoveryModelUnavailable",
  "VerificationActionUnsupportedPhase",
  "VerificationActionUnsupportedReconciliation",
  "VerificationProviderFailure",
] as const);
const InternalServerDiagnosticCodeSchema = Schema.Literals([
  "InternalServerError",
  "WorkerRecoveryIntentPersistenceFailed",
  "VerificationPersistenceFailure",
] as const);
const ForbiddenDiagnosticCodeSchema = Schema.Literals([
  "RunControlWrongAuthority",
] as const);

export const LocalRunApiErrorStatusSchema = Schema.Literals([
  400, 403, 404, 405, 409, 422, 500,
] as const);

const diagnosticFields = {
  artifactName: Schema.optionalKey(Schema.String),
  message: Schema.NonEmptyString,
  pathSegment: Schema.optionalKey(Schema.String),
  recoverable: Schema.Boolean,
  runId: Schema.optionalKey(RunIdSchema),
};

export const ServerHostSchema = Schema.Literal("127.0.0.1");

export const LocalRunReadStatusSchema = Schema.Literals([
  "cancelled",
  "completed",
  "failed",
  "running",
] as const);

export type LocalRunStatus = typeof LocalRunReadStatusSchema.Type;

/** Legacy local run status retained for existing non-product dashboard consumers. */
const LocalRunAdditionalStatusSchema = Schema.Literals([
  "runningWorker",
  "workerRecoveryPending",
  "workerRecoveryDispatching",
  "workerRecoveryFailed",
  "workerRecoveryOutcomeUnknown",
] as const);

export const LocalRunStatusSchema = Schema.Literals([
  ...LocalRunReadStatusSchema.literals,
  ...LocalRunAdditionalStatusSchema.literals,
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
  "run-contract",
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

export const LocalRunReadArtifactIdSchema = LocalRunArtifactIdSchema.pipe(
  Schema.brand("LocalRunArtifactId")
);

export type LocalRunArtifactId = typeof LocalRunReadArtifactIdSchema.Type;

export const parseLocalRunArtifactId = Schema.decodeUnknownSync(
  LocalRunReadArtifactIdSchema
);

export const localRunArtifactIds = Object.freeze(
  LocalRunArtifactIdSchema.literals.map((artifactId) =>
    parseLocalRunArtifactId(artifactId)
  )
);

export const LocalRunArtifactNameSchema = Schema.String.pipe(
  Schema.brand("LocalRunArtifactName")
);

export type LocalRunArtifactName = typeof LocalRunArtifactNameSchema.Type;

export const parseLocalRunArtifactName = Schema.decodeUnknownSync(
  LocalRunArtifactNameSchema
);

const localRunTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const LocalRunTimestampSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (timestamp) => {
        if (!localRunTimestampPattern.test(timestamp)) {
          return false;
        }

        const parsed = new Date(timestamp);
        return (
          !Number.isNaN(parsed.getTime()) && parsed.toISOString() === timestamp
        );
      },
      {
        identifier: "LocalRunTimestamp",
        message:
          "Local run timestamps must be UTC ISO strings with milliseconds.",
      }
    )
  ),
  Schema.brand("LocalRunTimestamp")
);

export type LocalRunTimestamp = typeof LocalRunTimestampSchema.Type;

export const parseLocalRunTimestamp = Schema.decodeUnknownSync(
  LocalRunTimestampSchema
);

const isSafeLocalRunPathSegment = Schema.makeFilter(
  (pathSegment: string) =>
    pathSegment !== "." &&
    pathSegment !== ".." &&
    !pathSegment.includes("/") &&
    !pathSegment.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(pathSegment),
  {
    identifier: "LocalRunPathSegment",
    message: "Local run path segments must be safe single directory names.",
  }
);

export const LocalRunPathSegmentSchema = Schema.NonEmptyString.pipe(
  Schema.check(isSafeLocalRunPathSegment),
  Schema.brand("LocalRunPathSegment")
);

export type LocalRunPathSegment = typeof LocalRunPathSegmentSchema.Type;

export const parseLocalRunPathSegment = Schema.decodeUnknownSync(
  LocalRunPathSegmentSchema
);

export class LocalRunReadDiagnosticDto extends Schema.Class<LocalRunReadDiagnosticDto>(
  "LocalRunReadDiagnosticDto"
)({
  artifactName: Schema.optionalKey(Schema.String),
  code: LocalRunReadDiagnosticCodeSchema,
  message: Schema.NonEmptyString,
  pathSegment: Schema.optionalKey(Schema.String),
  recoverable: Schema.Boolean,
  runId: Schema.optionalKey(RunIdSchema),
}) {}

export const LocalRunReadDiagnosticSchema = Schema.Struct({
  ...LocalRunReadDiagnosticDto.fields,
  artifactName: Schema.optionalKey(LocalRunArtifactNameSchema),
  pathSegment: Schema.optionalKey(LocalRunPathSegmentSchema),
}).annotate({ identifier: "LocalRunReadDiagnostic" });

export type LocalRunReadDiagnostic = typeof LocalRunReadDiagnosticSchema.Type;

export const parseLocalRunReadDiagnostic = Schema.decodeUnknownSync(
  LocalRunReadDiagnosticSchema
);

const ModelManifestEpisodeIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^episode1_[a-f0-9]{64}$/u))
);

export class LocalRunModelManifestArtifactDto extends Schema.Class<LocalRunModelManifestArtifactDto>(
  "LocalRunModelManifestArtifactDto"
)(
  {
    artifactId: ModelManifestArtifactIdSchema,
    availability: FactoryArtifactAvailabilitySchema,
    bodyDigest: DeliverySha256DigestPublicSchema,
    byteLength: Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 131_072 })
      )
    ),
    contentType: Schema.Literal("application/json"),
    diagnostic: Schema.optionalKey(ModelManifestArtifactDiagnosticDto),
    episodeId: ModelManifestEpisodeIdSchema,
    episodeRole: ModelInvocationEpisodeRoleSchema,
    identityDigest: DeliverySha256DigestPublicSchema,
    manifestId: Schema.NonEmptyString,
    manifestKind: Schema.Literals([
      "modelContextManifest",
      "modelInvocationManifest",
    ] as const),
    version: Schema.Literal(1),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export const LocalRunModelManifestArtifactSchema =
  LocalRunModelManifestArtifactDto.pipe(
    Schema.check(
      Schema.makeFilter(
        (artifact) =>
          artifact.availability === "available"
            ? artifact.diagnostic === undefined
            : artifact.diagnostic !== undefined,
        {
          expected:
            "available manifests without diagnostics or unavailable manifests with diagnostics",
        }
      )
    )
  );

export class LocalRunApiDiagnosticDto extends Schema.Class<LocalRunApiDiagnosticDto>(
  "LocalRunApiDiagnosticDto"
)({
  ...diagnosticFields,
  code: LocalRunApiDiagnosticCodeSchema,
}) {}

export type LocalRunApiDiagnostic = typeof LocalRunApiDiagnosticDto.Type;

export const parseLocalRunApiDiagnostic = Schema.decodeUnknownSync(
  LocalRunApiDiagnosticDto
);

/** Legacy run summary retained until downstream dashboard/server slices migrate. */
export class LocalRunSummaryDto extends Schema.Class<LocalRunSummaryDto>(
  "LocalRunSummaryDto"
)({
  artifacts: Schema.Array(LocalRunArtifactIdSchema),
  createdAt: LocalRunTimestampSchema,
  eventCount: Schema.Number.pipe(
    Schema.check(Schema.isInt({ identifier: "EventCount" }))
  ),
  latestEventType: EventTypeSchema,
  modelInvocationArtifacts: Schema.Array(LocalRunModelManifestArtifactSchema),
  proofAggregate: Schema.optionalKey(RunVerificationAggregateSchema),
  runId: RunIdSchema,
  state: RunStateSchema,
  status: LocalRunStatusSchema,
  updatedAt: LocalRunTimestampSchema,
  workerEnvironmentEpoch: Schema.optionalKey(
    WorkerEnvironmentEpochComparisonDto
  ),
}) {}

export class LocalRunReadSummary extends Schema.Class<LocalRunReadSummary>(
  "LocalRunReadSummary"
)({
  ...LocalRunSummaryDto.fields,
  artifacts: Schema.Array(LocalRunReadArtifactIdSchema),
  createdAt: LocalRunTimestampSchema,
  status: LocalRunReadStatusSchema,
  updatedAt: LocalRunTimestampSchema,
}) {}

const LegacyLocalRunReadSummaryEncodedIngress = Schema.Struct({
  ...LocalRunReadSummary.fields,
  modelInvocationArtifacts: Schema.optionalKey(
    Schema.Array(LocalRunModelManifestArtifactSchema)
  ),
});

/** Legacy wire-only ingress; decoded/domain summary Types remain required. */
export const LegacyLocalRunReadSummaryIngress =
  LegacyLocalRunReadSummaryEncodedIngress.pipe(
    Schema.decodeTo(LocalRunReadSummary, {
      decode: SchemaGetter.transform((value) =>
        Schema.encodeSync(LocalRunReadSummary)(
          LocalRunReadSummary.make({
            ...value,
            modelInvocationArtifacts: value.modelInvocationArtifacts ?? [],
          })
        )
      ),
      encode: SchemaGetter.transform((value) =>
        Schema.decodeUnknownSync(LegacyLocalRunReadSummaryEncodedIngress)(value)
      ),
    })
  );

export const LocalRunReadSummarySchema = LocalRunReadSummary;

export type LocalRunSummary = LocalRunReadSummary;
export type LocalRunDetail = LocalRunSummary;

export const parseLocalRunSummary = Schema.decodeUnknownSync(
  LocalRunReadSummarySchema
);

/** Legacy run list retained until downstream dashboard/server slices migrate. */
export class LocalRunListDto extends Schema.Class<LocalRunListDto>(
  "LocalRunListDto"
)({
  diagnostics: Schema.Array(LocalRunReadDiagnosticDto),
  runs: Schema.Array(LocalRunSummaryDto),
}) {}

export class LocalRunReadList extends Schema.Class<LocalRunReadList>(
  "LocalRunReadList"
)({
  ...LocalRunListDto.fields,
  diagnostics: Schema.Array(LocalRunReadDiagnosticSchema),
  runs: Schema.Array(LocalRunReadSummarySchema),
}) {}

export const LocalRunReadListSchema = LocalRunReadList;

export type LocalRunList = LocalRunReadList;

export const parseLocalRunList = Schema.decodeUnknownSync(
  LocalRunReadListSchema
);

/** Legacy internal event read retained but excluded from product OpenAPI. */
export class LocalRunEventsDto extends Schema.Class<LocalRunEventsDto>(
  "LocalRunEventsDto"
)({
  events: Schema.Array(RunEvent),
  runId: RunIdSchema,
}) {}

export type LocalRunEvents = LocalRunEventsDto;

export const parseLocalRunEvents = Schema.decodeUnknownSync(LocalRunEventsDto);

/** Legacy artifact body retained until first-class artifact metadata is wired downstream. */
export class LocalRunArtifactDto extends Schema.Class<LocalRunArtifactDto>(
  "LocalRunArtifactDto"
)({
  artifactName: LocalRunArtifactIdSchema,
  body: Schema.String,
  contentType: LocalRunArtifactContentTypeSchema,
  runId: RunIdSchema,
}) {}

export class LocalRunModelManifestArtifactBodyDto extends Schema.Class<LocalRunModelManifestArtifactBodyDto>(
  "LocalRunModelManifestArtifactBodyDto"
)({
  artifactName: ModelManifestArtifactIdSchema,
  body: Schema.String,
  contentType: Schema.Literal("application/json"),
  runId: RunIdSchema,
}) {}

export const LocalRunReadArtifactSchema = Schema.Union([
  Schema.Struct({
    ...LocalRunArtifactDto.fields,
    artifactName: LocalRunReadArtifactIdSchema,
  }),
  LocalRunModelManifestArtifactBodyDto,
]).annotate({ identifier: "LocalRunReadArtifact" });

export type LocalRunArtifact = typeof LocalRunReadArtifactSchema.Type;
export type LocalRunArtifactContentType =
  typeof LocalRunArtifactContentTypeSchema.Type;

export const parseLocalRunArtifact = Schema.decodeUnknownSync(
  LocalRunReadArtifactSchema
);

export class LocalRunListSuccessEnvelope extends Schema.Class<LocalRunListSuccessEnvelope>(
  "LocalRunListSuccessEnvelope"
)({
  data: LocalRunListDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunListPartialEnvelope extends Schema.Class<LocalRunListPartialEnvelope>(
  "LocalRunListPartialEnvelope"
)({
  data: LocalRunListDto,
  diagnostics: Schema.Array(LocalRunReadDiagnosticDto),
  status: Schema.Literal("partial"),
}) {}

export class LocalRunDetailSuccessEnvelope extends Schema.Class<LocalRunDetailSuccessEnvelope>(
  "LocalRunDetailSuccessEnvelope"
)({
  data: LocalRunReadSummarySchema,
  status: Schema.Literal("success"),
}) {}

export class FactoryRunListSuccessEnvelope extends Schema.Class<FactoryRunListSuccessEnvelope>(
  "FactoryRunListSuccessEnvelope"
)({
  data: FactoryRunListDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryRunDetailSuccessEnvelope extends Schema.Class<FactoryRunDetailSuccessEnvelope>(
  "FactoryRunDetailSuccessEnvelope"
)({
  data: FactoryRunDetailDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryGraphSuccessEnvelope extends Schema.Class<FactoryGraphSuccessEnvelope>(
  "FactoryGraphSuccessEnvelope"
)({
  data: FactoryGraphDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryActivitySuccessEnvelope extends Schema.Class<FactoryActivitySuccessEnvelope>(
  "FactoryActivitySuccessEnvelope"
)({
  data: FactoryActivityListDto,
  status: Schema.Literal("success"),
}) {}

export class FactoryArtifactListSuccessEnvelope extends Schema.Class<FactoryArtifactListSuccessEnvelope>(
  "FactoryArtifactListSuccessEnvelope"
)({
  data: FactoryArtifactListDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunArtifactSuccessEnvelope extends Schema.Class<LocalRunArtifactSuccessEnvelope>(
  "LocalRunArtifactSuccessEnvelope"
)({
  data: LocalRunReadArtifactSchema,
  status: Schema.Literal("success"),
}) {}

export class FactoryArtifactSuccessEnvelope extends Schema.Class<FactoryArtifactSuccessEnvelope>(
  "FactoryArtifactSuccessEnvelope"
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
export const DeliveryPublicRecoveryActionKindSchema = Schema.Literals([
  "reconcile",
  "retry",
  "reconcileMerge",
  "retryCleanup",
  "retryWorkerRecovery",
] as const);

const EventSequenceSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt({ identifier: "EventSequence" })),
  Schema.check(Schema.isGreaterThanOrEqualTo(1))
);
const DeliveryActionDigestSchema = DeliverySha256DigestPublicSchema;
const DeliveryActionGitShaSchema = DeliveryGitShaPublicSchema;
const DeliveryActionLoginSchema = GitHubLoginPublicSchema;
const DeliveryActionRepositorySchema = GitHubRepositoryPublicSchema;

export class DeliveryRecoveryActionRequest extends Schema.Class<DeliveryRecoveryActionRequest>(
  "DeliveryRecoveryActionRequest"
)(
  {
    expectedEventSequence: EventSequenceSchema,
    kind: DeliveryRecoveryActionKindSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export const DeliveryRecoveryActionRequestSchema =
  DeliveryRecoveryActionRequest;

/** Exact operator-approved request for one controlled feedback activation. */
export class DeliveryRemediationActivationActionRequest extends Schema.Class<DeliveryRemediationActivationActionRequest>(
  "DeliveryRemediationActivationActionRequest"
)(
  {
    actionIdempotencyKey: DeliveryActionIdPublicSchema,
    actorLogin: DeliveryActionLoginSchema,
    actorType: Schema.Literal("User"),
    authorAssociation: Schema.Literals([
      "COLLABORATOR",
      "MEMBER",
      "OWNER",
    ] as const),
    authorizationDigest: DeliveryActionDigestSchema,
    commentDatabaseId: GitHubDatabaseIdPublicSchema,
    contentDigest: DeliveryActionDigestSchema,
    expectedEventSequence: EventSequenceSchema,
    feedbackId: DeliveryFeedbackIdSchema,
    headSha: DeliveryActionGitShaSchema,
    kind: Schema.Literal("activateRemediation"),
    marker: Schema.Literal("<!-- gaia-remediation-request:v1 -->"),
    prNumber: DeliveryPositiveIntegerSchema,
    repository: DeliveryActionRepositorySchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class DeliveryMergeActionRequest extends Schema.Class<DeliveryMergeActionRequest>(
  "DeliveryMergeActionRequest"
)(
  {
    actionId: DeliveryActionIdPublicSchema,
    expectedBranchName: DeliveryBranchNamePublicSchema,
    expectedDecisionSequence: EventSequenceSchema,
    expectedHeadSha: DeliveryActionGitShaSchema,
    expectedPolicyDigest: DeliveryActionDigestSchema,
    expectedPrUrl: GitHubPullRequestUrlPublicSchema,
    kind: Schema.Literal("merge"),
    mergeMethod: DeliveryMergeMethodSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class DeliveryMarkReadyForReviewActionRequest extends Schema.Class<DeliveryMarkReadyForReviewActionRequest>(
  "DeliveryMarkReadyForReviewActionRequest"
)(
  {
    actionId: DeliveryActionIdPublicSchema,
    expectedBranchName: DeliveryBranchNamePublicSchema,
    expectedHeadSha: DeliveryActionGitShaSchema,
    expectedPrNumber: DeliveryPositiveIntegerSchema,
    expectedPrUrl: GitHubPullRequestUrlPublicSchema,
    kind: Schema.Literal("markReadyForReview"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class DeliveryEvaluateMergeReadinessActionRequest extends Schema.Class<DeliveryEvaluateMergeReadinessActionRequest>(
  "DeliveryEvaluateMergeReadinessActionRequest"
)(
  {
    actionId: DeliveryActionIdPublicSchema,
    kind: Schema.Literal("evaluateMergeReadiness"),
    mergeMethod: DeliveryMergeMethodSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class DeliveryAttestPairedReviewActionRequest extends Schema.Class<DeliveryAttestPairedReviewActionRequest>(
  "DeliveryAttestPairedReviewActionRequest"
)(
  {
    actionId: DeliveryActionIdPublicSchema,
    decision: Schema.Literal("approved"),
    expectedBranchName: DeliveryBranchNamePublicSchema,
    expectedHeadSha: DeliveryActionGitShaSchema,
    expectedPrNumber: DeliveryPositiveIntegerSchema,
    expectedPrUrl: GitHubPullRequestUrlPublicSchema,
    gaiaEvidenceDigest: Schema.optionalKey(DeliverySha256DigestPublicSchema),
    kind: Schema.Literal("attestPairedReviewApproval"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class DeliveryRetryCleanupActionRequest extends Schema.Class<DeliveryRetryCleanupActionRequest>(
  "DeliveryRetryCleanupActionRequest"
)(
  {
    actionId: DeliveryActionIdPublicSchema,
    expectedMergeCommitSha: DeliveryActionGitShaSchema,
    kind: Schema.Literal("retryCleanup"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

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
export type DeliveryActionRequest =
  | DeliveryRecoveryActionRequest
  | WorkerContinuationAction
  | WorkerCorrelationReconciliationAction
  | WorkerDesktopOriginCorrelationAction
  | DeliveryRemediationActivationActionRequest
  | DeliveryMarkReadyForReviewActionRequest
  | DeliveryAttestPairedReviewActionRequest
  | DeliveryEvaluateMergeReadinessActionRequest
  | DeliveryMergeActionRequest
  | DeliveryRetryCleanupActionRequest;

const publicPublicationBase = {
  branchName: DeliveryOwnedBranchNamePublicSchema,
} as const;
const PublicGitShaSchema = DeliveryGitShaPublicSchema;
const PublicPullRequestUrlSchema = GitHubPullRequestUrlPublicSchema;

export class DeliveryPublicationIntentDto extends Schema.Class<DeliveryPublicationIntentDto>(
  "DeliveryPublicationIntentDto"
)(
  {
    ...publicPublicationBase,
    state: Schema.Literal("intentRecorded"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class DeliveryPublicationAttemptedDto extends Schema.Class<DeliveryPublicationAttemptedDto>(
  "DeliveryPublicationAttemptedDto"
)(
  {
    ...publicPublicationBase,
    commitSha: PublicGitShaSchema,
    state: Schema.Literal("attempted"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class DeliveryPublicationConfirmedDto extends Schema.Class<DeliveryPublicationConfirmedDto>(
  "DeliveryPublicationConfirmedDto"
)(
  {
    ...publicPublicationBase,
    commitSha: PublicGitShaSchema,
    draft: Schema.Literal(true),
    prNumber: Schema.Int,
    prUrl: PublicPullRequestUrlSchema,
    state: Schema.Literal("confirmed"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class DeliveryPublicationFailureDto extends Schema.Class<DeliveryPublicationFailureDto>(
  "DeliveryPublicationFailureDto"
)(
  {
    ...publicPublicationBase,
    code: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(160))),
    commitSha: Schema.optionalKey(PublicGitShaSchema),
    message: Schema.NonEmptyString.pipe(
      Schema.check(Schema.isMaxLength(1_024))
    ),
    recoverable: Schema.Boolean,
    state: Schema.Literals(["failed", "outcomeUnknown"] as const),
    step: Schema.Literals([
      "validation",
      "commit",
      "push",
      "pullRequest",
      "reconciliation",
    ] as const),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export const DeliveryPublicationDto = Schema.Union([
  DeliveryPublicationIntentDto,
  DeliveryPublicationAttemptedDto,
  DeliveryPublicationConfirmedDto,
  DeliveryPublicationFailureDto,
]).annotate({ identifier: "DeliveryPublicationDto" });

export type DeliveryPublicationDto = typeof DeliveryPublicationDto.Type;

export class DeliveryProvenanceDto extends Schema.Class<DeliveryProvenanceDto>(
  "DeliveryProvenanceDto"
)({
  baseBranch: DeliveryBranchNamePublicSchema,
  baseRevision: DeliveryGitShaPublicSchema,
  headBranch: DeliveryBranchNamePublicSchema,
  remote: DeliveryRemoteNamePublicSchema,
}) {}

const DeliveryActionAuditEntrySchema = Schema.Struct({
  actionId: DeliveryActionIdPublicSchema,
  latestSequence: EventSequenceSchema,
  state: Schema.NonEmptyString,
});
const DeliverySnapshotSseEventIdSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(200))
);

export class DeliverySnapshotDto extends Schema.Class<DeliverySnapshotDto>(
  "DeliverySnapshotDto"
)({
  authoritativeHeadSha: Schema.optionalKey(PublicGitShaSchema),
  eventSequence: Schema.Number.pipe(
    Schema.check(Schema.isInt({ identifier: "EventSequence" }))
  ),
  mode: DeliveryModeSchema,
  provenance: Schema.optionalKey(DeliveryProvenanceDto),
  observation: Schema.optionalKey(DeliveryPullRequestObservation),
  publication: Schema.optionalKey(DeliveryPublicationDto),
  remediation: Schema.optionalKey(DeliveryRemediationSchema),
  activeMergeAction: Schema.optionalKey(DeliveryMergeReceiptSchema),
  latestMergeAction: Schema.optionalKey(DeliveryMergeReceiptSchema),
  activeReadyForReviewAction: Schema.optionalKey(
    DeliveryPullRequestReadyReceiptSchema
  ),
  latestReadyForReviewAction: Schema.optionalKey(
    DeliveryPullRequestReadyReceiptSchema
  ),
  activeLocalReviewAttestation: Schema.optionalKey(
    DeliveryLocalReviewAttestationReceiptSchema
  ),
  latestLocalReviewAttestation: Schema.optionalKey(
    DeliveryLocalReviewAttestationReceiptSchema
  ),
  mergeDecision: Schema.optionalKey(DeliveryMergeReadinessDecisionSchema),
  mergeDecisionSequence: Schema.optionalKey(EventSequenceSchema),
  activeCleanupAction: Schema.optionalKey(DeliveryCleanupReceiptSchema),
  latestCleanupAction: Schema.optionalKey(DeliveryCleanupReceiptSchema),
  actionAudit: Schema.optionalKey(
    Schema.Struct({
      cleanup: Schema.Array(DeliveryActionAuditEntrySchema).pipe(
        Schema.check(Schema.isMaxLength(20))
      ),
      localReviewAttestation: Schema.optionalKey(
        Schema.Array(DeliveryActionAuditEntrySchema).pipe(
          Schema.check(Schema.isMaxLength(20))
        )
      ),
      merge: Schema.Array(DeliveryActionAuditEntrySchema).pipe(
        Schema.check(Schema.isMaxLength(20))
      ),
      readyForReview: Schema.Array(DeliveryActionAuditEntrySchema).pipe(
        Schema.check(Schema.isMaxLength(20))
      ),
    })
  ),
  remediationRearmSequence: Schema.optionalKey(
    Schema.Number.pipe(
      Schema.check(Schema.isInt({ identifier: "EventSequence" })),
      Schema.check(Schema.isGreaterThanOrEqualTo(1))
    )
  ),
  recoveryActions: Schema.Array(DeliveryPublicRecoveryActionKindSchema),
  runId: RunIdSchema,
  stage: DeliveryStatusSchema,
  status: DeliveryStatusSchema,
  workerContinuation: Schema.optionalKey(WorkerContinuationReceiptSchema),
  workerCorrelationReconciliation: Schema.optionalKey(
    WorkerCorrelationReconciliationReceiptSchema
  ),
  workerDesktopOriginCorrelation: Schema.optionalKey(
    WorkerDesktopOriginCorrelationReceiptSchema
  ),
  workerRecovery: Schema.optionalKey(WorkerRecoveryReceiptSchema),
}) {}

export class DeliverySnapshotSuccessEnvelope extends Schema.Class<DeliverySnapshotSuccessEnvelope>(
  "DeliverySnapshotSuccessEnvelope"
)({
  data: DeliverySnapshotDto,
  status: Schema.Literal("success"),
}) {}

export class WorkerRecoverySuccessEnvelope extends Schema.Class<WorkerRecoverySuccessEnvelope>(
  "WorkerRecoverySuccessEnvelope"
)({
  data: WorkerRecoveryReceiptSchema,
  status: Schema.Literal("success"),
}) {}

const verificationActionAuthorityFields = {
  actionId: DeliveryActionIdPublicSchema,
  expectedContentAuthoritySequence: RunEventSequenceSchema,
  expectedContractDigest: DeliverySha256DigestPublicSchema,
  expectedEventSequence: RunEventSequenceSchema,
} as const;

export class StartPostPublicationGenerationAction extends Schema.Class<StartPostPublicationGenerationAction>(
  "StartPostPublicationGenerationAction"
)(
  {
    ...verificationActionAuthorityFields,
    expectedHeadSha: DeliveryGitShaPublicSchema,
    expectedPublicationSequence: RunEventSequenceSchema,
    expectedTargetDigest: StructuralDigestSchema,
    kind: Schema.Literal("startPostPublicationGeneration"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class CreatedWithoutCommandStartPrior extends Schema.Class<CreatedWithoutCommandStartPrior>(
  "CreatedWithoutCommandStartPrior"
)(
  {
    kind: Schema.Literal("createdWithoutCommandStart"),
    priorSandboxCreatedSequence: RunEventSequenceSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class CommandStartOutcomeUnknownPrior extends Schema.Class<CommandStartOutcomeUnknownPrior>(
  "CommandStartOutcomeUnknownPrior"
)(
  {
    kind: Schema.Literal("commandStartOutcomeUnknown"),
    priorCommandStartSequence: RunEventSequenceSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class ReconcileOutcomeUnknownAction extends Schema.Class<ReconcileOutcomeUnknownAction>(
  "ReconcileOutcomeUnknownAction"
)(
  {
    ...verificationActionAuthorityFields,
    claimId: Schema.String.pipe(
      Schema.check(Schema.isPattern(/^proof-claim:sha256:[a-f0-9]{64}$/u))
    ),
    expectedExecutionEvidenceIdentityDigest: VerificationIdentityDigestSchema,
    expectedSandboxName: VerificationSandboxNameSchema,
    expectedSandboxUuid: VerificationSandboxUuidSchema,
    kind: Schema.Literal("reconcileOutcomeUnknown"),
    prior: Schema.Union([
      CreatedWithoutCommandStartPrior,
      CommandStartOutcomeUnknownPrior,
    ]),
    priorGenerationSequence: RunEventSequenceSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

/** Exactly two public verification mutations. */
export const VerificationActionRequestSchema = Schema.Union([
  StartPostPublicationGenerationAction,
  ReconcileOutcomeUnknownAction,
]);
export type VerificationActionRequest =
  typeof VerificationActionRequestSchema.Type;
export const parseVerificationActionRequest = Schema.decodeUnknownSync(
  VerificationActionRequestSchema,
  { onExcessProperty: "error" }
);

/** Successful post-publication verification generation response. */
export class PostPublicationGenerationRecorded extends Schema.Class<PostPublicationGenerationRecorded>(
  "PostPublicationGenerationRecorded"
)(
  {
    actionId: DeliveryActionIdPublicSchema,
    actionRequestDigest: DeliverySha256DigestPublicSchema,
    aggregate: RunVerificationAggregateSchema,
    currentContentAuthoritySequence: RunEventSequenceSchema,
    expectedContentAuthoritySequence: RunEventSequenceSchema,
    generationSequence: RunEventSequenceSchema,
    headSha: DeliveryGitShaPublicSchema,
    kind: Schema.Literal("postPublicationGenerationRecorded"),
    proofResultDigest: RunProofResultDigestSchema,
    proofResultSequence: RunEventSequenceSchema,
    publicationSequence: RunEventSequenceSchema,
    replayed: Schema.Literal(false),
    runId: RunIdSchema,
    targetDigest: StructuralDigestSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

const reconciliationResponseFields = {
  actionId: DeliveryActionIdPublicSchema,
  actionRequestDigest: VerificationRequestDigestSchema,
  claimId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^proof-claim:sha256:[a-f0-9]{64}$/u))
  ),
  generationSequence: RunEventSequenceSchema,
  reconciliationReceipt: VerificationReconciliationReceiptV1,
  reconciliationSequence: RunEventSequenceSchema,
  replayed: Schema.Literal(false),
  runId: RunIdSchema,
} as const;

export class CreatedWithoutCommandStartReconciled extends Schema.Class<CreatedWithoutCommandStartReconciled>(
  "CreatedWithoutCommandStartReconciled"
)(
  {
    ...reconciliationResponseFields,
    kind: Schema.Literal("createdWithoutCommandStartReconciled"),
    sandboxCreatedSequence: RunEventSequenceSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class CommandStartOutcomeUnknownReconciled extends Schema.Class<CommandStartOutcomeUnknownReconciled>(
  "CommandStartOutcomeUnknownReconciled"
)(
  {
    ...reconciliationResponseFields,
    commandStartSequence: RunEventSequenceSchema,
    kind: Schema.Literal("commandStartOutcomeUnknownReconciled"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export const VerificationActionRecordedResultSchema = Schema.Union([
  PostPublicationGenerationRecorded,
  CreatedWithoutCommandStartReconciled,
  CommandStartOutcomeUnknownReconciled,
]);

export class VerificationActionIdempotentReplay extends Schema.Class<VerificationActionIdempotentReplay>(
  "VerificationActionIdempotentReplay"
)(
  {
    actionId: DeliveryActionIdPublicSchema,
    actionRequestDigest: VerificationRequestDigestSchema,
    kind: Schema.Literal("idempotentReplay"),
    originalKind: Schema.Literals([
      "postPublicationGenerationRecorded",
      "createdWithoutCommandStartReconciled",
      "commandStartOutcomeUnknownReconciled",
    ] as const),
    originalResponseDigest: VerificationRequestDigestSchema,
    originalResult: VerificationActionRecordedResultSchema,
    replayed: Schema.Literal(true),
    runId: RunIdSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export const VerificationActionResultSchema = Schema.Union([
  VerificationActionRecordedResultSchema,
  VerificationActionIdempotentReplay,
]);
export const parseVerificationActionResult = Schema.decodeUnknownSync(
  VerificationActionResultSchema,
  { onExcessProperty: "error" }
);

/** Success envelope for the verification action endpoint. */
export class VerificationActionSuccessEnvelope extends Schema.Class<VerificationActionSuccessEnvelope>(
  "VerificationActionSuccessEnvelope"
)(
  {
    data: VerificationActionResultSchema,
    status: Schema.Literal("success"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export const DeliverySnapshotSseEventSchema = Schema.Struct({
  data: Schema.fromJsonString(DeliverySnapshotDto),
  event: Schema.Literal("delivery-update"),
  id: DeliverySnapshotSseEventIdSchema,
});

export class LocalRunEventsSuccessEnvelope extends Schema.Class<LocalRunEventsSuccessEnvelope>(
  "LocalRunEventsSuccessEnvelope"
)({
  data: LocalRunEventsDto,
  status: Schema.Literal("success"),
}) {}

export class LocalRunApiErrorEnvelope extends Schema.Class<LocalRunApiErrorEnvelope>(
  "LocalRunApiErrorEnvelope"
)({
  ...LocalRunApiDiagnosticDto.fields,
  status: LocalRunApiErrorStatusSchema,
}) {}

export class LocalRunApiBadRequest extends Schema.Class<LocalRunApiBadRequest>(
  "LocalRunApiBadRequest"
)({
  ...diagnosticFields,
  code: BadRequestDiagnosticCodeSchema,
  status: Schema.Literal(400),
}) {}

export class LocalRunApiNotFound extends Schema.Class<LocalRunApiNotFound>(
  "LocalRunApiNotFound"
)({
  ...diagnosticFields,
  code: NotFoundDiagnosticCodeSchema,
  status: Schema.Literal(404),
}) {}

export class LocalRunApiForbidden extends Schema.Class<LocalRunApiForbidden>(
  "LocalRunApiForbidden"
)({
  ...diagnosticFields,
  code: ForbiddenDiagnosticCodeSchema,
  status: Schema.Literal(403),
}) {}

export class LocalRunApiMethodNotAllowed extends Schema.Class<LocalRunApiMethodNotAllowed>(
  "LocalRunApiMethodNotAllowed"
)({
  ...diagnosticFields,
  code: MethodNotAllowedDiagnosticCodeSchema,
  status: Schema.Literal(405),
}) {}

export class LocalRunApiConflict extends Schema.Class<LocalRunApiConflict>(
  "LocalRunApiConflict"
)({
  ...diagnosticFields,
  code: ConflictDiagnosticCodeSchema,
  status: Schema.Literal(409),
}) {}

export class LocalRunApiUnprocessable extends Schema.Class<LocalRunApiUnprocessable>(
  "LocalRunApiUnprocessable"
)({
  ...diagnosticFields,
  code: UnprocessableDiagnosticCodeSchema,
  status: Schema.Literal(422),
}) {}

export class LocalRunApiInternalServerError extends Schema.Class<LocalRunApiInternalServerError>(
  "LocalRunApiInternalServerError"
)({
  ...diagnosticFields,
  code: InternalServerDiagnosticCodeSchema,
  status: Schema.Literal(500),
}) {}

export const LocalRunListResponse = Schema.Union([
  LocalRunListSuccessEnvelope,
  LocalRunListPartialEnvelope,
]);

export const LocalRunApiBadRequestResponse = LocalRunApiBadRequest.pipe(
  HttpApiSchema.status(400)
);
export const LocalRunApiNotFoundResponse = LocalRunApiNotFound.pipe(
  HttpApiSchema.status(404)
);
export const LocalRunApiForbiddenResponse = LocalRunApiForbidden.pipe(
  HttpApiSchema.status(403)
);
export const LocalRunApiMethodNotAllowedResponse =
  LocalRunApiMethodNotAllowed.pipe(HttpApiSchema.status(405));
export const LocalRunApiConflictResponse = LocalRunApiConflict.pipe(
  HttpApiSchema.status(409)
);
export const LocalRunApiUnprocessableResponse = LocalRunApiUnprocessable.pipe(
  HttpApiSchema.status(422)
);
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

export const LocalRunControlErrorResponse = [
  LocalRunApiBadRequestResponse,
  LocalRunApiForbiddenResponse,
  LocalRunApiNotFoundResponse,
  LocalRunApiConflictResponse,
  LocalRunApiUnprocessableResponse,
  LocalRunApiInternalServerErrorResponse,
] as const;

export const LocalRunInternalErrorResponse = [
  LocalRunApiInternalServerErrorResponse,
] as const;

const ServerIdSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(200))
);
const ServerMetadataTimestampSchema = DeliveryTimestampPublicSchema;

export class ServerMetadata extends Schema.Class<ServerMetadata>(
  "ServerMetadata"
)({
  gaiaRoot: Schema.NonEmptyString,
  host: ServerHostSchema,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Pid" }))),
  port: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Port" }))),
  serverId: ServerIdSchema,
  startedAt: ServerMetadataTimestampSchema,
  updatedAt: ServerMetadataTimestampSchema,
  url: LocalGaiaServerUrlSchema,
  version: Schema.Literal(1),
  workspaceRoot: Schema.NonEmptyString,
}) {}

export class HealthResponse extends Schema.Class<HealthResponse>(
  "HealthResponse"
)({
  gaiaRoot: Schema.NonEmptyString,
  host: ServerHostSchema,
  pid: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Pid" }))),
  port: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Port" }))),
  serverId: ServerIdSchema,
  startedAt: ServerMetadataTimestampSchema,
  status: Schema.Literal("ok"),
  updatedAt: ServerMetadataTimestampSchema,
  url: LocalGaiaServerUrlSchema,
  version: Schema.Literal(1),
  workspaceRoot: Schema.NonEmptyString,
}) {}

/** Work item body for the fresh issue delivery run create command. */
export class CreateRunIssueWorkItemRequest extends Schema.Class<CreateRunIssueWorkItemRequest>(
  "CreateRunIssueWorkItemRequest"
)(
  {
    description: Schema.NonEmptyString,
    externalRefs: Schema.optionalKey(Schema.Array(FactoryExternalRefDto)),
    kind: Schema.Literal("issue"),
    title: Schema.NonEmptyString,
  },
  {
    parseOptions: { onExcessProperty: "error" },
  }
) {}

export const CreateRunLocalDeliveryRequest = Schema.Struct({
  mode: Schema.Literal("local"),
}).pipe(
  Schema.decode({
    decode: SchemaGetter.transform(strictDeliveryRequestKeys),
    encode: SchemaGetter.transform(strictDeliveryRequestKeys),
  })
);

export const CreateRunPullRequestDeliveryRequest = Schema.Struct({
  mode: Schema.Literal("pullRequest"),
}).pipe(
  Schema.decode({
    decode: SchemaGetter.transform(strictDeliveryRequestKeys),
    encode: SchemaGetter.transform(strictDeliveryRequestKeys),
  })
);

export const CreateRunDeliveryRequest = Schema.Union([
  CreateRunLocalDeliveryRequest,
  CreateRunPullRequestDeliveryRequest,
]);

function strictDeliveryRequestKeys<T extends object>(value: T) {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "mode") {
    throw new Error("Delivery request only accepts a mode field.");
  }
  return value;
}

/** Fresh factory-run create body for the issueDelivery workflow. */
export class CreateRunRequest extends Schema.Class<CreateRunRequest>(
  "CreateRunRequest"
)(
  {
    delivery: Schema.optionalKey(CreateRunDeliveryRequest),
    execution: HarnessExecutionSelection,
    workflow: FactoryWorkflowIdSchema,
    workItem: CreateRunIssueWorkItemRequest,
  },
  {
    parseOptions: { onExcessProperty: "error" },
  }
) {}

export class CreateRunAcceptedResponse extends Schema.Class<CreateRunAcceptedResponse>(
  "CreateRunAcceptedResponse"
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
  })
);

export const RunsGroup = HttpApiGroup.make("runs")
  .add(
    HttpApiEndpoint.get("listRuns", "/runs", {
      error: LocalRunInternalErrorResponse,
      success: FactoryRunListSuccessEnvelope,
    })
  )
  .add(
    HttpApiEndpoint.post("createRun", "/runs", {
      error: LocalRunCreateErrorResponse,
      payload: [CreateRunRequest, HttpApiSchema.NoContent],
      success: CreateRunAcceptedResponse.pipe(HttpApiSchema.status(202)),
    })
  )
  .add(
    HttpApiEndpoint.get("getRun", "/runs/:runId", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryRunDetailSuccessEnvelope,
    })
  )
  .add(
    HttpApiEndpoint.get("getRunControl", "/runs/:runId/control", {
      error: LocalRunControlErrorResponse,
      params: { runId: RunIdSchema },
      success: RunControlSnapshot,
    })
  )
  .add(
    HttpApiEndpoint.post("actOnRunControl", "/runs/:runId/control/actions", {
      error: LocalRunControlErrorResponse,
      params: { runId: RunIdSchema },
      payload: RunControlActionSchema,
      success: RunControlReceipt,
    })
  )
  .add(
    HttpApiEndpoint.get("getFactoryGraph", "/runs/:runId/factory-graph", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryGraphSuccessEnvelope,
    })
  )
  .add(
    HttpApiEndpoint.get("getRunEvents", "/runs/:runId/events", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: LocalRunEventsSuccessEnvelope,
    }).annotate(OpenApi.Exclude, true)
  )
  .add(
    HttpApiEndpoint.get("streamRunEvents", "/runs/:runId/events/stream", {
      error: LocalRunStreamErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: RunEventStreamResponse,
    }).annotate(OpenApi.Exclude, true)
  )
  .add(
    HttpApiEndpoint.get("getRunActivity", "/runs/:runId/activity", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryActivitySuccessEnvelope,
    })
  )
  .add(
    HttpApiEndpoint.get("getDeliverySnapshot", "/runs/:runId/delivery", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: DeliverySnapshotSuccessEnvelope,
    })
  )
  .add(
    HttpApiEndpoint.get(
      "streamDeliverySnapshot",
      "/runs/:runId/delivery/stream",
      {
        error: [...LocalRunStreamErrorResponse, LocalRunApiConflictResponse],
        params: {
          runId: RunIdSchema,
        },
        query: { afterSequence: Schema.optionalKey(Schema.NumberFromString) },
        success: DeliverySnapshotStreamResponse,
      }
    )
  )
  .add(
    HttpApiEndpoint.post("actOnDelivery", "/runs/:runId/delivery/actions", {
      error: [...LocalRunReadErrorResponse, LocalRunApiConflictResponse],
      params: { runId: RunIdSchema },
      payload: DeliveryActionRequestSchema,
      success: DeliverySnapshotSuccessEnvelope,
    })
  )
  .add(
    HttpApiEndpoint.post(
      "actOnRunVerification",
      "/runs/:runId/verification/actions",
      {
        error: [...LocalRunReadErrorResponse, LocalRunApiConflictResponse],
        params: { runId: RunIdSchema },
        payload: VerificationActionRequestSchema,
        success: VerificationActionSuccessEnvelope,
      }
    )
  )
  .add(
    HttpApiEndpoint.post("recoverWorker", "/runs/:runId/recovery/actions", {
      error: [...LocalRunReadErrorResponse, LocalRunApiConflictResponse],
      params: { runId: RunIdSchema },
      payload: WorkerRecoveryAction,
      success: WorkerRecoverySuccessEnvelope,
    })
  )
  .add(
    HttpApiEndpoint.get(
      "getAgentActivity",
      "/runs/:runId/agents/:agentId/activity",
      {
        error: LocalRunReadErrorResponse,
        params: {
          agentId: FactoryAgentIdSchema,
          runId: RunIdSchema,
        },
        success: FactoryActivitySuccessEnvelope,
      }
    )
  )
  .add(
    HttpApiEndpoint.get(
      "getAgentSession",
      "/runs/:runId/agents/:agentId/session",
      {
        error: LocalRunReadErrorResponse,
        params: { agentId: FactoryAgentIdSchema, runId: RunIdSchema },
        success: AgentSessionSnapshotSuccessEnvelope,
      }
    )
  )
  .add(
    HttpApiEndpoint.get(
      "streamAgentSession",
      "/runs/:runId/agents/:agentId/session/stream",
      {
        error: [...LocalRunStreamErrorResponse, LocalRunApiConflictResponse],
        params: { agentId: FactoryAgentIdSchema, runId: RunIdSchema },
        query: { afterSequence: AgentSessionCursorSchema },
        success: AgentSessionStreamResponse,
      }
    )
  )
  .add(
    HttpApiEndpoint.post(
      "actOnAgentSession",
      "/runs/:runId/agents/:agentId/session/actions",
      {
        error: [...LocalRunReadErrorResponse, LocalRunApiConflictResponse],
        params: { agentId: FactoryAgentIdSchema, runId: RunIdSchema },
        payload: AgentOperatorActionRequestSchema,
        success: AgentActionSuccessEnvelope,
      }
    )
  )
  .add(
    HttpApiEndpoint.get("listRunArtifacts", "/runs/:runId/artifacts", {
      error: LocalRunReadErrorResponse,
      params: {
        runId: RunIdSchema,
      },
      success: FactoryArtifactListSuccessEnvelope,
    })
  )
  .add(
    HttpApiEndpoint.get(
      "getRunArtifact",
      "/runs/:runId/artifacts/:artifactId",
      {
        error: LocalRunReadErrorResponse,
        params: {
          artifactId: FactoryArtifactIdSchema,
          runId: RunIdSchema,
        },
        success: FactoryArtifactSuccessEnvelope,
      }
    )
  );

export const LocalGaiaServerApi = HttpApi.make("LocalGaiaServerApi")
  .add(HealthGroup)
  .add(RunsGroup)
  .annotate(OpenApi.Title, "Local Gaia Server API")
  .annotate(OpenApi.Version, "0.1.0")
  .annotate(
    OpenApi.Description,
    "Local loopback Gaia server contract for workspace health and run reads."
  );

export const LocalGaiaServerOpenApi = OpenApi.fromApi(LocalGaiaServerApi);

export type LocalRunApiError =
  | typeof LocalRunApiBadRequest.Type
  | typeof LocalRunApiNotFound.Type
  | typeof LocalRunApiMethodNotAllowed.Type
  | typeof LocalRunApiConflict.Type
  | typeof LocalRunApiForbidden.Type
  | typeof LocalRunApiUnprocessable.Type
  | typeof LocalRunApiInternalServerError.Type;
