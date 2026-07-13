import * as Schema from "effect/Schema";

export const FactoryLaneRoleSchema = Schema.Literals([
  "direct-fallback",
  "gaia-dogfood",
  "reviewer-spec",
  "ci-watch",
  "orchestrator",
] as const);

export type FactoryLaneRole = typeof FactoryLaneRoleSchema.Type;

export const FactoryDelegationFindingCodeSchema = Schema.Literals([
  "base-commit-missing",
  "cleanup-rules-missing",
  "comparison-wait-rules-missing",
  "dogfood-promotion-evidence-missing",
  "dogfood-requirement-on-non-dogfood-lane",
  "dogfood-retrospective-missing",
  "dogfood-run-evidence-missing",
  "lane-role-conflict",
  "lane-role-missing",
  "worktree-branch-expectations-missing",
] as const);

export type FactoryDelegationFindingCode =
  typeof FactoryDelegationFindingCodeSchema.Type;

export const FactoryDelegationFindingSeveritySchema = Schema.Literals([
  "blocker",
] as const);

export type FactoryDelegationFindingSeverity =
  typeof FactoryDelegationFindingSeveritySchema.Type;

export const FactoryDelegationValidationStatusSchema = Schema.Literals([
  "passed",
  "failed",
] as const);

export type FactoryDelegationValidationStatus =
  typeof FactoryDelegationValidationStatusSchema.Type;

export class FactoryDelegationPromptValidationInput extends Schema.Class<FactoryDelegationPromptValidationInput>(
  "FactoryDelegationPromptValidationInput"
)({
  laneRole: FactoryLaneRoleSchema,
  promptMarkdown: Schema.NonEmptyString,
  requiresComparisonWait: Schema.Boolean,
}) {}

export class FactoryDelegationPromptValidationFinding extends Schema.Class<FactoryDelegationPromptValidationFinding>(
  "FactoryDelegationPromptValidationFinding"
)({
  code: FactoryDelegationFindingCodeSchema,
  message: Schema.NonEmptyString,
  severity: FactoryDelegationFindingSeveritySchema,
}) {}

export class FactoryDelegationPromptValidation extends Schema.Class<FactoryDelegationPromptValidation>(
  "FactoryDelegationPromptValidation"
)({
  findings: Schema.Array(FactoryDelegationPromptValidationFinding),
  laneRole: FactoryLaneRoleSchema,
  status: FactoryDelegationValidationStatusSchema,
  version: Schema.Literal(1),
}) {}

export const parseFactoryDelegationPromptValidationInput =
  Schema.decodeUnknownSync(FactoryDelegationPromptValidationInput);

export const parseFactoryDelegationPromptValidation = Schema.decodeUnknownSync(
  FactoryDelegationPromptValidation
);

export function validateFactoryDelegationPrompt(
  input: unknown
): FactoryDelegationPromptValidation {
  const decodedInput = parseFactoryDelegationPromptValidationInput(input);
  const prompt = decodedInput.promptMarkdown.toLowerCase();
  const findings: Array<FactoryDelegationPromptValidationFinding> = [];
  const addBlocker = (code: FactoryDelegationFindingCode, message: string) => {
    findings.push(
      new FactoryDelegationPromptValidationFinding({
        code,
        message,
        severity: "blocker",
      })
    );
  };

  const declaredLaneRoles = findDeclaredLaneRoles(decodedInput.promptMarkdown);
  const uniqueDeclaredLaneRoles = Array.from(new Set(declaredLaneRoles));

  if (uniqueDeclaredLaneRoles.length > 1) {
    addBlocker(
      "lane-role-conflict",
      "Delegation prompts must not declare more than one factory lane role."
    );
  }

  if (!uniqueDeclaredLaneRoles.includes(decodedInput.laneRole)) {
    addBlocker(
      "lane-role-missing",
      "Delegation prompts must explicitly declare the selected factory lane role."
    );
  }

  if (
    decodedInput.laneRole !== "gaia-dogfood" &&
    containsDogfoodRequirement(prompt)
  ) {
    addBlocker(
      "dogfood-requirement-on-non-dogfood-lane",
      "Non-dogfood lanes must not require Gaia dogfood run IDs, retrospectives, or promoted dogfood evidence."
    );
  }

  if (decodedInput.laneRole === "gaia-dogfood") {
    if (!containsDogfoodRunEvidence(prompt)) {
      addBlocker(
        "dogfood-run-evidence-missing",
        "Gaia dogfood lanes must require Gaia run IDs or run artifact evidence."
      );
    }
    if (!containsDogfoodRetrospective(prompt)) {
      addBlocker(
        "dogfood-retrospective-missing",
        "Gaia dogfood lanes must require a dogfood retrospective or factory-retro artifact."
      );
    }
    if (!containsDogfoodPromotionEvidence(prompt)) {
      addBlocker(
        "dogfood-promotion-evidence-missing",
        "Gaia dogfood lanes must require selected evidence to be promoted to Linear or PR text before cleanup."
      );
    }
  }

  if (decodedInput.requiresComparisonWait) {
    if (!containsBaseCommit(prompt)) {
      addBlocker(
        "base-commit-missing",
        "A/B lanes must name the base commit before dispatch."
      );
    }
    if (!containsWorktreeBranchExpectation(prompt)) {
      addBlocker(
        "worktree-branch-expectations-missing",
        "A/B lanes must state isolated worktree and branch expectations before dispatch."
      );
    }
    if (!containsCleanupRules(prompt)) {
      addBlocker(
        "cleanup-rules-missing",
        "A/B lanes must state cleanup rules for generated Gaia run state before handoff."
      );
    }
    if (!containsComparisonWaitRules(prompt)) {
      addBlocker(
        "comparison-wait-rules-missing",
        "A/B lanes must state whether lane comparison waits for both PRs."
      );
    }
  }

  return new FactoryDelegationPromptValidation({
    findings,
    laneRole: decodedInput.laneRole,
    status: findings.length === 0 ? "passed" : "failed",
    version: 1,
  });
}

function findDeclaredLaneRoles(promptMarkdown: string) {
  const declaredRoles: Array<FactoryLaneRole> = [];
  for (const rawLine of promptMarkdown.split("\n")) {
    const line = rawLine.trim().toLowerCase();
    if (!line.startsWith("lane role:")) {
      continue;
    }
    const role = laneRoleFromDeclaration(line);
    if (role !== undefined) {
      declaredRoles.push(role);
    }
  }
  return declaredRoles;
}

function laneRoleFromDeclaration(line: string): FactoryLaneRole | undefined {
  if (/\bdirect fallback\b/u.test(line)) {
    return "direct-fallback";
  }
  if (/\b(gaia dogfood|dogfood lane)\b/u.test(line)) {
    return "gaia-dogfood";
  }
  if (/\b(reviewer\/spec|reviewer spec|reviewer lane)\b/u.test(line)) {
    return "reviewer-spec";
  }
  if (/\b(ci watch|ci watcher|ci-watch)\b/u.test(line)) {
    return "ci-watch";
  }
  if (/\borchestrator\b/u.test(line)) {
    return "orchestrator";
  }
  return undefined;
}

function containsDogfoodRequirement(prompt: string) {
  return /dogfood\s+(evidence|requirement|retrospective|retro|run id|run ids)/u.test(
    prompt
  );
}

function containsDogfoodRunEvidence(prompt: string) {
  return /\b(run ids?|run-id|gaia run ids?|gaia run artifacts?|\.gaia\/runs?|run artifact evidence)\b/u.test(
    prompt
  );
}

function containsDogfoodRetrospective(prompt: string) {
  return /\b(dogfood retrospective|dogfood retro|factory-retro|factory retro)\b/u.test(
    prompt
  );
}

function containsDogfoodPromotionEvidence(prompt: string) {
  return /\b(promote|promoted|promotion|linear\/pr|pr text|pr evidence|before cleanup)\b/u.test(
    prompt
  );
}

function containsBaseCommit(prompt: string) {
  return /\b(base commit|base:\s|origin\/main at)\b/u.test(prompt);
}

function containsWorktreeBranchExpectation(prompt: string) {
  return /\b(isolated worktree|worktree branch|branch expectations|expected branch)\b/u.test(
    prompt
  );
}

function containsCleanupRules(prompt: string) {
  return /\b(clean up|cleanup|delete generated|remove generated)\b/u.test(
    prompt
  );
}

function containsComparisonWaitRules(prompt: string) {
  return /\b(wait for both|both .+ before comparing|comparison wait|compare .+ after both|do not compare .+ until)\b/u.test(
    prompt
  );
}
