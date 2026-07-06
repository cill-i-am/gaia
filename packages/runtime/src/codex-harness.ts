import { RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { execFile } from "node:child_process";
import type { PlatformError } from "effect/PlatformError";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";

const codexCommandMaxBufferBytes = 10 * 1024 * 1024;
const defaultCodexCommand = "codex";
const defaultCodexSandbox = "workspace-write";
const defaultCodexCommandTimeoutMs = 10 * 60 * 1000;

export const CodexCommandSchema = Schema.NonEmptyString.pipe(
  Schema.brand("CodexCommand"),
);

export type CodexCommand = typeof CodexCommandSchema.Type;

export const CodexCommandTimeoutMsSchema = Schema.Number.check(
  Schema.isInt({ identifier: "CodexCommandTimeoutMsInt" }),
  Schema.isGreaterThanOrEqualTo(1, {
    identifier: "CodexCommandTimeoutMsPositive",
  }),
).pipe(Schema.brand("CodexCommandTimeoutMs"));

export type CodexCommandTimeoutMs =
  typeof CodexCommandTimeoutMsSchema.Type;

const parseCodexCommandTimeoutMs = Schema.decodeUnknownSync(
  CodexCommandTimeoutMsSchema,
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
  "CodexHarnessProgress",
)({
  command: CodexCommandSchema,
  cwd: Schema.NonEmptyString,
  lastMessagePath: Schema.NonEmptyString,
  lastObservedOutputAt: Schema.optionalKey(Schema.NonEmptyString),
  lastObservedOutputStream: Schema.optionalKey(CodexCommandOutputStreamSchema),
  observedOutputBytes: Schema.Number.check(
    Schema.isInt({ identifier: "ObservedOutputBytesInt" }),
    Schema.isGreaterThanOrEqualTo(0, {
      identifier: "ObservedOutputBytesNonNegative",
    }),
  ),
  progressPath: Schema.NonEmptyString,
  runId: RunIdSchema,
  stallClassification: Schema.optionalKey(
    CodexHarnessStallClassificationSchema,
  ),
  startedAt: Schema.NonEmptyString,
  status: CodexHarnessProgressStatusSchema,
  terminal: Schema.Boolean,
  timeoutMs: CodexCommandTimeoutMsSchema,
  updatedAt: Schema.NonEmptyString,
  version: Schema.Literal(1),
}) {}

const CodexHarnessProgressJson = Schema.toCodecJson(CodexHarnessProgress);

export const encodeCodexHarnessProgress = Schema.encodeSync(
  CodexHarnessProgressJson,
);

export const parseCodexHarnessProgressJson = Schema.decodeUnknownSync(
  CodexHarnessProgressJson,
);

export class CodexHarnessConfig extends Schema.Class<CodexHarnessConfig>(
  "CodexHarnessConfig",
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

export type CodexHarnessConfigInput = {
  readonly command?: string | undefined;
  readonly extraArgs?: ReadonlyArray<string> | undefined;
  readonly model?: string | undefined;
  readonly profile?: string | undefined;
  readonly sandbox?: string | undefined;
  readonly timeoutMs?: number | string | undefined;
};

export function makeCodexHarnessConfig(
  input: CodexHarnessConfigInput = {},
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

export type CodexCommandInput = {
  readonly args: ReadonlyArray<string>;
  readonly command: CodexCommand;
  readonly cwd: string;
  readonly progressPath?: string | undefined;
  readonly recordProgress?: CodexCommandProgressRecorder | undefined;
  readonly stdin: string;
  readonly timeoutMs: CodexCommandTimeoutMs;
};

export type CodexCommandOutputObservation = {
  readonly bytes: number;
  readonly stream: CodexCommandOutputStream;
};

export type CodexCommandProgressRecorder = (
  observation: CodexCommandOutputObservation,
) => Promise<void>;

export type CodexCommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

export type CodexCommandRunner = (
  input: CodexCommandInput,
) => Effect.Effect<
  CodexCommandResult,
  GaiaRuntimeError | PlatformError,
  FileSystem.FileSystem | Path.Path
>;

export type CodexHarnessOptions = {
  readonly commandRunner?: CodexCommandRunner;
  readonly config: CodexHarnessConfig;
};

export type CodexHarnessPromptInput = {
  readonly resolvedSkillPaths: ReadonlyArray<string>;
  readonly runId: string;
  readonly skillBundlePath: string;
  readonly specBody: string;
  readonly specTitle: string;
  readonly workspaceOutputPath: string;
  readonly workspacePath: string;
};

export type CodexCommandArgsInput = {
  readonly config: CodexHarnessConfig;
  readonly lastMessagePath: string;
  readonly workspacePath: string;
};

export const nodeCodexCommandRunner: CodexCommandRunner = (input) =>
  Effect.tryPromise({
    try: () =>
      new Promise<CodexCommandResult>((resolve, reject) => {
        const pendingProgressWrites = new Set<Promise<void>>();
        const observeOutput = (
          stream: CodexCommandOutputStream,
          chunk: Buffer | string,
        ) => {
          const bytes = Buffer.byteLength(chunk);
          if (bytes === 0 || input.recordProgress === undefined) {
            return;
          }

          const recordProgress = input.recordProgress;
          const pending = Promise.resolve()
            .then(() => recordProgress({ bytes, stream }))
            .finally(() => pendingProgressWrites.delete(pending));
          pendingProgressWrites.add(pending);
        };
        const settleAfterProgressWrites = (
          complete: () => void,
          fail: (cause: unknown) => void,
        ) => {
          Promise.allSettled([...pendingProgressWrites]).then((results) => {
            const rejected = results.find(
              (result) => result.status === "rejected",
            );
            if (rejected?.status === "rejected") {
              fail(rejected.reason);
              return;
            }

            complete();
          }, fail);
        };
        const child = execFile(
          input.command,
          [...input.args],
          {
            cwd: input.cwd,
            maxBuffer: codexCommandMaxBufferBytes,
            timeout: input.timeoutMs,
          },
          (error, stdout, stderr) => {
            if (error !== null && error.code === "ENOENT") {
              settleAfterProgressWrites(
                () => reject(error),
                (cause) => reject(cause),
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
                (cause) => reject(cause),
              );
              return;
            }

            settleAfterProgressWrites(
              () =>
                resolve({
                  exitCode: normalizeExitCode(error?.code),
                  stderr: String(stderr),
                  stdout: String(stdout),
                }),
              (cause) => reject(cause),
            );
          },
        );
        child.stdout?.on("data", (chunk: Buffer | string) =>
          observeOutput("stdout", chunk),
        );
        child.stderr?.on("data", (chunk: Buffer | string) =>
          observeOutput("stderr", chunk),
        );
        child.stdin?.end(input.stdin);
      }),
    catch: (cause) =>
      cause instanceof GaiaRuntimeError
        ? cause
        : makeRuntimeError({
            cause,
            code: codexCommandFailureCode(cause),
            message: codexCommandFailureMessage(input.command, cause),
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

function formatResolvedSkillPaths(
  resolvedSkillPaths: ReadonlyArray<string>,
) {
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
    ...(input.config.model === undefined ? [] : ["--model", input.config.model]),
    ...(input.config.profile === undefined
      ? []
      : ["--profile", input.config.profile]),
    ...input.config.extraArgs,
    "-",
  ];
}

function parseCodexCommandTimeoutInput(
  input: CodexHarnessConfigInput["timeoutMs"],
) {
  if (input === undefined) {
    return parseCodexCommandTimeoutMs(defaultCodexCommandTimeoutMs);
  }

  if (typeof input === "string") {
    return parseCodexCommandTimeoutMs(
      Schema.decodeUnknownSync(Schema.NumberFromString)(input),
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
