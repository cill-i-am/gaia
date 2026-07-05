import { FileSystem, Path, Effect } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { createHash } from "node:crypto";

export function snapshotWorkspace(workspacePath: string) {
  return snapshotDirectory(workspacePath, "");
}

export function changedPaths(
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

function snapshotDirectory(
  directoryPath: string,
  relativePrefix: string,
): Effect.Effect<
  ReadonlyMap<string, string>,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = (yield* fs.readDirectory(directoryPath)).toSorted();
    const digestByPath = new Map<string, string>();

    for (const entry of entries) {
      const absolutePath = path.join(directoryPath, entry);
      const relativePath =
        relativePrefix.length === 0 ? entry : `${relativePrefix}/${entry}`;
      const info = yield* fs.stat(absolutePath);

      switch (info.type) {
        case "Directory": {
          const childDigest = yield* snapshotDirectory(
            absolutePath,
            relativePath,
          );
          for (const [childPath, digest] of childDigest) {
            digestByPath.set(childPath, digest);
          }
          break;
        }
        case "File": {
          const bytes = yield* fs.readFile(absolutePath);
          digestByPath.set(relativePath, hashBytes(bytes));
          break;
        }
        default: {
          break;
        }
      }
    }

    return digestByPath;
  });
}

function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
