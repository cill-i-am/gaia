import { RunIdSchema, type RunSpec } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { HarnessNameSchema, type HarnessName } from "./harness.js";
import type { RunPaths } from "./paths.js";

export class WorkerPlan extends Schema.Class<WorkerPlan>("WorkerPlan")({
  expectedArtifacts: Schema.Array(Schema.NonEmptyString),
  harnessName: HarnessNameSchema,
  runId: RunIdSchema,
  steps: Schema.Array(Schema.NonEmptyString),
  summary: Schema.NonEmptyString,
}) {}

const WorkerPlanJson = Schema.toCodecJson(WorkerPlan);
const encodeWorkerPlan = Schema.encodeSync(WorkerPlanJson);
export const parseWorkerPlanJson = Schema.decodeUnknownSync(WorkerPlanJson);

export function writeWorkerPlan(input: {
  readonly harnessName: HarnessName;
  readonly paths: RunPaths;
  readonly runId: typeof RunIdSchema.Type;
  readonly spec: RunSpec;
}): Effect.Effect<WorkerPlan, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const plan = WorkerPlan.make({
      expectedArtifacts: ["workspace/output.txt", "worker-result.json"],
      harnessName: input.harnessName,
      runId: input.runId,
      steps: [
        `Run the ${input.harnessName} harness for "${input.spec.title}".`,
        "Produce workspace/output.txt with the Gaia run id.",
        "Persist normalized worker-result.json evidence.",
      ],
      summary: `Execute "${input.spec.title}" through the ${input.harnessName} harness.`,
    });

    yield* fs.writeFileString(input.paths.workerPlanMarkdown, markdownPlan(plan));
    yield* fs.writeFileString(
      input.paths.workerPlanResult,
      `${JSON.stringify(encodeWorkerPlan(plan), null, 2)}\n`,
    );

    return plan;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "WorkerPlanWriteFailed",
          message: "Gaia could not write the worker plan artifacts.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function markdownPlan(plan: WorkerPlan) {
  const steps = plan.steps.map((step) => `- ${step}`).join("\n");
  const artifacts = plan.expectedArtifacts
    .map((artifact) => `- ${artifact}`)
    .join("\n");

  return `# Gaia Worker Plan

Harness: ${plan.harnessName}

## Summary

${plan.summary}

## Steps

${steps}

## Expected Artifacts

${artifacts}
`;
}
