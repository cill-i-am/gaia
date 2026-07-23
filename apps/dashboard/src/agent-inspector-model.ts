import {
  AgentSessionSnapshotDto,
  AgentSessionEventSequenceSchema,
  HarnessInteractionIdSchema,
  HarnessItemIdSchema,
  HarnessItemSchema,
  HarnessPendingInteractionSchema,
  HarnessSessionStateSchema,
  HarnessTurnSnapshot,
  HarnessTurnIdSchema,
  RunControlActionTarget,
  RunControlOperationSchema,
  RunControlSnapshot,
  type HarnessItem,
  type HarnessPendingInteraction,
  type HarnessSessionState,
} from "@gaia/core";
import { Schema } from "effect";

export const AgentInspectorConnectionSchema = Schema.Literals([
  "connecting",
  "connected",
  "reconnecting",
  "unavailable",
] as const);

export type AgentInspectorConnection =
  typeof AgentInspectorConnectionSchema.Type;

export const AgentInspectorTimelineItemSchema = Schema.Struct({
  details: Schema.optional(Schema.String),
  key: HarnessItemIdSchema,
  status: Schema.String,
  title: Schema.String,
});

export type AgentInspectorTimelineItem =
  typeof AgentInspectorTimelineItemSchema.Type;

export const AgentInspectorComposerSchema = Schema.Union([
  Schema.Struct({
    disabledReason: Schema.optional(Schema.String),
    mode: Schema.Literal("followUp"),
    placeholder: Schema.String,
    turnId: Schema.optional(HarnessTurnIdSchema),
  }),
  Schema.Struct({
    disabledReason: Schema.optional(Schema.String),
    mode: Schema.Literal("steer"),
    placeholder: Schema.String,
    turnId: HarnessTurnIdSchema,
  }),
  Schema.Struct({
    disabledReason: Schema.String,
    mode: Schema.Literal("disabled"),
    placeholder: Schema.String,
    turnId: Schema.optional(HarnessTurnIdSchema),
  }),
]);

export type AgentInspectorComposer = typeof AgentInspectorComposerSchema.Type;

export const AgentInspectorPendingActionSchema = Schema.Literals([
  "approve",
  "approveForSession",
  "decline",
  "cancel",
  "submit",
] as const);

export const AgentInspectorPendingInteractionSchema = Schema.Struct({
  actions: Schema.Array(AgentInspectorPendingActionSchema),
  body: Schema.String,
  interactionId: HarnessInteractionIdSchema,
  kind: Schema.Literals(["approval", "mcpElicitation", "userInput"] as const),
  title: Schema.String,
});

export type AgentInspectorPendingInteraction =
  typeof AgentInspectorPendingInteractionSchema.Type;

export const AgentInspectorSessionStatusSchema = Schema.Union([
  HarnessSessionStateSchema,
  Schema.Literals(["connecting", "reconnecting"] as const),
]);

export const AgentInspectorInterruptSchema = Schema.Struct({
  disabledReason: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  turnId: Schema.optional(HarnessTurnIdSchema),
});

export const AgentInspectorSessionModelSchema = Schema.Struct({
  composer: AgentInspectorComposerSchema,
  eventSequence: Schema.optional(AgentSessionEventSequenceSchema),
  interrupt: AgentInspectorInterruptSchema,
  notice: Schema.optional(Schema.String),
  pendingInteractions: Schema.Array(AgentInspectorPendingInteractionSchema),
  status: AgentInspectorSessionStatusSchema,
  timeline: Schema.Array(AgentInspectorTimelineItemSchema),
});

export type AgentInspectorSessionModel =
  typeof AgentInspectorSessionModelSchema.Type;

export const AgentInspectorRunControlModelSchema = Schema.Struct({
  actionTarget: Schema.optionalKey(RunControlActionTarget),
  allowedActions: Schema.Array(RunControlOperationSchema),
  expired: Schema.Boolean,
  state: RunControlSnapshot.fields.state,
});

export type AgentInspectorRunControlModel =
  typeof AgentInspectorRunControlModelSchema.Type;

export function buildAgentInspectorRunControlModel(
  snapshot: typeof RunControlSnapshot.Type
): AgentInspectorRunControlModel {
  return {
    ...(snapshot.actionTarget === undefined
      ? {}
      : { actionTarget: snapshot.actionTarget }),
    allowedActions: snapshot.allowedActions,
    expired: snapshot.expired,
    state: snapshot.state,
  };
}

const BuildAgentInspectorSessionModelInputSchema = Schema.Struct({
  connection: AgentInspectorConnectionSchema,
  lastError: Schema.optional(Schema.String),
  session: Schema.UndefinedOr(AgentSessionSnapshotDto),
});

export function buildAgentInspectorSessionModel(
  input: typeof BuildAgentInspectorSessionModelInputSchema.Type
): AgentInspectorSessionModel {
  if (input.connection === "reconnecting") {
    return unavailableModel({
      eventSequence: input.session?.eventSequence,
      notice: input.lastError ?? "Agent session stream is reconnecting.",
      status: "reconnecting",
    });
  }

  if (input.connection === "connecting") {
    return unavailableModel({
      eventSequence: input.session?.eventSequence,
      notice: "Agent session is connecting.",
      status: "connecting",
    });
  }

  if (input.connection === "unavailable" || input.session === undefined) {
    return unavailableModel({
      eventSequence: undefined,
      notice: input.lastError ?? "Agent session is unavailable.",
      status: "unavailable",
    });
  }

  const activeTurn = latestActiveTurn(input.session.turns);
  return {
    composer: composerFor(input.session, activeTurn),
    eventSequence: input.session.eventSequence,
    interrupt: interruptFor(input.session, activeTurn),
    notice: input.lastError,
    pendingInteractions: input.session.pendingInteractions.map(
      pendingInteractionModel
    ),
    status: input.session.state,
    timeline: input.session.items.map(timelineItemModel),
  };
}

function unavailableModel(input: {
  readonly eventSequence: number | undefined;
  readonly notice: string;
  readonly status: AgentInspectorSessionModel["status"];
}): AgentInspectorSessionModel {
  return {
    composer: disabledComposer(
      input.status === "unavailable"
        ? "Agent session is unavailable."
        : input.notice
    ),
    eventSequence: input.eventSequence,
    interrupt: {
      disabledReason: input.notice,
      enabled: false,
      turnId: undefined,
    },
    notice: input.notice,
    pendingInteractions: [],
    status: input.status,
    timeline: [],
  };
}

function latestActiveTurn(
  turns: ReadonlyArray<typeof HarnessTurnSnapshot.Type>
) {
  return [...turns]
    .reverse()
    .find(
      (turn) =>
        turn.status === "running" || turn.status === "waitingForOperator"
    );
}

function composerFor(
  session: typeof AgentSessionSnapshotDto.Type,
  activeTurn: typeof HarnessTurnSnapshot.Type | undefined
): AgentInspectorComposer {
  if (isTerminalSessionState(session.state)) {
    return disabledComposer(`Agent session is ${session.state}.`);
  }

  if (
    activeTurn !== undefined &&
    isActiveSessionState(session.state) &&
    session.capabilities.steering
  ) {
    return {
      disabledReason: undefined,
      mode: "steer",
      placeholder: "Steer the active turn",
      turnId: activeTurn.turnId,
    };
  }

  if (session.state === "idle" && session.capabilities.resumableSessions) {
    return {
      disabledReason: undefined,
      mode: "followUp",
      placeholder: "Send a follow-up turn",
      turnId: undefined,
    };
  }

  if (activeTurn !== undefined && !session.capabilities.steering) {
    return disabledComposer("Steering is not supported by this session.");
  }

  if (!session.capabilities.resumableSessions) {
    return disabledComposer(
      "Follow-up turns are not supported by this session."
    );
  }

  return disabledComposer(`Agent session is ${session.state}.`);
}

function interruptFor(
  session: typeof AgentSessionSnapshotDto.Type,
  activeTurn: typeof HarnessTurnSnapshot.Type | undefined
) {
  if (!session.capabilities.interruption) {
    return {
      disabledReason: "Interruption is not supported by this session.",
      enabled: false,
      turnId: undefined,
    };
  }

  if (activeTurn === undefined || !isActiveSessionState(session.state)) {
    return {
      disabledReason: "No active turn can be interrupted.",
      enabled: false,
      turnId: undefined,
    };
  }

  return {
    disabledReason: undefined,
    enabled: true,
    turnId: activeTurn.turnId,
  };
}

function disabledComposer(reason: string): AgentInspectorComposer {
  return {
    disabledReason: reason,
    mode: "disabled",
    placeholder: reason,
    turnId: undefined,
  };
}

function isTerminalSessionState(state: HarnessSessionState) {
  return state === "completed" || state === "failed" || state === "interrupted";
}

function isActiveSessionState(state: HarnessSessionState) {
  return state === "running" || state === "waitingForOperator";
}

function timelineItemModel(item: HarnessItem): AgentInspectorTimelineItem {
  switch (item.kind) {
    case "message":
      return {
        details: item.text,
        key: item.itemId,
        status: item.status,
        title: "Agent message",
      };
    case "plan":
      return {
        details: item.steps
          .map((step) => `${step.status}: ${step.step}`)
          .join("\n"),
        key: item.itemId,
        status: item.status,
        title: `Plan ${item.status}`,
      };
    case "command":
      return {
        details: [item.command, item.workspacePath, item.output]
          .filter(isPresent)
          .join("\n"),
        key: item.itemId,
        status: item.status,
        title: `Command ${item.status}`,
      };
    case "fileChange":
      return {
        details: item.changes
          .map((change) => `${change.path}\n${change.diff}`)
          .join("\n\n"),
        key: item.itemId,
        status: item.status,
        title:
          item.changes.length === 1
            ? `File ${item.changes[0]?.kind ?? "change"} ${item.status}`
            : `File changes ${item.status}`,
      };
    case "toolCall":
      return {
        details: item.summary,
        key: item.itemId,
        status: item.status,
        title: `Tool ${item.toolName} ${item.status}`,
      };
    case "review":
      return {
        details: item.summary,
        key: item.itemId,
        status: item.status,
        title: `Review ${item.status}`,
      };
    case "warning":
      return {
        details: item.message,
        key: item.itemId,
        status: "warning",
        title: "Warning",
      };
    case "usage":
      return {
        details: `${item.inputTokens} input / ${item.outputTokens} output tokens`,
        key: item.itemId,
        status: "completed",
        title: "Usage",
      };
  }
}

function pendingInteractionModel(
  interaction: HarnessPendingInteraction
): AgentInspectorPendingInteraction {
  switch (interaction.kind) {
    case "commandApproval":
      return {
        actions: interaction.allowedDecisions,
        body: interaction.command,
        interactionId: interaction.interactionId,
        kind: "approval",
        title: "Command approval",
      };
    case "fileChangeApproval":
      return {
        actions: interaction.allowedDecisions,
        body: interaction.paths.join(", "),
        interactionId: interaction.interactionId,
        kind: "approval",
        title: "File-change approval",
      };
    case "permissionApproval":
      return {
        actions: interaction.allowedDecisions,
        body: interaction.summary,
        interactionId: interaction.interactionId,
        kind: "approval",
        title: "Permission approval",
      };
    case "userInput":
      return {
        actions: ["submit"],
        body: interaction.questions.map(questionSummary).join("\n"),
        interactionId: interaction.interactionId,
        kind: "userInput",
        title: "Operator input",
      };
    case "mcpElicitation":
      return {
        actions: ["submit", "decline", "cancel"],
        body: interaction.message,
        interactionId: interaction.interactionId,
        kind: "mcpElicitation",
        title: `MCP elicitation: ${interaction.serverName}`,
      };
  }
}

function questionSummary(
  question: Extract<
    HarnessPendingInteraction,
    { readonly kind: "userInput" }
  >["questions"][number]
) {
  const options =
    question.options.length === 0
      ? ""
      : ` Options: ${question.options.join(", ")}`;
  const secret = question.secret ? " (secret)" : "";
  return `${question.prompt}${options}${secret}`;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
