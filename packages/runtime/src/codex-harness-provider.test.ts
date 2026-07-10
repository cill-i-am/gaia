import {
  parseHarnessActionId,
  parseHarnessSessionId,
  parseWorkspaceRelativePath,
} from "@gaia/core";
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import {
  type CodexAppServerClient,
} from "./codex-app-server-client.js";
import {
  parseCodexThreadId,
  parseCodexTurnId,
  parseCodexItemId,
  type CodexNotification,
  type CodexServerRequest,
  CodexAppServerIncompatibilityError,
} from "./codex-app-server-protocol.js";
import {
  createCodexHarnessProvider,
  makeInMemoryCodexHarnessCorrelationStore,
} from "./codex-harness-provider.js";
import { resumeHarnessSession, startHarnessSession } from "./harness-session.js";

function recordingClient() {
  const notifications = new Set<(notification: CodexNotification) => void>();
  const requests = new Set<(request: CodexServerRequest) => void>();
  const starts: Array<unknown> = [];
  const initializations: Array<unknown> = [];
  const reads: Array<unknown> = [];
  const threadId = parseCodexThreadId("native-thread-private");
  const turnId = parseCodexTurnId("native-turn-private");
  const client = {
    initialize: (params) => {
      initializations.push(params);
      return Effect.succeed({ platformFamily: "unix", platformOs: "macos", userAgent: "Codex/0.137.0" });
    },
    interruptTurn: () => Effect.succeed({}),
    onNotification: (listener) => { notifications.add(listener); return () => notifications.delete(listener); },
    onServerRequest: (listener) => { requests.add(listener); return () => requests.delete(listener); },
    readThread: (params) => {
      reads.push(params);
      return Effect.succeed({
        thread: { id: threadId, status: { type: "idle" as const }, turns: [] },
      });
    },
    respondCommandApproval: () => Effect.void,
    respondElicitation: () => Effect.void,
    respondFileApproval: () => Effect.void,
    respondPermissionApproval: () => Effect.void,
    respondUserInput: () => Effect.void,
    resumeThread: () => Effect.succeed({ thread: { id: threadId } }),
    startThread: (params) => { starts.push(params); return Effect.succeed({ thread: { id: threadId } }); },
    startTurn: (params) => { starts.push(params); return Effect.succeed({ turn: { id: turnId, status: "inProgress" as const } }); },
    steerTurn: () => Effect.succeed({ turnId }),
  } satisfies CodexAppServerClient;
  return {
    client,
    initializations,
    notifications,
    reads,
    requests,
    starts,
    threadId,
    turnId,
  };
}

describe("Codex HarnessProvider adapter", () => {
  it("implements the neutral SPI while keeping Codex correlation adapter-private", async () => {
    const fake = recordingClient();
    const sessionId = parseHarnessSessionId("session-codex-provider");
    const correlationStore = makeInMemoryCodexHarnessCorrelationStore();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* startHarnessSession({
            provider: createCodexHarnessProvider({
              client: fake.client,
              correlationStore,
              sensitiveValues: ["provider-secret"],
              workspaceRoot: "/workspace",
            }),
            request: {
              input: { text: "Implement the issue" },
              sessionId,
              workspacePath: parseWorkspaceRelativePath("project"),
            },
            requiredCapabilities: ["streamingMessages", "steering"],
          });
          const initial = yield* session.events.pipe(
            Stream.take(3),
            Stream.runCollect,
          );
          for (const listener of fake.notifications) {
            listener({
              method: "item/completed",
              params: {
                item: {
                  id: parseCodexItemId("native-item-private"),
                  memoryCitation: null,
                  phase: "final_answer",
                  text: "Done provider-secret",
                  type: "agentMessage",
                },
                threadId: fake.threadId,
                turnId: fake.turnId,
              },
            });
          }
          return {
            initial: Array.from(initial),
            snapshot: yield* session.snapshot,
          };
        }),
      ),
    );

    expect(fake.starts).toEqual([
      {
        approvalPolicy: "on-request",
        cwd: "/workspace/project",
        ephemeral: false,
        sandbox: "workspace-write",
      },
      {
        input: [{ text: "Implement the issue", type: "text" }],
        threadId: fake.threadId,
      },
    ]);
    expect(fake.initializations).toEqual([
      {
        clientInfo: { name: "gaia", title: "Gaia", version: "0.1.0" },
      },
    ]);
    expect(result.initial.map(({ kind }) => kind)).toEqual([
      "sessionStarted",
      "turnStarted",
      "sessionStateChanged",
    ]);
    const serialized = JSON.stringify(result.snapshot);
    expect(serialized).not.toContain("native-thread-private");
    expect(serialized).not.toContain("native-turn-private");
    expect(serialized).not.toContain("native-item-private");
    expect(serialized).not.toContain("provider-secret");
    expect(result.snapshot.items[0]).toMatchObject({
      kind: "message",
      text: "Done [REDACTED]",
    });
  });

  it("recovers through a reconstructed adapter using only its private correlation store", async () => {
    const sessionId = parseHarnessSessionId("session-codex-recovery");
    const correlationStore = makeInMemoryCodexHarnessCorrelationStore();
    const first = recordingClient();
    await Effect.runPromise(
      Effect.scoped(
        startHarnessSession({
          provider: createCodexHarnessProvider({
            client: first.client,
            correlationStore,
            workspaceRoot: "/workspace",
          }),
          request: {
            input: { text: "start" },
            sessionId,
            workspacePath: parseWorkspaceRelativePath("project"),
          },
          requiredCapabilities: ["resumableSessions"],
        }),
      ),
    );

    const second = recordingClient();
    const recovered = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* resumeHarnessSession({
            provider: createCodexHarnessProvider({
              client: second.client,
              correlationStore,
              workspaceRoot: "/workspace",
            }),
            request: {
              sessionId,
              workspacePath: parseWorkspaceRelativePath("project"),
            },
            requiredCapabilities: [],
          });
          const initial = yield* session.events.pipe(
            Stream.take(3),
            Stream.runCollect,
          );
          return {
            initial: Array.from(initial),
            snapshot: yield* session.snapshot,
          };
        }),
      ),
    );

    expect(second.reads).toEqual([
      { includeTurns: true, threadId: second.threadId },
    ]);
    expect(recovered.initial.map(({ kind }) => kind)).toEqual([
      "sessionStarted",
      "sessionRecovered",
      "sessionStateChanged",
    ]);
    expect(recovered.snapshot.recovered).toBe(true);
    expect(recovered.snapshot.state).toBe("idle");
  });

  it("reports initialize incompatibility instead of claiming availability", async () => {
    const fake = recordingClient();
    const client: CodexAppServerClient = {
      ...fake.client,
      initialize: () =>
        Effect.fail(
          new CodexAppServerIncompatibilityError({
            actualUserAgent: "Codex/0.136.0 test",
            supportedVersion: "0.137.0",
          }),
        ),
    };
    const detection = await Effect.runPromise(
      createCodexHarnessProvider({
        client,
        correlationStore: makeInMemoryCodexHarnessCorrelationStore(),
        workspaceRoot: "/workspace",
      }).detect,
    );

    expect(detection).toMatchObject({
      state: "incompatible",
      version: "0.136.0",
    });
    expect(fake.starts).toEqual([]);
  });

  it("shares one initialize handshake across concurrent detection", async () => {
    const fake = recordingClient();
    const client: CodexAppServerClient = {
      ...fake.client,
      initialize: (params) =>
        Effect.sleep("10 millis").pipe(
          Effect.andThen(fake.client.initialize(params)),
        ),
    };
    const provider = createCodexHarnessProvider({
      client,
      correlationStore: makeInMemoryCodexHarnessCorrelationStore(),
      workspaceRoot: "/workspace",
    });

    const detections = await Effect.runPromise(
      Effect.all([provider.detect, provider.detect], {
        concurrency: "unbounded",
      }),
    );

    expect(detections.map(({ state }) => state)).toEqual([
      "available",
      "available",
    ]);
    expect(fake.initializations).toHaveLength(1);
  });

  it("records an authoritative failure before exhausting the live event buffer", async () => {
    const fake = recordingClient();
    const sessionId = parseHarnessSessionId("session-codex-buffer-limit");
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* startHarnessSession({
            provider: createCodexHarnessProvider({
              client: fake.client,
              correlationStore: makeInMemoryCodexHarnessCorrelationStore(),
              workspaceRoot: "/workspace",
            }),
            request: {
              input: { text: "start" },
              sessionId,
              workspacePath: parseWorkspaceRelativePath("project"),
            },
            requiredCapabilities: [],
          });
          for (let index = 0; index < 1_997; index += 1) {
            for (const listener of fake.notifications) {
              listener({
                method: "warning",
                params: { message: `warning ${index}` },
              });
            }
          }
          return yield* session.snapshot;
        }),
      ),
    );

    expect(snapshot.state).toBe("failed");
    expect(snapshot.failure).toMatchObject({
      code: "CodexEventBufferExceeded",
      kind: "providerFailure",
    });
  });

  it("retires older-turn interactions without disturbing the newer active turn", async () => {
    const fake = recordingClient();
    const sessionId = parseHarnessSessionId("session-codex-stale-interaction");
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* startHarnessSession({
            provider: createCodexHarnessProvider({
              client: fake.client,
              correlationStore: makeInMemoryCodexHarnessCorrelationStore(),
              workspaceRoot: "/workspace",
            }),
            request: {
              input: { text: "start" },
              sessionId,
              workspacePath: parseWorkspaceRelativePath("project"),
            },
            requiredCapabilities: [],
          });
          for (const listener of fake.requests) {
            listener({
              id: 99,
              method: "item/permissions/requestApproval",
              params: {
                cwd: "/workspace/project",
                itemId: parseCodexItemId("native-permission-item"),
                permissions: {},
                reason: "permission",
                startedAtMs: 1,
                threadId: fake.threadId,
                turnId: fake.turnId,
              },
            });
          }
          const waiting = yield* session.snapshot;
          const interactionId = waiting.pendingInteractions[0]!.interactionId;
          const newerTurnId = parseCodexTurnId("native-newer-turn");
          for (const listener of fake.notifications) {
            listener({
              method: "turn/started",
              params: {
                threadId: fake.threadId,
                turn: { id: newerTurnId, status: "inProgress" },
              },
            });
            listener({
              method: "turn/completed",
              params: {
                threadId: fake.threadId,
                turn: { id: fake.turnId, status: "completed" },
              },
            });
          }
          const resolution = yield* session
            .resolveInteraction({
              actionId: parseHarnessActionId("action-stale-interaction"),
              decision: "decline",
              interactionId,
              kind: "approval",
            })
            .pipe(Effect.exit);
          return { resolution, snapshot: yield* session.snapshot };
        }),
      ),
    );

    expect(result.resolution._tag).toBe("Failure");
    expect(result.snapshot.pendingInteractions).toEqual([]);
    expect(result.snapshot.state).toBe("running");
  });
});
