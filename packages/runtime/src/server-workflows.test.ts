import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import {
  canonicalV1,
  codexAppServerExecutionSelection,
  DeliveryBranchNamePublicSchema,
  DeliveryFeedbackTrustPolicyV1,
  DeliveryGitShaPublicSchema,
  DeliveryPublicationConfirmed,
  DeliveryRemoteNamePublicSchema,
  deriveExplicitSpecItemDigest,
  encodeAnyRunContractJson,
  encodeAnyRunProofResultJson,
  encodeFailureRepairReceiptJson,
  HarnessProfileIdSchema,
  HarnessSessionIdSchema,
  ModelInvocationEpisodeStartV1,
  ModelContextManifestV1,
  RunControlEventPayload,
  RunControlRestoreStateSchema,
  RunControlSnapshot,
  RunEvent,
  WorkerContinuationReceiptSchema,
  WorkerContinuationAction,
  WorkerCorrelationReconciliationReceiptSchema,
  WorkerCorrelationReconciliationAction,
  WorkerDesktopOriginCorrelationReceiptSchema,
  WorkerDesktopOriginCorrelationAction,
  WorkerRecoveryActionIdSchema,
  WorkerRecoveryDigestSchema,
  WorkerRecoveryModelIdSchema,
  encodeWorkerContinuationReceiptJson,
  encodeWorkerCorrelationReconciliationReceiptJson,
  encodeWorkerDesktopOriginCorrelationReceiptJson,
  encodeWorkerRecoveryReceiptJson,
  HarnessCapabilities,
  HarnessBaselineManifestRefV1,
  HarnessLaunchObservationV1,
  HarnessEnvironmentReceiptArtifactRefV1,
  digestHarnessEnvironmentContract,
  HarnessProviderDescriptor,
  FailureRepairIntent,
  FailureRepairDispatchAttempted,
  FailureRepairTurnCompleted,
  FailureRepairVerified,
  FactoryLessonReviewReceiptV1,
  makeFailureDigestV1,
  makeFactoryLessonCandidateV1,
  makeFactoryLessonReviewReceiptV1,
  makeNoRawTelemetryAttestationV1,
  makeProofEvidenceIdV2,
  makeRunEvent,
  makeRunContractV2,
  makeRunProofResultV2,
  makeVerificationCommandRequestDigest,
  ModelInvocationObservationV1,
  parseFailureRepairReceipt,
  makeRunControlActionBindingDigest,
  parseMergeDecisionV2,
  parseAnyRunContract,
  parseRunContract,
  parseRunControlAction,
  parseRunControlActionId,
  parseRunId,
  parseRunEventSequence,
  parseMarkdownSpec,
  parseRunProofResult,
  parseHarnessInteractionId,
  parseHarnessItemId,
  parseHarnessProfileId,
  parseHarnessProviderId,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseWorkspaceRelativePath,
  projectHarnessEvents,
  parseWorkerRecoveryActionId,
  parseWorkerRecoveryDigest,
  ResolvedHarnessExecution,
  ProofClaimResultV2Schema,
  snapshotFromReplay,
} from "@gaia/core";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { makeLiveHarnessSessionCoordinator } from "./agent-session-runtime.js";
import { parseBrowserEvidenceTargetUrl } from "./browser-evidence.js";
import {
  CodexTurnIdSchema,
  parseCodexTurnId,
} from "./codex-app-server-protocol.js";
import { makeCodexHarnessConfig } from "./codex-harness.js";
import { StagedDockerSandboxVerificationReceiptSchema } from "./docker-sandbox-verification-executor.js";
import { GaiaRuntimeError } from "./errors.js";
import {
  appendEvent,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import {
  DeliveryAcceptanceProvenancePolicyV1,
  prepareDeliveryWorktree,
  type GitDeliveryCommandInput,
} from "./git-delivery.js";
import {
  canonicalHarnessBaselineManifestBody,
  recordHarnessBaselineManifest,
} from "./harness-evaluation.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import {
  HarnessActionError,
  HarnessSessionError,
  parseHarnessCheckpointToken,
  type HarnessProvider,
  type HarnessSession,
} from "./harness-session.js";
import { makeProcessHarnessConfig } from "./harness.js";
import { commitHarnessEnvironmentCandidate } from "./interactive-harness.js";
import { recordMergeDecision } from "./merge-decision.js";
import { commitDerivedAppModelInvocationEpisode } from "./model-invocation.js";
import { makeRunPaths, parseRuntimePath, type RunPaths } from "./paths.js";
import {
  ReviewFinding,
  ReviewResult,
  ReviewerNameSchema,
  type GaiaReviewer,
} from "./reviewer.js";
import {
  dispatchRunControlAction,
  readRunControlSnapshot,
} from "./run-control-runtime.js";
import { localRunProfileSource } from "./run-profile.js";
import { readLocalRun, readLocalRunEvents } from "./run-read-api.js";
import {
  acceptFactoryRun,
  acceptPreparedFactoryRun,
  acceptServerRun,
  actOnDeliveryMerge,
  actOnWorkerDesktopOriginCorrelation,
  actOnWorkerCorrelationReconciliation,
  actOnWorkerContinuation,
  continuePreparedStrictV2HarnessRun,
  continueServerRun,
  prepareStrictV2HarnessRun,
  prepareFactoryRunAcceptance,
  reconcileInterruptedServerRuns,
  readWorkerEnvironmentEpochComparison,
} from "./server-workflows.js";
import { localSkillManifestSource } from "./skill-manifest.js";
import {
  testHarnessCapabilities,
  testHarnessProvider,
} from "./test-support.js";
import { readVerificationExecutionProfile } from "./verification-execution-profile.js";
import type { VerificationServices } from "./verifier.js";
import { digestWorkerPlanEnvironmentSemantics } from "./worker-plan.js";
import {
  HarnessLaunchObservationLive,
  HarnessLaunchObservationService,
} from "./worker-runtime-environment.js";
import { observeWorkspaceStructuralDigest } from "./workspace-snapshot.js";
import { localDirectoryWorkspaceSource } from "./workspace.js";

const WorkerContinuationEventPayloadSchema = Schema.Struct({
  continuation: WorkerContinuationReceiptSchema,
});
const WorkerCorrelationEventPayloadSchema = Schema.Struct({
  reconciliation: WorkerCorrelationReconciliationReceiptSchema,
});
const WorkerDesktopOriginEventPayloadSchema = Schema.Struct({
  desktopOriginCorrelation: WorkerDesktopOriginCorrelationReceiptSchema,
});
const decodeWorkerContinuationEventPayload = Schema.decodeUnknownSync(
  WorkerContinuationEventPayloadSchema
);
const decodeWorkerCorrelationEventPayload = Schema.decodeUnknownSync(
  WorkerCorrelationEventPayloadSchema
);
const decodeWorkerDesktopOriginEventPayload = Schema.decodeUnknownSync(
  WorkerDesktopOriginEventPayloadSchema
);

function appendWorkerCorrelationIntent(
  runId: ReturnType<typeof parseRunId>,
  paths: RunPaths,
  receipt: Parameters<
    typeof encodeWorkerCorrelationReconciliationReceiptJson
  >[0]
) {
  return Effect.gen(function* () {
    const events = yield* readEvents(paths);
    const episode = yield* commitDerivedAppModelInvocationEpisode({
      episodeKey: `workerCorrelation:${receipt.actionId}`,
      episodeRole: "workerCorrelation",
      events,
      paths,
      runId,
      taskInput:
        "Continue the interrupted worker recovery from the audited checkpoint. Do not restart the run, publish, merge, or change recovery policy.",
    });
    return yield* appendEvent(runId, paths, {
      payload: {
        reconciliation:
          encodeWorkerCorrelationReconciliationReceiptJson(receipt),
        ...(episode === undefined
          ? {}
          : {
              modelInvocationEpisode: Schema.encodeSync(
                ModelInvocationEpisodeStartV1
              )(episode),
            }),
      },
      type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
    });
  });
}

function removeModelInvocationProtocolMarker(paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lines = (yield* fs.readFileString(paths.events))
      .trimEnd()
      .split("\n");
    const first = JSON.parse(lines[0] ?? "null") as {
      payload?: Record<string, unknown>;
      type?: string;
    };
    if (first.type !== "RUN_CREATED" || first.payload === undefined) return;
    delete first.payload["modelInvocationProtocol"];
    lines[0] = JSON.stringify(first);
    yield* fs.writeFileString(paths.events, `${lines.join("\n")}\n`);
  });
}

function snapshotAuditedActionEvidence(paths: RunPaths) {
  const modelInvocations = existsSync(paths.modelInvocations)
    ? readdirSync(paths.modelInvocations, {
        encoding: "utf8",
        recursive: true,
        withFileTypes: true,
      })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const filePath = join(entry.parentPath, entry.name);
          return [
            filePath.slice(paths.modelInvocations.length + 1),
            readFileSync(filePath, "utf8"),
          ] as const;
        })
        .toSorted(([left], [right]) => left.localeCompare(right))
    : [];
  return {
    events: readFileSync(paths.events, "utf8"),
    modelInvocations,
  };
}

function snapshotStrictV2PreparationArtifacts(paths: RunPaths) {
  return [
    paths.runContract,
    paths.runProfile,
    paths.skillManifest,
    paths.workerPlanResult,
  ].map((path) => [path, readFileSync(path, "utf8")] as const);
}

function makeMarkerHarnessProviderRegistry(rootDirectory: string) {
  const recordMarker = (request: {
    readonly sessionId: string;
    readonly workspacePath: string;
  }) => {
    const runId = request.sessionId.slice("session-".length);
    const workspace = join(rootDirectory, request.workspacePath);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "output.txt"), `${runId}\n`);
  };
  const provider: HarnessProvider = {
    ...testHarnessProvider,
    createSession: (request) =>
      Effect.sync(() => recordMarker(request)).pipe(
        Effect.andThen(testHarnessProvider.createSession(request))
      ),
    resumeSession: (request) =>
      Effect.sync(() => recordMarker(request)).pipe(
        Effect.andThen(testHarnessProvider.resumeSession(request))
      ),
  };
  return makeHarnessProviderRegistry([
    {
      profileId: codexAppServerExecutionSelection.harnessProfileId,
      provider,
    },
  ]);
}

function makeFailureRepairHarnessProvider(rootDirectory: string) {
  let repairResumes = 0;
  let repairSends = 0;
  const makeSession = (
    sessionId: ReturnType<typeof parseHarnessSessionId>,
    turnId: ReturnType<typeof parseHarnessTurnId>,
    repair: boolean
  ): HarnessSession => {
    const harnessEvents = [
      {
        capabilities: testHarnessCapabilities,
        kind: "sessionStarted" as const,
        provider: testHarnessProvider.descriptor,
        sessionId,
        state: "running" as const,
      },
      ...(repair ? [{ kind: "sessionRecovered" as const, sessionId }] : []),
      { kind: "turnStarted" as const, sessionId, turnId },
      {
        kind: "turnCompleted" as const,
        sessionId,
        status: "completed" as const,
        turnId,
      },
    ];
    return {
      events: Stream.fromIterable(harnessEvents),
      interrupt: Option.some(Effect.void),
      resolveInteraction: () => Effect.void,
      send: () =>
        Effect.sync(() => {
          if (repair) repairSends += 1;
          return undefined;
        }),
      snapshot: Effect.succeed(projectHarnessEvents(harnessEvents, sessionId)),
      steer: Option.none(),
    };
  };
  const provider: HarnessProvider = {
    ...testHarnessProvider,
    createSession: ({ sessionId, workspacePath }) =>
      Effect.sync(() => {
        const workspace = join(rootDirectory, workspacePath);
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "output.txt"), `${sessionId}\n`);
        return makeSession(
          sessionId,
          parseHarnessTurnId("turn-failure-repair-initial"),
          false
        );
      }),
    resumeSession: ({ sessionId, workspacePath }) =>
      Effect.sync(() => {
        repairResumes += 1;
        const workspace = join(rootDirectory, workspacePath);
        mkdirSync(workspace, { recursive: true });
        writeFileSync(join(workspace, "output.txt"), `${sessionId}\n`);
        return makeSession(
          sessionId,
          parseHarnessTurnId(`turn-failure-repair-${repairResumes}`),
          true
        );
      }),
  };
  return {
    get repairResumes() {
      return repairResumes;
    },
    get repairSends() {
      return repairSends;
    },
    registry: makeHarnessProviderRegistry([
      {
        profileId: codexAppServerExecutionSelection.harnessProfileId,
        provider,
      },
    ]),
  };
}

describe("server workflows", () => {
  layer(NodeServices.layer)((it) => {
    it.effect(
      "projects only event-authoritative worker environment evidence and ignores an orphan candidate",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-worker-epoch-",
          });
          const runId = parseRunId("run-EpochProof");
          const paths = yield* makeRunPaths(runId, { rootDirectory });
          yield* fs.makeDirectory(paths.root, { recursive: true });
          const environmentAssignment = {
            adapter: {
              contractDigest: "a".repeat(64),
              contractId: "gaia.codex-app-server",
              contractVersion: "1",
              providerNativeToolInventoryObservation: "notExposed",
              toolContractDigest: "b".repeat(64),
            },
            authority: {
              approvalPolicy: "on-request",
              ephemeral: false,
              sandbox: "workspace-write",
              workspaceBindingDigest: digestHarnessEnvironmentContract(
                "gaia.worker-workspace-authority.v1",
                ["cill-i-am/gaia", ".gaia/runs/<runId>/workspace"]
              ),
            },
            effectDependencyEpoch: "4.0.0-beta.93",
            hostClass: "localGaiaServer",
            interfaceClass: "codexAppServerStdio",
            model: {
              id: "gpt-5.6-codex",
              provider: "openai",
              reasoningEffort: "high",
            },
            runtimeSource: {
              repositoryIdentity: "cill-i-am/gaia",
              revision: "6cc2350063cec02229fde3669af0f67a8cc3497a",
              sourceState: "clean",
            },
            version: 1,
          } as const;
          const execution = ResolvedHarnessExecution.make({
            capabilities: acceptanceCapabilities,
            environmentAssignment,
            executionMode: "local",
            harnessProfileId: codexAppServerExecutionSelection.harnessProfileId,
            provider: HarnessProviderDescriptor.make({
              displayName: "Codex App Server",
              executionModes: ["local"],
              providerId: parseHarnessProviderId("codex-app-server"),
            }),
            version: "0.144.5",
          });
          yield* appendEvent(runId, paths, {
            payload: {
              execution: {
                resolved: Schema.encodeSync(ResolvedHarnessExecution)(
                  execution
                ),
              },
              specPath: "spec.md",
            },
            type: "RUN_CREATED",
          });
          yield* fs.makeDirectory(paths.harnessEnvironmentDirectory, {
            recursive: true,
          });
          yield* fs.writeFileString(
            paths.harnessEnvironmentCandidate,
            '{"forged":"candidate"}\n'
          );

          const incomplete = yield* readWorkerEnvironmentEpochComparison(paths);
          assert.strictEqual(incomplete.state, "incomplete");
          assert.deepEqual(incomplete.limitations, [
            "authoritativeReceiptMissing",
          ]);

          const legacyRunId = parseRunId("run-EpochMiss1");
          const legacyPaths = yield* makeRunPaths(legacyRunId, {
            rootDirectory,
          });
          yield* fs.makeDirectory(legacyPaths.root, { recursive: true });
          yield* appendEvent(legacyRunId, legacyPaths, {
            payload: {
              execution: {
                resolved: Schema.encodeSync(ResolvedHarnessExecution)(
                  ResolvedHarnessExecution.make({
                    capabilities: acceptanceCapabilities,
                    executionMode: "local",
                    harnessProfileId:
                      codexAppServerExecutionSelection.harnessProfileId,
                    provider: HarnessProviderDescriptor.make({
                      displayName: "Historical Harness",
                      executionModes: ["local"],
                      providerId: parseHarnessProviderId("historical"),
                    }),
                    version: "historical-1",
                  })
                ),
              },
              specPath: "spec.md",
            },
            type: "RUN_CREATED",
          });
          const missing =
            yield* readWorkerEnvironmentEpochComparison(legacyPaths);
          assert.strictEqual(missing.state, "missing");
          assert.deepEqual(missing.limitations, [
            "acceptedEnvironmentAssignmentMissing",
          ]);
        })
    );

    it.effect(
      "projects complete, non-comparable, corrupt, and replay-stable worker epochs from event authority",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-worker-epoch-complete-",
          });
          const launchObservation = yield* HarnessLaunchObservationService;
          const observation = HarnessLaunchObservationV1.make({
            approvalPolicy: "on-request",
            cwdMatchesWorkspaceBinding: true,
            model: "gpt-5.6-codex",
            modelProvider: "openai",
            reasoningEffort: "high",
            sandbox: "workspace-write",
            source: "threadRuntimeResult",
          });
          const observe = (sessionId: typeof HarnessSessionIdSchema.Type) =>
            launchObservation
              .complete(sessionId, observation)
              .pipe(Effect.orDie);
          const recordMarker = (request: {
            readonly sessionId: string;
            readonly workspacePath: string;
          }) =>
            Effect.sync(() => {
              const workspace = join(rootDirectory, request.workspacePath);
              mkdirSync(workspace, { recursive: true });
              writeFileSync(
                join(workspace, "output.txt"),
                `${request.sessionId.slice("session-".length)}\n`
              );
            });
          let createCount = 0;
          let resumeCount = 0;
          const provider: HarnessProvider = {
            ...testHarnessProvider,
            createSession: (request) =>
              Effect.sync(() => {
                createCount += 1;
              }).pipe(
                Effect.andThen(observe(request.sessionId)),
                Effect.andThen(recordMarker(request)),
                Effect.andThen(testHarnessProvider.createSession(request))
              ),
            resumeSession: (request) =>
              Effect.sync(() => {
                resumeCount += 1;
              }).pipe(
                Effect.andThen(observe(request.sessionId)),
                Effect.andThen(recordMarker(request)),
                Effect.andThen(testHarnessProvider.resumeSession(request))
              ),
          };
          const environmentAssignment = {
            adapter: {
              contractDigest: "a".repeat(64),
              contractId: "gaia.codex-app-server",
              contractVersion: "1",
              providerNativeToolInventoryObservation: "notExposed",
              toolContractDigest: "b".repeat(64),
            },
            authority: {
              approvalPolicy: "on-request",
              ephemeral: false,
              sandbox: "workspace-write",
              workspaceBindingDigest: digestHarnessEnvironmentContract(
                "gaia.worker-workspace-authority.v1",
                ["cill-i-am/gaia", ".gaia/runs/<runId>/workspace"]
              ),
            },
            effectDependencyEpoch: "4.0.0-beta.93",
            hostClass: "localGaiaServer",
            interfaceClass: "codexAppServerStdio",
            model: {
              id: "gpt-5.6-codex",
              provider: "openai",
              reasoningEffort: "high",
            },
            runtimeSource: {
              repositoryIdentity: "cill-i-am/gaia",
              revision: "6cc2350063cec02229fde3669af0f67a8cc3497a",
              sourceState: "clean",
            },
            version: 1,
          } as const;
          const registry = makeHarnessProviderRegistry([
            {
              environmentAssignment: () =>
                Effect.succeed(environmentAssignment),
              launchObservation,
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider,
            },
          ]);
          const factoryInput = {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery" as const,
            workItem: {
              description: "Prove the complete worker epoch projection.",
              kind: "issue" as const,
              title: "Complete worker epoch",
            },
          };
          const workflowOptions = {
            harnessProviderRegistry: registry,
            rootDirectory,
          };
          const prepared = yield* prepareFactoryRunAcceptance(
            factoryInput,
            workflowOptions
          );
          const accepted = yield* acceptPreparedFactoryRun(
            prepared,
            workflowOptions
          );
          yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry: registry,
            rootDirectory,
          });
          const paths = yield* makeRunPaths(accepted.runId, { rootDirectory });
          const completedEvents = yield* readEvents(paths);
          const workerCompletedIndex = completedEvents.findIndex(
            ({ type }) => type === "WORKER_COMPLETED"
          );
          if (workerCompletedIndex < 0)
            throw new Error("Expected an authoritative worker completion.");
          const lines = (yield* fs.readFileString(paths.events))
            .trimEnd()
            .split("\n");
          yield* fs.writeFileString(
            paths.events,
            `${lines.slice(0, workerCompletedIndex).join("\n")}\n`
          );
          const orphan = yield* readWorkerEnvironmentEpochComparison(paths);
          assert.strictEqual(orphan.state, "incomplete");
          yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry: registry,
            rootDirectory,
          });
          assert.strictEqual(createCount, 1);
          assert.strictEqual(resumeCount, 1);
          const first = yield* readWorkerEnvironmentEpochComparison(paths);
          const replay = yield* readWorkerEnvironmentEpochComparison(paths);
          assert.strictEqual(first.state, "completeComparable");
          assert.deepEqual(replay, first);

          const authoritativeEvents = yield* readEvents(paths);
          const authoritativeCompletion = [...authoritativeEvents]
            .reverse()
            .find(({ type }) => type === "WORKER_COMPLETED");
          const authoritativeRef = Schema.decodeUnknownSync(
            HarnessEnvironmentReceiptArtifactRefV1
          )(authoritativeCompletion?.payload["harnessEnvironmentReceipt"]);
          const reusedRef = yield* commitHarnessEnvironmentCandidate({
            events: authoritativeEvents,
            observation,
            paths,
            resolvedExecution: prepared.resolvedExecution,
            runId: accepted.runId,
          });
          assert.deepEqual(reusedRef, authoritativeRef);

          const changedObservation = HarnessLaunchObservationV1.make({
            ...observation,
            reasoningEffort: "medium",
          });
          const mismatch = yield* commitHarnessEnvironmentCandidate({
            events: authoritativeEvents,
            observation: changedObservation,
            paths,
            resolvedExecution: prepared.resolvedExecution,
            runId: accepted.runId,
          }).pipe(Effect.flip);
          assert.strictEqual(
            mismatch.code,
            "HarnessEnvironmentEvidenceUnavailable"
          );
          assert.deepEqual(yield* readEvents(paths), authoritativeEvents);

          const policyLimited = yield* readWorkerEnvironmentEpochComparison(
            paths,
            {
              requireProviderNativeToolInventory: true,
            }
          );
          assert.strictEqual(policyLimited.state, "nonComparable");

          const events = yield* readEvents(paths);
          const completed = [...events]
            .reverse()
            .find(({ type }) => type === "WORKER_COMPLETED");
          const receiptRef = completed?.payload["harnessEnvironmentReceipt"];
          if (typeof receiptRef !== "object" || receiptRef === null)
            throw new Error("Expected an authoritative receipt reference.");
          const receiptPath = Reflect.get(receiptRef, "path");
          if (typeof receiptPath !== "string")
            throw new Error("Expected an authoritative receipt path.");
          const target = join(paths.root, receiptPath);
          const body = yield* fs.readFileString(target);
          yield* fs.writeFileString(target, "{}\n");
          const corrupt = yield* readWorkerEnvironmentEpochComparison(paths);
          assert.strictEqual(corrupt.state, "incomplete");
          assert.deepEqual(corrupt.limitations, [
            "authoritativeReceiptInvalid",
          ]);
          yield* fs.writeFileString(target, body);
          assert.deepEqual(
            yield* readWorkerEnvironmentEpochComparison(paths),
            first
          );
        }).pipe(Effect.provide(HarnessLaunchObservationLive))
    );

    it.effect("durably accepts Markdown content before continuation", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({
          prefix: "gaia-server-workflow-",
        });

        const accepted = yield* acceptServerRun(
          { specMarkdown: "Accept this server run.\n" },
          { rootDirectory: cwd }
        );
        const input = yield* fs.readFileString(
          `${accepted.runDirectory}/input.md`
        );
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });

        assert.strictEqual(input, "Accept this server run.\n");
        assert.strictEqual(events.events.length, 1);
        assert.strictEqual(events.events[0]?.type, "RUN_CREATED");
        assert.strictEqual(events.events[0]?.payload["source"], "server");
        assert.strictEqual(events.events[0]?.sequence, accepted.eventSequence);
        const checkpointPath = `${accepted.runDirectory}/accepted-run-input.json`;
        const checkpointBody = yield* fs.readFileString(checkpointPath);
        const checkpointMtime = (yield* fs.stat(checkpointPath)).mtime;
        yield* fs.remove(`${accepted.runDirectory}/input.md`);
        const summary = yield* continueServerRun(accepted.runId, {
          rootDirectory: cwd,
        });
        const continuedEvents = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const legacyContract = continuedEvents.events.find(
          ({ type }) => type === "RUN_CONTRACT_RECORDED"
        );
        assert.strictEqual(summary.status, "completed");
        assert.ok(legacyContract);
        assert.strictEqual(
          parseAnyRunContract(legacyContract.payload["contract"]).version,
          1
        );
        assert.strictEqual(
          yield* fs.readFileString(checkpointPath),
          checkpointBody
        );
        assert.deepEqual(
          (yield* fs.stat(checkpointPath)).mtime,
          checkpointMtime
        );
        assert.isFalse(yield* fs.exists(`${cwd}/.gaia/lock`));
        const eventCount = (yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        })).events.length;
        const mismatch = yield* Effect.flip(
          continueServerRun(accepted.runId, {
            rootDirectory: cwd,
            workspaceSource: localDirectoryWorkspaceSource(cwd),
          })
        );
        assert.strictEqual(mismatch.code, "AcceptedRunCapabilityMismatch");
        assert.isFalse(yield* fs.exists(`${cwd}/.gaia/lock`));
        const afterMismatch = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        assert.lengthOf(afterMismatch.events, eventCount + 1);
        assert.strictEqual(afterMismatch.events.at(-1)?.type, "RUN_FAILED");
      })
    );

    it.effect(
      "preserves an accepted server V2 contract after the source input is removed",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-v2-continuation-",
          });
          const accepted = yield* acceptServerRun(
            {
              specMarkdown: readFileSync(
                `${process.cwd()}/../../examples/specs/claim-verification-v2.md`,
                "utf8"
              ),
            },
            { rootDirectory: cwd }
          );
          yield* fs.remove(`${accepted.runDirectory}/input.md`);

          const error = yield* Effect.flip(
            continueServerRun(accepted.runId, {
              reviewer: blockingReviewer(),
              rootDirectory: cwd,
            })
          );
          const events = (yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          })).events;
          const contractEvent = events.find(
            ({ type }) => type === "RUN_CONTRACT_RECORDED"
          );

          assert.strictEqual(error.code, "ReviewBlocked");
          assert.ok(contractEvent);
          assert.strictEqual(
            parseAnyRunContract(contractEvent.payload["contract"]).version,
            2
          );
        })
    );

    it.effect(
      "resolves and persists only safe execution metadata before accepting a factory run",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-accept-",
          });
          const registry = makeHarnessProviderRegistry([
            {
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider: acceptanceProvider,
            },
          ]);

          const accepted = yield* acceptFactoryRun(
            {
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Deliver through the selected provider.",
                kind: "issue",
                title: "Selected provider acceptance",
              },
            },
            { harnessProviderRegistry: registry, rootDirectory: cwd }
          );
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const serialized = JSON.stringify(events.events[0]?.payload);

          assert.deepEqual(events.events[0]?.payload["execution"], {
            resolved: Schema.encodeSync(ResolvedHarnessExecution)(
              ResolvedHarnessExecution.make({
                capabilities: acceptanceCapabilities,
                executionMode: "local",
                harnessProfileId:
                  codexAppServerExecutionSelection.harnessProfileId,
                provider: acceptanceProvider.descriptor,
                version: "synthetic-1",
              })
            ),
            selection: { harnessProfileId: "codexAppServer" },
          });
          assert.notInclude(serialized, "credential");
          assert.notInclude(serialized, "/usr/local/bin");
        })
    );

    it.effect(
      "continues an accepted server run through the default workflow",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-workflow-",
          });
          const accepted = yield* acceptServerRun(
            { specMarkdown: "Complete this server run.\n" },
            { rootDirectory: cwd }
          );

          const summary = yield* continueServerRun(accepted.runId, {
            rootDirectory: cwd,
          });
          const read = yield* readLocalRun(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(summary.status, "completed");
          assert.strictEqual(read.status, "completed");
          assert.strictEqual(read.latestEventType, "REPORT_COMPLETED");
        })
    );

    it.effect(
      "records a canonical failure when provider availability changes after acceptance",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-provider-change-",
          });
          let providerAvailable = true;
          const provider: HarnessProvider = {
            ...acceptanceProvider,
            detect: Effect.sync(() =>
              providerAvailable
                ? ({
                    auth: { state: "authenticated" },
                    capabilities: acceptanceCapabilities,
                    state: "available",
                    version: "synthetic-1",
                  } as const)
                : ({ state: "missing" } as const)
            ),
          };
          const registry = makeHarnessProviderRegistry([
            {
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider,
            },
          ]);
          const accepted = yield* acceptFactoryRun(
            {
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description:
                  "Fail when the accepted provider becomes unavailable.",
                kind: "issue",
                title: "Post-acceptance provider change",
              },
            },
            { harnessProviderRegistry: registry, rootDirectory: cwd }
          );
          providerAvailable = false;

          const error = yield* Effect.flip(
            continueServerRun(accepted.runId, {
              harnessProviderRegistry: registry,
              rootDirectory: cwd,
            })
          );
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(error.code, "AcceptedRunCapabilityMismatch");
          assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
        })
    );

    it.effect(
      "keeps default issue delivery local even inside a git repository",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-local-",
          });
          const commands: Array<GitDeliveryCommandInput> = [];
          const accepted = yield* acceptFactoryRun(
            {
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description:
                  "Run locally unless pull-request delivery is requested.",
                kind: "issue",
                title: "Local delivery policy",
              },
            },
            {
              deliveryGitCommandRunner: recordingGitRunner(commands, {
                baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
              }),
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          const summary = yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: recordingGitRunner(commands, {
              baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
            }),
            harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(summary.state, "completed");
          assert.strictEqual(events.events.at(-1)?.type, "REPORT_COMPLETED");
          assert.deepEqual(commands, []);
          assert.deepEqual(events.events[0]?.payload["delivery"], {
            mode: "local",
          });
        })
    );

    it.effect("repairs one failed exact claim before evidence review", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const rootDirectory = yield* fs.makeTempDirectory({
          prefix: "gaia-failure-repair-workflow-",
        });
        const harness = makeFailureRepairHarnessProvider(rootDirectory);
        const coordinator = makeLiveHarnessSessionCoordinator();
        const profile = yield* readVerificationExecutionProfile(
          parseRuntimePath(
            `${process.cwd()}/../../profiles/claim-verification.json`
          )
        );
        let verificationExecutions = 0;
        const verificationServices = {
          executor: {
            execute: (invocation) =>
              Effect.gen(function* () {
                verificationExecutions += 1;
                const passed = verificationExecutions === 2;
                const sandboxUuid = passed
                  ? "123e4567-e89b-12d3-a456-426614174002"
                  : "123e4567-e89b-12d3-a456-426614174001";
                yield* invocation.onSandboxCreated({
                  sandboxName: invocation.sandboxName,
                  sandboxUuid,
                });
                yield* fs.writeFileString(
                  invocation.stdoutPath,
                  passed ? "gaia-claim-ok\n" : ""
                );
                yield* fs.writeFileString(invocation.stderrPath, "");
                const observed = yield* observeWorkspaceStructuralDigest(
                  invocation.workspace
                );
                return Schema.decodeUnknownSync(
                  StagedDockerSandboxVerificationReceiptSchema
                )({
                  cleanup: {
                    finalAbsenceConfirmed: true,
                    removedSandboxUuid: sandboxUuid,
                    stoppedSandboxUuid: sandboxUuid,
                  },
                  durationMs: 1,
                  exitCode: passed ? 0 : 1,
                  observedProviderExitCode: passed ? 0 : 1,
                  observedExecutionIdentity: {
                    imageDigest: profile.imageDigest,
                    providerBuild: profile.provider.build,
                    providerVersion: profile.provider.version,
                    templateReference: profile.templateReference,
                  },
                  sandboxUuid,
                  status: passed ? "succeeded" : "nonZero",
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
                    contentDigest: passed
                      ? "c67d2c0ac3e5ea53ed76dadc9aab773e884efedcaac2be11aaa4b096576f5849"
                      : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    observedByteCount: passed ? 14 : 0,
                    retainedByteCount: passed ? 14 : 0,
                    truncated: false,
                  },
                  workspaceObservation: observed,
                });
              }).pipe(Effect.orDie),
            reconcile: () => Effect.die("must not reconcile"),
          },
          profile,
        } satisfies VerificationServices;
        const accepted = yield* acceptFactoryRun(
          {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery",
            workItem: {
              description: readFileSync(
                `${process.cwd()}/../../examples/specs/claim-verification-v2.md`,
                "utf8"
              ),
              kind: "issue",
              title: "Repair one failed exact claim",
            },
          },
          {
            harnessProviderRegistry: harness.registry,
            rootDirectory,
          }
        );

        const summary = yield* continueServerRun(accepted.runId, {
          harnessProviderRegistry: harness.registry,
          rootDirectory,
          sessionCoordinator: coordinator,
          verificationServices,
        });
        const events = (yield* readLocalRunEvents(accepted.runId, {
          rootDirectory,
        })).events;
        const repairReceipts = events.flatMap((event) =>
          event.type === "FAILURE_REPAIR_RECORDED"
            ? [parseFailureRepairReceipt(event.payload["failureRepair"])]
            : []
        );
        const repairVerifiedIndex = events.findIndex(
          (event) =>
            event.type === "FAILURE_REPAIR_RECORDED" &&
            parseFailureRepairReceipt(event.payload["failureRepair"]).state ===
              "verified"
        );
        const evidenceReviewIndex = events.findIndex(
          (event) =>
            event.type === "REVIEW_STARTED" &&
            event.payload["phase"] === "evidence"
        );

        assert.strictEqual(summary.state, "completed");
        assert.strictEqual(verificationExecutions, 2);
        assert.strictEqual(harness.repairResumes, 1);
        assert.strictEqual(harness.repairSends, 1);
        assert.deepEqual(
          repairReceipts.map(({ state }) => state),
          ["intentRecorded", "dispatchAttempted", "turnCompleted", "verified"]
        );
        assert.isTrue(repairVerifiedIndex >= 0);
        assert.isTrue(evidenceReviewIndex > repairVerifiedIndex);
      })
    );

    it.effect(
      "runs issue delivery in an owned worktree at the accepted remote base",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-worktree-",
          });
          const commands: Array<GitDeliveryCommandInput> = [];
          const gitRunner = recordingGitRunner(commands, {
            baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
          });
          const publicationCalls: Array<string> = [];

          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Deliver in a run-owned worktree.",
                kind: "issue",
                title: "Owned worktree delivery",
              },
            },
            {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          const summary = yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: gitRunner,
            deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
            harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const serialized = JSON.stringify(events.events);
          const deliveryStarted = events.events.find(
            ({ type }) => type === "DELIVERY_STARTED"
          );

          assert.strictEqual(summary.state, "delivering");
          assert.deepEqual(publicationCalls, [accepted.runId]);
          assert.strictEqual(
            events.events.at(-1)?.type,
            "DELIVERY_READY_TO_PUBLISH"
          );
          assert.isTrue(
            commands.some(
              ({ args }) =>
                args[0] === "worktree" &&
                args[1] === "add" &&
                args.includes("eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92")
            )
          );
          assert.include(serialized, '"remote":"origin"');
          assert.include(serialized, '"baseBranch":"main"');
          assert.deepEqual(deliveryStarted?.payload["delivery"], {
            baseBranch: "main",
            baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
            feedbackTrustPolicy: {
              allowPullRequestAuthor: false,
              trustedChecks: [
                {
                  appSlug: "github-actions",
                  name: "gaia-pr-ci",
                  repository: "cill-i-am/gaia",
                  workflow: "Gaia PR CI",
                },
              ],
              trustedHumanLogins: [],
              version: 1,
            },
            headBranch: `gaia/${accepted.runId}`,
            mode: "pullRequest",
            remote: "origin",
            stage: "delivering",
          });
          assert.notInclude(serialized, cwd);
        })
    );

    it.effect(
      "persists explicit solo approval policy only at delivery acceptance",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-solo-policy-",
          });
          const gitRunner = recordingGitRunner([], {
            baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
          });
          const trustPolicy = DeliveryFeedbackTrustPolicyV1.make({
            allowPullRequestAuthor: false,
            requireApprovedReview: false,
            trustedChecks: [],
            trustedHumanLogins: [],
            version: 1,
          });
          const provenancePolicy = DeliveryAcceptanceProvenancePolicyV1.make({
            baseBranch: "gaia-93-smoke-base-acceptance",
            headBranch: "gaia/gaia-93-smoke-head-acceptance",
            remote: "origin",
            version: 1,
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Persist solo review authority.",
                kind: "issue",
                title: "Solo policy",
              },
            },
            {
              deliveryAcceptanceProvenancePolicy: provenancePolicy,
              deliveryFeedbackTrustPolicy: trustPolicy,
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          const acceptedEvents = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          assert.deepInclude(acceptedEvents.events[0]?.payload, {
            delivery: {
              baseBranch: provenancePolicy.baseBranch,
              baseRevision: "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92",
              headBranch: provenancePolicy.headBranch,
              mode: "pullRequest",
              remote: provenancePolicy.remote,
            },
            deliveryFeedbackTrustPolicy: {
              allowPullRequestAuthor: false,
              requireApprovedReview: false,
              trustedChecks: [],
              trustedHumanLogins: [],
              version: 1,
            },
          });
          yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: gitRunner,
            deliveryPublisher: recordingDeliveryPublisher([]),
            harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const deliveryStarted = events.events.find(
            ({ type }) => type === "DELIVERY_STARTED"
          );

          assert.deepInclude(deliveryStarted?.payload["delivery"], {
            feedbackTrustPolicy: {
              allowPullRequestAuthor: false,
              requireApprovedReview: false,
              trustedChecks: [],
              trustedHumanLogins: [],
              version: 1,
            },
            headBranch: provenancePolicy.headBranch,
          });
          assert.lengthOf(
            events.events.filter(({ type }) => type === "DELIVERY_STARTED"),
            1
          );
        })
    );

    it.effect(
      "rejects a continuation policy mismatch before delivery starts or external work",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-policy-drift-",
          });
          const commands: Array<GitDeliveryCommandInput> = [];
          const gitRunner = recordingGitRunner(commands, {
            baseRevision: "e".repeat(40),
          });
          const solo = DeliveryFeedbackTrustPolicyV1.make({
            allowPullRequestAuthor: false,
            requireApprovedReview: false,
            trustedChecks: [],
            trustedHumanLogins: [],
            version: 1,
          });
          const strict = DeliveryFeedbackTrustPolicyV1.make({
            ...solo,
            requireApprovedReview: true,
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject policy drift.",
                kind: "issue",
                title: "Policy drift",
              },
            },
            {
              deliveryFeedbackTrustPolicy: solo,
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          const commandCountAfterAcceptance = commands.length;
          const exit = yield* continueServerRun(accepted.runId, {
            deliveryFeedbackTrustPolicy: strict,
            deliveryGitCommandRunner: gitRunner,
            deliveryPublisher: recordingDeliveryPublisher([]),
            harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          }).pipe(Effect.exit);
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(exit._tag, "Failure");
          if (exit._tag === "Failure")
            assert.include(
              String(exit.cause),
              "Delivery feedback trust policy changed after run acceptance."
            );
          assert.strictEqual(commands.length, commandCountAfterAcceptance);
          assert.lengthOf(
            events.events.filter(({ type }) => type === "DELIVERY_STARTED"),
            0
          );
        })
    );

    it.effect(
      "replays legacy RUN_CREATED without acceptance policy as strict",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-legacy-policy-",
          });
          const gitRunner = recordingGitRunner([], {
            baseRevision: "e".repeat(40),
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Replay legacy strict policy.",
                kind: "issue",
                title: "Legacy policy",
              },
            },
            {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          const paths = yield* makeRunPaths(parseRunId(accepted.runId), {
            rootDirectory: cwd,
          });
          const encoded = Schema.decodeUnknownSync(Schema.Json)(
            JSON.parse(yield* fs.readFileString(paths.events))
          );
          if (
            typeof encoded !== "object" ||
            encoded === null ||
            Array.isArray(encoded)
          ) {
            throw new Error("Expected the stored run event to be an object.");
          }
          const encodedObject = Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Json)
          )(encoded);
          const { payload } = encodedObject;
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error(
              "Expected the stored run event payload to be an object."
            );
          }
          const payloadObject = Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Json)
          )(payload);
          const {
            acceptedInputCheckpoint: _acceptedInputCheckpoint,
            deliveryFeedbackTrustPolicy: _deliveryFeedbackTrustPolicy,
            ...legacyPayload
          } = payloadObject;
          yield* fs.writeFileString(
            paths.events,
            `${JSON.stringify({ ...encodedObject, payload: legacyPayload })}\n`
          );

          yield* continueServerRun(accepted.runId, {
            deliveryGitCommandRunner: gitRunner,
            deliveryPublisher: recordingDeliveryPublisher([]),
            harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const started = events.events.find(
            ({ type }) => type === "DELIVERY_STARTED"
          );
          assert.notProperty(
            events.events[0]?.payload ?? {},
            "deliveryFeedbackTrustPolicy"
          );
          assert.isDefined(started);
          if (started === undefined) {
            throw new Error("DELIVERY_STARTED event was not recorded.");
          }
          assert.notProperty(
            (started.payload["delivery"] as Record<string, unknown>)
              .feedbackTrustPolicy as Record<string, unknown>,
            "requireApprovedReview"
          );
        })
    );

    it.effect(
      "rejects provenance assertion drift before continuation git or events",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-provenance-drift-",
          });
          const commands: Array<GitDeliveryCommandInput> = [];
          const gitRunner = recordingGitRunner(commands, {
            baseRevision: "e".repeat(40),
          });
          const acceptedPolicy = DeliveryAcceptanceProvenancePolicyV1.make({
            baseBranch: "gaia-93-smoke-base-drift",
            headBranch: "gaia/gaia-93-smoke-head-drift",
            remote: "origin",
            version: 1,
          });
          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject provenance drift.",
                kind: "issue",
                title: "Provenance drift",
              },
            },
            {
              deliveryAcceptanceProvenancePolicy: acceptedPolicy,
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          const countAfterAcceptance = commands.length;
          const drifted = DeliveryAcceptanceProvenancePolicyV1.make({
            ...acceptedPolicy,
            headBranch: "gaia/gaia-93-smoke-head-changed",
          });
          const exit = yield* continueServerRun(accepted.runId, {
            deliveryAcceptanceProvenancePolicy: drifted,
            deliveryGitCommandRunner: gitRunner,
            deliveryPublisher: recordingDeliveryPublisher([]),
            harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
            rootDirectory: cwd,
          }).pipe(Effect.exit);
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(exit._tag, "Failure");
          assert.strictEqual(commands.length, countAfterAcceptance);
          assert.lengthOf(
            events.events.filter(({ type }) => type === "DELIVERY_STARTED"),
            0
          );
        })
    );

    it.effect(
      "fails closed when a persisted delivery worktree has the wrong head",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-collision-",
          });
          const acceptedBase = "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92";
          const gitRunner = recordingGitRunner([], {
            baseRevision: acceptedBase,
            workspaceHead: "1111111111111111111111111111111111111111",
          });

          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject a colliding worktree.",
                kind: "issue",
                title: "Wrong worktree identity",
              },
            },
            {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          yield* fs.makeDirectory(`${accepted.runDirectory}/workspace`, {
            recursive: true,
          });

          const error = yield* Effect.flip(
            continueServerRun(accepted.runId, {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            })
          );
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(error.code, "DeliveryWorktreeIdentityMismatch");
          assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
        })
    );

    it.effect(
      "fails closed when ownership evidence does not match the repository identity",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-ownership-",
          });
          const acceptedBase = "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92";
          const gitRunner = recordingGitRunner([], {
            baseRevision: acceptedBase,
            workspaceHead: acceptedBase,
          });

          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject stale ownership evidence.",
                kind: "issue",
                title: "Wrong ownership identity",
              },
            },
            {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          yield* fs.makeDirectory(`${accepted.runDirectory}/workspace`, {
            recursive: true,
          });
          yield* fs.writeFileString(
            `${accepted.runDirectory}/delivery-ownership.json`,
            `${JSON.stringify(
              {
                baseRevision: acceptedBase,
                repositoryCommonDir: `${cwd}/other-common-dir`,
                repositoryRoot: cwd,
                token: "stale-token",
                version: 1,
                workspaceCommonDir: `${accepted.runDirectory}/workspace/.git`,
                workspaceRoot: `${accepted.runDirectory}/workspace`,
              },
              null,
              2
            )}\n`
          );

          const error = yield* Effect.flip(
            continueServerRun(accepted.runId, {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            })
          );
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(error.code, "DeliveryWorktreeIdentityMismatch");
          assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
        })
    );

    it.effect(
      "fails closed when accepted pull-request provenance is corrupt",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-delivery-provenance-",
          });
          const acceptedBase = "eea77bffa399d93ae0c90e71e9a39f1fb9a4aa92";
          const gitRunner = recordingGitRunner([], {
            baseRevision: acceptedBase,
          });

          const accepted = yield* acceptFactoryRun(
            {
              delivery: { mode: "pullRequest" },
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Reject corrupt provenance.",
                kind: "issue",
                title: "Corrupt provenance",
              },
            },
            {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            }
          );
          const eventLog = `${accepted.runDirectory}/events.jsonl`;
          const firstLine = yield* fs.readFileString(eventLog);
          const created = Schema.decodeUnknownSync(Schema.Json)(
            JSON.parse(firstLine.trim())
          );
          if (
            typeof created !== "object" ||
            created === null ||
            Array.isArray(created)
          ) {
            throw new Error("Expected the stored run event to be an object.");
          }
          const createdObject = Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Json)
          )(created);
          const { payload } = createdObject;
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          ) {
            throw new Error(
              "Expected the stored run event payload to be an object."
            );
          }
          const payloadObject = Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Json)
          )(payload);
          yield* fs.writeFileString(
            eventLog,
            `${JSON.stringify({
              ...createdObject,
              payload: {
                ...payloadObject,
                delivery: { mode: "pullRequest" },
              },
            })}\n`
          );

          const error = yield* Effect.flip(
            continueServerRun(accepted.runId, {
              deliveryGitCommandRunner: gitRunner,
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            })
          );
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(error.code, "AcceptedRunCapabilityMismatch");
          assert.strictEqual(events.events.at(-1)?.type, "RUN_FAILED");
        })
    );

    it.effect(
      "continues an audited worker recovery from a fresh epoch without publishing stale ready evidence",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const smoke = makeDisposableGitRemote();
          try {
            const cwd = realpathSync(smoke.source);
            const publicationCalls: Array<string> = [];
            const profilePath = `${cwd}/restart-profile.json`;
            const skillManifestPath = `${cwd}/restart-skills.json`;
            yield* fs.writeFileString(
              profilePath,
              JSON.stringify({
                checks: { browserEvidence: "optional" },
                name: "checkpoint-profile",
                version: 1,
              })
            );
            yield* fs.writeFileString(
              skillManifestPath,
              JSON.stringify({ skills: [] })
            );
            const acceptedSources = {
              runProfileSource: localRunProfileSource(profilePath),
              skillManifestSource: localSkillManifestSource(skillManifestPath),
            };
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: postPublicationOnlyV2Spec(),
                  kind: "issue",
                  title: "Audited continuation",
                },
              },
              {
                ...acceptedSources,
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
                rootDirectory: cwd,
              }
            );
            yield* continueServerRun(accepted.runId, {
              ...acceptedSources,
              deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            });
            publicationCalls.length = 0;
            yield* fs.remove(profilePath);
            yield* fs.remove(skillManifestPath);

            const runId = parseRunId(accepted.runId);
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            yield* fs.remove(paths.input);
            const readyEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const contaminatedReady = readyEvents.events.find(
              ({ type }) => type === "DELIVERY_READY_TO_PUBLISH"
            );
            if (contaminatedReady === undefined) {
              assert.fail("Expected contaminated ready evidence.");
            }
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const recoveryBase = {
              actionId: "recover-1",
              attempt: 1 as const,
              expectedFailureSequence: 10,
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              model: "gpt-5.4",
              payloadDigest: "a".repeat(64),
            };
            const recoveredTurnDigest = digest("turn-test-worker");
            yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "dispatchConfirmed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const failedRecovery = yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  code: "WorkerRecoveryContinuationFailed",
                  message:
                    "The checkpoint turn was interrupted after zero product changes.",
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "failed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            yield* fs.writeFileString(
              `${paths.root}/.worker-recovery-turn.json`,
              `${workerRecoveryTurnCheckpoint("turn-test-worker", recoveryBase)}\n`
            );

            const action = WorkerContinuationAction.make({
              actionId: parseWorkerRecoveryActionId("continue-recovery-1"),
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedCurrentSequence: failedRecovery.event.sequence,
              expectedDeliveryProvenanceDigest: deliveryProvenanceDigest({
                baseBranch: "main",
                baseRevision: smoke.baseRevision,
                headBranch: `gaia/${runId}`,
                remote: "origin",
              }),
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedRecoveryActionId:
                parseWorkerRecoveryActionId("recover-1"),
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              kind: "continueInterruptedWorkerRecovery",
            });
            const evidenceBeforeMismatch = snapshotAuditedActionEvidence(paths);
            for (const semanticMismatch of [
              {
                processHarness: makeProcessHarnessConfig("node", [
                  "changed-process-harness.mjs",
                ]),
              },
              {
                codexHarness: {
                  config: makeCodexHarnessConfig({
                    model: "gpt-5.4-audited-drift",
                  }),
                },
              },
              { skillInstaller: { command: "git-other" } },
              {
                workspaceSource: localDirectoryWorkspaceSource(
                  `${cwd}/changed-workspace`
                ),
              },
              { browserEvidenceRequirement: "required" as const },
              {
                browserEvidenceTargetUrl: parseBrowserEvidenceTargetUrl(
                  "https://example.test/changed-target"
                ),
              },
            ]) {
              let mismatchedRunnerCalls = 0;
              const mismatch = yield* Effect.flip(
                actOnWorkerContinuation(runId, action, {
                  ...acceptedSources,
                  ...semanticMismatch,
                  harnessProviderRegistry:
                    makeMarkerHarnessProviderRegistry(cwd),
                  rootDirectory: cwd,
                  workerContinuationRunner: () =>
                    Effect.sync(() => {
                      mismatchedRunnerCalls += 1;
                      throw new Error(
                        "The mismatched runner must not be called."
                      );
                    }),
                })
              );
              assert.strictEqual(
                mismatch.code,
                "AcceptedRunCapabilityMismatch"
              );
              assert.strictEqual(mismatchedRunnerCalls, 0);
              assert.deepEqual(
                snapshotAuditedActionEvidence(paths),
                evidenceBeforeMismatch
              );
            }
            const receipt = yield* actOnWorkerContinuation(runId, action, {
              ...acceptedSources,
              deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            });
            const events = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const continuationStates = events.events.flatMap((event) =>
              event.type === "WORKER_CONTINUATION_RECORDED"
                ? [
                    decodeWorkerContinuationEventPayload(event.payload)
                      .continuation.state,
                  ]
                : []
            );
            const workerCompletions = events.events.filter(
              ({ type }) => type === "WORKER_COMPLETED"
            );
            const freshReady = events.events
              .filter(({ type }) => type === "DELIVERY_READY_TO_PUBLISH")
              .at(-1);
            const delivery = snapshotFromReplay(events.events).context[
              "delivery"
            ];
            const contractEvent = events.events.find(
              ({ type }) => type === "RUN_CONTRACT_RECORDED"
            );

            assert.strictEqual(
              receipt.state,
              "workerCompleted",
              JSON.stringify({ receipt, tail: events.events.slice(-8) })
            );
            assert.deepEqual(continuationStates, [
              "intentRecorded",
              "resumeAttempted",
              "workerCompleted",
            ]);
            assert.lengthOf(workerCompletions, 2);
            assert.isAbove(
              workerCompletions.at(-1)?.sequence ?? 0,
              failedRecovery.event.sequence
            );
            assert.isAbove(
              freshReady?.sequence ?? 0,
              failedRecovery.event.sequence
            );
            assert.deepEqual(publicationCalls, []);
            assert.ok(contractEvent);
            assert.strictEqual(
              parseAnyRunContract(contractEvent.payload["contract"]).version,
              2
            );
            assert.isObject(delivery);
            assert.strictEqual(
              (delivery as Record<string, unknown>)["stage"],
              "readyToPublish"
            );
            assert.strictEqual(
              (delivery as Record<string, unknown>)[
                "workerEvidenceEpochSequence"
              ],
              failedRecovery.event.sequence + 1
            );

            const replayEventCount = events.events.length;
            const replayReceipt = yield* actOnWorkerContinuation(
              runId,
              action,
              {
                deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(
                  smoke.source
                ),
                rootDirectory: cwd,
              }
            );
            const replayedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const conflict = yield* Effect.flip(
              actOnWorkerContinuation(
                runId,
                WorkerContinuationAction.make({
                  ...action,
                  actionId: parseWorkerRecoveryActionId("continue-recovery-2"),
                }),
                {
                  deliveryPublisher:
                    recordingDeliveryPublisher(publicationCalls),
                  harnessProviderRegistry:
                    makeMarkerHarnessProviderRegistry(cwd),
                  rootDirectory: cwd,
                }
              )
            );
            const conflictedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });

            assert.deepEqual(replayReceipt, receipt);
            assert.lengthOf(replayedEvents.events, replayEventCount);
            assert.instanceOf(conflict, GaiaRuntimeError);
            assert.strictEqual(conflict.code, "DeliveryActionConflict");
            assert.lengthOf(conflictedEvents.events, replayEventCount);
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "marks ambiguous audited continuation restarts outcomeUnknown without redispatch",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-audited-continuation-ambiguity-",
          });
          const accepted = yield* acceptServerRun(
            {
              specMarkdown: "Already accepted before ambiguous continuation.\n",
            },
            { rootDirectory: cwd }
          );
          const runId = parseRunId(accepted.runId);
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          const sessionId = parseHarnessSessionId(`session-${runId}`);
          const action = WorkerContinuationAction.make({
            actionId: parseWorkerRecoveryActionId("continue-recovery-1"),
            expectedContaminatedReadySequence: accepted.eventSequence,
            expectedCurrentSequence: accepted.eventSequence,
            expectedDeliveryProvenanceDigest: parseWorkerRecoveryDigest(
              "c".repeat(64)
            ),
            expectedFailedRecoverySequence: accepted.eventSequence,
            expectedRecoveryActionId: parseWorkerRecoveryActionId("recover-1"),
            expectedSessionId: sessionId,
            harnessProfileId: codexAppServerExecutionSelection.harnessProfileId,
            kind: "continueInterruptedWorkerRecovery",
          });
          const base = {
            actionId: action.actionId,
            expectedContaminatedReadySequence:
              action.expectedContaminatedReadySequence,
            expectedCurrentSequence: action.expectedCurrentSequence,
            expectedDeliveryProvenanceDigest:
              action.expectedDeliveryProvenanceDigest,
            expectedFailedRecoverySequence:
              action.expectedFailedRecoverySequence,
            expectedRecoveryActionId: action.expectedRecoveryActionId,
            expectedSessionId: action.expectedSessionId,
            harnessProfileId: action.harnessProfileId,
            maxAttempts: 1 as const,
            workerEvidenceEpochSequence: accepted.eventSequence + 1,
          };
          yield* appendEvent(runId, paths, {
            payload: {
              continuation: encodeWorkerContinuationReceiptJson({
                ...base,
                state: "intentRecorded",
              }),
            },
            type: "WORKER_CONTINUATION_RECORDED",
          });
          yield* appendEvent(runId, paths, {
            payload: {
              continuation: encodeWorkerContinuationReceiptJson({
                ...base,
                state: "resumeAttempted",
              }),
            },
            type: "WORKER_CONTINUATION_RECORDED",
          });

          let dispatches = 0;
          const receipt = yield* actOnWorkerContinuation(runId, action, {
            rootDirectory: cwd,
            workerContinuationRunner: () =>
              Effect.sync(() => {
                dispatches += 1;
                return {
                  reportPath: paths.reportMarkdown,
                  runDirectory: paths.root,
                  runId,
                  state: "delivering",
                  status: "running",
                };
              }),
          });
          const events = yield* readLocalRunEvents(runId, {
            rootDirectory: cwd,
          });
          const continuationStates = events.events.flatMap((event) =>
            event.type === "WORKER_CONTINUATION_RECORDED"
              ? [
                  decodeWorkerContinuationEventPayload(event.payload)
                    .continuation.state,
                ]
              : []
          );
          const replayEventCount = events.events.length;
          const replayReceipt = yield* actOnWorkerContinuation(runId, action, {
            rootDirectory: cwd,
            workerContinuationRunner: () =>
              Effect.sync(() => {
                dispatches += 1;
                return {
                  reportPath: paths.reportMarkdown,
                  runDirectory: paths.root,
                  runId,
                  state: "delivering",
                  status: "running",
                };
              }),
          });
          const replayedEvents = yield* readLocalRunEvents(runId, {
            rootDirectory: cwd,
          });

          assert.strictEqual(receipt.state, "outcomeUnknown");
          assert.strictEqual(replayReceipt.state, "outcomeUnknown");
          assert.strictEqual(dispatches, 0);
          assert.deepEqual(continuationStates, [
            "intentRecorded",
            "resumeAttempted",
            "outcomeUnknown",
          ]);
          assert.lengthOf(replayedEvents.events, replayEventCount);
        })
    );

    it.effect(
      "records one audited correlation reconciliation epoch before a deterministic follow-up",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const smoke = makeDisposableGitRemote();
          try {
            const cwd = realpathSync(smoke.source);
            const publicationCalls: Array<string> = [];
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: "Recover the interrupted checkpoint.",
                  kind: "issue",
                  title: "Audited correlation reconciliation",
                },
              },
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
                rootDirectory: cwd,
              }
            );
            yield* continueServerRun(accepted.runId, {
              deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(
                smoke.source
              ),
              rootDirectory: cwd,
            });
            publicationCalls.length = 0;

            const runId = parseRunId(accepted.runId);
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            const readyEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const contaminatedReady = readyEvents.events.find(
              ({ type }) => type === "DELIVERY_READY_TO_PUBLISH"
            );
            if (contaminatedReady === undefined) {
              assert.fail("Expected contaminated ready evidence.");
            }
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const recoveredTurnDigest = digest("turn-test-worker");
            const recoveryBase = {
              actionId: "recover-1",
              attempt: 1 as const,
              expectedFailureSequence: 10,
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              model: "gpt-5.4",
              payloadDigest: "a".repeat(64),
            };
            yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "dispatchConfirmed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const failedRecovery = yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  code: "WorkerRecoveryContinuationFailed",
                  message:
                    "The checkpoint turn was interrupted after zero product changes.",
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "failed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const continuationBase = {
              actionId: "continue-recovery-1",
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedCurrentSequence: failedRecovery.event.sequence,
              expectedDeliveryProvenanceDigest: deliveryProvenanceDigest({
                baseBranch: "main",
                baseRevision: smoke.baseRevision,
                headBranch: `gaia/${runId}`,
                remote: "origin",
              }),
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence: failedRecovery.event.sequence + 1,
            };
            yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  state: "intentRecorded",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const failedContinuation = yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  code: "HarnessCorrelationUnavailable",
                  message:
                    "The interrupted checkpoint correlation is unavailable.",
                  state: "failed",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const action = WorkerCorrelationReconciliationAction.make({
              actionId: parseWorkerRecoveryActionId("reconcile-correlation-1"),
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedContinuationActionId: parseWorkerRecoveryActionId(
                "continue-recovery-1"
              ),
              expectedCurrentSequence: failedContinuation.event.sequence,
              expectedDeliveryProvenanceDigest:
                continuationBase.expectedDeliveryProvenanceDigest,
              expectedFailedContinuationSequence:
                failedContinuation.event.sequence,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedNativeTurnIdDigest: recoveredTurnDigest,
              expectedRecoveryActionId:
                parseWorkerRecoveryActionId("recover-1"),
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              kind: "reconcileInterruptedWorkerCorrelation",
            });
            const evidenceBeforeMismatch = snapshotAuditedActionEvidence(paths);
            for (const semanticMismatch of [
              {
                processHarness: makeProcessHarnessConfig("node", [
                  "changed-process-harness.mjs",
                ]),
              },
              {
                codexHarness: {
                  config: makeCodexHarnessConfig({
                    model: "gpt-5.4-audited-drift",
                  }),
                },
              },
              { skillInstaller: { command: "git-other" } },
              {
                workspaceSource: localDirectoryWorkspaceSource(
                  `${cwd}/changed-workspace`
                ),
              },
              { browserEvidenceRequirement: "required" as const },
              {
                browserEvidenceTargetUrl: parseBrowserEvidenceTargetUrl(
                  "https://example.test/changed-target"
                ),
              },
            ]) {
              const mismatchedSeamCalls: Array<string> = [];
              const mismatch = yield* Effect.flip(
                actOnWorkerCorrelationReconciliation(runId, action, {
                  ...semanticMismatch,
                  harnessProviderRegistry:
                    makeMarkerHarnessProviderRegistry(cwd),
                  rootDirectory: cwd,
                  workerCorrelationFollowUpDispatcher: () =>
                    Effect.sync(() => {
                      mismatchedSeamCalls.push("follow-up");
                    }),
                  workerCorrelationReconciler: () =>
                    Effect.sync(() => {
                      mismatchedSeamCalls.push("reconcile");
                    }),
                  workerCorrelationRunner: () =>
                    Effect.sync(() => {
                      mismatchedSeamCalls.push("runner");
                      throw new Error(
                        "The mismatched runner must not be called."
                      );
                    }),
                })
              );
              assert.strictEqual(
                mismatch.code,
                "AcceptedRunCapabilityMismatch"
              );
              assert.deepEqual(mismatchedSeamCalls, []);
              assert.deepEqual(
                snapshotAuditedActionEvidence(paths),
                evidenceBeforeMismatch
              );
            }
            const seamCalls: Array<string> = [];
            const receipt = yield* actOnWorkerCorrelationReconciliation(
              runId,
              action,
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
                rootDirectory: cwd,
                workerCorrelationReconciler: ({
                  action: seamAction,
                  clientInputId,
                }) =>
                  Effect.sync(() => {
                    seamCalls.push(
                      `reconcile:${seamAction.actionId}:${clientInputId}`
                    );
                  }),
                workerCorrelationFollowUpDispatcher: ({
                  clientInputId,
                  followUpText,
                }) =>
                  Effect.sync(() => {
                    seamCalls.push(
                      `follow-up:${clientInputId}:${followUpText.includes("Do not restart")}`
                    );
                  }),
                workerCorrelationRunner: () =>
                  appendEvent(runId, paths, {
                    payload: {
                      workerResultPath: "worker-result-reconciled.json",
                    },
                    type: "WORKER_COMPLETED",
                  }).pipe(
                    Effect.as({
                      reportPath: paths.reportMarkdown,
                      runDirectory: paths.root,
                      runId,
                      state: "delivering" as const,
                      status: "running" as const,
                    })
                  ),
              }
            );
            const events = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const reconciliationStates = events.events.flatMap((event) =>
              event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED"
                ? [
                    decodeWorkerCorrelationEventPayload(event.payload)
                      .reconciliation.state,
                  ]
                : []
            );
            const delivery = snapshotFromReplay(events.events).context[
              "delivery"
            ];

            assert.strictEqual(receipt.state, "workerCompleted");
            assert.deepEqual(reconciliationStates, [
              "intentRecorded",
              "correlationAttempted",
              "correlationConfirmed",
              "followUpAttempted",
              "followUpConfirmed",
              "workerCompleted",
            ]);
            assert.lengthOf(seamCalls, 2);
            assert.deepEqual(publicationCalls, []);
            assert.isObject(delivery);
            assert.strictEqual(
              (delivery as Record<string, unknown>)[
                "workerEvidenceEpochSequence"
              ],
              failedContinuation.event.sequence + 1
            );

            const replayEventCount = events.events.length;
            const replayReceipt = yield* actOnWorkerCorrelationReconciliation(
              runId,
              action,
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
                rootDirectory: cwd,
                workerCorrelationReconciler: () =>
                  Effect.die("must not reconcile twice"),
                workerCorrelationFollowUpDispatcher: () =>
                  Effect.die("must not redispatch follow-up"),
                workerCorrelationRunner: () =>
                  Effect.die("must not rerun completed worker"),
              }
            );
            const replayedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const conflict = yield* Effect.flip(
              actOnWorkerCorrelationReconciliation(
                runId,
                WorkerCorrelationReconciliationAction.make({
                  ...action,
                  actionId: parseWorkerRecoveryActionId(
                    "reconcile-correlation-2"
                  ),
                }),
                {
                  harnessProviderRegistry:
                    makeMarkerHarnessProviderRegistry(cwd),
                  rootDirectory: cwd,
                  workerCorrelationReconciler: () =>
                    Effect.die("must not reconcile conflicting action"),
                  workerCorrelationFollowUpDispatcher: () =>
                    Effect.die("must not dispatch conflicting action"),
                }
              )
            );
            const conflictedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });

            assert.deepEqual(replayReceipt, receipt);
            assert.lengthOf(replayedEvents.events, replayEventCount);
            assert.instanceOf(conflict, GaiaRuntimeError);
            assert.strictEqual(conflict.code, "DeliveryActionConflict");
            assert.lengthOf(conflictedEvents.events, replayEventCount);
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "records one desktop-origin correlation epoch after terminal source-classification failure",
      () =>
        Effect.gen(function* () {
          const smoke = makeDisposableGitRemote();
          try {
            const cwd = realpathSync(smoke.source);
            const publicationCalls: Array<string> = [];
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description:
                    "Recover the Desktop-originated interrupted checkpoint.",
                  kind: "issue",
                  title: "Desktop-origin correlation reconciliation",
                },
              },
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(
                  smoke.source
                ),
                rootDirectory: cwd,
              }
            );
            yield* continueServerRun(accepted.runId, {
              deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            });
            publicationCalls.length = 0;
            const runId = parseRunId(accepted.runId);
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            const readyEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const contaminatedReady = readyEvents.events.find(
              ({ type }) => type === "DELIVERY_READY_TO_PUBLISH"
            );
            if (contaminatedReady === undefined)
              assert.fail("Expected contaminated ready evidence.");
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const recoveredTurnDigest = digest("turn-test-worker");
            const provenanceDigest = deliveryProvenanceDigest({
              baseBranch: "main",
              baseRevision: smoke.baseRevision,
              headBranch: `gaia/${runId}`,
              remote: "origin",
            });
            const recoveryBase = {
              actionId: "recover-1",
              attempt: 1 as const,
              expectedFailureSequence: 10,
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              model: "gpt-5.4",
              payloadDigest: "a".repeat(64),
            };
            yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "dispatchConfirmed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const failedRecovery = yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  code: "WorkerRecoveryContinuationFailed",
                  message:
                    "The checkpoint turn was interrupted after zero product changes.",
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "failed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const continuationBase = {
              actionId: "continue-recovery-1",
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedCurrentSequence: failedRecovery.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence: failedRecovery.event.sequence + 1,
            };
            yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  state: "intentRecorded",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const failedContinuation = yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  code: "HarnessCorrelationUnavailable",
                  message:
                    "The interrupted checkpoint correlation is unavailable.",
                  state: "failed",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const correlationBase = {
              actionId: "reconcile-correlation-1",
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedContinuationActionId: "continue-recovery-1",
              expectedCurrentSequence: failedContinuation.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedContinuationSequence:
                failedContinuation.event.sequence,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedNativeTurnIdDigest: recoveredTurnDigest,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence:
                failedContinuation.event.sequence + 1,
            };
            yield* appendWorkerCorrelationIntent(runId, paths, {
              ...correlationBase,
              state: "intentRecorded",
            });
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...correlationBase,
                    state: "correlationAttempted",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            const failedCorrelation = yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...correlationBase,
                    code: "WorkerCorrelationReconciliationFailed",
                    message:
                      "The source-classification proof excluded the Desktop-originated thread.",
                    state: "failed",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            const action = WorkerDesktopOriginCorrelationAction.make({
              actionId: parseWorkerRecoveryActionId(
                "reconcile-desktop-origin-1"
              ),
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedContinuationActionId: parseWorkerRecoveryActionId(
                "continue-recovery-1"
              ),
              expectedCorrelationActionId: parseWorkerRecoveryActionId(
                "reconcile-correlation-1"
              ),
              expectedCurrentSequence: failedCorrelation.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedContinuationSequence:
                failedContinuation.event.sequence,
              expectedFailedCorrelationSequence:
                failedCorrelation.event.sequence,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedNativeTurnIdDigest: recoveredTurnDigest,
              expectedRecoveryActionId:
                parseWorkerRecoveryActionId("recover-1"),
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              kind: "reconcileDesktopOriginatedWorkerCorrelation",
            });
            const evidenceBeforeMismatch = snapshotAuditedActionEvidence(paths);
            for (const semanticMismatch of [
              {
                processHarness: makeProcessHarnessConfig("node", [
                  "changed-process-harness.mjs",
                ]),
              },
              {
                codexHarness: {
                  config: makeCodexHarnessConfig({
                    model: "gpt-5.4-audited-drift",
                  }),
                },
              },
              { skillInstaller: { command: "git-other" } },
              {
                workspaceSource: localDirectoryWorkspaceSource(
                  `${cwd}/changed-workspace`
                ),
              },
              { browserEvidenceRequirement: "required" as const },
              {
                browserEvidenceTargetUrl: parseBrowserEvidenceTargetUrl(
                  "https://example.test/changed-target"
                ),
              },
            ]) {
              const mismatchedSeamCalls: Array<string> = [];
              const mismatch = yield* Effect.flip(
                actOnWorkerDesktopOriginCorrelation(runId, action, {
                  ...semanticMismatch,
                  harnessProviderRegistry:
                    makeMarkerHarnessProviderRegistry(cwd),
                  rootDirectory: cwd,
                  workerDesktopOriginCorrelationFollowUpDispatcher: () =>
                    Effect.sync(() => {
                      mismatchedSeamCalls.push("follow-up");
                    }),
                  workerDesktopOriginCorrelationReconciler: () =>
                    Effect.sync(() => {
                      mismatchedSeamCalls.push("reconcile");
                    }),
                  workerDesktopOriginCorrelationRunner: () =>
                    Effect.sync(() => {
                      mismatchedSeamCalls.push("runner");
                      throw new Error(
                        "The mismatched runner must not be called."
                      );
                    }),
                })
              );
              assert.strictEqual(
                mismatch.code,
                "AcceptedRunCapabilityMismatch"
              );
              assert.deepEqual(mismatchedSeamCalls, []);
              assert.deepEqual(
                snapshotAuditedActionEvidence(paths),
                evidenceBeforeMismatch
              );
            }
            const seamCalls: Array<string> = [];
            const receipt = yield* actOnWorkerDesktopOriginCorrelation(
              runId,
              action,
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
                rootDirectory: cwd,
                workerDesktopOriginCorrelationFollowUpDispatcher: ({
                  clientInputId,
                  followUpText,
                }) =>
                  Effect.sync(() =>
                    seamCalls.push(
                      `follow-up:${clientInputId}:${followUpText.includes("Do not restart")}`
                    )
                  ),
                workerDesktopOriginCorrelationReconciler: ({
                  action: seamAction,
                  clientInputId,
                }) =>
                  Effect.sync(() =>
                    seamCalls.push(
                      `source:${seamAction.actionId}:${clientInputId}`
                    )
                  ),
                workerDesktopOriginCorrelationRunner: () =>
                  appendEvent(runId, paths, {
                    payload: {
                      workerResultPath: "worker-result-desktop-origin.json",
                    },
                    type: "WORKER_COMPLETED",
                  }).pipe(
                    Effect.as({
                      reportPath: paths.reportMarkdown,
                      runDirectory: paths.root,
                      runId,
                      state: "delivering" as const,
                      status: "running" as const,
                    })
                  ),
              }
            );
            const events = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const desktopStates = events.events.flatMap((event) =>
              event.type === "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED"
                ? [
                    decodeWorkerDesktopOriginEventPayload(event.payload)
                      .desktopOriginCorrelation.state,
                  ]
                : []
            );
            const delivery = snapshotFromReplay(events.events).context[
              "delivery"
            ];

            assert.strictEqual(receipt.state, "workerCompleted");
            assert.deepEqual(desktopStates, [
              "intentRecorded",
              "sourceCorrelationAttempted",
              "sourceCorrelationConfirmed",
              "followUpAttempted",
              "followUpConfirmed",
              "workerCompleted",
            ]);
            assert.lengthOf(seamCalls, 2);
            assert.deepEqual(publicationCalls, []);
            assert.isObject(delivery);
            assert.strictEqual(
              (delivery as Record<string, unknown>)[
                "workerEvidenceEpochSequence"
              ],
              failedCorrelation.event.sequence + 1
            );
            const replayEventCount = events.events.length;
            const replayReceipt = yield* actOnWorkerDesktopOriginCorrelation(
              runId,
              action,
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
                rootDirectory: cwd,
                workerDesktopOriginCorrelationFollowUpDispatcher: () =>
                  Effect.die("must not redispatch follow-up"),
                workerDesktopOriginCorrelationReconciler: () =>
                  Effect.die("must not reconcile twice"),
                workerDesktopOriginCorrelationRunner: () =>
                  Effect.die("must not rerun completed worker"),
              }
            );
            const replayedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const conflict = yield* Effect.flip(
              actOnWorkerDesktopOriginCorrelation(
                runId,
                WorkerDesktopOriginCorrelationAction.make({
                  ...action,
                  actionId: parseWorkerRecoveryActionId(
                    "reconcile-desktop-origin-2"
                  ),
                }),
                {
                  harnessProviderRegistry:
                    makeMarkerHarnessProviderRegistry(cwd),
                  rootDirectory: cwd,
                  workerDesktopOriginCorrelationFollowUpDispatcher: () =>
                    Effect.die("must not dispatch conflicting action"),
                  workerDesktopOriginCorrelationReconciler: () =>
                    Effect.die("must not reconcile conflicting action"),
                }
              )
            );

            assert.deepEqual(replayReceipt, receipt);
            assert.lengthOf(replayedEvents.events, replayEventCount);
            assert.instanceOf(conflict, GaiaRuntimeError);
            assert.strictEqual(conflict.code, "DeliveryActionConflict");
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "rejects desktop-origin correlation when the predecessor failure code is not source-classification failed",
      () =>
        Effect.gen(function* () {
          const smoke = makeDisposableGitRemote();
          try {
            const cwd = realpathSync(smoke.source);
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description:
                    "Reject a non-source-classification predecessor.",
                  kind: "issue",
                  title: "Desktop-origin predecessor code",
                },
              },
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(
                  smoke.source
                ),
                rootDirectory: cwd,
              }
            );
            yield* continueServerRun(accepted.runId, {
              deliveryPublisher: recordingDeliveryPublisher([]),
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
              rootDirectory: cwd,
            });
            const runId = parseRunId(accepted.runId);
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            const readyEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const contaminatedReady = readyEvents.events.find(
              ({ type }) => type === "DELIVERY_READY_TO_PUBLISH"
            );
            if (contaminatedReady === undefined)
              assert.fail("Expected contaminated ready evidence.");
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const recoveredTurnDigest = digest("turn-test-worker");
            const provenanceDigest = deliveryProvenanceDigest({
              baseBranch: "main",
              baseRevision: smoke.baseRevision,
              headBranch: `gaia/${runId}`,
              remote: "origin",
            });
            const recoveryBase = {
              actionId: "recover-1",
              attempt: 1 as const,
              expectedFailureSequence: 10,
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              model: "gpt-5.4",
              payloadDigest: "a".repeat(64),
            };
            yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "dispatchConfirmed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const failedRecovery = yield* appendEvent(runId, paths, {
              payload: {
                recovery: encodeWorkerRecoveryReceiptJson({
                  ...recoveryBase,
                  code: "WorkerRecoveryContinuationFailed",
                  message:
                    "The checkpoint turn was interrupted after zero product changes.",
                  nativeTurnIdDigest: recoveredTurnDigest,
                  state: "failed",
                }),
              },
              type: "WORKER_RECOVERY_RECORDED",
            });
            const continuationBase = {
              actionId: "continue-recovery-1",
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedCurrentSequence: failedRecovery.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence: failedRecovery.event.sequence + 1,
            };
            yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  state: "intentRecorded",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const failedContinuation = yield* appendEvent(runId, paths, {
              payload: {
                continuation: encodeWorkerContinuationReceiptJson({
                  ...continuationBase,
                  code: "HarnessCorrelationUnavailable",
                  message:
                    "The interrupted checkpoint correlation is unavailable.",
                  state: "failed",
                }),
              },
              type: "WORKER_CONTINUATION_RECORDED",
            });
            const correlationBase = {
              actionId: "reconcile-correlation-1",
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedContinuationActionId: "continue-recovery-1",
              expectedCurrentSequence: failedContinuation.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedContinuationSequence:
                failedContinuation.event.sequence,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedNativeTurnIdDigest: recoveredTurnDigest,
              expectedRecoveryActionId: "recover-1",
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence:
                failedContinuation.event.sequence + 1,
            };
            yield* appendWorkerCorrelationIntent(runId, paths, {
              ...correlationBase,
              state: "intentRecorded",
            });
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...correlationBase,
                    state: "correlationAttempted",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            const failedCorrelation = yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...correlationBase,
                    state: "correlationConfirmed",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            }).pipe(
              Effect.andThen(() =>
                appendEvent(runId, paths, {
                  payload: {
                    reconciliation:
                      encodeWorkerCorrelationReconciliationReceiptJson({
                        ...correlationBase,
                        state: "followUpAttempted",
                      }),
                  },
                  type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
                })
              ),
              Effect.andThen(() =>
                appendEvent(runId, paths, {
                  payload: {
                    reconciliation:
                      encodeWorkerCorrelationReconciliationReceiptJson({
                        ...correlationBase,
                        state: "followUpConfirmed",
                      }),
                  },
                  type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
                })
              ),
              Effect.andThen(() =>
                appendEvent(runId, paths, {
                  payload: {
                    reconciliation:
                      encodeWorkerCorrelationReconciliationReceiptJson({
                        ...correlationBase,
                        code: "WorkerCorrelationContinuationFailed",
                        message:
                          "The follow-up failed after source classification.",
                        state: "failed",
                      }),
                  },
                  type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
                })
              )
            );
            const before = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const action = WorkerDesktopOriginCorrelationAction.make({
              actionId: parseWorkerRecoveryActionId(
                "reconcile-desktop-origin-1"
              ),
              expectedContaminatedReadySequence: contaminatedReady.sequence,
              expectedContinuationActionId: parseWorkerRecoveryActionId(
                "continue-recovery-1"
              ),
              expectedCorrelationActionId: parseWorkerRecoveryActionId(
                "reconcile-correlation-1"
              ),
              expectedCurrentSequence: failedCorrelation.event.sequence,
              expectedDeliveryProvenanceDigest: provenanceDigest,
              expectedFailedContinuationSequence:
                failedContinuation.event.sequence,
              expectedFailedCorrelationSequence:
                failedCorrelation.event.sequence,
              expectedFailedRecoverySequence: failedRecovery.event.sequence,
              expectedNativeTurnIdDigest: recoveredTurnDigest,
              expectedRecoveryActionId:
                parseWorkerRecoveryActionId("recover-1"),
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              kind: "reconcileDesktopOriginatedWorkerCorrelation",
            });

            const error = yield* Effect.flip(
              actOnWorkerDesktopOriginCorrelation(runId, action, {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
                rootDirectory: cwd,
                workerDesktopOriginCorrelationFollowUpDispatcher: () =>
                  Effect.die("must not dispatch"),
                workerDesktopOriginCorrelationReconciler: () =>
                  Effect.die("must not reconcile"),
              })
            );
            const after = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });

            assert.instanceOf(error, GaiaRuntimeError);
            assert.strictEqual(error.code, "DeliveryActionConflict");
            assert.lengthOf(after.events, before.events.length);
            assert.notInclude(
              after.events.map(({ type }) => type),
              "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED"
            );
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "rejects audited continuation before intent when historical recovery evidence is missing",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-audited-continuation-preflight-",
          });
          const accepted = yield* acceptServerRun(
            { specMarkdown: "No eligible failed recovery exists.\n" },
            { rootDirectory: cwd }
          );
          const runId = parseRunId(accepted.runId);
          const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
          const action = WorkerContinuationAction.make({
            actionId: parseWorkerRecoveryActionId("continue-recovery-1"),
            expectedContaminatedReadySequence: accepted.eventSequence,
            expectedCurrentSequence: accepted.eventSequence,
            expectedDeliveryProvenanceDigest: parseWorkerRecoveryDigest(
              "c".repeat(64)
            ),
            expectedFailedRecoverySequence: accepted.eventSequence,
            expectedRecoveryActionId: parseWorkerRecoveryActionId("recover-1"),
            expectedSessionId: parseHarnessSessionId(`session-${runId}`),
            harnessProfileId: codexAppServerExecutionSelection.harnessProfileId,
            kind: "continueInterruptedWorkerRecovery",
          });
          let dispatches = 0;
          const error = yield* Effect.flip(
            actOnWorkerContinuation(runId, action, {
              rootDirectory: cwd,
              workerContinuationRunner: () =>
                Effect.sync(() => {
                  dispatches += 1;
                  return {
                    reportPath: paths.reportMarkdown,
                    runDirectory: paths.root,
                    runId,
                    state: "delivering",
                    status: "running",
                  };
                }),
            })
          );
          const events = yield* readLocalRunEvents(runId, {
            rootDirectory: cwd,
          });

          assert.instanceOf(error, GaiaRuntimeError);
          assert.strictEqual(error.code, "DeliveryActionConflict");
          assert.strictEqual(dispatches, 0);
          assert.isFalse(
            events.events.some(
              ({ type }) => type === "WORKER_CONTINUATION_RECORDED"
            )
          );
        })
    );

    it.effect(
      "marks ambiguous audited correlation follow-up restarts outcomeUnknown without redispatch",
      () =>
        Effect.gen(function* () {
          const smoke = makeDisposableGitRemote();
          try {
            const cwd = realpathSync(smoke.source);
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: "Ambiguous audited correlation.",
                  kind: "issue",
                  title: "Audited correlation ambiguity",
                },
              },
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
                rootDirectory: cwd,
              }
            );
            const runId = parseRunId(accepted.runId);
            const paths = yield* makeRunPaths(runId, { rootDirectory: cwd });
            yield* removeModelInvocationProtocolMarker(paths);
            yield* appendEvent(runId, paths, {
              payload: {
                delivery: {
                  baseBranch: "main",
                  baseRevision: smoke.baseRevision,
                  headBranch: `gaia/${runId}`,
                  mode: "pullRequest",
                  remote: "origin",
                  stage: "delivering",
                },
              },
              type: "DELIVERY_STARTED",
            });
            const sessionId = parseHarnessSessionId(`session-${runId}`);
            const action = WorkerCorrelationReconciliationAction.make({
              actionId: parseWorkerRecoveryActionId("reconcile-correlation-1"),
              expectedContaminatedReadySequence: accepted.eventSequence,
              expectedContinuationActionId: parseWorkerRecoveryActionId(
                "continue-recovery-1"
              ),
              expectedCurrentSequence: accepted.eventSequence,
              expectedDeliveryProvenanceDigest: parseWorkerRecoveryDigest(
                "c".repeat(64)
              ),
              expectedFailedContinuationSequence: accepted.eventSequence,
              expectedFailedRecoverySequence: accepted.eventSequence,
              expectedNativeTurnIdDigest: parseWorkerRecoveryDigest(
                "d".repeat(64)
              ),
              expectedRecoveryActionId:
                parseWorkerRecoveryActionId("recover-1"),
              expectedSessionId: sessionId,
              harnessProfileId:
                codexAppServerExecutionSelection.harnessProfileId,
              kind: "reconcileInterruptedWorkerCorrelation",
            });
            const base = {
              actionId: action.actionId,
              expectedContaminatedReadySequence:
                action.expectedContaminatedReadySequence,
              expectedContinuationActionId: action.expectedContinuationActionId,
              expectedCurrentSequence: action.expectedCurrentSequence,
              expectedDeliveryProvenanceDigest:
                action.expectedDeliveryProvenanceDigest,
              expectedFailedContinuationSequence:
                action.expectedFailedContinuationSequence,
              expectedFailedRecoverySequence:
                action.expectedFailedRecoverySequence,
              expectedNativeTurnIdDigest: action.expectedNativeTurnIdDigest,
              expectedRecoveryActionId: action.expectedRecoveryActionId,
              expectedSessionId: action.expectedSessionId,
              harnessProfileId: action.harnessProfileId,
              maxAttempts: 1 as const,
              workerEvidenceEpochSequence: accepted.eventSequence + 1,
            };
            yield* appendWorkerCorrelationIntent(runId, paths, {
              ...base,
              state: "intentRecorded",
            });
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...base,
                    state: "correlationAttempted",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...base,
                    state: "correlationConfirmed",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });
            yield* appendEvent(runId, paths, {
              payload: {
                reconciliation:
                  encodeWorkerCorrelationReconciliationReceiptJson({
                    ...base,
                    state: "followUpAttempted",
                  }),
              },
              type: "WORKER_CORRELATION_RECONCILIATION_RECORDED",
            });

            let dispatches = 0;
            const receipt = yield* actOnWorkerCorrelationReconciliation(
              runId,
              action,
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
                rootDirectory: cwd,
                workerCorrelationFollowUpDispatcher: () =>
                  Effect.sync(() => {
                    dispatches += 1;
                  }),
                workerCorrelationReconciler: () =>
                  Effect.sync(() => {
                    dispatches += 1;
                  }),
              }
            );
            const events = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });
            const reconciliationStates = events.events.flatMap((event) =>
              event.type === "WORKER_CORRELATION_RECONCILIATION_RECORDED"
                ? [
                    decodeWorkerCorrelationEventPayload(event.payload)
                      .reconciliation.state,
                  ]
                : []
            );
            const replayEventCount = events.events.length;
            const replayReceipt = yield* actOnWorkerCorrelationReconciliation(
              runId,
              action,
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(cwd),
                rootDirectory: cwd,
                workerCorrelationFollowUpDispatcher: () =>
                  Effect.die("must not redispatch ambiguous follow-up"),
                workerCorrelationReconciler: () =>
                  Effect.die("must not reconcile ambiguous follow-up"),
              }
            );
            const replayedEvents = yield* readLocalRunEvents(runId, {
              rootDirectory: cwd,
            });

            assert.strictEqual(receipt.state, "outcomeUnknown");
            assert.strictEqual(replayReceipt.state, "outcomeUnknown");
            assert.strictEqual(dispatches, 0);
            assert.deepEqual(reconciliationStates, [
              "intentRecorded",
              "correlationAttempted",
              "correlationConfirmed",
              "followUpAttempted",
              "outcomeUnknown",
            ]);
            assert.lengthOf(replayedEvents.events, replayEventCount);
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "fails closed when an unrelated same-head clone forges ownership evidence",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const smoke = makeDisposableGitRemote();
          try {
            const source = realpathSync(smoke.source);
            const runId = parseRunId("run-WrongRepo1");
            const paths = yield* makeRunPaths(runId, { rootDirectory: source });
            const provenance = {
              baseBranch: "main",
              baseRevision: smoke.baseRevision,
              headBranch: "gaia/run-WrongRepo1",
              mode: "pullRequest" as const,
              remote: "origin",
            };
            yield* fs.makeDirectory(paths.root, { recursive: true });

            yield* prepareDeliveryWorktree({
              options: { rootDirectory: source },
              paths,
              provenance,
            });
            const manifest = JSON.parse(
              readFileSync(paths.deliveryOwnershipManifest, "utf8")
            ) as Record<string, unknown>;
            rmSync(paths.workspace, { force: true, recursive: true });
            git(smoke.root, "clone", smoke.bare, paths.workspace);
            git(paths.workspace, "checkout", "--detach", smoke.baseRevision);
            manifest["workspaceRoot"] = paths.workspace;
            manifest["workspaceCommonDir"] = git(
              paths.workspace,
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir"
            );
            writeFileSync(
              paths.deliveryOwnershipManifest,
              `${JSON.stringify(manifest, null, 2)}\n`
            );

            const error = yield* Effect.flip(
              prepareDeliveryWorktree({
                options: { rootDirectory: source },
                paths,
                provenance,
              })
            );

            assert.instanceOf(error, GaiaRuntimeError);
            assert.strictEqual(error.code, "DeliveryWorktreeIdentityMismatch");
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "creates a real disposable detached git worktree without moving the primary checkout",
      () =>
        Effect.gen(function* () {
          const smoke = makeDisposableGitRemote();
          try {
            const primaryBefore = gitState(smoke.source);
            const publicationCalls: Array<string> = [];
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: "Real git worktree smoke.",
                  kind: "issue",
                  title: "Real worktree smoke",
                },
              },
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(
                  smoke.source
                ),
                rootDirectory: smoke.source,
              }
            );
            const summary = yield* continueServerRun(accepted.runId, {
              deliveryPublisher: recordingDeliveryPublisher(publicationCalls),
              harnessProviderRegistry: makeMarkerHarnessProviderRegistry(
                smoke.source
              ),
              rootDirectory: smoke.source,
            });
            const workspace = `${accepted.runDirectory}/workspace`;
            const workspaceHead = git(workspace, "rev-parse", "HEAD");
            const workspaceBranch = git(workspace, "branch", "--show-current");
            const primaryAfter = gitState(smoke.source);

            assert.strictEqual(summary.state, "delivering");
            assert.deepEqual(publicationCalls, [accepted.runId]);
            assert.strictEqual(workspaceHead, smoke.baseRevision);
            assert.strictEqual(workspaceBranch, "");
            assert.deepEqual(primaryAfter, primaryBefore);
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect(
      "fails closed from an unmapped source contract through the public delivery seams",
      () =>
        Effect.gen(function* () {
          const smoke = makeDisposableGitRemote();
          try {
            const accepted = yield* acceptFactoryRun(
              {
                delivery: { mode: "pullRequest" },
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: [
                    "## Acceptance Criteria",
                    "- The requested behavior is delivered.",
                    "",
                    "## Verification",
                    "- Run the behavioral verification suite.",
                  ].join("\n"),
                  kind: "issue",
                  title: "Unmapped proof relationships",
                },
              },
              {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(
                  smoke.source
                ),
                rootDirectory: smoke.source,
              }
            );

            const publicationError = yield* Effect.flip(
              continueServerRun(accepted.runId, {
                harnessProviderRegistry: makeMarkerHarnessProviderRegistry(
                  smoke.source
                ),
                rootDirectory: smoke.source,
              })
            );
            assert.instanceOf(publicationError, GaiaRuntimeError);
            assert.strictEqual(
              publicationError.code,
              "DeliveryNotReadyToPublish"
            );

            const beforeDecision = yield* readLocalRunEvents(accepted.runId, {
              rootDirectory: smoke.source,
            });
            const contractEvent = beforeDecision.events.find(
              ({ type }) => type === "RUN_CONTRACT_RECORDED"
            );
            assert.isDefined(contractEvent);
            const contract = parseRunContract(
              contractEvent?.payload["contract"]
            );
            assert.strictEqual(contract.acceptedOutcomes.length, 1);
            assert.deepEqual(
              contract.acceptedOutcomes[0]?.requiredClaimIds,
              []
            );
            assert.deepEqual(
              contract.acceptedOutcomes[0]?.conditionalClaimIds,
              []
            );
            assert.strictEqual(contract.proofClaims.length, 1);

            const proofEvent = beforeDecision.events.find(
              ({ type }) => type === "RUN_PROOF_RESULT_RECORDED"
            );
            assert.isDefined(proofEvent);
            const proof = parseRunProofResult(
              proofEvent?.payload["result"],
              contract
            );
            assert.strictEqual(proof.aggregate, "completed-unverified");
            assert.strictEqual(proof.results[0]?.status, "not-run");
            assert.isFalse(
              beforeDecision.events.some(({ type }) =>
                type.startsWith("DELIVERY_PUBLICATION_")
              )
            );

            const mergeDecision = yield* recordMergeDecision(accepted.runId, {
              rootDirectory: smoke.source,
            });
            assert.strictEqual(mergeDecision.status, "blocked");
            assert.isTrue(
              mergeDecision.blockers.some(
                ({ kind }) => kind === "run-proof-not-verified"
              )
            );

            const readinessError = yield* Effect.flip(
              actOnDeliveryMerge(
                accepted.runId,
                {
                  actionId: "gaia-144-option-a-readiness",
                  kind: "evaluateMergeReadiness",
                  mergeMethod: "merge",
                },
                { rootDirectory: smoke.source }
              )
            );
            assert.instanceOf(readinessError, GaiaRuntimeError);
            assert.strictEqual(readinessError.code, "DeliveryActionConflict");

            const finalEvents = yield* readLocalRunEvents(accepted.runId, {
              rootDirectory: smoke.source,
            });
            const decisionEvent = finalEvents.events.findLast(
              ({ type }) => type === "MERGE_DECISION_RECORDED"
            );
            assert.isDefined(decisionEvent);
            const persistedDecision = parseMergeDecisionV2(
              decisionEvent?.payload["decision"]
            );
            assert.strictEqual(persistedDecision.status, "blocked");
            assert.strictEqual(persistedDecision.proof.kind, "contract");
            if (persistedDecision.proof.kind !== "contract") return;
            assert.strictEqual(persistedDecision.proof.result.kind, "recorded");
            if (persistedDecision.proof.result.kind !== "recorded") return;
            assert.deepEqual(
              {
                ...persistedDecision.proof,
                result: { ...persistedDecision.proof.result },
              },
              {
                contractDigest: contract.contractDigest,
                contractId: contract.contractId,
                kind: "contract",
                result: {
                  aggregate: "completed-unverified",
                  kind: "recorded",
                  observedTargetDigest: proof.observedTargetDigest,
                  resultDigest: proof.resultDigest,
                  sequence: proof.recordedBy.sequence,
                },
              }
            );
            assert.isFalse(
              finalEvents.events.some(
                ({ type }) => type === "DELIVERY_MERGE_READINESS_RECORDED"
              )
            );
          } finally {
            rmSync(smoke.root, { force: true, recursive: true });
          }
        })
    );

    it.effect("appends RUN_FAILED for expected continuation failures", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({
          prefix: "gaia-server-workflow-",
        });
        const accepted = yield* acceptServerRun(
          { specMarkdown: "Fail this server run during review.\n" },
          { rootDirectory: cwd }
        );
        const reviewer = blockingReviewer();

        const error = yield* Effect.flip(
          continueServerRun(accepted.runId, { reviewer, rootDirectory: cwd })
        );
        const events = yield* readLocalRunEvents(accepted.runId, {
          rootDirectory: cwd,
        });
        const failed = events.events.at(-1);

        assert.isTrue(error instanceof GaiaRuntimeError);
        assert.strictEqual(failed?.type, "RUN_FAILED");
        assert.strictEqual(failed?.payload["code"], "ReviewBlocked");
      })
    );

    it.effect(
      "checkpoints and releases an accepted worker interaction before completion",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-durable-wait-",
          });
          const launchObservation = yield* HarnessLaunchObservationService;
          const observation = HarnessLaunchObservationV1.make({
            approvalPolicy: "on-request",
            cwdMatchesWorkspaceBinding: true,
            model: "gpt-5.6-codex",
            modelProvider: "openai",
            reasoningEffort: "high",
            sandbox: "workspace-write",
            source: "threadRuntimeResult",
          });
          const capabilities = HarnessCapabilities.make({
            ...acceptanceCapabilities,
            approvals: ["command"],
            durableCancellation: true,
            durableInteractionResolution: true,
            durablePause: true,
          });
          const descriptor = HarnessProviderDescriptor.make({
            displayName: "Durable Wait Harness",
            executionModes: ["local"],
            providerId: parseHarnessProviderId("durable-wait"),
          });
          const sessionFor = (
            sessionId: ReturnType<typeof parseHarnessSessionId>
          ): HarnessSession => {
            const turnId = parseHarnessTurnId("turn-durable-wait");
            const events = [
              {
                capabilities,
                kind: "sessionStarted",
                provider: descriptor,
                sessionId,
                state: "running",
              },
              { kind: "turnStarted", sessionId, turnId },
              {
                interaction: {
                  allowedDecisions: ["approve"],
                  command: "pnpm check",
                  interactionId: parseHarnessInteractionId(
                    "interaction-durable-wait"
                  ),
                  itemId: parseHarnessItemId("item-durable-wait"),
                  kind: "commandApproval",
                  requestedAt: "2026-07-22T16:00:00.000Z",
                  turnId,
                  workspacePath: parseWorkspaceRelativePath("."),
                },
                kind: "interactionRequested",
                sessionId,
              },
            ] as const;
            return {
              events: Stream.concat(Stream.fromIterable(events), Stream.never),
              interrupt: Option.some(Effect.void),
              resolveInteraction: () => Effect.void,
              send: () => Effect.succeed(undefined),
              snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
              steer: Option.none(),
            };
          };
          const provider: HarnessProvider = {
            createSession: (request) =>
              launchObservation
                .complete(request.sessionId, observation)
                .pipe(Effect.orDie, Effect.as(sessionFor(request.sessionId))),
            descriptor,
            detect: Effect.succeed({
              auth: { state: "notRequired" },
              capabilities,
              state: "available",
              version: "durable-wait-1",
            }),
            resumeSession: (request) =>
              launchObservation
                .complete(request.sessionId, observation)
                .pipe(Effect.orDie, Effect.as(sessionFor(request.sessionId))),
          };
          const registry = makeHarnessProviderRegistry([
            {
              environmentAssignment: () =>
                Effect.succeed(workerEnvironmentAssignment()),
              launchObservation,
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider,
            },
          ]);
          const accepted = yield* acceptFactoryRun(
            {
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description: "Wait durably for one operator decision.",
                kind: "issue",
                title: "Durable wait proof",
              },
            },
            { harnessProviderRegistry: registry, rootDirectory }
          );

          const fiber = yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry: registry,
            rootDirectory,
          }).pipe(Effect.forkChild);
          const paths = yield* makeRunPaths(accepted.runId, { rootDirectory });
          let events = yield* withRunEventSerialization(
            paths,
            readEvents(paths)
          );
          for (let attempt = 0; attempt < 1_000; attempt += 1) {
            if (events.some(({ type }) => type === "RUN_WAITING_FOR_HUMAN"))
              break;
            yield* Effect.yieldNow;
            events = yield* withRunEventSerialization(paths, readEvents(paths));
          }
          yield* Fiber.interrupt(fiber);

          assert.strictEqual(
            snapshotFromReplay(events).state,
            "waitingForHuman"
          );
          assert.include(
            events.map(({ type }) => type),
            "RUN_WAITING_FOR_HUMAN"
          );
          assert.notInclude(
            events.map(({ type }) => type),
            "WORKER_COMPLETED"
          );
          const reconciled = yield* reconcileInterruptedServerRuns({
            rootDirectory,
          });
          assert.deepEqual(reconciled.reconciledRunIds, []);
          assert.deepEqual(reconciled.resumableRunIds, []);
          const continued = yield* continueServerRun(accepted.runId, {
            rootDirectory,
          });
          assert.strictEqual(continued.state, "waitingForHuman");
        }).pipe(Effect.provide(HarnessLaunchObservationLive))
    );

    it.effect(
      "keeps an ambiguous live pause terminal without failing the server run",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-ambiguous-live-pause-",
          });
          const launchObservation = yield* HarnessLaunchObservationService;
          const observation = HarnessLaunchObservationV1.make({
            approvalPolicy: "on-request",
            cwdMatchesWorkspaceBinding: true,
            model: "gpt-5.6-codex",
            modelProvider: "openai",
            reasoningEffort: "high",
            sandbox: "workspace-write",
            source: "threadRuntimeResult",
          });
          const capabilities = HarnessCapabilities.make({
            ...acceptanceCapabilities,
            durableCancellation: true,
            durableInteractionResolution: true,
            durablePause: true,
          });
          const descriptor = HarnessProviderDescriptor.make({
            displayName: "Ambiguous Live Pause Harness",
            executionModes: ["local"],
            providerId: parseHarnessProviderId("ambiguous-live-pause"),
          });
          const failSession = yield* Deferred.make<void>();
          let interruptCount = 0;
          const sessionFor = (
            sessionId: ReturnType<typeof parseHarnessSessionId>
          ): HarnessSession => {
            const turnId = parseHarnessTurnId("turn-ambiguous-live-pause");
            const initial = [
              {
                capabilities,
                kind: "sessionStarted",
                provider: descriptor,
                sessionId,
                state: "running",
              },
              { kind: "turnStarted", sessionId, turnId },
            ] as const;
            return {
              events: Stream.concat(
                Stream.fromIterable(initial),
                Stream.fromEffect(
                  Deferred.await(failSession).pipe(
                    Effect.flatMap(() =>
                      Effect.fail(
                        HarnessSessionError.make({
                          message:
                            "Live session failed after provider acknowledgement was lost.",
                          providerId: descriptor.providerId,
                        })
                      )
                    )
                  )
                )
              ),
              interrupt: Option.some(
                Effect.sync(() => {
                  interruptCount += 1;
                }).pipe(
                  Effect.andThen(Deferred.succeed(failSession, undefined)),
                  Effect.flatMap(() =>
                    Effect.fail(
                      HarnessActionError.make({
                        actionKind: "interrupt",
                        message: "Provider acknowledgement lost.",
                        providerId: descriptor.providerId,
                      })
                    )
                  )
                )
              ),
              resolveInteraction: () => Effect.void,
              send: () => Effect.succeed(undefined),
              snapshot: Effect.succeed(
                projectHarnessEvents(initial, sessionId)
              ),
              steer: Option.none(),
            };
          };
          const provider: HarnessProvider = {
            createSession: (request) =>
              launchObservation
                .complete(request.sessionId, observation)
                .pipe(Effect.orDie, Effect.as(sessionFor(request.sessionId))),
            descriptor,
            detect: Effect.succeed({
              auth: { state: "notRequired" },
              capabilities,
              state: "available",
              version: "ambiguous-live-pause-1",
            }),
            resumeSession: (request) =>
              launchObservation
                .complete(request.sessionId, observation)
                .pipe(Effect.orDie, Effect.as(sessionFor(request.sessionId))),
          };
          const registry = makeHarnessProviderRegistry([
            {
              environmentAssignment: () =>
                Effect.succeed(workerEnvironmentAssignment()),
              launchObservation,
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider,
            },
          ]);
          const coordinator = makeLiveHarnessSessionCoordinator();
          const accepted = yield* acceptFactoryRun(
            {
              execution: codexAppServerExecutionSelection,
              workflow: "issueDelivery",
              workItem: {
                description:
                  "Never fail or redispatch after a live pause becomes ambiguous.",
                kind: "issue",
                title: "Ambiguous live pause proof",
              },
            },
            { harnessProviderRegistry: registry, rootDirectory }
          );
          const workflow = yield* continueServerRun(accepted.runId, {
            harnessProviderRegistry: registry,
            rootDirectory,
            sessionCoordinator: coordinator,
          }).pipe(Effect.forkChild);
          const paths = yield* makeRunPaths(accepted.runId, { rootDirectory });
          let control: RunControlSnapshot | undefined;
          for (let attempt = 0; attempt < 1_000; attempt += 1) {
            const events = yield* readEvents(paths);
            const initialSessionHistoryRecorded =
              events.filter(
                ({ type }) => type === "HARNESS_SESSION_EVENT_RECORDED"
              ).length >= 2;
            if (!initialSessionHistoryRecorded) {
              yield* Effect.yieldNow;
              continue;
            }
            const observed = yield* Effect.exit(
              readRunControlSnapshot(accepted.runId, { rootDirectory })
            );
            if (observed._tag === "Success") {
              control = observed.value;
              if (control.state === "runningWorker" && control.actionTarget)
                break;
            }
            yield* Effect.yieldNow;
          }
          assert.isDefined(control);
          assert.isDefined(control.actionTarget);
          const action = parseRunControlAction({
            ...control.actionTarget,
            actionId: parseRunControlActionId("action-ambiguous-live-pause"),
            operation: "pause",
            runId: accepted.runId,
          });
          const first = yield* dispatchRunControlAction({
            action,
            options: { rootDirectory, sessionCoordinator: coordinator },
            runId: accepted.runId,
          }).pipe(Effect.flip);
          const workflowExit = yield* Fiber.await(workflow);
          const replay = yield* dispatchRunControlAction({
            action,
            options: { rootDirectory, sessionCoordinator: coordinator },
            runId: accepted.runId,
          }).pipe(Effect.flip);
          const released = yield* coordinator.get({
            agentId: control.actionTarget.workerAgentId,
            runId: accepted.runId,
            sessionId: control.actionTarget.sessionId,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory,
          });
          const eventTypes = events.events.map(({ type }) => type);
          assert.instanceOf(first, GaiaRuntimeError);
          assert.instanceOf(replay, GaiaRuntimeError);
          assert.strictEqual(first.code, "outcomeUnknown");
          assert.strictEqual(replay.code, "outcomeUnknown");
          assert.strictEqual(workflowExit._tag, "Failure");
          assert.strictEqual(interruptCount, 1);
          assert.isUndefined(released);
          assert.deepEqual(
            eventTypes.filter((type) => type.startsWith("RUN_CONTROL_")),
            [
              "RUN_CONTROL_INTENT_RECORDED",
              "RUN_CONTROL_ATTEMPTED",
              "RUN_CONTROL_OUTCOME_UNKNOWN",
            ]
          );
          assert.notInclude(eventTypes, "RUN_FAILED");
          assert.notInclude(eventTypes, "WORKER_COMPLETED");
        }).pipe(Effect.provide(HarnessLaunchObservationLive))
    );

    it.effect(
      "never resumes an accepted run after a control attempt becomes ambiguous",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-ambiguous-control-restart-",
          });
          const launchObservation = yield* HarnessLaunchObservationService;
          const observation = HarnessLaunchObservationV1.make({
            approvalPolicy: "on-request",
            cwdMatchesWorkspaceBinding: true,
            model: "gpt-5.6-codex",
            modelProvider: "openai",
            reasoningEffort: "high",
            sandbox: "workspace-write",
            source: "threadRuntimeResult",
          });
          const capabilities = HarnessCapabilities.make({
            ...acceptanceCapabilities,
            durableCancellation: true,
            durableInteractionResolution: true,
            durablePause: true,
          });
          const descriptor = HarnessProviderDescriptor.make({
            displayName: "Ambiguous Control Harness",
            executionModes: ["local"],
            providerId: parseHarnessProviderId("ambiguous-control"),
          });
          let providerCalls = 0;
          const sessionFor = (
            sessionId: ReturnType<typeof parseHarnessSessionId>
          ): HarnessSession => {
            const events = [
              {
                capabilities,
                kind: "sessionStarted",
                provider: descriptor,
                sessionId,
                state: "running",
              },
            ] as const;
            return {
              events: Stream.concat(Stream.fromIterable(events), Stream.never),
              interrupt: Option.some(Effect.void),
              resolveInteraction: () => Effect.void,
              send: () => Effect.succeed(undefined),
              snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
              steer: Option.none(),
            };
          };
          const provider: HarnessProvider = {
            descriptor,
            createSession: (request) =>
              Effect.sync(() => {
                providerCalls += 1;
              }).pipe(
                Effect.andThen(
                  launchObservation.complete(request.sessionId, observation)
                ),
                Effect.orDie,
                Effect.as(sessionFor(request.sessionId))
              ),
            detect: Effect.sync(() => {
              providerCalls += 1;
              return {
                auth: { state: "authenticated" as const },
                capabilities,
                state: "available" as const,
                version: "ambiguous-control-1",
              };
            }),
            resumeSession: (request) =>
              Effect.sync(() => {
                providerCalls += 1;
              }).pipe(
                Effect.andThen(
                  launchObservation.complete(request.sessionId, observation)
                ),
                Effect.orDie,
                Effect.as(sessionFor(request.sessionId))
              ),
          };
          const registry = makeHarnessProviderRegistry([
            {
              environmentAssignment: () =>
                Effect.succeed(workerEnvironmentAssignment()),
              launchObservation,
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider,
            },
          ]);
          const runIds = [];

          for (const terminalPhase of [
            "RUN_CONTROL_ATTEMPTED",
            "RUN_CONTROL_OUTCOME_UNKNOWN",
          ] as const) {
            const accepted = yield* acceptFactoryRun(
              {
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description:
                    "Do not resume after an ambiguous durable control attempt.",
                  kind: "issue",
                  title: `Ambiguous control ${terminalPhase}`,
                },
              },
              { harnessProviderRegistry: registry, rootDirectory }
            );
            runIds.push(accepted.runId);
            const workflow = yield* continueServerRun(accepted.runId, {
              harnessProviderRegistry: registry,
              rootDirectory,
            }).pipe(Effect.forkChild);
            let snapshot: RunControlSnapshot | undefined;
            for (let attempt = 0; attempt < 1_000; attempt += 1) {
              const observed = yield* Effect.exit(
                readRunControlSnapshot(accepted.runId, { rootDirectory })
              );
              if (
                observed._tag === "Success" &&
                observed.value.state === "runningWorker" &&
                observed.value.actionTarget !== undefined
              ) {
                snapshot = observed.value;
                break;
              }
              yield* Effect.yieldNow;
            }
            assert.isDefined(snapshot);
            assert.isDefined(snapshot.actionTarget);
            const paths = yield* makeRunPaths(accepted.runId, {
              rootDirectory,
            });
            const action = parseRunControlAction({
              ...snapshot.actionTarget,
              actionId: parseRunControlActionId(
                `action-${terminalPhase.toLowerCase()}`
              ),
              operation: "pause",
              runId: accepted.runId,
            });
            const actionBindingDigest = makeRunControlActionBindingDigest({
              actionId: action.actionId,
              authorityId: action.authorityId,
              expectedEventSequence: action.expectedEventSequence,
              operation: action.operation,
              providerId: action.providerId,
              runId: action.runId,
              sessionId: action.sessionId,
              workerAgentId: action.workerAgentId,
              workerStartedSequence: action.workerStartedSequence,
            });
            const control = RunControlEventPayload.make({
              actionBindingDigest,
              actionId: action.actionId,
              authorityId: action.authorityId,
              expectedEventSequence: action.expectedEventSequence,
              operation: action.operation,
              providerId: action.providerId,
              restoreState: Schema.decodeUnknownSync(
                RunControlRestoreStateSchema
              )(snapshot.state),
              sessionId: action.sessionId,
              workerAgentId: action.workerAgentId,
              workerStartedSequence: action.workerStartedSequence,
            });
            const encodedControl = Schema.encodeSync(RunControlEventPayload)(
              control
            );
            yield* appendEvent(accepted.runId, paths, {
              payload: { control: encodedControl },
              type: "RUN_CONTROL_INTENT_RECORDED",
            });
            yield* appendEvent(accepted.runId, paths, {
              payload: { control: encodedControl },
              type: "RUN_CONTROL_ATTEMPTED",
            });
            if (terminalPhase === "RUN_CONTROL_OUTCOME_UNKNOWN")
              yield* appendEvent(accepted.runId, paths, {
                payload: { control: encodedControl },
                type: terminalPhase,
              });
            yield* Fiber.interrupt(workflow);
          }

          const providerCallsBeforeRestart = providerCalls;
          const eventCountsBeforeRestart = yield* Effect.forEach(
            runIds,
            (runId) =>
              readLocalRunEvents(runId, { rootDirectory }).pipe(
                Effect.map(({ events }) => events.length)
              )
          );
          yield* Effect.forEach(
            runIds,
            (runId) =>
              makeRunPaths(runId, { rootDirectory }).pipe(
                Effect.flatMap((paths) =>
                  fs.writeFileString(paths.acceptedRunInput, "{}\n")
                )
              ),
            { discard: true }
          );
          const reconciled = yield* reconcileInterruptedServerRuns({
            rootDirectory,
          });
          assert.deepEqual(reconciled.reconciledRunIds, []);
          assert.deepEqual(reconciled.resumableRunIds, []);

          for (const runId of runIds) {
            const continuation = yield* Effect.flip(
              continueServerRun(runId, { rootDirectory })
            );
            assert.strictEqual(continuation.code, "RunControlOutcomeUnknown");
          }
          assert.strictEqual(providerCalls, providerCallsBeforeRestart);
          const eventCountsAfterRestart = yield* Effect.forEach(
            runIds,
            (runId) =>
              readLocalRunEvents(runId, { rootDirectory }).pipe(
                Effect.map(({ events }) => events.length)
              )
          );
          assert.deepEqual(eventCountsAfterRestart, eventCountsBeforeRestart);
        }).pipe(Effect.provide(HarnessLaunchObservationLive))
    );

    it.effect(
      "marks unfinished accepted server runs interrupted on startup reconciliation",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-server-workflow-",
          });
          const accepted = yield* acceptServerRun(
            { specMarkdown: "Interrupt this server run.\n" },
            { rootDirectory: cwd }
          );

          const reconciled = yield* reconcileInterruptedServerRuns({
            rootDirectory: cwd,
          });
          const events = yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          });
          const failed = events.events.at(-1);

          assert.deepEqual(reconciled.reconciledRunIds, [accepted.runId]);
          assert.strictEqual(failed?.type, "RUN_FAILED");
          assert.strictEqual(
            failed?.payload["code"],
            "ServerExecutionInterrupted"
          );
          assert.strictEqual(failed?.payload["stage"], "preparingWorkspace");
        })
    );

    it.effect(
      "prepares and continues one accepted strict-V2 factory run without a reference run",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-strict-v2-same-run-",
          });
          let providerDispatches = 0;
          const provider: HarnessProvider = {
            ...acceptanceProvider,
            createSession: (...args) => {
              providerDispatches += 1;
              return acceptanceProvider.createSession(...args);
            },
            resumeSession: (...args) => {
              providerDispatches += 1;
              return acceptanceProvider.resumeSession(...args);
            },
          };
          const options = {
            harnessProviderRegistry: makeHarnessProviderRegistry([
              {
                environmentAssignment: () =>
                  Effect.succeed(workerEnvironmentAssignment()),
                profileId: codexAppServerExecutionSelection.harnessProfileId,
                provider,
              },
            ]),
            rootDirectory: cwd,
          };
          const accepted = yield* acceptPreparedFactoryRun(
            yield* prepareFactoryRunAcceptance(
              {
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: readFileSync(
                    `${process.cwd()}/../../examples/specs/claim-verification-v2.md`,
                    "utf8"
                  ),
                  kind: "issue",
                  title: "Prepare one strict V2 run",
                },
              },
              options
            ),
            options
          );
          const prepared = yield* prepareStrictV2HarnessRun(
            accepted.runId,
            {
              evaluationId: "evaluation-implementation-completes",
              externalConditionDescriptor: "test-owned-local-host",
              grader: { id: "grader.fixed", version: "1" },
              interventionWithheld: "runtimeRevision",
              limitations: ["singleLocalHost"],
              manifestId: "same-run-strict-v2",
              role: "baseline",
              scenario: { id: "implementation-completes", version: 1 },
              stopConditions: ["unknownExternalOutcome"],
            },
            options
          );
          const events = (yield* readLocalRunEvents(accepted.runId, options))
            .events;
          assert.strictEqual(
            prepared.receipt.preparationBinding.runId,
            accepted.runId
          );
          assert.strictEqual(
            prepared.receipt.manifestRef.ownerRunId,
            accepted.runId
          );
          assert.strictEqual(
            events.filter(
              ({ type }) => type === "HARNESS_BASELINE_MANIFEST_RECORDED"
            ).length,
            1
          );
          assert.strictEqual(
            events.filter(
              ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
            ).length,
            1
          );
          const replayed = yield* prepareStrictV2HarnessRun(
            accepted.runId,
            {
              evaluationId: "evaluation-implementation-completes",
              externalConditionDescriptor: "test-owned-local-host",
              grader: { id: "grader.fixed", version: "1" },
              interventionWithheld: "runtimeRevision",
              limitations: ["singleLocalHost"],
              manifestId: "same-run-strict-v2",
              role: "baseline",
              scenario: { id: "implementation-completes", version: 1 },
              stopConditions: ["unknownExternalOutcome"],
            },
            options
          );
          const replayedEvents = (yield* readLocalRunEvents(
            accepted.runId,
            options
          )).events;
          assert.deepEqual(replayed.receiptRef, prepared.receiptRef);
          assert.strictEqual(
            replayedEvents.filter(
              ({ type }) => type === "HARNESS_BASELINE_MANIFEST_RECORDED"
            ).length,
            1
          );
          assert.strictEqual(
            replayedEvents.filter(
              ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
            ).length,
            1
          );
          const conflict = yield* Effect.flip(
            prepareStrictV2HarnessRun(
              accepted.runId,
              {
                evaluationId: "evaluation-implementation-completes",
                externalConditionDescriptor: "different-test-owned-host",
                grader: { id: "grader.fixed", version: "1" },
                interventionWithheld: "runtimeRevision",
                limitations: ["singleLocalHost"],
                manifestId: "same-run-strict-v2",
                role: "baseline",
                scenario: { id: "implementation-completes", version: 1 },
                stopConditions: ["unknownExternalOutcome"],
              },
              options
            )
          );
          assert.strictEqual(
            conflict.code,
            "HarnessPreparedRunRequestConflict"
          );
          assert.deepEqual(
            (yield* readLocalRunEvents(accepted.runId, options)).events,
            replayedEvents
          );
          assert.strictEqual(
            events.some(({ type }) => type === "WORKER_STARTED"),
            false
          );
          assert.strictEqual(providerDispatches, 0);

          const error = yield* Effect.flip(
            continuePreparedStrictV2HarnessRun(accepted.runId, {
              ...options,
              reviewer: blockingReviewer(),
            })
          );
          assert.strictEqual(error.code, "ReviewBlocked");
          assert.strictEqual(providerDispatches, 0);
        })
    );

    it.effect(
      "records the prepared worker episode before committing strict-V2 launch evidence",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const rootDirectory = yield* fs.makeTempDirectory({
            prefix: "gaia-strict-v2-prepared-environment-",
          });
          const launchObservation = yield* HarnessLaunchObservationService;
          const observation = HarnessLaunchObservationV1.make({
            approvalPolicy: "on-request",
            cwdMatchesWorkspaceBinding: true,
            model: "gpt-5.6-codex",
            modelProvider: "openai",
            reasoningEffort: "high",
            sandbox: "workspace-write",
            source: "threadRuntimeResult",
          });
          let providerDispatches = 0;
          const profile = yield* readVerificationExecutionProfile(
            parseRuntimePath(
              `${process.cwd()}/../../profiles/claim-verification.json`
            )
          );
          const verificationServices = {
            executor: {
              execute: (invocation) =>
                Effect.gen(function* () {
                  const sandboxUuid = "123e4567-e89b-12d3-a456-426614174001";
                  yield* invocation.onSandboxCreated({
                    sandboxName: invocation.sandboxName,
                    sandboxUuid,
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
                      finalAbsenceConfirmed: true,
                      removedSandboxUuid: sandboxUuid,
                      stoppedSandboxUuid: sandboxUuid,
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
                    sandboxUuid,
                    status: "succeeded",
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
              reconcile: () => Effect.die("must not reconcile"),
            },
            profile,
          } satisfies VerificationServices;
          const recordMarker = (request: {
            readonly sessionId: string;
            readonly workspacePath: string;
          }) =>
            Effect.sync(() => {
              const workspace = join(rootDirectory, request.workspacePath);
              mkdirSync(workspace, { recursive: true });
              writeFileSync(
                join(workspace, "output.txt"),
                `${request.sessionId.slice("session-".length)}\n`
              );
            });
          const startSession = (
            request: Parameters<HarnessProvider["createSession"]>[0]
          ) =>
            Effect.sync(() => {
              providerDispatches += 1;
            }).pipe(
              Effect.andThen(
                launchObservation
                  .complete(request.sessionId, observation)
                  .pipe(Effect.orDie)
              ),
              Effect.andThen(recordMarker(request)),
              Effect.andThen(testHarnessProvider.createSession(request))
            );
          const provider: HarnessProvider = {
            ...testHarnessProvider,
            createSession: startSession,
            resumeSession: (request) =>
              Effect.sync(() => {
                providerDispatches += 1;
              }).pipe(
                Effect.andThen(
                  launchObservation
                    .complete(request.sessionId, observation)
                    .pipe(Effect.orDie)
                ),
                Effect.andThen(recordMarker(request)),
                Effect.andThen(testHarnessProvider.resumeSession(request))
              ),
          };
          const options = {
            harnessProviderRegistry: makeHarnessProviderRegistry([
              {
                environmentAssignment: () =>
                  Effect.succeed(workerEnvironmentAssignment()),
                launchObservation,
                profileId: codexAppServerExecutionSelection.harnessProfileId,
                provider,
              },
            ]),
            rootDirectory,
            verificationServices,
          };
          const accepted = yield* acceptPreparedFactoryRun(
            yield* prepareFactoryRunAcceptance(
              {
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: readFileSync(
                    `${process.cwd()}/../../examples/specs/claim-verification-v2.md`,
                    "utf8"
                  ),
                  kind: "issue",
                  title: "Commit strict V2 launch evidence",
                },
              },
              options
            ),
            options
          );
          yield* prepareStrictV2HarnessRun(
            accepted.runId,
            strictV2BaselineRequest("runtimeRevision", "environment"),
            options
          );

          yield* continuePreparedStrictV2HarnessRun(accepted.runId, options);

          const paths = yield* makeRunPaths(accepted.runId, options);
          const events = yield* readEvents(paths);
          const workerStart = events.find(
            ({ type }) => type === "WORKER_STARTED"
          );
          assert.strictEqual(
            workerStart?.payload["modelInvocationEpisode"],
            undefined
          );
          const completion = [...events]
            .reverse()
            .find(({ type }) => type === "WORKER_COMPLETED");
          assert.isDefined(completion?.payload["harnessEnvironmentReceipt"]);
          assert.strictEqual(providerDispatches, 1);

          const missing = yield* acceptPreparedFactoryRun(
            yield* prepareFactoryRunAcceptance(
              {
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: readFileSync(
                    `${process.cwd()}/../../examples/specs/claim-verification-v2.md`,
                    "utf8"
                  ),
                  kind: "issue",
                  title: "Reject a missing strict V2 invocation episode",
                },
              },
              options
            ),
            options
          );
          yield* prepareStrictV2HarnessRun(
            missing.runId,
            strictV2BaselineRequest("runtimeRevision", "missing-episode"),
            options
          );
          const missingPaths = yield* makeRunPaths(missing.runId, options);
          const originalMissingLines = (yield* fs.readFileString(
            missingPaths.events
          ))
            .trimEnd()
            .split("\n");
          const writeMissingEvents = (
            transform: (event: {
              readonly payload: Record<string, unknown>;
              readonly sequence: number;
              readonly type: string;
            }) => {
              readonly payload: Record<string, unknown>;
              readonly sequence: number;
              readonly type: string;
            }
          ) =>
            fs.writeFileString(
              missingPaths.events,
              `${originalMissingLines
                .map((line) => {
                  const event = JSON.parse(line) as {
                    payload: Record<string, unknown>;
                    sequence: number;
                    type: string;
                  };
                  return JSON.stringify(transform(event));
                })
                .join("\n")}\n`
            );
          yield* writeMissingEvents((event) => {
            if (event.type !== "HARNESS_PREPARED_RUN_RECORDED") return event;
            const payload = { ...event.payload };
            delete payload["modelInvocationEpisode"];
            return { ...event, payload };
          });
          const beforeMissingEpisode = providerDispatches;
          yield* Effect.flip(
            continuePreparedStrictV2HarnessRun(missing.runId, options)
          );
          assert.strictEqual(providerDispatches, beforeMissingEpisode);

          const duplicateEvents = originalMissingLines.map(
            (line) =>
              JSON.parse(line) as {
                payload: Record<string, unknown>;
                sequence: number;
                type: string;
              }
          );
          const preparedEvent = duplicateEvents.find(
            ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
          );
          const finalEvent = duplicateEvents.at(-1);
          if (preparedEvent === undefined || finalEvent === undefined)
            return yield* Effect.die(
              "prepared strict-V2 event was not recorded"
            );
          yield* fs.writeFileString(
            missingPaths.events,
            `${[
              ...duplicateEvents,
              { ...preparedEvent, sequence: finalEvent.sequence + 1 },
            ]
              .map((event) => JSON.stringify(event))
              .join("\n")}\n`
          );
          const beforeDuplicateEpisode = providerDispatches;
          yield* Effect.flip(
            continuePreparedStrictV2HarnessRun(missing.runId, options)
          );
          assert.strictEqual(providerDispatches, beforeDuplicateEpisode);

          yield* writeMissingEvents((event) => {
            if (event.type !== "HARNESS_PREPARED_RUN_RECORDED") return event;
            const preparedReceipt = event.payload["harnessPreparedRunReceipt"];
            if (
              preparedReceipt === null ||
              typeof preparedReceipt !== "object" ||
              Array.isArray(preparedReceipt)
            )
              return event;
            return {
              ...event,
              payload: {
                ...event.payload,
                harnessPreparedRunReceipt: {
                  ...preparedReceipt,
                  runId: accepted.runId,
                },
              },
            };
          });
          const beforeMismatchedReceipt = providerDispatches;
          yield* Effect.flip(
            continuePreparedStrictV2HarnessRun(missing.runId, options)
          );
          assert.strictEqual(providerDispatches, beforeMismatchedReceipt);
        }).pipe(Effect.provide(HarnessLaunchObservationLive))
    );

    it.effect(
      "resumes one partial strict-V2 baseline receipt without replaying Phase A",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-strict-v2-partial-preparation-",
          });
          let providerDispatches = 0;
          let reviewerCalls = 0;
          const provider: HarnessProvider = {
            ...acceptanceProvider,
            createSession: (...args) => {
              providerDispatches += 1;
              return acceptanceProvider.createSession(...args);
            },
            resumeSession: (...args) => {
              providerDispatches += 1;
              return acceptanceProvider.resumeSession(...args);
            },
          };
          const reviewer = blockingReviewer();
          const options = {
            harnessProviderRegistry: makeHarnessProviderRegistry([
              {
                environmentAssignment: () =>
                  Effect.succeed(workerEnvironmentAssignment()),
                profileId: codexAppServerExecutionSelection.harnessProfileId,
                provider,
              },
            ]),
            reviewer: {
              ...reviewer,
              run: (request: Parameters<GaiaReviewer["run"]>[0]) =>
                Effect.sync(() => {
                  reviewerCalls += 1;
                }).pipe(Effect.andThen(reviewer.run(request))),
            },
            rootDirectory: cwd,
          };
          const accepted = yield* acceptPreparedFactoryRun(
            yield* prepareFactoryRunAcceptance(
              {
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: readFileSync(
                    `${process.cwd()}/../../examples/specs/claim-verification-v2.md`,
                    "utf8"
                  ),
                  kind: "issue",
                  title: "Resume one partial strict V2 preparation",
                },
              },
              options
            ),
            options
          );
          const request = strictV2BaselineRequest(
            "runtimeRevision",
            "partial-receipt"
          );
          yield* TestClock.setTime(1_000);
          const initial = yield* prepareStrictV2HarnessRun(
            accepted.runId,
            request,
            options
          );
          const paths = yield* makeRunPaths(accepted.runId, options);
          const completeEvents = yield* readEvents(paths);
          const manifestEvent = completeEvents.find(
            ({ type }) => type === "HARNESS_BASELINE_MANIFEST_RECORDED"
          );
          const receiptEventIndex = completeEvents.findIndex(
            ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
          );
          assert.notStrictEqual(manifestEvent, undefined);
          assert.notStrictEqual(receiptEventIndex, -1);
          const manifestBody = yield* canonicalHarnessBaselineManifestBody(
            accepted.runId,
            options
          );
          const artifactsBefore = snapshotStrictV2PreparationArtifacts(paths);
          const modelInvocationsBefore =
            snapshotAuditedActionEvidence(paths).modelInvocations;
          yield* fs.writeFileString(
            paths.events,
            `${completeEvents
              .slice(0, receiptEventIndex)
              .map((event) => JSON.stringify(event))
              .join("\n")}\n`
          );
          yield* TestClock.setTime(2_000);

          const resumed = yield* prepareStrictV2HarnessRun(
            accepted.runId,
            request,
            options
          );
          const resumedEvents = yield* readEvents(paths);
          assert.strictEqual(
            resumedEvents.filter(({ type }) => type === "RUN_CONTRACT_RECORDED")
              .length,
            1
          );
          assert.strictEqual(
            resumedEvents.filter(
              ({ type }) => type === "HARNESS_BASELINE_MANIFEST_RECORDED"
            ).length,
            1
          );
          assert.strictEqual(
            resumedEvents.filter(
              ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
            ).length,
            1
          );
          assert.deepEqual(
            resumed.receipt.manifestRef,
            initial.receipt.manifestRef
          );
          assert.strictEqual(
            yield* canonicalHarnessBaselineManifestBody(
              accepted.runId,
              options
            ),
            manifestBody
          );
          assert.deepEqual(
            snapshotStrictV2PreparationArtifacts(paths),
            artifactsBefore
          );
          assert.deepEqual(
            snapshotAuditedActionEvidence(paths).modelInvocations,
            modelInvocationsBefore
          );
          assert.deepEqual(
            resumedEvents.filter(({ type }) =>
              [
                "HARNESS_SESSION_EVENT_RECORDED",
                "REVIEW_STARTED",
                "WORKER_CORRELATION_RECONCILIATION_RECORDED",
                "WORKER_DESKTOP_ORIGIN_CORRELATION_RECORDED",
                "WORKER_STARTED",
              ].includes(type)
            ),
            []
          );
          assert.strictEqual(providerDispatches, 0);
          assert.strictEqual(reviewerCalls, 0);
        })
    );

    it.effect(
      "prepares both strict-V2 treatment families through the public same-run seam",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-strict-v2-public-treatments-",
          });
          let providerDispatches = 0;
          let reviewerCalls = 0;
          const provider: HarnessProvider = {
            ...acceptanceProvider,
            createSession: (...args) => {
              providerDispatches += 1;
              return acceptanceProvider.createSession(...args);
            },
            resumeSession: (...args) => {
              providerDispatches += 1;
              return acceptanceProvider.resumeSession(...args);
            },
          };
          const baseRegistry = makeHarnessProviderRegistry([
            {
              environmentAssignment: () =>
                Effect.succeed(workerEnvironmentAssignment()),
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider,
            },
          ]);
          const revisedRegistry = makeHarnessProviderRegistry([
            {
              environmentAssignment: () =>
                Effect.succeed(runtimeRevisionEnvironmentAssignment()),
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider,
            },
          ]);
          const factoryInput = (title: string) => ({
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery" as const,
            workItem: {
              description: readFileSync(
                `${process.cwd()}/../../examples/specs/claim-verification-v2.md`,
                "utf8"
              ),
              kind: "issue" as const,
              title,
            },
          });
          const accept = (
            title: string,
            harnessProviderRegistry = baseRegistry
          ) =>
            prepareFactoryRunAcceptance(factoryInput(title), {
              harnessProviderRegistry,
              rootDirectory: cwd,
            }).pipe(
              Effect.flatMap((prepared) =>
                acceptPreparedFactoryRun(prepared, {
                  harnessProviderRegistry,
                  rootDirectory: cwd,
                })
              )
            );
          const baselineOptions = {
            harnessProviderRegistry: baseRegistry,
            rootDirectory: cwd,
          };
          const revisionBaseline = yield* accept("Runtime revision baseline");
          const revisionBaselinePrepared = yield* prepareStrictV2HarnessRun(
            revisionBaseline.runId,
            strictV2BaselineRequest("runtimeRevision", "runtime-revision"),
            baselineOptions
          );
          const revisionTreatment = yield* accept(
            "Runtime revision treatment",
            revisedRegistry
          );
          const revisionRequest = {
            intervention: {
              baselineRuntimeRevision:
                revisionBaselinePrepared.receipt.preparedInputs.runtimeRevision,
              baselineSemanticContractDigest:
                revisionBaselinePrepared.receipt.preparedInputs
                  .providerInterfaceDigest,
              kind: "runtimeRevision" as const,
              treatmentRuntimeRevision:
                runtimeRevisionEnvironmentAssignment().runtimeSource.revision,
              treatmentSemanticContractDigest:
                runtimeRevisionEnvironmentAssignment().adapter.contractDigest,
              version: 1 as const,
            },
            manifestRef: revisionBaselinePrepared.receipt.manifestRef,
            repetition: 1,
            role: "treatment" as const,
          };
          const revisionPrepared = yield* prepareStrictV2HarnessRun(
            revisionTreatment.runId,
            revisionRequest,
            { harnessProviderRegistry: revisedRegistry, rootDirectory: cwd }
          );
          const revisionDelta = Object.keys(
            revisionPrepared.receipt.preparedInputs
          ).filter(
            (key) =>
              revisionPrepared.receipt.preparedInputs[
                key as keyof typeof revisionPrepared.receipt.preparedInputs
              ] !==
              revisionBaselinePrepared.receipt.preparedInputs[
                key as keyof typeof revisionBaselinePrepared.receipt.preparedInputs
              ]
          );
          assert.deepEqual(revisionDelta, [
            "providerInterfaceDigest",
            "runtimeRevision",
          ]);
          const revisionReplayed = yield* prepareStrictV2HarnessRun(
            revisionTreatment.runId,
            revisionRequest,
            { harnessProviderRegistry: revisedRegistry, rootDirectory: cwd }
          );
          assert.deepEqual(
            revisionReplayed.receiptRef,
            revisionPrepared.receiptRef
          );
          const revisionConflict = yield* Effect.flip(
            prepareStrictV2HarnessRun(
              revisionTreatment.runId,
              {
                ...revisionRequest,
                intervention: {
                  ...revisionRequest.intervention,
                  treatmentSemanticContractDigest: "e".repeat(64),
                },
              },
              { harnessProviderRegistry: revisedRegistry, rootDirectory: cwd }
            )
          );
          assert.strictEqual(
            revisionConflict.code,
            "HarnessPreparedRunRequestConflict"
          );

          const lesson = yield* seedReviewedFactoryLesson(cwd);
          const promotedBaseline = yield* accept("Promoted control baseline");
          const promotedBaselinePrepared = yield* prepareStrictV2HarnessRun(
            promotedBaseline.runId,
            strictV2BaselineRequest("promotedControl", "promoted-control"),
            baselineOptions
          );
          const promotedTreatment = yield* accept("Promoted control treatment");
          const promotedRequest = {
            intervention: {
              kind: "promotedControl" as const,
              lessonId: lesson.lessonId,
              projectionDigest: lesson.projectionDigest,
              version: 1 as const,
            },
            manifestRef: promotedBaselinePrepared.receipt.manifestRef,
            repetition: 1,
            role: "treatment" as const,
          };
          const promotedPrepared = yield* prepareStrictV2HarnessRun(
            promotedTreatment.runId,
            promotedRequest,
            baselineOptions
          );
          assert.strictEqual(
            promotedPrepared.receipt.lessonSelectionDigest === undefined,
            false
          );
          assert.strictEqual(
            promotedPrepared.receipt.preparationBinding.role,
            "treatment"
          );
          if (promotedPrepared.receipt.preparationBinding.role !== "treatment")
            return yield* Effect.die(
              "Expected promoted-control treatment binding."
            );
          assert.deepEqual(
            promotedPrepared.receipt.preparationBinding.intervention,
            promotedRequest.intervention
          );

          const rebound = yield* Effect.flip(
            prepareStrictV2HarnessRun(
              promotedBaseline.runId,
              promotedRequest,
              baselineOptions
            )
          );
          assert.strictEqual(rebound.code, "HarnessPreparedRunRequestConflict");
          const reboundTarget = yield* accept(
            "Promoted control rebound target"
          );
          const reboundManifest = yield* Effect.flip(
            prepareStrictV2HarnessRun(
              reboundTarget.runId,
              {
                ...promotedRequest,
                manifestRef: Schema.decodeUnknownSync(
                  HarnessBaselineManifestRefV1
                )({
                  ...promotedRequest.manifestRef,
                  manifestDigest: "f".repeat(64),
                }),
              },
              baselineOptions
            )
          );
          assert.strictEqual(
            reboundManifest.code,
            "HarnessBaselineManifestRefRebound"
          );
          assert.strictEqual(providerDispatches, 0);
          assert.strictEqual(reviewerCalls, 0);

          const reviewer = blockingReviewer();
          const continuation = yield* Effect.flip(
            continuePreparedStrictV2HarnessRun(promotedTreatment.runId, {
              ...baselineOptions,
              reviewer: {
                ...reviewer,
                run: (request) =>
                  Effect.sync(() => {
                    reviewerCalls += 1;
                  }).pipe(Effect.andThen(reviewer.run(request))),
              },
            })
          );
          assert.strictEqual(continuation.code, "ReviewBlocked");
          assert.strictEqual(reviewerCalls, 1);
          assert.strictEqual(providerDispatches, 0);
          assert.strictEqual(
            (yield* readLocalRunEvents(
              promotedTreatment.runId,
              baselineOptions
            )).events.some(({ type }) => type === "WORKER_STARTED"),
            false
          );
        })
    );

    it.effect(
      "preserves an accepted factory V2 contract through continuation before provider dispatch",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-v2-continuation-",
          });
          let providerDispatches = 0;
          const provider: HarnessProvider = {
            ...acceptanceProvider,
            createSession: (...args) => {
              providerDispatches += 1;
              return acceptanceProvider.createSession(...args);
            },
            resumeSession: (...args) => {
              providerDispatches += 1;
              return acceptanceProvider.resumeSession(...args);
            },
          };
          const registry = makeHarnessProviderRegistry([
            {
              environmentAssignment: () =>
                Effect.succeed(workerEnvironmentAssignment()),
              profileId: codexAppServerExecutionSelection.harnessProfileId,
              provider,
            },
          ]);
          const factoryInput = {
            execution: codexAppServerExecutionSelection,
            workflow: "issueDelivery" as const,
            workItem: {
              description: readFileSync(
                `${process.cwd()}/../../examples/specs/claim-verification-v2.md`,
                "utf8"
              ),
              kind: "issue" as const,
              title: "Preserve accepted V2 verification",
            },
          };
          const options = {
            harnessProviderRegistry: registry,
            rootDirectory: cwd,
          };
          const reference = yield* acceptPreparedFactoryRun(
            yield* prepareFactoryRunAcceptance(factoryInput, options),
            options
          );
          const referenceError = yield* Effect.flip(
            continueServerRun(reference.runId, {
              ...options,
              reviewer: blockingReviewer(),
            })
          );
          assert.strictEqual(referenceError.code, "ReviewBlocked");
          const referencePaths = yield* makeRunPaths(reference.runId, {
            rootDirectory: cwd,
          });
          const referenceEvents = yield* readEvents(referencePaths);
          const referenceContractEvent = referenceEvents.find(
            ({ type }) => type === "RUN_CONTRACT_RECORDED"
          );
          assert.ok(referenceContractEvent);
          const referenceContract = parseAnyRunContract(
            referenceContractEvent.payload["contract"]
          );
          assert.strictEqual(referenceContract.version, 2);
          if (referenceContract.version !== 2)
            return yield* Effect.die("Expected a V2 reference contract.");
          const workerInitialContext = readdirSync(
            referencePaths.modelInvocations,
            { withFileTypes: true }
          )
            .filter((entry) => entry.isDirectory())
            .map((entry) =>
              Schema.decodeUnknownSync(ModelContextManifestV1)(
                JSON.parse(
                  readFileSync(
                    join(
                      referencePaths.modelInvocations,
                      entry.name,
                      "context-manifest.json"
                    ),
                    "utf8"
                  )
                )
              )
            )
            .find(
              ({ payload }) => payload.content.episodeRole === "workerInitial"
            );
          assert.ok(workerInitialContext);
          if (workerInitialContext === undefined)
            return yield* Effect.die(
              "Expected a prepared model invocation episode."
            );
          const assignment = workerEnvironmentAssignment();
          const accepted = yield* acceptPreparedFactoryRun(
            yield* prepareFactoryRunAcceptance(factoryInput, options),
            options
          );
          const owner = yield* acceptPreparedFactoryRun(
            yield* prepareFactoryRunAcceptance(
              {
                ...factoryInput,
                workItem: {
                  ...factoryInput.workItem,
                  title: "Own the test baseline manifest",
                },
              },
              options
            ),
            options
          );
          const fileDigest = (path: string) =>
            createHash("sha256").update(readFileSync(path)).digest("hex");
          const manifest = yield* recordHarnessBaselineManifest(
            {
              acceptedOutcome: {
                outcomeId: referenceContract.acceptedOutcomes[0]!.outcomeId,
                proofContractDigest: createHash("sha256")
                  .update(
                    canonicalV1("gaia.harness-proof-contract.v1", [
                      {
                        acceptedOutcomes: referenceContract.acceptedOutcomes,
                        proofClaims: referenceContract.proofClaims,
                        specDigest: referenceContract.specDigest,
                        version: referenceContract.version,
                      },
                    ])
                  )
                  .digest("hex"),
                version: 2,
              },
              authorityDigest: assignment.authority.workspaceBindingDigest,
              baseDigest: referenceContract.baseDigest,
              contextDigest: workerInitialContext.payload.contextContentDigest,
              evaluationId: "evaluation-implementation-completes",
              externalCondition: {
                descriptor: "test-owned-local-host",
                digest: "f".repeat(64),
              },
              freshSessionPolicy: "globallyDistinct",
              grader: { id: "grader.fixed", version: "1" },
              interventionWithheld: "runtimeRevision",
              limitations: ["singleLocalHost"],
              manifestId: "baseline-factory-continuation",
              model: assignment.model,
              ownerRunId: owner.runId,
              plannedBaselineRunIds: [accepted.runId],
              plannedRepetitions: 1,
              profileDigest: fileDigest(referencePaths.runProfile),
              providerInterfaceDigest: assignment.adapter.contractDigest,
              recordedAt: "2026-07-27T00:00:00.000Z",
              runtimeRevision: assignment.runtimeSource.revision,
              scenario: { id: "implementation-completes", version: 1 },
              skillManifestDigest: fileDigest(referencePaths.skillManifest),
              stopConditions: ["unknownExternalOutcome"],
              targetDigest: referenceContract.targetDigest,
              worker: {
                capabilityEpoch: assignment.effectDependencyEpoch,
                id: provider.descriptor.providerId,
              },
              workerPlanDigest: digestWorkerPlanEnvironmentSemantics(
                readFileSync(referencePaths.workerPlanResult, "utf8")
              ),
            },
            { rootDirectory: cwd }
          );

          const error = yield* Effect.flip(
            continueServerRun(accepted.runId, {
              ...options,
              harnessPreparationBinding: {
                manifestRef: manifest.ref,
                repetition: 1,
                role: "baseline",
                runId: accepted.runId,
              },
              reviewer: blockingReviewer(),
            })
          );
          const events = (yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          })).events;
          const contractEvent = events.find(
            ({ type }) => type === "RUN_CONTRACT_RECORDED"
          );
          const preparedEvent = events.find(
            ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
          );
          const failedEvent = events.at(-1);
          assert.strictEqual(error.code, "ReviewBlocked");
          assert.ok(contractEvent);
          assert.ok(preparedEvent);
          assert.strictEqual(failedEvent?.type, "RUN_FAILED");
          if (failedEvent === undefined)
            return yield* Effect.die("Expected a terminal run failure.");
          assert.isBelow(contractEvent.sequence, preparedEvent.sequence);
          assert.isBelow(preparedEvent.sequence, failedEvent.sequence);
          assert.strictEqual(
            parseAnyRunContract(contractEvent.payload["contract"]).version,
            2
          );
          assert.strictEqual(failedEvent.payload["code"], "ReviewBlocked");
          assert.strictEqual(providerDispatches, 0);
        })
    );

    it.effect(
      "preserves an accepted factory legacy work-item V1 contract through public continuation",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectory({
            prefix: "gaia-factory-v1-continuation-",
          });
          let providerDispatches = 0;
          const provider: HarnessProvider = {
            ...acceptanceProvider,
            createSession: (...args) => {
              providerDispatches += 1;
              return acceptanceProvider.createSession(...args);
            },
            resumeSession: (...args) => {
              providerDispatches += 1;
              return acceptanceProvider.resumeSession(...args);
            },
          };
          const options = {
            harnessProviderRegistry: makeHarnessProviderRegistry([
              {
                environmentAssignment: () =>
                  Effect.succeed(workerEnvironmentAssignment()),
                profileId: codexAppServerExecutionSelection.harnessProfileId,
                provider,
              },
            ]),
            rootDirectory: cwd,
          };
          const accepted = yield* acceptPreparedFactoryRun(
            yield* prepareFactoryRunAcceptance(
              {
                execution: codexAppServerExecutionSelection,
                workflow: "issueDelivery",
                workItem: {
                  description: "Preserve the accepted legacy factory input.",
                  kind: "issue",
                  title: "Preserve accepted V1 verification",
                },
              },
              options
            ),
            options
          );

          const error = yield* Effect.flip(
            continueServerRun(accepted.runId, {
              ...options,
              reviewer: blockingReviewer(),
            })
          );
          const events = (yield* readLocalRunEvents(accepted.runId, {
            rootDirectory: cwd,
          })).events;
          const contractEvent = events.find(
            ({ type }) => type === "RUN_CONTRACT_RECORDED"
          );

          assert.strictEqual(error.code, "ReviewBlocked");
          assert.ok(contractEvent);
          assert.strictEqual(
            parseAnyRunContract(contractEvent.payload["contract"]).version,
            1
          );
          assert.strictEqual(providerDispatches, 0);
        })
    );
  });
});

function postPublicationOnlyV2Spec() {
  const outcome =
    "The audited continuation remains bound to its accepted V2 contract.";
  const claim = "Paired local reviewer approves the published exact head.";
  return [
    "---",
    "title: Audited V2 continuation",
    "verification:",
    "  version: 2",
    "  outcomes:",
    "    - key: audited-continuation",
    `      statement: ${outcome}`,
    `      sourceItemDigest: ${deriveExplicitSpecItemDigest({
      section: "acceptanceCriteria",
      statement: outcome,
    })}`,
    "      prePublicationRequiredClaims: []",
    "      postPublicationRequiredClaims: [paired-review]",
    "      conditionalClaims: []",
    "  claims:",
    "    - key: paired-review",
    `      statement: ${claim}`,
    `      sourceItemDigest: ${deriveExplicitSpecItemDigest({
      section: "verificationChecks",
      statement: claim,
    })}`,
    "      phase: postPublication",
    "      kind: human-judgment",
    "      selector:",
    "        source: localOperatorPairedReview",
    "        decision: approved",
    "---",
    "",
    "## Acceptance Criteria",
    "",
    `- ${outcome}`,
    "",
    "## Verification",
    "",
    `- ${claim}`,
    "",
  ].join("\n");
}

const acceptanceCapabilities = HarnessCapabilities.make({
  approvals: [],
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: false,
  streamingMessages: true,
  structuredOutput: false,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: false,
});

function workerEnvironmentAssignment() {
  return {
    adapter: {
      contractDigest: "a".repeat(64),
      contractId: "gaia.codex-app-server",
      contractVersion: "1",
      providerNativeToolInventoryObservation: "notExposed" as const,
      toolContractDigest: "b".repeat(64),
    },
    authority: {
      approvalPolicy: "on-request" as const,
      ephemeral: false as const,
      sandbox: "workspace-write" as const,
      workspaceBindingDigest: digestHarnessEnvironmentContract(
        "gaia.worker-workspace-authority.v1",
        ["cill-i-am/gaia", ".gaia/runs/<runId>/workspace"]
      ),
    },
    effectDependencyEpoch: "4.0.0-beta.93" as const,
    hostClass: "localGaiaServer" as const,
    interfaceClass: "codexAppServerStdio" as const,
    model: {
      id: "gpt-5.6-codex",
      provider: "openai",
      reasoningEffort: "high",
    },
    runtimeSource: {
      repositoryIdentity: "cill-i-am/gaia",
      revision: "6cc2350063cec02229fde3669af0f67a8cc3497a",
      sourceState: "clean" as const,
    },
    version: 1 as const,
  };
}

function runtimeRevisionEnvironmentAssignment() {
  const assignment = workerEnvironmentAssignment();
  return {
    ...assignment,
    adapter: {
      ...assignment.adapter,
      contractDigest: "d".repeat(64),
    },
    runtimeSource: {
      ...assignment.runtimeSource,
      revision: "d".repeat(40),
    },
  };
}

function strictV2BaselineRequest(
  interventionWithheld: "promotedControl" | "runtimeRevision",
  suffix: string
) {
  return {
    evaluationId: `evaluation-${suffix}`,
    externalConditionDescriptor: "test-owned-local-host",
    grader: { id: "grader.fixed", version: "1" },
    interventionWithheld,
    limitations: ["singleLocalHost"] as const,
    manifestId: `same-run-strict-v2-${suffix}`,
    role: "baseline" as const,
    scenario: { id: "implementation-completes", version: 1 },
    stopConditions: ["unknownExternalOutcome"] as const,
  };
}

function seedReviewedFactoryLesson(rootDirectory: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sourceRunId = parseRunId("run-lessn00001");
    const spec = parseMarkdownSpec(
      readFileSync(
        `${process.cwd()}/../../examples/specs/claim-verification-v2.md`,
        "utf8"
      ),
      "strict-V2 promoted-control source"
    );
    const contract = makeRunContractV2({
      baseDigest: "1".repeat(64),
      baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
      runId: sourceRunId,
      spec,
      targetDigest: "2".repeat(64),
      targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
    });
    const commandClaim = contract.proofClaims.find(
      (claim) => claim.kind === "command"
    );
    if (commandClaim === undefined)
      return yield* Effect.die("Expected a command claim in the V2 fixture.");
    const candidate = makeFactoryLessonCandidateV1({
      applicability: { episodeRole: "workerInitial", version: 1 },
      carryingCostOwner: "@gaia/runtime",
      compactLesson:
        "Bind the claim to the current owning source and its explicit authority boundary.",
      durableOwner: "@gaia/runtime/strict-v2-preparation",
      durableOwnerDigest: "e".repeat(64),
      durableOwnerVersion: "gaia.strict-v2-preparation.v1",
      expectedEffect:
        "A promoted control transports one authenticated lesson into the worker context.",
      retirementCondition:
        "Retire after the versioned successor proves every consumer migrated.",
      version: 1,
    });
    const digest = makeFailureDigestV1({
      attempt: 1,
      evidenceRefs: [
        {
          evidenceId: makeProofEvidenceIdV2("command", ["6".repeat(64)]),
          kind: "command",
          receiptDigest: "6".repeat(64),
          requestDigest: makeVerificationCommandRequestDigest(
            commandClaim.command
          ),
          status: "nonZero",
          terminalSequence: parseRunEventSequence(4),
        },
      ],
      failedRef: {
        claimId: commandClaim.claimId,
        kind: "claim",
      },
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });
    const failureRepair = FailureRepairIntent.make({
      digest,
      episodeKey: `failureRepair:${digest.fingerprint}:1`,
      failedProofResultSequence: parseRunEventSequence(5),
      runId: sourceRunId,
      state: "intentRecorded",
    });
    const attempted = FailureRepairDispatchAttempted.make({
      ...failureRepair,
      state: "dispatchAttempted",
    });
    const completed = FailureRepairTurnCompleted.make({
      ...failureRepair,
      state: "turnCompleted",
      terminalEventSequence: parseRunEventSequence(10),
    });
    const verified = FailureRepairVerified.make({
      ...failureRepair,
      proofResultSequence: parseRunEventSequence(12),
      state: "verified",
    });
    const proof = (
      passed: boolean,
      contentAuthoritySequence: number,
      sequence: number
    ) =>
      makeRunProofResultV2({
        contentAuthoritySequence,
        contract,
        observedTargetDigest: contract.targetDigest,
        recordedBy: {
          runId: sourceRunId,
          sequence,
          type: "RUN_PROOF_RESULT_RECORDED",
        },
        results: Schema.decodeUnknownSync(
          Schema.Array(ProofClaimResultV2Schema)
        )(
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
                    evidence: [
                      {
                        evidenceId: makeProofEvidenceIdV2("command", [
                          "6".repeat(64),
                        ]),
                        kind: "command",
                        receiptDigest: "6".repeat(64),
                        requestDigest: makeVerificationCommandRequestDigest(
                          commandClaim.command
                        ),
                        status: "nonZero",
                        terminalSequence: parseRunEventSequence(4),
                      },
                    ],
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
    const episodeId = createHash("sha256")
      .update(failureRepair.episodeKey)
      .digest("hex");
    const modelContextIdentityDigest = createHash("sha256")
      .update(`${failureRepair.episodeKey}:context`)
      .digest("hex");
    const modelInvocationIdentityDigest = createHash("sha256")
      .update(`${failureRepair.episodeKey}:invocation`)
      .digest("hex");
    const artifactId = (kind: string, identityDigest: string) =>
      `mmf1_${createHash("sha256")
        .update(`${kind}\0${identityDigest}`)
        .digest("hex")}`;
    const modelEpisode = {
      contextRef: {
        artifactId: artifactId(
          "modelContextManifest",
          modelContextIdentityDigest
        ),
        bodyDigest: "f".repeat(64),
        byteLength: 123,
        episodeKey: failureRepair.episodeKey,
        identityDigest: modelContextIdentityDigest,
        kind: "modelContextManifest" as const,
        path: `model-invocations/episode1_${episodeId}/context-manifest.json`,
        runId: sourceRunId,
        version: 1 as const,
      },
      episodeKey: failureRepair.episodeKey,
      invocationRef: {
        artifactId: artifactId(
          "modelInvocationManifest",
          modelInvocationIdentityDigest
        ),
        bodyDigest: "f".repeat(64),
        byteLength: 123,
        episodeKey: failureRepair.episodeKey,
        identityDigest: modelInvocationIdentityDigest,
        kind: "modelInvocationManifest" as const,
        path: `model-invocations/episode1_${episodeId}/invocation-manifest.json`,
        runId: sourceRunId,
        version: 1 as const,
      },
      version: 1 as const,
    };
    const repairEvent = (
      receipt: Parameters<typeof encodeFailureRepairReceiptJson>[0],
      sequence: number
    ) =>
      makeRunEvent({
        payload: {
          failureRepair: encodeFailureRepairReceiptJson(receipt),
          ...(receipt.state === "intentRecorded"
            ? {
                modelInvocationEpisode: modelEpisode,
              }
            : {}),
        },
        runId: sourceRunId,
        sequence,
        timestamp: fixtureTimestamp(sequence),
        type: "FAILURE_REPAIR_RECORDED",
      });
    const review = makeFactoryLessonReviewReceiptV1({
      attestation: makeNoRawTelemetryAttestationV1({
        candidateDigest: candidate.candidateDigest,
        reviewerRef: "linear-comment:test-reviewed-lesson",
      }),
      candidate,
      decision: "accepted",
      source: {
        eventSequence: parseRunEventSequence(6),
        failureFingerprint: digest.fingerprint,
        runId: sourceRunId,
        type: "FAILURE_REPAIR_RECORDED",
        version: 1,
      },
    });
    const paths = yield* makeRunPaths(sourceRunId, { rootDirectory });
    yield* fs.makeDirectory(paths.root, { recursive: true });
    const events = [
      makeRunEvent({
        payload: {
          execution: {
            resolved: Schema.encodeSync(ResolvedHarnessExecution)(
              ResolvedHarnessExecution.make({
                capabilities: testHarnessCapabilities,
                executionMode: "local",
                harnessProfileId: parseHarnessProfileId("codexAppServer"),
                provider: testHarnessProvider.descriptor,
                version: "test-1",
              })
            ),
            selection: { harnessProfileId: "codexAppServer" },
          },
          modelInvocationProtocol: "v1",
          specPath: "input.md",
          workflow: "issueDelivery",
          workItem: {
            description: "Seed the strict-V2 promoted-control fixture.",
            kind: "issue",
            title: "Seed reviewed lesson",
          },
        },
        runId: sourceRunId,
        sequence: 1,
        timestamp: "2026-07-27T00:00:01.000Z",
        type: "RUN_CREATED",
      }),
      makeRunEvent({
        payload: { contract: encodeAnyRunContractJson(contract) },
        runId: sourceRunId,
        sequence: 2,
        timestamp: fixtureTimestamp(2),
        type: "RUN_CONTRACT_RECORDED",
      }),
      makeRunEvent({
        payload: { workspacePath: "workspace" },
        runId: sourceRunId,
        sequence: 3,
        timestamp: fixtureTimestamp(3),
        type: "WORKSPACE_PREPARED",
      }),
      makeRunEvent({
        payload: { workerResultPath: "worker-result.json" },
        runId: sourceRunId,
        sequence: 4,
        timestamp: fixtureTimestamp(4),
        type: "WORKER_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          result: encodeAnyRunProofResultJson(proof(false, 4, 5)),
          verificationResultPath: "verification/run-proof-5.json",
        },
        runId: sourceRunId,
        sequence: 5,
        timestamp: fixtureTimestamp(5),
        type: "RUN_PROOF_RESULT_RECORDED",
      }),
      repairEvent(failureRepair, 6),
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
        timestamp: fixtureTimestamp(8),
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
              episodeKey: failureRepair.episodeKey,
              kind: "offered",
              source: "codexAppServerTransport",
              trust: "high",
              version: 1,
            })
          ),
        },
        runId: sourceRunId,
        sequence: 9,
        timestamp: fixtureTimestamp(9),
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
        timestamp: fixtureTimestamp(10),
        type: "HARNESS_SESSION_EVENT_RECORDED",
      }),
      repairEvent(completed, 11),
      makeRunEvent({
        payload: {
          result: encodeAnyRunProofResultJson(proof(true, 11, 12)),
          verificationResultPath: "verification/run-proof-12.json",
        },
        runId: sourceRunId,
        sequence: 12,
        timestamp: fixtureTimestamp(12),
        type: "RUN_PROOF_RESULT_RECORDED",
      }),
      repairEvent(verified, 13),
      makeRunEvent({
        runId: sourceRunId,
        sequence: 14,
        timestamp: fixtureTimestamp(14),
        type: "REPORT_STARTED",
      }),
      makeRunEvent({
        payload: { reportPath: "report.md" },
        runId: sourceRunId,
        sequence: 15,
        timestamp: fixtureTimestamp(15),
        type: "REPORT_COMPLETED",
      }),
      makeRunEvent({
        payload: {
          factoryLessonReview: Schema.encodeSync(FactoryLessonReviewReceiptV1)(
            review
          ),
        },
        runId: sourceRunId,
        sequence: 16,
        timestamp: fixtureTimestamp(16),
        type: "FACTORY_LESSON_REVIEW_RECORDED",
      }),
    ];
    yield* fs.writeFileString(
      paths.events,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
    );
    if (review.decision !== "accepted")
      return yield* Effect.die("Expected an accepted factory lesson review.");
    return review.projection;
  });
}

function fixtureTimestamp(sequence: number) {
  return `2026-07-27T00:00:${sequence.toString().padStart(2, "0")}.000Z`;
}

const acceptanceProvider: HarnessProvider = {
  createSession: () => Effect.die("not used during acceptance"),
  descriptor: HarnessProviderDescriptor.make({
    displayName: "Synthetic Harness",
    executionModes: ["local"],
    providerId: parseHarnessProviderId("synthetic"),
  }),
  detect: Effect.succeed({
    auth: { state: "authenticated" },
    capabilities: acceptanceCapabilities,
    state: "available",
    version: "synthetic-1",
  }),
  resumeSession: () => Effect.die("not used during acceptance"),
};

function blockingReviewer(): GaiaReviewer {
  const reviewerName = Schema.decodeUnknownSync(ReviewerNameSchema)(
    "server-blocking-reviewer"
  );

  return {
    name: reviewerName,
    run: (request) =>
      Effect.succeed(
        ReviewResult.make({
          findings: [
            ReviewFinding.make({
              message: "Server workflow expected failure.",
              severity: "blocker",
            }),
          ],
          phase: request.phase,
          resultPath:
            request.phase === "plan"
              ? "plan-review.json"
              : "evidence-review.json",
          reviewerName,
          runId: request.runId,
          status: request.phase === "plan" ? "blocked" : "approved",
          summary: "Server workflow expected failure.",
        })
      ),
  };
}

const RecordingGitRunnerInputSchema = Schema.Struct({
  baseRevision: DeliveryGitShaPublicSchema,
  workspaceHead: Schema.optionalKey(DeliveryGitShaPublicSchema),
});

function recordingGitRunner(
  commands: Array<GitDeliveryCommandInput>,
  input: typeof RecordingGitRunnerInputSchema.Type
) {
  return (command: GitDeliveryCommandInput) =>
    Effect.sync(() => {
      commands.push(command);
      const [first, ...rest] = command.args;
      if (first === "rev-parse" && rest[0] === "--show-toplevel") {
        return { stderr: "", stdout: `${command.cwd}\n` };
      }
      if (
        first === "rev-parse" &&
        rest[0] === "--path-format=absolute" &&
        rest[1] === "--git-common-dir"
      ) {
        return { stderr: "", stdout: `${command.cwd}/.git\n` };
      }
      if (first === "fetch") {
        return { stderr: "", stdout: "" };
      }
      if (first === "check-ref-format" && rest[0] === "--branch") {
        return { stderr: "", stdout: `${rest[1]}\n` };
      }
      if (first === "remote" && rest[0] === "get-url") {
        return {
          stderr: "",
          stdout: "https://github.com/cill-i-am/gaia.git\n",
        };
      }
      if (
        first === "rev-parse" &&
        (rest[0] === "origin/main" || rest[0] === "--verify")
      ) {
        return { stderr: "", stdout: `${input.baseRevision}\n` };
      }
      if (first === "rev-parse" && rest[0] === "HEAD") {
        return {
          stderr: "",
          stdout: `${input.workspaceHead ?? input.baseRevision}\n`,
        };
      }
      if (first === "worktree" && rest[0] === "add") {
        return { stderr: "", stdout: "" };
      }
      throw new Error(`Unexpected git command ${command.args.join(" ")}`);
    });
}

function recordingDeliveryPublisher(calls: Array<string>) {
  return (runId: ReturnType<typeof parseRunId>) =>
    Effect.sync(() => {
      calls.push(runId);
      return DeliveryPublicationConfirmed.make({
        baseBranch: "main",
        baseRevision: "a".repeat(40),
        branchName: `gaia/${runId}`,
        commitMessage: `feat: deliver ${runId}`,
        commitSha: "b".repeat(40),
        commitTimestamp: "2026-07-11T00:00:00.000Z",
        digestVersion: 1,
        draft: true,
        headSha: "b".repeat(40),
        operationId: `publish-${runId}-1`,
        payloadDigest: "c".repeat(64),
        prNumber: 91,
        prUrl: "https://github.com/cill-i-am/gaia/pull/91",
        sourcePaths: ["src/feature.ts"],
        state: "confirmed",
        treeSha: "d".repeat(40),
      });
    });
}

function digest(value: string) {
  return parseWorkerRecoveryDigest(
    createHash("sha256").update(value).digest("hex")
  );
}

const WorkerRecoveryTurnCheckpointInputSchema = Schema.Struct({
  actionId: WorkerRecoveryActionIdSchema,
  expectedFailureSequence: RunEvent.fields.sequence,
  expectedSessionId: HarnessSessionIdSchema,
  harnessProfileId: HarnessProfileIdSchema,
  model: WorkerRecoveryModelIdSchema,
  payloadDigest: WorkerRecoveryDigestSchema,
});
const decodeWorkerRecoveryTurnCheckpointInput = Schema.decodeUnknownSync(
  WorkerRecoveryTurnCheckpointInputSchema
);

function workerRecoveryTurnCheckpoint(
  turnIdInput: typeof CodexTurnIdSchema.Encoded,
  recoveryInput: typeof WorkerRecoveryTurnCheckpointInputSchema.Encoded
) {
  const turnId = parseCodexTurnId(turnIdInput);
  const recovery = decodeWorkerRecoveryTurnCheckpointInput(recoveryInput);
  return JSON.stringify({
    actionId: recovery.actionId,
    checkpoint: parseHarnessCheckpointToken(`hchk1_${turnId}`),
    expectedFailureSequence: recovery.expectedFailureSequence,
    expectedSessionId: recovery.expectedSessionId,
    harnessProfileId: recovery.harnessProfileId,
    model: recovery.model,
    nativeTurnIdDigest: digest(turnId),
    payloadDigest: recovery.payloadDigest,
    version: 3,
  });
}

const DeliveryProvenanceDigestInputSchema = Schema.Struct({
  baseBranch: DeliveryBranchNamePublicSchema,
  baseRevision: DeliveryGitShaPublicSchema,
  headBranch: DeliveryBranchNamePublicSchema,
  remote: DeliveryRemoteNamePublicSchema,
});

function deliveryProvenanceDigest(
  input: typeof DeliveryProvenanceDigestInputSchema.Type
) {
  return digest(
    [
      "gaia-worker-continuation-delivery-provenance-v1",
      input.baseBranch,
      input.baseRevision,
      input.headBranch,
      input.remote,
    ].join("\0")
  );
}

function makeDisposableGitRemote() {
  const root = mkdtempSync(join(tmpdir(), "gaia-90-worktree-"));
  const source = join(root, "source");
  const bare = join(root, "origin.git");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.email", "gaia-smoke@example.test");
  git(source, "config", "user.name", "Gaia Smoke");
  writeFileSync(join(source, ".gitignore"), ".gaia/\n");
  writeFileSync(join(source, "README.md"), "# smoke\n");
  git(source, "add", "README.md");
  git(source, "add", ".gitignore");
  git(source, "commit", "-m", "initial smoke base");
  git(root, "init", "--bare", bare);
  git(source, "remote", "add", "origin", bare);
  git(source, "push", "-u", "origin", "main");
  return {
    baseRevision: git(source, "rev-parse", "origin/main"),
    bare,
    root,
    source,
  };
}

function git(cwd: string, ...args: ReadonlyArray<string>) {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function gitState(cwd: string) {
  return {
    branch: git(cwd, "branch", "--show-current"),
    head: git(cwd, "rev-parse", "HEAD"),
    status: git(cwd, "status", "--short", "--branch"),
  };
}
