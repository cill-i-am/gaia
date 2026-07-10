import { NodeServices } from "@effect/platform-node";
import {
  codexAppServerExecutionSelection,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  parseHarnessProviderId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  projectHarnessEvents,
  type HarnessEvent,
} from "@gaia/core";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Option, Stream } from "effect";
import { appendEvent, appendHarnessSessionEvent } from "./event-store.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import {
  HarnessResumeError,
  type HarnessProvider,
  type HarnessSession,
} from "./harness-session.js";
import {
  codexAppServerHarnessName,
  HarnessRunRequest,
} from "./harness.js";
import { interactiveSessionHarness } from "./interactive-harness.js";
import {
  readFactoryGraph,
  readFactoryRunActivity,
} from "./factory-run-read-api.js";
import { makeRunPaths } from "./paths.js";
import { readLocalRunEvents } from "./run-read-api.js";
import { acceptFactoryRun, continueServerRun } from "./server-workflows.js";
import { snapshotWorkspace, writeWorkspaceSnapshot } from "./workspace-snapshot.js";

const syntheticCapabilities = HarnessCapabilities.make({
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

describe("interactive issue-delivery harness", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("executes the actual workflow through a synthetic provider without waiting for stream close", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-interactive-" });
        const counters = { detect: 0, resume: 0, start: 0 };
        const provider = syntheticProvider(counters);
        const registry = makeHarnessProviderRegistry([
          {
            profileId: codexAppServerExecutionSelection.harnessProfileId,
            provider,
          },
        ]);
        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Complete through a synthetic interactive provider.",
              kind: "issue",
              title: "Synthetic provider workflow proof",
            },
          },
          { harnessProviderRegistry: registry, rootDirectory: cwd },
        );

        const summary = yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: registry,
          rootDirectory: cwd,
        });
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const types = events.events.map(({ type }) => type);

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(counters.start, 1);
        assert.strictEqual(counters.resume, 0);
        assert.isAtLeast(counters.detect, 3);
        assert.strictEqual(
          types.filter((type) => type === "WORKER_COMPLETED").length,
          1,
        );
        assert.strictEqual(
          types.filter((type) => type === "HARNESS_SESSION_EVENT_RECORDED")
            .length,
          4,
        );
        assert.strictEqual(types.at(-1), "REPORT_COMPLETED");
        assert.isBelow(
          types.indexOf("HARNESS_SESSION_EVENT_RECORDED"),
          types.indexOf("WORKER_COMPLETED"),
        );
      }),
    );

    it.effect("owns a persisted terminal turn without starting or resuming the provider after a crash window", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-terminal-resume-" });
        const counters = { detect: 0, resume: 0, start: 0 };
        let providerAvailable = true;
        const provider = syntheticProvider(counters, () => providerAvailable);
        const registry = makeHarnessProviderRegistry([
          {
            profileId: codexAppServerExecutionSelection.harnessProfileId,
            provider,
          },
        ]);
        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Recover after terminal turn persistence.",
              kind: "issue",
              title: "Terminal crash window",
            },
          },
          { harnessProviderRegistry: registry, rootDirectory: cwd },
        );
        const paths = yield* makeRunPaths(accepted.runId, { rootDirectory: cwd });
        yield* fs.makeDirectory(paths.workspace, { recursive: true });
        yield* writeWorkspaceSnapshot(
          paths.harnessWorkspaceBaseline,
          yield* snapshotWorkspace(paths.workspace),
        );
        const sessionId = parseHarnessSessionId(`session-${accepted.runId}`);
        const turnId = parseHarnessTurnId("turn-before-server-crash");
        for (const event of [
          {
            capabilities: syntheticCapabilities,
            kind: "sessionStarted",
            provider: provider.descriptor,
            sessionId,
            state: "running",
          },
          { kind: "turnStarted", sessionId, turnId },
          {
            kind: "turnCompleted",
            sessionId,
            status: "completed",
            turnId,
          },
        ] satisfies ReadonlyArray<HarnessEvent>) {
          yield* appendHarnessSessionEvent(accepted.runId, paths, event);
        }
        const detectionsAfterTerminal = counters.detect;
        providerAvailable = false;

        const summary = yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: registry,
          rootDirectory: cwd,
        });
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(counters.detect, detectionsAfterTerminal);
        assert.strictEqual(counters.start, 0);
        assert.strictEqual(counters.resume, 0);
        assert.strictEqual(
          events.events.filter(({ type }) => type === "WORKER_COMPLETED").length,
          1,
        );
        const terminalIndex = events.events.findIndex(
          (event) =>
            event.type === "HARNESS_SESSION_EVENT_RECORDED" &&
            event.payload.event !== null &&
            typeof event.payload.event === "object" &&
            !Array.isArray(event.payload.event) &&
            Object.getOwnPropertyDescriptor(event.payload.event, "kind")?.value ===
              "turnCompleted",
        );
        assert.strictEqual(
          events.events[terminalIndex + 1]?.type,
          "WORKER_COMPLETED",
        );
      }),
    );

    it.effect("fails a nonterminal resume once when private correlation is unavailable", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-correlation-resume-" });
        const counters = { detect: 0, resume: 0, start: 0 };
        const baseProvider = syntheticProvider(counters);
        const provider: HarnessProvider = {
          ...baseProvider,
          resumeSession: () => {
            counters.resume += 1;
            return Effect.fail(
              new HarnessResumeError({
                message: "Private correlation is unavailable.",
                providerId: baseProvider.descriptor.providerId,
              }),
            );
          },
        };
        const registry = makeHarnessProviderRegistry([
          {
            profileId: codexAppServerExecutionSelection.harnessProfileId,
            provider,
          },
        ]);
        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Fail closed when private correlation is missing.",
              kind: "issue",
              title: "Missing private correlation",
            },
          },
          { harnessProviderRegistry: registry, rootDirectory: cwd },
        );
        const paths = yield* makeRunPaths(accepted.runId, { rootDirectory: cwd });
        yield* fs.makeDirectory(paths.workspace, { recursive: true });
        yield* writeWorkspaceSnapshot(
          paths.harnessWorkspaceBaseline,
          yield* snapshotWorkspace(paths.workspace),
        );
        const sessionId = parseHarnessSessionId(`session-${accepted.runId}`);
        yield* appendHarnessSessionEvent(accepted.runId, paths, {
          capabilities: syntheticCapabilities,
          kind: "sessionStarted",
          provider: provider.descriptor,
          sessionId,
          state: "running",
        });

        const continuation = yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: registry,
          rootDirectory: cwd,
        }).pipe(Effect.exit);
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const failures = events.events.filter(({ type }) => type === "RUN_FAILED");

        assert.strictEqual(continuation._tag, "Failure");
        assert.strictEqual(counters.start, 0);
        assert.strictEqual(counters.resume, 1);
        assert.strictEqual(failures.length, 1);
        assert.strictEqual(failures[0]?.payload["code"], "HarnessCorrelationUnavailable");
        assert.notInclude(
          events.events.map(({ type }) => type),
          "WORKER_COMPLETED",
        );
      }),
    );

    it.effect("resumes a persisted nonterminal session through the generic provider SPI", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-session-resume-" });
        const counters = { detect: 0, resume: 0, start: 0 };
        const provider = syntheticProvider(counters);
        const registry = makeHarnessProviderRegistry([
          {
            profileId: codexAppServerExecutionSelection.harnessProfileId,
            provider,
          },
        ]);
        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Resume a nonterminal session.",
              kind: "issue",
              title: "Generic resume proof",
            },
          },
          { harnessProviderRegistry: registry, rootDirectory: cwd },
        );
        const paths = yield* makeRunPaths(accepted.runId, { rootDirectory: cwd });
        yield* fs.makeDirectory(paths.workspace, { recursive: true });
        yield* writeWorkspaceSnapshot(
          paths.harnessWorkspaceBaseline,
          yield* snapshotWorkspace(paths.workspace),
        );
        const sessionId = parseHarnessSessionId(`session-${accepted.runId}`);
        const turnId = parseHarnessTurnId("turn-synthetic-worker");
        for (const event of [
          {
            capabilities: syntheticCapabilities,
            kind: "sessionStarted",
            provider: provider.descriptor,
            sessionId,
            state: "running",
          },
          { kind: "turnStarted", sessionId, turnId },
        ] satisfies ReadonlyArray<HarnessEvent>) {
          yield* appendHarnessSessionEvent(accepted.runId, paths, event);
        }

        const graphBeforeResume = yield* readFactoryGraph(accepted.runId, {
          rootDirectory: cwd,
        });
        const activityBeforeResume = yield* readFactoryRunActivity(
          accepted.runId,
          { rootDirectory: cwd },
        );
        assert.deepInclude(
          graphBeforeResume.agents.map(({ role, state }) => ({ role, state })),
          { role: "worker", state: "running" },
        );
        assert.strictEqual(
          activityBeforeResume.activities.at(-1)?.agentId,
          "agent-worker",
        );
        assert.strictEqual(
          activityBeforeResume.activities.at(-1)?.subState,
          "turnStarted",
        );

        const summary = yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: registry,
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(counters.start, 0);
        assert.strictEqual(counters.resume, 1);
      }),
    );

    it.effect("continues downstream from persisted worker completion without resolving the provider twice", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-worker-complete-resume-" });
        const counters = { detect: 0, resume: 0, start: 0 };
        let providerAvailable = true;
        const provider = syntheticProvider(counters, () => providerAvailable);
        const registry = makeHarnessProviderRegistry([
          {
            profileId: codexAppServerExecutionSelection.harnessProfileId,
            provider,
          },
        ]);
        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Continue downstream after worker completion persistence.",
              kind: "issue",
              title: "Completed worker crash window",
            },
          },
          { harnessProviderRegistry: registry, rootDirectory: cwd },
        );
        const paths = yield* makeRunPaths(accepted.runId, { rootDirectory: cwd });
        yield* fs.makeDirectory(paths.workspace, { recursive: true });
        yield* writeWorkspaceSnapshot(
          paths.harnessWorkspaceBaseline,
          yield* snapshotWorkspace(paths.workspace),
        );
        const sessionId = parseHarnessSessionId(`session-${accepted.runId}`);
        const turnId = parseHarnessTurnId("turn-completed-before-crash");
        for (const event of [
          {
            capabilities: syntheticCapabilities,
            kind: "sessionStarted",
            provider: provider.descriptor,
            sessionId,
            state: "running",
          },
          { kind: "turnStarted", sessionId, turnId },
          {
            kind: "turnCompleted",
            sessionId,
            status: "completed",
            turnId,
          },
        ] satisfies ReadonlyArray<HarnessEvent>) {
          yield* appendHarnessSessionEvent(accepted.runId, paths, event);
        }
        const result = yield* interactiveSessionHarness({
          provider,
          rootDirectory: cwd,
        }).run(
          HarnessRunRequest.make({
            codexHarnessProgressPath: paths.codexHarnessProgress,
            harnessName: codexAppServerHarnessName,
            resolvedSkillPaths: [],
            runId: accepted.runId,
            skillBundlePath: paths.skillBundle,
            specBody: "Continue downstream.",
            specTitle: "Completed worker crash window",
            workerLogPath: paths.workerLog,
            workerResultPath: paths.workerResult,
            workspaceOutputPath: paths.workspaceOutput,
            workspacePath: paths.workspace,
          }),
        );
        yield* appendEvent(accepted.runId, paths, {
          payload: {
            changedWorkspacePaths: result.changedWorkspacePaths,
            harnessName: result.harnessName,
            outputArtifacts: result.outputArtifacts,
            workerResultPath: result.resultPath,
          },
          type: "WORKER_COMPLETED",
        });
        const detectionsAfterWorker = counters.detect;
        providerAvailable = false;

        const summary = yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: registry,
          rootDirectory: cwd,
        });
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(counters.detect, detectionsAfterWorker);
        assert.strictEqual(counters.start, 0);
        assert.strictEqual(counters.resume, 0);
        assert.strictEqual(
          events.events.filter(({ type }) => type === "WORKER_COMPLETED").length,
          1,
        );
      }),
    );
  });
});

function syntheticProvider(counters: {
  detect: number;
  resume: number;
  start: number;
}, isAvailable: () => boolean = () => true): HarnessProvider {
  const descriptor = HarnessProviderDescriptor.make({
    displayName: "Synthetic Interactive Provider",
    executionModes: ["local"],
    providerId: parseHarnessProviderId("synthetic-interactive"),
  });
  return {
    createSession: (request) =>
      Effect.sync(() => {
        counters.start += 1;
        return syntheticSession(request.sessionId, descriptor);
      }),
    descriptor,
    detect: Effect.sync(() => {
      counters.detect += 1;
      return isAvailable()
        ? {
            auth: { state: "notRequired" },
            capabilities: syntheticCapabilities,
            state: "available",
            version: "synthetic-1",
          } as const
        : { state: "missing" } as const;
    }),
    resumeSession: (request) =>
      Effect.sync(() => {
        counters.resume += 1;
        return syntheticSession(request.sessionId, descriptor);
      }),
  };
}

function syntheticSession(
  sessionId: ReturnType<typeof parseHarnessSessionId>,
  provider: HarnessProviderDescriptor,
): HarnessSession {
  const turnId = parseHarnessTurnId("turn-synthetic-worker");
  const events: ReadonlyArray<HarnessEvent> = [
    {
      capabilities: syntheticCapabilities,
      kind: "sessionStarted",
      provider,
      sessionId,
      state: "connecting",
    },
    { kind: "turnStarted", sessionId, turnId },
    { kind: "sessionStateChanged", sessionId, state: "running" },
    { kind: "turnCompleted", sessionId, status: "completed", turnId },
  ];
  const postTerminalEvent: HarnessEvent = {
    kind: "sessionStateChanged",
    sessionId,
    state: "running",
  };
  return {
    events: Stream.concat(
      Stream.fromIterable([...events, postTerminalEvent]),
      Stream.never,
    ),
    interrupt: Option.some(Effect.void),
    resolveInteraction: () => Effect.void,
    send: () => Effect.void,
    snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
    steer: Option.none(),
  };
}
