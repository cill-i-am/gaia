import type { LocalRunSummaryDto } from "@gaia/core";
import { RunIdSchema, makeRunEvent } from "@gaia/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { buildEvidenceProvenanceModel } from "@/provenance-model";
import {
  buildRunCanvasModel,
  buildRunReplayState,
  eventsForNode,
} from "@/run-canvas-model";
import { buildRunCompareModel } from "@/run-compare-model";

describe("evidence provenance model", () => {
  it("maps visible run and node claims to public source events and artifacts", () => {
    const runId = parseRunId("run-7777777777");
    const events = [
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
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        runId,
        sequence: 3,
        timestamp: "2026-07-07T12:02:00.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        runId,
        sequence: 4,
        timestamp: "2026-07-07T12:03:00.000Z",
        type: "REPORT_COMPLETED",
      }),
    ];
    const run = buildRunCanvasModel({
      run: localRunSummary({
        artifacts: [
          "input",
          "worker-plan",
          "worker-result",
          "verification-result",
          "report",
          "report-json",
        ],
        eventCount: 4,
        runId,
        status: "completed",
        state: "completed",
      }),
      events,
    });
    const replayState = buildRunReplayState({ requestedIndex: 3, run });
    const selectedNode = requiredNode(run, "lane:worker");
    const provenance = buildEvidenceProvenanceModel({
      relatedEvents: eventsForNode(run, selectedNode),
      replayState,
      runCompare: buildRunCompareModel({
        comparisonEvents: events,
        comparisonRun: localRunSummary({
          runId: parseRunId("run-8888888888"),
        }),
        primaryEvents: events,
        primaryRun: localRunSummary({ runId }),
      }),
      selectedNode,
      selectedRun: run,
    });

    expect(provenance.supportedCount).toBeGreaterThan(0);
    expect(
      provenance.claims.find((claim) => claim.id === "node-status:lane:worker")
    ).toEqual(
      expect.objectContaining({
        availability: "supported",
        label: "Node status",
        value: "complete",
      })
    );
    expect(
      provenance.claims.find(
        (claim) => claim.id === "artifact-count:lane:worker"
      )?.sources
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact",
          target: { artifactId: "worker-plan", type: "artifact" },
        }),
      ])
    );
    expect(
      provenance.claims.find((claim) => claim.id === "report-signal")
    ).toEqual(
      expect.objectContaining({
        availability: "supported",
        value: "Available",
      })
    );
    expect(
      provenance.claims
        .find((claim) => claim.id === "report-signal")
        ?.sources.some((source) => source.kind === "event")
    ).toBe(true);
  });

  it("labels unavailable and unsupported claims honestly", () => {
    const run = buildRunCanvasModel({
      events: [],
      run: localRunSummary({
        artifacts: [],
        eventCount: 0,
        runId: parseRunId("run-9999999999"),
        status: "running",
        state: "created",
      }),
    });
    const replayState = buildRunReplayState({ requestedIndex: undefined, run });
    const selectedNode = requiredNode(run, "relationship:thread-identity");
    const provenance = buildEvidenceProvenanceModel({
      relatedEvents: eventsForNode(run, selectedNode),
      replayState,
      runCompare: buildRunCompareModel({
        comparisonEvents: [],
        comparisonRun: undefined,
        primaryEvents: [],
        primaryRun: undefined,
      }),
      selectedNode,
      selectedRun: run,
    });

    expect(
      provenance.claims.find(
        (claim) => claim.id === "event-count:relationship:thread-identity"
      )
    ).toEqual(
      expect.objectContaining({
        availability: "unavailable",
        value: "0 related / 0 loaded",
      })
    );
    expect(
      provenance.claims.find((claim) => claim.id === "thread-identity")
    ).toEqual(
      expect.objectContaining({
        availability: "unsupported",
        value: "Unsupported by current public API",
      })
    );
    expect(provenance.unavailableCount).toBeGreaterThan(0);
    expect(provenance.unsupportedCount).toBe(1);
  });
});

function localRunSummary(
  input: Partial<typeof LocalRunSummaryDto.Type> & {
    readonly runId: typeof LocalRunSummaryDto.Type.runId;
  }
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

function requiredNode(
  run: ReturnType<typeof buildRunCanvasModel>,
  nodeId: string
) {
  const node = run.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    throw new Error(`Expected node ${nodeId}.`);
  }

  return node;
}
