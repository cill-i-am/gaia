import * as Schema from "effect/Schema";
import YAML from "yaml";

const frontmatterPattern =
  /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---\r?\n?(?<body>[\s\S]*)$/u;

/** Parsed optional metadata at the top of a Gaia Markdown spec. */
export class SpecFrontmatter extends Schema.Class<SpecFrontmatter>(
  "SpecFrontmatter"
)({
  title: Schema.optionalKey(Schema.NonEmptyString),
}) {}

/** Parsed input spec consumed by prototype Gaia runs. */
export class RunSpec extends Schema.Class<RunSpec>("RunSpec")({
  body: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
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
  });
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
