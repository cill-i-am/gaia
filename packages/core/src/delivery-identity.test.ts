import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DeliveryActionIdSchema,
  DeliveryBranchNameSchema,
  DeliveryEvidenceIdSchema,
  DeliveryGitObjectIdSchema,
  DeliveryGitShaSchema,
  DeliveryOperationIdSchema,
  DeliveryOwnedBranchNameSchema,
  DeliveryRemoteNameSchema,
  DeliverySha256DigestSchema,
  DeliveryTimestampSchema,
  GitHubCheckIdentity,
  GitHubLoginSchema,
  GitHubPullRequestUrlSchema,
  GitHubRepositorySchema,
  parseDeliveryGitSha,
  parseGitHubRepository,
} from "./delivery-identity.js";

describe("delivery identity schemas", () => {
  it("accepts canonical GitHub delivery identities", () => {
    expect(parseDeliveryGitSha("a".repeat(40))).toBe("a".repeat(40));
    expect(parseGitHubRepository("cill-i-am/gaia")).toBe("cill-i-am/gaia");
    expect(() =>
      Schema.decodeUnknownSync(DeliveryOwnedBranchNameSchema)(
        "gaia/gaia-93-smoke-head-abc123"
      )
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(GitHubPullRequestUrlSchema)(
        "https://github.com/cill-i-am/gaia/pull/108"
      )
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(GitHubCheckIdentity)({
        appSlug: "github-actions",
        name: "test",
        repository: "cill-i-am/gaia",
        workflow: "CI",
      })
    ).not.toThrow();
  });

  it.each([
    [DeliveryGitShaSchema, "A".repeat(40)],
    [DeliveryGitObjectIdSchema, "abc"],
    [DeliveryBranchNameSchema, "../main"],
    [DeliveryOwnedBranchNameSchema, "feature/schema-contracts"],
    [DeliveryOwnedBranchNameSchema, "gaia"],
    [DeliveryRemoteNameSchema, "origin/main"],
    [GitHubRepositorySchema, "not-a-repository"],
    [GitHubLoginSchema, "-bad"],
    [GitHubPullRequestUrlSchema, "https://example.com/cill-i-am/gaia/pull/1"],
    [DeliveryOperationIdSchema, "bad operation"],
    [DeliveryActionIdSchema, "bad action"],
    [DeliverySha256DigestSchema, "f".repeat(63)],
    [DeliveryTimestampSchema, "2026-07-15T03:00:00Z"],
    [DeliveryEvidenceIdSchema, "reviewerIdentity"],
  ])("rejects invalid %s values", (schema, value) => {
    expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow();
  });
});
