import { NodeServices } from "@effect/platform-node";
import { createHash } from "node:crypto";
import {
  HarnessCapabilities,
  HarnessProviderDescriptor,
  HarnessSessionSnapshot,
  parseHarnessActionId,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessProviderId,
  parseHarnessQuestionId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseRunId,
  parseWorkspaceRelativePath,
} from "@gaia/core";
import { layer } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Option, Stream } from "effect";
import { describe, expect } from "vitest";
import {
  dispatchAgentSessionAction,
  makeLiveHarnessSessionCoordinator,
  readAgentSessionSnapshot,
  streamAgentSessionUpdates,
} from "./agent-session-runtime.js";
import { appendEvent, appendHarnessSessionEvent, appendHarnessSessionEventWithinSerialization, subscribeRunEventFeed, withRunEventSerialization } from "./event-store.js";
import type { HarnessSession } from "./harness-session.js";
import { makeRunPaths } from "./paths.js";

const runId = parseRunId("run-Gaia86rt01");
const sessionId = parseHarnessSessionId(`session-${runId}`);
const turnId = parseHarnessTurnId("turn-runtime");
const provider = HarnessProviderDescriptor.make({ displayName: "Synthetic", executionModes: ["local"], providerId: parseHarnessProviderId("private-provider") });
const capabilities = HarnessCapabilities.make({ approvals: [], fileChangeEvents: false, interruption: true, resumableSessions: true, review: false, steering: true, streamingMessages: true, structuredOutput: false, subagents: false, toolEvents: false, usageReporting: false, userQuestions: false });

describe("agent session runtime", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("projects a provider-neutral snapshot and permits non-contiguous filtered SSE IDs", () =>
      Effect.scoped(Effect.gen(function* () {
        const rootDirectory = yield* setupRun();
        yield* appendEvent(runId, yield* makeRunPaths(runId, { rootDirectory }), { type: "WORKER_STARTED" });
        const paths = yield* makeRunPaths(runId, { rootDirectory });
        yield* appendHarnessSessionEvent(runId, paths, { kind: "turnStarted", sessionId, turnId });
        const snapshot = yield* readAgentSessionSnapshot(runId, "agent-worker", { rootDirectory });
        expect(snapshot).not.toHaveProperty("provider");
        const stream = yield* streamAgentSessionUpdates(runId, "agent-worker", undefined, { rootDirectory });
        const updates = yield* stream.pipe(Stream.take(2), Stream.runCollect);
        expect(updates.map(({ eventSequence }) => eventSequence)).toEqual([2, 4]);
      })),
    );

    it.effect("hands off subscriber-first without losing or duplicating a concurrent append", () =>
      Effect.scoped(Effect.gen(function* () {
        const rootDirectory = yield* setupRun();
        const paths = yield* makeRunPaths(runId, { rootDirectory });
        const stream = yield* streamAgentSessionUpdates(runId, "agent-worker", undefined, { rootDirectory });
        const fiber = yield* stream.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
        yield* appendHarnessSessionEvent(runId, paths, { kind: "turnStarted", sessionId, turnId });
        const updates = yield* Fiber.join(fiber);
        expect(updates.map(({ eventSequence }) => eventSequence)).toEqual([2, 3]);
      })),
    );

    it.effect("delivers a terminal update before closing the selected-agent stream", () =>
      Effect.scoped(Effect.gen(function* () {
        const rootDirectory = yield* setupRun();
        const paths = yield* makeRunPaths(runId, { rootDirectory });
        yield* appendHarnessSessionEvent(runId, paths, { kind: "turnStarted", sessionId, turnId });
        yield* appendHarnessSessionEvent(runId, paths, { kind: "turnCompleted", sessionId, status: "completed", turnId });
        const stream = yield* streamAgentSessionUpdates(runId, "agent-worker", undefined, { rootDirectory });
        const updates = yield* stream.pipe(Stream.runCollect);
        expect(updates.map(({ eventSequence }) => eventSequence)).toEqual([2, 3, 4]);
        expect(updates.at(-1)?.terminal).toBe(true);
      })),
    );

    it.effect("records and confirms a steer exactly once for same-ID retry", () =>
      Effect.scoped(Effect.gen(function* () {
        const rootDirectory = yield* setupRun();
        const paths = yield* makeRunPaths(runId, { rootDirectory });
        yield* appendHarnessSessionEvent(runId, paths, { kind: "turnStarted", sessionId, turnId });
        const calls: string[] = [];
        const coordinator = makeLiveHarnessSessionCoordinator();
        yield* coordinator.register({ agentId: "agent-worker", runId, session: fakeSession(calls), sessionId });
        const action = { actionId: parseHarnessActionId("action-steer"), kind: "steer" as const, sessionId, text: "focus", turnId };
        const first = yield* dispatchAgentSessionAction({ action, agentId: "agent-worker", coordinator, options: { rootDirectory }, runId });
        const second = yield* dispatchAgentSessionAction({ action, agentId: "agent-worker", coordinator, options: { rootDirectory }, runId });
        expect(first.state).toBe("dispatchConfirmed");
        expect(second.state).toBe("dispatchConfirmed");
        expect(calls).toEqual(["focus"]);
      })),
    );

    it.effect("rejects unsupported, stale, duplicate, and cross-session actions before dispatch", () =>
      Effect.scoped(Effect.gen(function* () {
        const rootDirectory = yield* setupRun();
        const paths = yield* makeRunPaths(runId, { rootDirectory });
        yield* appendHarnessSessionEvent(runId, paths, { kind: "turnStarted", sessionId, turnId });
        const coordinator = makeLiveHarnessSessionCoordinator();
        const calls: string[] = [];
        yield* coordinator.register({ agentId: "agent-worker", runId, session: fakeSession(calls), sessionId });

        const unsupportedFollowUp = yield* dispatchAgentSessionAction({
          action: { actionId: parseHarnessActionId("action-follow-up"), kind: "followUp", sessionId, text: "resume" },
          agentId: "agent-worker",
          coordinator,
          options: { rootDirectory },
          runId,
        }).pipe(Effect.exit);
        expect(unsupportedFollowUp._tag).toBe("Failure");

        const staleApproval = yield* dispatchAgentSessionAction({
          action: { actionId: parseHarnessActionId("action-stale"), decision: "approve", interactionId: parseHarnessInteractionId("interaction-missing"), kind: "approval", sessionId },
          agentId: "agent-worker",
          coordinator,
          options: { rootDirectory },
          runId,
        }).pipe(Effect.exit);
        expect(staleApproval._tag).toBe("Failure");

        const wrongSession = yield* dispatchAgentSessionAction({
          action: { actionId: parseHarnessActionId("action-wrong-session"), kind: "interrupt", sessionId: parseHarnessSessionId("session-other"), turnId },
          agentId: "agent-worker",
          coordinator,
          options: { rootDirectory },
          runId,
        }).pipe(Effect.exit);
        expect(wrongSession._tag).toBe("Failure");
        expect(calls).toEqual([]);
      })),
    );

    it.effect("confirms approval, user-input, and MCP actions only after provider acceptance", () =>
      Effect.scoped(Effect.gen(function* () {
        const rootDirectory = yield* setupRun(HarnessCapabilities.make({ ...capabilities, approvals: ["command", "userInput", "mcpElicitation"], userQuestions: true }));
        const paths = yield* makeRunPaths(runId, { rootDirectory });
        const commandInteractionId = parseHarnessInteractionId("interaction-command");
        const userInputInteractionId = parseHarnessInteractionId("interaction-user-input");
        const mcpInteractionId = parseHarnessInteractionId("interaction-mcp");
        yield* appendHarnessSessionEvent(runId, paths, { kind: "turnStarted", sessionId, turnId });
        yield* appendHarnessSessionEvent(runId, paths, { interaction: { allowedDecisions: ["approve", "decline"], command: "pnpm test", interactionId: commandInteractionId, itemId: parseHarnessItemId("item-command"), kind: "commandApproval", requestedAt: "2026-07-10T00:00:00.000Z", turnId, workspacePath: parseWorkspaceRelativePath(".") }, kind: "interactionRequested", sessionId });
        yield* appendHarnessSessionEvent(runId, paths, { interaction: { interactionId: userInputInteractionId, itemId: parseHarnessItemId("item-question"), kind: "userInput", questions: [{ options: [], prompt: "Continue?", questionId: parseHarnessQuestionId("question-continue"), secret: false }], requestedAt: "2026-07-10T00:00:01.000Z", turnId }, kind: "interactionRequested", sessionId });
        yield* appendHarnessSessionEvent(runId, paths, { interaction: { interactionId: mcpInteractionId, kind: "mcpElicitation", message: "Pick action", mode: "form", requestedAt: "2026-07-10T00:00:02.000Z", serverName: "safe-mcp", turnId }, kind: "interactionRequested", sessionId });
        const resolutions: unknown[] = [];
        const coordinator = makeLiveHarnessSessionCoordinator();
        yield* coordinator.register({ agentId: "agent-worker", runId, session: fakeSession([], resolutions), sessionId });

        const approval = yield* dispatchAgentSessionAction({ action: { actionId: parseHarnessActionId("action-approve"), decision: "approve", interactionId: commandInteractionId, kind: "approval", sessionId }, agentId: "agent-worker", coordinator, options: { rootDirectory }, runId });
        const userInput = yield* dispatchAgentSessionAction({ action: { actionId: parseHarnessActionId("action-answer"), answers: [{ answers: ["yes"], questionId: parseHarnessQuestionId("question-continue") }], interactionId: userInputInteractionId, kind: "userInput", sessionId }, agentId: "agent-worker", coordinator, options: { rootDirectory }, runId });
        const mcp = yield* dispatchAgentSessionAction({ action: { action: "submit", actionId: parseHarnessActionId("action-mcp"), content: "safe", interactionId: mcpInteractionId, kind: "mcpElicitation", sessionId }, agentId: "agent-worker", coordinator, options: { rootDirectory }, runId });
        expect([approval.state, userInput.state, mcp.state]).toEqual(["dispatchConfirmed", "dispatchConfirmed", "dispatchConfirmed"]);
        expect(resolutions).toHaveLength(3);

        const duplicate = yield* dispatchAgentSessionAction({ action: { actionId: parseHarnessActionId("action-duplicate"), decision: "decline", interactionId: commandInteractionId, kind: "approval", sessionId }, agentId: "agent-worker", coordinator, options: { rootDirectory }, runId }).pipe(Effect.exit);
        expect(duplicate._tag).toBe("Failure");
      })),
    );

    it.effect("derives outcomeUnknown from both incomplete crash windows and never redispatches", () =>
      Effect.scoped(Effect.gen(function* () {
        const rootDirectory = yield* setupRun();
        const paths = yield* makeRunPaths(runId, { rootDirectory });
        yield* appendHarnessSessionEvent(runId, paths, { kind: "turnStarted", sessionId, turnId });
        const actionId = parseHarnessActionId("action-crash");
        const binding = { actionId, actionKind: "interrupt" as const, agentId: "agent-worker", payloadDigest: actionDigestForInterrupt(actionId), sessionId, targetId: turnId };
        yield* appendHarnessSessionEvent(runId, paths, { ...binding, kind: "operatorActionIntentRecorded" });
        const coordinator = makeLiveHarnessSessionCoordinator();
        const intentReceipt = yield* dispatchAgentSessionAction({ action: { actionId, kind: "interrupt", sessionId, turnId }, agentId: "agent-worker", coordinator, options: { rootDirectory }, runId });
        expect(intentReceipt.state).toBe("outcomeUnknown");

        const attemptedId = parseHarnessActionId("action-attempted");
        const attempted = { ...binding, actionId: attemptedId, payloadDigest: actionDigestForInterrupt(attemptedId) };
        yield* withRunEventSerialization(paths, Effect.gen(function* () {
          yield* appendHarnessSessionEventWithinSerialization(runId, paths, { ...attempted, kind: "operatorActionIntentRecorded" });
          yield* appendHarnessSessionEventWithinSerialization(runId, paths, { ...attempted, kind: "operatorActionDispatchAttempted" });
        }));
        const receipt = yield* dispatchAgentSessionAction({ action: { actionId: attemptedId, kind: "interrupt", sessionId, turnId }, agentId: "agent-worker", coordinator, options: { rootDirectory }, runId });
        expect(receipt.state).toBe("outcomeUnknown");
      })),
    );

    it.effect("fails a bounded authoritative subscriber on overflow", () =>
      Effect.scoped(Effect.gen(function* () {
        const rootDirectory = yield* setupRun();
        const paths = yield* makeRunPaths(runId, { rootDirectory });
        const subscription = yield* subscribeRunEventFeed(paths, 1);
        yield* appendEvent(runId, paths, { type: "WORKER_STARTED" });
        yield* appendEvent(runId, paths, { type: "VERIFICATION_STARTED" });
        const exit = yield* subscription.live.pipe(Stream.runCollect, Effect.exit);
        expect(exit._tag).toBe("Failure");
      })),
    );

    it.effect("rejects duplicate live registration and clears scoped handles on shutdown", () =>
      Effect.scoped(Effect.gen(function* () {
        const coordinator = makeLiveHarnessSessionCoordinator();
        const calls: string[] = [];
        yield* coordinator.register({ agentId: "agent-worker", runId, session: fakeSession(calls), sessionId });
        const duplicate = yield* coordinator.register({ agentId: "agent-worker", runId, session: fakeSession(calls), sessionId }).pipe(Effect.exit);
        expect(duplicate._tag).toBe("Failure");
        yield* coordinator.shutdown;
        const live = yield* coordinator.get({ agentId: "agent-worker", runId, sessionId });
        expect(live).toBeUndefined();
      })),
    );
  });
});

function setupRun(runCapabilities = capabilities) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rootDirectory = yield* fs.makeTempDirectory({ prefix: "gaia-agent-session-" });
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    yield* fs.makeDirectory(paths.root, { recursive: true });
    yield* appendEvent(runId, paths, { payload: { specPath: "spec.md" }, type: "RUN_CREATED" });
    yield* appendHarnessSessionEvent(runId, paths, { capabilities: runCapabilities, kind: "sessionStarted", provider, sessionId, state: "running" });
    return rootDirectory;
  });
}

function fakeSession(calls: string[], resolutions: unknown[] = []): HarnessSession {
  const snapshot = HarnessSessionSnapshot.make({ capabilities, items: [], pendingInteractions: [], provider, recovered: false, resolvedInteractions: [], sessionId, state: "running", turns: [{ status: "running", turnId }] });
  return { events: Stream.empty, interrupt: Option.some(Effect.void), resolveInteraction: (resolution) => Effect.sync(() => { resolutions.push(resolution); }), send: () => Effect.void, snapshot: Effect.succeed(snapshot), steer: Option.some((input) => Effect.sync(() => { calls.push(input.text); })) };
}

function actionDigestForInterrupt(actionId: ReturnType<typeof parseHarnessActionId>) {
  const canonical = `{"actionId":"${actionId}","kind":"interrupt","sessionId":"${sessionId}","turnId":"${turnId}"}`;
  return createHash("sha256").update(canonical).digest("hex");
}
