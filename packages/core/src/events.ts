import * as Schema from "effect/Schema";

import { RunIdSchema } from "./run-id.js";

const RunEventSequenceSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt({ identifier: "Sequence" }))
);
export const RunEventTimestampSchema = Schema.NonEmptyString.pipe(
  Schema.brand("RunEventTimestamp")
);
const RunSnapshotEventSequenceSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt({ identifier: "EventSequence" }))
);

export const RunStateSchema = Schema.Literals([
  "created",
  "preparingWorkspace",
  "delivering",
  "runningWorker",
  "verifying",
  "reporting",
  "completed",
  "failed",
] as const);

/** Durable run lifecycle state. */
export type RunState = typeof RunStateSchema.Type;

export const EventTypeSchema = Schema.Literals([
  "RUN_CREATED",
  "DELIVERY_STARTED",
  "WORKSPACE_PREPARED",
  "REVIEW_STARTED",
  "REVIEW_COMPLETED",
  "WORKER_STARTED",
  "WORKER_COMPLETED",
  "PREVIEW_DEPLOYMENT_RECORDED",
  "VERIFICATION_STARTED",
  "VERIFICATION_COMPLETED",
  "BROWSER_EVIDENCE_RECORDED",
  "REPORT_STARTED",
  "REPORT_COMPLETED",
  "DELIVERY_READY_TO_PUBLISH",
  "DELIVERY_PUBLICATION_INTENT_RECORDED",
  "DELIVERY_PUBLICATION_ATTEMPTED",
  "DELIVERY_PUBLICATION_CONFIRMED",
  "DELIVERY_PUBLICATION_FAILED",
  "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN",
  "DELIVERY_REMEDIATION_RECORDED",
  "DELIVERY_PR_READY_RECORDED",
  "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED",
  "DELIVERY_MERGE_READINESS_RECORDED",
  "DELIVERY_MERGE_RECORDED",
  "DELIVERY_CLEANUP_RECORDED",
  "DELIVERY_CLEANUP_PROVENANCE_RECORDED",
  "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED",
  "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED",
  "GITHUB_CHECKS_RECORDED",
  "GITHUB_FEEDBACK_RECORDED",
  "GITHUB_PR_LOOP_RECORDED",
  "GITHUB_PR_COMMENT_RECORDED",
  "GITHUB_REMEDIATION_SPEC_RECORDED",
  "LINEAR_ISSUE_GRAPH_RECORDED",
  "MERGE_DECISION_RECORDED",
  "HARNESS_SESSION_EVENT_RECORDED",
  "WORKER_RECOVERY_RECORDED",
  "WORKER_CONTINUATION_RECORDED",
  "WORKER_CORRELATION_RECONCILIATION_RECORDED",
  "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED",
  "RUN_FAILED",
] as const);

/** Durable Gaia run event type. */
export type EventType = typeof EventTypeSchema.Type;

export const FailureStageSchema = Schema.Literals([
  "creating",
  "preparingWorkspace",
  "reviewing",
  "runningWorker",
  "verifying",
  "reporting",
  "replaying",
] as const);

/** Lifecycle stage where a typed failure occurred. */
export type FailureStage = typeof FailureStageSchema.Type;

export const ReviewPhaseSchema = Schema.Literals(["plan", "evidence"] as const);

/** Read-only reviewer phase within a Gaia run. */
export type ReviewPhase = typeof ReviewPhaseSchema.Type;

export class GaiaFailure extends Schema.Class<GaiaFailure>("GaiaFailure")({
  code: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  recoverable: Schema.Boolean,
  stage: FailureStageSchema,
}) {}

export class RunEvent extends Schema.Class<RunEvent>("RunEvent")({
  payload: Schema.Record(Schema.String, Schema.Json),
  runId: RunIdSchema,
  sequence: RunEventSequenceSchema,
  timestamp: RunEventTimestampSchema,
  type: EventTypeSchema,
  version: Schema.Literal(1),
}) {}

export class RunSnapshot extends Schema.Class<RunSnapshot>("RunSnapshot")({
  context: Schema.Record(Schema.String, Schema.Json),
  eventSequence: RunSnapshotEventSequenceSchema,
  runId: RunIdSchema,
  state: RunStateSchema,
  timestamp: RunEventTimestampSchema,
  version: Schema.Literal(1),
}) {}

const MakeRunEventInputSchema = Schema.Struct({
  payload: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  runId: RunIdSchema,
  sequence: RunEventSequenceSchema,
  timestamp: Schema.toEncoded(RunEventTimestampSchema),
  type: EventTypeSchema,
});

const parseMakeRunEventInput = Schema.decodeUnknownSync(
  MakeRunEventInputSchema
);

/** Parse an event read from the append-only event log. */
export const parseRunEvent = Schema.decodeUnknownSync(RunEvent);

/** Parse a snapshot read from the derived snapshot log. */
export const parseRunSnapshot = Schema.decodeUnknownSync(RunSnapshot);

/** Create a durable event record. */
export function makeRunEvent(
  input: Schema.Schema.Type<typeof MakeRunEventInputSchema>
): RunEvent {
  const parsed = parseMakeRunEventInput(input);
  return parseRunEvent({
    payload: parsed.payload ?? {},
    runId: parsed.runId,
    sequence: parsed.sequence,
    timestamp: parsed.timestamp,
    type: parsed.type,
    version: 1,
  });
}
