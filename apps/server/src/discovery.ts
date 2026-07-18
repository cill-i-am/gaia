import { ServerMetadata, parseLocalGaiaServerUrl } from "@gaia/core";
import {
  RunStorageRootInputSchema,
  RuntimePathSchema,
  makeRunStorePaths,
  parseRunStorageRootInput,
} from "@gaia/runtime/paths";
import { Effect, FileSystem, Path, Schema } from "effect";
import type * as HttpServer from "effect/unstable/http/HttpServer";

const LocalServerIdentitySchema = Schema.Struct({
  host: ServerMetadata.fields.host,
  pid: ServerMetadata.fields.pid,
  rootDirectory: RunStorageRootInputSchema,
  serverId: ServerMetadata.fields.serverId,
  startedAt: ServerMetadata.fields.startedAt,
});

export type LocalServerIdentity = typeof LocalServerIdentitySchema.Encoded;

const ServerDiscoveryPathsSchema = Schema.Struct({
  gaiaRoot: RuntimePathSchema,
  serverJson: RuntimePathSchema,
  serverLog: RuntimePathSchema,
});

export type ServerDiscoveryPaths = typeof ServerDiscoveryPathsSchema.Type;

const parseServerDiscoveryPaths = Schema.decodeUnknownSync(
  ServerDiscoveryPathsSchema
);

export function serverDiscoveryPaths(
  rootDirectory: typeof RunStorageRootInputSchema.Encoded
) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const store = yield* makeRunStorePaths({
      rootDirectory: parseRunStorageRootInput(rootDirectory),
    });
    return parseServerDiscoveryPaths({
      gaiaRoot: store.gaiaRoot,
      serverJson: path.join(store.gaiaRoot, "server.json"),
      serverLog: path.join(store.gaiaRoot, "server.log"),
    });
  });
}

export function serverMetadataFromAddress(
  identity: LocalServerIdentity,
  address: HttpServer.Address
) {
  return Effect.gen(function* () {
    if (address._tag !== "TcpAddress") {
      return yield* Effect.fail(
        new Error("Local Gaia server must bind to a TCP loopback address.")
      );
    }

    const paths = yield* serverDiscoveryPaths(identity.rootDirectory);
    const port = address.port;
    const now = new Date().toISOString();
    return ServerMetadata.make({
      gaiaRoot: paths.gaiaRoot,
      host: identity.host,
      pid: identity.pid,
      port,
      serverId: identity.serverId,
      startedAt: identity.startedAt,
      updatedAt: now,
      url: serverUrl(identity.host, port),
      version: 1,
      workspaceRoot: identity.rootDirectory,
    });
  });
}

export function writeServerMetadata(metadata: ServerMetadata) {
  return Effect.gen(function* () {
    const paths = yield* serverDiscoveryPaths(metadata.workspaceRoot);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(paths.gaiaRoot, { recursive: true });
    yield* fs.writeFileString(
      paths.serverJson,
      `${JSON.stringify(metadata, null, 2)}\n`
    );
  });
}

export function appendServerLog(
  rootDirectory: typeof RunStorageRootInputSchema.Encoded,
  line: string
) {
  return Effect.gen(function* () {
    const paths = yield* serverDiscoveryPaths(rootDirectory);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(paths.gaiaRoot, { recursive: true });
    yield* fs.writeFileString(paths.serverLog, `${line}\n`, { flag: "a" });
  });
}

export function removeServerMetadata(metadata: ServerMetadata) {
  return Effect.gen(function* () {
    const paths = yield* serverDiscoveryPaths(metadata.workspaceRoot);
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(paths.serverJson);
    if (!exists) {
      return;
    }

    const text = yield* fs.readFileString(paths.serverJson);
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: () => undefined,
    });
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "serverId" in parsed &&
      parsed.serverId === metadata.serverId
    ) {
      yield* fs.remove(paths.serverJson);
    }
  });
}

function serverUrl(host: "127.0.0.1", port: number) {
  return parseLocalGaiaServerUrl(`http://${host}:${port}`);
}
