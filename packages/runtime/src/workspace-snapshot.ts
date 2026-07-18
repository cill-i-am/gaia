import { createHash } from "node:crypto";

import {
  parseWorkspaceRelativePath,
  type WorkspaceRelativePath,
  WorkspaceRelativePathSchema,
} from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { parseRuntimePath, type RuntimePath } from "./paths.js";

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
  Schema.isGreaterThanOrEqualTo(0)
);
const WorkspaceSnapshotDigestSchema = Schema.NonEmptyString.pipe(
  Schema.brand("WorkspaceSnapshotDigest")
);
const parseWorkspaceSnapshotDigest = Schema.decodeUnknownSync(
  WorkspaceSnapshotDigestSchema
);
type WorkspaceSnapshotDigest = typeof WorkspaceSnapshotDigestSchema.Type;

/** Generated workspace root summarized instead of expanded into raw path evidence. */
export class WorkspaceDiffOmittedGeneratedPath extends Schema.Class<WorkspaceDiffOmittedGeneratedPath>(
  "WorkspaceDiffOmittedGeneratedPath"
)({
  changedFileCount: NonNegativeIntegerSchema,
  path: WorkspaceRelativePathSchema,
  reason: Schema.NonEmptyString,
}) {
  static override make(input: unknown): WorkspaceDiffOmittedGeneratedPath {
    return decodeWorkspaceDiffOmittedGeneratedPath(input);
  }
}

/** Bounded review evidence for product/source changes and omitted generated churn. */
export class WorkspaceDiffSummary extends Schema.Class<WorkspaceDiffSummary>(
  "WorkspaceDiffSummary"
)({
  notes: Schema.Array(Schema.NonEmptyString),
  omittedGeneratedFileCount: NonNegativeIntegerSchema,
  omittedGeneratedPathCount: NonNegativeIntegerSchema,
  omittedGeneratedPaths: Schema.Array(WorkspaceDiffOmittedGeneratedPath),
  productChangedPathCount: NonNegativeIntegerSchema,
  productChangedPaths: Schema.Array(WorkspaceRelativePathSchema),
  version: Schema.Literal(1),
}) {
  static override make(input: unknown): WorkspaceDiffSummary {
    return decodeWorkspaceDiffSummary(input);
  }
}

const decodeWorkspaceDiffOmittedGeneratedPath = Schema.decodeUnknownSync(
  WorkspaceDiffOmittedGeneratedPath
);
const decodeWorkspaceDiffSummary =
  Schema.decodeUnknownSync(WorkspaceDiffSummary);
const WorkspaceDiffSummaryJson = Schema.toCodecJson(WorkspaceDiffSummary);
export const encodeWorkspaceDiffSummaryJson = Schema.encodeSync(
  WorkspaceDiffSummaryJson
);

const PersistedGeneratedPathSnapshot = Schema.Struct({
  digest: WorkspaceSnapshotDigestSchema,
  fileCount: NonNegativeIntegerSchema,
  path: WorkspaceRelativePathSchema,
  reason: Schema.NonEmptyString,
});
const PersistedProductFileSnapshot = Schema.Struct({
  digest: WorkspaceSnapshotDigestSchema,
  path: WorkspaceRelativePathSchema,
});
const PersistedWorkspaceSnapshot = Schema.Struct({
  generatedPaths: Schema.Array(PersistedGeneratedPathSnapshot),
  productFiles: Schema.Array(PersistedProductFileSnapshot),
  version: Schema.Literal(1),
});
const decodePersistedWorkspaceSnapshot = Schema.decodeUnknownSync(
  PersistedWorkspaceSnapshot
);
const decodePersistedGeneratedPathSnapshot = Schema.decodeUnknownSync(
  PersistedGeneratedPathSnapshot
);

type PersistedWorkspaceSnapshotValue =
  typeof PersistedWorkspaceSnapshot.Encoded;
type ParsedPersistedWorkspaceSnapshotValue =
  typeof PersistedWorkspaceSnapshot.Type;
type GeneratedPathSnapshot =
  PersistedWorkspaceSnapshotValue["generatedPaths"][number];
type ParsedGeneratedPathSnapshot =
  ParsedPersistedWorkspaceSnapshotValue["generatedPaths"][number];

export type WorkspaceSnapshot = {
  readonly generatedPathSummaries: ReadonlyMap<
    WorkspaceRelativePath,
    GeneratedPathSnapshot
  >;
  readonly productFileDigests: ReadonlyMap<
    WorkspaceRelativePath,
    typeof WorkspaceSnapshotDigestSchema.Encoded
  >;
};

type GeneratedPathDigest = {
  readonly digest: WorkspaceSnapshotDigest;
  readonly fileCount: number;
};

export function snapshotWorkspace(workspacePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rootPath = yield* parseWorkspaceSnapshotRuntimePath(
      workspacePath,
      "Gaia workspace snapshot root path is invalid."
    );
    const rootRealPath = yield* realContainedPath(rootPath, rootPath);

    return yield* snapshotDirectory(rootRealPath, "", rootRealPath, new Set());
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "WorkspaceSnapshotReadFailed",
          message: "Gaia could not read workspace snapshot input.",
          recoverable: true,
        })
      )
    )
  );
}

/** Persist a private restart baseline without exposing absolute workspace paths. */
export function writeWorkspaceSnapshot(
  snapshotPath: string,
  snapshot: WorkspaceSnapshot
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parsedSnapshotPath = yield* parseWorkspaceSnapshotRuntimePath(
      snapshotPath,
      "Gaia workspace snapshot output path is invalid.",
      "WorkspaceSnapshotWriteFailed"
    );
    const persisted = yield* parsePersistedWorkspaceSnapshotForWrite({
      generatedPaths: [...snapshot.generatedPathSummaries.values()],
      productFiles: [...snapshot.productFileDigests].map(([path, digest]) => ({
        digest,
        path,
      })),
      version: 1,
    });
    yield* fs.writeFileString(
      parsedSnapshotPath,
      `${JSON.stringify(persisted)}\n`
    );
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "WorkspaceSnapshotWriteFailed",
          message: "Gaia could not write workspace snapshot baseline.",
          recoverable: true,
        })
      )
    )
  );
}

/** Read and validate the private workspace baseline used for crash recovery. */
export function readWorkspaceSnapshot(snapshotPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parsedSnapshotPath = yield* parseWorkspaceSnapshotRuntimePath(
      snapshotPath,
      "Gaia workspace snapshot input path is invalid."
    );
    const text = yield* fs.readFileString(parsedSnapshotPath).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "WorkspaceSnapshotReadFailed",
            message: "Gaia could not read workspace snapshot baseline.",
            recoverable: true,
          })
        )
      )
    );
    const parsed = yield* parsePersistedWorkspaceSnapshotText(text);
    const generatedPathSummaries = new Map<
      WorkspaceRelativePath,
      ParsedGeneratedPathSnapshot
    >(parsed.generatedPaths.map((entry) => [entry.path, entry]));
    const productFileDigests = new Map<
      WorkspaceRelativePath,
      WorkspaceSnapshotDigest
    >(parsed.productFiles.map((entry) => [entry.path, entry.digest]));
    return {
      generatedPathSummaries,
      productFileDigests,
    } satisfies WorkspaceSnapshot;
  });
}

export function changedPaths(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot
) {
  const diff = diffWorkspaceSnapshots(before, after);
  return [
    ...diff.productChangedPaths,
    ...diff.omittedGeneratedPaths.map((entry) => entry.path),
  ].toSorted();
}

export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot
) {
  const productChangedPaths = changedProductPaths(
    before.productFileDigests,
    after.productFileDigests
  );
  const omittedGeneratedPaths = changedGeneratedPaths(
    before.generatedPathSummaries,
    after.generatedPathSummaries
  );
  const omittedGeneratedFileCount = omittedGeneratedPaths.reduce(
    (total, entry) => total + entry.changedFileCount,
    0
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
  productChangedPaths: ReadonlyArray<string>
) {
  const sortedProductChangedPaths = productChangedPaths
    .map((path) => parseWorkspaceRelativePath(path))
    .toSorted();

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
  before: ReadonlyMap<WorkspaceRelativePath, string>,
  after: ReadonlyMap<WorkspaceRelativePath, string>
) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed: Array<WorkspaceRelativePath> = [];

  for (const path of paths) {
    if (before.get(path) !== after.get(path)) {
      changed.push(path);
    }
  }

  return changed.toSorted();
}

function changedGeneratedPaths(
  before: ReadonlyMap<WorkspaceRelativePath, GeneratedPathSnapshot>,
  after: ReadonlyMap<WorkspaceRelativePath, GeneratedPathSnapshot>
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
          afterSummary
        ),
        path,
        reason: summary.reason,
      })
    );
  }

  return changed;
}

function changedGeneratedFileCount(
  before: GeneratedPathSnapshot | undefined,
  after: GeneratedPathSnapshot | undefined
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
  omittedGeneratedPaths: ReadonlyArray<WorkspaceDiffOmittedGeneratedPath>
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
  directoryPath: RuntimePath,
  relativePrefix: string,
  workspaceRootPath: RuntimePath,
  visitedDirectoryPaths: ReadonlySet<RuntimePath>
): Effect.Effect<
  WorkspaceSnapshot,
  GaiaRuntimeError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalDirectoryPath = yield* realContainedPath(
      directoryPath,
      workspaceRootPath
    );
    if (visitedDirectoryPaths.has(canonicalDirectoryPath)) {
      return emptyWorkspaceSnapshot();
    }

    const nextVisitedDirectoryPaths = new Set(visitedDirectoryPaths);
    nextVisitedDirectoryPaths.add(canonicalDirectoryPath);
    const entries = (yield* fs.readDirectory(
      canonicalDirectoryPath
    )).toSorted();
    const productFileDigests = new Map<
      WorkspaceRelativePath,
      WorkspaceSnapshotDigest
    >();
    const generatedPathSummaries = new Map<
      WorkspaceRelativePath,
      ParsedGeneratedPathSnapshot
    >();

    for (const entry of entries) {
      const absolutePath = yield* parseWorkspaceSnapshotRuntimePath(
        path.join(canonicalDirectoryPath, entry),
        "Gaia workspace snapshot entry path is invalid."
      );
      const canonicalPath = yield* realContainedPath(
        absolutePath,
        workspaceRootPath
      );
      const relativePath = yield* parseSnapshotWorkspaceRelativePath(
        relativePrefix.length === 0 ? entry : `${relativePrefix}/${entry}`
      );
      const generatedReason = generatedWorkspaceEntryReasons.get(entry);

      if (generatedReason !== undefined) {
        const summary = yield* summarizeGeneratedPath(
          canonicalPath,
          relativePath,
          generatedReason,
          workspaceRootPath,
          nextVisitedDirectoryPaths
        );
        generatedPathSummaries.set(relativePath, summary);
        continue;
      }

      const info = yield* fs.stat(canonicalPath);

      switch (info.type) {
        case "Directory": {
          const childSnapshot = yield* snapshotDirectory(
            canonicalPath,
            relativePath,
            workspaceRootPath,
            nextVisitedDirectoryPaths
          );
          for (const [childPath, digest] of childSnapshot.productFileDigests) {
            productFileDigests.set(
              childPath,
              parseWorkspaceSnapshotDigest(digest)
            );
          }
          for (const [
            childPath,
            summary,
          ] of childSnapshot.generatedPathSummaries) {
            generatedPathSummaries.set(
              childPath,
              decodePersistedGeneratedPathSnapshot(summary)
            );
          }
          break;
        }
        case "File": {
          const bytes = yield* fs.readFile(canonicalPath);
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
  absolutePath: RuntimePath,
  relativePath: WorkspaceRelativePath,
  reason: string,
  workspaceRootPath: RuntimePath,
  visitedDirectoryPaths: ReadonlySet<RuntimePath>
): Effect.Effect<
  ParsedGeneratedPathSnapshot,
  GaiaRuntimeError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const digest = yield* digestGeneratedPath(
      absolutePath,
      workspaceRootPath,
      visitedDirectoryPaths
    );

    return {
      digest: digest.digest,
      fileCount: digest.fileCount,
      path: relativePath,
      reason,
    };
  });
}

function digestGeneratedPath(
  absolutePath: RuntimePath,
  workspaceRootPath: RuntimePath,
  visitedDirectoryPaths: ReadonlySet<RuntimePath>
): Effect.Effect<
  GeneratedPathDigest,
  GaiaRuntimeError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalPath = yield* realContainedPath(
      absolutePath,
      workspaceRootPath
    );
    const info = yield* fs.stat(canonicalPath);

    switch (info.type) {
      case "Directory": {
        if (visitedDirectoryPaths.has(canonicalPath)) {
          return {
            digest: hashString("omitted:directory-cycle"),
            fileCount: 0,
          };
        }

        const nextVisitedDirectoryPaths = new Set(visitedDirectoryPaths);
        nextVisitedDirectoryPaths.add(canonicalPath);
        const entries = (yield* fs.readDirectory(canonicalPath)).toSorted();
        const hash = createHash("sha256");
        let fileCount = 0;

        hash.update("directory");
        for (const entry of entries) {
          const childPath = yield* parseWorkspaceSnapshotRuntimePath(
            path.join(canonicalPath, entry),
            "Gaia workspace snapshot generated entry path is invalid."
          );
          const childDigest = yield* digestGeneratedPath(
            childPath,
            workspaceRootPath,
            nextVisitedDirectoryPaths
          );
          hash.update("\0entry\0");
          hash.update(entry);
          hash.update("\0digest\0");
          hash.update(childDigest.digest);
          hash.update("\0files\0");
          hash.update(String(childDigest.fileCount));
          fileCount += childDigest.fileCount;
        }

        return {
          digest: parseWorkspaceSnapshotDigest(hash.digest("hex")),
          fileCount,
        };
      }
      case "File": {
        const bytes = yield* fs.readFile(canonicalPath);
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
  return parseWorkspaceSnapshotDigest(
    createHash("sha256").update(bytes).digest("hex")
  );
}

function emptyWorkspaceSnapshot(): WorkspaceSnapshot {
  return {
    generatedPathSummaries: new Map<
      WorkspaceRelativePath,
      ParsedGeneratedPathSnapshot
    >(),
    productFileDigests: new Map<
      WorkspaceRelativePath,
      WorkspaceSnapshotDigest
    >(),
  };
}

function parseWorkspaceSnapshotRuntimePath(
  input: string,
  message: string,
  code:
    | "WorkspaceSnapshotReadFailed"
    | "WorkspaceSnapshotWriteFailed" = "WorkspaceSnapshotReadFailed"
) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code,
        message,
        recoverable: false,
      }),
    try: () => parseRuntimePath(input),
  });
}

function realContainedPath(path: RuntimePath, workspaceRootPath: RuntimePath) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const realPath = yield* parseWorkspaceSnapshotRuntimePath(
      yield* fs.realPath(path),
      "Gaia workspace snapshot canonical path is invalid."
    );
    const realWorkspaceRootPath = yield* parseWorkspaceSnapshotRuntimePath(
      yield* fs.realPath(workspaceRootPath),
      "Gaia workspace snapshot canonical root path is invalid."
    );

    if (!isSameOrChildPath(realWorkspaceRootPath, realPath)) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "WorkspaceSnapshotReadFailed",
          message:
            "Gaia workspace snapshot contains an entry outside the workspace root.",
          recoverable: false,
        })
      );
    }

    return realPath;
  });
}

function isSameOrChildPath(rootPath: RuntimePath, path: RuntimePath) {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function parsePersistedWorkspaceSnapshotForWrite(input: unknown) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "WorkspaceSnapshotWriteFailed",
        message: "Gaia workspace snapshot contains invalid persisted paths.",
        recoverable: false,
      }),
    try: () => decodePersistedWorkspaceSnapshot(input),
  });
}

function parseSnapshotWorkspaceRelativePath(input: string) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "WorkspaceSnapshotReadFailed",
        message:
          "Gaia workspace snapshot contains a path that is not a valid workspace-relative path.",
        recoverable: false,
      }),
    try: () => parseWorkspaceRelativePath(input),
  });
}

function parsePersistedWorkspaceSnapshotText(text: string) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "WorkspaceSnapshotReadFailed",
        message: "Gaia workspace snapshot contains invalid persisted paths.",
        recoverable: false,
      }),
    try: () => decodePersistedWorkspaceSnapshot(JSON.parse(text)),
  });
}

function hashString(input: string) {
  return parseWorkspaceSnapshotDigest(
    createHash("sha256").update(input).digest("hex")
  );
}
