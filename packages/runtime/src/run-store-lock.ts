import { Effect, FileSystem, Path } from "effect";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { makeRunStorePaths, type RunStorageOptions } from "./paths.js";

/** Run an effect while holding the local Gaia run-store mutation lock. */
export function withRunStoreLock<A, E, R>(
  options: RunStorageOptions,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | GaiaRuntimeError,
  R | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const lockPath = yield* acquireRunStoreLock(options);

    return yield* effect.pipe(
      Effect.ensuring(releaseRunStoreLock(lockPath).pipe(Effect.ignore)),
    );
  });
}

function acquireRunStoreLock(options: RunStorageOptions) {
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
          }),
        ),
      ),
    );
    yield* fs.makeDirectory(store.lock).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "RunStoreLocked",
            message:
              "Another Gaia run-store mutation is already in progress. Wait for it to finish before starting another mutating run command.",
            recoverable: true,
          }),
        ),
      ),
    );

    return store.lock;
  });
}

function releaseRunStoreLock(lockPath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(lockPath, { recursive: true });
  });
}
