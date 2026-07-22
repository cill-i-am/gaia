import { createHash } from "node:crypto";

import {
  AcceptedRunInputCheckpointRefV1,
  AcceptedRunInputCheckpointV1,
  makeAcceptedRunInputCheckpointRefV1,
  parseAcceptedRunInputCheckpoint,
  parseAcceptedRunInputCheckpointRef,
  type AcceptedRunInputCheckpointPayloadV1,
} from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";

import { BrowserEvidenceTargetUrlSchema } from "./browser-evidence.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import {
  CodexBatchSemanticConfigV1,
  PreparedSkillInstallerV1,
  ProcessHarnessSemanticConfigV1,
  assertPreparedRunSemanticsV1,
} from "./model-invocation.js";
import type { RunPaths } from "./paths.js";
import { BrowserEvidenceRequirementSchema, RunProfile } from "./run-profile.js";
import { SkillManifest } from "./skill-manifest.js";
import { WorkspaceSourceSchema } from "./workspace.js";

const encodeCheckpoint = Schema.encodeSync(AcceptedRunInputCheckpointV1);
const textEncoder = new TextEncoder();
const strict = { parseOptions: { onExcessProperty: "error" as const } };

export class AcceptedRunInputSemanticsV1 extends Schema.Class<AcceptedRunInputSemanticsV1>(
  "AcceptedRunInputSemanticsV1"
)(
  {
    browserEvidenceRequirement: BrowserEvidenceRequirementSchema,
    browserEvidenceTargetUrl: Schema.optionalKey(
      BrowserEvidenceTargetUrlSchema
    ),
    codexHarness: Schema.optionalKey(CodexBatchSemanticConfigV1),
    delivery: Schema.optionalKey(Schema.Json),
    deliveryFeedbackTrustPolicy: Schema.optionalKey(Schema.Json),
    execution: Schema.optionalKey(Schema.Json),
    installer: PreparedSkillInstallerV1,
    processHarness: Schema.optionalKey(ProcessHarnessSemanticConfigV1),
    profile: RunProfile,
    skills: SkillManifest,
    source: Schema.Literal("server"),
    workflow: Schema.optionalKey(Schema.Json),
    workItem: Schema.optionalKey(Schema.Json),
    workspaceSource: WorkspaceSourceSchema,
  },
  strict
) {}

const parseAcceptedSemantics = Schema.decodeUnknownSync(
  AcceptedRunInputSemanticsV1
);

export function decodeAcceptedRunInputSemantics(
  checkpointInput: AcceptedRunInputCheckpointV1
) {
  const checkpoint = parseAcceptedRunInputCheckpoint(checkpointInput);
  const semantics = parseAcceptedSemantics(
    checkpoint.payload.acceptedSemantics
  );
  assertPreparedRunSemanticsV1({
    browserEvidenceRequirement: semantics.browserEvidenceRequirement,
    ...(semantics.browserEvidenceTargetUrl === undefined
      ? {}
      : {
          explicitBrowserEvidenceTargetUrl: semantics.browserEvidenceTargetUrl,
        }),
    ...(semantics.codexHarness === undefined
      ? {}
      : { codexHarness: semantics.codexHarness }),
    installer: semantics.installer,
    ...(semantics.processHarness === undefined
      ? {}
      : { processHarness: semantics.processHarness }),
    runProfile: semantics.profile,
    skillManifest: semantics.skills,
    workspaceSource: semantics.workspaceSource,
  });
  const factoryFields = [
    semantics.delivery,
    semantics.execution,
    semantics.workflow,
    semantics.workItem,
  ];
  const hasEveryFactoryField = factoryFields.every(
    (value) => value !== undefined
  );
  const hasAnyFactoryField = factoryFields.some((value) => value !== undefined);
  if (
    (checkpoint.payload.acceptanceKind === "factory" &&
      !hasEveryFactoryField) ||
    (checkpoint.payload.acceptanceKind === "server" && hasAnyFactoryField)
  )
    throw checkpointError(
      "AcceptedRunInputCheckpointKindMismatch",
      "The accepted input checkpoint kind does not match its semantic payload."
    );
  return semantics;
}

function checkpointError(code: string, message: string, cause?: unknown) {
  return makeRuntimeError({ cause, code, message, recoverable: false });
}

export function encodeAcceptedRunInputCheckpointBody(
  checkpointInput: AcceptedRunInputCheckpointV1
) {
  const checkpoint = parseAcceptedRunInputCheckpoint(checkpointInput);
  const body = `${JSON.stringify(encodeCheckpoint(checkpoint))}\n`;
  const bytes = textEncoder.encode(body);
  if (bytes.byteLength > 131_072)
    throw checkpointError(
      "AcceptedRunInputCheckpointTooLarge",
      "The accepted input checkpoint exceeds its fixed body bound."
    );
  return { body, bytes };
}

export function commitAcceptedRunInputCheckpointNoReplace(
  paths: RunPaths,
  checkpointInput: AcceptedRunInputCheckpointV1
): Effect.Effect<
  AcceptedRunInputCheckpointRefV1,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkpoint = parseAcceptedRunInputCheckpoint(checkpointInput);
      const { bytes } = encodeAcceptedRunInputCheckpointBody(checkpoint);
      const stagingDirectory = yield* fs
        .makeTempDirectoryScoped({
          directory: paths.root,
          prefix: ".accepted-run-input-staging-",
        })
        .pipe(
          Effect.mapError((cause) =>
            checkpointError(
              "AcceptedRunInputCheckpointStageFailed",
              "The accepted input checkpoint staging directory could not be created.",
              cause
            )
          )
        );
      const staged = path.join(stagingDirectory, "checkpoint.json");
      const handle = yield* fs
        .open(staged, { flag: "wx", mode: 0o600 })
        .pipe(
          Effect.mapError((cause) =>
            checkpointError(
              "AcceptedRunInputCheckpointStageFailed",
              "The accepted input checkpoint staging file could not be opened.",
              cause
            )
          )
        );
      yield* handle.writeAll(bytes).pipe(
        Effect.andThen(handle.sync),
        Effect.mapError((cause) =>
          checkpointError(
            "AcceptedRunInputCheckpointStageFailed",
            "The accepted input checkpoint staging write could not be committed.",
            cause
          )
        )
      );
      yield* verifyCheckpointBody(
        yield* fs.readFileString(staged),
        checkpoint,
        undefined
      );
      yield* fs
        .link(staged, paths.acceptedRunInput)
        .pipe(
          Effect.mapError((cause) =>
            checkpointError(
              "AcceptedRunInputCheckpointConflict",
              "The accepted input checkpoint path is already occupied or could not be committed no-replace.",
              cause
            )
          )
        );
      const ref = yield* checkpointRefFromBody(checkpoint, bytes);
      yield* verifyFinalPath(paths, checkpoint, ref);
      return ref;
    })
  ).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        checkpointError(
          "AcceptedRunInputCheckpointStageFailed",
          "The accepted input checkpoint staging operation failed.",
          cause
        )
      )
    )
  );
}

export function loadAcceptedRunInputCheckpoint(
  paths: RunPaths,
  refInput: AcceptedRunInputCheckpointRefV1
): Effect.Effect<
  AcceptedRunInputCheckpointV1,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const ref = yield* Effect.try({
      try: () => parseAcceptedRunInputCheckpointRef(refInput),
      catch: (cause) =>
        checkpointError(
          "AcceptedRunInputCheckpointRefInvalid",
          "The accepted input checkpoint reference is invalid.",
          cause
        ),
    });
    return yield* verifyFinalPath(paths, undefined, ref);
  });
}

function checkpointRefFromBody(
  checkpoint: AcceptedRunInputCheckpointV1,
  bytes: Uint8Array
) {
  return Effect.try({
    try: () =>
      makeAcceptedRunInputCheckpointRefV1({
        bodyDigest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        checkpoint,
      }),
    catch: (cause) =>
      checkpointError(
        "AcceptedRunInputCheckpointRefInvalid",
        "The accepted input checkpoint reference could not be derived.",
        cause
      ),
  });
}

function verifyFinalPath(
  paths: RunPaths,
  expectedCheckpoint: AcceptedRunInputCheckpointV1 | undefined,
  ref: AcceptedRunInputCheckpointRefV1
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalRoot = yield* fs
      .realPath(paths.root)
      .pipe(
        Effect.mapError((cause) =>
          checkpointError(
            "AcceptedRunInputCheckpointPathMismatch",
            "The accepted run root could not be canonicalized.",
            cause
          )
        )
      );
    const lexical = path.join(canonicalRoot, "accepted-run-input.json");
    const real = yield* fs
      .realPath(paths.acceptedRunInput)
      .pipe(
        Effect.mapError((cause) =>
          checkpointError(
            "AcceptedRunInputCheckpointUnavailable",
            "The event-referenced accepted input checkpoint is unavailable.",
            cause
          )
        )
      );
    const info = yield* fs
      .stat(paths.acceptedRunInput)
      .pipe(
        Effect.mapError((cause) =>
          checkpointError(
            "AcceptedRunInputCheckpointUnavailable",
            "The event-referenced accepted input checkpoint is unavailable.",
            cause
          )
        )
      );
    if (real !== lexical || info.type !== "File")
      return yield* Effect.fail(
        checkpointError(
          "AcceptedRunInputCheckpointPathMismatch",
          "The event-referenced accepted input checkpoint path is not a canonical regular file."
        )
      );
    const body = yield* fs
      .readFileString(paths.acceptedRunInput)
      .pipe(
        Effect.mapError((cause) =>
          checkpointError(
            "AcceptedRunInputCheckpointUnreadable",
            "The event-referenced accepted input checkpoint is unreadable.",
            cause
          )
        )
      );
    return yield* verifyCheckpointBody(body, expectedCheckpoint, ref);
  });
}

function verifyCheckpointBody(
  body: string,
  expectedCheckpoint: AcceptedRunInputCheckpointV1 | undefined,
  expectedRef: AcceptedRunInputCheckpointRefV1 | undefined
) {
  return Effect.try({
    try: () => {
      const bytes = textEncoder.encode(body);
      if (!body.endsWith("\n") || body.slice(0, -1).includes("\n"))
        throw new Error("Checkpoint encoding is not canonical compact JSON.");
      const checkpoint = parseAcceptedRunInputCheckpoint(
        JSON.parse(body.slice(0, -1))
      );
      if (body !== encodeAcceptedRunInputCheckpointBody(checkpoint).body)
        throw new Error("Checkpoint encoding differs from Schema encoding.");
      if (
        expectedCheckpoint !== undefined &&
        (checkpoint.checkpointId !== expectedCheckpoint.checkpointId ||
          checkpoint.checkpointDigest !== expectedCheckpoint.checkpointDigest)
      )
        throw new Error("Checkpoint body identity differs from the writer.");
      if (
        expectedRef !== undefined &&
        (expectedRef.path !== "accepted-run-input.json" ||
          expectedRef.byteLength !== bytes.byteLength ||
          expectedRef.bodyDigest !==
            createHash("sha256").update(bytes).digest("hex") ||
          expectedRef.checkpointId !== checkpoint.checkpointId ||
          expectedRef.checkpointDigest !== checkpoint.checkpointDigest)
      )
        throw new Error("Checkpoint body differs from its event reference.");
      return checkpoint;
    },
    catch: (cause) =>
      cause instanceof Error && "_tag" in cause
        ? (cause as GaiaRuntimeError)
        : checkpointError(
            "AcceptedRunInputCheckpointCorrupt",
            "The event-referenced accepted input checkpoint failed strict verification.",
            cause
          ),
  });
}

export type AcceptedCheckpointPayload =
  typeof AcceptedRunInputCheckpointPayloadV1.Type;
