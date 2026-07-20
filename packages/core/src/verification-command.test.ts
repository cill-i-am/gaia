import { assert, describe, it } from "@effect/vitest";

import { parseRunId } from "./run-id.js";
import {
  makeVerificationCommandReceiptDigest,
  makeVerificationCommandRequestDigest,
  parseVerificationCommandReceipt,
} from "./verification-command.js";

const sha = "1".repeat(64);

describe("VerificationCommandReceipt", () => {
  it("keeps missingExecutable and spawnFailed distinct without a command exitCode", () => {
    const common = {
      argumentCount: 2,
      authorityDigest: sha,
      cleanup: {
        finalAbsenceConfirmed: true,
        removedSandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
        stoppedSandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
      },
      claimId: `proof-claim:sha256:${sha}`,
      commandIdentityDigest: sha,
      commandStartSequence: 5,
      contractDigest: sha,
      contractId: "run-contract:run-Gaia145V2x:v2",
      credentialProfileDigest: sha,
      durationMs: 12,
      environmentDigest: sha,
      executableId: "posix-printf-v1",
      executionEvidenceIdentityDigest: sha,
      executionProfileDigest: sha,
      generationSequence: 2,
      imageDigest: `sha256:${sha}`,
      network: "denied" as const,
      policyDigest: sha,
      providerBuild: sha.slice(0, 40),
      providerId: "docker-sandboxes-sbx",
      providerVersion: "0.35.0",
      receiptDigest: sha,
      requestDigest: makeVerificationCommandRequestDigest({
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
      }),
      runId: parseRunId("run-Gaia145V2x"),
      sandboxName: "gaia-run-Gaia145V2x-smoke-command-2",
      sandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
      stderr: {
        artifactPath: "verification/claims/smoke-command/stderr.bin",
        contentDigest: sha,
        observedByteCount: 0,
        retainedByteCount: 0,
        truncated: false,
      },
      stdout: {
        artifactPath: "verification/claims/smoke-command/stdout.bin",
        contentDigest: sha,
        observedByteCount: 0,
        retainedByteCount: 0,
        truncated: false,
      },
      targetDigest: sha,
      templateReference: `docker/sandbox-templates:shell-docker@sha256:${sha}`,
      terminalSequence: 6,
      workspace: ".",
    };
    const missingPayload = {
      ...common,
      observedProviderExitCode: 127,
      status: "missingExecutable",
    } as const;
    const missing = parseVerificationCommandReceipt({
      ...missingPayload,
      receiptDigest: makeVerificationCommandReceiptDigest(missingPayload),
    });
    const spawnPayload = {
      ...common,
      observedProviderExitCode: 126,
      spawnStage: "commandStart",
      status: "spawnFailed",
    } as const;
    const spawn = parseVerificationCommandReceipt({
      ...spawnPayload,
      receiptDigest: makeVerificationCommandReceiptDigest(spawnPayload),
    });
    const interruptedPayload = { ...common, status: "interrupted" } as const;
    const interrupted = parseVerificationCommandReceipt({
      ...interruptedPayload,
      receiptDigest: makeVerificationCommandReceiptDigest(interruptedPayload),
    });
    const timedOutPayload = { ...common, status: "timedOut" } as const;
    const timedOut = parseVerificationCommandReceipt({
      ...timedOutPayload,
      receiptDigest: makeVerificationCommandReceiptDigest(timedOutPayload),
    });
    const outputLimitPayload = {
      ...common,
      status: "outputLimitExceeded",
    } as const;
    const outputLimit = parseVerificationCommandReceipt({
      ...outputLimitPayload,
      receiptDigest: makeVerificationCommandReceiptDigest(outputLimitPayload),
    });

    assert.strictEqual(missing.status, "missingExecutable");
    assert.strictEqual(spawn.status, "spawnFailed");
    assert.strictEqual("exitCode" in missing, false);
    assert.strictEqual("exitCode" in spawn, false);
    assert.strictEqual(interrupted.status, "interrupted");
    assert.strictEqual(timedOut.status, "timedOut");
    assert.strictEqual(outputLimit.status, "outputLimitExceeded");
    assert.throws(() =>
      parseVerificationCommandReceipt({
        ...missing,
        observedProviderExitCode: 126,
      })
    );
  });
});
