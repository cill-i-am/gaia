import nodePath from "node:path";

import { Schema } from "effect";

export const supportedCodexCliVersion = "0.137.0" as const;
const CodexRawIntegerSchema = Schema.Number.pipe(
  Schema.check(Schema.makeFilter(Number.isInteger))
);
const signedInt64Minimum = -(1n << 63n);
const signedInt64Maximum = (1n << 63n) - 1n;
const CodexRawSignedInt64Schema = Schema.Number.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      if (!Number.isFinite(value) || !Number.isInteger(value)) return false;
      const exactValue = BigInt(value);
      return (
        exactValue >= signedInt64Minimum && exactValue <= signedInt64Maximum
      );
    })
  )
);
const CodexRawNonNegativeIntegerSchema = CodexRawIntegerSchema.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0))
);
const strictRawStruct = <const Fields extends Schema.Struct.Fields>(
  identifier: string,
  fields: Fields
) => {
  const StrictRawStruct = Schema.Class<object>(identifier)(fields, {
    parseOptions: { onExcessProperty: "error" },
  });
  return StrictRawStruct.pipe(Schema.decodeTo(Schema.Struct(fields)));
};
/** Source-exact Codex App Server 0.137.0 RequestId wire encoding. */
export const CodexRawRequestIdSchema = Schema.Union([
  Schema.String,
  CodexRawSignedInt64Schema,
]);
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

const CodexRawThreadStatusSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("notLoaded") }),
  Schema.Struct({ type: Schema.Literal("idle") }),
  Schema.Struct({ type: Schema.Literal("systemError") }),
  Schema.Struct({
    activeFlags: Schema.Array(
      Schema.Literals(["waitingOnApproval", "waitingOnUserInput"] as const)
    ),
    type: Schema.Literal("active"),
  }),
]);
const CodexRawFileChangeSchema = Schema.Struct({
  diff: Schema.String,
  kind: Schema.Union([
    Schema.Struct({ type: Schema.Literal("add") }),
    Schema.Struct({ type: Schema.Literal("delete") }),
    Schema.Struct({
      move_path: Schema.optionalKey(Schema.NullOr(Schema.String)),
      type: Schema.Literal("update"),
    }),
  ]),
  path: Schema.String,
});
const CodexRawByteRangeSchema = Schema.Struct({
  end: CodexRawNonNegativeIntegerSchema,
  start: CodexRawNonNegativeIntegerSchema,
});
const CodexRawTextElementSchema = Schema.Struct({
  byteRange: CodexRawByteRangeSchema,
  placeholder: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const CodexRawMemoryCitationEntrySchema = Schema.Struct({
  lineEnd: CodexRawNonNegativeIntegerSchema,
  lineStart: CodexRawNonNegativeIntegerSchema,
  note: Schema.String,
  path: Schema.String,
});
const CodexRawMemoryCitationSchema = Schema.Struct({
  entries: Schema.Array(CodexRawMemoryCitationEntrySchema),
  threadIds: Schema.Array(Schema.String),
});
const CodexRawWebSearchActionSchema = Schema.Union([
  Schema.Struct({
    queries: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    query: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("search"),
  }),
  Schema.Struct({
    type: Schema.Literal("openPage"),
    url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    pattern: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("findInPage"),
    url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ type: Schema.Literal("other") }),
]);
const CodexRawHttpConnectionFailedSchema = strictRawStruct(
  "CodexRawHttpConnectionFailed",
  {
    httpConnectionFailed: Schema.Struct({
      httpStatusCode: Schema.optionalKey(
        Schema.NullOr(CodexRawNonNegativeIntegerSchema)
      ),
    }),
  }
);
const CodexRawResponseStreamConnectionFailedSchema = strictRawStruct(
  "CodexRawResponseStreamConnectionFailed",
  {
    responseStreamConnectionFailed: Schema.Struct({
      httpStatusCode: Schema.optionalKey(
        Schema.NullOr(CodexRawNonNegativeIntegerSchema)
      ),
    }),
  }
);
const CodexRawResponseStreamDisconnectedSchema = strictRawStruct(
  "CodexRawResponseStreamDisconnected",
  {
    responseStreamDisconnected: Schema.Struct({
      httpStatusCode: Schema.optionalKey(
        Schema.NullOr(CodexRawNonNegativeIntegerSchema)
      ),
    }),
  }
);
const CodexRawResponseTooManyFailedAttemptsSchema = strictRawStruct(
  "CodexRawResponseTooManyFailedAttempts",
  {
    responseTooManyFailedAttempts: Schema.Struct({
      httpStatusCode: Schema.optionalKey(
        Schema.NullOr(CodexRawNonNegativeIntegerSchema)
      ),
    }),
  }
);
const CodexRawActiveTurnNotSteerableSchema = strictRawStruct(
  "CodexRawActiveTurnNotSteerable",
  {
    activeTurnNotSteerable: Schema.Struct({
      turnKind: Schema.Literals(["review", "compact"] as const),
    }),
  }
);
const CodexRawCodexErrorInfoSchema = Schema.Union([
  Schema.Literals([
    "contextWindowExceeded",
    "usageLimitExceeded",
    "serverOverloaded",
    "cyberPolicy",
    "internalServerError",
    "unauthorized",
    "badRequest",
    "threadRollbackFailed",
    "sandboxError",
    "other",
  ] as const),
  CodexRawHttpConnectionFailedSchema,
  CodexRawResponseStreamConnectionFailedSchema,
  CodexRawResponseStreamDisconnectedSchema,
  CodexRawResponseTooManyFailedAttemptsSchema,
  CodexRawActiveTurnNotSteerableSchema,
]);
const CodexRawUserInputSchema = Schema.Union([
  Schema.Struct({
    text: Schema.String,
    text_elements: Schema.optionalKey(Schema.Array(CodexRawTextElementSchema)),
    type: Schema.Literal("text"),
  }),
  Schema.Struct({
    detail: Schema.optionalKey(
      Schema.NullOr(
        Schema.Literals(["auto", "low", "high", "original"] as const)
      )
    ),
    type: Schema.Literal("image"),
    url: Schema.String,
  }),
  Schema.Struct({
    detail: Schema.optionalKey(
      Schema.NullOr(
        Schema.Literals(["auto", "low", "high", "original"] as const)
      )
    ),
    path: Schema.String,
    type: Schema.Literal("localImage"),
  }),
  Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    type: Schema.Literal("skill"),
  }),
  Schema.Struct({
    name: Schema.String,
    path: Schema.String,
    type: Schema.Literal("mention"),
  }),
]);
const CodexRawCommandActionSchema = Schema.Union([
  Schema.Struct({
    command: Schema.String,
    name: Schema.String,
    path: Schema.String,
    type: Schema.Literal("read"),
  }),
  Schema.Struct({
    command: Schema.String,
    path: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("listFiles"),
  }),
  Schema.Struct({
    command: Schema.String,
    path: Schema.optionalKey(Schema.NullOr(Schema.String)),
    query: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("search"),
  }),
  Schema.Struct({ command: Schema.String, type: Schema.Literal("unknown") }),
]);
/** Source-exact raw 0.137.0 ThreadItem family, before Gaia branding/projection. */
export const CodexRawThreadItemSchema = Schema.Union([
  Schema.Struct({
    clientId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    content: Schema.Array(CodexRawUserInputSchema),
    id: Schema.String,
    type: Schema.Literal("userMessage"),
  }),
  Schema.Struct({
    fragments: Schema.Array(
      Schema.Struct({ hookRunId: Schema.String, text: Schema.String })
    ),
    id: Schema.String,
    type: Schema.Literal("hookPrompt"),
  }),
  Schema.Struct({
    id: Schema.String,
    memoryCitation: Schema.optionalKey(
      Schema.NullOr(CodexRawMemoryCitationSchema)
    ),
    phase: Schema.optionalKey(
      Schema.NullOr(Schema.Literals(["commentary", "final_answer"] as const))
    ),
    text: Schema.String,
    type: Schema.Literal("agentMessage"),
  }),
  Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    type: Schema.Literal("plan"),
  }),
  Schema.Struct({
    content: Schema.optionalKey(Schema.Array(Schema.String)),
    id: Schema.String,
    summary: Schema.optionalKey(Schema.Array(Schema.String)),
    type: Schema.Literal("reasoning"),
  }),
  Schema.Struct({
    aggregatedOutput: Schema.optionalKey(Schema.NullOr(Schema.String)),
    command: Schema.String,
    commandActions: Schema.Array(CodexRawCommandActionSchema),
    cwd: Schema.String,
    durationMs: Schema.optionalKey(Schema.NullOr(CodexRawSignedInt64Schema)),
    exitCode: Schema.optionalKey(Schema.NullOr(CodexRawIntegerSchema)),
    id: Schema.String,
    processId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    source: Schema.optionalKey(
      Schema.Literals([
        "agent",
        "userShell",
        "unifiedExecStartup",
        "unifiedExecInteraction",
      ] as const)
    ),
    status: Schema.Literals([
      "inProgress",
      "completed",
      "failed",
      "declined",
    ] as const),
    type: Schema.Literal("commandExecution"),
  }),
  Schema.Struct({
    changes: Schema.Array(CodexRawFileChangeSchema),
    id: Schema.String,
    status: Schema.Literals([
      "inProgress",
      "completed",
      "failed",
      "declined",
    ] as const),
    type: Schema.Literal("fileChange"),
  }),
  Schema.Struct({
    arguments: Schema.Json,
    durationMs: Schema.optionalKey(Schema.NullOr(CodexRawSignedInt64Schema)),
    error: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ message: Schema.String }))
    ),
    id: Schema.String,
    mcpAppResourceUri: Schema.optionalKey(Schema.NullOr(Schema.String)),
    pluginId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    result: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          content: Schema.Array(Schema.Json),
          structuredContent: Schema.optionalKey(Schema.NullOr(Schema.Json)),
          _meta: Schema.optionalKey(Schema.NullOr(Schema.Json)),
        })
      )
    ),
    server: Schema.String,
    status: Schema.Literals(["inProgress", "completed", "failed"] as const),
    tool: Schema.String,
    type: Schema.Literal("mcpToolCall"),
  }),
  Schema.Struct({
    arguments: Schema.Json,
    contentItems: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Union([
            Schema.Struct({
              text: Schema.String,
              type: Schema.Literal("inputText"),
            }),
            Schema.Struct({
              imageUrl: Schema.String,
              type: Schema.Literal("inputImage"),
            }),
          ])
        )
      )
    ),
    durationMs: Schema.optionalKey(Schema.NullOr(CodexRawSignedInt64Schema)),
    id: Schema.String,
    namespace: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Schema.Literals(["inProgress", "completed", "failed"] as const),
    success: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    tool: Schema.String,
    type: Schema.Literal("dynamicToolCall"),
  }),
  Schema.Struct({
    agentsStates: Schema.Record(
      Schema.String,
      Schema.Struct({
        message: Schema.optionalKey(Schema.NullOr(Schema.String)),
        status: Schema.Literals([
          "pendingInit",
          "running",
          "interrupted",
          "completed",
          "errored",
          "shutdown",
          "notFound",
        ] as const),
      })
    ),
    id: Schema.String,
    model: Schema.optionalKey(Schema.NullOr(Schema.String)),
    prompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    reasoningEffort: Schema.optionalKey(
      Schema.NullOr(
        Schema.Literals([
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
        ] as const)
      )
    ),
    receiverThreadIds: Schema.Array(Schema.String),
    senderThreadId: Schema.String,
    status: Schema.Literals(["inProgress", "completed", "failed"] as const),
    tool: Schema.Literals([
      "spawnAgent",
      "sendInput",
      "resumeAgent",
      "wait",
      "closeAgent",
    ] as const),
    type: Schema.Literal("collabAgentToolCall"),
  }),
  Schema.Struct({
    action: Schema.optionalKey(Schema.NullOr(CodexRawWebSearchActionSchema)),
    id: Schema.String,
    query: Schema.String,
    type: Schema.Literal("webSearch"),
  }),
  Schema.Struct({
    id: Schema.String,
    path: Schema.String,
    type: Schema.Literal("imageView"),
  }),
  Schema.Struct({
    id: Schema.String,
    result: Schema.String,
    revisedPrompt: Schema.optionalKey(Schema.NullOr(Schema.String)),
    savedPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Schema.String,
    type: Schema.Literal("imageGeneration"),
  }),
  Schema.Struct({
    id: Schema.String,
    review: Schema.String,
    type: Schema.Literal("enteredReviewMode"),
  }),
  Schema.Struct({
    id: Schema.String,
    review: Schema.String,
    type: Schema.Literal("exitedReviewMode"),
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("contextCompaction"),
  }),
]);
const CodexRawTurnErrorSchema = Schema.Struct({
  additionalDetails: Schema.optionalKey(Schema.NullOr(Schema.String)),
  codexErrorInfo: Schema.optionalKey(
    Schema.NullOr(CodexRawCodexErrorInfoSchema)
  ),
  message: Schema.String,
});
export const CodexRawTurnSchema = Schema.Struct({
  completedAt: Schema.optionalKey(Schema.NullOr(CodexRawSignedInt64Schema)),
  durationMs: Schema.optionalKey(Schema.NullOr(CodexRawSignedInt64Schema)),
  error: Schema.optionalKey(Schema.NullOr(CodexRawTurnErrorSchema)),
  id: Schema.String,
  items: Schema.Array(CodexRawThreadItemSchema),
  itemsView: Schema.optionalKey(
    Schema.Literals(["notLoaded", "summary", "full"] as const)
  ),
  startedAt: Schema.optionalKey(Schema.NullOr(CodexRawSignedInt64Schema)),
  status: Schema.Literals([
    "completed",
    "interrupted",
    "failed",
    "inProgress",
  ] as const),
});
const CodexRawThreadSpawnSourceSchema = strictRawStruct(
  "CodexRawThreadSpawnSource",
  {
    thread_spawn: Schema.Struct({
      agent_nickname: Schema.optionalKey(Schema.NullOr(Schema.String)),
      agent_path: Schema.optionalKey(Schema.NullOr(Schema.String)),
      agent_role: Schema.optionalKey(Schema.NullOr(Schema.String)),
      depth: Schema.Int,
      parent_thread_id: Schema.String,
    }),
  }
);
const CodexRawOtherSubAgentSourceSchema = strictRawStruct(
  "CodexRawOtherSubAgentSource",
  { other: Schema.String }
);
const CodexRawSubAgentSourceSchema = Schema.Union([
  Schema.Literals(["review", "compact", "memory_consolidation"] as const),
  CodexRawThreadSpawnSourceSchema,
  CodexRawOtherSubAgentSourceSchema,
]);
const CodexRawCustomSessionSourceSchema = strictRawStruct(
  "CodexRawCustomSessionSource",
  { custom: Schema.String }
);
const CodexRawSubAgentSessionSourceSchema = strictRawStruct(
  "CodexRawSubAgentSessionSource",
  { subAgent: CodexRawSubAgentSourceSchema }
);
const CodexRawSessionSourceSchema = Schema.Union([
  Schema.Literals(["cli", "vscode", "exec", "appServer", "unknown"] as const),
  CodexRawCustomSessionSourceSchema,
  CodexRawSubAgentSessionSourceSchema,
]);
/** Source-exact raw 0.137.0 Thread contract. */
export const CodexRawThreadSchema = Schema.Struct({
  agentNickname: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agentRole: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cliVersion: Schema.String,
  createdAt: CodexRawSignedInt64Schema,
  cwd: Schema.String,
  ephemeral: Schema.Boolean,
  forkedFromId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  gitInfo: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
        originUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
        sha: Schema.optionalKey(Schema.NullOr(Schema.String)),
      })
    )
  ),
  id: Schema.String,
  modelProvider: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  parentThreadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  path: Schema.optionalKey(Schema.NullOr(Schema.String)),
  preview: Schema.String,
  sessionId: Schema.String,
  source: CodexRawSessionSourceSchema,
  status: CodexRawThreadStatusSchema,
  threadSource: Schema.optionalKey(
    Schema.NullOr(
      Schema.Literals(["user", "subagent", "memory_consolidation"] as const)
    )
  ),
  turns: Schema.Array(CodexRawTurnSchema),
  updatedAt: CodexRawSignedInt64Schema,
});
const CodexFileChange = Schema.Struct({
  diff: Schema.String,
  kind: Schema.Union([
    Schema.Struct({ type: Schema.Literal("add") }),
    Schema.Struct({ type: Schema.Literal("delete") }),
    Schema.Struct({
      move_path: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
export const CodexRawThreadListResultSchema = Schema.Struct({
  backwardsCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  data: Schema.Array(CodexRawThreadSchema),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const ThreadListBoundaryResultSchema =
  CodexRawThreadListResultSchema.pipe(Schema.decodeTo(ThreadListResultSchema));
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
const CodexRawGranularApprovalPolicySchema = strictRawStruct(
  "CodexRawGranularApprovalPolicy",
  {
    granular: Schema.Struct({
      mcp_elicitations: Schema.Boolean,
      request_permissions: Schema.optionalKey(Schema.Boolean),
      rules: Schema.Boolean,
      sandbox_approval: Schema.Boolean,
      skill_approval: Schema.optionalKey(Schema.Boolean),
    }),
  }
);
const CodexRawThreadRuntimeResultFields = {
  activePermissionProfile: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        extends: Schema.optionalKey(Schema.NullOr(Schema.String)),
        id: Schema.String,
      })
    )
  ),
  approvalPolicy: Schema.Union([
    Schema.Literals([
      "untrusted",
      "on-failure",
      "on-request",
      "never",
    ] as const),
    CodexRawGranularApprovalPolicySchema,
  ]),
  approvalsReviewer: Schema.Literals([
    "user",
    "auto_review",
    "guardian_subagent",
  ] as const),
  cwd: Schema.String,
  instructionSources: Schema.optionalKey(Schema.Array(Schema.String)),
  model: Schema.String,
  modelProvider: Schema.String,
  reasoningEffort: Schema.optionalKey(
    Schema.NullOr(
      Schema.Literals([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ] as const)
    )
  ),
  runtimeWorkspaceRoots: Schema.optionalKey(Schema.Array(Schema.String)),
  sandbox: Schema.Union([
    Schema.Struct({ type: Schema.Literal("dangerFullAccess") }),
    Schema.Struct({
      networkAccess: Schema.optionalKey(Schema.Boolean),
      type: Schema.Literal("readOnly"),
    }),
    Schema.Struct({
      networkAccess: Schema.optionalKey(
        Schema.Literals(["restricted", "enabled"] as const)
      ),
      type: Schema.Literal("externalSandbox"),
    }),
    Schema.Struct({
      excludeSlashTmp: Schema.optionalKey(Schema.Boolean),
      excludeTmpdirEnvVar: Schema.optionalKey(Schema.Boolean),
      networkAccess: Schema.optionalKey(Schema.Boolean),
      type: Schema.Literal("workspaceWrite"),
      writableRoots: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ]),
  serviceTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  thread: CodexRawThreadSchema,
} as const;
/** Source-exact raw 0.137.0 thread/read result. */
export const CodexRawThreadReadResultSchema = Schema.Struct({
  thread: CodexRawThreadSchema,
});
/** Source-exact raw 0.137.0 thread/start result. */
export const CodexRawThreadStartResultSchema = Schema.Struct(
  CodexRawThreadRuntimeResultFields
);
/** Source-exact raw 0.137.0 thread/resume result. */
export const CodexRawThreadResumeResultSchema = Schema.Struct({
  ...CodexRawThreadRuntimeResultFields,
  initialTurnsPage: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        backwardsCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
        data: Schema.Array(CodexRawTurnSchema),
        nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
      })
    )
  ),
});
export const ThreadReadBoundaryResultSchema =
  CodexRawThreadReadResultSchema.pipe(Schema.decodeTo(ThreadResultSchema));
export const ThreadStartBoundaryResultSchema =
  CodexRawThreadStartResultSchema.pipe(Schema.decodeTo(ThreadResultSchema));
export const ThreadResumeBoundaryResultSchema =
  CodexRawThreadResumeResultSchema.pipe(Schema.decodeTo(ThreadResultSchema));
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
/** Source-exact raw 0.137.0 model/list item. */
export const CodexRawModelSchema = Schema.Struct({
  additionalSpeedTiers: Schema.optionalKey(Schema.Array(Schema.String)),
  availabilityNux: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ message: Schema.String }))
  ),
  defaultReasoningEffort: Schema.Literals([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ] as const),
  defaultServiceTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.String,
  displayName: Schema.String,
  hidden: Schema.Boolean,
  id: Schema.String,
  inputModalities: Schema.optionalKey(
    Schema.Array(Schema.Literals(["text", "image"] as const))
  ),
  isDefault: Schema.Boolean,
  model: Schema.String,
  serviceTiers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        description: Schema.String,
        id: Schema.String,
        name: Schema.String,
      })
    )
  ),
  supportedReasoningEfforts: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      reasoningEffort: Schema.Literals([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ] as const),
    })
  ),
  supportsPersonality: Schema.optionalKey(Schema.Boolean),
  upgrade: Schema.optionalKey(Schema.NullOr(Schema.String)),
  upgradeInfo: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        migrationMarkdown: Schema.optionalKey(Schema.NullOr(Schema.String)),
        model: Schema.String,
        modelLink: Schema.optionalKey(Schema.NullOr(Schema.String)),
        upgradeCopy: Schema.optionalKey(Schema.NullOr(Schema.String)),
      })
    )
  ),
});
export const CodexRawModelListResultSchema = Schema.Struct({
  data: Schema.Array(CodexRawModelSchema),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const ModelListResultSchema = Schema.Struct({
  data: Schema.Array(CodexModelSchema),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const ModelListBoundaryResultSchema = CodexRawModelListResultSchema.pipe(
  Schema.decodeTo(ModelListResultSchema)
);
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
export const TurnBoundaryResultSchema = Schema.Struct({
  turn: CodexRawTurnSchema,
}).pipe(Schema.decodeTo(TurnResultSchema));
export const TurnSteerBoundaryResultSchema = Schema.Struct({
  turnId: Schema.String,
}).pipe(Schema.decodeTo(TurnSteerResultSchema));
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
        subpath: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      Schema.Struct({ kind: Schema.Literal("tmpdir") }),
      Schema.Struct({ kind: Schema.Literal("slash_tmp") }),
      Schema.Struct({
        kind: Schema.Literal("unknown"),
        path: Schema.String,
        subpath: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
const CodexRawBaseInteraction = {
  itemId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
} as const;
const CodexRawFileSystemSpecialPathSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("root") }),
  Schema.Struct({ kind: Schema.Literal("minimal") }),
  Schema.Struct({
    kind: Schema.Literal("project_roots"),
    subpath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({ kind: Schema.Literal("tmpdir") }),
  Schema.Struct({ kind: Schema.Literal("slash_tmp") }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    path: Schema.String,
    subpath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
]);
const CodexRawFileSystemPathSchema = Schema.Union([
  Schema.Struct({ path: Schema.String, type: Schema.Literal("path") }),
  Schema.Struct({
    pattern: Schema.String,
    type: Schema.Literal("glob_pattern"),
  }),
  Schema.Struct({
    type: Schema.Literal("special"),
    value: CodexRawFileSystemSpecialPathSchema,
  }),
]);
const CodexRawFileSystemSandboxEntrySchema = Schema.Struct({
  access: Schema.Literals(["read", "write", "deny"] as const),
  path: CodexRawFileSystemPathSchema,
});
const CodexRawAdditionalNetworkPermissionsSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
const CodexRawAdditionalFileSystemPermissionsSchema = Schema.Struct({
  entries: Schema.optionalKey(
    Schema.NullOr(Schema.Array(CodexRawFileSystemSandboxEntrySchema))
  ),
  globScanMaxDepth: Schema.optionalKey(
    Schema.NullOr(
      Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))
    )
  ),
  read: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  write: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
const CodexRawAdditionalPermissionProfileSchema = Schema.Struct({
  fileSystem: Schema.optionalKey(
    Schema.NullOr(CodexRawAdditionalFileSystemPermissionsSchema)
  ),
  network: Schema.optionalKey(
    Schema.NullOr(CodexRawAdditionalNetworkPermissionsSchema)
  ),
});
const CodexRawRequestPermissionProfileSchema = strictRawStruct(
  "CodexRawRequestPermissionProfile",
  CodexRawAdditionalPermissionProfileSchema.fields
);
const CodexRawNetworkPolicyAmendmentSchema = Schema.Struct({
  action: Schema.Literals(["allow", "deny"] as const),
  host: Schema.String,
});
const CodexRawAcceptWithExecpolicyAmendmentSchema = strictRawStruct(
  "CodexRawAcceptWithExecpolicyAmendment",
  {
    acceptWithExecpolicyAmendment: Schema.Struct({
      execpolicy_amendment: Schema.Array(Schema.String),
    }),
  }
);
const CodexRawApplyNetworkPolicyAmendmentSchema = strictRawStruct(
  "CodexRawApplyNetworkPolicyAmendment",
  {
    applyNetworkPolicyAmendment: Schema.Struct({
      network_policy_amendment: CodexRawNetworkPolicyAmendmentSchema,
    }),
  }
);
const CodexRawCommandExecutionApprovalDecisionSchema = Schema.Union([
  Schema.Literals(["accept", "acceptForSession", "decline", "cancel"] as const),
  CodexRawAcceptWithExecpolicyAmendmentSchema,
  CodexRawApplyNetworkPolicyAmendmentSchema,
]);
const CodexRawCommandRequest = Schema.Struct({
  id: CodexRawRequestIdSchema,
  method: Schema.Literal("item/commandExecution/requestApproval"),
  params: Schema.Struct({
    ...CodexRawBaseInteraction,
    additionalPermissions: Schema.optionalKey(
      Schema.NullOr(CodexRawAdditionalPermissionProfileSchema)
    ),
    approvalId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    availableDecisions: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(CodexRawCommandExecutionApprovalDecisionSchema)
      )
    ),
    command: Schema.optionalKey(Schema.NullOr(Schema.String)),
    commandActions: Schema.optionalKey(
      Schema.NullOr(Schema.Array(CodexRawCommandActionSchema))
    ),
    cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
    networkApprovalContext: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          host: Schema.String,
          protocol: Schema.Literals([
            "http",
            "https",
            "socks5Tcp",
            "socks5Udp",
          ] as const),
        })
      )
    ),
    proposedExecpolicyAmendment: Schema.optionalKey(
      Schema.NullOr(Schema.Array(Schema.String))
    ),
    proposedNetworkPolicyAmendments: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            action: Schema.Literals(["allow", "deny"] as const),
            host: Schema.String,
          })
        )
      )
    ),
    reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    startedAtMs: CodexRawSignedInt64Schema,
  }),
});
const CodexRawFileRequest = Schema.Struct({
  id: CodexRawRequestIdSchema,
  method: Schema.Literal("item/fileChange/requestApproval"),
  params: Schema.Struct({
    ...CodexRawBaseInteraction,
    grantRoot: Schema.optionalKey(Schema.NullOr(Schema.String)),
    reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    startedAtMs: CodexRawSignedInt64Schema,
  }),
});
const CodexRawPermissionRequest = Schema.Struct({
  id: CodexRawRequestIdSchema,
  method: Schema.Literal("item/permissions/requestApproval"),
  params: Schema.Struct({
    ...CodexRawBaseInteraction,
    cwd: Schema.String,
    environmentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    permissions: CodexRawRequestPermissionProfileSchema,
    reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
    startedAtMs: CodexRawSignedInt64Schema,
  }),
});
const CodexRawUserInputRequest = Schema.Struct({
  id: CodexRawRequestIdSchema,
  method: Schema.Literal("item/tool/requestUserInput"),
  params: Schema.Struct({
    ...CodexRawBaseInteraction,
    questions: Schema.Array(
      Schema.Struct({
        header: Schema.String,
        id: Schema.String,
        isOther: Schema.optionalKey(Schema.Boolean),
        isSecret: Schema.optionalKey(Schema.Boolean),
        options: Schema.optionalKey(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                description: Schema.String,
                label: Schema.String,
              })
            )
          )
        ),
        question: Schema.String,
      })
    ),
  }),
});
const CodexRawMcpElicitationConstOptionSchema = strictRawStruct(
  "CodexRawMcpElicitationConstOption",
  { const: Schema.String, title: Schema.String }
);
const CodexRawMcpElicitationUntitledEnumItemsSchema = strictRawStruct(
  "CodexRawMcpElicitationUntitledEnumItems",
  {
    enum: Schema.Array(Schema.String),
    type: Schema.Literal("string"),
  }
);
const CodexRawMcpElicitationTitledEnumItemsSchema = strictRawStruct(
  "CodexRawMcpElicitationTitledEnumItems",
  {
    anyOf: Schema.Array(CodexRawMcpElicitationConstOptionSchema),
  }
);
const CodexRawMcpElicitationUntitledSingleSelectSchema = strictRawStruct(
  "CodexRawMcpElicitationUntitledSingleSelect",
  {
    default: Schema.optionalKey(Schema.NullOr(Schema.String)),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    enum: Schema.Array(Schema.String),
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("string"),
  }
);
const CodexRawMcpElicitationTitledSingleSelectSchema = strictRawStruct(
  "CodexRawMcpElicitationTitledSingleSelect",
  {
    default: Schema.optionalKey(Schema.NullOr(Schema.String)),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    oneOf: Schema.Array(CodexRawMcpElicitationConstOptionSchema),
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("string"),
  }
);
const CodexRawMcpElicitationLegacyTitledEnumSchema = strictRawStruct(
  "CodexRawMcpElicitationLegacyTitledEnum",
  {
    default: Schema.optionalKey(Schema.NullOr(Schema.String)),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    enum: Schema.Array(Schema.String),
    enumNames: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("string"),
  }
);
const CodexRawMcpElicitationUntitledMultiSelectSchema = strictRawStruct(
  "CodexRawMcpElicitationUntitledMultiSelect",
  {
    default: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    items: CodexRawMcpElicitationUntitledEnumItemsSchema,
    maxItems: Schema.optionalKey(
      Schema.NullOr(CodexRawNonNegativeIntegerSchema)
    ),
    minItems: Schema.optionalKey(
      Schema.NullOr(CodexRawNonNegativeIntegerSchema)
    ),
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("array"),
  }
);
const CodexRawMcpElicitationTitledMultiSelectSchema = strictRawStruct(
  "CodexRawMcpElicitationTitledMultiSelect",
  {
    default: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    items: CodexRawMcpElicitationTitledEnumItemsSchema,
    maxItems: Schema.optionalKey(
      Schema.NullOr(CodexRawNonNegativeIntegerSchema)
    ),
    minItems: Schema.optionalKey(
      Schema.NullOr(CodexRawNonNegativeIntegerSchema)
    ),
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("array"),
  }
);
const CodexRawMcpElicitationEnumSchema = Schema.Union([
  CodexRawMcpElicitationUntitledSingleSelectSchema,
  CodexRawMcpElicitationTitledSingleSelectSchema,
  CodexRawMcpElicitationUntitledMultiSelectSchema,
  CodexRawMcpElicitationTitledMultiSelectSchema,
  CodexRawMcpElicitationLegacyTitledEnumSchema,
]);
const CodexRawMcpElicitationStringSchema = strictRawStruct(
  "CodexRawMcpElicitationString",
  {
    default: Schema.optionalKey(Schema.NullOr(Schema.String)),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    format: Schema.optionalKey(
      Schema.NullOr(
        Schema.Literals(["email", "uri", "date", "date-time"] as const)
      )
    ),
    maxLength: Schema.optionalKey(
      Schema.NullOr(CodexRawNonNegativeIntegerSchema)
    ),
    minLength: Schema.optionalKey(
      Schema.NullOr(CodexRawNonNegativeIntegerSchema)
    ),
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("string"),
  }
);
const CodexRawMcpElicitationNumberSchema = strictRawStruct(
  "CodexRawMcpElicitationNumber",
  {
    default: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    maximum: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    minimum: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literals(["number", "integer"] as const),
  }
);
const CodexRawMcpElicitationBooleanSchema = strictRawStruct(
  "CodexRawMcpElicitationBoolean",
  {
    default: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    title: Schema.optionalKey(Schema.NullOr(Schema.String)),
    type: Schema.Literal("boolean"),
  }
);
const CodexRawMcpElicitationPrimitiveSchema = Schema.Union([
  CodexRawMcpElicitationEnumSchema,
  CodexRawMcpElicitationStringSchema,
  CodexRawMcpElicitationNumberSchema,
  CodexRawMcpElicitationBooleanSchema,
]);
const CodexRawMcpElicitationSchema = strictRawStruct("CodexRawMcpElicitation", {
  $schema: Schema.optionalKey(Schema.NullOr(Schema.String)),
  properties: Schema.Record(
    Schema.String,
    CodexRawMcpElicitationPrimitiveSchema
  ),
  required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  type: Schema.Literal("object"),
});
const CodexRawElicitationRequest = Schema.Struct({
  id: CodexRawRequestIdSchema,
  method: Schema.Literal("mcpServer/elicitation/request"),
  params: Schema.Union([
    Schema.Struct({
      _meta: Schema.optionalKey(Schema.Json),
      message: Schema.String,
      mode: Schema.Literal("form"),
      requestedSchema: CodexRawMcpElicitationSchema,
      serverName: Schema.String,
      threadId: Schema.String,
      turnId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
    Schema.Struct({
      _meta: Schema.optionalKey(Schema.Json),
      elicitationId: Schema.String,
      message: Schema.String,
      mode: Schema.Literal("url"),
      serverName: Schema.String,
      threadId: Schema.String,
      turnId: Schema.optionalKey(Schema.NullOr(Schema.String)),
      url: Schema.String,
    }),
  ]),
});
/** Source-exact raw 0.137.0 curated server-request family. */
export const CodexRawServerRequestSchema = Schema.Union([
  CodexRawCommandRequest,
  CodexRawFileRequest,
  CodexRawPermissionRequest,
  CodexRawUserInputRequest,
  CodexRawElicitationRequest,
]);
const CodexServerRequestProjectionSchema = Schema.Union([
  CommandRequest,
  FileRequest,
  PermissionRequest,
  UserInputRequest,
  ElicitationRequest,
]);
export const CodexServerRequestSchema = CodexServerRequestProjectionSchema;
export const CodexServerRequestBoundarySchema =
  CodexRawServerRequestSchema.pipe(
    Schema.decodeTo(CodexServerRequestProjectionSchema)
  );
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
const rawNotification = notification;
const CodexRawTokenUsageBreakdownSchema = Schema.Struct({
  cachedInputTokens: CodexRawSignedInt64Schema,
  inputTokens: CodexRawSignedInt64Schema,
  outputTokens: CodexRawSignedInt64Schema,
  reasoningOutputTokens: CodexRawSignedInt64Schema,
  totalTokens: CodexRawSignedInt64Schema,
});
/** Source-exact raw 0.137.0 curated notification family. */
export const CodexRawNotificationSchema = Schema.Union([
  rawNotification(
    "thread/started",
    Schema.Struct({ thread: CodexRawThreadSchema })
  ),
  rawNotification(
    "thread/status/changed",
    Schema.Struct({
      threadId: Schema.String,
      status: CodexRawThreadStatusSchema,
    })
  ),
  rawNotification(
    "turn/started",
    Schema.Struct({ threadId: Schema.String, turn: CodexRawTurnSchema })
  ),
  rawNotification(
    "turn/completed",
    Schema.Struct({ threadId: Schema.String, turn: CodexRawTurnSchema })
  ),
  rawNotification(
    "turn/diff/updated",
    Schema.Struct({
      diff: Schema.String,
      threadId: Schema.String,
      turnId: Schema.String,
    })
  ),
  rawNotification(
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
      threadId: Schema.String,
      turnId: Schema.String,
    })
  ),
  rawNotification(
    "item/started",
    Schema.Struct({
      item: CodexRawThreadItemSchema,
      startedAtMs: CodexRawSignedInt64Schema,
      threadId: Schema.String,
      turnId: Schema.String,
    })
  ),
  rawNotification(
    "item/completed",
    Schema.Struct({
      completedAtMs: CodexRawSignedInt64Schema,
      item: CodexRawThreadItemSchema,
      threadId: Schema.String,
      turnId: Schema.String,
    })
  ),
  rawNotification(
    "item/agentMessage/delta",
    Schema.Struct({
      delta: Schema.String,
      itemId: Schema.String,
      threadId: Schema.String,
      turnId: Schema.String,
    })
  ),
  rawNotification(
    "item/commandExecution/outputDelta",
    Schema.Struct({
      delta: Schema.String,
      itemId: Schema.String,
      threadId: Schema.String,
      turnId: Schema.String,
    })
  ),
  rawNotification(
    "item/fileChange/outputDelta",
    Schema.Struct({
      delta: Schema.String,
      itemId: Schema.String,
      threadId: Schema.String,
      turnId: Schema.String,
    })
  ),
  rawNotification(
    "item/fileChange/patchUpdated",
    Schema.Struct({
      changes: Schema.Array(CodexRawFileChangeSchema),
      itemId: Schema.String,
      threadId: Schema.String,
      turnId: Schema.String,
    })
  ),
  rawNotification(
    "thread/tokenUsage/updated",
    Schema.Struct({
      threadId: Schema.String,
      tokenUsage: Schema.Struct({
        last: CodexRawTokenUsageBreakdownSchema,
        modelContextWindow: Schema.optionalKey(
          Schema.NullOr(CodexRawSignedInt64Schema)
        ),
        total: CodexRawTokenUsageBreakdownSchema,
      }),
      turnId: Schema.String,
    })
  ),
  rawNotification(
    "warning",
    Schema.Struct({
      message: Schema.String,
      threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    })
  ),
  rawNotification(
    "error",
    Schema.Struct({
      error: CodexRawTurnErrorSchema,
      threadId: Schema.String,
      turnId: Schema.String,
      willRetry: Schema.Boolean,
    })
  ),
  rawNotification(
    "serverRequest/resolved",
    Schema.Struct({
      requestId: CodexRawRequestIdSchema,
      threadId: Schema.String,
    })
  ),
]);

const CodexNotificationProjectionSchema = Schema.Union([
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
export const CodexNotificationSchema = CodexNotificationProjectionSchema;
export const CodexNotificationBoundarySchema = CodexRawNotificationSchema.pipe(
  Schema.decodeTo(CodexNotificationProjectionSchema)
);
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
  decision: CodexRawCommandExecutionApprovalDecisionSchema,
});
export const FileApprovalResponseSchema = Schema.Struct({
  decision: Schema.Literals([
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
  ] as const),
});
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
export const CodexAppServerResponseBoundarySchema = Schema.Union([
  Schema.Struct({ id: CodexRawRequestIdSchema, result: Schema.Json }),
  Schema.Struct({
    error: Schema.Struct({
      code: CodexRawIntegerSchema,
      message: Schema.String,
    }),
    id: CodexRawRequestIdSchema,
  }),
]).pipe(Schema.decodeTo(CodexAppServerResponseSchema));
export const CodexAppServerInboundRequestSchema = Schema.Struct({
  id: CodexRequestIdSchema,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
export const CodexAppServerInboundRequestBoundarySchema = Schema.Struct({
  id: CodexRawRequestIdSchema,
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
}).pipe(Schema.decodeTo(CodexAppServerInboundRequestSchema));
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
