import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { execPath } from "node:process";
import { parseRunId } from "@gaia/core";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import { parseBrowserEvidenceJson } from "./browser-evidence.js";
import {
  makeCodexHarnessConfig,
  nodeCodexCommandRunner,
  type CodexCommandInput,
  type CodexCommandRunner,
} from "./codex-harness.js";
import {
  inspectGitHubChecks,
  parseGitHubCiWatchStateJson,
  preflightGitHubPublish,
  previewGitHubPublish,
  publishRunToGitHub,
  publishWorkspaceRunToGitHub,
  recordGitHubChecks,
  type CommandExecutionResult,
  type GitHubCommandInput,
  type GitHubCommandRunner,
} from "./github-publisher.js";
import {
  codexHarnessName,
  makeProcessHarnessConfig,
  parseHarnessName,
} from "./harness.js";
import { makeRunPaths, makeRunStorePaths } from "./paths.js";
import { localSkillManifestSource } from "./skill-manifest.js";
import {
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
} from "./reviewer.js";
import { listRuns, resumeRun, runSpecFile, statusRun } from "./workflows.js";
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

    it.effect("skips empty run directories when listing runs", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "List around local debris.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        yield* fs.makeDirectory(`${store.runsRoot}/run-L84-kMhLY8`);

        const runs = yield* listRuns({ rootDirectory: cwd });

        assert.deepEqual(
          runs.map((run) => run.runId),
          [summary.runId],
        );
      }),
    );

    it.effect("releases the run store lock after a completed run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Run with a lock.\n");

        yield* runSpecFile(specPath, { rootDirectory: cwd });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        const lockExists = yield* fs.exists(store.lock);

        assert.isFalse(lockExists);
      }),
    );

    it.effect("refuses to start a run while the run store is locked", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        yield* fs.writeFileString(specPath, "Run while locked.\n");
        yield* fs.makeDirectory(store.gaiaRoot, { recursive: true });
        yield* fs.makeDirectory(store.lock);

        const error = yield* Effect.flip(
          runSpecFile(specPath, { rootDirectory: cwd }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "RunStoreLocked");
          assert.isTrue(error.recoverable);
        }
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
        assert.include(harnessResult, '"changedWorkspacePaths": [');
        assert.include(harnessResult, '"output.txt"');
        assert.include(harnessResult, '"exitCode": 0');
        assert.include(harnessResult, '"summary":');
      }),
    );

    it.effect("runs a configured reviewer through the workflow seam", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
          "recording-reviewer",
        );
        const reviewer: GaiaReviewer = {
          name: reviewerName,
          run: (request) =>
            Effect.succeed(
              ReviewResult.make({
                findings: [],
                phase: request.phase,
                resultPath:
                  request.phase === "plan"
                    ? "plan-review.json"
                    : "evidence-review.json",
                reviewerName,
                runId: request.runId,
                status: "approved",
                summary: `Recording reviewer approved ${request.phase}.`,
              }),
            ),
        };
        yield* fs.writeFileString(specPath, "Run with a configured reviewer.\n");

        const summary = yield* runSpecFile(specPath, {
          reviewer,
          rootDirectory: cwd,
        });

        const events = yield* fs.readFileString(
          `${summary.runDirectory}/events.jsonl`,
        );
        const planReview = yield* fs.readFileString(
          `${summary.runDirectory}/plan-review.md`,
        );
        const evidenceReview = yield* fs.readFileString(
          `${summary.runDirectory}/evidence-review.md`,
        );

        assert.include(events, '"reviewerName":"recording-reviewer"');
        assert.include(planReview, "Reviewer: recording-reviewer");
        assert.include(evidenceReview, "Recording reviewer approved evidence.");
      }),
    );

    it.effect("fails a run when a reviewer mutates the workspace", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
          "mutating-reviewer",
        );
        const reviewer: GaiaReviewer = {
          name: reviewerName,
          run: (request) =>
            Effect.gen(function* () {
              const runFs = yield* FileSystem.FileSystem;
              yield* runFs
                .writeFileString(
                  `${request.workspacePath}/reviewer-note.txt`,
                  "reviewers must be read-only\n",
                )
                .pipe(
                  Effect.mapError((cause) =>
                    makeRuntimeError({
                      cause,
                      code: "TestReviewerWriteFailed",
                      message: "Test reviewer could not write mutation marker.",
                      recoverable: false,
                    }),
                  ),
                );

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
                summary: "Mutating reviewer should be rejected.",
              });
            }),
        };
        yield* fs.writeFileString(specPath, "Reject mutating reviewers.\n");

        const error = yield* Effect.flip(
          runSpecFile(specPath, { reviewer, rootDirectory: cwd }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "ReviewerWorkspaceMutated");
        }

        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        assert.strictEqual(status.state, "failed");
      }),
    );

    it.effect("records selected skills from a pinned skill manifest", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const manifestPath = `${cwd}/skills.json`;
        yield* fs.writeFileString(specPath, "Run with selected skills.\n");
        yield* fs.writeFileString(
          manifestPath,
          `${JSON.stringify(
            {
              skills: [
                {
                  commit: "abc123",
                  name: "coding-standards",
                  sourcePath: "skills/coding-standards",
                  sourceRepository: "github.com/cillianbarron/skills",
                },
              ],
            },
            null,
            2,
          )}\n`,
        );

        const summary = yield* runSpecFile(specPath, {
          rootDirectory: cwd,
          skillManifestSource: localSkillManifestSource(manifestPath),
        });

        const skillManifest = yield* fs.readFileString(
          `${summary.runDirectory}/skill-manifest.json`,
        );
        const reportJson = yield* fs.readFileString(
          `${summary.runDirectory}/report.json`,
        );
        const reportMarkdown = yield* fs.readFileString(summary.reportPath);

        assert.include(skillManifest, '"name": "coding-standards"');
        assert.include(reportJson, '"selectedSkills": [');
        assert.include(reportJson, '"coding-standards"');
        assert.include(reportMarkdown, "- coding-standards");
        assert.include(reportMarkdown, "skill-manifest.json");
      }),
    );

    it.effect("writes a typed empty browser evidence contract", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Run with browser evidence shape.\n");

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const browserEvidence = yield* fs.readFileString(
          `${summary.runDirectory}/browser-evidence.json`,
        );
        const parsed = parseBrowserEvidenceJson(JSON.parse(browserEvidence));
        const report = yield* fs.readFileString(
          `${summary.runDirectory}/report.md`,
        );

        assert.strictEqual(parsed.status, "not-collected");
        assert.deepEqual(parsed.pages, []);
        assert.include(report, "browser-evidence.json");
      }),
    );

    it.effect("rejects unpinned skill manifest entries", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const manifestPath = `${cwd}/skills.json`;
        yield* fs.writeFileString(specPath, "Run with unpinned skills.\n");
        yield* fs.writeFileString(
          manifestPath,
          `${JSON.stringify({
            skills: [
              {
                name: "coding-standards",
                sourcePath: "skills/coding-standards",
                sourceRepository: "github.com/cillianbarron/skills",
              },
            ],
          })}\n`,
        );

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            rootDirectory: cwd,
            skillManifestSource: localSkillManifestSource(manifestPath),
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "SkillManifestEntryUnpinned");
        }

        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        assert.strictEqual(status.state, "failed");
      }),
    );

    it.effect("fails fast when the Codex harness config is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Run through Codex.\n");

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            harnessName: codexHarnessName,
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "CodexHarnessConfigMissing");
        }
      }),
    );

    it.effect("classifies a timed-out Codex process as a typed failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const config = makeCodexHarnessConfig({
          command: execPath,
          timeoutMs: 10,
        });

        const error = yield* Effect.flip(
          nodeCodexCommandRunner({
            args: ["-e", "setTimeout(() => {}, 1000);"],
            command: config.command,
            cwd,
            stdin: "",
            timeoutMs: config.timeoutMs,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "CodexCommandTimedOut");
          assert.isTrue(error.recoverable);
        }
      }),
    );

    it.effect("runs the Codex harness through the workflow seam", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const commands: Array<CodexCommandInput> = [];
        const commandRunner: CodexCommandRunner = (input) =>
          Effect.gen(function* () {
            commands.push(input);
            const outputLastMessageIndex = input.args.indexOf(
              "--output-last-message",
            );
            const outputLastMessagePath =
              input.args[outputLastMessageIndex + 1];

            if (outputLastMessagePath === undefined) {
              return yield* Effect.fail(
                makeRuntimeError({
                  code: "TestCodexLastMessagePathMissing",
                  message: "Test Codex command did not receive a last message path.",
                  recoverable: false,
                }),
              );
            }

            yield* fs.writeFileString(
              `${input.cwd}/output.txt`,
              `codex harness ${runIdFromCodexPrompt(input.stdin)} saw ${input.stdin.includes("Run through Codex")}\n`,
            );
            yield* fs.writeFileString(
              `${input.cwd}/changed.txt`,
              "changed by codex harness\n",
            );
            yield* fs.writeFileString(
              outputLastMessagePath,
              "Codex completed the run.\n",
            );

            return {
              exitCode: 0,
              stderr: "",
              stdout: '{"type":"turn.completed"}\n',
            };
          });
        yield* fs.writeFileString(specPath, "Run through Codex.\n");

        const summary = yield* runSpecFile(specPath, {
          codexHarness: {
            commandRunner,
            config: makeCodexHarnessConfig({
              command: "codex-test",
              timeoutMs: "12345",
            }),
          },
          harnessName: codexHarnessName,
          rootDirectory: cwd,
        });

        const output = yield* fs.readFileString(
          `${summary.runDirectory}/workspace/output.txt`,
        );
        const workerLog = yield* fs.readFileString(
          `${summary.runDirectory}/worker.log`,
        );
        const lastMessage = yield* fs.readFileString(
          `${summary.runDirectory}/codex-last-message.md`,
        );
        const harnessResult = yield* fs.readFileString(
          `${summary.runDirectory}/worker-result.json`,
        );
        const command = commands[0];

        assert.include(output, "true");
        assert.include(workerLog, "Codex stdout:");
        assert.include(lastMessage, "Codex completed");
        assert.include(harnessResult, '"harnessName": "codex"');
        assert.include(harnessResult, '"changedWorkspacePaths": [');
        assert.include(harnessResult, '"changed.txt"');
        assert.include(harnessResult, '"output.txt"');
        assert.include(harnessResult, '"exitCode": 0');
        assert.isDefined(command);

        if (command !== undefined) {
          assert.strictEqual(command.command, "codex-test");
          assert.strictEqual(command.cwd, `${summary.runDirectory}/workspace`);
          assert.strictEqual(command.timeoutMs, 12345);
          assert.deepEqual(command.args, [
            "exec",
            "--json",
            "--cd",
            `${summary.runDirectory}/workspace`,
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "--sandbox",
            "workspace-write",
            "--output-last-message",
            `${summary.runDirectory}/codex-last-message.md`,
            "-",
          ]);
          assert.include(command.stdin, "Run through Codex.");
          assert.include(command.stdin, "that artifact is ./output.txt");
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
            "if (process.env.GAIA_HARNESS_CONTRACT_VERSION !== '1') process.exit(8);",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness ${process.env.GAIA_RUN_ID}\\n`);",
            "writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/changed.txt`, 'changed by process harness\\n');",
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
        assert.include(harnessResult, '"changedWorkspacePaths": [');
        assert.include(harnessResult, '"changed.txt"');
        assert.include(harnessResult, '"output.txt"');
        assert.include(harnessResult, '"exitCode": 0');
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

    it.effect("fails with a typed error when Codex exits non-zero", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const commandRunner: CodexCommandRunner = () =>
          Effect.succeed({
            exitCode: 13,
            stderr: "Codex failed.\n",
            stdout: "",
          });
        yield* fs.writeFileString(specPath, "Run through failing Codex.\n");

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            codexHarness: {
              commandRunner,
              config: makeCodexHarnessConfig({ command: "codex-test" }),
            },
            harnessName: codexHarnessName,
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "CodexCommandFailed");
        }

        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        assert.strictEqual(status.state, "failed");
        assert.strictEqual(status.status, "failed");
      }),
    );

    it.effect("preflights GitHub publishing through the command seam", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Preflight this run.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const commands: Array<GitHubCommandInput> = [];

        const preflight = yield* preflightGitHubPublish(summary.runId, {
          commandRunner: githubPublishingRunner(commands),
          rootDirectory: cwd,
        });

        assert.strictEqual(preflight.status, "passed");
        assert.strictEqual(preflight.runId, summary.runId);
        assert.strictEqual(preflight.currentBranch, "main");
        assert.strictEqual(preflight.remoteName, "origin");
        assert.deepEqual(
          preflight.checks.map((check) => check.name),
          [
            "run-completed",
            "git-repository",
            "clean-worktree",
            "current-branch",
            "remote-configured",
            "base-branch",
            "base-synchronized",
            "github-auth",
          ],
        );
        assert.deepEqual(
          commands.map((command) => [command.command, command.args[0]]),
          [
            ["git", "rev-parse"],
            ["git", "status"],
            ["git", "rev-parse"],
            ["git", "remote"],
            ["git", "ls-remote"],
            ["git", "rev-parse"],
            ["gh", "auth"],
          ],
        );
      }),
    );

    it.effect("fails GitHub preflight when the base branch is unavailable", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Preflight missing base.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const error = yield* Effect.flip(
          preflightGitHubPublish(summary.runId, {
            commandRunner: githubPublishingRunner([], {
              respond: (input) =>
                input.command === "git" && input.args[0] === "ls-remote"
                  ? { exitCode: 2, stderr: "not found\n", stdout: "" }
                  : undefined,
            }),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "GitBaseBranchUnavailable");
          assert.isTrue(error.recoverable);
        }
      }),
    );

    it.effect("fails GitHub preflight when local HEAD is not the remote base", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Preflight out-of-sync base.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const error = yield* Effect.flip(
          preflightGitHubPublish(summary.runId, {
            commandRunner: githubPublishingRunner([], {
              respond: (input) =>
                input.command === "git" &&
                input.args.join(" ") === "rev-parse HEAD"
                  ? {
                      exitCode: 0,
                      stderr: "",
                      stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
                    }
                  : undefined,
            }),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "GitBaseBranchOutOfSync");
          assert.isFalse(error.recoverable);
        }
      }),
    );

    it.effect("previews an evidence-only GitHub PR without mutating commands", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Preview evidence PR.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const preview = yield* previewGitHubPublish(summary.runId, {
          commandRunner: githubPublishingRunner([]),
          rootDirectory: cwd,
        });

        assert.strictEqual(preview.status, "preview");
        assert.strictEqual(preview.mode, "evidence");
        assert.strictEqual(preview.sourceChanges, "evidence-only");
        assert.strictEqual(preview.branchName, `gaia/${summary.runId}`);
        assert.strictEqual(preview.evidencePath, `gaia-runs/${summary.runId}`);
        assert.deepEqual(
          preview.commands.map((command) => [
            command.command,
            command.args[0],
          ]),
          [
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

    it.effect("previews a workspace GitHub PR with source-staging commands", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Preview workspace PR.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const preview = yield* previewGitHubPublish(summary.runId, {
          commandRunner: githubPublishingRunner([]),
          mode: "workspace",
          rootDirectory: cwd,
        });

        assert.strictEqual(preview.mode, "workspace");
        assert.strictEqual(preview.sourceChanges, "workspace-required");
        assert.strictEqual(
          preview.branchName,
          `gaia/${summary.runId}-workspace`,
        );
        const sourceAddCommand = preview.commands.find(
          (command) =>
            command.command === "git" &&
            command.args.join(" ") === "add --all -- .",
        );
        const sourceDiffCommand = preview.commands.find(
          (command) =>
            command.command === "git" &&
            command.args.join(" ") === "diff --cached --quiet -- .",
        );
        if (sourceAddCommand === undefined) {
          assert.fail("Expected workspace preview to stage source changes.");
        }
        if (sourceDiffCommand === undefined) {
          assert.fail("Expected workspace preview to check staged changes.");
        }
        assert.deepEqual(
          preview.commands.map((command) => [
            command.command,
            command.args[0],
          ]),
          [
            ["git", "fetch"],
            ["git", "checkout"],
            ["git", "add"],
            ["git", "diff"],
            ["git", "add"],
            ["git", "commit"],
            ["git", "push"],
            ["gh", "pr"],
            ["git", "checkout"],
          ],
        );
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
        const runner = githubPublishingRunner(commands, {
          prUrl: "https://github.com/cill-i-am/gaia/pull/123\n",
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
            ["git", "rev-parse"],
            ["git", "status"],
            ["git", "rev-parse"],
            ["git", "remote"],
            ["git", "ls-remote"],
            ["git", "rev-parse"],
            ["gh", "auth"],
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
            commandRunner: githubPublishingRunner([], {
              respond: (input) =>
                input.command === "git" && input.args[0] === "status"
                  ? { exitCode: 0, stderr: "", stdout: "M README.md\n" }
                  : undefined,
            }),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "GitWorktreeDirty");
        }
      }),
    );

    it.effect("publishes workspace changes through the GitHub command seam", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const source = `${cwd}/repo`;
        const specPath = `${cwd}/spec.md`;
        yield* fs.makeDirectory(`${source}/src`, { recursive: true });
        yield* fs.writeFileString(`${source}/README.md`, "# Original\n");
        yield* fs.writeFileString(`${source}/src/index.ts`, "export {};\n");
        yield* fs.writeFileString(`${source}/src/removed.ts`, "export {};\n");
        yield* fs.writeFileString(specPath, "Publish workspace changes.\n");

        const summary = yield* runSpecFile(specPath, {
          rootDirectory: source,
          workspaceSource: localDirectoryWorkspaceSource(source),
        });
        const paths = yield* makeRunPaths(summary.runId, {
          rootDirectory: source,
        });
        yield* fs.writeFileString(`${paths.workspace}/README.md`, "# Changed\n");
        yield* fs.writeFileString(
          `${paths.workspace}/src/new-feature.ts`,
          "export const enabled = true;\n",
        );
        yield* fs.remove(`${paths.workspace}/src/removed.ts`);

        const commands: Array<GitHubCommandInput> = [];
        const runner = githubPublishingRunner(commands, {
          prUrl: "https://github.com/cill-i-am/gaia/pull/456\n",
        });

        const pr = yield* publishWorkspaceRunToGitHub(summary.runId, {
          commandRunner: runner,
          rootDirectory: source,
        });

        const readme = yield* fs.readFileString(`${source}/README.md`);
        const newFeatureExists = yield* fs.exists(
          `${source}/src/new-feature.ts`,
        );
        const outputArtifactExists = yield* fs.exists(`${source}/output.txt`);
        const removedFileExists = yield* fs.exists(`${source}/src/removed.ts`);
        const evidenceOutput = yield* fs.readFileString(
          `${source}/gaia-runs/${summary.runId}/workspace-output.txt`,
        );

        assert.strictEqual(pr.status, "opened");
        assert.strictEqual(pr.branchName, `gaia/${summary.runId}-workspace`);
        assert.strictEqual(
          pr.prUrl,
          "https://github.com/cill-i-am/gaia/pull/456",
        );
        assert.strictEqual(readme, "# Changed\n");
        assert.isTrue(newFeatureExists);
        assert.isFalse(removedFileExists);
        assert.isFalse(outputArtifactExists);
        assert.include(evidenceOutput, summary.runId);
        const sourceAddCommand = commands.find(
          (command) =>
            command.command === "git" &&
            command.args.join(" ") === "add --all -- .",
        );
        const sourceDiffCommand = commands.find(
          (command) =>
            command.command === "git" &&
            command.args.join(" ") === "diff --cached --quiet -- .",
        );
        if (sourceAddCommand === undefined) {
          assert.fail("Expected publish to stage source changes.");
        }
        if (sourceDiffCommand === undefined) {
          assert.fail("Expected publish to check staged source changes.");
        }
        assert.deepEqual(
          commands.map((command) => [command.command, command.args[0]]),
          [
            ["git", "rev-parse"],
            ["git", "status"],
            ["git", "rev-parse"],
            ["git", "remote"],
            ["git", "ls-remote"],
            ["git", "rev-parse"],
            ["gh", "auth"],
            ["git", "fetch"],
            ["git", "checkout"],
            ["git", "add"],
            ["git", "diff"],
            ["git", "add"],
            ["git", "commit"],
            ["git", "push"],
            ["gh", "pr"],
            ["git", "checkout"],
          ],
        );
      }),
    );

    it.effect("refuses a workspace PR when the workspace has no source changes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const source = `${cwd}/repo`;
        const specPath = `${cwd}/spec.md`;
        yield* fs.makeDirectory(source, { recursive: true });
        yield* fs.writeFileString(`${source}/README.md`, "# Same\n");
        yield* fs.writeFileString(specPath, "Publish unchanged workspace.\n");

        const summary = yield* runSpecFile(specPath, {
          rootDirectory: source,
          workspaceSource: localDirectoryWorkspaceSource(source),
        });
        const error = yield* Effect.flip(
          publishWorkspaceRunToGitHub(summary.runId, {
            commandRunner: githubPublishingRunner([], {
              respond: (input) => {
                if (
                  input.command === "git" &&
                  input.args.join(" ").startsWith("diff --cached --quiet")
                ) {
                  return { exitCode: 0, stderr: "", stdout: "" };
                }

                return undefined;
              },
            }),
            rootDirectory: source,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "WorkspacePrNoChanges");
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
        const watchState = parseGitHubCiWatchStateJson(
          JSON.parse(yield* fs.readFileString(recorded.watchStatePath)),
        );
        const events = yield* fs.readFileString(`${run.runDirectory}/events.jsonl`);
        const relativeSnapshotPath = recorded.snapshotPath.slice(
          run.runDirectory.length + 1,
        );

        assert.strictEqual(recorded.status, "passed");
        assert.strictEqual(recorded.attempts, 1);
        assert.isTrue(recorded.terminal);
        assert.include(snapshot, '"status": "passed"');
        assert.include(snapshot, '"attempts": 1');
        assert.strictEqual(watchState.nextAction, "complete");
        assert.strictEqual(watchState.lastSnapshotPath, relativeSnapshotPath);
        assert.include(events, '"type":"GITHUB_CHECKS_RECORDED"');
        assert.include(events, `"checksPath":"${relativeSnapshotPath}"`);
        assert.include(events, '"watchStatePath":"ci-watch-state.json"');
      }),
    );

    it.effect("refuses to record GitHub checks while the run store is locked", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Record checks while locked.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        yield* fs.makeDirectory(store.lock);

        const error = yield* Effect.flip(
          recordGitHubChecks(run.runId, "1", {
            commandRunner: recordingGitHubRunner([], () => ({
              exitCode: 0,
              stderr: "",
              stdout: "[]",
            })),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "RunStoreLocked");
        }
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

        const watchState = parseGitHubCiWatchStateJson(
          JSON.parse(yield* fs.readFileString(recorded.watchStatePath)),
        );
        assert.strictEqual(watchState.nextAction, "poll-again");
        assert.strictEqual(watchState.lastStatus, "pending");
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

function runIdFromCodexPrompt(prompt: string) {
  return prompt.match(/^Run ID: (.+)$/mu)?.[1] ?? "missing-run-id";
}

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

function githubPublishingRunner(
  commands: Array<GitHubCommandInput>,
  options: Readonly<{
    prUrl?: string;
    respond?: (
      input: GitHubCommandInput,
    ) => CommandExecutionResult | undefined;
  }> = {},
): GitHubCommandRunner {
  return recordingGitHubRunner(commands, (input) => {
    const response = options.respond?.(input);
    if (response !== undefined) {
      return response;
    }

    if (input.command === "git") {
      const args = input.args.join(" ");
      if (args === "rev-parse --is-inside-work-tree") {
        return { exitCode: 0, stderr: "", stdout: "true\n" };
      }
      if (args === "rev-parse --abbrev-ref HEAD") {
        return { exitCode: 0, stderr: "", stdout: "main\n" };
      }
      if (args === "rev-parse HEAD") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
        };
      }
      if (input.args[0] === "remote") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "https://github.com/cill-i-am/gaia.git\n",
        };
      }
      if (input.args[0] === "ls-remote") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main\n",
        };
      }
      if (args.startsWith("diff --cached --quiet")) {
        return { exitCode: 1, stderr: "", stdout: "" };
      }
    }

    if (input.command === "gh" && input.args[0] === "auth") {
      return { exitCode: 0, stderr: "", stdout: "Logged in to github.com\n" };
    }

    if (input.command === "gh" && input.args[0] === "pr") {
      return {
        exitCode: 0,
        stderr: "",
        stdout: options.prUrl ?? "https://github.com/cill-i-am/gaia/pull/1\n",
      };
    }

    return { exitCode: 0, stderr: "", stdout: "" };
  });
}
