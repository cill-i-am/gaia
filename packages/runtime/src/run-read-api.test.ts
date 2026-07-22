import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  codexAppServerExecutionSelection,
  LocalRunReadDiagnosticSchema,
  LocalRunReadListSchema,
  LocalRunReadSummarySchema,
  parseRunId,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { makeRunPaths, makeRunStorePaths } from "./paths.js";
import {
  listLocalRuns,
  readLocalRun,
  readLocalRunArtifact,
  readLocalRunEvents,
} from "./run-read-api.js";
import { acceptFactoryRun, continueServerRun } from "./server-workflows.js";
import { makeTestHarnessProviderRegistry } from "./test-support.js";
import { runSpecFile } from "./workflows.js";

describe("local run read api", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "lists valid runs with diagnostics for malformed run directories",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-read-api-" });
          const specPath = `${cwd}/spec.md`;
          yield* fs.writeFileString(specPath, "Expose read model.\n");
          const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
          const store = yield* makeRunStorePaths({ rootDirectory: cwd });
          yield* fs.makeDirectory(`${store.runsRoot}/run-not-valid`);
          yield* fs.makeDirectory(`${store.runsRoot}/run-unsafe\\segment`);
          yield* fs.makeDirectory(`${store.runsRoot}/run-L84-kMhLY8`);

          const result = yield* listLocalRuns({ rootDirectory: cwd });
          const decoded = Schema.decodeUnknownSync(LocalRunReadListSchema)(
            result
          );

          assert.deepEqual(
            decoded.runs.map((run) => run.runId),
            [summary.runId]
          );
          assert.strictEqual(result.diagnostics.length, 3);
          const invalidRunDiagnostic = result.diagnostics.find(
            (diagnostic) => diagnostic.pathSegment === "run-not-valid"
          );
          assert.strictEqual(
            invalidRunDiagnostic?.message,
            "Run directory name is not a valid Gaia run id."
          );
          assert.strictEqual(
            invalidRunDiagnostic?.pathSegment,
            "run-not-valid"
          );
          assert.isFalse(invalidRunDiagnostic?.recoverable);
          assert.isTrue(
            result.diagnostics.some(
              (diagnostic) =>
                diagnostic.code === "InvalidRunDirectory" &&
                diagnostic.pathSegment === undefined
            )
          );
          const emptyRunDiagnostic = result.diagnostics.find(
            (diagnostic) => diagnostic.code === "RunHasNoEvents"
          );
          assert.strictEqual(
            emptyRunDiagnostic?.message,
            "Run has no events.jsonl records."
          );
          assert.strictEqual(emptyRunDiagnostic?.runId, "run-L84-kMhLY8");
        })
    );

    it.effect("reads one run and its event envelope from events.jsonl", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-read-api-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Read one run.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const run = yield* readLocalRun(summary.runId, { rootDirectory: cwd });
        const events = yield* readLocalRunEvents(summary.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(run.runId, summary.runId);
        assert.deepEqual(
          Schema.decodeUnknownSync(LocalRunReadSummarySchema)(run),
          run
        );
        assert.strictEqual(run.status, "completed");
        assert.isAbove(run.eventCount, 0);
        for (const expected of [
          "input",
          "worker-plan",
          "plan-review",
          "worker-log",
          "worker-result",
          "verification-result",
          "evidence-review",
          "evidence-promotion",
          "evidence-promotion-markdown",
          "factory-retro",
          "factory-retro-markdown",
          "report",
          "report-json",
          "events",
          "snapshots",
        ]) {
          assert.isTrue(
            run.artifacts.some((artifactName) => artifactName === expected)
          );
        }
        assert.isFalse(run.artifacts.map(String).includes("report.json"));
        assert.strictEqual(events.runId, summary.runId);
        assert.strictEqual(events.events.length, run.eventCount);
        assert.strictEqual(events.events[0]?.type, "RUN_CREATED");
      })
    );

    it.effect(
      "lists and reads only event-referenced model manifest bodies",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-read-model-",
          });
          const completed = yield* makeManifestRun(fs, cwd);
          const run = yield* readLocalRun(completed.runId, {
            rootDirectory: cwd,
          });
          const first = run.modelInvocationArtifacts[0];
          if (first === undefined)
            assert.fail("Expected model manifest artifacts.");
          const body = yield* readLocalRunArtifact(
            completed.runId,
            first.artifactId,
            { rootDirectory: cwd }
          );
          const paths = yield* makeRunPaths(completed.runId, {
            rootDirectory: cwd,
          });
          yield* fs.makeDirectory(`${paths.modelInvocations}/orphan`, {
            recursive: true,
          });
          yield* fs.writeFileString(
            `${paths.modelInvocations}/orphan/context-manifest.json`,
            "{}\n"
          );
          const orphan = Schema.decodeUnknownSync(LocalRunReadDiagnosticSchema)(
            yield* Effect.flip(
              readLocalRunArtifact(completed.runId, `mmf1_${"9".repeat(64)}`, {
                rootDirectory: cwd,
              })
            )
          );
          const repeated = yield* readLocalRun(completed.runId, {
            rootDirectory: cwd,
          });

          assert.isAtLeast(run.modelInvocationArtifacts.length, 6);
          assert.strictEqual(first.availability, "available");
          assert.strictEqual(body.contentType, "application/json");
          assert.strictEqual(JSON.parse(body.body).payload.version, 1);
          assert.strictEqual(orphan.code, "ArtifactNotFound");
          assert.lengthOf(
            repeated.modelInvocationArtifacts,
            run.modelInvocationArtifacts.length
          );
        })
    );

    it.effect(
      "reports typed unavailable diagnostics for a corrupt referenced pair",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-read-corrupt-",
          });
          const completed = yield* makeManifestRun(fs, cwd);
          const events = yield* readLocalRunEvents(completed.runId, {
            rootDirectory: cwd,
          });
          const first = (yield* readLocalRun(completed.runId, {
            rootDirectory: cwd,
          })).modelInvocationArtifacts[0];
          if (first === undefined)
            assert.fail("Expected model manifest artifacts.");
          const relativePath = manifestPath(events.events, first.artifactId);
          const paths = yield* makeRunPaths(completed.runId, {
            rootDirectory: cwd,
          });
          yield* fs.writeFileString(`${paths.root}/${relativePath}`, "{}\n");

          const summary = yield* readLocalRun(completed.runId, {
            rootDirectory: cwd,
          });
          const unavailable = summary.modelInvocationArtifacts.find(
            ({ artifactId }) => artifactId === first.artifactId
          );
          const bodyFailure = Schema.decodeUnknownSync(
            LocalRunReadDiagnosticSchema
          )(
            yield* Effect.flip(
              readLocalRunArtifact(completed.runId, first.artifactId, {
                rootDirectory: cwd,
              })
            )
          );

          assert.strictEqual(unavailable?.availability, "unavailable");
          assert.strictEqual(
            unavailable?.diagnostic?.code,
            "ArtifactBodyMismatch"
          );
          assert.strictEqual(bodyFailure.code, "ArtifactBodyMismatch");
        })
    );

    it.effect(
      "rejects a public event read when the run directory contains a foreign history",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-read-api-substituted-run-",
          });
          const requestedRunId = parseRunId("run-PublicReq1");
          const foreignRunId = parseRunId("run-PublicFor1");
          const paths = yield* makeRunPaths(requestedRunId, {
            rootDirectory: cwd,
          });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.writeFileString(
            paths.events,
            `${JSON.stringify({
              payload: { specPath: "foreign.md" },
              runId: foreignRunId,
              sequence: 1,
              timestamp: "2026-07-20T08:00:01.000Z",
              type: "RUN_CREATED",
              version: 1,
            })}\n`
          );

          const failure = yield* Effect.flip(
            readLocalRunEvents(requestedRunId, { rootDirectory: cwd })
          );

          assert.deepInclude(failure, {
            code: "RunUnreadable",
            recoverable: false,
            runId: requestedRunId,
          });
        })
    );

    it.effect("reads logical artifacts and rejects arbitrary paths", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-read-api-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Read artifacts.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const report = yield* readLocalRunArtifact(
          summary.runId,
          "report-json",
          { rootDirectory: cwd }
        );
        const events = yield* readLocalRunArtifact(summary.runId, "events", {
          rootDirectory: cwd,
        });
        const promotion = yield* readLocalRunArtifact(
          summary.runId,
          "evidence-promotion-markdown",
          { rootDirectory: cwd }
        );
        const factoryRetro = yield* readLocalRunArtifact(
          summary.runId,
          "factory-retro-markdown",
          { rootDirectory: cwd }
        );
        const planReview = yield* readLocalRunArtifact(
          summary.runId,
          "plan-review",
          { rootDirectory: cwd }
        );
        const evidenceReview = yield* readLocalRunArtifact(
          summary.runId,
          "evidence-review",
          { rootDirectory: cwd }
        );
        const verificationResult = yield* readLocalRunArtifact(
          summary.runId,
          "verification-result",
          { rootDirectory: cwd }
        );
        const rejected = yield* Effect.flip(
          readLocalRunArtifact(summary.runId, "../events.jsonl", {
            rootDirectory: cwd,
          })
        );
        const emptyRejected = yield* Effect.flip(
          readLocalRunArtifact(summary.runId, "", { rootDirectory: cwd })
        );

        assert.strictEqual(report.artifactName, "report-json");
        assert.strictEqual(report.contentType, "application/json");
        assert.include(report.body, summary.runId);
        assert.strictEqual(events.artifactName, "events");
        assert.strictEqual(events.contentType, "application/json");
        assert.include(events.body, '"type":"RUN_CREATED"');
        assert.strictEqual(
          promotion.artifactName,
          "evidence-promotion-markdown"
        );
        assert.strictEqual(promotion.contentType, "text/markdown");
        assert.include(promotion.body, `# Evidence Promotion ${summary.runId}`);
        assert.strictEqual(factoryRetro.artifactName, "factory-retro-markdown");
        assert.strictEqual(factoryRetro.contentType, "text/markdown");
        assert.include(factoryRetro.body, `# Factory Retro ${summary.runId}`);
        assert.strictEqual(planReview.artifactName, "plan-review");
        assert.strictEqual(planReview.contentType, "application/json");
        assert.include(planReview.body, '"phase": "plan"');
        assert.strictEqual(evidenceReview.artifactName, "evidence-review");
        assert.strictEqual(evidenceReview.contentType, "application/json");
        assert.include(evidenceReview.body, '"phase": "evidence"');
        assert.strictEqual(
          verificationResult.artifactName,
          "verification-result"
        );
        assert.strictEqual(verificationResult.contentType, "application/json");
        assert.include(
          verificationResult.body,
          '"aggregate": "completed-unverified"'
        );
        const rejectedDiagnostic = Schema.decodeUnknownSync(
          LocalRunReadDiagnosticSchema
        )(rejected);
        const emptyDiagnostic = Schema.decodeUnknownSync(
          LocalRunReadDiagnosticSchema
        )(emptyRejected);
        assert.strictEqual(rejectedDiagnostic.artifactName, "../events.jsonl");
        assert.strictEqual(rejectedDiagnostic.code, "ArtifactNotAllowed");
        assert.strictEqual(
          rejectedDiagnostic.message,
          "Artifact is not allowlisted for local API reads."
        );
        assert.isFalse(rejectedDiagnostic.recoverable);
        assert.strictEqual(rejectedDiagnostic.runId, summary.runId);
        assert.strictEqual(emptyDiagnostic.artifactName, "");
        assert.strictEqual(emptyDiagnostic.code, "ArtifactNotAllowed");
        assert.strictEqual(
          emptyDiagnostic.message,
          "Artifact is not allowlisted for local API reads."
        );
        assert.isFalse(emptyDiagnostic.recoverable);
        assert.strictEqual(emptyDiagnostic.runId, summary.runId);
      })
    );

    it.effect(
      "repairs missing, corrupt, and schema-valid stale proof projections from events",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-read-api-" });
          const firstSpec = `${cwd}/first.md`;
          const secondSpec = `${cwd}/second.md`;
          yield* fs.writeFileString(firstSpec, "Repair first projections.\n");
          yield* fs.writeFileString(secondSpec, "Repair second projections.\n");
          const first = yield* runSpecFile(firstSpec, { rootDirectory: cwd });
          const second = yield* runSpecFile(secondSpec, {
            rootDirectory: cwd,
          });
          const firstPaths = yield* makeRunPaths(first.runId, {
            rootDirectory: cwd,
          });
          const secondPaths = yield* makeRunPaths(second.runId, {
            rootDirectory: cwd,
          });
          const canonicalContract = yield* fs.readFileString(
            firstPaths.runContract
          );
          const canonicalProof = yield* fs.readFileString(
            firstPaths.verificationResult
          );

          yield* fs.remove(firstPaths.runContract);
          yield* fs.writeFileString(firstPaths.verificationResult, "{ corrupt");
          const repaired = yield* readLocalRun(first.runId, {
            rootDirectory: cwd,
          });
          assert.isTrue(
            repaired.artifacts.some((artifact) => artifact === "run-contract")
          );
          assert.isTrue(
            repaired.artifacts.some(
              (artifact) => artifact === "verification-result"
            )
          );
          assert.strictEqual(
            yield* fs.readFileString(firstPaths.runContract),
            canonicalContract
          );
          assert.strictEqual(
            yield* fs.readFileString(firstPaths.verificationResult),
            canonicalProof
          );

          yield* fs.writeFileString(
            firstPaths.runContract,
            yield* fs.readFileString(secondPaths.runContract)
          );
          yield* fs.writeFileString(
            firstPaths.verificationResult,
            yield* fs.readFileString(secondPaths.verificationResult)
          );
          const contractArtifact = yield* readLocalRunArtifact(
            first.runId,
            "run-contract",
            { rootDirectory: cwd }
          );
          const proofArtifact = yield* readLocalRunArtifact(
            first.runId,
            "verification-result",
            { rootDirectory: cwd }
          );

          assert.strictEqual(contractArtifact.body, canonicalContract);
          assert.strictEqual(proofArtifact.body, canonicalProof);
          assert.strictEqual(
            yield* fs.readFileString(firstPaths.runContract),
            canonicalContract
          );
          assert.strictEqual(
            yield* fs.readFileString(firstPaths.verificationResult),
            canonicalProof
          );
        })
    );

    it.effect(
      "rejects an invalid summary timestamp at the filesystem seam",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-read-api-" });
          const specPath = `${cwd}/spec.md`;
          yield* fs.writeFileString(specPath, "Reject invalid timestamps.\n");
          const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
          const paths = yield* makeRunPaths(summary.runId, {
            rootDirectory: cwd,
          });
          const events = yield* fs.readFileString(paths.events);
          yield* fs.writeFileString(
            paths.events,
            events.replace(
              /"timestamp":"[^"]+"/u,
              '"timestamp":"not-a-timestamp"'
            )
          );

          const diagnostic = yield* Effect.flip(
            readLocalRun(summary.runId, { rootDirectory: cwd })
          );
          const decodedDiagnostic = Schema.decodeUnknownSync(
            LocalRunReadDiagnosticSchema
          )(diagnostic);

          assert.strictEqual(decodedDiagnostic.code, "RunUnreadable");
          assert.strictEqual(
            decodedDiagnostic.message,
            "Run could not be read from events.jsonl."
          );
          assert.isFalse(decodedDiagnostic.recoverable);
          assert.strictEqual(decodedDiagnostic.runId, summary.runId);
        })
    );
  });
});

function manifestPath(
  events: ReadonlyArray<{ readonly payload: Record<string, unknown> }>,
  artifactId: string
) {
  for (const event of events) {
    const episode = event.payload["modelInvocationEpisode"];
    if (typeof episode !== "object" || episode === null) continue;
    const record = episode as Record<string, unknown>;
    for (const key of ["contextRef", "invocationRef"] as const) {
      const ref = record[key];
      if (
        typeof ref === "object" &&
        ref !== null &&
        "artifactId" in ref &&
        ref.artifactId === artifactId &&
        "path" in ref &&
        typeof ref.path === "string"
      )
        return ref.path;
    }
  }
  throw new Error("Manifest reference path is unavailable.");
}

function makeManifestRun(fs: FileSystem.FileSystem, cwd: string) {
  const harnessProviderRegistry = makeTestHarnessProviderRegistry();
  return Effect.gen(function* () {
    const accepted = yield* acceptFactoryRun(
      {
        execution: codexAppServerExecutionSelection,
        workflow: "issueDelivery",
        workItem: {
          description: "Read event-owned manifests.",
          kind: "issue",
          title: "Manifest read API",
        },
      },
      { harnessProviderRegistry, rootDirectory: cwd }
    );
    const paths = yield* makeRunPaths(accepted.runId, { rootDirectory: cwd });
    yield* fs.makeDirectory(paths.workspace, { recursive: true });
    yield* fs.writeFileString(paths.workspaceOutput, `${accepted.runId}\n`);
    yield* continueServerRun(accepted.runId, {
      harnessProviderRegistry,
      rootDirectory: cwd,
    });
    return { runId: accepted.runId } as const;
  });
}
