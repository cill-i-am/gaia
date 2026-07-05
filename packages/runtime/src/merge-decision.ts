import { RunIdSchema } from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";
import { parseBrowserEvidenceJson } from "./browser-evidence.js";
import { appendEvent } from "./event-store.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import {
  parseGitHubPrLoopStateJson,
  type GitHubPrLoopState,
} from "./github-publisher.js";
import {
  makeRunPaths,
  runRelative,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import { parseReviewerSessionEvidenceJson } from "./reviewer-session-evidence.js";
import { parseRunProfileJson } from "./run-profile.js";
import { withRunStoreLock } from "./run-store-lock.js";
import { statusRun } from "./workflows.js";

export const MergeDecisionStatusSchema = Schema.Literals([
  "approved",
  "blocked",
] as const);

export type MergeDecisionStatus = typeof MergeDecisionStatusSchema.Type;

export const MergeDecisionNextActionSchema = Schema.Literals([
  "ready-to-merge",
  "resolve-blockers",
] as const);

export type MergeDecisionNextAction =
  typeof MergeDecisionNextActionSchema.Type;

export const MergeDecisionBlockerKindSchema = Schema.Literals([
  "browser-evidence-failed",
  "browser-evidence-missing",
  "missing-pr-loop",
  "pr-loop-not-ready",
  "reviewer-blocked",
  "reviewer-evidence-missing",
] as const);

export type MergeDecisionBlockerKind =
  typeof MergeDecisionBlockerKindSchema.Type;

export class MergeDecisionBlocker extends Schema.Class<MergeDecisionBlocker>(
  "MergeDecisionBlocker",
)({
  action: Schema.NonEmptyString,
  artifactPath: Schema.optionalKey(Schema.NonEmptyString),
  kind: MergeDecisionBlockerKindSchema,
  summary: Schema.NonEmptyString,
}) {}

const MergeDecisionBlockerCountSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("MergeDecisionBlockerCount"));

type MergeDecisionBlockerCount =
  typeof MergeDecisionBlockerCountSchema.Type;

export class MergeDecision extends Schema.Class<MergeDecision>(
  "MergeDecision",
)({
  blockerCount: MergeDecisionBlockerCountSchema,
  blockers: Schema.Array(MergeDecisionBlocker),
  decidedAt: Schema.NonEmptyString,
  evidenceReviewPath: Schema.NonEmptyString,
  evidenceReviewerSessionPath: Schema.NonEmptyString,
  nextAction: MergeDecisionNextActionSchema,
  planReviewPath: Schema.NonEmptyString,
  planReviewerSessionPath: Schema.NonEmptyString,
  pr: Schema.optionalKey(Schema.NonEmptyString),
  prLoopPath: Schema.NonEmptyString,
  runId: RunIdSchema,
  runProfilePath: Schema.NonEmptyString,
  status: MergeDecisionStatusSchema,
  version: Schema.Literal(1),
}) {}

export class MergeDecisionSummary extends Schema.Class<MergeDecisionSummary>(
  "MergeDecisionSummary",
)({
  blockerCount: MergeDecisionBlockerCountSchema,
  blockers: Schema.Array(MergeDecisionBlocker),
  decisionPath: Schema.NonEmptyString,
  nextAction: MergeDecisionNextActionSchema,
  pr: Schema.optionalKey(Schema.NonEmptyString),
  runId: RunIdSchema,
  status: MergeDecisionStatusSchema,
}) {}

const MergeDecisionJson = Schema.toCodecJson(MergeDecision);
const encodeMergeDecisionJson = Schema.encodeSync(MergeDecisionJson);

/** Parse a persisted merge decision from decoded JSON. */
export const parseMergeDecisionJson =
  Schema.decodeUnknownSync(MergeDecisionJson);

/** Record Gaia's explicit merge decision for a completed run. */
export function recordMergeDecision(
  runIdInput: string,
  options: RunStorageOptions = {},
) {
  return withRunStoreLock(
    options,
    recordMergeDecisionUnlocked(runIdInput, options),
  );
}

function recordMergeDecisionUnlocked(
  runIdInput: string,
  options: RunStorageOptions,
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const run = yield* statusRun(runIdInput, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before recording a merge decision.`,
          recoverable: false,
        }),
      );
    }

    const paths = yield* makeRunPaths(run.runId, { rootDirectory });
    const prLoop = yield* readOptionalGitHubPrLoopState(paths);
    const blockers = [
      ...prLoopBlockers(prLoop, paths),
      ...(yield* reviewerEvidenceBlockers(paths)),
      ...(yield* browserEvidenceBlockers(paths)),
    ];
    const status: MergeDecisionStatus =
      blockers.length === 0 ? "approved" : "blocked";
    const nextAction: MergeDecisionNextAction =
      status === "approved" ? "ready-to-merge" : "resolve-blockers";
    const decision = MergeDecision.make({
      blockerCount: parseMergeDecisionBlockerCount(blockers.length),
      blockers,
      decidedAt: new Date().toISOString(),
      evidenceReviewPath: runRelative(paths, paths.evidenceReviewMarkdown),
      evidenceReviewerSessionPath: runRelative(
        paths,
        paths.evidenceReviewerSession,
      ),
      nextAction,
      planReviewPath: runRelative(paths, paths.planReviewMarkdown),
      planReviewerSessionPath: runRelative(paths, paths.planReviewerSession),
      ...(prLoop === undefined ? {} : { pr: prLoop.pr }),
      prLoopPath: runRelative(paths, paths.prLoopState),
      runId: run.runId,
      runProfilePath: runRelative(paths, paths.runProfile),
      status,
      version: 1,
    });

    yield* writeMergeDecision(paths, decision);

    const mergeDecisionPath = runRelative(paths, paths.mergeDecision);

    yield* appendEvent(run.runId, paths, {
      payload: {
        blockerCount: decision.blockerCount,
        mergeDecisionPath,
        nextAction: decision.nextAction,
        ...(decision.pr === undefined ? {} : { pullRequest: decision.pr }),
        status: decision.status,
      },
      type: "MERGE_DECISION_RECORDED",
    });

    return MergeDecisionSummary.make({
      blockerCount: decision.blockerCount,
      blockers: decision.blockers,
      decisionPath: paths.mergeDecision,
      nextAction: decision.nextAction,
      ...(decision.pr === undefined ? {} : { pr: decision.pr }),
      runId: decision.runId,
      status: decision.status,
    });
  });
}

function prLoopBlockers(
  prLoop: GitHubPrLoopState | undefined,
  paths: RunPaths,
) {
  if (prLoop === undefined) {
    return [
      MergeDecisionBlocker.make({
        action: "Run `gaia pr-loop <run-id> <pull-request>` before deciding.",
        artifactPath: runRelative(paths, paths.prLoopState),
        kind: "missing-pr-loop",
        summary: "Gaia has no PR-loop state for this run.",
      }),
    ];
  }

  if (
    prLoop.status === "ready" &&
    prLoop.nextAction === "ready-for-merge-decision" &&
    prLoop.checksStatus === "passed"
  ) {
    return [];
  }

  return [
    MergeDecisionBlocker.make({
      action: prLoop.nextAction,
      artifactPath: runRelative(paths, paths.prLoopState),
      kind: "pr-loop-not-ready",
      summary: `PR-loop status is '${prLoop.status}' with checks '${prLoop.checksStatus}' and next action '${prLoop.nextAction}'.`,
    }),
  ];
}

function reviewerEvidenceBlockers(paths: RunPaths) {
  return Effect.gen(function* () {
    const plan = yield* readOptionalReviewerSession(paths.planReviewerSession);
    const evidence = yield* readOptionalReviewerSession(
      paths.evidenceReviewerSession,
    );
    const blockers: Array<MergeDecisionBlocker> = [];

    if (plan === undefined) {
      blockers.push(
        MergeDecisionBlocker.make({
          action: "Rerun the Gaia run with plan reviewer evidence enabled.",
          artifactPath: runRelative(paths, paths.planReviewerSession),
          kind: "reviewer-evidence-missing",
          summary: "Plan reviewer session evidence is missing.",
        }),
      );
    } else if (plan.decisionStatus !== "approved") {
      blockers.push(
        MergeDecisionBlocker.make({
          action: "Resolve the plan reviewer finding before deciding merge.",
          artifactPath: runRelative(paths, paths.planReviewerSession),
          kind: "reviewer-blocked",
          summary: "Plan reviewer did not approve the run.",
        }),
      );
    }

    if (evidence === undefined) {
      blockers.push(
        MergeDecisionBlocker.make({
          action: "Rerun the Gaia run with evidence reviewer evidence enabled.",
          artifactPath: runRelative(paths, paths.evidenceReviewerSession),
          kind: "reviewer-evidence-missing",
          summary: "Evidence reviewer session evidence is missing.",
        }),
      );
    } else if (evidence.decisionStatus !== "approved") {
      blockers.push(
        MergeDecisionBlocker.make({
          action: "Resolve the evidence reviewer finding before deciding merge.",
          artifactPath: runRelative(paths, paths.evidenceReviewerSession),
          kind: "reviewer-blocked",
          summary: "Evidence reviewer did not approve the run.",
        }),
      );
    }

    return blockers;
  });
}

function browserEvidenceBlockers(paths: RunPaths) {
  return Effect.gen(function* () {
    const profile = yield* readRunProfile(paths);

    if (profile.checks.browserEvidence !== "required") {
      return [];
    }

    const evidence = yield* readOptionalBrowserEvidence(paths);

    if (evidence === undefined) {
      return [
        MergeDecisionBlocker.make({
          action: "Collect browser evidence for this run before deciding merge.",
          artifactPath: runRelative(paths, paths.browserEvidence),
          kind: "browser-evidence-missing",
          summary: "Run profile requires browser evidence, but none is recorded.",
        }),
      ];
    }

    if (evidence.status !== "collected") {
      return [
        MergeDecisionBlocker.make({
          action: "Fix and recollect browser evidence before deciding merge.",
          artifactPath: runRelative(paths, paths.browserEvidence),
          kind: "browser-evidence-failed",
          summary: `Run profile requires browser evidence, but status is '${evidence.status}'.`,
        }),
      ];
    }

    return [];
  });
}

function writeMergeDecision(
  paths: RunPaths,
  decision: MergeDecision,
): Effect.Effect<MergeDecision, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* fs.writeFileString(
      paths.mergeDecision,
      `${JSON.stringify(encodeMergeDecisionJson(decision), null, 2)}\n`,
    );

    return decision;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "MergeDecisionWriteFailed",
          message: "Gaia could not write the merge decision artifact.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function readOptionalGitHubPrLoopState(paths: RunPaths) {
  return readOptionalJsonFile(
    paths.prLoopState,
    parseGitHubPrLoopStateJson,
    "GitHubPrLoopState",
  );
}

function readOptionalReviewerSession(path: string) {
  return readOptionalJsonFile(
    path,
    parseReviewerSessionEvidenceJson,
    "ReviewerSessionEvidence",
  );
}

function readOptionalBrowserEvidence(paths: RunPaths) {
  return readOptionalJsonFile(
    paths.browserEvidence,
    parseBrowserEvidenceJson,
    "BrowserEvidence",
  );
}

function readRunProfile(paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(paths.runProfile);
    const parsed = yield* parseJson(contents, paths.runProfile);

    return yield* parseJsonValue(parsed, parseRunProfileJson, "RunProfile");
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "RunProfileReadFailed",
          message: "Gaia could not read run-profile.json for merge decision.",
          recoverable: false,
        }),
      ),
    ),
  );
}

function readOptionalJsonFile<A>(
  path: string,
  parse: (input: unknown) => A,
  label: string,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path);

    if (!exists) {
      return undefined;
    }

    const contents = yield* fs.readFileString(path);
    const parsed = yield* parseJson(contents, path);

    return yield* parseJsonValue(parsed, parse, label);
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: `${label}ReadFailed`,
          message: `Gaia could not read ${path}.`,
          recoverable: true,
        }),
      ),
    ),
  );
}

function parseJson(text: string, path: string) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "MergeDecisionJsonInvalid",
        message: `${path} is not valid JSON.`,
        recoverable: true,
      }),
    try: () => JSON.parse(text) as unknown,
  });
}

function parseJsonValue<A>(
  input: unknown,
  parse: (input: unknown) => A,
  label: string,
) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: `${label}Invalid`,
        message: `${label} did not match Gaia's expected schema.`,
        recoverable: true,
      }),
    try: () => parse(input),
  });
}

function parseMergeDecisionBlockerCount(
  count: number,
): MergeDecisionBlockerCount {
  return Schema.decodeUnknownSync(MergeDecisionBlockerCountSchema)(count);
}
