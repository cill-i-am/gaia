import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { VerificationCommandRequestV1 } from "@gaia/core";
import { Deferred, Effect, Fiber, FileSystem, Path, Schema } from "effect";

import {
  makeDockerSandboxCli,
  nodeDockerSandboxCliRunner,
} from "./docker-sandbox-cli.js";
import {
  classifyDockerSandboxExecOutcome,
  executeDockerSandboxVerification,
  parseDockerSandboxInspectAuthorityJson,
  parseDockerSandboxInspectAuthoritySummary,
  reconcileDockerSandboxVerification,
  type StagedDockerSandboxVerificationReceipt,
} from "./docker-sandbox-verification-executor.js";
import { parseRuntimePath } from "./paths.js";
import {
  parseVerificationExecutionProfile,
  readVerificationExecutionProfile,
} from "./verification-execution-profile.js";
import { observeVerificationWorkspaceStructuralDigest } from "./workspace-snapshot.js";

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

  it("requires every normalized containment authority field explicitly", () => {
    const summary = [
      "Name: gaia-sandbox-1",
      "Agent: shell",
      "Kits: none",
      "State: running (1s)",
      "Image: pinned@example",
      "Image digest: sha256:expected",
      "Auth mode: not configured",
      "Workspace: /tmp/workspace",
      "Network Policy: global (local policy)",
      "Mount Policy: allowed",
      "Proxy: 172.17.0.0:3128",
      "Secrets: none",
      "Ports: none published",
      "Sessions: 0",
      "Daemon: v0.35.0 uptime 1m",
    ].join("\n");
    assert.strictEqual(
      parseDockerSandboxInspectAuthoritySummary(summary).authMode,
      "not configured"
    );
    for (const forbidden of [
      ["Auth mode: not configured", "Auth mode: oauth"],
      ["Kits: none", "Kits: credential-kit"],
      ["Mount Policy: allowed", "Mount Policy: read-only"],
      ["Ports: none published", "Ports: 3000:3000"],
      ["Secrets: none", "Secrets: github"],
      ["Sessions: 0", "Sessions: 1"],
    ] as const) {
      assert.throws(() =>
        parseDockerSandboxInspectAuthoritySummary(
          summary.replace(forbidden[0], forbidden[1])
        )
      );
    }
    for (const omitted of [
      "Auth mode",
      "Kits",
      "Mount Policy",
      "Ports",
      "Secrets",
      "Sessions",
    ]) {
      assert.throws(() =>
        parseDockerSandboxInspectAuthoritySummary(
          summary
            .split("\n")
            .filter((line) => !line.startsWith(`${omitted}:`))
            .join("\n")
        )
      );
    }
    assert.throws(() =>
      parseDockerSandboxInspectAuthoritySummary(`${summary}\nToken: present`)
    );
  });

  it("rejects omitted and positive forbidden JSON containment authority", () => {
    const authority = {
      agent: "shell",
      daemon_uptime: "12h 11m",
      daemon_version: "v0.35.0",
      image: "pinned@example",
      image_digest: "sha256:expected",
      kits: [],
      mcp_gateway: false,
      name: "gaia-sandbox-1",
      network: "gaia-sandbox-1",
      network_policy: { scope: "global" },
      proxy: "172.17.0.0:3128",
      sessions: 0,
      state: "running",
      uptime: "9s",
      workspace: "/tmp/workspace",
    };
    assert.strictEqual(
      parseDockerSandboxInspectAuthorityJson(JSON.stringify(authority)).name,
      "gaia-sandbox-1"
    );
    for (const omitted of Object.keys(authority)) {
      const candidate = { ...authority };
      Reflect.deleteProperty(candidate, omitted);
      assert.throws(() =>
        parseDockerSandboxInspectAuthorityJson(JSON.stringify(candidate))
      );
    }
    for (const forbidden of [
      { ...authority, agent: "claude" },
      { ...authority, kits: ["credential-kit"] },
      { ...authority, mcp_gateway: true },
      { ...authority, network_policy: { scope: "project" } },
      { ...authority, sessions: 1 },
      { ...authority, state: "paused" },
    ]) {
      assert.throws(() =>
        parseDockerSandboxInspectAuthorityJson(JSON.stringify(forbidden))
      );
    }
    for (const [field, value] of [
      ["auth", { mode: "oauth" }],
      ["secrets", ["github"]],
      ["published_ports", ["3000:3000"]],
      ["credential_proxy", true],
      ["docker_socket", "/var/run/docker.sock"],
      ["environment", { GITHUB_TOKEN: "present" }],
    ] as const) {
      assert.throws(() =>
        parseDockerSandboxInspectAuthorityJson(
          JSON.stringify({ ...authority, [field]: value })
        )
      );
    }
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
          let sandbox:
            | {
                id: string;
                name: string;
                status: string;
                workspaces: ReadonlyArray<string>;
              }
            | undefined;
          let execCount = 0;
          let stopCount = 0;
          let rejectStop = false;
          let delayedStage:
            | "execute"
            | "observation"
            | "remove"
            | "stop"
            | undefined;
          let enteredStage: typeof delayedStage;
          let stageEntryLatch: Deferred.Deferred<void> | undefined;
          const signalStageEntry = (
            stage: Exclude<typeof delayedStage, undefined>
          ) => {
            enteredStage = stage;
            const latch = stageEntryLatch;
            if (latch === undefined) return false;
            Deferred.doneUnsafe(latch, Effect.void);
            return true;
          };
          const suspendAtStage = (
            stage: Exclude<typeof delayedStage, undefined>
          ) =>
            Effect.callback<never>((resume) => {
              if (!signalStageEntry(stage))
                resume(Effect.die(`Missing stage-entry latch for ${stage}.`));
              return Effect.void;
            });
          const delayAtStage = (
            stage: Exclude<typeof delayedStage, undefined>,
            delayMilliseconds: number
          ) =>
            Effect.callback<void>((resume) => {
              if (!signalStageEntry(stage)) {
                resume(Effect.die(`Missing stage-entry latch for ${stage}.`));
                return Effect.void;
              }
              const timer = setTimeout(
                () => resume(Effect.void),
                delayMilliseconds
              );
              return Effect.sync(() => clearTimeout(timer));
            });
          let identityDrift: "rebound" | "rename" | undefined;
          let surviveRemovalAs: "rebound" | "rename" | undefined;
          let postCreateListCount = 0;
          let inspectedImageDigest =
            "sha256:39cf20eca861ec92747487af6197f6d916f774bdb98245d267dbd8dfd3debb05";
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
            if (verb === "ls") {
              const observedSandbox = sandbox;
              const shouldDrift =
                observedSandbox !== undefined &&
                identityDrift !== undefined &&
                (postCreateListCount += 1) === 2;
              const listedSandbox = shouldDrift
                ? {
                    ...observedSandbox,
                    ...(identityDrift === "rebound"
                      ? { id: "123e4567-e89b-12d3-a456-426614174999" }
                      : { name: "gaia-sandbox-renamed" }),
                  }
                : observedSandbox;
              if (shouldDrift) identityDrift = undefined;
              return Effect.succeed({
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({
                  sandboxes: listedSandbox === undefined ? [] : [listedSandbox],
                }),
              });
            }
            if (verb === "create") {
              postCreateListCount = 0;
              sandbox = {
                id: uuid,
                name: "gaia-sandbox-1",
                status: "running",
                workspaces: [workspace],
              };
              return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
            }
            if (verb === "inspect")
              return Effect.succeed({
                exitCode: 0,
                stderr: "",
                stdout: command.args.includes("--json")
                  ? JSON.stringify({
                      agent: "shell",
                      daemon_uptime: "1m",
                      daemon_version: "v0.35.0",
                      image:
                        "docker/sandbox-templates:shell-docker@sha256:39cf20eca861ec92747487af6197f6d916f774bdb98245d267dbd8dfd3debb05",
                      image_digest: inspectedImageDigest,
                      kits: [],
                      mcp_gateway: false,
                      name: "gaia-sandbox-1",
                      network: "gaia-sandbox-1",
                      network_policy: { scope: "global" },
                      proxy: "172.17.0.0:3128",
                      sessions: 0,
                      state: sandbox?.status,
                      uptime: "1s",
                      workspace,
                    })
                  : [
                      "Name: gaia-sandbox-1",
                      "Agent: shell",
                      "Kits: none",
                      `State: ${sandbox?.status} (1s)`,
                      `Image: ${profile.templateReference}`,
                      `Image digest: ${inspectedImageDigest}`,
                      "Auth mode: not configured",
                      `Workspace: ${workspace}`,
                      "Network Policy: global (local policy)",
                      "Mount Policy: allowed",
                      "Proxy: 172.17.0.0:3128",
                      "Secrets: none",
                      "Ports: none published",
                      "Sessions: 0",
                      `Daemon: v${profile.provider.version} uptime 1m`,
                    ].join("\n"),
              });
            if (verb === "exec") {
              execCount += 1;
              if (delayedStage === "execute") return suspendAtStage("execute");
              return Effect.succeed({
                exitCode: 0,
                stderr: "",
                stdout: "gaia-claim-ok\n",
              });
            }
            if (verb === "stop") {
              stopCount += 1;
              if (rejectStop)
                return Effect.succeed({
                  exitCode: 1,
                  stderr: "stop rejected",
                  stdout: "",
                });
              return (
                delayedStage === "stop" ? delayAtStage("stop", 20) : Effect.void
              ).pipe(
                Effect.map(() => {
                  sandbox = {
                    id: uuid,
                    name: "gaia-sandbox-1",
                    status: "stopped",
                    workspaces: [workspace],
                  };
                  return { exitCode: 0, stderr: "", stdout: "" };
                })
              );
            }
            if (verb === "rm") {
              return (
                delayedStage === "remove"
                  ? delayAtStage("remove", 20)
                  : Effect.void
              ).pipe(
                Effect.map(() => {
                  sandbox =
                    surviveRemovalAs === undefined
                      ? undefined
                      : {
                          id:
                            surviveRemovalAs === "rebound"
                              ? "123e4567-e89b-12d3-a456-426614174999"
                              : uuid,
                          name:
                            surviveRemovalAs === "rename"
                              ? "gaia-sandbox-renamed"
                              : "gaia-sandbox-1",
                          status: "stopped",
                          workspaces: [workspace],
                        };
                  return { exitCode: 0, stderr: "", stdout: "" };
                })
              );
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
                onInterrupted: () => Effect.void,
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
                onInterrupted: () => Effect.void,
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
          inspectedImageDigest = `sha256:${"0".repeat(64)}`;
          const drifted = yield* Effect.scoped(
            executeDockerSandboxVerification(
              {
                authorityDigest: "1".repeat(64),
                claimId: `proof-claim:sha256:${"2".repeat(64)}`,
                contractDigest: "3".repeat(64),
                contractId: "run-contract:run-Gaia145V2x:v2",
                executionEvidenceIdentityDigest: "4".repeat(64),
                generationSequence: 7,
                onInterrupted: () => Effect.void,
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
            ).pipe(Effect.exit)
          );
          assert.strictEqual(drifted._tag, "Failure");
          assert.include(
            JSON.stringify(drifted),
            "VerificationProviderFailure"
          );
          assert.strictEqual(execCount, 2);
          assert.strictEqual(sandbox, undefined);
          inspectedImageDigest = profile.imageDigest;
          for (const drift of ["rebound", "rename"] as const) {
            identityDrift = drift;
            const identityDrifted = yield* Effect.scoped(
              executeDockerSandboxVerification(
                {
                  authorityDigest: "1".repeat(64),
                  claimId: `proof-claim:sha256:${"2".repeat(64)}`,
                  contractDigest: "3".repeat(64),
                  contractId: "run-contract:run-Gaia145V2x:v2",
                  executionEvidenceIdentityDigest: "4".repeat(64),
                  generationSequence: 8,
                  onInterrupted: () => Effect.void,
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
              ).pipe(Effect.exit)
            );
            assert.strictEqual(identityDrifted._tag, "Failure");
            assert.include(
              JSON.stringify(identityDrifted),
              "VerificationProviderFailure"
            );
            assert.strictEqual(execCount, 2);
            assert.strictEqual(sandbox, undefined);
          }
          const reconciled = yield* reconcileDockerSandboxVerification(
            {
              actionId: "reconcile-gaia-145",
              claimId: `proof-claim:sha256:${"2".repeat(64)}`,
              contractDigest: "3".repeat(64),
              executionEvidenceIdentityDigest: "4".repeat(64),
              generationSequence: 6,
              priorSequence: 7,
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
          for (const survivingIdentity of ["rebound", "rename"] as const) {
            surviveRemovalAs = survivingIdentity;
            const absenceUnknown = yield* Effect.scoped(
              executeDockerSandboxVerification(
                {
                  authorityDigest: "1".repeat(64),
                  claimId: `proof-claim:sha256:${"2".repeat(64)}`,
                  contractDigest: "3".repeat(64),
                  contractId: "run-contract:run-Gaia145V2x:v2",
                  executionEvidenceIdentityDigest: "4".repeat(64),
                  generationSequence: 8,
                  onInterrupted: () => Effect.void,
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
              ).pipe(Effect.exit)
            );
            assert.strictEqual(absenceUnknown._tag, "Failure");
            assert.include(
              JSON.stringify(absenceUnknown),
              "VerificationCommandOutcomeUnknown"
            );
            sandbox = undefined;
            surviveRemovalAs = undefined;
          }
          inspectedImageDigest = profile.imageDigest;
          const observeWorkspace = (observedWorkspace: string) =>
            (delayedStage === "observation"
              ? delayAtStage("observation", 20)
              : Effect.void
            ).pipe(
              Effect.andThen(
                observeVerificationWorkspaceStructuralDigest(observedWorkspace)
              )
            );

          for (const stage of [
            "execute",
            "stop",
            "observation",
            "remove",
          ] as const) {
            const interruptedReceipts: Array<StagedDockerSandboxVerificationReceipt> =
              [];
            delayedStage = stage;
            enteredStage = undefined;
            const stageEntered = yield* Deferred.make<void>();
            stageEntryLatch = stageEntered;
            const interruptedFiber = yield* Effect.scoped(
              executeDockerSandboxVerification(
                {
                  authorityDigest: "1".repeat(64),
                  claimId: `proof-claim:sha256:${"2".repeat(64)}`,
                  contractDigest: "3".repeat(64),
                  contractId: "run-contract:run-Gaia145V2x:v2",
                  executionEvidenceIdentityDigest: "4".repeat(64),
                  generationSequence: 9,
                  onInterrupted: (receipt) =>
                    Effect.sync(() => {
                      interruptedReceipts.push(receipt);
                    }),
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
                profile,
                { observeWorkspace }
              )
            ).pipe(Effect.forkChild);
            const barrier = yield* Effect.race(
              Deferred.await(stageEntered).pipe(
                Effect.as({ _tag: "StageEntered" } as const)
              ),
              Fiber.await(interruptedFiber).pipe(
                Effect.map((exit) => ({ _tag: "Exited", exit }) as const)
              )
            );
            if (barrier._tag === "Exited")
              return assert.fail(
                `Executor exited before entering ${stage}: ${barrier.exit._tag}`
              );
            assert.strictEqual(enteredStage, stage);
            yield* Fiber.interrupt(interruptedFiber);
            const interrupted = yield* Fiber.await(interruptedFiber);
            assert.strictEqual(interrupted._tag, "Failure");
            assert.strictEqual(interruptedReceipts.length, 1);
            const interruptedReceipt = interruptedReceipts[0];
            if (interruptedReceipt === undefined)
              return yield* Effect.die(
                "interruption did not publish its typed terminal receipt"
              );
            assert.strictEqual(interruptedReceipt.status, "interrupted");
            assert.strictEqual(
              interruptedReceipt.cleanup.finalAbsenceConfirmed,
              true
            );
            assert.strictEqual(sandbox, undefined);
          }
          delayedStage = undefined;
          stageEntryLatch = undefined;
          rejectStop = true;
          const stopsBeforeFailure = stopCount;
          const cleanupFailure = yield* Effect.scoped(
            executeDockerSandboxVerification(
              {
                authorityDigest: "1".repeat(64),
                claimId: `proof-claim:sha256:${"2".repeat(64)}`,
                contractDigest: "3".repeat(64),
                contractId: "run-contract:run-Gaia145V2x:v2",
                executionEvidenceIdentityDigest: "4".repeat(64),
                generationSequence: 8,
                onInterrupted: () => Effect.void,
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
            ).pipe(Effect.exit)
          );
          assert.strictEqual(cleanupFailure._tag, "Failure");
          assert.include(
            JSON.stringify(cleanupFailure),
            "VerificationCommandOutcomeUnknown"
          );
          assert.strictEqual(stopCount, stopsBeforeFailure + 1);
          assert.strictEqual(sandbox?.status, "running");
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
                onInterrupted: () => Effect.void,
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
