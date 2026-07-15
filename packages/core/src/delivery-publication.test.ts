import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationFailed,
  DeliveryPublicationIntent,
  DeliveryPublicationOutcomeUnknown,
  encodeDeliveryPublicationJson,
  parseDeliveryPublication,
} from "./delivery-publication.js";

const publicationBase = {
  baseBranch: "main",
  baseRevision: "a".repeat(40),
  branchName: "gaia/run-1234567890",
  commitMessage: "GAIA-100 delivery evidence",
  commitTimestamp: "2026-07-15T10:00:00.000Z",
  digestVersion: 1,
  operationId: "publication:run-1234567890",
  payloadDigest: "b".repeat(64),
  sourcePaths: ["packages/core/src/delivery-publication.ts"],
  treeSha: "c".repeat(40),
} as const;

describe("delivery publication contracts", () => {
  it("round-trips every durable publication state through the schema-owned JSON codec", () => {
    const publications = [
      DeliveryPublicationIntent.make({
        ...publicationBase,
        state: "intentRecorded",
      }),
      DeliveryPublicationAttempted.make({
        ...publicationBase,
        commitSha: "d".repeat(40),
        state: "attempted",
      }),
      DeliveryPublicationConfirmed.make({
        ...publicationBase,
        commitSha: "d".repeat(40),
        draft: true,
        headSha: "d".repeat(40),
        prNumber: 108,
        prUrl: "https://github.com/cill-i-am/gaia/pull/108",
        state: "confirmed",
      }),
      DeliveryPublicationFailed.make({
        ...publicationBase,
        code: "GitHubPublicationFailed",
        message: "Publication failed before remote mutation.",
        recoverable: true,
        state: "failed",
        step: "push",
      }),
      DeliveryPublicationOutcomeUnknown.make({
        ...publicationBase,
        code: "GitHubPublicationOutcomeUnknown",
        message: "Remote outcome could not be reconciled.",
        recoverable: true,
        state: "outcomeUnknown",
        step: "reconciliation",
      }),
    ];

    for (const publication of publications) {
      expect(
        parseDeliveryPublication(encodeDeliveryPublicationJson(publication))
      ).toEqual(publication);
    }
  });

  it.each([
    ["generated source path", { sourcePaths: [".gaia/runs/evidence.json"] }],
    ["non-owned branch", { branchName: "feature/schema-contracts" }],
    ["uppercase commit sha", { baseRevision: "A".repeat(40) }],
    ["non-GitHub pull-request url", { prUrl: "https://example.com/pull/108" }],
  ])("rejects %s at the schema boundary", (_name, patch) => {
    expect(() =>
      DeliveryPublicationConfirmed.make({
        ...publicationBase,
        commitSha: "d".repeat(40),
        draft: true,
        headSha: "d".repeat(40),
        prNumber: 108,
        prUrl: "https://github.com/cill-i-am/gaia/pull/108",
        state: "confirmed",
        ...patch,
      })
    ).toThrow();
  });

  it("rejects extra persisted fields instead of trusting parallel DTOs", () => {
    expect(() =>
      Schema.decodeUnknownSync(DeliveryPublicationIntent)({
        ...publicationBase,
        providerId: "native-comment-104",
        state: "intentRecorded",
      })
    ).toThrow();
  });
});
