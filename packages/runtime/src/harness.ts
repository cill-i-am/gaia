import { RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";

export const HarnessNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("HarnessName"),
);

export type HarnessName = typeof HarnessNameSchema.Type;

export const parseHarnessName = Schema.decodeUnknownSync(HarnessNameSchema);

export const defaultHarnessName = parseHarnessName("fake");

export class HarnessRunRequest extends Schema.Class<HarnessRunRequest>(
  "HarnessRunRequest",
)({
  harnessName: HarnessNameSchema,
  runId: RunIdSchema,
  specBody: Schema.NonEmptyString,
  specTitle: Schema.NonEmptyString,
  workerLogPath: Schema.NonEmptyString,
  workerResultPath: Schema.NonEmptyString,
  workspaceOutputPath: Schema.NonEmptyString,
  workspacePath: Schema.NonEmptyString,
}) {}

export class HarnessRunResult extends Schema.Class<HarnessRunResult>(
  "HarnessRunResult",
)({
  harnessName: HarnessNameSchema,
  outputArtifacts: Schema.Array(Schema.NonEmptyString),
  resultPath: Schema.NonEmptyString,
  runId: RunIdSchema,
  status: Schema.Literal("completed"),
  summary: Schema.NonEmptyString,
}) {}

export type GaiaHarness = {
  readonly name: HarnessName;
  readonly run: (
    request: HarnessRunRequest,
  ) => Effect.Effect<
    HarnessRunResult,
    GaiaRuntimeError,
    FileSystem.FileSystem
  >;
};

const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const encodeHarnessRunResult = Schema.encodeSync(HarnessRunResultJson);

const fakeHarness: GaiaHarness = {
  name: defaultHarnessName,
  run: (request) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const output = `Gaia fake harness completed ${request.runId}.\n`;
      const result = HarnessRunResult.make({
        harnessName: request.harnessName,
        outputArtifacts: ["workspace/output.txt"],
        resultPath: "worker-result.json",
        runId: request.runId,
        status: "completed",
        summary: `Fake harness completed "${request.specTitle}".`,
      });

      yield* fs.writeFileString(
        request.workerLogPath,
        "Fake harness started.\n",
        { flag: "a" },
      );
      yield* fs.writeFileString(request.workspaceOutputPath, output);
      yield* fs.writeFileString(
        request.workerResultPath,
        `${JSON.stringify(encodeHarnessRunResult(result), null, 2)}\n`,
      );
      yield* fs.writeFileString(
        request.workerLogPath,
        "Fake harness completed.\n",
        { flag: "a" },
      );

      return result;
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "HarnessArtifactWriteFailed",
            message: `Harness '${request.harnessName}' could not write its artifacts.`,
            recoverable: true,
          }),
        ),
      ),
    ),
};

export const availableHarnessNames: ReadonlyArray<HarnessName> = [
  fakeHarness.name,
];

export function runHarness(
  request: HarnessRunRequest,
): Effect.Effect<HarnessRunResult, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const harness = yield* selectHarness(request.harnessName);
    return yield* harness.run(request);
  });
}

function selectHarness(
  harnessName: HarnessName,
): Effect.Effect<GaiaHarness, GaiaRuntimeError> {
  if (harnessName === fakeHarness.name) {
    return Effect.succeed(fakeHarness);
  }

  return Effect.fail(
    makeRuntimeError({
      code: "UnknownHarness",
      message: `Harness '${harnessName}' is not registered. Available harnesses: ${availableHarnessNames.join(", ")}.`,
      recoverable: false,
    }),
  );
}
