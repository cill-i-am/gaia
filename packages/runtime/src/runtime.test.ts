import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { execPath } from "node:process";
import { parseRunId } from "@gaia/core";
import { GaiaRuntimeError } from "./errors.js";
import {
  inspectGitHubChecks,
  publishRunToGitHub,
  recordGitHubChecks,
  type CommandExecutionResult,
  type GitHubCommandInput,
  type GitHubCommandRunner,
} from "./github-publisher.js";
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

    it.effect("publishes a completed run through the GitHub command seam", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Publish this run.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const commands: Array<GitHubCommandInput> = [];
        const runner = recordingGitHubRunner(commands, (input) => {
          if (
            input.command === "git" &&
            input.args.join(" ") === "rev-parse --abbrev-ref HEAD"
          ) {
            return { exitCode: 0, stderr: "", stdout: "main\n" };
          }
          if (input.command === "gh") {
            return {
              exitCode: 0,
              stderr: "",
              stdout: "https://github.com/cill-i-am/gaia/pull/123\n",
            };
          }

          return { exitCode: 0, stderr: "", stdout: "" };
        });

        const pr = yield* publishRunToGitHub(summary.runId, {
          commandRunner: runner,
          rootDirectory: cwd,
        });

        const evidenceReadme = yield* fs.readFileString(
          `${cwd}/gaia-runs/${summary.runId}/README.md`,
        );
        assert.strictEqual(pr.status, "opened");
        assert.strictEqual(pr.branchName, `gaia/${summary.runId}`);
        assert.strictEqual(
          pr.prUrl,
          "https://github.com/cill-i-am/gaia/pull/123",
        );
        assert.include(evidenceReadme, "Gaia Run");
        assert.deepEqual(
          commands.map((command) => [command.command, command.args[0]]),
          [
            ["git", "status"],
            ["git", "rev-parse"],
            ["git", "fetch"],
            ["git", "checkout"],
            ["git", "add"],
            ["git", "commit"],
            ["git", "push"],
            ["gh", "pr"],
            ["git", "checkout"],
          ],
        );
      }),
    );

    it.effect("refuses to publish a run from a dirty worktree", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Publish this dirty run.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const error = yield* Effect.flip(
          publishRunToGitHub(summary.runId, {
            commandRunner: recordingGitHubRunner([], (input) =>
              input.command === "git" && input.args[0] === "status"
                ? { exitCode: 0, stderr: "", stdout: "M README.md\n" }
                : { exitCode: 0, stderr: "", stdout: "" },
            ),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "GitWorktreeDirty");
        }
      }),
    );

    it.effect("reports no GitHub checks as an explicit state", () =>
      Effect.gen(function* () {
        const cwd = yield* tempDirectory;
        const summary = yield* inspectGitHubChecks("1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 1,
            stderr: "no checks reported on the 'gaia/example' branch\n",
            stdout: "",
          })),
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.status, "no-checks");
        assert.strictEqual(summary.checks.length, 0);
      }),
    );

    it.effect("classifies pending GitHub checks", () =>
      Effect.gen(function* () {
        const cwd = yield* tempDirectory;
        const summary = yield* inspectGitHubChecks("1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              {
                link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                name: "test",
                state: "PENDING",
                workflow: "CI",
              },
            ]),
          })),
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.status, "pending");
      }),
    );

    it.effect("classifies passing and failing GitHub checks", () =>
      Effect.gen(function* () {
        const cwd = yield* tempDirectory;
        const passed = yield* inspectGitHubChecks("1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              {
                link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                name: "check",
                state: "SUCCESS",
                workflow: "CI",
              },
            ]),
          })),
          rootDirectory: cwd,
        });
        const failed = yield* inspectGitHubChecks("1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              {
                link: "https://github.com/cill-i-am/gaia/actions/runs/2",
                name: "check",
                state: "FAILURE",
                workflow: "CI",
              },
            ]),
          })),
          rootDirectory: cwd,
        });

        assert.strictEqual(passed.status, "passed");
        assert.strictEqual(failed.status, "failed");
      }),
    );

    it.effect("records a GitHub check snapshot against a completed run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Record checks for this run.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const recorded = yield* recordGitHubChecks(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              {
                link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                name: "check",
                state: "SUCCESS",
                workflow: "CI",
              },
            ]),
          })),
          rootDirectory: cwd,
        });

        const snapshot = yield* fs.readFileString(recorded.snapshotPath);
        const events = yield* fs.readFileString(`${run.runDirectory}/events.jsonl`);
        const relativeSnapshotPath = recorded.snapshotPath.slice(
          run.runDirectory.length + 1,
        );

        assert.strictEqual(recorded.status, "passed");
        assert.strictEqual(recorded.attempts, 1);
        assert.isTrue(recorded.terminal);
        assert.include(snapshot, '"status": "passed"');
        assert.include(snapshot, '"attempts": 1');
        assert.include(events, '"type":"GITHUB_CHECKS_RECORDED"');
        assert.include(events, `"checksPath":"${relativeSnapshotPath}"`);
      }),
    );

    it.effect("waits for pending GitHub checks before recording", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Wait for checks for this run.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });
        let checksCalls = 0;

        const recorded = yield* recordGitHubChecks(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], () => {
            checksCalls += 1;
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify([
                {
                  link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                  name: "check",
                  state: checksCalls === 1 ? "PENDING" : "SUCCESS",
                  workflow: "CI",
                },
              ]),
            };
          }),
          pollInterval: "0 millis",
          rootDirectory: cwd,
          waitForTerminal: true,
        });

        assert.strictEqual(recorded.status, "passed");
        assert.strictEqual(recorded.attempts, 2);
        assert.isTrue(recorded.terminal);
        assert.strictEqual(checksCalls, 2);
      }),
    );

    it.effect("records pending checks when bounded waiting is exhausted", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Bound waiting for checks.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });
        let checksCalls = 0;

        const recorded = yield* recordGitHubChecks(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], () => {
            checksCalls += 1;
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify([
                {
                  link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                  name: "check",
                  state: "PENDING",
                  workflow: "CI",
                },
              ]),
            };
          }),
          maxAttempts: 2,
          pollInterval: "0 millis",
          rootDirectory: cwd,
          waitForTerminal: true,
        });

        assert.strictEqual(recorded.status, "pending");
        assert.strictEqual(recorded.attempts, 2);
        assert.isFalse(recorded.terminal);
        assert.strictEqual(checksCalls, 2);
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

const tempDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
});

function recordingGitHubRunner(
  commands: Array<GitHubCommandInput>,
  respond: (input: GitHubCommandInput) => CommandExecutionResult,
): GitHubCommandRunner {
  return (input) =>
    Effect.sync(() => {
      commands.push(input);
      return respond(input);
    });
}
