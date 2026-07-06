import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { execPath } from "node:process";
import {
  parseEvidencePromotion,
  parseFactoryLaneScorecard,
  parseFactoryRetro,
  parseDogfoodRetrospective,
  parseRunEvent,
  parseRunId,
} from "@gaia/core";
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
  parseCodexHarnessProgressJson,
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
  HarnessRunResult,
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
  ReviewFinding,
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
} from "./reviewer.js";
import { parseReviewerSessionEvidenceJson } from "./reviewer-session-evidence.js";
import { parseReviewerFindingsJson } from "./reviewer-findings.js";
import { parseWorkerPlanJson } from "./worker-plan.js";
import {
  localRunProfileSource,
  parseRunProfileJson,
} from "./run-profile.js";
import { readLocalRunArtifact } from "./run-read-api.js";
import {
  collectBrowserEvidence,
  listRuns,
  resumeRun,
  runSpecFile,
  statusRun,
} from "./workflows.js";
import { localDirectoryWorkspaceSource } from "./workspace.js";
import { parseWorkspacePrQualityGateJson } from "./workspace-pr-gate.js";
import { verifyHarnessOutput } from "./verifier.js";

const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const parseHarnessRunResultJson = Schema.decodeUnknownSync(
  HarnessRunResultJson,
);

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

    it.effect("writes a spec-derived worker plan for review", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          specPath,
          [
            "---",
            "title: Rich worker plan",
            "---",
            "",
            "Goal:",
            "- Replace generic worker planning with a spec-derived plan artifact.",
            "",
            "Acceptance criteria:",
            "- worker-plan.json lists spec acceptance criteria.",
            "- worker-plan.md is readable without opening input.md.",
            "",
            "Non-goals:",
            "- Do not add live reviewer threads.",
            "",
            "Likely touched surfaces:",
            "- packages/runtime/src/worker-plan.ts",
            "- packages/runtime/src/reviewer.ts",
            "",
            "Verification:",
            "- `pnpm --filter @gaia/runtime test` passes.",
            "- Existing fake harness smoke remains intact.",
            "",
            "Stop conditions:",
            "- Stop if the spec omits testable acceptance criteria.",
            "",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const workerPlan = parseWorkerPlanJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/worker-plan.json`),
          ),
        );
        const workerPlanMarkdown = yield* fs.readFileString(
          `${summary.runDirectory}/worker-plan.md`,
        );
        const planReview = yield* fs.readFileString(
          `${summary.runDirectory}/plan-review.md`,
        );

        assert.deepEqual(workerPlan.acceptanceCriteria, [
          "worker-plan.json lists spec acceptance criteria.",
          "worker-plan.md is readable without opening input.md.",
        ]);
        assert.deepEqual(workerPlan.nonGoals, [
          "Do not add live reviewer threads.",
        ]);
        assert.deepEqual(workerPlan.likelyTouchedSurfaces, [
          "packages/runtime/src/worker-plan.ts",
          "packages/runtime/src/reviewer.ts",
        ]);
        assert.deepEqual(
          workerPlan.verificationChecks.map((check) => check.expectation),
          [
            "`pnpm --filter @gaia/runtime test` passes.",
            "Existing fake harness smoke remains intact.",
          ],
        );
        assert.strictEqual(
          workerPlan.verificationChecks[0]?.command,
          "pnpm --filter @gaia/runtime test",
        );
        assert.deepEqual(workerPlan.stopConditions, [
          "Stop if the spec omits testable acceptance criteria.",
        ]);
        assert.include(
          workerPlanMarkdown,
          "worker-plan.json lists spec acceptance criteria.",
        );
        assert.include(workerPlanMarkdown, "Do not add live reviewer threads.");
        assert.include(
          workerPlanMarkdown,
          "packages/runtime/src/worker-plan.ts",
        );
        assert.include(
          workerPlanMarkdown,
          "`pnpm --filter @gaia/runtime test` passes.",
        );
        assert.include(
          workerPlanMarkdown,
          "Stop if the spec omits testable acceptance criteria.",
        );
        assert.include(
          workerPlanMarkdown,
          "Replace generic worker planning with a spec-derived plan artifact.",
        );
        assert.include(planReview, "2 acceptance criteria");
      }),
    );

    it.effect("separates executable checks from domain references in worker plans", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          specPath,
          [
            "---",
            "title: Command reference classification",
            "---",
            "",
            "Goal:",
            "- Keep domain references inspectable without turning them into checks.",
            "",
            "Verification:",
            "- `POST /runs` is an API route, not a shell command.",
            "- `GET /health` is also an API route.",
            "- `HttpApiBuilder.group` should stay a code reference.",
            "- `@effect/platform-node` should stay a package reference.",
            "- `packages/runtime/src/worker-plan.ts` should stay a file reference.",
            "- `runId` should stay a quoted symbol.",
            "- `pnpm --filter @gaia/runtime test` passes.",
            "- pnpm build",
            "",
            "```sh",
            "node ./scripts/check.mjs",
            "pnpm check",
            "pnpm test",
            "```",
            "",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const workerPlan = parseWorkerPlanJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/worker-plan.json`),
          ),
        );
        const workerPlanMarkdown = yield* fs.readFileString(
          `${summary.runDirectory}/worker-plan.md`,
        );
        const reportMarkdown = yield* fs.readFileString(summary.reportPath);

        assert.deepEqual(
          workerPlan.verificationChecks.map((check) => check.command),
          [
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            "pnpm --filter @gaia/runtime test",
            "pnpm build",
            "node ./scripts/check.mjs",
            "pnpm check",
            "pnpm test",
          ],
        );
        assert.deepEqual(
          workerPlan.domainReferences.map((reference) => [
            reference.kind,
            reference.value,
          ]),
          [
            ["http-route", "POST /runs"],
            ["http-route", "GET /health"],
            ["effect-api", "HttpApiBuilder.group"],
            ["package-name", "@effect/platform-node"],
            ["file-path", "packages/runtime/src/worker-plan.ts"],
            ["quoted-symbol", "runId"],
          ],
        );
        assert.include(workerPlanMarkdown, "## Domain References");
        assert.include(workerPlanMarkdown, "- http-route: `POST /runs`");
        assert.include(workerPlanMarkdown, "- effect-api: `HttpApiBuilder.group`");
        assert.include(reportMarkdown, "## Domain References");
        assert.include(reportMarkdown, "- http-route: `POST /runs`");
      }),
    );

    it.effect("produces source-backed planning context for a GAIA-12-like server slice", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const source = `${cwd}/source`;
        const specPath = `${cwd}/spec.md`;
        yield* writeReferencePlanningFixture(source);
        yield* fs.writeFileString(
          specPath,
          [
            "---",
            "title: GAIA-12 server foundation follow-up",
            "---",
            "",
            "Goal:",
            "- Migrate the local server foundation to Effect HttpApi and keep workspace read APIs aligned.",
            "",
            "Context:",
            "- The GAIA-12 retro says planning should name server/API contracts, CLI server plumbing, runtime read exports, package manifests, and focused tests.",
            "- Keep `POST /runs`, `GET /health`, and `HttpApiBuilder.group` as source references, not executable checks.",
            "",
            "Acceptance criteria:",
            "- Server API contracts and runtime read artifacts stay parseable.",
            "- CLI server commands continue to surface run artifacts without scraping markdown.",
            "",
            "Out of scope:",
            "- Do not implement GAIA-13 local-server run acceptance.",
            "- Do not add dashboards, live Linear sync, auth, SQLite, or merge automation.",
            "",
            "Verification:",
            "- Focused server API tests pass.",
            "- Focused CLI server smoke passes.",
            "- `pnpm check`",
            "- `pnpm test`",
            "",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, {
          rootDirectory: cwd,
          workspaceSource: localDirectoryWorkspaceSource(source),
        });
        const workerPlan = parseWorkerPlanJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/worker-plan.json`),
          ),
        );
        const workerPlanMarkdown = yield* fs.readFileString(
          `${summary.runDirectory}/worker-plan.md`,
        );
        const reportMarkdown = yield* fs.readFileString(summary.reportPath);
        const likelyFiles = workerPlan.planningContext.likelyFiles.map(
          (file) => file.path,
        );
        const sourceDocs = workerPlan.planningContext.sourceDocs.map(
          (doc) => doc.path,
        );
        const similarTests = workerPlan.planningContext.similarTests.map(
          (test) => test.path,
        );
        const instructionScopes = workerPlan.planningContext.agentInstructions.map(
          (instruction) => instruction.path,
        );
        const packageNames = workerPlan.planningContext.packages.map(
          (workspacePackage) => workspacePackage.name,
        );
        const traps = workerPlan.planningContext.outOfScopeTraps;
        const inferredSkills = workerPlan.inferredRecommendations.skills.map(
          (recommendation) => recommendation.name,
        );
        const inferredReviewStack =
          workerPlan.inferredRecommendations.reviewStack.map(
            (recommendation) => recommendation.name,
          );
        const inferredVerification =
          workerPlan.inferredRecommendations.verification.map(
            (recommendation) => recommendation.check,
          );
        const effectSkill = workerPlan.inferredRecommendations.skills.find(
          (recommendation) => recommendation.name === "effect-ts",
        );
        const reviewSwarm =
          workerPlan.inferredRecommendations.reviewStack.find(
            (recommendation) => recommendation.name === "review-swarm",
          );

        assert.include(likelyFiles, "packages/core/src/server-api.ts");
        assert.include(likelyFiles, "apps/server/src/api.ts");
        assert.include(likelyFiles, "apps/server/src/main.ts");
        assert.include(likelyFiles, "apps/cli/src/main.ts");
        assert.include(likelyFiles, "packages/runtime/src/run-read-api.ts");
        assert.include(sourceDocs, "docs/operator-model.md");
        assert.include(sourceDocs, "docs/post-harness-roadmap.md");
        assert.include(similarTests, "packages/core/src/server-api.test.ts");
        assert.include(similarTests, "apps/server/src/api.test.ts");
        assert.include(similarTests, "apps/cli/src/main.test.ts");
        assert.include(similarTests, "packages/runtime/src/runtime.test.ts");
        assert.include(instructionScopes, "AGENTS.md");
        assert.include(instructionScopes, "apps/AGENTS.md");
        assert.include(instructionScopes, "apps/cli/AGENTS.md");
        assert.include(instructionScopes, "packages/AGENTS.md");
        assert.include(instructionScopes, "packages/core/AGENTS.md");
        assert.include(instructionScopes, "packages/runtime/AGENTS.md");
        assert.include(packageNames, "@gaia/core");
        assert.include(packageNames, "@gaia/server");
        assert.include(packageNames, "@gaia/cli");
        assert.include(packageNames, "@gaia/runtime");
        assert.include(
          workerPlan.planningContext.verificationSeams,
          "apps/server/src/api.test.ts exercises server API behavior.",
        );
        assert.include(
          workerPlan.planningContext.verificationSeams,
          "apps/cli/src/main.test.ts exercises CLI behavior.",
        );
        assert.include(
          traps,
          "Do not implement GAIA-13 local-server run acceptance.",
        );
        assert.include(
          traps,
          "Do not add dashboards, live Linear sync, auth, SQLite, or merge automation.",
        );
        assert.include(workerPlanMarkdown, "## Reference-First Planning Context");
        assert.include(workerPlanMarkdown, "packages/core/src/server-api.ts");
        assert.include(workerPlanMarkdown, "packages/runtime/AGENTS.md");
        assert.include(workerPlanMarkdown, "apps/server/src/api.test.ts");
        assert.includeMembers(inferredSkills, [
          "effect-ts",
          "production-ready",
          "code-review",
          "simplify",
          "review-swarm",
        ]);
        assert.includeMembers(inferredReviewStack, [
          "effect-ts",
          "production-ready",
          "code-review",
          "simplify",
          "review-swarm",
        ]);
        assert.includeMembers(inferredVerification, [
          "Focused core contract tests",
          "Focused server tests",
          "Focused CLI tests",
          "Built server binary smoke",
        ]);
        assert.isAtLeast(effectSkill?.reasons.length ?? 0, 1);
        assert.isAtLeast(effectSkill?.sources.length ?? 0, 1);
        assert.isAtLeast(reviewSwarm?.sources.length ?? 0, 3);
        assert.include(workerPlanMarkdown, "## Inferred Recommendations");
        assert.include(workerPlanMarkdown, "effect-ts");
        assert.include(workerPlanMarkdown, "review-swarm");
        assert.include(workerPlanMarkdown, "Built server binary smoke");
        assert.include(reportMarkdown, "## Inferred Recommendations");
        assert.include(reportMarkdown, "effect-ts");
        assert.include(reportMarkdown, "review-swarm");
        assert.notInclude(
          workerPlan.verificationChecks.map((check) => check.command).join("\n"),
          "POST /runs",
        );
      }),
    );

    it.effect("surfaces relevant reviewer findings as historical risk notes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const source = `${cwd}/source`;
        const specPath = `${cwd}/spec.md`;
        yield* writeReferencePlanningFixture(source);
        yield* writeGaia12ReviewerFindingsFixture(source);
        yield* fs.writeFileString(
          specPath,
          [
            "---",
            "title: Future server API planning",
            "---",
            "",
            "Goal:",
            "- Plan a server/API-like slice that touches Effect HttpApi routes, runtime run reads, package manifests, and CLI server smoke.",
            "",
            "Acceptance criteria:",
            "- Server API contracts and non-GET behavior stay covered.",
            "- Runtime metadata cleanup timing remains explicit before handoff.",
            "",
            "Likely touched surfaces:",
            "- apps/server/src/api.ts",
            "- apps/server/src/main.ts",
            "- apps/cli/src/main.ts",
            "- packages/runtime/src/run-read-api.ts",
            "- packages/core/src/server-api.ts",
            "- package.json",
            "",
            "Verification:",
            "- Focused server API tests pass.",
            "- Built server binary smoke passes.",
            "- Metadata cleanup is verified before deleting raw .gaia state.",
            "",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, {
          rootDirectory: cwd,
          workspaceSource: localDirectoryWorkspaceSource(source),
        });
        const workerPlan = parseWorkerPlanJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/worker-plan.json`),
          ),
        );
        const reviewerFindings = parseReviewerFindingsJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/reviewer-findings.json`,
            ),
          ),
        );
        const workerPlanMarkdown = yield* fs.readFileString(
          `${summary.runDirectory}/worker-plan.md`,
        );
        const reportMarkdown = yield* fs.readFileString(summary.reportPath);
        const readArtifact = yield* readLocalRunArtifact(
          summary.runId,
          "reviewer-findings",
          { rootDirectory: cwd },
        );
        const riskTitles = workerPlan.historicalRiskNotes.map((note) => note.title);
        const verificationPrompts = workerPlan.historicalRiskNotes.flatMap(
          (note) => note.verificationPrompts,
        );

        assert.includeMembers(riskTitles, [
          "Built server binary smoke was missed",
          "Package-barrel import drag hid runtime coupling",
          "Non-GET behavior needed explicit coverage",
          "Startup timeouts needed race-safe tests",
          "Metadata cleanup timing needed finalization",
        ]);
        assert.strictEqual(
          workerPlan.historicalRiskNotes.every(
            (note) => note.status === "historical-risk",
          ),
          true,
        );
        assert.includeMembers(verificationPrompts, [
          "Smoke the built server binary, not only TypeScript source paths.",
          "Assert non-GET methods return the expected API error shape.",
          "Verify cleanup timing before deleting raw .gaia run state.",
        ]);
        assert.strictEqual(reviewerFindings.matchedRiskNotes.length, 5);
        assert.isAtLeast(reviewerFindings.relevanceInputs.length, 1);
        assert.include(
          reviewerFindings.relevanceInputs.map((input) => input.value),
          "apps/server/src/api.ts",
        );
        assert.include(workerPlanMarkdown, "## Historical Reviewer Risk Notes");
        assert.include(workerPlanMarkdown, "Historical risk, not current blocker");
        assert.include(workerPlanMarkdown, "historical-risk-not-current-blocker");
        assert.include(workerPlanMarkdown, "Source classification: historical-risk");
        assert.include(workerPlanMarkdown, "https://github.com/cill-i-am/gaia/pull/15");
        assert.include(reportMarkdown, "## Historical Reviewer Risk Notes");
        assert.include(reportMarkdown, "historical-risk-not-current-blocker");
        assert.include(reportMarkdown, "reviewer-findings.json");
        assert.include(reportMarkdown, "Built server binary smoke was missed");
        assert.strictEqual(readArtifact.contentType, "application/json");
        assert.include(readArtifact.body, '"matchedRiskNotes"');
      }),
    );

    it.effect("filters irrelevant reviewer findings out of docs-only plans", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const source = `${cwd}/source`;
        const specPath = `${cwd}/spec.md`;
        yield* writeReferencePlanningFixture(source);
        yield* writeGaia12ReviewerFindingsFixture(source);
        yield* fs.writeFileString(
          specPath,
          [
            "---",
            "title: Reviewer template wording",
            "---",
            "",
            "Goal:",
            "- Update docs/agents reviewer template copy.",
            "",
            "Likely touched surfaces:",
            "- docs/agents/reviewer-thread-template.md",
            "",
            "Acceptance criteria:",
            "- Template wording remains source-backed.",
            "- No runtime or server behavior changes.",
            "",
            "Verification:",
            "- Review the docs/template diff.",
            "",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, {
          rootDirectory: cwd,
          workspaceSource: localDirectoryWorkspaceSource(source),
        });
        const workerPlan = parseWorkerPlanJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/worker-plan.json`),
          ),
        );
        const reviewerFindings = parseReviewerFindingsJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/reviewer-findings.json`,
            ),
          ),
        );
        const workerPlanMarkdown = yield* fs.readFileString(
          `${summary.runDirectory}/worker-plan.md`,
        );

        assert.strictEqual(workerPlan.historicalRiskNotes.length, 0);
        assert.isAtLeast(reviewerFindings.relevanceInputs.length, 1);
        assert.strictEqual(reviewerFindings.suppliedFindings.length, 5);
        assert.strictEqual(reviewerFindings.matchedRiskNotes.length, 0);
        assert.include(workerPlanMarkdown, "## Historical Reviewer Risk Notes");
        assert.include(
          workerPlanMarkdown,
          "No supplied reviewer findings matched this plan's touched surfaces.",
        );
      }),
    );

    it.effect("ignores source-less supplied reviewer findings", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const source = `${cwd}/source`;
        const specPath = `${cwd}/spec.md`;
        yield* writeReferencePlanningFixture(source);
        yield* writeSourceLessReviewerFindingsFixture(source);
        yield* fs.writeFileString(
          specPath,
          [
            "---",
            "title: Future server API planning",
            "---",
            "",
            "Goal:",
            "- Plan a server/API-like slice that touches Effect HttpApi routes and runtime run reads.",
            "",
            "Likely touched surfaces:",
            "- apps/server/src/api.ts",
            "- packages/runtime/src/run-read-api.ts",
            "",
            "Verification:",
            "- Built server binary smoke passes.",
            "",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, {
          rootDirectory: cwd,
          workspaceSource: localDirectoryWorkspaceSource(source),
        });
        const workerPlan = parseWorkerPlanJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/worker-plan.json`),
          ),
        );
        const reviewerFindings = parseReviewerFindingsJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/reviewer-findings.json`,
            ),
          ),
        );
        const workerPlanMarkdown = yield* fs.readFileString(
          `${summary.runDirectory}/worker-plan.md`,
        );

        assert.strictEqual(reviewerFindings.suppliedFindings.length, 0);
        assert.strictEqual(reviewerFindings.matchedRiskNotes.length, 0);
        assert.strictEqual(workerPlan.historicalRiskNotes.length, 0);
        assert.notInclude(workerPlanMarkdown, "Source-less server smoke finding");
        assert.notInclude(workerPlanMarkdown, "Sources:\n- none");
      }),
    );

    it.effect("keeps narrow non-server source context focused", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const source = `${cwd}/source`;
        const specPath = `${cwd}/spec.md`;
        yield* writeReferencePlanningFixture(source);
        yield* fs.writeFileString(
          specPath,
          [
            "---",
            "title: Evidence promotion context",
            "---",
            "",
            "Goal:",
            "- Preserve selected dogfood evidence before raw run cleanup.",
            "",
            "Acceptance criteria:",
            "- Evidence promotion stays JSON-safe and report-visible.",
            "- Runtime and core artifacts explain cleanup status.",
            "",
            "Out of scope:",
            "- Do not add live Linear sync or dashboards.",
            "",
            "Verification:",
            "- Focused evidence promotion tests pass.",
            "- `pnpm --filter @gaia/runtime test`",
            "",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, {
          rootDirectory: cwd,
          workspaceSource: localDirectoryWorkspaceSource(source),
        });
        const workerPlan = parseWorkerPlanJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/worker-plan.json`),
          ),
        );
        const likelyFiles = workerPlan.planningContext.likelyFiles.map(
          (file) => file.path,
        );
        const similarTests = workerPlan.planningContext.similarTests.map(
          (test) => test.path,
        );
        const instructionScopes = workerPlan.planningContext.agentInstructions.map(
          (instruction) => instruction.path,
        );
        const packageNames = workerPlan.planningContext.packages.map(
          (workspacePackage) => workspacePackage.name,
        );
        const inferredSkills = workerPlan.inferredRecommendations.skills.map(
          (recommendation) => recommendation.name,
        );
        const inferredReviewStack =
          workerPlan.inferredRecommendations.reviewStack.map(
            (recommendation) => recommendation.name,
          );
        const inferredVerification =
          workerPlan.inferredRecommendations.verification.map(
            (recommendation) => recommendation.check,
          );

        assert.include(likelyFiles, "packages/core/src/evidence-promotion.ts");
        assert.include(likelyFiles, "packages/runtime/src/evidence-promotion.ts");
        assert.include(similarTests, "packages/runtime/src/runtime.test.ts");
        assert.notInclude(likelyFiles, "apps/server/src/api.ts");
        assert.notInclude(likelyFiles, "apps/server/src/main.ts");
        assert.notInclude(packageNames, "@gaia/server");
        assert.notInclude(packageNames, "@gaia/cli");
        assert.notInclude(instructionScopes, "apps/AGENTS.md");
        assert.notInclude(instructionScopes, "apps/cli/AGENTS.md");
        assert.includeMembers(inferredSkills, [
          "production-ready",
          "code-review",
          "simplify",
        ]);
        assert.includeMembers(inferredReviewStack, [
          "production-ready",
          "code-review",
          "simplify",
        ]);
        assert.notInclude(inferredSkills, "effect-ts");
        assert.notInclude(inferredReviewStack, "review-swarm");
        assert.notInclude(inferredVerification, "Focused server tests");
        assert.notInclude(inferredVerification, "Built server binary smoke");
      }),
    );

    it.effect("keeps docs and template-only inference lightweight", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const source = `${cwd}/source`;
        const specPath = `${cwd}/spec.md`;
        yield* writeReferencePlanningFixture(source);
        yield* fs.writeFileString(
          specPath,
          [
            "---",
            "title: Docs template planning update",
            "---",
            "",
            "Goal:",
            "- Update worker handoff template language for clearer evidence prompts.",
            "",
            "Likely touched surfaces:",
            "- docs/agents/worker-thread-template.md",
            "- docs/agents/reviewer-thread-template.md",
            "",
            "Acceptance criteria:",
            "- Template language remains source-backed and reviewable.",
            "- No runtime behavior changes are introduced.",
            "",
            "Out of scope:",
            "- Do not add live reviewer threads or automatic skill installation.",
            "",
            "Verification:",
            "- Review the docs/template diff for durable workflow wording.",
            "",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, {
          rootDirectory: cwd,
          workspaceSource: localDirectoryWorkspaceSource(source),
        });
        const workerPlan = parseWorkerPlanJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/worker-plan.json`),
          ),
        );
        const workerPlanMarkdown = yield* fs.readFileString(
          `${summary.runDirectory}/worker-plan.md`,
        );
        const inferredSkills = workerPlan.inferredRecommendations.skills.map(
          (recommendation) => recommendation.name,
        );
        const inferredReviewStack =
          workerPlan.inferredRecommendations.reviewStack.map(
            (recommendation) => recommendation.name,
          );
        const inferredVerification =
          workerPlan.inferredRecommendations.verification.map(
            (recommendation) => recommendation.check,
          );

        assert.includeMembers(inferredSkills, [
          "production-ready",
          "code-review",
          "simplify",
        ]);
        assert.includeMembers(inferredReviewStack, [
          "production-ready",
          "code-review",
          "simplify",
        ]);
        assert.notInclude(inferredSkills, "effect-ts");
        assert.notInclude(inferredReviewStack, "review-swarm");
        assert.deepEqual(inferredVerification, ["Docs/template artifact review"]);
        assert.include(workerPlanMarkdown, "docs/agents/worker-thread-template.md");
        assert.include(workerPlanMarkdown, "Docs/template artifact review");
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

    it.effect("emits a clean dogfood retrospective for a completed run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Retrospective clean run.\n");

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const retrospective = parseDogfoodRetrospective(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/dogfood-retrospective.json`,
            ),
          ),
        );
        const reportMarkdown = yield* fs.readFileString(summary.reportPath);
        const reportJson = yield* fs.readFileString(
          `${summary.runDirectory}/report.json`,
        );
        assert.strictEqual(retrospective.status, "clean");
        assert.strictEqual(retrospective.findings.length, 0);
        assert.strictEqual(retrospective.candidateIssueCount, 0);
        assert.include(
          retrospective.summary,
          "No high-signal dogfood findings",
        );
        assert.include(reportMarkdown, "dogfood-retrospective.json");
        assert.include(reportMarkdown, "No high-signal dogfood findings");
        assert.include(reportJson, '"dogfood-retrospective.json"');
      }),
    );

    it.effect("emits a factory retro with helped/missed/misled and source links", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          specPath,
          [
            "---",
            "title: GAIA-12-like dogfood retro",
            "---",
            "",
            "Acceptance criteria:",
            "- Factory retro captures helped, missed, and misled notes.",
            "",
            "Factory retro helped:",
            "- Durable planning and report artifacts changed review behavior.",
            "",
            "Factory retro missed:",
            "- Gaia missed likely implementation files and skills.",
            "",
            "Factory retro misled:",
            "- Command extraction treated `POST /runs` like a shell command.",
            "",
            "Factory retro next improvement:",
            "- Separate executable commands from domain references.",
            "",
            "Factory retro source links:",
            "- GAIA-12 retro: https://linear.app/tskr/document/factory-retro-gaia-12-ab-dogfood-45bcc888784b",
            "",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const factoryRetroPath = `${cwd}/.gaia/promoted/${summary.runId}/factory-retro.json`;
        const factoryRetroMarkdownPath = `${cwd}/.gaia/promoted/${summary.runId}/factory-retro.md`;
        const retro = parseFactoryRetro(
          JSON.parse(yield* fs.readFileString(factoryRetroPath)),
        );
        const markdown = yield* fs.readFileString(factoryRetroMarkdownPath);
        const reportMarkdown = yield* fs.readFileString(summary.reportPath);

        assert.strictEqual(retro.runId, summary.runId);
        assert.strictEqual(retro.status, "findings");
        assert.strictEqual(retro.cleanupStatus, "not-completed");
        assert.strictEqual(retro.promotionStatus, "pending-promotion");
        assert.include(
          retro.helped.map((entry) => entry.summary).join("\n"),
          "Durable planning and report artifacts",
        );
        assert.include(
          retro.missed.map((entry) => entry.summary).join("\n"),
          "likely implementation files",
        );
        assert.include(
          retro.misled.map((entry) => entry.summary).join("\n"),
          "POST /runs",
        );
        assert.strictEqual(
          retro.recommendedNextFactoryImprovement,
          "Separate executable commands from domain references.",
        );
        const gaia12Source = retro.sourceLinks.find(
          (source) => source.label === "GAIA-12 retro",
        );
        assert.strictEqual(
          gaia12Source?.url,
          "https://linear.app/tskr/document/factory-retro-gaia-12-ab-dogfood-45bcc888784b",
        );
        assert.include(markdown, "## Helped");
        assert.include(markdown, "## Missed");
        assert.include(markdown, "## Misled");
        assert.include(reportMarkdown, "factory-retro.json");
        assert.include(reportMarkdown, "factory-retro.md");
      }),
    );

    it.effect("emits a GAIA-12-like A/B lane scorecard preserving implementation and factory-learning tradeoffs", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          specPath,
          [
            "---",
            "title: GAIA-12-like A/B lane scorecard",
            "---",
            "",
            "Factory scorecard lane A:",
            "- Lane id: lane-a",
            "- Label: Lane A fallback",
            "- Role: direct fallback",
            "- PR: #14",
            "- Head SHA: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "- Checks: no checks configured",
            "- Comparison wait: valid",
            "- Local verification: pnpm check - passed",
            "- Local verification: pnpm test - passed",
            "- Correctness: adequate - Correct smaller-diff fallback.",
            "- Scope adherence: strong - Stayed inside the local-server slice.",
            "- Simplicity: strong - Smaller and easier to inspect.",
            "- Test evidence: adequate - Focused tests passed.",
            "- Production readiness: adequate - Local verification supplied because no CI exists.",
            "- Diff risk: low - Smaller diff with fewer moving parts.",
            "- Dogfood signal: weak - Did not exercise Gaia run artifacts.",
            "- Implementation acceptance: fallback - Closed unmerged as useful fallback/reference.",
            "- Factory learning signal: weak - Useful comparison baseline but little Gaia self-improvement evidence.",
            "- Tradeoff: Smaller diff, weaker boundary typing and dogfood evidence.",
            "- Source: Closed fallback lane PR #14: https://github.com/cill-i-am/gaia/pull/14",
            "",
            "Factory scorecard lane B:",
            "- Lane id: lane-b",
            "- Label: Lane B dogfood",
            "- Role: gaia dogfood",
            "- PR: #15",
            "- Head SHA: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "- Checks: no checks configured",
            "- Comparison wait: valid",
            "- Local verification: pnpm check - passed",
            "- Local verification: pnpm test - passed",
            "- Local verification: pnpm build - passed",
            "- Correctness: strong - Reviewer fixes improved endpoint errors and path schemas.",
            "- Scope adherence: adequate - Broader but stayed tied to the accepted slice.",
            "- Simplicity: adequate - Broader implementation with clearer contracts.",
            "- Test evidence: strong - Startup, contract, CLI, and built binary smokes were recorded.",
            "- Production readiness: strong - Local gates and smoke evidence were stronger despite no CI.",
            "- Diff risk: medium - Larger diff carried more integration risk.",
            "- Dogfood signal: strong - Gaia run IDs and factory retro evidence exposed planning gaps.",
            "- Implementation acceptance: accepted - Accepted and merged after reviewer fixes.",
            "- Factory learning signal: strong - Exposed command extraction, file inference, and evidence-promotion gaps.",
            "- Tradeoff: Broader diff, stronger boundary parsing and dogfood signal.",
            "- Source: Accepted dogfood lane PR #15: https://github.com/cill-i-am/gaia/pull/15",
            "",
            "Factory scorecard recommendation:",
            "- Preferred lane: lane-b",
            "- Rationale: Prefer Lane B because accepted implementation quality and dogfood evidence were stronger.",
            "- Tradeoff: Preserve Lane A as the smaller fallback/reference.",
            "- Note: No-CI is represented as no checks configured, not green.",
            "",
          ].join("\n"),
        );

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const scorecardPath = `${cwd}/.gaia/promoted/${summary.runId}/factory-scorecard.json`;
        const scorecardMarkdownPath = `${cwd}/.gaia/promoted/${summary.runId}/factory-scorecard.md`;
        const scorecard = parseFactoryLaneScorecard(
          JSON.parse(yield* fs.readFileString(scorecardPath)),
        );
        const markdown = yield* fs.readFileString(scorecardMarkdownPath);
        const reportMarkdown = yield* fs.readFileString(summary.reportPath);
        const readable = yield* readLocalRunArtifact(
          summary.runId,
          "factory-scorecard",
          { rootDirectory: cwd },
        );

        assert.strictEqual(scorecard.runId, summary.runId);
        assert.strictEqual(scorecard.lanes.length, 2);
        assert.sameMembers(
          scorecard.lanes[0]?.criteria.map((criterion) => criterion.criterion) ?? [],
          [
            "correctness",
            "scope-adherence",
            "simplicity",
            "test-evidence",
            "production-readiness",
            "diff-risk",
            "dogfood-signal",
          ],
        );
        assert.strictEqual(scorecard.lanes[0]?.checkStatus, "no-checks-configured");
        assert.strictEqual(scorecard.lanes[1]?.checkStatus, "no-checks-configured");
        assert.strictEqual(
          scorecard.lanes[1]?.implementationAcceptance.status,
          "accepted",
        );
        assert.strictEqual(scorecard.lanes[1]?.factoryLearningSignal.status, "strong");
        assert.strictEqual(scorecard.preferredLane?.laneId, "lane-b");
        assert.include(scorecard.preferredLane?.tradeoffsPreserved.join("\n"), "Lane A");
        assert.include(markdown, "## Accepted Implementation Quality");
        assert.include(markdown, "## Gaia Factory Learning Signal");
        assert.include(markdown, "no checks configured");
        assert.include(reportMarkdown, "factory-scorecard.json");
        assert.include(reportMarkdown, "No-CI is represented as no checks configured, not green.");
        assert.strictEqual(readable.contentType, "application/json");
      }),
    );

    it.effect("promotes selected evidence before raw run cleanup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Promote evidence before cleanup.\n");

        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const promotedPath = `${cwd}/.gaia/promoted/${summary.runId}/evidence-promotion.json`;
        const promotedMarkdownPath = `${cwd}/.gaia/promoted/${summary.runId}/evidence-promotion.md`;
        const promotion = parseEvidencePromotion(
          JSON.parse(yield* fs.readFileString(promotedPath)),
        );
        const promotionMarkdown = yield* fs.readFileString(promotedMarkdownPath);
        const reportMarkdown = yield* fs.readFileString(summary.reportPath);
        const run = yield* readLocalRunArtifact(
          summary.runId,
          "evidence-promotion",
          { rootDirectory: cwd },
        );

        assert.strictEqual(promotion.runId, summary.runId);
        assert.strictEqual(promotion.promotionStatus, "pending-promotion");
        assert.strictEqual(promotion.cleanupStatus, "not-completed");
        assert.strictEqual(
          promotion.artifactPath,
          `.gaia/promoted/${summary.runId}/evidence-promotion.json`,
        );
        assert.include(promotionMarkdown, `# Evidence Promotion ${summary.runId}`);
        assert.include(promotionMarkdown, "Cleanup status: not-completed");
        assert.include(reportMarkdown, "evidence-promotion.json");
        assert.include(reportMarkdown, "factory-retro.json");
        assert.isBelow(
          reportMarkdown.indexOf("evidence-promotion.json"),
          reportMarkdown.indexOf("Raw run state is disposable"),
        );
        assert.strictEqual(run.contentType, "application/json");

        yield* fs.remove(summary.runDirectory, { recursive: true });
        const survivingPromotion = parseEvidencePromotion(
          JSON.parse(yield* fs.readFileString(promotedPath)),
        );
        const survivingFactoryRetro = parseFactoryRetro(
          JSON.parse(
            yield* fs.readFileString(
              `${cwd}/.gaia/promoted/${summary.runId}/factory-retro.json`,
            ),
          ),
        );
        assert.strictEqual(survivingPromotion.runId, summary.runId);
        assert.strictEqual(survivingPromotion.cleanupStatus, "not-completed");
        assert.strictEqual(survivingFactoryRetro.runId, summary.runId);
        assert.strictEqual(survivingFactoryRetro.cleanupStatus, "not-completed");
      }),
    );

    it.effect("promotes blocked run evidence with factory retro cleanup still not completed", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
          "blocking-promotion-reviewer",
        );
        const reviewer: GaiaReviewer = {
          name: reviewerName,
          run: (request) =>
            Effect.succeed(
              ReviewResult.make({
                findings: [
                  ReviewFinding.make({
                    message: "Plan needs concrete evidence promotion handling.",
                    severity: "blocker",
                  }),
                ],
                phase: request.phase,
                resultPath:
                  request.phase === "plan"
                    ? "plan-review.json"
                    : "evidence-review.json",
                reviewerName,
                runId: request.runId,
                status: request.phase === "plan" ? "blocked" : "approved",
                summary: "Plan review blocked evidence promotion.",
              }),
            ),
        };
        yield* fs.writeFileString(specPath, "Blocked evidence promotion.\n");

        yield* Effect.flip(
          runSpecFile(specPath, { reviewer, rootDirectory: cwd }),
        );
        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        const promotion = parseEvidencePromotion(
          JSON.parse(
            yield* fs.readFileString(
              `${cwd}/.gaia/promoted/${status.runId}/evidence-promotion.json`,
            ),
          ),
        );
        const retro = parseFactoryRetro(
          JSON.parse(
            yield* fs.readFileString(
              `${cwd}/.gaia/promoted/${status.runId}/factory-retro.json`,
            ),
          ),
        );

        assert.strictEqual(status.state, "failed");
        assert.strictEqual(promotion.runId, status.runId);
        assert.strictEqual(promotion.promotionStatus, "pending-promotion");
        assert.strictEqual(promotion.cleanupStatus, "not-completed");
        assert.strictEqual(retro.runId, status.runId);
        assert.strictEqual(retro.status, "findings");
        assert.strictEqual(retro.cleanupStatus, "not-completed");
        assert.include(
          retro.missed.map((entry) => entry.summary).join("\n"),
          "Plan needs concrete evidence promotion handling.",
        );
        assert.include(
          retro.misled.map((entry) => entry.summary).join("\n"),
          "Plan review blocked evidence promotion.",
        );
        assert.isFalse(yield* fs.exists(`${status.runDirectory}/report.md`));
        assert.isFalse(yield* fs.exists(`${status.runDirectory}/report.json`));
        assert.isUndefined(promotion.reportPaths.reportMarkdownPath);
        assert.isUndefined(promotion.reportPaths.reportJsonPath);
        const reportEvidence = promotion.selectedEvidence.find(
          (evidence) => evidence.label === "Run report",
        );
        assert.strictEqual(reportEvidence?.status, "skipped");
        assert.isUndefined(reportEvidence?.path);
        assert.include(
          promotion.markdown,
          "- Report markdown: skipped\n- Report JSON: skipped",
        );
      }),
    );

    it.effect("classifies repeated generic plan blockers consistently", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
          "blocking-plan-reviewer",
        );
        const reviewer: GaiaReviewer = {
          name: reviewerName,
          run: (request) =>
            Effect.succeed(
              ReviewResult.make({
                findings: [
                  ReviewFinding.make({
                    message:
                      "Worker plan is generic and does not name concrete implementation surfaces.",
                    severity: "blocker",
                  }),
                ],
                phase: request.phase,
                resultPath:
                  request.phase === "plan"
                    ? "plan-review.json"
                    : "evidence-review.json",
                reviewerName,
                runId: request.runId,
                status: request.phase === "plan" ? "blocked" : "approved",
                summary:
                  "Codex plan review blocked the run because the worker plan is generic.",
              }),
            ),
        };

        const runBlockedSpec = (body: string) =>
          Effect.gen(function* () {
            const specPath = `${cwd}/${body}.md`;
            yield* fs.writeFileString(specPath, `${body}\n`);
            const error = yield* Effect.flip(
              runSpecFile(specPath, { reviewer, rootDirectory: cwd }),
            );
            assert.isTrue(error instanceof GaiaRuntimeError);
            const status = yield* statusRun(undefined, { rootDirectory: cwd });
            return parseDogfoodRetrospective(
              JSON.parse(
                yield* fs.readFileString(
                  `${status.runDirectory}/dogfood-retrospective.json`,
                ),
              ),
            );
          });

        const gaia1Retrospective = yield* runBlockedSpec("gaia-1-plan-blocker");
        const gaia2Retrospective = yield* runBlockedSpec("gaia-2-plan-blocker");
        const gaia1Finding = gaia1Retrospective.findings[0];
        const gaia2Finding = gaia2Retrospective.findings[0];

        assert.strictEqual(gaia1Finding?.category, "plan-quality");
        assert.strictEqual(gaia2Finding?.category, "plan-quality");
        assert.strictEqual(gaia1Finding?.severity, "blocker");
        assert.strictEqual(gaia2Finding?.severity, "blocker");
        assert.include(gaia1Finding?.summary ?? "", "generic");
        assert.include(gaia2Finding?.summary ?? "", "generic");
        assert.strictEqual(
          gaia1Finding?.candidateIssue?.category,
          "plan-quality",
        );
        assert.include(
          gaia1Finding?.candidateIssue?.bodyMarkdown ?? "",
          "## Acceptance Criteria",
        );
      }),
    );

    it.effect("caps reviewer findings before rendering Linear-ready candidates", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const rawOversizedBody = `RAW_PAYLOAD_${"x".repeat(8_000)}_END`;
        const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
          "oversized-reviewer",
        );
        const reviewer: GaiaReviewer = {
          name: reviewerName,
          run: (request) =>
            Effect.succeed(
              ReviewResult.make({
                findings: [
                  ReviewFinding.make({
                    message: `Reviewer found unsafe output.\n${rawOversizedBody}`,
                    severity: "blocker",
                  }),
                ],
                phase: request.phase,
                resultPath:
                  request.phase === "plan"
                    ? "plan-review.json"
                    : "evidence-review.json",
                reviewerName,
                runId: request.runId,
                status: request.phase === "plan" ? "blocked" : "approved",
                summary: "Reviewer blocked the plan with an oversized finding.",
              }),
            ),
        };
        yield* fs.writeFileString(specPath, "Cap reviewer summaries.\n");

        yield* Effect.flip(
          runSpecFile(specPath, { reviewer, rootDirectory: cwd }),
        );
        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        const retrospective = parseDogfoodRetrospective(
          JSON.parse(
            yield* fs.readFileString(
              `${status.runDirectory}/dogfood-retrospective.json`,
            ),
          ),
        );
        const candidateBody =
          retrospective.linearCandidates
            .map((candidate) => candidate.bodyMarkdown)
            .find((body) => body.includes("Reviewer found unsafe output.")) ??
          "";

        assert.isAtMost(candidateBody.length, 2_000);
        assert.notInclude(candidateBody, rawOversizedBody);
        assert.include(candidateBody, "Reviewer found unsafe output.");
        assert.include(candidateBody, "## Source Evidence");
        assert.include(candidateBody, "plan-review.json");
        assert.notInclude(
          retrospective.findings.map((finding) => finding.summary).join("\n"),
          rawOversizedBody,
        );
      }),
    );

    it.effect("emits Linear-ready candidates for noisy evidence and pre-publish failures", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Publish noisy evidence.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const paths = yield* makeRunPaths(summary.runId, { rootDirectory: cwd });
        const workerResult = parseHarnessRunResultJson(
          JSON.parse(yield* fs.readFileString(paths.workerResult)),
        );
        yield* fs.writeFileString(
          paths.workerResult,
          `${JSON.stringify(
            {
              ...workerResult,
              changedWorkspacePaths: Array.from(
                { length: 4_000 },
                (_, index) => `node_modules/package-${index}/index.js`,
              ),
            },
            null,
            2,
          )}\n`,
        );

        const commands: Array<GitHubCommandInput> = [];
        yield* Effect.flip(
          publishWorkspaceRunToGitHub(summary.runId, {
            commandRunner: githubPublishingRunner(commands),
            rootDirectory: cwd,
          }),
        );

        const retrospective = parseDogfoodRetrospective(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/dogfood-retrospective.json`,
            ),
          ),
        );
        const categories = retrospective.findings.map(
          (finding) => finding.category,
        );
        const evidenceFinding = retrospective.findings.find(
          (finding) => finding.category === "evidence-noise",
        );
        const verificationFinding = retrospective.findings.find(
          (finding) => finding.category === "verification",
        );

        assert.includeMembers(categories, ["evidence-noise", "verification"]);
        assert.isAtLeast(retrospective.candidateIssueCount, 2);
        assert.include(
          evidenceFinding?.candidateIssue?.bodyMarkdown ?? "",
          "## Source Evidence",
        );
        assert.include(
          verificationFinding?.candidateIssue?.title ?? "",
          "pre-publish",
        );
        assert.deepEqual(
          commands.map((command) => [command.command, command.args[0]]),
          workspacePrPreflightCommandSummary(),
        );
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
        const workerPlan = parseWorkerPlanJson(
          JSON.parse(
            yield* fs.readFileString(`${summary.runDirectory}/worker-plan.json`),
          ),
        );

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
        assert.include(reportMarkdown, "Explicit manifest-selected skills");
        assert.include(reportMarkdown, "Inferred recommendations are additive");
        assert.notInclude(
          workerPlan.inferredRecommendations.skills.map(
            (recommendation) => recommendation.name,
          ),
          "coding-standards",
        );
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

    it.effect("observes Node Codex command output through the progress recorder", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const config = makeCodexHarnessConfig({
          command: execPath,
          timeoutMs: 1_000,
        });
        const observations: Array<{
          readonly bytes: number;
          readonly stream: "stderr" | "stdout";
        }> = [];

        const result = yield* nodeCodexCommandRunner({
          args: [
            "-e",
            "process.stdout.write('hello'); process.stderr.write('warn');",
          ],
          command: config.command,
          cwd,
          progressPath: `${cwd}/codex-harness-progress.json`,
          recordProgress: (observation) => {
            observations.push(observation);
            return Promise.resolve();
          },
          stdin: "",
          timeoutMs: config.timeoutMs,
        });

        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout, "hello");
        assert.strictEqual(result.stderr, "warn");
        assert.deepEqual(
          observations.map((observation) => observation.stream).sort(),
          ["stderr", "stdout"],
        );
        assert.isTrue(observations.every((observation) => observation.bytes > 0));
      }),
    );

    it.effect("owns rejected Codex progress recorder promises until process exit", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const config = makeCodexHarnessConfig({
          command: execPath,
          timeoutMs: 1_000,
        });
        let observations = 0;

        const error = yield* Effect.flip(
          nodeCodexCommandRunner({
            args: [
              "-e",
              "process.stdout.write('hello'); setTimeout(() => process.stdout.write('done'), 150);",
            ],
            command: config.command,
            cwd,
            progressPath: `${cwd}/codex-harness-progress.json`,
            recordProgress: () => {
              observations += 1;
              return observations === 1
                ? Promise.reject(
                    makeRuntimeError({
                      code: "TestCodexProgressWriteFailed",
                      message: "Test progress recorder failed.",
                      recoverable: true,
                    }),
                  )
                : Promise.resolve();
            },
            stdin: "",
            timeoutMs: config.timeoutMs,
          }),
        );

        assert.isAtLeast(observations, 1);
        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "TestCodexProgressWriteFailed");
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

            if (
              input.progressPath === undefined ||
              input.recordProgress === undefined
            ) {
              return yield* Effect.fail(
                makeRuntimeError({
                  code: "TestCodexProgressRecorderMissing",
                  message:
                    "Test Codex command did not receive a progress recorder.",
                  recoverable: false,
                }),
              );
            }
            const progressPath = input.progressPath;
            const recordProgress = input.recordProgress;

            const startedProgress = parseCodexHarnessProgressJson(
              JSON.parse(yield* fs.readFileString(progressPath)),
            );
            assert.strictEqual(startedProgress.status, "running");
            assert.isFalse(startedProgress.terminal);
            assert.strictEqual(startedProgress.command, "codex-test");
            assert.strictEqual(startedProgress.cwd, input.cwd);
            assert.strictEqual(startedProgress.timeoutMs, 12345);
            assert.strictEqual(
              startedProgress.lastMessagePath,
              "codex-last-message.md",
            );

            yield* Effect.promise(() =>
              recordProgress({ bytes: 32, stream: "stdout" }),
            );
            const observedProgress = parseCodexHarnessProgressJson(
              JSON.parse(yield* fs.readFileString(progressPath)),
            );
            assert.strictEqual(
              observedProgress.lastObservedOutputStream,
              "stdout",
            );
            assert.isDefined(observedProgress.lastObservedOutputAt);

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
        const progress = parseCodexHarnessProgressJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/codex-harness-progress.json`,
            ),
          ),
        );
        const report = yield* fs.readFileString(
          `${summary.runDirectory}/report.md`,
        );
        const status = yield* statusRun(summary.runId, { rootDirectory: cwd });
        const command = commands[0];

        assert.include(output, "true");
        assert.include(workerLog, "Codex stdout:");
        assert.include(lastMessage, "Codex completed");
        assert.include(harnessResult, '"harnessName": "codex"');
        assert.include(harnessResult, '"changedWorkspacePaths": [');
        assert.include(harnessResult, '"changed.txt"');
        assert.include(harnessResult, '"output.txt"');
        assert.include(harnessResult, '"exitCode": 0');
        assert.strictEqual(progress.status, "completed");
        assert.isTrue(progress.terminal);
        assert.strictEqual(
          progress.progressPath,
          "codex-harness-progress.json",
        );
        assert.strictEqual(
          status.harnessProgressPath,
          `${summary.runDirectory}/codex-harness-progress.json`,
        );
        assert.include(report, "codex-harness-progress.json");
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

    it.effect("records timed-out Codex harness progress before failing the run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const commandRunner: CodexCommandRunner = () =>
          Effect.fail(
            makeRuntimeError({
              code: "CodexCommandTimedOut",
              message: "Codex command 'codex-test' timed out.",
              recoverable: true,
            }),
          );
        yield* fs.writeFileString(specPath, "Run through slow Codex.\n");

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
          assert.strictEqual(error.code, "CodexCommandTimedOut");
          assert.isTrue(error.recoverable);
        }

        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        const progress = parseCodexHarnessProgressJson(
          JSON.parse(
            yield* fs.readFileString(
              `${status.runDirectory}/codex-harness-progress.json`,
            ),
          ),
        );
        assert.strictEqual(status.state, "failed");
        assert.strictEqual(status.status, "failed");
        assert.strictEqual(
          status.harnessProgressPath,
          `${status.runDirectory}/codex-harness-progress.json`,
        );
        assert.strictEqual(progress.status, "timed-out");
        assert.isTrue(progress.terminal);
        assert.strictEqual(progress.stallClassification, "no-progress");
        assert.isUndefined(progress.lastObservedOutputAt);
      }),
    );

    it.effect("records missing last-message Codex progress before failing the run", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        const commandRunner: CodexCommandRunner = (input) =>
          Effect.gen(function* () {
            if (input.recordProgress === undefined) {
              return yield* Effect.fail(
                makeRuntimeError({
                  code: "TestCodexProgressRecorderMissing",
                  message:
                    "Test Codex command did not receive a progress recorder.",
                  recoverable: false,
                }),
              );
            }
            const recordProgress = input.recordProgress;

            yield* Effect.promise(() =>
              recordProgress({ bytes: 17, stream: "stderr" }),
            );
            yield* fs.writeFileString(
              `${input.cwd}/output.txt`,
              `codex harness ${runIdFromCodexPrompt(input.stdin)}\n`,
            );

            return {
              exitCode: 0,
              stderr: "",
              stdout: "",
            };
          });
        yield* fs.writeFileString(specPath, "Run without last message.\n");

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
          assert.strictEqual(error.code, "CodexLastMessageMissing");
          assert.isTrue(error.recoverable);
        }

        const status = yield* statusRun(undefined, { rootDirectory: cwd });
        const progress = parseCodexHarnessProgressJson(
          JSON.parse(
            yield* fs.readFileString(
              `${status.runDirectory}/codex-harness-progress.json`,
            ),
          ),
        );

        assert.strictEqual(status.state, "failed");
        assert.strictEqual(
          status.harnessProgressPath,
          `${status.runDirectory}/codex-harness-progress.json`,
        );
        assert.strictEqual(progress.status, "last-message-missing");
        assert.isTrue(progress.terminal);
        assert.strictEqual(progress.lastMessagePath, "codex-last-message.md");
        assert.strictEqual(progress.lastObservedOutputStream, "stderr");
        assert.strictEqual(progress.stallClassification, "progress-observed");
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
          assert.include(
            command.stdin,
            "Inspect the worker plan acceptance criteria, non-goals, likely touched surfaces, verification checks, and stop conditions.",
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

    it.effect("summarizes generated workspace churn in harness evidence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const scriptPath = `${cwd}/process-harness.mjs`;
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          scriptPath,
          [
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "mkdirSync(`${process.env.GAIA_WORKSPACE_PATH}/src`, { recursive: true });",
            "mkdirSync(`${process.env.GAIA_WORKSPACE_PATH}/node_modules/noisy`, { recursive: true });",
            "mkdirSync(`${process.env.GAIA_WORKSPACE_PATH}/dist/assets`, { recursive: true });",
            "mkdirSync(`${process.env.GAIA_WORKSPACE_PATH}/.turbo/cache`, { recursive: true });",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness ${process.env.GAIA_RUN_ID}\\n`);",
            "writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/README.md`, '# Product change\\n');",
            "writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/src/feature.ts`, 'export const enabled = true;\\n');",
            "for (let index = 0; index < 80; index += 1) {",
            "  writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/node_modules/noisy/file-${index}.js`, `module.exports = ${index};\\n`);",
            "  writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/dist/assets/chunk-${index}.js`, `console.log(${index});\\n`);",
            "}",
            "writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/.turbo/cache/trace.log`, 'cache metadata\\n');",
          ].join("\n"),
        );
        yield* fs.writeFileString(specPath, "Run with generated churn.\n");

        const summary = yield* runSpecFile(specPath, {
          harnessName: parseHarnessName("process"),
          processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
          rootDirectory: cwd,
        });

        const harnessResult = parseHarnessRunResultJson(
          JSON.parse(
            yield* fs.readFileString(
              `${summary.runDirectory}/worker-result.json`,
            ),
          ),
        );
        const evidenceReview = yield* fs.readFileString(
          `${summary.runDirectory}/evidence-review.md`,
        );
        const workspaceDiff = harnessResult.workspaceDiff;
        const encoded = JSON.stringify(harnessResult);

        assert.isDefined(workspaceDiff);
        if (workspaceDiff === undefined) {
          assert.fail("Expected process harness to write workspace diff evidence.");
        }
        assert.deepEqual(harnessResult.changedWorkspacePaths, [
          "README.md",
          "output.txt",
          "src/feature.ts",
        ]);
        assert.deepEqual(workspaceDiff.productChangedPaths, [
          "README.md",
          "output.txt",
          "src/feature.ts",
        ]);
        assert.deepEqual(
          workspaceDiff.omittedGeneratedPaths.map((entry) => entry.path),
          [".turbo", "dist", "node_modules"],
        );
        assert.include(
          workspaceDiff.omittedGeneratedPaths[0]?.reason,
          "generated",
        );
        assert.isBelow(encoded.length, 5_000);
        assert.notInclude(encoded, "node_modules/noisy/file-79.js");
        assert.notInclude(encoded, "dist/assets/chunk-79.js");
        assert.notInclude(encoded, ".turbo/cache/trace.log");
        assert.include(evidenceReview, "Workspace product changes (3)");
        assert.include(
          evidenceReview,
          "Generated workspace paths omitted from product diff evidence (3)",
        );
        assert.include(evidenceReview, "node_modules");
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
        assert.isDefined(preview.workspaceGate);
        assert.strictEqual(preview.workspaceGate?.status, "passed");
        assert.strictEqual(
          preview.workspaceGate?.artifactPath,
          "workspace-pr-gate.json",
        );
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

    it.effect("previews a workspace PR with blocked gate results for giant worker-result evidence", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Preview giant worker result.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const paths = yield* makeRunPaths(summary.runId, { rootDirectory: cwd });
        const workerResult = parseHarnessRunResultJson(
          JSON.parse(yield* fs.readFileString(paths.workerResult)),
        );
        yield* fs.writeFileString(
          paths.workerResult,
          `${JSON.stringify(
            {
              ...workerResult,
              summary: "x".repeat(70_000),
            },
            null,
            2,
          )}\n`,
        );

        const preview = yield* previewGitHubPublish(summary.runId, {
          commandRunner: githubPublishingRunner([]),
          mode: "workspace",
          rootDirectory: cwd,
        });

        const gate = preview.workspaceGate;
        assert.isDefined(gate);
        if (gate === undefined) {
          return;
        }

        const gateArtifact = parseWorkspacePrQualityGateJson(
          JSON.parse(yield* fs.readFileString(paths.workspacePrGate)),
        );
        const sizeItem = gate.items.find(
          (item) => item.check === "worker-result-reviewable-size",
        );

        assert.strictEqual(gate.status, "blocked");
        assert.strictEqual(gate.failItemCount, 1);
        assert.isDefined(sizeItem);
        assert.deepEqual(sizeItem?.changedFiles, ["worker-result.json"]);
        assert.strictEqual(sizeItem?.severity, "fail");
        assert.include(sizeItem?.reason ?? "", "above the");
        assert.include(sizeItem?.remediation ?? "", "bounded workspaceDiff");
        assert.strictEqual(gateArtifact.status, "blocked");
      }),
    );

    it.effect("refuses to publish a workspace PR when changed source casts as RunId", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const scriptPath = `${cwd}/process-harness.mjs`;
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          scriptPath,
          [
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "mkdirSync(`${process.env.GAIA_WORKSPACE_PATH}/src`, { recursive: true });",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness ${process.env.GAIA_RUN_ID}\\n`);",
            "writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/src/bad-run-id.ts`, 'import type { RunId } from \"@gaia/core\";\\nexport const runId = \"run-V7kP9sQ2xY\" as RunId;\\n');",
          ].join("\n"),
        );
        yield* fs.writeFileString(specPath, "Publish bad RunId cast.\n");
        const summary = yield* runSpecFile(specPath, {
          harnessName: parseHarnessName("process"),
          processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
          rootDirectory: cwd,
        });
        const commands: Array<GitHubCommandInput> = [];
        const error = yield* Effect.flip(
          publishWorkspaceRunToGitHub(summary.runId, {
            commandRunner: githubPublishingRunner(commands),
            rootDirectory: cwd,
          }),
        );
        const paths = yield* makeRunPaths(summary.runId, { rootDirectory: cwd });
        const gate = parseWorkspacePrQualityGateJson(
          JSON.parse(yield* fs.readFileString(paths.workspacePrGate)),
        );
        const runIdCastItem = gate.items.find(
          (item) => item.check === "run-id-brand-cast",
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "WorkspacePrQualityGateFailed");
          assert.include(error.message, "src/bad-run-id.ts");
          assert.include(error.message, "parseRunId");
        }
        assert.strictEqual(gate.status, "blocked");
        assert.isDefined(runIdCastItem);
        assert.deepEqual(runIdCastItem?.changedFiles, ["src/bad-run-id.ts"]);
        assert.strictEqual(runIdCastItem?.severity, "fail");
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

    it.effect("does not block a workspace PR when changed source only mentions as RunId in comments and strings", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const scriptPath = `${cwd}/process-harness.mjs`;
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          scriptPath,
          [
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "mkdirSync(`${process.env.GAIA_WORKSPACE_PATH}/src`, { recursive: true });",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness ${process.env.GAIA_RUN_ID}\\n`);",
            "writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/src/run-id-text.ts`, '// do not use as RunId in source\\nexport const note = \"as RunId appears in regression text\";\\nexport const templateNote = `as RunId appears in template text`;\\n');",
          ].join("\n"),
        );
        yield* fs.writeFileString(specPath, "Publish RunId text fixture.\n");
        const summary = yield* runSpecFile(specPath, {
          harnessName: parseHarnessName("process"),
          processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
          rootDirectory: cwd,
        });

        const preview = yield* previewGitHubPublish(summary.runId, {
          commandRunner: githubPublishingRunner([]),
          mode: "workspace",
          rootDirectory: cwd,
        });
        const runIdCastItem = preview.workspaceGate?.items.find(
          (item) => item.check === "run-id-brand-cast",
        );

        assert.strictEqual(preview.workspaceGate?.status, "passed");
        assert.isUndefined(runIdCastItem);
      }),
    );

    it.effect("refuses to publish a workspace PR when changed source casts as RunId inside template interpolation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const scriptPath = `${cwd}/process-harness.mjs`;
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          scriptPath,
          [
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "mkdirSync(`${process.env.GAIA_WORKSPACE_PATH}/src`, { recursive: true });",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness ${process.env.GAIA_RUN_ID}\\n`);",
            "writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/src/template-run-id.ts`, 'import type { RunId } from \"@gaia/core\";\\nconst raw = \"run-V7kP9sQ2xY\";\\nexport const label = `${raw as RunId}`;\\n');",
          ].join("\n"),
        );
        yield* fs.writeFileString(specPath, "Publish template RunId cast.\n");
        const summary = yield* runSpecFile(specPath, {
          harnessName: parseHarnessName("process"),
          processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
          rootDirectory: cwd,
        });
        const commands: Array<GitHubCommandInput> = [];
        const error = yield* Effect.flip(
          publishWorkspaceRunToGitHub(summary.runId, {
            commandRunner: githubPublishingRunner(commands),
            rootDirectory: cwd,
          }),
        );
        const paths = yield* makeRunPaths(summary.runId, { rootDirectory: cwd });
        const gate = parseWorkspacePrQualityGateJson(
          JSON.parse(yield* fs.readFileString(paths.workspacePrGate)),
        );
        const runIdCastItem = gate.items.find(
          (item) => item.check === "run-id-brand-cast",
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "WorkspacePrQualityGateFailed");
          assert.include(error.message, "src/template-run-id.ts");
        }
        assert.strictEqual(gate.status, "blocked");
        assert.deepEqual(runIdCastItem?.changedFiles, [
          "src/template-run-id.ts",
        ]);
        assert.deepEqual(
          commands.map((command) => [command.command, command.args[0]]),
          workspacePrPreflightCommandSummary(),
        );
      }),
    );

    it.effect("refuses to publish a workspace PR when omitted generated paths are unsafe", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Publish unsafe generated path.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const paths = yield* makeRunPaths(summary.runId, { rootDirectory: cwd });
        const workerResult = parseHarnessRunResultJson(
          JSON.parse(yield* fs.readFileString(paths.workerResult)),
        );
        const workspaceDiff = workerResult.workspaceDiff;
        if (workspaceDiff === undefined) {
          assert.fail("Expected test fixture to include workspaceDiff.");
          return;
        }
        yield* fs.writeFileString(
          paths.workerResult,
          `${JSON.stringify(
            {
              ...workerResult,
              workspaceDiff: {
                ...workspaceDiff,
                omittedGeneratedFileCount: 1,
                omittedGeneratedPathCount: 1,
                omittedGeneratedPaths: [
                  {
                    changedFileCount: 1,
                    path: "../dist",
                    reason: "unsafe generated path fixture",
                  },
                ],
              },
            },
            null,
            2,
          )}\n`,
        );

        const commands: Array<GitHubCommandInput> = [];
        const error = yield* Effect.flip(
          publishWorkspaceRunToGitHub(summary.runId, {
            commandRunner: githubPublishingRunner(commands),
            rootDirectory: cwd,
          }),
        );
        const gate = parseWorkspacePrQualityGateJson(
          JSON.parse(yield* fs.readFileString(paths.workspacePrGate)),
        );
        const unsafePathItem = gate.items.find(
          (item) => item.check === "workspace-diff-generated-safe-paths",
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "WorkspacePrQualityGateFailed");
        }
        assert.strictEqual(gate.status, "blocked");
        assert.deepEqual(unsafePathItem?.changedFiles, ["../dist"]);
        assert.deepEqual(
          commands.map((command) => [command.command, command.args[0]]),
          workspacePrPreflightCommandSummary(),
        );
      }),
    );

    it.effect("refuses to publish a workspace PR when changedWorkspacePaths are unsafe", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Publish unsafe changed path.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const paths = yield* makeRunPaths(summary.runId, { rootDirectory: cwd });
        const workerResult = parseHarnessRunResultJson(
          JSON.parse(yield* fs.readFileString(paths.workerResult)),
        );
        yield* fs.writeFileString(
          paths.workerResult,
          `${JSON.stringify(
            {
              ...workerResult,
              changedWorkspacePaths: ["../src/leak.ts"],
            },
            null,
            2,
          )}\n`,
        );

        const commands: Array<GitHubCommandInput> = [];
        const error = yield* Effect.flip(
          publishWorkspaceRunToGitHub(summary.runId, {
            commandRunner: githubPublishingRunner(commands),
            rootDirectory: cwd,
          }),
        );
        const gate = parseWorkspacePrQualityGateJson(
          JSON.parse(yield* fs.readFileString(paths.workspacePrGate)),
        );
        const unsafePathItem = gate.items.find(
          (item) => item.check === "changed-workspace-safe-paths",
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "WorkspacePrQualityGateFailed");
        }
        assert.strictEqual(gate.status, "blocked");
        assert.deepEqual(unsafePathItem?.changedFiles, ["../src/leak.ts"]);
        assert.deepEqual(
          commands.map((command) => [command.command, command.args[0]]),
          workspacePrPreflightCommandSummary(),
        );
      }),
    );

    it.effect("refuses to publish a workspace PR when worker-result resultPath is unsafe", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Publish unsafe result path.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const paths = yield* makeRunPaths(summary.runId, { rootDirectory: cwd });
        const workerResult = parseHarnessRunResultJson(
          JSON.parse(yield* fs.readFileString(paths.workerResult)),
        );
        yield* fs.writeFileString(
          paths.workerResult,
          `${JSON.stringify(
            {
              ...workerResult,
              resultPath: "/Users/cillian/project/.gaia/run/worker-result.json",
            },
            null,
            2,
          )}\n`,
        );

        const commands: Array<GitHubCommandInput> = [];
        const error = yield* Effect.flip(
          publishWorkspaceRunToGitHub(summary.runId, {
            commandRunner: githubPublishingRunner(commands),
            rootDirectory: cwd,
          }),
        );
        const gate = parseWorkspacePrQualityGateJson(
          JSON.parse(yield* fs.readFileString(paths.workspacePrGate)),
        );
        const unsafePathItem = gate.items.find(
          (item) => item.check === "worker-result-safe-paths",
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "WorkspacePrQualityGateFailed");
        }
        assert.strictEqual(gate.status, "blocked");
        assert.deepEqual(unsafePathItem?.changedFiles, [
          "/Users/cillian/project/.gaia/run/worker-result.json",
        ]);
        assert.deepEqual(
          commands.map((command) => [command.command, command.args[0]]),
          workspacePrPreflightCommandSummary(),
        );
      }),
    );

    it.effect("refuses to publish a workspace PR when outputArtifacts contain unsafe workspace paths", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Publish unsafe output artifact.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const paths = yield* makeRunPaths(summary.runId, { rootDirectory: cwd });
        const workerResult = parseHarnessRunResultJson(
          JSON.parse(yield* fs.readFileString(paths.workerResult)),
        );
        yield* fs.writeFileString(
          paths.workerResult,
          `${JSON.stringify(
            {
              ...workerResult,
              outputArtifacts: ["workspace/../secret.txt"],
            },
            null,
            2,
          )}\n`,
        );

        const commands: Array<GitHubCommandInput> = [];
        const error = yield* Effect.flip(
          publishWorkspaceRunToGitHub(summary.runId, {
            commandRunner: githubPublishingRunner(commands),
            rootDirectory: cwd,
          }),
        );
        const gate = parseWorkspacePrQualityGateJson(
          JSON.parse(yield* fs.readFileString(paths.workspacePrGate)),
        );
        const unsafePathItem = gate.items.find(
          (item) => item.check === "output-artifact-safe-paths",
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "WorkspacePrQualityGateFailed");
        }
        assert.strictEqual(gate.status, "blocked");
        assert.deepEqual(unsafePathItem?.changedFiles, [
          "workspace/../secret.txt",
        ]);
        assert.deepEqual(
          commands.map((command) => [command.command, command.args[0]]),
          workspacePrPreflightCommandSummary(),
        );
      }),
    );

    it.effect("reports invalid worker-result JSON as a gate failure before workspace PR mutation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Publish invalid worker result.\n");
        const summary = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const paths = yield* makeRunPaths(summary.runId, { rootDirectory: cwd });
        yield* fs.writeFileString(paths.workerResult, "{");

        const commands: Array<GitHubCommandInput> = [];
        const error = yield* Effect.flip(
          publishWorkspaceRunToGitHub(summary.runId, {
            commandRunner: githubPublishingRunner(commands),
            rootDirectory: cwd,
          }),
        );
        const gate = parseWorkspacePrQualityGateJson(
          JSON.parse(yield* fs.readFileString(paths.workspacePrGate)),
        );
        const jsonItem = gate.items.find(
          (item) => item.check === "worker-result-json",
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "WorkspacePrQualityGateFailed");
          assert.include(error.message, "worker-result.json");
        }
        assert.strictEqual(gate.status, "blocked");
        assert.isDefined(jsonItem);
        assert.deepEqual(jsonItem?.changedFiles, ["worker-result.json"]);
        assert.strictEqual(jsonItem?.severity, "fail");
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

    it.effect("copies bounded workspace diff evidence into a GitHub evidence PR", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const scriptPath = `${cwd}/process-harness.mjs`;
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(
          scriptPath,
          [
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            "mkdirSync(`${process.env.GAIA_WORKSPACE_PATH}/node_modules/noisy`, { recursive: true });",
            "mkdirSync(`${process.env.GAIA_WORKSPACE_PATH}/dist`, { recursive: true });",
            "writeFileSync(process.env.GAIA_WORKSPACE_OUTPUT_PATH, `process harness ${process.env.GAIA_RUN_ID}\\n`);",
            "writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/src.ts`, 'export const changed = true;\\n');",
            "for (let index = 0; index < 80; index += 1) {",
            "  writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/node_modules/noisy/file-${index}.js`, `module.exports = ${index};\\n`);",
            "  writeFileSync(`${process.env.GAIA_WORKSPACE_PATH}/dist/chunk-${index}.js`, `console.log(${index});\\n`);",
            "}",
          ].join("\n"),
        );
        yield* fs.writeFileString(specPath, "Publish bounded evidence.\n");
        const summary = yield* runSpecFile(specPath, {
          harnessName: parseHarnessName("process"),
          processHarness: makeProcessHarnessConfig(execPath, [scriptPath]),
          rootDirectory: cwd,
        });
        const commands: Array<GitHubCommandInput> = [];
        const runner = githubPublishingRunner(commands, {
          prUrl: "https://github.com/cill-i-am/gaia/pull/789\n",
        });

        const pr = yield* publishRunToGitHub(summary.runId, {
          commandRunner: runner,
          rootDirectory: cwd,
        });

        const copiedWorkerResult = yield* fs.readFileString(
          `${cwd}/gaia-runs/${summary.runId}/worker-result.json`,
        );
        assert.strictEqual(
          pr.prUrl,
          "https://github.com/cill-i-am/gaia/pull/789",
        );
        assert.include(copiedWorkerResult, '"workspaceDiff": {');
        assert.include(copiedWorkerResult, '"src.ts"');
        assert.include(copiedWorkerResult, '"node_modules"');
        assert.include(copiedWorkerResult, '"dist"');
        assert.notInclude(copiedWorkerResult, "node_modules/noisy/file-79.js");
        assert.notInclude(copiedWorkerResult, "dist/chunk-79.js");
        assert.isBelow(copiedWorkerResult.length, 5_000);
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
        const evidenceGate = parseWorkspacePrQualityGateJson(
          JSON.parse(
            yield* fs.readFileString(
              `${source}/gaia-runs/${summary.runId}/workspace-pr-gate.json`,
            ),
          ),
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
        assert.strictEqual(pr.workspaceGate?.status, "passed");
        assert.strictEqual(evidenceGate.status, "passed");
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

    it.effect("classifies GitHub checks into operator-facing states", () =>
      Effect.gen(function* () {
        const cwd = yield* tempDirectory;
        const noChecks = yield* inspectGitHubChecks("1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 1,
            stderr: "no checks reported on the 'gaia/example' branch\n",
            stdout: "",
          })),
          rootDirectory: cwd,
        });
        const pending = yield* inspectGitHubChecks("1", {
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
        const green = yield* inspectGitHubChecks("1", {
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
        const failing = yield* inspectGitHubChecks("1", {
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
        const providerUnavailable = yield* inspectGitHubChecks("1", {
          commandRunner: recordingGitHubRunner([], () => ({
            exitCode: 1,
            stderr: "GraphQL: Resource not accessible by integration\n",
            stdout: "",
          })),
          rootDirectory: cwd,
        });

        assert.strictEqual(green.status, "green");
        assert.strictEqual(failing.status, "failing");
        assert.strictEqual(pending.status, "pending");
        assert.strictEqual(noChecks.status, "no-checks-configured");
        assert.strictEqual(noChecks.checks.length, 0);
        assert.strictEqual(providerUnavailable.status, "provider-unavailable");
        assert.strictEqual(providerUnavailable.checks.length, 0);
      }),
    );

    it("decodes legacy GitHub check statuses as operator-facing states", () => {
      const state = parseGitHubCiWatchStateJson({
        attempts: 1,
        lastSnapshotPath: "github-checks/checks-1.json",
        lastStatus: "passed",
        nextAction: "complete",
        pr: "1",
        runId: parseRunId("run-V7kP9sQ2xY"),
        terminal: true,
        updatedAt: "2026-07-06T10:00:00.000Z",
        version: 1,
      });

      assert.strictEqual(state.lastStatus, "green");
    });

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

        assert.strictEqual(recorded.status, "green");
        assert.strictEqual(recorded.attempts, 1);
        assert.isTrue(recorded.terminal);
        assert.include(snapshot, '"status": "green"');
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

    it.effect("reports the active PR-loop operation when the run store is locked", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Lock with metadata.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const store = yield* makeRunStorePaths({ rootDirectory: cwd });
        yield* fs.makeDirectory(store.lock);
        yield* fs.writeFileString(
          `${store.lock}/metadata.json`,
          `${JSON.stringify({
            acquiredAt: "2026-07-05T10:00:00.000Z",
            nextSafeAction: "Wait for the active command, then rerun pnpm gaia pr-loop.",
            operation: "GitHub CI watch",
            version: 1,
          })}\n`,
        );

        const error = yield* Effect.flip(
          watchGitHubFeedback(run.runId, "1", {
            commandRunner: recordingGitHubRunner([], () => ({
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify(prFeedbackView()),
            })),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "RunStoreLocked");
          assert.isTrue(error.recoverable);
          assert.include(error.message, "GitHub CI watch");
          assert.include(error.message, "rerun pnpm gaia pr-loop");
        }
      }),
    );

    it.effect("reuses GitHub check evidence for the same run, PR, and head", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Idempotent checks.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const runner = recordingGitHubRunner([], (input) => {
          const args = input.args.join(" ");
          if (args === "pr view 1 --json headRefOid") {
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({ headRefOid: "abc123" }),
            };
          }

          return {
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
          };
        });

        const first = yield* recordGitHubChecks(run.runId, "1", {
          commandRunner: runner,
          rootDirectory: cwd,
        });
        const second = yield* recordGitHubChecks(run.runId, "1", {
          commandRunner: runner,
          rootDirectory: cwd,
        });
        const events = yield* readRunEvents(fs, run.runDirectory);

        assert.strictEqual(second.snapshotPath, first.snapshotPath);
        assert.strictEqual(second.watchStatePath, first.watchStatePath);
        assert.strictEqual(
          events.filter((event) => event.type === "GITHUB_CHECKS_RECORDED")
            .length,
          1,
        );
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
          commandRunner: recordingGitHubRunner([], (input) => {
            if (!input.args.join(" ").startsWith("pr checks")) {
              return {
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify({ headRefOid: "abc123" }),
              };
            }

            const state = checksCalls === 0 ? "PENDING" : "SUCCESS";
            checksCalls += 1;
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify([
                {
                  link: "https://github.com/cill-i-am/gaia/actions/runs/1",
                  name: "check",
                  state,
                  workflow: "CI",
                },
              ]),
            };
          }),
          pollInterval: "0 millis",
          rootDirectory: cwd,
          waitForTerminal: true,
        });

        assert.strictEqual(recorded.status, "green");
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
          commandRunner: recordingGitHubRunner([], (input) => {
            if (input.args.join(" ").startsWith("pr checks")) {
              checksCalls += 1;
            }
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

        assert.strictEqual(watched.status, "failing");
        assert.strictEqual(watched.source, "recorded");
        assert.isTrue(watched.terminal);
        assert.strictEqual(watched.nextAction, "fix-failed-checks");
        assert.strictEqual(watched.failedChecks.length, 1);
        assert.strictEqual(watched.failedChecks[0]?.name, "test");
        assert.strictEqual(watchState.nextAction, "fix-failed-checks");
        assert.strictEqual(watchState.lastStatus, "failing");
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

        assert.strictEqual(watched.status, "green");
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

        assert.strictEqual(watched.status, "green");
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

    it.effect("reuses PR feedback evidence for the same run, PR, and head", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Idempotent PR feedback.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const runner = recordingGitHubRunner([], () => ({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(
            prFeedbackView({
              headRefOid: "abc123",
              reviewDecision: "APPROVED",
            }),
          ),
        }));

        const first = yield* watchGitHubFeedback(run.runId, "1", {
          commandRunner: runner,
          rootDirectory: cwd,
        });
        const second = yield* watchGitHubFeedback(run.runId, "1", {
          commandRunner: runner,
          rootDirectory: cwd,
        });
        const events = yield* readRunEvents(fs, run.runDirectory);

        assert.strictEqual(second.feedbackPath, first.feedbackPath);
        assert.strictEqual(second.status, first.status);
        assert.strictEqual(
          events.filter((event) => event.type === "GITHUB_FEEDBACK_RECORDED")
            .length,
          1,
        );
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

    it.effect("coordinates unavailable check provider as a distinct blocker", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Coordinate unavailable CI.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const summary = yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], (input) => {
            if (input.args.join(" ").startsWith("pr checks")) {
              return {
                exitCode: 1,
                stderr: "GraphQL: Resource not accessible by integration\n",
                stdout: "",
              };
            }

            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify(
                prFeedbackView({
                  reviewDecision: "APPROVED",
                }),
              ),
            };
          }),
          rootDirectory: cwd,
        });

        assert.strictEqual(summary.status, "blocked");
        assert.strictEqual(summary.checksStatus, "provider-unavailable");
        assert.strictEqual(summary.nextAction, "restore-check-provider");
        assert.deepStrictEqual(
          summary.blockers.map((blocker) => blocker.kind),
          ["provider-unavailable"],
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

    it.effect("reuses PR-loop evidence for the same run, PR, and head", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Idempotent PR loop.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });
        const runner = recordingGitHubRunner([], (input) => {
          const args = input.args.join(" ");
          if (args === "pr view 1 --json headRefOid") {
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({ headRefOid: "abc123" }),
            };
          }

          if (args.startsWith("pr checks")) {
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
              prFeedbackView({
                headRefOid: "abc123",
                reviewDecision: "APPROVED",
              }),
            ),
          };
        });

        const first = yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: runner,
          rootDirectory: cwd,
        });
        const second = yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: runner,
          rootDirectory: cwd,
        });
        const events = yield* readRunEvents(fs, run.runDirectory);

        assert.strictEqual(second.checksPath, first.checksPath);
        assert.strictEqual(second.feedbackPath, first.feedbackPath);
        assert.strictEqual(second.statePath, first.statePath);
        assert.strictEqual(
          events.filter((event) => event.type === "GITHUB_CHECKS_RECORDED")
            .length,
          1,
        );
        assert.strictEqual(
          events.filter((event) => event.type === "GITHUB_FEEDBACK_RECORDED")
            .length,
          1,
        );
        assert.strictEqual(
          events.filter((event) => event.type === "GITHUB_PR_LOOP_RECORDED")
            .length,
          1,
        );
      }),
    );

    it.effect("rejects PR-loop evidence from mismatched PR heads", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Reject mismatched PR heads.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const error = yield* Effect.flip(
          coordinateGitHubPrLoop(run.runId, "1", {
            commandRunner: recordingGitHubRunner([], (input) => {
              const args = input.args.join(" ");
              if (args === "pr view 1 --json headRefOid") {
                return {
                  exitCode: 0,
                  stderr: "",
                  stdout: JSON.stringify({ headRefOid: "checks-head" }),
                };
              }

              if (args.startsWith("pr checks")) {
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
                  prFeedbackView({
                    headRefOid: "feedback-head",
                    reviewDecision: "APPROVED",
                  }),
                ),
              };
            }),
            rootDirectory: cwd,
          }),
        );

        assert.isTrue(error instanceof GaiaRuntimeError);
        if (error instanceof GaiaRuntimeError) {
          assert.strictEqual(error.code, "GitHubPrHeadMismatch");
          assert.isTrue(error.recoverable);
        }
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

    it.effect("approves merge decision when no CI is configured and local verification evidence exists", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "gaia-runtime-" });
        const specPath = `${cwd}/spec.md`;
        yield* fs.writeFileString(specPath, "Approve no-CI merge decision.\n");
        const run = yield* runSpecFile(specPath, { rootDirectory: cwd });

        const prLoop = yield* coordinateGitHubPrLoop(run.runId, "1", {
          commandRunner: recordingGitHubRunner([], (input) => {
            if (input.args.join(" ").startsWith("pr checks")) {
              return {
                exitCode: 1,
                stderr: "no checks reported on the 'gaia/example' branch\n",
                stdout: "",
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
        const verificationLog = yield* fs.readFileString(
          `${run.runDirectory}/verification.log`,
        );

        assert.strictEqual(prLoop.status, "ready");
        assert.strictEqual(prLoop.checksStatus, "no-checks-configured");
        assert.strictEqual(summary.status, "approved");
        assert.strictEqual(summary.nextAction, "ready-to-merge");
        assert.strictEqual(summary.blockerCount, 0);
        assert.include(verificationLog, "Verification passed.");
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

function writeReferencePlanningFixture(root: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(root, { recursive: true });
    const files: ReadonlyArray<readonly [string, string]> = [
      [
        "AGENTS.md",
        [
          "# Agent Instructions",
          "",
          "- Use pnpm for installs, scripts, workspace commands, and one-off package execution.",
          "- Keep the control plane boring, inspectable, and resumable.",
          "- Parse boundary input immediately with Effect Schema or the owning parser.",
          "- Do not add live Linear sync, dashboards, auth, SQLite, or merge automation unless explicitly asked.",
        ].join("\n"),
      ],
      [
        "apps/AGENTS.md",
        [
          "# Apps Intent",
          "",
          "- Keep app code thin.",
          "- App inputs are boundary input.",
        ].join("\n"),
      ],
      [
        "apps/cli/AGENTS.md",
        [
          "# CLI Intent",
          "",
          "- CLI handlers parse arguments, call runtime, then render output.",
          "- Do not execute workflow work directly in the CLI.",
        ].join("\n"),
      ],
      [
        "packages/AGENTS.md",
        [
          "# Packages Intent",
          "",
          "- Preserve dependency direction: app -> runtime -> core.",
          "- Prefer package-local tests for package behavior.",
        ].join("\n"),
      ],
      [
        "packages/core/AGENTS.md",
        [
          "# Core Intent",
          "",
          "- Core owns pure Gaia contracts, schemas, run IDs, and report models.",
          "- Keep persisted event payloads plain and serializable.",
        ].join("\n"),
      ],
      [
        "packages/runtime/AGENTS.md",
        [
          "# Runtime Intent",
          "",
          "- Runtime owns Gaia Effect workflows and side effects.",
          "- Keep runtime payloads JSON-safe.",
        ].join("\n"),
      ],
      [
        "docs/AGENTS.md",
        [
          "# Docs Intent",
          "",
          "- Keep implementation slices in narrow phase specs.",
          "- Do not turn product docs into API implementation.",
        ].join("\n"),
      ],
      [
        "package.json",
        [
          "{",
          '  "name": "gaia-fixture",',
          '  "private": true,',
          '  "workspaces": ["apps/*", "packages/*"]',
          "}",
        ].join("\n"),
      ],
      [
        "packages/core/package.json",
        [
          "{",
          '  "name": "@gaia/core",',
          '  "scripts": { "test": "vitest run src/core.test.ts" }',
          "}",
        ].join("\n"),
      ],
      [
        "packages/runtime/package.json",
        [
          "{",
          '  "name": "@gaia/runtime",',
          '  "scripts": { "test": "vitest run src/runtime.test.ts" }',
          "}",
        ].join("\n"),
      ],
      [
        "apps/cli/package.json",
        [
          "{",
          '  "name": "@gaia/cli",',
          '  "scripts": { "test": "vitest run src/main.test.ts" }',
          "}",
        ].join("\n"),
      ],
      [
        "apps/server/package.json",
        [
          "{",
          '  "name": "@gaia/server",',
          '  "scripts": { "test": "vitest run src/api.test.ts" }',
          "}",
        ].join("\n"),
      ],
      [
        "packages/core/src/server-api.ts",
        "export const serverApiContract = 'POST /runs';\n",
      ],
      [
        "packages/core/src/server-api.test.ts",
        "it('parses server API artifacts', () => {});\n",
      ],
      [
        "packages/core/src/evidence-promotion.ts",
        "export const evidencePromotionContract = 'cleanup status';\n",
      ],
      [
        "packages/runtime/src/run-read-api.ts",
        "export const readRunArtifact = 'worker-plan';\n",
      ],
      [
        "packages/runtime/src/evidence-promotion.ts",
        "export const promoteEvidence = 'evidence-promotion';\n",
      ],
      [
        "packages/runtime/src/runtime.test.ts",
        "it('promotes selected evidence before raw run cleanup', () => {});\n",
      ],
      ["apps/server/src/api.ts", "export const api = 'HttpApiBuilder.group';\n"],
      ["apps/server/src/main.ts", "export const main = 'gaia server';\n"],
      ["apps/server/src/api.test.ts", "it('serves POST /runs', () => {});\n"],
      ["apps/cli/src/main.ts", "export const cli = 'gaia server';\n"],
      ["apps/cli/src/main.test.ts", "it('reads server artifacts', () => {});\n"],
      [
        "docs/operator-model.md",
        "# Operator Model\n\nLocal artifact writing remains explicit and resumable.\n",
      ],
      [
        "docs/post-harness-roadmap.md",
        "# Post Harness Roadmap\n\nIntroduce gaia server while preserving direct local runtime commands.\n",
      ],
      [
        "docs/agents/worker-thread-template.md",
        "# Worker Thread Template\n\nRecord branch, evidence, review stack, verification, and cleanup expectations.\n",
      ],
      [
        "docs/agents/reviewer-thread-template.md",
        "# Reviewer Thread Template\n\nReview spec adherence, simplicity, standards, tests, and residual risk.\n",
      ],
    ];

    for (const [relativePath, body] of files) {
      const segments = relativePath.split("/");
      const directory = segments.slice(0, -1).join("/");
      if (directory.length > 0) {
        yield* fs.makeDirectory(`${root}/${directory}`, { recursive: true });
      }
      yield* fs.writeFileString(`${root}/${relativePath}`, `${body}\n`);
    }
  });
}

function writeGaia12ReviewerFindingsFixture(root: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const findings = {
      findings: [
        {
          id: "gaia-12-built-server-binary",
          severity: "warning",
          sourceStatus: "historical-risk",
          sources: [
            {
              label: "GAIA-12 accepted PR",
              pullRequest: "#15",
              url: "https://github.com/cill-i-am/gaia/pull/15",
            },
          ],
          summary:
            "The local server lane needed a built server binary smoke because source-level tests did not prove package bin resolution.",
          surfaces: ["apps/server", "server api", "package manifest"],
          title: "Built server binary smoke was missed",
          verificationPrompts: [
            "Smoke the built server binary, not only TypeScript source paths.",
          ],
        },
        {
          id: "gaia-12-package-barrel-import-drag",
          severity: "warning",
          sourceStatus: "historical-risk",
          sources: [
            {
              artifactPath: "plan-review.json",
              label: "GAIA-12 reviewer artifact",
              url: "https://github.com/cill-i-am/gaia/pull/15#discussion_r1",
            },
          ],
          summary:
            "Package-barrel imports pulled more runtime dependencies than the server entrypoint needed.",
          surfaces: ["packages/runtime", "package barrel", "apps/server"],
          title: "Package-barrel import drag hid runtime coupling",
          verificationPrompts: [
            "Check server entrypoint imports avoid unnecessary runtime barrel drag.",
          ],
        },
        {
          id: "gaia-12-non-get-behavior",
          severity: "warning",
          sourceStatus: "historical-risk",
          sources: [
            {
              label: "GAIA-12 accepted PR",
              pullRequest: "#15",
              url: "https://github.com/cill-i-am/gaia/pull/15",
            },
          ],
          summary:
            "Reviewer pressure added non-GET route behavior coverage for server API endpoints.",
          surfaces: ["server api", "http route", "non-get", "packages/core"],
          title: "Non-GET behavior needed explicit coverage",
          verificationPrompts: [
            "Assert non-GET methods return the expected API error shape.",
          ],
        },
        {
          id: "gaia-12-startup-timeouts",
          severity: "warning",
          sourceStatus: "historical-risk",
          sources: [
            {
              label: "GAIA-12 accepted PR",
              pullRequest: "#15",
              url: "https://github.com/cill-i-am/gaia/pull/15",
            },
          ],
          summary:
            "Startup tests needed timeout/race behavior coverage before server handoff.",
          surfaces: ["apps/server", "startup timeout", "server main"],
          title: "Startup timeouts needed race-safe tests",
          verificationPrompts: [
            "Exercise startup timeout and race behavior around the server process.",
          ],
        },
        {
          id: "gaia-12-metadata-cleanup-timing",
          severity: "warning",
          sourceStatus: "historical-risk",
          sources: [
            {
              artifactPath: "remediation-spec.md",
              label: "GAIA-12 remediation notes",
              url: "https://linear.app/tskr/issue/GAIA-12/migrate-local-server-foundation-to-effect-httpapi-and-workspace",
            },
          ],
          summary:
            "Metadata cleanup timing had to be finalized so promoted evidence was preserved before raw run state cleanup.",
          surfaces: ["metadata cleanup", "runtime", ".gaia"],
          title: "Metadata cleanup timing needed finalization",
          verificationPrompts: [
            "Verify cleanup timing before deleting raw .gaia run state.",
          ],
        },
      ],
      version: 1,
    };
    yield* fs.writeFileString(
      `${root}/reviewer-findings.json`,
      `${JSON.stringify(findings, null, 2)}\n`,
    );
  });
}

function writeSourceLessReviewerFindingsFixture(root: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const findings = {
      findings: [
        {
          id: "source-less-server-smoke",
          severity: "warning",
          sourceStatus: "historical-risk",
          sources: [],
          summary:
            "A server/API plan should not render this source-less finding.",
          surfaces: ["apps/server/src/api.ts", "built server binary"],
          title: "Source-less server smoke finding",
          verificationPrompts: [
            "This prompt must not appear because the finding has no source.",
          ],
        },
      ],
      version: 1,
    };
    yield* fs.writeFileString(
      `${root}/reviewer-findings.json`,
      `${JSON.stringify(findings, null, 2)}\n`,
    );
  });
}

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
    headRefOid?: string;
    isDraft?: boolean;
    latestReviews?: ReadonlyArray<unknown>;
    reviewDecision?: string | null;
    reviewRequests?: ReadonlyArray<unknown>;
  }> = {},
) {
  return {
    comments: input.comments ?? [],
    ...(input.headRefOid === undefined ? {} : { headRefOid: input.headRefOid }),
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

function workspacePrPreflightCommandSummary() {
  return [
    ["git", "rev-parse"],
    ["git", "status"],
    ["git", "rev-parse"],
    ["git", "remote"],
    ["git", "ls-remote"],
    ["git", "rev-parse"],
    ["gh", "auth"],
  ];
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
