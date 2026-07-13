import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  parseHarnessEvent,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessProviderId,
  parseRunId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseWorkspaceRelativePath,
  projectHarnessEvents,
  type HarnessEvent,
} from "@gaia/core";
import { Deferred, Effect, Fiber, FileSystem, Option, Stream } from "effect";

import type { CodexAppServerClient } from "./codex-app-server-client.js";
import {
  parseCodexItemId,
  parseCodexThreadId,
  parseCodexTurnId,
  type CodexNotification,
  type CodexThread,
  type CodexThreadId,
  type CodexTurnId,
} from "./codex-app-server-protocol.js";
import {
  CodexHarnessCapabilities,
  CodexHarnessProviderDescriptor,
  createCodexHarnessProvider,
  makeInMemoryCodexHarnessCorrelationStore,
} from "./codex-harness-provider.js";
import { appendEvent, appendHarnessSessionEvent } from "./event-store.js";
import {
  readFactoryGraph,
  readFactoryRunActivity,
} from "./factory-run-read-api.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import {
  HarnessResumeError,
  startHarnessSession,
  type HarnessProvider,
  type HarnessSession,
} from "./harness-session.js";
import { codexAppServerHarnessName, HarnessRunRequest } from "./harness.js";
import {
  interactiveSessionHarness,
  refreshInteractiveHarnessResult,
} from "./interactive-harness.js";
import { makeRunPaths } from "./paths.js";
import { readLocalRunEvents } from "./run-read-api.js";
import { acceptFactoryRun, continueServerRun } from "./server-workflows.js";
import {
  snapshotWorkspace,
  writeWorkspaceSnapshot,
} from "./workspace-snapshot.js";

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
    it.effect(
      "keeps interactive file changes publishable instead of classifying them as harness artifacts",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-interactive-source-",
          });
          const runId = parseRunId("run-SourcePub1");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.makeDirectory(paths.workspace, { recursive: true });
          yield* writeWorkspaceSnapshot(
            paths.harnessWorkspaceBaseline,
            yield* snapshotWorkspace(paths.workspace)
          );
          yield* fs.makeDirectory(`${paths.workspace}/src`, {
            recursive: true,
          });
          yield* fs.writeFileString(
            `${paths.workspace}/src/feature.ts`,
            "export const feature = true;\n"
          );

          const result = yield* refreshInteractiveHarnessResult({
            paths,
            runId,
            workerLogPath: paths.workerLog,
            workerResultPath: paths.workerResult,
            workspacePath: paths.workspace,
          });

          assert.deepEqual(result.workspaceDiff?.productChangedPaths, [
            "src/feature.ts",
          ]);
          assert.deepEqual(result.outputArtifacts, []);
        })
    );

    it.effect(
      "executes the actual workflow through a synthetic provider without waiting for stream close",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-interactive-",
          });
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
                description:
                  "Complete through a synthetic interactive provider.",
                kind: "issue",
                title: "Synthetic provider workflow proof",
              },
            },
            { harnessProviderRegistry: registry, rootDirectory: cwd }
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
            1
          );
          assert.strictEqual(
            types.filter((type) => type === "HARNESS_SESSION_EVENT_RECORDED")
              .length,
            4
          );
          assert.strictEqual(types.at(-1), "REPORT_COMPLETED");
          assert.isBelow(
            types.indexOf("HARNESS_SESSION_EVENT_RECORDED"),
            types.indexOf("WORKER_COMPLETED")
          );
        })
    );

    it.effect(
      "keeps a recovered provider stream open for the new pending interaction",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-interactive-recovered-",
          });
          const runId = parseRunId("run-RecoLive01");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.makeDirectory(paths.workspace, { recursive: true });
          yield* appendEvent(runId, paths, {
            payload: { specPath: "spec.md" },
            type: "RUN_CREATED",
          });

          const sessionId = parseHarnessSessionId(`session-${runId}`);
          const fiber = yield* interactiveSessionHarness({
            provider: recoveredPendingProvider(),
            rootDirectory: cwd,
          })
            .run(
              HarnessRunRequest.make({
                codexHarnessProgressPath: paths.codexHarnessProgress,
                harnessName: codexAppServerHarnessName,
                resolvedSkillPaths: [],
                runId,
                skillBundlePath: paths.skillBundle,
                specBody:
                  "Recover and continue with a new pending interaction.",
                specTitle: "Recovered pending interaction",
                workerLogPath: paths.workerLog,
                workerResultPath: paths.workerResult,
                workspaceOutputPath: paths.workspaceOutput,
                workspacePath: paths.workspace,
              })
            )
            .pipe(Effect.forkChild);

          let harnessEvents: ReadonlyArray<HarnessEvent> = [];
          for (let attempt = 0; attempt < 1_000; attempt += 1) {
            const observed = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            harnessEvents = observed.events.flatMap((event) =>
              event.type === "HARNESS_SESSION_EVENT_RECORDED"
                ? [parseHarnessEvent(event.payload.event)]
                : []
            );
            if (harnessEvents.length >= 7) break;
            yield* Effect.yieldNow;
          }
          yield* Fiber.interrupt(fiber);

          const snapshot = projectHarnessEvents(harnessEvents, sessionId);
          assert.deepEqual(
            harnessEvents.map(({ kind }) => kind),
            [
              "sessionStarted",
              "turnStarted",
              "interactionRequested",
              "sessionFailed",
              "sessionRecovered",
              "turnStarted",
              "interactionRequested",
            ]
          );
          assert.strictEqual(snapshot.state, "running");
          assert.deepEqual(
            snapshot.pendingInteractions.map(
              ({ interactionId }) => interactionId
            ),
            [parseHarnessInteractionId("interaction-recovered-pending")]
          );
          assert.deepEqual(
            snapshot.turns.map(({ status, turnId }) => ({ status, turnId })),
            [
              {
                status: "failed",
                turnId: parseHarnessTurnId("turn-recovered-old"),
              },
              {
                status: "running",
                turnId: parseHarnessTurnId("turn-recovered-new"),
              },
            ]
          );
        })
    );

    it.effect(
      "waits for the exact checkpoint turn instead of an older recovered terminal",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-checkpoint-turn-projection-",
          });
          const runId = parseRunId("run-ChkptProj1");
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.makeDirectory(paths.workspace, { recursive: true });
          yield* writeWorkspaceSnapshot(
            paths.harnessWorkspaceBaseline,
            yield* snapshotWorkspace(paths.workspace)
          );

          const sessionId = parseHarnessSessionId(`session-${runId}`);
          const threadId = parseCodexThreadId("native-checkpoint-thread");
          const olderTurnId = parseCodexTurnId("native-older-completed-turn");
          const checkpointTurnId = parseCodexTurnId("native-checkpoint-turn");
          const correlationStore = makeInMemoryCodexHarnessCorrelationStore();
          const first = recordingCodexClient({
            recoveredTurns: [],
            startTurnId: olderTurnId,
            threadId,
          });
          yield* Effect.scoped(
            startHarnessSession({
              provider: createCodexHarnessProvider({
                client: first.client,
                correlationStore,
                workspaceRoot: cwd,
              }),
              request: {
                input: { text: "initial turn" },
                sessionId,
                workspacePath: parseWorkspaceRelativePath("workspace"),
              },
              requiredCapabilities: [],
            })
          );
          yield* appendHarnessSessionEvent(runId, paths, {
            capabilities: CodexHarnessCapabilities,
            kind: "sessionStarted",
            provider: CodexHarnessProviderDescriptor,
            sessionId,
            state: "running",
          });

          const subscribed = yield* Deferred.make<void>();
          const second = recordingCodexClient({
            onSubscribed: () => {
              Deferred.doneUnsafe(subscribed, Effect.void);
            },
            recoveredTurns: [
              {
                id: olderTurnId,
                items: [
                  {
                    id: parseCodexItemId("native-older-completed-item"),
                    phase: "final_answer",
                    text: "older terminal output",
                    type: "agentMessage",
                  },
                ],
                status: "completed",
              },
              { id: checkpointTurnId, status: "inProgress" },
            ],
            startTurnId: checkpointTurnId,
            threadId,
          });
          const provider = createCodexHarnessProvider({
            client: second.client,
            correlationStore,
            workspaceRoot: cwd,
          });
          const resultFiber = yield* interactiveSessionHarness({
            expectedNativeTurnId: checkpointTurnId,
            provider,
            rootDirectory: cwd,
          })
            .run(
              HarnessRunRequest.make({
                codexHarnessProgressPath: paths.codexHarnessProgress,
                harnessName: codexAppServerHarnessName,
                resolvedSkillPaths: [],
                runId,
                skillBundlePath: paths.skillBundle,
                specBody: "Complete only the checkpointed turn.",
                specTitle: "Checkpoint turn projection",
                workerLogPath: paths.workerLog,
                workerResultPath: paths.workerResult,
                workspaceOutputPath: paths.workspaceOutput,
                workspacePath: paths.workspace,
              })
            )
            .pipe(Effect.forkChild);

          yield* Deferred.await(subscribed);
          let beforeCompletion: ReadonlyArray<HarnessEvent> = [];
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const observed = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            beforeCompletion = observed.events.flatMap((event) =>
              event.type === "HARNESS_SESSION_EVENT_RECORDED"
                ? [parseHarnessEvent(event.payload["event"])]
                : []
            );
            if (
              beforeCompletion.some((event) => event.kind === "turnStarted")
            ) {
              break;
            }
            yield* Effect.yieldNow;
          }
          assert.strictEqual(
            beforeCompletion.filter((event) => event.kind === "turnStarted")
              .length,
            1
          );
          assert.strictEqual(
            beforeCompletion.filter((event) => event.kind === "turnCompleted")
              .length,
            0
          );
          assert.notInclude(
            JSON.stringify(beforeCompletion),
            "older terminal output"
          );
          assert.strictEqual(resultFiber.pollUnsafe(), undefined);
          for (const listener of second.notifications) {
            listener({
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: checkpointTurnId, status: "completed" },
              },
            });
          }
          const result = yield* Fiber.join(resultFiber);
          const events = yield* readLocalRunEvents(runId, {
            rootDirectory: cwd,
          });
          const harnessEvents = events.events.flatMap((event) =>
            event.type === "HARNESS_SESSION_EVENT_RECORDED"
              ? [parseHarnessEvent(event.payload["event"])]
              : []
          );
          const turnStarts = harnessEvents.filter(
            (event) => event.kind === "turnStarted"
          );
          const terminals = harnessEvents.filter(
            (event) => event.kind === "turnCompleted"
          );

          assert.strictEqual(result.harnessName, codexAppServerHarnessName);
          assert.strictEqual(second.turnStarts.length, 0);
          assert.deepEqual(second.interrupts, []);
          assert.strictEqual(turnStarts.length, 1);
          assert.strictEqual(terminals.length, 1);
          assert.strictEqual(terminals[0]?.kind, "turnCompleted");
          assert.strictEqual(turnStarts[0]?.kind, "turnStarted");
          if (
            terminals[0]?.kind !== "turnCompleted" ||
            turnStarts[0]?.kind !== "turnStarted"
          ) {
            throw new Error("Expected one checkpoint turn lifecycle.");
          }
          assert.strictEqual(terminals[0].turnId, turnStarts[0].turnId);
          assert.notInclude(
            JSON.stringify(harnessEvents),
            "older terminal output"
          );
        })
    );

    it.effect(
      "owns a persisted terminal turn without starting or resuming the provider after a crash window",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-terminal-resume-",
          });
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
            { harnessProviderRegistry: registry, rootDirectory: cwd }
          );
          const paths = yield* makeRunPaths(accepted.runId, {
            rootDirectory: cwd,
          });
          yield* fs.makeDirectory(paths.workspace, { recursive: true });
          yield* writeWorkspaceSnapshot(
            paths.harnessWorkspaceBaseline,
            yield* snapshotWorkspace(paths.workspace)
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
            events.events.filter(({ type }) => type === "WORKER_COMPLETED")
              .length,
            1
          );
          const terminalIndex = events.events.findIndex(
            (event) =>
              event.type === "HARNESS_SESSION_EVENT_RECORDED" &&
              event.payload.event !== null &&
              typeof event.payload.event === "object" &&
              !Array.isArray(event.payload.event) &&
              Object.getOwnPropertyDescriptor(event.payload.event, "kind")
                ?.value === "turnCompleted"
          );
          assert.strictEqual(
            events.events[terminalIndex + 1]?.type,
            "WORKER_COMPLETED"
          );
        })
    );

    it.effect(
      "fails a nonterminal resume once when private correlation is unavailable",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-correlation-resume-",
          });
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
                })
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
            { harnessProviderRegistry: registry, rootDirectory: cwd }
          );
          const paths = yield* makeRunPaths(accepted.runId, {
            rootDirectory: cwd,
          });
          yield* fs.makeDirectory(paths.workspace, { recursive: true });
          yield* writeWorkspaceSnapshot(
            paths.harnessWorkspaceBaseline,
            yield* snapshotWorkspace(paths.workspace)
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
          const failures = events.events.filter(
            ({ type }) => type === "RUN_FAILED"
          );

          assert.strictEqual(continuation._tag, "Failure");
          assert.strictEqual(counters.start, 0);
          assert.strictEqual(counters.resume, 1);
          assert.strictEqual(failures.length, 1);
          assert.strictEqual(
            failures[0]?.payload["code"],
            "HarnessCorrelationUnavailable"
          );
          assert.notInclude(
            events.events.map(({ type }) => type),
            "WORKER_COMPLETED"
          );
        })
    );

    it.effect(
      "resumes a persisted nonterminal session through the generic provider SPI",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-session-resume-",
          });
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
            { harnessProviderRegistry: registry, rootDirectory: cwd }
          );
          const paths = yield* makeRunPaths(accepted.runId, {
            rootDirectory: cwd,
          });
          yield* fs.makeDirectory(paths.workspace, { recursive: true });
          yield* writeWorkspaceSnapshot(
            paths.harnessWorkspaceBaseline,
            yield* snapshotWorkspace(paths.workspace)
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
            { rootDirectory: cwd }
          );
          assert.deepInclude(
            graphBeforeResume.agents.map(({ role, state }) => ({
              role,
              state,
            })),
            { role: "worker", state: "running" }
          );
          assert.strictEqual(
            activityBeforeResume.activities.at(-1)?.agentId,
            "agent-worker"
          );
          assert.strictEqual(
            activityBeforeResume.activities.at(-1)?.subState,
            "turnStarted"
          );

          const summary = yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry: registry,
            rootDirectory: cwd,
          });

          assert.strictEqual(summary.status, "completed");
          assert.strictEqual(counters.start, 0);
          assert.strictEqual(counters.resume, 1);
        })
    );

    it.effect(
      "continues downstream from persisted worker completion without resolving the provider twice",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-worker-complete-resume-",
          });
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
                description:
                  "Continue downstream after worker completion persistence.",
                kind: "issue",
                title: "Completed worker crash window",
              },
            },
            { harnessProviderRegistry: registry, rootDirectory: cwd }
          );
          const paths = yield* makeRunPaths(accepted.runId, {
            rootDirectory: cwd,
          });
          yield* fs.makeDirectory(paths.workspace, { recursive: true });
          yield* writeWorkspaceSnapshot(
            paths.harnessWorkspaceBaseline,
            yield* snapshotWorkspace(paths.workspace)
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
            })
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
            events.events.filter(({ type }) => type === "WORKER_COMPLETED")
              .length,
            1
          );
        })
    );
  });
});

function syntheticProvider(
  counters: {
    detect: number;
    resume: number;
    start: number;
  },
  isAvailable: () => boolean = () => true
): HarnessProvider {
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
        ? ({
            auth: { state: "notRequired" },
            capabilities: syntheticCapabilities,
            state: "available",
            version: "synthetic-1",
          } as const)
        : ({ state: "missing" } as const);
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
  provider: HarnessProviderDescriptor
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
      Stream.never
    ),
    interrupt: Option.some(Effect.void),
    resolveInteraction: () => Effect.void,
    send: () => Effect.void,
    snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
    steer: Option.none(),
  };
}

function recoveredPendingProvider(): HarnessProvider {
  const descriptor = HarnessProviderDescriptor.make({
    displayName: "Recovered Pending Provider",
    executionModes: ["local"],
    providerId: parseHarnessProviderId("recovered-pending"),
  });
  return {
    createSession: (request) =>
      Effect.succeed(recoveredPendingSession(request.sessionId, descriptor)),
    descriptor,
    detect: Effect.succeed({
      auth: { state: "notRequired" },
      capabilities: recoveredPendingCapabilities,
      state: "available",
      version: "recovered-pending-1",
    }),
    resumeSession: (request) =>
      Effect.succeed(recoveredPendingSession(request.sessionId, descriptor)),
  };
}

const recoveredPendingCapabilities = HarnessCapabilities.make({
  ...syntheticCapabilities,
  approvals: ["command"],
});

function recoveredPendingSession(
  sessionId: ReturnType<typeof parseHarnessSessionId>,
  provider: HarnessProviderDescriptor
): HarnessSession {
  const oldTurnId = parseHarnessTurnId("turn-recovered-old");
  const newTurnId = parseHarnessTurnId("turn-recovered-new");
  const events: ReadonlyArray<HarnessEvent> = [
    {
      capabilities: recoveredPendingCapabilities,
      kind: "sessionStarted",
      provider,
      sessionId,
      state: "running",
    },
    { kind: "turnStarted", sessionId, turnId: oldTurnId },
    {
      interaction: {
        allowedDecisions: ["decline"],
        command: "pnpm gaia doctor --json",
        interactionId: parseHarnessInteractionId("interaction-recovered-old"),
        itemId: parseHarnessItemId("item-recovered-old"),
        kind: "commandApproval",
        requestedAt: "2026-07-13T02:30:00.000Z",
        turnId: oldTurnId,
        workspacePath: parseWorkspaceRelativePath("."),
      },
      kind: "interactionRequested",
      sessionId,
    },
    {
      failure: {
        code: "ProviderCrashed",
        kind: "providerFailure",
        message: "Provider stopped unexpectedly.",
        recoverable: true,
      },
      kind: "sessionFailed",
      sessionId,
    },
    { kind: "sessionRecovered", sessionId },
    { kind: "turnStarted", sessionId, turnId: newTurnId },
    {
      interaction: {
        allowedDecisions: ["decline"],
        command: "pnpm gaia doctor --json",
        interactionId: parseHarnessInteractionId(
          "interaction-recovered-pending"
        ),
        itemId: parseHarnessItemId("item-recovered-pending"),
        kind: "commandApproval",
        requestedAt: "2026-07-13T02:30:01.000Z",
        turnId: newTurnId,
        workspacePath: parseWorkspaceRelativePath("."),
      },
      kind: "interactionRequested",
      sessionId,
    },
  ];
  return {
    events: Stream.concat(Stream.fromIterable(events), Stream.never),
    interrupt: Option.some(Effect.void),
    resolveInteraction: () => Effect.void,
    send: () => Effect.void,
    snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
    steer: Option.none(),
  };
}

type RecoveredCodexTurn = NonNullable<CodexThread["turns"]>[number];

function recordingCodexClient(input: {
  readonly onSubscribed?: () => void;
  readonly recoveredTurns: ReadonlyArray<RecoveredCodexTurn>;
  readonly startTurnId: CodexTurnId;
  readonly threadId: CodexThreadId;
}) {
  const interrupts: Array<unknown> = [];
  const notifications = new Set<(notification: CodexNotification) => void>();
  const turnStarts: Array<unknown> = [];
  const client = {
    initialize: () =>
      Effect.succeed({
        platformFamily: "unix",
        platformOs: "macos",
        userAgent: "Codex/0.137.0",
      }),
    interruptTurn: (params) =>
      Effect.sync(() => {
        interrupts.push(params);
        return {};
      }),
    listThreads: () =>
      Effect.succeed({ backwardsCursor: null, data: [], nextCursor: null }),
    onNotification: (listener) => {
      notifications.add(listener);
      input.onSubscribed?.();
      return () => notifications.delete(listener);
    },
    onServerRequest: () => () => undefined,
    onTermination: () => () => undefined,
    readThread: () =>
      Effect.succeed({
        thread: {
          id: input.threadId,
          status: { type: "idle" as const },
          turns: [...input.recoveredTurns],
        },
      }),
    respondCommandApproval: () => Effect.void,
    respondElicitation: () => Effect.void,
    respondFileApproval: () => Effect.void,
    respondPermissionApproval: () => Effect.void,
    respondUserInput: () => Effect.void,
    resumeThread: () => Effect.succeed({ thread: { id: input.threadId } }),
    startThread: () => Effect.succeed({ thread: { id: input.threadId } }),
    startTurn: (params) =>
      Effect.sync(() => {
        turnStarts.push(params);
        return {
          turn: { id: input.startTurnId, status: "inProgress" as const },
        };
      }),
    steerTurn: () => Effect.succeed({ turnId: input.startTurnId }),
  } satisfies CodexAppServerClient;
  return { client, interrupts, notifications, turnStarts };
}
