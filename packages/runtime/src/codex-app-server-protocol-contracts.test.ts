import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  CodexClientVersionSchema,
  CodexProtocolCommandSchema,
  CodexServerNameSchema,
  CodexHttpUrlSchema,
  CodexItemIdSchema,
  CodexModelIdSchema,
  CodexPermissionAbsolutePathSchema,
  CodexRawNotificationSchema,
  CodexRawRequestIdSchema,
  CodexRawThreadSchema,
  CodexRawThreadItemSchema,
  CodexRawThreadStartResultSchema,
  CodexRequestIdSchema,
  CodexNotificationBoundarySchema,
  CodexNotificationSchema,
  CodexServerRequestBoundarySchema,
  CodexServerRequestSchema,
  CodexThreadIdSchema,
  CodexTurnIdSchema,
  ElicitationResponseSchema,
  ModelListBoundaryResultSchema,
  ModelListResultSchema,
  PermissionApprovalResponseSchema,
  ThreadListResultSchema,
  ThreadResumeBoundaryResultSchema,
  ThreadStartBoundaryResultSchema,
} from "./codex-app-server-protocol.js";

const decodeRequestId = Schema.decodeUnknownSync(CodexRequestIdSchema);
const decodeHttpUrl = Schema.decodeUnknownSync(CodexHttpUrlSchema);
const decodePermissionPath = Schema.decodeUnknownSync(
  CodexPermissionAbsolutePathSchema
);
const rawThread = {
  cliVersion: "0.137.0",
  createdAt: 1,
  cwd: "/workspace",
  ephemeral: false,
  id: "thread-1",
  modelProvider: "openai",
  preview: "",
  sessionId: "session-1",
  source: "appServer",
  status: { type: "idle" },
  turns: [],
  updatedAt: 2,
} as const;
const rawThreadRuntimeResult = {
  approvalPolicy: "never",
  approvalsReviewer: "user",
  cwd: "/workspace",
  model: "gpt-5.4",
  modelProvider: "openai",
  sandbox: { type: "dangerFullAccess" },
  thread: rawThread,
} as const;

describe("Codex App Server provider identities", () => {
  const signedInt64Minimum = Number(-9_223_372_036_854_775_808n);
  const signedInt64MaximumRepresentable = Number(9_223_372_036_854_774_784n);
  const signedInt64BelowMinimum = Number(-9_223_372_036_854_777_856n);
  const signedInt64AboveMaximum = Number(9_223_372_036_854_775_808n);

  it.prop(
    "round-trips generated Codex thread IDs through their canonical schema",
    { threadId: Schema.toArbitrary(CodexThreadIdSchema) },
    ({ threadId }) => {
      expect(
        Schema.encodeSync(Schema.toCodecJson(CodexThreadIdSchema))(threadId)
      ).toBe(threadId);
    }
  );

  it("decodes the source-exact raw RequestId before applying Gaia refinements", () => {
    const decodeRaw = Schema.decodeUnknownSync(CodexRawRequestIdSchema);

    expect(decodeRaw("request-1")).toBe("request-1");
    expect(decodeRaw(Number.MAX_SAFE_INTEGER + 1)).toBe(
      Number.MAX_SAFE_INTEGER + 1
    );
    expect(decodeRaw(signedInt64Minimum)).toBe(signedInt64Minimum);
    expect(decodeRaw(signedInt64MaximumRepresentable)).toBe(
      signedInt64MaximumRepresentable
    );
    expect(() => decodeRaw(1.5)).toThrow();
    expect(() => decodeRaw(signedInt64BelowMinimum)).toThrow();
    expect(() => decodeRaw(signedInt64AboveMaximum)).toThrow();
  });

  it("enforces signed-int64 bounds across representative touched raw families", () => {
    const decodeThread = Schema.decodeUnknownSync(CodexRawThreadSchema);
    const decodeNotification = Schema.decodeUnknownSync(
      CodexRawNotificationSchema
    );
    const thread = decodeThread({
      ...rawThread,
      createdAt: signedInt64Minimum,
      updatedAt: signedInt64MaximumRepresentable,
    });
    expect(thread.createdAt).toBe(signedInt64Minimum);
    expect(thread.updatedAt).toBe(signedInt64MaximumRepresentable);
    expect(() =>
      decodeThread({ ...rawThread, createdAt: signedInt64AboveMaximum })
    ).toThrow();

    const itemStarted = {
      method: "item/started",
      params: {
        item: { id: "item-1", type: "contextCompaction" },
        startedAtMs: signedInt64MaximumRepresentable,
        threadId: "thread-1",
        turnId: "turn-1",
      },
    } as const;
    expect(decodeNotification(itemStarted)).toMatchObject(itemStarted);
    expect(() =>
      decodeNotification({
        ...itemStarted,
        params: {
          ...itemStarted.params,
          startedAtMs: signedInt64AboveMaximum,
        },
      })
    ).toThrow();

    const tokenUsageUpdated = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          last: {
            cachedInputTokens: 0,
            inputTokens: signedInt64MaximumRepresentable,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: signedInt64MaximumRepresentable,
          },
          total: {
            cachedInputTokens: 0,
            inputTokens: signedInt64MaximumRepresentable,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: signedInt64MaximumRepresentable,
          },
        },
        turnId: "turn-1",
      },
    } as const;
    expect(decodeNotification(tokenUsageUpdated)).toMatchObject(
      tokenUsageUpdated
    );
    expect(() =>
      decodeNotification({
        ...tokenUsageUpdated,
        params: {
          ...tokenUsageUpdated.params,
          tokenUsage: {
            ...tokenUsageUpdated.params.tokenUsage,
            total: {
              ...tokenUsageUpdated.params.tokenUsage.total,
              totalTokens: signedInt64AboveMaximum,
            },
          },
        },
      })
    ).toThrow();
  });

  it("refines the request-id wire union to lossless JavaScript integers", () => {
    expect(decodeRequestId("request-1")).toBe("request-1");
    expect(decodeRequestId(42)).toBe(42);
    expect(() => decodeRequestId(1.5)).toThrow();
    expect(() => decodeRequestId(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => decodeRequestId(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("parses non-empty bounded native IDs without changing their JSON encoding", () => {
    const cases: ReadonlyArray<{
      readonly decode: (value: unknown) => string;
      readonly roundTrip: (value: unknown) => unknown;
      readonly value: string;
    }> = [
      {
        decode: Schema.decodeUnknownSync(CodexThreadIdSchema),
        roundTrip: (value) =>
          Schema.encodeSync(Schema.toCodecJson(CodexThreadIdSchema))(
            Schema.decodeUnknownSync(CodexThreadIdSchema)(value)
          ),
        value: "thread-1",
      },
      {
        decode: Schema.decodeUnknownSync(CodexTurnIdSchema),
        roundTrip: (value) =>
          Schema.encodeSync(Schema.toCodecJson(CodexTurnIdSchema))(
            Schema.decodeUnknownSync(CodexTurnIdSchema)(value)
          ),
        value: "turn-1",
      },
      {
        decode: Schema.decodeUnknownSync(CodexItemIdSchema),
        roundTrip: (value) =>
          Schema.encodeSync(Schema.toCodecJson(CodexItemIdSchema))(
            Schema.decodeUnknownSync(CodexItemIdSchema)(value)
          ),
        value: "item-1",
      },
      {
        decode: Schema.decodeUnknownSync(CodexModelIdSchema),
        roundTrip: (value) =>
          Schema.encodeSync(Schema.toCodecJson(CodexModelIdSchema))(
            Schema.decodeUnknownSync(CodexModelIdSchema)(value)
          ),
        value: "gpt-5.4",
      },
    ] as const;

    for (const { decode, roundTrip, value } of cases) {
      const parsed = decode(value);
      expect(roundTrip(parsed)).toBe(value);
      expect(() => decode("")).toThrow();
      expect(() => decode("x".repeat(4_097))).toThrow();
    }
  });

  it("refines HTTP URLs and normalized absolute permission paths after raw string decoding", () => {
    expect(decodeHttpUrl("https://example.com/approve")).toBe(
      "https://example.com/approve"
    );
    expect(() => decodeHttpUrl("file:///tmp/approve")).toThrow();
    expect(() => decodeHttpUrl("not a url")).toThrow();
    expect(() => decodeHttpUrl("https://example.com ")).toThrow();
    expect(() => decodeHttpUrl("https://example.com/\n")).toThrow();

    expect(decodePermissionPath("/tmp/gaia")).toBe("/tmp/gaia");
    expect(() => decodePermissionPath("tmp/gaia")).toThrow();
    expect(() => decodePermissionPath("/tmp/../tmp/gaia")).toThrow();
  });

  it("brands client versions, commands, and server names only after lexical validation", () => {
    const decodeVersion = Schema.decodeUnknownSync(CodexClientVersionSchema);
    const decodeCommand = Schema.decodeUnknownSync(CodexProtocolCommandSchema);
    const decodeServerName = Schema.decodeUnknownSync(CodexServerNameSchema);

    expect(decodeVersion("0.137.0")).toBe("0.137.0");
    expect(decodeVersion("0.137.0-beta.1+build.7")).toBe(
      "0.137.0-beta.1+build.7"
    );
    expect(() => decodeVersion("latest")).toThrow();
    expect(() => decodeVersion("01.2.3")).toThrow();
    expect(() => decodeVersion("1.2.3-")).toThrow();
    expect(() => decodeVersion("1.2.3-alpha..1")).toThrow();
    expect(decodeCommand("pnpm test")).toBe("pnpm test");
    expect(() => decodeCommand("")).toThrow();
    expect(() => decodeCommand("pnpm\0test")).toThrow();
    expect(decodeServerName("github")).toBe("github");
    expect(() => decodeServerName(" ")).toThrow();
    expect(() => decodeServerName(" github ")).toThrow();
  });

  it("accepts valid 0.137.0 optional cursors and permission profiles", () => {
    expect(
      Schema.decodeUnknownSync(ThreadListResultSchema)({ data: [] })
    ).toEqual({ data: [] });
    expect(
      Schema.decodeUnknownSync(ModelListResultSchema)({ data: [] })
    ).toEqual({ data: [] });
    expect(
      Schema.decodeUnknownSync(CodexServerRequestSchema)({
        id: 1,
        method: "item/permissions/requestApproval",
        params: {
          cwd: "/workspace",
          environmentId: null,
          itemId: "item-1",
          permissions: { fileSystem: {} },
          reason: null,
          startedAtMs: 1,
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }).method
    ).toBe("item/permissions/requestApproval");
  });

  it("accepts valid 0.137.0 omitted request and response defaults", () => {
    expect(
      Schema.decodeUnknownSync(CodexServerRequestSchema)({
        id: 1,
        method: "item/permissions/requestApproval",
        params: {
          cwd: "/workspace",
          itemId: "item-1",
          permissions: {},
          startedAtMs: 1,
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }).method
    ).toBe("item/permissions/requestApproval");
    expect(
      Schema.decodeUnknownSync(CodexServerRequestSchema)({
        id: 2,
        method: "mcpServer/elicitation/request",
        params: {
          message: "Choose",
          mode: "form",
          requestedSchema: { properties: {}, type: "object" },
          serverName: "github",
          threadId: "thread-1",
        },
      }).method
    ).toBe("mcpServer/elicitation/request");
    expect(
      Schema.decodeUnknownSync(PermissionApprovalResponseSchema)({
        permissions: {},
      })
    ).toEqual({ permissions: {} });
    expect(
      Schema.decodeUnknownSync(PermissionApprovalResponseSchema)({
        permissions: {},
        strictAutoReview: null,
      })
    ).toEqual({ permissions: {}, strictAutoReview: null });
    expect(
      Schema.decodeUnknownSync(ElicitationResponseSchema)({
        action: "decline",
      })
    ).toEqual({ action: "decline" });
  });

  it("decodes every curated 0.137.0 ID-bearing item variant", () => {
    const items = [
      { fragments: [], id: "hook-1", type: "hookPrompt" },
      {
        agentsStates: {},
        id: "collab-1",
        receiverThreadIds: [],
        senderThreadId: "thread-1",
        status: "completed",
        tool: "spawnAgent",
        type: "collabAgentToolCall",
      },
      { id: "view-1", path: "/tmp/image.png", type: "imageView" },
      {
        id: "generation-1",
        result: "completed",
        status: "completed",
        type: "imageGeneration",
      },
    ] as const;

    for (const item of items) {
      const notification = Schema.decodeUnknownSync(CodexNotificationSchema)({
        method: "item/started",
        params: {
          item,
          startedAtMs: 1,
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
      expect(notification.method).toBe("item/started");
    }
  });

  it("preserves required raw item data before explicit Gaia projection", () => {
    const reasoning = Schema.decodeUnknownSync(CodexRawThreadItemSchema)({
      content: ["private reasoning"],
      id: "reasoning-1",
      summary: ["summary"],
      type: "reasoning",
    });
    const mcp = Schema.decodeUnknownSync(CodexRawThreadItemSchema)({
      arguments: { owner: "gaia" },
      durationMs: null,
      error: null,
      id: "mcp-1",
      pluginId: null,
      result: null,
      server: "github",
      status: "completed",
      tool: "get_issue",
      type: "mcpToolCall",
    });

    expect(reasoning).toMatchObject({
      content: ["private reasoning"],
      summary: ["summary"],
    });
    expect(mcp).toMatchObject({ arguments: { owner: "gaia" } });
  });

  it("rejects incomplete raw thread results and token-usage notifications", () => {
    expect(() =>
      Schema.decodeUnknownSync(CodexRawThreadStartResultSchema)({
        thread: { id: "thread-1" },
      })
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CodexRawNotificationSchema)({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          tokenUsage: {
            last: { inputTokens: 1, outputTokens: 1 },
            modelContextWindow: null,
            total: { inputTokens: 1, outputTokens: 1 },
          },
          turnId: "turn-1",
        },
      })
    ).toThrow();
  });

  it("accepts source-valid optional nested fields at every affected boundary", () => {
    const cases = [
      {
        schema: ThreadStartBoundaryResultSchema,
        value: {
          ...rawThreadRuntimeResult,
          activePermissionProfile: { id: ":workspace" },
          thread: { ...rawThread, gitInfo: {} },
        },
      },
      {
        schema: ThreadResumeBoundaryResultSchema,
        value: {
          ...rawThreadRuntimeResult,
          initialTurnsPage: { data: [] },
        },
      },
      {
        schema: ModelListBoundaryResultSchema,
        value: {
          data: [
            {
              defaultReasoningEffort: "medium",
              description: "Current model",
              displayName: "GPT",
              hidden: false,
              id: "gpt-5.4",
              isDefault: true,
              model: "gpt-5.4",
              supportedReasoningEfforts: [],
              upgradeInfo: { model: "gpt-next" },
            },
          ],
        },
      },
      {
        schema: CodexNotificationBoundarySchema,
        value: {
          method: "turn/plan/updated",
          params: {
            plan: [],
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
      {
        schema: CodexNotificationBoundarySchema,
        value: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              last: {
                cachedInputTokens: 0,
                inputTokens: 1,
                outputTokens: 1,
                reasoningOutputTokens: 0,
                totalTokens: 2,
              },
              total: {
                cachedInputTokens: 0,
                inputTokens: 1,
                outputTokens: 1,
                reasoningOutputTokens: 0,
                totalTokens: 2,
              },
            },
            turnId: "turn-1",
          },
        },
      },
      {
        schema: CodexServerRequestBoundarySchema,
        value: {
          id: 1,
          method: "item/commandExecution/requestApproval",
          params: {
            availableDecisions: [
              {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: ["allow"],
                },
              },
              {
                applyNetworkPolicyAmendment: {
                  network_policy_amendment: {
                    action: "allow",
                    host: "example.com",
                  },
                },
              },
            ],
            itemId: "item-1",
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
      {
        schema: CodexServerRequestBoundarySchema,
        value: {
          id: 2,
          method: "item/permissions/requestApproval",
          params: {
            cwd: "/workspace",
            itemId: "item-1",
            permissions: {
              fileSystem: {
                entries: [
                  {
                    access: "read",
                    path: { path: "/workspace", type: "path" },
                  },
                  {
                    access: "read",
                    path: { pattern: "src/**", type: "glob_pattern" },
                  },
                  {
                    access: "read",
                    path: {
                      type: "special",
                      value: { kind: "project_roots" },
                    },
                  },
                  {
                    access: "deny",
                    path: {
                      type: "special",
                      value: { kind: "unknown", path: "/private" },
                    },
                  },
                ],
              },
            },
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
      {
        schema: CodexServerRequestBoundarySchema,
        value: {
          id: 3,
          method: "mcpServer/elicitation/request",
          params: {
            message: "Choose",
            mode: "form",
            requestedSchema: {
              properties: {
                choice: {
                  enum: ["yes", "no"],
                  type: "string",
                },
              },
              required: ["choice"],
              type: "object",
            },
            serverName: "github",
            threadId: "thread-1",
          },
        },
      },
    ] as const;

    for (const { schema, value } of cases)
      expect(Schema.decodeUnknownOption(schema)(value)._tag).toBe("Some");
  });

  it("rejects source-invalid widened nested objects at raw boundaries", () => {
    const invalid = [
      {
        schema: CodexNotificationBoundarySchema,
        value: {
          method: "item/started",
          params: {
            item: {
              id: "message-1",
              memoryCitation: "invalid",
              text: "hello",
              type: "agentMessage",
            },
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
      {
        schema: CodexServerRequestBoundarySchema,
        value: {
          id: 1,
          method: "mcpServer/elicitation/request",
          params: {
            message: "Choose",
            mode: "form",
            requestedSchema: {},
            serverName: "github",
            threadId: "thread-1",
          },
        },
      },
      {
        schema: ThreadStartBoundaryResultSchema,
        value: {
          ...rawThreadRuntimeResult,
          thread: {
            ...rawThread,
            source: { custom: "test", extra: true },
          },
        },
      },
      {
        schema: CodexServerRequestBoundarySchema,
        value: {
          id: 2,
          method: "item/permissions/requestApproval",
          params: {
            cwd: "/workspace",
            itemId: "item-1",
            permissions: { extra: true },
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
      {
        schema: ThreadStartBoundaryResultSchema,
        value: {
          ...rawThreadRuntimeResult,
          approvalPolicy: {
            extra: true,
            granular: {
              mcp_elicitations: true,
              rules: true,
              sandbox_approval: true,
            },
          },
        },
      },
    ] as const;

    for (const { schema, value } of invalid)
      expect(Schema.decodeUnknownOption(schema)(value)._tag).toBe("None");
  });

  it("decodes the pinned nested item and typed-error unions before projection", () => {
    const items = [
      {
        content: [
          {
            text: "hello",
            text_elements: [
              { byteRange: { end: 5, start: 0 }, placeholder: null },
            ],
            type: "text",
          },
        ],
        id: "user-1",
        type: "userMessage",
      },
      {
        id: "agent-1",
        memoryCitation: {
          entries: [
            {
              lineEnd: 2,
              lineStart: 1,
              note: "source",
              path: "memory.md",
            },
          ],
          threadIds: ["thread-1"],
        },
        text: "answer",
        type: "agentMessage",
      },
      ...[
        { queries: ["gaia"], query: "gaia", type: "search" },
        { type: "openPage", url: "https://example.com" },
        {
          pattern: "schema",
          type: "findInPage",
          url: "https://example.com",
        },
        { type: "other" },
      ].map((action, index) => ({
        action,
        id: `search-${index}`,
        query: "gaia",
        type: "webSearch" as const,
      })),
    ];

    for (const item of items) {
      const decoded = Schema.decodeUnknownOption(
        CodexNotificationBoundarySchema
      )({
        method: "item/started",
        params: {
          item,
          startedAtMs: 1,
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
      expect(decoded._tag).toBe("Some");
    }

    const errorInfo = [
      "contextWindowExceeded",
      { httpConnectionFailed: { httpStatusCode: 503 } },
      { responseStreamConnectionFailed: {} },
      { responseStreamDisconnected: { httpStatusCode: null } },
      { responseTooManyFailedAttempts: {} },
      { activeTurnNotSteerable: { turnKind: "review" } },
    ] as const;
    for (const codexErrorInfo of errorInfo) {
      const decoded = Schema.decodeUnknownOption(
        CodexNotificationBoundarySchema
      )({
        method: "error",
        params: {
          error: { codexErrorInfo, message: "failed" },
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: false,
        },
      });
      expect(decoded._tag).toBe("Some");
    }
  });

  it("decodes every pinned MCP elicitation primitive variant", () => {
    const requestedSchema = {
      properties: {
        boolean: { default: null, type: "boolean" },
        integer: { minimum: 0, type: "integer" },
        legacy: {
          enum: ["a"],
          enumNames: ["A"],
          type: "string",
        },
        number: { maximum: 10.5, type: "number" },
        string: { format: "email", minLength: 1, type: "string" },
        titledMulti: {
          items: { anyOf: [{ const: "a", title: "A" }] },
          type: "array",
        },
        titledSingle: {
          oneOf: [{ const: "a", title: "A" }],
          type: "string",
        },
        untitledMulti: {
          items: { enum: ["a"], type: "string" },
          type: "array",
        },
        untitledSingle: { enum: ["a"], type: "string" },
      },
      required: ["boolean"],
      type: "object",
    } as const;
    const request = {
      id: 1,
      method: "mcpServer/elicitation/request",
      params: {
        message: "Choose",
        mode: "form",
        requestedSchema,
        serverName: "github",
        threadId: "thread-1",
      },
    } as const;

    expect(
      Schema.decodeUnknownOption(CodexServerRequestBoundarySchema)(request)._tag
    ).toBe("Some");
    expect(
      Schema.decodeUnknownOption(CodexServerRequestBoundarySchema)({
        ...request,
        params: {
          ...request.params,
          requestedSchema: {
            ...requestedSchema,
            properties: {
              invalid: { extra: true, type: "boolean" },
            },
          },
        },
      })._tag
    ).toBe("None");
  });
});
