import { Schema } from "effect";
import {
  HarnessActionIdSchema,
  HarnessCapabilities,
  HarnessInteractionIdSchema,
  HarnessItemSchema,
  HarnessPendingInteractionSchema,
  HarnessQuestionIdSchema,
  HarnessResolvedInteraction,
  HarnessSessionIdSchema,
  HarnessSessionStateSchema,
  HarnessTurnIdSchema,
  HarnessTurnSnapshot,
} from "./harness-session.js";
import { FactoryAgentIdSchema } from "./factory-graph.js";
import { RunIdSchema } from "./run-id.js";

const SequenceSchema = Schema.Number.pipe(
  Schema.check(Schema.isInt({ identifier: "GaiaEventSequence" })),
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
);
const BoundedTextSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(16_384)),
);
const DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
);
const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** Provider-neutral public session projection. Provider identity stays adapter-private. */
export class AgentSessionSnapshotDto extends Schema.Class<AgentSessionSnapshotDto>(
  "AgentSessionSnapshotDto",
)({
  agentId: FactoryAgentIdSchema,
  capabilities: HarnessCapabilities,
  eventSequence: SequenceSchema,
  items: Schema.Array(HarnessItemSchema).pipe(Schema.check(Schema.isMaxLength(2_000))),
  pendingInteractions: Schema.Array(HarnessPendingInteractionSchema).pipe(
    Schema.check(Schema.isMaxLength(1_000)),
  ),
  recovered: Schema.Boolean,
  resolvedInteractions: Schema.Array(HarnessResolvedInteraction).pipe(
    Schema.check(Schema.isMaxLength(1_000)),
  ),
  runId: RunIdSchema,
  sessionId: HarnessSessionIdSchema,
  state: HarnessSessionStateSchema,
  turns: Schema.Array(HarnessTurnSnapshot).pipe(Schema.check(Schema.isMaxLength(1_000))),
}, strict) {}

export class AgentSessionSnapshotSuccessEnvelope extends Schema.Class<AgentSessionSnapshotSuccessEnvelope>(
  "AgentSessionSnapshotSuccessEnvelope",
)({ data: AgentSessionSnapshotDto, status: Schema.Literal("success") }, strict) {}

/** One normalized public update, ordered only by Gaia run sequence. */
export class AgentSessionUpdateDto extends Schema.Class<AgentSessionUpdateDto>(
  "AgentSessionUpdateDto",
)({
  agentId: FactoryAgentIdSchema,
  eventSequence: SequenceSchema,
  runId: RunIdSchema,
  sessionId: HarnessSessionIdSchema,
  snapshot: AgentSessionSnapshotDto,
  terminal: Schema.Boolean,
}, strict) {}

export const AgentSessionSseEventSchema = Schema.Struct({
  data: Schema.fromJsonString(AgentSessionUpdateDto),
  event: Schema.Literal("agent-session-update"),
  id: Schema.String,
});

export const AgentSessionCursorSchema = Schema.optionalKey(SequenceSchema);

const actionBase = {
  actionId: HarnessActionIdSchema,
  sessionId: HarnessSessionIdSchema,
} as const;
export class FollowUpAgentActionRequest extends Schema.Class<FollowUpAgentActionRequest>(
  "FollowUpAgentActionRequest",
)({ ...actionBase, kind: Schema.Literal("followUp"), text: BoundedTextSchema }, strict) {}
export class SteerAgentActionRequest extends Schema.Class<SteerAgentActionRequest>(
  "SteerAgentActionRequest",
)({ ...actionBase, kind: Schema.Literal("steer"), text: BoundedTextSchema, turnId: HarnessTurnIdSchema }, strict) {}
export class InterruptAgentActionRequest extends Schema.Class<InterruptAgentActionRequest>(
  "InterruptAgentActionRequest",
)({ ...actionBase, kind: Schema.Literal("interrupt"), turnId: HarnessTurnIdSchema }, strict) {}
export class ApprovalAgentActionRequest extends Schema.Class<ApprovalAgentActionRequest>(
  "ApprovalAgentActionRequest",
)({ ...actionBase, decision: Schema.Literals(["approve", "approveForSession", "decline", "cancel"] as const), interactionId: HarnessInteractionIdSchema, kind: Schema.Literal("approval") }, strict) {}
export class UserInputAgentActionRequest extends Schema.Class<UserInputAgentActionRequest>(
  "UserInputAgentActionRequest",
)({
  ...actionBase,
  answers: Schema.Array(Schema.Struct({ answers: Schema.Array(BoundedTextSchema).pipe(Schema.check(Schema.isMaxLength(20))), questionId: HarnessQuestionIdSchema })).pipe(Schema.check(Schema.isMaxLength(20))),
  interactionId: HarnessInteractionIdSchema,
  kind: Schema.Literal("userInput"),
}, strict) {}
export class McpElicitationAgentActionRequest extends Schema.Class<McpElicitationAgentActionRequest>(
  "McpElicitationAgentActionRequest",
)({ ...actionBase, action: Schema.Literals(["submit", "decline", "cancel"] as const), content: Schema.optionalKey(BoundedTextSchema), interactionId: HarnessInteractionIdSchema, kind: Schema.Literal("mcpElicitation") }, strict) {}

export const AgentOperatorActionRequestSchema = Schema.Union([
  FollowUpAgentActionRequest,
  SteerAgentActionRequest,
  InterruptAgentActionRequest,
  ApprovalAgentActionRequest,
  UserInputAgentActionRequest,
  McpElicitationAgentActionRequest,
]);
export type AgentOperatorActionRequest = typeof AgentOperatorActionRequestSchema.Type;

export const AgentActionStateSchema = Schema.Literals([
  "intentRecorded", "dispatchAttempted", "dispatchConfirmed", "dispatchFailed", "outcomeUnknown",
] as const);
export type AgentActionState = typeof AgentActionStateSchema.Type;

export class AgentActionReceiptDto extends Schema.Class<AgentActionReceiptDto>(
  "AgentActionReceiptDto",
)({
  actionId: HarnessActionIdSchema,
  agentId: FactoryAgentIdSchema,
  eventSequence: SequenceSchema,
  payloadDigest: DigestSchema,
  runId: RunIdSchema,
  sessionId: HarnessSessionIdSchema,
  state: AgentActionStateSchema,
}, strict) {}

export class AgentActionSuccessEnvelope extends Schema.Class<AgentActionSuccessEnvelope>(
  "AgentActionSuccessEnvelope",
)({ data: AgentActionReceiptDto, status: Schema.Literal("success") }, strict) {}
