import {
  FactoryLaneScorecard,
  FactoryLaneScorecardCriterionAssessment,
  FactoryLaneScorecardFactoryLearningSignal,
  FactoryLaneScorecardImplementationAcceptance,
  FactoryLaneScorecardLane,
  FactoryLaneScorecardPreferredLane,
  FactoryLaneScorecardSourceLink,
  FactoryLaneScorecardVerificationEvidence,
  parseFactoryLaneScorecardLane,
  type FactoryLaneRole,
  type FactoryLaneScorecardCheckStatus,
  type FactoryLaneScorecardComparisonWaitStatus,
  type FactoryLaneScorecardCriterion,
  type FactoryLaneScorecardCriterionClassification,
  type FactoryLaneScorecardFactoryLearningSignalStatus,
  type FactoryLaneScorecardImplementationAcceptanceStatus,
  type RunId,
  type RunSpec,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { makeRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";

const FactoryLaneScorecardJson = Schema.toCodecJson(FactoryLaneScorecard);
const encodeFactoryLaneScorecard = Schema.encodeSync(FactoryLaneScorecardJson);

type WriteFactoryScorecardInput = {
  readonly paths: RunPaths;
  readonly runId: RunId;
  readonly spec: RunSpec;
};

type LaneDraft = {
  checkStatus: FactoryLaneScorecardCheckStatus | undefined;
  comparisonWaitStatus: FactoryLaneScorecardComparisonWaitStatus | undefined;
  criteria: Array<FactoryLaneScorecardCriterionAssessment>;
  factoryLearningSignal: FactoryLaneScorecardFactoryLearningSignal | undefined;
  headSha: string | undefined;
  implementationAcceptance:
    | FactoryLaneScorecardImplementationAcceptance
    | undefined;
  label: string | undefined;
  laneId: string | undefined;
  localVerification: Array<FactoryLaneScorecardVerificationEvidence>;
  pullRequest: string | undefined;
  role: FactoryLaneRole | undefined;
  sourceLinks: Array<FactoryLaneScorecardSourceLink>;
  tradeoffs: Array<string>;
};

type RecommendationDraft = {
  readonly notes: ReadonlyArray<string>;
  readonly preferredLaneId?: string | undefined;
  readonly rationale?: string | undefined;
  readonly tradeoffsPreserved: ReadonlyArray<string>;
};

const requiredCriteria: ReadonlyArray<FactoryLaneScorecardCriterion> = [
  "correctness",
  "scope-adherence",
  "simplicity",
  "test-evidence",
  "production-readiness",
  "diff-risk",
  "dogfood-signal",
];

export function writeFactoryScorecard(input: WriteFactoryScorecardInput) {
  return Effect.gen(function* () {
    const parsed = parseScorecardSections(input.spec.body);
    if (parsed.lanes.length < 2) {
      return undefined;
    }

    const fs = yield* FileSystem.FileSystem;
    const generatedAt = new Date().toISOString();
    const lanes = parsed.lanes.map((lane, index) => laneFromDraft(lane, index));
    const preferredLane = preferredLaneFromRecommendation(
      parsed.recommendation,
      lanes
    );
    const recommendationSummary =
      preferredLane === undefined
        ? "No preferred lane recommendation was supplied; preserve all tradeoffs for orchestrator review."
        : `Prefer ${preferredLane.laneId}: ${preferredLane.rationale}`;
    const comparisonSummary = summarizeComparison(lanes, preferredLane);
    const markdown = renderFactoryScorecardMarkdown({
      comparisonSummary,
      generatedAt,
      lanes,
      notes: parsed.recommendation.notes,
      preferredLane,
      recommendationSummary,
      runId: input.runId,
    });
    const scorecard = FactoryLaneScorecard.make({
      artifactPath: gaiaRelative(input.paths, input.paths.factoryScorecardJson),
      comparisonSummary,
      generatedAt,
      lanes,
      markdown,
      markdownPath: gaiaRelative(
        input.paths,
        input.paths.factoryScorecardMarkdown
      ),
      notes: [...parsed.recommendation.notes],
      ...(preferredLane === undefined ? {} : { preferredLane }),
      recommendationSummary,
      runId: input.runId,
      version: 1,
    });

    yield* fs.makeDirectory(input.paths.promotedEvidenceDirectory, {
      recursive: true,
    });
    yield* fs.writeFileString(input.paths.factoryScorecardMarkdown, markdown);
    yield* fs.writeFileString(
      input.paths.factoryScorecardJson,
      `${JSON.stringify(encodeFactoryLaneScorecard(scorecard), null, 2)}\n`
    );

    return scorecard;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "FactoryScorecardWriteFailed",
          message: "Gaia could not write factory lane scorecard artifacts.",
          recoverable: true,
        })
      )
    )
  );
}

function parseScorecardSections(body: string) {
  const lanes: Array<LaneDraft> = [];
  const recommendationNotes: Array<string> = [];
  const tradeoffsPreserved: Array<string> = [];
  let preferredLaneId: string | undefined;
  let rationale: string | undefined;
  let currentLane: LaneDraft | undefined;
  let inRecommendation = false;

  for (const line of body.split(/\r?\n/u)) {
    const laneHeading = line.match(
      /^\s{0,3}(?:#{1,6}\s*)?factory scorecard lane\s+(.+?):?\s*$/iu
    );
    if (laneHeading !== null) {
      currentLane = emptyLaneDraft(laneHeading[1]?.trim());
      lanes.push(currentLane);
      inRecommendation = false;
      continue;
    }

    if (
      /^\s{0,3}(?:#{1,6}\s*)?factory scorecard recommendation:?\s*$/iu.test(
        line
      )
    ) {
      currentLane = undefined;
      inRecommendation = true;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/u);
    if (bullet === null) {
      continue;
    }
    const item = bullet[1]?.trim();
    if (item === undefined || item.length === 0) {
      continue;
    }

    if (currentLane !== undefined) {
      applyLaneItem(currentLane, item);
      continue;
    }

    if (inRecommendation) {
      const field = parseKeyValue(item);
      if (field === undefined) {
        recommendationNotes.push(item);
        continue;
      }
      switch (normalizeKey(field.key)) {
        case "preferred-lane":
          preferredLaneId = normalizeLaneId(field.value);
          break;
        case "rationale":
          rationale = field.value;
          break;
        case "tradeoff":
          tradeoffsPreserved.push(field.value);
          break;
        case "note":
          recommendationNotes.push(field.value);
          break;
      }
    }
  }

  return {
    lanes,
    recommendation: {
      notes: recommendationNotes,
      preferredLaneId,
      rationale,
      tradeoffsPreserved,
    } satisfies RecommendationDraft,
  };
}

function emptyLaneDraft(label: string | undefined): LaneDraft {
  return {
    checkStatus: undefined,
    comparisonWaitStatus: undefined,
    criteria: [],
    factoryLearningSignal: undefined,
    headSha: undefined,
    implementationAcceptance: undefined,
    label,
    laneId: label === undefined ? undefined : normalizeLaneId(label),
    localVerification: [],
    pullRequest: undefined,
    role: undefined,
    sourceLinks: [],
    tradeoffs: [],
  };
}

function applyLaneItem(lane: LaneDraft, item: string) {
  const field = parseKeyValue(item);
  if (field === undefined) {
    lane.tradeoffs.push(item);
    return;
  }

  const key = normalizeKey(field.key);
  switch (key) {
    case "lane-id":
      lane.laneId = normalizeLaneId(field.value);
      break;
    case "label":
      lane.label = field.value;
      break;
    case "role":
      lane.role = parseLaneRole(field.value);
      break;
    case "pr":
    case "pull-request":
      lane.pullRequest = field.value;
      break;
    case "head-sha":
      lane.headSha = field.value;
      break;
    case "checks":
      lane.checkStatus = parseCheckStatus(field.value);
      break;
    case "comparison-wait":
      lane.comparisonWaitStatus = parseComparisonWaitStatus(field.value);
      break;
    case "local-verification":
      lane.localVerification.push(parseVerification(field.value));
      break;
    case "implementation-acceptance":
      lane.implementationAcceptance = parseImplementationAcceptance(
        field.value
      );
      break;
    case "factory-learning-signal":
      lane.factoryLearningSignal = parseFactoryLearningSignal(field.value);
      break;
    case "tradeoff":
      lane.tradeoffs.push(field.value);
      break;
    case "source":
      lane.sourceLinks.push(parseSourceLink(field.value));
      break;
    case "correctness":
    case "scope-adherence":
    case "simplicity":
    case "test-evidence":
    case "production-readiness":
    case "diff-risk":
    case "dogfood-signal":
      lane.criteria.push(parseCriterion(key, field.value));
      break;
  }
}

function laneFromDraft(
  lane: LaneDraft,
  index: number
): FactoryLaneScorecardLane {
  const label = lane.label ?? `Lane ${index + 1}`;
  const laneId = lane.laneId ?? normalizeLaneId(label);
  return parseFactoryLaneScorecardLane({
    checkStatus: lane.checkStatus ?? "provider-unavailable",
    comparisonWaitStatus: lane.comparisonWaitStatus ?? "missing",
    criteria: completeCriteria(lane.criteria),
    factoryLearningSignal:
      lane.factoryLearningSignal ??
      FactoryLaneScorecardFactoryLearningSignal.make({
        evidence: [],
        status: "none",
        summary: "No factory learning signal was supplied for this lane.",
      }),
    ...(lane.headSha === undefined ? {} : { headSha: lane.headSha }),
    implementationAcceptance:
      lane.implementationAcceptance ??
      FactoryLaneScorecardImplementationAcceptance.make({
        status: "unknown",
        summary: "Implementation acceptance was not supplied for this lane.",
      }),
    label,
    laneId,
    localVerification: lane.localVerification,
    ...(lane.pullRequest === undefined
      ? {}
      : { pullRequest: lane.pullRequest }),
    role: lane.role ?? "direct-fallback",
    sourceLinks: lane.sourceLinks,
    tradeoffs: lane.tradeoffs,
  });
}

function completeCriteria(
  criteria: ReadonlyArray<FactoryLaneScorecardCriterionAssessment>
) {
  return requiredCriteria.map((criterion) => {
    const supplied = criteria.find(
      (candidate) => candidate.criterion === criterion
    );
    return (
      supplied ??
      FactoryLaneScorecardCriterionAssessment.make({
        classification: "unknown",
        criterion,
        evidence: [],
        summary: "No evidence was supplied for this criterion.",
      })
    );
  });
}

function preferredLaneFromRecommendation(
  recommendation: RecommendationDraft,
  lanes: ReadonlyArray<FactoryLaneScorecardLane>
) {
  if (recommendation.preferredLaneId === undefined) {
    return undefined;
  }

  const preferredLaneId = recommendation.preferredLaneId;
  const lane = lanes.find((candidate) =>
    laneIdsMatch(candidate.laneId, preferredLaneId)
  );
  const laneId = lane?.laneId ?? preferredLaneId;
  return FactoryLaneScorecardPreferredLane.make({
    laneId,
    rationale:
      recommendation.rationale ??
      "Preferred lane was supplied without a detailed rationale.",
    tradeoffsPreserved: [...recommendation.tradeoffsPreserved],
  });
}

function summarizeComparison(
  lanes: ReadonlyArray<FactoryLaneScorecardLane>,
  preferredLane: FactoryLaneScorecardPreferredLane | undefined
) {
  const laneLabels = lanes.map((lane) => lane.label).join(" vs ");
  if (preferredLane === undefined) {
    return `${laneLabels} comparison recorded with no preferred lane.`;
  }

  return `${laneLabels} comparison recorded; preferred lane is ${preferredLane.laneId}.`;
}

function renderFactoryScorecardMarkdown(input: {
  readonly comparisonSummary: string;
  readonly generatedAt: string;
  readonly lanes: ReadonlyArray<FactoryLaneScorecardLane>;
  readonly notes: ReadonlyArray<string>;
  readonly preferredLane?: FactoryLaneScorecardPreferredLane | undefined;
  readonly recommendationSummary: string;
  readonly runId: RunId;
}) {
  return `# Factory Lane Scorecard ${input.runId}

Generated at: ${input.generatedAt}

## Summary

${input.comparisonSummary}

${input.recommendationSummary}

## Accepted Implementation Quality

${input.lanes.map(formatImplementationAcceptance).join("\n")}

## Gaia Factory Learning Signal

${input.lanes.map(formatFactoryLearningSignal).join("\n")}

## Lane Criteria

${input.lanes.map(formatLaneCriteria).join("\n\n")}

## Preferred Lane

${formatPreferredLane(input.preferredLane)}

## Tradeoffs

${input.lanes.map(formatLaneTradeoffs).join("\n")}

## Notes

${input.notes.length === 0 ? "- none" : input.notes.map((note) => `- ${note}`).join("\n")}
`;
}

function formatImplementationAcceptance(lane: FactoryLaneScorecardLane) {
  return `- ${lane.label}: ${lane.implementationAcceptance.status} - ${lane.implementationAcceptance.summary}`;
}

function formatFactoryLearningSignal(lane: FactoryLaneScorecardLane) {
  const evidence =
    lane.factoryLearningSignal.evidence.length === 0
      ? "no explicit evidence"
      : lane.factoryLearningSignal.evidence.join("; ");
  return `- ${lane.label}: ${lane.factoryLearningSignal.status} - ${lane.factoryLearningSignal.summary} (${evidence})`;
}

function formatLaneCriteria(lane: FactoryLaneScorecardLane) {
  const checks = `checks: ${displayCheckStatus(lane.checkStatus)}`;
  const verification =
    lane.localVerification.length === 0
      ? "- local verification: none supplied"
      : lane.localVerification.map(formatVerification).join("\n");
  const criteria =
    lane.criteria.length === 0
      ? "- no criteria supplied"
      : lane.criteria
          .map(
            (criterion) =>
              `- ${criterion.criterion}: ${criterion.classification} - ${criterion.summary}`
          )
          .join("\n");
  return `### ${lane.label}

Role: ${lane.role}
PR: ${lane.pullRequest ?? "not supplied"}
${checks}
comparison wait: ${lane.comparisonWaitStatus}

${verification}

${criteria}`;
}

function formatPreferredLane(
  preferredLane: FactoryLaneScorecardPreferredLane | undefined
) {
  if (preferredLane === undefined) {
    return "No preferred lane supplied.";
  }

  const tradeoffs =
    preferredLane.tradeoffsPreserved.length === 0
      ? "- none"
      : preferredLane.tradeoffsPreserved
          .map((tradeoff) => `- ${tradeoff}`)
          .join("\n");
  return [
    `Preferred lane: ${preferredLane.laneId}`,
    `Rationale: ${preferredLane.rationale}`,
    "",
    "Preserved tradeoffs:",
    tradeoffs,
  ].join("\n");
}

function formatLaneTradeoffs(lane: FactoryLaneScorecardLane) {
  const tradeoffs =
    lane.tradeoffs.length === 0 ? "none" : lane.tradeoffs.join("; ");
  return `- ${lane.label}: ${tradeoffs}`;
}

function formatVerification(
  evidence: FactoryLaneScorecardVerificationEvidence
) {
  return `- local verification: ${evidence.command} - ${evidence.result}`;
}

function displayCheckStatus(status: FactoryLaneScorecardCheckStatus) {
  switch (status) {
    case "failing":
      return "failing";
    case "green":
      return "green";
    case "no-checks-configured":
      return "no checks configured";
    case "pending":
      return "pending";
    case "provider-unavailable":
      return "provider unavailable";
  }
}

function parseKeyValue(item: string) {
  const match = item.match(/^([^:]+):\s*(.+)$/u);
  if (match === null) {
    return undefined;
  }

  const key = match[1]?.trim();
  const value = match[2]?.trim();
  if (key === undefined || value === undefined || value.length === 0) {
    return undefined;
  }

  return { key, value };
}

function normalizeKey(input: string) {
  return input.trim().toLowerCase().replace(/\s+/gu, "-");
}

function normalizeLaneId(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^lane\s+/u, "lane-")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function laneIdsMatch(left: string, right: string) {
  return normalizeLaneId(left) === normalizeLaneId(right);
}

function parseLaneRole(input: string): FactoryLaneRole {
  const normalized = input.toLowerCase();
  if (/\b(dogfood|gaia)\b/u.test(normalized)) {
    return "gaia-dogfood";
  }
  if (/\b(reviewer|spec)\b/u.test(normalized)) {
    return "reviewer-spec";
  }
  if (/\bci\b|\bwatch\b/u.test(normalized)) {
    return "ci-watch";
  }
  if (/\borchestrator\b/u.test(normalized)) {
    return "orchestrator";
  }
  return "direct-fallback";
}

function parseCheckStatus(input: string): FactoryLaneScorecardCheckStatus {
  const normalized = input.toLowerCase();
  if (/no[-\s]?checks?|no[-\s]?ci/u.test(normalized)) {
    return "no-checks-configured";
  }
  if (/\bgreen\b|\bpass(?:ed|ing)?\b/u.test(normalized)) {
    return "green";
  }
  if (/\bfail(?:ed|ing)?\b/u.test(normalized)) {
    return "failing";
  }
  if (/\bpending\b|\bwaiting\b/u.test(normalized)) {
    return "pending";
  }
  return "provider-unavailable";
}

function parseComparisonWaitStatus(
  input: string
): FactoryLaneScorecardComparisonWaitStatus {
  const normalized = input.toLowerCase();
  if (/\bvalid\b|\bpassed\b|\bwaited\b/u.test(normalized)) {
    return "valid";
  }
  if (/\bnot[-\s]?required\b|\bn\/a\b/u.test(normalized)) {
    return "not-required";
  }
  if (/\bfailed\b|\binvalid\b/u.test(normalized)) {
    return "failed";
  }
  return "missing";
}

function parseVerification(input: string) {
  const parts = input.split(/\s+-\s+/u);
  const command = parts[0]?.trim() ?? input;
  const result = parts.slice(1).join(" - ").trim();
  return FactoryLaneScorecardVerificationEvidence.make({
    command,
    result: result.length === 0 ? "recorded" : result,
  });
}

function parseCriterion(
  criterion: FactoryLaneScorecardCriterion,
  input: string
) {
  const parsed = parseClassificationSummary(input);
  return FactoryLaneScorecardCriterionAssessment.make({
    classification: parseCriterionClassification(parsed.classification),
    criterion,
    evidence: [parsed.summary],
    summary: parsed.summary,
  });
}

function parseImplementationAcceptance(input: string) {
  const parsed = parseClassificationSummary(input);
  return FactoryLaneScorecardImplementationAcceptance.make({
    status: parseImplementationAcceptanceStatus(parsed.classification),
    summary: parsed.summary,
  });
}

function parseFactoryLearningSignal(input: string) {
  const parsed = parseClassificationSummary(input);
  return FactoryLaneScorecardFactoryLearningSignal.make({
    evidence: [parsed.summary],
    status: parseFactoryLearningSignalStatus(parsed.classification),
    summary: parsed.summary,
  });
}

function parseClassificationSummary(input: string) {
  const parts = input.split(/\s+-\s+/u);
  const classification = parts[0]?.trim() ?? "unknown";
  const summary = parts.slice(1).join(" - ").trim();
  return {
    classification,
    summary: summary.length === 0 ? input : summary,
  };
}

function parseCriterionClassification(
  input: string
): FactoryLaneScorecardCriterionClassification {
  switch (normalizeKey(input)) {
    case "strong":
      return "strong";
    case "adequate":
      return "adequate";
    case "weak":
      return "weak";
    case "risk":
      return "risk";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return "unknown";
  }
}

function parseImplementationAcceptanceStatus(
  input: string
): FactoryLaneScorecardImplementationAcceptanceStatus {
  switch (normalizeKey(input)) {
    case "accepted":
      return "accepted";
    case "acceptable-with-tradeoffs":
    case "acceptable":
      return "acceptable-with-tradeoffs";
    case "fallback":
      return "fallback";
    case "not-accepted":
    case "rejected":
      return "not-accepted";
    default:
      return "unknown";
  }
}

function parseFactoryLearningSignalStatus(
  input: string
): FactoryLaneScorecardFactoryLearningSignalStatus {
  switch (normalizeKey(input)) {
    case "strong":
      return "strong";
    case "moderate":
    case "adequate":
      return "moderate";
    case "weak":
      return "weak";
    case "negative":
      return "negative";
    default:
      return "none";
  }
}

function parseSourceLink(input: string) {
  const match = input.match(/^(.+?):\s*(https?:\/\/\S+)$/u);
  if (match === null) {
    return FactoryLaneScorecardSourceLink.make({ label: input });
  }

  return FactoryLaneScorecardSourceLink.make({
    label: match[1]?.trim() ?? "Source",
    ...(match[2] === undefined ? {} : { url: match[2].trim() }),
  });
}

function gaiaRelative(paths: RunPaths, absolutePath: string): string {
  if (absolutePath.startsWith(`${paths.gaiaRoot}/`)) {
    return `.gaia/${absolutePath.slice(paths.gaiaRoot.length + 1)}`;
  }

  return absolutePath;
}
