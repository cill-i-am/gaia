import nodePath from "node:path";

import { NodeServices } from "@effect/platform-node";
import {
  HarnessCapabilities,
  HarnessLaunchObservationV1,
  HarnessSessionIdSchema,
  HarnessSessionEventBudgetBytes,
  HarnessProviderDescriptor,
  parseHarnessEvent,
  harnessEventByteLength,
  digestHarnessEnvironmentContract,
  parseHarnessProviderId,
  projectHarnessEvents,
  type HarnessEvent,
  type HarnessDetection,
  type HarnessInteractionId,
  type HarnessSessionId,
} from "@gaia/core";
import {
  Cause,
  Clock,
  Effect,
  FileSystem,
  Option,
  Path,
  Queue,
  Random,
  Schema,
  Semaphore,
  Stream,
  type Scope,
} from "effect";

import { type CodexAppServerClient } from "./codex-app-server-client.js";
import {
  CodexThreadIdSchema,
  CodexThreadRuntimeResultSchema,
  CodexTurnIdSchema,
  supportedCodexCliVersion,
  parseCodexModelId,
  parseCodexThreadId,
  parseCodexClientVersion,
  type CodexAppServerError,
  type CodexThread,
  type CodexThreadId,
  type CodexTurnId,
  type CodexServerRequest,
} from "./codex-app-server-protocol.js";
import { createCodexSessionMapper } from "./codex-session-mapper.js";
import {
  HarnessActionError,
  HarnessCheckpointTokenSchema,
  HarnessCorrelationTokenSchema,
  HarnessInput,
  HarnessInteractionResponseSchema,
  HarnessResumeError,
  HarnessSessionError,
  HarnessActionTransportWitness,
  HarnessStartError,
  type HarnessInteractionResponse,
  type HarnessCheckpointToken,
  type HarnessProvider,
  type HarnessSession,
  type HarnessSessionResume,
  type HarnessSessionStart,
} from "./harness-session.js";
import {
  parseRunStorageRootInput,
  parseRuntimePath,
  RunStorageRootInputSchema,
} from "./paths.js";
import type { HarnessLaunchObservationService } from "./worker-runtime-environment.js";

/** Stable capabilities implemented by the initial Codex App Server adapter. */
export const CodexHarnessCapabilities = HarnessCapabilities.make({
  approvals: [
    "command",
    "fileChange",
    "permission",
    "userInput",
    "mcpElicitation",
  ],
  durableCancellation: false,
  durableInteractionResolution: false,
  durablePause: false,
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: true,
  steering: true,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: true,
  usageReporting: true,
  userQuestions: true,
});

/** Stable provider descriptor persisted independently from Codex wire IDs. */
export const CodexHarnessProviderDescriptor = HarnessProviderDescriptor.make({
  displayName: "Codex App Server",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("codex-app-server"),
});

/** Serializable configuration for the Codex harness provider adapter. */
export class CodexHarnessProviderConfig extends Schema.Class<CodexHarnessProviderConfig>(
  "CodexHarnessProviderConfig"
)(
  {
    sensitiveValues: Schema.optionalKey(Schema.Array(Schema.String)),
    model: Schema.optionalKey(Schema.NonEmptyString),
    modelProvider: Schema.optionalKey(Schema.NonEmptyString),
    reasoningEffort: Schema.optionalKey(Schema.NonEmptyString),
    workspaceRoot: Schema.NonEmptyString,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

/** Capability dependencies plus schema-owned provider configuration. */
export type CodexHarnessProviderOptions = {
  readonly client: CodexAppServerClient;
  readonly config: CodexHarnessProviderConfig;
  readonly launchObservation?: HarnessLaunchObservationService["Service"];
  readonly path?: Path.Path;
  readonly correlationStore: CodexHarnessCorrelationStore;
  readonly detectionProbe?: Effect.Effect<HarnessDetection>;
};

/** Finite opaque adapter token persisted without exposing its native meaning. */
export class CodexHarnessOpaqueCorrelation extends Schema.Class<CodexHarnessOpaqueCorrelation>(
  "CodexHarnessOpaqueCorrelation"
)(
  { token: HarnessCorrelationTokenSchema },
  { parseOptions: { onExcessProperty: "error" } }
) {}

/** Typed persistence failure for the adapter-private correlation store. */
export class CodexHarnessCorrelationStoreError extends Schema.TaggedErrorClass<CodexHarnessCorrelationStoreError>()(
  "CodexHarnessCorrelationStoreError",
  {
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(512))),
    operation: Schema.Literals(["load", "save"] as const),
  }
) {}

/** Adapter-owned persistence seam for opaque Codex session correlation. */
export interface CodexHarnessCorrelationStore {
  readonly load: (
    sessionId: HarnessSessionId
  ) => Effect.Effect<
    CodexHarnessOpaqueCorrelation | undefined,
    CodexHarnessCorrelationStoreError
  >;
  readonly save: (
    sessionId: HarnessSessionId,
    correlation: CodexHarnessOpaqueCorrelation
  ) => Effect.Effect<void, CodexHarnessCorrelationStoreError>;
}

/** In-memory correlation store for tests and single-process composition. */
export function makeInMemoryCodexHarnessCorrelationStore(): CodexHarnessCorrelationStore {
  const correlations = new Map<
    HarnessSessionId,
    CodexHarnessOpaqueCorrelation
  >();
  return {
    load: (sessionId) => Effect.succeed(correlations.get(sessionId)),
    save: (sessionId, correlation) =>
      Effect.sync(() => {
        correlations.set(sessionId, correlation);
      }),
  };
}

class CodexHarnessCorrelationFile extends Schema.Class<CodexHarnessCorrelationFile>(
  "CodexHarnessCorrelationFile"
)(
  {
    harnessProfileId: Schema.Literal("codexAppServer"),
    providerId: Schema.Literal("codex-app-server"),
    sessionId: HarnessSessionIdSchema,
    token: HarnessCorrelationTokenSchema,
    version: Schema.Literal(1),
  },
  {
    parseOptions: { onExcessProperty: "error" },
  }
) {}
const CodexHarnessCorrelationFileJson = Schema.toCodecJson(
  CodexHarnessCorrelationFile
);
const decodeCodexHarnessCorrelationFile = Schema.decodeUnknownSync(
  CodexHarnessCorrelationFileJson
);
const encodeCodexHarnessCorrelationFile = Schema.encodeSync(
  CodexHarnessCorrelationFileJson
);
const decodeCodexHarnessOpaqueCorrelation = Schema.decodeUnknownSync(
  CodexHarnessOpaqueCorrelation
);
const correlationFileMaxBytes = 49_152;

/** Durable adapter-private correlation store excluded from public run contracts. */
export function makeFileCodexHarnessCorrelationStore(
  rootDirectory: typeof RunStorageRootInputSchema.Encoded,
  services?: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }
): CodexHarnessCorrelationStore {
  const parsedRootDirectory = parseRunStorageRootInput(rootDirectory);
  const buildStore = (
    fs: FileSystem.FileSystem,
    pathService: Path.Path
  ): CodexHarnessCorrelationStore => {
    const directory = pathService.join(
      parsedRootDirectory,
      ".gaia",
      "private",
      "harness-correlations"
    );
    const correlationPath = (sessionId: HarnessSessionId) =>
      pathService.join(
        directory,
        `${digestHarnessEnvironmentContract("gaia.harness-correlation-path.v1", [sessionId])}.json`
      );
    const failure = (operation: "load" | "save") =>
      new CodexHarnessCorrelationStoreError({
        message: `Codex harness correlation could not be ${operation === "load" ? "loaded" : "saved"}.`,
        operation,
      });
    return {
      load: (sessionId: HarnessSessionId) =>
        Effect.gen(function* () {
          const target = correlationPath(sessionId);
          if (!(yield* fs.exists(target))) return undefined;
          const info = yield* fs.stat(target);
          if (info.type !== "File" || info.size > correlationFileMaxBytes)
            return yield* Effect.fail(failure("load"));
          const contents = yield* fs.readFileString(target);
          const parsed = yield* Effect.try({
            try: () => decodeCodexHarnessCorrelationFile(JSON.parse(contents)),
            catch: () => failure("load"),
          });
          if (parsed.sessionId !== sessionId)
            return yield* Effect.fail(failure("load"));
          return CodexHarnessOpaqueCorrelation.make({ token: parsed.token });
        }).pipe(Effect.mapError(() => failure("load"))),
      save: (
        sessionId: HarnessSessionId,
        correlation: CodexHarnessOpaqueCorrelation
      ) =>
        Effect.gen(function* () {
          const parsedCorrelation =
            decodeCodexHarnessOpaqueCorrelation(correlation);
          yield* fs.makeDirectory(directory, {
            mode: 0o700,
            recursive: true,
          });
          const target = correlationPath(sessionId);
          const suffix = yield* randomSuffix(16);
          const temporary = `${target}.${suffix}.tmp`;
          const record = CodexHarnessCorrelationFile.make({
            harnessProfileId: "codexAppServer",
            providerId: "codex-app-server",
            sessionId,
            token: parsedCorrelation.token,
            version: 1,
          });
          yield* fs
            .writeFileString(
              temporary,
              `${JSON.stringify(encodeCodexHarnessCorrelationFile(record))}\n`,
              { flag: "wx", mode: 0o600 }
            )
            .pipe(
              Effect.andThen(fs.rename(temporary, target)),
              Effect.onExit(() =>
                fs.remove(temporary).pipe(Effect.orElseSucceed(() => undefined))
              )
            );
        }).pipe(Effect.mapError(() => failure("save"))),
    };
  };
  if (services !== undefined)
    return buildStore(services.fileSystem, services.path);
  return Effect.runSync(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      return buildStore(fs, pathService);
    }).pipe(Effect.provide(NodeServices.layer))
  );
}

function randomSuffix(length: number) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Effect.gen(function* () {
    let suffix = "";
    for (let index = 0; index < length; index += 1) {
      const position = yield* Random.nextIntBetween(0, alphabet.length);
      suffix += alphabet[position];
    }
    return suffix;
  });
}

/** Build the first rich HarnessProvider implementation over the landed GAIA-83 client. */
export function createCodexHarnessProvider(
  options: CodexHarnessProviderOptions
): HarnessProvider {
  let initializedDetection: HarnessDetection | undefined;
  const initializationSemaphore = Semaphore.makeUnsafe(1);
  const initialize = initializationSemaphore.withPermits(1)(
    Effect.suspend(() => {
      if (initializedDetection !== undefined)
        return Effect.succeed(initializedDetection);
      return options.client
        .initialize({
          clientInfo: {
            name: "gaia",
            title: "Gaia",
            version: parseCodexClientVersion("0.1.0"),
          },
        })
        .pipe(
          Effect.match({
            onFailure: (error: CodexAppServerError) => {
              initializedDetection = detectionFromCodexError(error);
              return initializedDetection;
            },
            onSuccess: () => {
              initializedDetection = availableCodexDetection();
              return initializedDetection;
            },
          })
        );
    })
  );
  const detect = Effect.gen(function* () {
    const probe = yield* (
      options.detectionProbe ?? Effect.succeed(availableCodexDetection())
    );
    if (probe.state !== "available") return probe;
    const initialized = yield* initialize;
    return initialized.state === "available"
      ? { ...probe, capabilities: CodexHarnessCapabilities }
      : initialized;
  });

  return {
    createSession: (request) =>
      Effect.gen(function* () {
        const detection = yield* detect;
        if (detection.state !== "available") {
          return yield* new HarnessStartError({
            message: "Codex App Server is not available for session start.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          });
        }
        const existingCorrelation = yield* options.correlationStore
          .load(request.sessionId)
          .pipe(
            Effect.mapError(
              () =>
                new HarnessStartError({
                  message: "Codex session correlation could not be loaded.",
                  providerId: CodexHarnessProviderDescriptor.providerId,
                })
            )
          );
        if (existingCorrelation !== undefined) {
          const correlatedThreadId =
            decodeCodexHarnessCorrelation(existingCorrelation);
          if (correlatedThreadId === undefined)
            return yield* new HarnessStartError({
              message: "Codex session correlation is invalid.",
              providerId: CodexHarnessProviderDescriptor.providerId,
            });
          const resumed = yield* options.client
            .resumeThread({ threadId: correlatedThreadId })
            .pipe(
              Effect.mapError(
                () =>
                  new HarnessStartError({
                    message:
                      "Codex App Server could not recover the session thread.",
                    providerId: CodexHarnessProviderDescriptor.providerId,
                  })
              )
            );
          if (resumed.thread.id !== correlatedThreadId)
            return yield* new HarnessStartError({
              message:
                "Codex recovered a thread that does not match stored session correlation.",
              providerId: CodexHarnessProviderDescriptor.providerId,
            });
          const recovered = yield* options.client
            .readThread({ includeTurns: true, threadId: correlatedThreadId })
            .pipe(
              Effect.mapError(
                () =>
                  new HarnessStartError({
                    message:
                      "Codex App Server could not read the recovered session.",
                    providerId: CodexHarnessProviderDescriptor.providerId,
                  })
              )
            );
          if (recovered.thread.id !== correlatedThreadId)
            return yield* new HarnessStartError({
              message:
                "Codex read a thread that does not match stored session correlation.",
              providerId: CodexHarnessProviderDescriptor.providerId,
            });
          yield* validateAndRecordLaunchObservation(
            options,
            request.sessionId,
            resumed,
            absoluteWorkspacePath(
              options.config.workspaceRoot,
              request.workspacePath,
              options.path
            ),
            () =>
              new HarnessStartError({
                message: "Codex App Server returned a mismatched runtime.",
                providerId: CodexHarnessProviderDescriptor.providerId,
              })
          );
          const recoveredTurn = recovered.thread.turns?.at(-1);
          return yield* makeCodexSession(
            {
              nativeThreadId: correlatedThreadId,
              options,
              ...(recoveredTurn === undefined
                ? {}
                : { recoveredProjectionTurnId: recoveredTurn.id }),
              recoveredThread: recovered.thread,
              request:
                recoveredTurn === undefined
                  ? request
                  : {
                      sessionId: request.sessionId,
                      workspacePath: request.workspacePath,
                    },
            },
            () =>
              new HarnessStartError({
                message: "Codex App Server could not recover the session.",
                providerId: CodexHarnessProviderDescriptor.providerId,
              })
          );
        }
        const thread = yield* options.client
          .startThread({
            approvalPolicy: "on-request",
            cwd: absoluteWorkspacePath(
              options.config.workspaceRoot,
              request.workspacePath,
              options.path
            ),
            ephemeral: false,
            ...(options.config.model === undefined
              ? {}
              : { model: parseCodexModelId(options.config.model) }),
            sandbox: "workspace-write",
          })
          .pipe(
            Effect.mapError(
              () =>
                new HarnessStartError({
                  message:
                    "Codex App Server could not start the session thread.",
                  providerId: CodexHarnessProviderDescriptor.providerId,
                })
            )
          );
        yield* validateAndRecordLaunchObservation(
          options,
          request.sessionId,
          thread,
          absoluteWorkspacePath(
            options.config.workspaceRoot,
            request.workspacePath,
            options.path
          ),
          () =>
            new HarnessStartError({
              message: "Codex App Server returned a mismatched runtime.",
              providerId: CodexHarnessProviderDescriptor.providerId,
            })
        );
        yield* options.correlationStore
          .save(
            request.sessionId,
            encodeCodexHarnessCorrelation(thread.thread.id)
          )
          .pipe(
            Effect.mapError(
              () =>
                new HarnessStartError({
                  message: "Codex session correlation could not be persisted.",
                  providerId: CodexHarnessProviderDescriptor.providerId,
                })
            )
          );
        return yield* makeCodexSession(
          {
            nativeThreadId: thread.thread.id,
            options,
            request,
          },
          () =>
            new HarnessStartError({
              message: "Codex App Server could not start the initial turn.",
              providerId: CodexHarnessProviderDescriptor.providerId,
            })
        );
      }),
    descriptor: CodexHarnessProviderDescriptor,
    detect,
    resumeSession: (request) =>
      Effect.gen(function* () {
        const detection = yield* detect;
        if (detection.state !== "available") {
          return yield* new HarnessResumeError({
            message: "Codex App Server is not available for session resume.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          });
        }
        const correlation = yield* options.correlationStore
          .load(request.sessionId)
          .pipe(
            Effect.mapError(
              () =>
                new HarnessResumeError({
                  message: "Codex session correlation could not be loaded.",
                  providerId: CodexHarnessProviderDescriptor.providerId,
                })
            )
          );
        const correlatedThreadId =
          correlation === undefined
            ? undefined
            : decodeCodexHarnessCorrelation(correlation);
        if (correlatedThreadId === undefined) {
          return yield* new HarnessResumeError({
            message: "Codex session correlation is unavailable for resume.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          });
        }
        const thread = yield* options.client
          .resumeThread({ threadId: correlatedThreadId })
          .pipe(
            Effect.mapError(
              () =>
                new HarnessResumeError({
                  message:
                    "Codex App Server could not resume the session thread.",
                  providerId: CodexHarnessProviderDescriptor.providerId,
                })
            )
          );
        if (thread.thread.id !== correlatedThreadId) {
          return yield* new HarnessResumeError({
            message:
              "Codex resumed a thread that does not match stored session correlation.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          });
        }
        const recovered = yield* options.client
          .readThread({ includeTurns: true, threadId: thread.thread.id })
          .pipe(
            Effect.mapError(
              () =>
                new HarnessResumeError({
                  message:
                    "Codex App Server could not read the recovered session.",
                  providerId: CodexHarnessProviderDescriptor.providerId,
                })
            )
          );
        if (recovered.thread.id !== correlatedThreadId) {
          return yield* new HarnessResumeError({
            message:
              "Codex read a thread that does not match stored session correlation.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          });
        }
        const expectedTurnId =
          request.expectedCheckpoint === undefined
            ? undefined
            : decodeCodexHarnessCheckpoint(request.expectedCheckpoint);
        if (
          request.expectedCheckpoint !== undefined &&
          expectedTurnId === undefined
        ) {
          return yield* new HarnessResumeError({
            message: "Codex session checkpoint is invalid for this provider.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          });
        }
        let recoveredProjectionTurnId: CodexTurnId | undefined;
        let suppressRecoveredProjectionTurn = false;
        if (expectedTurnId !== undefined) {
          const turns = recovered.thread.turns ?? [];
          const matches = turns.filter(({ id }) => id === expectedTurnId);
          const exact = matches[0];
          const allowedStatuses =
            request.allowInterruptedCheckpoint === true
              ? ["inProgress", "completed", "failed", "interrupted"]
              : ["inProgress", "completed", "failed"];
          if (
            matches.length !== 1 ||
            turns.at(-1)?.id !== expectedTurnId ||
            exact?.status === undefined ||
            !allowedStatuses.includes(exact.status)
          ) {
            return yield* new HarnessResumeError({
              message:
                "Codex recovered thread does not end at the exact checkpointed turn.",
              providerId: CodexHarnessProviderDescriptor.providerId,
            });
          }
          suppressRecoveredProjectionTurn =
            request.allowInterruptedCheckpoint === true &&
            exact.status === "interrupted";
          recoveredProjectionTurnId = exact.id;
        }
        yield* validateAndRecordLaunchObservation(
          options,
          request.sessionId,
          thread,
          absoluteWorkspacePath(
            options.config.workspaceRoot,
            request.workspacePath,
            options.path
          ),
          () =>
            new HarnessResumeError({
              message: "Codex App Server returned a mismatched runtime.",
              providerId: CodexHarnessProviderDescriptor.providerId,
            })
        );
        return yield* makeCodexSession(
          {
            nativeThreadId: thread.thread.id,
            options,
            ...(recoveredProjectionTurnId === undefined
              ? {}
              : { recoveredProjectionTurnId }),
            ...(suppressRecoveredProjectionTurn
              ? { suppressRecoveredProjectionTurn }
              : {}),
            recoveredThread: recovered.thread,
            request,
          },
          () =>
            new HarnessResumeError({
              message: "Codex App Server could not restore the session.",
              providerId: CodexHarnessProviderDescriptor.providerId,
            })
        );
      }),
  };
}

function validateAndRecordLaunchObservation<E>(
  options: CodexHarnessProviderOptions,
  sessionId: HarnessSessionId,
  result: typeof CodexThreadRuntimeResultSchema.Type,
  expectedCwd: string,
  mismatch: () => E
): Effect.Effect<void, E> {
  const expectedModel = options.config.model;
  const expectedProvider = options.config.modelProvider;
  const expectedReasoning = options.config.reasoningEffort;
  if (
    expectedModel === undefined ||
    expectedProvider === undefined ||
    expectedReasoning === undefined
  )
    return Effect.void;
  if (
    result.model !== expectedModel ||
    result.modelProvider !== expectedProvider ||
    result.reasoningEffort !== expectedReasoning ||
    result.approvalPolicy !== "on-request" ||
    result.sandbox.type !== "workspaceWrite" ||
    result.cwd !== expectedCwd
  )
    return Effect.fail(mismatch());
  if (options.launchObservation === undefined) return Effect.void;
  return options.launchObservation
    .complete(
      sessionId,
      HarnessLaunchObservationV1.make({
        approvalPolicy: "on-request",
        cwdMatchesWorkspaceBinding: true,
        model: expectedModel,
        modelProvider: expectedProvider,
        reasoningEffort: expectedReasoning,
        sandbox: "workspace-write",
        source: "threadRuntimeResult",
      })
    )
    .pipe(Effect.mapError(() => mismatch()));
}

function makeCodexSession<E>(
  input: {
    readonly nativeThreadId: CodexThreadId;
    readonly options: CodexHarnessProviderOptions;
    readonly recoveredProjectionTurnId?: CodexTurnId;
    readonly recoveredThread?: CodexThread;
    readonly request: HarnessSessionStart | HarnessSessionResume;
    readonly suppressRecoveredProjectionTurn?: boolean;
  },
  initialTurnError: () => E
): Effect.Effect<HarnessSession, E, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.bounded<HarnessEvent, HarnessSessionError>(
      2_000
    );
    const mapper = createCodexSessionMapper({
      capabilities: CodexHarnessCapabilities,
      provider: CodexHarnessProviderDescriptor,
      ...(input.options.config.sensitiveValues === undefined
        ? {}
        : { sensitiveValues: input.options.config.sensitiveValues }),
      sessionId: input.request.sessionId,
      workspaceRoot: absoluteWorkspacePath(
        input.options.config.workspaceRoot,
        input.request.workspacePath,
        input.options.path
      ),
    });
    const recoveredThreadForProjection =
      input.recoveredThread === undefined ||
      input.recoveredProjectionTurnId === undefined
        ? input.recoveredThread
        : {
            ...input.recoveredThread,
            turns:
              input.suppressRecoveredProjectionTurn === true
                ? []
                : (input.recoveredThread.turns ?? []).filter(
                    ({ id }) => id === input.recoveredProjectionTurnId
                  ),
          };
    const projectedEvents: Array<HarnessEvent> = [];
    const pendingRequests = new Map<HarnessInteractionId, CodexServerRequest>();
    let activeTurnId: CodexTurnId | undefined;
    let adapterFailed = false;
    let bufferFailed = false;
    let projectedEventBytes = 0;
    const dispatchedClientInputIds = new Set(
      (input.recoveredThread?.turns ?? []).flatMap((turn) =>
        (turn.items ?? []).flatMap((item) =>
          item.type === "userMessage" &&
          item.clientId !== undefined &&
          item.clientId !== null
            ? [item.clientId]
            : []
        )
      )
    );

    const failEventBuffer = (message: string) => {
      if (bufferFailed) return;
      const failure = parseHarnessEvent({
        failure: {
          code: "CodexEventBufferExceeded",
          kind: "providerFailure",
          message,
          recoverable: false,
        },
        kind: "sessionFailed",
        sessionId: input.request.sessionId,
      });
      bufferFailed = true;
      activeTurnId = undefined;
      pendingRequests.clear();
      projectedEventBytes += harnessEventByteLength(failure);
      projectedEvents.push(failure);
      Queue.offerUnsafe(queue, failure);
      Queue.failCauseUnsafe(
        queue,
        Cause.fail(
          new HarnessSessionError({
            message,
            providerId: CodexHarnessProviderDescriptor.providerId,
          })
        )
      );
    };

    const emit = (events: ReadonlyArray<HarnessEvent>) => {
      for (const event of events) {
        if (bufferFailed) return;
        const parsed = parseHarnessEvent(event);
        const eventBytes = harnessEventByteLength(parsed);
        if (
          projectedEvents.length >= 1_999 ||
          projectedEventBytes + eventBytes >
            HarnessSessionEventBudgetBytes - 1_024
        ) {
          failEventBuffer("Codex session exceeded its bounded event buffer.");
          return;
        }
        projectedEventBytes += eventBytes;
        projectedEvents.push(parsed);
        if (!Queue.offerUnsafe(queue, parsed)) {
          failEventBuffer("Codex session live event consumer fell behind.");
        }
      }
    };

    const failLiveStream = (message: string) => {
      Queue.failCauseUnsafe(
        queue,
        Cause.fail(
          new HarnessSessionError({
            message,
            providerId: CodexHarnessProviderDescriptor.providerId,
          })
        )
      );
    };

    const terminateSession = (
      events: ReadonlyArray<HarnessEvent>,
      message: string
    ) => {
      if (adapterFailed || bufferFailed) return;
      adapterFailed = true;
      activeTurnId = undefined;
      pendingRequests.clear();
      emit(events);
      if (!bufferFailed) failLiveStream(message);
    };

    const emitProviderEvents = (events: ReadonlyArray<HarnessEvent>) => {
      if (adapterFailed || bufferFailed) return;
      if (events.some((event) => event.kind === "sessionFailed")) {
        terminateSession(
          events,
          "Codex session reached a terminal provider failure."
        );
        return;
      }
      emit(events);
    };

    const mapOrFail = (
      map: () => ReadonlyArray<HarnessEvent>
    ): ReadonlyArray<HarnessEvent> => {
      if (adapterFailed || bufferFailed) return [];
      try {
        return map();
      } catch {
        terminateSession(
          [
            parseHarnessEvent({
              failure: {
                code: "CodexProjectionRejected",
                kind: "providerFailure",
                message:
                  "Codex emitted an event outside Gaia's safe projection limits.",
                recoverable: false,
              },
              kind: "sessionFailed",
              sessionId: input.request.sessionId,
            }),
          ],
          "Codex session projection was rejected."
        );
        return [];
      }
    };

    emitProviderEvents(
      mapOrFail(() =>
        mapper.mapNotification({
          method: "thread/started",
          params: { thread: { id: input.nativeThreadId } },
        })
      )
    );

    const removeNotification = input.options.client.onNotification(
      (notification) => {
        const events = mapOrFail(() => mapper.mapNotification(notification));
        for (const event of events) {
          if (event.kind === "interactionCancelled") {
            pendingRequests.delete(event.interactionId);
          }
        }
        if (notification.method === "turn/started") {
          if (events.some((event) => event.kind === "turnStarted")) {
            activeTurnId = notification.params.turn.id;
          }
        } else if (
          notification.method === "turn/completed" &&
          activeTurnId === notification.params.turn.id &&
          events.some((event) => event.kind === "turnCompleted")
        ) {
          activeTurnId = undefined;
        } else if (notification.method === "serverRequest/resolved") {
          for (const [interactionId, request] of pendingRequests) {
            if (request.id === notification.params.requestId) {
              pendingRequests.delete(interactionId);
            }
          }
        }
        emitProviderEvents(events);
      }
    );
    const removeRequest = input.options.client.onServerRequest((request) => {
      const events = mapOrFail(() => mapper.mapServerRequest(request));
      for (const event of events) {
        if (event.kind === "interactionRequested") {
          pendingRequests.set(event.interaction.interactionId, request);
        }
      }
      emitProviderEvents(events);
    });
    const removeTermination = input.options.client.onTermination(() => {
      const message =
        "Codex App Server terminated before the session completed.";
      terminateSession(
        [
          parseHarnessEvent({
            failure: {
              code: "CodexAppServerTerminated",
              kind: "providerFailure",
              message,
              recoverable: true,
            },
            kind: "sessionFailed",
            sessionId: input.request.sessionId,
          }),
        ],
        message
      );
    });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        removeNotification();
        removeRequest();
        removeTermination();
        yield* Queue.shutdown(queue);
      })
    );

    if (
      recoveredThreadForProjection !== undefined &&
      !adapterFailed &&
      !bufferFailed
    ) {
      emitProviderEvents([
        parseHarnessEvent({
          kind: "sessionRecovered",
          sessionId: input.request.sessionId,
        }),
      ]);
      emitProviderEvents(
        mapOrFail(() => mapper.mapRecoveredThread(recoveredThreadForProjection))
      );
      if (!adapterFailed && !bufferFailed) {
        activeTurnId = [...(recoveredThreadForProjection.turns ?? [])]
          .reverse()
          .find((turn) => turn.status === "inProgress")?.id;
      }
    }

    if ("input" in input.request && !adapterFailed && !bufferFailed) {
      const turn = yield* input.options.client
        .startTurn({
          ...(input.request.input.clientInputId === undefined
            ? {}
            : { clientUserMessageId: input.request.input.clientInputId }),
          input: [{ text: input.request.input.text, type: "text" }],
          threadId: input.nativeThreadId,
        })
        .pipe(Effect.mapError(initialTurnError));
      if (!adapterFailed && !bufferFailed) {
        activeTurnId = turn.turn.id;
        emitProviderEvents(
          mapOrFail(() =>
            mapper.mapNotification({
              method: "turn/started",
              params: {
                threadId: input.nativeThreadId,
                turn: { id: turn.turn.id, status: "inProgress" },
              },
            })
          )
        );
      }
    }

    const session: HarnessSession = {
      events: Stream.fromQueue(queue),
      interrupt: Option.some(
        Effect.suspend(() => {
          if (adapterFailed || bufferFailed) {
            return Effect.fail(
              actionError("interrupt", "The Codex session is terminal.")
            );
          }
          if (activeTurnId === undefined) {
            return Effect.fail(
              actionError("interrupt", "No active Codex turn to interrupt.")
            );
          }
          return input.options.client
            .interruptTurn({
              threadId: input.nativeThreadId,
              turnId: activeTurnId,
            })
            .pipe(
              Effect.mapError(() =>
                actionError("interrupt", "Codex turn interruption failed.")
              )
            );
        })
      ),
      resolveInteraction: (response) =>
        Schema.decodeUnknownEffect(HarnessInteractionResponseSchema)(
          response
        ).pipe(
          Effect.mapError(() =>
            actionError(
              "resolveInteraction",
              "The Codex interaction response is invalid."
            )
          ),
          Effect.flatMap((parsedResponse) => {
            if (adapterFailed || bufferFailed) {
              return Effect.fail(
                actionError(
                  "resolveInteraction",
                  "The Codex session is terminal."
                )
              );
            }
            if (!interactionResponseWithinBudget(parsedResponse)) {
              return Effect.fail(
                actionError(
                  "resolveInteraction",
                  "The Codex interaction response exceeds its size limit."
                )
              );
            }
            const request = pendingRequests.get(parsedResponse.interactionId);
            if (request === undefined) {
              return Effect.fail(
                actionError(
                  "resolveInteraction",
                  "The Codex interaction is stale or already resolved."
                )
              );
            }
            return respondToCodexRequest(
              input.options.client,
              mapper,
              request,
              parsedResponse
            ).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (adapterFailed || bufferFailed) return;
                  pendingRequests.delete(parsedResponse.interactionId);
                  const resolvedAt = new Date(
                    yield* Clock.currentTimeMillis
                  ).toISOString();
                  const auditDecision =
                    parsedResponse.kind === "approval"
                      ? parsedResponse.decision
                      : parsedResponse.kind === "userInput"
                        ? "submit"
                        : parsedResponse.action;
                  emitProviderEvents(
                    mapper.resolveServerRequest(request.id, {
                      actionId: parsedResponse.actionId,
                      decision: auditDecision,
                      resolvedAt,
                      responseKind: parsedResponse.kind,
                    })
                  );
                })
              )
            );
          })
        ),
      send: (message) =>
        Schema.decodeUnknownEffect(HarnessInput)(message).pipe(
          Effect.mapError(() =>
            actionError("send", "Codex follow-up input is invalid.")
          ),
          Effect.flatMap((parsedMessage) => {
            if (adapterFailed || bufferFailed) {
              return Effect.fail(
                actionError("send", "The Codex session is terminal.")
              );
            }
            if (
              parsedMessage.clientInputId !== undefined &&
              dispatchedClientInputIds.has(parsedMessage.clientInputId)
            ) {
              return Effect.succeed(undefined);
            }
            return input.options.client
              .startTurn({
                ...(parsedMessage.clientInputId === undefined
                  ? {}
                  : { clientUserMessageId: parsedMessage.clientInputId }),
                input: [{ text: parsedMessage.text, type: "text" }],
                threadId: input.nativeThreadId,
              })
              .pipe(
                Effect.tap((turn) =>
                  Effect.sync(() => {
                    if (adapterFailed || bufferFailed) return;
                    if (parsedMessage.clientInputId !== undefined) {
                      dispatchedClientInputIds.add(parsedMessage.clientInputId);
                    }
                    activeTurnId = turn.turn.id;
                    emitProviderEvents(
                      mapOrFail(() =>
                        mapper.mapNotification({
                          method: "turn/started",
                          params: {
                            threadId: input.nativeThreadId,
                            turn: { id: turn.turn.id, status: "inProgress" },
                          },
                        })
                      )
                    );
                  })
                ),
                Effect.as(
                  HarnessActionTransportWitness.make({
                    kind: "codexAppServerTransportOffered",
                    version: 1,
                  })
                ),
                Effect.mapError(() =>
                  actionError("send", "Codex follow-up turn failed.")
                )
              );
          })
        ),
      snapshot: Effect.try({
        try: () =>
          projectHarnessEvents(projectedEvents, input.request.sessionId),
        catch: () =>
          new HarnessSessionError({
            message: "Codex session projection could not be rebuilt.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          }),
      }),
      steer: Option.some((message) =>
        Schema.decodeUnknownEffect(HarnessInput)(message).pipe(
          Effect.mapError(() =>
            actionError("steer", "Codex steering input is invalid.")
          ),
          Effect.flatMap((parsedMessage) =>
            Effect.suspend(() => {
              if (adapterFailed || bufferFailed) {
                return Effect.fail(
                  actionError("steer", "The Codex session is terminal.")
                );
              }
              if (activeTurnId === undefined) {
                return Effect.fail(
                  actionError("steer", "No active Codex turn to steer.")
                );
              }
              return input.options.client
                .steerTurn({
                  expectedTurnId: activeTurnId,
                  input: [{ text: parsedMessage.text, type: "text" }],
                  threadId: input.nativeThreadId,
                })
                .pipe(
                  Effect.as(
                    HarnessActionTransportWitness.make({
                      kind: "codexAppServerTransportOffered",
                      version: 1,
                    })
                  ),
                  Effect.mapError(() =>
                    actionError("steer", "Codex turn steering failed.")
                  )
                );
            })
          )
        )
      ),
    };
    return session;
  });
}

function respondToCodexRequest(
  client: CodexAppServerClient,
  mapper: ReturnType<typeof createCodexSessionMapper>,
  request: CodexServerRequest,
  response: HarnessInteractionResponse
) {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      if (
        response.kind !== "approval" ||
        !mapper.approvalDecisionAllowed(request.id, response.decision)
      ) {
        return invalidInteractionResponse();
      }
      return client
        .respondCommandApproval(request, {
          decision: mapApprovalDecision(response.decision),
        })
        .pipe(mapInteractionResponseError);
    case "item/fileChange/requestApproval":
      if (
        response.kind !== "approval" ||
        !mapper.approvalDecisionAllowed(request.id, response.decision)
      ) {
        return invalidInteractionResponse();
      }
      return client
        .respondFileApproval(request, {
          decision: mapApprovalDecision(response.decision),
        })
        .pipe(mapInteractionResponseError);
    case "item/permissions/requestApproval":
      if (
        response.kind !== "approval" ||
        response.decision === "approveForSession" ||
        !mapper.approvalDecisionAllowed(request.id, response.decision)
      ) {
        return invalidInteractionResponse();
      }
      const permissions = mapper.permissionApproval(request.id);
      if (response.decision === "approve" && permissions === undefined) {
        return invalidInteractionResponse();
      }
      return client
        .respondPermissionApproval(request, {
          permissions:
            response.decision === "approve" ? (permissions ?? {}) : {},
          scope: "turn",
        })
        .pipe(mapInteractionResponseError);
    case "item/tool/requestUserInput":
      if (response.kind !== "userInput") {
        return invalidInteractionResponse();
      }
      const answers = mapper.mapUserInputAnswers(request.id, response.answers);
      if (answers === undefined) return invalidInteractionResponse();
      return client
        .respondUserInput(request, { answers })
        .pipe(mapInteractionResponseError);
    case "mcpServer/elicitation/request":
      if (response.kind !== "mcpElicitation")
        return invalidInteractionResponse();
      return client
        .respondElicitation(request, {
          _meta: null,
          action: response.action === "submit" ? "accept" : response.action,
          content: response.content ?? null,
        })
        .pipe(mapInteractionResponseError);
  }
}

const mapInteractionResponseError = Effect.mapError(() =>
  actionError("resolveInteraction", "Codex interaction response failed.")
);

function invalidInteractionResponse() {
  return Effect.fail(
    actionError(
      "resolveInteraction",
      "The interaction response does not match the pending Codex request."
    )
  );
}

function interactionResponseWithinBudget(
  response: HarnessInteractionResponse
): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(response)).byteLength <= 1_048_576
  );
}

function actionError(
  actionKind: "send" | "steer" | "interrupt" | "resolveInteraction",
  message: string
) {
  return new HarnessActionError({
    actionKind,
    message,
    providerId: CodexHarnessProviderDescriptor.providerId,
  });
}

function mapApprovalDecision(
  decision: "approve" | "approveForSession" | "decline" | "cancel"
) {
  switch (decision) {
    case "approve":
      return "accept" as const;
    case "approveForSession":
      return "acceptForSession" as const;
    case "decline":
    case "cancel":
      return decision;
  }
}

function absoluteWorkspacePath(
  root: string,
  relativePath:
    | HarnessSessionStart["workspacePath"]
    | HarnessSessionResume["workspacePath"],
  injectedPath?: Pick<Path.Path, "resolve">
) {
  const pathService = injectedPath ?? nodePath;
  return parseRuntimePath(
    pathService.resolve(root, relativePath === "." ? "" : relativePath)
  );
}

function availableCodexDetection(): HarnessDetection {
  return {
    auth: { state: "unknown" },
    capabilities: CodexHarnessCapabilities,
    state: "available",
    version: supportedCodexCliVersion,
  };
}

function detectionFromCodexError(error: CodexAppServerError): HarnessDetection {
  switch (error._tag) {
    case "CodexAppServerIncompatibilityError":
      return {
        reason:
          "Codex App Server version is incompatible with this Gaia adapter.",
        state: "incompatible",
        version: boundedVersion(error.actualUserAgent),
      };
    case "CodexAppServerProtocolError":
      return {
        reason:
          "Codex App Server did not complete the expected initialize protocol.",
        state: "incompatible",
        version: "unknown",
      };
    case "CodexAppServerProcessExitError":
    case "CodexAppServerTimeoutError":
    case "CodexAppServerTransportError":
      return { state: "missing" };
  }
}

function boundedVersion(userAgent: string): string {
  const match =
    /\b(?:Codex|gaia)\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/iu.exec(
      userAgent
    );
  return (match?.[1] ?? "unknown").slice(0, 200);
}

class CodexHarnessCorrelationPayload extends Schema.Class<CodexHarnessCorrelationPayload>(
  "CodexHarnessCorrelationPayload"
)(
  {
    provider: Schema.Literal("codex-app-server"),
    threadId: CodexThreadIdSchema,
    version: Schema.Literal(1),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

class CodexHarnessCheckpointPayload extends Schema.Class<CodexHarnessCheckpointPayload>(
  "CodexHarnessCheckpointPayload"
)(
  {
    provider: Schema.Literal("codex-app-server"),
    turnId: CodexTurnIdSchema,
    version: Schema.Literal(1),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

const CodexHarnessCorrelationPayloadJson = Schema.toCodecJson(
  CodexHarnessCorrelationPayload
);
const CodexHarnessCheckpointPayloadJson = Schema.toCodecJson(
  CodexHarnessCheckpointPayload
);
const encodeCodexHarnessCorrelationPayload = Schema.encodeSync(
  CodexHarnessCorrelationPayloadJson
);
const encodeCodexHarnessCheckpointPayload = Schema.encodeSync(
  CodexHarnessCheckpointPayloadJson
);
const decodeCodexHarnessCorrelationPayload = Schema.decodeUnknownSync(
  CodexHarnessCorrelationPayloadJson
);
const decodeCodexHarnessCheckpointPayload = Schema.decodeUnknownSync(
  CodexHarnessCheckpointPayloadJson
);

/** Encode a Codex thread identity into a versioned provider-neutral token. */
export function encodeCodexHarnessCorrelation(
  threadId: CodexThreadId
): CodexHarnessOpaqueCorrelation {
  const payload = CodexHarnessCorrelationPayload.make({
    provider: "codex-app-server",
    threadId,
    version: 1,
  });
  const encoded = Buffer.from(
    JSON.stringify(encodeCodexHarnessCorrelationPayload(payload)),
    "utf8"
  ).toString("base64url");
  const token = Schema.decodeUnknownSync(HarnessCorrelationTokenSchema)(
    `hcor1_${encoded}`
  );
  return CodexHarnessOpaqueCorrelation.make({ token });
}

export function decodeCodexHarnessCorrelation(
  correlation: CodexHarnessOpaqueCorrelation
): CodexThreadId | undefined {
  try {
    const parsed = decodeCodexHarnessOpaqueCorrelation(correlation);
    const encoded = parsed.token.slice("hcor1_".length);
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    );
    return decodeCodexHarnessCorrelationPayload(decoded).threadId;
  } catch {
    return undefined;
  }
}

/** Encode a Codex turn identity into a distinct versioned checkpoint token. */
export function encodeCodexHarnessCheckpoint(
  turnId: CodexTurnId
): HarnessCheckpointToken {
  const payload = CodexHarnessCheckpointPayload.make({
    provider: "codex-app-server",
    turnId,
    version: 1,
  });
  const encoded = Buffer.from(
    JSON.stringify(encodeCodexHarnessCheckpointPayload(payload)),
    "utf8"
  ).toString("base64url");
  return Schema.decodeUnknownSync(HarnessCheckpointTokenSchema)(
    `hchk1_${encoded}`
  );
}

/** Decode an opaque checkpoint only inside the Codex adapter boundary. */
export function decodeCodexHarnessCheckpoint(
  checkpoint: HarnessCheckpointToken
): CodexTurnId | undefined {
  try {
    const encoded = checkpoint.slice("hchk1_".length);
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    );
    return decodeCodexHarnessCheckpointPayload(decoded).turnId;
  } catch {
    return undefined;
  }
}
