import { Effect, FileSystem, Path, Schema } from "effect";
import { execFile } from "node:child_process";
import type { PlatformError } from "effect/PlatformError";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";

const codexCommandMaxBufferBytes = 10 * 1024 * 1024;
const defaultCodexCommand = "codex";
const defaultCodexSandbox = "workspace-write";

export const CodexCommandSchema = Schema.NonEmptyString.pipe(
  Schema.brand("CodexCommand"),
);

export type CodexCommand = typeof CodexCommandSchema.Type;

export const CodexSandboxModeSchema = Schema.Literals([
  "read-only",
  "workspace-write",
] as const);

export type CodexSandboxMode = typeof CodexSandboxModeSchema.Type;

export class CodexHarnessConfig extends Schema.Class<CodexHarnessConfig>(
  "CodexHarnessConfig",
)({
  command: CodexCommandSchema,
  extraArgs: Schema.Array(Schema.String),
  model: Schema.optionalKey(Schema.NonEmptyString),
  profile: Schema.optionalKey(Schema.NonEmptyString),
  sandbox: CodexSandboxModeSchema,
}) {}

export const parseCodexHarnessConfig =
  Schema.decodeUnknownSync(CodexHarnessConfig);

export type CodexHarnessConfigInput = {
  readonly command?: string | undefined;
  readonly extraArgs?: ReadonlyArray<string> | undefined;
  readonly model?: string | undefined;
  readonly profile?: string | undefined;
  readonly sandbox?: string | undefined;
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
  });
}

export type CodexCommandInput = {
  readonly args: ReadonlyArray<string>;
  readonly command: CodexCommand;
  readonly cwd: string;
  readonly stdin: string;
};

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
  readonly runId: string;
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
        const child = execFile(
          input.command,
          [...input.args],
          {
            cwd: input.cwd,
            maxBuffer: codexCommandMaxBufferBytes,
          },
          (error, stdout, stderr) => {
            if (error !== null && error.code === "ENOENT") {
              reject(error);
              return;
            }

            if (error !== null && error.code === undefined) {
              reject(error);
              return;
            }

            resolve({
              exitCode: normalizeExitCode(error?.code),
              stderr: String(stderr),
              stdout: String(stdout),
            });
          },
        );
        child.stdin?.end(input.stdin);
      }),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: isErrorWithCode(cause, "ENOENT")
          ? "CodexCommandMissing"
          : "CodexCommandFailed",
        message: isErrorWithCode(cause, "ENOENT")
          ? `Codex command '${input.command}' was not found.`
          : `Codex command '${input.command}' failed.`,
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
    "Required output contract:",
    "- Make the smallest useful workspace change needed for the spec.",
    `- Write a concise final worker result to ${input.workspaceOutputPath}.`,
    "- From the current working directory, that artifact is ./output.txt.",
    "- Do not create a nested workspace/ directory.",
    "- Include the run id in ./output.txt.",
    "- Do not write outside the workspace.",
  ].join("\n\n");
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

function isErrorWithCode(error: unknown, code: string) {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  return Reflect.get(error, "code") === code;
}
