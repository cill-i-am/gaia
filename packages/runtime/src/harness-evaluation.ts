import { createHash } from "node:crypto";

import {
  canonicalV1,
  FactoryLessonContextSelectionV1,
  HarnessBaselineManifestV1,
  HarnessBaselineManifestRefV1,
  HarnessBaselinePreparedInputsV1,
  HarnessRunPreparationBindingV1,
  HarnessPreparedRunReceiptRefV1,
  HarnessPreparedRunReceiptV1,
  HarnessEvaluationV1,
  HarnessEvaluationInterventionV1,
  HarnessEvaluationInputV1Schema,
  HarnessEvaluationPrefixRefV1,
  HarnessEvaluationRecordingInputV1Schema,
  makeHarnessBaselineManifestRefV1,
  makeHarnessBaselineManifestV1,
  makeHarnessEvaluationV1,
  makeHarnessPreparedRunReceiptRefV1,
  makeHarnessPreparedRunReceiptV1,
  makeRunEvent,
  parseHarnessBaselineManifestV1,
  parseHarnessEvaluationV1,
  parseHarnessPreparedRunReceiptV1,
  parseHarnessEvent,
  parseModelContextContent,
  parseAnyRunContract,
  parseAnyRunProofResultEnvelope,
  projectHarnessBaselinePreparedInputsV1,
  resolveFactoryLessonContextAttribution,
  replayHarnessSession,
  ResolvedHarnessExecution,
  RunEvent,
  ModelInvocationEpisodeStartV1,
  type RunId,
} from "@gaia/core";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  PartitionedSemaphore,
  Schema,
} from "effect";

import { makeRuntimeError } from "./errors.js";
import {
  appendPreparedEventWithinSerialization,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import {
  assertFactoryRunAcceptanceSecretSafe,
  loadModelInvocationPair,
} from "./model-invocation.js";
import {
  makeRunPaths,
  makeRunStorePaths,
  runRelative,
  RunStorageOptionsSchema,
  type RuntimePath,
  type RunPaths,
  type RunStorageOptions,
} from "./paths.js";
import { canonicalRunProofResultBody } from "./run-contract.js";
import { digestWorkerPlanEnvironmentSemantics } from "./worker-plan.js";

const encodeManifest = Schema.encodeSync(HarnessBaselineManifestV1);
const encodeEvaluation = Schema.encodeSync(HarnessEvaluationV1);
const encodePreparedRunReceipt = Schema.encodeSync(HarnessPreparedRunReceiptV1);
const encodeRunEvent = Schema.encodeSync(RunEvent);
const decodeScenarioInput = Schema.decodeUnknownSync(
  HarnessEvaluationRecordingInputV1Schema,
  { onExcessProperty: "error" }
);
const projectionSemaphore = PartitionedSemaphore.makeUnsafe<string>({
  permits: 1,
});

function runtimeFailure(code: string, message: string, cause?: unknown) {
  return makeRuntimeError({ cause, code, message, recoverable: false });
}

export const HarnessEvaluationScenarioIdSchema = Schema.Literals([
  "bounded-authorized-repair",
  "cancelled-terminal",
  "implementation-completes",
  "lesson-observation",
  "unknown-outcome-no-redispatch",
  "verification-fails",
  "wait-expires-and-restarts",
] as const);
export type HarnessEvaluationScenarioId =
  typeof HarnessEvaluationScenarioIdSchema.Type;

const HarnessEvaluationScenarioFixtureSchema = Schema.Struct({
  input: Schema.Unknown,
  options: RunStorageOptionsSchema,
});

export type HarnessEvaluationScenarioFixture =
  typeof HarnessEvaluationScenarioFixtureSchema.Encoded;

export class HarnessEvaluationScenarioProvider extends Context.Service<
  HarnessEvaluationScenarioProvider,
  {
    readonly load: (
      scenarioId: HarnessEvaluationScenarioId
    ) => Effect.Effect<HarnessEvaluationScenarioFixture>;
  }
>()("@gaia/runtime/HarnessEvaluationScenarioProvider") {}

/**
 * Finite, Clock-owned scenario evaluation. Live providers are deliberately not
 * part of this service: adapters must return normalized serializable evidence.
 */
export function evaluateHarnessScenario(
  scenarioId: HarnessEvaluationScenarioId
) {
  return Effect.gen(function* () {
    const provider = yield* HarnessEvaluationScenarioProvider;
    const observedAtMillis = yield* Clock.currentTimeMillis;
    const loaded = yield* provider.load(scenarioId);
    const request = yield* decodeHarnessEvaluationRecordingInput(
      loaded.input,
      "HarnessEvaluationScenarioInvalid",
      "The scenario provider returned invalid stable selectors."
    );
    const resolved = yield* resolveEvaluationInput(request, loaded.options);
    return {
      evaluation: makeHarnessEvaluationV1(resolved),
      observedAtMillis,
      scenarioId,
    };
  });
}

function validate<A>(code: string, message: string, evaluate: () => A) {
  return Effect.try({
    catch: (cause) => runtimeFailure(code, message, cause),
    try: evaluate,
  });
}

function decodeHarnessEvaluationRecordingInput(
  input: unknown,
  code: "HarnessEvaluationScenarioInvalid" | "InvalidHarnessEvaluationRequest",
  message: string
) {
  return Effect.try({
    catch: () => runtimeFailure(code, message),
    try: () => decodeScenarioInput(input),
  });
}

function canonicalEncoded(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function manifestEvents(events: ReadonlyArray<RunEvent>) {
  return events.filter(
    (event) => event.type === "HARNESS_BASELINE_MANIFEST_RECORDED"
  );
}

function evaluationEvents(events: ReadonlyArray<RunEvent>) {
  return events.filter((event) => event.type === "HARNESS_EVALUATION_RECORDED");
}

function preparedRunEvents(events: ReadonlyArray<RunEvent>) {
  return events.filter(
    (event) => event.type === "HARNESS_PREPARED_RUN_RECORDED"
  );
}

function manifestFromEvent(event: RunEvent) {
  return parseHarnessBaselineManifestV1(
    event.payload["harnessBaselineManifest"]
  );
}

function evaluationFromEvent(event: RunEvent) {
  return parseHarnessEvaluationV1(event.payload["harnessEvaluation"]);
}

function preparedRunFromEvent(event: RunEvent) {
  return parseHarnessPreparedRunReceiptV1(
    event.payload["harnessPreparedRunReceipt"]
  );
}

function writeProjection(paths: RunPaths, path: string, body: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(paths.promotedEvidenceDirectory, {
      recursive: true,
    });
    yield* fs.writeFileString(path, body);
  }).pipe(
    Effect.mapError((cause) =>
      runtimeFailure(
        "HarnessEvaluationProjectionWriteFailed",
        "The disposable harness evaluation projection could not be written.",
        cause
      )
    )
  );
}

function assertPreDispatch(events: ReadonlyArray<RunEvent>) {
  if (events[0]?.type !== "RUN_CREATED")
    throw new Error(
      "Baseline manifest authority requires an existing RUN_CREATED event."
    );
  const forbidden = events.find(
    ({ type }) =>
      type === "WORKER_STARTED" ||
      type === "HARNESS_SESSION_EVENT_RECORDED" ||
      type === "WORKER_COMPLETED" ||
      type === "VERIFICATION_STARTED" ||
      type === "RUN_PROOF_RESULT_RECORDED" ||
      type === "RUN_FAILED"
  );
  if (forbidden !== undefined)
    throw new Error(
      `Baseline manifest must precede provider execution (${forbidden.type}).`
    );
}

export type HarnessRunPreparationBinding =
  typeof HarnessRunPreparationBindingV1.Type;

const StrictV2HarnessIdentifier = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(192),
    Schema.isPattern(/^[A-Za-z0-9@][A-Za-z0-9._@/:-]*$/u)
  )
);
const StrictV2HarnessPreparationRequestV1 = Schema.Union([
  Schema.Struct({
    evaluationId: StrictV2HarnessIdentifier,
    externalConditionDescriptor: StrictV2HarnessIdentifier,
    grader: Schema.Struct({
      id: StrictV2HarnessIdentifier,
      version: StrictV2HarnessIdentifier,
    }),
    interventionWithheld: Schema.Literals([
      "promotedControl",
      "runtimeRevision",
    ] as const),
    limitations: Schema.Array(
      Schema.Literals([
        "operatorRecordedExternalState",
        "providerNativeInventoryNotExposed",
        "singleLocalHost",
        "smallSample",
        "treatmentNotYetRecorded",
        "unobservableLessonBehavior",
      ] as const)
    ).pipe(Schema.check(Schema.isMaxLength(16))),
    manifestId: StrictV2HarnessIdentifier,
    role: Schema.Literal("baseline"),
    scenario: Schema.Struct({
      id: StrictV2HarnessIdentifier,
      version: Schema.Number.pipe(
        Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
      ),
    }),
    stopConditions: Schema.Array(
      Schema.Literals([
        "cancelled",
        "humanAuthorityRequired",
        "providerUnavailable",
        "unknownExternalOutcome",
      ] as const)
    ).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8))),
  }),
  Schema.Struct({
    intervention: HarnessEvaluationInterventionV1,
    manifestRef: HarnessBaselineManifestRefV1,
    repetition: Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 64 })
      )
    ),
    role: Schema.Literal("treatment"),
  }),
]);

/**
 * Stable selectors only. Runtime derives every digest and persisted binding
 * from the accepted run; callers never supply a derived proof value.
 */
export type StrictV2HarnessPreparationRequest =
  typeof StrictV2HarnessPreparationRequestV1.Type;

function sameEncoded(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function prefixDigest(events: ReadonlyArray<RunEvent>) {
  return createHash("sha256")
    .update(
      canonicalV1(
        "gaia.harness-evaluation-event-prefix.v1",
        events.map((event) => encodeRunEvent(event))
      )
    )
    .digest("hex");
}

function eventDigest(event: RunEvent) {
  return createHash("sha256")
    .update(
      canonicalV1("gaia.harness-evaluation-event.v1", [encodeRunEvent(event)])
    )
    .digest("hex");
}

function semanticDigest(domain: string, value: unknown) {
  return createHash("sha256")
    .update(canonicalV1(domain, [value]))
    .digest("hex");
}

export function makeHarnessEvaluationPrefixRef(
  runId: RunId,
  events: ReadonlyArray<RunEvent>,
  throughSequence = events.length
) {
  if (
    throughSequence < 1 ||
    throughSequence > events.length ||
    events[throughSequence - 1]?.sequence !== throughSequence
  )
    throw new Error("Harness evaluation prefix sequence is not authoritative.");
  return Schema.decodeUnknownSync(HarnessEvaluationPrefixRefV1)({
    prefixDigest: prefixDigest(events.slice(0, throughSequence)),
    runId,
    throughSequence,
  });
}

/**
 * Resolve the event-owned baseline commitment and bind the current prepared run
 * before WORKER_STARTED or any provider effect is allowed.
 */
export function preflightHarnessRun(
  runId: RunId,
  binding: HarnessRunPreparationBinding,
  modelInvocationEpisode: ModelInvocationEpisodeStartV1,
  options: RunStorageOptions = {},
  factoryLessonContextSelection?: FactoryLessonContextSelectionV1,
  persistModelInvocationOwner = false,
  strictV2PreparationRequest?: StrictV2HarnessPreparationRequest
) {
  return Effect.gen(function* () {
    const preparationBinding = yield* validate(
      "HarnessRunPreparationBindingInvalid",
      "The role-aware run preparation binding is invalid.",
      () =>
        Schema.decodeUnknownSync(HarnessRunPreparationBindingV1, {
          onExcessProperty: "error",
        })(binding)
    );
    const manifestRef = yield* validate(
      "HarnessBaselineManifestRefInvalid",
      "The baseline manifest ref is invalid.",
      () =>
        Schema.decodeUnknownSync(HarnessBaselineManifestRefV1)(
          preparationBinding.manifestRef
        )
    );
    if (preparationBinding.runId !== runId)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessRunPreparationRunRebound",
          "The preparation binding does not belong to the exact accepted run."
        )
      );
    const ownerPaths = yield* makeRunPaths(manifestRef.ownerRunId, options);
    const ownerEvents = yield* readEvents(ownerPaths);
    const authority = ownerEvents[manifestRef.eventSequence - 1];
    if (
      authority === undefined ||
      authority.sequence !== manifestRef.eventSequence ||
      authority.type !== "HARNESS_BASELINE_MANIFEST_RECORDED"
    )
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessBaselineManifestRefMissing",
          "The baseline manifest ref does not resolve its authoritative event."
        )
      );
    const manifest = yield* validate(
      "HarnessBaselineManifestRefInvalid",
      "The baseline manifest authority is invalid.",
      () => manifestFromEvent(authority)
    );
    if (
      manifest.manifestId !== manifestRef.manifestId ||
      manifest.manifestDigest !== manifestRef.manifestDigest ||
      manifest.ownerRunId !== manifestRef.ownerRunId
    )
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessBaselineManifestRefRebound",
          "The baseline manifest ref does not bind the recorded identity and digest."
        )
      );
    const plannedBaselineRunId =
      manifest.plannedBaselineRunIds[preparationBinding.repetition - 1];
    if (preparationBinding.repetition > manifest.plannedRepetitions)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessRunPreparationSlotInvalid",
          "The current run claims a repetition outside the committed cohort."
        )
      );
    if (
      preparationBinding.role === "baseline"
        ? plannedBaselineRunId !== runId
        : manifest.plannedBaselineRunIds.includes(runId) ||
          preparationBinding.intervention.kind !== manifest.interventionWithheld
    )
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessRunPreparationRoleRebound",
          "The current run does not match its exact committed role and repetition slot."
        )
      );
    if (
      preparationBinding.role === "treatment" &&
      preparationBinding.intervention.kind === "runtimeRevision" &&
      (preparationBinding.intervention.baselineRuntimeRevision !==
        manifest.runtimeRevision ||
        preparationBinding.intervention.baselineSemanticContractDigest !==
          manifest.providerInterfaceDigest)
    )
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessRunPreparationInterventionRebound",
          "The treatment intervention does not begin from the committed runtime and semantic contract."
        )
      );
    const currentPaths = yield* makeRunPaths(runId, options);
    const currentEvents = yield* readEvents(currentPaths);
    const modelInvocationPair = yield* loadModelInvocationPair(
      currentPaths,
      modelInvocationEpisode
    );
    const modelContextContent = yield* validate(
      "HarnessPreparedRunContextInvalid",
      "The committed model context content is invalid.",
      () =>
        parseModelContextContent({
          contextContentDigest:
            modelInvocationPair.context.payload.contextContentDigest,
          payload: modelInvocationPair.context.payload.content,
        })
    );
    const currentPreparedEvents = preparedRunEvents(currentEvents);
    if (currentPreparedEvents.length > 1)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessPreparedRunConflict",
          "The run has conflicting prepared-run authorities."
        )
      );
    const created = currentEvents[0];
    const rawExecution =
      created?.type === "RUN_CREATED"
        ? (created.payload["execution"] as
            | { readonly resolved?: unknown }
            | undefined)
        : undefined;
    const resolvedExecution = yield* validate(
      "HarnessPreparedRunExecutionMissing",
      "The accepted run has no complete resolved execution authority.",
      () =>
        Schema.decodeUnknownSync(ResolvedHarnessExecution, {
          onExcessProperty: "error",
        })(rawExecution?.resolved)
    );
    const assignment = resolvedExecution.environmentAssignment;
    if (assignment === undefined)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessPreparedRunExecutionIncomplete",
          "The accepted run has no complete model and runtime assignment."
        )
      );
    const fs = yield* FileSystem.FileSystem;
    const artifactDefinitions = [
      {
        artifactId: "model-context-manifest" as const,
        expectedByteLength: modelInvocationEpisode.contextRef.byteLength,
        expectedDigest: modelInvocationEpisode.contextRef.bodyDigest,
        path: modelInvocationEpisode.contextRef.path,
      },
      {
        artifactId: "model-invocation-manifest" as const,
        expectedByteLength: modelInvocationEpisode.invocationRef.byteLength,
        expectedDigest: modelInvocationEpisode.invocationRef.bodyDigest,
        path: modelInvocationEpisode.invocationRef.path,
      },
      {
        artifactId: "run-contract" as const,
        path: runRelative(currentPaths, currentPaths.runContract),
      },
      {
        artifactId: "run-profile" as const,
        path: runRelative(currentPaths, currentPaths.runProfile),
      },
      {
        artifactId: "skill-manifest" as const,
        path: runRelative(currentPaths, currentPaths.skillManifest),
      },
      {
        artifactId: "worker-plan" as const,
        path: runRelative(currentPaths, currentPaths.workerPlanResult),
      },
    ];
    const artifacts: Array<HarnessPreparedRunReceiptV1["artifacts"][number]> =
      [];
    for (const definition of artifactDefinitions) {
      const absolutePath = `${currentPaths.root}/${definition.path}`;
      const body = yield* fs
        .readFile(absolutePath)
        .pipe(
          Effect.mapError((cause) =>
            runtimeFailure(
              "HarnessPreparedRunArtifactMissing",
              `Prepared artifact ${definition.artifactId} is unavailable.`,
              cause
            )
          )
        );
      const contentDigest = createHash("sha256").update(body).digest("hex");
      if (
        ("expectedByteLength" in definition &&
          definition.expectedByteLength !== body.byteLength) ||
        ("expectedDigest" in definition &&
          definition.expectedDigest !== contentDigest)
      )
        return yield* Effect.fail(
          runtimeFailure(
            "HarnessPreparedRunArtifactMismatch",
            `Prepared artifact ${definition.artifactId} does not match its canonical ref.`
          )
        );
      artifacts.push({
        artifactId: definition.artifactId,
        byteLength: body.byteLength,
        contentDigest,
        path: String(definition.path),
      });
    }
    const contractEvent = currentEvents.find(
      ({ type }) => type === "RUN_CONTRACT_RECORDED"
    );
    if (contractEvent === undefined)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessPreparedRunContractMissing",
          "The accepted run has no event-owned run contract."
        )
      );
    const contract = yield* validate(
      "HarnessPreparedRunContractInvalid",
      "The event-owned run contract is invalid.",
      () => parseAnyRunContract(contractEvent.payload["contract"])
    );
    if (contract.version !== 2)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessPreparedRunContractUnsupported",
          "Harness evaluation requires an accepted V2 run contract."
        )
      );
    const artifactsById = new Map(
      artifacts.map((artifact) => [artifact.artifactId, artifact] as const)
    );
    const profileArtifact = artifactsById.get("run-profile");
    const skillManifestArtifact = artifactsById.get("skill-manifest");
    const workerPlanArtifact = artifactsById.get("worker-plan");
    if (
      profileArtifact === undefined ||
      skillManifestArtifact === undefined ||
      workerPlanArtifact === undefined
    )
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessPreparedRunArtifactMissing",
          "The prepared run is missing a required fixed-worker artifact."
        )
      );
    const workerPlanDigest = yield* fs
      .readFileString(`${currentPaths.root}/${workerPlanArtifact.path}`)
      .pipe(
        Effect.flatMap((body) =>
          Effect.try({
            try: () => digestWorkerPlanEnvironmentSemantics(body),
            catch: (cause) =>
              runtimeFailure(
                "HarnessPreparedRunArtifactMismatch",
                "The prepared worker plan is not a valid production artifact.",
                cause
              ),
          })
        )
      );
    const preparedInputs = yield* validate(
      "HarnessBaselinePreparedInputsInvalid",
      "Runtime-derived prepared inputs are invalid.",
      () =>
        Schema.decodeUnknownSync(HarnessBaselinePreparedInputsV1, {
          onExcessProperty: "error",
        })({
          authorityDigest: assignment.authority.workspaceBindingDigest,
          baseDigest: contract.baseDigest,
          capabilityEpoch: assignment.effectDependencyEpoch,
          contextDigest: modelContextContent.contextContentDigest,
          modelId: assignment.model.id,
          modelProvider: assignment.model.provider,
          modelReasoningEffort: assignment.model.reasoningEffort,
          profileDigest: profileArtifact.contentDigest,
          providerInterfaceDigest: assignment.adapter.contractDigest,
          runtimeRevision: assignment.runtimeSource.revision,
          skillManifestDigest: skillManifestArtifact.contentDigest,
          targetDigest: contract.targetDigest,
          workerId: resolvedExecution.provider.providerId,
          workerPlanDigest,
        })
    );
    const baselineInputs = projectHarnessBaselinePreparedInputsV1(manifest);
    const expectedPreparedInputs =
      preparationBinding.role === "treatment"
        ? preparationBinding.intervention.kind === "runtimeRevision"
          ? {
              ...baselineInputs,
              providerInterfaceDigest:
                preparationBinding.intervention.treatmentSemanticContractDigest,
              runtimeRevision:
                preparationBinding.intervention.treatmentRuntimeRevision,
            }
          : {
              ...baselineInputs,
              contextDigest: preparedInputs.contextDigest,
            }
        : baselineInputs;
    if (!sameEncoded(expectedPreparedInputs, preparedInputs))
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessPreparedInputsMismatch",
          `Runtime-derived inputs differ outside the exact declared intervention fields: ${Object.keys(
            preparedInputs
          )
            .filter(
              (key) =>
                expectedPreparedInputs[
                  key as keyof typeof expectedPreparedInputs
                ] !== preparedInputs[key as keyof typeof preparedInputs]
            )
            .join(", ")}.`
        )
      );
    let lessonSelectionDigest: string | undefined;
    if (
      preparationBinding.role === "treatment" &&
      preparationBinding.intervention.kind === "promotedControl"
    ) {
      const selection = factoryLessonContextSelection;
      const declared = preparationBinding.intervention;
      const selectedContentRefs =
        modelContextContent.payload.contentRefs.filter(
          (ref) => ref.kind === "factoryLesson/v1"
        );
      const selectedContentRef = selectedContentRefs[0];
      if (
        selection === undefined ||
        selection.targetRunId !== runId ||
        selection.contextContentDigest !== preparedInputs.contextDigest ||
        selection.lessons.length !== 1 ||
        selection.lessons[0]?.lessonId !== declared.lessonId ||
        selection.lessons[0]?.projectionDigest !== declared.projectionDigest ||
        selectedContentRefs.length !== 1 ||
        selectedContentRef?.kind !== "factoryLesson/v1" ||
        !("lessonId" in selectedContentRef) ||
        selectedContentRef.lessonId !== declared.lessonId ||
        selectedContentRef.projectionDigest !== declared.projectionDigest
      )
        return yield* Effect.fail(
          runtimeFailure(
            "HarnessPromotedControlSelectionMissing",
            "The promoted-control treatment lacks its exact authoritative lesson selection."
          )
        );
      lessonSelectionDigest = selection.selectionDigest;
    }
    const recordedAt =
      currentPreparedEvents[0] === undefined
        ? new Date(yield* Clock.currentTimeMillis).toISOString()
        : preparedRunFromEvent(currentPreparedEvents[0]).recordedAt;
    const receipt = yield* validate(
      "HarnessPreparedRunReceiptInvalid",
      "The runtime-derived prepared-run receipt is invalid.",
      () =>
        makeHarnessPreparedRunReceiptV1({
          artifacts,
          capabilitiesDigest: semanticDigest(
            "gaia.harness-capabilities.v1",
            Schema.encodeSync(ResolvedHarnessExecution.fields.capabilities)(
              resolvedExecution.capabilities
            )
          ),
          ...(lessonSelectionDigest === undefined
            ? {}
            : { lessonSelectionDigest }),
          manifestRef,
          preparationBinding,
          preparedInputs,
          providerId: resolvedExecution.provider.providerId,
          providerVersion: resolvedExecution.version,
          recordedAt,
          runId,
          version: 1,
        })
    );
    yield* assertFactoryRunAcceptanceSecretSafe(
      encodePreparedRunReceipt(receipt)
    );
    return yield* withRunEventSerialization(
      currentPaths,
      Effect.gen(function* () {
        const latestEvents = yield* readEvents(currentPaths);
        const existing = preparedRunEvents(latestEvents);
        const existingEvent = existing[0];
        if (existingEvent !== undefined) {
          if (existing.length !== 1)
            return yield* Effect.fail(
              runtimeFailure(
                "HarnessPreparedRunConflict",
                "The run has conflicting prepared-run authorities."
              )
            );
          const recorded = preparedRunFromEvent(existingEvent);
          if (recorded.receiptDigest !== receipt.receiptDigest)
            return yield* Effect.fail(
              runtimeFailure(
                "HarnessPreparedRunConflict",
                "The prepared-run identity is already bound to different authoritative inputs."
              )
            );
          return {
            manifest,
            manifestRef,
            receipt: recorded,
            receiptRef: makeHarnessPreparedRunReceiptRefV1({
              eventSequence: existingEvent.sequence,
              receipt: recorded,
            }),
          };
        }
        if (latestEvents.some(({ type }) => type === "WORKER_STARTED"))
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessRunAlreadyDispatched",
              "The prepared run already consumed its pre-dispatch slot."
            )
          );
        const preparedEvent = makeRunEvent({
          payload: {
            harnessPreparedRunReceipt: encodePreparedRunReceipt(receipt),
            ...(persistModelInvocationOwner
              ? {
                  modelInvocationEpisode: Schema.encodeSync(
                    ModelInvocationEpisodeStartV1
                  )(modelInvocationEpisode),
                }
              : {}),
            ...(strictV2PreparationRequest === undefined
              ? {}
              : {
                  strictV2PreparationRequest: Schema.encodeSync(
                    StrictV2HarnessPreparationRequestV1
                  )(strictV2PreparationRequest),
                }),
          },
          runId,
          sequence: latestEvents.length + 1,
          timestamp: recordedAt,
          type: "HARNESS_PREPARED_RUN_RECORDED",
        });
        const appended = yield* appendPreparedEventWithinSerialization(
          runId,
          currentPaths,
          latestEvents,
          preparedEvent
        );
        yield* writeProjection(
          currentPaths,
          currentPaths.harnessPreparedRunReceipt,
          canonicalEncoded(encodePreparedRunReceipt(receipt))
        );
        return {
          manifest,
          manifestRef,
          receipt,
          receiptRef: makeHarnessPreparedRunReceiptRefV1({
            eventSequence: appended.event.sequence,
            receipt,
          }),
        };
      })
    );
  });
}

/**
 * Materialize and bind a strict-V2 preparation from one already accepted run.
 * The only input is stable cohort selection; all durable facts are reloaded
 * from the run's own events and artifacts before the receipt is appended.
 */
export function prepareStrictV2HarnessRun(
  runId: RunId,
  request: StrictV2HarnessPreparationRequest,
  modelInvocationEpisode: ModelInvocationEpisodeStartV1,
  options: RunStorageOptions = {},
  factoryLessonContextSelection?: FactoryLessonContextSelectionV1
) {
  return Effect.gen(function* () {
    const preparedRequest = yield* validate(
      "StrictV2HarnessPreparationRequestInvalid",
      "The strict-V2 preparation selectors are invalid.",
      () =>
        Schema.decodeUnknownSync(StrictV2HarnessPreparationRequestV1, {
          onExcessProperty: "error",
        })(request)
    );
    const binding =
      preparedRequest.role === "treatment"
        ? {
            intervention: preparedRequest.intervention,
            manifestRef: preparedRequest.manifestRef,
            repetition: preparedRequest.repetition,
            role: "treatment" as const,
            runId,
          }
        : yield* Effect.gen(function* () {
            const paths = yield* makeRunPaths(runId, options);
            const events = yield* readEvents(paths);
            const created = events[0];
            const rawExecution =
              created?.type === "RUN_CREATED"
                ? (created.payload["execution"] as
                    | { readonly resolved?: unknown }
                    | undefined)
                : undefined;
            const resolved = yield* validate(
              "HarnessPreparedRunExecutionMissing",
              "The accepted run has no complete resolved execution authority.",
              () =>
                Schema.decodeUnknownSync(ResolvedHarnessExecution, {
                  onExcessProperty: "error",
                })(rawExecution?.resolved)
            );
            const assignment = resolved.environmentAssignment;
            if (assignment === undefined)
              return yield* Effect.fail(
                runtimeFailure(
                  "HarnessPreparedRunExecutionIncomplete",
                  "The accepted run has no complete model and runtime assignment."
                )
              );
            const contractEvent = events.find(
              ({ type }) => type === "RUN_CONTRACT_RECORDED"
            );
            if (contractEvent === undefined)
              return yield* Effect.fail(
                runtimeFailure(
                  "HarnessPreparedRunContractMissing",
                  "The accepted run has no event-owned run contract."
                )
              );
            const contract = yield* validate(
              "HarnessPreparedRunContractInvalid",
              "The event-owned run contract is invalid.",
              () => parseAnyRunContract(contractEvent.payload["contract"])
            );
            if (
              contract.version !== 2 ||
              contract.acceptedOutcomes.length !== 1
            )
              return yield* Effect.fail(
                runtimeFailure(
                  "HarnessPreparedRunContractUnsupported",
                  "Strict-V2 preparation requires one accepted V2 outcome."
                )
              );
            const modelPair = yield* loadModelInvocationPair(
              paths,
              modelInvocationEpisode
            );
            const fs = yield* FileSystem.FileSystem;
            const fileDigest = (path: RuntimePath) =>
              fs.readFile(path).pipe(
                Effect.map((body) =>
                  createHash("sha256").update(body).digest("hex")
                ),
                Effect.mapError((cause) =>
                  runtimeFailure(
                    "HarnessPreparedRunArtifactMissing",
                    "A fixed strict-V2 artifact is unavailable.",
                    cause
                  )
                )
              );
            const profileDigest = yield* fileDigest(paths.runProfile);
            const skillManifestDigest = yield* fileDigest(paths.skillManifest);
            const workerPlanBody = yield* fs
              .readFileString(paths.workerPlanResult)
              .pipe(
                Effect.mapError((cause) =>
                  runtimeFailure(
                    "HarnessPreparedRunArtifactMissing",
                    "The fixed strict-V2 worker plan is unavailable.",
                    cause
                  )
                )
              );
            const workerPlanDigest = yield* Effect.try({
              try: () => digestWorkerPlanEnvironmentSemantics(workerPlanBody),
              catch: (cause) =>
                runtimeFailure(
                  "HarnessPreparedRunArtifactMismatch",
                  "The fixed strict-V2 worker plan is invalid.",
                  cause
                ),
            });
            const recordedAt = new Date(
              yield* Clock.currentTimeMillis
            ).toISOString();
            const acceptedOutcome = contract.acceptedOutcomes[0]!;
            const manifest = yield* recordHarnessBaselineManifest(
              {
                acceptedOutcome: {
                  outcomeId: acceptedOutcome.outcomeId,
                  proofContractDigest: createHash("sha256")
                    .update(
                      canonicalV1("gaia.harness-proof-contract.v1", [
                        {
                          acceptedOutcomes: contract.acceptedOutcomes,
                          proofClaims: contract.proofClaims,
                          specDigest: contract.specDigest,
                          version: contract.version,
                        },
                      ])
                    )
                    .digest("hex"),
                  version: 2,
                },
                authorityDigest: assignment.authority.workspaceBindingDigest,
                baseDigest: contract.baseDigest,
                contextDigest: modelPair.context.payload.contextContentDigest,
                evaluationId: preparedRequest.evaluationId,
                externalCondition: {
                  descriptor: preparedRequest.externalConditionDescriptor,
                  digest: semanticDigest(
                    "gaia.harness-external-condition.v1",
                    preparedRequest.externalConditionDescriptor
                  ),
                },
                freshSessionPolicy: "globallyDistinct",
                grader: preparedRequest.grader,
                interventionWithheld: preparedRequest.interventionWithheld,
                limitations: preparedRequest.limitations,
                manifestId: preparedRequest.manifestId,
                model: assignment.model,
                ownerRunId: runId,
                plannedBaselineRunIds: [runId],
                plannedRepetitions: 1,
                profileDigest,
                providerInterfaceDigest: assignment.adapter.contractDigest,
                recordedAt,
                runtimeRevision: assignment.runtimeSource.revision,
                scenario: preparedRequest.scenario,
                skillManifestDigest,
                stopConditions: preparedRequest.stopConditions,
                targetDigest: contract.targetDigest,
                version: 1,
                worker: {
                  capabilityEpoch: assignment.effectDependencyEpoch,
                  id: resolved.provider.providerId,
                },
                workerPlanDigest,
              },
              options
            );
            return {
              manifestRef: manifest.ref,
              repetition: 1,
              role: "baseline" as const,
              runId,
            };
          });
    return yield* preflightHarnessRun(
      runId,
      binding,
      modelInvocationEpisode,
      options,
      factoryLessonContextSelection,
      true,
      preparedRequest
    );
  });
}

/** Reload exactly one event-owned receipt; no caller-provided binding is used. */
export function readStrictV2HarnessPreparedRun(
  runId: RunId,
  options: RunStorageOptions = {},
  expectedRequest?: StrictV2HarnessPreparationRequest
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const recorded = preparedRunEvents(yield* readEvents(paths));
    const event = recorded[0];
    if (recorded.length !== 1 || event === undefined)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessPreparedRunAuthorityMissing",
          "Exactly one event-owned strict-V2 prepared receipt is required."
        )
      );
    const receipt = yield* validate(
      "HarnessPreparedRunReceiptInvalid",
      "The event-owned strict-V2 prepared receipt is invalid.",
      () => preparedRunFromEvent(event)
    );
    const request = yield* validate(
      "HarnessPreparedRunRequestMissing",
      "The event-owned strict-V2 prepared receipt has no strict preparation request.",
      () =>
        Schema.decodeUnknownSync(StrictV2HarnessPreparationRequestV1)(
          event.payload["strictV2PreparationRequest"]
        )
    );
    if (expectedRequest !== undefined) {
      const expected = yield* validate(
        "StrictV2HarnessPreparationRequestInvalid",
        "The strict-V2 preparation selectors are invalid.",
        () =>
          Schema.decodeUnknownSync(StrictV2HarnessPreparationRequestV1)(
            expectedRequest
          )
      );
      if (!sameEncoded(request, expected))
        return yield* Effect.fail(
          runtimeFailure(
            "HarnessPreparedRunRequestConflict",
            "The strict-V2 prepared receipt is already bound to different selectors."
          )
        );
    }
    yield* validate(
      "HarnessPreparedRunModelInvocationMissing",
      "The event-owned strict-V2 prepared receipt has no model invocation authority.",
      () =>
        Schema.decodeUnknownSync(ModelInvocationEpisodeStartV1)(
          event.payload["modelInvocationEpisode"]
        )
    );
    if (receipt.runId !== runId)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessRunPreparationRunRebound",
          "The event-owned strict-V2 prepared receipt belongs to another run."
        )
      );
    return {
      receipt,
      receiptRef: makeHarnessPreparedRunReceiptRefV1({
        eventSequence: event.sequence,
        receipt,
      }),
    };
  });
}

function assertManifestRefEqual(
  actual: unknown,
  expected: HarnessBaselineManifestRefV1
) {
  const parsed = Schema.decodeUnknownSync(HarnessBaselineManifestRefV1)(actual);
  if (!sameEncoded(parsed, expected))
    throw new Error("Baseline run binds another manifest ref.");
}

function resolveEvaluationInput(
  request: typeof HarnessEvaluationRecordingInputV1Schema.Type,
  options: RunStorageOptions
) {
  return Effect.gen(function* () {
    const ownerPaths = yield* makeRunPaths(
      request.baselineManifestRef.ownerRunId,
      options
    );
    const ownerEvents = yield* readEvents(ownerPaths);
    const manifestEvent =
      ownerEvents[request.baselineManifestRef.eventSequence - 1];
    if (
      manifestEvent === undefined ||
      manifestEvent.type !== "HARNESS_BASELINE_MANIFEST_RECORDED"
    )
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessEvaluationManifestAuthorityMissing",
          "The evaluation baseline manifest ref does not resolve an event."
        )
      );
    const manifest = manifestFromEvent(manifestEvent);
    yield* validate(
      "HarnessEvaluationManifestAuthorityMismatch",
      "The evaluation baseline manifest ref was rebound.",
      () =>
        assertManifestRefEqual(
          request.baselineManifestRef,
          makeHarnessBaselineManifestRefV1({
            eventSequence: manifestEvent.sequence,
            manifest,
          })
        )
    );
    const resolveSide = (
      side: (typeof request.repetitions)[number]["treatment"],
      role: "baseline" | "treatment",
      repetition: number
    ) =>
      Effect.gen(function* () {
        const paths = yield* makeRunPaths(side.runId, options);
        const events = yield* readEvents(paths);
        const prefix = events.slice(0, side.prefix.throughSequence);
        if (
          side.prefix.runId !== side.runId ||
          prefix.length !== side.prefix.throughSequence ||
          prefixDigest(prefix) !== side.prefix.prefixDigest
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationPrefixMismatch",
              `The authoritative prefix for ${side.runId} does not match.`
            )
          );
        const preparedEvents = preparedRunEvents(prefix);
        const preparedEvent = preparedEvents[0];
        if (preparedEvents.length !== 1 || preparedEvent === undefined)
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationPreparationMissing",
              `Run ${side.runId} must have one unambiguous prepared-run receipt.`
            )
          );
        const receipt = preparedRunFromEvent(preparedEvent);
        if (
          receipt.runId !== side.runId ||
          !sameEncoded(receipt.manifestRef, request.baselineManifestRef) ||
          receipt.preparationBinding.role !== role ||
          receipt.preparationBinding.repetition !== repetition ||
          !sameEncoded(
            receipt.preparationBinding.manifestRef,
            request.baselineManifestRef
          ) ||
          (role === "baseline"
            ? manifest.plannedBaselineRunIds[repetition - 1] !== side.runId
            : receipt.preparationBinding.role !== "treatment" ||
              !sameEncoded(
                receipt.preparationBinding.intervention,
                request.intervention
              ))
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationPreparationRebound",
              `Run ${side.runId} has a stale or rebound preparation receipt.`
            )
          );
        const workerStarted = prefix.filter(
          ({ type }) => type === "WORKER_STARTED"
        );
        const workerStartedEvent = workerStarted[0];
        if (workerStarted.length !== 1 || workerStartedEvent === undefined)
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationExecutionBindingAmbiguous",
              `Run ${side.runId} must have one worker dispatch.`
            )
          );
        const expectedPreparedRef = makeHarnessPreparedRunReceiptRefV1({
          eventSequence: preparedEvent.sequence,
          receipt,
        });
        const actualPreparedRef = yield* validate(
          "HarnessEvaluationPreparationBindingInvalid",
          `Run ${side.runId} has an invalid prepared-run binding.`,
          () =>
            Schema.decodeUnknownSync(HarnessPreparedRunReceiptRefV1)(
              workerStartedEvent.payload["harnessPreparedRunReceiptRef"]
            )
        );
        if (
          !sameEncoded(actualPreparedRef, expectedPreparedRef) ||
          preparedEvent.sequence >= workerStartedEvent.sequence
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationPreparationBindingMismatch",
              `Run ${side.runId} did not bind its preparation before dispatch.`
            )
          );
        yield* validate(
          "HarnessEvaluationManifestBindingMismatch",
          `Run ${side.runId} did not bind the evaluation manifest at dispatch.`,
          () =>
            assertManifestRefEqual(
              workerStartedEvent.payload["harnessBaselineManifestRef"],
              request.baselineManifestRef
            )
        );
        if (
          role === "treatment" &&
          request.intervention.kind === "promotedControl"
        ) {
          const intervention = request.intervention;
          const attribution = yield* validate(
            "HarnessEvaluationLessonAuthorityInvalid",
            `Run ${side.runId} has invalid factory-lesson attribution.`,
            () => resolveFactoryLessonContextAttribution(prefix)
          );
          const selected = attribution.attributions.find(
            ({ lesson }) =>
              lesson.lessonId === intervention.lessonId &&
              lesson.projectionDigest === intervention.projectionDigest
          );
          if (
            selected === undefined ||
            attribution.selection?.selectionDigest !==
              receipt.lessonSelectionDigest
          )
            return yield* Effect.fail(
              runtimeFailure(
                "HarnessEvaluationLessonAuthorityMismatch",
                `Run ${side.runId} does not bind the exact promoted control.`
              )
            );
        }
        const starts = prefix
          .filter(({ type }) => type === "HARNESS_SESSION_EVENT_RECORDED")
          .map((event) => ({
            event,
            harnessEvent: parseHarnessEvent(event.payload["event"]),
          }))
          .filter(({ harnessEvent }) => harnessEvent.kind === "sessionStarted");
        const start = starts[0];
        if (starts.length !== 1 || start === undefined)
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationExecutionSessionAmbiguous",
              `Run ${side.runId} must have one exact execution session start.`
            )
          );
        if (start.harnessEvent.kind !== "sessionStarted")
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationExecutionSessionAmbiguous",
              `Run ${side.runId} has no exact execution session start.`
            )
          );
        if (
          start.harnessEvent.sessionId !== side.sessionId ||
          start.event.sequence <= workerStartedEvent.sequence ||
          start.harnessEvent.provider.providerId !== receipt.providerId ||
          semanticDigest(
            "gaia.harness-capabilities.v1",
            Schema.encodeSync(ResolvedHarnessExecution.fields.capabilities)(
              start.harnessEvent.capabilities
            )
          ) !== receipt.capabilitiesDigest
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationExecutionSessionMismatch",
              `Run ${side.runId} claimed an unrelated execution session.`
            )
          );
        yield* validate(
          "HarnessEvaluationExecutionSessionInvalid",
          `Run ${side.runId} has an invalid session history.`,
          () => replayHarnessSession(prefix, start.harnessEvent.sessionId)
        );
        const contractEvents = prefix.filter(
          ({ type }) => type === "RUN_CONTRACT_RECORDED"
        );
        const proofEvents = prefix.filter(
          ({ type }) => type === "RUN_PROOF_RESULT_RECORDED"
        );
        const contractEvent = contractEvents[0];
        const proofEvent = proofEvents[0];
        if (
          contractEvents.length !== 1 ||
          proofEvents.length !== 1 ||
          contractEvent === undefined ||
          proofEvent === undefined
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationProofAuthorityMissing",
              `Run ${side.runId} requires one V2 contract and one proof result.`
            )
          );
        const contract = yield* validate(
          "HarnessEvaluationContractInvalid",
          `Run ${side.runId} has an invalid run contract.`,
          () => parseAnyRunContract(contractEvent.payload["contract"])
        );
        const proof = yield* validate(
          "HarnessEvaluationProofInvalid",
          `Run ${side.runId} has an invalid proof result.`,
          () => parseAnyRunProofResultEnvelope(proofEvent.payload["result"])
        );
        if (
          contract.version !== 2 ||
          proof.version !== 2 ||
          proof.contractDigest !== contract.contractDigest ||
          proof.runId !== side.runId
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationProofAuthorityMismatch",
              `Run ${side.runId} does not bind one V2 proof to its contract.`
            )
          );
        const acceptedOutcome = contract.acceptedOutcomes.find(
          ({ outcomeId }) => outcomeId === manifest.acceptedOutcome.outcomeId
        );
        if (acceptedOutcome === undefined)
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationAcceptedOutcomeMissing",
              `Run ${side.runId} does not contain the committed accepted outcome.`
            )
          );
        const prepared = receipt.preparedInputs;
        return {
          conditions: {
            acceptedOutcomeDigest: semanticDigest(
              "gaia.harness-accepted-outcome.v1",
              acceptedOutcome
            ),
            authorityDigest: prepared.authorityDigest,
            baseDigest: prepared.baseDigest,
            capabilityEpoch: prepared.capabilityEpoch,
            externalConditionDigest: manifest.externalCondition.digest,
            graderDigest: semanticDigest(
              "gaia.harness-grader.v1",
              manifest.grader
            ),
            modelDigest: semanticDigest("gaia.harness-model.v1", {
              id: prepared.modelId,
              provider: prepared.modelProvider,
              reasoningEffort: prepared.modelReasoningEffort,
            }),
            profileDigest: prepared.profileDigest,
            providerInterfaceDigest: prepared.providerInterfaceDigest,
            skillManifestDigest: prepared.skillManifestDigest,
            targetDigest: prepared.targetDigest,
            workerDigest: semanticDigest("gaia.harness-worker.v1", {
              capabilityEpoch: prepared.capabilityEpoch,
              id: prepared.workerId,
            }),
            workerPlanDigest: prepared.workerPlanDigest,
          },
          evidence: {
            acceptedOutcome: {
              outcomeId: acceptedOutcome.outcomeId,
              resultDigest: proof.resultDigest,
              statementDigest: semanticDigest(
                "gaia.harness-accepted-outcome-statement.v1",
                acceptedOutcome.statement
              ),
            },
            contentAuthoritySequence: proof.contentAuthoritySequence,
            contractDigest: contract.contractDigest,
            contractVersion: 2 as const,
            environmentReceiptDigest: receipt.receiptDigest,
            externalConditionReceiptDigest: manifest.externalCondition.digest,
            modelManifestDigest: prepared.contextDigest,
            proofContractDigest: semanticDigest(
              "gaia.harness-proof-contract.v1",
              {
                acceptedOutcomes: contract.acceptedOutcomes,
                proofClaims: contract.proofClaims,
                specDigest: contract.specDigest,
                version: contract.version,
              }
            ),
            proofResultDigest: proof.resultDigest,
            providerReceiptDigest: receipt.receiptDigest,
            runProfileDigest: prepared.profileDigest,
            runtimeRevision: prepared.runtimeRevision,
            workerReceiptDigest: receipt.receiptDigest,
          },
          prefix: side.prefix,
          prefixEvents: prefix,
          paths,
          receipt,
          receiptEventSequence: preparedEvent.sequence,
          runId: side.runId,
          sessionId: side.sessionId,
        };
      });
    const repetitions = [];
    for (const [index, repetition] of request.repetitions.entries()) {
      const repetitionNumber = index + 1;
      const baseline = yield* resolveSide(
        repetition.baseline,
        "baseline",
        repetitionNumber
      );
      const treatment = yield* resolveSide(
        repetition.treatment,
        "treatment",
        repetitionNumber
      );
      repetitions.push({
        baseline: {
          ...baseline,
          baselineManifestRef: repetition.baseline.baselineManifestRef,
        },
        treatment,
      });
    }
    const interventionEvidence =
      request.intervention.kind === "promotedControl"
        ? (() => {
            const intervention = request.intervention;
            const attributions = repetitions.map(({ treatment }) => {
              const attribution = resolveFactoryLessonContextAttribution(
                treatment.prefixEvents
              );
              return attribution.attributions.find(
                ({ lesson }) =>
                  lesson.lessonId === intervention.lessonId &&
                  lesson.projectionDigest === intervention.projectionDigest
              );
            });
            const observations = attributions.flatMap(
              (attribution) => attribution?.observations ?? []
            );
            const observedKinds = new Set(observations.map(({ kind }) => kind));
            const observation = (
              [
                "relevant",
                "invoked",
                "retrieved",
                "unobservable",
                "offered",
              ] as const
            ).find((kind) => observedKinds.has(kind));
            return {
              available: attributions.every(
                (attribution) => attribution !== undefined
              ),
              observation: observation ?? ("unobservable" as const),
            };
          })()
        : undefined;
    const metrics: Array<
      (typeof HarnessEvaluationInputV1Schema.Type)["metrics"][number]
    > = [];
    for (const metric of request.metrics) {
      if ("value" in metric) {
        metrics.push(metric);
        continue;
      }
      const repetition = repetitions[metric.repetition - 1];
      if (repetition === undefined)
        return yield* Effect.fail(
          runtimeFailure(
            "HarnessEvaluationMetricProvenanceMismatch",
            "An inferred metric does not bind a declared repetition."
          )
        );
      const authorityByRun = new Map([
        [repetition.baseline.runId, repetition.baseline],
        [repetition.treatment.runId, repetition.treatment],
      ]);
      for (const source of metric.provenance.sources) {
        const authority = authorityByRun.get(source.runId);
        if (authority === undefined)
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationMetricProvenanceMismatch",
              "An inferred metric source was rebound outside its declared repetition."
            )
          );
        if (source.kind === "event") {
          const event = authority.prefixEvents[source.sequence - 1];
          if (
            event === undefined ||
            event.type !== source.eventType ||
            eventDigest(event) !== source.eventDigest
          )
            return yield* Effect.fail(
              runtimeFailure(
                "HarnessEvaluationMetricProvenanceMismatch",
                "An inferred event source does not resolve inside its authoritative prefix."
              )
            );
          continue;
        }
        const preparedArtifact = authority.receipt.artifacts.find(
          ({ artifactId }) => artifactId === source.artifactId
        );
        let expected: typeof source | undefined;
        if (preparedArtifact !== undefined)
          expected = {
            ...preparedArtifact,
            kind: "artifact",
            owningEventSequence: authority.receiptEventSequence,
            runId: source.runId,
          };
        else if (source.artifactId === "verification-result") {
          const proofEvents = authority.prefixEvents.filter(
            ({ type }) => type === "RUN_PROOF_RESULT_RECORDED"
          );
          const proofEvent = proofEvents[0];
          if (proofEvents.length === 1 && proofEvent !== undefined) {
            const proof = yield* validate(
              "HarnessEvaluationMetricProvenanceMismatch",
              "The inferred verification result owner is invalid.",
              () => parseAnyRunProofResultEnvelope(proofEvent.payload["result"])
            );
            const body = canonicalRunProofResultBody(proof);
            expected = {
              artifactId: "verification-result",
              byteLength: new TextEncoder().encode(body).byteLength,
              contentDigest: createHash("sha256").update(body).digest("hex"),
              kind: "artifact",
              owningEventSequence: proofEvent.sequence,
              path: String(
                runRelative(authority.paths, authority.paths.verificationResult)
              ),
              runId: source.runId,
            };
          }
        }
        if (
          expected === undefined ||
          source.byteLength !== expected.byteLength ||
          source.contentDigest !== expected.contentDigest ||
          source.owningEventSequence !== expected.owningEventSequence ||
          source.path !== expected.path
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationMetricProvenanceMismatch",
              "An inferred artifact source does not bind its exact event-owned artifact definition."
            )
          );
        const fs = yield* FileSystem.FileSystem;
        const bytes = yield* fs
          .readFile(`${authority.paths.root}/${expected.path}`)
          .pipe(
            Effect.mapError(() =>
              runtimeFailure(
                "HarnessEvaluationMetricArtifactMissing",
                "An inferred artifact source's authoritative bytes are unavailable."
              )
            )
          );
        if (
          bytes.byteLength !== expected.byteLength ||
          createHash("sha256").update(bytes).digest("hex") !==
            expected.contentDigest
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationMetricProvenanceMismatch",
              "An inferred artifact source's canonical bytes do not match its event-owned ref."
            )
          );
      }
      const artifactIds: Array<string> = [];
      const eventTypes: Array<string> = [];
      for (const source of metric.provenance.sources)
        if (source.kind === "artifact") artifactIds.push(source.artifactId);
        else eventTypes.push(source.eventType);
      metrics.push({
        ...metric,
        value: {
          artifactIds: artifactIds.sort(),
          eventTypes: eventTypes.sort(),
          sourceCount: metric.provenance.sources.length,
        },
      });
    }
    return {
      anchorRunId: request.anchorRunId,
      baselineManifest: manifest,
      baselineManifestRef: request.baselineManifestRef,
      evaluationId: request.evaluationId,
      grader: request.grader,
      intervention: request.intervention,
      ...(interventionEvidence === undefined ? {} : { interventionEvidence }),
      limitations: request.limitations,
      metrics,
      repetitions: repetitions.map(({ baseline, treatment }) => ({
        baseline: {
          baselineManifestRef: baseline.baselineManifestRef,
          conditions: baseline.conditions,
          evidence: baseline.evidence,
          prefix: baseline.prefix,
          runId: baseline.runId,
          sessionId: baseline.sessionId,
        },
        treatment: {
          conditions: treatment.conditions,
          evidence: treatment.evidence,
          prefix: treatment.prefix,
          runId: treatment.runId,
          sessionId: treatment.sessionId,
        },
      })),
      scenario: request.scenario,
    };
  });
}

function validateEvaluationAuthority(
  evaluation: HarnessEvaluationV1,
  options: RunStorageOptions
) {
  return Effect.gen(function* () {
    const ownerPaths = yield* makeRunPaths(
      evaluation.baselineManifestRef.ownerRunId,
      options
    );
    const ownerEvents = yield* readEvents(ownerPaths);
    const manifestEvent =
      ownerEvents[evaluation.baselineManifestRef.eventSequence - 1];
    if (
      manifestEvent === undefined ||
      manifestEvent.type !== "HARNESS_BASELINE_MANIFEST_RECORDED"
    )
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessEvaluationManifestAuthorityMissing",
          "The evaluation baseline manifest ref does not resolve an event."
        )
      );
    yield* validate(
      "HarnessEvaluationManifestAuthorityMismatch",
      "The evaluation baseline manifest ref was rebound.",
      () => {
        const manifest = manifestFromEvent(manifestEvent);
        const expected = makeHarnessBaselineManifestRefV1({
          eventSequence: manifestEvent.sequence,
          manifest,
        });
        assertManifestRefEqual(evaluation.baselineManifestRef, expected);
      }
    );
    const manifest = manifestFromEvent(manifestEvent);

    const declaredSides = evaluation.repetitions.flatMap(
      ({ baseline, treatment }) => [baseline, treatment]
    );
    const sessionOwners = new Map<string, Set<string>>();
    const authoritativePrefixes = new Map<string, ReadonlyArray<RunEvent>>();
    const authorityByRun = new Map<
      string,
      {
        readonly paths: RunPaths;
        readonly prefix: ReadonlyArray<RunEvent>;
        readonly preparedEvent: RunEvent;
        readonly receipt: HarnessPreparedRunReceiptV1;
      }
    >();
    for (const side of declaredSides) {
      const paths = yield* makeRunPaths(side.runId, options);
      const events = yield* readEvents(paths);
      const prefix = events.slice(0, side.prefix.throughSequence);
      if (
        side.prefix.runId !== side.runId ||
        prefix.length !== side.prefix.throughSequence ||
        prefixDigest(prefix) !== side.prefix.prefixDigest
      )
        return yield* Effect.fail(
          runtimeFailure(
            "HarnessEvaluationPrefixMismatch",
            `The authoritative prefix for ${side.runId} does not match.`
          )
        );
      authoritativePrefixes.set(side.runId, prefix);
      const prepared = preparedRunEvents(prefix);
      const preparedEvent = prepared[0];
      if (prepared.length !== 1 || preparedEvent === undefined)
        return yield* Effect.fail(
          runtimeFailure(
            "HarnessEvaluationPreparationMissing",
            `Run ${side.runId} has no unambiguous prepared-run authority.`
          )
        );
      authorityByRun.set(side.runId, {
        paths,
        prefix,
        preparedEvent,
        receipt: preparedRunFromEvent(preparedEvent),
      });
      const authoritativeSessions = new Set<string>(
        prefix
          .filter(({ type }) => type === "HARNESS_SESSION_EVENT_RECORDED")
          .map((event) =>
            String(parseHarnessEvent(event.payload["event"]).sessionId)
          )
      );
      if (!authoritativeSessions.has(side.sessionId))
        return yield* Effect.fail(
          runtimeFailure(
            "HarnessEvaluationSessionMissing",
            `The claimed session for ${side.runId} is not authoritative inside its prefix.`
          )
        );
      for (const sessionId of authoritativeSessions) {
        const owners = sessionOwners.get(sessionId) ?? new Set<string>();
        owners.add(side.runId);
        sessionOwners.set(sessionId, owners);
      }
    }
    const reused = [...sessionOwners].find(([, owners]) => owners.size > 1);
    if (reused !== undefined)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessEvaluationSessionReused",
          `Harness session ${reused[0]} is reused across runs.`
        )
      );
    const promotedObservationKinds = new Set<string>();
    let promotedAttributionCount = 0;
    const validateExactMetricSource = (
      provenance: Extract<
        (typeof evaluation.metrics)[number]["provenance"],
        { readonly kind: "artifact" | "event" }
      >
    ) =>
      Effect.gen(function* () {
        if (provenance.kind === "event") {
          const prefix = authoritativePrefixes.get(provenance.runId);
          const event = prefix?.[provenance.sequence - 1];
          if (
            event === undefined ||
            event.type !== provenance.eventType ||
            eventDigest(event) !== provenance.eventDigest
          )
            return yield* Effect.fail(
              runtimeFailure(
                "HarnessEvaluationMetricProvenanceMismatch",
                "An event metric does not resolve inside its authoritative prefix."
              )
            );
          return;
        }
        const authority = authorityByRun.get(provenance.runId);
        if (authority === undefined)
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationMetricProvenanceMismatch",
              "An artifact metric does not belong to a declared run."
            )
          );
        const preparedArtifact = authority.receipt.artifacts.find(
          ({ artifactId }) => artifactId === provenance.artifactId
        );
        let expected: typeof provenance | undefined;
        if (preparedArtifact !== undefined)
          expected = {
            ...preparedArtifact,
            kind: "artifact",
            owningEventSequence: authority.preparedEvent.sequence,
            runId: provenance.runId,
          };
        else if (provenance.artifactId === "verification-result") {
          const proofEvents = authority.prefix.filter(
            ({ type }) => type === "RUN_PROOF_RESULT_RECORDED"
          );
          const proofEvent = proofEvents[0];
          if (proofEvents.length === 1 && proofEvent !== undefined) {
            const proof = yield* validate(
              "HarnessEvaluationMetricProvenanceMismatch",
              "The verification result owner is invalid.",
              () => parseAnyRunProofResultEnvelope(proofEvent.payload["result"])
            );
            const body = canonicalRunProofResultBody(proof);
            expected = {
              artifactId: "verification-result",
              byteLength: new TextEncoder().encode(body).byteLength,
              contentDigest: createHash("sha256").update(body).digest("hex"),
              kind: "artifact",
              owningEventSequence: proofEvent.sequence,
              path: String(
                runRelative(authority.paths, authority.paths.verificationResult)
              ),
              runId: provenance.runId,
            };
          }
        }
        if (
          expected === undefined ||
          provenance.byteLength !== expected.byteLength ||
          provenance.contentDigest !== expected.contentDigest ||
          provenance.owningEventSequence !== expected.owningEventSequence ||
          provenance.path !== expected.path
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationMetricProvenanceMismatch",
              "An artifact metric does not bind its exact event-owned artifact definition."
            )
          );
        const fs = yield* FileSystem.FileSystem;
        const bytes = yield* fs
          .readFile(`${authority.paths.root}/${expected.path}`)
          .pipe(
            Effect.mapError((cause) =>
              runtimeFailure(
                "HarnessEvaluationMetricArtifactMissing",
                "An artifact metric's authoritative bytes are unavailable.",
                cause
              )
            )
          );
        if (
          bytes.byteLength !== expected.byteLength ||
          createHash("sha256").update(bytes).digest("hex") !==
            expected.contentDigest
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationMetricProvenanceMismatch",
              "An artifact metric's canonical bytes do not match its event-owned ref."
            )
          );
      });
    for (const metric of evaluation.metrics) {
      if (
        metric.provenance.kind === "event" ||
        metric.provenance.kind === "artifact"
      )
        yield* validateExactMetricSource(metric.provenance);
      if (
        metric.provenance.kind === "operatorSupplied" &&
        (metric.provenance.graderId !== evaluation.grader.id ||
          metric.provenance.graderVersion !== evaluation.grader.version)
      )
        return yield* Effect.fail(
          runtimeFailure(
            "HarnessEvaluationMetricProvenanceMismatch",
            "Operator-supplied evidence does not bind the configured grader."
          )
        );
      if (metric.provenance.kind === "inferred") {
        const repetition = evaluation.repetitions[metric.repetition - 1];
        if (repetition === undefined)
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationMetricProvenanceMismatch",
              "An inferred metric does not bind a declared repetition."
            )
          );
        const allowedRuns = new Set([
          repetition.baseline.runId,
          repetition.treatment.runId,
        ]);
        for (const source of metric.provenance.sources) {
          if (!allowedRuns.has(source.runId))
            return yield* Effect.fail(
              runtimeFailure(
                "HarnessEvaluationMetricProvenanceMismatch",
                "An inferred metric source was rebound outside its declared repetition."
              )
            );
          yield* validateExactMetricSource(source);
        }
      }
    }
    for (const [
      index,
      { baseline, treatment },
    ] of evaluation.repetitions.entries()) {
      for (const [role, side] of [
        ["baseline", baseline],
        ["treatment", treatment],
      ] as const) {
        const authority = authorityByRun.get(side.runId);
        if (authority === undefined)
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationPreparationMissing",
              `Run ${side.runId} has no preparation authority.`
            )
          );
        if (
          authority.receipt.preparationBinding.role !== role ||
          authority.receipt.preparationBinding.repetition !== index + 1 ||
          (role === "baseline"
            ? evaluation.repetitions[index]?.baseline.runId !== side.runId
            : authority.receipt.preparationBinding.role !== "treatment" ||
              !sameEncoded(
                authority.receipt.preparationBinding.intervention,
                evaluation.intervention
              ))
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationPreparationRebound",
              `Run ${side.runId} rebound its role, slot, or intervention.`
            )
          );
        const baselineInputs = projectHarnessBaselinePreparedInputsV1(manifest);
        const expectedPreparedInputs =
          role === "treatment"
            ? evaluation.intervention.kind === "runtimeRevision"
              ? {
                  ...baselineInputs,
                  providerInterfaceDigest:
                    evaluation.intervention.treatmentSemanticContractDigest,
                  runtimeRevision:
                    evaluation.intervention.treatmentRuntimeRevision,
                }
              : {
                  ...baselineInputs,
                  contextDigest: authority.receipt.preparedInputs.contextDigest,
                }
            : baselineInputs;
        if (
          !sameEncoded(expectedPreparedInputs, authority.receipt.preparedInputs)
        )
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationPreparationRebound",
              `Run ${side.runId} changed an undeclared prepared input.`
            )
          );
        if (
          role === "treatment" &&
          evaluation.intervention.kind === "promotedControl"
        ) {
          const intervention = evaluation.intervention;
          const attribution = yield* validate(
            "HarnessEvaluationLessonAuthorityInvalid",
            `Run ${side.runId} has invalid factory-lesson attribution.`,
            () => resolveFactoryLessonContextAttribution(authority.prefix)
          );
          const selected = attribution.attributions.find(
            ({ lesson }) =>
              lesson.lessonId === intervention.lessonId &&
              lesson.projectionDigest === intervention.projectionDigest
          );
          if (
            selected === undefined ||
            attribution.selection?.selectionDigest !==
              authority.receipt.lessonSelectionDigest
          )
            return yield* Effect.fail(
              runtimeFailure(
                "HarnessEvaluationLessonAuthorityMismatch",
                `Run ${side.runId} does not bind the exact promoted control.`
              )
            );
          promotedAttributionCount += 1;
          for (const { kind } of selected.observations)
            promotedObservationKinds.add(kind);
        }
        const workerStarted = authority.prefix.find(
          ({ type }) => type === "WORKER_STARTED"
        );
        if (workerStarted === undefined)
          return yield* Effect.fail(
            runtimeFailure(
              "HarnessEvaluationCommitmentMissing",
              `Run ${side.runId} has no pre-dispatch manifest binding.`
            )
          );
        yield* validate(
          "HarnessEvaluationCommitmentMismatch",
          `Run ${side.runId} binds another manifest.`,
          () =>
            assertManifestRefEqual(
              workerStarted.payload["harnessBaselineManifestRef"],
              evaluation.baselineManifestRef
            )
        );
      }
    }
    if (evaluation.intervention.kind === "promotedControl") {
      const expectedObservation = (
        ["relevant", "invoked", "retrieved", "unobservable", "offered"] as const
      ).find((kind) => promotedObservationKinds.has(kind));
      const expectedEvidence = {
        available: promotedAttributionCount === evaluation.repetitions.length,
        observation: expectedObservation ?? ("unobservable" as const),
      };
      if (!sameEncoded(evaluation.interventionEvidence, expectedEvidence))
        return yield* Effect.fail(
          runtimeFailure(
            "HarnessEvaluationLessonEvidenceMismatch",
            "Promoted-control evidence was not derived from authoritative factory-lesson history."
          )
        );
    }
    if (
      !evaluation.repetitions.some(
        ({ treatment }) => treatment.runId === evaluation.anchorRunId
      )
    )
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessEvaluationAnchorMismatch",
          "The evaluation anchor must be one declared treatment run."
        )
      );
  });
}

export function canonicalHarnessBaselineManifestBody(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const events = yield* readEvents(paths);
    const recorded = manifestEvents(events);
    const recordedEvent = recorded[0];
    if (recorded.length !== 1 || recordedEvent === undefined)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessBaselineManifestAuthorityMissing",
          "Exactly one authoritative harness baseline manifest event is required."
        )
      );
    return canonicalEncoded(encodeManifest(manifestFromEvent(recordedEvent)));
  });
}

export function readHarnessBaselineManifest(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const events = yield* readEvents(paths);
    const recorded = manifestEvents(events);
    const recordedEvent = recorded[0];
    if (recorded.length !== 1 || recordedEvent === undefined)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessBaselineManifestAuthorityMissing",
          "Exactly one authoritative harness baseline manifest event is required."
        )
      );
    const manifest = yield* validate(
      "HarnessBaselineManifestAuthorityInvalid",
      "The authoritative harness baseline manifest is invalid.",
      () => manifestFromEvent(recordedEvent)
    );
    yield* writeProjection(
      paths,
      paths.harnessBaselineManifest,
      canonicalEncoded(encodeManifest(manifest))
    );
    return manifest;
  });
}

export function recordHarnessBaselineManifest(
  input: Parameters<typeof makeHarnessBaselineManifestV1>[0],
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const manifest = yield* validate(
      "InvalidHarnessBaselineManifest",
      "Harness baseline manifest input is invalid.",
      () => makeHarnessBaselineManifestV1(input)
    );
    yield* assertFactoryRunAcceptanceSecretSafe(encodeManifest(manifest));
    const paths = yield* makeRunPaths(manifest.ownerRunId, options);
    const store = yield* makeRunStorePaths(options);
    return yield* projectionSemaphore.withPermits(
      store.gaiaRoot,
      1
    )(
      withRunEventSerialization(
        paths,
        Effect.gen(function* () {
          const events = yield* readEvents(paths);
          const existing = manifestEvents(events);
          const sameId = existing.find(
            (event) =>
              manifestFromEvent(event).manifestId === manifest.manifestId
          );
          if (sameId !== undefined) {
            const recorded = manifestFromEvent(sameId);
            if (recorded.manifestDigest !== manifest.manifestDigest)
              return yield* Effect.fail(
                runtimeFailure(
                  "HarnessBaselineManifestConflict",
                  "The baseline manifest identity is already bound to another digest."
                )
              );
            yield* writeProjection(
              paths,
              paths.harnessBaselineManifest,
              canonicalEncoded(encodeManifest(recorded))
            );
            return {
              event: sameId,
              manifest: recorded,
              ref: makeHarnessBaselineManifestRefV1({
                eventSequence: sameId.sequence,
                manifest: recorded,
              }),
            };
          }
          if (existing.length > 0)
            return yield* Effect.fail(
              runtimeFailure(
                "HarnessBaselineManifestConflict",
                "The cohort owner already has a different baseline manifest."
              )
            );
          yield* validate(
            "HarnessBaselineManifestRecordedAfterDispatch",
            "Harness baseline manifest must be committed before provider execution.",
            () => assertPreDispatch(events)
          );
          const prepared = makeRunEvent({
            payload: {
              harnessBaselineManifest: encodeManifest(manifest),
            },
            runId: manifest.ownerRunId,
            sequence: events.length + 1,
            timestamp: manifest.recordedAt,
            type: "HARNESS_BASELINE_MANIFEST_RECORDED",
          });
          const appended = yield* appendPreparedEventWithinSerialization(
            manifest.ownerRunId,
            paths,
            events,
            prepared
          );
          yield* writeProjection(
            paths,
            paths.harnessBaselineManifest,
            canonicalEncoded(encodeManifest(manifest))
          );
          return {
            event: appended.event,
            manifest,
            ref: makeHarnessBaselineManifestRefV1({
              eventSequence: appended.event.sequence,
              manifest,
            }),
          };
        })
      )
    );
  }).pipe(Effect.uninterruptible);
}

export function canonicalHarnessEvaluationBody(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const recorded = evaluationEvents(yield* readEvents(paths));
    const recordedEvent = recorded[0];
    if (recorded.length !== 1 || recordedEvent === undefined)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessEvaluationAuthorityMissing",
          "Exactly one authoritative harness evaluation event is required."
        )
      );
    return canonicalEncoded(
      encodeEvaluation(evaluationFromEvent(recordedEvent))
    );
  });
}

export function canonicalHarnessPreparedRunBody(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const recorded = preparedRunEvents(yield* readEvents(paths));
    const recordedEvent = recorded[0];
    if (recorded.length !== 1 || recordedEvent === undefined)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessPreparedRunAuthorityMissing",
          "Exactly one authoritative prepared-run receipt event is required."
        )
      );
    return canonicalEncoded(
      encodePreparedRunReceipt(preparedRunFromEvent(recordedEvent))
    );
  });
}

export function readHarnessEvaluation(
  runId: RunId,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const paths = yield* makeRunPaths(runId, options);
    const recorded = evaluationEvents(yield* readEvents(paths));
    const recordedEvent = recorded[0];
    if (recorded.length !== 1 || recordedEvent === undefined)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessEvaluationAuthorityMissing",
          "Exactly one authoritative harness evaluation event is required."
        )
      );
    const evaluation = yield* validate(
      "HarnessEvaluationAuthorityInvalid",
      "The authoritative harness evaluation is invalid.",
      () => evaluationFromEvent(recordedEvent)
    );
    yield* writeProjection(
      paths,
      paths.harnessEvaluation,
      canonicalEncoded(encodeEvaluation(evaluation))
    );
    return evaluation;
  });
}

export function synchronizeHarnessEvaluationProjections(
  paths: RunPaths,
  events: ReadonlyArray<RunEvent>
) {
  return Effect.gen(function* () {
    const manifests = manifestEvents(events);
    if (manifests.length > 1)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessBaselineManifestAuthorityConflict",
          "More than one harness baseline manifest event is authoritative."
        )
      );
    if (manifests[0] !== undefined)
      yield* writeProjection(
        paths,
        paths.harnessBaselineManifest,
        canonicalEncoded(encodeManifest(manifestFromEvent(manifests[0])))
      );
    const preparedRuns = preparedRunEvents(events);
    if (preparedRuns.length > 1)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessPreparedRunAuthorityConflict",
          "More than one prepared-run receipt event is authoritative."
        )
      );
    if (preparedRuns[0] !== undefined)
      yield* writeProjection(
        paths,
        paths.harnessPreparedRunReceipt,
        canonicalEncoded(
          encodePreparedRunReceipt(preparedRunFromEvent(preparedRuns[0]))
        )
      );
    const evaluations = evaluationEvents(events);
    if (evaluations.length > 1)
      return yield* Effect.fail(
        runtimeFailure(
          "HarnessEvaluationAuthorityConflict",
          "More than one harness evaluation event is authoritative."
        )
      );
    if (evaluations[0] !== undefined)
      yield* writeProjection(
        paths,
        paths.harnessEvaluation,
        canonicalEncoded(encodeEvaluation(evaluationFromEvent(evaluations[0])))
      );
  });
}

export function recordHarnessEvaluation(
  input: unknown,
  options: RunStorageOptions = {}
) {
  return Effect.gen(function* () {
    const request = yield* decodeHarnessEvaluationRecordingInput(
      input,
      "InvalidHarnessEvaluationRequest",
      "Harness evaluation recording selectors are invalid."
    );
    const resolved = yield* resolveEvaluationInput(request, options);
    const evaluation = yield* validate(
      "InvalidHarnessEvaluation",
      "Runtime-derived harness evaluation evidence is invalid.",
      () => makeHarnessEvaluationV1(resolved)
    );
    yield* assertFactoryRunAcceptanceSecretSafe(encodeEvaluation(evaluation));
    yield* validateEvaluationAuthority(evaluation, options);
    const paths = yield* makeRunPaths(evaluation.anchorRunId, options);
    const store = yield* makeRunStorePaths(options);
    return yield* projectionSemaphore.withPermits(
      store.gaiaRoot,
      1
    )(
      withRunEventSerialization(
        paths,
        Effect.gen(function* () {
          const events = yield* readEvents(paths);
          const existing = evaluationEvents(events);
          const sameId = existing.find(
            (event) =>
              evaluationFromEvent(event).evaluationId ===
              evaluation.evaluationId
          );
          if (sameId !== undefined) {
            const recorded = evaluationFromEvent(sameId);
            if (recorded.evaluationDigest !== evaluation.evaluationDigest)
              return yield* Effect.fail(
                runtimeFailure(
                  "HarnessEvaluationConflict",
                  "The evaluation identity is already bound to another digest."
                )
              );
            yield* writeProjection(
              paths,
              paths.harnessEvaluation,
              canonicalEncoded(encodeEvaluation(recorded))
            );
            return { evaluation: recorded, event: sameId };
          }
          if (existing.length > 0)
            return yield* Effect.fail(
              runtimeFailure(
                "HarnessEvaluationConflict",
                "The evaluation anchor already has a different evaluation."
              )
            );
          const latest = events.at(-1);
          const prepared = makeRunEvent({
            payload: { harnessEvaluation: encodeEvaluation(evaluation) },
            runId: evaluation.anchorRunId,
            sequence: events.length + 1,
            timestamp:
              latest === undefined
                ? new Date(0).toISOString()
                : new Date(Date.parse(latest.timestamp) + 1).toISOString(),
            type: "HARNESS_EVALUATION_RECORDED",
          });
          const appended = yield* appendPreparedEventWithinSerialization(
            evaluation.anchorRunId,
            paths,
            events,
            prepared
          );
          yield* writeProjection(
            paths,
            paths.harnessEvaluation,
            canonicalEncoded(encodeEvaluation(evaluation))
          );
          return { evaluation, event: appended.event };
        })
      )
    );
  }).pipe(Effect.uninterruptible);
}
