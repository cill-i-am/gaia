import { Effect, FileSystem, Schema } from "effect";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import {
  RunPathsSchema,
  RuntimePathSchema,
  type RuntimePath,
} from "./paths.js";

export const SkillNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("SkillName")
);

export type SkillName = typeof SkillNameSchema.Type;

export const SkillCommitSchema = Schema.NonEmptyString.pipe(
  Schema.brand("SkillCommit")
);

export const SkillSourcePathSchema = Schema.NonEmptyString.pipe(
  Schema.brand("SkillSourcePath")
);

export const SkillSourceRepositorySchema = Schema.NonEmptyString.pipe(
  Schema.brand("SkillSourceRepository")
);

export const SkillVersionSchema = Schema.NonEmptyString.pipe(
  Schema.brand("SkillVersion")
);

export class SkillManifestEntry extends Schema.Class<SkillManifestEntry>(
  "SkillManifestEntry"
)({
  commit: Schema.optionalKey(SkillCommitSchema),
  name: SkillNameSchema,
  sourcePath: SkillSourcePathSchema,
  sourceRepository: SkillSourceRepositorySchema,
  version: Schema.optionalKey(SkillVersionSchema),
}) {}

export class SkillManifest extends Schema.Class<SkillManifest>("SkillManifest")(
  {
    skills: Schema.Array(SkillManifestEntry),
  }
) {}

export const SkillManifestSourceSchema = Schema.Struct({
  path: RuntimePathSchema,
});

export type SkillManifestSource = typeof SkillManifestSourceSchema.Type;

const WriteSkillManifestInputSchema = Schema.Struct({
  paths: RunPathsSchema,
  source: Schema.optionalKey(SkillManifestSourceSchema),
});

const SkillManifestJson = Schema.toCodecJson(SkillManifest);
const decodeSkillManifestJson = Schema.decodeUnknownSync(SkillManifestJson);
const encodeSkillManifestJson = Schema.encodeSync(SkillManifestJson);
const parseSkillManifestSource = Schema.decodeUnknownSync(
  SkillManifestSourceSchema
);

export function localSkillManifestSource(path: unknown): SkillManifestSource {
  return parseSkillManifestSource({ path });
}

export function writeSkillManifest(
  input: typeof WriteSkillManifestInputSchema.Type
): Effect.Effect<SkillManifest, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifest =
      input.source === undefined
        ? SkillManifest.make({ skills: [] })
        : yield* readSkillManifest(input.source.path);

    yield* fs.writeFileString(
      input.paths.skillManifest,
      `${JSON.stringify(encodeSkillManifestJson(manifest), null, 2)}\n`
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
        })
      )
    )
  );
}

export function selectedSkillNames(
  manifest: SkillManifest
): ReadonlyArray<SkillName> {
  return manifest.skills.map((skill) => skill.name);
}

function readSkillManifest(
  manifestPath: RuntimePath
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
          })
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
        })
      )
    )
  );
}

function parseSkillManifest(contents: string, manifestPath: RuntimePath) {
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
