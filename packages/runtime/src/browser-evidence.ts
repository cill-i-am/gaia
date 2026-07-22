import { RunIdSchema, VerificationSourceKeySchema } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import {
  chromium,
  type ConsoleMessage as PlaywrightConsoleMessage,
} from "playwright";

import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
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
  Schema.refine(passesBrowserEvidenceTargetUrlChecks, {
    identifier: "BrowserEvidenceTargetUrl",
    message: "Expected a bounded credential-free HTTP or HTTPS URL.",
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
  sourceUrl: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
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

export class BrowserPageEvidenceV2 extends Schema.Class<BrowserPageEvidenceV2>(
  "BrowserPageEvidenceV2"
)({
  consoleMessages: Schema.Array(BrowserConsoleMessage),
  evidenceKind: Schema.Literal("page"),
  evidenceSelector: VerificationSourceKeySchema,
  screenshots: Schema.Array(BrowserScreenshotEvidence),
  url: BrowserEvidenceTargetUrlSchema,
}) {
  static override make(input: unknown): BrowserPageEvidenceV2 {
    return decodeBrowserPageEvidenceV2(input);
  }
}

const decodeBrowserPageEvidenceV2 = Schema.decodeUnknownSync(
  BrowserPageEvidenceV2
);

export const AnyBrowserPageEvidenceSchema = Schema.Union([
  BrowserPageEvidenceV2,
  BrowserPageEvidence,
]);

export class BrowserEvidence extends Schema.Class<BrowserEvidence>(
  "BrowserEvidence"
)({
  notes: Schema.Array(Schema.NonEmptyString),
  pages: Schema.Array(BrowserPageEvidence),
  status: BrowserEvidenceStatusSchema,
  version: Schema.Literal(1),
}) {}

export class BrowserEvidenceV2 extends Schema.Class<BrowserEvidenceV2>(
  "BrowserEvidenceV2"
)({
  notes: Schema.Array(Schema.NonEmptyString),
  pages: Schema.Array(BrowserPageEvidenceV2),
  status: BrowserEvidenceStatusSchema,
  version: Schema.Literal(2),
}) {}

export const AnyBrowserEvidenceSchema = Schema.Union([
  BrowserEvidence,
  BrowserEvidenceV2,
]);

export class BrowserEvidenceRecord extends Schema.Class<BrowserEvidenceRecord>(
  "BrowserEvidenceRecord"
)({
  evidencePath: RunRelativeArtifactPathSchema,
  pages: Schema.Array(AnyBrowserPageEvidenceSchema),
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
  typeof AnyBrowserEvidenceSchema.Type,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
>;

const BrowserEvidenceJson = Schema.toCodecJson(AnyBrowserEvidenceSchema);
const encodeBrowserEvidenceJson = Schema.encodeSync(BrowserEvidenceJson);
export const parseBrowserEvidenceJson =
  Schema.decodeUnknownSync(BrowserEvidenceJson);

const browserNavigationTimeoutMs = 30_000;
const browserNetworkIdleTimeoutMs = 2_000;

const WriteEmptyBrowserEvidenceInputSchema = Schema.Struct({
  paths: RunPathsSchema,
});

const WriteBrowserEvidenceInputSchema = Schema.Struct({
  evidence: AnyBrowserEvidenceSchema,
  paths: RunPathsSchema,
});

const FailedBrowserEvidenceInputSchema = Schema.Struct({
  message: Schema.String,
  targetUrl: BrowserEvidenceTargetUrlSchema,
});

const BrowserEvidenceRecordInputSchema = Schema.Struct({
  evidence: AnyBrowserEvidenceSchema,
  paths: RunPathsSchema,
  runId: RunIdSchema,
  targetUrl: BrowserEvidenceTargetUrlSchema,
});

export function writeEmptyBrowserEvidence(
  input: typeof WriteEmptyBrowserEvidenceInputSchema.Type
): Effect.Effect<
  typeof AnyBrowserEvidenceSchema.Type,
  GaiaRuntimeError,
  FileSystem.FileSystem
> {
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
): Effect.Effect<
  typeof AnyBrowserEvidenceSchema.Type,
  GaiaRuntimeError,
  FileSystem.FileSystem
> {
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
    let consoleSourceError: GaiaRuntimeError | undefined;

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

    const capture = yield* Effect.tryPromise({
      try: async () => {
        const browser = await chromium.launch({ headless: true });

        try {
          const page = await browser.newPage();
          page.on("console", (message) => {
            try {
              const parsed = browserConsoleMessage(message);
              if (parsed !== undefined) {
                consoleMessages.push(parsed);
              }
            } catch (cause) {
              consoleSourceError =
                cause instanceof GaiaRuntimeError
                  ? cause
                  : browserConsoleSourceUrlInvalidError();
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
          if (consoleSourceError !== undefined) {
            return Promise.reject(consoleSourceError);
          }
          const screenshotBytes = await page.screenshot({ fullPage: true });
          if (consoleSourceError !== undefined) {
            return Promise.reject(consoleSourceError);
          }

          return {
            finalUrl: parseBrowserEvidenceFinalUrl(page.url()),
            screenshotBytes,
          };
        } finally {
          await browser.close();
        }
      },
      catch: (cause) =>
        cause instanceof GaiaRuntimeError
          ? cause
          : makeRuntimeError({
              cause,
              code: "BrowserEvidenceCaptureFailed",
              message: `Gaia could not collect browser evidence for ${input.targetUrl}.`,
              recoverable: true,
            }),
    });

    yield* fs.writeFile(screenshotPath, capture.screenshotBytes).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "BrowserEvidenceCaptureFailed",
            message: `Gaia could not collect browser evidence for ${input.targetUrl}.`,
            recoverable: true,
          })
        )
      )
    );

    return BrowserEvidenceV2.make({
      notes: [`Browser evidence captured for ${input.targetUrl}.`],
      pages: [
        BrowserPageEvidenceV2.make({
          consoleMessages,
          evidenceKind: "page",
          evidenceSelector: "page-1",
          screenshots: [
            BrowserScreenshotEvidence.make({
              description: "Full page screenshot after initial page load.",
              path: runRelative(input.paths, screenshotPath),
            }),
          ],
          url: capture.finalUrl,
        }),
      ],
      status: "collected",
      version: 2,
    });
  });

function browserConsoleMessage(
  message: PlaywrightConsoleMessage
): BrowserConsoleMessage | undefined {
  const text = message.text().trim();
  if (text.length === 0) {
    return undefined;
  }

  const sourceUrl = parseBrowserConsoleSourceUrl(message.location().url);

  return BrowserConsoleMessage.make({
    level: browserConsoleLevel(message.type()),
    message: text,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  });
}

function browserConsoleSourceUrlInvalidError() {
  return makeRuntimeError({
    code: "BrowserConsoleSourceUrlInvalid",
    message:
      "A browser console message reported an invalid or credential-bearing source URL.",
    recoverable: false,
  });
}

export function parseBrowserConsoleSourceUrl(input: unknown) {
  if (input === "") return undefined;
  try {
    return parseBrowserEvidenceTargetUrl(input);
  } catch {
    throw browserConsoleSourceUrlInvalidError();
  }
}

function parseBrowserEvidenceFinalUrl(input: unknown) {
  try {
    return parseBrowserEvidenceTargetUrl(input);
  } catch {
    throw makeRuntimeError({
      code: "BrowserEvidenceFinalUrlInvalid",
      message:
        "The browser reported an invalid or credential-bearing final URL.",
      recoverable: false,
    });
  }
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

const browserUrlMaximumBytes = 16_384;
const browserUrlTextEncoder = new TextEncoder();
const credentialUrlNames = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "authorizationcode",
  "authtoken",
  "awsaccesskeyid",
  "bearer",
  "clientsecret",
  "code",
  "credential",
  "credentials",
  "googleaccessid",
  "oauth",
  "oauthcode",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "securitytoken",
  "sig",
  "signature",
  "signed",
  "token",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
]);

function normalizeUrlSecurityText(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function matchesCredentialUrlText(text: string) {
  const normalized = normalizeUrlSecurityText(text);
  return (
    credentialUrlNames.has(normalized) ||
    /^(?:xamz|xgoog)(?:credential|securitytoken|signature|signedheaders)$/u.test(
      normalized
    )
  );
}

function decodeUrlComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function containsCredentialUrlText(value: string) {
  const decoded = decodeUrlComponent(value);
  if (decoded === undefined) return true;
  return decoded
    .split(/[^\p{L}\p{N}]+/gu)
    .some((part) => part.length > 0 && matchesCredentialUrlText(part));
}

function hasCredentialUrlMaterial(url: URL) {
  if (
    [...url.searchParams.entries()].some(
      ([key, value]) =>
        matchesCredentialUrlText(key) ||
        (/^https?:\/\//iu.test(value) && containsCredentialUrlText(value))
    )
  )
    return true;

  if (
    url.pathname
      .split("/")
      .some(
        (segment) => segment.length > 0 && containsCredentialUrlText(segment)
      )
  )
    return true;

  const fragment = url.hash.slice(1);
  return fragment.length > 0 && containsCredentialUrlText(fragment);
}

function passesBrowserEvidenceTargetUrlChecks(text: string): text is string {
  if (
    !text.isWellFormed() ||
    browserUrlTextEncoder.encode(text).byteLength > browserUrlMaximumBytes
  )
    return false;
  try {
    const url = new URL(text);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      !hasCredentialUrlMaterial(url)
    );
  } catch {
    return false;
  }
}
