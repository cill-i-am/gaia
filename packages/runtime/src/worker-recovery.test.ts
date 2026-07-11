import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { RunEvent, WorkerRecoveryAction, makeRunEvent, parseHarnessEvent, parseHarnessProfileId, parseHarnessSessionId, parseRunId } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeRunPaths } from "./paths.js";
import { recoverWorkerSession, type WorkerRecoveryProvider } from "./worker-recovery.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "gaia-worker-recovery-")); roots.push(root);
  const runId = parseRunId("run-1234567890");
  const paths = Effect.runSync(makeRunPaths(runId, { rootDirectory: root }).pipe(Effect.provide(NodePath.layer)));
  mkdirSync(paths.root, { recursive: true }); mkdirSync(paths.workspace, { recursive: true });
  const event = (sequence: number, type: Parameters<typeof makeRunEvent>[0]["type"], payload: Record<string, Schema.Json>) => makeRunEvent({ runId, sequence, timestamp: `2026-07-11T00:00:0${sequence}.000Z`, type, payload });
  const session = (value: unknown) => ({ event: parseHarnessEvent(value) as unknown as Schema.Json });
  const events = [event(1, "RUN_CREATED", { specPath: "input.md" }), event(2, "DELIVERY_STARTED", { delivery: { baseBranch: "main", baseRevision: "a".repeat(40), headBranch: "gaia/run-1234567890", mode: "pullRequest", remote: "origin", stage: "delivering" } }), event(3, "WORKSPACE_PREPARED", { workspacePath: "workspace" }), event(4, "REVIEW_STARTED", { phase: "plan" }), event(5, "REVIEW_COMPLETED", { phase: "plan", reviewPath: "plan.md", reviewerName: "reviewer", status: "approved" }), event(6, "WORKER_STARTED", {}), event(7, "HARNESS_SESSION_EVENT_RECORDED", session({ sessionId: "session-run-1234567890", kind: "sessionStarted", state: "connecting", provider: { displayName: "Codex App Server", executionModes: ["local"], providerId: "codex-app-server" }, capabilities: { approvals: [], fileChangeEvents: true, interruption: true, resumableSessions: true, review: true, steering: true, streamingMessages: true, structuredOutput: false, subagents: false, toolEvents: true, usageReporting: true, userQuestions: true } })), event(8, "HARNESS_SESSION_EVENT_RECORDED", session({ sessionId: "session-run-1234567890", kind: "turnStarted", turnId: "turn-initial" })), event(9, "HARNESS_SESSION_EVENT_RECORDED", session({ sessionId: "session-run-1234567890", kind: "sessionFailed", failure: { code: "CodexThreadSystemError", kind: "providerFailure", message: "system error", recoverable: true } })), event(10, "RUN_FAILED", { code: "HarnessSessionFailed", message: "failed", recoverable: true, stage: "runningWorker" })];
  writeFileSync(paths.events, `${events.map((value) => JSON.stringify(Schema.encodeSync(RunEvent)(value))).join("\n")}\n`); writeFileSync(paths.snapshots, "");
  return { root, runId, paths };
}
function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) { return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer))); }
const action = WorkerRecoveryAction.make({ actionId: "recover-1", expectedFailureSequence: 10, expectedSessionId: parseHarnessSessionId("session-run-1234567890"), harnessProfileId: parseHarnessProfileId("codexAppServer"), kind: "retryRecoverableWorkerFailure", model: "gpt-5.4" });

describe("recoverWorkerSession", () => {
  it("preflights the same thread and dispatches exactly one explicit-model turn", async () => {
    const f = fixture(); const calls: string[] = [];
    const provider: WorkerRecoveryProvider = { listModels: () => Effect.sync(() => { calls.push("models"); return [{ hidden: false, id: "gpt-5.4" }]; }), resumeThread: (threadId) => Effect.sync(() => { calls.push("resume"); return { threadId }; }), readThread: (threadId) => Effect.sync(() => { calls.push("read"); return { active: false, systemError: true, threadId }; }), startTurn: ({ model }) => Effect.sync(() => { calls.push(`start:${model}`); return { turnId: "turn-recovery" }; }) };
    const validateWorkspace = () => Effect.void;
    const result = await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace }));
    expect(result.state).toBe("dispatchConfirmed"); expect(calls).toEqual(["models", "resume", "read", "start:gpt-5.4"]);
    expect(readFileSync(f.paths.events, "utf8")).not.toContain("thread-1");
    await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace }));
    expect(calls).toEqual(["models", "resume", "read", "start:gpt-5.4"]);
  });

  it("makes an ambiguous dispatch terminal and never redispatches", async () => {
    const f = fixture(); let starts = 0;
    const provider: WorkerRecoveryProvider = { listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]), resumeThread: (threadId) => Effect.succeed({ threadId }), readThread: (threadId) => Effect.succeed({ active: false, systemError: true, threadId }), startTurn: () => Effect.sync(() => { starts++; throw new Error("lost response"); }) };
    const validateWorkspace = () => Effect.void;
    const first = await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace })); expect(first.state).toBe("outcomeUnknown");
    const second = await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace })); expect(second.state).toBe("outcomeUnknown"); expect(starts).toBe(1);
  });
});
