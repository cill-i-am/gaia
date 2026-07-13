import {
  deliveryMergeMethodArguments,
  type DeliveryMergeMethod,
  type DeliveryRequiredCheckIdentity,
} from "@gaia/core";
import { Data, Effect } from "effect";
import { makeRuntimeError } from "./errors.js";
import {
  nodeGitHubCommandRunner,
  type GitHubCommandRunner,
} from "./github-publisher.js";

export type DeliveryMergeProviderInput = {
  readonly cwd: string;
  readonly expectedHeadSha: string;
  readonly method: DeliveryMergeMethod;
  readonly prUrl: string;
  readonly repository: string;
};
export class DeliveryMergeConclusivelyRejected extends Data.TaggedError("DeliveryMergeConclusivelyRejected")<{
  readonly message: string;
}> {}

export class DeliveryReadyForReviewOutcomeUncertain extends Data.TaggedError("DeliveryReadyForReviewOutcomeUncertain")<{
  readonly message: string;
}> {}

export class DeliveryReadyForReviewConclusivelyRejected extends Data.TaggedError("DeliveryReadyForReviewConclusivelyRejected")<{
  readonly message: string;
}> {}

export type DeliveryReadyForReviewProviderInput = {
  readonly cwd: string;
  readonly prUrl: string;
  readonly repository: string;
};

/** Invoke one exact ready-for-review mutation without branch inference. */
export function invokeGitHubReadyForReview(
  input: DeliveryReadyForReviewProviderInput,
  commandRunner: GitHubCommandRunner = nodeGitHubCommandRunner,
) {
  return commandRunner({
    args: ["pr", "ready", input.prUrl, "--repo", input.repository],
    command: "gh",
    cwd: input.cwd,
  }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(new DeliveryReadyForReviewOutcomeUncertain({
            message: "GitHub did not return a confirmable ready-for-review result.",
          })),
    ),
  );
}

/** Invoke exactly one explicitly selected expected-head-protected GitHub merge. */
export function invokeGitHubDeliveryMerge(
  input: DeliveryMergeProviderInput,
  commandRunner: GitHubCommandRunner = nodeGitHubCommandRunner,
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
        : Effect.fail(new DeliveryMergeConclusivelyRejected({ message: "GitHub conclusively rejected the exact-head merge request." })),
    ),
  );
}

export type RequiredCheckFact = {
  readonly appSlug: string;
  readonly headSha: string;
  readonly name: string;
  readonly state: "failed" | "passing" | "pending" | "unparseable";
  readonly repository: string;
  readonly workflow: string;
};

/** Exact stable-field join; extras are ignored and duplicates fail closed. */
export function validateRequiredChecks(
  policy: ReadonlyArray<typeof DeliveryRequiredCheckIdentity.Type>,
  observations: ReadonlyArray<RequiredCheckFact>,
  expectedHeadSha: string,
) {
  for (const required of policy) {
    const matches = observations.filter((candidate) =>
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
