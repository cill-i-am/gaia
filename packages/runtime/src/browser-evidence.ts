import { Effect, FileSystem, Schema } from "effect";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";

export const BrowserEvidenceStatusSchema = Schema.Literals([
  "not-collected",
  "collected",
] as const);

export const BrowserConsoleLevelSchema = Schema.Literals([
  "debug",
  "error",
  "info",
  "warn",
] as const);

export class BrowserConsoleMessage extends Schema.Class<BrowserConsoleMessage>(
  "BrowserConsoleMessage",
)({
  level: BrowserConsoleLevelSchema,
  message: Schema.NonEmptyString,
  sourceUrl: Schema.optionalKey(Schema.NonEmptyString),
}) {}

export class BrowserScreenshotEvidence extends Schema.Class<BrowserScreenshotEvidence>(
  "BrowserScreenshotEvidence",
)({
  description: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
}) {}

export class BrowserPageEvidence extends Schema.Class<BrowserPageEvidence>(
  "BrowserPageEvidence",
)({
  consoleMessages: Schema.Array(BrowserConsoleMessage),
  screenshots: Schema.Array(BrowserScreenshotEvidence),
  url: Schema.NonEmptyString,
}) {}

export class BrowserEvidence extends Schema.Class<BrowserEvidence>(
  "BrowserEvidence",
)({
  notes: Schema.Array(Schema.NonEmptyString),
  pages: Schema.Array(BrowserPageEvidence),
  status: BrowserEvidenceStatusSchema,
  version: Schema.Literal(1),
}) {}

const BrowserEvidenceJson = Schema.toCodecJson(BrowserEvidence);
const encodeBrowserEvidenceJson = Schema.encodeSync(BrowserEvidenceJson);
export const parseBrowserEvidenceJson =
  Schema.decodeUnknownSync(BrowserEvidenceJson);

export function writeEmptyBrowserEvidence(input: {
  readonly paths: RunPaths;
}): Effect.Effect<BrowserEvidence, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const evidence = BrowserEvidence.make({
      notes: [
        "Browser automation is not collected for this run yet.",
      ],
      pages: [],
      status: "not-collected",
      version: 1,
    });

    yield* fs.writeFileString(
      input.paths.browserEvidence,
      `${JSON.stringify(encodeBrowserEvidenceJson(evidence), null, 2)}\n`,
    );

    return evidence;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "BrowserEvidenceWriteFailed",
          message: "Gaia could not write the browser evidence artifact.",
          recoverable: true,
        }),
      ),
    ),
  );
}
