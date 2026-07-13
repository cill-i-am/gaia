import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { RunEvent, WorkerRecoveryAction, makeRunEvent, parseHarnessEvent, parseHarnessProfileId, parseHarnessSessionId, parseRunId } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeRunPaths } from "./paths.js";
import { readPrivateWorkerRecoveryTurn, recoverWorkerSession, type WorkerRecoveryProvider, type WorkerRecoveryThreadStatus } from "./worker-recovery.js";
import { inspectContinuableDeliveryWorktreeOwnership, inspectRecoverableDeliveryWorktreeOwnership, inspectRetainedPayloadDeliveryWorktreeOwnership, parseDeliveryProvenance, prepareDeliveryWorktree, type DeliveryProvenance } from "./git-delivery.js";
import { actOnWorkerRecovery } from "./server-workflows.js";
import { makeRuntimeError } from "./errors.js";
import { appendEvent, appendHarnessSessionEvent } from "./event-store.js";

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
  writeFileSync(path.join(f.root, "README.md"), "base\n");
  writeFileSync(path.join(f.root, ".gitignore"), [".gaia/", ".turbo/", "dist/", "**/.gaia/", "**/.turbo/", "**/dist/"].join("\n") + "\n");
  git(f.root, "add", "README.md", ".gitignore"); git(f.root, "commit", "-m", "base");
  const remote = mkdtempSync(path.join(tmpdir(), "gaia-worker-recovery-remote-")); roots.push(remote); git(remote, "init", "--bare"); git(f.root, "remote", "add", "origin", remote); git(f.root, "push", "-u", "origin", "main");
  const head = git(f.root, "rev-parse", "HEAD");
  const provenance: DeliveryProvenance = { baseBranch: "main", baseRevision: head, headBranch: "gaia/run-1234567890", mode: "pullRequest", remote: "origin" };
  const lines = readFileSync(f.paths.events, "utf8").trim().split("\n"); const created = JSON.parse(lines[0]!); created.payload.delivery = provenance; lines[0] = JSON.stringify(created); writeFileSync(f.paths.events, `${lines.join("\n").replaceAll("a".repeat(40), head)}\n`);
  await run(prepareDeliveryWorktree({ options: { rootDirectory: f.root }, paths: f.paths, provenance }));
  const validateWorkspace = () => Effect.gen(function* () { const latest = JSON.parse(readFileSync(f.paths.events, "utf8").split("\n")[0]!); const accepted = parseDeliveryProvenance(latest.payload.delivery); if (accepted._tag === "None") return yield* Effect.fail(new Error("invalid provenance")); yield* inspectRecoverableDeliveryWorktreeOwnership({ expectedHeads: [head], options: { rootDirectory: f.root }, paths: f.paths, provenance: accepted.value }); });
  return { ...f, head, provenance, validateWorkspace };
}
const action = WorkerRecoveryAction.make({ actionId: "recover-1", expectedFailureSequence: 10, expectedSessionId: parseHarnessSessionId("session-run-1234567890"), harnessProfileId: parseHarnessProfileId("codexAppServer"), kind: "retryRecoverableWorkerFailure", model: "gpt-5.4" });
const threadState = (status: WorkerRecoveryThreadStatus, threadId = "thread-1") => ({ status, threadId });
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function rewriteStoredEvents(eventsPath: string, mutate: (events: Array<Record<string, unknown>>) => void) {
  const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  mutate(events);
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

describe("recoverWorkerSession", () => {
  it("partitions worker recovery authority by exact failure generation", async () => {
    const f = fixture();
    let starts = 0;
    const provider: WorkerRecoveryProvider = {
      listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]),
      resumeThread: (threadId) => Effect.succeed(threadState("idle", threadId)),
      readThread: (threadId) => Effect.succeed(threadState("systemError", threadId)),
      startTurn: () => Effect.sync(() => {
        starts++;
        return { turnId: `turn-recovery-${starts}` };
      }),
    };

    const first = await run(recoverWorkerSession(f.runId, action, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.void,
    }));
    expect(first.state).toBe("dispatchConfirmed");
    expect(starts).toBe(1);

    await run(appendHarnessSessionEvent(f.runId, f.paths, parseHarnessEvent({
      failure: { code: "CodexThreadSystemError", kind: "providerFailure", message: "second failure", recoverable: true },
      kind: "sessionFailed",
      sessionId: "session-run-1234567890",
    })));
    const secondFailure = await run(appendEvent(f.runId, f.paths, {
      payload: { code: "HarnessSessionFailed", message: "second failed", recoverable: true, stage: "runningWorker" },
      type: "RUN_FAILED",
    }));
    const secondAction = WorkerRecoveryAction.make({
      ...action,
      actionId: "recover-2",
      expectedFailureSequence: secondFailure.event.sequence,
    });

    const replayOld = await run(recoverWorkerSession(f.runId, action, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.void,
    }));
    expect(replayOld).toMatchObject({
      actionId: first.actionId,
      expectedFailureSequence: first.expectedFailureSequence,
      nativeTurnIdDigest: first.state === "dispatchConfirmed" ? first.nativeTurnIdDigest : undefined,
      state: first.state,
    });
    expect(starts).toBe(1);

    const second = await run(recoverWorkerSession(f.runId, secondAction, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.void,
    }));
    expect(second).toMatchObject({ actionId: "recover-2", expectedFailureSequence: secondFailure.event.sequence, state: "dispatchConfirmed" });
    expect(starts).toBe(2);

    const replaySecond = await run(recoverWorkerSession(f.runId, secondAction, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.void,
    }));
    expect(replaySecond).toMatchObject({
      actionId: second.actionId,
      expectedFailureSequence: second.expectedFailureSequence,
      nativeTurnIdDigest: second.state === "dispatchConfirmed" ? second.nativeTurnIdDigest : undefined,
      state: second.state,
    });
    expect(starts).toBe(2);

    const drift = WorkerRecoveryAction.make({ ...secondAction, actionId: "recover-2-drift" });
    await expect(run(recoverWorkerSession(f.runId, drift, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.void,
    }))).rejects.toBeTruthy();
    expect(starts).toBe(2);
  });

  it("rejects stale private checkpoints from older recovery generations", async () => {
    const f = fixture();
    const provider: WorkerRecoveryProvider = {
      listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]),
      resumeThread: (threadId) => Effect.succeed(threadState("idle", threadId)),
      readThread: (threadId) => Effect.succeed(threadState("systemError", threadId)),
      startTurn: () => Effect.succeed({ turnId: "turn-recovery-1" }),
    };
    const first = await run(recoverWorkerSession(f.runId, action, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.void,
    }));
    if (first.state !== "dispatchConfirmed") throw new Error("expected confirmed recovery");

    const second = {
      ...first,
      actionId: "recover-2",
      expectedFailureSequence: 16,
      nativeTurnIdDigest: sha256("turn-recovery-1"),
    };

    await expect(run(readPrivateWorkerRecoveryTurn(f.paths.root, second.nativeTurnIdDigest, second))).rejects.toBeTruthy();
  });

  it("does not admit a later generation until previous generations are terminal", async () => {
    const f = fixture();
    const base = { ...action, attempt: 1 as const, maxAttempts: 1 as const, payloadDigest: "a".repeat(64) };
    await run(appendEvent(f.runId, f.paths, {
      payload: { recovery: { ...base, state: "intentRecorded" } },
      type: "WORKER_RECOVERY_RECORDED",
    }));
    await run(appendHarnessSessionEvent(f.runId, f.paths, parseHarnessEvent({
      failure: { code: "CodexThreadSystemError", kind: "providerFailure", message: "second failure", recoverable: true },
      kind: "sessionFailed",
      sessionId: "session-run-1234567890",
    })));
    const secondFailure = await run(appendEvent(f.runId, f.paths, {
      payload: { code: "HarnessSessionFailed", message: "second failed", recoverable: true, stage: "runningWorker" },
      type: "RUN_FAILED",
    }));
    const secondAction = WorkerRecoveryAction.make({ ...action, actionId: "recover-2", expectedFailureSequence: secondFailure.event.sequence });
    const before = readFileSync(f.paths.events, "utf8");
    let calls = 0;
    const provider: WorkerRecoveryProvider = {
      listModels: () => Effect.sync(() => { calls++; return [{ hidden: false, id: "gpt-5.4" }]; }),
      resumeThread: () => Effect.die("not called"),
      readThread: () => Effect.die("not called"),
      startTurn: () => Effect.die("not called"),
    };

    await expect(run(recoverWorkerSession(f.runId, secondAction, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.void,
    }))).rejects.toBeTruthy();
    expect(readFileSync(f.paths.events, "utf8")).toBe(before);
    expect(calls).toBe(0);
  });

  it("serializes concurrent same-generation recovery actions to one dispatch", async () => {
    const f = fixture();
    let starts = 0;
    const provider: WorkerRecoveryProvider = {
      listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]),
      resumeThread: (threadId) => Effect.succeed(threadState("idle", threadId)),
      readThread: (threadId) => Effect.succeed(threadState("systemError", threadId)),
      startTurn: () => Effect.sync(() => {
        starts++;
        return { turnId: `turn-concurrent-${starts}` };
      }),
    };

    const results = await Promise.allSettled([
      run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace: () => Effect.void })),
      run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace: () => Effect.void })),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const fulfilled = results.find((result) => result.status === "fulfilled");
    if (fulfilled === undefined || fulfilled.status !== "fulfilled") throw new Error("expected one fulfilled recovery");
    expect(fulfilled.value.state).toBe("dispatchConfirmed");
    expect(starts).toBe(1);

    const drift = WorkerRecoveryAction.make({ ...action, actionId: "recover-drift" });
    const driftResult = await run(recoverWorkerSession(f.runId, drift, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.void,
    }).pipe(Effect.exit));
    expect(driftResult._tag).toBe("Failure");
    expect(starts).toBe(1);
  });

  it("allows dirty registered owned worktrees for continuation ownership", async () => {
    const f = await realOwnedFixture();
    writeFileSync(path.join(f.paths.workspace, "payload-change.txt"), "dirty payload\n");

    await expect(run(inspectContinuableDeliveryWorktreeOwnership({
      expectedHeads: [f.head],
      options: { rootDirectory: f.root },
      paths: f.paths,
      provenance: f.provenance,
    }))).resolves.toBeUndefined();
  });

  it("fingerprints tracked payload while allowing ignored generated output churn", async () => {
    const f = await realOwnedFixture();
    writeFileSync(path.join(f.paths.workspace, "README.md"), "payload change\n");
    mkdirSync(path.join(f.paths.workspace, "apps/server/.gaia"), { recursive: true });
    mkdirSync(path.join(f.paths.workspace, "packages/runtime/dist"), { recursive: true });
    mkdirSync(path.join(f.paths.workspace, ".turbo"), { recursive: true });
    writeFileSync(path.join(f.paths.workspace, "apps/server/.gaia/events.jsonl"), "generated\n");
    writeFileSync(path.join(f.paths.workspace, "packages/runtime/dist/index.js"), "generated\n");
    writeFileSync(path.join(f.paths.workspace, ".turbo/cache.bin"), "generated\n");

    const first = await run(inspectRetainedPayloadDeliveryWorktreeOwnership({
      expectedHeads: [f.head],
      options: { rootDirectory: f.root },
      paths: f.paths,
      provenance: f.provenance,
    }));

    writeFileSync(path.join(f.paths.workspace, "packages/runtime/dist/index.js"), "generated churn\n");
    writeFileSync(path.join(f.paths.workspace, "apps/server/.gaia/events.jsonl"), "generated churn\n");
    const second = await run(inspectRetainedPayloadDeliveryWorktreeOwnership({
      expectedHeads: [f.head],
      options: { rootDirectory: f.root },
      paths: f.paths,
      provenance: f.provenance,
    }));

    expect(first).toEqual(second);
    expect(first.trackedPayloadEntryCount).toBe(1);
  });

  it.each([
    ["unexpected unignored untracked file", (f: Awaited<ReturnType<typeof realOwnedFixture>>) => {
      mkdirSync(path.join(f.paths.workspace, "src"), { recursive: true });
      writeFileSync(path.join(f.paths.workspace, "src/new-file.ts"), "untracked\n");
    }],
    ["tracked generated output", (f: Awaited<ReturnType<typeof realOwnedFixture>>) => {
      mkdirSync(path.join(f.paths.workspace, "dist"), { recursive: true });
      writeFileSync(path.join(f.paths.workspace, "dist/tracked.js"), "generated\n");
      git(f.paths.workspace, "add", "-f", "dist/tracked.js");
    }],
  ] as const)("rejects retained payload contamination: %s", async (_name, contaminate) => {
    const f = await realOwnedFixture();
    writeFileSync(path.join(f.paths.workspace, "README.md"), "payload change\n");
    contaminate(f);

    await expect(run(inspectRetainedPayloadDeliveryWorktreeOwnership({
      expectedHeads: [f.head],
      options: { rootDirectory: f.root },
      paths: f.paths,
      provenance: f.provenance,
    }))).rejects.toBeTruthy();
  });

  it.each([
    ["path", (f: Awaited<ReturnType<typeof realOwnedFixture>>, manifest: Record<string, unknown>) => { manifest.workspaceRoot = `${f.paths.workspace}-other`; }],
    ["common-dir", (_f: Awaited<ReturnType<typeof realOwnedFixture>>, manifest: Record<string, unknown>) => { manifest.workspaceCommonDir = "/wrong/common"; }],
    ["base", (_f: Awaited<ReturnType<typeof realOwnedFixture>>, manifest: Record<string, unknown>) => { manifest.baseRevision = "b".repeat(40); }],
    ["head", (f: Awaited<ReturnType<typeof realOwnedFixture>>) => { writeFileSync(path.join(f.paths.workspace, "advanced.txt"), "advance\n"); git(f.paths.workspace, "add", "advanced.txt"); git(f.paths.workspace, "commit", "-m", "advance"); }],
    ["primary-identity", (f: Awaited<ReturnType<typeof realOwnedFixture>>, manifest: Record<string, unknown>) => { manifest.workspaceRoot = f.root; }],
    ["registration", (f: Awaited<ReturnType<typeof realOwnedFixture>>) => { git(f.root, "worktree", "remove", f.paths.workspace); mkdirSync(f.paths.workspace); }],
  ] as const)("rejects real continuation %s identity drift without requiring cleanliness", async (_name, mutate) => {
    const f = await realOwnedFixture();
    const manifest = JSON.parse(readFileSync(f.paths.deliveryOwnershipManifest, "utf8"));
    mutate(f, manifest);
    if (_name !== "registration" && _name !== "head") {
      writeFileSync(f.paths.deliveryOwnershipManifest, JSON.stringify(manifest));
    }

    await expect(run(inspectContinuableDeliveryWorktreeOwnership({
      expectedHeads: [f.head],
      options: { rootDirectory: f.root },
      paths: f.paths,
      provenance: f.provenance,
    }))).rejects.toBeTruthy();
  });

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
    const provider: WorkerRecoveryProvider = { listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]), resumeThread: (threadId) => Effect.succeed({ status: "idle", threadId }), readThread: (threadId) => Effect.succeed({ status: "systemError", threadId }), startTurn: () => Effect.sync(() => { starts++; return { turnId: "turn-recovery" }; }) };
    expect(rootA).not.toBe(f.root);
    const activate = (runId: string, request: typeof action) => recoverWorkerSession(runId, request, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace: f.validateWorkspace });
    const confirmed = await run(actOnWorkerRecovery(f.runId, action, { rootDirectory: f.root, workerRecoveryActivator: activate }));
    expect(confirmed.state).toBe("dispatchConfirmed");
    if (confirmed.state !== "dispatchConfirmed") throw new Error("expected confirmed recovery");
    const restarted = await run(actOnWorkerRecovery(f.runId, action, { rootDirectory: f.root, workerRecoveryActivator: activate }));
    expect(restarted).toMatchObject({ nativeTurnIdDigest: confirmed.nativeTurnIdDigest, state: "dispatchConfirmed" }); expect(starts).toBe(1);
    expect(git(f.paths.workspace, "rev-parse", "HEAD")).toBe(beforeHead); expect(git(f.paths.workspace, "status", "--porcelain")).toBe(beforeStatus); expect(git(f.paths.workspace, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(beforeCommon); expect(git(f.root, "worktree", "list", "--porcelain")).toBe(beforeInventory);
  });
  it("accepts exact same-thread safe non-active resume and read statuses before dispatch", async () => {
    const f = fixture(); const calls: string[] = [];
    const provider: WorkerRecoveryProvider = { listModels: () => Effect.sync(() => { calls.push("models"); return [{ hidden: false, id: "gpt-5.4" }]; }), resumeThread: (threadId) => Effect.sync(() => { calls.push("resume:idle"); return { status: "idle", threadId }; }), readThread: (threadId) => Effect.sync(() => { calls.push("read:notLoaded"); return { status: "notLoaded", threadId }; }), startTurn: ({ model }) => Effect.sync(() => { calls.push(`start:${model}`); return { turnId: "turn-recovery" }; }) };
    const validateWorkspace = () => Effect.void;
    const result = await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace }));
    expect(result.state).toBe("dispatchConfirmed"); expect(calls).toEqual(["models", "resume:idle", "read:notLoaded", "start:gpt-5.4"]);
  });

  it("preflights the same thread and dispatches exactly one explicit-model turn", async () => {
    const f = fixture(); const calls: string[] = [];
    const provider: WorkerRecoveryProvider = { listModels: () => Effect.sync(() => { calls.push("models"); return [{ hidden: false, id: "gpt-5.4" }]; }), resumeThread: (threadId) => Effect.sync(() => { calls.push("resume"); return { status: "idle", threadId }; }), readThread: (threadId) => Effect.sync(() => { calls.push("read"); return { status: "systemError", threadId }; }), startTurn: ({ model }) => Effect.sync(() => { calls.push(`start:${model}`); return { turnId: "turn-recovery" }; }) };
    const validateWorkspace = () => Effect.void;
    const result = await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace }));
    expect(result.state).toBe("dispatchConfirmed"); expect(calls).toEqual(["models", "resume", "read", "start:gpt-5.4"]);
    expect(readFileSync(f.paths.events, "utf8")).not.toContain("thread-1");
    await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace }));
    expect(calls).toEqual(["models", "resume", "read", "start:gpt-5.4"]);
  });

  it("makes an ambiguous dispatch terminal and never redispatches", async () => {
    const f = fixture(); let starts = 0;
    const provider: WorkerRecoveryProvider = { listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]), resumeThread: (threadId) => Effect.succeed({ status: "idle", threadId }), readThread: (threadId) => Effect.succeed({ status: "systemError", threadId }), startTurn: () => Effect.sync(() => { starts++; throw new Error("lost response"); }) };
    const validateWorkspace = () => Effect.void;
    const first = await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace })); expect(first.state).toBe("outcomeUnknown");
    const second = await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace })); expect(second.state).toBe("outcomeUnknown"); expect(starts).toBe(1);
  });

  it.each([
    ["missing sessionFailed", (events: Array<Record<string, unknown>>): void => { events[8] = { ...events[6]!, sequence: 9, timestamp: "2026-07-11T00:00:09.000Z" }; }, action],
    ["wrong session", (events: Array<Record<string, unknown>>): void => { (((events[8]!["payload"] as Record<string, unknown>)["event"] as Record<string, unknown>)["sessionId"] = "session-run-other"); }, action],
    ["wrong harness profile", (events: Array<Record<string, unknown>>): void => { ((((events[0]!["payload"] as Record<string, unknown>)["execution"] as Record<string, unknown>)["selection"] as Record<string, unknown>)["harnessProfileId"] = "otherProfile"); }, action],
    ["nonrecoverable provider failure", (events: Array<Record<string, unknown>>): void => { (((((events[8]!["payload"] as Record<string, unknown>)["event"] as Record<string, unknown>)["failure"] as Record<string, unknown>)["recoverable"] = false)); }, action],
    ["nonrecoverable run failure", (events: Array<Record<string, unknown>>): void => { ((events[9]!["payload"] as Record<string, unknown>)["recoverable"] = false); }, action],
    ["wrong failure stage", (events: Array<Record<string, unknown>>): void => { ((events[9]!["payload"] as Record<string, unknown>)["stage"] = "reviewing"); }, action],
    ["wrong expected sequence", (_events: Array<Record<string, unknown>>): void => undefined, WorkerRecoveryAction.make({ ...action, expectedFailureSequence: 9 })],
    ["failure not final", (events: Array<Record<string, unknown>>): void => { events.push({ ...events[3]!, sequence: 11, timestamp: "2026-07-11T00:00:11.000Z" }); }, action],
  ] as const)("requires historical Gaia eligibility despite safe live status: %s", async (_name, mutate, request) => {
    const f = fixture();
    rewriteStoredEvents(f.paths.events, mutate);
    const before = readFileSync(f.paths.events, "utf8");
    const calls: string[] = [];
    const provider: WorkerRecoveryProvider = {
      listModels: () => Effect.sync(() => { calls.push("models"); return [{ hidden: false, id: "gpt-5.4" }]; }),
      resumeThread: (threadId) => Effect.sync(() => { calls.push("resume"); return threadState("idle", threadId); }),
      readThread: (threadId) => Effect.sync(() => { calls.push("read"); return threadState("notLoaded", threadId); }),
      startTurn: () => Effect.sync(() => { calls.push("start"); return { turnId: "turn-recovery" }; }),
    };
    const exit = await run(recoverWorkerSession(f.runId, request, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace: () => Effect.void }).pipe(Effect.exit));
    expect(exit._tag).toBe("Failure");
    expect(readFileSync(f.paths.events, "utf8")).toBe(before);
    expect(calls).toEqual([]);
  });

  it.each([
    ["wrong resume id", { resume: threadState("idle", "thread-other") }],
    ["wrong read id", { read: threadState("idle", "thread-other") }],
    ["active resume", { resume: threadState("active") }],
    ["active read", { read: threadState("active") }],
    ["unknown resume", { resume: threadState("unknown") }],
    ["unknown read", { read: threadState("unknown") }],
    ["resume error", { resumeError: true }],
    ["read error", { readError: true }],
    ["workspace race", { workspaceRace: true }],
  ] as const)("records preflight failure for %s with zero dispatch", async (_name, scenario) => {
    const f = fixture();
    let starts = 0;
    let validations = 0;
    const provider: WorkerRecoveryProvider = {
      listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]),
      resumeThread: (threadId): ReturnType<WorkerRecoveryProvider["resumeThread"]> => "resumeError" in scenario && scenario.resumeError === true ? Effect.fail(new Error("resume failed")) : Effect.succeed("resume" in scenario ? scenario.resume : threadState("idle", threadId)),
      readThread: (threadId): ReturnType<WorkerRecoveryProvider["readThread"]> => "readError" in scenario && scenario.readError === true ? Effect.fail(new Error("read failed")) : Effect.succeed("read" in scenario ? scenario.read : threadState("idle", threadId)),
      startTurn: () => Effect.sync(() => { starts++; return { turnId: "turn-recovery" }; }),
    };
    const validateWorkspace = () => {
      validations++;
      return "workspaceRace" in scenario && scenario.workspaceRace === true && validations === 2 ? Effect.fail(new Error("workspace race")) : Effect.void;
    };
    const result = await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace }));
    expect(result.state).toBe("failed");
    if (result.state !== "failed") throw new Error("expected failed recovery");
    expect(result.code).toBe("WorkerRecoveryPreflightFailed");
    expect(starts).toBe(0);
    const events = readFileSync(f.paths.events, "utf8");
    expect(events).toContain("WorkerRecoveryPreflightFailed");
    expect(events).not.toContain("dispatchAttempted");
    expect(events).not.toContain("dispatchConfirmed");
    expect(existsSync(path.join(f.paths.root, ".worker-recovery-turn.json"))).toBe(false);
  });

  it("returns a prior terminal failed recovery without another provider dispatch", async () => {
    const f = fixture();
    const failingProvider: WorkerRecoveryProvider = {
      listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]),
      resumeThread: (threadId) => Effect.succeed(threadState("active", threadId)),
      readThread: (threadId) => Effect.succeed(threadState("idle", threadId)),
      startTurn: () => Effect.die("not called"),
    };
    const first = await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider: failingProvider, rootDirectory: f.root, validateWorkspace: () => Effect.void }));
    expect(first.state).toBe("failed");
    const calls: string[] = [];
    const provider: WorkerRecoveryProvider = {
      listModels: () => Effect.sync(() => { calls.push("models"); return [{ hidden: false, id: "gpt-5.4" }]; }),
      resumeThread: (threadId) => Effect.sync(() => { calls.push("resume"); return threadState("idle", threadId); }),
      readThread: (threadId) => Effect.sync(() => { calls.push("read"); return threadState("idle", threadId); }),
      startTurn: () => Effect.sync(() => { calls.push("start"); return { turnId: "turn-recovery" }; }),
    };
    const second = await run(recoverWorkerSession(f.runId, action, { nativeThreadId: "thread-1", provider, rootDirectory: f.root, validateWorkspace: () => Effect.void }));
    expect(second).toMatchObject({ code: "WorkerRecoveryPreflightFailed", state: "failed" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["WorkerRecoveryModelCatalogUnavailable", () => Effect.fail(new Error("private catalog cause"))],
    ["WorkerRecoveryModelUnavailable", () => Effect.succeed([{ hidden: false, id: "other-model" }])],
  ] as const)("fails before intent with %s and zero provider mutation", async (code, listModels) => {
    const f = fixture();
    const before = readFileSync(f.paths.events, "utf8");
    let mutations = 0;
    const provider: WorkerRecoveryProvider = {
      listModels,
      readThread: () => Effect.sync(() => { mutations++; return { status: "systemError", threadId: "thread-1" }; }),
      resumeThread: () => Effect.sync(() => { mutations++; return { status: "idle", threadId: "thread-1" }; }),
      startTurn: () => Effect.sync(() => { mutations++; return { turnId: "turn-recovery" }; }),
    };
    const exit = await run(recoverWorkerSession(f.runId, action, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.void,
    }).pipe(Effect.exit));
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain(code);
    expect(JSON.stringify(exit)).not.toContain("private catalog cause");
    expect(readFileSync(f.paths.events, "utf8")).toBe(before);
    expect(mutations).toBe(0);
    expect(existsSync(path.join(f.paths.root, ".worker-recovery-turn.json"))).toBe(false);
  });

  it("reports initial intent persistence failure without a partial event or provider mutation", async () => {
    const f = fixture();
    const before = readFileSync(f.paths.events, "utf8");
    let mutations = 0;
    const provider: WorkerRecoveryProvider = {
      listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]),
      readThread: () => Effect.sync(() => { mutations++; return { status: "systemError", threadId: "thread-1" }; }),
      resumeThread: () => Effect.sync(() => { mutations++; return { status: "idle", threadId: "thread-1" }; }),
      startTurn: () => Effect.sync(() => { mutations++; return { turnId: "turn-recovery" }; }),
    };
    const exit = await run(recoverWorkerSession(f.runId, action, {
      appendRecoveryEvent: () => Effect.fail(makeRuntimeError({ cause: new Error("private persistence path"), code: "WriteFailed", message: "write failed" })),
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.void,
    }).pipe(Effect.exit));
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("WorkerRecoveryIntentPersistenceFailed");
    expect(JSON.stringify(exit)).not.toContain("private persistence path");
    expect(readFileSync(f.paths.events, "utf8")).toBe(before);
    expect(mutations).toBe(0);
  });

  it("rejects retained tracked payload drift between resume/read and dispatch", async () => {
    const f = fixture();
    let starts = 0;
    let currentDigest = "1".repeat(64);
    const validation = () => Effect.succeed({
      trackedPayloadDigest: currentDigest,
      trackedPayloadEntryCount: 1,
    });
    const provider: WorkerRecoveryProvider = {
      listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]),
      resumeThread: (threadId) => Effect.sync(() => {
        currentDigest = "2".repeat(64);
        return threadState("idle", threadId);
      }),
      readThread: (threadId) => Effect.succeed(threadState("systemError", threadId)),
      startTurn: () => Effect.sync(() => {
        starts++;
        return { turnId: "turn-recovery" };
      }),
    };

    const result = await run(recoverWorkerSession(f.runId, action, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: validation,
    }));

    expect(result).toMatchObject({
      code: "WorkerRecoveryPreflightFailed",
      state: "failed",
      trackedPayloadDigest: "1".repeat(64),
      trackedPayloadEntryCount: 1,
    });
    expect(starts).toBe(0);
    const events = readFileSync(f.paths.events, "utf8");
    expect(events).toContain("WorkerRecoveryPreflightFailed");
    expect(events).toContain(`"trackedPayloadDigest":"${"1".repeat(64)}"`);
    expect(events).not.toContain("dispatchAttempted");
    expect(events).not.toContain("dispatchConfirmed");
  });

  it("revalidates persisted tracked payload binding on intent restart before resume/read/start", async () => {
    const f = fixture();
    await run(appendEvent(f.runId, f.paths, {
      payload: {
        recovery: {
          ...action,
          attempt: 1,
          maxAttempts: 1,
          payloadDigest: sha256(JSON.stringify(action)),
          state: "intentRecorded",
          trackedPayloadDigest: "1".repeat(64),
          trackedPayloadEntryCount: 1,
        },
      },
      type: "WORKER_RECOVERY_RECORDED",
    }));
    let models = 0;
    let resumeReads = 0;
    let starts = 0;
    const provider: WorkerRecoveryProvider = {
      listModels: () => Effect.sync(() => {
        models++;
        return [{ hidden: false, id: "gpt-5.4" }];
      }),
      resumeThread: (threadId) => Effect.sync(() => {
        resumeReads++;
        return threadState("idle", threadId);
      }),
      readThread: (threadId) => Effect.sync(() => {
        resumeReads++;
        return threadState("systemError", threadId);
      }),
      startTurn: () => Effect.sync(() => {
        starts++;
        return { turnId: "turn-recovery" };
      }),
    };

    const result = await run(recoverWorkerSession(f.runId, action, {
      nativeThreadId: "thread-1",
      provider,
      rootDirectory: f.root,
      validateWorkspace: () => Effect.succeed({
        trackedPayloadDigest: "2".repeat(64),
        trackedPayloadEntryCount: 1,
      }),
    }));

    expect(result).toMatchObject({
      code: "WorkerRecoveryPreflightFailed",
      state: "failed",
      trackedPayloadDigest: "1".repeat(64),
      trackedPayloadEntryCount: 1,
    });
    expect(models).toBe(1);
    expect(resumeReads).toBe(0);
    expect(starts).toBe(0);
    const events = readFileSync(f.paths.events, "utf8");
    expect(events).toContain("WorkerRecoveryPreflightFailed");
    expect(events).not.toContain("dispatchAttempted");
    expect(events).not.toContain("dispatchConfirmed");
  });
});
