#!/usr/bin/env node
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { makeLocalGaiaServerLayer } from "./api.js";
import {
  loopbackHost,
  makeServerLifecycleLayer,
  type LocalGaiaServerConfig,
} from "./discovery.js";

export type LocalGaiaServerOptions = {
  readonly port?: number;
  readonly rootDirectory?: string;
  readonly serverId?: string;
  readonly startedAt?: string;
};

export function runLocalGaiaServer(options: LocalGaiaServerOptions = {}) {
  const config = makeServerConfig(options);
  const port = options.port ?? 0;
  const platform = NodeHttpServer.layer(createServer, {
    host: loopbackHost,
    port,
  });
  const app = Layer.mergeAll(
    makeLocalGaiaServerLayer(config),
    makeServerLifecycleLayer(config),
  ).pipe(Layer.provide(platform));

  return Layer.launch(app);
}

export function parseArgs(args: ReadonlyArray<string>): LocalGaiaServerOptions {
  let port: number | undefined;
  let rootDirectory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--port") {
      if (next === undefined) {
        throw new Error("--port requires a numeric value.");
      }

      port = parsePort(next);
      index += 1;
      continue;
    }

    if (arg === "--root") {
      if (next === undefined) {
        throw new Error("--root requires a workspace path.");
      }

      rootDirectory = path.resolve(next);
      index += 1;
      continue;
    }

    throw new Error(`Unknown gaia server option '${arg}'.`);
  }

  return {
    ...(port === undefined ? {} : { port }),
    ...(rootDirectory === undefined ? {} : { rootDirectory }),
  };
}

function makeServerConfig(options: LocalGaiaServerOptions): LocalGaiaServerConfig {
  return {
    rootDirectory: path.resolve(
      options.rootDirectory ?? process.env["INIT_CWD"] ?? process.cwd(),
    ),
    serverId: options.serverId ?? `srv_${randomUUID()}`,
    startedAt: options.startedAt ?? new Date().toISOString(),
  };
}

function parsePort(input: string) {
  if (!/^(?:0|[1-9]\d*)$/u.test(input)) {
    throw new Error("--port must be an integer from 0 to 65535.");
  }

  const port = Number.parseInt(input, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535.");
  }

  return port;
}

function printHelp() {
  console.log(`Usage: gaia-server [--port <port>] [--root <workspace>]

Start a foreground loopback-only Gaia local API server.

Options:
  --port <port>       Bind an explicit loopback port. Defaults to a dynamic port.
  --root <workspace>  Workspace root. Defaults to INIT_CWD or the current directory.
`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  NodeRuntime.runMain(
    Effect.suspend(() => runLocalGaiaServer(parseArgs(process.argv.slice(2)))),
  );
}
