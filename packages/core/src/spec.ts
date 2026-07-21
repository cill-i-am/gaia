import * as Schema from "effect/Schema";
import YAML from "yaml";

import {
  deriveExplicitSpecItemDigest,
  ExplicitSpecItemDigestSchema,
  normalizeExplicitSpecStatement,
  RunRelativeArtifactPathSchema,
} from "./run-contract.js";
import {
  VerificationCommandRequestV1,
  VerificationSourceKeySchema,
} from "./verification-command.js";

const frontmatterPattern =
  /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---\r?\n?(?<body>[\s\S]*)$/u;
const verificationSourceKeySchema = VerificationSourceKeySchema;
const boundedSourceTextSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(4_096)),
  Schema.check(
    Schema.makeFilter(
      (value) => value.isWellFormed() && !value.includes("\0"),
      {
        identifier: "BoundedVerificationSourceText",
      }
    )
  )
);
const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** Source-owned bounded argv request for one V2 command proof claim. */
export const VerificationCommandSourceV2 = VerificationCommandRequestV1;

const verificationSourceFields = {
  key: verificationSourceKeySchema,
  sourceItemDigest: ExplicitSpecItemDigestSchema,
  statement: boundedSourceTextSchema,
} as const;
const verificationClaimFields = {
  ...verificationSourceFields,
  phase: Schema.Literals(["prePublication", "postPublication"] as const),
} as const;

/** Source-owned acceptance outcome and exact claim mappings. */
export class VerificationOutcomeSourceV2 extends Schema.Class<VerificationOutcomeSourceV2>(
  "VerificationOutcomeSourceV2"
)(
  {
    ...verificationSourceFields,
    conditionalClaims: Schema.Array(verificationSourceKeySchema),
    postPublicationRequiredClaims: Schema.Array(verificationSourceKeySchema),
    prePublicationRequiredClaims: Schema.Array(verificationSourceKeySchema),
  },
  strict
) {}

/** Source-owned command claim. */
export class VerificationCommandClaimSourceV2 extends Schema.Class<VerificationCommandClaimSourceV2>(
  "VerificationCommandClaimSourceV2"
)(
  {
    ...verificationClaimFields,
    command: VerificationCommandSourceV2,
    kind: Schema.Literal("command"),
  },
  strict
) {}

export class VerificationArtifactSelectorV2 extends Schema.Class<VerificationArtifactSelectorV2>(
  "VerificationArtifactSelectorV2"
)({ paths: Schema.NonEmptyArray(RunRelativeArtifactPathSchema) }, strict) {}

export class VerificationBrowserSelectorV2 extends Schema.Class<VerificationBrowserSelectorV2>(
  "VerificationBrowserSelectorV2"
)(
  {
    evidenceSelector: verificationSourceKeySchema,
    targetUrl: boundedSourceTextSchema,
  },
  strict
) {}

export class VerificationExternalCheckSelectorV2 extends Schema.Class<VerificationExternalCheckSelectorV2>(
  "VerificationExternalCheckSelectorV2"
)(
  {
    checkName: boundedSourceTextSchema,
    conclusion: Schema.Literal("success"),
    provider: Schema.Literal("github"),
    workflow: boundedSourceTextSchema,
  },
  strict
) {}

export class VerificationHumanJudgmentSelectorV2 extends Schema.Class<VerificationHumanJudgmentSelectorV2>(
  "VerificationHumanJudgmentSelectorV2"
)(
  {
    decision: Schema.Literal("approved"),
    source: Schema.Literal("localOperatorPairedReview"),
  },
  strict
) {}

/** Source-owned exact artifact-integrity claim. */
export class VerificationArtifactClaimSourceV2 extends Schema.Class<VerificationArtifactClaimSourceV2>(
  "VerificationArtifactClaimSourceV2"
)(
  {
    ...verificationClaimFields,
    kind: Schema.Literal("artifact-integrity"),
    selector: VerificationArtifactSelectorV2,
  },
  strict
) {}

/** Source-owned exact browser-evidence claim. */
export class VerificationBrowserClaimSourceV2 extends Schema.Class<VerificationBrowserClaimSourceV2>(
  "VerificationBrowserClaimSourceV2"
)(
  {
    ...verificationClaimFields,
    kind: Schema.Literal("browser"),
    selector: VerificationBrowserSelectorV2,
  },
  strict
) {}

/** Source-owned exact external-check claim. */
export class VerificationExternalCheckClaimSourceV2 extends Schema.Class<VerificationExternalCheckClaimSourceV2>(
  "VerificationExternalCheckClaimSourceV2"
)(
  {
    ...verificationClaimFields,
    kind: Schema.Literal("external-check"),
    selector: VerificationExternalCheckSelectorV2,
  },
  strict
) {}

/** Source-owned exact explicit-human-decision claim. */
export class VerificationHumanJudgmentClaimSourceV2 extends Schema.Class<VerificationHumanJudgmentClaimSourceV2>(
  "VerificationHumanJudgmentClaimSourceV2"
)(
  {
    ...verificationClaimFields,
    kind: Schema.Literal("human-judgment"),
    selector: VerificationHumanJudgmentSelectorV2,
  },
  strict
) {}

/** Strict source declaration that opts a spec into executable V2 proof. */
export class VerificationSourceV2 extends Schema.Class<VerificationSourceV2>(
  "VerificationSourceV2"
)(
  {
    claims: Schema.NonEmptyArray(
      Schema.Union([
        VerificationCommandClaimSourceV2,
        VerificationArtifactClaimSourceV2,
        VerificationBrowserClaimSourceV2,
        VerificationExternalCheckClaimSourceV2,
        VerificationHumanJudgmentClaimSourceV2,
      ])
    ),
    outcomes: Schema.NonEmptyArray(VerificationOutcomeSourceV2),
    version: Schema.Literal(2),
  },
  strict
) {}

/** Parsed optional metadata at the top of a Gaia Markdown spec. */
export class SpecFrontmatter extends Schema.Class<SpecFrontmatter>(
  "SpecFrontmatter"
)({
  title: Schema.optionalKey(Schema.NonEmptyString),
  verification: Schema.optionalKey(VerificationSourceV2),
}) {}

/** Parsed input spec consumed by prototype Gaia runs. */
export class RunSpec extends Schema.Class<RunSpec>("RunSpec")({
  body: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  verification: Schema.optionalKey(VerificationSourceV2),
}) {}

/** Parse a Markdown spec with optional YAML frontmatter. */
export function parseMarkdownSpec(
  input: string,
  fallbackTitle: string
): RunSpec {
  const match = frontmatterPattern.exec(input);

  if (match === null) {
    return RunSpec.make({
      body: parseNonEmptyString(input.trim(), "Spec body must not be empty."),
      title: parseNonEmptyString(
        fallbackTitle,
        "Spec title must not be empty."
      ),
    });
  }

  const frontmatter = parseFrontmatter(match.groups?.frontmatter ?? "");
  const body = parseNonEmptyString(
    (match.groups?.body ?? "").trim(),
    "Spec body must not be empty."
  );

  return RunSpec.make({
    body,
    title:
      frontmatter.title ??
      parseNonEmptyString(fallbackTitle, "Spec title must not be empty."),
    ...(frontmatter.verification === undefined
      ? {}
      : {
          verification: validateVerificationSource(
            frontmatter.verification,
            body
          ),
        }),
  });
}

function validateVerificationSource(
  verification: VerificationSourceV2,
  body: string
): VerificationSourceV2 {
  assertUnique(verification.outcomes, (entry) => entry.key, "outcome keys");
  assertUnique(verification.claims, (entry) => entry.key, "claim keys");
  assertUnique(
    [...verification.outcomes, ...verification.claims],
    (entry) => entry.sourceItemDigest,
    "source item digests"
  );

  const acceptanceItems = extractRawSectionItems(body, "Acceptance Criteria");
  const verificationItems = extractRawSectionItems(body, "Verification");
  assertSourceEntries(
    verification.outcomes,
    acceptanceItems,
    "acceptanceCriteria"
  );
  assertSourceEntries(
    verification.claims,
    verificationItems,
    "verificationChecks"
  );

  const claims = new Map(
    verification.claims.map((claim) => [claim.key, claim])
  );
  const requirementKindsByClaim = new Map<
    string,
    Set<"conditional" | "required">
  >();
  for (const outcome of verification.outcomes) {
    const mappings = [
      ...outcome.prePublicationRequiredClaims,
      ...outcome.postPublicationRequiredClaims,
      ...outcome.conditionalClaims,
    ];
    if (new Set(mappings).size !== mappings.length)
      throw new Error("Verification outcome claim mappings overlap or repeat.");
    for (const key of outcome.prePublicationRequiredClaims) {
      if (claims.get(key)?.phase !== "prePublication")
        throw new Error(
          "Pre-publication mapping is dangling or phase-mismatched."
        );
      addRequirementKind(requirementKindsByClaim, key, "required");
    }
    for (const key of outcome.postPublicationRequiredClaims) {
      if (claims.get(key)?.phase !== "postPublication")
        throw new Error(
          "Post-publication mapping is dangling or phase-mismatched."
        );
      addRequirementKind(requirementKindsByClaim, key, "required");
    }
    for (const key of outcome.conditionalClaims) {
      if (!claims.has(key))
        throw new Error("Conditional claim mapping is dangling.");
      addRequirementKind(requirementKindsByClaim, key, "conditional");
    }
  }
  for (const key of claims.keys()) {
    const kinds = requirementKindsByClaim.get(key);
    if (kinds === undefined)
      throw new Error("Structured verification contains an unmapped claim.");
    if (kinds.size !== 1)
      throw new Error(
        "A verification claim cannot be both required and conditional."
      );
  }
  return verification;
}

function addRequirementKind(
  requirements: Map<string, Set<"conditional" | "required">>,
  key: string,
  kind: "conditional" | "required"
) {
  const existing = requirements.get(key);
  if (existing === undefined) requirements.set(key, new Set([kind]));
  else existing.add(kind);
}

const VerificationSourceEntrySchema = Schema.Struct({
  sourceItemDigest: ExplicitSpecItemDigestSchema,
  statement: boundedSourceTextSchema,
});
type VerificationSourceEntry = Schema.Schema.Type<
  typeof VerificationSourceEntrySchema
>;

function assertSourceEntries(
  entries: ReadonlyArray<VerificationSourceEntry>,
  rawItems: readonly string[],
  section: "acceptanceCriteria" | "verificationChecks"
) {
  if (entries.length !== rawItems.length)
    throw new Error(
      `Structured ${section} entries do not own every body item.`
    );
  for (const entry of entries) {
    const statement = normalizeExplicitSpecStatement(entry.statement);
    if (statement !== entry.statement)
      throw new Error("Frontmatter statement is not canonically normalized.");
    const expectedDigest = deriveExplicitSpecItemDigest({ section, statement });
    if (entry.sourceItemDigest !== expectedDigest)
      throw new Error("Structured source item digest is stale or rebound.");
    const matches = rawItems.filter(
      (item) => normalizeExplicitSpecStatement(item) === statement
    );
    if (matches.length !== 1)
      throw new Error(
        "Structured source item must match exactly one raw body item."
      );
  }
}

function extractRawSectionItems(body: string, heading: string) {
  const items: string[] = [];
  let active = false;
  for (const line of body.replaceAll("\r\n", "\n").split("\n")) {
    const headingMatch = /^##\s+(.+?)\s*$/u.exec(line);
    if (headingMatch !== null) {
      active = headingMatch[1] === heading;
      continue;
    }
    if (active && line.startsWith("- ")) items.push(line.slice(2));
  }
  return items;
}

function assertUnique<T>(
  entries: readonly T[],
  key: (entry: T) => string,
  label: string
) {
  if (new Set(entries.map(key)).size !== entries.length)
    throw new Error(`Structured verification has duplicate ${label}.`);
}

function parseFrontmatter(input: string): SpecFrontmatter {
  const parsed: unknown = YAML.parse(input) ?? {};
  return Schema.decodeUnknownSync(SpecFrontmatter)(parsed);
}

function parseNonEmptyString(input: string, message: string) {
  try {
    return Schema.decodeUnknownSync(Schema.NonEmptyString)(input);
  } catch (cause) {
    throw new Error(message, { cause });
  }
}
