import type { LocalRunSummaryDto } from "@gaia/core";
import { RunIdSchema, makeRunEvent, parseLocalRunTimestamp } from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  RunCompareModelSchema,
  buildRunCompareModel,
} from "@/run-compare-model";

describe("run compare model", () => {
  it("compares public run dimensions and artifact availability", () => {
    const primaryRunId = parseRunId("run-1111111111");
    const comparisonRunId = parseRunId("run-2222222222");
    const model = buildRunCompareModel({
      comparisonEvents: [
        makeRunEvent({
          runId: comparisonRunId,
          sequence: 1,
          timestamp: "2026-07-07T12:00:00.000Z",
          type: "RUN_CREATED",
        }),
        makeRunEvent({
          payload: { failure: { message: "Harness failed", stage: "worker" } },
          runId: comparisonRunId,
          sequence: 2,
          timestamp: "2026-07-07T12:04:00.000Z",
          type: "RUN_FAILED",
        }),
      ],
      comparisonRun: localRunSummary({
        artifacts: ["input", "worker-log"],
        eventCount: 2,
        latestEventType: "RUN_FAILED",
        runId: comparisonRunId,
        state: "failed",
        status: "failed",
        updatedAt: parseLocalRunTimestamp("2026-07-07T12:04:00.000Z"),
      }),
      primaryEvents: [
        makeRunEvent({
          runId: primaryRunId,
          sequence: 1,
          timestamp: "2026-07-07T12:00:00.000Z",
          type: "RUN_CREATED",
        }),
        makeRunEvent({
          runId: primaryRunId,
          sequence: 2,
          timestamp: "2026-07-07T12:01:00.000Z",
          type: "WORKER_COMPLETED",
        }),
        makeRunEvent({
          payload: { phase: "evidence" },
          runId: primaryRunId,
          sequence: 3,
          timestamp: "2026-07-07T12:02:00.000Z",
          type: "REVIEW_COMPLETED",
        }),
        makeRunEvent({
          runId: primaryRunId,
          sequence: 4,
          timestamp: "2026-07-07T12:03:00.000Z",
          type: "VERIFICATION_COMPLETED",
        }),
        makeRunEvent({
          runId: primaryRunId,
          sequence: 5,
          timestamp: "2026-07-07T12:05:00.000Z",
          type: "REPORT_COMPLETED",
        }),
      ],
      primaryRun: localRunSummary({
        artifacts: [
          "input",
          "worker-result",
          "evidence-review",
          "verification-result",
          "report",
          "report-json",
        ],
        eventCount: 5,
        latestEventType: "REPORT_COMPLETED",
        runId: primaryRunId,
        state: "completed",
        status: "completed",
        updatedAt: parseLocalRunTimestamp("2026-07-07T12:05:00.000Z"),
      }),
    });

    expect(model.primary?.statusLabel).toBe("Completed");
    expect(model.comparison?.reportSignal.label).toBe("Run failed");
    expect(model.metrics.find((metric) => metric.label === "Status")).toEqual(
      expect.objectContaining({
        comparisonValue: "Failed",
        isDifferent: true,
        primaryValue: "Completed",
      })
    );
    expect(model.artifactDelta).toEqual({
      comparisonOnly: ["worker-log"],
      primaryOnly: [
        "worker-result",
        "evidence-review",
        "verification-result",
        "report",
        "report-json",
      ],
      shared: ["input"],
    });
    expect(model.summary).toContain("key differences");
    expect(Schema.decodeUnknownSync(RunCompareModelSchema)(model)).toEqual(
      model
    );
  });

  it("keeps missing comparison data explicit", () => {
    const runId = parseRunId("run-3333333333");
    const model = buildRunCompareModel({
      comparisonEvents: [],
      comparisonRun: localRunSummary({
        artifacts: [],
        eventCount: 3,
        runId,
        updatedAt: parseLocalRunTimestamp("2026-07-07T11:59:00.000Z"),
      }),
      primaryEvents: [],
      primaryRun: undefined,
    });

    expect(model.primary).toBeUndefined();
    expect(model.comparison?.missingData).toEqual([
      "ordered events unavailable",
      "no artifacts exposed",
      "report outcome unavailable",
      "check outcome unavailable",
      "review outcome unavailable",
      "duration unavailable",
    ]);
    expect(model.missingData).toEqual(["Primary run unavailable"]);
    expect(model.summary).toBe("Choose two local runs to compare.");
  });
});

function localRunSummary(
  input: Partial<typeof LocalRunSummaryDto.Type> & {
    readonly runId: typeof LocalRunSummaryDto.Type.runId;
  }
): typeof LocalRunSummaryDto.Type {
  return {
    artifacts: ["input"],
    createdAt: parseLocalRunTimestamp("2026-07-07T12:00:00.000Z"),
    eventCount: 1,
    latestEventType: "RUN_CREATED",
    state: "created",
    status: "running",
    updatedAt: parseLocalRunTimestamp("2026-07-07T12:00:00.000Z"),
    ...input,
  };
}

function parseRunId(value: string): typeof RunIdSchema.Type {
  return Schema.decodeUnknownSync(RunIdSchema)(value);
}
