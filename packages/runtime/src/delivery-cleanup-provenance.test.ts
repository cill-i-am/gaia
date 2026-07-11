import { describe, expect, it } from "vitest";
import { DeliveryCleanupOwnershipProvenanceV1, DeliveryCleanupResourceCheckpointV1, deliveryCleanupOwnershipPayloadDigest, deriveCleanupResourceProofs, parseDeliveryCleanupOwnershipProvenance } from "./delivery-cleanup-provenance.js";

describe("private delivery cleanup provenance", () => {
  it("binds every private ownership field into one immutable digest", () => {
    const base = { actionId: "cleanup-1", branchRef: "refs/heads/gaia/run-1234567890", expectedBranchOid: "a".repeat(40), mergeCommitSha: "b".repeat(40), ownershipDigest: "c".repeat(64), ownershipToken: "private-token", repositoryCommonDir: "/private/repo/.git", repositoryRoot: "/private/repo", runId: "run-1234567890", version: 1 as const, worktreeCommonDir: "/private/repo/.git", worktreePath: "/private/run/workspace" };
    const payloadDigest = deliveryCleanupOwnershipPayloadDigest(base);
    const parsed = parseDeliveryCleanupOwnershipProvenance({ ...base, payloadDigest });
    expect(parsed).toBeInstanceOf(DeliveryCleanupOwnershipProvenanceV1);
    expect(deliveryCleanupOwnershipPayloadDigest({ ...base, ownershipToken: "other-token" })).not.toBe(payloadDigest);
  });

  it("does not equate removal attempts with proven absence", () => {
    const checkpoint = (resource: "branch" | "worktree", state: "absenceProven" | "inspectedPresent" | "removalAttempted") => DeliveryCleanupResourceCheckpointV1.make({ actionId: "cleanup-1", payloadDigest: "a".repeat(64), resource, state, version: 1 });
    expect(deriveCleanupResourceProofs([checkpoint("worktree", "removalAttempted")])).toEqual({ branch: false, worktree: false });
    expect(deriveCleanupResourceProofs([checkpoint("worktree", "absenceProven"), checkpoint("branch", "absenceProven")])).toEqual({ branch: true, worktree: true });
  });
});
