import { spawn } from "node:child_process";

import { Context, Effect, Layer, Schema } from "effect";

const DockerSandboxCliTextSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(4_096))
);
export const DockerSandboxCliCommandSchema = Schema.Struct({
  args: Schema.Array(DockerSandboxCliTextSchema),
  executable: Schema.NonEmptyString,
  outputLimitBytes: Schema.optionalKey(Schema.Int),
  timeoutMs: Schema.optionalKey(Schema.Int),
});
export type DockerSandboxCliCommand = Schema.Schema.Type<
  typeof DockerSandboxCliCommandSchema
>;

export const DockerSandboxCliResultSchema = Schema.Struct({
  exitCode: Schema.Int,
  stderrObservedByteCount: Schema.optionalKey(Schema.Int),
  stderr: Schema.String,
  stdoutObservedByteCount: Schema.optionalKey(Schema.Int),
  stdout: Schema.String,
  terminationReason: Schema.optionalKey(
    Schema.Literals(["interrupted", "outputLimitExceeded", "timedOut"] as const)
  ),
});
export type DockerSandboxCliResult = Schema.Schema.Type<
  typeof DockerSandboxCliResultSchema
>;
const DockerSandboxCliLimitsSchema = Schema.Struct({
  outputLimitBytes: Schema.optionalKey(Schema.Int),
  timeoutMs: Schema.optionalKey(Schema.Int),
});
type DockerSandboxCliLimits = Schema.Schema.Type<
  typeof DockerSandboxCliLimitsSchema
>;

export class DockerSandboxCliSpawnError extends Schema.TaggedErrorClass<DockerSandboxCliSpawnError>()(
  "DockerSandboxCliSpawnError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    command: DockerSandboxCliCommandSchema,
    message: Schema.NonEmptyString,
  }
) {}

export type DockerSandboxCliRunner = (
  command: DockerSandboxCliCommand
) => Effect.Effect<DockerSandboxCliResult, DockerSandboxCliSpawnError>;

export const DockerSandboxCreateInputSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  templateReference: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString,
});
export type DockerSandboxCreateInput = Schema.Schema.Type<
  typeof DockerSandboxCreateInputSchema
>;

export const DockerSandboxExecuteInputSchema = Schema.Struct({
  argv: Schema.Array(DockerSandboxCliTextSchema),
  name: Schema.NonEmptyString,
  outputLimitBytes: Schema.Int,
  timeoutMs: Schema.Int,
  workdir: Schema.NonEmptyString,
});
export type DockerSandboxExecuteInput = Schema.Schema.Type<
  typeof DockerSandboxExecuteInputSchema
>;

export class DockerSandboxCli extends Context.Service<
  DockerSandboxCli,
  ReturnType<typeof makeDockerSandboxCli>
>()("@gaia/runtime/DockerSandboxCli") {}

export function makeDockerSandboxCli(
  runner: DockerSandboxCliRunner,
  executable = "sbx"
) {
  const run = (
    args: ReadonlyArray<string>,
    limits: DockerSandboxCliLimits = {}
  ) => runner({ args, executable, ...limits });
  return {
    create: (input: DockerSandboxCreateInput) =>
      run([
        "create",
        "shell",
        input.workspace,
        "--name",
        input.name,
        "--template",
        input.templateReference,
        "--quiet",
      ]),
    execute: (input: DockerSandboxExecuteInput) =>
      run(["exec", "--workdir", input.workdir, input.name, ...input.argv], {
        outputLimitBytes: input.outputLimitBytes,
        timeoutMs: input.timeoutMs,
      }),
    inspect: (name: string) => run(["inspect", name, "--json"]),
    inspectAuthority: (name: string) => run(["inspect", name]),
    list: Effect.suspend(() => run(["ls", "--json"])),
    policyList: Effect.suspend(() => run(["policy", "ls", "--json"])),
    remove: (name: string) => run(["rm", "--force", name]),
    stop: (name: string) => run(["stop", name]),
    version: Effect.suspend(() => run(["version"])),
  } as const;
}
export type DockerSandboxCliService = ReturnType<typeof makeDockerSandboxCli>;

export function DockerSandboxCliLive(executable: string) {
  return Layer.succeed(
    DockerSandboxCli,
    DockerSandboxCli.of(
      makeDockerSandboxCli(nodeDockerSandboxCliRunner, executable)
    )
  );
}

export const nodeDockerSandboxCliRunner: DockerSandboxCliRunner = (command) =>
  Effect.callback((resume) => {
    const outputLimitBytes = command.outputLimitBytes ?? 1_048_576;
    const timeoutMs = command.timeoutMs ?? 30_000;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutObservedByteCount = 0;
    let stderrObservedByteCount = 0;
    let terminationReason:
      | "interrupted"
      | "outputLimitExceeded"
      | "timedOut"
      | undefined;
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command.executable, [...command.args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminate = (
      reason: "interrupted" | "outputLimitExceeded" | "timedOut"
    ) => {
      terminationReason ??= reason;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 1_000);
    };
    const timeout = setTimeout(() => terminate("timedOut"), timeoutMs);
    const append = (current: Buffer, chunk: Buffer) => {
      const remaining = Math.max(
        0,
        outputLimitBytes - stdout.byteLength - stderr.byteLength
      );
      if (chunk.byteLength > remaining) terminate("outputLimitExceeded");
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutObservedByteCount += chunk.byteLength;
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrObservedByteCount += chunk.byteLength;
      stderr = append(stderr, chunk);
    });
    child.once("error", (cause) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resume(
        Effect.fail(
          new DockerSandboxCliSpawnError({
            cause,
            command,
            message: "Docker Sandbox CLI could not be spawned.",
          })
        )
      );
    });
    child.once("close", (code) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      const observedTerminationReason =
        terminationReason ?? (code === null ? "interrupted" : undefined);
      resume(
        Effect.succeed({
          exitCode: code ?? 125,
          stderr: stderr.toString("utf8"),
          stderrObservedByteCount,
          stdout: stdout.toString("utf8"),
          stdoutObservedByteCount,
          ...(observedTerminationReason === undefined
            ? {}
            : { terminationReason: observedTerminationReason }),
        })
      );
    });
    return Effect.promise(() => {
      if (closed) return Promise.resolve();
      terminate("interrupted");
      return new Promise<void>((resolve) => {
        child.once("close", resolve);
      });
    });
  });
