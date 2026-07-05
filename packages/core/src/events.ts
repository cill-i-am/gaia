import * as Schema from "effect/Schema";
import { RunIdSchema } from "./run-id.js";

export const RunStateSchema = Schema.Literals([
  "created",
  "preparingWorkspace",
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
  "GITHUB_CHECKS_RECORDED",
  "GITHUB_FEEDBACK_RECORDED",
  "GITHUB_PR_LOOP_RECORDED",
  "GITHUB_REMEDIATION_SPEC_RECORDED",
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
  sequence: Schema.Number.pipe(Schema.check(Schema.isInt({ identifier: "Sequence" }))),
  timestamp: Schema.NonEmptyString,
  type: EventTypeSchema,
  version: Schema.Literal(1),
}) {}

export class RunSnapshot extends Schema.Class<RunSnapshot>("RunSnapshot")({
  context: Schema.Record(Schema.String, Schema.Json),
  eventSequence: Schema.Number.pipe(
    Schema.check(Schema.isInt({ identifier: "EventSequence" })),
  ),
  runId: RunIdSchema,
  state: RunStateSchema,
  timestamp: Schema.NonEmptyString,
  version: Schema.Literal(1),
}) {}

/** Parse an event read from the append-only event log. */
export const parseRunEvent = Schema.decodeUnknownSync(RunEvent);

/** Parse a snapshot read from the derived snapshot log. */
export const parseRunSnapshot = Schema.decodeUnknownSync(RunSnapshot);

/** Create a durable event record. */
export function makeRunEvent(input: {
  readonly payload?: Readonly<Record<string, Schema.Json>>;
  readonly runId: typeof RunIdSchema.Type;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: EventType;
}): RunEvent {
  return RunEvent.make({
    payload: input.payload ?? {},
    runId: input.runId,
    sequence: input.sequence,
    timestamp: input.timestamp,
    type: input.type,
    version: 1,
  });
}
