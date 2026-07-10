import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { createHash } from "node:crypto";

const generatedWorkspaceEntryReasons = new Map([
  [
    ".gaia",
    "Gaia local run state is generated runtime evidence and is omitted from product diff paths.",
  ],
  [
    ".git",
    "Git repository metadata is generated tool state and is omitted from product diff paths.",
  ],
  [
    ".turbo",
    "Turbo cache output is generated build state and is omitted from product diff paths.",
  ],
  [
    "coverage",
    "Coverage output is generated test evidence and is omitted from product diff paths.",
  ],
  [
    "dist",
    "Build output is generated from source files and is omitted from product diff paths.",
  ],
  [
    "gaia-runs",
    "Gaia PR evidence is generated publishing output and is omitted from product diff paths.",
  ],
  [
    "node_modules",
    "Installed dependencies are generated from package manifests and are omitted from product diff paths.",
  ],
]);

const NonNegativeIntegerSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
);

/** Generated workspace root summarized instead of expanded into raw path evidence. */
export class WorkspaceDiffOmittedGeneratedPath extends Schema.Class<WorkspaceDiffOmittedGeneratedPath>(
  "WorkspaceDiffOmittedGeneratedPath",
)({
  changedFileCount: NonNegativeIntegerSchema,
  path: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
}) {}

/** Bounded review evidence for product/source changes and omitted generated churn. */
export class WorkspaceDiffSummary extends Schema.Class<WorkspaceDiffSummary>(
  "WorkspaceDiffSummary",
)({
  notes: Schema.Array(Schema.NonEmptyString),
  omittedGeneratedFileCount: NonNegativeIntegerSchema,
  omittedGeneratedPathCount: NonNegativeIntegerSchema,
  omittedGeneratedPaths: Schema.Array(WorkspaceDiffOmittedGeneratedPath),
  productChangedPathCount: NonNegativeIntegerSchema,
  productChangedPaths: Schema.Array(Schema.NonEmptyString),
  version: Schema.Literal(1),
}) {}

const WorkspaceDiffSummaryJson = Schema.toCodecJson(WorkspaceDiffSummary);
export const encodeWorkspaceDiffSummaryJson = Schema.encodeSync(
  WorkspaceDiffSummaryJson,
);

export type WorkspaceSnapshot = {
  readonly generatedPathSummaries: ReadonlyMap<string, GeneratedPathSnapshot>;
  readonly productFileDigests: ReadonlyMap<string, string>;
};

const PersistedWorkspaceSnapshot = Schema.Struct({
  generatedPaths: Schema.Array(
    Schema.Struct({
      digest: Schema.String,
      fileCount: Schema.Int,
      path: Schema.String,
      reason: Schema.String,
    }),
  ),
  productFiles: Schema.Array(
    Schema.Struct({ digest: Schema.String, path: Schema.String }),
  ),
  version: Schema.Literal(1),
});
const decodePersistedWorkspaceSnapshot = Schema.decodeUnknownSync(
  PersistedWorkspaceSnapshot,
);

type GeneratedPathSnapshot = {
  readonly digest: string;
  readonly fileCount: number;
  readonly path: string;
  readonly reason: string;
};

type GeneratedPathDigest = {
  readonly digest: string;
  readonly fileCount: number;
};

export function snapshotWorkspace(workspacePath: string) {
  return snapshotDirectory(workspacePath, "");
}

/** Persist a private restart baseline without exposing absolute workspace paths. */
export function writeWorkspaceSnapshot(
  snapshotPath: string,
  snapshot: WorkspaceSnapshot,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      snapshotPath,
      `${JSON.stringify({
        generatedPaths: [...snapshot.generatedPathSummaries.values()],
        productFiles: [...snapshot.productFileDigests].map(([path, digest]) => ({
          digest,
          path,
        })),
        version: 1,
      })}\n`,
    );
  });
}

/** Read and validate the private workspace baseline used for crash recovery. */
export function readWorkspaceSnapshot(snapshotPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parsed = decodePersistedWorkspaceSnapshot(
      JSON.parse(yield* fs.readFileString(snapshotPath)),
    );
    return {
      generatedPathSummaries: new Map(
        parsed.generatedPaths.map((entry) => [entry.path, entry]),
      ),
      productFileDigests: new Map(
        parsed.productFiles.map((entry) => [entry.path, entry.digest]),
      ),
    } satisfies WorkspaceSnapshot;
  });
}

export function changedPaths(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
) {
  const diff = diffWorkspaceSnapshots(before, after);
  return [
    ...diff.productChangedPaths,
    ...diff.omittedGeneratedPaths.map((entry) => entry.path),
  ].toSorted();
}

export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
) {
  const productChangedPaths = changedProductPaths(
    before.productFileDigests,
    after.productFileDigests,
  );
  const omittedGeneratedPaths = changedGeneratedPaths(
    before.generatedPathSummaries,
    after.generatedPathSummaries,
  );
  const omittedGeneratedFileCount = omittedGeneratedPaths.reduce(
    (total, entry) => total + entry.changedFileCount,
    0,
  );

  return WorkspaceDiffSummary.make({
    notes: workspaceDiffNotes(omittedGeneratedPaths),
    omittedGeneratedFileCount,
    omittedGeneratedPathCount: omittedGeneratedPaths.length,
    omittedGeneratedPaths,
    productChangedPathCount: productChangedPaths.length,
    productChangedPaths,
    version: 1,
  });
}

export function productOnlyWorkspaceDiff(
  productChangedPaths: ReadonlyArray<string>,
) {
  const sortedProductChangedPaths = [...productChangedPaths].toSorted();

  return WorkspaceDiffSummary.make({
    notes: [],
    omittedGeneratedFileCount: 0,
    omittedGeneratedPathCount: 0,
    omittedGeneratedPaths: [],
    productChangedPathCount: sortedProductChangedPaths.length,
    productChangedPaths: sortedProductChangedPaths,
    version: 1,
  });
}

function changedProductPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed: Array<string> = [];

  for (const path of paths) {
    if (before.get(path) !== after.get(path)) {
      changed.push(path);
    }
  }

  return changed.toSorted();
}

function changedGeneratedPaths(
  before: ReadonlyMap<string, GeneratedPathSnapshot>,
  after: ReadonlyMap<string, GeneratedPathSnapshot>,
) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed: Array<WorkspaceDiffOmittedGeneratedPath> = [];

  for (const path of [...paths].toSorted()) {
    const beforeSummary = before.get(path);
    const afterSummary = after.get(path);

    if (
      beforeSummary?.digest === afterSummary?.digest &&
      beforeSummary?.fileCount === afterSummary?.fileCount
    ) {
      continue;
    }

    const summary = afterSummary ?? beforeSummary;
    if (summary === undefined) {
      continue;
    }

    changed.push(
      WorkspaceDiffOmittedGeneratedPath.make({
        changedFileCount: changedGeneratedFileCount(
          beforeSummary,
          afterSummary,
        ),
        path,
        reason: summary.reason,
      }),
    );
  }

  return changed;
}

function changedGeneratedFileCount(
  before: GeneratedPathSnapshot | undefined,
  after: GeneratedPathSnapshot | undefined,
) {
  if (before === undefined) {
    return after?.fileCount ?? 0;
  }

  if (after === undefined) {
    return before.fileCount;
  }

  return Math.max(before.fileCount, after.fileCount);
}

function workspaceDiffNotes(
  omittedGeneratedPaths: ReadonlyArray<WorkspaceDiffOmittedGeneratedPath>,
) {
  if (omittedGeneratedPaths.length === 0) {
    return [];
  }

  return [
    "changedWorkspacePaths lists reviewable product/source paths and declared workspace artifacts only.",
    "Generated workspace paths are summarized instead of expanded to keep worker-result.json reviewable.",
  ];
}

function snapshotDirectory(
  directoryPath: string,
  relativePrefix: string,
): Effect.Effect<
  WorkspaceSnapshot,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = (yield* fs.readDirectory(directoryPath)).toSorted();
    const productFileDigests = new Map<string, string>();
    const generatedPathSummaries = new Map<string, GeneratedPathSnapshot>();

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry);
      const relativePath =
        relativePrefix.length === 0 ? entry : `${relativePrefix}/${entry}`;
      const generatedReason = generatedWorkspaceEntryReasons.get(entry);

      if (generatedReason !== undefined) {
        const summary = yield* summarizeGeneratedPath(
          absolutePath,
          relativePath,
          generatedReason,
        );
        generatedPathSummaries.set(relativePath, summary);
        continue;
      }

      const info = yield* fs.stat(absolutePath);

      switch (info.type) {
        case "Directory": {
          const childSnapshot = yield* snapshotDirectory(
            absolutePath,
            relativePath,
          );
          for (const [childPath, digest] of childSnapshot.productFileDigests) {
            productFileDigests.set(childPath, digest);
          }
          for (const [childPath, summary] of childSnapshot.generatedPathSummaries) {
            generatedPathSummaries.set(childPath, summary);
          }
          break;
        }
        case "File": {
          const bytes = yield* fs.readFile(absolutePath);
          productFileDigests.set(relativePath, hashBytes(bytes));
          break;
        }
        default: {
          break;
        }
      }
    }

    return { generatedPathSummaries, productFileDigests };
  });
}

function summarizeGeneratedPath(
  absolutePath: string,
  relativePath: string,
  reason: string,
): Effect.Effect<
  GeneratedPathSnapshot,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const digest = yield* digestGeneratedPath(absolutePath);

    return {
      digest: digest.digest,
      fileCount: digest.fileCount,
      path: relativePath,
      reason,
    };
  });
}

function digestGeneratedPath(
  absolutePath: string,
): Effect.Effect<
  GeneratedPathDigest,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const info = yield* fs.stat(absolutePath);

    switch (info.type) {
      case "Directory": {
        const entries = (yield* fs.readDirectory(absolutePath)).toSorted();
        const hash = createHash("sha256");
        let fileCount = 0;

        hash.update("directory");
        for (const entry of entries) {
          const childPath = path.join(absolutePath, entry);
          const childDigest = yield* digestGeneratedPath(childPath);
          hash.update("\0entry\0");
          hash.update(entry);
          hash.update("\0digest\0");
          hash.update(childDigest.digest);
          hash.update("\0files\0");
          hash.update(String(childDigest.fileCount));
          fileCount += childDigest.fileCount;
        }

        return { digest: hash.digest("hex"), fileCount };
      }
      case "File": {
        const bytes = yield* fs.readFile(absolutePath);
        return { digest: hashBytes(bytes), fileCount: 1 };
      }
      default: {
        return {
          digest: hashString(`omitted:${info.type}`),
          fileCount: 0,
        };
      }
    }
  });
}

function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashString(input: string) {
  return createHash("sha256").update(input).digest("hex");
}
