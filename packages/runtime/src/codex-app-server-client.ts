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
  supportedCodexCliVersion,
  type CodexAppServerError,
  type CodexRequestId,
  type CodexNotification,
  type CodexServerRequest,
} from "./codex-app-server-protocol.js";

type JsonObject = Readonly<Record<string, Schema.Json>>;
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
const decodeServerRequest = Schema.decodeUnknownOption(CodexServerRequestSchema);
const decodeCuratedNotification = Schema.decodeUnknownOption(CodexNotificationSchema);

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
          const decoded = decodeServerRequest(request.value);
          if (Option.isNone(decoded)) {
            process.write(`${JSON.stringify({ id: request.value.id, error: { code: -32601, message: "Unsupported server request" } })}\n`);
            return;
          }
          for (const listener of requestListeners) listener(decoded.value);
          return;
        }
        const notification = decodeNotification(value);
        if (Option.isSome(notification)) {
          const decoded = decodeCuratedNotification(notification.value);
          if (Option.isSome(decoded)) for (const listener of notificationListeners) listener(decoded.value);
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
          try {
            process.write(`${JSON.stringify({ id, method, params })}\n`);
          } catch {
            clearTimeout(timer);
            pending.delete(id);
            resume(Effect.fail(new CodexAppServerTransportError({ message: "Failed to write to Codex App Server" })));
          }
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

export function makeCodexAppServerClient(connection: CodexAppServerConnection) {
  const request = <S extends Schema.Top>(method: string, params: JsonObject, schema: S) => connection.request(method, params).pipe(
    Effect.flatMap((result) => Schema.decodeUnknownEffect(schema)(result).pipe(
      Effect.mapError(() => new CodexAppServerProtocolError({ method, message: `Invalid ${method} response` })),
    )),
  );
  return {
    initialize: (clientInfo: { readonly name: string; readonly title: string; readonly version: string }) => request("initialize", { clientInfo }, InitializeResultSchema).pipe(
      Effect.flatMap((result) => result.userAgent.includes(`/${supportedCodexCliVersion} `)
        ? Effect.succeed(result)
        : Effect.fail(new CodexAppServerIncompatibilityError({ actualUserAgent: result.userAgent, supportedVersion: supportedCodexCliVersion }))),
      Effect.tap(() => connection.notify("initialized")),
    ),
    interruptTurn: (params: { readonly threadId: string; readonly turnId: string }) => request("turn/interrupt", params, EmptyResultSchema),
    onNotification: connection.onNotification,
    onServerRequest: connection.onServerRequest,
    readThread: (params: { readonly threadId: string; readonly includeTurns?: boolean }) => request("thread/read", params, ThreadResultSchema),
    respondCommandApproval: (id: CodexRequestId, response: typeof CommandApprovalResponseSchema.Type) => Schema.decodeUnknownEffect(CommandApprovalResponseSchema)(response).pipe(Effect.flatMap((value) => connection.respond(id, value))),
    respondFileApproval: (id: CodexRequestId, response: typeof FileApprovalResponseSchema.Type) => Schema.decodeUnknownEffect(FileApprovalResponseSchema)(response).pipe(Effect.flatMap((value) => connection.respond(id, value))),
    respondPermissionApproval: (id: CodexRequestId, response: typeof PermissionApprovalResponseSchema.Type) => Schema.decodeUnknownEffect(PermissionApprovalResponseSchema)(response).pipe(Effect.flatMap((value) => connection.respond(id, value as Schema.Json))),
    respondUserInput: (id: CodexRequestId, response: typeof UserInputResponseSchema.Type) => Schema.decodeUnknownEffect(UserInputResponseSchema)(response).pipe(Effect.flatMap((value) => connection.respond(id, value))),
    respondElicitation: (id: CodexRequestId, response: typeof ElicitationResponseSchema.Type) => Schema.decodeUnknownEffect(ElicitationResponseSchema)(response).pipe(Effect.flatMap((value) => connection.respond(id, value as Schema.Json))),
    resumeThread: (params: { readonly threadId: string }) => request("thread/resume", params, ThreadResultSchema),
    startThread: (params: { readonly approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never"; readonly cwd?: string; readonly ephemeral?: boolean; readonly model?: string; readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access" }) => request("thread/start", params, ThreadResultSchema),
    startTurn: (params: { readonly input: ReadonlyArray<{ readonly type: "text"; readonly text: string }>; readonly threadId: string }) => request("turn/start", params, TurnResultSchema),
    steerTurn: (params: { readonly expectedTurnId: string; readonly input: ReadonlyArray<{ readonly type: "text"; readonly text: string }>; readonly threadId: string }) => request("turn/steer", params, TurnSteerResultSchema),
  } as const;
}

export type CodexAppServerClient = ReturnType<typeof makeCodexAppServerClient>;
export class CodexAppServerClientService extends Context.Service<CodexAppServerClientService, CodexAppServerClient>()("@gaia/runtime/CodexAppServerClient") {}
export const CodexAppServerClientLive = (options: CodexAppServerTransportOptions = {}) => Layer.effect(CodexAppServerClientService, makeCodexAppServerConnection(options).pipe(Effect.map(makeCodexAppServerClient)));
