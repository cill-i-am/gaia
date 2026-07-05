import { RunReport, type RunId, type RunSpec } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import type { RunPaths } from "./paths.js";
import {
  selectedSkillNames,
  type SkillManifest,
} from "./skill-manifest.js";

const RunReportJson = Schema.toCodecJson(RunReport);
const encodeRunReport = Schema.encodeSync(RunReportJson);

export function writeReport(input: {
  readonly paths: RunPaths;
  readonly runId: RunId;
  readonly skillManifest: SkillManifest;
  readonly spec: RunSpec;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
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

    yield* fs.writeFileString(input.paths.reportMarkdown, markdownReport(report));
    yield* fs.writeFileString(
      input.paths.reportJson,
      `${JSON.stringify(encodeRunReport(report), null, 2)}\n`,
    );

    return report;
  });
}

function markdownReport(report: RunReport): string {
  const artifacts = report.artifacts
    .map((artifact) => `- ${artifact}`)
    .join("\n");
  const selectedSkills =
    report.selectedSkills.length === 0
      ? "No skills selected for this run."
      : report.selectedSkills.map((skill) => `- ${skill}`).join("\n");

  return `# Gaia Run ${report.runId}

Status: ${report.status}

## Summary

${report.summary}

## Selected Skills

${selectedSkills}

## Evidence

${artifacts}
`;
}
