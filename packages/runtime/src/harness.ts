import { RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";

export const HarnessNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("HarnessName"),
);

export type HarnessName = typeof HarnessNameSchema.Type;

export const parseHarnessName = Schema.decodeUnknownSync(HarnessNameSchema);

export const defaultHarnessName = parseHarnessName("fake");
export const processHarnessName = parseHarnessName("process");

const processHarnessMaxBufferBytes = 10 * 1024 * 1024;

export const ProcessHarnessCommandSchema = Schema.NonEmptyString.pipe(
  Schema.brand("ProcessHarnessCommand"),
);

export type ProcessHarnessCommand = typeof ProcessHarnessCommandSchema.Type;

export class ProcessHarnessConfig extends Schema.Class<ProcessHarnessConfig>(
  "ProcessHarnessConfig",
)({
  args: Schema.Array(Schema.String),
  command: ProcessHarnessCommandSchema,
}) {}

export const parseProcessHarnessConfig =
  Schema.decodeUnknownSync(ProcessHarnessConfig);

export function makeProcessHarnessConfig(
  command: string,
  args: ReadonlyArray<string> = [],
): ProcessHarnessConfig {
  return parseProcessHarnessConfig({ args, command });
}

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
const execFileAsync = promisify(execFile);

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

function processHarness(config: ProcessHarnessConfig): GaiaHarness {
  return {
    name: processHarnessName,
    run: (request) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          request.workerLogPath,
          `Process harness started: ${config.command}\n`,
          { flag: "a" },
        );

        const execution = yield* runProcessHarnessCommand(config, request);
        yield* fs.writeFileString(
          request.workerLogPath,
          formatProcessOutput(execution),
          { flag: "a" },
        );

        const result = HarnessRunResult.make({
          harnessName: request.harnessName,
          outputArtifacts: ["workspace/output.txt"],
          resultPath: "worker-result.json",
          runId: request.runId,
          status: "completed",
          summary: `Process harness completed "${request.specTitle}".`,
        });

        yield* writeHarnessRunResult(request, result);
        yield* fs.writeFileString(
          request.workerLogPath,
          "Process harness completed.\n",
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
}

export const availableHarnessNames: ReadonlyArray<HarnessName> = [
  fakeHarness.name,
  processHarnessName,
];

export function runHarness(
  request: HarnessRunRequest,
  options: HarnessRunOptions = {},
): Effect.Effect<HarnessRunResult, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const harness = yield* selectHarness(request.harnessName, options);
    return yield* harness.run(request);
  });
}

export type HarnessRunOptions = {
  readonly processHarness?: ProcessHarnessConfig;
};

function selectHarness(
  harnessName: HarnessName,
  options: HarnessRunOptions,
): Effect.Effect<GaiaHarness, GaiaRuntimeError> {
  if (harnessName === fakeHarness.name) {
    return Effect.succeed(fakeHarness);
  }

  if (harnessName === processHarnessName) {
    if (options.processHarness === undefined) {
      return Effect.fail(
        makeRuntimeError({
          code: "ProcessHarnessCommandMissing",
          message:
            "Harness 'process' requires a process harness command.",
          recoverable: false,
        }),
      );
    }

    return Effect.succeed(processHarness(options.processHarness));
  }

  return Effect.fail(
    makeRuntimeError({
      code: "UnknownHarness",
      message: `Harness '${harnessName}' is not registered. Available harnesses: ${availableHarnessNames.join(", ")}.`,
      recoverable: false,
    }),
  );
}

type ProcessExecutionResult = {
  readonly stderr: string;
  readonly stdout: string;
};

function runProcessHarnessCommand(
  config: ProcessHarnessConfig,
  request: HarnessRunRequest,
) {
  return Effect.tryPromise({
    try: () =>
      execFileAsync(config.command, [...config.args], {
        cwd: request.workspacePath,
        env: {
          ...process.env,
          GAIA_RUN_ID: request.runId,
          GAIA_SPEC_BODY: request.specBody,
          GAIA_SPEC_TITLE: request.specTitle,
          GAIA_WORKER_LOG_PATH: request.workerLogPath,
          GAIA_WORKER_RESULT_PATH: request.workerResultPath,
          GAIA_WORKSPACE_OUTPUT_PATH: request.workspaceOutputPath,
          GAIA_WORKSPACE_PATH: request.workspacePath,
        },
        maxBuffer: processHarnessMaxBufferBytes,
      }),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "ProcessHarnessCommandFailed",
        message: `Process harness command '${config.command}' failed.`,
        recoverable: true,
      }),
  }).pipe(
    Effect.map((result) => ({
      stderr: String(result.stderr),
      stdout: String(result.stdout),
    })),
  );
}

function formatProcessOutput(execution: ProcessExecutionResult) {
  const lines: Array<string> = [];

  if (execution.stdout.length > 0) {
    lines.push("stdout:", execution.stdout.trimEnd());
  }

  if (execution.stderr.length > 0) {
    lines.push("stderr:", execution.stderr.trimEnd());
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function writeHarnessRunResult(
  request: HarnessRunRequest,
  result: HarnessRunResult,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      request.workerResultPath,
      `${JSON.stringify(encodeHarnessRunResult(result), null, 2)}\n`,
    );
  });
}
