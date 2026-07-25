import nodePath from "node:path";

import {
  FailureDigestV1,
  FailureRepairDispatchAttempted,
  FailureRepairExhausted,
  FailureRepairFailed,
  FailureRepairIntent,
  FailureRepairOutcomeUnknown,
  FailureRepairSuperseded,
  FailureRepairTurnCompleted,
  FailureRepairVerified,
  failureOutcomeUnknownPolicyV1,
  HarnessEventSchema,
  HarnessExecutionSelection,
  ModelInvocationEpisodeStartV1,
  ModelInvocationObservationV1,
  ResolvedHarnessExecution,
  encodeFailureRepairReceiptJson,
  makeFailureDigestV1,
  parseAnyRunProofResultEnvelope,
  parseFailureRepairReceipt,
  parseHarnessEvent,
  parseHarnessSessionId,
  parseModelInvocationObservation,
  parseRunEventSequence,
  parseWorkspaceRelativePath,
  projectFailureEvidenceV1,
  renderFailureEvidenceV1,
  resolveModelInvocationEpisodes,
  RunIdSchema,
  snapshotFromReplay,
  type FailureRepairReceipt,
  type HarnessEvent,
  type RunEvent,
  type RunId,
  type RunProofResult,
} from "@gaia/core";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";

import type { LiveHarnessSessionCoordinator } from "./agent-session-runtime.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import {
  appendEvent,
  appendEventWithinSerialization,
  appendHarnessSessionEvent,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import {
  issueDeliveryWorkerHarnessCapabilities,
  type HarnessProviderRegistry,
} from "./harness-provider-registry.js";
import { HarnessInput, resumeHarnessSession } from "./harness-session.js";
import {
  commitDerivedAppModelInvocationEpisode,
  loadModelInvocationPair,
} from "./model-invocation.js";
import {
  makeRunPaths,
  RunPathsSchema,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import { withRunStoreLock } from "./run-store-lock.js";
import { recordRunProofResult, type VerificationServices } from "./verifier.js";

export const FailureRepairReverifyInputSchema = Schema.Struct({
  digest: FailureDigestV1,
  paths: RunPathsSchema,
  runId: RunIdSchema,
});

export type FailureRepairReverify = (
  input: Schema.Schema.Type<typeof FailureRepairReverifyInputSchema>
) => Effect.Effect<RunProofResult, unknown, FileSystem.FileSystem | Path.Path>;

export type FailureRepairCoordinatorOptions = RunStorageOptions & {
  readonly harnessProviderRegistry?: HarnessProviderRegistry;
  readonly reverify?: FailureRepairReverify;
  readonly sessionCoordinator?: LiveHarnessSessionCoordinator;
  readonly verificationServices?: VerificationServices;
};

/** Advance the finite exact-claim repair policy under the run-store lease. */
export function continueFailureRepair(
  runId: RunId,
  options: FailureRepairCoordinatorOptions = {}
) {
  return withRunStoreLock(
    options,
    continueFailureRepairWithinLease(runId, options),
    {
      nextSafeAction:
        "Reload authoritative run history before continuing failure repair.",
      operation: "Gaia failure repair",
    }
  );
}

/** Advance at most the two schema-owned repair attempts while a caller owns the lease. */
export function continueFailureRepairWithinLease(
  runId: RunId,
  options: FailureRepairCoordinatorOptions
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    let repair = yield* reserveRepairIntent(runId, paths);
    if (repair === undefined || isTerminal(repair)) return repair;

    repair = yield* advanceRepairAttempt(runId, paths, repair, options);
    if (repair.state === "failed" && repair.proofResultSequence !== undefined) {
      if (repair.digest.attempt === repair.digest.maxAttempts)
        return yield* exhaustRepair(runId, paths, repair);
      repair = yield* reserveRepairIntent(runId, paths);
      if (repair === undefined || isTerminal(repair)) return repair;
      repair = yield* advanceRepairAttempt(runId, paths, repair, options);
      if (
        repair.state === "failed" &&
        repair.proofResultSequence !== undefined &&
        repair.digest.attempt === repair.digest.maxAttempts
      )
        return yield* exhaustRepair(runId, paths, repair);
    }
    return repair;
  });
}

function reserveRepairIntent(runId: RunId, paths: RunPaths) {
  return withRunEventSerialization(
    paths,
    Effect.gen(function* () {
      const events = yield* readEvents(paths);
      const current = latestRepair(events);
      const failedRepair = current?.state === "failed" ? current : undefined;
      if (current !== undefined && current.state !== "failed") return current;
      const previousProofSequence = failedRepair?.proofResultSequence;
      if (failedRepair !== undefined && previousProofSequence === undefined)
        return failedRepair;
      if (snapshotFromReplay(events).state !== "reporting") return current;

      const proof = latestAuthoritativeV2Proof(events);
      if (proof === undefined) return current;
      const failedClaimId =
        failedRepair?.digest.failedRef.kind === "claim"
          ? failedRepair.digest.failedRef.claimId
          : undefined;
      if (failedRepair !== undefined && failedClaimId === undefined)
        return failedRepair;
      const failedProofSequence = proof.recordedBy.sequence;
      const failed =
        failedRepair !== undefined
          ? proof.results.find(({ claimId }) => claimId === failedClaimId)
          : proof.results.find(({ status }) => status === "failed");
      if (
        failedRepair !== undefined &&
        previousProofSequence !== undefined &&
        failedProofSequence > previousProofSequence &&
        failed?.status === "passed"
      ) {
        const superseded = FailureRepairSuperseded.make({
          ...repairBinding(failedRepair),
          proofResultSequence: parseRunEventSequence(failedProofSequence),
          state: "superseded",
        });
        yield* appendEventWithinSerialization(runId, paths, {
          payload: {
            failureRepair: encodeFailureRepairReceiptJson(superseded),
          },
          type: "FAILURE_REPAIR_RECORDED",
        });
        return superseded;
      }
      if (
        failedRepair !== undefined &&
        failedRepair.digest.attempt >= failedRepair.digest.maxAttempts
      )
        return failedRepair;
      if (failed?.status !== "failed") return current;
      const attempt = (current?.digest.attempt ?? 0) + 1;
      const evidenceRefs = projectFailureEvidenceV1(failed.evidence);
      const digest = makeFailureDigestV1({
        attempt,
        evidenceRefs,
        failedRef: { claimId: failed.claimId, kind: "claim" },
        maxAttempts: 2,
        outcomeCertainty: "confirmed",
        retryability: "repairable",
        stage: "verifying",
        tag: "verificationClaimFailed",
      });
      if (
        failedRepair !== undefined &&
        failedRepair.digest.fingerprint !== digest.fingerprint
      )
        return failedRepair;
      const episodeKey =
        `failureRepair:${digest.fingerprint}:${attempt}` as const;
      const intent = FailureRepairIntent.make({
        digest,
        episodeKey,
        failedProofResultSequence: parseRunEventSequence(failedProofSequence),
        runId,
        state: "intentRecorded",
      });
      const modelInvocationEpisode =
        yield* commitDerivedAppModelInvocationEpisode({
          episodeKey,
          episodeRole: "failureRepair",
          events,
          paths,
          runId,
          taskInput: makeFailureRepairTaskInput(intent),
        });
      yield* appendEventWithinSerialization(runId, paths, {
        payload: {
          failureRepair: encodeFailureRepairReceiptJson(intent),
          ...(modelInvocationEpisode === undefined
            ? {}
            : {
                modelInvocationEpisode: Schema.encodeSync(
                  ModelInvocationEpisodeStartV1
                )(modelInvocationEpisode),
              }),
        },
        type: "FAILURE_REPAIR_RECORDED",
      });
      return intent;
    })
  );
}

function advanceRepairAttempt(
  runId: RunId,
  paths: RunPaths,
  input: FailureRepairReceipt,
  options: FailureRepairCoordinatorOptions
) {
  return Effect.gen(function* () {
    let repair = input;
    if (repair.state === "dispatchAttempted")
      repair = yield* reconcileAttemptedRepair(runId, paths, repair);
    else if (repair.state === "intentRecorded")
      repair = yield* runRepairTurn(runId, paths, repair, options);

    if (repair.state === "turnCompleted") {
      repair = yield* authorizeRepairVerification(runId, paths, repair);
      if (repair.state === "turnCompleted")
        repair = yield* verifyRepair(runId, paths, repair, options);
    }
    return repair;
  });
}

function authorizeRepairVerification(
  runId: RunId,
  paths: RunPaths,
  completed: FailureRepairTurnCompleted
) {
  return withRunEventSerialization(
    paths,
    Effect.gen(function* () {
      const events = yield* readEvents(paths);
      const current = latestRepair(events);
      if (
        current?.state !== "turnCompleted" ||
        current.episodeKey !== completed.episodeKey
      )
        return current ?? completed;
      if (snapshotFromReplay(events).state === "verifying") return current;
      const failed = FailureRepairFailed.make({
        ...repairBinding(current),
        code: "RepairLifecycleAuthorityChanged",
        message: "The run lifecycle no longer authorizes repair verification.",
        state: "failed",
      });
      yield* appendEventWithinSerialization(runId, paths, {
        payload: {
          failureRepair: encodeFailureRepairReceiptJson(failed),
        },
        type: "FAILURE_REPAIR_RECORDED",
      });
      return failed;
    })
  );
}

function runRepairTurn(
  runId: RunId,
  paths: RunPaths,
  intent: FailureRepairIntent,
  options: FailureRepairCoordinatorOptions
) {
  const preparation = Effect.gen(function* () {
    const coordinator = options.sessionCoordinator;
    const registry = options.harnessProviderRegistry;
    const events = yield* readEvents(paths);
    const firstEvent = events[0];
    if (
      coordinator === undefined ||
      registry === undefined ||
      firstEvent?.type !== "RUN_CREATED"
    )
      return yield* Effect.fail(sessionUnavailable());
    if (snapshotFromReplay(events).state !== "runningWorker")
      return yield* Effect.fail(
        repairError(
          "RepairLifecycleAuthorityChanged",
          "The run lifecycle no longer authorizes repair dispatch."
        )
      );
    const intentSequence = repairStateSequence(
      events,
      intent,
      "intentRecorded"
    );
    if (intentSequence === undefined)
      return yield* Effect.fail(
        repairError(
          "RepairIntentMissing",
          "The authoritative repair intent is missing."
        )
      );
    const episodes = resolveModelInvocationEpisodes(events);
    const modelEpisode =
      episodes.protocol === "v1"
        ? episodes.episodes.find(
            ({ start }) => start.episodeKey === intent.episodeKey
          )
        : undefined;
    if (modelEpisode === undefined)
      return yield* Effect.fail(
        repairError(
          "RepairModelInvocationMissing",
          "The authoritative repair input manifest is missing."
        )
      );
    const modelInput = yield* loadModelInvocationPair(
      paths,
      modelEpisode.start
    );
    const accepted = acceptedExecution(firstEvent);
    const resolved = yield* registry
      .resolve(accepted.selection, issueDeliveryWorkerHarnessCapabilities)
      .pipe(Effect.mapError(() => sessionUnavailable()));
    if (
      JSON.stringify(
        Schema.encodeSync(ResolvedHarnessExecution)(resolved.execution)
      ) !==
      JSON.stringify(
        Schema.encodeSync(ResolvedHarnessExecution)(accepted.resolved)
      )
    )
      return yield* Effect.fail(
        repairError(
          "RepairSessionProviderChanged",
          "The accepted provider resolution changed."
        )
      );
    const sessionId = parseHarnessSessionId(`session-${runId}`);
    const session = yield* resumeHarnessSession({
      provider: resolved.provider,
      request: {
        sessionId,
        workspacePath: parseWorkspaceRelativePath(
          nodePath.relative(options.rootDirectory ?? ".", paths.workspace)
        ),
      },
      requiredCapabilities: issueDeliveryWorkerHarnessCapabilities,
    }).pipe(Effect.mapError(() => sessionUnavailable()));
    yield* coordinator.register({
      agentId: issueDeliveryAgentIds.worker,
      generation: intentSequence,
      runId,
      session,
      sessionId,
    });
    return {
      events,
      intentSequence,
      modelEpisode,
      modelInput,
      session,
      sessionId,
    } as const;
  });

  return Effect.scoped(
    preparation.pipe(
      Effect.matchEffect({
        onFailure: (cause) => {
          const failure =
            cause instanceof GaiaRuntimeError ? cause : sessionUnavailable();
          return recordFailed(
            runId,
            paths,
            intent,
            failure.code,
            failure.message
          );
        },
        onSuccess: ({
          events,
          intentSequence,
          modelEpisode,
          modelInput,
          session,
          sessionId,
        }) =>
          appendRepair(
            runId,
            paths,
            FailureRepairDispatchAttempted.make({
              ...repairBinding(intent),
              state: "dispatchAttempted",
            })
          ).pipe(
            Effect.matchEffect({
              onFailure: () =>
                recordFailed(
                  runId,
                  paths,
                  intent,
                  "RepairDispatchNotReserved",
                  "The repair dispatch attempt could not be reserved."
                ),
              onSuccess: (attempted) =>
                Effect.gen(function* () {
                  yield* session.send(
                    HarnessInput.make({
                      clientInputId: attempted.episodeKey,
                      text: modelInput.rendered.text,
                    })
                  );
                  const terminalEventSequence = yield* recordNewTurn({
                    events,
                    expectedSessionId: sessionId,
                    intentSequence,
                    modelEpisodeKey: modelEpisode.start.episodeKey,
                    paths,
                    runId,
                    stream: session.events,
                  });
                  return yield* appendRepair(
                    runId,
                    paths,
                    FailureRepairTurnCompleted.make({
                      ...repairBinding(attempted),
                      state: "turnCompleted",
                      terminalEventSequence,
                    })
                  );
                }).pipe(
                  Effect.catch(() =>
                    appendRepair(
                      runId,
                      paths,
                      FailureRepairOutcomeUnknown.make({
                        ...repairBinding(attempted),
                        code: "RepairTurnOutcomeUnknown",
                        message:
                          "The repair transport has no exact durable completed terminal and will not be redispatched.",
                        state: "outcomeUnknown",
                        terminalPolicy: failureOutcomeUnknownPolicyV1,
                      })
                    )
                  )
                ),
            })
          ),
      })
    )
  );
}

function reconcileAttemptedRepair(
  runId: RunId,
  paths: RunPaths,
  attempted: FailureRepairDispatchAttempted
) {
  return Effect.gen(function* () {
    const events = yield* readEvents(paths);
    const attemptedSequence = repairStateSequence(
      events,
      attempted,
      "dispatchAttempted"
    );
    if (attemptedSequence === undefined)
      return yield* appendRepair(
        runId,
        paths,
        FailureRepairOutcomeUnknown.make({
          ...repairBinding(attempted),
          code: "RepairTurnOutcomeUnknown",
          message:
            "A prior repair attempt has no authoritative intent and will not be redispatched.",
          state: "outcomeUnknown",
          terminalPolicy: failureOutcomeUnknownPolicyV1,
        })
      );
    const existingTurns = new Set(
      events
        .filter(
          (event) =>
            event.sequence < attemptedSequence &&
            event.type === "HARNESS_SESSION_EVENT_RECORDED"
        )
        .flatMap((event) => {
          const harnessEvent = parseHarnessEvent(event.payload["event"]);
          return "turnId" in harnessEvent ? [harnessEvent.turnId] : [];
        })
    );
    const postDispatchStarts = new Set(
      events.flatMap((event) => {
        if (
          event.sequence <= attemptedSequence ||
          event.type !== "HARNESS_SESSION_EVENT_RECORDED"
        )
          return [];
        const harnessEvent = parseHarnessEvent(event.payload["event"]);
        const observationValue = event.payload["modelInvocationObservation"];
        const observation =
          observationValue === undefined
            ? undefined
            : parseModelInvocationObservation(observationValue);
        return harnessEvent.kind === "turnStarted" &&
          harnessEvent.sessionId ===
            parseHarnessSessionId(`session-${runId}`) &&
          observation?.kind === "offered" &&
          observation.episodeKey === attempted.episodeKey
          ? [harnessEvent.turnId]
          : [];
      })
    );
    const terminals = events.flatMap((event) => {
      if (
        event.sequence <= attemptedSequence ||
        event.type !== "HARNESS_SESSION_EVENT_RECORDED"
      )
        return [];
      const harnessEvent = parseHarnessEvent(event.payload["event"]);
      return harnessEvent.kind === "turnCompleted" &&
        harnessEvent.status === "completed" &&
        harnessEvent.sessionId === parseHarnessSessionId(`session-${runId}`) &&
        postDispatchStarts.has(harnessEvent.turnId) &&
        !existingTurns.has(harnessEvent.turnId)
        ? [event.sequence]
        : [];
    });
    return terminals.length === 1
      ? yield* appendRepair(
          runId,
          paths,
          FailureRepairTurnCompleted.make({
            ...repairBinding(attempted),
            state: "turnCompleted",
            terminalEventSequence: parseRunEventSequence(terminals[0]!),
          })
        )
      : yield* appendRepair(
          runId,
          paths,
          FailureRepairOutcomeUnknown.make({
            ...repairBinding(attempted),
            code: "RepairTurnOutcomeUnknown",
            message:
              "A prior repair attempt has no single durable completed terminal and will not be redispatched.",
            state: "outcomeUnknown",
            terminalPolicy: failureOutcomeUnknownPolicyV1,
          })
        );
  });
}

function verifyRepair(
  runId: RunId,
  paths: RunPaths,
  completed: FailureRepairTurnCompleted,
  options: FailureRepairCoordinatorOptions
) {
  return Effect.gen(function* () {
    yield* appendEvent(runId, paths, { type: "VERIFICATION_STARTED" });
    const reverify =
      options.reverify ??
      ((input: Parameters<FailureRepairReverify>[0]) =>
        recordRunProofResult(input.runId, input.paths, {
          ...(options.verificationServices === undefined
            ? {}
            : { verificationServices: options.verificationServices }),
        }));
    const exit = yield* Effect.exit(
      reverify({ digest: completed.digest, paths, runId })
    );
    if (exit._tag === "Failure")
      return yield* recordFailed(
        runId,
        paths,
        completed,
        "RepairVerificationUnavailable",
        "Fresh exact-claim verification could not be recorded."
      );
    const proof = exit.value;
    const events = yield* readEvents(paths);
    const proofEvent = events[proof.recordedBy.sequence - 1];
    const fresh =
      proofEvent?.type === "RUN_PROOF_RESULT_RECORDED" &&
      proof.recordedBy.sequence > completed.terminalEventSequence
        ? parseAnyRunProofResultEnvelope(proofEvent.payload["result"])
        : undefined;
    const failedRef = completed.digest.failedRef;
    const result =
      fresh?.version === 2 && failedRef.kind === "claim"
        ? fresh.results.find(({ claimId }) => claimId === failedRef.claimId)
        : undefined;
    if (result?.status === "passed")
      return yield* appendRepair(
        runId,
        paths,
        FailureRepairVerified.make({
          ...repairBinding(completed),
          proofResultSequence: fresh!.recordedBy.sequence,
          state: "verified",
        })
      );
    if (result?.status === "failed")
      return yield* recordFailed(
        runId,
        paths,
        completed,
        "RepairVerificationFailed",
        "The exact claim still failed after the bounded repair.",
        fresh!.recordedBy.sequence
      );
    return yield* recordFailed(
      runId,
      paths,
      completed,
      "RepairVerificationInconclusive",
      "Fresh exact-claim verification was inconclusive."
    );
  });
}

function recordNewTurn(input: {
  readonly events: ReadonlyArray<RunEvent>;
  readonly expectedSessionId: ReturnType<typeof parseHarnessSessionId>;
  readonly intentSequence: number;
  readonly modelEpisodeKey?: string;
  readonly paths: RunPaths;
  readonly runId: RunId;
  readonly stream: Stream.Stream<HarnessEvent, unknown>;
}) {
  const existingHarness = input.events.flatMap((event) =>
    event.type === "HARNESS_SESSION_EVENT_RECORDED"
      ? [
          {
            event: parseHarnessEvent(event.payload["event"]),
            sequence: event.sequence,
          },
        ]
      : []
  );
  const existingTurns = new Set(
    existingHarness.flatMap(({ event }) =>
      "turnId" in event ? [event.turnId] : []
    )
  );
  const persisted = existingHarness.filter(
    ({ sequence }) => sequence > input.intentSequence
  );
  const persistedKeys = new Set(
    persisted.map(({ event }) => harnessEventKey(event))
  );
  let recoveredRecorded = persisted.some(
    ({ event }) => event.kind === "sessionRecovered"
  );
  let offeredRecorded = input.events.some((event) => {
    const value = event.payload["modelInvocationObservation"];
    return (
      typeof value === "object" &&
      value !== null &&
      "episodeKey" in value &&
      value.episodeKey === input.modelEpisodeKey &&
      "kind" in value &&
      value.kind === "offered"
    );
  });
  let activeTurn: string | undefined;
  let terminal:
    | { readonly sequence: number; readonly status: string }
    | undefined;
  return Effect.gen(function* () {
    yield* Stream.runForEachWhile(input.stream, (event) =>
      Effect.gen(function* () {
        if (event.sessionId !== input.expectedSessionId)
          return yield* Effect.fail(sessionTurnConflict());
        if (event.kind === "sessionStarted") return true;
        if (event.kind === "sessionRecovered") {
          if (!recoveredRecorded) {
            yield* appendHarnessSessionEvent(input.runId, input.paths, event);
            recoveredRecorded = true;
          }
          return true;
        }
        if (event.kind === "turnStarted") {
          if (existingTurns.has(event.turnId)) return true;
          if (activeTurn !== undefined && activeTurn !== event.turnId)
            return yield* Effect.fail(sessionTurnConflict());
          activeTurn = event.turnId;
          const observation =
            input.modelEpisodeKey === undefined || offeredRecorded
              ? undefined
              : ModelInvocationObservationV1.make({
                  episodeKey: input.modelEpisodeKey,
                  kind: "offered",
                  source: "codexAppServerTransport",
                  trust: "high",
                  version: 1,
                });
          yield* appendHarnessSessionEvent(
            input.runId,
            input.paths,
            event,
            undefined,
            observation
          );
          if (observation !== undefined) offeredRecorded = true;
          return true;
        }
        if (activeTurn === undefined) return true;
        const turnId = "turnId" in event ? event.turnId : undefined;
        if (turnId !== undefined && turnId !== activeTurn) return true;
        if (persistedKeys.has(harnessEventKey(event))) return true;
        const appended = yield* appendHarnessSessionEvent(
          input.runId,
          input.paths,
          event
        );
        if (event.kind === "turnCompleted" && event.turnId === activeTurn) {
          terminal = {
            sequence: appended.event.sequence,
            status: event.status,
          };
          return false;
        }
        return true;
      })
    );
    if (terminal?.status !== "completed")
      return yield* Effect.fail(sessionTurnConflict());
    return parseRunEventSequence(terminal.sequence);
  });
}

function exhaustRepair(
  runId: RunId,
  paths: RunPaths,
  failed: FailureRepairFailed
) {
  return appendRepair(
    runId,
    paths,
    FailureRepairExhausted.make({
      ...repairBinding(failed),
      state: "exhausted",
    })
  );
}

function appendRepair<A extends FailureRepairReceipt>(
  runId: RunId,
  paths: RunPaths,
  repair: A
) {
  return appendEvent(runId, paths, {
    payload: {
      failureRepair: encodeFailureRepairReceiptJson(repair),
    },
    type: "FAILURE_REPAIR_RECORDED",
  }).pipe(Effect.as(repair));
}

function recordFailed(
  runId: RunId,
  paths: RunPaths,
  repair: FailureRepairReceipt,
  code: string,
  message: string,
  proofResultSequence?: number
) {
  return appendRepair(
    runId,
    paths,
    FailureRepairFailed.make({
      ...repairBinding(repair),
      code,
      message,
      ...(proofResultSequence === undefined
        ? {}
        : {
            proofResultSequence: parseRunEventSequence(proofResultSequence),
          }),
      state: "failed",
    })
  );
}

function repairBinding(repair: FailureRepairReceipt) {
  return {
    digest: repair.digest,
    episodeKey: repair.episodeKey,
    failedProofResultSequence: repair.failedProofResultSequence,
    runId: repair.runId,
  };
}

function latestRepair(events: ReadonlyArray<RunEvent>) {
  const event = events.findLast(
    ({ type }) => type === "FAILURE_REPAIR_RECORDED"
  );
  return event === undefined
    ? undefined
    : parseFailureRepairReceipt(event.payload["failureRepair"]);
}

function latestAuthoritativeV2Proof(events: ReadonlyArray<RunEvent>) {
  const event = events.findLast(
    ({ type }) => type === "RUN_PROOF_RESULT_RECORDED"
  );
  if (event === undefined) return undefined;
  const proof = parseAnyRunProofResultEnvelope(event.payload["result"]);
  return proof.version === 2 ? proof : undefined;
}

function repairStateSequence(
  events: ReadonlyArray<RunEvent>,
  repair: FailureRepairReceipt,
  state: FailureRepairReceipt["state"]
) {
  return events
    .flatMap((event) =>
      event.type === "FAILURE_REPAIR_RECORDED"
        ? [
            {
              event,
              repair: parseFailureRepairReceipt(event.payload["failureRepair"]),
            },
          ]
        : []
    )
    .find(
      (entry) =>
        entry.repair.episodeKey === repair.episodeKey &&
        entry.repair.state === state
    )?.event.sequence;
}

function acceptedExecution(event: RunEvent) {
  const value = Schema.decodeUnknownSync(
    Schema.Record(Schema.String, Schema.Json)
  )(event.payload["execution"]);
  return {
    resolved: Schema.decodeUnknownSync(ResolvedHarnessExecution)(
      value["resolved"]
    ),
    selection: Schema.decodeUnknownSync(HarnessExecutionSelection)(
      value["selection"]
    ),
  };
}

export function makeFailureRepairTaskInput(repair: FailureRepairReceipt) {
  const failed = repair.digest.failedRef;
  return [
    "Continue the same Gaia implementation session and repair only the exact failed verification claim.",
    "Do not publish, deploy, mutate external providers, broaden scope, or change unrelated files.",
    `Failure: ${repair.digest.safeSummary}`,
    `Stage: ${repair.digest.stage}.`,
    `Attempt: ${repair.digest.attempt}/${repair.digest.maxAttempts}.`,
    `Failed ${failed.kind}: ${failed.kind === "claim" ? failed.claimId : failed.actionId}.`,
    ...repair.digest.evidenceRefs.flatMap(renderFailureEvidenceV1),
    "Run focused verification for the repaired behavior and stop.",
  ].join("\n");
}

function isTerminal(repair: FailureRepairReceipt) {
  return (
    repair.state === "verified" ||
    repair.state === "superseded" ||
    repair.state === "outcomeUnknown" ||
    repair.state === "exhausted" ||
    (repair.state === "failed" && repair.proofResultSequence === undefined)
  );
}

function harnessEventKey(event: HarnessEvent) {
  return JSON.stringify(Schema.encodeSync(HarnessEventSchema)(event));
}

function repairError(code: string, message: string) {
  return makeRuntimeError({
    code,
    message,
    recoverable: false,
  });
}

function sessionUnavailable() {
  return repairError(
    "RepairSessionUnavailable",
    "The accepted provider session could not be resumed."
  );
}

function sessionTurnConflict() {
  return repairError(
    "RepairTurnOutcomeUnknown",
    "The resumed repair turn has no single completed terminal."
  );
}
