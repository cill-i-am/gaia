import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { NodeServices } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import {
  HarnessCapabilities,
  HarnessExecutionSelection,
  HarnessProviderDescriptor,
  HarnessSessionSnapshot,
  RunControlEventPayload,
  RunControlCheckpointDigestSchema,
  RunControlRequestDigestSchema,
  RunHumanWaitCheckpointV1,
  makeRunControlActionBindingDigest,
  makeRunControlCheckpointDigest,
  makeRunControlRequestDigest,
  parseHarnessActionId,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessProviderId,
  parseHarnessProfileId,
  parseHarnessQuestionId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseRunControlAction,
  parseRunControlActionId,
  parseRunControlAuthorityId,
  parseRunId,
  ResolvedHarnessExecution,
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
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";

import {
  dispatchAgentSessionAction,
  makeLiveHarnessSessionCoordinator,
} from "./agent-session-runtime.js";
import {
  appendEvent,
  appendHarnessSessionEvent,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import {
  HarnessActionError,
  type HarnessProvider,
  type HarnessSession,
} from "./harness-session.js";
import { makeRunPaths } from "./paths.js";
import {
  dispatchRunControlAction,
  readRunControlSnapshot,
  reconcileRunControlExpiry,
} from "./run-control-runtime.js";
import { withRunStoreLock } from "./run-store-lock.js";

const runId = parseRunId("run-Gaia148rt1");
const workerAgentId = issueDeliveryAgentIds.worker;
const sessionId = parseHarnessSessionId(`session-${runId}`);
const turnId = parseHarnessTurnId("turn-control");
const interactionId = parseHarnessInteractionId("interaction-control-secret");
const questionId = parseHarnessQuestionId("question-control-secret");
const provider = HarnessProviderDescriptor.make({
  displayName: "Synthetic",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("private-provider"),
});
const capabilities = HarnessCapabilities.make({
  approvals: ["userInput"],
  durableCancellation: true,
  durableInteractionResolution: true,
  durablePause: true,
  fileChangeEvents: false,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: true,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: true,
});
const legacyCapabilities = HarnessCapabilities.make({
  approvals: ["userInput"],
  fileChangeEvents: false,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: true,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: true,
});
const execFile = promisify(nodeExecFile);
const contentionTestName =
  "claims one durable hidden response and rejects every replay before the provider";
const contentionInputEnvironment = "GAIA_RUN_CONTROL_CONTENTION_INPUT";

describe("durable run control", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "rejects genuine and substituted hidden-response replays without redispatch",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const rootDirectory = yield* fs.makeTempDirectory({
              prefix: "gaia-run-control-privacy-",
            });
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            yield* fs.makeDirectory(paths.root, { recursive: true });
            yield* appendEvent(runId, paths, {
              payload: { specPath: "spec.md" },
              type: "RUN_CREATED",
            });
            yield* appendHarnessSessionEvent(runId, paths, {
              capabilities,
              kind: "sessionStarted",
              provider,
              sessionId,
              state: "running",
            });
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            yield* appendHarnessSessionEvent(runId, paths, {
              interaction: {
                interactionId,
                itemId: parseHarnessItemId("item-control-secret"),
                kind: "userInput",
                questions: [
                  { options: [], prompt: "Token?", questionId, secret: true },
                ],
                requestedAt: "2026-07-22T00:00:00.000Z",
                turnId,
              },
              kind: "interactionRequested",
              sessionId,
            });

            const resolutions: unknown[] = [];
            const coordinator = makeLiveHarnessSessionCoordinator();
            yield* coordinator.register({
              agentId: workerAgentId,
              runId,
              session: fakeSession(resolutions),
              sessionId,
            });
            const action = {
              actionId: parseHarnessActionId("action-control-secret"),
              answers: [{ answers: ["FIRST_SECRET"], questionId }],
              interactionId,
              kind: "userInput" as const,
              sessionId,
            };
            yield* dispatchAgentSessionAction({
              action,
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });

            const genuine = yield* dispatchAgentSessionAction({
              action,
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.exit);
            const substituted = yield* dispatchAgentSessionAction({
              action: {
                ...action,
                answers: [{ answers: ["SUBSTITUTED_SECRET"], questionId }],
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.exit);

            expect(genuine._tag).toBe("Failure");
            expect(substituted._tag).toBe("Failure");
            expect(resolutions).toHaveLength(1);
          })
        )
    );

    it.effect(contentionTestName, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const resolutions: unknown[] = [];
          const provider: HarnessProvider = {
            createSession: () => Effect.succeed(fakeSession(resolutions)),
            descriptor: HarnessProviderDescriptor.make({
              displayName: "Durable Synthetic",
              executionModes: ["local"],
              providerId: parseHarnessProviderId("durable-private"),
            }),
            detect: Effect.succeed({
              auth: { state: "notRequired" },
              capabilities,
              state: "available",
              version: "test-1",
            }),
            resumeSession: () => Effect.succeed(fakeSession(resolutions)),
          };
          const selection = HarnessExecutionSelection.make({
            harnessProfileId: parseHarnessProfileId("codexAppServer"),
          });
          const registry = makeHarnessProviderRegistry([
            { profileId: selection.harnessProfileId, provider },
          ]);
          const resolved = yield* registry.resolve(selection, []);
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-run-control-durable-",
          });
          const paths = yield* makeRunPaths(runId, { rootDirectory });
          yield* fs.makeDirectory(paths.workspace, { recursive: true });
          yield* appendEvent(runId, paths, {
            payload: {
              execution: {
                resolved: Schema.encodeSync(ResolvedHarnessExecution)(
                  resolved.execution
                ),
                selection: Schema.encodeSync(HarnessExecutionSelection)(
                  selection
                ),
              },
              specPath: "spec.md",
            },
            type: "RUN_CREATED",
          });
          yield* appendEvent(runId, paths, {
            payload: { workspacePath: "." },
            type: "WORKSPACE_PREPARED",
          });
          yield* appendEvent(runId, paths, { type: "WORKER_STARTED" });
          yield* appendHarnessSessionEvent(runId, paths, {
            capabilities,
            kind: "sessionStarted",
            provider: provider.descriptor,
            sessionId,
            state: "running",
          });
          yield* appendHarnessSessionEvent(runId, paths, {
            kind: "turnStarted",
            sessionId,
            turnId,
          });
          const durableInteraction = {
            interactionId,
            itemId: parseHarnessItemId("item-control-durable"),
            kind: "userInput" as const,
            questions: [
              { options: [], prompt: "Token?", questionId, secret: true },
            ],
            requestedAt: "2026-07-22T00:00:00.000Z",
            turnId,
          };
          yield* appendHarnessSessionEvent(runId, paths, {
            interaction: durableInteraction,
            kind: "interactionRequested",
            sessionId,
          });
          const checkpointWithPlaceholder = Schema.decodeUnknownSync(
            RunHumanWaitCheckpointV1
          )({
            checkpointDigest: "a".repeat(64),
            environmentReceipt: {
              byteLength: 512,
              path: `harness-environment/receipt-${"b".repeat(64)}.json`,
              receiptDigest: "b".repeat(64),
              runId,
              structuralDigest: "c".repeat(64),
              version: 1 as const,
            },
            expectedEventSequence: 7,
            interactionId,
            providerId: provider.descriptor.providerId,
            requestDigest: makeRunControlRequestDigest(durableInteraction),
            requestedAt: "2026-07-22T00:00:00.000Z",
            resolverAuthorityId: parseRunControlAuthorityId("authority-local"),
            runId,
            sessionId,
            version: 1 as const,
            workerAgentId,
            workerStartedSequence: 3,
          });
          const { checkpointDigest: _checkpointDigest, ...checkpointInput } =
            checkpointWithPlaceholder;
          const checkpoint = RunHumanWaitCheckpointV1.make({
            ...checkpointInput,
            checkpointDigest: makeRunControlCheckpointDigest(checkpointInput),
          });
          yield* appendEvent(runId, paths, {
            payload: {
              checkpoint: Schema.encodeSync(RunHumanWaitCheckpointV1)(
                checkpoint
              ),
            },
            type: "RUN_WAITING_FOR_HUMAN",
          });
          expect(
            Reflect.get(
              yield* readRunControlSnapshot(runId, { rootDirectory }),
              "actionTarget"
            )
          ).toMatchObject({
            authorityId: checkpoint.resolverAuthorityId,
            expectedEventSequence: checkpoint.expectedEventSequence,
            providerId: checkpoint.providerId,
            sessionId: checkpoint.sessionId,
            workerAgentId,
            workerStartedSequence: checkpoint.workerStartedSequence,
          });

          const action = parseRunControlAction({
            actionId: parseRunControlActionId("action-durable-secret"),
            authorityId: checkpoint.resolverAuthorityId,
            checkpointDigest: checkpoint.checkpointDigest,
            expectedEventSequence: checkpoint.expectedEventSequence,
            interactionId,
            operation: "resolveInteraction",
            providerId: checkpoint.providerId,
            requestDigest: checkpoint.requestDigest,
            response: {
              answers: [{ answers: ["FIRST_DURABLE_SECRET"], questionId }],
              kind: "userInput",
            },
            runId,
            sessionId,
            workerAgentId,
            workerStartedSequence: checkpoint.workerStartedSequence,
          });
          const wrongAuthority = yield* dispatchRunControlAction({
            action: parseRunControlAction({
              ...action,
              actionId: parseRunControlActionId(
                "action-durable-wrong-authority"
              ),
              authorityId: parseRunControlAuthorityId("authority-other"),
            }),
            options: { harnessProviderRegistry: registry, rootDirectory },
            runId,
          }).pipe(Effect.flip);
          const staleEpoch = yield* dispatchRunControlAction({
            action: parseRunControlAction({
              ...action,
              actionId: parseRunControlActionId("action-durable-stale-epoch"),
              workerStartedSequence: checkpoint.workerStartedSequence + 1,
            }),
            options: { harnessProviderRegistry: registry, rootDirectory },
            runId,
          }).pipe(Effect.flip);
          const wrongWorker = yield* dispatchRunControlAction({
            action: parseRunControlAction({
              ...action,
              actionId: parseRunControlActionId("action-durable-wrong-worker"),
              workerAgentId: "agent-reviewer",
            }),
            options: { harnessProviderRegistry: registry, rootDirectory },
            runId,
          }).pipe(Effect.flip);
          const eventCountBeforeIncompatibleResponses = (yield* readEvents(
            paths
          )).length;
          const incompatibleKind = yield* dispatchRunControlAction({
            action: parseRunControlAction({
              ...action,
              actionId: parseRunControlActionId(
                "action-durable-incompatible-kind"
              ),
              response: { decision: "approve", kind: "approval" },
            }),
            options: { harnessProviderRegistry: registry, rootDirectory },
            runId,
          }).pipe(Effect.flip);
          const incompatibleQuestions = yield* dispatchRunControlAction({
            action: parseRunControlAction({
              ...action,
              actionId: parseRunControlActionId(
                "action-durable-incompatible-questions"
              ),
              response: {
                answers: [
                  {
                    answers: ["INCOMPATIBLE_SECRET"],
                    questionId: parseHarnessQuestionId(
                      "question-control-unexpected"
                    ),
                  },
                ],
                kind: "userInput",
              },
            }),
            options: { harnessProviderRegistry: registry, rootDirectory },
            runId,
          }).pipe(Effect.flip);
          expect(wrongAuthority).toMatchObject({ code: "wrongAuthority" });
          expect(staleEpoch).toMatchObject({ code: "stale" });
          expect(wrongWorker).toMatchObject({ code: "stale" });
          expect(incompatibleKind).toMatchObject({ code: "stale" });
          expect(incompatibleQuestions).toMatchObject({ code: "stale" });
          expect(resolutions).toHaveLength(0);
          expect(yield* readEvents(paths)).toHaveLength(
            eventCountBeforeIncompatibleResponses
          );

          const markerDirectory = `${rootDirectory}/provider-calls`;
          yield* fs.makeDirectory(markerDirectory, { recursive: true });
          const childInput = JSON.stringify({
            action,
            markerDirectory,
            rootDirectory,
          });
          const childProcess = execFile(
            process.execPath,
            [
              `${process.cwd()}/../../node_modules/.pnpm/node_modules/tsx/dist/cli.mjs`,
              "--input-type=module",
              "--eval",
              contentionChildScript(),
            ],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                [contentionInputEnvironment]: childInput,
              },
              maxBuffer: 4 * 1024 * 1024,
            }
          );
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 3000;
            while (
              !(await readdir(markerDirectory)).includes("ready-child") &&
              Date.now() < deadline
            )
              await waitForContentionPoll();
            if (!(await readdir(markerDirectory)).includes("ready-child")) {
              throw new Error("Child contention process did not become ready.");
            }
            await writeFile(`${markerDirectory}/go`, "go", "utf8");
          });
          const parentContentionProvider = contentionProvider(
            markerDirectory,
            "parent"
          );
          const parentContentionRegistry = makeHarnessProviderRegistry([
            {
              profileId: selection.harnessProfileId,
              provider: parentContentionProvider,
            },
          ]);
          yield* Effect.all(
            [
              dispatchRunControlAction({
                action,
                options: {
                  harnessProviderRegistry: parentContentionRegistry,
                  rootDirectory,
                },
                runId,
              }).pipe(Effect.exit),
              Effect.promise(() => childProcess),
            ],
            { concurrency: "unbounded" }
          );
          expect(
            (yield* fs.readDirectory(markerDirectory)).filter((entry) =>
              ["child", "parent"].includes(entry)
            )
          ).toHaveLength(1);
          const contentionEvents = yield* readEvents(paths);
          expect(
            contentionEvents.filter(
              ({ type }) => type === "RUN_CONTROL_INTENT_RECORDED"
            )
          ).toHaveLength(1);
          expect(
            contentionEvents.filter(
              ({ type }) => type === "RUN_CONTROL_ATTEMPTED"
            )
          ).toHaveLength(1);
          expect(
            contentionEvents.filter(
              ({ type }) => type === "RUN_CONTROL_CONFIRMED"
            )
          ).toHaveLength(1);
          const genuine = yield* dispatchRunControlAction({
            action,
            options: { harnessProviderRegistry: registry, rootDirectory },
            runId,
          }).pipe(Effect.flip);
          const substituted = yield* dispatchRunControlAction({
            action: parseRunControlAction({
              ...action,
              response: {
                answers: [
                  { answers: ["SUBSTITUTED_DURABLE_SECRET"], questionId },
                ],
                kind: "userInput",
              },
            }),
            options: { harnessProviderRegistry: registry, rootDirectory },
            runId,
          }).pipe(Effect.flip);
          const changedStructure = yield* dispatchRunControlAction({
            action: parseRunControlAction({
              ...action,
              response: {
                answers: [
                  {
                    answers: [
                      "CHANGED_STRUCTURE_SECRET",
                      "SECOND_SECRET_VALUE",
                    ],
                    questionId,
                  },
                ],
                kind: "userInput",
              },
            }),
            options: { harnessProviderRegistry: registry, rootDirectory },
            runId,
          }).pipe(Effect.flip);
          const alternateAction = yield* dispatchRunControlAction({
            action: parseRunControlAction({
              ...action,
              actionId: parseRunControlActionId(
                "action-durable-secret-alternate"
              ),
            }),
            options: { harnessProviderRegistry: registry, rootDirectory },
            runId,
          }).pipe(Effect.flip);

          expect(genuine).toMatchObject({
            code: "resolutionReplayNotComparable",
          });
          expect(substituted).toMatchObject({
            code: "resolutionReplayNotComparable",
          });
          expect(changedStructure).toMatchObject({
            code: "resolutionReplayNotComparable",
          });
          expect(alternateAction).toMatchObject({
            code: "resolutionAlreadyClaimed",
          });
          expect(resolutions).toHaveLength(0);
          const persisted = yield* fs.readFileString(paths.events);
          expect(persisted).not.toContain("FIRST_DURABLE_SECRET");
          expect(persisted).not.toContain("SUBSTITUTED_DURABLE_SECRET");
          expect(persisted).not.toContain("CHANGED_STRUCTURE_SECRET");
          expect(persisted).not.toContain("SECOND_SECRET_VALUE");
          expect(persisted).not.toContain("INCOMPATIBLE_SECRET");
          expect(persisted).not.toContain('"answerShape"');
          expect(persisted).not.toContain('"answerCount"');
          expect(persisted).not.toContain('"contentProvided"');
          expect(persisted).not.toContain('"responsePresent"');
        })
      )
    );

    it.effect(
      "records an unsupported operation as a value-free failure without attempting the provider",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-run-control-unsupported-",
          });
          const paths = yield* makeRunPaths(runId, { rootDirectory });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* appendEvent(runId, paths, {
            payload: { specPath: "spec.md" },
            type: "RUN_CREATED",
          });
          yield* appendEvent(runId, paths, {
            payload: { workspacePath: "." },
            type: "WORKSPACE_PREPARED",
          });
          yield* appendEvent(runId, paths, { type: "WORKER_STARTED" });
          yield* appendHarnessSessionEvent(runId, paths, {
            capabilities: legacyCapabilities,
            kind: "sessionStarted",
            provider,
            sessionId,
            state: "running",
          });
          const snapshot = yield* readRunControlSnapshot(runId, {
            rootDirectory,
          });
          const action = parseRunControlAction({
            ...snapshot.actionTarget,
            actionId: parseRunControlActionId("action-unsupported-pause"),
            operation: "pause",
            runId,
          });

          const error = yield* dispatchRunControlAction({
            action,
            options: { rootDirectory },
            runId,
          }).pipe(Effect.flip);
          const events = yield* readEvents(paths);

          expect(error).toMatchObject({ code: "unsupportedProviderOperation" });
          expect(events.map(({ type }) => type)).toEqual([
            "RUN_CREATED",
            "WORKSPACE_PREPARED",
            "WORKER_STARTED",
            "HARNESS_SESSION_EVENT_RECORDED",
            "RUN_CONTROL_INTENT_RECORDED",
            "RUN_CONTROL_FAILED",
          ]);
          expect(JSON.stringify(events.at(-1)?.payload)).not.toContain(
            "userInput"
          );

          const live = yield* setupRunningControlRun(
            capabilities,
            "gaia-run-control-missing-live-handle-"
          );
          const liveSnapshot = yield* readRunControlSnapshot(runId, {
            rootDirectory: live.rootDirectory,
          });
          const missingLiveHandle = yield* dispatchRunControlAction({
            action: parseRunControlAction({
              ...liveSnapshot.actionTarget,
              actionId: parseRunControlActionId(
                "action-pause-missing-live-handle"
              ),
              operation: "pause",
              runId,
            }),
            options: { rootDirectory: live.rootDirectory },
            runId,
          }).pipe(Effect.flip);
          const liveEvents = yield* readEvents(live.paths);

          expect(missingLiveHandle).toMatchObject({
            code: "unsupportedProviderOperation",
          });
          expect(liveEvents.map(({ type }) => type)).toContain(
            "RUN_CONTROL_INTENT_RECORDED"
          );
          expect(liveEvents.map(({ type }) => type)).toContain(
            "RUN_CONTROL_FAILED"
          );
          expect(liveEvents.map(({ type }) => type)).not.toContain(
            "RUN_CONTROL_ATTEMPTED"
          );

          const waiting = yield* setupWaitingControlRun(
            legacyCapabilities,
            "gaia-run-control-unsupported-resolution-"
          );
          const waitingSnapshot = yield* readRunControlSnapshot(runId, {
            rootDirectory: waiting.rootDirectory,
          });
          const resolutionAction = parseRunControlAction({
            ...waitingSnapshot.actionTarget,
            actionId: parseRunControlActionId("action-unsupported-resolution"),
            operation: "resolveInteraction",
            response: {
              answers: [{ answers: ["UNSUPPORTED_SECRET"], questionId }],
              kind: "userInput",
            },
            runId,
          });
          const firstUnsupportedResolution = yield* dispatchRunControlAction({
            action: resolutionAction,
            options: { rootDirectory: waiting.rootDirectory },
            runId,
          }).pipe(Effect.flip);
          const repeatedUnsupportedResolution = yield* dispatchRunControlAction(
            {
              action: resolutionAction,
              options: { rootDirectory: waiting.rootDirectory },
              runId,
            }
          ).pipe(Effect.flip);
          const alternateUnsupportedResolution =
            yield* dispatchRunControlAction({
              action: parseRunControlAction({
                ...resolutionAction,
                actionId: parseRunControlActionId(
                  "action-unsupported-resolution-alternate"
                ),
              }),
              options: { rootDirectory: waiting.rootDirectory },
              runId,
            }).pipe(Effect.flip);
          const waitingEvents = yield* readEvents(waiting.paths);

          expect(firstUnsupportedResolution).toMatchObject({
            code: "unsupportedProviderOperation",
          });
          expect(repeatedUnsupportedResolution).toMatchObject({
            code: "unsupportedProviderOperation",
          });
          expect(alternateUnsupportedResolution).toMatchObject({
            code: "unsupportedProviderOperation",
          });
          expect(JSON.stringify(waitingEvents)).not.toContain(
            "resolutionClaimed"
          );
          expect(JSON.stringify(waitingEvents)).not.toContain(
            "UNSUPPORTED_SECRET"
          );
        })
    );

    it.effect(
      "rejects wrong authority for running and paused control before dispatch",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { paths, rootDirectory } = yield* setupRunningControlRun(
              capabilities,
              "gaia-run-control-wrong-authority-"
            );
            let interruptCount = 0;
            const coordinator = makeLiveHarnessSessionCoordinator();
            yield* coordinator.register({
              agentId: workerAgentId,
              runId,
              session: {
                ...fakeSession([]),
                interrupt: Option.some(
                  Effect.sync(() => {
                    interruptCount += 1;
                  })
                ),
              },
              sessionId,
            });
            const running = yield* readRunControlSnapshot(runId, {
              rootDirectory,
            });
            const initialEventCount = (yield* readEvents(paths)).length;

            for (const operation of ["pause", "cancel"] as const) {
              const error = yield* dispatchRunControlAction({
                action: parseRunControlAction({
                  ...running.actionTarget,
                  actionId: parseRunControlActionId(
                    `action-wrong-authority-${operation}`
                  ),
                  authorityId: parseRunControlAuthorityId(
                    "authority-substituted"
                  ),
                  operation,
                  runId,
                }),
                options: { rootDirectory, sessionCoordinator: coordinator },
                runId,
              }).pipe(Effect.flip);
              expect(error).toMatchObject({ code: "wrongAuthority" });
            }
            expect(yield* readEvents(paths)).toHaveLength(initialEventCount);
            expect(interruptCount).toBe(0);

            yield* dispatchRunControlAction({
              action: parseRunControlAction({
                ...running.actionTarget,
                actionId: parseRunControlActionId("action-authorized-pause"),
                operation: "pause",
                runId,
              }),
              options: { rootDirectory, sessionCoordinator: coordinator },
              runId,
            });
            const paused = yield* readRunControlSnapshot(runId, {
              rootDirectory,
            });
            const pausedEventCount = (yield* readEvents(paths)).length;
            const resumeError = yield* dispatchRunControlAction({
              action: parseRunControlAction({
                ...paused.actionTarget,
                actionId: parseRunControlActionId(
                  "action-wrong-authority-resume"
                ),
                authorityId: parseRunControlAuthorityId(
                  "authority-substituted"
                ),
                operation: "resume",
                runId,
              }),
              options: { rootDirectory, sessionCoordinator: coordinator },
              runId,
            }).pipe(Effect.flip);

            expect(resumeError).toMatchObject({ code: "wrongAuthority" });
            expect(yield* readEvents(paths)).toHaveLength(pausedEventCount);
            expect(interruptCount).toBe(1);
          })
        )
    );

    it.effect(
      "pins live control to its lease and terminalizes before worker completion",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { paths, rootDirectory } = yield* setupRunningControlRun(
              capabilities,
              "gaia-run-control-cancel-"
            );
            const actionStarted = yield* Deferred.make<void>();
            const finishAction = yield* Deferred.make<void>();
            const ownerRegistered = yield* Deferred.make<void>();
            const closeOwner = yield* Deferred.make<void>();
            const ownerClosing = yield* Deferred.make<void>();
            const serializationHeld = yield* Deferred.make<void>();
            const releaseSerialization = yield* Deferred.make<void>();
            const coordinator = makeLiveHarnessSessionCoordinator();
            const markerDirectory = `${rootDirectory}/provider-calls`;
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(markerDirectory, { recursive: true });
            const ownerFiber = yield* withRunStoreLock(
              { rootDirectory },
              Effect.scoped(
                Effect.gen(function* () {
                  yield* coordinator.register({
                    agentId: workerAgentId,
                    runId,
                    session: {
                      ...fakeSession([]),
                      interrupt: Option.some(
                        Effect.gen(function* () {
                          yield* Effect.promise(() =>
                            writeFile(
                              `${markerDirectory}/parent`,
                              "called",
                              "utf8"
                            )
                          );
                          yield* Deferred.succeed(actionStarted, undefined);
                          yield* Deferred.await(finishAction);
                        })
                      ),
                    },
                    sessionId,
                  });
                  yield* Effect.addFinalizer(() =>
                    Deferred.succeed(ownerClosing, undefined)
                  );
                  yield* Deferred.succeed(ownerRegistered, undefined);
                  yield* Deferred.await(closeOwner);
                })
              ),
              {
                nextSafeAction:
                  "Wait for the live cancellation action to complete.",
                operation: "Gaia live cancellation owner",
              }
            ).pipe(Effect.forkChild);
            yield* Deferred.await(ownerRegistered);
            const snapshot = yield* readRunControlSnapshot(runId, {
              rootDirectory,
            });
            const action = parseRunControlAction({
              ...snapshot.actionTarget,
              actionId: parseRunControlActionId("action-cancel-once"),
              operation: "cancel",
              runId,
            });

            const serializationFiber = yield* withRunEventSerialization(
              paths,
              Deferred.succeed(serializationHeld, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSerialization))
              )
            ).pipe(Effect.forkChild);
            yield* Deferred.await(serializationHeld);
            const firstFiber = yield* dispatchRunControlAction({
              action,
              options: { rootDirectory, sessionCoordinator: coordinator },
              runId,
            }).pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            yield* Deferred.succeed(closeOwner, undefined);
            yield* Deferred.await(ownerClosing);

            const childInput = JSON.stringify({
              action,
              markerDirectory,
              rootDirectory,
            });
            yield* fs.writeFileString(`${markerDirectory}/go`, "go");
            yield* Effect.promise(() =>
              execFile(
                process.execPath,
                [
                  `${process.cwd()}/../../node_modules/.pnpm/node_modules/tsx/dist/cli.mjs`,
                  "--input-type=module",
                  "--eval",
                  contentionChildScript(),
                ],
                {
                  cwd: process.cwd(),
                  env: {
                    ...process.env,
                    [contentionInputEnvironment]: childInput,
                  },
                  maxBuffer: 4 * 1024 * 1024,
                }
              )
            );
            const markersWhileParentBlocked =
              yield* fs.readDirectory(markerDirectory);
            expect(ownerFiber.pollUnsafe()).toBeUndefined();
            expect(markersWhileParentBlocked).not.toContain("child");

            yield* Deferred.succeed(releaseSerialization, undefined);
            yield* Fiber.join(serializationFiber);
            yield* Deferred.await(actionStarted);
            yield* Deferred.succeed(finishAction, undefined);
            const first = yield* Fiber.join(firstFiber);
            yield* Fiber.join(ownerFiber);
            const duplicate = yield* dispatchRunControlAction({
              action,
              options: { rootDirectory },
              runId,
            });
            const events = yield* readEvents(paths);
            const cancelled = yield* readRunControlSnapshot(runId, {
              rootDirectory,
            });

            expect(first).toMatchObject({
              duplicate: false,
              state: "confirmed",
            });
            expect(duplicate).toMatchObject({
              duplicate: true,
              state: "confirmed",
            });
            expect(
              (yield* fs.readDirectory(markerDirectory)).filter((entry) =>
                ["child", "parent"].includes(entry)
              )
            ).toEqual(["parent"]);
            expect(
              events.filter(
                ({ type }) => type === "RUN_CONTROL_INTENT_RECORDED"
              )
            ).toHaveLength(1);
            expect(
              events.filter(({ type }) => type === "RUN_CONTROL_ATTEMPTED")
            ).toHaveLength(1);
            expect(
              events.filter(({ type }) => type === "RUN_CONTROL_CONFIRMED")
            ).toHaveLength(1);
            expect(cancelled).toMatchObject({
              allowedActions: [],
              state: "cancelled",
            });

            const pauseRun = yield* setupRunningControlRun(
              capabilities,
              "gaia-run-control-pause-completion-race-"
            );
            const pauseCoordinator = makeLiveHarnessSessionCoordinator();
            const pauseProviderStarted = yield* Deferred.make<void>();
            const finishPauseProvider = yield* Deferred.make<void>();
            const pauseOwnerRegistered = yield* Deferred.make<void>();
            const closePauseOwner = yield* Deferred.make<void>();
            let pauseInterruptCount = 0;
            const pauseOwnerFiber = yield* withRunStoreLock(
              { rootDirectory: pauseRun.rootDirectory },
              Effect.scoped(
                Effect.gen(function* () {
                  yield* pauseCoordinator.register({
                    agentId: workerAgentId,
                    runId,
                    session: {
                      ...fakeSession([]),
                      interrupt: Option.some(
                        Effect.sync(() => {
                          pauseInterruptCount += 1;
                        }).pipe(
                          Effect.andThen(
                            Deferred.succeed(pauseProviderStarted, undefined)
                          ),
                          Effect.andThen(Deferred.await(finishPauseProvider))
                        )
                      ),
                    },
                    sessionId,
                  });
                  yield* Deferred.succeed(pauseOwnerRegistered, undefined);
                  yield* Deferred.await(closePauseOwner);
                })
              ),
              {
                nextSafeAction:
                  "Wait for the live pause action to terminalize.",
                operation: "Gaia live pause owner",
              }
            ).pipe(Effect.forkChild);
            yield* Deferred.await(pauseOwnerRegistered);
            const pauseSnapshot = yield* readRunControlSnapshot(runId, {
              rootDirectory: pauseRun.rootDirectory,
            });
            const pauseAction = parseRunControlAction({
              ...pauseSnapshot.actionTarget,
              actionId: parseRunControlActionId(
                "action-pause-before-completion"
              ),
              operation: "pause",
              runId,
            });
            const pauseFiber = yield* dispatchRunControlAction({
              action: pauseAction,
              options: {
                rootDirectory: pauseRun.rootDirectory,
                sessionCoordinator: pauseCoordinator,
              },
              runId,
            }).pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(pauseProviderStarted);
            const completionFiber = yield* appendEvent(runId, pauseRun.paths, {
              payload: { workerResultPath: "worker-result.json" },
              type: "WORKER_COMPLETED",
            }).pipe(Effect.exit, Effect.forkChild);
            yield* Effect.yieldNow;

            expect(completionFiber.pollUnsafe()).toBeUndefined();

            yield* Deferred.succeed(finishPauseProvider, undefined);
            const pauseExit = yield* Fiber.join(pauseFiber);
            const completionExit = yield* Fiber.join(completionFiber);
            yield* Deferred.succeed(closePauseOwner, undefined);
            yield* Fiber.join(pauseOwnerFiber);
            const pauseEvents = yield* readEvents(pauseRun.paths);

            expect(pauseExit).toMatchObject({
              _tag: "Success",
              value: { duplicate: false, state: "confirmed" },
            });
            expect(completionExit._tag).toBe("Success");
            expect(pauseInterruptCount).toBe(1);
            expect(
              pauseEvents
                .filter(({ type }) => type.startsWith("RUN_CONTROL_"))
                .map(({ type }) => type)
            ).toEqual([
              "RUN_CONTROL_INTENT_RECORDED",
              "RUN_CONTROL_ATTEMPTED",
              "RUN_CONTROL_CONFIRMED",
            ]);
            expect(pauseEvents.at(-1)?.type).toBe("WORKER_COMPLETED");
          })
        )
    );

    it.effect(
      "makes an ambiguous attempted action outcomeUnknown and never redispatches",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { paths, rootDirectory } = yield* setupRunningControlRun(
              capabilities,
              "gaia-run-control-unknown-"
            );
            let interruptCount = 0;
            const coordinator = makeLiveHarnessSessionCoordinator();
            yield* coordinator.register({
              agentId: workerAgentId,
              runId,
              session: {
                ...fakeSession([]),
                interrupt: Option.some(
                  Effect.sync(() => {
                    interruptCount += 1;
                  }).pipe(
                    Effect.flatMap(() =>
                      Effect.fail(
                        new HarnessActionError({
                          actionKind: "interrupt",
                          message: "Provider acknowledgement lost.",
                          providerId: provider.providerId,
                        })
                      )
                    )
                  )
                ),
              },
              sessionId,
            });
            const snapshot = yield* readRunControlSnapshot(runId, {
              rootDirectory,
            });
            const action = parseRunControlAction({
              ...snapshot.actionTarget,
              actionId: parseRunControlActionId("action-pause-unknown"),
              operation: "pause",
              runId,
            });

            const first = yield* dispatchRunControlAction({
              action,
              options: { rootDirectory, sessionCoordinator: coordinator },
              runId,
            }).pipe(Effect.flip);
            const replay = yield* dispatchRunControlAction({
              action,
              options: { rootDirectory, sessionCoordinator: coordinator },
              runId,
            }).pipe(Effect.flip);
            const afterUnknown = yield* readRunControlSnapshot(runId, {
              rootDirectory,
            });
            const fresh = yield* dispatchRunControlAction({
              action: parseRunControlAction({
                ...afterUnknown.actionTarget,
                actionId: parseRunControlActionId(
                  "action-pause-fresh-after-unknown"
                ),
                operation: "pause",
                runId,
              }),
              options: { rootDirectory, sessionCoordinator: coordinator },
              runId,
            }).pipe(Effect.flip);
            const events = yield* readEvents(paths);

            expect(first).toMatchObject({ code: "outcomeUnknown" });
            expect(replay).toMatchObject({ code: "outcomeUnknown" });
            expect(fresh).toMatchObject({ code: "outcomeUnknown" });
            expect(afterUnknown.allowedActions).toEqual([]);
            expect(interruptCount).toBe(1);
            expect(
              events.filter(
                ({ type }) => type === "RUN_CONTROL_OUTCOME_UNKNOWN"
              )
            ).toHaveLength(1);
            expect(events.map(({ type }) => type)).not.toContain("RUN_FAILED");

            const crashed = yield* setupRunningControlRun(
              capabilities,
              "gaia-run-control-attempted-crash-"
            );
            const beforeCrash = yield* readRunControlSnapshot(runId, {
              rootDirectory: crashed.rootDirectory,
            });
            const crashAction = parseRunControlAction({
              ...beforeCrash.actionTarget,
              actionId: parseRunControlActionId("action-pause-crashed-attempt"),
              operation: "pause",
              runId,
            });
            const crashBinding = makeRunControlActionBindingDigest({
              actionId: crashAction.actionId,
              authorityId: crashAction.authorityId,
              expectedEventSequence: crashAction.expectedEventSequence,
              operation: crashAction.operation,
              providerId: crashAction.providerId,
              runId,
              sessionId: crashAction.sessionId,
              workerAgentId: crashAction.workerAgentId,
              workerStartedSequence: crashAction.workerStartedSequence,
            });
            const crashControl = RunControlEventPayload.make({
              actionBindingDigest: crashBinding,
              actionId: crashAction.actionId,
              authorityId: crashAction.authorityId,
              expectedEventSequence: crashAction.expectedEventSequence,
              operation: crashAction.operation,
              providerId: crashAction.providerId,
              restoreState: "runningWorker",
              sessionId: crashAction.sessionId,
              workerAgentId: crashAction.workerAgentId,
              workerStartedSequence: crashAction.workerStartedSequence,
            });
            yield* appendEvent(runId, crashed.paths, {
              payload: {
                control: Schema.encodeSync(RunControlEventPayload)(
                  crashControl
                ),
              },
              type: "RUN_CONTROL_INTENT_RECORDED",
            });
            yield* appendEvent(runId, crashed.paths, {
              payload: {
                control: Schema.encodeSync(RunControlEventPayload)(
                  crashControl
                ),
              },
              type: "RUN_CONTROL_ATTEMPTED",
            });
            const restarted = yield* readRunControlSnapshot(runId, {
              rootDirectory: crashed.rootDirectory,
            });
            let crashInterruptCount = 0;
            const crashCoordinator = makeLiveHarnessSessionCoordinator();
            yield* crashCoordinator.register({
              agentId: workerAgentId,
              runId,
              session: {
                ...fakeSession([]),
                interrupt: Option.some(
                  Effect.sync(() => {
                    crashInterruptCount += 1;
                  })
                ),
              },
              sessionId,
            });
            const freshAfterCrash = yield* dispatchRunControlAction({
              action: parseRunControlAction({
                ...restarted.actionTarget,
                actionId: parseRunControlActionId(
                  "action-pause-fresh-after-crash"
                ),
                operation: "pause",
                runId,
              }),
              options: {
                rootDirectory: crashed.rootDirectory,
                sessionCoordinator: crashCoordinator,
              },
              runId,
            }).pipe(Effect.flip);
            expect(restarted.allowedActions).toEqual([]);
            expect(restarted.activeReceipt).toMatchObject({
              state: "outcomeUnknown",
            });
            expect(freshAfterCrash).toMatchObject({ code: "outcomeUnknown" });
            expect(crashInterruptCount).toBe(0);
          })
        )
    );

    it.effect("appends one expiry event under the controlled Clock", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const fs = yield* FileSystem.FileSystem;
        const waiting = yield* setupWaitingControlRun(
          capabilities,
          "gaia-run-control-expiry-",
          {
            expiresAt: "1970-01-01T00:00:01.000Z",
            requestedAt: "1970-01-01T00:00:00.000Z",
          }
        );
        const { checkpoint, paths, rootDirectory } = waiting;

        yield* reconcileRunControlExpiry(runId, { rootDirectory });
        expect(
          (yield* readEvents(paths)).filter(
            ({ type }) => type === "RUN_INTERACTION_EXPIRED"
          )
        ).toHaveLength(0);

        yield* TestClock.setTime(1_000);
        expect(
          (yield* readRunControlSnapshot(runId, { rootDirectory })).expired
        ).toBe(true);
        yield* reconcileRunControlExpiry(runId, { rootDirectory });
        yield* reconcileRunControlExpiry(runId, { rootDirectory });
        const expiredEvents = yield* readEvents(paths);
        expect(
          expiredEvents.filter(({ type }) => type === "RUN_INTERACTION_EXPIRED")
        ).toHaveLength(1);
        const resolution = yield* dispatchRunControlAction({
          action: parseRunControlAction({
            actionId: parseRunControlActionId("action-expired-resolution"),
            authorityId: checkpoint.resolverAuthorityId,
            checkpointDigest: checkpoint.checkpointDigest,
            expectedEventSequence: checkpoint.expectedEventSequence,
            interactionId: checkpoint.interactionId,
            operation: "resolveInteraction",
            providerId: checkpoint.providerId,
            requestDigest: checkpoint.requestDigest,
            response: {
              answers: [{ answers: ["EXPIRED_SECRET"], questionId }],
              kind: "userInput",
            },
            runId,
            sessionId: checkpoint.sessionId,
            workerAgentId: checkpoint.workerAgentId,
            workerStartedSequence: checkpoint.workerStartedSequence,
          }),
          options: { rootDirectory },
          runId,
        }).pipe(Effect.flip);
        expect(resolution).toMatchObject({ code: "expired" });
        expect(yield* readEvents(paths)).toHaveLength(expiredEvents.length);
        expect(yield* fs.readFileString(paths.events)).not.toContain(
          "EXPIRED_SECRET"
        );
      })
    );
  });
});

function setupRunningControlRun(
  sessionCapabilities: HarnessCapabilities,
  prefix: string
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rootDirectory = yield* fs.makeTempDirectory({ prefix });
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    yield* fs.makeDirectory(paths.root, { recursive: true });
    yield* appendEvent(runId, paths, {
      payload: { specPath: "spec.md" },
      type: "RUN_CREATED",
    });
    yield* appendEvent(runId, paths, {
      payload: { workspacePath: "." },
      type: "WORKSPACE_PREPARED",
    });
    yield* appendEvent(runId, paths, { type: "WORKER_STARTED" });
    yield* appendHarnessSessionEvent(runId, paths, {
      capabilities: sessionCapabilities,
      kind: "sessionStarted",
      provider,
      sessionId,
      state: "running",
    });
    return { paths, rootDirectory };
  });
}

function setupWaitingControlRun(
  sessionCapabilities: HarnessCapabilities,
  prefix: string,
  options: {
    readonly expiresAt?: string;
    readonly requestedAt?: string;
  } = {}
) {
  return Effect.gen(function* () {
    const running = yield* setupRunningControlRun(sessionCapabilities, prefix);
    const requestedAt = options.requestedAt ?? "2026-07-22T00:00:00.000Z";
    const interaction = {
      interactionId,
      itemId: parseHarnessItemId("item-control-wait"),
      kind: "userInput" as const,
      questions: [{ options: [], prompt: "Token?", questionId, secret: true }],
      requestedAt,
      turnId,
    };
    yield* appendHarnessSessionEvent(runId, running.paths, {
      kind: "turnStarted",
      sessionId,
      turnId,
    });
    yield* appendHarnessSessionEvent(runId, running.paths, {
      interaction,
      kind: "interactionRequested",
      sessionId,
    });
    const checkpointWithPlaceholder = Schema.decodeUnknownSync(
      RunHumanWaitCheckpointV1
    )({
      checkpointDigest: "a".repeat(64),
      environmentReceipt: {
        byteLength: 512,
        path: `harness-environment/receipt-${"b".repeat(64)}.json`,
        receiptDigest: "b".repeat(64),
        runId,
        structuralDigest: "c".repeat(64),
        version: 1 as const,
      },
      expectedEventSequence: 7,
      ...(options.expiresAt === undefined
        ? {}
        : { expiresAt: options.expiresAt }),
      interactionId,
      providerId: provider.providerId,
      requestDigest: makeRunControlRequestDigest(interaction),
      requestedAt,
      resolverAuthorityId: parseRunControlAuthorityId("authority-local"),
      runId,
      sessionId,
      version: 1 as const,
      workerAgentId,
      workerStartedSequence: 3,
    });
    const { checkpointDigest: _checkpointDigest, ...checkpointInput } =
      checkpointWithPlaceholder;
    const checkpoint = RunHumanWaitCheckpointV1.make({
      ...checkpointInput,
      checkpointDigest: makeRunControlCheckpointDigest(checkpointInput),
    });
    yield* appendEvent(runId, running.paths, {
      payload: {
        checkpoint: Schema.encodeSync(RunHumanWaitCheckpointV1)(checkpoint),
      },
      type: "RUN_WAITING_FOR_HUMAN",
    });
    return { ...running, checkpoint };
  });
}

function fakeSession(resolutions: unknown[]): HarnessSession {
  return {
    events: Stream.empty,
    interrupt: Option.some(Effect.void),
    resolveInteraction: (resolution) =>
      Effect.sync(() => {
        resolutions.push(resolution);
      }),
    send: () => Effect.succeed(undefined),
    snapshot: Effect.succeed(
      HarnessSessionSnapshot.make({
        capabilities,
        items: [],
        pendingInteractions: [],
        provider,
        recovered: false,
        resolvedInteractions: [],
        sessionId,
        state: "running",
        turns: [{ status: "running", turnId }],
      })
    ),
    steer: Option.some(() => Effect.succeed(undefined)),
  };
}

function contentionChildScript() {
  const runControlUrl = pathToFileURL(
    `${process.cwd()}/src/run-control-runtime.ts`
  ).href;
  const registryUrl = pathToFileURL(
    `${process.cwd()}/src/harness-provider-registry.ts`
  ).href;
  const coordinatorUrl = pathToFileURL(
    `${process.cwd()}/src/agent-session-runtime.ts`
  ).href;
  const lockUrl = pathToFileURL(`${process.cwd()}/src/run-store-lock.ts`).href;
  return `
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { NodeServices } from "@effect/platform-node";
import {
  HarnessCapabilities,
  HarnessProviderDescriptor,
  HarnessSessionSnapshot,
  parseHarnessProviderId,
  parseHarnessProfileId,
  parseHarnessTurnId,
  parseRunControlAction,
  parseRunId,
} from "@gaia/core";
import { Effect, Option, Stream } from "effect";
import { makeLiveHarnessSessionCoordinator } from ${JSON.stringify(coordinatorUrl)};
import { dispatchRunControlAction } from ${JSON.stringify(runControlUrl)};
import { makeHarnessProviderRegistry } from ${JSON.stringify(registryUrl)};
import { withRunStoreLock } from ${JSON.stringify(lockUrl)};

const input = JSON.parse(process.env[${JSON.stringify(contentionInputEnvironment)}]);
const action = parseRunControlAction(input.action);
const runId = parseRunId(action.runId);
const capabilities = HarnessCapabilities.make({
  approvals: ["userInput"],
  durableCancellation: true,
  durableInteractionResolution: true,
  durablePause: true,
  fileChangeEvents: false,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: true,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: true,
});
const descriptor = HarnessProviderDescriptor.make({
  displayName: "Durable Synthetic",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("durable-private"),
});
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
const providerCall = Effect.promise(async () => {
  await writeFile(input.markerDirectory + "/child", "called", "utf8");
});
await mkdir(input.markerDirectory, { recursive: true });
await writeFile(input.markerDirectory + "/ready-child", "ready", "utf8");
const barrierDeadline = Date.now() + 3000;
while (
  !(await readdir(input.markerDirectory)).includes("go") &&
  Date.now() < barrierDeadline
) await wait();
if (!(await readdir(input.markerDirectory)).includes("go"))
  throw new Error("Cross-process contention barrier expired.");
const session = {
  events: Stream.empty,
  interrupt: Option.some(providerCall),
  resolveInteraction: () => Effect.promise(async () => {
    await writeFile(input.markerDirectory + "/child", "called", "utf8");
    const deadline = Date.now() + 500;
    while (
      (await readdir(input.markerDirectory)).filter((entry) =>
        ["child", "parent"].includes(entry)
      ).length < 2 &&
      Date.now() < deadline
    ) await wait();
  }),
  send: () => Effect.void,
  snapshot: Effect.succeed(HarnessSessionSnapshot.make({
    capabilities,
    items: [],
    pendingInteractions: [],
    provider: descriptor,
    recovered: false,
    resolvedInteractions: [],
    sessionId: action.sessionId,
    state: "running",
    turns: [{ status: "running", turnId: parseHarnessTurnId("turn-control") }],
  })),
  steer: Option.some(() => Effect.void),
};
const provider = {
  createSession: () => Effect.succeed(session),
  descriptor,
  detect: Effect.succeed({
    auth: { state: "notRequired" },
    capabilities,
    state: "available",
    version: "test-1",
  }),
  resumeSession: () => Effect.succeed(session),
};
const profileId = parseHarnessProfileId("codexAppServer");
const registry = makeHarnessProviderRegistry([{ profileId, provider }]);
const coordinator = makeLiveHarnessSessionCoordinator();
await Effect.runPromise(
  withRunStoreLock(
    { rootDirectory: input.rootDirectory },
    Effect.scoped(Effect.gen(function* () {
      yield* coordinator.register({
        agentId: action.workerAgentId,
        runId,
        session,
        sessionId: action.sessionId,
      });
      yield* dispatchRunControlAction({
        action,
        options: {
          harnessProviderRegistry: registry,
          rootDirectory: input.rootDirectory,
          sessionCoordinator: coordinator,
        },
        runId,
      });
    })),
    { operation: "Competing Gaia run control action" }
  ).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      error.code === "RunStoreLocked" ? Effect.void : Effect.fail(error)
    ),
    Effect.provide(NodeServices.layer)
  )
);
`;
}

function contentionProvider(
  markerDirectory: string,
  markerId: string
): HarnessProvider {
  const descriptor = HarnessProviderDescriptor.make({
    displayName: "Durable Synthetic",
    executionModes: ["local"],
    providerId: parseHarnessProviderId("durable-private"),
  });
  const session: HarnessSession = {
    ...fakeSession([]),
    resolveInteraction: () =>
      Effect.tryPromise({
        catch: () =>
          new HarnessActionError({
            actionKind: "resolveInteraction",
            message: "The contention witness could not be recorded.",
            providerId: descriptor.providerId,
          }),
        try: async () => {
          await mkdir(markerDirectory, { recursive: true });
          await writeFile(`${markerDirectory}/${markerId}`, "called", "utf8");
          const deadline = Date.now() + 500;
          while (
            (await readdir(markerDirectory)).filter((entry) =>
              ["child", "parent"].includes(entry)
            ).length < 2 &&
            Date.now() < deadline
          )
            await waitForContentionPoll();
        },
      }),
  };
  return {
    createSession: () => Effect.succeed(session),
    descriptor,
    detect: Effect.succeed({
      auth: { state: "notRequired" },
      capabilities,
      state: "available",
      version: "test-1",
    }),
    resumeSession: () => Effect.succeed(session),
  };
}

function waitForContentionPoll() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });
}
