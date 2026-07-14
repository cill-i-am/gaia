import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  AgentOperatorActionRequestSchema,
  AgentSessionSnapshotDto,
  AgentSessionSseEventIdSchema,
  AgentSessionSseEventSchema,
  makeAgentSessionSseEventId,
} from "./agent-session-api.js";

describe("public agent session contracts", () => {
  it("strictly decodes every finite operator action family", () => {
    const decode = Schema.decodeUnknownSync(AgentOperatorActionRequestSchema);
    const base = { actionId: "action-1", sessionId: "session-1" };
    assert.equal(
      decode({ ...base, kind: "followUp", text: "continue" }).kind,
      "followUp"
    );
    assert.equal(
      decode({ ...base, kind: "steer", text: "focus", turnId: "turn-1" }).kind,
      "steer"
    );
    assert.equal(
      decode({ ...base, kind: "interrupt", turnId: "turn-1" }).kind,
      "interrupt"
    );
    assert.equal(
      decode({
        ...base,
        decision: "decline",
        interactionId: "interaction-1",
        kind: "approval",
      }).kind,
      "approval"
    );
    assert.equal(
      decode({
        ...base,
        answers: [{ answers: ["safe"], questionId: "question-1" }],
        interactionId: "interaction-1",
        kind: "userInput",
      }).kind,
      "userInput"
    );
    assert.equal(
      decode({
        ...base,
        action: "submit",
        content: "bounded",
        interactionId: "interaction-1",
        kind: "mcpElicitation",
      }).kind,
      "mcpElicitation"
    );
    assert.throws(() =>
      decode({
        ...base,
        kind: "followUp",
        providerThreadId: "raw",
        text: "continue",
      })
    );
    assert.throws(() =>
      decode({
        ...base,
        kind: "mcpElicitation",
        action: "submit",
        content: { unrestricted: true },
        interactionId: "interaction-1",
      })
    );
  });

  it("owns canonical positive-decimal agent-session SSE event IDs", () => {
    const decodeEventId = Schema.decodeUnknownSync(
      AgentSessionSseEventIdSchema
    );
    const decodeSseEvent = Schema.decodeUnknownSync(AgentSessionSseEventSchema);
    const update = {
      agentId: "agent-worker",
      eventSequence: 3,
      runId: "run-1234567890",
      sessionId: "session-run-1234567890",
      snapshot: snapshotInput(3),
      terminal: false,
    };

    assert.strictEqual(makeAgentSessionSseEventId(3), "3");
    assert.strictEqual(decodeEventId("42"), "42");
    assert.strictEqual(
      decodeSseEvent({
        data: JSON.stringify(update),
        event: "agent-session-update",
        id: "3",
      }).id,
      "3"
    );

    for (const rejected of [
      "",
      "abc",
      "0",
      "-1",
      "01",
      "+1",
      "1.5",
      " 1",
      "1 ",
    ]) {
      assert.throws(() => decodeEventId(rejected));
    }
  });

  it("does not admit provider identity in the public snapshot", () => {
    const decode = Schema.decodeUnknownSync(AgentSessionSnapshotDto);
    const input = snapshotInput(3);
    assert.doesNotThrow(() => decode(input));
    assert.throws(() =>
      decode({ ...input, provider: { providerId: "codex" } })
    );
  });
});

function snapshotInput(eventSequence: number) {
  return {
    agentId: "agent-worker",
    capabilities: {
      approvals: [],
      fileChangeEvents: false,
      interruption: true,
      resumableSessions: true,
      review: false,
      steering: true,
      streamingMessages: true,
      structuredOutput: false,
      subagents: false,
      toolEvents: true,
      usageReporting: false,
      userQuestions: true,
    },
    eventSequence,
    items: [],
    pendingInteractions: [],
    recovered: false,
    resolvedInteractions: [],
    runId: "run-1234567890",
    sessionId: "session-1",
    state: "running",
    turns: [],
  };
}
