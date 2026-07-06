import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { describe, expect, it, layer } from "@effect/vitest";
import { runSpecFile } from "@gaia/runtime";
import { Context, Effect, FileSystem, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { makeLocalGaiaServerLayer } from "../../server/src/api.js";
import { loopbackHost } from "../../server/src/discovery.js";

const execFileAsync = promisify(execFile);

describe("gaia CLI local server read parity", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "matches direct list and status JSON output when opted into server reads",
      () =>
        Effect.gen(function* () {
          const cwd = yield* createRunStore("CLI server parity.");
          yield* withLocalRunServer(cwd, (server) =>
            Effect.gen(function* () {
              const directList = yield* runGaiaJson(cwd, ["list", "--json"]);
              const serverList = yield* runGaiaJson(cwd, [
                "list",
                "--json",
                "--server-url",
                server.url,
              ]);
              const runId = getRunId(directList);
              const directStatus = yield* runGaiaJson(cwd, [
                "status",
                runId,
                "--json",
              ]);
              const serverStatus = yield* runGaiaJson(cwd, [
                "status",
                runId,
                "--json",
                "--server-url",
                server.url,
              ]);

              expect(serverList).toEqual(directList);
              expect(serverStatus).toEqual(directStatus);
            }),
          );
        }),
      20_000,
    );

    it.effect(
      "matches direct events and artifact JSON output when opted into server reads",
      () =>
        Effect.gen(function* () {
          const cwd = yield* createRunStore(
            "CLI server event and artifact parity.",
          );
          const directList = yield* runGaiaJson(cwd, ["list", "--json"]);
          const runId = getRunId(directList);
          yield* withLocalRunServer(cwd, (server) =>
            Effect.gen(function* () {
              const directEvents = yield* runGaiaJson(cwd, [
                "events",
                runId,
                "--json",
              ]);
              const serverEvents = yield* runGaiaJson(cwd, [
                "events",
                runId,
                "--json",
                "--server-url",
                server.url,
              ]);
              const directArtifact = yield* runGaiaJson(cwd, [
                "artifact",
                runId,
                "report.json",
                "--json",
              ]);
              const serverArtifact = yield* runGaiaJson(cwd, [
                "artifact",
                runId,
                "report.json",
                "--json",
                "--server-url",
                server.url,
              ]);

              expect(serverEvents).toEqual(directEvents);
              expect(serverArtifact).toEqual(directArtifact);
            }),
          );
        }),
      20_000,
    );

    it.effect(
      "fails clearly when server reads are opted in but the server is unavailable",
      () =>
        Effect.gen(function* () {
          const cwd = yield* createRunStore("CLI server unavailable.");
          const directList = yield* runGaiaJson(cwd, ["list", "--json"]);
          const runId = getRunId(directList);
          const directStatus = yield* runGaiaJson(cwd, [
            "status",
            runId,
            "--json",
          ]);
          const failed = yield* runGaia(cwd, [
            "status",
            runId,
            "--json",
            "--server-url",
            "http://127.0.0.1:1",
          ]);

          expect(directStatus.status).toBe("completed");
          expect(failed.exitCode).toBe(1);
          expect(parseCliJson(failed.stdout)).toMatchObject({
            code: "LocalRunApiUnavailable",
            recoverable: true,
            status: "failed",
          });
        }),
      20_000,
    );
  });
});

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type TestServer = {
  readonly url: string;
};

function createRunStore(specBody: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-cli-" });
    const specPath = `${cwd}/spec.md`;
    yield* fs.writeFileString(specPath, specBody);
    yield* runSpecFile(specPath, { rootDirectory: cwd });
    return cwd;
  });
}

function withLocalRunServer<A, E, R>(
  rootDirectory: string,
  use: (server: TestServer) => Effect.Effect<A, E, R>,
) {
  return Effect.scopedWith((scope) =>
    Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(
        makeLocalGaiaServerLayer({
          rootDirectory,
          serverId: "srv_cli_test",
          startedAt: "2026-07-06T10:00:00.000Z",
        }).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(createServer, {
              host: loopbackHost,
              port: 0,
            }),
          ),
        ),
        scope,
      );
      const server = Context.get(context, HttpServer.HttpServer);
      if (server.address._tag !== "TcpAddress") {
        return yield* Effect.fail(new Error("Test server did not bind to TCP."));
      }

      return yield* use({
        url: `http://${loopbackHost}:${server.address.port}`,
      });
    }),
  );
}

function runGaiaJson(cwd: string, args: ReadonlyArray<string>) {
  return runGaia(cwd, args).pipe(
    Effect.map((result) => {
      expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
      return parseCliJson(result.stdout);
    }),
  );
}

function runGaia(cwd: string, args: ReadonlyArray<string>) {
  return Effect.promise(async () => {
    const result = await execFileAsync("pnpm", [
      "--dir",
      repoRoot(),
      "--filter",
      "@gaia/cli",
      "gaia",
      ...args,
    ], {
      cwd,
      env: {
        ...process.env,
        INIT_CWD: cwd,
      },
    }).then(
      ({ stdout, stderr }) =>
        ({
          exitCode: 0,
          stderr,
          stdout,
        }) satisfies CliResult,
      (error: unknown) => {
        if (isExecError(error)) {
          return {
            exitCode: typeof error.code === "number" ? error.code : 1,
            stderr: error.stderr,
            stdout: error.stdout,
          } satisfies CliResult;
        }

        throw error;
      },
    );

    return result;
  });
}

function getRunId(input: unknown) {
  if (
    Array.isArray(input) &&
    input.length > 0 &&
    typeof input[0] === "object" &&
    input[0] !== null &&
    "runId" in input[0] &&
    typeof input[0].runId === "string"
  ) {
    return input[0].runId;
  }

  throw new Error("Expected list JSON output to contain a run id.");
}

function parseCliJson(stdout: string) {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      const end = jsonEndIndex(trimmed);
      if (end !== undefined) {
        return JSON.parse(trimmed.slice(0, end));
      }
    }
  }

  throw new Error(`Expected CLI stdout to start with JSON.\n${stdout}`);
}

function jsonEndIndex(input: string) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === undefined) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return undefined;
}

function repoRoot() {
  return new URL("../../..", import.meta.url).pathname;
}

function isExecError(input: unknown): input is {
  readonly code?: unknown;
  readonly stderr: string;
  readonly stdout: string;
} {
  return (
    typeof input === "object" &&
    input !== null &&
    "stdout" in input &&
    "stderr" in input
  );
}
