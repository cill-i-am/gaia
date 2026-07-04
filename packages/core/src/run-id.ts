import * as Schema from "effect/Schema";

const runIdPattern = /^run-[A-Za-z0-9_-]{10}$/u;

/** A parsed Gaia run identifier, formatted as `run-<10 nanoid chars>`. */
export const RunIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(runIdPattern, {
      identifier: "RunId",
      message: "Run id must look like run-<10 url-safe chars>.",
    }),
  ),
  Schema.brand("RunId"),
);

/** A parsed Gaia run identifier. */
export type RunId = typeof RunIdSchema.Type;

/** Parse untrusted input into a `RunId`. */
export const parseRunId = Schema.decodeUnknownSync(RunIdSchema);
