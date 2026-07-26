import { createHash } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { makeRunEvent } from "./events.js";
import {
  FACTORY_LESSON_REVIEWED_FIELDS_V1,
  FactoryLessonActiveV1,
  FactoryLessonContextSelectionV1,
  FactoryLessonReviewReceiptV1,
  makeFactoryLessonCandidateV1,
  makeFactoryLessonContextSelectionV1,
  makeFactoryLessonReviewReceiptV1,
  makeNoRawTelemetryAttestationV1,
  parseFactoryLessonCandidateV1,
  projectFactoryLessons,
} from "./factory-lesson.js";
import { FailureRepairIntent, makeFailureDigestV1 } from "./failure-repair.js";
import {
  FactoryLessonContextObservationV1,
  MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
  makeFactoryLessonContextObservationV1,
  makeModelContextContentV1,
  renderModelInputV1,
  resolveFactoryLessonContextAttribution,
  selectFactoryLessonsForWorkerInitial,
} from "./model-invocation.js";
import { parseRunEventSequence } from "./run-contract.js";
import { parseRunId } from "./run-id.js";

const sourceRunId = parseRunId("run-source0001");
const laterRunId = parseRunId("run-later00001");
const reviewerRef = "linear-comment:review-123";

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

function makeFailureRepairSource(sequence: number, fingerprintSeed: string) {
  const digest = makeFailureDigestV1({
    attempt: 1,
    evidenceRefs: [],
    failedRef: {
      claimId: `proof-claim:sha256:${createHash("sha256")
        .update(fingerprintSeed)
        .digest("hex")}`,
      kind: "claim",
    },
    maxAttempts: 2,
    outcomeCertainty: "confirmed",
    retryability: "repairable",
    stage: "verifying",
    tag: "verificationClaimFailed",
  });
  const receipt = FailureRepairIntent.make({
    digest,
    episodeKey: `failureRepair:${digest.fingerprint}:1`,
    failedProofResultSequence: parseRunEventSequence(1),
    runId: sourceRunId,
    state: "intentRecorded",
  });
  return {
    event: makeRunEvent({
      payload: {
        failureRepair: Schema.encodeSync(FailureRepairIntent)(receipt),
      },
      runId: sourceRunId,
      sequence,
      timestamp: `2026-07-25T20:00:0${sequence}.000Z`,
      type: "FAILURE_REPAIR_RECORDED",
    }),
    source: {
      eventSequence: parseRunEventSequence(sequence),
      failureFingerprint: digest.fingerprint,
      runId: sourceRunId,
      type: "FAILURE_REPAIR_RECORDED" as const,
      version: 1 as const,
    },
  };
}

function acceptedReview(sequence = 2, input = lessonInput) {
  const failure = makeFailureRepairSource(sequence - 1, `${sequence}`);
  const candidate = makeFactoryLessonCandidateV1(input);
  const attestation = makeNoRawTelemetryAttestationV1({
    candidateDigest: candidate.candidateDigest,
    reviewerRef,
  });
  const receipt = makeFactoryLessonReviewReceiptV1({
    attestation,
    candidate,
    decision: "accepted",
    source: failure.source,
  });
  const event = makeRunEvent({
    payload: {
      factoryLessonReview: Schema.encodeSync(FactoryLessonReviewReceiptV1)(
        receipt
      ),
    },
    runId: sourceRunId,
    sequence,
    timestamp: `2026-07-25T20:00:0${sequence}.000Z`,
    type: "FACTORY_LESSON_REVIEW_RECORDED",
  });
  return { candidate, event, failure: failure.event, receipt };
}

function baseContent(taskInput = "Implement the accepted slice.") {
  return makeModelContextContentV1({
    acceptedOutcomes: ["Return an inspectable implementation."],
    authority: ["Edit this issue only."],
    budget: { maxOutputBytes: 16_384, maxTurns: 1 },
    contentRefs: [],
    episodeRole: "workerInitial",
    instructions: ["Use the accepted verification commands."],
    nonGoals: ["Do not deploy."],
    outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
    planningFacts: ["events.jsonl is authoritative."],
    safeExclusions: ["credentials"],
    skills: ["effect-ts"],
    stops: ["Stop on scope drift."],
    taskInput,
    verificationCommands: ["pnpm test"],
  });
}

describe("reviewed factory lessons", () => {
  it("creates an exact compact projection only after an explicit reviewed no-raw-telemetry attestation", () => {
    const { candidate, failure, event, receipt } = acceptedReview();
    const replayed = projectFactoryLessons([failure, event]);

    assert.match(candidate.candidateDigest, /^[a-f0-9]{64}$/u);
    assert.strictEqual(receipt.decision, "accepted");
    if (receipt.decision !== "accepted") return;
    assert.deepEqual(
      receipt.attestation.reviewedFields,
      FACTORY_LESSON_REVIEWED_FIELDS_V1
    );
    assert.strictEqual(
      receipt.attestation.candidateDigest,
      candidate.candidateDigest
    );
    assert.strictEqual(
      receipt.projection.candidateDigest,
      candidate.candidateDigest
    );
    assert.strictEqual(replayed.active.length, 1);
    assert.strictEqual(
      replayed.active[0]?.projection.lessonId,
      receipt.projection.lessonId
    );
    assert.deepEqual(
      makeFactoryLessonCandidateV1(lessonInput),
      parseFactoryLessonCandidateV1(candidate)
    );
  });

  it("binds the explicit no-raw-telemetry attestation to exact reviewed bytes without pretending to detect arbitrary telemetry", () => {
    const fields = [
      "compactLesson",
      "expectedEffect",
      "retirementCondition",
    ] as const;
    const rawTelemetry = [
      "2026-07-25T20:31:22.123Z INFO worker stderr: request failed",
      "user: paste the run output assistant: here is the complete transcript",
    ] as const;

    for (const field of fields)
      for (const fixture of rawTelemetry) {
        const rawLookingCandidate = makeFactoryLessonCandidateV1({
          ...lessonInput,
          [field]: fixture,
        });
        assert.strictEqual(String(rawLookingCandidate[field]), fixture);

        const safeCandidate = makeFactoryLessonCandidateV1(lessonInput);
        const safeAttestation = makeNoRawTelemetryAttestationV1({
          candidateDigest: safeCandidate.candidateDigest,
          reviewerRef,
        });
        assert.throws(() =>
          makeFactoryLessonReviewReceiptV1({
            attestation: safeAttestation,
            candidate: {
              ...safeCandidate,
              [field]: fixture,
            },
            decision: "accepted",
            source: makeFailureRepairSource(1, field).source,
          })
        );
        assert.throws(() =>
          makeFactoryLessonReviewReceiptV1({
            candidate: rawLookingCandidate,
            decision: "accepted",
            source: makeFailureRepairSource(1, fixture).source,
          } as never)
        );
      }
  });

  it("keeps rejected, deferred, superseded, and retired transitions traceable without persisting rejected prose", () => {
    const first = acceptedReview(2);
    const secondFailure = makeFailureRepairSource(3, "second");
    const secondCandidate = makeFactoryLessonCandidateV1({
      ...lessonInput,
      compactLesson: "Prefer the exact event-owned projection.",
      durableOwnerDigest: "4".repeat(64),
      durableOwnerVersion: "gaia.failure-evidence-projection.v2",
    });
    const secondAttestation = makeNoRawTelemetryAttestationV1({
      candidateDigest: secondCandidate.candidateDigest,
      reviewerRef,
    });
    const secondAccepted = makeFactoryLessonReviewReceiptV1({
      attestation: secondAttestation,
      candidate: secondCandidate,
      decision: "accepted",
      source: secondFailure.source,
    });
    const secondEvent = makeRunEvent({
      payload: {
        factoryLessonReview: Schema.encodeSync(FactoryLessonReviewReceiptV1)(
          secondAccepted
        ),
      },
      runId: sourceRunId,
      sequence: 4,
      timestamp: "2026-07-25T20:00:04.000Z",
      type: "FACTORY_LESSON_REVIEW_RECORDED",
    });
    const rejected = makeFactoryLessonReviewReceiptV1({
      candidateDigest: "a".repeat(64),
      decision: "rejected",
      reason: "duplicatesExistingIntent",
      reviewerRef,
      source: secondFailure.source,
    });
    assert.notProperty(rejected, "candidate");
    assert.notProperty(rejected, "projection");
    assert.throws(() =>
      makeFactoryLessonReviewReceiptV1({
        ...rejected,
        compactLesson: "must not persist",
      } as never)
    );
    const rejectedEvent = makeRunEvent({
      payload: {
        factoryLessonReview: Schema.encodeSync(FactoryLessonReviewReceiptV1)(
          rejected
        ),
      },
      runId: sourceRunId,
      sequence: 5,
      timestamp: "2026-07-25T20:00:05.000Z",
      type: "FACTORY_LESSON_REVIEW_RECORDED",
    });
    const deferred = makeFactoryLessonReviewReceiptV1({
      candidateDigest: "b".repeat(64),
      decision: "deferred",
      reason: "promotionDeferred",
      reviewerRef,
      source: secondFailure.source,
    });
    if (deferred.decision !== "deferred")
      throw new Error("Deferred review fixture was not deferred.");
    const deferredEvent = makeRunEvent({
      payload: {
        factoryLessonReview: Schema.encodeSync(FactoryLessonReviewReceiptV1)(
          deferred
        ),
      },
      runId: sourceRunId,
      sequence: 6,
      timestamp: "2026-07-25T20:00:06.000Z",
      type: "FACTORY_LESSON_REVIEW_RECORDED",
    });
    const deferredResolved = makeFactoryLessonReviewReceiptV1({
      candidateDigest: deferred.candidateDigest,
      decision: "rejected",
      reason: "insufficientEvidence",
      reviewerRef,
      source: secondFailure.source,
    });
    const deferredResolvedEvent = makeRunEvent({
      payload: {
        factoryLessonReview: Schema.encodeSync(FactoryLessonReviewReceiptV1)(
          deferredResolved
        ),
      },
      runId: sourceRunId,
      sequence: 7,
      timestamp: "2026-07-25T20:00:07.000Z",
      type: "FACTORY_LESSON_REVIEW_RECORDED",
    });
    const superseded = makeFactoryLessonReviewReceiptV1({
      decision: "superseded",
      lessonId:
        first.receipt.decision === "accepted"
          ? first.receipt.projection.lessonId
          : "",
      replacement:
        secondAccepted.decision === "accepted"
          ? {
              lessonId: secondAccepted.projection.lessonId,
              projectionDigest: secondAccepted.projection.projectionDigest,
              version: 1,
            }
          : {
              lessonId: "",
              projectionDigest: "",
              version: 1,
            },
      reviewerRef,
    });
    const supersededEvent = makeRunEvent({
      payload: {
        factoryLessonReview: Schema.encodeSync(FactoryLessonReviewReceiptV1)(
          superseded
        ),
      },
      runId: sourceRunId,
      sequence: 8,
      timestamp: "2026-07-25T20:00:08.000Z",
      type: "FACTORY_LESSON_REVIEW_RECORDED",
    });
    const retired = makeFactoryLessonReviewReceiptV1({
      decision: "retired",
      lessonId:
        secondAccepted.decision === "accepted"
          ? secondAccepted.projection.lessonId
          : "",
      retirementEvidence: {
        kind: "linearComment",
        ref: "linear-comment:retirement-456",
        version: 1,
      },
      reviewerRef,
    });
    const retiredEvent = makeRunEvent({
      payload: {
        factoryLessonReview: Schema.encodeSync(FactoryLessonReviewReceiptV1)(
          retired
        ),
      },
      runId: sourceRunId,
      sequence: 9,
      timestamp: "2026-07-25T20:00:09.000Z",
      type: "FACTORY_LESSON_REVIEW_RECORDED",
    });
    const projection = projectFactoryLessons([
      first.failure,
      first.event,
      secondFailure.event,
      secondEvent,
      rejectedEvent,
      deferredEvent,
      deferredResolvedEvent,
      supersededEvent,
      retiredEvent,
    ]);

    assert.deepEqual(
      projection.history.map(({ state }) => state),
      [
        "accepted",
        "accepted",
        "rejected",
        "deferred",
        "rejected",
        "superseded",
        "retired",
      ]
    );
    assert.lengthOf(projection.active, 0);
  });

  it("rejects a second active projection for the same exact durable owner identity", () => {
    const first = acceptedReview(2);
    const secondFailure = makeFailureRepairSource(3, "duplicate-owner");
    const duplicateCandidate = makeFactoryLessonCandidateV1({
      ...lessonInput,
      compactLesson: "Duplicate the same owner intent with different prose.",
    });
    const duplicateReview = makeFactoryLessonReviewReceiptV1({
      attestation: makeNoRawTelemetryAttestationV1({
        candidateDigest: duplicateCandidate.candidateDigest,
        reviewerRef,
      }),
      candidate: duplicateCandidate,
      decision: "accepted",
      source: secondFailure.source,
    });
    const duplicateEvent = makeRunEvent({
      payload: {
        factoryLessonReview: Schema.encodeSync(FactoryLessonReviewReceiptV1)(
          duplicateReview
        ),
      },
      runId: sourceRunId,
      sequence: 4,
      timestamp: "2026-07-25T20:00:04.000Z",
      type: "FACTORY_LESSON_REVIEW_RECORDED",
    });

    assert.throws(
      () =>
        projectFactoryLessons([
          first.failure,
          first.event,
          secondFailure.event,
          duplicateEvent,
        ]),
      /durable owner identity/u
    );
  });

  it("requires the exact prior GAIA-149 failure-repair evidence binding", () => {
    const accepted = acceptedReview();
    const wrongSourceEvent = makeFailureRepairSource(1, "wrong").event;
    assert.throws(
      () => projectFactoryLessons([wrongSourceEvent, accepted.event]),
      /failure|source|fingerprint/u
    );
    assert.throws(
      () => projectFactoryLessons([accepted.event, accepted.failure]),
      /prior|source/u
    );
  });

  it("selects accepted lessons only for later workerInitial input and fits the complete rendered byte budget", () => {
    const accepted = acceptedReview();
    const projection = projectFactoryLessons([
      accepted.failure,
      accepted.event,
    ]);
    const selected = selectFactoryLessonsForWorkerInitial({
      available: projection.active,
      baseContent: baseContent(),
      target: {
        createdAt: "2026-07-25T21:00:00.000Z",
        runId: laterRunId,
      },
    });

    assert.lengthOf(selected.selection.lessons, 1);
    assert.include(selected.rendered.text, lessonInput.compactLesson);
    assert.notInclude(selected.rendered.text, lessonInput.expectedEffect);
    assert.notInclude(selected.rendered.text, lessonInput.retirementCondition);
    assert.strictEqual(
      selected.selection.baseRenderedBytes,
      renderModelInputV1(baseContent()).byteLength
    );
    assert.strictEqual(
      selected.selection.finalRenderedBytes,
      selected.rendered.byteLength
    );
    assert.strictEqual(selected.selection.maximumRenderedBytes, 16_384);
    assert.isAtMost(selected.rendered.byteLength, 16_384);
    assert.deepEqual(
      selectFactoryLessonsForWorkerInitial({
        available: projection.active,
        baseContent: baseContent(),
        target: {
          createdAt: "2026-07-25T21:00:00.000Z",
          runId: laterRunId,
        },
      }),
      selected
    );

    let low = 1;
    let high = 16_384;
    let nearCeiling = baseContent("x");
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      try {
        const candidate = baseContent("x".repeat(middle));
        renderModelInputV1(candidate);
        nearCeiling = candidate;
        low = middle + 1;
      } catch {
        high = middle - 1;
      }
    }
    const omitted = selectFactoryLessonsForWorkerInitial({
      available: projection.active,
      baseContent: nearCeiling,
      target: {
        createdAt: "2026-07-25T21:00:00.000Z",
        runId: laterRunId,
      },
    });
    assert.lengthOf(omitted.selection.lessons, 0);
    assert.deepEqual(
      omitted.selection.omitted.map(({ reason }) => reason),
      ["renderBudget"]
    );
    assert.isAtMost(omitted.rendered.byteLength, 16_384);
    const { version: _contentVersion, ...contentRefPayload } =
      baseContent().payload;
    const contentRefLimited = selectFactoryLessonsForWorkerInitial({
      available: projection.active,
      baseContent: makeModelContextContentV1({
        ...contentRefPayload,
        contentRefs: Array.from({ length: 64 }, (_item, index) => ({
          digest: index.toString(16).padStart(64, "0"),
          kind: "existing/v1",
          relevance: "existing bounded input",
        })),
      }),
      target: {
        createdAt: "2026-07-25T21:00:00.000Z",
        runId: laterRunId,
      },
    });
    assert.lengthOf(contentRefLimited.selection.lessons, 0);
    assert.deepEqual(
      contentRefLimited.selection.omitted.map(({ reason }) => reason),
      ["contentRefLimit"]
    );

    const budgetSource = makeFailureRepairSource(1, "budget-order");
    const makeAcceptedProjection = (compactLesson: string) => {
      const candidate = makeFactoryLessonCandidateV1({
        ...lessonInput,
        compactLesson,
      });
      const review = makeFactoryLessonReviewReceiptV1({
        attestation: makeNoRawTelemetryAttestationV1({
          candidateDigest: candidate.candidateDigest,
          reviewerRef,
        }),
        candidate,
        decision: "accepted",
        source: budgetSource.source,
      });
      if (review.decision !== "accepted")
        throw new Error("Accepted budget fixture was not accepted.");
      return review.projection;
    };
    const smallProjection = makeAcceptedProjection("Use typed evidence.");
    let largeProjection = makeAcceptedProjection(`${"B".repeat(650)}0`);
    for (let suffix = 1; suffix < 128; suffix += 1) {
      if (largeProjection.lessonId < smallProjection.lessonId) break;
      largeProjection = makeAcceptedProjection(`${"B".repeat(650)}${suffix}`);
    }
    assert.strictEqual(
      largeProjection.lessonId.localeCompare(smallProjection.lessonId),
      -1
    );
    const makeActive = (
      lessonProjection: typeof largeProjection | typeof smallProjection
    ) =>
      FactoryLessonActiveV1.make({
        acceptedAt: "2026-07-25T20:00:00.000Z",
        acceptedEventSequence: parseRunEventSequence(2),
        projection: lessonProjection,
        sourceRunId,
        version: 1,
      });
    let smallerFitsAfterLargeOmission:
      | ReturnType<typeof selectFactoryLessonsForWorkerInitial>
      | undefined;
    for (
      let taskBytes = nearCeiling.payload.taskInput.length;
      taskBytes >= Math.max(1, nearCeiling.payload.taskInput.length - 1_024);
      taskBytes -= 1
    ) {
      const result = selectFactoryLessonsForWorkerInitial({
        available: [makeActive(largeProjection), makeActive(smallProjection)],
        baseContent: baseContent("x".repeat(taskBytes)),
        target: {
          createdAt: "2026-07-25T21:00:00.000Z",
          runId: laterRunId,
        },
      });
      if (
        result.selection.lessons.length === 1 &&
        result.selection.lessons[0]?.lessonId === smallProjection.lessonId
      ) {
        smallerFitsAfterLargeOmission = result;
        break;
      }
    }
    assert.isDefined(smallerFitsAfterLargeOmission);
    assert.strictEqual(
      smallerFitsAfterLargeOmission?.selection.omitted[0]?.lesson.lessonId,
      largeProjection.lessonId
    );
    assert.strictEqual(
      smallerFitsAfterLargeOmission?.selection.omitted[0]?.reason,
      "renderBudget"
    );

    const manyEligible = Array.from({ length: 1_089 }, (_item, index) => {
      const manyCandidate = makeFactoryLessonCandidateV1({
        ...lessonInput,
        compactLesson: `Use bounded reviewed evidence owner ${index}.`,
        durableOwnerDigest: index.toString(16).padStart(64, "0"),
        durableOwnerVersion: `gaia.failure-evidence-projection.v${index + 2}`,
      });
      const manyReview = makeFactoryLessonReviewReceiptV1({
        attestation: makeNoRawTelemetryAttestationV1({
          candidateDigest: manyCandidate.candidateDigest,
          reviewerRef,
        }),
        candidate: manyCandidate,
        decision: "accepted",
        source: budgetSource.source,
      });
      if (manyReview.decision !== "accepted")
        throw new Error("Accepted omission-bound fixture was not accepted.");
      return FactoryLessonActiveV1.make({
        acceptedAt: "2026-07-25T20:00:00.000Z",
        acceptedEventSequence: parseRunEventSequence(index + 1),
        projection: manyReview.projection,
        sourceRunId,
        version: 1,
      });
    });
    const boundedOmissions = selectFactoryLessonsForWorkerInitial({
      available: manyEligible,
      baseContent: nearCeiling,
      target: {
        createdAt: "2026-07-25T21:00:00.000Z",
        runId: laterRunId,
      },
    });
    assert.lengthOf(boundedOmissions.selection.lessons, 0);
    assert.lengthOf(boundedOmissions.selection.omitted, 1_024);
    assert.strictEqual(boundedOmissions.selection.omittedLessonCount, 1_089);
    assert.strictEqual(boundedOmissions.selection.eligibleLessonCount, 1_089);

    assert.lengthOf(
      selectFactoryLessonsForWorkerInitial({
        available: projection.active,
        baseContent: baseContent(),
        target: {
          createdAt: "2026-07-25T19:00:00.000Z",
          runId: laterRunId,
        },
      }).selection.lessons,
      0
    );
    const { version: _version, ...failureRepairPayload } =
      baseContent().payload;
    assert.throws(() =>
      selectFactoryLessonsForWorkerInitial({
        available: projection.active,
        baseContent: makeModelContextContentV1({
          ...failureRepairPayload,
          contentRefs: [],
          episodeRole: "failureRepair",
        }),
        target: {
          createdAt: "2026-07-25T21:00:00.000Z",
          runId: laterRunId,
        },
      })
    );
  });

  it("rejects generic and malformed reserved factory lesson refs during content construction", () => {
    const accepted = acceptedReview();
    if (accepted.receipt.decision !== "accepted")
      throw new Error("Accepted boundary fixture was not accepted.");
    const acceptedProjection = accepted.receipt.projection;
    const { version: _version, ...payload } = baseContent().payload;

    assert.throws(() =>
      makeModelContextContentV1({
        ...payload,
        contentRefs: [
          {
            digest: acceptedProjection.projectionDigest,
            kind: "factoryLesson/v1",
            relevance: acceptedProjection.lessonId,
          },
        ],
      })
    );
    assert.throws(() =>
      makeModelContextContentV1({
        ...payload,
        contentRefs: [
          {
            kind: "factoryLesson/v1",
            lessonId: acceptedProjection.lessonId,
            projectionDigest: acceptedProjection.projectionDigest,
            version: 1,
          },
        ],
      })
    );
    const malformedReservedRefs: ReadonlyArray<unknown> = [
      {
        kind: "factoryLesson/v1",
        lessonId: "not-a-factory-lesson-id",
        projectionDigest: acceptedProjection.projectionDigest,
        version: 1,
      },
      {
        kind: "factoryLesson/v1",
        lessonId: acceptedProjection.lessonId,
        projectionDigest: acceptedProjection.projectionDigest,
        version: 2,
      },
      {
        kind: "factoryLesson/v1",
        lessonId: acceptedProjection.lessonId,
        projectionDigest: "not-a-projection-digest",
        version: 1,
      },
      {
        kind: "factoryLesson/v1",
        lessonId: acceptedProjection.lessonId,
        projectionDigest:
          acceptedProjection.projectionDigest === "f".repeat(64)
            ? "e".repeat(64)
            : "f".repeat(64),
        version: 1,
      },
      {
        kind: "factoryLesson/v1",
        lessonId: acceptedProjection.lessonId,
        version: 1,
      },
    ];
    for (const malformedReservedRef of malformedReservedRefs)
      assert.throws(() =>
        makeModelContextContentV1({
          ...payload,
          // @ts-expect-error Intentionally unknown input exercises boundary parsing.
          contentRefs: [malformedReservedRef],
        })
      );
  });

  it("binds the exact selected factory lesson ref to rendered workerInitial bytes and budget", () => {
    const accepted = acceptedReview();
    const projection = projectFactoryLessons([
      accepted.failure,
      accepted.event,
    ]);
    const base = baseContent();
    const selected = selectFactoryLessonsForWorkerInitial({
      available: projection.active,
      baseContent: base,
      target: {
        createdAt: "2026-07-25T21:00:00.000Z",
        runId: laterRunId,
      },
    });
    const selectedLesson = selected.selection.lessons[0];
    const selectedRef = selected.content.payload.contentRefs.find(
      (ref) =>
        ref.kind === "factoryLesson/v1" &&
        "projectionDigest" in ref &&
        ref.projectionDigest === selectedLesson?.projectionDigest
    );
    assert.isDefined(selectedLesson);
    assert.isDefined(selectedRef);
    if (
      selectedLesson === undefined ||
      selectedRef === undefined ||
      !("projectionDigest" in selectedRef)
    )
      return;

    const exactRenderedRef = [
      `kind=${selectedRef.kind}`,
      `lessonId=${selectedRef.lessonId}`,
      `version=${selectedRef.version}`,
      `projectionDigest=${selectedRef.projectionDigest}`,
    ].join("; ");
    assert.include(selected.rendered.text, exactRenderedRef);

    const { version: _selectedVersion, ...selectedPayload } =
      selected.content.payload;
    const withoutRef = makeModelContextContentV1({
      ...selectedPayload,
      contentRefs: [],
    });
    const renderedWithoutRef = renderModelInputV1(withoutRef);
    assert.notStrictEqual(selected.rendered.text, renderedWithoutRef.text);
    assert.notStrictEqual(
      selected.rendered.renderedInputDigest,
      renderedWithoutRef.renderedInputDigest
    );
    assert.isAbove(selected.rendered.byteLength, renderedWithoutRef.byteLength);

    const alternateAccepted = acceptedReview(4, {
      ...lessonInput,
      expectedEffect: `${lessonInput.expectedEffect} Alternate projection.`,
    });
    const alternateProjection = projectFactoryLessons([
      alternateAccepted.failure,
      alternateAccepted.event,
    ]);
    const changedRef = selectFactoryLessonsForWorkerInitial({
      available: alternateProjection.active,
      baseContent: base,
      target: {
        createdAt: "2026-07-25T21:00:00.000Z",
        runId: laterRunId,
      },
    });
    assert.lengthOf(changedRef.selection.lessons, 1);
    assert.strictEqual(
      alternateProjection.active[0]?.projection.compactLesson,
      projection.active[0]?.projection.compactLesson
    );
    assert.notStrictEqual(
      changedRef.selection.lessons[0]?.projectionDigest,
      selectedRef.projectionDigest
    );
    assert.notStrictEqual(selected.rendered.text, changedRef.rendered.text);
    assert.notStrictEqual(
      selected.rendered.renderedInputDigest,
      changedRef.rendered.renderedInputDigest
    );

    const { version: _baseVersion, ...basePayload } = base.payload;
    const genericRefDigest = "a".repeat(64);
    const genericRef = renderModelInputV1(
      makeModelContextContentV1({
        ...basePayload,
        contentRefs: [
          {
            digest: genericRefDigest,
            kind: "existing/v1",
            relevance: "existing bounded input",
          },
        ],
      })
    );
    assert.notInclude(genericRef.text, "existing/v1");
    assert.notInclude(genericRef.text, genericRefDigest);

    const baseRendered = renderModelInputV1(base);
    const proseOnlyLessonBytes =
      renderedWithoutRef.byteLength - baseRendered.byteLength;
    const budgetPadding =
      16_384 - baseRendered.byteLength - proseOnlyLessonBytes;
    assert.isAtLeast(budgetPadding, 0);
    const atProseOnlyCeiling = baseContent(
      `${base.payload.taskInput}${"x".repeat(budgetPadding)}`
    );
    assert.strictEqual(
      renderModelInputV1(atProseOnlyCeiling).byteLength + proseOnlyLessonBytes,
      16_384
    );
    const refBudgeted = selectFactoryLessonsForWorkerInitial({
      available: projection.active,
      baseContent: atProseOnlyCeiling,
      target: {
        createdAt: "2026-07-25T21:00:00.000Z",
        runId: laterRunId,
      },
    });
    assert.lengthOf(refBudgeted.selection.lessons, 0);
    assert.strictEqual(
      refBudgeted.selection.omitted[0]?.reason,
      "renderBudget"
    );
    assert.isAtMost(refBudgeted.rendered.byteLength, 16_384);
  });

  it("attributes only exact selected workerInitial bindings and distinguishes every observable state", () => {
    const accepted = acceptedReview();
    const projection = projectFactoryLessons([
      accepted.failure,
      accepted.event,
    ]);
    const selected = selectFactoryLessonsForWorkerInitial({
      available: projection.active,
      baseContent: baseContent(),
      target: {
        createdAt: "2026-07-25T21:00:00.000Z",
        runId: laterRunId,
      },
    });
    const selectedLesson = selected.selection.lessons[0];
    assert.isDefined(selectedLesson);
    if (selectedLesson === undefined) return;
    const start = makeRunEvent({
      payload: {
        factoryLessonContextSelection: Schema.encodeSync(
          FactoryLessonContextSelectionV1
        )(selected.selection),
      },
      runId: laterRunId,
      sequence: 1,
      timestamp: "2026-07-25T21:00:01.000Z",
      type: "WORKER_STARTED",
    });
    const observations = [
      {
        kind: "offered" as const,
        source: "codexBatchTransport" as const,
        trust: "high" as const,
      },
      {
        kind: "retrieved" as const,
        source: "providerTelemetry" as const,
        trust: "high" as const,
      },
      {
        kind: "invoked" as const,
        source: "providerTelemetry" as const,
        trust: "high" as const,
      },
      {
        kind: "relevant" as const,
        source: "providerSelfReport" as const,
        trust: "low" as const,
      },
      {
        kind: "unobservable" as const,
        source: "gaiaBoundary" as const,
        trust: "none" as const,
      },
    ] as const;

    for (const [index, input] of observations.entries()) {
      const observation = makeFactoryLessonContextObservationV1({
        ...input,
        contextContentDigest: selected.selection.contextContentDigest,
        episodeRole: "workerInitial",
        lesson: selectedLesson,
        selectionDigest: selected.selection.selectionDigest,
        targetRunId: laterRunId,
      });
      const event = makeRunEvent({
        payload: {
          factoryLessonContextObservation: Schema.encodeSync(
            FactoryLessonContextObservationV1
          )(observation),
        },
        runId: laterRunId,
        sequence: 2,
        timestamp: `2026-07-25T21:00:0${index + 2}.000Z`,
        type: "FACTORY_LESSON_CONTEXT_OBSERVED",
      });
      const attribution = resolveFactoryLessonContextAttribution([
        start,
        event,
      ]);
      assert.deepEqual(
        attribution.attributions[0]?.observations.map(({ kind }) => kind),
        [input.kind]
      );
    }

    assert.lengthOf(
      resolveFactoryLessonContextAttribution([start]).attributions[0]
        ?.observations ?? [],
      0
    );
    const makeObservationEvent = (
      input: (typeof observations)[number],
      sequence: number
    ) => {
      const observation = makeFactoryLessonContextObservationV1({
        ...input,
        contextContentDigest: selected.selection.contextContentDigest,
        episodeRole: "workerInitial",
        lesson: selectedLesson,
        selectionDigest: selected.selection.selectionDigest,
        targetRunId: laterRunId,
      });
      return makeRunEvent({
        payload: {
          factoryLessonContextObservation: Schema.encodeSync(
            FactoryLessonContextObservationV1
          )(observation),
        },
        runId: laterRunId,
        sequence,
        timestamp: `2026-07-25T21:00:0${sequence}.000Z`,
        type: "FACTORY_LESSON_CONTEXT_OBSERVED",
      });
    };
    const offeredEvent = makeObservationEvent(observations[0], 2);
    const unobservableEvent = makeObservationEvent(observations[4], 3);
    assert.deepEqual(
      resolveFactoryLessonContextAttribution([
        start,
        offeredEvent,
        unobservableEvent,
      ]).attributions[0]?.observations.map(({ kind }) => kind),
      ["offered", "unobservable"]
    );
    assert.throws(() =>
      resolveFactoryLessonContextAttribution([
        start,
        offeredEvent,
        unobservableEvent,
        makeObservationEvent(observations[1], 4),
      ])
    );
    const wrongObservation = makeFactoryLessonContextObservationV1({
      contextContentDigest: selected.selection.contextContentDigest,
      episodeRole: "workerInitial",
      kind: "retrieved",
      lesson: { ...selectedLesson, projectionDigest: "f".repeat(64) },
      selectionDigest: selected.selection.selectionDigest,
      source: "providerTelemetry",
      targetRunId: laterRunId,
      trust: "high",
    });
    const wrongEvent = makeRunEvent({
      payload: {
        factoryLessonContextObservation: Schema.encodeSync(
          FactoryLessonContextObservationV1
        )(wrongObservation),
      },
      runId: laterRunId,
      sequence: 2,
      timestamp: "2026-07-25T21:00:02.000Z",
      type: "FACTORY_LESSON_CONTEXT_OBSERVED",
    });
    assert.throws(() =>
      resolveFactoryLessonContextAttribution([start, wrongEvent])
    );

    const arbitraryLesson = {
      lessonId: `lesson1_${"e".repeat(64)}`,
      projectionDigest: "e".repeat(64),
      version: 1 as const,
    };
    const forgedSelection = makeFactoryLessonContextSelectionV1({
      baseRenderedBytes: selected.selection.baseRenderedBytes,
      contextContentDigest: selected.selection.contextContentDigest,
      eligibleLessonCount: 1,
      finalRenderedBytes: selected.selection.finalRenderedBytes,
      lessons: [arbitraryLesson],
      maximumRenderedBytes: 16_384,
      omitted: [],
      omittedLessonCount: 0,
      targetRunId: laterRunId,
    });
    const forgedStart = makeRunEvent({
      payload: {
        factoryLessonContextSelection: Schema.encodeSync(
          FactoryLessonContextSelectionV1
        )(forgedSelection),
      },
      runId: laterRunId,
      sequence: 1,
      timestamp: "2026-07-25T21:00:01.000Z",
      type: "WORKER_STARTED",
    });
    assert.throws(
      () =>
        projectFactoryLessons([accepted.failure, accepted.event, forgedStart]),
      /active accepted|selection/u
    );
  });

  it("validates later context against the target run creation cutoff", () => {
    const accepted = acceptedReview();
    const projection = projectFactoryLessons([
      accepted.failure,
      accepted.event,
    ]);
    const targetCreated = makeRunEvent({
      payload: {},
      runId: laterRunId,
      sequence: 1,
      timestamp: "2026-07-25T19:00:00.000Z",
      type: "RUN_CREATED",
    });
    const selected = selectFactoryLessonsForWorkerInitial({
      available: projection.active,
      baseContent: baseContent(),
      target: {
        createdAt: targetCreated.timestamp,
        runId: laterRunId,
      },
    });
    const workerStarted = makeRunEvent({
      payload: {
        factoryLessonContextSelection: Schema.encodeSync(
          FactoryLessonContextSelectionV1
        )(selected.selection),
      },
      runId: laterRunId,
      sequence: 2,
      timestamp: "2026-07-25T20:00:03.000Z",
      type: "WORKER_STARTED",
    });

    assert.lengthOf(selected.selection.lessons, 0);
    assert.strictEqual(
      projectFactoryLessons([
        targetCreated,
        accepted.failure,
        accepted.event,
        workerStarted,
      ]).active.length,
      1
    );
  });
});
