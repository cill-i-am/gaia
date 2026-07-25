import { NodeServices } from "@effect/platform-node";
import {
  codexAppServerHarnessProfileId,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  parseHarnessTurnId,
  parseHarnessProviderId,
  parseRunId,
  projectHarnessEvents,
  type HarnessEvent,
  type HarnessSessionId,
  type WorkspaceRelativePath,
} from "@gaia/core";
import { Effect, FileSystem, Option, Path, Stream } from "effect";

import { makeRuntimeError } from "./errors.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import {
  HarnessStartError,
  type HarnessProvider,
  type HarnessSession,
} from "./harness-session.js";
import {
  parseRunStorageRootInput,
  RunStorageRootInputSchema,
} from "./paths.js";

export const testHarnessCapabilities = HarnessCapabilities.make({
  approvals: [],
  durableCancellation: true,
  durableInteractionResolution: true,
  durablePause: true,
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: false,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: false,
});

export const testHarnessProvider: HarnessProvider = {
  createSession: (request) =>
    Effect.succeed(testHarnessSession(request.sessionId)),
  descriptor: HarnessProviderDescriptor.make({
    displayName: "Test Interactive Harness",
    executionModes: ["local"],
    providerId: parseHarnessProviderId("test-interactive"),
  }),
  detect: Effect.succeed({
    auth: { state: "notRequired" },
    capabilities: testHarnessCapabilities,
    state: "available",
    version: "test-1",
  }),
  resumeSession: (request) =>
    Effect.succeed(testHarnessSession(request.sessionId)),
};

/** Explicit test-only provider registry; never used by production composition. */
export function makeTestHarnessProviderRegistry() {
  return makeHarnessProviderRegistry([
    {
      profileId: codexAppServerHarnessProfileId,
      provider: testHarnessProvider,
    },
  ]);
}

/**
 * Test-only registry whose initial session writes the verifier's exact run marker.
 */
export function makeMarkerWritingTestHarnessProviderRegistry(
  rootDirectory: typeof RunStorageRootInputSchema.Encoded
) {
  const provider: HarnessProvider = {
    ...testHarnessProvider,
    createSession: (request) =>
      writeTestHarnessRunMarker({
        rootDirectory,
        workspacePath: request.workspacePath,
      }).pipe(
        Effect.provide(NodeServices.layer),
        Effect.as(testHarnessSession(request.sessionId)),
        Effect.mapError(
          () =>
            new HarnessStartError({
              message:
                "The test harness could not write the exact run output marker.",
              providerId: testHarnessProvider.descriptor.providerId,
            })
        )
      ),
  };
  return makeHarnessProviderRegistry([
    {
      profileId: codexAppServerHarnessProfileId,
      provider,
    },
  ]);
}

const writeTestHarnessRunMarker = Effect.fn("TestHarness.writeRunMarker")(
  function* (input: {
    readonly rootDirectory: typeof RunStorageRootInputSchema.Encoded;
    readonly workspacePath: WorkspaceRelativePath;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parsedRoot = yield* Effect.try({
      try: () => parseRunStorageRootInput(input.rootDirectory),
      catch: () => invalidMarkerWorkspace(),
    });
    const canonicalRoot = yield* canonicalTestDirectory(fs, parsedRoot);
    const requestedWorkspace = path.resolve(canonicalRoot, input.workspacePath);
    const canonicalWorkspace = yield* canonicalTestDirectory(
      fs,
      requestedWorkspace
    );
    const runId = yield* Effect.try({
      try: () => parseRunId(path.basename(path.dirname(canonicalWorkspace))),
      catch: () => invalidMarkerWorkspace(),
    });
    const expectedWorkspace = path.join(
      canonicalRoot,
      ".gaia",
      "runs",
      runId,
      "workspace"
    );
    if (
      requestedWorkspace !== expectedWorkspace ||
      canonicalWorkspace !== expectedWorkspace
    )
      return yield* Effect.fail(invalidMarkerWorkspace());

    const outputPath = path.join(canonicalWorkspace, "output.txt");
    const marker = `${runId}\n`;
    const exists = yield* fs.exists(outputPath);
    if (!exists)
      yield* fs
        .writeFileString(outputPath, marker, { flag: "wx" })
        .pipe(Effect.mapError(() => markerWriteFailed()));
    yield* verifyTestHarnessRunMarker(fs, outputPath, marker);
  }
);

function canonicalTestDirectory(fs: FileSystem.FileSystem, value: string) {
  return Effect.gen(function* () {
    const canonical = yield* fs
      .realPath(value)
      .pipe(Effect.mapError(() => invalidMarkerWorkspace()));
    const info = yield* fs
      .stat(canonical)
      .pipe(Effect.mapError(() => invalidMarkerWorkspace()));
    if (info.type !== "Directory")
      return yield* Effect.fail(invalidMarkerWorkspace());
    return canonical;
  });
}

function verifyTestHarnessRunMarker(
  fs: FileSystem.FileSystem,
  outputPath: string,
  marker: string
) {
  return Effect.gen(function* () {
    const canonical = yield* fs
      .realPath(outputPath)
      .pipe(Effect.mapError(() => markerWriteFailed()));
    const info = yield* fs
      .stat(outputPath)
      .pipe(Effect.mapError(() => markerWriteFailed()));
    const content = yield* fs
      .readFileString(outputPath)
      .pipe(Effect.mapError(() => markerWriteFailed()));
    if (canonical !== outputPath || info.type !== "File" || content !== marker)
      return yield* Effect.fail(markerWriteFailed());
  });
}

function invalidMarkerWorkspace() {
  return makeRuntimeError({
    code: "TestHarnessMarkerWorkspaceInvalid",
    message: "The test harness workspace does not have an exact run shape.",
    recoverable: false,
  });
}

function markerWriteFailed() {
  return makeRuntimeError({
    code: "TestHarnessMarkerWriteFailed",
    message: "The test harness could not write the exact run output marker.",
    recoverable: false,
  });
}

function testHarnessSession(sessionId: HarnessSessionId): HarnessSession {
  const turnId = parseHarnessTurnId("turn-test-worker");
  const events: ReadonlyArray<HarnessEvent> = [
    {
      capabilities: testHarnessCapabilities,
      kind: "sessionStarted",
      provider: testHarnessProvider.descriptor,
      sessionId,
      state: "running",
    },
    { kind: "turnStarted", sessionId, turnId },
    { kind: "turnCompleted", sessionId, status: "completed", turnId },
  ];
  return {
    events: Stream.fromIterable(events),
    interrupt: Option.some(Effect.void),
    resolveInteraction: () => Effect.void,
    send: () => Effect.succeed(undefined),
    snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
    steer: Option.none(),
  };
}
