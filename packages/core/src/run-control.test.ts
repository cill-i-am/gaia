import { assert, describe, it } from "@effect/vitest";

import {
  makeRunControlActionBindingDigest,
  makeRunControlCheckpointDigest,
  makeRunControlRequestDigest,
  parseHarnessEvent,
  parseRunHumanWaitCheckpoint,
  parseRunControlEventPayload,
  parseRunEvent,
  parseRunEventSequence,
  parseRunId,
  replayRunEvents,
  snapshotFromReplay,
} from "./index.js";

const runId = parseRunId("run-Gaia148A1x");
const timestamp = "2026-07-22T15:55:00.000Z";
const sessionId = "session-gaia-148";
const interactionId = "interaction-gaia-148";

const event = (
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {}
) =>
  parseRunEvent({
    payload,
    runId,
    sequence,
    timestamp,
    type,
    version: 1 as const,
  });

const interactionRequested = parseHarnessEvent({
  interaction: {
    interactionId,
    itemId: "item-gaia-148",
    kind: "userInput",
    questions: [
      {
        options: [],
        prompt: "Choose the next safe action.",
        questionId: "question-gaia-148",
        secret: false,
      },
    ],
    requestedAt: timestamp,
    turnId: "turn-gaia-148",
  },
  kind: "interactionRequested",
  sessionId,
});
if (interactionRequested.kind !== "interactionRequested")
  throw new Error("Expected an interactionRequested harness event.");

const checkpointWithPlaceholder = parseRunHumanWaitCheckpoint({
  checkpointDigest: "a".repeat(64),
  environmentReceipt: {
    byteLength: 512,
    path: `harness-environment/receipt-${"b".repeat(64)}.json`,
    receiptDigest: "b".repeat(64),
    runId,
    structuralDigest: "c".repeat(64),
    version: 1,
  },
  expectedEventSequence: 7,
  interactionId,
  providerId: "fake",
  requestDigest: makeRunControlRequestDigest(interactionRequested.interaction),
  requestedAt: timestamp,
  resolverAuthorityId: "authority-local",
  runId,
  sessionId,
  version: 1 as const,
  workerAgentId: "agent-worker",
  workerStartedSequence: 3,
});
const { checkpointDigest: _checkpointDigest, ...checkpointWithoutDigest } =
  checkpointWithPlaceholder;
const checkpoint = {
  ...checkpointWithoutDigest,
  checkpointDigest: makeRunControlCheckpointDigest(checkpointWithoutDigest),
};

const binding = {
  actionBindingDigest: "e".repeat(64),
  actionId: "action-gaia-148",
  authorityId: "authority-local",
  checkpointDigest: checkpoint.checkpointDigest,
  expectedEventSequence: 7,
  interactionId: checkpoint.interactionId,
  operation: "resolveInteraction",
  providerId: checkpoint.providerId,
  requestDigest: checkpoint.requestDigest,
  sessionId: checkpoint.sessionId,
  workerAgentId: checkpoint.workerAgentId,
  workerStartedSequence: checkpoint.workerStartedSequence,
};
const runningControlBinding = {
  actionBindingDigest: binding.actionBindingDigest,
  actionId: "action-running-control",
  authorityId: binding.authorityId,
  expectedEventSequence: 3,
  operation: "pause",
  providerId: binding.providerId,
  restoreState: "runningWorker",
  sessionId: binding.sessionId,
  workerAgentId: binding.workerAgentId,
  workerStartedSequence: binding.workerStartedSequence,
};

const runningHistory = () => [
  event(1, "RUN_CREATED", { specPath: "spec.md" }),
  event(2, "WORKSPACE_PREPARED", { workspacePath: "." }),
  event(3, "WORKER_STARTED"),
];

const authoritativeWaitHistory = () => [
  ...runningHistory(),
  event(4, "HARNESS_SESSION_EVENT_RECORDED", {
    event: {
      capabilities: {
        approvals: ["userInput"],
        durableCancellation: true,
        durableInteractionResolution: true,
        durablePause: true,
        fileChangeEvents: false,
        interruption: true,
        resumableSessions: true,
        review: false,
        steering: false,
        streamingMessages: true,
        structuredOutput: false,
        subagents: false,
        toolEvents: false,
        usageReporting: false,
        userQuestions: true,
      },
      kind: "sessionStarted",
      provider: {
        displayName: "Fake",
        executionModes: ["local"],
        providerId: "fake",
      },
      sessionId,
      state: "running",
    },
  }),
  event(5, "HARNESS_SESSION_EVENT_RECORDED", {
    event: {
      kind: "turnStarted",
      sessionId,
      turnId: "turn-gaia-148",
    },
  }),
  event(6, "HARNESS_SESSION_EVENT_RECORDED", {
    event: interactionRequested,
  }),
];

const attemptedControl = (startSequence: number, control: unknown) => [
  event(startSequence, "RUN_CONTROL_INTENT_RECORDED", { control }),
  event(startSequence + 1, "RUN_CONTROL_ATTEMPTED", { control }),
];

describe("durable run control replay", () => {
  it("replays a value-free human wait checkpoint", () => {
    const events = [
      ...authoritativeWaitHistory(),
      event(7, "RUN_WAITING_FOR_HUMAN", { checkpoint }),
    ];

    const snapshot = snapshotFromReplay(events);

    assert.strictEqual(snapshot.state, "waitingForHuman");
    assert.deepEqual(
      JSON.parse(JSON.stringify(snapshot.context["runControl"])),
      JSON.parse(
        JSON.stringify({
          checkpoint,
          expired: false,
          restoreState: "waitingForHuman",
        })
      )
    );
    assert.throws(() =>
      replayRunEvents([
        ...authoritativeWaitHistory(),
        event(7, "RUN_WAITING_FOR_HUMAN", {
          checkpoint: { ...checkpoint, requestDigest: "f".repeat(64) },
        }),
      ])
    );
    assert.throws(() =>
      replayRunEvents([
        ...events,
        event(8, "RUN_INTERACTION_EXPIRED", {
          checkpointDigest: "f".repeat(64),
        }),
      ])
    );
    assert.throws(() =>
      replayRunEvents([
        ...events,
        event(8, "RUN_INTERACTION_EXPIRED", {
          checkpointDigest: checkpoint.checkpointDigest,
        }),
        event(9, "RUN_INTERACTION_EXPIRED", {
          checkpointDigest: checkpoint.checkpointDigest,
        }),
      ])
    );
  });

  it("rejects forged wait authority without matching harness history", () => {
    for (const override of [
      { sessionId: "session-forged" },
      { providerId: "forged-provider" },
      { interactionId: "interaction-forged" },
    ]) {
      const forgedWithPlaceholder = parseRunHumanWaitCheckpoint({
        ...checkpoint,
        ...override,
        checkpointDigest: "f".repeat(64),
      });
      const { checkpointDigest: _digest, ...checkpointInput } =
        forgedWithPlaceholder;
      const forgedCheckpoint = {
        ...checkpointInput,
        checkpointDigest: makeRunControlCheckpointDigest(checkpointInput),
      };
      assert.throws(() =>
        replayRunEvents([
          ...authoritativeWaitHistory(),
          event(7, "RUN_WAITING_FOR_HUMAN", {
            checkpoint: forgedCheckpoint,
          }),
        ])
      );
    }
  });

  it("binds every claimed control phase to the active wait checkpoint", () => {
    const forgedBindings = [
      { authorityId: "authority-forged" },
      { checkpointDigest: "f".repeat(64) },
      { requestDigest: "f".repeat(64) },
      { sessionId: "session-forged" },
      { interactionId: "interaction-forged" },
      { providerId: "forged-provider" },
      { workerAgentId: "agent-forged" },
      { workerStartedSequence: 2 },
      { expectedEventSequence: 6 },
    ];

    for (const override of forgedBindings) {
      const forged = parseRunControlEventPayload({ ...binding, ...override });
      const control = parseRunControlEventPayload({
        ...forged,
        actionBindingDigest: makeRunControlActionBindingDigest({
          actionId: forged.actionId,
          authorityId: forged.authorityId,
          ...(forged.checkpointDigest === undefined
            ? {}
            : { checkpointDigest: forged.checkpointDigest }),
          expectedEventSequence: forged.expectedEventSequence,
          ...(forged.interactionId === undefined
            ? {}
            : { interactionId: forged.interactionId }),
          operation: forged.operation,
          providerId: forged.providerId,
          ...(forged.requestDigest === undefined
            ? {}
            : { requestDigest: forged.requestDigest }),
          runId,
          sessionId: forged.sessionId,
          workerAgentId: forged.workerAgentId,
          workerStartedSequence: forged.workerStartedSequence,
        }),
      });

      assert.throws(() =>
        replayRunEvents([
          ...authoritativeWaitHistory(),
          event(7, "RUN_WAITING_FOR_HUMAN", { checkpoint }),
          ...attemptedControl(8, control),
          event(10, "RUN_CONTROL_CONFIRMED", { control }),
        ])
      );
    }
  });

  it("requires the checkpoint interaction to remain pending", () => {
    const terminalInteractionEvents = [
      {
        interactionId,
        kind: "interactionCancelled",
        reason: "providerResolved",
        sessionId,
      },
      {
        kind: "interactionResolved",
        resolution: {
          actionId: "action-resolved-before-wait",
          decision: "submit",
          interactionId,
          kind: "userInput",
          resolvedAt: timestamp,
        },
        sessionId,
      },
      {
        kind: "sessionStateChanged",
        sessionId,
        state: "completed",
      },
    ];
    const waitingCheckpointInput = {
      ...checkpointWithoutDigest,
      expectedEventSequence: parseRunEventSequence(8),
    };
    const waitingCheckpoint = {
      ...waitingCheckpointInput,
      checkpointDigest: makeRunControlCheckpointDigest(waitingCheckpointInput),
    };

    for (const harnessEvent of terminalInteractionEvents) {
      assert.throws(() =>
        replayRunEvents([
          ...authoritativeWaitHistory(),
          event(7, "HARNESS_SESSION_EVENT_RECORDED", {
            event: harnessEvent,
          }),
          event(8, "RUN_WAITING_FOR_HUMAN", {
            checkpoint: waitingCheckpoint,
          }),
        ])
      );
    }
  });

  it("pauses and resumes the exact intentional state", () => {
    const events = [
      ...authoritativeWaitHistory(),
      event(7, "RUN_WAITING_FOR_HUMAN", { checkpoint }),
      ...attemptedControl(8, {
        ...binding,
        actionId: "action-pause",
        operation: "pause",
        restoreState: "waitingForHuman",
      }),
      event(10, "RUN_CONTROL_CONFIRMED", {
        control: {
          ...binding,
          actionId: "action-pause",
          operation: "pause",
          restoreState: "waitingForHuman",
        },
      }),
      ...attemptedControl(11, {
        ...binding,
        actionId: "action-resume",
        operation: "resume",
        restoreState: "waitingForHuman",
      }),
      event(13, "RUN_CONTROL_CONFIRMED", {
        control: {
          ...binding,
          actionId: "action-resume",
          operation: "resume",
          restoreState: "waitingForHuman",
        },
      }),
    ];

    assert.strictEqual(snapshotFromReplay(events.slice(0, 10)).state, "paused");
    assert.strictEqual(snapshotFromReplay(events).state, "waitingForHuman");
  });

  it("rejects fabricated restore states without a human-wait checkpoint", () => {
    const boundControl = (overrides: Record<string, unknown>) => {
      const parsed = parseRunControlEventPayload({
        ...runningControlBinding,
        ...overrides,
      });
      return parseRunControlEventPayload({
        ...parsed,
        actionBindingDigest: makeRunControlActionBindingDigest({
          actionId: parsed.actionId,
          authorityId: parsed.authorityId,
          expectedEventSequence: parsed.expectedEventSequence,
          operation: parsed.operation,
          providerId: parsed.providerId,
          runId,
          sessionId: parsed.sessionId,
          workerAgentId: parsed.workerAgentId,
          workerStartedSequence: parsed.workerStartedSequence,
        }),
      });
    };
    const forgedPause = boundControl({
      actionId: "action-forged-pause-restore",
      restoreState: "waitingForHuman",
    });
    const validPause = boundControl({
      actionId: "action-valid-pause-restore",
    });
    const forgedResume = boundControl({
      actionId: "action-forged-resume-restore",
      expectedEventSequence: 6,
      operation: "resume",
      restoreState: "waitingForHuman",
    });

    assert.throws(() =>
      replayRunEvents([
        ...runningHistory(),
        ...attemptedControl(4, forgedPause),
        event(6, "RUN_CONTROL_CONFIRMED", { control: forgedPause }),
      ])
    );
    assert.throws(() =>
      replayRunEvents([
        ...runningHistory(),
        ...attemptedControl(4, validPause),
        event(6, "RUN_CONTROL_CONFIRMED", { control: validPause }),
        ...attemptedControl(7, forgedResume),
        event(9, "RUN_CONTROL_CONFIRMED", { control: forgedResume }),
      ])
    );
  });

  it("makes confirmed cancellation terminal", () => {
    const cancelled = [
      ...runningHistory(),
      ...attemptedControl(4, {
        ...runningControlBinding,
        actionId: "action-cancel",
        operation: "cancel",
      }),
      event(6, "RUN_CONTROL_CONFIRMED", {
        control: {
          ...runningControlBinding,
          actionId: "action-cancel",
          operation: "cancel",
        },
      }),
    ];

    assert.strictEqual(snapshotFromReplay(cancelled).state, "cancelled");
    assert.throws(
      () =>
        replayRunEvents([
          ...cancelled,
          event(7, "WORKER_COMPLETED", {
            workerResultPath: "worker-result.json",
          }),
        ]),
      /terminal|cancelled/u
    );
    assert.throws(() =>
      replayRunEvents([
        ...runningHistory(),
        event(4, "RUN_CONTROL_CONFIRMED", {
          control: {
            ...runningControlBinding,
            actionId: "action-fabricated-confirmation",
            operation: "cancel",
          },
        }),
      ])
    );
    const unknownControl = {
      ...runningControlBinding,
      actionId: "action-unknown",
      operation: "pause",
    };
    assert.throws(() =>
      replayRunEvents([
        ...runningHistory(),
        ...attemptedControl(4, unknownControl),
        event(6, "RUN_CONTROL_OUTCOME_UNKNOWN", { control: unknownControl }),
        event(7, "RUN_CONTROL_CONFIRMED", { control: unknownControl }),
      ])
    );
    assert.throws(() =>
      replayRunEvents([
        ...runningHistory(),
        event(4, "RUN_CONTROL_INTENT_RECORDED", {
          control: { ...unknownControl, workerStartedSequence: 5 },
        }),
        event(5, "WORKER_STARTED"),
        event(6, "RUN_CONTROL_ATTEMPTED", {
          control: { ...unknownControl, workerStartedSequence: 5 },
        }),
        event(7, "RUN_CONTROL_CONFIRMED", {
          control: { ...unknownControl, workerStartedSequence: 5 },
        }),
      ])
    );
    assert.throws(() =>
      replayRunEvents([
        ...runningHistory(),
        event(4, "RUN_CONTROL_INTENT_RECORDED", { control: unknownControl }),
        event(5, "RUN_CONTROL_ATTEMPTED", {
          control: { ...unknownControl, actionBindingDigest: "f".repeat(64) },
        }),
      ])
    );
  });

  it("rejects illegal claimed phases while preserving typed failure history", () => {
    const illegalResume = {
      ...runningControlBinding,
      actionId: "action-illegal-resume",
      operation: "resume",
    };
    const histories = [
      [event(4, "RUN_CONTROL_INTENT_RECORDED", { control: illegalResume })],
      [
        event(4, "RUN_CONTROL_INTENT_RECORDED", { control: illegalResume }),
        event(5, "RUN_CONTROL_ATTEMPTED", { control: illegalResume }),
      ],
      [
        event(4, "RUN_CONTROL_INTENT_RECORDED", { control: illegalResume }),
        event(5, "RUN_CONTROL_ATTEMPTED", { control: illegalResume }),
        event(6, "RUN_CONTROL_OUTCOME_UNKNOWN", { control: illegalResume }),
      ],
    ];

    for (const history of histories) {
      assert.throws(
        () => replayRunEvents([...runningHistory(), ...history]),
        /Resume requires paused state/u
      );
    }

    assert.doesNotThrow(() =>
      replayRunEvents([
        ...runningHistory(),
        event(4, "RUN_CONTROL_FAILED", { control: illegalResume }),
      ])
    );
  });
});
