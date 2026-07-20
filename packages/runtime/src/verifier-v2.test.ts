import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import {
  DeliveryPublicationAttempted,
  DeliveryPublicationConfirmed,
  DeliveryPublicationIntent,
  encodeDeliveryPublicationJson,
  parseMarkdownSpec,
  parseRunId,
  VerificationActionRequestSchema,
} from "@gaia/core";
import { Effect, FileSystem, Schema } from "effect";

import { StagedDockerSandboxVerificationReceiptSchema } from "./docker-sandbox-verification-executor.js";
import { appendEvent, readEvents } from "./event-store.js";
import { makeRunPaths, parseRuntimePath } from "./paths.js";
import { deriveAndRecordRunContract } from "./run-contract.js";
import { actOnRunVerification } from "./server-workflows.js";
import { readVerificationExecutionProfile } from "./verification-execution-profile.js";
import { recordRunProofResult } from "./verifier.js";
import { observeWorkspaceStructuralDigest } from "./workspace-snapshot.js";

describe("V2 claim verifier", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "records the exact command lifecycle and claim-matched result",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-verifier-v2-",
          });
          const runId = parseRunId("run-Gaia145v2a");
          const paths = yield* makeRunPaths(runId, { rootDirectory });
          yield* fs.makeDirectory(paths.workspace, { recursive: true });
          yield* fs.writeFileString(paths.verificationLog, "");
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
            payload: { delivery: { ...provenance, stage: "delivering" } },
            type: "DELIVERY_STARTED",
          });
          yield* appendEvent(runId, paths, {
            payload: { workspacePath: "workspace" },
            type: "WORKSPACE_PREPARED",
          });
          yield* appendEvent(runId, paths, { type: "WORKER_STARTED" });
          const workerCompletion = yield* appendEvent(runId, paths, {
            payload: { workerResultPath: "worker-result.json" },
            type: "WORKER_COMPLETED",
          });
          yield* appendEvent(runId, paths, { type: "VERIFICATION_STARTED" });

          const profile = yield* readVerificationExecutionProfile(
            parseRuntimePath(
              `${process.cwd()}/../../profiles/claim-verification.json`
            )
          );
          let executions = 0;
          const result = yield* recordRunProofResult(runId, paths, {
            verificationServices: {
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
            },
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
          const publicationBase = {
            baseBranch: provenance.baseBranch,
            baseRevision: provenance.baseRevision,
            branchName: provenance.headBranch,
            commitMessage: "feat(runtime): verify claims",
            commitTimestamp: "2026-07-20T22:00:00.000Z",
            digestVersion: 1 as const,
            operationId: "publish-gaia-145",
            payloadDigest: "6".repeat(64),
            sourcePaths: ["packages/runtime/src/verifier.ts"],
            treeSha: "7".repeat(40),
          };
          const intent = DeliveryPublicationIntent.make({
            ...publicationBase,
            state: "intentRecorded",
          });
          yield* appendEvent(runId, paths, {
            payload: { publication: encodeDeliveryPublicationJson(intent) },
            type: "DELIVERY_PUBLICATION_INTENT_RECORDED",
          });
          const attempted = DeliveryPublicationAttempted.make({
            ...publicationBase,
            commitSha: "8".repeat(40),
            state: "attempted",
          });
          yield* appendEvent(runId, paths, {
            payload: { publication: encodeDeliveryPublicationJson(attempted) },
            type: "DELIVERY_PUBLICATION_ATTEMPTED",
          });
          const confirmed = DeliveryPublicationConfirmed.make({
            ...publicationBase,
            commitSha: "8".repeat(40),
            draft: true,
            headSha: "8".repeat(40),
            prNumber: 145,
            prUrl: "https://github.com/cill-i-am/gaia/pull/145",
            state: "confirmed",
          });
          const publication = yield* appendEvent(runId, paths, {
            payload: { publication: encodeDeliveryPublicationJson(confirmed) },
            type: "DELIVERY_PUBLICATION_CONFIRMED",
          });
          const action = Schema.decodeUnknownSync(
            VerificationActionRequestSchema
          )({
            actionId: "post-publication-gaia-145",
            expectedContentAuthoritySequence: workerCompletion.event.sequence,
            expectedContractDigest: contract.contractDigest,
            expectedEventSequence: publication.event.sequence,
            expectedHeadSha: confirmed.headSha,
            expectedPublicationSequence: publication.event.sequence,
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
          });
          assert.strictEqual(post.kind, "postPublicationGenerationRecorded");
          if (post.kind !== "postPublicationGenerationRecorded")
            return assert.fail("Expected post-publication generation.");
          assert.strictEqual(
            post.proofResultSequence,
            post.generationSequence + 1
          );
          const replay = yield* actOnRunVerification(runId, action, {
            rootDirectory,
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
        })
    );
  });
});
