#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { NodeHttpServer } from "@effect/platform-node";
import type { ServerMetadata } from "@gaia/core";
import { Effect, Layer } from "effect";
import * as Console from "effect/Console";
import { HttpServer } from "effect/unstable/http";
import { reconcileInterruptedServerRuns } from "@gaia/runtime/server-workflows";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { makeLocalGaiaServerLayer } from "./api.js";
import {
  appendServerLog,
  removeServerMetadata,
  serverMetadataFromAddress,
  writeServerMetadata,
  type LocalServerIdentity,
} from "./discovery.js";

export type ServerConfig = {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly rootDirectory: string;
};

export const defaultServerConfig = {
  host: "127.0.0.1",
  port: 0,
  rootDirectory: process.cwd(),
} satisfies ServerConfig;

export function runLocalGaiaServer(input: {
  readonly onReady?: ((metadata: ServerMetadata) => Effect.Effect<void>) | undefined;
  readonly port?: number | undefined;
  readonly rootDirectory?: string | undefined;
}): Effect.Effect<void, unknown> {
  const identity = makeServerIdentity({
    host: defaultServerConfig.host,
    rootDirectory: input.rootDirectory ?? defaultServerConfig.rootDirectory,
  });
  const port = input.port ?? defaultServerConfig.port;
  const nodeLayer = NodeHttpServer.layer(createServer, {
    host: identity.host,
    port,
  });
  const serverLayer = makeLocalGaiaServerLayer(identity).pipe(
    Layer.provideMerge(nodeLayer),
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      yield* reconcileInterruptedServerRuns({
        rootDirectory: identity.rootDirectory,
      });
      const metadata = yield* serverMetadataFromAddress(identity, server.address);
      yield* writeServerMetadata(metadata);
      yield* Effect.addFinalizer(() =>
        removeServerMetadata(metadata).pipe(Effect.orElseSucceed(() => undefined)),
      );
      yield* appendServerLog(
        metadata.workspaceRoot,
        `${metadata.startedAt} ${metadata.serverId} listening ${metadata.url}`,
      );
      if (input.onReady !== undefined) {
        yield* input.onReady(metadata);
      }
      yield* Console.log(
        `Gaia local API listening on ${metadata.url}`,
      );
      yield* Console.log(`workspace: ${metadata.workspaceRoot}`);
      yield* Effect.never;
    }).pipe(Effect.provide(serverLayer)),
  );
}

export function parseServerArgs(args: ReadonlyArray<string>): ServerConfig {
  let port = defaultServerConfig.port;
  let rootDirectory = defaultServerConfig.rootDirectory;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--port" && next !== undefined) {
      port = parsePort(next);
      index += 1;
      continue;
    }

    if (arg === "--root" && next !== undefined) {
      rootDirectory = next;
      index += 1;
      continue;
    }

    if (arg === "--host") {
      throw new Error("GAIA-12 only supports loopback host 127.0.0.1.");
    }
  }

  return {
    host: defaultServerConfig.host,
    port,
    rootDirectory,
  };
}

function makeServerIdentity(input: {
  readonly host: "127.0.0.1";
  readonly rootDirectory: string;
}): LocalServerIdentity {
  return {
    host: input.host,
    pid: process.pid,
    rootDirectory: input.rootDirectory,
    serverId: `srv_${randomUUID()}`,
    startedAt: new Date().toISOString(),
  };
}

function parsePort(input: string): number {
  const parsed = /^\d+$/u.test(input) ? Number(input) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid port: ${input}`);
  }

  return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = parseServerArgs(process.argv.slice(2));
  runLocalGaiaServer(config).pipe(NodeRuntime.runMain);
}
