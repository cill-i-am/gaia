import {
  HarnessCapabilities,
  HarnessProviderDescriptor,
  parseHarnessActionId,
  parseHarnessProviderId,
  parseHarnessSessionId,
  projectHarnessEvents,
} from "@gaia/core";
import { describe, expect, it } from "vitest";
import { createCodexSessionMapper } from "./codex-session-mapper.js";

const sessionId = parseHarnessSessionId("session-codex-mapper");
const capabilities = HarnessCapabilities.make({
  approvals: ["command", "fileChange", "permission", "userInput", "mcpElicitation"],
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: true,
  steering: true,
  streamingMessages: true,
  structuredOutput: false,
  subagents: true,
  toolEvents: true,
  usageReporting: true,
  userQuestions: true,
});
const provider = HarnessProviderDescriptor.make({
  displayName: "Codex App Server",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("codex-app-server"),
});

function mapper() {
  return createCodexSessionMapper({
    capabilities,
    deltaFlushCharacters: 8,
    provider,
    sensitiveValues: ["super-secret-token"],
    sessionId,
    workspaceRoot: "/workspace/project",
  });
}

describe("Codex App Server provider-neutral mapper", () => {
  it("coalesces deltas, drops reasoning, and treats the final item as authoritative", () => {
    const subject = mapper();
    expect(subject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "vendor-thread" } },
    }).map(({ kind }) => kind)).toEqual(["sessionStarted"]);
    expect(subject.mapNotification({
      method: "turn/started",
      params: {
        threadId: "vendor-thread",
        turn: { id: "vendor-turn", status: "inProgress" },
      },
    }).map(({ kind }) => kind)).toEqual(["turnStarted", "sessionStateChanged"]);

    expect(subject.mapNotification({
      method: "item/started",
      params: {
        item: {
          content: ["hidden chain of thought"],
          id: "vendor-reasoning",
          summary: ["hidden summary"],
          type: "reasoning",
        },
        threadId: "vendor-thread",
        turnId: "vendor-turn",
      },
    })).toEqual([]);
    expect(subject.mapNotification({
      method: "item/agentMessage/delta",
      params: {
        delta: "Hello ",
        itemId: "vendor-message",
        threadId: "vendor-thread",
        turnId: "vendor-turn",
      },
    })).toEqual([]);
    const deltaEvents = subject.mapNotification({
      method: "item/agentMessage/delta",
      params: {
        delta: "world",
        itemId: "vendor-message",
        threadId: "vendor-thread",
        turnId: "vendor-turn",
      },
    });
    expect(deltaEvents).toHaveLength(1);
    expect(deltaEvents[0]).toMatchObject({
      chunk: "Hello world",
      deltaKind: "message",
      kind: "itemDeltaRecorded",
    });

    const completed = subject.mapNotification({
      method: "item/completed",
      params: {
        completedAtMs: 2,
        item: {
          id: "vendor-message",
          memoryCitation: null,
          phase: "final_answer",
          text: "Final super-secret-token at /Users/operator/private.txt",
          type: "agentMessage",
        },
        threadId: "vendor-thread",
        turnId: "vendor-turn",
      },
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      final: true,
      item: {
        kind: "message",
        phase: "final",
        status: "completed",
      },
      kind: "itemUpserted",
    });
    expect(JSON.stringify(completed)).not.toContain("super-secret-token");
    expect(JSON.stringify(completed)).not.toContain("/Users/operator");
    expect(JSON.stringify(completed)).not.toContain("vendor-");

    expect(subject.mapNotification({
      method: "item/completed",
      params: {
        completedAtMs: 3,
        item: {
          id: "vendor-message",
          memoryCitation: null,
          phase: "final_answer",
          text: "duplicate final",
          type: "agentMessage",
        },
        threadId: "vendor-thread",
        turnId: "vendor-turn",
      },
    })).toEqual([]);
    expect(subject.mapNotification({
      method: "item/agentMessage/delta",
      params: {
        delta: "late",
        itemId: "vendor-message",
        threadId: "vendor-thread",
        turnId: "vendor-turn",
      },
    })).toEqual([]);
  });

  it("maps allowlisted commands, file changes, tools, plans, reviews, usage, and failures", () => {
    const subject = mapper();
    subject.mapNotification({ method: "thread/started", params: { thread: { id: "t" } } });
    subject.mapNotification({
      method: "turn/started",
      params: { threadId: "t", turn: { id: "u", status: "inProgress" } },
    });

    const fixtures: ReadonlyArray<unknown> = [
      {
        method: "item/started",
        params: {
          item: {
            aggregatedOutput: "safe output",
            command: "pnpm test",
            commandActions: [],
            cwd: "/workspace/project/packages/core",
            durationMs: null,
            exitCode: null,
            id: "command-native",
            processId: null,
            source: "agent",
            status: "inProgress",
            type: "commandExecution",
          },
          threadId: "t",
          turnId: "u",
        },
      },
      {
        method: "item/completed",
        params: {
          item: {
            changes: [
              { diff: "+safe", kind: { type: "add" }, path: "/workspace/project/src/new.ts" },
              { diff: "+secret", kind: { move_path: null, type: "update" }, path: "/private/outside.txt" },
            ],
            id: "file-native",
            status: "completed",
            type: "fileChange",
          },
          threadId: "t",
          turnId: "u",
        },
      },
      {
        method: "item/completed",
        params: {
          item: {
            arguments: { raw: "must not cross" },
            durationMs: 1,
            error: null,
            id: "tool-native",
            mcpAppResourceUri: "secret://resource",
            pluginId: null,
            result: { content: [{ raw: "must not cross" }], structuredContent: null, _meta: null },
            server: "linear",
            status: "completed",
            tool: "get_issue",
            type: "mcpToolCall",
          },
          threadId: "t",
          turnId: "u",
        },
      },
      {
        method: "item/completed",
        params: {
          item: { id: "review-native", review: "Looks safe", type: "exitedReviewMode" },
          threadId: "t",
          turnId: "u",
        },
      },
      {
        method: "turn/plan/updated",
        params: {
          explanation: "Current plan",
          plan: [{ status: "completed", step: "Inspect" }],
          threadId: "t",
          turnId: "u",
        },
      },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "t",
          tokenUsage: {
            last: { cachedInputTokens: 2, inputTokens: 3, outputTokens: 5 },
            modelContextWindow: 200000,
            total: { cachedInputTokens: 7, inputTokens: 11, outputTokens: 13 },
          },
          turnId: "u",
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "t",
          turn: {
            error: { additionalDetails: "private details", codexErrorInfo: null, message: "provider failed" },
            id: "u",
            status: "failed",
          },
        },
      },
    ];
    const events = fixtures.flatMap((fixture) => subject.mapNotification(fixture));
    const serialized = JSON.stringify(events);

    expect(events.map(({ kind }) => kind)).toEqual([
      "itemUpserted",
      "itemUpserted",
      "itemUpserted",
      "itemUpserted",
      "itemUpserted",
      "itemUpserted",
      "turnCompleted",
      "sessionFailed",
    ]);
    expect(serialized).toContain("packages/core");
    expect(serialized).toContain("src/new.ts");
    expect(serialized).not.toContain("/workspace/project");
    expect(serialized).not.toContain("/private/outside");
    expect(serialized).not.toContain("arguments");
    expect(serialized).not.toContain("structuredContent");
    expect(serialized).not.toContain("additionalDetails");
    expect(serialized).not.toContain("native");
  });

  it("maps interactions without exposing provider request IDs or unsafe paths", () => {
    const subject = mapper();
    subject.mapNotification({ method: "thread/started", params: { thread: { id: "thread-secret" } } });
    subject.mapNotification({
      method: "turn/started",
      params: { threadId: "thread-secret", turn: { id: "turn-secret", status: "inProgress" } },
    });
    const events = subject.mapServerRequest({
      id: "request-secret",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "curl example.com",
        cwd: "/workspace/project",
        itemId: "item-secret",
        reason: "Use super-secret-token",
        startedAtMs: 1,
        threadId: "thread-secret",
        turnId: "turn-secret",
      },
    });
    const serialized = JSON.stringify(events);

    expect(events).toHaveLength(2);
    expect(events.map(({ kind }) => kind)).toEqual([
      "interactionRequested",
      "sessionStateChanged",
    ]);
    expect(serialized).not.toContain("request-secret");
    expect(serialized).not.toContain("item-secret");
    expect(serialized).not.toContain("thread-secret");
    expect(serialized).not.toContain("turn-secret");
    expect(serialized).not.toContain("super-secret-token");

    const resolved = subject.resolveServerRequest("request-secret", {
      actionId: parseHarnessActionId("action-mapper-resolve"),
      decision: "decline",
      resolvedAt: "2026-07-10T10:10:00.000Z",
      responseKind: "approval",
    });
    expect(resolved.map(({ kind }) => kind)).toEqual([
      "interactionResolved",
      "sessionStateChanged",
    ]);

    const questions = subject.mapServerRequest({
      id: "question-request-secret",
      method: "item/tool/requestUserInput",
      params: {
        itemId: "question-item-secret",
        questions: [
          {
            description: "",
            header: "Choice",
            id: "native-question-secret",
            question: "Choose",
          },
        ],
        threadId: "thread-secret",
        turnId: "turn-secret",
      },
    });
    const questionEvent = questions.find(
      (event) =>
        event.kind === "interactionRequested" &&
        event.interaction.kind === "userInput",
    );
    if (
      questionEvent?.kind !== "interactionRequested" ||
      questionEvent.interaction.kind !== "userInput"
    ) {
      throw new Error("Expected a mapped user-input interaction.");
    }
    const publicQuestion = questionEvent.interaction.questions[0];
    if (publicQuestion === undefined) {
      throw new Error("Expected a mapped user-input question.");
    }
    const publicQuestionId = publicQuestion.questionId;
    expect(JSON.stringify(questions)).not.toContain("native-question-secret");
    expect(
      subject.mapUserInputAnswers("question-request-secret", [
        { answers: ["yes"], questionId: publicQuestionId },
      ]),
    ).toEqual({ "native-question-secret": { answers: ["yes"] } });
    const auditedQuestion = subject.resolveServerRequest(
      "question-request-secret",
      {
        actionId: parseHarnessActionId("action-question-resolve"),
        decision: "submit",
        resolvedAt: "2026-07-10T10:11:00.000Z",
        responseKind: "userInput",
      },
    );
    expect(JSON.stringify(auditedQuestion)).not.toContain("yes");
    expect(JSON.stringify(auditedQuestion)).not.toContain(
      "native-question-secret",
    );

    const elicitation = subject.mapServerRequest({
      id: "mcp-request-secret",
      method: "mcpServer/elicitation/request",
      params: {
        _meta: { secret: "must not cross" },
        message: "Choose input from `/etc/private`",
        mode: "form",
        requestedSchema: {
          properties: { token: { type: "string" } },
          type: "object",
        },
        serverName: "linear",
        threadId: "thread-secret",
        turnId: "turn-secret",
      },
    });
    expect(elicitation).toMatchObject([
      {
        interaction: {
          kind: "mcpElicitation",
          mode: "form",
        },
        kind: "interactionRequested",
      },
      { kind: "sessionStateChanged" },
    ]);
    const serializedElicitation = JSON.stringify(elicitation);
    expect(serializedElicitation).not.toContain("/etc/private");
    expect(serializedElicitation).not.toContain("must not cross");
    expect(serializedElicitation).not.toContain("requestedSchema");

    const urlElicitation = subject.mapServerRequest({
      id: "mcp-url-request-secret",
      method: "mcpServer/elicitation/request",
      params: {
        _meta: null,
        elicitationId: "native-elicitation-secret",
        message: "Open the provider flow",
        mode: "url",
        serverName: "linear",
        threadId: "thread-secret",
        turnId: null,
        url: "https://provider.example/private",
      },
    });
    expect(urlElicitation).toMatchObject([
      {
        interaction: { kind: "mcpElicitation", mode: "url" },
        kind: "interactionRequested",
      },
      { kind: "sessionStateChanged" },
    ]);
    expect(JSON.stringify(urlElicitation)).not.toContain(
      "native-elicitation-secret",
    );
    expect(JSON.stringify(urlElicitation)).not.toContain("provider.example");
  });

  it("accepts the generated Codex status and error shapes", () => {
    const subject = mapper();
    subject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "generated-thread" } },
    });
    expect(
      subject.mapNotification({
        method: "thread/status/changed",
        params: {
          status: { activeFlags: ["waitingOnApproval"], type: "active" },
          threadId: "generated-thread",
        },
      }),
    ).toMatchObject([
      { kind: "sessionStateChanged", state: "waitingForOperator" },
    ]);
    subject.mapNotification({
      method: "turn/started",
      params: {
        threadId: "generated-thread",
        turn: { id: "generated-turn", status: "inProgress" },
      },
    });
    const error = subject.mapNotification({
      method: "error",
      params: {
        error: {
          additionalDetails: "must not cross",
          codexErrorInfo: null,
          message: "GITHUB_TOKEN=ghp_topsecret at /etc/passwd",
        },
        threadId: "generated-thread",
        turnId: "generated-turn",
        willRetry: true,
      },
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("ghp_topsecret");
    expect(serialized).not.toContain("/etc/passwd");
    expect(serialized).not.toContain("additionalDetails");
  });

  it("redacts credential assignments, URI authority, and unrestricted absolute paths", () => {
    const subject = mapper();
    subject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "privacy-thread" } },
    });
    const events = subject.mapNotification({
      method: "warning",
      params: {
        message:
          "AWS_SECRET_ACCESS_KEY=aws_topsecret DATABASE_URL=postgres://secret@host/db HOME=/home/operator FEATURE_FLAG=private { NODE_ENV: 'production' } Authorization: Basic dXNlcjpwYXNz x-api-key: arbitrary-secret {\"NODE_ENV\":\"json-production\",\"AWS_SECRET_ACCESS_KEY\":\"json-secret\",\"Authorization\":\"Basic anNvbi1iYXNpYw==\"} Read `/etc/passwd` and see,/opt/private plus /Volumes/private/file",
        threadId: "privacy-thread",
      },
    });
    const serialized = JSON.stringify(events);
    for (const secret of [
      "aws_topsecret",
      "postgres://secret@host",
      "/home/operator",
      "FEATURE_FLAG=private",
      "NODE_ENV",
      "dXNlcjpwYXNz",
      "arbitrary-secret",
      "json-production",
      "json-secret",
      "anNvbi1iYXNpYw==",
      "/etc/passwd",
      "/opt/private",
      "/Volumes/private/file",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("bounds cumulative deltas and normalizes completion before start", () => {
    const subject = createCodexSessionMapper({
      capabilities,
      deltaFlushCharacters: 10_000,
      provider,
      sessionId,
      workspaceRoot: "/workspace/project",
    });
    subject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "ordering-thread" } },
    });
    const itemBeforeTurn = subject.mapNotification({
      method: "item/completed",
      params: {
        item: {
          id: "ordering-item",
          memoryCitation: null,
          phase: "final_answer",
          text: "final",
          type: "agentMessage",
        },
        threadId: "ordering-thread",
        turnId: "ordering-turn",
      },
    });
    expect(itemBeforeTurn.map(({ kind }) => kind)).toEqual([
      "turnStarted",
      "itemUpserted",
    ]);
    expect(
      subject.mapNotification({
        method: "turn/started",
        params: {
          threadId: "ordering-thread",
          turn: { id: "ordering-turn", status: "inProgress" },
        },
      }),
    ).toMatchObject([{ kind: "sessionStateChanged", state: "running" }]);

    subject.mapNotification({
      method: "turn/started",
      params: {
        threadId: "ordering-thread",
        turn: { id: "newer-turn", status: "inProgress" },
      },
    });
    const olderCompletion = subject.mapNotification({
      method: "turn/completed",
      params: {
        threadId: "ordering-thread",
        turn: { id: "ordering-turn", status: "completed" },
      },
    });
    expect(olderCompletion.map(({ kind }) => kind)).toEqual(["turnCompleted"]);
    expect(
      subject.mapNotification({
        method: "turn/started",
        params: {
          threadId: "ordering-thread",
          turn: { id: "ordering-turn", status: "inProgress" },
        },
      }),
    ).toEqual([]);
    const interruptedNewer = subject.mapNotification({
      method: "turn/completed",
      params: {
        threadId: "ordering-thread",
        turn: { id: "newer-turn", status: "interrupted" },
      },
    });
    expect(interruptedNewer.at(-1)).toMatchObject({
      kind: "sessionStateChanged",
      state: "idle",
    });

    const deltaSubject = createCodexSessionMapper({
      capabilities,
      deltaFlushCharacters: 10_000,
      provider,
      sessionId: parseHarnessSessionId("session-delta-budget"),
      workspaceRoot: "/workspace/project",
    });
    deltaSubject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "delta-thread" } },
    });
    const emitted = Array.from({ length: 8 }).flatMap(() =>
      deltaSubject.mapNotification({
        method: "item/agentMessage/delta",
        params: {
          delta: "x".repeat(10_000),
          itemId: "delta-item",
          threadId: "delta-thread",
          turnId: "delta-turn",
        },
      }),
    );
    const total = emitted.reduce(
      (sum, event) =>
        event.kind === "itemDeltaRecorded" ? sum + event.chunk.length : sum,
      0,
    );
    expect(total).toBeLessThanOrEqual(65_536);
  });

  it("removes externally resolved requests without inventing an operator decision", () => {
    const subject = mapper();
    subject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "resolved-thread" } },
    });
    const requested = {
      id: 7,
      method: "item/permissions/requestApproval",
      params: {
        cwd: "/workspace/project",
        environmentId: null,
        itemId: "resolved-item",
        permissions: { fileSystem: null, network: null },
        reason: "permission",
        startedAtMs: 1,
        threadId: "resolved-thread",
        turnId: "resolved-turn",
      },
    } as const;
    subject.mapServerRequest(requested);
    expect(subject.mapServerRequest(requested)).toEqual([]);
    expect(
      subject
        .mapNotification({
          method: "serverRequest/resolved",
          params: { requestId: 7, threadId: "resolved-thread" },
        })
        .map(({ kind }) => kind),
    ).toEqual(["interactionCancelled", "sessionStateChanged"]);
    expect(subject.mapServerRequest(requested)).toEqual([]);
  });

  it("maps live system errors to a typed terminal failure", () => {
    const subject = mapper();
    subject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "system-error-thread" } },
    });

    expect(
      subject.mapNotification({
        method: "thread/status/changed",
        params: {
          status: { type: "systemError" },
          threadId: "system-error-thread",
        },
      }),
    ).toEqual([
      expect.objectContaining({
        failure: expect.objectContaining({
          code: "CodexThreadSystemError",
          kind: "providerFailure",
        }),
        kind: "sessionFailed",
      }),
    ]);
  });

  it("routes warnings only to their owning thread and drops unscoped warnings", () => {
    const subject = mapper();
    subject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "warning-owner" } },
    });

    expect(
      subject.mapNotification({
        method: "warning",
        params: { message: "other", threadId: "warning-other" },
      }),
    ).toEqual([]);
    expect(
      subject.mapNotification({
        method: "warning",
        params: { message: "global", threadId: null },
      }),
    ).toEqual([]);
    expect(
      subject.mapNotification({
        method: "warning",
        params: { message: "owned", threadId: "warning-owner" },
      }),
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ message: "owned" }),
        kind: "itemUpserted",
      }),
    ]);
  });

  it("derives stable opaque item identity across recovery regardless of prior synthetic items", () => {
    const live = mapper();
    live.mapNotification({
      method: "thread/started",
      params: { thread: { id: "stable-thread" } },
    });
    live.mapNotification({
      method: "warning",
      params: { message: "pre-crash warning", threadId: "stable-thread" },
    });
    const liveItem = live.mapNotification({
      method: "item/completed",
      params: {
        item: {
          id: "stable-native-item",
          phase: "final_answer",
          text: "final",
          type: "agentMessage",
        },
        threadId: "stable-thread",
        turnId: "stable-turn",
      },
    }).find((event) => event.kind === "itemUpserted");

    const recovered = mapper();
    recovered.mapNotification({
      method: "thread/started",
      params: { thread: { id: "stable-thread" } },
    });
    const recoveredItem = recovered
      .mapRecoveredThread({
        id: "stable-thread",
        status: { type: "idle" },
        turns: [
          {
            id: "stable-turn",
            items: [
              {
                id: "stable-native-item",
                phase: "final_answer",
                text: "final",
                type: "agentMessage",
              },
            ],
            status: "completed",
          },
        ],
      })
      .find((event) => event.kind === "itemUpserted");

    expect(liveItem?.kind).toBe("itemUpserted");
    expect(recoveredItem?.kind).toBe("itemUpserted");
    if (liveItem?.kind !== "itemUpserted" || recoveredItem?.kind !== "itemUpserted") {
      throw new Error("Expected mapped items.");
    }
    expect(recoveredItem.item.itemId).toBe(liveItem.item.itemId);
  });

  it("replays a pre-crash warning together with a newly recovered final item", () => {
    const live = mapper();
    const liveStart = live.mapNotification({
      method: "thread/started",
      params: { thread: { id: "combined-thread" } },
    });
    const warning = live.mapNotification({
      method: "warning",
      params: { message: "pre-crash", threadId: "combined-thread" },
    });

    const recovered = mapper();
    const recoveredStart = recovered.mapNotification({
      method: "thread/started",
      params: { thread: { id: "combined-thread" } },
    });
    const recoveredEvents = recovered.mapRecoveredThread({
      id: "combined-thread",
      status: { type: "idle" },
      turns: [
        {
          id: "combined-turn",
          items: [
            {
              id: "missing-before-crash",
              phase: "final_answer",
              text: "authoritative recovered final",
              type: "agentMessage",
            },
          ],
          status: "completed",
        },
      ],
    });
    const snapshot = projectHarnessEvents(
      [
        ...liveStart,
        ...warning,
        ...recoveredStart,
        { kind: "sessionRecovered", sessionId },
        ...recoveredEvents,
      ],
      sessionId,
    );

    expect(snapshot.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "warning", message: "pre-crash" }),
        expect.objectContaining({
          kind: "message",
          text: "authoritative recovered final",
        }),
      ]),
    );
  });

  it("fails closed on unrepresentable approval scope and exposes audited permission scope", () => {
    const subject = mapper();
    subject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "approval-thread" } },
    });

    const file = subject.mapServerRequest({
      id: "outside-file",
      method: "item/fileChange/requestApproval",
      params: {
        grantRoot: "/private/outside",
        itemId: "file-item",
        reason: "outside",
        startedAtMs: 1,
        threadId: "approval-thread",
        turnId: "approval-turn",
      },
    });
    const fileInteraction = file.find(
      (event) => event.kind === "interactionRequested",
    );
    expect(fileInteraction).toMatchObject({
      interaction: {
        allowedDecisions: ["decline", "cancel"],
        kind: "fileChangeApproval",
        paths: [],
      },
    });

    const command = subject.mapServerRequest({
      id: "network-command",
      method: "item/commandExecution/requestApproval",
      params: {
        command: "curl example.com",
        cwd: "/workspace/project",
        itemId: "command-item",
        networkApprovalContext: { host: "example.com" },
        reason: "network",
        startedAtMs: 2,
        threadId: "approval-thread",
        turnId: "approval-turn",
      },
    });
    expect(
      command.find((event) => event.kind === "interactionRequested"),
    ).toMatchObject({
      interaction: {
        allowedDecisions: ["decline", "cancel"],
        kind: "commandApproval",
      },
    });

    const permission = subject.mapServerRequest({
      id: "audited-permission",
      method: "item/permissions/requestApproval",
      params: {
        cwd: "/workspace/project",
        environmentId: null,
        itemId: "permission-item",
        permissions: {
          fileSystem: {
            entries: [
              {
                access: "write",
                path: {
                  path: "/workspace/project/src",
                  type: "path",
                },
              },
            ],
            read: null,
            write: null,
          },
          network: { enabled: false },
        },
        reason: "write src",
        startedAtMs: 3,
        threadId: "approval-thread",
        turnId: "approval-turn",
      },
    });
    expect(
      permission.find((event) => event.kind === "interactionRequested"),
    ).toMatchObject({
      interaction: {
        allowedDecisions: ["approve", "decline", "cancel"],
        kind: "permissionApproval",
        scope: {
          fileSystem: [{ access: "write", path: "src" }],
          network: "disabled",
        },
      },
    });
  });

  it("redacts configured values before workspace normalization and structured credential keys", () => {
    const subject = createCodexSessionMapper({
      capabilities,
      provider,
      sensitiveValues: [
        "/workspace/project/private-key-material",
        "short-secret",
      ],
      sessionId,
      workspaceRoot: "/workspace/project",
    });
    subject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "redaction-thread" } },
    });
    const events = subject.mapNotification({
      method: "item/completed",
      params: {
        item: {
          id: "redaction-item",
          phase: "final_answer",
          text: 'path=/workspace/project/private-key-material {"client_secret":"value-one","openai_api_key":"value-two"}',
          type: "agentMessage",
        },
        threadId: "redaction-thread",
        turnId: "redaction-turn",
      },
    });
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain("private-key-material");
    expect(serialized).not.toContain("value-one");
    expect(serialized).not.toContain("value-two");
    expect(serialized).toContain("[environment]");
    expect(serialized).toContain("[credential]");
  });

  it("bounds adapter-local delta buffers before a provider can create unbounded item state", () => {
    const subject = createCodexSessionMapper({
      capabilities,
      deltaFlushCharacters: 10_000,
      provider,
      sessionId,
      workspaceRoot: "/workspace/project",
    });
    subject.mapNotification({
      method: "thread/started",
      params: { thread: { id: "delta-buffer-thread" } },
    });

    expect(() => {
      for (let index = 0; index < 1_001; index += 1) {
        subject.mapNotification({
          method: "item/agentMessage/delta",
          params: {
            delta: "x",
            itemId: `delta-item-${index}`,
            threadId: "delta-buffer-thread",
            turnId: "delta-buffer-turn",
          },
        });
      }
    }).toThrow();
  });
});
