import { RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { BrowserEvidenceTargetUrlSchema } from "./browser-evidence.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import {
  parseRunRelativeArtifactPath,
  runRelative,
  RunPathsSchema,
  RunRelativeArtifactPathSchema,
} from "./paths.js";

export const PreviewDeploymentStatusSchema = Schema.Literals([
  "not-created",
  "available",
  "failed",
] as const);

/** Status of the preview deployment artifact for a Gaia run. */
export type PreviewDeploymentStatus = typeof PreviewDeploymentStatusSchema.Type;

export class PreviewDeployment extends Schema.Class<PreviewDeployment>(
  "PreviewDeployment"
)({
  notes: Schema.Array(Schema.NonEmptyString),
  status: PreviewDeploymentStatusSchema,
  url: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
  version: Schema.Literal(1),
}) {}

export class PreviewDeploymentRecord extends Schema.Class<PreviewDeploymentRecord>(
  "PreviewDeploymentRecord"
)({
  deploymentPath: RunRelativeArtifactPathSchema,
  runId: RunIdSchema,
  status: PreviewDeploymentStatusSchema,
  url: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
}) {}

const PreviewDeploymentJson = Schema.toCodecJson(PreviewDeployment);
const encodePreviewDeploymentJson = Schema.encodeSync(PreviewDeploymentJson);

/** Parse a preview deployment artifact from decoded JSON. */
export const parsePreviewDeploymentJson = Schema.decodeUnknownSync(
  PreviewDeploymentJson
);

const AvailablePreviewDeploymentInputSchema = Schema.Struct({
  url: BrowserEvidenceTargetUrlSchema,
});

const WriteEmptyPreviewDeploymentInputSchema = Schema.Struct({
  paths: RunPathsSchema,
});

const WritePreviewDeploymentInputSchema = Schema.Struct({
  deployment: PreviewDeployment,
  paths: RunPathsSchema,
});

const PreviewDeploymentRecordInputSchema = Schema.Struct({
  deployment: PreviewDeployment,
  paths: RunPathsSchema,
  runId: RunIdSchema,
});

/** Create the empty preview deployment artifact written at run start. */
export function emptyPreviewDeployment() {
  return PreviewDeployment.make({
    notes: ["Preview deployment is not created for this run yet."],
    status: "not-created",
    version: 1,
  });
}

/** Create an available preview deployment artifact from a parsed URL. */
export function availablePreviewDeployment(
  input: typeof AvailablePreviewDeploymentInputSchema.Type
) {
  return PreviewDeployment.make({
    notes: [`Preview deployment available at ${input.url}.`],
    status: "available",
    url: input.url,
    version: 1,
  });
}

/** Persist the empty preview deployment artifact for a new run. */
export function writeEmptyPreviewDeployment(
  input: typeof WriteEmptyPreviewDeploymentInputSchema.Type
): Effect.Effect<PreviewDeployment, GaiaRuntimeError, FileSystem.FileSystem> {
  return writePreviewDeployment({
    deployment: emptyPreviewDeployment(),
    paths: input.paths,
  });
}

/** Persist a preview deployment artifact. */
export function writePreviewDeployment(
  input: typeof WritePreviewDeploymentInputSchema.Type
): Effect.Effect<PreviewDeployment, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* fs.writeFileString(
      input.paths.previewDeployment,
      `${JSON.stringify(encodePreviewDeploymentJson(input.deployment), null, 2)}\n`
    );

    return input.deployment;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "PreviewDeploymentWriteFailed",
          message: "Gaia could not write the preview deployment artifact.",
          recoverable: true,
        })
      )
    )
  );
}

/** Create the event payload model for a persisted preview deployment artifact. */
export function previewDeploymentRecord(
  input: typeof PreviewDeploymentRecordInputSchema.Type
) {
  return PreviewDeploymentRecord.make({
    deploymentPath: parseRunRelativeArtifactPath(
      runRelative(input.paths, input.paths.previewDeployment)
    ),
    runId: input.runId,
    status: input.deployment.status,
    ...(input.deployment.url === undefined
      ? {}
      : { url: input.deployment.url }),
  });
}
