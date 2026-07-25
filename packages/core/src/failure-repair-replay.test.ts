import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { makeRunEvent } from "./events.js";
import {
  encodeFailureRepairReceiptJson,
  FailureRepairDispatchAttempted,
  FailureRepairFailed,
  FailureRepairIntent,
  FailureRepairOutcomeUnknown,
  FailureRepairSuperseded,
  FailureRepairTurnCompleted,
  FailureRepairVerified,
  failureOutcomeUnknownPolicyV1,
  makeFailureDigestV1,
} from "./failure-repair.js";
import { replayRunEvents } from "./machine.js";
import { ModelInvocationObservationV1 } from "./model-invocation.js";
import {
  encodeAnyRunContractJson,
  encodeAnyRunProofResultJson,
  makeProofEvidenceIdV2,
  makeRunContractV2,
  makeRunProofResultV2,
  ProofClaimResultV2Schema,
} from "./run-contract-v2.js";
import { parseRunEventSequence } from "./run-contract.js";
import { parseRunId } from "./run-id.js";
import { parseMarkdownSpec } from "./spec.js";
import { makeVerificationCommandRequestDigest } from "./verification-command.js";

const sha = "1".repeat(64);

describe("failure repair replay", () => {
  it("advances content authority only after a durable terminal repair turn and accepts fresh exact proof", () => {
    const fixture = makeFixture();
    const events = repairPrefix(fixture);
    const freshProof = makeProof(fixture, {
      contentAuthoritySequence: 10,
      passed: true,
      sequence: 11,
    });
    const verified = FailureRepairVerified.make({
      ...fixture.repair,
      proofResultSequence: parseRunEventSequence(11),
      state: "verified",
    });
    events.push(
      proofEvent(fixture.runId, freshProof, 11),
      repairEvent(fixture.runId, verified, 12)
    );

    const snapshot = replayRunEvents(events);

    assert.strictEqual(snapshot.value, "reporting");
    assert.strictEqual(snapshot.context.failureRepair?.state, "verified");
    assert.throws(() =>
      replayRunEvents([
        ...events.slice(0, 10),
        proofEvent(
          fixture.runId,
          makeProof(fixture, {
            contentAuthoritySequence: 4,
            passed: true,
            sequence: 11,
          }),
          11
        ),
      ])
    );
    const wrongSession = [...events];
    wrongSession[8] = makeRunEvent({
      payload: {
        event: {
          kind: "turnCompleted",
          sessionId: "session-run-Wrong149a",
          status: "completed",
          turnId: "failure-repair-turn-1",
        },
      },
      runId: fixture.runId,
      sequence: 9,
      timestamp: timestamp(9),
      type: "HARNESS_SESSION_EVENT_RECORDED",
    });
    assert.throws(() => replayRunEvents(wrongSession));
  });

  it("makes ambiguous repair dispatch sticky and rejects redispatch or verification", () => {
    const fixture = makeFixture();
    const events = initialFailure(fixture);
    const intent = FailureRepairIntent.make({
      ...fixture.repair,
      state: "intentRecorded",
    });
    const attempted = FailureRepairDispatchAttempted.make({
      ...fixture.repair,
      state: "dispatchAttempted",
    });
    const unknown = FailureRepairOutcomeUnknown.make({
      ...fixture.repair,
      code: "RepairDispatchOutcomeUnknown",
      message: "Repair dispatch outcome is unknown.",
      state: "outcomeUnknown",
      terminalPolicy: failureOutcomeUnknownPolicyV1,
    });
    events.push(
      repairEvent(fixture.runId, intent, 6),
      repairEvent(fixture.runId, attempted, 7),
      repairEvent(fixture.runId, unknown, 8)
    );

    assert.strictEqual(replayRunEvents(events).value, "failed");
    assert.throws(() =>
      replayRunEvents([...events, repairEvent(fixture.runId, attempted, 9)])
    );
    assert.throws(() =>
      replayRunEvents([
        ...events,
        proofEvent(
          fixture.runId,
          makeProof(fixture, {
            contentAuthoritySequence: 4,
            passed: true,
            sequence: 9,
          }),
          9
        ),
      ])
    );
  });

  it("rejects schema-valid command evidence that differs from the authoritative failed proof", () => {
    const fixture = makeFixture();
    const original = fixture.failureEvidence[0];
    assert.ok(original);
    const tamperedEvidence = [
      { ...original, evidenceId: makeProofEvidenceIdV2("command", ["7"]) },
      { ...original, receiptDigest: "7".repeat(64) },
      { ...original, requestDigest: "7".repeat(64) },
      { ...original, status: "succeeded" as const },
      {
        ...original,
        terminalSequence: parseRunEventSequence(original.terminalSequence + 1),
      },
    ];

    for (const evidence of tamperedEvidence) {
      const digest = makeFailureDigestV1({
        attempt: 1,
        evidenceRefs: [evidence],
        failedRef: fixture.repair.digest.failedRef,
        maxAttempts: 2,
        outcomeCertainty: "confirmed",
        retryability: "repairable",
        stage: "verifying",
        tag: "verificationClaimFailed",
      });
      const intent = FailureRepairIntent.make({
        ...fixture.repair,
        digest,
        state: "intentRecorded",
      });

      assert.strictEqual(digest.fingerprint, fixture.repair.digest.fingerprint);
      assert.throws(() =>
        replayRunEvents([
          ...initialFailure(fixture),
          repairEvent(fixture.runId, intent, 6),
        ])
      );
    }
  });

  it("rejects a terminal that predates the durable dispatch attempt", () => {
    const fixture = makeFixture();
    const events = initialFailure(fixture);
    const intent = FailureRepairIntent.make({
      ...fixture.repair,
      state: "intentRecorded",
    });
    const attempted = FailureRepairDispatchAttempted.make({
      ...fixture.repair,
      state: "dispatchAttempted",
    });
    const completed = FailureRepairTurnCompleted.make({
      ...fixture.repair,
      state: "turnCompleted",
      terminalEventSequence: parseRunEventSequence(6),
    });
    events.push(
      makeRunEvent({
        payload: {
          event: {
            kind: "turnCompleted",
            sessionId: `session-${fixture.runId}`,
            status: "completed",
            turnId: "pre-dispatch-turn",
          },
        },
        runId: fixture.runId,
        sequence: 6,
        timestamp: timestamp(6),
        type: "HARNESS_SESSION_EVENT_RECORDED",
      }),
      repairEvent(fixture.runId, intent, 7),
      repairEvent(fixture.runId, attempted, 8),
      repairEvent(fixture.runId, completed, 9)
    );

    assert.throws(() => replayRunEvents(events));
  });

  it("rejects a repair turn that started before the durable dispatch attempt", () => {
    const fixture = makeFixture();
    const events = initialFailure(fixture);
    const intent = FailureRepairIntent.make({
      ...fixture.repair,
      state: "intentRecorded",
    });
    const attempted = FailureRepairDispatchAttempted.make({
      ...fixture.repair,
      state: "dispatchAttempted",
    });
    const completed = FailureRepairTurnCompleted.make({
      ...fixture.repair,
      state: "turnCompleted",
      terminalEventSequence: parseRunEventSequence(9),
    });
    events.push(
      repairEvent(fixture.runId, intent, 6),
      makeRunEvent({
        payload: {
          event: {
            kind: "turnStarted",
            sessionId: `session-${fixture.runId}`,
            turnId: "pre-dispatch-turn",
          },
        },
        runId: fixture.runId,
        sequence: 7,
        timestamp: timestamp(7),
        type: "HARNESS_SESSION_EVENT_RECORDED",
      }),
      repairEvent(fixture.runId, attempted, 8),
      makeRunEvent({
        payload: {
          event: {
            kind: "turnCompleted",
            sessionId: `session-${fixture.runId}`,
            status: "completed",
            turnId: "pre-dispatch-turn",
          },
        },
        runId: fixture.runId,
        sequence: 9,
        timestamp: timestamp(9),
        type: "HARNESS_SESSION_EVENT_RECORDED",
      }),
      repairEvent(fixture.runId, completed, 10)
    );

    assert.throws(() => replayRunEvents(events));
  });

  it("rejects repair turn attribution without the exact offered repair episode", () => {
    const fixture = makeFixture();
    for (const observation of [
      undefined,
      Schema.encodeSync(ModelInvocationObservationV1)(
        ModelInvocationObservationV1.make({
          episodeKey: "workerInitial",
          kind: "offered",
          source: "codexAppServerTransport",
          trust: "high",
          version: 1,
        })
      ),
    ]) {
      const events = repairPrefix(fixture);
      events[7] = makeRunEvent({
        payload: {
          event: {
            kind: "turnStarted",
            sessionId: `session-${fixture.runId}`,
            turnId: "failure-repair-turn-1",
          },
          ...(observation === undefined
            ? {}
            : { modelInvocationObservation: observation }),
        },
        runId: fixture.runId,
        sequence: 8,
        timestamp: timestamp(8),
        type: "HARNESS_SESSION_EVENT_RECORDED",
      });

      assert.throws(() => replayRunEvents(events));
    }
  });

  it("makes a conclusive pre-verification repair failure terminal", () => {
    const fixture = makeFixture();
    const events = initialFailure(fixture);
    const intent = FailureRepairIntent.make({
      ...fixture.repair,
      state: "intentRecorded",
    });
    const failed = FailureRepairFailed.make({
      ...fixture.repair,
      code: "RepairSessionUnavailable",
      message: "The accepted provider session could not be resumed.",
      state: "failed",
    });
    events.push(
      repairEvent(fixture.runId, intent, 6),
      repairEvent(fixture.runId, failed, 7)
    );

    assert.strictEqual(replayRunEvents(events).value, "failed");
  });

  it("makes unavailable fresh verification terminal", () => {
    const fixture = makeFixture();
    const events = repairPrefix(fixture);
    const failed = FailureRepairFailed.make({
      ...fixture.repair,
      code: "RepairVerificationUnavailable",
      message: "Fresh exact-claim verification could not be recorded.",
      state: "failed",
    });
    events.push(repairEvent(fixture.runId, failed, 11));

    assert.strictEqual(replayRunEvents(events).value, "failed");
  });

  it("rejects a persisted repair intent after newer authoritative proof passes", () => {
    const fixture = makeFixture();
    const events = initialFailure(fixture);
    const intent = FailureRepairIntent.make({
      ...fixture.repair,
      state: "intentRecorded",
    });
    events.push(
      repairEvent(fixture.runId, intent, 6),
      makeRunEvent({
        payload: { workerResultPath: "worker-result-2.json" },
        runId: fixture.runId,
        sequence: 7,
        timestamp: timestamp(7),
        type: "WORKER_COMPLETED",
      }),
      proofEvent(
        fixture.runId,
        makeProof(fixture, {
          contentAuthoritySequence: 7,
          passed: true,
          sequence: 8,
        }),
        8
      )
    );

    assert.throws(() => replayRunEvents(events));
  });

  it("rejects supersession that does not cite the latest authoritative proof", () => {
    const fixture = makeFixture();
    const repair = {
      ...fixture.repair,
      failedProofResultSequence: parseRunEventSequence(6),
    };
    const intent = FailureRepairIntent.make({
      ...repair,
      state: "intentRecorded",
    });
    const attempted = FailureRepairDispatchAttempted.make({
      ...repair,
      state: "dispatchAttempted",
    });
    const completed = FailureRepairTurnCompleted.make({
      ...repair,
      state: "turnCompleted",
      terminalEventSequence: parseRunEventSequence(10),
    });
    const failed = FailureRepairFailed.make({
      ...repair,
      code: "RepairVerificationFailed",
      message: "The exact claim still failed.",
      proofResultSequence: parseRunEventSequence(12),
      state: "failed",
    });
    const superseded = FailureRepairSuperseded.make({
      ...repair,
      proofResultSequence: parseRunEventSequence(15),
      state: "superseded",
    });
    const events = [
      makeRunEvent({
        payload: {
          modelInvocationProtocol: "v1",
          specPath: "input.md",
        },
        runId: fixture.runId,
        sequence: 1,
        timestamp: timestamp(1),
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "1".repeat(40),
            headBranch: "codex/gaia-149-proof-order",
            mode: "pullRequest",
            remote: "origin",
            stage: "delivering",
          },
        },
        runId: fixture.runId,
        sequence: 2,
        timestamp: timestamp(2),
        type: "DELIVERY_STARTED",
      }),
      makeRunEvent({
        payload: { contract: encodeAnyRunContractJson(fixture.contract) },
        runId: fixture.runId,
        sequence: 3,
        timestamp: timestamp(3),
        type: "RUN_CONTRACT_RECORDED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId: fixture.runId,
        sequence: 4,
        timestamp: timestamp(4),
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId: fixture.runId,
        sequence: 5,
        timestamp: timestamp(5),
        type: "WORKER_COMPLETED",
      }),
      proofEvent(
        fixture.runId,
        makeProof(fixture, {
          contentAuthoritySequence: 5,
          passed: false,
          sequence: 6,
        }),
        6
      ),
      repairEvent(fixture.runId, intent, 7),
      repairEvent(fixture.runId, attempted, 8),
      makeRunEvent({
        payload: {
          event: {
            kind: "turnStarted",
            sessionId: `session-${fixture.runId}`,
            turnId: "failure-repair-turn-1",
          },
          modelInvocationObservation: Schema.encodeSync(
            ModelInvocationObservationV1
          )(
            ModelInvocationObservationV1.make({
              episodeKey: repair.episodeKey,
              kind: "offered",
              source: "codexAppServerTransport",
              trust: "high",
              version: 1,
            })
          ),
        },
        runId: fixture.runId,
        sequence: 9,
        timestamp: timestamp(9),
        type: "HARNESS_SESSION_EVENT_RECORDED",
      }),
      makeRunEvent({
        payload: {
          event: {
            kind: "turnCompleted",
            sessionId: `session-${fixture.runId}`,
            status: "completed",
            turnId: "failure-repair-turn-1",
          },
        },
        runId: fixture.runId,
        sequence: 10,
        timestamp: timestamp(10),
        type: "HARNESS_SESSION_EVENT_RECORDED",
      }),
      repairEvent(fixture.runId, completed, 11),
      proofEvent(
        fixture.runId,
        makeProof(fixture, {
          contentAuthoritySequence: 11,
          passed: false,
          sequence: 12,
        }),
        12
      ),
      repairEvent(fixture.runId, failed, 13),
      makeRunEvent({
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "1".repeat(40),
            headBranch: "codex/gaia-149-proof-order",
            mode: "pullRequest",
            remote: "origin",
            stage: "readyToPublish",
          },
          reportPath: "report.md",
        },
        runId: fixture.runId,
        sequence: 14,
        timestamp: timestamp(14),
        type: "DELIVERY_READY_TO_PUBLISH",
      }),
      proofEvent(
        fixture.runId,
        makeProof(fixture, {
          contentAuthoritySequence: 11,
          passed: true,
          sequence: 15,
        }),
        15
      ),
      proofEvent(
        fixture.runId,
        makeProof(fixture, {
          contentAuthoritySequence: 11,
          passed: false,
          sequence: 16,
        }),
        16
      ),
      repairEvent(fixture.runId, superseded, 17),
    ];

    assert.throws(() => replayRunEvents(events));
  });
});

function makeFixture() {
  const runId = parseRunId("run-Gaia149V2z");
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
  const failureEvidence = [
    {
      evidenceId: makeProofEvidenceIdV2("command", ["6".repeat(64)]),
      kind: "command" as const,
      receiptDigest: "6".repeat(64),
      requestDigest: makeVerificationCommandRequestDigest(claim.command),
      status: "nonZero" as const,
      terminalSequence: parseRunEventSequence(4),
    },
  ];
  const digest = makeFailureDigestV1({
    attempt: 1,
    evidenceRefs: failureEvidence,
    failedRef: { claimId: claim.claimId, kind: "claim" },
    maxAttempts: 2,
    outcomeCertainty: "confirmed",
    retryability: "repairable",
    stage: "verifying",
    tag: "verificationClaimFailed",
  });
  return {
    claim,
    contract,
    failureEvidence,
    repair: {
      digest,
      episodeKey: `failureRepair:${digest.fingerprint}:1`,
      failedProofResultSequence: parseRunEventSequence(5),
      runId,
    },
    runId,
  };
}

function initialFailure(fixture: ReturnType<typeof makeFixture>) {
  const failedProof = makeProof(fixture, {
    contentAuthoritySequence: 4,
    passed: false,
    sequence: 5,
  });
  return [
    makeRunEvent({
      payload: {
        modelInvocationProtocol: "v1",
        specPath: "input.md",
      },
      runId: fixture.runId,
      sequence: 1,
      timestamp: timestamp(1),
      type: "RUN_CREATED",
    }),
    makeRunEvent({
      payload: { contract: encodeAnyRunContractJson(fixture.contract) },
      runId: fixture.runId,
      sequence: 2,
      timestamp: timestamp(2),
      type: "RUN_CONTRACT_RECORDED",
    }),
    makeRunEvent({
      payload: { workspacePath: "workspace" },
      runId: fixture.runId,
      sequence: 3,
      timestamp: timestamp(3),
      type: "WORKSPACE_PREPARED",
    }),
    makeRunEvent({
      payload: { workerResultPath: "worker-result.json" },
      runId: fixture.runId,
      sequence: 4,
      timestamp: timestamp(4),
      type: "WORKER_COMPLETED",
    }),
    proofEvent(fixture.runId, failedProof, 5),
  ];
}

function repairPrefix(fixture: ReturnType<typeof makeFixture>) {
  const events = initialFailure(fixture);
  const intent = FailureRepairIntent.make({
    ...fixture.repair,
    state: "intentRecorded",
  });
  const attempted = FailureRepairDispatchAttempted.make({
    ...fixture.repair,
    state: "dispatchAttempted",
  });
  const completed = FailureRepairTurnCompleted.make({
    ...fixture.repair,
    state: "turnCompleted",
    terminalEventSequence: parseRunEventSequence(9),
  });
  events.push(
    repairEvent(fixture.runId, intent, 6),
    repairEvent(fixture.runId, attempted, 7),
    makeRunEvent({
      payload: {
        event: {
          kind: "turnStarted",
          sessionId: `session-${fixture.runId}`,
          turnId: "failure-repair-turn-1",
        },
        modelInvocationObservation: Schema.encodeSync(
          ModelInvocationObservationV1
        )(
          ModelInvocationObservationV1.make({
            episodeKey: fixture.repair.episodeKey,
            kind: "offered",
            source: "codexAppServerTransport",
            trust: "high",
            version: 1,
          })
        ),
      },
      runId: fixture.runId,
      sequence: 8,
      timestamp: timestamp(8),
      type: "HARNESS_SESSION_EVENT_RECORDED",
    }),
    makeRunEvent({
      payload: {
        event: {
          kind: "turnCompleted",
          sessionId: `session-${fixture.runId}`,
          status: "completed",
          turnId: "failure-repair-turn-1",
        },
      },
      runId: fixture.runId,
      sequence: 9,
      timestamp: timestamp(9),
      type: "HARNESS_SESSION_EVENT_RECORDED",
    }),
    repairEvent(fixture.runId, completed, 10)
  );
  return events;
}

function makeProof(
  fixture: ReturnType<typeof makeFixture>,
  input: {
    readonly contentAuthoritySequence: number;
    readonly passed: boolean;
    readonly sequence: number;
  }
) {
  return makeRunProofResultV2({
    contentAuthoritySequence: input.contentAuthoritySequence,
    contract: fixture.contract,
    observedTargetDigest: fixture.contract.targetDigest,
    recordedBy: {
      runId: fixture.runId,
      sequence: input.sequence,
      type: "RUN_PROOF_RESULT_RECORDED",
    },
    results: Schema.decodeUnknownSync(Schema.Array(ProofClaimResultV2Schema))(
      fixture.contract.proofClaims.map((claim) =>
        claim.claimId === fixture.claim.claimId
          ? input.passed
            ? {
                claimId: claim.claimId,
                evidence: [
                  {
                    evidenceId: makeProofEvidenceIdV2("command", [
                      "4".repeat(64),
                    ]),
                    kind: "command",
                    receiptDigest: "4".repeat(64),
                    requestDigest: makeVerificationCommandRequestDigest(
                      fixture.claim.command
                    ),
                    status: "succeeded",
                    terminalSequence: 8,
                  },
                ],
                status: "passed",
              }
            : {
                claimId: claim.claimId,
                evidence: fixture.failureEvidence,
                reason: "The exact command returned a non-zero status.",
                status: "failed",
              }
          : claim.kind === "human-judgment"
            ? {
                claimId: claim.claimId,
                reason: "An explicit paired-review decision is required.",
                requiredAuthority: "human",
                status: "requires-decision",
              }
            : {
                claimId: claim.claimId,
                reason: "Post-publication evidence is not available yet.",
                status: "not-run",
              }
      )
    ),
  });
}

function proofEvent(
  runId: ReturnType<typeof parseRunId>,
  result: ReturnType<typeof makeRunProofResultV2>,
  sequence: number
) {
  return makeRunEvent({
    payload: {
      result: encodeAnyRunProofResultJson(result),
      verificationResultPath: `verification/run-proof-${sequence}.json`,
    },
    runId,
    sequence,
    timestamp: timestamp(sequence),
    type: "RUN_PROOF_RESULT_RECORDED",
  });
}

function repairEvent(
  runId: ReturnType<typeof parseRunId>,
  failureRepair: Parameters<typeof encodeFailureRepairReceiptJson>[0],
  sequence: number
) {
  return makeRunEvent({
    payload: {
      failureRepair: encodeFailureRepairReceiptJson(failureRepair),
      ...(failureRepair.state === "intentRecorded"
        ? {
            modelInvocationEpisode: modelEpisode(
              runId,
              failureRepair.episodeKey
            ),
          }
        : {}),
    },
    runId,
    sequence,
    timestamp: timestamp(sequence),
    type: "FAILURE_REPAIR_RECORDED",
  });
}

function modelEpisode(
  runId: ReturnType<typeof parseRunId>,
  episodeKey: string
) {
  const episodeId = createHash("sha256").update(episodeKey).digest("hex");
  const ref = (
    kind: "modelContextManifest" | "modelInvocationManifest",
    identityDigest: string,
    filename: "context-manifest.json" | "invocation-manifest.json"
  ) => ({
    artifactId: `mmf1_${createHash("sha256")
      .update(`${kind}\0${identityDigest}`)
      .digest("hex")}`,
    bodyDigest: "f".repeat(64),
    byteLength: 123,
    episodeKey,
    identityDigest,
    kind,
    path: `model-invocations/episode1_${episodeId}/${filename}`,
    runId,
    version: 1 as const,
  });
  return {
    contextRef: ref(
      "modelContextManifest",
      createHash("sha256").update(`${episodeKey}:context`).digest("hex"),
      "context-manifest.json"
    ),
    episodeKey,
    invocationRef: ref(
      "modelInvocationManifest",
      createHash("sha256").update(`${episodeKey}:invocation`).digest("hex"),
      "invocation-manifest.json"
    ),
    version: 1 as const,
  };
}

function timestamp(sequence: number) {
  return `2026-07-25T12:40:${sequence.toString().padStart(2, "0")}.000Z`;
}
