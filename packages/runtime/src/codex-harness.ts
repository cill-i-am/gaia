import { execFile } from "node:child_process";

import { RunEvent, RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import { RuntimePathSchema } from "./paths.js";

const codexCommandMaxBufferBytes = 10 * 1024 * 1024;
const defaultCodexCommand = "codex";
const defaultCodexSandbox = "workspace-write";
const defaultCodexCommandTimeoutMs = 10 * 60 * 1000;

export const CodexCommandSchema = Schema.NonEmptyString.pipe(
  Schema.brand("CodexCommand")
);

export type CodexCommand = typeof CodexCommandSchema.Type;

export const CodexCommandTimeoutMsSchema = Schema.Number.check(
  Schema.isInt({ identifier: "CodexCommandTimeoutMsInt" }),
  Schema.isGreaterThanOrEqualTo(1, {
    identifier: "CodexCommandTimeoutMsPositive",
  })
).pipe(Schema.brand("CodexCommandTimeoutMs"));

export type CodexCommandTimeoutMs = typeof CodexCommandTimeoutMsSchema.Type;

const parseCodexCommandTimeoutMs = Schema.decodeUnknownSync(
  CodexCommandTimeoutMsSchema
);

export const CodexSandboxModeSchema = Schema.Literals([
  "read-only",
  "workspace-write",
] as const);

export type CodexSandboxMode = typeof CodexSandboxModeSchema.Type;

export const CodexCommandOutputStreamSchema = Schema.Literals([
  "stderr",
  "stdout",
] as const);

export type CodexCommandOutputStream =
  typeof CodexCommandOutputStreamSchema.Type;

export const CodexHarnessProgressStatusSchema = Schema.Literals([
  "running",
  "completed",
  "command-failed",
  "timed-out",
  "last-message-missing",
] as const);

export type CodexHarnessProgressStatus =
  typeof CodexHarnessProgressStatusSchema.Type;

export const CodexHarnessStallClassificationSchema = Schema.Literals([
  "no-progress",
  "progress-observed",
] as const);

export type CodexHarnessStallClassification =
  typeof CodexHarnessStallClassificationSchema.Type;

export class CodexHarnessProgress extends Schema.Class<CodexHarnessProgress>(
  "CodexHarnessProgress"
)({
  command: CodexCommandSchema,
  cwd: Schema.NonEmptyString,
  lastMessagePath: RuntimePathSchema,
  lastObservedOutputAt: Schema.optionalKey(Schema.NonEmptyString),
  lastObservedOutputStream: Schema.optionalKey(CodexCommandOutputStreamSchema),
  observedOutputBytes: Schema.Number.check(
    Schema.isInt({ identifier: "ObservedOutputBytesInt" }),
    Schema.isGreaterThanOrEqualTo(0, {
      identifier: "ObservedOutputBytesNonNegative",
    })
  ),
  progressPath: RuntimePathSchema,
  runId: RunIdSchema,
  stallClassification: Schema.optionalKey(
    CodexHarnessStallClassificationSchema
  ),
  startedAt: RunEvent.fields.timestamp,
  status: CodexHarnessProgressStatusSchema,
  terminal: Schema.Boolean,
  timeoutMs: CodexCommandTimeoutMsSchema,
  updatedAt: RunEvent.fields.timestamp,
  version: Schema.Literal(1),
}) {}

const CodexHarnessProgressJson = Schema.toCodecJson(CodexHarnessProgress);

export const encodeCodexHarnessProgress = Schema.encodeSync(
  CodexHarnessProgressJson
);

export const parseCodexHarnessProgressJson = Schema.decodeUnknownSync(
  CodexHarnessProgressJson
);

export class CodexHarnessConfig extends Schema.Class<CodexHarnessConfig>(
  "CodexHarnessConfig"
)({
  command: CodexCommandSchema,
  extraArgs: Schema.Array(Schema.String),
  model: Schema.optionalKey(Schema.NonEmptyString),
  profile: Schema.optionalKey(Schema.NonEmptyString),
  sandbox: CodexSandboxModeSchema,
  timeoutMs: CodexCommandTimeoutMsSchema,
}) {}

export const parseCodexHarnessConfig =
  Schema.decodeUnknownSync(CodexHarnessConfig);

export const CodexHarnessConfigInputSchema = Schema.Struct({
  command: Schema.optional(Schema.String),
  extraArgs: Schema.optional(Schema.Array(Schema.String)),
  model: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
  sandbox: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
});
export type CodexHarnessConfigInput = typeof CodexHarnessConfigInputSchema.Type;

export function makeCodexHarnessConfig(
  input: CodexHarnessConfigInput = {}
): CodexHarnessConfig {
  return parseCodexHarnessConfig({
    command: input.command ?? defaultCodexCommand,
    extraArgs: [...(input.extraArgs ?? [])],
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    sandbox: input.sandbox ?? defaultCodexSandbox,
    timeoutMs: parseCodexCommandTimeoutInput(input.timeoutMs),
  });
}

export class CodexCommandRequest extends Schema.Class<CodexCommandRequest>(
  "CodexCommandRequest"
)(
  {
    args: Schema.Array(Schema.String),
    command: CodexCommandSchema,
    cwd: Schema.NonEmptyString,
    progressPath: Schema.optionalKey(Schema.NonEmptyString),
    stdin: Schema.String,
    timeoutMs: CodexCommandTimeoutMsSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class CodexCommandOutputObservation extends Schema.Class<CodexCommandOutputObservation>(
  "CodexCommandOutputObservation"
)(
  {
    bytes: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    stream: CodexCommandOutputStreamSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export type CodexCommandProgressRecorder = (
  observation: CodexCommandOutputObservation
) => Promise<void>;

export class CodexCommandResult extends Schema.Class<CodexCommandResult>(
  "CodexCommandResult"
)(
  { exitCode: Schema.Int, stderr: Schema.String, stdout: Schema.String },
  { parseOptions: { onExcessProperty: "error" } }
) {}

/** Manual capability shell; serializable request data is schema-owned. */
export type CodexCommandInvocation = {
  readonly recordProgress?: CodexCommandProgressRecorder;
  readonly request: CodexCommandRequest;
};

export type CodexCommandRunner = (
  input: CodexCommandInvocation
) => Effect.Effect<
  CodexCommandResult,
  GaiaRuntimeError | PlatformError,
  FileSystem.FileSystem | Path.Path
>;

export type CodexHarnessOptions = {
  readonly commandRunner?: CodexCommandRunner;
  readonly config: CodexHarnessConfig;
};

export class CodexHarnessPromptInput extends Schema.Class<CodexHarnessPromptInput>(
  "CodexHarnessPromptInput"
)(
  {
    resolvedSkillPaths: Schema.Array(Schema.NonEmptyString),
    runId: RunIdSchema,
    skillBundlePath: RuntimePathSchema,
    specBody: Schema.NonEmptyString,
    specTitle: Schema.NonEmptyString,
    workspaceOutputPath: RuntimePathSchema,
    workspacePath: RuntimePathSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export class CodexCommandArgsInput extends Schema.Class<CodexCommandArgsInput>(
  "CodexCommandArgsInput"
)(
  {
    config: CodexHarnessConfig,
    lastMessagePath: RuntimePathSchema,
    workspacePath: RuntimePathSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

export const nodeCodexCommandRunner: CodexCommandRunner = (input) =>
  Effect.tryPromise({
    try: () =>
      new Promise<CodexCommandResult>((resolve, reject) => {
        const request = input.request;
        const pendingProgressWrites = new Set<Promise<void>>();
        let progressWriteFailed = false;
        let progressWriteFailure: unknown;
        const recordProgressWriteFailure = (cause: unknown) => {
          if (!progressWriteFailed) {
            progressWriteFailed = true;
            progressWriteFailure = cause;
          }
        };
        const observeOutput = (
          stream: CodexCommandOutputStream,
          chunk: Buffer | string
        ) => {
          const bytes = Buffer.byteLength(chunk);
          if (bytes === 0 || input.recordProgress === undefined) {
            return;
          }

          const recordProgress = input.recordProgress;
          const pending = Promise.resolve()
            .then(() =>
              recordProgress(
                CodexCommandOutputObservation.make({ bytes, stream })
              )
            )
            .catch(recordProgressWriteFailure)
            .finally(() => pendingProgressWrites.delete(pending));
          pendingProgressWrites.add(pending);
        };
        const settleAfterProgressWrites = (
          complete: () => void,
          fail: (cause: unknown) => void
        ) => {
          Promise.allSettled([...pendingProgressWrites]).then((results) => {
            const rejected = results.find(
              (result) => result.status === "rejected"
            );
            if (rejected?.status === "rejected") {
              fail(rejected.reason);
              return;
            }

            if (progressWriteFailed) {
              fail(progressWriteFailure);
              return;
            }

            complete();
          }, fail);
        };
        const child = execFile(
          request.command,
          [...request.args],
          {
            cwd: request.cwd,
            maxBuffer: codexCommandMaxBufferBytes,
            timeout: request.timeoutMs,
          },
          (error, stdout, stderr) => {
            if (error !== null && error.code === "ENOENT") {
              settleAfterProgressWrites(
                () => reject(error),
                (cause) => reject(cause)
              );
              return;
            }

            if (
              error !== null &&
              (error.code === undefined ||
                error.code === null ||
                isTimeoutError(error))
            ) {
              settleAfterProgressWrites(
                () => reject(error),
                (cause) => reject(cause)
              );
              return;
            }

            settleAfterProgressWrites(
              () =>
                resolve(
                  CodexCommandResult.make({
                    exitCode: normalizeExitCode(error?.code),
                    stderr: String(stderr),
                    stdout: String(stdout),
                  })
                ),
              (cause) => reject(cause)
            );
          }
        );
        child.stdout?.on("data", (chunk: Buffer | string) =>
          observeOutput("stdout", chunk)
        );
        child.stderr?.on("data", (chunk: Buffer | string) =>
          observeOutput("stderr", chunk)
        );
        child.stdin?.end(request.stdin);
      }),
    catch: (cause) =>
      cause instanceof GaiaRuntimeError
        ? cause
        : makeRuntimeError({
            cause,
            code: codexCommandFailureCode(cause),
            message: codexCommandFailureMessage(input.request.command, cause),
            recoverable: true,
          }),
  });

export function makeCodexHarnessPrompt(input: CodexHarnessPromptInput) {
  return [
    "You are the Gaia Codex worker harness.",
    `Run ID: ${input.runId}`,
    `Workspace: ${input.workspacePath}`,
    `Spec title: ${input.specTitle}`,
    "Spec body:",
    input.specBody,
    "Skill context:",
    `- Skill bundle JSON: ${input.skillBundlePath}`,
    ...formatResolvedSkillPaths(input.resolvedSkillPaths),
    "Required output contract:",
    "- Make the smallest useful workspace change needed for the spec.",
    `- Write a concise final worker result to ${input.workspaceOutputPath}.`,
    "- From the current working directory, that artifact is ./output.txt.",
    "- Do not create a nested workspace/ directory.",
    "- Include the run id in ./output.txt.",
    "- Do not write outside the workspace.",
  ].join("\n\n");
}

function formatResolvedSkillPaths(resolvedSkillPaths: ReadonlyArray<string>) {
  if (resolvedSkillPaths.length === 0) {
    return ["- No local resolved skill paths are available for this run."];
  }

  return [
    "- Local resolved skill paths:",
    ...resolvedSkillPaths.map((skillPath) => `  - ${skillPath}`),
  ];
}

export function makeCodexCommandArgs(input: CodexCommandArgsInput) {
  return [
    "exec",
    "--json",
    "--cd",
    input.workspacePath,
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox",
    input.config.sandbox,
    "--output-last-message",
    input.lastMessagePath,
    ...(input.config.model === undefined
      ? []
      : ["--model", input.config.model]),
    ...(input.config.profile === undefined
      ? []
      : ["--profile", input.config.profile]),
    ...input.config.extraArgs,
    "-",
  ];
}

function parseCodexCommandTimeoutInput(
  input: CodexHarnessConfigInput["timeoutMs"]
) {
  if (input === undefined) {
    return parseCodexCommandTimeoutMs(defaultCodexCommandTimeoutMs);
  }

  if (typeof input === "string") {
    return parseCodexCommandTimeoutMs(
      Schema.decodeUnknownSync(Schema.NumberFromString)(input)
    );
  }

  return parseCodexCommandTimeoutMs(input);
}

function normalizeExitCode(code: string | number | null | undefined) {
  if (typeof code === "number") {
    return code;
  }

  if (typeof code === "string") {
    const parsed = Number.parseInt(code, 10);
    return Number.isInteger(parsed) ? parsed : 1;
  }

  return 0;
}

function codexCommandFailureCode(cause: unknown) {
  if (isErrorWithCode(cause, "ENOENT")) {
    return "CodexCommandMissing";
  }

  if (isTimeoutError(cause)) {
    return "CodexCommandTimedOut";
  }

  return "CodexCommandFailed";
}

function codexCommandFailureMessage(command: CodexCommand, cause: unknown) {
  if (isErrorWithCode(cause, "ENOENT")) {
    return `Codex command '${command}' was not found.`;
  }

  if (isTimeoutError(cause)) {
    return `Codex command '${command}' timed out.`;
  }

  return `Codex command '${command}' failed.`;
}

function isErrorWithCode(error: unknown, code: string) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return Reflect.get(error, "code") === code;
}

function isTimeoutError(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return (
    Reflect.get(error, "killed") === true &&
    Reflect.get(error, "signal") === "SIGTERM"
  );
}
