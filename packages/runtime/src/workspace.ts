import {
  parseWorkspaceRelativePath,
  type WorkspaceRelativePath,
  WorkspaceRelativePathSchema,
} from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import {
  parseRuntimePath,
  RunRelativeArtifactPathSchema,
  RuntimePathSchema,
  type RunPaths,
  type RuntimePath,
} from "./paths.js";

const ignoredWorkspaceEntries = new Set([
  ".gaia",
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "gaia-runs",
  "node_modules",
]);

export const WorkspaceSourcePathSchema = RuntimePathSchema;

export type WorkspaceSourcePath = RuntimePath;

export const parseWorkspaceSourcePath = parseRuntimePath;

const WorkspaceSourceSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Empty") }),
  Schema.Struct({
    _tag: Schema.Literal("LocalDirectory"),
    path: WorkspaceSourcePathSchema,
  }),
]);

export type WorkspaceSource = typeof WorkspaceSourceSchema.Type;

export class WorkspacePreparationResult extends Schema.Class<WorkspacePreparationResult>(
  "WorkspacePreparationResult"
)({
  copiedFiles: Schema.Number.pipe(
    Schema.check(Schema.isInt({ identifier: "CopiedFiles" }))
  ),
  manifestPath: RunRelativeArtifactPathSchema,
  skippedEntries: Schema.Array(WorkspaceRelativePathSchema),
  source: Schema.Literals(["empty", "local-directory"] as const),
  sourcePath: Schema.optionalKey(RuntimePathSchema),
  workspacePath: RunRelativeArtifactPathSchema,
}) {
  static override make(input: unknown): WorkspacePreparationResult {
    return decodeWorkspacePreparationResult(input);
  }
}

const WorkspacePreparationResultJson = Schema.toCodecJson(
  WorkspacePreparationResult
);
const decodeWorkspacePreparationResult = Schema.decodeUnknownSync(
  WorkspacePreparationResult
);
const encodeWorkspacePreparationResult = Schema.encodeSync(
  WorkspacePreparationResultJson
);

export function emptyWorkspaceSource(): WorkspaceSource {
  return { _tag: "Empty" };
}

export function localDirectoryWorkspaceSource(input: string): WorkspaceSource {
  return {
    _tag: "LocalDirectory",
    path: parseWorkspaceSourcePath(input),
  };
}

export function prepareWorkspace(
  paths: RunPaths,
  source: WorkspaceSource = emptyWorkspaceSource()
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* fs.makeDirectory(paths.workspace, { recursive: true });

    const result =
      source._tag === "Empty"
        ? WorkspacePreparationResult.make({
            copiedFiles: 0,
            manifestPath: "workspace-manifest.json",
            skippedEntries: [],
            source: "empty",
            workspacePath: "workspace",
          })
        : yield* prepareLocalDirectoryWorkspace(paths, source.path);

    yield* fs.writeFileString(
      paths.workspaceManifest,
      `${JSON.stringify(encodeWorkspacePreparationResult(result), null, 2)}\n`
    );

    return result;
  });
}

function prepareLocalDirectoryWorkspace(
  paths: RunPaths,
  sourcePath: WorkspaceSourcePath
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sourceInfo = yield* fs.stat(sourcePath).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "WorkspaceSourceUnavailable",
            message: `Workspace source '${sourcePath}' is not available.`,
            recoverable: false,
          })
        )
      )
    );

    if (sourceInfo.type !== "Directory") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "WorkspaceSourceNotDirectory",
          message: `Workspace source '${sourcePath}' must be a directory.`,
          recoverable: false,
        })
      );
    }

    const copied = yield* copyWorkspaceDirectoryContents(
      sourcePath,
      paths.workspace
    );

    return WorkspacePreparationResult.make({
      copiedFiles: copied.copiedFiles,
      manifestPath: "workspace-manifest.json",
      skippedEntries: copied.skippedEntries,
      source: "local-directory",
      sourcePath,
      workspacePath: "workspace",
    });
  });
}

type CopyDirectoryResult = {
  readonly copiedFiles: number;
  readonly skippedEntries: ReadonlyArray<WorkspaceRelativePath>;
};

export type WorkspaceCopyOptions = {
  readonly deleteExtraneous?: boolean;
  readonly skippedRelativePaths?: ReadonlySet<string>;
};

/** Copy source files while skipping generated workspace entries and owned artifacts. */
export function copyWorkspaceDirectoryContents(
  sourceDirectory: string,
  destinationDirectory: string,
  options: WorkspaceCopyOptions = {}
): Effect.Effect<
  CopyDirectoryResult,
  GaiaRuntimeError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const sourcePath = yield* parseWorkspaceRuntimePath(sourceDirectory);
    const destinationPath =
      yield* parseWorkspaceRuntimePath(destinationDirectory);
    yield* rejectSourceSymbolicLink(sourcePath, ".");

    return yield* copyDirectoryContents(sourcePath, destinationPath, {
      deleteExtraneous: options.deleteExtraneous ?? false,
      relativePrefix: "",
      skippedRelativePaths: options.skippedRelativePaths ?? new Set<string>(),
    });
  });
}

function copyDirectoryContents(
  sourceDirectory: RuntimePath,
  destinationDirectory: RuntimePath,
  input: Readonly<{
    deleteExtraneous: boolean;
    relativePrefix: string;
    skippedRelativePaths: ReadonlySet<string>;
  }>
): Effect.Effect<
  CopyDirectoryResult,
  GaiaRuntimeError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = (yield* fs.readDirectory(sourceDirectory)).toSorted();
    const entrySet = new Set(entries);
    const skippedEntries: Array<WorkspaceRelativePath> = [];
    let copiedFiles = 0;

    if (input.deleteExtraneous && (yield* fs.exists(destinationDirectory))) {
      const destinationEntries = (yield* fs.readDirectory(
        destinationDirectory
      )).toSorted();

      for (const entry of destinationEntries) {
        const relativePath = yield* parseWorkspaceCopyRelativePath(
          input.relativePrefix.length === 0
            ? entry
            : `${input.relativePrefix}/${entry}`
        );

        if (
          ignoredWorkspaceEntries.has(entry) ||
          input.skippedRelativePaths.has(relativePath) ||
          entrySet.has(entry)
        ) {
          continue;
        }

        const staleDestinationPath = yield* parseWorkspaceRuntimePath(
          path.join(destinationDirectory, entry)
        );
        yield* fs.remove(staleDestinationPath, { recursive: true });
      }
    }

    for (const entry of entries) {
      const relativePath = yield* parseWorkspaceCopyRelativePath(
        input.relativePrefix.length === 0
          ? entry
          : `${input.relativePrefix}/${entry}`
      );

      if (
        ignoredWorkspaceEntries.has(entry) ||
        input.skippedRelativePaths.has(relativePath)
      ) {
        skippedEntries.push(relativePath);
        continue;
      }

      const sourcePath = yield* parseWorkspaceRuntimePath(
        path.join(sourceDirectory, entry)
      );
      const destinationPath = yield* parseWorkspaceRuntimePath(
        path.join(destinationDirectory, entry)
      );
      yield* rejectSourceSymbolicLink(sourcePath, relativePath);
      const info = yield* fs.stat(sourcePath);

      switch (info.type) {
        case "Directory": {
          yield* fs.makeDirectory(destinationPath, { recursive: true });
          const childResult = yield* copyDirectoryContents(
            sourcePath,
            destinationPath,
            {
              deleteExtraneous: input.deleteExtraneous,
              relativePrefix: relativePath,
              skippedRelativePaths: input.skippedRelativePaths,
            }
          );
          copiedFiles += childResult.copiedFiles;
          skippedEntries.push(...childResult.skippedEntries);
          break;
        }
        case "File": {
          yield* fs.makeDirectory(path.dirname(destinationPath), {
            recursive: true,
          });
          yield* fs.copyFile(sourcePath, destinationPath);
          copiedFiles += 1;
          break;
        }
        default: {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "WorkspaceSourceEntryUnsupported",
              message: `Workspace source entry '${relativePath}' is not a regular file or directory.`,
              recoverable: false,
            })
          );
        }
      }
    }

    return { copiedFiles, skippedEntries } satisfies CopyDirectoryResult;
  });
}

function rejectSourceSymbolicLink(path: RuntimePath, relativePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.readLink(path).pipe(
      Effect.flatMap(() =>
        Effect.fail(
          makeRuntimeError({
            code: "WorkspaceSourceSymlinkRejected",
            message: `Workspace source entry '${relativePath}' is a symbolic link.`,
            recoverable: false,
          })
        )
      ),
      Effect.catchTag("PlatformError", () => Effect.void)
    );
  });
}

function parseWorkspaceRuntimePath(input: string) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "WorkspacePathInvalid",
        message: "Workspace filesystem path is invalid.",
        recoverable: false,
      }),
    try: () => parseRuntimePath(input),
  });
}

function parseWorkspaceCopyRelativePath(input: string) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "WorkspacePathInvalid",
        message: "Workspace relative path is invalid.",
        recoverable: false,
      }),
    try: () => parseWorkspaceRelativePath(input),
  });
}
