import { readFileSync } from "node:fs";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CodexNotificationBoundarySchema,
  CodexServerRequestBoundarySchema,
  ModelListBoundaryResultSchema,
  ThreadListBoundaryResultSchema,
  supportedCodexCliVersion,
} from "./codex-app-server-protocol.js";

const schemaPaths = [
  "ClientRequest.json",
  "CommandExecutionRequestApprovalParams.json",
  "CommandExecutionRequestApprovalResponse.json",
  "FileChangeRequestApprovalParams.json",
  "FileChangeRequestApprovalResponse.json",
  "McpServerElicitationRequestParams.json",
  "McpServerElicitationRequestResponse.json",
  "PermissionsRequestApprovalParams.json",
  "PermissionsRequestApprovalResponse.json",
  "RequestId.json",
  "ServerNotification.json",
  "ServerRequest.json",
  "ToolRequestUserInputParams.json",
  "ToolRequestUserInputResponse.json",
  "v1/InitializeParams.json",
  "v1/InitializeResponse.json",
  "v2/AgentMessageDeltaNotification.json",
  "v2/CommandExecutionOutputDeltaNotification.json",
  "v2/ErrorNotification.json",
  "v2/FileChangeOutputDeltaNotification.json",
  "v2/FileChangePatchUpdatedNotification.json",
  "v2/ItemCompletedNotification.json",
  "v2/ItemStartedNotification.json",
  "v2/ModelListParams.json",
  "v2/ModelListResponse.json",
  "v2/ServerRequestResolvedNotification.json",
  "v2/ThreadListParams.json",
  "v2/ThreadListResponse.json",
  "v2/ThreadReadParams.json",
  "v2/ThreadReadResponse.json",
  "v2/ThreadResumeParams.json",
  "v2/ThreadResumeResponse.json",
  "v2/ThreadStartParams.json",
  "v2/ThreadStartResponse.json",
  "v2/ThreadStartedNotification.json",
  "v2/ThreadStatusChangedNotification.json",
  "v2/ThreadTokenUsageUpdatedNotification.json",
  "v2/TurnCompletedNotification.json",
  "v2/TurnDiffUpdatedNotification.json",
  "v2/TurnInterruptParams.json",
  "v2/TurnInterruptResponse.json",
  "v2/TurnPlanUpdatedNotification.json",
  "v2/TurnStartParams.json",
  "v2/TurnStartResponse.json",
  "v2/TurnStartedNotification.json",
  "v2/TurnSteerParams.json",
  "v2/TurnSteerResponse.json",
  "v2/WarningNotification.json",
] as const;

class PinnedCodexSchemaSet extends Schema.Class<PinnedCodexSchemaSet>(
  "PinnedCodexSchemaSet"
)(
  {
    facts: Schema.Struct({
      activePermissionProfileRequired: Schema.Array(Schema.String),
      additionalFileSystemPermissionsRequired: Schema.Array(Schema.String),
      additionalNetworkPermissionsRequired: Schema.Array(Schema.String),
      commandApprovalDecisionVariants: Schema.Array(Schema.String),
      elicitationRequestRequired: Schema.Array(Schema.String),
      elicitationResponseRequired: Schema.Array(Schema.String),
      gitInfoRequired: Schema.Array(Schema.String),
      granularApprovalPolicyAdditionalProperties: Schema.Boolean,
      itemCompletedRequired: Schema.Array(Schema.String),
      itemStartedRequired: Schema.Array(Schema.String),
      modelListRequired: Schema.Array(Schema.String),
      modelRequired: Schema.Array(Schema.String),
      modelUpgradeInfoRequired: Schema.Array(Schema.String),
      mcpElicitationSchemaAdditionalProperties: Schema.Boolean,
      mcpElicitationSchemaRequired: Schema.Array(Schema.String),
      notificationMethods: Schema.Array(Schema.String),
      permissionApprovalResponseRequired: Schema.Array(Schema.String),
      permissionApprovalScopeDefault: Schema.String,
      permissionRequestRequired: Schema.Array(Schema.String),
      requestIdIntegerFormat: Schema.String,
      requestIdTypes: Schema.Array(Schema.String),
      requestPermissionProfileAdditionalProperties: Schema.Boolean,
      requestPermissionProfileRequired: Schema.Array(Schema.String),
      threadItemRequired: Schema.Record(
        Schema.String,
        Schema.Array(Schema.String)
      ),
      threadItemTypes: Schema.Array(Schema.String),
      threadTimestampFormats: Schema.Struct({
        createdAt: Schema.String,
        updatedAt: Schema.String,
      }),
      threadListRequired: Schema.Array(Schema.String),
      threadRequired: Schema.Array(Schema.String),
      threadResumeRequired: Schema.Array(Schema.String),
      threadStartRequired: Schema.Array(Schema.String),
      threadTokenUsageRequired: Schema.Array(Schema.String),
      tokenUsageBreakdownRequired: Schema.Array(Schema.String),
      tokenUsageIntegerFormats: Schema.Record(Schema.String, Schema.String),
      turnPlanRequired: Schema.Array(Schema.String),
      turnTimingFormats: Schema.Struct({
        completedAt: Schema.String,
        durationMs: Schema.String,
        startedAt: Schema.String,
      }),
      turnRequired: Schema.Array(Schema.String),
      turnsPageRequired: Schema.Array(Schema.String),
      itemLifecycleTimestampFormats: Schema.Struct({
        completedAtMs: Schema.String,
        startedAtMs: Schema.String,
      }),
    }),
    generatedBy: Schema.Literal("codex-cli 0.137.0"),
    schemas: Schema.Record(
      Schema.String,
      Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)))
    ),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

const pinned = Schema.decodeUnknownSync(PinnedCodexSchemaSet)(
  JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/codex-app-server-0.137.0-recovery.schema.json",
        import.meta.url
      ),
      "utf8"
    )
  )
);

describe("pinned Codex App Server 0.137.0 generated-schema parity", () => {
  it("pins every touched request, response, server-request, and curated notification family", () => {
    expect(supportedCodexCliVersion).toBe("0.137.0");
    expect(pinned.generatedBy).toBe("codex-cli 0.137.0");
    expect(Object.keys(pinned.schemas).toSorted()).toEqual(
      [...schemaPaths].toSorted()
    );
  });

  it("pins the exact raw wire facts that Gaia refines or projects", () => {
    expect(pinned.facts.requestIdTypes).toEqual(["string", "integer"]);
    expect(pinned.facts.requestIdIntegerFormat).toBe("int64");
    expect(pinned.facts.threadTimestampFormats).toEqual({
      createdAt: "int64",
      updatedAt: "int64",
    });
    expect(pinned.facts.turnTimingFormats).toEqual({
      completedAt: "int64",
      durationMs: "int64",
      startedAt: "int64",
    });
    expect(pinned.facts.itemLifecycleTimestampFormats).toEqual({
      completedAtMs: "int64",
      startedAtMs: "int64",
    });
    expect(pinned.facts.tokenUsageIntegerFormats).toEqual({
      cachedInputTokens: "int64",
      inputTokens: "int64",
      outputTokens: "int64",
      reasoningOutputTokens: "int64",
      totalTokens: "int64",
    });
    expect(pinned.facts.activePermissionProfileRequired).toEqual(["id"]);
    expect(pinned.facts.gitInfoRequired).toEqual([]);
    expect(pinned.facts.granularApprovalPolicyAdditionalProperties).toBe(false);
    expect(pinned.facts.threadListRequired).toEqual(["data"]);
    expect(pinned.facts.modelListRequired).toEqual(["data"]);
    expect(pinned.facts.modelRequired).toEqual([
      "defaultReasoningEffort",
      "description",
      "displayName",
      "hidden",
      "id",
      "isDefault",
      "model",
      "supportedReasoningEfforts",
    ]);
    expect(pinned.facts.modelUpgradeInfoRequired).toEqual(["model"]);
    expect(pinned.facts.additionalFileSystemPermissionsRequired).toEqual([]);
    expect(pinned.facts.additionalNetworkPermissionsRequired).toEqual([]);
    expect(pinned.facts.requestPermissionProfileRequired).toEqual([]);
    expect(pinned.facts.requestPermissionProfileAdditionalProperties).toBe(
      false
    );
    expect(pinned.facts.permissionRequestRequired).toEqual([
      "cwd",
      "itemId",
      "permissions",
      "startedAtMs",
      "threadId",
      "turnId",
    ]);
    expect(pinned.facts.elicitationRequestRequired).toEqual([
      "serverName",
      "threadId",
    ]);
    expect(pinned.facts.mcpElicitationSchemaRequired).toEqual([
      "properties",
      "type",
    ]);
    expect(pinned.facts.mcpElicitationSchemaAdditionalProperties).toBe(false);
    expect(pinned.facts.commandApprovalDecisionVariants).toEqual([
      "accept",
      "acceptForSession",
      "acceptWithExecpolicyAmendment",
      "applyNetworkPolicyAmendment",
      "decline",
      "cancel",
    ]);
    expect(pinned.facts.permissionApprovalResponseRequired).toEqual([
      "permissions",
    ]);
    expect(pinned.facts.permissionApprovalScopeDefault).toBe("turn");
    expect(pinned.facts.elicitationResponseRequired).toEqual(["action"]);
    expect(pinned.facts.itemStartedRequired).toEqual([
      "item",
      "startedAtMs",
      "threadId",
      "turnId",
    ]);
    expect(pinned.facts.itemCompletedRequired).toEqual([
      "completedAtMs",
      "item",
      "threadId",
      "turnId",
    ]);
    expect(pinned.facts.threadItemTypes).toEqual([
      "userMessage",
      "hookPrompt",
      "agentMessage",
      "plan",
      "reasoning",
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "dynamicToolCall",
      "collabAgentToolCall",
      "webSearch",
      "imageView",
      "imageGeneration",
      "enteredReviewMode",
      "exitedReviewMode",
      "contextCompaction",
    ]);
    expect(pinned.facts.threadItemRequired["reasoning"]).toEqual([
      "id",
      "type",
    ]);
    expect(pinned.facts.threadItemRequired["mcpToolCall"]).toContain(
      "arguments"
    );
    expect(pinned.facts.threadItemRequired["dynamicToolCall"]).toContain(
      "arguments"
    );
    expect(pinned.facts.threadRequired).toEqual([
      "cliVersion",
      "createdAt",
      "cwd",
      "ephemeral",
      "id",
      "modelProvider",
      "preview",
      "sessionId",
      "source",
      "status",
      "turns",
      "updatedAt",
    ]);
    expect(pinned.facts.turnRequired).toEqual(["id", "items", "status"]);
    expect(pinned.facts.threadStartRequired).toEqual([
      "approvalPolicy",
      "approvalsReviewer",
      "cwd",
      "model",
      "modelProvider",
      "sandbox",
      "thread",
    ]);
    expect(pinned.facts.threadResumeRequired).toEqual(
      pinned.facts.threadStartRequired
    );
    expect(pinned.facts.turnsPageRequired).toEqual(["data"]);
    expect(pinned.facts.turnPlanRequired).toEqual([
      "plan",
      "threadId",
      "turnId",
    ]);
    expect(pinned.facts.threadTokenUsageRequired).toEqual(["last", "total"]);
    expect(pinned.facts.tokenUsageBreakdownRequired).toEqual([
      "cachedInputTokens",
      "inputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
    ]);
    expect(pinned.facts.notificationMethods).toContain(
      "item/fileChange/patchUpdated"
    );
    expect(pinned.facts.notificationMethods).not.toContain(
      "item/fileChange/patch/updated"
    );
  });

  it("keeps the Effect decoders aligned with representative pinned wire facts", () => {
    expect(
      Schema.decodeUnknownSync(ThreadListBoundaryResultSchema)({ data: [] })
    ).toEqual({ data: [] });
    expect(
      Schema.decodeUnknownSync(ModelListBoundaryResultSchema)({ data: [] })
    ).toEqual({ data: [] });
    expect(
      Schema.decodeUnknownSync(CodexServerRequestBoundarySchema)({
        id: "permission-1",
        method: "item/permissions/requestApproval",
        params: {
          cwd: "/workspace",
          environmentId: null,
          itemId: "item-1",
          permissions: {},
          reason: null,
          startedAtMs: 1,
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }).method
    ).toBe("item/permissions/requestApproval");
    expect(
      Schema.decodeUnknownSync(CodexNotificationBoundarySchema)({
        method: "item/completed",
        params: {
          completedAtMs: 2,
          item: { fragments: [], id: "item-1", type: "hookPrompt" },
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }).method
    ).toBe("item/completed");
  });
});
