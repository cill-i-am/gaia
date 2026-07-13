import { Schema } from "effect";

import { HarnessProfileIdSchema } from "./harness-execution.js";
import { HarnessSessionIdSchema } from "./harness-session.js";
import { RunIdSchema } from "./run-id.js";

const ActionId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(200))
);
const ModelId = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/u)),
  Schema.check(Schema.isMaxLength(120))
);
const Sequence = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1))
);
const Digest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
);

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
export class WorkerRecoveryFailureEvidence extends Schema.Class<WorkerRecoveryFailureEvidence>(
  "WorkerRecoveryFailureEvidence"
)(
  {
    actionId: ActionId,
    code: WorkerRecoveryFailureCodeSchema,
    runId: RunIdSchema,
    stage: WorkerRecoveryFailureStageSchema,
    status: Schema.Literals([409, 422, 500] as const),
    timestamp: Schema.String.pipe(
      Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/u))
    ),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class WorkerRecoveryAction extends Schema.Class<WorkerRecoveryAction>(
  "WorkerRecoveryAction"
)(
  {
    actionId: ActionId,
    expectedFailureSequence: Sequence,
    expectedSessionId: HarnessSessionIdSchema,
    harnessProfileId: HarnessProfileIdSchema,
    kind: Schema.Literal("retryRecoverableWorkerFailure"),
    model: ModelId,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class WorkerContinuationAction extends Schema.Class<WorkerContinuationAction>(
  "WorkerContinuationAction"
)(
  {
    actionId: ActionId,
    expectedContaminatedReadySequence: Sequence,
    expectedCurrentSequence: Sequence,
    expectedDeliveryProvenanceDigest: Digest,
    expectedFailedRecoverySequence: Sequence,
    expectedRecoveryActionId: ActionId,
    expectedSessionId: HarnessSessionIdSchema,
    harnessProfileId: HarnessProfileIdSchema,
    kind: Schema.Literal("continueInterruptedWorkerRecovery"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class WorkerCorrelationReconciliationAction extends Schema.Class<WorkerCorrelationReconciliationAction>(
  "WorkerCorrelationReconciliationAction"
)(
  {
    actionId: ActionId,
    expectedContaminatedReadySequence: Sequence,
    expectedContinuationActionId: ActionId,
    expectedCurrentSequence: Sequence,
    expectedDeliveryProvenanceDigest: Digest,
    expectedFailedContinuationSequence: Sequence,
    expectedFailedRecoverySequence: Sequence,
    expectedNativeTurnIdDigest: Digest,
    expectedRecoveryActionId: ActionId,
    expectedSessionId: HarnessSessionIdSchema,
    harnessProfileId: HarnessProfileIdSchema,
    kind: Schema.Literal("reconcileInterruptedWorkerCorrelation"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class WorkerDesktopOriginCorrelationAction extends Schema.Class<WorkerDesktopOriginCorrelationAction>(
  "WorkerDesktopOriginCorrelationAction"
)(
  {
    actionId: ActionId,
    expectedContaminatedReadySequence: Sequence,
    expectedContinuationActionId: ActionId,
    expectedCorrelationActionId: ActionId,
    expectedCurrentSequence: Sequence,
    expectedDeliveryProvenanceDigest: Digest,
    expectedFailedContinuationSequence: Sequence,
    expectedFailedCorrelationSequence: Sequence,
    expectedFailedRecoverySequence: Sequence,
    expectedNativeTurnIdDigest: Digest,
    expectedRecoveryActionId: ActionId,
    expectedSessionId: HarnessSessionIdSchema,
    harnessProfileId: HarnessProfileIdSchema,
    kind: Schema.Literal("reconcileDesktopOriginatedWorkerCorrelation"),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

const Base = {
  actionId: ActionId,
  attempt: Schema.Literal(1),
  expectedFailureSequence: Sequence,
  expectedSessionId: HarnessSessionIdSchema,
  harnessProfileId: HarnessProfileIdSchema,
  maxAttempts: Schema.Literal(1),
  model: ModelId,
  payloadDigest: Digest,
  trackedPayloadDigest: Schema.optionalKey(Digest),
  trackedPayloadEntryCount: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))
  ),
} as const;

export const WorkerRecoveryReceiptSchema = Schema.Union([
  Schema.Struct({ ...Base, state: Schema.Literal("intentRecorded") }),
  Schema.Struct({ ...Base, state: Schema.Literal("preflightConfirmed") }),
  Schema.Struct({ ...Base, state: Schema.Literal("dispatchAttempted") }),
  Schema.Struct({
    ...Base,
    nativeTurnIdDigest: Digest,
    state: Schema.Literal("dispatchConfirmed"),
  }),
  Schema.Struct({
    ...Base,
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    nativeTurnIdDigest: Schema.optionalKey(Digest),
    state: Schema.Literal("failed"),
  }),
  Schema.Struct({
    ...Base,
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    state: Schema.Literal("outcomeUnknown"),
  }),
]);
export type WorkerRecoveryReceipt = typeof WorkerRecoveryReceiptSchema.Type;

const ContinuationBase = {
  actionId: ActionId,
  expectedContaminatedReadySequence: Sequence,
  expectedCurrentSequence: Sequence,
  expectedDeliveryProvenanceDigest: Digest,
  expectedFailedRecoverySequence: Sequence,
  expectedRecoveryActionId: ActionId,
  expectedSessionId: HarnessSessionIdSchema,
  harnessProfileId: HarnessProfileIdSchema,
  maxAttempts: Schema.Literal(1),
  workerEvidenceEpochSequence: Sequence,
} as const;

export const WorkerContinuationReceiptSchema = Schema.Union([
  Schema.Struct({
    ...ContinuationBase,
    state: Schema.Literal("intentRecorded"),
  }),
  Schema.Struct({
    ...ContinuationBase,
    state: Schema.Literal("resumeAttempted"),
  }),
  Schema.Struct({
    ...ContinuationBase,
    state: Schema.Literal("resumeConfirmed"),
  }),
  Schema.Struct({
    ...ContinuationBase,
    state: Schema.Literal("followUpAttempted"),
  }),
  Schema.Struct({
    ...ContinuationBase,
    state: Schema.Literal("followUpConfirmed"),
  }),
  Schema.Struct({
    ...ContinuationBase,
    state: Schema.Literal("workerCompleted"),
  }),
  Schema.Struct({
    ...ContinuationBase,
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    state: Schema.Literal("failed"),
  }),
  Schema.Struct({
    ...ContinuationBase,
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    state: Schema.Literal("outcomeUnknown"),
  }),
]);
export type WorkerContinuationReceipt =
  typeof WorkerContinuationReceiptSchema.Type;

const CorrelationBase = {
  actionId: ActionId,
  expectedContaminatedReadySequence: Sequence,
  expectedContinuationActionId: ActionId,
  expectedCurrentSequence: Sequence,
  expectedDeliveryProvenanceDigest: Digest,
  expectedFailedContinuationSequence: Sequence,
  expectedFailedRecoverySequence: Sequence,
  expectedNativeTurnIdDigest: Digest,
  expectedRecoveryActionId: ActionId,
  expectedSessionId: HarnessSessionIdSchema,
  harnessProfileId: HarnessProfileIdSchema,
  maxAttempts: Schema.Literal(1),
  workerEvidenceEpochSequence: Sequence,
} as const;

export const WorkerCorrelationReconciliationReceiptSchema = Schema.Union([
  Schema.Struct({
    ...CorrelationBase,
    state: Schema.Literal("intentRecorded"),
  }),
  Schema.Struct({
    ...CorrelationBase,
    state: Schema.Literal("correlationAttempted"),
  }),
  Schema.Struct({
    ...CorrelationBase,
    state: Schema.Literal("correlationConfirmed"),
  }),
  Schema.Struct({
    ...CorrelationBase,
    state: Schema.Literal("followUpAttempted"),
  }),
  Schema.Struct({
    ...CorrelationBase,
    state: Schema.Literal("followUpConfirmed"),
  }),
  Schema.Struct({
    ...CorrelationBase,
    state: Schema.Literal("workerCompleted"),
  }),
  Schema.Struct({
    ...CorrelationBase,
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    state: Schema.Literal("failed"),
  }),
  Schema.Struct({
    ...CorrelationBase,
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    state: Schema.Literal("outcomeUnknown"),
  }),
]);
export type WorkerCorrelationReconciliationReceipt =
  typeof WorkerCorrelationReconciliationReceiptSchema.Type;

const DesktopOriginCorrelationBase = {
  actionId: ActionId,
  expectedContaminatedReadySequence: Sequence,
  expectedContinuationActionId: ActionId,
  expectedCorrelationActionId: ActionId,
  expectedCurrentSequence: Sequence,
  expectedDeliveryProvenanceDigest: Digest,
  expectedFailedContinuationSequence: Sequence,
  expectedFailedCorrelationSequence: Sequence,
  expectedFailedRecoverySequence: Sequence,
  expectedNativeTurnIdDigest: Digest,
  expectedRecoveryActionId: ActionId,
  expectedSessionId: HarnessSessionIdSchema,
  harnessProfileId: HarnessProfileIdSchema,
  maxAttempts: Schema.Literal(1),
  workerEvidenceEpochSequence: Sequence,
} as const;

export const WorkerDesktopOriginCorrelationReceiptSchema = Schema.Union([
  Schema.Struct({
    ...DesktopOriginCorrelationBase,
    state: Schema.Literal("intentRecorded"),
  }),
  Schema.Struct({
    ...DesktopOriginCorrelationBase,
    state: Schema.Literal("sourceCorrelationAttempted"),
  }),
  Schema.Struct({
    ...DesktopOriginCorrelationBase,
    state: Schema.Literal("sourceCorrelationConfirmed"),
  }),
  Schema.Struct({
    ...DesktopOriginCorrelationBase,
    state: Schema.Literal("followUpAttempted"),
  }),
  Schema.Struct({
    ...DesktopOriginCorrelationBase,
    state: Schema.Literal("followUpConfirmed"),
  }),
  Schema.Struct({
    ...DesktopOriginCorrelationBase,
    state: Schema.Literal("workerCompleted"),
  }),
  Schema.Struct({
    ...DesktopOriginCorrelationBase,
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    state: Schema.Literal("failed"),
  }),
  Schema.Struct({
    ...DesktopOriginCorrelationBase,
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(1024))),
    state: Schema.Literal("outcomeUnknown"),
  }),
]);
export type WorkerDesktopOriginCorrelationReceipt =
  typeof WorkerDesktopOriginCorrelationReceiptSchema.Type;

export const parseWorkerRecoveryAction =
  Schema.decodeUnknownSync(WorkerRecoveryAction);
export const parseWorkerRecoveryReceipt = Schema.decodeUnknownSync(
  WorkerRecoveryReceiptSchema
);
export const parseWorkerContinuationAction = Schema.decodeUnknownSync(
  WorkerContinuationAction
);
export const parseWorkerContinuationReceipt = Schema.decodeUnknownSync(
  WorkerContinuationReceiptSchema
);
export const parseWorkerCorrelationReconciliationAction =
  Schema.decodeUnknownSync(WorkerCorrelationReconciliationAction);
export const parseWorkerCorrelationReconciliationReceipt =
  Schema.decodeUnknownSync(WorkerCorrelationReconciliationReceiptSchema);
export const parseWorkerDesktopOriginCorrelationAction =
  Schema.decodeUnknownSync(WorkerDesktopOriginCorrelationAction);
export const parseWorkerDesktopOriginCorrelationReceipt =
  Schema.decodeUnknownSync(WorkerDesktopOriginCorrelationReceiptSchema);
export const encodeWorkerRecoveryFailureEvidenceJson = Schema.encodeSync(
  WorkerRecoveryFailureEvidence
);
export const encodeWorkerRecoveryReceiptJson = Schema.encodeSync(
  WorkerRecoveryReceiptSchema
);
export const encodeWorkerContinuationReceiptJson = Schema.encodeSync(
  WorkerContinuationReceiptSchema
);
export const encodeWorkerCorrelationReconciliationReceiptJson =
  Schema.encodeSync(WorkerCorrelationReconciliationReceiptSchema);
export const encodeWorkerDesktopOriginCorrelationReceiptJson =
  Schema.encodeSync(WorkerDesktopOriginCorrelationReceiptSchema);

export function workerRecoveryProjection(
  receipt: WorkerRecoveryReceipt | undefined
) {
  if (receipt === undefined) return undefined;
  switch (receipt.state) {
    case "intentRecorded":
      return "workerRecoveryPending" as const;
    case "preflightConfirmed":
    case "dispatchAttempted":
      return "workerRecoveryDispatching" as const;
    case "dispatchConfirmed":
      return "runningWorker" as const;
    case "failed":
      return "workerRecoveryFailed" as const;
    case "outcomeUnknown":
      return "workerRecoveryOutcomeUnknown" as const;
  }
}

export function workerContinuationProjection(
  receipt: WorkerContinuationReceipt | undefined
) {
  if (receipt === undefined) return undefined;
  switch (receipt.state) {
    case "intentRecorded":
      return "workerContinuationPending" as const;
    case "resumeAttempted":
    case "resumeConfirmed":
    case "followUpAttempted":
    case "followUpConfirmed":
      return "workerContinuationRunning" as const;
    case "workerCompleted":
      return undefined;
    case "failed":
      return "workerContinuationFailed" as const;
    case "outcomeUnknown":
      return "workerContinuationOutcomeUnknown" as const;
  }
}

export function workerCorrelationReconciliationProjection(
  receipt: WorkerCorrelationReconciliationReceipt | undefined
) {
  if (receipt === undefined) return undefined;
  switch (receipt.state) {
    case "intentRecorded":
      return "workerCorrelationPending" as const;
    case "correlationAttempted":
    case "correlationConfirmed":
    case "followUpAttempted":
    case "followUpConfirmed":
      return "workerCorrelationRunning" as const;
    case "workerCompleted":
      return undefined;
    case "failed":
      return "workerCorrelationFailed" as const;
    case "outcomeUnknown":
      return "workerCorrelationOutcomeUnknown" as const;
  }
}

export function workerDesktopOriginCorrelationProjection(
  receipt: WorkerDesktopOriginCorrelationReceipt | undefined
) {
  if (receipt === undefined) return undefined;
  switch (receipt.state) {
    case "intentRecorded":
      return "workerCorrelationPending" as const;
    case "sourceCorrelationAttempted":
    case "sourceCorrelationConfirmed":
    case "followUpAttempted":
    case "followUpConfirmed":
      return "workerCorrelationRunning" as const;
    case "workerCompleted":
      return undefined;
    case "failed":
      return "workerCorrelationFailed" as const;
    case "outcomeUnknown":
      return "workerCorrelationOutcomeUnknown" as const;
  }
}
