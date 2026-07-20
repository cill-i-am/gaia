import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { makeRunEvent } from "./events.js";
import { replayRunEvents } from "./machine.js";
import {
  aggregateRunProofResult,
  ContractRunProofProjectionV1,
  deriveAcceptedOutcomeId,
  deriveExplicitSpecItemDigest,
  deriveProofClaimId,
  encodeRunContractJson,
  encodeRunProofResultJson,
  makeRunContract,
  makeRunProofResult,
  parseRunContract,
  parseRunContractJson,
  parseRunProofResult,
  parseRunProofResultJson,
  RunProofProjectionV1Schema,
  workspaceStructuralDigestV1,
} from "./run-contract.js";
import { parseRunId } from "./run-id.js";

const runId = parseRunId("run-gaia144red");
const targetDigest = "1".repeat(64);
const baseDigest = "2".repeat(64);

const source = <
  const Section extends
    | "acceptanceCriteria"
    | "verificationChecks"
    | "nonGoals"
    | "stopConditions",
>(
  section: Section,
  statement: string
) => ({
  itemDigest: deriveExplicitSpecItemDigest({ section, statement }),
  kind: "explicitSpecItem" as const,
  section,
  specDigest: "3".repeat(64),
  version: 1 as const,
});

describe("RunContractV1", () => {
  it("keeps an explicit zero-claim contract completed-unverified", () => {
    const contract = makeRunContract({
      acceptedOutcomes: [],
      baseDigest,
      baseIdentity: {
        kind: "provenanceUnavailable",
        reason: "notCollected",
        workspacePath: ".",
      },
      nonGoals: [],
      proofClaims: [],
      runId,
      stopConditions: [],
      targetDigest,
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });
    expect(() =>
      Schema.decodeUnknownSync(ContractRunProofProjectionV1)({
        aggregate: "completed-unverified",
        contract,
        kind: "contract",
        version: 1,
      })
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RunProofProjectionV1Schema)({
        aggregate: "completed-unverified",
        contract,
        kind: "contract",
        version: 1,
      })
    ).not.toThrow();
    const result = makeRunProofResult({
      contract,
      observedTargetDigest: targetDigest,
      recordedBy: { runId, sequence: 7, type: "RUN_PROOF_RESULT_RECORDED" },
      results: [],
      supplementalProtocolEvidence: [
        {
          artifactPath: "workspace/output.txt",
          contentDigest: "4".repeat(64),
          kind: "framework-output-marker",
        },
      ],
    });

    expect(result.aggregate).toBe("completed-unverified");
    expect(contract.proofClaims).toHaveLength(0);
  });

  it("verifies only when every outcome has required behavioral proof", () => {
    const outcomeStatement = "The requested change is present.";
    const claimStatement = "Inspect the requested artifact.";
    const outcomeSource = source("acceptanceCriteria", outcomeStatement);
    const claimSource = source("verificationChecks", claimStatement);
    const claimId = deriveProofClaimId({
      authorityRequirements: ["gaia-runtime"],
      kind: "command",
      requirement: "required",
      source: claimSource,
      statement: claimStatement,
    });
    const contract = makeRunContract({
      acceptedOutcomes: [
        {
          outcomeId: deriveAcceptedOutcomeId({
            source: outcomeSource,
            statement: outcomeStatement,
          }),
          requiredClaimIds: [claimId],
          source: outcomeSource,
          statement: outcomeStatement,
        },
      ],
      baseDigest,
      baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
      nonGoals: [],
      proofClaims: [
        {
          authorityRequirements: ["gaia-runtime"],
          claimId,
          kind: "command",
          requirement: "required",
          source: claimSource,
          statement: claimStatement,
        },
      ],
      runId,
      stopConditions: [],
      targetDigest,
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });

    const result = makeRunProofResult({
      contract,
      observedTargetDigest: targetDigest,
      recordedBy: { runId, sequence: 8, type: "RUN_PROOF_RESULT_RECORDED" },
      results: [
        {
          claimId,
          evidence: [
            {
              artifactPath: "workspace/output.txt",
              contentDigest: "5".repeat(64),
              kind: "command",
            },
          ],
          status: "passed",
        },
      ],
      supplementalProtocolEvidence: [],
    });

    expect(aggregateRunProofResult(contract, result.results)).toBe("verified");
    expect(result.aggregate).toBe("verified");
  });

  it("rejects source-role swaps and a forged aggregate", () => {
    const contract = makeRunContract({
      acceptedOutcomes: [],
      baseDigest,
      baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
      nonGoals: [],
      proofClaims: [],
      runId,
      stopConditions: [],
      targetDigest,
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });

    expect(() =>
      parseRunContract({
        ...contract,
        acceptedOutcomes: [
          {
            outcomeId: `accepted-outcome:sha256:${"a".repeat(64)}`,
            requiredClaimIds: [],
            source: source("nonGoals", "Wrong source role"),
            statement: "Wrong source role",
          },
        ],
      })
    ).toThrow();
  });

  it.each([
    ["accepted outcome", "acceptedOutcomes", "nonGoals"],
    ["proof claim", "proofClaims", "acceptanceCriteria"],
    ["non-goal", "nonGoals", "stopConditions"],
    ["stop condition", "stopConditions", "verificationChecks"],
  ] as const)(
    "rejects a corrupt %s source role",
    (_label, field, wrongRole) => {
      const fixture = contractWithRequiredClaim();
      const statement = `Corrupt ${field}`;
      const corruptItem =
        field === "acceptedOutcomes"
          ? {
              conditionalClaimIds: [],
              outcomeId: fixture.contract.acceptedOutcomes[0]!.outcomeId,
              requiredClaimIds: [fixture.claimId],
              source: source(wrongRole, statement),
              statement,
            }
          : field === "proofClaims"
            ? {
                ...fixture.contract.proofClaims[0]!,
                source: source(wrongRole, statement),
                statement,
              }
            : { source: source(wrongRole, statement), statement };

      expect(() =>
        parseRunContract({
          ...fixture.contract,
          [field]: [corruptItem],
        })
      ).toThrow();
    }
  );

  it("round-trips contract and proof JSON and rejects a forged aggregate", () => {
    const fixture = contractWithRequiredClaim();
    const result = makeRunProofResult({
      contract: fixture.contract,
      observedTargetDigest: targetDigest,
      recordedBy: { runId, sequence: 9, type: "RUN_PROOF_RESULT_RECORDED" },
      results: [passedResult(fixture.claimId)],
      supplementalProtocolEvidence: [],
    });

    expect(
      parseRunContractJson(encodeRunContractJson(fixture.contract))
    ).toEqual(fixture.contract);
    expect(parseRunProofResultJson(encodeRunProofResultJson(result))).toEqual(
      result
    );
    expect(() =>
      parseRunProofResult(
        { ...result, aggregate: "completed-unverified" },
        fixture.contract
      )
    ).toThrow();
  });

  it("uses stable collision-resistant claim IDs and rejects duplicate claims", () => {
    const statement = "Run the explicit verification check.";
    const claimSource = source("verificationChecks", statement);
    const base = {
      authorityRequirements: ["harness" as const],
      kind: "command" as const,
      requirement: "required" as const,
      source: claimSource,
      statement,
    };
    const first = deriveProofClaimId(base);

    expect(deriveProofClaimId({ ...base, statement: `  ${statement}\n` })).toBe(
      first
    );
    expect(deriveProofClaimId({ ...base, kind: "browser" })).not.toBe(first);
    expect(
      deriveProofClaimId({
        ...base,
        authorityRequirements: ["gaia-runtime"],
      })
    ).not.toBe(first);

    const fixture = contractWithRequiredClaim();
    expect(() =>
      makeRunContract({
        ...contractInput(fixture.contract),
        proofClaims: [
          { ...fixture.contract.proofClaims[0]! },
          { ...fixture.contract.proofClaims[0]! },
        ],
      })
    ).toThrow(/sorted unique proof claim IDs/iu);
  });

  it("normalizes every sourced statement before ordering and digesting", () => {
    const claimStatement = "Inspect the requested change.";
    const claimSource = source("verificationChecks", claimStatement);
    const claimId = deriveProofClaimId({
      authorityRequirements: ["harness"],
      kind: "command",
      requirement: "required",
      source: claimSource,
      statement: claimStatement,
    });
    const nonGoalStatement = "Do not deploy.";
    const nonGoalSource = source("nonGoals", nonGoalStatement);
    const stopStatement = "Stop for operator approval.";
    const stopSource = source("stopConditions", stopStatement);
    const input = {
      acceptedOutcomes: [],
      baseDigest,
      baseIdentity: {
        kind: "unversionedSnapshot" as const,
        workspacePath: ".",
      },
      nonGoals: [
        {
          source: nonGoalSource,
          statement: `  ${nonGoalStatement}\r\n`,
        },
      ],
      proofClaims: [
        {
          authorityRequirements: ["harness" as const],
          claimId,
          kind: "command" as const,
          requirement: "required" as const,
          source: claimSource,
          statement: `\n${claimStatement}  `,
        },
      ],
      runId,
      stopConditions: [
        { source: stopSource, statement: `\r\n${stopStatement}\r\n` },
      ],
      targetDigest,
      targetIdentity: {
        kind: "unversionedWorkspace" as const,
        workspacePath: ".",
      },
    };
    const normalized = makeRunContract(input);
    const canonical = makeRunContract({
      ...input,
      nonGoals: [{ source: nonGoalSource, statement: nonGoalStatement }],
      proofClaims: [
        {
          ...input.proofClaims[0]!,
          statement: claimStatement,
        },
      ],
      stopConditions: [{ source: stopSource, statement: stopStatement }],
    });

    expect(normalized.proofClaims[0]?.statement).toBe(claimStatement);
    expect(normalized.nonGoals[0]?.statement).toBe(nonGoalStatement);
    expect(normalized.stopConditions[0]?.statement).toBe(stopStatement);
    expect(normalized.contractDigest).toBe(canonical.contractDigest);
    expect(() =>
      makeRunContract({
        ...input,
        nonGoals: [
          { source: nonGoalSource, statement: nonGoalStatement },
          { source: nonGoalSource, statement: ` ${nonGoalStatement} ` },
        ],
      })
    ).toThrow(/sorted unique non-goals/iu);
  });

  it("supports shared outcome claims while unreferenced required claims remain global", () => {
    const fixture = contractWithRequiredClaim();
    const secondOutcomeStatement = "The second accepted outcome is present.";
    const secondOutcomeSource = source(
      "acceptanceCriteria",
      secondOutcomeStatement
    );
    const extraClaimStatement = "Inspect the unreferenced required behavior.";
    const extraClaimSource = source("verificationChecks", extraClaimStatement);
    const extraClaimId = deriveProofClaimId({
      authorityRequirements: ["harness"],
      kind: "command",
      requirement: "required",
      source: extraClaimSource,
      statement: extraClaimStatement,
    });
    const contract = makeRunContract({
      ...contractInput(fixture.contract),
      acceptedOutcomes: [
        { ...fixture.contract.acceptedOutcomes[0]! },
        {
          conditionalClaimIds: [],
          outcomeId: deriveAcceptedOutcomeId({
            source: secondOutcomeSource,
            statement: secondOutcomeStatement,
          }),
          requiredClaimIds: [fixture.claimId],
          source: secondOutcomeSource,
          statement: secondOutcomeStatement,
        },
      ],
      proofClaims: [
        { ...fixture.contract.proofClaims[0]! },
        {
          authorityRequirements: ["harness"],
          claimId: extraClaimId,
          kind: "command",
          requirement: "required",
          source: extraClaimSource,
          statement: extraClaimStatement,
        },
      ],
    });

    expect(
      aggregateRunProofResult(contract, [
        passedResult(fixture.claimId),
      ] as never)
    ).toBe("completed-unverified");
    expect(
      makeRunProofResult({
        contract,
        observedTargetDigest: targetDigest,
        recordedBy: { runId, sequence: 10, type: "RUN_PROOF_RESULT_RECORDED" },
        results: [
          passedResult(fixture.claimId),
          {
            claimId: extraClaimId,
            evidence: [
              {
                artifactPath: "verification/extra-claim.json",
                contentDigest: "9".repeat(64),
                kind: "command",
              },
            ],
            status: "passed",
          },
        ],
        supplementalProtocolEvidence: [],
      }).aggregate
    ).toBe("verified");
  });

  it("enforces all five strict claim-result cases and proof-kind compatibility", () => {
    const fixture = contractWithRequiredClaim();
    const recordedBy = {
      runId,
      sequence: 11,
      type: "RUN_PROOF_RESULT_RECORDED" as const,
    };
    expect(
      makeRunProofResult({
        contract: fixture.contract,
        observedTargetDigest: targetDigest,
        recordedBy,
        results: [passedResult(fixture.claimId)],
        supplementalProtocolEvidence: [],
      }).aggregate
    ).toBe("verified");
    expect(
      makeRunProofResult({
        contract: fixture.contract,
        observedTargetDigest: targetDigest,
        recordedBy,
        results: [
          {
            claimId: fixture.claimId,
            evidence: [],
            reason: "Observed failure.",
            status: "failed",
          },
        ],
        supplementalProtocolEvidence: [],
      }).aggregate
    ).toBe("verification-failed");
    expect(
      makeRunProofResult({
        contract: fixture.contract,
        observedTargetDigest: targetDigest,
        recordedBy,
        results: [
          {
            claimId: fixture.claimId,
            reason: "Not executed.",
            status: "not-run",
          },
        ],
        supplementalProtocolEvidence: [],
      }).aggregate
    ).toBe("completed-unverified");

    const conditional = contractWithClaim({
      kind: "browser",
      requirement: "conditional",
    });
    expect(
      makeRunProofResult({
        contract: conditional.contract,
        observedTargetDigest: targetDigest,
        recordedBy,
        results: [
          {
            claimId: conditional.claimId,
            reason: "Condition did not apply.",
            status: "not-applicable",
          },
        ],
        supplementalProtocolEvidence: [],
      }).results[0]?.status
    ).toBe("not-applicable");

    const judgment = contractWithClaim({
      kind: "human-judgment",
      requirement: "required",
    });
    expect(
      makeRunProofResult({
        contract: judgment.contract,
        observedTargetDigest: targetDigest,
        recordedBy,
        results: [
          {
            claimId: judgment.claimId,
            reason: "A human outcome decision is required.",
            requiredAuthority: "human",
            status: "requires-decision",
          },
        ],
        supplementalProtocolEvidence: [],
      }).aggregate
    ).toBe("awaiting-outcome-decision");

    expect(() =>
      makeRunProofResult({
        contract: fixture.contract,
        observedTargetDigest: targetDigest,
        recordedBy,
        results: [
          {
            claimId: fixture.claimId,
            evidence: [
              {
                artifactPath: "browser.json",
                contentDigest: "6".repeat(64),
                kind: "browser",
              },
            ],
            status: "passed",
          },
        ],
        supplementalProtocolEvidence: [],
      })
    ).toThrow(/incompatible/iu);
  });

  it("rejects duplicate evidence tuples and keeps marker evidence supplemental", () => {
    const fixture = contractWithRequiredClaim();
    const evidence = {
      artifactPath: "worker-result.json",
      contentDigest: "7".repeat(64),
      kind: "command" as const,
    };
    expect(() =>
      makeRunProofResult({
        contract: fixture.contract,
        observedTargetDigest: targetDigest,
        recordedBy: { runId, sequence: 12, type: "RUN_PROOF_RESULT_RECORDED" },
        results: [
          {
            claimId: fixture.claimId,
            evidence: [evidence, evidence],
            status: "passed",
          },
        ],
        supplementalProtocolEvidence: [],
      })
    ).toThrow(/Duplicate proof evidence (ID|tuple)/iu);

    const zero = makeRunContract({
      acceptedOutcomes: [],
      baseDigest,
      baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
      nonGoals: [],
      proofClaims: [],
      runId,
      stopConditions: [],
      targetDigest,
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });
    const markerOnly = makeRunProofResult({
      contract: zero,
      observedTargetDigest: targetDigest,
      recordedBy: { runId, sequence: 13, type: "RUN_PROOF_RESULT_RECORDED" },
      results: [],
      supplementalProtocolEvidence: [
        {
          artifactPath: "workspace/output.txt",
          contentDigest: "8".repeat(64),
          kind: "framework-output-marker",
        },
      ],
    });
    expect(markerOnly.aggregate).toBe("completed-unverified");
    expect(zero.proofClaims).toHaveLength(0);
    expect(markerOnly.supplementalProtocolEvidence).toHaveLength(1);
  });

  it("hashes a canonical structural manifest and changes on kind/path/content drift", () => {
    const first = workspaceStructuralDigestV1({
      entries: [
        {
          contentDigest: "a".repeat(64),
          kind: "regular-file",
          path: "src/a.ts",
          sizeBytes: "1",
        },
      ],
      version: 1,
    });
    const renamed = workspaceStructuralDigestV1({
      entries: [
        {
          contentDigest: "a".repeat(64),
          kind: "regular-file",
          path: "src/b.ts",
          sizeBytes: "1",
        },
      ],
      version: 1,
    });
    const changed = workspaceStructuralDigestV1({
      entries: [
        {
          contentDigest: "b".repeat(64),
          kind: "regular-file",
          path: "src/a.ts",
          sizeBytes: "1",
        },
      ],
      version: 1,
    });
    const resized = workspaceStructuralDigestV1({
      entries: [
        {
          contentDigest: "a".repeat(64),
          kind: "regular-file",
          path: "src/a.ts",
          sizeBytes: "2",
        },
      ],
      version: 1,
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(renamed).not.toBe(first);
    expect(changed).not.toBe(first);
    expect(resized).not.toBe(first);
    expect(() =>
      workspaceStructuralDigestV1({
        entries: [
          {
            contentDigest: "a".repeat(64),
            kind: "regular-file",
            path: "src/b.ts",
            sizeBytes: "1",
          },
          {
            contentDigest: "a".repeat(64),
            kind: "regular-file",
            path: "src/a.ts",
            sizeBytes: "1",
          },
        ],
        version: 1,
      })
    ).toThrow();
    expect(() =>
      workspaceStructuralDigestV1({
        entries: [
          {
            contentDigest: "a".repeat(64),
            kind: "symlink",
            path: "src/a.ts",
            sizeBytes: "1",
          },
        ],
        version: 1,
      })
    ).toThrow();
  });
});

describe("run proof replay migration", () => {
  it("replays literal legacy verification as no-contract unverified", () => {
    const replay = replayRunEvents(
      lifecycleEvents().concat(
        makeRunEvent({
          payload: { verificationResultPath: "verification-result.json" },
          runId,
          sequence: 6,
          timestamp: "2026-07-20T00:00:05.000Z",
          type: "VERIFICATION_COMPLETED",
        })
      )
    );

    expect(replay.context.runProof).toMatchObject({
      aggregate: "completed-unverified",
      kind: "no-contract",
      legacyVerification: {
        recordedBy: { sequence: 6, type: "VERIFICATION_COMPLETED" },
      },
    });
  });

  it("rejects mixed legacy and contract-bound histories", () => {
    const contract = makeRunContract({
      acceptedOutcomes: [],
      baseDigest,
      baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
      nonGoals: [],
      proofClaims: [],
      runId,
      stopConditions: [],
      targetDigest,
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });
    const events = lifecycleEvents().concat(
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 6,
        timestamp: "2026-07-20T00:00:05.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { contract: encodeRunContractJson(contract) },
        runId,
        sequence: 7,
        timestamp: "2026-07-20T00:00:06.000Z",
        type: "RUN_CONTRACT_RECORDED",
      })
    );

    expect(() => replayRunEvents(events)).toThrow(/cannot mix/iu);
  });

  it("rejects a first contract recorded after worker execution begins", () => {
    const contract = makeRunContract({
      acceptedOutcomes: [],
      baseDigest,
      baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
      nonGoals: [],
      proofClaims: [],
      runId,
      stopConditions: [],
      targetDigest,
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });
    const events = lifecycleEvents()
      .slice(0, 3)
      .concat(
        makeRunEvent({
          payload: { contract: encodeRunContractJson(contract) },
          runId,
          sequence: 4,
          timestamp: "2026-07-20T00:00:03.000Z",
          type: "RUN_CONTRACT_RECORDED",
        })
      );

    expect(() => replayRunEvents(events)).toThrow(/before worker execution/iu);
  });
});

function lifecycleEvents() {
  return [
    makeRunEvent({
      payload: { specPath: "input.md" },
      runId,
      sequence: 1,
      timestamp: "2026-07-20T00:00:00.000Z",
      type: "RUN_CREATED",
    }),
    makeRunEvent({
      payload: { workspacePath: "workspace" },
      runId,
      sequence: 2,
      timestamp: "2026-07-20T00:00:01.000Z",
      type: "WORKSPACE_PREPARED",
    }),
    makeRunEvent({
      runId,
      sequence: 3,
      timestamp: "2026-07-20T00:00:02.000Z",
      type: "WORKER_STARTED",
    }),
    makeRunEvent({
      payload: { workerResultPath: "worker-result.json" },
      runId,
      sequence: 4,
      timestamp: "2026-07-20T00:00:03.000Z",
      type: "WORKER_COMPLETED",
    }),
    makeRunEvent({
      runId,
      sequence: 5,
      timestamp: "2026-07-20T00:00:04.000Z",
      type: "VERIFICATION_STARTED",
    }),
  ];
}

function contractWithRequiredClaim() {
  return contractWithClaim({ kind: "command", requirement: "required" });
}

function contractWithClaim(input: {
  readonly kind:
    | "artifact-integrity"
    | "command"
    | "browser"
    | "external-check"
    | "human-judgment";
  readonly requirement: "required" | "conditional";
}) {
  const outcomeStatement = "The requested outcome is present.";
  const claimStatement = `Verify the requested ${input.kind} outcome.`;
  const outcomeSource = source("acceptanceCriteria", outcomeStatement);
  const claimSource = source("verificationChecks", claimStatement);
  const authorityRequirements =
    input.kind === "human-judgment"
      ? (["human"] as const)
      : input.kind === "browser"
        ? (["browser"] as const)
        : (["harness"] as const);
  const claimId = deriveProofClaimId({
    authorityRequirements,
    kind: input.kind,
    requirement: input.requirement,
    source: claimSource,
    statement: claimStatement,
  });
  const contract = makeRunContract({
    acceptedOutcomes: [
      {
        conditionalClaimIds:
          input.requirement === "conditional" ? [claimId] : [],
        outcomeId: deriveAcceptedOutcomeId({
          source: outcomeSource,
          statement: outcomeStatement,
        }),
        requiredClaimIds: input.requirement === "required" ? [claimId] : [],
        source: outcomeSource,
        statement: outcomeStatement,
      },
    ],
    baseDigest,
    baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
    nonGoals: [],
    proofClaims: [
      {
        authorityRequirements,
        claimId,
        kind: input.kind,
        requirement: input.requirement,
        source: claimSource,
        statement: claimStatement,
      },
    ],
    runId,
    stopConditions: [],
    targetDigest,
    targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
  });
  return { claimId, contract };
}

function passedResult(claimId: ReturnType<typeof deriveProofClaimId>) {
  return {
    claimId,
    evidence: [
      {
        artifactPath: "worker-result.json",
        contentDigest: "5".repeat(64),
        kind: "command" as const,
      },
    ],
    status: "passed" as const,
  };
}

function contractInput(contract: ReturnType<typeof makeRunContract>) {
  return {
    acceptedOutcomes: contract.acceptedOutcomes.map((item) => ({ ...item })),
    baseDigest: contract.baseDigest,
    baseIdentity: contract.baseIdentity,
    baseObservation: contract.baseObservation,
    nonGoals: contract.nonGoals.map((item) => ({ ...item })),
    proofClaims: contract.proofClaims.map((item) => ({ ...item })),
    runId: contract.runId,
    stopConditions: contract.stopConditions.map((item) => ({ ...item })),
    targetDigest: contract.targetDigest,
    targetIdentity: contract.targetIdentity,
    targetObservation: contract.targetObservation,
  };
}
