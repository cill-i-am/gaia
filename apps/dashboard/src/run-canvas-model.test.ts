import {
  LocalRunReadSummarySchema,
  RunIdSchema,
  makeRunEvent,
} from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DashboardRunSchema,
  RunReplayStateSchema,
  buildRunCanvasModel,
  buildRunReplayState,
  isTerminalRunEvent,
} from "@/run-canvas-model";

const LocalRunSummaryFixtureInputSchema = Schema.Struct({
  ...LocalRunReadSummarySchema.fields,
  artifacts: Schema.optionalKey(LocalRunReadSummarySchema.fields.artifacts),
  createdAt: Schema.optionalKey(LocalRunReadSummarySchema.fields.createdAt),
  eventCount: Schema.optionalKey(LocalRunReadSummarySchema.fields.eventCount),
  latestEventType: Schema.optionalKey(
    LocalRunReadSummarySchema.fields.latestEventType
  ),
  modelInvocationArtifacts: Schema.optionalKey(
    LocalRunReadSummarySchema.fields.modelInvocationArtifacts
  ),
  state: Schema.optionalKey(LocalRunReadSummarySchema.fields.state),
  status: Schema.optionalKey(LocalRunReadSummarySchema.fields.status),
  updatedAt: Schema.optionalKey(LocalRunReadSummarySchema.fields.updatedAt),
});

describe("run canvas model", () => {
  it("preserves cancelled as a terminal non-running canvas status", () => {
    const runId = parseRunId("run-cancelled1");
    const model = buildRunCanvasModel({
      events: [
        makeRunEvent({
          runId,
          sequence: 1,
          timestamp: "2026-07-22T16:00:00.000Z",
          type: "WORKER_STARTED",
        }),
      ],
      run: localRunSummary({
        artifacts: [],
        eventCount: 4,
        runId,
        state: "cancelled",
        status: "cancelled",
      }),
    });

    expect(model.status).toBe("cancelled");
    expect(model.nodes.find((node) => node.id === `run:${runId}`)?.status).toBe(
      "cancelled"
    );
    expect(model.nodes.find((node) => node.id === "lane:worker")?.status).toBe(
      "cancelled"
    );
    expect(Schema.decodeUnknownSync(DashboardRunSchema)(model)).toEqual(model);
  });

  it("treats only a confirmed cancel control event as terminal", () => {
    const runId = parseRunId("run-control148");
    const control = {
      actionBindingDigest: "a".repeat(64),
      actionId: "action-control",
      authorityId: "authority-local",
      expectedEventSequence: 4,
      operation: "cancel" as const,
      providerId: "fake",
      sessionId: "session-control",
      workerAgentId: "agent-worker",
      workerStartedSequence: 3,
    };
    const controlEvent = (
      type: Parameters<typeof makeRunEvent>[0]["type"],
      operation:
        | typeof control.operation
        | "pause"
        | "resume"
        | "resolveInteraction"
    ) =>
      makeRunEvent({
        payload: { control: { ...control, operation } },
        runId,
        sequence: 4,
        timestamp: "2026-07-22T16:00:00.000Z",
        type,
      });

    expect(
      isTerminalRunEvent(controlEvent("RUN_CONTROL_CONFIRMED", "cancel"))
    ).toBe(true);
    for (const operation of [
      "resolveInteraction",
      "pause",
      "resume",
    ] as const) {
      expect(
        isTerminalRunEvent(controlEvent("RUN_CONTROL_CONFIRMED", operation))
      ).toBe(false);
    }
    for (const type of [
      "RUN_CONTROL_INTENT_RECORDED",
      "RUN_CONTROL_ATTEMPTED",
      "RUN_CONTROL_FAILED",
      "RUN_CONTROL_OUTCOME_UNKNOWN",
    ] as const) {
      expect(isTerminalRunEvent(controlEvent(type, "cancel"))).toBe(false);
    }
  });

  it("derives a run graph from ordered events and exposed artifacts", () => {
    const runId = parseRunId("run-1234567890");
    const model = buildRunCanvasModel({
      run: localRunSummary({
        artifacts: [
          "input",
          "worker-plan",
          "worker-log",
          "worker-result",
          "plan-review",
          "evidence-review",
          "verification-result",
          "report",
          "report-json",
          "events",
        ],
        eventCount: 8,
        runId,
        status: "completed",
        state: "completed",
      }),
      events: [
        makeRunEvent({
          payload: { specPath: "input.md" },
          runId,
          sequence: 1,
          timestamp: "2026-07-07T12:00:00.000Z",
          type: "RUN_CREATED",
        }),
        makeRunEvent({
          runId,
          sequence: 2,
          timestamp: "2026-07-07T12:01:00.000Z",
          type: "WORKER_STARTED",
        }),
        makeRunEvent({
          payload: { workerResultPath: "worker-result.md" },
          runId,
          sequence: 3,
          timestamp: "2026-07-07T12:02:00.000Z",
          type: "WORKER_COMPLETED",
        }),
        makeRunEvent({
          payload: { phase: "plan", reviewPath: "plan-review.md" },
          runId,
          sequence: 4,
          timestamp: "2026-07-07T12:03:00.000Z",
          type: "REVIEW_COMPLETED",
        }),
        makeRunEvent({
          payload: { reportPath: "report.md" },
          runId,
          sequence: 5,
          timestamp: "2026-07-07T12:04:00.000Z",
          type: "REPORT_COMPLETED",
        }),
      ],
    });

    expect(model.id).toBe("run-1234567890");
    expect(model.status).toBe("complete");
    expect(model.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "run:run-1234567890",
        "lane:spec",
        "lane:worker",
        "lane:reviewer",
        "relationship:thread-identity",
        "event:1:RUN_CREATED:2026-07-07T12:00:00.000Z",
        "event:5:REPORT_COMPLETED:2026-07-07T12:04:00.000Z",
        "artifact:input",
        "artifact:report-json",
      ])
    );
    expect(model.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "then",
          source: "event:1:RUN_CREATED:2026-07-07T12:00:00.000Z",
          target: "event:2:WORKER_STARTED:2026-07-07T12:01:00.000Z",
        }),
        expect.objectContaining({
          label: "evidence",
          source: "event:5:REPORT_COMPLETED:2026-07-07T12:04:00.000Z",
          target: "artifact:report-json",
        }),
      ])
    );
    expect(
      model.nodes.find((node) => node.id === "relationship:thread-identity")
        ?.summary
    ).toContain("not Codex thread IDs");
    expect(Schema.decodeUnknownSync(DashboardRunSchema)(model)).toEqual(model);
  });

  it("keeps sparse run data honest instead of inventing worker or reviewer relationships", () => {
    const model = buildRunCanvasModel({
      events: [],
      run: localRunSummary({
        artifacts: [],
        eventCount: 0,
        runId: parseRunId("run-abcdefghij"),
        status: "running",
        state: "created",
      }),
    });

    expect(model.status).toBe("running");
    expect(model.nodes.map((node) => node.id)).toEqual([
      "run:run-abcdefghij",
      "relationship:thread-identity",
    ]);
    expect(model.edges).toEqual([
      expect.objectContaining({
        label: "unavailable",
        source: "run:run-abcdefghij",
        target: "relationship:thread-identity",
      }),
    ]);
  });

  it("labels a legacy no-contract verification artifact as unverified", () => {
    const runId = parseRunId("run-legacyart1");
    const model = buildRunCanvasModel({
      events: [
        makeRunEvent({
          payload: { specPath: "input.md" },
          runId,
          sequence: 1,
          timestamp: "2026-07-07T12:00:00.000Z",
          type: "RUN_CREATED",
        }),
        makeRunEvent({
          payload: { verificationResultPath: "verification-result.json" },
          runId,
          sequence: 2,
          timestamp: "2026-07-07T12:01:00.000Z",
          type: "VERIFICATION_COMPLETED",
        }),
      ],
      run: localRunSummary({
        artifacts: ["verification-result"],
        eventCount: 2,
        proofAggregate: "completed-unverified",
        runId,
      }),
    });

    expect(
      model.nodes.find((node) => node.id === "artifact:verification-result")
        ?.label
    ).toBe("Legacy Verification Artifact (Unverified)");
  });

  it("returns an empty canvas when no selected run is available", () => {
    const model = buildRunCanvasModel({
      events: [],
      run: undefined,
    });

    expect(model.nodes).toEqual([]);
    expect(model.events).toEqual([]);
    expect(model.title).toBe("No local run selected");
  });

  it("derives replay state from ordered dashboard events", () => {
    const runId = parseRunId("run-3333333333");
    const model = buildRunCanvasModel({
      run: localRunSummary({
        eventCount: 3,
        runId,
      }),
      events: [
        makeRunEvent({
          runId,
          sequence: 1,
          timestamp: "2026-07-07T12:00:00.000Z",
          type: "RUN_CREATED",
        }),
        makeRunEvent({
          runId,
          sequence: 2,
          timestamp: "2026-07-07T12:01:00.000Z",
          type: "WORKER_STARTED",
        }),
        makeRunEvent({
          runId,
          sequence: 3,
          timestamp: "2026-07-07T12:02:00.000Z",
          type: "WORKER_COMPLETED",
        }),
      ],
    });

    const replayState = buildRunReplayState({
      requestedIndex: 1,
      run: model,
    });

    expect(replayState.currentStep?.label).toBe("2: Worker Started");
    expect(replayState.activeEventId).toBe(
      "event:2:WORKER_STARTED:2026-07-07T12:01:00.000Z"
    );
    expect(replayState.visibleEventIds).toEqual([
      "event:1:RUN_CREATED:2026-07-07T12:00:00.000Z",
      "event:2:WORKER_STARTED:2026-07-07T12:01:00.000Z",
    ]);
    expect(replayState.futureEventIds).toEqual([
      "event:3:WORKER_COMPLETED:2026-07-07T12:02:00.000Z",
    ]);
    expect(replayState.visibleArtifactIds).toEqual(["input", "worker-plan"]);
    expect(Math.round(replayState.progressPercent)).toBe(50);
    expect(Schema.decodeUnknownSync(RunReplayStateSchema)(replayState)).toEqual(
      replayState
    );
  });

  it("defaults replay to the latest event and clamps requested positions", () => {
    const runId = parseRunId("run-4444444444");
    const model = buildRunCanvasModel({
      run: localRunSummary({
        eventCount: 2,
        runId,
      }),
      events: [
        makeRunEvent({
          runId,
          sequence: 1,
          timestamp: "2026-07-07T12:00:00.000Z",
          type: "RUN_CREATED",
        }),
        makeRunEvent({
          runId,
          sequence: 2,
          timestamp: "2026-07-07T12:01:00.000Z",
          type: "REPORT_COMPLETED",
        }),
      ],
    });

    expect(
      buildRunReplayState({ requestedIndex: undefined, run: model })
        .activeSequence
    ).toBe(2);
    expect(
      buildRunReplayState({ requestedIndex: -99, run: model }).activeSequence
    ).toBe(1);
    expect(
      buildRunReplayState({ requestedIndex: 99, run: model }).activeSequence
    ).toBe(2);
  });
});

function localRunSummary(
  input: typeof LocalRunSummaryFixtureInputSchema.Encoded
): typeof LocalRunReadSummarySchema.Type {
  return Schema.decodeUnknownSync(LocalRunReadSummarySchema)({
    artifacts: ["input"],
    createdAt: "2026-07-07T12:00:00.000Z",
    eventCount: 1,
    latestEventType: "RUN_CREATED",
    modelInvocationArtifacts: [],
    state: "created",
    status: "running",
    updatedAt: "2026-07-07T12:00:00.000Z",
    ...input,
  });
}

function parseRunId(value: string): typeof RunIdSchema.Type {
  return Schema.decodeUnknownSync(RunIdSchema)(value);
}
