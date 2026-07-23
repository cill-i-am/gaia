import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import * as Schema from "effect/Schema";

import { FactoryAgentIdSchema } from "./factory-graph.js";
import { HarnessEnvironmentReceiptArtifactRefV1 } from "./harness-execution.js";
import {
  HarnessInteractionIdSchema,
  HarnessPendingInteractionSchema,
  HarnessProviderIdSchema,
  HarnessQuestionIdSchema,
  HarnessSessionIdSchema,
  type HarnessPendingInteraction,
} from "./harness-session.js";
import { canonicalV1, RunEventSequenceSchema } from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const IdentifierSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(200))
);
const TimestampSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(100))
);
const DigestSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-f0-9]{64}$/u, { identifier: "LowerSha256" })
  )
);

export const RunControlAuthorityIdSchema = IdentifierSchema.pipe(
  Schema.brand("RunControlAuthorityId")
);
export type RunControlAuthorityId = typeof RunControlAuthorityIdSchema.Type;
export const parseRunControlAuthorityId = Schema.decodeUnknownSync(
  RunControlAuthorityIdSchema
);

export const RunControlActionIdSchema = IdentifierSchema.pipe(
  Schema.brand("RunControlActionId")
);
export type RunControlActionId = typeof RunControlActionIdSchema.Type;
export const parseRunControlActionId = Schema.decodeUnknownSync(
  RunControlActionIdSchema
);

export const RunControlCheckpointDigestSchema = DigestSchema.pipe(
  Schema.brand("RunControlCheckpointDigest")
);
export type RunControlCheckpointDigest =
  typeof RunControlCheckpointDigestSchema.Type;
export const RunControlRequestDigestSchema = DigestSchema.pipe(
  Schema.brand("RunControlRequestDigest")
);
export type RunControlRequestDigest = typeof RunControlRequestDigestSchema.Type;
export const RunControlActionBindingDigestSchema = DigestSchema.pipe(
  Schema.brand("RunControlActionBindingDigest")
);
export type RunControlActionBindingDigest =
  typeof RunControlActionBindingDigestSchema.Type;

export const RunControlOperationSchema = Schema.Literals([
  "resolveInteraction",
  "pause",
  "resume",
  "cancel",
] as const);
export type RunControlOperation = typeof RunControlOperationSchema.Type;

export const RunControlRestoreStateSchema = Schema.Literals([
  "runningWorker",
  "waitingForHuman",
] as const);
export type RunControlRestoreState = typeof RunControlRestoreStateSchema.Type;

/** A value-free durable checkpoint proving an intentional human wait. */
export class RunHumanWaitCheckpointV1 extends Schema.Class<RunHumanWaitCheckpointV1>(
  "RunHumanWaitCheckpointV1"
)(
  {
    checkpointDigest: RunControlCheckpointDigestSchema,
    environmentReceipt: HarnessEnvironmentReceiptArtifactRefV1,
    expectedEventSequence: RunEventSequenceSchema,
    expiresAt: Schema.optionalKey(TimestampSchema),
    interactionId: HarnessInteractionIdSchema,
    providerId: HarnessProviderIdSchema,
    requestDigest: RunControlRequestDigestSchema,
    requestedAt: TimestampSchema,
    resolverAuthorityId: RunControlAuthorityIdSchema,
    restoreState: Schema.optionalKey(RunControlRestoreStateSchema),
    runId: RunIdSchema,
    sessionId: HarnessSessionIdSchema,
    version: Schema.Literal(1),
    workerAgentId: FactoryAgentIdSchema,
    workerStartedSequence: RunEventSequenceSchema,
  },
  strict
) {}

export const parseRunHumanWaitCheckpoint = Schema.decodeUnknownSync(
  RunHumanWaitCheckpointV1
);

const RunControlBindingFields = {
  actionBindingDigest: RunControlActionBindingDigestSchema,
  actionId: RunControlActionIdSchema,
  authorityId: RunControlAuthorityIdSchema,
  checkpointDigest: Schema.optionalKey(RunControlCheckpointDigestSchema),
  expectedEventSequence: RunEventSequenceSchema,
  interactionId: Schema.optionalKey(HarnessInteractionIdSchema),
  operation: RunControlOperationSchema,
  providerId: HarnessProviderIdSchema,
  requestDigest: Schema.optionalKey(RunControlRequestDigestSchema),
  restoreState: Schema.optionalKey(RunControlRestoreStateSchema),
  sessionId: HarnessSessionIdSchema,
  workerAgentId: FactoryAgentIdSchema,
  workerStartedSequence: RunEventSequenceSchema,
} as const;

/** Persistable action identity. This binding never represents response equality. */
export class RunControlEventPayload extends Schema.Class<RunControlEventPayload>(
  "RunControlEventPayload"
)(
  {
    ...RunControlBindingFields,
    diagnostic: Schema.optionalKey(
      Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(4_096)))
    ),
    recordedAt: Schema.optionalKey(TimestampSchema),
    resolutionClaimed: Schema.optionalKey(Schema.Literal(true)),
    resolutionIdentityMode: Schema.optionalKey(
      Schema.Literal("singleUseValueOpaque")
    ),
    witness: Schema.optionalKey(IdentifierSchema),
  },
  strict
) {}

export const parseRunControlEventPayload = Schema.decodeUnknownSync(
  RunControlEventPayload
);

const ResolveInteractionPayloadSchema = Schema.Union([
  Schema.Struct({
    decision: Schema.Literals([
      "approve",
      "approveForSession",
      "decline",
      "cancel",
    ] as const),
    kind: Schema.Literal("approval"),
  }),
  Schema.Struct({
    answers: Schema.Array(
      Schema.Struct({
        answers: Schema.Array(Schema.String).pipe(
          Schema.check(Schema.isMaxLength(20))
        ),
        questionId: HarnessQuestionIdSchema,
      })
    ).pipe(Schema.check(Schema.isMaxLength(20))),
    kind: Schema.Literal("userInput"),
  }),
  Schema.Struct({
    action: Schema.Literals(["submit", "decline", "cancel"] as const),
    content: Schema.optionalKey(Schema.String),
    kind: Schema.Literal("mcpElicitation"),
  }),
]);

const RunControlActionBase = {
  actionId: RunControlActionIdSchema,
  authorityId: RunControlAuthorityIdSchema,
  checkpointDigest: Schema.optionalKey(RunControlCheckpointDigestSchema),
  expectedEventSequence: RunEventSequenceSchema,
  interactionId: Schema.optionalKey(HarnessInteractionIdSchema),
  providerId: HarnessProviderIdSchema,
  requestDigest: Schema.optionalKey(RunControlRequestDigestSchema),
  runId: RunIdSchema,
  sessionId: HarnessSessionIdSchema,
  workerAgentId: FactoryAgentIdSchema,
  workerStartedSequence: RunEventSequenceSchema,
} as const;

/** Boundary request. Hidden resolution values are ephemeral and never persisted. */
export const RunControlActionSchema = Schema.Union([
  Schema.Struct({
    ...RunControlActionBase,
    operation: Schema.Literal("resolveInteraction"),
    response: ResolveInteractionPayloadSchema,
  }),
  Schema.Struct({
    ...RunControlActionBase,
    operation: Schema.Literal("pause"),
  }),
  Schema.Struct({
    ...RunControlActionBase,
    operation: Schema.Literal("resume"),
  }),
  Schema.Struct({
    ...RunControlActionBase,
    operation: Schema.Literal("cancel"),
  }),
]);
export type RunControlAction = typeof RunControlActionSchema.Type;
export const parseRunControlAction = Schema.decodeUnknownSync(
  RunControlActionSchema
);

export const RunControlReceiptStateSchema = Schema.Literals([
  "confirmed",
  "failed",
  "outcomeUnknown",
] as const);

/** Value-free result returned after a durable control attempt. */
export class RunControlReceipt extends Schema.Class<RunControlReceipt>(
  "RunControlReceipt"
)(
  {
    actionBindingDigest: RunControlActionBindingDigestSchema,
    actionId: RunControlActionIdSchema,
    duplicate: Schema.Boolean,
    operation: RunControlOperationSchema,
    runId: RunIdSchema,
    state: RunControlReceiptStateSchema,
  },
  strict
) {}

/** Value-free exact binding clients copy into their next control action. */
export class RunControlActionTarget extends Schema.Class<RunControlActionTarget>(
  "RunControlActionTarget"
)(
  {
    authorityId: RunControlAuthorityIdSchema,
    checkpointDigest: Schema.optionalKey(RunControlCheckpointDigestSchema),
    expectedEventSequence: RunEventSequenceSchema,
    interactionId: Schema.optionalKey(HarnessInteractionIdSchema),
    providerId: HarnessProviderIdSchema,
    requestDigest: Schema.optionalKey(RunControlRequestDigestSchema),
    sessionId: HarnessSessionIdSchema,
    workerAgentId: FactoryAgentIdSchema,
    workerStartedSequence: RunEventSequenceSchema,
  },
  strict
) {}

/** Event-derived public read model for one run's durable control state. */
export class RunControlSnapshot extends Schema.Class<RunControlSnapshot>(
  "RunControlSnapshot"
)(
  {
    activeReceipt: Schema.optionalKey(RunControlReceipt),
    actionTarget: Schema.optionalKey(RunControlActionTarget),
    allowedActions: Schema.Array(RunControlOperationSchema).pipe(
      Schema.check(Schema.isMaxLength(4))
    ),
    expired: Schema.Boolean,
    pendingCheckpoint: Schema.optionalKey(RunHumanWaitCheckpointV1),
    runId: RunIdSchema,
    state: Schema.Literals([
      "runningWorker",
      "waitingForHuman",
      "paused",
      "cancelled",
      "completed",
      "failed",
    ] as const),
  },
  strict
) {}

function digest(domain: string, fields: ReadonlyArray<unknown>): string {
  return bytesToHex(sha256(canonicalV1(domain, fields)));
}

/** Digest a value-free checkpoint envelope before adding checkpointDigest. */
export function makeRunControlCheckpointDigest(
  input: Omit<RunHumanWaitCheckpointV1, "checkpointDigest">
): RunControlCheckpointDigest {
  return Schema.decodeUnknownSync(RunControlCheckpointDigestSchema)(
    digest("gaia.run-control-checkpoint.v1", [input])
  );
}

/** Digest only non-secret interaction identity; prompts, options, and values are excluded. */
export function makeRunControlRequestDigest(
  input: HarnessPendingInteraction
): RunControlRequestDigest {
  const interaction = Schema.decodeUnknownSync(HarnessPendingInteractionSchema)(
    input
  );
  const base = {
    interactionId: interaction.interactionId,
    kind: interaction.kind,
    requestedAt: interaction.requestedAt,
    ...(interaction.turnId === undefined ? {} : { turnId: interaction.turnId }),
  };
  const binding = (() => {
    switch (interaction.kind) {
      case "commandApproval":
      case "fileChangeApproval":
        return {
          ...base,
          allowedDecisions: interaction.allowedDecisions,
          itemId: interaction.itemId,
        };
      case "permissionApproval":
        return {
          ...base,
          allowedDecisions: interaction.allowedDecisions,
          fileSystemEntryCount: interaction.scope.fileSystem.length,
          itemId: interaction.itemId,
          network: interaction.scope.network,
        };
      case "userInput":
        return {
          ...base,
          itemId: interaction.itemId,
          questions: interaction.questions.map((question) => ({
            optionCount: question.options.length,
            questionId: question.questionId,
            secret: question.secret,
          })),
        };
      case "mcpElicitation":
        return {
          ...base,
          mode: interaction.mode,
          serverName: interaction.serverName,
        };
    }
  })();
  return Schema.decodeUnknownSync(RunControlRequestDigestSchema)(
    digest("gaia.run-control-request.v1", [binding])
  );
}

const RunControlActionBindingInputSchema = Schema.Struct({
  actionId: RunControlActionIdSchema,
  authorityId: RunControlAuthorityIdSchema,
  checkpointDigest: Schema.optionalKey(RunControlCheckpointDigestSchema),
  expectedEventSequence: RunEventSequenceSchema,
  interactionId: Schema.optionalKey(HarnessInteractionIdSchema),
  operation: RunControlOperationSchema,
  providerId: HarnessProviderIdSchema,
  requestDigest: Schema.optionalKey(RunControlRequestDigestSchema),
  runId: RunIdSchema,
  sessionId: HarnessSessionIdSchema,
  workerAgentId: FactoryAgentIdSchema,
  workerStartedSequence: RunEventSequenceSchema,
});

/** Digest only safe structural binding; never pass a response value here. */
export function makeRunControlActionBindingDigest(
  input: typeof RunControlActionBindingInputSchema.Type
): RunControlActionBindingDigest {
  return Schema.decodeUnknownSync(RunControlActionBindingDigestSchema)(
    digest("gaia.run-control-action-binding.v1", [input])
  );
}
