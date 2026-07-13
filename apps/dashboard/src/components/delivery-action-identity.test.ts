import { describe, expect, it } from "vitest";

import {
  createReadinessActionId,
  mergeDecisionIdentity,
} from "./delivery-action-identity";

describe("delivery action identity", () => {
  it("creates a fresh readiness action ID for every deliberate evaluation", () => {
    const first = createReadinessActionId();
    const second = createReadinessActionId();

    expect(first).not.toBe(second);
    expect(first).toMatch(/^readiness-/u);
    expect(second).toMatch(/^readiness-/u);
  });

  it("keys merge identity to the authoritative readiness decision", () => {
    const first = mergeDecisionIdentity({
      payloadDigest: "a".repeat(64),
      sequence: 6,
    });
    const replay = mergeDecisionIdentity({
      payloadDigest: "a".repeat(64),
      sequence: 6,
    });
    const newer = mergeDecisionIdentity({
      payloadDigest: "b".repeat(64),
      sequence: 9,
    });

    expect(replay).toBe(first);
    expect(newer).not.toBe(first);
    expect(first).toBe(`merge-${"a".repeat(64)}-6`);
  });
});
