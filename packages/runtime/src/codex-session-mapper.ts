import {
  parseHarnessEvent,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessQuestionId,
  parseHarnessTurnId,
  parseWorkspaceRelativePath,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessInteractionId,
  type HarnessInteractionResolution,
  type HarnessItem,
  type HarnessItemId,
  type HarnessProviderDescriptor,
  type HarnessPendingInteraction,
  type HarnessQuestionId,
  type HarnessSessionId,
  type HarnessTurnId,
  type WorkspaceRelativePath,
} from "@gaia/core";
import path from "node:path";
import { Option, Schema } from "effect";
import {
  CodexNotificationSchema,
  CodexServerRequestSchema,
  CodexThreadSchema,
  type CodexNotification,
  type CodexServerRequest,
  type CodexThreadItem,
  type CodexRequestId,
} from "./codex-app-server-protocol.js";

/** Construction options for one adapter-local Codex session mapper. */
export type CodexSessionMapperOptions = {
  readonly capabilities: HarnessCapabilities;
  readonly deltaFlushCharacters?: number;
  readonly provider: HarnessProviderDescriptor;
  readonly sensitiveValues?: ReadonlyArray<string>;
  readonly sessionId: HarnessSessionId;
  readonly workspaceRoot: string;
};

/** Adapter-private mapper surface; all provider inputs remain unknown at this boundary. */
export interface CodexSessionMapper {
  readonly mapNotification: (input: unknown) => ReadonlyArray<HarnessEvent>;
  readonly mapServerRequest: (input: unknown) => ReadonlyArray<HarnessEvent>;
  readonly mapRecoveredThread: (input: unknown) => ReadonlyArray<HarnessEvent>;
  readonly mapUserInputAnswers: (
    requestId: string | number,
    answers: ReadonlyArray<{
      readonly answers: ReadonlyArray<string>;
      readonly questionId: HarnessQuestionId;
    }>,
  ) => Record<string, { readonly answers: ReadonlyArray<string> }> | undefined;
  readonly resolveServerRequest: (
    requestId: string | number,
    resolution: {
      readonly actionId: HarnessInteractionResolution["actionId"];
      readonly decision:
        | "approve"
        | "approveForSession"
        | "decline"
        | "cancel"
        | "submit";
      readonly resolvedAt: string;
      readonly responseKind: "approval" | "userInput" | "mcpElicitation";
    },
  ) => ReadonlyArray<HarnessEvent>;
}

const decodeNotification = Schema.decodeUnknownOption(CodexNotificationSchema);
const decodeServerRequest = Schema.decodeUnknownOption(CodexServerRequestSchema);
const decodeThread = Schema.decodeUnknownOption(CodexThreadSchema);

/** Create a stateful adapter-local mapper with private vendor correlation state. */
export function createCodexSessionMapper(
  options: CodexSessionMapperOptions,
): CodexSessionMapper {
  const state = new MapperState(options);
  return {
    mapNotification: (input) => {
      const decoded = decodeNotification(input);
      return Option.isNone(decoded) ? [] : state.mapNotification(decoded.value);
    },
    mapServerRequest: (input) => {
      const decoded = decodeServerRequest(input);
      return Option.isNone(decoded) ? [] : state.mapServerRequest(decoded.value);
    },
    mapRecoveredThread: (input) => {
      const decoded = decodeThread(input);
      return Option.isNone(decoded) ? [] : state.mapRecoveredThread(decoded.value);
    },
    mapUserInputAnswers: (requestId, answers) =>
      state.mapUserInputAnswers(requestId, answers),
    resolveServerRequest: (requestId, resolution) =>
      state.resolveServerRequest(requestId, resolution),
  };
}

class MapperState {
  readonly #deltaFlushCharacters: number;
  readonly #deltaEmittedCharacters = new Map<string, number>();
  readonly #finalItems = new Set<string>();
  readonly #itemIds = new Map<string, HarnessItemId>();
  readonly #messageBuffers = new Map<string, string>();
  readonly #options: CodexSessionMapperOptions;
  readonly #planItemIds = new Map<string, HarnessItemId>();
  readonly #requestIds = new Map<
    CodexRequestId,
    {
      readonly interaction: HarnessPendingInteraction;
      readonly interactionId: HarnessInteractionId;
      readonly questionIds?: ReadonlyMap<HarnessQuestionId, string>;
    }
  >();
  readonly #seenRequestIds = new Set<CodexRequestId>();
  readonly #startedTurns = new Set<string>();
  readonly #terminalTurns = new Set<string>();
  readonly #turnIds = new Map<string, HarnessTurnId>();
  readonly #usageItemIds = new Map<string, HarnessItemId>();
  #activeTurnId: string | undefined;
  #interactionCounter = 0;
  #itemCounter = 0;
  #threadId: string | undefined;
  #turnCounter = 0;

  constructor(options: CodexSessionMapperOptions) {
    this.#options = options;
    this.#deltaFlushCharacters = Math.max(
      1,
      Math.trunc(options.deltaFlushCharacters ?? 1_024),
    );
  }

  mapNotification(notification: CodexNotification): ReadonlyArray<HarnessEvent> {
    switch (notification.method) {
      case "thread/started": {
        const nativeThreadId = notification.params.thread.id;
        if (this.#threadId !== undefined) return [];
        this.#threadId = nativeThreadId;
        return [
          this.#event({
            capabilities: this.#options.capabilities,
            kind: "sessionStarted",
            provider: this.#options.provider,
            sessionId: this.#options.sessionId,
            state: "connecting",
          }),
        ];
      }
      case "thread/status/changed": {
        if (!this.#ownsThread(notification.params.threadId)) return [];
        const state = mapThreadStatus(notification.params.status);
        return state === undefined
          ? []
          : [
              this.#event({
                kind: "sessionStateChanged",
                sessionId: this.#options.sessionId,
                state,
              }),
            ];
      }
      case "turn/started": {
        if (!this.#ownsThread(notification.params.threadId)) return [];
        const nativeTurnId = notification.params.turn.id;
        if (
          this.#terminalTurns.has(nativeTurnId) ||
          (this.#startedTurns.has(nativeTurnId) &&
            this.#activeTurnId !== undefined &&
            this.#activeTurnId !== nativeTurnId)
        ) {
          return [];
        }
        const events = this.#ensureTurnStarted(nativeTurnId);
        this.#activeTurnId = nativeTurnId;
        return [
          ...events,
          this.#event({
            kind: "sessionStateChanged",
            sessionId: this.#options.sessionId,
            state: "running",
          }),
        ];
      }
      case "turn/completed":
        return this.#mapTurnCompleted(notification);
      case "turn/diff/updated":
        return [];
      case "turn/plan/updated":
        return this.#mapPlan(notification);
      case "item/started":
        return this.#mapItemLifecycle(notification, false);
      case "item/completed":
        return this.#mapItemLifecycle(notification, true);
      case "item/agentMessage/delta":
        return this.#mapDelta(notification, "message");
      case "item/commandExecution/outputDelta":
        return this.#mapDelta(notification, "commandOutput");
      case "thread/tokenUsage/updated":
        return this.#mapUsage(notification);
      case "warning":
        return this.#mapWarning(notification.params.message);
      case "error":
        return this.#ownsThread(notification.params.threadId)
          ? this.#mapWarning(notification.params.error.message)
          : [];
      case "serverRequest/resolved":
        return this.#ownsThread(notification.params.threadId)
          ? this.#cancelServerRequest(notification.params.requestId)
          : [];
    }
  }

  mapServerRequest(request: CodexServerRequest): ReadonlyArray<HarnessEvent> {
    const nativeThreadId = request.params.threadId;
    if (
      !this.#ownsThread(nativeThreadId) ||
      this.#seenRequestIds.has(request.id)
    ) {
      return [];
    }

    const interactionId = this.#interactionId();
    const interaction = this.#mapInteraction(request, interactionId);
    if (interaction === undefined) return [];
    this.#seenRequestIds.add(request.id);
    const questionIds =
      request.method === "item/tool/requestUserInput" &&
      interaction.kind === "userInput"
        ? new Map(
            interaction.questions.map((question, index) => [
              question.questionId,
              request.params.questions[index]!.id,
            ]),
          )
        : undefined;
    this.#requestIds.set(request.id, {
      interaction,
      interactionId,
      ...(questionIds === undefined ? {} : { questionIds }),
    });
    const turnEvents =
      request.method === "mcpServer/elicitation/request" &&
      request.params.turnId === undefined
        ? []
        : this.#ensureTurnStarted(request.params.turnId ?? "");
    return [
      ...turnEvents,
      this.#event({
        interaction,
        kind: "interactionRequested",
        sessionId: this.#options.sessionId,
      }),
      this.#event({
        kind: "sessionStateChanged",
        sessionId: this.#options.sessionId,
        state: "waitingForOperator",
      }),
    ];
  }

  mapRecoveredThread(
    thread: typeof CodexThreadSchema.Type,
  ): ReadonlyArray<HarnessEvent> {
    if (!this.#ownsThread(thread.id)) return [];
    const events: Array<HarnessEvent> = [];
    for (const turn of thread.turns ?? []) {
      events.push(...this.#ensureTurnStarted(turn.id));
      for (const item of turn.items ?? []) {
        events.push(
          ...this.#mapItemLifecycle(
            {
              method: "item/completed",
              params: {
                item,
                threadId: thread.id,
                turnId: turn.id,
              },
            },
            true,
          ),
        );
      }
      const status = mapTurnStatus(turn.status);
      if (
        status !== undefined &&
        status !== "running" &&
        !this.#terminalTurns.has(turn.id)
      ) {
        this.#terminalTurns.add(turn.id);
        const failure =
          turn.error === null || turn.error === undefined
            ? status === "failed"
              ? {
                  code: "CodexTurnFailed",
                  kind: "providerFailure" as const,
                  message: "Codex turn failed.",
                  recoverable: false,
                }
              : undefined
            : {
                code: "CodexTurnFailed",
                kind: "providerFailure" as const,
                message: this.#text(turn.error.message),
                recoverable: false,
              };
        events.push(
          this.#event({
            ...(failure === undefined ? {} : { failure }),
            kind: "turnCompleted",
            sessionId: this.#options.sessionId,
            status,
            turnId: this.#turnId(turn.id),
          }),
        );
      }
    }
    this.#activeTurnId = [...(thread.turns ?? [])]
      .reverse()
      .find((turn) => turn.status === "inProgress")?.id;
    const state = mapThreadStatus(thread.status ?? { type: "idle" });
    if (state === "failed") {
      events.push(
        this.#event({
          failure: {
            code: "CodexThreadSystemError",
            kind: "providerFailure",
            message: "Codex session recovered in a failed state.",
            recoverable: true,
          },
          kind: "sessionFailed",
          sessionId: this.#options.sessionId,
        }),
      );
    } else if (state !== undefined) {
      events.push(
        this.#event({
          kind: "sessionStateChanged",
          sessionId: this.#options.sessionId,
          state,
        }),
      );
    }
    return events;
  }

  mapUserInputAnswers(
    requestId: CodexRequestId,
    answers: ReadonlyArray<{
      readonly answers: ReadonlyArray<string>;
      readonly questionId: HarnessQuestionId;
    }>,
  ): Record<string, { readonly answers: ReadonlyArray<string> }> | undefined {
    const questionIds = this.#requestIds.get(requestId)?.questionIds;
    if (questionIds === undefined || answers.length !== questionIds.size) {
      return undefined;
    }
    const nativeAnswers: Array<
      readonly [string, { readonly answers: ReadonlyArray<string> }]
    > = [];
    for (const answer of answers) {
      const nativeQuestionId = questionIds.get(answer.questionId);
      if (nativeQuestionId === undefined) return undefined;
      nativeAnswers.push([nativeQuestionId, { answers: answer.answers }]);
    }
    return Object.fromEntries(nativeAnswers);
  }

  resolveServerRequest(
    requestId: string | number,
    resolution: {
      readonly actionId: HarnessInteractionResolution["actionId"];
      readonly decision:
        | "approve"
        | "approveForSession"
        | "decline"
        | "cancel"
        | "submit";
      readonly resolvedAt: string;
      readonly responseKind: "approval" | "userInput" | "mcpElicitation";
    },
  ): ReadonlyArray<HarnessEvent> {
    const pending = this.#requestIds.get(requestId);
    if (pending === undefined) return [];
    const coreResolution = this.#resolution(
      pending.interaction,
      pending.interactionId,
      resolution,
    );
    this.#requestIds.delete(requestId);
    return [
      this.#event({
        kind: "interactionResolved",
        resolution: coreResolution,
        sessionId: this.#options.sessionId,
      }),
      this.#event({
        kind: "sessionStateChanged",
        sessionId: this.#options.sessionId,
        state: this.#requestIds.size === 0 ? "running" : "waitingForOperator",
      }),
    ];
  }

  #cancelServerRequest(requestId: CodexRequestId): ReadonlyArray<HarnessEvent> {
    const pending = this.#requestIds.get(requestId);
    if (pending === undefined) return [];
    this.#requestIds.delete(requestId);
    return [
      this.#event({
        interactionId: pending.interactionId,
        kind: "interactionCancelled",
        reason: "providerResolved",
        sessionId: this.#options.sessionId,
      }),
      this.#event({
        kind: "sessionStateChanged",
        sessionId: this.#options.sessionId,
        state: this.#requestIds.size === 0 ? "running" : "waitingForOperator",
      }),
    ];
  }

  #resolution(
    request: HarnessPendingInteraction,
    interactionId: HarnessInteractionId,
    resolution: {
      readonly actionId: HarnessInteractionResolution["actionId"];
      readonly decision:
        | "approve"
        | "approveForSession"
        | "decline"
        | "cancel"
        | "submit";
      readonly resolvedAt: string;
      readonly responseKind: "approval" | "userInput" | "mcpElicitation";
    },
  ): HarnessInteractionResolution {
    switch (request.kind) {
      case "commandApproval":
      case "fileChangeApproval":
      case "permissionApproval":
        if (
          resolution.responseKind !== "approval" ||
          resolution.decision === "submit" ||
          !request.allowedDecisions.includes(resolution.decision)
        ) {
          throw new Error("Codex approval response is not allowed by its request.");
        }
        return {
          actionId: resolution.actionId,
          decision: resolution.decision,
          interactionId,
          kind: "approval",
          resolvedAt: resolution.resolvedAt,
        };
      case "userInput":
        if (
          resolution.responseKind !== "userInput" ||
          resolution.decision !== "submit"
        ) {
          throw new Error("Codex user-input response does not match its request.");
        }
        return {
          actionId: resolution.actionId,
          decision: "submit",
          interactionId,
          kind: "userInput",
          resolvedAt: resolution.resolvedAt,
        };
      case "mcpElicitation":
        if (
          resolution.responseKind !== "mcpElicitation" ||
          resolution.decision === "approve" ||
          resolution.decision === "approveForSession"
        ) {
          throw new Error("Codex MCP response does not match its request.");
        }
        return {
          actionId: resolution.actionId,
          decision: resolution.decision,
          interactionId,
          kind: "mcpElicitation",
          resolvedAt: resolution.resolvedAt,
        };
    }
  }

  #mapTurnCompleted(
    notification: Extract<CodexNotification, { readonly method: "turn/completed" }>,
  ): ReadonlyArray<HarnessEvent> {
    if (!this.#ownsThread(notification.params.threadId)) return [];
    const nativeTurnId = notification.params.turn.id;
    if (this.#terminalTurns.has(nativeTurnId)) return [];
    const turnId = this.#turnId(nativeTurnId);
    const status = mapTurnStatus(notification.params.turn.status);
    if (status === undefined || status === "running") return [];
    const startEvents = this.#ensureTurnStarted(nativeTurnId);
    const cancelledInteractions = this.#cancelInteractionsForTurn(turnId);
    this.#terminalTurns.add(nativeTurnId);
    const completedActiveTurn =
      this.#activeTurnId === undefined || this.#activeTurnId === nativeTurnId;
    if (this.#activeTurnId === nativeTurnId) this.#activeTurnId = undefined;
    const failure =
      notification.params.turn.error === null ||
      notification.params.turn.error === undefined
        ? status === "failed"
          ? {
              code: "CodexTurnFailed",
              kind: "providerFailure" as const,
              message: "Codex turn failed.",
              recoverable: false,
            }
          : undefined
        : {
            code: "CodexTurnFailed",
            kind: "providerFailure" as const,
            message: this.#text(notification.params.turn.error.message),
            recoverable: false,
          };
    const events: Array<HarnessEvent> = [
      ...startEvents,
      ...cancelledInteractions,
      this.#event({
        ...(failure === undefined ? {} : { failure }),
        kind: "turnCompleted",
        sessionId: this.#options.sessionId,
        status,
        turnId,
      }),
    ];
    if (status === "failed" && completedActiveTurn) {
      events.push(
        this.#event({
          failure:
            failure ??
            ({
              code: "CodexTurnFailed",
              kind: "providerFailure",
              message: "Codex turn failed.",
              recoverable: false,
            } as const),
          kind: "sessionFailed",
          sessionId: this.#options.sessionId,
        }),
      );
    } else if (completedActiveTurn) {
      events.push(
        this.#event({
          kind: "sessionStateChanged",
          sessionId: this.#options.sessionId,
          state:
            this.#requestIds.size === 0 ? "idle" : "waitingForOperator",
        }),
      );
    }
    return events;
  }

  #mapPlan(
    notification: Extract<CodexNotification, { readonly method: "turn/plan/updated" }>,
  ): ReadonlyArray<HarnessEvent> {
    if (!this.#ownsThread(notification.params.threadId)) return [];
    const turnId = this.#turnId(notification.params.turnId);
    const startEvents = this.#ensureTurnStarted(notification.params.turnId);
    const key = notification.params.turnId;
    let itemId = this.#planItemIds.get(key);
    if (itemId === undefined) {
      itemId = this.#newItemId();
      this.#planItemIds.set(key, itemId);
    }
    return [
      ...startEvents,
      this.#event({
        final: false,
        item: {
          ...(notification.params.explanation === null ||
          notification.params.explanation === undefined
            ? {}
            : { explanation: this.#text(notification.params.explanation) }),
          itemId,
          kind: "plan",
          status: "streaming",
          steps: notification.params.plan.slice(0, 50).map(({ status, step }) => ({
            status,
            step: this.#brief(step),
          })),
          turnId,
        },
        kind: "itemUpserted",
        sessionId: this.#options.sessionId,
        turnId,
      }),
    ];
  }

  #cancelInteractionsForTurn(
    turnId: HarnessTurnId,
  ): ReadonlyArray<HarnessEvent> {
    const events: Array<HarnessEvent> = [];
    for (const [requestId, pending] of this.#requestIds) {
      if (
        "turnId" in pending.interaction &&
        pending.interaction.turnId === turnId
      ) {
        this.#requestIds.delete(requestId);
        events.push(
          this.#event({
            interactionId: pending.interactionId,
            kind: "interactionCancelled",
            reason: "turnTerminal",
            sessionId: this.#options.sessionId,
          }),
        );
      }
    }
    return events;
  }

  #mapItemLifecycle(
    notification: Extract<
      CodexNotification,
      { readonly method: "item/started" | "item/completed" }
    >,
    final: boolean,
  ): ReadonlyArray<HarnessEvent> {
    if (!this.#ownsThread(notification.params.threadId)) return [];
    const nativeItemId = notification.params.item.id;
    if (this.#finalItems.has(nativeItemId)) return [];
    if (notification.params.item.type === "reasoning") {
      if (final) this.#finalItems.add(nativeItemId);
      return [];
    }
    const turnId = this.#turnId(notification.params.turnId);
    const startEvents = this.#ensureTurnStarted(notification.params.turnId);
    const itemId = this.#itemId(nativeItemId);
    const item = this.#mapItem(notification.params.item, itemId, turnId, final);
    if (item === undefined) return [];
    if (final) {
      this.#finalItems.add(nativeItemId);
      this.#deltaEmittedCharacters.delete(nativeItemId);
      this.#messageBuffers.delete(nativeItemId);
    }
    return [
      ...startEvents,
      this.#event({
        final,
        item,
        kind: "itemUpserted",
        sessionId: this.#options.sessionId,
        turnId,
      }),
    ];
  }

  #mapDelta(
    notification: Extract<
      CodexNotification,
      {
        readonly method:
          | "item/agentMessage/delta"
          | "item/commandExecution/outputDelta";
      }
    >,
    deltaKind: "message" | "commandOutput",
  ): ReadonlyArray<HarnessEvent> {
    if (
      !this.#ownsThread(notification.params.threadId) ||
      this.#finalItems.has(notification.params.itemId)
    ) {
      return [];
    }
    const nativeItemId = notification.params.itemId;
    const emitted = this.#deltaEmittedCharacters.get(nativeItemId) ?? 0;
    const remaining = 65_536 - emitted;
    if (remaining <= 0) return [];
    const nextBuffer = this.#output(
      `${this.#messageBuffers.get(nativeItemId) ?? ""}${notification.params.delta}`,
    ).slice(0, remaining);
    if (nextBuffer.length < this.#deltaFlushCharacters) {
      this.#messageBuffers.set(nativeItemId, nextBuffer);
      return [];
    }
    this.#messageBuffers.delete(nativeItemId);
    this.#deltaEmittedCharacters.set(nativeItemId, emitted + nextBuffer.length);
    const itemId = this.#itemId(nativeItemId);
    const turnId = this.#turnId(notification.params.turnId);
    return [
      ...this.#ensureTurnStarted(notification.params.turnId),
      this.#event({
        chunk: nextBuffer,
        deltaKind,
        itemId,
        kind: "itemDeltaRecorded",
        sessionId: this.#options.sessionId,
        turnId,
      }),
    ];
  }

  #mapUsage(
    notification: Extract<
      CodexNotification,
      { readonly method: "thread/tokenUsage/updated" }
    >,
  ): ReadonlyArray<HarnessEvent> {
    if (!this.#ownsThread(notification.params.threadId)) return [];
    const nativeTurnId = notification.params.turnId;
    let itemId = this.#usageItemIds.get(nativeTurnId);
    if (itemId === undefined) {
      itemId = this.#newItemId();
      this.#usageItemIds.set(nativeTurnId, itemId);
    }
    const turnId = this.#turnId(notification.params.turnId);
    return [
      ...this.#ensureTurnStarted(notification.params.turnId),
      this.#event({
        final: false,
        item: {
          ...(notification.params.tokenUsage.total.cachedInputTokens === undefined
            ? {}
            : {
                cachedInputTokens:
                  notification.params.tokenUsage.total.cachedInputTokens,
              }),
          inputTokens: notification.params.tokenUsage.total.inputTokens,
          itemId,
          kind: "usage",
          outputTokens: notification.params.tokenUsage.total.outputTokens,
          turnId,
        },
        kind: "itemUpserted",
        sessionId: this.#options.sessionId,
        turnId,
      }),
    ];
  }

  #mapWarning(message: string): ReadonlyArray<HarnessEvent> {
    if (this.#threadId === undefined) return [];
    const itemId = this.#newItemId();
    return [
      this.#event({
        final: true,
        item: {
          itemId,
          kind: "warning",
          message: this.#text(message),
        },
        kind: "itemUpserted",
        sessionId: this.#options.sessionId,
      }),
    ];
  }

  #mapInteraction(
    request: CodexServerRequest,
    interactionId: HarnessInteractionId,
  ) {
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const workspacePath = this.#relativePath(request.params.cwd ?? this.#options.workspaceRoot);
        if (workspacePath === undefined) return undefined;
        return {
          allowedDecisions: ["approve", "approveForSession", "decline", "cancel"] as const,
          command: this.#text(request.params.command ?? "Command execution"),
          interactionId,
          itemId: this.#itemId(request.params.itemId),
          kind: "commandApproval" as const,
          ...(request.params.reason === null || request.params.reason === undefined
            ? {}
            : { reason: this.#text(request.params.reason) }),
          requestedAt: timestampFromMilliseconds(request.params.startedAtMs),
          turnId: this.#turnId(request.params.turnId),
          workspacePath,
        };
      }
      case "item/fileChange/requestApproval": {
        const grantRoot =
          request.params.grantRoot === null || request.params.grantRoot === undefined
            ? undefined
            : this.#relativePath(request.params.grantRoot);
        return {
          allowedDecisions: ["approve", "approveForSession", "decline", "cancel"] as const,
          interactionId,
          itemId: this.#itemId(request.params.itemId),
          kind: "fileChangeApproval" as const,
          paths: grantRoot === undefined ? [] : [grantRoot],
          ...(request.params.reason === null || request.params.reason === undefined
            ? {}
            : { reason: this.#text(request.params.reason) }),
          requestedAt: timestampFromMilliseconds(request.params.startedAtMs),
          turnId: this.#turnId(request.params.turnId),
        };
      }
      case "item/permissions/requestApproval":
        return {
          allowedDecisions: ["approve", "decline", "cancel"] as const,
          interactionId,
          itemId: this.#itemId(request.params.itemId),
          kind: "permissionApproval" as const,
          requestedAt: timestampFromMilliseconds(request.params.startedAtMs),
          summary: this.#text(request.params.reason ?? "Additional permissions requested"),
          turnId: this.#turnId(request.params.turnId),
        };
      case "item/tool/requestUserInput":
        return {
          interactionId,
          itemId: this.#itemId(request.params.itemId),
          kind: "userInput" as const,
          questions: request.params.questions.slice(0, 20).map((question, index) => ({
            options: (question.options ?? [])
              .slice(0, 20)
              .map(({ label }) => this.#label(label)),
            prompt: this.#brief(question.question),
            questionId: parseHarnessQuestionId(
              `${interactionId}-question-${index + 1}`,
            ),
            secret: question.isSecret ?? false,
          })),
          requestedAt: new Date(0).toISOString(),
          turnId: this.#turnId(request.params.turnId),
        };
      case "mcpServer/elicitation/request":
        return {
          interactionId,
          kind: "mcpElicitation" as const,
          message: this.#text(request.params.message),
          mode: request.params.mode,
          requestedAt: new Date(0).toISOString(),
          serverName: this.#text(request.params.serverName),
          ...(request.params.turnId === null || request.params.turnId === undefined
            ? {}
            : { turnId: this.#turnId(request.params.turnId) }),
        };
    }
  }

  #mapItem(
    item: CodexThreadItem,
    itemId: HarnessItemId,
    turnId: HarnessTurnId,
    final: boolean,
  ): HarnessItem | undefined {
    switch (item.type) {
      case "userMessage":
      case "reasoning":
        return undefined;
      case "agentMessage":
        return {
          itemId,
          kind: "message",
          phase:
            item.phase === "commentary"
              ? "commentary"
              : item.phase === "final_answer"
                ? "final"
                : "unknown",
          status: final ? "completed" : "streaming",
          text: this.#output(item.text),
          turnId,
        };
      case "plan":
        return {
          itemId,
          kind: "plan",
          status: final ? "completed" : "streaming",
          steps: [
            { status: final ? "completed" : "pending", step: this.#text(item.text) },
          ],
          turnId,
        };
      case "commandExecution": {
        const workspacePath = this.#relativePath(item.cwd);
        if (workspacePath === undefined) return undefined;
        return {
          command: this.#text(item.command),
          ...(item.durationMs === null || item.durationMs === undefined
            ? {}
            : { durationMs: item.durationMs }),
          ...(item.exitCode === null || item.exitCode === undefined
            ? {}
            : { exitCode: item.exitCode }),
          itemId,
          kind: "command",
          ...(item.aggregatedOutput === null || item.aggregatedOutput === undefined
            ? {}
            : { output: this.#output(item.aggregatedOutput) }),
          status: mapItemStatus(item.status),
          turnId,
          workspacePath,
        };
      }
      case "fileChange":
        return {
          changes: item.changes.slice(0, 20).flatMap((change) => {
            const publicPath = this.#relativePath(change.path);
            return publicPath === undefined
              ? []
              : [
                  {
                    diff: this.#diff(change.diff),
                    kind: mapFileChangeKind(change.kind),
                    path: publicPath,
                  },
                ];
          }),
          itemId,
          kind: "fileChange",
          status: mapItemStatus(item.status),
          turnId,
        };
      case "mcpToolCall":
        return {
          itemId,
          kind: "toolCall",
          serverName: this.#text(item.server),
          status: mapToolStatus(item.status),
          ...(item.error === null || item.error === undefined
            ? {}
            : { summary: this.#text(item.error.message) }),
          toolName: this.#text(item.tool),
          turnId,
        };
      case "dynamicToolCall":
        return {
          itemId,
          kind: "toolCall",
          status: mapToolStatus(item.status),
          toolName: this.#text(item.tool),
          turnId,
        };
      case "webSearch":
        return {
          itemId,
          kind: "toolCall",
          status: final ? "completed" : "running",
          summary: this.#text(item.query),
          toolName: "webSearch",
          turnId,
        };
      case "enteredReviewMode":
      case "exitedReviewMode":
        return {
          itemId,
          kind: "review",
          status: item.type === "enteredReviewMode" ? "entered" : "completed",
          summary: this.#output(item.review),
          turnId,
        };
      case "contextCompaction":
        return {
          itemId,
          kind: "warning",
          message: "Session context was compacted.",
          turnId,
        };
    }
  }

  #event(event: HarnessEvent): HarnessEvent {
    return parseHarnessEvent(event);
  }

  #ownsThread(nativeThreadId: string): boolean {
    return this.#threadId !== undefined && this.#threadId === nativeThreadId;
  }

  #turnId(nativeTurnId: string): HarnessTurnId {
    const existing = this.#turnIds.get(nativeTurnId);
    if (existing !== undefined) return existing;
    this.#turnCounter += 1;
    const created = parseHarnessTurnId(
      `${this.#options.sessionId}-turn-${this.#turnCounter}`,
    );
    this.#turnIds.set(nativeTurnId, created);
    return created;
  }

  #ensureTurnStarted(nativeTurnId: string): ReadonlyArray<HarnessEvent> {
    if (nativeTurnId.length === 0 || this.#startedTurns.has(nativeTurnId)) {
      return [];
    }
    this.#startedTurns.add(nativeTurnId);
    return [
      this.#event({
        kind: "turnStarted",
        sessionId: this.#options.sessionId,
        turnId: this.#turnId(nativeTurnId),
      }),
    ];
  }

  #itemId(nativeItemId: string): HarnessItemId {
    const existing = this.#itemIds.get(nativeItemId);
    if (existing !== undefined) return existing;
    const created = this.#newItemId();
    this.#itemIds.set(nativeItemId, created);
    return created;
  }

  #newItemId(): HarnessItemId {
    this.#itemCounter += 1;
    return parseHarnessItemId(
      `${this.#options.sessionId}-item-${this.#itemCounter}`,
    );
  }

  #interactionId(): HarnessInteractionId {
    this.#interactionCounter += 1;
    return parseHarnessInteractionId(
      `${this.#options.sessionId}-interaction-${this.#interactionCounter}`,
    );
  }

  #relativePath(input: string): WorkspaceRelativePath | undefined {
    const root = path.resolve(this.#options.workspaceRoot);
    const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return parseWorkspaceRelativePath(relative === "" ? "." : relative.split(path.sep).join("/"));
  }

  #text(input: string): string {
    return sanitizeText(input, this.#options, 16_384);
  }

  #brief(input: string): string {
    return sanitizeText(input, this.#options, 4_096);
  }

  #label(input: string): string {
    return sanitizeText(input, this.#options, 1_024);
  }

  #output(input: string): string {
    return sanitizeText(input, this.#options, 65_536);
  }

  #diff(input: string): string {
    return sanitizeText(input, this.#options, 32_768);
  }
}

function sanitizeText(
  input: string,
  options: CodexSessionMapperOptions,
  limit: number,
): string {
  let output = input.split(options.workspaceRoot).join(".");
  for (const sensitive of options.sensitiveValues ?? []) {
    if (sensitive.length > 0) output = output.split(sensitive).join("[REDACTED]");
  }
  output = output
    .replace(
      /(["']?)[A-Z_][A-Z0-9_]{1,63}\1\s*:\s*(?:"[^"]*"|'[^']*'|[^,\s}]+)/gu,
      "[environment]",
    )
    .replace(
      /(["']?)(?:authorization|proxy-authorization|x-api-key|api-key|password|secret|token)\1\s*:\s*(?:"(?:Basic\s+|Bearer\s+)?[^"]*"|'(?:Basic\s+|Bearer\s+)?[^']*'|(?:Basic\s+|Bearer\s+)?[^,\s}]+)/giu,
      "[credential]",
    )
    .replace(
      /\b[A-Za-z_][A-Za-z0-9_]{0,63}\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gu,
      "[environment]",
    )
    .replace(
      /\b[A-Z_][A-Z0-9_]{1,63}\s*:\s*(?:"[^"]*"|'[^']*'|\S+)/gu,
      "[environment]",
    )
    .replace(
      /\b(?:authorization|proxy-authorization|x-api-key|api-key|password|secret|token)\s*:\s*(?:Basic\s+|Bearer\s+)?\S+/giu,
      "[credential]",
    )
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})\b/gu,
      "[REDACTED]",
    )
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+(?::[^\s/@]*)?@/giu,
      "[REDACTED-AUTHORITY]@",
    )
    .replace(
      /(^|[^A-Za-z0-9_./])\/(?!\/)[^\s`"'<>)}\],;]+/gu,
      "$1[absolute-path]",
    )
    .replace(/\b[A-Za-z]:\\\S+/gu, "[absolute-path]");
  return output.slice(0, limit);
}

function timestampFromMilliseconds(value: number): string {
  return new Date(value).toISOString();
}

function mapThreadStatus(status: {
  readonly activeFlags?: ReadonlyArray<
    "waitingOnApproval" | "waitingOnUserInput"
  >;
  readonly type: string;
}) {
  switch (status.type) {
    case "idle":
    case "notLoaded":
      return "idle" as const;
    case "active":
      return (status.activeFlags?.length ?? 0) > 0
        ? ("waitingForOperator" as const)
        : ("running" as const);
    case "systemError":
      return "failed" as const;
    default:
      return undefined;
  }
}

function mapTurnStatus(status: string | undefined) {
  switch (status) {
    case "inProgress":
      return "running" as const;
    case "completed":
      return "completed" as const;
    case "interrupted":
      return "interrupted" as const;
    case "failed":
      return "failed" as const;
    default:
      return undefined;
  }
}

function mapItemStatus(status: "inProgress" | "completed" | "failed" | "declined") {
  return status === "inProgress" ? "running" : status;
}

function mapToolStatus(status: "inProgress" | "completed" | "failed") {
  return status === "inProgress" ? "running" : status;
}

function mapFileChangeKind(kind: { readonly type: string }) {
  switch (kind.type) {
    case "add":
    case "delete":
    case "update":
      return kind.type;
    default:
      return "unknown" as const;
  }
}
