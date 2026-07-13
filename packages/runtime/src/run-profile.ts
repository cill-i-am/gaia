import { Effect, FileSystem, Schema } from "effect";

import { BrowserEvidenceTargetUrlSchema } from "./browser-evidence.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";

export const BrowserEvidenceRequirementSchema = Schema.Literals([
  "optional",
  "required",
] as const);

/** Policy for whether browser evidence is allowed to fail a run. */
export type BrowserEvidenceRequirement =
  typeof BrowserEvidenceRequirementSchema.Type;

export const RunProfileNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("RunProfileName")
);

/** Name of a reusable Gaia run profile. */
export type RunProfileName = typeof RunProfileNameSchema.Type;

export class RunProfileChecks extends Schema.Class<RunProfileChecks>(
  "RunProfileChecks"
)({
  browserEvidence: BrowserEvidenceRequirementSchema,
}) {}

/** Browser automation defaults supplied by a reusable run profile. */
export class RunProfileBrowser extends Schema.Class<RunProfileBrowser>(
  "RunProfileBrowser"
)({
  targetUrl: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
}) {}

export class RunProfile extends Schema.Class<RunProfile>("RunProfile")({
  browser: Schema.optionalKey(RunProfileBrowser),
  checks: RunProfileChecks,
  name: RunProfileNameSchema,
  version: Schema.Literal(1),
}) {}

export type RunProfileSource = {
  readonly path: string;
};

const RunProfileJson = Schema.toCodecJson(RunProfile);
const decodeRunProfileJson = Schema.decodeUnknownSync(RunProfileJson);
const encodeRunProfileJson = Schema.encodeSync(RunProfileJson);
const parseRunProfileName = Schema.decodeUnknownSync(RunProfileNameSchema);

/** Default run profile used when no explicit profile is selected. */
export const defaultRunProfile = RunProfile.make({
  checks: RunProfileChecks.make({ browserEvidence: "optional" }),
  name: parseRunProfileName("default"),
  version: 1,
});

/** Parse a run profile from a decoded JSON boundary value. */
export const parseRunProfileJson = Schema.decodeUnknownSync(RunProfileJson);

/** Create a local file-backed run profile source. */
export function localRunProfileSource(path: string): RunProfileSource {
  return { path };
}

/** Resolve the run profile that should govern a run. */
export function resolveRunProfile(
  source?: RunProfileSource
): Effect.Effect<RunProfile, GaiaRuntimeError, FileSystem.FileSystem> {
  if (source === undefined) {
    return Effect.succeed(defaultRunProfile);
  }

  return readRunProfile(source.path);
}

/** Persist the resolved run profile as run evidence. */
export function writeRunProfile(input: {
  readonly paths: RunPaths;
  readonly profile: RunProfile;
}): Effect.Effect<RunProfile, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* fs.writeFileString(
      input.paths.runProfile,
      `${JSON.stringify(encodeRunProfileJson(input.profile), null, 2)}\n`
    );

    return input.profile;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "RunProfileWriteFailed",
          message: "Gaia could not write the run profile artifact.",
          recoverable: true,
        })
      )
    )
  );
}

function readRunProfile(
  profilePath: string
): Effect.Effect<RunProfile, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(profilePath);

    return yield* parseRunProfile(contents, profilePath);
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "RunProfileReadFailed",
          message: `Gaia could not read run profile '${profilePath}'.`,
          recoverable: false,
        })
      )
    )
  );
}

function parseRunProfile(contents: string, profilePath: string) {
  return Effect.try({
    try: () => decodeRunProfileJson(JSON.parse(contents)),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "RunProfileInvalid",
        message: `Run profile '${profilePath}' is not valid.`,
        recoverable: false,
      }),
  });
}
