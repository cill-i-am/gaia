import { spawn } from "node:child_process";

import { Context, Effect, Layer, Schema } from "effect";

const DockerSandboxCliTextSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(4_096))
);
export const DockerSandboxCliCommandSchema = Schema.Struct({
  args: Schema.Array(DockerSandboxCliTextSchema),
  executable: Schema.NonEmptyString,
});
export type DockerSandboxCliCommand = Schema.Schema.Type<
  typeof DockerSandboxCliCommandSchema
>;

export const DockerSandboxCliResultSchema = Schema.Struct({
  exitCode: Schema.Int,
  stderr: Schema.String,
  stdout: Schema.String,
});
export type DockerSandboxCliResult = Schema.Schema.Type<
  typeof DockerSandboxCliResultSchema
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
  const run = (args: ReadonlyArray<string>) => runner({ args, executable });
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
      run(["exec", "--workdir", input.workdir, input.name, ...input.argv]),
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
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    const child = spawn(command.executable, [...command.args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const append = (current: Buffer, chunk: Buffer) => {
      const remaining = Math.max(
        0,
        1_048_576 - stdout.byteLength - stderr.byteLength
      );
      if (chunk.byteLength > remaining) overflow = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      if (overflow && child.exitCode === null) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      if (overflow && child.exitCode === null) child.kill("SIGTERM");
    });
    child.once("error", (cause) =>
      resume(
        Effect.fail(
          new DockerSandboxCliSpawnError({
            cause,
            command,
            message: "Docker Sandbox CLI could not be spawned.",
          })
        )
      )
    );
    child.once("close", (code) =>
      resume(
        overflow
          ? Effect.fail(
              new DockerSandboxCliSpawnError({
                command,
                message: "Docker Sandbox CLI output exceeded its host cap.",
              })
            )
          : Effect.succeed({
              exitCode: code ?? 125,
              stderr: stderr.toString("utf8"),
              stdout: stdout.toString("utf8"),
            })
      )
    );
    return Effect.sync(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
  });
