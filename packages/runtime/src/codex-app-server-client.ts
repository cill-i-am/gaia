import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  CodexAppServerInboundRequestSchema,
  CodexAppServerNotificationSchema,
  CodexAppServerProcessExitError,
  CodexAppServerProtocolError,
  CodexAppServerResponseSchema,
  CodexAppServerTimeoutError,
  CodexAppServerTransportError,
  CodexStableNotificationMethodSchema,
  CodexStableServerRequestMethodSchema,
  type CodexAppServerError,
  type CodexRequestId,
  type CodexStableNotificationMethod,
  type CodexStableServerRequestMethod,
} from "./codex-app-server-protocol.js";

type JsonObject = Readonly<Record<string, Schema.Json>>;
export interface CodexNotification {
  readonly method: CodexStableNotificationMethod;
  readonly params: JsonObject;
}
export interface CodexServerRequest {
  readonly id: CodexRequestId;
  readonly method: CodexStableServerRequestMethod;
  readonly params: JsonObject;
}
export interface CodexAppServerConnection {
  readonly notify: (method: string, params?: JsonObject) => Effect.Effect<void, CodexAppServerError>;
  readonly onNotification: (listener: (notification: CodexNotification) => void) => () => void;
  readonly onServerRequest: (listener: (request: CodexServerRequest) => void) => () => void;
  readonly request: (method: string, params?: JsonObject, timeoutMs?: number) => Effect.Effect<Schema.Json, CodexAppServerError>;
  readonly respond: (id: CodexRequestId, result: Schema.Json) => Effect.Effect<void, CodexAppServerError>;
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
const decodeRequest = Schema.decodeUnknownOption(CodexAppServerInboundRequestSchema);
const decodeNotification = Schema.decodeUnknownOption(CodexAppServerNotificationSchema);
const decodeRequestMethod = Schema.decodeUnknownOption(CodexStableServerRequestMethodSchema);
const decodeNotificationMethod = Schema.decodeUnknownOption(CodexStableNotificationMethodSchema);

function nodeProcess(options: CodexAppServerTransportOptions): CodexAppServerProcess {
  const child: ChildProcessWithoutNullStreams = spawn(
    options.command ?? "codex",
    ["app-server", "--listen", "stdio://"],
    { cwd: options.cwd, env: options.env, stdio: "pipe" },
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

export function makeCodexAppServerConnection(options: CodexAppServerTransportOptions = {}) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const process = options.process ?? nodeProcess(options);
      let nextId = 1;
      let closed = false;
      const pending = new Map<CodexRequestId, { readonly fail: (error: CodexAppServerError) => void; readonly succeed: (value: Schema.Json) => void }>();
      const notificationListeners = new Set<(value: CodexNotification) => void>();
      const requestListeners = new Set<(value: CodexServerRequest) => void>();

      const write = (message: unknown) => Effect.try({
        try: () => process.write(`${JSON.stringify(message)}\n`),
        catch: () => new CodexAppServerTransportError({ message: "Failed to write to Codex App Server" }),
      });
      const failAll = (error: CodexAppServerError) => {
        if (closed) return;
        closed = true;
        for (const entry of pending.values()) entry.fail(error);
        pending.clear();
      };
      const removeLine = process.onLine((line) => {
        let value: unknown;
        try { value = JSON.parse(line); } catch {
          failAll(new CodexAppServerProtocolError({ message: "Invalid JSONL frame" }));
          return;
        }
        const response = decodeResponse(value);
        if (Option.isSome(response)) {
          const entry = pending.get(response.value.id);
          if (!entry) return;
          pending.delete(response.value.id);
          if ("error" in response.value) entry.fail(new CodexAppServerProtocolError({ message: response.value.error.message }));
          else entry.succeed(response.value.result);
          return;
        }
        const request = decodeRequest(value);
        if (Option.isSome(request)) {
          const method = decodeRequestMethod(request.value.method);
          if (Option.isNone(method)) {
            process.write(`${JSON.stringify({ id: request.value.id, error: { code: -32601, message: "Unsupported server request" } })}\n`);
            return;
          }
          for (const listener of requestListeners) listener({ id: request.value.id, method: method.value, params: request.value.params ?? {} });
          return;
        }
        const notification = decodeNotification(value);
        if (Option.isSome(notification)) {
          const method = decodeNotificationMethod(notification.value.method);
          if (Option.isSome(method)) for (const listener of notificationListeners) listener({ method: method.value, params: notification.value.params ?? {} });
        }
      });
      const removeExit = process.onExit((code) => failAll(new CodexAppServerProcessExitError({ code, stderr: process.stderr() })));
      const removeError = process.onError(() => failAll(new CodexAppServerTransportError({ message: "Failed to start Codex App Server" })));

      const connection: CodexAppServerConnection = {
        notify: (method, params = {}) => write({ method, params }),
        onNotification: (listener) => { notificationListeners.add(listener); return () => notificationListeners.delete(listener); },
        onServerRequest: (listener) => { requestListeners.add(listener); return () => requestListeners.delete(listener); },
        request: (method, params = {}, timeoutMs = 30_000) => Effect.callback<Schema.Json, CodexAppServerError>((resume) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            resume(Effect.fail(new CodexAppServerTimeoutError({ method, timeoutMs })));
          }, timeoutMs);
          pending.set(id, {
            fail: (error) => { clearTimeout(timer); resume(Effect.fail(error)); },
            succeed: (result) => { clearTimeout(timer); resume(Effect.succeed(result)); },
          });
          Effect.runSync(write({ id, method, params }));
          return Effect.sync(() => { clearTimeout(timer); pending.delete(id); });
        }),
        respond: (id, result) => write({ id, result }),
      };
      return { close: () => { failAll(new CodexAppServerTransportError({ message: "Codex App Server connection released" })); removeLine(); removeExit(); removeError(); process.kill(); }, connection };
    }),
    ({ close }) => Effect.sync(close),
  ).pipe(Effect.map(({ connection }) => connection));
}

export class CodexAppServerConnectionService extends Context.Service<CodexAppServerConnectionService, CodexAppServerConnection>()("@gaia/runtime/CodexAppServerConnection") {}
export const CodexAppServerConnectionLive = (options: CodexAppServerTransportOptions = {}) => Layer.effect(CodexAppServerConnectionService, makeCodexAppServerConnection(options));

const objectResult = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json));
export function makeCodexAppServerClient(connection: CodexAppServerConnection) {
  const requestObject = (method: string, params: JsonObject = {}) => connection.request(method, params).pipe(
    Effect.flatMap((result) => objectResult(result).pipe(
      Effect.mapError(() => new CodexAppServerProtocolError({ method, message: `Invalid ${method} response` })),
    )),
  );
  return {
    initialize: (clientInfo: JsonObject) => requestObject("initialize", { clientInfo }).pipe(Effect.tap(() => connection.notify("initialized"))),
    interruptTurn: (params: JsonObject) => requestObject("turn/interrupt", params),
    onNotification: connection.onNotification,
    onServerRequest: connection.onServerRequest,
    readThread: (params: JsonObject) => requestObject("thread/read", params),
    respond: connection.respond,
    resumeThread: (params: JsonObject) => requestObject("thread/resume", params),
    startThread: (params: JsonObject) => requestObject("thread/start", params),
    startTurn: (params: JsonObject) => requestObject("turn/start", params),
    steerTurn: (params: JsonObject) => requestObject("turn/steer", params),
  } as const;
}
