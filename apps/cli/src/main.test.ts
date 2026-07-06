import { NodeServices } from "@effect/platform-node";
import { describe, expect, it, layer } from "@effect/vitest";
import type { ServerMetadata } from "@gaia/core";
import { runSpecFile } from "@gaia/runtime";
import { runLocalGaiaServer } from "@gaia/server";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("gaia CLI local server read parity", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "matches direct list and status JSON output when opted into server reads",
      () =>
        Effect.gen(function* () {
          const cwd = yield* createRunStore("CLI server parity.");
          const server = yield* startLocalRunServer(cwd);
          try {
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
          } finally {
            yield* stopServer(server);
          }
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
          const server = yield* startLocalRunServer(cwd);
          try {
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
          } finally {
            yield* stopServer(server);
          }
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

    it.effect("rejects malformed foreground server ports", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-cli-port-" });
        const failed = yield* runGaia(cwd, ["server", "--port", "12345abc"], {
          timeoutMs: 3_000,
        });

        expect(failed.exitCode).toBe(1);
        expect(failed.stdout).toContain("InvalidServerPort");
        expect(failed.stdout).not.toContain("Gaia local API listening");
      }),
    );
  });
});

type CliResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type TestServer = {
  readonly close: Effect.Effect<void>;
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

function startLocalRunServer(rootDirectory: string) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<ServerMetadata>();
    const fiber = yield* runLocalGaiaServer({
      onReady: (metadata) => Deferred.succeed(ready, metadata).pipe(Effect.asVoid),
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
      url: metadata.url,
    } satisfies TestServer;
  });
}

function stopServer(server: TestServer) {
  return server.close;
}

function runGaiaJson(cwd: string, args: ReadonlyArray<string>) {
  return runGaia(cwd, args).pipe(
    Effect.map((result) => {
      expect(result.exitCode, JSON.stringify(result, null, 2)).toBe(0);
      return parseCliJson(result.stdout);
    }),
  );
}

function runGaia(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs?: number } = {},
) {
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
      timeout: options.timeoutMs,
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
