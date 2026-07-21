import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Schema } from "effect";

import {
  canonicalV1,
  ContentDigestSchema,
  ProofClaimIdSchema,
  RunContractDigestSchema,
  RunEventSequenceSchema,
  RunRelativeArtifactPathSchema,
  StructuralDigestSchema,
} from "./run-contract.js";
import { RunIdSchema } from "./run-id.js";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const lowerSha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
);
const boundedText = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(4_096)),
  Schema.check(
    Schema.makeFilter((value) => value.isWellFormed() && !value.includes("\0"))
  )
);

export const VerificationSourceKeySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u))
);
export const VerificationRequestDigestSchema = lowerSha256.pipe(
  Schema.brand("VerificationRequestDigest")
);
export const VerificationReceiptDigestSchema = lowerSha256.pipe(
  Schema.brand("VerificationReceiptDigest")
);
export const VerificationIdentityDigestSchema = lowerSha256.pipe(
  Schema.brand("VerificationIdentityDigest")
);
export const VerificationProviderBuildSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
);
export const VerificationSandboxUuidSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    )
  )
);
export const VerificationSandboxNameSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u))
);
export const VerificationWorkingDirectorySchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(1_024)),
  Schema.check(
    Schema.makeFilter(
      (value) =>
        value === "." ||
        (/^(?!\/)(?![A-Za-z]:[\\/])(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)[^\u0000-\u001f\u007f]+$/u.test(
          value
        ) &&
          value.isWellFormed())
    )
  )
);
const VerificationArgumentSchema = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(4_096)),
  Schema.check(
    Schema.makeFilter((value) => value.isWellFormed() && !value.includes("\0"))
  )
);

/** Exact, source-owned command request. It never contains a shell string. */
export class VerificationCommandRequestV1 extends Schema.Class<VerificationCommandRequestV1>(
  "VerificationCommandRequestV1"
)(
  {
    argv: Schema.Array(VerificationArgumentSchema).pipe(
      Schema.check(Schema.isMaxLength(64))
    ),
    credentials: Schema.Literal("none"),
    executableId: VerificationSourceKeySchema,
    expectedExitCode: Schema.Literal(0),
    expectedStdoutByteLength: Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 0, maximum: 1_048_576 }))
    ),
    expectedStdoutSha256: ContentDigestSchema,
    network: Schema.Literal("denied"),
    outputLimitBytes: Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_048_576 }))
    ),
    timeoutMs: Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 1, maximum: 300_000 }))
    ),
    workingDirectory: VerificationWorkingDirectorySchema,
    workspaceAccess: Schema.Literal("read-write"),
  },
  strict
) {}

const decodeRequest = Schema.decodeUnknownSync(VerificationCommandRequestV1);
const parseRequestDigest = Schema.decodeUnknownSync(
  VerificationRequestDigestSchema
);

export function makeVerificationCommandRequestDigest(
  input: typeof VerificationCommandRequestV1.Encoded
) {
  const request = decodeRequest(input);
  return parseRequestDigest(
    bytesToHex(
      sha256(canonicalV1("gaia.verification-command-request.v1", [request]))
    )
  );
}

export class VerificationOutputEvidenceV1 extends Schema.Class<VerificationOutputEvidenceV1>(
  "VerificationOutputEvidenceV1"
)(
  {
    artifactPath: RunRelativeArtifactPathSchema,
    contentDigest: ContentDigestSchema,
    observedByteCount: Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(0))
    ),
    retainedByteCount: Schema.Int.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(0))
    ),
    truncated: Schema.Boolean,
  },
  strict
) {}

export class VerificationCleanupEvidenceV1 extends Schema.Class<VerificationCleanupEvidenceV1>(
  "VerificationCleanupEvidenceV1"
)(
  {
    finalAbsenceConfirmed: Schema.Literal(true),
    removedSandboxUuid: VerificationSandboxUuidSchema,
    stoppedSandboxUuid: VerificationSandboxUuidSchema,
  },
  strict
) {}

const receiptFields = {
  argumentCount: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  authorityDigest: VerificationIdentityDigestSchema,
  cleanup: VerificationCleanupEvidenceV1,
  claimId: ProofClaimIdSchema,
  commandIdentityDigest: VerificationIdentityDigestSchema,
  commandStartSequence: RunEventSequenceSchema,
  contractDigest: RunContractDigestSchema,
  contractId: boundedText,
  credentialProfileDigest: VerificationIdentityDigestSchema,
  durationMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  environmentDigest: VerificationIdentityDigestSchema,
  executableId: VerificationSourceKeySchema,
  executionEvidenceIdentityDigest: VerificationIdentityDigestSchema,
  executionProfileDigest: VerificationIdentityDigestSchema,
  generationSequence: RunEventSequenceSchema,
  imageDigest: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u))
  ),
  network: Schema.Literal("denied"),
  policyDigest: VerificationIdentityDigestSchema,
  providerBuild: VerificationProviderBuildSchema,
  providerId: VerificationSourceKeySchema,
  providerVersion: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^\d+\.\d+\.\d+$/u))
  ),
  receiptDigest: VerificationReceiptDigestSchema,
  requestDigest: VerificationRequestDigestSchema,
  runId: RunIdSchema,
  sandboxName: VerificationSandboxNameSchema,
  sandboxUuid: VerificationSandboxUuidSchema,
  stderr: VerificationOutputEvidenceV1,
  stdout: VerificationOutputEvidenceV1,
  targetDigest: StructuralDigestSchema,
  templateReference: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^docker\/sandbox-templates:[^@]+@sha256:[a-f0-9]{64}$/u)
    )
  ),
  terminalSequence: RunEventSequenceSchema,
  workspace: VerificationWorkingDirectorySchema,
} as const;

export class VerificationCommandSucceededReceipt extends Schema.Class<VerificationCommandSucceededReceipt>(
  "VerificationCommandSucceededReceipt"
)(
  {
    ...receiptFields,
    exitCode: Schema.Literal(0),
    status: Schema.Literal("succeeded"),
  },
  strict
) {}
export class VerificationCommandNonZeroReceipt extends Schema.Class<VerificationCommandNonZeroReceipt>(
  "VerificationCommandNonZeroReceipt"
)(
  {
    ...receiptFields,
    exitCode: Schema.Int.pipe(
      Schema.check(Schema.makeFilter((value) => value !== 0))
    ),
    status: Schema.Literal("nonZero"),
  },
  strict
) {}
export class VerificationCommandTimedOutReceipt extends Schema.Class<VerificationCommandTimedOutReceipt>(
  "VerificationCommandTimedOutReceipt"
)({ ...receiptFields, status: Schema.Literal("timedOut") }, strict) {}
export class VerificationCommandMissingExecutableReceipt extends Schema.Class<VerificationCommandMissingExecutableReceipt>(
  "VerificationCommandMissingExecutableReceipt"
)(
  {
    ...receiptFields,
    observedProviderExitCode: Schema.Literal(127),
    status: Schema.Literal("missingExecutable"),
  },
  strict
) {}
export class VerificationCommandSpawnFailedReceipt extends Schema.Class<VerificationCommandSpawnFailedReceipt>(
  "VerificationCommandSpawnFailedReceipt"
)(
  {
    ...receiptFields,
    observedProviderExitCode: Schema.Literal(126),
    spawnStage: Schema.Literal("commandStart"),
    status: Schema.Literal("spawnFailed"),
  },
  strict
) {}
export class VerificationCommandInterruptedReceipt extends Schema.Class<VerificationCommandInterruptedReceipt>(
  "VerificationCommandInterruptedReceipt"
)({ ...receiptFields, status: Schema.Literal("interrupted") }, strict) {}
export class VerificationCommandOutputLimitExceededReceipt extends Schema.Class<VerificationCommandOutputLimitExceededReceipt>(
  "VerificationCommandOutputLimitExceededReceipt"
)(
  { ...receiptFields, status: Schema.Literal("outputLimitExceeded") },
  strict
) {}

export const VerificationCommandReceiptSchema = Schema.Union([
  VerificationCommandSucceededReceipt,
  VerificationCommandNonZeroReceipt,
  VerificationCommandTimedOutReceipt,
  VerificationCommandMissingExecutableReceipt,
  VerificationCommandSpawnFailedReceipt,
  VerificationCommandInterruptedReceipt,
  VerificationCommandOutputLimitExceededReceipt,
]);
export type VerificationCommandReceipt =
  | VerificationCommandSucceededReceipt
  | VerificationCommandNonZeroReceipt
  | VerificationCommandTimedOutReceipt
  | VerificationCommandMissingExecutableReceipt
  | VerificationCommandSpawnFailedReceipt
  | VerificationCommandInterruptedReceipt
  | VerificationCommandOutputLimitExceededReceipt;
const decodeVerificationCommandReceipt = Schema.decodeUnknownSync(
  VerificationCommandReceiptSchema
);
const VerificationCommandReceiptJson = Schema.toCodecJson(
  VerificationCommandReceiptSchema
);
export const encodeVerificationCommandReceiptJson = Schema.encodeSync(
  VerificationCommandReceiptJson
);
export function makeVerificationCommandReceiptDigest(input: object) {
  return verificationReceiptDigest(
    "gaia.verification-command-receipt.v1",
    input
  );
}

export function parseVerificationCommandReceipt(input: unknown) {
  const receipt = decodeVerificationCommandReceipt(input);
  if (receipt.receiptDigest !== makeVerificationCommandReceiptDigest(receipt))
    throw new Error("Verification command receipt digest is stale or rebound.");
  return receipt;
}

export const VerificationCommandTerminalStatusSchema = Schema.Literals([
  "succeeded",
  "nonZero",
  "timedOut",
  "missingExecutable",
  "spawnFailed",
  "interrupted",
  "outputLimitExceeded",
] as const);

export class VerificationCommandFailureDiagnostic extends Schema.Class<VerificationCommandFailureDiagnostic>(
  "VerificationCommandFailureDiagnostic"
)(
  {
    code: Schema.Literals([
      "VerificationCommandNonZero",
      "VerificationCommandTimedOut",
      "VerificationExecutableMissing",
      "VerificationCommandSpawnFailed",
      "VerificationCommandInterrupted",
      "VerificationOutputLimitExceeded",
    ] as const),
    kind: VerificationCommandTerminalStatusSchema,
    message: Schema.NonEmptyString,
    receiptDigest: VerificationReceiptDigestSchema,
    retryable: Schema.Literal(false),
  },
  strict
) {}

export class VerificationOperationCounts extends Schema.Class<VerificationOperationCounts>(
  "VerificationOperationCounts"
)(
  {
    create: Schema.Literal(0),
    exec: Schema.Literal(0),
    list: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(2))),
    redispatch: Schema.Literal(0),
    remove: Schema.Literals([0, 1] as const),
    stop: Schema.Literals([0, 1] as const),
  },
  strict
) {}

export class VerificationReconciliationReceiptV1 extends Schema.Class<VerificationReconciliationReceiptV1>(
  "VerificationReconciliationReceiptV1"
)(
  {
    actionId: Schema.NonEmptyString,
    claimId: ProofClaimIdSchema,
    contractDigest: RunContractDigestSchema,
    executionEvidenceIdentityDigest: VerificationIdentityDigestSchema,
    finalAbsenceConfirmed: Schema.Literal(true),
    generationSequence: RunEventSequenceSchema,
    operationCounts: VerificationOperationCounts,
    priorSequence: RunEventSequenceSchema,
    reason: Schema.Literals([
      "createdWithoutCommandStart",
      "commandStartOutcomeUnknown",
    ] as const),
    receiptDigest: VerificationReceiptDigestSchema,
    runId: RunIdSchema,
    sandboxName: VerificationSandboxNameSchema,
    sandboxUuid: VerificationSandboxUuidSchema,
  },
  strict
) {}
const VerificationReconciliationReceiptJson = Schema.toCodecJson(
  VerificationReconciliationReceiptV1
);
export const encodeVerificationReconciliationReceiptJson = Schema.encodeSync(
  VerificationReconciliationReceiptJson
);
const decodeVerificationReconciliationReceipt = Schema.decodeUnknownSync(
  VerificationReconciliationReceiptV1
);

export function makeVerificationReconciliationReceiptDigest(input: object) {
  return verificationReceiptDigest(
    "gaia.verification-reconciliation.v1",
    input
  );
}

export function parseVerificationReconciliationReceipt(input: unknown) {
  const receipt = decodeVerificationReconciliationReceipt(input);
  if (
    receipt.receiptDigest !==
    makeVerificationReconciliationReceiptDigest(receipt)
  )
    throw new Error(
      "Verification reconciliation receipt digest is stale or rebound."
    );
  return receipt;
}

function verificationReceiptDigest(domain: string, input: object) {
  const payload = Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "receiptDigest")
  );
  return Schema.decodeUnknownSync(VerificationReceiptDigestSchema)(
    bytesToHex(sha256(canonicalV1(domain, [payload])))
  );
}

const lifecycleIdentityFields = {
  claimId: ProofClaimIdSchema,
  contractDigest: RunContractDigestSchema,
  executionEvidenceIdentityDigest: VerificationIdentityDigestSchema,
  generationSequence: RunEventSequenceSchema,
  runId: RunIdSchema,
} as const;

export class ClaimVerificationGenerationStartedV1 extends Schema.Class<ClaimVerificationGenerationStartedV1>(
  "ClaimVerificationGenerationStartedV1"
)(
  {
    actionId: Schema.NonEmptyString,
    actionRequestDigest: VerificationRequestDigestSchema,
    claimIds: Schema.Array(ProofClaimIdSchema),
    contentAuthoritySequence: RunEventSequenceSchema,
    contractDigest: RunContractDigestSchema,
    executionEvidenceIdentityDigest: VerificationIdentityDigestSchema,
    runId: RunIdSchema,
  },
  strict
) {}

export class ClaimVerificationCreateIntentV1 extends Schema.Class<ClaimVerificationCreateIntentV1>(
  "ClaimVerificationCreateIntentV1"
)(
  {
    ...lifecycleIdentityFields,
    sandboxName: VerificationSandboxNameSchema,
  },
  strict
) {}

export class ClaimVerificationSandboxCreatedV1 extends Schema.Class<ClaimVerificationSandboxCreatedV1>(
  "ClaimVerificationSandboxCreatedV1"
)(
  {
    ...lifecycleIdentityFields,
    createIntentSequence: RunEventSequenceSchema,
    sandboxName: VerificationSandboxNameSchema,
    sandboxUuid: VerificationSandboxUuidSchema,
  },
  strict
) {}

export class ClaimVerificationCommandStartV1 extends Schema.Class<ClaimVerificationCommandStartV1>(
  "ClaimVerificationCommandStartV1"
)(
  {
    ...lifecycleIdentityFields,
    requestDigest: VerificationRequestDigestSchema,
    sandboxCreatedSequence: RunEventSequenceSchema,
    sandboxName: VerificationSandboxNameSchema,
    sandboxUuid: VerificationSandboxUuidSchema,
  },
  strict
) {}

export class ClaimVerificationReuseReceiptV1 extends Schema.Class<ClaimVerificationReuseReceiptV1>(
  "ClaimVerificationReuseReceiptV1"
)(
  {
    ...lifecycleIdentityFields,
    originalCommandStartSequence: RunEventSequenceSchema,
    originalTerminalSequence: RunEventSequenceSchema,
    receiptDigest: VerificationReceiptDigestSchema,
  },
  strict
) {}
