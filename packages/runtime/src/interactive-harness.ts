import nodePath from "node:path";

import {
  HarnessEnvironmentReceiptArtifactRefV1,
  HarnessEnvironmentReceiptV1,
  HarnessLaunchObservationV1,
  ModelContextManifestV1,
  ModelInvocationEpisodeStartV1,
  ModelInvocationManifestV1,
  ModelWorkspaceBindingV1,
  ResolvedHarnessExecution,
  StructuralDigestSchema,
  digestHarnessEnvironmentContract,
  makeHarnessEnvironmentReceiptV1,
  parseHarnessEnvironmentReceiptV1,
  parseHarnessEvent,
  parseHarnessSessionId,
  parseWorkerContinuationReceipt,
  parseWorkerCorrelationReconciliationReceipt,
  parseWorkerRecoveryReceipt,
  parseWorkspaceRelativePath,
  type HarnessEvent,
  type RunEvent,
  type RunId,
  type RunContractV1,
  type RunContractV2,
} from "@gaia/core";
import {
  Clock,
  Effect,
  FileSystem,
  Option,
  Path,
  Random,
  Schema,
  Stream,
} from "effect";

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
  loadModelInvocationPair,
  verifyModelAdapterCwd,
} from "./model-invocation.js";
import {
  makeRunPaths,
  parseRunStorageRootInput,
  RunStorageRootInputSchema,
  type RunPaths,
  type RunStorageRootInput,
  type RuntimePath,
} from "./paths.js";
import { loadRunContract } from "./run-contract.js";
import { parseWorkerPlanJson } from "./worker-plan.js";
import type { HarnessLaunchObservationService } from "./worker-runtime-environment.js";
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
  readonly launchObservation?: HarnessLaunchObservationService["Service"];
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
        const acceptedExecution = acceptedEnvironmentExecution(existing);

        // An environment-assigned epoch may have crashed after persisting a
        // terminal session event but before WORKER_COMPLETED. It must obtain a
        // fresh provider result before any candidate can become authoritative.
        let terminal =
          acceptedExecution?.environmentAssignment === undefined
            ? existingTerminal
            : undefined;
        if (terminal === undefined) {
          const sessionStarted = fullHistory.some(
            (event) => event.kind === "sessionStarted"
          );
          if (!sessionStarted) {
            if (request.modelWorkspaceBinding !== undefined)
              yield* verifyModelAdapterCwd(
                request.workspacePath,
                request.modelWorkspaceBinding
              );
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
              const observesLaunch =
                acceptedExecution?.environmentAssignment !== undefined;
              const launchObservation = input.launchObservation;
              if (observesLaunch) {
                if (launchObservation === undefined)
                  return yield* Effect.fail(
                    environmentEvidenceError(
                      "Harness launch observation service is unavailable."
                    )
                  );
                yield* Effect.acquireRelease(
                  launchObservation
                    .open(sessionId)
                    .pipe(Effect.mapError(() => environmentEvidenceError())),
                  () => launchObservation.release(sessionId)
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
                      input: HarnessInput.make({
                        text:
                          request.modelRenderedInput?.text ?? request.specBody,
                      }),
                      sessionId,
                      workspacePath: workspacePathFromRoot(
                        rootDirectory,
                        request.workspacePath
                      ),
                    },
                    requiredCapabilities:
                      issueDeliveryWorkerHarnessCapabilities,
                  });
              if (observesLaunch) {
                if (launchObservation === undefined)
                  return yield* Effect.fail(environmentEvidenceError());
                const observation = yield* launchObservation
                  .take(sessionId)
                  .pipe(Effect.mapError(() => environmentEvidenceError()));
                if (acceptedExecution === undefined)
                  return yield* Effect.fail(environmentEvidenceError());
                yield* commitHarnessEnvironmentCandidate({
                  events: existing,
                  observation,
                  paths,
                  resolvedExecution: acceptedExecution,
                  runId: request.runId,
                });
              }
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

const decodeModelInvocationEpisodeStart = Schema.decodeUnknownSync(
  ModelInvocationEpisodeStartV1
);
const encodeHarnessEnvironmentReceipt = Schema.encodeSync(
  Schema.toCodecJson(HarnessEnvironmentReceiptV1)
);
const encodeHarnessEnvironmentReceiptRef = Schema.encodeSync(
  Schema.toCodecJson(HarnessEnvironmentReceiptArtifactRefV1)
);
const decodeHarnessEnvironmentReceiptRef = Schema.decodeUnknownSync(
  HarnessEnvironmentReceiptArtifactRefV1
);

/** Stable WorkerPlan semantics with per-run identity removed. */
export function digestWorkerPlanEnvironmentSemantics(body: string) {
  const { runId: _runId, ...semantic } = parseWorkerPlanJson(JSON.parse(body));
  return digestHarnessEnvironmentContract(
    "gaia.harness-environment.worker-plan.v1",
    [semantic]
  );
}

/** Stable run-contract semantics while preserving full receipt integrity. */
export function digestRunContractEnvironmentSemantics(
  contract: RunContractV1 | RunContractV2
) {
  const {
    contractDigest: _contractDigest,
    contractId: _contractId,
    runId: _runId,
    ...semantic
  } = contract;
  return digestHarnessEnvironmentContract(
    "gaia.harness-environment.run-contract-semantic.v1",
    [semantic]
  );
}

/** Run-invariant semantic identity for GAIA-146 invocation evidence. */
const ModelInvocationEnvironmentSemanticsInputSchema = Schema.Struct({
  context: ModelContextManifestV1,
  invocation: ModelInvocationManifestV1,
  runContractSemanticDigest: StructuralDigestSchema,
  workspaceBinding: ModelWorkspaceBindingV1,
});
type ModelInvocationEnvironmentSemanticsInput =
  typeof ModelInvocationEnvironmentSemanticsInputSchema.Type;

export function digestModelInvocationEnvironmentSemantics(
  input: ModelInvocationEnvironmentSemanticsInput
) {
  return digestHarnessEnvironmentContract(
    "gaia.harness-environment.model-invocation-semantic.v1",
    [
      {
        acceptedProviderCapabilityObservation:
          input.invocation.payload.acceptedProviderCapabilityObservation,
        adapterInputClass: input.invocation.payload.adapterInputClass,
        adapterSemantics: input.invocation.payload.adapterSemantics,
        authorityRef: input.invocation.payload.authorityRef,
        contextAuthorityKinds: input.context.payload.authoritativeRefs
          .map(({ kind }) => kind)
          .toSorted(),
        budget: input.invocation.payload.budget,
        contextContentDigest: input.context.payload.contextContentDigest,
        outputContract: input.invocation.payload.outputContract,
        runContractSemanticDigest: input.runContractSemanticDigest,
        template: input.invocation.payload.template,
        version: input.invocation.payload.version,
        workspaceBinding: {
          canonicalRunStoreRootDigest:
            input.workspaceBinding.canonicalRunStoreRootDigest,
          shape: input.workspaceBinding.shape,
          version: input.workspaceBinding.version,
          workspaceRole: input.workspaceBinding.workspaceRole,
        },
      },
    ]
  );
}

function acceptedEnvironmentExecution(events: ReadonlyArray<RunEvent>) {
  const created = events[0];
  if (created?.type !== "RUN_CREATED") return undefined;
  const execution = created.payload["execution"];
  if (typeof execution !== "object" || execution === null) return undefined;
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(ResolvedHarnessExecution)(
      Reflect.get(execution, "resolved")
    )
  );
}

function environmentEvidenceError(
  message = "Harness environment evidence is unavailable."
) {
  return makeRuntimeError({
    code: "HarnessEnvironmentEvidenceUnavailable",
    message,
    recoverable: false,
  });
}

function writePrivateFileAtomically(target: string, body: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const suffix = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER);
    const temporary = `${target}.${suffix.toString(36)}.tmp`;
    yield* fs
      .writeFileString(temporary, body, { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.andThen(fs.rename(temporary, target)),
        Effect.onExit(() =>
          fs.remove(temporary).pipe(Effect.orElseSucceed(() => undefined))
        )
      );
  });
}

/** Read and fully validate an event-owned environment receipt. */
export function readHarnessEnvironmentReceipt(
  paths: RunPaths,
  events: ReadonlyArray<RunEvent>,
  refInput: unknown
) {
  return Effect.gen(function* () {
    const ref = yield* Effect.try({
      try: () => decodeHarnessEnvironmentReceiptRef(refInput),
      catch: () => environmentEvidenceError(),
    });
    if (ref.runId !== paths.runId)
      return yield* Effect.fail(environmentEvidenceError());
    const execution = acceptedEnvironmentExecution(events);
    if (execution?.environmentAssignment === undefined)
      return yield* Effect.fail(environmentEvidenceError());
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(paths.root, ref.path);
    const [canonicalDirectory, canonicalTarget, info] = yield* Effect.all([
      fs.realPath(paths.harnessEnvironmentDirectory),
      fs.realPath(target),
      fs.stat(target),
    ]).pipe(Effect.mapError(() => environmentEvidenceError()));
    if (
      canonicalTarget !==
        path.join(canonicalDirectory, path.basename(ref.path)) ||
      info.type !== "File" ||
      Number(info.size) !== ref.byteLength
    )
      return yield* Effect.fail(environmentEvidenceError());
    const body = yield* fs
      .readFileString(target)
      .pipe(Effect.mapError(() => environmentEvidenceError()));
    if (new TextEncoder().encode(body).byteLength !== ref.byteLength)
      return yield* Effect.fail(environmentEvidenceError());
    const receipt = yield* Effect.try({
      try: () => parseHarnessEnvironmentReceiptV1(JSON.parse(body)),
      catch: () => environmentEvidenceError(),
    });
    const matchesRecordedEpisode = events.some((event) => {
      if (event.type !== "WORKER_STARTED") return false;
      const episode = Option.getOrUndefined(
        Schema.decodeUnknownOption(ModelInvocationEpisodeStartV1)(
          event.payload["modelInvocationEpisode"]
        )
      );
      return (
        episode !== undefined &&
        receipt.modelInvocation.contextRef.path === episode.contextRef.path &&
        receipt.modelInvocation.invocationRef.path ===
          episode.invocationRef.path
      );
    });
    if (
      body !==
        `${JSON.stringify(encodeHarnessEnvironmentReceipt(receipt))}\n` ||
      receipt.runId !== paths.runId ||
      receipt.receiptDigest !== ref.receiptDigest ||
      receipt.structuralDigest !== ref.structuralDigest ||
      !matchesRecordedEpisode ||
      JSON.stringify(receipt.resolvedExecution) !== JSON.stringify(execution)
    )
      return yield* Effect.fail(environmentEvidenceError());
    return { receipt, ref } as const;
  });
}

/** Commit a non-authoritative receipt candidate after source-exact launch evidence. */
export function commitHarnessEnvironmentCandidate(input: {
  readonly events: ReadonlyArray<RunEvent>;
  readonly observation: HarnessLaunchObservationV1;
  readonly paths: RunPaths;
  readonly resolvedExecution: ResolvedHarnessExecution;
  readonly runId: RunId;
}) {
  return Effect.gen(function* () {
    const assignment = input.resolvedExecution.environmentAssignment;
    if (assignment === undefined)
      return yield* Effect.fail(environmentEvidenceError());
    const workerStart = [...input.events]
      .reverse()
      .find(({ type }) => type === "WORKER_STARTED");
    const episode = yield* Effect.try({
      try: () =>
        decodeModelInvocationEpisodeStart(
          workerStart?.payload["modelInvocationEpisode"]
        ),
      catch: () => environmentEvidenceError(),
    });
    const pair = yield* loadModelInvocationPair(input.paths, episode);
    const contract = yield* loadRunContract(input.paths, input.runId);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [runProfile, skillManifest, workerPlan] = yield* Effect.all([
      fs.readFileString(input.paths.runProfile),
      fs.readFileString(input.paths.skillManifest),
      fs.readFileString(input.paths.workerPlanResult),
    ]).pipe(Effect.mapError(() => environmentEvidenceError()));
    const workerPlanDigest = yield* Effect.try({
      try: () => digestWorkerPlanEnvironmentSemantics(workerPlan),
      catch: () => environmentEvidenceError(),
    });
    const runContractSemanticDigest =
      digestRunContractEnvironmentSemantics(contract);
    const invocationSemanticDigest = digestModelInvocationEnvironmentSemantics({
      context: pair.context,
      invocation: pair.invocation,
      runContractSemanticDigest,
      workspaceBinding: pair.workspaceBinding,
    });
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    const receipt = yield* Effect.try({
      try: () =>
        makeHarnessEnvironmentReceiptV1({
          modelInvocation: {
            adapterSemanticDigest:
              pair.invocation.payload.adapterSemantics.semanticDigest,
            contextContentDigest: pair.context.payload.contextContentDigest,
            contextDigest: pair.context.contextDigest,
            contextRef: episode.contextRef,
            invocationDigest: pair.invocation.invocationDigest,
            invocationSemanticDigest,
            invocationRef: episode.invocationRef,
            outputContractId: pair.invocation.payload.outputContract.id,
            outputContractVersion:
              pair.invocation.payload.outputContract.version,
            renderedInputDigest: pair.rendered.renderedInputDigest,
            workspaceBinding: pair.workspaceBinding,
          },
          observation: input.observation,
          recordedAt,
          resolvedExecution: {
            ...input.resolvedExecution,
            environmentAssignment: assignment,
          },
          runContract: {
            baseDigest: contract.baseDigest,
            contractDigest: contract.contractDigest,
            semanticDigest: runContractSemanticDigest,
            targetDigest: contract.targetDigest,
          },
          runId: input.runId,
          runProfileDigest: digestHarnessEnvironmentContract(
            "gaia.harness-environment.run-profile.v1",
            [runProfile]
          ),
          skillManifestDigest: digestHarnessEnvironmentContract(
            "gaia.harness-environment.skill-manifest.v1",
            [skillManifest]
          ),
          version: 1,
          workerPlanDigest,
        }),
      catch: () => environmentEvidenceError(),
    });
    const body = `${JSON.stringify(encodeHarnessEnvironmentReceipt(receipt))}\n`;
    const relativePath = `harness-environment/receipt-${receipt.receiptDigest}.json`;
    const ref = HarnessEnvironmentReceiptArtifactRefV1.make({
      byteLength: new TextEncoder().encode(body).byteLength,
      path: relativePath,
      receiptDigest: receipt.receiptDigest,
      runId: input.runId,
      structuralDigest: receipt.structuralDigest,
      version: 1,
    });
    const authoritativeRefInput = [...input.events]
      .reverse()
      .find(
        ({ type, payload }) =>
          type === "WORKER_COMPLETED" &&
          payload["harnessEnvironmentReceipt"] !== undefined
      )?.payload["harnessEnvironmentReceipt"];
    const authoritative =
      authoritativeRefInput === undefined
        ? undefined
        : yield* readHarnessEnvironmentReceipt(
            input.paths,
            input.events,
            authoritativeRefInput
          );
    if (
      authoritative !== undefined &&
      authoritative.receipt.structuralDigest !== receipt.structuralDigest
    )
      return yield* Effect.fail(
        environmentEvidenceError(
          "Harness environment evidence changed after authoritative completion."
        )
      );
    const committedRef = authoritative?.ref ?? ref;
    yield* fs.makeDirectory(input.paths.harnessEnvironmentDirectory, {
      mode: 0o700,
      recursive: true,
    });
    if (authoritative === undefined)
      yield* writePrivateFileAtomically(
        path.join(input.paths.root, relativePath),
        body
      );
    yield* writePrivateFileAtomically(
      input.paths.harnessEnvironmentCandidate,
      `${JSON.stringify(encodeHarnessEnvironmentReceiptRef(committedRef))}\n`
    );
    return committedRef;
  }).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.fail(environmentEvidenceError())
    )
  );
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
