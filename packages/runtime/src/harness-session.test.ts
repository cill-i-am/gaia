import {
  HarnessCapabilities,
  HarnessProviderDescriptor,
  HarnessSessionSnapshot,
  HarnessTurnSnapshot,
  parseHarnessProviderId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseWorkspaceRelativePath,
} from "@gaia/core";
import { Effect, Option, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  HarnessCheckpointTokenSchema,
  HarnessCorrelationTokenSchema,
  HarnessSessionResume,
  resumeHarnessSession,
  startHarnessSession,
  type HarnessProvider,
  type HarnessSession,
} from "./index.js";

const sessionId = parseHarnessSessionId("session-synthetic");
const turnId = parseHarnessTurnId("turn-synthetic");
const capabilities = HarnessCapabilities.make({
  approvals: [],
  fileChangeEvents: false,
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
const descriptor = HarnessProviderDescriptor.make({
  displayName: "Synthetic Stream Harness",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("synthetic-stream"),
});
const snapshot = HarnessSessionSnapshot.make({
  capabilities,
  items: [],
  pendingInteractions: [],
  provider: descriptor,
  recovered: false,
  resolvedInteractions: [],
  sessionId,
  state: "running",
  turns: [HarnessTurnSnapshot.make({ status: "running", turnId })],
});

function syntheticProvider(started: Array<string>): HarnessProvider {
  const session: HarnessSession = {
    events: Stream.fromIterable([
      {
        capabilities,
        kind: "sessionStarted",
        provider: descriptor,
        sessionId,
        state: "running",
      },
      {
        kind: "turnStarted",
        sessionId,
        turnId,
      },
    ]),
    interrupt: Option.some(Effect.void),
    resolveInteraction: () => Effect.void,
    send: () => Effect.succeed(undefined),
    snapshot: Effect.succeed(snapshot),
    steer: Option.none(),
  };

  return {
    createSession: (request) => {
      started.push(request.sessionId);
      return Effect.succeed(session);
    },
    descriptor,
    detect: Effect.succeed({
      auth: { state: "notRequired" },
      capabilities,
      state: "available",
      version: "1.0.0",
    }),
    resumeSession: () => Effect.succeed(session),
  };
}

describe("provider-neutral harness session SPI", () => {
  it("keeps correlation and checkpoint tokens opaque, bounded, and differently encoded", () => {
    const correlation = Schema.decodeUnknownSync(HarnessCorrelationTokenSchema)(
      "hcor1_eyJwcm92aWRlciI6InRlc3QifQ"
    );
    const checkpoint = Schema.decodeUnknownSync(HarnessCheckpointTokenSchema)(
      "hchk1_eyJwcm92aWRlciI6InRlc3QifQ"
    );

    expect(correlation).not.toBe(checkpoint);
    expect(() =>
      Schema.decodeUnknownSync(HarnessCheckpointTokenSchema)("turn-1")
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HarnessCorrelationTokenSchema)(
        `hcor1_${"x".repeat(36_865)}`
      )
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(HarnessSessionResume)({
        expectedCheckpoint: checkpoint,
        sessionId,
        workspacePath: ".",
      }).expectedCheckpoint
    ).toBe(checkpoint);
  });

  it("runs a synthetic non-Codex provider through the public session contract", async () => {
    const started: Array<string> = [];
    const provider = syntheticProvider(started);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* startHarnessSession({
            provider,
            request: {
              input: { text: "run the synthetic task" },
              sessionId,
              workspacePath: parseWorkspaceRelativePath("."),
            },
            requiredCapabilities: ["streamingMessages", "interruption"],
          });
          const events = yield* Stream.runCollect(session.events);
          return {
            events: Array.from(events),
            snapshot: yield* session.snapshot,
          };
        })
      )
    );

    expect(started).toEqual([sessionId]);
    expect(result.events.map(({ kind }) => kind)).toEqual([
      "sessionStarted",
      "turnStarted",
    ]);
    expect(result.snapshot.provider.providerId).toBe("synthetic-stream");
  });

  it("fails a capability mismatch before provider dispatch", async () => {
    const started: Array<string> = [];
    const error = await Effect.runPromise(
      Effect.scoped(
        startHarnessSession({
          provider: syntheticProvider(started),
          request: {
            input: { text: "review" },
            sessionId,
            workspacePath: parseWorkspaceRelativePath("."),
          },
          requiredCapabilities: ["review"],
        }).pipe(Effect.flip)
      )
    );

    expect(error._tag).toBe("HarnessCapabilityMismatchError");
    if (error._tag !== "HarnessCapabilityMismatchError") {
      throw new Error(`Unexpected error: ${error._tag}`);
    }
    expect(error.missing).toEqual(["review"]);
    expect(started).toEqual([]);
  });

  it("rejects capability flags that contradict optional session operations", async () => {
    const started: Array<string> = [];
    const provider = syntheticProvider(started);
    const contradictory: HarnessProvider = {
      ...provider,
      createSession: (request) =>
        provider
          .createSession(request)
          .pipe(
            Effect.map((session) => ({ ...session, interrupt: Option.none() }))
          ),
    };

    const error = await Effect.runPromise(
      Effect.scoped(
        startHarnessSession({
          provider: contradictory,
          request: {
            input: { text: "interruptible task" },
            sessionId,
            workspacePath: parseWorkspaceRelativePath("."),
          },
          requiredCapabilities: ["interruption"],
        }).pipe(Effect.flip)
      )
    );

    expect(error._tag).toBe("HarnessSessionContractError");
    if (error._tag !== "HarnessSessionContractError") {
      throw new Error(`Unexpected error: ${error._tag}`);
    }
    expect(error.contradictions).toEqual(["interruption"]);
    expect(started).toEqual([sessionId]);
  });

  it("rejects optional operations that are callable without the matching capability", async () => {
    const started: Array<string> = [];
    const provider = syntheticProvider(started);
    const contradictory: HarnessProvider = {
      ...provider,
      createSession: (request) =>
        provider.createSession(request).pipe(
          Effect.map((session) => ({
            ...session,
            steer: Option.some(() => Effect.succeed(undefined)),
          }))
        ),
    };

    const error = await Effect.runPromise(
      Effect.scoped(
        startHarnessSession({
          provider: contradictory,
          request: {
            input: { text: "not steerable" },
            sessionId,
            workspacePath: parseWorkspaceRelativePath("."),
          },
          requiredCapabilities: [],
        }).pipe(Effect.flip)
      )
    );

    expect(error._tag).toBe("HarnessSessionContractError");
    if (error._tag !== "HarnessSessionContractError") {
      throw new Error(`Unexpected error: ${error._tag}`);
    }
    expect(error.contradictions).toEqual(["steering"]);
  });

  it("fails resume capability mismatch before provider dispatch", async () => {
    const resumed: Array<string> = [];
    const base = syntheticProvider([]);
    const provider: HarnessProvider = {
      ...base,
      resumeSession: (request) => {
        resumed.push(request.sessionId);
        return base.resumeSession(request);
      },
    };

    const error = await Effect.runPromise(
      Effect.scoped(
        resumeHarnessSession({
          provider,
          request: {
            sessionId,
            workspacePath: parseWorkspaceRelativePath("."),
          },
          requiredCapabilities: ["review"],
        }).pipe(Effect.flip)
      )
    );

    expect(error._tag).toBe("HarnessCapabilityMismatchError");
    expect(resumed).toEqual([]);
  });
});
