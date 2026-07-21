import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeAcceptedRunInputCheckpointV1,
  AcceptedRunInputCheckpointRefV1,
  makeAcceptedRunInputCheckpointRefV1,
  parseAcceptedRunInputCheckpoint,
  parseAcceptedRunInputCheckpointRef,
  resolveAcceptedRunInputCheckpoint,
} from "./accepted-run-input.js";
import { makeRunEvent } from "./events.js";
import { parseRunId } from "./run-id.js";

const runId = parseRunId("run-1234567890");
const payload = {
  acceptanceKind: "server" as const,
  acceptedSemantics: {
    adapter: { kind: "fake" },
    profile: { browserEvidence: "optional", name: "default" },
  },
  runId,
  spec: {
    body: "Implement the accepted slice. 🚀",
    bodyDigest:
      "644aa9617899f01b66064f0fb91ce24dcd9ca79321c918f38f05f697f52d03e2",
    byteLength: 34,
    title: "Accepted slice",
  },
  version: 1 as const,
};

describe("accepted run input checkpoint", () => {
  it("derives a stable non-circular checkpoint digest and id", () => {
    const checkpoint = makeAcceptedRunInputCheckpointV1(payload);
    expect(checkpoint.checkpointDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(checkpoint.checkpointId).toBe(
      `arin1_${checkpoint.checkpointDigest}`
    );
    expect(parseAcceptedRunInputCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("rejects mutation, excess properties, and wrong self-authentication", () => {
    const checkpoint = makeAcceptedRunInputCheckpointV1(payload);
    expect(() =>
      parseAcceptedRunInputCheckpoint({
        ...checkpoint,
        checkpointDigest: "0".repeat(64),
      })
    ).toThrow();
    expect(() =>
      parseAcceptedRunInputCheckpoint({ ...checkpoint, extra: true })
    ).toThrow();
    expect(() =>
      parseAcceptedRunInputCheckpoint({
        ...checkpoint,
        payload: { ...checkpoint.payload, runId: "run-abcdefghij" },
      })
    ).toThrow();
  });

  it("strictly binds the canonical body reference", () => {
    const checkpoint = makeAcceptedRunInputCheckpointV1(payload);
    const ref = makeAcceptedRunInputCheckpointRefV1({
      bodyDigest: "b".repeat(64),
      byteLength: 123,
      checkpoint,
    });
    expect(parseAcceptedRunInputCheckpointRef(ref)).toEqual(ref);
    expect(() =>
      parseAcceptedRunInputCheckpointRef({ ...ref, path: "../secret" })
    ).toThrow();
  });

  it("uses RUN_CREATED as the only checkpoint authority and keeps legacy absence", () => {
    const checkpoint = makeAcceptedRunInputCheckpointV1(payload);
    const ref = makeAcceptedRunInputCheckpointRefV1({
      bodyDigest: "b".repeat(64),
      byteLength: 123,
      checkpoint,
    });
    const legacy = makeRunEvent({
      payload: { source: "server" },
      runId,
      sequence: 1,
      timestamp: "2026-07-21T00:00:00.000Z",
      type: "RUN_CREATED",
    });
    expect(resolveAcceptedRunInputCheckpoint([legacy])).toEqual({
      kind: "legacyAbsent",
    });
    const marked = makeRunEvent({
      payload: {
        acceptedInputCheckpoint: Schema.encodeSync(
          AcceptedRunInputCheckpointRefV1
        )(ref),
        source: "server",
      },
      runId,
      sequence: 1,
      timestamp: "2026-07-21T00:00:00.000Z",
      type: "RUN_CREATED",
    });
    expect(resolveAcceptedRunInputCheckpoint([marked])).toEqual({
      kind: "v1",
      ref,
    });
  });
});
