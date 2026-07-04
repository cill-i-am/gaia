import * as Schema from "effect/Schema";

/** Expected runtime failure raised by Gaia filesystem/workflow adapters. */
export class GaiaRuntimeError extends Schema.TaggedErrorClass<GaiaRuntimeError>()(
  "GaiaRuntimeError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
    recoverable: Schema.Boolean,
  },
) {}

/** Build a runtime error with a stable code and safe message. */
export function makeRuntimeError(input: {
  readonly cause?: unknown;
  readonly code: string;
  readonly message: string;
  readonly recoverable?: boolean;
}) {
  return GaiaRuntimeError.make({
    cause: input.cause,
    code: input.code,
    message: input.message,
    recoverable: input.recoverable ?? false,
  });
}
