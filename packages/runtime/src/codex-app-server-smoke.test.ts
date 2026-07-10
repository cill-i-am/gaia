import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeCodexAppServerClient, makeCodexAppServerConnection } from "./codex-app-server-client.js";

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
});
