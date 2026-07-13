import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  LocalRunReadDiagnosticSchema,
  LocalRunReadListSchema,
  LocalRunReadSummarySchema,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { makeRunPaths, makeRunStorePaths } from "./paths.js";
import {
  listLocalRuns,
  readLocalRun,
  readLocalRunArtifact,
  readLocalRunEvents,
} from "./run-read-api.js";
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
