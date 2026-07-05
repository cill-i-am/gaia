import { RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import {
  makeCodexCommandArgs,
  makeCodexHarnessPrompt,
  nodeCodexCommandRunner,
  type CodexCommandResult,
  type CodexHarnessOptions,
} from "./codex-harness.js";
import { BrowserEvidenceTargetUrlSchema } from "./browser-evidence.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import { changedPaths, snapshotWorkspace } from "./workspace-snapshot.js";

export const HarnessNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("HarnessName"),
);

export type HarnessName = typeof HarnessNameSchema.Type;

export const parseHarnessName = Schema.decodeUnknownSync(HarnessNameSchema);

export const defaultHarnessName = parseHarnessName("fake");
export const processHarnessName = parseHarnessName("process");
export const codexHarnessName = parseHarnessName("codex");

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
  resolvedSkillPaths: Schema.Array(Schema.NonEmptyString),
  skillBundlePath: Schema.NonEmptyString,
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
  browserTargetUrl: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
  changedWorkspacePaths: Schema.Array(Schema.NonEmptyString),
  exitCode: Schema.Number.pipe(
    Schema.check(Schema.isInt({ identifier: "ProcessExitCode" })),
  ),
  harnessName: HarnessNameSchema,
  outputArtifacts: Schema.Array(Schema.NonEmptyString),
  previewDeploymentUrl: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
  resultPath: Schema.NonEmptyString,
  runId: RunIdSchema,
  status: Schema.Literal("completed"),
  summary: Schema.NonEmptyString,
}) {}

class ProcessHarnessDeclaration extends Schema.Class<ProcessHarnessDeclaration>(
  "ProcessHarnessDeclaration",
)({
  browserTargetUrl: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
  previewDeploymentUrl: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
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
const ProcessHarnessDeclarationJson = Schema.toCodecJson(
  ProcessHarnessDeclaration,
);
const decodeProcessHarnessDeclaration = Schema.decodeUnknownSync(
  ProcessHarnessDeclarationJson,
);
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
        const declaration = yield* readProcessHarnessDeclaration(request);
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
          ...(declaration.browserTargetUrl === undefined
            ? {}
            : { browserTargetUrl: declaration.browserTargetUrl }),
          ...(declaration.previewDeploymentUrl === undefined
            ? {}
            : { previewDeploymentUrl: declaration.previewDeploymentUrl }),
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

function codexHarness(options: CodexHarnessOptions): GaiaHarness {
  return {
    name: codexHarnessName,
    run: (request) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runner = options.commandRunner ?? nodeCodexCommandRunner;
        const lastMessagePath = path.join(
          path.dirname(request.workerResultPath),
          "codex-last-message.md",
        );

        yield* fs.writeFileString(
          request.workerLogPath,
          `Codex harness started: ${options.config.command}\n`,
          { flag: "a" },
        );

        const beforeWorkspace = yield* snapshotWorkspace(request.workspacePath);
        const execution = yield* runner({
          args: makeCodexCommandArgs({
            config: options.config,
            lastMessagePath,
            workspacePath: request.workspacePath,
          }),
          command: options.config.command,
          cwd: request.workspacePath,
          stdin: makeCodexHarnessPrompt({
            resolvedSkillPaths: request.resolvedSkillPaths,
            runId: request.runId,
            skillBundlePath: request.skillBundlePath,
            specBody: request.specBody,
            specTitle: request.specTitle,
            workspaceOutputPath: request.workspaceOutputPath,
            workspacePath: request.workspacePath,
          }),
          timeoutMs: options.config.timeoutMs,
        });
        yield* fs.writeFileString(
          request.workerLogPath,
          formatCodexOutput(execution),
          { flag: "a" },
        );

        if (execution.exitCode !== 0) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "CodexCommandFailed",
              message: `Codex command '${options.config.command}' exited with code ${execution.exitCode}.`,
              recoverable: true,
            }),
          );
        }

        const lastMessageExists = yield* fs.exists(lastMessagePath);
        if (!lastMessageExists) {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "CodexLastMessageMissing",
              message:
                "Codex completed without writing its last-message artifact.",
              recoverable: true,
            }),
          );
        }

        const afterWorkspace = yield* snapshotWorkspace(request.workspacePath);
        const changedWorkspacePaths = changedPaths(
          beforeWorkspace,
          afterWorkspace,
        );
        const result = HarnessRunResult.make({
          changedWorkspacePaths,
          exitCode: execution.exitCode,
          harnessName: request.harnessName,
          outputArtifacts: ["workspace/output.txt"],
          resultPath: "worker-result.json",
          runId: request.runId,
          status: "completed",
          summary: `Codex harness completed "${request.specTitle}".`,
        });

        yield* requireDeclaredOutputArtifacts(request, result);
        yield* writeHarnessRunResult(request, result);
        yield* fs.writeFileString(
          request.workerLogPath,
          "Codex harness completed.\n",
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
  codexHarnessName,
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
  readonly codexHarness?: CodexHarnessOptions;
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

  if (harnessName === codexHarnessName) {
    if (options.codexHarness === undefined) {
      return Effect.fail(
        makeRuntimeError({
          code: "CodexHarnessConfigMissing",
          message: "Harness 'codex' requires Codex harness config.",
          recoverable: false,
        }),
      );
    }

    return Effect.succeed(codexHarness(options.codexHarness));
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
          GAIA_RESOLVED_SKILL_PATHS_JSON: JSON.stringify(
            request.resolvedSkillPaths,
          ),
          GAIA_SKILL_BUNDLE_PATH: request.skillBundlePath,
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

function formatCodexOutput(execution: CodexCommandResult) {
  const lines: Array<string> = [];

  if (execution.stdout.length > 0) {
    lines.push("Codex stdout:", execution.stdout.trimEnd());
  }

  if (execution.stderr.length > 0) {
    lines.push("Codex stderr:", execution.stderr.trimEnd());
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

function readProcessHarnessDeclaration(
  request: HarnessRunRequest,
): Effect.Effect<ProcessHarnessDeclaration, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(request.workerResultPath);
    if (!exists) {
      return ProcessHarnessDeclaration.make({});
    }

    const contents = yield* fs.readFileString(request.workerResultPath);
    return yield* parseProcessHarnessDeclaration(contents, request);
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "ProcessHarnessDeclarationReadFailed",
          message:
            "Process harness completed, but Gaia could not read its worker result declaration.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function parseProcessHarnessDeclaration(
  contents: string,
  request: HarnessRunRequest,
) {
  return Effect.try({
    try: () => decodeProcessHarnessDeclaration(JSON.parse(contents)),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "ProcessHarnessDeclarationInvalid",
        message: `Process harness '${request.harnessName}' wrote an invalid worker result declaration.`,
        recoverable: true,
      }),
  });
}
