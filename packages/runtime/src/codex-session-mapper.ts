import { createHash } from "node:crypto";
import path from "node:path";

import {
  parseHarnessEvent,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessQuestionId,
  parseHarnessTurnId,
  parseWorkspaceRelativePath,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  HarnessSessionIdSchema,
  type HarnessEvent,
  type HarnessInteractionId,
  type HarnessInteractionResolution,
  type HarnessItem,
  type HarnessItemId,
  type HarnessPendingInteraction,
  type HarnessPermissionScope,
  type HarnessQuestionId,
  type HarnessSessionId,
  type HarnessTurnId,
  type WorkspaceRelativePath,
} from "@gaia/core";
import { Schema } from "effect";

import {
  PermissionApprovalResponseSchema,
  parseCodexPermissionAbsolutePath,
  type CodexNotification,
  type CodexServerRequest,
  type CodexThreadItem,
  type CodexThread,
  type CodexRequestId,
  type CodexItemId,
  type CodexThreadId,
  type CodexTurnId,
} from "./codex-app-server-protocol.js";

/** Schema-owned configuration for one adapter-local Codex session mapper. */
export class CodexSessionMapperConfig extends Schema.Class<CodexSessionMapperConfig>(
  "CodexSessionMapperConfig"
)(
  {
    capabilities: HarnessCapabilities,
    deltaFlushCharacters: Schema.optionalKey(Schema.Number),
    provider: HarnessProviderDescriptor,
    sensitiveValues: Schema.optionalKey(Schema.Array(Schema.String)),
    sessionId: HarnessSessionIdSchema,
    workspaceRoot: Schema.NonEmptyString,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}
export type CodexSessionMapperOptions = CodexSessionMapperConfig;

/** Adapter-private mapper surface; provider messages are decoded before mapping. */
export interface CodexSessionMapper {
  readonly approvalDecisionAllowed: (
    requestId: CodexRequestId,
    decision: "approve" | "approveForSession" | "decline" | "cancel"
  ) => boolean;
  readonly mapNotification: (
    input: CodexNotification
  ) => ReadonlyArray<HarnessEvent>;
  readonly mapServerRequest: (
    input: CodexServerRequest
  ) => ReadonlyArray<HarnessEvent>;
  readonly mapRecoveredThread: (
    input: CodexThread
  ) => ReadonlyArray<HarnessEvent>;
  readonly mapUserInputAnswers: (
    requestId: CodexRequestId,
    answers: ReadonlyArray<{
      readonly answers: ReadonlyArray<string>;
      readonly questionId: HarnessQuestionId;
    }>
  ) => Record<string, { readonly answers: ReadonlyArray<string> }> | undefined;
  readonly permissionApproval: (
    requestId: CodexRequestId
  ) => typeof PermissionApprovalResponseSchema.Type.permissions | undefined;
  readonly resolveServerRequest: (
    requestId: CodexRequestId,
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
    }
  ) => ReadonlyArray<HarnessEvent>;
}

/** Compile-time contract for the provider-native identities held by mapper state. */
export type CodexSessionMapperNativeIdentityState = {
  readonly activeTurnId: CodexTurnId | undefined;
  readonly deltaEmittedCharacters: Map<CodexItemId, number>;
  readonly finalItems: Set<CodexItemId>;
  readonly itemIds: Map<CodexItemId, HarnessItemId>;
  readonly messageBuffers: Map<CodexItemId, string>;
  readonly planItemIds: Map<CodexTurnId, HarnessItemId>;
  readonly startedTurns: Set<CodexTurnId>;
  readonly terminalTurns: Set<CodexTurnId>;
  readonly threadId: CodexThreadId | undefined;
  readonly turnIds: Map<CodexTurnId, HarnessTurnId>;
  readonly usageItemIds: Map<CodexTurnId, HarnessItemId>;
};

/** Create a stateful adapter-local mapper with private vendor correlation state. */
export function createCodexSessionMapper(
  options: CodexSessionMapperOptions
): CodexSessionMapper {
  const state = new MapperState(
    Schema.decodeUnknownSync(CodexSessionMapperConfig)(options)
  );
  return {
    approvalDecisionAllowed: (requestId, decision) =>
      state.approvalDecisionAllowed(requestId, decision),
    mapNotification: (input) => state.mapNotification(input),
    mapServerRequest: (input) => state.mapServerRequest(input),
    mapRecoveredThread: (input) => state.mapRecoveredThread(input),
    mapUserInputAnswers: (requestId, answers) =>
      state.mapUserInputAnswers(requestId, answers),
    permissionApproval: (requestId) => state.permissionApproval(requestId),
    resolveServerRequest: (requestId, resolution) =>
      state.resolveServerRequest(requestId, resolution),
  };
}

class MapperState {
  readonly #auditedPermissionGrants = new Map<
    CodexRequestId,
    typeof PermissionApprovalResponseSchema.Type.permissions
  >();
  #bufferedDeltaBytes = 0;
  readonly #deltaFlushCharacters: number;
  readonly #deltaEmittedCharacters: CodexSessionMapperNativeIdentityState["deltaEmittedCharacters"] =
    new Map();
  readonly #finalItems: CodexSessionMapperNativeIdentityState["finalItems"] =
    new Set();
  readonly #itemIds: CodexSessionMapperNativeIdentityState["itemIds"] =
    new Map();
  readonly #messageBuffers: CodexSessionMapperNativeIdentityState["messageBuffers"] =
    new Map();
  readonly #options: CodexSessionMapperOptions;
  readonly #planItemIds: CodexSessionMapperNativeIdentityState["planItemIds"] =
    new Map();
  readonly #requestIds = new Map<
    CodexRequestId,
    {
      readonly interaction: HarnessPendingInteraction;
      readonly interactionId: HarnessInteractionId;
      readonly questionIds?: ReadonlyMap<HarnessQuestionId, string>;
    }
  >();
  readonly #seenRequestIds = new Set<CodexRequestId>();
  readonly #startedTurns: CodexSessionMapperNativeIdentityState["startedTurns"] =
    new Set();
  readonly #terminalTurns: CodexSessionMapperNativeIdentityState["terminalTurns"] =
    new Set();
  readonly #turnIds: CodexSessionMapperNativeIdentityState["turnIds"] =
    new Map();
  readonly #usageItemIds: CodexSessionMapperNativeIdentityState["usageItemIds"] =
    new Map();
  #activeTurnId: CodexSessionMapperNativeIdentityState["activeTurnId"];
  #threadId: CodexSessionMapperNativeIdentityState["threadId"];

  constructor(options: CodexSessionMapperOptions) {
    this.#options = options;
    this.#deltaFlushCharacters = Math.max(
      1,
      Math.trunc(options.deltaFlushCharacters ?? 1_024)
    );
  }

  mapNotification(
    notification: CodexNotification
  ): ReadonlyArray<HarnessEvent> {
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
        if (notification.params.status.type === "systemError") {
          return [
            this.#event({
              failure: {
                code: "CodexThreadSystemError",
                kind: "providerFailure",
                message: "Codex session entered a system error state.",
                recoverable: true,
              },
              kind: "sessionFailed",
              sessionId: this.#options.sessionId,
            }),
          ];
        }
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
      case "item/fileChange/outputDelta":
      case "item/fileChange/patchUpdated":
        return [];
      case "thread/tokenUsage/updated":
        return this.#mapUsage(notification);
      case "warning":
        return typeof notification.params.threadId === "string" &&
          this.#ownsThread(notification.params.threadId)
          ? this.#mapWarning(notification.params.message)
          : [];
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

    const interactionId = this.#interactionId(request);
    const interaction = this.#mapInteraction(request, interactionId);
    if (interaction === undefined) return [];
    this.#seenRequestIds.add(request.id);
    let questionIds: Map<HarnessQuestionId, string> | undefined;
    if (
      request.method === "item/tool/requestUserInput" &&
      interaction.kind === "userInput"
    ) {
      questionIds = new Map();
      for (const [index, question] of interaction.questions.entries()) {
        const nativeQuestion = request.params.questions[index];
        if (nativeQuestion === undefined) return [];
        questionIds.set(question.questionId, nativeQuestion.id);
      }
    }
    this.#requestIds.set(request.id, {
      interaction,
      interactionId,
      ...(questionIds === undefined ? {} : { questionIds }),
    });
    const turnEvents =
      request.method === "mcpServer/elicitation/request"
        ? request.params.turnId == null
          ? []
          : this.#ensureTurnStarted(request.params.turnId)
        : this.#ensureTurnStarted(request.params.turnId);
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

  mapRecoveredThread(thread: CodexThread): ReadonlyArray<HarnessEvent> {
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
                completedAtMs: 0,
                item,
                threadId: thread.id,
                turnId: turn.id,
              },
            },
            true
          )
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
          })
        );
      }
    }
    this.#activeTurnId = [...(thread.turns ?? [])]
      .reverse()
      .find((turn) => turn.status === "inProgress")?.id;
    const state = mapThreadStatus(thread.status ?? { type: "idle" });
    if (thread.status?.type === "systemError") {
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
        })
      );
    } else if (state !== undefined) {
      events.push(
        this.#event({
          kind: "sessionStateChanged",
          sessionId: this.#options.sessionId,
          state,
        })
      );
    }
    return events;
  }

  mapUserInputAnswers(
    requestId: CodexRequestId,
    answers: ReadonlyArray<{
      readonly answers: ReadonlyArray<string>;
      readonly questionId: HarnessQuestionId;
    }>
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

  approvalDecisionAllowed(
    requestId: CodexRequestId,
    decision: "approve" | "approveForSession" | "decline" | "cancel"
  ): boolean {
    const interaction = this.#requestIds.get(requestId)?.interaction;
    return (
      interaction !== undefined &&
      (interaction.kind === "commandApproval" ||
        interaction.kind === "fileChangeApproval" ||
        interaction.kind === "permissionApproval") &&
      interaction.allowedDecisions.includes(decision)
    );
  }

  permissionApproval(
    requestId: CodexRequestId
  ): typeof PermissionApprovalResponseSchema.Type.permissions | undefined {
    return this.#auditedPermissionGrants.get(requestId);
  }

  resolveServerRequest(
    requestId: CodexRequestId,
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
    }
  ): ReadonlyArray<HarnessEvent> {
    const pending = this.#requestIds.get(requestId);
    if (pending === undefined) return [];
    const coreResolution = this.#resolution(
      pending.interaction,
      pending.interactionId,
      resolution
    );
    this.#requestIds.delete(requestId);
    this.#auditedPermissionGrants.delete(requestId);
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
    this.#auditedPermissionGrants.delete(requestId);
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
    }
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
          throw new Error(
            "Codex approval response is not allowed by its request."
          );
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
          throw new Error(
            "Codex user-input response does not match its request."
          );
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
    notification: Extract<
      CodexNotification,
      { readonly method: "turn/completed" }
    >
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
        })
      );
    } else if (completedActiveTurn) {
      events.push(
        this.#event({
          kind: "sessionStateChanged",
          sessionId: this.#options.sessionId,
          state: this.#requestIds.size === 0 ? "idle" : "waitingForOperator",
        })
      );
    }
    return events;
  }

  #mapPlan(
    notification: Extract<
      CodexNotification,
      { readonly method: "turn/plan/updated" }
    >
  ): ReadonlyArray<HarnessEvent> {
    if (!this.#ownsThread(notification.params.threadId)) return [];
    const turnId = this.#turnId(notification.params.turnId);
    const startEvents = this.#ensureTurnStarted(notification.params.turnId);
    const key = notification.params.turnId;
    let itemId = this.#planItemIds.get(key);
    if (itemId === undefined) {
      itemId = this.#stableItemId(`plan:${key}`);
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
          steps: notification.params.plan
            .slice(0, 50)
            .map(({ status, step }) => ({
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
    turnId: HarnessTurnId
  ): ReadonlyArray<HarnessEvent> {
    const events: Array<HarnessEvent> = [];
    for (const [requestId, pending] of this.#requestIds) {
      if (
        "turnId" in pending.interaction &&
        pending.interaction.turnId === turnId
      ) {
        this.#requestIds.delete(requestId);
        this.#auditedPermissionGrants.delete(requestId);
        events.push(
          this.#event({
            interactionId: pending.interactionId,
            kind: "interactionCancelled",
            reason: "turnTerminal",
            sessionId: this.#options.sessionId,
          })
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
    final: boolean
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
      this.#deleteMessageBuffer(nativeItemId);
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
    deltaKind: "message" | "commandOutput"
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
      `${this.#messageBuffers.get(nativeItemId) ?? ""}${notification.params.delta}`
    ).slice(0, remaining);
    if (nextBuffer.length < this.#deltaFlushCharacters) {
      this.#setMessageBuffer(nativeItemId, nextBuffer);
      return [];
    }
    this.#deleteMessageBuffer(nativeItemId);
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
    >
  ): ReadonlyArray<HarnessEvent> {
    if (!this.#ownsThread(notification.params.threadId)) return [];
    const nativeTurnId = notification.params.turnId;
    let itemId = this.#usageItemIds.get(nativeTurnId);
    if (itemId === undefined) {
      itemId = this.#stableItemId(`usage:${nativeTurnId}`);
      this.#usageItemIds.set(nativeTurnId, itemId);
    }
    const turnId = this.#turnId(notification.params.turnId);
    return [
      ...this.#ensureTurnStarted(notification.params.turnId),
      this.#event({
        final: false,
        item: {
          ...(notification.params.tokenUsage.total.cachedInputTokens ===
          undefined
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
    const itemId = this.#stableItemId(`warning:${message}`);
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
    interactionId: HarnessInteractionId
  ) {
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const workspacePath = this.#relativePath(
          request.params.cwd ?? this.#options.workspaceRoot
        );
        const audited =
          workspacePath !== undefined &&
          (request.params.networkApprovalContext === null ||
            request.params.networkApprovalContext === undefined) &&
          (request.params.proposedExecpolicyAmendment?.length ?? 0) === 0 &&
          (request.params.proposedNetworkPolicyAmendments?.length ?? 0) === 0;
        return {
          allowedDecisions: audited
            ? (["approve", "approveForSession", "decline", "cancel"] as const)
            : (["decline", "cancel"] as const),
          command: this.#text(request.params.command ?? "Command execution"),
          interactionId,
          itemId: this.#itemId(request.params.itemId),
          kind: "commandApproval" as const,
          reason: audited
            ? this.#text(request.params.reason ?? "Command execution approval")
            : "Command scope could not be safely represented; approval is disabled.",
          requestedAt: timestampFromMilliseconds(request.params.startedAtMs),
          turnId: this.#turnId(request.params.turnId),
          workspacePath: workspacePath ?? parseWorkspaceRelativePath("."),
        };
      }
      case "item/fileChange/requestApproval": {
        const grantRoot =
          request.params.grantRoot === null ||
          request.params.grantRoot === undefined
            ? undefined
            : this.#relativePath(request.params.grantRoot);
        const audited =
          request.params.grantRoot === null ||
          request.params.grantRoot === undefined ||
          grantRoot !== undefined;
        return {
          allowedDecisions: audited
            ? (["approve", "approveForSession", "decline", "cancel"] as const)
            : (["decline", "cancel"] as const),
          interactionId,
          itemId: this.#itemId(request.params.itemId),
          kind: "fileChangeApproval" as const,
          paths: grantRoot === undefined ? [] : [grantRoot],
          reason: audited
            ? this.#text(request.params.reason ?? "File change approval")
            : "File grant is outside the accepted workspace; approval is disabled.",
          requestedAt: timestampFromMilliseconds(request.params.startedAtMs),
          turnId: this.#turnId(request.params.turnId),
        };
      }
      case "item/permissions/requestApproval": {
        const audited = this.#auditPermissionScope(request.params.permissions);
        if (audited !== undefined) {
          this.#auditedPermissionGrants.set(request.id, audited.grant);
        }
        return {
          allowedDecisions:
            audited === undefined
              ? (["decline", "cancel"] as const)
              : (["approve", "decline", "cancel"] as const),
          interactionId,
          itemId: this.#itemId(request.params.itemId),
          kind: "permissionApproval" as const,
          requestedAt: timestampFromMilliseconds(request.params.startedAtMs),
          scope:
            audited?.scope ??
            ({
              fileSystem: [],
              network: "notRequested",
            } satisfies HarnessPermissionScope),
          summary:
            audited === undefined
              ? "Permission scope could not be safely represented; approval is disabled."
              : this.#text(
                  request.params.reason ?? "Additional permissions requested"
                ),
          turnId: this.#turnId(request.params.turnId),
        };
      }
      case "item/tool/requestUserInput":
        return {
          interactionId,
          itemId: this.#itemId(request.params.itemId),
          kind: "userInput" as const,
          questions: request.params.questions
            .slice(0, 20)
            .map((question, index) => ({
              options: (question.options ?? [])
                .slice(0, 20)
                .map(({ label }) => this.#label(label)),
              prompt: this.#brief(question.question),
              questionId: parseHarnessQuestionId(
                `${interactionId}-question-${index + 1}`
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
          ...(request.params.turnId === null ||
          request.params.turnId === undefined
            ? {}
            : { turnId: this.#turnId(request.params.turnId) }),
        };
    }
  }

  #mapItem(
    item: CodexThreadItem,
    itemId: HarnessItemId,
    turnId: HarnessTurnId,
    final: boolean
  ): HarnessItem | undefined {
    switch (item.type) {
      case "userMessage":
      case "hookPrompt":
      case "reasoning":
      case "collabAgentToolCall":
      case "imageView":
      case "imageGeneration":
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
            {
              status: final ? "completed" : "pending",
              step: this.#text(item.text),
            },
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
          ...(item.aggregatedOutput === null ||
          item.aggregatedOutput === undefined
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

  #ownsThread(nativeThreadId: CodexThreadId): boolean {
    return this.#threadId !== undefined && this.#threadId === nativeThreadId;
  }

  #turnId(nativeTurnId: CodexTurnId): HarnessTurnId {
    const existing = this.#turnIds.get(nativeTurnId);
    if (existing !== undefined) return existing;
    const created = parseHarnessTurnId(
      `turn-${this.#opaqueId("turn", nativeTurnId)}`
    );
    this.#turnIds.set(nativeTurnId, created);
    return created;
  }

  #ensureTurnStarted(nativeTurnId: CodexTurnId): ReadonlyArray<HarnessEvent> {
    if (this.#startedTurns.has(nativeTurnId)) {
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

  #itemId(nativeItemId: CodexItemId): HarnessItemId {
    const existing = this.#itemIds.get(nativeItemId);
    if (existing !== undefined) return existing;
    const created = this.#stableItemId(`item:${nativeItemId}`);
    this.#itemIds.set(nativeItemId, created);
    return created;
  }

  #stableItemId(nativeKey: string): HarnessItemId {
    return parseHarnessItemId(`item-${this.#opaqueId("item", nativeKey)}`);
  }

  #interactionId(request: CodexServerRequest): HarnessInteractionId {
    const nativeKey = [
      typeof request.id,
      String(request.id),
      request.method,
      request.params.threadId,
      request.params.turnId ?? "",
      "itemId" in request.params ? request.params.itemId : "",
    ].join("\0");
    return parseHarnessInteractionId(
      `interaction-${this.#opaqueId("interaction", nativeKey)}`
    );
  }

  #opaqueId(kind: string, nativeId: string): string {
    return createHash("sha256")
      .update(`${this.#options.sessionId}\0${kind}\0${nativeId}`, "utf8")
      .digest("base64url")
      .slice(0, 22);
  }

  #relativePath(input: string): WorkspaceRelativePath | undefined {
    const root = path.resolve(this.#options.workspaceRoot);
    const resolved = path.isAbsolute(input)
      ? path.resolve(input)
      : path.resolve(root, input);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      return undefined;
    return parseWorkspaceRelativePath(
      relative === "" ? "." : relative.split(path.sep).join("/")
    );
  }

  #auditPermissionScope(
    permissions: Extract<
      CodexServerRequest,
      { readonly method: "item/permissions/requestApproval" }
    >["params"]["permissions"]
  ):
    | {
        readonly grant: typeof PermissionApprovalResponseSchema.Type.permissions;
        readonly scope: HarnessPermissionScope;
      }
    | undefined {
    const fileSystem: Array<{
      readonly access: "read" | "write" | "deny";
      readonly path: WorkspaceRelativePath;
    }> = [];
    const addPath = (
      absolutePath: string,
      access: "read" | "write" | "deny"
    ): boolean => {
      const relative = this.#relativePath(absolutePath);
      if (relative === undefined) return false;
      if (
        !fileSystem.some(
          (entry) => entry.access === access && entry.path === relative
        )
      ) {
        fileSystem.push({ access, path: relative });
      }
      return true;
    };

    const nativeFileSystem = permissions.fileSystem;
    if (nativeFileSystem != null) {
      if (nativeFileSystem.globScanMaxDepth != null) return undefined;
      for (const absolutePath of nativeFileSystem.read ?? []) {
        if (!addPath(absolutePath, "read")) return undefined;
      }
      for (const absolutePath of nativeFileSystem.write ?? []) {
        if (!addPath(absolutePath, "write")) return undefined;
      }
      for (const entry of nativeFileSystem.entries ?? []) {
        if (
          entry.path.type !== "path" ||
          !addPath(entry.path.path, entry.access)
        ) {
          return undefined;
        }
      }
    }
    if (fileSystem.length > 200) return undefined;

    const nativeNetwork = permissions.network;
    const network =
      nativeNetwork == null
        ? ("notRequested" as const)
        : nativeNetwork.enabled === true
          ? ("enabled" as const)
          : nativeNetwork.enabled === false
            ? ("disabled" as const)
            : ("unspecified" as const);
    const grant: typeof PermissionApprovalResponseSchema.Type.permissions = {
      ...(nativeFileSystem == null
        ? {}
        : {
            fileSystem: {
              entries: fileSystem.map((entry) => ({
                access: entry.access,
                path: {
                  path: parseCodexPermissionAbsolutePath(
                    path.resolve(this.#options.workspaceRoot, entry.path)
                  ),
                  type: "path" as const,
                },
              })),
              read: null,
              write: null,
            },
          }),
      ...(nativeNetwork == null
        ? {}
        : {
            network:
              nativeNetwork.enabled === undefined
                ? {}
                : { enabled: nativeNetwork.enabled },
          }),
    };

    return {
      grant,
      scope: { fileSystem, network },
    };
  }

  #setMessageBuffer(nativeItemId: CodexItemId, value: string): void {
    const existing = this.#messageBuffers.get(nativeItemId);
    if (existing === undefined && this.#messageBuffers.size >= 1_000) {
      throw new Error("Codex delta buffer exceeded its item limit.");
    }
    const existingBytes =
      existing === undefined
        ? 0
        : new TextEncoder().encode(existing).byteLength;
    const nextBytes = new TextEncoder().encode(value).byteLength;
    const aggregate = this.#bufferedDeltaBytes - existingBytes + nextBytes;
    if (aggregate > 1_048_576) {
      throw new Error("Codex delta buffer exceeded its byte limit.");
    }
    this.#bufferedDeltaBytes = aggregate;
    this.#messageBuffers.set(nativeItemId, value);
  }

  #deleteMessageBuffer(nativeItemId: CodexItemId): void {
    const existing = this.#messageBuffers.get(nativeItemId);
    if (existing === undefined) return;
    this.#bufferedDeltaBytes -= new TextEncoder().encode(existing).byteLength;
    this.#messageBuffers.delete(nativeItemId);
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
  limit: number
): string {
  let output = input;
  for (const sensitive of [...(options.sensitiveValues ?? [])].sort(
    (left, right) => right.length - left.length
  )) {
    if (sensitive.length > 0)
      output = output.split(sensitive).join("[REDACTED]");
  }
  output = output.split(options.workspaceRoot).join(".");
  output = output
    .replace(
      /(?<![A-Za-z0-9_])(["']?)(?:[A-Za-z][A-Za-z0-9]{0,31})?(?:Secret|Token|Password|[Aa]piKey|Authorization)\1\s*:\s*(?:"(?:Basic\s+|Bearer\s+)?[^"]*"|'(?:Basic\s+|Bearer\s+)?[^']*'|(?:Basic\s+|Bearer\s+)?[^,\s}]+)/gu,
      "[credential]"
    )
    .replace(
      /(["']?)[A-Z_][A-Z0-9_]{1,63}\1\s*:\s*(?:"[^"]*"|'[^']*'|[^,\s}]+)/gu,
      "[environment]"
    )
    .replace(
      /(?<![A-Za-z0-9_-])(["']?)(?:(?:[A-Za-z0-9]{1,32}[_-]){0,4}(?:authorization|proxy[_-]authorization|x[_-]api[_-]key|api[_-]key|password|secret|token))\1\s*:\s*(?:"(?:Basic\s+|Bearer\s+)?[^"]*"|'(?:Basic\s+|Bearer\s+)?[^']*'|(?:Basic\s+|Bearer\s+)?[^,\s}]+)/giu,
      "[credential]"
    )
    .replace(
      /\b[A-Za-z_][A-Za-z0-9_]{0,63}\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gu,
      "[environment]"
    )
    .replace(
      /\b[A-Z_][A-Z0-9_]{1,63}\s*:\s*(?:"[^"]*"|'[^']*'|\S+)/gu,
      "[environment]"
    )
    .replace(
      /\b(?:(?:[A-Za-z0-9]{1,32}[_-]){0,4}(?:authorization|proxy[_-]authorization|x[_-]api[_-]key|api[_-]key|password|secret|token))\s*:\s*(?:Basic\s+|Bearer\s+)?\S+/giu,
      "[credential]"
    )
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})\b/gu,
      "[REDACTED]"
    )
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+(?::[^\s/@]*)?@/giu,
      "[REDACTED-AUTHORITY]@"
    );
  output = redactQuotedAbsolutePaths(output);
  output = output
    .replace(/\\\\(?:\\ |[^\s`"'<>)}\],;])+/gu, "[absolute-path]")
    .replace(
      /(^|[^A-Za-z0-9_./])\/(?!\/)(?:\\ |[^\s`"'<>)}\],;])+/gu,
      "$1[absolute-path]"
    )
    .replace(/\b[A-Za-z]:\\(?:\\ |[^\s`"'<>)}\],;])+/gu, "[absolute-path]");
  return output.slice(0, limit);
}

function redactQuotedAbsolutePaths(input: string): string {
  const fragments: Array<string> = [];
  let copiedFrom = 0;
  let cursor = 0;

  while (cursor < input.length) {
    const delimiter = input[cursor];
    if (
      !isPathDelimiter(delimiter) ||
      !hasAbsolutePathPrefix(input, cursor + 1)
    ) {
      cursor += 1;
      continue;
    }

    const openingIndex = cursor;
    let boundaryIndex = input.length;
    let closed = false;
    let escaped = false;
    cursor += 1;

    while (cursor < input.length) {
      const character = input[cursor];
      if (character === "\r" || character === "\n") {
        boundaryIndex = cursor;
        break;
      }
      if (escaped) {
        escaped = false;
        cursor += 1;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        cursor += 1;
        continue;
      }
      if (character === delimiter) {
        boundaryIndex = cursor + 1;
        closed = true;
        break;
      }
      cursor += 1;
    }

    fragments.push(input.slice(copiedFrom, openingIndex));
    fragments.push(
      closed
        ? `${delimiter}[absolute-path]${delimiter}`
        : `${delimiter}[absolute-path]`
    );
    copiedFrom = boundaryIndex;
    cursor = boundaryIndex;
  }

  fragments.push(input.slice(copiedFrom));
  return fragments.join("");
}

function isPathDelimiter(value: string | undefined): value is '"' | "'" | "`" {
  return value === '"' || value === "'" || value === "`";
}

function hasAbsolutePathPrefix(input: string, index: number): boolean {
  const first = input[index];
  if (first === "/") return true;
  if (first === "\\") return input[index + 1] === "\\";
  return (
    isAsciiLetter(first) &&
    input[index + 1] === ":" &&
    (input[index + 2] === "\\" || input[index + 2] === "/")
  );
}

function isAsciiLetter(value: string | undefined): boolean {
  return (
    value !== undefined &&
    ((value >= "A" && value <= "Z") || (value >= "a" && value <= "z"))
  );
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

function mapItemStatus(
  status: "inProgress" | "completed" | "failed" | "declined"
) {
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
