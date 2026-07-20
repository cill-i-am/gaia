import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import {
  DeliveryBranchNamePublicSchema,
  DeliveryGitShaPublicSchema,
  DeliveryRemoteNamePublicSchema,
} from "./delivery-identity.js";
import { RunIdSchema, type RunId } from "./run-id.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const sha256Pattern = /^[a-f0-9]{64}$/u;
const artifactPathPattern =
  /^(?!\/)(?![A-Za-z]:[\\/])(?!.*\\)(?!.*[\u0000-\u001f\u007f])(?!.{4097})(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/).+$/u;
const canonicalUint64Pattern = /^(?:0|[1-9][0-9]*)$/u;
const maxUint64 = 18_446_744_073_709_551_615n;
const WorkspaceIdentityPathSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isMaxLength(4_096),
    Schema.isPattern(
      /^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?:\.|.+)$/u,
      { identifier: "WorkspaceIdentityPath" }
    )
  )
);

const LowerSha256Schema = Schema.String.pipe(
  Schema.check(Schema.isPattern(sha256Pattern, { identifier: "LowerSha256" }))
);

export const StructuralDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("StructuralDigest")
);
export const SpecDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("SpecDigest")
);
export const ExplicitSpecItemDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("ExplicitSpecItemDigest")
);
export const RunContractDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("RunContractDigest")
);
export const RunProofResultDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("RunProofResultDigest")
);
export const ContentDigestSchema = LowerSha256Schema.pipe(
  Schema.brand("ContentDigest")
);

export type StructuralDigest = typeof StructuralDigestSchema.Type;
export type SpecDigest = typeof SpecDigestSchema.Type;
export type ExplicitSpecItemDigest = typeof ExplicitSpecItemDigestSchema.Type;
export type RunContractDigest = typeof RunContractDigestSchema.Type;
export type RunProofResultDigest = typeof RunProofResultDigestSchema.Type;
export type ContentDigest = typeof ContentDigestSchema.Type;

const acceptedOutcomeIdPattern = /^accepted-outcome:sha256:[a-f0-9]{64}$/u;
const proofClaimIdPattern = /^proof-claim:sha256:[a-f0-9]{64}$/u;
const proofEvidenceIdPattern = /^proof-evidence:sha256:[a-f0-9]{64}$/u;
const runContractIdPattern = /^run-contract:.+:v1$/u;
const runContractIdV2Pattern = /^run-contract:.+:v2$/u;

export const AcceptedOutcomeIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(acceptedOutcomeIdPattern, {
      identifier: "AcceptedOutcomeId",
    })
  ),
  Schema.brand("AcceptedOutcomeId")
);
export const ProofClaimIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(proofClaimIdPattern, { identifier: "ProofClaimId" })
  ),
  Schema.brand("ProofClaimId")
);
export const ProofEvidenceIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(proofEvidenceIdPattern, {
      identifier: "ProofEvidenceId",
    })
  ),
  Schema.brand("ProofEvidenceId")
);
export const RunContractIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(runContractIdPattern, { identifier: "RunContractId" })
  ),
  Schema.brand("RunContractId")
);
export const RunContractIdV2Schema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(runContractIdV2Pattern, {
      identifier: "RunContractIdV2",
    })
  ),
  Schema.brand("RunContractIdV2")
);

export type AcceptedOutcomeId = typeof AcceptedOutcomeIdSchema.Type;
export type ProofClaimId = typeof ProofClaimIdSchema.Type;
export type ProofEvidenceId = typeof ProofEvidenceIdSchema.Type;
export type RunContractId = typeof RunContractIdSchema.Type;

/** A path inside a run directory, never an absolute or traversing path. */
export const RunRelativeArtifactPathSchema = Schema.NonEmptyString.pipe(
  Schema.check(
    Schema.isPattern(artifactPathPattern, {
      identifier: "RunRelativeArtifactPath",
    })
  ),
  Schema.brand("RunRelativeArtifactPath")
);
export type RunRelativeArtifactPath = typeof RunRelativeArtifactPathSchema.Type;
export const parseRunRelativeArtifactPath = Schema.decodeUnknownSync(
  RunRelativeArtifactPathSchema
);

/** Positive, append-only event sequence. */
export const RunEventSequenceSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.brand("RunEventSequence")
);
export type RunEventSequence = typeof RunEventSequenceSchema.Type;
export const parseRunEventSequence = Schema.decodeUnknownSync(
  RunEventSequenceSchema
);

export const WorkspaceStructuralPathSchema = RunRelativeArtifactPathSchema.pipe(
  Schema.brand("WorkspaceStructuralPath")
);
export type WorkspaceStructuralPath = typeof WorkspaceStructuralPathSchema.Type;

export const CanonicalUint64DecimalSchema = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value) =>
        canonicalUint64Pattern.test(value) && BigInt(value) <= maxUint64,
      { identifier: "CanonicalUint64Decimal" }
    )
  ),
  Schema.brand("CanonicalUint64Decimal")
);
export type CanonicalUint64Decimal = typeof CanonicalUint64DecimalSchema.Type;

export const ExplicitSpecSectionSchema = Schema.Literals([
  "acceptanceCriteria",
  "verificationChecks",
  "nonGoals",
  "stopConditions",
] as const);
export type ExplicitSpecSection = typeof ExplicitSpecSectionSchema.Type;

const NormalizedExplicitSpecStatementSchema = Schema.NonEmptyString.pipe(
  Schema.brand("NormalizedExplicitSpecStatement")
);
type NormalizedExplicitSpecStatement =
  typeof NormalizedExplicitSpecStatementSchema.Type;

const explicitSpecSourceFields = {
  itemDigest: ExplicitSpecItemDigestSchema,
  kind: Schema.Literal("explicitSpecItem"),
  specDigest: SpecDigestSchema,
  version: Schema.Literal(1),
} as const;

export class ExplicitAcceptanceCriterionSourceV1 extends Schema.Class<ExplicitAcceptanceCriterionSourceV1>(
  "ExplicitAcceptanceCriterionSourceV1"
)(
  {
    ...explicitSpecSourceFields,
    section: Schema.Literal("acceptanceCriteria"),
  },
  strict
) {}
export class ExplicitVerificationCheckSourceV1 extends Schema.Class<ExplicitVerificationCheckSourceV1>(
  "ExplicitVerificationCheckSourceV1"
)(
  {
    ...explicitSpecSourceFields,
    section: Schema.Literal("verificationChecks"),
  },
  strict
) {}
export class ExplicitNonGoalSourceV1 extends Schema.Class<ExplicitNonGoalSourceV1>(
  "ExplicitNonGoalSourceV1"
)(
  { ...explicitSpecSourceFields, section: Schema.Literal("nonGoals") },
  strict
) {}
export class ExplicitStopConditionSourceV1 extends Schema.Class<ExplicitStopConditionSourceV1>(
  "ExplicitStopConditionSourceV1"
)(
  { ...explicitSpecSourceFields, section: Schema.Literal("stopConditions") },
  strict
) {}

export const ExplicitSpecSourceV1Schema = Schema.Union([
  ExplicitAcceptanceCriterionSourceV1,
  ExplicitVerificationCheckSourceV1,
  ExplicitNonGoalSourceV1,
  ExplicitStopConditionSourceV1,
]);
export type ExplicitSpecSourceV1 = typeof ExplicitSpecSourceV1Schema.Type;

export const ProofClaimKindSchema = Schema.Literals([
  "artifact-integrity",
  "command",
  "browser",
  "external-check",
  "human-judgment",
] as const);
export type ProofClaimKind = typeof ProofClaimKindSchema.Type;

export const ProofClaimRequirementSchema = Schema.Literals([
  "required",
  "conditional",
] as const);
export type ProofClaimRequirement = typeof ProofClaimRequirementSchema.Type;

export const ProofAuthorityRequirementSchema = Schema.Literals([
  "gaia-runtime",
  "harness",
  "reviewer",
  "github",
  "browser",
  "human",
  "external-system",
] as const);
export type ProofAuthorityRequirement =
  typeof ProofAuthorityRequirementSchema.Type;

const SortedUniqueProofClaimIdsSchema = Schema.Array(ProofClaimIdSchema).pipe(
  Schema.check(
    Schema.makeFilter(isStrictlySortedUniqueStrings, {
      identifier: "SortedUniqueProofClaimIds",
    })
  )
);
const SortedUniqueAuthoritiesSchema = Schema.Array(
  ProofAuthorityRequirementSchema
).pipe(
  Schema.check(
    Schema.makeFilter(isStrictlySortedUniqueStrings, {
      identifier: "SortedUniqueProofAuthorities",
    })
  )
);

export class AcceptedOutcomeV1 extends Schema.Class<AcceptedOutcomeV1>(
  "AcceptedOutcomeV1"
)(
  {
    conditionalClaimIds: SortedUniqueProofClaimIdsSchema,
    outcomeId: AcceptedOutcomeIdSchema,
    requiredClaimIds: SortedUniqueProofClaimIdsSchema,
    source: ExplicitAcceptanceCriterionSourceV1,
    statement: Schema.NonEmptyString,
  },
  strict
) {}

export class ProofClaimV1 extends Schema.Class<ProofClaimV1>("ProofClaimV1")(
  {
    authorityRequirements: SortedUniqueAuthoritiesSchema,
    claimId: ProofClaimIdSchema,
    kind: ProofClaimKindSchema,
    requirement: ProofClaimRequirementSchema,
    source: ExplicitVerificationCheckSourceV1,
    statement: Schema.NonEmptyString,
  },
  strict
) {}

export class SourcedNonGoalV1 extends Schema.Class<SourcedNonGoalV1>(
  "SourcedNonGoalV1"
)(
  {
    source: ExplicitNonGoalSourceV1,
    statement: Schema.NonEmptyString,
  },
  strict
) {}

export class SourcedStopConditionV1 extends Schema.Class<SourcedStopConditionV1>(
  "SourcedStopConditionV1"
)(
  {
    source: ExplicitStopConditionSourceV1,
    statement: Schema.NonEmptyString,
  },
  strict
) {}

export const RunTargetIdentityV1Schema = Schema.Union([
  Schema.Struct({
    baseBranch: DeliveryBranchNamePublicSchema,
    headBranch: DeliveryBranchNamePublicSchema,
    kind: Schema.Literal("gitWorktree"),
    remote: DeliveryRemoteNamePublicSchema,
    workspacePath: WorkspaceIdentityPathSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("unversionedWorkspace"),
    workspacePath: WorkspaceIdentityPathSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("provenanceUnavailable"),
    reason: Schema.Literals([
      "notCollected",
      "unobservable",
      "historicalInput",
    ] as const),
    workspacePath: WorkspaceIdentityPathSchema,
  }),
]);
export type RunTargetIdentityV1 = typeof RunTargetIdentityV1Schema.Type;

export const RunBaseIdentityV1Schema = Schema.Union([
  Schema.Struct({
    branch: DeliveryBranchNamePublicSchema,
    kind: Schema.Literal("gitRevision"),
    remote: DeliveryRemoteNamePublicSchema,
    revision: DeliveryGitShaPublicSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("unversionedSnapshot"),
    workspacePath: WorkspaceIdentityPathSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("provenanceUnavailable"),
    reason: Schema.Literals([
      "notCollected",
      "unobservable",
      "historicalInput",
    ] as const),
    workspacePath: WorkspaceIdentityPathSchema,
  }),
]);
export type RunBaseIdentityV1 = typeof RunBaseIdentityV1Schema.Type;

export class WorkspaceStructuralObservationReceiptV1 extends Schema.Class<WorkspaceStructuralObservationReceiptV1>(
  "WorkspaceStructuralObservationReceiptV1"
)(
  {
    observationModel: Schema.Literal("single-traversal-manifest"),
    proofLimitations: Schema.Tuple([
      Schema.Literal("not-an-atomic-filesystem-snapshot"),
      Schema.Literal("metadata-stable-concurrent-rewrite-may-be-undetected"),
    ]),
    version: Schema.Literal(1),
  },
  strict
) {}

export function makeWorkspaceStructuralObservationReceipt() {
  return WorkspaceStructuralObservationReceiptV1.make({
    observationModel: "single-traversal-manifest",
    proofLimitations: [
      "not-an-atomic-filesystem-snapshot",
      "metadata-stable-concurrent-rewrite-may-be-undetected",
    ],
    version: 1,
  });
}

export class RunContractV1 extends Schema.Class<RunContractV1>("RunContractV1")(
  {
    acceptedOutcomes: Schema.Array(AcceptedOutcomeV1),
    baseDigest: StructuralDigestSchema,
    baseIdentity: RunBaseIdentityV1Schema,
    baseObservation: WorkspaceStructuralObservationReceiptV1,
    contractDigest: RunContractDigestSchema,
    contractId: RunContractIdSchema,
    nonGoals: Schema.Array(SourcedNonGoalV1),
    proofClaims: Schema.Array(ProofClaimV1),
    runId: RunIdSchema,
    stopConditions: Schema.Array(SourcedStopConditionV1),
    targetDigest: StructuralDigestSchema,
    targetIdentity: RunTargetIdentityV1Schema,
    targetObservation: WorkspaceStructuralObservationReceiptV1,
    version: Schema.Literal(1),
  },
  strict
) {}

export const RunVerificationAggregateSchema = Schema.Literals([
  "verified",
  "completed-unverified",
  "verification-failed",
  "awaiting-outcome-decision",
] as const);
export type RunVerificationAggregate =
  typeof RunVerificationAggregateSchema.Type;

const claimEvidenceFields = {
  artifactPath: RunRelativeArtifactPathSchema,
  contentDigest: ContentDigestSchema,
  evidenceId: ProofEvidenceIdSchema,
} as const;

export class ArtifactIntegrityClaimEvidenceV1 extends Schema.Class<ArtifactIntegrityClaimEvidenceV1>(
  "ArtifactIntegrityClaimEvidenceV1"
)(
  { ...claimEvidenceFields, kind: Schema.Literal("artifact-integrity") },
  strict
) {}
export class CommandClaimEvidenceV1 extends Schema.Class<CommandClaimEvidenceV1>(
  "CommandClaimEvidenceV1"
)({ ...claimEvidenceFields, kind: Schema.Literal("command") }, strict) {}
export class BrowserClaimEvidenceV1 extends Schema.Class<BrowserClaimEvidenceV1>(
  "BrowserClaimEvidenceV1"
)({ ...claimEvidenceFields, kind: Schema.Literal("browser") }, strict) {}
export class ExternalCheckClaimEvidenceV1 extends Schema.Class<ExternalCheckClaimEvidenceV1>(
  "ExternalCheckClaimEvidenceV1"
)({ ...claimEvidenceFields, kind: Schema.Literal("external-check") }, strict) {}

export const ClaimEvidenceV1Schema = Schema.Union([
  ArtifactIntegrityClaimEvidenceV1,
  CommandClaimEvidenceV1,
  BrowserClaimEvidenceV1,
  ExternalCheckClaimEvidenceV1,
]);
export type ClaimEvidenceV1 = typeof ClaimEvidenceV1Schema.Type;

export class SupplementalProtocolEvidenceV1 extends Schema.Class<SupplementalProtocolEvidenceV1>(
  "SupplementalProtocolEvidenceV1"
)(
  {
    ...claimEvidenceFields,
    kind: Schema.Literal("framework-output-marker"),
  },
  strict
) {}

export class PassedProofClaimResultV1 extends Schema.Class<PassedProofClaimResultV1>(
  "PassedProofClaimResultV1"
)(
  {
    claimId: ProofClaimIdSchema,
    evidence: Schema.NonEmptyArray(ClaimEvidenceV1Schema),
    status: Schema.Literal("passed"),
  },
  strict
) {}
export class FailedProofClaimResultV1 extends Schema.Class<FailedProofClaimResultV1>(
  "FailedProofClaimResultV1"
)(
  {
    claimId: ProofClaimIdSchema,
    evidence: Schema.Array(ClaimEvidenceV1Schema),
    reason: Schema.NonEmptyString,
    status: Schema.Literal("failed"),
  },
  strict
) {}
export class NotRunProofClaimResultV1 extends Schema.Class<NotRunProofClaimResultV1>(
  "NotRunProofClaimResultV1"
)(
  {
    claimId: ProofClaimIdSchema,
    reason: Schema.NonEmptyString,
    status: Schema.Literal("not-run"),
  },
  strict
) {}
export class NotApplicableProofClaimResultV1 extends Schema.Class<NotApplicableProofClaimResultV1>(
  "NotApplicableProofClaimResultV1"
)(
  {
    claimId: ProofClaimIdSchema,
    reason: Schema.NonEmptyString,
    status: Schema.Literal("not-applicable"),
  },
  strict
) {}
export class RequiresDecisionProofClaimResultV1 extends Schema.Class<RequiresDecisionProofClaimResultV1>(
  "RequiresDecisionProofClaimResultV1"
)(
  {
    claimId: ProofClaimIdSchema,
    reason: Schema.NonEmptyString,
    requiredAuthority: Schema.Literal("human"),
    status: Schema.Literal("requires-decision"),
  },
  strict
) {}

export const ProofClaimResultV1Schema = Schema.Union([
  PassedProofClaimResultV1,
  FailedProofClaimResultV1,
  NotRunProofClaimResultV1,
  NotApplicableProofClaimResultV1,
  RequiresDecisionProofClaimResultV1,
]);
export type ProofClaimResultV1 = typeof ProofClaimResultV1Schema.Type;

const MakeClaimEvidenceV1Schema = Schema.Union([
  Schema.Struct({
    artifactPath: RunRelativeArtifactPathSchema,
    contentDigest: ContentDigestSchema,
    kind: Schema.Literal("artifact-integrity"),
  }),
  Schema.Struct({
    artifactPath: RunRelativeArtifactPathSchema,
    contentDigest: ContentDigestSchema,
    kind: Schema.Literal("command"),
  }),
  Schema.Struct({
    artifactPath: RunRelativeArtifactPathSchema,
    contentDigest: ContentDigestSchema,
    kind: Schema.Literal("browser"),
  }),
  Schema.Struct({
    artifactPath: RunRelativeArtifactPathSchema,
    contentDigest: ContentDigestSchema,
    kind: Schema.Literal("external-check"),
  }),
]);
type MakeClaimEvidenceV1 = Schema.Schema.Type<typeof MakeClaimEvidenceV1Schema>;
const MakeSupplementalProtocolEvidenceV1Schema = Schema.Struct({
  artifactPath: RunRelativeArtifactPathSchema,
  contentDigest: ContentDigestSchema,
  kind: Schema.Literal("framework-output-marker"),
});
type MakeSupplementalProtocolEvidenceV1 = Schema.Schema.Type<
  typeof MakeSupplementalProtocolEvidenceV1Schema
>;
const MakeProofClaimResultV1Schema = Schema.Union([
  Schema.Struct({
    claimId: ProofClaimIdSchema,
    evidence: Schema.Array(MakeClaimEvidenceV1Schema).pipe(
      Schema.check(Schema.isMinLength(1))
    ),
    status: Schema.Literal("passed"),
  }),
  Schema.Struct({
    claimId: ProofClaimIdSchema,
    evidence: Schema.Array(MakeClaimEvidenceV1Schema),
    reason: Schema.NonEmptyString,
    status: Schema.Literal("failed"),
  }),
  Schema.Struct({
    claimId: ProofClaimIdSchema,
    reason: Schema.NonEmptyString,
    status: Schema.Literal("not-run"),
  }),
  Schema.Struct({
    claimId: ProofClaimIdSchema,
    reason: Schema.NonEmptyString,
    status: Schema.Literal("not-applicable"),
  }),
  Schema.Struct({
    claimId: ProofClaimIdSchema,
    reason: Schema.NonEmptyString,
    requiredAuthority: Schema.Literal("human"),
    status: Schema.Literal("requires-decision"),
  }),
]);
type MakeProofClaimResultV1 = Schema.Schema.Type<
  typeof MakeProofClaimResultV1Schema
>;

export class RunProofResultRecordedByV1 extends Schema.Class<RunProofResultRecordedByV1>(
  "RunProofResultRecordedByV1"
)(
  {
    runId: RunIdSchema,
    sequence: RunEventSequenceSchema,
    type: Schema.Literal("RUN_PROOF_RESULT_RECORDED"),
  },
  strict
) {}

const EvidenceEventBindingV1Schema = Schema.Struct({
  contractDigest: RunContractDigestSchema,
  contractId: RunContractIdSchema,
  runId: RunIdSchema,
  sequence: RunEventSequenceSchema,
});
type EvidenceEventBindingV1 = typeof EvidenceEventBindingV1Schema.Type;

export class RunProofResultV1 extends Schema.Class<RunProofResultV1>(
  "RunProofResultV1"
)(
  {
    aggregate: RunVerificationAggregateSchema,
    baseDigest: StructuralDigestSchema,
    contractDigest: RunContractDigestSchema,
    contractId: RunContractIdSchema,
    observedTargetDigest: StructuralDigestSchema,
    observedTargetObservation: WorkspaceStructuralObservationReceiptV1,
    recordedBy: RunProofResultRecordedByV1,
    resultDigest: RunProofResultDigestSchema,
    results: Schema.Array(ProofClaimResultV1Schema),
    runId: RunIdSchema,
    supplementalProtocolEvidence: Schema.Array(SupplementalProtocolEvidenceV1),
    targetDigest: StructuralDigestSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

const MakeRunProofResultInputSchema = Schema.Struct({
  contract: RunContractV1,
  observedTargetDigest: StructuralDigestSchema,
  observedTargetObservation: Schema.optionalKey(
    WorkspaceStructuralObservationReceiptV1
  ),
  recordedBy: RunProofResultRecordedByV1,
  results: Schema.Array(MakeProofClaimResultV1Schema),
  supplementalProtocolEvidence: Schema.Array(
    MakeSupplementalProtocolEvidenceV1Schema
  ),
});
const decodeMakeRunProofResultInput = Schema.decodeUnknownSync(
  MakeRunProofResultInputSchema
);
const decodeProofClaimResults = Schema.decodeUnknownSync(
  Schema.Array(ProofClaimResultV1Schema)
);
const decodeSupplementalProtocolEvidence = Schema.decodeUnknownSync(
  Schema.Array(SupplementalProtocolEvidenceV1)
);

export class LegacyNoContractRunProofProjectionV1 extends Schema.Class<LegacyNoContractRunProofProjectionV1>(
  "LegacyNoContractRunProofProjectionV1"
)(
  {
    kind: Schema.Literal("no-contract"),
    aggregate: Schema.Literal("completed-unverified"),
    legacyVerification: Schema.optionalKey(
      Schema.Struct({
        recordedBy: Schema.Struct({
          runId: RunIdSchema,
          sequence: RunEventSequenceSchema,
          type: Schema.Literal("VERIFICATION_COMPLETED"),
        }),
        resultPath: RunRelativeArtifactPathSchema,
      })
    ),
    version: Schema.Literal(1),
  },
  strict
) {}

export class ContractRunProofProjectionV1 extends Schema.Class<ContractRunProofProjectionV1>(
  "ContractRunProofProjectionV1"
)(
  {
    kind: Schema.Literal("contract"),
    aggregate: RunVerificationAggregateSchema,
    contract: RunContractV1,
    latestResult: Schema.optionalKey(RunProofResultV1),
    version: Schema.Literal(1),
  },
  strict
) {}

export const RunProofProjectionV1Schema = Schema.Union([
  LegacyNoContractRunProofProjectionV1,
  ContractRunProofProjectionV1,
]);
export type RunProofProjectionV1 = typeof RunProofProjectionV1Schema.Type;

export class WorkspaceStructuralManifestEntryV1 extends Schema.Class<WorkspaceStructuralManifestEntryV1>(
  "WorkspaceStructuralManifestEntryV1"
)(
  {
    contentDigest: ContentDigestSchema,
    kind: Schema.Literal("regular-file"),
    path: WorkspaceStructuralPathSchema,
    sizeBytes: CanonicalUint64DecimalSchema,
  },
  strict
) {}

export class WorkspaceStructuralManifestV1 extends Schema.Class<WorkspaceStructuralManifestV1>(
  "WorkspaceStructuralManifestV1"
)(
  {
    entries: Schema.Array(WorkspaceStructuralManifestEntryV1).pipe(
      Schema.check(
        Schema.makeFilter(
          (entries) =>
            entries.every(
              (entry, index) =>
                index === 0 ||
                compareUtf8(entries[index - 1]!.path, entry.path) < 0
            ),
          { identifier: "CanonicalWorkspaceStructuralManifestOrder" }
        )
      )
    ),
    version: Schema.Literal(1),
  },
  strict
) {}

const WorkspaceStructuralManifestEntriesInputSchema = Schema.Array(
  WorkspaceStructuralManifestEntryV1
);
const decodeWorkspaceStructuralManifestEntriesInput = Schema.decodeUnknownSync(
  WorkspaceStructuralManifestEntriesInputSchema
);

const decodeRunContract = Schema.decodeUnknownSync(RunContractV1);
const decodeRunProofResult = Schema.decodeUnknownSync(RunProofResultV1);
const decodeWorkspaceStructuralManifest = Schema.decodeUnknownSync(
  WorkspaceStructuralManifestV1
);
export const parseWorkspaceStructuralManifest =
  decodeWorkspaceStructuralManifest;
const parseStructuralDigest = Schema.decodeUnknownSync(StructuralDigestSchema);
const parseSpecDigest = Schema.decodeUnknownSync(SpecDigestSchema);
const parseExplicitSpecItemDigest = Schema.decodeUnknownSync(
  ExplicitSpecItemDigestSchema
);
const parseRunContractDigest = Schema.decodeUnknownSync(
  RunContractDigestSchema
);
const parseRunProofResultDigest = Schema.decodeUnknownSync(
  RunProofResultDigestSchema
);
const parseAcceptedOutcomeId = Schema.decodeUnknownSync(
  AcceptedOutcomeIdSchema
);
const parseProofClaimId = Schema.decodeUnknownSync(ProofClaimIdSchema);
const parseProofEvidenceId = Schema.decodeUnknownSync(ProofEvidenceIdSchema);
const parseRunContractId = Schema.decodeUnknownSync(RunContractIdSchema);
const parseNormalizedExplicitSpecStatement = Schema.decodeUnknownSync(
  NormalizedExplicitSpecStatementSchema
);

export const encodeRunContractJson = Schema.encodeSync(
  Schema.toCodecJson(RunContractV1)
);
export const encodeRunProofResultJson = Schema.encodeSync(
  Schema.toCodecJson(RunProofResultV1)
);
export const parseRunContractJson = (input: unknown) =>
  parseRunContract(
    Schema.decodeUnknownSync(Schema.toCodecJson(RunContractV1))(input)
  );
export const parseRunProofResultJson = (
  input: unknown,
  expectedContract: RunContractV1
) =>
  parseRunProofResult(
    Schema.decodeUnknownSync(Schema.toCodecJson(RunProofResultV1))(input),
    expectedContract
  );

export function normalizeExplicitSpecStatement(
  input: string
): NormalizedExplicitSpecStatement {
  const normalized = input.replace(/\r\n?/gu, "\n").trim();
  return parseNormalizedExplicitSpecStatement(normalized);
}

const ExplicitSpecItemDigestInputSchema = Schema.Struct({
  section: ExplicitSpecSectionSchema,
  statement: Schema.String,
});

export function deriveExplicitSpecItemDigest(
  input: typeof ExplicitSpecItemDigestInputSchema.Type
): ExplicitSpecItemDigest {
  return parseExplicitSpecItemDigest(
    digestCanonical("gaia.explicit-spec-item.v1", [
      input.section,
      normalizeExplicitSpecStatement(input.statement),
    ])
  );
}

const AcceptedOutcomeIdInputSchema = Schema.Struct({
  source: ExplicitAcceptanceCriterionSourceV1,
  statement: Schema.String,
});
const decodeAcceptedOutcomeIdInput = Schema.decodeUnknownSync(
  AcceptedOutcomeIdInputSchema
);

export function deriveAcceptedOutcomeId(
  input: typeof AcceptedOutcomeIdInputSchema.Encoded
): AcceptedOutcomeId {
  const decoded = decodeAcceptedOutcomeIdInput(input);
  return parseAcceptedOutcomeId(
    `accepted-outcome:sha256:${digestCanonical("gaia.accepted-outcome-id.v1", [
      sourceCanonical(decoded.source),
      normalizeExplicitSpecStatement(decoded.statement),
    ])}`
  );
}

const ProofClaimIdInputSchema = Schema.Struct({
  authorityRequirements: Schema.Array(ProofAuthorityRequirementSchema),
  kind: ProofClaimKindSchema,
  requirement: ProofClaimRequirementSchema,
  source: ExplicitVerificationCheckSourceV1,
  statement: Schema.String,
});
const decodeProofClaimIdInput = Schema.decodeUnknownSync(
  ProofClaimIdInputSchema
);

export function deriveProofClaimId(
  input: typeof ProofClaimIdInputSchema.Encoded
): ProofClaimId {
  const decoded = decodeProofClaimIdInput(input);
  return parseProofClaimId(
    `proof-claim:sha256:${digestCanonical("gaia.proof-claim-id.v1", [
      sourceCanonical(decoded.source),
      normalizeExplicitSpecStatement(decoded.statement),
      decoded.kind,
      decoded.requirement,
      [...decoded.authorityRequirements].toSorted(),
    ])}`
  );
}

const MakeAcceptedOutcomeV1Schema = Schema.Struct({
  conditionalClaimIds: Schema.optionalKey(SortedUniqueProofClaimIdsSchema),
  outcomeId: AcceptedOutcomeIdSchema,
  requiredClaimIds: SortedUniqueProofClaimIdsSchema,
  source: ExplicitAcceptanceCriterionSourceV1,
  statement: Schema.String,
});
const MakeRunContractV1InputSchema = Schema.Struct({
  acceptedOutcomes: Schema.Array(MakeAcceptedOutcomeV1Schema),
  baseDigest: StructuralDigestSchema,
  baseIdentity: RunBaseIdentityV1Schema,
  baseObservation: Schema.optionalKey(WorkspaceStructuralObservationReceiptV1),
  nonGoals: Schema.Array(SourcedNonGoalV1),
  proofClaims: Schema.Array(ProofClaimV1),
  runId: RunIdSchema,
  stopConditions: Schema.Array(SourcedStopConditionV1),
  targetDigest: StructuralDigestSchema,
  targetIdentity: RunTargetIdentityV1Schema,
  targetObservation: Schema.optionalKey(
    WorkspaceStructuralObservationReceiptV1
  ),
});
const decodeMakeRunContractV1Input = Schema.decodeUnknownSync(
  MakeRunContractV1InputSchema
);

export function makeRunContract(
  input: typeof MakeRunContractV1InputSchema.Encoded
): RunContractV1 {
  const decoded = decodeMakeRunContractV1Input(input);
  const acceptedOutcomes = decoded.acceptedOutcomes
    .map((outcome) => ({
      conditionalClaimIds: outcome.conditionalClaimIds ?? [],
      outcomeId: outcome.outcomeId,
      requiredClaimIds: outcome.requiredClaimIds,
      source: outcome.source,
      statement: normalizeExplicitSpecStatement(outcome.statement),
    }))
    .toSorted((left, right) => compareUtf8(left.outcomeId, right.outcomeId));
  const proofClaims = decoded.proofClaims
    .map((claim) => ({
      ...claim,
      statement: normalizeExplicitSpecStatement(claim.statement),
    }))
    .toSorted((left, right) => compareUtf8(left.claimId, right.claimId));
  const nonGoals = decoded.nonGoals
    .map((item) => ({
      ...item,
      statement: normalizeExplicitSpecStatement(item.statement),
    }))
    .toSorted(compareSourcedStatements);
  const stopConditions = decoded.stopConditions
    .map((item) => ({
      ...item,
      statement: normalizeExplicitSpecStatement(item.statement),
    }))
    .toSorted(compareSourcedStatements);
  const base = {
    acceptedOutcomes,
    baseDigest: decoded.baseDigest,
    baseIdentity: decoded.baseIdentity,
    baseObservation:
      decoded.baseObservation ?? makeWorkspaceStructuralObservationReceipt(),
    contractId: `run-contract:${decoded.runId}:v1`,
    nonGoals,
    proofClaims,
    runId: decoded.runId,
    stopConditions,
    targetDigest: decoded.targetDigest,
    targetIdentity: decoded.targetIdentity,
    targetObservation:
      decoded.targetObservation ?? makeWorkspaceStructuralObservationReceipt(),
    version: 1,
  };
  const contractDigest = digestRunContract(base);
  return parseRunContract({ ...base, contractDigest });
}

export function parseRunContract(input: unknown): RunContractV1 {
  const contract = decodeRunContract(input);
  assertStrictlySortedUniqueBy(
    contract.acceptedOutcomes,
    (outcome) => outcome.outcomeId,
    "accepted outcome IDs"
  );
  assertStrictlySortedUniqueBy(
    contract.proofClaims,
    (claim) => claim.claimId,
    "proof claim IDs"
  );
  assertStrictlySortedUniqueBy(
    contract.nonGoals,
    sourcedStatementKey,
    "non-goals"
  );
  assertStrictlySortedUniqueBy(
    contract.stopConditions,
    sourcedStatementKey,
    "stop conditions"
  );
  if (contract.contractId !== `run-contract:${contract.runId}:v1`)
    throw new Error("Run contract ID does not bind the run.");

  for (const outcome of contract.acceptedOutcomes) {
    assertSourceItem(outcome.source, outcome.statement, "acceptanceCriteria");
    if (
      outcome.outcomeId !==
      deriveAcceptedOutcomeId({
        source: outcome.source,
        statement: outcome.statement,
      })
    )
      throw new Error("Accepted outcome ID does not match its payload.");
  }
  for (const claim of contract.proofClaims) {
    assertSourceItem(claim.source, claim.statement, "verificationChecks");
    if (
      claim.claimId !==
      deriveProofClaimId({
        authorityRequirements: claim.authorityRequirements,
        kind: claim.kind,
        requirement: claim.requirement,
        source: claim.source,
        statement: claim.statement,
      })
    )
      throw new Error("Proof claim ID does not match its payload.");
  }
  for (const item of contract.nonGoals)
    assertSourceItem(item.source, item.statement, "nonGoals");
  for (const item of contract.stopConditions)
    assertSourceItem(item.source, item.statement, "stopConditions");

  const claimById = new Map(
    contract.proofClaims.map((claim) => [claim.claimId, claim])
  );
  for (const outcome of contract.acceptedOutcomes) {
    const all = [...outcome.requiredClaimIds, ...outcome.conditionalClaimIds];
    if (new Set(all).size !== all.length)
      throw new Error("Outcome claim references overlap or repeat.");
    for (const claimId of outcome.requiredClaimIds) {
      if (claimById.get(claimId)?.requirement !== "required")
        throw new Error(
          "Outcome required claim reference is dangling or conditional."
        );
    }
    for (const claimId of outcome.conditionalClaimIds) {
      if (claimById.get(claimId)?.requirement !== "conditional")
        throw new Error(
          "Outcome conditional claim reference is dangling or required."
        );
    }
  }

  if (contract.contractDigest !== digestRunContract(contract))
    throw new Error("Run contract digest does not match its payload.");
  return contract;
}

export function makeRunProofResult(
  input: typeof MakeRunProofResultInputSchema.Encoded
): RunProofResultV1 {
  const decoded = decodeMakeRunProofResultInput(input);
  const contract = parseRunContract(decoded.contract);
  const binding = {
    contractDigest: contract.contractDigest,
    contractId: contract.contractId,
    runId: contract.runId,
    sequence: decoded.recordedBy.sequence,
  };
  const results = decodeProofClaimResults(
    decoded.results
      .map((result) => withDerivedEvidenceIds(result, binding))
      .toSorted((left, right) =>
        String(left.claimId).localeCompare(String(right.claimId))
      )
  );
  const supplementalProtocolEvidence = decodeSupplementalProtocolEvidence(
    decoded.supplementalProtocolEvidence
      .map((evidence) =>
        withDerivedEvidenceId(evidence, binding, { scope: "protocol" })
      )
      .toSorted((left, right) =>
        compareUtf8(String(left.evidenceId), String(right.evidenceId))
      )
  );
  const base = {
    aggregate: aggregateRunProofResult(contract, results),
    baseDigest: contract.baseDigest,
    contractDigest: contract.contractDigest,
    contractId: contract.contractId,
    observedTargetDigest: decoded.observedTargetDigest,
    observedTargetObservation:
      decoded.observedTargetObservation ??
      makeWorkspaceStructuralObservationReceipt(),
    recordedBy: decoded.recordedBy,
    results,
    runId: contract.runId,
    supplementalProtocolEvidence,
    targetDigest: contract.targetDigest,
    version: 1,
  };
  return parseRunProofResult(
    { ...base, resultDigest: digestRunProofResult(base) },
    contract
  );
}

export function parseRunProofResult(
  input: unknown,
  expectedContract: RunContractV1
): RunProofResultV1 {
  const result = parseRunProofResultEnvelope(input);
  const contract = parseRunContract(expectedContract);
  if (
    result.runId !== contract.runId ||
    result.contractId !== contract.contractId ||
    result.contractDigest !== contract.contractDigest ||
    result.baseDigest !== contract.baseDigest ||
    result.targetDigest !== contract.targetDigest
  )
    throw new Error("Proof result does not bind the expected contract.");
  validateClaimResults(contract, result.results);
  if (result.aggregate !== aggregateRunProofResult(contract, result.results))
    throw new Error("Stored proof aggregate does not match recomputation.");
  return result;
}

/** Decode the self-authenticating event envelope before replay supplies its contract. */
export function parseRunProofResultEnvelope(input: unknown): RunProofResultV1 {
  const result = decodeRunProofResult(input);
  assertStrictlySortedUniqueBy(
    result.results,
    (entry) => entry.claimId,
    "claim results"
  );
  assertStrictlySortedUniqueBy(
    result.supplementalProtocolEvidence,
    (entry) => entry.evidenceId,
    "supplemental evidence IDs"
  );
  if (result.runId !== result.recordedBy.runId)
    throw new Error("Proof result event binding uses another run.");
  validateEvidenceIds(result);
  if (result.resultDigest !== digestRunProofResult(result))
    throw new Error("Run proof result digest does not match its payload.");
  return result;
}

export function aggregateRunProofResult(
  contract: RunContractV1,
  results: readonly ProofClaimResultV1[]
): RunVerificationAggregate {
  const claimById = new Map(
    contract.proofClaims.map((claim) => [claim.claimId, claim])
  );
  const resultById = new Map(results.map((result) => [result.claimId, result]));
  if (results.some((result) => result.status === "failed"))
    return "verification-failed";
  if (results.some((result) => result.status === "requires-decision"))
    return "awaiting-outcome-decision";
  if (contract.acceptedOutcomes.length === 0) return "completed-unverified";
  if (
    !contract.proofClaims.some(
      (claim) =>
        claim.requirement === "required" && claim.kind !== "artifact-integrity"
    )
  )
    return "completed-unverified";
  if (
    contract.acceptedOutcomes.some(
      (outcome) => outcome.requiredClaimIds.length === 0
    )
  )
    return "completed-unverified";
  for (const claim of contract.proofClaims) {
    const result = resultById.get(claim.claimId);
    if (claim.requirement === "required") {
      if (result?.status !== "passed") return "completed-unverified";
    } else if (
      result?.status !== "passed" &&
      result?.status !== "not-applicable"
    ) {
      return "completed-unverified";
    }
  }
  for (const outcome of contract.acceptedOutcomes) {
    if (
      !outcome.requiredClaimIds.every(
        (claimId) =>
          claimById.get(claimId)?.requirement === "required" &&
          resultById.get(claimId)?.status === "passed"
      )
    )
      return "completed-unverified";
  }
  return "verified";
}

export function workspaceStructuralDigestV1(input: unknown): StructuralDigest {
  const manifest = decodeWorkspaceStructuralManifest(input);
  const chunks: Uint8Array[] = [
    utf8ToBytes("gaia.workspace-structural-digest.v1"),
    Uint8Array.of(0, 1),
    u32be(manifest.entries.length),
  ];
  for (const entry of manifest.entries) {
    if (!entry.path.isWellFormed())
      throw new Error("Structural manifest paths must be well-formed Unicode.");
    const path = utf8ToBytes(entry.path);
    chunks.push(
      Uint8Array.of(1),
      u32be(path.length),
      path,
      u64be(BigInt(entry.sizeBytes)),
      hexToBytes(entry.contentDigest)
    );
  }
  return parseStructuralDigest(bytesToHex(sha256(concatBytes(chunks))));
}

export function sortWorkspaceStructuralManifestEntries(
  entries: typeof WorkspaceStructuralManifestEntriesInputSchema.Encoded
) {
  return decodeWorkspaceStructuralManifestEntriesInput(entries).toSorted(
    (left, right) => compareUtf8(left.path, right.path)
  );
}

export function canonicalV1(domain: string, fields: readonly unknown[]) {
  if (!/^[\u0020-\u007e]+$/u.test(domain))
    throw new Error("Canonical domain separator must be printable ASCII.");
  return concatBytes([
    utf8ToBytes(domain),
    Uint8Array.of(0),
    ...fields.map(encodeCanonicalValue),
  ]);
}

function digestRunContract(input: Record<string, unknown> | RunContractV1) {
  return parseRunContractDigest(
    digestCanonical("gaia.run-contract.v1", [
      withoutKey(input, "contractDigest"),
    ])
  );
}

function digestRunProofResult(
  input: Record<string, unknown> | RunProofResultV1
) {
  return parseRunProofResultDigest(
    digestCanonical("gaia.run-proof-result.v1", [
      withoutKey(input, "resultDigest"),
    ])
  );
}

function withDerivedEvidenceIds(
  result: MakeProofClaimResultV1,
  binding: EvidenceEventBindingV1
) {
  if (result.status !== "passed" && result.status !== "failed") return result;
  const evidence = Array.isArray(result.evidence)
    ? result.evidence.map((entry) =>
        withDerivedEvidenceId(entry, binding, {
          claimId: result.claimId,
          scope: "claim",
        })
      )
    : result.evidence;
  return { ...result, evidence };
}

type EvidenceScopeV1 =
  | { readonly claimId: ProofClaimId; readonly scope: "claim" }
  | { readonly scope: "protocol" };

function withDerivedEvidenceId(
  evidence:
    | MakeClaimEvidenceV1
    | MakeSupplementalProtocolEvidenceV1
    | ClaimEvidenceV1
    | SupplementalProtocolEvidenceV1,
  binding: EvidenceEventBindingV1,
  scope: EvidenceScopeV1
) {
  const withoutId = withoutKey(evidence, "evidenceId");
  const evidenceId = parseProofEvidenceId(
    `proof-evidence:sha256:${digestCanonical("gaia.proof-evidence-id.v1", [
      binding.runId,
      binding.contractId,
      binding.contractDigest,
      binding.sequence,
      scope.scope,
      scope.scope === "claim" ? scope.claimId : "",
      withoutId,
    ])}`
  );
  return { ...evidence, evidenceId };
}

function validateClaimResults(
  contract: RunContractV1,
  results: readonly ProofClaimResultV1[]
) {
  if (
    results.length !== contract.proofClaims.length ||
    results.some(
      (result, index) => result.claimId !== contract.proofClaims[index]?.claimId
    )
  )
    throw new Error(
      "Run proof requires exactly one result for every contract proof claim."
    );
  const claimById = new Map(
    contract.proofClaims.map((claim) => [claim.claimId, claim])
  );
  for (const result of results) {
    const claim = claimById.get(result.claimId);
    if (claim === undefined)
      throw new Error("Proof result references an unknown claim.");
    if (
      result.status === "not-applicable" &&
      claim.requirement !== "conditional"
    )
      throw new Error("A required proof claim cannot be not-applicable.");
    if (
      result.status === "requires-decision" &&
      claim.kind !== "human-judgment"
    )
      throw new Error(
        "Only human-judgment claims can require a human decision."
      );
    if (result.status === "passed" && claim.kind === "human-judgment")
      throw new Error("A human-judgment claim cannot be automatically passed.");
    if (result.status === "passed" || result.status === "failed") {
      for (const evidence of result.evidence) {
        if (evidence.kind !== claim.kind)
          throw new Error(
            "Evidence kind is incompatible with its proof claim."
          );
      }
    }
  }
}

function validateEvidenceIds(result: RunProofResultV1) {
  const binding = {
    contractDigest: result.contractDigest,
    contractId: result.contractId,
    runId: result.runId,
    sequence: result.recordedBy.sequence,
  };
  const evidence: ReadonlyArray<{
    readonly item: ClaimEvidenceV1 | SupplementalProtocolEvidenceV1;
    readonly scope: EvidenceScopeV1;
  }> = [
    ...result.results.flatMap((entry) =>
      entry.status === "passed" || entry.status === "failed"
        ? entry.evidence.map((item) => ({
            item,
            scope: { claimId: entry.claimId, scope: "claim" as const },
          }))
        : []
    ),
    ...result.supplementalProtocolEvidence.map((item) => ({
      item,
      scope: { scope: "protocol" as const },
    })),
  ];
  const ids = new Set<string>();
  const tuples = new Set<string>();
  for (const { item, scope } of evidence) {
    const expected = withDerivedEvidenceId(item, binding, scope).evidenceId;
    if (item.evidenceId !== expected)
      throw new Error(
        scope.scope === "claim"
          ? "Proof evidence ID does not match its claim-bound tuple."
          : "Proof evidence ID does not match its protocol-bound tuple."
      );
    const tuple = canonicalKey({
      ...(scope.scope === "claim" ? { claimId: scope.claimId } : {}),
      evidence: withoutKey(item, "evidenceId"),
      scope: scope.scope,
    });
    if (ids.has(item.evidenceId))
      throw new Error("Duplicate proof evidence ID.");
    if (tuples.has(tuple)) throw new Error("Duplicate proof evidence tuple.");
    ids.add(item.evidenceId);
    tuples.add(tuple);
  }
}

function assertSourceItem(
  source: ExplicitSpecSourceV1,
  statement: string,
  section: ExplicitSpecSection
) {
  if (source.section !== section)
    throw new Error(`Explicit source role must be ${section}.`);
  if (
    source.itemDigest !== deriveExplicitSpecItemDigest({ section, statement })
  )
    throw new Error(
      "Explicit source item digest does not match its role and prose."
    );
}

function sourceCanonical(source: ExplicitSpecSourceV1) {
  return {
    itemDigest: String(source.itemDigest),
    kind: String(source.kind),
    section: String(source.section),
    specDigest: String(source.specDigest),
    version: Number(source.version),
  };
}

function compareSourcedStatements(
  left: SourcedNonGoalV1 | SourcedStopConditionV1,
  right: SourcedNonGoalV1 | SourcedStopConditionV1
) {
  return compareUtf8(sourcedStatementKey(left), sourcedStatementKey(right));
}

function sourcedStatementKey(value: SourcedNonGoalV1 | SourcedStopConditionV1) {
  return canonicalKey({
    source: value.source,
    statement: String(value.statement),
  });
}

function assertStrictlySortedUniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string
) {
  for (let index = 1; index < values.length; index += 1) {
    if (key(values[index - 1]!) >= key(values[index]!))
      throw new Error(`Expected canonical sorted unique ${label}.`);
  }
}

function isStrictlySortedUniqueStrings(values: readonly string[]) {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! < value
  );
}

function compareUtf8(left: string, right: string) {
  if (!left.isWellFormed() || !right.isWellFormed())
    throw new Error("Canonical strings must be well-formed Unicode.");
  const a = utf8ToBytes(left);
  const b = utf8ToBytes(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function digestCanonical(domain: string, fields: readonly unknown[]) {
  return bytesToHex(sha256(canonicalV1(domain, fields)));
}

function encodeCanonicalValue(value: unknown): Uint8Array {
  if (value === null) return Uint8Array.of(0);
  if (typeof value === "string") {
    if (!value.isWellFormed())
      throw new Error("Canonical strings must be well-formed Unicode.");
    return taggedBytes(1, utf8ToBytes(value));
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Canonical integers must be safe integers.");
    return taggedBytes(2, utf8ToBytes(String(value)));
  }
  if (typeof value === "boolean") return Uint8Array.of(3, value ? 1 : 0);
  if (Array.isArray(value)) {
    return concatBytes([
      Uint8Array.of(4),
      u32be(value.length),
      ...value.map(encodeCanonicalValue),
    ]);
  }
  if (typeof value !== "object" || value === null)
    throw new Error("Unsupported canonical value.");
  const entries = Object.entries(value).filter(
    (entry): entry is [string, unknown] => entry[1] !== undefined
  );
  for (const [key] of entries) {
    if (!key.isWellFormed())
      throw new Error("Canonical strings must be well-formed Unicode.");
  }
  const sortedEntries = entries.toSorted(([left], [right]) =>
    compareUtf8(left, right)
  );
  return concatBytes([
    Uint8Array.of(5),
    u32be(sortedEntries.length),
    ...sortedEntries.flatMap(([key, entry]) => [
      taggedBytes(1, utf8ToBytes(key)),
      encodeCanonicalValue(entry),
    ]),
  ]);
}

function taggedBytes(tag: number, bytes: Uint8Array) {
  return concatBytes([Uint8Array.of(tag), u32be(bytes.length), bytes]);
}

function withoutKey(input: unknown, key: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("Canonical self-exclusion requires an object.");
  return Object.fromEntries(
    Object.entries(input).filter(([name]) => name !== key)
  );
}

function canonicalKey(input: unknown) {
  return bytesToHex(canonicalV1("gaia.canonical-key.v1", [input]));
}

function concatBytes(chunks: readonly Uint8Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function u32be(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new Error("Value is outside U32 range.");
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function u64be(value: bigint) {
  if (value < 0n || value > maxUint64)
    throw new Error("Value is outside U64 range.");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, false);
  return bytes;
}

function hexToBytes(input: ContentDigest) {
  if (!sha256Pattern.test(input))
    throw new Error("Expected lower-case SHA-256.");
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(input.slice(index * 2, index * 2 + 2), 16)
  );
}

/** Parse an external structural digest. */
export { parseStructuralDigest, parseSpecDigest, parseContentDigest };
const parseContentDigest = Schema.decodeUnknownSync(ContentDigestSchema);
