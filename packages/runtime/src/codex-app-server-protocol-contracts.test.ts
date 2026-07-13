import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CodexClientVersionSchema,
  CodexProtocolCommandSchema,
  CodexServerNameSchema,
  CodexHttpUrlSchema,
  CodexItemIdSchema,
  CodexModelIdSchema,
  CodexPermissionAbsolutePathSchema,
  CodexRequestIdSchema,
  CodexNotificationSchema,
  CodexServerRequestSchema,
  CodexThreadIdSchema,
  CodexTurnIdSchema,
  ElicitationResponseSchema,
  ModelListResultSchema,
  PermissionApprovalResponseSchema,
  ThreadListResultSchema,
} from "./codex-app-server-protocol.js";

const decodeRequestId = Schema.decodeUnknownSync(CodexRequestIdSchema);
const decodeHttpUrl = Schema.decodeUnknownSync(CodexHttpUrlSchema);
const decodePermissionPath = Schema.decodeUnknownSync(
  CodexPermissionAbsolutePathSchema
);

describe("Codex App Server provider identities", () => {
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
          requestedSchema: {},
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
});
