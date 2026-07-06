import {
  RunReport,
  type DogfoodRetrospective,
  type EvidencePromotion,
  type RunId,
  type RunSpec,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import type { RunPaths } from "./paths.js";
import {
  selectedSkillNames,
  type SkillManifest,
} from "./skill-manifest.js";
import {
  classifyDomainReferences,
  type WorkerPlanDomainReference,
} from "./worker-plan.js";

const RunReportJson = Schema.toCodecJson(RunReport);
const encodeRunReport = Schema.encodeSync(RunReportJson);

export function writeReport(input: {
  readonly paths: RunPaths;
  readonly evidencePromotion?: EvidencePromotion | undefined;
  readonly runId: RunId;
  readonly skillManifest: SkillManifest;
  readonly spec: RunSpec;
  readonly retrospective?: DogfoodRetrospective | undefined;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const codexHarnessProgressExists = yield* fs.exists(
      input.paths.codexHarnessProgress,
    );
    const report = RunReport.make({
      artifacts: [
        "workspace-manifest.json",
        "run-profile.json",
        "skill-manifest.json",
        "skill-bundle.json",
        "browser-evidence.json",
        "preview-deployment.json",
        "worker-plan.md",
        "worker-plan.json",
        "plan-review.md",
        "plan-review.json",
        "plan-reviewer-session.json",
        ...(codexHarnessProgressExists
          ? ["codex-harness-progress.json"]
          : []),
        "dogfood-retrospective.json",
        "evidence-promotion.json",
        "evidence-promotion.md",
        "worker.log",
        "verification.log",
        "workspace/output.txt",
        "worker-result.json",
        "verification-result.json",
        "evidence-review.md",
        "evidence-review.json",
        "evidence-reviewer-session.json",
      ],
      reportPath: "report.md",
      runId: input.runId,
      selectedSkills: [...selectedSkillNames(input.skillManifest)],
      status: "completed",
      summary: `Gaia completed, reviewed, and verified "${input.spec.title}".`,
    });

    yield* fs.writeFileString(
      input.paths.reportMarkdown,
      markdownReport(
        report,
        input.retrospective,
        input.evidencePromotion,
        classifyDomainReferences(input.spec.body),
      ),
    );
    yield* fs.writeFileString(
      input.paths.reportJson,
      `${JSON.stringify(encodeRunReport(report), null, 2)}\n`,
    );

    return report;
  });
}

function markdownReport(
  report: RunReport,
  retrospective: DogfoodRetrospective | undefined,
  evidencePromotion: EvidencePromotion | undefined,
  domainReferences: ReadonlyArray<WorkerPlanDomainReference>,
): string {
  const artifacts = report.artifacts
    .map((artifact) => `- ${artifact}`)
    .join("\n");
  const selectedSkills =
    report.selectedSkills.length === 0
      ? "No skills selected for this run."
      : report.selectedSkills.map((skill) => `- ${skill}`).join("\n");

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
                (finding) => `- ${finding.category}: ${finding.summary}`,
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
            (evidence) => `- ${evidence.status}: ${evidence.label}`,
          ),
          "",
          "Cleanup guidance:",
          "Raw run state is disposable only after the promoted Markdown has been copied into Linear/PR evidence or the promotion status is otherwise marked complete.",
        ].join("\n");
  const domainReferenceSection =
    domainReferences.length === 0
      ? "No domain references classified from the source spec."
      : domainReferences
          .map((reference) => `- ${reference.kind}: \`${reference.value}\``)
          .join("\n");

  return `# Gaia Run ${report.runId}

Status: ${report.status}

## Summary

${report.summary}

## Selected Skills

${selectedSkills}

## Dogfood Retrospective

${retrospectiveSection}

## Evidence Promotion

${promotionSection}

## Domain References

${domainReferenceSection}

## Evidence

${artifacts}
`;
}
