import { RunIdSchema, type RunId } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import {
  BrowserEvidenceTargetUrlSchema,
  type BrowserEvidenceTargetUrl,
} from "./browser-evidence.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { runRelative, type RunPaths } from "./paths.js";

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
  deploymentPath: Schema.NonEmptyString,
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

/** Create the empty preview deployment artifact written at run start. */
export function emptyPreviewDeployment() {
  return PreviewDeployment.make({
    notes: ["Preview deployment is not created for this run yet."],
    status: "not-created",
    version: 1,
  });
}

/** Create an available preview deployment artifact from a parsed URL. */
export function availablePreviewDeployment(input: {
  readonly url: BrowserEvidenceTargetUrl;
}) {
  return PreviewDeployment.make({
    notes: [`Preview deployment available at ${input.url}.`],
    status: "available",
    url: input.url,
    version: 1,
  });
}

/** Persist the empty preview deployment artifact for a new run. */
export function writeEmptyPreviewDeployment(input: {
  readonly paths: RunPaths;
}): Effect.Effect<PreviewDeployment, GaiaRuntimeError, FileSystem.FileSystem> {
  return writePreviewDeployment({
    deployment: emptyPreviewDeployment(),
    paths: input.paths,
  });
}

/** Persist a preview deployment artifact. */
export function writePreviewDeployment(input: {
  readonly deployment: PreviewDeployment;
  readonly paths: RunPaths;
}): Effect.Effect<PreviewDeployment, GaiaRuntimeError, FileSystem.FileSystem> {
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
export function previewDeploymentRecord(input: {
  readonly deployment: PreviewDeployment;
  readonly paths: RunPaths;
  readonly runId: RunId;
}) {
  return PreviewDeploymentRecord.make({
    deploymentPath: runRelative(input.paths, input.paths.previewDeployment),
    runId: input.runId,
    status: input.deployment.status,
    ...(input.deployment.url === undefined
      ? {}
      : { url: input.deployment.url }),
  });
}
