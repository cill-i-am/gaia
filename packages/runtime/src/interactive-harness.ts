import {
  parseHarnessEvent,
  parseHarnessSessionId,
  parseWorkspaceRelativePath,
  type HarnessEvent,
  type RunEvent,
} from "@gaia/core";
import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import nodePath from "node:path";
import { appendHarnessSessionEvent, readEvents } from "./event-store.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import {
  codexAppServerHarnessName,
  HarnessRunResult,
  type GaiaHarness,
} from "./harness.js";
import {
  HarnessInput,
  HarnessResumeError,
  resumeHarnessSession,
  startHarnessSession,
  type HarnessProvider,
} from "./harness-session.js";
import type { LiveHarnessSessionCoordinator } from "./agent-session-runtime.js";
import { issueDeliveryAgentIds } from "./factory-workflows.js";
import { issueDeliveryWorkerHarnessCapabilities } from "./harness-provider-registry.js";
import { makeRunPaths } from "./paths.js";
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
  readonly sessionCoordinator?: LiveHarnessSessionCoordinator;
  readonly provider?: HarnessProvider;
  readonly rootDirectory: string;
}): GaiaHarness {
  return {
    name: codexAppServerHarnessName,
    run: (request) =>
      Effect.gen(function* () {
        const paths = yield* makeRunPaths(request.runId, {
          rootDirectory: input.rootDirectory,
        });
        const existing = yield* readEvents(paths);
        const sessionId = parseHarnessSessionId(`session-${request.runId}`);
        const history = harnessHistory(existing, sessionId);
        const existingTerminal = terminalSessionEvent(history);

        let terminal = existingTerminal;
        if (terminal === undefined) {
          const sessionStarted = history.some(
            (event) => event.kind === "sessionStarted",
          );
          if (!sessionStarted) {
            const baseline = yield* snapshotWorkspace(request.workspacePath);
            yield* writeWorkspaceSnapshot(
              paths.harnessWorkspaceBaseline,
              baseline,
            );
          }
          terminal = yield* Effect.scoped(
            Effect.gen(function* () {
              const provider = input.provider;
              if (provider === undefined) {
                return yield* Effect.fail(
                  makeRuntimeError({
                    code: "HarnessProviderUnavailable",
                    message: "Harness provider is unavailable for a non-terminal session.",
                    recoverable: false,
                  }),
                );
              }
              const session = sessionStarted
                ? yield* resumeHarnessSession({
                    provider,
                    request: {
                      sessionId,
                      workspacePath: workspacePathFromRoot(
                        input.rootDirectory,
                        request.workspacePath,
                      ),
                    },
                    requiredCapabilities: issueDeliveryWorkerHarnessCapabilities,
                  })
                : yield* startHarnessSession({
                    provider,
                    request: {
                      input: HarnessInput.make({ text: request.specBody }),
                      sessionId,
                      workspacePath: workspacePathFromRoot(
                        input.rootDirectory,
                        request.workspacePath,
                      ),
                    },
                    requiredCapabilities: issueDeliveryWorkerHarnessCapabilities,
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
                  appendHarnessSessionEvent(request.runId, paths, event),
                ),
                Stream.takeUntil(isTerminalSessionEvent),
                Stream.runLast,
              );
              if (Option.isNone(last) || !isTerminalSessionEvent(last.value)) {
                return yield* Effect.fail(
                  makeRuntimeError({
                    code: "HarnessSessionInterrupted",
                    message: "Harness session ended before a terminal worker turn.",
                    recoverable: true,
                  }),
                );
              }
              return last.value;
            }),
          );
        }

        if (terminal.kind === "sessionFailed") {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "HarnessSessionFailed",
              message: harnessFailureMessage(terminal.failure),
              recoverable: terminal.failure.kind === "providerFailure"
                ? terminal.failure.recoverable
                : false,
            }),
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
            }),
          );
        }

        const baseline = yield* readWorkspaceSnapshot(
          paths.harnessWorkspaceBaseline,
        ).pipe(
          Effect.mapError(() =>
            makeRuntimeError({
              code: "HarnessWorkspaceBaselineMissing",
              message: "Harness workspace baseline is unavailable for completion.",
              recoverable: false,
            }),
          ),
        );
        const after = yield* snapshotWorkspace(request.workspacePath);
        const workspaceDiff = diffWorkspaceSnapshots(baseline, after);
        const outputArtifacts = yield* existingWorkspaceArtifacts(
          request.workspacePath,
          workspaceDiff.productChangedPaths,
        );
        const result = HarnessRunResult.make({
          changedWorkspacePaths: [
            ...workspaceDiff.productChangedPaths,
            ...workspaceDiff.omittedGeneratedPaths.map(({ path }) => path),
          ].toSorted(),
          exitCode: 0,
          harnessName: codexAppServerHarnessName,
          outputArtifacts,
          resultPath: "worker-result.json",
          runId: request.runId,
          status: "completed",
          summary: "Interactive harness worker turn completed.",
          workspaceDiff,
        });
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          request.workerResultPath,
          `${JSON.stringify(encodeHarnessRunResult(result), null, 2)}\n`,
        );
        yield* fs.writeFileString(
          request.workerLogPath,
          "Interactive harness worker turn completed.\n",
          { flag: "a" },
        );
        return result;
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
              }),
        ),
      ),
  };
}

function harnessFailureMessage(
  failure: Extract<
    HarnessEvent,
    { readonly kind: "sessionFailed" }
  >["failure"],
) {
  return failure.kind === "capabilityMismatch"
    ? "Harness provider lacks required capabilities."
    : failure.message;
}

function harnessHistory(
  events: ReadonlyArray<RunEvent>,
  sessionId: ReturnType<typeof parseHarnessSessionId>,
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

function isTerminalSessionEvent(
  event: HarnessEvent,
): event is Extract<
  HarnessEvent,
  { readonly kind: "sessionFailed" | "turnCompleted" }
> {
  return event.kind === "turnCompleted" || event.kind === "sessionFailed";
}

function workspacePathFromRoot(rootDirectory: string, workspacePath: string) {
  const relative = nodePath.relative(rootDirectory, workspacePath);
  return parseWorkspaceRelativePath(relative);
}

function existingWorkspaceArtifacts(
  workspacePath: string,
  changedPaths: ReadonlyArray<string>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const artifacts: Array<string> = [];
    for (const changedPath of changedPaths) {
      if (yield* fs.exists(path.join(workspacePath, changedPath))) {
        artifacts.push(`workspace/${changedPath}`);
      }
    }
    return artifacts;
  });
}
