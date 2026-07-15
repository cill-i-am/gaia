import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  EvidencePromotion,
  EvidencePromotionDogfoodSummary,
  EvidencePromotionPullRequestSummary,
  EvidencePromotionReportPaths,
  EvidencePromotionVerificationSummary,
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationFailed,
  DeliveryPublicationIntent,
  DeliveryPublicationOutcomeUnknown,
  encodeDeliveryPublicationJson,
  FactoryRetro,
  FactoryRetroEntry,
  FactoryRetroSourceLink,
  FactoryLaneScorecard,
  FactoryLaneScorecardCriterionAssessment,
  FactoryLaneScorecardFactoryLearningSignal,
  FactoryLaneScorecardImplementationAcceptance,
  FactoryLaneScorecardLane,
  FactoryLaneScorecardPreferredLane,
  FactoryLaneScorecardSourceLink,
  FactoryLaneScorecardVerificationEvidence,
  PromotedEvidenceItem,
  parseFactoryDelegationPromptValidationInput,
  makeRunEvent,
  parseEvidencePromotion,
  parseFactoryRetro,
  parseFactoryLaneScorecard,
  parseDeliveryPublication,
  parseMarkdownSpec,
  parseRunReport,
  parseRunReportArtifactPath,
  parseRunMachineContext,
  parseRunMachineEvent,
  parseRunId,
  replayRunEvents,
  RunReport,
  RunMachineContextSchema,
  RunMachineEventSchema,
  snapshotFromReplay,
  validateFactoryDelegationPrompt,
} from "./index.js";

describe("core contracts", () => {
  it("parses branded run ids", () => {
    assert.strictEqual(parseRunId("run-V7kP9sQ2xY"), "run-V7kP9sQ2xY");
    assert.throws(() => parseRunId("not-a-run"));
  });

  it("parses markdown specs with frontmatter", () => {
    const spec = parseMarkdownSpec(
      "---\ntitle: Smoke test\n---\n\nDo the smallest thing.",
      "fallback"
    );

    assert.strictEqual(spec.title, "Smoke test");
    assert.strictEqual(spec.body, "Do the smallest thing.");
  });

  it("parses run report artifact paths through the owning schema", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const artifact = parseRunReportArtifactPath("worker-plan.md");
    const report = RunReport.make({
      artifacts: [artifact],
      reportPath: "report.md",
      runId,
      selectedSkills: ["production-ready"],
      status: "completed",
      summary: "Gaia completed the run.",
    });
    const serialized: unknown = JSON.parse(JSON.stringify(report));

    assert.strictEqual(
      parseRunReportArtifactPath("report.json"),
      "report.json"
    );
    assert.throws(() => parseRunReportArtifactPath(""));
    assert.deepEqual(parseRunReport(serialized).artifacts, [artifact]);
  });

  it("parses JSON-safe evidence promotion summaries", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const promotion = EvidencePromotion.make({
      artifactPath: ".gaia/promoted/run-V7kP9sQ2xY/evidence-promotion.json",
      cleanupStatus: "not-completed",
      dogfood: EvidencePromotionDogfoodSummary.make({
        artifactPath: "dogfood-retrospective.json",
        findingCount: 0,
        status: "clean",
        summary: "No findings.",
      }),
      generatedAt: "2026-07-06T12:00:00.000Z",
      markdown: "# Evidence Promotion run-V7kP9sQ2xY\n",
      markdownPath: ".gaia/promoted/run-V7kP9sQ2xY/evidence-promotion.md",
      promotionStatus: "pending-promotion",
      pullRequest: EvidencePromotionPullRequestSummary.make({
        artifactPaths: [],
        status: "skipped",
        summary: "No PR evidence.",
      }),
      reportPaths: EvidencePromotionReportPaths.make({
        dogfoodRetrospectivePath: "dogfood-retrospective.json",
        reportJsonPath: "report.json",
        reportMarkdownPath: "report.md",
        workerPlanPath: "worker-plan.md",
      }),
      runId,
      selectedEvidence: [
        PromotedEvidenceItem.make({
          label: "Run report",
          path: "report.md",
          status: "pending-promotion",
          summary: "Report selected before cleanup.",
        }),
      ],
      verification: EvidencePromotionVerificationSummary.make({
        checkedArtifacts: ["workspace/output.txt"],
        path: "verification-result.json",
        status: "passed",
      }),
      version: 1,
    });

    const serialized: unknown = JSON.parse(JSON.stringify(promotion));

    assert.strictEqual(parseEvidencePromotion(serialized).runId, runId);
    assert.strictEqual(promotion.cleanupStatus, "not-completed");
    assert.strictEqual(promotion.promotionStatus, "pending-promotion");
  });

  it("parses JSON-safe factory retro artifacts", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const retro = FactoryRetro.make({
      artifactPath: ".gaia/promoted/run-V7kP9sQ2xY/factory-retro.json",
      cleanupStatus: "not-completed",
      generatedAt: "2026-07-06T12:00:00.000Z",
      helped: [
        FactoryRetroEntry.make({
          source: "observed",
          summary: "Durable planning and report artifacts helped review.",
        }),
      ],
      markdown: "# Factory Retro run-V7kP9sQ2xY\n",
      markdownPath: ".gaia/promoted/run-V7kP9sQ2xY/factory-retro.md",
      missed: [
        FactoryRetroEntry.make({
          source: "operator-note",
          summary: "Gaia missed likely implementation files.",
        }),
      ],
      misled: [
        FactoryRetroEntry.make({
          source: "inferred",
          summary: "Command extraction treated a route like a shell command.",
        }),
      ],
      promotionStatus: "pending-promotion",
      promotedEvidence: [
        PromotedEvidenceItem.make({
          label: "Evidence promotion",
          path: ".gaia/promoted/run-V7kP9sQ2xY/evidence-promotion.md",
          status: "pending-promotion",
          summary: "Promotion is pending operator copy into Linear or PR text.",
        }),
      ],
      recommendedNextFactoryImprovement:
        "Separate executable commands from domain references.",
      runId,
      sourceLinks: [
        FactoryRetroSourceLink.make({
          label: "GAIA-12 retro",
          url: "https://linear.app/tskr/document/factory-retro-gaia-12-ab-dogfood-45bcc888784b",
        }),
      ],
      status: "findings",
      version: 1,
    });

    const serialized: unknown = JSON.parse(JSON.stringify(retro));

    assert.strictEqual(parseFactoryRetro(serialized).runId, runId);
    assert.strictEqual(retro.helped[0]?.source, "observed");
    assert.strictEqual(retro.cleanupStatus, "not-completed");
    assert.strictEqual(
      retro.recommendedNextFactoryImprovement.includes("commands"),
      true
    );
  });

  it("parses JSON-safe factory lane scorecards with acceptance separated from factory learning", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const scorecard = FactoryLaneScorecard.make({
      artifactPath: ".gaia/promoted/run-V7kP9sQ2xY/factory-scorecard.json",
      comparisonSummary:
        "Lane B is preferred for accepted implementation quality while Lane A remains a smaller fallback.",
      generatedAt: "2026-07-06T12:00:00.000Z",
      lanes: [
        FactoryLaneScorecardLane.make({
          checkStatus: "no-checks-configured",
          comparisonWaitStatus: "valid",
          criteria: [
            FactoryLaneScorecardCriterionAssessment.make({
              classification: "adequate",
              criterion: "correctness",
              evidence: ["Focused tests passed."],
              summary: "Correct but narrower.",
            }),
          ],
          factoryLearningSignal: FactoryLaneScorecardFactoryLearningSignal.make(
            {
              evidence: ["Direct lane did not exercise Gaia artifacts."],
              status: "weak",
              summary: "Useful fallback but limited dogfood signal.",
            }
          ),
          headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          implementationAcceptance:
            FactoryLaneScorecardImplementationAcceptance.make({
              status: "fallback",
              summary: "Closed unmerged as fallback/reference.",
            }),
          label: "Lane A",
          laneId: "lane-a",
          localVerification: [
            FactoryLaneScorecardVerificationEvidence.make({
              command: "pnpm test",
              result: "passed",
            }),
          ],
          pullRequest: "#14",
          role: "direct-fallback",
          sourceLinks: [
            FactoryLaneScorecardSourceLink.make({
              label: "Closed fallback lane PR #14",
              url: "https://github.com/cill-i-am/gaia/pull/14",
            }),
          ],
          tradeoffs: ["Smaller diff, weaker factory signal."],
        }),
        FactoryLaneScorecardLane.make({
          checkStatus: "no-checks-configured",
          comparisonWaitStatus: "valid",
          criteria: [
            FactoryLaneScorecardCriterionAssessment.make({
              classification: "strong",
              criterion: "dogfood-signal",
              evidence: ["Gaia run IDs and factory retro were promoted."],
              summary: "Dogfood artifacts improved handoff evidence.",
            }),
          ],
          factoryLearningSignal: FactoryLaneScorecardFactoryLearningSignal.make(
            {
              evidence: ["Gaia exposed command extraction and planning gaps."],
              status: "strong",
              summary: "Strong signal for Gaia self-improvement.",
            }
          ),
          headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          implementationAcceptance:
            FactoryLaneScorecardImplementationAcceptance.make({
              status: "accepted",
              summary: "Accepted and merged after reviewer fixes.",
            }),
          label: "Lane B",
          laneId: "lane-b",
          localVerification: [
            FactoryLaneScorecardVerificationEvidence.make({
              command: "pnpm build",
              result: "passed",
            }),
          ],
          pullRequest: "#15",
          role: "gaia-dogfood",
          sourceLinks: [
            FactoryLaneScorecardSourceLink.make({
              label: "Accepted dogfood lane PR #15",
              url: "https://github.com/cill-i-am/gaia/pull/15",
            }),
          ],
          tradeoffs: ["Broader diff, stronger boundary typing and evidence."],
        }),
      ],
      markdown: "# Factory Lane Scorecard run-V7kP9sQ2xY\n",
      markdownPath: ".gaia/promoted/run-V7kP9sQ2xY/factory-scorecard.md",
      notes: ["No-CI is not green; local verification remains evidence."],
      preferredLane: FactoryLaneScorecardPreferredLane.make({
        laneId: "lane-b",
        rationale:
          "Lane B had stronger implementation quality and dogfood signal.",
        tradeoffsPreserved: ["Lane A remains a smaller fallback/reference."],
      }),
      recommendationSummary:
        "Prefer Lane B while preserving Lane A as fallback context.",
      runId,
      version: 1,
    });

    const serialized: unknown = JSON.parse(JSON.stringify(scorecard));
    const parsed = parseFactoryLaneScorecard(serialized);

    assert.strictEqual(parsed.runId, runId);
    assert.strictEqual(parsed.lanes[0]?.checkStatus, "no-checks-configured");
    assert.strictEqual(
      parsed.lanes[1]?.implementationAcceptance.status,
      "accepted"
    );
    assert.strictEqual(parsed.lanes[1]?.factoryLearningSignal.status, "strong");
    assert.strictEqual(parsed.preferredLane?.laneId, "lane-b");
  });

  it("flags dogfood requirements on direct fallback lanes", () => {
    const validation = validateFactoryDelegationPrompt({
      laneRole: "direct-fallback",
      promptMarkdown: [
        "Lane role: direct fallback.",
        "Base commit: e9e2f1ee79f15fe3949703277f0fe83bd6a19634.",
        "Use isolated worktree branch codex/gaia-20.",
        "Clean up generated .gaia run state before handoff.",
        "Wait for both A/B PRs before comparing lanes.",
        "Record Gaia dogfood run IDs and a dogfood retrospective.",
      ].join("\n"),
      requiresComparisonWait: true,
    });

    assert.strictEqual(validation.status, "failed");
    assert.include(
      validation.findings.map((finding) => finding.code),
      "dogfood-requirement-on-non-dogfood-lane"
    );
  });

  it("flags dogfood lanes missing Gaia evidence expectations", () => {
    const validation = validateFactoryDelegationPrompt({
      laneRole: "gaia-dogfood",
      promptMarkdown: [
        "Lane role: Gaia dogfood.",
        "Base commit: e9e2f1ee79f15fe3949703277f0fe83bd6a19634.",
        "Use isolated worktree branch codex/gaia-20.",
        "Clean up generated .gaia run state before handoff.",
        "Wait for both A/B PRs before comparing lanes.",
      ].join("\n"),
      requiresComparisonWait: true,
    });

    assert.strictEqual(validation.status, "failed");
    assert.sameMembers(
      validation.findings.map((finding) => finding.code),
      [
        "dogfood-run-evidence-missing",
        "dogfood-retrospective-missing",
        "dogfood-promotion-evidence-missing",
      ]
    );
  });

  it("flags A/B lanes missing base, cleanup, and comparison-wait guidance", () => {
    const validation = validateFactoryDelegationPrompt({
      laneRole: "direct-fallback",
      promptMarkdown: [
        "Lane role: direct fallback.",
        "Use an isolated worktree branch codex/gaia-20.",
      ].join("\n"),
      requiresComparisonWait: true,
    });

    assert.strictEqual(validation.status, "failed");
    assert.sameMembers(
      validation.findings.map((finding) => finding.code),
      [
        "base-commit-missing",
        "cleanup-rules-missing",
        "comparison-wait-rules-missing",
      ]
    );
  });

  it("flags A/B lanes missing isolated worktree and branch guidance", () => {
    const validation = validateFactoryDelegationPrompt({
      laneRole: "direct-fallback",
      promptMarkdown: [
        "Lane role: direct fallback.",
        "Base commit: e9e2f1ee79f15fe3949703277f0fe83bd6a19634.",
        "Clean up generated .gaia run state before handoff.",
        "Wait for both A/B PRs before comparing lanes.",
      ].join("\n"),
      requiresComparisonWait: true,
    });

    assert.deepEqual(
      validation.findings.map((finding) => finding.code),
      ["worktree-branch-expectations-missing"]
    );
  });

  it("flags prompts that do not declare the selected lane role", () => {
    const validation = validateFactoryDelegationPrompt({
      laneRole: "reviewer-spec",
      promptMarkdown: "Read the PR and report findings without editing files.",
      requiresComparisonWait: false,
    });

    assert.deepEqual(
      validation.findings.map((finding) => finding.code),
      ["lane-role-missing"]
    );
  });

  it("flags prompts with conflicting lane role declarations", () => {
    const validation = validateFactoryDelegationPrompt({
      laneRole: "direct-fallback",
      promptMarkdown: [
        "Lane role: direct fallback.",
        "Lane role: Gaia dogfood.",
        "Base commit: e9e2f1ee79f15fe3949703277f0fe83bd6a19634.",
        "Use isolated worktree branch codex/gaia-20.",
        "Clean up generated .gaia run state before handoff.",
        "Wait for both A/B PRs before comparing lanes.",
      ].join("\n"),
      requiresComparisonWait: true,
    });

    assert.strictEqual(validation.status, "failed");
    assert.include(
      validation.findings.map((finding) => finding.code),
      "lane-role-conflict"
    );
  });

  it("passes a dogfood A/B lane with the required evidence and wait rules", () => {
    const validation = validateFactoryDelegationPrompt({
      laneRole: "gaia-dogfood",
      promptMarkdown: [
        "Lane role: Gaia dogfood.",
        "Base commit: e9e2f1ee79f15fe3949703277f0fe83bd6a19634.",
        "Use isolated worktree branch codex/gaia-20.",
        "Promote Gaia run IDs and run artifact evidence to Linear/PR text before cleanup.",
        "Write a dogfood retrospective.",
        "Wait for both A/B PRs before comparing lanes.",
      ].join("\n"),
      requiresComparisonWait: true,
    });

    assert.strictEqual(validation.status, "passed");
    assert.deepEqual(validation.findings, []);
  });

  it("accepts valid delegation validation input lane roles", () => {
    const input = parseFactoryDelegationPromptValidationInput({
      laneRole: "ci-watch",
      promptMarkdown:
        "Lane role: CI watch. Monitor the PR checks and comments.",
      requiresComparisonWait: false,
    });

    assert.strictEqual(input.laneRole, "ci-watch");
  });

  it("replays the durable event log to the current state", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "REPORT_COMPLETED",
      }),
    ];

    const snapshot = replayRunEvents(events);
    assert.strictEqual(snapshot.value, "completed");

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 5);
  });

  it("round-trips lifecycle machine context and events through schemas", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
    ];

    const context = parseRunMachineContext(replayRunEvents(events).context);
    const encodedContext = Schema.encodeSync(RunMachineContextSchema)(context);

    assert.deepEqual(
      Schema.decodeUnknownSync(RunMachineContextSchema)(encodedContext),
      context
    );

    const event = parseRunMachineEvent({
      runId,
      specPath: "input.md",
      type: "RUN_CREATED",
    });
    const encodedEvent = Schema.encodeSync(RunMachineEventSchema)(event);

    assert.deepEqual(parseRunMachineEvent(encodedEvent), event);
    assert.deepEqual(snapshotFromReplay(events).context, {
      runId,
      specPath: "input.md",
      workspacePath: "workspace",
    });
  });

  it("rejects invalid lifecycle machine inputs before transition logic", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");

    assert.throws(() =>
      parseRunMachineEvent({
        type: "WORKSPACE_PREPARED",
        workspacePath: 123,
      })
    );
    assert.throws(() =>
      parseRunMachineEvent({
        phase: "planning",
        reviewPath: "review.md",
        type: "REVIEW_COMPLETED",
      })
    );

    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: 123 },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
    ];

    assert.throws(() => replayRunEvents(events), /workspacePath/u);
  });

  it("replays pull-request delivery lifecycle from safe provenance events", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const feedbackTrustPolicy = {
      allowPullRequestAuthor: false,
      trustedChecks: [
        {
          appSlug: "github-actions",
          name: "gaia-pr-ci",
          repository: "cill-i-am/gaia",
          workflow: "Gaia PR CI",
        },
      ],
      trustedHumanLogins: [],
      version: 1,
    };
    const events = [
      makeRunEvent({
        payload: {
          delivery: {
            mode: "pullRequest",
            remote: "origin",
            baseBranch: "main",
            baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
            headBranch: "gaia/run-V7kP9sQ2xY",
          },
          specPath: "input.md",
        },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
            feedbackTrustPolicy,
            headBranch: "gaia/run-V7kP9sQ2xY",
            mode: "pullRequest",
            remote: "origin",
            stage: "delivering",
          },
        },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "DELIVERY_STARTED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          delivery: {
            baseBranch: "main",
            baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
            headBranch: "gaia/run-V7kP9sQ2xY",
            mode: "pullRequest",
            remote: "origin",
            stage: "readyToPublish",
          },
          reportPath: "report.md",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "DELIVERY_READY_TO_PUBLISH",
      }),
    ];

    const delivering = snapshotFromReplay(events.slice(0, 2));
    assert.strictEqual(delivering.state, "delivering");
    assert.deepEqual(delivering.context.delivery, {
      baseBranch: "main",
      baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
      feedbackTrustPolicy,
      headBranch: "gaia/run-V7kP9sQ2xY",
      mode: "pullRequest",
      remote: "origin",
      stage: "delivering",
    });

    const ready = snapshotFromReplay(events);
    assert.strictEqual(ready.state, "delivering");
    assert.deepEqual(ready.context.delivery, {
      baseBranch: "main",
      baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
      feedbackTrustPolicy,
      headBranch: "gaia/run-V7kP9sQ2xY",
      mode: "pullRequest",
      remote: "origin",
      stage: "readyToPublish",
    });
    assert.strictEqual(ready.context.reportPath, "report.md");
    assert.notInclude(JSON.stringify(ready.context), "/Users/");
    assert.notInclude(JSON.stringify(ready.context), ".gaia/runs");
  });

  it("replays publication intent, attempt, and confirmation into waiting-for-PR", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const publicationBase = {
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      branchName: "gaia/run-V7kP9sQ2xY",
      commitMessage: "feat: deliver run-V7kP9sQ2xY",
      commitTimestamp: "2026-07-11T08:00:00.000Z",
      digestVersion: 1 as const,
      operationId: "publish-run-V7kP9sQ2xY-1",
      payloadDigest: "b".repeat(64),
      sourcePaths: ["src/delivery.ts"],
      treeSha: "d".repeat(40),
    };
    const intent = DeliveryPublicationIntent.make({
      ...publicationBase,
      state: "intentRecorded",
    });
    const attempted = DeliveryPublicationAttempted.make({
      ...publicationBase,
      commitSha: "c".repeat(40),
      state: "attempted",
      treeSha: "d".repeat(40),
    });
    const confirmed = DeliveryPublicationConfirmed.make({
      ...publicationBase,
      commitSha: "c".repeat(40),
      draft: true,
      headSha: "c".repeat(40),
      prNumber: 91,
      prUrl: "https://github.com/cill-i-am/gaia/pull/91",
      state: "confirmed",
      treeSha: "d".repeat(40),
    });
    const events = [
      ...readyToPublishEvents(runId),
      makeRunEvent({
        payload: { publication: encodeDeliveryPublicationJson(intent) },
        runId,
        sequence: 7,
        timestamp: "2026-07-11T08:00:00.000Z",
        type: "DELIVERY_PUBLICATION_INTENT_RECORDED",
      }),
      makeRunEvent({
        payload: { publication: encodeDeliveryPublicationJson(attempted) },
        runId,
        sequence: 8,
        timestamp: "2026-07-11T08:00:01.000Z",
        type: "DELIVERY_PUBLICATION_ATTEMPTED",
      }),
      makeRunEvent({
        payload: { publication: encodeDeliveryPublicationJson(confirmed) },
        runId,
        sequence: 9,
        timestamp: "2026-07-11T08:00:02.000Z",
        type: "DELIVERY_PUBLICATION_CONFIRMED",
      }),
    ];

    const publishing = snapshotFromReplay(events.slice(0, 8));
    const waiting = snapshotFromReplay(events);

    assert.strictEqual(
      (publishing.context.delivery as { stage: string }).stage,
      "publishing"
    );
    assert.strictEqual(
      (waiting.context.delivery as { stage: string }).stage,
      "waitingForPr"
    );
    assert.deepEqual(
      (waiting.context.delivery as { publication: unknown }).publication,
      encodeDeliveryPublicationJson(confirmed)
    );
  });

  it("strictly parses publication payloads and rejects secret-bearing excess fields", () => {
    const publication = {
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      branchName: "gaia/run-V7kP9sQ2xY",
      commitMessage: "feat: deliver run-V7kP9sQ2xY",
      commitTimestamp: "2026-07-11T08:00:00.000Z",
      digestVersion: 1,
      operationId: "publish-run-V7kP9sQ2xY-1",
      payloadDigest: "b".repeat(64),
      sourcePaths: ["src/delivery.ts"],
      state: "intentRecorded",
    } as const;

    assert.deepEqual(
      encodeDeliveryPublicationJson(parseDeliveryPublication(publication)),
      publication
    );
    assert.throws(() =>
      parseDeliveryPublication({
        ...publication,
        reportText: "private report body",
      })
    );
    assert.throws(() =>
      parseDeliveryPublication({
        ...publication,
        sourcePaths: ["../private.txt"],
      })
    );
    assert.throws(() =>
      parseDeliveryPublication({
        ...publication,
        sourcePaths: ["packages/core/dist/private.js"],
      })
    );
  });

  it("replays unknown, definitive failure, and explicit retry as distinct states", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const base = {
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      branchName: "gaia/run-V7kP9sQ2xY",
      commitMessage: "feat: deliver run-V7kP9sQ2xY",
      commitSha: "c".repeat(40),
      commitTimestamp: "2026-07-11T08:00:00.000Z",
      digestVersion: 1 as const,
      operationId: "publish-run-V7kP9sQ2xY-1",
      payloadDigest: "b".repeat(64),
      sourcePaths: ["src/delivery.ts"],
      treeSha: "d".repeat(40),
    };
    const intent = DeliveryPublicationIntent.make({
      ...base,
      state: "intentRecorded",
    });
    const attempted = DeliveryPublicationAttempted.make({
      ...base,
      state: "attempted",
    });
    const unknown = DeliveryPublicationOutcomeUnknown.make({
      ...base,
      code: "DeliveryPublicationOutcomeUnknown",
      message: "External acceptance could not be confirmed.",
      recoverable: true,
      state: "outcomeUnknown",
      step: "pullRequest",
    });
    const failed = DeliveryPublicationFailed.make({
      ...base,
      code: "DeliveryPullRequestNotCreated",
      message: "Exact reconciliation proved no pull request exists.",
      recoverable: true,
      state: "failed",
      step: "pullRequest",
    });
    const retryIntent = DeliveryPublicationIntent.make({
      ...intent,
      operationId: "publish-run-V7kP9sQ2xY-2",
      payloadDigest: "e".repeat(64),
    });
    const events = [
      ...readyToPublishEvents(runId),
      ...[
        ["DELIVERY_PUBLICATION_INTENT_RECORDED", intent],
        ["DELIVERY_PUBLICATION_ATTEMPTED", attempted],
        ["DELIVERY_PUBLICATION_OUTCOME_UNKNOWN", unknown],
        ["DELIVERY_PUBLICATION_FAILED", failed],
        ["DELIVERY_PUBLICATION_INTENT_RECORDED", retryIntent],
      ].map(([type, publication], index) =>
        makeRunEvent({
          payload: {
            publication: encodeDeliveryPublicationJson(
              publication as typeof intent
            ),
          },
          runId,
          sequence: index + 7,
          timestamp: `2026-07-11T08:00:0${index}.000Z`,
          type: type as "DELIVERY_PUBLICATION_INTENT_RECORDED",
        })
      ),
    ];

    assert.strictEqual(
      (
        snapshotFromReplay(events.slice(0, 9)).context.delivery as {
          stage: string;
        }
      ).stage,
      "publicationOutcomeUnknown"
    );
    assert.strictEqual(
      (
        snapshotFromReplay(events.slice(0, 10)).context.delivery as {
          stage: string;
        }
      ).stage,
      "publicationFailed"
    );
    assert.strictEqual(
      (snapshotFromReplay(events).context.delivery as { stage: string }).stage,
      "publishing"
    );
  });

  it("rejects conflicting publication reuse for the same operation ID", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const intent = DeliveryPublicationIntent.make({
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      branchName: "gaia/run-V7kP9sQ2xY",
      commitMessage: "feat: deliver run-V7kP9sQ2xY",
      commitTimestamp: "2026-07-11T08:00:00.000Z",
      digestVersion: 1,
      operationId: "publish-run-V7kP9sQ2xY-1",
      payloadDigest: "b".repeat(64),
      sourcePaths: ["src/delivery.ts"],
      state: "intentRecorded",
    });
    const conflicting = DeliveryPublicationAttempted.make({
      ...intent,
      commitSha: "c".repeat(40),
      payloadDigest: "e".repeat(64),
      state: "attempted",
      treeSha: "d".repeat(40),
    });
    const events = [
      ...readyToPublishEvents(runId),
      makeRunEvent({
        payload: { publication: encodeDeliveryPublicationJson(intent) },
        runId,
        sequence: 7,
        timestamp: "2026-07-11T08:00:00.000Z",
        type: "DELIVERY_PUBLICATION_INTENT_RECORDED",
      }),
      makeRunEvent({
        payload: { publication: encodeDeliveryPublicationJson(conflicting) },
        runId,
        sequence: 8,
        timestamp: "2026-07-11T08:00:01.000Z",
        type: "DELIVERY_PUBLICATION_ATTEMPTED",
      }),
    ];

    assert.throws(() => snapshotFromReplay(events), /operation ID/u);
  });

  it("preserves known tree and commit identity through every same-operation outcome", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const base = {
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      branchName: "gaia/run-V7kP9sQ2xY",
      commitMessage: "feat: deliver run-V7kP9sQ2xY",
      commitTimestamp: "2026-07-11T08:00:00.000Z",
      digestVersion: 1 as const,
      operationId: "publish-run-V7kP9sQ2xY-1",
      payloadDigest: "b".repeat(64),
      sourcePaths: ["src/delivery.ts"],
    };
    const intent = DeliveryPublicationIntent.make({
      ...base,
      state: "intentRecorded",
      treeSha: "d".repeat(40),
    });
    const attempted = DeliveryPublicationAttempted.make({
      ...base,
      commitSha: "c".repeat(40),
      state: "attempted",
      treeSha: "d".repeat(40),
    });
    const conflictingOutcomes = [
      DeliveryPublicationConfirmed.make({
        ...attempted,
        draft: true,
        headSha: attempted.commitSha,
        prNumber: 91,
        prUrl: "https://github.com/cill-i-am/gaia/pull/91",
        state: "confirmed",
        treeSha: "e".repeat(40),
      }),
      DeliveryPublicationOutcomeUnknown.make({
        ...attempted,
        code: "DeliveryPublicationOutcomeUnknown",
        commitSha: "e".repeat(40),
        message: "External acceptance could not be confirmed.",
        recoverable: true,
        state: "outcomeUnknown",
        step: "push",
      }),
      DeliveryPublicationFailed.make({
        ...base,
        code: "DeliveryRemoteBranchConflict",
        commitSha: attempted.commitSha,
        message: "Remote ownership changed.",
        recoverable: false,
        state: "failed",
        step: "push",
      }),
      DeliveryPublicationOutcomeUnknown.make({
        ...base,
        code: "DeliveryPublicationOutcomeUnknown",
        message: "External acceptance could not be confirmed.",
        recoverable: true,
        state: "outcomeUnknown",
        step: "pullRequest",
        treeSha: attempted.treeSha,
      }),
    ];

    for (const outcome of conflictingOutcomes) {
      const events = [
        ...readyToPublishEvents(runId),
        ...[
          ["DELIVERY_PUBLICATION_INTENT_RECORDED", intent],
          ["DELIVERY_PUBLICATION_ATTEMPTED", attempted],
          [
            outcome.state === "confirmed"
              ? "DELIVERY_PUBLICATION_CONFIRMED"
              : outcome.state === "failed"
                ? "DELIVERY_PUBLICATION_FAILED"
                : "DELIVERY_PUBLICATION_OUTCOME_UNKNOWN",
            outcome,
          ],
        ].map(([type, publication], index) =>
          makeRunEvent({
            payload: {
              publication: encodeDeliveryPublicationJson(
                publication as typeof attempted
              ),
            },
            runId,
            sequence: index + 7,
            timestamp: `2026-07-11T08:00:0${index}.000Z`,
            type: type as "DELIVERY_PUBLICATION_ATTEMPTED",
          })
        ),
      ];

      assert.throws(() => snapshotFromReplay(events), /tree|commit/u);
    }

    const unknown = DeliveryPublicationOutcomeUnknown.make({
      ...attempted,
      code: "DeliveryPublicationOutcomeUnknown",
      message: "External acceptance could not be confirmed.",
      recoverable: true,
      state: "outcomeUnknown",
      step: "pullRequest",
    });
    const failedAfterUnknown = DeliveryPublicationFailed.make({
      ...unknown,
      code: "DeliveryPullRequestNotCreated",
      commitSha: "e".repeat(40),
      message: "No pull request exists.",
      state: "failed",
    });
    const events = [
      ...readyToPublishEvents(runId),
      ...[
        ["DELIVERY_PUBLICATION_INTENT_RECORDED", intent],
        ["DELIVERY_PUBLICATION_ATTEMPTED", attempted],
        ["DELIVERY_PUBLICATION_OUTCOME_UNKNOWN", unknown],
        ["DELIVERY_PUBLICATION_FAILED", failedAfterUnknown],
      ].map(([type, publication], index) =>
        makeRunEvent({
          payload: {
            publication: encodeDeliveryPublicationJson(
              publication as typeof attempted
            ),
          },
          runId,
          sequence: index + 7,
          timestamp: `2026-07-11T08:00:1${index}.000Z`,
          type: type as "DELIVERY_PUBLICATION_ATTEMPTED",
        })
      ),
    ];
    assert.throws(() => snapshotFromReplay(events), /commit/u);
  });

  it("rejects publication identity outside accepted delivery provenance", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const intent = DeliveryPublicationIntent.make({
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      branchName: "gaia/run-WrongBrn01",
      commitMessage: "feat: deliver run-V7kP9sQ2xY",
      commitTimestamp: "2026-07-11T08:00:00.000Z",
      digestVersion: 1,
      operationId: "publish-run-V7kP9sQ2xY-1",
      payloadDigest: "b".repeat(64),
      sourcePaths: ["src/delivery.ts"],
      state: "intentRecorded",
    });
    const events = [
      ...readyToPublishEvents(runId),
      makeRunEvent({
        payload: { publication: encodeDeliveryPublicationJson(intent) },
        runId,
        sequence: 7,
        timestamp: "2026-07-11T08:00:00.000Z",
        type: "DELIVERY_PUBLICATION_INTENT_RECORDED",
      }),
    ];

    assert.throws(
      () => snapshotFromReplay(events),
      /accepted delivery provenance/u
    );
  });

  it("replays read-only review evidence paths", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: {
          phase: "plan",
          reviewPath: "plan-review.md",
          reviewerSessionEvidencePath: "plan-reviewer-session.json",
        },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "REVIEW_COMPLETED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          phase: "evidence",
          reviewPath: "evidence-review.md",
          reviewerSessionEvidencePath: "evidence-reviewer-session.json",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "REVIEW_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 7,
        timestamp: "2026-07-04T10:00:06.000Z",
        type: "REPORT_COMPLETED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(
      durableSnapshot.context.planReviewPath,
      "plan-review.md"
    );
    assert.strictEqual(
      durableSnapshot.context.evidenceReviewPath,
      "evidence-review.md"
    );
    assert.strictEqual(
      durableSnapshot.context.planReviewerSessionPath,
      "plan-reviewer-session.json"
    );
    assert.strictEqual(
      durableSnapshot.context.evidenceReviewerSessionPath,
      "evidence-reviewer-session.json"
    );
  });

  it("replays GitHub check evidence without leaving completed state", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "REPORT_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          checksPath: "github-checks/checks-6.json",
          pullRequest: "1",
          status: "passed",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "GITHUB_CHECKS_RECORDED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 6);
    assert.strictEqual(
      durableSnapshot.context.githubChecksPath,
      "github-checks/checks-6.json"
    );
    assert.strictEqual(durableSnapshot.context.githubChecksStatus, "green");
    assert.strictEqual(durableSnapshot.context.githubPullRequest, "1");
  });

  it("replays GitHub feedback evidence without leaving completed state", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "REPORT_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          commentCount: 1,
          feedbackPath: "github-feedback.json",
          nextAction: "address-review-comments",
          pullRequest: "1",
          reviewCount: 1,
          reviewRequestCount: 0,
          status: "changes-requested",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "GITHUB_FEEDBACK_RECORDED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 6);
    assert.strictEqual(
      durableSnapshot.context.githubFeedbackPath,
      "github-feedback.json"
    );
    assert.strictEqual(
      durableSnapshot.context.githubFeedbackStatus,
      "changes-requested"
    );
    assert.strictEqual(
      durableSnapshot.context.githubFeedbackNextAction,
      "address-review-comments"
    );
    assert.strictEqual(durableSnapshot.context.githubPullRequest, "1");
    assert.strictEqual(durableSnapshot.context.githubFeedbackCommentCount, 1);
  });

  it("replays GitHub PR loop evidence without leaving completed state", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "REPORT_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          blockerCount: 2,
          nextAction: "address-review-comments",
          prLoopPath: "pr-loop-state.json",
          pullRequest: "1",
          status: "blocked",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "GITHUB_PR_LOOP_RECORDED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 6);
    assert.strictEqual(durableSnapshot.context.githubPullRequest, "1");
    assert.strictEqual(durableSnapshot.context.githubPrLoopBlockerCount, 2);
    assert.strictEqual(
      durableSnapshot.context.githubPrLoopNextAction,
      "address-review-comments"
    );
    assert.strictEqual(
      durableSnapshot.context.githubPrLoopPath,
      "pr-loop-state.json"
    );
    assert.strictEqual(durableSnapshot.context.githubPrLoopStatus, "blocked");
  });

  it("replays GitHub remediation spec evidence without leaving completed state", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "REPORT_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          blockerCount: 2,
          nextAction: "address-review-comments",
          pullRequest: "1",
          remediationSpecPath: "remediation-spec.md",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "GITHUB_REMEDIATION_SPEC_RECORDED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 6);
    assert.strictEqual(durableSnapshot.context.githubPullRequest, "1");
    assert.strictEqual(
      durableSnapshot.context.githubRemediationBlockerCount,
      2
    );
    assert.strictEqual(
      durableSnapshot.context.githubRemediationNextAction,
      "address-review-comments"
    );
    assert.strictEqual(
      durableSnapshot.context.githubRemediationSpecPath,
      "remediation-spec.md"
    );
  });

  it("replays GitHub PR comment evidence without leaving completed state", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "REPORT_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          commentPath: "github-pr-comment.md",
          commentUrl: "https://github.com/cill-i-am/gaia/pull/1#issuecomment-1",
          pullRequest: "1",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "GITHUB_PR_COMMENT_RECORDED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 6);
    assert.strictEqual(durableSnapshot.context.githubPullRequest, "1");
    assert.strictEqual(
      durableSnapshot.context.githubPrCommentPath,
      "github-pr-comment.md"
    );
    assert.strictEqual(
      durableSnapshot.context.githubPrCommentUrl,
      "https://github.com/cill-i-am/gaia/pull/1#issuecomment-1"
    );
  });

  it("replays Linear issue graph evidence without leaving completed state", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "REPORT_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          blockedByCount: 1,
          blocksCount: 2,
          issueGraphPath: "linear-issue-graph.json",
          issueIdentifier: "GAI-123",
          issueUrl: "https://linear.app/acme/issue/GAI-123/test",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "LINEAR_ISSUE_GRAPH_RECORDED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 6);
    assert.strictEqual(
      durableSnapshot.context.linearIssueGraphPath,
      "linear-issue-graph.json"
    );
    assert.strictEqual(
      durableSnapshot.context.linearIssueIdentifier,
      "GAI-123"
    );
    assert.strictEqual(
      durableSnapshot.context.linearIssueUrl,
      "https://linear.app/acme/issue/GAI-123/test"
    );
    assert.strictEqual(durableSnapshot.context.linearBlockedByCount, 1);
    assert.strictEqual(durableSnapshot.context.linearBlocksCount, 2);
  });

  it("replays merge decision evidence without leaving completed state", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "REPORT_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          blockerCount: 0,
          mergeDecisionPath: "merge-decision.json",
          nextAction: "ready-to-merge",
          pullRequest: "1",
          status: "approved",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "MERGE_DECISION_RECORDED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 6);
    assert.strictEqual(durableSnapshot.context.githubPullRequest, "1");
    assert.strictEqual(durableSnapshot.context.mergeDecisionBlockerCount, 0);
    assert.strictEqual(
      durableSnapshot.context.mergeDecisionNextAction,
      "ready-to-merge"
    );
    assert.strictEqual(
      durableSnapshot.context.mergeDecisionPath,
      "merge-decision.json"
    );
    assert.strictEqual(durableSnapshot.context.mergeDecisionStatus, "approved");
  });

  it("replays browser evidence without leaving completed state", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "REPORT_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          evidencePath: "browser-evidence.json",
          status: "collected",
          targetUrl: "http://localhost:3000",
        },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "BROWSER_EVIDENCE_RECORDED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 6);
    assert.strictEqual(
      durableSnapshot.context.browserEvidencePath,
      "browser-evidence.json"
    );
    assert.strictEqual(
      durableSnapshot.context.browserEvidenceStatus,
      "collected"
    );
    assert.strictEqual(
      durableSnapshot.context.browserEvidenceTargetUrl,
      "http://localhost:3000"
    );
  });

  it("replays browser evidence recorded before report completion", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          evidencePath: "browser-evidence.json",
          status: "collected",
          targetUrl: "http://localhost:3000",
        },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "BROWSER_EVIDENCE_RECORDED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "REPORT_COMPLETED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 6);
    assert.strictEqual(
      durableSnapshot.context.browserEvidencePath,
      "browser-evidence.json"
    );
    assert.strictEqual(
      durableSnapshot.context.browserEvidenceStatus,
      "collected"
    );
    assert.strictEqual(
      durableSnapshot.context.browserEvidenceTargetUrl,
      "http://localhost:3000"
    );
  });

  it("replays preview deployment evidence recorded before verification", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          deploymentPath: "preview-deployment.json",
          status: "available",
          url: "http://localhost:3000",
        },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "PREVIEW_DEPLOYMENT_RECORDED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 6,
        timestamp: "2026-07-04T10:00:05.000Z",
        type: "REPORT_COMPLETED",
      }),
    ];

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 6);
    assert.strictEqual(
      durableSnapshot.context.previewDeploymentPath,
      "preview-deployment.json"
    );
    assert.strictEqual(
      durableSnapshot.context.previewDeploymentStatus,
      "available"
    );
    assert.strictEqual(
      durableSnapshot.context.previewDeploymentUrl,
      "http://localhost:3000"
    );
  });

  it("rejects out-of-order event logs", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
    ];

    assert.throws(() => replayRunEvents(events));
  });
});

function readyToPublishEvents(runId: ReturnType<typeof parseRunId>) {
  const delivery = {
    baseBranch: "main",
    baseRevision: "a".repeat(40),
    headBranch: `gaia/${runId}`,
    mode: "pullRequest",
    remote: "origin",
  };
  return [
    makeRunEvent({
      payload: { delivery, specPath: "input.md" },
      runId,
      sequence: 1,
      timestamp: "2026-07-11T07:59:54.000Z",
      type: "RUN_CREATED",
    }),
    makeRunEvent({
      payload: { delivery: { ...delivery, stage: "delivering" } },
      runId,
      sequence: 2,
      timestamp: "2026-07-11T07:59:55.000Z",
      type: "DELIVERY_STARTED",
    }),
    makeRunEvent({
      payload: { workspacePath: "workspace" },
      runId,
      sequence: 3,
      timestamp: "2026-07-11T07:59:56.000Z",
      type: "WORKSPACE_PREPARED",
    }),
    makeRunEvent({
      payload: { workerResultPath: "worker-result.json" },
      runId,
      sequence: 4,
      timestamp: "2026-07-11T07:59:57.000Z",
      type: "WORKER_COMPLETED",
    }),
    makeRunEvent({
      payload: { verificationResultPath: "verification-result.json" },
      runId,
      sequence: 5,
      timestamp: "2026-07-11T07:59:58.000Z",
      type: "VERIFICATION_COMPLETED",
    }),
    makeRunEvent({
      payload: {
        delivery: { ...delivery, stage: "readyToPublish" },
        reportPath: "report.md",
      },
      runId,
      sequence: 6,
      timestamp: "2026-07-11T07:59:59.000Z",
      type: "DELIVERY_READY_TO_PUBLISH",
    }),
  ];
}
