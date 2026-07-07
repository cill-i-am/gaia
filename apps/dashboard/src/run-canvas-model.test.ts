import type { LocalRunSummaryDto } from "@gaia/core";
import { RunIdSchema, makeRunEvent } from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildRunCanvasModel,
  buildRunReplayState,
} from "@/run-canvas-model";

describe("run canvas model", () => {
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
        "event:1:RUN_CREATED",
        "event:5:REPORT_COMPLETED",
        "artifact:input",
        "artifact:report-json",
      ]),
    );
    expect(model.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "then",
          source: "event:1:RUN_CREATED",
          target: "event:2:WORKER_STARTED",
        }),
        expect.objectContaining({
          label: "evidence",
          source: "event:5:REPORT_COMPLETED",
          target: "artifact:report-json",
        }),
      ]),
    );
    expect(
      model.nodes.find((node) => node.id === "relationship:thread-identity")
        ?.summary,
    ).toContain("not Codex thread IDs");
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
    expect(replayState.activeEventId).toBe("event:2:WORKER_STARTED");
    expect(replayState.visibleEventIds).toEqual([
      "event:1:RUN_CREATED",
      "event:2:WORKER_STARTED",
    ]);
    expect(replayState.futureEventIds).toEqual([
      "event:3:WORKER_COMPLETED",
    ]);
    expect(replayState.visibleArtifactIds).toEqual([
      "input",
      "worker-plan",
    ]);
    expect(Math.round(replayState.progressPercent)).toBe(50);
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
        .activeSequence,
    ).toBe(2);
    expect(
      buildRunReplayState({ requestedIndex: -99, run: model }).activeSequence,
    ).toBe(1);
    expect(
      buildRunReplayState({ requestedIndex: 99, run: model }).activeSequence,
    ).toBe(2);
  });
});

function localRunSummary(
  input: Partial<typeof LocalRunSummaryDto.Type> & {
    readonly runId: typeof LocalRunSummaryDto.Type.runId;
  },
): typeof LocalRunSummaryDto.Type {
  return {
    artifacts: ["input"],
    createdAt: "2026-07-07T12:00:00.000Z",
    eventCount: 1,
    latestEventType: "RUN_CREATED",
    state: "created",
    status: "running",
    updatedAt: "2026-07-07T12:00:00.000Z",
    ...input,
  };
}

function parseRunId(value: string): typeof RunIdSchema.Type {
  return Schema.decodeUnknownSync(RunIdSchema)(value);
}
