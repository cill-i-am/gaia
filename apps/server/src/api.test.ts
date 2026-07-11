import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationIntent,
  DeliveryPublicationOutcomeUnknown,
  DeliveryBlocker,
  DeliveryFeedbackObservation,
  DeliveryPullRequestObservation,
  DeliveryRemediationIntent,
  DeliveryRemediationFailed,
  encodeDeliveryPullRequestObservationJson,
  encodeDeliveryPublicationJson,
  encodeDeliveryRemediationJson,
  parseDeliveryFeedbackId,
  parseRunId,
} from "@gaia/core";
import {
  makeHarnessProviderRegistry,
  appendEvent,
  ReviewResult,
  ReviewerNameSchema,
  subscribeRunEventFeed,
  type GaiaReviewer,
  type DeliveryPublicationOptions,
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
import { Deferred, Effect, FileSystem, Layer, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import { makeLocalGaiaServerLayer } from "./api.js";
import type { LocalServerIdentity } from "./discovery.js";

describe("local run api http boundary", () => {
  layer(NodeServices.layer)((it) => {
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
        const layer = testServerLayer(cwd, {
          deliveryMergeActivator: (_runId, action) => Effect.gen(function* () {
            const key = JSON.stringify(action);
            if (action.actionId.includes("conflict")) return yield* Effect.fail({ code: "DeliveryActionConflict", message: "immutable tuple changed", recoverable: true });
            if (!seen.has(key)) { seen.add(key); mutations += 1; }
            return action;
          }),
        });
        const request = (body: Record<string, unknown>) => HttpClientRequest.post(`/runs/${accepted.runId}/delivery/actions`).pipe(HttpClientRequest.bodyJsonUnsafe(body), HttpClient.execute, Effect.provide(layer));
        const actions = [
          { actionId: "readiness-1", kind: "evaluateMergeReadiness", mergeMethod: "merge" },
          { actionId: "merge-1", expectedBranchName: "gaia/run-1234567890", expectedDecisionSequence: 9, expectedHeadSha: "a".repeat(40), expectedPolicyDigest: "b".repeat(64), expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/74", kind: "merge", mergeMethod: "squash" },
          { actionId: "cleanup-1", expectedMergeCommitSha: "c".repeat(40), kind: "retryCleanup" },
        ];
        for (const action of actions) {
          const first = yield* request(action); const duplicate = yield* request(action);
          assert.strictEqual(first.status, 200); assert.strictEqual(duplicate.status, 200);
        }
        assert.strictEqual(mutations, actions.length);
        const conflicts = [
          { ...actions[0]!, actionId: "conflict-readiness", mergeMethod: "rebase" },
          { ...actions[1]!, actionId: "conflict-merge", expectedDecisionSequence: 8 },
          { ...actions[1]!, actionId: "conflict-head", expectedHeadSha: "d".repeat(40) },
          { ...actions[1]!, actionId: "conflict-pr", expectedPrUrl: "https://github.com/cill-i-am/gaia/pull/75" },
          { ...actions[2]!, actionId: "conflict-cleanup", expectedMergeCommitSha: "e".repeat(40) },
        ];
        for (const action of conflicts) {
          const response = yield* request(action); const body = yield* responseJsonObject(response);
          assert.strictEqual(response.status, 409); assertApiError(body, "DeliveryActionConflict", 409);
        }
      }),
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
        assert.strictEqual(getNumber(projected, "remediationRearmSequence"), intentEvent.event.sequence);
        assert.strictEqual(getString(getObject(projected, "observation"), "headSha"), observation.headSha);
        assert.strictEqual(getString(getObject(projected, "remediation"), "state"), "intentRecorded");
        assert.notInclude(JSON.stringify(projected), "Project delivery remediation");
        assert.notInclude(JSON.stringify(projected), "native-comment");
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
  return createRunRequestFromPayload({
    delivery: { mode: "local" },
    execution: codexAppServerExecutionSelection,
    workflow: "issueDelivery",
    workItem: {
      description: specMarkdown,
      kind: "issue",
      title: "Server API test run",
    },
  });
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
