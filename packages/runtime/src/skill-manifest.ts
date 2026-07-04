import { Effect, FileSystem, Schema } from "effect";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";

export const SkillNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("SkillName"),
);

export type SkillName = typeof SkillNameSchema.Type;

export class SkillManifestEntry extends Schema.Class<SkillManifestEntry>(
  "SkillManifestEntry",
)({
  commit: Schema.optionalKey(Schema.NonEmptyString),
  name: SkillNameSchema,
  sourcePath: Schema.NonEmptyString,
  sourceRepository: Schema.NonEmptyString,
  version: Schema.optionalKey(Schema.NonEmptyString),
}) {}

export class SkillManifest extends Schema.Class<SkillManifest>(
  "SkillManifest",
)({
  skills: Schema.Array(SkillManifestEntry),
}) {}

export type SkillManifestSource = {
  readonly path: string;
};

const SkillManifestJson = Schema.toCodecJson(SkillManifest);
const decodeSkillManifestJson = Schema.decodeUnknownSync(SkillManifestJson);
const encodeSkillManifestJson = Schema.encodeSync(SkillManifestJson);

export function localSkillManifestSource(path: string): SkillManifestSource {
  return { path };
}

export function writeSkillManifest(input: {
  readonly paths: RunPaths;
  readonly source?: SkillManifestSource;
}): Effect.Effect<SkillManifest, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifest =
      input.source === undefined
        ? SkillManifest.make({ skills: [] })
        : yield* readSkillManifest(input.source.path);

    yield* fs.writeFileString(
      input.paths.skillManifest,
      `${JSON.stringify(encodeSkillManifestJson(manifest), null, 2)}\n`,
    );

    return manifest;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "SkillManifestWriteFailed",
          message: "Gaia could not write the skill manifest artifact.",
          recoverable: true,
        }),
      ),
    ),
  );
}

export function selectedSkillNames(
  manifest: SkillManifest,
): ReadonlyArray<SkillName> {
  return manifest.skills.map((skill) => skill.name);
}

function readSkillManifest(
  manifestPath: string,
): Effect.Effect<SkillManifest, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(manifestPath);
    const manifest = yield* parseSkillManifest(contents, manifestPath);

    for (const skill of manifest.skills) {
      if (skill.version === undefined && skill.commit === undefined) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "SkillManifestEntryUnpinned",
            message: `Skill manifest entry '${skill.name}' must include a version or commit.`,
            recoverable: false,
          }),
        );
      }
    }

    return manifest;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "SkillManifestReadFailed",
          message: `Gaia could not read skill manifest '${manifestPath}'.`,
          recoverable: false,
        }),
      ),
    ),
  );
}

function parseSkillManifest(contents: string, manifestPath: string) {
  return Effect.try({
    try: () => decodeSkillManifestJson(JSON.parse(contents)),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "SkillManifestInvalid",
        message: `Skill manifest '${manifestPath}' is not valid.`,
        recoverable: false,
      }),
  });
}
