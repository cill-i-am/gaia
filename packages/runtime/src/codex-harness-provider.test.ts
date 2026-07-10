import {
  parseHarnessActionId,
  parseHarnessInteractionId,
  parseHarnessSessionId,
  parseWorkspaceRelativePath,
} from "@gaia/core";
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Option, Stream } from "effect";
import {
  type CodexAppServerClient,
} from "./codex-app-server-client.js";
import {
  parseCodexThreadId,
  parseCodexTurnId,
  parseCodexItemId,
  type CodexNotification,
  type CodexAppServerError,
  type CodexServerRequest,
  CodexAppServerIncompatibilityError,
  CodexAppServerTransportError,
} from "./codex-app-server-protocol.js";
import {
  createCodexHarnessProvider,
  makeInMemoryCodexHarnessCorrelationStore,
} from "./codex-harness-provider.js";
import { resumeHarnessSession, startHarnessSession } from "./harness-session.js";

function recordingClient() {
  const notifications = new Set<(notification: CodexNotification) => void>();
  const requests = new Set<(request: CodexServerRequest) => void>();
  const terminations = new Set<(error: CodexAppServerError) => void>();
  const starts: Array<unknown> = [];
  const initializations: Array<unknown> = [];
  const fileResponses: Array<unknown> = [];
  const permissionResponses: Array<unknown> = [];
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
    onTermination: (listener) => { terminations.add(listener); return () => terminations.delete(listener); },
    readThread: (params) => {
      reads.push(params);
      return Effect.succeed({
        thread: { id: threadId, status: { type: "idle" as const }, turns: [] },
      });
    },
    respondCommandApproval: () => Effect.void,
    respondElicitation: () => Effect.void,
    respondFileApproval: (_request, response) => Effect.sync(() => { fileResponses.push(response); }),
    respondPermissionApproval: (_request, response) => Effect.sync(() => { permissionResponses.push(response); }),
    respondUserInput: () => Effect.void,
    resumeThread: () => Effect.succeed({ thread: { id: threadId } }),
    startThread: (params) => { starts.push(params); return Effect.succeed({ thread: { id: threadId } }); },
    startTurn: (params) => { starts.push(params); return Effect.succeed({ turn: { id: turnId, status: "inProgress" as const } }); },
    steerTurn: () => Effect.succeed({ turnId }),
  } satisfies CodexAppServerClient;
  return {
    client,
    fileResponses,
    initializations,
    notifications,
    permissionResponses,
    reads,
    requests,
    starts,
    terminations,
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

  it("rejects a resumed native thread that differs from stored correlation before reading it", async () => {
    const sessionId = parseHarnessSessionId("session-codex-resume-mismatch");
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
    const mismatchedThreadId = parseCodexThreadId("different-native-thread");
    const client: CodexAppServerClient = {
      ...second.client,
      resumeThread: () =>
        Effect.succeed({ thread: { id: mismatchedThreadId } }),
    };
    const error = await Effect.runPromise(
      Effect.scoped(
        resumeHarnessSession({
          provider: createCodexHarnessProvider({
            client,
            correlationStore,
            workspaceRoot: "/workspace",
          }),
          request: {
            sessionId,
            workspacePath: parseWorkspaceRelativePath("project"),
          },
          requiredCapabilities: [],
        }).pipe(Effect.flip),
      ),
    );

    expect(error._tag).toBe("HarnessResumeError");
    if (error._tag !== "HarnessResumeError") {
      throw new Error(`Unexpected error: ${error._tag}`);
    }
    expect(error.message).toBe(
      "Codex resumed a thread that does not match stored session correlation.",
    );
    expect(second.reads).toEqual([]);
  });

  it("rejects a read native thread that differs from stored correlation", async () => {
    const sessionId = parseHarnessSessionId("session-codex-read-mismatch");
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
    const mismatchedThreadId = parseCodexThreadId("foreign-read-thread");
    const client: CodexAppServerClient = {
      ...second.client,
      readThread: (params) =>
        second.client.readThread(params).pipe(
          Effect.map((result) => ({
            thread: { ...result.thread, id: mismatchedThreadId },
          })),
        ),
    };
    const error = await Effect.runPromise(
      Effect.scoped(
        resumeHarnessSession({
          provider: createCodexHarnessProvider({
            client,
            correlationStore,
            workspaceRoot: "/workspace",
          }),
          request: {
            sessionId,
            workspacePath: parseWorkspaceRelativePath("project"),
          },
          requiredCapabilities: [],
        }).pipe(Effect.flip),
      ),
    );

    expect(error._tag).toBe("HarnessResumeError");
    if (error._tag !== "HarnessResumeError") {
      throw new Error(`Unexpected error: ${error._tag}`);
    }
    expect(error.message).toBe(
      "Codex read a thread that does not match stored session correlation.",
    );
    expect(second.reads).toEqual([
      { includeTurns: true, threadId: second.threadId },
    ]);
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

  it("reports the Gaia originator version from an incompatibility", async () => {
    const fake = recordingClient();
    const client: CodexAppServerClient = {
      ...fake.client,
      initialize: () =>
        Effect.fail(
          new CodexAppServerIncompatibilityError({
            actualUserAgent: "gaia/0.136.0 test",
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

  it("records an authoritative failure and ignores provider input after exhausting the live event buffer", async () => {
    const fake = recordingClient();
    const sessionId = parseHarnessSessionId("session-codex-buffer-limit");
    const snapshots = await Effect.runPromise(
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
                params: {
                  message: `warning ${index}`,
                  threadId: fake.threadId,
                },
              });
            }
          }
          const failed = yield* session.snapshot;
          for (const listener of fake.notifications) {
            listener({
              method: "item/completed",
              params: {
                item: {
                  id: parseCodexItemId("post-terminal-item"),
                  phase: "final_answer",
                  text: "must be ignored",
                  type: "agentMessage",
                },
                threadId: fake.threadId,
                turnId: parseCodexTurnId("post-terminal-turn"),
              },
            });
          }
          return { failed, afterProviderInput: yield* session.snapshot };
        }),
      ),
    );

    expect(snapshots.failed.state).toBe("failed");
    expect(snapshots.failed.failure).toMatchObject({
      code: "CodexEventBufferExceeded",
      kind: "providerFailure",
    });
    expect(snapshots.afterProviderInput).toEqual(snapshots.failed);
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
                environmentId: null,
                itemId: parseCodexItemId("native-permission-item"),
                permissions: { fileSystem: null, network: null },
                reason: "permission",
                startedAtMs: 1,
                threadId: fake.threadId,
                turnId: fake.turnId,
              },
            });
          }
          const waiting = yield* session.snapshot;
          const pendingInteraction = waiting.pendingInteractions[0];
          if (pendingInteraction === undefined) {
            throw new Error("Expected a pending permission interaction.");
          }
          const interactionId = pendingInteraction.interactionId;
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

  it("fails the session with a typed terminal event when the shared client terminates", async () => {
    const fake = recordingClient();
    const sessionId = parseHarnessSessionId("session-codex-termination");
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
          for (const listener of fake.terminations) {
            listener(
              new CodexAppServerTransportError({
                message: "connection closed",
              }),
            );
          }
          return yield* session.snapshot;
        }),
      ),
    );

    expect(snapshot.state).toBe("failed");
    expect(snapshot.failure).toMatchObject({
      code: "CodexAppServerTerminated",
      kind: "providerFailure",
    });
  });

  it("terminates the live stream and action surface on a provider system error", async () => {
    const fake = recordingClient();
    const sessionId = parseHarnessSessionId("session-codex-system-terminal");
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
          const observed: Array<unknown> = [];
          const streamFiber = yield* session.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                observed.push(event);
              }),
            ),
            Effect.exit,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          for (const listener of fake.notifications) {
            listener({
              method: "thread/status/changed",
              params: {
                status: { type: "systemError" },
                threadId: fake.threadId,
              },
            });
            listener({
              method: "warning",
              params: {
                message: "must be ignored after terminal failure",
                threadId: fake.threadId,
              },
            });
          }
          const send = yield* session
            .send({ text: "must not dispatch" })
            .pipe(Effect.exit);
          if (Option.isNone(session.steer) || Option.isNone(session.interrupt)) {
            throw new Error("Expected Codex steering and interruption operations.");
          }
          const steer = yield* session.steer.value({ text: "must not steer" }).pipe(
            Effect.exit,
          );
          const interrupt = yield* session.interrupt.value.pipe(Effect.exit);
          const resolveInteraction = yield* session
            .resolveInteraction({
              actionId: parseHarnessActionId("action-terminal-resolution"),
              decision: "decline",
              interactionId: parseHarnessInteractionId(
                "interaction-terminal-resolution",
              ),
              kind: "approval",
            })
            .pipe(Effect.exit);
          const stream = yield* Fiber.join(streamFiber).pipe(
            Effect.timeoutOption("1 second"),
          );
          return {
            interrupt,
            observed,
            resolveInteraction,
            send,
            snapshot: yield* session.snapshot,
            steer,
            stream,
          };
        }),
      ),
    );

    expect(Option.isSome(result.stream)).toBe(true);
    if (Option.isNone(result.stream)) {
      throw new Error("Expected the terminal session stream to close.");
    }
    expect(result.stream.value._tag).toBe("Failure");
    expect(result.send._tag).toBe("Failure");
    expect(result.steer._tag).toBe("Failure");
    expect(result.interrupt._tag).toBe("Failure");
    expect(result.resolveInteraction._tag).toBe("Failure");
    expect(fake.starts).toHaveLength(2);
    expect(result.snapshot.state).toBe("failed");
    expect(result.snapshot.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "warning",
          message: "must be ignored after terminal failure",
        }),
      ]),
    );
    expect(result.observed.at(-1)).toMatchObject({
      failure: expect.objectContaining({ code: "CodexThreadSystemError" }),
      kind: "sessionFailed",
    });
  });

  it("terminates the live stream when safe projection rejects provider output", async () => {
    const fake = recordingClient();
    const sessionId = parseHarnessSessionId("session-codex-projection-terminal");
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
          const observed: Array<unknown> = [];
          const streamFiber = yield* session.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                observed.push(event);
              }),
            ),
            Effect.exit,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          for (let index = 0; index < 1_001; index += 1) {
            for (const listener of fake.notifications) {
              listener({
                method: "item/agentMessage/delta",
                params: {
                  delta: "x",
                  itemId: parseCodexItemId(`projection-item-${index}`),
                  threadId: fake.threadId,
                  turnId: fake.turnId,
                },
              });
            }
          }
          return {
            observed,
            snapshot: yield* session.snapshot,
            stream: yield* Fiber.join(streamFiber).pipe(
              Effect.timeoutOption("1 second"),
            ),
          };
        }),
      ),
    );

    expect(Option.isSome(result.stream)).toBe(true);
    if (Option.isNone(result.stream)) {
      throw new Error("Expected projection rejection to close the stream.");
    }
    expect(result.stream.value._tag).toBe("Failure");
    expect(result.snapshot.failure).toMatchObject({
      code: "CodexProjectionRejected",
    });
    expect(result.observed.at(-1)).toMatchObject({
      failure: expect.objectContaining({ code: "CodexProjectionRejected" }),
      kind: "sessionFailed",
    });
  });

  it("records sessionStarted before synchronous termination replay during subscription", async () => {
    const sessionId = parseHarnessSessionId("session-codex-late-subscription");
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
    const client: CodexAppServerClient = {
      ...second.client,
      onTermination: (listener) => {
        listener(
          new CodexAppServerTransportError({ message: "already terminated" }),
        );
        return () => undefined;
      },
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* resumeHarnessSession({
            provider: createCodexHarnessProvider({
              client,
              correlationStore,
              workspaceRoot: "/workspace",
            }),
            request: {
              sessionId,
              workspacePath: parseWorkspaceRelativePath("project"),
            },
            requiredCapabilities: [],
          });
          return yield* session.snapshot.pipe(Effect.exit);
        }),
      ),
    );

    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") {
      throw new Error("Expected a projectable terminal session snapshot.");
    }
    expect(result.value.state).toBe("failed");
    expect(result.value.failure).toMatchObject({
      code: "CodexAppServerTerminated",
      kind: "providerFailure",
    });
  });

  it("rejects approval decisions that exceed the audited public scope before provider dispatch", async () => {
    const fake = recordingClient();
    const sessionId = parseHarnessSessionId("session-codex-audited-approval");
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
              id: "outside-file-request",
              method: "item/fileChange/requestApproval",
              params: {
                grantRoot: "/private/outside",
                itemId: parseCodexItemId("outside-file-item"),
                reason: "outside",
                startedAtMs: 1,
                threadId: fake.threadId,
                turnId: fake.turnId,
              },
            });
          }
          const waiting = yield* session.snapshot;
          const pendingInteraction = waiting.pendingInteractions[0];
          if (pendingInteraction === undefined) {
            throw new Error("Expected a pending file-change interaction.");
          }
          const interactionId = pendingInteraction.interactionId;
          const resolution = yield* session
            .resolveInteraction({
              actionId: parseHarnessActionId("action-outside-approve"),
              decision: "approve",
              interactionId,
              kind: "approval",
            })
            .pipe(Effect.exit);
          return { resolution, snapshot: yield* session.snapshot };
        }),
      ),
    );

    expect(result.resolution._tag).toBe("Failure");
    expect(fake.fileResponses).toEqual([]);
    expect(result.snapshot.pendingInteractions[0]).toMatchObject({
      allowedDecisions: ["decline", "cancel"],
      kind: "fileChangeApproval",
    });
  });

  it("constructs permission approval responses from the audited neutral scope", async () => {
    const fake = recordingClient();
    const sessionId = parseHarnessSessionId("session-codex-permission-response");
    await Effect.runPromise(
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
              id: "permission-request",
              method: "item/permissions/requestApproval",
              params: {
                cwd: "/workspace/project",
                environmentId: null,
                itemId: parseCodexItemId("permission-item"),
                permissions: {
                  fileSystem: {
                    entries: [
                      {
                        access: "write",
                        path: {
                          path: "/workspace/project/src",
                          type: "path",
                        },
                      },
                    ],
                    read: null,
                    write: null,
                  },
                  network: { enabled: false },
                },
                reason: "write src",
                startedAtMs: 1,
                threadId: fake.threadId,
                turnId: fake.turnId,
              },
            });
          }
          const waiting = yield* session.snapshot;
          const pendingInteraction = waiting.pendingInteractions[0];
          if (pendingInteraction === undefined) {
            throw new Error("Expected a pending permission interaction.");
          }
          yield* session.resolveInteraction({
            actionId: parseHarnessActionId("action-permission-approve"),
            decision: "approve",
            interactionId: pendingInteraction.interactionId,
            kind: "approval",
          });
        }),
      ),
    );

    expect(fake.permissionResponses).toEqual([
      {
        permissions: {
          fileSystem: {
            entries: [
              {
                access: "write",
                path: {
                  path: "/workspace/project/src",
                  type: "path",
                },
              },
            ],
            read: null,
            write: null,
          },
          network: { enabled: false },
        },
        scope: "turn",
      },
    ]);
  });
});
