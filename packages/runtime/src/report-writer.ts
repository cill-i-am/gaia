import {
  DogfoodRetrospective,
  EvidencePromotion,
  FactoryLaneScorecard,
  FactoryRetro,
  RunReport,
  RunIdSchema,
  RunSpec,
  parseRunReportArtifactPath,
  type RunProofResultV1,
  type RunReportArtifactPath,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { RunPathsSchema, type RunPaths } from "./paths.js";
import {
  markdownHistoricalRiskNotes,
  WorkerPlanHistoricalRiskNote,
} from "./reviewer-findings.js";
import { loadAuthoritativeRunProofResult } from "./run-contract.js";
import { selectedSkillNames, SkillManifest } from "./skill-manifest.js";
import {
  markdownInferredRecommendations,
  WorkerPlanInferredRecommendations,
} from "./skill-review-inference.js";
import {
  classifyDomainReferences,
  WorkerPlanDomainReference,
} from "./worker-plan.js";

const RunReportJson = Schema.toCodecJson(RunReport);
const encodeRunReport = Schema.encodeSync(RunReportJson);

class WriteReportInputSchema extends Schema.Class<WriteReportInputSchema>(
  "WriteReportInput"
)({
  inferredRecommendations: WorkerPlanInferredRecommendations,
  historicalRiskNotes: Schema.Array(WorkerPlanHistoricalRiskNote),
  paths: RunPathsSchema,
  evidencePromotion: Schema.optionalKey(Schema.UndefinedOr(EvidencePromotion)),
  factoryRetro: Schema.optionalKey(Schema.UndefinedOr(FactoryRetro)),
  factoryScorecard: Schema.optionalKey(
    Schema.UndefinedOr(FactoryLaneScorecard)
  ),
  runId: RunIdSchema,
  skillManifest: SkillManifest,
  spec: RunSpec,
  retrospective: Schema.optionalKey(Schema.UndefinedOr(DogfoodRetrospective)),
}) {}

const ReportArtifactPathsInputSchema = Schema.Struct({
  codexHarnessProgressExists: Schema.Boolean,
  factoryScorecardExists: Schema.Boolean,
});

export function writeReport(input: WriteReportInputSchema) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const codexHarnessProgressExists = yield* fs.exists(
      input.paths.codexHarnessProgress
    );
    const proofResult = yield* loadAuthoritativeRunProofResult(
      input.paths,
      input.runId
    );
    const report = RunReport.make({
      artifacts: reportArtifactPaths({
        codexHarnessProgressExists,
        factoryScorecardExists: input.factoryScorecard !== undefined,
      }),
      reportPath: "report.md",
      proofAggregate: proofResult.aggregate,
      runId: input.runId,
      selectedSkills: [...selectedSkillNames(input.skillManifest)],
      status: "completed",
      summary: `Gaia lifecycle completed and evidence review finished for "${input.spec.title}"; run proof is '${proofResult.aggregate}'.`,
    });

    yield* fs.writeFileString(
      input.paths.reportMarkdown,
      markdownReport(
        report,
        input.retrospective,
        input.evidencePromotion,
        input.factoryRetro,
        input.factoryScorecard,
        input.inferredRecommendations,
        input.historicalRiskNotes,
        classifyDomainReferences(input.spec.body),
        proofResult
      )
    );
    yield* fs.writeFileString(
      input.paths.reportJson,
      `${JSON.stringify(encodeRunReport(report), null, 2)}\n`
    );

    return report;
  });
}

function reportArtifactPaths(
  input: Schema.Schema.Type<typeof ReportArtifactPathsInputSchema>
): ReadonlyArray<RunReportArtifactPath> {
  return [
    "workspace-manifest.json",
    "run-contract.json",
    "run-profile.json",
    "skill-manifest.json",
    "skill-bundle.json",
    "browser-evidence.json",
    "preview-deployment.json",
    "worker-plan.md",
    "worker-plan.json",
    "reviewer-findings.json",
    "plan-review.md",
    "plan-review.json",
    "plan-reviewer-session.json",
    ...(input.codexHarnessProgressExists
      ? ["codex-harness-progress.json"]
      : []),
    "dogfood-retrospective.json",
    "evidence-promotion.json",
    "evidence-promotion.md",
    "factory-retro.json",
    "factory-retro.md",
    ...(input.factoryScorecardExists
      ? ["factory-scorecard.json", "factory-scorecard.md"]
      : []),
    "worker.log",
    "verification.log",
    "workspace/output.txt",
    "worker-result.json",
    "verification-result.json",
    "evidence-review.md",
    "evidence-review.json",
    "evidence-reviewer-session.json",
  ].map((artifactPath) => parseRunReportArtifactPath(artifactPath));
}

function markdownReport(
  report: RunReport,
  retrospective: DogfoodRetrospective | undefined,
  evidencePromotion: EvidencePromotion | undefined,
  factoryRetro: FactoryRetro | undefined,
  factoryScorecard: FactoryLaneScorecard | undefined,
  inferredRecommendations: WorkerPlanInferredRecommendations,
  historicalRiskNotes: ReadonlyArray<WorkerPlanHistoricalRiskNote>,
  domainReferences: ReadonlyArray<WorkerPlanDomainReference>,
  proofResult: RunProofResultV1
): string {
  const artifacts = report.artifacts
    .map((artifact) => `- ${artifact}`)
    .join("\n");
  const selectedSkills =
    report.selectedSkills.length === 0
      ? "No explicit manifest-selected skills were provided for this run."
      : [
          "Explicit manifest-selected skills:",
          ...report.selectedSkills.map((skill) => `- ${skill}`),
        ].join("\n");
  const inferredRecommendationSection = [
    "Inferred recommendations are additive planning evidence and do not replace explicit manifests or orchestrator judgment.",
    "",
    markdownInferredRecommendations(inferredRecommendations),
  ].join("\n");
  const historicalRiskSection = [
    "Reviewer findings are supplied planning evidence. Matched notes are historical-risk-not-current-blocker prompts unless current evidence proves a blocker.",
    "",
    markdownHistoricalRiskNotes(historicalRiskNotes),
  ].join("\n");

  const retrospectiveSection =
    retrospective === undefined
      ? "Retrospective artifact: dogfood-retrospective.json"
      : [
          "Retrospective artifact: dogfood-retrospective.json",
          "",
          retrospective.summary,
          "",
          "High-signal findings:",
          ...(retrospective.findings.length === 0
            ? ["- none"]
            : retrospective.findings.map(
                (finding) => `- ${finding.category}: ${finding.summary}`
              )),
        ].join("\n");
  const promotionSection =
    evidencePromotion === undefined
      ? "Promotion artifact: evidence-promotion.json"
      : [
          "Promotion artifact: evidence-promotion.json",
          "Promotion Markdown: evidence-promotion.md",
          "",
          `Promotion status: ${evidencePromotion.promotionStatus}`,
          `Cleanup status: ${evidencePromotion.cleanupStatus}`,
          "",
          "Selected evidence:",
          ...evidencePromotion.selectedEvidence.map(
            (evidence) => `- ${evidence.status}: ${evidence.label}`
          ),
          "",
          "Cleanup guidance:",
          "Raw run state is disposable only after the promoted Markdown has been copied into Linear/PR evidence or the promotion status is otherwise marked complete.",
        ].join("\n");
  const factoryRetroSection =
    factoryRetro === undefined
      ? [
          "Factory retro JSON: factory-retro.json",
          "Factory retro Markdown: factory-retro.md",
        ].join("\n")
      : [
          "Factory retro JSON: factory-retro.json",
          "Factory retro Markdown: factory-retro.md",
          "",
          `Promotion status: ${factoryRetro.promotionStatus}`,
          `Cleanup status: ${factoryRetro.cleanupStatus}`,
          "",
          "Helped:",
          ...(factoryRetro.helped.length === 0
            ? ["- none"]
            : factoryRetro.helped.map(
                (entry) => `- ${entry.source}: ${entry.summary}`
              )),
          "",
          "Missed:",
          ...(factoryRetro.missed.length === 0
            ? ["- none"]
            : factoryRetro.missed.map(
                (entry) => `- ${entry.source}: ${entry.summary}`
              )),
          "",
          "Misled:",
          ...(factoryRetro.misled.length === 0
            ? ["- none"]
            : factoryRetro.misled.map(
                (entry) => `- ${entry.source}: ${entry.summary}`
              )),
          "",
          "Recommended next factory improvement:",
          factoryRetro.recommendedNextFactoryImprovement,
        ].join("\n");
  const factoryScorecardSection =
    factoryScorecard === undefined
      ? "Factory scorecard: not generated; at least two lane evidence bundles are required."
      : [
          "Factory scorecard JSON: factory-scorecard.json",
          "Factory scorecard Markdown: factory-scorecard.md",
          "",
          factoryScorecard.comparisonSummary,
          "",
          "Recommendation:",
          factoryScorecard.recommendationSummary,
          "",
          "Lane implementation acceptance:",
          ...factoryScorecard.lanes.map(
            (lane) =>
              `- ${lane.label}: ${lane.implementationAcceptance.status} - ${lane.implementationAcceptance.summary}`
          ),
          "",
          "Gaia factory learning signal:",
          ...factoryScorecard.lanes.map(
            (lane) =>
              `- ${lane.label}: ${lane.factoryLearningSignal.status} - ${lane.factoryLearningSignal.summary}`
          ),
          "",
          "Notes:",
          ...(factoryScorecard.notes.length === 0
            ? ["- none"]
            : factoryScorecard.notes.map((note) => `- ${note}`)),
        ].join("\n");
  const domainReferenceSection =
    domainReferences.length === 0
      ? "No domain references classified from the source spec."
      : domainReferences
          .map((reference) => `- ${reference.kind}: \`${reference.value}\``)
          .join("\n");

  return `# Gaia Run ${report.runId}

Status: ${report.status}
Run proof: ${report.proofAggregate}

## Summary

${report.summary}

## Run Proof

Aggregate: ${proofResult.aggregate}
Contract: ${proofResult.contractId}
Result event sequence: ${proofResult.recordedBy.sequence}

Claim results:
${
  proofResult.results.length === 0
    ? "- none (no explicit verification claims were present)"
    : proofResult.results
        .map((result) => `- ${result.claimId}: ${result.status}`)
        .join("\n")
}

Framework protocol evidence: ${proofResult.supplementalProtocolEvidence.length}; it does not establish behavioral verification.

## Selected Skills

${selectedSkills}

## Inferred Recommendations

${inferredRecommendationSection}

## Historical Reviewer Risk Notes

${historicalRiskSection}

## Dogfood Retrospective

${retrospectiveSection}

## Evidence Promotion

${promotionSection}

## Factory Retro

${factoryRetroSection}

## Factory Lane Scorecard

${factoryScorecardSection}

## Domain References

${domainReferenceSection}

## Evidence

${artifacts}
`;
}
