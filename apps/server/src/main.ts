#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer, type IncomingMessage } from "node:http";
import { Effect } from "effect";
import { handleLocalRunApiRequest } from "./api.js";

type ServerConfig = {
  readonly host: string;
  readonly port: number;
  readonly rootDirectory: string;
};

const defaultConfig: ServerConfig = {
  host: "127.0.0.1",
  port: 8787,
  rootDirectory: process.cwd(),
};

const program = Effect.gen(function* () {
  const config = parseArgs(process.argv.slice(2));
  const server = createServer((request, response) => {
    const webRequest = toWebRequest(request, config);
    const effect = handleLocalRunApiRequest(webRequest, {
      rootDirectory: config.rootDirectory,
    }).pipe(Effect.provide(NodeServices.layer));

    Effect.runPromise(effect)
      .then((webResponse) => writeWebResponse(response, webResponse))
      .catch(() => {
        response.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            error: {
              code: "InternalServerError",
              message: "Local Gaia API request failed.",
              recoverable: false,
            },
            status: "error",
          }),
        );
      });
  });

  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve) => {
        server.listen(config.port, config.host, () => resolve());
      }),
    catch: () => new Error("Local Gaia API server failed to start."),
  });
  console.log(
    `Gaia local API listening on http://${config.host}:${config.port} for ${config.rootDirectory}`,
  );
});

NodeRuntime.runMain(program);

function parseArgs(args: ReadonlyArray<string>): ServerConfig {
  let host = defaultConfig.host;
  let port = defaultConfig.port;
  let rootDirectory = defaultConfig.rootDirectory;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--host" && next !== undefined) {
      host = next;
      index += 1;
      continue;
    }

    if (arg === "--port" && next !== undefined) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed)) {
        port = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === "--root" && next !== undefined) {
      rootDirectory = next;
      index += 1;
    }
  }

  return { host, port, rootDirectory };
}

function toWebRequest(request: IncomingMessage, config: ServerConfig) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }

  const path = request.url ?? "/";
  return new Request(`http://${config.host}:${config.port}${path}`, {
    headers,
    method: request.method ?? "GET",
  });
}

function writeWebResponse(
  response: import("node:http").ServerResponse,
  webResponse: Response,
) {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => response.setHeader(key, value));
  webResponse
    .text()
    .then((body) => response.end(body))
    .catch(() => response.end());
}
