import { NodeServices } from "@effect/platform-node";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  CodexAppServerInboundRequestBoundarySchema,
  CodexAppServerNotificationSchema,
  CodexAppServerIncompatibilityError,
  CodexAppServerProcessExitError,
  CodexAppServerProtocolError,
  CodexAppServerResponseBoundarySchema,
  CodexAppServerTimeoutError,
  CodexAppServerTransportError,
  CodexNotificationBoundarySchema,
  CodexServerRequestBoundarySchema,
  InitializeResultSchema,
  ThreadReadBoundaryResultSchema,
  ThreadResumeBoundaryResultSchema,
  ThreadStartBoundaryResultSchema,
  TurnBoundaryResultSchema,
  TurnSteerBoundaryResultSchema,
  EmptyResultSchema,
  CommandApprovalResponseSchema,
  FileApprovalResponseSchema,
  PermissionApprovalResponseSchema,
  UserInputResponseSchema,
  ElicitationResponseSchema,
  InitializeParamsSchema,
  ThreadStartParamsSchema,
  ThreadResumeParamsSchema,
  ThreadReadParamsSchema,
  ThreadListParamsSchema,
  ThreadListBoundaryResultSchema,
  ModelListParamsSchema,
  ModelListBoundaryResultSchema,
  TurnStartParamsSchema,
  TurnSteerParamsSchema,
  TurnInterruptParamsSchema,
  isCuratedCodexNotificationMethod,
  isCodexServerRequestMethod,
  CodexRawRequestIdSchema,
  parseCodexRequestId,
  supportedCodexCliVersion,
  type CodexAppServerError,
  type CodexRequestId,
  CodexRequestIdSchema,
  type CodexNotification,
  type CodexServerRequest,
  type InitializeParams,
  type ThreadStartParams,
  type ThreadResumeParams,
  type ThreadReadParams,
  type ThreadListParams,
  type TurnStartParams,
  type TurnSteerParams,
  type TurnInterruptParams,
  type CommandApprovalRequest,
  type FileApprovalRequest,
  type PermissionApprovalRequest,
  type UserInputRequest,
  type ElicitationRequest,
} from "./codex-app-server-protocol.js";

type JsonObject = Readonly<Record<string, Schema.Json>>;
export interface CodexAppServerConnection {
  readonly notify: (
    method: string,
    params?: JsonObject
  ) => Effect.Effect<void, CodexAppServerError>;
  readonly onNotification: (
    listener: (notification: CodexNotification) => void
  ) => () => void;
  readonly onServerRequest: (
    listener: (request: CodexServerRequest) => void
  ) => () => void;
  readonly onTermination: (
    listener: (error: CodexAppServerError) => void
  ) => () => void;
  readonly request: (
    method: string,
    params?: unknown,
    timeoutMs?: number
  ) => Effect.Effect<Schema.Json, CodexAppServerError>;
  readonly respond: (
    id: CodexRequestId,
    result: Schema.Json
  ) => Effect.Effect<void, CodexAppServerError>;
}

export interface CodexAppServerProcess {
  readonly kill: () => Effect.Effect<void, CodexAppServerError>;
  readonly onError: (listener: () => void) => () => void;
  readonly onExit: (listener: (code: number | null) => void) => () => void;
  readonly onLine: (listener: (line: string) => void) => () => void;
  readonly stderr: () => string;
  readonly write: (line: string) => Effect.Effect<void, CodexAppServerError>;
}

/** Serializable process-spawn data for the Codex App Server adapter. */
export class CodexAppServerSpawnConfig extends Schema.Class<CodexAppServerSpawnConfig>(
  "CodexAppServerSpawnConfig"
)(
  {
    args: Schema.optionalKey(
      Schema.Array(
        Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(4_096)))
      ).pipe(Schema.check(Schema.isMaxLength(16)))
    ),
    command: Schema.optionalKey(
      Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(4_096)))
    ),
    cwd: Schema.optionalKey(
      Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(16_384)))
    ),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}

/** Manual capability shell; spawn data remains schema-owned. */
export type CodexAppServerTransportOptions = {
  readonly config?: CodexAppServerSpawnConfig;
  readonly process?: CodexAppServerProcess;
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
};

const decodeResponse = Schema.decodeUnknownOption(
  CodexAppServerResponseBoundarySchema
);
const decodeRequest = Schema.decodeUnknownOption(
  CodexAppServerInboundRequestBoundarySchema
);
const decodeRawRequestId = Schema.decodeUnknownOption(CodexRawRequestIdSchema);
const decodeNotification = Schema.decodeUnknownOption(
  CodexAppServerNotificationSchema
);
const decodeServerRequest = Schema.decodeUnknownOption(
  CodexServerRequestBoundarySchema
);
const decodeCuratedNotification = Schema.decodeUnknownOption(
  CodexNotificationBoundarySchema
);

function effectProcess(
  options: CodexAppServerTransportOptions,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
) {
  const config = options.config ?? CodexAppServerSpawnConfig.make({});
  return Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        config.command ?? "codex",
        config.args ?? ["app-server", "--listen", "stdio://"],
        {
          ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          ...(config.env === undefined
            ? {}
            : { env: { ...config.env }, extendEnv: false }),
          stderr: "pipe",
          stdin: "pipe",
          stdout: "pipe",
        }
      )
    );
    const writes = yield* Queue.unbounded<Uint8Array>();
    const lines = new Set<(line: string) => void>();
    const exits = new Set<(code: number | null) => void>();
    const errors = new Set<() => void>();
    let stderr = "";
    const mapTransportError = () =>
      new CodexAppServerTransportError({
        message: "Codex App Server process transport failed",
      });
    yield* Stream.fromQueue(writes).pipe(
      Stream.run(handle.stdin),
      Effect.mapError(mapTransportError),
      Effect.catch((_) =>
        Effect.sync(() => {
          for (const listener of errors) listener();
        })
      ),
      Effect.forkScoped
    );
    yield* Stream.decodeText(handle.stdout).pipe(
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          for (const listener of lines) listener(line);
        })
      ),
      Effect.catch(() =>
        Effect.sync(() => {
          for (const listener of errors) listener();
        })
      ),
      Effect.forkScoped
    );
    yield* Stream.decodeText(handle.stderr).pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderr = `${stderr}${chunk}`.slice(-16_384);
        })
      ),
      Effect.catch(() => Effect.void),
      Effect.forkScoped
    );
    yield* handle.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.sync(() => {
          for (const listener of exits) listener(Number(code));
        })
      ),
      Effect.catch(() =>
        Effect.sync(() => {
          for (const listener of errors) listener();
        })
      ),
      Effect.forkScoped
    );
    return {
      kill: () =>
        Effect.gen(function* () {
          yield* Queue.shutdown(writes);
          yield* handle.kill({ forceKillAfter: "2 seconds" });
        }).pipe(Effect.mapError(mapTransportError)),
      onError: (listener: () => void) => {
        errors.add(listener);
        return () => errors.delete(listener);
      },
      onExit: (listener: (code: number | null) => void) => {
        exits.add(listener);
        return () => exits.delete(listener);
      },
      onLine: (listener: (line: string) => void) => {
        lines.add(listener);
        return () => lines.delete(listener);
      },
      stderr: () => stderr,
      write: (line: string) =>
        Queue.offer(writes, new TextEncoder().encode(line)).pipe(
          Effect.asVoid,
          Effect.mapError(mapTransportError)
        ),
    } satisfies CodexAppServerProcess;
  }).pipe(
    Effect.mapError(
      () =>
        new CodexAppServerTransportError({
          message: "Failed to start Codex App Server",
        })
    )
  );
}

export function makeCodexAppServerConnection(
  options: CodexAppServerTransportOptions = {}
) {
  const acquireProcess =
    options.process !== undefined
      ? Effect.succeed(options.process)
      : options.spawner !== undefined
        ? effectProcess(options, options.spawner)
        : Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            return yield* effectProcess(options, spawner);
          }).pipe(Effect.provide(NodeServices.layer));
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const process = yield* acquireProcess;
      let nextId = 1;
      let closed = false;
      let terminalError: CodexAppServerError | undefined;
      const pending = new Map<
        CodexRequestId,
        Deferred.Deferred<Schema.Json, CodexAppServerError>
      >();
      const notificationListeners = new Set<
        (value: CodexNotification) => void
      >();
      const requestListeners = new Set<(value: CodexServerRequest) => void>();
      const terminationListeners = new Set<
        (error: CodexAppServerError) => void
      >();

      const write = (message: unknown) =>
        process.write(`${JSON.stringify(message)}\n`);
      const failAll = (error: CodexAppServerError) => {
        if (closed) return;
        closed = true;
        terminalError = error;
        for (const entry of pending.values())
          Deferred.doneUnsafe(entry, Effect.fail(error));
        pending.clear();
        for (const listener of terminationListeners) listener(error);
      };
      const rejectUnsupportedServerRequest = (
        id: typeof CodexRawRequestIdSchema.Type
      ) => {
        const frame = `${JSON.stringify({ id, error: { code: -32601, message: "Unsupported server request" } })}\n`;
        Effect.runFork(
          Effect.try({
            try: () => process.write(frame),
            catch: () =>
              new CodexAppServerTransportError({
                message: "Codex App Server process transport failed",
              }),
          }).pipe(
            Effect.flatten,
            Effect.catch((error) => Effect.sync(() => failAll(error)))
          )
        );
      };
      const removeLine = process.onLine((line) => {
        if (closed) return;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          failAll(
            new CodexAppServerProtocolError({ message: "Invalid JSONL frame" })
          );
          return;
        }
        if (!isUnknownRecord(value)) return;
        const frame = value;
        const hasMethod = "method" in frame;
        const hasId = "id" in frame;
        if (hasMethod && hasId) {
          const request = decodeRequest(frame);
          if (Option.isNone(request)) {
            if (typeof frame.method === "string") {
              const rawRequestId = decodeRawRequestId(frame.id);
              if (Option.isSome(rawRequestId)) {
                rejectUnsupportedServerRequest(rawRequestId.value);
                return;
              }
              if (isCodexServerRequestMethod(frame.method))
                failAll(
                  new CodexAppServerProtocolError({
                    message: `Invalid ${frame.method} server request`,
                    method: frame.method,
                  })
                );
            }
            return;
          }
          const decoded = decodeServerRequest(request.value);
          if (Option.isSome(decoded)) {
            for (const listener of requestListeners) listener(decoded.value);
            return;
          }
          rejectUnsupportedServerRequest(request.value.id);
          return;
        }
        if (hasMethod) {
          if (
            typeof frame.method === "string" &&
            isCodexServerRequestMethod(frame.method)
          ) {
            failAll(
              new CodexAppServerProtocolError({
                message: `Invalid ${frame.method} server request`,
                method: frame.method,
              })
            );
            return;
          }
          const notification = decodeNotification(frame);
          if (Option.isNone(notification)) return;
          const decoded = decodeCuratedNotification(notification.value);
          if (Option.isSome(decoded)) {
            for (const listener of notificationListeners)
              listener(decoded.value);
          } else if (
            isCuratedCodexNotificationMethod(notification.value.method)
          ) {
            failAll(
              new CodexAppServerProtocolError({
                message: `Invalid ${notification.value.method} notification`,
              })
            );
          }
          return;
        }
        if (!hasId) return;
        const response = decodeResponse(frame);
        if (Option.isSome(response)) {
          const entry = pending.get(response.value.id);
          if (!entry) return;
          pending.delete(response.value.id);
          if ("error" in response.value)
            Deferred.doneUnsafe(
              entry,
              Effect.fail(
                new CodexAppServerProtocolError({
                  message: response.value.error.message,
                })
              )
            );
          else
            Deferred.doneUnsafe(entry, Effect.succeed(response.value.result));
          return;
        }
        const responseId = Schema.decodeUnknownOption(CodexRequestIdSchema)(
          frame.id
        );
        if (Option.isNone(responseId)) return;
        const entry = pending.get(responseId.value);
        if (entry !== undefined) {
          pending.delete(responseId.value);
          Deferred.doneUnsafe(
            entry,
            Effect.fail(
              new CodexAppServerProtocolError({
                message: "Invalid Codex App Server response",
              })
            )
          );
        }
      });
      const removeExit = process.onExit((code) =>
        failAll(
          new CodexAppServerProcessExitError({ code, stderr: process.stderr() })
        )
      );
      const removeError = process.onError(() =>
        failAll(
          new CodexAppServerTransportError({
            message: "Failed to start Codex App Server",
          })
        )
      );

      const connection: CodexAppServerConnection = {
        notify: (method, params = {}) => write({ method, params }),
        onNotification: (listener) => {
          notificationListeners.add(listener);
          return () => notificationListeners.delete(listener);
        },
        onServerRequest: (listener) => {
          requestListeners.add(listener);
          return () => requestListeners.delete(listener);
        },
        onTermination: (listener) => {
          if (terminalError !== undefined) {
            listener(terminalError);
            return () => undefined;
          }
          terminationListeners.add(listener);
          return () => terminationListeners.delete(listener);
        },
        request: (method, params = {}, timeoutMs = 30_000) =>
          Effect.suspend(() => {
            if (terminalError !== undefined) return Effect.fail(terminalError);
            const id = parseCodexRequestId(nextId++);
            const awaited = Deferred.makeUnsafe<
              Schema.Json,
              CodexAppServerError
            >();
            pending.set(id, awaited);
            return write({ id, method, params }).pipe(
              Effect.andThen(Deferred.await(awaited)),
              Effect.timeoutOrElse({
                duration: `${timeoutMs} millis`,
                orElse: () =>
                  Effect.fail(
                    new CodexAppServerTimeoutError({ method, timeoutMs })
                  ),
              }),
              Effect.ensuring(Effect.sync(() => pending.delete(id)))
            );
          }),
        respond: (id, result) => write({ id, result }),
      };
      return {
        close: Effect.gen(function* () {
          failAll(
            new CodexAppServerTransportError({
              message: "Codex App Server connection released",
            })
          );
          removeLine();
          removeExit();
          removeError();
          yield* process.kill().pipe(Effect.orElseSucceed(() => undefined));
        }),
        connection,
      };
    }),
    ({ close }) => close
  ).pipe(Effect.map(({ connection }) => connection));
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CodexAppServerConnectionService extends Context.Service<
  CodexAppServerConnectionService,
  CodexAppServerConnection
>()("@gaia/runtime/CodexAppServerConnection") {}
export const CodexAppServerConnectionLive = (
  options: CodexAppServerTransportOptions = {}
) =>
  Layer.effect(
    CodexAppServerConnectionService,
    makeCodexAppServerConnection(options)
  );

export function makeCodexAppServerClient(connection: CodexAppServerConnection) {
  const request = <P extends Schema.Top, S extends Schema.Top>(
    method: string,
    params: unknown,
    paramsSchema: P,
    schema: S
  ) =>
    Schema.decodeUnknownEffect(paramsSchema)(params).pipe(
      Effect.mapError(
        () =>
          new CodexAppServerProtocolError({
            method,
            message: `Invalid ${method} params`,
          })
      ),
      Effect.flatMap((parsed) => connection.request(method, parsed)),
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(schema)(result).pipe(
          Effect.mapError(
            () =>
              new CodexAppServerProtocolError({
                method,
                message: `Invalid ${method} response`,
              })
          )
        )
      )
    );
  return {
    initialize: (params: InitializeParams) =>
      request(
        "initialize",
        params,
        InitializeParamsSchema,
        InitializeResultSchema
      ).pipe(
        Effect.flatMap((result) =>
          result.userAgent.includes(`/${supportedCodexCliVersion} `)
            ? Effect.succeed(result)
            : Effect.fail(
                new CodexAppServerIncompatibilityError({
                  actualUserAgent: result.userAgent,
                  supportedVersion: supportedCodexCliVersion,
                })
              )
        ),
        Effect.tap(() => connection.notify("initialized"))
      ),
    interruptTurn: (params: TurnInterruptParams) =>
      request(
        "turn/interrupt",
        params,
        TurnInterruptParamsSchema,
        EmptyResultSchema
      ),
    onNotification: connection.onNotification,
    onServerRequest: connection.onServerRequest,
    onTermination: connection.onTermination,
    listThreads: (params: ThreadListParams) =>
      request(
        "thread/list",
        params,
        ThreadListParamsSchema,
        ThreadListBoundaryResultSchema
      ),
    readThread: (params: ThreadReadParams) =>
      request(
        "thread/read",
        params,
        ThreadReadParamsSchema,
        ThreadReadBoundaryResultSchema
      ),
    respondCommandApproval: (
      request: CommandApprovalRequest,
      response: typeof CommandApprovalResponseSchema.Type
    ) =>
      Schema.decodeUnknownEffect(CommandApprovalResponseSchema)(response).pipe(
        Effect.flatMap((value) => connection.respond(request.id, value))
      ),
    respondFileApproval: (
      request: FileApprovalRequest,
      response: typeof FileApprovalResponseSchema.Type
    ) =>
      Schema.decodeUnknownEffect(FileApprovalResponseSchema)(response).pipe(
        Effect.flatMap((value) => connection.respond(request.id, value))
      ),
    respondPermissionApproval: (
      request: PermissionApprovalRequest,
      response: typeof PermissionApprovalResponseSchema.Type
    ) =>
      Schema.decodeUnknownEffect(PermissionApprovalResponseSchema)(
        response
      ).pipe(Effect.flatMap((value) => connection.respond(request.id, value))),
    respondUserInput: (
      request: UserInputRequest,
      response: typeof UserInputResponseSchema.Type
    ) =>
      Schema.decodeUnknownEffect(UserInputResponseSchema)(response).pipe(
        Effect.flatMap((value) => connection.respond(request.id, value))
      ),
    respondElicitation: (
      request: ElicitationRequest,
      response: typeof ElicitationResponseSchema.Type
    ) =>
      Schema.decodeUnknownEffect(ElicitationResponseSchema)(response).pipe(
        Effect.flatMap((value) => connection.respond(request.id, value))
      ),
    resumeThread: (params: ThreadResumeParams) =>
      request(
        "thread/resume",
        params,
        ThreadResumeParamsSchema,
        ThreadResumeBoundaryResultSchema
      ),
    startThread: (params: ThreadStartParams) =>
      request(
        "thread/start",
        params,
        ThreadStartParamsSchema,
        ThreadStartBoundaryResultSchema
      ),
    startTurn: (params: TurnStartParams) =>
      request(
        "turn/start",
        params,
        TurnStartParamsSchema,
        TurnBoundaryResultSchema
      ),
    steerTurn: (params: TurnSteerParams) =>
      request(
        "turn/steer",
        params,
        TurnSteerParamsSchema,
        TurnSteerBoundaryResultSchema
      ),
  } as const;
}

export type CodexAppServerClient = ReturnType<typeof makeCodexAppServerClient>;
export function listCodexModels(
  connection: CodexAppServerConnection,
  params: typeof ModelListParamsSchema.Type = {}
) {
  return Schema.decodeUnknownEffect(ModelListParamsSchema)(params).pipe(
    Effect.flatMap((parsed) => connection.request("model/list", parsed)),
    Effect.flatMap(Schema.decodeUnknownEffect(ModelListBoundaryResultSchema))
  );
}
export class CodexAppServerClientService extends Context.Service<
  CodexAppServerClientService,
  CodexAppServerClient
>()("@gaia/runtime/CodexAppServerClient") {}
export const CodexAppServerClientLive = (
  options: CodexAppServerTransportOptions = {}
) =>
  Layer.effect(
    CodexAppServerClientService,
    makeCodexAppServerConnection(options).pipe(
      Effect.map(makeCodexAppServerClient)
    )
  );
