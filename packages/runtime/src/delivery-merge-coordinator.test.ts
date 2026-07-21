import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodePath, NodeServices } from "@effect/platform-node";
import {
  DeliveryFeedbackTrustPolicyV1,
  DeliveryGitShaPublicSchema,
  DeliverySha256DigestPublicSchema,
  DeliveryMergeDispatchAttempted,
  DeliveryMergeIntent,
  DeliveryMergeReadinessDecisionV3,
  DeliveryGitHubApprovedReviewSource,
  DeliveryReviewApprovalNotRequiredSource,
  DeliveryMergeTerminalFailure,
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationIntent,
  DeliveryPullRequestReadyDispatchConfirmed,
  DeliveryPullRequestReadyDispatchAttempted,
  DeliveryPullRequestReadyConfirmedWithoutDispatch,
  DeliveryPullRequestReadyIntent,
  DeliveryRemediationCommitAttempted,
  DeliveryRemediationConfirmed,
  DeliveryRemediationDispatchAttempted,
  DeliveryRemediationIntent,
  DeliveryRemediationPushAttempted,
  DeliveryRemediationTurnCompleted,
  DeliveryRemediationVerified,
  RunEvent,
  deliveryRequiredCheckPolicyCanonicalPayload,
  deliveryMergeReadinessDecisionV3PayloadDigest,
  deliveryPullRequestReadyCanonicalPayload,
  deliveryPullRequestReadyPayloadDigest,
  encodeDeliveryMergeReadinessDecisionJson,
  encodeDeliveryMergeReceiptJson,
  encodeMergeDecisionV2Json,
  encodeAnyRunContractJson,
  encodeAnyRunProofResultJson,
  encodeRunContractJson,
  encodeRunProofResultJson,
  encodeDeliveryPublicationJson,
  encodeDeliveryPullRequestReadyReceiptJson,
  encodeDeliveryRemediationJson,
  makeRunEvent,
  makeMergeDecisionV2,
  makeRunContract,
  makeRunContractV2,
  makeRunProofResult,
  makeRunProofResultV2,
  makeProofEvidenceIdV2,
  makeVerificationCommandRequestDigest,
  MergeDecisionBlockerV2,
  deriveAcceptedOutcomeId,
  deriveExplicitSpecItemDigest,
  deriveProofClaimId,
  parseDeliveryPullRequestReadyReceipt,
  parseDeliveryFeedbackId,
  parseRunId,
  parseRunEventSequence,
  parseRunRelativeArtifactPath,
  workspaceStructuralDigestV1,
  MergeDecisionPayloadDigestSchema,
  parseMarkdownSpec,
  ProofClaimResultV2Schema,
} from "@gaia/core";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  coordinateDeliveryMerge,
  coordinateDeliveryMergeReadiness,
  normalizeGitHubReviewDecision,
  requiredCheckPolicyFromTrustPolicy,
  type FreshMergeState,
} from "./delivery-merge-coordinator.js";
import { defaultDeliveryFeedbackTrustPolicy } from "./delivery-remediation-coordinator.js";
import { coordinateDeliveryLocalReviewAttestation } from "./delivery-review-attestation-coordinator.js";
import { GaiaRuntimeError } from "./errors.js";
import { loadRun } from "./event-store.js";
import { makeRunPaths } from "./paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

function fixture(
  state: "ready" | "attempted" | "checkpoint" | "unknown",
  requireApprovedReview?: boolean,
  readyHeadSha = "a".repeat(40),
  proofVersion: 1 | 2 = 1
) {
  const root = mkdtempSync(path.join(tmpdir(), "gaia-merge-restart-"));
  roots.push(root);
  const runId = parseRunId("run-1234567890");
  const paths = Effect.runSync(
    makeRunPaths(runId, { rootDirectory: root }).pipe(
      Effect.provide(NodePath.layer)
    )
  );
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(paths.snapshots, "");
  const structuralDigest = workspaceStructuralDigestV1({
    entries: [],
    version: 1,
  });
  const outcomeStatement = "The delivery is acceptable.";
  const claimStatement = "Inspect the delivery result.";
  const specDigest = "3".repeat(64);
  const outcomeSource = {
    itemDigest: deriveExplicitSpecItemDigest({
      section: "acceptanceCriteria",
      statement: outcomeStatement,
    }),
    kind: "explicitSpecItem" as const,
    section: "acceptanceCriteria" as const,
    specDigest,
    version: 1 as const,
  };
  const claimSource = {
    itemDigest: deriveExplicitSpecItemDigest({
      section: "verificationChecks",
      statement: claimStatement,
    }),
    kind: "explicitSpecItem" as const,
    section: "verificationChecks" as const,
    specDigest,
    version: 1 as const,
  };
  const claimId = deriveProofClaimId({
    authorityRequirements: ["gaia-runtime"],
    kind: "command",
    requirement: "required",
    source: claimSource,
    statement: claimStatement,
  });
  const contractV1 = makeRunContract({
    acceptedOutcomes: [
      {
        conditionalClaimIds: [],
        outcomeId: deriveAcceptedOutcomeId({
          source: outcomeSource,
          statement: outcomeStatement,
        }),
        requiredClaimIds: [claimId],
        source: outcomeSource,
        statement: outcomeStatement,
      },
    ],
    baseDigest: structuralDigest,
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
    targetDigest: structuralDigest,
    targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
  });
  const proofV1 = makeRunProofResult({
    contract: contractV1,
    observedTargetDigest: structuralDigest,
    recordedBy: {
      runId,
      sequence: 6,
      type: "RUN_PROOF_RESULT_RECORDED",
    },
    results: [
      {
        claimId,
        evidence: [
          {
            artifactPath: "worker-result.json",
            contentDigest: "4".repeat(64),
            kind: "command",
          },
        ],
        status: "passed",
      },
    ],
    supplementalProtocolEvidence: [],
  });
  const contractV2 = makeRunContractV2({
    baseDigest: structuralDigest,
    baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
    runId,
    spec: parseMarkdownSpec(
      readFileSync(
        new URL(
          "../../../examples/specs/claim-verification-v2.md",
          import.meta.url
        ),
        "utf8"
      ),
      "fallback"
    ),
    targetDigest: structuralDigest,
    targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
  });
  const proofV2 = makeRunProofResultV2({
    contentAuthoritySequence: 5,
    contract: contractV2,
    observedTargetDigest: structuralDigest,
    recordedBy: {
      runId,
      sequence: 6,
      type: "RUN_PROOF_RESULT_RECORDED",
    },
    results: Schema.decodeUnknownSync(Schema.Array(ProofClaimResultV2Schema))(
      contractV2.proofClaims.map((claim) => {
        if (claim.kind === "command") {
          const receiptDigest = "4".repeat(64);
          return {
            claimId: claim.claimId,
            evidence: [
              {
                evidenceId: makeProofEvidenceIdV2("command", [receiptDigest]),
                kind: "command" as const,
                receiptDigest,
                requestDigest: makeVerificationCommandRequestDigest(
                  claim.command
                ),
                status: "succeeded" as const,
                terminalSequence: 6,
              },
            ],
            status: "passed" as const,
          };
        }
        if (claim.kind === "external-check") {
          const eventSequence = 6;
          return {
            claimId: claim.claimId,
            evidence: [
              {
                ...claim.selector,
                evidenceId: makeProofEvidenceIdV2("external-check", [
                  claim.claimId,
                  eventSequence,
                ]),
                eventSequence,
                headSha: "a".repeat(40),
                kind: "external-check" as const,
              },
            ],
            status: "passed" as const,
          };
        }
        if (claim.kind === "human-judgment") {
          const eventSequence = 6;
          return {
            claimId: claim.claimId,
            evidence: [
              {
                ...claim.selector,
                evidenceId: makeProofEvidenceIdV2("human", [
                  claim.claimId,
                  eventSequence,
                ]),
                eventSequence,
                headSha: "a".repeat(40),
                kind: "human-judgment" as const,
              },
            ],
            status: "passed" as const,
          };
        }
        return {
          claimId: claim.claimId,
          reason: "Unexpected claim kind in the dedicated V2 fixture.",
          status: "not-run" as const,
        };
      })
    ),
  });
  const contract = proofVersion === 2 ? contractV2 : contractV1;
  const proof = proofVersion === 2 ? proofV2 : proofV1;
  const trust = DeliveryFeedbackTrustPolicyV1.make({
    ...defaultDeliveryFeedbackTrustPolicy("cill-i-am/gaia"),
    ...(requireApprovedReview === undefined ? {} : { requireApprovedReview }),
  });
  const policyDigest = createHash("sha256")
    .update(
      deliveryRequiredCheckPolicyCanonicalPayload(
        requiredCheckPolicyFromTrustPolicy(trust)
      )
    )
    .digest("hex");
  const publicationBase = {
    baseBranch: "main",
    baseRevision: "0".repeat(40),
    branchName: "gaia/run-1234567890",
    commitMessage: "feat: delivery",
    commitTimestamp: "2026-07-11T19:00:00.000Z",
    digestVersion: 1 as const,
    operationId: "delivery:run-1234567890:1",
    payloadDigest: "1".repeat(64),
    sourcePaths: ["feature.ts"],
    treeSha: "2".repeat(40),
  };
  const pubIntent = DeliveryPublicationIntent.make({
    ...publicationBase,
    state: "intentRecorded",
  });
  const pubAttempt = DeliveryPublicationAttempted.make({
    ...publicationBase,
    commitSha: "a".repeat(40),
    state: "attempted",
  });
  const publication = DeliveryPublicationConfirmed.make({
    ...pubAttempt,
    draft: true,
    headSha: "a".repeat(40),
    prNumber: 74,
    prUrl: "https://github.com/cill-i-am/gaia/pull/74",
    state: "confirmed",
  });
  const readyBase = {
    actionId: "ready-1",
    branchName: publication.branchName,
    expectedHeadSha: readyHeadSha,
    prNumber: 74,
    prUrl: publication.prUrl,
    publicationOperationId: publication.operationId,
    publicationPayloadDigest: publication.payloadDigest,
    repository: "cill-i-am/gaia",
    runId,
    version: 1 as const,
  };
  const readyBinding = {
    ...readyBase,
    payloadDigest: createHash("sha256")
      .update(deliveryPullRequestReadyCanonicalPayload(readyBase))
      .digest("hex"),
  };
  const readyIntent = DeliveryPullRequestReadyIntent.make({
    ...readyBinding,
    state: "intentRecorded",
  });
  const readyAttempted = DeliveryPullRequestReadyDispatchAttempted.make({
    ...readyBinding,
    state: "dispatchAttempted",
  });
  const readyConfirmed = DeliveryPullRequestReadyDispatchConfirmed.make({
    ...readyBinding,
    draft: false,
    state: "dispatchConfirmed",
  });
  const binding = {
    actionId: "merge-1",
    branchName: publication.branchName,
    decisionSequence: 16,
    expectedHeadSha: publication.headSha,
    mergeMethod: "merge" as const,
    payloadDigest: createHash("sha256")
      .update(
        [
          "merge-1",
          runId,
          publication.prUrl,
          publication.branchName,
          publication.headSha,
          "16",
          "merge",
          policyDigest,
        ].join("\0")
      )
      .digest("hex"),
    policyDigest,
    policyVersion: 1 as const,
    prNumber: 74,
    prUrl: publication.prUrl,
    repository: "cill-i-am/gaia",
  };
  const decisionProof = {
    contractDigest: proof.contractDigest,
    contractId: proof.contractId,
    kind: "contract" as const,
    result: {
      aggregate: "verified" as const,
      kind: "recorded" as const,
      observedTargetDigest: proof.observedTargetDigest,
      resultDigest: proof.resultDigest,
      sequence: proof.recordedBy.sequence,
    },
  };
  const mergeDecision = makeMergeDecisionV2({
    blockerCount: 0,
    blockers: [],
    contentAuthoritySequence: parseRunEventSequence(5),
    decidedAt: "2026-07-11T19:00:12.000Z",
    evidenceReviewPath: parseRunRelativeArtifactPath("evidence-review.md"),
    evidenceReviewSequence: parseRunEventSequence(8),
    evidenceReviewerSessionPath: parseRunRelativeArtifactPath(
      "evidence-reviewer-session.json"
    ),
    nextAction: "ready-to-merge",
    planReviewPath: parseRunRelativeArtifactPath("plan-review.md"),
    planReviewerSessionPath: parseRunRelativeArtifactPath(
      "plan-reviewer-session.json"
    ),
    pr: "74",
    proof: decisionProof,
    publicationConfirmationSequence: parseRunEventSequence(11),
    runId,
    runProfilePath: parseRunRelativeArtifactPath("run-profile.json"),
    status: "approved",
    version: 2,
  });
  const decisionBase = {
    actionId: "readiness-1",
    approved: true,
    approvalSource:
      requireApprovedReview === false
        ? DeliveryReviewApprovalNotRequiredSource.make({
            kind: "notRequired",
            version: 1,
          })
        : DeliveryGitHubApprovedReviewSource.make({
            kind: "githubApproved",
            reviewDecision: "APPROVED",
            version: 1,
          }),
    authoritySequence: parseRunEventSequence(11),
    blockers: [],
    branchName: binding.branchName,
    contentAuthoritySequence: parseRunEventSequence(5),
    contractDigest: proof.contractDigest,
    contractId: proof.contractId,
    evidenceReviewSequence: parseRunEventSequence(8),
    headSha: binding.expectedHeadSha,
    mergeDecisionPayloadDigest: mergeDecision.payloadDigest,
    mergeDecisionSequence: parseRunEventSequence(15),
    mergeMethod: binding.mergeMethod,
    policyDigest,
    policyVersion: 1 as const,
    prNumber: 74,
    prUrl: binding.prUrl,
    observedTargetDigest: proof.observedTargetDigest,
    proofAggregate: "verified" as const,
    proofResultDigest: proof.resultDigest,
    proofResultSequence: proof.recordedBy.sequence,
    publicationConfirmationSequence: parseRunEventSequence(11),
    publicationOperationId: publication.operationId,
    publicationPayloadDigest: publication.payloadDigest,
    repository: binding.repository,
    runId,
    version: 3 as const,
  };
  const decision = DeliveryMergeReadinessDecisionV3.make({
    ...decisionBase,
    payloadDigest: deliveryMergeReadinessDecisionV3PayloadDigest(decisionBase),
  });
  const intent = DeliveryMergeIntent.make({
    ...binding,
    state: "intentRecorded",
  });
  const attempted = DeliveryMergeDispatchAttempted.make({
    ...binding,
    state: "dispatchAttempted",
  });
  const event = (
    sequence: number,
    type: Parameters<typeof makeRunEvent>[0]["type"],
    payload: Readonly<Record<string, Schema.Json>>
  ) =>
    makeRunEvent({
      payload,
      runId,
      sequence,
      timestamp: `2026-07-11T19:00:${String(sequence).padStart(2, "0")}.000Z`,
      type,
    });
  const events = [
    event(1, "RUN_CREATED", { specPath: "spec.md" }),
    event(2, "DELIVERY_STARTED", {
      delivery: {
        baseBranch: "main",
        baseRevision: "0".repeat(40),
        feedbackTrustPolicy: Schema.encodeSync(DeliveryFeedbackTrustPolicyV1)(
          trust
        ),
        headBranch: publication.branchName,
        mode: "pullRequest",
        remote: "origin",
        stage: "delivering",
      },
    }),
    event(3, "RUN_CONTRACT_RECORDED", {
      contract: encodeAnyRunContractJson(contract),
    }),
    event(4, "WORKSPACE_PREPARED", { workspacePath: "workspace" }),
    event(5, "WORKER_COMPLETED", {
      workerResultPath: "worker-result.json",
    }),
    event(6, "RUN_PROOF_RESULT_RECORDED", {
      result: encodeAnyRunProofResultJson(proof),
      verificationResultPath: "verification-result.json",
    }),
    event(7, "DELIVERY_READY_TO_PUBLISH", {
      delivery: {
        baseBranch: "main",
        baseRevision: "0".repeat(40),
        feedbackTrustPolicy: Schema.encodeSync(DeliveryFeedbackTrustPolicyV1)(
          trust
        ),
        headBranch: publication.branchName,
        mode: "pullRequest",
        remote: "origin",
        stage: "readyToPublish",
      },
      reportPath: "report.md",
    }),
    event(8, "REVIEW_COMPLETED", {
      phase: "evidence",
      reviewPath: "evidence-review.md",
    }),
    event(9, "DELIVERY_PUBLICATION_INTENT_RECORDED", {
      publication: encodeDeliveryPublicationJson(pubIntent),
    }),
    event(10, "DELIVERY_PUBLICATION_ATTEMPTED", {
      publication: encodeDeliveryPublicationJson(pubAttempt),
    }),
    event(11, "DELIVERY_PUBLICATION_CONFIRMED", {
      publication: encodeDeliveryPublicationJson(publication),
    }),
    event(12, "DELIVERY_PR_READY_RECORDED", {
      readyForReviewAction:
        encodeDeliveryPullRequestReadyReceiptJson(readyIntent),
    }),
    event(13, "DELIVERY_PR_READY_RECORDED", {
      readyForReviewAction:
        encodeDeliveryPullRequestReadyReceiptJson(readyAttempted),
    }),
    event(14, "DELIVERY_PR_READY_RECORDED", {
      readyForReviewAction:
        encodeDeliveryPullRequestReadyReceiptJson(readyConfirmed),
    }),
    event(15, "MERGE_DECISION_RECORDED", {
      decision: encodeMergeDecisionV2Json(mergeDecision),
      mergeDecisionPath: "merge-decision.json",
    }),
    event(16, "DELIVERY_MERGE_READINESS_RECORDED", {
      decision: encodeDeliveryMergeReadinessDecisionJson(decision),
    }),
    ...(state === "ready"
      ? []
      : [
          event(17, "DELIVERY_MERGE_RECORDED", {
            mergeAction: encodeDeliveryMergeReceiptJson(intent),
          }),
          event(18, "DELIVERY_MERGE_RECORDED", {
            mergeAction: encodeDeliveryMergeReceiptJson(attempted),
          }),
        ]),
    ...(state === "checkpoint"
      ? [
          event(19, "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED", {
            checkpoint: {
              actionId: binding.actionId,
              payloadDigest: binding.payloadDigest,
              state: "attemptRecorded",
              version: 1,
            },
          }),
        ]
      : []),
    ...(state === "unknown"
      ? [
          event(19, "DELIVERY_MERGE_RECORDED", {
            mergeAction: encodeDeliveryMergeReceiptJson(
              DeliveryMergeTerminalFailure.make({
                ...binding,
                code: "DeliveryMergeOutcomeUnknown",
                message: "ambiguous",
                state: "outcomeUnknown",
              })
            ),
          }),
        ]
      : []),
  ];
  writeFileSync(
    paths.events,
    `${events.map((value) => JSON.stringify(Schema.encodeSync(RunEvent)(value))).join("\n")}\n`
  );
  const action = {
    actionId: binding.actionId,
    expectedBranchName: binding.branchName,
    expectedDecisionSequence: 16,
    expectedHeadSha: binding.expectedHeadSha,
    expectedPolicyDigest: policyDigest,
    expectedPrUrl: binding.prUrl,
    kind: "merge" as const,
    mergeMethod: "merge" as const,
  };
  return {
    action,
    binding,
    claimId,
    contract,
    contractV1,
    decisionProof,
    mergeDecision,
    paths,
    proof,
    proofV1,
    readinessDecision: decision,
    root,
    runId,
  };
}

type InterveningAuthority =
  | "content remediation"
  | "newer blocked V2"
  | "newer evidence review"
  | "newer proof result"
  | "newer publication";

function insertAuthorityBeforeReadiness(
  result: ReturnType<typeof fixture>,
  authority: InterveningAuthority
) {
  const events = readFileSync(result.paths.events, "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(RunEvent)(JSON.parse(line)));
  const readinessIndex = events.findIndex(
    ({ type }) => type === "DELIVERY_MERGE_READINESS_RECORDED"
  );
  if (readinessIndex < 0)
    throw new Error("Expected a merge-readiness event in the fixture.");
  const readiness = events[readinessIndex];
  if (readiness === undefined)
    throw new Error("Expected a merge-readiness event in the fixture.");
  const nextSequence = readiness.sequence;
  const event = (
    offset: number,
    type: Parameters<typeof makeRunEvent>[0]["type"],
    payload: Readonly<Record<string, Schema.Json>>
  ) =>
    makeRunEvent({
      payload,
      runId: result.runId,
      sequence: nextSequence + offset,
      timestamp: `2026-07-11T20:00:${String(offset).padStart(2, "0")}.000Z`,
      type,
    });

  const inserted = (() => {
    switch (authority) {
      case "newer proof result": {
        const proof = makeRunProofResult({
          contract: result.contractV1,
          observedTargetDigest: result.proofV1.observedTargetDigest,
          recordedBy: {
            runId: result.runId,
            sequence: nextSequence,
            type: "RUN_PROOF_RESULT_RECORDED",
          },
          results: [
            {
              claimId: result.claimId,
              evidence: [
                {
                  artifactPath: "worker-result.json",
                  contentDigest: "4".repeat(64),
                  kind: "command",
                },
              ],
              status: "passed",
            },
          ],
          supplementalProtocolEvidence: [],
        });
        return [
          event(0, "RUN_PROOF_RESULT_RECORDED", {
            result: encodeRunProofResultJson(proof),
            verificationResultPath: "verification-result.json",
          }),
        ];
      }
      case "newer blocked V2": {
        const blocker = MergeDecisionBlockerV2.make({
          action: "Record current proof and review evidence.",
          kind: "run-proof-stale",
          summary: "The prior approved merge decision is stale.",
        });
        const decision = makeMergeDecisionV2({
          blockerCount: 1,
          blockers: [blocker],
          contentAuthoritySequence: parseRunEventSequence(1),
          decidedAt: "2026-07-11T20:00:00.000Z",
          evidenceReviewPath:
            parseRunRelativeArtifactPath("evidence-review.md"),
          evidenceReviewerSessionPath: parseRunRelativeArtifactPath(
            "evidence-reviewer-session.json"
          ),
          nextAction: "resolve-blockers",
          planReviewPath: parseRunRelativeArtifactPath("plan-review.md"),
          planReviewerSessionPath: parseRunRelativeArtifactPath(
            "plan-reviewer-session.json"
          ),
          pr: "74",
          proof: result.decisionProof,
          runId: result.runId,
          runProfilePath: parseRunRelativeArtifactPath("run-profile.json"),
          status: "blocked",
          version: 2,
        });
        return [
          event(0, "MERGE_DECISION_RECORDED", {
            decision: encodeMergeDecisionV2Json(decision),
            mergeDecisionPath: "merge-decision.json",
          }),
        ];
      }
      case "content remediation": {
        const remediation = DeliveryRemediationIntent.make({
          attempt: 1,
          commitTimestamp: "2026-07-11T20:00:00.000Z",
          expectedHeadSha: result.binding.expectedHeadSha,
          feedbackDigest: "e".repeat(64),
          feedbackIds: [
            parseDeliveryFeedbackId(`feedback-comment-${"f".repeat(64)}`),
          ],
          inputId: "remediation-run-1234567890-1",
          operationId: "remediation:run-1234567890:1",
          state: "intentRecorded",
        });
        return [
          event(0, "DELIVERY_REMEDIATION_RECORDED", {
            remediation: encodeDeliveryRemediationJson(remediation),
          }),
        ];
      }
      case "newer evidence review":
        return [
          event(0, "REVIEW_COMPLETED", {
            phase: "evidence",
            reviewPath: "evidence-review-2.md",
          }),
        ];
      case "newer publication": {
        const confirmed = events.findLast(
          ({ type }) => type === "DELIVERY_PUBLICATION_CONFIRMED"
        );
        if (confirmed?.type !== "DELIVERY_PUBLICATION_CONFIRMED")
          throw new Error("Expected confirmed publication in the fixture.");
        return [event(0, "DELIVERY_PUBLICATION_CONFIRMED", confirmed.payload)];
      }
    }
  })();
  const shiftedReadiness = makeRunEvent({
    payload: readiness.payload,
    runId: readiness.runId,
    sequence: readiness.sequence + inserted.length,
    timestamp: readiness.timestamp,
    type: readiness.type,
  });
  const next = [
    ...events.slice(0, readinessIndex),
    ...inserted,
    shiftedReadiness,
  ];
  writeFileSync(
    result.paths.events,
    `${next.map((value) => JSON.stringify(Schema.encodeSync(RunEvent)(value))).join("\n")}\n`
  );
}

function appendAuthorityAfterReadiness(
  result: ReturnType<typeof fixture>,
  authority: "content remediation" | "evidence review" | "proof result"
) {
  const events = readFileSync(result.paths.events, "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(RunEvent)(JSON.parse(line)));
  const sequence = events.length + 1;
  const next =
    authority === "proof result"
      ? makeRunEvent({
          payload: {
            result: encodeRunProofResultJson(
              makeRunProofResult({
                contract: result.contractV1,
                observedTargetDigest: result.proofV1.observedTargetDigest,
                recordedBy: {
                  runId: result.runId,
                  sequence,
                  type: "RUN_PROOF_RESULT_RECORDED",
                },
                results: [
                  {
                    claimId: result.claimId,
                    reason: "A newer proof pass has not run the claim.",
                    status: "not-run",
                  },
                ],
                supplementalProtocolEvidence: [],
              })
            ),
            verificationResultPath: "verification-result-2.json",
          },
          runId: result.runId,
          sequence,
          timestamp: "2026-07-11T20:01:00.000Z",
          type: "RUN_PROOF_RESULT_RECORDED",
        })
      : authority === "evidence review"
        ? makeRunEvent({
            payload: {
              phase: "evidence",
              reviewPath: "evidence-review-2.md",
            },
            runId: result.runId,
            sequence,
            timestamp: "2026-07-11T20:01:00.000Z",
            type: "REVIEW_COMPLETED",
          })
        : makeRunEvent({
            payload: {
              remediation: encodeDeliveryRemediationJson(
                DeliveryRemediationIntent.make({
                  attempt: 1,
                  commitTimestamp: "2026-07-11T20:01:00.000Z",
                  expectedHeadSha: result.binding.expectedHeadSha,
                  feedbackDigest: "e".repeat(64),
                  feedbackIds: [
                    parseDeliveryFeedbackId(
                      `feedback-comment-${"f".repeat(64)}`
                    ),
                  ],
                  inputId: "remediation-run-1234567890-1",
                  operationId: "remediation:run-1234567890:1",
                  state: "intentRecorded",
                })
              ),
            },
            runId: result.runId,
            sequence,
            timestamp: "2026-07-11T20:01:00.000Z",
            type: "DELIVERY_REMEDIATION_RECORDED",
          });
  writeFileSync(
    result.paths.events,
    `${[...events, next].map((value) => JSON.stringify(Schema.encodeSync(RunEvent)(value))).join("\n")}\n`
  );
}

function retainedPreReadyFixture() {
  const result = fixture("attempted");
  const eventsPath = path.join(
    result.root,
    ".gaia",
    "runs",
    result.runId,
    "events.jsonl"
  );
  const retained = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(RunEvent)(JSON.parse(line)))
    .filter(({ type }) => type !== "DELIVERY_PR_READY_RECORDED")
    .map((event, index) =>
      makeRunEvent({
        payload: event.payload,
        runId: event.runId,
        sequence: index + 1,
        timestamp: event.timestamp,
        type: event.type,
      })
    );
  writeFileSync(
    eventsPath,
    `${retained.map((event) => JSON.stringify(Schema.encodeSync(RunEvent)(event))).join("\n")}\n`
  );
  return result;
}

function corruptReadyReceipts(
  result: ReturnType<typeof fixture>,
  corruption: "digest" | "publication generation" | "pull request tuple"
) {
  const eventsPath = path.join(
    result.root,
    ".gaia",
    "runs",
    result.runId,
    "events.jsonl"
  );
  const events = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(RunEvent)(JSON.parse(line)))
    .map((event) => {
      if (event.type !== "DELIVERY_PR_READY_RECORDED") return event;
      const receipt = parseDeliveryPullRequestReadyReceipt(
        event.payload["readyForReviewAction"]
      );
      const binding = {
        actionId: receipt.actionId,
        branchName: receipt.branchName,
        expectedHeadSha: receipt.expectedHeadSha,
        prNumber:
          corruption === "pull request tuple"
            ? receipt.prNumber + 1
            : receipt.prNumber,
        prUrl:
          corruption === "pull request tuple"
            ? "https://github.com/cill-i-am/gaia/pull/75"
            : receipt.prUrl,
        publicationOperationId:
          corruption === "publication generation"
            ? `${receipt.publicationOperationId}:forged`
            : receipt.publicationOperationId,
        publicationPayloadDigest: receipt.publicationPayloadDigest,
        repository: receipt.repository,
        runId: receipt.runId,
        version: receipt.version,
      };
      const changed = parseDeliveryPullRequestReadyReceipt({
        ...receipt,
        ...binding,
        payloadDigest:
          corruption === "digest"
            ? "f".repeat(64)
            : deliveryPullRequestReadyPayloadDigest(binding),
      });
      return makeRunEvent({
        payload: {
          readyForReviewAction:
            encodeDeliveryPullRequestReadyReceiptJson(changed),
        },
        runId: event.runId,
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
      });
    });
  writeFileSync(
    eventsPath,
    `${events.map((event) => JSON.stringify(Schema.encodeSync(RunEvent)(event))).join("\n")}\n`
  );
}

function corruptMergeReadinessDecision(
  result: ReturnType<typeof fixture>,
  corruption: "payload digest" | "merge-decision binding"
) {
  const eventsPath = path.join(
    result.root,
    ".gaia",
    "runs",
    result.runId,
    "events.jsonl"
  );
  const events = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(RunEvent)(JSON.parse(line)))
    .map((event) => {
      if (event.type !== "DELIVERY_MERGE_READINESS_RECORDED") return event;
      const decision = Schema.decodeUnknownSync(
        DeliveryMergeReadinessDecisionV3
      )(event.payload["decision"]);
      const changed = DeliveryMergeReadinessDecisionV3.make({
        ...decision,
        ...(corruption === "payload digest"
          ? {
              payloadDigest: Schema.decodeUnknownSync(
                DeliverySha256DigestPublicSchema
              )("f".repeat(64)),
            }
          : {
              mergeDecisionPayloadDigest: Schema.decodeUnknownSync(
                MergeDecisionPayloadDigestSchema
              )("f".repeat(64)),
            }),
      });
      return makeRunEvent({
        payload: {
          decision: encodeDeliveryMergeReadinessDecisionJson(changed),
        },
        runId: event.runId,
        sequence: event.sequence,
        timestamp: event.timestamp,
        type: event.type,
      });
    });
  writeFileSync(
    eventsPath,
    `${events.map((event) => JSON.stringify(Schema.encodeSync(RunEvent)(event))).join("\n")}\n`
  );
}

function appendConfirmedRemediation(
  result: ReturnType<typeof fixture>,
  commitSha = "b".repeat(40)
) {
  const eventsPath = path.join(
    result.root,
    ".gaia",
    "runs",
    result.runId,
    "events.jsonl"
  );
  const events = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(RunEvent)(JSON.parse(line)));
  const base = {
    attempt: 1 as const,
    commitTimestamp: "2026-07-13T07:02:00.000Z",
    expectedHeadSha: result.binding.expectedHeadSha,
    feedbackDigest: "e".repeat(64),
    feedbackIds: [
      parseDeliveryFeedbackId(`feedback-comment-${"f".repeat(64)}`),
    ],
    inputId: "remediation-run-1234567890-1",
    operationId: "remediation:run-1234567890:1",
  };
  const remediations = [
    DeliveryRemediationIntent.make({ ...base, state: "intentRecorded" }),
    DeliveryRemediationDispatchAttempted.make({
      ...base,
      state: "dispatchAttempted",
    }),
    DeliveryRemediationTurnCompleted.make({ ...base, state: "turnCompleted" }),
    DeliveryRemediationVerified.make({ ...base, state: "verified" }),
    DeliveryRemediationCommitAttempted.make({
      ...base,
      commitSha,
      state: "commitAttempted",
    }),
    DeliveryRemediationPushAttempted.make({
      ...base,
      commitSha,
      state: "pushAttempted",
    }),
    DeliveryRemediationConfirmed.make({
      ...base,
      commitSha,
      state: "confirmed",
    }),
  ];
  const next = [
    ...events,
    ...remediations.map((remediation, index) =>
      makeRunEvent({
        payload: { remediation: encodeDeliveryRemediationJson(remediation) },
        runId: result.runId,
        sequence: events.length + index + 1,
        timestamp: `2026-07-13T07:02:${String(index).padStart(2, "0")}.000Z`,
        type: "DELIVERY_REMEDIATION_RECORDED",
      })
    ),
  ];
  writeFileSync(
    eventsPath,
    `${next.map((event) => JSON.stringify(Schema.encodeSync(RunEvent)(event))).join("\n")}\n`
  );
  return commitSha;
}

function appendCurrentReadyConfirmation(
  result: ReturnType<typeof fixture>,
  expectedHeadSha: typeof DeliveryGitShaPublicSchema.Type
) {
  const eventsPath = path.join(
    result.root,
    ".gaia",
    "runs",
    result.runId,
    "events.jsonl"
  );
  const events = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(RunEvent)(JSON.parse(line)));
  const base = {
    actionId: "ready-remediated-1",
    branchName: result.binding.branchName,
    expectedHeadSha,
    prNumber: result.binding.prNumber,
    prUrl: result.binding.prUrl,
    publicationOperationId: "delivery:run-1234567890:1",
    publicationPayloadDigest: "1".repeat(64),
    repository: result.binding.repository,
    runId: result.runId,
    version: 1 as const,
  };
  const binding = {
    ...base,
    payloadDigest: deliveryPullRequestReadyPayloadDigest(base),
  };
  const receipts = [
    DeliveryPullRequestReadyIntent.make({
      ...binding,
      state: "intentRecorded",
    }),
    DeliveryPullRequestReadyConfirmedWithoutDispatch.make({
      ...binding,
      draft: false,
      state: "confirmedWithoutDispatch",
    }),
  ];
  const next = [
    ...events,
    ...receipts.map((receipt, index) =>
      makeRunEvent({
        payload: {
          readyForReviewAction:
            encodeDeliveryPullRequestReadyReceiptJson(receipt),
        },
        runId: result.runId,
        sequence: events.length + index + 1,
        timestamp: `2026-07-13T07:03:0${index}.000Z`,
        type: "DELIVERY_PR_READY_RECORDED",
      })
    ),
  ];
  writeFileSync(
    eventsPath,
    `${next.map((event) => JSON.stringify(Schema.encodeSync(RunEvent)(event))).join("\n")}\n`
  );
}

const merged = (
  binding: ReturnType<typeof fixture>["binding"]
): FreshMergeState => ({
  branchName: binding.branchName,
  checks: [],
  draft: false,
  feedbackBlockers: 0,
  headSha: binding.expectedHeadSha,
  mergeCommitSha: "d".repeat(40),
  mergeability: "mergeable",
  mergedAt: "2026-07-11T20:00:00.000Z",
  prNumber: binding.prNumber,
  prUrl: binding.prUrl,
  repository: binding.repository,
  reviewDecision: "APPROVED",
  state: "merged",
  supportedMethods: ["merge"],
  unresolvedActionableThreads: 0,
});

describe("delivery merge reconstructed coordinator", () => {
  it("replays the natural V2 proof through MergeDecisionV2 and readiness V3", async () => {
    const f = fixture("ready", false, "a".repeat(40), 2);

    const loaded = await Effect.runPromise(
      loadRun(f.paths).pipe(Effect.provide(NodeServices.layer))
    );

    expect(loaded.latestSnapshot?.context["runProof"]).toMatchObject({
      aggregate: "verified",
      version: 2,
    });
    expect(loaded.events.at(-1)?.type).toBe(
      "DELIVERY_MERGE_READINESS_RECORDED"
    );
  });

  it("rejects malformed Unicode before canonical V3 digesting", () => {
    const f = fixture("ready", false);

    expect(() =>
      deliveryMergeReadinessDecisionV3PayloadDigest({
        ...f.readinessDecision,
        blockers: ["\uD800"],
      })
    ).toThrow(/well-formed Unicode/iu);
  });

  it("satisfies strict review policy from one current exact-head local operator attestation but never overrides changes requested", async () => {
    const f = fixture("ready", true);
    const current = merged(f.binding);
    const {
      mergedAt: _mergedAt,
      mergeCommitSha: _mergeCommitSha,
      reviewDecision: _reviewDecision,
      ...openBase
    } = current;
    const open = { ...openBase, state: "open" as const };
    await Effect.runPromise(
      coordinateDeliveryLocalReviewAttestation(
        f.runId,
        {
          actionId: "paired-review-attestation-1",
          decision: "approved",
          expectedBranchName: f.binding.branchName,
          expectedHeadSha: f.binding.expectedHeadSha,
          expectedPrNumber: f.binding.prNumber,
          expectedPrUrl: f.binding.prUrl,
          kind: "attestPairedReviewApproval",
        },
        { freshStateReader: () => Effect.succeed(open), rootDirectory: f.root }
      ).pipe(Effect.provide(NodeServices.layer))
    );

    const checks = [
      {
        appSlug: "github-actions",
        headSha: f.binding.expectedHeadSha,
        name: "gaia-pr-ci",
        repository: f.binding.repository,
        state: "passing" as const,
        workflow: "Gaia PR CI",
      },
    ];
    const approved = await Effect.runPromise(
      coordinateDeliveryMergeReadiness(
        f.runId,
        {
          actionId: "readiness-local-attestation",
          kind: "evaluateMergeReadiness",
          mergeMethod: "merge",
        },
        {
          freshStateReader: () => Effect.succeed({ ...open, checks }),
          rootDirectory: f.root,
        }
      ).pipe(Effect.provide(NodeServices.layer))
    );
    expect(approved).toMatchObject({
      approved: true,
      approvalSource: { kind: "localOperatorPairedReview" },
      version: 3,
    });
    let replayReads = 0;
    const replay = await Effect.runPromise(
      coordinateDeliveryMergeReadiness(
        f.runId,
        {
          actionId: "readiness-local-attestation",
          kind: "evaluateMergeReadiness",
          mergeMethod: "merge",
        },
        {
          freshStateReader: () =>
            Effect.sync(() => {
              replayReads += 1;
              return { ...open, checks };
            }),
          rootDirectory: f.root,
        }
      ).pipe(Effect.provide(NodeServices.layer))
    );
    expect(replay.payloadDigest).toBe(approved.payloadDigest);
    expect(replayReads).toBe(0);

    const rejected = await Effect.runPromise(
      coordinateDeliveryMergeReadiness(
        f.runId,
        {
          actionId: "readiness-changes-requested",
          kind: "evaluateMergeReadiness",
          mergeMethod: "merge",
        },
        {
          freshStateReader: () =>
            Effect.succeed({
              ...open,
              checks,
              reviewDecision: "CHANGES_REQUESTED",
            }),
          rootDirectory: f.root,
        }
      ).pipe(Effect.provide(NodeServices.layer))
    );
    expect(rejected).toMatchObject({ approved: false, version: 3 });
    expect(
      "approvalSource" in rejected ? rejected.approvalSource : undefined
    ).toBeUndefined();
  });

  it("rejects a local-attested readiness decision after a later authority generation even when the tree SHA is unchanged", async () => {
    const f = fixture("ready", true);
    const current = merged(f.binding);
    const {
      mergedAt: _mergedAt,
      mergeCommitSha: _mergeCommitSha,
      reviewDecision: _reviewDecision,
      ...openBase
    } = current;
    const open = { ...openBase, state: "open" as const };
    await Effect.runPromise(
      coordinateDeliveryLocalReviewAttestation(
        f.runId,
        {
          actionId: "paired-review-attestation-1",
          decision: "approved",
          expectedBranchName: f.binding.branchName,
          expectedHeadSha: f.binding.expectedHeadSha,
          expectedPrNumber: f.binding.prNumber,
          expectedPrUrl: f.binding.prUrl,
          kind: "attestPairedReviewApproval",
        },
        { freshStateReader: () => Effect.succeed(open), rootDirectory: f.root }
      ).pipe(Effect.provide(NodeServices.layer))
    );
    const checks = [
      {
        appSlug: "github-actions",
        headSha: f.binding.expectedHeadSha,
        name: "gaia-pr-ci",
        repository: f.binding.repository,
        state: "passing" as const,
        workflow: "Gaia PR CI",
      },
    ];
    await Effect.runPromise(
      coordinateDeliveryMergeReadiness(
        f.runId,
        {
          actionId: "readiness-local-attestation",
          kind: "evaluateMergeReadiness",
          mergeMethod: "merge",
        },
        {
          freshStateReader: () => Effect.succeed({ ...open, checks }),
          rootDirectory: f.root,
        }
      ).pipe(Effect.provide(NodeServices.layer))
    );
    const eventsPath = path.join(
      f.root,
      ".gaia",
      "runs",
      f.runId,
      "events.jsonl"
    );
    const decisionSequence = readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n").length;
    appendConfirmedRemediation(f, f.binding.expectedHeadSha);
    let reads = 0;
    let providerCalls = 0;

    await expect(
      Effect.runPromise(
        coordinateDeliveryMerge(
          f.runId,
          {
            actionId: "merge-stale-attestation",
            expectedBranchName: f.binding.branchName,
            expectedDecisionSequence: decisionSequence,
            expectedHeadSha: f.binding.expectedHeadSha,
            expectedPolicyDigest: f.binding.policyDigest,
            expectedPrUrl: f.binding.prUrl,
            kind: "merge",
            mergeMethod: "merge",
          },
          {
            commandRunner: () =>
              Effect.sync(() => {
                providerCalls += 1;
                return { exitCode: 0, stderr: "", stdout: "" };
              }),
            freshStateReader: () =>
              Effect.sync(() => {
                reads += 1;
                return open;
              }),
            rootDirectory: f.root,
          }
        ).pipe(Effect.provide(NodeServices.layer))
      )
    ).rejects.toMatchObject({ code: "DeliveryActionConflict" });
    expect(reads).toBe(0);
    expect(providerCalls).toBe(0);
  });
  it("canonicalizes legacy and explicit strict review policy while distinguishing solo policy", () => {
    const legacy = defaultDeliveryFeedbackTrustPolicy("cill-i-am/gaia");
    const strict = DeliveryFeedbackTrustPolicyV1.make({
      ...legacy,
      requireApprovedReview: true,
    });
    const solo = DeliveryFeedbackTrustPolicyV1.make({
      ...legacy,
      requireApprovedReview: false,
    });
    const canonical = (policy: DeliveryFeedbackTrustPolicyV1) =>
      deliveryRequiredCheckPolicyCanonicalPayload(
        requiredCheckPolicyFromTrustPolicy(policy)
      );

    expect(canonical(legacy)).toBe(canonical(strict));
    expect(canonical(legacy)).toContain("review:1");
    expect(canonical(solo)).toContain("review:0");
    expect(canonical(solo)).not.toBe(canonical(strict));
  });

  it("rejects strict-to-solo process drift before intent or provider invocation", async () => {
    const f = fixture("ready", false);
    const strict = requiredCheckPolicyFromTrustPolicy(
      defaultDeliveryFeedbackTrustPolicy("cill-i-am/gaia")
    );
    let providerCalls = 0;

    await expect(
      Effect.runPromise(
        coordinateDeliveryMerge(f.runId, f.action, {
          commandRunner: () =>
            Effect.sync(() => {
              providerCalls += 1;
              return { exitCode: 0, stderr: "", stdout: "" };
            }),
          freshStateReader: () => Effect.succeed(merged(f.binding)),
          requiredCheckPolicy: strict,
          rootDirectory: f.root,
        }).pipe(Effect.provide(NodeServices.layer))
      )
    ).rejects.toMatchObject({ code: "DeliveryActionConflict" });
    expect(providerCalls).toBe(0);
    expect(
      readFileSync(
        path.join(f.root, ".gaia", "runs", f.runId, "events.jsonl"),
        "utf8"
      )
    ).not.toContain('"DELIVERY_MERGE_RECORDED"');
  });

  it("requires durable ready confirmation for the exact current head before readiness or merge", async () => {
    const f = fixture("ready", false, "b".repeat(40));
    const {
      mergeCommitSha: _mergeCommitSha,
      mergedAt: _mergedAt,
      ...base
    } = merged(f.binding);
    const fresh = {
      ...base,
      checks: [
        {
          appSlug: "github-actions",
          headSha: f.binding.expectedHeadSha,
          name: "gaia-pr-ci",
          repository: f.binding.repository,
          state: "passing" as const,
          workflow: "Gaia PR CI",
        },
      ],
      state: "open" as const,
    };
    let providerCalls = 0;

    await expect(
      Effect.runPromise(
        coordinateDeliveryMergeReadiness(
          f.runId,
          {
            actionId: "readiness-current-head",
            kind: "evaluateMergeReadiness",
            mergeMethod: "merge",
          },
          {
            freshStateReader: () => Effect.succeed(fresh),
            rootDirectory: f.root,
          }
        ).pipe(Effect.provide(NodeServices.layer))
      )
    ).rejects.toMatchObject({ code: "DeliveryActionConflict" });

    await expect(
      Effect.runPromise(
        coordinateDeliveryMerge(f.runId, f.action, {
          commandRunner: () =>
            Effect.sync(() => {
              providerCalls += 1;
              return { exitCode: 0, stderr: "", stdout: "" };
            }),
          freshStateReader: () => Effect.succeed(fresh),
          rootDirectory: f.root,
        }).pipe(Effect.provide(NodeServices.layer))
      )
    ).rejects.toMatchObject({ code: "DeliveryActionConflict" });
    expect(providerCalls).toBe(0);
  });

  it("rejects a prior same-action readiness decision after confirmed remediation without rereading", async () => {
    const f = fixture("ready");
    appendConfirmedRemediation(f);
    let reads = 0;

    await expect(
      Effect.runPromise(
        coordinateDeliveryMergeReadiness(
          f.runId,
          {
            actionId: "readiness-1",
            kind: "evaluateMergeReadiness",
            mergeMethod: "merge",
          },
          {
            freshStateReader: () =>
              Effect.sync(() => {
                reads += 1;
                return merged(f.binding);
              }),
            rootDirectory: f.root,
          }
        ).pipe(Effect.provide(NodeServices.layer))
      )
    ).rejects.toMatchObject({ code: "DeliveryActionConflict" });
    expect(reads).toBe(0);
  });

  it("rejects a stale-head merge after confirmed remediation before reads or provider dispatch", async () => {
    const f = fixture("ready");
    appendConfirmedRemediation(f);
    let reads = 0;
    let providerCalls = 0;

    await expect(
      Effect.runPromise(
        coordinateDeliveryMerge(f.runId, f.action, {
          commandRunner: () =>
            Effect.sync(() => {
              providerCalls += 1;
              return { exitCode: 0, stderr: "", stdout: "" };
            }),
          freshStateReader: () =>
            Effect.sync(() => {
              reads += 1;
              return merged(f.binding);
            }),
          rootDirectory: f.root,
        }).pipe(Effect.provide(NodeServices.layer))
      )
    ).rejects.toMatchObject({ code: "DeliveryActionConflict" });
    expect(reads).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it("keeps remediation stale by sequence even after exact-head ready confirmation", async () => {
    const f = fixture("ready", false);
    const currentHeadSha = appendConfirmedRemediation(f);
    appendCurrentReadyConfirmation(f, currentHeadSha);
    const {
      mergeCommitSha: _mergeCommitSha,
      mergedAt: _mergedAt,
      ...base
    } = merged(f.binding);
    const fresh = {
      ...base,
      checks: [
        {
          appSlug: "github-actions",
          headSha: currentHeadSha,
          name: "gaia-pr-ci",
          repository: f.binding.repository,
          state: "passing" as const,
          workflow: "Gaia PR CI",
        },
      ],
      headSha: currentHeadSha,
      state: "open" as const,
    };

    await expect(
      Effect.runPromise(
        coordinateDeliveryMergeReadiness(
          f.runId,
          {
            actionId: "readiness-remediated-1",
            kind: "evaluateMergeReadiness",
            mergeMethod: "merge",
          },
          {
            freshStateReader: () => Effect.succeed(fresh),
            rootDirectory: f.root,
          }
        ).pipe(Effect.provide(NodeServices.layer))
      )
    ).rejects.toMatchObject({ code: "DeliveryActionConflict" });
  });

  for (const corruption of [
    "publication generation",
    "pull request tuple",
    "digest",
  ] as const) {
    it(`rejects a ready receipt with a mismatched ${corruption} before readiness or merge side effects`, async () => {
      const f = fixture("ready", false);
      corruptReadyReceipts(f, corruption);
      let reads = 0;
      let providerCalls = 0;

      await expect(
        Effect.runPromise(
          coordinateDeliveryMergeReadiness(
            f.runId,
            {
              actionId: "readiness-corrupt-history",
              kind: "evaluateMergeReadiness",
              mergeMethod: "merge",
            },
            {
              freshStateReader: () =>
                Effect.sync(() => {
                  reads += 1;
                  return merged(f.binding);
                }),
              rootDirectory: f.root,
            }
          ).pipe(Effect.provide(NodeServices.layer))
        )
      ).rejects.toThrow();

      await expect(
        Effect.runPromise(
          coordinateDeliveryMerge(f.runId, f.action, {
            commandRunner: () =>
              Effect.sync(() => {
                providerCalls += 1;
                return { exitCode: 0, stderr: "", stdout: "" };
              }),
            freshStateReader: () =>
              Effect.sync(() => {
                reads += 1;
                return merged(f.binding);
              }),
            rootDirectory: f.root,
          }).pipe(Effect.provide(NodeServices.layer))
        )
      ).rejects.toThrow();
      expect(reads).toBe(0);
      expect(providerCalls).toBe(0);
    });
  }

  for (const corruption of [
    "payload digest",
    "merge-decision binding",
  ] as const) {
    it(`rejects a corrupt V3 ${corruption} during replay before merge dispatch`, async () => {
      const f = fixture("ready", false);
      corruptMergeReadinessDecision(f, corruption);
      let providerCalls = 0;
      let stateReads = 0;

      await expect(
        Effect.runPromise(
          coordinateDeliveryMerge(f.runId, f.action, {
            commandRunner: () =>
              Effect.sync(() => {
                providerCalls += 1;
                return { exitCode: 0, stderr: "", stdout: "" };
              }),
            freshStateReader: () =>
              Effect.sync(() => {
                stateReads += 1;
                return merged(f.binding);
              }),
            rootDirectory: f.root,
          }).pipe(Effect.provide(NodeServices.layer))
        )
      ).rejects.toThrow();
      expect(stateReads).toBe(0);
      expect(providerCalls).toBe(0);
    });
  }

  for (const authority of [
    "newer proof result",
    "newer blocked V2",
    "content remediation",
    "newer evidence review",
  ] as const) {
    it(`rejects literal JSONL when ${authority} intervenes between approved V2 and V3`, async () => {
      const f = fixture("ready", false);
      insertAuthorityBeforeReadiness(f, authority);

      await expect(
        Effect.runPromise(
          loadRun(f.paths).pipe(Effect.provide(NodeServices.layer))
        )
      ).rejects.toMatchObject({ code: "InvalidRunEventHistory" });
    });
  }

  it("rejects a newer publication record between V2 and V3 at the terminal publication lifecycle boundary", async () => {
    const f = fixture("ready", false);
    insertAuthorityBeforeReadiness(f, "newer publication");

    const failure = await Effect.runPromise(
      Effect.flip(loadRun(f.paths)).pipe(Effect.provide(NodeServices.layer))
    );
    expect(failure).toMatchObject({ code: "InvalidRunEventHistory" });
    if (!(failure instanceof GaiaRuntimeError))
      throw new Error("Expected typed invalid-history failure.");
    expect(String(failure.cause)).toMatch(
      /publication confirmation requires an attempted operation/iu
    );
  });

  for (const authority of [
    "proof result",
    "content remediation",
    "evidence review",
  ] as const) {
    it(`rejects merge dispatch when a newer ${authority} follows V3`, async () => {
      const f = fixture("ready", false);
      appendAuthorityAfterReadiness(f, authority);
      let providerCalls = 0;
      let stateReads = 0;

      await expect(
        Effect.runPromise(
          coordinateDeliveryMerge(f.runId, f.action, {
            commandRunner: () =>
              Effect.sync(() => {
                providerCalls += 1;
                return { exitCode: 0, stderr: "", stdout: "" };
              }),
            freshStateReader: () =>
              Effect.sync(() => {
                stateReads += 1;
                return merged(f.binding);
              }),
            rootDirectory: f.root,
          }).pipe(Effect.provide(NodeServices.layer))
        )
      ).rejects.toMatchObject({ code: "DeliveryActionConflict" });
      expect(stateReads).toBe(0);
      expect(providerCalls).toBe(0);
    });
  }

  for (const [required, reviewDecision, approved] of [
    [true, "APPROVED", true],
    [true, undefined, false],
    [true, "REVIEW_REQUIRED", false],
    [true, "CHANGES_REQUESTED", false],
    [true, "UNKNOWN_CONFLICT", false],
    [false, "APPROVED", true],
    [false, undefined, true],
    [false, "REVIEW_REQUIRED", true],
    [false, "CHANGES_REQUESTED", false],
    [false, "UNKNOWN_CONFLICT", false],
  ] as const) {
    it(`applies review truth table required=${required} state=${reviewDecision ?? "none"}`, async () => {
      const f = fixture("attempted", required);
      const {
        mergeCommitSha: _mergeCommitSha,
        mergedAt: _mergedAt,
        reviewDecision: _reviewDecision,
        ...base
      } = merged(f.binding);
      const fresh = {
        ...base,
        checks: [
          {
            appSlug: "github-actions",
            headSha: f.binding.expectedHeadSha,
            name: "gaia-pr-ci",
            repository: f.binding.repository,
            state: "passing" as const,
            workflow: "Gaia PR CI",
          },
        ],
        ...(reviewDecision === undefined ? {} : { reviewDecision }),
        state: "open" as const,
      };
      const decision = await Effect.runPromise(
        coordinateDeliveryMergeReadiness(
          f.runId,
          {
            actionId: `readiness-${required}-${reviewDecision ?? "none"}`,
            kind: "evaluateMergeReadiness",
            mergeMethod: "merge",
          },
          {
            freshStateReader: () => Effect.succeed(fresh),
            rootDirectory: f.root,
          }
        ).pipe(Effect.provide(NodeServices.layer))
      );
      expect(decision.approved).toBe(approved);
    });
  }

  for (const [providerValue, normalized, strictApproved, soloApproved] of [
    ["", undefined, false, true],
    [undefined, undefined, false, true],
    [null, undefined, false, true],
    ["APPROVED", "APPROVED", true, true],
    ["CHANGES_REQUESTED", "CHANGES_REQUESTED", false, false],
    ["HOSTILE_UNKNOWN", "HOSTILE_UNKNOWN", false, false],
  ] as const) {
    it(`normalizes provider review decision ${String(providerValue)}`, async () => {
      expect(normalizeGitHubReviewDecision(providerValue)).toBe(normalized);
      for (const [required, approved] of [
        [true, strictApproved],
        [false, soloApproved],
      ] as const) {
        const f = fixture("attempted", required);
        const {
          mergeCommitSha: _mergeCommitSha,
          mergedAt: _mergedAt,
          reviewDecision: _reviewDecision,
          ...base
        } = merged(f.binding);
        const decision = normalizeGitHubReviewDecision(providerValue);
        const fresh = {
          ...base,
          checks: [
            {
              appSlug: "github-actions",
              headSha: f.binding.expectedHeadSha,
              name: "gaia-pr-ci",
              repository: f.binding.repository,
              state: "passing" as const,
              workflow: "Gaia PR CI",
            },
          ],
          ...(decision === undefined ? {} : { reviewDecision: decision }),
          state: "open" as const,
        };
        const readiness = await Effect.runPromise(
          coordinateDeliveryMergeReadiness(
            f.runId,
            {
              actionId: `provider-${String(providerValue)}-${required}`,
              kind: "evaluateMergeReadiness",
              mergeMethod: "merge",
            },
            {
              freshStateReader: () => Effect.succeed(fresh),
              rootDirectory: f.root,
            }
          ).pipe(Effect.provide(NodeServices.layer))
        );
        expect(readiness.approved).toBe(approved);
      }
    });
  }

  for (const [name, change] of [
    ["draft", { draft: true }],
    ["closed", { state: "closed" as const }],
    ["wrong branch", { branchName: "gaia/unrelated" }],
    ["wrong head", { headSha: "e".repeat(40) }],
    ["conflicting mergeability", { mergeability: "conflicting" as const }],
    ["unresolved threads", { unresolvedActionableThreads: 1 }],
    ["untrusted or ambiguous feedback", { feedbackBlockers: 1 }],
    ["unsupported method", { supportedMethods: [] }],
    ["changes requested", { reviewDecision: "CHANGES_REQUESTED" }],
    ["missing required check", { checks: [] }],
    [
      "pending required check",
      {
        checks: [
          {
            appSlug: "github-actions",
            headSha: "a".repeat(40),
            name: "gaia-pr-ci",
            repository: "cill-i-am/gaia",
            state: "pending" as const,
            workflow: "Gaia PR CI",
          },
        ],
      },
    ],
    [
      "failed required check",
      {
        checks: [
          {
            appSlug: "github-actions",
            headSha: "a".repeat(40),
            name: "gaia-pr-ci",
            repository: "cill-i-am/gaia",
            state: "failed" as const,
            workflow: "Gaia PR CI",
          },
        ],
      },
    ],
  ] as const) {
    it(`keeps ${name} blocking under solo review policy before intent`, async () => {
      const f = fixture("ready", false);
      const {
        mergeCommitSha: _mergeCommitSha,
        mergedAt: _mergedAt,
        ...base
      } = merged(f.binding);
      const fresh = {
        ...base,
        checks: [
          {
            appSlug: "github-actions",
            headSha: f.binding.expectedHeadSha,
            name: "gaia-pr-ci",
            repository: f.binding.repository,
            state: "passing" as const,
            workflow: "Gaia PR CI",
          },
        ],
        state: "open" as const,
        ...change,
      };
      let providerCalls = 0;

      await expect(
        Effect.runPromise(
          coordinateDeliveryMerge(f.runId, f.action, {
            commandRunner: () =>
              Effect.sync(() => {
                providerCalls += 1;
                return { exitCode: 0, stderr: "", stdout: "" };
              }),
            freshStateReader: () => Effect.succeed(fresh),
            rootDirectory: f.root,
          }).pipe(Effect.provide(NodeServices.layer))
        )
      ).rejects.toMatchObject({ code: "DeliveryMergePreconditionFailed" });
      expect(providerCalls).toBe(0);
      expect(
        readFileSync(
          path.join(f.root, ".gaia", "runs", f.runId, "events.jsonl"),
          "utf8"
        )
      ).not.toContain('"DELIVERY_MERGE_RECORDED"');
    });
  }
  it("replays identical readiness action without reread and rejects changed method", async () => {
    const f = fixture("attempted");
    let reads = 0;
    const options = {
      freshStateReader: () =>
        Effect.sync(() => {
          reads += 1;
          return merged(f.binding);
        }),
      rootDirectory: f.root,
    };
    const replay = await Effect.runPromise(
      coordinateDeliveryMergeReadiness(
        f.runId,
        {
          actionId: "readiness-1",
          kind: "evaluateMergeReadiness",
          mergeMethod: "merge",
        },
        options
      ).pipe(Effect.provide(NodeServices.layer))
    );
    expect(replay.actionId).toBe("readiness-1");
    expect(reads).toBe(0);
    await expect(
      Effect.runPromise(
        coordinateDeliveryMergeReadiness(
          f.runId,
          {
            actionId: "readiness-1",
            kind: "evaluateMergeReadiness",
            mergeMethod: "rebase",
          },
          options
        ).pipe(Effect.provide(NodeServices.layer))
      )
    ).rejects.toMatchObject({ code: "DeliveryActionConflict" });
    expect(reads).toBe(0);
  });

  it("rejects a retained pre-slice readiness decision without exact ready confirmation", async () => {
    const f = retainedPreReadyFixture();
    let reads = 0;
    await expect(
      Effect.runPromise(
        coordinateDeliveryMergeReadiness(
          f.runId,
          {
            actionId: "readiness-1",
            kind: "evaluateMergeReadiness",
            mergeMethod: "merge",
          },
          {
            freshStateReader: () =>
              Effect.sync(() => {
                reads += 1;
                return merged(f.binding);
              }),
            rootDirectory: f.root,
          }
        ).pipe(Effect.provide(NodeServices.layer))
      )
    ).rejects.toMatchObject({ code: "DeliveryActionConflict" });
    expect(reads).toBe(0);
  });
  for (const state of ["attempted", "checkpoint", "unknown"] as const) {
    it(`reconciles ${state} with zero provider redispatch`, async () => {
      const f = fixture(state);
      let providerCalls = 0;
      let reconciliationCalls = 0;
      const receipt = await Effect.runPromise(
        coordinateDeliveryMerge(f.runId, f.action, {
          commandRunner: () =>
            Effect.sync(() => {
              providerCalls += 1;
              return { exitCode: 0, stderr: "", stdout: "" };
            }),
          freshStateReader: () =>
            Effect.sync(() => {
              reconciliationCalls += 1;
              return merged(f.binding);
            }),
          rootDirectory: f.root,
        }).pipe(Effect.provide(NodeServices.layer))
      );
      expect(receipt.state).toBe("dispatchConfirmed");
      expect(providerCalls).toBe(0);
      expect(reconciliationCalls).toBe(1);
    });
  }

  it("serializes concurrent duplicate replay without provider invocation", async () => {
    const f = fixture("unknown");
    let providerCalls = 0;
    let reconciliationCalls = 0;
    const options = {
      commandRunner: () =>
        Effect.sync(() => {
          providerCalls += 1;
          return { exitCode: 0, stderr: "", stdout: "" };
        }),
      freshStateReader: () =>
        Effect.sync(() => {
          reconciliationCalls += 1;
          return merged(f.binding);
        }),
      rootDirectory: f.root,
    };
    const results = await Promise.allSettled([
      Effect.runPromise(
        coordinateDeliveryMerge(f.runId, f.action, options).pipe(
          Effect.provide(NodeServices.layer)
        )
      ),
      Effect.runPromise(
        coordinateDeliveryMerge(f.runId, f.action, options).pipe(
          Effect.provide(NodeServices.layer)
        )
      ),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1
    );
    expect(providerCalls).toBe(0);
    expect(reconciliationCalls).toBe(1);
  });

  it("retains outcome unknown when fresh exact state cannot prove acceptance or rejection", async () => {
    const f = fixture("checkpoint");
    let providerCalls = 0;
    let reconciliationCalls = 0;
    const {
      mergeCommitSha: _mergeCommitSha,
      mergedAt: _mergedAt,
      ...fresh
    } = merged(f.binding);
    const open = { ...fresh, state: "open" as const };
    const receipt = await Effect.runPromise(
      coordinateDeliveryMerge(f.runId, f.action, {
        commandRunner: () =>
          Effect.sync(() => {
            providerCalls += 1;
            return { exitCode: 0, stderr: "", stdout: "" };
          }),
        freshStateReader: () =>
          Effect.sync(() => {
            reconciliationCalls += 1;
            return open;
          }),
        rootDirectory: f.root,
      }).pipe(Effect.provide(NodeServices.layer))
    );
    expect(receipt.state).toBe("outcomeUnknown");
    expect(providerCalls).toBe(0);
    expect(reconciliationCalls).toBe(1);
  });
});
