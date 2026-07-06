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

export const WorkerPlanDomainReferenceKindSchema = Schema.Literals([
  "code-symbol",
  "effect-api",
  "file-path",
  "http-route",
  "package-name",
  "quoted-symbol",
] as const);

export class WorkerPlanDomainReference extends Schema.Class<WorkerPlanDomainReference>(
  "WorkerPlanDomainReference",
)({
  kind: WorkerPlanDomainReferenceKindSchema,
  value: Schema.NonEmptyString,
}) {}

export class WorkerPlan extends Schema.Class<WorkerPlan>("WorkerPlan")({
  acceptanceCriteria: Schema.Array(Schema.NonEmptyString),
  domainReferences: Schema.Array(WorkerPlanDomainReference),
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
      domainReferences: derived.domainReferences,
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
  readonly domainReferences: ReadonlyArray<WorkerPlanDomainReference>;
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
    extractVerificationItems(spec.body, [
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
    domainReferences: classifyDomainReferences(spec.body),
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
  const domainReferences = markdownList(
    plan.domainReferences.map(formatDomainReference),
  );
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

## Domain References

${domainReferences}

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

function extractVerificationItems(
  input: string,
  labels: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const normalizedLabels = labels.map(normalizeSectionLabel);
  const items: Array<string> = [];
  let active = false;
  let fence: "none" | "shell" | "other" = "none";

  for (const line of input.split(/\r?\n/u)) {
    const fenceKind = codeFenceKind(line);
    if (fenceKind !== undefined) {
      if (fence === "none") {
        fence = isShellFence(fenceKind) ? "shell" : "other";
      } else {
        fence = "none";
      }
      continue;
    }

    if (fence !== "none") {
      if (active && fence === "shell") {
        const command = executableCommandFromShellLine(line);
        if (command !== undefined) {
          items.push(command);
        }
      }
      continue;
    }

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
  const command = executableCommandFromText(item);

  return WorkerPlanVerificationCheck.make({
    ...(command === undefined ? {} : { command }),
    expectation: item,
  });
}

function executableCommandFromText(input: string) {
  const directCommand = executableCommandFromShellLine(input);
  if (directCommand !== undefined) {
    return directCommand;
  }

  for (const snippet of inlineCodeSnippets(input)) {
    const command = executableCommandFromShellLine(snippet);
    if (command !== undefined) {
      return command;
    }
  }

  return undefined;
}

function executableCommandFromShellLine(input: string) {
  const command = input
    .trim()
    .replace(/^\$\s+/u, "")
    .replace(/^>\s+/u, "")
    .trim();

  if (command.length === 0 || command.startsWith("#")) {
    return undefined;
  }

  return isKnownWorkspaceCommand(command) ? command : undefined;
}

function isKnownWorkspaceCommand(command: string) {
  return /^pnpm(?:\s|$)/u.test(command);
}

export function classifyDomainReferences(
  input: string,
): ReadonlyArray<WorkerPlanDomainReference> {
  const references: Array<WorkerPlanDomainReference> = [];
  const seen = new Set<string>();
  let fence: "none" | "shell" | "other" = "none";

  for (const line of input.split(/\r?\n/u)) {
    const fenceKind = codeFenceKind(line);
    if (fenceKind !== undefined) {
      if (fence === "none") {
        fence = isShellFence(fenceKind) ? "shell" : "other";
      } else {
        fence = "none";
      }
      continue;
    }

    if (fence === "shell") {
      continue;
    }

    const sanitized = removeExecutableInlineCode(line);
    const lineReferences = [
      ...referenceMatches(
        sanitized,
        "http-route",
        /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[^\s`'")]+/gu,
      ),
      ...referenceMatches(
        sanitized,
        "effect-api",
        /\b(?:Effect|Schema|HttpApi|HttpApiBuilder|HttpApiEndpoint|HttpApiGroup|Layer|Context|Stream|Exit|Cause)\.[A-Za-z_$][\w$]*/gu,
      ),
      ...referenceMatches(
        sanitized,
        "code-symbol",
        /\b[A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][\w$]*)+\b/gu,
      ),
      ...referenceMatches(
        sanitized,
        "package-name",
        /(?<![\w./-])@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*(?![\w./-])/giu,
      ),
      ...referenceMatches(
        sanitized,
        "file-path",
        /(?<![\w./-])(?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+(?![\w./-])/gu,
      ),
      ...quotedSymbolReferences(sanitized),
    ].sort((left, right) => left.index - right.index);

    for (const reference of lineReferences) {
      const key = reference.value;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      references.push(
        WorkerPlanDomainReference.make({
          kind: reference.kind,
          value: reference.value,
        }),
      );
    }
  }

  return references;
}

type DomainReferenceMatch = {
  readonly index: number;
  readonly kind: typeof WorkerPlanDomainReferenceKindSchema.Type;
  readonly value: string;
};

function referenceMatches(
  input: string,
  kind: typeof WorkerPlanDomainReferenceKindSchema.Type,
  pattern: RegExp,
): ReadonlyArray<DomainReferenceMatch> {
  return [...input.matchAll(pattern)].flatMap((match) => {
    const value = match[0]?.trim();
    if (value === undefined || value.length === 0 || match.index === undefined) {
      return [];
    }

    return [{ index: match.index, kind, value }];
  });
}

function quotedSymbolReferences(
  input: string,
): ReadonlyArray<DomainReferenceMatch> {
  return inlineCodeSnippetsWithIndex(input).flatMap((snippet) => {
    if (!/^[A-Za-z_$][\w$]*$/u.test(snippet.value)) {
      return [];
    }
    const kind: typeof WorkerPlanDomainReferenceKindSchema.Type =
      "quoted-symbol";

    return [
      {
        index: snippet.index,
        kind,
        value: snippet.value,
      },
    ];
  });
}

function removeExecutableInlineCode(input: string) {
  let output = input;
  for (const snippet of inlineCodeSnippets(input)) {
    if (executableCommandFromShellLine(snippet) !== undefined) {
      output = output.replace(`\`${snippet}\``, "");
    }
  }

  return output;
}

function inlineCodeSnippets(input: string) {
  return inlineCodeSnippetsWithIndex(input).map((snippet) => snippet.value);
}

function inlineCodeSnippetsWithIndex(input: string) {
  return [...input.matchAll(/`(?<snippet>[^`]+)`/gu)].flatMap((match) => {
    const snippet = match.groups?.["snippet"]?.trim();
    if (
      snippet === undefined ||
      snippet.length === 0 ||
      match.index === undefined
    ) {
      return [];
    }

    return [{ index: match.index, value: snippet }];
  });
}

function codeFenceKind(input: string) {
  const match = /^```\s*(?<kind>[A-Za-z0-9_-]*)\s*$/u.exec(input.trim());
  return match?.groups?.["kind"];
}

function isShellFence(kind: string) {
  return /^(?:sh|shell|bash|zsh|console|terminal)$/iu.test(kind);
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
  return items.length === 0
    ? "- none"
    : items.map((item) => `- ${item}`).join("\n");
}

function formatDomainReference(reference: WorkerPlanDomainReference) {
  return `${reference.kind}: \`${reference.value}\``;
}

function formatVerificationCheck(check: WorkerPlanVerificationCheck) {
  if (check.command === undefined) {
    return check.expectation;
  }

  return `${check.expectation} (command: \`${check.command}\`)`;
}
