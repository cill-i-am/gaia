import { assert, describe, it } from "@effect/vitest";
import {
  makeRunEvent,
  parseMarkdownSpec,
  parseRunId,
  replayRunEvents,
  snapshotFromReplay,
} from "./index.js";

describe("core contracts", () => {
  it("parses branded run ids", () => {
    assert.strictEqual(parseRunId("run-V7kP9sQ2xY"), "run-V7kP9sQ2xY");
    assert.throws(() => parseRunId("not-a-run"));
  });

  it("parses markdown specs with frontmatter", () => {
    const spec = parseMarkdownSpec(
      "---\ntitle: Smoke test\n---\n\nDo the smallest thing.",
      "fallback",
    );

    assert.strictEqual(spec.title, "Smoke test");
    assert.strictEqual(spec.body, "Do the smallest thing.");
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
    assert.strictEqual(durableSnapshot.context.planReviewPath, "plan-review.md");
    assert.strictEqual(
      durableSnapshot.context.evidenceReviewPath,
      "evidence-review.md",
    );
    assert.strictEqual(
      durableSnapshot.context.planReviewerSessionPath,
      "plan-reviewer-session.json",
    );
    assert.strictEqual(
      durableSnapshot.context.evidenceReviewerSessionPath,
      "evidence-reviewer-session.json",
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
      "github-checks/checks-6.json",
    );
    assert.strictEqual(durableSnapshot.context.githubChecksStatus, "passed");
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
      "github-feedback.json",
    );
    assert.strictEqual(
      durableSnapshot.context.githubFeedbackStatus,
      "changes-requested",
    );
    assert.strictEqual(
      durableSnapshot.context.githubFeedbackNextAction,
      "address-review-comments",
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
      "address-review-comments",
    );
    assert.strictEqual(
      durableSnapshot.context.githubPrLoopPath,
      "pr-loop-state.json",
    );
    assert.strictEqual(durableSnapshot.context.githubPrLoopStatus, "blocked");
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
      "browser-evidence.json",
    );
    assert.strictEqual(
      durableSnapshot.context.browserEvidenceStatus,
      "collected",
    );
    assert.strictEqual(
      durableSnapshot.context.browserEvidenceTargetUrl,
      "http://localhost:3000",
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
      "browser-evidence.json",
    );
    assert.strictEqual(
      durableSnapshot.context.browserEvidenceStatus,
      "collected",
    );
    assert.strictEqual(
      durableSnapshot.context.browserEvidenceTargetUrl,
      "http://localhost:3000",
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
      "preview-deployment.json",
    );
    assert.strictEqual(
      durableSnapshot.context.previewDeploymentStatus,
      "available",
    );
    assert.strictEqual(
      durableSnapshot.context.previewDeploymentUrl,
      "http://localhost:3000",
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
