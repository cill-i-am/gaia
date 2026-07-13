import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  invokeGitHubDeliveryMerge,
  invokeGitHubReadyForReview,
  validateRequiredChecks,
} from "./delivery-merge-provider.js";
import type { GitHubCommandInput } from "./github-publisher.js";

describe("delivery merge provider", () => {
  it("marks only the exact owned pull request ready for review", async () => {
    const calls: GitHubCommandInput[] = [];
    await Effect.runPromise(
      invokeGitHubReadyForReview(
        {
          cwd: "/repo",
          prUrl: "https://github.com/cill-i-am/gaia/pull/74",
          repository: "cill-i-am/gaia",
        },
        (input) => {
          calls.push(input);
          return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
        }
      )
    );
    expect(calls).toEqual([
      {
        args: [
          "pr",
          "ready",
          "https://github.com/cill-i-am/gaia/pull/74",
          "--repo",
          "cill-i-am/gaia",
        ],
        command: "gh",
        cwd: "/repo",
      },
    ]);
  });

  for (const [method, flag] of [
    ["merge", "--merge"],
    ["squash", "--squash"],
    ["rebase", "--rebase"],
  ] as const) {
    it(`maps ${method} to its one exact provider mutation`, async () => {
      const calls: GitHubCommandInput[] = [];
      await Effect.runPromise(
        invokeGitHubDeliveryMerge(
          {
            cwd: "/repo",
            expectedHeadSha: "a".repeat(40),
            method,
            prUrl: "https://github.com/cill-i-am/gaia/pull/74",
            repository: "cill-i-am/gaia",
          },
          (input) => {
            calls.push(input);
            return Effect.succeed({ exitCode: 0, stderr: "", stdout: "" });
          }
        )
      );
      expect(calls).toEqual([
        {
          args: [
            "pr",
            "merge",
            "https://github.com/cill-i-am/gaia/pull/74",
            flag,
            "--match-head-commit",
            "a".repeat(40),
            "--repo",
            "cill-i-am/gaia",
          ],
          command: "gh",
          cwd: "/repo",
        },
      ]);
    });
  }

  it("requires one passing exact-head observation for every configured check", () => {
    const required = [
      {
        appSlug: "github-actions",
        name: "test",
        repository: "cill-i-am/gaia",
        workflow: "CI",
      },
    ];
    const passing = {
      ...required[0]!,
      headSha: "a".repeat(40),
      state: "passing" as const,
    };
    expect(validateRequiredChecks(required, [passing], passing.headSha)).toBe(
      true
    );
    expect(validateRequiredChecks(required, [], passing.headSha)).toBe(false);
    expect(
      validateRequiredChecks(required, [passing, passing], passing.headSha)
    ).toBe(false);
    expect(
      validateRequiredChecks(
        required,
        [{ ...passing, headSha: "b".repeat(40) }],
        passing.headSha
      )
    ).toBe(false);
    expect(
      validateRequiredChecks(
        required,
        [{ ...passing, state: "pending" }],
        passing.headSha
      )
    ).toBe(false);
  });
});
