import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { RunEvent, RunIdSchema, WorkspaceRelativePathSchema } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";

import { BrowserEvidenceTargetUrlSchema } from "./browser-evidence.js";
import {
  makeCodexCommandArgs,
  makeCodexHarnessPrompt,
  nodeCodexCommandRunner,
  CodexCommandRequest,
  CodexHarnessProgress,
  encodeCodexHarnessProgress,
  type CodexCommandResult,
  type CodexHarnessProgressStatus,
  type CodexHarnessOptions,
  type CodexCommandOutputObservation,
} from "./codex-harness.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import {
  parseRuntimePath,
  RunRelativeArtifactPathSchema,
  RuntimePathSchema,
} from "./paths.js";
import {
  diffWorkspaceSnapshots,
  productOnlyWorkspaceDiff,
  snapshotWorkspace,
  WorkspaceDiffSummary,
} from "./workspace-snapshot.js";

export const HarnessNameSchema = Schema.NonEmptyString.pipe(
  Schema.brand("HarnessName")
);

export type HarnessName = typeof HarnessNameSchema.Type;

export const parseHarnessName = Schema.decodeUnknownSync(HarnessNameSchema);

export const defaultHarnessName = parseHarnessName("fake");
export const processHarnessName = parseHarnessName("process");
export const codexHarnessName = parseHarnessName("codex");
export const codexAppServerHarnessName = parseHarnessName("codexAppServer");

const processHarnessMaxBufferBytes = 10 * 1024 * 1024;
const harnessContractVersion = "1";
const parseCodexHarnessTimestamp = Schema.decodeUnknownSync(
  RunEvent.fields.timestamp
);

export const ProcessHarnessCommandSchema = Schema.NonEmptyString.pipe(
  Schema.brand("ProcessHarnessCommand")
);

export type ProcessHarnessCommand = typeof ProcessHarnessCommandSchema.Type;

export class ProcessHarnessConfig extends Schema.Class<ProcessHarnessConfig>(
  "ProcessHarnessConfig"
)({
  args: Schema.Array(Schema.String),
  command: ProcessHarnessCommandSchema,
}) {}

export const parseProcessHarnessConfig =
  Schema.decodeUnknownSync(ProcessHarnessConfig);

export function makeProcessHarnessConfig(
  command: string,
  args: ReadonlyArray<string> = []
): ProcessHarnessConfig {
  return parseProcessHarnessConfig({ args, command });
}

export class HarnessRunRequest extends Schema.Class<HarnessRunRequest>(
  "HarnessRunRequest"
)({
  codexHarnessProgressPath: RuntimePathSchema,
  harnessName: HarnessNameSchema,
  runId: RunIdSchema,
  resolvedSkillPaths: Schema.Array(RuntimePathSchema),
  skillBundlePath: RuntimePathSchema,
  specBody: Schema.NonEmptyString,
  specTitle: Schema.NonEmptyString,
  workerLogPath: RuntimePathSchema,
  workerResultPath: RuntimePathSchema,
  workspaceOutputPath: RuntimePathSchema,
  workspacePath: RuntimePathSchema,
}) {
  static override make(input: unknown): HarnessRunRequest {
    return decodeHarnessRunRequest(input);
  }
}

export class HarnessRunResult extends Schema.Class<HarnessRunResult>(
  "HarnessRunResult"
)({
  browserTargetUrl: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
  changedWorkspacePaths: Schema.Array(WorkspaceRelativePathSchema),
  exitCode: Schema.Number.pipe(
    Schema.check(Schema.isInt({ identifier: "ProcessExitCode" }))
  ),
  harnessName: HarnessNameSchema,
  outputArtifacts: Schema.Array(RunRelativeArtifactPathSchema),
  previewDeploymentUrl: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
  resultPath: RunRelativeArtifactPathSchema,
  runId: RunIdSchema,
  status: Schema.Literal("completed"),
  summary: Schema.NonEmptyString,
  workspaceDiff: Schema.optionalKey(WorkspaceDiffSummary),
}) {
  static override make(input: unknown): HarnessRunResult {
    return decodeHarnessRunResult(input);
  }
}

class ProcessHarnessDeclaration extends Schema.Class<ProcessHarnessDeclaration>(
  "ProcessHarnessDeclaration"
)({
  browserTargetUrl: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
  previewDeploymentUrl: Schema.optionalKey(BrowserEvidenceTargetUrlSchema),
}) {}

export type GaiaHarness = {
  readonly name: HarnessName;
  readonly run: (
    request: HarnessRunRequest
  ) => Effect.Effect<
    HarnessRunResult,
    GaiaRuntimeError,
    FileSystem.FileSystem | Path.Path
  >;
};

const decodeHarnessRunRequest = Schema.decodeUnknownSync(HarnessRunRequest);
const decodeHarnessRunResult = Schema.decodeUnknownSync(HarnessRunResult);
const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
export const parseHarnessRunResultJson =
  Schema.decodeUnknownSync(HarnessRunResultJson);
const encodeHarnessRunResult = Schema.encodeSync(HarnessRunResultJson);
const ProcessHarnessDeclarationJson = Schema.toCodecJson(
  ProcessHarnessDeclaration
);
const decodeProcessHarnessDeclaration = Schema.decodeUnknownSync(
  ProcessHarnessDeclarationJson
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
        { flag: "a" }
      );
      yield* fs.writeFileString(request.workspaceOutputPath, output);
      const workspaceDiff = productOnlyWorkspaceDiff(["output.txt"]);
      const result = HarnessRunResult.make({
        changedWorkspacePaths: workspaceDiff.productChangedPaths,
        exitCode: 0,
        harnessName: request.harnessName,
        outputArtifacts: ["workspace/output.txt"],
        resultPath: "worker-result.json",
        runId: request.runId,
        status: "completed",
        summary: `Fake harness completed "${request.specTitle}".`,
        workspaceDiff,
      });
      yield* requireDeclaredOutputArtifacts(request, result);
      yield* fs.writeFileString(
        request.workerResultPath,
        `${JSON.stringify(encodeHarnessRunResult(result), null, 2)}\n`
      );
      yield* fs.writeFileString(
        request.workerLogPath,
        "Fake harness completed.\n",
        { flag: "a" }
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
          })
        )
      )
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
          { flag: "a" }
        );

        const beforeWorkspace = yield* snapshotWorkspace(request.workspacePath);
        const execution = yield* runProcessHarnessCommand(config, request);
        const declaration = yield* readProcessHarnessDeclaration(request);
        const afterWorkspace = yield* snapshotWorkspace(request.workspacePath);
        const workspaceDiff = diffWorkspaceSnapshots(
          beforeWorkspace,
          afterWorkspace
        );
        yield* fs.writeFileString(
          request.workerLogPath,
          formatProcessOutput(execution),
          { flag: "a" }
        );

        const result = HarnessRunResult.make({
          ...(declaration.browserTargetUrl === undefined
            ? {}
            : { browserTargetUrl: declaration.browserTargetUrl }),
          ...(declaration.previewDeploymentUrl === undefined
            ? {}
            : { previewDeploymentUrl: declaration.previewDeploymentUrl }),
          changedWorkspacePaths: workspaceDiff.productChangedPaths,
          exitCode: execution.exitCode,
          harnessName: request.harnessName,
          outputArtifacts: ["workspace/output.txt"],
          resultPath: "worker-result.json",
          runId: request.runId,
          status: "completed",
          summary: `Process harness completed "${request.specTitle}".`,
          workspaceDiff,
        });

        yield* requireDeclaredOutputArtifacts(request, result);
        yield* writeHarnessRunResult(request, result);
        yield* fs.writeFileString(
          request.workerLogPath,
          "Process harness completed.\n",
          { flag: "a" }
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
            })
          )
        )
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
        const lastMessagePath = parseRuntimePath(
          path.join(
            path.dirname(request.workerResultPath),
            "codex-last-message.md"
          )
        );
        const startedAt = parseCodexHarnessTimestamp(new Date().toISOString());
        let progress = CodexHarnessProgress.make({
          command: options.config.command,
          cwd: request.workspacePath,
          lastMessagePath: parseRuntimePath(path.basename(lastMessagePath)),
          observedOutputBytes: 0,
          progressPath: parseRuntimePath(
            path.basename(request.codexHarnessProgressPath)
          ),
          runId: request.runId,
          startedAt,
          status: "running",
          terminal: false,
          timeoutMs: options.config.timeoutMs,
          updatedAt: startedAt,
          version: 1,
        });
        const writeProgress = (nextProgress: CodexHarnessProgress) =>
          fs.writeFileString(
            request.codexHarnessProgressPath,
            `${JSON.stringify(encodeCodexHarnessProgress(nextProgress), null, 2)}\n`
          );
        const recordOutputProgress = (
          observation: CodexCommandOutputObservation
        ) => {
          const observedAt = parseCodexHarnessTimestamp(
            new Date().toISOString()
          );
          progress = CodexHarnessProgress.make({
            command: progress.command,
            cwd: progress.cwd,
            lastMessagePath: progress.lastMessagePath,
            lastObservedOutputAt: observedAt,
            lastObservedOutputStream: observation.stream,
            observedOutputBytes:
              progress.observedOutputBytes + observation.bytes,
            progressPath: progress.progressPath,
            runId: progress.runId,
            startedAt: progress.startedAt,
            status: "running",
            terminal: false,
            timeoutMs: progress.timeoutMs,
            updatedAt: observedAt,
            version: progress.version,
          });

          return Effect.runPromise(writeProgress(progress));
        };
        const recordTerminalProgress = (
          status: Exclude<CodexHarnessProgressStatus, "running">
        ) =>
          Effect.gen(function* () {
            const updatedAt = parseCodexHarnessTimestamp(
              new Date().toISOString()
            );
            progress = CodexHarnessProgress.make({
              command: progress.command,
              cwd: progress.cwd,
              lastMessagePath: progress.lastMessagePath,
              ...codexObservedOutput(progress),
              observedOutputBytes: progress.observedOutputBytes,
              progressPath: progress.progressPath,
              runId: progress.runId,
              stallClassification:
                progress.lastObservedOutputAt === undefined
                  ? "no-progress"
                  : "progress-observed",
              startedAt: progress.startedAt,
              status,
              terminal: true,
              timeoutMs: progress.timeoutMs,
              updatedAt,
              version: progress.version,
            });
            yield* writeProgress(progress);
          });

        yield* fs.writeFileString(
          request.workerLogPath,
          `Codex harness started: ${options.config.command}\n`,
          { flag: "a" }
        );
        yield* writeProgress(progress);

        const beforeWorkspace = yield* snapshotWorkspace(request.workspacePath);
        const execution = yield* runner({
          recordProgress: recordOutputProgress,
          request: CodexCommandRequest.make({
            args: makeCodexCommandArgs({
              config: options.config,
              lastMessagePath,
              workspacePath: request.workspacePath,
            }),
            command: options.config.command,
            cwd: request.workspacePath,
            progressPath: request.codexHarnessProgressPath,
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
          }),
        }).pipe(
          Effect.catchTag("GaiaRuntimeError", (error) =>
            recordTerminalProgress(codexProgressStatusFromError(error)).pipe(
              Effect.flatMap(() => Effect.fail(error))
            )
          )
        );
        yield* fs.writeFileString(
          request.workerLogPath,
          formatCodexOutput(execution),
          { flag: "a" }
        );

        if (execution.exitCode !== 0) {
          yield* recordTerminalProgress("command-failed");
          return yield* Effect.fail(
            makeRuntimeError({
              code: "CodexCommandFailed",
              message: `Codex command '${options.config.command}' exited with code ${execution.exitCode}.`,
              recoverable: true,
            })
          );
        }

        const lastMessageExists = yield* fs.exists(lastMessagePath);
        if (!lastMessageExists) {
          yield* recordTerminalProgress("last-message-missing");
          return yield* Effect.fail(
            makeRuntimeError({
              code: "CodexLastMessageMissing",
              message:
                "Codex completed without writing its last-message artifact.",
              recoverable: true,
            })
          );
        }

        const afterWorkspace = yield* snapshotWorkspace(request.workspacePath);
        const workspaceDiff = diffWorkspaceSnapshots(
          beforeWorkspace,
          afterWorkspace
        );
        const result = HarnessRunResult.make({
          changedWorkspacePaths: workspaceDiff.productChangedPaths,
          exitCode: execution.exitCode,
          harnessName: request.harnessName,
          outputArtifacts: ["workspace/output.txt"],
          resultPath: "worker-result.json",
          runId: request.runId,
          status: "completed",
          summary: `Codex harness completed "${request.specTitle}".`,
          workspaceDiff,
        });

        yield* requireDeclaredOutputArtifacts(request, result);
        yield* writeHarnessRunResult(request, result);
        yield* recordTerminalProgress("completed");
        yield* fs.writeFileString(
          request.workerLogPath,
          "Codex harness completed.\n",
          { flag: "a" }
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
            })
          )
        )
      ),
  };
}

function codexProgressStatusFromError(
  error: GaiaRuntimeError
): Exclude<CodexHarnessProgressStatus, "running"> {
  if (error.code === "CodexCommandTimedOut") {
    return "timed-out";
  }

  if (error.code === "CodexLastMessageMissing") {
    return "last-message-missing";
  }

  return "command-failed";
}

function codexObservedOutput(progress: CodexHarnessProgress) {
  if (
    progress.lastObservedOutputAt === undefined ||
    progress.lastObservedOutputStream === undefined
  ) {
    return {};
  }

  return {
    lastObservedOutputAt: progress.lastObservedOutputAt,
    lastObservedOutputStream: progress.lastObservedOutputStream,
  };
}

export const availableHarnessNames: ReadonlyArray<HarnessName> = [
  fakeHarness.name,
  processHarnessName,
  codexHarnessName,
];

export function runHarness(
  request: HarnessRunRequest,
  options: HarnessRunOptions = {}
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
  options: HarnessRunOptions
): Effect.Effect<GaiaHarness, GaiaRuntimeError> {
  if (harnessName === fakeHarness.name) {
    return Effect.succeed(fakeHarness);
  }

  if (harnessName === processHarnessName) {
    if (options.processHarness === undefined) {
      return Effect.fail(
        makeRuntimeError({
          code: "ProcessHarnessCommandMissing",
          message: "Harness 'process' requires a process harness command.",
          recoverable: false,
        })
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
        })
      );
    }

    return Effect.succeed(codexHarness(options.codexHarness));
  }

  return Effect.fail(
    makeRuntimeError({
      code: "UnknownHarness",
      message: `Harness '${harnessName}' is not registered. Available harnesses: ${availableHarnessNames.join(", ")}.`,
      recoverable: false,
    })
  );
}

type ProcessExecutionResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

function runProcessHarnessCommand(
  config: ProcessHarnessConfig,
  request: HarnessRunRequest
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
            request.resolvedSkillPaths
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
    }))
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
  result: HarnessRunResult
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
        path.join(request.workspacePath, relativePath)
      );
      if (!exists) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "HarnessOutputArtifactMissing",
            message: `Harness '${request.harnessName}' declared missing output artifact '${artifact}'.`,
            recoverable: true,
          })
        );
      }
    }
  });
}

function writeHarnessRunResult(
  request: HarnessRunRequest,
  result: HarnessRunResult
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      request.workerResultPath,
      `${JSON.stringify(encodeHarnessRunResult(result), null, 2)}\n`
    );
  });
}

function readProcessHarnessDeclaration(
  request: HarnessRunRequest
): Effect.Effect<
  ProcessHarnessDeclaration,
  GaiaRuntimeError,
  FileSystem.FileSystem
> {
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
        })
      )
    )
  );
}

function parseProcessHarnessDeclaration(
  contents: string,
  request: HarnessRunRequest
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
