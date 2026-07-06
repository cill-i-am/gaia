import { Schema } from "effect";
import type { WorkerPlanPlanningContext } from "./source-planning-context.js";

export const InferenceConfidenceSchema = Schema.Literals([
  "high",
  "medium",
  "low",
] as const);

export const InferenceSourceKindSchema = Schema.Literals([
  "domain-reference",
  "likely-file",
  "package",
  "planned-surface",
  "similar-test",
  "source-doc",
  "verification-check",
] as const);

export class InferenceSource extends Schema.Class<InferenceSource>(
  "InferenceSource",
)({
  kind: InferenceSourceKindSchema,
  reason: Schema.NonEmptyString,
  value: Schema.NonEmptyString,
}) {}

export class InferenceRecommendation extends Schema.Class<InferenceRecommendation>(
  "InferenceRecommendation",
)({
  confidence: InferenceConfidenceSchema,
  name: Schema.NonEmptyString,
  reasons: Schema.Array(Schema.NonEmptyString),
  sources: Schema.Array(InferenceSource),
}) {}

export class InferredVerificationExpectation extends Schema.Class<InferredVerificationExpectation>(
  "InferredVerificationExpectation",
)({
  check: Schema.NonEmptyString,
  command: Schema.optionalKey(Schema.NonEmptyString),
  confidence: InferenceConfidenceSchema,
  reasons: Schema.Array(Schema.NonEmptyString),
  sources: Schema.Array(InferenceSource),
}) {}

export class WorkerPlanInferredRecommendations extends Schema.Class<WorkerPlanInferredRecommendations>(
  "WorkerPlanInferredRecommendations",
)({
  reviewStack: Schema.Array(InferenceRecommendation),
  skills: Schema.Array(InferenceRecommendation),
  verification: Schema.Array(InferredVerificationExpectation),
}) {}

type Confidence = typeof InferenceConfidenceSchema.Type;
type SourceKind = typeof InferenceSourceKindSchema.Type;

type DomainReferenceInput = {
  readonly kind: string;
  readonly value: string;
};

type VerificationCheckInput = {
  readonly command?: string | undefined;
  readonly expectation: string;
};

type InferenceInput = {
  readonly domainReferences: ReadonlyArray<DomainReferenceInput>;
  readonly likelyTouchedSurfaces: ReadonlyArray<string>;
  readonly planningContext: WorkerPlanPlanningContext;
  readonly verificationChecks: ReadonlyArray<VerificationCheckInput>;
};

type SurfaceProfile = {
  readonly cli: ReadonlyArray<InferenceSource>;
  readonly core: ReadonlyArray<InferenceSource>;
  readonly docsTemplates: ReadonlyArray<InferenceSource>;
  readonly effect: ReadonlyArray<InferenceSource>;
  readonly githubPr: ReadonlyArray<InferenceSource>;
  readonly browserVisible: ReadonlyArray<InferenceSource>;
  readonly runtime: ReadonlyArray<InferenceSource>;
  readonly server: ReadonlyArray<InferenceSource>;
};

type SkillAccumulator = {
  readonly confidence: Confidence;
  readonly reasons: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<InferenceSource>;
};

type VerificationAccumulator = SkillAccumulator & {
  readonly command?: string | undefined;
};

const baseReviewSource = InferenceSource.make({
  kind: "planned-surface",
  reason: "Every implementation handoff needs a reviewable production-readiness record.",
  value: "worker plan",
});

export function inferSkillReviewStack(
  input: InferenceInput,
): WorkerPlanInferredRecommendations {
  const profile = surfaceProfile(input);
  const skills = new Map<string, SkillAccumulator>();
  const reviewStack = new Map<string, SkillAccumulator>();
  const verification = new Map<string, VerificationAccumulator>();
  const docsTemplateOnly = isDocsTemplateOnly(input.likelyTouchedSurfaces);

  addRecommendation(skills, "production-ready", "high", [
    "Worker output should pass the repo production-ready evidence gate before handoff.",
  ], [baseReviewSource]);
  addRecommendation(reviewStack, "production-ready", "high", [
    "Run the production-ready gate before claiming the worker slice is complete.",
  ], [baseReviewSource]);
  addRecommendation(skills, "code-review", "high", [
    "Changed artifacts need standards-backed review before merge.",
  ], [baseReviewSource]);
  addRecommendation(reviewStack, "code-review", "high", [
    "Review changed behavior, contracts, boundaries, and tests.",
  ], [baseReviewSource]);
  addRecommendation(skills, "simplify", "high", [
    "Run a simplification pass before handoff to keep the factory artifact small.",
  ], [baseReviewSource]);
  addRecommendation(reviewStack, "simplify", "high", [
    "Check for removable inference complexity before the PR is handed off.",
  ], [baseReviewSource]);

  if (!docsTemplateOnly && profile.effect.length > 0) {
    addRecommendation(skills, "effect-ts", "high", [
      "Effect APIs or Effect-oriented runtime/server surfaces are present.",
    ], profile.effect);
    addRecommendation(reviewStack, "effect-ts", "high", [
      "Effect code should be reviewed for typed errors, Schema boundaries, and runtime-edge provisioning.",
    ], profile.effect);
    addVerification(verification, "Focused runtime Effect tests", {
      command: "pnpm --filter @gaia/runtime test",
      confidence: "medium",
      reasons: ["Effect runtime behavior needs focused package coverage."],
      sources: profile.effect,
    });
  }

  if (!docsTemplateOnly && profile.core.length > 0) {
    addVerification(verification, "Focused core contract tests", {
      command: "pnpm --filter @gaia/core test",
      confidence: "high",
      reasons: ["Core contract surfaces should be proven through core package tests."],
      sources: profile.core,
    });
  }

  const explicitServerSources = profile.server.filter(isExplicitServerSource);
  if (!docsTemplateOnly && explicitServerSources.length > 0) {
    addVerification(verification, "Focused server tests", {
      command: "pnpm --filter @gaia/server test",
      confidence: "high",
      reasons: ["Server API surfaces should be covered by server package tests."],
      sources: explicitServerSources,
    });
    addVerification(verification, "Built server binary smoke", {
      confidence: "medium",
      reasons: ["Server entrypoint changes should be checked after the binary is built."],
      sources: explicitServerSources,
    });
  }

  if (!docsTemplateOnly && profile.cli.length > 0) {
    addVerification(verification, "Focused CLI tests", {
      command: "pnpm --filter @gaia/cli test",
      confidence: "high",
      reasons: ["CLI command-output surfaces should be covered by CLI package tests."],
      sources: profile.cli,
    });
  }

  if (!docsTemplateOnly && profile.githubPr.length > 0) {
    addRecommendation(skills, "ci-watch", "medium", [
      "GitHub, PR, check, or feedback evidence paths require explicit CI/comment classification.",
    ], profile.githubPr);
    addRecommendation(reviewStack, "ci-watch", "medium", [
      "PR/check evidence changes should be watched for check and comment drift.",
    ], profile.githubPr);
    addVerification(verification, "PR check and comment watch", {
      command: "pnpm gaia pr-checks 1 --json",
      confidence: "medium",
      reasons: ["PR evidence surfaces should preserve explicit check classifications."],
      sources: profile.githubPr,
    });
  }

  if (!docsTemplateOnly && profile.browserVisible.length > 0) {
    addVerification(verification, "Browser/user-visible evidence smoke", {
      confidence: "medium",
      reasons: ["Browser or user-visible surfaces should have explicit rendered evidence when a target URL exists."],
      sources: profile.browserVisible,
    });
  }

  if (profile.docsTemplates.length > 0) {
    addVerification(verification, "Docs/template artifact review", {
      confidence: "medium",
      reasons: ["Docs and templates need review for durable source-of-truth language without heavier code gates."],
      sources: profile.docsTemplates,
    });
  }

  const broadSources = docsTemplateOnly ? [] : broadContractSources(profile);
  if (broadSources.length > 0) {
    addRecommendation(skills, "review-swarm", "high", [
      "The plan spans broad contract, app, server, or runtime boundaries.",
    ], broadSources);
    addRecommendation(reviewStack, "review-swarm", "high", [
      "Use an additional broad read-only review for cross-boundary workflow risk.",
    ], broadSources);
  }

  return WorkerPlanInferredRecommendations.make({
    reviewStack: recommendationsFromMap(reviewStack),
    skills: recommendationsFromMap(skills),
    verification: verificationFromMap(verification),
  });
}

function isDocsTemplateOnly(surfaces: ReadonlyArray<string>) {
  return (
    surfaces.length > 0 &&
    surfaces.every((surface) => {
      const normalized = surface.toLowerCase();
      return (
        normalized.startsWith("docs/") ||
        normalized.includes("template") ||
        normalized.endsWith(".md")
      );
    })
  );
}

export function markdownInferredRecommendations(
  recommendations: WorkerPlanInferredRecommendations,
) {
  return [
    "### Skills",
    markdownList(recommendations.skills.map(formatRecommendation)),
    "",
    "### Review Stack",
    markdownList(recommendations.reviewStack.map(formatRecommendation)),
    "",
    "### Verification Expectations",
    markdownList(recommendations.verification.map(formatVerification)),
  ].join("\n");
}

function surfaceProfile(input: InferenceInput): SurfaceProfile {
  const sources = [
    ...input.likelyTouchedSurfaces.map((surface) =>
      source("planned-surface", surface, "Listed as a likely touched surface."),
    ),
    ...input.planningContext.likelyFiles.map((file) =>
      source("likely-file", file.path, file.reason),
    ),
    ...input.planningContext.packages.map((workspacePackage) =>
      source("package", workspacePackage.name, workspacePackage.reason),
    ),
    ...input.planningContext.sourceDocs.map((doc) =>
      source("source-doc", doc.path, doc.reason),
    ),
    ...input.planningContext.similarTests.map((test) =>
      source("similar-test", test.path, test.reason),
    ),
    ...input.domainReferences.map((reference) =>
      source(
        "domain-reference",
        reference.value,
        `Classified as ${reference.kind}.`,
      ),
    ),
    ...input.verificationChecks.map((check) =>
      source(
        "verification-check",
        check.command ?? check.expectation,
        check.expectation,
      ),
    ),
  ];
  return {
    browserVisible: matchingSources(sources, browserSurface),
    cli: matchingSources(sources, cliSurface),
    core: matchingSources(sources, coreSurface),
    docsTemplates: matchingSources(sources, docsTemplateSurface),
    effect: matchingSources(sources, effectSurface),
    githubPr: matchingSources(sources, githubPrSurface),
    runtime: matchingSources(sources, runtimeSurface),
    server: matchingSources(sources, serverSurface),
  };
}

function broadContractSources(profile: SurfaceProfile) {
  const includesHighRiskBoundary =
    profile.server.some(isExplicitServerSource) ||
    profile.githubPr.length > 0 ||
    profile.browserVisible.length > 0;
  if (!includesHighRiskBoundary) {
    return [];
  }

  const groups = [
    profile.core,
    profile.server,
    profile.cli,
    profile.runtime,
    profile.githubPr,
    profile.browserVisible,
  ].filter((group) => group.length > 0);

  if (groups.length < 3) {
    return [];
  }

  return uniqueSources(groups.flat());
}

function isExplicitServerSource(source: InferenceSource) {
  return (
    source.value.startsWith("apps/server/") ||
    source.value === "@gaia/server" ||
    source.kind === "domain-reference" ||
    source.kind === "planned-surface"
  );
}

function matchingSources(
  sources: ReadonlyArray<InferenceSource>,
  predicate: (source: InferenceSource) => boolean,
) {
  return uniqueSources(sources.filter(predicate));
}

function effectSurface(candidate: InferenceSource) {
  if (!isBehaviorSource(candidate)) {
    return false;
  }

  const text = sourceText(candidate);
  return (
    /\beffect\b/u.test(text) ||
    /\bhttpapi\b/u.test(text) ||
    text.includes("httpapibuilder.") ||
    text.includes("@effect/")
  );
}

function coreSurface(candidate: InferenceSource) {
  if (!isBehaviorSource(candidate)) {
    return false;
  }

  const text = sourceText(candidate);
  return (
    text.includes("packages/core/") ||
    text.includes("@gaia/core") ||
    /\bcore\b/u.test(text) ||
    /\bcontract\b/u.test(text)
  );
}

function runtimeSurface(candidate: InferenceSource) {
  if (!isBehaviorSource(candidate)) {
    return false;
  }

  const text = sourceText(candidate);
  return text.includes("packages/runtime/") || text.includes("@gaia/runtime");
}

function serverSurface(candidate: InferenceSource) {
  if (!isBehaviorSource(candidate)) {
    return false;
  }

  const text = sourceText(candidate);
  if (
    candidate.kind === "likely-file" &&
    candidate.value.startsWith("packages/core/")
  ) {
    return false;
  }

  return (
    text.includes("apps/server/") ||
    text.includes("@gaia/server") ||
    /\bserver\b/u.test(text) ||
    /\bhttp\b/u.test(text) ||
    /\bapi\b/u.test(text) ||
    /\b(?:get|post|put|patch|delete)\s+\//u.test(text)
  );
}

function cliSurface(candidate: InferenceSource) {
  if (!isBehaviorSource(candidate)) {
    return false;
  }

  const text = sourceText(candidate);
  return (
    text.includes("apps/cli/") ||
    text.includes("@gaia/cli") ||
    /\bcli\b/u.test(text) ||
    /\bcommand output\b/u.test(text)
  );
}

function githubPrSurface(candidate: InferenceSource) {
  if (!isBehaviorSource(candidate)) {
    return false;
  }

  const text = sourceText(candidate);
  return (
    /\bgithub\b/u.test(text) ||
    /\bpr[-\s]?(?:loop|check|checks|feedback|review|comment|comments)\b/u.test(
      text,
    ) ||
    /\bpull request\b/u.test(text) ||
    /\bci\b/u.test(text) ||
    /\bfeedback\b/u.test(text)
  );
}

function browserSurface(candidate: InferenceSource) {
  if (!isBehaviorSource(candidate)) {
    return false;
  }

  const text = sourceText(candidate);
  return (
    /\bbrowser\b/u.test(text) ||
    /\buser-visible\b/u.test(text) ||
    /\bui\b/u.test(text) ||
    /\bpreview\b/u.test(text)
  );
}

function docsTemplateSurface(candidate: InferenceSource) {
  const text = sourceText(candidate);
  return (
    candidate.value.startsWith("docs/") ||
    /\bdocs?\b/u.test(text) ||
    /\btemplate\b/u.test(text)
  );
}

function isBehaviorSource(candidate: InferenceSource) {
  return (
    candidate.kind !== "similar-test" && candidate.kind !== "source-doc"
  );
}

function sourceText(candidate: InferenceSource) {
  return `${candidate.value}\n${candidate.reason}`.toLowerCase();
}

function addRecommendation(
  target: Map<string, SkillAccumulator>,
  name: string,
  confidence: Confidence,
  reasons: ReadonlyArray<string>,
  sources: ReadonlyArray<InferenceSource>,
) {
  const existing = target.get(name);
  target.set(name, {
    confidence:
      existing === undefined
        ? confidence
        : highestConfidence(existing.confidence, confidence),
    reasons: uniqueStrings([...(existing?.reasons ?? []), ...reasons]),
    sources: uniqueSources([...(existing?.sources ?? []), ...sources]),
  });
}

function addVerification(
  target: Map<string, VerificationAccumulator>,
  check: string,
  input: {
    readonly command?: string | undefined;
    readonly confidence: Confidence;
    readonly reasons: ReadonlyArray<string>;
    readonly sources: ReadonlyArray<InferenceSource>;
  },
) {
  const existing = target.get(check);
  target.set(check, {
    ...(input.command === undefined && existing?.command === undefined
      ? {}
      : { command: input.command ?? existing?.command }),
    confidence:
      existing === undefined
        ? input.confidence
        : highestConfidence(existing.confidence, input.confidence),
    reasons: uniqueStrings([...(existing?.reasons ?? []), ...input.reasons]),
    sources: uniqueSources([...(existing?.sources ?? []), ...input.sources]),
  });
}

function recommendationsFromMap(
  recommendations: ReadonlyMap<string, SkillAccumulator>,
) {
  return [...recommendations.entries()].map(([name, recommendation]) =>
    InferenceRecommendation.make({
      confidence: recommendation.confidence,
      name,
      reasons: [...recommendation.reasons],
      sources: [...recommendation.sources],
    }),
  );
}

function verificationFromMap(
  recommendations: ReadonlyMap<string, VerificationAccumulator>,
) {
  return [...recommendations.entries()].map(([check, recommendation]) =>
    InferredVerificationExpectation.make({
      check,
      ...(recommendation.command === undefined
        ? {}
        : { command: recommendation.command }),
      confidence: recommendation.confidence,
      reasons: [...recommendation.reasons],
      sources: [...recommendation.sources],
    }),
  );
}

function highestConfidence(left: Confidence, right: Confidence): Confidence {
  if (left === "high" || right === "high") {
    return "high";
  }
  if (left === "medium" || right === "medium") {
    return "medium";
  }

  return "low";
}

function source(kind: SourceKind, value: string, reason: string) {
  return InferenceSource.make({
    kind,
    reason: fallbackText(reason, "Source contributed to inference."),
    value: fallbackText(value, "unknown source"),
  });
}

function uniqueSources(sources: ReadonlyArray<InferenceSource>) {
  const seen = new Set<string>();
  const unique: Array<InferenceSource> = [];

  for (const candidate of sources) {
    const key = `${candidate.kind}\u0000${candidate.value}\u0000${candidate.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }

  return unique;
}

function uniqueStrings(values: ReadonlyArray<string>) {
  const seen = new Set<string>();
  const unique: Array<string> = [];

  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function fallbackText(value: string, fallback: string) {
  const normalized = value.trim();
  return normalized.length === 0 ? fallback : normalized;
}

function markdownList(items: ReadonlyArray<string>) {
  return items.length === 0
    ? "- none"
    : items.map((item) => `- ${item}`).join("\n");
}

function formatRecommendation(recommendation: InferenceRecommendation) {
  return [
    `${recommendation.name} (${recommendation.confidence})`,
    `reasons: ${recommendation.reasons.join("; ")}`,
    `sources: ${recommendation.sources.map(formatSource).join("; ")}`,
  ].join(" - ");
}

function formatVerification(recommendation: InferredVerificationExpectation) {
  const command =
    recommendation.command === undefined
      ? ""
      : ` command: \`${recommendation.command}\`;`;

  return [
    `${recommendation.check} (${recommendation.confidence}) -${command}`,
    `reasons: ${recommendation.reasons.join("; ")}`,
    `sources: ${recommendation.sources.map(formatSource).join("; ")}`,
  ].join(" ");
}

function formatSource(source: InferenceSource) {
  return `${source.kind} \`${source.value}\` (${source.reason})`;
}
