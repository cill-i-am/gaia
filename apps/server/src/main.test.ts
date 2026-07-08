import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import type { ServerMetadata } from "@gaia/core";
import { readLocalRunEvents } from "@gaia/runtime/run-read-api";
import { acceptServerRun } from "@gaia/runtime/server-workflows";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { createServer } from "node:net";
import { runLocalGaiaServer } from "./main.js";

describe("local Gaia server process", () => {
  layer(NodeServices.layer)((it) => {
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
  });
});

type TestServer = {
  readonly close: Effect.Effect<void>;
  readonly metadata: ServerMetadata;
};

function startServer(rootDirectory: string, port?: number) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<ServerMetadata>();
    const fiber = yield* runLocalGaiaServer({
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
