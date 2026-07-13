import { Effect, FileSystem, Path, Schema } from "effect";

import {
  makeCodexCommandArgs,
  makeCodexHarnessConfig,
  nodeCodexCommandRunner,
  type CodexCommandResult,
  type CodexCommandRunner,
  type CodexHarnessConfig,
  type CodexHarnessConfigInput,
} from "./codex-harness.js";
import { makeRuntimeError, type GaiaRuntimeError } from "./errors.js";
import { ReviewerSessionEvidence } from "./reviewer-session-evidence.js";
import {
  ReviewFinding,
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
  type ReviewRunRequest,
} from "./reviewer.js";

/** Stable reviewer name for the read-only Codex reviewer adapter. */
export const codexReviewerName =
  Schema.decodeUnknownSync(ReviewerNameSchema)("codex-reviewer");

/** Safe Codex settings accepted by the read-only reviewer adapter. */
export type CodexReviewerConfigInput = Pick<
  CodexHarnessConfigInput,
  "command" | "model" | "profile" | "timeoutMs"
>;

/** Dependencies and configuration for the read-only Codex reviewer. */
export type CodexReviewerOptions = {
  readonly commandRunner?: CodexCommandRunner;
  readonly config: CodexHarnessConfig;
};

/** Inputs used to construct the Codex reviewer prompt. */
export type CodexReviewerPromptInput = {
  readonly request: ReviewRunRequest;
};

type CodexReviewDecision = {
  readonly status: ReviewResult["status"];
  readonly summary: string;
};

/** Build a Codex config for read-only reviewer execution. */
export function makeCodexReviewerConfig(
  input: CodexReviewerConfigInput = {}
): CodexHarnessConfig {
  return makeCodexHarnessConfig({
    command: input.command,
    extraArgs: [],
    model: input.model,
    profile: input.profile,
    sandbox: "read-only",
    timeoutMs: input.timeoutMs,
  });
}

/** Build a read-only Gaia reviewer backed by `codex exec`. */
export function makeCodexReviewer(options: CodexReviewerOptions): GaiaReviewer {
  return {
    adapterKind: "codex-cli",
    name: codexReviewerName,
    run: (request) => runCodexReviewer(request, options),
    sessionKind: "cli",
  };
}

/** Build the review prompt sent to Codex over stdin. */
export function makeCodexReviewerPrompt(input: CodexReviewerPromptInput) {
  const phaseArtifacts = artifactsForPhase(input.request);

  return [
    "You are the Gaia Codex reviewer.",
    "You are reviewing a Gaia software-factory run as a read-only reviewer.",
    "Do not write, edit, delete, move, or create files.",
    "Do not run mutating commands.",
    `Review phase: ${input.request.phase}`,
    `Run ID: ${input.request.runId}`,
    `Workspace: ${input.request.workspacePath}`,
    `Spec title: ${input.request.specTitle}`,
    "Spec body:",
    input.request.specBody,
    "Artifacts to inspect:",
    ...phaseArtifacts.map((artifact) => `- ${artifact}`),
    "Inspect the worker plan acceptance criteria, non-goals, likely touched surfaces, verification checks, and stop conditions.",
    "Decision contract:",
    "First line must be exactly one of:",
    "Status: approved",
    "Status: blocked",
    "Second line must start with `Summary: ` and contain one concise sentence.",
    "After that, include any short Markdown findings you think matter.",
  ].join("\n\n");
}

function runCodexReviewer(
  request: ReviewRunRequest,
  options: CodexReviewerOptions
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runRoot = path.dirname(request.resultPath);
    const lastMessagePath = path.join(
      runRoot,
      `${request.phase}-codex-reviewer-last-message.md`
    );
    const reviewerLogPath = path.join(
      runRoot,
      `${request.phase}-codex-reviewer.log`
    );
    const runner = options.commandRunner ?? nodeCodexCommandRunner;
    const execution = yield* runner({
      args: makeCodexCommandArgs({
        config: options.config,
        lastMessagePath,
        workspacePath: runRoot,
      }),
      command: options.config.command,
      cwd: runRoot,
      stdin: makeCodexReviewerPrompt({ request }),
      timeoutMs: options.config.timeoutMs,
    });

    yield* fs.writeFileString(
      reviewerLogPath,
      formatCodexReviewerOutput(execution)
    );

    if (execution.exitCode !== 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "CodexReviewerCommandFailed",
          message: `Codex reviewer command '${options.config.command}' exited with code ${execution.exitCode}.`,
          recoverable: true,
        })
      );
    }

    const lastMessageExists = yield* fs.exists(lastMessagePath);
    if (!lastMessageExists) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "CodexReviewerLastMessageMissing",
          message:
            "Codex reviewer completed without writing its last-message artifact.",
          recoverable: true,
        })
      );
    }

    const lastMessage = yield* fs.readFileString(lastMessagePath);
    const decision = yield* parseCodexReviewDecision(lastMessage);
    const resultPath =
      request.phase === "plan" ? "plan-review.json" : "evidence-review.json";
    const sessionEvidence = ReviewerSessionEvidence.make({
      adapterKind: "codex-cli",
      command: options.config.command,
      cwd: runRoot,
      decisionStatus: decision.status,
      evidencePath: path.basename(request.sessionEvidencePath),
      logPath: path.basename(reviewerLogPath),
      phase: request.phase,
      resultPath,
      reviewPath: path.basename(request.markdownPath),
      reviewerName: codexReviewerName,
      runId: request.runId,
      sessionKind: "cli",
      transcriptPath: path.basename(lastMessagePath),
      version: 1,
    });

    return ReviewResult.make({
      findings: [
        ReviewFinding.make({
          message: `Codex reviewer transcript: ${path.basename(lastMessagePath)}.`,
          severity: decision.status === "blocked" ? "blocker" : "info",
        }),
        ReviewFinding.make({
          message: `Codex reviewer log: ${path.basename(reviewerLogPath)}.`,
          severity: "info",
        }),
      ],
      phase: request.phase,
      resultPath,
      reviewerName: codexReviewerName,
      runId: request.runId,
      sessionEvidence,
      status: decision.status,
      summary: decision.summary,
    });
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "CodexReviewerArtifactFailed",
          message: `Codex reviewer could not read or write ${request.phase} review artifacts.`,
          recoverable: true,
        })
      )
    )
  );
}

function artifactsForPhase(request: ReviewRunRequest) {
  const commonArtifacts = [
    `Workspace manifest JSON: ${request.workspaceManifestPath}`,
    `Worker plan Markdown: ${request.workerPlanPath.replace(/\.json$/u, ".md")}`,
    `Worker plan JSON: ${request.workerPlanPath}`,
  ];

  if (request.phase === "plan") {
    return commonArtifacts;
  }

  return [
    ...commonArtifacts,
    `Browser evidence JSON: ${request.browserEvidencePath}`,
    `Worker result JSON: ${request.workerResultPath}`,
    `Verification result JSON: ${request.verificationResultPath}`,
  ];
}

function parseCodexReviewDecision(
  lastMessage: string
): Effect.Effect<CodexReviewDecision, GaiaRuntimeError> {
  const lines = lastMessage
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstLine = lines[0];

  if (firstLine === undefined) {
    return invalidCodexReviewDecision(
      "Codex reviewer returned an empty response."
    );
  }

  const status = statusFromLine(firstLine);
  if (status === undefined) {
    return invalidCodexReviewDecision(
      "Codex reviewer response must start with `Status: approved` or `Status: blocked`."
    );
  }

  const summary = summaryFromLines(lines);
  if (summary === undefined) {
    return invalidCodexReviewDecision(
      "Codex reviewer response must include a non-empty `Summary: ...` line."
    );
  }

  return Effect.succeed({ status, summary });
}

function statusFromLine(line: string): ReviewResult["status"] | undefined {
  switch (line) {
    case "Status: approved":
      return "approved";
    case "Status: blocked":
      return "blocked";
    default:
      return undefined;
  }
}

function summaryFromLines(lines: ReadonlyArray<string>) {
  for (const line of lines) {
    if (!line.startsWith("Summary: ")) {
      continue;
    }

    const summary = line.slice("Summary: ".length).trim();
    return summary.length === 0 ? undefined : summary;
  }

  return undefined;
}

function invalidCodexReviewDecision(message: string) {
  return Effect.fail(
    makeRuntimeError({
      code: "CodexReviewerDecisionInvalid",
      message,
      recoverable: true,
    })
  );
}

function formatCodexReviewerOutput(execution: CodexCommandResult) {
  const lines: Array<string> = [];

  if (execution.stdout.length > 0) {
    lines.push("Codex reviewer stdout:", execution.stdout.trimEnd());
  }

  if (execution.stderr.length > 0) {
    lines.push("Codex reviewer stderr:", execution.stderr.trimEnd());
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
