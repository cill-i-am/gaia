import { RunIdSchema, type RunId } from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { HarnessRunResult } from "./harness.js";
import { runRelative, type RunPaths } from "./paths.js";

const maxReviewableWorkerResultBytes = 64 * 1024;
const runIdAsExpressionPattern = /\bas\s+RunId\b/u;
const workspaceArtifactPrefix = "workspace/";
const sourceFileExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const NonNegativeIntegerSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
);

export const WorkspacePrQualityGateSeveritySchema = Schema.Literals([
  "pass",
  "warn",
  "fail",
] as const);

export type WorkspacePrQualityGateSeverity =
  typeof WorkspacePrQualityGateSeveritySchema.Type;

export class WorkspacePrQualityGateItem extends Schema.Class<WorkspacePrQualityGateItem>(
  "WorkspacePrQualityGateItem",
)({
  changedFiles: Schema.Array(Schema.NonEmptyString),
  check: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
  remediation: Schema.NonEmptyString,
  severity: WorkspacePrQualityGateSeveritySchema,
}) {}

export class WorkspacePrQualityGate extends Schema.Class<WorkspacePrQualityGate>(
  "WorkspacePrQualityGate",
)({
  artifactPath: Schema.NonEmptyString,
  failItemCount: NonNegativeIntegerSchema,
  items: Schema.Array(WorkspacePrQualityGateItem),
  runId: RunIdSchema,
  status: Schema.Literals(["passed", "blocked"] as const),
  version: Schema.Literal(1),
  warnItemCount: NonNegativeIntegerSchema,
}) {}

const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const parseHarnessRunResultJson = Schema.decodeUnknownSync(
  HarnessRunResultJson,
);
const WorkspacePrQualityGateJson = Schema.toCodecJson(WorkspacePrQualityGate);
const encodeWorkspacePrQualityGateJson = Schema.encodeSync(
  WorkspacePrQualityGateJson,
);
export const parseWorkspacePrQualityGateJson = Schema.decodeUnknownSync(
  WorkspacePrQualityGateJson,
);

type JsonDecodeResult =
  | {
      readonly _tag: "Invalid";
      readonly message: string;
    }
  | {
      readonly _tag: "Valid";
      readonly value: unknown;
    };

type HarnessDecodeResult =
  | {
      readonly _tag: "Invalid";
      readonly message: string;
    }
  | {
      readonly _tag: "Valid";
      readonly value: HarnessRunResult;
    };

export function evaluateWorkspacePrQualityGate(
  runId: RunId,
  paths: RunPaths,
): Effect.Effect<WorkspacePrQualityGate, GaiaRuntimeError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const items: Array<WorkspacePrQualityGateItem> = [];
    const workerResultExists = yield* fs.exists(paths.workerResult).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "WorkspacePrQualityGateReadFailed",
            message: "Gaia could not inspect workspace PR quality gate inputs.",
            recoverable: true,
          }),
        ),
      ),
    );

    if (!workerResultExists) {
      items.push(
        gateItem({
          changedFiles: ["worker-result.json"],
          check: "worker-result-present",
          reason: "worker-result.json is missing, so Gaia cannot review the workspace PR payload.",
          remediation: "Rerun the Gaia task to regenerate worker-result.json before publishing a workspace PR.",
          severity: "fail",
        }),
      );
      return yield* writeWorkspacePrQualityGate(runId, paths, items);
    }

    const workerResultBytes = yield* fileSizeBytes(paths.workerResult);
    if (workerResultBytes > maxReviewableWorkerResultBytes) {
      items.push(
        gateItem({
          changedFiles: ["worker-result.json"],
          check: "worker-result-reviewable-size",
          reason: `worker-result.json is ${workerResultBytes} bytes, above the ${maxReviewableWorkerResultBytes} byte reviewability limit.`,
          remediation: "Rerun with bounded workspaceDiff evidence instead of listing generated or noisy paths in worker-result.json.",
          severity: "fail",
        }),
      );
    }

    const rawWorkerResult = yield* fs.readFileString(paths.workerResult).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "WorkspacePrQualityGateReadFailed",
            message: "Gaia could not read worker-result.json for the workspace PR quality gate.",
            recoverable: true,
          }),
        ),
      ),
    );
    const parsedJson = parseJson(rawWorkerResult);

    if (parsedJson._tag === "Invalid") {
      items.push(
        gateItem({
          changedFiles: ["worker-result.json"],
          check: "worker-result-json",
          reason: `worker-result.json is not valid JSON: ${parsedJson.message}.`,
          remediation: "Fix the harness so worker-result.json is valid JSON, then rerun Gaia before publishing.",
          severity: "fail",
        }),
      );
      return yield* writeWorkspacePrQualityGate(runId, paths, items);
    }

    const harnessResult = decodeHarnessResult(parsedJson.value);
    if (harnessResult._tag === "Invalid") {
      items.push(
        gateItem({
          changedFiles: ["worker-result.json"],
          check: "worker-result-schema",
          reason: `worker-result.json does not match Gaia's harness result schema: ${harnessResult.message}.`,
          remediation: "Fix the harness result contract and rerun Gaia so workspaceDiff evidence is schema-valid.",
          severity: "fail",
        }),
      );
      return yield* writeWorkspacePrQualityGate(runId, paths, items);
    }

    const workspaceDiff = harnessResult.value.workspaceDiff;
    if (workspaceDiff === undefined) {
      items.push(
        gateItem({
          changedFiles: ["worker-result.json"],
          check: "workspace-diff-present",
          reason: "worker-result.json does not include normalized workspaceDiff evidence.",
          remediation: "Rerun the Gaia task with the current runtime so changed files are recorded in workspaceDiff.",
          severity: "fail",
        }),
      );
      return yield* writeWorkspacePrQualityGate(runId, paths, items);
    }

    items.push(
      gateItem({
        changedFiles: workspaceDiff.productChangedPaths,
        check: "workspace-diff-reviewable",
        reason: `workspaceDiff reports ${workspaceDiff.productChangedPathCount} reviewable product changed file(s).`,
        remediation: "No action required.",
        severity: "pass",
      }),
    );

    const unsafeProductChangedPaths = unsafeRelativePaths(
      workspaceDiff.productChangedPaths,
    );
    if (unsafeProductChangedPaths.length > 0) {
      items.push(
        gateItem({
          changedFiles: unsafeProductChangedPaths,
          check: "workspace-diff-product-safe-paths",
          reason: "workspaceDiff productChangedPaths contains paths that are not safe relative workspace paths.",
          remediation: "Emit workspaceDiff paths relative to the workspace root without absolute paths or parent-directory segments.",
          severity: "fail",
        }),
      );
    }

    const unsafeGeneratedPaths = unsafeRelativePaths(
      workspaceDiff.omittedGeneratedPaths.map((entry) => entry.path),
    );
    if (unsafeGeneratedPaths.length > 0) {
      items.push(
        gateItem({
          changedFiles: unsafeGeneratedPaths,
          check: "workspace-diff-generated-safe-paths",
          reason: "workspaceDiff omittedGeneratedPaths contains paths that are not safe relative workspace paths.",
          remediation: "Emit generated path summaries relative to the workspace root without absolute paths or parent-directory segments.",
          severity: "fail",
        }),
      );
    }

    const unsafeChangedWorkspacePaths = unsafeRelativePaths(
      harnessResult.value.changedWorkspacePaths,
    );
    if (unsafeChangedWorkspacePaths.length > 0) {
      items.push(
        gateItem({
          changedFiles: unsafeChangedWorkspacePaths,
          check: "changed-workspace-safe-paths",
          reason: "changedWorkspacePaths contains paths that are not safe relative workspace paths.",
          remediation: "Emit changedWorkspacePaths relative to the workspace root without absolute paths or parent-directory segments.",
          severity: "fail",
        }),
      );
    }

    const unsafeOutputArtifactPaths = unsafeOutputArtifacts(
      harnessResult.value.outputArtifacts,
    );
    if (unsafeOutputArtifactPaths.length > 0) {
      items.push(
        gateItem({
          changedFiles: unsafeOutputArtifactPaths,
          check: "output-artifact-safe-paths",
          reason: "outputArtifacts contains workspace artifact paths that are not safe relative paths.",
          remediation: "Emit outputArtifacts as safe run-relative paths such as workspace/output.txt.",
          severity: "fail",
        }),
      );
    }

    if (workspaceDiff.omittedGeneratedPathCount > 0) {
      items.push(
        gateItem({
          changedFiles: workspaceDiff.omittedGeneratedPaths.map(
            (entry) => entry.path,
          ),
          check: "generated-paths-summarized",
          reason: `workspaceDiff summarizes ${workspaceDiff.omittedGeneratedFileCount} generated file(s) under ${workspaceDiff.omittedGeneratedPathCount} generated path(s).`,
          remediation: "Inspect the local .gaia workspace artifacts if needed; publish only if the source changes explain the generated output.",
          severity: "warn",
        }),
      );
    }

    const runIdCastFiles = yield* changedSourceFilesContainingRunIdCast(
      paths,
      workspaceDiff.productChangedPaths,
    );
    if (runIdCastFiles.length > 0) {
      items.push(
        gateItem({
          changedFiles: runIdCastFiles,
          check: "run-id-brand-cast",
          reason: "Changed source casts a value with `as RunId`, bypassing the RunId parser/brand boundary.",
          remediation: "Use parseRunId or RunIdSchema decoding at the boundary and carry the parsed RunId inward.",
          severity: "fail",
        }),
      );
    }

    return yield* writeWorkspacePrQualityGate(runId, paths, items);
  });
}

function writeWorkspacePrQualityGate(
  runId: RunId,
  paths: RunPaths,
  items: ReadonlyArray<WorkspacePrQualityGateItem>,
): Effect.Effect<WorkspacePrQualityGate, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const failItemCount = items.filter((item) => item.severity === "fail").length;
    const warnItemCount = items.filter((item) => item.severity === "warn").length;
    const gate = WorkspacePrQualityGate.make({
      artifactPath: runRelative(paths, paths.workspacePrGate),
      failItemCount,
      items,
      runId,
      status: failItemCount > 0 ? "blocked" : "passed",
      version: 1,
      warnItemCount,
    });

    yield* fs.writeFileString(
      paths.workspacePrGate,
      `${JSON.stringify(encodeWorkspacePrQualityGateJson(gate), null, 2)}\n`,
    );

    return gate;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "WorkspacePrQualityGateWriteFailed",
          message: "Gaia could not write workspace-pr-gate.json.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function fileSizeBytes(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path);
    return Number(info.size);
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "WorkspacePrQualityGateReadFailed",
          message: "Gaia could not inspect worker-result.json size for the workspace PR quality gate.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function parseJson(input: string): JsonDecodeResult {
  try {
    return { _tag: "Valid", value: JSON.parse(input) };
  } catch (cause) {
    return {
      _tag: "Invalid",
      message: errorMessage(cause),
    };
  }
}

function decodeHarnessResult(input: unknown): HarnessDecodeResult {
  try {
    return { _tag: "Valid", value: parseHarnessRunResultJson(input) };
  } catch (cause) {
    return {
      _tag: "Invalid",
      message: errorMessage(cause),
    };
  }
}

function changedSourceFilesContainingRunIdCast(
  paths: RunPaths,
  changedPaths: ReadonlyArray<string>,
) {
  return Effect.gen(function* () {
    const matches: Array<string> = [];

    for (const changedPath of changedPaths) {
      if (!isSafeRelativePath(changedPath) || !isSourceFile(changedPath)) {
        continue;
      }

      const fileContents = yield* readWorkspaceSourceFile(paths, changedPath);
      if (
        fileContents !== undefined &&
        containsRunIdAsExpression(fileContents)
      ) {
        matches.push(changedPath);
      }
    }

    return matches;
  });
}

function readWorkspaceSourceFile(
  paths: RunPaths,
  changedPath: string,
): Effect.Effect<string | undefined, GaiaRuntimeError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolutePath = path.join(paths.workspace, changedPath);
    const exists = yield* fs.exists(absolutePath);

    if (!exists) {
      return undefined;
    }

    const info = yield* fs.stat(absolutePath);
    if (info.type !== "File") {
      return undefined;
    }

    return yield* fs.readFileString(absolutePath);
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "WorkspacePrQualityGateReadFailed",
          message: `Gaia could not read changed source file '${changedPath}' for the workspace PR quality gate.`,
          recoverable: true,
        }),
      ),
    ),
  );
}

function isSafeRelativePath(input: string) {
  if (
    input.length === 0 ||
    input.startsWith("/") ||
    input.includes("\0") ||
    input.includes("\\")
  ) {
    return false;
  }

  const segments = input.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function unsafeRelativePaths(paths: ReadonlyArray<string>) {
  return paths.filter((path) => !isSafeRelativePath(path));
}

function unsafeOutputArtifacts(paths: ReadonlyArray<string>) {
  return paths.filter((artifactPath) => {
    if (!isSafeRelativePath(artifactPath)) {
      return true;
    }

    if (!artifactPath.startsWith(workspaceArtifactPrefix)) {
      return false;
    }

    return !isSafeRelativePath(artifactPath.slice(workspaceArtifactPrefix.length));
  });
}

function isSourceFile(input: string) {
  for (const extension of sourceFileExtensions) {
    if (input.endsWith(extension)) {
      return true;
    }
  }

  return false;
}

function containsRunIdAsExpression(input: string) {
  return runIdAsExpressionPattern.test(stripCommentsAndStrings(input));
}

function stripCommentsAndStrings(input: string) {
  let output = "";
  let state:
    | "blockComment"
    | "code"
    | "doubleQuote"
    | "lineComment"
    | "singleQuote"
    | "template" = "code";
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] ?? "";
    const nextCharacter = input[index + 1] ?? "";

    switch (state) {
      case "code": {
        if (character === "/" && nextCharacter === "/") {
          output += "  ";
          index += 1;
          state = "lineComment";
          continue;
        }

        if (character === "/" && nextCharacter === "*") {
          output += "  ";
          index += 1;
          state = "blockComment";
          continue;
        }

        if (character === "'") {
          output += " ";
          state = "singleQuote";
          escaped = false;
          continue;
        }

        if (character === '"') {
          output += " ";
          state = "doubleQuote";
          escaped = false;
          continue;
        }

        if (character === "`") {
          output += " ";
          state = "template";
          escaped = false;
          continue;
        }

        output += character;
        continue;
      }

      case "lineComment": {
        if (character === "\n") {
          output += "\n";
          state = "code";
          continue;
        }

        output += " ";
        continue;
      }

      case "blockComment": {
        if (character === "*" && nextCharacter === "/") {
          output += "  ";
          index += 1;
          state = "code";
          continue;
        }

        output += character === "\n" ? "\n" : " ";
        continue;
      }

      case "singleQuote":
      case "doubleQuote":
      case "template": {
        const closingCharacter =
          state === "singleQuote"
            ? "'"
            : state === "doubleQuote"
              ? '"'
              : "`";

        if (escaped) {
          output += character === "\n" ? "\n" : " ";
          escaped = false;
          continue;
        }

        if (character === "\\") {
          output += " ";
          escaped = true;
          continue;
        }

        if (character === closingCharacter) {
          output += " ";
          state = "code";
          continue;
        }

        output += character === "\n" ? "\n" : " ";
        continue;
      }
    }
  }

  return output;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "unknown error";
}

function gateItem(input: {
  readonly changedFiles: ReadonlyArray<string>;
  readonly check: string;
  readonly reason: string;
  readonly remediation: string;
  readonly severity: WorkspacePrQualityGateSeverity;
}) {
  return WorkspacePrQualityGateItem.make({
    changedFiles: [...new Set(input.changedFiles)].toSorted(),
    check: input.check,
    reason: input.reason,
    remediation: input.remediation,
    severity: input.severity,
  });
}
