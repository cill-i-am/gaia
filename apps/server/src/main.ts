import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { listenGaiaApi } from "./server.js";

const options = parseArgs(process.argv.slice(2));

listenGaiaApi(options).pipe(
  Effect.tap((server) =>
    Effect.sync(() => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        process.stdout.write(
          `Gaia local API listening on http://${address.address}:${address.port}\n`,
        );
      }
    }),
  ),
  Effect.provide(NodeServices.layer),
  Effect.runPromise,
).catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});

function parseArgs(args: ReadonlyArray<string>) {
  const parsed: {
    host?: string;
    port?: number;
    rootDirectory?: string;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--host" && value !== undefined) {
      parsed.host = value;
      index += 1;
    } else if (arg === "--port" && value !== undefined) {
      parsed.port = Number.parseInt(value, 10);
      index += 1;
    } else if (arg === "--root" && value !== undefined) {
      parsed.rootDirectory = value;
      index += 1;
    }
  }

  return parsed;
}
