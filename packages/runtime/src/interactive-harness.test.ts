import { mkdir, writeFile } from "node:fs/promises";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  digestHarnessEnvironmentContract,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
  makeModelContextContentV1,
  makeModelContextManifestV1,
  makeModelInvocationManifestV1,
  ModelInvocationEpisodeStartV1,
  RunControlEventPayload,
  parseHarnessEvent,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessProviderId,
  parseRunId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseMarkdownSpec,
  parseRunControlEventPayload,
  parseWorkspaceRelativePath,
  projectHarnessEvents,
  renderModelInputV1,
  type HarnessEvent,
  type RunId,
} from "@gaia/core";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Schema,
  Stream,
} from "effect";

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
  CodexHarnessProviderConfig,
  CodexHarnessProviderDescriptor,
  createCodexHarnessProvider,
  encodeCodexHarnessCheckpoint,
  makeInMemoryCodexHarnessCorrelationStore,
} from "./codex-harness-provider.js";
import {
  makeCodexHarnessConfig,
  type CodexCommandInvocation,
} from "./codex-harness.js";
import { GaiaRuntimeError } from "./errors.js";
import {
  appendEvent,
  appendEventWithinSerialization,
  appendHarnessSessionEvent,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import {
  readFactoryGraph,
  readFactoryRunActivity,
} from "./factory-run-read-api.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import {
  HarnessResumeError,
  startHarnessSession,
  type HarnessProvider,
  type HarnessSession,
} from "./harness-session.js";
import {
  codexAppServerHarnessName,
  codexHarnessName,
  HarnessRunRequest,
  parseHarnessName,
  runHarness,
} from "./harness.js";
import {
  digestRunContractEnvironmentSemantics,
  digestModelInvocationEnvironmentSemantics,
  digestWorkerPlanEnvironmentSemantics,
  interactiveSessionHarness,
  refreshInteractiveHarnessResult,
} from "./interactive-harness.js";
import {
  commitModelInvocationPair,
  deriveModelWorkspaceBinding,
} from "./model-invocation.js";
import { makeRunPaths } from "./paths.js";
import type { RunPaths } from "./paths.js";
import { deriveAndRecordRunContract, loadRunContract } from "./run-contract.js";
import { readLocalRunEvents } from "./run-read-api.js";
import { acceptFactoryRun, continueServerRun } from "./server-workflows.js";
import { recordRunProofResult } from "./verifier.js";
import { writeWorkerPlan } from "./worker-plan.js";
import { runSpecFile } from "./workflows.js";
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
      "keeps actual run-contract and WorkerPlan semantics stable across run IDs",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-epoch-semantic-digest-",
          });
          const spec = parseMarkdownSpec(
            "Implement the same bounded behavior.",
            "Stable worker epoch"
          );
          const evidence = [];
          for (const runId of [
            parseRunId("run-EpochSem01"),
            parseRunId("run-EpochSem02"),
          ]) {
            const paths = yield* makeRunPaths(runId, { rootDirectory: root });
            yield* fs.makeDirectory(paths.workspace, { recursive: true });
            yield* appendEvent(runId, paths, {
              payload: { specPath: "input.md" },
              type: "RUN_CREATED",
            });
            const contract = yield* deriveAndRecordRunContract({
              paths,
              runId,
              spec,
            });
            yield* writeWorkerPlan({
              harnessName: codexAppServerHarnessName,
              paths,
              runId,
              spec,
            });
            const workerPlan = yield* fs.readFileString(paths.workerPlanResult);
            evidence.push({
              contractDigest: contract.contractDigest,
              contractSemanticDigest:
                digestRunContractEnvironmentSemantics(contract),
              workerPlan,
              workerPlanSemanticDigest:
                digestWorkerPlanEnvironmentSemantics(workerPlan),
            });
          }

          assert.notStrictEqual(
            evidence[0]?.contractDigest,
            evidence[1]?.contractDigest
          );
          assert.notStrictEqual(
            evidence[0]?.workerPlan,
            evidence[1]?.workerPlan
          );
          assert.strictEqual(
            evidence[0]?.contractSemanticDigest,
            evidence[1]?.contractSemanticDigest
          );
          assert.strictEqual(
            evidence[0]?.workerPlanSemanticDigest,
            evidence[1]?.workerPlanSemanticDigest
          );
        })
    );

    it.effect(
      "changes GAIA-146 semantic identity for material invocation evidence",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-invocation-semantic-digest-",
          });
          const runId = parseRunId("run-InvSem0001");
          const paths = yield* makeRunPaths(runId, { rootDirectory: root });
          yield* fs.makeDirectory(paths.workspace, { recursive: true });
          const workspaceBinding = yield* deriveModelWorkspaceBinding(paths);
          const content = makeModelContextContentV1({
            acceptedOutcomes: [],
            authority: ["Apply only accepted worker authority."],
            budget: { maxOutputBytes: 16_384, maxTurns: 1 },
            contentRefs: [],
            episodeRole: "workerInitial",
            instructions: ["Complete the bounded task."],
            nonGoals: [],
            outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
            planningFacts: [],
            safeExclusions: [],
            skills: [],
            stops: [],
            taskInput: "Complete the bounded task.",
            verificationCommands: [],
          });
          const rendered = renderModelInputV1(content);
          const context = makeModelContextManifestV1({
            authoritativeRefs: [{ digest: "a".repeat(64), kind: "authority" }],
            binding: { episodeKey: "workerInitial", runId },
            content,
            workspaceBinding,
          });
          const invocation = (
            observation: "offered" | "unobservable",
            authorityDigest = "a".repeat(64)
          ) =>
            makeModelInvocationManifestV1({
              acceptedProviderCapabilityObservation: observation,
              adapterInputClass: "codexAppTurn",
              adapterSemantics: {
                kind: "codexAppServer",
                semanticDigest: "b".repeat(64),
              },
              authorityRef: { digest: authorityDigest, kind: "authority" },
              binding: context.payload.binding,
              budget: content.payload.budget,
              context,
              outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
              rendered,
              runContractRef: {
                digest: "c".repeat(64),
                kind: "runContract",
              },
              template: { id: "gaia.worker-input.v1", version: 1 },
              workspaceBinding,
            });
          const semanticDigest = (
            observation: "offered" | "unobservable",
            authorityDigest?: string
          ) =>
            digestModelInvocationEnvironmentSemantics({
              context,
              invocation: invocation(
                observation,
                authorityDigest ?? "a".repeat(64)
              ),
              runContractSemanticDigest: digestHarnessEnvironmentContract(
                "gaia.test.run-contract-semantic.v1",
                ["stable"]
              ),
              workspaceBinding,
            });

          assert.notStrictEqual(
            semanticDigest("offered"),
            semanticDigest("unobservable")
          );
          assert.notStrictEqual(
            semanticDigest("unobservable", "a".repeat(64)),
            semanticDigest("unobservable", "e".repeat(64))
          );
        })
    );

    it.effect(
      "keeps distinct-run batch stdin and App turn text byte-identical while binding each actual cwd",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-model-adapter-parity-",
          });
          const batchRunId = parseRunId("run-BatchPair1");
          const appRunId = parseRunId("run-AppPair001");
          const batchPaths = yield* makeRunPaths(batchRunId, {
            rootDirectory: root,
          });
          const appPaths = yield* makeRunPaths(appRunId, {
            rootDirectory: root,
          });
          for (const [runId, paths] of [
            [batchRunId, batchPaths],
            [appRunId, appPaths],
          ] as const) {
            yield* fs.makeDirectory(paths.root, { recursive: true });
            yield* fs.makeDirectory(paths.workspace, { recursive: true });
            yield* appendEvent(runId, paths, {
              payload: {
                modelInvocationProtocol: "v1",
                specPath: "input.md",
              },
              type: "RUN_CREATED",
            });
          }
          const title = "Stable adapter parity";
          const description = "Complete the same accepted worker outcome.";
          const batchPrepared = yield* prepareAcceptedInteractiveRun(
            batchRunId,
            batchPaths,
            title,
            description
          );
          const appPrepared = yield* prepareAcceptedInteractiveRun(
            appRunId,
            appPaths,
            title,
            description
          );
          const batchCommands: Array<CodexCommandInvocation> = [];
          const batchResult = yield* runHarness(
            HarnessRunRequest.make({
              codexHarnessProgressPath: batchPaths.codexHarnessProgress,
              harnessName: codexHarnessName,
              modelRenderedInput: batchPrepared.rendered,
              modelWorkspaceBinding: batchPrepared.workspaceBinding,
              resolvedSkillPaths: [],
              runId: batchRunId,
              skillBundlePath: batchPaths.skillBundle,
              specBody: description,
              specTitle: title,
              workerLogPath: batchPaths.workerLog,
              workerResultPath: batchPaths.workerResult,
              workspaceOutputPath: batchPaths.workspaceOutput,
              workspacePath: batchPaths.workspace,
            }),
            {
              codexHarness: {
                commandRunner: (input) =>
                  Effect.gen(function* () {
                    batchCommands.push(input);
                    const lastMessageIndex = input.request.args.indexOf(
                      "--output-last-message"
                    );
                    const lastMessagePath =
                      input.request.args[lastMessageIndex + 1];
                    assert.isString(lastMessagePath);
                    yield* fs.writeFileString(
                      lastMessagePath!,
                      "Recorded batch completion.\n"
                    );
                    yield* fs.writeFileString(
                      `${input.request.cwd}/output.txt`,
                      `recorded batch ${batchRunId}\n`
                    );
                    return { exitCode: 0, stderr: "", stdout: "" };
                  }),
                config: makeCodexHarnessConfig({ command: "codex-recording" }),
              },
            }
          );
          yield* appendEvent(batchRunId, batchPaths, {
            payload: {
              changedWorkspacePaths: batchResult.changedWorkspacePaths,
              harnessName: batchResult.harnessName,
              outputArtifacts: batchResult.outputArtifacts,
              workerResultPath: batchResult.resultPath,
            },
            type: "WORKER_COMPLETED",
          });
          const batchProof = yield* recordRunProofResult(
            batchRunId,
            batchPaths
          );

          const subscribed = yield* Deferred.make<void>();
          const appClient = recordingCodexClient({
            onSubscribed: () => {
              Deferred.doneUnsafe(subscribed, Effect.void);
            },
            recoveredTurns: [],
            startTurnId: parseCodexTurnId("native-app-parity-turn"),
            threadId: parseCodexThreadId("native-app-parity-thread"),
          });
          const appProvider = createCodexHarnessProvider({
            client: appClient.client,
            config: CodexHarnessProviderConfig.make({ workspaceRoot: root }),
            correlationStore: makeInMemoryCodexHarnessCorrelationStore(),
          });
          const appFiber = yield* interactiveSessionHarness({
            provider: appProvider,
            rootDirectory: root,
          })
            .run(
              HarnessRunRequest.make({
                codexHarnessProgressPath: appPaths.codexHarnessProgress,
                harnessName: codexAppServerHarnessName,
                modelRenderedInput: appPrepared.rendered,
                modelWorkspaceBinding: appPrepared.workspaceBinding,
                resolvedSkillPaths: [],
                runId: appRunId,
                skillBundlePath: appPaths.skillBundle,
                specBody: description,
                specTitle: title,
                workerLogPath: appPaths.workerLog,
                workerResultPath: appPaths.workerResult,
                workspaceOutputPath: appPaths.workspaceOutput,
                workspacePath: appPaths.workspace,
              })
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(subscribed);
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              appClient.threadStarts.length === 1 &&
              appClient.turnStarts.length === 1 &&
              appClient.notifications.size > 0
            )
              break;
            yield* Effect.yieldNow;
          }
          assert.strictEqual(appClient.threadStarts.length, 1);
          assert.strictEqual(appClient.turnStarts.length, 1);
          assert.isAbove(appClient.notifications.size, 0);
          yield* fs.writeFileString(
            appPaths.workspaceOutput,
            `recorded app ${appRunId}\n`
          );
          for (const listener of appClient.notifications) {
            listener({
              method: "turn/completed",
              params: {
                threadId: parseCodexThreadId("native-app-parity-thread"),
                turn: {
                  id: parseCodexTurnId("native-app-parity-turn"),
                  status: "completed",
                },
              },
            });
          }
          const appResult = yield* Fiber.join(appFiber);
          if ("kind" in appResult)
            assert.fail("Expected a completed interactive harness result.");
          yield* appendEvent(appRunId, appPaths, {
            payload: {
              changedWorkspacePaths: appResult.changedWorkspacePaths,
              harnessName: appResult.harnessName,
              outputArtifacts: appResult.outputArtifacts,
              workerResultPath: appResult.resultPath,
            },
            type: "WORKER_COMPLETED",
          });
          const appProof = yield* recordRunProofResult(appRunId, appPaths);

          assert.strictEqual(batchCommands.length, 1);
          assert.strictEqual(appClient.threadStarts.length, 1);
          assert.strictEqual(appClient.turnStarts.length, 1);
          const batchCommand = batchCommands[0]!;
          const appThread = appClient.threadStarts[0] as { cwd: string };
          const appTurn = appClient.turnStarts[0] as {
            input: ReadonlyArray<{ text?: string; type: string }>;
          };
          const appText = appTurn.input[0]?.text;
          assert.strictEqual(batchCommand.request.stdin, appText);
          assert.strictEqual(
            batchCommand.request.stdin,
            batchPrepared.rendered.text
          );
          assert.strictEqual(appText, appPrepared.rendered.text);
          assert.strictEqual(
            batchPrepared.rendered.renderedInputDigest,
            appPrepared.rendered.renderedInputDigest
          );
          assert.notInclude(batchCommand.request.stdin, batchRunId);
          assert.notInclude(batchCommand.request.stdin, appRunId);
          assert.notInclude(batchCommand.request.stdin, batchPaths.workspace);
          assert.notInclude(batchCommand.request.stdin, appPaths.workspace);
          assert.strictEqual(batchCommand.request.cwd, batchPaths.workspace);
          assert.strictEqual(appThread.cwd, appPaths.workspace);
          assert.strictEqual(
            batchCommand.request.args[
              batchCommand.request.args.indexOf("--cd") + 1
            ],
            batchPaths.workspace
          );
          assert.strictEqual(batchProof.version, 1);
          assert.strictEqual(appProof.version, 1);
          if (batchProof.version === 1 && appProof.version === 1) {
            assert.strictEqual(
              batchProof.supplementalProtocolEvidence[0]?.kind,
              "framework-output-marker"
            );
            assert.strictEqual(
              appProof.supplementalProtocolEvidence[0]?.kind,
              "framework-output-marker"
            );
          }
        })
    );

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

          assert.deepEqual(
            result.workspaceDiff?.productChangedPaths.map(String),
            ["src/feature.ts"]
          );
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
          const provider = syntheticProvider(counters, () => true, cwd);
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
                config: CodexHarnessProviderConfig.make({ workspaceRoot: cwd }),
              }),
              request: {
                input: { text: "initial turn" },
                sessionId,
                workspacePath: parseWorkspaceRelativePath("workspace"),
              },
              requiredCapabilities: [],
            })
          );
          yield* appendEvent(runId, paths, {
            payload: { specPath: "input.md" },
            type: "RUN_CREATED",
          });
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
            config: CodexHarnessProviderConfig.make({ workspaceRoot: cwd }),
          });
          const resultFiber = yield* interactiveSessionHarness({
            expectedCheckpoint: encodeCodexHarnessCheckpoint(checkpointTurnId),
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

          if ("kind" in result)
            assert.fail("Expected a completed interactive harness result.");
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
          yield* prepareAcceptedInteractiveRun(
            accepted.runId,
            paths,
            "Terminal crash window",
            "Recover after terminal turn persistence."
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
          yield* prepareAcceptedInteractiveRun(
            accepted.runId,
            paths,
            "Missing private correlation",
            "Fail closed when private correlation is missing."
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
          yield* prepareAcceptedInteractiveRun(
            accepted.runId,
            paths,
            "Generic resume proof",
            "Resume a nonterminal session."
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

          for (const terminalPhase of [
            "RUN_CONTROL_ATTEMPTED",
            "RUN_CONTROL_OUTCOME_UNKNOWN",
          ] as const) {
            const controlRunId = parseRunId(
              terminalPhase === "RUN_CONTROL_ATTEMPTED"
                ? "run-AttemptR1x"
                : "run-UnknownR1x"
            );
            const controlPaths = yield* makeRunPaths(controlRunId, {
              rootDirectory: cwd,
            });
            yield* fs.makeDirectory(controlPaths.workspace, {
              recursive: true,
            });
            yield* appendEvent(controlRunId, controlPaths, {
              payload: { specPath: "input.md" },
              type: "RUN_CREATED",
            });
            yield* appendEvent(controlRunId, controlPaths, {
              payload: { workspacePath: "workspace" },
              type: "WORKSPACE_PREPARED",
            });
            yield* appendEvent(controlRunId, controlPaths, {
              type: "WORKER_STARTED",
            });
            const controlSessionId = parseHarnessSessionId(
              `session-${controlRunId}`
            );
            const controlTurnId = parseHarnessTurnId(`turn-${controlRunId}`);
            yield* appendHarnessSessionEvent(controlRunId, controlPaths, {
              capabilities: syntheticCapabilities,
              kind: "sessionStarted",
              provider: provider.descriptor,
              sessionId: controlSessionId,
              state: "running",
            });
            yield* appendHarnessSessionEvent(controlRunId, controlPaths, {
              kind: "turnStarted",
              sessionId: controlSessionId,
              turnId: controlTurnId,
            });
            const control = parseRunControlEventPayload({
              actionBindingDigest: "a".repeat(64),
              actionId: `action-${controlRunId}`,
              authorityId: "local-gaia-server",
              expectedEventSequence: 5,
              operation: "pause",
              providerId: provider.descriptor.providerId,
              restoreState: "runningWorker",
              sessionId: controlSessionId,
              workerAgentId: issueDeliveryAgentIds.worker,
              workerStartedSequence: 3,
            });
            const encodedControl = Schema.encodeSync(RunControlEventPayload)(
              control
            );
            yield* appendEvent(controlRunId, controlPaths, {
              payload: { control: encodedControl },
              type: "RUN_CONTROL_INTENT_RECORDED",
            });
            yield* appendEvent(controlRunId, controlPaths, {
              payload: { control: encodedControl },
              type: "RUN_CONTROL_ATTEMPTED",
            });
            if (terminalPhase === "RUN_CONTROL_OUTCOME_UNKNOWN") {
              yield* appendEvent(controlRunId, controlPaths, {
                payload: { control: encodedControl },
                type: terminalPhase,
              });
            }
            const interruptedSession = syntheticSession(
              controlSessionId,
              provider.descriptor
            );
            let controlResumeCalls = 0;
            const interruptedProvider: HarnessProvider = {
              ...provider,
              resumeSession: () => {
                controlResumeCalls += 1;
                return Effect.succeed({
                  ...interruptedSession,
                  events: Stream.fromIterable([
                    {
                      kind: "turnCompleted" as const,
                      sessionId: controlSessionId,
                      status: "interrupted" as const,
                      turnId: controlTurnId,
                    },
                  ]),
                });
              },
            };
            const interruptedRegistry = makeHarnessProviderRegistry([
              {
                profileId: codexAppServerExecutionSelection.harnessProfileId,
                provider: interruptedProvider,
              },
            ]);
            const interrupted = yield* continueServerRun(controlRunId, {
              harnessProviderRegistry: interruptedRegistry,
              rootDirectory: cwd,
            }).pipe(Effect.exit);
            const controlEvents = yield* readLocalRunEvents(controlRunId, {
              rootDirectory: cwd,
            });
            assert.strictEqual(interrupted._tag, "Failure");
            assert.strictEqual(controlResumeCalls, 0);
            assert.notInclude(
              controlEvents.events.map(({ type }) => type),
              "RUN_FAILED"
            );
          }

          const stickySpec = `${cwd}/sticky-control.md`;
          yield* fs.writeFileString(
            stickySpec,
            "# Sticky control ambiguity\n\nPreserve an indeterminate control outcome.\n"
          );
          let stickyRunId: RunId | undefined;
          let stickyProviderActions = 0;
          const stickyHarnessReady = yield* Deferred.make<{
            readonly control: typeof RunControlEventPayload.Type;
            readonly paths: RunPaths;
          }>();
          const releaseStickyHarness = yield* Deferred.make<void>();
          const stickyFiber = yield* runSpecFile(stickySpec, {
            rootDirectory: cwd,
            workerHarness: {
              name: parseHarnessName("sticky-control-harness"),
              run: (request) =>
                Effect.gen(function* () {
                  stickyRunId = request.runId;
                  const stickyPaths = yield* makeRunPaths(request.runId, {
                    rootDirectory: cwd,
                  });
                  const workerStarted = (yield* readEvents(
                    stickyPaths
                  )).findLast(({ type }) => type === "WORKER_STARTED");
                  assert.isDefined(workerStarted);
                  const stickySessionId = parseHarnessSessionId(
                    `session-${request.runId}`
                  );
                  yield* appendHarnessSessionEvent(request.runId, stickyPaths, {
                    capabilities: syntheticCapabilities,
                    kind: "sessionStarted",
                    provider: provider.descriptor,
                    sessionId: stickySessionId,
                    state: "running",
                  });
                  yield* appendHarnessSessionEvent(request.runId, stickyPaths, {
                    kind: "turnStarted",
                    sessionId: stickySessionId,
                    turnId: parseHarnessTurnId(`turn-${request.runId}`),
                  });
                  const beforeControl = yield* readEvents(stickyPaths);
                  const stickyControl = parseRunControlEventPayload({
                    actionBindingDigest: "c".repeat(64),
                    actionId: `action-${request.runId}`,
                    authorityId: "local-gaia-server",
                    expectedEventSequence: beforeControl.at(-1)!.sequence,
                    operation: "pause",
                    providerId: provider.descriptor.providerId,
                    restoreState: "runningWorker",
                    sessionId: stickySessionId,
                    workerAgentId: issueDeliveryAgentIds.worker,
                    workerStartedSequence: workerStarted!.sequence,
                  });
                  yield* Deferred.succeed(stickyHarnessReady, {
                    control: stickyControl,
                    paths: stickyPaths,
                  });
                  yield* Deferred.await(releaseStickyHarness);
                  stickyProviderActions += 1;
                  return yield* Effect.fail(
                    new GaiaRuntimeError({
                      code: "HarnessSessionFailed",
                      message:
                        "Provider acknowledgement was lost after dispatch.",
                      recoverable: true,
                    })
                  );
                }).pipe(
                  Effect.mapError((cause) =>
                    cause instanceof GaiaRuntimeError
                      ? cause
                      : new GaiaRuntimeError({
                          cause,
                          code: "HarnessSessionFailed",
                          message:
                            "The synthetic sticky-control harness failed.",
                          recoverable: true,
                        })
                  )
                ),
            },
          }).pipe(Effect.exit, Effect.forkChild);
          const stickyPrepared = yield* Deferred.await(stickyHarnessReady);
          yield* withRunEventSerialization(
            stickyPrepared.paths,
            Effect.gen(function* () {
              yield* Deferred.succeed(releaseStickyHarness, undefined);
              for (let attempt = 0; attempt < 100; attempt += 1) {
                yield* Effect.yieldNow;
              }
              assert.strictEqual(stickyFiber.pollUnsafe(), undefined);
              for (const type of [
                "RUN_CONTROL_INTENT_RECORDED",
                "RUN_CONTROL_ATTEMPTED",
                "RUN_CONTROL_OUTCOME_UNKNOWN",
              ] as const) {
                yield* appendEventWithinSerialization(
                  stickyPrepared.paths.runId,
                  stickyPrepared.paths,
                  {
                    payload: {
                      control: Schema.encodeSync(RunControlEventPayload)(
                        stickyPrepared.control
                      ),
                    },
                    type,
                  }
                );
              }
            })
          );
          const sticky = yield* Fiber.join(stickyFiber);
          assert.strictEqual(sticky._tag, "Failure");
          assert.isDefined(stickyRunId);
          const stickyEvents = yield* readLocalRunEvents(stickyRunId!, {
            rootDirectory: cwd,
          });
          assert.strictEqual(stickyProviderActions, 1);
          assert.notInclude(
            stickyEvents.events.map(({ type }) => type),
            "RUN_FAILED"
          );
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
          yield* prepareAcceptedInteractiveRun(
            accepted.runId,
            paths,
            "Completed worker crash window",
            "Continue downstream after worker completion persistence."
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
          if ("kind" in result)
            assert.fail("Expected a completed interactive harness result.");
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

const SyntheticProviderCountersSchema = Schema.Struct({
  detect: Schema.mutableKey(Schema.Number),
  resume: Schema.mutableKey(Schema.Number),
  start: Schema.mutableKey(Schema.Number),
});

function prepareAcceptedInteractiveRun(
  runId: RunId,
  paths: RunPaths,
  title: string,
  description: string
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      paths.workspaceOutput,
      `synthetic interactive completion ${runId}\n`
    );
    yield* deriveAndRecordRunContract({
      paths,
      runId,
      spec: parseMarkdownSpec(description, title),
    });
    yield* appendEvent(runId, paths, {
      payload: { workspacePath: "workspace" },
      type: "WORKSPACE_PREPARED",
    });
    const content = makeModelContextContentV1({
      acceptedOutcomes: [],
      authority: ["Synthetic accepted worker authority."],
      budget: { maxOutputBytes: 16_384, maxTurns: 1 },
      contentRefs: [],
      episodeRole: "workerInitial",
      instructions: ["Complete the accepted synthetic worker turn."],
      nonGoals: [],
      outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
      planningFacts: [`Accepted task title: ${title}`],
      safeExclusions: ["credentials", "ambient environment"],
      skills: [],
      stops: [],
      taskInput: description,
      verificationCommands: [],
    });
    const rendered = renderModelInputV1(content);
    const workspaceBinding = yield* deriveModelWorkspaceBinding(paths);
    const contract = yield* loadRunContract(paths, runId);
    const context = makeModelContextManifestV1({
      authoritativeRefs: [
        { digest: contract.contractDigest, kind: "runContract" },
      ],
      binding: { episodeKey: "workerInitial", runId },
      content,
      workspaceBinding,
    });
    const invocation = makeModelInvocationManifestV1({
      acceptedProviderCapabilityObservation: "unobservable",
      adapterInputClass: "codexAppTurn",
      adapterSemantics: {
        kind: "codexAppServer",
        semanticDigest: "a".repeat(64),
      },
      authorityRef: { digest: "b".repeat(64), kind: "authority" },
      binding: context.payload.binding,
      budget: content.payload.budget,
      context,
      outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
      rendered,
      runContractRef: {
        digest: contract.contractDigest,
        kind: "runContract",
      },
      template: { id: "gaia.worker-input.v1", version: 1 },
      workspaceBinding,
    });
    const episode = yield* commitModelInvocationPair({
      context,
      episodeKey: "workerInitial",
      invocation,
      paths,
    });
    yield* appendEvent(runId, paths, {
      payload: {
        modelInvocationEpisode: Schema.encodeSync(
          ModelInvocationEpisodeStartV1
        )(episode),
      },
      type: "WORKER_STARTED",
    });
    return { rendered, workspaceBinding };
  });
}

function syntheticProvider(
  counters: typeof SyntheticProviderCountersSchema.Type,
  isAvailable: () => boolean = () => true,
  rootDirectory?: string
): HarnessProvider {
  const descriptor = HarnessProviderDescriptor.make({
    displayName: "Synthetic Interactive Provider",
    executionModes: ["local"],
    providerId: parseHarnessProviderId("synthetic-interactive"),
  });
  return {
    createSession: (request) =>
      Effect.gen(function* () {
        counters.start += 1;
        if (rootDirectory !== undefined) {
          const runId = request.sessionId.slice("session-".length);
          const workspace = `${rootDirectory}/.gaia/runs/${runId}/workspace`;
          yield* Effect.promise(async () => {
            await mkdir(workspace, { recursive: true });
            await writeFile(
              `${workspace}/output.txt`,
              `synthetic interactive completion ${runId}\n`,
              "utf8"
            );
          });
        }
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
    send: () => Effect.succeed(undefined),
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
    send: () => Effect.succeed(undefined),
    snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
    steer: Option.none(),
  };
}

type RecoveredCodexTurn = NonNullable<CodexThread["turns"]>[number];

function runtimeThreadResult(threadId: CodexThreadId) {
  return {
    approvalPolicy: "on-request" as const,
    cwd: "/workspace/project",
    model: "gpt-5.6-codex",
    modelProvider: "openai",
    reasoningEffort: "high" as const,
    sandbox: { type: "workspaceWrite" as const },
    thread: { id: threadId },
  };
}

function recordingCodexClient(input: {
  readonly onSubscribed?: () => void;
  readonly recoveredTurns: ReadonlyArray<RecoveredCodexTurn>;
  readonly startTurnId: CodexTurnId;
  readonly threadId: CodexThreadId;
}) {
  const interrupts: Array<unknown> = [];
  const notifications = new Set<(notification: CodexNotification) => void>();
  const threadStarts: Array<unknown> = [];
  const turnStarts: Array<unknown> = [];
  const client = {
    initialize: () =>
      Effect.succeed({
        codexHome: "/tmp/codex-home",
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
    resumeThread: () => Effect.succeed(runtimeThreadResult(input.threadId)),
    startThread: (params) =>
      Effect.sync(() => {
        threadStarts.push(params);
        return runtimeThreadResult(input.threadId);
      }),
    startTurn: (params) =>
      Effect.sync(() => {
        turnStarts.push(params);
        return {
          turn: { id: input.startTurnId, status: "inProgress" as const },
        };
      }),
    steerTurn: () => Effect.succeed({ turnId: input.startTurnId }),
  } satisfies CodexAppServerClient;
  return { client, interrupts, notifications, threadStarts, turnStarts };
}
