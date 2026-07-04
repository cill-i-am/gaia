import type { RunId } from "@gaia/core";
import { Effect, Path } from "effect";

export type RunStorageOptions = {
  readonly rootDirectory?: string;
};

export type RunStorePaths = {
  readonly gaiaRoot: string;
  readonly latest: string;
  readonly runsRoot: string;
};

export type RunPaths = {
  readonly evidenceReviewMarkdown: string;
  readonly evidenceReviewResult: string;
  readonly events: string;
  readonly gaiaRoot: string;
  readonly githubChecks: string;
  readonly input: string;
  readonly latest: string;
  readonly planReviewMarkdown: string;
  readonly planReviewResult: string;
  readonly reportJson: string;
  readonly reportMarkdown: string;
  readonly root: string;
  readonly runsRoot: string;
  readonly snapshots: string;
  readonly verificationLog: string;
  readonly verificationResult: string;
  readonly workerLog: string;
  readonly workerPlanMarkdown: string;
  readonly workerPlanResult: string;
  readonly workerResult: string;
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
      runsRoot: path.join(gaiaRoot, "runs"),
    } satisfies RunStorePaths;
  });
}

export function makeRunPaths(runId: RunId, options: RunStorageOptions = {}) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const store = yield* makeRunStorePaths(options);
    const root = path.join(store.runsRoot, runId);
    const workspace = path.join(root, "workspace");

    return {
      evidenceReviewMarkdown: path.join(root, "evidence-review.md"),
      evidenceReviewResult: path.join(root, "evidence-review.json"),
      events: path.join(root, "events.jsonl"),
      gaiaRoot: store.gaiaRoot,
      githubChecks: path.join(root, "github-checks"),
      input: path.join(root, "input.md"),
      latest: store.latest,
      planReviewMarkdown: path.join(root, "plan-review.md"),
      planReviewResult: path.join(root, "plan-review.json"),
      reportJson: path.join(root, "report.json"),
      reportMarkdown: path.join(root, "report.md"),
      root,
      runsRoot: store.runsRoot,
      snapshots: path.join(root, "snapshots.jsonl"),
      verificationLog: path.join(root, "verification.log"),
      verificationResult: path.join(root, "verification-result.json"),
      workerLog: path.join(root, "worker.log"),
      workerPlanMarkdown: path.join(root, "worker-plan.md"),
      workerPlanResult: path.join(root, "worker-plan.json"),
      workerResult: path.join(root, "worker-result.json"),
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
