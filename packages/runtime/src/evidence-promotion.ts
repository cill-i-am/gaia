import {
  EvidencePromotion,
  EvidencePromotionDogfoodSummary,
  EvidencePromotionPullRequestSummary,
  EvidencePromotionReportPaths,
  EvidencePromotionVerificationSummary,
  PromotedEvidenceItem,
  parseDogfoodRetrospective,
  type EvidencePromotionCleanupStatus,
  type EvidencePromotionStatus,
  type RunId,
} from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";

import { makeRuntimeError } from "./errors.js";
import { runRelative, type RunPaths } from "./paths.js";

const EvidencePromotionJson = Schema.toCodecJson(EvidencePromotion);
const encodeEvidencePromotion = Schema.encodeSync(EvidencePromotionJson);

const VerificationResultArtifact = Schema.Struct({
  checkedArtifacts: Schema.Array(Schema.NonEmptyString),
  status: Schema.NonEmptyString,
});
const parseVerificationResultArtifact = Schema.decodeUnknownSync(
  VerificationResultArtifact
);

const GitHubChecksSnapshotArtifact = Schema.Struct({
  headSha: Schema.optionalKey(Schema.NonEmptyString),
  pr: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
});
const parseGitHubChecksSnapshotArtifact = Schema.decodeUnknownSync(
  GitHubChecksSnapshotArtifact
);

const GitHubPrFeedbackArtifact = Schema.Struct({
  headSha: Schema.optionalKey(Schema.NonEmptyString),
  pr: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  url: Schema.optionalKey(Schema.String),
});
const parseGitHubPrFeedbackArtifact = Schema.decodeUnknownSync(
  GitHubPrFeedbackArtifact
);

const GitHubPrLoopArtifact = Schema.Struct({
  checksPath: Schema.NonEmptyString,
  checksStatus: Schema.NonEmptyString,
  feedbackPath: Schema.NonEmptyString,
  feedbackStatus: Schema.NonEmptyString,
  headSha: Schema.optionalKey(Schema.NonEmptyString),
  pr: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
});
const parseGitHubPrLoopArtifact =
  Schema.decodeUnknownSync(GitHubPrLoopArtifact);

type WriteEvidencePromotionInput = {
  readonly cleanupStatus?: EvidencePromotionCleanupStatus;
  readonly promotionStatus?: EvidencePromotionStatus;
  readonly paths: RunPaths;
  readonly runId: RunId;
};

export function writeEvidencePromotion(input: WriteEvidencePromotionInput) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const generatedAt = new Date().toISOString();
    const reportPaths = yield* buildReportPaths(input.paths);
    const verification = yield* buildVerificationSummary(input.paths);
    const pullRequest = yield* buildPullRequestSummary(input.paths);
    const dogfood = yield* buildDogfoodSummary(input.paths);
    const promotionStatus = input.promotionStatus ?? "pending-promotion";
    const cleanupStatus = input.cleanupStatus ?? "not-completed";
    const selectedEvidence = buildSelectedEvidence({
      dogfood,
      paths: input.paths,
      pullRequest,
      reportPaths,
      verification,
    });
    const markdown = renderEvidencePromotionMarkdown({
      cleanupStatus,
      dogfood,
      generatedAt,
      promotionStatus,
      pullRequest,
      reportPaths,
      runId: input.runId,
      selectedEvidence,
      verification,
    });
    const promotion = EvidencePromotion.make({
      artifactPath: gaiaRelative(
        input.paths,
        input.paths.evidencePromotionJson
      ),
      cleanupStatus,
      dogfood,
      generatedAt,
      markdown,
      markdownPath: gaiaRelative(
        input.paths,
        input.paths.evidencePromotionMarkdown
      ),
      promotionStatus,
      pullRequest,
      reportPaths,
      runId: input.runId,
      selectedEvidence,
      version: 1,
      verification,
    });

    yield* fs.makeDirectory(input.paths.promotedEvidenceDirectory, {
      recursive: true,
    });
    yield* fs.writeFileString(input.paths.evidencePromotionMarkdown, markdown);
    yield* fs.writeFileString(
      input.paths.evidencePromotionJson,
      `${JSON.stringify(encodeEvidencePromotion(promotion), null, 2)}\n`
    );

    return promotion;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "EvidencePromotionWriteFailed",
          message:
            "Gaia could not write selected evidence promotion artifacts.",
          recoverable: true,
        })
      )
    )
  );
}

function buildReportPaths(paths: RunPaths) {
  return Effect.gen(function* () {
    const workerPlanPath = yield* existingRunPath(
      paths,
      paths.workerPlanMarkdown
    );
    const dogfoodRetrospectivePath = yield* existingRunPath(
      paths,
      paths.dogfoodRetrospective
    );
    const reportMarkdownPath = yield* existingRunPath(
      paths,
      paths.reportMarkdown
    );
    const reportJsonPath = yield* existingRunPath(paths, paths.reportJson);

    return EvidencePromotionReportPaths.make({
      ...(dogfoodRetrospectivePath === undefined
        ? {}
        : { dogfoodRetrospectivePath }),
      ...(reportJsonPath === undefined ? {} : { reportJsonPath }),
      ...(reportMarkdownPath === undefined ? {} : { reportMarkdownPath }),
      ...(workerPlanPath === undefined ? {} : { workerPlanPath }),
    });
  });
}

function buildVerificationSummary(paths: RunPaths) {
  return Effect.gen(function* () {
    const artifact = yield* readJsonIfExists(
      paths.verificationResult,
      parseVerificationResultArtifact
    );

    if (artifact === undefined) {
      return EvidencePromotionVerificationSummary.make({
        checkedArtifacts: [],
        status: "skipped",
      });
    }

    return EvidencePromotionVerificationSummary.make({
      checkedArtifacts: artifact.checkedArtifacts,
      path: runRelative(paths, paths.verificationResult),
      status: artifact.status,
    });
  });
}

function buildPullRequestSummary(paths: RunPaths) {
  return Effect.gen(function* () {
    const prLoop = yield* readJsonIfExists(
      paths.prLoopState,
      parseGitHubPrLoopArtifact
    );
    const feedback = yield* readJsonIfExists(
      paths.githubFeedback,
      parseGitHubPrFeedbackArtifact
    );
    const checks = yield* readLatestGitHubChecksSnapshot(paths);
    const artifactPaths = compactStrings([
      prLoop === undefined ? undefined : runRelative(paths, paths.prLoopState),
      feedback === undefined
        ? undefined
        : runRelative(paths, paths.githubFeedback),
      checks?.path,
    ]);
    const status = artifactPaths.length === 0 ? "skipped" : "promoted";
    const pr = prLoop?.pr ?? feedback?.pr ?? checks?.snapshot.pr;
    const checksStatus = prLoop?.checksStatus ?? checks?.snapshot.status;
    const feedbackStatus = prLoop?.feedbackStatus ?? feedback?.status;
    const headSha =
      prLoop?.headSha ?? feedback?.headSha ?? checks?.snapshot.headSha;
    const url = feedback?.url;

    return EvidencePromotionPullRequestSummary.make({
      artifactPaths,
      ...(checksStatus === undefined ? {} : { checksStatus }),
      ...(feedbackStatus === undefined ? {} : { feedbackStatus }),
      ...(headSha === undefined ? {} : { headSha }),
      ...(pr === undefined ? {} : { pr }),
      status,
      summary:
        artifactPaths.length === 0
          ? "No GitHub PR, check, or feedback evidence was recorded for this local run."
          : "GitHub PR/check/feedback evidence was selected for promotion.",
      ...(url === undefined ? {} : { url }),
    });
  });
}

function buildDogfoodSummary(paths: RunPaths) {
  return Effect.gen(function* () {
    const artifact = yield* readJsonIfExists(
      paths.dogfoodRetrospective,
      parseDogfoodRetrospective
    );

    if (artifact === undefined) {
      return EvidencePromotionDogfoodSummary.make({
        findingCount: 0,
        status: "skipped",
        summary: "Dogfood retrospective evidence was not available.",
      });
    }

    return EvidencePromotionDogfoodSummary.make({
      artifactPath: runRelative(paths, paths.dogfoodRetrospective),
      findingCount: artifact.highSignalFindingCount,
      status: artifact.status,
      summary: artifact.summary,
    });
  });
}

function buildSelectedEvidence(input: {
  readonly dogfood: EvidencePromotionDogfoodSummary;
  readonly paths: RunPaths;
  readonly pullRequest: EvidencePromotionPullRequestSummary;
  readonly reportPaths: EvidencePromotionReportPaths;
  readonly verification: EvidencePromotionVerificationSummary;
}) {
  return [
    promotedEvidenceItem({
      label: "Worker plan",
      path: input.reportPaths.workerPlanPath,
      status:
        input.reportPaths.workerPlanPath === undefined ? "skipped" : "promoted",
      summary:
        input.reportPaths.workerPlanPath === undefined
          ? "Worker plan was not available for this run."
          : "Worker planning path selected for promotion.",
    }),
    promotedEvidenceItem({
      label: "Run report",
      path:
        input.reportPaths.reportMarkdownPath ??
        input.reportPaths.reportJsonPath,
      status:
        input.reportPaths.reportMarkdownPath === undefined &&
        input.reportPaths.reportJsonPath === undefined
          ? "skipped"
          : "pending-promotion",
      summary:
        input.reportPaths.reportMarkdownPath === undefined &&
        input.reportPaths.reportJsonPath === undefined
          ? "Run report artifacts were not written before this run stopped."
          : "Report path is selected here before report cleanup guidance is rendered.",
    }),
    promotedEvidenceItem({
      label: "Verification summary",
      path: input.verification.path,
      status: input.verification.path === undefined ? "skipped" : "promoted",
      summary:
        input.verification.path === undefined
          ? "Verification evidence was not available for this run."
          : `Verification ${input.verification.status} for ${input.verification.checkedArtifacts.length} artifact(s).`,
    }),
    promotedEvidenceItem({
      label: "PR/check/feedback evidence",
      status: input.pullRequest.status,
      summary: input.pullRequest.summary,
    }),
    promotedEvidenceItem({
      label: "Dogfood findings",
      path: input.dogfood.artifactPath,
      status: input.dogfood.artifactPath === undefined ? "skipped" : "promoted",
      summary: input.dogfood.summary,
    }),
    promotedEvidenceItem({
      label: "Promotion markdown",
      path: gaiaRelative(input.paths, input.paths.evidencePromotionMarkdown),
      status: "promoted",
      summary: "Copy-ready Markdown selected for Linear or PR text.",
    }),
  ];
}

function promotedEvidenceItem(input: {
  readonly label: string;
  readonly path?: string | undefined;
  readonly status: EvidencePromotionStatus;
  readonly summary: string;
}) {
  return PromotedEvidenceItem.make({
    label: input.label,
    ...(input.path === undefined ? {} : { path: input.path }),
    status: input.status,
    summary: input.summary,
  });
}

function renderEvidencePromotionMarkdown(input: {
  readonly cleanupStatus: EvidencePromotionCleanupStatus;
  readonly dogfood: EvidencePromotionDogfoodSummary;
  readonly generatedAt: string;
  readonly promotionStatus: EvidencePromotionStatus;
  readonly pullRequest: EvidencePromotionPullRequestSummary;
  readonly reportPaths: EvidencePromotionReportPaths;
  readonly runId: RunId;
  readonly selectedEvidence: ReadonlyArray<PromotedEvidenceItem>;
  readonly verification: EvidencePromotionVerificationSummary;
}) {
  const selectedEvidence = input.selectedEvidence
    .map(
      (evidence) =>
        `- ${evidence.status}: ${evidence.label}${formatPath(evidence.path)} - ${evidence.summary}`
    )
    .join("\n");
  const checkedArtifacts =
    input.verification.checkedArtifacts.length === 0
      ? "- none"
      : input.verification.checkedArtifacts
          .map((artifact) => `- ${artifact}`)
          .join("\n");
  const prEvidence =
    input.pullRequest.artifactPaths.length === 0
      ? "- skipped: no GitHub PR/check/feedback artifact recorded"
      : input.pullRequest.artifactPaths.map((path) => `- ${path}`).join("\n");

  return `# Evidence Promotion ${input.runId}

Promotion status: ${input.promotionStatus}
Cleanup status: ${input.cleanupStatus}
Generated at: ${input.generatedAt}

## Plan And Report Paths

- Worker plan: ${input.reportPaths.workerPlanPath ?? "skipped"}
- Report markdown: ${input.reportPaths.reportMarkdownPath ?? "skipped"}
- Report JSON: ${input.reportPaths.reportJsonPath ?? "skipped"}
- Dogfood retrospective: ${input.reportPaths.dogfoodRetrospectivePath ?? "skipped"}

## Selected Evidence

${selectedEvidence}

## Verification Summary

Status: ${input.verification.status}${formatPath(input.verification.path)}

Checked artifacts:
${checkedArtifacts}

## PR / Check / Feedback Evidence

Status: ${input.pullRequest.status}
Summary: ${input.pullRequest.summary}
PR: ${input.pullRequest.pr ?? "skipped"}
Checks: ${input.pullRequest.checksStatus ?? "skipped"}
Feedback: ${input.pullRequest.feedbackStatus ?? "skipped"}

Artifacts:
${prEvidence}

## Dogfood Findings

Status: ${input.dogfood.status}${formatPath(input.dogfood.artifactPath)}
High-signal findings: ${input.dogfood.findingCount}

${input.dogfood.summary}

## Cleanup

Selected evidence has been promoted into this summary. Raw run state is disposable only after this Markdown has been copied into Linear/PR evidence or the promotion status is otherwise marked complete.
`;
}

function formatPath(path: string | undefined) {
  return path === undefined ? "" : ` (${path})`;
}

function compactStrings(input: ReadonlyArray<string | undefined>) {
  return input.filter((value): value is string => value !== undefined);
}

function existingRunPath(paths: RunPaths, absolutePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(absolutePath);
    return exists ? runRelative(paths, absolutePath) : undefined;
  });
}

function gaiaRelative(paths: RunPaths, absolutePath: string): string {
  if (absolutePath.startsWith(`${paths.gaiaRoot}/`)) {
    return `.gaia/${absolutePath.slice(paths.gaiaRoot.length + 1)}`;
  }

  return absolutePath;
}

function readJsonIfExists<A>(
  artifactPath: string,
  parse: (input: unknown) => A
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(artifactPath);
    if (!exists) {
      return undefined;
    }

    const contents = yield* fs.readFileString(artifactPath);
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "EvidencePromotionJsonInvalid",
          message: "A selected evidence source artifact was not valid JSON.",
          recoverable: true,
        }),
    });

    return yield* Effect.try({
      try: () => parse(parsed),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "EvidencePromotionArtifactInvalid",
          message:
            "A selected evidence source artifact did not match Gaia's schema.",
          recoverable: true,
        }),
    });
  });
}

function readLatestGitHubChecksSnapshot(paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const exists = yield* fs.exists(paths.githubChecks);
    if (!exists) {
      return undefined;
    }

    const entries = (yield* fs.readDirectory(paths.githubChecks))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
    const latest = entries.at(-1);
    if (latest === undefined) {
      return undefined;
    }

    const artifactPath = path.join(paths.githubChecks, latest);
    const snapshot = yield* readJsonIfExists(
      artifactPath,
      parseGitHubChecksSnapshotArtifact
    );
    if (snapshot === undefined) {
      return undefined;
    }

    return {
      path: runRelative(paths, artifactPath),
      snapshot,
    };
  });
}
