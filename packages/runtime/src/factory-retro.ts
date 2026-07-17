import {
  FactoryRetro,
  FactoryRetroEntry,
  FactoryRetroSourceLink,
  DogfoodFinding,
  EvidencePromotion,
  EvidencePromotionCleanupStatusSchema,
  EvidencePromotionStatusSchema,
  PromotedEvidenceItem,
  RunIdSchema,
  RunSpec,
  parseDogfoodRetrospective,
  parseEvidencePromotion,
  type FactoryRetroEntrySource,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { makeRuntimeError } from "./errors.js";
import {
  runRelative,
  RunPathsSchema,
  type RunPaths,
  type RuntimePath,
} from "./paths.js";

const FactoryRetroJson = Schema.toCodecJson(FactoryRetro);
const encodeFactoryRetro = Schema.encodeSync(FactoryRetroJson);

const WriteFactoryRetroInputSchema = Schema.Struct({
  evidencePromotion: Schema.optionalKey(EvidencePromotion),
  paths: RunPathsSchema,
  runId: RunIdSchema,
  spec: RunSpec,
});

const OperatorNotesSchema = Schema.Struct({
  helped: Schema.Array(Schema.NonEmptyString),
  missed: Schema.Array(Schema.NonEmptyString),
  misled: Schema.Array(Schema.NonEmptyString),
  nextImprovement: Schema.optionalKey(Schema.NonEmptyString),
  sourceLinks: Schema.Array(FactoryRetroSourceLink),
});

type OperatorNotes = Schema.Schema.Type<typeof OperatorNotesSchema>;

const RecommendedImprovementInputSchema = Schema.Struct({
  findings: Schema.Array(DogfoodFinding),
  missed: Schema.Array(FactoryRetroEntry),
  misled: Schema.Array(FactoryRetroEntry),
});

const FactoryRetroRenderInputSchema = Schema.Struct({
  cleanupStatus: EvidencePromotionCleanupStatusSchema,
  generatedAt: Schema.NonEmptyString,
  helped: Schema.Array(FactoryRetroEntry),
  missed: Schema.Array(FactoryRetroEntry),
  misled: Schema.Array(FactoryRetroEntry),
  promotedEvidence: Schema.Array(PromotedEvidenceItem),
  promotionStatus: EvidencePromotionStatusSchema,
  recommendedNextFactoryImprovement: Schema.NonEmptyString,
  runId: RunIdSchema,
  sourceLinks: Schema.Array(FactoryRetroSourceLink),
});

type FactoryRetroRenderInput = Schema.Schema.Type<
  typeof FactoryRetroRenderInputSchema
>;

const FactoryRetroHeadingSchema = Schema.String;

export function writeFactoryRetro(
  input: Schema.Schema.Type<typeof WriteFactoryRetroInputSchema>
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const generatedAt = new Date().toISOString();
    const notes = parseOperatorNotes(input.spec.body);
    const retrospective = yield* readDogfoodRetrospective(input.paths);
    const evidencePromotion =
      input.evidencePromotion ?? (yield* readEvidencePromotion(input.paths));
    const findings = retrospective?.findings ?? [];
    const helped = dedupeEntries([
      ...entriesFromNotes(notes.helped, "operator-note"),
      ...observedHelpedEntries(input.paths, evidencePromotion),
    ]);
    const missed = dedupeEntries([
      ...entriesFromNotes(notes.missed, "operator-note"),
      ...missedEntries(findings),
    ]);
    const misled = dedupeEntries([
      ...entriesFromNotes(notes.misled, "operator-note"),
      ...misledEntries(findings),
    ]);
    const promotedEvidence = promotedEvidenceForRetro(
      input.paths,
      evidencePromotion
    );
    const sourceLinks = dedupeSourceLinks([
      ...notes.sourceLinks,
      ...sourceLinksFromRetrospective(findings),
      FactoryRetroSourceLink.make({
        artifactPath: runRelative(
          input.paths,
          input.paths.dogfoodRetrospective
        ),
        label: "Dogfood retrospective",
      }),
      ...(evidencePromotion === undefined
        ? []
        : [
            FactoryRetroSourceLink.make({
              artifactPath: evidencePromotion.artifactPath,
              label: "Evidence promotion",
            }),
          ]),
    ]);
    const recommendedNextFactoryImprovement =
      notes.nextImprovement ??
      recommendedImprovement({ findings, missed, misled });
    const markdown = renderFactoryRetroMarkdown({
      cleanupStatus: evidencePromotion?.cleanupStatus ?? "not-completed",
      generatedAt,
      helped,
      missed,
      misled,
      promotedEvidence,
      promotionStatus:
        evidencePromotion?.promotionStatus ?? "pending-promotion",
      recommendedNextFactoryImprovement,
      runId: input.runId,
      sourceLinks,
    });
    const retro = FactoryRetro.make({
      artifactPath: gaiaRelative(input.paths, input.paths.factoryRetroJson),
      cleanupStatus: evidencePromotion?.cleanupStatus ?? "not-completed",
      generatedAt,
      helped,
      markdown,
      markdownPath: gaiaRelative(input.paths, input.paths.factoryRetroMarkdown),
      missed,
      misled,
      promotedEvidence,
      promotionStatus:
        evidencePromotion?.promotionStatus ?? "pending-promotion",
      recommendedNextFactoryImprovement,
      runId: input.runId,
      sourceLinks,
      status:
        helped.length === 0 && missed.length === 0 && misled.length === 0
          ? "clean"
          : "findings",
      version: 1,
    });

    yield* fs.makeDirectory(input.paths.promotedEvidenceDirectory, {
      recursive: true,
    });
    yield* fs.writeFileString(input.paths.factoryRetroMarkdown, markdown);
    yield* fs.writeFileString(
      input.paths.factoryRetroJson,
      `${JSON.stringify(encodeFactoryRetro(retro), null, 2)}\n`
    );

    return retro;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "FactoryRetroWriteFailed",
          message: "Gaia could not write factory-retro artifacts.",
          recoverable: true,
        })
      )
    )
  );
}

function observedHelpedEntries(
  paths: RunPaths,
  evidencePromotion: EvidencePromotion | undefined
) {
  const entries: Array<FactoryRetroEntry> = [];
  if (evidencePromotion?.reportPaths.workerPlanPath !== undefined) {
    entries.push(
      FactoryRetroEntry.make({
        artifactPath: evidencePromotion.reportPaths.workerPlanPath,
        source: "observed",
        summary: "Worker planning evidence was available for operator review.",
      })
    );
  }

  if (
    evidencePromotion?.reportPaths.reportMarkdownPath !== undefined ||
    evidencePromotion?.reportPaths.reportJsonPath !== undefined
  ) {
    entries.push(
      factoryRetroEntry({
        ...(evidencePromotion.reportPaths.reportMarkdownPath === undefined &&
        evidencePromotion.reportPaths.reportJsonPath === undefined
          ? {}
          : {
              artifactPath:
                evidencePromotion.reportPaths.reportMarkdownPath ??
                evidencePromotion.reportPaths.reportJsonPath,
            }),
        source: "observed",
        summary:
          "Human run reports were available as durable handoff evidence.",
      })
    );
  }

  if (evidencePromotion?.verification.path !== undefined) {
    entries.push(
      FactoryRetroEntry.make({
        artifactPath: evidencePromotion.verification.path,
        source: "observed",
        summary: `Verification evidence was recorded with status '${evidencePromotion.verification.status}'.`,
      })
    );
  }

  if (evidencePromotion?.pullRequest.status === "promoted") {
    entries.push(
      FactoryRetroEntry.make({
        source: "observed",
        summary: "PR, check, or feedback evidence was selected for promotion.",
      })
    );
  }

  if (entries.length === 0) {
    entries.push(
      FactoryRetroEntry.make({
        artifactPath: runRelative(paths, paths.events),
        source: "observed",
        summary: "events.jsonl preserved the run history for later replay.",
      })
    );
  }

  return entries;
}

function missedEntries(findings: ReadonlyArray<DogfoodFinding>) {
  return findings
    .filter((finding) => finding.severity !== "info")
    .map((finding) =>
      factoryRetroEntry({
        ...(finding.sources[0]?.artifactPath === undefined
          ? {}
          : { artifactPath: finding.sources[0].artifactPath }),
        source: "observed",
        summary: finding.summary,
      })
    );
}

function misledEntries(findings: ReadonlyArray<DogfoodFinding>) {
  return findings
    .filter((finding) => finding.severity === "blocker")
    .map((finding) =>
      factoryRetroEntry({
        ...(finding.sources[0]?.artifactPath === undefined
          ? {}
          : { artifactPath: finding.sources[0].artifactPath }),
        source: "inferred",
        summary: finding.summary,
      })
    );
}

function promotedEvidenceForRetro(
  paths: RunPaths,
  evidencePromotion: EvidencePromotion | undefined
) {
  if (evidencePromotion === undefined) {
    return [
      PromotedEvidenceItem.make({
        label: "Factory retro markdown",
        path: gaiaRelative(paths, paths.factoryRetroMarkdown),
        status: "pending-promotion",
        summary: "Factory-retro Markdown is available for Linear or PR text.",
      }),
    ];
  }

  return [
    ...evidencePromotion.selectedEvidence,
    PromotedEvidenceItem.make({
      label: "Factory retro markdown",
      path: gaiaRelative(paths, paths.factoryRetroMarkdown),
      status: evidencePromotion.promotionStatus,
      summary: "Factory-retro Markdown is available for Linear or PR text.",
    }),
  ];
}

function sourceLinksFromRetrospective(findings: ReadonlyArray<DogfoodFinding>) {
  return findings.flatMap((finding) =>
    finding.sources.map((source) =>
      FactoryRetroSourceLink.make({
        ...(source.artifactPath === undefined
          ? {}
          : { artifactPath: source.artifactPath }),
        label: source.label,
        ...(source.url === undefined ? {} : { url: source.url }),
      })
    )
  );
}

function recommendedImprovement(
  input: Schema.Schema.Type<typeof RecommendedImprovementInputSchema>
) {
  const firstCandidate = input.findings.find(
    (finding) => finding.candidateIssue !== undefined
  )?.candidateIssue;
  if (firstCandidate !== undefined) {
    return firstCandidate.title;
  }

  if (input.misled.length > 0) {
    return "Tighten factory planning so misleading guidance is surfaced before worker execution.";
  }

  if (input.missed.length > 0) {
    return "Add focused factory planning checks for the missed evidence before the next lane dispatch.";
  }

  return "Keep collecting compact factory retrospectives so future runs have comparable dogfood evidence.";
}

function parseOperatorNotes(body: string): OperatorNotes {
  const helped = extractSectionItems(body, ["factory retro helped", "helped"]);
  const missed = extractSectionItems(body, ["factory retro missed", "missed"]);
  const misled = extractSectionItems(body, ["factory retro misled", "misled"]);
  const nextImprovement = extractSectionItems(body, [
    "factory retro next improvement",
    "recommended next factory improvement",
    "next factory improvement",
  ])[0];
  const sourceLinks = extractSectionItems(body, [
    "factory retro source links",
    "source links",
  ]).map(parseSourceLink);
  return {
    helped,
    missed,
    misled,
    ...(nextImprovement === undefined ? {} : { nextImprovement }),
    sourceLinks,
  };
}

function entriesFromNotes(
  notes: ReadonlyArray<string>,
  source: FactoryRetroEntrySource
) {
  return notes.map((summary) =>
    factoryRetroEntry({
      source,
      summary,
    })
  );
}

function factoryRetroEntry(input: typeof FactoryRetroEntry.Type) {
  return FactoryRetroEntry.make({
    ...(input.artifactPath === undefined
      ? {}
      : { artifactPath: input.artifactPath }),
    source: input.source,
    summary: input.summary,
  });
}

function extractSectionItems(
  body: string,
  headings: ReadonlyArray<string>
): ReadonlyArray<string> {
  const lines = body.split(/\r?\n/u);
  const wanted = new Set(headings.map(normalizeHeading));
  const items: Array<string> = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(?:#{1,6}\s*)?(.+?):?\s*$/u);
    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/u);
    if (heading !== null && bullet === null) {
      const normalized = normalizeHeading(heading[1] ?? "");
      if (wanted.has(normalized)) {
        inSection = true;
        continue;
      }
      if (inSection && normalized.length > 0) {
        inSection = false;
      }
    }

    if (!inSection || bullet === null) {
      continue;
    }

    const item = bullet[1]?.trim();
    if (item !== undefined && item.length > 0) {
      items.push(item);
    }
  }

  return items;
}

function parseSourceLink(item: string) {
  const match = item.match(/^(.+?):\s*(https?:\/\/\S+)$/u);
  if (match === null) {
    return FactoryRetroSourceLink.make({ label: item });
  }

  return FactoryRetroSourceLink.make({
    label: match[1]?.trim() ?? "Source",
    ...(match[2] === undefined ? {} : { url: match[2].trim() }),
  });
}

function renderFactoryRetroMarkdown(input: FactoryRetroRenderInput) {
  return `# Factory Retro ${input.runId}

Promotion status: ${input.promotionStatus}
Cleanup status: ${input.cleanupStatus}
Generated at: ${input.generatedAt}

## Helped

${entryList(input.helped)}

## Missed

${entryList(input.missed)}

## Misled

${entryList(input.misled)}

## Promoted Evidence

${input.promotedEvidence.map(formatPromotedEvidence).join("\n")}

## Recommended Next Factory Improvement

${input.recommendedNextFactoryImprovement}

## Source Links

${input.sourceLinks.map(formatSourceLink).join("\n")}
`;
}

function entryList(entries: ReadonlyArray<FactoryRetroEntry>) {
  return entries.length === 0
    ? "- none"
    : entries
        .map(
          (entry) =>
            `- ${entry.source}: ${entry.summary}${formatPath(entry.artifactPath)}`
        )
        .join("\n");
}

function formatPromotedEvidence(evidence: PromotedEvidenceItem) {
  return `- ${evidence.status}: ${evidence.label}${formatPath(evidence.path)} - ${evidence.summary}`;
}

function formatSourceLink(link: FactoryRetroSourceLink) {
  const target = link.url ?? link.artifactPath ?? "source unavailable";
  return `- ${link.label}: ${target}`;
}

function formatPath(path: string | undefined) {
  return path === undefined ? "" : ` (${path})`;
}

function dedupeEntries(entries: ReadonlyArray<FactoryRetroEntry>) {
  const seen = new Set<string>();
  const output: Array<FactoryRetroEntry> = [];
  for (const entry of entries) {
    const key = `${entry.source}:${entry.summary}:${entry.artifactPath ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(entry);
  }
  return output;
}

function dedupeSourceLinks(links: ReadonlyArray<FactoryRetroSourceLink>) {
  const seen = new Set<string>();
  const output: Array<FactoryRetroSourceLink> = [];
  for (const link of links) {
    const key = `${link.label}:${link.url ?? ""}:${link.artifactPath ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(link);
  }
  return output;
}

function normalizeHeading(
  input: Schema.Schema.Type<typeof FactoryRetroHeadingSchema>
) {
  return input
    .replace(/^#+\s*/u, "")
    .replace(/:$/u, "")
    .trim()
    .toLowerCase();
}

function readDogfoodRetrospective(paths: RunPaths) {
  return readJsonIfExists(
    paths.dogfoodRetrospective,
    parseDogfoodRetrospective
  );
}

function readEvidencePromotion(paths: RunPaths) {
  return readJsonIfExists(paths.evidencePromotionJson, parseEvidencePromotion);
}

function readJsonIfExists<A>(
  artifactPath: RuntimePath,
  parse: (input: unknown) => A
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(artifactPath);
    if (!exists) {
      return undefined;
    }

    const contents = yield* fs.readFileString(artifactPath);
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(contents),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRetroJsonInvalid",
          message: "A factory retro source artifact was not valid JSON.",
          recoverable: true,
        }),
    });

    return yield* Effect.try({
      try: () => parse(parsed),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "FactoryRetroArtifactInvalid",
          message:
            "A factory retro source artifact did not match Gaia's schema.",
          recoverable: true,
        }),
    });
  });
}

function gaiaRelative(
  paths: RunPaths,
  absolutePath: RuntimePath
): typeof FactoryRetro.fields.artifactPath.Encoded {
  if (absolutePath.startsWith(`${paths.gaiaRoot}/`)) {
    return `.gaia/${absolutePath.slice(paths.gaiaRoot.length + 1)}`;
  }

  return absolutePath;
}
