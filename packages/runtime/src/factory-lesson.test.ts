import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import {
  encodeAnyRunContractJson,
  encodeAnyRunProofResultJson,
  encodeFailureRepairReceiptJson,
  CommandClaimEvidenceV2,
  FailureRepairDispatchAttempted,
  FailureRepairIntent,
  FailureRepairTurnCompleted,
  FailureRepairVerified,
  FactoryArtifactIdSchema,
  FactoryLessonContextObservationV1,
  FactoryLessonContextSelectionV1,
  HarnessCapabilities,
  HarnessProviderDescriptor,
  makeFactoryLessonContextObservationV1,
  makeFactoryLessonCandidateV1,
  makeFactoryLessonReviewReceiptV1,
  makeFailureDigestV1,
  makeNoRawTelemetryAttestationV1,
  makeProofEvidenceIdV2,
  makeRunContractV2,
  makeRunEvent,
  makeRunProofResultV2,
  makeVerificationCommandRequestDigest,
  ModelInvocationEpisodeStartV1,
  ModelInvocationObservationV1,
  encodeWorkerRecoveryReceiptJson,
  parseHarnessProfileId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseFactoryLessonContextSelectionV1,
  parseRunEventSequence,
  parseRunId,
  parseMarkdownSpec,
  projectHarnessEvents,
  ProofClaimResultV2Schema,
  ResolvedHarnessExecution,
  resolveFactoryLessonContextAttribution,
  type RunContractV2,
  type RunEvent,
} from "@gaia/core";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";

import { makeCodexHarnessConfig } from "./codex-harness.js";
import { appendEvent, readEvents } from "./event-store.js";
import {
  readFactoryLessons,
  readFactoryLessonsArtifact,
  rebuildFactoryLessons,
  recordFactoryLessonReview,
} from "./factory-lesson.js";
import { readFactoryRunArtifact } from "./factory-run-read-api.js";
import type { HarnessProvider } from "./harness-session.js";
import {
  codexAppServerHarnessName,
  codexHarnessName,
  defaultHarnessName,
  HarnessRunResult,
  processHarnessName,
} from "./harness.js";
import {
  appendEvent as appendPublicRuntimeEvent,
  appendHarnessSessionEvent as appendPublicHarnessSessionEvent,
  type AppendEventInput,
} from "./index.js";
import { interactiveSessionHarness } from "./interactive-harness.js";
import {
  commitDerivedAppModelInvocationEpisode,
  loadModelInvocationPair,
} from "./model-invocation.js";
import { makeRunPaths, parseRunStorageRootInput } from "./paths.js";
import { readLocalRunArtifact } from "./run-read-api.js";
import {
  testHarnessCapabilities,
  testHarnessProvider,
} from "./test-support.js";
import { continueAcceptedRun, runSpecFile } from "./workflows.js";

const sourceRunId = parseRunId("run-Gaia150src");
const reviewerRef = "linear-comment:gaia-150-review";
const factoryLessonsArtifactId = Schema.decodeUnknownSync(
  FactoryArtifactIdSchema
)("factory-lessons");

const lessonInput = {
  applicability: { episodeRole: "workerInitial" as const, version: 1 as const },
  carryingCostOwner: "@gaia/core",
  compactLesson:
    "When constructing repair context, project only authenticated FailureDigestV1 evidence; never include raw stdout, stderr, transcripts, or secrets.",
  durableOwner: "@gaia/core/projectFailureEvidenceV1",
  durableOwnerDigest:
    "3ec8565c59aa1f8bc8fbfdaa1c3e7fc3eb40ac8ca3568d02f0a7894f89c14777",
  durableOwnerVersion: "gaia.failure-evidence-projection.v1",
  expectedEffect:
    "Bounded authenticated repair context excludes raw failure output and secrets.",
  retirementCondition:
    "Retire after every failure-context producer uses a versioned successor and compatibility proof shows no v1 consumer remains.",
  version: 1 as const,
};

describe("factory lesson runtime", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "records an idempotent reviewed strict-V2 proof source without starting a provider session (generic append exclusion: rejects forged offered attribution through the public runtime append surface)",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-proof-source-",
          });
          const source = yield* writeRepairSource(root, true);
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const review = makeAcceptedProofReview(candidate, source);
          const before = yield* readEvents(source.paths);

          const recorded = yield* recordFactoryLessonReview(
            sourceRunId,
            review.input,
            { rootDirectory: root }
          );
          const after = yield* readEvents(source.paths);
          const read = yield* readFactoryLessons({ rootDirectory: root });
          const artifact = yield* readFactoryLessonsArtifact(sourceRunId, {
            rootDirectory: root,
          });
          const rebuilt = yield* rebuildFactoryLessons(sourceRunId, {
            rootDirectory: root,
          });

          assert.strictEqual(recorded.review.decision, "accepted");
          if (recorded.review.decision !== "accepted")
            return yield* Effect.die("Proof review fixture was not accepted.");
          assert.strictEqual(
            recorded.review.source.type,
            "RUN_PROOF_RESULT_RECORDED"
          );
          if (recorded.review.source.type !== "RUN_PROOF_RESULT_RECORDED")
            return yield* Effect.die("Proof review source was not strict-V2.");
          assert.strictEqual(
            recorded.review.source.resultDigest,
            source.freshProof.resultDigest
          );
          assert.strictEqual(after.length, before.length + 1);
          assert.deepEqual(
            after.slice(before.length).map((event) => event.type),
            ["FACTORY_LESSON_REVIEW_RECORDED"]
          );
          assert.strictEqual(
            after.at(-1)?.type,
            "FACTORY_LESSON_REVIEW_RECORDED"
          );
          assert.deepEqual(recorded.projection, read);
          assert.deepEqual(recorded.artifact, artifact);
          assert.deepEqual(artifact, rebuilt);

          const repeated = yield* recordFactoryLessonReview(
            sourceRunId,
            review.input,
            { rootDirectory: root }
          );
          const afterRepeated = yield* readEvents(source.paths);
          assert.deepEqual(repeated.event, recorded.event);
          assert.deepEqual(repeated.artifact, recorded.artifact);
          assert.strictEqual(afterRepeated.length, after.length);

          const conflict = yield* Effect.flip(
            recordFactoryLessonReview(
              sourceRunId,
              {
                ...review.input,
                source: {
                  ...review.input.source,
                  resultDigest: "a".repeat(64),
                },
              },
              { rootDirectory: root }
            )
          );
          if (!("code" in conflict))
            return yield* Effect.die("Conflicting proof review was untyped.");
          assert.strictEqual(conflict.code, "InvalidFactoryLessonHistory");
          assert.strictEqual(
            (yield* readEvents(source.paths)).length,
            after.length
          );
          assert.isFalse(
            after
              .slice(before.length)
              .some((event) =>
                [
                  "HARNESS_SESSION_EVENT_RECORDED",
                  "CORRELATION_RECORDED",
                  "WORKER_STARTED",
                ].includes(event.type)
              )
          );
        })
    );

    it.effect(
      "records a terminal reviewed transition before rebuilding its disposable event-derived projection",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-",
          });
          const source = yield* writeRepairSource(root, true);
          assert.lengthOf(
            (yield* readFactoryLessons({ rootDirectory: root })).active,
            0
          );
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const review = makeAcceptedReview(candidate, source);
          const rawTelemetry = [
            "2026-07-25T20:31:22.123Z INFO worker stderr: request failed",
            "user: paste the run output assistant: here is the complete transcript",
          ] as const;
          for (const field of [
            "compactLesson",
            "expectedEffect",
            "retirementCondition",
          ] as const)
            for (const fixture of rawTelemetry) {
              const rawCandidate = makeFactoryLessonCandidateV1({
                ...lessonInput,
                [field]: fixture,
              });
              const missingAttestation = yield* Effect.flip(
                recordFactoryLessonReview(
                  sourceRunId,
                  {
                    candidate: rawCandidate,
                    decision: "accepted",
                    source: review.input.source,
                  } as never,
                  { rootDirectory: root }
                )
              );
              const mutatedBytes = yield* Effect.flip(
                recordFactoryLessonReview(
                  sourceRunId,
                  {
                    ...review.input,
                    candidate: {
                      ...candidate,
                      [field]: fixture,
                    },
                  },
                  { rootDirectory: root }
                )
              );
              if (!("code" in missingAttestation) || !("code" in mutatedBytes))
                return yield* Effect.die(
                  "Attestation rejection was not typed."
                );
              assert.strictEqual(
                missingAttestation.code,
                "InvalidFactoryLessonReview"
              );
              assert.strictEqual(
                mutatedBytes.code,
                "InvalidFactoryLessonReview"
              );
            }
          assert.strictEqual((yield* readEvents(source.paths)).length, 15);

          const recorded = yield* recordFactoryLessonReview(
            sourceRunId,
            review.input,
            { rootDirectory: root }
          );
          const events = yield* readEvents(source.paths);
          const artifact = yield* readFactoryLessonsArtifact(sourceRunId, {
            rootDirectory: root,
          });

          assert.strictEqual(recorded.event.sequence, 16);
          assert.strictEqual(
            events.at(-1)?.type,
            "FACTORY_LESSON_REVIEW_RECORDED"
          );
          assert.deepEqual(artifact, recorded.artifact);
          assert.strictEqual(artifact.lessons.active.length, 1);
          assert.strictEqual(
            artifact.lessons.active[0]?.projection.durableOwnerDigest,
            lessonInput.durableOwnerDigest
          );
          const tamperedArtifact = JSON.parse(JSON.stringify(artifact)) as {
            lessons: {
              active: Array<{
                projection: { compactLesson: string };
              }>;
            };
          };
          const rawArtifactSentinel =
            "2026-07-25T20:31:22.123Z INFO worker stderr: raw transcript";
          const tamperedProjection =
            tamperedArtifact.lessons.active[0]?.projection;
          if (tamperedProjection === undefined)
            return yield* Effect.die("Tampered artifact fixture is missing.");
          tamperedProjection.compactLesson = rawArtifactSentinel;
          yield* fs.writeFileString(
            source.paths.factoryLessons,
            `${JSON.stringify(tamperedArtifact)}\n`
          );
          const directArtifact = yield* readFactoryLessonsArtifact(
            sourceRunId,
            {
              rootDirectory: root,
            }
          );
          const localArtifact = yield* readLocalRunArtifact(
            sourceRunId,
            "factory-lessons",
            { rootDirectory: root }
          );
          const factoryArtifact = yield* readFactoryRunArtifact(
            sourceRunId,
            factoryLessonsArtifactId,
            { rootDirectory: root }
          );
          for (const authoritativeBody of [
            JSON.stringify(directArtifact),
            localArtifact.body,
            factoryArtifact.body,
          ]) {
            assert.notInclude(authoritativeBody, rawArtifactSentinel);
            assert.include(authoritativeBody, candidate.compactLesson);
          }
          const retried = yield* recordFactoryLessonReview(
            sourceRunId,
            review.input,
            { rootDirectory: root }
          );
          assert.deepEqual(retried.event, recorded.event);
          assert.strictEqual((yield* readEvents(source.paths)).length, 16);

          yield* fs.writeFileString(source.paths.factoryLessons, "{}\n");
          assert.strictEqual(
            (yield* readFactoryLessons({ rootDirectory: root })).active[0]
              ?.projection.lessonId,
            review.receipt.projection.lessonId
          );
          assert.deepEqual(
            (yield* recordFactoryLessonReview(sourceRunId, review.input, {
              rootDirectory: root,
            })).event,
            recorded.event
          );
          assert.deepEqual(
            yield* readFactoryLessonsArtifact(sourceRunId, {
              rootDirectory: root,
            }),
            artifact
          );

          const duplicateOwnerCandidate = makeFactoryLessonCandidateV1({
            ...lessonInput,
            compactLesson:
              "Duplicate the same durable owner identity with different prose.",
          });
          const duplicateOwner = yield* Effect.flip(
            recordFactoryLessonReview(
              sourceRunId,
              makeAcceptedReview(duplicateOwnerCandidate, source).input,
              { rootDirectory: root }
            )
          );
          if (!("code" in duplicateOwner))
            return yield* Effect.die(
              "Duplicate owner rejection was not typed."
            );
          assert.strictEqual(
            duplicateOwner.code,
            "InvalidFactoryLessonHistory"
          );
          assert.strictEqual((yield* readEvents(source.paths)).length, 16);
          const persistedReview = JSON.stringify({
            artifact,
            events,
          });
          assert.notInclude(persistedReview, "INFO worker stderr");
          assert.notInclude(persistedReview, "complete transcript");

          yield* fs.remove(source.paths.factoryLessons);
          assert.strictEqual(
            (yield* readFactoryLessons({ rootDirectory: root })).active[0]
              ?.projection.lessonId,
            review.receipt.projection.lessonId
          );
          assert.isFalse(yield* fs.exists(source.paths.factoryLessons));
          const missingLocalArtifact = yield* readLocalRunArtifact(
            sourceRunId,
            "factory-lessons",
            { rootDirectory: root }
          );
          const missingFactoryArtifact = yield* readFactoryRunArtifact(
            sourceRunId,
            factoryLessonsArtifactId,
            { rootDirectory: root }
          );
          for (const authoritativeBody of [
            missingLocalArtifact.body,
            missingFactoryArtifact.body,
          ])
            assert.include(authoritativeBody, candidate.compactLesson);
          assert.deepEqual(
            yield* rebuildFactoryLessons(sourceRunId, {
              rootDirectory: root,
            }),
            artifact
          );
          assert.deepEqual(
            yield* readFactoryLessonsArtifact(sourceRunId, {
              rootDirectory: root,
            }),
            artifact
          );

          const secretCandidate = makeFactoryLessonCandidateV1({
            ...lessonInput,
            expectedEffect: "Preserve password=abc123 in later context.",
          });
          const secretReview = makeAcceptedReview(secretCandidate, source);
          const rejected = yield* Effect.flip(
            recordFactoryLessonReview(sourceRunId, secretReview.input, {
              rootDirectory: root,
            })
          );
          if (!("code" in rejected))
            return yield* Effect.die("Secret rejection was not typed.");
          assert.strictEqual(rejected.code, "AcceptedInputRejected");
          assert.strictEqual((yield* readEvents(source.paths)).length, 16);
          assert.deepEqual(
            yield* readFactoryLessonsArtifact(sourceRunId, {
              rootDirectory: root,
            }),
            artifact
          );
        })
    );

    it.effect(
      "keeps an exact review retry idempotent after a legal terminal failure reopens into worker recovery",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-retry-",
          });
          const source = yield* writeRepairSource(root, true);
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const review = makeAcceptedReview(candidate, source);
          const recorded = yield* recordFactoryLessonReview(
            sourceRunId,
            review.input,
            { rootDirectory: root }
          );
          yield* appendEvent(sourceRunId, source.paths, {
            payload: {
              code: "WorkerRecoveryRequired",
              message: "A legal recovery reopened the reviewed source.",
              recoverable: true,
              stage: "runningWorker",
            },
            type: "RUN_FAILED",
          });
          yield* appendEvent(sourceRunId, source.paths, {
            payload: {
              recovery: encodeWorkerRecoveryReceiptJson({
                actionId: "recover-gaia-150",
                attempt: 1,
                expectedFailureSequence: 17,
                expectedSessionId: parseHarnessSessionId(
                  `session-${sourceRunId}`
                ),
                harnessProfileId: parseHarnessProfileId("codexAppServer"),
                maxAttempts: 1,
                model: "gpt-5.4",
                nativeTurnIdDigest: "7".repeat(64),
                payloadDigest: "8".repeat(64),
                state: "dispatchConfirmed",
              }),
            },
            type: "WORKER_RECOVERY_RECORDED",
          });

          const retried = yield* recordFactoryLessonReview(
            sourceRunId,
            review.input,
            { rootDirectory: root }
          );
          assert.deepEqual(retried.event, recorded.event);
          assert.strictEqual((yield* readEvents(source.paths)).length, 18);
        })
    );

    it.effect(
      "records finite superseded and retired transitions while rejecting conflicts before append",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-lifecycle-",
          });
          const source = yield* writeRepairSource(root, true);
          const firstCandidate = makeFactoryLessonCandidateV1(lessonInput);
          const first = makeAcceptedReview(firstCandidate, source);
          yield* recordFactoryLessonReview(sourceRunId, first.input, {
            rootDirectory: root,
          });
          const replacementCandidate = makeFactoryLessonCandidateV1({
            ...lessonInput,
            compactLesson: "Use the versioned replacement evidence owner.",
            durableOwnerDigest: "4".repeat(64),
            durableOwnerVersion: "gaia.failure-evidence-projection.v2",
          });
          const replacement = makeAcceptedReview(replacementCandidate, source);
          yield* recordFactoryLessonReview(sourceRunId, replacement.input, {
            rootDirectory: root,
          });
          const supersededInput = {
            decision: "superseded" as const,
            lessonId: first.receipt.projection.lessonId,
            replacement: {
              lessonId: replacement.receipt.projection.lessonId,
              projectionDigest: replacement.receipt.projection.projectionDigest,
              version: 1 as const,
            },
            reviewerRef,
          };
          const superseded = yield* recordFactoryLessonReview(
            sourceRunId,
            supersededInput,
            { rootDirectory: root }
          );
          assert.deepEqual(
            superseded.projection.active.map(
              ({ projection }) => projection.lessonId
            ),
            [replacement.receipt.projection.lessonId]
          );
          const eventCount = (yield* readEvents(source.paths)).length;
          assert.deepEqual(
            (yield* recordFactoryLessonReview(sourceRunId, supersededInput, {
              rootDirectory: root,
            })).event,
            superseded.event
          );
          assert.strictEqual(
            (yield* readEvents(source.paths)).length,
            eventCount
          );

          const conflict = yield* Effect.flip(
            recordFactoryLessonReview(
              sourceRunId,
              {
                decision: "retired",
                lessonId: first.receipt.projection.lessonId,
                retirementEvidence: {
                  kind: "test",
                  ref: "test:already-superseded",
                  version: 1,
                },
                reviewerRef,
              },
              { rootDirectory: root }
            )
          );
          if (!("code" in conflict))
            return yield* Effect.die(
              "Conflicting transition rejection was not typed."
            );
          assert.strictEqual(conflict.code, "InvalidFactoryLessonHistory");
          assert.strictEqual(
            (yield* readEvents(source.paths)).length,
            eventCount
          );

          const retired = yield* recordFactoryLessonReview(
            sourceRunId,
            {
              decision: "retired",
              lessonId: replacement.receipt.projection.lessonId,
              retirementEvidence: {
                kind: "test",
                ref: "test:replacement-retired",
                version: 1,
              },
              reviewerRef,
            },
            { rootDirectory: root }
          );
          assert.lengthOf(retired.projection.active, 0);
          assert.deepEqual(
            retired.projection.history.map(({ state }) => state),
            ["accepted", "accepted", "superseded", "retired"]
          );
        })
    );

    it.effect(
      "records an explicit review after the exact source run fails terminally",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-failed-source-",
          });
          const source = yield* writeRepairSource(root, "failed");
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const recorded = yield* recordFactoryLessonReview(
            sourceRunId,
            makeAcceptedReview(candidate, source).input,
            { rootDirectory: root }
          );

          assert.strictEqual(recorded.event.sequence, 15);
          assert.strictEqual(recorded.projection.active.length, 1);
        })
    );

    it.effect(
      "rejects review before the exact source run reaches a terminal state",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-nonterminal-",
          });
          const source = yield* writeRepairSource(root, false);
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const failure = yield* Effect.flip(
            recordFactoryLessonReview(
              sourceRunId,
              makeAcceptedReview(candidate, source).input,
              { rootDirectory: root }
            )
          );

          if (!("code" in failure))
            return yield* Effect.die("Terminal rejection was not typed.");
          assert.strictEqual(failure.code, "FactoryLessonSourceNotTerminal");
          assert.strictEqual((yield* readEvents(source.paths)).length, 13);
          assert.isFalse(yield* fs.exists(source.paths.factoryLessons));
        })
    );

    it.effect(
      "rejects forged offered attribution through the public runtime append surface",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-public-forgery-",
          });
          const source = yield* writeRepairSource(root, true);
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const review = makeAcceptedReview(candidate, source);
          yield* recordFactoryLessonReview(sourceRunId, review.input, {
            rootDirectory: root,
          });

          const specPath = `${root}/public-forgery-worker.md`;
          yield* fs.writeFileString(
            specPath,
            "# Public forgery worker\n\nReject generic offered attribution.\n"
          );
          const summary = yield* runSpecFile(specPath, {
            rootDirectory: root,
            workerHarness: {
              name: codexAppServerHarnessName,
              run: (request) =>
                Effect.gen(function* () {
                  const paths = yield* makeRunPaths(request.runId, {
                    rootDirectory: root,
                  });
                  const events = yield* readEvents(paths);
                  const workerStarted = events.find(
                    (event) => event.type === "WORKER_STARTED"
                  );
                  if (workerStarted === undefined)
                    return yield* Effect.die(
                      "Public forgery fixture did not reach WORKER_STARTED."
                    );
                  const selection = parseFactoryLessonContextSelectionV1(
                    workerStarted.payload["factoryLessonContextSelection"]
                  );
                  const lesson = selection.lessons[0];
                  if (lesson === undefined)
                    return yield* Effect.die(
                      "Public forgery fixture did not select a lesson."
                    );
                  const forgedObservation =
                    makeFactoryLessonContextObservationV1({
                      contextContentDigest: selection.contextContentDigest,
                      episodeRole: "workerInitial",
                      kind: "offered",
                      lesson,
                      selectionDigest: selection.selectionDigest,
                      source: "codexBatchTransport",
                      targetRunId: request.runId,
                      trust: "high",
                    });
                  const failure = yield* appendPublicRuntimeEvent(
                    request.runId,
                    paths,
                    {
                      payload: {
                        factoryLessonContextObservation: Schema.encodeSync(
                          FactoryLessonContextObservationV1
                        )(forgedObservation),
                      },
                      type: "FACTORY_LESSON_CONTEXT_OBSERVED",
                    } as unknown as AppendEventInput
                  ).pipe(
                    Effect.match({
                      onFailure: (error) => error,
                      onSuccess: () => undefined,
                    })
                  );
                  if (failure === undefined)
                    return yield* Effect.die(
                      "Public runtime append accepted forged offered attribution."
                    );
                  if (!("code" in failure))
                    return yield* Effect.die(
                      "Public forgery rejection was not typed."
                    );
                  assert.strictEqual(
                    failure.code,
                    "UnsafeFactoryLessonContextObservationAppend"
                  );
                  assert.isFalse(failure.recoverable);

                  const result = HarnessRunResult.make({
                    changedWorkspacePaths: ["output.txt"],
                    exitCode: 0,
                    harnessName: codexAppServerHarnessName,
                    outputArtifacts: ["workspace/output.txt"],
                    resultPath: "worker-result.json",
                    runId: request.runId,
                    status: "completed",
                    summary: "Public forgery rejected.",
                  });
                  yield* fs.writeFileString(
                    request.workspaceOutputPath,
                    `Public forgery rejected for ${request.runId}.\n`
                  );
                  yield* fs.writeFileString(
                    request.workerResultPath,
                    `${JSON.stringify(result)}\n`
                  );
                  return result;
                }).pipe(Effect.orDie),
            },
          });
          const paths = yield* makeRunPaths(summary.runId, {
            rootDirectory: root,
          });
          const attribution = resolveFactoryLessonContextAttribution(
            yield* readEvents(paths)
          );
          assert.deepEqual(
            attribution.attributions[0]?.observations.map(
              ({ kind, source }) => ({ kind, source })
            ),
            [{ kind: "unobservable", source: "gaiaBoundary" }]
          );
        })
    );

    it.effect(
      "selects accepted lessons only for a later workerInitial input and records exact offered attribution",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-context-",
          });
          const source = yield* writeRepairSource(root, true);
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const review = makeAcceptedReview(candidate, source);
          yield* recordFactoryLessonReview(sourceRunId, review.input, {
            rootDirectory: root,
          });

          const specPath = `${root}/later-worker.md`;
          yield* fs.writeFileString(
            specPath,
            "# Later worker\n\nUse the accepted reviewed context.\n"
          );
          let offeredInput = "";
          const summary = yield* runSpecFile(specPath, {
            rootDirectory: root,
            workerHarness: interactiveSessionHarness({
              provider: {
                ...testHarnessProvider,
                createSession: (request) =>
                  Effect.sync(() => {
                    offeredInput = request.input.text;
                    writeFileSync(
                      `${root}/${request.workspacePath}/output.txt`,
                      `${request.sessionId.slice("session-".length)}\n`,
                      "utf8"
                    );
                  }).pipe(
                    Effect.flatMap(() =>
                      testHarnessProvider.createSession(request)
                    )
                  ),
              },
              rootDirectory: root,
            }),
          });
          const paths = yield* makeRunPaths(summary.runId, {
            rootDirectory: root,
          });
          const events = yield* readEvents(paths);
          const workerStarted = events.find(
            (event) => event.type === "WORKER_STARTED"
          );
          assert.isDefined(workerStarted);
          const selection = parseFactoryLessonContextSelectionV1(
            workerStarted?.payload["factoryLessonContextSelection"]
          );
          const episode = workerStarted?.payload["modelInvocationEpisode"];
          assert.isDefined(episode);
          const pair = yield* loadModelInvocationPair(
            paths,
            Schema.decodeUnknownSync(ModelInvocationEpisodeStartV1)(episode)
          );
          const attribution = resolveFactoryLessonContextAttribution(events);
          const selectedLesson = selection.lessons[0];

          assert.deepEqual(
            Schema.decodeUnknownSync(FactoryLessonContextSelectionV1)(
              selection
            ),
            selection
          );
          assert.strictEqual(selection.episodeRole, "workerInitial");
          assert.strictEqual(selection.lessons.length, 1);
          assert.strictEqual(
            selection.lessons[0]?.lessonId,
            review.receipt.projection.lessonId
          );
          if (selectedLesson === undefined)
            return yield* Effect.die("Selected lesson is missing.");
          const exactRenderedRef = renderedFactoryLessonRef(selectedLesson);
          assert.include(offeredInput, exactRenderedRef);
          assert.include(offeredInput, candidate.compactLesson);
          assert.isBelow(
            offeredInput.indexOf(exactRenderedRef),
            offeredInput.indexOf(candidate.compactLesson)
          );
          assert.notInclude(offeredInput, candidate.expectedEffect);
          assert.notInclude(offeredInput, candidate.retirementCondition);
          assert.strictEqual(pair.rendered.text, offeredInput);
          assert.strictEqual(
            pair.context.payload.contextContentDigest,
            selection.contextContentDigest
          );
          assert.strictEqual(attribution.attributions.length, 1);
          const observations = attribution.attributions[0]?.observations;
          if (observations === undefined)
            return yield* Effect.die("Selected lesson observation is missing.");
          assert.deepInclude(observations[0], {
            kind: "offered",
            lesson: selectedLesson,
            source: "codexAppServerTransport",
            trust: "high",
          });
          assert.deepInclude(observations[1], {
            kind: "unobservable",
            lesson: selectedLesson,
            source: "gaiaBoundary",
            trust: "none",
          });

          const derivedArtifact = yield* readFactoryLessonsArtifact(
            summary.runId,
            { rootDirectory: root }
          );
          assert.deepEqual(derivedArtifact.selection, selection);
          assert.deepEqual(
            JSON.parse(JSON.stringify(derivedArtifact.attributions)),
            JSON.parse(JSON.stringify(attribution.attributions))
          );
          const localArtifact = yield* readLocalRunArtifact(
            summary.runId,
            "factory-lessons",
            { rootDirectory: root }
          );
          assert.include(localArtifact.body, candidate.compactLesson);
        })
    );

    it.effect(
      "derives failureRepair without inheriting selected factory lesson context",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-failure-repair-derived-",
          });
          const prepared = yield* prepareSelectedFactoryLessonRun(
            root,
            "failure-repair-derived"
          );
          const episode = yield* commitDerivedAppModelInvocationEpisode({
            episodeKey: `failureRepair:${prepared.candidate.candidateDigest}:1`,
            episodeRole: "failureRepair",
            events: prepared.events,
            paths: prepared.paths,
            runId: prepared.runId,
            taskInput: "Repair only the exact authenticated failure.",
          });
          if (episode === undefined)
            return yield* Effect.die(
              "Derived failure-repair episode is missing."
            );
          const pair = yield* loadModelInvocationPair(prepared.paths, episode);
          const content = pair.context.payload.content;
          const selectedLesson = prepared.selection.lessons[0];
          if (selectedLesson === undefined)
            return yield* Effect.die("Selected lesson is missing.");

          assert.strictEqual(content.episodeRole, "failureRepair");
          assert.isFalse(
            content.contentRefs.some(({ kind }) => kind === "factoryLesson/v1")
          );
          assert.notInclude(
            pair.rendered.text,
            renderedFactoryLessonRef(selectedLesson)
          );
          assert.notInclude(
            pair.rendered.text,
            prepared.candidate.compactLesson
          );
          assert.isFalse(
            content.planningFacts.includes(prepared.candidate.compactLesson)
          );
        })
    );

    it.effect(
      "derives an ordinary App episode without the private factory lesson ref",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-ordinary-derived-",
          });
          const prepared = yield* prepareSelectedFactoryLessonRun(
            root,
            "ordinary-derived"
          );
          const episode = yield* commitDerivedAppModelInvocationEpisode({
            episodeKey: `operatorFollowUp:${prepared.candidate.candidateDigest}`,
            episodeRole: "operatorFollowUp",
            events: prepared.events,
            paths: prepared.paths,
            runId: prepared.runId,
            taskInput: "Continue only the accepted bounded worker task.",
          });
          if (episode === undefined)
            return yield* Effect.die("Derived ordinary episode is missing.");
          const pair = yield* loadModelInvocationPair(prepared.paths, episode);
          const baseContent =
            prepared.workerInitialPair.context.payload.content;
          const content = pair.context.payload.content;
          const selectedLesson = prepared.selection.lessons[0];
          if (selectedLesson === undefined)
            return yield* Effect.die("Selected lesson is missing.");

          assert.strictEqual(content.episodeRole, "operatorFollowUp");
          assert.deepEqual(
            content.contentRefs,
            baseContent.contentRefs.filter(
              ({ kind }) => kind !== "factoryLesson/v1"
            )
          );
          assert.notInclude(
            pair.rendered.text,
            renderedFactoryLessonRef(selectedLesson)
          );
          assert.isTrue(
            content.planningFacts.some((fact) =>
              fact.includes(prepared.candidate.compactLesson)
            )
          );
          assert.include(pair.rendered.text, prepared.candidate.compactLesson);
          assert.deepEqual(
            {
              acceptedOutcomes: content.acceptedOutcomes,
              authority: content.authority,
              instructions: content.instructions,
              nonGoals: content.nonGoals,
              planningFacts: content.planningFacts,
              safeExclusions: content.safeExclusions,
              skills: content.skills,
              stops: content.stops,
              verificationCommands: content.verificationCommands,
            },
            {
              acceptedOutcomes: baseContent.acceptedOutcomes,
              authority: baseContent.authority,
              instructions: baseContent.instructions,
              nonGoals: baseContent.nonGoals,
              planningFacts: baseContent.planningFacts,
              safeExclusions: baseContent.safeExclusions,
              skills: baseContent.skills,
              stops: baseContent.stops,
              verificationCommands: baseContent.verificationCommands,
            }
          );
        })
    );

    it.effect(
      "records one exact app-server offer when the real transport completes after a human-wait resume",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-app-server-resume-",
          });
          const source = yield* writeRepairSource(root, true);
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const review = makeAcceptedReview(candidate, source);
          yield* recordFactoryLessonReview(sourceRunId, review.input, {
            rootDirectory: root,
          });

          let offeredInput = "";
          let createSessionCount = 0;
          let resumeSessionCount = 0;
          const turnId = parseHarnessTurnId(
            "turn-factory-lesson-app-server-resume"
          );
          const provider: HarnessProvider = {
            ...testHarnessProvider,
            createSession: (request) => {
              createSessionCount += 1;
              offeredInput = request.input.text;
              const events = [
                {
                  capabilities: testHarnessCapabilities,
                  kind: "sessionStarted" as const,
                  provider: testHarnessProvider.descriptor,
                  sessionId: request.sessionId,
                  state: "running" as const,
                },
                {
                  kind: "turnStarted" as const,
                  sessionId: request.sessionId,
                  turnId,
                },
              ];
              return Effect.succeed({
                events: Stream.fromIterable(events),
                interrupt: Option.some(Effect.void),
                resolveInteraction: () => Effect.void,
                send: () => Effect.succeed(undefined),
                snapshot: Effect.succeed(
                  projectHarnessEvents(events, request.sessionId)
                ),
                steer: Option.none(),
              });
            },
            resumeSession: (request) =>
              Effect.sync(() => {
                resumeSessionCount += 1;
                writeFileSync(
                  `${root}/${request.workspacePath}/output.txt`,
                  `${request.sessionId.slice("session-".length)}\n`,
                  "utf8"
                );
                const events = [
                  {
                    kind: "turnCompleted" as const,
                    sessionId: request.sessionId,
                    status: "completed" as const,
                    turnId,
                  },
                ];
                return {
                  events: Stream.fromIterable(events),
                  interrupt: Option.some(Effect.void),
                  resolveInteraction: () => Effect.void,
                  send: () => Effect.succeed(undefined),
                  snapshot: Effect.succeed(
                    projectHarnessEvents(
                      [
                        {
                          capabilities: testHarnessCapabilities,
                          kind: "sessionStarted" as const,
                          provider: testHarnessProvider.descriptor,
                          sessionId: request.sessionId,
                          state: "running" as const,
                        },
                        {
                          kind: "turnStarted" as const,
                          sessionId: request.sessionId,
                          turnId,
                        },
                        ...events,
                      ],
                      request.sessionId
                    )
                  ),
                  steer: Option.none(),
                };
              }),
          };
          const releasingHarness = interactiveSessionHarness({
            provider,
            rootDirectory: root,
          });
          const specPath = `${root}/app-server-resume-worker.md`;
          yield* fs.writeFileString(
            specPath,
            "# App-server resume worker\n\nUse the accepted reviewed context.\n"
          );
          const initial = yield* runSpecFile(specPath, {
            rootDirectory: root,
            workerHarness: {
              ...releasingHarness,
              run: (request) =>
                releasingHarness.run(request).pipe(
                  Effect.catchTag("GaiaRuntimeError", () =>
                    Effect.succeed({
                      kind: "controlRelease" as const,
                      runId: request.runId,
                      state: "waitingForHuman" as const,
                    })
                  )
                ),
            },
          });
          const paths = yield* makeRunPaths(initial.runId, {
            rootDirectory: root,
          });
          assert.strictEqual(initial.state, "waitingForHuman");
          assert.strictEqual(
            resolveFactoryLessonContextAttribution(yield* readEvents(paths))
              .attributions[0]?.observations.length,
            0
          );

          const resumed = yield* continueAcceptedRun(
            initial.runId,
            paths,
            parseMarkdownSpec(
              "Use the accepted reviewed context.",
              "App-server resume worker"
            ),
            {
              rootDirectory: root,
              workerContinuationState: "resume",
              workerHarness: interactiveSessionHarness({
                provider,
                rootDirectory: root,
              }),
            }
          );
          const attribution = resolveFactoryLessonContextAttribution(
            yield* readEvents(paths)
          );

          assert.strictEqual(resumed.status, "completed");
          assert.strictEqual(createSessionCount, 1);
          assert.strictEqual(resumeSessionCount, 1);
          assert.include(offeredInput, candidate.compactLesson);
          assert.deepEqual(
            attribution.attributions[0]?.observations.map(
              ({ kind, source, trust }) => ({ kind, source, trust })
            ),
            [
              {
                kind: "offered",
                source: "codexAppServerTransport",
                trust: "high",
              },
              {
                kind: "unobservable",
                source: "gaiaBoundary",
                trust: "none",
              },
            ]
          );
        })
    );

    it.effect(
      "keeps publicly forged terminal history unobservable on resume",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-terminal-forgery-",
          });
          const source = yield* writeRepairSource(root, true);
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const review = makeAcceptedReview(candidate, source);
          yield* recordFactoryLessonReview(sourceRunId, review.input, {
            rootDirectory: root,
          });

          let resumeSessionCount = 0;
          const turnId = parseHarnessTurnId(
            "turn-factory-lesson-terminal-forgery"
          );
          const provider: HarnessProvider = {
            ...testHarnessProvider,
            createSession: (request) => {
              const events = [
                {
                  capabilities: testHarnessCapabilities,
                  kind: "sessionStarted" as const,
                  provider: testHarnessProvider.descriptor,
                  sessionId: request.sessionId,
                  state: "running" as const,
                },
                {
                  kind: "turnStarted" as const,
                  sessionId: request.sessionId,
                  turnId,
                },
              ];
              return Effect.succeed({
                events: Stream.fromIterable(events),
                interrupt: Option.some(Effect.void),
                resolveInteraction: () => Effect.void,
                send: () => Effect.succeed(undefined),
                snapshot: Effect.succeed(
                  projectHarnessEvents(events, request.sessionId)
                ),
                steer: Option.none(),
              });
            },
            resumeSession: () => {
              resumeSessionCount += 1;
              return Effect.die(
                "Forged terminal history unexpectedly resumed the provider."
              );
            },
          };
          const releasingHarness = interactiveSessionHarness({
            provider,
            rootDirectory: root,
          });
          const specPath = `${root}/terminal-forgery-worker.md`;
          yield* fs.writeFileString(
            specPath,
            "# Terminal forgery worker\n\nReject terminal-history attribution forgery.\n"
          );
          const initial = yield* runSpecFile(specPath, {
            rootDirectory: root,
            workerHarness: {
              ...releasingHarness,
              run: (request) =>
                releasingHarness.run(request).pipe(
                  Effect.catchTag("GaiaRuntimeError", () =>
                    Effect.succeed({
                      kind: "controlRelease" as const,
                      runId: request.runId,
                      state: "waitingForHuman" as const,
                    })
                  )
                ),
            },
          });
          const paths = yield* makeRunPaths(initial.runId, {
            rootDirectory: root,
          });
          yield* appendPublicHarnessSessionEvent(initial.runId, paths, {
            kind: "turnCompleted",
            sessionId: parseHarnessSessionId(`session-${initial.runId}`),
            status: "completed",
            turnId,
          });
          yield* fs.writeFileString(
            paths.workspaceOutput,
            `Forged terminal history for ${initial.runId}.\n`
          );

          const resumed = yield* continueAcceptedRun(
            initial.runId,
            paths,
            parseMarkdownSpec(
              "Reject terminal-history attribution forgery.",
              "Terminal forgery worker"
            ),
            {
              rootDirectory: root,
              workerContinuationState: "resume",
              workerHarness: interactiveSessionHarness({
                provider,
                rootDirectory: root,
              }),
            }
          );
          const attribution = resolveFactoryLessonContextAttribution(
            yield* readEvents(paths)
          );

          assert.strictEqual(resumed.status, "completed");
          assert.strictEqual(resumeSessionCount, 0);
          assert.deepEqual(
            attribution.attributions[0]?.observations.map(
              ({ kind, source, trust }) => ({ kind, source, trust })
            ),
            [
              {
                kind: "unobservable",
                source: "gaiaBoundary",
                trust: "none",
              },
            ]
          );
        })
    );

    it.effect(
      "records exact offered attribution only after the real Codex batch transport completes",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-codex-batch-",
          });
          const source = yield* writeRepairSource(root, true);
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const review = makeAcceptedReview(candidate, source);
          yield* recordFactoryLessonReview(sourceRunId, review.input, {
            rootDirectory: root,
          });

          const specPath = `${root}/codex-batch-worker.md`;
          yield* fs.writeFileString(
            specPath,
            "# Codex batch worker\n\nUse the accepted reviewed context.\n"
          );
          let offeredInput = "";
          let transportCompleted = false;
          const summary = yield* runSpecFile(specPath, {
            codexHarness: {
              commandRunner: (input) =>
                Effect.gen(function* () {
                  offeredInput = input.request.stdin;
                  const lastMessageIndex = input.request.args.indexOf(
                    "--output-last-message"
                  );
                  const lastMessagePath =
                    input.request.args[lastMessageIndex + 1];
                  if (lastMessagePath === undefined)
                    return yield* Effect.die(
                      "Codex batch fixture did not receive a last-message path."
                    );
                  const targetRunId = input.request.cwd.split("/").at(-2);
                  if (targetRunId === undefined)
                    return yield* Effect.die(
                      "Codex batch fixture could not resolve its run id."
                    );
                  yield* fs.writeFileString(
                    `${input.request.cwd}/output.txt`,
                    `${targetRunId}\n`
                  );
                  yield* fs.writeFileString(
                    lastMessagePath,
                    "Codex batch completed.\n"
                  );
                  transportCompleted = true;
                  return { exitCode: 0, stderr: "", stdout: "" };
                }),
              config: makeCodexHarnessConfig({
                command: "codex-factory-lesson-test",
              }),
            },
            harnessName: codexHarnessName,
            rootDirectory: root,
          });
          const paths = yield* makeRunPaths(summary.runId, {
            rootDirectory: root,
          });
          const events = yield* readEvents(paths);
          const workerStarted = events.find(
            (event) => event.type === "WORKER_STARTED"
          );
          assert.isDefined(workerStarted);
          const selection = parseFactoryLessonContextSelectionV1(
            workerStarted?.payload["factoryLessonContextSelection"]
          );
          const episode = Schema.decodeUnknownSync(
            ModelInvocationEpisodeStartV1
          )(workerStarted?.payload["modelInvocationEpisode"]);
          const pair = yield* loadModelInvocationPair(paths, episode);
          const attribution = resolveFactoryLessonContextAttribution(events);
          const selectedLesson = selection.lessons[0];

          assert.isTrue(transportCompleted);
          if (selectedLesson === undefined)
            return yield* Effect.die("Selected lesson is missing.");
          const exactRenderedRef = renderedFactoryLessonRef(selectedLesson);
          assert.include(offeredInput, exactRenderedRef);
          assert.include(offeredInput, candidate.compactLesson);
          assert.isBelow(
            offeredInput.indexOf(exactRenderedRef),
            offeredInput.indexOf(candidate.compactLesson)
          );
          assert.strictEqual(pair.rendered.text, offeredInput);
          assert.strictEqual(selection.lessons.length, 1);
          assert.deepEqual(
            attribution.attributions[0]?.observations.map(
              ({ kind, source, trust }) => ({ kind, source, trust })
            ),
            [
              {
                kind: "offered",
                source: "codexBatchTransport",
                trust: "high",
              },
              {
                kind: "unobservable",
                source: "gaiaBoundary",
                trust: "none",
              },
            ]
          );
        })
    );

    it.effect(
      "keeps fake and process completions unobservable without manufacturing an offer",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-unobservable-transports-",
          });
          const source = yield* writeRepairSource(root, true);
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const review = makeAcceptedReview(candidate, source);
          yield* recordFactoryLessonReview(sourceRunId, review.input, {
            rootDirectory: root,
          });

          const specPath = `${root}/unobservable-worker.md`;
          yield* fs.writeFileString(
            specPath,
            "# Unobservable worker\n\nDo not infer an offer from selection.\n"
          );
          for (const harnessName of [defaultHarnessName, processHarnessName]) {
            const summary = yield* runSpecFile(specPath, {
              // Enable the existing workerInitial model protocol fixture while
              // the injected production seam reports the actual harness kind.
              harnessName: codexHarnessName,
              rootDirectory: root,
              workerHarness: {
                name: harnessName,
                run: (request) =>
                  Effect.gen(function* () {
                    const result = HarnessRunResult.make({
                      changedWorkspacePaths: ["output.txt"],
                      exitCode: 0,
                      harnessName,
                      outputArtifacts: ["workspace/output.txt"],
                      resultPath: "worker-result.json",
                      runId: request.runId,
                      status: "completed",
                      summary: `${harnessName} completed without transport evidence.`,
                    });
                    yield* fs.writeFileString(
                      request.workspaceOutputPath,
                      `${request.runId}\n`
                    );
                    yield* fs.writeFileString(
                      request.workerResultPath,
                      `${JSON.stringify(result)}\n`
                    );
                    return result;
                  }).pipe(Effect.orDie),
              },
            });
            const paths = yield* makeRunPaths(summary.runId, {
              rootDirectory: root,
            });
            const events = yield* readEvents(paths);
            const attribution = resolveFactoryLessonContextAttribution(events);

            assert.strictEqual(attribution.selection?.lessons.length, 1);
            assert.deepEqual(
              attribution.attributions[0]?.observations.map(
                ({ kind, source, trust }) => ({ kind, source, trust })
              ),
              [
                {
                  kind: "unobservable",
                  source: "gaiaBoundary",
                  trust: "none",
                },
              ]
            );
          }
        })
    );

    it.effect(
      "starts a near-ceiling worker with fewer lessons after final rendered-input overhead",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-lesson-near-ceiling-",
          });
          const source = yield* writeRepairSource(root, true);
          const candidate = makeFactoryLessonCandidateV1(lessonInput);
          const review = makeAcceptedReview(candidate, source);
          yield* recordFactoryLessonReview(sourceRunId, review.input, {
            rootDirectory: root,
          });

          const specPath = `${root}/near-ceiling-worker.md`;
          yield* fs.writeFileString(
            specPath,
            [
              "# Near-ceiling worker",
              "",
              "Keep the worker input bounded.",
              "",
              "## Acceptance criteria",
              "",
              "- Complete the bounded worker turn.",
              "",
              "## Non-goals",
              "",
              "- Do not widen scope.",
              "",
              "## Stop conditions",
              "",
              "- Stop on missing authority.",
              "",
              "## Bounded fixture",
              "",
              "x".repeat(14_650),
              "",
            ].join("\n")
          );
          let offeredInput = "";
          const summary = yield* runSpecFile(specPath, {
            rootDirectory: root,
            workerHarness: {
              name: codexAppServerHarnessName,
              run: (request) =>
                Effect.gen(function* () {
                  offeredInput = request.modelRenderedInput?.text ?? "";
                  const result = HarnessRunResult.make({
                    changedWorkspacePaths: ["output.txt"],
                    exitCode: 0,
                    harnessName: codexAppServerHarnessName,
                    outputArtifacts: ["workspace/output.txt"],
                    resultPath: "worker-result.json",
                    runId: request.runId,
                    status: "completed",
                    summary: "Near-ceiling worker completed.",
                  });
                  const runtimeFs = yield* FileSystem.FileSystem;
                  yield* runtimeFs.writeFileString(
                    request.workspaceOutputPath,
                    `Bounded worker completed for ${request.runId}.\n`
                  );
                  yield* runtimeFs.writeFileString(
                    request.workerResultPath,
                    `${JSON.stringify(result)}\n`
                  );
                  return result;
                }).pipe(Effect.orDie),
            },
          });
          const paths = yield* makeRunPaths(summary.runId, {
            rootDirectory: root,
          });
          const events = yield* readEvents(paths);
          const workerStarted = events.find(
            (event) => event.type === "WORKER_STARTED"
          );
          assert.isDefined(workerStarted);
          const selection = parseFactoryLessonContextSelectionV1(
            workerStarted?.payload["factoryLessonContextSelection"]
          );

          assert.strictEqual(selection.eligibleLessonCount, 1);
          assert.lengthOf(selection.lessons, 0);
          assert.strictEqual(selection.omittedLessonCount, 1);
          assert.deepEqual(
            selection.omitted.map(({ reason }) => reason),
            ["renderBudget"]
          );
          assert.isAtMost(selection.finalRenderedBytes, 16_384);
          assert.strictEqual(
            new TextEncoder().encode(offeredInput).byteLength,
            selection.finalRenderedBytes
          );
          assert.notInclude(offeredInput, candidate.compactLesson);
          assert.strictEqual(events.at(-1)?.type, "REPORT_COMPLETED");
        })
    );
  });
});

function prepareSelectedFactoryLessonRun(
  rootDirectory: string,
  fixtureName: string
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* writeRepairSource(rootDirectory, true);
    const candidate = makeFactoryLessonCandidateV1(lessonInput);
    const review = makeAcceptedReview(candidate, source);
    yield* recordFactoryLessonReview(sourceRunId, review.input, {
      rootDirectory,
    });

    const specPath = `${rootDirectory}/${fixtureName}.md`;
    yield* fs.writeFileString(
      specPath,
      `# ${fixtureName}\n\nUse accepted reviewed context.\n`
    );
    const summary = yield* runSpecFile(specPath, {
      harnessName: codexHarnessName,
      rootDirectory,
      workerHarness: {
        name: codexAppServerHarnessName,
        run: (request) =>
          Effect.gen(function* () {
            const result = HarnessRunResult.make({
              changedWorkspacePaths: ["output.txt"],
              exitCode: 0,
              harnessName: codexAppServerHarnessName,
              outputArtifacts: ["workspace/output.txt"],
              resultPath: "worker-result.json",
              runId: request.runId,
              status: "completed",
              summary: "Selected factory lesson worker completed.",
            });
            yield* fs.writeFileString(
              request.workspaceOutputPath,
              `${request.runId}\n`
            );
            yield* fs.writeFileString(
              request.workerResultPath,
              `${JSON.stringify(result)}\n`
            );
            return result;
          }).pipe(Effect.orDie),
      },
    });
    const paths = yield* makeRunPaths(summary.runId, {
      rootDirectory,
    });
    const events = yield* readEvents(paths);
    const workerStarted = events.find(
      (event) => event.type === "WORKER_STARTED"
    );
    if (workerStarted === undefined)
      return yield* Effect.die("Selected lesson worker start is missing.");
    const selection = parseFactoryLessonContextSelectionV1(
      workerStarted.payload["factoryLessonContextSelection"]
    );
    assert.lengthOf(selection.lessons, 1);
    const workerInitialEpisode = Schema.decodeUnknownSync(
      ModelInvocationEpisodeStartV1
    )(workerStarted.payload["modelInvocationEpisode"]);
    const workerInitialPair = yield* loadModelInvocationPair(
      paths,
      workerInitialEpisode
    );

    return {
      candidate,
      events,
      paths,
      runId: summary.runId,
      selection,
      workerInitialPair,
    };
  });
}

function makeAcceptedReview(
  candidate: ReturnType<typeof makeFactoryLessonCandidateV1>,
  source: Awaited<ReturnType<typeof sourceFixture>>
) {
  const input = {
    attestation: makeNoRawTelemetryAttestationV1({
      candidateDigest: candidate.candidateDigest,
      reviewerRef,
    }),
    candidate,
    decision: "accepted",
    source: {
      eventSequence: parseRunEventSequence(13),
      failureFingerprint: source.digest.fingerprint,
      runId: sourceRunId,
      type: "FAILURE_REPAIR_RECORDED",
      version: 1,
    },
  } as const;
  const receipt = makeFactoryLessonReviewReceiptV1(input);
  if (receipt.decision !== "accepted")
    throw new Error("Accepted review fixture was not accepted.");
  return { input, receipt };
}

function makeAcceptedProofReview(
  candidate: ReturnType<typeof makeFactoryLessonCandidateV1>,
  source: Awaited<ReturnType<typeof sourceFixture>>
) {
  const input = {
    attestation: makeNoRawTelemetryAttestationV1({
      candidateDigest: candidate.candidateDigest,
      reviewerRef,
    }),
    candidate,
    decision: "accepted",
    source: {
      eventSequence: parseRunEventSequence(12),
      resultDigest: source.freshProof.resultDigest,
      runId: sourceRunId,
      type: "RUN_PROOF_RESULT_RECORDED",
      version: 1,
    },
  } as const;
  const receipt = makeFactoryLessonReviewReceiptV1(input);
  if (receipt.decision !== "accepted")
    throw new Error("Accepted proof review fixture was not accepted.");
  return { input, receipt };
}

function renderedFactoryLessonRef(input: {
  readonly lessonId: string;
  readonly projectionDigest: string;
  readonly version: 1;
}) {
  return [
    "kind=factoryLesson/v1",
    `lessonId=${input.lessonId}`,
    `version=${input.version}`,
    `projectionDigest=${input.projectionDigest}`,
  ].join("; ");
}

function writeRepairSource(
  rootDirectory: ReturnType<typeof parseRunStorageRootInput> | string,
  terminal: boolean | "failed"
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const source = sourceFixture();
    const paths = yield* makeRunPaths(sourceRunId, { rootDirectory });
    yield* fs.makeDirectory(paths.root, { recursive: true });
    const events =
      terminal === "failed"
        ? [
            ...source.events.slice(0, 13),
            makeRunEvent({
              payload: {
                code: "ReviewedSourceFailed",
                message: "The reviewed repair source ended terminally.",
                recoverable: false,
                stage: "verifying",
              },
              runId: sourceRunId,
              sequence: 14,
              timestamp: timestamp(14),
              type: "RUN_FAILED",
            }),
          ]
        : source.events.slice(0, terminal ? 15 : 13);
    yield* fs.writeFileString(
      paths.events,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
    );
    yield* readEvents(paths);
    return { ...source, paths };
  });
}

function sourceFixture() {
  const spec = parseMarkdownSpec(
    readFileSync(
      new URL(
        "../../../examples/specs/claim-verification-v2.md",
        import.meta.url
      ),
      "utf8"
    ),
    "factory lesson source"
  );
  const contract = makeRunContractV2({
    baseDigest: "1".repeat(64),
    baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
    runId: sourceRunId,
    spec,
    targetDigest: "2".repeat(64),
    targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
  });
  const claim = contract.proofClaims.find((entry) => entry.kind === "command");
  if (claim === undefined) throw new Error("Command claim fixture is missing.");
  const failureEvidence = [
    {
      evidenceId: makeProofEvidenceIdV2("command", ["6".repeat(64)]),
      kind: "command" as const,
      receiptDigest: "6".repeat(64),
      requestDigest: makeVerificationCommandRequestDigest(claim.command),
      status: "nonZero" as const,
      terminalSequence: parseRunEventSequence(4),
    },
  ];
  const digest = makeFailureDigestV1({
    attempt: 1,
    evidenceRefs: failureEvidence,
    failedRef: { claimId: claim.claimId, kind: "claim" },
    maxAttempts: 2,
    outcomeCertainty: "confirmed",
    retryability: "repairable",
    stage: "verifying",
    tag: "verificationClaimFailed",
  });
  const repair = {
    digest,
    episodeKey: `failureRepair:${digest.fingerprint}:1`,
    failedProofResultSequence: parseRunEventSequence(5),
    runId: sourceRunId,
  };
  const intent = FailureRepairIntent.make({
    ...repair,
    state: "intentRecorded",
  });
  const attempted = FailureRepairDispatchAttempted.make({
    ...repair,
    state: "dispatchAttempted",
  });
  const completed = FailureRepairTurnCompleted.make({
    ...repair,
    state: "turnCompleted",
    terminalEventSequence: parseRunEventSequence(10),
  });
  const verified = FailureRepairVerified.make({
    ...repair,
    proofResultSequence: parseRunEventSequence(12),
    state: "verified",
  });
  const initialProof = makeProof(contract, claim, failureEvidence, false, 4, 5);
  const freshProof = makeProof(contract, claim, failureEvidence, true, 11, 12);
  const resolvedExecution = ResolvedHarnessExecution.make({
    capabilities: testHarnessCapabilities,
    executionMode: "local",
    harnessProfileId: parseHarnessProfileId("codexAppServer"),
    provider: testHarnessProvider.descriptor,
    version: "test-1",
  });
  const events: Array<RunEvent> = [
    makeRunEvent({
      payload: {
        execution: {
          resolved: Schema.encodeSync(ResolvedHarnessExecution)(
            resolvedExecution
          ),
          selection: { harnessProfileId: "codexAppServer" },
        },
        modelInvocationProtocol: "v1",
        specPath: "input.md",
        workflow: "issueDelivery",
        workItem: {
          description: "Review a bounded factory lesson source.",
          kind: "issue",
          title: "GAIA-150 factory lesson source",
        },
      },
      runId: sourceRunId,
      sequence: 1,
      timestamp: timestamp(1),
      type: "RUN_CREATED",
    }),
    makeRunEvent({
      payload: { contract: encodeAnyRunContractJson(contract) },
      runId: sourceRunId,
      sequence: 2,
      timestamp: timestamp(2),
      type: "RUN_CONTRACT_RECORDED",
    }),
    makeRunEvent({
      payload: { workspacePath: "workspace" },
      runId: sourceRunId,
      sequence: 3,
      timestamp: timestamp(3),
      type: "WORKSPACE_PREPARED",
    }),
    makeRunEvent({
      payload: { workerResultPath: "worker-result.json" },
      runId: sourceRunId,
      sequence: 4,
      timestamp: timestamp(4),
      type: "WORKER_COMPLETED",
    }),
    proofEvent(initialProof, 5),
    repairEvent(intent, 6),
    repairEvent(attempted, 7),
    makeRunEvent({
      payload: {
        event: {
          capabilities: Schema.encodeSync(HarnessCapabilities)(
            testHarnessCapabilities
          ),
          kind: "sessionStarted",
          provider: Schema.encodeSync(HarnessProviderDescriptor)(
            testHarnessProvider.descriptor
          ),
          sessionId: `session-${sourceRunId}`,
          state: "running",
        },
      },
      runId: sourceRunId,
      sequence: 8,
      timestamp: timestamp(8),
      type: "HARNESS_SESSION_EVENT_RECORDED",
    }),
    makeRunEvent({
      payload: {
        event: {
          kind: "turnStarted",
          sessionId: `session-${sourceRunId}`,
          turnId: "failure-repair-turn-1",
        },
        modelInvocationObservation: Schema.encodeSync(
          ModelInvocationObservationV1
        )(
          ModelInvocationObservationV1.make({
            episodeKey: repair.episodeKey,
            kind: "offered",
            source: "codexAppServerTransport",
            trust: "high",
            version: 1,
          })
        ),
      },
      runId: sourceRunId,
      sequence: 9,
      timestamp: timestamp(9),
      type: "HARNESS_SESSION_EVENT_RECORDED",
    }),
    makeRunEvent({
      payload: {
        event: {
          kind: "turnCompleted",
          sessionId: `session-${sourceRunId}`,
          status: "completed",
          turnId: "failure-repair-turn-1",
        },
      },
      runId: sourceRunId,
      sequence: 10,
      timestamp: timestamp(10),
      type: "HARNESS_SESSION_EVENT_RECORDED",
    }),
    repairEvent(completed, 11),
    proofEvent(freshProof, 12),
    repairEvent(verified, 13),
    makeRunEvent({
      runId: sourceRunId,
      sequence: 14,
      timestamp: timestamp(14),
      type: "REPORT_STARTED",
    }),
    makeRunEvent({
      payload: { reportPath: "report.md" },
      runId: sourceRunId,
      sequence: 15,
      timestamp: timestamp(15),
      type: "REPORT_COMPLETED",
    }),
  ];
  return { digest, events, freshProof };
}

function makeProof(
  contract: RunContractV2,
  commandClaim: Extract<
    RunContractV2["proofClaims"][number],
    { readonly kind: "command" }
  >,
  failureEvidence: ReadonlyArray<typeof CommandClaimEvidenceV2.Encoded>,
  passed: boolean,
  contentAuthoritySequence: number,
  sequence: number
) {
  return makeRunProofResultV2({
    contentAuthoritySequence,
    contract,
    observedTargetDigest: contract.targetDigest,
    recordedBy: {
      runId: sourceRunId,
      sequence,
      type: "RUN_PROOF_RESULT_RECORDED",
    },
    results: Schema.decodeUnknownSync(Schema.Array(ProofClaimResultV2Schema))(
      contract.proofClaims.map((claim) =>
        claim.claimId === commandClaim.claimId
          ? passed
            ? {
                claimId: claim.claimId,
                evidence: [
                  {
                    evidenceId: makeProofEvidenceIdV2("command", [
                      "4".repeat(64),
                    ]),
                    kind: "command",
                    receiptDigest: "4".repeat(64),
                    requestDigest: makeVerificationCommandRequestDigest(
                      commandClaim.command
                    ),
                    status: "succeeded",
                    terminalSequence: parseRunEventSequence(
                      contentAuthoritySequence
                    ),
                  },
                ],
                status: "passed",
              }
            : {
                claimId: claim.claimId,
                evidence: failureEvidence,
                reason: "The exact command returned a non-zero status.",
                status: "failed",
              }
          : claim.kind === "human-judgment"
            ? {
                claimId: claim.claimId,
                reason: "An explicit paired-review decision is required.",
                requiredAuthority: "human",
                status: "requires-decision",
              }
            : {
                claimId: claim.claimId,
                reason: "Post-publication evidence is not available yet.",
                status: "not-run",
              }
      )
    ),
  });
}

function proofEvent(
  result: ReturnType<typeof makeRunProofResultV2>,
  sequence: number
) {
  return makeRunEvent({
    payload: {
      result: encodeAnyRunProofResultJson(result),
      verificationResultPath: `verification/run-proof-${sequence}.json`,
    },
    runId: sourceRunId,
    sequence,
    timestamp: timestamp(sequence),
    type: "RUN_PROOF_RESULT_RECORDED",
  });
}

function repairEvent(
  failureRepair: Parameters<typeof encodeFailureRepairReceiptJson>[0],
  sequence: number
) {
  return makeRunEvent({
    payload: {
      failureRepair: encodeFailureRepairReceiptJson(failureRepair),
      ...(failureRepair.state === "intentRecorded"
        ? {
            modelInvocationEpisode: modelEpisode(
              sourceRunId,
              failureRepair.episodeKey
            ),
          }
        : {}),
    },
    runId: sourceRunId,
    sequence,
    timestamp: timestamp(sequence),
    type: "FAILURE_REPAIR_RECORDED",
  });
}

function modelEpisode(runId: typeof sourceRunId, episodeKey: string) {
  const episodeId = createHash("sha256").update(episodeKey).digest("hex");
  const ref = (
    kind: "modelContextManifest" | "modelInvocationManifest",
    identityDigest: string,
    filename: "context-manifest.json" | "invocation-manifest.json"
  ) => ({
    artifactId: `mmf1_${createHash("sha256")
      .update(`${kind}\0${identityDigest}`)
      .digest("hex")}`,
    bodyDigest: "f".repeat(64),
    byteLength: 123,
    episodeKey,
    identityDigest,
    kind,
    path: `model-invocations/episode1_${episodeId}/${filename}`,
    runId,
    version: 1 as const,
  });
  return {
    contextRef: ref(
      "modelContextManifest",
      createHash("sha256").update(`${episodeKey}:context`).digest("hex"),
      "context-manifest.json"
    ),
    episodeKey,
    invocationRef: ref(
      "modelInvocationManifest",
      createHash("sha256").update(`${episodeKey}:invocation`).digest("hex"),
      "invocation-manifest.json"
    ),
    version: 1 as const,
  };
}

function timestamp(sequence: number) {
  return `2026-07-25T12:40:${sequence.toString().padStart(2, "0")}.000Z`;
}
