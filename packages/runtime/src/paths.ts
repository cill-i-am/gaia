import {
  parseRunRelativeArtifactPath,
  RunIdSchema,
  RunRelativeArtifactPathSchema,
  type RunId,
  type RunRelativeArtifactPath,
} from "@gaia/core";
import { Effect, Path, Schema } from "effect";

const noControlCharacters = Schema.makeFilter(
  (input: string) => !/[\u0000-\u001f\u007f]/u.test(input),
  {
    identifier: "RuntimePathText",
    message: "Runtime paths must not contain control characters.",
  }
);

/** Runtime-owned filesystem path accepted by Gaia filesystem adapters. */
export const RuntimePathTextSchema = Schema.NonEmptyString.pipe(
  Schema.check(noControlCharacters)
);

/** Branded runtime filesystem path carried inward after boundary parsing. */
export const RuntimePathSchema = RuntimePathTextSchema.pipe(
  Schema.brand("RuntimePath")
);

export type RuntimePath = typeof RuntimePathSchema.Type;

/** Boundary input for the configured Gaia run storage root. */
export const RunStorageRootInputSchema = Schema.NonEmptyString.pipe(
  Schema.check(noControlCharacters),
  Schema.brand("RunStorageRootInput")
);

export type RunStorageRootInput = typeof RunStorageRootInputSchema.Type;

export { RunRelativeArtifactPathSchema, parseRunRelativeArtifactPath };
export type { RunRelativeArtifactPath };

/** Decode untrusted or newly joined filesystem paths before runtime use. */
export const parseRuntimePath = Schema.decodeUnknownSync(RuntimePathSchema);
/** Decode user-provided run-store roots before deriving Gaia storage paths. */
export const parseRunStorageRootInput = Schema.decodeUnknownSync(
  RunStorageRootInputSchema
);

export const RunStorageOptionsSchema = Schema.Struct({
  rootDirectory: Schema.optionalKey(RunStorageRootInputSchema),
});

export type RunStorageOptions = typeof RunStorageOptionsSchema.Encoded;

export type RunRelativePath = RunRelativeArtifactPath | RuntimePath;

export const RunStorePathsSchema = Schema.Struct({
  gaiaRoot: RuntimePathSchema,
  latest: RuntimePathSchema,
  lock: RuntimePathSchema,
  runsRoot: RuntimePathSchema,
});

export type RunStorePaths = typeof RunStorePathsSchema.Type;

export const RunPathsSchema = Schema.Struct({
  browserEvidence: RuntimePathSchema,
  browserScreenshots: RuntimePathSchema,
  ciWatchState: RuntimePathSchema,
  codexHarnessProgress: RuntimePathSchema,
  deliveryOwnershipManifest: RuntimePathSchema,
  deliveryPullRequestBody: RuntimePathSchema,
  dogfoodRetrospective: RuntimePathSchema,
  evidencePromotionJson: RuntimePathSchema,
  evidencePromotionMarkdown: RuntimePathSchema,
  evidenceReviewMarkdown: RuntimePathSchema,
  evidenceReviewResult: RuntimePathSchema,
  evidenceReviewerSession: RuntimePathSchema,
  events: RuntimePathSchema,
  factoryActivityIndex: RuntimePathSchema,
  factoryArtifactsDirectory: RuntimePathSchema,
  factoryArtifactsIndex: RuntimePathSchema,
  factoryGraph: RuntimePathSchema,
  factoryRetroJson: RuntimePathSchema,
  factoryRetroMarkdown: RuntimePathSchema,
  factoryScorecardJson: RuntimePathSchema,
  factoryScorecardMarkdown: RuntimePathSchema,
  gaiaRoot: RuntimePathSchema,
  githubChecks: RuntimePathSchema,
  githubFeedback: RuntimePathSchema,
  githubPrComment: RuntimePathSchema,
  githubRemediationSpec: RuntimePathSchema,
  harnessWorkspaceBaseline: RuntimePathSchema,
  input: RuntimePathSchema,
  latest: RuntimePathSchema,
  linearIssueGraph: RuntimePathSchema,
  mergeDecision: RuntimePathSchema,
  planReviewMarkdown: RuntimePathSchema,
  planReviewResult: RuntimePathSchema,
  planReviewerSession: RuntimePathSchema,
  previewDeployment: RuntimePathSchema,
  promotedEvidenceDirectory: RuntimePathSchema,
  prLoopState: RuntimePathSchema,
  reportJson: RuntimePathSchema,
  reportMarkdown: RuntimePathSchema,
  reviewerFindings: RuntimePathSchema,
  root: RuntimePathSchema,
  runProfile: RuntimePathSchema,
  runContract: RuntimePathSchema,
  runId: RunIdSchema,
  runsRoot: RuntimePathSchema,
  skillBundle: RuntimePathSchema,
  skillInstallRoot: RuntimePathSchema,
  skillManifest: RuntimePathSchema,
  snapshots: RuntimePathSchema,
  verificationLog: RuntimePathSchema,
  verificationResult: RuntimePathSchema,
  workerLog: RuntimePathSchema,
  workerPlanMarkdown: RuntimePathSchema,
  workerPlanResult: RuntimePathSchema,
  workerResult: RuntimePathSchema,
  workspace: RuntimePathSchema,
  workspaceManifest: RuntimePathSchema,
  workspaceOutput: RuntimePathSchema,
  workspacePrGate: RuntimePathSchema,
});

export type RunPaths = typeof RunPathsSchema.Type;

const parseRunStorageOptions = Schema.decodeUnknownSync(
  RunStorageOptionsSchema
);
const parseRunStorePaths = Schema.decodeUnknownSync(RunStorePathsSchema);
const parseRunPaths = Schema.decodeUnknownSync(RunPathsSchema);

export const runRootDirectory = ".gaia/runs";
export const latestRunFile = ".gaia/latest";

export function makeRunStorePaths(options: RunStorageOptions = {}) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const { rootDirectory = parseRunStorageRootInput(".") } =
      parseRunStorageOptions(options);
    const gaiaRoot = path.join(rootDirectory, ".gaia");

    return parseRunStorePaths({
      gaiaRoot,
      latest: path.join(gaiaRoot, "latest"),
      lock: path.join(gaiaRoot, "lock"),
      runsRoot: path.join(gaiaRoot, "runs"),
    });
  });
}

export function makeRunPaths(runId: RunId, options: RunStorageOptions = {}) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const store = yield* makeRunStorePaths(options);
    const root = path.join(store.runsRoot, runId);
    const promotedEvidenceDirectory = path.join(
      store.gaiaRoot,
      "promoted",
      runId
    );
    const workspace = path.join(root, "workspace");

    return parseRunPaths({
      browserEvidence: path.join(root, "browser-evidence.json"),
      browserScreenshots: path.join(root, "browser"),
      ciWatchState: path.join(root, "ci-watch-state.json"),
      codexHarnessProgress: path.join(root, "codex-harness-progress.json"),
      dogfoodRetrospective: path.join(root, "dogfood-retrospective.json"),
      deliveryOwnershipManifest: path.join(root, "delivery-ownership.json"),
      deliveryPullRequestBody: path.join(root, "delivery-pr-body.md"),
      evidenceReviewMarkdown: path.join(root, "evidence-review.md"),
      evidenceReviewResult: path.join(root, "evidence-review.json"),
      evidenceReviewerSession: path.join(
        root,
        "evidence-reviewer-session.json"
      ),
      events: path.join(root, "events.jsonl"),
      factoryActivityIndex: path.join(root, "activity-index.json"),
      factoryArtifactsDirectory: path.join(root, "artifacts"),
      factoryArtifactsIndex: path.join(root, "artifacts", "index.json"),
      factoryGraph: path.join(root, "factory-graph.json"),
      factoryRetroJson: path.join(
        promotedEvidenceDirectory,
        "factory-retro.json"
      ),
      factoryRetroMarkdown: path.join(
        promotedEvidenceDirectory,
        "factory-retro.md"
      ),
      factoryScorecardJson: path.join(
        promotedEvidenceDirectory,
        "factory-scorecard.json"
      ),
      factoryScorecardMarkdown: path.join(
        promotedEvidenceDirectory,
        "factory-scorecard.md"
      ),
      gaiaRoot: store.gaiaRoot,
      githubChecks: path.join(root, "github-checks"),
      githubFeedback: path.join(root, "github-feedback.json"),
      githubPrComment: path.join(root, "github-pr-comment.md"),
      githubRemediationSpec: path.join(root, "remediation-spec.md"),
      harnessWorkspaceBaseline: path.join(
        root,
        ".harness-workspace-baseline.json"
      ),
      input: path.join(root, "input.md"),
      latest: store.latest,
      linearIssueGraph: path.join(root, "linear-issue-graph.json"),
      mergeDecision: path.join(root, "merge-decision.json"),
      planReviewMarkdown: path.join(root, "plan-review.md"),
      planReviewResult: path.join(root, "plan-review.json"),
      planReviewerSession: path.join(root, "plan-reviewer-session.json"),
      previewDeployment: path.join(root, "preview-deployment.json"),
      promotedEvidenceDirectory,
      evidencePromotionJson: path.join(
        promotedEvidenceDirectory,
        "evidence-promotion.json"
      ),
      evidencePromotionMarkdown: path.join(
        promotedEvidenceDirectory,
        "evidence-promotion.md"
      ),
      prLoopState: path.join(root, "pr-loop-state.json"),
      reportJson: path.join(root, "report.json"),
      reportMarkdown: path.join(root, "report.md"),
      reviewerFindings: path.join(root, "reviewer-findings.json"),
      root,
      runProfile: path.join(root, "run-profile.json"),
      runContract: path.join(root, "run-contract.json"),
      runId,
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
    });
  });
}

/** Convert a runtime filesystem path to a run-relative artifact path when it is inside the run root. */
export function runRelative(
  path: RunPaths,
  absolutePath: string
): RunRelativePath {
  const runtimePath = parseRuntimePath(absolutePath);
  if (runtimePath.startsWith(`${path.root}/`)) {
    return parseRunRelativeArtifactPath(
      runtimePath.slice(path.root.length + 1)
    );
  }

  return runtimePath;
}
