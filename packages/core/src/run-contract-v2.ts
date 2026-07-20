import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import {
  AcceptedOutcomeIdSchema,
  canonicalV1,
  ContentDigestSchema,
  ExplicitSpecItemDigestSchema,
  makeWorkspaceStructuralObservationReceipt,
  ProofAuthorityRequirementSchema,
  ProofClaimIdSchema,
  ProofClaimRequirementSchema,
  ProofEvidenceIdSchema,
  RunBaseIdentityV1Schema,
  RunContractDigestSchema,
  RunContractIdV2Schema,
  RunEventSequenceSchema,
  RunRelativeArtifactPathSchema,
  RunProofProjectionV1Schema,
  RunProofResultDigestSchema,
  RunProofResultRecordedByV1,
  RunProofResultV1,
  RunContractV1,
  RunVerificationAggregateSchema,
  RunTargetIdentityV1Schema,
  SpecDigestSchema,
  StructuralDigestSchema,
  WorkspaceStructuralObservationReceiptV1,
  type AcceptedOutcomeId,
  type ProofClaimId,
  parseRunContract,
  parseRunProofResult,
  parseRunProofResultEnvelope,
} from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";
import {
  RunSpec,
  VerificationArtifactClaimSourceV2,
  VerificationBrowserClaimSourceV2,
  VerificationCommandClaimSourceV2,
  VerificationExternalCheckClaimSourceV2,
  VerificationHumanJudgmentClaimSourceV2,
  type VerificationSourceV2,
} from "./spec.js";
import {
  makeVerificationCommandRequestDigest,
  VerificationCommandTerminalStatusSchema,
  VerificationReceiptDigestSchema,
  VerificationRequestDigestSchema,
} from "./verification-command.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const sourceKeySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u))
);

/** Exact source-owned acceptance mapping in a V2 run contract. */
export class AcceptedOutcomeV2 extends Schema.Class<AcceptedOutcomeV2>(
  "AcceptedOutcomeV2"
)(
  {
    conditionalClaimIds: Schema.Array(ProofClaimIdSchema),
    key: sourceKeySchema,
    outcomeId: AcceptedOutcomeIdSchema,
    postPublicationRequiredClaimIds: Schema.Array(ProofClaimIdSchema),
    prePublicationRequiredClaimIds: Schema.Array(ProofClaimIdSchema),
    sourceItemDigest: ExplicitSpecItemDigestSchema,
    statement: Schema.NonEmptyString,
  },
  strict
) {}

const claimFields = {
  authorityRequirements: Schema.Array(ProofAuthorityRequirementSchema),
  claimId: ProofClaimIdSchema,
  key: sourceKeySchema,
  phase: Schema.Literals(["prePublication", "postPublication"] as const),
  requirement: ProofClaimRequirementSchema,
  sourceItemDigest: ExplicitSpecItemDigestSchema,
  statement: Schema.NonEmptyString,
} as const;

/** Exact executable command claim in a V2 run contract. */
export class CommandProofClaimV2 extends Schema.Class<CommandProofClaimV2>(
  "CommandProofClaimV2"
)(
  {
    ...claimFields,
    command: VerificationCommandClaimSourceV2.fields.command,
    kind: Schema.Literal("command"),
  },
  strict
) {}

/** Exact artifact-integrity claim in a V2 run contract. */
export class ArtifactProofClaimV2 extends Schema.Class<ArtifactProofClaimV2>(
  "ArtifactProofClaimV2"
)(
  {
    ...claimFields,
    kind: Schema.Literal("artifact-integrity"),
    selector: VerificationArtifactClaimSourceV2.fields.selector,
  },
  strict
) {}

/** Exact browser claim in a V2 run contract. */
export class BrowserProofClaimV2 extends Schema.Class<BrowserProofClaimV2>(
  "BrowserProofClaimV2"
)(
  {
    ...claimFields,
    kind: Schema.Literal("browser"),
    selector: VerificationBrowserClaimSourceV2.fields.selector,
  },
  strict
) {}

/** Exact external-check claim in a V2 run contract. */
export class ExternalCheckProofClaimV2 extends Schema.Class<ExternalCheckProofClaimV2>(
  "ExternalCheckProofClaimV2"
)(
  {
    ...claimFields,
    kind: Schema.Literal("external-check"),
    selector: VerificationExternalCheckClaimSourceV2.fields.selector,
  },
  strict
) {}

/** Exact explicit-human-decision claim in a V2 run contract. */
export class HumanJudgmentProofClaimV2 extends Schema.Class<HumanJudgmentProofClaimV2>(
  "HumanJudgmentProofClaimV2"
)(
  {
    ...claimFields,
    kind: Schema.Literal("human-judgment"),
    selector: VerificationHumanJudgmentClaimSourceV2.fields.selector,
  },
  strict
) {}

/** Public discriminated V2 proof-claim union. */
export const ProofClaimV2Schema = Schema.Union([
  CommandProofClaimV2,
  ArtifactProofClaimV2,
  BrowserProofClaimV2,
  ExternalCheckProofClaimV2,
  HumanJudgmentProofClaimV2,
]);
export type ProofClaimV2 =
  | CommandProofClaimV2
  | ArtifactProofClaimV2
  | BrowserProofClaimV2
  | ExternalCheckProofClaimV2
  | HumanJudgmentProofClaimV2;

/** Immutable source-owned V2 run contract. */
export class RunContractV2 extends Schema.Class<RunContractV2>("RunContractV2")(
  {
    acceptedOutcomes: Schema.NonEmptyArray(AcceptedOutcomeV2),
    baseDigest: StructuralDigestSchema,
    baseIdentity: RunBaseIdentityV1Schema,
    baseObservation: WorkspaceStructuralObservationReceiptV1,
    contractDigest: RunContractDigestSchema,
    contractId: RunContractIdV2Schema,
    proofClaims: Schema.Array(ProofClaimV2Schema),
    runId: RunIdSchema,
    specDigest: SpecDigestSchema,
    targetDigest: StructuralDigestSchema,
    targetIdentity: RunTargetIdentityV1Schema,
    targetObservation: WorkspaceStructuralObservationReceiptV1,
    version: Schema.Literal(2),
  },
  strict
) {}

const MakeRunContractV2InputSchema = Schema.Struct({
  baseDigest: StructuralDigestSchema,
  baseIdentity: RunBaseIdentityV1Schema,
  baseObservation: Schema.optionalKey(WorkspaceStructuralObservationReceiptV1),
  runId: RunIdSchema,
  spec: RunSpec,
  targetDigest: StructuralDigestSchema,
  targetIdentity: RunTargetIdentityV1Schema,
  targetObservation: Schema.optionalKey(
    WorkspaceStructuralObservationReceiptV1
  ),
});
const decodeMakeRunContractV2Input = Schema.decodeUnknownSync(
  MakeRunContractV2InputSchema,
  { onExcessProperty: "error" }
);
const decodeRunContractV2 = Schema.decodeUnknownSync(RunContractV2);
const parseProofClaimId = Schema.decodeUnknownSync(ProofClaimIdSchema);
const parseProofEvidenceId = Schema.decodeUnknownSync(ProofEvidenceIdSchema);
const parseAcceptedOutcomeId = Schema.decodeUnknownSync(
  AcceptedOutcomeIdSchema
);
const parseRunContractDigest = Schema.decodeUnknownSync(
  RunContractDigestSchema
);
const parseSpecDigest = Schema.decodeUnknownSync(SpecDigestSchema);

/** Derive the immutable V2 contract from a validated structured source spec. */
export function makeRunContractV2(
  input: typeof MakeRunContractV2InputSchema.Encoded
): RunContractV2 {
  const decoded = decodeMakeRunContractV2Input(input);
  const verification = requireVerification(decoded.spec);
  const requirementByKey = claimRequirements(verification);
  const proofClaims = verification.claims.map((claim) => {
    const base = {
      authorityRequirements: authorityRequirements(claim.kind),
      claimId: deriveClaimId(claim),
      key: claim.key,
      phase: claim.phase,
      requirement: requirementByKey.get(claim.key) ?? "required",
      sourceItemDigest: claim.sourceItemDigest,
      statement: claim.statement,
    };
    switch (claim.kind) {
      case "command":
        return CommandProofClaimV2.make({
          ...base,
          command: claim.command,
          kind: claim.kind,
        });
      case "artifact-integrity":
        return ArtifactProofClaimV2.make({
          ...base,
          kind: claim.kind,
          selector: claim.selector,
        });
      case "browser":
        return BrowserProofClaimV2.make({
          ...base,
          kind: claim.kind,
          selector: claim.selector,
        });
      case "external-check":
        return ExternalCheckProofClaimV2.make({
          ...base,
          kind: claim.kind,
          selector: claim.selector,
        });
      case "human-judgment":
        return HumanJudgmentProofClaimV2.make({
          ...base,
          kind: claim.kind,
          selector: claim.selector,
        });
    }
    throw new Error("Unsupported proof claim kind.");
  });
  const claimIdByKey = new Map(
    proofClaims.map((claim) => [claim.key, claim.claimId])
  );
  const acceptedOutcomes = verification.outcomes.map((outcome) =>
    AcceptedOutcomeV2.make({
      conditionalClaimIds: mapClaimIds(outcome.conditionalClaims, claimIdByKey),
      key: outcome.key,
      outcomeId: deriveOutcomeId(outcome),
      postPublicationRequiredClaimIds: mapClaimIds(
        outcome.postPublicationRequiredClaims,
        claimIdByKey
      ),
      prePublicationRequiredClaimIds: mapClaimIds(
        outcome.prePublicationRequiredClaims,
        claimIdByKey
      ),
      sourceItemDigest: outcome.sourceItemDigest,
      statement: outcome.statement,
    })
  );
  const base = {
    acceptedOutcomes,
    baseDigest: decoded.baseDigest,
    baseIdentity: decoded.baseIdentity,
    baseObservation:
      decoded.baseObservation ?? makeWorkspaceStructuralObservationReceipt(),
    contractId: `run-contract:${decoded.runId}:v2`,
    proofClaims,
    runId: decoded.runId,
    specDigest: digestSpec(decoded.spec),
    targetDigest: decoded.targetDigest,
    targetIdentity: decoded.targetIdentity,
    targetObservation:
      decoded.targetObservation ?? makeWorkspaceStructuralObservationReceipt(),
    version: 2 as const,
  };
  return parseRunContractV2({
    ...base,
    contractDigest: digestContract(base),
  });
}

/** Parse and self-authenticate a stored V2 run contract. */
export function parseRunContractV2(input: unknown): RunContractV2 {
  const contract = decodeRunContractV2(input);
  if (contract.contractId !== `run-contract:${contract.runId}:v2`)
    throw new Error("V2 run contract ID does not bind the run.");
  assertUniqueBy(contract.proofClaims, (claim) => claim.claimId, "claim IDs");
  assertUniqueBy(contract.proofClaims, (claim) => claim.key, "claim keys");
  assertUniqueBy(
    contract.acceptedOutcomes,
    (outcome) => outcome.outcomeId,
    "outcome IDs"
  );
  assertUniqueBy(
    contract.acceptedOutcomes,
    (outcome) => outcome.key,
    "outcome keys"
  );
  const claimById = new Map(
    contract.proofClaims.map((claim) => [claim.claimId, claim])
  );
  for (const claim of contract.proofClaims) {
    if (claim.claimId !== deriveClaimId(proofClaimSource(claim)))
      throw new Error("V2 proof claim ID does not match its source payload.");
    if (
      claim.authorityRequirements.length !== 1 ||
      claim.authorityRequirements[0] !== authorityRequirements(claim.kind)[0]
    )
      throw new Error("V2 proof claim authority does not match its kind.");
  }
  const requirementKindsByClaim = new Map<
    ProofClaimId,
    Set<"conditional" | "required">
  >();
  for (const outcome of contract.acceptedOutcomes) {
    const ids = [
      ...outcome.prePublicationRequiredClaimIds,
      ...outcome.postPublicationRequiredClaimIds,
      ...outcome.conditionalClaimIds,
    ];
    if (new Set(ids).size !== ids.length)
      throw new Error("V2 outcome mappings overlap or repeat.");
    for (const id of outcome.prePublicationRequiredClaimIds) {
      if (claimById.get(id)?.phase !== "prePublication")
        throw new Error(
          "V2 pre-publication mapping is dangling or phase-mismatched."
        );
      addContractRequirement(requirementKindsByClaim, id, "required");
    }
    for (const id of outcome.postPublicationRequiredClaimIds) {
      if (claimById.get(id)?.phase !== "postPublication")
        throw new Error(
          "V2 post-publication mapping is dangling or phase-mismatched."
        );
      addContractRequirement(requirementKindsByClaim, id, "required");
    }
    for (const id of outcome.conditionalClaimIds) {
      if (claimById.get(id)?.requirement !== "conditional")
        throw new Error("V2 conditional mapping is dangling or required.");
      addContractRequirement(requirementKindsByClaim, id, "conditional");
    }
    if (
      outcome.outcomeId !==
      deriveOutcomeId({
        conditionalClaims: mapClaimKeys(outcome.conditionalClaimIds, claimById),
        key: outcome.key,
        postPublicationRequiredClaims: mapClaimKeys(
          outcome.postPublicationRequiredClaimIds,
          claimById
        ),
        prePublicationRequiredClaims: mapClaimKeys(
          outcome.prePublicationRequiredClaimIds,
          claimById
        ),
        sourceItemDigest: outcome.sourceItemDigest,
        statement: outcome.statement,
      })
    )
      throw new Error("V2 accepted outcome ID does not match its mappings.");
  }
  for (const claim of contract.proofClaims) {
    const kinds = requirementKindsByClaim.get(claim.claimId);
    if (kinds === undefined)
      throw new Error("V2 run contract contains an unmapped claim.");
    if (kinds.size !== 1 || !kinds.has(claim.requirement))
      throw new Error("V2 claim requirement does not match its mappings.");
  }
  if (contract.contractDigest !== digestContract(contract))
    throw new Error("V2 run contract digest does not match its payload.");
  return contract;
}

const evidenceFields = {
  evidenceId: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^proof-evidence:sha256:[a-f0-9]{64}$/u))
  ),
} as const;

export class CommandClaimEvidenceV2 extends Schema.Class<CommandClaimEvidenceV2>(
  "CommandClaimEvidenceV2"
)(
  {
    ...evidenceFields,
    kind: Schema.Literal("command"),
    receiptDigest: VerificationReceiptDigestSchema,
    requestDigest: VerificationRequestDigestSchema,
    status: VerificationCommandTerminalStatusSchema,
    terminalSequence: RunEventSequenceSchema,
  },
  strict
) {}

export class ArtifactClaimEvidenceV2 extends Schema.Class<ArtifactClaimEvidenceV2>(
  "ArtifactClaimEvidenceV2"
)(
  {
    ...evidenceFields,
    artifacts: Schema.NonEmptyArray(
      Schema.Struct({
        contentDigest: ContentDigestSchema,
        path: RunRelativeArtifactPathSchema,
      })
    ),
    kind: Schema.Literal("artifact-integrity"),
  },
  strict
) {}

export class BrowserClaimEvidenceV2 extends Schema.Class<BrowserClaimEvidenceV2>(
  "BrowserClaimEvidenceV2"
)(
  {
    ...evidenceFields,
    evidenceSelector: sourceKeySchema,
    eventSequence: RunEventSequenceSchema,
    kind: Schema.Literal("browser"),
    targetUrl: Schema.NonEmptyString,
  },
  strict
) {}

export class ExternalCheckClaimEvidenceV2 extends Schema.Class<ExternalCheckClaimEvidenceV2>(
  "ExternalCheckClaimEvidenceV2"
)(
  {
    ...evidenceFields,
    checkName: Schema.NonEmptyString,
    conclusion: Schema.Literal("success"),
    eventSequence: RunEventSequenceSchema,
    headSha: Schema.String.pipe(
      Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
    ),
    kind: Schema.Literal("external-check"),
    provider: Schema.Literal("github"),
    workflow: Schema.NonEmptyString,
  },
  strict
) {}

export class HumanJudgmentClaimEvidenceV2 extends Schema.Class<HumanJudgmentClaimEvidenceV2>(
  "HumanJudgmentClaimEvidenceV2"
)(
  {
    ...evidenceFields,
    decision: Schema.Literals(["approved", "rejected"] as const),
    eventSequence: RunEventSequenceSchema,
    headSha: Schema.String.pipe(
      Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
    ),
    kind: Schema.Literal("human-judgment"),
    source: Schema.Literal("localOperatorPairedReview"),
  },
  strict
) {}

export const ClaimEvidenceV2Schema = Schema.Union([
  CommandClaimEvidenceV2,
  ArtifactClaimEvidenceV2,
  BrowserClaimEvidenceV2,
  ExternalCheckClaimEvidenceV2,
  HumanJudgmentClaimEvidenceV2,
]);
export type ClaimEvidenceV2 = typeof ClaimEvidenceV2Schema.Type;

export class PassedProofClaimResultV2 extends Schema.Class<PassedProofClaimResultV2>(
  "PassedProofClaimResultV2"
)(
  {
    claimId: ProofClaimIdSchema,
    evidence: Schema.NonEmptyArray(ClaimEvidenceV2Schema),
    status: Schema.Literal("passed"),
  },
  strict
) {}
export class FailedProofClaimResultV2 extends Schema.Class<FailedProofClaimResultV2>(
  "FailedProofClaimResultV2"
)(
  {
    claimId: ProofClaimIdSchema,
    evidence: Schema.Array(ClaimEvidenceV2Schema),
    reason: Schema.NonEmptyString,
    status: Schema.Literal("failed"),
  },
  strict
) {}
export class NotRunProofClaimResultV2 extends Schema.Class<NotRunProofClaimResultV2>(
  "NotRunProofClaimResultV2"
)(
  {
    claimId: ProofClaimIdSchema,
    reason: Schema.NonEmptyString,
    status: Schema.Literal("not-run"),
  },
  strict
) {}
export class NotApplicableProofClaimResultV2 extends Schema.Class<NotApplicableProofClaimResultV2>(
  "NotApplicableProofClaimResultV2"
)(
  {
    claimId: ProofClaimIdSchema,
    reason: Schema.NonEmptyString,
    status: Schema.Literal("not-applicable"),
  },
  strict
) {}
export class RequiresDecisionProofClaimResultV2 extends Schema.Class<RequiresDecisionProofClaimResultV2>(
  "RequiresDecisionProofClaimResultV2"
)(
  {
    claimId: ProofClaimIdSchema,
    reason: Schema.NonEmptyString,
    requiredAuthority: Schema.Literal("human"),
    status: Schema.Literal("requires-decision"),
  },
  strict
) {}

export const ProofClaimResultV2Schema = Schema.Union([
  PassedProofClaimResultV2,
  FailedProofClaimResultV2,
  NotRunProofClaimResultV2,
  NotApplicableProofClaimResultV2,
  RequiresDecisionProofClaimResultV2,
]);
export type ProofClaimResultV2 = typeof ProofClaimResultV2Schema.Type;

export class RunProofResultV2 extends Schema.Class<RunProofResultV2>(
  "RunProofResultV2"
)(
  {
    aggregate: RunVerificationAggregateSchema,
    contentAuthoritySequence: RunEventSequenceSchema,
    contractDigest: RunContractDigestSchema,
    contractId: RunContractIdV2Schema,
    observedTargetDigest: StructuralDigestSchema,
    observedTargetObservation: WorkspaceStructuralObservationReceiptV1,
    recordedBy: RunProofResultRecordedByV1,
    resultDigest: RunProofResultDigestSchema,
    results: Schema.Array(ProofClaimResultV2Schema),
    runId: RunIdSchema,
    targetDigest: StructuralDigestSchema,
    version: Schema.Literal(2),
  },
  strict
) {}

const MakeRunProofResultV2Input = Schema.Struct({
  contentAuthoritySequence: RunEventSequenceSchema,
  contract: RunContractV2,
  observedTargetDigest: StructuralDigestSchema,
  observedTargetObservation: Schema.optionalKey(
    WorkspaceStructuralObservationReceiptV1
  ),
  recordedBy: RunProofResultRecordedByV1,
  results: Schema.Array(ProofClaimResultV2Schema),
});
const decodeMakeRunProofResultV2Input = Schema.decodeUnknownSync(
  MakeRunProofResultV2Input
);
const decodeRunProofResultV2 = Schema.decodeUnknownSync(RunProofResultV2);
const parseResultDigest = Schema.decodeUnknownSync(RunProofResultDigestSchema);

export function makeRunProofResultV2(
  input: typeof MakeRunProofResultV2Input.Encoded
): RunProofResultV2 {
  const decoded = decodeMakeRunProofResultV2Input(input);
  const contract = parseRunContractV2(decoded.contract);
  const results = [...decoded.results];
  validateV2ClaimResults(contract, results);
  const base = {
    aggregate: aggregateV2(contract, results),
    contentAuthoritySequence: decoded.contentAuthoritySequence,
    contractDigest: contract.contractDigest,
    contractId: contract.contractId,
    observedTargetDigest: decoded.observedTargetDigest,
    observedTargetObservation:
      decoded.observedTargetObservation ??
      makeWorkspaceStructuralObservationReceipt(),
    recordedBy: decoded.recordedBy,
    results,
    runId: contract.runId,
    targetDigest: contract.targetDigest,
    version: 2 as const,
  };
  return parseRunProofResultV2(
    { ...base, resultDigest: digestResult(base) },
    contract
  );
}

export function parseRunProofResultV2(
  input: unknown,
  expectedContract: RunContractV2
): RunProofResultV2 {
  const result = parseRunProofResultV2Envelope(input);
  const contract = parseRunContractV2(expectedContract);
  if (
    result.runId !== contract.runId ||
    result.contractId !== contract.contractId ||
    result.contractDigest !== contract.contractDigest ||
    result.targetDigest !== contract.targetDigest
  )
    throw new Error("V2 proof result is rebound from its immutable contract.");
  validateV2ClaimResults(contract, result.results);
  if (result.aggregate !== aggregateV2(contract, result.results))
    throw new Error("V2 proof aggregate does not match its claim results.");
  return result;
}

export function parseRunProofResultV2Envelope(input: unknown) {
  const result = decodeRunProofResultV2(input);
  if (
    result.recordedBy.runId !== result.runId ||
    result.resultDigest !== digestResult(result)
  )
    throw new Error("V2 proof result identity or digest is invalid.");
  return result;
}

export class ContractRunProofProjectionV2 extends Schema.Class<ContractRunProofProjectionV2>(
  "ContractRunProofProjectionV2"
)(
  {
    aggregate: RunVerificationAggregateSchema,
    contract: RunContractV2,
    kind: Schema.Literal("contract"),
    latestResult: Schema.optionalKey(RunProofResultV2),
    version: Schema.Literal(2),
  },
  strict
) {}

export const RunContractSchema = Schema.Union([RunContractV1, RunContractV2]);
export type RunContract = typeof RunContractSchema.Type;
export const RunProofResultSchema = Schema.Union([
  RunProofResultV1,
  RunProofResultV2,
]);
export type RunProofResult = typeof RunProofResultSchema.Type;
export const RunProofProjectionSchema = Schema.Union([
  RunProofProjectionV1Schema,
  ContractRunProofProjectionV2,
]);
export const encodeAnyRunContractJson = Schema.encodeSync(
  Schema.toCodecJson(RunContractSchema)
);
export const encodeAnyRunProofResultJson = Schema.encodeSync(
  Schema.toCodecJson(RunProofResultSchema)
);

export function parseAnyRunContract(input: unknown): RunContract {
  const version = readVersion(input);
  return version === 2 ? parseRunContractV2(input) : parseRunContract(input);
}

export function parseAnyRunProofResultEnvelope(input: unknown): RunProofResult {
  const version = readVersion(input);
  return version === 2
    ? parseRunProofResultV2Envelope(input)
    : parseRunProofResultEnvelope(input);
}

export function parseAnyRunProofResult(
  input: unknown,
  contract: RunContract
): RunProofResult {
  if (contract.version === 2) return parseRunProofResultV2(input, contract);
  return parseRunProofResult(input, contract);
}

/** Exact phase gate used by publication and final merge-readiness consumers. */
export function isRunProofPhaseSatisfiedV2(
  contractInput: RunContractV2,
  resultInput: RunProofResultV2,
  phase: "prePublication" | "postPublication"
) {
  const contract = parseRunContractV2(contractInput);
  const result = parseRunProofResultV2(resultInput, contract);
  const resultById = new Map(
    result.results.map((claimResult) => [claimResult.claimId, claimResult])
  );
  const required = contract.acceptedOutcomes.flatMap((outcome) =>
    phase === "prePublication"
      ? outcome.prePublicationRequiredClaimIds
      : outcome.postPublicationRequiredClaimIds
  );
  return required.every(
    (claimId) => resultById.get(claimId)?.status === "passed"
  );
}

function validateV2ClaimResults(
  contract: RunContractV2,
  results: readonly ProofClaimResultV2[]
) {
  if (results.length !== contract.proofClaims.length)
    throw new Error("V2 proof requires exactly one result per claim.");
  const resultById = new Map(results.map((result) => [result.claimId, result]));
  if (resultById.size !== results.length)
    throw new Error("V2 proof contains duplicate claim results.");
  const evidenceIds = new Set<string>();
  for (const claim of contract.proofClaims) {
    const result = resultById.get(claim.claimId);
    if (result === undefined)
      throw new Error("V2 proof is missing a contract claim result.");
    if (result.status === "passed" || result.status === "failed") {
      for (const evidence of result.evidence) {
        if (evidenceIds.has(evidence.evidenceId))
          throw new Error("V2 proof contains rebound or duplicate evidence.");
        evidenceIds.add(evidence.evidenceId);
        if (evidence.kind !== claim.kind)
          throw new Error("V2 proof evidence kind does not match its claim.");
        if (!evidenceMatchesClaim(evidence, claim))
          throw new Error(
            "V2 proof evidence does not match its exact selector."
          );
        if (evidence.evidenceId !== expectedEvidenceId(evidence, claim.claimId))
          throw new Error("V2 proof evidence ID is stale or rebound.");
      }
    }
    if (
      claim.kind === "command" &&
      result.status === "passed" &&
      result.evidence.some(
        (evidence) =>
          evidence.kind !== "command" || evidence.status !== "succeeded"
      )
    )
      throw new Error("A passed V2 command claim requires succeeded evidence.");
    if (
      result.status === "not-applicable" &&
      claim.requirement !== "conditional"
    )
      throw new Error("Only conditional V2 claims may be not applicable.");
    if (
      result.status === "requires-decision" &&
      claim.kind !== "human-judgment"
    )
      throw new Error("Only human V2 claims may require a decision.");
  }
}

/** Derive one exact V2 evidence identity from its authoritative tuple. */
export function makeProofEvidenceIdV2(
  kind: "artifact" | "browser" | "command" | "external-check" | "human",
  fields: readonly unknown[]
) {
  return parseProofEvidenceId(
    `proof-evidence:sha256:${digest(`gaia.proof-evidence.${kind}.v2`, fields)}`
  );
}

function expectedEvidenceId(evidence: ClaimEvidenceV2, claimId: ProofClaimId) {
  switch (evidence.kind) {
    case "command":
      return makeProofEvidenceIdV2("command", [evidence.receiptDigest]);
    case "artifact-integrity":
      return makeProofEvidenceIdV2("artifact", [claimId, evidence.artifacts]);
    case "browser":
      return makeProofEvidenceIdV2("browser", [
        claimId,
        evidence.eventSequence,
      ]);
    case "external-check":
      return makeProofEvidenceIdV2("external-check", [
        claimId,
        evidence.eventSequence,
      ]);
    case "human-judgment":
      return makeProofEvidenceIdV2("human", [claimId, evidence.eventSequence]);
  }
}

function evidenceMatchesClaim(evidence: ClaimEvidenceV2, claim: ProofClaimV2) {
  if (evidence.kind !== claim.kind) return false;
  switch (claim.kind) {
    case "command":
      return (
        evidence.kind === "command" &&
        evidence.requestDigest ===
          makeVerificationCommandRequestDigest(claim.command)
      );
    case "artifact-integrity":
      return (
        evidence.kind === "artifact-integrity" &&
        evidence.artifacts.length === claim.selector.paths.length &&
        evidence.artifacts.every(
          (artifact, index) => artifact.path === claim.selector.paths[index]
        )
      );
    case "browser":
      return (
        evidence.kind === "browser" &&
        evidence.evidenceSelector === claim.selector.evidenceSelector &&
        evidence.targetUrl === claim.selector.targetUrl
      );
    case "external-check":
      return (
        evidence.kind === "external-check" &&
        evidence.provider === claim.selector.provider &&
        evidence.workflow === claim.selector.workflow &&
        evidence.checkName === claim.selector.checkName &&
        evidence.conclusion === claim.selector.conclusion
      );
    case "human-judgment":
      return (
        evidence.kind === "human-judgment" &&
        evidence.source === claim.selector.source &&
        evidence.decision === claim.selector.decision
      );
  }
}

function aggregateV2(
  contract: RunContractV2,
  results: readonly ProofClaimResultV2[]
) {
  const resultById = new Map(results.map((result) => [result.claimId, result]));
  const mapped = contract.acceptedOutcomes
    .flatMap((outcome) => [
      ...outcome.prePublicationRequiredClaimIds,
      ...outcome.postPublicationRequiredClaimIds,
      ...outcome.conditionalClaimIds,
    ])
    .map((claimId) => resultById.get(claimId)!);
  if (mapped.some((result) => result.status === "failed"))
    return "verification-failed" as const;
  if (mapped.some((result) => result.status === "requires-decision"))
    return "awaiting-outcome-decision" as const;
  if (
    mapped.every(
      (result) =>
        result.status === "passed" || result.status === "not-applicable"
    )
  )
    return "verified" as const;
  return "completed-unverified" as const;
}

function digestResult(input: object) {
  return parseResultDigest(
    digest("gaia.run-proof-result.v2", [withoutKey(input, "resultDigest")])
  );
}

function readVersion(input: unknown) {
  if (typeof input !== "object" || input === null || !("version" in input))
    throw new Error("Versioned proof input is missing its version.");
  return Reflect.get(input, "version");
}

function requireVerification(spec: RunSpec): VerificationSourceV2 {
  if (spec.verification === undefined)
    throw new Error(
      "RunContractV2 requires verification.version 2 source data."
    );
  return spec.verification;
}

function claimRequirements(verification: VerificationSourceV2) {
  const output = new Map<string, "required" | "conditional">();
  for (const outcome of verification.outcomes) {
    for (const key of [
      ...outcome.prePublicationRequiredClaims,
      ...outcome.postPublicationRequiredClaims,
    ])
      output.set(key, "required");
    for (const key of outcome.conditionalClaims) output.set(key, "conditional");
  }
  return output;
}

function addContractRequirement(
  requirements: Map<ProofClaimId, Set<"conditional" | "required">>,
  claimId: ProofClaimId,
  kind: "conditional" | "required"
) {
  const existing = requirements.get(claimId);
  if (existing === undefined) requirements.set(claimId, new Set([kind]));
  else existing.add(kind);
}

function assertUniqueBy<T>(
  entries: readonly T[],
  key: (entry: T) => string,
  label: string
) {
  if (new Set(entries.map(key)).size !== entries.length)
    throw new Error(`V2 run contract contains duplicate ${label}.`);
}

function authorityRequirements(kind: ProofClaimV2["kind"]) {
  switch (kind) {
    case "command":
    case "artifact-integrity":
      return ["gaia-runtime"] as const;
    case "browser":
      return ["browser"] as const;
    case "external-check":
      return ["github"] as const;
    case "human-judgment":
      return ["human"] as const;
  }
}

function deriveClaimId(
  claim: VerificationSourceV2["claims"][number]
): ProofClaimId {
  return parseProofClaimId(
    `proof-claim:sha256:${digest("gaia.proof-claim.v2", [claim])}`
  );
}

function deriveOutcomeId(
  outcome: VerificationSourceV2["outcomes"][number]
): AcceptedOutcomeId {
  return parseAcceptedOutcomeId(
    `accepted-outcome:sha256:${digest("gaia.accepted-outcome.v2", [outcome])}`
  );
}

function mapClaimIds(
  keys: readonly string[],
  claimIdByKey: ReadonlyMap<string, ProofClaimId>
) {
  return keys.map((key) => {
    const claimId = claimIdByKey.get(key);
    if (claimId === undefined) throw new Error("V2 claim mapping is dangling.");
    return claimId;
  });
}

function mapClaimKeys(
  claimIds: readonly ProofClaimId[],
  claimById: ReadonlyMap<ProofClaimId, ProofClaimV2>
) {
  return claimIds.map((claimId) => {
    const claim = claimById.get(claimId);
    if (claim === undefined) throw new Error("V2 claim mapping is dangling.");
    return claim.key;
  });
}

function proofClaimSource(
  claim: ProofClaimV2
): VerificationSourceV2["claims"][number] {
  const base = {
    key: claim.key,
    phase: claim.phase,
    sourceItemDigest: claim.sourceItemDigest,
    statement: claim.statement,
  };
  switch (claim.kind) {
    case "command":
      return { ...base, command: claim.command, kind: claim.kind };
    case "artifact-integrity":
      return { ...base, kind: claim.kind, selector: claim.selector };
    case "browser":
      return { ...base, kind: claim.kind, selector: claim.selector };
    case "external-check":
      return { ...base, kind: claim.kind, selector: claim.selector };
    case "human-judgment":
      return { ...base, kind: claim.kind, selector: claim.selector };
  }
}

function digestSpec(spec: RunSpec) {
  return parseSpecDigest(
    digest("gaia.run-spec.v2", [
      { body: spec.body, title: spec.title, verification: spec.verification },
    ])
  );
}

function digestContract(input: object) {
  return parseRunContractDigest(
    digest("gaia.run-contract.v2", [withoutKey(input, "contractDigest")])
  );
}

function digest(domain: string, fields: readonly unknown[]) {
  return bytesToHex(sha256(canonicalV1(domain, fields)));
}

function withoutKey(input: object, key: string) {
  return Object.fromEntries(
    Object.entries(input).filter(([name]) => name !== key)
  );
}
