import { RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { makeRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";

export class VerificationResult extends Schema.Class<VerificationResult>(
  "VerificationResult"
)({
  checkedArtifacts: Schema.Array(Schema.NonEmptyString),
  runId: RunIdSchema,
  status: Schema.Literal("passed"),
}) {}

const VerificationResultJson = Schema.toCodecJson(VerificationResult);
export const encodeVerificationResultJson = Schema.encodeSync(
  VerificationResultJson
);
export const parseVerificationResultJson = Schema.decodeUnknownSync(
  VerificationResultJson
);

export function verifyHarnessOutput(
  runId: typeof RunIdSchema.Type,
  paths: RunPaths,
  options: { readonly requireLegacyWorkspaceMarker?: boolean } = {}
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      paths.verificationLog,
      "Verifying harness output.\n",
      { flag: "a" }
    );

    const requireLegacyWorkspaceMarker =
      options.requireLegacyWorkspaceMarker ?? true;
    if (requireLegacyWorkspaceMarker) {
      const exists = yield* fs.exists(paths.workspaceOutput);
      if (!exists) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "VerificationArtifactMissing",
            message: "Expected workspace/output.txt to exist.",
            recoverable: true,
          })
        );
      }

      const output = yield* fs.readFileString(paths.workspaceOutput);
      if (!output.includes(runId)) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "VerificationMarkerMissing",
            message: "Expected workspace/output.txt to include the run id.",
            recoverable: true,
          })
        );
      }
    }

    const result = VerificationResult.make({
      checkedArtifacts: requireLegacyWorkspaceMarker
        ? ["workspace/output.txt", "worker-result.json"]
        : ["worker-result.json"],
      runId,
      status: "passed",
    });

    yield* fs.writeFileString(
      paths.verificationResult,
      `${JSON.stringify(encodeVerificationResultJson(result), null, 2)}\n`
    );
    yield* fs.writeFileString(paths.verificationLog, "Verification passed.\n", {
      flag: "a",
    });

    return result;
  });
}
