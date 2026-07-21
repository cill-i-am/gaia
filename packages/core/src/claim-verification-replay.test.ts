import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import { makeRunEvent } from "./events.js";
import { replayRunEvents } from "./machine.js";
import {
  encodeAnyRunContractJson,
  makeRunContractV2,
} from "./run-contract-v2.js";
import { parseRunId } from "./run-id.js";
import { parseMarkdownSpec } from "./spec.js";
import { makeVerificationReconciliationReceiptDigest } from "./verification-command.js";

const sha = "1".repeat(64);
const sandboxUuid = "123e4567-e89b-12d3-a456-426614174000";

describe("claim-verification replay", () => {
  it("retains createdWithoutCommandStart as a legal non-terminal prefix", () => {
    const { claim, contract, runId } = fixture();
    const executionEvidenceIdentityDigest = "3".repeat(64);
    const sandboxName = "gaia-run-Gaia145V2z-smoke-command-5";
    const events = prefix(contract, runId);
    events.push(
      makeRunEvent({
        payload: {
          generation: {
            actionId: "action-1",
            actionRequestDigest: sha,
            claimIds: [claim.claimId],
            contentAuthoritySequence: 4,
            contractDigest: contract.contractDigest,
            executionEvidenceIdentityDigest,
            runId,
          },
        },
        runId,
        sequence: 5,
        timestamp: "2026-07-20T20:00:04.000Z",
        type: "CLAIM_VERIFICATION_GENERATION_STARTED",
      }),
      makeRunEvent({
        payload: {
          createIntent: {
            claimId: claim.claimId,
            contractDigest: contract.contractDigest,
            executionEvidenceIdentityDigest,
            generationSequence: 5,
            runId,
            sandboxName,
          },
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-20T20:00:05.000Z",
        type: "CLAIM_VERIFICATION_CREATE_INTENT_RECORDED",
      }),
      makeRunEvent({
        payload: {
          sandboxCreated: {
            claimId: claim.claimId,
            contractDigest: contract.contractDigest,
            createIntentSequence: 6,
            executionEvidenceIdentityDigest,
            generationSequence: 5,
            runId,
            sandboxName,
            sandboxUuid,
          },
        },
        runId,
        sequence: 7,
        timestamp: "2026-07-20T20:00:06.000Z",
        type: "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED",
      })
    );

    assert.strictEqual(replayRunEvents(events).value, "verifying");
  });

  it("rejects a command start without the exact created prefix", () => {
    const { claim, contract, runId } = fixture();
    const events = prefix(contract, runId);
    events.push(
      makeRunEvent({
        payload: {
          generation: {
            actionId: "action-2",
            actionRequestDigest: sha,
            claimIds: [claim.claimId],
            contentAuthoritySequence: 4,
            contractDigest: contract.contractDigest,
            executionEvidenceIdentityDigest: "3".repeat(64),
            runId,
          },
        },
        runId,
        sequence: 5,
        timestamp: "2026-07-20T20:00:04.000Z",
        type: "CLAIM_VERIFICATION_GENERATION_STARTED",
      }),
      makeRunEvent({
        payload: {
          commandStart: {
            claimId: claim.claimId,
            contractDigest: contract.contractDigest,
            executionEvidenceIdentityDigest: "3".repeat(64),
            generationSequence: 5,
            requestDigest: sha,
            runId,
            sandboxCreatedSequence: 6,
            sandboxName: "gaia-run-Gaia145V2z-smoke-command-5",
            sandboxUuid,
          },
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-20T20:00:05.000Z",
        type: "CLAIM_VERIFICATION_COMMAND_START_RECORDED",
      })
    );

    assert.throws(() => replayRunEvents(events), /created prefix/u);
  });

  it("binds reconciliation to the exact prior name, UUID, and sequence and makes it terminal", () => {
    const { claim, contract, runId } = fixture();
    const executionEvidenceIdentityDigest = "3".repeat(64);
    const sandboxName = "gaia-run-Gaia145V2z-smoke-command-5";
    const events = prefix(contract, runId);
    events.push(
      makeRunEvent({
        payload: {
          generation: {
            actionId: "action-reconcile",
            actionRequestDigest: sha,
            claimIds: [claim.claimId],
            contentAuthoritySequence: 4,
            contractDigest: contract.contractDigest,
            executionEvidenceIdentityDigest,
            runId,
          },
        },
        runId,
        sequence: 5,
        timestamp: "2026-07-20T20:00:04.000Z",
        type: "CLAIM_VERIFICATION_GENERATION_STARTED",
      }),
      makeRunEvent({
        payload: {
          createIntent: {
            claimId: claim.claimId,
            contractDigest: contract.contractDigest,
            executionEvidenceIdentityDigest,
            generationSequence: 5,
            runId,
            sandboxName,
          },
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-20T20:00:05.000Z",
        type: "CLAIM_VERIFICATION_CREATE_INTENT_RECORDED",
      }),
      makeRunEvent({
        payload: {
          sandboxCreated: {
            claimId: claim.claimId,
            contractDigest: contract.contractDigest,
            createIntentSequence: 6,
            executionEvidenceIdentityDigest,
            generationSequence: 5,
            runId,
            sandboxName,
            sandboxUuid,
          },
        },
        runId,
        sequence: 7,
        timestamp: "2026-07-20T20:00:06.000Z",
        type: "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED",
      })
    );
    const reconciliationBase = {
      actionId: "reconcile-action",
      claimId: claim.claimId,
      contractDigest: contract.contractDigest,
      executionEvidenceIdentityDigest,
      finalAbsenceConfirmed: true as const,
      generationSequence: 5,
      operationCounts: {
        create: 0 as const,
        exec: 0 as const,
        list: 2,
        redispatch: 0 as const,
        remove: 1 as const,
        stop: 1 as const,
      },
      priorSequence: 7,
      reason: "createdWithoutCommandStart" as const,
      runId,
      sandboxName,
      sandboxUuid,
    };
    const reconciliation = {
      ...reconciliationBase,
      receiptDigest:
        makeVerificationReconciliationReceiptDigest(reconciliationBase),
    };
    const reconciled = [
      ...events,
      makeRunEvent({
        payload: { reconciliation },
        runId,
        sequence: 8,
        timestamp: "2026-07-20T20:00:07.000Z",
        type: "CLAIM_VERIFICATION_RECONCILIATION_RECORDED",
      }),
    ];

    replayRunEvents(reconciled);
    assert.throws(() =>
      replayRunEvents([
        ...reconciled,
        makeRunEvent({
          payload: {
            commandStart: {
              claimId: claim.claimId,
              contractDigest: contract.contractDigest,
              executionEvidenceIdentityDigest,
              generationSequence: 5,
              requestDigest: sha,
              runId,
              sandboxCreatedSequence: 7,
              sandboxName,
              sandboxUuid,
            },
          },
          runId,
          sequence: 9,
          timestamp: "2026-07-20T20:00:08.000Z",
          type: "CLAIM_VERIFICATION_COMMAND_START_RECORDED",
        }),
      ])
    );
    for (const changed of [
      { ...reconciliationBase, priorSequence: 6 },
      {
        ...reconciliationBase,
        sandboxUuid: "223e4567-e89b-42d3-a456-426614174000",
      },
    ]) {
      assert.throws(() =>
        replayRunEvents([
          ...events,
          makeRunEvent({
            payload: {
              reconciliation: {
                ...changed,
                receiptDigest:
                  makeVerificationReconciliationReceiptDigest(changed),
              },
            },
            runId,
            sequence: 8,
            timestamp: "2026-07-20T20:00:07.000Z",
            type: "CLAIM_VERIFICATION_RECONCILIATION_RECORDED",
          }),
        ])
      );
    }
  });
});

function fixture() {
  const runId = parseRunId("run-Gaia145V2z");
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
    baseDigest: sha,
    baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
    runId,
    spec,
    targetDigest: "2".repeat(64),
    targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
  });
  const claim = contract.proofClaims.find((entry) => entry.kind === "command");
  assert.ok(claim);
  return { claim, contract, runId };
}

function prefix(
  contract: ReturnType<typeof makeRunContractV2>,
  runId: ReturnType<typeof parseRunId>
) {
  return [
    makeRunEvent({
      payload: { specPath: "input.md" },
      runId,
      sequence: 1,
      timestamp: "2026-07-20T20:00:00.000Z",
      type: "RUN_CREATED",
    }),
    makeRunEvent({
      payload: { contract: encodeAnyRunContractJson(contract) },
      runId,
      sequence: 2,
      timestamp: "2026-07-20T20:00:01.000Z",
      type: "RUN_CONTRACT_RECORDED",
    }),
    makeRunEvent({
      payload: { workspacePath: "workspace" },
      runId,
      sequence: 3,
      timestamp: "2026-07-20T20:00:02.000Z",
      type: "WORKSPACE_PREPARED",
    }),
    makeRunEvent({
      payload: { workerResultPath: "worker-result.json" },
      runId,
      sequence: 4,
      timestamp: "2026-07-20T20:00:03.000Z",
      type: "WORKER_COMPLETED",
    }),
  ];
}
