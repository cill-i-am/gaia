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
  projectHarnessEvents,
  RunEvent,
  WorkerRecoveryAction,
  type HarnessDetection,
  type ServerMetadata,
} from "@gaia/core";
import { readLocalRunEvents } from "@gaia/runtime/run-read-api";
import {
  acceptFactoryRun,
  acceptServerRun,
} from "@gaia/runtime/server-workflows";
import {
  makeHarnessProviderRegistry,
  recoverWorkerSession,
  type HarnessProvider,
  type HarnessProviderRegistry,
} from "@gaia/runtime";
import { makeRunPaths } from "@gaia/runtime/paths";
import {
  makeTestHarnessProviderRegistry,
  testHarnessCapabilities,
  testHarnessProvider,
} from "@gaia/runtime/test-support";
import { Deferred, Effect, Fiber, FileSystem, Option, Ref, Schema, Stream } from "effect";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import {
  makeProductionWorkerRecoveryProvider,
  runLocalGaiaServer,
} from "./main.js";

describe("local Gaia server process", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("detects before direct recovery model catalog and reaches preflight", () =>
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
              calls.push(detected ? "model/list" : "model/list-before-detect");
              return [{ hidden: false, id: "gpt-5.4" }];
            }),
          readThread: (threadId) =>
            Effect.sync(() => {
              calls.push("read");
              return { active: false, systemError: true, threadId };
            }),
          resumeThread: (threadId) =>
            Effect.sync(() => {
              calls.push("resume");
              return { threadId };
            }),
          startTurn: ({ model }) =>
            Effect.sync(() => {
              calls.push(`start:${model}`);
              return { turnId: "turn-recovery" };
            }),
        });
        const result = yield* recoverWorkerSession(
          fixture.runId,
          workerRecoveryAction,
          {
            nativeThreadId: "thread-private",
            provider,
            rootDirectory: fixture.root,
            validateWorkspace: () => Effect.void,
          },
        );

        assert.strictEqual(result.state, "dispatchConfirmed");
        assert.deepEqual(calls, [
          "detect",
          "model/list",
          "resume",
          "read",
          "start:gpt-5.4",
        ]);
      }),
    );
    it.effect("fails before model catalog and recovery mutation when detection cannot become available", () =>
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
                  return [{ hidden: false, id: "gpt-5.4" }];
                }),
              readThread: () =>
                Effect.sync(() => {
                  calls.push("read");
                  return {
                    active: false,
                    systemError: true,
                    threadId: "thread-private",
                  };
                }),
              resumeThread: () =>
                Effect.sync(() => {
                  calls.push("resume");
                  return { threadId: "thread-private" };
                }),
              startTurn: () =>
                Effect.sync(() => {
                  calls.push("start");
                  return { turnId: "turn-recovery" };
                }),
            });
            const exit = yield* recoverWorkerSession(
              fixture.runId,
              workerRecoveryAction,
              {
                nativeThreadId: "thread-private",
                provider,
                rootDirectory: fixture.root,
                validateWorkspace: () => Effect.void,
              },
            ).pipe(Effect.exit);

            assert.strictEqual(exit._tag, "Failure");
            assert.include(
              JSON.stringify(exit),
              "WorkerRecoveryModelCatalogUnavailable",
            );
            assert.notInclude(JSON.stringify(exit), "private detection cause");
            assert.deepEqual(calls, ["detect"]);
            assert.strictEqual(
              yield* fs.readFileString(fixture.paths.events),
              before,
            );
            assert.isFalse(
              yield* fs.exists(
                `${fixture.paths.root}/.worker-recovery-turn.json`,
              ),
            );
          }),
        );
      }),
    );
    it.effect("binds dynamically, writes discovery state, and cleans metadata on shutdown", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-main-" });
        const server = yield* startServer(cwd);
        const metadata = server.metadata;

        const metadataText = yield* fs.readFileString(`${cwd}/.gaia/server.json`);
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
      20_000,
    );

    it.effect("honors an explicit foreground port", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-port-" });
        const port = yield* freePort();
        const server = yield* startServer(cwd, port);

        assert.strictEqual(server.metadata.port, port);
        assert.strictEqual(server.metadata.url, `http://127.0.0.1:${port}`);

        yield* server.close;
      }),
      20_000,
    );

    it.effect("marks accepted unfinished server runs interrupted on startup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-main-" });
        const accepted = yield* acceptServerRun(
          { specMarkdown: "Interrupted before server restart.\n" },
          { rootDirectory: cwd },
        );
        const server = yield* startServer(cwd);
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const failed = events.events.at(-1);

        assert.strictEqual(failed?.type, "RUN_FAILED");
        assert.strictEqual(failed?.payload["code"], "ServerExecutionInterrupted");

        yield* server.close;
      }),
      20_000,
    );

    it.effect("resumes an accepted issue-delivery run on server restart instead of failing it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-resume-" });
        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Resume through the server-owned provider registry.",
              kind: "issue",
              title: "Restart resume",
            },
          },
          {
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          },
        );

        const server = yield* startServer(cwd);
        const events = yield* waitForTerminalRunEventFile(cwd, accepted.runId);

        assert.strictEqual(events.at(-1)?.type, "REPORT_COMPLETED");
        assert.notInclude(
          events.map(({ type }) => type),
          "RUN_FAILED",
        );
        yield* server.close;
      }),
      20_000,
    );

    it.effect("interrupts run-scoped sessions on shutdown while preserving resumable state", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-scope-" });
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
                events: Stream.concat(Stream.fromIterable(events), Stream.never),
                interrupt: Option.some(Effect.void),
                resolveInteraction: () => Effect.void,
                send: () => Effect.void,
                snapshot: Effect.succeed(
                  projectHarnessEvents(events, request.sessionId),
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
          Schema.Struct({ runId: Schema.String }),
        )(yield* Effect.promise(() => response.json()));
        assert.strictEqual(response.status, 202);
        yield* Deferred.await(started);
        yield* waitForRunEventTypeFile(
          cwd,
          body.runId,
          "HARNESS_SESSION_EVENT_RECORDED",
        );

        yield* server.close;

        assert.isTrue(yield* Ref.get(released));
        const events = yield* readLocalRunEvents(body.runId, {
          rootDirectory: cwd,
        });
        assert.notInclude(
          events.events.map(({ type }) => type),
          "RUN_FAILED",
        );
        assert.strictEqual(
          events.events.at(-1)?.type,
          "HARNESS_SESSION_EVENT_RECORDED",
        );
      }),
      20_000,
    );
  });
});

const workerRecoveryAction = WorkerRecoveryAction.make({
  actionId: "recover-1",
  expectedFailureSequence: 10,
  expectedSessionId: parseHarnessSessionId("session-run-1234567890"),
  harnessProfileId: parseHarnessProfileId("codexAppServer"),
  kind: "retryRecoverableWorkerFailure",
  model: "gpt-5.4",
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
      payload: Record<string, Schema.Json>,
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
      event(7, "HARNESS_SESSION_EVENT_RECORDED", session({
        capabilities: testHarnessCapabilities,
        kind: "sessionStarted",
        provider: testHarnessProvider.descriptor,
        sessionId: "session-run-1234567890",
        state: "connecting",
      })),
      event(8, "HARNESS_SESSION_EVENT_RECORDED", session({
        kind: "turnStarted",
        sessionId: "session-run-1234567890",
        turnId: "turn-initial",
      })),
      event(9, "HARNESS_SESSION_EVENT_RECORDED", session({
        failure: {
          code: "CodexThreadSystemError",
          kind: "providerFailure",
          message: "system error",
          recoverable: true,
        },
        kind: "sessionFailed",
        sessionId: "session-run-1234567890",
      })),
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
        .join("\n")}\n`,
    );
    yield* fs.writeFileString(paths.snapshots, "");
    return { paths, root, runId };
  });
}

type TestServer = {
  readonly close: Effect.Effect<void>;
  readonly metadata: ServerMetadata;
};

function startServer(
  rootDirectory: string,
  port?: number,
  harnessProviderRegistry: HarnessProviderRegistry =
    makeTestHarnessProviderRegistry(),
) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<ServerMetadata>();
    const fiber = yield* runLocalGaiaServer({
      harnessProviderRegistry,
      onReady: (metadata) => Deferred.succeed(ready, metadata).pipe(Effect.asVoid),
      ...(port === undefined ? {} : { port }),
      rootDirectory,
    }).pipe(Effect.forkScoped);
    const startupFailed = Fiber.await(fiber).pipe(
      Effect.flatMap((exit) =>
        Effect.fail(new Error(`Local test server exited before ready: ${exit._tag}.`)),
      ),
    );
    const metadata = yield* Deferred.await(ready).pipe(
      Effect.raceFirst(startupFailed),
      Effect.timeout("5 seconds"),
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
      cause instanceof Error ? cause : new Error("Could not allocate a free port."),
  });
}

function waitForTerminalRunEventFile(rootDirectory: string, runId: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const events = yield* Effect.tryPromise({
        try: async () => {
          const contents = await readFile(
            `${rootDirectory}/.gaia/runs/${runId}/events.jsonl`,
            "utf8",
          );
          return contents
            .trimEnd()
            .split(/\r?\n/u)
            .map((line) => Schema.decodeUnknownSync(RunEvent)(JSON.parse(line)));
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
        () => new Promise<void>((resolve) => setTimeout(resolve, 25)),
      );
    }
    return yield* Effect.fail(new Error("Restarted run did not become terminal."));
  });
}

function waitForRunEventTypeFile(
  rootDirectory: string,
  runId: string,
  eventType: string,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const contents = yield* Effect.promise(() =>
          readFile(
            `${rootDirectory}/.gaia/runs/${runId}/events.jsonl`,
            "utf8",
          ),
        );
        if (contents.includes(`\"type\":\"${eventType}\"`)) return;
      } catch {
        // The accepted run file can be between atomic append steps.
      }
      yield* Effect.promise(
        () => new Promise<void>((resolve) => setTimeout(resolve, 10)),
      );
    }
    return yield* Effect.fail(new Error(`Run event ${eventType} was not persisted.`));
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

function isJsonObject(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
