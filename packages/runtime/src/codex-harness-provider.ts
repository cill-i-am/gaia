import {
  HarnessCapabilities,
  HarnessSessionIdSchema,
  HarnessSessionEventBudgetBytes,
  HarnessProviderDescriptor,
  parseHarnessEvent,
  harnessEventByteLength,
  parseHarnessProviderId,
  projectHarnessEvents,
  type HarnessEvent,
  type HarnessDetection,
  type HarnessInteractionId,
  type HarnessSessionId,
} from "@gaia/core";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import {
  Cause,
  Effect,
  Option,
  Queue,
  Schema,
  Semaphore,
  Stream,
  type Scope,
} from "effect";
import {
  type CodexAppServerClient,
} from "./codex-app-server-client.js";
import {
  supportedCodexCliVersion,
  parseCodexThreadId,
  type CodexAppServerError,
  type CodexThread,
  type CodexThreadId,
  type CodexTurnId,
  type CodexServerRequest,
} from "./codex-app-server-protocol.js";
import { createCodexSessionMapper } from "./codex-session-mapper.js";
import {
  HarnessActionError,
  HarnessInput,
  HarnessInteractionResponseSchema,
  HarnessResumeError,
  HarnessSessionError,
  HarnessStartError,
  type HarnessInteractionResponse,
  type HarnessProvider,
  type HarnessSession,
  type HarnessSessionResume,
  type HarnessSessionStart,
} from "./harness-session.js";

/** Stable capabilities implemented by the initial Codex App Server adapter. */
export const CodexHarnessCapabilities = HarnessCapabilities.make({
  approvals: ["command", "fileChange", "permission", "userInput", "mcpElicitation"],
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

/** Dependencies and privacy policy for the Codex harness provider adapter. */
export type CodexHarnessProviderOptions = {
  readonly client: CodexAppServerClient;
  readonly correlationStore: CodexHarnessCorrelationStore;
  readonly detectionProbe?: Effect.Effect<HarnessDetection>;
  readonly sensitiveValues?: ReadonlyArray<string>;
  readonly workspaceRoot: string;
};

/** Opaque adapter token; callers persist it without interpreting its contents. */
const CodexHarnessCorrelationTokenSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(4_096),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
  ),
);

/** Finite opaque adapter token persisted without exposing its native meaning. */
export type CodexHarnessOpaqueCorrelation = {
  readonly token: typeof CodexHarnessCorrelationTokenSchema.Type;
};

/** Adapter-owned persistence seam for opaque Codex session correlation. */
export interface CodexHarnessCorrelationStore {
  readonly load: (
    sessionId: HarnessSessionId,
  ) => Effect.Effect<CodexHarnessOpaqueCorrelation | undefined, unknown>;
  readonly save: (
    sessionId: HarnessSessionId,
    correlation: CodexHarnessOpaqueCorrelation,
  ) => Effect.Effect<void, unknown>;
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
  "CodexHarnessCorrelationFile",
)({
  harnessProfileId: Schema.Literal("codexAppServer"),
  providerId: Schema.Literal("codex-app-server"),
  sessionId: HarnessSessionIdSchema,
  token: CodexHarnessCorrelationTokenSchema,
  version: Schema.Literal(1),
}, {
  parseOptions: { onExcessProperty: "error" },
}) {}
const decodeCodexHarnessCorrelationFile = Schema.decodeUnknownSync(
  CodexHarnessCorrelationFile,
);
const decodeCodexHarnessOpaqueCorrelation = Schema.decodeUnknownSync(
  Schema.Struct({ token: CodexHarnessCorrelationTokenSchema }),
);
const correlationFileMaxBytes = 16_384;

/** Durable adapter-private correlation store excluded from public run contracts. */
export function makeFileCodexHarnessCorrelationStore(
  rootDirectory: string,
): CodexHarnessCorrelationStore {
  const directory = path.join(rootDirectory, ".gaia", "private", "harness-correlations");
  const correlationPath = (sessionId: HarnessSessionId) =>
    path.join(
      directory,
      `${createHash("sha256").update(sessionId).digest("hex")}.json`,
    );

  return {
    load: (sessionId) =>
      Effect.tryPromise({
        try: async () => {
          try {
            const target = correlationPath(sessionId);
            if ((await stat(target)).size > correlationFileMaxBytes) {
              throw new Error("Harness correlation file exceeds its size limit.");
            }
            const contents = await readFile(target, "utf8");
            const parsed = decodeCodexHarnessCorrelationFile(
              JSON.parse(contents),
            );
            if (parsed.sessionId !== sessionId) {
              throw new Error("Harness correlation session does not match.");
            }
            return { token: parsed.token };
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              return undefined;
            }
            throw error;
          }
        },
        catch: (error) => error,
      }),
    save: (sessionId, correlation) =>
      Effect.tryPromise({
        try: async () => {
          const parsedCorrelation = decodeCodexHarnessOpaqueCorrelation(
            correlation,
          );
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const target = correlationPath(sessionId);
          const temporary = `${target}.${process.pid}.tmp`;
          await writeFile(
            temporary,
            `${JSON.stringify({
              harnessProfileId: "codexAppServer",
              providerId: "codex-app-server",
              sessionId,
              token: parsedCorrelation.token,
              version: 1,
            })}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
          await rename(temporary, target);
        },
        catch: (error) => error,
      }),
  };
}

/** Build the first rich HarnessProvider implementation over the landed GAIA-83 client. */
export function createCodexHarnessProvider(
  options: CodexHarnessProviderOptions,
): HarnessProvider {
  let initializedDetection: HarnessDetection | undefined;
  const initializationSemaphore = Semaphore.makeUnsafe(1);
  const initialize = initializationSemaphore.withPermits(1)(
    Effect.suspend(() => {
      if (initializedDetection !== undefined) return Effect.succeed(initializedDetection);
      return options.client
        .initialize({
          clientInfo: { name: "gaia", title: "Gaia", version: "0.1.0" },
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
          }),
        );
    }),
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
        const thread = yield* options.client
          .startThread({
            approvalPolicy: "on-request",
            cwd: absoluteWorkspacePath(options.workspaceRoot, request.workspacePath),
            ephemeral: false,
            sandbox: "workspace-write",
          })
          .pipe(
            Effect.mapError(
              () =>
                new HarnessStartError({
                  message: "Codex App Server could not start the session thread.",
                  providerId: CodexHarnessProviderDescriptor.providerId,
                }),
            ),
          );
        yield* options.correlationStore
          .save(request.sessionId, encodeCorrelation(thread.thread.id))
          .pipe(
            Effect.mapError(
              () =>
                new HarnessStartError({
                  message: "Codex session correlation could not be persisted.",
                  providerId: CodexHarnessProviderDescriptor.providerId,
                }),
            ),
          );
        return yield* makeCodexSession({
          nativeThreadId: thread.thread.id,
          options,
          request,
        }, () =>
          new HarnessStartError({
            message: "Codex App Server could not start the initial turn.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          }),
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
                }),
            ),
          );
        const correlatedThreadId =
          correlation === undefined ? undefined : decodeCorrelation(correlation);
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
                  message: "Codex App Server could not resume the session thread.",
                  providerId: CodexHarnessProviderDescriptor.providerId,
              }),
            ),
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
                  message: "Codex App Server could not read the recovered session.",
                  providerId: CodexHarnessProviderDescriptor.providerId,
                }),
            ),
          );
        if (recovered.thread.id !== correlatedThreadId) {
          return yield* new HarnessResumeError({
            message:
              "Codex read a thread that does not match stored session correlation.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          });
        }
        return yield* makeCodexSession({
          nativeThreadId: thread.thread.id,
          options,
          recoveredThread: recovered.thread,
          request,
        }, () =>
          new HarnessResumeError({
            message: "Codex App Server could not restore the session.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          }),
        );
      }),
  };
}

function makeCodexSession<E>(input: {
  readonly nativeThreadId: CodexThreadId;
  readonly options: CodexHarnessProviderOptions;
  readonly recoveredThread?: CodexThread;
  readonly request: HarnessSessionStart | HarnessSessionResume;
}, initialTurnError: () => E): Effect.Effect<HarnessSession, E, Scope.Scope> {
  return Effect.gen(function* () {
    const queue = yield* Queue.bounded<HarnessEvent, HarnessSessionError>(2_000);
    const mapper = createCodexSessionMapper({
      capabilities: CodexHarnessCapabilities,
      provider: CodexHarnessProviderDescriptor,
      ...(input.options.sensitiveValues === undefined
        ? {}
        : { sensitiveValues: input.options.sensitiveValues }),
      sessionId: input.request.sessionId,
      workspaceRoot: absoluteWorkspacePath(
        input.options.workspaceRoot,
        input.request.workspacePath,
      ),
    });
    const projectedEvents: Array<HarnessEvent> = [];
    const pendingRequests = new Map<HarnessInteractionId, CodexServerRequest>();
    let activeTurnId: CodexTurnId | undefined;
    let adapterFailed = false;
    let bufferFailed = false;
    let projectedEventBytes = 0;
    const dispatchedClientInputIds = new Set(
      (input.recoveredThread?.turns ?? []).flatMap((turn) =>
        (turn.items ?? []).flatMap((item) =>
          item.type === "userMessage" && item.clientId !== undefined && item.clientId !== null
            ? [item.clientId]
            : [],
        ),
      ),
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
          }),
        ),
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
          failEventBuffer(
            "Codex session exceeded its bounded event buffer.",
          );
          return;
        }
        projectedEventBytes += eventBytes;
        projectedEvents.push(parsed);
        if (!Queue.offerUnsafe(queue, parsed)) {
          failEventBuffer(
            "Codex session live event consumer fell behind.",
          );
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
          }),
        ),
      );
    };

    const terminateSession = (
      events: ReadonlyArray<HarnessEvent>,
      message: string,
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
          "Codex session reached a terminal provider failure.",
        );
        return;
      }
      emit(events);
    };

    const mapOrFail = (
      map: () => ReadonlyArray<HarnessEvent>,
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
                message: "Codex emitted an event outside Gaia's safe projection limits.",
                recoverable: false,
              },
              kind: "sessionFailed",
              sessionId: input.request.sessionId,
            }),
          ],
          "Codex session projection was rejected.",
        );
        return [];
      }
    };

    emitProviderEvents(
      mapOrFail(() => mapper.mapNotification({
        method: "thread/started",
        params: { thread: { id: input.nativeThreadId } },
      })),
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
      },
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
      const message = "Codex App Server terminated before the session completed.";
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
        message,
      );
    });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        removeNotification();
        removeRequest();
        removeTermination();
        yield* Queue.shutdown(queue);
      }),
    );

    if (
      input.recoveredThread !== undefined &&
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
        mapOrFail(() => mapper.mapRecoveredThread(input.recoveredThread)),
      );
      if (!adapterFailed && !bufferFailed) {
        activeTurnId = [...(input.recoveredThread.turns ?? [])]
          .reverse()
          .find((turn) => turn.status === "inProgress")?.id;
      }
    }

    if (
      "input" in input.request &&
      !adapterFailed &&
      !bufferFailed
    ) {
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
          mapOrFail(() => mapper.mapNotification({
            method: "turn/started",
            params: {
              threadId: input.nativeThreadId,
              turn: { id: turn.turn.id, status: "inProgress" },
            },
          })),
        );
      }
    }

    const session: HarnessSession = {
      events: Stream.fromQueue(queue),
      interrupt: Option.some(
        Effect.suspend(() => {
          if (adapterFailed || bufferFailed) {
            return Effect.fail(
              actionError("interrupt", "The Codex session is terminal."),
            );
          }
          if (activeTurnId === undefined) {
            return Effect.fail(actionError("interrupt", "No active Codex turn to interrupt."));
          }
          return input.options.client
            .interruptTurn({ threadId: input.nativeThreadId, turnId: activeTurnId })
            .pipe(
              Effect.mapError(() =>
                actionError("interrupt", "Codex turn interruption failed."),
              ),
            );
        }),
      ),
      resolveInteraction: (response) =>
        Schema.decodeUnknownEffect(HarnessInteractionResponseSchema)(response).pipe(
          Effect.mapError(() =>
            actionError(
              "resolveInteraction",
              "The Codex interaction response is invalid.",
            ),
          ),
          Effect.flatMap((parsedResponse) => {
            if (adapterFailed || bufferFailed) {
              return Effect.fail(
                actionError(
                  "resolveInteraction",
                  "The Codex session is terminal.",
                ),
              );
            }
            if (!interactionResponseWithinBudget(parsedResponse)) {
              return Effect.fail(
                actionError(
                  "resolveInteraction",
                  "The Codex interaction response exceeds its size limit.",
                ),
              );
            }
            const request = pendingRequests.get(parsedResponse.interactionId);
            if (request === undefined) {
              return Effect.fail(
                actionError(
                  "resolveInteraction",
                  "The Codex interaction is stale or already resolved.",
                ),
              );
            }
            return respondToCodexRequest(
              input.options.client,
              mapper,
              request,
              parsedResponse,
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (adapterFailed || bufferFailed) return;
                  pendingRequests.delete(parsedResponse.interactionId);
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
                      resolvedAt: new Date().toISOString(),
                      responseKind: parsedResponse.kind,
                    }),
                  );
                }),
              ),
            );
          }),
        ),
      send: (message) =>
        Schema.decodeUnknownEffect(HarnessInput)(message).pipe(
          Effect.mapError(() => actionError("send", "Codex follow-up input is invalid.")),
          Effect.flatMap((parsedMessage) => {
            if (adapterFailed || bufferFailed) {
              return Effect.fail(
                actionError("send", "The Codex session is terminal."),
              );
            }
            if (
              parsedMessage.clientInputId !== undefined &&
              dispatchedClientInputIds.has(parsedMessage.clientInputId)
            ) {
              return Effect.void;
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
                        }),
                      ),
                    );
                  }),
                ),
                Effect.asVoid,
                Effect.mapError(() =>
                  actionError("send", "Codex follow-up turn failed."),
                ),
              );
          }),
        ),
      snapshot: Effect.try({
        try: () => projectHarnessEvents(projectedEvents, input.request.sessionId),
        catch: () =>
          new HarnessSessionError({
            message: "Codex session projection could not be rebuilt.",
            providerId: CodexHarnessProviderDescriptor.providerId,
          }),
      }),
      steer: Option.some((message) =>
        Schema.decodeUnknownEffect(HarnessInput)(message).pipe(
          Effect.mapError(() => actionError("steer", "Codex steering input is invalid.")),
          Effect.flatMap((parsedMessage) =>
            Effect.suspend(() => {
              if (adapterFailed || bufferFailed) {
                return Effect.fail(
                  actionError("steer", "The Codex session is terminal."),
                );
              }
              if (activeTurnId === undefined) {
                return Effect.fail(
                  actionError("steer", "No active Codex turn to steer."),
                );
              }
              return input.options.client
                .steerTurn({
                  expectedTurnId: activeTurnId,
                  input: [{ text: parsedMessage.text, type: "text" }],
                  threadId: input.nativeThreadId,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError(() =>
                    actionError("steer", "Codex turn steering failed."),
                  ),
                );
            }),
          ),
        ),
      ),
    };
    return session;
  });
}

function respondToCodexRequest(
  client: CodexAppServerClient,
  mapper: ReturnType<typeof createCodexSessionMapper>,
  request: CodexServerRequest,
  response: HarnessInteractionResponse,
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
      if (response.kind !== "mcpElicitation") return invalidInteractionResponse();
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
  actionError("resolveInteraction", "Codex interaction response failed."),
);

function invalidInteractionResponse() {
  return Effect.fail(
    actionError(
      "resolveInteraction",
      "The interaction response does not match the pending Codex request.",
    ),
  );
}

function interactionResponseWithinBudget(
  response: HarnessInteractionResponse,
): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(response)).byteLength <= 1_048_576
  );
}

function actionError(
  actionKind: "send" | "steer" | "interrupt" | "resolveInteraction",
  message: string,
) {
  return new HarnessActionError({
    actionKind,
    message,
    providerId: CodexHarnessProviderDescriptor.providerId,
  });
}

function mapApprovalDecision(
  decision: "approve" | "approveForSession" | "decline" | "cancel",
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

function absoluteWorkspacePath(root: string, relativePath: string): string {
  return path.resolve(root, relativePath === "." ? "" : relativePath);
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
        reason: "Codex App Server version is incompatible with this Gaia adapter.",
        state: "incompatible",
        version: boundedVersion(error.actualUserAgent),
      };
    case "CodexAppServerProtocolError":
      return {
        reason: "Codex App Server did not complete the expected initialize protocol.",
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
  const match = /\b(?:Codex|gaia)\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/iu.exec(
    userAgent,
  );
  return (match?.[1] ?? "unknown").slice(0, 200);
}

function encodeCorrelation(threadId: CodexThreadId): CodexHarnessOpaqueCorrelation {
  return { token: Buffer.from(threadId, "utf8").toString("base64url") };
}

function decodeCorrelation(
  correlation: CodexHarnessOpaqueCorrelation,
): CodexThreadId | undefined {
  try {
    const decoded = Buffer.from(correlation.token, "base64url").toString("utf8");
    return decoded.length === 0 ? undefined : parseCodexThreadId(decoded);
  } catch {
    return undefined;
  }
}
