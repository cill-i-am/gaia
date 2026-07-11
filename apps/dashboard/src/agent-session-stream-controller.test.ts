import { describe, expect, it } from "vitest";
import type { AgentSessionUpdateDto } from "@gaia/core";
import {
  FactoryAgentIdSchema,
  parseHarnessSessionId,
  parseRunId,
} from "@gaia/core";
import { Schema } from "effect";

import { createAgentSessionStreamController } from "@/agent-session-stream-controller";
import type { AgentSessionEventSource } from "@/lib/local-gaia-client";

const parseAgentId = Schema.decodeUnknownSync(FactoryAgentIdSchema);

describe("Agent session stream controller", () => {
  it("opens only while an agent Inspector is visible and closes on close, switch, terminal, and unmount", () => {
    const sources: Array<AgentSessionEventSource> = [];
    const closed: Array<number> = [];
    const updates: Array<number> = [];
    const controller = createAgentSessionStreamController({
      openSource: (_config, handlers) => {
        const index = sources.length;
        const source: AgentSessionEventSource = {
          addEventListener: () => undefined,
          close: () => closed.push(index),
          onerror: handlers.onError,
          onmessage: null,
          removeEventListener: () => undefined,
        };
        sources.push(source);
        return { close: source.close };
      },
      onConnectionChange: () => undefined,
      onError: () => undefined,
      onUpdate: (update) => updates.push(update.eventSequence),
      serverUrl: "/gaia-api",
    });

    controller.sync({
      agentId: "agent-worker",
      isOpen: true,
      runId: "run-1234567890",
      sessionId: "session-run-1234567890",
    });
    expect(sources).toHaveLength(1);

    controller.sync({
      agentId: "agent-reviewer",
      isOpen: true,
      runId: "run-1234567890",
      sessionId: "session-run-1234567890",
    });
    expect(sources).toHaveLength(2);
    expect(closed).toEqual([0]);

    controller.handleUpdate(update({ agentId: "agent-reviewer", terminal: true, sequence: 12 }));
    expect(updates).toEqual([12]);
    expect(closed).toEqual([0, 1]);

    controller.sync({
      agentId: "agent-reviewer",
      isOpen: false,
      runId: "run-1234567890",
      sessionId: "session-run-1234567890",
    });
    controller.dispose();
    expect(closed).toEqual([0, 1]);
  });

  it("reconnects from the last Gaia sequence without treating non-contiguous IDs as gaps", () => {
    const openedAfterSequences: Array<number | undefined> = [];
    const connections: Array<string> = [];
    const controller = createAgentSessionStreamController({
      openSource: (config, handlers) => {
        openedAfterSequences.push(config.afterSequence);
        return {
          close: () => undefined,
          onError: handlers.onError,
          onUpdate: handlers.onUpdate,
        };
      },
      onConnectionChange: (state) => connections.push(state),
      onError: () => undefined,
      onUpdate: () => undefined,
      serverUrl: "/gaia-api",
    });

    controller.sync({
      agentId: "agent-worker",
      isOpen: true,
      runId: "run-1234567890",
      sessionId: "session-run-1234567890",
    });
    controller.handleUpdate(update({ sequence: 6 }));
    controller.handleUpdate(update({ sequence: 9 }));
    controller.handleError(new Error("network"));

    expect(openedAfterSequences).toEqual([undefined, 9]);
    expect(connections).toEqual(["connecting", "connected", "reconnecting", "connected"]);
  });

  it("does not synthesize an invalid zero cursor before the first update", () => {
    const openedAfterSequences: Array<number | undefined> = [];
    const controller = createAgentSessionStreamController({
      openSource: (config) => {
        openedAfterSequences.push(config.afterSequence);
        return { close: () => undefined };
      },
      onConnectionChange: () => undefined,
      onError: () => undefined,
      onUpdate: () => undefined,
      serverUrl: "/gaia-api",
    });
    const target = {
      agentId: "agent-worker",
      isOpen: true,
      runId: "run-1234567890",
      sessionId: "session-run-1234567890",
    } as const;

    controller.sync(target);
    controller.sync(target);
    controller.handleError(new Error("network"));

    expect(openedAfterSequences).toEqual([undefined, undefined]);
  });

  it("re-arms one second-turn stream for the same public session and rejects stale callbacks", () => {
    const openedAfterSequences: Array<number | undefined> = [];
    const callbacks: Array<{
      readonly onError: (error: unknown) => void;
      readonly onUpdate: (update: typeof AgentSessionUpdateDto.Type) => void;
    }> = [];
    const closed: Array<number> = [];
    const updates: Array<number> = [];
    const errors: Array<string> = [];
    const controller = createAgentSessionStreamController({
      openSource: (config, handlers) => {
        const index = callbacks.length;
        openedAfterSequences.push(config.afterSequence);
        callbacks.push(handlers);
        return { close: () => closed.push(index) };
      },
      onConnectionChange: () => undefined,
      onError: (error) => errors.push(String(error)),
      onUpdate: (value) => updates.push(value.eventSequence),
      serverUrl: "/gaia-api",
    });
    const target = {
      agentId: "agent-worker",
      isOpen: true,
      runId: "run-1234567890",
      sessionId: "session-run-1234567890",
      snapshotSequence: 5,
    } as const;

    controller.sync(target);
    callbacks[0]?.onUpdate(update({ sequence: 12, terminal: true }));
    controller.sync({ ...target, rearmSequence: 14, snapshotSequence: 12 });
    callbacks[0]?.onUpdate(update({ sequence: 15 }));
    callbacks[1]?.onUpdate(update({ sequence: 15 }));
    callbacks[1]?.onUpdate(update({ sequence: 16, terminal: true }));
    controller.sync({ ...target, rearmSequence: 14, snapshotSequence: 16 });

    expect(openedAfterSequences).toEqual([5, 14]);
    expect(updates).toEqual([12, 15, 16]);
    expect(closed).toEqual([0, 1]);
    expect(errors).toEqual([]);
  });
});

function update(input: {
  readonly agentId?: string;
  readonly sequence: number;
  readonly terminal?: boolean;
}): typeof AgentSessionUpdateDto.Type {
  const agentId = parseAgentId(input.agentId ?? "agent-worker");
  const runId = parseRunId("run-1234567890");
  const sessionId = parseHarnessSessionId("session-run-1234567890");
  const snapshot = {
    agentId,
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
    eventSequence: input.sequence,
    items: [],
    pendingInteractions: [],
    recovered: false,
    resolvedInteractions: [],
    runId,
    sessionId,
    state: input.terminal ? "completed" : "running",
    turns: [],
  } as const;

  return {
    agentId,
    eventSequence: input.sequence,
    runId,
    sessionId,
    snapshot,
    terminal: input.terminal ?? false,
  };
}
