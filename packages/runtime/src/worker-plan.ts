import { RunIdSchema, type RunSpec } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { HarnessNameSchema, type HarnessName } from "./harness.js";
import type { RunPaths } from "./paths.js";

export class WorkerPlanVerificationCheck extends Schema.Class<WorkerPlanVerificationCheck>(
  "WorkerPlanVerificationCheck",
)({
  command: Schema.optionalKey(Schema.NonEmptyString),
  expectation: Schema.NonEmptyString,
}) {}

export class WorkerPlan extends Schema.Class<WorkerPlan>("WorkerPlan")({
  acceptanceCriteria: Schema.Array(Schema.NonEmptyString),
  expectedArtifacts: Schema.Array(Schema.NonEmptyString),
  harnessName: HarnessNameSchema,
  likelyTouchedSurfaces: Schema.Array(Schema.NonEmptyString),
  nonGoals: Schema.Array(Schema.NonEmptyString),
  runId: RunIdSchema,
  sourceSpecBody: Schema.NonEmptyString,
  sourceSpecTitle: Schema.NonEmptyString,
  steps: Schema.Array(Schema.NonEmptyString),
  stopConditions: Schema.Array(Schema.NonEmptyString),
  summary: Schema.NonEmptyString,
  verificationChecks: Schema.Array(WorkerPlanVerificationCheck),
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
    const derived = derivePlanFromSpec(input.spec);
    const plan = WorkerPlan.make({
      acceptanceCriteria: derived.acceptanceCriteria,
      expectedArtifacts: ["workspace/output.txt", "worker-result.json"],
      harnessName: input.harnessName,
      likelyTouchedSurfaces: derived.likelyTouchedSurfaces,
      nonGoals: derived.nonGoals,
      runId: input.runId,
      sourceSpecBody: input.spec.body,
      sourceSpecTitle: input.spec.title,
      steps: [
        `Review the spec-derived acceptance criteria for "${input.spec.title}".`,
        `Run the ${input.harnessName} harness against the prepared workspace.`,
        "Produce the declared Gaia worker artifacts and normalized worker-result.json evidence.",
        "Stop instead of widening scope if a listed stop condition is hit.",
      ],
      stopConditions: derived.stopConditions,
      summary: `Execute "${input.spec.title}" through the ${input.harnessName} harness.`,
      verificationChecks: derived.verificationChecks,
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

type DerivedWorkerPlan = {
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly likelyTouchedSurfaces: ReadonlyArray<string>;
  readonly nonGoals: ReadonlyArray<string>;
  readonly stopConditions: ReadonlyArray<string>;
  readonly verificationChecks: ReadonlyArray<WorkerPlanVerificationCheck>;
};

function derivePlanFromSpec(spec: RunSpec): DerivedWorkerPlan {
  const summary = firstMeaningfulLine(spec.body);
  const acceptanceCriteria = withFallback(
    extractSectionItems(spec.body, [
      "acceptance criteria",
      "acceptance",
      "criteria",
      "success criteria",
    ]),
    `Satisfy the parsed spec request: ${summary}`,
  );
  const nonGoals = withFallback(
    extractSectionItems(spec.body, [
      "non-goals",
      "non goals",
      "non-goal",
      "non goal",
      "out of scope",
    ]),
    "No explicit non-goals were provided by the spec; avoid expanding beyond the stated request.",
  );
  const likelyTouchedSurfaces = withFallback(
    extractSectionItems(spec.body, [
      "likely touched surfaces",
      "likely touched files",
      "likely files",
      "implementation surfaces",
      "touched surfaces",
      "files",
    ]),
    "No explicit touched surfaces were provided by the spec; inspect the workspace before editing.",
  );
  const verificationChecks = withFallback(
    extractSectionItems(spec.body, [
      "verification",
      "verification commands",
      "validation",
      "test plan",
      "tests",
      "commands",
    ]).map(makeVerificationCheck),
    WorkerPlanVerificationCheck.make({
      expectation:
        "The Gaia run completes with worker-result.json and verification-result.json evidence.",
    }),
  );
  const stopConditions = withFallback(
    extractSectionItems(spec.body, [
      "stop conditions",
      "stop condition",
      "abort conditions",
      "blockers",
    ]),
    "Stop if required inputs, credentials, or scope decisions are missing from the spec.",
  );

  return {
    acceptanceCriteria,
    likelyTouchedSurfaces,
    nonGoals,
    stopConditions,
    verificationChecks,
  };
}

function markdownPlan(plan: WorkerPlan) {
  const steps = plan.steps.map((step) => `- ${step}`).join("\n");
  const artifacts = plan.expectedArtifacts
    .map((artifact) => `- ${artifact}`)
    .join("\n");
  const acceptanceCriteria = markdownList(plan.acceptanceCriteria);
  const nonGoals = markdownList(plan.nonGoals);
  const likelyTouchedSurfaces = markdownList(plan.likelyTouchedSurfaces);
  const verificationChecks = markdownList(
    plan.verificationChecks.map(formatVerificationCheck),
  );
  const stopConditions = markdownList(plan.stopConditions);

  return `# Gaia Worker Plan

Harness: ${plan.harnessName}
Run ID: ${plan.runId}
Spec: ${plan.sourceSpecTitle}

## Summary

${plan.summary}

## Acceptance Criteria

${acceptanceCriteria}

## Non-Goals

${nonGoals}

## Likely Touched Surfaces

${likelyTouchedSurfaces}

## Verification

${verificationChecks}

## Stop Conditions

${stopConditions}

## Steps

${steps}

## Expected Artifacts

${artifacts}

## Source Spec

${plan.sourceSpecBody}
`;
}

function extractSectionItems(
  input: string,
  labels: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const normalizedLabels = labels.map(normalizeSectionLabel);
  const items: Array<string> = [];
  let active = false;

  for (const line of input.split(/\r?\n/u)) {
    const marker = sectionMarkerFromLine(line);
    if (marker !== undefined) {
      active = normalizedLabels.includes(marker.label);
      if (active && marker.inlineContent !== undefined) {
        items.push(marker.inlineContent);
      }
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

  return uniqueItems(items);
}

function sectionMarkerFromLine(line: string) {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const headingLabel = markdownHeadingLabel(trimmed);
  if (headingLabel !== undefined) {
    return {
      label: normalizeSectionLabel(headingLabel),
    };
  }

  const labeled = labeledLine(trimmed);
  if (labeled !== undefined) {
    return {
      inlineContent: labeled.inlineContent,
      label: normalizeSectionLabel(labeled.label),
    };
  }

  return undefined;
}

function markdownHeadingLabel(line: string) {
  const headingMatch = /^(#{1,6})\s+(?<label>.+?)\s*#*$/u.exec(line);
  const label = headingMatch?.groups?.["label"]?.trim();
  if (label === undefined || label.length === 0) {
    return undefined;
  }

  return label.replace(/:$/u, "").trim();
}

function labeledLine(line: string) {
  const labelMatch = /^(?<label>[A-Za-z][A-Za-z0-9 _/-]{0,80}):\s*(?<content>.*)$/u.exec(
    line,
  );
  const label = labelMatch?.groups?.["label"]?.trim();
  if (label === undefined || label.length === 0) {
    return undefined;
  }

  const content = labelMatch?.groups?.["content"]?.trim() ?? "";
  return {
    inlineContent: content.length === 0 ? undefined : content,
    label,
  };
}

function itemFromLine(line: string) {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const itemMatch = /^(?:[-*+]|\d+[.)])\s+(?<item>.+)$/u.exec(trimmed);
  const item = itemMatch?.groups?.["item"]?.trim() ?? trimmed;
  const withoutCheckbox = item.replace(/^\[[ xX]\]\s+/u, "").trim();

  return withoutCheckbox.length === 0 ? undefined : withoutCheckbox;
}

function normalizeSectionLabel(input: string) {
  return input
    .toLowerCase()
    .replace(/[`*_]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function uniqueItems(items: ReadonlyArray<string>) {
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

function withFallback<T>(
  values: ReadonlyArray<T>,
  fallback: T,
): ReadonlyArray<T> {
  return values.length === 0 ? [fallback] : values;
}

function makeVerificationCheck(item: string) {
  const command = commandFromMarkdown(item);

  return WorkerPlanVerificationCheck.make({
    ...(command === undefined ? {} : { command }),
    expectation: item,
  });
}

function commandFromMarkdown(input: string) {
  const commandMatch = /`(?<command>[^`]+)`/u.exec(input);
  const command = commandMatch?.groups?.["command"]?.trim();

  return command === undefined || command.length === 0 ? undefined : command;
}

function firstMeaningfulLine(input: string) {
  for (const line of input.split(/\r?\n/u)) {
    const item = itemFromLine(line);
    if (item !== undefined && !isLikelySectionLabel(item)) {
      return item;
    }
  }

  return "No spec body was provided.";
}

function isLikelySectionLabel(input: string) {
  return (
    labeledLine(input) !== undefined || markdownHeadingLabel(input) !== undefined
  );
}

function markdownList(items: ReadonlyArray<string>) {
  return items.map((item) => `- ${item}`).join("\n");
}

function formatVerificationCheck(check: WorkerPlanVerificationCheck) {
  if (check.command === undefined) {
    return check.expectation;
  }

  return `${check.expectation} (command: \`${check.command}\`)`;
}
