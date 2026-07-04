import { RunReport, type RunId, type RunSpec } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import type { RunPaths } from "./paths.js";

const RunReportJson = Schema.toCodecJson(RunReport);
const encodeRunReport = Schema.encodeSync(RunReportJson);

export function writeReport(input: {
  readonly paths: RunPaths;
  readonly runId: RunId;
  readonly spec: RunSpec;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const report = RunReport.make({
      artifacts: [
        "workspace-manifest.json",
        "worker-plan.md",
        "worker-plan.json",
        "plan-review.md",
        "plan-review.json",
        "worker.log",
        "verification.log",
        "workspace/output.txt",
        "worker-result.json",
        "verification-result.json",
        "evidence-review.md",
        "evidence-review.json",
      ],
      reportPath: "report.md",
      runId: input.runId,
      selectedSkills: [],
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

  return `# Gaia Run ${report.runId}

Status: ${report.status}

## Summary

${report.summary}

## Selected Skills

Prototype 1 does not install or select skills yet.

## Evidence

${artifacts}
`;
}
