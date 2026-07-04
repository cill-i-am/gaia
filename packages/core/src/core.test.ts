import { assert, describe, it } from "@effect/vitest";
import {
  makeRunEvent,
  parseMarkdownSpec,
  parseRunId,
  replayRunEvents,
  snapshotFromReplay,
} from "./index.js";

describe("core contracts", () => {
  it("parses branded run ids", () => {
    assert.strictEqual(parseRunId("run-V7kP9sQ2xY"), "run-V7kP9sQ2xY");
    assert.throws(() => parseRunId("not-a-run"));
  });

  it("parses markdown specs with frontmatter", () => {
    const spec = parseMarkdownSpec(
      "---\ntitle: Smoke test\n---\n\nDo the smallest thing.",
      "fallback",
    );

    assert.strictEqual(spec.title, "Smoke test");
    assert.strictEqual(spec.body, "Do the smallest thing.");
  });

  it("replays the durable event log to the current state", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 1,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:01.000Z",
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId,
        sequence: 3,
        timestamp: "2026-07-04T10:00:02.000Z",
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: { verificationResultPath: "verification-result.json" },
        runId,
        sequence: 4,
        timestamp: "2026-07-04T10:00:03.000Z",
        type: "VERIFICATION_COMPLETED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId,
        sequence: 5,
        timestamp: "2026-07-04T10:00:04.000Z",
        type: "REPORT_COMPLETED",
      }),
    ];

    const snapshot = replayRunEvents(events);
    assert.strictEqual(snapshot.value, "completed");

    const durableSnapshot = snapshotFromReplay(events);
    assert.strictEqual(durableSnapshot.state, "completed");
    assert.strictEqual(durableSnapshot.eventSequence, 5);
  });

  it("rejects out-of-order event logs", () => {
    const runId = parseRunId("run-V7kP9sQ2xY");
    const events = [
      makeRunEvent({
        payload: { specPath: "input.md" },
        runId,
        sequence: 2,
        timestamp: "2026-07-04T10:00:00.000Z",
        type: "RUN_CREATED",
      }),
    ];

    assert.throws(() => replayRunEvents(events));
  });
});

