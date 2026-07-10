import {
  codexAppServerHarnessProfileId,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  parseHarnessTurnId,
  parseHarnessProviderId,
  projectHarnessEvents,
  type HarnessEvent,
  type HarnessSessionId,
} from "@gaia/core";
import { Effect, Option, Stream } from "effect";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import type { HarnessProvider, HarnessSession } from "./harness-session.js";

export const testHarnessCapabilities = HarnessCapabilities.make({
  approvals: [],
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: false,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: false,
});

export const testHarnessProvider: HarnessProvider = {
  createSession: (request) =>
    Effect.succeed(testHarnessSession(request.sessionId)),
  descriptor: HarnessProviderDescriptor.make({
    displayName: "Test Interactive Harness",
    executionModes: ["local"],
    providerId: parseHarnessProviderId("test-interactive"),
  }),
  detect: Effect.succeed({
    auth: { state: "notRequired" },
    capabilities: testHarnessCapabilities,
    state: "available",
    version: "test-1",
  }),
  resumeSession: (request) =>
    Effect.succeed(testHarnessSession(request.sessionId)),
};

/** Explicit test-only provider registry; never used by production composition. */
export function makeTestHarnessProviderRegistry() {
  return makeHarnessProviderRegistry([
    {
      profileId: codexAppServerHarnessProfileId,
      provider: testHarnessProvider,
    },
  ]);
}

function testHarnessSession(sessionId: HarnessSessionId): HarnessSession {
  const turnId = parseHarnessTurnId("turn-test-worker");
  const events: ReadonlyArray<HarnessEvent> = [
    {
      capabilities: testHarnessCapabilities,
      kind: "sessionStarted",
      provider: testHarnessProvider.descriptor,
      sessionId,
      state: "running",
    },
    { kind: "turnStarted", sessionId, turnId },
    { kind: "turnCompleted", sessionId, status: "completed", turnId },
  ];
  return {
    events: Stream.fromIterable(events),
    interrupt: Option.some(Effect.void),
    resolveInteraction: () => Effect.void,
    send: () => Effect.void,
    snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
    steer: Option.none(),
  };
}
