import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  makeRunContractV2,
  makeRunProofResultV2,
  isRunProofPhaseSatisfiedV2,
  makeProofEvidenceIdV2,
  parseRunContractV2,
  parseRunProofResultV2,
  ProofClaimResultV2Schema,
} from "./run-contract-v2.js";
import { parseRunId } from "./run-id.js";
import { parseMarkdownSpec } from "./spec.js";
import { makeVerificationCommandRequestDigest } from "./verification-command.js";

describe("RunContractV2", () => {
  it("derives exact source-owned mappings and command requests", () => {
    const spec = parseMarkdownSpec(
      readFileSync(
        new URL(
          "../../../examples/specs/claim-verification-v2.md",
          import.meta.url
        ),
        "utf8"
      ),
      "fallback"
    );
    const contract = makeRunContractV2({
      baseDigest: "1".repeat(64),
      baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
      runId: parseRunId("run-Gaia145V2x"),
      spec,
      targetDigest: "2".repeat(64),
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });
    const firstClaim = contract.proofClaims[0];
    assert.ok(firstClaim);

    assert.strictEqual(contract.version, 2);
    assert.strictEqual(firstClaim.kind, "command");
    assert.deepEqual(
      contract.acceptedOutcomes[0]?.prePublicationRequiredClaimIds,
      [firstClaim.claimId]
    );
    assert.strictEqual(
      firstClaim.kind === "command"
        ? firstClaim.command.executableId
        : undefined,
      "posix-printf-v1"
    );
    assert.deepEqual(parseRunContractV2(contract), contract);
  });

  it("cannot verify when the exact command claim failed", () => {
    const spec = parseMarkdownSpec(
      readFileSync(
        new URL(
          "../../../examples/specs/claim-verification-v2.md",
          import.meta.url
        ),
        "utf8"
      ),
      "fallback"
    );
    const contract = makeRunContractV2({
      baseDigest: "1".repeat(64),
      baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
      runId: parseRunId("run-Gaia145V2y"),
      spec,
      targetDigest: "2".repeat(64),
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });
    const results = contract.proofClaims.map((claim) =>
      claim.kind === "command"
        ? {
            claimId: claim.claimId,
            evidence: [],
            reason: "The exact command returned a non-zero status.",
            status: "failed" as const,
          }
        : claim.kind === "human-judgment"
          ? {
              claimId: claim.claimId,
              reason: "An explicit paired-review decision is required.",
              requiredAuthority: "human" as const,
              status: "requires-decision" as const,
            }
          : {
              claimId: claim.claimId,
              reason: "Post-publication evidence is not available yet.",
              status: "not-run" as const,
            }
    );
    const result = makeRunProofResultV2({
      contentAuthoritySequence: 7,
      contract,
      observedTargetDigest: contract.targetDigest,
      recordedBy: {
        runId: contract.runId,
        sequence: 8,
        type: "RUN_PROOF_RESULT_RECORDED",
      },
      results: Schema.decodeUnknownSync(Schema.Array(ProofClaimResultV2Schema))(
        results
      ),
    });

    assert.strictEqual(result.aggregate, "verification-failed");
    assert.deepEqual(parseRunProofResultV2(result, contract), result);
  });

  it("opens only the pre-publication gate from an exact command receipt", () => {
    const spec = parseMarkdownSpec(
      readFileSync(
        new URL(
          "../../../examples/specs/claim-verification-v2.md",
          import.meta.url
        ),
        "utf8"
      ),
      "fallback"
    );
    const contract = makeRunContractV2({
      baseDigest: "1".repeat(64),
      baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
      runId: parseRunId("run-Gaia145V2z"),
      spec,
      targetDigest: "2".repeat(64),
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });
    const results = contract.proofClaims.map((claim) =>
      claim.kind === "command"
        ? {
            claimId: claim.claimId,
            evidence: [
              {
                evidenceId: makeProofEvidenceIdV2("command", ["4".repeat(64)]),
                kind: "command" as const,
                receiptDigest: "4".repeat(64),
                requestDigest: makeVerificationCommandRequestDigest(
                  claim.command
                ),
                status: "succeeded" as const,
                terminalSequence: 8,
              },
            ],
            status: "passed" as const,
          }
        : claim.kind === "human-judgment"
          ? {
              claimId: claim.claimId,
              reason: "Post-publication decision is not available yet.",
              requiredAuthority: "human" as const,
              status: "requires-decision" as const,
            }
          : {
              claimId: claim.claimId,
              reason: "Post-publication checks are not available yet.",
              status: "not-run" as const,
            }
    );
    const result = makeRunProofResultV2({
      contentAuthoritySequence: 7,
      contract,
      observedTargetDigest: contract.targetDigest,
      recordedBy: {
        runId: contract.runId,
        sequence: 9,
        type: "RUN_PROOF_RESULT_RECORDED",
      },
      results: Schema.decodeUnknownSync(Schema.Array(ProofClaimResultV2Schema))(
        results
      ),
    });
    assert.strictEqual(
      isRunProofPhaseSatisfiedV2(contract, result, "prePublication"),
      true
    );
    assert.strictEqual(
      isRunProofPhaseSatisfiedV2(contract, result, "postPublication"),
      false
    );
  });

  it("rejects empty V2 obligations, mappings, results, and phase evaluation", () => {
    const contract = makeFixtureContract("run-Gaia145V2e");
    const emptyMappings = {
      ...contract,
      acceptedOutcomes: contract.acceptedOutcomes.map((outcome) => ({
        ...outcome,
        conditionalClaimIds: [],
        postPublicationRequiredClaimIds: [],
        prePublicationRequiredClaimIds: [],
      })),
    };
    const emptyResultInput = {
      contentAuthoritySequence: 7,
      contract,
      observedTargetDigest: contract.targetDigest,
      recordedBy: {
        runId: contract.runId,
        sequence: 9,
        type: "RUN_PROOF_RESULT_RECORDED" as const,
      },
      results: [],
    };
    const validResult = makeRunProofResultV2({
      ...emptyResultInput,
      results: contract.proofClaims.map((claim) => ({
        claimId: claim.claimId,
        reason: "Evidence has not been collected.",
        status: "not-run" as const,
      })),
    });

    assert.throws(
      () => parseRunContractV2({ ...contract, proofClaims: [] }),
      /at least one proof claim/u
    );
    assert.throws(
      () => parseRunContractV2(emptyMappings),
      /mappings|unmapped claim/u
    );
    assert.throws(
      () => makeRunProofResultV2(emptyResultInput),
      /at least one claim result/u
    );
    assert.throws(() =>
      isRunProofPhaseSatisfiedV2(
        contract,
        {
          ...validResult,
          aggregate: "verified",
          results: [],
        },
        "prePublication"
      )
    );
  });

  it("rejects evidence rebound from an exact command or source selector", () => {
    const contract = makeFixtureContract("run-Gaia145V2b");
    const command = contract.proofClaims.find(
      (claim) => claim.kind === "command"
    );
    const external = contract.proofClaims.find(
      (claim) => claim.kind === "external-check"
    );
    const human = contract.proofClaims.find(
      (claim) => claim.kind === "human-judgment"
    );
    assert.ok(command?.kind === "command");
    assert.ok(external?.kind === "external-check");
    assert.ok(human?.kind === "human-judgment");

    const baseResults = contract.proofClaims.map((claim) => ({
      claimId: claim.claimId,
      reason: "Evidence has not been collected.",
      status: "not-run" as const,
    }));
    const makeInput = (results: unknown[]) => ({
      contentAuthoritySequence: 7,
      contract,
      observedTargetDigest: contract.targetDigest,
      recordedBy: {
        runId: contract.runId,
        sequence: 9,
        type: "RUN_PROOF_RESULT_RECORDED" as const,
      },
      results: Schema.decodeUnknownSync(Schema.Array(ProofClaimResultV2Schema))(
        results
      ),
    });
    const withResult = (claimId: string, result: object) =>
      baseResults.map((candidate) =>
        candidate.claimId === claimId ? result : candidate
      );

    assert.throws(() =>
      makeRunProofResultV2(
        makeInput(
          withResult(command.claimId, {
            claimId: command.claimId,
            evidence: [
              {
                evidenceId: `proof-evidence:sha256:${"1".repeat(64)}`,
                kind: "command",
                receiptDigest: "2".repeat(64),
                requestDigest: "3".repeat(64),
                status: "succeeded",
                terminalSequence: 8,
              },
            ],
            status: "passed",
          })
        )
      )
    );
    assert.throws(() =>
      makeRunProofResultV2(
        makeInput(
          withResult(external.claimId, {
            claimId: external.claimId,
            evidence: [
              {
                checkName: external.selector.checkName,
                conclusion: "success",
                evidenceId: `proof-evidence:sha256:${"4".repeat(64)}`,
                eventSequence: 8,
                headSha: "5".repeat(40),
                kind: "external-check",
                provider: "github",
                workflow: "rebound-workflow",
              },
            ],
            status: "passed",
          })
        )
      )
    );
    assert.throws(() =>
      makeRunProofResultV2(
        makeInput(
          withResult(human.claimId, {
            claimId: human.claimId,
            evidence: [
              {
                decision: "rejected",
                evidenceId: `proof-evidence:sha256:${"6".repeat(64)}`,
                eventSequence: 8,
                headSha: "7".repeat(40),
                kind: "human-judgment",
                source: "localOperatorPairedReview",
              },
            ],
            status: "passed",
          })
        )
      )
    );
  });
});

function makeFixtureContract(runId: string) {
  const spec = parseMarkdownSpec(
    readFileSync(
      new URL(
        "../../../examples/specs/claim-verification-v2.md",
        import.meta.url
      ),
      "utf8"
    ),
    "fallback"
  );
  return makeRunContractV2({
    baseDigest: "1".repeat(64),
    baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
    runId: parseRunId(runId),
    spec,
    targetDigest: "2".repeat(64),
    targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
  });
}
