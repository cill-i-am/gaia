import {
  DeliveryBlocker,
  DeliveryCheckObservation,
  DeliveryFeedbackIdSchema,
  DeliveryFeedbackObservation,
  DeliveryPullRequestObservation,
  parseDeliveryFeedbackId,
  type DeliveryFeedbackTrustPolicyV1,
} from "@gaia/core";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";

import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import {
  nodeGitHubCommandRunner,
  type GitHubCommandRunner,
} from "./github-publisher.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const remediationMarker = "<!-- gaia-remediation-request:v1 -->";
const evidenceMarker = "<!-- gaia:evidence-comment ";
const maximumBodyCharacters = 16_384;
const trustedAssociations = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);
const passingConclusions = new Set(["NEUTRAL", "SKIPPED", "SUCCESS"]);
const DigestSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
);
const GitShaSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
);
const LoginSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u),
  ),
);
const RepositorySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
);
const TrustedAssociationSchema = Schema.Literals([
  "COLLABORATOR",
  "MEMBER",
  "OWNER",
] as const);
const DeliveryFeedbackSmokeAuthorizationInputSchema = Schema.Struct({
  actorLogin: LoginSchema,
  actorType: Schema.Literal("User"),
  authorAssociation: TrustedAssociationSchema,
  commentDatabaseId: Schema.Union([Schema.String, Schema.Number]),
  contentDigest: DigestSchema,
  feedbackId: DeliveryFeedbackIdSchema,
  headSha: GitShaSchema,
  prNumber: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  repository: RepositorySchema,
});
type DeliveryFeedbackSmokeAuthorizationInput =
  typeof DeliveryFeedbackSmokeAuthorizationInputSchema.Type;

class RawActor extends Schema.Class<RawActor>("RawActor")({
  __typename: Schema.NonEmptyString,
  login: Schema.NonEmptyString,
}, strict) {}

/** Ephemeral authorization for one controlled acceptance-smoke comment. */
export class DeliveryFeedbackSmokeAuthorization extends Schema.Class<DeliveryFeedbackSmokeAuthorization>(
  "DeliveryFeedbackSmokeAuthorization",
)({
  ...DeliveryFeedbackSmokeAuthorizationInputSchema.fields,
  authorizationDigest: DigestSchema,
  marker: Schema.Literal(remediationMarker),
  version: Schema.Literal(1),
}, strict) {}

/** Create one exact, self-verifying acceptance-smoke authorization tuple. */
export function makeDeliveryFeedbackSmokeAuthorization(
  input: DeliveryFeedbackSmokeAuthorizationInput,
) {
  const binding = Schema.decodeUnknownSync(
    DeliveryFeedbackSmokeAuthorizationInputSchema,
    { onExcessProperty: "error" },
  )(input);
  const tuple = {
    ...binding,
    marker: remediationMarker,
    version: 1,
  } as const;
  return DeliveryFeedbackSmokeAuthorization.make({
    ...tuple,
    authorizationDigest: deliveryFeedbackSmokeAuthorizationDigest(tuple),
  });
}

/** Canonical domain-separated digest for an exact smoke authorization tuple. */
export function deliveryFeedbackSmokeAuthorizationDigest(
  input: Omit<DeliveryFeedbackSmokeAuthorization, "authorizationDigest">,
) {
  return stableHash([
    "gaia-feedback-smoke-authorization-v1",
    String(input.version),
    input.repository,
    String(input.prNumber),
    input.headSha,
    input.actorType,
    input.actorLogin,
    input.authorAssociation,
    String(input.commentDatabaseId),
    input.feedbackId,
    input.contentDigest,
    input.marker,
  ].join("\0"));
}

const RawActorOrNull = Schema.NullOr(RawActor);
const RawAssociation = Schema.Literals([
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIMER",
  "FIRST_TIME_CONTRIBUTOR",
  "MANNEQUIN",
  "MEMBER",
  "NONE",
  "OWNER",
] as const);
const RawBody = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(maximumBodyCharacters)),
);
const RawPageInfo = Schema.Struct({ hasNextPage: Schema.Boolean });

class RawComment extends Schema.Class<RawComment>("RawComment")({
  author: RawActorOrNull,
  authorAssociation: RawAssociation,
  body: RawBody,
  databaseId: Schema.Union([Schema.String, Schema.Number]),
  updatedAt: Schema.String,
  url: Schema.String,
}, strict) {}

class RawReview extends Schema.Class<RawReview>("RawReview")({
  author: RawActorOrNull,
  authorAssociation: RawAssociation,
  body: RawBody,
  databaseId: Schema.Union([Schema.String, Schema.Number]),
  state: Schema.NonEmptyString,
  updatedAt: Schema.String,
  url: Schema.String,
}, strict) {}

class RawThreadComment extends Schema.Class<RawThreadComment>("RawThreadComment")({
  author: RawActorOrNull,
  authorAssociation: RawAssociation,
  body: RawBody,
  databaseId: Schema.Union([Schema.String, Schema.Number]),
  outdated: Schema.Boolean,
  path: Schema.NullOr(Schema.String),
  pullRequestReview: Schema.NullOr(
    Schema.Struct({ state: Schema.NonEmptyString }),
  ),
  updatedAt: Schema.String,
  url: Schema.String,
}, strict) {}

class RawReviewThread extends Schema.Class<RawReviewThread>("RawReviewThread")({
  comments: Schema.Struct({
    nodes: Schema.Array(RawThreadComment).pipe(
      Schema.check(Schema.isMaxLength(20)),
    ),
    pageInfo: RawPageInfo,
  }),
  id: Schema.String,
  isResolved: Schema.Boolean,
}, strict) {}

class RawCheckRun extends Schema.Class<RawCheckRun>("RawCheckRun")({
  conclusion: Schema.NullOr(Schema.String),
  detailsUrl: Schema.NullOr(Schema.String),
  name: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
}, strict) {}

class RawCheckSuite extends Schema.Class<RawCheckSuite>("RawCheckSuite")({
  app: Schema.NullOr(Schema.Struct({ slug: Schema.NonEmptyString })),
  checkRuns: Schema.Struct({
    nodes: Schema.Array(RawCheckRun).pipe(Schema.check(Schema.isMaxLength(100))),
    pageInfo: RawPageInfo,
  }),
  workflowRun: Schema.NullOr(
    Schema.Struct({
      workflow: Schema.NullOr(Schema.Struct({ name: Schema.NonEmptyString })),
    }),
  ),
}, strict) {}

class RawPullRequest extends Schema.Class<RawPullRequest>("RawPullRequest")({
  author: RawActorOrNull,
  comments: Schema.Struct({
    nodes: Schema.Array(RawComment).pipe(Schema.check(Schema.isMaxLength(100))),
    pageInfo: RawPageInfo,
  }),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          checkSuites: Schema.Struct({
            nodes: Schema.Array(RawCheckSuite).pipe(
              Schema.check(Schema.isMaxLength(50)),
            ),
            pageInfo: RawPageInfo,
          }),
          oid: Schema.String,
        }),
      }),
    ).pipe(Schema.check(Schema.isMaxLength(1))),
  }),
  headRefOid: Schema.String,
  isDraft: Schema.Boolean,
  mergeable: Schema.NonEmptyString,
  reviewDecision: Schema.NullOr(Schema.String),
  reviewThreads: Schema.Struct({
    nodes: Schema.Array(RawReviewThread).pipe(
      Schema.check(Schema.isMaxLength(100)),
    ),
    pageInfo: RawPageInfo,
  }),
  reviews: Schema.Struct({
    nodes: Schema.Array(RawReview).pipe(Schema.check(Schema.isMaxLength(100))),
    pageInfo: RawPageInfo,
  }),
  url: Schema.String,
}, strict) {}

const RawResponse = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({ pullRequest: RawPullRequest }),
  }),
});

/** Prompt-bearing normalized input retained only inside the remediation workflow. */
export type DeliveryRemediationInput = {
  readonly id: string;
  readonly kind: "check" | "comment" | "review" | "thread";
  readonly text: string;
};

/** Result of one atomic, bounded GitHub pull-request observation. */
export type GitHubPullRequestRead = {
  readonly observation: DeliveryPullRequestObservation;
  readonly remediationInputs: ReadonlyArray<DeliveryRemediationInput>;
};

/** Read and normalize one owned pull request without mutating GitHub. */
export function readGitHubPullRequest(input: {
  readonly authorization?: DeliveryFeedbackSmokeAuthorization;
  readonly commandRunner?: GitHubCommandRunner;
  readonly now?: () => string;
  readonly prNumber: number;
  readonly repository: string;
  readonly rootDirectory: string;
  readonly trustPolicy: DeliveryFeedbackTrustPolicyV1;
}) {
  return Effect.gen(function* () {
    const authorization = input.authorization === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(DeliveryFeedbackSmokeAuthorization)(
          input.authorization,
        ).pipe(
          Effect.mapError((cause) => makeRuntimeError({ cause, code: "GitHubFeedbackAuthorizationInvalid", message: "Controlled feedback authorization is invalid.", recoverable: false })),
        );
    const repository = yield* Effect.try({
      catch: (cause) => makeRuntimeError({ cause, code: "GitHubRepositoryInvalid", message: "GitHub repository identity is invalid.", recoverable: false }),
      try: () => parseRepository(input.repository),
    });
    const runner = input.commandRunner ?? nodeGitHubCommandRunner;
    const result = yield* runner({
      args: [
        "api",
        "graphql",
        "-f",
        `query=${pullRequestQuery}`,
        "-F",
        `owner=${repository.owner}`,
        "-F",
        `name=${repository.name}`,
        "-F",
        `number=${input.prNumber}`,
      ],
      command: "gh",
      cwd: input.rootDirectory,
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "GitHubPullRequestReadFailed",
          message: "GitHub pull-request observation failed.",
          recoverable: true,
        }),
      );
    }
    const raw = yield* decodeResponse(result.stdout);
    return yield* Effect.try({
      catch: (cause) =>
        cause instanceof GaiaRuntimeError
          ? cause
          : makeRuntimeError({ cause, code: "GitHubPullRequestResponseInvalid", message: "GitHub pull-request observation could not be normalized.", recoverable: true }),
      try: () => normalizePullRequest({
        ...(authorization === undefined ? {} : { authorization }),
        now: input.now?.() ?? new Date().toISOString(),
        pr: raw.data.repository.pullRequest,
        prNumber: input.prNumber,
        repository: input.repository,
        trustPolicy: input.trustPolicy,
      }),
    });
  });
}

function decodeResponse(stdout: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(
      RawResponse,
      { onExcessProperty: "error" },
    )(JSON.parse(stdout)),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "GitHubPullRequestResponseInvalid",
        message: "GitHub pull-request output did not match Gaia's bounded schema.",
        recoverable: true,
      }),
  });
}

function normalizePullRequest(input: {
  readonly authorization?: DeliveryFeedbackSmokeAuthorization;
  readonly now: string;
  readonly pr: RawPullRequest;
  readonly prNumber: number;
  readonly repository: string;
  readonly trustPolicy: DeliveryFeedbackTrustPolicyV1;
}): GitHubPullRequestRead {
  const headCommit = input.pr.commits.nodes[0]?.commit;
  if (headCommit === undefined || headCommit.oid !== input.pr.headRefOid) {
    throw makeRuntimeError({
      code: "GitHubPullRequestHeadChanged",
      message: "GitHub changed the pull-request head during observation.",
      recoverable: true,
    });
  }
  const truncated = isTruncated(input.pr, headCommit.checkSuites.nodes);
  const pullRequestAuthor = input.pr.author?.login.toLowerCase();
  const feedback: Array<DeliveryFeedbackObservation> = [];
  const remediationInputs: Array<DeliveryRemediationInput> = [];

  for (const comment of input.pr.comments.nodes) {
    const normalized = normalizeFeedback({
      body: comment.body,
      kind: "comment",
      nativeId: String(comment.databaseId),
      path: undefined,
      repository: input.repository,
      prNumber: input.prNumber,
      actor: comment.author,
      association: comment.authorAssociation,
      controlledAuthorization: controlledCommentAuthorization(input, comment),
      explicitAction: hasRemediationMarker(comment.body),
      forcedInformational: comment.body.trimStart().startsWith(evidenceMarker),
      pullRequestAuthor,
      trustPolicy: input.trustPolicy,
      url: comment.url,
    });
    feedback.push(normalized.observation);
    if (normalized.input !== undefined) remediationInputs.push(normalized.input);
  }
  for (const review of input.pr.reviews.nodes) {
    const normalized = normalizeFeedback({
      body: review.body,
      kind: "review",
      nativeId: String(review.databaseId),
      path: undefined,
      repository: input.repository,
      prNumber: input.prNumber,
      actor: review.author,
      association: review.authorAssociation,
      explicitAction: review.state === "CHANGES_REQUESTED",
      forcedInformational: review.state !== "CHANGES_REQUESTED",
      pullRequestAuthor,
      trustPolicy: input.trustPolicy,
      url: review.url,
    });
    feedback.push(normalized.observation);
    if (normalized.input !== undefined) remediationInputs.push(normalized.input);
  }
  for (const thread of input.pr.reviewThreads.nodes) {
    const root = thread.comments.nodes[0];
    if (root === undefined) continue;
    const explicitAction =
      !thread.isResolved &&
      !root.outdated &&
      (root.pullRequestReview?.state === "CHANGES_REQUESTED" ||
        hasRemediationMarker(root.body));
    const normalized = normalizeFeedback({
      body: root.body,
      kind: "thread",
      nativeId: thread.id,
      path: root.path ?? undefined,
      repository: input.repository,
      prNumber: input.prNumber,
      actor: root.author,
      association: root.authorAssociation,
      explicitAction,
      forcedInformational: thread.isResolved || root.outdated || !explicitAction,
      pullRequestAuthor,
      trustPolicy: input.trustPolicy,
      url: root.url,
    });
    feedback.push(normalized.observation);
    if (normalized.input !== undefined) remediationInputs.push(normalized.input);
  }

  const checks = headCommit.checkSuites.nodes.flatMap((suite) =>
    suite.checkRuns.nodes.map((check) => {
      const state = checkState(check);
      const appSlug = suite.app?.slug ?? "unknown";
      const workflow = suite.workflowRun?.workflow?.name ?? "unknown";
      const trusted = input.trustPolicy.trustedChecks.some(
        (candidate) =>
          candidate.appSlug === appSlug &&
          candidate.name === check.name &&
          candidate.repository === input.repository &&
          candidate.workflow === workflow,
      );
      const classification = trusted
        ? state === "failing"
          ? "actionable"
          : "informational"
        : "untrusted";
      const observation = DeliveryCheckObservation.make({
        appSlug,
        classification,
        ...(check.detailsUrl === null ? {} : { link: check.detailsUrl }),
        name: check.name,
        state,
        workflow,
      });
      if (classification === "actionable") {
        remediationInputs.unshift({
          id: parseDeliveryFeedbackId(
            `feedback-check-${stableHash(`github-check-v1\0${input.repository}\0${input.prNumber}\0${appSlug}\0${workflow}\0${check.name}`)}`,
          ),
          kind: "check",
          text: `Hosted check ${check.name} failed.`,
        });
      }
      return observation;
    }),
  );
  const blockers = blockersFor({
    checks,
    draft: input.pr.isDraft,
    feedback,
    mergeability: input.pr.mergeable,
    reviewDecision: input.pr.reviewDecision,
    truncated,
  });
  const actionableBlocker = blockers.some((blocker) =>
    blocker.kind !== "pendingCheck" &&
    blocker.kind !== "draftPullRequest" &&
    blocker.kind !== "mergeabilityUnknown"
  );
  const status = actionableBlocker
    ? "blocked"
    : blockers.length > 0
      ? "waiting"
      : "ready";
  const snapshotDigest = stableHash(JSON.stringify({
    blockers,
    checks,
    draft: input.pr.isDraft,
    feedback,
    headSha: input.pr.headRefOid,
    mergeable: input.pr.mergeable,
    reviewDecision: input.pr.reviewDecision,
  }));
  return {
    observation: DeliveryPullRequestObservation.make({
      blockers,
      checks,
      draft: input.pr.isDraft,
      feedback,
      headSha: input.pr.headRefOid,
      mergeability: normalizeMergeability(input.pr.mergeable),
      observedAt: input.now,
      prNumber: input.prNumber,
      prUrl: input.pr.url,
      repository: input.repository,
      ...(input.pr.reviewDecision === null
        ? {}
        : { reviewDecision: input.pr.reviewDecision }),
      snapshotDigest,
      status,
      version: 1,
    }),
    remediationInputs: truncated ? [] : remediationInputs,
  };
}

function normalizeFeedback(input: {
  readonly actor: RawActor | null;
  readonly association: typeof RawAssociation.Type;
  readonly body: string;
  readonly controlledAuthorization?: boolean;
  readonly explicitAction: boolean;
  readonly forcedInformational: boolean;
  readonly kind: "comment" | "review" | "thread";
  readonly nativeId: string;
  readonly path: string | undefined;
  readonly prNumber: number;
  readonly pullRequestAuthor: string | undefined;
  readonly repository: string;
  readonly trustPolicy: DeliveryFeedbackTrustPolicyV1;
  readonly url: string;
}) {
  const contentDigest = stableHash(input.body);
  const id = feedbackId(input);
  const actorLogin = input.actor?.login;
  const trusted =
    input.actor?.__typename === "User" &&
    trustedAssociations.has(input.association) &&
    (input.controlledAuthorization === true ||
      input.trustPolicy.trustedHumanLogins.some(
        (login) => login.toLowerCase() === actorLogin?.toLowerCase(),
      ) &&
      (input.trustPolicy.allowPullRequestAuthor ||
        actorLogin?.toLowerCase() !== input.pullRequestAuthor));
  const deniedPullRequestAuthor =
    input.controlledAuthorization !== true &&
    !input.trustPolicy.allowPullRequestAuthor &&
    actorLogin?.toLowerCase() === input.pullRequestAuthor;
  const classification =
    input.forcedInformational || !input.explicitAction || deniedPullRequestAuthor
    ? "informational"
    : trusted
      ? "actionable"
      : "untrusted";
  const observation = DeliveryFeedbackObservation.make({
    ...(actorLogin === undefined ? {} : { actorLogin }),
    authorAssociation: input.association,
    classification,
    contentDigest,
    id,
    kind: input.kind,
    ...(input.path === undefined ? {} : { path: input.path }),
    url: input.url,
  });
  return {
    observation,
    input:
      classification === "actionable"
        ? {
            id,
            kind: input.kind,
            text: remediationText(input.body),
          }
        : undefined,
  };
}

function blockersFor(input: {
  readonly checks: ReadonlyArray<DeliveryCheckObservation>;
  readonly draft: boolean;
  readonly feedback: ReadonlyArray<DeliveryFeedbackObservation>;
  readonly mergeability: string;
  readonly reviewDecision: string | null;
  readonly truncated: boolean;
}) {
  const blockers: Array<DeliveryBlocker> = [];
  const actionable = input.feedback.filter(
    ({ classification }) => classification === "actionable",
  );
  const untrusted = input.feedback.filter(
    ({ classification }) => classification === "untrusted",
  );
  if (actionable.length > 0) {
    blockers.push(DeliveryBlocker.make({
      feedbackIds: actionable.map(({ id }) => id),
      kind: "actionableFeedback",
      summary: "Trusted actionable pull-request feedback requires remediation.",
    }));
  }
  if (untrusted.length > 0 || input.reviewDecision === "CHANGES_REQUESTED" && actionable.length === 0) {
    blockers.push(DeliveryBlocker.make({
      feedbackIds: untrusted.map(({ id }) => id).slice(0, 20),
      kind: "operatorReviewRequired",
      summary: "Untrusted or ambiguous feedback requires operator review.",
    }));
  }
  const failing = input.checks.filter(
    ({ classification, state }) => classification === "actionable" && state === "failing",
  );
  if (failing.length > 0) {
    blockers.push(DeliveryBlocker.make({
      feedbackIds: [],
      kind: "failedCheck",
      summary: "A trusted hosted check failed.",
    }));
  }
  const trustedChecks = input.checks.filter(
    ({ classification }) => classification !== "untrusted",
  );
  if (trustedChecks.length === 0) {
    blockers.push(DeliveryBlocker.make({ feedbackIds: [], kind: "missingHostedChecks", summary: "No trusted hosted checks were reported." }));
  } else if (trustedChecks.some(({ state }) => state === "pending")) {
    blockers.push(DeliveryBlocker.make({ feedbackIds: [], kind: "pendingCheck", summary: "Hosted checks are still pending." }));
  }
  if (input.draft) blockers.push(DeliveryBlocker.make({ feedbackIds: [], kind: "draftPullRequest", summary: "The pull request is still a draft." }));
  if (input.mergeability === "UNKNOWN") blockers.push(DeliveryBlocker.make({ feedbackIds: [], kind: "mergeabilityUnknown", summary: "GitHub mergeability is not yet known." }));
  if (input.mergeability === "CONFLICTING") blockers.push(DeliveryBlocker.make({ feedbackIds: [], kind: "mergeConflict", summary: "The pull request has merge conflicts." }));
  if (input.truncated) blockers.push(DeliveryBlocker.make({ feedbackIds: [], kind: "feedbackTruncated", summary: "GitHub evidence exceeded Gaia's bounded read." }));
  return blockers;
}

function isTruncated(pr: RawPullRequest, suites: ReadonlyArray<RawCheckSuite>) {
  return pr.comments.pageInfo.hasNextPage ||
    pr.reviews.pageInfo.hasNextPage ||
    pr.reviewThreads.pageInfo.hasNextPage ||
    pr.reviewThreads.nodes.some((thread) => thread.comments.pageInfo.hasNextPage) ||
    pr.commits.nodes[0]?.commit.checkSuites.pageInfo.hasNextPage === true ||
    suites.some((suite) => suite.checkRuns.pageInfo.hasNextPage);
}

function hasRemediationMarker(body: string) {
  return body.split(/\r?\n/u).find((line) => line.trim() !== "")?.trim() === remediationMarker;
}

function remediationText(body: string) {
  if (!hasRemediationMarker(body)) return body.trim().slice(0, 4_096);
  const lines = body.split(/\r?\n/u);
  const markerIndex = lines.findIndex((line) => line.trim() === remediationMarker);
  return lines.slice(markerIndex + 1).join("\n").trim().slice(0, 4_096);
}

function feedbackId(input: {
  readonly kind: "comment" | "review" | "thread";
  readonly nativeId: string;
  readonly prNumber: number;
  readonly repository: string;
}) {
  return parseDeliveryFeedbackId(
    `feedback-${input.kind}-${stableHash(`github-feedback-v1\0${input.repository}\0${input.prNumber}\0${input.kind}\0${input.nativeId}`)}`,
  );
}

function controlledCommentAuthorization(
  input: {
    readonly authorization?: DeliveryFeedbackSmokeAuthorization;
    readonly pr: RawPullRequest;
    readonly prNumber: number;
    readonly repository: string;
  },
  comment: RawComment,
) {
  const authorization = input.authorization;
  const actor = comment.author;
  const observedFeedbackId = feedbackId({
    kind: "comment",
    nativeId: String(comment.databaseId),
    prNumber: input.prNumber,
    repository: input.repository,
  });
  return authorization !== undefined &&
    actor !== null &&
    authorization.version === 1 &&
    authorization.marker === remediationMarker &&
    authorization.authorizationDigest ===
      deliveryFeedbackSmokeAuthorizationDigest(authorization) &&
    authorization.repository === input.repository &&
    authorization.prNumber === input.prNumber &&
    authorization.headSha === input.pr.headRefOid &&
    String(authorization.commentDatabaseId) === String(comment.databaseId) &&
    authorization.feedbackId === observedFeedbackId &&
    authorization.contentDigest === stableHash(comment.body) &&
    authorization.actorType === actor.__typename &&
    actor.__typename === "User" &&
    authorization.actorLogin === actor.login &&
    authorization.authorAssociation === comment.authorAssociation &&
    trustedAssociations.has(comment.authorAssociation) &&
    hasRemediationMarker(comment.body);
}

function checkState(check: RawCheckRun): "failing" | "passing" | "pending" {
  if (check.status !== "COMPLETED") return "pending";
  return check.conclusion !== null && passingConclusions.has(check.conclusion)
    ? "passing"
    : "failing";
}

function normalizeMergeability(value: string) {
  switch (value) {
    case "MERGEABLE": return "mergeable" as const;
    case "CONFLICTING": return "conflicting" as const;
    default: return "unknown" as const;
  }
}

function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseRepository(repository: string) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(repository);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw makeRuntimeError({ code: "GitHubRepositoryInvalid", message: "GitHub repository identity is invalid.", recoverable: false });
  }
  return { name: match[2], owner: match[1] };
}

const pullRequestQuery = `query GaiaDeliveryPullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author { __typename login }
      comments(first: 100) { nodes { author { __typename login } authorAssociation body databaseId updatedAt url } pageInfo { hasNextPage } }
      commits(last: 1) { nodes { commit { oid checkSuites(first: 50) { nodes { app { slug } workflowRun { workflow { name } } checkRuns(first: 100) { nodes { conclusion detailsUrl name status } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } }
      headRefOid isDraft mergeable reviewDecision url
      reviews(first: 100) { nodes { author { __typename login } authorAssociation body databaseId state updatedAt url } pageInfo { hasNextPage } }
      reviewThreads(first: 100) { nodes { id isResolved comments(first: 20) { nodes { author { __typename login } authorAssociation body databaseId outdated path pullRequestReview { state } updatedAt url } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }
    }
  }
}`;
