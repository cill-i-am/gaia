import { createHash } from "node:crypto";

import { NodeServices } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import {
  HarnessCapabilities,
  HarnessProviderDescriptor,
  HarnessSessionSnapshot,
  MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
  ModelInvocationEpisodeStartV1,
  RunControlEventPayload,
  makeRunControlActionBindingDigest,
  makeModelContextContentV1,
  makeModelContextManifestV1,
  makeModelInvocationManifestV1,
  parseHarnessActionId,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessProviderId,
  parseHarnessQuestionId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseRunControlActionId,
  parseRunControlAuthorityId,
  parseRunControlEventPayload,
  parseRunEventSequence,
  parseRunId,
  parseWorkspaceRelativePath,
  renderModelInputV1,
} from "@gaia/core";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { describe, expect } from "vitest";

import {
  dispatchAgentSessionAction,
  makeLiveHarnessSessionCoordinator,
  readAgentSessionSnapshot,
  streamAgentSessionUpdates,
} from "./agent-session-runtime.js";
import {
  appendEvent,
  appendHarnessSessionEvent,
  appendHarnessSessionEventWithinSerialization,
  readEvents,
  subscribeRunEventFeed,
  withRunEventSerialization,
} from "./event-store.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import type { HarnessSession } from "./harness-session.js";
import {
  commitModelInvocationPair,
  deriveModelWorkspaceBinding,
  loadModelInvocationPair,
} from "./model-invocation.js";
import { makeRunPaths } from "./paths.js";

const runId = parseRunId("run-Gaia86rt01");
const workerAgentId = issueDeliveryAgentIds.worker;
const sessionId = parseHarnessSessionId(`session-${runId}`);
const turnId = parseHarnessTurnId("turn-runtime");
const recoveredTurnId = parseHarnessTurnId("turn-runtime-recovered");
const oldInteractionId = parseHarnessInteractionId("interaction-runtime-old");
const recoveredInteractionId = parseHarnessInteractionId(
  "interaction-runtime-recovered"
);
const provider = HarnessProviderDescriptor.make({
  displayName: "Synthetic",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("private-provider"),
});
const capabilities = HarnessCapabilities.make({
  approvals: [],
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
  userQuestions: false,
});
const approvalCapabilities = HarnessCapabilities.make({
  ...capabilities,
  approvals: ["command"],
});

describe("agent session runtime", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "projects a provider-neutral snapshot and permits non-contiguous filtered SSE IDs",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const rootDirectory = yield* setupRun();
            yield* appendEvent(
              runId,
              yield* makeRunPaths(runId, { rootDirectory }),
              { type: "WORKER_STARTED" }
            );
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            const snapshot = yield* readAgentSessionSnapshot(
              runId,
              workerAgentId,
              { rootDirectory }
            );
            expect(snapshot).not.toHaveProperty("provider");
            const stream = yield* streamAgentSessionUpdates(
              runId,
              workerAgentId,
              undefined,
              { rootDirectory }
            );
            const updates = yield* stream.pipe(
              Stream.take(2),
              Stream.runCollect
            );
            expect(updates.map(({ eventSequence }) => eventSequence)).toEqual([
              2, 4,
            ]);
          })
        )
    );

    it.effect(
      "hands off subscriber-first without losing or duplicating a concurrent append",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const rootDirectory = yield* setupRun();
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            const stream = yield* streamAgentSessionUpdates(
              runId,
              workerAgentId,
              undefined,
              { rootDirectory }
            );
            const fiber = yield* stream.pipe(
              Stream.take(2),
              Stream.runCollect,
              Effect.forkChild
            );
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            const updates = yield* Fiber.join(fiber);
            expect(updates.map(({ eventSequence }) => eventSequence)).toEqual([
              2, 3,
            ]);
          })
        )
    );

    it.effect(
      "rejects invalid stream cursors before reading the event feed",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const rootDirectory = yield* fs.makeTempDirectory({
              prefix: "gaia-agent-session-invalid-cursor-",
            });
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            yield* fs.makeDirectory(paths.root, { recursive: true });
            yield* fs.makeDirectory(paths.events);

            for (const afterSequence of [0, -1, 1.5]) {
              const error = yield* streamAgentSessionUpdates(
                runId,
                workerAgentId,
                afterSequence,
                { rootDirectory }
              ).pipe(Effect.flip);
              const diagnostic = Schema.decodeUnknownSync(
                Schema.Struct({ code: Schema.String })
              )(error);

              expect(diagnostic.code).toBe("InvalidRequest");
            }
          })
        )
    );

    it.effect(
      "delivers a terminal update before closing the selected-agent stream",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const rootDirectory = yield* setupRun();
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "turnCompleted",
              sessionId,
              status: "completed",
              turnId,
            });
            const stream = yield* streamAgentSessionUpdates(
              runId,
              workerAgentId,
              undefined,
              { rootDirectory }
            );
            const updates = yield* stream.pipe(Stream.runCollect);
            expect(updates.map(({ eventSequence }) => eventSequence)).toEqual([
              2, 3, 4,
            ]);
            expect(updates.at(-1)?.terminal).toBe(true);

            const cancelledRoot = yield* setupMarkedRun();
            const cancelledPaths = yield* makeRunPaths(runId, {
              rootDirectory: cancelledRoot,
            });
            yield* appendHarnessSessionEvent(runId, cancelledPaths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            const cancelledControlFields = {
              actionId: parseRunControlActionId("action-agent-stream-cancel"),
              authorityId: parseRunControlAuthorityId("authority-local"),
              expectedEventSequence: parseRunEventSequence(5),
              operation: "cancel",
              providerId: provider.providerId,
              sessionId,
              workerAgentId,
              workerStartedSequence: parseRunEventSequence(3),
            } as const;
            const cancelledControl = parseRunControlEventPayload({
              ...cancelledControlFields,
              actionBindingDigest: makeRunControlActionBindingDigest({
                ...cancelledControlFields,
                runId,
              }),
            });
            for (const type of [
              "RUN_CONTROL_INTENT_RECORDED",
              "RUN_CONTROL_ATTEMPTED",
              "RUN_CONTROL_CONFIRMED",
            ] as const) {
              yield* appendEvent(runId, cancelledPaths, {
                payload: {
                  control: Schema.encodeSync(RunControlEventPayload)(
                    cancelledControl
                  ),
                },
                type,
              });
            }
            const cancelledStream = yield* streamAgentSessionUpdates(
              runId,
              workerAgentId,
              4,
              { rootDirectory: cancelledRoot }
            );
            const cancelledFiber = yield* cancelledStream.pipe(
              Stream.runCollect,
              Effect.forkChild
            );
            for (let attempt = 0; attempt < 10; attempt += 1) {
              yield* Effect.yieldNow;
            }
            const cancelledExit = cancelledFiber.pollUnsafe();
            if (cancelledExit?._tag === "Success") {
              expect(cancelledExit.value.at(-1)?.eventSequence).toBe(8);
              expect(cancelledExit.value.at(-1)?.terminal).toBe(true);
            }

            const resumedRoot = yield* setupMarkedRun();
            const resumedPaths = yield* makeRunPaths(runId, {
              rootDirectory: resumedRoot,
            });
            yield* appendHarnessSessionEvent(runId, resumedPaths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            for (const [sequence, operation] of [
              [5, "pause"],
              [8, "resume"],
            ] as const) {
              const controlFields = {
                actionId: parseRunControlActionId(
                  `action-agent-stream-${operation}`
                ),
                authorityId: parseRunControlAuthorityId("authority-local"),
                expectedEventSequence: parseRunEventSequence(sequence),
                operation,
                providerId: provider.providerId,
                sessionId,
                workerAgentId,
                workerStartedSequence: parseRunEventSequence(3),
              } as const;
              const control = parseRunControlEventPayload({
                ...controlFields,
                actionBindingDigest: makeRunControlActionBindingDigest({
                  ...controlFields,
                  runId,
                }),
                restoreState: "runningWorker",
              });
              for (const type of [
                "RUN_CONTROL_INTENT_RECORDED",
                "RUN_CONTROL_ATTEMPTED",
                "RUN_CONTROL_CONFIRMED",
              ] as const) {
                yield* appendEvent(runId, resumedPaths, {
                  payload: {
                    control: Schema.encodeSync(RunControlEventPayload)(control),
                  },
                  type,
                });
              }
            }
            const resumedStream = yield* streamAgentSessionUpdates(
              runId,
              workerAgentId,
              8,
              { rootDirectory: resumedRoot }
            );
            const resumedFiber = yield* resumedStream.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.forkChild
            );
            for (let attempt = 0; attempt < 10; attempt += 1) {
              yield* Effect.yieldNow;
            }
            const resumedExit = resumedFiber.pollUnsafe();
            expect([cancelledExit?._tag, resumedExit?._tag]).toEqual([
              "Success",
              "Success",
            ]);
            if (resumedExit?._tag === "Success") {
              expect(resumedExit.value).toHaveLength(1);
              expect(resumedExit.value[0]).toMatchObject({
                eventSequence: 11,
                terminal: false,
              });
            }
          })
        )
    );

    it.effect(
      "streams recovered backlog after a historical recoverable failure without permanently closing",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const rootDirectory = yield* setupRecoveredRun();
            const stream = yield* streamAgentSessionUpdates(
              runId,
              workerAgentId,
              2,
              { rootDirectory }
            );
            const updates = yield* stream.pipe(
              Stream.take(6),
              Stream.runCollect
            );

            expect(updates.map(({ eventSequence }) => eventSequence)).toEqual([
              3, 4, 5, 6, 7, 8,
            ]);
            expect(updates.map(({ terminal }) => terminal)).toEqual([
              false,
              false,
              false,
              false,
              false,
              false,
            ]);
            expect(updates.at(-1)?.snapshot.state).toBe("running");
            expect(updates.at(-1)?.snapshot.turns).toEqual([
              { failure: recoverableProviderFailure, status: "failed", turnId },
              { status: "running", turnId: recoveredTurnId },
            ]);
            expect(
              updates
                .at(-1)
                ?.snapshot.pendingInteractions.map(
                  ({ interactionId }) => interactionId
                )
            ).toEqual([recoveredInteractionId]);
          })
        )
    );

    it.effect("still closes unrecovered terminal streams", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rootDirectory = yield* setupRun(approvalCapabilities);
          const paths = yield* makeRunPaths(runId, { rootDirectory });
          yield* appendHarnessSessionEvent(runId, paths, {
            kind: "turnStarted",
            sessionId,
            turnId,
          });
          yield* appendHarnessSessionEvent(runId, paths, {
            failure: recoverableProviderFailure,
            kind: "sessionFailed",
            sessionId,
          });
          const stream = yield* streamAgentSessionUpdates(
            runId,
            workerAgentId,
            2,
            { rootDirectory }
          );
          const updates = yield* stream.pipe(Stream.runCollect);

          expect(updates.map(({ eventSequence }) => eventSequence)).toEqual([
            3, 4,
          ]);
          expect(updates.at(-1)?.terminal).toBe(true);
          expect(updates.at(-1)?.snapshot.state).toBe("failed");
        })
      )
    );

    it.effect("still closes other terminal session-state streams", () =>
      Effect.scoped(
        Effect.gen(function* () {
          for (const state of [
            "completed",
            "interrupted",
            "unavailable",
          ] as const) {
            const rootDirectory = yield* setupRun();
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "sessionStateChanged",
              sessionId,
              state,
            });
            const stream = yield* streamAgentSessionUpdates(
              runId,
              workerAgentId,
              2,
              { rootDirectory }
            );
            const updates = yield* stream.pipe(Stream.runCollect);

            expect(updates.map(({ eventSequence }) => eventSequence)).toEqual([
              3,
            ]);
            expect(updates.at(-1)?.terminal).toBe(true);
            expect(updates.at(-1)?.snapshot.state).toBe(state);
          }
        })
      )
    );

    it.effect(
      "records and confirms a steer exactly once for same-ID retry",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const rootDirectory = yield* setupMarkedRun();
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            const calls: string[] = [];
            const coordinator = makeLiveHarnessSessionCoordinator();
            yield* coordinator.register({
              agentId: workerAgentId,
              runId,
              session: fakeSession(calls),
              sessionId,
            });
            const action = {
              actionId: parseHarnessActionId("action-steer"),
              kind: "steer" as const,
              sessionId,
              text: "focus",
              turnId,
            };
            const first = yield* dispatchAgentSessionAction({
              action,
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });
            const second = yield* dispatchAgentSessionAction({
              action: {
                ...action,
                text: "different low-entropy operator text",
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });
            expect(first.state).toBe("dispatchConfirmed");
            expect(second.state).toBe("dispatchConfirmed");
            expect(second.payloadDigest).toBe(first.payloadDigest);
            const events = yield* readEvents(paths);
            const owner = events.find(
              (event) =>
                event.type === "HARNESS_SESSION_EVENT_RECORDED" &&
                event.payload["modelInvocationEpisode"] !== undefined
            );
            const episode = Schema.decodeUnknownSync(
              ModelInvocationEpisodeStartV1
            )(owner?.payload["modelInvocationEpisode"]);
            const pair = yield* loadModelInvocationPair(paths, episode);
            expect(calls).toEqual([pair.rendered.text]);
            expect(calls[0]).not.toBe(action.text);
            expect(calls[0]).toContain(action.text);
            expect(
              events.flatMap((event) =>
                event.type === "HARNESS_SESSION_EVENT_RECORDED" &&
                event.payload["modelInvocationObservation"] !== undefined
                  ? [event.payload["modelInvocationObservation"]]
                  : []
              )
            ).toEqual([]);
          })
        )
    );

    it.effect(
      "rejects unsupported, stale, duplicate, and cross-session actions before dispatch",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const rootDirectory = yield* setupRun();
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            const coordinator = makeLiveHarnessSessionCoordinator();
            const calls: string[] = [];
            yield* coordinator.register({
              agentId: workerAgentId,
              runId,
              session: fakeSession(calls),
              sessionId,
            });

            const unsupportedFollowUp = yield* dispatchAgentSessionAction({
              action: {
                actionId: parseHarnessActionId("action-follow-up"),
                kind: "followUp",
                sessionId,
                text: "resume",
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.exit);
            expect(unsupportedFollowUp._tag).toBe("Failure");

            const staleApproval = yield* dispatchAgentSessionAction({
              action: {
                actionId: parseHarnessActionId("action-stale"),
                decision: "approve",
                interactionId: parseHarnessInteractionId("interaction-missing"),
                kind: "approval",
                sessionId,
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.exit);
            expect(staleApproval._tag).toBe("Failure");

            const wrongSession = yield* dispatchAgentSessionAction({
              action: {
                actionId: parseHarnessActionId("action-wrong-session"),
                kind: "interrupt",
                sessionId: parseHarnessSessionId("session-other"),
                turnId,
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.exit);
            expect(wrongSession._tag).toBe("Failure");
            expect(calls).toEqual([]);
          })
        )
    );

    it.effect(
      "confirms approval, user-input, and MCP actions only after provider acceptance",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const rootDirectory = yield* setupRun(
              HarnessCapabilities.make({
                ...capabilities,
                approvals: ["command", "userInput", "mcpElicitation"],
                userQuestions: true,
              })
            );
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            const commandInteractionId = parseHarnessInteractionId(
              "interaction-command"
            );
            const userInputInteractionId = parseHarnessInteractionId(
              "interaction-user-input"
            );
            const mcpInteractionId =
              parseHarnessInteractionId("interaction-mcp");
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            yield* appendHarnessSessionEvent(runId, paths, {
              interaction: {
                allowedDecisions: ["approve", "decline"],
                command: "pnpm test",
                interactionId: commandInteractionId,
                itemId: parseHarnessItemId("item-command"),
                kind: "commandApproval",
                requestedAt: "2026-07-10T00:00:00.000Z",
                turnId,
                workspacePath: parseWorkspaceRelativePath("."),
              },
              kind: "interactionRequested",
              sessionId,
            });
            yield* appendHarnessSessionEvent(runId, paths, {
              interaction: {
                interactionId: userInputInteractionId,
                itemId: parseHarnessItemId("item-question"),
                kind: "userInput",
                questions: [
                  {
                    options: [],
                    prompt: "Continue?",
                    questionId: parseHarnessQuestionId("question-continue"),
                    secret: false,
                  },
                ],
                requestedAt: "2026-07-10T00:00:01.000Z",
                turnId,
              },
              kind: "interactionRequested",
              sessionId,
            });
            yield* appendHarnessSessionEvent(runId, paths, {
              interaction: {
                interactionId: mcpInteractionId,
                kind: "mcpElicitation",
                message: "Pick action",
                mode: "form",
                requestedAt: "2026-07-10T00:00:02.000Z",
                serverName: "safe-mcp",
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
              session: fakeSession([], resolutions),
              sessionId,
            });

            const approval = yield* dispatchAgentSessionAction({
              action: {
                actionId: parseHarnessActionId("action-approve"),
                decision: "approve",
                interactionId: commandInteractionId,
                kind: "approval",
                sessionId,
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });
            const userInput = yield* dispatchAgentSessionAction({
              action: {
                actionId: parseHarnessActionId("action-answer"),
                answers: [
                  {
                    answers: ["yes"],
                    questionId: parseHarnessQuestionId("question-continue"),
                  },
                ],
                interactionId: userInputInteractionId,
                kind: "userInput",
                sessionId,
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });
            const mcp = yield* dispatchAgentSessionAction({
              action: {
                action: "submit",
                actionId: parseHarnessActionId("action-mcp"),
                content: "safe",
                interactionId: mcpInteractionId,
                kind: "mcpElicitation",
                sessionId,
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });
            expect([approval.state, userInput.state, mcp.state]).toEqual([
              "dispatchConfirmed",
              "dispatchConfirmed",
              "dispatchConfirmed",
            ]);
            expect(resolutions).toHaveLength(3);

            const duplicate = yield* dispatchAgentSessionAction({
              action: {
                actionId: parseHarnessActionId("action-duplicate"),
                decision: "decline",
                interactionId: commandInteractionId,
                kind: "approval",
                sessionId,
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.exit);
            expect(duplicate._tag).toBe("Failure");
          })
        )
    );

    it.effect(
      "resolves only the recovered pending interaction and rejects hidden-response replay",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const rootDirectory = yield* setupRecoveredRun();
            const snapshot = yield* readAgentSessionSnapshot(
              runId,
              workerAgentId,
              { rootDirectory }
            );

            expect(snapshot.state).toBe("running");
            expect(snapshot.turns).toEqual([
              { failure: recoverableProviderFailure, status: "failed", turnId },
              { status: "running", turnId: recoveredTurnId },
            ]);
            expect(
              snapshot.pendingInteractions.map(
                ({ interactionId }) => interactionId
              )
            ).toEqual([recoveredInteractionId]);

            const resolutions: unknown[] = [];
            const coordinator = makeLiveHarnessSessionCoordinator();
            yield* coordinator.register({
              agentId: workerAgentId,
              runId,
              session: fakeSession([], resolutions),
              sessionId,
            });

            const oldInteraction = yield* dispatchAgentSessionAction({
              action: {
                actionId: parseHarnessActionId("action-old-interaction"),
                decision: "decline",
                interactionId: oldInteractionId,
                kind: "approval",
                sessionId,
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.exit);
            expect(oldInteraction._tag).toBe("Failure");
            expect(resolutions).toHaveLength(0);

            const action = {
              actionId: parseHarnessActionId("action-recovered-approval"),
              decision: "decline" as const,
              interactionId: recoveredInteractionId,
              kind: "approval" as const,
              sessionId,
            };
            const first = yield* dispatchAgentSessionAction({
              action,
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });
            const replay = yield* dispatchAgentSessionAction({
              action,
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.flip);
            const differentAction = yield* dispatchAgentSessionAction({
              action: {
                ...action,
                actionId: parseHarnessActionId(
                  "action-recovered-approval-other"
                ),
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.exit);

            expect(first.state).toBe("dispatchConfirmed");
            expect(replay).toMatchObject({
              code: "ResolutionReplayNotComparable",
            });
            expect(differentAction._tag).toBe("Failure");
            expect(resolutions).toEqual([
              {
                actionId: action.actionId,
                decision: "decline",
                interactionId: recoveredInteractionId,
                kind: "approval",
              },
            ]);
          })
        )
    );

    it.effect(
      "uses privacy-safe structural action digests for secret answers and MCP content",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const rootDirectory = yield* setupRun(
              HarnessCapabilities.make({
                ...capabilities,
                approvals: ["userInput", "mcpElicitation"],
                userQuestions: true,
              })
            );
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            const userInputInteractionId = parseHarnessInteractionId(
              "interaction-secret-user-input"
            );
            const mcpInteractionId = parseHarnessInteractionId(
              "interaction-secret-mcp"
            );
            const questionId = parseHarnessQuestionId("question-secret");
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            yield* appendHarnessSessionEvent(runId, paths, {
              interaction: {
                interactionId: userInputInteractionId,
                itemId: parseHarnessItemId("item-secret-question"),
                kind: "userInput",
                questions: [
                  { options: [], prompt: "Token?", questionId, secret: true },
                ],
                requestedAt: "2026-07-10T00:00:03.000Z",
                turnId,
              },
              kind: "interactionRequested",
              sessionId,
            });
            yield* appendHarnessSessionEvent(runId, paths, {
              interaction: {
                interactionId: mcpInteractionId,
                kind: "mcpElicitation",
                message: "Provide MCP content",
                mode: "form",
                requestedAt: "2026-07-10T00:00:04.000Z",
                serverName: "safe-mcp",
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
              session: fakeSession([], resolutions),
              sessionId,
            });

            const userAction = {
              actionId: parseHarnessActionId("action-secret-answer"),
              answers: [{ answers: ["SECRET_ONE_TIME_CODE"], questionId }],
              interactionId: userInputInteractionId,
              kind: "userInput" as const,
              sessionId,
            };
            const first = yield* dispatchAgentSessionAction({
              action: userAction,
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });
            const eventsAfterUserInput = yield* readEvents(paths);
            const snapshotAfterUserInput = yield* readAgentSessionSnapshot(
              runId,
              workerAgentId,
              { rootDirectory }
            );
            const retry = yield* dispatchAgentSessionAction({
              action: {
                ...userAction,
                answers: [
                  {
                    answers: ["DIFFERENT_PASSWORD", "SECOND_PASSWORD"],
                    questionId,
                  },
                ],
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.flip);
            expect(retry).toMatchObject({
              code: "ResolutionReplayNotComparable",
            });
            expect(resolutions).toHaveLength(1);

            const groupedReplay = yield* dispatchAgentSessionAction({
              action: {
                ...userAction,
                answers: [
                  {
                    answers: ["GROUPED_SECRET"],
                    questionId,
                  },
                  {
                    answers: ["OTHER_GROUP_SECRET"],
                    questionId: parseHarnessQuestionId(
                      "question-secret-other-group"
                    ),
                  },
                ],
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.flip);
            expect(groupedReplay).toMatchObject({
              code: "ResolutionReplayNotComparable",
            });
            expect(yield* readEvents(paths)).toEqual(eventsAfterUserInput);
            expect(
              yield* readAgentSessionSnapshot(runId, workerAgentId, {
                rootDirectory,
              })
            ).toEqual(snapshotAfterUserInput);

            const mcpAction = {
              action: "submit" as const,
              actionId: parseHarnessActionId("action-secret-mcp"),
              content: "UNRESTRICTED_MCP_SECRET_CONTENT",
              interactionId: mcpInteractionId,
              kind: "mcpElicitation" as const,
              sessionId,
            };
            const mcp = yield* dispatchAgentSessionAction({
              action: mcpAction,
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });
            const eventsAfterMcp = yield* readEvents(paths);
            const snapshotAfterMcp = yield* readAgentSessionSnapshot(
              runId,
              workerAgentId,
              { rootDirectory }
            );
            const { content: _content, ...mcpWithoutContent } = mcpAction;
            const mcpRetry = yield* dispatchAgentSessionAction({
              action: mcpWithoutContent,
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            }).pipe(Effect.flip);
            expect(mcpRetry).toMatchObject({
              code: "ResolutionReplayNotComparable",
            });
            expect(resolutions).toHaveLength(2);
            expect(yield* readEvents(paths)).toEqual(eventsAfterMcp);
            expect(
              yield* readAgentSessionSnapshot(runId, workerAgentId, {
                rootDirectory,
              })
            ).toEqual(snapshotAfterMcp);
            expect(first.payloadDigest).not.toBe(mcp.payloadDigest);

            const persisted = JSON.stringify(yield* readEvents(paths));
            expect(persisted).not.toContain("SECRET_ONE_TIME_CODE");
            expect(persisted).not.toContain("DIFFERENT_PASSWORD");
            expect(persisted).not.toContain("SECOND_PASSWORD");
            expect(persisted).not.toContain("GROUPED_SECRET");
            expect(persisted).not.toContain("OTHER_GROUP_SECRET");
            expect(persisted).not.toContain("UNRESTRICTED_MCP_SECRET_CONTENT");
            expect(persisted).not.toContain("DIFFERENT_MCP_SECRET_CONTENT");
          })
        )
    );

    it.effect(
      "derives outcomeUnknown from both incomplete crash windows and never redispatches",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const rootDirectory = yield* setupRun();
            const paths = yield* makeRunPaths(runId, { rootDirectory });
            yield* appendHarnessSessionEvent(runId, paths, {
              kind: "turnStarted",
              sessionId,
              turnId,
            });
            const actionId = parseHarnessActionId("action-crash");
            const binding = {
              actionId,
              actionKind: "interrupt" as const,
              agentId: workerAgentId,
              payloadDigest: actionDigestForInterrupt(actionId),
              sessionId,
              targetId: turnId,
            };
            yield* appendHarnessSessionEvent(runId, paths, {
              ...binding,
              kind: "operatorActionIntentRecorded",
            });
            const coordinator = makeLiveHarnessSessionCoordinator();
            const intentReceipt = yield* dispatchAgentSessionAction({
              action: { actionId, kind: "interrupt", sessionId, turnId },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });
            expect(intentReceipt.state).toBe("outcomeUnknown");

            const attemptedId = parseHarnessActionId("action-attempted");
            const attempted = {
              ...binding,
              actionId: attemptedId,
              payloadDigest: actionDigestForInterrupt(attemptedId),
            };
            yield* withRunEventSerialization(
              paths,
              Effect.gen(function* () {
                yield* appendHarnessSessionEventWithinSerialization(
                  runId,
                  paths,
                  { ...attempted, kind: "operatorActionIntentRecorded" }
                );
                yield* appendHarnessSessionEventWithinSerialization(
                  runId,
                  paths,
                  { ...attempted, kind: "operatorActionDispatchAttempted" }
                );
              })
            );
            const receipt = yield* dispatchAgentSessionAction({
              action: {
                actionId: attemptedId,
                kind: "interrupt",
                sessionId,
                turnId,
              },
              agentId: workerAgentId,
              coordinator,
              options: { rootDirectory },
              runId,
            });
            expect(receipt.state).toBe("outcomeUnknown");
          })
        )
    );

    it.effect("fails a bounded authoritative subscriber on overflow", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const rootDirectory = yield* setupRun();
          const paths = yield* makeRunPaths(runId, { rootDirectory });
          const subscription = yield* subscribeRunEventFeed(paths, 1);
          yield* appendEvent(runId, paths, { type: "WORKER_STARTED" });
          yield* appendEvent(runId, paths, { type: "VERIFICATION_STARTED" });
          const exit = yield* subscription.live.pipe(
            Stream.runCollect,
            Effect.exit
          );
          expect(exit._tag).toBe("Failure");
        })
      )
    );

    it.effect(
      "rejects duplicate registration and drains a pinned handle on shutdown",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const coordinator = makeLiveHarnessSessionCoordinator();
            const calls: string[] = [];
            const identity = {
              agentId: workerAgentId,
              runId,
              sessionId,
            } as const;
            const registrationScope = yield* Scope.make();
            yield* coordinator
              .register({ ...identity, session: fakeSession(calls) })
              .pipe(Effect.provideService(Scope.Scope, registrationScope));
            const duplicate = yield* coordinator
              .register({
                ...identity,
                session: fakeSession(calls),
              })
              .pipe(Effect.exit);
            expect(duplicate._tag).toBe("Failure");

            const pinEntered = yield* Deferred.make<void>();
            const releasePin = yield* Deferred.make<void>();
            const pinFiber = yield* coordinator
              .use(identity, () =>
                Deferred.succeed(pinEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releasePin))
                )
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(pinEntered);

            const closeFiber = yield* Scope.close(
              registrationScope,
              Exit.void
            ).pipe(Effect.forkChild);
            while ((yield* coordinator.get(identity))?.closing !== true)
              yield* Effect.yieldNow;
            const shutdownFiber = yield* coordinator.shutdown.pipe(
              Effect.forkChild
            );
            yield* Effect.yieldNow;

            yield* Deferred.succeed(releasePin, undefined);
            yield* Fiber.join(pinFiber);
            for (let attempt = 0; attempt < 10; attempt += 1)
              yield* Effect.yieldNow;

            expect(closeFiber.pollUnsafe()).toBeDefined();
            expect(shutdownFiber.pollUnsafe()).toBeDefined();
            expect(yield* coordinator.get(identity)).toBeUndefined();
          })
        )
    );

    it.effect(
      "rejects a higher active generation and registers it only after lease release",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const coordinator = makeLiveHarnessSessionCoordinator();
            const firstScope = yield* Scope.make();
            const secondScope = yield* Scope.make();
            const first = fakeSession(["first"]);
            const second = fakeSession(["second"]);
            const identity = {
              agentId: workerAgentId,
              runId,
              sessionId,
            } as const;

            yield* coordinator
              .register({ ...identity, generation: 10, session: first })
              .pipe(Effect.provideService(Scope.Scope, firstScope));
            const activeHigher = yield* coordinator
              .register({
                ...identity,
                generation: 11,
                session: second,
              })
              .pipe(
                Effect.provideService(Scope.Scope, secondScope),
                Effect.exit
              );
            expect(activeHigher._tag).toBe("Failure");
            expect((yield* coordinator.get(identity))?.session).toBe(first);

            yield* Scope.close(firstScope, Exit.void);
            yield* coordinator
              .register({ ...identity, generation: 11, session: second })
              .pipe(Effect.provideService(Scope.Scope, secondScope));
            expect((yield* coordinator.get(identity))?.session).toBe(second);
            yield* Scope.close(secondScope, Exit.void);
            expect(yield* coordinator.get(identity)).toBeUndefined();
          })
        )
    );
  });
});

function setupRun(runCapabilities = capabilities) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rootDirectory = yield* fs.makeTempDirectory({
      prefix: "gaia-agent-session-",
    });
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    yield* fs.makeDirectory(paths.root, { recursive: true });
    yield* appendEvent(runId, paths, {
      payload: { specPath: "spec.md" },
      type: "RUN_CREATED",
    });
    yield* appendHarnessSessionEvent(runId, paths, {
      capabilities: runCapabilities,
      kind: "sessionStarted",
      provider,
      sessionId,
      state: "running",
    });
    return rootDirectory;
  });
}

function setupMarkedRun() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rootDirectory = yield* fs.makeTempDirectory({
      prefix: "gaia-agent-session-model-input-",
    });
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    yield* fs.makeDirectory(paths.workspace, { recursive: true });
    yield* appendEvent(runId, paths, {
      payload: { modelInvocationProtocol: "v1", specPath: "spec.md" },
      type: "RUN_CREATED",
    });
    yield* appendEvent(runId, paths, {
      payload: { workspacePath: "." },
      type: "WORKSPACE_PREPARED",
    });
    const content = makeModelContextContentV1({
      acceptedOutcomes: ["Complete the accepted worker task."],
      authority: ["Operate only inside the accepted run."],
      budget: { maxOutputBytes: 16_384, maxTurns: 1 },
      contentRefs: [],
      episodeRole: "workerInitial",
      instructions: ["Use the accepted operator inputs."],
      nonGoals: ["Do not deploy."],
      outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
      planningFacts: ["events.jsonl is authoritative."],
      safeExclusions: ["credentials"],
      skills: [],
      stops: ["Stop on scope drift."],
      taskInput: "Complete the initial worker task.",
      verificationCommands: [],
    });
    const workspaceBinding = yield* deriveModelWorkspaceBinding(paths);
    const context = makeModelContextManifestV1({
      authoritativeRefs: [],
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
      outputContract: content.payload.outputContract,
      rendered: renderModelInputV1(content),
      runContractRef: { digest: "c".repeat(64), kind: "runContract" },
      template: { id: "gaia.worker-input.v1", version: 1 },
      workspaceBinding,
    });
    const modelInvocationEpisode = yield* commitModelInvocationPair({
      context,
      episodeKey: "workerInitial",
      invocation,
      paths,
    });
    yield* appendEvent(runId, paths, {
      payload: {
        modelInvocationEpisode: Schema.encodeSync(
          ModelInvocationEpisodeStartV1
        )(modelInvocationEpisode),
      },
      type: "WORKER_STARTED",
    });
    yield* appendHarnessSessionEvent(runId, paths, {
      capabilities,
      kind: "sessionStarted",
      provider,
      sessionId,
      state: "running",
    });
    return rootDirectory;
  });
}

function setupRecoveredRun() {
  return Effect.gen(function* () {
    const rootDirectory = yield* setupRun(approvalCapabilities);
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    yield* appendHarnessSessionEvent(runId, paths, {
      kind: "turnStarted",
      sessionId,
      turnId,
    });
    yield* appendHarnessSessionEvent(runId, paths, {
      interaction: commandApproval(oldInteractionId, turnId),
      kind: "interactionRequested",
      sessionId,
    });
    yield* appendHarnessSessionEvent(runId, paths, {
      failure: recoverableProviderFailure,
      kind: "sessionFailed",
      sessionId,
    });
    yield* appendHarnessSessionEvent(runId, paths, {
      kind: "sessionRecovered",
      sessionId,
    });
    yield* appendHarnessSessionEvent(runId, paths, {
      kind: "turnStarted",
      sessionId,
      turnId: recoveredTurnId,
    });
    yield* appendHarnessSessionEvent(runId, paths, {
      interaction: commandApproval(recoveredInteractionId, recoveredTurnId),
      kind: "interactionRequested",
      sessionId,
    });
    return rootDirectory;
  });
}

const recoverableProviderFailure = {
  code: "ProviderCrashed",
  kind: "providerFailure" as const,
  message: "Provider stopped unexpectedly.",
  recoverable: true,
};

function commandApproval(
  interactionId: typeof recoveredInteractionId,
  turnId: typeof recoveredTurnId
) {
  return {
    allowedDecisions: ["decline", "cancel"] as const,
    command: "pnpm gaia doctor --json",
    interactionId,
    itemId: parseHarnessItemId(`item-${interactionId}`),
    kind: "commandApproval" as const,
    reason: "Run doctor smoke",
    requestedAt: "2026-07-10T00:00:00.000Z",
    turnId,
    workspacePath: parseWorkspaceRelativePath("."),
  };
}

function fakeSession(
  calls: string[],
  resolutions: unknown[] = []
): HarnessSession {
  const snapshot = HarnessSessionSnapshot.make({
    capabilities,
    items: [],
    pendingInteractions: [],
    provider,
    recovered: false,
    resolvedInteractions: [],
    sessionId,
    state: "running",
    turns: [{ status: "running", turnId }],
  });
  return {
    events: Stream.empty,
    interrupt: Option.some(Effect.void),
    resolveInteraction: (resolution) =>
      Effect.sync(() => {
        resolutions.push(resolution);
      }),
    send: () => Effect.succeed(undefined),
    snapshot: Effect.succeed(snapshot),
    steer: Option.some((input) =>
      Effect.sync(() => {
        calls.push(input.text);
      }).pipe(Effect.as(undefined))
    ),
  };
}

function actionDigestForInterrupt(
  actionId: ReturnType<typeof parseHarnessActionId>
) {
  const canonical = `{"actionId":"${actionId}","agentId":"agent-worker","kind":"interrupt","runId":"${runId}","sessionId":"${sessionId}","turnId":"${turnId}"}`;
  return createHash("sha256").update(canonical).digest("hex");
}
