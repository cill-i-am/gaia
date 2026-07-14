import {
  FactoryAgentIdSchema,
  parseLocalGaiaServerUrl,
  parseRunId,
} from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  openAgentSessionEventSource,
  openDeliverySnapshotEventSource,
  type AgentSessionEventSource,
} from "./local-gaia-client.js";

const runId = parseRunId("run-1234567890");
const serverUrl = parseLocalGaiaServerUrl("/gaia-api");
const agentWorkerId =
  Schema.decodeUnknownSync(FactoryAgentIdSchema)("agent-worker");

describe("local Gaia agent session SSE client", () => {
  it("subscribes to Gaia's named session event, cleans up, and pins sequence IDs", () => {
    let url = "";
    const source = new TestAgentSessionEventSource();
    const updates: Array<number> = [];
    const errors: Array<unknown> = [];
    const handle = openAgentSessionEventSource(
      { afterSequence: 4, agentId: agentWorkerId, runId, serverUrl },
      {
        onError: (error) => errors.push(error),
        onUpdate: (update) => updates.push(update.eventSequence),
      },
      (input) => {
        url = input;
        return source;
      }
    );
    expect(url).toBe(
      "/gaia-api/runs/run-1234567890/agents/agent-worker/session/stream?afterSequence=4"
    );
    expect(source.listenerCount("agent-session-update")).toBe(1);
    expect(source.onmessage).toBeNull();

    source.dispatch("agent-session-update", {
      data: JSON.stringify(update(6)),
      lastEventId: "6",
    });
    expect(updates).toEqual([6]);

    source.dispatch("agent-session-update", {
      data: JSON.stringify(update(8)),
      lastEventId: "7",
    });
    expect(errors).toHaveLength(1);
    expect(source.closed).toBe(1);

    handle.close();
    expect(source.closed).toBe(2);
    expect(source.listenerCount("agent-session-update")).toBe(0);
  });

  it("accepts an empty session SSE ID as absence", () => {
    const source = new TestAgentSessionEventSource();
    const updates: Array<number> = [];
    const errors: Array<unknown> = [];
    const handle = openAgentSessionEventSource(
      { agentId: agentWorkerId, runId, serverUrl },
      {
        onError: (error) => errors.push(error),
        onUpdate: (value) => updates.push(value.eventSequence),
      },
      () => source
    );

    source.dispatch("agent-session-update", {
      data: JSON.stringify(update(6)),
      lastEventId: "",
    });

    expect(updates).toEqual([6]);
    expect(errors).toEqual([]);
    expect(source.closed).toBe(0);
    handle.close();
  });

  it.each(["abc", "0", "-1", "01", "+1", "1.5", " 6", "6 "])(
    "rejects malformed session SSE ID %s",
    (lastEventId) => {
      const source = new TestAgentSessionEventSource();
      const updates: Array<number> = [];
      const errors: Array<unknown> = [];
      const handle = openAgentSessionEventSource(
        { agentId: agentWorkerId, runId, serverUrl },
        {
          onError: (error) => errors.push(error),
          onUpdate: (value) => updates.push(value.eventSequence),
        },
        () => source
      );

      source.dispatch("agent-session-update", {
        data: JSON.stringify(update(6)),
        lastEventId,
      });

      expect(updates).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(source.closed).toBe(1);
      handle.close();
    }
  );

  it("streams delivery remediation updates without closing at waiting", () => {
    let url = "";
    const source = new TestAgentSessionEventSource();
    const updates: Array<string> = [];
    const handle = openDeliverySnapshotEventSource(
      { afterSequence: 12, runId, serverUrl },
      {
        onError: () => undefined,
        onUpdate: (value) => updates.push(value.stage),
      },
      (input) => {
        url = input;
        return source;
      }
    );

    source.dispatch("delivery-update", {
      data: JSON.stringify({
        eventSequence: 14,
        mode: "pullRequest",
        recoveryActions: [],
        remediationRearmSequence: 14,
        runId: "run-1234567890",
        stage: "remediating",
        status: "remediating",
      }),
      lastEventId: "14",
    });

    expect(url).toBe(
      "/gaia-api/runs/run-1234567890/delivery/stream?afterSequence=12"
    );
    expect(updates).toEqual(["remediating"]);
    expect(source.closed).toBe(0);
    handle.close();
    expect(source.closed).toBe(1);
  });
});

class TestAgentSessionEventSource implements AgentSessionEventSource {
  closed = 0;
  onerror: ((event: unknown) => void) | null = null;
  onmessage:
    | ((event: { readonly data: string; readonly lastEventId: string }) => void)
    | null = null;
  readonly #listeners = new Map<
    string,
    Set<
      (event: { readonly data: string; readonly lastEventId: string }) => void
    >
  >();

  addEventListener(
    event: string,
    listener: (message: {
      readonly data: string;
      readonly lastEventId: string;
    }) => void
  ) {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  }

  close() {
    this.closed += 1;
  }

  dispatch(
    event: string,
    message: { readonly data: string; readonly lastEventId: string }
  ) {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(message);
    }
  }

  listenerCount(event: string) {
    return this.#listeners.get(event)?.size ?? 0;
  }

  removeEventListener(
    event: string,
    listener: (message: {
      readonly data: string;
      readonly lastEventId: string;
    }) => void
  ) {
    this.#listeners.get(event)?.delete(listener);
  }
}

function update(eventSequence: number) {
  const snapshot = {
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
      toolEvents: false,
      usageReporting: false,
      userQuestions: false,
    },
    eventSequence,
    items: [],
    pendingInteractions: [],
    recovered: false,
    resolvedInteractions: [],
    runId: "run-1234567890",
    sessionId: "session-run-1234567890",
    state: "running",
    turns: [],
  };
  return {
    agentId: "agent-worker",
    eventSequence,
    runId: "run-1234567890",
    sessionId: "session-run-1234567890",
    snapshot,
    terminal: false,
  };
}
