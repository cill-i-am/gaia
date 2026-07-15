import {
  DeliveryGitShaPublicSchema,
  deliveryMergeMethodArguments,
  GitHubCheckFieldPublicSchema,
  GitHubPullRequestUrlPublicSchema,
  GitHubRepositoryPublicSchema,
  type DeliveryMergeMethod,
  type DeliveryRequiredCheckIdentity,
} from "@gaia/core";
import { Effect, Schema } from "effect";

import { makeRuntimeError } from "./errors.js";
import {
  nodeGitHubCommandRunner,
  type GitHubCommandRunner,
} from "./github-publisher.js";
import { RuntimePathTextSchema } from "./paths.js";

export const DeliveryMergeProviderInputSchema = Schema.Struct({
  cwd: RuntimePathTextSchema,
  expectedHeadSha: DeliveryGitShaPublicSchema,
  method: Schema.declare<DeliveryMergeMethod>(
    (input): input is DeliveryMergeMethod =>
      typeof input === "string" && input in deliveryMergeMethodArguments
  ),
  prUrl: GitHubPullRequestUrlPublicSchema,
  repository: GitHubRepositoryPublicSchema,
});

export type DeliveryMergeProviderInput =
  typeof DeliveryMergeProviderInputSchema.Type;

export class DeliveryMergeConclusivelyRejected extends Schema.TaggedErrorClass<DeliveryMergeConclusivelyRejected>()(
  "DeliveryMergeConclusivelyRejected",
  {
    message: Schema.String,
  }
) {}

export class DeliveryReadyForReviewOutcomeUncertain extends Schema.TaggedErrorClass<DeliveryReadyForReviewOutcomeUncertain>()(
  "DeliveryReadyForReviewOutcomeUncertain",
  {
    message: Schema.String,
  }
) {}

export class DeliveryReadyForReviewConclusivelyRejected extends Schema.TaggedErrorClass<DeliveryReadyForReviewConclusivelyRejected>()(
  "DeliveryReadyForReviewConclusivelyRejected",
  {
    message: Schema.String,
  }
) {}

export const DeliveryReadyForReviewProviderInputSchema = Schema.Struct({
  cwd: RuntimePathTextSchema,
  prUrl: GitHubPullRequestUrlPublicSchema,
  repository: GitHubRepositoryPublicSchema,
});

export type DeliveryReadyForReviewProviderInput =
  typeof DeliveryReadyForReviewProviderInputSchema.Type;

/** Invoke one exact ready-for-review mutation without branch inference. */
export function invokeGitHubReadyForReview(
  input: DeliveryReadyForReviewProviderInput,
  commandRunner: GitHubCommandRunner = nodeGitHubCommandRunner
) {
  return commandRunner({
    args: ["pr", "ready", input.prUrl, "--repo", input.repository],
    command: "gh",
    cwd: input.cwd,
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            DeliveryReadyForReviewOutcomeUncertain.make({
              message:
                "GitHub did not return a confirmable ready-for-review result.",
            })
          )
    )
  );
}

/** Invoke exactly one explicitly selected expected-head-protected GitHub merge. */
export function invokeGitHubDeliveryMerge(
  input: DeliveryMergeProviderInput,
  commandRunner: GitHubCommandRunner = nodeGitHubCommandRunner
) {
  const methodArgs = deliveryMergeMethodArguments[input.method];
  return commandRunner({
    args: [
      "pr",
      "merge",
      input.prUrl,
      ...methodArgs,
      "--match-head-commit",
      input.expectedHeadSha,
      "--repo",
      input.repository,
    ],
    command: "gh",
    cwd: input.cwd,
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            DeliveryMergeConclusivelyRejected.make({
              message:
                "GitHub conclusively rejected the exact-head merge request.",
            })
          )
    )
  );
}

export const RequiredCheckFactSchema = Schema.Struct({
  appSlug: GitHubCheckFieldPublicSchema,
  headSha: DeliveryGitShaPublicSchema,
  name: GitHubCheckFieldPublicSchema,
  repository: GitHubRepositoryPublicSchema,
  state: Schema.Literals([
    "failed",
    "passing",
    "pending",
    "unparseable",
  ] as const),
  workflow: GitHubCheckFieldPublicSchema,
});

export type RequiredCheckFact = typeof RequiredCheckFactSchema.Type;

/** Exact stable-field join; extras are ignored and duplicates fail closed. */
export function validateRequiredChecks(
  policy: ReadonlyArray<typeof DeliveryRequiredCheckIdentity.Type>,
  observations: ReadonlyArray<RequiredCheckFact>,
  expectedHeadSha: typeof DeliveryGitShaPublicSchema.Type
) {
  for (const required of policy) {
    const matches = observations.filter(
      (candidate) =>
        candidate.appSlug === required.appSlug &&
        candidate.name === required.name &&
        candidate.repository === required.repository &&
        candidate.workflow === required.workflow
    );
    if (
      matches.length !== 1 ||
      matches[0]?.headSha !== expectedHeadSha ||
      matches[0]?.state !== "passing"
    ) {
      return false;
    }
  }
  return true;
}
