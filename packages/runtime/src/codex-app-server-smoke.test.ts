import { NodeServices } from "@effect/platform-node";
import {
  codexAppServerExecutionSelection,
  parseHarnessSessionId,
  parseWorkspaceRelativePath,
} from "@gaia/core";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { listCodexModels, makeCodexAppServerClient, makeCodexAppServerConnection } from "./codex-app-server-client.js";
import {
  createCodexHarnessProvider,
  makeFileCodexHarnessCorrelationStore,
} from "./codex-harness-provider.js";
import { detectInstalledCodexAppServer } from "./codex-provider-detection.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import { acceptFactoryRun, continueServerRun } from "./server-workflows.js";
import { localDirectoryWorkspaceSource } from "./workspace.js";
import {
  resumeHarnessSession,
  startHarnessSession,
} from "./harness-session.js";

const runSmoke = process.env.GAIA_CODEX_APP_SERVER_SMOKE === "1";

describe("Codex App Server installed CLI smoke", () => {
  it.skipIf(!runSmoke)("streams an item and completes an isolated ephemeral turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "gaia-codex-smoke-"));
    const codexHome = join(root, "codex-home");
    const cwd = join(root, "workspace");
    await mkdir(codexHome);
    await mkdir(cwd);
    await cp(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"), {
      recursive: false,
    });
    try {
      const evidence = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const connection = yield* makeCodexAppServerConnection({
          cwd,
          env: { ...process.env, CODEX_HOME: codexHome },
        });
        const client = makeCodexAppServerClient(connection);
        let sawItem = false;
        let completed = false;
        client.onNotification(({ method }) => {
          if (method === "item/started" || method === "item/completed") sawItem = true;
          if (method === "turn/completed") completed = true;
        });
        yield* client.initialize({ clientInfo: { name: "gaia", title: "Gaia", version: "0.1.0" } });
        const catalog = yield* listCodexModels(connection, { includeHidden: false });
        const model = catalog.data.find(({ hidden }) => !hidden)?.id;
        if (model === undefined) return yield* Effect.die("model/list returned no visible model");
        const started = yield* client.startThread({
          approvalPolicy: "never",
          cwd,
          ephemeral: true,
          sandbox: "read-only",
        });
        const thread = started.thread;
        if (typeof thread !== "object" || thread === null || !("id" in thread) || typeof thread.id !== "string") {
          return yield* Effect.die("thread/start returned no thread id");
        }
        yield* client.startTurn({
          input: [{ type: "text", text: "Reply exactly GAIA_SMOKE_OK. Do not use tools." }],
          model,
          threadId: thread.id,
        });
        yield* Effect.sleep("1 second").pipe(
          Effect.repeat({ while: () => !completed, times: 45 }),
        );
        return { completed, model, sawItem };
      })).pipe(Effect.timeout("60 seconds")));
      expect(evidence).toMatchObject({ completed: true, sawItem: true });
      expect(evidence.model.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  }, 70_000);

  it.skipIf(!runSmoke)("completes issue delivery through the selected profile without touching its source", async () => {
    const root = await mkdtemp(join(tmpdir(), "gaia-selected-harness-smoke-"));
    const codexHome = join(root, "codex-home");
    const factoryRoot = join(root, "factory");
    const sourceRoot = join(root, "live-source");
    await mkdir(codexHome);
    await mkdir(factoryRoot);
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, "source.txt"), "SOURCE_MUST_STAY_UNCHANGED\n");
    await cp(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"), {
      recursive: false,
    });
    const sourceBefore = await readFile(join(sourceRoot, "source.txt"), "utf8");
    const sourceEntriesBefore = await readdir(sourceRoot);

    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* makeCodexAppServerConnection({
              cwd: factoryRoot,
              env: { ...process.env, CODEX_HOME: codexHome },
            });
            const provider = createCodexHarnessProvider({
              client: makeCodexAppServerClient(connection),
              correlationStore: makeFileCodexHarnessCorrelationStore(factoryRoot),
              detectionProbe: detectInstalledCodexAppServer,
              workspaceRoot: factoryRoot,
            });
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
                    "Create result.txt in the current workspace containing exactly GAIA_SELECTED_HARNESS_OK followed by a newline. Do not edit source.txt. Do not run tests. Finish after creating the file.",
                  kind: "issue",
                  title: "Selected harness live smoke",
                },
              },
              { harnessProviderRegistry: registry, rootDirectory: factoryRoot },
            );
            const summary = yield* continueServerRun(accepted.runId, {
              harnessProviderRegistry: registry,
              rootDirectory: factoryRoot,
              workspaceSource: localDirectoryWorkspaceSource(sourceRoot),
            });
            return { accepted, summary };
          }),
        ).pipe(
          Effect.provide(NodeServices.layer),
          Effect.timeout("120 seconds"),
        ),
      );

      expect(result.summary.status).toBe("completed");
      expect(
        await readFile(
          join(result.accepted.runDirectory, "workspace", "result.txt"),
          "utf8",
        ),
      ).toBe("GAIA_SELECTED_HARNESS_OK\n");
      expect(await readFile(join(sourceRoot, "source.txt"), "utf8")).toBe(
        sourceBefore,
      );
      expect(await readdir(sourceRoot)).toEqual(sourceEntriesBefore);
    } finally {
      await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  }, 130_000);

  it.skipIf(!runSmoke)("restarts the App Server and sends one idempotent second turn through the same private session", async () => {
    const root = await mkdtemp(join(tmpdir(), "gaia-codex-resume-smoke-"));
    const codexHome = join(root, "codex-home");
    const workspace = join(root, "workspace");
    await mkdir(codexHome);
    await mkdir(workspace);
    await cp(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"), {
      recursive: false,
    });
    const sessionId = parseHarnessSessionId("session-real-resume-smoke");
    const workspacePath = parseWorkspaceRelativePath("workspace");
    const correlationDirectory = join(root, ".gaia", "private", "harness-correlations");

    try {
      const firstEvents = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* makeCodexAppServerConnection({
              cwd: workspace,
              env: { ...process.env, CODEX_HOME: codexHome },
            });
            const session = yield* startHarnessSession({
              provider: createCodexHarnessProvider({
                client: makeCodexAppServerClient(connection),
                correlationStore: makeFileCodexHarnessCorrelationStore(root),
                detectionProbe: detectInstalledCodexAppServer,
                workspaceRoot: root,
              }),
              request: {
                input: { text: "Reply exactly GAIA_RESUME_FIRST_OK. Do not use tools." },
                sessionId,
                workspacePath,
              },
              requiredCapabilities: ["resumableSessions", "streamingMessages"],
            });
            return yield* session.events.pipe(
              Stream.takeUntil((event) => event.kind === "turnCompleted"),
              Stream.runCollect,
            );
          }),
        ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("90 seconds")),
      );
      const [correlationFile] = await readdir(correlationDirectory);
      expect(correlationFile).toBeDefined();
      const privateCorrelationBefore = await readFile(
        join(correlationDirectory, correlationFile ?? "missing"),
        "utf8",
      );

      const secondEvents = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* makeCodexAppServerConnection({
              cwd: workspace,
              env: { ...process.env, CODEX_HOME: codexHome },
            });
            const session = yield* resumeHarnessSession({
              provider: createCodexHarnessProvider({
                client: makeCodexAppServerClient(connection),
                correlationStore: makeFileCodexHarnessCorrelationStore(root),
                detectionProbe: detectInstalledCodexAppServer,
                workspaceRoot: root,
              }),
              request: { sessionId, workspacePath },
              requiredCapabilities: ["resumableSessions", "streamingMessages"],
            });
            const followUp = {
              clientInputId: "remediation-real-resume-smoke-1",
              text: "Reply exactly GAIA_RESUME_SECOND_OK. Do not use tools.",
            } as const;
            yield* session.send(followUp);
            yield* session.send(followUp);
            return yield* session.events.pipe(
              Stream.filter((event) => event.kind === "turnCompleted"),
              Stream.take(2),
              Stream.runCollect,
            );
          }),
        ).pipe(Effect.provide(NodeServices.layer), Effect.timeout("90 seconds")),
      );
      const privateCorrelationAfter = await readFile(
        join(correlationDirectory, correlationFile ?? "missing"),
        "utf8",
      );
      const privateToken = JSON.parse(privateCorrelationBefore).token as string;
      const publicEvidence = JSON.stringify([...firstEvents, ...secondEvents]);

      expect(secondEvents).toHaveLength(2);
      expect(privateCorrelationAfter).toBe(privateCorrelationBefore);
      expect(publicEvidence).not.toContain(privateToken);
      expect(publicEvidence).not.toContain("remediation-real-resume-smoke-1");
    } finally {
      await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  }, 100_000);
});
