import { createHash } from "node:crypto";

import {
  GaiaFailure,
  MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
  MODEL_REVIEW_OUTPUT_CONTRACT_V1,
  makeModelContextContentV1,
  makeModelContextManifestV1,
  makeModelInvocationManifestV1,
  ModelInvocationEpisodeStartV1,
  ModelInvocationObservationV1,
  parseMarkdownSpec,
  parseRunId,
  resolveAcceptedRunInputCheckpoint,
  resolveModelInvocationEpisodes,
  snapshotFromReplay,
  RunIdSchema,
  RunProofProjectionSchema,
  RunStateSchema,
  RunVerificationAggregateSchema,
  renderModelInputV1,
  type ReviewPhase,
  type RunId,
  type RunState,
} from "@gaia/core";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { customAlphabet } from "nanoid";

import { loadAcceptedRunInputCheckpoint } from "./accepted-run-input.js";
import {
  browserEvidenceRecord,
  failedBrowserEvidence,
  parseBrowserEvidenceJson,
  parseBrowserEvidenceTargetUrl,
  playwrightBrowserEvidenceCollector,
  BrowserEvidenceTargetUrlSchema,
  writeBrowserEvidence,
  writeEmptyBrowserEvidence,
  type BrowserEvidenceCollector,
  type BrowserEvidenceRecord,
  type BrowserEvidenceTargetUrl,
} from "./browser-evidence.js";
import {
  makeCodexHarnessConfig,
  type CodexHarnessOptions,
} from "./codex-harness.js";
import { writeDogfoodRetrospective } from "./dogfood-retrospective.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import { appendEvent, loadRun } from "./event-store.js";
import { writeEvidencePromotion } from "./evidence-promotion.js";
import { writeFactoryRetro } from "./factory-retro.js";
import { writeFactoryScorecard } from "./factory-scorecard.js";
import type { DeliveryProvenance } from "./git-delivery.js";
import {
  HarnessRunRequest,
  HarnessRunResult,
  codexAppServerHarnessName,
  codexHarnessName,
  defaultHarnessName,
  processHarnessName,
  runHarness,
  type GaiaHarness,
  type HarnessName,
  type ProcessHarnessConfig,
} from "./harness.js";
import {
  commitModelInvocationPair,
  decodeCodexBatchSemanticConfig,
  deriveModelWorkspaceBinding,
  loadModelInvocationPair,
  prepareSpecRunAcceptance,
  type PreparedSpecRunAcceptanceV1,
} from "./model-invocation.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  runRelative,
  RuntimePathSchema,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import {
  availablePreviewDeployment,
  previewDeploymentRecord,
  writeEmptyPreviewDeployment,
  writePreviewDeployment,
} from "./preview-deployment.js";
import { writeReport } from "./report-writer.js";
import {
  ReviewRunRequest,
  defaultReviewerName,
  runReviewer,
  type ReviewerRunOptions,
} from "./reviewer.js";
import { deriveAndRecordRunContract, loadRunContract } from "./run-contract.js";
import {
  resolveRunProfile,
  parseRunProfileJson,
  writeRunProfile,
  type BrowserEvidenceRequirement,
  type RunProfile,
  type RunProfileSource,
} from "./run-profile.js";
import { withRunStoreLock } from "./run-store-lock.js";
import {
  resolvedSkillPaths,
  writeSkillBundle,
  type SkillInstallerOptions,
} from "./skill-bundle.js";
import {
  selectedSkillNames,
  SkillManifest,
  writeSkillManifest,
  type SkillManifestSource,
} from "./skill-manifest.js";
import { recordRunProofResult, type VerificationServices } from "./verifier.js";
import {
  parseWorkerPlanJson,
  writeWorkerPlan,
  type WorkerPlan,
} from "./worker-plan.js";
import { encodeWorkspaceDiffSummaryJson } from "./workspace-snapshot.js";
import {
  emptyWorkspaceSource,
  prepareWorkspace,
  type WorkspaceSource,
} from "./workspace.js";

const nanoid = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-",
  10
);
const HarnessRunResultJson = Schema.toCodecJson(HarnessRunResult);
const decodeHarnessRunResult = Schema.decodeUnknownSync(HarnessRunResultJson);
const decodePersistedSkillManifest = Schema.decodeUnknownSync(
  Schema.toCodecJson(SkillManifest)
);
const parseWorkflowSpecPath = Schema.decodeUnknownSync(RuntimePathSchema);
const BrowserEvidenceTargetSelectionSchema = Schema.Struct({
  explicitTargetUrl: Schema.UndefinedOr(BrowserEvidenceTargetUrlSchema),
  harnessTargetUrl: Schema.UndefinedOr(BrowserEvidenceTargetUrlSchema),
  previewDeploymentTargetUrl: Schema.UndefinedOr(
    BrowserEvidenceTargetUrlSchema
  ),
  profileTargetUrl: Schema.UndefinedOr(BrowserEvidenceTargetUrlSchema),
});
type BrowserEvidenceTargetSelection =
  typeof BrowserEvidenceTargetSelectionSchema.Type;

export const CommandStatusSchema = Schema.Literals([
  "completed",
  "failed",
  "running",
] as const);

export const CommandSummarySchema = Schema.Struct({
  harnessProgressPath: Schema.optionalKey(RuntimePathSchema),
  reportPath: Schema.UndefinedOr(RuntimePathSchema),
  runDirectory: RuntimePathSchema,
  runId: RunIdSchema,
  proofAggregate: Schema.optionalKey(RunVerificationAggregateSchema),
  state: RunStateSchema,
  status: CommandStatusSchema,
});

export type CommandSummary = typeof CommandSummarySchema.Type;

export const parseCommandSummary =
  Schema.decodeUnknownSync(CommandSummarySchema);

export const WorkerContinuationStateSchema = Schema.Literals([
  "start",
  "resume",
  "terminal",
  "completed",
] as const);

export type WorkerContinuationState = typeof WorkerContinuationStateSchema.Type;

export type WorkflowOptions = RunStorageOptions &
  ReviewerRunOptions & {
    readonly browserEvidenceCollector?: BrowserEvidenceCollector;
    readonly browserEvidenceRequirement?: BrowserEvidenceRequirement;
    readonly browserEvidenceTargetUrl?: string;
    readonly codexHarness?: CodexHarnessOptions;
    readonly deliveryProvenance?: DeliveryProvenance;
    readonly harnessName?: HarnessName;
    readonly workerHarness?: GaiaHarness;
    readonly processHarness?: ProcessHarnessConfig;
    readonly skillInstaller?: SkillInstallerOptions;
    readonly skillManifestSource?: SkillManifestSource;
    readonly runProfileSource?: RunProfileSource;
    readonly workspaceSource?: WorkspaceSource;
    readonly workerContinuationState?: WorkerContinuationState;
    readonly verificationServices?: VerificationServices;
  };

export type BrowserEvidenceCollectionOptions = RunStorageOptions & {
  readonly browserEvidenceCollector?: BrowserEvidenceCollector;
};

export function runSpecFile(
  specPath: typeof RuntimePathSchema.Encoded,
  options: WorkflowOptions = {}
) {
  return prepareSpecRunAcceptance(
    parseWorkflowSpecPath(specPath),
    options
  ).pipe(
    Effect.flatMap((prepared) =>
      withRunStoreLock(options, runSpecFileUnlocked(prepared, options))
    )
  );
}

function runSpecFileUnlocked(
  prepared: PreparedSpecRunAcceptanceV1,
  options: WorkflowOptions
) {
  return Effect.gen(function* () {
    const runId = yield* generateRunId;
    const paths = yield* makeRunPaths(runId, options);
    const fs = yield* FileSystem.FileSystem;
    const {
      browserEvidenceRequirement,
      explicitBrowserEvidenceTargetUrl,
      input,
      runProfile,
      spec,
    } = prepared;
    yield* fs.makeDirectory(paths.root, { recursive: true });
    yield* fs.writeFileString(paths.input, input);
    yield* fs.writeFileString(paths.latest, runId);
    yield* writeRunProfile({ paths, profile: runProfile }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "creating", error)
      )
    );

    yield* appendEvent(runId, paths, {
      payload: {
        ...(options.harnessName === codexHarnessName ||
        options.workerHarness?.name === codexAppServerHarnessName ||
        options.reviewer?.adapterKind === "codex-cli"
          ? { modelInvocationProtocol: "v1" }
          : {}),
        specPath: "input.md",
      },
      type: "RUN_CREATED",
    });

    return yield* executeAcceptedRun({
      browserEvidenceRequirement,
      explicitBrowserEvidenceTargetUrl,
      options,
      paths,
      runId,
      runProfile,
      preparedAcceptance: prepared,
      spec,
    });
  });
}

export function continueAcceptedRun(
  runId: RunId,
  paths: RunPaths,
  spec: ReturnType<typeof parseMarkdownSpec>,
  options: WorkflowOptions = {},
  preparedAcceptance?: PreparedSpecRunAcceptanceV1
) {
  return Effect.gen(function* () {
    const runProfile =
      preparedAcceptance?.runProfile ??
      (yield* resolveRunProfile(options.runProfileSource));
    const browserEvidenceRequirement =
      preparedAcceptance?.browserEvidenceRequirement ??
      options.browserEvidenceRequirement ??
      runProfile.checks.browserEvidence;
    const explicitBrowserEvidenceTargetUrl =
      preparedAcceptance?.explicitBrowserEvidenceTargetUrl ??
      (options.browserEvidenceTargetUrl === undefined
        ? undefined
        : yield* parseBrowserEvidenceTargetUrlEffect(
            options.browserEvidenceTargetUrl
          ));

    yield* writeRunProfile({ paths, profile: runProfile }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "creating", error)
      )
    );

    return yield* executeAcceptedRun({
      browserEvidenceRequirement,
      explicitBrowserEvidenceTargetUrl,
      options,
      paths,
      ...(preparedAcceptance === undefined ? {} : { preparedAcceptance }),
      runId,
      runProfile,
      spec,
    });
  });
}

function executeAcceptedRun(input: {
  readonly browserEvidenceRequirement: BrowserEvidenceRequirement;
  readonly explicitBrowserEvidenceTargetUrl?:
    | BrowserEvidenceTargetUrl
    | undefined;
  readonly options: WorkflowOptions;
  readonly paths: RunPaths;
  readonly runId: RunId;
  readonly runProfile: RunProfile;
  readonly preparedAcceptance?: PreparedSpecRunAcceptanceV1;
  readonly spec: ReturnType<typeof parseMarkdownSpec>;
}) {
  return Effect.gen(function* () {
    const {
      browserEvidenceRequirement,
      explicitBrowserEvidenceTargetUrl,
      options,
      paths,
      runId,
      runProfile,
      preparedAcceptance,
      spec,
    } = input;
    const workerContinuationState = options.workerContinuationState ?? "start";
    if (workerContinuationState === "start") {
      const workspace = yield* prepareWorkspace(
        paths,
        preparedAcceptance?.workspaceSource ??
          options.workspaceSource ??
          emptyWorkspaceSource()
      );
      yield* deriveAndRecordRunContract({
        ...(options.deliveryProvenance === undefined
          ? {}
          : { deliveryProvenance: options.deliveryProvenance }),
        paths,
        runId,
        spec,
      }).pipe(
        Effect.catchTag("GaiaRuntimeError", (error) =>
          recordRunFailure(runId, paths, "preparingWorkspace", error)
        )
      );
      yield* appendEvent(runId, paths, {
        payload: {
          copiedFiles: workspace.copiedFiles,
          workspaceManifestPath: workspace.manifestPath,
          workspacePath: workspace.workspacePath,
          workspaceSource: workspace.source,
        },
        type: "WORKSPACE_PREPARED",
      });
    } else {
      yield* loadRunContract(paths, runId);
    }
    const skillManifest = yield* writeSkillManifest({
      ...(preparedAcceptance === undefined
        ? {}
        : { manifest: preparedAcceptance.skillManifest }),
      paths,
      ...(preparedAcceptance !== undefined ||
      options.skillManifestSource === undefined
        ? {}
        : { source: options.skillManifestSource }),
    }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "preparingWorkspace", error)
      )
    );
    const skillBundle = yield* writeSkillBundle({
      manifest: skillManifest,
      paths,
      ...(preparedAcceptance === undefined
        ? options.skillInstaller === undefined
          ? {}
          : { installer: options.skillInstaller }
        : {
            installer: {
              command: preparedAcceptance.installer.command,
              ...(options.skillInstaller?.commandRunner === undefined
                ? {}
                : { commandRunner: options.skillInstaller.commandRunner }),
            },
          }),
      ...(options.skillManifestSource === undefined
        ? {}
        : { source: options.skillManifestSource }),
    }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "preparingWorkspace", error)
      )
    );
    yield* writeEmptyBrowserEvidence({ paths }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "preparingWorkspace", error)
      )
    );
    yield* writeEmptyPreviewDeployment({ paths }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "preparingWorkspace", error)
      )
    );
    const harnessName =
      options.workerHarness?.name ??
      (workerContinuationState === "completed"
        ? codexAppServerHarnessName
        : (options.harnessName ?? defaultHarnessName));
    const workerPlan = yield* writeWorkerPlan({
      harnessName,
      paths,
      runId,
      spec,
    }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "reviewing", error)
      )
    );
    const modelHistory = (yield* loadRun(paths)).events;
    const modelResolution = resolveModelInvocationEpisodes(modelHistory);
    const modelProtocolEnabled = modelResolution.protocol === "v1";
    const modelProjection = modelProtocolEnabled
      ? yield* Effect.gen(function* () {
          const existing = modelResolution.episodes.find(
            ({ start }) => start.episodeKey === "workerInitial"
          );
          if (existing !== undefined) {
            const pair = yield* loadModelInvocationPair(paths, existing.start);
            return {
              modelInvocationEpisode: existing.start,
              modelRenderedInput: pair.rendered,
              modelWorkspaceBinding: pair.workspaceBinding,
            };
          }
          if (workerContinuationState !== "start")
            return yield* Effect.fail(
              makeRuntimeError({
                code: "ModelInvocationEpisodeMissing",
                message:
                  "The marked run cannot resume worker execution without its event-owned initial invocation pair.",
                recoverable: false,
              })
            );
          const content = makeModelContextContentV1({
            acceptedOutcomes: workerPlan.acceptanceCriteria,
            authority: [
              "Operate only within the accepted Gaia run and workspace authority.",
            ],
            budget: { maxOutputBytes: 16_384, maxTurns: 1 },
            contentRefs: [],
            episodeRole: "workerInitial",
            instructions: [
              "Apply the accepted plan and preserve the recorded verification contract.",
            ],
            nonGoals: workerPlan.nonGoals,
            outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
            planningFacts: [`Accepted task title: ${spec.title}`],
            safeExclusions: [
              "credentials",
              "ambient environment",
              "provider handles",
              "unbounded logs",
            ],
            skills: selectedSkillNames(skillManifest),
            stops: workerPlan.stopConditions,
            taskInput: spec.body,
            verificationCommands: workerPlan.verificationChecks.map(
              (check) => check.command ?? check.expectation
            ),
          });
          const modelRenderedInput = renderModelInputV1(content);
          const modelWorkspaceBinding =
            yield* deriveModelWorkspaceBinding(paths);
          const runContract = yield* loadRunContract(paths, runId);
          const digestText = (value: string) =>
            createHash("sha256").update(value, "utf8").digest("hex");
          const context = makeModelContextManifestV1({
            authoritativeRefs: [
              {
                digest: digestText(JSON.stringify(workerPlan)),
                kind: "workerPlan",
              },
              { digest: runContract.contractDigest, kind: "runContract" },
            ],
            binding: { episodeKey: "workerInitial", runId },
            content,
            workspaceBinding: modelWorkspaceBinding,
          });
          const batchSemantics = decodeCodexBatchSemanticConfig(
            options.codexHarness
          );
          const adapterSemantics =
            harnessName === codexHarnessName
              ? {
                  kind: "codexBatch" as const,
                  semanticDigest:
                    batchSemantics?.semanticDigest ??
                    digestText("gaia.codex-batch.default.v1"),
                }
              : harnessName === codexAppServerHarnessName
                ? {
                    kind: "codexAppServer" as const,
                    semanticDigest: digestText(
                      "gaia.codex-app-server.on-request.ephemeral-false.workspace-write.start-turn.v1"
                    ),
                  }
                : harnessName === processHarnessName
                  ? {
                      kind: "legacyProcess" as const,
                      semanticDigest: digestText(
                        "gaia.legacy-process.spec-environment.unobservable.v1"
                      ),
                    }
                  : {
                      kind: "deterministicFake" as const,
                      semanticDigest: digestText(
                        "gaia.deterministic-fake.not-applicable.v1"
                      ),
                    };
          const invocation = makeModelInvocationManifestV1({
            acceptedProviderCapabilityObservation:
              harnessName === defaultHarnessName
                ? "notApplicable"
                : "unobservable",
            adapterInputClass:
              harnessName === codexHarnessName
                ? "codexBatchStdin"
                : harnessName === codexAppServerHarnessName
                  ? "codexAppTurn"
                  : harnessName === processHarnessName
                    ? "legacySpecEnvironment"
                    : "deterministicInput",
            adapterSemantics,
            authorityRef: {
              digest: digestText(
                "Operate only within the accepted Gaia run and workspace authority."
              ),
              kind: "authority",
            },
            binding: context.payload.binding,
            budget: content.payload.budget,
            context,
            outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
            rendered: modelRenderedInput,
            runContractRef: {
              digest: runContract.contractDigest,
              kind: "runContract",
            },
            template: { id: "gaia.worker-input.v1", version: 1 },
            workspaceBinding: modelWorkspaceBinding,
          });
          const modelInvocationEpisode = yield* commitModelInvocationPair({
            context,
            episodeKey: "workerInitial",
            invocation,
            paths,
          });
          return {
            modelInvocationEpisode,
            modelRenderedInput,
            modelWorkspaceBinding,
          };
        })
      : undefined;
    if (workerContinuationState === "start") {
      yield* runReviewPhase(
        runId,
        paths,
        spec,
        "plan",
        options,
        workerPlan,
        skillManifest
      );
      yield* appendEvent(runId, paths, {
        payload: {
          harnessName,
          ...(modelProjection === undefined
            ? {}
            : {
                modelInvocationEpisode: Schema.encodeSync(
                  ModelInvocationEpisodeStartV1
                )(modelProjection.modelInvocationEpisode),
              }),
          ...(harnessName === codexHarnessName
            ? {
                harnessProgressPath: runRelative(
                  paths,
                  paths.codexHarnessProgress
                ),
              }
            : {}),
        },
        type: "WORKER_STARTED",
      });
    }
    const harnessOptions = {
      ...(options.codexHarness === undefined
        ? {}
        : {
            codexHarness: {
              ...(options.codexHarness.commandRunner === undefined
                ? {}
                : { commandRunner: options.codexHarness.commandRunner }),
              config:
                preparedAcceptance?.codexHarness === undefined
                  ? options.codexHarness.config
                  : makeCodexHarnessConfig(preparedAcceptance.codexHarness),
            },
          }),
      ...(options.processHarness === undefined
        ? {}
        : { processHarness: options.processHarness }),
    };
    const harnessRequest = HarnessRunRequest.make({
      codexHarnessProgressPath: paths.codexHarnessProgress,
      harnessName,
      ...(modelProjection === undefined
        ? {}
        : {
            modelRenderedInput: modelProjection.modelRenderedInput,
            modelWorkspaceBinding: modelProjection.modelWorkspaceBinding,
          }),
      resolvedSkillPaths: [...resolvedSkillPaths(skillBundle)],
      runId,
      skillBundlePath: paths.skillBundle,
      specBody: spec.body,
      specTitle: spec.title,
      workerLogPath: paths.workerLog,
      workerResultPath: paths.workerResult,
      workspaceOutputPath: paths.workspaceOutput,
      workspacePath: paths.workspace,
    });
    const harnessResult = yield* (
      workerContinuationState === "completed"
        ? readPersistedWorkerResult(runId, paths)
        : options.workerHarness === undefined
          ? runHarness(harnessRequest, harnessOptions)
          : options.workerHarness.run(harnessRequest)
    ).pipe(
      Effect.flatMap(decodeProviderHarnessRunResult),
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "runningWorker", error)
      )
    );
    const previewDeploymentTargetUrl = harnessResult.previewDeploymentUrl;
    if (workerContinuationState !== "completed") {
      yield* appendEvent(runId, paths, {
        payload: {
          ...(workerContinuationState === "start" &&
          modelProjection !== undefined &&
          (harnessName === codexHarnessName ||
            harnessName === codexAppServerHarnessName)
            ? {
                modelInvocationObservation: Schema.encodeSync(
                  ModelInvocationObservationV1
                )(
                  ModelInvocationObservationV1.make({
                    episodeKey:
                      modelProjection.modelInvocationEpisode.episodeKey,
                    kind: "offered",
                    source:
                      harnessName === codexHarnessName
                        ? "codexBatchTransport"
                        : "codexAppServerTransport",
                    trust: "high",
                    version: 1,
                  })
                ),
              }
            : {}),
          ...(harnessResult.browserTargetUrl === undefined
            ? {}
            : { browserTargetUrl: harnessResult.browserTargetUrl }),
          changedWorkspacePaths: harnessResult.changedWorkspacePaths,
          harnessName: harnessResult.harnessName,
          outputArtifacts: harnessResult.outputArtifacts,
          ...(previewDeploymentTargetUrl === undefined
            ? {}
            : { previewDeploymentUrl: previewDeploymentTargetUrl }),
          ...(harnessResult.workspaceDiff === undefined
            ? {}
            : {
                workspaceDiff: encodeWorkspaceDiffSummaryJson(
                  harnessResult.workspaceDiff
                ),
              }),
          workerResultPath: harnessResult.resultPath,
        },
        type: "WORKER_COMPLETED",
      });
    }
    if (previewDeploymentTargetUrl !== undefined) {
      yield* recordPreviewDeployment(
        runId,
        paths,
        previewDeploymentTargetUrl
      ).pipe(
        Effect.catchTag("GaiaRuntimeError", (error) =>
          recordRunFailure(runId, paths, "runningWorker", error)
        )
      );
    }
    const browserEvidenceTargetUrl = selectBrowserEvidenceTargetUrl({
      explicitTargetUrl: explicitBrowserEvidenceTargetUrl,
      harnessTargetUrl: harnessResult.browserTargetUrl,
      previewDeploymentTargetUrl,
      profileTargetUrl: runProfile.browser?.targetUrl,
    });
    const requiredBrowserTargetMissing =
      browserEvidenceRequirement === "required" &&
      browserEvidenceTargetUrl === undefined;
    if (browserEvidenceTargetUrl !== undefined) {
      const browserEvidenceRecord = yield* recordBrowserEvidence(
        runId,
        paths,
        browserEvidenceTargetUrl,
        options
      ).pipe(
        Effect.catchTag("GaiaRuntimeError", (error) =>
          recordRunFailure(runId, paths, "reporting", error)
        )
      );
      yield* requireBrowserEvidencePolicy(
        browserEvidenceRecord,
        browserEvidenceRequirement
      ).pipe(
        Effect.catchTag("GaiaRuntimeError", (error) =>
          recordRunFailure(runId, paths, "reporting", error)
        )
      );
    }
    yield* appendEvent(runId, paths, { type: "VERIFICATION_STARTED" });
    const proofResult = yield* recordRunProofResult(runId, paths, {
      ...(options.verificationServices === undefined
        ? {}
        : { verificationServices: options.verificationServices }),
    }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "verifying", error)
      )
    );
    if (requiredBrowserTargetMissing)
      return yield* recordRunFailure(
        runId,
        paths,
        "reporting",
        browserEvidenceTargetRequiredError()
      );
    yield* runReviewPhase(
      runId,
      paths,
      spec,
      "evidence",
      options,
      workerPlan,
      skillManifest
    );
    yield* appendEvent(runId, paths, { type: "REPORT_STARTED" });
    const retrospective = yield* writeDogfoodRetrospective(runId, paths).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "reporting", error)
      )
    );
    const evidencePromotion = yield* writeEvidencePromotion({
      paths,
      runId,
    }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "reporting", error)
      )
    );
    const factoryRetro = yield* writeFactoryRetro({
      evidencePromotion,
      paths,
      runId,
      spec,
    }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "reporting", error)
      )
    );
    const factoryScorecard = yield* writeFactoryScorecard({
      paths,
      runId,
      spec,
    }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "reporting", error)
      )
    );
    yield* writeReport({
      evidencePromotion,
      factoryRetro,
      factoryScorecard,
      historicalRiskNotes: workerPlan.historicalRiskNotes,
      inferredRecommendations: workerPlan.inferredRecommendations,
      paths,
      retrospective,
      runId,
      skillManifest,
      spec,
    });
    const finalSnapshot =
      options.deliveryProvenance === undefined
        ? (yield* appendEvent(runId, paths, {
            payload: { reportPath: "report.md" },
            type: "REPORT_COMPLETED",
          })).snapshot
        : (yield* appendEvent(runId, paths, {
            payload: {
              delivery: {
                ...options.deliveryProvenance,
                stage: "readyToPublish",
              },
              reportPath: "report.md",
            },
            type: "DELIVERY_READY_TO_PUBLISH",
          })).snapshot;

    return parseCommandSummary({
      ...(harnessName === codexHarnessName
        ? { harnessProgressPath: paths.codexHarnessProgress }
        : {}),
      reportPath: paths.reportMarkdown,
      proofAggregate: proofResult.aggregate,
      runDirectory: paths.root,
      runId,
      state: finalSnapshot.state,
      status: finalSnapshot.state === "delivering" ? "running" : "completed",
    });
  });
}

function decodeProviderHarnessRunResult(input: unknown) {
  return Effect.try({
    try: () => HarnessRunResult.make(input),
    catch: () =>
      makeRuntimeError({
        code: "HarnessRunResultInvalid",
        message: "The harness provider returned an invalid worker result.",
        recoverable: false,
      }),
  });
}

function readPersistedWorkerResult(runId: RunId, paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const contents = yield* fs.readFileString(paths.workerResult).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "WorkerResultUnreadable",
          message:
            "Persisted worker result is unavailable for downstream resume.",
          recoverable: false,
        })
      )
    );
    const result = yield* Effect.try({
      try: () => decodeHarnessRunResult(JSON.parse(contents)),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "WorkerResultUnreadable",
          message:
            "Persisted worker result is unavailable for downstream resume.",
          recoverable: false,
        }),
    });
    if (
      result.runId !== runId ||
      result.harnessName !== codexAppServerHarnessName
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "WorkerResultMismatch",
          message: "Persisted worker result does not match the accepted run.",
          recoverable: false,
        })
      );
    }
    return result;
  });
}

function selectBrowserEvidenceTargetUrl(input: BrowserEvidenceTargetSelection) {
  return (
    input.explicitTargetUrl ??
    input.profileTargetUrl ??
    input.previewDeploymentTargetUrl ??
    input.harnessTargetUrl
  );
}

export function resumeRun(runId: RunId, options: WorkflowOptions = {}) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);

    if (loaded.events.length === 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunHasNoEvents",
          message: `Run ${runId} has no events to resume.`,
          recoverable: false,
        })
      );
    }

    const snapshot = snapshotFromReplay(loaded.events);
    if (snapshot.state === "completed") {
      const proofAggregate = proofAggregateFromSnapshot(
        snapshot.context["runProof"]
      );
      return parseCommandSummary({
        ...(yield* existingHarnessProgressPath(paths)),
        reportPath: paths.reportMarkdown,
        ...(proofAggregate === undefined ? {} : { proofAggregate }),
        runDirectory: paths.root,
        runId,
        state: snapshot.state,
        status: "completed",
      });
    }

    return yield* Effect.fail(
      makeRuntimeError({
        code: "ResumeIncompletePrototype",
        message:
          "Prototype 1 can resume completed runs and validate logs, but cannot continue partial live work yet.",
        recoverable: false,
      })
    );
  });
}

export function collectBrowserEvidence(
  runId: RunId,
  targetUrlInput: string,
  options: BrowserEvidenceCollectionOptions = {}
) {
  return withRunStoreLock(
    options,
    collectBrowserEvidenceUnlocked(runId, targetUrlInput, options)
  );
}

/** Rerun the accepted verifier, Browser policy, and read-only evidence review. */
export function reverifyRemediatedRun(input: {
  readonly options?: WorkflowOptions;
  readonly paths: RunPaths;
  readonly runId: RunId;
  readonly spec: ReturnType<typeof parseMarkdownSpec>;
}) {
  const options = input.options ?? {};
  return Effect.gen(function* () {
    yield* appendEvent(input.runId, input.paths, {
      type: "VERIFICATION_STARTED",
    });
    yield* loadRunContract(input.paths, input.runId);
    yield* recordRunProofResult(input.runId, input.paths, {
      ...(options.verificationServices === undefined
        ? {}
        : { verificationServices: options.verificationServices }),
    });

    const fs = yield* FileSystem.FileSystem;
    const profileText = yield* fs.readFileString(input.paths.runProfile);
    const profile = yield* Effect.try({
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "RunProfileUnreadable",
          message: "Persisted remediation run profile is invalid.",
          recoverable: false,
        }),
      try: () => parseRunProfileJson(JSON.parse(profileText)),
    });
    const browserEvidenceText = yield* fs.readFileString(
      input.paths.browserEvidence
    );
    const priorEvidence = yield* Effect.try({
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "BrowserEvidenceUnreadable",
          message: "Persisted Browser evidence is invalid.",
          recoverable: false,
        }),
      try: () => parseBrowserEvidenceJson(JSON.parse(browserEvidenceText)),
    });
    const priorTarget = priorEvidence.pages[0]?.url;
    const targetInput =
      options.browserEvidenceTargetUrl ??
      profile.browser?.targetUrl ??
      priorTarget;
    const target =
      targetInput === undefined
        ? undefined
        : yield* parseBrowserEvidenceTargetUrlEffect(targetInput);
    const requirement =
      options.browserEvidenceRequirement ?? profile.checks.browserEvidence;
    if (target === undefined && requirement === "required") {
      return yield* Effect.fail(browserEvidenceTargetRequiredError());
    }
    if (target !== undefined) {
      const record = yield* recordBrowserEvidence(
        input.runId,
        input.paths,
        target,
        options
      );
      yield* requireBrowserEvidencePolicy(record, requirement);
    }

    const reviewPaths = reviewPathsForPhase(input.paths, "evidence");
    const reviewerName = reviewerNameFromOptions(options);
    const workerPlanText = yield* fs.readFileString(
      input.paths.workerPlanResult
    );
    const workerPlan = yield* Effect.try({
      try: () => parseWorkerPlanJson(workerPlanText),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "WorkerPlanUnreadable",
          message: "Persisted worker plan is invalid.",
          recoverable: false,
        }),
    });
    const skillManifestText = yield* fs.readFileString(
      input.paths.skillManifest
    );
    const skillManifest = yield* Effect.try({
      try: () => decodePersistedSkillManifest(skillManifestText),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "SkillManifestUnreadable",
          message: "Persisted skill manifest is invalid.",
          recoverable: false,
        }),
    });
    const modelProjection = yield* makeReviewModelProjection({
      options,
      paths: input.paths,
      phase: "evidence",
      runId: input.runId,
      skillManifest,
      spec: input.spec,
      workerPlan,
    });
    yield* appendEvent(input.runId, input.paths, {
      payload: {
        ...(modelProjection === undefined
          ? {}
          : {
              modelInvocationEpisode: Schema.encodeSync(
                ModelInvocationEpisodeStartV1
              )(modelProjection.episode),
            }),
        phase: "evidence",
        reviewerName,
      },
      type: "REVIEW_STARTED",
    });
    const review = yield* runReviewer(
      ReviewRunRequest.make({
        browserEvidencePath: input.paths.browserEvidence,
        markdownPath: reviewPaths.markdown,
        ...(modelProjection === undefined
          ? {}
          : {
              modelRenderedInput: modelProjection.rendered,
              modelWorkspaceBinding: modelProjection.workspaceBinding,
            }),
        phase: "evidence",
        paths: input.paths,
        resultPath: reviewPaths.result,
        runId: input.runId,
        sessionEvidencePath: reviewPaths.sessionEvidence,
        specBody: input.spec.body,
        specTitle: input.spec.title,
        verificationResultPath: input.paths.verificationResult,
        workerPlanPath: input.paths.workerPlanResult,
        workerResultPath: input.paths.workerResult,
        workspaceManifestPath: input.paths.workspaceManifest,
        workspacePath: input.paths.workspace,
      }),
      options
    );
    yield* appendEvent(input.runId, input.paths, {
      payload: {
        ...(modelProjection?.codex === true
          ? {
              modelInvocationObservation: Schema.encodeSync(
                ModelInvocationObservationV1
              )(
                ModelInvocationObservationV1.make({
                  episodeKey: modelProjection.episode.episodeKey,
                  kind: "offered",
                  source: "codexBatchTransport",
                  trust: "high",
                  version: 1,
                })
              ),
            }
          : {}),
        phase: review.phase,
        resultPath: review.resultPath,
        reviewPath: runRelative(input.paths, reviewPaths.markdown),
        reviewerSessionEvidencePath: runRelative(
          input.paths,
          reviewPaths.sessionEvidence
        ),
        reviewerName: review.reviewerName,
        status: review.status,
      },
      type: "REVIEW_COMPLETED",
    });
    if (review.status === "blocked") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "ReviewBlocked",
          message: `Evidence review blocked remediation: ${review.summary}`,
          recoverable: true,
        })
      );
    }
    return review;
  });
}

function collectBrowserEvidenceUnlocked(
  runId: RunId,
  targetUrlInput: string,
  options: BrowserEvidenceCollectionOptions
) {
  return Effect.gen(function* () {
    const rootDirectory = options.rootDirectory ?? ".";
    const targetUrl =
      yield* parseBrowserEvidenceTargetUrlEffect(targetUrlInput);
    const run = yield* statusRun(runId, { rootDirectory });

    if (run.status !== "completed") {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunNotCompleted",
          message: `Run ${run.runId} must be completed before collecting browser evidence.`,
          recoverable: false,
        })
      );
    }

    const paths = yield* makeRunPaths(run.runId, { rootDirectory });
    return yield* recordBrowserEvidence(run.runId, paths, targetUrl, options);
  });
}

export function statusRun(
  requestedRunId?: RunId,
  options: WorkflowOptions = {}
) {
  return Effect.gen(function* () {
    const runId =
      requestedRunId === undefined
        ? yield* latestRunId(options)
        : requestedRunId;
    const paths = yield* makeRunPaths(runId, options);
    const loaded = yield* loadRun(paths);

    if (loaded.events.length === 0) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunHasNoEvents",
          message: `Run ${runId} has no events.`,
          recoverable: false,
        })
      );
    }

    const snapshot = snapshotFromReplay(loaded.events);
    const proofAggregate = proofAggregateFromSnapshot(
      snapshot.context["runProof"]
    );
    return parseCommandSummary({
      ...(yield* existingHarnessProgressPath(paths)),
      reportPath:
        snapshot.state === "completed" ? paths.reportMarkdown : undefined,
      ...(proofAggregate === undefined ? {} : { proofAggregate }),
      runDirectory: paths.root,
      runId,
      state: snapshot.state,
      status: statusFromState(snapshot.state),
    });
  });
}

function proofAggregateFromSnapshot(input: unknown) {
  const proof = Schema.decodeUnknownOption(RunProofProjectionSchema)(input);
  return Option.isSome(proof) ? proof.value.aggregate : undefined;
}

function existingHarnessProgressPath(paths: RunPaths) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(paths.codexHarnessProgress);
    return exists ? { harnessProgressPath: paths.codexHarnessProgress } : {};
  });
}

export function listRuns(options: WorkflowOptions = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);
    const exists = yield* fs.exists(store.runsRoot);
    if (!exists) {
      return [];
    }

    const entries = yield* fs.readDirectory(store.runsRoot);
    const runIds = entries
      .filter((entry) => entry.startsWith("run-"))
      .sort()
      .reverse()
      .map((entry) => parseRunId(entry));

    const summaries: Array<CommandSummary> = [];
    for (const runId of runIds) {
      const paths = yield* makeRunPaths(runId, options);
      const hasEvents = yield* fs.exists(paths.events);
      if (hasEvents) {
        summaries.push(yield* statusRun(runId, options));
      }
    }

    return summaries;
  });
}

const generateRunId = Effect.sync(() => parseRunId(`run-${nanoid()}`));

function latestRunId(options: WorkflowOptions) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* makeRunStorePaths(options);
    const exists = yield* fs.exists(store.latest);
    if (!exists) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "NoRunsFound",
          message: "No Gaia latest-run pointer found.",
          recoverable: false,
        })
      );
    }

    const latest = (yield* fs.readFileString(store.latest)).trim();
    return yield* parsePersistedRunIdEffect(latest);
  });
}

function parseSpec(input: string, fallbackTitle: string) {
  return Effect.try({
    try: () => parseMarkdownSpec(input, fallbackTitle),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidSpec",
        message: "Spec markdown could not be parsed.",
        recoverable: false,
      }),
  });
}

function parsePersistedRunIdEffect(input: string) {
  return Effect.try({
    try: () => parseRunId(input),
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "InvalidRunId",
        message: `Invalid Gaia run id '${input}'.`,
        recoverable: false,
      }),
  });
}

function recordBrowserEvidence(
  runId: RunId,
  paths: RunPaths,
  targetUrl: BrowserEvidenceTargetUrl,
  options: Readonly<{
    readonly browserEvidenceCollector?: BrowserEvidenceCollector;
  }>
) {
  return Effect.gen(function* () {
    const collector =
      options.browserEvidenceCollector ?? playwrightBrowserEvidenceCollector;
    const captured = yield* collector({ paths, targetUrl }).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        error.code === "BrowserConsoleSourceUrlInvalid" ||
        error.code === "BrowserEvidenceFinalUrlInvalid"
          ? Effect.fail(error)
          : Effect.succeed(
              failedBrowserEvidence({
                message: error.message,
                targetUrl,
              })
            )
      )
    );
    const evidence = yield* writeBrowserEvidence({ evidence: captured, paths });
    const record = browserEvidenceRecord({
      evidence,
      paths,
      runId,
      targetUrl,
    });
    const matchingPages = record.pages.filter((page) => page.url === targetUrl);
    const matchingPage = matchingPages[0];
    const observedPage =
      record.status === "collected" &&
      matchingPages.length === 1 &&
      matchingPage !== undefined &&
      "evidenceKind" in matchingPage &&
      matchingPage.evidenceKind === "page"
        ? matchingPage
        : undefined;
    const observedSelector = observedPage?.evidenceSelector;

    yield* appendEvent(runId, paths, {
      payload: {
        ...(observedSelector === undefined
          ? {}
          : {
              evidenceKind: "page",
              evidenceSelector: observedSelector,
            }),
        evidencePath: runRelative(paths, paths.browserEvidence),
        status: record.status,
        targetUrl,
      },
      type: "BROWSER_EVIDENCE_RECORDED",
    });

    return record;
  });
}

function recordPreviewDeployment(
  runId: RunId,
  paths: RunPaths,
  targetUrl: BrowserEvidenceTargetUrl
) {
  return Effect.gen(function* () {
    const deployment = yield* writePreviewDeployment({
      deployment: availablePreviewDeployment({ url: targetUrl }),
      paths,
    });
    const record = previewDeploymentRecord({
      deployment,
      paths,
      runId,
    });

    yield* appendEvent(runId, paths, {
      payload: {
        deploymentPath: record.deploymentPath,
        status: record.status,
        ...(record.url === undefined ? {} : { url: record.url }),
      },
      type: "PREVIEW_DEPLOYMENT_RECORDED",
    });

    return record;
  });
}

function requireBrowserEvidencePolicy(
  record: BrowserEvidenceRecord,
  requirement: BrowserEvidenceRequirement
): Effect.Effect<void, GaiaRuntimeError> {
  if (requirement === "optional" || record.status === "collected") {
    return Effect.void;
  }

  return Effect.fail(
    makeRuntimeError({
      code: "RequiredBrowserEvidenceFailed",
      message: `Browser evidence is required for this run, but capture status was '${record.status}'.`,
      recoverable: true,
    })
  );
}

function recordRunFailure(
  runId: RunId,
  paths: RunPaths,
  stage: GaiaFailure["stage"],
  error: GaiaRuntimeError
) {
  return Effect.gen(function* () {
    yield* appendEvent(runId, paths, {
      payload: failureToEventPayload(error, stage),
      type: "RUN_FAILED",
    });
    yield* writeDogfoodRetrospective(runId, paths).pipe(
      Effect.catchTag("GaiaRuntimeError", () => Effect.void)
    );
    yield* writeEvidencePromotion({ paths, runId }).pipe(
      Effect.catchTag("GaiaRuntimeError", () => Effect.void)
    );
    const fs = yield* FileSystem.FileSystem;
    let input = {
      body: "Failed run did not have a parseable source spec.",
      title: "factory-retro-failed-run",
    };
    const history = yield* Effect.exit(loadRun(paths));
    const checkpointResolution =
      history._tag === "Success"
        ? yield* Effect.exit(
            Effect.try({
              try: () =>
                resolveAcceptedRunInputCheckpoint(history.value.events),
              catch: (cause) => cause,
            })
          )
        : undefined;
    if (
      checkpointResolution?._tag === "Success" &&
      checkpointResolution.value.kind === "v1"
    ) {
      const checkpoint = yield* Effect.exit(
        loadAcceptedRunInputCheckpoint(paths, checkpointResolution.value.ref)
      );
      if (checkpoint._tag === "Success") {
        input = {
          body: checkpoint.value.payload.spec.body,
          title: checkpoint.value.payload.spec.title,
        };
      }
    } else if (
      checkpointResolution?._tag === "Success" &&
      checkpointResolution.value.kind === "legacyAbsent"
    ) {
      const inputText = yield* Effect.exit(fs.readFileString(paths.input));
      if (inputText._tag === "Success") {
        const parsedSpec = yield* Effect.exit(
          parseSpec(inputText.value, "factory-retro-failed-run")
        );
        if (parsedSpec._tag === "Success") {
          input = parsedSpec.value;
        }
      }
    }
    yield* writeFactoryRetro({ paths, runId, spec: input }).pipe(
      Effect.catchTag("GaiaRuntimeError", () => Effect.void)
    );

    return yield* Effect.fail(error);
  });
}

function makeReviewModelProjection(input: {
  readonly options: ReviewerRunOptions;
  readonly paths: RunPaths;
  readonly phase: ReviewPhase;
  readonly runId: RunId;
  readonly skillManifest: SkillManifest;
  readonly spec: ReturnType<typeof parseMarkdownSpec>;
  readonly workerPlan: WorkerPlan;
}) {
  return Effect.gen(function* () {
    const loaded = yield* loadRun(input.paths);
    const marked =
      loaded.events[0]?.payload["modelInvocationProtocol"] === "v1";
    if (!marked) return undefined;
    const ownerSequence = loaded.events.length + 1;
    const episodeKey =
      input.phase === "plan" ? "planReview" : `evidenceReview:${ownerSequence}`;
    const content = makeModelContextContentV1({
      acceptedOutcomes: input.workerPlan.acceptanceCriteria,
      authority: [
        "Review only the accepted Gaia run evidence under read-only authority.",
      ],
      budget: { maxOutputBytes: 16_384, maxTurns: 1 },
      contentRefs: [],
      episodeRole: input.phase === "plan" ? "planReview" : "evidenceReview",
      instructions: [
        input.phase === "plan"
          ? "Review the accepted plan before worker execution."
          : "Review the recorded worker and verification evidence without changing its proof aggregate.",
      ],
      nonGoals: input.workerPlan.nonGoals,
      outputContract: MODEL_REVIEW_OUTPUT_CONTRACT_V1,
      planningFacts: [`Accepted task title: ${input.spec.title}`],
      safeExclusions: [
        "credentials",
        "ambient environment",
        "provider handles",
        "unbounded logs",
      ],
      skills: selectedSkillNames(input.skillManifest),
      stops: input.workerPlan.stopConditions,
      taskInput: input.spec.body,
      verificationCommands: input.workerPlan.verificationChecks.map(
        (check) => check.command ?? check.expectation
      ),
    });
    const rendered = renderModelInputV1(content);
    const workspaceBinding = yield* deriveModelWorkspaceBinding(input.paths);
    const runContract = yield* loadRunContract(input.paths, input.runId);
    const digestText = (value: string) =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const context = makeModelContextManifestV1({
      authoritativeRefs: [
        {
          digest: digestText(JSON.stringify(input.workerPlan)),
          kind: "workerPlan",
        },
        { digest: runContract.contractDigest, kind: "runContract" },
      ],
      binding: { episodeKey, runId: input.runId },
      content,
      workspaceBinding,
    });
    const reviewer = input.options.reviewer;
    const codex = reviewer?.adapterKind === "codex-cli";
    const adapterSemantics = codex
      ? reviewer.modelAdapterSemantics
      : {
          kind: "deterministicReviewer" as const,
          semanticDigest: digestText(
            JSON.stringify({
              adapterKind: reviewer?.adapterKind ?? "deterministic",
              reviewerName: reviewer?.name ?? defaultReviewerName,
              sessionKind: reviewer?.sessionKind ?? "local",
            })
          ),
        };
    if (adapterSemantics === undefined)
      return yield* Effect.fail(
        makeRuntimeError({
          code: "AcceptedInputRejected",
          message:
            "Codex reviewer semantic configuration is required before review ownership.",
          recoverable: false,
        })
      );
    const invocation = makeModelInvocationManifestV1({
      acceptedProviderCapabilityObservation: codex
        ? "unobservable"
        : "notApplicable",
      adapterInputClass: "codexReviewerStdin",
      adapterSemantics,
      authorityRef: {
        digest: digestText(
          "Review only the accepted Gaia run evidence under read-only authority."
        ),
        kind: "authority",
      },
      binding: context.payload.binding,
      budget: content.payload.budget,
      context,
      outputContract: MODEL_REVIEW_OUTPUT_CONTRACT_V1,
      rendered,
      runContractRef: {
        digest: runContract.contractDigest,
        kind: "runContract",
      },
      template: {
        id: "gaia.worker-input.v1",
        version: 1,
      },
      workspaceBinding,
    });
    return {
      codex,
      episode: yield* commitModelInvocationPair({
        context,
        episodeKey,
        invocation,
        paths: input.paths,
      }),
      rendered,
      workspaceBinding,
    };
  });
}

function runReviewPhase(
  runId: RunId,
  paths: RunPaths,
  spec: ReturnType<typeof parseMarkdownSpec>,
  phase: ReviewPhase,
  options: ReviewerRunOptions,
  workerPlan: WorkerPlan,
  skillManifest: SkillManifest
) {
  return Effect.gen(function* () {
    const reviewPaths = reviewPathsForPhase(paths, phase);
    const reviewerName = reviewerNameFromOptions(options);
    const modelProjection = yield* makeReviewModelProjection({
      options,
      paths,
      phase,
      runId,
      skillManifest,
      spec,
      workerPlan,
    });
    yield* appendEvent(runId, paths, {
      payload: {
        ...(modelProjection === undefined
          ? {}
          : {
              modelInvocationEpisode: Schema.encodeSync(
                ModelInvocationEpisodeStartV1
              )(modelProjection.episode),
            }),
        phase,
        reviewerName,
      },
      type: "REVIEW_STARTED",
    });
    const review = yield* runReviewer(
      ReviewRunRequest.make({
        browserEvidencePath: paths.browserEvidence,
        markdownPath: reviewPaths.markdown,
        ...(modelProjection === undefined
          ? {}
          : {
              modelRenderedInput: modelProjection.rendered,
              modelWorkspaceBinding: modelProjection.workspaceBinding,
            }),
        phase,
        paths,
        resultPath: reviewPaths.result,
        runId,
        sessionEvidencePath: reviewPaths.sessionEvidence,
        specBody: spec.body,
        specTitle: spec.title,
        verificationResultPath: paths.verificationResult,
        workerPlanPath: paths.workerPlanResult,
        workerResultPath: paths.workerResult,
        workspaceManifestPath: paths.workspaceManifest,
        workspacePath: paths.workspace,
      }),
      options
    ).pipe(
      Effect.catchTag("GaiaRuntimeError", (error) =>
        recordRunFailure(runId, paths, "reviewing", error)
      )
    );

    yield* appendEvent(runId, paths, {
      payload: {
        ...(modelProjection?.codex === true
          ? {
              modelInvocationObservation: Schema.encodeSync(
                ModelInvocationObservationV1
              )(
                ModelInvocationObservationV1.make({
                  episodeKey: modelProjection.episode.episodeKey,
                  kind: "offered",
                  source: "codexBatchTransport",
                  trust: "high",
                  version: 1,
                })
              ),
            }
          : {}),
        phase: review.phase,
        resultPath: review.resultPath,
        reviewPath: runRelative(paths, reviewPaths.markdown),
        reviewerSessionEvidencePath: runRelative(
          paths,
          reviewPaths.sessionEvidence
        ),
        reviewerName: review.reviewerName,
        status: review.status,
      },
      type: "REVIEW_COMPLETED",
    });

    if (review.status === "blocked") {
      return yield* recordRunFailure(
        runId,
        paths,
        "reviewing",
        makeRuntimeError({
          code: "ReviewBlocked",
          message: `${review.phase} review blocked the run: ${review.summary}`,
          recoverable: true,
        })
      );
    }

    return review;
  });
}

function reviewerNameFromOptions(options: ReviewerRunOptions) {
  return options.reviewer?.name ?? defaultReviewerName;
}

function reviewPathsForPhase(paths: RunPaths, phase: ReviewPhase) {
  switch (phase) {
    case "plan":
      return {
        markdown: paths.planReviewMarkdown,
        result: paths.planReviewResult,
        sessionEvidence: paths.planReviewerSession,
      };
    case "evidence":
      return {
        markdown: paths.evidenceReviewMarkdown,
        result: paths.evidenceReviewResult,
        sessionEvidence: paths.evidenceReviewerSession,
      };
  }
}

function parseBrowserEvidenceTargetUrlEffect(input: string) {
  return Effect.try({
    try: () => parseBrowserEvidenceTargetUrl(input),
    catch: () =>
      makeRuntimeError({
        code: "BrowserEvidenceTargetUrlInvalid",
        message:
          "The browser evidence target URL is invalid or contains credential material.",
        recoverable: false,
      }),
  });
}

function browserEvidenceTargetRequiredError() {
  return makeRuntimeError({
    code: "BrowserEvidenceTargetRequired",
    message:
      "Browser evidence is required for this run, but no browser target URL was provided or discovered.",
    recoverable: false,
  });
}

function statusFromState(state: RunState): CommandSummary["status"] {
  switch (state) {
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    case "created":
    case "delivering":
    case "preparingWorkspace":
    case "runningWorker":
    case "verifying":
    case "reporting":
      return "running";
  }
}

export function failureToEventPayload(
  error: GaiaRuntimeError,
  stage: GaiaFailure["stage"]
): Readonly<Record<string, Schema.Json>> {
  const failure = GaiaFailure.make({
    code: error.code,
    message: error.message,
    recoverable: error.recoverable,
    stage,
  });

  return {
    code: failure.code,
    message: failure.message,
    recoverable: failure.recoverable,
    stage: failure.stage,
  };
}
