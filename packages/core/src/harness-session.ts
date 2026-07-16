import * as Schema from "effect/Schema";

import { makeRunEvent, RunEvent } from "./events.js";

const IdTextSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(200))
);
const BoundedTextSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(16_384))
);
const BoundedOutputSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(65_536))
);
const BoundedDiffSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(131_072))
);
const NonNegativeIntegerSchema = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ identifier: "NonNegativeInteger" }),
    Schema.isGreaterThanOrEqualTo(0)
  )
);

/** Stable Gaia identifier for a harness provider implementation. */
export const HarnessProviderIdSchema = IdTextSchema.pipe(
  Schema.brand("HarnessProviderId")
);
/** Stable Gaia identifier for one harness provider implementation. */
export type HarnessProviderId = typeof HarnessProviderIdSchema.Type;
/** Parse a harness provider identifier at a boundary. */
export const parseHarnessProviderId = Schema.decodeUnknownSync(
  HarnessProviderIdSchema
);

/** Stable Gaia identifier for an interactive harness session. */
export const HarnessSessionIdSchema = IdTextSchema.pipe(
  Schema.brand("HarnessSessionId")
);
/** Stable Gaia identifier for one interactive harness session. */
export type HarnessSessionId = typeof HarnessSessionIdSchema.Type;
/** Parse a harness session identifier at a boundary. */
export const parseHarnessSessionId = Schema.decodeUnknownSync(
  HarnessSessionIdSchema
);

/** Stable Gaia identifier for a provider-neutral turn. */
export const HarnessTurnIdSchema = IdTextSchema.pipe(
  Schema.brand("HarnessTurnId")
);
/** Stable Gaia identifier for one provider-neutral turn. */
export type HarnessTurnId = typeof HarnessTurnIdSchema.Type;
/** Parse a harness turn identifier at a boundary. */
export const parseHarnessTurnId = Schema.decodeUnknownSync(HarnessTurnIdSchema);

/** Stable Gaia identifier for an operator-safe session item. */
export const HarnessItemIdSchema = IdTextSchema.pipe(
  Schema.brand("HarnessItemId")
);
/** Stable Gaia identifier for one operator-safe session item. */
export type HarnessItemId = typeof HarnessItemIdSchema.Type;
/** Parse a harness item identifier at a boundary. */
export const parseHarnessItemId = Schema.decodeUnknownSync(HarnessItemIdSchema);

/** Stable Gaia identifier for a pending operator interaction. */
export const HarnessInteractionIdSchema = IdTextSchema.pipe(
  Schema.brand("HarnessInteractionId")
);
/** Stable Gaia identifier for one pending operator interaction. */
export type HarnessInteractionId = typeof HarnessInteractionIdSchema.Type;
/** Parse a harness interaction identifier at a boundary. */
export const parseHarnessInteractionId = Schema.decodeUnknownSync(
  HarnessInteractionIdSchema
);

/** Stable Gaia identifier for one operator question within an interaction. */
export const HarnessQuestionIdSchema = IdTextSchema.pipe(
  Schema.brand("HarnessQuestionId")
);
/** Stable Gaia identifier for one operator question. */
export type HarnessQuestionId = typeof HarnessQuestionIdSchema.Type;
/** Parse a harness question identifier at a boundary. */
export const parseHarnessQuestionId = Schema.decodeUnknownSync(
  HarnessQuestionIdSchema
);

/** Stable Gaia identifier for an operator action. */
export const HarnessActionIdSchema = IdTextSchema.pipe(
  Schema.brand("HarnessActionId")
);
/** Stable Gaia identifier for one operator action. */
export type HarnessActionId = typeof HarnessActionIdSchema.Type;
/** Parse a harness action identifier at a boundary. */
export const parseHarnessActionId = Schema.decodeUnknownSync(
  HarnessActionIdSchema
);

/** A workspace-relative path that cannot escape through traversal or platform roots. */
export const WorkspaceRelativePathSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(4_096),
    Schema.isPattern(
      /^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?:\.|.+)$/,
      { identifier: "WorkspaceRelativePath" }
    )
  ),
  Schema.brand("WorkspaceRelativePath")
);
/** A parsed path relative to the accepted run workspace. */
export type WorkspaceRelativePath = typeof WorkspaceRelativePathSchema.Type;
/** Parse a public workspace-relative path. */
export const parseWorkspaceRelativePath = Schema.decodeUnknownSync(
  WorkspaceRelativePathSchema
);

/** Finite operator interaction categories supported by harnesses. */
export const HarnessInteractionKindSchema = Schema.Literals([
  "command",
  "fileChange",
  "permission",
  "userInput",
  "mcpElicitation",
] as const);
/** An operator interaction category. */
export type HarnessInteractionKind = typeof HarnessInteractionKindSchema.Type;

/** Finite provider capability vocabulary used during assignment checks. */
export const HarnessCapabilitySchema = Schema.Literals([
  "streamingMessages",
  "resumableSessions",
  "toolEvents",
  "fileChangeEvents",
  "userQuestions",
  "steering",
  "interruption",
  "review",
  "subagents",
  "structuredOutput",
  "usageReporting",
  "approval:command",
  "approval:fileChange",
  "approval:permission",
  "approval:userInput",
  "approval:mcpElicitation",
] as const);
/** A single harness capability requirement. */
export type HarnessCapability = typeof HarnessCapabilitySchema.Type;

/** Serializable, explicit capabilities advertised by a harness provider. */
export class HarnessCapabilities extends Schema.Class<HarnessCapabilities>(
  "HarnessCapabilities"
)({
  approvals: Schema.Array(HarnessInteractionKindSchema).pipe(
    Schema.check(Schema.isMaxLength(5))
  ),
  fileChangeEvents: Schema.Boolean,
  interruption: Schema.Boolean,
  resumableSessions: Schema.Boolean,
  review: Schema.Boolean,
  steering: Schema.Boolean,
  streamingMessages: Schema.Boolean,
  structuredOutput: Schema.Boolean,
  subagents: Schema.Boolean,
  toolEvents: Schema.Boolean,
  usageReporting: Schema.Boolean,
  userQuestions: Schema.Boolean,
}) {}

/** Stable provider metadata that is safe to persist with a run. */
export class HarnessProviderDescriptor extends Schema.Class<HarnessProviderDescriptor>(
  "HarnessProviderDescriptor"
)({
  displayName: Schema.NonEmptyString.pipe(
    Schema.check(Schema.isMaxLength(200))
  ),
  executionModes: Schema.Array(
    Schema.Literals(["local", "remote"] as const)
  ).pipe(Schema.check(Schema.isMaxLength(2))),
  providerId: HarnessProviderIdSchema,
}) {}

export const HarnessAuthStateSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("authenticated") }),
  Schema.Struct({ state: Schema.Literal("notRequired") }),
  Schema.Struct({ state: Schema.Literal("authenticationRequired") }),
  Schema.Struct({ state: Schema.Literal("unknown") }),
]);

/** Authentication state without credentials or environment material. */
export type HarnessAuthState = typeof HarnessAuthStateSchema.Type;

/** Finite result of a bounded harness detection and compatibility probe. */
export const HarnessDetectionSchema = Schema.Union([
  Schema.Struct({
    auth: Schema.Union([
      Schema.Struct({ state: Schema.Literal("authenticated") }),
      Schema.Struct({ state: Schema.Literal("notRequired") }),
      Schema.Struct({ state: Schema.Literal("unknown") }),
    ]),
    capabilities: HarnessCapabilities,
    state: Schema.Literal("available"),
    version: IdTextSchema,
  }),
  Schema.Struct({ state: Schema.Literal("missing") }),
  Schema.Struct({
    reason: BoundedTextSchema,
    state: Schema.Literal("incompatible"),
    version: IdTextSchema,
  }),
  Schema.Struct({
    state: Schema.Literal("authenticationRequired"),
    version: IdTextSchema,
  }),
]);
/** Result of a provider detection probe. */
export type HarnessDetection = typeof HarnessDetectionSchema.Type;

/** Finite lifecycle states exposed by every interactive harness session. */
export const HarnessSessionStateSchema = Schema.Literals([
  "connecting",
  "idle",
  "running",
  "waitingForOperator",
  "interrupted",
  "failed",
  "completed",
  "unavailable",
] as const);
/** Current provider-neutral session lifecycle state. */
export type HarnessSessionState = typeof HarnessSessionStateSchema.Type;
const HarnessNonFailureSessionStateSchema = Schema.Literals([
  "connecting",
  "idle",
  "running",
  "waitingForOperator",
  "interrupted",
  "completed",
  "unavailable",
] as const);

/** Finite lifecycle states exposed by provider-neutral turns. */
export const HarnessTurnStatusSchema = Schema.Literals([
  "running",
  "waitingForOperator",
  "interrupted",
  "failed",
  "completed",
] as const);
/** Current provider-neutral turn lifecycle state. */
export type HarnessTurnStatus = typeof HarnessTurnStatusSchema.Type;
const HarnessTerminalTurnStatusSchema = Schema.Literals([
  "interrupted",
  "failed",
  "completed",
] as const);

const MessageItemSchema = Schema.Struct({
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("message"),
  phase: Schema.Literals(["commentary", "final", "unknown"] as const),
  status: Schema.Literals(["streaming", "completed"] as const),
  text: BoundedOutputSchema,
  turnId: HarnessTurnIdSchema,
});
const PlanStepSchema = Schema.Struct({
  status: Schema.Literals(["pending", "inProgress", "completed"] as const),
  step: BoundedTextSchema,
});
const PlanItemSchema = Schema.Struct({
  explanation: Schema.optionalKey(BoundedTextSchema),
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("plan"),
  status: Schema.Literals(["streaming", "completed"] as const),
  steps: Schema.Array(PlanStepSchema).pipe(
    Schema.check(Schema.isMaxLength(100))
  ),
  turnId: HarnessTurnIdSchema,
});
const CommandItemSchema = Schema.Struct({
  command: BoundedTextSchema,
  durationMs: Schema.optionalKey(Schema.Number),
  exitCode: Schema.optionalKey(Schema.Number),
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("command"),
  output: Schema.optionalKey(BoundedOutputSchema),
  status: Schema.Literals([
    "running",
    "completed",
    "failed",
    "declined",
  ] as const),
  turnId: HarnessTurnIdSchema,
  workspacePath: WorkspaceRelativePathSchema,
});
const FileChangeSchema = Schema.Struct({
  diff: BoundedDiffSchema,
  kind: Schema.Literals(["add", "delete", "update", "unknown"] as const),
  path: WorkspaceRelativePathSchema,
});
const FileChangeItemSchema = Schema.Struct({
  changes: Schema.Array(FileChangeSchema).pipe(
    Schema.check(Schema.isMaxLength(200))
  ),
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("fileChange"),
  status: Schema.Literals([
    "running",
    "completed",
    "failed",
    "declined",
  ] as const),
  turnId: HarnessTurnIdSchema,
});
const ToolCallItemSchema = Schema.Struct({
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("toolCall"),
  serverName: Schema.optionalKey(IdTextSchema),
  status: Schema.Literals(["running", "completed", "failed"] as const),
  summary: Schema.optionalKey(BoundedTextSchema),
  toolName: IdTextSchema,
  turnId: HarnessTurnIdSchema,
});
const ReviewItemSchema = Schema.Struct({
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("review"),
  status: Schema.Literals(["entered", "completed"] as const),
  summary: BoundedOutputSchema,
  turnId: HarnessTurnIdSchema,
});
const WarningItemSchema = Schema.Struct({
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("warning"),
  message: BoundedTextSchema,
  turnId: Schema.optionalKey(HarnessTurnIdSchema),
});
const UsageItemSchema = Schema.Struct({
  cachedInputTokens: Schema.optionalKey(NonNegativeIntegerSchema),
  inputTokens: NonNegativeIntegerSchema,
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("usage"),
  outputTokens: NonNegativeIntegerSchema,
  turnId: Schema.optionalKey(HarnessTurnIdSchema),
});

/** Finite allowlisted item union safe for operator-facing projections. */
export const HarnessItemSchema = Schema.Union([
  MessageItemSchema,
  PlanItemSchema,
  CommandItemSchema,
  FileChangeItemSchema,
  ToolCallItemSchema,
  ReviewItemSchema,
  WarningItemSchema,
  UsageItemSchema,
]);
/** An operator-safe provider-neutral session item. */
export type HarnessItem = typeof HarnessItemSchema.Type;

const ApprovalDecisionSchema = Schema.Literals([
  "approve",
  "approveForSession",
  "decline",
  "cancel",
] as const);
const CommandApprovalSchema = Schema.Struct({
  allowedDecisions: Schema.Array(ApprovalDecisionSchema).pipe(
    Schema.check(Schema.isMaxLength(4))
  ),
  command: BoundedTextSchema,
  interactionId: HarnessInteractionIdSchema,
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("commandApproval"),
  reason: Schema.optionalKey(BoundedTextSchema),
  requestedAt: IdTextSchema,
  turnId: HarnessTurnIdSchema,
  workspacePath: WorkspaceRelativePathSchema,
});
const FileChangeApprovalSchema = Schema.Struct({
  allowedDecisions: Schema.Array(ApprovalDecisionSchema).pipe(
    Schema.check(Schema.isMaxLength(4))
  ),
  interactionId: HarnessInteractionIdSchema,
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("fileChangeApproval"),
  paths: Schema.Array(WorkspaceRelativePathSchema).pipe(
    Schema.check(Schema.isMaxLength(200))
  ),
  reason: Schema.optionalKey(BoundedTextSchema),
  requestedAt: IdTextSchema,
  turnId: HarnessTurnIdSchema,
});
const HarnessPermissionAccessSchema = Schema.Literals([
  "read",
  "write",
  "deny",
] as const);
const HarnessPermissionPathSchema = Schema.Struct({
  access: HarnessPermissionAccessSchema,
  path: WorkspaceRelativePathSchema,
});
/** Finite audited permission scope shown to an operator before approval. */
export const HarnessPermissionScopeSchema = Schema.Struct({
  fileSystem: Schema.Array(HarnessPermissionPathSchema).pipe(
    Schema.check(Schema.isMaxLength(200))
  ),
  network: Schema.Literals([
    "notRequested",
    "enabled",
    "disabled",
    "unspecified",
  ] as const),
});
/** A finite audited permission scope safe for public projection. */
export type HarnessPermissionScope = typeof HarnessPermissionScopeSchema.Type;
const PermissionApprovalSchema = Schema.Struct({
  allowedDecisions: Schema.Array(ApprovalDecisionSchema).pipe(
    Schema.check(Schema.isMaxLength(4))
  ),
  interactionId: HarnessInteractionIdSchema,
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("permissionApproval"),
  requestedAt: IdTextSchema,
  scope: HarnessPermissionScopeSchema,
  summary: BoundedTextSchema,
  turnId: HarnessTurnIdSchema,
});
const UserInputQuestionSchema = Schema.Struct({
  options: Schema.Array(BoundedTextSchema).pipe(
    Schema.check(Schema.isMaxLength(20))
  ),
  prompt: BoundedTextSchema,
  questionId: HarnessQuestionIdSchema,
  secret: Schema.Boolean,
});
const UserInputInteractionSchema = Schema.Struct({
  interactionId: HarnessInteractionIdSchema,
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("userInput"),
  questions: Schema.Array(UserInputQuestionSchema).pipe(
    Schema.check(Schema.isMaxLength(20))
  ),
  requestedAt: IdTextSchema,
  turnId: HarnessTurnIdSchema,
});
const McpElicitationSchema = Schema.Struct({
  interactionId: HarnessInteractionIdSchema,
  kind: Schema.Literal("mcpElicitation"),
  message: BoundedTextSchema,
  mode: Schema.Literals(["form", "url"] as const),
  requestedAt: IdTextSchema,
  serverName: IdTextSchema,
  turnId: Schema.optionalKey(HarnessTurnIdSchema),
});

/** Finite allowlisted pending-interaction union. */
export const HarnessPendingInteractionSchema = Schema.Union([
  CommandApprovalSchema,
  FileChangeApprovalSchema,
  PermissionApprovalSchema,
  UserInputInteractionSchema,
  McpElicitationSchema,
]);
/** An unresolved operator interaction. */
export type HarnessPendingInteraction =
  typeof HarnessPendingInteractionSchema.Type;

/** Audited resolution of one pending interaction. */
export const HarnessInteractionResolutionSchema = Schema.Union([
  Schema.Struct({
    actionId: HarnessActionIdSchema,
    decision: ApprovalDecisionSchema,
    interactionId: HarnessInteractionIdSchema,
    kind: Schema.Literal("approval"),
    resolvedAt: IdTextSchema,
  }),
  Schema.Struct({
    actionId: HarnessActionIdSchema,
    decision: Schema.Literal("submit"),
    interactionId: HarnessInteractionIdSchema,
    kind: Schema.Literal("userInput"),
    resolvedAt: IdTextSchema,
  }),
  Schema.Struct({
    actionId: HarnessActionIdSchema,
    decision: Schema.Literals(["submit", "decline", "cancel"] as const),
    interactionId: HarnessInteractionIdSchema,
    kind: Schema.Literal("mcpElicitation"),
    resolvedAt: IdTextSchema,
  }),
]);
/** An audited operator resolution. */
export type HarnessInteractionResolution =
  typeof HarnessInteractionResolutionSchema.Type;

/** A resolved interaction retains the safe request and audited response. */
export class HarnessResolvedInteraction extends Schema.Class<HarnessResolvedInteraction>(
  "HarnessResolvedInteraction"
)({
  request: HarnessPendingInteractionSchema,
  resolution: HarnessInteractionResolutionSchema,
}) {}

/** Finite operator action union accepted by the harness-session SPI. */
export const HarnessOperatorActionSchema = Schema.Union([
  Schema.Struct({
    actionId: HarnessActionIdSchema,
    kind: Schema.Literal("followUp"),
    sessionId: HarnessSessionIdSchema,
    text: BoundedTextSchema,
  }),
  Schema.Struct({
    actionId: HarnessActionIdSchema,
    kind: Schema.Literal("steer"),
    sessionId: HarnessSessionIdSchema,
    text: BoundedTextSchema,
    turnId: HarnessTurnIdSchema,
  }),
  Schema.Struct({
    actionId: HarnessActionIdSchema,
    kind: Schema.Literal("interrupt"),
    sessionId: HarnessSessionIdSchema,
    turnId: HarnessTurnIdSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("resolveInteraction"),
    resolution: HarnessInteractionResolutionSchema,
    sessionId: HarnessSessionIdSchema,
  }),
]);
/** An operator action routed to a harness session. */
export type HarnessOperatorAction = typeof HarnessOperatorActionSchema.Type;

/** Finite provider-neutral failure union safe for persistence and display. */
export const HarnessFailureSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    message: BoundedTextSchema,
    recoverable: Schema.Boolean,
  }),
  Schema.Struct({
    actualVersion: IdTextSchema,
    kind: Schema.Literal("incompatible"),
    message: BoundedTextSchema,
    supportedVersion: IdTextSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("capabilityMismatch"),
    missing: Schema.Array(HarnessCapabilitySchema).pipe(
      Schema.check(Schema.isMaxLength(15))
    ),
    providerId: HarnessProviderIdSchema,
  }),
  Schema.Struct({
    code: IdTextSchema,
    kind: Schema.Literal("providerFailure"),
    message: BoundedTextSchema,
    recoverable: Schema.Boolean,
  }),
]);
/** A typed provider-neutral session failure. */
export type HarnessFailure = typeof HarnessFailureSchema.Type;

const HarnessSessionEventBaseSchema = Schema.Struct({
  sessionId: HarnessSessionIdSchema,
});
const HarnessOperatorActionEventBaseSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  actionId: HarnessActionIdSchema,
  actionKind: Schema.Literals([
    "followUp",
    "steer",
    "interrupt",
    "approval",
    "userInput",
    "mcpElicitation",
  ] as const),
  agentId: IdTextSchema,
  payloadDigest: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
  ),
  targetId: Schema.optionalKey(IdTextSchema),
});

const HarnessSessionStartedEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  capabilities: HarnessCapabilities,
  kind: Schema.Literal("sessionStarted"),
  provider: HarnessProviderDescriptor,
  state: HarnessNonFailureSessionStateSchema,
});
const HarnessSessionStateChangedEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  kind: Schema.Literal("sessionStateChanged"),
  state: HarnessNonFailureSessionStateSchema,
});
const HarnessTurnStartedEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  kind: Schema.Literal("turnStarted"),
  turnId: HarnessTurnIdSchema,
});
const HarnessItemDeltaRecordedEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  chunk: BoundedOutputSchema,
  deltaKind: Schema.Literals(["message", "commandOutput"] as const),
  itemId: HarnessItemIdSchema,
  kind: Schema.Literal("itemDeltaRecorded"),
  turnId: HarnessTurnIdSchema,
});
const HarnessItemUpsertedEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  final: Schema.Boolean,
  item: HarnessItemSchema,
  kind: Schema.Literal("itemUpserted"),
  turnId: Schema.optionalKey(HarnessTurnIdSchema),
});
const HarnessInteractionRequestedEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  interaction: HarnessPendingInteractionSchema,
  kind: Schema.Literal("interactionRequested"),
});
const HarnessInteractionResolvedEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  kind: Schema.Literal("interactionResolved"),
  resolution: HarnessInteractionResolutionSchema,
});
const HarnessInteractionCancelledEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  interactionId: HarnessInteractionIdSchema,
  kind: Schema.Literal("interactionCancelled"),
  reason: Schema.Literals(["providerResolved", "turnTerminal"] as const),
});
const HarnessTurnCompletedEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  failure: Schema.optionalKey(HarnessFailureSchema),
  kind: Schema.Literal("turnCompleted"),
  status: HarnessTerminalTurnStatusSchema,
  turnId: HarnessTurnIdSchema,
});
const HarnessSessionRecoveredEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  kind: Schema.Literal("sessionRecovered"),
});
const HarnessSessionFailedEventSchema = Schema.Struct({
  ...HarnessSessionEventBaseSchema.fields,
  failure: HarnessFailureSchema,
  kind: Schema.Literal("sessionFailed"),
});
const HarnessOperatorActionIntentRecordedEventSchema = Schema.Struct({
  ...HarnessOperatorActionEventBaseSchema.fields,
  kind: Schema.Literal("operatorActionIntentRecorded"),
});
const HarnessOperatorActionDispatchAttemptedEventSchema = Schema.Struct({
  ...HarnessOperatorActionEventBaseSchema.fields,
  kind: Schema.Literal("operatorActionDispatchAttempted"),
});
const HarnessOperatorActionDispatchConfirmedEventSchema = Schema.Struct({
  ...HarnessOperatorActionEventBaseSchema.fields,
  kind: Schema.Literal("operatorActionDispatchConfirmed"),
});
const HarnessOperatorActionDispatchFailedEventSchema = Schema.Struct({
  ...HarnessOperatorActionEventBaseSchema.fields,
  kind: Schema.Literal("operatorActionDispatchFailed"),
  message: BoundedTextSchema,
});

/** Finite authoritative event vocabulary used inside Gaia run events. */
export const HarnessEventSchema = Schema.Union([
  HarnessSessionStartedEventSchema,
  HarnessSessionStateChangedEventSchema,
  HarnessTurnStartedEventSchema,
  HarnessItemDeltaRecordedEventSchema,
  HarnessItemUpsertedEventSchema,
  HarnessInteractionRequestedEventSchema,
  HarnessInteractionResolvedEventSchema,
  HarnessInteractionCancelledEventSchema,
  HarnessTurnCompletedEventSchema,
  HarnessSessionRecoveredEventSchema,
  HarnessSessionFailedEventSchema,
  HarnessOperatorActionIntentRecordedEventSchema,
  HarnessOperatorActionDispatchAttemptedEventSchema,
  HarnessOperatorActionDispatchConfirmedEventSchema,
  HarnessOperatorActionDispatchFailedEventSchema,
]);
/** A decoded authoritative provider-neutral session event. */
export type HarnessEvent = typeof HarnessEventSchema.Type;

type HarnessSessionStartedEvent = typeof HarnessSessionStartedEventSchema.Type;
type HarnessSessionRecoveredEvent =
  typeof HarnessSessionRecoveredEventSchema.Type;
type HarnessItemDeltaRecordedEvent =
  typeof HarnessItemDeltaRecordedEventSchema.Type;
type HarnessItemUpsertedEvent = typeof HarnessItemUpsertedEventSchema.Type;
type HarnessInteractionRequestedEvent =
  typeof HarnessInteractionRequestedEventSchema.Type;

/** Maximum cumulative canonical event bytes retained for one session projection. */
export const HarnessSessionEventBudgetBytes = 16_777_216;

/** Measure one decoded canonical event using its persisted JSON representation. */
export function harnessEventByteLength(event: HarnessEvent): number {
  const encoded = Schema.encodeSync(HarnessEventSchema)(event);
  return new TextEncoder().encode(JSON.stringify(encoded)).byteLength;
}

/** Decode one canonical event and enforce its serialized persistence budget. */
export function parseHarnessEvent(input: unknown): HarnessEvent {
  const event = Schema.decodeUnknownSync(HarnessEventSchema)(input);
  const byteLength = harnessEventByteLength(event);
  if (byteLength > 1_048_576) {
    throw new Error(
      "Harness event exceeds the one-megabyte persistence limit."
    );
  }
  return event;
}

/** Derived snapshot of one provider-neutral turn. */
export class HarnessTurnSnapshot extends Schema.Class<HarnessTurnSnapshot>(
  "HarnessTurnSnapshot"
)({
  failure: Schema.optionalKey(HarnessFailureSchema),
  status: HarnessTurnStatusSchema,
  turnId: HarnessTurnIdSchema,
}) {}

/** Deterministic provider-neutral session projection rebuilt from run events. */
export class HarnessSessionSnapshot extends Schema.Class<HarnessSessionSnapshot>(
  "HarnessSessionSnapshot"
)({
  capabilities: HarnessCapabilities,
  failure: Schema.optionalKey(HarnessFailureSchema),
  items: Schema.Array(HarnessItemSchema).pipe(
    Schema.check(Schema.isMaxLength(2_000))
  ),
  pendingInteractions: Schema.Array(HarnessPendingInteractionSchema).pipe(
    Schema.check(Schema.isMaxLength(1_000))
  ),
  provider: HarnessProviderDescriptor,
  recovered: Schema.Boolean,
  resolvedInteractions: Schema.Array(HarnessResolvedInteraction).pipe(
    Schema.check(Schema.isMaxLength(1_000))
  ),
  sessionId: HarnessSessionIdSchema,
  state: HarnessSessionStateSchema,
  turns: Schema.Array(HarnessTurnSnapshot).pipe(
    Schema.check(Schema.isMaxLength(1_000))
  ),
}) {}

/** Return the explicit required capabilities that a provider does not advertise. */
export function missingHarnessCapabilities(
  capabilities: HarnessCapabilities,
  required: ReadonlyArray<HarnessCapability>
): ReadonlyArray<HarnessCapability> {
  return [...new Set(required)].filter(
    (capability) => !hasHarnessCapability(capabilities, capability)
  );
}

const MakeHarnessRunEventInputSchema = Schema.Struct({
  event: HarnessEventSchema,
  runId: RunEvent.fields.runId,
  sequence: RunEvent.fields.sequence,
  timestamp: Schema.toEncoded(RunEvent.fields.timestamp),
});
const parseMakeHarnessRunEventInput = Schema.decodeUnknownSync(
  MakeHarnessRunEventInputSchema
);

/** Wrap one finite harness event in the authoritative Gaia run-event envelope. */
export function makeHarnessRunEvent(
  input: typeof MakeHarnessRunEventInputSchema.Type
): RunEvent {
  const parsed = parseMakeHarnessRunEventInput(input);
  const event = parseHarnessEvent(parsed.event);
  const encoded = Schema.encodeSync(HarnessEventSchema)(event);
  return makeRunEvent({
    payload: { event: encoded },
    runId: parsed.runId,
    sequence: parsed.sequence,
    timestamp: parsed.timestamp,
    type: "HARNESS_SESSION_EVENT_RECORDED",
  });
}

/** Rebuild one session projection from the full ordered authoritative run log. */
export function replayHarnessSession(
  events: ReadonlyArray<RunEvent>,
  sessionId: HarnessSessionId
): HarnessSessionSnapshot {
  let expectedSequence = 1;
  let sessionEventBytes = 0;
  const sessionEvents: Array<HarnessEvent> = [];

  for (const runEvent of events) {
    if (runEvent.sequence !== expectedSequence) {
      throw new Error(
        `Invalid event sequence: expected ${expectedSequence}, received ${runEvent.sequence}.`
      );
    }
    expectedSequence += 1;

    if (runEvent.type !== "HARNESS_SESSION_EVENT_RECORDED") {
      continue;
    }

    const event = parseHarnessEvent(runEvent.payload.event);
    if (event.sessionId !== sessionId) {
      continue;
    }
    sessionEventBytes += harnessEventByteLength(event);
    if (sessionEventBytes > HarnessSessionEventBudgetBytes) {
      throw new Error("Harness session exceeds its cumulative event budget.");
    }
    sessionEvents.push(event);
  }

  return projectHarnessEvents(sessionEvents, sessionId);
}

/** Project already-decoded live adapter events without weakening run-log replay authority. */
export function projectHarnessEvents(
  events: ReadonlyArray<HarnessEvent>,
  sessionId: HarnessSessionId
): HarnessSessionSnapshot {
  let projection: MutableProjection | undefined;
  let sessionEventBytes = 0;

  for (const rawEvent of events) {
    const event = parseHarnessEvent(rawEvent);
    if (event.sessionId !== sessionId) continue;
    sessionEventBytes += harnessEventByteLength(event);
    if (sessionEventBytes > HarnessSessionEventBudgetBytes) {
      throw new Error("Harness session exceeds its cumulative event budget.");
    }
    if (projection === undefined) {
      if (event.kind !== "sessionStarted") {
        throw new Error(`Session ${sessionId} has no sessionStarted event.`);
      }
      projection = startProjection(event);
      continue;
    }
    applyEvent(projection, event);
  }

  if (projection === undefined) {
    throw new Error(`Session ${sessionId} was not found in the run event log.`);
  }

  return HarnessSessionSnapshot.make({
    capabilities: projection.capabilities,
    ...(projection.failure === undefined
      ? {}
      : { failure: projection.failure }),
    items: [...projection.items.values()].map(({ item }) => item),
    pendingInteractions: [...projection.pendingInteractions.values()],
    provider: projection.provider,
    recovered: projection.recovered,
    resolvedInteractions: projection.resolvedInteractions,
    sessionId: projection.sessionId,
    state: projection.state,
    turns: [...projection.turns.values()].map(({ failure, status, turnId }) =>
      HarnessTurnSnapshot.make({
        ...(failure === undefined ? {} : { failure }),
        status,
        turnId,
      })
    ),
  });
}

const HarnessMutableTurnSchema = Schema.Struct({
  failure: Schema.mutableKey(Schema.optionalKey(HarnessFailureSchema)),
  status: Schema.mutableKey(HarnessTurnStatusSchema),
  terminal: Schema.mutableKey(Schema.Boolean),
  turnId: HarnessTurnIdSchema,
});
type HarnessMutableTurn = typeof HarnessMutableTurnSchema.Type;

const HarnessProjectedItemSchema = Schema.Struct({
  final: Schema.Boolean,
  item: HarnessItemSchema,
});

const HarnessProjectionStateSchema = Schema.Struct({
  capabilities: HarnessCapabilities,
  failure: Schema.mutableKey(Schema.optionalKey(HarnessFailureSchema)),
  provider: HarnessProviderDescriptor,
  recovered: Schema.mutableKey(Schema.Boolean),
  resolvedInteractions: Schema.mutable(
    Schema.Array(HarnessResolvedInteraction)
  ),
  sessionId: HarnessSessionIdSchema,
  state: Schema.mutableKey(HarnessSessionStateSchema),
  terminal: Schema.mutableKey(Schema.Boolean),
});
const parseHarnessProjectionState = Schema.decodeUnknownSync(
  HarnessProjectionStateSchema
);

function startProjection(event: HarnessSessionStartedEvent) {
  const state = parseHarnessProjectionState({
    capabilities: event.capabilities,
    provider: event.provider,
    recovered: false,
    resolvedInteractions: [],
    sessionId: event.sessionId,
    state: event.state,
    terminal: isTerminalSessionState(event.state),
  });
  return {
    ...state,
    items: new Map<HarnessItemId, typeof HarnessProjectedItemSchema.Type>(),
    pendingInteractions: new Map<
      HarnessInteractionId,
      HarnessPendingInteraction
    >(),
    turns: new Map<HarnessTurnId, HarnessMutableTurn>(),
  };
}

type MutableProjection = ReturnType<typeof startProjection>;

function applyEvent(projection: MutableProjection, event: HarnessEvent): void {
  if (
    projection.terminal &&
    event.kind !== "sessionStarted" &&
    !canRecoverTerminalProjection(projection, event)
  ) {
    return;
  }

  switch (event.kind) {
    case "sessionStarted":
      if (
        !structurallyEqual(projection.provider, event.provider) ||
        !structurallyEqual(projection.capabilities, event.capabilities)
      ) {
        throw new Error(
          "Duplicate harness session start changed its contract."
        );
      }
      return;
    case "sessionStateChanged":
      projection.state = event.state;
      projection.terminal = isTerminalSessionState(event.state);
      if (projection.terminal) projection.pendingInteractions.clear();
      return;
    case "turnStarted":
      if (projection.turns.has(event.turnId)) return;
      if (projection.turns.size >= 1_000) {
        throw new Error("Harness session exceeded its turn projection limit.");
      }
      projection.turns.set(event.turnId, {
        status: "running",
        terminal: false,
        turnId: event.turnId,
      });
      return;
    case "itemDeltaRecorded":
      requireEventCapability(projection.capabilities, event);
      applyItemDelta(projection, event);
      return;
    case "itemUpserted":
      requireEventCapability(projection.capabilities, event);
      applyItemUpsert(projection, event);
      return;
    case "interactionRequested":
      requireEventCapability(projection.capabilities, event);
      if (
        "turnId" in event.interaction &&
        event.interaction.turnId !== undefined &&
        !projection.turns.has(event.interaction.turnId)
      ) {
        throw new Error("Harness interaction references an unknown turn.");
      }
      if (
        "turnId" in event.interaction &&
        event.interaction.turnId !== undefined &&
        projection.turns.get(event.interaction.turnId)?.terminal === true
      ) {
        return;
      }
      if (
        projection.resolvedInteractions.some(
          ({ request }) =>
            request.interactionId === event.interaction.interactionId
        )
      ) {
        return;
      }
      const existingInteraction = projection.pendingInteractions.get(
        event.interaction.interactionId
      );
      if (existingInteraction !== undefined) {
        if (!structurallyEqual(existingInteraction, event.interaction)) {
          throw new Error("Duplicate harness interaction changed its request.");
        }
        return;
      }
      projection.pendingInteractions.set(
        event.interaction.interactionId,
        event.interaction
      );
      if (projection.pendingInteractions.size > 1_000) {
        throw new Error(
          "Harness session exceeded its pending-interaction limit."
        );
      }
      return;
    case "interactionResolved": {
      const request = projection.pendingInteractions.get(
        event.resolution.interactionId
      );
      if (request === undefined) {
        const existingResolution = projection.resolvedInteractions.find(
          ({ resolution }) =>
            resolution.interactionId === event.resolution.interactionId
        )?.resolution;
        if (
          existingResolution !== undefined &&
          !structurallyEqual(existingResolution, event.resolution)
        ) {
          throw new Error("Duplicate harness resolution changed its action.");
        }
        return;
      }
      requireCompatibleResolution(request, event.resolution);
      projection.pendingInteractions.delete(event.resolution.interactionId);
      projection.resolvedInteractions.push(
        HarnessResolvedInteraction.make({
          request,
          resolution: event.resolution,
        })
      );
      if (projection.resolvedInteractions.length > 1_000) {
        throw new Error(
          "Harness session exceeded its resolved-interaction limit."
        );
      }
      return;
    }
    case "interactionCancelled":
      projection.pendingInteractions.delete(event.interactionId);
      return;
    case "turnCompleted": {
      const turn = projection.turns.get(event.turnId);
      if (turn === undefined) {
        throw new Error("Harness turn completion references an unknown turn.");
      }
      if (turn.terminal) {
        return;
      }
      if (event.status === "failed" && event.failure === undefined) {
        throw new Error("A failed harness turn must include a safe failure.");
      }
      if (event.status !== "failed" && event.failure !== undefined) {
        throw new Error("Only a failed harness turn may include a failure.");
      }
      turn.status = event.status;
      turn.terminal = isTerminalTurnStatus(event.status);
      if (event.failure !== undefined) turn.failure = event.failure;
      for (const [
        interactionId,
        interaction,
      ] of projection.pendingInteractions) {
        if ("turnId" in interaction && interaction.turnId === event.turnId) {
          projection.pendingInteractions.delete(interactionId);
        }
      }
      return;
    }
    case "sessionRecovered":
      requireEventCapability(projection.capabilities, event);
      if (projection.terminal) {
        delete projection.failure;
        projection.state = "running";
        projection.terminal = false;
      }
      projection.recovered = true;
      return;
    case "sessionFailed":
      projection.failure = event.failure;
      projection.state = "failed";
      projection.terminal = true;
      for (const turn of projection.turns.values()) {
        if (turn.terminal) continue;
        turn.status = "failed";
        turn.terminal = true;
        turn.failure = event.failure;
      }
      projection.pendingInteractions.clear();
      return;
    case "operatorActionIntentRecorded":
    case "operatorActionDispatchAttempted":
    case "operatorActionDispatchConfirmed":
    case "operatorActionDispatchFailed":
      return;
  }
}

function canRecoverTerminalProjection(
  projection: MutableProjection,
  event: HarnessEvent
): event is HarnessSessionRecoveredEvent {
  return (
    event.kind === "sessionRecovered" &&
    projection.state === "failed" &&
    projection.failure?.kind === "providerFailure" &&
    projection.failure.recoverable === true
  );
}

function applyItemDelta(
  projection: MutableProjection,
  event: HarnessItemDeltaRecordedEvent
): void {
  const existing = projection.items.get(event.itemId);
  const turn = projection.turns.get(event.turnId);
  if (turn === undefined) {
    throw new Error("Harness item delta references an unknown turn.");
  }
  if (existing?.final === true || turn.terminal) {
    return;
  }

  if (event.deltaKind === "message") {
    const priorText =
      existing?.item.kind === "message" ? existing.item.text : "";
    projection.items.set(event.itemId, {
      final: false,
      item: Schema.decodeUnknownSync(HarnessItemSchema)({
        itemId: event.itemId,
        kind: "message",
        phase: "unknown",
        status: "streaming",
        text: truncateText(`${priorText}${event.chunk}`),
        turnId: event.turnId,
      }),
    });
    return;
  }

  if (existing?.item.kind !== "command") return;
  projection.items.set(event.itemId, {
    final: false,
    item: Schema.decodeUnknownSync(HarnessItemSchema)({
      ...existing.item,
      output: truncateText(`${existing.item.output ?? ""}${event.chunk}`),
    }),
  });
}

function applyItemUpsert(
  projection: MutableProjection,
  event: HarnessItemUpsertedEvent
): void {
  const existing = projection.items.get(event.item.itemId);
  const eventTurnId = event.turnId;
  const itemTurnId = "turnId" in event.item ? event.item.turnId : undefined;
  if (
    eventTurnId !== undefined &&
    itemTurnId !== undefined &&
    eventTurnId !== itemTurnId
  ) {
    throw new Error("Harness item turn does not match its event turn.");
  }
  const scopedTurnId = eventTurnId ?? itemTurnId;
  if (scopedTurnId !== undefined && !projection.turns.has(scopedTurnId)) {
    throw new Error("Harness item references an unknown turn.");
  }
  if (
    existing?.final === true ||
    (scopedTurnId !== undefined &&
      projection.turns.get(scopedTurnId)?.terminal === true)
  ) {
    return;
  }
  projection.items.set(event.item.itemId, {
    final: event.final,
    item: event.item,
  });
  if (projection.items.size > 2_000) {
    throw new Error("Harness session exceeded its item projection limit.");
  }
}

function truncateText(
  value: typeof Schema.String.Type
): typeof BoundedOutputSchema.Type {
  const marker = "\n[preview truncated]";
  return value.length <= 65_536
    ? value
    : `${value.slice(0, 65_536 - marker.length)}${marker}`;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireCompatibleResolution(
  request: HarnessPendingInteraction,
  resolution: HarnessInteractionResolution
): void {
  switch (request.kind) {
    case "commandApproval":
    case "fileChangeApproval":
    case "permissionApproval":
      if (
        resolution.kind !== "approval" ||
        !request.allowedDecisions.includes(resolution.decision)
      ) {
        throw new Error(
          "Harness interaction resolution is not allowed by its request."
        );
      }
      return;
    case "userInput":
      if (resolution.kind !== "userInput") {
        throw new Error(
          "Harness user-input interaction has an invalid resolution."
        );
      }
      return;
    case "mcpElicitation":
      if (resolution.kind !== "mcpElicitation") {
        throw new Error("Harness MCP elicitation has an invalid resolution.");
      }
  }
}

function requireEventCapability(
  capabilities: HarnessCapabilities,
  event:
    | HarnessItemDeltaRecordedEvent
    | HarnessItemUpsertedEvent
    | HarnessInteractionRequestedEvent
    | HarnessSessionRecoveredEvent
): void {
  let required: HarnessCapability | undefined;
  switch (event.kind) {
    case "sessionRecovered":
      required = "resumableSessions";
      break;
    case "itemDeltaRecorded":
      required =
        event.deltaKind === "message" ? "streamingMessages" : undefined;
      break;
    case "itemUpserted":
      required =
        event.item.kind === "fileChange"
          ? "fileChangeEvents"
          : event.item.kind === "toolCall"
            ? "toolEvents"
            : event.item.kind === "review"
              ? "review"
              : event.item.kind === "usage"
                ? "usageReporting"
                : undefined;
      break;
    case "interactionRequested":
      required =
        event.interaction.kind === "commandApproval"
          ? "approval:command"
          : event.interaction.kind === "fileChangeApproval"
            ? "approval:fileChange"
            : event.interaction.kind === "permissionApproval"
              ? "approval:permission"
              : event.interaction.kind === "userInput"
                ? "approval:userInput"
                : "approval:mcpElicitation";
      if (
        event.interaction.kind === "userInput" &&
        !hasHarnessCapability(capabilities, "userQuestions")
      ) {
        throw new Error(
          "Harness event contradicts provider capability userQuestions."
        );
      }
      break;
  }

  if (required !== undefined && !hasHarnessCapability(capabilities, required)) {
    throw new Error(
      `Harness event contradicts provider capability ${required}.`
    );
  }
}

function hasHarnessCapability(
  capabilities: HarnessCapabilities,
  capability: HarnessCapability
): boolean {
  switch (capability) {
    case "streamingMessages":
    case "resumableSessions":
    case "toolEvents":
    case "fileChangeEvents":
    case "userQuestions":
    case "steering":
    case "interruption":
    case "review":
    case "subagents":
    case "structuredOutput":
    case "usageReporting":
      return capabilities[capability];
    case "approval:command":
      return capabilities.approvals.includes("command");
    case "approval:fileChange":
      return capabilities.approvals.includes("fileChange");
    case "approval:permission":
      return capabilities.approvals.includes("permission");
    case "approval:userInput":
      return capabilities.approvals.includes("userInput");
    case "approval:mcpElicitation":
      return capabilities.approvals.includes("mcpElicitation");
  }
}

function isTerminalSessionState(state: HarnessSessionState): boolean {
  return (
    state === "interrupted" ||
    state === "failed" ||
    state === "completed" ||
    state === "unavailable"
  );
}

function isTerminalTurnStatus(status: HarnessTurnStatus): boolean {
  return (
    status === "interrupted" || status === "failed" || status === "completed"
  );
}
