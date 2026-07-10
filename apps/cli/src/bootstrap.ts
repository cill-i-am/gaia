#!/usr/bin/env node
import { parseServerPort } from "./server-port.js";

const args = process.argv.slice(2);
const portIndex = args[0] === "server" ? args.indexOf("--port") : -1;
const port = portIndex < 0 ? undefined : args[portIndex + 1];

if (port !== undefined && parseServerPort(port) === undefined) {
  if (args.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          code: "InvalidServerPort",
          message: `Invalid local server port: ${port}`,
          recoverable: false,
          status: "failed",
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `Gaia command failed: Invalid local server port: ${port}\ncode: InvalidServerPort\nrecoverable: false\n`,
    );
  }
  process.exitCode = 1;
} else {
  await import("./main.js");
}
