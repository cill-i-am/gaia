import { createHash } from "node:crypto";
import { readFile, symlink } from "node:fs/promises";
import { createServer } from "node:net";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  makeRunEvent,
  parseHarnessEvent,
  parseHarnessProfileId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseRunId,
  parseWorkerRecoveryActionId,
  parseWorkerRecoveryDigest,
  parseWorkerRecoveryModelId,
  projectHarnessEvents,
  RunEvent,
  WorkerRecoveryAction,
  type HarnessDetection,
  type ServerMetadata,
} from "@gaia/core";
import {
  makeHarnessProviderRegistry,
  CodexListedThreadSchema,
  parseHarnessCheckpointToken,
  parseCodexThreadId,
  recoverWorkerSession,
  WorkerRecoveryModel,
  WorkerRecoveryTurnStarted,
  WorkerRecoveryThreadState,
  ThreadListResultSchema,
  ThreadResultSchema,
  type ThreadListParams,
  type ThreadReadParams,
  type WorkerRecoveryThreadStatus,
  type HarnessProvider,
  type HarnessProviderRegistry,
} from "@gaia/runtime";
import { makeRunPaths } from "@gaia/runtime/paths";
import { readLocalRunEvents } from "@gaia/runtime/run-read-api";
import {
  acceptFactoryRun,
  acceptServerRun,
} from "@gaia/runtime/server-workflows";
import {
  makeTestHarnessProviderRegistry,
  testHarnessCapabilities,
  testHarnessProvider,
} from "@gaia/runtime/test-support";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";

import {
  findStableDesktopOriginCorrelationThread,
  listStableCodexThreadsForWorkspace,
  makeProductionWorkerRecoveryProvider,
  projectWorkerRecoveryThreadState,
  resolveAuditedWorkerWorkspacePath,
  runLocalGaiaServer,
  toWorkerRecoveryThreadStatus,
} from "./main.js";

describe("local Gaia server process", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "detects before direct recovery model catalog and reaches preflight",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeWorkerRecoveryFixture();
          const calls: string[] = [];
          let detected = false;
          const provider = makeProductionWorkerRecoveryProvider({
            detect: Effect.sync(() => {
              calls.push("detect");
              detected = true;
              return {
                auth: { state: "notRequired" },
                capabilities: testHarnessCapabilities,
                state: "available",
                version: "test-1",
              };
            }),
            listModels: () =>
              Effect.sync(() => {
                calls.push(
                  detected ? "model/list" : "model/list-before-detect"
                );
                return [workerRecoveryModel()];
              }),
            readThread: () =>
              Effect.sync(() => {
                calls.push("read");
                return workerRecoveryThreadState("systemError");
              }),
            resumeThread: () =>
              Effect.sync(() => {
                calls.push("resume");
                return workerRecoveryThreadState("idle");
              }),
            startTurn: ({ model }) =>
              Effect.sync(() => {
                calls.push(`start:${model}`);
                return workerRecoveryStartTurn("turn-recovery");
              }),
          });
          const result = yield* recoverWorkerSession(
            fixture.runId,
            workerRecoveryAction,
            {
              provider,
              rootDirectory: fixture.root,
              validateWorkspace: () => Effect.void,
            }
          );

          assert.strictEqual(result.state, "dispatchConfirmed");
          assert.deepEqual(calls, [
            "detect",
            "model/list",
            "resume",
            "read",
            "start:gpt-5.4",
          ]);
        })
    );
    it("normalizes finite App Server thread statuses for recovery preflight", () => {
      assert.strictEqual(toWorkerRecoveryThreadStatus("idle"), "idle");
      assert.strictEqual(
        toWorkerRecoveryThreadStatus("notLoaded"),
        "notLoaded"
      );
      assert.strictEqual(
        toWorkerRecoveryThreadStatus("systemError"),
        "systemError"
      );
      assert.strictEqual(toWorkerRecoveryThreadStatus("active"), "active");
      assert.strictEqual(toWorkerRecoveryThreadStatus(undefined), "unknown");
      assert.strictEqual(toWorkerRecoveryThreadStatus("paused"), "unknown");
    });

    it.effect("rejects mismatched read and resume thread responses", () =>
      Effect.gen(function* () {
        const expected = parseCodexThreadId("expected-thread");
        const mismatched = Schema.decodeUnknownSync(ThreadResultSchema)({
          thread: { id: "other-thread", status: { type: "idle" } },
        }).thread;

        for (const operation of ["readThread", "resumeThread"] as const) {
          const exit = yield* projectWorkerRecoveryThreadState(
            expected,
            mismatched,
            operation
          ).pipe(Effect.exit);
          assert.strictEqual(exit._tag, "Failure");
          assert.include(JSON.stringify(exit), operation);
        }
      })
    );

    it.effect(
      "fails closed when stable App Server thread pagination repeats a cursor",
      () =>
        Effect.gen(function* () {
          let calls = 0;
          const exit = yield* listStableCodexThreadsForWorkspace(
            {
              listThreads: () =>
                Effect.gen(function* () {
                  calls += 1;
                  yield* Effect.yieldNow;
                  return {
                    backwardsCursor: null,
                    data: [],
                    nextCursor: "cursor-a",
                  };
                }),
            },
            "/tmp/gaia/workspace"
          ).pipe(Effect.timeout("250 millis"), Effect.exit);

          assert.strictEqual(exit._tag, "Failure");
          assert.include(JSON.stringify(exit), "HarnessCorrelationUnavailable");
          assert.isAtMost(calls, 3);
        })
    );

    it.effect(
      "accepts one Desktop-originated vscode candidate when state stores and checkpoint agree",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const threadId = parseCodexThreadId("desktop-origin-thread");
            const turnId = "interrupted-turn";
            const client = makeStableThreadClient({
              readTurns: [
                { id: "older-completed-turn", status: "completed" as const },
                { id: turnId, status: "interrupted" as const },
              ],
              threads: [stableThread({ id: threadId, source: "vscode" })],
            });

            const result = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId(turnId),
              workspacePath: "/tmp/gaia/owned-workspace",
            });

            assert.strictEqual(result.threadId, threadId);
            assert.deepEqual(yield* Ref.get(client.calls), {
              list: [
                "state:open:appServer,vscode",
                "state:archived:appServer,vscode",
                "jsonl:open:appServer,vscode",
                "jsonl:archived:appServer,vscode",
              ],
              read: [threadId],
            });
          })
        )
    );

    it.effect(
      "resolves the persisted workspace-relative event path to the private owned workspace cwd",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const fixture = yield* makeAuditedWorkspacePathFixture("workspace");
            const inspected = yield* Ref.make(0);
            const workspacePath = yield* resolveAuditedWorkerWorkspacePath({
              events: fixture.events,
              inspectOwnership: () =>
                Ref.update(inspected, (value) => value + 1),
              paths: fixture.paths,
              rootDirectory: fixture.root,
            });
            const threadId = parseCodexThreadId(
              "desktop-relative-workspace-thread"
            );
            const client = makeStableThreadClient({
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              threads: [
                stableThread({
                  cwd: workspacePath,
                  id: threadId,
                  source: "vscode",
                }),
              ],
            });

            const result = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath,
            });

            assert.strictEqual(result.threadId, threadId);
            assert.strictEqual(workspacePath, fixture.canonicalWorkspace);
            assert.strictEqual(yield* Ref.get(inspected), 1);
            assert.deepEqual((yield* Ref.get(client.calls)).read, [threadId]);
          })
        )
    );

    it.effect(
      "rejects unsafe persisted workspace event paths before stable list/read",
      () =>
        Effect.gen(function* () {
          const cases = [
            "../workspace",
            "/tmp/gaia/absolute-workspace",
            "C:\\workspace",
            "workspace\u0000",
            "",
            "workspace/child",
            "workspace-link",
          ] as const;

          for (const workspacePath of cases) {
            const fixture =
              yield* makeAuditedWorkspacePathFixture(workspacePath);
            if (workspacePath === "workspace/child") {
              const fs = yield* FileSystem.FileSystem;
              yield* fs.makeDirectory(`${fixture.paths.workspace}/child`, {
                recursive: true,
              });
            }
            if (workspacePath === "workspace-link") {
              const fs = yield* FileSystem.FileSystem;
              const outside = yield* fs.makeTempDirectory({
                prefix: "gaia-workspace-escape-",
              });
              yield* Effect.tryPromise({
                try: () =>
                  symlink(outside, `${fixture.paths.root}/workspace-link`),
                catch: (cause) => cause,
              });
            }
            const inspected = yield* Ref.make(0);
            const client = makeStableThreadClient({
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              threads: [
                stableThread({
                  cwd: fixture.canonicalWorkspace,
                  id: parseCodexThreadId("unsafe-workspace-thread"),
                  source: "vscode",
                }),
              ],
            });

            const exit = yield* resolveAuditedWorkerWorkspacePath({
              events: fixture.events,
              inspectOwnership: () =>
                Ref.update(inspected, (value) => value + 1),
              paths: fixture.paths,
              rootDirectory: fixture.root,
            }).pipe(
              Effect.flatMap((resolvedWorkspacePath) =>
                findStableDesktopOriginCorrelationThread({
                  acceptedAtSeconds: 1_000,
                  client,
                  expectedDigest: digestStableId("interrupted-turn"),
                  workspacePath: resolvedWorkspacePath,
                })
              ),
              Effect.exit
            );

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.deepEqual((yield* Ref.get(client.calls)).list, []);
            assert.deepEqual((yield* Ref.get(client.calls)).read, []);
            assert.strictEqual(yield* Ref.get(inspected), 0);
          }
        })
    );

    it.effect("rejects a missing owned workspace before stable list/read", () =>
      Effect.gen(function* () {
        const fixture = yield* makeAuditedWorkspacePathFixture("workspace");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(fixture.paths.workspace, { recursive: true });
        const inspected = yield* Ref.make(0);
        const client = makeStableThreadClient({
          readTurns: [
            { id: "interrupted-turn", status: "interrupted" as const },
          ],
          threads: [
            stableThread({
              cwd: fixture.canonicalWorkspace,
              id: parseCodexThreadId("missing-workspace-thread"),
              source: "vscode",
            }),
          ],
        });

        const exit = yield* resolveAuditedWorkerWorkspacePath({
          events: fixture.events,
          inspectOwnership: () => Ref.update(inspected, (value) => value + 1),
          paths: fixture.paths,
          rootDirectory: fixture.root,
        }).pipe(
          Effect.flatMap((resolvedWorkspacePath) =>
            findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: resolvedWorkspacePath,
            })
          ),
          Effect.exit
        );

        assert.strictEqual(exit._tag, "Failure");
        assert.include(JSON.stringify(exit), "HarnessCorrelationUnavailable");
        assert.deepEqual((yield* Ref.get(client.calls)).list, []);
        assert.deepEqual((yield* Ref.get(client.calls)).read, []);
        assert.strictEqual(yield* Ref.get(inspected), 0);
      })
    );

    it.effect(
      "rejects a symlinked owned workspace escape before stable list/read",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeAuditedWorkspacePathFixture("workspace");
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(fixture.paths.workspace, { recursive: true });
          const outside = yield* fs.makeTempDirectory({
            prefix: "gaia-workspace-escape-",
          });
          yield* Effect.tryPromise({
            try: () => symlink(outside, fixture.paths.workspace),
            catch: (cause) => cause,
          });
          const inspected = yield* Ref.make(0);
          const client = makeStableThreadClient({
            readTurns: [
              { id: "interrupted-turn", status: "interrupted" as const },
            ],
            threads: [
              stableThread({
                cwd: outside,
                id: parseCodexThreadId("symlink-workspace-thread"),
                source: "vscode",
              }),
            ],
          });

          const exit = yield* resolveAuditedWorkerWorkspacePath({
            events: fixture.events,
            inspectOwnership: () => Ref.update(inspected, (value) => value + 1),
            paths: fixture.paths,
            rootDirectory: fixture.root,
          }).pipe(
            Effect.flatMap((resolvedWorkspacePath) =>
              findStableDesktopOriginCorrelationThread({
                acceptedAtSeconds: 1_000,
                client,
                expectedDigest: digestStableId("interrupted-turn"),
                workspacePath: resolvedWorkspacePath,
              })
            ),
            Effect.exit
          );

          assert.strictEqual(exit._tag, "Failure");
          assert.include(JSON.stringify(exit), "HarnessCorrelationUnavailable");
          assert.notInclude(JSON.stringify(exit), outside);
          assert.deepEqual((yield* Ref.get(client.calls)).list, []);
          assert.deepEqual((yield* Ref.get(client.calls)).read, []);
          assert.strictEqual(yield* Ref.get(inspected), 0);
        })
    );

    it.effect(
      "rejects exact-owned absolute event paths before stable list/read",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeAuditedWorkspacePathFixture("workspace");
          const absoluteFixture = {
            ...fixture,
            events: workspacePathEvents(fixture.canonicalWorkspace),
          };
          const inspected = yield* Ref.make(0);
          const client = makeStableThreadClient({
            readTurns: [
              { id: "interrupted-turn", status: "interrupted" as const },
            ],
            threads: [
              stableThread({
                cwd: fixture.canonicalWorkspace,
                id: parseCodexThreadId("absolute-workspace-thread"),
                source: "vscode",
              }),
            ],
          });

          const exit = yield* resolveAuditedWorkerWorkspacePath({
            events: absoluteFixture.events,
            inspectOwnership: () => Ref.update(inspected, (value) => value + 1),
            paths: absoluteFixture.paths,
            rootDirectory: absoluteFixture.root,
          }).pipe(
            Effect.flatMap((resolvedWorkspacePath) =>
              findStableDesktopOriginCorrelationThread({
                acceptedAtSeconds: 1_000,
                client,
                expectedDigest: digestStableId("interrupted-turn"),
                workspacePath: resolvedWorkspacePath,
              })
            ),
            Effect.exit
          );

          assert.strictEqual(exit._tag, "Failure");
          assert.include(JSON.stringify(exit), "HarnessCorrelationUnavailable");
          assert.notInclude(JSON.stringify(exit), fixture.canonicalWorkspace);
          assert.deepEqual((yield* Ref.get(client.calls)).list, []);
          assert.deepEqual((yield* Ref.get(client.calls)).read, []);
          assert.strictEqual(yield* Ref.get(inspected), 0);
        })
    );

    it.effect(
      "rejects ownership inspection drift before stable list/read",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeAuditedWorkspacePathFixture("workspace");
          const inspected = yield* Ref.make(0);
          const client = makeStableThreadClient({
            readTurns: [
              { id: "interrupted-turn", status: "interrupted" as const },
            ],
            threads: [
              stableThread({
                cwd: fixture.canonicalWorkspace,
                id: parseCodexThreadId("ownership-drift-thread"),
                source: "vscode",
              }),
            ],
          });

          const exit = yield* resolveAuditedWorkerWorkspacePath({
            events: fixture.events,
            inspectOwnership: () =>
              Ref.update(inspected, (value) => value + 1).pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new Error("private wrong common-dir/base/registration")
                  )
                )
              ),
            paths: fixture.paths,
            rootDirectory: fixture.root,
          }).pipe(
            Effect.flatMap((resolvedWorkspacePath) =>
              findStableDesktopOriginCorrelationThread({
                acceptedAtSeconds: 1_000,
                client,
                expectedDigest: digestStableId("interrupted-turn"),
                workspacePath: resolvedWorkspacePath,
              })
            ),
            Effect.exit
          );

          assert.strictEqual(exit._tag, "Failure");
          assert.include(JSON.stringify(exit), "HarnessCorrelationUnavailable");
          assert.notInclude(JSON.stringify(exit), "private wrong common-dir");
          assert.deepEqual((yield* Ref.get(client.calls)).list, []);
          assert.deepEqual((yield* Ref.get(client.calls)).read, []);
          assert.strictEqual(yield* Ref.get(inspected), 1);
        })
    );

    it.effect(
      "fails closed before reading when vscode lacks private Desktop originator proof",
      () =>
        withCodexDesktopOriginator(
          undefined,
          Effect.gen(function* () {
            const threadId = parseCodexThreadId("unproved-vscode-thread");
            const client = makeStableThreadClient({
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              threads: [stableThread({ id: threadId, source: "vscode" })],
            });

            const exit = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            }).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.deepEqual((yield* Ref.get(client.calls)).read, []);
          })
        )
    );

    it.effect(
      "accepts one appServer candidate without Desktop originator proof",
      () =>
        withCodexDesktopOriginator(
          undefined,
          Effect.gen(function* () {
            const threadId = parseCodexThreadId("app-server-thread");
            const client = makeStableThreadClient({
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              threads: [stableThread({ id: threadId, source: "appServer" })],
            });

            const result = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            });

            assert.strictEqual(result.threadId, threadId);
            assert.deepEqual((yield* Ref.get(client.calls)).read, [threadId]);
          })
        )
    );

    it.effect(
      "fails closed before reading when appServer and vscode candidates collide",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const appServerThread = stableThread({
              id: parseCodexThreadId("app-server-thread"),
              source: "appServer",
            });
            const vscodeThread = stableThread({
              id: parseCodexThreadId("desktop-origin-thread"),
              source: "vscode",
            });
            const client = makeStableThreadClient({
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              threads: [appServerThread, vscodeThread],
            });

            const exit = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            }).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.deepEqual((yield* Ref.get(client.calls)).read, []);
          })
        )
    );

    it.effect(
      "fails closed before reading when candidate cwd or creation time is outside the accepted window",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const cases = [
              stableThread({
                cwd: "/tmp/gaia/other-workspace",
                id: parseCodexThreadId("wrong-cwd-thread"),
                source: "vscode",
              }),
              stableThread({
                createdAt: 100,
                id: parseCodexThreadId("wrong-time-thread"),
                source: "vscode",
              }),
              stableThread({
                createdAt: 1_301,
                id: parseCodexThreadId("late-time-thread"),
                source: "vscode",
              }),
            ];

            for (const thread of cases) {
              const client = makeStableThreadClient({
                readTurns: [
                  { id: "interrupted-turn", status: "interrupted" as const },
                ],
                threads: [thread],
              });

              const exit = yield* findStableDesktopOriginCorrelationThread({
                acceptedAtSeconds: 1_000,
                client,
                expectedDigest: digestStableId("interrupted-turn"),
                workspacePath: "/tmp/gaia/owned-workspace",
              }).pipe(Effect.exit);

              assert.strictEqual(exit._tag, "Failure");
              assert.include(
                JSON.stringify(exit),
                "HarnessCorrelationUnavailable"
              );
              assert.deepEqual((yield* Ref.get(client.calls)).read, []);
            }
          })
        )
    );

    it.effect(
      "fails closed before reading when stable list returns an unsupported source",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const client = makeStableThreadClient({
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              threads: [
                stableThread({
                  id: parseCodexThreadId("unsupported-source-thread"),
                  source: "cli",
                }),
              ],
            });

            const exit = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            }).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.deepEqual((yield* Ref.get(client.calls)).read, []);
          })
        )
    );

    it.effect(
      "fails closed without leaking raw App Server list or read errors",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const listed = makeStableThreadClient({
              listError: new Error("private list failure"),
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              threads: [
                stableThread({
                  id: parseCodexThreadId("list-error-thread"),
                  source: "vscode",
                }),
              ],
            });
            const read = makeStableThreadClient({
              readError: new Error("private read failure"),
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              threads: [
                stableThread({
                  id: parseCodexThreadId("read-error-thread"),
                  source: "vscode",
                }),
              ],
            });

            for (const client of [listed, read]) {
              const exit = yield* findStableDesktopOriginCorrelationThread({
                acceptedAtSeconds: 1_000,
                client,
                expectedDigest: digestStableId("interrupted-turn"),
                workspacePath: "/tmp/gaia/owned-workspace",
              }).pipe(Effect.exit);

              const text = JSON.stringify(exit);
              assert.strictEqual(exit._tag, "Failure");
              assert.include(text, "HarnessCorrelationUnavailable");
              assert.notInclude(text, "private list failure");
              assert.notInclude(text, "private read failure");
            }
          })
        )
    );

    it.effect(
      "fails closed before reading when state-db and JSONL thread identities disagree",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const client = makeStableThreadClient({
              jsonlThreads: [
                stableThread({
                  id: parseCodexThreadId("jsonl-thread"),
                  source: "vscode",
                }),
              ],
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              stateThreads: [
                stableThread({
                  id: parseCodexThreadId("state-thread"),
                  source: "vscode",
                }),
              ],
            });

            const exit = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            }).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.deepEqual((yield* Ref.get(client.calls)).read, []);
          })
        )
    );

    it.effect(
      "fails closed before reading when a single open index reports duplicate identities",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const thread = stableThread({
              id: parseCodexThreadId("duplicated-open-thread"),
              source: "vscode",
            });
            const client = makeStableThreadClient({
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              stateThreads: [thread, thread],
              jsonlThreads: [thread],
            });

            const exit = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            }).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.deepEqual((yield* Ref.get(client.calls)).read, []);
          })
        )
    );

    it.effect(
      "fails closed before reading when state-db and JSONL listed statuses disagree",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const threadId = parseCodexThreadId("status-mismatch-thread");
            const client = makeStableThreadClient({
              jsonlThreads: [
                stableThread({
                  id: threadId,
                  source: "vscode",
                  statusType: "idle",
                }),
              ],
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              stateThreads: [
                stableThread({
                  id: threadId,
                  source: "vscode",
                  statusType: "notLoaded",
                }),
              ],
            });

            const exit = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            }).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.deepEqual((yield* Ref.get(client.calls)).read, []);
          })
        )
    );

    it.effect(
      "fails closed when matching checkpoint digest is not the latest turn",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const threadId = parseCodexThreadId("not-latest-digest-thread");
            const client = makeStableThreadClient({
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
                { id: "latest-turn", status: "interrupted" as const },
              ],
              threads: [stableThread({ id: threadId, source: "vscode" })],
            });

            const exit = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            }).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.deepEqual((yield* Ref.get(client.calls)).read, [threadId]);
          })
        )
    );

    it.effect(
      "fails closed when checkpoint digest has zero or multiple matching turns",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const cases = [
              {
                expectedDigest: digestStableId("missing-turn"),
                readTurns: [
                  { id: "interrupted-turn", status: "interrupted" as const },
                ],
                threadId: parseCodexThreadId("zero-digest-thread"),
              },
              {
                expectedDigest: digestStableId("interrupted-turn"),
                readTurns: [
                  { id: "interrupted-turn", status: "interrupted" as const },
                  { id: "interrupted-turn", status: "interrupted" as const },
                ],
                threadId: parseCodexThreadId("multiple-digest-thread"),
              },
            ];

            for (const item of cases) {
              const client = makeStableThreadClient({
                readTurns: item.readTurns,
                threads: [
                  stableThread({ id: item.threadId, source: "vscode" }),
                ],
              });

              const exit = yield* findStableDesktopOriginCorrelationThread({
                acceptedAtSeconds: 1_000,
                client,
                expectedDigest: item.expectedDigest,
                workspacePath: "/tmp/gaia/owned-workspace",
              }).pipe(Effect.exit);

              assert.strictEqual(exit._tag, "Failure");
              assert.include(
                JSON.stringify(exit),
                "HarnessCorrelationUnavailable"
              );
              assert.deepEqual((yield* Ref.get(client.calls)).read, [
                item.threadId,
              ]);
            }
          })
        )
    );

    it.effect(
      "fails closed before reading when every stable list page returns a fresh cursor",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const calls = yield* Ref.make({ list: 0, read: 0 });
            const client = {
              listThreads: () =>
                Effect.gen(function* () {
                  yield* Effect.yieldNow;
                  const next = yield* Ref.modify(calls, (value) => [
                    value.list + 1,
                    { ...value, list: value.list + 1 },
                  ]);
                  return {
                    backwardsCursor: null,
                    data: [],
                    nextCursor: `cursor-${next}`,
                  };
                }),
              readThread: () =>
                Effect.gen(function* () {
                  yield* Ref.update(calls, (value) => ({
                    ...value,
                    read: value.read + 1,
                  }));
                  return {
                    thread: {
                      id: parseCodexThreadId("should-not-read"),
                      turns: [],
                    },
                  };
                }),
            };

            const exit = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            }).pipe(Effect.timeout("1 second"), Effect.exit);
            const observed = yield* Ref.get(calls);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.strictEqual(observed.read, 0);
          })
        )
    );

    it.effect(
      "fails closed before reading when open and archived indexes expose the same candidate",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const thread = stableThread({
              id: parseCodexThreadId("duplicated-archived-thread"),
              source: "vscode",
            });
            const client = makeStableThreadClient({
              jsonlArchivedThreads: [thread],
              readTurns: [
                { id: "interrupted-turn", status: "interrupted" as const },
              ],
              threads: [thread],
            });

            const exit = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("interrupted-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            }).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.deepEqual((yield* Ref.get(client.calls)).read, []);
          })
        )
    );

    it.effect(
      "fails closed when the latest turn is not the exact interrupted checkpoint",
      () =>
        withCodexDesktopOriginator(
          "Codex Desktop",
          Effect.gen(function* () {
            const threadId = parseCodexThreadId("wrong-checkpoint-thread");
            const client = makeStableThreadClient({
              readTurns: [
                { id: "older-turn", status: "completed" as const },
                { id: "latest-turn", status: "completed" as const },
              ],
              threads: [stableThread({ id: threadId, source: "vscode" })],
            });

            const exit = yield* findStableDesktopOriginCorrelationThread({
              acceptedAtSeconds: 1_000,
              client,
              expectedDigest: digestStableId("latest-turn"),
              workspacePath: "/tmp/gaia/owned-workspace",
            }).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "HarnessCorrelationUnavailable"
            );
            assert.deepEqual((yield* Ref.get(client.calls)).read, [threadId]);
          })
        )
    );

    it.effect(
      "fails before model catalog and recovery mutation when detection cannot become available",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const detections: ReadonlyArray<
            () => Effect.Effect<HarnessDetection, unknown>
          > = [
            () => Effect.succeed({ state: "missing" }),
            () =>
              Effect.succeed({
                reason: "Unsupported stable protocol.",
                state: "incompatible",
                version: "test-0",
              }),
            () => Effect.fail(new Error("private detection cause")),
          ];
          yield* Effect.forEach(detections, (makeDetection) =>
            Effect.gen(function* () {
              const fixture = yield* makeWorkerRecoveryFixture();
              const before = yield* fs.readFileString(fixture.paths.events);
              const calls: string[] = [];
              const provider = makeProductionWorkerRecoveryProvider({
                detect: Effect.sync(() => {
                  calls.push("detect");
                }).pipe(Effect.andThen(makeDetection)),
                listModels: () =>
                  Effect.sync(() => {
                    calls.push("model/list");
                    return [workerRecoveryModel()];
                  }),
                readThread: () =>
                  Effect.sync(() => {
                    calls.push("read");
                    return workerRecoveryThreadState("systemError");
                  }),
                resumeThread: () =>
                  Effect.sync(() => {
                    calls.push("resume");
                    return workerRecoveryThreadState("idle");
                  }),
                startTurn: () =>
                  Effect.sync(() => {
                    calls.push("start");
                    return workerRecoveryStartTurn("turn-recovery");
                  }),
              });
              const exit = yield* recoverWorkerSession(
                fixture.runId,
                workerRecoveryAction,
                {
                  provider,
                  rootDirectory: fixture.root,
                  validateWorkspace: () => Effect.void,
                }
              ).pipe(Effect.exit);

              assert.strictEqual(exit._tag, "Failure");
              assert.include(
                JSON.stringify(exit),
                "WorkerRecoveryModelCatalogUnavailable"
              );
              assert.notInclude(
                JSON.stringify(exit),
                "private detection cause"
              );
              assert.deepEqual(calls, ["detect"]);
              assert.strictEqual(
                yield* fs.readFileString(fixture.paths.events),
                before
              );
              assert.isFalse(
                yield* fs.exists(
                  `${fixture.paths.root}/.worker-recovery-turn.json`
                )
              );
            })
          );
        })
    );
    it.effect(
      "binds dynamically, writes discovery state, and cleans metadata on shutdown",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-main-",
          });
          const server = yield* startServer(cwd);
          const metadata = server.metadata;

          const metadataText = yield* fs.readFileString(
            `${cwd}/.gaia/server.json`
          );
          const metadataJson = parseJsonObject(metadataText);
          const log = yield* fs.readFileString(`${cwd}/.gaia/server.log`);
          const health = yield* fetchJsonObject(`${metadata.url}/health`);

          assert.isAbove(metadata.port, 0);
          assert.strictEqual(metadata.host, "127.0.0.1");
          assert.strictEqual(metadataJson["serverId"], metadata.serverId);
          assert.strictEqual(metadataJson["workspaceRoot"], cwd);
          assert.strictEqual(health["serverId"], metadata.serverId);
          assert.strictEqual(health["workspaceRoot"], cwd);
          assert.include(log, metadata.url);
          assert.include(log, `serverId=${metadata.serverId}`);
          assert.include(log, `pid=${metadata.pid}`);
          assert.include(log, `workspaceRoot=${cwd}`);
          assert.include(log, "metadata=");

          yield* server.close;
          assert.isFalse(yield* fs.exists(`${cwd}/.gaia/server.json`));
        }),
      20_000
    );

    it.effect(
      "honors an explicit foreground port",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-port-",
          });
          const port = yield* freePort();
          const server = yield* startServer(cwd, port);

          assert.strictEqual(server.metadata.port, port);
          assert.strictEqual(server.metadata.url, `http://127.0.0.1:${port}`);

          yield* server.close;
        }),
      20_000
    );

    it.effect(
      "marks accepted unfinished server runs interrupted on startup",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-main-",
          });
          const accepted = yield* acceptServerRun(
            { specMarkdown: "Interrupted before server restart.\n" },
            { rootDirectory: cwd }
          );
          const server = yield* startServer(cwd);
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const failed = events.events.at(-1);

          assert.strictEqual(failed?.type, "RUN_FAILED");
          assert.strictEqual(
            failed?.payload["code"],
            "ServerExecutionInterrupted"
          );

          yield* server.close;
        }),
      20_000
    );

    it.effect(
      "resumes an accepted issue-delivery run on server restart instead of failing it",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-resume-",
          });
          const accepted = yield* acceptFactoryRun(
            {
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description:
                  "Resume through the server-owned provider registry.",
                kind: "issue",
                title: "Restart resume",
              },
            },
            {
              harnessProviderRegistry: makeTestHarnessProviderRegistry(),
              rootDirectory: cwd,
            }
          );

          const server = yield* startServer(cwd);
          const events = yield* waitForTerminalRunEventFile(
            cwd,
            accepted.runId
          );

          assert.strictEqual(events.at(-1)?.type, "REPORT_COMPLETED");
          assert.notInclude(
            events.map(({ type }) => type),
            "RUN_FAILED"
          );
          yield* server.close;
        }),
      20_000
    );

    it.effect(
      "interrupts run-scoped sessions on shutdown while preserving resumable state",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-scope-",
          });
          const started = yield* Deferred.make<void>();
          const released = yield* Ref.make(false);
          const provider: HarnessProvider = {
            ...testHarnessProvider,
            createSession: (request) =>
              Effect.gen(function* () {
                const turnId = parseHarnessTurnId("turn-server-shutdown");
                const events = [
                  {
                    capabilities: testHarnessCapabilities,
                    kind: "sessionStarted",
                    provider: testHarnessProvider.descriptor,
                    sessionId: request.sessionId,
                    state: "running",
                  },
                  {
                    kind: "turnStarted",
                    sessionId: request.sessionId,
                    turnId,
                  },
                ] as const;
                yield* Deferred.succeed(started, undefined);
                yield* Effect.addFinalizer(() => Ref.set(released, true));
                return {
                  events: Stream.concat(
                    Stream.fromIterable(events),
                    Stream.never
                  ),
                  interrupt: Option.some(Effect.void),
                  resolveInteraction: () => Effect.void,
                  send: () => Effect.void,
                  snapshot: Effect.succeed(
                    projectHarnessEvents(events, request.sessionId)
                  ),
                  steer: Option.none(),
                };
              }),
          };
          const registry = makeHarnessProviderRegistry([
            {
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider,
            },
          ]);
          const server = yield* startServer(cwd, undefined, registry);
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${server.metadata.url}/runs`, {
                body: JSON.stringify({
                  execution: { harnessProfileId: "codexAppServer" },
                  workflow: "issueDelivery",
                  workItem: {
                    description: "Remain nonterminal until server shutdown.",
                    kind: "issue",
                    title: "Server scope shutdown",
                  },
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
              }),
            catch: (cause) => cause,
          });
          const body = Schema.decodeUnknownSync(
            Schema.Struct({ runId: Schema.String })
          )(yield* Effect.promise(() => response.json()));
          assert.strictEqual(response.status, 202);
          yield* Deferred.await(started);
          yield* waitForRunEventTypeFile(
            cwd,
            body.runId,
            "HARNESS_SESSION_EVENT_RECORDED"
          );

          yield* server.close;

          assert.isTrue(yield* Ref.get(released));
          const events = yield* readLocalRunEvents(parseRunId(body.runId), {
            rootDirectory: cwd,
          });
          assert.notInclude(
            events.events.map(({ type }) => type),
            "RUN_FAILED"
          );
          assert.strictEqual(
            events.events.at(-1)?.type,
            "HARNESS_SESSION_EVENT_RECORDED"
          );
        }),
      20_000
    );
  });
});

const workerRecoveryAction = WorkerRecoveryAction.make({
  actionId: parseWorkerRecoveryActionId("recover-1"),
  expectedFailureSequence: 10,
  expectedSessionId: parseHarnessSessionId("session-run-1234567890"),
  harnessProfileId: parseHarnessProfileId("codexAppServer"),
  kind: "retryRecoverableWorkerFailure",
  model: parseWorkerRecoveryModelId("gpt-5.4"),
});

const workerRecoveryModel = () =>
  WorkerRecoveryModel.make({ hidden: false, id: workerRecoveryAction.model });
const workerRecoveryThreadState = (status: WorkerRecoveryThreadStatus) =>
  WorkerRecoveryThreadState.make({ status });
const workerRecoveryStartTurn = (turnId: string) =>
  WorkerRecoveryTurnStarted.make({
    checkpoint: parseHarnessCheckpointToken(`hchk1_${turnId}`),
    nativeTurnIdDigest: parseWorkerRecoveryDigest(
      createHash("sha256").update(turnId).digest("hex")
    ),
  });

function makeWorkerRecoveryFixture() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectory({
      prefix: "gaia-server-recovery-provider-",
    });
    const runId = parseRunId("run-1234567890");
    const paths = yield* makeRunPaths(runId, { rootDirectory: root });
    yield* fs.makeDirectory(paths.root, { recursive: true });
    yield* fs.makeDirectory(paths.workspace, { recursive: true });
    const event = (
      sequence: number,
      type: Parameters<typeof makeRunEvent>[0]["type"],
      payload: Record<string, Schema.Json>
    ) =>
      makeRunEvent({
        payload,
        runId,
        sequence,
        timestamp: `2026-07-11T00:00:0${sequence}.000Z`,
        type,
      });
    const session = (value: unknown) => ({
      event: parseHarnessEvent(value) as unknown as Schema.Json,
    });
    const events = [
      event(1, "RUN_CREATED", {
        delivery: {
          baseRevision: "a".repeat(40),
          mode: "pullRequest",
        },
        execution: { selection: { harnessProfileId: "codexAppServer" } },
        specPath: "input.md",
      }),
      event(2, "DELIVERY_STARTED", {
        delivery: {
          baseBranch: "main",
          baseRevision: "a".repeat(40),
          headBranch: "gaia/run-1234567890",
          mode: "pullRequest",
          remote: "origin",
          stage: "delivering",
        },
      }),
      event(3, "WORKSPACE_PREPARED", { workspacePath: "workspace" }),
      event(4, "REVIEW_STARTED", { phase: "plan" }),
      event(5, "REVIEW_COMPLETED", {
        phase: "plan",
        reviewPath: "plan.md",
        reviewerName: "reviewer",
        status: "approved",
      }),
      event(6, "WORKER_STARTED", {}),
      event(
        7,
        "HARNESS_SESSION_EVENT_RECORDED",
        session({
          capabilities: testHarnessCapabilities,
          kind: "sessionStarted",
          provider: testHarnessProvider.descriptor,
          sessionId: "session-run-1234567890",
          state: "connecting",
        })
      ),
      event(
        8,
        "HARNESS_SESSION_EVENT_RECORDED",
        session({
          kind: "turnStarted",
          sessionId: "session-run-1234567890",
          turnId: "turn-initial",
        })
      ),
      event(
        9,
        "HARNESS_SESSION_EVENT_RECORDED",
        session({
          failure: {
            code: "CodexThreadSystemError",
            kind: "providerFailure",
            message: "system error",
            recoverable: true,
          },
          kind: "sessionFailed",
          sessionId: "session-run-1234567890",
        })
      ),
      event(10, "RUN_FAILED", {
        code: "HarnessSessionFailed",
        message: "failed",
        recoverable: true,
        stage: "runningWorker",
      }),
    ];
    yield* fs.writeFileString(
      paths.events,
      `${events
        .map((value) => JSON.stringify(Schema.encodeSync(RunEvent)(value)))
        .join("\n")}\n`
    );
    yield* fs.writeFileString(paths.snapshots, "");
    return { paths, root, runId };
  });
}

function makeAuditedWorkspacePathFixture(workspacePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectory({
      prefix: "gaia-server-audited-workspace-",
    });
    const runId = parseRunId("run-AuditPath1");
    const paths = yield* makeRunPaths(runId, { rootDirectory: root });
    yield* fs.makeDirectory(paths.root, { recursive: true });
    yield* fs.makeDirectory(paths.workspace, { recursive: true });
    const canonicalWorkspace = yield* fs.realPath(paths.workspace);
    return {
      canonicalWorkspace,
      events: workspacePathEvents(workspacePath),
      paths,
      root,
      runId,
    };
  });
}

function workspacePathEvents(workspacePath: string) {
  return [
    makeRunEvent({
      payload: {
        delivery: {
          baseBranch: "main",
          baseRevision: "a".repeat(40),
          headBranch: "gaia/run-AuditPath1",
          mode: "pullRequest",
          remote: "origin",
          stage: "delivering",
        },
        specPath: "input.md",
      },
      runId: parseRunId("run-AuditPath1"),
      sequence: 1,
      timestamp: "2026-07-11T00:16:40.000Z",
      type: "RUN_CREATED",
    }),
    makeRunEvent({
      payload: { workspacePath },
      runId: parseRunId("run-AuditPath1"),
      sequence: 2,
      timestamp: "2026-07-11T00:16:41.000Z",
      type: "WORKSPACE_PREPARED",
    }),
  ];
}

type TestServer = {
  readonly close: Effect.Effect<void>;
  readonly metadata: ServerMetadata;
};

function startServer(
  rootDirectory: string,
  port?: number,
  harnessProviderRegistry: HarnessProviderRegistry = makeTestHarnessProviderRegistry()
) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<ServerMetadata>();
    const fiber = yield* runLocalGaiaServer({
      harnessProviderRegistry,
      onReady: (metadata) =>
        Deferred.succeed(ready, metadata).pipe(Effect.asVoid),
      ...(port === undefined ? {} : { port }),
      rootDirectory,
    }).pipe(Effect.forkScoped);
    const startupFailed = Fiber.await(fiber).pipe(
      Effect.flatMap((exit) =>
        Effect.fail(
          new Error(`Local test server exited before ready: ${exit._tag}.`)
        )
      )
    );
    const metadata = yield* Deferred.await(ready).pipe(
      Effect.raceFirst(startupFailed),
      Effect.timeout("5 seconds")
    );

    return {
      close: Fiber.interrupt(fiber).pipe(Effect.asVoid),
      metadata,
    } satisfies TestServer;
  });
}

function freePort() {
  return Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            server.close(() => reject(new Error("No TCP port was allocated.")));
            return;
          }

          server.close(() => resolve(address.port));
        });
      }),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error("Could not allocate a free port."),
  });
}

function waitForTerminalRunEventFile(rootDirectory: string, runId: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const events = yield* Effect.tryPromise({
        try: async () => {
          const contents = await readFile(
            `${rootDirectory}/.gaia/runs/${runId}/events.jsonl`,
            "utf8"
          );
          return contents
            .trimEnd()
            .split(/\r?\n/u)
            .map((line) =>
              Schema.decodeUnknownSync(RunEvent)(JSON.parse(line))
            );
        },
        catch: () => [],
      });
      if (
        events.at(-1)?.type === "REPORT_COMPLETED" ||
        events.at(-1)?.type === "RUN_FAILED"
      ) {
        return events;
      }
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 25);
          })
      );
    }
    return yield* Effect.fail(
      new Error("Restarted run did not become terminal.")
    );
  });
}

function waitForRunEventTypeFile(
  rootDirectory: string,
  runId: string,
  eventType: string
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const contents = yield* Effect.promise(() =>
          readFile(`${rootDirectory}/.gaia/runs/${runId}/events.jsonl`, "utf8")
        );
        if (contents.includes(`\"type\":\"${eventType}\"`)) return;
      } catch {
        // The accepted run file can be between atomic append steps.
      }
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          })
      );
    }
    return yield* Effect.fail(
      new Error(`Run event ${eventType} was not persisted.`)
    );
  });
}

function fetchJsonObject(url: string) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url);
      const parsed: unknown = await response.json();
      if (isJsonObject(parsed)) {
        return parsed;
      }

      throw new Error("Response JSON was not an object.");
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Could not fetch JSON."),
  });
}

function parseJsonObject(input: string) {
  const parsed: unknown = JSON.parse(input);
  if (isJsonObject(parsed)) {
    return parsed;
  }

  throw new Error("Expected JSON object.");
}

function isJsonObject(
  input: unknown
): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function digestStableId(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function withCodexDesktopOriginator<A, E, R>(
  value: string | undefined,
  effect: Effect.Effect<A, E, R>
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
      if (value === undefined) {
        delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
      } else {
        process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = value;
      }
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
        } else {
          process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = previous;
        }
      })
  );
}

function stableThread(input: {
  readonly createdAt?: number;
  readonly cwd?: string;
  readonly id: ReturnType<typeof parseCodexThreadId>;
  readonly sessionId?: string;
  readonly source: "appServer" | "cli" | "vscode";
  readonly statusType?: "active" | "idle" | "notLoaded" | "systemError";
}) {
  return Schema.decodeUnknownSync(CodexListedThreadSchema)({
    createdAt: input.createdAt ?? 1_010,
    cwd: input.cwd ?? "/tmp/gaia/owned-workspace",
    id: input.id,
    sessionId: input.sessionId ?? "session-private-stable",
    source: input.source,
    status:
      input.statusType === "active"
        ? { activeFlags: [], type: "active" }
        : { type: input.statusType ?? "notLoaded" },
    updatedAt: input.createdAt ?? 1_010,
  });
}

function makeStableThreadClient(input: {
  readonly jsonlArchivedThreads?: ReadonlyArray<
    ReturnType<typeof stableThread>
  >;
  readonly jsonlThreads?: ReadonlyArray<ReturnType<typeof stableThread>>;
  readonly listError?: unknown;
  readonly readError?: unknown;
  readonly readTurns: ReadonlyArray<{
    readonly id: string;
    readonly status: "completed" | "failed" | "inProgress" | "interrupted";
  }>;
  readonly stateArchivedThreads?: ReadonlyArray<
    ReturnType<typeof stableThread>
  >;
  readonly stateThreads?: ReadonlyArray<ReturnType<typeof stableThread>>;
  readonly threads?: ReadonlyArray<ReturnType<typeof stableThread>>;
}) {
  return Effect.runSync(
    Effect.gen(function* () {
      const calls = yield* Ref.make({
        list: [] as string[],
        read: [] as Array<ReturnType<typeof parseCodexThreadId>>,
      });
      const stateThreads = input.stateThreads ?? input.threads ?? [];
      const jsonlThreads = input.jsonlThreads ?? input.threads ?? [];
      const stateArchivedThreads = input.stateArchivedThreads ?? [];
      const jsonlArchivedThreads = input.jsonlArchivedThreads ?? [];
      const client = {
        listThreads: (params: ThreadListParams) =>
          Effect.gen(function* () {
            const store = params.useStateDbOnly === true ? "state" : "jsonl";
            const archived = params.archived === true ? "archived" : "open";
            const sourceKinds = [...(params.sourceKinds ?? [])].join(",");
            yield* Ref.update(calls, (value) => ({
              ...value,
              list: [...value.list, `${store}:${archived}:${sourceKinds}`],
            }));
            if (input.listError !== undefined) {
              return yield* Effect.fail(input.listError);
            }
            return Schema.decodeUnknownSync(ThreadListResultSchema)({
              backwardsCursor: null,
              data:
                params.archived === true
                  ? params.useStateDbOnly === true
                    ? stateArchivedThreads
                    : jsonlArchivedThreads
                  : params.useStateDbOnly === true
                    ? stateThreads
                    : jsonlThreads,
              nextCursor: null,
            });
          }),
        readThread: (params: ThreadReadParams) =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (value) => ({
              ...value,
              read: [...value.read, params.threadId],
            }));
            if (input.readError !== undefined) {
              return yield* Effect.fail(input.readError);
            }
            return Schema.decodeUnknownSync(ThreadResultSchema)({
              thread: {
                id: params.threadId,
                turns: [...input.readTurns],
              },
            });
          }),
      };
      return { calls, ...client };
    })
  );
}
