import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  CreateRunRequest,
  DeliveryActionIdPublicSchema,
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationIntent,
  DeliveryPublicationOutcomeUnknown,
  DeliveryCleanupCompleted,
  DeliveryCleanupRequired,
  DeliveryMergeDispatchAttempted,
  DeliveryMergeDispatchConfirmed,
  DeliveryMergeIntent,
  DeliveryMergeReadinessDecision,
  DeliveryMergeTerminalFailure,
  DeliveryBlocker,
  DeliveryFeedbackObservation,
  DeliveryPullRequestObservation,
  DeliveryPullRequestReadyIntent,
  DeliveryRemediationIntent,
  DeliveryRemediationDispatchAttempted,
  DeliveryRemediationTurnCompleted,
  DeliveryRemediationVerified,
  DeliveryRemediationCommitAttempted,
  DeliveryRemediationPushAttempted,
  DeliveryRemediationConfirmed,
  DeliveryRemediationFailed,
  encodeDeliveryPullRequestObservationJson,
  encodeDeliveryPullRequestReadyReceiptJson,
  encodeDeliveryPublicationJson,
  encodeDeliveryCleanupReceiptJson,
  encodeDeliveryMergeReadinessDecisionJson,
  encodeDeliveryMergeReceiptJson,
  encodeDeliveryRemediationJson,
  encodeWorkerRecoveryReceiptJson,
  encodeWorkerContinuationReceiptJson,
  encodeWorkerCorrelationReconciliationReceiptJson,
  FactoryAgentIdSchema,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  makeModelContextContentV1,
  makeModelContextManifestV1,
  makeModelInvocationManifestV1,
  makeRunControlActionBindingDigest,
  makeRunControlCheckpointDigest,
  makeRunControlRequestDigest,
  MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
  ModelInvocationEpisodeStartV1,
  deliveryPullRequestReadyPayloadDigest,
  makeRunEvent,
  parseDeliveryFeedbackId,
  parseHarnessEvent,
  parseHarnessProfileId,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessProviderId,
  parseHarnessQuestionId,
  parseHarnessSessionId,
  parseMarkdownSpec,
  parseHarnessTurnId,
  parseRunId,
  parseRunControlAction,
  parseRunControlActionId,
  parseRunControlAuthorityId,
  parseRunControlEventPayload,
  parseWorkerRecoveryActionId,
  parseWorkerRecoveryModelId,
  parseWorkspaceRelativePath,
  projectHarnessEvents,
  renderModelInputV1,
  LocalGaiaServerUrlSchema,
  RunEvent,
  RunControlEventPayload,
  RunHumanWaitCheckpointV1,
  RunIdSchema,
  WorkerRecoveryAction,
} from "@gaia/core";
import {
  makeHarnessProviderRegistry,
  appendEvent,
  appendHarnessSessionEvent,
  commitModelInvocationPair,
  commitDerivedAppModelInvocationEpisode,
  deriveAndRecordRunContract,
  deriveModelWorkspaceBinding,
  dispatchRunControlAction,
  loadRunContract,
  makeLiveHarnessSessionCoordinator,
  readEvents,
  readRunControlSnapshot,
  ReviewResult,
  ReviewerNameSchema,
  subscribeRunEventFeed,
  type GaiaReviewer,
  type DeliveryPublicationOptions,
  makeRuntimeError,
} from "@gaia/runtime";
import {
  makeRunPaths,
  makeRunStorePaths,
  parseRunStorageRootInput,
  RunStorageRootInputSchema,
  RuntimePathTextSchema,
  type RunPaths,
} from "@gaia/runtime/paths";
import type { ServerWorkflowOptions } from "@gaia/runtime/server-workflows";
import {
  acceptFactoryRun,
  acceptServerRun,
  continueServerRun,
} from "@gaia/runtime/server-workflows";
import {
  testHarnessCapabilities,
  testHarnessProvider,
} from "@gaia/runtime/test-support";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpServer,
  type HttpClientResponse,
} from "effect/unstable/http";

import { deliveryUpdateFromEvents, makeLocalGaiaServerLayer } from "./api.js";
import type { LocalServerIdentity } from "./discovery.js";

const decodeCreateRunRequest = Schema.decodeUnknownSync(CreateRunRequest);
const DeliveryActionActivationSchema = Schema.Struct({
  actionId: DeliveryActionIdPublicSchema,
});

function recoveredCompletedDeliveryEvents(
  runId = parseRunId("run-1234567890")
) {
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
  const publicationBase = {
    baseBranch: provenance.baseBranch,
    baseRevision: provenance.baseRevision,
    branchName,
    commitMessage: "fix: project terminal delivery state",
    commitTimestamp: "2026-07-13T12:00:00.000Z",
    digestVersion: 1 as const,
    operationId: `delivery:${runId}:1`,
    payloadDigest: "1".repeat(64),
    sourcePaths: ["apps/server/src/api.ts"],
    treeSha: "2".repeat(40),
  };
  const publicationIntent = DeliveryPublicationIntent.make({
    ...publicationBase,
    state: "intentRecorded",
  });
  const publicationAttempted = DeliveryPublicationAttempted.make({
    ...publicationBase,
    commitSha: headSha,
    state: "attempted",
  });
  const publicationConfirmed = DeliveryPublicationConfirmed.make({
    ...publicationAttempted,
    draft: true,
    headSha,
    prNumber: 94,
    prUrl: "https://github.com/cill-i-am/gaia/pull/94",
    state: "confirmed",
  });
  const mergeBinding = {
    actionId: "merge-terminal-1",
    branchName,
    decisionSequence: 11,
    expectedHeadSha: headSha,
    mergeMethod: "merge" as const,
    payloadDigest: "3".repeat(64),
    policyDigest: "4".repeat(64),
    policyVersion: 1 as const,
    prNumber: publicationConfirmed.prNumber,
    prUrl: publicationConfirmed.prUrl,
    repository: "cill-i-am/gaia",
  };
  const mergeDecision = DeliveryMergeReadinessDecision.make({
    actionId: "readiness-terminal-1",
    approved: true,
    blockers: [],
    branchName,
    headSha,
    mergeMethod: "merge",
    payloadDigest: "5".repeat(64),
    policyDigest: mergeBinding.policyDigest,
    policyVersion: 1,
    prNumber: publicationConfirmed.prNumber,
    prUrl: publicationConfirmed.prUrl,
  });
  const mergeIntent = DeliveryMergeIntent.make({
    ...mergeBinding,
    state: "intentRecorded",
  });
  const mergeAttempted = DeliveryMergeDispatchAttempted.make({
    ...mergeBinding,
    state: "dispatchAttempted",
  });
  const mergeConfirmed = DeliveryMergeDispatchConfirmed.make({
    ...mergeBinding,
    mergeCommitSha,
    mergedAt: "2026-07-13T12:01:00.000Z",
    state: "dispatchConfirmed",
  });
  const cleanupRequired = DeliveryCleanupRequired.make({
    actionId: "cleanup-terminal-1",
    branch: "present",
    branchName,
    mergeCommitSha,
    ownershipDigest: "6".repeat(64),
    state: "cleanupRequired",
    worktree: "absent",
  });
  const cleanupCompleted = DeliveryCleanupCompleted.make({
    actionId: cleanupRequired.actionId,
    branch: "absent",
    branchName,
    mergeCommitSha,
    ownershipDigest: cleanupRequired.ownershipDigest,
    state: "completed",
    worktree: "absent",
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
      timestamp: `2026-07-13T12:00:${String(sequence).padStart(2, "0")}.000Z`,
      type,
    });

  return [
    event(1, "RUN_CREATED", { specPath: "spec.md" }),
    event(2, "DELIVERY_STARTED", {
      delivery: { ...provenance, stage: "delivering" },
    }),
    event(3, "RUN_FAILED", {
      code: "HarnessSessionFailed",
      message: "Worker recovery required.",
      recoverable: true,
      stage: "runningWorker",
    }),
    event(4, "WORKER_RECOVERY_RECORDED", {
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
    }),
    event(5, "WORKER_COMPLETED", { workerResultPath: "worker-result.json" }),
    event(6, "VERIFICATION_COMPLETED", {
      verificationResultPath: "verification.json",
    }),
    event(7, "DELIVERY_READY_TO_PUBLISH", {
      delivery: { ...provenance, stage: "readyToPublish" },
      reportPath: "report.md",
    }),
    event(8, "DELIVERY_PUBLICATION_INTENT_RECORDED", {
      publication: encodeDeliveryPublicationJson(publicationIntent),
    }),
    event(9, "DELIVERY_PUBLICATION_ATTEMPTED", {
      publication: encodeDeliveryPublicationJson(publicationAttempted),
    }),
    event(10, "DELIVERY_PUBLICATION_CONFIRMED", {
      publication: encodeDeliveryPublicationJson(publicationConfirmed),
    }),
    event(11, "DELIVERY_MERGE_READINESS_RECORDED", {
      decision: encodeDeliveryMergeReadinessDecisionJson(mergeDecision),
    }),
    event(12, "DELIVERY_MERGE_RECORDED", {
      mergeAction: encodeDeliveryMergeReceiptJson(mergeIntent),
    }),
    event(13, "DELIVERY_MERGE_RECORDED", {
      mergeAction: encodeDeliveryMergeReceiptJson(mergeAttempted),
    }),
    event(14, "DELIVERY_MERGE_RECORDED", {
      mergeAction: encodeDeliveryMergeReceiptJson(mergeConfirmed),
    }),
    event(15, "DELIVERY_CLEANUP_RECORDED", {
      cleanup: encodeDeliveryCleanupReceiptJson(cleanupRequired),
    }),
    event(16, "DELIVERY_CLEANUP_RECORDED", {
      cleanup: encodeDeliveryCleanupReceiptJson(cleanupCompleted),
    }),
  ];
}

function appendProjectionEvent(
  events: ReadonlyArray<RunEvent>,
  type: Parameters<typeof makeRunEvent>[0]["type"],
  payload: Readonly<Record<string, Schema.Json>>
) {
  const sequence = events.length + 1;
  return [
    ...events,
    makeRunEvent({
      payload,
      runId: events[0]!.runId,
      sequence,
      timestamp: `2026-07-13T12:01:${String(sequence).padStart(2, "0")}.000Z`,
      type,
    }),
  ];
}

describe("local run api http boundary", () => {
  layer(NodeServices.layer)((it) => {
    for (const [inputCode, code, status] of [
      [
        "WorkerRecoveryCorrelationUnavailable",
        "WorkerRecoveryCorrelationUnavailable",
        422,
      ],
      [
        "WorkerRecoveryModelCatalogUnavailable",
        "WorkerRecoveryModelCatalogUnavailable",
        422,
      ],
      ["WorkerRecoveryModelUnavailable", "WorkerRecoveryModelUnavailable", 422],
      [
        "WorkerRecoveryIntentPersistenceFailed",
        "WorkerRecoveryIntentPersistenceFailed",
        500,
      ],
      ["ArbitraryPrivateRecoveryCode", "InternalServerError", 500],
    ] as const) {
      it.effect(
        `maps ${code} through the strict recovery endpoint with safe evidence`,
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const cwd = yield* fs.makeTempDirectory({
              prefix: "gaia-recovery-error-",
            });
            const action = WorkerRecoveryAction.make({
              actionId: parseWorkerRecoveryActionId(`action-${inputCode}`),
              expectedFailureSequence: 15,
              expectedSessionId: parseHarnessSessionId(
                "session-run-1234567890"
              ),
              harnessProfileId: parseHarnessProfileId("codexAppServer"),
              kind: "retryRecoverableWorkerFailure",
              model: parseWorkerRecoveryModelId("gpt-5.5"),
            });
            const response = yield* HttpClientRequest.post(
              "/runs/run-1234567890/recovery/actions"
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe(action),
              HttpClient.execute,
              Effect.provide(
                testServerLayer(cwd, {
                  workerRecoveryActivator: () =>
                    Effect.fail(
                      makeRuntimeError({
                        cause: new Error(
                          "native-thread-token /private/path model-catalog prompt"
                        ),
                        code: inputCode,
                        message:
                          code === "WorkerRecoveryIntentPersistenceFailed"
                            ? "Worker recovery intent could not be persisted."
                            : "Worker recovery pre-intent dependency is unavailable.",
                      })
                    ),
                })
              )
            );
            const body = yield* responseJsonObject(response);
            const log = yield* fs.readFileString(`${cwd}/.gaia/server.log`);
            const evidence = JSON.parse(log.trim()) as Record<string, unknown>;
            assert.strictEqual(response.status, status);
            assert.strictEqual(getString(body, "code"), code);
            assert.strictEqual(evidence["code"], code);
            assert.strictEqual(evidence["status"], status);
            assert.strictEqual(evidence["runId"], "run-1234567890");
            assert.strictEqual(evidence["actionId"], action.actionId);
            assert.hasAllKeys(evidence, [
              "timestamp",
              "runId",
              "actionId",
              "stage",
              "code",
              "status",
            ]);
            for (const secret of [
              "native-thread",
              "token",
              "/private/path",
              "model-catalog",
              "prompt",
              "gpt-5.5",
            ]) {
              assert.notInclude(JSON.stringify(body), secret);
              assert.notInclude(log, secret);
            }
          })
      );
    }

    it.effect(
      "preserves the primary typed response when safe evidence append fails",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-recovery-log-failure-",
          });
          const action = WorkerRecoveryAction.make({
            actionId: parseWorkerRecoveryActionId("action-log-failure"),
            expectedFailureSequence: 15,
            expectedSessionId: parseHarnessSessionId("session-run-1234567890"),
            harnessProfileId: parseHarnessProfileId("codexAppServer"),
            kind: "retryRecoverableWorkerFailure",
            model: parseWorkerRecoveryModelId("gpt-5.5"),
          });
          const response = yield* HttpClientRequest.post(
            "/runs/run-1234567890/recovery/actions"
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe(action),
            HttpClient.execute,
            Effect.provide(
              testServerLayer(
                cwd,
                {
                  workerRecoveryActivator: () =>
                    Effect.fail(
                      makeRuntimeError({
                        code: "WorkerRecoveryModelUnavailable",
                        message:
                          "The explicitly selected Codex model is unavailable.",
                      })
                    ),
                },
                {
                  writeWorkerRecoveryFailureEvidence: () =>
                    Effect.fail(new Error("evidence unavailable")),
                }
              )
            )
          );
          const body = yield* responseJsonObject(response);
          assert.strictEqual(response.status, 422);
          assert.strictEqual(
            getString(body, "code"),
            "WorkerRecoveryModelUnavailable"
          );
        })
    );

    it.effect("returns health with workspace identity", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const response = yield* HttpClient.get("/health").pipe(
          Effect.provide(testServerLayer(cwd))
        );
        const body = yield* responseJsonObject(response);

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(body, "status"), "ok");
        assert.strictEqual(getString(body, "workspaceRoot"), cwd);
        assert.strictEqual(getString(body, "host"), "127.0.0.1");
        assert.strictEqual(getNumber(body, "version"), 1);
        assert.isAbove(getNumber(body, "port"), 0);
      })
    );

    it.effect("returns factory run summaries with partial diagnostics", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry:
            markerWritingTestHarnessProviderRegistry(cwd),
          rootDirectory: cwd,
        });
        yield* fs.makeDirectory(`${cwd}/.gaia/runs/run-not-valid`);

        const response = yield* HttpClient.get("/runs").pipe(
          Effect.provide(testServerLayer(cwd))
        );
        const body = yield* responseJsonObject(response);
        const data = getObject(body, "data");
        const runs = getArray(data, "runs");
        const firstRun = getObjectFromArray(runs, 0);
        const diagnostics = getArray(data, "diagnostics");
        const firstDiagnostic = getObjectFromArray(diagnostics, 0);

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(body, "status"), "success");
        assert.strictEqual(getString(firstRun, "runId"), accepted.runId);
        assert.strictEqual(
          getString(getObject(firstRun, "workerEnvironmentEpoch"), "state"),
          "missing"
        );
        assert.strictEqual(getString(firstRun, "workflow"), "issueDelivery");
        assert.strictEqual(
          getString(getObject(firstRun, "rootWorkItem"), "title"),
          "Wire LocalGaiaServerApi factory endpoints"
        );
        assert.strictEqual(
          getNumber(getObject(firstRun, "counts"), "agents"),
          5
        );
        assert.strictEqual(
          getString(firstDiagnostic, "code"),
          "InvalidRunDirectory"
        );
      })
    );

    it.effect("returns factory run detail and internal event envelopes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry:
            markerWritingTestHarnessProviderRegistry(cwd),
          rootDirectory: cwd,
        });

        const layer = testServerLayer(cwd);
        const detailResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}`
        ).pipe(Effect.provide(layer));
        const eventsResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/events`
        ).pipe(Effect.provide(layer));
        const detail = yield* responseJsonObject(detailResponse);
        const events = yield* responseJsonObject(eventsResponse);
        const detailData = getObject(detail, "data");
        const eventsData = getObject(events, "data");
        const eventItems = getArray(eventsData, "events");

        assert.strictEqual(detailResponse.status, 200);
        assert.strictEqual(eventsResponse.status, 200);
        assert.strictEqual(getString(detailData, "runId"), accepted.runId);
        assert.strictEqual(
          getString(getObject(detailData, "workerEnvironmentEpoch"), "state"),
          "missing"
        );
        assert.strictEqual(getString(eventsData, "runId"), accepted.runId);
        assert.strictEqual(
          getString(getObject(detailData, "execution"), "harnessProfileId"),
          "codexAppServer"
        );
        assert.notInclude(JSON.stringify(detailData), "native-thread");
        assert.notInclude(JSON.stringify(detailData), "/usr/local/bin");
        assert.strictEqual(
          getNumber(getObject(detailData, "counts"), "agents"),
          5
        );
        assert.strictEqual(
          eventItems.length,
          getNumber(getObject(detailData, "counts"), "activity")
        );
      })
    );

    it.effect("serves the event-derived durable run control resource", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry:
            markerWritingTestHarnessProviderRegistry(cwd),
          rootDirectory: cwd,
        });

        const response = yield* HttpClient.get(
          `/runs/${accepted.runId}/control`
        ).pipe(Effect.provide(testServerLayer(cwd)));
        const body = yield* responseJsonObject(response);

        assert.strictEqual(response.status, 409);
        assertApiError(body, "RunControlStale", 409);

        const staleCanary = "SERVER_POST_HIDDEN_RESPONSE_CANARY";
        const staleAction = parseRunControlAction({
          actionId: parseRunControlActionId("action-server-stale-response"),
          authorityId: "authority-stale",
          checkpointDigest: "a".repeat(64),
          expectedEventSequence: 1,
          interactionId: "interaction-stale",
          operation: "resolveInteraction",
          providerId: "fake",
          requestDigest: "b".repeat(64),
          response: {
            answers: [
              {
                answers: [staleCanary],
                questionId: parseHarnessQuestionId("question-stale"),
              },
            ],
            kind: "userInput",
          },
          runId: accepted.runId,
          sessionId: `session-${accepted.runId}`,
          workerAgentId: "agent-worker",
          workerStartedSequence: 1,
        });
        const stalePost = yield* HttpClientRequest.post(
          `/runs/${accepted.runId}/control/actions`
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe(staleAction),
          HttpClient.execute,
          Effect.provide(testServerLayer(cwd))
        );
        const stalePostBody = yield* responseJsonObject(stalePost);
        assert.strictEqual(stalePost.status, 409);
        assertApiError(stalePostBody, "RunControlStale", 409);
        assert.notInclude(JSON.stringify(stalePostBody), staleCanary);

        const setupRunningControl = (input: {
          readonly capabilities: typeof HarnessCapabilities.Type;
          readonly runId: ReturnType<typeof parseRunId>;
          readonly waitingForHuman?: boolean;
        }) =>
          Effect.gen(function* () {
            const paths = yield* makeRunPaths(input.runId, {
              rootDirectory: cwd,
            });
            yield* fs.makeDirectory(paths.root, { recursive: true });
            yield* appendEvent(input.runId, paths, {
              payload: { specPath: "spec.md" },
              type: "RUN_CREATED",
            });
            yield* appendEvent(input.runId, paths, {
              payload: { workspacePath: "." },
              type: "WORKSPACE_PREPARED",
            });
            yield* appendEvent(input.runId, paths, { type: "WORKER_STARTED" });
            yield* appendHarnessSessionEvent(input.runId, paths, {
              capabilities: input.capabilities,
              kind: "sessionStarted",
              provider: testHarnessProvider.descriptor,
              sessionId: parseHarnessSessionId(`session-${input.runId}`),
              state: "running",
            });
            if (input.waitingForHuman === true) {
              const sessionId = parseHarnessSessionId(`session-${input.runId}`);
              const interactionId = parseHarnessInteractionId(
                `interaction-${input.runId}`
              );
              const turnId = parseHarnessTurnId(`turn-${input.runId}`);
              yield* appendHarnessSessionEvent(input.runId, paths, {
                kind: "turnStarted",
                sessionId,
                turnId,
              });
              const interaction = {
                interactionId,
                itemId: parseHarnessItemId(`item-${input.runId}`),
                kind: "userInput" as const,
                questions: [
                  {
                    options: [],
                    prompt: "Secret?",
                    questionId: parseHarnessQuestionId(
                      `question-${input.runId}`
                    ),
                    secret: true,
                  },
                ],
                requestedAt: "2026-07-22T00:00:00.000Z",
                turnId,
              };
              yield* appendHarnessSessionEvent(input.runId, paths, {
                interaction,
                kind: "interactionRequested",
                sessionId,
              });
              const checkpointWithPlaceholder = Schema.decodeUnknownSync(
                RunHumanWaitCheckpointV1
              )({
                checkpointDigest: "a".repeat(64),
                environmentReceipt: {
                  byteLength: 512,
                  path: `harness-environment/receipt-${"b".repeat(64)}.json`,
                  receiptDigest: "b".repeat(64),
                  runId: input.runId,
                  structuralDigest: "c".repeat(64),
                  version: 1,
                },
                expectedEventSequence: 7,
                interactionId,
                providerId: testHarnessProvider.descriptor.providerId,
                requestDigest: makeRunControlRequestDigest(interaction),
                requestedAt: "2026-07-22T00:00:00.000Z",
                resolverAuthorityId:
                  parseRunControlAuthorityId("authority-local"),
                runId: input.runId,
                sessionId,
                version: 1,
                workerAgentId: "agent-worker",
                workerStartedSequence: 3,
              });
              const {
                checkpointDigest: _checkpointDigest,
                ...checkpointInput
              } = checkpointWithPlaceholder;
              const checkpoint = RunHumanWaitCheckpointV1.make({
                ...checkpointInput,
                checkpointDigest:
                  makeRunControlCheckpointDigest(checkpointInput),
              });
              yield* appendEvent(input.runId, paths, {
                payload: {
                  checkpoint: Schema.encodeSync(RunHumanWaitCheckpointV1)(
                    checkpoint
                  ),
                },
                type: "RUN_WAITING_FOR_HUMAN",
              });
            }
            return yield* readRunControlSnapshot(input.runId, {
              rootDirectory: cwd,
            });
          });
        const durableCapabilities = HarnessCapabilities.make({
          approvals: ["userInput"],
          durableInteractionResolution: true,
          durablePause: true,
          fileChangeEvents: false,
          interruption: true,
          resumableSessions: true,
          review: false,
          steering: false,
          streamingMessages: true,
          structuredOutput: false,
          subagents: false,
          toolEvents: false,
          usageReporting: false,
          userQuestions: true,
        });
        const activeRunId = parseRunId("run-148servr01");
        const active = yield* setupRunningControl({
          capabilities: durableCapabilities,
          runId: activeRunId,
          waitingForHuman: true,
        });
        assert.isDefined(active.actionTarget);
        const wrongAuthority = parseRunControlAction({
          ...active.actionTarget,
          actionId: parseRunControlActionId("action-server-wrong-authority"),
          authorityId: parseRunControlAuthorityId("authority-wrong"),
          operation: "resolveInteraction",
          response: {
            answers: [
              {
                answers: [staleCanary],
                questionId: parseHarnessQuestionId(`question-${activeRunId}`),
              },
            ],
            kind: "userInput",
          },
          runId: activeRunId,
        });
        const wrongAuthorityResponse = yield* HttpClientRequest.post(
          `/runs/${activeRunId}/control/actions`
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe(wrongAuthority),
          HttpClient.execute,
          Effect.provide(testServerLayer(cwd))
        );
        assert.strictEqual(wrongAuthorityResponse.status, 403);
        const wrongAuthorityBody = yield* responseJsonObject(
          wrongAuthorityResponse
        );
        assertApiError(wrongAuthorityBody, "RunControlWrongAuthority", 403);
        assert.notInclude(JSON.stringify(wrongAuthorityBody), staleCanary);

        const unsupportedRunId = parseRunId("run-148servr02");
        const unsupported = yield* setupRunningControl({
          capabilities: HarnessCapabilities.make({
            ...durableCapabilities,
            durablePause: false,
          }),
          runId: unsupportedRunId,
        });
        assert.isDefined(unsupported.actionTarget);
        const unsupportedResponse = yield* HttpClientRequest.post(
          `/runs/${unsupportedRunId}/control/actions`
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe(
            parseRunControlAction({
              ...unsupported.actionTarget,
              actionId: parseRunControlActionId(
                "action-server-unsupported-pause"
              ),
              operation: "pause",
              runId: unsupportedRunId,
            })
          ),
          HttpClient.execute,
          Effect.provide(testServerLayer(cwd))
        );
        assert.strictEqual(unsupportedResponse.status, 422);
        assertApiError(
          yield* responseJsonObject(unsupportedResponse),
          "RunControlUnsupportedProviderOperation",
          422
        );
      })
    );

    it.effect(
      "resumes the provider exactly once across the control action and continuation",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const cwd = yield* fs.makeTempDirectory({
              prefix: "gaia-server-run-control-resume-",
            });
            let consumedSessions = 0;
            let releasedSessions = 0;
            let resumeCalls = 0;
            const resumeCapabilities = HarnessCapabilities.make({
              ...testHarnessCapabilities,
              approvals: ["userInput"],
              userQuestions: true,
            });
            const provider = {
              ...testHarnessProvider,
              detect: Effect.succeed({
                auth: { state: "notRequired" as const },
                capabilities: resumeCapabilities,
                state: "available" as const,
                version: "resume-once-1",
              }),
              resumeSession: (
                request: Parameters<typeof testHarnessProvider.resumeSession>[0]
              ) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    resumeCalls += 1;
                  }),
                  () =>
                    Effect.sync(() => {
                      releasedSessions += 1;
                    })
                ).pipe(
                  Effect.map(() => {
                    let consumed = false;
                    const turnId = parseHarnessTurnId(
                      "turn-server-resume-once"
                    );
                    const events = [
                      {
                        capabilities: resumeCapabilities,
                        kind: "sessionStarted" as const,
                        provider: testHarnessProvider.descriptor,
                        sessionId: request.sessionId,
                        state: "running" as const,
                      },
                      {
                        kind: "turnStarted" as const,
                        sessionId: request.sessionId,
                        turnId,
                      },
                      {
                        interaction: {
                          interactionId: parseHarnessInteractionId(
                            "interaction-server-resume-once"
                          ),
                          itemId: parseHarnessItemId("item-server-resume-once"),
                          kind: "userInput" as const,
                          questions: [
                            {
                              options: [],
                              prompt: "Continue?",
                              questionId: parseHarnessQuestionId(
                                "question-server-resume-once"
                              ),
                              secret: false,
                            },
                          ],
                          requestedAt: "2026-07-22T20:00:00.000Z",
                          turnId,
                        },
                        kind: "interactionRequested" as const,
                        sessionId: request.sessionId,
                      },
                    ];
                    return {
                      events: Stream.fromIterable(events).pipe(
                        Stream.tap(() =>
                          Effect.sync(() => {
                            if (!consumed) {
                              consumed = true;
                              consumedSessions += 1;
                            }
                          })
                        )
                      ),
                      interrupt: Option.some(Effect.void),
                      resolveInteraction: () => Effect.void,
                      send: () => Effect.succeed(undefined),
                      snapshot: Effect.succeed(
                        projectHarnessEvents(events, request.sessionId)
                      ),
                      steer: Option.none(),
                    };
                  })
                ),
            };
            const registry = makeHarnessProviderRegistry([
              {
                profileId: codexAppServerExecutionSelection.harnessProfileId,
                provider,
              },
            ]);
            const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
              harnessProviderRegistry: registry,
              rootDirectory: cwd,
            });
            const paths = yield* makeRunPaths(accepted.runId, {
              rootDirectory: cwd,
            });
            const sessionId = parseHarnessSessionId(
              `session-${accepted.runId}`
            );
            yield* fs.makeDirectory(paths.workspace, { recursive: true });
            yield* fs.writeFileString(
              `${paths.workspace}/output.txt`,
              `test interactive completion ${accepted.runId}\n`
            );
            yield* deriveAndRecordRunContract({
              paths,
              runId: accepted.runId,
              spec: parseMarkdownSpec(
                "# Resume once\n\nComplete the bounded task.\n",
                "input.md"
              ),
            });
            yield* appendEvent(accepted.runId, paths, {
              payload: { workspacePath: "." },
              type: "WORKSPACE_PREPARED",
            });
            const content = makeModelContextContentV1({
              acceptedOutcomes: [],
              authority: ["Apply only accepted worker authority."],
              budget: { maxOutputBytes: 16_384, maxTurns: 1 },
              contentRefs: [],
              episodeRole: "workerInitial",
              instructions: ["Complete the bounded task."],
              nonGoals: [],
              outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
              planningFacts: [],
              safeExclusions: [],
              skills: [],
              stops: [],
              taskInput: "Complete the bounded task.",
              verificationCommands: [],
            });
            const rendered = renderModelInputV1(content);
            const workspaceBinding = yield* deriveModelWorkspaceBinding(paths);
            const contract = yield* loadRunContract(paths, accepted.runId);
            const context = makeModelContextManifestV1({
              authoritativeRefs: [
                { digest: contract.contractDigest, kind: "runContract" },
              ],
              binding: {
                episodeKey: "workerInitial",
                runId: accepted.runId,
              },
              content,
              workspaceBinding,
            });
            const invocation = makeModelInvocationManifestV1({
              acceptedProviderCapabilityObservation: "unobservable",
              adapterInputClass: "codexAppTurn",
              adapterSemantics: {
                kind: "codexAppServer",
                semanticDigest: "a".repeat(64),
              },
              authorityRef: {
                digest: "b".repeat(64),
                kind: "authority",
              },
              binding: context.payload.binding,
              budget: content.payload.budget,
              context,
              outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
              rendered,
              runContractRef: {
                digest: contract.contractDigest,
                kind: "runContract",
              },
              template: { id: "gaia.worker-input.v1", version: 1 },
              workspaceBinding,
            });
            const episode = yield* commitModelInvocationPair({
              context,
              episodeKey: "workerInitial",
              invocation,
              paths,
            });
            yield* appendEvent(accepted.runId, paths, {
              payload: {
                modelInvocationEpisode: Schema.encodeSync(
                  ModelInvocationEpisodeStartV1
                )(episode),
              },
              type: "WORKER_STARTED",
            });
            yield* appendHarnessSessionEvent(accepted.runId, paths, {
              capabilities: resumeCapabilities,
              kind: "sessionStarted",
              provider: testHarnessProvider.descriptor,
              sessionId,
              state: "running",
            });

            const coordinator = makeLiveHarnessSessionCoordinator();
            const liveSession = yield* testHarnessProvider.resumeSession({
              sessionId,
              workspacePath: parseWorkspaceRelativePath("."),
            });
            const running = yield* readRunControlSnapshot(accepted.runId, {
              rootDirectory: cwd,
            });
            if (running.actionTarget === undefined)
              assert.fail("Expected the running control action target.");
            yield* coordinator.register({
              agentId: running.actionTarget.workerAgentId,
              runId: accepted.runId,
              session: liveSession,
              sessionId,
            });
            yield* dispatchRunControlAction({
              action: parseRunControlAction({
                ...running.actionTarget,
                actionId: parseRunControlActionId(
                  "action-server-pause-before-resume"
                ),
                operation: "pause",
                runId: accepted.runId,
              }),
              options: { rootDirectory: cwd, sessionCoordinator: coordinator },
              runId: accepted.runId,
            });
            const paused = yield* readRunControlSnapshot(accepted.runId, {
              rootDirectory: cwd,
            });
            assert.isDefined(paused.actionTarget);
            const resume = parseRunControlAction({
              ...paused.actionTarget,
              actionId: parseRunControlActionId("action-server-resume-once"),
              operation: "resume",
              runId: accepted.runId,
            });

            const completed = yield* Effect.gen(function* () {
              const result = yield* HttpClientRequest.post(
                `/runs/${accepted.runId}/control/actions`
              ).pipe(
                HttpClientRequest.bodyJsonUnsafe(resume),
                HttpClient.execute
              );
              for (let attempt = 0; attempt < 1_000; attempt += 1) {
                const observed = yield* readEvents(paths);
                if (
                  consumedSessions === 1 &&
                  releasedSessions === resumeCalls &&
                  observed.some(({ type }) => type === "RUN_FAILED")
                )
                  return { events: observed, response: result };
                yield* Effect.yieldNow;
              }
              const observedTypes = (yield* readEvents(paths)).map(
                ({ type }) => type
              );
              assert.fail(
                `Expected the resumed continuation to consume and release its provider session (resumeCalls=${resumeCalls}, consumedSessions=${consumedSessions}, releasedSessions=${releasedSessions}, events=${observedTypes.join(",")}).`
              );
            }).pipe(
              Effect.provide(
                testServerLayer(cwd, { harnessProviderRegistry: registry })
              )
            );
            const { events, response } = completed;
            const resumeLifecycle = events.filter((event) => {
              const control = event.payload["control"];
              return (
                control !== null &&
                typeof control === "object" &&
                !Array.isArray(control) &&
                Reflect.get(control, "actionId") === resume.actionId
              );
            });

            assert.strictEqual(response.status, 200);
            assert.strictEqual(resumeCalls, 1);
            assert.strictEqual(consumedSessions, 1);
            assert.strictEqual(releasedSessions, 1);
            assert.strictEqual(
              resumeLifecycle.filter(
                ({ type }) => type === "RUN_CONTROL_ATTEMPTED"
              ).length,
              1
            );
            assert.strictEqual(
              resumeLifecycle.filter(({ type }) =>
                [
                  "RUN_CONTROL_CONFIRMED",
                  "RUN_CONTROL_FAILED",
                  "RUN_CONTROL_OUTCOME_UNKNOWN",
                ].includes(type)
              ).length,
              1
            );
          })
        )
    );

    it.effect(
      "serves factory artifact catalogs and bodies through JSON envelopes only",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });

          const catalogResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/artifacts`
          ).pipe(Effect.provide(testServerLayer(cwd)));
          const [
            bodyResponse,
            planReviewResponse,
            evidenceReviewResponse,
            verificationResultResponse,
          ] = yield* Effect.all(
            [
              HttpClient.get(`/runs/${accepted.runId}/artifacts/report-json`),
              HttpClient.get(`/runs/${accepted.runId}/artifacts/plan-review`),
              HttpClient.get(
                `/runs/${accepted.runId}/artifacts/evidence-review`
              ),
              HttpClient.get(
                `/runs/${accepted.runId}/artifacts/verification-result`
              ),
            ],
            { concurrency: "unbounded" }
          ).pipe(Effect.provide(testServerLayer(cwd)));
          const catalogBody = yield* responseJsonObject(catalogResponse);
          const body = yield* responseJsonObject(bodyResponse);
          const planReview = getObject(
            yield* responseJsonObject(planReviewResponse),
            "data"
          );
          const evidenceReview = getObject(
            yield* responseJsonObject(evidenceReviewResponse),
            "data"
          );
          const verificationResult = getObject(
            yield* responseJsonObject(verificationResultResponse),
            "data"
          );
          const artifacts = getArray(
            getObject(catalogBody, "data"),
            "artifacts"
          );
          const reportMetadata = artifacts
            .map((artifact) => {
              if (!isJsonObject(artifact)) {
                throw new Error("Expected artifact metadata to be an object.");
              }
              return artifact;
            })
            .find(
              (artifact) => getString(artifact, "artifactId") === "report-json"
            );
          const data = getObject(body, "data");

          assert.strictEqual(catalogResponse.status, 200);
          assert.strictEqual(bodyResponse.status, 200);
          assert.strictEqual(planReviewResponse.status, 200);
          assert.strictEqual(evidenceReviewResponse.status, 200);
          assert.strictEqual(verificationResultResponse.status, 200);
          assert.isDefined(reportMetadata);
          for (const expectedArtifactId of [
            "plan-review",
            "evidence-review",
            "verification-result",
          ]) {
            assert.isDefined(
              artifacts
                .map((artifact) => {
                  if (!isJsonObject(artifact)) {
                    throw new Error(
                      "Expected artifact metadata to be an object."
                    );
                  }
                  return artifact;
                })
                .find(
                  (artifact) =>
                    getString(artifact, "artifactId") === expectedArtifactId
                )
            );
          }
          assert.strictEqual(getString(data, "artifactId"), "report-json");
          assert.strictEqual(
            getString(data, "contentType"),
            "application/json"
          );
          assert.include(getString(data, "body"), accepted.runId);
          assert.strictEqual(
            getString(planReview, "artifactId"),
            "plan-review"
          );
          assert.include(getString(planReview, "body"), '"phase": "plan"');
          assert.strictEqual(
            getString(evidenceReview, "artifactId"),
            "evidence-review"
          );
          assert.include(
            getString(evidenceReview, "body"),
            '"phase": "evidence"'
          );
          assert.strictEqual(
            getString(verificationResult, "artifactId"),
            "verification-result"
          );
          assert.include(
            getString(verificationResult, "body"),
            '"aggregate": "completed-unverified"'
          );
          assert.include(
            getString(verificationResult, "body"),
            '"results": []'
          );
        })
    );

    it.effect(
      "streams a server-created run from replayed events to terminal close",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const accepted = yield* acceptServerRun(
            {
              specMarkdown: "Stream this server run to completion.\n",
            },
            {
              rootDirectory: cwd,
            }
          );

          yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const response = yield* HttpClient.get(
            `/runs/${accepted.runId}/events/stream`
          ).pipe(Effect.provide(testServerLayer(cwd)));
          const text = yield* response.text;
          const events = parseSseDataEvents(text);
          const firstEvent = events[0];
          const lastEvent = events.at(-1);

          assert.strictEqual(response.status, 200);
          if (firstEvent === undefined || lastEvent === undefined) {
            assert.fail("Expected stream to emit run events.");
          }

          assert.strictEqual(getString(firstEvent, "type"), "RUN_CREATED");
          assert.strictEqual(getString(lastEvent, "type"), "REPORT_COMPLETED");
          assert.deepEqual(
            events.map((event) => getNumber(event, "sequence")),
            Array.from({ length: events.length }, (_, index) => index + 1)
          );
        }),
      20_000
    );

    it.effect(
      "accepts Markdown content durably before returning",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const layer = testServerLayer(cwd);
          const response = yield* postCreateRun(
            layer,
            "Create through the local server.\n"
          );
          const body = yield* responseJsonObject(response);
          const runId = getString(body, "runId");
          const paths = yield* makeRunPaths(parseRunId(runId), {
            rootDirectory: cwd,
          });
          const persistedInput = yield* fs.readFileString(paths.input);

          assert.strictEqual(response.status, 202);
          assert.strictEqual(getString(body, "status"), "accepted");
          assert.strictEqual(
            persistedInput,
            "Create through the local server.\n"
          );
        }),
      20_000
    );

    it.effect(
      "refreshes externally created runs on list and detail reads",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const layer = testServerLayer(cwd);

          yield* Effect.gen(function* () {
            const initialResponse = yield* HttpClient.get("/runs");
            const initialBody = yield* responseJsonObject(initialResponse);

            assert.strictEqual(initialResponse.status, 200);
            assert.deepEqual(
              getArray(getObject(initialBody, "data"), "runs"),
              []
            );

            const summary = yield* acceptFactoryRun(factoryCreateInput(), {
              harnessProviderRegistry:
                markerWritingTestHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            });

            const listResponse = yield* HttpClient.get("/runs");
            const detailResponse = yield* HttpClient.get(
              `/runs/${summary.runId}`
            );
            const listBody = yield* responseJsonObject(listResponse);
            const detailBody = yield* responseJsonObject(detailResponse);
            const listRun = getObjectFromArray(
              getArray(getObject(listBody, "data"), "runs"),
              0
            );
            const detail = getObject(detailBody, "data");

            assert.strictEqual(listResponse.status, 200);
            assert.strictEqual(detailResponse.status, 200);
            assert.strictEqual(getString(listRun, "runId"), summary.runId);
            assert.strictEqual(getString(detail, "runId"), summary.runId);
            assert.strictEqual(getString(detail, "state"), "running");
          }).pipe(Effect.provide(layer));
        }),
      20_000
    );

    it.effect(
      "returns factory graph, activity, agent activity, and artifact bodies",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const layer = testServerLayer(cwd);

          const graphResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/factory-graph`
          ).pipe(Effect.provide(layer));
          const activityResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/activity`
          ).pipe(Effect.provide(layer));
          const agentActivityResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/agents/agent-worker/activity`
          ).pipe(Effect.provide(layer));
          const artifactResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/artifacts/worker-plan`
          ).pipe(Effect.provide(layer));
          const graph = getObject(
            yield* responseJsonObject(graphResponse),
            "data"
          );
          const activity = getObject(
            yield* responseJsonObject(activityResponse),
            "data"
          );
          const agentActivity = getObject(
            yield* responseJsonObject(agentActivityResponse),
            "data"
          );
          const artifact = getObject(
            yield* responseJsonObject(artifactResponse),
            "data"
          );

          assert.strictEqual(graphResponse.status, 200);
          assert.strictEqual(activityResponse.status, 200);
          assert.strictEqual(agentActivityResponse.status, 200);
          assert.strictEqual(artifactResponse.status, 200);
          assert.strictEqual(getString(graph, "workflow"), "issueDelivery");
          assert.lengthOf(getArray(graph, "agents"), 5);
          assert.isAtLeast(getArray(activity, "activities").length, 1);
          assert.deepEqual(
            getArray(agentActivity, "activities").map((item) =>
              getString(asJsonObject(item), "kind")
            ),
            [
              "WORKER_STARTED",
              "HARNESS_SESSION_EVENT_RECORDED",
              "HARNESS_SESSION_EVENT_RECORDED",
              "HARNESS_SESSION_EVENT_RECORDED",
              "WORKER_COMPLETED",
            ]
          );
          assert.strictEqual(
            getString(getObject(graph, "execution"), "harnessProfileId"),
            "codexAppServer"
          );
          assert.strictEqual(getString(artifact, "artifactId"), "worker-plan");
          assert.include(getString(artifact, "body"), accepted.runId);
        }),
      20_000
    );

    it.effect(
      "serves normalized agent session snapshots and selected-agent SSE without provider leakage",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const layer = testServerLayer(cwd);

          const snapshotResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/agents/agent-worker/session`
          ).pipe(Effect.provide(layer));
          const streamResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/agents/agent-worker/session/stream`
          ).pipe(Effect.provide(layer));
          const snapshotBody = yield* responseJsonObject(snapshotResponse);
          const snapshot = getObject(snapshotBody, "data");
          const streamText = yield* streamResponse.text;
          const sse = parseSseBlocks(streamText);
          const updates = sse.map(({ data }) => data);

          assert.strictEqual(snapshotResponse.status, 200);
          assert.strictEqual(getString(snapshotBody, "status"), "success");
          assert.strictEqual(getString(snapshot, "runId"), accepted.runId);
          assert.strictEqual(getString(snapshot, "agentId"), "agent-worker");
          assert.notInclude(JSON.stringify(snapshot), "native-thread");
          assert.notInclude(JSON.stringify(snapshot), "synthetic-stream");
          assert.strictEqual(streamResponse.status, 200);
          assert.isAtLeast(updates.length, 1);
          assert.deepEqual(
            sse.map(({ id }) => id),
            updates.map((update) => String(getNumber(update, "eventSequence")))
          );
          assert.deepEqual(
            updates.map((update) => getNumber(update, "eventSequence")),
            [
              ...updates.map((update) => getNumber(update, "eventSequence")),
            ].sort((left, right) => left - right)
          );
          assert.isTrue(
            getObjectFromArray(updates, updates.length - 1)["terminal"] === true
          );

          const canonicalCursorResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/agents/agent-worker/session/stream?afterSequence=1`
          ).pipe(Effect.provide(layer));
          yield* canonicalCursorResponse.text;
          assert.strictEqual(canonicalCursorResponse.status, 200);

          for (const rejectedCursor of ["0", "-1", "1.5", "01", "abc"]) {
            const rejectedResponse = yield* HttpClient.get(
              `/runs/${accepted.runId}/agents/agent-worker/session/stream?afterSequence=${encodeURIComponent(rejectedCursor)}`
            ).pipe(Effect.provide(layer));
            const rejectedBody = yield* responseJsonObject(rejectedResponse);
            assert.strictEqual(rejectedResponse.status, 400);
            assert.strictEqual(getNumber(rejectedBody, "status"), 400);
          }
        }),
      20_000
    );

    it.effect(
      "serves recovered pending interactions and blocks actions behind the live continuation lease",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-recovered-session-",
          });
          const resolutions: unknown[] = [];
          const layer = testServerLayer(cwd, {
            harnessProviderRegistry: pendingApprovalRegistry(resolutions),
          });
          yield* Effect.gen(function* () {
            const createResponse = yield* createRunRequest(
              "Create a recovered-session projection proof.\n"
            );
            const createBody = yield* responseJsonObject(createResponse);
            const runId = getString(createBody, "runId");
            const sessionId = `session-${runId}`;
            const snapshot = yield* eventuallyAgentSession(runId);

            assert.strictEqual(createResponse.status, 202);
            assert.strictEqual(getString(snapshot, "state"), "running");
            assert.deepEqual(
              getArray(snapshot, "pendingInteractions")
                .map(asJsonObject)
                .map((interaction) => getString(interaction, "interactionId")),
              [serverRecoveredInteractionId]
            );
            assert.deepEqual(
              getArray(snapshot, "turns")
                .map(asJsonObject)
                .map((turn) => ({
                  status: getString(turn, "status"),
                  turnId: getString(turn, "turnId"),
                })),
              [
                { status: "failed", turnId: serverOldTurnId },
                { status: "running", turnId: serverRecoveredTurnId },
              ]
            );
            assert.notInclude(
              JSON.stringify(getArray(snapshot, "pendingInteractions")),
              serverOldInteractionId
            );
            assert.notInclude(JSON.stringify(snapshot), "native-thread");
            assert.notInclude(JSON.stringify(snapshot), "raw-provider");

            const staleResponse = yield* HttpClientRequest.post(
              `/runs/${runId}/agents/agent-worker/session/actions`
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                actionId: "action-server-stale-interaction",
                decision: "decline",
                interactionId: serverOldInteractionId,
                kind: "approval",
                sessionId,
              }),
              HttpClient.execute
            );
            const staleBody = yield* responseJsonObject(staleResponse);
            assert.strictEqual(
              staleResponse.status,
              409,
              JSON.stringify(staleBody)
            );
            assertApiError(staleBody, "RunStoreLocked", 409);
            assert.deepEqual(resolutions, []);

            const action = {
              actionId: "action-server-recovered-approval",
              decision: "decline",
              interactionId: serverRecoveredInteractionId,
              kind: "approval",
              sessionId,
            } as const;
            const firstResponse = yield* HttpClientRequest.post(
              `/runs/${runId}/agents/agent-worker/session/actions`
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe(action),
              HttpClient.execute
            );
            const firstBody = yield* responseJsonObject(firstResponse);

            assert.strictEqual(firstResponse.status, 409);
            assertApiError(firstBody, "RunStoreLocked", 409);
            assert.deepEqual(resolutions, []);
          }).pipe(Effect.provide(layer));
        }),
      20_000
    );

    it.effect(
      "streams delivery updates with resumable Gaia sequence SSE ids",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-delivery-",
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Stream delivery lifecycle.",
                kind: "issue",
                title: "Delivery stream",
              },
            },
            {
              deliveryGitCommandRunner: recordingGitRunner(),
              harnessProviderRegistry:
                markerWritingTestHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: recordingGitRunner(),
            deliveryPublisher: recordingDeliveryPublisher(),
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const layer = testServerLayer(cwd, {
            deliveryGitCommandRunner: recordingGitRunner(),
          });

          yield* appendTerminalRemediation(accepted.runId, cwd);
          const streamResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery/stream`
          ).pipe(Effect.provide(layer));
          const streamText = yield* streamResponse.text;
          const sse = parseSseBlocks(streamText);
          const updates = sse.map(({ data }) => data);
          const lastSequence = getNumber(
            getObjectFromArray(updates, updates.length - 1),
            "eventSequence"
          );
          const resumeResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery/stream?afterSequence=${lastSequence - 1}`
          ).pipe(Effect.provide(layer));
          const resumeBlocks = parseSseBlocks(yield* resumeResponse.text);
          const conflictResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery/stream?afterSequence=999999`
          ).pipe(Effect.provide(layer));
          const conflictBody = yield* responseJsonObject(conflictResponse);

          assert.strictEqual(streamResponse.status, 200);
          assert.isAtLeast(updates.length, 2);
          assert.deepEqual(
            sse.map(({ id }) => id),
            updates.map((update) => String(getNumber(update, "eventSequence")))
          );
          assert.deepEqual(
            updates.map((update) => getNumber(update, "eventSequence")),
            [
              ...updates.map((update) => getNumber(update, "eventSequence")),
            ].sort((left, right) => left - right)
          );
          assert.strictEqual(
            getString(getObjectFromArray(updates, updates.length - 1), "stage"),
            "remediationFailed"
          );
          assert.include(
            updates.map((update) => getString(update, "stage")),
            "waitingForPr"
          );
          assert.include(
            updates.map((update) => getString(update, "stage")),
            "remediating"
          );
          const finalUpdate = getObjectFromArray(updates, updates.length - 1);
          const publication = getObject(finalUpdate, "publication");
          assert.strictEqual(getString(publication, "state"), "confirmed");
          assert.strictEqual(
            getString(publication, "prUrl"),
            "https://github.com/cill-i-am/gaia/pull/91"
          );
          assert.notInclude(JSON.stringify(finalUpdate), "payloadDigest");
          assert.notInclude(JSON.stringify(finalUpdate), cwd);
          assert.strictEqual(resumeResponse.status, 200);
          assert.strictEqual(resumeBlocks.length, 1);
          assert.strictEqual(resumeBlocks[0]?.id, String(lastSequence));
          assert.strictEqual(conflictResponse.status, 409);
          assertApiError(conflictBody, "DeliveryStreamCursorConflict", 409);

          const cancelled = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const cancelledPaths = yield* makeRunPaths(cancelled.runId, {
            rootDirectory: cwd,
          });
          yield* fs.makeDirectory(cancelledPaths.workspace, {
            recursive: true,
          });
          yield* deriveAndRecordRunContract({
            paths: cancelledPaths,
            runId: cancelled.runId,
            spec: parseMarkdownSpec(
              "# Cancel stream\n\nClose every live feed on confirmed cancel.\n",
              "input.md"
            ),
          });
          yield* appendEvent(cancelled.runId, cancelledPaths, {
            payload: { workspacePath: "." },
            type: "WORKSPACE_PREPARED",
          });
          const cancelContent = makeModelContextContentV1({
            acceptedOutcomes: [],
            authority: ["Apply only accepted worker authority."],
            budget: { maxOutputBytes: 16_384, maxTurns: 1 },
            contentRefs: [],
            episodeRole: "workerInitial",
            instructions: ["Complete the bounded task."],
            nonGoals: [],
            outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
            planningFacts: [],
            safeExclusions: [],
            skills: [],
            stops: [],
            taskInput: "Complete the bounded task.",
            verificationCommands: [],
          });
          const cancelWorkspaceBinding =
            yield* deriveModelWorkspaceBinding(cancelledPaths);
          const cancelContract = yield* loadRunContract(
            cancelledPaths,
            cancelled.runId
          );
          const cancelContext = makeModelContextManifestV1({
            authoritativeRefs: [
              {
                digest: cancelContract.contractDigest,
                kind: "runContract",
              },
            ],
            binding: {
              episodeKey: "workerInitial",
              runId: cancelled.runId,
            },
            content: cancelContent,
            workspaceBinding: cancelWorkspaceBinding,
          });
          const cancelInvocation = makeModelInvocationManifestV1({
            acceptedProviderCapabilityObservation: "unobservable",
            adapterInputClass: "codexAppTurn",
            adapterSemantics: {
              kind: "codexAppServer",
              semanticDigest: "a".repeat(64),
            },
            authorityRef: {
              digest: "b".repeat(64),
              kind: "authority",
            },
            binding: cancelContext.payload.binding,
            budget: cancelContent.payload.budget,
            context: cancelContext,
            outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
            rendered: renderModelInputV1(cancelContent),
            runContractRef: {
              digest: cancelContract.contractDigest,
              kind: "runContract",
            },
            template: { id: "gaia.worker-input.v1", version: 1 },
            workspaceBinding: cancelWorkspaceBinding,
          });
          const cancelEpisode = yield* commitModelInvocationPair({
            context: cancelContext,
            episodeKey: "workerInitial",
            invocation: cancelInvocation,
            paths: cancelledPaths,
          });
          const cancelWorkerStarted = yield* appendEvent(
            cancelled.runId,
            cancelledPaths,
            {
              payload: {
                modelInvocationEpisode: Schema.encodeSync(
                  ModelInvocationEpisodeStartV1
                )(cancelEpisode),
              },
              type: "WORKER_STARTED",
            }
          );
          yield* appendHarnessSessionEvent(cancelled.runId, cancelledPaths, {
            capabilities: testHarnessCapabilities,
            kind: "sessionStarted",
            provider: testHarnessProvider.descriptor,
            sessionId: parseHarnessSessionId(`session-${cancelled.runId}`),
            state: "running",
          });
          const cancelEvents = yield* readEvents(cancelledPaths);
          const cancelControlFields = {
            actionId: parseRunControlActionId(
              "action-server-delivery-stream-cancel"
            ),
            authorityId: parseRunControlAuthorityId("authority-local"),
            expectedEventSequence: cancelEvents.at(-1)!.sequence,
            operation: "cancel",
            providerId: testHarnessProvider.descriptor.providerId,
            sessionId: parseHarnessSessionId(`session-${cancelled.runId}`),
            workerAgentId:
              Schema.decodeUnknownSync(FactoryAgentIdSchema)("agent-worker"),
            workerStartedSequence: cancelWorkerStarted.event.sequence,
          } as const;
          const cancelControl = parseRunControlEventPayload({
            ...cancelControlFields,
            actionBindingDigest: makeRunControlActionBindingDigest({
              ...cancelControlFields,
              runId: cancelled.runId,
            }),
          });
          for (const type of [
            "RUN_CONTROL_INTENT_RECORDED",
            "RUN_CONTROL_ATTEMPTED",
            "RUN_CONTROL_CONFIRMED",
          ] as const) {
            yield* appendEvent(cancelled.runId, cancelledPaths, {
              payload: {
                control: Schema.encodeSync(RunControlEventPayload)(
                  cancelControl
                ),
              },
              type,
            });
          }
          const cancelledFiber = yield* HttpClient.get(
            `/runs/${cancelled.runId}/delivery/stream`
          ).pipe(
            Effect.flatMap((response) => response.text),
            Effect.provide(layer),
            Effect.forkChild
          );
          const cancelledStream = yield* Effect.raceFirst(
            Fiber.join(cancelledFiber).pipe(Effect.map(Option.some)),
            Effect.promise(
              () =>
                new Promise<Option.Option<never>>((resolve) => {
                  setTimeout(() => resolve(Option.none()), 500);
                })
            )
          );

          assert.isTrue(Option.isSome(cancelledStream));
          if (Option.isSome(cancelledStream)) {
            const cancelledUpdates = parseSseBlocks(cancelledStream.value);
            assert.strictEqual(
              getNumber(
                getObjectFromArray(
                  cancelledUpdates.map(({ data }) => data),
                  cancelledUpdates.length - 1
                ),
                "eventSequence"
              ),
              cancelEvents.at(-1)!.sequence + 3
            );
          }
        }),
      20_000
    );

    it.effect(
      "opens one authoritative delivery event feed per stream connection",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-delivery-feed-",
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Count delivery stream event reads.",
                kind: "issue",
                title: "Delivery stream read count",
              },
            },
            {
              deliveryGitCommandRunner: recordingGitRunner(),
              harnessProviderRegistry:
                markerWritingTestHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: recordingGitRunner(),
            deliveryPublisher: recordingDeliveryPublisher(),
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          let deliveryEventReads = 0;
          const layer = testServerLayer(
            cwd,
            { deliveryGitCommandRunner: recordingGitRunner() },
            {
              subscribeDeliveryRunEventFeed: (paths, capacity) => {
                deliveryEventReads += 1;
                return subscribeRunEventFeed(paths, capacity);
              },
            }
          );

          yield* appendTerminalRemediation(accepted.runId, cwd);
          const streamResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery/stream`
          ).pipe(Effect.provide(layer));
          const streamBlocks = parseSseBlocks(yield* streamResponse.text);
          const readsAfterSuccess = deliveryEventReads;
          const lastSequence = getNumber(
            getObjectFromArray(
              streamBlocks.map(({ data }) => data),
              streamBlocks.length - 1
            ),
            "eventSequence"
          );
          const resumeResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery/stream?afterSequence=${lastSequence - 1}`
          ).pipe(Effect.provide(layer));
          yield* resumeResponse.text;
          const readsAfterResume = deliveryEventReads;
          const conflictResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery/stream?afterSequence=999999`
          ).pipe(Effect.provide(layer));
          yield* conflictResponse.text;

          assert.strictEqual(streamResponse.status, 200);
          assert.strictEqual(readsAfterSuccess, 1);
          assert.strictEqual(resumeResponse.status, 200);
          assert.strictEqual(readsAfterResume, 2);
          assert.strictEqual(conflictResponse.status, 409);
          assert.strictEqual(deliveryEventReads, 3);
        }),
      20_000
    );

    it.effect(
      "projects publication recovery and rejects stale delivery actions",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-delivery-recovery-",
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Recover an ambiguous publication outcome.",
                kind: "issue",
                title: "Delivery recovery",
              },
            },
            {
              deliveryGitCommandRunner: recordingGitRunner(),
              harnessProviderRegistry:
                markerWritingTestHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: recordingGitRunner(),
            deliveryPublisher: recordingUnknownDeliveryPublisher(),
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const layer = testServerLayer(cwd, {
            deliveryPublisher: reconcilingDeliveryPublisher(),
          });
          const beforeResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery`
          ).pipe(Effect.provide(layer));
          const before = getObject(
            yield* responseJsonObject(beforeResponse),
            "data"
          );
          const sequence = getNumber(before, "eventSequence");
          const staleResponse = yield* deliveryActionRequest(
            accepted.runId,
            sequence - 1
          ).pipe(HttpClient.execute, Effect.provide(layer));
          const staleBody = yield* responseJsonObject(staleResponse);
          const recoveryResponse = yield* deliveryActionRequest(
            accepted.runId,
            sequence
          ).pipe(HttpClient.execute, Effect.provide(layer));
          const recovered = getObject(
            yield* responseJsonObject(recoveryResponse),
            "data"
          );

          assert.strictEqual(
            getString(before, "stage"),
            "publicationOutcomeUnknown"
          );
          assert.deepEqual(getArray(before, "recoveryActions"), ["reconcile"]);
          assert.strictEqual(staleResponse.status, 409);
          assertApiError(staleBody, "DeliveryActionConflict", 409);
          assert.strictEqual(recoveryResponse.status, 200);
          assert.strictEqual(getString(recovered, "stage"), "waitingForPr");
          assert.deepEqual(getArray(recovered, "recoveryActions"), []);
        }),
      20_000
    );

    it.effect(
      "projects recovered delivery as terminal after confirmed merge and completed cleanup",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-terminal-delivery-",
          });
          const runId = parseRunId("run-5555555555");
          const events = recoveredCompletedDeliveryEvents(runId);
          const direct = deliveryUpdateFromEvents(runId, events);
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(
            paths.events,
            `${events.map((event) => JSON.stringify(Schema.encodeSync(RunEvent)(event))).join("\n")}\n`
          );
          yield* fs.writeFileString(paths.snapshots, "");

          assert.strictEqual(direct?.stage, "completed");
          assert.strictEqual(direct?.status, "completed");
          assert.deepEqual(direct?.recoveryActions, []);
          assert.strictEqual(direct?.authoritativeHeadSha, "a".repeat(40));
          assert.strictEqual(direct?.publication?.state, "confirmed");
          assert.strictEqual(
            direct?.latestMergeAction?.state,
            "dispatchConfirmed"
          );
          assert.strictEqual(direct?.latestCleanupAction?.state, "completed");
          assert.deepEqual(direct?.actionAudit?.merge, [
            {
              actionId: "merge-terminal-1",
              latestSequence: 14,
              state: "dispatchConfirmed",
            },
          ]);
          assert.deepEqual(direct?.actionAudit?.cleanup, [
            {
              actionId: "cleanup-terminal-1",
              latestSequence: 16,
              state: "completed",
            },
          ]);

          const response = yield* HttpClient.get(
            `/runs/${runId}/delivery`
          ).pipe(Effect.provide(testServerLayer(cwd)));
          const projected = getObject(
            yield* responseJsonObject(response),
            "data"
          );

          assert.strictEqual(response.status, 200);
          assert.strictEqual(getString(projected, "stage"), "completed");
          assert.strictEqual(getString(projected, "status"), "completed");
          assert.deepEqual(getArray(projected, "recoveryActions"), []);
          assert.strictEqual(
            getString(getObject(projected, "latestMergeAction"), "state"),
            "dispatchConfirmed"
          );
          assert.strictEqual(
            getString(getObject(projected, "latestCleanupAction"), "state"),
            "completed"
          );
        }),
      20_000
    );

    it("preserves nonterminal recovery and delivery action precedence", () => {
      const terminal = recoveredCompletedDeliveryEvents();
      const recovery = terminal.slice(0, 4);
      const continuation = appendProjectionEvent(
        recovery,
        "WORKER_CONTINUATION_RECORDED",
        {
          continuation: encodeWorkerContinuationReceiptJson({
            actionId: "continue-terminal-1",
            expectedContaminatedReadySequence: 2,
            expectedCurrentSequence: 4,
            expectedDeliveryProvenanceDigest: "9".repeat(64),
            expectedFailedRecoverySequence: 3,
            expectedRecoveryActionId: "recover-terminal-1",
            expectedSessionId: parseHarnessSessionId("session-run-1234567890"),
            harnessProfileId: parseHarnessProfileId("codexAppServer"),
            maxAttempts: 1,
            state: "intentRecorded",
            workerEvidenceEpochSequence: 4,
          }),
        }
      );
      const correlation = appendProjectionEvent(
        continuation,
        "WORKER_CORRELATION_RECONCILIATION_RECORDED",
        {
          reconciliation: encodeWorkerCorrelationReconciliationReceiptJson({
            actionId: "correlate-terminal-1",
            expectedContaminatedReadySequence: 2,
            expectedContinuationActionId: "continue-terminal-1",
            expectedCurrentSequence: 5,
            expectedDeliveryProvenanceDigest: "9".repeat(64),
            expectedFailedContinuationSequence: 5,
            expectedFailedRecoverySequence: 3,
            expectedNativeTurnIdDigest: "7".repeat(64),
            expectedRecoveryActionId: "recover-terminal-1",
            expectedSessionId: parseHarnessSessionId("session-run-1234567890"),
            harnessProfileId: parseHarnessProfileId("codexAppServer"),
            maxAttempts: 1,
            state: "intentRecorded",
            workerEvidenceEpochSequence: 5,
          }),
        }
      );
      const failedAfterRecovery = appendProjectionEvent(
        recovery,
        "RUN_FAILED",
        {
          code: "HarnessSessionFailed",
          message: "Recovered worker failed again.",
          recoverable: false,
          stage: "runningWorker",
        }
      );
      const mergeUnknown = [
        ...terminal.slice(0, 13),
        makeRunEvent({
          payload: {
            mergeAction: encodeDeliveryMergeReceiptJson(
              DeliveryMergeTerminalFailure.make({
                ...DeliveryMergeDispatchAttempted.make({
                  actionId: "merge-terminal-1",
                  branchName: "gaia/run-1234567890",
                  decisionSequence: 11,
                  expectedHeadSha: "a".repeat(40),
                  mergeMethod: "merge",
                  payloadDigest: "3".repeat(64),
                  policyDigest: "4".repeat(64),
                  policyVersion: 1,
                  prNumber: 94,
                  prUrl: "https://github.com/cill-i-am/gaia/pull/94",
                  repository: "cill-i-am/gaia",
                  state: "dispatchAttempted",
                }),
                code: "DeliveryMergeOutcomeUnknown",
                message: "Merge outcome is ambiguous.",
                state: "outcomeUnknown",
              })
            ),
          },
          runId: terminal[0]!.runId,
          sequence: 14,
          timestamp: "2026-07-13T12:01:14.000Z",
          type: "DELIVERY_MERGE_RECORDED",
        }),
      ];

      assert.strictEqual(
        deliveryUpdateFromEvents(terminal[0]!.runId, recovery)?.stage,
        "runningWorker"
      );
      assert.strictEqual(
        deliveryUpdateFromEvents(terminal[0]!.runId, continuation)?.stage,
        "workerContinuationPending"
      );
      assert.strictEqual(
        deliveryUpdateFromEvents(terminal[0]!.runId, correlation)?.stage,
        "workerCorrelationPending"
      );
      assert.strictEqual(
        deliveryUpdateFromEvents(terminal[0]!.runId, failedAfterRecovery)
          ?.stage,
        "failed"
      );
      assert.strictEqual(
        deliveryUpdateFromEvents(terminal[0]!.runId, mergeUnknown)?.stage,
        "mergeReconciliationRequired"
      );
      assert.strictEqual(
        deliveryUpdateFromEvents(terminal[0]!.runId, mergeUnknown)?.status,
        "mergeReconciliationRequired"
      );
      assert.deepEqual(
        deliveryUpdateFromEvents(terminal[0]!.runId, terminal.slice(0, 15))
          ?.recoveryActions,
        ["retryCleanup"]
      );
      assert.strictEqual(
        deliveryUpdateFromEvents(terminal[0]!.runId, terminal.slice(0, 15))
          ?.stage,
        "cleanupRequired"
      );
    });

    it.effect(
      "exposes one worker recovery action for the latest eligible failure generation",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-worker-recovery-action-",
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Expose the current worker recovery generation.",
                kind: "issue",
                title: "Worker recovery action",
              },
            },
            {
              deliveryGitCommandRunner: recordingGitRunner(),
              harnessProviderRegistry:
                markerWritingTestHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          const runId = parseRunId(accepted.runId);
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          const sessionId = parseHarnessSessionId(`session-${accepted.runId}`);
          yield* appendEvent(runId, paths, {
            payload: {
              delivery: {
                baseBranch: "main",
                baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
                headBranch: `gaia/${accepted.runId}`,
                mode: "pullRequest",
                remote: "origin",
                stage: "delivering",
              },
            },
            type: "DELIVERY_STARTED",
          });
          yield* appendHarnessSessionEvent(
            runId,
            paths,
            parseHarnessEvent({
              capabilities: {
                approvals: [],
                fileChangeEvents: true,
                interruption: true,
                resumableSessions: true,
                review: false,
                steering: true,
                streamingMessages: true,
                structuredOutput: false,
                subagents: false,
                toolEvents: true,
                usageReporting: false,
                userQuestions: false,
              },
              kind: "sessionStarted",
              provider: {
                displayName: "Codex App Server",
                executionModes: ["local"],
                providerId: "codex-app-server",
              },
              sessionId,
              state: "running",
            })
          );
          yield* appendHarnessSessionEvent(
            runId,
            paths,
            parseHarnessEvent({
              failure: {
                code: "CodexThreadSystemError",
                kind: "providerFailure",
                message: "first failure",
                recoverable: true,
              },
              kind: "sessionFailed",
              sessionId,
            })
          );
          const firstFailure = yield* appendEvent(runId, paths, {
            payload: {
              code: "HarnessSessionFailed",
              message: "first failed",
              recoverable: true,
              stage: "runningWorker",
            },
            type: "RUN_FAILED",
          });
          yield* appendEvent(runId, paths, {
            payload: {
              recovery: encodeWorkerRecoveryReceiptJson({
                actionId: "recover-old",
                attempt: 1,
                expectedFailureSequence: firstFailure.event.sequence,
                expectedSessionId: sessionId,
                harnessProfileId:
                  codexAppServerExecutionSelection.harnessProfileId,
                maxAttempts: 1,
                model: "gpt-5.4",
                nativeTurnIdDigest: "b".repeat(64),
                payloadDigest: "a".repeat(64),
                state: "dispatchConfirmed",
              }),
            },
            type: "WORKER_RECOVERY_RECORDED",
          });
          yield* appendHarnessSessionEvent(
            runId,
            paths,
            parseHarnessEvent({
              failure: {
                code: "CodexThreadSystemError",
                kind: "providerFailure",
                message: "second failure",
                recoverable: true,
              },
              kind: "sessionFailed",
              sessionId,
            })
          );
          const secondFailure = yield* appendEvent(runId, paths, {
            payload: {
              code: "HarnessSessionFailed",
              message: "second failed",
              recoverable: true,
              stage: "runningWorker",
            },
            type: "RUN_FAILED",
          });

          const response = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery`
          ).pipe(Effect.provide(testServerLayer(cwd)));
          const projected = getObject(
            yield* responseJsonObject(response),
            "data"
          );

          assert.strictEqual(response.status, 200);
          assert.deepEqual(getArray(projected, "recoveryActions"), [
            "retryWorkerRecovery",
          ]);
          assert.strictEqual(
            getNumber(projected, "eventSequence"),
            secondFailure.event.sequence
          );
          assert.strictEqual(
            getString(getObject(projected, "workerRecovery"), "actionId"),
            "recover-old"
          );
        }),
      20_000
    );

    it.effect(
      "rejects excess merge action fields and redacts private conflict causes",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-private-merge-",
          });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const hostile =
            "/HOSTILE/absolute/common-dir::PRIVATE_TOKEN_93::refs/heads/forged";
          const layer = testServerLayer(cwd, {
            deliveryMergeActivator: () =>
              Effect.fail({
                code: "DeliveryActionConflict",
                message: hostile,
                recoverable: true,
              }),
          });
          const request = (body: Record<string, unknown>) =>
            HttpClientRequest.post(
              `/runs/${accepted.runId}/delivery/actions`
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
              HttpClient.execute,
              Effect.provide(layer)
            );
          const conflict = yield* request({
            actionId: "readiness-1",
            kind: "evaluateMergeReadiness",
            mergeMethod: "merge",
          });
          const conflictText = yield* conflict.text;
          const excess = yield* request({
            actionId: "readiness-1",
            kind: "evaluateMergeReadiness",
            mergeMethod: "merge",
            ownershipToken: hostile,
          });
          const excessText = yield* excess.text;

          assert.strictEqual(conflict.status, 409);
          assert.notInclude(conflictText, hostile);
          assert.notInclude(conflictText, "PRIVATE_TOKEN_93");
          assert.strictEqual(excess.status, 400);
          assert.notInclude(excessText, hostile);
        })
    );

    it.effect(
      "redacts private cleanup provenance from public event, activity, and artifact responses",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-private-events-",
          });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const paths = yield* makeRunPaths(parseRunId(accepted.runId), {
            rootDirectory: cwd,
          });
          const hostile =
            "/HOSTILE/private/common-dir::PRIVATE_TOKEN_93::provider-secret::raw-cause";
          const runId = parseRunId(accepted.runId);
          yield* appendEvent(runId, paths, {
            payload: {
              provenance: {
                actionId: "cleanup-1",
                branchRef: "refs/heads/gaia/run-1234567890",
                expectedBranchOid: "a".repeat(40),
                mergeCommitSha: "b".repeat(40),
                ownershipDigest: "c".repeat(64),
                ownershipToken: hostile,
                payloadDigest: "d".repeat(64),
                providerId: hostile,
                rawCause: { nested: hostile },
                repositoryCommonDir: hostile,
                repositoryRoot: hostile,
                runId: accepted.runId,
                version: 1,
                worktreeCommonDir: hostile,
                worktreePath: hostile,
              },
            },
            type: "DELIVERY_CLEANUP_PROVENANCE_RECORDED",
          });
          yield* appendEvent(runId, paths, {
            payload: {
              checkpoint: {
                actionId: "cleanup-1",
                nested: { path: hostile, providerId: hostile },
                payloadDigest: "d".repeat(64),
                resource: "worktree",
                state: "removalAttempted",
                version: 1,
              },
            },
            type: "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED",
          });
          yield* appendEvent(runId, paths, {
            payload: {
              checkpoint: {
                actionId: "merge-1",
                payloadDigest: "e".repeat(64),
                providerId: hostile,
                rawCause: { nested: hostile },
                state: "reconciliationRequired",
                version: 1,
              },
            },
            type: "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED",
          });
          yield* appendEvent(runId, paths, {
            payload: {
              code: "fixture-terminal",
              message: "fixture terminal",
              recoverable: false,
              stage: "replaying",
            },
            type: "RUN_FAILED",
          });
          const layer = testServerLayer(cwd);
          const eventsResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/events`
          ).pipe(Effect.provide(layer));
          const eventsBody = yield* responseJsonObject(eventsResponse);
          const publicEvents = getArray(
            getObject(eventsBody, "data"),
            "events"
          ).map(asJsonObject);
          const privateEvents = publicEvents.filter((event) =>
            [
              "DELIVERY_CLEANUP_PROVENANCE_RECORDED",
              "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED",
              "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED",
            ].includes(getString(event, "type"))
          );
          assert.strictEqual(eventsResponse.status, 200);
          assert.lengthOf(privateEvents, 3);
          for (const event of privateEvents)
            assert.deepEqual(getObject(event, "payload"), { redacted: true });

          const activityResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/activity`
          ).pipe(Effect.provide(layer));
          const activityText = yield* activityResponse.text;
          assert.strictEqual(activityResponse.status, 200);
          assert.notInclude(activityText, hostile);

          const streamResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/events/stream`
          ).pipe(Effect.provide(layer));
          const streamEvents = parseSseDataEvents(yield* streamResponse.text);
          const privateStreamEvents = streamEvents.filter((event) =>
            [
              "DELIVERY_CLEANUP_PROVENANCE_RECORDED",
              "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED",
              "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED",
            ].includes(getString(event, "type"))
          );
          assert.strictEqual(streamResponse.status, 200);
          assert.lengthOf(privateStreamEvents, 3);
          for (const event of privateStreamEvents)
            assert.deepEqual(getObject(event, "payload"), { redacted: true });

          const catalogResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/artifacts`
          ).pipe(Effect.provide(layer));
          const catalogText = yield* catalogResponse.text;
          assert.strictEqual(catalogResponse.status, 200);
          assert.notInclude(catalogText, '"artifactId":"events"');
          assert.notInclude(catalogText, hostile);
          const rawArtifactResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/artifacts/events`
          ).pipe(Effect.provide(layer));
          assert.strictEqual(rawArtifactResponse.status, 404);
          for (const body of [
            JSON.stringify(eventsBody),
            activityText,
            JSON.stringify(streamEvents),
            catalogText,
            yield* rawArtifactResponse.text,
          ]) {
            assert.notInclude(body, hostile);
            assert.notInclude(body, "PRIVATE_TOKEN_93");
          }
        })
    );

    it.effect(
      "routes strict merge action families and maps immutable tuple conflicts",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-merge-matrix-",
          });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const seen = new Set<string>();
          let mutations = 0;
          const activate = (
            action: typeof DeliveryActionActivationSchema.Type
          ) =>
            Effect.gen(function* () {
              const key = JSON.stringify(action);
              if (action.actionId.includes("conflict"))
                return yield* Effect.fail({
                  code: "DeliveryActionConflict",
                  message: "immutable tuple changed",
                  recoverable: true,
                });
              if (!seen.has(key)) {
                seen.add(key);
                mutations += 1;
              }
              return action;
            });
          const layer = testServerLayer(cwd, {
            deliveryLocalReviewAttestationActivator: (_runId, action) =>
              activate(action),
            deliveryMergeActivator: (_runId, action) => activate(action),
            deliveryReadyForReviewActivator: (_runId, action) =>
              activate(action),
          });
          const request = (body: Record<string, unknown>) =>
            HttpClientRequest.post(
              `/runs/${accepted.runId}/delivery/actions`
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
              HttpClient.execute,
              Effect.provide(layer)
            );
          const actions = [
            {
              actionId: "ready-1",
              expectedBranchName: "gaia/run-1234567890",
              expectedHeadSha: "a".repeat(40),
              expectedPrNumber: 74,
              expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74",
              kind: "markReadyForReview",
            },
            {
              actionId: "attestation-1",
              decision: "approved",
              expectedBranchName: "gaia/run-1234567890",
              expectedHeadSha: "a".repeat(40),
              expectedPrNumber: 74,
              expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74",
              gaiaEvidenceDigest: "f".repeat(64),
              kind: "attestPairedReviewApproval",
            },
            {
              actionId: "readiness-1",
              kind: "evaluateMergeReadiness",
              mergeMethod: "merge",
            },
            {
              actionId: "merge-1",
              expectedBranchName: "gaia/run-1234567890",
              expectedDecisionSequence: 9,
              expectedHeadSha: "a".repeat(40),
              expectedPolicyDigest: "b".repeat(64),
              expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74",
              kind: "merge",
              mergeMethod: "squash",
            },
            {
              actionId: "cleanup-1",
              expectedMergeCommitSha: "c".repeat(40),
              kind: "retryCleanup",
            },
          ];
          for (const action of actions) {
            const first = yield* request(action);
            const duplicate = yield* request(action);
            assert.strictEqual(first.status, 200);
            assert.strictEqual(duplicate.status, 200);
          }
          assert.strictEqual(mutations, actions.length);
          const malformedActionId = yield* request({
            ...actions[0]!,
            actionId: "bad action id",
          });
          const malformedActionIdBody =
            yield* responseJsonObject(malformedActionId);
          assert.strictEqual(malformedActionId.status, 400);
          assertApiError(malformedActionIdBody, "InvalidRequest", 400);
          assert.strictEqual(mutations, actions.length);
          const malformedEvidenceDigest = yield* request({
            ...actions[1]!,
            gaiaEvidenceDigest: "not-a-digest",
          });
          assert.strictEqual(malformedEvidenceDigest.status, 400);
          const privateEvidenceField = yield* request({
            ...actions[1]!,
            reviewerIdentity: "cill-i-am",
          });
          assert.strictEqual(privateEvidenceField.status, 400);
          assert.strictEqual(mutations, actions.length);
          const conflicts = [
            {
              ...actions[0]!,
              actionId: "conflict-ready",
              expectedHeadSha: "d".repeat(40),
            },
            {
              ...actions[1]!,
              actionId: "conflict-attestation",
              expectedHeadSha: "d".repeat(40),
            },
            {
              ...actions[2]!,
              actionId: "conflict-readiness",
              mergeMethod: "rebase",
            },
            {
              ...actions[3]!,
              actionId: "conflict-merge",
              expectedDecisionSequence: 8,
            },
            {
              ...actions[3]!,
              actionId: "conflict-head",
              expectedHeadSha: "d".repeat(40),
            },
            {
              ...actions[3]!,
              actionId: "conflict-pr",
              expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/75",
            },
            {
              ...actions[4]!,
              actionId: "conflict-cleanup",
              expectedMergeCommitSha: "e".repeat(40),
            },
          ];
          for (const action of conflicts) {
            const response = yield* request(action);
            const body = yield* responseJsonObject(response);
            assert.strictEqual(response.status, 409);
            assertApiError(body, "DeliveryActionConflict", 409);
          }
        })
    );

    it.effect(
      "rejects a canonically hashed wrong-run ready receipt from the public projection",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-ready-authority-",
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject corrupt ready history.",
                kind: "issue",
                title: "Ready authority",
              },
            },
            {
              deliveryGitCommandRunner: recordingGitRunner(),
              harnessProviderRegistry:
                markerWritingTestHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: recordingGitRunner(),
            deliveryPublisher: recordingDeliveryPublisher(),
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const paths = yield* makeRunPaths(accepted.runId, {
            rootDirectory: cwd,
          });
          const publication = publicationTestFields(accepted.runId);
          const bindingBase = {
            actionId: "ready-wrong-run",
            branchName: publication.branchName,
            expectedHeadSha: "b".repeat(40),
            prNumber: 91,
            prUrl: "https://github.com/cill-i-am/gaia/pull/91",
            publicationOperationId: publication.operationId,
            publicationPayloadDigest: publication.payloadDigest,
            repository: "cill-i-am/gaia",
            runId: parseRunId("run-wrong12345"),
            version: 1 as const,
          };
          const ready = DeliveryPullRequestReadyIntent.make({
            ...bindingBase,
            payloadDigest: deliveryPullRequestReadyPayloadDigest(bindingBase),
            state: "intentRecorded",
          });
          const existingEvents = yield* fs.readFileString(paths.events);
          const event = makeRunEvent({
            payload: {
              readyForReviewAction:
                encodeDeliveryPullRequestReadyReceiptJson(ready),
            },
            runId: accepted.runId,
            sequence: existingEvents.trim().split("\n").length + 1,
            timestamp: "2026-07-13T08:00:00.000Z",
            type: "DELIVERY_PR_READY_RECORDED",
          });
          yield* fs.writeFileString(
            paths.events,
            `${existingEvents}${JSON.stringify(Schema.encodeSync(RunEvent)(event))}\n`
          );

          const response = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery`
          ).pipe(Effect.provide(testServerLayer(cwd)));
          const text = yield* response.text;
          const body = asJsonObject(JSON.parse(text));

          assert.strictEqual(response.status, 422);
          assertApiError(body, "RunUnreadable", 422);
          assert.notInclude(text, ready.actionId);
          assert.notInclude(text, "run-wrong12345");
        }),
      20_000
    );

    it.effect(
      "routes controlled remediation activation through the existing live coordinator",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-activation-",
          });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          let usedLiveCoordinator = false;
          let observedActionKey = "";
          const layer = testServerLayer(cwd, {
            deliveryRemediationActivator: (_runId, action, options) =>
              Effect.sync(() => {
                usedLiveCoordinator = options.sessionCoordinator !== undefined;
                observedActionKey = action.actionIdempotencyKey;
                return { observation: undefined };
              }),
          });
          const request = deliveryActivationRequest(accepted.eventSequence);
          const response = yield* HttpClientRequest.post(
            `/runs/${accepted.runId}/delivery/actions`
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe(request),
            HttpClient.execute,
            Effect.provide(layer)
          );
          const malformed = yield* HttpClientRequest.post(
            `/runs/${accepted.runId}/delivery/actions`
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({ ...request, prompt: "unsafe" }),
            HttpClient.execute,
            Effect.provide(layer)
          );

          assert.strictEqual(response.status, 200);
          assert.strictEqual(malformed.status, 400);
          assert.isTrue(usedLiveCoordinator);
          assert.strictEqual(observedActionKey, request.actionIdempotencyKey);
        }),
      20_000
    );

    it.effect(
      "projects privacy-safe PR feedback and the authoritative remediation re-arm sequence",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-remediation-",
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Project delivery remediation.",
                kind: "issue",
                title: "Delivery remediation projection",
              },
            },
            {
              deliveryGitCommandRunner: recordingGitRunner(),
              harnessProviderRegistry:
                markerWritingTestHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: recordingGitRunner(),
            deliveryPublisher: recordingDeliveryPublisher(),
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const paths = yield* makeRunPaths(accepted.runId, {
            rootDirectory: cwd,
          });
          const feedbackId = parseDeliveryFeedbackId(
            `feedback-comment-${"f".repeat(64)}`
          );
          const observation = DeliveryPullRequestObservation.make({
            blockers: [
              DeliveryBlocker.make({
                feedbackIds: [feedbackId],
                kind: "actionableFeedback",
                summary:
                  "Trusted actionable pull-request feedback requires remediation.",
              }),
            ],
            checks: [],
            draft: false,
            feedback: [
              DeliveryFeedbackObservation.make({
                actorLogin: "trusted-reviewer",
                authorAssociation: "MEMBER",
                classification: "actionable",
                contentDigest: "a".repeat(64),
                id: feedbackId,
                kind: "comment",
                url: "https://github.com/cill-i-am/gaia/pull/91#issuecomment-1",
              }),
            ],
            headSha: "b".repeat(40),
            mergeability: "mergeable",
            observedAt: "2026-07-11T11:00:00.000Z",
            prNumber: 91,
            prUrl: "https://github.com/cill-i-am/gaia/pull/91",
            repository: "cill-i-am/gaia",
            reviewDecision: "CHANGES_REQUESTED",
            snapshotDigest: "c".repeat(64),
            status: "blocked",
            version: 1,
          });
          yield* appendEvent(accepted.runId, paths, {
            payload: {
              blockerCount: 1,
              nextAction: "remediate",
              observation:
                encodeDeliveryPullRequestObservationJson(observation),
              prLoopPath: "delivery-pr-observation.json",
              pullRequest: observation.prUrl,
              status: "blocked",
            },
            type: "GITHUB_PR_LOOP_RECORDED",
          });
          const intent = DeliveryRemediationIntent.make({
            attempt: 1,
            commitTimestamp: "2026-07-11T11:00:00.000Z",
            expectedHeadSha: observation.headSha,
            feedbackDigest: observation.snapshotDigest,
            feedbackIds: [feedbackId],
            inputId: `remediation-${accepted.runId}-1`,
            operationId: `remediation:${accepted.runId}:1`,
            state: "intentRecorded",
          });
          const intentEvent = yield* appendTestRemediationIntent(
            accepted.runId,
            paths,
            intent,
            "Apply the bounded projection remediation input."
          );
          const response = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery`
          ).pipe(Effect.provide(testServerLayer(cwd)));
          const projected = getObject(
            yield* responseJsonObject(response),
            "data"
          );

          assert.strictEqual(getString(projected, "stage"), "remediating");
          assert.strictEqual(
            getString(projected, "authoritativeHeadSha"),
            observation.headSha
          );
          assert.strictEqual(
            getNumber(projected, "remediationRearmSequence"),
            intentEvent.event.sequence
          );
          assert.strictEqual(
            getString(getObject(projected, "observation"), "headSha"),
            observation.headSha
          );
          assert.strictEqual(
            getString(getObject(projected, "remediation"), "state"),
            "intentRecorded"
          );
          assert.notInclude(
            JSON.stringify(projected),
            "Project delivery remediation"
          );
          assert.notInclude(JSON.stringify(projected), "native-comment");

          const remediatedHeadSha = "d".repeat(40);
          for (const remediation of [
            DeliveryRemediationDispatchAttempted.make({
              ...intent,
              state: "dispatchAttempted",
            }),
            DeliveryRemediationTurnCompleted.make({
              ...intent,
              state: "turnCompleted",
            }),
            DeliveryRemediationVerified.make({ ...intent, state: "verified" }),
            DeliveryRemediationCommitAttempted.make({
              ...intent,
              commitSha: remediatedHeadSha,
              state: "commitAttempted",
            }),
            DeliveryRemediationPushAttempted.make({
              ...intent,
              commitSha: remediatedHeadSha,
              state: "pushAttempted",
            }),
            DeliveryRemediationConfirmed.make({
              ...intent,
              commitSha: remediatedHeadSha,
              state: "confirmed",
            }),
          ]) {
            yield* appendEvent(accepted.runId, paths, {
              payload: {
                remediation: encodeDeliveryRemediationJson(remediation),
              },
              type: "DELIVERY_REMEDIATION_RECORDED",
            });
          }
          const remediatedResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/delivery`
          ).pipe(Effect.provide(testServerLayer(cwd)));
          const remediatedProjection = getObject(
            yield* responseJsonObject(remediatedResponse),
            "data"
          );
          assert.strictEqual(
            getString(remediatedProjection, "authoritativeHeadSha"),
            remediatedHeadSha
          );
          assert.strictEqual(
            getString(
              getObject(remediatedProjection, "publication"),
              "commitSha"
            ),
            observation.headSha
          );
        }),
      20_000
    );

    it.effect(
      "maps strict agent action conflicts to public 409 errors",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const response = yield* HttpClientRequest.post(
            `/runs/${accepted.runId}/agents/agent-worker/session/actions`
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              actionId: "action-server-follow-up",
              kind: "followUp",
              sessionId: `session-${accepted.runId}`,
              text: "Continue safely.",
            }),
            HttpClient.execute,
            Effect.provide(testServerLayer(cwd))
          );
          const body = yield* responseJsonObject(response);

          assert.strictEqual(response.status, 409);
          assertApiError(body, "AgentActionConflict", 409);
        }),
      20_000
    );

    it.effect(
      "returns typed diagnostics for missing agents and corrupt projections",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const paths = yield* makeRunPaths(accepted.runId, {
            rootDirectory: cwd,
          });
          const layer = testServerLayer(cwd);

          const missingAgentResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/agents/agent-missing/activity`
          ).pipe(Effect.provide(layer));
          yield* fs.writeFileString(paths.factoryGraph, "{ not json");
          const rebuiltGraphResponse = yield* HttpClient.get(
            `/runs/${accepted.runId}/factory-graph`
          ).pipe(Effect.provide(layer));
          const missingAgentBody =
            yield* responseJsonObject(missingAgentResponse);
          const rebuiltGraph = getObject(
            yield* responseJsonObject(rebuiltGraphResponse),
            "data"
          );
          const diagnostics = getArray(rebuiltGraph, "diagnostics");

          assert.strictEqual(missingAgentResponse.status, 404);
          assertApiError(missingAgentBody, "FactoryAgentNotFound", 404);
          assert.strictEqual(rebuiltGraphResponse.status, 200);
          assert.deepInclude(
            diagnostics
              .map(asJsonObject)
              .filter(
                (diagnostic) => typeof diagnostic["sourceId"] === "string"
              )
              .map((diagnostic) => ({
                code: getString(diagnostic, "code"),
                sourceId: getString(diagnostic, "sourceId"),
              })),
            {
              code: "FactoryGraphIndexInvalid",
              sourceId: "factory-graph.json",
            }
          );
        })
    );

    it.effect(
      "refreshes external malformed run diagnostics on list and detail reads",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const store = yield* makeRunStorePaths({ rootDirectory: cwd });
          const layer = testServerLayer(cwd);

          yield* Effect.gen(function* () {
            const initialResponse = yield* HttpClient.get("/runs");
            const initialBody = yield* responseJsonObject(initialResponse);

            assert.strictEqual(initialResponse.status, 200);
            assert.deepEqual(
              getArray(getObject(initialBody, "data"), "runs"),
              []
            );

            yield* fs.makeDirectory(`${store.runsRoot}/run-not-valid`, {
              recursive: true,
            });
            yield* fs.makeDirectory(`${store.runsRoot}/run-L84-kMhLY8`);

            const listResponse = yield* HttpClient.get("/runs");
            const detailResponse = yield* HttpClient.get(
              "/runs/run-L84-kMhLY8"
            );
            const listBody = yield* responseJsonObject(listResponse);
            const detailBody = yield* responseJsonObject(detailResponse);
            const diagnostics = getArray(
              getObject(listBody, "data"),
              "diagnostics"
            );

            assert.strictEqual(listResponse.status, 200);
            assert.strictEqual(getString(listBody, "status"), "success");
            assert.sameMembers(
              diagnostics.map((_, index) =>
                getString(getObjectFromArray(diagnostics, index), "code")
              ),
              ["InvalidRunDirectory", "RunHasNoEvents"]
            );
            assert.strictEqual(detailResponse.status, 422);
            assertApiError(detailBody, "RunHasNoEvents", 422);
          }).pipe(Effect.provide(layer));
        })
    );

    it.effect(
      "preserves parseable bad-run detail diagnostics through the index",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const store = yield* makeRunStorePaths({ rootDirectory: cwd });
          yield* fs.makeDirectory(`${store.runsRoot}/run-L84-kMhLY8`, {
            recursive: true,
          });

          const response = yield* HttpClient.get("/runs/run-L84-kMhLY8").pipe(
            Effect.provide(testServerLayer(cwd))
          );
          const body = yield* responseJsonObject(response);

          assert.strictEqual(response.status, 422);
          assertApiError(body, "RunHasNoEvents", 422);
        })
    );

    it.effect(
      "returns typed 400 before persistence for invalid or sensitive input",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-preflight-",
          });
          const layer = testServerLayer(cwd);
          const response = yield* postCreateRun(layer, "   ");
          const body = yield* responseJsonObject(response);
          const secret = "sensitive-preflight-canary";
          const sensitiveResponse = yield* createRunRequest(
            `Authorization=${secret}`
          ).pipe(Effect.provide(layer));
          const sensitiveBody = yield* responseJsonObject(sensitiveResponse);

          assert.strictEqual(response.status, 400);
          assertApiError(body, "InvalidSpec", 400);
          assert.strictEqual(sensitiveResponse.status, 400);
          assertApiError(sensitiveBody, "InvalidSpec", 400);
          assert.notInclude(JSON.stringify(sensitiveBody), secret);
          assert.isFalse(yield* fs.exists(`${cwd}/.gaia`));
        })
    );

    it.effect(
      "rejects unavailable selected providers before acceptance without fallback",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-reject-",
          });
          const registry = makeHarnessProviderRegistry([
            {
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider: {
                ...testHarnessProvider,
                detect: Effect.succeed({
                  state: "authenticationRequired",
                  version: "test-1",
                }),
              },
            },
          ]);

          const response = yield* postCreateRun(
            testServerLayer(cwd, { harnessProviderRegistry: registry }),
            "This run must not fall back.\n"
          );
          const body = yield* responseJsonObject(response);
          const store = yield* makeRunStorePaths({ rootDirectory: cwd });

          assert.strictEqual(response.status, 422);
          assertApiError(body, "HarnessAuthenticationRequired", 422);
          assert.isFalse(yield* fs.exists(store.runsRoot));
        })
    );

    it.effect(
      "rolls back a pre-acceptance failure so a later create can be accepted",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-reusable-",
          });
          const store = yield* makeRunStorePaths({ rootDirectory: cwd });
          let detections = 0;
          const registry = makeHarnessProviderRegistry([
            {
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider: {
                ...testHarnessProvider,
                detect: Effect.gen(function* () {
                  detections += 1;
                  if (detections === 1) {
                    return {
                      state: "authenticationRequired",
                      version: "test-1",
                    } as const;
                  }
                  return yield* testHarnessProvider.detect;
                }),
              },
            },
          ]);
          const layer = testServerLayer(cwd, {
            harnessProviderRegistry: registry,
          });

          const { first, second } = yield* Effect.gen(function* () {
            const failed = yield* createRunRequest(
              "Fail before durable acceptance.\n"
            );
            assert.isFalse(yield* fs.exists(store.runsRoot));
            const accepted = yield* createRunRequest(
              "Accept after rollback.\n"
            );
            return { first: failed, second: accepted };
          }).pipe(Effect.provide(layer));
          const firstBody = yield* responseJsonObject(first);
          const secondBody = yield* responseJsonObject(second);

          assert.strictEqual(first.status, 422);
          assertApiError(firstBody, "HarnessAuthenticationRequired", 422);
          assert.strictEqual(second.status, 202);
          assert.strictEqual(getString(secondBody, "status"), "accepted");
        })
    );

    it.effect("rejects path-bearing and unknown create request shapes", () =>
      Effect.gen(function* () {
        const layer = testServerLayer(".");
        const pathBearing = yield* createRunRequestFromPayload({
          browserEvidenceTargetUrl: "http://127.0.0.1:3000",
          codexHarness: { command: "codex" },
          processHarness: { command: "node", args: ["harness.mjs"] },
          profile: "dogfood",
          skillManifestSource: "skills.json",
          specMarkdown: "Only Markdown content is accepted here.\n",
          workspaceSource: ".",
        }).pipe(Effect.provide(layer));
        const unknownOptions = yield* createRunRequestFromPayload({
          options: { workspaceSource: "." },
          specMarkdown: "Unknown option bags are rejected too.\n",
        }).pipe(Effect.provide(layer));
        const pathBearingBody = yield* responseJsonObject(pathBearing);
        const unknownOptionsBody = yield* responseJsonObject(unknownOptions);

        assert.strictEqual(pathBearing.status, 400);
        assertApiError(pathBearingBody, "InvalidRequest", 400);
        assert.strictEqual(unknownOptions.status, 400);
        assertApiError(unknownOptionsBody, "InvalidRequest", 400);
      })
    );

    it.effect(
      "returns typed 409 while a server-created run is active",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const release = yield* Deferred.make<void>();
          const layer = testServerLayer(cwd, {
            reviewer: pausingReviewer(release),
          });

          const responses = yield* Effect.all(
            [
              createRunRequest("Keep this run active.\n"),
              createRunRequest("Conflict with active run.\n"),
            ],
            { concurrency: "unbounded" }
          ).pipe(Effect.provide(layer));
          const first = responses.find((response) => response.status === 202);
          const second = responses.find((response) => response.status === 409);

          if (first === undefined || second === undefined) {
            assert.fail(
              "Expected one accepted response and one conflict response."
            );
          }

          const body = yield* responseJsonObject(second);

          assert.strictEqual(first.status, 202);
          assert.strictEqual(second.status, 409);
          assertApiError(body, "ActiveRunConflict", 409);

          yield* Deferred.succeed(release, undefined);
        }),
      20_000
    );

    it.effect(
      "resolves provider semantics before reserving create ownership",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-accepting-",
          });
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const registry = pausingFirstDetectionRegistry(entered, release);
          const layer = testServerLayer(cwd, {
            harnessProviderRegistry: registry,
          });

          const { first, second } = yield* Effect.gen(function* () {
            const firstFiber = yield* createRunRequest(
              "Pause during acceptance.\n"
            ).pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const conflict = yield* createRunRequest(
              "Conflict while accepting.\n"
            );
            yield* Deferred.succeed(release, undefined);
            const accepted = yield* Fiber.join(firstFiber);
            return { first: accepted, second: conflict };
          }).pipe(Effect.provide(layer));
          const firstBody = yield* responseJsonObject(first);

          assert.strictEqual(first.status, 409);
          assert.strictEqual(second.status, 202);
          assertApiError(firstBody, "ActiveRunConflict", 409);
        }),
      20_000
    );

    it.effect(
      "rolls back a canceled pre-acceptance create so a later create is accepted",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-cancel-accepting-",
          });
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const registry = pausingFirstDetectionRegistry(entered, release);
          const layer = testServerLayer(cwd, {
            harnessProviderRegistry: registry,
          });

          const second = yield* Effect.gen(function* () {
            const server = yield* HttpServer.HttpServer;
            const firstRequest = startNativeCreateRunRequest(
              loopbackServerUrl(server),
              "Cancel during acceptance.\n"
            );
            yield* Deferred.await(entered);
            const socket = yield* Effect.promise(() => firstRequest.socket);
            socket.resetAndDestroy();
            yield* Effect.promise(() => firstRequest.closed);
            return yield* eventuallyAcceptedCreate(
              "Accept after cancellation rollback.\n"
            );
          }).pipe(
            Effect.ensuring(Deferred.succeed(release, undefined)),
            Effect.provide(layer)
          );
          const body = yield* responseJsonObject(second);

          assert.strictEqual(second.status, 202);
          assert.strictEqual(getString(body, "status"), "accepted");
        }),
      20_000
    );

    it.effect(
      "keeps the running reservation owned after canceling a post-markAccepted request",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-cancel-running-",
          });
          const markedAccepted = yield* Deferred.make<void>();
          const releaseReviewer = yield* Deferred.make<void>();
          const layer = testServerLayer(
            cwd,
            { reviewer: pausingReviewer(releaseReviewer) },
            {
              afterCreateRunAccepted: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(markedAccepted, undefined);
                  yield* Effect.never;
                }),
            }
          );

          const second = yield* Effect.gen(function* () {
            const firstFiber = yield* createRunRequest(
              "Cancel after markAccepted.\n"
            ).pipe(Effect.forkChild);
            yield* Deferred.await(markedAccepted);
            yield* Fiber.interrupt(firstFiber);
            const conflict = yield* createRunRequest(
              "Conflict with running owner.\n"
            );
            yield* Deferred.succeed(releaseReviewer, undefined);
            return conflict;
          }).pipe(Effect.provide(layer));
          const secondBody = yield* responseJsonObject(second);

          assert.strictEqual(second.status, 409);
          assertApiError(secondBody, "ActiveRunConflict", 409);
        }),
      20_000
    );

    it.effect(
      "serves verification actions and preserves typed provider diagnostics",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-verification-actions-",
          });
          const successful = yield* makeVerificationActionFixture(
            cwd,
            parseRunId("run-Gaia145ok1"),
            true
          );
          const unavailable = yield* makeVerificationActionFixture(
            cwd,
            parseRunId("run-Gaia145bad"),
            false
          );
          const serverLayer = testServerLayer(cwd);
          const successResponse = yield* HttpClientRequest.post(
            `/runs/${successful.runId}/verification/actions`
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe(successful.action),
            HttpClient.execute,
            Effect.provide(serverLayer)
          );
          const unavailableResponse = yield* HttpClientRequest.post(
            `/runs/${unavailable.runId}/verification/actions`
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe(unavailable.action),
            HttpClient.execute,
            Effect.provide(serverLayer)
          );
          const successBody = yield* responseJsonObject(successResponse);
          const unavailableBody =
            yield* responseJsonObject(unavailableResponse);

          assert.strictEqual(successResponse.status, 200);
          assert.strictEqual(getString(successBody, "status"), "success");
          assert.strictEqual(
            getString(getObject(successBody, "data"), "kind"),
            "postPublicationGenerationRecorded"
          );
          assert.strictEqual(unavailableResponse.status, 422);
          assertApiError(unavailableBody, "VerificationProviderFailure", 422);
        }),
      20_000
    );

    it.effect(
      "rejects malformed ids, path-like artifacts, and mutation methods",
      () =>
        Effect.gen(function* () {
          const layer = testServerLayer(".");
          const badRun = yield* HttpClient.get("/runs/not-a-run").pipe(
            Effect.provide(layer)
          );
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
          const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry:
              markerWritingTestHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const artifactLayer = testServerLayer(cwd);
          const badArtifact = yield* HttpClient.get(
            `/runs/${accepted.runId}/artifacts/..%2Fevents.jsonl`
          ).pipe(Effect.provide(artifactLayer));
          const unknownArtifact = yield* HttpClient.get(
            `/runs/${accepted.runId}/artifacts/report.json`
          ).pipe(Effect.provide(artifactLayer));
          const post = yield* HttpClientRequest.post("/runs").pipe(
            HttpClient.execute,
            Effect.provide(layer)
          );
          const put = yield* HttpClientRequest.put("/runs/not-a-run").pipe(
            HttpClient.execute,
            Effect.provide(layer)
          );
          const verificationPost = yield* HttpClientRequest.post(
            `/runs/${accepted.runId}/verification/actions`
          ).pipe(HttpClient.execute, Effect.provide(artifactLayer));
          const head = yield* HttpClientRequest.head("/runs").pipe(
            HttpClient.execute,
            Effect.provide(layer)
          );
          const malformedPath = yield* HttpClient.get("/runs/%E0%A4%A").pipe(
            Effect.provide(layer)
          );
          const badRunBody = yield* responseJsonObject(badRun, "bad run");
          const badArtifactBody = yield* responseJsonObject(
            badArtifact,
            "bad artifact"
          );
          const unknownArtifactBody = yield* responseJsonObject(
            unknownArtifact,
            "unknown artifact"
          );
          const postBody = yield* responseJsonObject(post, "post runs");
          const putBody = yield* responseJsonObject(put, "put run");
          const verificationPostBody = yield* responseJsonObject(
            verificationPost,
            "verification post"
          );
          const malformedPathBody = yield* responseJsonObject(
            malformedPath,
            "malformed path"
          );

          assert.strictEqual(badRun.status, 400);
          assertApiError(badRunBody, "InvalidRunId", 400);
          assert.strictEqual(badArtifact.status, 404);
          assertApiError(badArtifactBody, "ArtifactNotFound", 404);
          assert.strictEqual(unknownArtifact.status, 404);
          assertApiError(unknownArtifactBody, "ArtifactNotFound", 404);
          assert.strictEqual(post.status, 400);
          assertApiError(postBody, "InvalidRequest", 400);
          assert.strictEqual(put.status, 405);
          assertApiError(putBody, "MethodNotAllowed", 405);
          assert.strictEqual(verificationPost.status, 400);
          assertApiError(verificationPostBody, "InvalidRequest", 400);
          assert.strictEqual(head.status, 405);
          assert.strictEqual(malformedPath.status, 404);
          assertApiError(malformedPathBody, "EndpointNotFound", 404);
        })
    );
  });
});

function testServerLayer(
  rootDirectory: typeof RunStorageRootInputSchema.Encoded,
  workflowOptions: ServerWorkflowOptions = {},
  serverOptions: Parameters<typeof makeLocalGaiaServerLayer>[3] = {}
) {
  return makeLocalGaiaServerLayer(
    testIdentity(rootDirectory),
    {
      harnessProviderRegistry:
        markerWritingTestHarnessProviderRegistry(rootDirectory),
      ...workflowOptions,
    },
    [],
    serverOptions
  ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
}

function markerWritingTestHarnessProviderRegistry(
  rootDirectory: typeof RunStorageRootInputSchema.Encoded
) {
  return makeHarnessProviderRegistry([
    {
      profileId: codexAppServerExecutionSelection.harnessProfileId,
      provider: {
        ...testHarnessProvider,
        createSession: (request) =>
          Effect.sync(() => {
            const runId = request.sessionId.slice("session-".length);
            const workspace = `${rootDirectory}/.gaia/runs/${runId}/workspace`;
            mkdirSync(workspace, { recursive: true });
            writeFileSync(
              `${workspace}/output.txt`,
              `test interactive completion ${runId}\n`
            );
          }).pipe(Effect.andThen(testHarnessProvider.createSession(request))),
      },
    },
  ]);
}

function makeVerificationActionFixture(
  rootDirectory: typeof RunStorageRootInputSchema.Encoded,
  runId: ReturnType<typeof parseRunId>,
  published: boolean
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    yield* fs.makeDirectory(paths.workspace, { recursive: true });
    yield* fs.writeFileString(paths.verificationLog, "");
    const spec = parseMarkdownSpec(
      yield* fs.readFileString(
        `${process.cwd()}/../../examples/specs/claim-verification-v2.md`
      ),
      "claim-verification-v2"
    );
    const provenance = {
      baseBranch: "main",
      baseRevision: "1".repeat(40),
      headBranch: `gaia/${runId}`,
      mode: "pullRequest" as const,
      remote: "origin",
    };
    yield* appendEvent(runId, paths, {
      payload: { delivery: provenance, specPath: "input.md" },
      type: "RUN_CREATED",
    });
    const contract = yield* deriveAndRecordRunContract({
      deliveryProvenance: provenance,
      paths,
      runId,
      spec,
    });
    yield* appendEvent(runId, paths, {
      payload: { delivery: { ...provenance, stage: "delivering" } },
      type: "DELIVERY_STARTED",
    });
    yield* appendEvent(runId, paths, {
      payload: { workspacePath: "workspace" },
      type: "WORKSPACE_PREPARED",
    });
    yield* appendEvent(runId, paths, { type: "WORKER_STARTED" });
    const workerCompletion = yield* appendEvent(runId, paths, {
      payload: { workerResultPath: "worker-result.json" },
      type: "WORKER_COMPLETED",
    });
    const current = yield* appendEvent(runId, paths, {
      type: "VERIFICATION_STARTED",
    });
    if (!published) {
      return {
        action: {
          actionId: "reconcile-unavailable-gaia-145",
          claimId: contract.proofClaims[0]!.claimId,
          expectedContentAuthoritySequence: workerCompletion.event.sequence,
          expectedContractDigest: contract.contractDigest,
          expectedEventSequence: current.event.sequence,
          expectedExecutionEvidenceIdentityDigest: "2".repeat(64),
          expectedSandboxName: `gaia-${runId}-smoke-command`,
          expectedSandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
          kind: "reconcileOutcomeUnknown",
          prior: {
            kind: "createdWithoutCommandStart",
            priorSandboxCreatedSequence: current.event.sequence,
          },
          priorGenerationSequence: current.event.sequence,
        },
        runId,
      };
    }

    const publicationBase = {
      baseBranch: provenance.baseBranch,
      baseRevision: provenance.baseRevision,
      branchName: provenance.headBranch,
      commitMessage: "fix(server): serve verification actions",
      commitTimestamp: "2026-07-20T22:00:00.000Z",
      digestVersion: 1 as const,
      operationId: `publish-${runId}`,
      payloadDigest: "3".repeat(64),
      sourcePaths: ["apps/server/src/api.ts"],
      treeSha: "4".repeat(40),
    };
    const intent = DeliveryPublicationIntent.make({
      ...publicationBase,
      state: "intentRecorded",
    });
    yield* appendEvent(runId, paths, {
      payload: { publication: encodeDeliveryPublicationJson(intent) },
      type: "DELIVERY_PUBLICATION_INTENT_RECORDED",
    });
    const attempted = DeliveryPublicationAttempted.make({
      ...publicationBase,
      commitSha: "5".repeat(40),
      state: "attempted",
    });
    yield* appendEvent(runId, paths, {
      payload: { publication: encodeDeliveryPublicationJson(attempted) },
      type: "DELIVERY_PUBLICATION_ATTEMPTED",
    });
    const confirmed = DeliveryPublicationConfirmed.make({
      ...publicationBase,
      commitSha: "5".repeat(40),
      draft: true,
      headSha: "5".repeat(40),
      prNumber: 145,
      prUrl: "https://github.com/cill-i-am/gaia/pull/145",
      state: "confirmed",
    });
    const publication = yield* appendEvent(runId, paths, {
      payload: { publication: encodeDeliveryPublicationJson(confirmed) },
      type: "DELIVERY_PUBLICATION_CONFIRMED",
    });
    return {
      action: {
        actionId: "post-publication-gaia-145-api",
        expectedContentAuthoritySequence: workerCompletion.event.sequence,
        expectedContractDigest: contract.contractDigest,
        expectedEventSequence: publication.event.sequence,
        expectedHeadSha: confirmed.headSha,
        expectedPublicationSequence: publication.event.sequence,
        expectedTargetDigest: contract.targetDigest,
        kind: "startPostPublicationGeneration",
      },
      runId,
    };
  });
}

function testIdentity(
  rootDirectory: typeof RunStorageRootInputSchema.Encoded
): LocalServerIdentity {
  return {
    host: "127.0.0.1",
    pid: process.pid,
    rootDirectory,
    serverId: "srv_test",
    startedAt: "2026-07-06T00:00:00.000Z",
  };
}

const serverRecoveredTurnId = parseHarnessTurnId("turn-server-recovered");
const serverOldTurnId = parseHarnessTurnId("turn-server-old");
const serverRecoveredInteractionId = "interaction-server-recovered";
const serverOldInteractionId = "interaction-server-old";

const pendingApprovalCapabilities = HarnessCapabilities.make({
  approvals: ["command"],
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: false,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: false,
});

const pendingApprovalProvider = HarnessProviderDescriptor.make({
  displayName: "Pending Approval Harness",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("pending-approval"),
});

function pendingApprovalRegistry(resolutions: unknown[]) {
  return makeHarnessProviderRegistry([
    {
      profileId: codexAppServerExecutionSelection.harnessProfileId,
      provider: {
        createSession: (request) =>
          Effect.succeed(
            pendingApprovalSession(request.sessionId, resolutions)
          ),
        descriptor: pendingApprovalProvider,
        detect: Effect.succeed({
          auth: { state: "notRequired" },
          capabilities: pendingApprovalCapabilities,
          state: "available",
          version: "pending-approval-1",
        }),
        resumeSession: (request) =>
          Effect.succeed(
            pendingApprovalSession(request.sessionId, resolutions)
          ),
      },
    },
  ]);
}

function pendingApprovalSession(
  sessionId: ReturnType<typeof parseHarnessSessionId>,
  resolutions: unknown[]
) {
  const events = [
    {
      capabilities: pendingApprovalCapabilities,
      kind: "sessionStarted" as const,
      provider: pendingApprovalProvider,
      sessionId,
      state: "running" as const,
    },
    {
      kind: "turnStarted" as const,
      sessionId,
      turnId: serverOldTurnId,
    },
    {
      interaction: {
        allowedDecisions: ["decline", "cancel"] as const,
        command: "pnpm gaia doctor --json",
        interactionId: parseHarnessInteractionId(serverOldInteractionId),
        itemId: parseHarnessItemId("item-server-old"),
        kind: "commandApproval" as const,
        reason: "Run stale doctor smoke",
        requestedAt: "2026-07-13T02:00:00.000Z",
        turnId: serverOldTurnId,
        workspacePath: parseWorkspaceRelativePath("."),
      },
      kind: "interactionRequested" as const,
      sessionId,
    },
    {
      failure: {
        code: "ProviderCrashed",
        kind: "providerFailure" as const,
        message: "Provider stopped unexpectedly.",
        recoverable: true,
      },
      kind: "sessionFailed" as const,
      sessionId,
    },
    {
      kind: "sessionRecovered" as const,
      sessionId,
    },
    {
      kind: "turnStarted" as const,
      sessionId,
      turnId: serverRecoveredTurnId,
    },
    {
      interaction: {
        allowedDecisions: ["decline", "cancel"] as const,
        command: "pnpm gaia doctor --json",
        interactionId: parseHarnessInteractionId(serverRecoveredInteractionId),
        itemId: parseHarnessItemId("item-server-recovered"),
        kind: "commandApproval" as const,
        reason: "Run recovered doctor smoke",
        requestedAt: "2026-07-13T02:00:01.000Z",
        turnId: serverRecoveredTurnId,
        workspacePath: parseWorkspaceRelativePath("."),
      },
      kind: "interactionRequested" as const,
      sessionId,
    },
  ];
  return {
    events: Stream.fromIterable(events).pipe(Stream.concat(Stream.never)),
    interrupt: Option.some(Effect.void),
    resolveInteraction: (resolution: unknown) =>
      Effect.sync(() => {
        resolutions.push(resolution);
      }),
    send: () => Effect.succeed(undefined),
    snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
    steer: Option.none(),
  };
}

function eventuallyAgentSession(runIdInput: typeof RunIdSchema.Encoded) {
  return Effect.gen(function* () {
    const runId = Schema.decodeUnknownSync(RunIdSchema)(runIdInput);
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const response = yield* HttpClient.get(
        `/runs/${runId}/agents/agent-worker/session`
      );
      if (response.status === 200) {
        const snapshot = getObject(yield* responseJsonObject(response), "data");
        const pendingInteractionIds = getArray(snapshot, "pendingInteractions")
          .map(asJsonObject)
          .map((interaction) => getString(interaction, "interactionId"));
        if (pendingInteractionIds.includes(serverRecoveredInteractionId)) {
          return snapshot;
        }
      }
      yield* Effect.yieldNow;
    }
    assert.fail("Expected recovered agent session to become visible.");
  });
}

function responseJsonObject(
  response: HttpClientResponse.HttpClientResponse,
  label = "response"
) {
  return response.json.pipe(
    Effect.flatMap((parsed) => {
      if (isJsonObject(parsed)) {
        return Effect.succeed(parsed);
      }

      return Effect.fail(
        new Error(
          `${label} JSON was not an object at status ${response.status}: ${JSON.stringify(parsed)}.`
        )
      );
    })
  );
}

function parseSseDataEvents(text: string) {
  return parseSseBlocks(text).map(({ data }) => data);
}

const SseBlockSchema = Schema.Struct({
  data: Schema.Record(Schema.String, Schema.Json),
  id: Schema.UndefinedOr(Schema.String),
});
const decodeSseBlock = Schema.decodeUnknownSync(SseBlockSchema);

function parseSseBlocks(
  text: string
): ReadonlyArray<typeof SseBlockSchema.Type> {
  return text
    .trim()
    .split(/\r?\n\r?\n/u)
    .flatMap((block) => {
      const id = block
        .split(/\r?\n/u)
        .find((line) => line.startsWith("id:"))
        ?.slice("id:".length)
        .trimStart();
      const dataLines = block
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());

      if (dataLines.length === 0) {
        return [];
      }

      const parsed: unknown = JSON.parse(dataLines.join("\n"));
      if (!isJsonObject(parsed)) {
        throw new Error(
          `Expected SSE data event to be an object: ${dataLines.join("\n")}.`
        );
      }

      return [decodeSseBlock({ data: parsed, id })];
    });
}

function assertApiError(
  body: Readonly<Record<string, unknown>>,
  code: string,
  status: number
) {
  assert.strictEqual(getString(body, "code"), code);
  assert.strictEqual(getNumber(body, "status"), status);
  assert.strictEqual(typeof body["message"], "string");
  assert.strictEqual(typeof body["recoverable"], "boolean");
  assert.notProperty(body, "error");
}

function postCreateRun(
  layer: ReturnType<typeof testServerLayer>,
  specMarkdown: string
) {
  return createRunRequest(specMarkdown).pipe(Effect.provide(layer));
}

function createRunRequest(specMarkdown: string) {
  return createRunRequestFromPayload(createRunPayload(specMarkdown));
}

function createRunPayload(specMarkdown: string) {
  return {
    delivery: { mode: "local" },
    execution: codexAppServerExecutionSelection,
    workflow: "issueDelivery",
    workItem: {
      description: specMarkdown,
      kind: "issue",
      title: "Server API test run",
    },
  } as const;
}

function createRunRequestFromPayload(payload: unknown) {
  return HttpClientRequest.post("/runs").pipe(
    HttpClientRequest.bodyJsonUnsafe(payload),
    HttpClient.execute
  );
}

function deliveryActivationRequest(expectedEventSequence: number) {
  return {
    actionIdempotencyKey: "activate-gaia-92-attempt-1",
    actorLogin: "cill-i-am",
    actorType: "User",
    authorAssociation: "OWNER",
    authorizationDigest: "a".repeat(64),
    commentDatabaseId: "104",
    contentDigest: "b".repeat(64),
    expectedEventSequence,
    feedbackId: `feedback-comment-${"c".repeat(64)}`,
    headSha: "d".repeat(40),
    kind: "activateRemediation",
    marker: "<!-- gaia-remediation-request:v1 -->",
    prNumber: 92,
    repository: "cill-i-am/gaia",
  } as const;
}

function factoryCreateInput() {
  return decodeCreateRunRequest({
    delivery: { mode: "local" },
    execution: codexAppServerExecutionSelection,
    workflow: "issueDelivery",
    workItem: {
      description: "Deliver the server endpoint slice.",
      externalRefs: [
        {
          id: "GAIA-67",
          provider: "linear",
          url: "https://linear.app/tskr/issue/GAIA-67",
        },
      ],
      kind: "issue",
      title: "Wire LocalGaiaServerApi factory endpoints",
    },
  });
}

function pausingFirstDetectionRegistry(
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
) {
  let detections = 0;
  return makeHarnessProviderRegistry([
    {
      profileId: codexAppServerExecutionSelection.harnessProfileId,
      provider: {
        ...testHarnessProvider,
        detect: Effect.gen(function* () {
          detections += 1;
          if (detections === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return yield* testHarnessProvider.detect;
        }),
      },
    },
  ]);
}

function eventuallyAcceptedCreate(specMarkdown: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = yield* createRunRequest(specMarkdown);
      if (response.status === 202) {
        return response;
      }
      if (response.status !== 409) {
        assert.fail(
          `Expected create retry to return 202 or transient 409, got ${response.status}.`
        );
      }
      yield* Effect.yieldNow;
    }
    assert.fail(
      "Expected canceled pre-acceptance create to release its reservation."
    );
  });
}

function startNativeCreateRunRequest(
  baseUrlInput: typeof LocalGaiaServerUrlSchema.Encoded,
  specMarkdown: string
) {
  const baseUrl = Schema.decodeUnknownSync(LocalGaiaServerUrlSchema)(
    baseUrlInput
  );
  const body = JSON.stringify(createRunPayload(specMarkdown));
  const request = httpRequest(new URL("/runs", baseUrl), {
    headers: {
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json",
    },
    method: "POST",
  });
  const socket = new Promise<import("node:net").Socket>((resolve) => {
    request.once("socket", resolve);
  });
  const closed = new Promise<void>((resolve) => {
    request.once("close", resolve);
    request.once("error", () => resolve());
  });
  request.write(body);
  request.end();
  return { closed, request, socket } as const;
}

function loopbackServerUrl(server: { readonly address: HttpServer.Address }) {
  const address = server.address;
  if (address._tag !== "TcpAddress") {
    assert.fail("Expected test server to bind a TCP address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

function recordingGitRunner() {
  const RecordingGitCommandSchema = Schema.Struct({
    args: Schema.Array(Schema.String),
    cwd: RuntimePathTextSchema,
  });
  return (command: typeof RecordingGitCommandSchema.Type) =>
    Effect.sync(() => {
      const [first, ...rest] = command.args;
      if (first === "rev-parse" && rest[0] === "--show-toplevel") {
        return { stderr: "", stdout: `${command.cwd}\n` };
      }
      if (
        first === "rev-parse" &&
        rest[0] === "--path-format=absolute" &&
        rest[1] === "--git-common-dir"
      ) {
        return { stderr: "", stdout: `${command.cwd}/.git\n` };
      }
      if (first === "fetch") {
        return { stderr: "", stdout: "" };
      }
      if (first === "remote" && rest[0] === "get-url") {
        return {
          stderr: "",
          stdout: "https://github.com/cill-i-am/gaia.git\n",
        };
      }
      if (first === "rev-parse" && rest[0] === "origin/main") {
        return {
          stderr: "",
          stdout: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92\n",
        };
      }
      if (first === "rev-parse" && rest[0] === "HEAD") {
        return {
          stderr: "",
          stdout: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92\n",
        };
      }
      if (first === "worktree" && rest[0] === "add") {
        return { stderr: "", stdout: "" };
      }
      throw new Error(`Unexpected git command ${command.args.join(" ")}`);
    });
}

function appendTerminalRemediation(
  runId: ReturnType<typeof parseRunId>,
  rootDirectoryInput: typeof RunStorageRootInputSchema.Encoded
) {
  return Effect.gen(function* () {
    const rootDirectory = parseRunStorageRootInput(rootDirectoryInput);
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    const intent = DeliveryRemediationIntent.make({
      attempt: 1,
      commitTimestamp: "2026-07-11T11:00:00.000Z",
      expectedHeadSha: "b".repeat(40),
      feedbackDigest: "9".repeat(64),
      feedbackIds: [
        parseDeliveryFeedbackId(`feedback-check-${"8".repeat(64)}`),
      ],
      inputId: `remediation-${runId}-1`,
      operationId: `remediation:${runId}:1`,
      state: "intentRecorded",
    });
    yield* appendTestRemediationIntent(
      runId,
      paths,
      intent,
      "Apply the bounded terminal remediation input."
    );
    yield* appendEvent(runId, paths, {
      payload: {
        remediation: encodeDeliveryRemediationJson(
          DeliveryRemediationFailed.make({
            ...intent,
            code: "TestTerminalBlocker",
            message: "Terminal test blocker.",
            recoverable: false,
            state: "failed",
          })
        ),
      },
      type: "DELIVERY_REMEDIATION_RECORDED",
    });
  });
}

function appendTestRemediationIntent(
  runId: ReturnType<typeof parseRunId>,
  paths: RunPaths,
  intent: DeliveryRemediationIntent,
  taskInput: string
) {
  return Effect.gen(function* () {
    const modelInvocationEpisode =
      yield* commitDerivedAppModelInvocationEpisode({
        episodeKey: `deliveryRemediation:${intent.operationId}`,
        episodeRole: "deliveryRemediation",
        events: yield* readEvents(paths),
        paths,
        runId,
        taskInput,
      });
    return yield* appendEvent(runId, paths, {
      payload: {
        remediation: encodeDeliveryRemediationJson(intent),
        ...(modelInvocationEpisode === undefined
          ? {}
          : {
              modelInvocationEpisode: Schema.encodeSync(
                ModelInvocationEpisodeStartV1
              )(modelInvocationEpisode),
            }),
      },
      type: "DELIVERY_REMEDIATION_RECORDED",
    });
  });
}

function recordingDeliveryPublisher() {
  return (
    runId: ReturnType<typeof parseRunId>,
    options: DeliveryPublicationOptions = {}
  ) =>
    Effect.gen(function* () {
      const paths = yield* makeRunPaths(runId, options);
      const fields = publicationTestFields(runId);
      const intent = DeliveryPublicationIntent.make({
        ...fields,
        state: "intentRecorded",
      });
      const attempted = DeliveryPublicationAttempted.make({
        ...fields,
        commitSha: "b".repeat(40),
        state: "attempted",
        treeSha: "d".repeat(40),
      });
      const confirmed = DeliveryPublicationConfirmed.make({
        ...attempted,
        draft: true,
        headSha: attempted.commitSha,
        prNumber: 91,
        prUrl: "https://github.com/cill-i-am/gaia/pull/91",
        state: "confirmed",
      });
      for (const [type, publication] of [
        ["DELIVERY_PUBLICATION_INTENT_RECORDED", intent],
        ["DELIVERY_PUBLICATION_ATTEMPTED", attempted],
        ["DELIVERY_PUBLICATION_CONFIRMED", confirmed],
      ] as const) {
        yield* appendEvent(runId, paths, {
          payload: { publication: encodeDeliveryPublicationJson(publication) },
          type,
        });
      }
      return confirmed;
    });
}

function recordingUnknownDeliveryPublisher() {
  return (
    runId: ReturnType<typeof parseRunId>,
    options: DeliveryPublicationOptions = {}
  ) =>
    Effect.gen(function* () {
      const paths = yield* makeRunPaths(runId, options);
      const fields = publicationTestFields(runId);
      const intent = DeliveryPublicationIntent.make({
        ...fields,
        state: "intentRecorded",
      });
      const attempted = DeliveryPublicationAttempted.make({
        ...fields,
        commitSha: "b".repeat(40),
        state: "attempted",
        treeSha: "d".repeat(40),
      });
      const unknown = DeliveryPublicationOutcomeUnknown.make({
        ...attempted,
        code: "DeliveryPublicationOutcomeUnknown",
        message: "Gaia could not confirm the external publication outcome.",
        recoverable: true,
        state: "outcomeUnknown",
        step: "pullRequest",
      });
      for (const [type, publication] of [
        ["DELIVERY_PUBLICATION_INTENT_RECORDED", intent],
        ["DELIVERY_PUBLICATION_ATTEMPTED", attempted],
        ["DELIVERY_PUBLICATION_OUTCOME_UNKNOWN", unknown],
      ] as const) {
        yield* appendEvent(runId, paths, {
          payload: { publication: encodeDeliveryPublicationJson(publication) },
          type,
        });
      }
      return unknown;
    });
}

function reconcilingDeliveryPublisher() {
  return (
    runId: ReturnType<typeof parseRunId>,
    options: DeliveryPublicationOptions = {}
  ) =>
    Effect.gen(function* () {
      const paths = yield* makeRunPaths(runId, options);
      const confirmed = DeliveryPublicationConfirmed.make({
        ...publicationTestFields(runId),
        commitSha: "b".repeat(40),
        draft: true,
        headSha: "b".repeat(40),
        prNumber: 91,
        prUrl: "https://github.com/cill-i-am/gaia/pull/91",
        state: "confirmed",
        treeSha: "d".repeat(40),
      });
      yield* appendEvent(runId, paths, {
        payload: { publication: encodeDeliveryPublicationJson(confirmed) },
        type: "DELIVERY_PUBLICATION_CONFIRMED",
      });
      return confirmed;
    });
}

function publicationTestFields(runId: ReturnType<typeof parseRunId>) {
  return {
    baseBranch: "main",
    baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
    branchName: `gaia/${runId}`,
    commitMessage: `feat: deliver ${runId}`,
    commitTimestamp: "2026-07-11T00:00:00.000Z",
    digestVersion: 1 as const,
    operationId: `publish-${runId}-1`,
    payloadDigest: "c".repeat(64),
    sourcePaths: ["src/feature.ts"],
    treeSha: "d".repeat(40),
  };
}

function deliveryActionRequest(
  runIdInput: typeof RunIdSchema.Encoded,
  expectedEventSequence: number
) {
  const runId = Schema.decodeUnknownSync(RunIdSchema)(runIdInput);
  return HttpClientRequest.post(`/runs/${runId}/delivery/actions`).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      expectedEventSequence,
      kind: "reconcile",
    })
  );
}

function pausingReviewer(release: Deferred.Deferred<void>): GaiaReviewer {
  const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
    "pausing-server-reviewer"
  );

  return {
    name: reviewerName,
    run: (request) =>
      Effect.gen(function* () {
        if (request.phase === "plan") {
          yield* Deferred.await(release);
        }

        return ReviewResult.make({
          findings: [],
          phase: request.phase,
          resultPath:
            request.phase === "plan"
              ? "plan-review.json"
              : "evidence-review.json",
          reviewerName,
          runId: request.runId,
          status: "approved",
          summary: `Pausing reviewer approved ${request.phase}.`,
        });
      }),
  };
}

function getObject(
  input: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> {
  const value = input[key];
  if (isJsonObject(value)) {
    return value;
  }

  throw new Error(`Expected ${key} to be an object.`);
}

function getArray(
  input: Readonly<Record<string, unknown>>,
  key: string
): ReadonlyArray<unknown> {
  const value = input[key];
  if (Array.isArray(value)) {
    return value;
  }

  throw new Error(`Expected ${key} to be an array.`);
}

function getObjectFromArray(
  input: ReadonlyArray<unknown>,
  index: number
): Readonly<Record<string, unknown>> {
  const value = input[index];
  if (isJsonObject(value)) {
    return value;
  }

  throw new Error(`Expected array item ${index} to be an object.`);
}

function asJsonObject(input: unknown): Readonly<Record<string, unknown>> {
  if (isJsonObject(input)) {
    return input;
  }

  throw new Error("Expected value to be an object.");
}

function getString(
  input: Readonly<Record<string, unknown>>,
  key: string
): string {
  const value = input[key];
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Expected ${key} to be a string.`);
}

function getNumber(
  input: Readonly<Record<string, unknown>>,
  key: string
): number {
  const value = input[key];
  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Expected ${key} to be a number.`);
}

function isJsonObject(
  input: unknown
): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
