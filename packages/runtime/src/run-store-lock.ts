import { Effect, FileSystem, Path, Schema } from "effect";

import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import {
  makeRunStorePaths,
  parseRuntimePath,
  type RunStorageOptions,
  type RuntimePath,
} from "./paths.js";

const lockMetadataFileName = "metadata.json";

class RunStoreLockMetadata extends Schema.Class<RunStoreLockMetadata>(
  "RunStoreLockMetadata"
)({
  acquiredAt: Schema.NonEmptyString,
  nextSafeAction: Schema.NonEmptyString,
  operation: Schema.NonEmptyString,
  version: Schema.Literal(1),
}) {}

const RunStoreLockMetadataJson = Schema.toCodecJson(RunStoreLockMetadata);
const encodeRunStoreLockMetadataJson = Schema.encodeSync(
  RunStoreLockMetadataJson
);
const parseRunStoreLockMetadataJson = Schema.decodeUnknownSync(
  RunStoreLockMetadataJson
);

export type RunStoreLockContext = {
  readonly nextSafeAction?: string;
  readonly operation?: string;
};

/** Run an effect while holding the local Gaia run-store mutation lock. */
export function withRunStoreLock<A, E, R>(
  options: RunStorageOptions,
  effect: Effect.Effect<A, E, R>,
  context: RunStoreLockContext = {}
): Effect.Effect<
  A,
  E | GaiaRuntimeError,
  R | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const lockPath = yield* acquireRunStoreLock(options, context);

    return yield* effect.pipe(
      Effect.ensuring(releaseRunStoreLock(lockPath).pipe(Effect.ignore))
    );
  });
}

function acquireRunStoreLock(
  options: RunStorageOptions,
  context: RunStoreLockContext
): Effect.Effect<
  RuntimePath,
  GaiaRuntimeError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);

    yield* fs.makeDirectory(store.gaiaRoot, { recursive: true }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "RunStoreLockPrepareFailed",
            message: "Gaia could not prepare the local run-store lock.",
            recoverable: true,
          })
        )
      )
    );
    yield* fs
      .makeDirectory(store.lock)
      .pipe(
        Effect.catchTag("PlatformError", (cause) =>
          runStoreLocked(store.lock, cause)
        )
      );
    yield* writeRunStoreLockMetadata(store.lock, context).pipe(
      Effect.tapError(() => releaseRunStoreLock(store.lock).pipe(Effect.ignore))
    );

    return store.lock;
  });
}

function writeRunStoreLockMetadata(
  lockPath: RuntimePath,
  context: RunStoreLockContext
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const metadata = RunStoreLockMetadata.make({
      acquiredAt: new Date().toISOString(),
      nextSafeAction:
        context.nextSafeAction ??
        "Wait for the active Gaia command to finish, then retry the command.",
      operation: context.operation ?? "Gaia run-store mutation",
      version: 1,
    });

    yield* fs.writeFileString(
      parseRuntimePath(path.join(lockPath, lockMetadataFileName)),
      `${JSON.stringify(encodeRunStoreLockMetadataJson(metadata), null, 2)}\n`
    );
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "RunStoreLockPrepareFailed",
          message: "Gaia could not write the local run-store lock metadata.",
          recoverable: true,
        })
      )
    )
  );
}

function runStoreLocked(
  lockPath: RuntimePath,
  cause: unknown
): Effect.Effect<never, GaiaRuntimeError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const metadata = yield* readOptionalRunStoreLockMetadata(lockPath);

    return yield* Effect.fail(
      makeRuntimeError({
        cause,
        code: "RunStoreLocked",
        message: runStoreLockedMessage(metadata),
        recoverable: true,
      })
    );
  });
}

function readOptionalRunStoreLockMetadata(
  lockPath: RuntimePath
): Effect.Effect<
  RunStoreLockMetadata | undefined,
  never,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const metadataPath = parseRuntimePath(
      path.join(lockPath, lockMetadataFileName)
    );
    const exists = yield* fs.exists(metadataPath);

    if (!exists) {
      return undefined;
    }

    const contents = yield* fs.readFileString(metadataPath);
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(contents),
      catch: (parseCause) =>
        makeRuntimeError({
          cause: parseCause,
          code: "RunStoreLockMetadataJsonInvalid",
          message: "Gaia run-store lock metadata was not valid JSON.",
          recoverable: true,
        }),
    });

    return yield* Effect.try({
      try: () => parseRunStoreLockMetadataJson(parsed),
      catch: (parseCause) =>
        makeRuntimeError({
          cause: parseCause,
          code: "RunStoreLockMetadataInvalid",
          message: "Gaia run-store lock metadata did not match Gaia's schema.",
          recoverable: true,
        }),
    });
  }).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(undefined),
      onSuccess: (metadata) => Effect.succeed(metadata),
    })
  );
}

function runStoreLockedMessage(metadata: RunStoreLockMetadata | undefined) {
  if (metadata === undefined) {
    return "Another Gaia run-store mutation is already in progress. Wait for it to finish before starting another mutating run command.";
  }

  return [
    `Another Gaia run-store mutation is already in progress: ${metadata.operation}.`,
    `Lock acquired at: ${metadata.acquiredAt}.`,
    metadata.nextSafeAction,
  ].join(" ");
}

function releaseRunStoreLock(lockPath: RuntimePath) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(lockPath, { recursive: true });
  });
}
