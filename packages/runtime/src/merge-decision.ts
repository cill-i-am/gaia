import {
  DeliveryTimestampSchema,
  encodeMergeDecisionV2Json,
  GitHubPullRequestSelectorSchema,
  makeMergeDecisionV2,
  MergeDecisionBlockerV2,
  MergeDecisionNextActionSchema,
  MergeDecisionStatusSchema,
  MergeDecisionV2,
  parseDeliveryTimestamp,
  parseGitHubPullRequestSelector,
  parseMergeDecisionV2,
  parseRunEventSequence,
  RunProofProjectionV1Schema,
  RunProofResultV1,
  RunEventSequenceSchema,
  RunIdSchema,
  StructuralDigestSchema,
  sortMergeDecisionBlockersV2,
  type MergeDecisionV2Binding,
  type RunId,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { parseBrowserEvidenceJson } from "./browser-evidence.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { appendEvent, loadRun } from "./event-store.js";
import {
  parseGitHubPrLoopStateJson,
  type GitHubPrLoopState,
} from "./github-publisher.js";
import {
  makeRunPaths,
  parseRunRelativeArtifactPath,
  runRelative,
  RunRelativeArtifactPathSchema,
  RuntimePathSchema,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import { parseReviewerSessionEvidenceJson } from "./reviewer-session-evidence.js";
import { parseRunProfileJson } from "./run-profile.js";
import { withRunStoreLock } from "./run-store-lock.js";
import { observeWorkspaceStructuralDigest } from "./workspace-snapshot.js";

export {
  MergeDecisionNextActionSchema,
  MergeDecisionStatusSchema,
  MergeDecisionV2,
};
export type MergeDecisionStatus = typeof MergeDecisionStatusSchema.Type;
export type MergeDecisionNextAction = typeof MergeDecisionNextActionSchema.Type;

/** Decode-only historical blocker vocabulary. */
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

/** Decode-only historical V1 blocker. */
export class MergeDecisionBlocker extends Schema.Class<MergeDecisionBlocker>(
  "MergeDecisionBlocker"
)({
  action: Schema.NonEmptyString,
  artifactPath: Schema.optionalKey(RunRelativeArtifactPathSchema),
  kind: MergeDecisionBlockerKindSchema,
  summary: Schema.NonEmptyString,
}) {}

const MergeDecisionBlockerCountSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
).pipe(Schema.brand("MergeDecisionBlockerCount"));

/** Decode-only historical V1 decision. New writes always emit V2. */
export class MergeDecision extends Schema.Class<MergeDecision>("MergeDecision")(
  {
    blockerCount: MergeDecisionBlockerCountSchema,
    blockers: Schema.Array(MergeDecisionBlocker),
    decidedAt: DeliveryTimestampSchema,
    evidenceReviewPath: RunRelativeArtifactPathSchema,
    evidenceReviewerSessionPath: RunRelativeArtifactPathSchema,
    nextAction: MergeDecisionNextActionSchema,
    planReviewPath: RunRelativeArtifactPathSchema,
    planReviewerSessionPath: RunRelativeArtifactPathSchema,
    pr: Schema.optionalKey(GitHubPullRequestSelectorSchema),
    prLoopPath: RunRelativeArtifactPathSchema,
    runId: RunIdSchema,
    runProfilePath: RunRelativeArtifactPathSchema,
    status: MergeDecisionStatusSchema,
    version: Schema.Literal(1),
  }
) {}

export class MergeDecisionSummary extends Schema.Class<MergeDecisionSummary>(
  "MergeDecisionSummary"
)({
  blockerCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  blockers: Schema.Array(MergeDecisionBlockerV2),
  decisionPath: RuntimePathSchema,
  nextAction: MergeDecisionNextActionSchema,
  pr: Schema.optionalKey(GitHubPullRequestSelectorSchema),
  runId: RunIdSchema,
  status: MergeDecisionStatusSchema,
}) {}

const LegacyMergeDecisionJson = Schema.toCodecJson(MergeDecision);
const parseLegacyMergeDecision = Schema.decodeUnknownSync(
  LegacyMergeDecisionJson
);

/** Parse either historical V1 or current proof-bound V2 persisted JSON. */
export function parseMergeDecisionJson(input: unknown) {
  if (
    typeof input === "object" &&
    input !== null &&
    "version" in input &&
    input.version === 2
  )
    return parseMergeDecisionV2(input);
  return parseLegacyMergeDecision(input);
}

/** Record current proof-bound merge readiness while the delivery run is live. */
export function recordMergeDecision(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return withRunStoreLock(options, recordMergeDecisionUnlocked(runId, options));
}

function recordMergeDecisionUnlocked(runId: RunId, options: RunStorageOptions) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const paths = yield* makeRunPaths(runId, { rootDirectory });
    const loaded = yield* loadRun(paths);
    if (loaded.latestSnapshot?.state !== "delivering")
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotDelivering",
          message: `Run ${runId} must be in delivering state before MergeDecisionV2 is recorded.`,
          recoverable: false,
        })
      );

    const events = loaded.events;
    const replayProof = loaded.latestSnapshot.context["runProof"];
    const observed = yield* observeWorkspaceStructuralDigest(paths.workspace);
    const contentAuthoritySequence = parseRunEventSequence(
      Math.max(
        1,
        ...events
          .filter(
            (event) =>
              event.type === "WORKER_COMPLETED" ||
              event.type === "WORKER_CONTINUATION_RECORDED" ||
              event.type === "DELIVERY_REMEDIATION_RECORDED"
          )
          .map((event) => event.sequence)
      )
    );
    const evidenceReviewEvent = events.findLast(
      (event) =>
        event.type === "REVIEW_COMPLETED" &&
        event.payload["phase"] === "evidence"
    );
    const publicationEvent = events.findLast(
      (event) => event.type === "DELIVERY_PUBLICATION_CONFIRMED"
    );
    const proof = decodeProofProjection(replayProof);
    const proofResult =
      proof?.kind === "contract" ? proof.latestResult : undefined;
    const decisionProof =
      proof?.kind === "contract"
        ? {
            contractDigest: proof.contract.contractDigest,
            contractId: proof.contract.contractId,
            kind: "contract" as const,
            result:
              proofResult === undefined
                ? { kind: "missing" as const }
                : {
                    aggregate: proofResult.aggregate,
                    kind: "recorded" as const,
                    observedTargetDigest: proofResult.observedTargetDigest,
                    resultDigest: proofResult.resultDigest,
                    sequence: proofResult.recordedBy.sequence,
                  },
          }
        : {
            aggregate: "completed-unverified" as const,
            kind: "noContract" as const,
            ...(proof?.kind === "no-contract" &&
            proof.legacyVerification !== undefined
              ? {
                  legacyVerificationSequence:
                    proof.legacyVerification.recordedBy.sequence,
                }
              : {}),
          };
    const proofBlockers = proofDecisionBlockers({
      contentAuthoritySequence,
      currentDigest: observed.digest,
      proof,
      ...(proofResult === undefined ? {} : { proofResult }),
      ...(evidenceReviewEvent === undefined
        ? {}
        : { evidenceReviewSequence: evidenceReviewEvent.sequence }),
      ...(publicationEvent === undefined
        ? {}
        : { publicationSequence: publicationEvent.sequence }),
    });
    const prLoop = yield* readOptionalGitHubPrLoopState(paths);
    const blockers = sortMergeDecisionBlockersV2([
      ...proofBlockers,
      ...prLoopBlockers(prLoop, paths),
      ...(yield* reviewerEvidenceBlockers(paths)),
      ...(yield* browserEvidenceBlockers(paths)),
    ]);
    const status = blockers.length === 0 ? "approved" : "blocked";
    const nextAction =
      status === "approved" ? "ready-to-merge" : "resolve-blockers";
    const binding: MergeDecisionV2Binding = {
      blockerCount: blockers.length,
      blockers,
      contentAuthoritySequence,
      decidedAt: parseDeliveryTimestamp(new Date().toISOString()),
      evidenceReviewPath: runArtifactPath(paths, paths.evidenceReviewMarkdown),
      ...(evidenceReviewEvent === undefined
        ? {}
        : {
            evidenceReviewSequence: parseRunEventSequence(
              evidenceReviewEvent.sequence
            ),
          }),
      evidenceReviewerSessionPath: runArtifactPath(
        paths,
        paths.evidenceReviewerSession
      ),
      nextAction,
      planReviewPath: runArtifactPath(paths, paths.planReviewMarkdown),
      planReviewerSessionPath: runArtifactPath(
        paths,
        paths.planReviewerSession
      ),
      ...(prLoop === undefined ? {} : { pr: prLoop.pr }),
      proof: decisionProof,
      ...(publicationEvent === undefined
        ? {}
        : {
            publicationConfirmationSequence: parseRunEventSequence(
              publicationEvent.sequence
            ),
          }),
      runId,
      runProfilePath: runArtifactPath(paths, paths.runProfile),
      status,
      version: 2,
    };
    const decision = makeMergeDecisionV2(binding);
    const mergeDecisionPath = runArtifactPath(paths, paths.mergeDecision);

    yield* appendEvent(runId, paths, {
      payload: {
        decision: encodeMergeDecisionV2Json(decision),
        mergeDecisionPath,
      },
      type: "MERGE_DECISION_RECORDED",
    });
    yield* writeMergeDecision(paths, decision);

    return MergeDecisionSummary.make({
      blockerCount: blockers.length,
      blockers,
      decisionPath: paths.mergeDecision,
      nextAction,
      ...(decision.pr === undefined
        ? {}
        : { pr: parseGitHubPullRequestSelector(decision.pr) }),
      runId,
      status,
    });
  });
}

function decodeProofProjection(input: unknown) {
  if (input === undefined) return undefined;
  return Schema.decodeUnknownSync(RunProofProjectionV1Schema)(input);
}

const ProofDecisionBlockersInputSchema = Schema.Struct({
  contentAuthoritySequence: RunEventSequenceSchema,
  currentDigest: StructuralDigestSchema,
  evidenceReviewSequence: Schema.optionalKey(RunEventSequenceSchema),
  proof: Schema.UndefinedOr(RunProofProjectionV1Schema),
  proofResult: Schema.optionalKey(RunProofResultV1),
  publicationSequence: Schema.optionalKey(RunEventSequenceSchema),
});
const decodeProofDecisionBlockersInput = Schema.decodeUnknownSync(
  ProofDecisionBlockersInputSchema
);

function proofDecisionBlockers(
  input: typeof ProofDecisionBlockersInputSchema.Encoded
) {
  const decoded = decodeProofDecisionBlockersInput(input);
  const blockers: MergeDecisionBlockerV2[] = [];
  if (decoded.proof?.kind !== "contract")
    blockers.push(
      proofBlocker(
        "run-contract-missing",
        "No contract-bound proof is present."
      )
    );
  else if (decoded.proofResult === undefined)
    blockers.push(
      proofBlocker(
        "run-proof-result-missing",
        "No run-proof result is present."
      )
    );
  else {
    if (decoded.proofResult.aggregate !== "verified")
      blockers.push(
        proofBlocker(
          "run-proof-not-verified",
          `Run proof aggregate is '${decoded.proofResult.aggregate}'.`
        )
      );
    if (
      decoded.proofResult.observedTargetDigest !== decoded.currentDigest ||
      decoded.proofResult.recordedBy.sequence < decoded.contentAuthoritySequence
    )
      blockers.push(
        proofBlocker(
          "run-proof-stale",
          "Run proof predates current content authority or observes another digest."
        )
      );
    if (
      decoded.evidenceReviewSequence === undefined ||
      decoded.evidenceReviewSequence <= decoded.proofResult.recordedBy.sequence
    )
      blockers.push(
        proofBlocker(
          "evidence-review-stale",
          "Evidence review must be newer than the latest proof result."
        )
      );
  }
  if (decoded.publicationSequence === undefined)
    blockers.push(
      proofBlocker(
        "delivery-publication-missing",
        "Delivery publication is not confirmed for this run."
      )
    );
  return blockers;
}

function proofBlocker(
  kind:
    | "run-contract-missing"
    | "run-proof-result-missing"
    | "run-proof-not-verified"
    | "run-proof-stale"
    | "evidence-review-stale"
    | "delivery-publication-missing",
  summary: string
) {
  return MergeDecisionBlockerV2.make({
    action:
      "Record fresh, contract-bound proof and review before deciding merge.",
    kind,
    summary,
  });
}

function prLoopBlockers(
  prLoop: GitHubPrLoopState | undefined,
  paths: RunPaths
) {
  if (prLoop === undefined) return [];
  if (
    prLoop.status === "ready" &&
    prLoop.nextAction === "ready-for-merge-decision" &&
    (prLoop.checksStatus === "green" ||
      prLoop.checksStatus === "no-checks-configured")
  )
    return [];
  return [
    MergeDecisionBlockerV2.make({
      action: prLoop.nextAction,
      artifactPath: runArtifactPath(paths, paths.prLoopState),
      kind: "pr-loop-not-ready",
      summary: `PR-loop status is '${prLoop.status}' with checks '${prLoop.checksStatus}'.`,
    }),
  ];
}

function reviewerEvidenceBlockers(paths: RunPaths) {
  return Effect.gen(function* () {
    const plan = yield* readOptionalReviewerSession(paths.planReviewerSession);
    const evidence = yield* readOptionalReviewerSession(
      paths.evidenceReviewerSession
    );
    const blockers: MergeDecisionBlockerV2[] = [];
    for (const [phase, value, path] of [
      ["Plan", plan, paths.planReviewerSession],
      ["Evidence", evidence, paths.evidenceReviewerSession],
    ] as const) {
      if (value === undefined)
        blockers.push(
          MergeDecisionBlockerV2.make({
            action: `Record ${phase.toLowerCase()} reviewer evidence.`,
            artifactPath: runArtifactPath(paths, path),
            kind: "reviewer-evidence-missing",
            summary: `${phase} reviewer session evidence is missing.`,
          })
        );
      else if (value.decisionStatus !== "approved")
        blockers.push(
          MergeDecisionBlockerV2.make({
            action: `Resolve the ${phase.toLowerCase()} reviewer finding.`,
            artifactPath: runArtifactPath(paths, path),
            kind: "reviewer-blocked",
            summary: `${phase} reviewer did not approve the run.`,
          })
        );
    }
    return blockers;
  });
}

function browserEvidenceBlockers(paths: RunPaths) {
  return Effect.gen(function* () {
    const profile = yield* readRunProfile(paths);
    if (profile.checks.browserEvidence !== "required") return [];
    const evidence = yield* readOptionalBrowserEvidence(paths);
    if (evidence?.status === "collected") return [];
    return [
      MergeDecisionBlockerV2.make({
        action: "Collect required browser evidence before deciding merge.",
        artifactPath: runArtifactPath(paths, paths.browserEvidence),
        kind:
          evidence === undefined
            ? "browser-evidence-missing"
            : "browser-evidence-failed",
        summary:
          evidence === undefined
            ? "Required browser evidence is missing."
            : `Required browser evidence status is '${evidence.status}'.`,
      }),
    ];
  });
}

function writeMergeDecision(paths: RunPaths, decision: MergeDecisionV2) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      paths.mergeDecision,
      `${JSON.stringify(encodeMergeDecisionV2Json(decision), null, 2)}\n`
    );
    return decision;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "MergeDecisionWriteFailed",
          message: "Gaia could not write MergeDecisionV2.",
          recoverable: true,
        })
      )
    )
  );
}

function readOptionalGitHubPrLoopState(paths: RunPaths) {
  return readOptionalJsonFile(
    paths.prLoopState,
    parseGitHubPrLoopStateJson,
    "GitHubPrLoopState"
  );
}
function readOptionalReviewerSession(path: typeof RuntimePathSchema.Type) {
  return readOptionalJsonFile(
    path,
    parseReviewerSessionEvidenceJson,
    "ReviewerSessionEvidence"
  );
}
function readOptionalBrowserEvidence(paths: RunPaths) {
  return readOptionalJsonFile(
    paths.browserEvidence,
    parseBrowserEvidenceJson,
    "BrowserEvidence"
  );
}
function readRunProfile(paths: RunPaths) {
  return readRequiredJsonFile(
    paths.runProfile,
    parseRunProfileJson,
    "RunProfile"
  );
}

function readOptionalJsonFile<A>(
  path: typeof RuntimePathSchema.Type,
  parse: (input: unknown) => A,
  label: string
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path))) return undefined;
    return yield* decodeJson(yield* fs.readFileString(path), parse, label);
  }).pipe(Effect.mapError((cause) => jsonReadError(cause, label)));
}
function readRequiredJsonFile<A>(
  path: typeof RuntimePathSchema.Type,
  parse: (input: unknown) => A,
  label: string
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* decodeJson(yield* fs.readFileString(path), parse, label);
  }).pipe(Effect.mapError((cause) => jsonReadError(cause, label)));
}
function decodeJson<A>(
  text: string,
  parse: (input: unknown) => A,
  label: string
) {
  return Effect.try({
    catch: (cause) => jsonReadError(cause, label),
    try: () => parse(JSON.parse(text)),
  });
}
function jsonReadError(cause: unknown, label: string) {
  return makeRuntimeError({
    cause,
    code: `${label}Invalid`,
    message: `${label} did not match Gaia's expected schema.`,
    recoverable: false,
  });
}
function runArtifactPath(
  paths: RunPaths,
  absolutePath: typeof RuntimePathSchema.Type
) {
  return parseRunRelativeArtifactPath(runRelative(paths, absolutePath));
}
