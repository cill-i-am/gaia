import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  CreateRunRequest,
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
  FactoryArtifactIdSchema,
  FactoryGraphDiagnosticDto,
  FactoryGraphDto,
  parseHarnessProfileId,
  parseHarnessSessionId,
  parseRunId,
  RunIdSchema,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { appendEvent } from "./event-store.js";
import {
  listFactoryRunArtifacts,
  readFactoryAgentActivity,
  readFactoryGraph,
  readFactoryRunActivity,
  readFactoryRunArtifact,
} from "./factory-run-read-api.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import { makeRunPaths, parseRuntimePath, RuntimePathSchema } from "./paths.js";
import {
  ReviewFinding,
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
} from "./reviewer.js";
import { acceptFactoryRun, continueServerRun } from "./server-workflows.js";
import { makeTestHarnessProviderRegistry } from "./test-support.js";

const harnessProviderRegistry = makeTestHarnessProviderRegistry();
const decodeCreateRunRequest = Schema.decodeUnknownSync(CreateRunRequest);
const decodeFactoryArtifactId = Schema.decodeUnknownSync(
  FactoryArtifactIdSchema
);
const encodeFactoryGraph = Schema.encodeSync(FactoryGraphDto);
const workerPlanArtifactId = decodeFactoryArtifactId("worker-plan");

describe("factory run read api", () => {
  it.prop(
    "round-trips generated runtime paths through their canonical schema",
    { runtimePath: Schema.toArbitrary(RuntimePathSchema) },
    ({ runtimePath }) => {
      assert.strictEqual(parseRuntimePath(runtimePath), runtimePath);
    }
  );

  layer(NodeServices.layer)((it) => {
    it.effect(
      "creates an issueDelivery graph projection for an accepted factory run",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-run-",
          });
          const createInput = factoryCreateInput();

          const accepted = yield* acceptFactoryRun(createInput, {
            harnessProviderRegistry,
            rootDirectory: cwd,
          });

          const graph = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          const expectedExternalRefs = (
            createInput.workItem.externalRefs ?? []
          ).map((ref) => ({
            id: ref.id,
            provider: ref.provider,
            url: ref.url,
          }));

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
                externalRefs: expectedExternalRefs,
                kind: "issue",
                title: "Implement issueDelivery runtime projection",
              },
            ]
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
            ]
          );
          assert.deepEqual(
            graph.edges.map((edge) => edge.type),
            ["owns", "spawned", "reviewed", "tested", "watched"]
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
            }
          );
        })
    );

    it.effect(
      "rebuilds completed run indexes with agent-scoped activity and artifact metadata",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-run-",
          });
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
            issueDeliveryAgentIds.worker,
            { rootDirectory: cwd }
          );
          const artifacts = yield* listFactoryRunArtifacts(accepted.runId, {
            rootDirectory: cwd,
          });
          const workerPlan = yield* readFactoryRunArtifact(
            accepted.runId,
            workerPlanArtifactId,
            { rootDirectory: cwd }
          );

          assert.deepInclude(
            graph.agents.map((agent) => ({
              artifactCount: agent.artifactCount,
              role: agent.role,
              state: agent.state,
            })),
            { artifactCount: 4, role: "worker", state: "succeeded" }
          );
          assert.deepInclude(
            graph.agents.map((agent) => ({
              role: agent.role,
              state: agent.state,
            })),
            { role: "tester", state: "succeeded" }
          );
          assert.deepEqual(
            runActivity.activities.map((activity) => activity.sequence),
            Array.from(
              { length: runActivity.activities.length },
              (_item, index) => index + 1
            )
          );
          assert.deepEqual(
            workerActivity.activities.map((activity) => activity.kind),
            [
              "WORKER_STARTED",
              "HARNESS_SESSION_EVENT_RECORDED",
              "HARNESS_SESSION_EVENT_RECORDED",
              "HARNESS_SESSION_EVENT_RECORDED",
              "WORKER_COMPLETED",
            ]
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
            }
          );
          assert.strictEqual(workerPlan.artifactId, "worker-plan");
          assert.strictEqual(workerPlan.contentType, "application/json");
          assert.include(workerPlan.body, accepted.runId);
        })
    );

    it.effect(
      "replays a readiness decision without reading remediation payload",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-readiness-replay-",
          });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry,
            rootDirectory: cwd,
          });
          const runId = parseRunId(accepted.runId);
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          const decision = DeliveryMergeReadinessDecision.make({
            actionId: "readiness-1",
            approved: false,
            blockers: ["not ready"],
            branchName: "gaia/run-1234567890",
            headSha: "a".repeat(40),
            mergeMethod: "merge",
            payloadDigest: "b".repeat(64),
            policyDigest: "c".repeat(64),
            policyVersion: 1,
            prNumber: 74,
            prUrl: "https://github.com/cill-i-am/gaia/pull/74",
          });
          yield* appendEvent(runId, paths, {
            payload: {
              decision: encodeDeliveryMergeReadinessDecisionJson(decision),
            },
            type: "DELIVERY_MERGE_READINESS_RECORDED",
          });
          const graph = yield* readFactoryGraph(runId, { rootDirectory: cwd });
          assert.strictEqual(graph.runId, runId);
        })
    );

    it.effect(
      "settles the recovered delivery graph after confirmed merge and completed cleanup",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-terminal-delivery-",
          });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry,
            rootDirectory: cwd,
          });
          yield* appendTerminalDeliveryHistory(
            accepted.runId,
            parseRuntimePath(cwd)
          );

          const graph = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          const paths = yield* makeRunPaths(accepted.runId, {
            rootDirectory: cwd,
          });
          const states = new Map(
            graph.agents.map(({ role, state }) => [role, state])
          );
          assert.strictEqual(states.get("orchestrator"), "succeeded");
          assert.strictEqual(states.get("ciWatcher"), "succeeded");
          assert.notInclude(
            graph.agents.map(({ state }) => state),
            "running"
          );
          const encodedGraph = encodeFactoryGraph(graph);
          yield* fs.writeFileString(
            paths.factoryGraph,
            `${JSON.stringify(
              {
                ...encodedGraph,
                diagnostics: encodedGraph.diagnostics.filter(
                  ({ code, sourceId }) =>
                    code !== "FactoryProjectionIndexStale" ||
                    sourceId !== "factory-graph.json"
                ),
              },
              null,
              2
            )}\n`
          );
          const compatible = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          const graphBytes = yield* fs.readFileString(paths.factoryGraph);
          const repeated = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          assert.isFalse(
            compatible.diagnostics.some(
              ({ code, sourceId }) =>
                code === "FactoryProjectionIndexStale" &&
                sourceId === "factory-graph.json"
            )
          );
          assert.deepEqual(repeated, compatible);
          assert.strictEqual(
            yield* fs.readFileString(paths.factoryGraph),
            graphBytes
          );
        })
    );

    it.effect(
      "rebuilds a schema-valid pre-settlement graph after terminal cleanup",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-terminal-index-compatibility-",
          });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry,
            rootDirectory: cwd,
          });
          const { paths } = yield* appendTerminalDeliveryHistory(
            accepted.runId,
            parseRuntimePath(cwd)
          );
          const currentGraph = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          const activityBefore = yield* readFactoryRunActivity(accepted.runId, {
            rootDirectory: cwd,
          });
          const artifactsBefore = yield* listFactoryRunArtifacts(
            accepted.runId,
            {
              rootDirectory: cwd,
            }
          );
          const eventsBefore = yield* fs.readFileString(paths.events);
          const encodedGraph = encodeFactoryGraph(currentGraph);
          const oldGraph = {
            ...encodedGraph,
            agents: encodedGraph.agents.map((agent) =>
              agent.role === "ciWatcher"
                ? { ...agent, state: "running" as const }
                : agent
            ),
          };
          yield* fs.writeFileString(
            paths.factoryGraph,
            `${JSON.stringify(oldGraph, null, 2)}\n`
          );

          const repaired = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          const repairedBytes = yield* fs.readFileString(paths.factoryGraph);
          const repeated = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          const repeatedBytes = yield* fs.readFileString(paths.factoryGraph);
          const activityAfter = yield* readFactoryRunActivity(accepted.runId, {
            rootDirectory: cwd,
          });
          const artifactsAfter = yield* listFactoryRunArtifacts(
            accepted.runId,
            {
              rootDirectory: cwd,
            }
          );

          assert.strictEqual(repaired.version, 1);
          assert.deepEqual(
            repaired.agents
              .filter(
                ({ role }) => role === "orchestrator" || role === "ciWatcher"
              )
              .map(({ role, state }) => ({ role, state })),
            [
              { role: "orchestrator", state: "succeeded" },
              { role: "ciWatcher", state: "succeeded" },
            ]
          );
          assert.deepEqual(repaired.edges, currentGraph.edges);
          assert.deepEqual(repaired.execution, currentGraph.execution);
          assert.deepEqual(
            repaired.linkedArtifacts,
            currentGraph.linkedArtifacts
          );
          assert.deepEqual(repaired.workItems, currentGraph.workItems);
          assert.deepEqual(
            repaired.agents.filter(
              ({ role }) => role !== "orchestrator" && role !== "ciWatcher"
            ),
            currentGraph.agents.filter(
              ({ role }) => role !== "orchestrator" && role !== "ciWatcher"
            )
          );
          assert.deepEqual(activityAfter, activityBefore);
          assert.deepEqual(artifactsAfter, artifactsBefore);
          assert.strictEqual(
            yield* fs.readFileString(paths.events),
            eventsBefore
          );
          assert.deepEqual(
            repaired.diagnostics
              .filter(
                ({ code, sourceId }) =>
                  code === "FactoryProjectionIndexStale" &&
                  sourceId === "factory-graph.json"
              )
              .map(({ code, message, recoverable, sourceId }) => ({
                code,
                message,
                recoverable,
                sourceId,
              })),
            [
              {
                code: "FactoryProjectionIndexStale",
                message:
                  "factory-graph.json conflicted with terminal delivery cleanup and was rebuilt from events.jsonl.",
                recoverable: true,
                sourceId: "factory-graph.json",
              },
            ]
          );
          assert.deepEqual(repeated, repaired);
          assert.strictEqual(repeatedBytes, repairedBytes);
        })
    );

    it.effect(
      "rejects noncanonical terminal agent entries in a valid v1 graph",
      () =>
        Effect.gen(function* () {
          for (const defect of [
            "orchestratorState",
            "missingOrchestrator",
            "duplicateOrchestrator",
            "orchestratorId",
            "missingCiWatcher",
            "duplicateCiWatcher",
            "ciWatcherId",
          ] as const) {
            const fs = yield* FileSystem.FileSystem;
            const cwd = yield* fs.makeTempDirectory({
              prefix: `gaia-factory-terminal-${defect}-`,
            });
            const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
              harnessProviderRegistry,
              rootDirectory: cwd,
            });
            const { paths } = yield* appendTerminalDeliveryHistory(
              accepted.runId,
              parseRuntimePath(cwd)
            );
            const currentGraph = yield* readFactoryGraph(accepted.runId, {
              rootDirectory: cwd,
            });
            const encodedGraph = encodeFactoryGraph(currentGraph);
            let agents = [...encodedGraph.agents];

            switch (defect) {
              case "orchestratorState":
                agents = agents.map((agent) =>
                  agent.role === "orchestrator"
                    ? { ...agent, state: "blocked" as const }
                    : agent
                );
                break;
              case "missingOrchestrator":
                agents = agents.filter(({ role }) => role !== "orchestrator");
                break;
              case "duplicateOrchestrator":
                agents = agents.flatMap((agent) =>
                  agent.role === "orchestrator"
                    ? [agent, { ...agent, id: "agent-orchestrator-duplicate" }]
                    : [agent]
                );
                break;
              case "orchestratorId":
                agents = agents.map((agent) =>
                  agent.role === "orchestrator"
                    ? { ...agent, id: "agent-orchestrator-old" }
                    : agent
                );
                break;
              case "missingCiWatcher":
                agents = agents.filter(({ role }) => role !== "ciWatcher");
                break;
              case "duplicateCiWatcher":
                agents = agents.flatMap((agent) =>
                  agent.role === "ciWatcher"
                    ? [agent, { ...agent, id: "agent-ci-watcher-duplicate" }]
                    : [agent]
                );
                break;
              case "ciWatcherId":
                agents = agents.map((agent) =>
                  agent.role === "ciWatcher"
                    ? { ...agent, id: "agent-ci-watcher-old" }
                    : agent
                );
                break;
            }
            yield* fs.writeFileString(
              paths.factoryGraph,
              `${JSON.stringify({ ...encodedGraph, agents }, null, 2)}\n`
            );

            const repaired = yield* readFactoryGraph(accepted.runId, {
              rootDirectory: cwd,
            });
            const terminalAgents = repaired.agents.filter(
              ({ role }) => role === "orchestrator" || role === "ciWatcher"
            );
            assert.deepEqual(
              terminalAgents.map(({ id, role, state }) => ({
                id,
                role,
                state,
              })),
              [
                {
                  id: "agent-orchestrator",
                  role: "orchestrator",
                  state: "succeeded",
                },
                {
                  id: "agent-ci-watcher",
                  role: "ciWatcher",
                  state: "succeeded",
                },
              ],
              defect
            );
            assert.lengthOf(
              repaired.diagnostics.filter(
                ({ code, sourceId }) =>
                  code === "FactoryProjectionIndexStale" &&
                  sourceId === "factory-graph.json"
              ),
              1,
              defect
            );
          }
        })
    );

    it.effect("preserves valid nonterminal graph caches", () =>
      Effect.gen(function* () {
        for (const cleanupState of ["none", "cleanupRequired"] as const) {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: `gaia-factory-nonterminal-${cleanupState}-`,
          });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry,
            rootDirectory: cwd,
          });
          const { paths } = yield* appendTerminalDeliveryHistory(
            accepted.runId,
            parseRuntimePath(cwd),
            cleanupState
          );
          const graph = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          const graphBytes = yield* fs.readFileString(paths.factoryGraph);
          const eventsBytes = yield* fs.readFileString(paths.events);

          const repeated = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.deepEqual(repeated, graph, cleanupState);
          assert.strictEqual(
            yield* fs.readFileString(paths.factoryGraph),
            graphBytes,
            cleanupState
          );
          assert.strictEqual(
            yield* fs.readFileString(paths.events),
            eventsBytes,
            cleanupState
          );
          assert.isFalse(
            graph.diagnostics.some(
              ({ code, sourceId }) =>
                code === "FactoryProjectionIndexStale" &&
                sourceId === "factory-graph.json"
            ),
            cleanupState
          );
        }
      })
    );

    it.effect(
      "projects failed factory runs from events.jsonl without requiring successful artifacts",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-run-",
          });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry,
            rootDirectory: cwd,
          });

          yield* Effect.flip(
            continueServerRun(accepted.runId, {
              harnessProviderRegistry,
              reviewer: blockingReviewer(),
              rootDirectory: cwd,
            })
          );
          const graph = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          const activity = yield* readFactoryRunActivity(accepted.runId, {
            rootDirectory: cwd,
          });
          const reviewerActivity = yield* readFactoryAgentActivity(
            accepted.runId,
            issueDeliveryAgentIds.reviewer,
            { rootDirectory: cwd }
          );

          assert.deepInclude(
            graph.agents.map((agent) => ({
              role: agent.role,
              state: agent.state,
            })),
            { role: "reviewer", state: "failed" }
          );
          assert.strictEqual(activity.activities.at(-1)?.kind, "RUN_FAILED");
          assert.strictEqual(activity.activities.at(-1)?.state, "failed");
          assert.strictEqual(
            reviewerActivity.activities.at(-1)?.kind,
            "RUN_FAILED"
          );
        })
    );

    it.effect(
      "rebuilds missing and corrupt derived indexes with typed diagnostics",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-run-",
          });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry,
            rootDirectory: cwd,
          });
          const paths = yield* makeRunPaths(accepted.runId, {
            rootDirectory: cwd,
          });

          yield* fs.remove(paths.factoryGraph);
          const rebuiltMissing = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          assert.deepInclude(diagnosticSummaries(rebuiltMissing.diagnostics), {
            code: "FactoryProjectionIndexMissing",
            recoverable: true,
            sourceId: "factory-graph.json",
          });

          yield* fs.writeFileString(paths.factoryGraph, "{ not json");
          const rebuiltCorrupt = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          assert.deepInclude(diagnosticSummaries(rebuiltCorrupt.diagnostics), {
            code: "FactoryGraphIndexInvalid",
            recoverable: true,
            sourceId: "factory-graph.json",
          });

          yield* fs.writeFileString(
            paths.factoryActivityIndex,
            `${JSON.stringify({ activities: [], runId: accepted.runId })}\n`
          );
          const rebuiltStale = yield* readFactoryGraph(accepted.runId, {
            rootDirectory: cwd,
          });
          assert.deepInclude(diagnosticSummaries(rebuiltStale.diagnostics), {
            code: "FactoryActivityIndexStale",
            recoverable: true,
            sourceId: "activity-index.json",
          });
        })
    );
  });
});

function factoryCreateInput() {
  return decodeCreateRunRequest({
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
  });
}

function appendTerminalDeliveryHistory(
  runId: typeof RunIdSchema.Type,
  rootDirectory: typeof RuntimePathSchema.Type,
  cleanupState: "none" | "cleanupRequired" | "completed" = "completed"
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    const branchName = `gaia/${runId}`;
    const headSha = "a".repeat(40);
    const mergeCommitSha = "d".repeat(40);
    const provenance = {
      baseBranch: "main",
      baseRevision: "0".repeat(40),
      headBranch: branchName,
      mode: "pullRequest" as const,
      remote: "origin",
    };

    yield* appendEvent(runId, paths, {
      payload: { delivery: { ...provenance, stage: "delivering" } },
      type: "DELIVERY_STARTED",
    });
    yield* appendEvent(runId, paths, {
      payload: {
        code: "HarnessSessionFailed",
        message: "Worker recovery required.",
        recoverable: true,
        stage: "runningWorker",
      },
      type: "RUN_FAILED",
    });
    yield* appendEvent(runId, paths, {
      payload: {
        recovery: encodeWorkerRecoveryReceiptJson({
          actionId: "recover-terminal-1",
          attempt: 1,
          expectedFailureSequence: 3,
          expectedSessionId: parseHarnessSessionId(`session-${runId}`),
          harnessProfileId: parseHarnessProfileId("codexAppServer"),
          maxAttempts: 1,
          model: "gpt-5.4",
          nativeTurnIdDigest: "7".repeat(64),
          payloadDigest: "8".repeat(64),
          state: "dispatchConfirmed",
        }),
      },
      type: "WORKER_RECOVERY_RECORDED",
    });
    yield* appendEvent(runId, paths, {
      payload: { workerResultPath: "worker-result.json" },
      type: "WORKER_COMPLETED",
    });
    yield* appendEvent(runId, paths, {
      payload: { verificationResultPath: "verification.json" },
      type: "VERIFICATION_COMPLETED",
    });
    yield* appendEvent(runId, paths, {
      payload: {
        delivery: { ...provenance, stage: "readyToPublish" },
        reportPath: "report.md",
      },
      type: "DELIVERY_READY_TO_PUBLISH",
    });

    const decision = DeliveryMergeReadinessDecision.make({
      actionId: "readiness-terminal-1",
      approved: true,
      blockers: [],
      branchName,
      headSha,
      mergeMethod: "merge",
      payloadDigest: "5".repeat(64),
      policyDigest: "4".repeat(64),
      policyVersion: 1,
      prNumber: 94,
      prUrl: "https://github.com/cill-i-am/gaia/pull/94",
    });
    yield* appendEvent(runId, paths, {
      payload: {
        decision: encodeDeliveryMergeReadinessDecisionJson(decision),
      },
      type: "DELIVERY_MERGE_READINESS_RECORDED",
    });
    const mergeBinding = {
      actionId: "merge-terminal-1",
      branchName,
      decisionSequence: 8,
      expectedHeadSha: headSha,
      mergeMethod: "merge" as const,
      payloadDigest: "3".repeat(64),
      policyDigest: decision.policyDigest,
      policyVersion: 1 as const,
      prNumber: 94,
      prUrl: decision.prUrl,
      repository: "cill-i-am/gaia",
    };
    const mergeReceipts = [
      DeliveryMergeIntent.make({ ...mergeBinding, state: "intentRecorded" }),
      DeliveryMergeDispatchAttempted.make({
        ...mergeBinding,
        state: "dispatchAttempted",
      }),
      DeliveryMergeDispatchConfirmed.make({
        ...mergeBinding,
        mergeCommitSha,
        mergedAt: "2026-07-13T12:01:00.000Z",
        state: "dispatchConfirmed",
      }),
    ];
    for (const mergeAction of mergeReceipts) {
      yield* appendEvent(runId, paths, {
        payload: { mergeAction: encodeDeliveryMergeReceiptJson(mergeAction) },
        type: "DELIVERY_MERGE_RECORDED",
      });
    }
    const cleanupRequired = DeliveryCleanupRequired.make({
      actionId: "cleanup-terminal-1",
      branch: "present",
      branchName,
      mergeCommitSha,
      ownershipDigest: "6".repeat(64),
      state: "cleanupRequired",
      worktree: "absent",
    });
    if (cleanupState === "none") {
      return { cleanupRequired, paths, runId };
    }
    yield* appendEvent(runId, paths, {
      payload: {
        cleanup: encodeDeliveryCleanupReceiptJson(cleanupRequired),
      },
      type: "DELIVERY_CLEANUP_RECORDED",
    });
    if (cleanupState === "cleanupRequired") {
      return { cleanupRequired, paths, runId };
    }
    yield* appendEvent(runId, paths, {
      payload: {
        cleanup: encodeDeliveryCleanupReceiptJson(
          DeliveryCleanupCompleted.make({
            actionId: cleanupRequired.actionId,
            branch: "absent",
            branchName,
            mergeCommitSha,
            ownershipDigest: cleanupRequired.ownershipDigest,
            state: "completed",
            worktree: "absent",
          })
        ),
      },
      type: "DELIVERY_CLEANUP_RECORDED",
    });

    return { cleanupRequired, paths, runId };
  });
}

function diagnosticSummaries(
  diagnostics: ReadonlyArray<typeof FactoryGraphDiagnosticDto.Type>
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
    "factory-blocking-reviewer"
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
        })
      ),
  };
}
