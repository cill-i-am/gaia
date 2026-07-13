import { request as httpRequest } from "node:http";
import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
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
  HarnessCapabilities,
  HarnessProviderDescriptor,
  deliveryPullRequestReadyPayloadDigest,
  makeRunEvent,
  parseDeliveryFeedbackId,
  parseHarnessEvent,
  parseHarnessProfileId,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessProviderId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseRunId,
  parseWorkspaceRelativePath,
  projectHarnessEvents,
  RunEvent,
  WorkerRecoveryAction,
} from "@gaia/core";
import {
  makeHarnessProviderRegistry,
  appendEvent,
  appendHarnessSessionEvent,
  ReviewResult,
  ReviewerNameSchema,
  subscribeRunEventFeed,
  type GaiaReviewer,
  type DeliveryPublicationOptions,
  makeRuntimeError,
} from "@gaia/runtime";
import type { ServerWorkflowOptions } from "@gaia/runtime/server-workflows";
import {
  acceptFactoryRun,
  acceptServerRun,
  continueServerRun,
} from "@gaia/runtime/server-workflows";
import { makeRunPaths, makeRunStorePaths } from "@gaia/runtime/paths";
import {
  makeTestHarnessProviderRegistry,
  testHarnessProvider,
} from "@gaia/runtime/test-support";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Schema, Stream } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpServer,
  type HttpClientResponse,
} from "effect/unstable/http";
import { deliveryUpdateFromEvents, makeLocalGaiaServerLayer } from "./api.js";
import type { LocalServerIdentity } from "./discovery.js";

function recoveredCompletedDeliveryEvents(runId = parseRunId("run-1234567890")) {
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
    payload: Readonly<Record<string, Schema.Json>>,
  ) => makeRunEvent({
    payload,
    runId,
    sequence,
    timestamp: `2026-07-13T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
  });

  return [
    event(1, "RUN_CREATED", { specPath: "spec.md" }),
    event(2, "DELIVERY_STARTED", { delivery: { ...provenance, stage: "delivering" } }),
    event(3, "RUN_FAILED", { code: "HarnessSessionFailed", message: "Worker recovery required.", recoverable: true, stage: "runningWorker" }),
    event(4, "WORKER_RECOVERY_RECORDED", { recovery: encodeWorkerRecoveryReceiptJson({ actionId: "recover-terminal-1", attempt: 1, expectedFailureSequence: 3, expectedSessionId: parseHarnessSessionId(`session-${runId}`), harnessProfileId: parseHarnessProfileId("codexAppServer"), maxAttempts: 1, model: "gpt-5.4", nativeTurnIdDigest: "7".repeat(64), payloadDigest: "8".repeat(64), state: "dispatchConfirmed" }) }),
    event(5, "WORKER_COMPLETED", { workerResultPath: "worker-result.json" }),
    event(6, "VERIFICATION_COMPLETED", { verificationResultPath: "verification.json" }),
    event(7, "DELIVERY_READY_TO_PUBLISH", { delivery: { ...provenance, stage: "readyToPublish" }, reportPath: "report.md" }),
    event(8, "DELIVERY_PUBLICATION_INTENT_RECORDED", { publication: encodeDeliveryPublicationJson(publicationIntent) }),
    event(9, "DELIVERY_PUBLICATION_ATTEMPTED", { publication: encodeDeliveryPublicationJson(publicationAttempted) }),
    event(10, "DELIVERY_PUBLICATION_CONFIRMED", { publication: encodeDeliveryPublicationJson(publicationConfirmed) }),
    event(11, "DELIVERY_MERGE_READINESS_RECORDED", { decision: encodeDeliveryMergeReadinessDecisionJson(mergeDecision) }),
    event(12, "DELIVERY_MERGE_RECORDED", { mergeAction: encodeDeliveryMergeReceiptJson(mergeIntent) }),
    event(13, "DELIVERY_MERGE_RECORDED", { mergeAction: encodeDeliveryMergeReceiptJson(mergeAttempted) }),
    event(14, "DELIVERY_MERGE_RECORDED", { mergeAction: encodeDeliveryMergeReceiptJson(mergeConfirmed) }),
    event(15, "DELIVERY_CLEANUP_RECORDED", { cleanup: encodeDeliveryCleanupReceiptJson(cleanupRequired) }),
    event(16, "DELIVERY_CLEANUP_RECORDED", { cleanup: encodeDeliveryCleanupReceiptJson(cleanupCompleted) }),
  ];
}

function appendProjectionEvent(
  events: ReadonlyArray<RunEvent>,
  type: Parameters<typeof makeRunEvent>[0]["type"],
  payload: Readonly<Record<string, Schema.Json>>,
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
      ["WorkerRecoveryCorrelationUnavailable", "WorkerRecoveryCorrelationUnavailable", 422],
      ["WorkerRecoveryModelCatalogUnavailable", "WorkerRecoveryModelCatalogUnavailable", 422],
      ["WorkerRecoveryModelUnavailable", "WorkerRecoveryModelUnavailable", 422],
      ["WorkerRecoveryIntentPersistenceFailed", "WorkerRecoveryIntentPersistenceFailed", 500],
      ["ArbitraryPrivateRecoveryCode", "InternalServerError", 500],
    ] as const) {
      it.effect(`maps ${code} through the strict recovery endpoint with safe evidence`, () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-recovery-error-" });
          const action = WorkerRecoveryAction.make({
            actionId: `action-${inputCode}`,
            expectedFailureSequence: 15,
            expectedSessionId: parseHarnessSessionId("session-run-1234567890"),
            harnessProfileId: parseHarnessProfileId("codexAppServer"),
            kind: "retryRecoverableWorkerFailure",
            model: "gpt-5.5",
          });
          const response = yield* HttpClientRequest.post("/runs/run-1234567890/recovery/actions").pipe(
            HttpClientRequest.bodyJsonUnsafe(action),
            HttpClient.execute,
            Effect.provide(testServerLayer(cwd, {
              workerRecoveryActivator: () => Effect.fail(makeRuntimeError({
                cause: new Error("native-thread-token /private/path model-catalog prompt"),
                code: inputCode,
                message: code === "WorkerRecoveryIntentPersistenceFailed"
                  ? "Worker recovery intent could not be persisted."
                  : "Worker recovery pre-intent dependency is unavailable.",
              })),
            })),
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
          assert.hasAllKeys(evidence, ["timestamp", "runId", "actionId", "stage", "code", "status"]);
          for (const secret of ["native-thread", "token", "/private/path", "model-catalog", "prompt", "gpt-5.5"]) {
            assert.notInclude(JSON.stringify(body), secret);
            assert.notInclude(log, secret);
          }
        }),
      );
    }

    it.effect("preserves the primary typed response when safe evidence append fails", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-recovery-log-failure-" });
        const action = WorkerRecoveryAction.make({
          actionId: "action-log-failure",
          expectedFailureSequence: 15,
          expectedSessionId: parseHarnessSessionId("session-run-1234567890"),
          harnessProfileId: parseHarnessProfileId("codexAppServer"),
          kind: "retryRecoverableWorkerFailure",
          model: "gpt-5.5",
        });
        const response = yield* HttpClientRequest.post("/runs/run-1234567890/recovery/actions").pipe(
          HttpClientRequest.bodyJsonUnsafe(action),
          HttpClient.execute,
          Effect.provide(testServerLayer(
            cwd,
            {
              workerRecoveryActivator: () => Effect.fail(makeRuntimeError({
                code: "WorkerRecoveryModelUnavailable",
                message: "The explicitly selected Codex model is unavailable.",
              })),
            },
            { writeWorkerRecoveryFailureEvidence: () => Effect.fail(new Error("evidence unavailable")) },
          )),
        );
        const body = yield* responseJsonObject(response);
        assert.strictEqual(response.status, 422);
        assert.strictEqual(getString(body, "code"), "WorkerRecoveryModelUnavailable");
      }),
    );

    it.effect("returns health with workspace identity", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const response = yield* HttpClient.get("/health").pipe(
          Effect.provide(testServerLayer(cwd)),
        );
        const body = yield* responseJsonObject(response);

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(body, "status"), "ok");
        assert.strictEqual(getString(body, "workspaceRoot"), cwd);
        assert.strictEqual(getString(body, "host"), "127.0.0.1");
        assert.strictEqual(getNumber(body, "version"), 1);
        assert.isAbove(getNumber(body, "port"), 0);
      }),
    );

    it.effect("returns factory run summaries with partial diagnostics", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        yield* fs.makeDirectory(`${cwd}/.gaia/runs/run-not-valid`);

        const response = yield* HttpClient.get("/runs").pipe(
          Effect.provide(testServerLayer(cwd)),
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
        assert.strictEqual(getString(firstRun, "workflow"), "issueDelivery");
        assert.strictEqual(
          getString(getObject(firstRun, "rootWorkItem"), "title"),
          "Wire LocalGaiaServerApi factory endpoints",
        );
        assert.strictEqual(getNumber(getObject(firstRun, "counts"), "agents"), 5);
        assert.strictEqual(getString(firstDiagnostic, "code"), "InvalidRunDirectory");
      }),
    );

    it.effect("returns factory run detail and internal event envelopes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });

        const layer = testServerLayer(cwd);
        const detailResponse = yield* HttpClient.get(`/runs/${accepted.runId}`).pipe(
          Effect.provide(layer),
        );
        const eventsResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/events`,
        ).pipe(Effect.provide(layer));
        const detail = yield* responseJsonObject(detailResponse);
        const events = yield* responseJsonObject(eventsResponse);
        const detailData = getObject(detail, "data");
        const eventsData = getObject(events, "data");
        const eventItems = getArray(eventsData, "events");

        assert.strictEqual(detailResponse.status, 200);
        assert.strictEqual(eventsResponse.status, 200);
        assert.strictEqual(getString(detailData, "runId"), accepted.runId);
        assert.strictEqual(getString(eventsData, "runId"), accepted.runId);
        assert.strictEqual(
          getString(getObject(detailData, "execution"), "harnessProfileId"),
          "codexAppServer",
        );
        assert.notInclude(JSON.stringify(detailData), "native-thread");
        assert.notInclude(JSON.stringify(detailData), "/usr/local/bin");
        assert.strictEqual(getNumber(getObject(detailData, "counts"), "agents"), 5);
        assert.strictEqual(
          eventItems.length,
          getNumber(getObject(detailData, "counts"), "activity"),
        );
      }),
    );

    it.effect("serves factory artifact catalogs and bodies through JSON envelopes only", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });

        const catalogResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/artifacts`,
        ).pipe(Effect.provide(testServerLayer(cwd)));
        const bodyResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/artifacts/report-json`,
        ).pipe(Effect.provide(testServerLayer(cwd)));
        const catalogBody = yield* responseJsonObject(catalogResponse);
        const body = yield* responseJsonObject(bodyResponse);
        const artifacts = getArray(getObject(catalogBody, "data"), "artifacts");
        const reportMetadata = artifacts
          .map((artifact) => {
            if (!isJsonObject(artifact)) {
              throw new Error("Expected artifact metadata to be an object.");
            }
            return artifact;
          })
          .find((artifact) => getString(artifact, "artifactId") === "report-json");
        const data = getObject(body, "data");

        assert.strictEqual(catalogResponse.status, 200);
        assert.strictEqual(bodyResponse.status, 200);
        assert.isDefined(reportMetadata);
        assert.strictEqual(getString(data, "artifactId"), "report-json");
        assert.strictEqual(getString(data, "contentType"), "application/json");
        assert.include(getString(data, "body"), accepted.runId);
      }),
    );

    it.effect("streams a server-created run from replayed events to terminal close", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptServerRun({
          specMarkdown: "Stream this server run to completion.\n",
        }, {
          rootDirectory: cwd,
        });

        yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const response = yield* HttpClient.get(
          `/runs/${accepted.runId}/events/stream`,
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
          Array.from({ length: events.length }, (_, index) => index + 1),
        );
      }),
      20_000,
    );

    it.effect("accepts Markdown content durably before returning", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const layer = testServerLayer(cwd);
        const response = yield* postCreateRun(
          layer,
          "Create through the local server.\n",
        );
        const body = yield* responseJsonObject(response);
        const runId = getString(body, "runId");
        const paths = yield* makeRunPaths(parseRunId(runId), { rootDirectory: cwd });
        const persistedInput = yield* fs.readFileString(paths.input);

        assert.strictEqual(response.status, 202);
        assert.strictEqual(getString(body, "status"), "accepted");
        assert.strictEqual(persistedInput, "Create through the local server.\n");
      }),
      20_000,
    );

    it.effect("refreshes externally created runs on list and detail reads", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const layer = testServerLayer(cwd);

        yield* Effect.gen(function* () {
          const initialResponse = yield* HttpClient.get("/runs");
          const initialBody = yield* responseJsonObject(initialResponse);

          assert.strictEqual(initialResponse.status, 200);
          assert.deepEqual(getArray(getObject(initialBody, "data"), "runs"), []);

          const summary = yield* acceptFactoryRun(factoryCreateInput(), {
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          });

          const listResponse = yield* HttpClient.get("/runs");
          const detailResponse = yield* HttpClient.get(`/runs/${summary.runId}`);
          const listBody = yield* responseJsonObject(listResponse);
          const detailBody = yield* responseJsonObject(detailResponse);
          const listRun = getObjectFromArray(
            getArray(getObject(listBody, "data"), "runs"),
            0,
          );
          const detail = getObject(detailBody, "data");

          assert.strictEqual(listResponse.status, 200);
          assert.strictEqual(detailResponse.status, 200);
          assert.strictEqual(getString(listRun, "runId"), summary.runId);
          assert.strictEqual(getString(detail, "runId"), summary.runId);
          assert.strictEqual(getString(detail, "state"), "running");
        }).pipe(Effect.provide(layer));
      }),
      20_000,
    );

    it.effect("returns factory graph, activity, agent activity, and artifact bodies", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const layer = testServerLayer(cwd);

        const graphResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/factory-graph`,
        ).pipe(Effect.provide(layer));
        const activityResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/activity`,
        ).pipe(Effect.provide(layer));
        const agentActivityResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/agents/agent-worker/activity`,
        ).pipe(Effect.provide(layer));
        const artifactResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/artifacts/worker-plan`,
        ).pipe(Effect.provide(layer));
        const graph = getObject(yield* responseJsonObject(graphResponse), "data");
        const activity = getObject(
          yield* responseJsonObject(activityResponse),
          "data",
        );
        const agentActivity = getObject(
          yield* responseJsonObject(agentActivityResponse),
          "data",
        );
        const artifact = getObject(
          yield* responseJsonObject(artifactResponse),
          "data",
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
            getString(asJsonObject(item), "kind"),
          ),
          [
            "WORKER_STARTED",
            "HARNESS_SESSION_EVENT_RECORDED",
            "HARNESS_SESSION_EVENT_RECORDED",
            "HARNESS_SESSION_EVENT_RECORDED",
            "WORKER_COMPLETED",
          ],
        );
        assert.strictEqual(
          getString(getObject(graph, "execution"), "harnessProfileId"),
          "codexAppServer",
        );
        assert.strictEqual(getString(artifact, "artifactId"), "worker-plan");
        assert.include(getString(artifact, "body"), accepted.runId);
      }),
      20_000,
    );

    it.effect("serves normalized agent session snapshots and selected-agent SSE without provider leakage", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const layer = testServerLayer(cwd);

        const snapshotResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/agents/agent-worker/session`,
        ).pipe(Effect.provide(layer));
        const streamResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/agents/agent-worker/session/stream`,
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
          updates.map((update) => String(getNumber(update, "eventSequence"))),
        );
        assert.deepEqual(
          updates.map((update) => getNumber(update, "eventSequence")),
          [...updates.map((update) => getNumber(update, "eventSequence"))].sort((left, right) => left - right),
        );
        assert.isTrue(getObjectFromArray(updates, updates.length - 1)["terminal"] === true);
      }),
      20_000,
    );

    it.effect("serves recovered pending interactions and resolves them through LocalGaiaServerApi", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-recovered-session-" });
        const resolutions: unknown[] = [];
        const layer = testServerLayer(cwd, {
          harnessProviderRegistry: pendingApprovalRegistry(resolutions),
        });
        yield* Effect.gen(function* () {
          const createResponse = yield* createRunRequest(
            "Create a recovered-session projection proof.\n",
          );
          const createBody = yield* responseJsonObject(createResponse);
          const runId = getString(createBody, "runId");
          const sessionId = `session-${runId}`;
          const snapshot = yield* eventuallyAgentSession(runId);

          assert.strictEqual(createResponse.status, 202);
          assert.strictEqual(getString(snapshot, "state"), "running");
          assert.deepEqual(
            getArray(snapshot, "pendingInteractions").map(asJsonObject).map((interaction) => getString(interaction, "interactionId")),
            [serverRecoveredInteractionId],
          );
          assert.deepEqual(
            getArray(snapshot, "turns").map(asJsonObject).map((turn) => ({
              status: getString(turn, "status"),
              turnId: getString(turn, "turnId"),
            })),
            [
              { status: "failed", turnId: serverOldTurnId },
              { status: "running", turnId: serverRecoveredTurnId },
            ],
          );
          assert.notInclude(
            JSON.stringify(getArray(snapshot, "pendingInteractions")),
            serverOldInteractionId,
          );
          assert.notInclude(JSON.stringify(snapshot), "native-thread");
          assert.notInclude(JSON.stringify(snapshot), "raw-provider");

          const staleResponse = yield* HttpClientRequest.post(
            `/runs/${runId}/agents/agent-worker/session/actions`,
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              actionId: "action-server-stale-interaction",
              decision: "decline",
              interactionId: serverOldInteractionId,
              kind: "approval",
              sessionId,
            }),
            HttpClient.execute,
          );
          const staleBody = yield* responseJsonObject(staleResponse);
          assert.strictEqual(staleResponse.status, 409);
          assertApiError(staleBody, "AgentActionConflict", 409);
          assert.deepEqual(resolutions, []);

          const action = {
            actionId: "action-server-recovered-approval",
            decision: "decline",
            interactionId: serverRecoveredInteractionId,
            kind: "approval",
            sessionId,
          } as const;
          const firstResponse = yield* HttpClientRequest.post(
            `/runs/${runId}/agents/agent-worker/session/actions`,
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe(action),
            HttpClient.execute,
          );
          const replayResponse = yield* HttpClientRequest.post(
            `/runs/${runId}/agents/agent-worker/session/actions`,
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe(action),
            HttpClient.execute,
          );
          const conflictResponse = yield* HttpClientRequest.post(
            `/runs/${runId}/agents/agent-worker/session/actions`,
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              ...action,
              actionId: "action-server-recovered-approval-other",
            }),
            HttpClient.execute,
          );
          const firstBody = getObject(yield* responseJsonObject(firstResponse), "data");
          const replayBody = getObject(yield* responseJsonObject(replayResponse), "data");
          const conflictBody = yield* responseJsonObject(conflictResponse);

          assert.strictEqual(firstResponse.status, 200);
          assert.strictEqual(replayResponse.status, 200);
          assert.deepEqual(replayBody, firstBody);
          assert.strictEqual(conflictResponse.status, 409);
          assertApiError(conflictBody, "AgentActionConflict", 409);
          assert.deepEqual(resolutions, [
            {
              actionId: action.actionId,
              decision: "decline",
              interactionId: serverRecoveredInteractionId,
              kind: "approval",
            },
          ]);
        }).pipe(Effect.provide(layer));
      }),
      20_000,
    );

    it.effect("streams delivery updates with resumable Gaia sequence SSE ids", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-delivery-" });
        const accepted = yield* acceptFactoryRun({
          delivery: { mode: "pullRequest" },
          execution: codexAppServerExecutionSelection,
          workflow: "issueDelivery",
          workItem: {
            description: "Stream delivery lifecycle.",
            kind: "issue",
            title: "Delivery stream",
          },
        }, {
          deliveryGitCommandRunner: recordingGitRunner(),
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        yield* continueServerRun(accepted.runId, {
          deliveryGitCommandRunner: recordingGitRunner(),
          deliveryPublisher: recordingDeliveryPublisher(),
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const layer = testServerLayer(cwd, {
          deliveryGitCommandRunner: recordingGitRunner(),
        });

        yield* appendTerminalRemediation(accepted.runId, cwd);
        const streamResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/delivery/stream`,
        ).pipe(Effect.provide(layer));
        const streamText = yield* streamResponse.text;
        const sse = parseSseBlocks(streamText);
        const updates = sse.map(({ data }) => data);
        const lastSequence = getNumber(getObjectFromArray(updates, updates.length - 1), "eventSequence");
        const resumeResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/delivery/stream?afterSequence=${lastSequence - 1}`,
        ).pipe(Effect.provide(layer));
        const resumeBlocks = parseSseBlocks(yield* resumeResponse.text);
        const conflictResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/delivery/stream?afterSequence=999999`,
        ).pipe(Effect.provide(layer));
        const conflictBody = yield* responseJsonObject(conflictResponse);

        assert.strictEqual(streamResponse.status, 200);
        assert.isAtLeast(updates.length, 2);
        assert.deepEqual(
          sse.map(({ id }) => id),
          updates.map((update) => String(getNumber(update, "eventSequence"))),
        );
        assert.deepEqual(
          updates.map((update) => getNumber(update, "eventSequence")),
          [...updates.map((update) => getNumber(update, "eventSequence"))].sort((left, right) => left - right),
        );
        assert.strictEqual(
          getString(getObjectFromArray(updates, updates.length - 1), "stage"),
          "remediationFailed",
        );
        assert.include(
          updates.map((update) => getString(update, "stage")),
          "waitingForPr",
        );
        assert.include(
          updates.map((update) => getString(update, "stage")),
          "remediating",
        );
        const finalUpdate = getObjectFromArray(updates, updates.length - 1);
        const publication = getObject(finalUpdate, "publication");
        assert.strictEqual(getString(publication, "state"), "confirmed");
        assert.strictEqual(
          getString(publication, "prUrl"),
          "https://github.com/cill-i-am/gaia/pull/91",
        );
        assert.notInclude(JSON.stringify(finalUpdate), "payloadDigest");
        assert.notInclude(JSON.stringify(finalUpdate), cwd);
        assert.strictEqual(resumeResponse.status, 200);
        assert.strictEqual(resumeBlocks.length, 1);
        assert.strictEqual(resumeBlocks[0]?.id, String(lastSequence));
        assert.strictEqual(conflictResponse.status, 409);
        assertApiError(conflictBody, "DeliveryStreamCursorConflict", 409);
      }),
      20_000,
    );

    it.effect("opens one authoritative delivery event feed per stream connection", () =>
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
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          },
        );
        yield* continueServerRun(accepted.runId, {
          deliveryGitCommandRunner: recordingGitRunner(),
          deliveryPublisher: recordingDeliveryPublisher(),
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
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
          },
        );

        yield* appendTerminalRemediation(accepted.runId, cwd);
        const streamResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/delivery/stream`,
        ).pipe(Effect.provide(layer));
        const streamBlocks = parseSseBlocks(yield* streamResponse.text);
        const readsAfterSuccess = deliveryEventReads;
        const lastSequence = getNumber(
          getObjectFromArray(
            streamBlocks.map(({ data }) => data),
            streamBlocks.length - 1,
          ),
          "eventSequence",
        );
        const resumeResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/delivery/stream?afterSequence=${lastSequence - 1}`,
        ).pipe(Effect.provide(layer));
        yield* resumeResponse.text;
        const readsAfterResume = deliveryEventReads;
        const conflictResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/delivery/stream?afterSequence=999999`,
        ).pipe(Effect.provide(layer));
        yield* conflictResponse.text;

        assert.strictEqual(streamResponse.status, 200);
        assert.strictEqual(readsAfterSuccess, 1);
        assert.strictEqual(resumeResponse.status, 200);
        assert.strictEqual(readsAfterResume, 2);
        assert.strictEqual(conflictResponse.status, 409);
        assert.strictEqual(deliveryEventReads, 3);
      }),
      20_000,
    );

    it.effect("projects publication recovery and rejects stale delivery actions", () =>
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
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          },
        );
        yield* continueServerRun(accepted.runId, {
          deliveryGitCommandRunner: recordingGitRunner(),
          deliveryPublisher: recordingUnknownDeliveryPublisher(),
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const layer = testServerLayer(cwd, {
          deliveryPublisher: reconcilingDeliveryPublisher(),
        });
        const beforeResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/delivery`,
        ).pipe(Effect.provide(layer));
        const before = getObject(
          yield* responseJsonObject(beforeResponse),
          "data",
        );
        const sequence = getNumber(before, "eventSequence");
        const staleResponse = yield* deliveryActionRequest(
          accepted.runId,
          sequence - 1,
        ).pipe(HttpClient.execute, Effect.provide(layer));
        const staleBody = yield* responseJsonObject(staleResponse);
        const recoveryResponse = yield* deliveryActionRequest(
          accepted.runId,
          sequence,
        ).pipe(HttpClient.execute, Effect.provide(layer));
        const recovered = getObject(
          yield* responseJsonObject(recoveryResponse),
          "data",
        );

        assert.strictEqual(getString(before, "stage"), "publicationOutcomeUnknown");
        assert.deepEqual(getArray(before, "recoveryActions"), ["reconcile"]);
        assert.strictEqual(staleResponse.status, 409);
        assertApiError(staleBody, "DeliveryActionConflict", 409);
        assert.strictEqual(recoveryResponse.status, 200);
        assert.strictEqual(getString(recovered, "stage"), "waitingForPr");
        assert.deepEqual(getArray(recovered, "recoveryActions"), []);
      }),
      20_000,
    );

    it.effect("projects recovered delivery as terminal after confirmed merge and completed cleanup", () =>
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
          `${events.map((event) => JSON.stringify(Schema.encodeSync(RunEvent)(event))).join("\n")}\n`,
        );
        yield* fs.writeFileString(paths.snapshots, "");

        assert.strictEqual(direct?.stage, "completed");
        assert.strictEqual(direct?.status, "completed");
        assert.deepEqual(direct?.recoveryActions, []);
        assert.strictEqual(direct?.authoritativeHeadSha, "a".repeat(40));
        assert.strictEqual(direct?.publication?.state, "confirmed");
        assert.strictEqual(direct?.latestMergeAction?.state, "dispatchConfirmed");
        assert.strictEqual(direct?.latestCleanupAction?.state, "completed");
        assert.deepEqual(direct?.actionAudit?.merge, [
          { actionId: "merge-terminal-1", latestSequence: 14, state: "dispatchConfirmed" },
        ]);
        assert.deepEqual(direct?.actionAudit?.cleanup, [
          { actionId: "cleanup-terminal-1", latestSequence: 16, state: "completed" },
        ]);

        const response = yield* HttpClient.get(`/runs/${runId}/delivery`).pipe(
          Effect.provide(testServerLayer(cwd)),
        );
        const projected = getObject(yield* responseJsonObject(response), "data");

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getString(projected, "stage"), "completed");
        assert.strictEqual(getString(projected, "status"), "completed");
        assert.deepEqual(getArray(projected, "recoveryActions"), []);
        assert.strictEqual(getString(getObject(projected, "latestMergeAction"), "state"), "dispatchConfirmed");
        assert.strictEqual(getString(getObject(projected, "latestCleanupAction"), "state"), "completed");
      }),
      20_000,
    );

    it("preserves nonterminal recovery and delivery action precedence", () => {
      const terminal = recoveredCompletedDeliveryEvents();
      const recovery = terminal.slice(0, 4);
      const continuation = appendProjectionEvent(recovery, "WORKER_CONTINUATION_RECORDED", {
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
      });
      const correlation = appendProjectionEvent(continuation, "WORKER_CORRELATION_RECONCILIATION_RECORDED", {
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
      });
      const failedAfterRecovery = appendProjectionEvent(recovery, "RUN_FAILED", {
        code: "HarnessSessionFailed",
        message: "Recovered worker failed again.",
        recoverable: false,
        stage: "runningWorker",
      });
      const mergeUnknown = [
        ...terminal.slice(0, 13),
        makeRunEvent({
          payload: {
            mergeAction: encodeDeliveryMergeReceiptJson(DeliveryMergeTerminalFailure.make({
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
            })),
          },
          runId: terminal[0]!.runId,
          sequence: 14,
          timestamp: "2026-07-13T12:01:14.000Z",
          type: "DELIVERY_MERGE_RECORDED",
        }),
      ];

      assert.strictEqual(deliveryUpdateFromEvents(terminal[0]!.runId, recovery)?.stage, "runningWorker");
      assert.strictEqual(deliveryUpdateFromEvents(terminal[0]!.runId, continuation)?.stage, "workerContinuationPending");
      assert.strictEqual(deliveryUpdateFromEvents(terminal[0]!.runId, correlation)?.stage, "workerCorrelationPending");
      assert.strictEqual(deliveryUpdateFromEvents(terminal[0]!.runId, failedAfterRecovery)?.stage, "failed");
      assert.strictEqual(deliveryUpdateFromEvents(terminal[0]!.runId, mergeUnknown)?.stage, "mergeReconciliationRequired");
      assert.strictEqual(deliveryUpdateFromEvents(terminal[0]!.runId, mergeUnknown)?.status, "mergeReconciliationRequired");
      assert.deepEqual(deliveryUpdateFromEvents(terminal[0]!.runId, terminal.slice(0, 15))?.recoveryActions, ["retryCleanup"]);
      assert.strictEqual(deliveryUpdateFromEvents(terminal[0]!.runId, terminal.slice(0, 15))?.stage, "cleanupRequired");
    });

    it.effect("exposes one worker recovery action for the latest eligible failure generation", () =>
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
            harnessProviderRegistry: makeTestHarnessProviderRegistry(),
            rootDirectory: cwd,
          },
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
        yield* appendHarnessSessionEvent(runId, paths, parseHarnessEvent({
          capabilities: { approvals: [], fileChangeEvents: true, interruption: true, resumableSessions: true, review: false, steering: true, streamingMessages: true, structuredOutput: false, subagents: false, toolEvents: true, usageReporting: false, userQuestions: false },
          kind: "sessionStarted",
          provider: { displayName: "Codex App Server", executionModes: ["local"], providerId: "codex-app-server" },
          sessionId,
          state: "running",
        }));
        yield* appendHarnessSessionEvent(runId, paths, parseHarnessEvent({
          failure: { code: "CodexThreadSystemError", kind: "providerFailure", message: "first failure", recoverable: true },
          kind: "sessionFailed",
          sessionId,
        }));
        const firstFailure = yield* appendEvent(runId, paths, {
          payload: { code: "HarnessSessionFailed", message: "first failed", recoverable: true, stage: "runningWorker" },
          type: "RUN_FAILED",
        });
        yield* appendEvent(runId, paths, {
          payload: {
            recovery: encodeWorkerRecoveryReceiptJson({
              actionId: "recover-old",
              attempt: 1,
              expectedFailureSequence: firstFailure.event.sequence,
              expectedSessionId: sessionId,
              harnessProfileId: codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1,
              model: "gpt-5.4",
              nativeTurnIdDigest: "b".repeat(64),
              payloadDigest: "a".repeat(64),
              state: "dispatchConfirmed",
            }),
          },
          type: "WORKER_RECOVERY_RECORDED",
        });
        yield* appendHarnessSessionEvent(runId, paths, parseHarnessEvent({
          failure: { code: "CodexThreadSystemError", kind: "providerFailure", message: "second failure", recoverable: true },
          kind: "sessionFailed",
          sessionId,
        }));
        const secondFailure = yield* appendEvent(runId, paths, {
          payload: { code: "HarnessSessionFailed", message: "second failed", recoverable: true, stage: "runningWorker" },
          type: "RUN_FAILED",
        });

        const response = yield* HttpClient.get(`/runs/${accepted.runId}/delivery`).pipe(
          Effect.provide(testServerLayer(cwd)),
        );
        const projected = getObject(yield* responseJsonObject(response), "data");

        assert.strictEqual(response.status, 200);
        assert.deepEqual(getArray(projected, "recoveryActions"), ["retryWorkerRecovery"]);
        assert.strictEqual(getNumber(projected, "eventSequence"), secondFailure.event.sequence);
        assert.strictEqual(getString(getObject(projected, "workerRecovery"), "actionId"), "recover-old");
      }),
      20_000,
    );

    it.effect("rejects excess merge action fields and redacts private conflict causes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-private-merge-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const hostile = "/HOSTILE/absolute/common-dir::PRIVATE_TOKEN_93::refs/heads/forged";
        const layer = testServerLayer(cwd, {
          deliveryMergeActivator: () => Effect.fail({ code: "DeliveryActionConflict", message: hostile, recoverable: true }),
        });
        const request = (body: Record<string, unknown>) => HttpClientRequest.post(`/runs/${accepted.runId}/delivery/actions`).pipe(HttpClientRequest.bodyJsonUnsafe(body), HttpClient.execute, Effect.provide(layer));
        const conflict = yield* request({ actionId: "readiness-1", kind: "evaluateMergeReadiness", mergeMethod: "merge" });
        const conflictText = yield* conflict.text;
        const excess = yield* request({ actionId: "readiness-1", kind: "evaluateMergeReadiness", mergeMethod: "merge", ownershipToken: hostile });
        const excessText = yield* excess.text;

        assert.strictEqual(conflict.status, 409);
        assert.notInclude(conflictText, hostile);
        assert.notInclude(conflictText, "PRIVATE_TOKEN_93");
        assert.strictEqual(excess.status, 400);
        assert.notInclude(excessText, hostile);
      }),
    );

    it.effect("redacts private cleanup provenance from public event, activity, and artifact responses", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-private-events-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), { harnessProviderRegistry: makeTestHarnessProviderRegistry(), rootDirectory: cwd });
        const paths = yield* makeRunPaths(parseRunId(accepted.runId), { rootDirectory: cwd });
        const hostile = "/HOSTILE/private/common-dir::PRIVATE_TOKEN_93::provider-secret::raw-cause";
        const runId = parseRunId(accepted.runId);
        yield* appendEvent(runId, paths, { payload: { provenance: { actionId: "cleanup-1", branchRef: "refs/heads/gaia/run-1234567890", expectedBranchOid: "a".repeat(40), mergeCommitSha: "b".repeat(40), ownershipDigest: "c".repeat(64), ownershipToken: hostile, payloadDigest: "d".repeat(64), providerId: hostile, rawCause: { nested: hostile }, repositoryCommonDir: hostile, repositoryRoot: hostile, runId: accepted.runId, version: 1, worktreeCommonDir: hostile, worktreePath: hostile } }, type: "DELIVERY_CLEANUP_PROVENANCE_RECORDED" });
        yield* appendEvent(runId, paths, { payload: { checkpoint: { actionId: "cleanup-1", nested: { path: hostile, providerId: hostile }, payloadDigest: "d".repeat(64), resource: "worktree", state: "removalAttempted", version: 1 } }, type: "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED" });
        yield* appendEvent(runId, paths, { payload: { checkpoint: { actionId: "merge-1", payloadDigest: "e".repeat(64), providerId: hostile, rawCause: { nested: hostile }, state: "reconciliationRequired", version: 1 } }, type: "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED" });
        yield* appendEvent(runId, paths, { payload: { code: "fixture-terminal", message: "fixture terminal", recoverable: false, stage: "replaying" }, type: "RUN_FAILED" });
        const layer = testServerLayer(cwd);
        const eventsResponse = yield* HttpClient.get(`/runs/${accepted.runId}/events`).pipe(Effect.provide(layer));
        const eventsBody = yield* responseJsonObject(eventsResponse);
        const publicEvents = getArray(getObject(eventsBody, "data"), "events").map(asJsonObject);
        const privateEvents = publicEvents.filter((event) => ["DELIVERY_CLEANUP_PROVENANCE_RECORDED", "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED", "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED"].includes(getString(event, "type")));
        assert.strictEqual(eventsResponse.status, 200);
        assert.lengthOf(privateEvents, 3);
        for (const event of privateEvents) assert.deepEqual(getObject(event, "payload"), { redacted: true });

        const activityResponse = yield* HttpClient.get(`/runs/${accepted.runId}/activity`).pipe(Effect.provide(layer));
        const activityText = yield* activityResponse.text;
        assert.strictEqual(activityResponse.status, 200);
        assert.notInclude(activityText, hostile);

        const streamResponse = yield* HttpClient.get(`/runs/${accepted.runId}/events/stream`).pipe(Effect.provide(layer));
        const streamEvents = parseSseDataEvents(yield* streamResponse.text);
        const privateStreamEvents = streamEvents.filter((event) => ["DELIVERY_CLEANUP_PROVENANCE_RECORDED", "DELIVERY_CLEANUP_RESOURCE_CHECKPOINT_RECORDED", "DELIVERY_MERGE_PROVIDER_CHECKPOINT_RECORDED"].includes(getString(event, "type")));
        assert.strictEqual(streamResponse.status, 200);
        assert.lengthOf(privateStreamEvents, 3);
        for (const event of privateStreamEvents) assert.deepEqual(getObject(event, "payload"), { redacted: true });

        const catalogResponse = yield* HttpClient.get(`/runs/${accepted.runId}/artifacts`).pipe(Effect.provide(layer));
        const catalogText = yield* catalogResponse.text;
        assert.strictEqual(catalogResponse.status, 200);
        assert.notInclude(catalogText, '"artifactId":"events"');
        assert.notInclude(catalogText, hostile);
        const rawArtifactResponse = yield* HttpClient.get(`/runs/${accepted.runId}/artifacts/events`).pipe(Effect.provide(layer));
        assert.strictEqual(rawArtifactResponse.status, 404);
        for (const body of [JSON.stringify(eventsBody), activityText, JSON.stringify(streamEvents), catalogText, yield* rawArtifactResponse.text]) {
          assert.notInclude(body, hostile);
          assert.notInclude(body, "PRIVATE_TOKEN_93");
        }
      }),
    );

    it.effect("routes strict merge action families and maps immutable tuple conflicts", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-merge-matrix-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), { harnessProviderRegistry: makeTestHarnessProviderRegistry(), rootDirectory: cwd });
        const seen = new Set<string>(); let mutations = 0;
        const activate = (action: { readonly actionId: string }) => Effect.gen(function* () {
          const key = JSON.stringify(action);
          if (action.actionId.includes("conflict")) return yield* Effect.fail({ code: "DeliveryActionConflict", message: "immutable tuple changed", recoverable: true });
          if (!seen.has(key)) { seen.add(key); mutations += 1; }
          return action;
        });
        const layer = testServerLayer(cwd, {
          deliveryLocalReviewAttestationActivator: (_runId, action) => activate(action),
          deliveryMergeActivator: (_runId, action) => activate(action),
          deliveryReadyForReviewActivator: (_runId, action) => activate(action),
        });
        const request = (body: Record<string, unknown>) => HttpClientRequest.post(`/runs/${accepted.runId}/delivery/actions`).pipe(HttpClientRequest.bodyJsonUnsafe(body), HttpClient.execute, Effect.provide(layer));
        const actions = [
          { actionId: "ready-1", expectedBranchName: "gaia/run-1234567890", expectedHeadSha: "a".repeat(40), expectedPrNumber: 74, expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74", kind: "markReadyForReview" },
          { actionId: "attestation-1", decision: "approved", expectedBranchName: "gaia/run-1234567890", expectedHeadSha: "a".repeat(40), expectedPrNumber: 74, expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74", gaiaEvidenceDigest: "f".repeat(64), kind: "attestPairedReviewApproval" },
          { actionId: "readiness-1", kind: "evaluateMergeReadiness", mergeMethod: "merge" },
          { actionId: "merge-1", expectedBranchName: "gaia/run-1234567890", expectedDecisionSequence: 9, expectedHeadSha: "a".repeat(40), expectedPolicyDigest: "b".repeat(64), expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74", kind: "merge", mergeMethod: "squash" },
          { actionId: "cleanup-1", expectedMergeCommitSha: "c".repeat(40), kind: "retryCleanup" },
        ];
        for (const action of actions) {
          const first = yield* request(action); const duplicate = yield* request(action);
          assert.strictEqual(first.status, 200); assert.strictEqual(duplicate.status, 200);
        }
        assert.strictEqual(mutations, actions.length);
        const malformedActionId = yield* request({ ...actions[0]!, actionId: "bad action id" });
        const malformedActionIdBody = yield* responseJsonObject(malformedActionId);
        assert.strictEqual(malformedActionId.status, 400);
        assertApiError(malformedActionIdBody, "InvalidRequest", 400);
        assert.strictEqual(mutations, actions.length);
        const malformedEvidenceDigest = yield* request({ ...actions[1]!, gaiaEvidenceDigest: "not-a-digest" });
        assert.strictEqual(malformedEvidenceDigest.status, 400);
        const privateEvidenceField = yield* request({ ...actions[1]!, reviewerIdentity: "cill-i-am" });
        assert.strictEqual(privateEvidenceField.status, 400);
        assert.strictEqual(mutations, actions.length);
        const conflicts = [
          { ...actions[0]!, actionId: "conflict-ready", expectedHeadSha: "d".repeat(40) },
          { ...actions[1]!, actionId: "conflict-attestation", expectedHeadSha: "d".repeat(40) },
          { ...actions[2]!, actionId: "conflict-readiness", mergeMethod: "rebase" },
          { ...actions[3]!, actionId: "conflict-merge", expectedDecisionSequence: 8 },
          { ...actions[3]!, actionId: "conflict-head", expectedHeadSha: "d".repeat(40) },
          { ...actions[3]!, actionId: "conflict-pr", expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/75" },
          { ...actions[4]!, actionId: "conflict-cleanup", expectedMergeCommitSha: "e".repeat(40) },
        ];
        for (const action of conflicts) {
          const response = yield* request(action); const body = yield* responseJsonObject(response);
          assert.strictEqual(response.status, 409); assertApiError(body, "DeliveryActionConflict", 409);
        }
      }),
    );

    it.effect("rejects a canonically hashed wrong-run ready receipt from the public projection", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-ready-authority-" });
        const accepted = yield* acceptFactoryRun({
          delivery: { mode: "pullRequest" },
          execution: codexAppServerExecutionSelection,
          workflow: "issueDelivery",
          workItem: { description: "Reject corrupt ready history.", kind: "issue", title: "Ready authority" },
        }, {
          deliveryGitCommandRunner: recordingGitRunner(),
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        yield* continueServerRun(accepted.runId, {
          deliveryGitCommandRunner: recordingGitRunner(),
          deliveryPublisher: recordingDeliveryPublisher(),
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const paths = yield* makeRunPaths(accepted.runId, { rootDirectory: cwd });
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
          payload: { readyForReviewAction: encodeDeliveryPullRequestReadyReceiptJson(ready) },
          runId: accepted.runId,
          sequence: existingEvents.trim().split("\n").length + 1,
          timestamp: "2026-07-13T08:00:00.000Z",
          type: "DELIVERY_PR_READY_RECORDED",
        });
        yield* fs.writeFileString(paths.events, `${existingEvents}${JSON.stringify(Schema.encodeSync(RunEvent)(event))}\n`);

        const response = yield* HttpClient.get(`/runs/${accepted.runId}/delivery`).pipe(
          Effect.provide(testServerLayer(cwd)),
        );
        const text = yield* response.text;
        const body = asJsonObject(JSON.parse(text));

        assert.strictEqual(response.status, 422);
        assertApiError(body, "RunUnreadable", 422);
        assert.notInclude(text, ready.actionId);
        assert.notInclude(text, "run-wrong12345");
      }),
      20_000,
    );

    it.effect("routes controlled remediation activation through the existing live coordinator", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-activation-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
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
        const request = deliveryActivationRequest(
          accepted.eventSequence,
        );
        const response = yield* HttpClientRequest.post(
          `/runs/${accepted.runId}/delivery/actions`,
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe(request),
          HttpClient.execute,
          Effect.provide(layer),
        );
        const malformed = yield* HttpClientRequest.post(
          `/runs/${accepted.runId}/delivery/actions`,
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({ ...request, prompt: "unsafe" }),
          HttpClient.execute,
          Effect.provide(layer),
        );

        assert.strictEqual(response.status, 200);
        assert.strictEqual(malformed.status, 400);
        assert.isTrue(usedLiveCoordinator);
        assert.strictEqual(observedActionKey, request.actionIdempotencyKey);
      }),
      20_000,
    );

    it.effect("projects privacy-safe PR feedback and the authoritative remediation re-arm sequence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-remediation-" });
        const accepted = yield* acceptFactoryRun({
          delivery: { mode: "pullRequest" },
          execution: codexAppServerExecutionSelection,
          workflow: "issueDelivery",
          workItem: {
            description: "Project delivery remediation.",
            kind: "issue",
            title: "Delivery remediation projection",
          },
        }, {
          deliveryGitCommandRunner: recordingGitRunner(),
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        yield* continueServerRun(accepted.runId, {
          deliveryGitCommandRunner: recordingGitRunner(),
          deliveryPublisher: recordingDeliveryPublisher(),
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const paths = yield* makeRunPaths(accepted.runId, { rootDirectory: cwd });
        const feedbackId = parseDeliveryFeedbackId(`feedback-comment-${"f".repeat(64)}`);
        const observation = DeliveryPullRequestObservation.make({
          blockers: [DeliveryBlocker.make({
            feedbackIds: [feedbackId],
            kind: "actionableFeedback",
            summary: "Trusted actionable pull-request feedback requires remediation.",
          })],
          checks: [],
          draft: false,
          feedback: [DeliveryFeedbackObservation.make({
            actorLogin: "trusted-reviewer",
            authorAssociation: "MEMBER",
            classification: "actionable",
            contentDigest: "a".repeat(64),
            id: feedbackId,
            kind: "comment",
            url: "https://github.com/cill-i-am/gaia/pull/91#issuecomment-1",
          })],
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
            observation: encodeDeliveryPullRequestObservationJson(observation),
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
        const intentEvent = yield* appendEvent(accepted.runId, paths, {
          payload: { remediation: encodeDeliveryRemediationJson(intent) },
          type: "DELIVERY_REMEDIATION_RECORDED",
        });
        const response = yield* HttpClient.get(`/runs/${accepted.runId}/delivery`).pipe(
          Effect.provide(testServerLayer(cwd)),
        );
        const projected = getObject(yield* responseJsonObject(response), "data");

        assert.strictEqual(getString(projected, "stage"), "remediating");
        assert.strictEqual(getString(projected, "authoritativeHeadSha"), observation.headSha);
        assert.strictEqual(getNumber(projected, "remediationRearmSequence"), intentEvent.event.sequence);
        assert.strictEqual(getString(getObject(projected, "observation"), "headSha"), observation.headSha);
        assert.strictEqual(getString(getObject(projected, "remediation"), "state"), "intentRecorded");
        assert.notInclude(JSON.stringify(projected), "Project delivery remediation");
        assert.notInclude(JSON.stringify(projected), "native-comment");

        const remediatedHeadSha = "d".repeat(40);
        for (const remediation of [
          DeliveryRemediationDispatchAttempted.make({ ...intent, state: "dispatchAttempted" }),
          DeliveryRemediationTurnCompleted.make({ ...intent, state: "turnCompleted" }),
          DeliveryRemediationVerified.make({ ...intent, state: "verified" }),
          DeliveryRemediationCommitAttempted.make({ ...intent, commitSha: remediatedHeadSha, state: "commitAttempted" }),
          DeliveryRemediationPushAttempted.make({ ...intent, commitSha: remediatedHeadSha, state: "pushAttempted" }),
          DeliveryRemediationConfirmed.make({ ...intent, commitSha: remediatedHeadSha, state: "confirmed" }),
        ]) {
          yield* appendEvent(accepted.runId, paths, {
            payload: { remediation: encodeDeliveryRemediationJson(remediation) },
            type: "DELIVERY_REMEDIATION_RECORDED",
          });
        }
        const remediatedResponse = yield* HttpClient.get(`/runs/${accepted.runId}/delivery`).pipe(
          Effect.provide(testServerLayer(cwd)),
        );
        const remediatedProjection = getObject(yield* responseJsonObject(remediatedResponse), "data");
        assert.strictEqual(getString(remediatedProjection, "authoritativeHeadSha"), remediatedHeadSha);
        assert.strictEqual(getString(getObject(remediatedProjection, "publication"), "commitSha"), observation.headSha);
      }),
      20_000,
    );


    it.effect("maps strict agent action conflicts to public 409 errors", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const response = yield* HttpClientRequest.post(
          `/runs/${accepted.runId}/agents/agent-worker/session/actions`,
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            actionId: "action-server-follow-up",
            kind: "followUp",
            sessionId: `session-${accepted.runId}`,
            text: "Continue safely.",
          }),
          HttpClient.execute,
          Effect.provide(testServerLayer(cwd)),
        );
        const body = yield* responseJsonObject(response);

        assert.strictEqual(response.status, 409);
        assertApiError(body, "AgentActionConflict", 409);
      }),
      20_000,
    );

    it.effect("returns typed diagnostics for missing agents and corrupt projections", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const paths = yield* makeRunPaths(accepted.runId, { rootDirectory: cwd });
        const layer = testServerLayer(cwd);

        const missingAgentResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/agents/agent-missing/activity`,
        ).pipe(Effect.provide(layer));
        yield* fs.writeFileString(paths.factoryGraph, "{ not json");
        const rebuiltGraphResponse = yield* HttpClient.get(
          `/runs/${accepted.runId}/factory-graph`,
        ).pipe(Effect.provide(layer));
        const missingAgentBody = yield* responseJsonObject(missingAgentResponse);
        const rebuiltGraph = getObject(
          yield* responseJsonObject(rebuiltGraphResponse),
          "data",
        );
        const diagnostics = getArray(rebuiltGraph, "diagnostics");

        assert.strictEqual(missingAgentResponse.status, 404);
        assertApiError(missingAgentBody, "FactoryAgentNotFound", 404);
        assert.strictEqual(rebuiltGraphResponse.status, 200);
        assert.deepInclude(
          diagnostics
            .map(asJsonObject)
            .filter((diagnostic) => typeof diagnostic["sourceId"] === "string")
            .map((diagnostic) => ({
              code: getString(diagnostic, "code"),
              sourceId: getString(diagnostic, "sourceId"),
            })),
          {
            code: "FactoryGraphIndexInvalid",
            sourceId: "factory-graph.json",
          },
        );
      }),
    );

    it.effect("refreshes external malformed run diagnostics on list and detail reads", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        const layer = testServerLayer(cwd);

        yield* Effect.gen(function* () {
          const initialResponse = yield* HttpClient.get("/runs");
          const initialBody = yield* responseJsonObject(initialResponse);

          assert.strictEqual(initialResponse.status, 200);
          assert.deepEqual(getArray(getObject(initialBody, "data"), "runs"), []);

          yield* fs.makeDirectory(`${store.runsRoot}/run-not-valid`, {
            recursive: true,
          });
          yield* fs.makeDirectory(`${store.runsRoot}/run-L84-kMhLY8`);

          const listResponse = yield* HttpClient.get("/runs");
          const detailResponse = yield* HttpClient.get("/runs/run-L84-kMhLY8");
          const listBody = yield* responseJsonObject(listResponse);
          const detailBody = yield* responseJsonObject(detailResponse);
          const diagnostics = getArray(getObject(listBody, "data"), "diagnostics");

          assert.strictEqual(listResponse.status, 200);
          assert.strictEqual(getString(listBody, "status"), "success");
          assert.sameMembers(
            diagnostics.map((_, index) =>
              getString(getObjectFromArray(diagnostics, index), "code"),
            ),
            ["InvalidRunDirectory", "RunHasNoEvents"],
          );
          assert.strictEqual(detailResponse.status, 422);
          assertApiError(detailBody, "RunHasNoEvents", 422);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("preserves parseable bad-run detail diagnostics through the index", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        yield* fs.makeDirectory(`${store.runsRoot}/run-L84-kMhLY8`, {
          recursive: true,
        });

        const response = yield* HttpClient.get("/runs/run-L84-kMhLY8").pipe(
          Effect.provide(testServerLayer(cwd)),
        );
        const body = yield* responseJsonObject(response);

        assert.strictEqual(response.status, 422);
        assertApiError(body, "RunHasNoEvents", 422);
      }),
    );

    it.effect("returns typed 400 for invalid Markdown content", () =>
      Effect.gen(function* () {
        const response = yield* postCreateRun(testServerLayer("."), "   ");
        const body = yield* responseJsonObject(response);

        assert.strictEqual(response.status, 400);
        assertApiError(body, "InvalidSpec", 400);
      }),
    );

    it.effect("rejects unavailable selected providers before acceptance without fallback", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-reject-" });
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
          "This run must not fall back.\n",
        );
        const body = yield* responseJsonObject(response);
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });

        assert.strictEqual(response.status, 422);
        assertApiError(body, "HarnessAuthenticationRequired", 422);
        assert.isFalse(yield* fs.exists(store.runsRoot));
      }),
    );

    it.effect("rolls back a pre-acceptance failure so a later create can be accepted", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-reusable-" });
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
        const layer = testServerLayer(cwd, { harnessProviderRegistry: registry });

        const { first, second } = yield* Effect.gen(function* () {
          const failed = yield* createRunRequest("Fail before durable acceptance.\n");
          assert.isFalse(yield* fs.exists(store.runsRoot));
          const accepted = yield* createRunRequest("Accept after rollback.\n");
          return { first: failed, second: accepted };
        }).pipe(Effect.provide(layer));
        const firstBody = yield* responseJsonObject(first);
        const secondBody = yield* responseJsonObject(second);

        assert.strictEqual(first.status, 422);
        assertApiError(firstBody, "HarnessAuthenticationRequired", 422);
        assert.strictEqual(second.status, 202);
        assert.strictEqual(getString(secondBody, "status"), "accepted");
      }),
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
      }),
    );

    it.effect("returns typed 409 while a server-created run is active", () =>
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
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(layer));
        const first = responses.find((response) => response.status === 202);
        const second = responses.find((response) => response.status === 409);

        if (first === undefined || second === undefined) {
          assert.fail("Expected one accepted response and one conflict response.");
        }

        const body = yield* responseJsonObject(second);

        assert.strictEqual(first.status, 202);
        assert.strictEqual(second.status, 409);
        assertApiError(body, "ActiveRunConflict", 409);

        yield* Deferred.succeed(release, undefined);
      }),
      20_000,
    );

    it.effect("returns typed 409 while the first create is still accepting", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-accepting-" });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const registry = pausingFirstDetectionRegistry(entered, release);
        const layer = testServerLayer(cwd, { harnessProviderRegistry: registry });

        const { first, second } = yield* Effect.gen(function* () {
          const firstFiber = yield* createRunRequest("Pause during acceptance.\n").pipe(
            Effect.forkChild,
          );
          yield* Deferred.await(entered);
          const conflict = yield* createRunRequest("Conflict while accepting.\n");
          yield* Deferred.succeed(release, undefined);
          const accepted = yield* Fiber.join(firstFiber);
          return { first: accepted, second: conflict };
        }).pipe(Effect.provide(layer));
        const secondBody = yield* responseJsonObject(second);

        assert.strictEqual(first.status, 202);
        assert.strictEqual(second.status, 409);
        assertApiError(secondBody, "ActiveRunConflict", 409);
      }),
      20_000,
    );

    it.effect("rolls back a canceled pre-acceptance create so a later create is accepted", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-cancel-accepting-" });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const registry = pausingFirstDetectionRegistry(entered, release);
        const layer = testServerLayer(cwd, { harnessProviderRegistry: registry });

        const second = yield* Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const firstRequest = startNativeCreateRunRequest(
            loopbackServerUrl(server),
            "Cancel during acceptance.\n",
          );
          yield* Deferred.await(entered);
          const socket = yield* Effect.promise(() => firstRequest.socket);
          socket.resetAndDestroy();
          yield* Effect.promise(() => firstRequest.closed);
          return yield* eventuallyAcceptedCreate("Accept after cancellation rollback.\n");
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.provide(layer),
        );
        const body = yield* responseJsonObject(second);

        assert.strictEqual(second.status, 202);
        assert.strictEqual(getString(body, "status"), "accepted");
      }),
      20_000,
    );

    it.effect("keeps the running reservation owned after canceling a post-markAccepted request", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-cancel-running-" });
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
          },
        );

        const second = yield* Effect.gen(function* () {
          const firstFiber = yield* createRunRequest("Cancel after markAccepted.\n").pipe(
            Effect.forkChild,
          );
          yield* Deferred.await(markedAccepted);
          yield* Fiber.interrupt(firstFiber);
          const conflict = yield* createRunRequest("Conflict with running owner.\n");
          yield* Deferred.succeed(releaseReviewer, undefined);
          return conflict;
        }).pipe(Effect.provide(layer));
        const secondBody = yield* responseJsonObject(second);

        assert.strictEqual(second.status, 409);
        assertApiError(secondBody, "ActiveRunConflict", 409);
      }),
      20_000,
    );

    it.effect("rejects malformed ids, path-like artifacts, and mutation methods", () =>
      Effect.gen(function* () {
        const layer = testServerLayer(".");
        const badRun = yield* HttpClient.get("/runs/not-a-run").pipe(
          Effect.provide(layer),
        );
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-server-" });
        const accepted = yield* acceptFactoryRun(factoryCreateInput(), {
          harnessProviderRegistry: makeTestHarnessProviderRegistry(),
          rootDirectory: cwd,
        });
        const artifactLayer = testServerLayer(cwd);
        const badArtifact = yield* HttpClient.get(
          `/runs/${accepted.runId}/artifacts/..%2Fevents.jsonl`,
        ).pipe(Effect.provide(artifactLayer));
        const unknownArtifact = yield* HttpClient.get(
          `/runs/${accepted.runId}/artifacts/report.json`,
        ).pipe(Effect.provide(artifactLayer));
        const post = yield* HttpClientRequest.post("/runs").pipe(
          HttpClient.execute,
          Effect.provide(layer),
        );
        const put = yield* HttpClientRequest.put("/runs/not-a-run").pipe(
          HttpClient.execute,
          Effect.provide(layer),
        );
        const head = yield* HttpClientRequest.head("/runs").pipe(
          HttpClient.execute,
          Effect.provide(layer),
        );
        const malformedPath = yield* HttpClient.get("/runs/%E0%A4%A").pipe(
          Effect.provide(layer),
        );
        const badRunBody = yield* responseJsonObject(badRun, "bad run");
        const badArtifactBody = yield* responseJsonObject(
          badArtifact,
          "bad artifact",
        );
        const unknownArtifactBody = yield* responseJsonObject(
          unknownArtifact,
          "unknown artifact",
        );
        const postBody = yield* responseJsonObject(post, "post runs");
        const putBody = yield* responseJsonObject(put, "put run");
        const malformedPathBody = yield* responseJsonObject(
          malformedPath,
          "malformed path",
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
        assert.strictEqual(head.status, 405);
        assert.strictEqual(malformedPath.status, 404);
        assertApiError(malformedPathBody, "EndpointNotFound", 404);
      }),
    );
  });
});

function testServerLayer(
  rootDirectory: string,
  workflowOptions: ServerWorkflowOptions = {},
  serverOptions: Parameters<typeof makeLocalGaiaServerLayer>[3] = {},
) {
  return makeLocalGaiaServerLayer(
    testIdentity(rootDirectory),
    {
      harnessProviderRegistry: makeTestHarnessProviderRegistry(),
      ...workflowOptions,
    },
    [],
    serverOptions,
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
  );
}

function testIdentity(rootDirectory: string): LocalServerIdentity {
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
          Effect.succeed(pendingApprovalSession(request.sessionId, resolutions)),
        descriptor: pendingApprovalProvider,
        detect: Effect.succeed({
          auth: { state: "notRequired" },
          capabilities: pendingApprovalCapabilities,
          state: "available",
          version: "pending-approval-1",
        }),
        resumeSession: (request) =>
          Effect.succeed(pendingApprovalSession(request.sessionId, resolutions)),
      },
    },
  ]);
}

function pendingApprovalSession(
  sessionId: ReturnType<typeof parseHarnessSessionId>,
  resolutions: unknown[],
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
    send: () => Effect.void,
    snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
    steer: Option.none(),
  };
}

function eventuallyAgentSession(runId: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const response = yield* HttpClient.get(
        `/runs/${runId}/agents/agent-worker/session`,
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
  label = "response",
) {
  return response.json.pipe(
    Effect.flatMap((parsed) => {
      if (isJsonObject(parsed)) {
        return Effect.succeed(parsed);
      }

      return Effect.fail(
        new Error(
          `${label} JSON was not an object at status ${response.status}: ${JSON.stringify(parsed)}.`,
        ),
      );
    }),
  );
}

function parseSseDataEvents(
  text: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return parseSseBlocks(text).map(({ data }) => data);
}

function parseSseBlocks(
  text: string,
): ReadonlyArray<{ readonly data: Readonly<Record<string, unknown>>; readonly id: string | undefined }> {
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
          `Expected SSE data event to be an object: ${dataLines.join("\n")}.`,
        );
      }

      return [{ data: parsed, id }];
    });
}

function assertApiError(
  body: Readonly<Record<string, unknown>>,
  code: string,
  status: number,
) {
  assert.strictEqual(getString(body, "code"), code);
  assert.strictEqual(getNumber(body, "status"), status);
  assert.strictEqual(typeof body["message"], "string");
  assert.strictEqual(typeof body["recoverable"], "boolean");
  assert.notProperty(body, "error");
}

function postCreateRun(
  layer: ReturnType<typeof testServerLayer>,
  specMarkdown: string,
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
    HttpClient.execute,
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
  return {
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
  } as const;
}

function pausingFirstDetectionRegistry(
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
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
        assert.fail(`Expected create retry to return 202 or transient 409, got ${response.status}.`);
      }
      yield* Effect.yieldNow;
    }
    assert.fail("Expected canceled pre-acceptance create to release its reservation.");
  });
}

function startNativeCreateRunRequest(
  baseUrl: string,
  specMarkdown: string,
) {
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
  return (command: { readonly args: ReadonlyArray<string>; readonly cwd: string }) =>
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
        return { stderr: "", stdout: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92\n" };
      }
      if (first === "rev-parse" && rest[0] === "HEAD") {
        return { stderr: "", stdout: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92\n" };
      }
      if (first === "worktree" && rest[0] === "add") {
        return { stderr: "", stdout: "" };
      }
      throw new Error(`Unexpected git command ${command.args.join(" ")}`);
    });
}

function appendTerminalRemediation(
  runId: ReturnType<typeof parseRunId>,
  rootDirectory: string,
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    const intent = DeliveryRemediationIntent.make({
      attempt: 1,
      commitTimestamp: "2026-07-11T11:00:00.000Z",
      expectedHeadSha: "b".repeat(40),
      feedbackDigest: "9".repeat(64),
      feedbackIds: [parseDeliveryFeedbackId(`feedback-check-${"8".repeat(64)}`)],
      inputId: `remediation-${runId}-1`,
      operationId: `remediation:${runId}:1`,
      state: "intentRecorded",
    });
    for (const remediation of [
      intent,
      DeliveryRemediationFailed.make({
        ...intent,
        code: "TestTerminalBlocker",
        message: "Terminal test blocker.",
        recoverable: false,
        state: "failed",
      }),
    ]) {
      yield* appendEvent(runId, paths, {
        payload: { remediation: encodeDeliveryRemediationJson(remediation) },
        type: "DELIVERY_REMEDIATION_RECORDED",
      });
    }
  });
}

function recordingDeliveryPublisher() {
  return (
    runId: ReturnType<typeof parseRunId>,
    options: DeliveryPublicationOptions = {},
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
    options: DeliveryPublicationOptions = {},
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
    options: DeliveryPublicationOptions = {},
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

function deliveryActionRequest(runId: string, expectedEventSequence: number) {
  return HttpClientRequest.post(`/runs/${runId}/delivery/actions`).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      expectedEventSequence,
      kind: "reconcile",
    }),
  );
}

function pausingReviewer(release: Deferred.Deferred<void>): GaiaReviewer {
  const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
    "pausing-server-reviewer",
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
  key: string,
): Readonly<Record<string, unknown>> {
  const value = input[key];
  if (isJsonObject(value)) {
    return value;
  }

  throw new Error(`Expected ${key} to be an object.`);
}

function getArray(
  input: Readonly<Record<string, unknown>>,
  key: string,
): ReadonlyArray<unknown> {
  const value = input[key];
  if (Array.isArray(value)) {
    return value;
  }

  throw new Error(`Expected ${key} to be an array.`);
}

function getObjectFromArray(
  input: ReadonlyArray<unknown>,
  index: number,
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

function getString(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key];
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Expected ${key} to be a string.`);
}

function getNumber(input: Readonly<Record<string, unknown>>, key: string): number {
  const value = input[key];
  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Expected ${key} to be a number.`);
}

function isJsonObject(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
