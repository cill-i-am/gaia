import { NodeServices } from "@effect/platform-node";
import { codexAppServerExecutionSelection } from "@gaia/core";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeCodexAppServerClient, makeCodexAppServerConnection } from "./codex-app-server-client.js";
import {
  createCodexHarnessProvider,
  makeFileCodexHarnessCorrelationStore,
} from "./codex-harness-provider.js";
import { detectInstalledCodexAppServer } from "./codex-provider-detection.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import { acceptFactoryRun, continueServerRun } from "./server-workflows.js";
import { localDirectoryWorkspaceSource } from "./workspace.js";

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
          threadId: thread.id,
        });
        yield* Effect.sleep("1 second").pipe(
          Effect.repeat({ while: () => !completed, times: 45 }),
        );
        return { completed, sawItem };
      })).pipe(Effect.timeout("60 seconds")));
      expect(evidence).toEqual({ completed: true, sawItem: true });
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
});
