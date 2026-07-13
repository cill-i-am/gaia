import { RunIdSchema, type RunId } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { appendEvent } from "./event-store.js";
import {
  makeRunPaths,
  runRelative,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import { withRunStoreLock } from "./run-store-lock.js";
import { statusRun } from "./workflows.js";

const linearIssueIdentifierPattern = /^[A-Z][A-Z0-9]*-\d+$/u;

export const LinearIssueIdentifierSchema = Schema.NonEmptyString.pipe(
  Schema.refine(isLinearIssueIdentifier, {
    identifier: "LinearIssueIdentifier",
    message: "Expected a Linear issue identifier like GAI-123.",
  }),
  Schema.brand("LinearIssueIdentifier")
);

export type LinearIssueIdentifier = typeof LinearIssueIdentifierSchema.Type;

export const LinearIssueIdSchema = Schema.NonEmptyString.pipe(
  Schema.brand("LinearIssueId")
);

export type LinearIssueId = typeof LinearIssueIdSchema.Type;

export const LinearIssueUrlSchema = Schema.NonEmptyString.pipe(
  Schema.refine(isHttpUrl, {
    identifier: "LinearIssueUrl",
    message: "Expected an HTTP or HTTPS Linear issue URL.",
  }),
  Schema.brand("LinearIssueUrl")
);

export type LinearIssueUrl = typeof LinearIssueUrlSchema.Type;

const LinearIssueRelationCountSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
).pipe(Schema.brand("LinearIssueRelationCount"));

type LinearIssueRelationCount = typeof LinearIssueRelationCountSchema.Type;

export class LinearIssueReference extends Schema.Class<LinearIssueReference>(
  "LinearIssueReference"
)({
  id: Schema.optionalKey(LinearIssueIdSchema),
  identifier: LinearIssueIdentifierSchema,
  title: Schema.optionalKey(Schema.NonEmptyString),
  url: Schema.optionalKey(LinearIssueUrlSchema),
}) {}

export class LinearIssue extends Schema.Class<LinearIssue>("LinearIssue")({
  description: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(LinearIssueIdSchema),
  identifier: LinearIssueIdentifierSchema,
  status: Schema.optionalKey(Schema.NonEmptyString),
  title: Schema.NonEmptyString,
  url: Schema.optionalKey(LinearIssueUrlSchema),
}) {}

export class LinearIssueGraphInput extends Schema.Class<LinearIssueGraphInput>(
  "LinearIssueGraphInput"
)({
  blockedBy: Schema.Array(LinearIssueReference),
  blocks: Schema.Array(LinearIssueReference),
  issue: LinearIssue,
}) {}

export class LinearIssueGraph extends Schema.Class<LinearIssueGraph>(
  "LinearIssueGraph"
)({
  blockedBy: Schema.Array(LinearIssueReference),
  blocks: Schema.Array(LinearIssueReference),
  capturedAt: Schema.NonEmptyString,
  issue: LinearIssue,
  source: Schema.Literal("linear-json"),
  sourcePath: Schema.NonEmptyString,
  version: Schema.Literal(1),
}) {}

export class LinearIssueGraphSummary extends Schema.Class<LinearIssueGraphSummary>(
  "LinearIssueGraphSummary"
)({
  blockedByCount: LinearIssueRelationCountSchema,
  blocksCount: LinearIssueRelationCountSchema,
  graphPath: Schema.NonEmptyString,
  issueIdentifier: LinearIssueIdentifierSchema,
  issueTitle: Schema.NonEmptyString,
  issueUrl: Schema.optionalKey(LinearIssueUrlSchema),
  runId: RunIdSchema,
  sourcePath: Schema.NonEmptyString,
}) {}

const LinearIssueGraphJson = Schema.toCodecJson(LinearIssueGraph);
const encodeLinearIssueGraphJson = Schema.encodeSync(LinearIssueGraphJson);

/** Parse a persisted Linear issue graph artifact from decoded JSON. */
export const parseLinearIssueGraphJson =
  Schema.decodeUnknownSync(LinearIssueGraphJson);

/** Attach one Linear issue graph snapshot to a completed Gaia run. */
export function recordLinearIssueGraph(
  runIdInput: RunId,
  sourcePath: string,
  options: RunStorageOptions = {}
) {
  return withRunStoreLock(
    options,
    recordLinearIssueGraphUnlocked(runIdInput, sourcePath, options)
  );
}

function recordLinearIssueGraphUnlocked(
  runIdInput: RunId,
  sourcePath: string,
  options: RunStorageOptions
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const run = yield* statusRun(runIdInput, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before recording Linear issue graph evidence.`,
          recoverable: false,
        })
      );
    }

    const input = yield* readLinearIssueGraphInput(sourcePath);
    const graph = LinearIssueGraph.make({
      blockedBy: input.blockedBy,
      blocks: input.blocks,
      capturedAt: new Date().toISOString(),
      issue: input.issue,
      source: "linear-json",
      sourcePath,
      version: 1,
    });
    const paths = yield* makeRunPaths(run.runId, { rootDirectory });

    yield* writeLinearIssueGraph(paths, graph);

    const issueGraphPath = runRelative(paths, paths.linearIssueGraph);

    yield* appendEvent(run.runId, paths, {
      payload: {
        blockedByCount: graph.blockedBy.length,
        blocksCount: graph.blocks.length,
        issueGraphPath,
        issueIdentifier: graph.issue.identifier,
        ...(graph.issue.url === undefined ? {} : { issueUrl: graph.issue.url }),
      },
      type: "LINEAR_ISSUE_GRAPH_RECORDED",
    });

    return LinearIssueGraphSummary.make({
      blockedByCount: parseLinearIssueRelationCount(graph.blockedBy.length),
      blocksCount: parseLinearIssueRelationCount(graph.blocks.length),
      graphPath: paths.linearIssueGraph,
      issueIdentifier: graph.issue.identifier,
      issueTitle: graph.issue.title,
      ...(graph.issue.url === undefined ? {} : { issueUrl: graph.issue.url }),
      runId: run.runId,
      sourcePath,
    });
  });
}

function readLinearIssueGraphInput(sourcePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(sourcePath).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "LinearIssueGraphReadFailed",
            message: `Gaia could not read Linear issue graph input at ${sourcePath}.`,
            recoverable: true,
          })
        )
      )
    );
    const parsed = yield* parseJson(text, sourcePath);

    return yield* parseLinearIssueGraphInput(parsed);
  });
}

function writeLinearIssueGraph(
  paths: RunPaths,
  graph: LinearIssueGraph
): Effect.Effect<LinearIssueGraph, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* fs.writeFileString(
      paths.linearIssueGraph,
      `${JSON.stringify(encodeLinearIssueGraphJson(graph), null, 2)}\n`
    );

    return graph;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "LinearIssueGraphWriteFailed",
          message: "Gaia could not write the Linear issue graph artifact.",
          recoverable: true,
        })
      )
    )
  );
}

function parseLinearIssueGraphInput(input: unknown) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "LinearIssueGraphInvalid",
        message: "Linear issue graph input did not match the expected schema.",
        recoverable: false,
      }),
    try: () => Schema.decodeUnknownSync(LinearIssueGraphInput)(input),
  });
}

function parseJson(text: string, sourcePath: string) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "LinearIssueGraphJsonInvalid",
        message: `Linear issue graph input at ${sourcePath} is not valid JSON.`,
        recoverable: false,
      }),
    try: () => JSON.parse(text) as unknown,
  });
}

function parseLinearIssueRelationCount(
  count: number
): LinearIssueRelationCount {
  return Schema.decodeUnknownSync(LinearIssueRelationCountSchema)(count);
}

function isLinearIssueIdentifier(value: string): value is string {
  return linearIssueIdentifierPattern.test(value);
}

function isHttpUrl(value: string): value is string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
