import {
  FactoryLessonContextObservationV1,
  FactoryLessonContextSelectionV1,
  FactoryLessonProjectionRefV1,
  FactoryLessonReadModelV1,
  FactoryLessonReviewInputV1,
  FactoryLessonReviewReceiptV1,
  makeRunEvent,
  makeFactoryLessonReviewReceiptV1,
  parseRunId,
  parseFactoryLessonReviewReceiptV1,
  projectFactoryLessons,
  resolveFactoryLessonContextAttribution,
  RunIdSchema,
  snapshotFromReplay,
  type RunEvent,
  type RunId,
} from "@gaia/core";
import { Effect, FileSystem, PartitionedSemaphore, Schema } from "effect";

import { makeRuntimeError } from "./errors.js";
import {
  appendPreparedEventWithinSerialization,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import { assertFactoryRunAcceptanceSecretSafe } from "./model-invocation.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  type RunPaths,
  type RunStorageOptions,
  type RuntimePath,
} from "./paths.js";

const encodeReview = Schema.encodeSync(FactoryLessonReviewReceiptV1);
const strict = { parseOptions: { onExcessProperty: "error" as const } };

export class FactoryLessonAttributionV1 extends Schema.Class<FactoryLessonAttributionV1>(
  "FactoryLessonAttributionV1"
)(
  {
    lesson: FactoryLessonProjectionRefV1,
    observations: Schema.Array(FactoryLessonContextObservationV1),
  },
  strict
) {}

export class FactoryLessonArtifactV1 extends Schema.Class<FactoryLessonArtifactV1>(
  "FactoryLessonArtifactV1"
)(
  {
    attributions: Schema.Array(FactoryLessonAttributionV1),
    lessons: FactoryLessonReadModelV1,
    selection: Schema.UndefinedOr(FactoryLessonContextSelectionV1),
    sourceRunId: RunIdSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

const FactoryLessonArtifactJson = Schema.toCodecJson(FactoryLessonArtifactV1);
const encodeArtifactJson = Schema.encodeSync(FactoryLessonArtifactJson);
const factoryLessonProjectionSemaphore =
  PartitionedSemaphore.makeUnsafe<RuntimePath>({ permits: 1 });

function validate<A>(code: string, message: string, evaluate: () => A) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code,
        message,
        recoverable: false,
      }),
    try: evaluate,
  });
}

function orderedFactoryLessonEvents(options: RunStorageOptions = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);
    if (!(yield* fs.exists(store.runsRoot))) return [];
    const entries = (yield* fs.readDirectory(store.runsRoot))
      .filter((entry) => entry.startsWith("run-"))
      .sort();
    const events: Array<RunEvent> = [];
    for (const entry of entries) {
      const runId = yield* validate(
        "InvalidRunId",
        "Factory lesson discovery found an invalid run directory.",
        () => parseRunId(entry)
      );
      const paths = yield* makeRunPaths(runId, options);
      if (yield* fs.exists(paths.events))
        events.push(...(yield* readEvents(paths)));
    }
    return events.sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        left.runId.localeCompare(right.runId) ||
        left.sequence - right.sequence
    );
  });
}

function deriveFactoryLessons(options: RunStorageOptions = {}) {
  return Effect.gen(function* () {
    const events = yield* orderedFactoryLessonEvents(options);
    return yield* validate(
      "InvalidFactoryLessonHistory",
      "Factory lesson events violate the reviewed promotion contract.",
      () => projectFactoryLessons(events)
    );
  });
}

function deriveFactoryLessonArtifact(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const events = yield* orderedFactoryLessonEvents(options);
    const lessons = yield* validate(
      "InvalidFactoryLessonHistory",
      "Factory lesson events violate the reviewed promotion contract.",
      () => projectFactoryLessons(events)
    );
    const attribution = yield* validate(
      "InvalidFactoryLessonAttribution",
      "Factory lesson context events violate their exact attribution contract.",
      () =>
        resolveFactoryLessonContextAttribution(
          events.filter((event) => event.runId === runId)
        )
    );
    return FactoryLessonArtifactV1.make({
      attributions: attribution.attributions,
      lessons,
      selection: attribution.selection,
      sourceRunId: runId,
      version: 1,
    });
  });
}

export function canonicalFactoryLessonArtifactBody(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return deriveFactoryLessonArtifact(runId, options).pipe(
    Effect.map(
      (artifact) => `${JSON.stringify(encodeArtifactJson(artifact), null, 2)}\n`
    )
  );
}

function writeFactoryLessonArtifact(
  artifact: FactoryLessonArtifactV1,
  paths: RunPaths
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(paths.promotedEvidenceDirectory, {
      recursive: true,
    });
    yield* fs.writeFileString(
      paths.factoryLessons,
      `${JSON.stringify(encodeArtifactJson(artifact), null, 2)}\n`
    );
    return artifact;
  }).pipe(
    Effect.mapError((cause) =>
      makeRuntimeError({
        cause,
        code: "FactoryLessonArtifactWriteFailed",
        message: "The derived factory lesson artifact could not be written.",
      })
    )
  );
}

/**
 * Explicitly append one reviewed promotion transition. The public operation
 * constructs the receipt from reviewed input; callers cannot bypass the exact
 * candidate/attestation binding by supplying a prebuilt receipt.
 */
export function recordFactoryLessonReview(
  runId: RunId,
  reviewInput: typeof FactoryLessonReviewInputV1.Encoded,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const review = yield* validate(
      "InvalidFactoryLessonReview",
      "Factory lesson review input is invalid.",
      () => makeFactoryLessonReviewReceiptV1(reviewInput)
    );
    if (
      (review.decision === "accepted" ||
        review.decision === "rejected" ||
        review.decision === "deferred") &&
      review.source.runId !== runId
    )
      return yield* Effect.fail(
        makeRuntimeError({
          code: "InvalidFactoryLessonReview",
          message: "Factory lesson review input belongs to another source run.",
          recoverable: false,
        })
      );
    yield* assertFactoryRunAcceptanceSecretSafe(encodeReview(review));
    const paths = yield* makeRunPaths(runId, options);
    const store = yield* makeRunStorePaths(options);

    return yield* factoryLessonProjectionSemaphore
      .withPermits(
        store.gaiaRoot,
        1
      )(
        withRunEventSerialization(
          paths,
          Effect.gen(function* () {
            const existing = yield* readEvents(paths);
            const snapshot = yield* validate(
              "FactoryLessonSourceNotTerminal",
              "Factory lessons can be reviewed only after a completed or failed source run.",
              () => snapshotFromReplay(existing)
            );
            const authoritativeEvents =
              yield* orderedFactoryLessonEvents(options);
            const existingReview = authoritativeEvents.find((event) => {
              if (event.type !== "FACTORY_LESSON_REVIEW_RECORDED") return false;
              return (
                parseFactoryLessonReviewReceiptV1(
                  event.payload["factoryLessonReview"]
                ).reviewDigest === review.reviewDigest
              );
            });
            if (existingReview !== undefined) {
              if (existingReview.runId !== runId)
                return yield* Effect.fail(
                  makeRuntimeError({
                    code: "InvalidFactoryLessonReview",
                    message:
                      "Factory lesson review identity is already owned by another run.",
                    recoverable: false,
                  })
                );
              const artifact = yield* deriveFactoryLessonArtifact(
                runId,
                options
              );
              yield* writeFactoryLessonArtifact(artifact, paths);
              return {
                artifact,
                event: existingReview,
                projection: artifact.lessons,
                review,
              };
            }
            if (snapshot.state !== "completed" && snapshot.state !== "failed")
              return yield* Effect.fail(
                makeRuntimeError({
                  code: "FactoryLessonSourceNotTerminal",
                  message:
                    "Factory lessons can be reviewed only after a completed or failed source run.",
                  recoverable: false,
                })
              );
            const latestTimestamp = authoritativeEvents.reduce(
              (latest, event) => Math.max(latest, Date.parse(event.timestamp)),
              Date.now()
            );
            const prepared = makeRunEvent({
              payload: {
                factoryLessonReview: encodeReview(review),
              },
              runId,
              sequence: existing.length + 1,
              timestamp: new Date(latestTimestamp + 1).toISOString(),
              type: "FACTORY_LESSON_REVIEW_RECORDED",
            });
            yield* validate(
              "InvalidFactoryLessonHistory",
              "Factory lesson review violates the reviewed promotion lifecycle.",
              () => projectFactoryLessons([...authoritativeEvents, prepared])
            );
            const appended = yield* appendPreparedEventWithinSerialization(
              runId,
              paths,
              existing,
              prepared
            );
            const artifact = yield* deriveFactoryLessonArtifact(runId, options);
            yield* writeFactoryLessonArtifact(artifact, paths);
            return {
              artifact,
              event: appended.event,
              projection: artifact.lessons,
              review,
            };
          })
        )
      )
      .pipe(Effect.uninterruptible);
  });
}

/** Rebuild one disposable run-owned artifact solely from events.jsonl. */
export function rebuildFactoryLessons(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const store = yield* makeRunStorePaths(options);
    return yield* factoryLessonProjectionSemaphore.withPermits(
      store.gaiaRoot,
      1
    )(
      deriveFactoryLessonArtifact(runId, options).pipe(
        Effect.flatMap((artifact) =>
          writeFactoryLessonArtifact(artifact, paths)
        )
      )
    );
  });
}

/** Read current promotion authority from events, never from derived JSON. */
export function readFactoryLessons(options: RunStorageOptions = {}) {
  return deriveFactoryLessons(options);
}

export function readFactoryLessonsArtifact(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return deriveFactoryLessonArtifact(runId, options);
}
