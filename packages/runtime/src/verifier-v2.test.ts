import { mkdirSync, readFileSync } from "node:fs";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import {
  DeliveryFeedbackTrustPolicyV1,
  deriveExplicitSpecItemDigest,
  parseAnyRunProofResult,
  parseMarkdownSpec,
  parseMergeDecisionV2,
  parseRunId,
  parseVerificationCommandReceipt,
  VerificationActionRequestSchema,
} from "@gaia/core";
import { Effect, Fiber, FileSystem, Schema } from "effect";

import {
  BrowserEvidenceV2,
  BrowserPageEvidenceV2,
  BrowserScreenshotEvidence,
} from "./browser-evidence.js";
import {
  coordinateDeliveryMergeReadiness,
  FreshMergeState,
} from "./delivery-merge-coordinator.js";
import { publishReadyDeliveryRun } from "./delivery-publication.js";
import { coordinateDeliveryPullRequestReady } from "./delivery-ready-for-review-coordinator.js";
import { defaultDeliveryFeedbackTrustPolicy } from "./delivery-remediation-coordinator.js";
import { coordinateDeliveryLocalReviewAttestation } from "./delivery-review-attestation-coordinator.js";
import { makeDockerSandboxCli } from "./docker-sandbox-cli.js";
import {
  executeDockerSandboxVerification,
  StagedDockerSandboxVerificationReceiptSchema,
} from "./docker-sandbox-verification-executor.js";
import { appendEvent, readEvents } from "./event-store.js";
import {
  prepareDeliveryWorktree,
  type DeliveryProvenance,
  type GitDeliveryCommandRunner,
} from "./git-delivery.js";
import {
  GitHubPrLoopState,
  type CommandExecutionResult,
  type GitHubCommandInput,
  type GitHubCommandRunner,
} from "./github-publisher.js";
import { codexAppServerHarnessName, HarnessRunResult } from "./harness.js";
import { recordMergeDecision } from "./merge-decision.js";
import {
  makeRunPaths,
  makeVerificationClaimPaths,
  parseRuntimePath,
} from "./paths.js";
import { ReviewerSessionEvidence } from "./reviewer-session-evidence.js";
import {
  defaultReviewerName,
  ReviewResult,
  ReviewRunRequest,
  runReviewer,
} from "./reviewer.js";
import { deriveAndRecordRunContract, loadRunContract } from "./run-contract.js";
import { defaultRunProfile, writeRunProfile } from "./run-profile.js";
import { actOnRunVerification } from "./server-workflows.js";
import { readVerificationExecutionProfile } from "./verification-execution-profile.js";
import { recordRunProofResult, type VerificationServices } from "./verifier.js";
import { runSpecFile } from "./workflows.js";
import {
  encodeWorkspaceDiffSummaryJson,
  observeVerificationWorkspaceStructuralDigest,
  observeWorkspaceStructuralDigest,
  productOnlyWorkspaceDiff,
} from "./workspace-snapshot.js";

describe("V2 claim verifier", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "drives a natural V2 proof through MergeDecisionV2 and readiness V3",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-verifier-v2-",
          });
          const runId = parseRunId("run-Gaia145v2a");
          const paths = yield* makeRunPaths(runId, { rootDirectory });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          yield* fs.makeDirectory(`${rootDirectory}/.git`, {
            recursive: true,
          });
          const spec = parseMarkdownSpec(
            yield* fs.readFileString(
              `${process.cwd()}/../../examples/specs/claim-verification-v2.md`
            ),
            "claim-verification-v2"
          );
          const provenance = {
            baseBranch: "main",
            baseRevision: "1".repeat(40),
            headBranch: "gaia/run-Gaia145v2a",
            mode: "pullRequest" as const,
            remote: "origin",
          };
          yield* prepareDeliveryWorktree({
            options: {
              commandRunner: naturalDeliveryWorktreeRunner(rootDirectory),
              rootDirectory,
            },
            paths,
            provenance,
          });
          yield* fs.makeDirectory(`${paths.workspace}/src`, {
            recursive: true,
          });
          yield* fs.writeFileString(
            `${paths.workspace}/src/feature.ts`,
            "export const verified = true;\n"
          );
          const workspaceDiff = productOnlyWorkspaceDiff(["src/feature.ts"]);
          yield* fs.writeFileString(paths.verificationLog, "");
          yield* writeRunProfile({ paths, profile: defaultRunProfile });
          yield* appendEvent(runId, paths, {
            payload: { delivery: provenance, specPath: "input.md" },
            type: "RUN_CREATED",
          });
          const contract = yield* deriveAndRecordRunContract({
            deliveryProvenance: provenance,
            paths,
            runId,
            spec,
          });
          yield* appendEvent(runId, paths, {
            payload: {
              delivery: {
                ...provenance,
                feedbackTrustPolicy: Schema.encodeSync(
                  DeliveryFeedbackTrustPolicyV1
                )(
                  DeliveryFeedbackTrustPolicyV1.make({
                    ...defaultDeliveryFeedbackTrustPolicy("cill-i-am/gaia"),
                    requireApprovedReview: false,
                  })
                ),
                stage: "delivering",
              },
            },
            type: "DELIVERY_STARTED",
          });
          yield* appendEvent(runId, paths, {
            payload: { workspacePath: "workspace" },
            type: "WORKSPACE_PREPARED",
          });
          yield* appendEvent(runId, paths, { type: "WORKER_STARTED" });
          yield* fs.writeFileString(
            paths.workerResult,
            `${JSON.stringify(
              HarnessRunResult.make({
                changedWorkspacePaths: workspaceDiff.productChangedPaths,
                exitCode: 0,
                harnessName: codexAppServerHarnessName,
                outputArtifacts: [],
                resultPath: "worker-result.json",
                runId,
                status: "completed",
                summary: "Delivered one verified source change.",
                workspaceDiff,
              })
            )}\n`
          );
          const workerCompletion = yield* appendEvent(runId, paths, {
            payload: {
              changedWorkspacePaths: workspaceDiff.productChangedPaths,
              harnessName: codexAppServerHarnessName,
              outputArtifacts: [],
              workerResultPath: "worker-result.json",
              workspaceDiff: encodeWorkspaceDiffSummaryJson(workspaceDiff),
            },
            type: "WORKER_COMPLETED",
          });
          yield* appendEvent(runId, paths, { type: "VERIFICATION_STARTED" });

          const profile = yield* readVerificationExecutionProfile(
            parseRuntimePath(
              `${process.cwd()}/../../profiles/claim-verification.json`
            )
          );
          let executions = 0;
          const verificationServices = {
            executor: {
              execute: (invocation) =>
                Effect.gen(function* () {
                  executions += 1;
                  yield* invocation.onSandboxCreated({
                    sandboxName: invocation.sandboxName,
                    sandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
                  });
                  yield* fs.writeFileString(
                    invocation.stdoutPath,
                    "gaia-claim-ok\n"
                  );
                  yield* fs.writeFileString(invocation.stderrPath, "");
                  const observed = yield* observeWorkspaceStructuralDigest(
                    invocation.workspace
                  );
                  return Schema.decodeUnknownSync(
                    StagedDockerSandboxVerificationReceiptSchema
                  )({
                    cleanup: {
                      finalAbsenceConfirmed: true as const,
                      removedSandboxUuid:
                        "123e4567-e89b-12d3-a456-426614174000",
                      stoppedSandboxUuid:
                        "123e4567-e89b-12d3-a456-426614174000",
                    },
                    durationMs: 1,
                    exitCode: 0,
                    observedProviderExitCode: 0,
                    observedExecutionIdentity: {
                      imageDigest: profile.imageDigest,
                      providerBuild: profile.provider.build,
                      providerVersion: profile.provider.version,
                      templateReference: profile.templateReference,
                    },
                    sandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
                    status: "succeeded" as const,
                    stderr: {
                      artifactPath: invocation.stderrArtifactPath,
                      contentDigest:
                        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                      observedByteCount: 0,
                      retainedByteCount: 0,
                      truncated: false,
                    },
                    stdout: {
                      artifactPath: invocation.stdoutArtifactPath,
                      contentDigest:
                        "c67d2c0ac3e5ea53ed76dadc9aab773e884efedcaac2be11aaa4b096576f5849",
                      observedByteCount: 14,
                      retainedByteCount: 14,
                      truncated: false,
                    },
                    workspaceObservation: observed,
                  });
                }).pipe(Effect.orDie),
              reconcile: () => Effect.die("not used"),
            },
            profile,
          } satisfies VerificationServices;
          const result = yield* recordRunProofResult(runId, paths, {
            verificationServices,
          });
          const events = yield* readEvents(paths);

          assert.strictEqual(executions, 1);
          assert.strictEqual(result.version, 2);
          if (result.version !== 2) return assert.fail("Expected V2 proof.");
          assert.strictEqual(result.results[0]?.status, "passed");
          assert.deepEqual(
            events
              .slice(
                events.findIndex(
                  ({ type }) => type === "CLAIM_VERIFICATION_GENERATION_STARTED"
                )
              )
              .map(({ type }) => type),
            [
              "CLAIM_VERIFICATION_GENERATION_STARTED",
              "CLAIM_VERIFICATION_CREATE_INTENT_RECORDED",
              "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED",
              "CLAIM_VERIFICATION_COMMAND_START_RECORDED",
              "CLAIM_VERIFICATION_COMMAND_RECORDED",
              "RUN_PROOF_RESULT_RECORDED",
            ]
          );
          assert.strictEqual(
            events.at(-1)?.sequence,
            result.recordedBy.sequence
          );

          const generationEvent = events.find(
            ({ type }) => type === "CLAIM_VERIFICATION_GENERATION_STARTED"
          );
          const sandboxCreatedEvent = events.find(
            ({ type }) => type === "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED"
          );
          assert.ok(
            generationEvent?.type === "CLAIM_VERIFICATION_GENERATION_STARTED"
          );
          assert.ok(
            sandboxCreatedEvent?.type ===
              "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED"
          );
          const generation = Schema.decodeUnknownSync(
            Schema.Struct({
              executionEvidenceIdentityDigest: Schema.String,
            })
          )(generationEvent.payload["generation"]);
          const sandboxCreated = Schema.decodeUnknownSync(
            Schema.Struct({
              claimId: Schema.String,
              sandboxName: Schema.String,
              sandboxUuid: Schema.String,
            })
          )(sandboxCreatedEvent.payload["sandboxCreated"]);
          let reconciliations = 0;
          const wrongPrior = Schema.decodeUnknownSync(
            VerificationActionRequestSchema
          )({
            actionId: "reconcile-wrong-created-prefix",
            claimId: sandboxCreated.claimId,
            expectedContentAuthoritySequence: workerCompletion.event.sequence,
            expectedContractDigest: contract.contractDigest,
            expectedEventSequence: events.at(-1)!.sequence,
            expectedExecutionEvidenceIdentityDigest:
              generation.executionEvidenceIdentityDigest,
            expectedSandboxName: sandboxCreated.sandboxName,
            expectedSandboxUuid: sandboxCreated.sandboxUuid,
            kind: "reconcileOutcomeUnknown",
            prior: {
              kind: "createdWithoutCommandStart",
              priorSandboxCreatedSequence: sandboxCreatedEvent.sequence,
            },
            priorGenerationSequence: generationEvent.sequence,
          });
          const wrongPriorError = yield* actOnRunVerification(
            runId,
            wrongPrior,
            {
              rootDirectory,
              verificationServices: {
                executor: {
                  execute: () => Effect.die("not used"),
                  reconcile: () => {
                    reconciliations += 1;
                    return Effect.die("must reject before provider mutation");
                  },
                },
                profile,
              },
            }
          ).pipe(Effect.flip);
          assert.strictEqual(
            Reflect.get(wrongPriorError, "code"),
            "VerificationActionUnsupportedReconciliation"
          );
          assert.strictEqual(reconciliations, 0);

          yield* appendEvent(runId, paths, {
            payload: { phase: "evidence", reviewPath: "evidence-review.md" },
            type: "REVIEW_COMPLETED",
          });
          yield* appendEvent(runId, paths, {
            payload: {
              delivery: { ...provenance, stage: "readyToPublish" },
              reportPath: "report.md",
            },
            type: "DELIVERY_READY_TO_PUBLISH",
          });
          const confirmed = yield* publishReadyDeliveryRun(runId, {
            commandRunner: naturalPublicationRunner(paths.root, provenance),
            deliveryGitCommandRunner:
              naturalDeliveryWorktreeRunner(rootDirectory),
            rootDirectory,
          });
          assert.strictEqual(confirmed.state, "confirmed");
          if (confirmed.state !== "confirmed")
            return assert.fail("Expected public publication confirmation.");
          const publication = (yield* readEvents(paths)).findLast(
            ({ type }) => type === "DELIVERY_PUBLICATION_CONFIRMED"
          );
          if (publication === undefined)
            return assert.fail("Expected public publication event.");
          const checks = [
            {
              appSlug: "github-actions",
              headSha: confirmed.headSha,
              name: "gaia-pr-ci",
              repository: "cill-i-am/gaia",
              state: "passing" as const,
              workflow: "Gaia PR CI",
            },
          ];
          const freshPullRequest = FreshMergeState.make({
            branchName: confirmed.branchName,
            checks,
            draft: false,
            feedbackBlockers: 0,
            headSha: confirmed.headSha,
            mergeability: "mergeable" as const,
            prNumber: confirmed.prNumber,
            prUrl: confirmed.prUrl,
            repository: "cill-i-am/gaia",
            state: "open" as const,
            supportedMethods: ["merge" as const],
            unresolvedActionableThreads: 0,
          });
          yield* coordinateDeliveryPullRequestReady(
            runId,
            {
              actionId: "ready-natural-v2",
              expectedBranchName: confirmed.branchName,
              expectedHeadSha: confirmed.headSha,
              expectedPrNumber: confirmed.prNumber,
              expectedPrUrl: confirmed.prUrl,
              kind: "markReadyForReview",
            },
            {
              freshStateReader: () => Effect.succeed(freshPullRequest),
              rootDirectory,
            }
          );
          yield* coordinateDeliveryLocalReviewAttestation(
            runId,
            {
              actionId: "review-natural-v2",
              decision: "approved",
              expectedBranchName: confirmed.branchName,
              expectedHeadSha: confirmed.headSha,
              expectedPrNumber: confirmed.prNumber,
              expectedPrUrl: confirmed.prUrl,
              kind: "attestPairedReviewApproval",
            },
            {
              freshStateReader: () => Effect.succeed(freshPullRequest),
              rootDirectory,
            }
          );
          yield* fs.writeFileString(
            `${paths.root}/github-checks.json`,
            `${JSON.stringify({
              checks: [{ name: "test", state: "SUCCESS", workflow: "ci" }],
              headSha: confirmed.headSha,
            })}\n`
          );
          const checksEvent = yield* appendEvent(runId, paths, {
            payload: {
              checksPath: "github-checks.json",
              headSha: confirmed.headSha,
              pullRequest: confirmed.prUrl,
              status: "passing",
            },
            type: "GITHUB_CHECKS_RECORDED",
          });
          const action = Schema.decodeUnknownSync(
            VerificationActionRequestSchema
          )({
            actionId: "post-publication-gaia-145",
            expectedContentAuthoritySequence: workerCompletion.event.sequence,
            expectedContractDigest: contract.contractDigest,
            expectedEventSequence: checksEvent.event.sequence,
            expectedHeadSha: confirmed.headSha,
            expectedPublicationSequence: publication.sequence,
            expectedTargetDigest: contract.targetDigest,
            kind: "startPostPublicationGeneration",
          });
          const beforeAction = yield* readEvents(paths);
          assert.strictEqual(
            beforeAction.at(-1)?.sequence,
            action.expectedEventSequence
          );
          assert.strictEqual(
            [...beforeAction]
              .reverse()
              .find(({ type }) =>
                [
                  "WORKER_COMPLETED",
                  "WORKER_CONTINUATION_RECORDED",
                  "DELIVERY_REMEDIATION_RECORDED",
                ].includes(type)
              )?.sequence,
            action.expectedContentAuthoritySequence
          );
          const post = yield* actOnRunVerification(runId, action, {
            rootDirectory,
            verificationServices,
          });
          assert.strictEqual(post.kind, "postPublicationGenerationRecorded");
          if (post.kind !== "postPublicationGenerationRecorded")
            return assert.fail("Expected post-publication generation.");
          assert.strictEqual(
            post.proofResultSequence,
            post.generationSequence + 1
          );
          const postResult = yield* readEvents(paths).pipe(
            Effect.map((recorded) => recorded.at(-1))
          );
          assert.strictEqual(postResult?.type, "RUN_PROOF_RESULT_RECORDED");
          assert.strictEqual(
            parseAnyRunProofResult(
              postResult!.payload["result"],
              contract
            ).results.find(
              (claimResult) =>
                claimResult.claimId === contract.proofClaims[0]?.claimId
            )?.status,
            "passed"
          );
          assert.strictEqual(executions, 1);
          const replay = yield* actOnRunVerification(runId, action, {
            rootDirectory,
            verificationServices,
          });
          assert.strictEqual(replay.kind, "idempotentReplay");
          if (
            replay.kind === "idempotentReplay" &&
            replay.originalResult.kind === "postPublicationGenerationRecorded"
          )
            assert.strictEqual(
              replay.originalResult.proofResultSequence,
              post.proofResultSequence
            );
          const verifiedProof = parseAnyRunProofResult(
            postResult!.payload["result"],
            contract
          );
          assert.strictEqual(verifiedProof.aggregate, "verified");
          const reviewer = {
            adapterKind: "deterministic" as const,
            name: defaultReviewerName,
            run: (request: ReviewRunRequest) =>
              Effect.succeed(
                ReviewResult.make({
                  findings: [],
                  phase: request.phase,
                  resultPath:
                    request.phase === "plan"
                      ? "plan-review.json"
                      : "evidence-review.json",
                  reviewerName: defaultReviewerName,
                  runId,
                  sessionEvidence: ReviewerSessionEvidence.make({
                    adapterKind: "deterministic",
                    decisionStatus: "approved",
                    evidencePath:
                      request.phase === "plan"
                        ? "plan-reviewer-session.json"
                        : "evidence-reviewer-session.json",
                    phase: request.phase,
                    resultPath:
                      request.phase === "plan"
                        ? "plan-review.json"
                        : "evidence-review.json",
                    reviewPath:
                      request.phase === "plan"
                        ? "plan-review.md"
                        : "evidence-review.md",
                    reviewerName: defaultReviewerName,
                    runId,
                    sessionKind: "local",
                    version: 1,
                  }),
                  status: "approved",
                  summary: "Natural V2 lifecycle review approved.",
                })
              ),
            sessionKind: "local" as const,
          };
          for (const phase of ["plan", "evidence"] as const) {
            const markdownPath =
              phase === "plan"
                ? paths.planReviewMarkdown
                : paths.evidenceReviewMarkdown;
            const resultPath =
              phase === "plan"
                ? paths.planReviewResult
                : paths.evidenceReviewResult;
            const sessionEvidencePath =
              phase === "plan"
                ? paths.planReviewerSession
                : paths.evidenceReviewerSession;
            yield* appendEvent(runId, paths, {
              payload: { phase, reviewerName: defaultReviewerName },
              type: "REVIEW_STARTED",
            });
            const review = yield* runReviewer(
              ReviewRunRequest.make({
                browserEvidencePath: paths.browserEvidence,
                markdownPath,
                phase,
                paths,
                resultPath,
                runId,
                sessionEvidencePath,
                specBody: spec.body,
                specTitle: spec.title,
                verificationResultPath: paths.verificationResult,
                workerPlanPath: paths.workerPlanResult,
                workerResultPath: paths.workerResult,
                workspaceManifestPath: paths.workspaceManifest,
                workspacePath: paths.workspace,
              }),
              { reviewer }
            );
            yield* appendEvent(runId, paths, {
              payload: {
                phase,
                resultPath: review.resultPath,
                reviewPath:
                  phase === "plan" ? "plan-review.md" : "evidence-review.md",
                reviewerSessionEvidencePath:
                  phase === "plan"
                    ? "plan-reviewer-session.json"
                    : "evidence-reviewer-session.json",
                reviewerName: review.reviewerName,
                status: review.status,
              },
              type: "REVIEW_COMPLETED",
            });
          }
          yield* fs.writeFileString(
            paths.prLoopState,
            `${JSON.stringify(
              Schema.decodeUnknownSync(GitHubPrLoopState)({
                blockerCount: 0,
                blockers: [],
                checksPath: "github-checks.json",
                checksStatus: "green",
                feedbackPath: "github-feedback.json",
                feedbackStatus: "clear",
                headSha: confirmed.headSha,
                nextAction: "ready-for-merge-decision",
                observedAt: "2026-07-20T22:01:00.000Z",
                pr: "145",
                runId,
                status: "ready",
                version: 1,
              }),
              null,
              2
            )}\n`
          );
          const mergeDecision = yield* recordMergeDecision(runId, {
            rootDirectory,
          });
          assert.strictEqual(
            mergeDecision.status,
            "approved",
            JSON.stringify(mergeDecision.blockers)
          );
          const mergeEvents = yield* readEvents(paths);
          const mergeDecisionEvent = mergeEvents.findLast(
            ({ type }) => type === "MERGE_DECISION_RECORDED"
          );
          assert.strictEqual(
            parseMergeDecisionV2(mergeDecisionEvent?.payload["decision"])
              .version,
            2
          );
          const readiness = yield* coordinateDeliveryMergeReadiness(
            runId,
            {
              actionId: "readiness-natural-v2",
              kind: "evaluateMergeReadiness",
              mergeMethod: "merge",
            },
            {
              freshStateReader: () => Effect.succeed(freshPullRequest),
              rootDirectory,
            }
          );
          assert.strictEqual(readiness.version, 3);
          assert.strictEqual(readiness.approved, true);
          assert.strictEqual(
            (yield* readEvents(paths)).at(-1)?.type,
            "DELIVERY_MERGE_READINESS_RECORDED"
          );
        }),
      15_000
    );

    it.effect(
      "persists one typed terminal receipt when the public verifier is interrupted at every executor stage",
      () =>
        Effect.forEach(
          ["execute", "stop", "observation", "remove"] as const,
          (stage) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const rootDirectory = yield* fs.makeTempDirectory({
                prefix: `gaia-verifier-interrupt-${stage}-`,
              });
              const runId = parseRunId(
                `run-${
                  stage === "execute"
                    ? "GaiaIexec1"
                    : stage === "stop"
                      ? "GaiaIstop1"
                      : stage === "observation"
                        ? "GaiaIobs01"
                        : "GaiaIrem01"
                }`
              );
              const paths = yield* makeRunPaths(runId, { rootDirectory });
              yield* fs.makeDirectory(paths.workspace, { recursive: true });
              yield* fs.writeFileString(paths.verificationLog, "");
              const spec = parseMarkdownSpec(
                yield* fs.readFileString(
                  `${process.cwd()}/../../examples/specs/claim-verification-v2.md`
                ),
                `claim-verification-interrupt-${stage}`
              );
              const provenance = {
                baseBranch: "main",
                baseRevision: "1".repeat(40),
                headBranch: `gaia/${runId}`,
                mode: "pullRequest" as const,
                remote: "origin",
              };
              yield* appendEvent(runId, paths, {
                payload: { delivery: provenance, specPath: "input.md" },
                type: "RUN_CREATED",
              });
              yield* deriveAndRecordRunContract({
                deliveryProvenance: provenance,
                paths,
                runId,
                spec,
              });
              yield* appendEvent(runId, paths, {
                payload: { delivery: { ...provenance, stage: "delivering" } },
                type: "DELIVERY_STARTED",
              });
              yield* appendEvent(runId, paths, {
                payload: { workspacePath: "workspace" },
                type: "WORKSPACE_PREPARED",
              });
              yield* appendEvent(runId, paths, { type: "WORKER_STARTED" });
              yield* appendEvent(runId, paths, {
                payload: { workerResultPath: "worker-result.json" },
                type: "WORKER_COMPLETED",
              });
              yield* appendEvent(runId, paths, {
                type: "VERIFICATION_STARTED",
              });
              const profile = yield* readVerificationExecutionProfile(
                parseRuntimePath(
                  `${process.cwd()}/../../profiles/claim-verification.json`
                )
              );
              const sandboxUuid = "123e4567-e89b-12d3-a456-426614174000";
              let enteredStage: typeof stage | undefined;
              let sandbox:
                | {
                    id: string;
                    name: string;
                    status: "running" | "stopped";
                    workspaces: Array<string>;
                  }
                | undefined;
              const delayed = (candidate: typeof stage) =>
                candidate === stage
                  ? Effect.sync(() => {
                      enteredStage = candidate;
                    }).pipe(
                      Effect.andThen(
                        Effect.promise(
                          () =>
                            new Promise<void>((resolve) => {
                              setTimeout(resolve, 20);
                            })
                        )
                      )
                    )
                  : Effect.void;
              const cli = makeDockerSandboxCli((command) => {
                const [verb] = command.args;
                if (verb === "version")
                  return Effect.succeed({
                    exitCode: 0,
                    stderr: "",
                    stdout:
                      "sbx version: v0.35.0 01e01520456e4126a9653471e7072e4d9b280321\n",
                  });
                if (verb === "policy")
                  return Effect.succeed({
                    exitCode: 0,
                    stderr: "",
                    stdout: JSON.stringify({
                      rules: [
                        {
                          decision: "deny",
                          resource_type: "network",
                          resources: ["**"],
                          status: "active",
                        },
                      ],
                    }),
                  });
                if (verb === "ls")
                  return Effect.succeed({
                    exitCode: 0,
                    stderr: "",
                    stdout: JSON.stringify({
                      sandboxes: sandbox === undefined ? [] : [sandbox],
                    }),
                  });
                if (verb === "create") {
                  sandbox = {
                    id: sandboxUuid,
                    name: `gaia-${runId}-smoke-command`,
                    status: "running",
                    workspaces: [paths.workspace],
                  };
                  return Effect.succeed({
                    exitCode: 0,
                    stderr: "",
                    stdout: "",
                  });
                }
                if (verb === "inspect")
                  return Effect.succeed({
                    exitCode: 0,
                    stderr: "",
                    stdout: command.args.includes("--json")
                      ? JSON.stringify({
                          agent: "shell",
                          daemon_uptime: "1m",
                          daemon_version: "v0.35.0",
                          image: profile.templateReference,
                          image_digest: profile.imageDigest,
                          kits: [],
                          mcp_gateway: false,
                          name: `gaia-${runId}-smoke-command`,
                          network: `gaia-${runId}-smoke-command`,
                          network_policy: { scope: "global" },
                          proxy: "172.17.0.0:3128",
                          sessions: 0,
                          state: "running",
                          uptime: "1s",
                          workspace: paths.workspace,
                        })
                      : [
                          `Name: gaia-${runId}-smoke-command`,
                          "Agent: shell",
                          "Kits: none",
                          "State: running (1s)",
                          `Image: ${profile.templateReference}`,
                          `Image digest: ${profile.imageDigest}`,
                          "Auth mode: not configured",
                          `Workspace: ${paths.workspace}`,
                          "Network Policy: global (local policy)",
                          "Mount Policy: allowed",
                          "Proxy: 172.17.0.0:3128",
                          "Secrets: none",
                          "Ports: none published",
                          "Sessions: 0",
                          "Daemon: v0.35.0 uptime 1m",
                        ].join("\n"),
                  });
                if (verb === "exec") {
                  if (stage === "execute")
                    return Effect.sync(() => {
                      enteredStage = "execute";
                    }).pipe(Effect.andThen(Effect.never));
                  return Effect.succeed({
                    exitCode: 0,
                    stderr: "",
                    stdout: "gaia-claim-ok\n",
                  });
                }
                if (verb === "stop")
                  return delayed("stop").pipe(
                    Effect.map(() => {
                      if (sandbox !== undefined) sandbox.status = "stopped";
                      return { exitCode: 0, stderr: "", stdout: "" };
                    })
                  );
                if (verb === "rm")
                  return delayed("remove").pipe(
                    Effect.map(() => {
                      sandbox = undefined;
                      return { exitCode: 0, stderr: "", stdout: "" };
                    })
                  );
                return Effect.die(`Unexpected sbx verb: ${verb}`);
              });
              const verificationServices = {
                executor: {
                  execute: (invocation) =>
                    executeDockerSandboxVerification(invocation, cli, profile, {
                      observeWorkspace: (workspace) =>
                        delayed("observation").pipe(
                          Effect.andThen(
                            observeVerificationWorkspaceStructuralDigest(
                              workspace
                            )
                          )
                        ),
                    }),
                  reconcile: () =>
                    Effect.die("Interruption proof must not reconcile."),
                },
                profile,
              } satisfies VerificationServices;
              const fiber = yield* Effect.scoped(
                recordRunProofResult(runId, paths, { verificationServices })
              ).pipe(Effect.forkChild);
              for (let attempts = 0; attempts < 1_000; attempts += 1) {
                if (enteredStage === stage) break;
                yield* Effect.yieldNow;
              }
              assert.strictEqual(enteredStage, stage);
              yield* Fiber.interrupt(fiber);
              const exit = yield* Fiber.await(fiber);
              assert.strictEqual(exit._tag, "Failure");
              const events = yield* readEvents(paths);
              const terminals = events.filter(
                (event) => event.type === "CLAIM_VERIFICATION_COMMAND_RECORDED"
              );
              assert.strictEqual(terminals.length, 1);
              const terminal = terminals[0];
              if (terminal === undefined)
                return assert.fail("Expected one terminal receipt event.");
              const receipt = parseVerificationCommandReceipt(
                terminal.payload["receipt"]
              );
              assert.strictEqual(receipt.status, "interrupted");
              assert.strictEqual(receipt.terminalSequence, terminal.sequence);
              assert.strictEqual(receipt.cleanup.finalAbsenceConfirmed, true);
              const claimPaths = yield* makeVerificationClaimPaths(
                paths,
                "smoke-command"
              );
              const artifact = parseVerificationCommandReceipt(
                JSON.parse(yield* fs.readFileString(claimPaths.receipt))
              );
              assert.strictEqual(artifact.receiptDigest, receipt.receiptDigest);
              assert.strictEqual(artifact.status, "interrupted");
              assert.strictEqual(sandbox, undefined);
            }),
          { discard: true }
        )
    );

    it.effect(
      "matches browser claims to the persisted observed selector and kind",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-verifier-browser-v2-",
          });
          const specPath = `${rootDirectory}/browser-selector-proof.md`;
          const outcomeStatement = "The observed browser page is available.";
          const claimStatement =
            "The browser evidence records the primary page selector.";
          const secondaryClaimStatement =
            "The browser evidence records the secondary page selector.";
          yield* fs.writeFileString(
            specPath,
            `---
title: Browser selector proof
verification:
  version: 2
  outcomes:
    - key: browser-ready
      statement: ${outcomeStatement}
      sourceItemDigest: ${deriveExplicitSpecItemDigest({ section: "acceptanceCriteria", statement: outcomeStatement })}
      prePublicationRequiredClaims: [browser-primary, browser-secondary]
      postPublicationRequiredClaims: []
      conditionalClaims: []
  claims:
    - key: browser-primary
      statement: ${claimStatement}
      sourceItemDigest: ${deriveExplicitSpecItemDigest({ section: "verificationChecks", statement: claimStatement })}
      phase: prePublication
      kind: browser
      selector:
        evidenceSelector: primary-page
        targetUrl: https://example.test/app
    - key: browser-secondary
      statement: ${secondaryClaimStatement}
      sourceItemDigest: ${deriveExplicitSpecItemDigest({ section: "verificationChecks", statement: secondaryClaimStatement })}
      phase: prePublication
      kind: browser
      selector:
        evidenceSelector: secondary-page
        targetUrl: https://example.test/app
---

## Acceptance Criteria

- ${outcomeStatement}

## Verification

- ${claimStatement}
- ${secondaryClaimStatement}
`
          );
          const summary = yield* runSpecFile(specPath, {
            browserEvidenceCollector: () =>
              Effect.succeed(
                BrowserEvidenceV2.make({
                  notes: ["Observed primary page evidence."],
                  pages: [
                    BrowserPageEvidenceV2.make({
                      consoleMessages: [],
                      evidenceKind: "page",
                      evidenceSelector: "primary-page",
                      screenshots: [
                        BrowserScreenshotEvidence.make({
                          description: "Observed primary page.",
                          path: "browser/page-1.png",
                        }),
                      ],
                      url: "https://example.test/app",
                    }),
                  ],
                  status: "collected",
                  version: 2,
                })
              ),
            browserEvidenceTargetUrl: "https://example.test/app",
            rootDirectory,
          });
          const paths = yield* makeRunPaths(summary.runId, { rootDirectory });
          const observed = (yield* readEvents(paths)).findLast(
            (event) => event.type === "BROWSER_EVIDENCE_RECORDED"
          );
          if (observed === undefined)
            return assert.fail("Expected observed browser evidence event.");
          const result = parseAnyRunProofResult(
            JSON.parse(yield* fs.readFileString(paths.verificationResult)),
            yield* loadRunContract(paths, summary.runId)
          );
          assert.strictEqual(result.version, 2);
          if (result.version !== 2) return assert.fail("Expected V2 proof.");
          const claim = result.results[0];
          assert.strictEqual(claim?.status, "passed");
          if (claim?.status !== "passed")
            return assert.fail("Expected matched browser proof.");
          assert.strictEqual(claim.evidence.length, 1);
          const evidence = claim.evidence[0];
          assert.strictEqual(evidence?.kind, "browser");
          if (evidence?.kind !== "browser")
            return assert.fail("Expected browser evidence.");
          assert.strictEqual(evidence.evidenceSelector, "primary-page");
          assert.strictEqual(evidence.eventSequence, observed.sequence);
          assert.strictEqual(evidence.targetUrl, "https://example.test/app");
          assert.strictEqual(result.results[1]?.status, "not-run");
        })
    );
  });
});

function naturalDeliveryWorktreeRunner(
  rootDirectory: string
): GitDeliveryCommandRunner {
  return ({ args, cwd }) =>
    Effect.sync(() => {
      const command = args.join(" ");
      if (command.startsWith("worktree add --detach ")) {
        const workspace = args[3];
        if (workspace !== undefined) mkdirSync(workspace, { recursive: true });
        return { stderr: "", stdout: "" };
      }
      if (command === "rev-parse --show-toplevel")
        return {
          stderr: "",
          stdout: `${cwd === rootDirectory ? rootDirectory : cwd}\n`,
        };
      if (command === "rev-parse --path-format=absolute --git-common-dir")
        return { stderr: "", stdout: `${rootDirectory}/.git\n` };
      if (command === "remote get-url origin")
        return {
          stderr: "",
          stdout: "https://github.com/cill-i-am/gaia.git\n",
        };
      if (command === "rev-parse HEAD")
        return { stderr: "", stdout: `${"1".repeat(40)}\n` };
      return { stderr: "", stdout: "" };
    });
}

function naturalPublicationRunner(
  runRoot: string,
  provenance: DeliveryProvenance
): GitHubCommandRunner {
  const commitSha = "8".repeat(40);
  const treeSha = "7".repeat(40);
  const changedStatus = "M\0src/feature.ts\0";
  let commitTimestamp = "2026-07-20T22:00:00.000Z";
  let prCreated = false;
  let pushed = false;
  let staged = false;
  return (input: GitHubCommandInput) =>
    Effect.sync(() => {
      const args = input.args.join(" ");
      if (input.command === "git") {
        if (args === "remote get-url origin")
          return naturalCommandSuccess(
            "https://github.com/cill-i-am/gaia.git\n"
          );
        if (
          args ===
          `diff --name-status -z --find-renames ${provenance.baseRevision} --`
        )
          return naturalCommandSuccess(changedStatus);
        if (args === "ls-files --others --exclude-standard -z")
          return naturalCommandSuccess("");
        if (args.startsWith("show-ref --verify --quiet "))
          return { exitCode: 1, stderr: "", stdout: "" };
        if (
          args ===
          `diff --cached --name-status -z ${provenance.baseRevision} --`
        )
          return naturalCommandSuccess(staged ? changedStatus : "");
        if (input.args[0] === "add") {
          staged = true;
          return naturalCommandSuccess("");
        }
        if (input.args.includes("commit")) {
          commitTimestamp = input.env?.GIT_AUTHOR_DATE ?? commitTimestamp;
          return naturalCommandSuccess("");
        }
        if (args === "rev-parse HEAD")
          return naturalCommandSuccess(`${commitSha}\n`);
        if (args.startsWith("rev-parse refs/heads/"))
          return naturalCommandSuccess(`${provenance.baseRevision}\n`);
        if (args === "rev-parse HEAD^{tree}")
          return naturalCommandSuccess(`${treeSha}\n`);
        if (args === "write-tree") return naturalCommandSuccess(`${treeSha}\n`);
        if (args.startsWith("show -s --format="))
          return naturalCommandSuccess(
            [
              provenance.baseRevision,
              treeSha,
              `feat: deliver ${runRoot.split("/").at(-1)}\n`,
              "Gaia Delivery",
              "delivery@gaia.local",
              commitTimestamp,
              "Gaia Delivery",
              "delivery@gaia.local",
              commitTimestamp,
            ].join("\0")
          );
        if (args.startsWith("diff-tree --no-commit-id --name-status -z "))
          return naturalCommandSuccess(changedStatus);
        if (args.startsWith("ls-remote --heads "))
          return naturalCommandSuccess(
            pushed ? `${commitSha}\trefs/heads/${provenance.headBranch}\n` : ""
          );
        if (input.args[0] === "push") {
          pushed = true;
          return naturalCommandSuccess("");
        }
        return naturalCommandSuccess("");
      }
      if (input.command === "gh" && input.args[0] === "pr") {
        if (input.args[1] === "create") {
          prCreated = true;
          return naturalCommandSuccess(
            "https://github.com/cill-i-am/gaia/pull/91\n"
          );
        }
        if (input.args[1] === "list") {
          if (!prCreated) return naturalCommandSuccess("[]\n");
          const body = readFileSync(`${runRoot}/delivery-pr-body.md`, "utf8");
          return naturalCommandSuccess(
            `${JSON.stringify([
              {
                baseRefName: provenance.baseBranch,
                body,
                headRefName: provenance.headBranch,
                headRefOid: commitSha,
                isDraft: true,
                number: 91,
                state: "OPEN",
                url: "https://github.com/cill-i-am/gaia/pull/91",
              },
            ])}\n`
          );
        }
      }
      return naturalCommandSuccess("");
    });
}

function naturalCommandSuccess(stdout: string): CommandExecutionResult {
  return { exitCode: 0, stderr: "", stdout };
}
