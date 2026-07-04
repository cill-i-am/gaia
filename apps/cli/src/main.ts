#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CommandSummary } from "@gaia/runtime";
import { GaiaRuntimeError, listRuns, resumeRun, runSpecFile, statusRun } from "@gaia/runtime";
import path from "node:path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";

type FailureOutput = {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
  readonly status: "failed";
};

const specFile = Argument.string("spec-file");
const runId = Argument.string("run-id");
const optionalRunId = runId.pipe(Argument.optional);
const json = Flag.boolean("json").pipe(
  Flag.withDescription("Write a machine-readable JSON response."),
);

const run = Command.make("run", { json, specFile }).pipe(
  Command.withDescription("Start a new Gaia run from a Markdown spec."),
  Command.withHandler(({ json, specFile }) =>
    renderEffect(
      runSpecFile(resolveInvocationPath(specFile), workflowOptions()),
      json,
      renderSummary,
    ),
  ),
);

const resume = Command.make("resume", { json, runId }).pipe(
  Command.withDescription("Replay and validate an existing Gaia run."),
  Command.withHandler(({ json, runId }) =>
    renderEffect(resumeRun(runId, workflowOptions()), json, renderSummary),
  ),
);

const status = Command.make("status", { json, runId: optionalRunId }).pipe(
  Command.withDescription("Show the latest run status or a specific run status."),
  Command.withHandler(({ json, runId }) =>
    renderEffect(
      statusRun(Option.getOrUndefined(runId), workflowOptions()),
      json,
      renderSummary,
    ),
  ),
);

const list = Command.make("list", { json }).pipe(
  Command.withDescription("List known Gaia runs."),
  Command.withHandler(({ json }) =>
    renderEffect(listRuns(workflowOptions()), json, renderRunList),
  ),
);

const cli = Command.make("gaia").pipe(
  Command.withDescription("Gaia software-factory control plane prototype."),
  Command.withSubcommands([run, resume, status, list]),
);

const command = Command.run(cli, { version: "0.1.0" });

function invocationRoot() {
  return process.env["INIT_CWD"] ?? process.cwd();
}

function workflowOptions() {
  return { rootDirectory: invocationRoot() };
}

function resolveInvocationPath(input: string) {
  return path.resolve(invocationRoot(), input);
}

function renderEffect<A>(
  effect: Effect.Effect<A, unknown, NodeServices.NodeServices>,
  json: boolean,
  renderSuccess: (value: A) => string,
) {
  return effect.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.gen(function* () {
          const failure = failureOutput(error);
          yield* Console.log(
            json ? JSON.stringify(failure, null, 2) : renderFailure(failure),
          );
          yield* Effect.sync(() => {
            process.exitCode = 1;
          });
        }),
      onSuccess: (value) =>
        Console.log(
          json ? JSON.stringify(value, null, 2) : renderSuccess(value),
        ),
    }),
  );
}

function failureOutput(error: unknown): FailureOutput {
  if (error instanceof GaiaRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      recoverable: error.recoverable,
      status: "failed",
    };
  }

  if (error instanceof Error) {
    return {
      code: "UnexpectedFailure",
      message: error.message,
      recoverable: false,
      status: "failed",
    };
  }

  return {
    code: "UnexpectedFailure",
    message: "Gaia command failed.",
    recoverable: false,
    status: "failed",
  };
}

function renderFailure(failure: FailureOutput) {
  return [
    `Gaia command failed: ${failure.message}`,
    `code: ${failure.code}`,
    `recoverable: ${failure.recoverable}`,
  ].join("\n");
}

function renderSummary(summary: CommandSummary) {
  const reportLine =
    summary.reportPath === undefined ? undefined : `report: ${summary.reportPath}`;
  const lines = [
    `${summary.status === "completed" ? "completed" : summary.status}: ${summary.runId}`,
    `state: ${summary.state}`,
    `run: ${summary.runDirectory}`,
  ];

  return reportLine === undefined ? lines.join("\n") : [...lines, reportLine].join("\n");
}

function renderRunList(summaries: ReadonlyArray<CommandSummary>) {
  if (summaries.length === 0) {
    return "No Gaia runs found.";
  }

  return summaries
    .map((summary) => `${summary.runId} ${summary.status} ${summary.state}`)
    .join("\n");
}

command.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
