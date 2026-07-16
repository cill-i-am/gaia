import * as Schema from "effect/Schema";

const LocalGaiaServerUrlBaseSchema = Schema.NonEmptyString;

function isLocalGaiaServerUrl(input: typeof LocalGaiaServerUrlBaseSchema.Type) {
  if (/\s|\\|\?|#/u.test(input)) {
    return false;
  }

  if (input.startsWith("/")) {
    return !input.startsWith("//");
  }

  if (!/^https?:\/\/[^/]+/iu.test(input)) {
    return false;
  }

  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A Gaia server base URL that preserves its exact HTTP(S) or same-origin path
 * representation for JSON and protocol use.
 */
export const LocalGaiaServerUrlSchema = LocalGaiaServerUrlBaseSchema.pipe(
  Schema.check(
    Schema.makeFilter(isLocalGaiaServerUrl, {
      identifier: "LocalGaiaServerUrl",
      message:
        "Local Gaia server URL must be an HTTP(S) URL or root-relative path without whitespace, backslashes, a query, or a fragment.",
    })
  ),
  Schema.brand("LocalGaiaServerUrl")
);

/** A parsed Gaia server base URL. */
export type LocalGaiaServerUrl = typeof LocalGaiaServerUrlSchema.Type;

/** Parse untrusted input into a `LocalGaiaServerUrl`. */
export const parseLocalGaiaServerUrl = Schema.decodeUnknownSync(
  LocalGaiaServerUrlSchema
);
