import type {
  AgentSessionSnapshotDto,
  HarnessItem,
  HarnessPendingInteraction,
  HarnessSessionState,
  HarnessTurnSnapshot,
} from "@gaia/core";

export type AgentInspectorConnection =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unavailable";

export type AgentInspectorTimelineItem = {
  readonly details: string | undefined;
  readonly key: string;
  readonly status: string;
  readonly title: string;
};

export type AgentInspectorComposer =
  | {
      readonly disabledReason: undefined;
      readonly mode: "followUp";
      readonly placeholder: string;
      readonly turnId: undefined;
    }
  | {
      readonly disabledReason: undefined;
      readonly mode: "steer";
      readonly placeholder: string;
      readonly turnId: string;
    }
  | {
      readonly disabledReason: string;
      readonly mode: "disabled";
      readonly placeholder: string;
      readonly turnId: undefined;
    };

export type AgentInspectorPendingInteraction = {
  readonly actions: ReadonlyArray<string>;
  readonly body: string;
  readonly interactionId: string;
  readonly kind: "approval" | "mcpElicitation" | "userInput";
  readonly title: string;
};

export type AgentInspectorSessionModel = {
  readonly composer: AgentInspectorComposer;
  readonly eventSequence: number | undefined;
  readonly interrupt: {
    readonly disabledReason: string | undefined;
    readonly enabled: boolean;
    readonly turnId: string | undefined;
  };
  readonly notice: string | undefined;
  readonly pendingInteractions: ReadonlyArray<AgentInspectorPendingInteraction>;
  readonly status: HarnessSessionState | "connecting" | "reconnecting";
  readonly timeline: ReadonlyArray<AgentInspectorTimelineItem>;
};

export function buildAgentInspectorSessionModel(input: {
  readonly connection: AgentInspectorConnection;
  readonly lastError?: string | undefined;
  readonly session: typeof AgentSessionSnapshotDto.Type | undefined;
}): AgentInspectorSessionModel {
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
      pendingInteractionModel,
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
        : input.notice,
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
  turns: ReadonlyArray<typeof HarnessTurnSnapshot.Type>,
) {
  return [...turns]
    .reverse()
    .find(
      (turn) =>
        turn.status === "running" || turn.status === "waitingForOperator",
    );
}

function composerFor(
  session: typeof AgentSessionSnapshotDto.Type,
  activeTurn: typeof HarnessTurnSnapshot.Type | undefined,
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
    return disabledComposer("Follow-up turns are not supported by this session.");
  }

  return disabledComposer(`Agent session is ${session.state}.`);
}

function interruptFor(
  session: typeof AgentSessionSnapshotDto.Type,
  activeTurn: typeof HarnessTurnSnapshot.Type | undefined,
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
  return (
    state === "completed" || state === "failed" || state === "interrupted"
  );
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
  interaction: HarnessPendingInteraction,
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
        actions: ["submit", "decline"],
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
  >["questions"][number],
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
