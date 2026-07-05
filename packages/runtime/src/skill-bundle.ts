import { Effect, FileSystem, Path, Schema } from "effect";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";
import {
  SkillManifest,
  SkillNameSchema,
  type SkillManifestEntry,
  type SkillManifestSource,
} from "./skill-manifest.js";

export const SkillBundleResolutionSchema = Schema.Literals([
  "external",
  "local",
] as const);

export type SkillBundleResolution = typeof SkillBundleResolutionSchema.Type;

export const SkillBundleStatusSchema = Schema.Literals([
  "empty",
  "ready",
  "requires-install",
] as const);

export type SkillBundleStatus = typeof SkillBundleStatusSchema.Type;

export class SkillBundleEntry extends Schema.Class<SkillBundleEntry>(
  "SkillBundleEntry",
)({
  commit: Schema.optionalKey(Schema.NonEmptyString),
  name: SkillNameSchema,
  resolution: SkillBundleResolutionSchema,
  resolvedPath: Schema.optionalKey(Schema.NonEmptyString),
  sourcePath: Schema.NonEmptyString,
  sourceRepository: Schema.NonEmptyString,
  version: Schema.optionalKey(Schema.NonEmptyString),
}) {}

export class SkillBundle extends Schema.Class<SkillBundle>("SkillBundle")({
  skills: Schema.Array(SkillBundleEntry),
  status: SkillBundleStatusSchema,
  version: Schema.Literal(1),
}) {}

const SkillBundleJson = Schema.toCodecJson(SkillBundle);
const encodeSkillBundleJson = Schema.encodeSync(SkillBundleJson);
export const parseSkillBundleJson = Schema.decodeUnknownSync(SkillBundleJson);

export function writeSkillBundle(input: {
  readonly manifest: SkillManifest;
  readonly paths: RunPaths;
  readonly source?: SkillManifestSource;
}): Effect.Effect<
  SkillBundle,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries: Array<SkillBundleEntry> = [];

    for (const skill of input.manifest.skills) {
      entries.push(yield* resolveSkillBundleEntry(skill, input.source));
    }

    const bundle = SkillBundle.make({
      skills: entries,
      status: skillBundleStatus(entries),
      version: 1,
    });

    yield* fs.writeFileString(
      input.paths.skillBundle,
      `${JSON.stringify(encodeSkillBundleJson(bundle), null, 2)}\n`,
    );

    return bundle;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "SkillBundleWriteFailed",
          message: "Gaia could not write the skill bundle artifact.",
          recoverable: false,
        }),
      ),
    ),
  );
}

function resolveSkillBundleEntry(
  skill: SkillManifestEntry,
  source: SkillManifestSource | undefined,
) {
  return isLocalSkillSource(skill.sourceRepository)
    ? resolveLocalSkillBundleEntry(skill, source)
    : Effect.succeed(
        SkillBundleEntry.make({
          ...(skill.commit === undefined ? {} : { commit: skill.commit }),
          name: skill.name,
          resolution: "external",
          sourcePath: skill.sourcePath,
          sourceRepository: skill.sourceRepository,
          ...(skill.version === undefined ? {} : { version: skill.version }),
        }),
      );
}

function resolveLocalSkillBundleEntry(
  skill: SkillManifestEntry,
  source: SkillManifestSource | undefined,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestDirectory =
      source === undefined ? "." : path.dirname(source.path);
    const resolvedPath = path.isAbsolute(skill.sourcePath)
      ? skill.sourcePath
      : path.resolve(manifestDirectory, skill.sourcePath);
    const skillInfo = yield* fs.stat(resolvedPath).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "SkillBundleSourceUnavailable",
            message: `Skill '${skill.name}' source '${resolvedPath}' is not available.`,
            recoverable: false,
          }),
        ),
      ),
    );

    if (skillInfo.type !== "Directory") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "SkillBundleSourceNotDirectory",
          message: `Skill '${skill.name}' source '${resolvedPath}' must be a directory.`,
          recoverable: false,
        }),
      );
    }

    const skillMarkdownPath = path.join(resolvedPath, "SKILL.md");
    const hasSkillMarkdown = yield* fs.exists(skillMarkdownPath);
    if (!hasSkillMarkdown) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "SkillBundleSkillMarkdownMissing",
          message: `Skill '${skill.name}' source '${resolvedPath}' must contain SKILL.md.`,
          recoverable: false,
        }),
      );
    }

    return SkillBundleEntry.make({
      ...(skill.commit === undefined ? {} : { commit: skill.commit }),
      name: skill.name,
      resolution: "local",
      resolvedPath,
      sourcePath: skill.sourcePath,
      sourceRepository: skill.sourceRepository,
      ...(skill.version === undefined ? {} : { version: skill.version }),
    });
  });
}

function skillBundleStatus(
  entries: ReadonlyArray<SkillBundleEntry>,
): SkillBundleStatus {
  if (entries.length === 0) {
    return "empty";
  }

  return entries.some((entry) => entry.resolution === "external")
    ? "requires-install"
    : "ready";
}

function isLocalSkillSource(sourceRepository: string) {
  return sourceRepository === "local" || sourceRepository === "file";
}
