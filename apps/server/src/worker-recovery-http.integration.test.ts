import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  parseHarnessEvent,
  parseHarnessProfileId,
  parseHarnessSessionId,
  encodeWorkerRecoveryReceiptJson,
  parseWorkerRecoveryReceipt,
  WorkerRecoveryAction,
  type WorkerRecoveryReceipt,
} from "@gaia/core";
import {
  appendEvent,
  appendHarnessSessionEvent,
  HarnessResumeError,
  HarnessSessionError,
  inspectRecoverableDeliveryWorktreeOwnership,
  loadRun,
  parseDeliveryProvenance,
  recoverWorkerSession,
} from "@gaia/runtime";
import { makeHarnessProviderRegistry } from "../../../packages/runtime/src/harness-provider-registry.js";
import { prepareDeliveryWorktree } from "../../../packages/runtime/src/git-delivery.js";
import {
  testHarnessProvider,
  makeTestHarnessProviderRegistry,
} from "@gaia/runtime/test-support";
import { acceptFactoryRun } from "@gaia/runtime/server-workflows";
import { makeRunPaths } from "@gaia/runtime/paths";
import {
  snapshotWorkspace,
  writeWorkspaceSnapshot,
} from "../../../packages/runtime/src/workspace-snapshot.js";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeLocalGaiaServerLayer } from "./api.js";
import { validateProductionWorkerRecoveryWorkspace } from "./main.js";

type FailureMode =
  | "missing checkpoint"
  | "corrupt checkpoint"
  | "exact-turn mismatch"
  | "provider resume rejection"
  | "provider read rejection"
  | "generic continuation failure";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function inventory(root: string) {
  return {
    common: git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    head: git(root, "rev-parse", "HEAD"),
    inventory: git(root, "worktree", "list", "--porcelain"),
    status: git(root, "status", "--porcelain"),
  };
}

function failureRegistry(mode: FailureMode) {
  if (mode === "generic continuation failure") return undefined;
  if (mode === "provider resume rejection") {
    return makeHarnessProviderRegistry([{
      profileId: parseHarnessProfileId("codexAppServer"),
      provider: {
        ...testHarnessProvider,
        resumeSession: () => Effect.fail(new HarnessResumeError({
          message: "synthetic provider resume rejection",
          providerId: testHarnessProvider.descriptor.providerId,
        })),
      },
    }]);
  }
  if (mode === "provider read rejection") {
    return makeHarnessProviderRegistry([{
      profileId: parseHarnessProfileId("codexAppServer"),
      provider: {
        ...testHarnessProvider,
        resumeSession: (request) => Effect.map(
          testHarnessProvider.resumeSession(request),
          (session) => ({
            ...session,
            events: Stream.fail(new HarnessSessionError({
              message: "synthetic provider read rejection",
              providerId: testHarnessProvider.descriptor.providerId,
            })),
          }),
        ),
      },
    }]);
  }
  return makeTestHarnessProviderRegistry();
}

function makeFixture(mode?: FailureMode, options: {
  readonly retainedDirty?: boolean;
  readonly productionWorkspaceValidation?: boolean;
} = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rootB = yield* fs.makeTempDirectory({ prefix: "gaia-http-b-" });
    const remote = yield* fs.makeTempDirectory({ prefix: "gaia-http-remote-" });
    git(rootB, "init", "-b", "main");
    git(rootB, "config", "user.email", "gaia@test.invalid");
    git(rootB, "config", "user.name", "Gaia Test");
    writeFileSync(`${rootB}/README.md`, "base\n");
    writeFileSync(`${rootB}/.gitignore`, [".gaia/", ".turbo/", "dist/", "**/.gaia/", "**/.turbo/", "**/dist/"].join("\n") + "\n");
    git(rootB, "add", "README.md", ".gitignore");
    git(rootB, "commit", "-m", "base");
    git(remote, "init", "--bare");
    git(rootB, "remote", "add", "origin", remote);
    git(rootB, "push", "-u", "origin", "main");

    const acceptanceRegistry = failureRegistry(mode ?? "missing checkpoint") ?? makeTestHarnessProviderRegistry();
    const accepted = yield* acceptFactoryRun({
      delivery: { mode: "pullRequest" },
      execution: codexAppServerExecutionSelection,
      workflow: "issueDelivery",
      workItem: { description: "retained", kind: "issue", title: "HTTP recovery" },
    }, { harnessProviderRegistry: acceptanceRegistry, rootDirectory: rootB });
    const paths = yield* makeRunPaths(accepted.runId, { rootDirectory: rootB });
    const initial = yield* loadRun(paths);
    const provenance = parseDeliveryProvenance(initial.events[0]?.payload["delivery"]);
    if (provenance._tag === "None") throw new Error("missing provenance");
    yield* prepareDeliveryWorktree({ options: { rootDirectory: rootB }, paths, provenance: provenance.value });
    yield* writeWorkspaceSnapshot(paths.harnessWorkspaceBaseline, yield* snapshotWorkspace(paths.workspace));
    const sessionId = `session-${accepted.runId}`;
    yield* appendEvent(accepted.runId, paths, { payload: { delivery: { ...provenance.value, mode: "pullRequest", stage: "delivering" } }, type: "DELIVERY_STARTED" });
    yield* appendEvent(accepted.runId, paths, { payload: { workspacePath: "workspace" }, type: "WORKSPACE_PREPARED" });
    yield* appendEvent(accepted.runId, paths, { payload: { phase: "plan" }, type: "REVIEW_STARTED" });
    yield* appendEvent(accepted.runId, paths, { payload: { phase: "plan", reviewPath: "plan.md", reviewerName: "reviewer", status: "approved" }, type: "REVIEW_COMPLETED" });
    yield* appendEvent(accepted.runId, paths, { type: "WORKER_STARTED" });
    yield* appendHarnessSessionEvent(accepted.runId, paths, parseHarnessEvent({ capabilities: { approvals: [], fileChangeEvents: true, interruption: true, resumableSessions: true, review: false, steering: false, streamingMessages: true, structuredOutput: false, subagents: false, toolEvents: false, usageReporting: false, userQuestions: false }, kind: "sessionStarted", provider: { displayName: "Test Interactive Harness", executionModes: ["local"], providerId: "test-interactive" }, sessionId, state: "running" }));
    yield* appendHarnessSessionEvent(accepted.runId, paths, parseHarnessEvent({ kind: "turnStarted", sessionId, turnId: "turn-initial" }));
    yield* appendHarnessSessionEvent(accepted.runId, paths, parseHarnessEvent({ failure: { code: "CodexThreadSystemError", kind: "providerFailure", message: "failed", recoverable: true }, kind: "sessionFailed", sessionId }));
    yield* appendEvent(accepted.runId, paths, { payload: { code: "HarnessSessionFailed", message: "failed", recoverable: true, stage: "runningWorker" }, type: "RUN_FAILED" });
    const firstFailureSequence = (yield* loadRun(paths)).events.at(-1)!.sequence;
    let failureSequence = firstFailureSequence;
    if (options.retainedDirty === true) {
      const priorReceipt = {
        actionId: "recover-http-prior",
        attempt: 1 as const,
        expectedFailureSequence: firstFailureSequence,
        expectedSessionId: parseHarnessSessionId(sessionId),
        harnessProfileId: parseHarnessProfileId("codexAppServer"),
        maxAttempts: 1 as const,
        model: "gpt-5.4",
        nativeTurnIdDigest: "b".repeat(64),
        payloadDigest: "a".repeat(64),
      };
      yield* appendEvent(accepted.runId, paths, {
        payload: {
          recovery: encodeWorkerRecoveryReceiptJson({
            ...priorReceipt,
            state: "intentRecorded",
          }),
        },
        type: "WORKER_RECOVERY_RECORDED",
      });
      yield* appendEvent(accepted.runId, paths, {
        payload: {
          recovery: encodeWorkerRecoveryReceiptJson({
            ...priorReceipt,
            state: "dispatchConfirmed",
          }),
        },
        type: "WORKER_RECOVERY_RECORDED",
      });
      yield* appendHarnessSessionEvent(accepted.runId, paths, parseHarnessEvent({ failure: { code: "CodexThreadSystemError", kind: "providerFailure", message: "second failed", recoverable: true }, kind: "sessionFailed", sessionId }));
      const secondFailure = yield* appendEvent(accepted.runId, paths, { payload: { code: "HarnessSessionFailed", message: "second failed", recoverable: true, stage: "runningWorker" }, type: "RUN_FAILED" });
      failureSequence = secondFailure.event.sequence;
      yield* fs.writeFileString(`${paths.workspace}/README.md`, "retained payload change\n");
      yield* fs.makeDirectory(`${paths.workspace}/apps/server/.gaia`, { recursive: true });
      yield* fs.makeDirectory(`${paths.workspace}/packages/runtime/dist`, { recursive: true });
      yield* fs.makeDirectory(`${paths.workspace}/.turbo`, { recursive: true });
      yield* fs.writeFileString(`${paths.workspace}/apps/server/.gaia/events.jsonl`, "generated\n");
      yield* fs.writeFileString(`${paths.workspace}/packages/runtime/dist/index.js`, "generated\n");
      yield* fs.writeFileString(`${paths.workspace}/.turbo/cache.bin`, "generated\n");
    }
    const before = inventory(rootB);
    let starts = 0;
    let mutated = false;
    const action = WorkerRecoveryAction.make({ actionId: "recover-http-1", expectedFailureSequence: failureSequence, expectedSessionId: parseHarnessSessionId(sessionId), harnessProfileId: parseHarnessProfileId("codexAppServer"), kind: "retryRecoverableWorkerFailure", model: "gpt-5.4" });
    const activator = (runId: typeof accepted.runId, request: WorkerRecoveryAction) => Effect.gen(function* () {
      const receipt = yield* recoverWorkerSession(runId, request, { nativeThreadId: "thread-private", rootDirectory: rootB, provider: { listModels: () => Effect.succeed([{ hidden: false, id: "gpt-5.4" }]), readThread: (threadId) => Effect.succeed({ status: "systemError", threadId }), resumeThread: (threadId) => Effect.succeed({ status: "idle", threadId }), startTurn: () => Effect.sync(() => { starts += 1; return { turnId: "turn-recovery" }; }) }, validateWorkspace: () => options.productionWorkspaceValidation === true ? validateProductionWorkerRecoveryWorkspace({ action: request, expectedHead: provenance.value.baseRevision, rootDirectory: rootB, runId }) : inspectRecoverableDeliveryWorktreeOwnership({ expectedHeads: [provenance.value.baseRevision], options: { rootDirectory: rootB }, paths, provenance: provenance.value }) });
      if (mode !== undefined && receipt.state === "dispatchConfirmed" && !mutated) {
        mutated = true;
        const checkpoint = `${paths.root}/.worker-recovery-turn.json`;
        if (mode === "missing checkpoint") yield* fs.remove(checkpoint);
        if (mode === "corrupt checkpoint") yield* fs.writeFileString(checkpoint, "not-json");
        if (mode === "exact-turn mismatch") yield* fs.writeFileString(checkpoint, JSON.stringify({ turnId: "wrong-turn", version: 1 }));
      }
      return receipt;
    });
    const registry = mode === undefined ? makeTestHarnessProviderRegistry() : failureRegistry(mode);
    const workflowOptions = registry === undefined ? { workerRecoveryActivator: activator } : { harnessProviderRegistry: registry, workerRecoveryActivator: activator };
    const server = makeLocalGaiaServerLayer({ host: "127.0.0.1", pid: process.pid, rootDirectory: rootB, serverId: "srv_http_recovery", startedAt: new Date().toISOString() }, workflowOptions, []).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
    const post = () => HttpClientRequest.post(`/runs/${accepted.runId}/recovery/actions`).pipe(HttpClientRequest.bodyJsonUnsafe(action), HttpClient.execute, Effect.provide(server));
    const getProjection = () => HttpClient.get(`/runs/${accepted.runId}/delivery`).pipe(Effect.provide(server));
    const cleanup = fs.remove(rootB, { recursive: true }).pipe(Effect.andThen(fs.remove(remote, { recursive: true })));
    return { action, before, cleanup, getProjection, paths, post, rootB, starts: () => starts };
  });
}

describe("finite worker recovery HTTP lifecycle", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("continues retained Git root B to WORKER_COMPLETED and restarts without duplicate dispatch", () => Effect.gen(function* () {
      const fixture = yield* makeFixture();
      assert.strictEqual((yield* fixture.post()).status, 200);
      const after = yield* loadRun(fixture.paths);
      assert.isTrue(after.events.some(({ type }) => type === "WORKER_COMPLETED"));
      assert.strictEqual(fixture.starts(), 1);
      assert.strictEqual((yield* fixture.post()).status, 200);
      assert.strictEqual(fixture.starts(), 1);
      assert.deepEqual(inventory(fixture.rootB), fixture.before);
      yield* fixture.cleanup;
    }), 20_000);

    it.effect("allows later-generation retained dirty tracked payload through production recovery validation only", () => Effect.gen(function* () {
      const strict = yield* makeFixture(undefined, { retainedDirty: true });
      assert.strictEqual((yield* strict.post()).status, 409);
      assert.strictEqual(strict.starts(), 0);
      const strictEvents = yield* loadRun(strict.paths);
      assert.isFalse(strictEvents.events.some((event) => event.type === "WORKER_RECOVERY_RECORDED" && parseWorkerRecoveryReceipt(event.payload["recovery"]).actionId === strict.action.actionId));
      assert.deepEqual(inventory(strict.rootB), strict.before);
      yield* strict.cleanup;

      const production = yield* makeFixture(undefined, { productionWorkspaceValidation: true, retainedDirty: true });
      assert.strictEqual((yield* production.post()).status, 200);
      assert.strictEqual(production.starts(), 1);
      const events = yield* loadRun(production.paths);
      const receipts = events.events.flatMap((event) => event.type === "WORKER_RECOVERY_RECORDED" ? [parseWorkerRecoveryReceipt(event.payload["recovery"])] : []);
      const confirmed = receipts.find((receipt) => receipt.actionId === production.action.actionId && receipt.state === "dispatchConfirmed");
      assert.strictEqual(confirmed?.state, "dispatchConfirmed");
      assert.match(confirmed?.trackedPayloadDigest ?? "", /^[a-f0-9]{64}$/u);
      assert.strictEqual(confirmed?.trackedPayloadEntryCount, 1);
      assert.notInclude(JSON.stringify(confirmed), production.rootB);
      assert.isTrue(events.events.some((event) => event.type === "WORKER_COMPLETED"));
      const continuationFailure = receipts.find((receipt) => receipt.actionId === production.action.actionId && receipt.state === "failed" && receipt.code === "WorkerRecoveryContinuationFailed");
      assert.strictEqual(continuationFailure?.state, "failed");
      assert.deepEqual(inventory(production.rootB), production.before);
      yield* production.cleanup;
    }), 20_000);

    for (const mode of ["missing checkpoint", "corrupt checkpoint", "exact-turn mismatch", "provider resume rejection", "provider read rejection", "generic continuation failure"] as const) {
      it.effect(`fails closed after confirmed dispatch on ${mode}`, () => Effect.gen(function* () {
        const fixture = yield* makeFixture(mode);
        assert.strictEqual((yield* fixture.post()).status, 200);
        const first = yield* loadRun(fixture.paths);
        const receiptEvents = first.events.filter(({ type }) => type === "WORKER_RECOVERY_RECORDED");
        const receipt = parseWorkerRecoveryReceipt(receiptEvents.at(-1)?.payload["recovery"]);
        if (receipt.state !== "failed") throw new Error(`expected failed receipt, got ${receipt.state}`);
        assert.strictEqual(receipt.actionId, fixture.action.actionId);
        assert.match(receipt.nativeTurnIdDigest ?? "", /^[a-f0-9]{64}$/u);
        assert.notInclude(JSON.stringify(receipt), fixture.rootB);
        const confirmedSequence = receiptEvents.find(({ payload }) => parseWorkerRecoveryReceipt(payload["recovery"]).state === "dispatchConfirmed")!.sequence;
        assert.lengthOf(first.events.filter(({ sequence, type }) => sequence > confirmedSequence && type === "HARNESS_SESSION_EVENT_RECORDED"), 0);
        assert.isFalse(first.events.some(({ type }) => type === "WORKER_COMPLETED"));
        const projection = yield* fixture.getProjection();
        assert.strictEqual(projection.status, 200);
        const projected = JSON.parse(yield* projection.text) as {
          readonly data: {
            readonly stage: string;
            readonly status: string;
            readonly workerRecovery: { readonly state: string };
          };
        };
        const expectedStage = mode === "corrupt checkpoint" ? "workerRecoveryFailed" : "failed";
        assert.strictEqual(projected.data.stage, expectedStage);
        assert.strictEqual(projected.data.status, expectedStage);
        assert.strictEqual(projected.data.workerRecovery.state, "failed");
        const eventCount = first.events.length;
        assert.strictEqual((yield* fixture.post()).status, 200);
        const repeated = yield* loadRun(fixture.paths);
        assert.strictEqual(repeated.events.length, eventCount);
        assert.strictEqual(fixture.starts(), 1);
        assert.isFalse(repeated.events.some(({ type }) => type === "WORKER_COMPLETED"));
        assert.deepEqual(inventory(fixture.rootB), fixture.before);
        yield* fixture.cleanup;
      }), 20_000);
    }
  });
});
