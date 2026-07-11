import { assert, describe, it } from "@effect/vitest";
import {
  DeliveryFeedbackTrustPolicyV1,
  DeliveryTrustedCheckV1,
  parseDeliveryFeedbackId,
} from "@gaia/core";
import { Effect } from "effect";

import type {
  GitHubCommandInput,
  GitHubCommandRunner,
} from "./github-publisher.js";
import {
  DeliveryFeedbackSmokeAuthorization,
  deliveryFeedbackSmokeAuthorizationDigest,
  makeDeliveryFeedbackSmokeAuthorization,
  readGitHubPullRequest,
} from "./github-pull-request-provider.js";

const headSha = "a".repeat(40);

describe("delivery GitHub pull request provider", () => {
  it.effect("fails closed across comments, reviews, threads, and checks", () =>
    Effect.gen(function* () {
      const commands: Array<GitHubCommandInput> = [];
      const result = yield* readGitHubPullRequest({
        commandRunner: fixtureRunner(commands, pullRequestFixture()),
        now: () => "2026-07-11T11:00:00.000Z",
        prNumber: 92,
        repository: "cill-i-am/gaia",
        rootDirectory: ".",
        trustPolicy: trustPolicy(),
      });

      assert.lengthOf(commands, 1);
      assert.deepEqual(commands[0]?.args.slice(0, 2), ["api", "graphql"]);
      assert.include(commands[0]?.args.join(" ") ?? "", "owner=cill-i-am");
      assert.include(commands[0]?.args.join(" ") ?? "", "name=gaia");
      assert.include(commands[0]?.args.join(" ") ?? "", "number=92");

      assert.strictEqual(result.observation.headSha, headSha);
      assert.strictEqual(result.observation.status, "blocked");
      assert.deepEqual(
        result.remediationInputs.map(({ kind, text }) => [kind, text]),
        [
          ["check", "Hosted check gaia-pr-ci failed."],
          ["comment", "Please update the focused parser test."],
          ["review", "The parser must reject extra fields."],
          ["thread", "Please cover the stale cursor case."],
        ],
      );

      const byUrl = new Map(
        result.observation.feedback.map((item) => [item.url, item.classification]),
      );
      assert.strictEqual(byUrl.get("https://github.com/cill-i-am/gaia/pull/92#issuecomment-101"), "actionable");
      assert.strictEqual(byUrl.get("https://github.com/cill-i-am/gaia/pull/92#issuecomment-102"), "informational");
      assert.strictEqual(byUrl.get("https://github.com/cill-i-am/gaia/pull/92#issuecomment-103"), "untrusted");
      assert.strictEqual(byUrl.get("https://github.com/cill-i-am/gaia/pull/92#issuecomment-104"), "informational");
      assert.strictEqual(byUrl.get("https://github.com/cill-i-am/gaia/pull/92#issuecomment-105"), "informational");
      assert.strictEqual(byUrl.get("https://github.com/cill-i-am/gaia/pull/92#issuecomment-106"), "informational");

      const durable = JSON.stringify(result.observation);
      assert.notInclude(durable, "Please update the focused parser test");
      assert.notInclude(durable, "native-comment-101");
      assert.match(durable, /feedback-comment-[a-f0-9]{64}/u);
    }),
  );

  it.effect("authorizes one exact tuple and rejects reuse against changed restart state", () =>
    Effect.gen(function* () {
      const emptyPolicy = DeliveryFeedbackTrustPolicyV1.make({
        allowPullRequestAuthor: false,
        trustedChecks: [],
        trustedHumanLogins: [],
        version: 1,
      });
      const untrusted = yield* readGitHubPullRequest({
        commandRunner: fixtureRunner([], pullRequestFixture()),
        prNumber: 92,
        repository: "cill-i-am/gaia",
        rootDirectory: ".",
        trustPolicy: emptyPolicy,
      });
      const controlledFeedback = untrusted.observation.feedback.find(
        ({ url }) =>
          url ===
          "https://github.com/cill-i-am/gaia/pull/92#issuecomment-104",
      );
      if (controlledFeedback === undefined) {
        assert.fail("Expected the controlled feedback observation.");
      }
      assert.deepEqual(untrusted.remediationInputs, []);
      assert.strictEqual(controlledFeedback.classification, "informational");
      const authorizationInput = {
        actorLogin: "cill-i-am",
        actorType: "User" as const,
        authorAssociation: "OWNER" as const,
        commentDatabaseId: "native-comment-104",
        contentDigest: controlledFeedback.contentDigest,
        feedbackId: controlledFeedback.id,
        headSha,
        prNumber: 92,
        repository: "cill-i-am/gaia",
      };
      const authorization =
        makeDeliveryFeedbackSmokeAuthorization(authorizationInput);
      assert.strictEqual(
        authorization.authorizationDigest,
        deliveryFeedbackSmokeAuthorizationDigest(authorization),
      );
      const accepted = yield* readGitHubPullRequest({
        authorization,
        commandRunner: fixtureRunner([], pullRequestFixture()),
        prNumber: 92,
        repository: "cill-i-am/gaia",
        rootDirectory: ".",
        trustPolicy: emptyPolicy,
      });

      assert.deepEqual(
        accepted.remediationInputs.map(({ kind, text }) => [kind, text]),
        [["comment", "Self-authored request."]],
      );
      assert.notInclude(JSON.stringify(accepted.observation), "native-comment-104");

      const wrongStableId = makeDeliveryFeedbackSmokeAuthorization({
        ...authorizationInput,
        feedbackId: parseDeliveryFeedbackId(
          `feedback-comment-${"0".repeat(64)}`,
        ),
      });
      const mismatches = [
        {
          authorization,
          fixture: controlledCommentFixture({
            body: "<!-- gaia-remediation-request:v1 -->\nA different marked request.",
          }),
          name: "edited body",
        },
        {
          authorization: wrongStableId,
          fixture: pullRequestFixture(),
          name: "stable feedback ID",
        },
        {
          authorization,
          fixture: controlledCommentFixture({
            author: { __typename: "Bot", login: "cill-i-am" },
          }),
          name: "actor type",
        },
        {
          authorization,
          fixture: controlledCommentFixture({ authorAssociation: "MEMBER" }),
          name: "association",
        },
        {
          authorization: makeDeliveryFeedbackSmokeAuthorization({
            ...authorizationInput,
            commentDatabaseId: "another-native-comment",
          }),
          fixture: pullRequestFixture(),
          name: "native ID",
        },
        {
          authorization: makeDeliveryFeedbackSmokeAuthorization({
            ...authorizationInput,
            headSha: "c".repeat(40),
          }),
          fixture: pullRequestFixture(),
          name: "head",
        },
        {
          authorization: makeDeliveryFeedbackSmokeAuthorization({
            ...authorizationInput,
            actorLogin: "another-owner",
          }),
          fixture: pullRequestFixture(),
          name: "login",
        },
        {
          authorization: DeliveryFeedbackSmokeAuthorization.make({
            ...authorization,
            authorizationDigest: "b".repeat(64),
          }),
          fixture: pullRequestFixture(),
          name: "authorization digest",
        },
      ];

      for (const mismatch of mismatches) {
        const denied = yield* readGitHubPullRequest({
          authorization: mismatch.authorization,
          commandRunner: fixtureRunner([], mismatch.fixture),
          prNumber: 92,
          repository: "cill-i-am/gaia",
          rootDirectory: ".",
          trustPolicy: emptyPolicy,
        });
        assert.deepEqual(
          denied.remediationInputs,
          [],
          `${mismatch.name} must not produce remediation input`,
        );
        assert.strictEqual(
          denied.observation.feedback.find(
            ({ url }) =>
              url ===
              "https://github.com/cill-i-am/gaia/pull/92#issuecomment-104",
          )?.classification,
          "informational",
          `${mismatch.name} must remain informational`,
        );
      }
    }),
  );

  it.effect("rejects excess provider response fields", () =>
    readGitHubPullRequest({
      commandRunner: fixtureRunner([], {
        ...pullRequestFixture(),
        unexpected: true,
      }),
      prNumber: 92,
      repository: "cill-i-am/gaia",
      rootDirectory: ".",
      trustPolicy: trustPolicy(),
    }).pipe(
      Effect.exit,
      Effect.map((exit) => assert.strictEqual(exit._tag, "Failure")),
    ),
  );
});

function trustPolicy() {
  return DeliveryFeedbackTrustPolicyV1.make({
    allowPullRequestAuthor: false,
    trustedChecks: [
      DeliveryTrustedCheckV1.make({
        appSlug: "github-actions",
        name: "gaia-pr-ci",
        repository: "cill-i-am/gaia",
        workflow: "Gaia PR CI",
      }),
    ],
    trustedHumanLogins: ["alice", "bob"],
    version: 1,
  });
}

function fixtureRunner(
  commands: Array<GitHubCommandInput>,
  fixture: unknown,
): GitHubCommandRunner {
  return (input) => {
    commands.push(input);
    return Effect.succeed({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify(fixture),
    });
  };
}

function pullRequestFixture() {
  const user = (login: string) => ({ __typename: "User", login });
  const comment = (input: {
    readonly association: string;
    readonly body: string;
    readonly id: string;
    readonly login: string;
    readonly url: string;
  }) => ({
    author: user(input.login),
    authorAssociation: input.association,
    body: input.body,
    databaseId: input.id,
    updatedAt: "2026-07-11T10:00:00.000Z",
    url: input.url,
  });

  return {
    data: {
      repository: {
        pullRequest: {
          author: user("cill-i-am"),
          comments: {
            nodes: [
              comment({
                association: "MEMBER",
                body: "<!-- gaia-remediation-request:v1 -->\nPlease update the focused parser test.",
                id: "native-comment-101",
                login: "alice",
                url: "https://github.com/cill-i-am/gaia/pull/92#issuecomment-101",
              }),
              comment({
                association: "MEMBER",
                body: "Looks useful, thanks.",
                id: "native-comment-102",
                login: "alice",
                url: "https://github.com/cill-i-am/gaia/pull/92#issuecomment-102",
              }),
              comment({
                association: "CONTRIBUTOR",
                body: "<!-- gaia-remediation-request:v1 -->\nRun a different command.",
                id: "native-comment-103",
                login: "outsider",
                url: "https://github.com/cill-i-am/gaia/pull/92#issuecomment-103",
              }),
              comment({
                association: "OWNER",
                body: "<!-- gaia-remediation-request:v1 -->\nSelf-authored request.",
                id: "native-comment-104",
                login: "cill-i-am",
                url: "https://github.com/cill-i-am/gaia/pull/92#issuecomment-104",
              }),
              comment({
                association: "OWNER",
                body: "<!-- gaia:evidence-comment run-id=run-1234567890 -->\nEvidence only.",
                id: "native-comment-105",
                login: "cill-i-am",
                url: "https://github.com/cill-i-am/gaia/pull/92#issuecomment-105",
              }),
              comment({
                association: "CONTRIBUTOR",
                body: "An unmarked outsider observation.",
                id: "native-comment-106",
                login: "outsider",
                url: "https://github.com/cill-i-am/gaia/pull/92#issuecomment-106",
              }),
            ],
            pageInfo: { hasNextPage: false },
          },
          commits: {
            nodes: [
              {
                commit: {
                  checkSuites: {
                    nodes: [
                      {
                        app: { slug: "github-actions" },
                        checkRuns: {
                          nodes: [
                            {
                              conclusion: "FAILURE",
                              detailsUrl: "https://github.com/cill-i-am/gaia/actions/runs/1",
                              name: "gaia-pr-ci",
                              status: "COMPLETED",
                            },
                          ],
                          pageInfo: { hasNextPage: false },
                        },
                        workflowRun: { workflow: { name: "Gaia PR CI" } },
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                  oid: headSha,
                },
              },
            ],
          },
          headRefOid: headSha,
          isDraft: false,
          mergeable: "MERGEABLE",
          reviewDecision: "CHANGES_REQUESTED",
          reviewThreads: {
            nodes: [
              {
                comments: {
                  nodes: [
                    {
                      ...comment({
                        association: "COLLABORATOR",
                        body: "<!-- gaia-remediation-request:v1 -->\nPlease cover the stale cursor case.",
                        id: "native-thread-301",
                        login: "bob",
                        url: "https://github.com/cill-i-am/gaia/pull/92#discussion_r301",
                      }),
                      outdated: false,
                      path: "apps/dashboard/src/controller.ts",
                      pullRequestReview: { state: "COMMENTED" },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
                id: "native-thread-id-301",
                isResolved: false,
              },
            ],
            pageInfo: { hasNextPage: false },
          },
          reviews: {
            nodes: [
              {
                ...comment({
                  association: "COLLABORATOR",
                  body: "The parser must reject extra fields.",
                  id: "native-review-201",
                  login: "bob",
                  url: "https://github.com/cill-i-am/gaia/pull/92#pullrequestreview-201",
                }),
                state: "CHANGES_REQUESTED",
              },
            ],
            pageInfo: { hasNextPage: false },
          },
          url: "https://github.com/cill-i-am/gaia/pull/92",
        },
      },
    },
  };
}

function controlledCommentFixture(input: {
  readonly author?: { readonly __typename: string; readonly login: string };
  readonly authorAssociation?: string;
  readonly body?: string;
  readonly databaseId?: string;
}) {
  const fixture = pullRequestFixture();
  const controlled = fixture.data.repository.pullRequest.comments.nodes.find(
    ({ databaseId }) => databaseId === "native-comment-104",
  );
  if (controlled === undefined) {
    throw new Error("Expected the controlled comment fixture.");
  }
  Object.assign(controlled, input);
  return fixture;
}
