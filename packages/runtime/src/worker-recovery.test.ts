import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { RunEvent, WorkerRecoveryAction, makeRunEvent, parseHarnessEvent, parseHarnessProfileId, parseHarnessSessionId, parseRunId } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeRunPaths } from "./paths.js";
import { recoverWorkerSession, type WorkerRecoveryProvider } from "./worker-recovery.js";
import { inspectRecoverableDeliveryWorktreeOwnership, parseDeliveryProvenance, prepareDeliveryWorktree, type DeliveryProvenance } from "./git-delivery.js";
import { actOnWorkerRecovery } from "./server-workflows.js";

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
  events[0] = event(1, "RUN_CREATED", { specPath: "input.md", delivery: { baseRevision: "a".repeat(40), mode: "pullRequest" }, execution: { selection: { harnessProfileId: "codexAppServer" } } });
  writeFileSync(paths.events, `${events.map((value) => JSON.stringify(Schema.encodeSync(RunEvent)(value))).join("\n")}\n`);
  return { root, runId, paths };
}
function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) { return Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer))); }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function realOwnedFixture() {
  const f = fixture(); rmSync(f.paths.workspace, { recursive: true, force: true });
  git(f.root, "init", "-b", "main"); git(f.root, "config", "user.email", "gaia@test.invalid"); git(f.root, "config", "user.name", "Gaia Test");
  writeFileSync(path.join(f.root, "README.md"), "base\n"); git(f.root, "add", "README.md"); git(f.root, "commit", "-m", "base");
  const remote = mkdtempSync(path.join(tmpdir(), "gaia-worker-recovery-remote-")); roots.push(remote); git(remote, "init", "--bare"); git(f.root, "remote", "add", "origin", remote); git(f.root, "push", "-u", "origin", "main");
  const head = git(f.root, "rev-parse", "HEAD");
  const provenance: DeliveryProvenance = { baseBranch: "main", baseRevision: head, headBranch: "gaia/run-1234567890", mode: "pullRequest", remote: "origin" };
  const lines = readFileSync(f.paths.events, "utf8").trim().split("\n"); const created = JSON.parse(lines[0]!); created.payload.delivery = provenance; lines[0] = JSON.stringify(created); writeFileSync(f.paths.events, `${lines.join("\n").replaceAll("a".repeat(40), head)}\n`);
  await run(prepareDeliveryWorktree({ options: { rootDirectory: f.root }, paths: f.paths, provenance }));
  const validateWorkspace = () => Effect.gen(function* () { const latest = JSON.parse(readFileSync(f.paths.events, "utf8").split("\n")[0]!); const accepted = parseDeliveryProvenance(latest.payload.delivery); if (accepted._tag === "None") return yield* Effect.fail(new Error("invalid provenance")); yield* inspectRecoverableDeliveryWorktreeOwnership({ expectedHeads: [head], options: { rootDirectory: f.root }, paths: f.paths, provenance: accepted.value }); });
  return { ...f, head, provenance, validateWorkspace };
}
const action = WorkerRecoveryAction.make({ actionId: "recover-1", expectedFailureSequence: 10, expectedSessionId: parseHarnessSessionId("session-run-1234567890"), harnessProfileId: parseHarnessProfileId("codexAppServer"), kind: "retryRecoverableWorkerFailure", model: "gpt-5.4" });

describe("recoverWorkerSession", () => {
  it.each([
    ["path", (f: Awaited<ReturnType<typeof realOwnedFixture>>, manifest: Record<string, unknown>) => { manifest.workspaceRoot = `${f.paths.workspace}-other`; }],
    ["common-dir", (_f: Awaited<ReturnType<typeof realOwnedFixture>>, manifest: Record<string, unknown>) => { manifest.workspaceCommonDir = "/wrong/common"; }],
    ["repository", (_f: Awaited<ReturnType<typeof realOwnedFixture>>, manifest: Record<string, unknown>) => { manifest.repositoryRoot = "/wrong/repository"; }],
    ["base", (_f: Awaited<ReturnType<typeof realOwnedFixture>>, manifest: Record<string, unknown>) => { manifest.baseRevision = "b".repeat(40); }],
    ["branch-plan", (f: Awaited<ReturnType<typeof realOwnedFixture>>) => { const lines = readFileSync(f.paths.events, "utf8").trim().split("\n"); const created = JSON.parse(lines[0]!); created.payload.delivery.headBranch = "gaia/other"; lines[0] = JSON.stringify(created); writeFileSync(f.paths.events, `${lines.join("\n")}\n`); }],
    ["ownership-digest", (_f: Awaited<ReturnType<typeof realOwnedFixture>>, manifest: Record<string, unknown>) => { manifest.token = "wrong"; }],
    ["primary-identity", (f: Awaited<ReturnType<typeof realOwnedFixture>>, manifest: Record<string, unknown>) => { manifest.workspaceRoot = f.root; }],
    ["cleanliness", (f: Awaited<ReturnType<typeof realOwnedFixture>>) => { writeFileSync(path.join(f.paths.workspace, "dirty.txt"), "dirty\n"); }],
    ["registration", (f: Awaited<ReturnType<typeof realOwnedFixture>>) => { git(f.root, "worktree", "remove", f.paths.workspace); mkdirSync(f.paths.workspace); }],
  ] as const)("rejects real %s identity drift with zero events and zero provider calls", async (_name, mutate) => {
    const f = await realOwnedFixture(); let calls = 0;
    const manifest = JSON.parse(readFileSync(f.paths.deliveryOwnershipManifest, "utf8")); mutate(f, manifest); if (_name !== "cleanliness" && _name !== "registration" && _name !== "branch-plan") writeFileSync(f.paths.deliveryOwnershipManifest, JSON.stringify(manifest));
    const before = readFileSync(f.paths.events, "utf8");
    const provider: WorkerRecoveryProvider = { listModels: () => Effect.sync(() => { calls++; return []; }), resumeThread: () => Effect.die("not called"), readThread: () => Effect.die("not called"), startTurn: () => Effect.die("not called") };
    await expect(run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace: f.validateWorkspace }))).rejects.toBeTruthy();
    expect(readFileSync(f.paths.events, "utf8")).toBe(before); expect(calls).toBe(0);
  });

  it("runs the public server workflow A/B restart and non-mutation matrix against a real retained Git root", async () => {
    const f = await realOwnedFixture(); const rootA = process.cwd(); const beforeHead = git(f.paths.workspace, "rev-parse", "HEAD"); const beforeStatus = git(f.paths.workspace, "status", "--porcelain"); const beforeCommon = git(f.paths.workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"); const beforeInventory = git(f.root, "worktree", "list", "--porcelain"); let starts = 0;
    const provider: WorkerRecoveryProvider = { listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]), resumeThread: (threadId) => Effect.succeed({ threadId }), readThread: (threadId) => Effect.succeed({ active: false, systemError: true, threadId }), startTurn: () => Effect.sync(() => { starts++; return { turnId: "turn-recovery" }; }) };
    expect(rootA).not.toBe(f.root);
    const activate = (runId: string, request: typeof action) => recoverWorkerSession(runId, request, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace: f.validateWorkspace });
    const confirmed = await run(actOnWorkerRecovery(f.runId, action, { rootDirectory: f.root, workerRecoveryActivator: activate }));
    expect(confirmed.state).toBe("dispatchConfirmed");
    if (confirmed.state !== "dispatchConfirmed") throw new Error("expected confirmed recovery");
    const restarted = await run(actOnWorkerRecovery(f.runId, action, { rootDirectory: f.root, workerRecoveryActivator: activate }));
    expect(restarted).toMatchObject({ nativeTurnIdDigest: confirmed.nativeTurnIdDigest, state: "dispatchConfirmed" }); expect(starts).toBe(1);
    expect(git(f.paths.workspace, "rev-parse", "HEAD")).toBe(beforeHead); expect(git(f.paths.workspace, "status", "--porcelain")).toBe(beforeStatus); expect(git(f.paths.workspace, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(beforeCommon); expect(git(f.root, "worktree", "list", "--porcelain")).toBe(beforeInventory);
  });
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
