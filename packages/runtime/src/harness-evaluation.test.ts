import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { NodeServices } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import {
  canonicalV1,
  codexAppServerExecutionSelection,
  codexAppServerHarnessProfileId,
  deriveExplicitSpecItemDigest,
  digestHarnessEnvironmentContract,
  encodeFailureRepairReceiptJson,
  FactoryArtifactIdSchema,
  FailureRepairIntent,
  FactoryLessonActiveV1,
  FactoryLessonContextObservationV1,
  FactoryLessonContextSelectionV1,
  HarnessCapabilities,
  HarnessBaselineManifestRefV1,
  HarnessEnvironmentAssignmentV1,
  HarnessEvaluationRecordingInputV1Schema,
  HarnessExecutionSelection,
  HarnessLaunchObservationV1,
  HarnessPreparedRunReceiptV1,
  HarnessPreparedRunReceiptRefV1,
  HarnessProviderDescriptor,
  makeHarnessBaselineManifestRefV1,
  makeHarnessBaselineManifestV1,
  makeHarnessOperatorStatementDigestV1,
  makeFailureDigestV1,
  makeFactoryLessonCandidateV1,
  makeFactoryLessonContextObservationV1,
  makeFactoryLessonReviewReceiptV1,
  makeModelContextContentV1,
  makeModelContextManifestV1,
  makeModelInvocationManifestV1,
  makeRunEvent,
  makeRunContractV2,
  makeRunProofResultV2,
  makeNoRawTelemetryAttestationV1,
  MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
  ModelInvocationEpisodeStartV1,
  parseHarnessProviderId,
  parseHarnessEvent,
  parseHarnessSessionId,
  parseHarnessTurnId,
  parseAnyRunContract,
  parseMarkdownSpec,
  parseRunId,
  parseRunEventSequence,
  projectHarnessEvents,
  ProofClaimResultV2Schema,
  RunEvent,
  RunContractV2,
  RunProofResultV2,
  ResolvedHarnessExecution,
  renderModelInputV1,
  selectFactoryLessonsForWorkerInitial,
} from "@gaia/core";
import { Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { StagedDockerSandboxVerificationReceiptSchema } from "./docker-sandbox-verification-executor.js";
import { GaiaRuntimeError } from "./errors.js";
import {
  appendEvent,
  appendHarnessSessionEvent,
  appendPreparedEventWithinSerialization,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import { recordFactoryLessonReview } from "./factory-lesson.js";
import { readFactoryRunArtifact } from "./factory-run-read-api.js";
import { rebuildFactoryRunIndexes } from "./factory-run-store.js";
import {
  canonicalHarnessBaselineManifestBody,
  canonicalHarnessEvaluationBody,
  canonicalHarnessPreparedRunBody,
  evaluateHarnessScenario,
  type HarnessEvaluationScenarioFixture,
  HarnessEvaluationScenarioProvider,
  makeHarnessEvaluationPrefixRef,
  preflightHarnessRun,
  readHarnessBaselineManifest,
  readHarnessEvaluation,
  recordHarnessBaselineManifest,
  recordHarnessEvaluation,
} from "./harness-evaluation.js";
import { makeHarnessProviderRegistry } from "./harness-provider-registry.js";
import type { HarnessProvider, HarnessSession } from "./harness-session.js";
import {
  codexAppServerHarnessName,
  HarnessRunRequest,
  HarnessRunResult,
} from "./harness.js";
import { commitHarnessEnvironmentCandidate } from "./interactive-harness.js";
import {
  commitModelInvocationPair,
  loadModelInvocationPair,
} from "./model-invocation.js";
import { makeRunPaths, parseRuntimePath, runRelative } from "./paths.js";
import {
  canonicalRunContractBody,
  canonicalRunProofResultBody,
} from "./run-contract.js";
import { readLocalRunArtifact } from "./run-read-api.js";
import { readVerificationExecutionProfile } from "./verification-execution-profile.js";
import type { VerificationServices } from "./verifier.js";
import {
  digestWorkerPlanEnvironmentSemantics,
  writeWorkerPlan,
} from "./worker-plan.js";
import { HarnessLaunchObservationService } from "./worker-runtime-environment.js";
import { runSpecFile } from "./workflows.js";
import { observeWorkspaceStructuralDigest } from "./workspace-snapshot.js";

const sha = (value: string) => value.repeat(64).slice(0, 64);
const encodeMetricRunEvent = Schema.encodeSync(RunEvent);
function exactEventMetricSource(
  events: ReadonlyArray<typeof RunEvent.Type>,
  type: (typeof RunEvent.Type)["type"]
) {
  const event = events.find((candidate) => candidate.type === type);
  if (event === undefined)
    throw new Error(`Missing authoritative fixture event ${type}.`);
  return {
    eventDigest: createHash("sha256")
      .update(
        canonicalV1("gaia.harness-evaluation-event.v1", [
          encodeMetricRunEvent(event),
        ])
      )
      .digest("hex"),
    eventType: event.type,
    kind: "event" as const,
    runId: event.runId,
    sequence: event.sequence,
  };
}
const roots: Array<string> = [];
const suiteRoots: Array<string> = [];
let sharedPublicScenarioReferences:
  | Effect.Success<ReturnType<typeof setupPublicScenarioReferences>>
  | undefined;
const baselineRevision = "dc559bd3236edf595ba36f8bf625d3dd97c24f91";
const treatmentRevision = "ac559bd3236edf595ba36f8bf625d3dd97c24f91";
const baselineSemanticContractDigest = digestHarnessEnvironmentContract(
  "gaia.fixture.adapter-semantic-contract.v1",
  ["baseline"]
);
const treatmentSemanticContractDigest = digestHarnessEnvironmentContract(
  "gaia.fixture.adapter-semantic-contract.v1",
  ["treatment"]
);
const reboundSemanticContractDigest = digestHarnessEnvironmentContract(
  "gaia.fixture.adapter-semantic-contract.v1",
  ["rebound"]
);
const workspaceAuthorityDigest = digestHarnessEnvironmentContract(
  "gaia.fixture.workspace-authority.v1",
  ["cill-i-am/gaia", ".gaia/runs/<runId>/workspace"]
);
const provider = HarnessProviderDescriptor.make({
  displayName: "Deterministic fake",
  executionModes: ["local"],
  providerId: parseHarnessProviderId("deterministic-fake"),
});
const runProfileBody = '{"profile":"fixed"}\n';
const skillManifestBody = '{"skills":[]}\n';
const workerPlanBody = '{"plan":"bounded"}\n';
const capabilities = HarnessCapabilities.make({
  approvals: [],
  fileChangeEvents: true,
  interruption: true,
  resumableSessions: true,
  review: false,
  steering: false,
  streamingMessages: true,
  structuredOutput: true,
  subagents: false,
  toolEvents: false,
  usageReporting: false,
  userQuestions: false,
});
const publicOutcomeStatement =
  "The bounded harness run completes through the production workflow.";
const publicReviewStatement =
  "Paired local reviewer approved the published exact head.";
const publicSpecBody = `---
title: Deterministic harness evaluation
verification:
  version: 2
  outcomes:
    - key: bounded-harness-run
      statement: ${publicOutcomeStatement}
      sourceItemDigest: ${deriveExplicitSpecItemDigest({
        section: "acceptanceCriteria",
        statement: publicOutcomeStatement,
      })}
      prePublicationRequiredClaims: []
      postPublicationRequiredClaims: [paired-review]
      conditionalClaims: []
  claims:
    - key: paired-review
      statement: ${publicReviewStatement}
      sourceItemDigest: ${deriveExplicitSpecItemDigest({
        section: "verificationChecks",
        statement: publicReviewStatement,
      })}
      phase: postPublication
      kind: human-judgment
      selector:
        source: localOperatorPairedReview
        decision: approved
---

## Acceptance Criteria

- ${publicOutcomeStatement}

## Verification

- ${publicReviewStatement}
`;
const spec = parseMarkdownSpec(publicSpecBody, "fallback");
const lessonSourceSpecBody = readFileSync(
  new URL("../../../examples/specs/claim-verification-v2.md", import.meta.url),
  "utf8"
);
const lessonSourceSpec = parseMarkdownSpec(
  lessonSourceSpecBody,
  "authoritative lesson source"
);

function digest(domain: string, value: unknown) {
  return createHash("sha256")
    .update(canonicalV1(domain, [value]))
    .digest("hex");
}

function rawDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixtureModelContent(
  episodeRole: "failureRepair" | "workerInitial" = "workerInitial"
) {
  return makeModelContextContentV1({
    acceptedOutcomes: ["Return one bounded result."],
    authority: ["Edit only the accepted issue."],
    budget: { maxOutputBytes: 16_384, maxTurns: 1 },
    contentRefs: [],
    episodeRole,
    instructions: ["Follow the accepted instructions."],
    nonGoals: ["Do not deploy."],
    outputContract: MODEL_OUTPUT_CONTRACT_CWD_RUN_MARKER_V1,
    planningFacts: ["events.jsonl is authoritative."],
    safeExclusions: ["credentials"],
    skills: ["effect-ts"],
    stops: ["Stop on scope drift."],
    taskInput: "Implement the accepted slice.",
    verificationCommands: ["pnpm test"],
  });
}

const baselineModelContent = fixtureModelContent();
const fixtureLessonCandidate = makeFactoryLessonCandidateV1({
  applicability: { episodeRole: "workerInitial", version: 1 },
  carryingCostOwner: "@gaia/runtime",
  compactLesson: "Use the exact event-owned harness preparation authority.",
  durableOwner: "@gaia/runtime/preflightHarnessRun",
  durableOwnerDigest: rawDigest("fixture-durable-owner"),
  durableOwnerVersion: "gaia.harness-preflight.v1",
  expectedEffect: "The exact prepared run fails closed before dispatch.",
  retirementCondition: "Retire only with a versioned successor.",
  version: 1,
});
const fixtureLessonAttestation = makeNoRawTelemetryAttestationV1({
  candidateDigest: fixtureLessonCandidate.candidateDigest,
  reviewerRef: "linear-comment:fixture-review",
});
const fixtureLessonReview = makeFactoryLessonReviewReceiptV1({
  attestation: fixtureLessonAttestation,
  candidate: fixtureLessonCandidate,
  decision: "accepted",
  source: {
    eventSequence: 1,
    failureFingerprint: rawDigest("fixture-failure"),
    runId: "run-source0001",
    type: "FAILURE_REPAIR_RECORDED",
    version: 1,
  },
});
if (fixtureLessonReview.decision !== "accepted")
  throw new Error("The deterministic lesson fixture must be accepted.");
const fixtureLessonProjection = fixtureLessonReview.projection;
const fixtureActiveLesson = FactoryLessonActiveV1.make({
  acceptedAt: "2026-07-25T20:00:00.000Z",
  acceptedEventSequence: parseRunEventSequence(2),
  projection: fixtureLessonProjection,
  sourceRunId: parseRunId("run-source0001"),
  version: 1,
});

function bytes(body: string) {
  return {
    byteLength: new TextEncoder().encode(body).byteLength,
    contentDigest: createHash("sha256").update(body).digest("hex"),
  };
}

beforeAll(async () => {
  sharedPublicScenarioReferences = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const templateRoot = yield* fs.makeTempDirectory({
        prefix: "gaia-harness-scenario-references-",
      });
      suiteRoots.push(templateRoot);
      return yield* setupPublicScenarioReferences(templateRoot);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

afterEach(async () => {
  for (const root of roots.splice(0))
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (yield* fs.exists(root)) yield* fs.remove(root, { recursive: true });
      }).pipe(Effect.provide(NodeServices.layer))
    );
});

afterAll(async () => {
  for (const root of suiteRoots.splice(0))
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (yield* fs.exists(root)) yield* fs.remove(root, { recursive: true });
      }).pipe(Effect.provide(NodeServices.layer))
    );
});

function getSharedPublicScenarioReferences() {
  if (sharedPublicScenarioReferences === undefined)
    throw new Error("Public scenario references were not prepared.");
  return sharedPublicScenarioReferences;
}

function contractFor(runId: ReturnType<typeof parseRunId>) {
  return makeRunContractV2({
    baseDigest: sha("d"),
    baseIdentity: { kind: "unversionedSnapshot", workspacePath: "." },
    runId,
    spec,
    targetDigest: sha("4"),
    targetIdentity: { kind: "unversionedWorkspace", workspacePath: "." },
  });
}

function proofContractDigest(contract: ReturnType<typeof contractFor>) {
  return digest("gaia.harness-proof-contract.v1", {
    acceptedOutcomes: contract.acceptedOutcomes,
    proofClaims: contract.proofClaims,
    specDigest: contract.specDigest,
    version: contract.version,
  });
}

function manifestInput(
  ownerRunId = parseRunId("run-owner00001"),
  scenarioId = "implementation-completes"
) {
  const baselineContract = contractFor(parseRunId("run-base000001"));
  return {
    acceptedOutcome: {
      outcomeId: baselineContract.acceptedOutcomes[0]!.outcomeId,
      proofContractDigest: proofContractDigest(baselineContract),
      version: 2 as const,
    },
    authorityDigest: workspaceAuthorityDigest,
    baseDigest: sha("d"),
    contextDigest: baselineModelContent.contextContentDigest,
    evaluationId: `evaluation-${scenarioId}`,
    externalCondition: {
      descriptor: "local-host-pinned",
      digest: sha("f"),
    },
    freshSessionPolicy: "globallyDistinct" as const,
    grader: { id: "grader.fixed", version: "1" },
    interventionWithheld:
      scenarioId === "lesson-observation"
        ? ("promotedControl" as const)
        : ("runtimeRevision" as const),
    limitations: ["singleLocalHost"] as const,
    manifestId: `baseline-${scenarioId}`,
    model: {
      id: "gpt-fixed",
      provider: "openai",
      reasoningEffort: "high",
    },
    ownerRunId,
    plannedBaselineRunIds: ["run-base000001"],
    plannedRepetitions: 1,
    profileDigest: bytes(runProfileBody).contentDigest,
    providerInterfaceDigest: baselineSemanticContractDigest,
    recordedAt: "2026-07-26T00:00:01.000Z",
    runtimeRevision: baselineRevision,
    scenario: { id: scenarioId, version: 1 },
    skillManifestDigest: bytes(skillManifestBody).contentDigest,
    stopConditions: ["unknownExternalOutcome"] as const,
    targetDigest: sha("4"),
    worker: {
      capabilityEpoch: "4.0.0-beta.93",
      id: provider.providerId,
    },
    workerPlanDigest: bytes(workerPlanBody).contentDigest,
  };
}

function resolvedExecutionFor(
  runtimeRevision: string,
  semanticContractDigest: string
) {
  return ResolvedHarnessExecution.make({
    capabilities,
    environmentAssignment: Schema.decodeUnknownSync(
      HarnessEnvironmentAssignmentV1
    )({
      adapter: {
        contractDigest: semanticContractDigest,
        contractId: "gaia.deterministic",
        contractVersion: "1",
        providerNativeToolInventoryObservation: "notExposed",
        toolContractDigest: rawDigest("fixture-tool-contract"),
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
        id: "gpt-fixed",
        provider: "openai",
        reasoningEffort: "high",
      },
      runtimeSource: {
        repositoryIdentity: "cill-i-am/gaia",
        revision: runtimeRevision,
        sourceState: "clean",
      },
      version: 1,
    }),
    executionMode: "local",
    harnessProfileId: codexAppServerHarnessProfileId,
    provider,
    version: "deterministic-1",
  });
}

function successfulProviderSpy(
  root: string,
  execution: ResolvedHarnessExecution,
  calls: Array<true>
) {
  return {
    name: codexAppServerHarnessName,
    run: (request: HarnessRunRequest) =>
      Effect.gen(function* () {
        calls.push(true);
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* makeRunPaths(request.runId, {
          rootDirectory: root,
        });
        yield* commitHarnessEnvironmentCandidate({
          events: yield* readEvents(paths),
          observation: HarnessLaunchObservationV1.make({
            approvalPolicy: "on-request",
            cwdMatchesWorkspaceBinding: true,
            model: "gpt-fixed",
            modelProvider: "openai",
            reasoningEffort: "high",
            sandbox: "workspace-write",
            source: "threadRuntimeResult",
          }),
          paths,
          resolvedExecution: execution,
          runId: request.runId,
        });
        const sessionId = parseHarnessSessionId(`session-${request.runId}`);
        yield* appendHarnessSessionEvent(request.runId, paths, {
          capabilities,
          kind: "sessionStarted",
          provider,
          sessionId,
          state: "running",
        });
        yield* appendHarnessSessionEvent(request.runId, paths, {
          kind: "sessionStateChanged",
          sessionId,
          state: "completed",
        });
        const result = HarnessRunResult.make({
          changedWorkspacePaths: ["output.txt"],
          exitCode: 0,
          harnessName: codexAppServerHarnessName,
          outputArtifacts: ["workspace/output.txt"],
          resultPath: "worker-result.json",
          runId: request.runId,
          status: "completed",
          summary: "Deterministic bound provider completed.",
        });
        yield* fs.writeFileString(
          request.workspaceOutputPath,
          `completed ${request.runId}\n`
        );
        yield* fs.writeFileString(
          request.workerResultPath,
          `${JSON.stringify(result)}\n`
        );
        return result;
      }).pipe(Effect.orDie),
  } as const;
}

function successfulBoundProviderRegistry(
  root: string,
  execution: ResolvedHarnessExecution,
  calls: Array<true>
) {
  const launchObservation = HarnessLaunchObservationService.of({
    complete: () => Effect.void,
    open: () => Effect.void,
    release: () => Effect.void,
    take: () =>
      Effect.succeed(
        HarnessLaunchObservationV1.make({
          approvalPolicy: "on-request",
          cwdMatchesWorkspaceBinding: true,
          model: "gpt-fixed",
          modelProvider: "openai",
          reasoningEffort: "high",
          sandbox: "workspace-write",
          source: "threadRuntimeResult",
        })
      ),
  });
  const provider: HarnessProvider = {
    createSession: (request) =>
      Effect.gen(function* () {
        calls.push(true);
        const fs = yield* FileSystem.FileSystem;
        const runId = parseRunId(
          String(request.sessionId).replace("session-", "")
        );
        yield* fs.writeFileString(
          `${root}/${request.workspacePath}/output.txt`,
          `${runId}\n`
        );
        return successfulBoundSession(request.sessionId, provider);
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    descriptor: execution.provider,
    detect: Effect.succeed({
      auth: { state: "notRequired" },
      capabilities: execution.capabilities,
      state: "available",
      version: execution.version,
    }),
    resumeSession: (request) =>
      Effect.succeed(successfulBoundSession(request.sessionId, provider)),
  };
  return makeHarnessProviderRegistry([
    {
      environmentAssignment: () =>
        Effect.succeed(execution.environmentAssignment!),
      launchObservation,
      profileId: codexAppServerHarnessProfileId,
      provider,
    },
  ]);
}

function successfulBoundSession(
  sessionId: ReturnType<typeof parseHarnessSessionId>,
  provider: HarnessProvider
): HarnessSession {
  const turnId = parseHarnessTurnId("turn-harness-evaluation");
  const events = [
    {
      capabilities,
      kind: "sessionStarted",
      provider: provider.descriptor,
      sessionId,
      state: "running",
    },
    { kind: "turnStarted", sessionId, turnId },
    { kind: "turnCompleted", sessionId, status: "completed", turnId },
  ] as const;
  return {
    events: Stream.fromIterable(events),
    interrupt: Option.some(Effect.void),
    resolveInteraction: () => Effect.void,
    send: () => Effect.succeed(undefined),
    snapshot: Effect.succeed(projectHarnessEvents(events, sessionId)),
    steer: Option.none(),
  };
}

function failingVerificationServices() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const profile = yield* readVerificationExecutionProfile(
      parseRuntimePath(
        new URL("../../../profiles/claim-verification.json", import.meta.url)
          .pathname
      )
    );
    return {
      executor: {
        execute: (invocation) =>
          Effect.gen(function* () {
            yield* invocation.onSandboxCreated({
              sandboxName: invocation.sandboxName,
              sandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
            });
            const stderr = "deterministic verification failure\n";
            yield* fs.writeFileString(invocation.stdoutPath, "");
            yield* fs.writeFileString(invocation.stderrPath, stderr);
            const workspaceObservation =
              yield* observeWorkspaceStructuralDigest(invocation.workspace);
            return Schema.decodeUnknownSync(
              StagedDockerSandboxVerificationReceiptSchema
            )({
              cleanup: {
                finalAbsenceConfirmed: true,
                removedSandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
                stoppedSandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
              },
              durationMs: 1,
              exitCode: 1,
              observedExecutionIdentity: {
                imageDigest: profile.imageDigest,
                providerBuild: profile.provider.build,
                providerVersion: profile.provider.version,
                templateReference: profile.templateReference,
              },
              observedProviderExitCode: 1,
              sandboxUuid: "123e4567-e89b-12d3-a456-426614174000",
              status: "nonZero",
              stderr: {
                artifactPath: invocation.stderrArtifactPath,
                contentDigest: rawDigest(stderr),
                observedByteCount: Buffer.byteLength(stderr),
                retainedByteCount: Buffer.byteLength(stderr),
                truncated: false,
              },
              stdout: {
                artifactPath: invocation.stdoutArtifactPath,
                contentDigest: rawDigest(""),
                observedByteCount: 0,
                retainedByteCount: 0,
                truncated: false,
              },
              workspaceObservation,
            });
          }).pipe(Effect.orDie),
        reconcile: () => Effect.die("The finite fixture does not reconcile."),
      },
      profile,
    } satisfies VerificationServices;
  });
}

function publicManifestInput(
  root: string,
  referenceRunId: ReturnType<typeof parseRunId>,
  ownerRunId: ReturnType<typeof parseRunId>,
  plannedRunId: ReturnType<typeof parseRunId>,
  scenarioId: string,
  execution: ResolvedHarnessExecution,
  runSpec = spec
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* makeRunPaths(referenceRunId, {
      rootDirectory: root,
    });
    const events = yield* readEvents(paths);
    const contractEvent = events.find(
      ({ type }) => type === "RUN_CONTRACT_RECORDED"
    );
    const workerStarted = events.find(({ type }) => type === "WORKER_STARTED");
    if (contractEvent === undefined || workerStarted === undefined)
      return yield* Effect.die(
        "The public commitment reference run is incomplete."
      );
    const contract = parseAnyRunContract(contractEvent.payload["contract"]);
    if (contract.version !== 2)
      return yield* Effect.die(
        "The public commitment reference run must use V2 proof."
      );
    const episode = Schema.decodeUnknownSync(ModelInvocationEpisodeStartV1)(
      workerStarted.payload["modelInvocationEpisode"]
    );
    const pair = yield* loadModelInvocationPair(paths, episode);
    const assignment = execution.environmentAssignment;
    if (assignment === undefined)
      return yield* Effect.die(
        "The public commitment fixture requires a complete execution."
      );
    const readDigest = (path: string) =>
      fs.readFileString(path).pipe(Effect.map((body) => rawDigest(body)));
    const plannedPaths = yield* makeRunPaths(plannedRunId, {
      rootDirectory: `${root}/manifest-planning`,
    });
    yield* fs.makeDirectory(plannedPaths.workspace, { recursive: true });
    yield* writeWorkerPlan({
      harnessName: codexAppServerHarnessName,
      paths: plannedPaths,
      runId: plannedRunId,
      spec: runSpec,
    });
    return {
      ...manifestInput(ownerRunId, scenarioId),
      acceptedOutcome: {
        outcomeId: contract.acceptedOutcomes[0]!.outcomeId,
        proofContractDigest: proofContractDigest(contract),
        version: 2 as const,
      },
      authorityDigest: assignment.authority.workspaceBindingDigest,
      baseDigest: contract.baseDigest,
      contextDigest: pair.context.payload.contextContentDigest,
      plannedBaselineRunIds: [plannedRunId],
      profileDigest: yield* readDigest(paths.runProfile),
      providerInterfaceDigest: assignment.adapter.contractDigest,
      runtimeRevision: assignment.runtimeSource.revision,
      skillManifestDigest: yield* readDigest(paths.skillManifest),
      targetDigest: contract.targetDigest,
      worker: {
        capabilityEpoch: assignment.effectDependencyEpoch,
        id: execution.provider.providerId,
      },
      workerPlanDigest: digestWorkerPlanEnvironmentSemantics(
        yield* fs.readFileString(plannedPaths.workerPlanResult)
      ),
    };
  });
}

function promoteFixtureLessonFromRun(
  root: string,
  runId: ReturnType<typeof parseRunId>
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, { rootDirectory: root });
    const events = yield* readEvents(paths);
    const contractEvent = events.find(
      ({ type }) => type === "RUN_CONTRACT_RECORDED"
    );
    const proofEvent = events.findLast(
      (event) =>
        event.type === "RUN_PROOF_RESULT_RECORDED" &&
        Schema.decodeUnknownSync(RunProofResultV2)(
          event.payload["result"]
        ).results.some(({ status }) => status === "failed")
    );
    const workerStarted = events.find(({ type }) => type === "WORKER_STARTED");
    if (
      contractEvent === undefined ||
      proofEvent === undefined ||
      workerStarted === undefined
    )
      return yield* Effect.die(
        "The public lesson source lacks contract, failed proof, or worker authority."
      );
    const contract = parseAnyRunContract(contractEvent.payload["contract"]);
    const proof = Schema.decodeUnknownSync(RunProofResultV2)(
      proofEvent.payload["result"]
    );
    const failedResult = proof.results.find(
      ({ status }) => status === "failed"
    );
    if (contract.version !== 2 || failedResult?.status !== "failed")
      return yield* Effect.die("The public lesson source must use V2 proof.");
    const failureEvidence = failedResult.evidence.filter(
      (evidence) => evidence.kind === "command"
    );
    if (failureEvidence.length !== 1)
      return yield* Effect.die(
        "The public lesson source must bind one failed command receipt."
      );
    const failure = makeFailureDigestV1({
      attempt: 1,
      evidenceRefs: failureEvidence,
      failedRef: { claimId: failedResult.claimId, kind: "claim" },
      maxAttempts: 2,
      outcomeCertainty: "confirmed",
      retryability: "repairable",
      stage: "verifying",
      tag: "verificationClaimFailed",
    });
    const episodeKey = `failureRepair:${failure.fingerprint}:1`;
    const workerEpisode = Schema.decodeUnknownSync(
      ModelInvocationEpisodeStartV1
    )(workerStarted.payload["modelInvocationEpisode"]);
    const workerPair = yield* loadModelInvocationPair(paths, workerEpisode);
    const content = fixtureModelContent("failureRepair");
    const workspaceBinding = workerPair.context.payload.workspaceBinding;
    const context = makeModelContextManifestV1({
      authoritativeRefs: [],
      binding: { episodeKey, runId },
      content,
      workspaceBinding,
    });
    const workerInvocation = workerPair.invocation.payload;
    const invocation = makeModelInvocationManifestV1({
      acceptedProviderCapabilityObservation:
        workerInvocation.acceptedProviderCapabilityObservation,
      adapterInputClass: workerInvocation.adapterInputClass,
      adapterSemantics: workerInvocation.adapterSemantics,
      authorityRef: workerInvocation.authorityRef,
      binding: context.payload.binding,
      budget: content.payload.budget,
      context,
      outputContract: content.payload.outputContract,
      rendered: renderModelInputV1(content),
      runContractRef: workerInvocation.runContractRef,
      template: workerInvocation.template,
      workspaceBinding,
    });
    const modelInvocationEpisode = yield* commitModelInvocationPair({
      context,
      episodeKey,
      invocation,
      paths,
    });
    const failureRepair = FailureRepairIntent.make({
      digest: failure,
      episodeKey,
      failedProofResultSequence: proofEvent.sequence,
      runId,
      state: "intentRecorded",
    });
    const sourceEvent = yield* appendEvent(runId, paths, {
      payload: {
        failureRepair: encodeFailureRepairReceiptJson(failureRepair),
        modelInvocationEpisode: Schema.encodeSync(
          ModelInvocationEpisodeStartV1
        )(modelInvocationEpisode),
      },
      type: "FAILURE_REPAIR_RECORDED",
    });
    yield* appendEvent(runId, paths, {
      payload: {
        code: "FixtureFailure",
        message: "The reviewed repair source ended terminally.",
        recoverable: false,
        stage: "verifying",
      },
      type: "RUN_FAILED",
    });
    const review = yield* recordFactoryLessonReview(
      runId,
      {
        attestation: fixtureLessonAttestation,
        candidate: fixtureLessonCandidate,
        decision: "accepted",
        source: {
          eventSequence: sourceEvent.event.sequence,
          failureFingerprint: failure.fingerprint,
          runId,
          type: "FAILURE_REPAIR_RECORDED",
          version: 1,
        },
      },
      { rootDirectory: root }
    );
    if (review.review.decision !== "accepted")
      return yield* Effect.die("The public lesson promotion was not accepted.");
    return review.review.projection;
  });
}

type SetupMutation =
  | "ambiguous-session"
  | "forged-artifact"
  | "reused-session"
  | "unrelated-session";

function setupAuthoritativeScenario(
  root: string,
  scenarioId: string,
  mutation?: SetupMutation
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ownerRunId = parseRunId("run-owner00001");
    const ownerPaths = yield* makeRunPaths(ownerRunId, { rootDirectory: root });
    yield* fs.makeDirectory(ownerPaths.root, { recursive: true });
    yield* appendEvent(ownerRunId, ownerPaths, {
      payload: {
        specPath: "input.md",
        workflow: "issueDelivery",
        workItem: {
          description: "Fixed-worker evaluation owner.",
          kind: "issue",
          title: "GAIA-151",
        },
      },
      type: "RUN_CREATED",
    });
    const planningPaths = yield* makeRunPaths(parseRunId("run-base000001"), {
      rootDirectory: `${root}/scenario-planning`,
    });
    yield* fs.makeDirectory(planningPaths.workspace, { recursive: true });
    yield* writeWorkerPlan({
      harnessName: codexAppServerHarnessName,
      paths: planningPaths,
      runId: parseRunId("run-base000001"),
      spec,
    });
    const generatedWorkerPlanBody = yield* fs.readFileString(
      planningPaths.workerPlanResult
    );
    const recordedManifest = yield* recordHarnessBaselineManifest(
      {
        ...manifestInput(ownerRunId, scenarioId),
        workerPlanDigest: digestWorkerPlanEnvironmentSemantics(
          generatedWorkerPlanBody
        ),
      },
      { rootDirectory: root }
    );
    const treatmentRunId = parseRunId(
      `run-${scenarioId.replaceAll("-", "").padEnd(10, "0").slice(0, 10)}`
    );
    const intervention =
      scenarioId === "lesson-observation"
        ? ({
            kind: "promotedControl",
            lessonId: fixtureLessonProjection.lessonId,
            projectionDigest: fixtureLessonProjection.projectionDigest,
            version: 1,
          } as const)
        : ({
            baselineRuntimeRevision: baselineRevision,
            baselineSemanticContractDigest,
            kind: "runtimeRevision",
            treatmentRuntimeRevision: treatmentRevision,
            treatmentSemanticContractDigest,
            version: 1,
          } as const);

    const setupSide = (
      runId: ReturnType<typeof parseRunId>,
      runtimeRevision: string,
      role: "baseline" | "treatment"
    ) =>
      Effect.gen(function* () {
        const paths = yield* makeRunPaths(runId, { rootDirectory: root });
        yield* fs.makeDirectory(paths.root, { recursive: true });
        const contract = contractFor(runId);
        type PreparedArtifactId =
          | "run-contract"
          | "run-profile"
          | "skill-manifest"
          | "worker-plan";
        const artifactBodies = new Map<PreparedArtifactId, string>([
          ["run-contract", canonicalRunContractBody(contract)],
          ["run-profile", runProfileBody],
          ["skill-manifest", skillManifestBody],
          ["worker-plan", generatedWorkerPlanBody],
        ]);
        const artifactPaths = new Map<PreparedArtifactId, string>([
          ["run-contract", String(runRelative(paths, paths.runContract))],
          ["run-profile", String(runRelative(paths, paths.runProfile))],
          ["skill-manifest", String(runRelative(paths, paths.skillManifest))],
          ["worker-plan", String(runRelative(paths, paths.workerPlanResult))],
        ]);
        for (const [artifactId, body] of artifactBodies) {
          const path = artifactPaths.get(artifactId)!;
          const absolute = `${paths.root}/${path}`;
          yield* fs.makeDirectory(
            absolute.slice(0, absolute.lastIndexOf("/")),
            {
              recursive: true,
            }
          );
          yield* fs.writeFileString(absolute, body);
        }
        yield* appendEvent(runId, paths, {
          payload: {
            execution: {
              resolved: Schema.encodeSync(ResolvedHarnessExecution)(
                ResolvedHarnessExecution.make({
                  capabilities,
                  environmentAssignment: Schema.decodeUnknownSync(
                    HarnessEnvironmentAssignmentV1
                  )({
                    adapter: {
                      contractDigest:
                        role === "treatment" &&
                        intervention.kind === "runtimeRevision"
                          ? intervention.treatmentSemanticContractDigest
                          : baselineSemanticContractDigest,
                      contractId: "gaia.deterministic",
                      contractVersion: "1",
                      providerNativeToolInventoryObservation: "notExposed",
                      toolContractDigest: rawDigest("fixture-tool-contract"),
                    },
                    authority: {
                      approvalPolicy: "on-request",
                      ephemeral: false,
                      sandbox: "workspace-write",
                      workspaceBindingDigest: workspaceAuthorityDigest,
                    },
                    effectDependencyEpoch: "4.0.0-beta.93",
                    hostClass: "localGaiaServer",
                    interfaceClass: "codexAppServerStdio",
                    model: {
                      id: "gpt-fixed",
                      provider: "openai",
                      reasoningEffort: "high",
                    },
                    runtimeSource: {
                      repositoryIdentity: "cill-i-am/gaia",
                      revision: runtimeRevision,
                      sourceState: "clean",
                    },
                    version: 1,
                  }),
                  executionMode: "local",
                  harnessProfileId: codexAppServerHarnessProfileId,
                  provider,
                  version: "deterministic-1",
                })
              ),
              selection: Schema.encodeSync(HarnessExecutionSelection)(
                codexAppServerExecutionSelection
              ),
            },
            modelInvocationProtocol: "v1",
            specPath: "input.md",
            workflow: "issueDelivery",
            workItem: {
              description: "Deterministic fixed-worker fixture.",
              kind: "issue",
              title: "GAIA-151",
            },
          },
          type: "RUN_CREATED",
        });
        yield* appendEvent(runId, paths, {
          payload: { contract: Schema.encodeSync(RunContractV2)(contract) },
          type: "RUN_CONTRACT_RECORDED",
        } as never);
        yield* appendEvent(runId, paths, {
          payload: { workspacePath: "." },
          type: "WORKSPACE_PREPARED",
        });
        const selectedFactoryLessons =
          role === "treatment" && intervention.kind === "promotedControl"
            ? selectFactoryLessonsForWorkerInitial({
                available: [fixtureActiveLesson],
                baseContent: baselineModelContent,
                target: {
                  createdAt: "2026-07-26T00:00:00.000Z",
                  runId,
                },
              })
            : undefined;
        const content = selectedFactoryLessons?.content ?? baselineModelContent;
        const workspaceBinding = {
          canonicalRunStoreRootDigest: rawDigest(`run-store\0${root}`),
          canonicalWorkspacePathDigest: rawDigest(`workspace\0${runId}`),
          runId,
          shape: ".gaia/runs/<runId>/workspace" as const,
          version: 1 as const,
          workspaceRole: "workerWorkspace" as const,
        };
        const context = makeModelContextManifestV1({
          authoritativeRefs: [],
          binding: { episodeKey: "workerInitial", runId },
          content,
          workspaceBinding,
        });
        const invocation = makeModelInvocationManifestV1({
          acceptedProviderCapabilityObservation: "unobservable",
          adapterInputClass: "codexAppTurn",
          adapterSemantics: {
            kind: "codexAppServer",
            semanticDigest: rawDigest("fixture-codex-app-server-semantics"),
          },
          authorityRef: {
            digest: rawDigest("fixture-authority"),
            kind: "authority",
          },
          binding: context.payload.binding,
          budget: content.payload.budget,
          context,
          outputContract: content.payload.outputContract,
          rendered: renderModelInputV1(content),
          runContractRef: {
            digest: contract.contractDigest,
            kind: "runContract",
          },
          template: { id: "gaia.worker-input.v1", version: 1 },
          workspaceBinding,
        });
        const modelInvocationEpisode = yield* commitModelInvocationPair({
          context,
          episodeKey: "workerInitial",
          invocation,
          paths,
        });
        const factoryLessonContextSelection =
          role === "treatment" && intervention.kind === "promotedControl"
            ? selectedFactoryLessons?.selection
            : undefined;
        const preparationBinding =
          role === "baseline"
            ? ({
                manifestRef: recordedManifest.ref,
                repetition: 1,
                role,
                runId,
              } as const)
            : ({
                intervention,
                manifestRef: recordedManifest.ref,
                repetition: 1,
                role,
                runId,
              } as const);
        const prepared = yield* preflightHarnessRun(
          runId,
          preparationBinding,
          modelInvocationEpisode,
          { rootDirectory: root },
          factoryLessonContextSelection
        );
        yield* appendEvent(runId, paths, {
          payload: {
            harnessBaselineManifestRef: Schema.encodeSync(
              HarnessBaselineManifestRefV1
            )(recordedManifest.ref),
            harnessPreparedRunReceiptRef: Schema.encodeSync(
              HarnessPreparedRunReceiptRefV1
            )(prepared.receiptRef),
            modelInvocationEpisode: Schema.encodeSync(
              ModelInvocationEpisodeStartV1
            )(modelInvocationEpisode),
            ...(factoryLessonContextSelection === undefined
              ? {}
              : {
                  factoryLessonContextSelection: Schema.encodeSync(
                    FactoryLessonContextSelectionV1
                  )(factoryLessonContextSelection),
                }),
          },
          type: "WORKER_STARTED",
        });
        const exactSession = parseHarnessSessionId(
          mutation === "reused-session" ? "session-reused" : `session-${runId}`
        );
        if (mutation === "unrelated-session")
          yield* appendHarnessSessionEvent(runId, paths, {
            capabilities,
            kind: "sessionStarted",
            provider,
            sessionId: parseHarnessSessionId(`session-unrelated-${runId}`),
            state: "running",
          });
        yield* appendHarnessSessionEvent(runId, paths, {
          capabilities,
          kind: "sessionStarted",
          provider,
          sessionId: exactSession,
          state: "running",
        });
        if (mutation === "ambiguous-session")
          yield* appendHarnessSessionEvent(runId, paths, {
            capabilities,
            kind: "sessionStarted",
            provider,
            sessionId: parseHarnessSessionId(`session-extra-${runId}`),
            state: "running",
          });
        yield* appendHarnessSessionEvent(runId, paths, {
          kind: "sessionStateChanged",
          sessionId: exactSession,
          state: "completed",
        });
        if (factoryLessonContextSelection !== undefined) {
          for (const [kind, source, trust] of [
            ["offered", "codexAppServerTransport", "high"],
            ["unobservable", "gaiaBoundary", "none"],
          ] as const) {
            const observation = makeFactoryLessonContextObservationV1({
              contextContentDigest:
                factoryLessonContextSelection.contextContentDigest,
              episodeRole: "workerInitial",
              kind,
              lesson: factoryLessonContextSelection.lessons[0]!,
              selectionDigest: factoryLessonContextSelection.selectionDigest,
              source,
              targetRunId: runId,
              trust,
            });
            yield* withRunEventSerialization(
              paths,
              Effect.gen(function* () {
                const events = yield* readEvents(paths);
                yield* appendPreparedEventWithinSerialization(
                  runId,
                  paths,
                  events,
                  makeRunEvent({
                    payload: {
                      factoryLessonContextObservation: Schema.encodeSync(
                        FactoryLessonContextObservationV1
                      )(observation),
                    },
                    runId,
                    sequence: events.length + 1,
                    timestamp: "2026-07-26T00:00:06.000Z",
                    type: "FACTORY_LESSON_CONTEXT_OBSERVED",
                  })
                );
              })
            );
          }
        }
        yield* appendEvent(runId, paths, {
          payload: { workerResultPath: "worker-result.json" },
          type: "WORKER_COMPLETED",
        });
        yield* appendEvent(runId, paths, {
          payload: {},
          type: "VERIFICATION_STARTED",
        });
        const current = yield* readEvents(paths);
        const proofSequence = current.length + 1;
        const proof = makeRunProofResultV2({
          contentAuthoritySequence: proofSequence - 2,
          contract,
          observedTargetDigest: contract.targetDigest,
          recordedBy: {
            runId,
            sequence: proofSequence,
            type: "RUN_PROOF_RESULT_RECORDED",
          },
          results: Schema.decodeUnknownSync(
            Schema.Array(ProofClaimResultV2Schema)
          )(
            contract.proofClaims.map(({ claimId }) => ({
              claimId,
              reason: "Deterministic conformance fixture.",
              status: "not-run",
            }))
          ),
        });
        yield* fs.writeFileString(
          paths.verificationResult,
          canonicalRunProofResultBody(proof)
        );
        yield* appendEvent(runId, paths, {
          payload: {
            result: Schema.encodeSync(RunProofResultV2)(proof),
            verificationResultPath: "verification-result.json",
          },
          type: "RUN_PROOF_RESULT_RECORDED",
        });
        const events = yield* readEvents(paths);
        return {
          events,
          exactSession: String(exactSession),
          modelInvocationEpisode,
          paths,
          prefix: makeHarnessEvaluationPrefixRef(runId, events),
          receipt: prepared.receipt,
          runId,
        };
      });

    const baseline = yield* setupSide(
      parseRunId("run-base000001"),
      baselineRevision,
      "baseline"
    );
    const treatment = yield* setupSide(
      treatmentRunId,
      scenarioId === "lesson-observation"
        ? baselineRevision
        : treatmentRevision,
      "treatment"
    );
    const input = Schema.encodeSync(HarnessEvaluationRecordingInputV1Schema)(
      Schema.decodeUnknownSync(HarnessEvaluationRecordingInputV1Schema)({
        anchorRunId: treatment.runId,
        baselineManifestRef: recordedManifest.ref,
        evaluationId: recordedManifest.manifest.evaluationId,
        grader: recordedManifest.manifest.grader,
        intervention,
        limitations: [],
        metrics:
          mutation === "forged-artifact"
            ? [
                {
                  family: "proofCompleteness",
                  provenance: {
                    artifactId: "run-contract",
                    byteLength: 1,
                    contentDigest: sha("f"),
                    kind: "artifact",
                    owningEventSequence: 1,
                    path: "run-contract.json",
                    runId: baseline.runId,
                  },
                  repetition: 1,
                  value: "forged",
                },
              ]
            : [
                {
                  family:
                    scenarioId === "bounded-authorized-repair"
                      ? "attemptsRepairTrajectory"
                      : scenarioId === "unknown-outcome-no-redispatch"
                        ? "unknownExternalEffects"
                        : "acceptedOutcomeCorrectness",
                  provenance: {
                    algorithm: "authority-reference-summary",
                    kind: "inferred",
                    limitation: "conformance-only",
                    sources: [
                      exactEventMetricSource(
                        baseline.events,
                        "HARNESS_PREPARED_RUN_RECORDED"
                      ),
                    ],
                    version: "1",
                  },
                  repetition: 1,
                },
              ],
        repetitions: [
          {
            baseline: {
              baselineManifestRef: recordedManifest.ref,
              prefix: baseline.prefix,
              runId: baseline.runId,
              sessionId: baseline.exactSession,
            },
            treatment: {
              prefix: treatment.prefix,
              runId: treatment.runId,
              sessionId: treatment.exactSession,
            },
          },
        ],
        scenario: {
          id: scenarioId,
          minimumRepetitions:
            scenarioId === "wait-expires-and-restarts" ? 2 : 1,
          version: 1,
        },
      })
    );
    return { baseline, input, recordedManifest, treatment };
  });
}

function scenarioRunId(role: "baseline" | "treatment", scenarioId: string) {
  const rolePrefix = role === "baseline" ? "b" : "t";
  const scenarioPart = scenarioId
    .replaceAll("-", "")
    .padEnd(9, "0")
    .slice(0, 9);
  return parseRunId(`run-${rolePrefix}${scenarioPart}`);
}

function setupPublicScenarioReferences(root: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baselineExecution = resolvedExecutionFor(
      baselineRevision,
      baselineSemanticContractDigest
    );
    const references = yield* Effect.all(
      [
        {
          runSpec: spec,
          specBody: publicSpecBody,
          specPath: `${root}/standard-spec.md`,
          verificationServices: undefined,
        },
        {
          runSpec: lessonSourceSpec,
          specBody: lessonSourceSpecBody,
          specPath: `${root}/lesson-source-spec.md`,
          verificationServices: yield* failingVerificationServices(),
        },
      ].map((reference) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(reference.specPath, reference.specBody);
          const calls: Array<true> = [];
          const run = yield* runSpecFile(reference.specPath, {
            rootDirectory: root,
            ...(reference.verificationServices === undefined
              ? {}
              : { verificationServices: reference.verificationServices }),
            workerHarness: successfulProviderSpy(
              root,
              baselineExecution,
              calls
            ),
          });
          return { ...reference, runId: run.runId };
        })
      ),
      { concurrency: 1 }
    );
    return {
      baselineExecution,
      lessonSource: references[1]!,
      standard: references[0]!,
      templateRoot: root,
    };
  });
}

function setupPublicAuthoritativeRuns(
  root: string,
  scenarioId: string,
  shared: Effect.Success<ReturnType<typeof setupPublicScenarioReferences>>
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const promotedControl = scenarioId === "lesson-observation";
    const reference = promotedControl ? shared.lessonSource : shared.standard;
    const scenarioSpec = reference.runSpec;
    const specPath = `${root}/spec.md`;
    const verificationServices = reference.verificationServices;
    const calls: Array<true> = [];
    const baselineExecution = shared.baselineExecution;
    yield* fs.writeFileString(specPath, reference.specBody);
    const templateReferencePaths = yield* makeRunPaths(reference.runId, {
      rootDirectory: shared.templateRoot,
    });
    const referencePaths = yield* makeRunPaths(reference.runId, {
      rootDirectory: root,
    });
    yield* fs.makeDirectory(`${root}/.gaia/runs`, { recursive: true });
    yield* fs.copy(templateReferencePaths.root, referencePaths.root);
    const ownerRunId = parseRunId("run-owner00001");
    const ownerPaths = yield* makeRunPaths(ownerRunId, { rootDirectory: root });
    yield* fs.makeDirectory(ownerPaths.root, { recursive: true });
    yield* appendEvent(ownerRunId, ownerPaths, {
      payload: {
        specPath: "input.md",
        workflow: "issueDelivery",
        workItem: {
          description: "Fixed-worker evaluation owner.",
          kind: "issue",
          title: "GAIA-151",
        },
      },
      type: "RUN_CREATED",
    });
    const baselineRunId = scenarioRunId("baseline", scenarioId);
    const recordedManifest = yield* recordHarnessBaselineManifest(
      yield* publicManifestInput(
        root,
        reference.runId,
        ownerRunId,
        baselineRunId,
        scenarioId,
        baselineExecution,
        scenarioSpec
      ),
      { rootDirectory: root }
    );
    calls.length = 0;
    yield* runSpecFile(specPath, {
      harnessPreparationBinding: {
        manifestRef: recordedManifest.ref,
        repetition: 1,
        role: "baseline",
        runId: baselineRunId,
      },
      harnessProviderRegistry: successfulBoundProviderRegistry(
        root,
        baselineExecution,
        calls
      ),
      rootDirectory: root,
      ...(verificationServices === undefined ? {} : { verificationServices }),
    });
    const selectedIntervention = promotedControl
      ? yield* promoteFixtureLessonFromRun(root, baselineRunId).pipe(
          Effect.map(
            (projection) =>
              ({
                kind: "promotedControl",
                lessonId: projection.lessonId,
                projectionDigest: projection.projectionDigest,
                version: 1,
              }) as const
          )
        )
      : ({
          baselineRuntimeRevision: baselineRevision,
          baselineSemanticContractDigest,
          kind: "runtimeRevision",
          treatmentRuntimeRevision: treatmentRevision,
          treatmentSemanticContractDigest,
          version: 1,
        } as const);
    const treatmentRunId = scenarioRunId("treatment", scenarioId);
    const treatmentExecution = promotedControl
      ? baselineExecution
      : resolvedExecutionFor(
          treatmentRevision,
          treatmentSemanticContractDigest
        );
    yield* runSpecFile(specPath, {
      harnessPreparationBinding: {
        intervention: selectedIntervention,
        manifestRef: recordedManifest.ref,
        repetition: 1,
        role: "treatment",
        runId: treatmentRunId,
      },
      harnessProviderRegistry: successfulBoundProviderRegistry(
        root,
        treatmentExecution,
        calls
      ),
      rootDirectory: root,
      ...(verificationServices === undefined ? {} : { verificationServices }),
    });
    expect(calls).toHaveLength(2);

    const readSide = (runId: ReturnType<typeof parseRunId>) =>
      Effect.gen(function* () {
        const paths = yield* makeRunPaths(runId, { rootDirectory: root });
        const events = yield* readEvents(paths);
        const preparedEvent = events.find(
          ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
        );
        if (preparedEvent === undefined)
          return yield* Effect.die("Public scenario preparation is missing.");
        return {
          events,
          exactSession: String(parseHarnessSessionId(`session-${runId}`)),
          paths,
          prefix: makeHarnessEvaluationPrefixRef(runId, events),
          receipt: Schema.decodeUnknownSync(HarnessPreparedRunReceiptV1)(
            preparedEvent.payload["harnessPreparedRunReceipt"]
          ),
          runId,
        };
      });
    const baseline = yield* readSide(baselineRunId);
    const treatment = yield* readSide(treatmentRunId);
    return {
      baseline,
      recordedManifest,
      selectedIntervention,
      treatment,
    };
  });
}

function setupPublicAuthoritativeScenario(
  root: string,
  scenarioId: string,
  shared: Effect.Success<ReturnType<typeof setupPublicScenarioReferences>>
) {
  return Effect.gen(function* () {
    const { baseline, recordedManifest, selectedIntervention, treatment } =
      yield* setupPublicAuthoritativeRuns(root, scenarioId, shared);
    const input = Schema.encodeSync(HarnessEvaluationRecordingInputV1Schema)(
      Schema.decodeUnknownSync(HarnessEvaluationRecordingInputV1Schema)({
        anchorRunId: treatment.runId,
        baselineManifestRef: recordedManifest.ref,
        evaluationId: recordedManifest.manifest.evaluationId,
        grader: recordedManifest.manifest.grader,
        intervention: selectedIntervention,
        limitations: [],
        metrics: [
          {
            family:
              scenarioId === "bounded-authorized-repair"
                ? "attemptsRepairTrajectory"
                : scenarioId === "unknown-outcome-no-redispatch"
                  ? "unknownExternalEffects"
                  : "acceptedOutcomeCorrectness",
            provenance: {
              algorithm: "authority-reference-summary" as const,
              kind: "inferred",
              limitation: "conformance-only",
              sources: [
                exactEventMetricSource(
                  baseline.events,
                  "HARNESS_PREPARED_RUN_RECORDED"
                ),
              ],
              version: "1" as const,
            },
            repetition: 1,
          },
        ],
        repetitions: [
          {
            baseline: {
              baselineManifestRef: recordedManifest.ref,
              prefix: baseline.prefix,
              runId: baseline.runId,
              sessionId: baseline.exactSession,
            },
            treatment: {
              prefix: treatment.prefix,
              runId: treatment.runId,
              sessionId: treatment.exactSession,
            },
          },
        ],
        scenario: {
          id: scenarioId,
          minimumRepetitions:
            scenarioId === "wait-expires-and-restarts" ? 2 : 1,
          version: 1,
        },
      })
    );
    return { baseline, input, recordedManifest, treatment };
  });
}

describe("harness baseline and preparation authority", () => {
  it("records idempotently and rebuilds event-owned manifest bytes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-manifest-",
        });
        roots.push(root);
        const runId = parseRunId("run-owner00001");
        const paths = yield* makeRunPaths(runId, { rootDirectory: root });
        yield* fs.makeDirectory(paths.root, { recursive: true });
        yield* appendEvent(runId, paths, {
          payload: { specPath: "input.md" },
          type: "RUN_CREATED",
        });
        const input = manifestInput(runId);
        const first = yield* recordHarnessBaselineManifest(input, {
          rootDirectory: root,
        });
        const second = yield* recordHarnessBaselineManifest(input, {
          rootDirectory: root,
        });
        expect(second.event.sequence).toBe(first.event.sequence);
        expect(
          (yield* recordHarnessBaselineManifest(
            { ...input, workerPlanDigest: sha("6") },
            { rootDirectory: root }
          ).pipe(Effect.exit))._tag
        ).toBe("Failure");
        const canonical = yield* canonicalHarnessBaselineManifestBody(runId, {
          rootDirectory: root,
        });
        yield* fs.writeFileString(paths.harnessBaselineManifest, "tampered");
        expect(
          yield* readHarnessBaselineManifest(runId, { rootDirectory: root })
        ).toEqual(first.manifest);
        expect(yield* fs.readFileString(paths.harnessBaselineManifest)).toBe(
          canonical
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("rejects lifecycle-authority events through the generic append path", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-generic-append-",
        });
        roots.push(root);
        const runId = parseRunId("run-generic001");
        const paths = yield* makeRunPaths(runId, { rootDirectory: root });
        yield* fs.makeDirectory(paths.root, { recursive: true });
        yield* appendEvent(runId, paths, {
          payload: { specPath: "input.md" },
          type: "RUN_CREATED",
        });

        for (const type of [
          "HARNESS_BASELINE_MANIFEST_RECORDED",
          "HARNESS_PREPARED_RUN_RECORDED",
          "HARNESS_EVALUATION_RECORDED",
        ] as const) {
          const attempted = yield* appendEvent(runId, paths, {
            payload: {},
            type,
          } as never).pipe(Effect.exit);
          expect(attempted._tag).toBe("Failure");
        }
        expect((yield* readEvents(paths)).map((event) => event.type)).toEqual([
          "RUN_CREATED",
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("rejects secret-shaped manifest material before persistence", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-secret-boundary-",
        });
        roots.push(root);
        const runId = parseRunId("run-secret0001");
        const paths = yield* makeRunPaths(runId, { rootDirectory: root });
        yield* fs.makeDirectory(paths.root, { recursive: true });
        yield* appendEvent(runId, paths, {
          payload: { specPath: "input.md" },
          type: "RUN_CREATED",
        });

        const attempted = yield* recordHarnessBaselineManifest(
          {
            ...manifestInput(runId),
            workerPlanDigest: "sk-plaintext-secret",
          } as never,
          { rootDirectory: root }
        ).pipe(Effect.exit);
        expect(attempted._tag).toBe("Failure");
        expect((yield* readEvents(paths)).map((event) => event.type)).toEqual([
          "RUN_CREATED",
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("fails baseline and treatment preparation before reviewer or worker provider effects", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-preflight-",
        });
        roots.push(root);
        const manifest = makeHarnessBaselineManifestV1(manifestInput());
        const specPath = `${root}/spec.md`;
        yield* fs.writeFileString(specPath, publicSpecBody);
        let reviewerCalls = 0;
        const workerCalls: Array<true> = [];
        const execution = resolvedExecutionFor(
          baselineRevision,
          baselineSemanticContractDigest
        );
        const manifestRef = makeHarnessBaselineManifestRefV1({
          eventSequence: 2,
          manifest,
        });
        const reviewer = {
          adapterKind: "deterministic",
          name: "provider-spy",
          run: () =>
            Effect.sync(() => {
              reviewerCalls += 1;
              throw new Error("reviewer must not run");
            }),
        } as never;
        for (const harnessPreparationBinding of [
          {
            manifestRef,
            repetition: 1,
            role: "baseline" as const,
            runId: parseRunId("run-base000001"),
          },
          {
            intervention: {
              baselineRuntimeRevision: baselineRevision,
              baselineSemanticContractDigest,
              kind: "runtimeRevision" as const,
              treatmentRuntimeRevision: treatmentRevision,
              treatmentSemanticContractDigest,
              version: 1 as const,
            },
            manifestRef,
            repetition: 1,
            role: "treatment" as const,
            runId: parseRunId("run-treat00001"),
          },
        ]) {
          const failed = yield* runSpecFile(specPath, {
            harnessPreparationBinding,
            harnessProviderRegistry: successfulBoundProviderRegistry(
              root,
              execution,
              workerCalls
            ),
            reviewer,
            rootDirectory: root,
          }).pipe(Effect.exit);
          expect(failed._tag).toBe("Failure");
          expect(String(failed)).toContain(
            "The baseline manifest ref does not resolve its authoritative event."
          );
        }
        expect(reviewerCalls).toBe(0);
        expect(workerCalls).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("rejects caller-attested execution, missing registry, and worker substitution before provider start", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-provider-authority-",
        });
        roots.push(root);
        const specPath = `${root}/spec.md`;
        yield* fs.writeFileString(specPath, publicSpecBody);
        const runId = parseRunId("run-base000001");
        const binding = {
          manifestRef: makeHarnessBaselineManifestRefV1({
            eventSequence: 2,
            manifest: makeHarnessBaselineManifestV1(manifestInput()),
          }),
          repetition: 1,
          role: "baseline" as const,
          runId,
        };
        const execution = resolvedExecutionFor(
          baselineRevision,
          baselineSemanticContractDigest
        );
        const calls: Array<true> = [];
        const registry = successfulBoundProviderRegistry(
          root,
          execution,
          calls
        );

        const attested = yield* runSpecFile(specPath, {
          harnessPreparationBinding: binding,
          harnessPreparationExecution: execution,
          harnessProviderRegistry: registry,
          rootDirectory: root,
        } as never).pipe(Effect.exit);
        expect(String(attested)).toContain(
          "Caller-attested harness execution is not accepted."
        );

        const missingRegistry = yield* runSpecFile(specPath, {
          harnessPreparationBinding: binding,
          rootDirectory: root,
        }).pipe(Effect.exit);
        expect(String(missingRegistry)).toContain(
          "No harness provider registry is available"
        );

        const substituted = yield* runSpecFile(specPath, {
          harnessPreparationBinding: binding,
          harnessProviderRegistry: registry,
          rootDirectory: root,
          workerHarness: successfulProviderSpy(root, execution, calls),
        }).pipe(Effect.exit);
        expect(String(substituted)).toContain(
          "must use the provider resolved by its registry"
        );
        expect(calls).toHaveLength(0);
        expect(
          yield* fs.exists(
            (yield* makeRunPaths(runId, { rootDirectory: root })).root
          )
        ).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("dispatches the exact precommitted baseline run through runSpecFile with content-bound preparation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-public-baseline-",
        });
        roots.push(root);
        const specPath = `${root}/spec.md`;
        yield* fs.writeFileString(specPath, publicSpecBody);
        const calls: Array<true> = [];
        const execution = resolvedExecutionFor(
          baselineRevision,
          baselineSemanticContractDigest
        );
        const workerHarness = successfulProviderSpy(root, execution, calls);
        const reference = yield* runSpecFile(specPath, {
          rootDirectory: root,
          workerHarness,
        });
        const ownerRunId = parseRunId("run-owner00001");
        const ownerPaths = yield* makeRunPaths(ownerRunId, {
          rootDirectory: root,
        });
        yield* fs.makeDirectory(ownerPaths.root, { recursive: true });
        yield* appendEvent(ownerRunId, ownerPaths, {
          payload: { specPath: "input.md" },
          type: "RUN_CREATED",
        });
        const runId = parseRunId("run-base000001");
        const manifest = yield* recordHarnessBaselineManifest(
          yield* publicManifestInput(
            root,
            reference.runId,
            ownerRunId,
            runId,
            "implementation-completes",
            execution
          ),
          { rootDirectory: root }
        );
        calls.length = 0;
        const completed = yield* runSpecFile(specPath, {
          harnessPreparationBinding: {
            manifestRef: manifest.ref,
            repetition: 1,
            role: "baseline",
            runId,
          },
          harnessProviderRegistry: successfulBoundProviderRegistry(
            root,
            execution,
            calls
          ),
          rootDirectory: root,
        });
        expect(completed.runId).toBe(runId);
        expect(calls).toHaveLength(1);
        const paths = yield* makeRunPaths(runId, { rootDirectory: root });
        const events = yield* readEvents(paths);
        const prepared = events.find(
          ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
        );
        const started = events.find(({ type }) => type === "WORKER_STARTED");
        const completedEvent = events.find(
          ({ type }) => type === "WORKER_COMPLETED"
        );
        const sessionStarted = events
          .filter(({ type }) => type === "HARNESS_SESSION_EVENT_RECORDED")
          .map((event) => parseHarnessEvent(event.payload["event"]))
          .find(({ kind }) => kind === "sessionStarted");
        if (
          prepared === undefined ||
          started === undefined ||
          completedEvent === undefined ||
          sessionStarted?.kind !== "sessionStarted"
        )
          return yield* Effect.die("The bound public run was not prepared.");
        const persistedExecution = Schema.decodeUnknownSync(
          ResolvedHarnessExecution
        )(Reflect.get(events[0]?.payload["execution"] as object, "resolved"));
        const receipt = Schema.decodeUnknownSync(HarnessPreparedRunReceiptV1)(
          prepared.payload["harnessPreparedRunReceipt"]
        );
        const episode = Schema.decodeUnknownSync(ModelInvocationEpisodeStartV1)(
          started.payload["modelInvocationEpisode"]
        );
        const pair = yield* loadModelInvocationPair(paths, episode);
        expect(receipt.preparedInputs.contextDigest).toBe(
          pair.context.payload.contextContentDigest
        );
        expect(receipt.preparedInputs.contextDigest).not.toBe(
          pair.context.contextDigest
        );
        expect(persistedExecution).toEqual(execution);
        expect(receipt.preparedInputs.providerInterfaceDigest).toBe(
          execution.environmentAssignment?.adapter.contractDigest
        );
        expect(receipt.preparedInputs.runtimeRevision).toBe(
          execution.environmentAssignment?.runtimeSource.revision
        );
        expect(started.payload["harnessPreparedRunReceiptRef"]).toEqual({
          eventSequence: prepared.sequence,
          receiptDigest: receipt.receiptDigest,
          runId,
          version: 1,
        });
        expect(sessionStarted.provider).toEqual(execution.provider);
        expect(sessionStarted.sessionId).toBe(`session-${runId}`);
        expect(completedEvent.payload["modelInvocationObservation"]).toEqual(
          expect.objectContaining({
            kind: "offered",
            source: "codexAppServerTransport",
          })
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("dispatches runtime-revision treatment through the same exact production preparation seam", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-public-runtime-revision-",
        });
        roots.push(root);
        const specPath = `${root}/spec.md`;
        yield* fs.writeFileString(specPath, publicSpecBody);
        const calls: Array<true> = [];
        const baselineExecution = resolvedExecutionFor(
          baselineRevision,
          baselineSemanticContractDigest
        );
        const reference = yield* runSpecFile(specPath, {
          rootDirectory: root,
          workerHarness: successfulProviderSpy(root, baselineExecution, calls),
        });
        const ownerRunId = parseRunId("run-owner00001");
        const ownerPaths = yield* makeRunPaths(ownerRunId, {
          rootDirectory: root,
        });
        yield* fs.makeDirectory(ownerPaths.root, { recursive: true });
        yield* appendEvent(ownerRunId, ownerPaths, {
          payload: { specPath: "input.md" },
          type: "RUN_CREATED",
        });
        const baselineRunId = parseRunId("run-base000001");
        const recordedManifest = yield* recordHarnessBaselineManifest(
          yield* publicManifestInput(
            root,
            reference.runId,
            ownerRunId,
            baselineRunId,
            "implementation-completes",
            baselineExecution
          ),
          { rootDirectory: root }
        );
        calls.length = 0;
        yield* runSpecFile(specPath, {
          harnessPreparationBinding: {
            manifestRef: recordedManifest.ref,
            repetition: 1,
            role: "baseline",
            runId: baselineRunId,
          },
          harnessProviderRegistry: successfulBoundProviderRegistry(
            root,
            baselineExecution,
            calls
          ),
          rootDirectory: root,
        });
        const treatmentRunId = parseRunId("run-treat00001");
        const treatmentExecution = resolvedExecutionFor(
          treatmentRevision,
          treatmentSemanticContractDigest
        );
        yield* runSpecFile(specPath, {
          harnessPreparationBinding: {
            intervention: {
              baselineRuntimeRevision: baselineRevision,
              baselineSemanticContractDigest,
              kind: "runtimeRevision",
              treatmentRuntimeRevision: treatmentRevision,
              treatmentSemanticContractDigest,
              version: 1,
            },
            manifestRef: recordedManifest.ref,
            repetition: 1,
            role: "treatment",
            runId: treatmentRunId,
          },
          harnessProviderRegistry: successfulBoundProviderRegistry(
            root,
            treatmentExecution,
            calls
          ),
          rootDirectory: root,
        });
        expect(calls).toHaveLength(2);
        const baselineEvents = yield* readEvents(
          yield* makeRunPaths(baselineRunId, { rootDirectory: root })
        );
        const treatmentEvents = yield* readEvents(
          yield* makeRunPaths(treatmentRunId, { rootDirectory: root })
        );
        const receipt = (events: ReadonlyArray<RunEvent>) =>
          Schema.decodeUnknownSync(HarnessPreparedRunReceiptV1)(
            events.find(({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED")
              ?.payload["harnessPreparedRunReceipt"]
          );
        const baselineReceipt = receipt(baselineEvents);
        const treatmentReceipt = receipt(treatmentEvents);
        expect(treatmentReceipt.preparedInputs).toEqual({
          ...baselineReceipt.preparedInputs,
          providerInterfaceDigest: treatmentSemanticContractDigest,
          runtimeRevision: treatmentRevision,
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("fails run reuse and every resolved execution mismatch with zero provider effects", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-public-mismatch-",
        });
        roots.push(root);
        const specPath = `${root}/spec.md`;
        yield* fs.writeFileString(specPath, publicSpecBody);
        const calls: Array<true> = [];
        const baselineExecution = resolvedExecutionFor(
          baselineRevision,
          baselineSemanticContractDigest
        );
        const reference = yield* runSpecFile(specPath, {
          rootDirectory: root,
          workerHarness: successfulProviderSpy(root, baselineExecution, calls),
        });
        const ownerRunId = parseRunId("run-owner00001");
        const ownerPaths = yield* makeRunPaths(ownerRunId, {
          rootDirectory: root,
        });
        yield* fs.makeDirectory(ownerPaths.root, { recursive: true });
        yield* appendEvent(ownerRunId, ownerPaths, {
          payload: { specPath: "input.md" },
          type: "RUN_CREATED",
        });
        const baselineRunId = parseRunId("run-base000001");
        const manifest = yield* recordHarnessBaselineManifest(
          yield* publicManifestInput(
            root,
            reference.runId,
            ownerRunId,
            baselineRunId,
            "implementation-completes",
            baselineExecution
          ),
          { rootDirectory: root }
        );
        calls.length = 0;
        const baselineBinding = {
          manifestRef: manifest.ref,
          repetition: 1,
          role: "baseline" as const,
          runId: baselineRunId,
        };
        yield* runSpecFile(specPath, {
          harnessPreparationBinding: baselineBinding,
          harnessProviderRegistry: successfulBoundProviderRegistry(
            root,
            baselineExecution,
            calls
          ),
          rootDirectory: root,
        });
        expect(calls).toHaveLength(1);

        calls.length = 0;
        const reused = yield* runSpecFile(specPath, {
          harnessPreparationBinding: baselineBinding,
          harnessProviderRegistry: successfulBoundProviderRegistry(
            root,
            baselineExecution,
            calls
          ),
          rootDirectory: root,
        }).pipe(Effect.exit);
        expect(reused._tag).toBe("Failure");
        expect(String(reused)).toContain("already has local run-store state");
        expect(calls).toHaveLength(0);

        const treatmentRunId = parseRunId("run-treat00001");
        const rebound = yield* runSpecFile(specPath, {
          harnessPreparationBinding: {
            intervention: {
              baselineRuntimeRevision: baselineRevision,
              baselineSemanticContractDigest,
              kind: "runtimeRevision",
              treatmentRuntimeRevision: treatmentRevision,
              treatmentSemanticContractDigest,
              version: 1,
            },
            manifestRef: manifest.ref,
            repetition: 1,
            role: "treatment",
            runId: treatmentRunId,
          },
          harnessProviderRegistry: successfulBoundProviderRegistry(
            root,
            baselineExecution,
            calls
          ),
          rootDirectory: root,
        }).pipe(Effect.exit);
        expect(rebound._tag).toBe("Failure");
        expect(String(rebound)).toContain("providerInterfaceDigest");
        expect(String(rebound)).toContain("runtimeRevision");
        expect(calls).toHaveLength(0);

        const treatmentExecution = resolvedExecutionFor(
          treatmentRevision,
          treatmentSemanticContractDigest
        );
        const mismatches = [
          {
            execution: ResolvedHarnessExecution.make({
              ...treatmentExecution,
              provider: HarnessProviderDescriptor.make({
                ...treatmentExecution.provider,
                providerId: parseHarnessProviderId("rebound-provider"),
              }),
            }),
            runId: parseRunId("run-treat00002"),
          },
          {
            execution: ResolvedHarnessExecution.make({
              ...treatmentExecution,
              environmentAssignment: HarnessEnvironmentAssignmentV1.make({
                ...treatmentExecution.environmentAssignment!,
                model: {
                  ...treatmentExecution.environmentAssignment!.model,
                  id: "gpt-rebound",
                },
              }),
            }),
            runId: parseRunId("run-treat00003"),
          },
        ];
        for (const mismatch of mismatches) {
          const failed = yield* runSpecFile(specPath, {
            harnessPreparationBinding: {
              intervention: {
                baselineRuntimeRevision: baselineRevision,
                baselineSemanticContractDigest,
                kind: "runtimeRevision",
                treatmentRuntimeRevision: treatmentRevision,
                treatmentSemanticContractDigest,
                version: 1,
              },
              manifestRef: manifest.ref,
              repetition: 1,
              role: "treatment",
              runId: mismatch.runId,
            },
            harnessProviderRegistry: successfulBoundProviderRegistry(
              root,
              mismatch.execution,
              calls
            ),
            rootDirectory: root,
          }).pipe(Effect.exit);
          expect(failed._tag).toBe("Failure");
          expect(calls).toHaveLength(0);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("dispatches promoted-control treatment with exact authoritative selection and content binding", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-public-promoted-control-",
        });
        roots.push(root);
        const setup = yield* setupPublicAuthoritativeRuns(
          root,
          "lesson-observation",
          getSharedPublicScenarioReferences()
        );
        if (setup.selectedIntervention.kind !== "promotedControl")
          return yield* Effect.die(
            "The promoted-control fixture selected another intervention."
          );
        const workerStarted = setup.treatment.events.find(
          ({ type }) => type === "WORKER_STARTED"
        );
        if (workerStarted === undefined)
          return yield* Effect.die("The promoted treatment did not start.");
        const selection = Schema.decodeUnknownSync(
          FactoryLessonContextSelectionV1
        )(workerStarted.payload["factoryLessonContextSelection"]);
        const episode = Schema.decodeUnknownSync(ModelInvocationEpisodeStartV1)(
          workerStarted.payload["modelInvocationEpisode"]
        );
        const pair = yield* loadModelInvocationPair(
          setup.treatment.paths,
          episode
        );
        expect(selection.lessons).toEqual([
          {
            lessonId: setup.selectedIntervention.lessonId,
            projectionDigest: setup.selectedIntervention.projectionDigest,
            version: 1,
          },
        ]);
        expect(setup.treatment.receipt.preparedInputs.contextDigest).toBe(
          selection.contextContentDigest
        );
        expect(pair.context.payload.contextContentDigest).toBe(
          selection.contextContentDigest
        );
        expect(setup.treatment.receipt.preparedInputs.contextDigest).not.toBe(
          setup.baseline.receipt.preparedInputs.contextDigest
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("replays the same prepared-run digest idempotently after dispatch", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-preflight-idempotent-",
        });
        roots.push(root);
        const setup = yield* setupAuthoritativeScenario(
          root,
          "implementation-completes"
        );
        const replayed = yield* preflightHarnessRun(
          setup.baseline.runId,
          {
            manifestRef: setup.recordedManifest.ref,
            repetition: 1,
            role: "baseline",
            runId: setup.baseline.runId,
          },
          setup.baseline.modelInvocationEpisode,
          { rootDirectory: root }
        );
        expect(replayed.receipt.receiptDigest).toBe(
          setup.baseline.receipt.receiptDigest
        );
        expect(replayed.receiptRef.eventSequence).toBe(4);
        expect(
          (yield* readEvents(setup.baseline.paths)).filter(
            ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
          )
        ).toHaveLength(1);
        yield* fs.writeFileString(
          setup.baseline.paths.workerPlanResult,
          '{"plan":"changed"}\n'
        );
        expect(
          (yield* preflightHarnessRun(
            setup.baseline.runId,
            {
              manifestRef: setup.recordedManifest.ref,
              repetition: 1,
              role: "baseline",
              runId: setup.baseline.runId,
            },
            setup.baseline.modelInvocationEpisode,
            { rootDirectory: root }
          ).pipe(Effect.exit))._tag
        ).toBe("Failure");
        expect(
          (yield* readEvents(setup.baseline.paths)).filter(
            ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
          )
        ).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("binds baseline-only planned runs and the exact treatment intervention at its slot", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-role-binding-",
        });
        roots.push(root);
        const setup = yield* setupAuthoritativeScenario(
          root,
          "implementation-completes"
        );
        expect(setup.recordedManifest.manifest.plannedBaselineRunIds).toEqual([
          setup.baseline.runId,
        ]);
        expect(
          setup.recordedManifest.manifest.plannedBaselineRunIds
        ).not.toContain(setup.treatment.runId);
        expect(setup.baseline.receipt.preparationBinding).toMatchObject({
          repetition: 1,
          role: "baseline",
        });
        expect(setup.treatment.receipt.preparationBinding).toMatchObject({
          intervention: setup.input.intervention,
          repetition: 1,
          role: "treatment",
        });
        expect(setup.treatment.receipt.preparedInputs).toEqual({
          ...setup.baseline.receipt.preparedInputs,
          providerInterfaceDigest:
            setup.input.intervention.kind === "runtimeRevision"
              ? setup.input.intervention.treatmentSemanticContractDigest
              : setup.baseline.receipt.preparedInputs.providerInterfaceDigest,
          runtimeRevision:
            setup.input.intervention.kind === "runtimeRevision"
              ? setup.input.intervention.treatmentRuntimeRevision
              : setup.baseline.receipt.preparedInputs.runtimeRevision,
        });
        const treatmentBinding = setup.treatment.receipt.preparationBinding;
        if (treatmentBinding.role !== "treatment")
          throw new Error("fixture treatment must use treatment authority");
        expect(
          (yield* preflightHarnessRun(
            setup.treatment.runId,
            {
              intervention: treatmentBinding.intervention,
              manifestRef: setup.recordedManifest.ref,
              repetition: 2,
              role: "treatment",
              runId: setup.treatment.runId,
            },
            setup.treatment.modelInvocationEpisode,
            { rootDirectory: root }
          ).pipe(Effect.exit))._tag
        ).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("rejects generic append and internal-only treatment receipt shortcuts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-prepared-append-",
        });
        roots.push(root);
        const setup = yield* setupAuthoritativeScenario(
          root,
          "implementation-completes"
        );
        const attempted = yield* appendEvent(
          setup.treatment.runId,
          setup.treatment.paths,
          {
            payload: {
              harnessPreparedRunReceipt: Schema.encodeSync(
                HarnessPreparedRunReceiptV1
              )(setup.treatment.receipt),
            },
            type: "HARNESS_PREPARED_RUN_RECORDED",
          } as never
        ).pipe(Effect.exit);
        expect(attempted._tag).toBe("Failure");
        expect(
          (yield* readEvents(setup.treatment.paths)).filter(
            ({ type }) => type === "HARNESS_PREPARED_RUN_RECORDED"
          )
        ).toHaveLength(1);
        yield* withRunEventSerialization(
          setup.treatment.paths,
          Effect.gen(function* () {
            const events = yield* readEvents(setup.treatment.paths);
            yield* appendPreparedEventWithinSerialization(
              setup.treatment.runId,
              setup.treatment.paths,
              events,
              makeRunEvent({
                payload: {
                  harnessPreparedRunReceipt: Schema.encodeSync(
                    HarnessPreparedRunReceiptV1
                  )(setup.treatment.receipt),
                },
                runId: setup.treatment.runId,
                sequence: events.length + 1,
                timestamp: "2026-07-26T00:00:07.000Z",
                type: "HARNESS_PREPARED_RUN_RECORDED",
              })
            );
          })
        );
        const events = yield* readEvents(setup.treatment.paths);
        const repetition = setup.input.repetitions[0]!;
        expect(
          (yield* recordHarnessEvaluation(
            {
              ...setup.input,
              repetitions: [
                {
                  baseline: repetition.baseline,
                  treatment: {
                    ...repetition.treatment,
                    prefix: makeHarnessEvaluationPrefixRef(
                      setup.treatment.runId,
                      events
                    ),
                  },
                },
              ],
            },
            { rootDirectory: root }
          ).pipe(Effect.exit))._tag
        ).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });
});

describe("runtime-owned harness evaluation authority", () => {
  it("binds operator-supplied evidence to the configured grader before append", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const makeInput = (
          setup: Effect.Success<ReturnType<typeof setupAuthoritativeScenario>>,
          grader: { readonly id: string; readonly version: string },
          statement: string,
          statementDigest = makeHarnessOperatorStatementDigestV1({
            grader,
            statement,
          })
        ) => ({
          ...setup.input,
          metrics: [
            {
              family: "humanAttention" as const,
              provenance: {
                graderId: grader.id,
                graderVersion: grader.version,
                kind: "operatorSupplied" as const,
                recordedAt: "2026-07-26T00:00:09.000Z",
                statement,
                statementDigest,
              },
              repetition: 1,
              value: "bounded-observation",
            },
          ],
        });
        const safeRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-operator-safe-",
        });
        roots.push(safeRoot);
        const safe = yield* setupAuthoritativeScenario(
          safeRoot,
          "implementation-completes"
        );
        const safeStatement = "The exact authoritative proof event completed.";
        const recorded = yield* recordHarnessEvaluation(
          makeInput(safe, safe.input.grader, safeStatement),
          { rootDirectory: safeRoot }
        );
        expect(recorded.evaluation.metrics[0]?.provenance).toMatchObject({
          graderId: safe.input.grader.id,
          graderVersion: safe.input.grader.version,
          statement: safeStatement,
        });

        const secretRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-operator-safe-decode-",
        });
        roots.push(secretRoot);
        const secretSetup = yield* setupAuthoritativeScenario(
          secretRoot,
          "implementation-completes"
        );
        const secretInput = makeInput(
          secretSetup,
          secretSetup.input.grader,
          "Safe statement before boundary mutation."
        );
        const secretMetric = secretInput.metrics[0]!;
        const credential = "github_pat_11AAABBBCCCDDDEEEFFF_1234567890abcdef";
        const beforeEvents = yield* readEvents(secretSetup.treatment.paths);
        const rejected = yield* Effect.flip(
          recordHarnessEvaluation(
            {
              ...secretInput,
              metrics: [
                {
                  ...secretMetric,
                  provenance: {
                    ...secretMetric.provenance,
                    statement: `Observed ${credential}`,
                  },
                },
              ],
            },
            { rootDirectory: secretRoot }
          )
        );
        expect(rejected).toBeInstanceOf(GaiaRuntimeError);
        if (!(rejected instanceof GaiaRuntimeError)) return;
        expect(rejected.code).toBe("InvalidHarnessEvaluationRequest");
        expect(rejected.message).toBe(
          "Harness evaluation recording selectors are invalid."
        );
        expect(rejected.cause).toBeUndefined();
        expect(String(rejected)).not.toContain(credential);
        expect(JSON.stringify(rejected)).not.toContain(credential);
        expect(yield* readEvents(secretSetup.treatment.paths)).toEqual(
          beforeEvents
        );
        expect(
          yield* fs.exists(secretSetup.treatment.paths.harnessEvaluation)
        ).toBe(false);

        for (const [name, mutate] of [
          [
            "grader-rebound",
            (
              setup: Effect.Success<
                ReturnType<typeof setupAuthoritativeScenario>
              >
            ) => {
              const grader = { id: "grader.rebound", version: "1" };
              return makeInput(setup, grader, "Rebound grader statement.");
            },
          ],
          [
            "statement-digest-forged",
            (
              setup: Effect.Success<
                ReturnType<typeof setupAuthoritativeScenario>
              >
            ) =>
              makeInput(
                setup,
                setup.input.grader,
                "Mutated statement.",
                sha("f")
              ),
          ],
          [
            "statement-secret",
            (
              setup: Effect.Success<
                ReturnType<typeof setupAuthoritativeScenario>
              >
            ) =>
              makeInput(
                setup,
                setup.input.grader,
                "Bearer live-token",
                sha("f")
              ),
          ],
          [
            "statement-over-bound",
            (
              setup: Effect.Success<
                ReturnType<typeof setupAuthoritativeScenario>
              >
            ) =>
              makeInput(setup, setup.input.grader, "x".repeat(513), sha("f")),
          ],
        ] as const) {
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: `gaia-harness-operator-${name}-`,
          });
          roots.push(root);
          const setup = yield* setupAuthoritativeScenario(
            root,
            "implementation-completes"
          );
          expect(
            (yield* recordHarnessEvaluation(mutate(setup), {
              rootDirectory: root,
            }).pipe(Effect.exit))._tag
          ).toBe("Failure");
          expect(
            (yield* readEvents(setup.treatment.paths)).some(
              ({ type }) => type === "HARNESS_EVALUATION_RECORDED"
            )
          ).toBe(false);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("resolves every inferred source inside its exact cohort authority", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-inferred-source-",
        });
        roots.push(root);
        const setup = yield* setupAuthoritativeScenario(
          root,
          "implementation-completes"
        );
        const exact = exactEventMetricSource(
          setup.baseline.events,
          "HARNESS_PREPARED_RUN_RECORDED"
        );
        const exactArtifact = {
          ...setup.baseline.receipt.artifacts.find(
            ({ artifactId }) => artifactId === "run-contract"
          )!,
          kind: "artifact" as const,
          owningEventSequence: exact.sequence,
          runId: setup.baseline.runId,
        };
        const inputWith = (
          sources: ReadonlyArray<typeof exact | typeof exactArtifact>
        ) => ({
          ...setup.input,
          metrics: setup.input.metrics.map((metric) => ({
            family: metric.family,
            provenance: {
              algorithm: "authority-reference-summary" as const,
              kind: "inferred" as const,
              limitation: "conformance-only",
              sources,
              version: "1" as const,
            },
            repetition: metric.repetition,
          })),
        });
        const inferredRequest = inputWith([exact]);
        const callerValued = {
          ...inferredRequest,
          metrics: inferredRequest.metrics.map((metric) => ({
            ...metric,
            value: "caller-attested",
          })),
        };
        const unknownAlgorithm = {
          ...inferredRequest,
          metrics: inferredRequest.metrics.map((metric) => ({
            ...metric,
            provenance: {
              ...metric.provenance,
              algorithm: "caller-selected-algorithm",
            },
          })),
        };
        for (const rejectedInput of [callerValued, unknownAlgorithm]) {
          const beforeEvents = yield* readEvents(setup.treatment.paths);
          const rejected = yield* Effect.flip(
            recordHarnessEvaluation(rejectedInput, { rootDirectory: root })
          );
          expect(rejected).toBeInstanceOf(GaiaRuntimeError);
          expect((rejected as GaiaRuntimeError).code).toBe(
            "InvalidHarnessEvaluationRequest"
          );
          expect(yield* readEvents(setup.treatment.paths)).toEqual(
            beforeEvents
          );
          expect(
            yield* fs.exists(setup.treatment.paths.harnessEvaluation)
          ).toBe(false);
        }
        expect(
          (yield* recordHarnessEvaluation(inputWith([exact, exactArtifact]), {
            rootDirectory: root,
          })).evaluation.metrics[0]?.provenance
        ).toMatchObject({ sources: [exact, exactArtifact] });

        for (const sources of [
          [{ ...exact, sequence: exact.sequence + 100 }],
          [{ ...exact, runId: parseRunId("run-missing001") }],
          [{ ...exact, runId: setup.treatment.runId }],
          [exact, exact],
        ]) {
          const invalidRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "gaia-harness-inferred-invalid-",
          });
          roots.push(invalidRoot);
          const invalidSetup = yield* setupAuthoritativeScenario(
            invalidRoot,
            "implementation-completes"
          );
          const invalidExact = exactEventMetricSource(
            invalidSetup.baseline.events,
            "HARNESS_PREPARED_RUN_RECORDED"
          );
          const reboundSources = sources.map((source) => ({
            ...source,
            eventDigest: invalidExact.eventDigest,
            runId:
              source.runId === setup.treatment.runId
                ? invalidSetup.treatment.runId
                : source.runId === exact.runId
                  ? invalidExact.runId
                  : source.runId,
            sequence:
              source.sequence === exact.sequence
                ? invalidExact.sequence
                : source.sequence,
          }));
          expect(
            (yield* recordHarnessEvaluation(
              {
                ...invalidSetup.input,
                metrics: invalidSetup.input.metrics.map((metric) => ({
                  ...metric,
                  provenance: {
                    algorithm: "authority-reference-summary",
                    kind: "inferred" as const,
                    limitation: "conformance-only",
                    sources: reboundSources,
                    version: "1",
                  },
                })),
              },
              { rootDirectory: invalidRoot }
            ).pipe(Effect.exit))._tag
          ).toBe("Failure");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("rejects caller-attested conditions and evidence at the recording boundary", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-self-attestation-",
        });
        roots.push(root);
        const setup = yield* setupAuthoritativeScenario(
          root,
          "implementation-completes"
        );
        expect(
          (yield* recordHarnessEvaluation(
            {
              ...setup.input,
              conditions: { authorityDigest: sha("f") },
              evidence: { contractDigest: sha("e") },
            } as never,
            { rootDirectory: root }
          ).pipe(Effect.exit))._tag
        ).toBe("Failure");
        const promotedRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-self-attestation-promoted-",
        });
        roots.push(promotedRoot);
        const promoted = yield* setupAuthoritativeScenario(
          promotedRoot,
          "lesson-observation"
        );
        expect(
          (yield* recordHarnessEvaluation(
            {
              ...promoted.input,
              interventionEvidence: {
                available: true,
                observation: "relevant",
              },
            } as never,
            { rootDirectory: promotedRoot }
          ).pipe(Effect.exit))._tag
        ).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("rejects role, run, and intervention rebound from prepared authority", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-rebound-",
        });
        roots.push(root);
        const setup = yield* setupAuthoritativeScenario(
          root,
          "implementation-completes"
        );
        const repetition = setup.input.repetitions[0]!;
        for (const rebound of [
          {
            ...setup.input,
            repetitions: [
              {
                baseline: {
                  ...repetition.baseline,
                  prefix: repetition.treatment.prefix,
                  runId: repetition.treatment.runId,
                  sessionId: repetition.treatment.sessionId,
                },
                treatment: repetition.treatment,
              },
            ],
          },
          {
            ...setup.input,
            intervention: {
              ...setup.input.intervention,
              treatmentSemanticContractDigest: reboundSemanticContractDigest,
            },
          },
          {
            ...setup.input,
            baselineManifestRef: {
              ...setup.input.baselineManifestRef,
              eventSequence: setup.input.baselineManifestRef.eventSequence + 1,
            },
          },
          {
            ...setup.input,
            repetitions: [
              {
                baseline: repetition.baseline,
                treatment: {
                  ...repetition.treatment,
                  runId: repetition.baseline.runId,
                },
              },
            ],
          },
        ]) {
          expect(
            (yield* recordHarnessEvaluation(rebound as never, {
              rootDirectory: root,
            }).pipe(Effect.exit))._tag
          ).toBe("Failure");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("rejects standard bearer credential material before persistence", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-evaluation-secret-",
        });
        roots.push(root);
        const setup = yield* setupAuthoritativeScenario(
          root,
          "implementation-completes"
        );
        const credentialBearingInput = {
          ...setup.input,
          metrics: setup.input.metrics.map((metric) => ({
            ...metric,
            value: "Bearer live-token",
          })),
        };
        const attempted = yield* recordHarnessEvaluation(
          credentialBearingInput,
          { rootDirectory: root }
        ).pipe(Effect.exit);
        expect(attempted._tag).toBe("Failure");
        expect(
          (yield* readEvents(setup.treatment.paths)).some(
            ({ type }) => type === "HARNESS_EVALUATION_RECORDED"
          )
        ).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  it("records valid distinct session-${runId} bindings and rebuilds exact bytes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "gaia-harness-evaluation-",
        });
        roots.push(root);
        const setup = yield* setupAuthoritativeScenario(
          root,
          "implementation-completes"
        );
        const treatmentContract = setup.treatment.receipt.artifacts.find(
          (artifact) => artifact.artifactId === "run-contract"
        )!;
        const input = {
          ...setup.input,
          metrics: [
            {
              family: "proofCompleteness" as const,
              provenance: {
                ...treatmentContract,
                kind: "artifact" as const,
                owningEventSequence: 4,
                runId: setup.treatment.runId,
              },
              repetition: 1,
              value: "exact-authoritative-bytes",
            },
          ],
        };
        const first = yield* recordHarnessEvaluation(input, {
          rootDirectory: root,
        });
        const second = yield* recordHarnessEvaluation(input, {
          rootDirectory: root,
        });
        expect(second.event.sequence).toBe(first.event.sequence);
        expect(first.evaluation.validity.state).toBe("validComparable");
        const evaluationBody = yield* canonicalHarnessEvaluationBody(
          setup.treatment.runId,
          { rootDirectory: root }
        );
        yield* fs.writeFileString(
          setup.treatment.paths.harnessEvaluation,
          "tampered"
        );
        expect(
          yield* readHarnessEvaluation(setup.treatment.runId, {
            rootDirectory: root,
          })
        ).toEqual(first.evaluation);
        expect(
          yield* fs.readFileString(setup.treatment.paths.harnessEvaluation)
        ).toBe(evaluationBody);
        const preparedBody = yield* canonicalHarnessPreparedRunBody(
          setup.treatment.runId,
          { rootDirectory: root }
        );
        expect(
          (yield* readLocalRunArtifact(
            setup.treatment.runId,
            "harness-prepared-run",
            { rootDirectory: root }
          )).body
        ).toBe(preparedBody);
        yield* rebuildFactoryRunIndexes(setup.treatment.runId, {
          rootDirectory: root,
        });
        expect(
          (yield* readFactoryRunArtifact(
            setup.treatment.runId,
            Schema.decodeUnknownSync(FactoryArtifactIdSchema)(
              "harness-evaluation"
            ),
            { rootDirectory: root }
          )).body
        ).toBe(evaluationBody);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
    );
  });

  for (const mutation of [
    "forged-artifact",
    "unrelated-session",
    "ambiguous-session",
    "reused-session",
  ] as const)
    it(`fails closed for ${mutation}`, async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({
            prefix: `gaia-harness-${mutation}-`,
          });
          roots.push(root);
          const setup = yield* setupAuthoritativeScenario(
            root,
            "implementation-completes",
            mutation
          );
          expect(
            (yield* recordHarnessEvaluation(setup.input, {
              rootDirectory: root,
            }).pipe(Effect.exit))._tag
          ).toBe("Failure");
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
      );
    });
});

describe("deterministic authoritative harness scenarios", () => {
  const scenarioIds = [
    "bounded-authorized-repair",
    "cancelled-terminal",
    "implementation-completes",
    "lesson-observation",
    "unknown-outcome-no-redispatch",
    "verification-fails",
    "wait-expires-and-restarts",
  ] as const;
  it("redacts secret-bearing invalid scenario inputs before storage resolution", async () => {
    const credential = "github_pat_11AAABBBCCCDDDEEEFFF_1234567890abcdef";
    const root = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory({
          prefix: "gaia-harness-scenario-safe-decode-",
        });
      }).pipe(Effect.provide(NodeServices.layer))
    );
    roots.push(root);
    const providerLayer = Layer.succeed(HarnessEvaluationScenarioProvider, {
      load: () =>
        Effect.succeed({
          input: {
            credential,
            metrics: [{ value: credential }],
          },
          options: { rootDirectory: root },
        }),
    });
    const rejected = await Effect.runPromise(
      Effect.flip(
        evaluateHarnessScenario("implementation-completes").pipe(
          Effect.provide(Layer.merge(providerLayer, NodeServices.layer))
        )
      )
    );
    expect(rejected).toBeInstanceOf(GaiaRuntimeError);
    if (!(rejected instanceof GaiaRuntimeError)) return;
    expect(rejected.code).toBe("HarnessEvaluationScenarioInvalid");
    expect(rejected.message).toBe(
      "The scenario provider returned invalid stable selectors."
    );
    expect(rejected.cause).toBeUndefined();
    expect(String(rejected)).not.toContain(credential);
    expect(JSON.stringify(rejected)).not.toContain(credential);
    expect(
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.exists(`${root}/.gaia`);
        }).pipe(Effect.provide(NodeServices.layer))
      )
    ).toBe(false);
  });

  const fakeLayer = Layer.effect(
    HarnessEvaluationScenarioProvider,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const byScenario = new Map<string, HarnessEvaluationScenarioFixture>();
      const shared = getSharedPublicScenarioReferences();
      return {
        load: (scenarioId: (typeof scenarioIds)[number]) =>
          Effect.gen(function* () {
            const cached = byScenario.get(scenarioId);
            if (cached !== undefined) return cached;
            const root = yield* fs.makeTempDirectory({
              prefix: `gaia-harness-scenario-${scenarioId}-`,
            });
            roots.push(root);
            const setup = yield* setupPublicAuthoritativeScenario(
              root,
              scenarioId,
              shared
            );
            expect(setup.baseline.receipt.preparationBinding.role).toBe(
              "baseline"
            );
            expect(setup.treatment.receipt.preparationBinding).toMatchObject({
              intervention: setup.input.intervention,
              repetition: 1,
              role: "treatment",
            });
            const fixture = {
              input: setup.input,
              options: { rootDirectory: root },
            };
            byScenario.set(scenarioId, fixture);
            return fixture;
          }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
      };
    })
  ).pipe(Layer.provide(NodeServices.layer));

  layer(Layer.merge(fakeLayer, NodeServices.layer))((it) => {
    for (const scenarioId of scenarioIds) {
      it.effect(
        `evaluates ${scenarioId} from finite production-path histories`,
        () =>
          Effect.gen(function* () {
            yield* TestClock.setTime(1_000);
            const first = yield* evaluateHarnessScenario(scenarioId);
            yield* TestClock.setTime(2_000);
            const second = yield* evaluateHarnessScenario(scenarioId);
            expect(first.observedAtMillis).toBe(1_000);
            expect(second.observedAtMillis).toBe(2_000);
            expect(second.evaluation).toEqual(first.evaluation);
            const provenance = first.evaluation.metrics[0]?.provenance;
            expect(provenance?.kind).toBe("inferred");
            if (provenance?.kind === "inferred")
              expect(provenance.sources).toEqual([
                expect.objectContaining({
                  eventType: "HARNESS_PREPARED_RUN_RECORDED",
                  kind: "event",
                }),
              ]);
            expect(first.evaluation.metrics[0]?.value).toEqual({
              artifactIds: [],
              eventTypes: ["HARNESS_PREPARED_RUN_RECORDED"],
              sourceCount: 1,
            });
            expect(
              JSON.stringify(first.evaluation.metrics[0]?.value)
            ).not.toMatch(
              /caus|availab|relev|lesson|invok|retriev|correct|improv/iu
            );
            if (scenarioId === "lesson-observation") {
              expect(first.evaluation.validity.state).toBe(
                "insufficientEvidence"
              );
              expect(first.evaluation.interventionEvidence).toEqual({
                available: true,
                observation: "unobservable",
              });
              expect(JSON.stringify(first.evaluation)).not.toContain(
                '"opened"'
              );
            }
            if (scenarioId === "wait-expires-and-restarts")
              expect(first.evaluation.validity.state).toBe(
                "insufficientEvidence"
              );
          })
      );
    }
  });
});
