import { execFile } from "node:child_process";
import { chmod, realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  RunIdSchema,
  ServerMetadata,
} from "@gaia/core";
import {
  parseRuntimePath,
  runSpecFile,
  RuntimePathSchema,
} from "@gaia/runtime";
import {
  acceptFactoryRun,
  continueServerRun,
} from "@gaia/runtime/server-workflows";
import { makeMarkerWritingTestHarnessProviderRegistry } from "@gaia/runtime/test-support";
import { runLocalGaiaServer } from "@gaia/server";
import { Deferred, Effect, Fiber, FileSystem, Schema } from "effect";

const execFileAsync = promisify(execFile);

describe("gaia CLI local server read parity", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "matches direct list and status JSON output when opted into server reads",
      () =>
        Effect.gen(function* () {
          const { cwd, runId } =
            yield* createFactoryRunStoreState("CLI server parity.");
          const server = yield* startLocalRunServer(cwd);
          try {
            const [directList, serverList, directStatus, serverStatus] =
              yield* Effect.all(
                [
                  runGaiaJson(cwd, ["list", "--json"]),
                  runGaiaJson(cwd, [
                    "list",
                    "--json",
                    "--server-url",
                    server.url,
                  ]),
                  runGaiaJson(cwd, ["status", runId, "--json"]),
                  runGaiaJson(cwd, [
                    "status",
                    runId,
                    "--json",
                    "--server-url",
                    server.url,
                  ]),
                ],
                { concurrency: "unbounded" }
              );

            expect(serverList).toEqual(directList);
            expect(serverStatus).toEqual(directStatus);
          } finally {
            yield* stopServer(server);
          }
        }),
      20_000
    );

    it.effect(
      "matches direct events and artifact JSON output when opted into server reads",
      () =>
        Effect.gen(function* () {
          const { cwd, runId } = yield* createFactoryRunStoreState(
            "CLI server event and artifact parity."
          );
          const server = yield* startLocalRunServer(cwd);
          try {
            const [
              directEvents,
              serverEvents,
              directArtifact,
              serverArtifact,
              directPlanReview,
              serverPlanReview,
              directEvidenceReview,
              serverEvidenceReview,
              directVerificationResult,
              serverVerificationResult,
              directEventsHuman,
              serverEventsHuman,
              directArtifactHuman,
              serverArtifactHuman,
              directPlanReviewHuman,
              serverPlanReviewHuman,
            ] = yield* Effect.all(
              [
                runGaiaJson(cwd, ["events", runId, "--json"]),
                runGaiaJson(cwd, [
                  "events",
                  runId,
                  "--json",
                  "--server-url",
                  server.url,
                ]),
                runGaiaJson(cwd, ["artifact", runId, "report-json", "--json"]),
                runGaiaJson(cwd, [
                  "artifact",
                  runId,
                  "report-json",
                  "--json",
                  "--server-url",
                  server.url,
                ]),
                runGaiaJson(cwd, ["artifact", runId, "plan-review", "--json"]),
                runGaiaJson(cwd, [
                  "artifact",
                  runId,
                  "plan-review",
                  "--json",
                  "--server-url",
                  server.url,
                ]),
                runGaiaJson(cwd, [
                  "artifact",
                  runId,
                  "evidence-review",
                  "--json",
                ]),
                runGaiaJson(cwd, [
                  "artifact",
                  runId,
                  "evidence-review",
                  "--json",
                  "--server-url",
                  server.url,
                ]),
                runGaiaJson(cwd, [
                  "artifact",
                  runId,
                  "verification-result",
                  "--json",
                ]),
                runGaiaJson(cwd, [
                  "artifact",
                  runId,
                  "verification-result",
                  "--json",
                  "--server-url",
                  server.url,
                ]),
                runGaia(cwd, ["events", runId]),
                runGaia(cwd, ["events", runId, "--server-url", server.url]),
                runGaia(cwd, ["artifact", runId, "report-json"]),
                runGaia(cwd, [
                  "artifact",
                  runId,
                  "report-json",
                  "--server-url",
                  server.url,
                ]),
                runGaia(cwd, ["artifact", runId, "plan-review"]),
                runGaia(cwd, [
                  "artifact",
                  runId,
                  "plan-review",
                  "--server-url",
                  server.url,
                ]),
              ],
              { concurrency: "unbounded" }
            );

            expect(serverEvents).toEqual(directEvents);
            expect(serverArtifact).toEqual(directArtifact);
            expect(serverPlanReview).toEqual(directPlanReview);
            expect(serverEvidenceReview).toEqual(directEvidenceReview);
            expect(serverVerificationResult).toEqual(directVerificationResult);
            expect(serverEventsHuman.stdout).toBe(directEventsHuman.stdout);
            expect(serverArtifactHuman.stdout).toBe(directArtifactHuman.stdout);
            expect(serverPlanReviewHuman.stdout).toBe(
              directPlanReviewHuman.stdout
            );
            expect(directPlanReviewHuman.stdout).toContain('"phase": "plan"');
            expect(
              getObjectString(directVerificationResult, "artifactName")
            ).toBe("verification-result");
          } finally {
            yield* stopServer(server);
          }
        }),
      20_000
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
      20_000
    );

    it.effect(
      "rejects traversal artifacts before transport with direct and server parity",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-cli-artifact-input-",
          });
          const base = ["artifact", "run-L84-kMhLY8", "../events.jsonl"];
          const [directJson, serverJson, directHuman, serverHuman] =
            yield* Effect.all(
              [
                runGaia(cwd, [...base, "--json"]),
                runGaia(cwd, [
                  ...base,
                  "--json",
                  "--server-url",
                  "http://127.0.0.1:1",
                ]),
                runGaia(cwd, base),
                runGaia(cwd, [...base, "--server-url", "http://127.0.0.1:1"]),
              ],
              { concurrency: "unbounded" }
            );
          const expectedJson = {
            code: "ArtifactNotAllowed",
            message: "Artifact is not allowlisted for local API reads.",
            recoverable: false,
            status: "failed",
          };

          expect(directJson.exitCode).toBe(1);
          expect(serverJson.exitCode).toBe(1);
          expect(parseCliJson(directJson.stdout)).toEqual(expectedJson);
          expect(parseCliJson(serverJson.stdout)).toEqual(expectedJson);
          expect(directHuman.exitCode).toBe(1);
          expect(serverHuman.exitCode).toBe(1);
          expect(serverHuman.stdout).toBe(directHuman.stdout);
        }),
      20_000
    );

    it.effect(
      "autostarts and reuses a workspace server for opt-in run, status, list, and events",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-cli-server-",
          });
          const specPath = `${cwd}/spec.md`;
          yield* fs.writeFileString(
            specPath,
            "Run through opt-in server mode.\n"
          );

          try {
            const accepted = yield* runGaiaJson(cwd, [
              "run",
              specPath,
              "--server",
              "--json",
            ]);
            const runId = getObjectString(accepted, "runId");
            const metadata = yield* readServerMetadata(cwd);
            const status = yield* waitForCompletedServerRun(cwd, runId);
            const [list, events] = yield* Effect.all(
              [
                runGaiaJson(cwd, ["list", "--server", "--json"]),
                runGaiaJson(cwd, ["events", runId, "--server", "--json"]),
              ],
              { concurrency: "unbounded" }
            );
            const reused = yield* readServerMetadata(cwd);

            expect(getObjectString(accepted, "status")).toBe("accepted");
            expect(status.status).toBe("completed");
            expect(getRunId(list)).toBe(runId);
            expect(getObjectString(events, "runId")).toBe(runId);
            expect(getObjectArray(events, "events").length).toBeGreaterThan(0);
            expect(reused.serverId).toBe(metadata.serverId);
            expect(yield* fs.exists(`${cwd}/.gaia/server.log`)).toBe(true);

            const [humanStatus, humanList, humanEvents] = yield* Effect.all(
              [
                runGaia(cwd, ["status", runId, "--server"]),
                runGaia(cwd, ["list", "--server"]),
                runGaia(cwd, ["events", runId, "--server"]),
              ],
              { concurrency: "unbounded" }
            );
            expect(humanStatus.stdout).toContain(`completed: ${runId}`);
            expect(humanList.stdout).toContain(runId);
            expect(humanEvents.stdout).toContain(`events: ${runId}`);
          } finally {
            yield* stopAutostartedServer(cwd);
          }
        }),
      30_000
    );

    it.effect(
      "keeps direct run as the default when --server is absent",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-cli-direct-",
          });
          const specPath = `${cwd}/spec.md`;
          yield* fs.makeDirectory(`${cwd}/.gaia`, { recursive: true });
          yield* fs.writeFileString(specPath, "Run directly by default.\n");
          yield* fs.writeFileString(
            `${cwd}/.gaia/server.json`,
            `${JSON.stringify(
              {
                gaiaRoot: `${cwd}/.gaia`,
                host: "127.0.0.1",
                pid: 999_999,
                port: 1,
                serverId: "srv_stale",
                startedAt: "2026-07-06T00:00:00.000Z",
                updatedAt: "2026-07-06T00:00:00.000Z",
                url: "http://example.com:1",
                version: 1,
                workspaceRoot: cwd,
              },
              null,
              2
            )}\n`
          );

          const summary = yield* runGaiaJson(cwd, ["run", specPath, "--json"]);
          const metadata = yield* readServerMetadata(cwd);

          expect(getObjectString(summary, "status")).toBe("completed");
          expect(getObjectString(metadata, "serverId")).toBe("srv_stale");
          expect(yield* fs.exists(`${cwd}/.gaia/server.log`)).toBe(false);
        }),
      20_000
    );

    it.effect(
      "uses the latest pointer for status through server mode",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-cli-latest-",
          });
          yield* createFactoryRun(cwd, "First latest candidate.\n");
          yield* createFactoryRun(cwd, "Second latest candidate.\n");
          const directList = yield* runGaiaJson(cwd, ["list", "--json"]);
          const runIds = getRunIds(directList);
          const selected = runIds[1] ?? runIds[0];
          if (selected === undefined) {
            throw new Error("Expected at least one Gaia run.");
          }
          yield* fs.writeFileString(`${cwd}/.gaia/latest`, selected);

          const server = yield* startLocalRunServer(cwd);
          try {
            const directStatus = yield* runGaiaJson(cwd, ["status", "--json"]);
            const serverStatus = yield* runGaiaJson(cwd, [
              "status",
              "--server-url",
              server.url,
              "--json",
            ]);

            expect(getObjectString(directStatus, "runId")).toBe(selected);
            expect(serverStatus).toEqual(directStatus);
          } finally {
            yield* stopServer(server);
          }
        }),
      25_000
    );

    it.effect(
      "honors explicit --server-url instead of discovery metadata",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const sourceRoot = yield* createFactoryRunStore(
            "Explicit URL source."
          );
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-cli-url-" });
          const sourceRunId = getRunId(
            yield* runGaiaJson(sourceRoot, ["list", "--json"])
          );
          const sourceServer = yield* startLocalRunServer(sourceRoot);
          const localServer = yield* startLocalRunServer(cwd);
          try {
            const list = yield* runGaiaJson(cwd, [
              "list",
              "--json",
              "--server-url",
              sourceServer.url,
            ]);

            expect(getRunId(list)).toBe(sourceRunId);
            expect(
              getObjectString(yield* readServerMetadata(cwd), "serverId")
            ).toBe(localServer.serverId);
          } finally {
            yield* stopServer(sourceServer);
            yield* stopServer(localServer);
          }
        }),
      25_000
    );

    it.effect(
      "recovers stale server metadata when --server is requested",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-cli-stale-",
          });
          yield* fs.makeDirectory(`${cwd}/.gaia`, { recursive: true });
          yield* fs.writeFileString(
            `${cwd}/.gaia/server.json`,
            `${JSON.stringify(
              {
                gaiaRoot: `${cwd}/.gaia`,
                host: "127.0.0.1",
                pid: 999_999,
                port: 1,
                serverId: "srv_stale",
                startedAt: "2026-07-06T00:00:00.000Z",
                updatedAt: "2026-07-06T00:00:00.000Z",
                url: "http://127.0.0.1:1",
                version: 1,
                workspaceRoot: cwd,
              },
              null,
              2
            )}\n`
          );

          try {
            const list = yield* runGaiaJson(cwd, [
              "list",
              "--server",
              "--json",
            ]);
            const metadata = yield* readServerMetadata(cwd);
            const log = yield* fs.readFileString(`${cwd}/.gaia/server.log`);

            expect(list).toEqual([]);
            expect(metadata.serverId).not.toBe("srv_stale");
            expect(
              yield* canonicalPath(getObjectString(metadata, "workspaceRoot"))
            ).toBe(yield* canonicalPath(cwd));
            expect(log).toContain("discarding stale local server metadata");
            expect(log).toContain("serverId=srv_stale");
            expect(log).toContain("pid=999999");
            expect(log).toContain("starting replacement server");
          } finally {
            yield* stopAutostartedServer(cwd);
          }
        }),
      20_000
    );

    it.effect(
      "ignores healthy wrong-root metadata when --server is requested",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const wrongRoot = yield* createRunStore("Wrong root server.");
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-cli-wrong-root-",
          });
          const wrongServer = yield* startLocalRunServer(wrongRoot);
          try {
            const wrongMetadata = yield* fs.readFileString(
              `${wrongRoot}/.gaia/server.json`
            );
            yield* fs.makeDirectory(`${cwd}/.gaia`, { recursive: true });
            yield* fs.writeFileString(
              `${cwd}/.gaia/server.json`,
              wrongMetadata
            );

            const list = yield* runGaiaJson(cwd, [
              "list",
              "--server",
              "--json",
            ]);
            const metadata = yield* readServerMetadata(cwd);
            const log = yield* fs.readFileString(`${cwd}/.gaia/server.log`);

            expect(list).toEqual([]);
            expect(
              yield* canonicalPath(getObjectString(metadata, "workspaceRoot"))
            ).toBe(yield* canonicalPath(cwd));
            expect(metadata.serverId).not.toBe(wrongServer.serverId);
            expect(log).toContain(
              "discarding wrong-root local server metadata"
            );
            expect(log).toContain(`serverId=${wrongServer.serverId}`);
            expect(log).toContain("expectedWorkspaceRoot=");
            expect(log).toContain("starting replacement server");
          } finally {
            yield* stopServer(wrongServer);
            yield* stopAutostartedServer(cwd);
          }
        }),
      30_000
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
      })
    );

    it.effect(
      "rejects malformed run IDs and unusable server URLs at the CLI boundary without echoing them",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-cli-domain-input-",
          });
          const [
            runIdFailure,
            schemeFailure,
            relativeFailure,
            sensitiveFailure,
          ] = yield* Effect.all(
            [
              runGaia(cwd, ["status", "not-a-run", "--json"]),
              runGaia(cwd, [
                "list",
                "--json",
                "--server-url",
                "ftp://127.0.0.1:4321",
              ]),
              runGaia(cwd, ["list", "--json", "--server-url", "/gaia-api"]),
              runGaia(cwd, [
                "list",
                "--json",
                "--server-url",
                "https://example.test/gaia?token=review-secret",
              ]),
            ],
            { concurrency: "unbounded" }
          );

          expect(runIdFailure.exitCode).toBe(1);
          expect(parseCliJson(runIdFailure.stdout)).toEqual({
            code: "InvalidRunId",
            message: "Invalid Gaia run id 'not-a-run'.",
            recoverable: false,
            status: "failed",
          });
          for (const failure of [
            schemeFailure,
            relativeFailure,
            sensitiveFailure,
          ]) {
            expect(failure.exitCode).toBe(1);
            expect(parseCliJson(failure.stdout)).toEqual({
              code: "InvalidServerUrl",
              message: "Invalid local Gaia server URL.",
              recoverable: false,
              status: "failed",
            });
          }
          const sensitiveOutput = `${sensitiveFailure.stdout}\n${sensitiveFailure.stderr}`;
          expect(sensitiveOutput).not.toContain("review-secret");
          expect(sensitiveOutput).not.toContain("token=");
        })
    );

    it.effect(
      "requires one explicit finite merge-readiness method and exact inputs",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-cli-readiness-parser-",
          });
          const base = [
            "merge-readiness",
            "run-1234567890",
            "readiness-1",
            "--server-url",
            "http://127.0.0.1:1",
          ];
          const [omitted, unknown, duplicate, excess] = yield* Effect.all(
            [
              runGaia(cwd, base),
              runGaia(cwd, [...base, "--method", "octopus"]),
              runGaia(cwd, [
                ...base,
                "--method",
                "merge",
                "--method",
                "squash",
              ]),
              runGaia(cwd, [...base, "extra", "--method", "merge"]),
            ],
            { concurrency: "unbounded" }
          );
          for (const result of [omitted, unknown, duplicate, excess])
            expect(result.exitCode).toBe(1);
        })
    );

    it.effect(
      "renders no configured PR checks as an operator-facing human state",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-cli-checks-",
          });
          const fakeGh = yield* createFakeGh(
            cwd,
            [
              "#!/bin/sh",
              "echo \"no checks reported on the 'gaia/example' branch\" >&2",
              "exit 1",
              "",
            ].join("\n")
          );

          const result = yield* runGaia(cwd, ["pr-checks", "1"], {
            env: { PATH: `${fakeGh}:${process.env.PATH ?? ""}` },
          });

          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("checks: no checks configured");
          expect(result.stdout).toContain("outcome: no checks configured");
        })
    );

    it.effect("emits provider unavailable in PR checks JSON output", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-cli-checks-" });
        const fakeGh = yield* createFakeGh(
          cwd,
          [
            "#!/bin/sh",
            'echo "GraphQL: Resource not accessible by integration" >&2',
            "exit 1",
            "",
          ].join("\n")
        );

        const result = yield* runGaia(cwd, ["pr-checks", "1", "--json"], {
          env: { PATH: `${fakeGh}:${process.env.PATH ?? ""}` },
        });

        expect(result.exitCode).toBe(0);
        expect(parseCliJson(result.stdout)).toMatchObject({
          checks: [],
          pr: "1",
          status: "provider-unavailable",
        });
      })
    );
  });
});

const CliResultSchema = Schema.Struct({
  exitCode: Schema.Number,
  stderr: Schema.String,
  stdout: Schema.String,
});
type CliResult = typeof CliResultSchema.Type;

type TestServer = {
  readonly close: Effect.Effect<void>;
  readonly serverId: typeof ServerMetadata.fields.serverId.Type;
  readonly url: typeof ServerMetadata.fields.url.Type;
};

function createRunStore(specBody: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-cli-" });
    yield* createSpecRun(cwd, specBody);
    return cwd;
  });
}

function createFactoryRunStore(specBody: string) {
  return createFactoryRunStoreState(specBody).pipe(
    Effect.map(({ cwd }) => cwd)
  );
}

function createFactoryRunStoreState(specBody: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-cli-" });
    const accepted = yield* createFactoryRun(cwd, specBody);
    return { cwd, runId: accepted.runId };
  });
}

function createFactoryRun(cwd: string, specBody: string) {
  return Effect.gen(function* () {
    const accepted = yield* acceptFactoryRun(
      {
        execution: codexAppServerExecutionSelection,
        workflow: "issueDelivery",
        workItem: {
          description: specBody,
          kind: "issue",
          title: "CLI server parity",
        },
      },
      {
        harnessProviderRegistry:
          makeMarkerWritingTestHarnessProviderRegistry(cwd),
        rootDirectory: cwd,
      }
    );
    yield* continueServerRun(accepted.runId, {
      harnessProviderRegistry:
        makeMarkerWritingTestHarnessProviderRegistry(cwd),
      rootDirectory: cwd,
    });
    return accepted;
  });
}

function createSpecRun(cwd: string, specBody: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const specPath = `${cwd}/spec-${Date.now()}.md`;
    yield* fs.writeFileString(specPath, specBody);
    return yield* runSpecFile(specPath, { rootDirectory: cwd });
  });
}

function startLocalRunServer(
  rootDirectoryInput: typeof RuntimePathSchema.Encoded
) {
  return Effect.gen(function* () {
    const rootDirectory = parseRuntimePath(rootDirectoryInput);
    const ready = yield* Deferred.make<ServerMetadata>();
    const fiber = yield* runLocalGaiaServer({
      harnessProviderRegistry:
        makeMarkerWritingTestHarnessProviderRegistry(rootDirectory),
      onReady: (metadata) =>
        Deferred.succeed(ready, metadata).pipe(Effect.asVoid),
      rootDirectory,
    }).pipe(Effect.forkScoped);
    const startupFailed = Fiber.await(fiber).pipe(
      Effect.flatMap((exit) =>
        Effect.fail(
          new Error(`Local test server exited before ready: ${exit._tag}.`)
        )
      )
    );
    const metadata = yield* Deferred.await(ready).pipe(
      Effect.raceFirst(startupFailed),
      Effect.timeout("5 seconds")
    );
    return {
      close: Fiber.interrupt(fiber).pipe(Effect.asVoid),
      serverId: metadata.serverId,
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
    })
  );
}

const RunGaiaOptionsSchema = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  timeoutMs: Schema.optionalKey(Schema.Number),
});

function runGaia(
  cwd: string,
  args: ReadonlyArray<string>,
  options: typeof RunGaiaOptionsSchema.Type = {}
) {
  return Effect.promise(async () => {
    const result = await execFileAsync(
      `${repoRoot()}/apps/cli/node_modules/.bin/tsx`,
      [`${repoRoot()}/apps/cli/src/bootstrap.ts`, ...args],
      {
        cwd,
        env: {
          ...process.env,
          ...options.env,
          INIT_CWD: cwd,
        },
        timeout: options.timeoutMs,
      }
    ).then(
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
      }
    );

    return result;
  });
}

function createFakeGh(cwd: string, script: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bin = `${cwd}/bin`;
    const gh = `${bin}/gh`;
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(gh, script);
    yield* Effect.promise(() => chmod(gh, 0o755));
    return bin;
  });
}

function getRunId(input: unknown) {
  const first = getRunIds(input)[0];
  if (first !== undefined) {
    return first;
  }

  throw new Error("Expected list JSON output to contain a run id.");
}

function getRunIds(input: unknown) {
  if (
    Array.isArray(input) &&
    input.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "runId" in entry &&
        typeof entry.runId === "string"
    )
  ) {
    return input.map((entry) => entry.runId);
  }

  throw new Error("Expected list JSON output to contain run ids.");
}

function waitForCompletedServerRun(
  cwd: string,
  runIdInput: typeof RunIdSchema.Encoded
) {
  return Effect.gen(function* () {
    const runId = Schema.decodeUnknownSync(RunIdSchema)(runIdInput);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = yield* runGaiaJson(cwd, [
        "status",
        runId,
        "--server",
        "--json",
      ]);
      if (isObjectRecord(status) && status.status === "completed") {
        return status;
      }

      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
          })
      );
    }

    throw new Error(`Server run ${runId} did not complete in time.`);
  });
}

function readServerMetadata(cwd: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return parseJsonObject(
      yield* fs.readFileString(`${cwd}/.gaia/server.json`)
    );
  });
}

function stopAutostartedServer(cwd: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const metadataPath = `${cwd}/.gaia/server.json`;
    if (!(yield* fs.exists(metadataPath))) {
      return;
    }

    const metadata = parseJsonObject(yield* fs.readFileString(metadataPath));
    const pid = metadata["pid"];
    if (typeof pid === "number") {
      yield* Effect.sync(() => {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The process may already have exited after the command under test.
        }
      });
    }
  });
}

function getObjectString(input: unknown, key: string) {
  const value = parseJsonObjectValue(input, key);
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Expected JSON object string field ${key}.`);
}

function getObjectArray(input: unknown, key: string) {
  const value = parseJsonObjectValue(input, key);
  if (Array.isArray(value)) {
    return value;
  }

  throw new Error(`Expected JSON object array field ${key}.`);
}

function parseJsonObjectValue(input: unknown, key: string) {
  const object = parseJsonObject(input);
  if (key in object) {
    return object[key];
  }

  throw new Error(`Expected JSON object field ${key}.`);
}

function parseJsonObject(input: unknown) {
  if (isObjectRecord(input)) {
    return input;
  }

  if (typeof input === "string") {
    const parsed = JSON.parse(input) as unknown;
    if (isObjectRecord(parsed)) {
      return parsed;
    }
  }

  throw new Error("Expected a JSON object.");
}

function isObjectRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function canonicalPath(input: typeof RuntimePathSchema.Encoded) {
  const path = parseRuntimePath(input);
  return Effect.promise(() => realpath(path));
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

const CliJsonTextSchema = Schema.String;

function jsonEndIndex(input: typeof CliJsonTextSchema.Type) {
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
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
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
