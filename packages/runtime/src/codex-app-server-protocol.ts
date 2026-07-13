import nodePath from "node:path";

import { Schema } from "effect";

export const supportedCodexCliVersion = "0.137.0" as const;
const CodexProviderIdentifierSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(4_096))
);

/** JSON-RPC request identity accepted by Codex App Server 0.137.0. */
export const CodexRequestIdSchema = Schema.Union([
  CodexProviderIdentifierSchema,
  Schema.Number.pipe(Schema.check(Schema.makeFilter(Number.isSafeInteger))),
]).pipe(Schema.brand("CodexRequestId"));
export type CodexRequestId = typeof CodexRequestIdSchema.Type;
/** Parse a provider JSON-RPC request identity at the boundary. */
export const parseCodexRequestId =
  Schema.decodeUnknownSync(CodexRequestIdSchema);

/** Provider-native Codex thread identity. */
export const CodexThreadIdSchema = CodexProviderIdentifierSchema.pipe(
  Schema.brand("CodexThreadId")
);
/** Provider-native Codex turn identity. */
export const CodexTurnIdSchema = CodexProviderIdentifierSchema.pipe(
  Schema.brand("CodexTurnId")
);
/** Provider-native Codex item identity. */
export const CodexItemIdSchema = CodexProviderIdentifierSchema.pipe(
  Schema.brand("CodexItemId")
);
/** Provider-native Codex model identity. */
export const CodexModelIdSchema = CodexProviderIdentifierSchema.pipe(
  Schema.brand("CodexModelId")
);
export type CodexModelId = typeof CodexModelIdSchema.Type;
/** Semver-compatible client version sent during initialize. */
export const CodexClientVersionSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
    ),
    Schema.isMaxLength(200)
  ),
  Schema.brand("CodexClientVersion")
);
/** Non-empty bounded command text received from the provider. */
export const CodexProtocolCommandSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) => value.trim().length > 0 && !value.includes("\0")
    ),
    Schema.isMaxLength(16_384)
  ),
  Schema.brand("CodexProtocolCommand")
);
/** Bounded MCP server name received from the provider. */
export const CodexServerNameSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.length > 0 && value === value.trim()),
    Schema.isMaxLength(200)
  ),
  Schema.brand("CodexServerName")
);
/** HTTP(S) URL decoded from a Codex provider message. */
export const CodexHttpUrlSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value))
        return false;
      try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    })
  ),
  Schema.check(Schema.isMaxLength(8_192)),
  Schema.brand("CodexHttpUrl")
);
/** Absolute normalized path used by Codex permission requests. */
export const CodexPermissionAbsolutePathSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        value.length > 0 &&
        !value.includes("\0") &&
        nodePath.isAbsolute(value) &&
        nodePath.normalize(value) === value
    )
  ),
  Schema.check(Schema.isMaxLength(16_384)),
  Schema.brand("CodexPermissionAbsolutePath")
);
/** Parse a Codex model identity at the adapter boundary. */
export const parseCodexModelId = Schema.decodeUnknownSync(CodexModelIdSchema);
/** Parse a Codex client version before initialize. */
export const parseCodexClientVersion = Schema.decodeUnknownSync(
  CodexClientVersionSchema
);
/** Parse an absolute normalized provider permission path. */
export const parseCodexPermissionAbsolutePath = Schema.decodeUnknownSync(
  CodexPermissionAbsolutePathSchema
);
export type CodexThreadId = typeof CodexThreadIdSchema.Type;
export type CodexTurnId = typeof CodexTurnIdSchema.Type;
export const parseCodexThreadId = Schema.decodeUnknownSync(CodexThreadIdSchema);
export const parseCodexTurnId = Schema.decodeUnknownSync(CodexTurnIdSchema);
const ThreadId = CodexThreadIdSchema;
const TurnId = CodexTurnIdSchema;
const ItemId = CodexItemIdSchema;
export type CodexItemId = typeof ItemId.Type;
export const parseCodexItemId = Schema.decodeUnknownSync(ItemId);
const CodexFileChange = Schema.Struct({
  diff: Schema.String,
  kind: Schema.Union([
    Schema.Struct({ type: Schema.Literal("add") }),
    Schema.Struct({ type: Schema.Literal("delete") }),
    Schema.Struct({
      move_path: Schema.NullOr(Schema.String),
      type: Schema.Literal("update"),
    }),
  ]),
  path: Schema.String,
});
export const CodexThreadItemSchema = Schema.Union([
  Schema.Struct({
    clientId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    content: Schema.Array(Schema.Json),
    id: ItemId,
    type: Schema.Literal("userMessage"),
  }),
  Schema.Struct({
    fragments: Schema.Array(Schema.Json),
    id: ItemId,
    type: Schema.Literal("hookPrompt"),
  }),
  Schema.Struct({
    id: ItemId,
    memoryCitation: Schema.optionalKey(Schema.NullOr(Schema.Json)),
    phase: Schema.optionalKey(
      Schema.NullOr(Schema.Literals(["commentary", "final_answer"] as const))
    ),
    text: Schema.String,
    type: Schema.Literal("agentMessage"),
  }),
  Schema.Struct({
    id: ItemId,
    text: Schema.String,
    type: Schema.Literal("plan"),
  }),
  Schema.Struct({ id: ItemId, type: Schema.Literal("reasoning") }),
  Schema.Struct({
    aggregatedOutput: Schema.optionalKey(Schema.NullOr(Schema.String)),
    command: Schema.String,
    commandActions: Schema.optionalKey(Schema.Array(Schema.Json)),
    cwd: Schema.String,
    durationMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    exitCode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    id: ItemId,
    status: Schema.Literals([
      "inProgress",
      "completed",
      "failed",
      "declined",
    ] as const),
    type: Schema.Literal("commandExecution"),
  }),
  Schema.Struct({
    changes: Schema.Array(CodexFileChange),
    id: ItemId,
    status: Schema.Literals([
      "inProgress",
      "completed",
      "failed",
      "declined",
    ] as const),
    type: Schema.Literal("fileChange"),
  }),
  Schema.Struct({
    durationMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    error: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ message: Schema.String }))
    ),
    id: ItemId,
    server: Schema.String,
    status: Schema.Literals(["inProgress", "completed", "failed"] as const),
    tool: Schema.String,
    type: Schema.Literal("mcpToolCall"),
  }),
  Schema.Struct({
    durationMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    id: ItemId,
    status: Schema.Literals(["inProgress", "completed", "failed"] as const),
    tool: Schema.String,
    type: Schema.Literal("dynamicToolCall"),
  }),
  Schema.Struct({
    agentsStates: Schema.Record(Schema.String, Schema.Json),
    id: ItemId,
    model: Schema.optionalKey(Schema.NullOr(CodexModelIdSchema)),
    prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    receiverThreadIds: Schema.Array(ThreadId),
    senderThreadId: ThreadId,
    status: Schema.String,
    tool: Schema.String,
    type: Schema.Literal("collabAgentToolCall"),
  }),
  Schema.Struct({
    id: ItemId,
    query: Schema.String,
    type: Schema.Literal("webSearch"),
  }),
  Schema.Struct({
    id: ItemId,
    path: CodexPermissionAbsolutePathSchema,
    type: Schema.Literal("imageView"),
  }),
  Schema.Struct({
    id: ItemId,
    result: Schema.String,
    revisedPrompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    savedPath: Schema.optionalKey(
      Schema.NullOr(CodexPermissionAbsolutePathSchema)
    ),
    status: Schema.String,
    type: Schema.Literal("imageGeneration"),
  }),
  Schema.Struct({
    id: ItemId,
    review: Schema.String,
    type: Schema.Literal("enteredReviewMode"),
  }),
  Schema.Struct({
    id: ItemId,
    review: Schema.String,
    type: Schema.Literal("exitedReviewMode"),
  }),
  Schema.Struct({ id: ItemId, type: Schema.Literal("contextCompaction") }),
]);
export type CodexThreadItem = typeof CodexThreadItemSchema.Type;
const TurnError = Schema.Struct({
  additionalDetails: Schema.optionalKey(Schema.NullOr(Schema.String)),
  codexErrorInfo: Schema.optionalKey(Schema.NullOr(Schema.Json)),
  message: Schema.String,
});
const Turn = Schema.Struct({
  error: Schema.optionalKey(Schema.NullOr(TurnError)),
  id: TurnId,
  items: Schema.optionalKey(Schema.Array(CodexThreadItemSchema)),
  status: Schema.optionalKey(
    Schema.Literals([
      "completed",
      "interrupted",
      "failed",
      "inProgress",
    ] as const)
  ),
});
export const CodexThreadSchema = Schema.Struct({
  id: ThreadId,
  status: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("notLoaded") }),
      Schema.Struct({ type: Schema.Literal("idle") }),
      Schema.Struct({ type: Schema.Literal("systemError") }),
      Schema.Struct({
        activeFlags: Schema.Array(
          Schema.Literals(["waitingOnApproval", "waitingOnUserInput"] as const)
        ),
        type: Schema.Literal("active"),
      }),
    ])
  ),
  turns: Schema.optionalKey(Schema.Array(Turn)),
});
export type CodexThread = typeof CodexThreadSchema.Type;
const Thread = CodexThreadSchema;
const Empty = Schema.Struct({});
export const CodexThreadSourceKindSchema = Schema.Literals([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const);
const CodexThreadSourceSchema = Schema.Union([
  Schema.Literals(["cli", "vscode", "exec", "appServer", "unknown"] as const),
  Schema.Struct({ custom: Schema.String }),
  Schema.Struct({ subAgent: Schema.Json }),
]);
export const ThreadListParamsSchema = Schema.Struct({
  archived: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)]))
  ),
  limit: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  modelProviders: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.String))
  ),
  searchTerm: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sortDirection: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["asc", "desc"] as const))
  ),
  sortKey: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["created_at", "updated_at"] as const))
  ),
  sourceKinds: Schema.optionalKey(
    Schema.NullOr(Schema.Array(CodexThreadSourceKindSchema))
  ),
  useStateDbOnly: Schema.optionalKey(Schema.Boolean),
});
export const CodexListedThreadSchema = Schema.Struct({
  createdAt: Schema.Number,
  cwd: Schema.String,
  id: ThreadId,
  sessionId: Schema.String,
  source: CodexThreadSourceSchema,
  status: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("notLoaded") }),
      Schema.Struct({ type: Schema.Literal("idle") }),
      Schema.Struct({ type: Schema.Literal("systemError") }),
      Schema.Struct({
        activeFlags: Schema.Array(
          Schema.Literals(["waitingOnApproval", "waitingOnUserInput"] as const)
        ),
        type: Schema.Literal("active"),
      }),
    ])
  ),
  turns: Schema.optionalKey(Schema.Array(Turn)),
  updatedAt: Schema.Number,
});
export const ThreadListResultSchema = Schema.Struct({
  backwardsCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  data: Schema.Array(CodexListedThreadSchema),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ThreadListParams = typeof ThreadListParamsSchema.Type;
export type ThreadListResult = typeof ThreadListResultSchema.Type;
export type CodexListedThread = typeof CodexListedThreadSchema.Type;

export const InitializeParamsSchema = Schema.Struct({
  clientInfo: Schema.Struct({
    name: Schema.String,
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    version: CodexClientVersionSchema,
  }),
});
export const InitializeResultSchema = Schema.Struct({
  codexHome: Schema.String,
  platformFamily: Schema.String,
  platformOs: Schema.String,
  userAgent: Schema.String,
});
export const ThreadStartParamsSchema = Schema.Struct({
  approvalPolicy: Schema.optionalKey(
    Schema.Literals(["untrusted", "on-failure", "on-request", "never"] as const)
  ),
  cwd: Schema.optionalKey(Schema.String),
  ephemeral: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(CodexModelIdSchema),
  sandbox: Schema.optionalKey(
    Schema.Literals([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ] as const)
  ),
});
export const ThreadResumeParamsSchema = Schema.Struct({ threadId: ThreadId });
export const ThreadReadParamsSchema = Schema.Struct({
  includeTurns: Schema.optionalKey(Schema.Boolean),
  threadId: ThreadId,
});
export const ThreadResultSchema = Schema.Struct({ thread: Thread });
export type ThreadResult = typeof ThreadResultSchema.Type;
export const TextInputSchema = Schema.Struct({
  text: Schema.String,
  type: Schema.Literal("text"),
});
export const TurnStartParamsSchema = Schema.Struct({
  clientUserMessageId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  input: Schema.Array(TextInputSchema).pipe(
    Schema.check(Schema.isMaxLength(100))
  ),
  model: Schema.optionalKey(Schema.NullOr(CodexModelIdSchema)),
  threadId: ThreadId,
});
export const ModelListParamsSchema = Schema.Struct({
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  includeHidden: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  limit: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export const CodexModelSchema = Schema.Struct({
  displayName: Schema.String,
  hidden: Schema.Boolean,
  id: CodexModelIdSchema,
  model: CodexModelIdSchema,
});
export const ModelListResultSchema = Schema.Struct({
  data: Schema.Array(CodexModelSchema),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const TurnSteerParamsSchema = Schema.Struct({
  expectedTurnId: TurnId,
  input: Schema.Array(TextInputSchema).pipe(
    Schema.check(Schema.isMaxLength(100))
  ),
  threadId: ThreadId,
});
export const TurnInterruptParamsSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
export const TurnResultSchema = Schema.Struct({ turn: Turn });
export const TurnSteerResultSchema = Schema.Struct({ turnId: TurnId });
export const EmptyResultSchema = Empty;

const BaseInteraction = {
  itemId: ItemId,
  threadId: ThreadId,
  turnId: TurnId,
} as const;
const CommandRequest = Schema.Struct({
  id: CodexRequestIdSchema,
  method: Schema.Literal("item/commandExecution/requestApproval"),
  params: Schema.Struct({
    ...BaseInteraction,
    approvalId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    command: Schema.optionalKey(Schema.NullOr(CodexProtocolCommandSchema)),
    commandActions: Schema.optionalKey(
      Schema.NullOr(Schema.Array(Schema.Json))
    ),
    cwd: Schema.optionalKey(Schema.NullOr(CodexPermissionAbsolutePathSchema)),
    networkApprovalContext: Schema.optionalKey(Schema.NullOr(Schema.Json)),
    proposedExecpolicyAmendment: Schema.optionalKey(
      Schema.NullOr(Schema.Array(Schema.String))
    ),
    proposedNetworkPolicyAmendments: Schema.optionalKey(
      Schema.NullOr(Schema.Array(Schema.Json))
    ),
    reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    startedAtMs: Schema.Number,
  }),
});
const FileRequest = Schema.Struct({
  id: CodexRequestIdSchema,
  method: Schema.Literal("item/fileChange/requestApproval"),
  params: Schema.Struct({
    ...BaseInteraction,
    grantRoot: Schema.optionalKey(
      Schema.NullOr(CodexPermissionAbsolutePathSchema)
    ),
    reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    startedAtMs: Schema.Number,
  }),
});
const AdditionalNetworkPermissionsSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
const FileSystemPathSchema = Schema.Union([
  Schema.Struct({
    path: CodexPermissionAbsolutePathSchema,
    type: Schema.Literal("path"),
  }),
  Schema.Struct({
    pattern: Schema.String.pipe(
      Schema.check(
        Schema.makeFilter((value) => value.length > 0 && !value.includes("\0")),
        Schema.isMaxLength(16_384)
      )
    ),
    type: Schema.Literal("glob_pattern"),
  }),
  Schema.Struct({
    type: Schema.Literal("special"),
    value: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("root") }),
      Schema.Struct({ kind: Schema.Literal("minimal") }),
      Schema.Struct({
        kind: Schema.Literal("project_roots"),
        subpath: Schema.NullOr(Schema.String),
      }),
      Schema.Struct({ kind: Schema.Literal("tmpdir") }),
      Schema.Struct({ kind: Schema.Literal("slash_tmp") }),
      Schema.Struct({
        kind: Schema.Literal("unknown"),
        path: Schema.String,
        subpath: Schema.NullOr(Schema.String),
      }),
    ]),
  }),
]);
const FileSystemSandboxEntrySchema = Schema.Struct({
  access: Schema.Literals(["read", "write", "deny"] as const),
  path: FileSystemPathSchema,
});
const AdditionalFileSystemPermissionsSchema = Schema.Struct({
  entries: Schema.optionalKey(
    Schema.NullOr(Schema.Array(FileSystemSandboxEntrySchema))
  ),
  globScanMaxDepth: Schema.optionalKey(
    Schema.NullOr(
      Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))
    )
  ),
  read: Schema.optionalKey(
    Schema.NullOr(Schema.Array(CodexPermissionAbsolutePathSchema))
  ),
  write: Schema.optionalKey(
    Schema.NullOr(Schema.Array(CodexPermissionAbsolutePathSchema))
  ),
});
const RequestPermissionProfileSchema = Schema.Struct({
  fileSystem: Schema.optionalKey(
    Schema.NullOr(AdditionalFileSystemPermissionsSchema)
  ),
  network: Schema.optionalKey(
    Schema.NullOr(AdditionalNetworkPermissionsSchema)
  ),
});
const GrantedPermissionProfileSchema = Schema.Struct({
  fileSystem: Schema.optionalKey(
    Schema.NullOr(AdditionalFileSystemPermissionsSchema)
  ),
  network: Schema.optionalKey(
    Schema.NullOr(AdditionalNetworkPermissionsSchema)
  ),
});
const PermissionRequest = Schema.Struct({
  id: CodexRequestIdSchema,
  method: Schema.Literal("item/permissions/requestApproval"),
  params: Schema.Struct({
    ...BaseInteraction,
    cwd: CodexPermissionAbsolutePathSchema,
    environmentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    permissions: RequestPermissionProfileSchema,
    reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    startedAtMs: Schema.Number,
  }),
});
const UserInputOption = Schema.Struct({
  description: Schema.String,
  label: Schema.String,
});
const UserInputQuestion = Schema.Struct({
  header: Schema.String,
  id: Schema.String,
  isOther: Schema.optionalKey(Schema.Boolean),
  isSecret: Schema.optionalKey(Schema.Boolean),
  options: Schema.optionalKey(Schema.NullOr(Schema.Array(UserInputOption))),
  question: Schema.String,
});
const UserInputRequest = Schema.Struct({
  id: CodexRequestIdSchema,
  method: Schema.Literal("item/tool/requestUserInput"),
  params: Schema.Struct({
    ...BaseInteraction,
    questions: Schema.Array(UserInputQuestion),
  }),
});
const ElicitationBase = {
  _meta: Schema.optionalKey(Schema.Json),
  message: Schema.String,
  serverName: CodexServerNameSchema,
  threadId: ThreadId,
  turnId: Schema.optionalKey(Schema.NullOr(TurnId)),
} as const;
const ElicitationRequest = Schema.Struct({
  id: CodexRequestIdSchema,
  method: Schema.Literal("mcpServer/elicitation/request"),
  params: Schema.Union([
    Schema.Struct({
      ...ElicitationBase,
      mode: Schema.Literal("form"),
      requestedSchema: Schema.Json,
    }),
    Schema.Struct({
      ...ElicitationBase,
      elicitationId: Schema.String,
      mode: Schema.Literal("url"),
      url: CodexHttpUrlSchema,
    }),
  ]),
});
export const CodexServerRequestSchema = Schema.Union([
  CommandRequest,
  FileRequest,
  PermissionRequest,
  UserInputRequest,
  ElicitationRequest,
]);
export type CodexServerRequest = typeof CodexServerRequestSchema.Type;

const ItemStartedParams = Schema.Struct({
  item: CodexThreadItemSchema,
  startedAtMs: Schema.Number,
  threadId: ThreadId,
  turnId: TurnId,
});
const ItemCompletedParams = Schema.Struct({
  completedAtMs: Schema.Number,
  item: CodexThreadItemSchema,
  threadId: ThreadId,
  turnId: TurnId,
});
const TurnParams = Schema.Struct({ threadId: ThreadId, turn: Turn });
const notification = <M extends string, S extends Schema.Top>(
  method: M,
  params: S
) => Schema.Struct({ method: Schema.Literal(method), params });
export const CodexNotificationSchema = Schema.Union([
  notification("thread/started", Schema.Struct({ thread: Thread })),
  notification(
    "thread/status/changed",
    Schema.Struct({
      threadId: ThreadId,
      status: Schema.Union([
        Schema.Struct({ type: Schema.Literal("notLoaded") }),
        Schema.Struct({ type: Schema.Literal("idle") }),
        Schema.Struct({ type: Schema.Literal("systemError") }),
        Schema.Struct({
          activeFlags: Schema.Array(
            Schema.Literals([
              "waitingOnApproval",
              "waitingOnUserInput",
            ] as const)
          ),
          type: Schema.Literal("active"),
        }),
      ]),
    })
  ),
  notification("turn/started", TurnParams),
  notification("turn/completed", TurnParams),
  notification(
    "turn/diff/updated",
    Schema.Struct({ diff: Schema.String, threadId: ThreadId, turnId: TurnId })
  ),
  notification(
    "turn/plan/updated",
    Schema.Struct({
      explanation: Schema.optionalKey(Schema.NullOr(Schema.String)),
      plan: Schema.Array(
        Schema.Struct({
          status: Schema.Literals([
            "pending",
            "inProgress",
            "completed",
          ] as const),
          step: Schema.String,
        })
      ),
      threadId: ThreadId,
      turnId: TurnId,
    })
  ),
  notification("item/started", ItemStartedParams),
  notification("item/completed", ItemCompletedParams),
  notification(
    "item/agentMessage/delta",
    Schema.Struct({
      delta: Schema.String,
      itemId: ItemId,
      threadId: ThreadId,
      turnId: TurnId,
    })
  ),
  notification(
    "item/commandExecution/outputDelta",
    Schema.Struct({
      delta: Schema.String,
      itemId: ItemId,
      threadId: ThreadId,
      turnId: TurnId,
    })
  ),
  notification(
    "item/fileChange/outputDelta",
    Schema.Struct({
      delta: Schema.String,
      itemId: ItemId,
      threadId: ThreadId,
      turnId: TurnId,
    })
  ),
  notification(
    "item/fileChange/patchUpdated",
    Schema.Struct({
      changes: Schema.Array(CodexFileChange),
      itemId: ItemId,
      threadId: ThreadId,
      turnId: TurnId,
    })
  ),
  notification(
    "thread/tokenUsage/updated",
    Schema.Struct({
      threadId: ThreadId,
      tokenUsage: Schema.Struct({
        last: Schema.Struct({
          cachedInputTokens: Schema.optionalKey(Schema.Number),
          inputTokens: Schema.Number,
          outputTokens: Schema.Number,
        }),
        modelContextWindow: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        total: Schema.Struct({
          cachedInputTokens: Schema.optionalKey(Schema.Number),
          inputTokens: Schema.Number,
          outputTokens: Schema.Number,
        }),
      }),
      turnId: TurnId,
    })
  ),
  notification(
    "warning",
    Schema.Struct({
      message: Schema.String,
      threadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
    })
  ),
  notification(
    "error",
    Schema.Struct({
      error: TurnError,
      threadId: ThreadId,
      turnId: TurnId,
      willRetry: Schema.Boolean,
    })
  ),
  notification(
    "serverRequest/resolved",
    Schema.Struct({ requestId: CodexRequestIdSchema, threadId: ThreadId })
  ),
]);
export type CodexNotification = typeof CodexNotificationSchema.Type;

/** True when a raw notification belongs to Gaia's curated stable subset. */
export function isCuratedCodexNotificationMethod(method: string): boolean {
  switch (method) {
    case "thread/started":
    case "thread/status/changed":
    case "turn/started":
    case "turn/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/completed":
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "thread/tokenUsage/updated":
    case "warning":
    case "error":
    case "serverRequest/resolved":
      return true;
    default:
      return false;
  }
}

export function isCodexServerRequestMethod(method: string): boolean {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
    case "item/tool/requestUserInput":
    case "mcpServer/elicitation/request":
      return true;
    default:
      return false;
  }
}

export const CommandApprovalResponseSchema = Schema.Struct({
  decision: Schema.Literals([
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
  ] as const),
});
export const FileApprovalResponseSchema = CommandApprovalResponseSchema;
export const PermissionApprovalResponseSchema = Schema.Struct({
  permissions: GrantedPermissionProfileSchema,
  scope: Schema.optionalKey(Schema.Literals(["turn", "session"] as const)),
  strictAutoReview: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
export const UserInputResponseSchema = Schema.Struct({
  answers: Schema.Record(
    Schema.String,
    Schema.Struct({
      answers: Schema.Array(Schema.String).pipe(
        Schema.check(Schema.isMaxLength(20))
      ),
    })
  ),
});
export const ElicitationResponseSchema = Schema.Struct({
  _meta: Schema.optionalKey(Schema.Json),
  action: Schema.Literals(["accept", "decline", "cancel"] as const),
  content: Schema.optionalKey(Schema.Json),
});

export type InitializeParams = typeof InitializeParamsSchema.Type;
export type ThreadStartParams = typeof ThreadStartParamsSchema.Type;
export type ThreadResumeParams = typeof ThreadResumeParamsSchema.Type;
export type ThreadReadParams = typeof ThreadReadParamsSchema.Type;
export type TurnStartParams = typeof TurnStartParamsSchema.Type;
export type TurnSteerParams = typeof TurnSteerParamsSchema.Type;
export type TurnInterruptParams = typeof TurnInterruptParamsSchema.Type;
export type CommandApprovalRequest = Extract<
  CodexServerRequest,
  { readonly method: "item/commandExecution/requestApproval" }
>;
export type FileApprovalRequest = Extract<
  CodexServerRequest,
  { readonly method: "item/fileChange/requestApproval" }
>;
export type PermissionApprovalRequest = Extract<
  CodexServerRequest,
  { readonly method: "item/permissions/requestApproval" }
>;
export type UserInputRequest = Extract<
  CodexServerRequest,
  { readonly method: "item/tool/requestUserInput" }
>;
export type ElicitationRequest = Extract<
  CodexServerRequest,
  { readonly method: "mcpServer/elicitation/request" }
>;

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
  params: Schema.optionalKey(Schema.Unknown),
});
export const CodexAppServerNotificationSchema = Schema.Struct({
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});

export class CodexAppServerTransportError extends Schema.TaggedErrorClass<CodexAppServerTransportError>()(
  "CodexAppServerTransportError",
  { message: Schema.String }
) {}
export class CodexAppServerProtocolError extends Schema.TaggedErrorClass<CodexAppServerProtocolError>()(
  "CodexAppServerProtocolError",
  { message: Schema.String, method: Schema.optionalKey(Schema.String) }
) {}
export class CodexAppServerTimeoutError extends Schema.TaggedErrorClass<CodexAppServerTimeoutError>()(
  "CodexAppServerTimeoutError",
  { method: Schema.String, timeoutMs: Schema.Number }
) {}
export class CodexAppServerProcessExitError extends Schema.TaggedErrorClass<CodexAppServerProcessExitError>()(
  "CodexAppServerProcessExitError",
  { code: Schema.NullOr(Schema.Number), stderr: Schema.String }
) {}
export class CodexAppServerIncompatibilityError extends Schema.TaggedErrorClass<CodexAppServerIncompatibilityError>()(
  "CodexAppServerIncompatibilityError",
  { actualUserAgent: Schema.String, supportedVersion: Schema.String }
) {}
export type CodexAppServerError =
  | CodexAppServerTransportError
  | CodexAppServerProtocolError
  | CodexAppServerTimeoutError
  | CodexAppServerProcessExitError
  | CodexAppServerIncompatibilityError;
