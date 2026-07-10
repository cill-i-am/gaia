import { Schema } from "effect";

export const supportedCodexCliVersion = "0.137.0" as const;
export const CodexRequestIdSchema = Schema.Union([Schema.String, Schema.Number]);
export type CodexRequestId = typeof CodexRequestIdSchema.Type;

const ThreadId = Schema.String.pipe(Schema.brand("CodexThreadId"));
const TurnId = Schema.String.pipe(Schema.brand("CodexTurnId"));
const ItemId = Schema.String.pipe(Schema.brand("CodexItemId"));
const Thread = Schema.Struct({ id: ThreadId });
const Turn = Schema.Struct({ id: TurnId, status: Schema.optionalKey(Schema.String) });
const Empty = Schema.Struct({});

export const InitializeParamsSchema = Schema.Struct({
  clientInfo: Schema.Struct({ name: Schema.String, title: Schema.String, version: Schema.String }),
});
export const InitializeResultSchema = Schema.Struct({
  platformFamily: Schema.String,
  platformOs: Schema.String,
  userAgent: Schema.String,
});
export const ThreadStartParamsSchema = Schema.Struct({
  approvalPolicy: Schema.optionalKey(Schema.Literals(["untrusted", "on-failure", "on-request", "never"] as const)),
  cwd: Schema.optionalKey(Schema.String),
  ephemeral: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.String),
  sandbox: Schema.optionalKey(Schema.Literals(["read-only", "workspace-write", "danger-full-access"] as const)),
});
export const ThreadResumeParamsSchema = Schema.Struct({ threadId: ThreadId });
export const ThreadReadParamsSchema = Schema.Struct({ includeTurns: Schema.optionalKey(Schema.Boolean), threadId: ThreadId });
export const ThreadResultSchema = Schema.Struct({ thread: Thread });
export const TextInputSchema = Schema.Struct({ text: Schema.String, type: Schema.Literal("text") });
export const TurnStartParamsSchema = Schema.Struct({ input: Schema.Array(TextInputSchema), threadId: ThreadId });
export const TurnSteerParamsSchema = Schema.Struct({ expectedTurnId: TurnId, input: Schema.Array(TextInputSchema), threadId: ThreadId });
export const TurnInterruptParamsSchema = Schema.Struct({ threadId: ThreadId, turnId: TurnId });
export const TurnResultSchema = Schema.Struct({ turn: Turn });
export const TurnSteerResultSchema = Schema.Struct({ turnId: TurnId });
export const EmptyResultSchema = Empty;

const BaseInteraction = { itemId: ItemId, threadId: ThreadId, turnId: TurnId } as const;
const CommandRequest = Schema.Struct({ id: CodexRequestIdSchema, method: Schema.Literal("item/commandExecution/requestApproval"), params: Schema.Struct({ ...BaseInteraction, command: Schema.NullOr(Schema.String), startedAtMs: Schema.Number }) });
const FileRequest = Schema.Struct({ id: CodexRequestIdSchema, method: Schema.Literal("item/fileChange/requestApproval"), params: Schema.Struct({ ...BaseInteraction, reason: Schema.NullOr(Schema.String), startedAtMs: Schema.Number }) });
const PermissionRequest = Schema.Struct({ id: CodexRequestIdSchema, method: Schema.Literal("item/permissions/requestApproval"), params: Schema.Struct({ ...BaseInteraction, cwd: Schema.String, permissions: Schema.Unknown, startedAtMs: Schema.Number }) });
const UserInputRequest = Schema.Struct({ id: CodexRequestIdSchema, method: Schema.Literal("item/tool/requestUserInput"), params: Schema.Struct({ ...BaseInteraction, questions: Schema.Array(Schema.Struct({ header: Schema.String, id: Schema.String, question: Schema.String })) }) });
const ElicitationRequest = Schema.Struct({ id: CodexRequestIdSchema, method: Schema.Literal("mcpServer/elicitation/request"), params: Schema.Struct({ serverName: Schema.String, threadId: ThreadId, turnId: Schema.optionalKey(Schema.NullOr(TurnId)) }) });
export const CodexServerRequestSchema = Schema.Union([CommandRequest, FileRequest, PermissionRequest, UserInputRequest, ElicitationRequest]);
export type CodexServerRequest = typeof CodexServerRequestSchema.Type;

const ItemParams = Schema.Struct({ item: Schema.Struct({ id: ItemId, type: Schema.String }), threadId: ThreadId, turnId: TurnId });
const TurnParams = Schema.Struct({ threadId: ThreadId, turn: Turn });
const notification = <M extends string, S extends Schema.Top>(method: M, params: S) => Schema.Struct({ method: Schema.Literal(method), params });
export const CodexNotificationSchema = Schema.Union([
  notification("thread/started", Schema.Struct({ thread: Thread })),
  notification("thread/status/changed", Schema.Struct({ threadId: ThreadId, status: Schema.String })),
  notification("turn/started", TurnParams), notification("turn/completed", TurnParams),
  notification("turn/diff/updated", Schema.Struct({ diff: Schema.String, threadId: ThreadId, turnId: TurnId })),
  notification("turn/plan/updated", Schema.Struct({ threadId: ThreadId, turnId: TurnId })),
  notification("item/started", ItemParams), notification("item/completed", ItemParams),
  notification("item/agentMessage/delta", Schema.Struct({ delta: Schema.String, itemId: ItemId, threadId: ThreadId, turnId: TurnId })),
  notification("item/commandExecution/outputDelta", Schema.Struct({ delta: Schema.String, itemId: ItemId, threadId: ThreadId, turnId: TurnId })),
  notification("warning", Schema.Struct({ message: Schema.String })), notification("error", Schema.Struct({ message: Schema.String })),
  notification("serverRequest/resolved", Schema.Struct({ requestId: CodexRequestIdSchema })),
]);
export type CodexNotification = typeof CodexNotificationSchema.Type;

export const CommandApprovalResponseSchema = Schema.Struct({ decision: Schema.Literals(["accept", "acceptForSession", "decline", "cancel"] as const) });
export const FileApprovalResponseSchema = CommandApprovalResponseSchema;
export const PermissionApprovalResponseSchema = Schema.Struct({ permissions: Schema.Unknown, scope: Schema.optionalKey(Schema.Literals(["turn", "session"] as const)), strictAutoReview: Schema.optionalKey(Schema.NullOr(Schema.Boolean)) });
export const UserInputResponseSchema = Schema.Struct({ answers: Schema.Record(Schema.String, Schema.Struct({ answers: Schema.Array(Schema.String) })) });
export const ElicitationResponseSchema = Schema.Struct({ action: Schema.Literals(["accept", "decline", "cancel"] as const), content: Schema.optionalKey(Schema.Unknown) });

export const CodexAppServerResponseSchema = Schema.Union([Schema.Struct({ id: CodexRequestIdSchema, result: Schema.Json }), Schema.Struct({ error: Schema.Struct({ code: Schema.Number, message: Schema.String }), id: CodexRequestIdSchema })]);
export const CodexAppServerInboundRequestSchema = Schema.Struct({ id: CodexRequestIdSchema, method: Schema.String, params: Schema.optionalKey(Schema.Unknown) });
export const CodexAppServerNotificationSchema = Schema.Struct({ method: Schema.String, params: Schema.optionalKey(Schema.Unknown) });

export class CodexAppServerTransportError extends Schema.TaggedErrorClass<CodexAppServerTransportError>()("CodexAppServerTransportError", { message: Schema.String }) {}
export class CodexAppServerProtocolError extends Schema.TaggedErrorClass<CodexAppServerProtocolError>()("CodexAppServerProtocolError", { message: Schema.String, method: Schema.optionalKey(Schema.String) }) {}
export class CodexAppServerTimeoutError extends Schema.TaggedErrorClass<CodexAppServerTimeoutError>()("CodexAppServerTimeoutError", { method: Schema.String, timeoutMs: Schema.Number }) {}
export class CodexAppServerProcessExitError extends Schema.TaggedErrorClass<CodexAppServerProcessExitError>()("CodexAppServerProcessExitError", { code: Schema.NullOr(Schema.Number), stderr: Schema.String }) {}
export class CodexAppServerIncompatibilityError extends Schema.TaggedErrorClass<CodexAppServerIncompatibilityError>()("CodexAppServerIncompatibilityError", { actualUserAgent: Schema.String, supportedVersion: Schema.String }) {}
export type CodexAppServerError = CodexAppServerTransportError | CodexAppServerProtocolError | CodexAppServerTimeoutError | CodexAppServerProcessExitError | CodexAppServerIncompatibilityError;
