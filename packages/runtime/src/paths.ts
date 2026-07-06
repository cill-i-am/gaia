import type { RunId } from "@gaia/core";
import { Effect, Path } from "effect";

export type RunStorageOptions = {
  readonly rootDirectory?: string;
};

export type RunStorePaths = {
  readonly gaiaRoot: string;
  readonly latest: string;
  readonly lock: string;
  readonly runsRoot: string;
};

export type RunPaths = {
  readonly browserEvidence: string;
  readonly browserScreenshots: string;
  readonly ciWatchState: string;
  readonly codexHarnessProgress: string;
  readonly dogfoodRetrospective: string;
  readonly evidenceReviewMarkdown: string;
  readonly evidenceReviewResult: string;
  readonly evidenceReviewerSession: string;
  readonly events: string;
  readonly gaiaRoot: string;
  readonly githubChecks: string;
  readonly githubFeedback: string;
  readonly githubPrComment: string;
  readonly githubRemediationSpec: string;
  readonly input: string;
  readonly latest: string;
  readonly linearIssueGraph: string;
  readonly mergeDecision: string;
  readonly planReviewMarkdown: string;
  readonly planReviewResult: string;
  readonly planReviewerSession: string;
  readonly previewDeployment: string;
  readonly promotedEvidenceDirectory: string;
  readonly evidencePromotionJson: string;
  readonly evidencePromotionMarkdown: string;
  readonly prLoopState: string;
  readonly reportJson: string;
  readonly reportMarkdown: string;
  readonly root: string;
  readonly runProfile: string;
  readonly runsRoot: string;
  readonly snapshots: string;
  readonly skillBundle: string;
  readonly skillInstallRoot: string;
  readonly skillManifest: string;
  readonly verificationLog: string;
  readonly verificationResult: string;
  readonly workerLog: string;
  readonly workerPlanMarkdown: string;
  readonly workerPlanResult: string;
  readonly workerResult: string;
  readonly workspacePrGate: string;
  readonly workspace: string;
  readonly workspaceManifest: string;
  readonly workspaceOutput: string;
};

export const runRootDirectory = ".gaia/runs";
export const latestRunFile = ".gaia/latest";

export function makeRunStorePaths(options: RunStorageOptions = {}) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const rootDirectory = options.rootDirectory ?? ".";
    const gaiaRoot = path.join(rootDirectory, ".gaia");

    return {
      gaiaRoot,
      latest: path.join(gaiaRoot, "latest"),
      lock: path.join(gaiaRoot, "lock"),
      runsRoot: path.join(gaiaRoot, "runs"),
    } satisfies RunStorePaths;
  });
}

export function makeRunPaths(runId: RunId, options: RunStorageOptions = {}) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const store = yield* makeRunStorePaths(options);
    const root = path.join(store.runsRoot, runId);
    const promotedEvidenceDirectory = path.join(store.gaiaRoot, "promoted", runId);
    const workspace = path.join(root, "workspace");

    return {
      browserEvidence: path.join(root, "browser-evidence.json"),
      browserScreenshots: path.join(root, "browser"),
      ciWatchState: path.join(root, "ci-watch-state.json"),
      codexHarnessProgress: path.join(root, "codex-harness-progress.json"),
      dogfoodRetrospective: path.join(root, "dogfood-retrospective.json"),
      evidenceReviewMarkdown: path.join(root, "evidence-review.md"),
      evidenceReviewResult: path.join(root, "evidence-review.json"),
      evidenceReviewerSession: path.join(
        root,
        "evidence-reviewer-session.json",
      ),
      events: path.join(root, "events.jsonl"),
      gaiaRoot: store.gaiaRoot,
      githubChecks: path.join(root, "github-checks"),
      githubFeedback: path.join(root, "github-feedback.json"),
      githubPrComment: path.join(root, "github-pr-comment.md"),
      githubRemediationSpec: path.join(root, "remediation-spec.md"),
      input: path.join(root, "input.md"),
      latest: store.latest,
      linearIssueGraph: path.join(root, "linear-issue-graph.json"),
      mergeDecision: path.join(root, "merge-decision.json"),
      planReviewMarkdown: path.join(root, "plan-review.md"),
      planReviewResult: path.join(root, "plan-review.json"),
      planReviewerSession: path.join(
        root,
        "plan-reviewer-session.json",
      ),
      previewDeployment: path.join(root, "preview-deployment.json"),
      promotedEvidenceDirectory,
      evidencePromotionJson: path.join(
        promotedEvidenceDirectory,
        "evidence-promotion.json",
      ),
      evidencePromotionMarkdown: path.join(
        promotedEvidenceDirectory,
        "evidence-promotion.md",
      ),
      prLoopState: path.join(root, "pr-loop-state.json"),
      reportJson: path.join(root, "report.json"),
      reportMarkdown: path.join(root, "report.md"),
      root,
      runProfile: path.join(root, "run-profile.json"),
      runsRoot: store.runsRoot,
      snapshots: path.join(root, "snapshots.jsonl"),
      skillBundle: path.join(root, "skill-bundle.json"),
      skillInstallRoot: path.join(root, "skill-sources"),
      skillManifest: path.join(root, "skill-manifest.json"),
      verificationLog: path.join(root, "verification.log"),
      verificationResult: path.join(root, "verification-result.json"),
      workerLog: path.join(root, "worker.log"),
      workerPlanMarkdown: path.join(root, "worker-plan.md"),
      workerPlanResult: path.join(root, "worker-plan.json"),
      workerResult: path.join(root, "worker-result.json"),
      workspacePrGate: path.join(root, "workspace-pr-gate.json"),
      workspace,
      workspaceManifest: path.join(root, "workspace-manifest.json"),
      workspaceOutput: path.join(workspace, "output.txt"),
    } satisfies RunPaths;
  });
}

export function runRelative(path: RunPaths, absolutePath: string): string {
  if (absolutePath.startsWith(`${path.root}/`)) {
    return absolutePath.slice(path.root.length + 1);
  }

  return absolutePath;
}
