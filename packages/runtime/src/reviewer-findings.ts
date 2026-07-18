import path from "node:path";

import {
  FactoryExternalRefUrlSchema,
  GitHubProviderUrlSchema,
  GitHubPullRequestSelectorSchema,
  parseGitHubProviderUrl,
  parseWorkspaceRelativePath,
  RunSpec,
  WorkspaceRelativePathSchema,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import {
  parseRunRelativeArtifactPath,
  parseRuntimePath,
  RunPathsSchema,
  RunRelativeArtifactPathSchema,
  RuntimePathSchema,
  type RunPaths,
  type RunRelativeArtifactPath,
} from "./paths.js";
import { ReviewerNameSchema } from "./reviewer-session-evidence.js";
import type { WorkerPlan } from "./worker-plan.js";

export const ReviewerFindingSeveritySchema = Schema.Literals([
  "info",
  "warning",
  "blocker",
] as const);

export type ReviewerFindingSeverity = typeof ReviewerFindingSeveritySchema.Type;

export const ReviewerFindingSourceStatusSchema = Schema.Literals([
  "current-blocker",
  "historical-risk",
] as const);

export type ReviewerFindingSourceStatus =
  typeof ReviewerFindingSourceStatusSchema.Type;

export class ReviewerFindingSource extends Schema.Class<ReviewerFindingSource>(
  "ReviewerFindingSource"
)({
  artifactPath: Schema.optionalKey(RunRelativeArtifactPathSchema),
  label: Schema.NonEmptyString,
  pullRequest: Schema.optionalKey(GitHubPullRequestSelectorSchema),
  url: Schema.optionalKey(FactoryExternalRefUrlSchema),
}) {}

const parseReviewerFindingSourceUrl = Schema.decodeUnknownSync(
  FactoryExternalRefUrlSchema
);

export class ReviewerFindingInput extends Schema.Class<ReviewerFindingInput>(
  "ReviewerFindingInput"
)({
  id: Schema.optionalKey(Schema.NonEmptyString),
  severity: ReviewerFindingSeveritySchema,
  sourceStatus: Schema.optionalKey(ReviewerFindingSourceStatusSchema),
  sources: Schema.NonEmptyArray(ReviewerFindingSource),
  summary: Schema.NonEmptyString,
  surfaces: Schema.Array(Schema.NonEmptyString),
  title: Schema.NonEmptyString,
  verificationPrompts: Schema.Array(Schema.NonEmptyString),
}) {}

export const ReviewerFindingRelevanceInputKindSchema = Schema.Literals([
  "domain-reference",
  "likely-file",
  "package",
  "source-doc",
  "similar-test",
  "touched-surface",
  "verification",
] as const);

export class ReviewerFindingRelevanceInput extends Schema.Class<ReviewerFindingRelevanceInput>(
  "ReviewerFindingRelevanceInput"
)({
  kind: ReviewerFindingRelevanceInputKindSchema,
  reason: Schema.NonEmptyString,
  value: Schema.NonEmptyString,
}) {}

export class WorkerPlanHistoricalRiskNote extends Schema.Class<WorkerPlanHistoricalRiskNote>(
  "WorkerPlanHistoricalRiskNote"
)({
  findingId: Schema.optionalKey(Schema.NonEmptyString),
  matchedSurfaces: Schema.Array(Schema.NonEmptyString),
  severity: ReviewerFindingSeveritySchema,
  sourceStatus: ReviewerFindingSourceStatusSchema,
  sources: Schema.NonEmptyArray(ReviewerFindingSource),
  status: Schema.Literal("historical-risk"),
  summary: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  verificationPrompts: Schema.Array(Schema.NonEmptyString),
}) {}

export class ReviewerFindings extends Schema.Class<ReviewerFindings>(
  "ReviewerFindings"
)({
  matchedRiskNotes: Schema.Array(WorkerPlanHistoricalRiskNote),
  relevanceInputs: Schema.Array(ReviewerFindingRelevanceInput),
  suppliedFindings: Schema.Array(ReviewerFindingInput),
  version: Schema.Literal(1),
}) {}

const ReviewerFindingsJson = Schema.toCodecJson(ReviewerFindings);
const encodeReviewerFindingsJson = Schema.encodeSync(ReviewerFindingsJson);
export const parseReviewerFindingsJson =
  Schema.decodeUnknownSync(ReviewerFindingsJson);

const ReviewerFindingsInputDocument = Schema.Struct({
  findings: Schema.Array(ReviewerFindingInput),
  version: Schema.optionalKey(Schema.Number),
});
const parseReviewerFindingsInputDocument = Schema.decodeUnknownSync(
  ReviewerFindingsInputDocument
);

const LegacyReviewFinding = Schema.Struct({
  message: Schema.NonEmptyString,
  severity: ReviewerFindingSeveritySchema,
});
const LegacyReviewArtifact = Schema.Struct({
  findings: Schema.Array(LegacyReviewFinding),
  summary: Schema.optionalKey(Schema.NonEmptyString),
});
const parseLegacyReviewArtifact =
  Schema.decodeUnknownSync(LegacyReviewArtifact);

const LegacyReviewerSessionEvidence = Schema.Struct({
  decisionStatus: Schema.Literals(["approved", "blocked"] as const),
  evidencePath: RunRelativeArtifactPathSchema,
  phase: Schema.String,
  resultPath: RunRelativeArtifactPathSchema,
  reviewerName: ReviewerNameSchema,
});
const parseLegacyReviewerSessionEvidence = Schema.decodeUnknownSync(
  LegacyReviewerSessionEvidence
);

const LegacyGitHubComment = Schema.Struct({
  body: Schema.String,
  url: Schema.optionalKey(Schema.String),
});
const LegacyGitHubReview = Schema.Struct({
  body: Schema.optionalKey(Schema.String),
  state: Schema.String,
  url: Schema.optionalKey(Schema.String),
});
const LegacyGitHubFeedback = Schema.Struct({
  comments: Schema.Array(LegacyGitHubComment),
  latestReviews: Schema.Array(LegacyGitHubReview),
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});
const parseLegacyGitHubFeedback =
  Schema.decodeUnknownSync(LegacyGitHubFeedback);

const WriteReviewerFindingsLocalInputSchema = Schema.Struct({
  paths: RunPathsSchema,
  spec: RunSpec,
});

type ReviewerFindingPlanningInput = Pick<
  typeof WorkerPlan.Type,
  | "domainReferences"
  | "likelyTouchedSurfaces"
  | "planningContext"
  | "verificationChecks"
>;

type WriteReviewerFindingsInput =
  typeof WriteReviewerFindingsLocalInputSchema.Type &
    ReviewerFindingPlanningInput;

const MatchedHistoricalRiskNotesLocalInputSchema = Schema.Struct({
  findings: Schema.Array(ReviewerFindingInput),
});

type MatchedHistoricalRiskNotesInput =
  typeof MatchedHistoricalRiskNotesLocalInputSchema.Type &
    ReviewerFindingPlanningInput;

const FindingFromFeedbackTextInputSchema = Schema.Struct({
  artifactPath: RunRelativeArtifactPathSchema,
  fallbackTitle: Schema.NonEmptyString,
  sourceLabel: Schema.NonEmptyString,
  text: Schema.String,
  url: Schema.optionalKey(Schema.String),
});

type ReviewerFindingRelevanceValue =
  (typeof ReviewerFindingRelevanceInput.Type)["value"];
type ReviewerFindingRelevanceReason =
  (typeof ReviewerFindingRelevanceInput.Type)["reason"];
type ReviewerFindingText = (typeof ReviewerFindingInput.Type)["summary"];

export function writeReviewerFindings(input: WriteReviewerFindingsInput) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const suppliedFindings = uniqueFindings([
      ...findingsFromSpec(input.spec),
      ...(yield* findingsFromWorkspaceArtifacts(fs, input.paths)),
    ]);
    const relevanceInputs = reviewerFindingRelevanceInputs(input);
    const matchedRiskNotes = matchedHistoricalRiskNotes({
      domainReferences: input.domainReferences,
      findings: suppliedFindings,
      likelyTouchedSurfaces: input.likelyTouchedSurfaces,
      planningContext: input.planningContext,
      verificationChecks: input.verificationChecks,
    });
    const artifact = ReviewerFindings.make({
      matchedRiskNotes,
      relevanceInputs,
      suppliedFindings,
      version: 1,
    });

    yield* fs.writeFileString(
      input.paths.reviewerFindings,
      `${JSON.stringify(encodeReviewerFindingsJson(artifact), null, 2)}\n`
    );

    return artifact;
  });
}

function reviewerFindingRelevanceInputs(input: ReviewerFindingPlanningInput) {
  return uniqueRelevanceInputs([
    ...input.likelyTouchedSurfaces.map((value) =>
      relevanceInput(
        "touched-surface",
        value,
        "Spec-listed likely touched surface."
      )
    ),
    ...input.domainReferences.map((reference) =>
      relevanceInput(
        "domain-reference",
        reference.value,
        `Spec domain reference classified as ${reference.kind}.`
      )
    ),
    ...input.planningContext.likelyFiles.map((file) =>
      relevanceInput("likely-file", file.path, file.reason)
    ),
    ...input.planningContext.packages.map((workspacePackage) =>
      relevanceInput(
        "package",
        workspacePackage.name,
        `${workspacePackage.path}: ${workspacePackage.reason}`
      )
    ),
    ...input.planningContext.sourceDocs.map((doc) =>
      relevanceInput("source-doc", doc.path, doc.reason)
    ),
    ...input.planningContext.similarTests.map((test) =>
      relevanceInput("similar-test", test.path, test.reason)
    ),
    ...input.verificationChecks.map((check) =>
      relevanceInput(
        "verification",
        check.command ?? check.expectation,
        check.command === undefined
          ? "Spec verification expectation."
          : `Spec verification command for: ${check.expectation}`
      )
    ),
  ]);
}

function relevanceInput(
  kind: typeof ReviewerFindingRelevanceInputKindSchema.Type,
  value: ReviewerFindingRelevanceValue,
  reason: ReviewerFindingRelevanceReason
) {
  return ReviewerFindingRelevanceInput.make({
    kind,
    reason: fallbackText(reason, "Relevant planning input."),
    value: fallbackText(value, "unknown planning input"),
  });
}

function matchedHistoricalRiskNotes(input: MatchedHistoricalRiskNotesInput) {
  const context = planningContextText(input);
  const contextTokens = tokenSet(context);

  return input.findings.flatMap((finding) => {
    const matchedSurfaces = matchedFindingSurfaces(
      finding,
      context,
      contextTokens
    );
    if (matchedSurfaces.length === 0) {
      return [];
    }

    return [
      WorkerPlanHistoricalRiskNote.make({
        ...(finding.id === undefined ? {} : { findingId: finding.id }),
        matchedSurfaces,
        severity: finding.severity,
        sourceStatus: finding.sourceStatus ?? "historical-risk",
        sources: finding.sources,
        status: "historical-risk",
        summary: finding.summary,
        title: finding.title,
        verificationPrompts: finding.verificationPrompts,
      }),
    ];
  });
}

function matchedFindingSurfaces(
  finding: ReviewerFindingInput,
  context: string,
  contextTokens: ReadonlySet<string>
) {
  const surfaces =
    finding.surfaces.length === 0
      ? [finding.title, finding.summary]
      : finding.surfaces;
  const matched: Array<string> = [];
  const normalizedContext = normalizeForIncludes(context);

  for (const surface of surfaces) {
    if (isWeakSurface(surface)) {
      continue;
    }
    const normalizedSurface = normalizeForIncludes(surface);
    const surfaceTokens = tokenSet(surface);
    const tokenMatches = [...surfaceTokens].filter((token) =>
      contextTokens.has(token)
    );
    const pathLikeMatch =
      surface.includes("/") && normalizedContext.includes(normalizedSurface);
    const phraseMatch =
      normalizedSurface.length > 3 &&
      normalizedContext.includes(normalizedSurface);
    const tokenMatch = tokenMatches.length >= Math.min(2, surfaceTokens.size);
    if (pathLikeMatch || phraseMatch || tokenMatch) {
      matched.push(surface);
    }
  }

  return uniqueStrings(matched);
}

function isWeakSurface(surface: string) {
  const normalized = normalizeForIncludes(surface).trim();
  return weakSurfaceHints.has(normalized);
}

function planningContextText(input: ReviewerFindingPlanningInput) {
  return [
    ...input.likelyTouchedSurfaces,
    ...input.domainReferences.map((reference) => reference.value),
    ...input.verificationChecks.map((check) => check.expectation),
  ].join("\n");
}

function findingsFromSpec(spec: RunSpec) {
  return extractSectionItems(spec.body, [
    "reviewer findings",
    "review findings",
    "historical reviewer findings",
    "prior reviewer findings",
  ]).map((item) =>
    ReviewerFindingInput.make({
      severity: "warning",
      sources: [
        ReviewerFindingSource.make({
          label: `Source spec: ${spec.title}`,
        }),
      ],
      summary: item,
      surfaces: [],
      title: firstSentence(item),
      verificationPrompts: [],
    })
  );
}

function findingsFromWorkspaceArtifacts(
  fs: FileSystem.FileSystem,
  paths: RunPaths
): Effect.Effect<ReadonlyArray<ReviewerFindingInput>, never> {
  return Effect.gen(function* () {
    const artifactPaths = yield* listCandidateArtifactPaths(
      fs,
      paths.workspace
    );
    const findings: Array<ReviewerFindingInput> = [];
    for (const artifactPath of artifactPaths) {
      const body = yield* fs
        .readFileString(
          parseRuntimePath(path.join(paths.workspace, artifactPath))
        )
        .pipe(
          Effect.catchTag("PlatformError", () => Effect.succeed(undefined))
        );
      if (body === undefined) {
        continue;
      }
      findings.push(...findingsFromArtifactBody(body, artifactPath));
    }

    return findings;
  });
}

function findingsFromArtifactBody(
  body: string,
  artifactPath: RunRelativeArtifactPath
) {
  if (artifactPath.endsWith("reviewer-findings.json")) {
    const decoded = decodeJson(body, parseReviewerFindingsInputDocument);
    return decoded?.findings ?? [];
  }

  if (artifactPath.endsWith("github-feedback.json")) {
    const decoded = decodeJson(body, parseLegacyGitHubFeedback);
    if (decoded === undefined) {
      return [];
    }
    return [
      ...decoded.comments.flatMap((comment, index) =>
        findingFromFeedbackText({
          artifactPath,
          fallbackTitle: `GitHub PR comment ${index + 1}`,
          sourceLabel: "GitHub PR feedback",
          text: comment.body,
          ...(comment.url === undefined && decoded.url === undefined
            ? {}
            : { url: comment.url ?? decoded.url }),
        })
      ),
      ...decoded.latestReviews.flatMap((review, index) =>
        findingFromFeedbackText({
          artifactPath,
          fallbackTitle: `GitHub PR review ${index + 1}`,
          sourceLabel: "GitHub PR review",
          text: review.body ?? review.state,
          ...(review.url === undefined && decoded.url === undefined
            ? {}
            : { url: review.url ?? decoded.url }),
        })
      ),
    ];
  }

  if (
    artifactPath.endsWith("plan-review.json") ||
    artifactPath.endsWith("evidence-review.json")
  ) {
    const decoded = decodeJson(body, parseLegacyReviewArtifact);
    if (decoded === undefined) {
      return [];
    }
    return decoded.findings.map((finding) =>
      ReviewerFindingInput.make({
        severity: finding.severity,
        sources: [
          ReviewerFindingSource.make({
            artifactPath,
            label: "Reviewer artifact",
          }),
        ],
        summary: finding.message,
        surfaces: [],
        title: firstSentence(finding.message),
        verificationPrompts: [],
      })
    );
  }

  if (
    artifactPath.endsWith("plan-reviewer-session.json") ||
    artifactPath.endsWith("evidence-reviewer-session.json")
  ) {
    const decoded = decodeJson(body, parseLegacyReviewerSessionEvidence);
    if (decoded === undefined || decoded.decisionStatus !== "blocked") {
      return [];
    }

    return [
      ReviewerFindingInput.make({
        severity: "blocker",
        sourceStatus: "current-blocker",
        sources: [
          ReviewerFindingSource.make({
            artifactPath,
            label: "Reviewer session evidence",
          }),
        ],
        summary: `${decoded.reviewerName} blocked the ${decoded.phase} review. Result: ${decoded.resultPath}. Evidence: ${decoded.evidencePath}.`,
        surfaces: [],
        title: `Blocked ${decoded.phase} reviewer session`,
        verificationPrompts: [
          "Read the linked reviewer result before treating the plan as ready.",
        ],
      }),
    ];
  }

  if (artifactPath.endsWith("remediation-spec.md")) {
    const summary = firstMeaningfulLine(body);
    return [
      ReviewerFindingInput.make({
        severity: "warning",
        sources: [
          ReviewerFindingSource.make({
            artifactPath,
            label: "Remediation artifact",
          }),
        ],
        summary,
        surfaces: extractSurfaceHints(body),
        title: "Supplied remediation spec",
        verificationPrompts: extractVerificationPrompts(body),
      }),
    ];
  }

  return [];
}

function findingFromFeedbackText(
  input: typeof FindingFromFeedbackTextInputSchema.Type
) {
  const summary = input.text.trim();
  if (summary.length === 0) {
    return [];
  }

  let providerUrl: typeof FactoryExternalRefUrlSchema.Type | undefined;
  if (input.url !== undefined) {
    try {
      providerUrl = parseReviewerFindingSourceUrl(
        parseGitHubProviderUrl(input.url)
      );
    } catch {
      providerUrl = undefined;
    }
  }

  return [
    ReviewerFindingInput.make({
      severity: "warning",
      sources: [
        ReviewerFindingSource.make({
          artifactPath: input.artifactPath,
          label: input.sourceLabel,
          ...(providerUrl === undefined ? {} : { url: providerUrl }),
        }),
      ],
      summary,
      surfaces: extractSurfaceHints(summary),
      title: firstSentence(summary) || input.fallbackTitle,
      verificationPrompts: extractVerificationPrompts(summary),
    }),
  ];
}

function listCandidateArtifactPaths(
  fs: FileSystem.FileSystem,
  workspaceRoot: typeof RuntimePathSchema.Type
) {
  return Effect.gen(function* () {
    const files = yield* listFilesBelow(
      fs,
      workspaceRoot,
      parseWorkspaceRelativePath(".")
    );
    return files.filter(isCandidateArtifactPath).slice(0, 50);
  });
}

function listFilesBelow(
  fs: FileSystem.FileSystem,
  workspaceRoot: typeof RuntimePathSchema.Type,
  relativeDirectory: typeof WorkspaceRelativePathSchema.Type
): Effect.Effect<ReadonlyArray<RunRelativeArtifactPath>, never> {
  return Effect.gen(function* () {
    const absoluteDirectory = parseRuntimePath(
      relativeDirectory === "."
        ? workspaceRoot
        : path.join(workspaceRoot, relativeDirectory)
    );
    const info = yield* fs
      .stat(absoluteDirectory)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(undefined)));
    if (info?.type !== "Directory") {
      return [];
    }

    const entries = yield* fs
      .readDirectory(absoluteDirectory)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed([])));
    const files: Array<RunRelativeArtifactPath> = [];
    for (const entry of entries.toSorted()) {
      if (ignoredPathSegments.has(entry)) {
        continue;
      }

      const relativePath = parseWorkspaceRelativePath(
        relativeDirectory === "." ? entry : `${relativeDirectory}/${entry}`
      );
      const absolutePath = parseRuntimePath(
        path.join(workspaceRoot, relativePath)
      );
      const entryInfo = yield* fs
        .stat(absolutePath)
        .pipe(
          Effect.catchTag("PlatformError", () => Effect.succeed(undefined))
        );
      if (entryInfo?.type === "Directory") {
        files.push(...(yield* listFilesBelow(fs, workspaceRoot, relativePath)));
        continue;
      }
      if (entryInfo?.type === "File") {
        files.push(parseRunRelativeArtifactPath(relativePath));
      }
    }

    return files;
  });
}

function isCandidateArtifactPath(relativePath: RunRelativeArtifactPath) {
  return (
    relativePath.endsWith("reviewer-findings.json") ||
    relativePath.endsWith("github-feedback.json") ||
    relativePath.endsWith("plan-review.json") ||
    relativePath.endsWith("evidence-review.json") ||
    relativePath.endsWith("plan-reviewer-session.json") ||
    relativePath.endsWith("evidence-reviewer-session.json") ||
    relativePath.endsWith("remediation-spec.md")
  );
}

function decodeJson<A>(body: string, decode: (input: unknown) => A) {
  try {
    return decode(JSON.parse(body));
  } catch {
    return undefined;
  }
}

function extractSectionItems(input: string, labels: ReadonlyArray<string>) {
  const normalizedLabels = labels.map(normalizeSectionLabel);
  const items: Array<string> = [];
  let active = false;

  for (const line of input.split(/\r?\n/u)) {
    const heading = markdownHeadingLabel(line.trim());
    if (heading !== undefined) {
      active = normalizedLabels.includes(normalizeSectionLabel(heading));
      continue;
    }

    if (!active) {
      continue;
    }

    const item = itemFromLine(line);
    if (item !== undefined) {
      items.push(item);
    }
  }

  return uniqueStrings(items);
}

function extractSurfaceHints(input: ReviewerFindingText) {
  const pathHints =
    input.match(/(?:apps|packages|docs)\/[A-Za-z0-9_.\-/]+/gu) ?? [];
  const phraseHints = [
    "server api",
    "built server binary",
    "package manifest",
    "package barrel",
    "non-get",
    "startup timeout",
    "metadata cleanup",
    "runtime",
    "cli",
    "core",
  ].filter((hint) => normalizeForIncludes(input).includes(hint));

  return uniqueStrings([...pathHints, ...phraseHints]);
}

function extractVerificationPrompts(input: string) {
  return extractSectionItems(input, ["verification", "verification prompts"]);
}

function markdownHeadingLabel(line: string) {
  const headingMatch = /^(#{1,6})\s+(?<label>.+?)\s*#*$/u.exec(line);
  return headingMatch?.groups?.["label"]?.replace(/:$/u, "").trim();
}

function itemFromLine(line: string) {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const itemMatch = /^(?:[-*+]|\d+[.)])\s+(?<item>.+)$/u.exec(trimmed);
  const item = itemMatch?.groups?.["item"]?.trim();
  return item === undefined || item.length === 0 ? undefined : item;
}

function firstMeaningfulLine(input: string) {
  return (
    input
      .split(/\r?\n/u)
      .map((line) => itemFromLine(line) ?? line.trim())
      .find((line) => line.length > 0) ?? "Supplied reviewer artifact."
  );
}

function firstSentence(input: string) {
  const sentence = input.split(/(?<=\.)\s+/u)[0]?.trim() ?? input.trim();
  return sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence;
}

function uniqueFindings(findings: ReadonlyArray<ReviewerFindingInput>) {
  const seen = new Set<string>();
  const unique: Array<ReviewerFindingInput> = [];
  for (const finding of findings) {
    const key = [
      finding.id ?? "",
      finding.title,
      finding.summary,
      finding.sources.map(formatSourceKey).join("|"),
    ].join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(finding);
  }

  return unique;
}

function uniqueRelevanceInputs(
  inputs: ReadonlyArray<ReviewerFindingRelevanceInput>
) {
  const seen = new Set<string>();
  const unique: Array<ReviewerFindingRelevanceInput> = [];
  for (const input of inputs) {
    const key = `${input.kind}\u0000${input.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(input);
  }

  return unique;
}

function formatSourceKey(source: ReviewerFindingSource) {
  return [
    source.label,
    source.artifactPath ?? "",
    source.pullRequest ?? "",
    source.url ?? "",
  ].join(":");
}

function normalizeSectionLabel(input: string) {
  return input
    .toLowerCase()
    .replace(/[`*_]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function normalizeForIncludes(input: ReviewerFindingText) {
  return input.toLowerCase().replace(/_/gu, "-");
}

function tokenSet(input: ReviewerFindingText) {
  return new Set(tokensFrom(input));
}

function tokensFrom(input: ReviewerFindingText) {
  const rawTokens = input
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1 && !weakTokens.has(token));
  const expanded: Array<string> = [];
  for (const token of rawTokens) {
    expanded.push(token);
    if (token.length > 3 && token.endsWith("s")) {
      expanded.push(token.slice(0, -1));
    }
  }

  return uniqueStrings(expanded);
}

function uniqueStrings(items: ReadonlyArray<string>) {
  const seen = new Set<string>();
  const unique: Array<string> = [];
  for (const item of items) {
    const normalized = item.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function fallbackText(input: string, fallback: string) {
  const normalized = input.trim();
  return normalized.length === 0 ? fallback : normalized;
}

export function markdownHistoricalRiskNotes(
  notes: ReadonlyArray<WorkerPlanHistoricalRiskNote>
) {
  if (notes.length === 0) {
    return "No supplied reviewer findings matched this plan's touched surfaces.";
  }

  return notes.map(formatHistoricalRiskNote).join("\n\n");
}

function formatHistoricalRiskNote(note: WorkerPlanHistoricalRiskNote) {
  return [
    `### ${note.title}`,
    "",
    `Status: historical-risk-not-current-blocker (Historical risk, not current blocker.)`,
    `Severity: ${note.severity}`,
    `Source classification: ${note.sourceStatus}`,
    `Matched surfaces: ${note.matchedSurfaces.join(", ")}`,
    "",
    note.summary,
    "",
    "Verification prompts:",
    markdownList(note.verificationPrompts),
    "",
    "Sources:",
    markdownList(note.sources.map(formatSource)),
  ].join("\n");
}

function markdownList(items: ReadonlyArray<string>) {
  return items.length === 0
    ? "- none"
    : items.map((item) => `- ${item}`).join("\n");
}

function formatSource(source: ReviewerFindingSource) {
  const details = [
    source.artifactPath === undefined
      ? undefined
      : `artifact: \`${source.artifactPath}\``,
    source.pullRequest === undefined
      ? undefined
      : `PR: \`${source.pullRequest}\``,
    source.url === undefined ? undefined : `url: ${source.url}`,
  ].filter((detail) => detail !== undefined);

  return details.length === 0
    ? source.label
    : `${source.label} (${details.join(", ")})`;
}

const ignoredPathSegments = new Set([".git", ".turbo", "dist", "node_modules"]);

const weakTokens = new Set([
  "add",
  "and",
  "before",
  "current",
  "does",
  "for",
  "from",
  "gaia",
  "historical",
  "into",
  "keep",
  "local",
  "make",
  "not",
  "prior",
  "review",
  "reviewer",
  "risk",
  "raw",
  "should",
  "source",
  "stay",
  "the",
  "this",
  "with",
]);

const weakSurfaceHints = new Set([
  ".gaia",
  "cli",
  "core",
  "package manifest",
  "runtime",
]);
