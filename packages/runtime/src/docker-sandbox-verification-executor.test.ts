import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { VerificationCommandRequestV1 } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";

import {
  makeDockerSandboxCli,
  nodeDockerSandboxCliRunner,
} from "./docker-sandbox-cli.js";
import {
  classifyDockerSandboxExecOutcome,
  executeDockerSandboxVerification,
  reconcileDockerSandboxVerification,
} from "./docker-sandbox-verification-executor.js";
import { parseRuntimePath } from "./paths.js";
import {
  parseVerificationExecutionProfile,
  readVerificationExecutionProfile,
} from "./verification-execution-profile.js";

const runLiveDockerSandboxProof =
  process.env["GAIA_DOCKER_SANDBOX_LIVE"] === "1";

describe("Docker Sandbox verification outcome classification", () => {
  it("classifies structural env and host outcomes without stderr guessing", () => {
    assert.deepEqual(
      classifyDockerSandboxExecOutcome({
        kind: "exited",
        observedExitCode: 125,
      }),
      {
        code: "VerificationProviderFailure",
        kind: "providerFailure",
        observedProviderExitCode: 125,
        retryable: false,
      }
    );
    assert.deepEqual(
      classifyDockerSandboxExecOutcome({
        kind: "exited",
        observedExitCode: 126,
      }),
      {
        observedProviderExitCode: 126,
        status: "spawnFailed",
      }
    );
    assert.deepEqual(
      classifyDockerSandboxExecOutcome({
        kind: "exited",
        observedExitCode: 127,
      }),
      {
        observedProviderExitCode: 127,
        status: "missingExecutable",
      }
    );
    assert.deepEqual(
      classifyDockerSandboxExecOutcome({
        kind: "exited",
        observedExitCode: 9,
      }),
      {
        exitCode: 9,
        observedProviderExitCode: 9,
        status: "nonZero",
      }
    );
    assert.deepEqual(
      classifyDockerSandboxExecOutcome({
        kind: "hostSpawnFailure",
        stage: "preflight",
      }),
      {
        code: "VerificationProviderFailure",
        kind: "providerFailure",
        retryable: false,
      }
    );
    assert.deepEqual(
      classifyDockerSandboxExecOutcome({
        kind: "hostSpawnFailure",
        stage: "dispatch",
      }),
      {
        code: "VerificationCommandOutcomeUnknown",
        kind: "outcomeUnknown",
        retryable: false,
      }
    );
  });

  layer(NodeServices.layer)((it) => {
    it.effect(
      "stops before observation and removes the exact name and UUID",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-sbx-verification-",
          });
          const workspace = parseRuntimePath(`${root}/workspace`);
          const stdoutPath = parseRuntimePath(`${root}/stdout.bin`);
          const stderrPath = parseRuntimePath(`${root}/stderr.bin`);
          yield* fs.makeDirectory(workspace);
          let sandbox: { id: string; name: string; status: string } | undefined;
          const uuid = "123e4567-e89b-12d3-a456-426614174000";
          const cli = makeDockerSandboxCli((command) => {
            const [verb] = command.args;
            if (verb === "version")
              return Effect.succeed({
                exitCode: 0,
                stderr: "",
                stdout:
                  "sbx version: v0.35.0 01e01520456e4126a9653471e7072e4d9b280321\n",
              });
            if (verb === "policy")
              return Effect.succeed({
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({
                  rules: [
                    {
                      decision: "deny",
                      resource_type: "network",
                      resources: ["**"],
                      status: "active",
                    },
                  ],
                }),
              });
            if (verb === "ls")
              return Effect.succeed({
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({
                  sandboxes: sandbox === undefined ? [] : [sandbox],
                }),
              });
            if (verb === "create") {
              sandbox = { id: uuid, name: "gaia-sandbox-1", status: "running" };
              return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
            }
            if (verb === "exec")
              return Effect.succeed({
                exitCode: 0,
                stderr: "",
                stdout: "gaia-claim-ok\n",
              });
            if (verb === "stop") {
              sandbox = { id: uuid, name: "gaia-sandbox-1", status: "stopped" };
              return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
            }
            if (verb === "rm") {
              sandbox = undefined;
              return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
            }
            return Effect.die("unexpected fake sbx command");
          });
          const profile = parseVerificationExecutionProfile({
            credentials: {
              credentialProfileId: "credentials-none-env-i-v1",
              environmentScrubExecutable: "/usr/bin/env",
              expectedCredentialLikeCount: 0,
              inheritCommandEnvironment: false,
              minimalPath: "/usr/bin:/bin",
              mode: "none",
            },
            executables: [
              {
                executableId: "posix-printf-v1",
                sandboxPath: "/usr/bin/printf",
              },
            ],
            imageDigest:
              "sha256:39cf20eca861ec92747487af6197f6d916f774bdb98245d267dbd8dfd3debb05",
            policy: {
              activeAllowCount: 0,
              network: "denied",
              policyId: "local-deny-all-v1",
              workspaceMount: "direct-sole-read-write",
            },
            profileId: "docker-sandbox-claim-verification-v1",
            provider: {
              build: "01e01520456e4126a9653471e7072e4d9b280321",
              cliExecutableId: "sbx-v0.35.0",
              providerId: "docker-sandboxes-sbx",
              version: "0.35.0",
            },
            templateReference:
              "docker/sandbox-templates:shell-docker@sha256:39cf20eca861ec92747487af6197f6d916f774bdb98245d267dbd8dfd3debb05",
            version: 1,
          });
          const request = Schema.decodeUnknownSync(
            VerificationCommandRequestV1
          )({
            argv: ["%s", "gaia-claim-ok\n"],
            credentials: "none",
            executableId: "posix-printf-v1",
            expectedExitCode: 0,
            expectedStdoutByteLength: 14,
            expectedStdoutSha256:
              "c67d2c0ac3e5ea53ed76dadc9aab773e884efedcaac2be11aaa4b096576f5849",
            network: "denied",
            outputLimitBytes: 1_048_576,
            timeoutMs: 30_000,
            workingDirectory: ".",
            workspaceAccess: "read-write",
          });
          const receipt = yield* Effect.scoped(
            executeDockerSandboxVerification(
              {
                authorityDigest: "1".repeat(64),
                claimId: `proof-claim:sha256:${"2".repeat(64)}`,
                contractDigest: "3".repeat(64),
                contractId: "run-contract:run-Gaia145V2x:v2",
                executionEvidenceIdentityDigest: "4".repeat(64),
                generationSequence: 5,
                onSandboxCreated: () => Effect.void,
                request,
                runId: "run-Gaia145V2x",
                sandboxName: "gaia-sandbox-1",
                stderrArtifactPath:
                  "verification/claims/smoke-command/stderr.bin",
                stderrPath,
                stdoutArtifactPath:
                  "verification/claims/smoke-command/stdout.bin",
                stdoutPath,
                targetDigest: "5".repeat(64),
                workspace,
              },
              cli,
              profile
            )
          );

          assert.strictEqual(receipt.status, "succeeded");
          assert.strictEqual(receipt.cleanup.finalAbsenceConfirmed, true);
          assert.strictEqual(sandbox, undefined);
          assert.strictEqual(
            yield* fs.readFileString(stdoutPath),
            "gaia-claim-ok\n"
          );

          const cappedRequest = Schema.decodeUnknownSync(
            VerificationCommandRequestV1
          )({ ...request, outputLimitBytes: 4 });
          const capped = yield* Effect.scoped(
            executeDockerSandboxVerification(
              {
                authorityDigest: "1".repeat(64),
                claimId: `proof-claim:sha256:${"2".repeat(64)}`,
                contractDigest: "3".repeat(64),
                contractId: "run-contract:run-Gaia145V2x:v2",
                executionEvidenceIdentityDigest: "4".repeat(64),
                generationSequence: 6,
                onSandboxCreated: () => Effect.void,
                request: cappedRequest,
                runId: "run-Gaia145V2x",
                sandboxName: "gaia-sandbox-1",
                stderrArtifactPath:
                  "verification/claims/smoke-command/stderr.bin",
                stderrPath,
                stdoutArtifactPath:
                  "verification/claims/smoke-command/stdout.bin",
                stdoutPath,
                targetDigest: "5".repeat(64),
                workspace,
              },
              cli,
              profile
            )
          );
          assert.strictEqual(capped.status, "outputLimitExceeded");
          assert.strictEqual(capped.cleanup.finalAbsenceConfirmed, true);
          assert.strictEqual(sandbox, undefined);
          assert.strictEqual(yield* fs.readFileString(stdoutPath), "gaia");
          assert.strictEqual(capped.stdout.observedByteCount, 14);
          assert.strictEqual(capped.stdout.retainedByteCount, 4);
          assert.strictEqual(capped.stdout.truncated, true);
          const reconciled = yield* reconcileDockerSandboxVerification(
            {
              actionId: "reconcile-gaia-145",
              claimId: `proof-claim:sha256:${"2".repeat(64)}`,
              contractDigest: "3".repeat(64),
              executionEvidenceIdentityDigest: "4".repeat(64),
              generationSequence: 6,
              reason: "commandStartOutcomeUnknown",
              runId: "run-Gaia145V2x",
              sandboxName: "gaia-sandbox-1",
              sandboxUuid: uuid,
            },
            cli,
            profile
          );
          assert.deepEqual(
            { ...reconciled.operationCounts },
            {
              create: 0,
              exec: 0,
              list: 2,
              redispatch: 0,
              remove: 0,
              stop: 0,
            }
          );
          assert.strictEqual(reconciled.finalAbsenceConfirmed, true);
        })
    );
  });

  it.skipIf(!runLiveDockerSandboxProof)(
    "executes the pinned claim in a live sandbox and proves final absence",
    async () => {
      const evidence = await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const repositoryRoot = path.resolve(process.cwd(), "../..");
          const runId = "run-Gaia145L01";
          const runRoot = parseRuntimePath(
            path.join(repositoryRoot, ".gaia", "runs", runId)
          );
          const workspace = parseRuntimePath(path.join(runRoot, "workspace"));
          const claimRoot = parseRuntimePath(
            path.join(runRoot, "verification", "claims", "smoke-command")
          );
          const stdoutPath = parseRuntimePath(
            path.join(claimRoot, "stdout.txt")
          );
          const stderrPath = parseRuntimePath(
            path.join(claimRoot, "stderr.txt")
          );
          yield* fs.makeDirectory(workspace, { recursive: true });
          yield* fs.makeDirectory(claimRoot, { recursive: true });
          const profile = yield* readVerificationExecutionProfile(
            parseRuntimePath(
              path.join(repositoryRoot, "profiles", "claim-verification.json")
            )
          );
          const cli = makeDockerSandboxCli(
            nodeDockerSandboxCliRunner,
            "/opt/homebrew/bin/sbx"
          );
          const receipt = yield* Effect.scoped(
            executeDockerSandboxVerification(
              {
                authorityDigest: "a".repeat(64),
                claimId: `proof-claim:sha256:${"b".repeat(64)}`,
                contractDigest: "c".repeat(64),
                contractId: `run-contract:${runId}:v2`,
                executionEvidenceIdentityDigest: "d".repeat(64),
                generationSequence: 1,
                onSandboxCreated: () => Effect.void,
                request: {
                  argv: ["%s", "gaia-claim-ok\n"],
                  credentials: "none",
                  executableId: "posix-printf-v1",
                  expectedExitCode: 0,
                  expectedStdoutByteLength: 14,
                  expectedStdoutSha256:
                    "c67d2c0ac3e5ea53ed76dadc9aab773e884efedcaac2be11aaa4b096576f5849",
                  network: "denied",
                  outputLimitBytes: 1_048_576,
                  timeoutMs: 30_000,
                  workingDirectory: ".",
                  workspaceAccess: "read-write",
                },
                runId,
                sandboxName: "gaia-run-Gaia145L01-smoke-command",
                stderrArtifactPath:
                  "verification/claims/smoke-command/stderr.txt",
                stderrPath,
                stdoutArtifactPath:
                  "verification/claims/smoke-command/stdout.txt",
                stdoutPath,
                targetDigest: "e".repeat(64),
                workspace,
              },
              cli,
              profile
            )
          );
          const finalList = yield* cli.list;
          assert.strictEqual(receipt.status, "succeeded");
          assert.strictEqual(receipt.cleanup.finalAbsenceConfirmed, true);
          assert.strictEqual(receipt.stdout.observedByteCount, 14);
          assert.strictEqual(receipt.stdout.truncated, false);
          assert.strictEqual(
            yield* fs.readFileString(stdoutPath),
            "gaia-claim-ok\n"
          );
          assert.deepEqual(JSON.parse(finalList.stdout), { sandboxes: [] });
          return {
            cleanup: receipt.cleanup,
            sandboxUuid: receipt.sandboxUuid,
            status: receipt.status,
            stdout: receipt.stdout,
          };
        }).pipe(Effect.provide(NodeServices.layer))
      );
      console.log(JSON.stringify(evidence));
    },
    60_000
  );
});
