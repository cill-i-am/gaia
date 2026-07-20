import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeRunEvent } from "./events.js";
import { replayRunEvents } from "./machine.js";
import {
  encodeMergeDecisionV2Json,
  makeMergeDecisionV2,
  MergeDecisionBlockerV2,
  RunProofBindingV1,
  sortMergeDecisionBlockersV2,
} from "./merge-decision.js";
import {
  encodeRunContractJson,
  encodeRunProofResultJson,
  makeRunContract,
  makeRunProofResult,
  RunContractDigestSchema,
  RunContractIdSchema,
  RunEventSequenceSchema,
  RunProofResultDigestSchema,
  RunRelativeArtifactPathSchema,
  StructuralDigestSchema,
} from "./run-contract.js";
import { parseRunId } from "./run-id.js";

const parseContractDigest = Schema.decodeUnknownSync(RunContractDigestSchema);
const parseContractId = Schema.decodeUnknownSync(RunContractIdSchema);
const parseProofResultDigest = Schema.decodeUnknownSync(
  RunProofResultDigestSchema
);
const parseStructuralDigest = Schema.decodeUnknownSync(StructuralDigestSchema);
const parseEventSequence = Schema.decodeUnknownSync(RunEventSequenceSchema);
const parseArtifactPath = Schema.decodeUnknownSync(
  RunRelativeArtifactPathSchema
);

describe("MergeDecisionV2", () => {
  it("rejects a proof binding whose contract belongs to another run", () => {
    const runId = parseRunId("run-mergeprf01");
    const otherRunId = parseRunId("run-mergeprf02");
    const proofBinding = RunProofBindingV1.make({
      contractDigest: parseContractDigest("a".repeat(64)),
      contractId: parseContractId(`run-contract:${otherRunId}:v1`),
      observedTargetDigest: parseStructuralDigest("b".repeat(64)),
      proofResultDigest: parseProofResultDigest("c".repeat(64)),
      proofResultSequence: parseEventSequence(2),
    });

    expect(() =>
      makeMergeDecisionV2({
        blockerCount: 0,
        blockers: [],
        contentAuthoritySequence: parseEventSequence(1),
        decidedAt: "2026-07-20T08:00:00.000Z",
        evidenceReviewPath: parseArtifactPath("evidence-review.md"),
        evidenceReviewSequence: parseEventSequence(3),
        evidenceReviewerSessionPath: parseArtifactPath(
          "evidence-reviewer-session.json"
        ),
        nextAction: "ready-to-merge",
        planReviewPath: parseArtifactPath("plan-review.md"),
        planReviewerSessionPath: parseArtifactPath(
          "plan-reviewer-session.json"
        ),
        proofBinding,
        publicationConfirmationSequence: parseEventSequence(4),
        runId,
        runProfilePath: parseArtifactPath("run-profile.json"),
        status: "approved",
        version: 2,
      })
    ).toThrow(/contract.*run/iu);
  });

  it("uses the parser's deterministic UTF-8 blocker order", () => {
    const blockers = ["ä", "z"].map((summary) =>
      MergeDecisionBlockerV2.make({
        action: "Resolve the blocker.",
        kind: "reviewer-blocked",
        summary,
      })
    );

    expect(
      sortMergeDecisionBlockersV2(blockers).map(({ summary }) => summary)
    ).toEqual(["z", "ä"]);
  });

  it("rejects a valid V2 decision embedded in another run's event history", () => {
    const enclosingRunId = parseRunId("run-mergeevt01");
    const decisionRunId = parseRunId("run-mergeevt02");
    const blocker = MergeDecisionBlockerV2.make({
      action: "Record contract-bound proof.",
      kind: "run-proof-not-verified",
      summary: "Run proof is not verified.",
    });
    const decision = makeMergeDecisionV2({
      blockerCount: 1,
      blockers: [blocker],
      contentAuthoritySequence: parseEventSequence(1),
      decidedAt: "2026-07-20T08:00:00.000Z",
      evidenceReviewPath: parseArtifactPath("evidence-review.md"),
      evidenceReviewerSessionPath: parseArtifactPath(
        "evidence-reviewer-session.json"
      ),
      nextAction: "resolve-blockers",
      planReviewPath: parseArtifactPath("plan-review.md"),
      planReviewerSessionPath: parseArtifactPath("plan-reviewer-session.json"),
      runId: decisionRunId,
      runProfilePath: parseArtifactPath("run-profile.json"),
      status: "blocked",
      version: 2,
    });
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId: enclosingRunId,
        sequence: 1,
        timestamp: "2026-07-20T08:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "0".repeat(40),
            headBranch: "gaia/mergeevt01",
            mode: "pullRequest",
            remote: "origin",
            stage: "delivering",
          },
        },
        runId: enclosingRunId,
        sequence: 2,
        timestamp: "2026-07-20T08:00:01.000Z",
        type: "DELIVERY_STARTED",
      }),
      makeRunEvent({
        payload: {
          decision: encodeMergeDecisionV2Json(decision),
          mergeDecisionPath: "merge-decision.json",
        },
        runId: enclosingRunId,
        sequence: 3,
        timestamp: "2026-07-20T08:00:02.000Z",
        type: "MERGE_DECISION_RECORDED",
      }),
    ];

    expect(() => replayRunEvents(events)).toThrow(/enclosing run/iu);
  });

  it("rejects approved V2 replay without matching verified proof authority", () => {
    const runId = parseRunId("run-mergeauth1");
    const contract = makeRunContract({
      acceptedOutcomes: [],
      baseDigest: "a".repeat(64),
      baseIdentity: {
        kind: "provenanceUnavailable",
        reason: "notCollected",
        workspacePath: ".",
      },
      nonGoals: [],
      proofClaims: [],
      runId,
      stopConditions: [],
      targetDigest: "b".repeat(64),
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });
    const proof = makeRunProofResult({
      contract,
      observedTargetDigest: contract.targetDigest,
      recordedBy: { runId, sequence: 4, type: "RUN_PROOF_RESULT_RECORDED" },
      results: [],
      supplementalProtocolEvidence: [],
    });
    const decision = makeMergeDecisionV2({
      blockerCount: 0,
      blockers: [],
      contentAuthoritySequence: parseEventSequence(3),
      decidedAt: "2026-07-20T08:00:05.000Z",
      evidenceReviewPath: parseArtifactPath("evidence-review.md"),
      evidenceReviewSequence: parseEventSequence(3),
      evidenceReviewerSessionPath: parseArtifactPath(
        "evidence-reviewer-session.json"
      ),
      nextAction: "ready-to-merge",
      planReviewPath: parseArtifactPath("plan-review.md"),
      planReviewerSessionPath: parseArtifactPath("plan-reviewer-session.json"),
      proofBinding: RunProofBindingV1.make({
        contractDigest: contract.contractDigest,
        contractId: contract.contractId,
        observedTargetDigest: proof.observedTargetDigest,
        proofResultDigest: proof.resultDigest,
        proofResultSequence: proof.recordedBy.sequence,
      }),
      publicationConfirmationSequence: parseEventSequence(2),
      runId,
      runProfilePath: parseArtifactPath("run-profile.json"),
      status: "approved",
      version: 2,
    });
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-20T08:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { contract: encodeRunContractJson(contract) },
        runId,
        sequence: 2,
        timestamp: "2026-07-20T08:00:01.000Z",
        type: "RUN_CONTRACT_RECORDED",
      }),
      makeRunEvent({
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "0".repeat(40),
            headBranch: "gaia/mergeauth1",
            mode: "pullRequest",
            remote: "origin",
            stage: "delivering",
          },
        },
        runId,
        sequence: 3,
        timestamp: "2026-07-20T08:00:02.000Z",
        type: "DELIVERY_STARTED",
      }),
      makeRunEvent({
        payload: {
          result: encodeRunProofResultJson(proof),
          verificationResultPath: "verification-result.json",
        },
        runId,
        sequence: 4,
        timestamp: "2026-07-20T08:00:03.000Z",
        type: "RUN_PROOF_RESULT_RECORDED",
      }),
      makeRunEvent({
        payload: {
          decision: encodeMergeDecisionV2Json(decision),
          mergeDecisionPath: "merge-decision.json",
        },
        runId,
        sequence: 5,
        timestamp: "2026-07-20T08:00:04.000Z",
        type: "MERGE_DECISION_RECORDED",
      }),
    ];

    expect(() => replayRunEvents(events)).toThrow(/approved.*authority/iu);
  });
});
