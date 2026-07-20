import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeRunEvent } from "./events.js";
import { replayRunEvents } from "./machine.js";
import {
  encodeMergeDecisionV2Json,
  makeMergeDecisionV2,
  MergeDecisionBlockerV2,
  parseMergeDecisionV2Json,
  sortMergeDecisionBlockersV2,
  type MergeDecisionProofV2,
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
  it("rejects malformed canonical fields during construction and JSON decode", () => {
    const runId = parseRunId("run-UnicodeV2a");
    const loneHigh = "\uD800";
    const loneLow = "\uDC00";
    const binding = {
      blockerCount: 1,
      contentAuthoritySequence: parseEventSequence(1),
      decidedAt: "2026-07-20T08:00:00.000Z",
      evidenceReviewPath: parseArtifactPath("evidence-review.md"),
      evidenceReviewerSessionPath: parseArtifactPath(
        "evidence-reviewer-session.json"
      ),
      nextAction: "resolve-blockers" as const,
      planReviewPath: parseArtifactPath("plan-review.md"),
      planReviewerSessionPath: parseArtifactPath("plan-reviewer-session.json"),
      proof: {
        aggregate: "completed-unverified" as const,
        kind: "noContract" as const,
      },
      runId,
      runProfilePath: parseArtifactPath("run-profile.json"),
      status: "blocked" as const,
      version: 2 as const,
    };

    expect(() =>
      makeMergeDecisionV2({
        ...binding,
        blockers: [
          MergeDecisionBlockerV2.make({
            action: "Resolve.",
            kind: "reviewer-blocked",
            summary: loneHigh,
          }),
        ],
      })
    ).toThrow(/well-formed Unicode/iu);
    expect(() =>
      makeMergeDecisionV2({
        ...binding,
        blockers: [
          MergeDecisionBlockerV2.make({
            action: loneLow,
            kind: "reviewer-blocked",
            summary: "Resolve the review blocker.",
          }),
        ],
      })
    ).toThrow(/well-formed Unicode/iu);
    expect(() =>
      makeMergeDecisionV2({
        ...binding,
        blockers: [
          MergeDecisionBlockerV2.make({
            action: "Resolve.",
            kind: "reviewer-blocked",
            summary: "Resolve the review blocker.",
          }),
        ],
        planReviewPath: parseArtifactPath(`plan-${loneHigh}.md`),
      })
    ).toThrow(/well-formed Unicode/iu);

    const legacyMalformedDecision = {
      blockerCount: 1,
      blockers: [
        {
          action: "Resolve.",
          kind: "reviewer-blocked",
          summary: loneLow,
        },
      ],
      contentAuthoritySequence: 1,
      decidedAt: "2026-07-20T08:00:00.000Z",
      evidenceReviewPath: "evidence-review.md",
      evidenceReviewerSessionPath: "evidence-reviewer-session.json",
      nextAction: "resolve-blockers",
      payloadDigest:
        "64151280db5e9e06f8c811a3801090741154e55b320161ba5cb2a9151c2af718",
      planReviewPath: "plan-review.md",
      planReviewerSessionPath: "plan-reviewer-session.json",
      proof: { aggregate: "completed-unverified", kind: "noContract" },
      runId: "run-UnicodeV2a",
      runProfilePath: "run-profile.json",
      status: "blocked",
      version: 2,
    };

    expect(() => parseMergeDecisionV2Json(legacyMalformedDecision)).toThrow(
      /well-formed Unicode/iu
    );

    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-20T08:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "0".repeat(40),
            headBranch: "gaia/unicode-v2",
            mode: "pullRequest",
            remote: "origin",
            stage: "delivering",
          },
        },
        runId,
        sequence: 2,
        timestamp: "2026-07-20T08:00:01.000Z",
        type: "DELIVERY_STARTED",
      }),
      makeRunEvent({
        payload: {
          decision: legacyMalformedDecision,
          mergeDecisionPath: "merge-decision.json",
        },
        runId,
        sequence: 3,
        timestamp: "2026-07-20T08:00:02.000Z",
        type: "MERGE_DECISION_RECORDED",
      }),
    ];

    expect(() => replayRunEvents(events)).toThrow(/well-formed Unicode/iu);
  });

  it("round-trips valid surrogate pairs with a deterministic payload digest", () => {
    const runId = parseRunId("run-UnicodeV2b");
    const blocker = MergeDecisionBlockerV2.make({
      action: "Resolve the astral blocker 😀.",
      kind: "reviewer-blocked",
      summary: "Astral notation 𝄞 remains intact.",
    });
    const binding = {
      blockerCount: 1,
      blockers: [blocker],
      contentAuthoritySequence: parseEventSequence(1),
      decidedAt: "2026-07-20T08:00:00.000Z",
      evidenceReviewPath: parseArtifactPath("evidence-review.md"),
      evidenceReviewerSessionPath: parseArtifactPath(
        "evidence-reviewer-session.json"
      ),
      nextAction: "resolve-blockers" as const,
      planReviewPath: parseArtifactPath("plan-review.md"),
      planReviewerSessionPath: parseArtifactPath("plan-reviewer-session.json"),
      proof: {
        aggregate: "completed-unverified" as const,
        kind: "noContract" as const,
      },
      runId,
      runProfilePath: parseArtifactPath("run-profile.json"),
      status: "blocked" as const,
      version: 2 as const,
    };
    const first = makeMergeDecisionV2(binding);
    const second = makeMergeDecisionV2(binding);

    expect(second.payloadDigest).toBe(first.payloadDigest);
    expect(parseMergeDecisionV2Json(encodeMergeDecisionV2Json(first))).toEqual(
      first
    );
  });

  it("requires a typed proof description even when blocked", () => {
    const runId = parseRunId("run-mergemiss1");
    const blocker = MergeDecisionBlockerV2.make({
      action: "Record contract-bound proof.",
      kind: "run-contract-missing",
      summary: "The run contract is missing.",
    });

    const valid = makeMergeDecisionV2({
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
      proof: {
        aggregate: "completed-unverified",
        kind: "noContract",
      },
      runId,
      runProfilePath: parseArtifactPath("run-profile.json"),
      status: "blocked",
      version: 2,
    });
    const encoded = encodeMergeDecisionV2Json(valid);
    if (
      typeof encoded !== "object" ||
      encoded === null ||
      Array.isArray(encoded)
    )
      throw new Error("Expected encoded MergeDecisionV2 object.");
    const missingProof = Object.fromEntries(
      Object.entries(encoded).filter(([key]) => key !== "proof")
    );

    expect(() => parseMergeDecisionV2Json(missingProof)).toThrow(/proof/iu);
  });

  it("rejects a proof binding whose contract belongs to another run", () => {
    const runId = parseRunId("run-mergeprf01");
    const otherRunId = parseRunId("run-mergeprf02");
    const proof = {
      contractDigest: parseContractDigest("a".repeat(64)),
      contractId: parseContractId(`run-contract:${otherRunId}:v1`),
      kind: "contract" as const,
      result: {
        aggregate: "verified" as const,
        kind: "recorded" as const,
        observedTargetDigest: parseStructuralDigest("b".repeat(64)),
        resultDigest: parseProofResultDigest("c".repeat(64)),
        sequence: parseEventSequence(2),
      },
    };

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
        proof,
        publicationConfirmationSequence: parseEventSequence(4),
        runId,
        runProfilePath: parseArtifactPath("run-profile.json"),
        status: "approved",
        version: 2,
      })
    ).toThrow(/contract.*run/iu);
  });

  it.each([
    [
      "no contract",
      {
        aggregate: "completed-unverified" as const,
        kind: "noContract" as const,
      },
      "blocked" as const,
    ],
    [
      "missing result",
      {
        contractDigest: parseContractDigest("a".repeat(64)),
        contractId: parseContractId("run-contract:run-mergeprf03:v1"),
        kind: "contract" as const,
        result: { kind: "missing" as const },
      },
      "blocked" as const,
    ],
    [
      "recorded unverified result",
      {
        contractDigest: parseContractDigest("a".repeat(64)),
        contractId: parseContractId("run-contract:run-mergeprf03:v1"),
        kind: "contract" as const,
        result: {
          aggregate: "completed-unverified" as const,
          kind: "recorded" as const,
          observedTargetDigest: parseStructuralDigest("b".repeat(64)),
          resultDigest: parseProofResultDigest("c".repeat(64)),
          sequence: parseEventSequence(2),
        },
      },
      "blocked" as const,
    ],
    [
      "recorded verified result",
      {
        contractDigest: parseContractDigest("a".repeat(64)),
        contractId: parseContractId("run-contract:run-mergeprf03:v1"),
        kind: "contract" as const,
        result: {
          aggregate: "verified" as const,
          kind: "recorded" as const,
          observedTargetDigest: parseStructuralDigest("b".repeat(64)),
          resultDigest: parseProofResultDigest("c".repeat(64)),
          sequence: parseEventSequence(2),
        },
      },
      "approved" as const,
    ],
  ])("round-trips a %s proof description", (_label, proof, status) => {
    const runId = parseRunId("run-mergeprf03");
    const blocker = MergeDecisionBlockerV2.make({
      action: "Record verified proof.",
      kind: "run-proof-not-verified",
      summary: "Run proof is not verified.",
    });
    const approved = status === "approved";
    const decision = makeMergeDecisionV2({
      blockerCount: approved ? 0 : 1,
      blockers: approved ? [] : [blocker],
      contentAuthoritySequence: parseEventSequence(1),
      decidedAt: "2026-07-20T08:00:00.000Z",
      evidenceReviewPath: parseArtifactPath("evidence-review.md"),
      ...(approved ? { evidenceReviewSequence: parseEventSequence(3) } : {}),
      evidenceReviewerSessionPath: parseArtifactPath(
        "evidence-reviewer-session.json"
      ),
      nextAction: approved ? "ready-to-merge" : "resolve-blockers",
      planReviewPath: parseArtifactPath("plan-review.md"),
      planReviewerSessionPath: parseArtifactPath("plan-reviewer-session.json"),
      proof,
      ...(approved
        ? { publicationConfirmationSequence: parseEventSequence(4) }
        : {}),
      runId,
      runProfilePath: parseArtifactPath("run-profile.json"),
      status,
      version: 2,
    });

    expect(
      parseMergeDecisionV2Json(encodeMergeDecisionV2Json(decision))
    ).toEqual(decision);
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

  it("rejects malformed blocker text before UTF-8 sorting", () => {
    const blockers = ["\uD800", "\uDC00"].map((summary) =>
      MergeDecisionBlockerV2.make({
        action: "Resolve the blocker.",
        kind: "reviewer-blocked",
        summary,
      })
    );

    expect(() => sortMergeDecisionBlockersV2(blockers)).toThrow(
      /well-formed Unicode/iu
    );
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
      proof: {
        aggregate: "completed-unverified",
        kind: "noContract",
      },
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

  it("rejects a foreign V2 chain whose payloads match their enclosing events", () => {
    const historyRunId = parseRunId("run-mergehist1");
    const foreignRunId = parseRunId("run-mergehist2");
    const blocker = MergeDecisionBlockerV2.make({
      action: "Record contract-bound proof.",
      kind: "run-contract-missing",
      summary: "The run contract is missing.",
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
      proof: {
        aggregate: "completed-unverified",
        kind: "noContract",
      },
      runId: foreignRunId,
      runProfilePath: parseArtifactPath("run-profile.json"),
      status: "blocked",
      version: 2,
    });
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId: historyRunId,
        sequence: 1,
        timestamp: "2026-07-20T08:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "0".repeat(40),
            headBranch: "gaia/mergehist2",
            mode: "pullRequest",
            remote: "origin",
            stage: "delivering",
          },
        },
        runId: foreignRunId,
        sequence: 2,
        timestamp: "2026-07-20T08:00:01.000Z",
        type: "DELIVERY_STARTED",
      }),
      makeRunEvent({
        payload: {
          decision: encodeMergeDecisionV2Json(decision),
          mergeDecisionPath: "merge-decision.json",
        },
        runId: foreignRunId,
        sequence: 3,
        timestamp: "2026-07-20T08:00:02.000Z",
        type: "MERGE_DECISION_RECORDED",
      }),
    ];

    expect(() => replayRunEvents(events)).toThrow(/single run/iu);
  });

  it.each([
    ["no-contract", "run-v2nocontr1"],
    ["missing-result", "run-v2missing1"],
    ["recorded-unverified", "run-v2unverif1"],
  ] as const)("replays a blocked V2 with %s proof truth", (mode, rawRunId) => {
    const runId = parseRunId(rawRunId);
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-20T08:00:00.000Z",
        type: "RUN_CREATED",
      }),
    ];
    let proofDescription: MergeDecisionProofV2 = {
      aggregate: "completed-unverified",
      kind: "noContract",
    };
    if (mode !== "no-contract") {
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
      events.push(
        makeRunEvent({
          payload: { contract: encodeRunContractJson(contract) },
          runId,
          sequence: 2,
          timestamp: "2026-07-20T08:00:01.000Z",
          type: "RUN_CONTRACT_RECORDED",
        })
      );
      proofDescription = {
        contractDigest: contract.contractDigest,
        contractId: contract.contractId,
        kind: "contract",
        result: { kind: "missing" },
      };
      if (mode === "recorded-unverified") {
        const result = makeRunProofResult({
          contract,
          observedTargetDigest: contract.targetDigest,
          recordedBy: {
            runId,
            sequence: 6,
            type: "RUN_PROOF_RESULT_RECORDED",
          },
          results: [],
          supplementalProtocolEvidence: [],
        });
        proofDescription = {
          contractDigest: contract.contractDigest,
          contractId: contract.contractId,
          kind: "contract",
          result: {
            aggregate: result.aggregate,
            kind: "recorded",
            observedTargetDigest: result.observedTargetDigest,
            resultDigest: result.resultDigest,
            sequence: result.recordedBy.sequence,
          },
        };
        events.push(
          makeRunEvent({
            payload: { workspacePath: "workspace" },
            runId,
            sequence: 4,
            timestamp: "2026-07-20T08:00:03.000Z",
            type: "WORKSPACE_PREPARED",
          }),
          makeRunEvent({
            payload: { workerResultPath: "worker-result.json" },
            runId,
            sequence: 5,
            timestamp: "2026-07-20T08:00:04.000Z",
            type: "WORKER_COMPLETED",
          }),
          makeRunEvent({
            payload: {
              result: encodeRunProofResultJson(result),
              verificationResultPath: "verification-result.json",
            },
            runId,
            sequence: 6,
            timestamp: "2026-07-20T08:00:05.000Z",
            type: "RUN_PROOF_RESULT_RECORDED",
          }),
          makeRunEvent({
            payload: {
              delivery: {
                baseBranch: "main",
                baseRevision: "0".repeat(40),
                headBranch: `gaia/${rawRunId}`,
                mode: "pullRequest",
                remote: "origin",
                stage: "readyToPublish",
              },
              reportPath: "report.md",
            },
            runId,
            sequence: 7,
            timestamp: "2026-07-20T08:00:06.000Z",
            type: "DELIVERY_READY_TO_PUBLISH",
          })
        );
      }
    }
    const deliverySequence = mode === "no-contract" ? 2 : 3;
    events.splice(
      deliverySequence - 1,
      0,
      makeRunEvent({
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "0".repeat(40),
            headBranch: `gaia/${rawRunId}`,
            mode: "pullRequest",
            remote: "origin",
            stage: "delivering",
          },
        },
        runId,
        sequence: deliverySequence,
        timestamp: "2026-07-20T08:00:02.000Z",
        type: "DELIVERY_STARTED",
      })
    );
    const blocker = MergeDecisionBlockerV2.make({
      action: "Record verified contract proof.",
      kind:
        mode === "no-contract"
          ? "run-contract-missing"
          : mode === "missing-result"
            ? "run-proof-result-missing"
            : "run-proof-not-verified",
      summary: "The proof truth is not merge-ready.",
    });
    const decision = makeMergeDecisionV2({
      blockerCount: 1,
      blockers: [blocker],
      contentAuthoritySequence: parseEventSequence(1),
      decidedAt: "2026-07-20T08:00:05.000Z",
      evidenceReviewPath: parseArtifactPath("evidence-review.md"),
      evidenceReviewerSessionPath: parseArtifactPath(
        "evidence-reviewer-session.json"
      ),
      nextAction: "resolve-blockers",
      planReviewPath: parseArtifactPath("plan-review.md"),
      planReviewerSessionPath: parseArtifactPath("plan-reviewer-session.json"),
      proof: proofDescription,
      runId,
      runProfilePath: parseArtifactPath("run-profile.json"),
      status: "blocked",
      version: 2,
    });
    events.push(
      makeRunEvent({
        payload: {
          decision: encodeMergeDecisionV2Json(decision),
          mergeDecisionPath: "merge-decision.json",
        },
        runId,
        sequence: events.length + 1,
        timestamp: "2026-07-20T08:00:05.000Z",
        type: "MERGE_DECISION_RECORDED",
      })
    );

    expect(replayRunEvents(events).value).toBe("delivering");
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
      recordedBy: { runId, sequence: 6, type: "RUN_PROOF_RESULT_RECORDED" },
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
      proof: {
        contractDigest: contract.contractDigest,
        contractId: contract.contractId,
        kind: "contract",
        result: {
          aggregate: "verified",
          kind: "recorded",
          observedTargetDigest: proof.observedTargetDigest,
          resultDigest: proof.resultDigest,
          sequence: proof.recordedBy.sequence,
        },
      },
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
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 4,
        timestamp: "2026-07-20T08:00:03.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 5,
        timestamp: "2026-07-20T08:00:04.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          result: encodeRunProofResultJson(proof),
          verificationResultPath: "verification-result.json",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-20T08:00:05.000Z",
        type: "RUN_PROOF_RESULT_RECORDED",
      }),
      makeRunEvent({
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "0".repeat(40),
            headBranch: "gaia/mergeauth1",
            mode: "pullRequest",
            remote: "origin",
            stage: "readyToPublish",
          },
          reportPath: "report.md",
        },
        runId,
        sequence: 7,
        timestamp: "2026-07-20T08:00:06.000Z",
        type: "DELIVERY_READY_TO_PUBLISH",
      }),
      makeRunEvent({
        payload: {
          decision: encodeMergeDecisionV2Json(decision),
          mergeDecisionPath: "merge-decision.json",
        },
        runId,
        sequence: 8,
        timestamp: "2026-07-20T08:00:07.000Z",
        type: "MERGE_DECISION_RECORDED",
      }),
    ];

    expect(() => replayRunEvents(events)).toThrow(/proof description/iu);
  });
});
