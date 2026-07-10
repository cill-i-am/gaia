import { describe, expect, it } from "vitest";
import {
  openAgentSessionEventSource,
  type AgentSessionEventSource,
} from "./local-gaia-client.js";

describe("local Gaia agent session SSE client", () => {
  it("owns close lifecycle, parses normalized updates, and pins Gaia sequence IDs", () => {
    let url = "";
    let closed = 0;
    const source: AgentSessionEventSource = { close: () => { closed += 1; }, onerror: null, onmessage: null };
    const updates: Array<number> = [];
    const errors: Array<unknown> = [];
    const handle = openAgentSessionEventSource(
      { afterSequence: 4, agentId: "agent-worker", runId: "run-1234567890", serverUrl: "/gaia-api" },
      { onError: (error) => errors.push(error), onUpdate: (update) => updates.push(update.eventSequence) },
      (input) => { url = input; return source; },
    );
    expect(url).toBe("/gaia-api/runs/run-1234567890/agents/agent-worker/session/stream?afterSequence=4");
    source.onmessage?.({ data: JSON.stringify(update(6)), lastEventId: "6" });
    expect(updates).toEqual([6]);
    source.onmessage?.({ data: JSON.stringify(update(8)), lastEventId: "7" });
    expect(errors).toHaveLength(1);
    expect(closed).toBe(1);
    handle.close();
    expect(closed).toBe(2);
  });
});

function update(eventSequence: number) {
  const snapshot = {
    agentId: "agent-worker",
    capabilities: { approvals: [], fileChangeEvents: false, interruption: true, resumableSessions: true, review: false, steering: true, streamingMessages: true, structuredOutput: false, subagents: false, toolEvents: false, usageReporting: false, userQuestions: false },
    eventSequence,
    items: [], pendingInteractions: [], recovered: false, resolvedInteractions: [],
    runId: "run-1234567890", sessionId: "session-run-1234567890", state: "running", turns: [],
  };
  return { agentId: "agent-worker", eventSequence, runId: "run-1234567890", sessionId: "session-run-1234567890", snapshot, terminal: false };
}
