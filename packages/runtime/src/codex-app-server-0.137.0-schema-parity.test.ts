import { readFileSync } from "node:fs";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CodexNotificationSchema,
  CodexServerRequestSchema,
  ModelListResultSchema,
  ThreadListResultSchema,
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
      additionalFileSystemPermissionsRequired: Schema.Array(Schema.String),
      additionalNetworkPermissionsRequired: Schema.Array(Schema.String),
      elicitationRequestRequired: Schema.Array(Schema.String),
      elicitationResponseRequired: Schema.Array(Schema.String),
      itemCompletedRequired: Schema.Array(Schema.String),
      itemStartedRequired: Schema.Array(Schema.String),
      modelListRequired: Schema.Array(Schema.String),
      notificationMethods: Schema.Array(Schema.String),
      permissionApprovalResponseRequired: Schema.Array(Schema.String),
      permissionApprovalScopeDefault: Schema.String,
      permissionRequestRequired: Schema.Array(Schema.String),
      requestIdTypes: Schema.Array(Schema.String),
      requestPermissionProfileRequired: Schema.Array(Schema.String),
      threadItemTypes: Schema.Array(Schema.String),
      threadListRequired: Schema.Array(Schema.String),
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
    expect(pinned.facts.threadListRequired).toEqual(["data"]);
    expect(pinned.facts.modelListRequired).toEqual(["data"]);
    expect(pinned.facts.additionalFileSystemPermissionsRequired).toEqual([]);
    expect(pinned.facts.additionalNetworkPermissionsRequired).toEqual([]);
    expect(pinned.facts.requestPermissionProfileRequired).toEqual([]);
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
    expect(pinned.facts.notificationMethods).toContain(
      "item/fileChange/patchUpdated"
    );
    expect(pinned.facts.notificationMethods).not.toContain(
      "item/fileChange/patch/updated"
    );
  });

  it("keeps the Effect decoders aligned with representative pinned wire facts", () => {
    expect(
      Schema.decodeUnknownSync(ThreadListResultSchema)({ data: [] })
    ).toEqual({ data: [] });
    expect(
      Schema.decodeUnknownSync(ModelListResultSchema)({ data: [] })
    ).toEqual({ data: [] });
    expect(
      Schema.decodeUnknownSync(CodexServerRequestSchema)({
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
      Schema.decodeUnknownSync(CodexNotificationSchema)({
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
