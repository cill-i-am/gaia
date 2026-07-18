import { execFile } from "node:child_process";

import { Effect, FileSystem, Path, Schema } from "effect";
import { chromium } from "playwright";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import {
  makeRunStorePaths,
  parseRuntimePath,
  type RunStorageOptions,
  type RuntimePath,
} from "./paths.js";

export const DoctorCheckNameSchema = Schema.Literals([
  "codex-cli",
  "gaia-store-writable",
  "gh-auth",
  "git-repository",
  "git-worktree",
  "playwright-browser",
] as const);

export type DoctorCheckName = typeof DoctorCheckNameSchema.Type;

export const DoctorCheckStatusSchema = Schema.Literals([
  "failed",
  "passed",
  "warning",
] as const);

export type DoctorCheckStatus = typeof DoctorCheckStatusSchema.Type;

export const DoctorStatusSchema = Schema.Literals([
  "failed",
  "healthy",
  "warnings",
] as const);

export type DoctorStatus = typeof DoctorStatusSchema.Type;

export class DoctorCheck extends Schema.Class<DoctorCheck>("DoctorCheck")({
  detail: Schema.NonEmptyString,
  name: DoctorCheckNameSchema,
  status: DoctorCheckStatusSchema,
}) {}

export class DoctorSummary extends Schema.Class<DoctorSummary>("DoctorSummary")(
  {
    checks: Schema.Array(DoctorCheck),
    status: DoctorStatusSchema,
  }
) {}

export const DoctorCommandInputSchema = Schema.Struct({
  args: Schema.Array(Schema.String),
  command: Schema.NonEmptyString,
  cwd: Schema.NonEmptyString,
});

export type DoctorCommandInput = typeof DoctorCommandInputSchema.Type;

export const parseDoctorCommandInput = Schema.decodeUnknownSync(
  DoctorCommandInputSchema
);

export const DoctorCommandResultSchema = Schema.Struct({
  exitCode: Schema.Number,
  stderr: Schema.String,
  stdout: Schema.String,
});

export type DoctorCommandResult = typeof DoctorCommandResultSchema.Type;

export const parseDoctorCommandResult = Schema.decodeUnknownSync(
  DoctorCommandResultSchema
);

export type DoctorCommandRunner = (
  input: DoctorCommandInput
) => Effect.Effect<DoctorCommandResult, GaiaRuntimeError>;

export type DoctorBrowserInspector = () => Effect.Effect<
  boolean,
  GaiaRuntimeError,
  FileSystem.FileSystem
>;

export type DoctorOptions = RunStorageOptions & {
  readonly browserInspector?: DoctorBrowserInspector;
  readonly commandRunner?: DoctorCommandRunner;
};

/** Inspect local Gaia prerequisites without mutating external systems. */
export function doctor(options: DoctorOptions = {}) {
  return Effect.gen(function* () {
    const rootDirectory = parseRuntimePath(options.rootDirectory ?? ".");
    const runner = options.commandRunner ?? nodeDoctorCommandRunner;
    const browserInspector =
      options.browserInspector ?? nodePlaywrightBrowserInspector;
    const checks = [
      yield* checkRunStoreWritable(rootDirectory),
      yield* checkGitRepository(rootDirectory, runner),
      yield* checkGitWorktree(rootDirectory, runner),
      yield* checkGitHubAuth(rootDirectory, runner),
      yield* checkCodexCli(rootDirectory, runner),
      yield* checkPlaywrightBrowser(browserInspector),
    ];

    return DoctorSummary.make({
      checks,
      status: doctorStatus(checks),
    });
  });
}

export const nodeDoctorCommandRunner: DoctorCommandRunner = (input) =>
  Effect.tryPromise({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "DoctorCommandFailed",
        message: `Gaia could not execute '${input.command}' for doctor checks.`,
        recoverable: true,
      }),
    try: () =>
      new Promise<DoctorCommandResult>((resolve) => {
        execFile(
          input.command,
          [...input.args],
          { cwd: input.cwd },
          (error, stdout, stderr) => {
            const exitCode =
              error === null
                ? 0
                : typeof error.code === "number"
                  ? error.code
                  : 1;
            resolve(
              parseDoctorCommandResult({
                exitCode,
                stderr,
                stdout,
              })
            );
          }
        );
      }),
  }).pipe(
    Effect.catchTag("GaiaRuntimeError", () =>
      Effect.succeed(
        parseDoctorCommandResult({
          exitCode: 1,
          stderr: "",
          stdout: "",
        })
      )
    )
  );

export const nodePlaywrightBrowserInspector: DoctorBrowserInspector = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const executablePath = chromium.executablePath();
    return yield* fs.exists(executablePath);
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "PlaywrightBrowserInspectFailed",
          message: "Gaia could not inspect Playwright Chromium.",
          recoverable: true,
        })
      )
    )
  );

function runDoctorCommand(
  runner: DoctorCommandRunner,
  input: DoctorCommandInput
) {
  return runner(parseDoctorCommandInput(input)).pipe(
    Effect.map(parseDoctorCommandResult)
  );
}

function checkRunStoreWritable(rootDirectory: RuntimePath) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* makeRunStorePaths({ rootDirectory });
    const doctorDirectory = path.join(store.gaiaRoot, "doctor");
    const marker = path.join(doctorDirectory, "write-check.txt");

    yield* fs.makeDirectory(doctorDirectory, { recursive: true });
    yield* fs.writeFileString(marker, "ok\n");
    yield* fs.remove(doctorDirectory, { recursive: true });

    return DoctorCheck.make({
      detail: ".gaia is writable.",
      name: "gaia-store-writable",
      status: "passed",
    });
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.succeed(
        DoctorCheck.make({
          detail: `Gaia could not write to .gaia: ${safeCauseMessage(cause)}`,
          name: "gaia-store-writable",
          status: "failed",
        })
      )
    )
  );
}

function checkGitRepository(
  rootDirectory: RuntimePath,
  runner: DoctorCommandRunner
) {
  return runDoctorCommand(runner, {
    args: ["rev-parse", "--is-inside-work-tree"],
    command: "git",
    cwd: rootDirectory,
  }).pipe(
    Effect.map((result) =>
      result.exitCode === 0 && result.stdout.trim() === "true"
        ? DoctorCheck.make({
            detail: "Current directory is inside a git repository.",
            name: "git-repository",
            status: "passed",
          })
        : DoctorCheck.make({
            detail:
              "Current directory is not inside a git repository; GitHub PR workflows will be unavailable.",
            name: "git-repository",
            status: "warning",
          })
    )
  );
}

function checkGitHubAuth(
  rootDirectory: RuntimePath,
  runner: DoctorCommandRunner
) {
  return runDoctorCommand(runner, {
    args: ["auth", "status"],
    command: "gh",
    cwd: rootDirectory,
  }).pipe(
    Effect.map((result) =>
      result.exitCode === 0
        ? DoctorCheck.make({
            detail: "GitHub CLI is authenticated.",
            name: "gh-auth",
            status: "passed",
          })
        : DoctorCheck.make({
            detail:
              "GitHub CLI is missing or not authenticated; PR publish/comment/check workflows will be unavailable.",
            name: "gh-auth",
            status: "warning",
          })
    )
  );
}

function checkGitWorktree(
  rootDirectory: RuntimePath,
  runner: DoctorCommandRunner
) {
  return runDoctorCommand(runner, {
    args: ["worktree", "list", "--porcelain"],
    command: "git",
    cwd: rootDirectory,
  }).pipe(
    Effect.map((result) =>
      result.exitCode === 0
        ? DoctorCheck.make({
            detail: "Git worktrees are supported in this repository.",
            name: "git-worktree",
            status: "passed",
          })
        : DoctorCheck.make({
            detail: gitWorktreeWarningDetail(result),
            name: "git-worktree",
            status: "warning",
          })
    )
  );
}

function checkCodexCli(
  rootDirectory: RuntimePath,
  runner: DoctorCommandRunner
) {
  return runDoctorCommand(runner, {
    args: ["--version"],
    command: "codex",
    cwd: rootDirectory,
  }).pipe(
    Effect.map((result) =>
      result.exitCode === 0
        ? DoctorCheck.make({
            detail: "Codex CLI is available.",
            name: "codex-cli",
            status: "passed",
          })
        : DoctorCheck.make({
            detail:
              "Codex CLI is missing or unavailable; Codex harness/reviewer workflows will be unavailable.",
            name: "codex-cli",
            status: "warning",
          })
    )
  );
}

function checkPlaywrightBrowser(inspector: DoctorBrowserInspector) {
  return Effect.gen(function* () {
    const browserExists = yield* inspector();

    return browserExists
      ? DoctorCheck.make({
          detail: "Playwright Chromium browser is installed.",
          name: "playwright-browser",
          status: "passed",
        })
      : DoctorCheck.make({
          detail:
            "Playwright Chromium browser was not found; browser evidence capture may fail.",
          name: "playwright-browser",
          status: "warning",
        });
  }).pipe(
    Effect.catchTag("GaiaRuntimeError", (cause) =>
      Effect.succeed(
        DoctorCheck.make({
          detail: `Gaia could not inspect Playwright Chromium: ${cause.message}`,
          name: "playwright-browser",
          status: "warning",
        })
      )
    )
  );
}

function doctorStatus(checks: ReadonlyArray<DoctorCheck>): DoctorStatus {
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }

  if (checks.some((check) => check.status === "warning")) {
    return "warnings";
  }

  return "healthy";
}

function safeCauseMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "unknown error";
}

function gitWorktreeWarningDetail(result: DoctorCommandResult) {
  const output = [result.stderr, result.stdout].join("\n").toLowerCase();

  if (output.includes("not a git repository")) {
    return "Git worktree readiness could not be confirmed because the current directory is not inside a git repository. Workspace PR workflows will be unavailable.";
  }

  if (
    output.includes("'worktree' is not a git command") ||
    output.includes("unknown subcommand: worktree")
  ) {
    return "Git worktree readiness could not be confirmed because this Git installation does not support worktree commands. Workspace PR workflows will be unavailable.";
  }

  return "Git worktree readiness could not be confirmed. Workspace PR workflows will be unavailable.";
}
