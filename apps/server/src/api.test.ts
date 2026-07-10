import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { codexAppServerExecutionSelection, parseRunId } from "@gaia/core";
import {
  makeHarnessProviderRegistry,
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
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
) {
  return makeLocalGaiaServerLayer(testIdentity(rootDirectory), {
    harnessProviderRegistry: makeTestHarnessProviderRegistry(),
    ...workflowOptions,
  }).pipe(
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

function factoryCreateInput() {
  return {
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
