import { RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";
import type { PlatformError } from "effect/PlatformError";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";

export const HarnessNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("HarnessName"),
);

export type HarnessName = typeof HarnessNameSchema.Type;

export const parseHarnessName = Schema.decodeUnknownSync(HarnessNameSchema);

export const defaultHarnessName = parseHarnessName("fake");
export const processHarnessName = parseHarnessName("process");

const processHarnessMaxBufferBytes = 10 * 1024 * 1024;
const harnessContractVersion = "1";

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
  changedWorkspacePaths: Schema.Array(Schema.NonEmptyString),
  exitCode: Schema.Number.pipe(
    Schema.check(Schema.isInt({ identifier: "ProcessExitCode" })),
  ),
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
    FileSystem.FileSystem | Path.Path
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

      yield* fs.writeFileString(
        request.workerLogPath,
        "Fake harness started.\n",
        { flag: "a" },
      );
      yield* fs.writeFileString(request.workspaceOutputPath, output);
      const result = HarnessRunResult.make({
        changedWorkspacePaths: ["output.txt"],
        exitCode: 0,
        harnessName: request.harnessName,
        outputArtifacts: ["workspace/output.txt"],
        resultPath: "worker-result.json",
        runId: request.runId,
        status: "completed",
        summary: `Fake harness completed "${request.specTitle}".`,
      });
      yield* requireDeclaredOutputArtifacts(request, result);
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

        const beforeWorkspace = yield* snapshotWorkspace(request.workspacePath);
        const execution = yield* runProcessHarnessCommand(config, request);
        const afterWorkspace = yield* snapshotWorkspace(request.workspacePath);
        const changedWorkspacePaths = changedPaths(
          beforeWorkspace,
          afterWorkspace,
        );
        yield* fs.writeFileString(
          request.workerLogPath,
          formatProcessOutput(execution),
          { flag: "a" },
        );

        const result = HarnessRunResult.make({
          changedWorkspacePaths,
          exitCode: execution.exitCode,
          harnessName: request.harnessName,
          outputArtifacts: ["workspace/output.txt"],
          resultPath: "worker-result.json",
          runId: request.runId,
          status: "completed",
          summary: `Process harness completed "${request.specTitle}".`,
        });

        yield* requireDeclaredOutputArtifacts(request, result);
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
): Effect.Effect<
  HarnessRunResult,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
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
  readonly exitCode: number;
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
          GAIA_HARNESS_CONTRACT_VERSION: harnessContractVersion,
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
      exitCode: 0,
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

function requireDeclaredOutputArtifacts(
  request: HarnessRunRequest,
  result: HarnessRunResult,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    for (const artifact of result.outputArtifacts) {
      if (!artifact.startsWith("workspace/")) {
        continue;
      }

      const relativePath = artifact.slice("workspace/".length);
      const exists = yield* fs.exists(
        path.join(request.workspacePath, relativePath),
      );
      if (!exists) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "HarnessOutputArtifactMissing",
            message: `Harness '${request.harnessName}' declared missing output artifact '${artifact}'.`,
            recoverable: true,
          }),
        );
      }
    }
  });
}

function snapshotWorkspace(workspacePath: string) {
  return snapshotDirectory(workspacePath, "");
}

function snapshotDirectory(
  directoryPath: string,
  relativePrefix: string,
): Effect.Effect<
  ReadonlyMap<string, string>,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = (yield* fs.readDirectory(directoryPath)).toSorted();
    const digestByPath = new Map<string, string>();

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry);
      const relativePath =
        relativePrefix.length === 0 ? entry : `${relativePrefix}/${entry}`;
      const info = yield* fs.stat(absolutePath);

      switch (info.type) {
        case "Directory": {
          const childDigest = yield* snapshotDirectory(
            absolutePath,
            relativePath,
          );
          for (const [childPath, digest] of childDigest) {
            digestByPath.set(childPath, digest);
          }
          break;
        }
        case "File": {
          const bytes = yield* fs.readFile(absolutePath);
          digestByPath.set(relativePath, hashBytes(bytes));
          break;
        }
        default: {
          break;
        }
      }
    }

    return digestByPath;
  });
}

function changedPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed: Array<string> = [];

  for (const path of paths) {
    if (before.get(path) !== after.get(path)) {
      changed.push(path);
    }
  }

  return changed.toSorted();
}

function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
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
