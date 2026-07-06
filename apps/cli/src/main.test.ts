import { NodeServices } from "@effect/platform-node";
import { describe, expect, it, layer } from "@effect/vitest";
import type { ServerMetadata } from "@gaia/core";
import { runSpecFile } from "@gaia/runtime";
import { runLocalGaiaServer } from "@gaia/server";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
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
              "report-json",
              "--json",
            ]);
            const serverArtifact = yield* runGaiaJson(cwd, [
              "artifact",
              runId,
              "report-json",
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

    it.effect(
      "auto-starts a workspace server for run status list and events server mode",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-cli-server-" });
          yield* fs.writeFileString(`${cwd}/spec.md`, "Run through server mode.\n");
          try {
            const created = yield* runGaiaJson(cwd, [
              "run",
              "spec.md",
              "--server",
              "--json",
            ]);
            const runId = getRunIdFromSummary(created);
            const metadata = yield* readServerMetadata(cwd);
            const log = yield* fs.readFileString(`${cwd}/.gaia/server.log`);

            expect(created).toMatchObject({
              runId,
              state: "created",
              status: "running",
            });
            expect(yield* realPath(metadata.workspaceRoot)).toBe(
              yield* realPath(cwd),
            );
            expect(metadata.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
            expect(log).toContain(metadata.url);

            yield* waitForCompletedStatus(cwd, runId);
            const directList = yield* runGaiaJson(cwd, ["list", "--json"]);
            const serverList = yield* runGaiaJson(cwd, [
              "list",
              "--server",
              "--json",
            ]);
            const serverStatus = yield* runGaiaJson(cwd, [
              "status",
              runId,
              "--server",
              "--json",
            ]);
            const serverEvents = yield* runGaiaJson(cwd, [
              "events",
              runId,
              "--server",
              "--json",
            ]);

            expect(serverList).toEqual(directList);
            expect(serverStatus).toMatchObject({
              runId,
              status: "completed",
            });
            expect(serverEvents).toMatchObject({ runId });
            expect(getEventCount(serverEvents)).toBeGreaterThan(1);
          } finally {
            yield* stopBackgroundServer(cwd);
          }
        }),
      30_000,
    );

    it.effect("reuses healthy same-root server metadata for server mode", () =>
      Effect.gen(function* () {
        const cwd = yield* createRunStore("CLI server reuse.");
        try {
          yield* runGaiaJson(cwd, ["list", "--server", "--json"]);
          const first = yield* readServerMetadata(cwd);
          yield* runGaiaJson(cwd, ["status", "--server", "--json"]);
          const second = yield* readServerMetadata(cwd);

          expect(second.serverId).toBe(first.serverId);
          expect(second.url).toBe(first.url);
        } finally {
          yield* stopBackgroundServer(cwd);
        }
      }),
      30_000,
    );

    it.effect("recovers malformed stale server metadata for server mode", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* createRunStore("CLI server stale metadata.");
        try {
          yield* fs.writeFileString(`${cwd}/.gaia/server.json`, "not-json\n");

          const list = yield* runGaiaJson(cwd, ["list", "--server", "--json"]);
          const metadata = yield* readServerMetadata(cwd);

          expect(getRunId(list)).toBeDefined();
          expect(yield* realPath(metadata.workspaceRoot)).toBe(
            yield* realPath(cwd),
          );
        } finally {
          yield* stopBackgroundServer(cwd);
        }
      }),
      30_000,
    );

    it.effect("replaces live wrong-root server metadata for server mode", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* createRunStore("CLI server current root.");
        const otherCwd = yield* createRunStore("CLI server other root.");
        const otherServer = yield* startLocalRunServer(otherCwd);
        try {
          yield* fs.makeDirectory(`${cwd}/.gaia`, { recursive: true });
          yield* fs.writeFileString(
            `${cwd}/.gaia/server.json`,
            `${JSON.stringify(otherServer.metadata, null, 2)}\n`,
          );

          const list = yield* runGaiaJson(cwd, ["list", "--server", "--json"]);
          const currentMetadata = yield* readServerMetadata(cwd);

          expect(getRunId(list)).toBeDefined();
          expect(yield* realPath(currentMetadata.workspaceRoot)).toBe(
            yield* realPath(cwd),
          );
          expect(currentMetadata.serverId).not.toBe(otherServer.metadata.serverId);
        } finally {
          yield* stopBackgroundServer(cwd);
          yield* stopServer(otherServer);
        }
      }),
      30_000,
    );

    it.effect("rejects path-bearing run options in server mode", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-cli-server-" });
        yield* fs.writeFileString(`${cwd}/spec.md`, "Reject server options.\n");
        const failed = yield* runGaia(cwd, [
          "run",
          "spec.md",
          "--server",
          "--workspace-source",
          ".",
          "--json",
        ]);

        expect(failed.exitCode).toBe(1);
        expect(parseCliJson(failed.stdout)).toMatchObject({
          code: "UnsupportedServerRunOption",
          recoverable: false,
          status: "failed",
        });
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
  readonly metadata: ServerMetadata;
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
      metadata,
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

function getRunIdFromSummary(input: unknown) {
  if (
    typeof input === "object" &&
    input !== null &&
    "runId" in input &&
    typeof input.runId === "string"
  ) {
    return input.runId;
  }

  throw new Error("Expected summary JSON output to contain a run id.");
}

function getEventCount(input: unknown) {
  if (
    typeof input === "object" &&
    input !== null &&
    "events" in input &&
    Array.isArray(input.events)
  ) {
    return input.events.length;
  }

  throw new Error("Expected events JSON output to contain events.");
}

function waitForCompletedStatus(cwd: string, runId: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = yield* runGaiaJson(cwd, ["status", runId, "--json"]);
      if (
        typeof status === "object" &&
        status !== null &&
        "status" in status &&
        status.status === "completed"
      ) {
        return;
      }
      yield* Effect.sleep("250 millis");
    }

    throw new Error(`Run ${runId} did not complete before timeout.`);
  });
}

function readServerMetadata(cwd: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(`${cwd}/.gaia/server.json`);
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "serverId" in parsed &&
      "url" in parsed &&
      "workspaceRoot" in parsed &&
      typeof parsed.serverId === "string" &&
      typeof parsed.url === "string" &&
      typeof parsed.workspaceRoot === "string"
    ) {
      return {
        serverId: parsed.serverId,
        url: parsed.url,
        workspaceRoot: parsed.workspaceRoot,
      };
    }

    throw new Error("Expected valid server metadata.");
  });
}

function realPath(input: string) {
  return Effect.promise(() => realpath(input));
}

function stopBackgroundServer(cwd: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(`${cwd}/.gaia/server.json`);
    if (!exists) {
      return;
    }

    const text = yield* fs.readFileString(`${cwd}/.gaia/server.json`);
    const parsed: unknown = JSON.parse(text);
    const pid =
      typeof parsed === "object" && parsed !== null && "pid" in parsed
        ? parsed.pid
        : undefined;
    if (typeof pid === "number") {
      yield* Effect.sync(() => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Best-effort cleanup for background server tests.
        }
      });
    }
  });
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
