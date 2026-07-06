import {
  DogfoodFinding,
  DogfoodFindingSource,
  DogfoodRetrospective,
  LinearCandidateIssue,
  type DogfoodFindingCategory,
  type DogfoodFindingSeverity,
  type RunEvent,
  type RunId,
} from "@gaia/core";
import { Effect, FileSystem, Path, Schema } from "effect";
import { loadRun } from "./event-store.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { HarnessRunResult } from "./harness.js";
import { runRelative, type RunPaths } from "./paths.js";
import { ReviewResult } from "./reviewer.js";
import {
  parseWorkspacePrQualityGateJson,
  type WorkspacePrQualityGate,
  type WorkspacePrQualityGateItem,
} from "./workspace-pr-gate.js";

const noisePathPattern = /(?:^|\/)(node_modules|dist|\.turbo)(?:\/|$)/u;
const genericPlanPattern = /\bgeneric\b|\bconcrete\b|\bsurface/u;
const noisyChangedPathThreshold = 100;
const safeSummaryMaxLength = 240;

const ReviewResultJson = Schema.toCodecJson(ReviewResult);
const parseReviewResultJson: (input: unknown) => ReviewResult =
  Schema.decodeUnknownSync(ReviewResultJson);
const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const parseHarnessRunResultJson: (input: unknown) => HarnessRunResult =
  Schema.decodeUnknownSync(HarnessRunResultJson);
const DogfoodRetrospectiveJson = Schema.toCodecJson(DogfoodRetrospective);
const encodeDogfoodRetrospectiveJson = Schema.encodeSync(
  DogfoodRetrospectiveJson,
);

type DraftFinding = {
  readonly category: DogfoodFindingCategory;
  readonly lesson: string;
  readonly severity: DogfoodFindingSeverity;
  readonly sources: ReadonlyArray<DogfoodFindingSource>;
  readonly summary: string;
};

type OptionalJson =
  | {
      readonly _tag: "Invalid";
      readonly message: string;
      readonly path: string;
    }
  | {
      readonly _tag: "Missing";
    }
  | {
      readonly _tag: "Valid";
      readonly value: unknown;
    };

type HarnessResultParse =
  | {
      readonly _tag: "Invalid";
      readonly message: string;
    }
  | {
      readonly _tag: "Valid";
      readonly value: HarnessRunResult;
    };

/** Derive and persist the Gaia dogfood retrospective artifact for a run. */
export function writeDogfoodRetrospective(
  runId: RunId,
  paths: RunPaths,
): Effect.Effect<DogfoodRetrospective, GaiaRuntimeError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const loaded = yield* loadRun(paths).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "DogfoodRetrospectiveEventReadFailed",
          message: "Gaia could not read events.jsonl for dogfood retrospective generation.",
          recoverable: true,
        }),
      ),
    );
    const drafts: Array<DraftFinding> = [];

    drafts.push(...(yield* reviewFindings(runId, paths)));
    drafts.push(...(yield* workerResultFindings(runId, paths)));
    drafts.push(...(yield* workspaceGateFindings(runId, paths)));
    drafts.push(
      ...prLoopFindings(
        runId,
        paths,
        yield* readOptionalJson(paths.prLoopState),
      ),
    );
    drafts.push(...eventFindings(runId, loaded.events));

    const findings = [...aggregateFindings(drafts)].sort(compareFindings);
    const linearCandidates = findings.flatMap((finding) =>
      finding.candidateIssue === undefined ? [] : [finding.candidateIssue],
    );
    const highSignalFindingCount = findings.filter(
      (finding) => finding.severity !== "info",
    ).length;
    const sourceArtifactPaths = yield* existingSourceArtifactPaths(paths);
    const summary =
      findings.length === 0
        ? "No high-signal dogfood findings were detected for this run."
        : `${highSignalFindingCount} high-signal dogfood finding(s) detected across ${findings.length} normalized category finding(s).`;
    const retrospective = DogfoodRetrospective.make({
      artifactPath: runRelative(paths, paths.dogfoodRetrospective),
      candidateIssueCount: linearCandidates.length,
      findings,
      generatedAt: new Date().toISOString(),
      highSignalFindingCount,
      lessons:
        findings.length === 0
          ? ["Keep events.jsonl authoritative and derived evidence bounded."]
          : findings.map((finding) => finding.lesson),
      linearCandidates,
      runId,
      sourceArtifactPaths,
      status: findings.length === 0 ? "clean" : "findings",
      summary,
      version: 1,
    });

    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      paths.dogfoodRetrospective,
      `${JSON.stringify(encodeDogfoodRetrospectiveJson(retrospective), null, 2)}\n`,
    ).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "DogfoodRetrospectiveWriteFailed",
            message: "Gaia could not write dogfood-retrospective.json.",
            recoverable: true,
          }),
        ),
      ),
    );

    return retrospective;
  });
}

function reviewFindings(runId: RunId, paths: RunPaths) {
  return Effect.gen(function* () {
    const findings: Array<DraftFinding> = [];
    const planReview = yield* readReviewArtifact(paths.planReviewResult);
    const evidenceReview = yield* readReviewArtifact(paths.evidenceReviewResult);

    if (planReview !== undefined) {
      findings.push(...reviewResultFindings(runId, planReview, "plan-review.json"));
    }

    if (evidenceReview !== undefined) {
      findings.push(
        ...reviewResultFindings(runId, evidenceReview, "evidence-review.json"),
      );
    }

    return findings;
  });
}

function readReviewArtifact(artifactPath: string) {
  return Effect.gen(function* () {
    const json = yield* readOptionalJson(artifactPath);
    if (json._tag === "Missing") {
      return undefined;
    }

    if (json._tag === "Invalid") {
      return undefined;
    }

    try {
      return parseReviewResultJson(json.value);
    } catch {
      return undefined;
    }
  });
}

function reviewResultFindings(
  runId: RunId,
  review: ReviewResult,
  artifactPath: string,
): ReadonlyArray<DraftFinding> {
  const source = sourceForRun({
    artifactPath,
    label: `${review.phase} review`,
    runId,
  });
  const text = [
    review.summary,
    ...review.findings.map((finding) => finding.message),
  ].join("\n");
  const findings: Array<DraftFinding> = [];

  if (review.status === "blocked") {
    const category = review.phase === "plan" ? "plan-quality" : "verification";
    const planWasGeneric =
      review.phase === "plan" && genericPlanPattern.test(text.toLowerCase());
    findings.push({
      category,
      lesson: planWasGeneric
        ? "Worker plans need concrete implementation surfaces, verification commands, and stop conditions before Codex review."
        : "Reviewer blockers should be preserved as structured follow-up evidence.",
      severity: "blocker",
      sources: [source],
      summary: planWasGeneric
        ? "Worker plan was blocked as generic by plan review."
        : `${review.phase} review blocked the run: ${review.summary}`,
    });
  }

  for (const finding of review.findings) {
    if (finding.severity === "info") {
      continue;
    }

    const category = categoryFromText(finding.message, review.phase);
    findings.push({
      category,
      lesson: lessonForCategory(category),
      severity: finding.severity,
      sources: [source],
      summary: finding.message,
    });
  }

  return findings;
}

function workerResultFindings(runId: RunId, paths: RunPaths) {
  return Effect.gen(function* () {
    const json = yield* readOptionalJson(paths.workerResult);
    if (json._tag === "Missing") {
      return [];
    }

    if (json._tag === "Invalid") {
      return [
        {
          category: "boundary-contract",
          lesson:
            "Persisted harness results must be valid JSON before downstream gates inspect them.",
          severity: "blocker",
          sources: [
            sourceForRun({
              artifactPath: "worker-result.json",
              label: "worker result",
              runId,
            }),
          ],
          summary: `worker-result.json is invalid JSON: ${json.message}.`,
        },
      ] satisfies ReadonlyArray<DraftFinding>;
    }

    const parsed = parseHarnessResult(json.value);
    if (parsed._tag === "Invalid") {
      return [
        {
          category: "boundary-contract",
          lesson:
            "Harness adapters need schema-valid result payloads at the runtime boundary.",
          severity: "blocker",
          sources: [
            sourceForRun({
              artifactPath: "worker-result.json",
              label: "worker result",
              runId,
            }),
          ],
          summary: `worker-result.json failed the harness result schema: ${parsed.message}.`,
        },
      ] satisfies ReadonlyArray<DraftFinding>;
    }

    const result = parsed.value;
    const noisyPaths = result.changedWorkspacePaths.filter((path) =>
      noisePathPattern.test(path),
    );
    const findings: Array<DraftFinding> = [];
    if (
      result.changedWorkspacePaths.length >= noisyChangedPathThreshold ||
      noisyPaths.length > 0
    ) {
      findings.push({
        category: "evidence-noise",
        lesson:
          "Workspace evidence should summarize generated/dependency paths instead of publishing full noisy path lists.",
        severity:
          result.changedWorkspacePaths.length >= noisyChangedPathThreshold
            ? "blocker"
            : "warning",
        sources: [
          sourceForRun({
            artifactPath: "worker-result.json",
            label: "worker result changedWorkspacePaths",
            runId,
          }),
        ],
        summary: `worker-result.json recorded ${result.changedWorkspacePaths.length} changed workspace path(s), including ${noisyPaths.length} generated/dependency path(s).`,
      });
    }

    const workspaceDiff = result.workspaceDiff;
    if (
      workspaceDiff !== undefined &&
      workspaceDiff.omittedGeneratedPathCount > 0
    ) {
      findings.push({
        category: "evidence-noise",
        lesson:
          "Generated workspace paths should stay summarized and separate from reviewable source diffs.",
        severity: "warning",
        sources: [
          sourceForRun({
            artifactPath: "worker-result.json",
            label: "worker result workspaceDiff",
            runId,
          }),
        ],
        summary: `workspaceDiff summarized ${workspaceDiff.omittedGeneratedFileCount} generated file(s) under ${workspaceDiff.omittedGeneratedPathCount} path group(s).`,
      });
    }

    return findings;
  });
}

function workspaceGateFindings(runId: RunId, paths: RunPaths) {
  return Effect.gen(function* () {
    const json = yield* readOptionalJson(paths.workspacePrGate);
    if (json._tag === "Missing") {
      return [];
    }

    if (json._tag === "Invalid") {
      return [
        {
          category: "boundary-contract",
          lesson: "Gate artifacts need to remain parseable for later review.",
          severity: "blocker",
          sources: [
            sourceForRun({
              artifactPath: "workspace-pr-gate.json",
              label: "workspace PR quality gate",
              runId,
            }),
          ],
          summary: `workspace-pr-gate.json is invalid JSON: ${json.message}.`,
        },
      ] satisfies ReadonlyArray<DraftFinding>;
    }

    let gate: WorkspacePrQualityGate;
    try {
      gate = parseWorkspacePrQualityGateJson(json.value);
    } catch {
      return [];
    }
    const findings: Array<DraftFinding> = [];

    if (gate.status === "blocked") {
      findings.push({
        category: "verification",
        lesson:
          "Pre-publish quality gates should block known Gaia-lane mistakes before a draft PR is opened.",
        severity: "blocker",
        sources: [
          sourceForRun({
            artifactPath: gate.artifactPath,
            label: "workspace PR quality gate",
            runId,
          }),
        ],
        summary: `Workspace PR pre-publish quality gate blocked publishing with ${gate.failItemCount} fail item(s).`,
      });
    }

    for (const item of gate.items) {
      if (item.severity === "pass") {
        continue;
      }

      findings.push(gateItemFinding(runId, gate, item));
    }

    return findings;
  });
}

function gateItemFinding(
  runId: RunId,
  gate: WorkspacePrQualityGate,
  item: WorkspacePrQualityGateItem,
): DraftFinding {
  const category = categoryFromGateItem(item);
  return {
    category,
    lesson: lessonForGateItem(item),
    severity: item.severity === "fail" ? "blocker" : "warning",
    sources: [
      sourceForRun({
        artifactPath: gate.artifactPath,
        label: `workspace PR gate: ${item.check}`,
        runId,
      }),
    ],
    summary: `${item.check}: ${item.reason}`,
  };
}

function prLoopFindings(
  runId: RunId,
  paths: RunPaths,
  json: OptionalJson,
): ReadonlyArray<DraftFinding> {
  if (json._tag !== "Valid" || !isRecord(json.value)) {
    return [];
  }

  const status = stringField(json.value, "status");
  const checksStatus = stringField(json.value, "checksStatus");
  const pr = stringField(json.value, "pr");
  const blockers = arrayField(json.value, "blockers");
  const findings: Array<DraftFinding> = [];
  const source = sourceForRun({
    artifactPath: runRelative(paths, paths.prLoopState),
    label: "PR-loop state",
    pullRequest: pr,
    runId,
  });

  if (status === "blocked") {
    findings.push({
      category: "operator-workflow",
      lesson:
        "PR-loop blockers should be captured as ordered operator follow-up evidence.",
      severity: "blocker",
      sources: [source],
      summary: `PR-loop state is blocked with ${blockers.length} blocker(s).`,
    });
  }

  if (
    checksStatus === "failing" ||
    checksStatus === "failed" ||
    checksStatus === "pending" ||
    checksStatus === "provider-unavailable"
  ) {
    const failingChecks = checksStatus === "failing" || checksStatus === "failed";
    findings.push({
      category: "verification",
      lesson:
        "PR checks should be recorded with terminal status before merge confidence is claimed.",
      severity: failingChecks || checksStatus === "provider-unavailable"
        ? "blocker"
        : "warning",
      sources: [source],
      summary: `GitHub checks are ${checksStatus} in the PR-loop state.`,
    });
  }

  if (checksStatus === "no-checks-configured" || checksStatus === "no-checks") {
    findings.push({
      category: "verification",
      lesson:
        "When GitHub has no checks, Gaia needs explicit local verification evidence in the handoff.",
      severity: "warning",
      sources: [source],
      summary: "GitHub reported no checks for the PR-loop state.",
    });
  }

  for (const blocker of blockers) {
    if (!isRecord(blocker)) {
      continue;
    }

    const kind = stringField(blocker, "kind");
    const summary = stringField(blocker, "summary");
    if (kind === undefined || summary === undefined) {
      continue;
    }

    findings.push({
      category:
        kind === "failed-checks" || kind === "pending-checks"
          ? "verification"
          : "operator-workflow",
      lesson: lessonForCategory(
        kind === "failed-checks" || kind === "pending-checks"
          ? "verification"
          : "operator-workflow",
      ),
      severity: kind === "failed-checks" ? "blocker" : "warning",
      sources: [source],
      summary: `${kind}: ${summary}`,
    });
  }

  return findings;
}

function eventFindings(
  runId: RunId,
  events: ReadonlyArray<RunEvent>,
): ReadonlyArray<DraftFinding> {
  const findings: Array<DraftFinding> = [];
  for (const event of events) {
    if (event.type !== "RUN_FAILED") {
      continue;
    }

    const code = stringField(event.payload, "code");
    const message = stringField(event.payload, "message") ?? "Run failed.";
    const stage = stringField(event.payload, "stage");
    const category = categoryFromFailure(code, message, stage);
    findings.push({
      category,
      lesson: lessonForCategory(category),
      severity: "blocker",
      sources: [
        sourceForRun({
          eventType: event.type,
          label: `run failure ${code ?? "unknown"}`,
          runId,
        }),
      ],
      summary:
        code === "ReviewBlocked" && message.toLowerCase().includes("generic")
          ? "Worker plan was blocked as generic by plan review."
          : message,
    });
  }

  const lockFailure = events.find(
    (event) =>
      event.type === "RUN_FAILED" &&
      stringField(event.payload, "code") === "RunStoreLocked" &&
      (stringField(event.payload, "message") ?? "")
        .toLowerCase()
        .includes("pr-loop"),
  );
  if (lockFailure !== undefined) {
    findings.push({
      category: "operator-workflow",
      lesson:
        "PR-loop evidence commands should be serialized or made lock-aware for resumed operation.",
      severity: "blocker",
      sources: [
        sourceForRun({
          eventType: lockFailure.type,
          label: "run-store lock failure",
          runId,
        }),
      ],
      summary: "PR-loop evidence command hit the run-store mutation lock.",
    });
  }

  return findings;
}

function aggregateFindings(
  drafts: ReadonlyArray<DraftFinding>,
): ReadonlyArray<DogfoodFinding> {
  const grouped = new Map<string, DraftFinding>();
  const occurrenceCounts = new Map<string, number>();

  for (const draft of drafts) {
    const safeDraft = {
      ...draft,
      summary: safeSummary(draft.summary),
    };
    const key = `${safeDraft.category}:${normalizeSummary(safeDraft.summary)}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, safeDraft);
      occurrenceCounts.set(key, 1);
      continue;
    }

    grouped.set(key, {
      ...existing,
      severity: maxSeverity(existing.severity, safeDraft.severity),
      sources: mergeSources(existing.sources, safeDraft.sources),
    });
    occurrenceCounts.set(key, (occurrenceCounts.get(key) ?? 1) + 1);
  }

  return [...grouped.entries()].map(([key, draft]) => {
    const occurrenceCount = occurrenceCounts.get(key) ?? 1;
    const candidateIssue =
      draft.severity === "info"
        ? undefined
        : candidateIssueForFinding(draft, occurrenceCount);
    return DogfoodFinding.make({
      category: draft.category,
      lesson: draft.lesson,
      occurrenceCount,
      severity: draft.severity,
      sources: [...draft.sources],
      summary: draft.summary,
      ...(candidateIssue === undefined ? {} : { candidateIssue }),
    });
  });
}

function candidateIssueForFinding(
  finding: DraftFinding,
  occurrenceCount: number,
) {
  const title = `Address Gaia ${finding.category} finding: ${shortTitle(finding.summary)}`;
  const goal = `Prevent repeat Gaia dogfood failure: ${finding.summary}`;
  const acceptanceCriteria = acceptanceCriteriaForCategory(finding.category);
  const bodyMarkdown = [
    "## Goal",
    "",
    goal,
    "",
    "## Acceptance Criteria",
    "",
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "## Source Evidence",
    "",
    ...finding.sources.map(formatSourceEvidence),
    "",
    "## Notes",
    "",
    `Category: \`${finding.category}\``,
    `Severity: \`${finding.severity}\``,
    `Observed occurrences: ${occurrenceCount}`,
    "",
    "This is a Linear-ready candidate emitted by Gaia. Gaia did not create or mutate a Linear issue.",
  ].join("\n");

  return LinearCandidateIssue.make({
    acceptanceCriteria,
    bodyMarkdown,
    category: finding.category,
    goal,
    sourceEvidence: [...finding.sources],
    title,
  });
}

function categoryFromText(
  text: string,
  phase: ReviewResult["phase"],
): DogfoodFindingCategory {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("generic") ||
    normalized.includes("plan") ||
    phase === "plan"
  ) {
    return "plan-quality";
  }

  if (
    normalized.includes("json") ||
    normalized.includes("schema") ||
    normalized.includes("runid") ||
    normalized.includes("payload") ||
    normalized.includes("contract") ||
    normalized.includes("cast")
  ) {
    return "boundary-contract";
  }

  if (
    normalized.includes("node_modules") ||
    normalized.includes("dist") ||
    normalized.includes("artifact") ||
    normalized.includes("evidence")
  ) {
    return "evidence-noise";
  }

  if (
    normalized.includes("check") ||
    normalized.includes("verify") ||
    normalized.includes("verification")
  ) {
    return "verification";
  }

  if (
    normalized.includes("quiet") ||
    normalized.includes("progress") ||
    normalized.includes("stall") ||
    normalized.includes("timeout")
  ) {
    return "observability";
  }

  return "operator-workflow";
}

function categoryFromGateItem(
  item: WorkspacePrQualityGateItem,
): DogfoodFindingCategory {
  switch (item.check) {
    case "worker-result-reviewable-size":
    case "generated-paths-summarized":
      return "evidence-noise";
    case "worker-result-json":
    case "worker-result-schema":
    case "worker-result-safe-paths":
    case "changed-workspace-safe-paths":
    case "workspace-diff-product-safe-paths":
    case "workspace-diff-generated-safe-paths":
    case "output-artifact-safe-paths":
    case "run-id-brand-cast":
      return "boundary-contract";
    case "worker-result-present":
    case "workspace-diff-present":
    case "workspace-diff-reviewable":
      return "verification";
    default:
      return categoryFromText(`${item.check} ${item.reason}`, "evidence");
  }
}

function categoryFromFailure(
  code: string | undefined,
  message: string,
  stage: string | undefined,
): DogfoodFindingCategory {
  const text = `${code ?? ""} ${message} ${stage ?? ""}`.toLowerCase();
  if (text.includes("reviewblocked") && text.includes("plan")) {
    return "plan-quality";
  }

  if (
    text.includes("json") ||
    text.includes("schema") ||
    text.includes("artifact") ||
    text.includes("payload") ||
    text.includes("contract")
  ) {
    return "boundary-contract";
  }

  if (
    text.includes("browser") ||
    text.includes("progress") ||
    text.includes("stall") ||
    text.includes("timeout") ||
    text.includes("last-message")
  ) {
    return "observability";
  }

  if (
    text.includes("verify") ||
    text.includes("verification") ||
    text.includes("gate") ||
    text.includes("check")
  ) {
    return "verification";
  }

  if (text.includes("lock") || text.includes("pr-loop")) {
    return "operator-workflow";
  }

  return stage === "reviewing" ? "plan-quality" : "operator-workflow";
}

function lessonForGateItem(item: WorkspacePrQualityGateItem) {
  if (item.check === "worker-result-reviewable-size") {
    return "Noisy worker-result evidence should be capped and summarized before a workspace PR can be published.";
  }

  return lessonForCategory(categoryFromGateItem(item));
}

function lessonForCategory(category: DogfoodFindingCategory) {
  switch (category) {
    case "boundary-contract":
      return "Boundary inputs should be parsed with schemas before branded/domain values move inward.";
    case "evidence-noise":
      return "Dogfood evidence should stay bounded, reviewable, and focused on product/source changes.";
    case "observability":
      return "Long-running Gaia loops need explicit progress or stall classification for operators.";
    case "operator-workflow":
      return "Operator-facing commands should be resumable, idempotent, and explicit about next safe actions.";
    case "plan-quality":
      return "Worker plans should be specific enough for reviewer/spec gates before execution.";
    case "verification":
      return "Verification and pre-publish gates should fail early with actionable remediation.";
  }
}

function acceptanceCriteriaForCategory(
  category: DogfoodFindingCategory,
): ReadonlyArray<string> {
  switch (category) {
    case "boundary-contract":
      return [
        "Boundary payloads are decoded with Effect Schema or the owning parser.",
        "Tests cover the invalid payload or brand-construction regression.",
        "Failure output explains the operator remediation path.",
      ];
    case "evidence-noise":
      return [
        "Generated/dependency/build paths are summarized instead of emitted as large raw lists.",
        "Regression tests cover the noisy evidence fixture.",
        "Human reports point to the bounded evidence artifact.",
      ];
    case "observability":
      return [
        "Long-running phases emit bounded progress or a terminal stall classification.",
        "Operators can distinguish healthy quiet work from a stuck run.",
        "The progress artifact remains JSON-safe and derived.",
      ];
    case "operator-workflow":
      return [
        "The command can be safely rerun or reports the active blocker.",
        "Next safe action is explicit in human and JSON output.",
        "A regression test covers the repeated operator workflow failure.",
      ];
    case "plan-quality":
      return [
        "Worker plans include concrete code surfaces, acceptance criteria, verification, and stop conditions.",
        "Plan review blocks generic plans with a clear finding.",
        "A regression fixture proves the known generic-plan failure is classified consistently.",
      ];
    case "verification":
      return [
        "Pre-publish or PR-loop gates fail before mutation when known risks are present.",
        "The failure artifact includes category, source evidence, and remediation.",
        "A focused test covers the failing gate fixture.",
      ];
  }
}

function existingSourceArtifactPaths(paths: RunPaths) {
  const artifactPaths = [
    paths.events,
    paths.planReviewResult,
    paths.evidenceReviewResult,
    paths.workerResult,
    paths.workspacePrGate,
    paths.prLoopState,
    paths.githubFeedback,
    paths.githubPrComment,
    paths.mergeDecision,
    paths.codexHarnessProgress,
  ];

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const existing: Array<string> = [];
    for (const artifactPath of artifactPaths) {
      const exists = yield* fs.exists(artifactPath);
      if (exists) {
        existing.push(runRelative(paths, artifactPath));
      }
    }

    return existing;
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "DogfoodRetrospectiveArtifactReadFailed",
          message: "Gaia could not inspect source artifacts for dogfood retrospective generation.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function readOptionalJson(
  artifactPath: string,
): Effect.Effect<OptionalJson, GaiaRuntimeError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(artifactPath);
    if (!exists) {
      return { _tag: "Missing" } satisfies OptionalJson;
    }

    const text = yield* fs.readFileString(artifactPath);
    try {
      const value: unknown = JSON.parse(text);
      return { _tag: "Valid", value } satisfies OptionalJson;
    } catch (cause) {
      return {
        _tag: "Invalid",
        message: errorMessage(cause),
        path: artifactPath,
      } satisfies OptionalJson;
    }
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "DogfoodRetrospectiveArtifactReadFailed",
          message: "Gaia could not read an artifact for dogfood retrospective generation.",
          recoverable: true,
        }),
      ),
    ),
  );
}

function parseHarnessResult(input: unknown): HarnessResultParse {
  try {
    return { _tag: "Valid", value: parseHarnessRunResultJson(input) };
  } catch (cause) {
    return { _tag: "Invalid", message: errorMessage(cause) };
  }
}

function sourceForRun(input: {
  readonly artifactPath?: string | undefined;
  readonly eventType?: string | undefined;
  readonly label: string;
  readonly pullRequest?: string | undefined;
  readonly runId: RunId;
  readonly url?: string | undefined;
}) {
  return DogfoodFindingSource.make({
    label: input.label,
    runId: input.runId,
    ...(input.artifactPath === undefined
      ? {}
      : { artifactPath: input.artifactPath }),
    ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
    ...(input.pullRequest === undefined
      ? {}
      : { pullRequest: input.pullRequest }),
    ...(input.url === undefined ? {} : { url: input.url }),
  });
}

function mergeSources(
  left: ReadonlyArray<DogfoodFindingSource>,
  right: ReadonlyArray<DogfoodFindingSource>,
) {
  const sources: Array<DogfoodFindingSource> = [];
  const seen = new Set<string>();
  for (const source of [...left, ...right]) {
    const key = [
      source.label,
      source.artifactPath ?? "",
      source.eventType ?? "",
      source.pullRequest ?? "",
      source.url ?? "",
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sources.push(source);
  }

  return sources;
}

function maxSeverity(
  left: DogfoodFindingSeverity,
  right: DogfoodFindingSeverity,
): DogfoodFindingSeverity {
  const rank: Readonly<Record<DogfoodFindingSeverity, number>> = {
    blocker: 3,
    info: 1,
    warning: 2,
  };

  return rank[left] >= rank[right] ? left : right;
}

function compareFindings(left: DogfoodFinding, right: DogfoodFinding) {
  const severity = severityRank(right.severity) - severityRank(left.severity);
  if (severity !== 0) {
    return severity;
  }

  return left.category.localeCompare(right.category);
}

function severityRank(severity: DogfoodFindingSeverity) {
  switch (severity) {
    case "blocker":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
  }
}

function normalizeSummary(summary: string) {
  return summary.toLowerCase().replace(/\s+/gu, " ").trim();
}

function safeSummary(input: string) {
  const firstMeaningfulLine =
    input
      .split(/\r?\n/u)
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .find((line) => line.length > 0) ??
    "Finding details are available in source evidence.";

  return firstMeaningfulLine.length <= safeSummaryMaxLength
    ? firstMeaningfulLine
    : `${firstMeaningfulLine.slice(0, safeSummaryMaxLength - 3)}...`;
}

function shortTitle(summary: string) {
  const normalized = summary.replace(/\s+/gu, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function formatSourceEvidence(source: DogfoodFindingSource) {
  const details = [
    source.artifactPath === undefined ? undefined : `artifact: \`${source.artifactPath}\``,
    source.eventType === undefined ? undefined : `event: \`${source.eventType}\``,
    source.pullRequest === undefined ? undefined : `PR: \`${source.pullRequest}\``,
    source.url === undefined ? undefined : `url: ${source.url}`,
  ].filter((item): item is string => item !== undefined);

  if (details.length === 0) {
    return `- ${source.label} for \`${source.runId}\``;
  }

  return `- ${source.label} for \`${source.runId}\` (${details.join(", ")})`;
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null;
}

function stringField(
  input: Readonly<Record<string, unknown>>,
  field: string,
) {
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

function arrayField(
  input: Readonly<Record<string, unknown>>,
  field: string,
): ReadonlyArray<unknown> {
  const value = input[field];
  return Array.isArray(value) ? value : [];
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
