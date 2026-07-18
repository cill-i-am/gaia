import nodePath from "node:path";

import {
  parseHarnessEvent,
  parseHarnessSessionId,
  parseWorkerContinuationReceipt,
  parseWorkerCorrelationReconciliationReceipt,
  parseWorkerRecoveryReceipt,
  parseWorkspaceRelativePath,
  type HarnessEvent,
  type RunEvent,
  type RunId,
} from "@gaia/core";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";

import type { LiveHarnessSessionCoordinator } from "./agent-session-runtime.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import { appendHarnessSessionEvent, readEvents } from "./event-store.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import { issueDeliveryWorkerHarnessCapabilities } from "./harness-provider-registry.js";
import {
  HarnessInput,
  HarnessResumeError,
  resumeHarnessSession,
  startHarnessSession,
  type HarnessProvider,
  type HarnessCheckpointToken,
} from "./harness-session.js";
import {
  codexAppServerHarnessName,
  HarnessRunResult,
  type GaiaHarness,
} from "./harness.js";
import {
  makeRunPaths,
  parseRunStorageRootInput,
  RunStorageRootInputSchema,
  type RunPaths,
  type RunStorageRootInput,
  type RuntimePath,
} from "./paths.js";
import {
  diffWorkspaceSnapshots,
  readWorkspaceSnapshot,
  snapshotWorkspace,
  writeWorkspaceSnapshot,
} from "./workspace-snapshot.js";

const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const encodeHarnessRunResult = Schema.encodeSync(HarnessRunResultJson);

/** Adapt one provider-neutral interactive session into the existing worker stage. */
export function interactiveSessionHarness(input: {
  readonly expectedCheckpoint?: HarnessCheckpointToken;
  readonly sessionCoordinator?: LiveHarnessSessionCoordinator;
  readonly provider?: HarnessProvider;
  readonly rootDirectory: typeof RunStorageRootInputSchema.Encoded;
}): GaiaHarness {
  const rootDirectory = parseRunStorageRootInput(input.rootDirectory);
  return {
    name: codexAppServerHarnessName,
    run: (request) =>
      Effect.gen(function* () {
        const paths = yield* makeRunPaths(request.runId, {
          rootDirectory,
        });
        const existing = yield* readEvents(paths);
        const sessionId = parseHarnessSessionId(`session-${request.runId}`);
        const fullHistory = harnessHistory(existing, sessionId);
        const recoverySequence = latestRecoveryCheckpointSequence(existing);
        const continuationEpochSequence =
          latestWorkerContinuationEpochSequence(existing);
        const correlationEpochSequence =
          latestWorkerCorrelationEpochSequence(existing);
        const historyStartSequence = Math.max(
          recoverySequence ?? 0,
          continuationEpochSequence ?? 0,
          correlationEpochSequence ?? 0
        );
        const history =
          historyStartSequence === 0
            ? fullHistory
            : harnessHistory(
                existing.filter(
                  ({ sequence }) => sequence > historyStartSequence
                ),
                sessionId
              );
        const existingTerminal = terminalSessionEvent(history);

        let terminal = existingTerminal;
        if (terminal === undefined) {
          const sessionStarted = fullHistory.some(
            (event) => event.kind === "sessionStarted"
          );
          if (!sessionStarted) {
            const baseline = yield* snapshotWorkspace(request.workspacePath);
            yield* writeWorkspaceSnapshot(
              paths.harnessWorkspaceBaseline,
              baseline
            );
          }
          terminal = yield* Effect.scoped(
            Effect.gen(function* () {
              const provider = input.provider;
              if (provider === undefined) {
                return yield* Effect.fail(
                  makeRuntimeError({
                    code: "HarnessProviderUnavailable",
                    message:
                      "Harness provider is unavailable for a non-terminal session.",
                    recoverable: false,
                  })
                );
              }
              const session = sessionStarted
                ? yield* resumeHarnessSession({
                    provider,
                    request: {
                      ...(input.expectedCheckpoint === undefined
                        ? {}
                        : { expectedCheckpoint: input.expectedCheckpoint }),
                      sessionId,
                      workspacePath: workspacePathFromRoot(
                        rootDirectory,
                        request.workspacePath
                      ),
                    },
                    requiredCapabilities:
                      issueDeliveryWorkerHarnessCapabilities,
                  })
                : yield* startHarnessSession({
                    provider,
                    request: {
                      input: HarnessInput.make({ text: request.specBody }),
                      sessionId,
                      workspacePath: workspacePathFromRoot(
                        rootDirectory,
                        request.workspacePath
                      ),
                    },
                    requiredCapabilities:
                      issueDeliveryWorkerHarnessCapabilities,
                  });
              if (input.sessionCoordinator !== undefined) {
                yield* input.sessionCoordinator.register({
                  agentId: issueDeliveryAgentIds.worker,
                  runId: request.runId,
                  session,
                  sessionId,
                });
              }
              const last = yield* session.events.pipe(
                Stream.tap((event) =>
                  appendHarnessSessionEvent(request.runId, paths, event)
                ),
                Stream.takeUntil(shouldStopLiveSessionStream),
                Stream.runLast
              );
              if (Option.isNone(last) || !isTerminalSessionEvent(last.value)) {
                return yield* Effect.fail(
                  makeRuntimeError({
                    code: "HarnessSessionInterrupted",
                    message:
                      "Harness session ended before a terminal worker turn.",
                    recoverable: true,
                  })
                );
              }
              return last.value;
            })
          );
        }

        if (terminal.kind === "sessionFailed") {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "HarnessSessionFailed",
              message: harnessFailureMessage(terminal.failure),
              recoverable:
                terminal.failure.kind === "providerFailure"
                  ? terminal.failure.recoverable
                  : false,
            })
          );
        }
        if (terminal.status !== "completed") {
          return yield* Effect.fail(
            makeRuntimeError({
              code:
                terminal.status === "interrupted"
                  ? "HarnessSessionInterrupted"
                  : "HarnessSessionFailed",
              message:
                terminal.status === "interrupted"
                  ? "Harness worker turn was interrupted."
                  : "Harness worker turn failed.",
              recoverable: terminal.status === "interrupted",
            })
          );
        }

        return yield* refreshInteractiveHarnessResult({
          paths,
          runId: request.runId,
          workerLogPath: request.workerLogPath,
          workerResultPath: request.workerResultPath,
          workspacePath: request.workspacePath,
        });
      }).pipe(
        Effect.mapError((error) =>
          error instanceof GaiaRuntimeError
            ? error
            : error instanceof HarnessResumeError
              ? makeRuntimeError({
                  code: "HarnessCorrelationUnavailable",
                  message:
                    "Harness session correlation is missing or corrupt for resume.",
                  recoverable: false,
                })
              : makeRuntimeError({
                  code: "HarnessSessionFailed",
                  message: "Interactive harness execution failed.",
                  recoverable: true,
                })
        )
      ),
  };
}

/** Refresh worker diff evidence after another turn in the same session. */
export function refreshInteractiveHarnessResult(input: {
  readonly paths: RunPaths;
  readonly runId: RunId;
  readonly workerLogPath: RuntimePath;
  readonly workerResultPath: RuntimePath;
  readonly workspacePath: RuntimePath;
}) {
  return Effect.gen(function* () {
    const baseline = yield* readWorkspaceSnapshot(
      input.paths.harnessWorkspaceBaseline
    ).pipe(
      Effect.mapError(() =>
        makeRuntimeError({
          code: "HarnessWorkspaceBaselineMissing",
          message: "Harness workspace baseline is unavailable for completion.",
          recoverable: false,
        })
      )
    );
    const after = yield* snapshotWorkspace(input.workspacePath);
    const workspaceDiff = diffWorkspaceSnapshots(baseline, after);
    const result = HarnessRunResult.make({
      changedWorkspacePaths: [
        ...workspaceDiff.productChangedPaths,
        ...workspaceDiff.omittedGeneratedPaths.map(({ path }) => path),
      ].toSorted(),
      exitCode: 0,
      harnessName: codexAppServerHarnessName,
      // Interactive provider file changes are delivery source, not generated
      // harness artifacts. Session file-change items already expose them for
      // inspection; marking them as artifacts would exclude them from publish.
      outputArtifacts: [],
      resultPath: "worker-result.json",
      runId: input.runId,
      status: "completed",
      summary: "Interactive harness worker turn completed.",
      workspaceDiff,
    });
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      input.workerResultPath,
      `${JSON.stringify(encodeHarnessRunResult(result), null, 2)}\n`
    );
    yield* fs.writeFileString(
      input.workerLogPath,
      "Interactive harness worker turn completed.\n",
      { flag: "a" }
    );
    return result;
  });
}

function harnessFailureMessage(
  failure: Extract<HarnessEvent, { readonly kind: "sessionFailed" }>["failure"]
) {
  return failure.kind === "capabilityMismatch"
    ? "Harness provider lacks required capabilities."
    : failure.message;
}

function harnessHistory(
  events: ReadonlyArray<RunEvent>,
  sessionId: ReturnType<typeof parseHarnessSessionId>
): ReadonlyArray<HarnessEvent> {
  return events.flatMap((event) => {
    if (event.type !== "HARNESS_SESSION_EVENT_RECORDED") return [];
    const harnessEvent = parseHarnessEvent(event.payload.event);
    return harnessEvent.sessionId === sessionId ? [harnessEvent] : [];
  });
}

function terminalSessionEvent(events: ReadonlyArray<HarnessEvent>) {
  return events.find(isTerminalSessionEvent);
}

function shouldStopLiveSessionStream(event: HarnessEvent) {
  if (event.kind === "turnCompleted") return true;
  if (event.kind !== "sessionFailed") return false;
  return (
    event.failure.kind !== "providerFailure" ||
    event.failure.recoverable !== true
  );
}

function isTerminalSessionEvent(
  event: HarnessEvent
): event is Extract<
  HarnessEvent,
  { readonly kind: "sessionFailed" | "turnCompleted" }
> {
  return event.kind === "turnCompleted" || event.kind === "sessionFailed";
}

function workspacePathFromRoot(
  rootDirectory: RunStorageRootInput,
  workspacePath: RuntimePath
) {
  const relative = nodePath.relative(rootDirectory, workspacePath);
  return parseWorkspaceRelativePath(relative);
}

function latestRecoveryCheckpointSequence(events: ReadonlyArray<RunEvent>) {
  return [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "WORKER_RECOVERY_RECORDED" &&
        parseWorkerRecoveryReceipt(event.payload["recovery"]).state ===
          "dispatchConfirmed"
    )?.sequence;
}

function latestWorkerContinuationEpochSequence(
  events: ReadonlyArray<RunEvent>
) {
  return [...events].reverse().flatMap((event) => {
    if (event.type !== "WORKER_CONTINUATION_RECORDED") return [];
    const continuation = parseWorkerContinuationReceipt(
      event.payload["continuation"]
    );
    return [continuation.workerEvidenceEpochSequence];
  })[0];
}

function latestWorkerCorrelationEpochSequence(events: ReadonlyArray<RunEvent>) {
  return [...events].reverse().flatMap((event) => {
    if (event.type !== "WORKER_CORRELATION_RECONCILIATION_RECORDED") return [];
    const reconciliation = parseWorkerCorrelationReconciliationReceipt(
      event.payload["reconciliation"]
    );
    return [reconciliation.workerEvidenceEpochSequence];
  })[0];
}
