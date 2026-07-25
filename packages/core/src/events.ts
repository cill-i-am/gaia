import * as Schema from "effect/Schema";

import { parseAcceptedRunInputCheckpointRef } from "./accepted-run-input.js";
import {
  parseModelInvocationEpisodeStart,
  parseModelInvocationObservation,
} from "./model-invocation.js";
import {
  parseAnyRunContract,
  parseAnyRunProofResultEnvelope,
} from "./run-contract-v2.js";
import { RunEventSequenceSchema } from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";
import {
  ClaimVerificationCommandStartV1,
  ClaimVerificationCreateIntentV1,
  ClaimVerificationGenerationStartedV1,
  ClaimVerificationReuseReceiptV1,
  ClaimVerificationSandboxCreatedV1,
  parseVerificationCommandReceipt,
  parseVerificationReconciliationReceipt,
} from "./verification-command.js";

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
  "waitingForHuman",
  "paused",
  "verifying",
  "reporting",
  "completed",
  "cancelled",
  "failed",
] as const);

/** Durable run lifecycle state. */
export type RunState = typeof RunStateSchema.Type;

export const EventTypeSchema = Schema.Literals([
  "RUN_CREATED",
  "RUN_CONTRACT_RECORDED",
  "DELIVERY_STARTED",
  "WORKSPACE_PREPARED",
  "REVIEW_STARTED",
  "REVIEW_COMPLETED",
  "WORKER_STARTED",
  "WORKER_COMPLETED",
  "PREVIEW_DEPLOYMENT_RECORDED",
  "VERIFICATION_STARTED",
  "VERIFICATION_COMPLETED",
  "RUN_PROOF_RESULT_RECORDED",
  "CLAIM_VERIFICATION_GENERATION_STARTED",
  "CLAIM_VERIFICATION_CREATE_INTENT_RECORDED",
  "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED",
  "CLAIM_VERIFICATION_COMMAND_START_RECORDED",
  "CLAIM_VERIFICATION_COMMAND_RECORDED",
  "CLAIM_VERIFICATION_REUSE_RECORDED",
  "CLAIM_VERIFICATION_RECONCILIATION_RECORDED",
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
  "RUN_WAITING_FOR_HUMAN",
  "RUN_INTERACTION_EXPIRED",
  "RUN_CONTROL_INTENT_RECORDED",
  "RUN_CONTROL_ATTEMPTED",
  "RUN_CONTROL_CONFIRMED",
  "RUN_CONTROL_FAILED",
  "RUN_CONTROL_OUTCOME_UNKNOWN",
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
  sequence: Schema.toEncoded(RunEventSequenceSchema),
  timestamp: Schema.toEncoded(RunEventTimestampSchema),
  type: EventTypeSchema,
});

const parseMakeRunEventInput = Schema.decodeUnknownSync(
  MakeRunEventInputSchema
);

const decodeRunEvent = Schema.decodeUnknownSync(RunEvent);

/** Parse and validate an event read from the append-only event log. */
export const parseRunEvent = (input: unknown): RunEvent => {
  const event = decodeRunEvent(input);
  if (event.type === "RUN_CREATED") {
    const checkpoint = event.payload["acceptedInputCheckpoint"];
    if (checkpoint !== undefined)
      parseAcceptedRunInputCheckpointRef(checkpoint);
    const protocol = event.payload["modelInvocationProtocol"];
    if (protocol !== undefined && protocol !== "v1")
      throw new Error("Unknown model invocation protocol marker.");
  }
  if (event.type === "RUN_CONTRACT_RECORDED") {
    const contract = parseAnyRunContract(event.payload["contract"]);
    if (contract.runId !== event.runId)
      throw new Error("Run-contract event payload belongs to another run.");
  }
  if (event.type === "RUN_PROOF_RESULT_RECORDED") {
    const result = parseAnyRunProofResultEnvelope(event.payload["result"]);
    if (
      result.runId !== event.runId ||
      result.recordedBy.sequence !== event.sequence
    )
      throw new Error("Run-proof result does not bind its enclosing event.");
  }
  const episode = event.payload["modelInvocationEpisode"];
  if (episode !== undefined) {
    const parsed = parseModelInvocationEpisodeStart(episode);
    if (
      parsed.contextRef.runId !== event.runId ||
      parsed.invocationRef.runId !== event.runId ||
      parsed.contextRef.episodeKey !== parsed.episodeKey ||
      parsed.invocationRef.episodeKey !== parsed.episodeKey ||
      parsed.contextRef.kind !== "modelContextManifest" ||
      parsed.invocationRef.kind !== "modelInvocationManifest"
    )
      throw new Error(
        "Model invocation episode does not bind its owner event."
      );
  }
  const observation = event.payload["modelInvocationObservation"];
  if (observation !== undefined) parseModelInvocationObservation(observation);
  validateClaimVerificationPayload(event);
  return event;
};

function validateClaimVerificationPayload(event: RunEvent) {
  const ensureRun = (runId: string) => {
    if (runId !== event.runId)
      throw new Error("Claim-verification payload belongs to another run.");
  };
  switch (event.type) {
    case "CLAIM_VERIFICATION_GENERATION_STARTED":
      ensureRun(
        Schema.decodeUnknownSync(ClaimVerificationGenerationStartedV1)(
          event.payload["generation"]
        ).runId
      );
      return;
    case "CLAIM_VERIFICATION_CREATE_INTENT_RECORDED":
      ensureRun(
        Schema.decodeUnknownSync(ClaimVerificationCreateIntentV1)(
          event.payload["createIntent"]
        ).runId
      );
      return;
    case "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED":
      ensureRun(
        Schema.decodeUnknownSync(ClaimVerificationSandboxCreatedV1)(
          event.payload["sandboxCreated"]
        ).runId
      );
      return;
    case "CLAIM_VERIFICATION_COMMAND_START_RECORDED":
      ensureRun(
        Schema.decodeUnknownSync(ClaimVerificationCommandStartV1)(
          event.payload["commandStart"]
        ).runId
      );
      return;
    case "CLAIM_VERIFICATION_COMMAND_RECORDED":
      ensureRun(
        parseVerificationCommandReceipt(event.payload["receipt"]).runId
      );
      return;
    case "CLAIM_VERIFICATION_REUSE_RECORDED":
      ensureRun(
        Schema.decodeUnknownSync(ClaimVerificationReuseReceiptV1)(
          event.payload["reuse"]
        ).runId
      );
      return;
    case "CLAIM_VERIFICATION_RECONCILIATION_RECORDED":
      ensureRun(
        parseVerificationReconciliationReceipt(event.payload["reconciliation"])
          .runId
      );
      return;
  }
}

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
