import { Schema } from "effect";

export const CodexRequestIdSchema = Schema.Union([Schema.String, Schema.Number]);
export type CodexRequestId = typeof CodexRequestIdSchema.Type;

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

export const CodexAppServerResponseSchema = Schema.Union([
  Schema.Struct({ id: CodexRequestIdSchema, result: Schema.Json }),
  Schema.Struct({
    error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
    id: CodexRequestIdSchema,
  }),
]);

export const CodexAppServerInboundRequestSchema = Schema.Struct({
  id: CodexRequestIdSchema,
  method: Schema.String,
  params: Schema.optionalKey(JsonObjectSchema),
});

export const CodexAppServerNotificationSchema = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(JsonObjectSchema),
});

export const CodexStableServerRequestMethodSchema = Schema.Literals([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
] as const);
export type CodexStableServerRequestMethod =
  typeof CodexStableServerRequestMethodSchema.Type;

export const CodexStableNotificationMethodSchema = Schema.Literals([
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "warning",
  "error",
  "serverRequest/resolved",
] as const);
export type CodexStableNotificationMethod =
  typeof CodexStableNotificationMethodSchema.Type;

export class CodexAppServerTransportError extends Schema.TaggedErrorClass<CodexAppServerTransportError>()(
  "CodexAppServerTransportError",
  { message: Schema.String },
) {}
export class CodexAppServerProtocolError extends Schema.TaggedErrorClass<CodexAppServerProtocolError>()(
  "CodexAppServerProtocolError",
  { message: Schema.String, method: Schema.optionalKey(Schema.String) },
) {}
export class CodexAppServerTimeoutError extends Schema.TaggedErrorClass<CodexAppServerTimeoutError>()(
  "CodexAppServerTimeoutError",
  { method: Schema.String, timeoutMs: Schema.Number },
) {}
export class CodexAppServerProcessExitError extends Schema.TaggedErrorClass<CodexAppServerProcessExitError>()(
  "CodexAppServerProcessExitError",
  { code: Schema.NullOr(Schema.Number), stderr: Schema.String },
) {}
export class CodexAppServerIncompatibilityError extends Schema.TaggedErrorClass<CodexAppServerIncompatibilityError>()(
  "CodexAppServerIncompatibilityError",
  { message: Schema.String },
) {}

export type CodexAppServerError =
  | CodexAppServerTransportError
  | CodexAppServerProtocolError
  | CodexAppServerTimeoutError
  | CodexAppServerProcessExitError
  | CodexAppServerIncompatibilityError;
