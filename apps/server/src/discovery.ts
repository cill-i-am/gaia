import { ServerMetadata } from "@gaia/core";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { HttpServer } from "effect/unstable/http";

export const loopbackHost = "127.0.0.1";

export type LocalGaiaServerConfig = {
  readonly rootDirectory: string;
  readonly serverId: string;
  readonly startedAt: string;
};

export function serverMetadata(
  config: LocalGaiaServerConfig,
  server: HttpServer.HttpServer["Service"],
) {
  const port = server.address._tag === "TcpAddress" ? server.address.port : 0;
  const url = `http://${loopbackHost}:${port}`;
  return ServerMetadata.make({
    gaiaRoot: gaiaRoot(config.rootDirectory),
    host: loopbackHost,
    pid: process.pid,
    port,
    serverId: config.serverId,
    startedAt: config.startedAt,
    updatedAt: config.startedAt,
    url,
    version: 1,
    workspaceRoot: config.rootDirectory,
  });
}

export function makeServerLifecycleLayer(config: LocalGaiaServerConfig) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const metadata = serverMetadata(config, server);

      yield* writeServerMetadata(metadata);
      yield* appendServerLog(metadata, "started");
      yield* Console.log(
        `Gaia local API listening on ${metadata.url} for ${metadata.workspaceRoot}`,
      );
      yield* Effect.addFinalizer(() =>
        removeMatchingServerMetadata(metadata).pipe(
          Effect.andThen(appendServerLog(metadata, "stopped")),
          Effect.matchEffect({
            onFailure: () => Effect.void,
            onSuccess: () => Effect.void,
          }),
        ),
      );
    }),
  );
}

export function serverJsonPath(rootDirectory: string) {
  return `${gaiaRoot(rootDirectory)}/server.json`;
}

export function serverLogPath(rootDirectory: string) {
  return `${gaiaRoot(rootDirectory)}/server.log`;
}

export function writeServerMetadata(metadata: ServerMetadata) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(metadata.gaiaRoot, { recursive: true });
    yield* fs.writeFileString(
      serverJsonPath(metadata.workspaceRoot),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  });
}

export function readServerMetadata(rootDirectory: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = serverJsonPath(rootDirectory);
    const exists = yield* fs.exists(path);
    if (!exists) {
      return undefined;
    }

    const text = yield* fs.readFileString(path);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () => new Error("Server metadata is not valid JSON."),
    });
    return yield* Schema.decodeUnknownEffect(ServerMetadata)(parsed);
  });
}

export function removeMatchingServerMetadata(metadata: ServerMetadata) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existing = yield* readServerMetadata(metadata.workspaceRoot).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(undefined),
        onSuccess: (metadata) => Effect.succeed(metadata),
      }),
    );
    if (existing?.serverId !== metadata.serverId) {
      return;
    }

    yield* fs.remove(serverJsonPath(metadata.workspaceRoot));
  });
}

export function appendServerLog(
  metadata: ServerMetadata,
  event: "started" | "stopped",
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(metadata.gaiaRoot, { recursive: true });
    yield* fs.writeFileString(
      serverLogPath(metadata.workspaceRoot),
      `${JSON.stringify({
        event,
        serverId: metadata.serverId,
        timestamp: new Date().toISOString(),
        url: metadata.url,
        workspaceRoot: metadata.workspaceRoot,
      })}\n`,
      { flag: "a" },
    );
  });
}

function gaiaRoot(rootDirectory: string) {
  return `${rootDirectory}/.gaia`;
}
