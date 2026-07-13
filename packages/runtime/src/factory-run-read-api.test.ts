import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  DeliveryCleanupCompleted,
  DeliveryCleanupRequired,
  DeliveryMergeDispatchAttempted,
  DeliveryMergeDispatchConfirmed,
  DeliveryMergeIntent,
  DeliveryMergeReadinessDecision,
  encodeDeliveryCleanupReceiptJson,
  encodeDeliveryMergeReadinessDecisionJson,
  encodeDeliveryMergeReceiptJson,
  encodeWorkerRecoveryReceiptJson,
  parseHarnessProfileId,
  parseHarnessSessionId,
  parseRunId,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import {
  ReviewFinding,
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
} from "./reviewer.js";
import { makeRunPaths } from "./paths.js";
import {
  acceptFactoryRun,
  continueServerRun,
} from "./server-workflows.js";
import {
  listFactoryRunArtifacts,
  readFactoryAgentActivity,
  readFactoryGraph,
  readFactoryRunActivity,
  readFactoryRunArtifact,
} from "./factory-run-read-api.js";
import { makeTestHarnessProviderRegistry } from "./test-support.js";
import { appendEvent } from "./event-store.js";

const harnessProviderRegistry = makeTestHarnessProviderRegistry();

describe("factory run read api", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("creates an issueDelivery graph projection for an accepted factory run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-factory-run-" });

        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: "Deliver GAIA-66 runtime projection.",
              externalRefs: [
                {
                  id: "GAIA-66",
                  provider: "linear",
                  url: "https://linear.app/tskr/issue/GAIA-66",
                },
              ],
              kind: "issue",
              title: "Implement issueDelivery runtime projection",
            },
          },
          { harnessProviderRegistry, rootDirectory: cwd },
        );

        const graph = yield* readFactoryGraph(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(graph.runId, accepted.runId);
        assert.strictEqual(graph.workflow, "issueDelivery");
        assert.deepEqual(
          graph.workItems.map((item) => ({
            externalRefs: item.externalRefs.map((ref) => ({
              id: ref.id,
              provider: ref.provider,
              url: ref.url,
            })),
            kind: item.kind,
            title: item.title,
          })),
          [
            {
              externalRefs: [
                {
                  id: "GAIA-66",
                  provider: "linear",
                  url: "https://linear.app/tskr/issue/GAIA-66",
                },
              ],
              kind: "issue",
              title: "Implement issueDelivery runtime projection",
            },
          ],
        );
        assert.deepEqual(
          graph.agents.map((agent) => ({
            parentAgentId: agent.parentAgentId,
            role: agent.role,
            state: agent.state,
            title: agent.title,
          })),
          [
            {
              parentAgentId: undefined,
              role: "orchestrator",
              state: "running",
              title: "Issue orchestrator",
            },
            {
              parentAgentId: "agent-orchestrator",
              role: "worker",
              state: "pending",
              title: "Worker",
            },
            {
              parentAgentId: "agent-worker",
              role: "reviewer",
              state: "pending",
              title: "Reviewer",
            },
            {
              parentAgentId: "agent-reviewer",
              role: "tester",
              state: "pending",
              title: "Tester",
            },
            {
              parentAgentId: "agent-tester",
              role: "ciWatcher",
              state: "unknown",
              title: "CI watcher",
            },
          ],
        );
        assert.deepEqual(
          graph.edges.map((edge) => edge.type),
          ["owns", "spawned", "reviewed", "tested", "watched"],
        );
        assert.deepInclude(
          graph.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            recoverable: diagnostic.recoverable,
          })),
          {
            code: "FactoryCiWatcherUnavailable",
            message:
              "CI watcher state is unavailable until PR/check evidence is recorded.",
            recoverable: true,
          },
        );
      }),
    );

    it.effect("rebuilds completed run indexes with agent-scoped activity and artifact metadata", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-factory-run-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry,
          rootDirectory: cwd,
        });

        yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry,
          rootDirectory: cwd,
        });
        const graph = yield* readFactoryGraph(accepted.runId, {
          rootDirectory: cwd,
        });
        const runActivity = yield* readFactoryRunActivity(accepted.runId, {
          rootDirectory: cwd,
        });
        const workerActivity = yield* readFactoryAgentActivity(
          accepted.runId,
          "agent-worker",
          { rootDirectory: cwd },
        );
        const artifacts = yield* listFactoryRunArtifacts(accepted.runId, {
          rootDirectory: cwd,
        });
        const workerPlan = yield* readFactoryRunArtifact(
          accepted.runId,
          "worker-plan",
          { rootDirectory: cwd },
        );

        assert.deepInclude(
          graph.agents.map((agent) => ({
            artifactCount: agent.artifactCount,
            role: agent.role,
            state: agent.state,
          })),
          { artifactCount: 4, role: "worker", state: "succeeded" },
        );
        assert.deepInclude(
          graph.agents.map((agent) => ({
            role: agent.role,
            state: agent.state,
          })),
          { role: "tester", state: "succeeded" },
        );
        assert.deepEqual(
          runActivity.activities.map((activity) => activity.sequence),
          Array.from(
            { length: runActivity.activities.length },
            (_item, index) => index + 1,
          ),
        );
        assert.deepEqual(
          workerActivity.activities.map(
            (activity: { readonly kind: string }) => activity.kind,
          ),
          [
            "WORKER_STARTED",
            "HARNESS_SESSION_EVENT_RECORDED",
            "HARNESS_SESSION_EVENT_RECORDED",
            "HARNESS_SESSION_EVENT_RECORDED",
            "WORKER_COMPLETED",
          ],
        );
        assert.deepInclude(
          artifacts.artifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            kind: artifact.kind,
            ownerAgentId: artifact.ownerAgentId,
            visibility: artifact.visibility,
          })),
          {
            artifactId: "worker-plan",
            kind: "plan",
            ownerAgentId: "agent-worker",
            visibility: "run",
          },
        );
        assert.strictEqual(workerPlan.artifactId, "worker-plan");
        assert.strictEqual(workerPlan.contentType, "application/json");
        assert.include(workerPlan.body, accepted.runId);
      }),
    );

    it.effect("replays a readiness decision without reading remediation payload", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-factory-readiness-replay-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), { harnessProviderRegistry, rootDirectory: cwd });
        const runId = parseRunId(accepted.runId);
        const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
        const decision = DeliveryMergeReadinessDecision.make({ actionId: "readiness-1", approved: false, blockers: ["not ready"], branchName: "gaia/run-1234567890", headSha: "a".repeat(40), mergeMethod: "merge", payloadDigest: "b".repeat(64), policyDigest: "c".repeat(64), policyVersion: 1, prNumber: 74, prUrl: "https://github.com/cill-i-am/gaia/pull/74" });
        yield* appendEvent(runId, paths, { payload: { decision: encodeDeliveryMergeReadinessDecisionJson(decision) }, type: "DELIVERY_MERGE_READINESS_RECORDED" });
        const graph = yield* readFactoryGraph(runId, { rootDirectory: cwd });
        assert.strictEqual(graph.runId, runId);
      }),
    );

    it.effect("settles the recovered delivery graph after confirmed merge and completed cleanup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-factory-terminal-delivery-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry,
          rootDirectory: cwd,
        });
        const runId = parseRunId(accepted.runId);
        const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
        const branchName = `gaia/${runId}`;
        const headSha = "a".repeat(40);
        const mergeCommitSha = "d".repeat(40);
        const provenance = { baseBranch: "main", baseRevision: "0".repeat(40), headBranch: branchName, mode: "pullRequest" as const, remote: "origin" };

        yield* appendEvent(runId, paths, { payload: { delivery: { ...provenance, stage: "delivering" } }, type: "DELIVERY_STARTED" });
        yield* appendEvent(runId, paths, { payload: { code: "HarnessSessionFailed", message: "Worker recovery required.", recoverable: true, stage: "runningWorker" }, type: "RUN_FAILED" });
        yield* appendEvent(runId, paths, {
          payload: { recovery: encodeWorkerRecoveryReceiptJson({ actionId: "recover-terminal-1", attempt: 1, expectedFailureSequence: 3, expectedSessionId: parseHarnessSessionId(`session-${runId}`), harnessProfileId: parseHarnessProfileId("codexAppServer"), maxAttempts: 1, model: "gpt-5.4", nativeTurnIdDigest: "7".repeat(64), payloadDigest: "8".repeat(64), state: "dispatchConfirmed" }) },
          type: "WORKER_RECOVERY_RECORDED",
        });
        yield* appendEvent(runId, paths, { payload: { workerResultPath: "worker-result.json" }, type: "WORKER_COMPLETED" });
        yield* appendEvent(runId, paths, { payload: { verificationResultPath: "verification.json" }, type: "VERIFICATION_COMPLETED" });
        yield* appendEvent(runId, paths, { payload: { delivery: { ...provenance, stage: "readyToPublish" }, reportPath: "report.md" }, type: "DELIVERY_READY_TO_PUBLISH" });

        const decision = DeliveryMergeReadinessDecision.make({ actionId: "readiness-terminal-1", approved: true, blockers: [], branchName, headSha, mergeMethod: "merge", payloadDigest: "5".repeat(64), policyDigest: "4".repeat(64), policyVersion: 1, prNumber: 94, prUrl: "https://github.com/cill-i-am/gaia/pull/94" });
        yield* appendEvent(runId, paths, { payload: { decision: encodeDeliveryMergeReadinessDecisionJson(decision) }, type: "DELIVERY_MERGE_READINESS_RECORDED" });
        const mergeBinding = { actionId: "merge-terminal-1", branchName, decisionSequence: 8, expectedHeadSha: headSha, mergeMethod: "merge" as const, payloadDigest: "3".repeat(64), policyDigest: decision.policyDigest, policyVersion: 1 as const, prNumber: 94, prUrl: decision.prUrl, repository: "cill-i-am/gaia" };
        const mergeReceipts = [
          DeliveryMergeIntent.make({ ...mergeBinding, state: "intentRecorded" }),
          DeliveryMergeDispatchAttempted.make({ ...mergeBinding, state: "dispatchAttempted" }),
          DeliveryMergeDispatchConfirmed.make({ ...mergeBinding, mergeCommitSha, mergedAt: "2026-07-13T12:01:00.000Z", state: "dispatchConfirmed" }),
        ];
        for (const mergeAction of mergeReceipts) {
          yield* appendEvent(runId, paths, { payload: { mergeAction: encodeDeliveryMergeReceiptJson(mergeAction) }, type: "DELIVERY_MERGE_RECORDED" });
        }
        const cleanupRequired = DeliveryCleanupRequired.make({ actionId: "cleanup-terminal-1", branch: "present", branchName, mergeCommitSha, ownershipDigest: "6".repeat(64), state: "cleanupRequired", worktree: "absent" });
        yield* appendEvent(runId, paths, { payload: { cleanup: encodeDeliveryCleanupReceiptJson(cleanupRequired) }, type: "DELIVERY_CLEANUP_RECORDED" });
        yield* appendEvent(runId, paths, { payload: { cleanup: encodeDeliveryCleanupReceiptJson(DeliveryCleanupCompleted.make({ actionId: cleanupRequired.actionId, branch: "absent", branchName, mergeCommitSha, ownershipDigest: cleanupRequired.ownershipDigest, state: "completed", worktree: "absent" })) }, type: "DELIVERY_CLEANUP_RECORDED" });

        const graph = yield* readFactoryGraph(runId, { rootDirectory: cwd });
        const states = new Map(graph.agents.map(({ role, state }) => [role, state]));
        assert.strictEqual(states.get("orchestrator"), "succeeded");
        assert.strictEqual(states.get("ciWatcher"), "succeeded");
        assert.notInclude(graph.agents.map(({ state }) => state), "running");
      }),
    );

    it.effect("projects failed factory runs from events.jsonl without requiring successful artifacts", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-factory-run-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry,
          rootDirectory: cwd,
        });

        yield* Effect.flip(
          continueServerRun(accepted.runId, {
            harnessProviderRegistry,
            reviewer: blockingReviewer(),
            rootDirectory: cwd,
          }),
        );
        const graph = yield* readFactoryGraph(accepted.runId, {
          rootDirectory: cwd,
        });
        const activity = yield* readFactoryRunActivity(accepted.runId, {
          rootDirectory: cwd,
        });
        const reviewerActivity = yield* readFactoryAgentActivity(
          accepted.runId,
          "agent-reviewer",
          { rootDirectory: cwd },
        );

        assert.deepInclude(
          graph.agents.map((agent) => ({
            role: agent.role,
            state: agent.state,
          })),
          { role: "reviewer", state: "failed" },
        );
        assert.strictEqual(activity.activities.at(-1)?.kind, "RUN_FAILED");
        assert.strictEqual(activity.activities.at(-1)?.state, "failed");
        assert.strictEqual(reviewerActivity.activities.at(-1)?.kind, "RUN_FAILED");
      }),
    );

    it.effect("rebuilds missing and corrupt derived indexes with typed diagnostics", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-factory-run-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry,
          rootDirectory: cwd,
        });
        const paths = yield* makeRunPaths(accepted.runId, { rootDirectory: cwd });

        yield* fs.remove(paths.factoryGraph);
        const rebuiltMissing = yield* readFactoryGraph(accepted.runId, {
          rootDirectory: cwd,
        });
        assert.deepInclude(
          diagnosticSummaries(rebuiltMissing.diagnostics),
          {
            code: "FactoryProjectionIndexMissing",
            recoverable: true,
            sourceId: "factory-graph.json",
          },
        );

        yield* fs.writeFileString(paths.factoryGraph, "{ not json");
        const rebuiltCorrupt = yield* readFactoryGraph(accepted.runId, {
          rootDirectory: cwd,
        });
        assert.deepInclude(
          diagnosticSummaries(rebuiltCorrupt.diagnostics),
          {
            code: "FactoryGraphIndexInvalid",
            recoverable: true,
            sourceId: "factory-graph.json",
          },
        );

        yield* fs.writeFileString(
          paths.factoryActivityIndex,
          `${JSON.stringify({ activities: [], runId: accepted.runId })}\n`,
        );
        const rebuiltStale = yield* readFactoryGraph(accepted.runId, {
          rootDirectory: cwd,
        });
        assert.deepInclude(
          diagnosticSummaries(rebuiltStale.diagnostics),
          {
            code: "FactoryActivityIndexStale",
            recoverable: true,
            sourceId: "activity-index.json",
          },
        );
      }),
    );
  });
});

function factoryCreateInput() {
  return {
    execution: codexAppServerExecutionSelection,
    workflow: "issueDelivery",
    workItem: {
      description: "Deliver GAIA-66 runtime projection.",
      externalRefs: [
        {
          id: "GAIA-66",
          provider: "linear",
          url: "https://linear.app/tskr/issue/GAIA-66",
        },
      ],
      kind: "issue",
      title: "Implement issueDelivery runtime projection",
    },
  } as const;
}

function diagnosticSummaries(
  diagnostics: ReadonlyArray<{
    readonly code: string;
    readonly recoverable: boolean;
    readonly sourceId?: string;
  }>,
) {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    recoverable: diagnostic.recoverable,
    ...(diagnostic.sourceId === undefined
      ? {}
      : { sourceId: diagnostic.sourceId }),
  }));
}

function blockingReviewer(): GaiaReviewer {
  const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
    "factory-blocking-reviewer",
  );

  return {
    name: reviewerName,
    run: (request) =>
      Effect.succeed(
        ReviewResult.make({
          findings: [
            ReviewFinding.make({
              message: "Factory projection expected failure.",
              severity: "blocker",
            }),
          ],
          phase: request.phase,
          resultPath:
            request.phase === "plan"
              ? "plan-review.json"
              : "evidence-review.json",
          reviewerName,
          runId: request.runId,
          status: request.phase === "plan" ? "blocked" : "approved",
          summary: "Factory projection expected failure.",
        }),
      ),
  };
}
