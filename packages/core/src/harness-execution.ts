import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import {
  HarnessCapabilities,
  HarnessProviderDescriptor,
} from "./harness-session.js";
import {
  ModelContextDigestSchema,
  ModelInvocationDigestSchema,
  ModelManifestArtifactRefV1,
  ModelWorkspaceBindingV1,
} from "./model-invocation.js";
import {
  RunContractDigestSchema,
  StructuralDigestSchema,
  canonicalV1,
} from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const BoundedIdentifierSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(200))
);
const LowerSha256Schema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-f0-9]{64}$/u, { identifier: "LowerSha256" })
  )
);

/** Fixed production harness profile supported by issue-delivery create calls. */
export const HarnessProfileIdSchema = Schema.Literal("codexAppServer").pipe(
  Schema.brand("HarnessProfileId")
);

/** A parsed stable harness profile identifier. */
export type HarnessProfileId = typeof HarnessProfileIdSchema.Type;

/** Parse a public harness profile identifier at a boundary. */
export const parseHarnessProfileId = Schema.decodeUnknownSync(
  HarnessProfileIdSchema
);

/** The only production issue-delivery harness profile in this slice. */
export const codexAppServerHarnessProfileId =
  parseHarnessProfileId("codexAppServer");

/** Explicit profile selection accepted by the strict create-run contract. */
export class HarnessExecutionSelection extends Schema.Class<HarnessExecutionSelection>(
  "HarnessExecutionSelection"
)(
  {
    harnessProfileId: HarnessProfileIdSchema,
  },
  strict
) {}

/** Fixed selection used by current dashboard and CLI create callers. */
export const codexAppServerExecutionSelection = HarnessExecutionSelection.make({
  harnessProfileId: codexAppServerHarnessProfileId,
});

/** Safe, exact identity of the clean Gaia source used to accept a new run. */
export class GaiaRuntimeSourceIdentityV1 extends Schema.Class<GaiaRuntimeSourceIdentityV1>(
  "GaiaRuntimeSourceIdentityV1"
)(
  {
    repositoryIdentity: BoundedIdentifierSchema,
    revision: Schema.String.pipe(
      Schema.check(
        Schema.isPattern(/^[a-f0-9]{40}$/u, { identifier: "GitCommitSha" })
      )
    ),
    sourceState: Schema.Literal("clean"),
  },
  strict
) {}

/** Requested authority that must match the effective provider result. */
export class HarnessEnvironmentAuthorityV1 extends Schema.Class<HarnessEnvironmentAuthorityV1>(
  "HarnessEnvironmentAuthorityV1"
)(
  {
    approvalPolicy: Schema.Literal("on-request"),
    ephemeral: Schema.Literal(false),
    sandbox: Schema.Literal("workspace-write"),
    workspaceBindingDigest: LowerSha256Schema,
  },
  strict
) {}

/** Secret-free Codex model selection resolved before run acceptance. */
export class HarnessEnvironmentModelV1 extends Schema.Class<HarnessEnvironmentModelV1>(
  "HarnessEnvironmentModelV1"
)(
  {
    id: BoundedIdentifierSchema,
    provider: BoundedIdentifierSchema,
    reasoningEffort: BoundedIdentifierSchema,
  },
  strict
) {}

/** Versioned Gaia adapter/tool contract recorded without provider internals. */
export class HarnessEnvironmentAdapterV1 extends Schema.Class<HarnessEnvironmentAdapterV1>(
  "HarnessEnvironmentAdapterV1"
)(
  {
    contractDigest: LowerSha256Schema,
    contractId: BoundedIdentifierSchema,
    contractVersion: BoundedIdentifierSchema,
    providerNativeToolInventoryObservation: Schema.Literal("notExposed"),
    toolContractDigest: LowerSha256Schema,
  },
  strict
) {}

/** Accepted, secret-free production environment assignment. */
export class HarnessEnvironmentAssignmentV1 extends Schema.Class<HarnessEnvironmentAssignmentV1>(
  "HarnessEnvironmentAssignmentV1"
)(
  {
    adapter: HarnessEnvironmentAdapterV1,
    authority: HarnessEnvironmentAuthorityV1,
    effectDependencyEpoch: Schema.Literal("4.0.0-beta.93"),
    hostClass: Schema.Literal("localGaiaServer"),
    interfaceClass: Schema.Literal("codexAppServerStdio"),
    model: HarnessEnvironmentModelV1,
    runtimeSource: GaiaRuntimeSourceIdentityV1,
    version: Schema.Literal(1),
  },
  strict
) {}

/** Immutable safe execution assignment persisted with an accepted run. */
export class ResolvedHarnessExecution extends Schema.Class<ResolvedHarnessExecution>(
  "ResolvedHarnessExecution"
)(
  {
    capabilities: HarnessCapabilities,
    environmentAssignment: Schema.optionalKey(HarnessEnvironmentAssignmentV1),
    executionMode: Schema.Literal("local"),
    harnessProfileId: HarnessProfileIdSchema,
    provider: HarnessProviderDescriptor,
    version: BoundedIdentifierSchema,
  },
  strict
) {}

const CompleteResolvedHarnessExecution = Schema.Struct({
  ...ResolvedHarnessExecution.fields,
  environmentAssignment: HarnessEnvironmentAssignmentV1,
});

/** Safe effective values observed only after a checked start/resume result. */
export class HarnessLaunchObservationV1 extends Schema.Class<HarnessLaunchObservationV1>(
  "HarnessLaunchObservationV1"
)(
  {
    approvalPolicy: Schema.Literal("on-request"),
    cwdMatchesWorkspaceBinding: Schema.Literal(true),
    model: BoundedIdentifierSchema,
    modelProvider: BoundedIdentifierSchema,
    reasoningEffort: BoundedIdentifierSchema,
    sandbox: Schema.Literal("workspace-write"),
    source: Schema.Literal("threadRuntimeResult"),
  },
  strict
) {}

/** Run-contract identities referenced by one worker environment receipt. */
export class HarnessEnvironmentRunContractRefV1 extends Schema.Class<HarnessEnvironmentRunContractRefV1>(
  "HarnessEnvironmentRunContractRefV1"
)(
  {
    baseDigest: StructuralDigestSchema,
    contractDigest: RunContractDigestSchema,
    semanticDigest: LowerSha256Schema,
    targetDigest: StructuralDigestSchema,
  },
  strict
) {}

/** GAIA-146-owned manifest evidence referenced without a second hierarchy. */
export class HarnessEnvironmentModelInvocationRefV1 extends Schema.Class<HarnessEnvironmentModelInvocationRefV1>(
  "HarnessEnvironmentModelInvocationRefV1"
)(
  {
    adapterSemanticDigest: LowerSha256Schema,
    contextContentDigest: LowerSha256Schema,
    contextDigest: ModelContextDigestSchema,
    contextRef: ModelManifestArtifactRefV1,
    invocationDigest: ModelInvocationDigestSchema,
    invocationSemanticDigest: LowerSha256Schema,
    invocationRef: ModelManifestArtifactRefV1,
    outputContractId: BoundedIdentifierSchema,
    outputContractVersion: Schema.Number.pipe(Schema.check(Schema.isInt())),
    renderedInputDigest: LowerSha256Schema,
    workspaceBinding: ModelWorkspaceBindingV1,
  },
  strict
) {}

const HarnessEnvironmentReceiptContentV1 = Schema.Struct({
  modelInvocation: HarnessEnvironmentModelInvocationRefV1,
  observation: HarnessLaunchObservationV1,
  recordedAt: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(64))),
  resolvedExecution: CompleteResolvedHarnessExecution,
  runContract: HarnessEnvironmentRunContractRefV1,
  runId: RunIdSchema,
  runProfileDigest: LowerSha256Schema,
  skillManifestDigest: LowerSha256Schema,
  version: Schema.Literal(1),
  workerPlanDigest: LowerSha256Schema,
});

/** Complete encoded environment receipt referenced only by WORKER_COMPLETED. */
export class HarnessEnvironmentReceiptV1 extends Schema.Class<HarnessEnvironmentReceiptV1>(
  "HarnessEnvironmentReceiptV1"
)(
  {
    ...HarnessEnvironmentReceiptContentV1.fields,
    receiptDigest: LowerSha256Schema,
    structuralDigest: StructuralDigestSchema,
  },
  strict
) {}

/** Content-addressed, run-relative reference persisted in the authority event. */
export class HarnessEnvironmentReceiptArtifactRefV1 extends Schema.Class<HarnessEnvironmentReceiptArtifactRefV1>(
  "HarnessEnvironmentReceiptArtifactRefV1"
)(
  {
    byteLength: Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 1, maximum: 262_144 })
      )
    ),
    path: Schema.String.pipe(
      Schema.check(
        Schema.isPattern(/^harness-environment\/receipt-[a-f0-9]{64}\.json$/u, {
          identifier: "HarnessEnvironmentReceiptArtifactPath",
        })
      )
    ),
    receiptDigest: LowerSha256Schema,
    runId: RunIdSchema,
    structuralDigest: StructuralDigestSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

/** Safe limitation labels exposed by the public comparison projection. */
export const WorkerEnvironmentEpochLimitationSchema = Schema.Literals([
  "acceptedEnvironmentAssignmentMissing",
  "authoritativeReceiptInvalid",
  "authoritativeReceiptMissing",
  "providerNativeToolInventoryNotExposed",
  "providerNativeToolInventoryRequired",
] as const);

const WorkerEnvironmentEpochLimitationsSchema = Schema.Array(
  WorkerEnvironmentEpochLimitationSchema
).pipe(Schema.check(Schema.isMaxLength(8)));

class MissingWorkerEnvironmentEpochDto extends Schema.Class<MissingWorkerEnvironmentEpochDto>(
  "MissingWorkerEnvironmentEpochDto"
)(
  {
    limitations: WorkerEnvironmentEpochLimitationsSchema,
    state: Schema.Literal("missing"),
    version: Schema.Literal(1),
  },
  strict
) {}
class IncompleteWorkerEnvironmentEpochDto extends Schema.Class<IncompleteWorkerEnvironmentEpochDto>(
  "IncompleteWorkerEnvironmentEpochDto"
)(
  {
    limitations: WorkerEnvironmentEpochLimitationsSchema,
    state: Schema.Literal("incomplete"),
    version: Schema.Literal(1),
  },
  strict
) {}
class NonComparableWorkerEnvironmentEpochDto extends Schema.Class<NonComparableWorkerEnvironmentEpochDto>(
  "NonComparableWorkerEnvironmentEpochDto"
)(
  {
    limitations: WorkerEnvironmentEpochLimitationsSchema,
    state: Schema.Literal("nonComparable"),
    version: Schema.Literal(1),
  },
  strict
) {}
class CompleteComparableWorkerEnvironmentEpochDto extends Schema.Class<CompleteComparableWorkerEnvironmentEpochDto>(
  "CompleteComparableWorkerEnvironmentEpochDto"
)(
  {
    limitations: WorkerEnvironmentEpochLimitationsSchema,
    state: Schema.Literal("completeComparable"),
    structuralDigest: StructuralDigestSchema,
    version: Schema.Literal(1),
  },
  strict
) {}

/** Bounded public comparison state derived only from authoritative evidence. */
export const WorkerEnvironmentEpochComparisonDto = Schema.Union([
  MissingWorkerEnvironmentEpochDto,
  IncompleteWorkerEnvironmentEpochDto,
  NonComparableWorkerEnvironmentEpochDto,
  CompleteComparableWorkerEnvironmentEpochDto,
]);

/** Why two worker environment projections did or did not compare equally. */
export const WorkerEnvironmentEpochComparisonReasonSchema = Schema.Literals([
  "differentStructuralDigest",
  "incompleteEvidence",
  "matchingCompleteStructuralDigest",
  "missingEvidence",
  "nonComparableEvidence",
] as const);
export type WorkerEnvironmentEpochComparisonReason =
  typeof WorkerEnvironmentEpochComparisonReasonSchema.Type;
const WorkerEnvironmentEpochComparisonResultSchema = Schema.Struct({
  equivalent: Schema.Boolean,
  reason: WorkerEnvironmentEpochComparisonReasonSchema,
});
type WorkerEnvironmentEpochComparisonResult =
  typeof WorkerEnvironmentEpochComparisonResultSchema.Type;

/** Compare only complete comparable receipt digests; every absence fails closed. */
export function compareWorkerEnvironmentEpochs(
  left: typeof WorkerEnvironmentEpochComparisonDto.Type | undefined,
  right: typeof WorkerEnvironmentEpochComparisonDto.Type | undefined
): WorkerEnvironmentEpochComparisonResult {
  if (left === undefined || right === undefined)
    return { equivalent: false, reason: "missingEvidence" };
  if (left.state === "missing" || right.state === "missing")
    return { equivalent: false, reason: "missingEvidence" };
  if (left.state === "incomplete" || right.state === "incomplete")
    return { equivalent: false, reason: "incompleteEvidence" };
  if (left.state === "nonComparable" || right.state === "nonComparable")
    return { equivalent: false, reason: "nonComparableEvidence" };
  if (left.structuralDigest !== right.structuralDigest)
    return { equivalent: false, reason: "differentStructuralDigest" };
  return { equivalent: true, reason: "matchingCompleteStructuralDigest" };
}

const parseReceiptContent = Schema.decodeUnknownSync(
  HarnessEnvironmentReceiptContentV1
);
const parseReceipt = Schema.decodeUnknownSync(HarnessEnvironmentReceiptV1);
const encodeReceiptContent = Schema.encodeSync(
  HarnessEnvironmentReceiptContentV1
);

/** Build canonical integrity and structural digests for one complete receipt. */
export function makeHarnessEnvironmentReceiptV1(
  input: typeof HarnessEnvironmentReceiptContentV1.Encoded
): HarnessEnvironmentReceiptV1 {
  const content = parseReceiptContent(input);
  assertReceiptBindings(content);
  const structuralDigest = digestCanonical(
    "gaia.harness-environment-structural.v1",
    structuralEvidence(content)
  );
  const receiptDigest = digestCanonical("gaia.harness-environment-receipt.v1", [
    encodeReceiptContent(content),
    structuralDigest,
  ]);
  return parseReceipt({ ...content, receiptDigest, structuralDigest });
}

/** Parse a receipt and reject forged derived digests. */
export function parseHarnessEnvironmentReceiptV1(
  input: unknown
): HarnessEnvironmentReceiptV1 {
  const parsed = parseReceipt(input);
  const expected = makeHarnessEnvironmentReceiptV1(receiptContent(parsed));
  if (
    parsed.receiptDigest !== expected.receiptDigest ||
    parsed.structuralDigest !== expected.structuralDigest
  )
    throw new Error("Harness environment receipt digest mismatch.");
  return parsed;
}

function structuralEvidence(
  content: typeof HarnessEnvironmentReceiptContentV1.Type
) {
  const assignment = content.resolvedExecution.environmentAssignment;
  return [
    {
      capabilities: content.resolvedExecution.capabilities,
      environmentAssignment: assignment,
      executionMode: content.resolvedExecution.executionMode,
      harnessProfileId: content.resolvedExecution.harnessProfileId,
      provider: content.resolvedExecution.provider,
      version: content.resolvedExecution.version,
    },
    content.observation,
    {
      baseDigest: content.runContract.baseDigest,
      semanticDigest: content.runContract.semanticDigest,
      targetDigest: content.runContract.targetDigest,
    },
    {
      adapterSemanticDigest: content.modelInvocation.adapterSemanticDigest,
      contextContentDigest: content.modelInvocation.contextContentDigest,
      invocationSemanticDigest:
        content.modelInvocation.invocationSemanticDigest,
      outputContractId: content.modelInvocation.outputContractId,
      outputContractVersion: content.modelInvocation.outputContractVersion,
      renderedInputDigest: content.modelInvocation.renderedInputDigest,
      workspaceBinding: {
        canonicalRunStoreRootDigest:
          content.modelInvocation.workspaceBinding.canonicalRunStoreRootDigest,
        shape: content.modelInvocation.workspaceBinding.shape,
        version: content.modelInvocation.workspaceBinding.version,
        workspaceRole: content.modelInvocation.workspaceBinding.workspaceRole,
      },
    },
    content.runProfileDigest,
    content.skillManifestDigest,
    content.workerPlanDigest,
  ] as const;
}

function receiptContent(receipt: HarnessEnvironmentReceiptV1) {
  const {
    receiptDigest: _receiptDigest,
    structuralDigest: _structuralDigest,
    ...content
  } = receipt;
  return content;
}

function assertReceiptBindings(
  content: typeof HarnessEnvironmentReceiptContentV1.Type
) {
  const assignment = content.resolvedExecution.environmentAssignment;
  const invocation = content.modelInvocation;
  if (
    invocation.contextRef.runId !== content.runId ||
    invocation.invocationRef.runId !== content.runId ||
    invocation.workspaceBinding.runId !== content.runId ||
    invocation.contextRef.identityDigest !== invocation.contextDigest ||
    invocation.invocationRef.identityDigest !== invocation.invocationDigest ||
    invocation.contextRef.episodeKey !== invocation.invocationRef.episodeKey ||
    assignment.authority.workspaceBindingDigest !==
      digestHarnessEnvironmentContract("gaia.worker-workspace-authority.v1", [
        assignment.runtimeSource.repositoryIdentity,
        invocation.workspaceBinding.shape,
      ]) ||
    assignment.model.id !== content.observation.model ||
    assignment.model.provider !== content.observation.modelProvider ||
    assignment.model.reasoningEffort !== content.observation.reasoningEffort ||
    assignment.authority.approvalPolicy !==
      content.observation.approvalPolicy ||
    assignment.authority.sandbox !== content.observation.sandbox
  )
    throw new Error("Harness environment receipt binding mismatch.");
}

function digestCanonical(domain: string, fields: readonly unknown[]) {
  return bytesToHex(sha256(canonicalV1(domain, fields)));
}

/** Hash one schema-owned worker-environment contract with canonical v1 bytes. */
export function digestHarnessEnvironmentContract(
  domain: string,
  fields: readonly unknown[]
) {
  return Schema.decodeUnknownSync(StructuralDigestSchema)(
    digestCanonical(domain, fields)
  );
}
