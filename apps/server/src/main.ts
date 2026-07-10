#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { codexAppServerHarnessProfileId, type ServerMetadata } from "@gaia/core";
import {
  createCodexHarnessProvider,
  detectInstalledCodexAppServer,
  makeCodexAppServerClient,
  makeCodexAppServerConnection,
  makeFileCodexHarnessCorrelationStore,
  makeHarnessProviderRegistry,
  type HarnessProviderRegistry,
} from "@gaia/runtime";
import {
  reconcileInterruptedServerRuns,
} from "@gaia/runtime/server-workflows";
import { makeTestHarnessProviderRegistry } from "@gaia/runtime/test-support";
import { Effect, Layer } from "effect";
import * as Console from "effect/Console";
import { HttpServer } from "effect/unstable/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { makeLocalGaiaServerLayer } from "./api.js";
import {
  appendServerLog,
  removeServerMetadata,
  serverDiscoveryPaths,
  serverMetadataFromAddress,
  writeServerMetadata,
  type LocalServerIdentity,
} from "./discovery.js";

export type ServerConfig = {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly rootDirectory: string;
  readonly testHarness: boolean;
};

export const defaultServerConfig = {
  host: "127.0.0.1",
  port: 0,
  rootDirectory: process.cwd(),
  testHarness: false,
} satisfies ServerConfig;

export function runLocalGaiaServer(input: {
  readonly harnessProviderRegistry?: HarnessProviderRegistry | undefined;
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
  return Effect.scoped(
    Effect.gen(function* () {
      const harnessProviderRegistry =
        input.harnessProviderRegistry ??
        (yield* makeProductionHarnessProviderRegistry(identity.rootDirectory));
      const workflowOptions = {
        harnessProviderRegistry,
        rootDirectory: identity.rootDirectory,
      };
      const reconciliation = yield* reconcileInterruptedServerRuns(
        workflowOptions,
      );
      const serverLayer = makeLocalGaiaServerLayer(
        identity,
        workflowOptions,
        reconciliation.resumableRunIds,
      ).pipe(Layer.provideMerge(nodeLayer));
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const metadata = yield* serverMetadataFromAddress(identity, server.address);
        yield* writeServerMetadata(metadata);
        yield* Effect.addFinalizer(() =>
          removeServerMetadata(metadata).pipe(Effect.orElseSucceed(() => undefined)),
        );
        const discoveryPaths = yield* serverDiscoveryPaths(metadata.workspaceRoot);
        yield* appendServerLog(
          metadata.workspaceRoot,
          `${metadata.startedAt} listening ${metadata.url} serverId=${metadata.serverId} pid=${metadata.pid} workspaceRoot=${metadata.workspaceRoot} metadata=${discoveryPaths.serverJson}`,
        );
        if (input.onReady !== undefined) {
          yield* input.onReady(metadata);
        }
        yield* Console.log(
          `Gaia local API listening on ${metadata.url}`,
        );
        yield* Console.log(`workspace: ${metadata.workspaceRoot}`);
        yield* Effect.never;
      }).pipe(Effect.provide(serverLayer));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}

function makeProductionHarnessProviderRegistry(rootDirectory: string) {
  return Effect.gen(function* () {
    const connection = yield* makeCodexAppServerConnection({
      cwd: rootDirectory,
    });
    const provider = createCodexHarnessProvider({
      client: makeCodexAppServerClient(connection),
      correlationStore: makeFileCodexHarnessCorrelationStore(rootDirectory),
      detectionProbe: detectInstalledCodexAppServer,
      workspaceRoot: rootDirectory,
    });
    return makeHarnessProviderRegistry([
      { profileId: codexAppServerHarnessProfileId, provider },
    ]);
  });
}

export function parseServerArgs(args: ReadonlyArray<string>): ServerConfig {
  let port = defaultServerConfig.port;
  let rootDirectory = defaultServerConfig.rootDirectory;
  let testHarness: boolean = defaultServerConfig.testHarness;

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
    if (arg === "--test-harness") {
      testHarness = true;
    }
  }

  return {
    host: defaultServerConfig.host,
    port,
    rootDirectory,
    testHarness,
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
  runLocalGaiaServer({
    ...(config.testHarness
      ? { harnessProviderRegistry: makeTestHarnessProviderRegistry() }
      : {}),
    port: config.port,
    rootDirectory: config.rootDirectory,
  }).pipe(NodeRuntime.runMain);
}
