import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import {
  listLocalRuns,
  readLocalRun,
  readLocalRunArtifact,
  readLocalRunEvents,
} from "./run-read-api.js";
import { makeRunStorePaths } from "./paths.js";
import { runSpecFile } from "./workflows.js";

describe("local run read api", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("lists valid runs with diagnostics for malformed run directories", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-read-api-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Expose read model.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        yield* fs.makeDirectory(`${store.runsRoot}/run-not-valid`);
        yield* fs.makeDirectory(`${store.runsRoot}/run-L84-kMhLY8`);

        const result = yield* listLocalRuns({ rootDirectory: cwd });

        assert.deepEqual(
          result.runs.map((run) => run.runId),
          [summary.runId],
        );
        assert.strictEqual(result.diagnostics.length, 2);
        assert.deepInclude(result.diagnostics, {
          code: "InvalidRunDirectory",
          message: "Run directory name is not a valid Gaia run id.",
          pathSegment: "run-not-valid",
          recoverable: false,
        });
        const emptyRunDiagnostic = result.diagnostics.find(
          (diagnostic) => diagnostic.code === "RunHasNoEvents",
        );
        assert.strictEqual(
          emptyRunDiagnostic?.message,
          "Run has no events.jsonl records.",
        );
        assert.strictEqual(emptyRunDiagnostic?.runId, "run-L84-kMhLY8");
      }),
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
        assert.strictEqual(run.status, "completed");
        assert.isAbove(run.eventCount, 0);
        assert.includeMembers(run.artifacts, [
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
        ]);
        assert.notInclude(run.artifacts, "report.json");
        assert.strictEqual(events.runId, summary.runId);
        assert.strictEqual(events.events.length, run.eventCount);
        assert.strictEqual(events.events[0]?.type, "RUN_CREATED");
      }),
    );

    it.effect("fails a malformed requested run with a constrained diagnostic", () =>
      Effect.gen(function* () {
        const diagnostic = yield* Effect.flip(
          readLocalRun("not-a-run-id", { rootDirectory: "." }),
        );

        assert.deepEqual(diagnostic, {
          code: "InvalidRunId",
          message: "Requested run id is not a valid Gaia run id.",
          pathSegment: "not-a-run-id",
          recoverable: false,
        });
      }),
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
          { rootDirectory: cwd },
        );
        const events = yield* readLocalRunArtifact(
          summary.runId,
          "events",
          { rootDirectory: cwd },
        );
        const promotion = yield* readLocalRunArtifact(
          summary.runId,
          "evidence-promotion-markdown",
          { rootDirectory: cwd },
        );
        const factoryRetro = yield* readLocalRunArtifact(
          summary.runId,
          "factory-retro-markdown",
          { rootDirectory: cwd },
        );
        const rejected = yield* Effect.flip(
          readLocalRunArtifact(summary.runId, "../events.jsonl", {
            rootDirectory: cwd,
          }),
        );

        assert.strictEqual(report.artifactName, "report-json");
        assert.strictEqual(report.contentType, "application/json");
        assert.include(report.body, summary.runId);
        assert.strictEqual(events.artifactName, "events");
        assert.strictEqual(events.contentType, "application/json");
        assert.include(events.body, "\"type\":\"RUN_CREATED\"");
        assert.strictEqual(promotion.artifactName, "evidence-promotion-markdown");
        assert.strictEqual(promotion.contentType, "text/markdown");
        assert.include(promotion.body, `# Evidence Promotion ${summary.runId}`);
        assert.strictEqual(factoryRetro.artifactName, "factory-retro-markdown");
        assert.strictEqual(factoryRetro.contentType, "text/markdown");
        assert.include(factoryRetro.body, `# Factory Retro ${summary.runId}`);
        assert.deepEqual(rejected, {
          artifactName: "../events.jsonl",
          code: "ArtifactNotAllowed",
          message: "Artifact is not allowlisted for local API reads.",
          recoverable: false,
          runId: summary.runId,
        });
      }),
    );
  });
});
