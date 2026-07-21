import { Effect, FileSystem, Schema } from "effect";

import {
  BrowserEvidenceTargetUrlSchema,
  parseBrowserEvidenceTargetUrl,
} from "./browser-evidence.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import { RunPathsSchema } from "./paths.js";

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

const RunProfileSourcePathSchema = Schema.String.pipe(
  Schema.brand("RunProfileSourcePath")
);
export const RunProfileSourceSchema = Schema.Struct({
  path: RunProfileSourcePathSchema,
});

export type RunProfileSource = Schema.Schema.Type<
  typeof RunProfileSourceSchema
>;

const RunProfileJson = Schema.toCodecJson(RunProfile);
const decodeRunProfileJson = Schema.decodeUnknownSync(RunProfileJson);
const encodeRunProfileJson = Schema.encodeSync(RunProfileJson);
const parseRunProfileName = Schema.decodeUnknownSync(RunProfileNameSchema);
const parseRunProfileSource = Schema.decodeUnknownSync(RunProfileSourceSchema);

/** Default run profile used when no explicit profile is selected. */
export const defaultRunProfile = RunProfile.make({
  checks: RunProfileChecks.make({ browserEvidence: "optional" }),
  name: parseRunProfileName("default"),
  version: 1,
});

/** Parse a run profile from a decoded JSON boundary value. */
export const parseRunProfileJson = Schema.decodeUnknownSync(RunProfileJson);

/** Create a local file-backed run profile source. */
export function localRunProfileSource(
  path: typeof RunProfileSourcePathSchema.Encoded
): RunProfileSource {
  return parseRunProfileSource({ path });
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
const WriteRunProfileInputSchema = Schema.Struct({
  paths: RunPathsSchema,
  profile: RunProfile,
});

export function writeRunProfile(
  input: Schema.Schema.Type<typeof WriteRunProfileInputSchema>
): Effect.Effect<RunProfile, GaiaRuntimeError, FileSystem.FileSystem> {
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
  profilePath: typeof RunProfileSourcePathSchema.Type
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
          message: "Gaia could not read the selected run profile.",
          recoverable: false,
        })
      )
    )
  );
}

function parseRunProfile(
  contents: string,
  profilePath: typeof RunProfileSourcePathSchema.Type
) {
  return Effect.try({
    try: () => {
      const input: unknown = JSON.parse(contents);
      try {
        return decodeRunProfileJson(input);
      } catch (cause) {
        const browser =
          typeof input === "object" && input !== null && "browser" in input
            ? input.browser
            : undefined;
        const targetUrl =
          typeof browser === "object" &&
          browser !== null &&
          "targetUrl" in browser
            ? browser.targetUrl
            : undefined;
        if (typeof targetUrl === "string") {
          try {
            parseBrowserEvidenceTargetUrl(targetUrl);
          } catch {
            throw makeRuntimeError({
              code: "AcceptedInputRejected",
              message:
                "Accepted input profile.browser.targetUrl failed the credential-free-url safety policy.",
              recoverable: false,
            });
          }
        }
        throw makeRuntimeError({
          cause,
          code: "RunProfileInvalid",
          message: "The selected run profile is not valid.",
          recoverable: false,
        });
      }
    },
    catch: (cause) =>
      cause instanceof GaiaRuntimeError
        ? cause
        : makeRuntimeError({
            cause,
            code: "RunProfileInvalid",
            message: "The selected run profile is not valid.",
            recoverable: false,
          }),
  });
}
