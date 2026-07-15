import { describe, expect, it } from "vitest";

import {
  parseGitHubCiWatchStateJson,
  parseGitHubDraftPullRequestViewsJson,
  parseGitHubPrLoopStateJson,
} from "./github-publisher.js";

const headSha = "a".repeat(40);

describe("GitHub publisher schema boundaries", () => {
  it("decodes bounded draft pull-request views from raw gh JSON", () => {
    const views = parseGitHubDraftPullRequestViewsJson(
      JSON.stringify([
        {
          baseRefName: "main",
          body: "GAIA-100 evidence",
          headRefName: "gaia/run-1234567890",
          headRefOid: headSha,
          isDraft: true,
          number: 108,
          state: "OPEN",
          url: "https://github.com/cill-i-am/gaia/pull/108",
        },
      ])
    );

    expect(views).toHaveLength(1);
    expect(views[0]?.headRefOid).toBe(headSha);
  });

  it.each([
    ["uppercase head SHA", { headRefOid: "A".repeat(40) }],
    ["invalid PR URL", { url: "https://example.com/cill-i-am/gaia/pull/108" }],
    ["zero PR number", { number: 0 }],
  ])("rejects invalid draft pull-request %s", (_name, patch) => {
    expect(() =>
      parseGitHubDraftPullRequestViewsJson(
        JSON.stringify([
          {
            baseRefName: "main",
            body: "GAIA-100 evidence",
            headRefName: "gaia/run-1234567890",
            headRefOid: headSha,
            isDraft: true,
            number: 108,
            state: "OPEN",
            url: "https://github.com/cill-i-am/gaia/pull/108",
            ...patch,
          },
        ])
      )
    ).toThrow();
  });

  it("normalizes legacy check status fields before decoding persisted CI state", () => {
    const state = parseGitHubCiWatchStateJson({
      attempts: 1,
      lastSnapshotPath: "github-checks.json",
      lastStatus: "failed",
      nextAction: "fix-failed-checks",
      pr: "108",
      runId: "run-1234567890",
      terminal: false,
      updatedAt: "2026-07-15T10:00:00.000Z",
      version: 1,
    });

    expect(state.lastStatus).toBe("failing");
  });

  it("normalizes nested legacy check status fields before decoding PR-loop state", () => {
    const state = parseGitHubPrLoopStateJson({
      blockerCount: 0,
      blockers: [],
      checksPath: "github-checks.json",
      checksStatus: "passed",
      feedbackPath: "github-feedback.json",
      feedbackStatus: "clear",
      headSha,
      nextAction: "ready-for-merge-decision",
      observedAt: "2026-07-15T10:00:00.000Z",
      pr: "108",
      runId: "run-1234567890",
      status: "ready",
      version: 1,
    });

    expect(state.checksStatus).toBe("green");
  });
});
