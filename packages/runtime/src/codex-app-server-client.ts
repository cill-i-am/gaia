import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { Context, Effect, Layer, Option, Schema } from "effect";

import {
  CodexAppServerInboundRequestSchema,
  CodexAppServerNotificationSchema,
  CodexAppServerIncompatibilityError,
  CodexAppServerProcessExitError,
  CodexAppServerProtocolError,
  CodexAppServerResponseSchema,
  CodexAppServerTimeoutError,
  CodexAppServerTransportError,
  CodexNotificationSchema,
  CodexServerRequestSchema,
  InitializeResultSchema,
  ThreadResultSchema,
  TurnResultSchema,
  TurnSteerResultSchema,
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
  ThreadListResultSchema,
  ModelListParamsSchema,
  ModelListResultSchema,
  TurnStartParamsSchema,
  TurnSteerParamsSchema,
  TurnInterruptParamsSchema,
  isCuratedCodexNotificationMethod,
  supportedCodexCliVersion,
  type CodexAppServerError,
  type CodexRequestId,
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
  readonly kill: () => void;
  readonly onError: (listener: () => void) => () => void;
  readonly onExit: (listener: (code: number | null) => void) => () => void;
  readonly onLine: (listener: (line: string) => void) => () => void;
  readonly stderr: () => string;
  readonly write: (line: string) => void;
}

export interface CodexAppServerTransportOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly process?: CodexAppServerProcess;
}

const decodeResponse = Schema.decodeUnknownOption(CodexAppServerResponseSchema);
const decodeRequest = Schema.decodeUnknownOption(
  CodexAppServerInboundRequestSchema
);
const decodeNotification = Schema.decodeUnknownOption(
  CodexAppServerNotificationSchema
);
const decodeServerRequest = Schema.decodeUnknownOption(
  CodexServerRequestSchema
);
const decodeCuratedNotification = Schema.decodeUnknownOption(
  CodexNotificationSchema
);

function nodeProcess(
  options: CodexAppServerTransportOptions
): CodexAppServerProcess {
  const child: ChildProcessWithoutNullStreams = spawn(
    options.command ?? "codex",
    ["app-server", "--listen", "stdio://"],
    { cwd: options.cwd, env: options.env, stdio: "pipe" }
  );
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384);
  });
  return {
    kill: () => {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
    },
    onError: (listener) => {
      child.on("error", listener);
      return () => child.off("error", listener);
    },
    onExit: (listener) => {
      child.on("exit", listener);
      return () => child.off("exit", listener);
    },
    onLine: (listener) => {
      lines.on("line", listener);
      return () => lines.off("line", listener);
    },
    stderr: () => stderr,
    write: (line) => child.stdin.write(line),
  };
}

export function makeCodexAppServerConnection(
  options: CodexAppServerTransportOptions = {}
) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const process = options.process ?? nodeProcess(options);
      let nextId = 1;
      let closed = false;
      let terminalError: CodexAppServerError | undefined;
      const pending = new Map<
        CodexRequestId,
        {
          readonly fail: (error: CodexAppServerError) => void;
          readonly succeed: (value: Schema.Json) => void;
        }
      >();
      const notificationListeners = new Set<
        (value: CodexNotification) => void
      >();
      const requestListeners = new Set<(value: CodexServerRequest) => void>();
      const terminationListeners = new Set<
        (error: CodexAppServerError) => void
      >();

      const write = (message: unknown) =>
        Effect.try({
          try: () => process.write(`${JSON.stringify(message)}\n`),
          catch: () =>
            new CodexAppServerTransportError({
              message: "Failed to write to Codex App Server",
            }),
        });
      const failAll = (error: CodexAppServerError) => {
        if (closed) return;
        closed = true;
        terminalError = error;
        for (const entry of pending.values()) entry.fail(error);
        pending.clear();
        for (const listener of terminationListeners) listener(error);
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
        const response = decodeResponse(value);
        if (Option.isSome(response)) {
          const entry = pending.get(response.value.id);
          if (!entry) return;
          pending.delete(response.value.id);
          if ("error" in response.value)
            entry.fail(
              new CodexAppServerProtocolError({
                message: response.value.error.message,
              })
            );
          else entry.succeed(response.value.result);
          return;
        }
        const request = decodeRequest(value);
        if (Option.isSome(request)) {
          const decoded = decodeServerRequest(request.value);
          if (Option.isNone(decoded)) {
            try {
              process.write(
                `${JSON.stringify({ id: request.value.id, error: { code: -32601, message: "Unsupported server request" } })}\n`
              );
            } catch {
              failAll(
                new CodexAppServerTransportError({
                  message: "Failed to write to Codex App Server",
                })
              );
            }
            return;
          }
          for (const listener of requestListeners) listener(decoded.value);
          return;
        }
        const notification = decodeNotification(value);
        if (Option.isSome(notification)) {
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
          Effect.callback<Schema.Json, CodexAppServerError>((resume) => {
            if (terminalError !== undefined) {
              resume(Effect.fail(terminalError));
              return Effect.void;
            }
            const id = nextId++;
            const timer = setTimeout(() => {
              if (!pending.delete(id)) return;
              resume(
                Effect.fail(
                  new CodexAppServerTimeoutError({ method, timeoutMs })
                )
              );
            }, timeoutMs);
            pending.set(id, {
              fail: (error) => {
                clearTimeout(timer);
                resume(Effect.fail(error));
              },
              succeed: (result) => {
                clearTimeout(timer);
                resume(Effect.succeed(result));
              },
            });
            try {
              process.write(`${JSON.stringify({ id, method, params })}\n`);
            } catch {
              clearTimeout(timer);
              pending.delete(id);
              resume(
                Effect.fail(
                  new CodexAppServerTransportError({
                    message: "Failed to write to Codex App Server",
                  })
                )
              );
            }
            return Effect.sync(() => {
              clearTimeout(timer);
              pending.delete(id);
            });
          }),
        respond: (id, result) => write({ id, result }),
      };
      return {
        close: () => {
          failAll(
            new CodexAppServerTransportError({
              message: "Codex App Server connection released",
            })
          );
          removeLine();
          removeExit();
          removeError();
          process.kill();
        },
        connection,
      };
    }),
    ({ close }) => Effect.sync(close)
  ).pipe(Effect.map(({ connection }) => connection));
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
        ThreadListResultSchema
      ),
    readThread: (params: ThreadReadParams) =>
      request(
        "thread/read",
        params,
        ThreadReadParamsSchema,
        ThreadResultSchema
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
        ThreadResultSchema
      ),
    startThread: (params: ThreadStartParams) =>
      request(
        "thread/start",
        params,
        ThreadStartParamsSchema,
        ThreadResultSchema
      ),
    startTurn: (params: TurnStartParams) =>
      request("turn/start", params, TurnStartParamsSchema, TurnResultSchema),
    steerTurn: (params: TurnSteerParams) =>
      request(
        "turn/steer",
        params,
        TurnSteerParamsSchema,
        TurnSteerResultSchema
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
    Effect.flatMap(Schema.decodeUnknownEffect(ModelListResultSchema))
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
