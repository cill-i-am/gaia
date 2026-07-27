import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import { FactoryLessonIdSchema } from "./factory-lesson.js";
import { canonicalV1, RunEventSequenceSchema } from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const LowerSha256Schema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
);
const CommitShaSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
);
const BoundedIdentifierSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(192),
    Schema.isPattern(/^[A-Za-z0-9@][A-Za-z0-9._@/:-]*$/u)
  )
);
const TimestampSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  )
);

export const HarnessBaselineManifestDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("HarnessBaselineManifestDigest")
);
export const HarnessEvaluationDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("HarnessEvaluationDigest")
);

const GraderV1 = Schema.Struct({
  id: BoundedIdentifierSchema,
  version: BoundedIdentifierSchema,
});
const ScenarioRefV1 = Schema.Struct({
  id: BoundedIdentifierSchema,
  version: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
  ),
});
const StableModelV1 = Schema.Struct({
  id: BoundedIdentifierSchema,
  provider: BoundedIdentifierSchema,
  reasoningEffort: BoundedIdentifierSchema,
});
const StableWorkerV1 = Schema.Struct({
  capabilityEpoch: BoundedIdentifierSchema,
  id: BoundedIdentifierSchema,
});
const AcceptedOutcomeRefV2 = Schema.Struct({
  outcomeId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^accepted-outcome:sha256:[a-f0-9]{64}$/u))
  ),
  proofContractDigest: LowerSha256Schema,
  version: Schema.Literal(2),
});
const ExternalConditionV1 = Schema.Struct({
  descriptor: BoundedIdentifierSchema,
  digest: LowerSha256Schema,
});
const BaselineLimitationSchema = Schema.Literals([
  "operatorRecordedExternalState",
  "providerNativeInventoryNotExposed",
  "singleLocalHost",
  "smallSample",
  "treatmentNotYetRecorded",
  "unobservableLessonBehavior",
] as const);
const StopConditionSchema = Schema.Literals([
  "cancelled",
  "humanAuthorityRequired",
  "providerUnavailable",
  "unknownExternalOutcome",
] as const);

const HarnessBaselineManifestContentV1 = Schema.Struct({
  acceptedOutcome: AcceptedOutcomeRefV2,
  authorityDigest: LowerSha256Schema,
  baseDigest: LowerSha256Schema,
  contextDigest: LowerSha256Schema,
  evaluationId: BoundedIdentifierSchema,
  externalCondition: ExternalConditionV1,
  freshSessionPolicy: Schema.Literal("globallyDistinct"),
  grader: GraderV1,
  interventionWithheld: Schema.Literals([
    "promotedControl",
    "runtimeRevision",
  ] as const),
  limitations: Schema.Array(BaselineLimitationSchema).pipe(
    Schema.check(Schema.isMaxLength(16))
  ),
  manifestId: BoundedIdentifierSchema,
  model: StableModelV1,
  ownerRunId: RunIdSchema,
  plannedBaselineRunIds: Schema.Array(RunIdSchema).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64))
  ),
  plannedRepetitions: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 64 }))
  ),
  profileDigest: LowerSha256Schema,
  providerInterfaceDigest: LowerSha256Schema,
  recordedAt: TimestampSchema,
  runtimeRevision: CommitShaSchema,
  scenario: ScenarioRefV1,
  skillManifestDigest: LowerSha256Schema,
  stopConditions: Schema.Array(StopConditionSchema).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8))
  ),
  targetDigest: LowerSha256Schema,
  version: Schema.Literal(1),
  worker: StableWorkerV1,
  workerPlanDigest: LowerSha256Schema,
});

export class HarnessBaselineManifestV1 extends Schema.Class<HarnessBaselineManifestV1>(
  "HarnessBaselineManifestV1"
)(
  {
    ...HarnessBaselineManifestContentV1.fields,
    manifestDigest: HarnessBaselineManifestDigestSchema,
  },
  strict
) {}

export class HarnessBaselineManifestRefV1 extends Schema.Class<HarnessBaselineManifestRefV1>(
  "HarnessBaselineManifestRefV1"
)(
  {
    eventSequence: RunEventSequenceSchema,
    manifestDigest: HarnessBaselineManifestDigestSchema,
    manifestId: BoundedIdentifierSchema,
    ownerRunId: RunIdSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

export const HarnessBaselinePreparedInputsV1 = Schema.Struct({
  authorityDigest: LowerSha256Schema,
  baseDigest: LowerSha256Schema,
  capabilityEpoch: BoundedIdentifierSchema,
  contextDigest: LowerSha256Schema,
  modelId: BoundedIdentifierSchema,
  modelProvider: BoundedIdentifierSchema,
  modelReasoningEffort: BoundedIdentifierSchema,
  profileDigest: LowerSha256Schema,
  providerInterfaceDigest: LowerSha256Schema,
  runtimeRevision: CommitShaSchema,
  skillManifestDigest: LowerSha256Schema,
  targetDigest: LowerSha256Schema,
  workerId: BoundedIdentifierSchema,
  workerPlanDigest: LowerSha256Schema,
});

export type HarnessBaselinePreparedInputsV1 =
  typeof HarnessBaselinePreparedInputsV1.Type;

const RuntimeRevisionInterventionV1 = Schema.Struct({
  baselineRuntimeRevision: CommitShaSchema,
  baselineSemanticContractDigest: LowerSha256Schema,
  kind: Schema.Literal("runtimeRevision"),
  treatmentRuntimeRevision: CommitShaSchema,
  treatmentSemanticContractDigest: LowerSha256Schema,
  version: Schema.Literal(1),
});
const PromotedControlInterventionV1 = Schema.Struct({
  kind: Schema.Literal("promotedControl"),
  lessonId: FactoryLessonIdSchema,
  projectionDigest: LowerSha256Schema,
  version: Schema.Literal(1),
}).pipe(
  Schema.check(
    Schema.makeFilter((intervention) =>
      intervention.lessonId === `lesson1_${intervention.projectionDigest}`
        ? undefined
        : {
            issue: "lessonId must bind the exact projectionDigest",
            path: ["lessonId"],
          }
    )
  )
);
export const HarnessEvaluationInterventionV1 = Schema.Union([
  RuntimeRevisionInterventionV1,
  PromotedControlInterventionV1,
]);

const HarnessPreparationRepetitionV1 = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 64 }))
);
const HarnessBaselinePreparationBindingV1 = Schema.Struct({
  manifestRef: HarnessBaselineManifestRefV1,
  repetition: HarnessPreparationRepetitionV1,
  role: Schema.Literal("baseline"),
  runId: RunIdSchema,
});
const HarnessTreatmentPreparationBindingV1 = Schema.Struct({
  intervention: HarnessEvaluationInterventionV1,
  manifestRef: HarnessBaselineManifestRefV1,
  repetition: HarnessPreparationRepetitionV1,
  role: Schema.Literal("treatment"),
  runId: RunIdSchema,
});
export const HarnessRunPreparationBindingV1 = Schema.Union([
  HarnessBaselinePreparationBindingV1,
  HarnessTreatmentPreparationBindingV1,
]);
export type HarnessRunPreparationBindingV1 =
  typeof HarnessRunPreparationBindingV1.Type;

const HarnessPreparedArtifactRefV1 = Schema.Struct({
  artifactId: Schema.Literals([
    "model-context-manifest",
    "model-invocation-manifest",
    "run-contract",
    "run-profile",
    "skill-manifest",
    "worker-plan",
  ] as const),
  byteLength: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 1_048_576 })
    )
  ),
  contentDigest: LowerSha256Schema,
  path: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(240),
      Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/u)
    )
  ),
});

const HarnessPreparedRunReceiptContentV1 = Schema.Struct({
  artifacts: Schema.Array(HarnessPreparedArtifactRefV1).pipe(
    Schema.check(Schema.isMinLength(6), Schema.isMaxLength(6))
  ),
  capabilitiesDigest: LowerSha256Schema,
  lessonSelectionDigest: Schema.optionalKey(LowerSha256Schema),
  manifestRef: HarnessBaselineManifestRefV1,
  preparationBinding: HarnessRunPreparationBindingV1,
  preparedInputs: HarnessBaselinePreparedInputsV1,
  providerId: BoundedIdentifierSchema,
  providerVersion: BoundedIdentifierSchema,
  recordedAt: TimestampSchema,
  runId: RunIdSchema,
  version: Schema.Literal(1),
});

export class HarnessPreparedRunReceiptV1 extends Schema.Class<HarnessPreparedRunReceiptV1>(
  "HarnessPreparedRunReceiptV1"
)(
  {
    ...HarnessPreparedRunReceiptContentV1.fields,
    receiptDigest: LowerSha256Schema,
  },
  strict
) {}

export class HarnessPreparedRunReceiptRefV1 extends Schema.Class<HarnessPreparedRunReceiptRefV1>(
  "HarnessPreparedRunReceiptRefV1"
)(
  {
    eventSequence: RunEventSequenceSchema,
    receiptDigest: LowerSha256Schema,
    runId: RunIdSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

const decodePreparedRunReceiptContent = Schema.decodeUnknownSync(
  HarnessPreparedRunReceiptContentV1,
  strict.parseOptions
);
const decodePreparedRunReceipt = Schema.decodeUnknownSync(
  HarnessPreparedRunReceiptV1,
  strict.parseOptions
);
const encodePreparedRunReceiptContent = Schema.encodeSync(
  HarnessPreparedRunReceiptContentV1
);

export function makeHarnessPreparedRunReceiptV1(
  input: typeof HarnessPreparedRunReceiptContentV1.Encoded
) {
  const content = decodePreparedRunReceiptContent(input);
  const artifactIds = content.artifacts.map(({ artifactId }) => artifactId);
  const paths = content.artifacts.map(({ path }) => path);
  if (!unique(artifactIds) || !unique(paths))
    throw new Error(
      "Prepared-run artifact identities and paths must be unique."
    );
  if (
    !sameManifestRef(
      content.manifestRef,
      content.preparationBinding.manifestRef
    )
  )
    throw new Error("Prepared-run binding must use the receipt manifest ref.");
  const promotedTreatment =
    content.preparationBinding.role === "treatment" &&
    content.preparationBinding.intervention.kind === "promotedControl";
  if (promotedTreatment !== (content.lessonSelectionDigest !== undefined))
    throw new Error(
      "Promoted-control preparation must bind one exact lesson selection."
    );
  return decodePreparedRunReceipt({
    ...content,
    receiptDigest: digest(
      "gaia.harness-prepared-run-receipt.v1",
      encodePreparedRunReceiptContent(content)
    ),
  });
}

export function parseHarnessPreparedRunReceiptV1(input: unknown) {
  const parsed = decodePreparedRunReceipt(input);
  const expected = makeHarnessPreparedRunReceiptV1(
    encodePreparedRunReceiptContent(parsed)
  );
  if (parsed.receiptDigest !== expected.receiptDigest)
    throw new Error(
      "Harness prepared-run receipt digest does not match content."
    );
  return parsed;
}

export function makeHarnessPreparedRunReceiptRefV1(input: {
  readonly eventSequence: number;
  readonly receipt: HarnessPreparedRunReceiptV1;
}) {
  return Schema.decodeUnknownSync(HarnessPreparedRunReceiptRefV1)({
    eventSequence: input.eventSequence,
    receiptDigest: input.receipt.receiptDigest,
    runId: input.receipt.runId,
    version: 1,
  });
}

export function projectHarnessBaselinePreparedInputsV1(
  manifest: HarnessBaselineManifestV1
): HarnessBaselinePreparedInputsV1 {
  return Schema.decodeUnknownSync(HarnessBaselinePreparedInputsV1)({
    authorityDigest: manifest.authorityDigest,
    baseDigest: manifest.baseDigest,
    capabilityEpoch: manifest.worker.capabilityEpoch,
    contextDigest: manifest.contextDigest,
    modelId: manifest.model.id,
    modelProvider: manifest.model.provider,
    modelReasoningEffort: manifest.model.reasoningEffort,
    profileDigest: manifest.profileDigest,
    providerInterfaceDigest: manifest.providerInterfaceDigest,
    runtimeRevision: manifest.runtimeRevision,
    skillManifestDigest: manifest.skillManifestDigest,
    targetDigest: manifest.targetDigest,
    workerId: manifest.worker.id,
    workerPlanDigest: manifest.workerPlanDigest,
  });
}

const BaselineManifestInput = Schema.Struct({
  ...HarnessBaselineManifestContentV1.fields,
  version: Schema.optionalKey(Schema.Literal(1)),
});
const decodeBaselineManifestInput = Schema.decodeUnknownSync(
  BaselineManifestInput,
  strict.parseOptions
);
const decodeBaselineManifest = Schema.decodeUnknownSync(
  HarnessBaselineManifestV1,
  strict.parseOptions
);
const encodeBaselineContent = Schema.encodeSync(
  HarnessBaselineManifestContentV1
);

function digest(domain: string, value: unknown) {
  return bytesToHex(sha256(canonicalV1(domain, [value])));
}

function unique<T>(values: ReadonlyArray<T>) {
  return new Set(values).size === values.length;
}

function sameManifestRef(
  left: HarnessBaselineManifestRefV1,
  right: HarnessBaselineManifestRefV1
) {
  return (
    left.eventSequence === right.eventSequence &&
    left.manifestDigest === right.manifestDigest &&
    left.manifestId === right.manifestId &&
    left.ownerRunId === right.ownerRunId &&
    left.version === right.version
  );
}

export function makeHarnessBaselineManifestV1(
  input: typeof BaselineManifestInput.Encoded
) {
  const parsed = decodeBaselineManifestInput(input);
  if (!unique(parsed.plannedBaselineRunIds))
    throw new Error("Baseline manifest planned run IDs must be unique.");
  if (parsed.plannedRepetitions !== parsed.plannedBaselineRunIds.length)
    throw new Error(
      "Baseline manifest repetition count must match planned run IDs."
    );
  const content = {
    ...parsed,
    limitations: [...parsed.limitations].sort(),
    plannedBaselineRunIds: [...parsed.plannedBaselineRunIds],
    stopConditions: [...parsed.stopConditions].sort(),
    version: 1 as const,
  };
  return decodeBaselineManifest({
    ...content,
    manifestDigest: digest(
      "gaia.harness-baseline-manifest.v1",
      encodeBaselineContent(content)
    ),
  });
}

export function parseHarnessBaselineManifestV1(input: unknown) {
  const parsed = decodeBaselineManifest(input);
  const expectedDigest = digest(
    "gaia.harness-baseline-manifest.v1",
    encodeBaselineContent(parsed)
  );
  if (parsed.manifestDigest !== expectedDigest)
    throw new Error("Harness baseline manifest digest does not match content.");
  return parsed;
}

export function makeHarnessBaselineManifestRefV1(input: {
  readonly eventSequence: number;
  readonly manifest: HarnessBaselineManifestV1;
}) {
  return Schema.decodeUnknownSync(HarnessBaselineManifestRefV1)({
    eventSequence: input.eventSequence,
    manifestDigest: input.manifest.manifestDigest,
    manifestId: input.manifest.manifestId,
    ownerRunId: input.manifest.ownerRunId,
    version: 1,
  });
}

export const HarnessEvaluationConditionProjectionV1 = Schema.Struct({
  acceptedOutcomeDigest: LowerSha256Schema,
  authorityDigest: LowerSha256Schema,
  baseDigest: LowerSha256Schema,
  capabilityEpoch: BoundedIdentifierSchema,
  externalConditionDigest: LowerSha256Schema,
  graderDigest: LowerSha256Schema,
  modelDigest: LowerSha256Schema,
  profileDigest: LowerSha256Schema,
  providerInterfaceDigest: LowerSha256Schema,
  skillManifestDigest: LowerSha256Schema,
  targetDigest: LowerSha256Schema,
  workerDigest: LowerSha256Schema,
  workerPlanDigest: LowerSha256Schema,
});

export class HarnessEvaluationPrefixRefV1 extends Schema.Class<HarnessEvaluationPrefixRefV1>(
  "HarnessEvaluationPrefixRefV1"
)(
  {
    prefixDigest: LowerSha256Schema,
    runId: RunIdSchema,
    throughSequence: RunEventSequenceSchema,
  },
  strict
) {}

const HarnessEvaluationSideV1 = Schema.Struct({
  conditions: HarnessEvaluationConditionProjectionV1,
  evidence: Schema.Struct({
    acceptedOutcome: Schema.Struct({
      outcomeId: AcceptedOutcomeRefV2.fields.outcomeId,
      resultDigest: LowerSha256Schema,
      statementDigest: LowerSha256Schema,
    }),
    contentAuthoritySequence: RunEventSequenceSchema,
    contractDigest: LowerSha256Schema,
    contractVersion: Schema.Literal(2),
    environmentReceiptDigest: LowerSha256Schema,
    externalConditionReceiptDigest: LowerSha256Schema,
    modelManifestDigest: LowerSha256Schema,
    proofContractDigest: LowerSha256Schema,
    proofResultDigest: LowerSha256Schema,
    providerReceiptDigest: LowerSha256Schema,
    runProfileDigest: LowerSha256Schema,
    runtimeRevision: CommitShaSchema,
    workerReceiptDigest: LowerSha256Schema,
  }),
  prefix: HarnessEvaluationPrefixRefV1,
  runId: RunIdSchema,
  sessionId: BoundedIdentifierSchema,
});
const HarnessEvaluationBaselineSideV1 = Schema.Struct({
  ...HarnessEvaluationSideV1.fields,
  baselineManifestRef: HarnessBaselineManifestRefV1,
});
const HarnessEvaluationRepetitionV1 = Schema.Struct({
  baseline: HarnessEvaluationBaselineSideV1,
  treatment: HarnessEvaluationSideV1,
});

export const HarnessLessonObservationSchema = Schema.Literals([
  "invoked",
  "offered",
  "relevant",
  "retrieved",
  "unobservable",
] as const);
const InterventionEvidenceV1 = Schema.Struct({
  available: Schema.Boolean,
  observation: HarnessLessonObservationSchema,
});

export const HarnessMetricFamilySchema = Schema.Literals([
  "acceptedOutcomeCorrectness",
  "architectureScopeAdherence",
  "attemptsRepairTrajectory",
  "carryingCost",
  "humanAttention",
  "latency",
  "proofCompleteness",
  "replayCorrectness",
  "unknownExternalEffects",
] as const);
const EventMetricProvenanceV1 = Schema.Struct({
  eventDigest: LowerSha256Schema,
  eventType: BoundedIdentifierSchema,
  kind: Schema.Literal("event"),
  runId: RunIdSchema,
  sequence: RunEventSequenceSchema,
});
const ArtifactMetricProvenanceV1 = Schema.Struct({
  artifactId: BoundedIdentifierSchema,
  byteLength: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 1_048_576 })
    )
  ),
  contentDigest: LowerSha256Schema,
  kind: Schema.Literal("artifact"),
  owningEventSequence: RunEventSequenceSchema,
  path: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(240),
      Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/u)
    )
  ),
  runId: RunIdSchema,
});
const credentialMaterialPattern =
  /(?:bearer\s+\S+|(?:api[_-]?key|secret|token)\s*[:=]|(?:ghp|sk)-[A-Za-z0-9_-]+|(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,})/iu;
function containsCredentialMaterial(value: string) {
  return credentialMaterialPattern.test(value);
}
const OperatorStatementV1 = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(512),
    Schema.makeFilter((statement) => !containsCredentialMaterial(statement), {
      description: "bounded privacy-safe operator statement",
    })
  )
);
const HarnessOperatorStatementCommitmentInputV1 = Schema.Struct({
  grader: GraderV1,
  statement: OperatorStatementV1,
});
const decodeOperatorStatementCommitmentInput = Schema.decodeUnknownSync(
  HarnessOperatorStatementCommitmentInputV1,
  strict.parseOptions
);

/**
 * Commits an operator statement to the exact configured grader identity.
 */
export function makeHarnessOperatorStatementDigestV1(
  input: typeof HarnessOperatorStatementCommitmentInputV1.Encoded
) {
  return digest(
    "gaia.harness-evaluation-operator-statement.v1",
    decodeOperatorStatementCommitmentInput(input)
  );
}

const OperatorMetricProvenanceV1 = Schema.Struct({
  graderId: BoundedIdentifierSchema,
  graderVersion: BoundedIdentifierSchema,
  kind: Schema.Literal("operatorSupplied"),
  recordedAt: TimestampSchema,
  statement: OperatorStatementV1,
  statementDigest: LowerSha256Schema,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (provenance) =>
        provenance.statementDigest ===
        makeHarnessOperatorStatementDigestV1({
          grader: {
            id: provenance.graderId,
            version: provenance.graderVersion,
          },
          statement: provenance.statement,
        }),
      { description: "operator statement digest bound to the exact grader" }
    )
  )
);
const InferredMetricSourceV1 = Schema.Union([
  EventMetricProvenanceV1,
  ArtifactMetricProvenanceV1,
]);
function inferredMetricSourceKey(source: typeof InferredMetricSourceV1.Type) {
  return bytesToHex(
    canonicalV1("gaia.harness-evaluation-inferred-source-ref.v1", [source])
  );
}
export const HarnessInferredMetricDerivationRequestV1 = Schema.Struct({
  algorithm: Schema.Literal("authority-reference-summary"),
  kind: Schema.Literal("inferred"),
  limitation: BoundedIdentifierSchema,
  sources: Schema.Array(InferredMetricSourceV1).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    Schema.check(
      Schema.makeFilter(
        (sources) =>
          new Set(sources.map(inferredMetricSourceKey)).size === sources.length,
        { description: "unique exact inferred metric source refs" }
      )
    )
  ),
  version: Schema.Literal("1"),
});
export const HarnessMetricProvenanceV1 = Schema.Union([
  EventMetricProvenanceV1,
  ArtifactMetricProvenanceV1,
  OperatorMetricProvenanceV1,
  HarnessInferredMetricDerivationRequestV1,
]);
function isSafeNonCollapsingMetricValue(value: unknown): boolean {
  if (typeof value === "string")
    return value.length <= 512 && !containsCredentialMaterial(value);
  if (Array.isArray(value))
    return value.length <= 64 && value.every(isSafeNonCollapsingMetricValue);
  if (value !== null && typeof value === "object")
    return (
      Object.keys(value).length <= 32 &&
      Object.entries(value).every(
        ([key, child]) =>
          !["rank", "total", "winner"].includes(key) &&
          isSafeNonCollapsingMetricValue(child)
      )
    );
  return (
    value === null || typeof value === "number" || typeof value === "boolean"
  );
}
const HarnessMetricValueV1 = Schema.Json.pipe(
  Schema.check(
    Schema.makeFilter(isSafeNonCollapsingMetricValue, {
      description:
        "privacy-safe metric JSON without rank, total, or winner aggregates",
    })
  )
);
const HarnessMetricV1 = Schema.Struct({
  family: HarnessMetricFamilySchema,
  provenance: HarnessMetricProvenanceV1,
  repetition: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
  ),
  value: HarnessMetricValueV1,
});
const DirectMetricProvenanceV1 = Schema.Union([
  EventMetricProvenanceV1,
  ArtifactMetricProvenanceV1,
  OperatorMetricProvenanceV1,
]);
const HarnessMetricRecordingInputV1 = Schema.Union([
  Schema.Struct({
    family: HarnessMetricFamilySchema,
    provenance: DirectMetricProvenanceV1,
    repetition: Schema.Number.pipe(
      Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
    ),
    value: HarnessMetricValueV1,
  }),
  Schema.Struct({
    family: HarnessMetricFamilySchema,
    provenance: HarnessInferredMetricDerivationRequestV1,
    repetition: Schema.Number.pipe(
      Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
    ),
  }),
]);

export const HarnessEvaluationInvalidReasonSchema = Schema.Literals([
  "conditionMismatch",
  "duplicateRunId",
  "duplicateSessionId",
  "manifestEvaluationMismatch",
  "evidenceMismatch",
  "missingSessionId",
  "multiIntervention",
  "runNotPlanned",
  "unavailableIntervention",
] as const);
const ValidComparable = Schema.Struct({
  reasons: Schema.Tuple([]),
  state: Schema.Literal("validComparable"),
});
const Invalid = Schema.Struct({
  reasons: Schema.Array(HarnessEvaluationInvalidReasonSchema).pipe(
    Schema.check(Schema.isMinLength(1))
  ),
  state: Schema.Literal("invalid"),
});
const InsufficientEvidence = Schema.Struct({
  reasons: Schema.Array(
    Schema.Literals([
      "insufficientRepetitions",
      "unobservableIntervention",
    ] as const)
  ).pipe(Schema.check(Schema.isMinLength(1))),
  state: Schema.Literal("insufficientEvidence"),
});
export const HarnessEvaluationValidityV1 = Schema.Union([
  ValidComparable,
  Invalid,
  InsufficientEvidence,
]);

const EvaluationScenarioV1 = Schema.Struct({
  id: BoundedIdentifierSchema,
  minimumRepetitions: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 64 }))
  ),
  version: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0))
  ),
});
export const HarnessEvaluationInputV1Schema = Schema.Struct({
  anchorRunId: RunIdSchema,
  baselineManifest: HarnessBaselineManifestV1,
  baselineManifestRef: HarnessBaselineManifestRefV1,
  evaluationMode: Schema.optionalKey(Schema.Literal("fixedWorker")),
  evaluationId: BoundedIdentifierSchema,
  grader: GraderV1,
  intervention: HarnessEvaluationInterventionV1,
  interventionEvidence: Schema.optionalKey(InterventionEvidenceV1),
  limitations: Schema.Array(BoundedIdentifierSchema).pipe(
    Schema.check(Schema.isMaxLength(32))
  ),
  metrics: Schema.Array(HarnessMetricV1).pipe(
    Schema.check(Schema.isMaxLength(4_096))
  ),
  repetitions: Schema.Array(HarnessEvaluationRepetitionV1).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64))
  ),
  scenario: EvaluationScenarioV1,
});

const HarnessEvaluationRecordingSideV1 = Schema.Struct({
  prefix: HarnessEvaluationPrefixRefV1,
  runId: RunIdSchema,
  sessionId: BoundedIdentifierSchema,
});
const HarnessEvaluationRecordingBaselineSideV1 = Schema.Struct({
  ...HarnessEvaluationRecordingSideV1.fields,
  baselineManifestRef: HarnessBaselineManifestRefV1,
});
const HarnessEvaluationRecordingRepetitionV1 = Schema.Struct({
  baseline: HarnessEvaluationRecordingBaselineSideV1,
  treatment: HarnessEvaluationRecordingSideV1,
});

/**
 * Runtime recording accepts only stable selectors.
 * Fixed conditions and evidence are resolved from event-owned run histories.
 */
export const HarnessEvaluationRecordingInputV1Schema = Schema.Struct({
  anchorRunId: RunIdSchema,
  baselineManifestRef: HarnessBaselineManifestRefV1,
  evaluationId: BoundedIdentifierSchema,
  grader: GraderV1,
  intervention: HarnessEvaluationInterventionV1,
  limitations: Schema.Array(BoundedIdentifierSchema).pipe(
    Schema.check(Schema.isMaxLength(32))
  ),
  metrics: Schema.Array(HarnessMetricRecordingInputV1).pipe(
    Schema.check(Schema.isMaxLength(4_096))
  ),
  repetitions: Schema.Array(HarnessEvaluationRecordingRepetitionV1).pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64))
  ),
  scenario: EvaluationScenarioV1,
});

export type HarnessEvaluationRecordingInputV1Encoded =
  typeof HarnessEvaluationRecordingInputV1Schema.Encoded;

const HarnessEvaluationContentV1 = Schema.Struct({
  anchorRunId: RunIdSchema,
  baselineManifestRef: HarnessBaselineManifestRefV1,
  conditionComparison: Schema.Struct({
    equal: Schema.Boolean,
    mismatchedFields: Schema.Array(BoundedIdentifierSchema),
  }),
  disposition: Schema.Literals([
    "insufficientEvidence",
    "remove",
    "retain",
    "revise",
  ] as const),
  evaluationId: BoundedIdentifierSchema,
  evaluationMode: Schema.Literal("fixedWorker"),
  grader: GraderV1,
  intervention: HarnessEvaluationInterventionV1,
  interventionEvidence: Schema.optionalKey(InterventionEvidenceV1),
  limitations: Schema.Array(BoundedIdentifierSchema),
  metrics: Schema.Array(HarnessMetricV1),
  repetitions: Schema.Array(HarnessEvaluationRepetitionV1),
  scenario: EvaluationScenarioV1,
  validity: HarnessEvaluationValidityV1,
  version: Schema.Literal(1),
});

export class HarnessEvaluationV1 extends Schema.Class<HarnessEvaluationV1>(
  "HarnessEvaluationV1"
)(
  {
    ...HarnessEvaluationContentV1.fields,
    evaluationDigest: HarnessEvaluationDigestSchema,
  },
  strict
) {}

export type HarnessEvaluationInputV1Encoded =
  typeof HarnessEvaluationInputV1Schema.Encoded;

const decodeEvaluationInput = Schema.decodeUnknownSync(
  HarnessEvaluationInputV1Schema,
  strict.parseOptions
);
const decodeEvaluation = Schema.decodeUnknownSync(
  HarnessEvaluationV1,
  strict.parseOptions
);
const encodeEvaluationContent = Schema.encodeSync(HarnessEvaluationContentV1);

function differingConditionFields(
  repetitions: ReadonlyArray<typeof HarnessEvaluationRepetitionV1.Type>,
  intervention: typeof HarnessEvaluationInterventionV1.Type
) {
  const fields = Object.keys(
    HarnessEvaluationConditionProjectionV1.fields
  ) as ReadonlyArray<keyof typeof HarnessEvaluationConditionProjectionV1.Type>;
  const fixedFields =
    intervention.kind === "runtimeRevision"
      ? fields.filter((field) => field !== "providerInterfaceDigest")
      : fields;
  const first = repetitions[0];
  if (first === undefined) return [];
  const expected = first.baseline.conditions;
  return fixedFields.filter((field) =>
    repetitions.some(({ baseline, treatment }) =>
      [baseline, treatment].some(
        ({ conditions }) => conditions[field] !== expected[field]
      )
    )
  );
}

export function makeHarnessEvaluationV1(
  input: HarnessEvaluationInputV1Encoded
) {
  const parsed = decodeEvaluationInput(input);
  const invalidReasons = new Set<
    typeof HarnessEvaluationInvalidReasonSchema.Type
  >();
  const runs = parsed.repetitions.flatMap(({ baseline, treatment }) => [
    baseline.runId,
    treatment.runId,
  ]);
  const sessions = parsed.repetitions.flatMap(({ baseline, treatment }) => [
    baseline.sessionId,
    treatment.sessionId,
  ]);
  if (!unique(runs)) invalidReasons.add("duplicateRunId");
  if (!unique(sessions)) invalidReasons.add("duplicateSessionId");
  if (
    parsed.evaluationId !== parsed.baselineManifest.evaluationId ||
    parsed.scenario.id !== parsed.baselineManifest.scenario.id ||
    parsed.scenario.version !== parsed.baselineManifest.scenario.version ||
    parsed.intervention.kind !== parsed.baselineManifest.interventionWithheld ||
    JSON.stringify(parsed.grader) !==
      JSON.stringify(parsed.baselineManifest.grader)
  )
    invalidReasons.add("manifestEvaluationMismatch");
  if (
    parsed.intervention.kind === "runtimeRevision" &&
    (parsed.intervention.baselineRuntimeRevision !==
      parsed.baselineManifest.runtimeRevision ||
      parsed.intervention.baselineSemanticContractDigest !==
        parsed.baselineManifest.providerInterfaceDigest)
  )
    invalidReasons.add("manifestEvaluationMismatch");
  if (
    parsed.repetitions.some(
      ({ baseline }) =>
        baseline.baselineManifestRef.manifestDigest !==
          parsed.baselineManifestRef.manifestDigest ||
        baseline.baselineManifestRef.manifestId !==
          parsed.baselineManifestRef.manifestId ||
        baseline.baselineManifestRef.ownerRunId !==
          parsed.baselineManifestRef.ownerRunId ||
        baseline.baselineManifestRef.eventSequence !==
          parsed.baselineManifestRef.eventSequence
    )
  )
    invalidReasons.add("manifestEvaluationMismatch");
  if (
    parsed.baselineManifestRef.manifestDigest !==
      parsed.baselineManifest.manifestDigest ||
    parsed.baselineManifestRef.manifestId !==
      parsed.baselineManifest.manifestId ||
    parsed.baselineManifestRef.ownerRunId !== parsed.baselineManifest.ownerRunId
  )
    invalidReasons.add("manifestEvaluationMismatch");
  if (
    parsed.repetitions.some(
      ({ baseline }) =>
        !parsed.baselineManifest.plannedBaselineRunIds.includes(baseline.runId)
    )
  )
    invalidReasons.add("runNotPlanned");
  if (
    parsed.repetitions.some(({ baseline, treatment }) => {
      const sides = [baseline, treatment];
      return sides.some(
        ({ evidence }) =>
          evidence.contractVersion !== 2 ||
          evidence.proofContractDigest !==
            parsed.baselineManifest.acceptedOutcome.proofContractDigest ||
          evidence.acceptedOutcome.outcomeId !==
            parsed.baselineManifest.acceptedOutcome.outcomeId
      );
    })
  )
    invalidReasons.add("evidenceMismatch");
  const runtimeEvidenceMismatch =
    parsed.intervention.kind === "runtimeRevision"
      ? (() => {
          const intervention = parsed.intervention;
          return parsed.repetitions.some(
            ({ baseline, treatment }) =>
              baseline.evidence.runtimeRevision !==
                intervention.baselineRuntimeRevision ||
              treatment.evidence.runtimeRevision !==
                intervention.treatmentRuntimeRevision ||
              baseline.conditions.providerInterfaceDigest !==
                intervention.baselineSemanticContractDigest ||
              treatment.conditions.providerInterfaceDigest !==
                intervention.treatmentSemanticContractDigest
          );
        })()
      : parsed.repetitions.some(
          ({ baseline, treatment }) =>
            baseline.evidence.runtimeRevision !==
            treatment.evidence.runtimeRevision
        );
  if (runtimeEvidenceMismatch) invalidReasons.add("evidenceMismatch");
  if (
    parsed.metrics.some(
      ({ repetition }) => repetition > parsed.repetitions.length
    )
  )
    invalidReasons.add("evidenceMismatch");
  const mismatchedFields = differingConditionFields(
    parsed.repetitions,
    parsed.intervention
  );
  if (mismatchedFields.length > 0) invalidReasons.add("conditionMismatch");
  if (
    parsed.intervention.kind === "promotedControl" &&
    parsed.interventionEvidence?.available !== true
  )
    invalidReasons.add("unavailableIntervention");

  const insufficientReasons: Array<
    (typeof InsufficientEvidence.fields.reasons.Type)[number]
  > = [];
  if (
    parsed.repetitions.length < parsed.scenario.minimumRepetitions ||
    parsed.repetitions.length < parsed.baselineManifest.plannedRepetitions
  )
    insufficientReasons.push("insufficientRepetitions");
  if (
    parsed.intervention.kind === "promotedControl" &&
    parsed.interventionEvidence?.observation === "unobservable"
  )
    insufficientReasons.push("unobservableIntervention");

  const validity =
    invalidReasons.size > 0
      ? {
          reasons: [...invalidReasons].sort(),
          state: "invalid" as const,
        }
      : insufficientReasons.length > 0
        ? {
            reasons: [...new Set(insufficientReasons)].sort(),
            state: "insufficientEvidence" as const,
          }
        : { reasons: [] as [], state: "validComparable" as const };
  const content = {
    anchorRunId: parsed.anchorRunId,
    baselineManifestRef: parsed.baselineManifestRef,
    conditionComparison: {
      equal: mismatchedFields.length === 0,
      mismatchedFields,
    },
    disposition: "insufficientEvidence" as const,
    evaluationId: parsed.evaluationId,
    evaluationMode: "fixedWorker" as const,
    grader: parsed.grader,
    intervention: parsed.intervention,
    ...(parsed.interventionEvidence === undefined
      ? {}
      : { interventionEvidence: parsed.interventionEvidence }),
    limitations: [...parsed.limitations].sort(),
    metrics: parsed.metrics,
    repetitions: parsed.repetitions,
    scenario: parsed.scenario,
    validity,
    version: 1 as const,
  };
  return decodeEvaluation({
    ...content,
    evaluationDigest: digest(
      "gaia.harness-evaluation.v1",
      encodeEvaluationContent(content)
    ),
  });
}

export function parseHarnessEvaluationV1(input: unknown) {
  const parsed = decodeEvaluation(input);
  const expectedDigest = digest(
    "gaia.harness-evaluation.v1",
    encodeEvaluationContent(parsed)
  );
  if (parsed.evaluationDigest !== expectedDigest)
    throw new Error("Harness evaluation digest does not match content.");
  return parsed;
}
