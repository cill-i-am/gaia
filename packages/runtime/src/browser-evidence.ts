import { RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import {
  chromium,
  type ConsoleMessage as PlaywrightConsoleMessage,
} from "playwright";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import {
  runRelative,
  parseRunRelativeArtifactPath,
  RunPathsSchema,
  RunRelativeArtifactPathSchema,
} from "./paths.js";

export const BrowserEvidenceStatusSchema = Schema.Literals([
  "not-collected",
  "collected",
  "failed",
] as const);

export type BrowserEvidenceStatus = typeof BrowserEvidenceStatusSchema.Type;

export const BrowserConsoleLevelSchema = Schema.Literals([
  "debug",
  "error",
  "info",
  "warn",
] as const);

export const BrowserEvidenceTargetUrlSchema = Schema.NonEmptyString.pipe(
  Schema.refine(isBrowserEvidenceTargetUrl, {
    identifier: "BrowserEvidenceTargetUrl",
    message: "Expected an HTTP or HTTPS URL.",
  }),
  Schema.brand("BrowserEvidenceTargetUrl")
);

export type BrowserEvidenceTargetUrl =
  typeof BrowserEvidenceTargetUrlSchema.Type;

export const parseBrowserEvidenceTargetUrl = Schema.decodeUnknownSync(
  BrowserEvidenceTargetUrlSchema
);

export class BrowserConsoleMessage extends Schema.Class<BrowserConsoleMessage>(
  "BrowserConsoleMessage"
)({
  level: BrowserConsoleLevelSchema,
  message: Schema.NonEmptyString,
  sourceUrl: Schema.optionalKey(Schema.NonEmptyString),
}) {}

export class BrowserScreenshotEvidence extends Schema.Class<BrowserScreenshotEvidence>(
  "BrowserScreenshotEvidence"
)({
  description: Schema.NonEmptyString,
  path: RunRelativeArtifactPathSchema,
}) {
  static override make(input: unknown): BrowserScreenshotEvidence {
    return decodeBrowserScreenshotEvidence(input);
  }
}

const decodeBrowserScreenshotEvidence = Schema.decodeUnknownSync(
  BrowserScreenshotEvidence
);

export class BrowserPageEvidence extends Schema.Class<BrowserPageEvidence>(
  "BrowserPageEvidence"
)({
  consoleMessages: Schema.Array(BrowserConsoleMessage),
  screenshots: Schema.Array(BrowserScreenshotEvidence),
  url: BrowserEvidenceTargetUrlSchema,
}) {
  static override make(input: unknown): BrowserPageEvidence {
    return decodeBrowserPageEvidence(input);
  }
}

const decodeBrowserPageEvidence = Schema.decodeUnknownSync(BrowserPageEvidence);

export class BrowserEvidence extends Schema.Class<BrowserEvidence>(
  "BrowserEvidence"
)({
  notes: Schema.Array(Schema.NonEmptyString),
  pages: Schema.Array(BrowserPageEvidence),
  status: BrowserEvidenceStatusSchema,
  version: Schema.Literal(1),
}) {}

export class BrowserEvidenceRecord extends Schema.Class<BrowserEvidenceRecord>(
  "BrowserEvidenceRecord"
)({
  evidencePath: RunRelativeArtifactPathSchema,
  pages: Schema.Array(BrowserPageEvidence),
  runId: RunIdSchema,
  status: BrowserEvidenceStatusSchema,
  targetUrl: BrowserEvidenceTargetUrlSchema,
}) {}

const BrowserEvidenceCollectorInputSchema = Schema.Struct({
  paths: RunPathsSchema,
  targetUrl: BrowserEvidenceTargetUrlSchema,
});

export type BrowserEvidenceCollectorInput =
  typeof BrowserEvidenceCollectorInputSchema.Type;

export type BrowserEvidenceCollector = (
  input: BrowserEvidenceCollectorInput
) => Effect.Effect<
  BrowserEvidence,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
>;

const BrowserEvidenceJson = Schema.toCodecJson(BrowserEvidence);
const encodeBrowserEvidenceJson = Schema.encodeSync(BrowserEvidenceJson);
export const parseBrowserEvidenceJson =
  Schema.decodeUnknownSync(BrowserEvidenceJson);

const browserNavigationTimeoutMs = 30_000;
const browserNetworkIdleTimeoutMs = 2_000;

const WriteEmptyBrowserEvidenceInputSchema = Schema.Struct({
  paths: RunPathsSchema,
});

const WriteBrowserEvidenceInputSchema = Schema.Struct({
  evidence: BrowserEvidence,
  paths: RunPathsSchema,
});

const FailedBrowserEvidenceInputSchema = Schema.Struct({
  message: Schema.String,
  targetUrl: BrowserEvidenceTargetUrlSchema,
});

const BrowserEvidenceRecordInputSchema = Schema.Struct({
  evidence: BrowserEvidence,
  paths: RunPathsSchema,
  runId: RunIdSchema,
  targetUrl: BrowserEvidenceTargetUrlSchema,
});

export function writeEmptyBrowserEvidence(
  input: typeof WriteEmptyBrowserEvidenceInputSchema.Type
): Effect.Effect<BrowserEvidence, GaiaRuntimeError, FileSystem.FileSystem> {
  return writeBrowserEvidence({
    evidence: BrowserEvidence.make({
      notes: ["Browser automation is not collected for this run yet."],
      pages: [],
      status: "not-collected",
      version: 1,
    }),
    paths: input.paths,
  });
}

export function writeBrowserEvidence(
  input: typeof WriteBrowserEvidenceInputSchema.Type
): Effect.Effect<BrowserEvidence, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      input.paths.browserEvidence,
      `${JSON.stringify(encodeBrowserEvidenceJson(input.evidence), null, 2)}\n`
    );

    return input.evidence;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "BrowserEvidenceWriteFailed",
          message: "Gaia could not write the browser evidence artifact.",
          recoverable: true,
        })
      )
    )
  );
}

export function failedBrowserEvidence(
  input: typeof FailedBrowserEvidenceInputSchema.Type
) {
  return BrowserEvidence.make({
    notes: [
      `Browser evidence capture failed for ${input.targetUrl}.`,
      input.message,
    ],
    pages: [],
    status: "failed",
    version: 1,
  });
}

export function browserEvidenceRecord(
  input: typeof BrowserEvidenceRecordInputSchema.Type
) {
  return BrowserEvidenceRecord.make({
    evidencePath: parseRunRelativeArtifactPath(
      runRelative(input.paths, input.paths.browserEvidence)
    ),
    pages: input.evidence.pages,
    runId: input.runId,
    status: input.evidence.status,
    targetUrl: input.targetUrl,
  });
}

export const playwrightBrowserEvidenceCollector: BrowserEvidenceCollector = (
  input
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const screenshotPath = path.join(
      input.paths.browserScreenshots,
      "page-1.png"
    );
    const consoleMessages: Array<BrowserConsoleMessage> = [];

    yield* fs
      .makeDirectory(input.paths.browserScreenshots, { recursive: true })
      .pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            makeRuntimeError({
              cause,
              code: "BrowserEvidenceScreenshotDirectoryFailed",
              message:
                "Gaia could not create the browser screenshot directory.",
              recoverable: true,
            })
          )
        )
      );

    const finalUrl = yield* Effect.tryPromise({
      try: async () => {
        const browser = await chromium.launch({ headless: true });

        try {
          const page = await browser.newPage();
          page.on("console", (message) => {
            const parsed = browserConsoleMessage(message);
            if (parsed !== undefined) {
              consoleMessages.push(parsed);
            }
          });

          await page.goto(input.targetUrl, {
            timeout: browserNavigationTimeoutMs,
            waitUntil: "domcontentloaded",
          });
          await page
            .waitForLoadState("networkidle", {
              timeout: browserNetworkIdleTimeoutMs,
            })
            .catch(() => undefined);
          await page.screenshot({ fullPage: true, path: screenshotPath });

          return parseBrowserEvidenceTargetUrl(page.url());
        } finally {
          await browser.close();
        }
      },
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "BrowserEvidenceCaptureFailed",
          message: `Gaia could not collect browser evidence for ${input.targetUrl}.`,
          recoverable: true,
        }),
    });

    return BrowserEvidence.make({
      notes: [`Browser evidence captured for ${input.targetUrl}.`],
      pages: [
        BrowserPageEvidence.make({
          consoleMessages,
          screenshots: [
            BrowserScreenshotEvidence.make({
              description: "Full page screenshot after initial page load.",
              path: runRelative(input.paths, screenshotPath),
            }),
          ],
          url: finalUrl,
        }),
      ],
      status: "collected",
      version: 1,
    });
  });

function browserConsoleMessage(
  message: PlaywrightConsoleMessage
): BrowserConsoleMessage | undefined {
  const text = message.text().trim();
  if (text.length === 0) {
    return undefined;
  }

  const sourceUrl = message.location().url;

  return BrowserConsoleMessage.make({
    level: browserConsoleLevel(message.type()),
    message: text,
    ...(sourceUrl.length === 0 ? {} : { sourceUrl }),
  });
}

function browserConsoleLevel(level: string) {
  switch (level) {
    case "debug":
      return "debug";
    case "error":
      return "error";
    case "warning":
      return "warn";
    case "info":
    case "log":
    default:
      return "info";
  }
}

function isBrowserEvidenceTargetUrl(value: string): value is string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
