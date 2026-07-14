import type { AgentSessionSnapshotDto } from "@gaia/core";
import {
  FactoryAgentIdSchema,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessQuestionId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseRunId,
  parseWorkspaceRelativePath,
} from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AgentInspectorSessionModelSchema,
  buildAgentInspectorSessionModel,
} from "@/agent-inspector-model";

const parseAgentId = Schema.decodeUnknownSync(FactoryAgentIdSchema);

describe("Agent Inspector session model", () => {
  it("maps a running public session to steer and interrupt controls", () => {
    const model = buildAgentInspectorSessionModel({
      connection: "connected",
      session: sessionFixture({
        items: [
          {
            itemId: parseHarnessItemId("item-message-1"),
            kind: "message",
            phase: "commentary",
            status: "completed",
            text: "I am editing the dashboard.",
            turnId: parseHarnessTurnId("turn-1"),
          },
          {
            itemId: parseHarnessItemId("item-command-1"),
            kind: "command",
            command: "pnpm --filter @gaia/dashboard test",
            status: "running",
            turnId: parseHarnessTurnId("turn-1"),
            workspacePath: parseWorkspaceRelativePath("."),
          },
          {
            itemId: parseHarnessItemId("item-file-1"),
            kind: "fileChange",
            changes: [
              {
                diff: "@@ -1 +1 @@\n-Agent\n+Agent Inspector\n",
                kind: "update",
                path: parseWorkspaceRelativePath(
                  "apps/dashboard/src/components/dashboard-shell.tsx"
                ),
              },
            ],
            status: "running",
            turnId: parseHarnessTurnId("turn-1"),
          },
        ],
        state: "running",
        turns: [{ status: "running", turnId: parseHarnessTurnId("turn-1") }],
      }),
    });

    expect(model.status).toBe("running");
    expect(model.composer).toEqual({
      disabledReason: undefined,
      mode: "steer",
      placeholder: "Steer the active turn",
      turnId: "turn-1",
    });
    expect(model.interrupt).toEqual({
      disabledReason: undefined,
      enabled: true,
      turnId: "turn-1",
    });
    expect(model.timeline.map((item) => item.title)).toEqual([
      "Agent message",
      "Command running",
      "File update running",
    ]);
    expect(model.timeline[2]?.details).toContain(
      "apps/dashboard/src/components/dashboard-shell.tsx"
    );
    expect(
      Schema.decodeUnknownSync(AgentInspectorSessionModelSchema)(model)
    ).toEqual(model);
  });

  it("maps an idle resumable public session to follow-up and disables unsupported steering", () => {
    const model = buildAgentInspectorSessionModel({
      connection: "connected",
      session: sessionFixture({
        capabilities: {
          ...capabilities,
          interruption: false,
          steering: false,
        },
        state: "idle",
        turns: [{ status: "completed", turnId: parseHarnessTurnId("turn-1") }],
      }),
    });

    expect(model.composer).toMatchObject({
      mode: "followUp",
      placeholder: "Send a follow-up turn",
      turnId: undefined,
    });
    expect(model.interrupt).toEqual({
      disabledReason: "Interruption is not supported by this session.",
      enabled: false,
      turnId: undefined,
    });
  });

  it("keeps waiting-for-operator sessions attached to active-turn controls", () => {
    const model = buildAgentInspectorSessionModel({
      connection: "connected",
      session: sessionFixture({
        state: "waitingForOperator",
        turns: [
          {
            status: "waitingForOperator",
            turnId: parseHarnessTurnId("turn-1"),
          },
        ],
      }),
    });

    expect(model.composer).toMatchObject({
      mode: "steer",
      turnId: "turn-1",
    });
    expect(model.interrupt).toEqual({
      disabledReason: undefined,
      enabled: true,
      turnId: "turn-1",
    });
  });

  it("uses explicit reconnecting, unavailable, and terminal states without inventing actions", () => {
    const reconnecting = buildAgentInspectorSessionModel({
      connection: "reconnecting",
      lastError: "SSE recovery required; reconnecting from Gaia sequence 12.",
      session: sessionFixture({ eventSequence: 12, state: "running" }),
    });
    const unavailable = buildAgentInspectorSessionModel({
      connection: "unavailable",
      lastError: "Local Gaia server is offline.",
      session: undefined,
    });
    const completed = buildAgentInspectorSessionModel({
      connection: "connected",
      session: sessionFixture({ state: "completed" }),
    });

    expect(reconnecting.status).toBe("reconnecting");
    expect(reconnecting.notice).toBe(
      "SSE recovery required; reconnecting from Gaia sequence 12."
    );
    expect(reconnecting.composer.mode).toBe("disabled");
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.composer.disabledReason).toBe(
      "Agent session is unavailable."
    );
    expect(completed.status).toBe("completed");
    expect(completed.composer.disabledReason).toBe(
      "Agent session is completed."
    );
  });

  it("renders pending interactions from finite Gaia-supplied decisions only", () => {
    const model = buildAgentInspectorSessionModel({
      connection: "connected",
      session: sessionFixture({
        pendingInteractions: [
          {
            allowedDecisions: ["approve", "decline"],
            command: "pnpm check",
            interactionId: parseHarnessInteractionId("interaction-command"),
            itemId: parseHarnessItemId("item-command-approval"),
            kind: "commandApproval",
            reason: "Run the gate before PR.",
            requestedAt: "2026-07-10T21:10:00.000Z",
            turnId: parseHarnessTurnId("turn-1"),
            workspacePath: parseWorkspaceRelativePath("."),
          },
          {
            interactionId: parseHarnessInteractionId("interaction-question"),
            itemId: parseHarnessItemId("item-question"),
            kind: "userInput",
            questions: [
              {
                options: ["Keep activity", "Hide activity"],
                prompt: "How should activity be shown?",
                questionId: parseHarnessQuestionId("question-activity"),
                secret: false,
              },
              {
                options: [],
                prompt: "Enter a token",
                questionId: parseHarnessQuestionId("question-secret"),
                secret: true,
              },
            ],
            requestedAt: "2026-07-10T21:11:00.000Z",
            turnId: parseHarnessTurnId("turn-1"),
          },
          {
            interactionId: parseHarnessInteractionId("interaction-mcp"),
            kind: "mcpElicitation",
            message: "Provide a bounded value.",
            mode: "form",
            requestedAt: "2026-07-10T21:12:00.000Z",
            serverName: "gaia-fixture",
            turnId: parseHarnessTurnId("turn-1"),
          },
        ],
        state: "waitingForOperator",
      }),
    });

    expect(model.pendingInteractions).toEqual([
      {
        actions: ["approve", "decline"],
        body: "pnpm check",
        interactionId: "interaction-command",
        kind: "approval",
        title: "Command approval",
      },
      {
        actions: ["submit"],
        body: "How should activity be shown? Options: Keep activity, Hide activity\nEnter a token (secret)",
        interactionId: "interaction-question",
        kind: "userInput",
        title: "Operator input",
      },
      {
        actions: ["submit", "decline", "cancel"],
        body: "Provide a bounded value.",
        interactionId: "interaction-mcp",
        kind: "mcpElicitation",
        title: "MCP elicitation: gaia-fixture",
      },
    ]);
    expect(JSON.stringify(model)).not.toContain("approveForSession");
  });
});

const capabilities = {
  approvals: [
    "command",
    "fileChange",
    "permission",
    "userInput",
    "mcpElicitation",
  ],
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: true,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: true,
  usageReporting: true,
  userQuestions: true,
} as const;

function sessionFixture(
  input: Partial<typeof AgentSessionSnapshotDto.Type> = {}
): typeof AgentSessionSnapshotDto.Type {
  return {
    agentId: parseAgentId("agent-worker"),
    capabilities,
    eventSequence: 7,
    items: [],
    pendingInteractions: [],
    recovered: false,
    resolvedInteractions: [],
    runId: parseRunId("run-1234567890"),
    sessionId: parseHarnessSessionId("session-run-1234567890"),
    state: "running",
    turns: [{ status: "running", turnId: parseHarnessTurnId("turn-1") }],
    ...input,
  };
}
