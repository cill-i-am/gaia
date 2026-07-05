import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Exit, FileSystem, Schema } from "effect";
import { execPath } from "node:process";
import { parseRunEvent, parseRunId } from "@gaia/core";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import {
  BrowserEvidence,
  BrowserPageEvidence,
  BrowserScreenshotEvidence,
  parseBrowserEvidenceJson,
  type BrowserEvidenceCollector,
} from "./browser-evidence.js";
import {
  parseSkillBundleJson,
  type SkillInstallCommandInput,
  type SkillInstallCommandRunner,
} from "./skill-bundle.js";
import {
  makeCodexHarnessConfig,
  nodeCodexCommandRunner,
  type CodexCommandInput,
  type CodexCommandRunner,
} from "./codex-harness.js";
import {
  makeCodexReviewer,
  makeCodexReviewerConfig,
} from "./codex-reviewer.js";
import {
  doctor,
  type DoctorCommandRunner,
} from "./doctor.js";
import {
  commentGitHubPullRequest,
  coordinateGitHubPrLoop,
  createGitHubRemediationSpec,
  inspectGitHubChecks,
  parseGitHubCiWatchStateJson,
  parseGitHubPrFeedbackJson,
  parseGitHubPrLoopStateJson,
  preflightGitHubPublish,
  previewGitHubPublish,
  publishRunToGitHub,
  publishWorkspaceRunToGitHub,
  recordGitHubChecks,
  watchGitHubChecks,
  watchGitHubFeedback,
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
import { parsePreviewDeploymentJson } from "./preview-deployment.js";
import {
  parseLinearIssueGraphJson,
  recordLinearIssueGraph,
} from "./linear-issue-graph.js";
import {
  parseMergeDecisionJson,
  recordMergeDecision,
} from "./merge-decision.js";
import { localSkillManifestSource } from "./skill-manifest.js";
import {
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
} from "./reviewer.js";
import { parseReviewerSessionEvidenceJson } from "./reviewer-session-evidence.js";
import {
  localRunProfileSource,
  parseRunProfileJson,
} from "./run-profile.js";
import {
  collectBrowserEvidence,
  listRuns,
  resumeRun,
  runSpecFile,
  statusRun,
} from "./workflows.js";
import {
  listReadableRuns,
  readRunArtifact,
  readRunDetail,
  readRunEventLog,
} from "./run-read-model.js";
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
        const planReviewerSessionExists = yield* fs.exists(
          `${summary.runDirectory}/plan-reviewer-session.json`,
        );
        const evidenceReviewExists = yield* fs.exists(
          `${summary.runDirectory}/evidence-review.md`,
        );
        const evidenceReviewerSessionExists = yield* fs.exists(
          `${summary.runDirectory}/evidence-reviewer-session.json`,
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
        assert.isTrue(planReviewerSessionExists);
        assert.isTrue(evidenceReviewExists);
        assert.isTrue(evidenceReviewerSessionExists);
        assert.include(events, '"type":"REVIEW_COMPLETED"');
        assert.include(events, '"reviewerSessionEvidencePath"');
        assert.include(report, "worker-plan.md");
        assert.include(report, "plan-review.md");
        assert.include(report, "plan-reviewer-session.json");
        assert.include(report, "evidence-review.md");
        assert.include(report, "evidence-reviewer-session.json");
        assert.include(output, summary.runId);

        const planReviewerSession = parseReviewerSessionEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/plan-reviewer-session.json`,
            ),
          ),
        );
        assert.strictEqual(planReviewerSession.adapterKind, "deterministic");
        assert.strictEqual(planReviewerSession.sessionKind, "local");
        assert.strictEqual(planReviewerSession.phase, "plan");
        assert.strictEqual(planReviewerSession.decisionStatus, "approved");

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

    it.effect("lists readable runs with diagnostics for invalid run directories", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "List readable runs.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        yield* fs.makeDirectory(`${store.runsRoot}/run-not-a-valid-id`);

        const result = yield* listReadableRuns({ rootDirectory: cwd });

        assert.deepEqual(
          result.runs.map((run) => run.runId),
          [summary.runId],
        );
        assert.isDefined(
          result.diagnostics.find(
            (diagnostic) =>
              diagnostic.code === "InvalidRunDirectory" &&
              diagnostic.message ===
                "Run directory name is not a valid Gaia run id." &&
              diagnostic.pathSegment === "run-not-a-valid-id" &&
              diagnostic.recoverable,
          ),
        );
      }),
    );

    it.effect("reads run detail, event log, and allowlisted artifacts", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Read API contract.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const detail = yield* readRunDetail(summary.runId, { rootDirectory: cwd });
        const events = yield* readRunEventLog(summary.runId, {
          rootDirectory: cwd,
        });
        const report = yield* readRunArtifact(summary.runId, "report.json", {
          rootDirectory: cwd,
        });
        const blocked = yield* Effect.exit(
          readRunArtifact(summary.runId, "../events.jsonl", {
            rootDirectory: cwd,
          }),
        );

        assert.strictEqual(detail.runId, summary.runId);
        assert.strictEqual(detail.state, "completed");
        assert.strictEqual(events.events.length, detail.eventCount);
        assert.strictEqual(report.encoding, "json");
        assert.strictEqual(report.artifactName, "report.json");
        assert.isTrue(Exit.isFailure(blocked));
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

    it.effect("reports a healthy local doctor result", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });

        const summary = yield* doctor({
          browserInspector: () => Effect.succeed(true),
          commandRunner: passingDoctorCommandRunner,
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.status, "healthy");
        assert.deepEqual(
          summary.checks.map((check) => check.status),
          ["passed", "passed", "passed", "passed", "passed"],
        );
      }),
    );

    it.effect("reports local doctor warnings without failing the command", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });

        const summary = yield* doctor({
          browserInspector: () => Effect.succeed(false),
          commandRunner: warningDoctorCommandRunner,
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.status, "warnings");
        assert.deepEqual(
          summary.checks.map((check) => [check.name, check.status]),
          [
            ["gaia-store-writable", "passed"],
            ["git-repository", "warning"],
            ["gh-auth", "warning"],
            ["codex-cli", "warning"],
            ["playwright-browser", "warning"],
          ],
        );
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
        const installCommands: Array<SkillInstallCommandInput> = [];
        const skillInstaller = {
          commandRunner: installingSkillRunner(
            fs,
            installCommands,
            "skills/coding-standards",
          ),
        };
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
          skillInstaller,
          skillManifestSource: localSkillManifestSource(manifestPath),
        });

        const skillManifest = yield* fs.readFileString(
          `${summary.runDirectory}/skill-manifest.json`,
        );
        const skillBundle = parseSkillBundleJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/skill-bundle.json`,
            ),
          ),
        );
        const reportJson = yield* fs.readFileString(
          `${summary.runDirectory}/report.json`,
        );
        const reportMarkdown = yield* fs.readFileString(summary.reportPath);

        assert.include(skillManifest, '"name": "coding-standards"');
        assert.strictEqual(skillBundle.status, "ready");
        assert.strictEqual(skillBundle.skills[0]?.resolution, "installed");
        assert.include(
          skillBundle.skills[0]?.resolvedPath,
          "/skill-sources/0-coding-standards/repository/skills/coding-standards",
        );
        assert.deepEqual(
          installCommands.map((command) => command.args),
          [
            [
              "clone",
              "https://github.com/cillianbarron/skills.git",
              `${summary.runDirectory}/skill-sources/0-coding-standards/repository`,
            ],
            [
              "-C",
              `${summary.runDirectory}/skill-sources/0-coding-standards/repository`,
              "checkout",
              "abc123",
            ],
          ],
        );
        assert.include(reportJson, '"selectedSkills": [');
        assert.include(reportJson, '"coding-standards"');
        assert.include(reportMarkdown, "- coding-standards");
        assert.include(reportMarkdown, "skill-manifest.json");
        assert.include(reportMarkdown, "skill-bundle.json");
      }),
    );

    it.effect("fails before worker execution when external skill install fails", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const manifestPath = `${cwd}/skills.json`;
        yield* fs.writeFileString(specPath, "Run with broken skills.\n");
        yield* fs.writeFileString(
          manifestPath,
          `${JSON.stringify({
            skills: [
              {
                commit: "abc123",
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
            skillInstaller: {
              commandRunner: () =>
                Effect.succeed({
                  exitCode: 128,
                  stderr: "repository not found\n",
                  stdout: "",
                }),
            },
            skillManifestSource: localSkillManifestSource(manifestPath),
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "SkillBundleInstallCommandFailed");
        }

        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        assert.strictEqual(status.state, "failed");
      }),
    );

    it.effect("resolves local skills from a pinned skill manifest", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const manifestPath = `${cwd}/skills.json`;
        const skillDirectory = `${cwd}/skills/coding-standards`;
        yield* fs.makeDirectory(skillDirectory, { recursive: true });
        yield* fs.writeFileString(`${skillDirectory}/SKILL.md`, "# Skill\n");
        yield* fs.writeFileString(specPath, "Run with local skills.\n");
        yield* fs.writeFileString(
          manifestPath,
          `${JSON.stringify(
            {
              skills: [
                {
                  commit: "abc123",
                  name: "coding-standards",
                  sourcePath: "skills/coding-standards",
                  sourceRepository: "local",
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

        const skillBundle = parseSkillBundleJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/skill-bundle.json`,
            ),
          ),
        );

        assert.strictEqual(skillBundle.status, "ready");
        assert.strictEqual(skillBundle.skills[0]?.resolution, "local");
        assert.strictEqual(skillBundle.skills[0]?.resolvedPath, skillDirectory);
      }),
    );

    it.effect("rejects missing local skill sources", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const manifestPath = `${cwd}/skills.json`;
        yield* fs.writeFileString(specPath, "Run with missing local skills.\n");
        yield* fs.writeFileString(
          manifestPath,
          `${JSON.stringify({
            skills: [
              {
                commit: "abc123",
                name: "coding-standards",
                sourcePath: "skills/coding-standards",
                sourceRepository: "local",
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
          assert.strictEqual(error.code, "SkillBundleSourceUnavailable");
        }

        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        assert.strictEqual(status.state, "failed");
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

    it.effect("writes the default run profile as run evidence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Run with default profile.\n");

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const profile = parseRunProfileJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/run-profile.json`),
          ),
        );
        const report = yield* fs.readFileString(
          `${summary.runDirectory}/report.md`,
        );

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(profile.name, "default");
        assert.strictEqual(profile.checks.browserEvidence, "optional");
        assert.include(report, "run-profile.json");
      }),
    );

    it.effect("collects browser evidence for a completed run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Run with collected browser evidence.\n");

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const record = yield* collectBrowserEvidence(
          summary.runId,
          "http://localhost:3000",
          {
            browserEvidenceCollector: collectedBrowserEvidenceCollector,
            rootDirectory: cwd,
          },
        );
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/browser-evidence.json`,
            ),
          ),
        );
        const events = yield* fs.readFileString(
          `${summary.runDirectory}/events.jsonl`,
        );
        const resumed = yield* resumeRun(summary.runId, { rootDirectory: cwd });

        assert.strictEqual(record.status, "collected");
        assert.strictEqual(record.evidencePath, "browser-evidence.json");
        assert.strictEqual(record.pages[0]?.screenshots[0]?.path, "browser/page-1.png");
        assert.strictEqual(browserEvidence.status, "collected");
        assert.strictEqual(browserEvidence.pages[0]?.url, "http://localhost:3000/");
        assert.include(events, '"type":"BROWSER_EVIDENCE_RECORDED"');
        assert.include(events, '"targetUrl":"http://localhost:3000"');
        assert.strictEqual(resumed.status, "completed");
      }),
    );

    it.effect("records failed browser capture as browser evidence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Run with failed browser evidence.\n");

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const record = yield* collectBrowserEvidence(
          summary.runId,
          "http://localhost:3000",
          {
            browserEvidenceCollector: failedBrowserEvidenceCollector,
            rootDirectory: cwd,
          },
        );
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/browser-evidence.json`,
            ),
          ),
        );
        const events = yield* fs.readFileString(
          `${summary.runDirectory}/events.jsonl`,
        );

        assert.strictEqual(record.status, "failed");
        assert.deepEqual(record.pages, []);
        assert.strictEqual(browserEvidence.status, "failed");
        assert.include(browserEvidence.notes.join("\n"), "browser unavailable");
        assert.include(events, '"status":"failed"');
      }),
    );

    it.effect("collects browser evidence during a run before evidence review", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          specPath,
          "Run with integrated browser evidence.\n",
        );

        const summary = yield* runSpecFile(specPath, {
          browserEvidenceCollector: collectedBrowserEvidenceCollector,
          browserEvidenceTargetUrl: "http://localhost:3000",
          rootDirectory: cwd,
        });
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/browser-evidence.json`,
            ),
          ),
        );
        const evidenceReview = yield* fs.readFileString(
          `${summary.runDirectory}/evidence-review.md`,
        );
        const events = yield* readRunEvents(fs, summary.runDirectory);
        const browserEventIndex = events.findIndex(
          (event) => event.type === "BROWSER_EVIDENCE_RECORDED",
        );
        const evidenceReviewStartedIndex = events.findIndex(
          (event) =>
            event.type === "REVIEW_STARTED" &&
            event.payload["phase"] === "evidence",
        );

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(browserEvidence.status, "collected");
        assert.strictEqual(
          browserEvidence.pages[0]?.url,
          "http://localhost:3000/",
        );
        assert.include(
          evidenceReview,
          "Browser evidence collected for 1 page(s).",
        );
        assert.isTrue(browserEventIndex >= 0);
        assert.isTrue(evidenceReviewStartedIndex >= 0);
        assert.isTrue(browserEventIndex < evidenceReviewStartedIndex);
      }),
    );

    it.effect("keeps the run completed when integrated browser capture fails", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          specPath,
          "Run with failed integrated browser evidence.\n",
        );

        const summary = yield* runSpecFile(specPath, {
          browserEvidenceCollector: failedBrowserEvidenceCollector,
          browserEvidenceTargetUrl: "http://localhost:3000",
          rootDirectory: cwd,
        });
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/browser-evidence.json`,
            ),
          ),
        );
        const evidenceReview = yield* fs.readFileString(
          `${summary.runDirectory}/evidence-review.md`,
        );
        const status = yield* statusRun(summary.runId, { rootDirectory: cwd });

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(status.status, "completed");
        assert.strictEqual(browserEvidence.status, "failed");
        assert.include(browserEvidence.notes.join("\n"), "browser unavailable");
        assert.include(
          evidenceReview,
          "warning: Browser evidence failed for 0 page(s).",
        );
      }),
    );

    it.effect("completes when required browser evidence is collected", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          specPath,
          "Run with required browser evidence.\n",
        );

        const summary = yield* runSpecFile(specPath, {
          browserEvidenceCollector: collectedBrowserEvidenceCollector,
          browserEvidenceRequirement: "required",
          browserEvidenceTargetUrl: "http://localhost:3000",
          rootDirectory: cwd,
        });
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/browser-evidence.json`,
            ),
          ),
        );

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(browserEvidence.status, "collected");
      }),
    );

    it.effect("uses a run profile browser target URL", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const profilePath = yield* writeFrontendRunProfile(fs, cwd);
        yield* fs.writeFileString(
          specPath,
          "Run with profile-required browser evidence.\n",
        );

        const summary = yield* runSpecFile(specPath, {
          browserEvidenceCollector: collectedBrowserEvidenceCollector,
          rootDirectory: cwd,
          runProfileSource: localRunProfileSource(profilePath),
        });
        const profile = parseRunProfileJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/run-profile.json`),
          ),
        );
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/browser-evidence.json`,
            ),
          ),
        );

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(profile.name, "frontend");
        assert.strictEqual(profile.browser?.targetUrl, "http://localhost:3000");
        assert.strictEqual(profile.checks.browserEvidence, "required");
        assert.strictEqual(browserEvidence.status, "collected");
        assert.strictEqual(browserEvidence.pages[0]?.url, "http://localhost:3000/");
      }),
    );

    it.effect("uses an explicit browser target URL before a profile target URL", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const profilePath = yield* writeFrontendRunProfile(fs, cwd);
        yield* fs.writeFileString(
          specPath,
          "Run with explicit browser evidence URL.\n",
        );

        const summary = yield* runSpecFile(specPath, {
          browserEvidenceCollector: collectedBrowserEvidenceCollector,
          browserEvidenceTargetUrl: "http://localhost:4000",
          rootDirectory: cwd,
          runProfileSource: localRunProfileSource(profilePath),
        });
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/browser-evidence.json`,
            ),
          ),
        );
        const events = yield* fs.readFileString(
          `${summary.runDirectory}/events.jsonl`,
        );

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(browserEvidence.status, "collected");
        assert.strictEqual(browserEvidence.pages[0]?.url, "http://localhost:4000/");
        assert.include(events, '"targetUrl":"http://localhost:4000"');
      }),
    );

    it.effect("uses a browser target URL declared by the process harness", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const scriptPath = `${cwd}/process-harness.mjs`;
        yield* fs.writeFileString(
          specPath,
          "Run with process-discovered browser evidence URL.\n",
        );
        yield* fs.writeFileString(
          scriptPath,
          [
            "import { writeFileSync } from 'node:fs';",
            "if (process.env.GAIA_RUN_ID === undefined) { throw new Error('missing run id'); }",
            "if (process.env.GAIA_WORKSPACE_OUTPUT_PATH === undefined) { throw new Error('missing output'); }",
            "if (process.env.GAIA_WORKER_RESULT_PATH === undefined) { throw new Error('missing result'); }",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness output ${process.env.GAIA_RUN_ID}\\n`);",
            "writeFileSync(process.env.GAIA_WORKER_RESULT_PATH, JSON.stringify({ browserTargetUrl: 'http://localhost:4100' }));",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, {
          browserEvidenceCollector: collectedBrowserEvidenceCollector,
          browserEvidenceRequirement: "required",
          harnessName: parseHarnessName("process"),
          processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
          rootDirectory: cwd,
        });
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/browser-evidence.json`,
            ),
          ),
        );
        const harnessResult = yield* fs.readFileString(
          `${summary.runDirectory}/worker-result.json`,
        );
        const events = yield* fs.readFileString(
          `${summary.runDirectory}/events.jsonl`,
        );

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(browserEvidence.status, "collected");
        assert.strictEqual(browserEvidence.pages[0]?.url, "http://localhost:4100/");
        assert.include(harnessResult, '"browserTargetUrl": "http://localhost:4100"');
        assert.include(events, '"browserTargetUrl":"http://localhost:4100"');
        assert.include(events, '"targetUrl":"http://localhost:4100"');
      }),
    );

    it.effect("uses a preview deployment URL before a direct harness browser target", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const scriptPath = `${cwd}/process-harness.mjs`;
        yield* fs.writeFileString(
          specPath,
          "Run with process-discovered preview deployment URL.\n",
        );
        yield* fs.writeFileString(
          scriptPath,
          [
            "import { writeFileSync } from 'node:fs';",
            "if (process.env.GAIA_RUN_ID === undefined) { throw new Error('missing run id'); }",
            "if (process.env.GAIA_WORKSPACE_OUTPUT_PATH === undefined) { throw new Error('missing output'); }",
            "if (process.env.GAIA_WORKER_RESULT_PATH === undefined) { throw new Error('missing result'); }",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness output ${process.env.GAIA_RUN_ID}\\n`);",
            "writeFileSync(process.env.GAIA_WORKER_RESULT_PATH, JSON.stringify({ browserTargetUrl: 'http://localhost:4100', previewDeploymentUrl: 'http://localhost:4200' }));",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, {
          browserEvidenceCollector: collectedBrowserEvidenceCollector,
          browserEvidenceRequirement: "required",
          harnessName: parseHarnessName("process"),
          processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
          rootDirectory: cwd,
        });
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/browser-evidence.json`,
            ),
          ),
        );
        const previewDeployment = parsePreviewDeploymentJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/preview-deployment.json`,
            ),
          ),
        );
        const harnessResult = yield* fs.readFileString(
          `${summary.runDirectory}/worker-result.json`,
        );
        const report = yield* fs.readFileString(
          `${summary.runDirectory}/report.md`,
        );
        const events = yield* fs.readFileString(
          `${summary.runDirectory}/events.jsonl`,
        );

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(browserEvidence.status, "collected");
        assert.strictEqual(browserEvidence.pages[0]?.url, "http://localhost:4200/");
        assert.strictEqual(previewDeployment.status, "available");
        assert.strictEqual(previewDeployment.url, "http://localhost:4200");
        assert.include(harnessResult, '"previewDeploymentUrl": "http://localhost:4200"');
        assert.include(report, "preview-deployment.json");
        assert.include(events, '"type":"PREVIEW_DEPLOYMENT_RECORDED"');
        assert.include(events, '"url":"http://localhost:4200"');
        assert.include(events, '"targetUrl":"http://localhost:4200"');
      }),
    );

    it.effect("uses an explicit browser target URL before a preview deployment URL", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const scriptPath = `${cwd}/process-harness.mjs`;
        yield* fs.writeFileString(
          specPath,
          "Run with explicit URL and preview deployment URL.\n",
        );
        yield* fs.writeFileString(
          scriptPath,
          [
            "import { writeFileSync } from 'node:fs';",
            "if (process.env.GAIA_RUN_ID === undefined) { throw new Error('missing run id'); }",
            "if (process.env.GAIA_WORKSPACE_OUTPUT_PATH === undefined) { throw new Error('missing output'); }",
            "if (process.env.GAIA_WORKER_RESULT_PATH === undefined) { throw new Error('missing result'); }",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness output ${process.env.GAIA_RUN_ID}\\n`);",
            "writeFileSync(process.env.GAIA_WORKER_RESULT_PATH, JSON.stringify({ previewDeploymentUrl: 'http://localhost:4200' }));",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, {
          browserEvidenceCollector: collectedBrowserEvidenceCollector,
          browserEvidenceRequirement: "required",
          browserEvidenceTargetUrl: "http://localhost:4300",
          harnessName: parseHarnessName("process"),
          processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
          rootDirectory: cwd,
        });
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/browser-evidence.json`,
            ),
          ),
        );
        const previewDeployment = parsePreviewDeploymentJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/preview-deployment.json`,
            ),
          ),
        );
        const events = yield* fs.readFileString(
          `${summary.runDirectory}/events.jsonl`,
        );

        assert.strictEqual(summary.status, "completed");
        assert.strictEqual(browserEvidence.pages[0]?.url, "http://localhost:4300/");
        assert.strictEqual(previewDeployment.status, "available");
        assert.strictEqual(previewDeployment.url, "http://localhost:4200");
        assert.include(events, '"targetUrl":"http://localhost:4300"');
      }),
    );

    it.effect("rejects invalid preview deployment URLs from the process harness", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const scriptPath = `${cwd}/process-harness.mjs`;
        yield* fs.writeFileString(
          specPath,
          "Run with an invalid preview deployment URL.\n",
        );
        yield* fs.writeFileString(
          scriptPath,
          [
            "import { writeFileSync } from 'node:fs';",
            "if (process.env.GAIA_RUN_ID === undefined) { throw new Error('missing run id'); }",
            "if (process.env.GAIA_WORKSPACE_OUTPUT_PATH === undefined) { throw new Error('missing output'); }",
            "if (process.env.GAIA_WORKER_RESULT_PATH === undefined) { throw new Error('missing result'); }",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness output ${process.env.GAIA_RUN_ID}\\n`);",
            "writeFileSync(process.env.GAIA_WORKER_RESULT_PATH, JSON.stringify({ previewDeploymentUrl: 'not-a-url' }));",
          ].join("\n"),
        );

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            browserEvidenceRequirement: "required",
            harnessName: parseHarnessName("process"),
            processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
            rootDirectory: cwd,
          }),
        );
        const status = yield* statusRun(undefined, { rootDirectory: cwd });

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "ProcessHarnessDeclarationInvalid");
          assert.isTrue(error.recoverable);
        }
        assert.strictEqual(status.state, "failed");
      }),
    );

    it.effect("fails a required browser evidence run after worker completion when no target is found", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const profilePath = yield* writeFrontendRunProfile(fs, cwd, {
          targetUrl: undefined,
        });
        yield* fs.writeFileString(
          specPath,
          "Run with missing profile-required browser URL.\n",
        );

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            rootDirectory: cwd,
            runProfileSource: localRunProfileSource(profilePath),
          }),
        );
        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        const events = yield* readRunEvents(fs, status.runDirectory);
        const workerCompletedIndex = events.findIndex(
          (event) => event.type === "WORKER_COMPLETED",
        );
        const verificationCompletedIndex = events.findIndex(
          (event) => event.type === "VERIFICATION_COMPLETED",
        );
        const runFailedIndex = events.findIndex(
          (event) => event.type === "RUN_FAILED",
        );
        const evidenceReviewStartedIndex = events.findIndex(
          (event) =>
            event.type === "REVIEW_STARTED" &&
            event.payload["phase"] === "evidence",
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "BrowserEvidenceTargetRequired");
          assert.isFalse(error.recoverable);
        }
        assert.strictEqual(status.state, "failed");
        assert.isTrue(workerCompletedIndex >= 0);
        assert.isTrue(verificationCompletedIndex >= 0);
        assert.isTrue(runFailedIndex >= 0);
        assert.isTrue(verificationCompletedIndex < runFailedIndex);
        assert.strictEqual(evidenceReviewStartedIndex, -1);
      }),
    );

    it.effect("rejects invalid run profiles before worker execution", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const profilePath = `${cwd}/invalid-profile.json`;
        yield* fs.writeFileString(specPath, "Run with invalid profile.\n");
        yield* fs.writeFileString(
          profilePath,
          `${JSON.stringify({
            checks: { browserEvidence: "sometimes" },
            name: "frontend",
            version: 1,
          })}\n`,
        );

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            rootDirectory: cwd,
            runProfileSource: localRunProfileSource(profilePath),
          }),
        );
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        const lockExists = yield* fs.exists(store.lock);

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "RunProfileInvalid");
          assert.isFalse(error.recoverable);
        }
        assert.isFalse(lockExists);
      }),
    );

    it.effect("fails a required browser evidence run after worker completion without a target URL", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          specPath,
          "Run without required browser URL.\n",
        );

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            browserEvidenceRequirement: "required",
            rootDirectory: cwd,
          }),
        );
        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        const events = yield* readRunEvents(fs, status.runDirectory);
        const workerCompletedIndex = events.findIndex(
          (event) => event.type === "WORKER_COMPLETED",
        );
        const runFailedIndex = events.findIndex(
          (event) => event.type === "RUN_FAILED",
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "BrowserEvidenceTargetRequired");
          assert.isFalse(error.recoverable);
        }
        assert.strictEqual(status.state, "failed");
        assert.isTrue(workerCompletedIndex >= 0);
        assert.isTrue(runFailedIndex > workerCompletedIndex);
      }),
    );

    it.effect("fails the run when required browser capture fails", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          specPath,
          "Run with required failed browser evidence.\n",
        );

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            browserEvidenceCollector: failedBrowserEvidenceCollector,
            browserEvidenceRequirement: "required",
            browserEvidenceTargetUrl: "http://localhost:3000",
            rootDirectory: cwd,
          }),
        );
        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        const browserEvidence = parseBrowserEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${status.runDirectory}/browser-evidence.json`,
            ),
          ),
        );
        const events = yield* readRunEvents(fs, status.runDirectory);
        const browserEventIndex = events.findIndex(
          (event) => event.type === "BROWSER_EVIDENCE_RECORDED",
        );
        const runFailedIndex = events.findIndex(
          (event) => event.type === "RUN_FAILED",
        );
        const evidenceReviewStartedIndex = events.findIndex(
          (event) =>
            event.type === "REVIEW_STARTED" &&
            event.payload["phase"] === "evidence",
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "RequiredBrowserEvidenceFailed");
          assert.isTrue(error.recoverable);
        }
        assert.strictEqual(status.state, "failed");
        assert.strictEqual(status.status, "failed");
        assert.strictEqual(browserEvidence.status, "failed");
        assert.isTrue(browserEventIndex >= 0);
        assert.isTrue(runFailedIndex >= 0);
        assert.isTrue(browserEventIndex < runFailedIndex);
        assert.strictEqual(evidenceReviewStartedIndex, -1);
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
        const manifestPath = `${cwd}/skills.json`;
        const skillDirectory = `${cwd}/skills/coding-standards`;
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
        yield* fs.makeDirectory(skillDirectory, { recursive: true });
        yield* fs.writeFileString(`${skillDirectory}/SKILL.md`, "# Skill\n");
        yield* fs.writeFileString(
          manifestPath,
          `${JSON.stringify({
            skills: [
              {
                commit: "abc123",
                name: "coding-standards",
                sourcePath: "skills/coding-standards",
                sourceRepository: "local",
              },
            ],
          })}\n`,
        );
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
          skillManifestSource: localSkillManifestSource(manifestPath),
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
          assert.include(command.stdin, "Skill bundle JSON:");
          assert.include(command.stdin, skillDirectory);
        }
      }),
    );

    it.effect("runs the Codex reviewer through the workflow seam", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const commands: Array<CodexCommandInput> = [];
        const commandRunner: CodexCommandRunner = (input) =>
          Effect.gen(function* () {
            commands.push(input);
            const outputLastMessagePath = yield* codexLastMessagePath(input);
            yield* fs.writeFileString(
              outputLastMessagePath,
              [
                "Status: approved",
                `Summary: Codex reviewer approved ${codexReviewPhaseFromPrompt(input.stdin)}.`,
                "",
                "- The reviewed artifacts are coherent.",
              ].join("\n"),
            );

            return {
              exitCode: 0,
              stderr: "",
              stdout: '{"type":"review.completed"}\n',
            };
          });
        yield* fs.writeFileString(specPath, "Run with Codex review.\n");

        const summary = yield* runSpecFile(specPath, {
          reviewer: makeCodexReviewer({
            commandRunner,
            config: makeCodexReviewerConfig({
              command: "codex-review-test",
              timeoutMs: "12345",
            }),
          }),
          rootDirectory: cwd,
        });

        const planReview = yield* fs.readFileString(
          `${summary.runDirectory}/plan-review.md`,
        );
        const evidenceReview = yield* fs.readFileString(
          `${summary.runDirectory}/evidence-review.md`,
        );
        const planReviewerLog = yield* fs.readFileString(
          `${summary.runDirectory}/plan-codex-reviewer.log`,
        );
        const planReviewerSession = parseReviewerSessionEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/plan-reviewer-session.json`,
            ),
          ),
        );

        assert.lengthOf(commands, 2);
        for (const command of commands) {
          assert.strictEqual(command.command, "codex-review-test");
          assert.strictEqual(command.cwd, summary.runDirectory);
          assert.strictEqual(command.timeoutMs, 12345);
          assert.deepEqual(command.args, [
            "exec",
            "--json",
            "--cd",
            summary.runDirectory,
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "--sandbox",
            "read-only",
            "--output-last-message",
            `${summary.runDirectory}/${codexReviewPhaseFromPrompt(command.stdin)}-codex-reviewer-last-message.md`,
            "-",
          ]);
          assert.include(
            command.stdin,
            "Do not write, edit, delete, move, or create files.",
          );
          assert.include(command.stdin, "Status: approved");
          assert.include(command.stdin, "Summary: ");
          if (codexReviewPhaseFromPrompt(command.stdin) === "evidence") {
            assert.include(command.stdin, "Browser evidence JSON:");
          }
        }
        assert.include(planReview, "Reviewer: codex-reviewer");
        assert.include(
          planReview,
          "Session Evidence: plan-reviewer-session.json",
        );
        assert.include(planReview, "Codex reviewer approved plan.");
        assert.include(evidenceReview, "Codex reviewer approved evidence.");
        assert.include(planReviewerLog, "Codex reviewer stdout:");
        assert.strictEqual(planReviewerSession.adapterKind, "codex-cli");
        assert.strictEqual(planReviewerSession.command, "codex-review-test");
        assert.strictEqual(planReviewerSession.cwd, summary.runDirectory);
        assert.strictEqual(planReviewerSession.decisionStatus, "approved");
        assert.strictEqual(
          planReviewerSession.transcriptPath,
          "plan-codex-reviewer-last-message.md",
        );
        assert.strictEqual(
          planReviewerSession.logPath,
          "plan-codex-reviewer.log",
        );
      }),
    );

    it.effect("fails before worker execution when the Codex plan reviewer blocks", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const commands: Array<CodexCommandInput> = [];
        const commandRunner: CodexCommandRunner = (input) =>
          Effect.gen(function* () {
            commands.push(input);
            const outputLastMessagePath = yield* codexLastMessagePath(input);
            yield* fs.writeFileString(
              outputLastMessagePath,
              [
                "Status: blocked",
                "Summary: Codex reviewer found an unsafe plan.",
                "",
                "- Do not proceed.",
              ].join("\n"),
            );

            return { exitCode: 0, stderr: "", stdout: "" };
          });
        yield* fs.writeFileString(specPath, "Block this run.\n");

        const error = yield* Effect.flip(
          runSpecFile(specPath, {
            reviewer: makeCodexReviewer({
              commandRunner,
              config: makeCodexReviewerConfig({
                command: "codex-review-test",
              }),
            }),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "ReviewBlocked");
        }

        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        const events = yield* fs.readFileString(
          `${status.runDirectory}/events.jsonl`,
        );
        const planReviewerSession = parseReviewerSessionEvidenceJson(
          JSON.parse(
            yield* fs.readFileString(
              `${status.runDirectory}/plan-reviewer-session.json`,
            ),
          ),
        );
        assert.lengthOf(commands, 1);
        assert.strictEqual(status.state, "failed");
        assert.include(events, '"status":"blocked"');
        assert.strictEqual(planReviewerSession.decisionStatus, "blocked");
        assert.notInclude(events, '"type":"WORKER_STARTED"');
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
            "if (process.env.GAIA_SKILL_BUNDLE_PATH === undefined) process.exit(9);",
            "if (process.env.GAIA_RESOLVED_SKILL_PATHS_JSON !== '[]') process.exit(10);",
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

    it.effect("starts a CI watch and points failed checks at the fix action", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Watch failed checks.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const watched = yield* watchGitHubChecks(run.runId, {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              {
                link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                name: "test",
                state: "FAILURE",
                workflow: "CI",
              },
            ]),
          })),
          pullRequest: "1",
          rootDirectory: cwd,
        });
        const watchState = parseGitHubCiWatchStateJson(
          JSON.parse(yield* fs.readFileString(watched.watchStatePath)),
        );

        assert.strictEqual(watched.status, "failed");
        assert.strictEqual(watched.source, "recorded");
        assert.isTrue(watched.terminal);
        assert.strictEqual(watched.nextAction, "fix-failed-checks");
        assert.strictEqual(watched.failedChecks.length, 1);
        assert.strictEqual(watched.failedChecks[0]?.name, "test");
        assert.strictEqual(watchState.nextAction, "fix-failed-checks");
        assert.strictEqual(watchState.lastStatus, "failed");
      }),
    );

    it.effect("resumes a pending CI watch from stored state", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Resume pending checks.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });
        yield* recordGitHubChecks(run.runId, "1", {
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
          maxAttempts: 1,
          pollInterval: "0 millis",
          rootDirectory: cwd,
          waitForTerminal: true,
        });

        const watched = yield* watchGitHubChecks(run.runId, {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              {
                link: "https://github.com/cill-i-am/gaia/actions/runs/2",
                name: "test",
                state: "SUCCESS",
                workflow: "CI",
              },
            ]),
          })),
          rootDirectory: cwd,
        });
        const events = yield* readRunEvents(fs, run.runDirectory);
        const checkEvents = events.filter(
          (event) => event.type === "GITHUB_CHECKS_RECORDED",
        );

        assert.strictEqual(watched.status, "passed");
        assert.strictEqual(watched.source, "recorded");
        assert.strictEqual(watched.pr, "1");
        assert.strictEqual(watched.nextAction, "complete");
        assert.strictEqual(checkEvents.length, 2);
      }),
    );

    it.effect("does not poll GitHub again for terminal CI watch state", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Do not rewatch terminal checks.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });
        yield* recordGitHubChecks(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify([
              {
                link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                name: "test",
                state: "SUCCESS",
                workflow: "CI",
              },
            ]),
          })),
          rootDirectory: cwd,
        });
        let calls = 0;

        const watched = yield* watchGitHubChecks(run.runId, {
          commandRunner: recordingGitHubRunner([], () => {
            calls += 1;
            return {
              exitCode: 0,
              stderr: "",
              stdout: "[]",
            };
          }),
          rootDirectory: cwd,
        });

        assert.strictEqual(watched.status, "passed");
        assert.strictEqual(watched.source, "already-terminal");
        assert.strictEqual(watched.nextAction, "complete");
        assert.strictEqual(calls, 0);
      }),
    );

    it.effect("records PR feedback and points changes requested at review fixes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Record PR feedback.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const feedback = yield* watchGitHubFeedback(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              prFeedbackView({
                comments: [
                  {
                    author: { login: "reviewer" },
                    body: "Could you simplify this?",
                    createdAt: "2026-07-05T10:00:00Z",
                    url: "https://github.com/cill-i-am/gaia/pull/1#issuecomment-1",
                  },
                ],
                latestReviews: [
                  {
                    author: { login: "reviewer" },
                    body: "Needs work.",
                    state: "CHANGES_REQUESTED",
                    submittedAt: "2026-07-05T10:01:00Z",
                    url: "https://github.com/cill-i-am/gaia/pull/1#pullrequestreview-1",
                  },
                ],
                reviewDecision: "CHANGES_REQUESTED",
              }),
            ),
          })),
          rootDirectory: cwd,
        });

        const recorded = parseGitHubPrFeedbackJson(
          JSON.parse(yield* fs.readFileString(feedback.feedbackPath)),
        );
        const events = yield* fs.readFileString(`${run.runDirectory}/events.jsonl`);

        assert.strictEqual(feedback.status, "changes-requested");
        assert.strictEqual(feedback.nextAction, "address-review-comments");
        assert.strictEqual(feedback.commentCount, 1);
        assert.strictEqual(feedback.reviewCount, 1);
        assert.strictEqual(recorded.status, "changes-requested");
        assert.include(
          recorded.notes.join("\n"),
          "does not expose unresolved review-thread state",
        );
        assert.include(events, '"type":"GITHUB_FEEDBACK_RECORDED"');
        assert.include(events, '"feedbackPath":"github-feedback.json"');
        assert.include(events, '"nextAction":"address-review-comments"');
      }),
    );

    it.effect("classifies PR comments without changes requested as response work", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Record PR comments.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const feedback = yield* watchGitHubFeedback(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              prFeedbackView({
                comments: [
                  {
                    author: { login: "reviewer" },
                    body: "Question on naming.",
                  },
                ],
              }),
            ),
          })),
          rootDirectory: cwd,
        });

        assert.strictEqual(feedback.status, "comments");
        assert.strictEqual(feedback.nextAction, "respond-to-comments");
      }),
    );

    it.effect("classifies required reviews as awaiting review", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Record awaiting review.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const feedback = yield* watchGitHubFeedback(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              prFeedbackView({
                reviewDecision: "REVIEW_REQUIRED",
                reviewRequests: [{ requestedReviewer: "team" }],
              }),
            ),
          })),
          rootDirectory: cwd,
        });

        assert.strictEqual(feedback.status, "awaiting-review");
        assert.strictEqual(feedback.nextAction, "await-review");
        assert.strictEqual(feedback.reviewRequestCount, 1);
      }),
    );

    it.effect("classifies approved PR feedback as clear", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Record clear feedback.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const feedback = yield* watchGitHubFeedback(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(
              prFeedbackView({ reviewDecision: "APPROVED" }),
            ),
          })),
          rootDirectory: cwd,
        });

        assert.strictEqual(feedback.status, "clear");
        assert.strictEqual(feedback.nextAction, "complete");
      }),
    );

    it.effect("coordinates changes requested and failed CI as ordered blockers", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Coordinate blocked PR loop.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const summary = yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], (input) => {
            if (input.args.join(" ").startsWith("pr checks")) {
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify([
                  {
                    link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                    name: "test",
                    state: "FAILURE",
                    workflow: "CI",
                  },
                ]),
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify(
                prFeedbackView({
                  latestReviews: [
                    {
                      author: { login: "reviewer" },
                      body: "Needs work.",
                      state: "CHANGES_REQUESTED",
                    },
                  ],
                  reviewDecision: "CHANGES_REQUESTED",
                }),
              ),
            };
          }),
          rootDirectory: cwd,
        });

        const state = parseGitHubPrLoopStateJson(
          JSON.parse(yield* fs.readFileString(summary.statePath)),
        );
        const events = yield* fs.readFileString(`${run.runDirectory}/events.jsonl`);

        assert.strictEqual(summary.status, "blocked");
        assert.strictEqual(summary.nextAction, "address-review-comments");
        assert.strictEqual(summary.blockerCount, 2);
        assert.deepStrictEqual(
          summary.blockers.map((blocker) => blocker.kind),
          ["changes-requested", "failed-checks"],
        );
        assert.strictEqual(state.status, "blocked");
        assert.strictEqual(state.nextAction, "address-review-comments");
        assert.include(events, '"type":"GITHUB_CHECKS_RECORDED"');
        assert.include(events, '"type":"GITHUB_FEEDBACK_RECORDED"');
        assert.include(events, '"type":"GITHUB_PR_LOOP_RECORDED"');
        assert.include(events, '"prLoopPath":"pr-loop-state.json"');
      }),
    );

    it.effect("coordinates pending CI and required review as waiting", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Coordinate waiting PR loop.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const summary = yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], (input) => {
            if (input.args.join(" ").startsWith("pr checks")) {
              return {
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
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify(
                prFeedbackView({
                  reviewDecision: "REVIEW_REQUIRED",
                  reviewRequests: [{ requestedReviewer: "team" }],
                }),
              ),
            };
          }),
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.status, "waiting");
        assert.strictEqual(summary.nextAction, "wait-for-ci");
        assert.strictEqual(summary.blockerCount, 2);
        assert.deepStrictEqual(
          summary.blockers.map((blocker) => blocker.kind),
          ["pending-checks", "awaiting-review"],
        );
      }),
    );

    it.effect("coordinates clean PR state as ready for merge decision", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Coordinate ready PR loop.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const summary = yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], (input) => {
            if (input.args.join(" ").startsWith("pr checks")) {
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify([
                  {
                    link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                    name: "test",
                    state: "SUCCESS",
                    workflow: "CI",
                  },
                ]),
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify(
                prFeedbackView({ reviewDecision: "APPROVED" }),
              ),
            };
          }),
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.status, "ready");
        assert.strictEqual(summary.nextAction, "ready-for-merge-decision");
        assert.strictEqual(summary.blockerCount, 0);
        assert.strictEqual(summary.blockers.length, 0);
      }),
    );

    it.effect("creates a remediation spec from a blocked PR loop", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Create remediation spec.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], (input) => {
            if (input.args.join(" ").startsWith("pr checks")) {
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify([
                  {
                    link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                    name: "test",
                    state: "FAILURE",
                    workflow: "CI",
                  },
                ]),
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify(
                prFeedbackView({
                  latestReviews: [
                    {
                      author: { login: "reviewer" },
                      body: "Needs work.",
                      state: "CHANGES_REQUESTED",
                    },
                  ],
                  reviewDecision: "CHANGES_REQUESTED",
                }),
              ),
            };
          }),
          rootDirectory: cwd,
        });

        const remediation = yield* createGitHubRemediationSpec(run.runId, {
          rootDirectory: cwd,
        });
        const markdown = yield* fs.readFileString(remediation.specPath);
        const events = yield* fs.readFileString(`${run.runDirectory}/events.jsonl`);

        assert.strictEqual(remediation.status, "created");
        assert.strictEqual(remediation.nextAction, "address-review-comments");
        assert.strictEqual(remediation.blockerCount, 2);
        assert.include(markdown, "title: \"Remediate GitHub PR 1\"");
        assert.include(markdown, "PR-loop state: `pr-loop-state.json`");
        assert.include(markdown, "`changes-requested` -> `address-review-comments`");
        assert.include(markdown, "`failed-checks` -> `fix-failed-checks`");
        assert.include(markdown, "Do not auto-merge");
        assert.include(events, '"type":"GITHUB_REMEDIATION_SPEC_RECORDED"');
        assert.include(events, '"remediationSpecPath":"remediation-spec.md"');
      }),
    );

    it.effect("does not create remediation specs from waiting PR loops", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Do not remediate waiting state.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], (input) => {
            if (input.args.join(" ").startsWith("pr checks")) {
              return {
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
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify(
                prFeedbackView({ reviewDecision: "REVIEW_REQUIRED" }),
              ),
            };
          }),
          rootDirectory: cwd,
        });

        const error = yield* Effect.flip(
          createGitHubRemediationSpec(run.runId, { rootDirectory: cwd }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "GitHubPrLoopNotBlocked");
        }
      }),
    );

    it.effect("publishes a timestamped Gaia evidence comment to a PR", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Comment with Gaia evidence.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], (input) => {
            if (input.args.join(" ").startsWith("pr checks")) {
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify([
                  {
                    link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                    name: "test",
                    state: "FAILURE",
                    workflow: "CI",
                  },
                ]),
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify(
                prFeedbackView({ reviewDecision: "CHANGES_REQUESTED" }),
              ),
            };
          }),
          rootDirectory: cwd,
        });
        yield* createGitHubRemediationSpec(run.runId, { rootDirectory: cwd });

        const commands: Array<GitHubCommandInput> = [];
        const comment = yield* commentGitHubPullRequest(run.runId, "1", {
          commandRunner: recordingGitHubRunner(commands, (input) => {
            const args = input.args.join(" ");
            if (input.command === "git" && args === "rev-parse --is-inside-work-tree") {
              return { exitCode: 0, stderr: "", stdout: "true\n" };
            }
            if (input.command === "gh" && args === "auth status") {
              return { exitCode: 0, stderr: "", stdout: "" };
            }
            if (input.command === "gh" && args.startsWith("pr comment 1 --body-file ")) {
              return {
                exitCode: 0,
                stderr: "",
                stdout: "https://github.com/cill-i-am/gaia/pull/1#issuecomment-1\n",
              };
            }

            return {
              exitCode: 1,
              stderr: `unexpected command ${input.command} ${args}`,
              stdout: "",
            };
          }),
          rootDirectory: cwd,
        });
        const markdown = yield* fs.readFileString(comment.commentPath);
        const events = yield* fs.readFileString(`${run.runDirectory}/events.jsonl`);
        const commentCommand = commands.find(
          (command) =>
            command.command === "gh" &&
            command.args.join(" ").startsWith("pr comment 1 --body-file "),
        );

        assert.strictEqual(comment.status, "posted");
        assert.strictEqual(
          comment.commentUrl,
          "https://github.com/cill-i-am/gaia/pull/1#issuecomment-1",
        );
        assert.isDefined(commentCommand);
        assert.include(markdown, `<!-- gaia:evidence-comment run-id=${run.runId} -->`);
        assert.include(markdown, `gaia-runs/${run.runId}/report.md`);
        assert.include(markdown, `gaia-runs/${run.runId}/pr-loop-state.json`);
        assert.include(markdown, `gaia-runs/${run.runId}/remediation-spec.md`);
        assert.include(markdown, "Gaia has not approved, merged, or resolved review feedback");
        assert.include(events, '"type":"GITHUB_PR_COMMENT_RECORDED"');
        assert.include(events, '"commentPath":"github-pr-comment.md"');
        assert.include(events, '"commentUrl":"https://github.com/cill-i-am/gaia/pull/1#issuecomment-1"');
      }),
    );

    it.effect("records a Linear issue graph against a completed run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const linearGraphPath = `${cwd}/linear-issue.json`;
        yield* fs.writeFileString(specPath, "Record Linear issue graph.\n");
        yield* fs.writeFileString(
          linearGraphPath,
          JSON.stringify({
            blockedBy: [
              {
                identifier: "GAI-122",
                title: "Complete prerequisite",
                url: "https://linear.app/acme/issue/GAI-122/prerequisite",
              },
            ],
            blocks: [
              {
                identifier: "GAI-124",
                title: "Follow-up task",
              },
            ],
            issue: {
              description: "Build the first issue graph slice.",
              identifier: "GAI-123",
              status: "In Progress",
              title: "Record Linear issue graph",
              url: "https://linear.app/acme/issue/GAI-123/record-linear-issue-graph",
            },
          }),
        );
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const summary = yield* recordLinearIssueGraph(
          run.runId,
          linearGraphPath,
          { rootDirectory: cwd },
        );
        const graph = parseLinearIssueGraphJson(
          JSON.parse(yield* fs.readFileString(summary.graphPath)),
        );
        const events = yield* fs.readFileString(`${run.runDirectory}/events.jsonl`);

        assert.strictEqual(summary.issueIdentifier, "GAI-123");
        assert.strictEqual(summary.issueTitle, "Record Linear issue graph");
        assert.strictEqual(summary.blockedByCount, 1);
        assert.strictEqual(summary.blocksCount, 1);
        assert.strictEqual(graph.source, "linear-json");
        assert.strictEqual(graph.sourcePath, linearGraphPath);
        assert.strictEqual(graph.issue.identifier, "GAI-123");
        assert.strictEqual(graph.blockedBy[0]?.identifier, "GAI-122");
        assert.strictEqual(graph.blocks[0]?.identifier, "GAI-124");
        assert.include(events, '"type":"LINEAR_ISSUE_GRAPH_RECORDED"');
        assert.include(events, '"issueGraphPath":"linear-issue-graph.json"');
        assert.include(events, '"issueIdentifier":"GAI-123"');
      }),
    );

    it.effect("rejects invalid Linear issue identifiers", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const linearGraphPath = `${cwd}/linear-issue.json`;
        yield* fs.writeFileString(specPath, "Reject invalid Linear graph.\n");
        yield* fs.writeFileString(
          linearGraphPath,
          JSON.stringify({
            blockedBy: [],
            blocks: [],
            issue: {
              identifier: "not-linear",
              title: "Invalid identifier",
            },
          }),
        );
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const error = yield* Effect.flip(
          recordLinearIssueGraph(run.runId, linearGraphPath, {
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "LinearIssueGraphInvalid");
          assert.isFalse(error.recoverable);
        }
      }),
    );

    it.effect("approves merge decision when PR loop and reviewer gates pass", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Approve merge decision.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], (input) => {
            if (input.args.join(" ").startsWith("pr checks")) {
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify([
                  {
                    link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                    name: "test",
                    state: "SUCCESS",
                    workflow: "CI",
                  },
                ]),
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify(
                prFeedbackView({ reviewDecision: "APPROVED" }),
              ),
            };
          }),
          rootDirectory: cwd,
        });

        const summary = yield* recordMergeDecision(run.runId, {
          rootDirectory: cwd,
        });
        const decision = parseMergeDecisionJson(
          JSON.parse(yield* fs.readFileString(summary.decisionPath)),
        );
        const events = yield* fs.readFileString(`${run.runDirectory}/events.jsonl`);

        assert.strictEqual(summary.status, "approved");
        assert.strictEqual(summary.nextAction, "ready-to-merge");
        assert.strictEqual(summary.pr, "1");
        assert.strictEqual(summary.blockerCount, 0);
        assert.strictEqual(decision.status, "approved");
        assert.strictEqual(decision.pr, "1");
        assert.strictEqual(decision.planReviewerSessionPath, "plan-reviewer-session.json");
        assert.strictEqual(decision.evidenceReviewerSessionPath, "evidence-reviewer-session.json");
        assert.include(events, '"type":"MERGE_DECISION_RECORDED"');
        assert.include(events, '"mergeDecisionPath":"merge-decision.json"');
        assert.include(events, '"nextAction":"ready-to-merge"');
      }),
    );

    it.effect("blocks merge decision when PR loop evidence is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Block merge decision.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const summary = yield* recordMergeDecision(run.runId, {
          rootDirectory: cwd,
        });
        const decision = parseMergeDecisionJson(
          JSON.parse(yield* fs.readFileString(summary.decisionPath)),
        );

        assert.strictEqual(summary.status, "blocked");
        assert.strictEqual(summary.nextAction, "resolve-blockers");
        assert.strictEqual(summary.pr, undefined);
        assert.strictEqual(summary.blockerCount, 1);
        assert.deepEqual(
          summary.blockers.map((blocker) => blocker.kind),
          ["missing-pr-loop"],
        );
        assert.strictEqual(decision.status, "blocked");
        assert.strictEqual(decision.blockerCount, 1);
      }),
    );

    it.effect("reports invalid PR feedback JSON as a typed failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Invalid PR feedback.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const error = yield* Effect.flip(
          watchGitHubFeedback(run.runId, "1", {
            commandRunner: recordingGitHubRunner([], () => ({
              exitCode: 0,
              stderr: "",
              stdout: "not json",
            })),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "GitHubFeedbackJsonInvalid");
          assert.isTrue(error.recoverable);
        }
      }),
    );

    it.effect("requires a pull request before a CI watch state exists", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Missing watch state.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const error = yield* Effect.flip(
          watchGitHubChecks(run.runId, { rootDirectory: cwd }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "GitHubCiWatchStateMissing");
          assert.isFalse(error.recoverable);
        }
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

function readRunEvents(fs: FileSystem.FileSystem, runDirectory: string) {
  return Effect.gen(function* () {
    const body = yield* fs.readFileString(`${runDirectory}/events.jsonl`);
    return body
      .trim()
      .split(/\r?\n/u)
      .map((line) => parseRunEvent(JSON.parse(line)));
  });
}

function runIdFromCodexPrompt(prompt: string) {
  return prompt.match(/^Run ID: (.+)$/mu)?.[1] ?? "missing-run-id";
}

function codexReviewPhaseFromPrompt(prompt: string) {
  return prompt.match(/^Review phase: (plan|evidence)$/mu)?.[1] ?? "plan";
}

function codexLastMessagePath(input: CodexCommandInput) {
  const outputLastMessageIndex = input.args.indexOf("--output-last-message");
  const outputLastMessagePath = input.args[outputLastMessageIndex + 1];

  if (outputLastMessageIndex < 0 || outputLastMessagePath === undefined) {
    return Effect.fail(
      makeRuntimeError({
        code: "TestCodexLastMessagePathMissing",
        message: "Test Codex command did not receive a last message path.",
        recoverable: false,
      }),
    );
  }

  return Effect.succeed(outputLastMessagePath);
}

function installingSkillRunner(
  fs: FileSystem.FileSystem,
  commands: Array<SkillInstallCommandInput>,
  sourcePath: string,
): SkillInstallCommandRunner {
  return (input) =>
    Effect.gen(function* () {
      commands.push(input);

      if (input.args[0] === "clone") {
        const repositoryDirectory = input.args[2];
        if (repositoryDirectory === undefined) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "TestSkillInstallMissingCloneTarget",
              message: "The test skill installer expected a git clone target.",
              recoverable: false,
            }),
          );
        }

        const skillDirectory = `${repositoryDirectory}/${sourcePath}`;
        yield* fs.makeDirectory(skillDirectory, { recursive: true }).pipe(
          Effect.catchTag("PlatformError", (cause) =>
            Effect.fail(
              makeRuntimeError({
                cause,
                code: "TestSkillInstallDirectoryFailed",
                message: "The test skill installer could not make a skill directory.",
                recoverable: false,
              }),
            ),
          ),
        );
        yield* fs.writeFileString(`${skillDirectory}/SKILL.md`, "# Skill\n").pipe(
          Effect.catchTag("PlatformError", (cause) =>
            Effect.fail(
              makeRuntimeError({
                cause,
                code: "TestSkillInstallSkillMarkdownFailed",
                message: "The test skill installer could not write SKILL.md.",
                recoverable: false,
              }),
            ),
          ),
        );
      }

      return { exitCode: 0, stderr: "", stdout: "" };
    });
}

const passingDoctorCommandRunner: DoctorCommandRunner = (input) =>
  Effect.sync(() => {
    if (input.command === "git") {
      return { exitCode: 0, stderr: "", stdout: "true\n" };
    }

    return { exitCode: 0, stderr: "", stdout: "" };
  });

const warningDoctorCommandRunner: DoctorCommandRunner = (input) =>
  Effect.sync(() => ({
    exitCode: 1,
    stderr: `${input.command} unavailable`,
    stdout: "",
  }));

const collectedBrowserEvidenceCollector: BrowserEvidenceCollector = (input) =>
  Effect.sync(() =>
    BrowserEvidence.make({
      notes: ["Browser evidence captured by test collector."],
      pages: [
        BrowserPageEvidence.make({
          consoleMessages: [],
          screenshots: [
            BrowserScreenshotEvidence.make({
              description: "Test screenshot.",
              path: "browser/page-1.png",
            }),
          ],
          url: new URL(input.targetUrl).toString(),
        }),
      ],
      status: "collected",
      version: 1,
    }),
  );

const failedBrowserEvidenceCollector: BrowserEvidenceCollector = () =>
  Effect.fail(
    makeRuntimeError({
      code: "TestBrowserEvidenceCaptureFailed",
      message: "browser unavailable",
      recoverable: true,
    }),
  );

function writeFrontendRunProfile(
  fs: FileSystem.FileSystem,
  directory: string,
  input: Readonly<{ targetUrl?: string | undefined }> = {
    targetUrl: "http://localhost:3000",
  },
) {
  return Effect.gen(function* () {
    const profilePath = `${directory}/frontend-profile.json`;
    yield* fs.writeFileString(
      profilePath,
      `${JSON.stringify({
        ...(input.targetUrl === undefined
          ? {}
          : { browser: { targetUrl: input.targetUrl } }),
        checks: { browserEvidence: "required" },
        name: "frontend",
        version: 1,
      })}\n`,
    );

    return profilePath;
  });
}

function prFeedbackView(
  input: Readonly<{
    comments?: ReadonlyArray<unknown>;
    isDraft?: boolean;
    latestReviews?: ReadonlyArray<unknown>;
    reviewDecision?: string | null;
    reviewRequests?: ReadonlyArray<unknown>;
  }> = {},
) {
  return {
    comments: input.comments ?? [],
    isDraft: input.isDraft ?? false,
    latestReviews: input.latestReviews ?? [],
    reviewDecision: input.reviewDecision ?? null,
    reviewRequests: input.reviewRequests ?? [],
    title: "Gaia run",
    url: "https://github.com/cill-i-am/gaia/pull/1",
  };
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
