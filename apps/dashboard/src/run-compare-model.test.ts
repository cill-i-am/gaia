import type { LocalRunSummaryDto } from "@gaia/core";
import {
  LocalRunReadSummarySchema,
  RunIdSchema,
  makeRunEvent,
  parseLocalRunTimestamp,
} from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  RunCompareModelSchema,
  buildRunCompareModel,
} from "@/run-compare-model";

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
      "worker environment epoch equivalence refused because comparable evidence is unavailable",
    ]);
    expect(model.missingData).toEqual(["Primary run unavailable"]);
    expect(model.summary).toBe("Choose two local runs to compare.");
  });

  it("equates only matching complete worker environment epochs", () => {
    const primaryRunId = parseRunId("run-5555555555");
    const comparisonRunId = parseRunId("run-6666666666");
    const complete = {
      limitations: ["providerNativeToolInventoryNotExposed"],
      state: "completeComparable",
      structuralDigest: "a".repeat(64),
      version: 1,
    } as const;
    const compare = (
      primaryEpoch: typeof complete,
      comparisonEpoch:
        | typeof complete
        | {
            readonly limitations: readonly ["authoritativeReceiptMissing"];
            readonly state: "incomplete";
            readonly version: 1;
          }
    ) =>
      buildRunCompareModel({
        comparisonEvents: [],
        comparisonRun: localRunSummary({
          runId: comparisonRunId,
          workerEnvironmentEpoch: comparisonEpoch,
        }),
        primaryEvents: [],
        primaryRun: localRunSummary({
          runId: primaryRunId,
          workerEnvironmentEpoch: primaryEpoch,
        }),
      }).metrics.find(({ label }) => label === "Worker environment");

    expect(compare(complete, complete)?.isDifferent).toBe(false);
    expect(
      compare(complete, {
        ...complete,
        structuralDigest: "b".repeat(64),
      })?.isDifferent
    ).toBe(true);
    expect(
      compare(complete, {
        limitations: ["authoritativeReceiptMissing"],
        state: "incomplete",
        version: 1,
      })?.isDifferent
    ).toBe(true);
  });

  it.each([
    [
      undefined,
      "Worker environment epoch equivalence refused: evidence is missing.",
    ],
    [
      {
        limitations: ["authoritativeReceiptMissing"],
        state: "incomplete",
        version: 1,
      },
      "Worker environment epoch equivalence refused: evidence is incomplete.",
    ],
    [
      {
        limitations: ["providerNativeToolInventoryRequired"],
        state: "nonComparable",
        version: 1,
      },
      "Worker environment epoch equivalence refused: policy marks evidence non-comparable.",
    ],
  ] as const)(
    "visibly refuses epoch equivalence for %j public evidence",
    (workerEnvironmentEpoch, refusal) => {
      const primaryRunId = parseRunId("run-7777777777");
      const comparisonRunId = parseRunId("run-8888888888");
      const model = buildRunCompareModel({
        comparisonEvents: [],
        comparisonRun: localRunSummary({
          runId: comparisonRunId,
          ...(workerEnvironmentEpoch === undefined
            ? {}
            : { workerEnvironmentEpoch }),
        }),
        primaryEvents: [],
        primaryRun: localRunSummary({
          runId: primaryRunId,
          ...(workerEnvironmentEpoch === undefined
            ? {}
            : { workerEnvironmentEpoch }),
        }),
      });

      expect(model.missingData).toContain(refusal);
      expect(model.summary).toContain(refusal);
      expect(model.summary).not.toBe(
        "No key differences detected in public run data."
      );
    }
  );

  it.each([
    ["verified", "available"],
    ["completed-unverified", "blocked"],
    ["verification-failed", "failed"],
    ["awaiting-outcome-decision", "blocked"],
  ] as const)("renders %s as known proof state %s", (proofAggregate, state) => {
    const runId = parseRunId("run-4444444444");
    const run = localRunSummary({ proofAggregate, runId });
    const model = buildRunCompareModel({
      comparisonEvents: [],
      comparisonRun: run,
      primaryEvents: [],
      primaryRun: run,
    });

    expect(model.primary?.checkSignal).toEqual({
      label: `Run proof: ${proofAggregate}`,
      state,
    });
    expect(model.primary?.missingData).not.toContain(
      "check outcome unavailable"
    );
  });
});

function localRunSummary(
  input: typeof LocalRunSummaryFixtureInputSchema.Encoded
): typeof LocalRunSummaryDto.Type {
  return Schema.decodeUnknownSync(LocalRunReadSummarySchema)({
    artifacts: ["input"],
    createdAt: parseLocalRunTimestamp("2026-07-07T12:00:00.000Z"),
    eventCount: 1,
    latestEventType: "RUN_CREATED",
    modelInvocationArtifacts: [],
    state: "created",
    status: "running",
    updatedAt: parseLocalRunTimestamp("2026-07-07T12:00:00.000Z"),
    ...input,
  });
}

function parseRunId(value: string): typeof RunIdSchema.Type {
  return Schema.decodeUnknownSync(RunIdSchema)(value);
}
