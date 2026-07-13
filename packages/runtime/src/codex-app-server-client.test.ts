import { Effect, Fiber, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CodexAppServerSpawnConfig,
  makeCodexAppServerClient,
  makeCodexAppServerConnection,
  type CodexAppServerProcess,
} from "./codex-app-server-client.js";
import { parseCodexClientVersion } from "./codex-app-server-protocol.js";

function fakeProcess() {
  const lines = new Set<(line: string) => void>();
  const exits = new Set<(code: number | null) => void>();
  const errors = new Set<() => void>();
  const writes: Array<Record<string, unknown>> = [];
  let kills = 0;
  const process: CodexAppServerProcess = {
    kill: () => {
      kills += 1;
    },
    onError: (listener) => {
      errors.add(listener);
      return () => errors.delete(listener);
    },
    onExit: (listener) => {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    onLine: (listener) => {
      lines.add(listener);
      return () => lines.delete(listener);
    },
    stderr: () => "bounded stderr",
    write: (line) => writes.push(JSON.parse(line)),
  };
  return { errors, exits, kills: () => kills, lines, process, writes };
}

describe("Codex App Server connection", () => {
  it("schema-owns strict JSON-safe spawn data outside the process capability", () => {
    const decode = Schema.decodeUnknownSync(CodexAppServerSpawnConfig);
    const config = decode({
      command: "codex",
      cwd: "/tmp/gaia",
      env: { CODEX_HOME: "/tmp/codex-home" },
    });

    expect(Schema.encodeSync(CodexAppServerSpawnConfig)(config)).toEqual({
      command: "codex",
      cwd: "/tmp/gaia",
      env: { CODEX_HOME: "/tmp/codex-home" },
    });
    expect(() => decode({ command: "", cwd: "/tmp/gaia" })).toThrow();
    expect(() => decode({ cwd: "/tmp/gaia", extra: true })).toThrow();
    expect(() => decode({ env: { CODEX_HOME: undefined } })).toThrow();
  });

  it("correlates out-of-order responses and ignores duplicate or late responses", async () => {
    const fake = fakeProcess();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const first = yield* connection
            .request("first")
            .pipe(Effect.forkChild);
          const second = yield* connection
            .request("second")
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines)
            listener(JSON.stringify({ id: 2, result: { value: "second" } }));
          for (const listener of fake.lines)
            listener(JSON.stringify({ id: 1, result: { value: "first" } }));
          for (const listener of fake.lines)
            listener(JSON.stringify({ id: 1, result: { value: "late" } }));
          return [yield* Fiber.join(first), yield* Fiber.join(second)] as const;
        })
      )
    );
    expect(result).toEqual([{ value: "first" }, { value: "second" }]);
  });

  it("fails only the matching request for a malformed response and keeps the connection live", async () => {
    const fake = fakeProcess();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const terminations: Array<string> = [];
          connection.onTermination((error) => terminations.push(error._tag));
          const malformed = yield* connection
            .request("first")
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines)
            listener(JSON.stringify({ id: 1 }));
          const malformedExit = yield* Fiber.join(malformed);

          const healthy = yield* connection
            .request("second")
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines)
            listener(JSON.stringify({ id: 2, result: { ok: true } }));
          return {
            healthy: yield* Fiber.join(healthy),
            malformedExit,
            terminations: [...terminations],
          };
        })
      )
    );

    expect(result.malformedExit._tag).toBe("Failure");
    expect(result.healthy).toEqual({ ok: true });
    expect(result.terminations).toEqual([]);
  });

  it("fails only the matching request for an error response and keeps the connection live", async () => {
    const fake = fakeProcess();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const terminations: Array<string> = [];
          connection.onTermination((error) => terminations.push(error._tag));
          const rejected = yield* connection
            .request("first")
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines)
            listener(
              JSON.stringify({
                error: { code: -32_000, message: "Rejected" },
                id: 1,
              })
            );
          const rejectedExit = yield* Fiber.join(rejected);

          const healthy = yield* connection
            .request("second")
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines)
            listener(JSON.stringify({ id: 2, result: { ok: true } }));
          return {
            healthy: yield* Fiber.join(healthy),
            rejectedExit,
            terminations: [...terminations],
          };
        })
      )
    );

    expect(result.rejectedExit._tag).toBe("Failure");
    expect(result.healthy).toEqual({ ok: true });
    expect(result.terminations).toEqual([]);
  });

  it("scopes an invalid method result to its request and keeps the connection live", async () => {
    const fake = fakeProcess();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const client = makeCodexAppServerClient(connection);
          const terminations: Array<string> = [];
          connection.onTermination((error) => terminations.push(error._tag));
          const invalid = yield* client
            .initialize({
              clientInfo: {
                name: "gaia",
                title: "Gaia",
                version: parseCodexClientVersion("0.1.0"),
              },
            })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines)
            listener(
              JSON.stringify({
                id: 1,
                result: { codexHome: "/tmp/codex-home" },
              })
            );
          const invalidExit = yield* Fiber.join(invalid);

          const healthy = yield* connection
            .request("healthy")
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines)
            listener(JSON.stringify({ id: 2, result: { ok: true } }));
          return {
            healthy: yield* Fiber.join(healthy),
            invalidExit,
            terminations: [...terminations],
          };
        })
      )
    );

    expect(result.invalidExit._tag).toBe("Failure");
    expect(result.healthy).toEqual({ ok: true });
    expect(result.terminations).toEqual([]);
  });

  it("routes curated notifications and fails closed on unknown server requests", async () => {
    const fake = fakeProcess();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const notifications: Array<string> = [];
          const requests: Array<string> = [];
          connection.onNotification(({ method }) => notifications.push(method));
          connection.onServerRequest(({ method }) => requests.push(method));
          for (const listener of fake.lines)
            listener(
              JSON.stringify({
                method: "turn/started",
                params: {
                  threadId: "thr-1",
                  turn: { id: "turn-1", status: "inProgress" },
                },
              })
            );
          for (const listener of fake.lines)
            listener(
              JSON.stringify({ method: "reasoning/text/delta", params: {} })
            );
          for (const listener of fake.lines)
            listener(JSON.stringify({ id: 40, method: "fs/read", params: {} }));
          for (const listener of fake.lines)
            listener(
              JSON.stringify({
                id: 41,
                method: "item/tool/requestUserInput",
                params: { questions: "not-an-array" },
              })
            );
          expect(notifications).toEqual(["turn/started"]);
          expect(requests).toEqual([]);
          expect(fake.writes.at(-1)).toEqual({
            id: 41,
            error: { code: -32601, message: "Unsupported server request" },
          });
        })
      )
    );
  });

  it("never lets a hybrid server-request frame settle pending client work", async () => {
    const fake = fakeProcess();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const pending = yield* connection
            .request("first")
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines)
            listener(
              JSON.stringify({
                id: 1,
                method: "fs/read",
                params: {},
                result: { forged: true },
              })
            );
          for (const listener of fake.lines)
            listener(JSON.stringify({ id: 1, result: { ok: true } }));
          return yield* Fiber.join(pending);
        })
      )
    );

    expect(result).toEqual({ ok: true });
    expect(fake.writes.at(-1)).toEqual({
      id: 1,
      error: { code: -32601, message: "Unsupported server request" },
    });
  });

  it("terminates all pending work on an invalid JSONL frame", async () => {
    const fake = fakeProcess();
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const terminations: Array<string> = [];
          connection.onTermination((error) => terminations.push(error._tag));
          const pending = yield* connection
            .request("first")
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines) listener("{not-json");
          return {
            exit: yield* Fiber.join(pending),
            terminations: [...terminations],
          };
        })
      )
    );
    expect(result.exit._tag).toBe("Failure");
    expect(result.terminations).toEqual(["CodexAppServerProtocolError"]);
  });

  it("performs initialize followed by initialized and releases the process", async () => {
    const fake = fakeProcess();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const client = makeCodexAppServerClient(connection);
          const fiber = yield* client
            .initialize({
              clientInfo: {
                name: "gaia",
                title: "Gaia",
                version: parseCodexClientVersion("0.1.0"),
              },
            })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines)
            listener(
              JSON.stringify({
                id: 1,
                result: {
                  codexHome: "/tmp/codex-home",
                  userAgent: "Codex Desktop/0.137.0 (test)",
                  platformFamily: "unix",
                  platformOs: "macos",
                },
              })
            );
          yield* Fiber.join(fiber);
          expect(fake.writes.map(({ method }) => method)).toEqual([
            "initialize",
            "initialized",
          ]);
        })
      )
    );
    expect(fake.kills()).toBe(1);
  });

  it("parses stable thread/list responses with App Server source and cursors", async () => {
    const fake = fakeProcess();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const client = makeCodexAppServerClient(connection);
          const fiber = yield* client
            .listThreads({
              archived: false,
              cwd: "/tmp/gaia/workspace",
              limit: 100,
              sortDirection: "asc",
              sortKey: "created_at",
              sourceKinds: ["appServer"],
              useStateDbOnly: true,
            })
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(fake.writes.at(-1)).toMatchObject({
            method: "thread/list",
            params: {
              archived: false,
              cwd: "/tmp/gaia/workspace",
              limit: 100,
              sortDirection: "asc",
              sortKey: "created_at",
              sourceKinds: ["appServer"],
              useStateDbOnly: true,
            },
          });
          for (const listener of fake.lines)
            listener(
              JSON.stringify({
                id: 1,
                result: {
                  backwardsCursor: "back-1",
                  data: [
                    {
                      cliVersion: "0.137.0",
                      createdAt: 1_789_000_000,
                      cwd: "/tmp/gaia/workspace",
                      ephemeral: false,
                      forkedFromId: null,
                      id: "thread-1",
                      modelProvider: "openai",
                      parentThreadId: null,
                      path: null,
                      preview: "Fix",
                      sessionId: "session-1",
                      source: "appServer",
                      status: { type: "idle" },
                      threadSource: null,
                      agentNickname: null,
                      agentRole: null,
                      gitInfo: null,
                      name: null,
                      turns: [],
                      updatedAt: 1_789_000_001,
                    },
                  ],
                  nextCursor: null,
                },
              })
            );
          const result = yield* Fiber.join(fiber);
          expect(result.data[0]?.source).toBe("appServer");
          expect(result.data[0]?.cwd).toBe("/tmp/gaia/workspace");
          expect(result.backwardsCursor).toBe("back-1");
        })
      )
    );
  });

  it("fails every pending request exactly once when the process exits", async () => {
    const fake = fakeProcess();
    const tags = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const first = yield* connection
            .request("first")
            .pipe(Effect.exit, Effect.forkChild);
          const second = yield* connection
            .request("second")
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.exits) listener(17);
          for (const listener of fake.exits) listener(18);
          return [
            (yield* Fiber.join(first))._tag,
            (yield* Fiber.join(second))._tag,
          ];
        })
      )
    );
    expect(tags).toEqual(["Failure", "Failure"]);
  });

  it("notifies scoped listeners when the process exits without pending RPCs", async () => {
    const fake = fakeProcess();
    const tags = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const observed: Array<string> = [];
          connection.onTermination((error) => observed.push(error._tag));
          for (const listener of fake.exits) listener(17);
          for (const listener of fake.exits) listener(18);
          return observed;
        })
      )
    );

    expect(tags).toEqual(["CodexAppServerProcessExitError"]);
  });

  it("returns a typed timeout and ignores its late response", async () => {
    const fake = fakeProcess();
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          return yield* connection.request("slow", {}, 1).pipe(Effect.exit);
        })
      )
    );
    expect(exit._tag).toBe("Failure");
  });

  it("maps process startup errors into the typed transport channel", async () => {
    const fake = fakeProcess();
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const request = yield* connection
            .request("initialize")
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.errors) listener();
          return yield* Fiber.join(request);
        })
      )
    );
    expect(exit._tag).toBe("Failure");
  });

  it("rejects an incompatible initialized server", async () => {
    const fake = fakeProcess();
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const client = makeCodexAppServerClient(connection);
          const fiber = yield* client
            .initialize({
              clientInfo: {
                name: "gaia",
                title: "Gaia",
                version: parseCodexClientVersion("0.1.0"),
              },
            })
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          for (const listener of fake.lines)
            listener(
              JSON.stringify({
                id: 1,
                result: {
                  codexHome: "/tmp/codex-home",
                  userAgent: "Codex Desktop/0.136.0 (test)",
                  platformFamily: "unix",
                  platformOs: "macos",
                },
              })
            );
          return yield* Fiber.join(fiber);
        })
      )
    );
    expect(exit._tag).toBe("Failure");
  });

  it("returns a typed failure immediately when request write throws", async () => {
    const fake = fakeProcess();
    Object.defineProperty(fake.process, "write", {
      value: () => {
        throw new Error("closed");
      },
    });
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          return yield* connection
            .request("initialize", {}, 10_000)
            .pipe(Effect.exit);
        })
      )
    );
    expect(exit._tag).toBe("Failure");
  });

  it("routes all five generated stable request shapes and writes matching responses", async () => {
    const fake = fakeProcess();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const client = makeCodexAppServerClient(connection);
          let preserved = 0;
          client.onServerRequest((request) => {
            if (request.method === "item/commandExecution/requestApproval") {
              expect(request.params).toMatchObject({
                approvalId: "approval-1",
                commandActions: [{ type: "read" }],
                cwd: "/tmp",
                networkApprovalContext: { host: "example.com" },
                proposedExecpolicyAmendment: ["allow"],
                proposedNetworkPolicyAmendments: [{ host: "example.com" }],
                reason: "network",
              });
              preserved += 1;
              Effect.runFork(
                client.respondCommandApproval(request, { decision: "decline" })
              );
            } else if (request.method === "item/fileChange/requestApproval") {
              expect(request.params.grantRoot).toBe("/tmp/project");
              preserved += 1;
              Effect.runFork(
                client.respondFileApproval(request, { decision: "decline" })
              );
            } else if (request.method === "item/permissions/requestApproval") {
              expect(request.params).toMatchObject({
                environmentId: "env-1",
                reason: "write",
              });
              preserved += 1;
              Effect.runFork(
                client.respondPermissionApproval(request, {
                  permissions: {},
                  scope: "turn",
                })
              );
            } else if (request.method === "item/tool/requestUserInput") {
              expect(request.params.questions[0]).toMatchObject({
                isOther: true,
                isSecret: false,
                options: [{ description: "Continue", label: "Yes" }],
              });
              preserved += 1;
              Effect.runFork(
                client.respondUserInput(request, {
                  answers: { q1: { answers: ["no"] } },
                })
              );
            } else {
              expect(request.params).toMatchObject({
                message: "Choose",
                mode: "form",
                serverName: "test",
                threadId: "thr-1",
                turnId: null,
              });
              preserved += 1;
              Effect.runFork(
                client.respondElicitation(request, {
                  _meta: null,
                  action: "decline",
                  content: null,
                })
              );
            }
          });
          const base = {
            itemId: "item-1",
            startedAtMs: 1,
            threadId: "thr-1",
            turnId: "turn-1",
          };
          const fixtures = [
            {
              id: 1,
              method: "item/commandExecution/requestApproval",
              params: {
                ...base,
                approvalId: "approval-1",
                commandActions: [{ type: "read" }],
                cwd: "/tmp",
                networkApprovalContext: { host: "example.com" },
                proposedExecpolicyAmendment: ["allow"],
                proposedNetworkPolicyAmendments: [{ host: "example.com" }],
                reason: "network",
              },
            },
            {
              id: 2,
              method: "item/fileChange/requestApproval",
              params: { ...base, grantRoot: "/tmp/project", reason: null },
            },
            {
              id: 3,
              method: "item/permissions/requestApproval",
              params: {
                ...base,
                cwd: "/tmp",
                environmentId: "env-1",
                permissions: { fileSystem: null, network: null },
                reason: "write",
              },
            },
            {
              id: 4,
              method: "item/tool/requestUserInput",
              params: {
                itemId: "item-1",
                threadId: "thr-1",
                turnId: "turn-1",
                questions: [
                  {
                    header: "Choice",
                    id: "q1",
                    isOther: true,
                    isSecret: false,
                    options: [{ description: "Continue", label: "Yes" }],
                    question: "Continue?",
                  },
                ],
              },
            },
            {
              id: 5,
              method: "mcpServer/elicitation/request",
              params: {
                _meta: null,
                message: "Choose",
                mode: "form",
                requestedSchema: { properties: {}, type: "object" },
                serverName: "test",
                threadId: "thr-1",
                turnId: null,
              },
            },
          ];
          for (const fixture of fixtures)
            for (const listener of fake.lines)
              listener(JSON.stringify(fixture));
          yield* Effect.yieldNow;
          expect(
            fake.writes.filter(({ result }) => result !== undefined)
          ).toHaveLength(5);
          expect(preserved).toBe(5);
        })
      )
    );
  });

  it("preserves warning targets and accepts source-exact large file-change notifications", async () => {
    const fake = fakeProcess();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const notifications: Array<unknown> = [];
          const terminations: Array<string> = [];
          connection.onNotification((notification) =>
            notifications.push(notification)
          );
          connection.onTermination((error) => terminations.push(error._tag));
          for (const listener of fake.lines) {
            listener(
              JSON.stringify({
                method: "warning",
                params: { message: "owned", threadId: "thread-1" },
              })
            );
            listener(
              JSON.stringify({
                method: "warning",
                params: { message: "global-omitted" },
              })
            );
            listener(
              JSON.stringify({
                method: "warning",
                params: { message: "global-null", threadId: null },
              })
            );
            listener(
              JSON.stringify({
                method: "item/completed",
                params: {
                  completedAtMs: 1,
                  item: {
                    changes: Array.from({ length: 201 }, (_, index) => ({
                      diff: "+safe",
                      kind: { type: "add" },
                      path: `/workspace/src/file-${index}.ts`,
                    })),
                    id: "large-file-change",
                    status: "completed",
                    type: "fileChange",
                  },
                  threadId: "thread-1",
                  turnId: "turn-1",
                },
              })
            );
            listener(
              JSON.stringify({
                method: "item/fileChange/outputDelta",
                params: {
                  delta: "updated file",
                  itemId: "file-change-1",
                  threadId: "thread-1",
                  turnId: "turn-1",
                },
              })
            );
            listener(
              JSON.stringify({
                method: "item/fileChange/patchUpdated",
                params: {
                  changes: [
                    {
                      diff: "@@ -1 +1 @@",
                      kind: { move_path: null, type: "update" },
                      path: "/workspace/src/file.ts",
                    },
                  ],
                  itemId: "file-change-1",
                  threadId: "thread-1",
                  turnId: "turn-1",
                },
              })
            );
          }

          expect(terminations).toEqual([]);
          expect(notifications).toHaveLength(6);
          expect(notifications[0]).toMatchObject({
            method: "warning",
            params: { threadId: "thread-1" },
          });
          expect(notifications[1]).toMatchObject({
            method: "warning",
            params: { message: "global-omitted" },
          });
          expect(notifications[2]).toMatchObject({
            method: "warning",
            params: { message: "global-null", threadId: null },
          });
          expect(notifications[3]).toMatchObject({
            method: "item/completed",
          });
          const large = notifications[3] as {
            readonly params: {
              readonly item: { readonly changes: ReadonlyArray<unknown> };
            };
          };
          expect(large.params.item.changes).toHaveLength(201);
          expect(
            notifications
              .slice(4)
              .map((value) => (value as { readonly method: string }).method)
          ).toEqual([
            "item/fileChange/outputDelta",
            "item/fileChange/patchUpdated",
          ]);
        })
      )
    );
  });

  it("turns malformed known notifications into a typed connection termination", async () => {
    const fake = fakeProcess();
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const failures: Array<string> = [];
          const notifications: Array<string> = [];
          connection.onTermination((error) => failures.push(error._tag));
          connection.onNotification(({ method }) => notifications.push(method));
          for (const listener of fake.lines) {
            listener(
              JSON.stringify({
                method: "item/completed",
                params: {
                  completedAtMs: 1,
                  item: {
                    changes: "not-an-array",
                    id: "bad-file-change",
                    status: "completed",
                    type: "fileChange",
                  },
                  threadId: "thread-1",
                  turnId: "turn-1",
                },
              })
            );
          }
          return { failures, notifications };
        })
      )
    );

    expect(observed.failures).toEqual(["CodexAppServerProtocolError"]);
    expect(observed.notifications).toEqual([]);
  });

  it("rejects invalid outbound params before transport write", async () => {
    const fake = fakeProcess();
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const client = makeCodexAppServerClient(connection);
          return yield* client
            .startTurn({ threadId: 1, input: [] } as never)
            .pipe(Effect.exit);
        })
      )
    );
    expect(exit._tag).toBe("Failure");
    expect(fake.writes).toHaveLength(0);
  });

  it("fails pending work through the typed channel when unknown-request rejection cannot be written", async () => {
    const fake = fakeProcess();
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makeCodexAppServerConnection({
            process: fake.process,
          });
          const pending = yield* connection
            .request("initialize")
            .pipe(Effect.exit, Effect.forkChild);
          yield* Effect.yieldNow;
          Object.defineProperty(fake.process, "write", {
            value: () => {
              throw new Error("closed");
            },
          });
          for (const listener of fake.lines)
            listener(JSON.stringify({ id: 99, method: "fs/read", params: {} }));
          return yield* Fiber.join(pending);
        })
      )
    );
    expect(exit._tag).toBe("Failure");
  });
});
