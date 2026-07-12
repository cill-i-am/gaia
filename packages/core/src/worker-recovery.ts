import { Schema } from "effect";
import { HarnessProfileIdSchema } from "./harness-execution.js";
import { HarnessSessionIdSchema } from "./harness-session.js";
import { RunIdSchema } from "./run-id.js";

const ActionId = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200)));
const ModelId = Schema.NonEmptyString.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/u)), Schema.check(Schema.isMaxLength(120)));
const Sequence = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)));
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)));

export const WorkerRecoveryFailureCodeSchema = Schema.Literals([
  "DeliveryActionConflict",
  "InternalServerError",
  "WorkerRecoveryCorrelationUnavailable",
  "WorkerRecoveryIntentPersistenceFailed",
  "WorkerRecoveryModelCatalogUnavailable",
  "WorkerRecoveryModelUnavailable",
] as const);
export const WorkerRecoveryFailureStageSchema = Schema.Literals([
  "correlation",
  "intentPersistence",
  "modelCatalog",
  "modelSelection",
  "unknown",
] as const);
export class WorkerRecoveryFailureEvidence extends Schema.Class<WorkerRecoveryFailureEvidence>("WorkerRecoveryFailureEvidence")({
  actionId: ActionId,
  code: WorkerRecoveryFailureCodeSchema,
  runId: RunIdSchema,
  stage: WorkerRecoveryFailureStageSchema,
  status: Schema.Literals([409, 422, 500] as const),
  timestamp: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/u))),
}, { parseOptions: { onExcessProperty: "error" } }) {}

export class WorkerRecoveryAction extends Schema.Class<WorkerRecoveryAction>("WorkerRecoveryAction")({
  actionId: ActionId,
  expectedFailureSequence: Sequence,
  expectedSessionId: HarnessSessionIdSchema,
  harnessProfileId: HarnessProfileIdSchema,
  kind: Schema.Literal("retryRecoverableWorkerFailure"),
  model: ModelId,
}, { parseOptions: { onExcessProperty: "error" } }) {}

const Base = {
  actionId: ActionId,
  attempt: Schema.Literal(1),
  expectedFailureSequence: Sequence,
  expectedSessionId: HarnessSessionIdSchema,
  harnessProfileId: HarnessProfileIdSchema,
  maxAttempts: Schema.Literal(1),
  model: ModelId,
  payloadDigest: Digest,
} as const;

export const WorkerRecoveryReceiptSchema = Schema.Union([
  Schema.Struct({ ...Base, state: Schema.Literal("intentRecorded") }),
  Schema.Struct({ ...Base, state: Schema.Literal("preflightConfirmed") }),
  Schema.Struct({ ...Base, state: Schema.Literal("dispatchAttempted") }),
  Schema.Struct({ ...Base, nativeTurnIdDigest: Digest, state: Schema.Literal("dispatchConfirmed") }),
  Schema.Struct({
    ...Base,
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    nativeTurnIdDigest: Schema.optionalKey(Digest),
    state: Schema.Literal("failed"),
  }),
  Schema.Struct({ ...Base, code: Schema.NonEmptyString, message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))), state: Schema.Literal("outcomeUnknown") }),
]);
export type WorkerRecoveryReceipt = typeof WorkerRecoveryReceiptSchema.Type;
export const parseWorkerRecoveryAction = Schema.decodeUnknownSync(WorkerRecoveryAction);
export const parseWorkerRecoveryReceipt = Schema.decodeUnknownSync(WorkerRecoveryReceiptSchema);
export const encodeWorkerRecoveryFailureEvidenceJson = Schema.encodeSync(WorkerRecoveryFailureEvidence);
export const encodeWorkerRecoveryReceiptJson = Schema.encodeSync(WorkerRecoveryReceiptSchema);

export function workerRecoveryProjection(receipt: WorkerRecoveryReceipt | undefined) {
  if (receipt === undefined) return undefined;
  switch (receipt.state) {
    case "intentRecorded": return "workerRecoveryPending" as const;
    case "preflightConfirmed":
    case "dispatchAttempted": return "workerRecoveryDispatching" as const;
    case "dispatchConfirmed": return "runningWorker" as const;
    case "failed": return "workerRecoveryFailed" as const;
    case "outcomeUnknown": return "workerRecoveryOutcomeUnknown" as const;
  }
}
