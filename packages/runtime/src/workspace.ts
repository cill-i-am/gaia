import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { makeRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";

const ignoredWorkspaceEntries = new Set([
  ".gaia",
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "gaia-runs",
  "node_modules",
]);

export const WorkspaceSourcePathSchema = Schema.NonEmptyString.pipe(
  Schema.brand("WorkspaceSourcePath")
);

export type WorkspaceSourcePath = typeof WorkspaceSourcePathSchema.Type;

export const parseWorkspaceSourcePath = Schema.decodeUnknownSync(
  WorkspaceSourcePathSchema
);

export type WorkspaceSource =
  | { readonly _tag: "Empty" }
  | {
      readonly _tag: "LocalDirectory";
      readonly path: WorkspaceSourcePath;
    };

export class WorkspacePreparationResult extends Schema.Class<WorkspacePreparationResult>(
  "WorkspacePreparationResult"
)({
  copiedFiles: Schema.Number.pipe(
    Schema.check(Schema.isInt({ identifier: "CopiedFiles" }))
  ),
  manifestPath: Schema.NonEmptyString,
  skippedEntries: Schema.Array(Schema.NonEmptyString),
  source: Schema.Literals(["empty", "local-directory"] as const),
  sourcePath: Schema.optionalKey(Schema.NonEmptyString),
  workspacePath: Schema.NonEmptyString,
}) {}

const WorkspacePreparationResultJson = Schema.toCodecJson(
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
  readonly skippedEntries: ReadonlyArray<string>;
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
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return copyDirectoryContents(sourceDirectory, destinationDirectory, {
    deleteExtraneous: options.deleteExtraneous ?? false,
    relativePrefix: "",
    skippedRelativePaths: options.skippedRelativePaths ?? new Set<string>(),
  });
}

function copyDirectoryContents(
  sourceDirectory: string,
  destinationDirectory: string,
  input: Readonly<{
    deleteExtraneous: boolean;
    relativePrefix: string;
    skippedRelativePaths: ReadonlySet<string>;
  }>
): Effect.Effect<
  CopyDirectoryResult,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = (yield* fs.readDirectory(sourceDirectory)).toSorted();
    const entrySet = new Set(entries);
    const skippedEntries: Array<string> = [];
    let copiedFiles = 0;

    if (input.deleteExtraneous && (yield* fs.exists(destinationDirectory))) {
      const destinationEntries = (yield* fs.readDirectory(
        destinationDirectory
      )).toSorted();

      for (const entry of destinationEntries) {
        const relativePath =
          input.relativePrefix.length === 0
            ? entry
            : `${input.relativePrefix}/${entry}`;

        if (
          ignoredWorkspaceEntries.has(entry) ||
          input.skippedRelativePaths.has(relativePath) ||
          entrySet.has(entry)
        ) {
          continue;
        }

        yield* fs.remove(path.join(destinationDirectory, entry), {
          recursive: true,
        });
      }
    }

    for (const entry of entries) {
      const relativePath =
        input.relativePrefix.length === 0
          ? entry
          : `${input.relativePrefix}/${entry}`;

      if (
        ignoredWorkspaceEntries.has(entry) ||
        input.skippedRelativePaths.has(relativePath)
      ) {
        skippedEntries.push(relativePath);
        continue;
      }

      const sourcePath = path.join(sourceDirectory, entry);
      const destinationPath = path.join(destinationDirectory, entry);
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
          skippedEntries.push(relativePath);
        }
      }
    }

    return { copiedFiles, skippedEntries } satisfies CopyDirectoryResult;
  });
}
