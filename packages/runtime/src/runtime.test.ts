import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { execPath } from "node:process";
import { parseRunId } from "@gaia/core";
import { GaiaRuntimeError } from "./errors.js";
import { makeProcessHarnessConfig, parseHarnessName } from "./harness.js";
import { makeRunPaths } from "./paths.js";
import { resumeRun, runSpecFile, statusRun } from "./workflows.js";
import { localDirectoryWorkspaceSource } from "./workspace.js";
import { verifyHarnessOutput } from "./verifier.js";

describe("runtime workflows", () => {
  layer(NodeServices.layer)((it) => {
    it.effect("creates a durable run with evidence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          specPath,
          "---\ntitle: Runtime smoke\n---\n\nDo the thing.\n",
        );

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        assert.strictEqual(summary.status, "completed");

        const eventsExists = yield* fs.exists(`${summary.runDirectory}/events.jsonl`);
        assert.isDefined(summary.reportPath);
        const reportExists = yield* fs.exists(summary.reportPath);
        const workerPlanExists = yield* fs.exists(
          `${summary.runDirectory}/worker-plan.md`,
        );
        const planReviewExists = yield* fs.exists(
          `${summary.runDirectory}/plan-review.md`,
        );
        const evidenceReviewExists = yield* fs.exists(
          `${summary.runDirectory}/evidence-review.md`,
        );
        const output = yield* fs.readFileString(
          `${summary.runDirectory}/workspace/output.txt`,
        );
        const events = yield* fs.readFileString(
          `${summary.runDirectory}/events.jsonl`,
        );
        const report = yield* fs.readFileString(summary.reportPath);

        assert.isTrue(eventsExists);
        assert.isTrue(reportExists);
        assert.isTrue(workerPlanExists);
        assert.isTrue(planReviewExists);
        assert.isTrue(evidenceReviewExists);
        assert.include(events, '"type":"REVIEW_COMPLETED"');
        assert.include(report, "worker-plan.md");
        assert.include(report, "plan-review.md");
        assert.include(report, "evidence-review.md");
        assert.include(output, summary.runId);

        const resumed = yield* resumeRun(summary.runId, { rootDirectory: cwd });
        assert.strictEqual(resumed.status, "completed");
      }),
    );

    it.effect("reports status for the latest run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Run latest status.\n");

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const status = yield* statusRun(undefined, { rootDirectory: cwd });

        assert.strictEqual(status.runId, summary.runId);
        assert.strictEqual(status.state, "completed");
      }),
    );

    it.effect("copies a local workspace source into the isolated run workspace", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const source = `${cwd}/source`;
        const specPath = `${cwd}/spec.md`;

        yield* fs.makeDirectory(`${source}/src`, { recursive: true });
        yield* fs.makeDirectory(`${source}/.git`, { recursive: true });
        yield* fs.makeDirectory(`${source}/node_modules/pkg`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${source}/README.md`, "# Target\n");
        yield* fs.writeFileString(`${source}/src/index.ts`, "export {};\n");
        yield* fs.writeFileString(`${source}/.git/config`, "[core]\n");
        yield* fs.writeFileString(`${source}/node_modules/pkg/index.js`, "");
        yield* fs.writeFileString(specPath, "Run against a source workspace.\n");

        const summary = yield* runSpecFile(specPath, {
          rootDirectory: cwd,
          workspaceSource: localDirectoryWorkspaceSource(source),
        });

        const copiedReadme = yield* fs.exists(
          `${summary.runDirectory}/workspace/README.md`,
        );
        const copiedSourceFile = yield* fs.exists(
          `${summary.runDirectory}/workspace/src/index.ts`,
        );
        const copiedGitConfig = yield* fs.exists(
          `${summary.runDirectory}/workspace/.git/config`,
        );
        const copiedNodeModule = yield* fs.exists(
          `${summary.runDirectory}/workspace/node_modules/pkg/index.js`,
        );
        const manifest = yield* fs.readFileString(
          `${summary.runDirectory}/workspace-manifest.json`,
        );

        assert.isTrue(copiedReadme);
        assert.isTrue(copiedSourceFile);
        assert.isFalse(copiedGitConfig);
        assert.isFalse(copiedNodeModule);
        assert.include(manifest, '"source": "local-directory"');
      }),
    );

    it.effect("records normalized harness evidence for the selected harness", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Run through the fake harness.\n");

        const summary = yield* runSpecFile(specPath, {
          harnessName: parseHarnessName("fake"),
          rootDirectory: cwd,
        });

        const events = yield* fs.readFileString(
          `${summary.runDirectory}/events.jsonl`,
        );
        const harnessResult = yield* fs.readFileString(
          `${summary.runDirectory}/worker-result.json`,
        );

        assert.include(events, '"harnessName":"fake"');
        assert.include(events, '"outputArtifacts":["workspace/output.txt"]');
        assert.include(harnessResult, '"harnessName": "fake"');
        assert.include(harnessResult, '"summary":');
      }),
    );

    it.effect("fails fast when a requested harness is not registered", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Run through a missing harness.\n");

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            harnessName: parseHarnessName("codex"),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "UnknownHarness");
        }
      }),
    );

    it.effect("runs the process harness through the workflow seam", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const scriptPath = `${cwd}/process-harness.mjs`;
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          scriptPath,
          [
            "import { writeFileSync } from 'node:fs';",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness ${process.env.GAIA_RUN_ID}\\n`);",
            "console.log(`process harness saw ${process.env.GAIA_SPEC_TITLE}`);",
          ].join("\n"),
        );
        yield* fs.writeFileString(specPath, "Run through process.\n");

        const summary = yield* runSpecFile(specPath, {
          harnessName: parseHarnessName("process"),
          processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
          rootDirectory: cwd,
        });

        const output = yield* fs.readFileString(
          `${summary.runDirectory}/workspace/output.txt`,
        );
        const workerLog = yield* fs.readFileString(
          `${summary.runDirectory}/worker.log`,
        );
        const harnessResult = yield* fs.readFileString(
          `${summary.runDirectory}/worker-result.json`,
        );

        assert.include(output, summary.runId);
        assert.include(workerLog, "process harness saw spec");
        assert.include(harnessResult, '"harnessName": "process"');
      }),
    );

    it.effect("fails fast when the process harness command is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Run through missing process.\n");

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            harnessName: parseHarnessName("process"),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "ProcessHarnessCommandMissing");
        }
      }),
    );

    it.effect("fails with a typed error when the process exits non-zero", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const scriptPath = `${cwd}/process-harness-fails.mjs`;
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(scriptPath, "process.exit(7);\n");
        yield* fs.writeFileString(specPath, "Run through failing process.\n");

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            harnessName: parseHarnessName("process"),
            processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "ProcessHarnessCommandFailed");
        }

        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        assert.strictEqual(status.state, "failed");
        assert.strictEqual(status.status, "failed");
      }),
    );

    it.effect("fails verification when the worker artifact is missing", () =>
      Effect.gen(function* () {
        const runId = parseRunId("run-V7kP9sQ2xY");
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
        yield* fs.makeDirectory(paths.workspace, { recursive: true });

        const exit = yield* Effect.exit(verifyHarnessOutput(runId, paths));
        assert.isTrue(exit._tag === "Failure");
      }),
    );
  });
});
