import { assert, describe, it } from "@effect/vitest";
import {
  HarnessCapabilities,
  HarnessProviderDescriptor,
  HarnessSessionSnapshot,
  makeHarnessRunEvent,
  missingHarnessCapabilities,
  parseHarnessActionId,
  parseHarnessEvent,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessProviderId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseRunEvent,
  parseRunId,
  parseWorkspaceRelativePath,
  projectHarnessEvents,
  replayHarnessSession,
  type HarnessEvent,
} from "./index.js";

const runId = parseRunId("run-Gaia840001");
const sessionId = parseHarnessSessionId("session-gaia-84");
const turnId = parseHarnessTurnId("turn-gaia-84");
const recoveredTurnId = parseHarnessTurnId("turn-gaia-84-recovered");
const itemId = parseHarnessItemId("item-gaia-84");
const interactionId = parseHarnessInteractionId("interaction-gaia-84");
const recoveredInteractionId = parseHarnessInteractionId(
  "interaction-gaia-84-recovered",
);

const capabilities = HarnessCapabilities.make({
  approvals: ["command"],
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: true,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: true,
  usageReporting: true,
  userQuestions: true,
});

const provider = HarnessProviderDescriptor.make({
  displayName: "Synthetic Harness",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("synthetic"),
});

describe("provider-neutral harness contracts", () => {
  it("brands IDs and admits only workspace-relative non-traversing paths", () => {
    assert.strictEqual(parseHarnessProviderId("codex-app-server"), "codex-app-server");
    assert.strictEqual(parseHarnessSessionId("session-1"), "session-1");
    assert.strictEqual(parseHarnessTurnId("turn-1"), "turn-1");
    assert.strictEqual(parseHarnessItemId("item-1"), "item-1");
    assert.strictEqual(parseHarnessInteractionId("interaction-1"), "interaction-1");
    assert.strictEqual(parseHarnessActionId("action-1"), "action-1");
    assert.strictEqual(parseWorkspaceRelativePath("src/index.ts"), "src/index.ts");
    assert.throws(() => parseWorkspaceRelativePath("/Users/operator/secret.txt"));
    assert.throws(() => parseWorkspaceRelativePath("../secret.txt"));
    assert.throws(() => parseWorkspaceRelativePath("src/../../secret.txt"));
    assert.throws(() => parseWorkspaceRelativePath("C:\\secret.txt"));
  });

  it("reports every missing explicit capability without simulating support", () => {
    assert.deepStrictEqual(
      missingHarnessCapabilities(capabilities, [
        "streamingMessages",
        "fileChangeEvents",
        "review",
        "approval:fileChange",
      ]),
      ["review", "approval:fileChange"],
    );
  });

  it("replays ordered events deterministically with final item authority", () => {
    const events = [
      {
        capabilities,
        kind: "sessionStarted" as const,
        provider,
        sessionId,
        state: "connecting" as const,
      },
      {
        kind: "sessionStateChanged" as const,
        sessionId,
        state: "running" as const,
      },
      {
        kind: "turnStarted" as const,
        sessionId,
        turnId,
      },
      {
        kind: "turnStarted" as const,
        sessionId,
        turnId,
      },
      {
        chunk: "Hel",
        deltaKind: "message" as const,
        itemId,
        kind: "itemDeltaRecorded" as const,
        sessionId,
        turnId,
      },
      {
        chunk: "duplicate",
        deltaKind: "message" as const,
        itemId,
        kind: "itemDeltaRecorded" as const,
        sessionId,
        turnId,
      },
      {
        final: true,
        item: {
          kind: "message" as const,
          itemId,
          phase: "final" as const,
          status: "completed" as const,
          text: "Hello from the final item",
          turnId,
        },
        kind: "itemUpserted" as const,
        sessionId,
        turnId,
      },
      {
        final: true,
        item: {
          kind: "message" as const,
          itemId,
          phase: "final" as const,
          status: "completed" as const,
          text: "duplicate final must not replace authority",
          turnId,
        },
        kind: "itemUpserted" as const,
        sessionId,
        turnId,
      },
      {
        interaction: {
          allowedDecisions: ["approve", "decline"] as const,
          command: "pnpm test",
          interactionId,
          itemId,
          kind: "commandApproval" as const,
          reason: "Run tests",
          requestedAt: "2026-07-10T10:00:00.000Z",
          turnId,
          workspacePath: parseWorkspaceRelativePath("."),
        },
        kind: "interactionRequested" as const,
        sessionId,
      },
      {
        kind: "sessionStateChanged" as const,
        sessionId,
        state: "waitingForOperator" as const,
      },
      {
        kind: "interactionResolved" as const,
        resolution: {
          actionId: parseHarnessActionId("action-approve"),
          decision: "approve" as const,
          interactionId,
          kind: "approval" as const,
          resolvedAt: "2026-07-10T10:01:00.000Z",
        },
        sessionId,
      },
      {
        kind: "turnCompleted" as const,
        sessionId,
        status: "completed" as const,
        turnId,
      },
      {
        kind: "sessionStateChanged" as const,
        sessionId,
        state: "completed" as const,
      },
      {
        kind: "sessionStateChanged" as const,
        sessionId,
        state: "running" as const,
      },
    ].map((event, index) =>
      makeHarnessRunEvent({
        event,
        runId,
        sequence: index + 1,
        timestamp: `2026-07-10T10:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );

    const first = replayHarnessSession(events, sessionId);
    const second = replayHarnessSession(
      events.map((event) => parseRunEvent(JSON.parse(JSON.stringify(event)))),
      sessionId,
    );

    assert.deepStrictEqual(first, second);
    assert.instanceOf(first, HarnessSessionSnapshot);
    assert.strictEqual(first.state, "completed");
    assert.strictEqual(first.items[0]?.kind, "message");
    assert.strictEqual(first.items[0]?.kind === "message" ? first.items[0].text : "", "Hello from the final item");
    assert.strictEqual(first.pendingInteractions.length, 0);
    assert.strictEqual(first.resolvedInteractions.length, 1);
    assert.strictEqual(first.turns[0]?.status, "completed");
  });

  it("decodes the finite event payload instead of trusting generic RunEvent JSON", () => {
    const event = makeHarnessRunEvent({
      event: {
        capabilities,
        kind: "sessionStarted",
        provider,
        sessionId,
        state: "connecting",
      },
      runId,
      sequence: 1,
      timestamp: "2026-07-10T10:00:00.000Z",
    });
    const invalid = Object.assign(Object.create(Object.getPrototypeOf(event)), event, {
      payload: { event: { kind: "rawVendorPacket", secret: "token" } },
    });

    assert.throws(() => replayHarnessSession([invalid], sessionId));
  });

  it("rejects individually valid fields when the canonical event exceeds its byte budget", () => {
    assert.throws(() =>
      makeHarnessRunEvent({
        event: {
          final: true,
          item: {
            changes: Array.from({ length: 20 }, (_, index) => ({
              diff: "x".repeat(60_000),
              kind: "update" as const,
              path: parseWorkspaceRelativePath(`src/file-${index}.ts`),
            })),
            itemId,
            kind: "fileChange",
            status: "completed",
            turnId,
          },
          kind: "itemUpserted",
          sessionId,
          turnId,
        },
        runId,
        sequence: 1,
        timestamp: "2026-07-10T10:00:00.000Z",
      }),
    );
  });

  it("rejects a session whose individually valid events exceed the aggregate budget", () => {
    const largeText = "x".repeat(65_536);
    const events: Array<HarnessEvent> = [
      {
        capabilities,
        kind: "sessionStarted",
        provider,
        sessionId,
        state: "running",
      },
      ...Array.from({ length: 256 }, (_, index) => ({
        final: true,
        item: {
          itemId: parseHarnessItemId(`aggregate-item-${index}`),
          kind: "message" as const,
          phase: "final" as const,
          status: "completed" as const,
          text: largeText,
          turnId,
        },
        kind: "itemUpserted" as const,
        sessionId,
        turnId,
      })),
    ];

    assert.throws(() => projectHarnessEvents(events, sessionId));
  });

  it("recovers deterministically and keeps every terminal state monotonic", () => {
    const terminalCases = [
      "completed",
      "interrupted",
      "unavailable",
    ] as const;
    for (const terminalState of terminalCases) {
      const events = [
        makeHarnessRunEvent({
          event: {
            capabilities,
            kind: "sessionStarted",
            provider,
            sessionId,
            state: "connecting",
          },
          runId,
          sequence: 1,
          timestamp: "2026-07-10T10:00:00.000Z",
        }),
        makeHarnessRunEvent({
          event: {
            kind: "sessionRecovered",
            sessionId,
          },
          runId,
          sequence: 2,
          timestamp: "2026-07-10T10:00:01.000Z",
        }),
        makeHarnessRunEvent({
          event: {
            kind: "sessionStateChanged",
            sessionId,
            state: terminalState,
          },
          runId,
          sequence: 3,
          timestamp: "2026-07-10T10:00:02.000Z",
        }),
        makeHarnessRunEvent({
          event: {
            kind: "sessionStateChanged",
            sessionId,
            state: "running",
          },
          runId,
          sequence: 4,
          timestamp: "2026-07-10T10:00:03.000Z",
        }),
      ];
      const projection = replayHarnessSession(events, sessionId);
      assert.strictEqual(projection.recovered, true);
      assert.strictEqual(projection.state, terminalState);
    }

    const failed = replayHarnessSession(
      [
        makeHarnessRunEvent({
          event: {
            capabilities,
            kind: "sessionStarted",
            provider,
            sessionId,
            state: "connecting",
          },
          runId,
          sequence: 1,
          timestamp: "2026-07-10T10:00:00.000Z",
        }),
        makeHarnessRunEvent({
          event: {
            failure: {
              code: "ProviderCrashed",
              kind: "providerFailure",
              message: "Provider stopped unexpectedly.",
              recoverable: true,
            },
            kind: "sessionFailed",
            sessionId,
          },
          runId,
          sequence: 2,
          timestamp: "2026-07-10T10:00:01.000Z",
        }),
      ],
      sessionId,
    );
    assert.strictEqual(failed.state, "failed");
    assert.strictEqual(failed.failure?.kind, "providerFailure");
  });

  it("reopens only an explicitly recoverable provider failure and projects the new active interaction", () => {
    const projection = replayHarnessSession(
      [
        harnessRunEvent(1, {
          capabilities,
          kind: "sessionStarted",
          provider,
          sessionId,
          state: "running",
        }),
        harnessRunEvent(2, {
          kind: "turnStarted",
          sessionId,
          turnId,
        }),
        harnessRunEvent(3, {
          interaction: commandApproval(interactionId, turnId),
          kind: "interactionRequested",
          sessionId,
        }),
        harnessRunEvent(4, {
          failure: recoverableProviderFailure,
          kind: "sessionFailed",
          sessionId,
        }),
        harnessRunEvent(5, {
          kind: "sessionRecovered",
          sessionId,
        }),
        harnessRunEvent(6, {
          kind: "turnStarted",
          sessionId,
          turnId: recoveredTurnId,
        }),
        harnessRunEvent(7, {
          interaction: commandApproval(recoveredInteractionId, recoveredTurnId),
          kind: "interactionRequested",
          sessionId,
        }),
      ],
      sessionId,
    );

    assert.strictEqual(projection.state, "running");
    assert.strictEqual(projection.recovered, true);
    assert.strictEqual(projection.failure, undefined);
    assert.deepStrictEqual(
      projection.turns.map(({ status, turnId }) => ({ status, turnId })),
      [
        { status: "failed", turnId },
        { status: "running", turnId: recoveredTurnId },
      ],
    );
    assert.deepStrictEqual(
      projection.pendingInteractions.map(({ interactionId, kind, turnId }) => ({
        interactionId,
        kind,
        turnId,
      })),
      [
        {
          interactionId: recoveredInteractionId,
          kind: "commandApproval",
          turnId: recoveredTurnId,
        },
      ],
    );
    assert.deepStrictEqual(projection.turns[0]?.failure, recoverableProviderFailure);
  });

  it("terminalizes nonterminal turns and clears pending interactions on session failure", () => {
    const projection = replayHarnessSession(
      [
        harnessRunEvent(1, {
          capabilities,
          kind: "sessionStarted",
          provider,
          sessionId,
          state: "running",
        }),
        harnessRunEvent(2, {
          kind: "turnStarted",
          sessionId,
          turnId,
        }),
        harnessRunEvent(3, {
          interaction: commandApproval(interactionId, turnId),
          kind: "interactionRequested",
          sessionId,
        }),
        harnessRunEvent(4, {
          failure: recoverableProviderFailure,
          kind: "sessionFailed",
          sessionId,
        }),
      ],
      sessionId,
    );

    assert.strictEqual(projection.state, "failed");
    assert.deepStrictEqual(projection.pendingInteractions, []);
    assert.deepStrictEqual(
      projection.turns.map(({ failure, status, turnId }) => ({
        failure,
        status,
        turnId,
      })),
      [
        {
          failure: recoverableProviderFailure,
          status: "failed",
          turnId,
        },
      ],
    );
  });

  it("keeps completed, interrupted, unavailable, and nonrecoverable failures absorbing", () => {
    const terminalCases: ReadonlyArray<{
      readonly label: string;
      readonly terminalEvent: HarnessEvent;
      readonly expectedState: "completed" | "failed" | "interrupted" | "unavailable";
    }> = [
      {
        expectedState: "completed",
        label: "completed",
        terminalEvent: {
          kind: "sessionStateChanged",
          sessionId,
          state: "completed",
        },
      },
      {
        expectedState: "interrupted",
        label: "interrupted",
        terminalEvent: {
          kind: "sessionStateChanged",
          sessionId,
          state: "interrupted",
        },
      },
      {
        expectedState: "unavailable",
        label: "unavailable",
        terminalEvent: {
          kind: "sessionStateChanged",
          sessionId,
          state: "unavailable",
        },
      },
      {
        expectedState: "failed",
        label: "nonrecoverable provider failure",
        terminalEvent: {
          failure: {
            code: "ProviderDenied",
            kind: "providerFailure",
            message: "Provider refused the session.",
            recoverable: false,
          },
          kind: "sessionFailed",
          sessionId,
        },
      },
      {
        expectedState: "failed",
        label: "nonrecoverable unavailable failure",
        terminalEvent: {
          failure: {
            kind: "unavailable",
            message: "Harness stopped safely.",
            recoverable: false,
          },
          kind: "sessionFailed",
          sessionId,
        },
      },
    ];

    for (const { expectedState, label, terminalEvent } of terminalCases) {
      const projection = replayHarnessSession(
        [
          harnessRunEvent(1, {
            capabilities,
            kind: "sessionStarted",
            provider,
            sessionId,
            state: "running",
          }),
          harnessRunEvent(2, {
            kind: "turnStarted",
            sessionId,
            turnId,
          }),
          harnessRunEvent(3, terminalEvent),
          harnessRunEvent(4, {
            kind: "sessionRecovered",
            sessionId,
          }),
          harnessRunEvent(5, {
            kind: "turnStarted",
            sessionId,
            turnId: recoveredTurnId,
          }),
          harnessRunEvent(6, {
            interaction: commandApproval(recoveredInteractionId, recoveredTurnId),
            kind: "interactionRequested",
            sessionId,
          }),
        ],
        sessionId,
      );

      assert.strictEqual(
        projection.state,
        expectedState,
        `${label} must remain terminal`,
      );
      assert.strictEqual(projection.turns.length, 1);
      assert.strictEqual(projection.pendingInteractions.length, 0);
    }
  });

  it("rejects lifecycle events without a start and globally out-of-order run events", () => {
    const turnBeforeSession = makeHarnessRunEvent({
      event: {
        kind: "turnStarted",
        sessionId,
        turnId,
      },
      runId,
      sequence: 1,
      timestamp: "2026-07-10T10:00:00.000Z",
    });
    assert.throws(() => replayHarnessSession([turnBeforeSession], sessionId));

    const startedAtSequenceTwo = makeHarnessRunEvent({
      event: {
        capabilities,
        kind: "sessionStarted",
        provider,
        sessionId,
        state: "connecting",
      },
      runId,
      sequence: 2,
      timestamp: "2026-07-10T10:00:00.000Z",
    });
    assert.throws(() => replayHarnessSession([startedAtSequenceTwo], sessionId));
  });

  it("rejects failed starts and state changes without a typed terminal failure", () => {
    assert.throws(() =>
      parseHarnessEvent({
        capabilities,
        kind: "sessionStarted",
        provider,
        sessionId,
        state: "failed",
      }),
    );
    assert.throws(() =>
      parseHarnessEvent({
        kind: "sessionStateChanged",
        sessionId,
        state: "failed",
      }),
    );
  });

  it("rejects turn-scoped items and interactions for turns that never started", () => {
    const start: HarnessEvent = {
      capabilities,
      kind: "sessionStarted",
      provider,
      sessionId,
      state: "running",
    };
    const invalidEvents: ReadonlyArray<HarnessEvent> = [
      {
        chunk: "orphan",
        deltaKind: "message",
        itemId,
        kind: "itemDeltaRecorded",
        sessionId,
        turnId,
      },
      {
        final: true,
        item: {
          itemId,
          kind: "message",
          phase: "final",
          status: "completed",
          text: "orphan",
          turnId,
        },
        kind: "itemUpserted",
        sessionId,
        turnId,
      },
      {
        interaction: {
          allowedDecisions: ["decline"],
          command: "pnpm test",
          interactionId,
          itemId,
          kind: "commandApproval",
          requestedAt: "2026-07-10T10:00:00.000Z",
          turnId,
          workspacePath: parseWorkspaceRelativePath("."),
        },
        kind: "interactionRequested",
        sessionId,
      },
    ];

    for (const invalidEvent of invalidEvents) {
      assert.throws(() =>
        projectHarnessEvents([start, invalidEvent], sessionId),
      );
    }
  });

  it("uses authoritative run-event order instead of provider-local revisions", () => {
    const runEvents = [
      makeHarnessRunEvent({
          event: {
            capabilities,
            kind: "sessionStarted",
            provider,
            sessionId,
            state: "connecting",
          },
          runId,
          sequence: 1,
          timestamp: "2026-07-10T10:00:00.000Z",
      }),
      makeHarnessRunEvent({
          event: {
            kind: "sessionStateChanged",
            sessionId,
            state: "idle",
          },
          runId,
          sequence: 2,
          timestamp: "2026-07-10T10:00:01.000Z",
      }),
    ];
    const firstRunEvent = runEvents[0];
    if (firstRunEvent === undefined) {
      throw new Error("Expected the first harness run event.");
    }
    const firstPayload = firstRunEvent.payload.event;
    assert.strictEqual(
      typeof firstPayload === "object" &&
        firstPayload !== null &&
        "revision" in firstPayload,
      false,
    );
    const projection = replayHarnessSession(runEvents, sessionId);

    assert.strictEqual(projection.state, "idle");
  });

  it("bounds cumulative delta previews and lets the final item replace them", () => {
    const chunk = "x".repeat(40_000);
    const events = [
      {
        capabilities,
        kind: "sessionStarted" as const,
        provider,
        sessionId,
        state: "running" as const,
      },
      {
        kind: "turnStarted" as const,
        sessionId,
        turnId,
      },
      {
        chunk,
        deltaKind: "message" as const,
        itemId,
        kind: "itemDeltaRecorded" as const,
        sessionId,
        turnId,
      },
      {
        chunk,
        deltaKind: "message" as const,
        itemId,
        kind: "itemDeltaRecorded" as const,
        sessionId,
        turnId,
      },
      {
        final: true,
        item: {
          itemId,
          kind: "message" as const,
          phase: "final" as const,
          status: "completed" as const,
          text: "authoritative final",
          turnId,
        },
        kind: "itemUpserted" as const,
        sessionId,
        turnId,
      },
    ].map((event, index) =>
      makeHarnessRunEvent({
        event,
        runId,
        sequence: index + 1,
        timestamp: `2026-07-10T10:00:0${index}.000Z`,
      }),
    );

    const projection = replayHarnessSession(events, sessionId);
    assert.strictEqual(
      projection.items[0]?.kind === "message"
        ? projection.items[0].text
        : "",
      "authoritative final",
    );
  });

  it("rejects resolutions and events that contradict their request or capabilities", () => {
    const request = {
      allowedDecisions: ["decline"] as const,
      command: "pnpm test",
      interactionId,
      itemId,
      kind: "commandApproval" as const,
      requestedAt: "2026-07-10T10:00:00.000Z",
      turnId,
      workspacePath: parseWorkspaceRelativePath("."),
    };
    assert.throws(() =>
      replayHarnessSession(
        [
          makeHarnessRunEvent({
            event: {
              capabilities,
              kind: "sessionStarted",
              provider,
              sessionId,
              state: "running",
            },
            runId,
            sequence: 1,
            timestamp: "2026-07-10T10:00:00.000Z",
          }),
          makeHarnessRunEvent({
            event: {
              interaction: request,
              kind: "interactionRequested",
              sessionId,
            },
            runId,
            sequence: 2,
            timestamp: "2026-07-10T10:00:01.000Z",
          }),
          makeHarnessRunEvent({
            event: {
              kind: "interactionResolved",
              resolution: {
                actionId: parseHarnessActionId("action-invalid"),
                decision: "approve",
                interactionId,
                kind: "approval",
                resolvedAt: "2026-07-10T10:00:02.000Z",
              },
              sessionId,
            },
            runId,
            sequence: 3,
            timestamp: "2026-07-10T10:00:02.000Z",
          }),
        ],
        sessionId,
      ),
    );

    const noTools = HarnessCapabilities.make({
      ...capabilities,
      toolEvents: false,
    });
    assert.throws(() =>
      replayHarnessSession(
        [
          makeHarnessRunEvent({
            event: {
              capabilities: noTools,
              kind: "sessionStarted",
              provider,
              sessionId,
              state: "running",
            },
            runId,
            sequence: 1,
            timestamp: "2026-07-10T10:00:00.000Z",
          }),
          makeHarnessRunEvent({
            event: {
              final: true,
              item: {
                itemId,
                kind: "toolCall",
                status: "completed",
                toolName: "forbidden-tool",
                turnId,
              },
              kind: "itemUpserted",
              sessionId,
              turnId,
            },
            runId,
            sequence: 2,
            timestamp: "2026-07-10T10:00:01.000Z",
          }),
        ],
        sessionId,
      ),
    );
  });

  it("enforces every event-producing capability at replay", () => {
    const unavailable = HarnessCapabilities.make({
      approvals: [],
      fileChangeEvents: false,
      interruption: false,
      resumableSessions: false,
      review: false,
      steering: false,
      streamingMessages: false,
      structuredOutput: false,
      subagents: false,
      toolEvents: false,
      usageReporting: false,
      userQuestions: false,
    });
    const interactionBase = {
      interactionId,
      itemId,
      requestedAt: "2026-07-10T10:00:00.000Z",
      turnId,
    } as const;
    const capabilityEvents: ReadonlyArray<HarnessEvent> = [
      {
        chunk: "delta",
        deltaKind: "message",
        itemId,
        kind: "itemDeltaRecorded",
        sessionId,
        turnId,
      },
      {
        final: true,
        item: {
          changes: [],
          itemId,
          kind: "fileChange",
          status: "completed",
          turnId,
        },
        kind: "itemUpserted",
        sessionId,
        turnId,
      },
      {
        final: true,
        item: {
          itemId,
          kind: "toolCall",
          status: "completed",
          toolName: "tool",
          turnId,
        },
        kind: "itemUpserted",
        sessionId,
        turnId,
      },
      {
        final: true,
        item: {
          itemId,
          kind: "review",
          status: "completed",
          summary: "review",
          turnId,
        },
        kind: "itemUpserted",
        sessionId,
        turnId,
      },
      {
        final: false,
        item: {
          inputTokens: 1,
          itemId,
          kind: "usage",
          outputTokens: 1,
          turnId,
        },
        kind: "itemUpserted",
        sessionId,
        turnId,
      },
      { kind: "sessionRecovered", sessionId },
      {
        interaction: {
          ...interactionBase,
          allowedDecisions: ["decline"],
          command: "pnpm test",
          kind: "commandApproval",
          workspacePath: parseWorkspaceRelativePath("."),
        },
        kind: "interactionRequested",
        sessionId,
      },
      {
        interaction: {
          ...interactionBase,
          allowedDecisions: ["decline"],
          kind: "fileChangeApproval",
          paths: [],
        },
        kind: "interactionRequested",
        sessionId,
      },
      {
        interaction: {
          ...interactionBase,
          allowedDecisions: ["decline"],
          kind: "permissionApproval",
          scope: { fileSystem: [], network: "notRequested" },
          summary: "permission",
        },
        kind: "interactionRequested",
        sessionId,
      },
      {
        interaction: {
          ...interactionBase,
          kind: "userInput",
          questions: [],
        },
        kind: "interactionRequested",
        sessionId,
      },
      {
        interaction: {
          interactionId,
          kind: "mcpElicitation",
          message: "input",
          mode: "form",
          requestedAt: "2026-07-10T10:00:00.000Z",
          serverName: "server",
        },
        kind: "interactionRequested",
        sessionId,
      },
    ];

    for (const event of capabilityEvents) {
      assert.throws(() =>
        replayHarnessSession(
          [
            makeHarnessRunEvent({
              event: {
                capabilities: unavailable,
                kind: "sessionStarted",
                provider,
                sessionId,
                state: "running",
              },
              runId,
              sequence: 1,
              timestamp: "2026-07-10T10:00:00.000Z",
            }),
            makeHarnessRunEvent({
              event,
              runId,
              sequence: 2,
              timestamp: "2026-07-10T10:00:01.000Z",
            }),
          ],
          sessionId,
        ),
      );
    }

    const approvalButNoQuestions = HarnessCapabilities.make({
      ...unavailable,
      approvals: ["userInput"],
    });
    const userInputCapabilityEvent = capabilityEvents[9];
    if (userInputCapabilityEvent === undefined) {
      throw new Error("Expected the user-input capability event fixture.");
    }
    assert.throws(() =>
      replayHarnessSession(
        [
          makeHarnessRunEvent({
            event: {
              capabilities: approvalButNoQuestions,
              kind: "sessionStarted",
              provider,
              sessionId,
              state: "running",
            },
            runId,
            sequence: 1,
            timestamp: "2026-07-10T10:00:00.000Z",
          }),
          makeHarnessRunEvent({
            event: userInputCapabilityEvent,
            runId,
            sequence: 2,
            timestamp: "2026-07-10T10:00:01.000Z",
          }),
        ],
        sessionId,
      ),
    );
  });
});

const recoverableProviderFailure = {
  code: "ProviderCrashed",
  kind: "providerFailure" as const,
  message: "Provider stopped unexpectedly.",
  recoverable: true,
};

function harnessRunEvent(
  sequence: number,
  event: HarnessEvent,
) {
  return makeHarnessRunEvent({
    event,
    runId,
    sequence,
    timestamp: `2026-07-10T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  });
}

function commandApproval(
  interactionId: typeof recoveredInteractionId,
  turnId: typeof recoveredTurnId,
) {
  return {
    allowedDecisions: ["decline", "cancel"] as const,
    command: "pnpm gaia doctor --json",
    interactionId,
    itemId,
    kind: "commandApproval" as const,
    reason: "Run doctor smoke",
    requestedAt: "2026-07-10T10:00:00.000Z",
    turnId,
    workspacePath: parseWorkspaceRelativePath("."),
  };
}
