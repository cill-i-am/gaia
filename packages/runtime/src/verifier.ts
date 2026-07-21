import { createHash } from "node:crypto";

import {
  canonicalV1,
  DeliveryGitShaPublicSchema,
  encodeAnyRunProofResultJson,
  encodeRunProofResultJson,
  encodeVerificationCommandReceiptJson,
  makeRunEvent,
  makeRunProofResult,
  makeRunProofResultV2,
  makeProofEvidenceIdV2,
  makeVerificationCommandRequestDigest,
  parseDeliveryLocalReviewAttestationReceipt,
  ProofClaimResultV2Schema,
  parseRunContract,
  parseRunEventSequence,
  parseVerificationCommandReceipt,
  type ProofClaimV1,
  type ProofClaimV2,
  type ProofClaimResultV2,
  type RunContractV2,
  type RunEvent,
  type RunId,
  type RunProofResult,
  type VerificationCommandReceipt,
  VerificationIdentityDigestSchema,
  VerificationRequestDigestSchema,
  VerificationSourceKeySchema,
} from "@gaia/core";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { BrowserEvidenceTargetUrlSchema } from "./browser-evidence.js";
import {
  finalizeDockerSandboxVerificationReceipt,
  VerificationCommandOutcomeUnknown,
  type DockerSandboxVerificationExecutorService,
  type DockerSandboxVerificationInvocation,
} from "./docker-sandbox-verification-executor.js";
import { GaiaRuntimeError, makeRuntimeError } from "./errors.js";
import {
  appendEvent,
  appendPreparedEventWithinSerialization,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import {
  makeVerificationClaimPaths,
  runRelative,
  type RunPaths,
} from "./paths.js";
import { loadRunContract } from "./run-contract.js";
import {
  VerificationExecutionProfileV1,
  verificationExecutionProfileDigests,
} from "./verification-execution-profile.js";
import { observeWorkspaceStructuralDigest } from "./workspace-snapshot.js";

const VerificationGitHubChecksSnapshotSchema = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      state: Schema.String,
      workflow: Schema.optionalKey(Schema.String),
    })
  ),
  headSha: Schema.optionalKey(Schema.String),
});

const DockerSandboxVerificationExecutorServiceSchema =
  Schema.declare<DockerSandboxVerificationExecutorService>(
    (input): input is DockerSandboxVerificationExecutorService =>
      typeof input === "object" && input !== null
  );
export const VerificationServicesSchema = Schema.Struct({
  executor: DockerSandboxVerificationExecutorServiceSchema,
  profile: VerificationExecutionProfileV1,
});

const BrowserEvidenceObservationSchema = Schema.Struct({
  evidenceKind: Schema.Literal("page"),
  evidenceSelector: VerificationSourceKeySchema,
  status: Schema.Literal("collected"),
  targetUrl: BrowserEvidenceTargetUrlSchema,
});
const parseBrowserEvidenceObservation = Schema.decodeUnknownOption(
  BrowserEvidenceObservationSchema
);
export type VerificationServices = Schema.Schema.Type<
  typeof VerificationServicesSchema
>;
export const RecordRunProofOptionsSchema = Schema.Struct({
  actionId: Schema.optionalKey(Schema.NonEmptyString),
  actionRequestDigest: Schema.optionalKey(VerificationRequestDigestSchema),
  expectedHeadSha: Schema.optionalKey(DeliveryGitShaPublicSchema),
  phase: Schema.optionalKey(
    Schema.Literals(["prePublication", "postPublication"] as const)
  ),
  requireLegacyWorkspaceMarker: Schema.optionalKey(Schema.Boolean),
  verificationServices: Schema.optionalKey(VerificationServicesSchema),
});
export type RecordRunProofOptions = typeof RecordRunProofOptionsSchema.Encoded;
type ParsedRecordRunProofOptions = Schema.Schema.Type<
  typeof RecordRunProofOptionsSchema
>;
const parseRecordRunProofOptions = Schema.decodeUnknownSync(
  RecordRunProofOptionsSchema
);
const parseVerificationIdentityDigest = Schema.decodeUnknownSync(
  VerificationIdentityDigestSchema
);
const parseProofClaimResultV2 = Schema.decodeUnknownSync(
  ProofClaimResultV2Schema
);

/** Record a version-selected contract-bound proof without silently executing V1. */
export function recordRunProofResult(
  runId: RunId,
  paths: RunPaths,
  options: RecordRunProofOptions = {}
) {
  const parsedOptions = parseRecordRunProofOptions(options);
  return loadRunContract(paths, runId).pipe(
    Effect.flatMap(
      (
        contract
      ): Effect.Effect<
        RunProofResult,
        unknown,
        FileSystem.FileSystem | Path.Path
      > =>
        contract.version === 2
          ? recordV2RunProofResult(runId, paths, contract, parsedOptions)
          : recordLegacyRunProofResult(runId, paths, parsedOptions)
    ),
    Effect.mapError((cause) => verificationRuntimeError(cause))
  );
}

function recordV2RunProofResult(
  runId: RunId,
  paths: RunPaths,
  contract: RunContractV2,
  options: ParsedRecordRunProofOptions
) {
  return Effect.gen(function* () {
    const phase = options.phase ?? "prePublication";
    const services = options.verificationServices;
    const initialEvents = yield* readEvents(paths);
    const contentAuthoritySequence =
      currentContentAuthoritySequence(initialEvents);
    const profileIdentity =
      services === undefined
        ? null
        : verificationExecutionProfileDigests(services.profile);
    const executionIdentityForPhase = (
      evidencePhase: "prePublication" | "postPublication"
    ) =>
      parseVerificationIdentityDigest(
        digest("gaia.claim-verification-execution-identity.v1", [
          contract.contractDigest,
          contentAuthoritySequence,
          evidencePhase,
          profileIdentity,
        ])
      );
    const commandClaims = contract.proofClaims.filter(
      (claim): claim is Extract<ProofClaimV2, { readonly kind: "command" }> =>
        claim.kind === "command" && claim.phase === phase
    );
    if (commandClaims.length > 0 && services === undefined)
      return yield* Effect.fail(
        makeRuntimeError({
          code: "VerificationProviderFailure",
          message:
            "Executable V2 command claims require the trusted verification service.",
          recoverable: false,
        })
      );

    const executionEvidenceIdentityDigest = executionIdentityForPhase(phase);
    const actionId =
      options.actionId ??
      `internal:${runId}:${phase}:${contentAuthoritySequence}`;
    const actionRequestDigest =
      options.actionRequestDigest ??
      digest("gaia.claim-verification-action.v1", [
        actionId,
        runId,
        contract.contractDigest,
        contentAuthoritySequence,
        phase,
        options.expectedHeadSha ?? "",
      ]);
    const generation = yield* appendEvent(runId, paths, {
      payload: {
        generation: {
          actionId,
          actionRequestDigest,
          claimIds: commandClaims.map((claim) => claim.claimId),
          contentAuthoritySequence,
          contractDigest: contract.contractDigest,
          executionEvidenceIdentityDigest,
          runId,
        },
      },
      type: "CLAIM_VERIFICATION_GENERATION_STARTED",
    });
    const generationSequence = generation.event.sequence;

    for (const claim of commandClaims) {
      const reusable = latestExactCommandReceipt(
        yield* readEvents(paths),
        contract,
        claim,
        executionEvidenceIdentityDigest
      );
      if (reusable !== undefined) {
        yield* appendEvent(runId, paths, {
          payload: {
            reuse: {
              claimId: claim.claimId,
              contractDigest: contract.contractDigest,
              executionEvidenceIdentityDigest,
              generationSequence,
              originalCommandStartSequence: reusable.commandStartSequence,
              originalTerminalSequence: reusable.terminalSequence,
              receiptDigest: reusable.receiptDigest,
              runId,
            },
          },
          type: "CLAIM_VERIFICATION_REUSE_RECORDED",
        });
        continue;
      }
      yield* executeCommandClaim({
        claim,
        contract,
        executionEvidenceIdentityDigest,
        generationSequence,
        paths,
        runId,
        services: services!,
      });
    }

    const events = yield* readEvents(paths);
    const claimResults: ProofClaimResultV2[] = [];
    for (const claim of contract.proofClaims)
      claimResults.push(
        parseProofClaimResultV2(
          yield* resultForClaim(
            claim,
            contract,
            events,
            paths,
            options.expectedHeadSha,
            executionIdentityForPhase(claim.phase)
          )
        )
      );
    const observed = yield* observeWorkspaceStructuralDigest(paths.workspace);
    const recorded = yield* withRunEventSerialization(
      paths,
      Effect.gen(function* () {
        const latestEvents = yield* readEvents(paths);
        const sequence = parseRunEventSequence(
          (latestEvents.at(-1)?.sequence ?? 0) + 1
        );
        const result = makeRunProofResultV2({
          contentAuthoritySequence,
          contract,
          observedTargetDigest: observed.digest,
          observedTargetObservation: observed.receipt,
          recordedBy: {
            runId,
            sequence,
            type: "RUN_PROOF_RESULT_RECORDED",
          },
          results: claimResults,
        });
        const event = makeRunEvent({
          payload: {
            result: encodeAnyRunProofResultJson(result),
            verificationAction: {
              actionId,
              actionRequestDigest,
              generationSequence,
            },
            verificationResultPath: runRelative(
              paths,
              paths.verificationResult
            ),
          },
          runId,
          sequence,
          timestamp: new Date().toISOString(),
          type: "RUN_PROOF_RESULT_RECORDED",
        });
        yield* appendPreparedEventWithinSerialization(
          runId,
          paths,
          latestEvents,
          event
        );
        return { generationSequence, result };
      })
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      paths.verificationResult,
      `${JSON.stringify(encodeAnyRunProofResultJson(recorded.result), null, 2)}\n`
    );
    yield* fs.writeFileString(
      paths.verificationLog,
      `Run proof aggregate: ${recorded.result.aggregate}.\n`,
      { flag: "a" }
    );
    return recorded.result;
  });
}

function executeCommandClaim(input: {
  readonly claim: Extract<ProofClaimV2, { readonly kind: "command" }>;
  readonly contract: RunContractV2;
  readonly executionEvidenceIdentityDigest: string;
  readonly generationSequence: number;
  readonly paths: RunPaths;
  readonly runId: RunId;
  readonly services: VerificationServices;
}) {
  return Effect.gen(function* () {
    const claimPaths = yield* makeVerificationClaimPaths(
      input.paths,
      input.claim.key
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(claimPaths.directory, { recursive: true });
    const sandboxName = `gaia-${input.runId}-${input.claim.key}`.slice(0, 128);
    const createIntent = yield* appendEvent(input.runId, input.paths, {
      payload: {
        createIntent: {
          claimId: input.claim.claimId,
          contractDigest: input.contract.contractDigest,
          executionEvidenceIdentityDigest:
            input.executionEvidenceIdentityDigest,
          generationSequence: input.generationSequence,
          runId: input.runId,
          sandboxName,
        },
      },
      type: "CLAIM_VERIFICATION_CREATE_INTENT_RECORDED",
    });
    let commandStartSequence: number | undefined;
    let invocation: DockerSandboxVerificationInvocation;
    const persistStagedReceipt = (
      staged: Parameters<
        DockerSandboxVerificationInvocation["onInterrupted"]
      >[0]
    ) =>
      Effect.gen(function* () {
        if (commandStartSequence === undefined)
          return yield* Effect.fail(
            new VerificationCommandOutcomeUnknown({
              code: "VerificationCommandOutcomeUnknown",
              message: "Command dispatch has no durable command-start prefix.",
              recoverable: false,
            })
          );
        const receipt = yield* withRunEventSerialization(
          input.paths,
          Effect.gen(function* () {
            const events = yield* readEvents(input.paths);
            const terminalSequence = parseRunEventSequence(
              (events.at(-1)?.sequence ?? 0) + 1
            );
            const finalized = finalizeDockerSandboxVerificationReceipt(
              invocation,
              staged,
              input.services.profile,
              commandStartSequence!,
              terminalSequence
            );
            const event = makeRunEvent({
              payload: {
                receipt: encodeVerificationCommandReceiptJson(finalized),
              },
              runId: input.runId,
              sequence: terminalSequence,
              timestamp: new Date().toISOString(),
              type: "CLAIM_VERIFICATION_COMMAND_RECORDED",
            });
            yield* appendPreparedEventWithinSerialization(
              input.runId,
              input.paths,
              events,
              event
            );
            return finalized;
          })
        );
        yield* fs.writeFileString(
          claimPaths.receipt,
          `${JSON.stringify(receipt, null, 2)}\n`
        );
        return receipt;
      });
    invocation = {
      authorityDigest: digest("gaia.verification-authority.v1", [
        input.contract.contractDigest,
        input.generationSequence,
      ]),
      claimId: input.claim.claimId,
      contractDigest: input.contract.contractDigest,
      contractId: input.contract.contractId,
      executionEvidenceIdentityDigest: input.executionEvidenceIdentityDigest,
      generationSequence: input.generationSequence,
      onInterrupted: (staged) =>
        persistStagedReceipt(staged).pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new VerificationCommandOutcomeUnknown({
                code: "VerificationCommandOutcomeUnknown",
                message:
                  "Interrupted terminal evidence could not be persisted.",
                recoverable: false,
              })
          )
        ),
      onSandboxCreated: ({ sandboxName: createdName, sandboxUuid }) =>
        Effect.gen(function* () {
          const created = yield* appendEvent(input.runId, input.paths, {
            payload: {
              sandboxCreated: {
                claimId: input.claim.claimId,
                contractDigest: input.contract.contractDigest,
                createIntentSequence: createIntent.event.sequence,
                executionEvidenceIdentityDigest:
                  input.executionEvidenceIdentityDigest,
                generationSequence: input.generationSequence,
                runId: input.runId,
                sandboxName: createdName,
                sandboxUuid,
              },
            },
            type: "CLAIM_VERIFICATION_SANDBOX_CREATED_RECORDED",
          });
          const started = yield* appendEvent(input.runId, input.paths, {
            payload: {
              commandStart: {
                claimId: input.claim.claimId,
                contractDigest: input.contract.contractDigest,
                executionEvidenceIdentityDigest:
                  input.executionEvidenceIdentityDigest,
                generationSequence: input.generationSequence,
                requestDigest: makeVerificationCommandRequestDigest(
                  input.claim.command
                ),
                runId: input.runId,
                sandboxCreatedSequence: created.event.sequence,
                sandboxName: createdName,
                sandboxUuid,
              },
            },
            type: "CLAIM_VERIFICATION_COMMAND_START_RECORDED",
          });
          commandStartSequence = started.event.sequence;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new VerificationCommandOutcomeUnknown({
                code: "VerificationCommandOutcomeUnknown",
                message:
                  "Command-start evidence could not be persisted after sandbox creation.",
                recoverable: false,
              })
          )
        ),
      request: input.claim.command,
      runId: input.runId,
      sandboxName,
      stderrArtifactPath: runRelative(input.paths, claimPaths.stderr),
      stderrPath: claimPaths.stderr,
      stdoutArtifactPath: runRelative(input.paths, claimPaths.stdout),
      stdoutPath: claimPaths.stdout,
      targetDigest: input.contract.targetDigest,
      workspace: input.paths.workspace,
    };
    const staged = yield* Effect.scoped(
      input.services.executor.execute(invocation)
    );
    const receipt = yield* persistStagedReceipt(staged);
    return receipt;
  });
}

function resultForClaim(
  claim: ProofClaimV2,
  contract: RunContractV2,
  events: readonly RunEvent[],
  paths: RunPaths,
  expectedHeadSha: typeof DeliveryGitShaPublicSchema.Type | undefined,
  executionEvidenceIdentityDigest: typeof VerificationIdentityDigestSchema.Type
) {
  switch (claim.kind) {
    case "command": {
      const receipt = latestExactCommandReceipt(
        events,
        contract,
        claim,
        executionEvidenceIdentityDigest
      );
      if (receipt === undefined)
        return Effect.succeed(
          notRun(claim, "No exact terminal command receipt exists.")
        );
      const passed =
        receipt.status === "succeeded" &&
        receipt.exitCode === claim.command.expectedExitCode &&
        receipt.stdout.observedByteCount ===
          claim.command.expectedStdoutByteLength &&
        receipt.stdout.contentDigest === claim.command.expectedStdoutSha256 &&
        receipt.stdout.truncated === false;
      const evidence = commandEvidence(receipt);
      return Effect.succeed(
        passed
          ? {
              claimId: claim.claimId,
              evidence: [evidence],
              status: "passed" as const,
            }
          : {
              claimId: claim.claimId,
              evidence: [evidence],
              reason: `Command receipt status ${receipt.status} did not match the source-owned expectation.`,
              status: "failed" as const,
            }
      );
    }
    case "artifact-integrity":
      return artifactResult(claim, paths);
    case "browser": {
      const matched = [...events].reverse().flatMap((candidate) => {
        if (candidate.type !== "BROWSER_EVIDENCE_RECORDED") return [];
        const observation = parseBrowserEvidenceObservation(candidate.payload);
        return Option.isSome(observation) &&
          observation.value.evidenceSelector ===
            claim.selector.evidenceSelector &&
          observation.value.targetUrl === claim.selector.targetUrl
          ? [{ event: candidate, observation: observation.value }]
          : [];
      })[0];
      return Effect.succeed(
        matched === undefined
          ? notRun(claim, "No exact collected browser evidence event exists.")
          : {
              claimId: claim.claimId,
              evidence: [
                {
                  evidenceId: evidenceId("browser", [
                    claim.claimId,
                    matched.event.sequence,
                  ]),
                  evidenceSelector: matched.observation.evidenceSelector,
                  eventSequence: matched.event.sequence,
                  kind: "browser" as const,
                  targetUrl: matched.observation.targetUrl,
                },
              ],
              status: "passed" as const,
            }
      );
    }
    case "external-check":
      return externalCheckResult(claim, events, paths, expectedHeadSha);
    case "human-judgment": {
      const matched = [...events].reverse().find((event) => {
        if (event.type !== "DELIVERY_LOCAL_REVIEW_ATTESTATION_RECORDED")
          return false;
        try {
          const receipt = parseDeliveryLocalReviewAttestationReceipt(
            event.payload["attestation"]
          );
          return (
            receipt.state === "confirmed" &&
            receipt.decision === claim.selector.decision &&
            receipt.headSha === expectedHeadSha
          );
        } catch {
          return false;
        }
      });
      return Effect.succeed(
        matched === undefined || expectedHeadSha === undefined
          ? {
              claimId: claim.claimId,
              reason: "Exact-head paired human approval has not been recorded.",
              requiredAuthority: "human" as const,
              status: "requires-decision" as const,
            }
          : {
              claimId: claim.claimId,
              evidence: [
                {
                  decision: "approved" as const,
                  evidenceId: evidenceId("human", [
                    claim.claimId,
                    matched.sequence,
                  ]),
                  eventSequence: matched.sequence,
                  headSha: expectedHeadSha,
                  kind: "human-judgment" as const,
                  source: "localOperatorPairedReview" as const,
                },
              ],
              status: "passed" as const,
            }
      );
    }
  }
}

function artifactResult(
  claim: Extract<ProofClaimV2, { readonly kind: "artifact-integrity" }>,
  paths: RunPaths
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const artifacts = [];
    for (const relative of claim.selector.paths) {
      const absolute = path.join(paths.root, relative);
      if (!(yield* fs.exists(absolute)))
        return notRun(claim, `Required artifact ${relative} is absent.`);
      const bytes = yield* fs.readFile(absolute);
      artifacts.push({
        contentDigest: createHash("sha256").update(bytes).digest("hex"),
        path: relative,
      });
    }
    return {
      claimId: claim.claimId,
      evidence: [
        {
          artifacts,
          evidenceId: evidenceId("artifact", [claim.claimId, artifacts]),
          kind: "artifact-integrity" as const,
        },
      ],
      status: "passed" as const,
    };
  });
}

function externalCheckResult(
  claim: Extract<ProofClaimV2, { readonly kind: "external-check" }>,
  events: readonly RunEvent[],
  paths: RunPaths,
  expectedHeadSha: typeof DeliveryGitShaPublicSchema.Type | undefined
) {
  return Effect.gen(function* () {
    if (expectedHeadSha === undefined)
      return notRun(
        claim,
        "No published exact head is bound to this generation."
      );
    const event = [...events]
      .reverse()
      .find(
        (candidate) =>
          candidate.type === "GITHUB_CHECKS_RECORDED" &&
          candidate.payload["headSha"] === expectedHeadSha
      );
    if (event === undefined)
      return notRun(claim, "No exact-head GitHub check event exists.");
    const relative = event.payload["checksPath"];
    if (typeof relative !== "string")
      return notRun(claim, "GitHub check event has no owned snapshot path.");
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const body = yield* fs.readFileString(path.join(paths.root, relative));
    const snapshot = Schema.decodeUnknownSync(
      VerificationGitHubChecksSnapshotSchema
    )(JSON.parse(body));
    const matched = snapshot.checks.find(
      (check) =>
        check.name === claim.selector.checkName &&
        check.workflow === claim.selector.workflow &&
        check.state.toLowerCase() === claim.selector.conclusion
    );
    return matched === undefined || snapshot.headSha !== expectedHeadSha
      ? notRun(claim, "Exact workflow/check/conclusion evidence is absent.")
      : {
          claimId: claim.claimId,
          evidence: [
            {
              checkName: claim.selector.checkName,
              conclusion: "success" as const,
              evidenceId: evidenceId("external-check", [
                claim.claimId,
                event.sequence,
              ]),
              eventSequence: event.sequence,
              headSha: expectedHeadSha,
              kind: "external-check" as const,
              provider: "github" as const,
              workflow: claim.selector.workflow,
            },
          ],
          status: "passed" as const,
        };
  }).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.succeed(
        notRun(claim, "Exact GitHub check snapshot could not be read.")
      )
    )
  );
}

function commandEvidence(receipt: VerificationCommandReceipt) {
  return {
    evidenceId: evidenceId("command", [receipt.receiptDigest]),
    kind: "command" as const,
    receiptDigest: receipt.receiptDigest,
    requestDigest: receipt.requestDigest,
    status: receipt.status,
    terminalSequence: receipt.terminalSequence,
  };
}

function notRun(claim: ProofClaimV2, reason: string) {
  return { claimId: claim.claimId, reason, status: "not-run" as const };
}

function latestExactCommandReceipt(
  events: readonly RunEvent[],
  contract: RunContractV2,
  claim: Extract<ProofClaimV2, { readonly kind: "command" }>,
  executionEvidenceIdentityDigest: typeof VerificationIdentityDigestSchema.Type
) {
  for (const event of [...events].reverse()) {
    if (event.type !== "CLAIM_VERIFICATION_COMMAND_RECORDED") continue;
    try {
      const receipt = parseVerificationCommandReceipt(event.payload["receipt"]);
      if (
        receipt.claimId === claim.claimId &&
        receipt.contractDigest === contract.contractDigest &&
        receipt.executionEvidenceIdentityDigest ===
          executionEvidenceIdentityDigest &&
        receipt.targetDigest === contract.targetDigest &&
        receipt.requestDigest ===
          makeVerificationCommandRequestDigest(claim.command)
      )
        return receipt;
    } catch {
      // Event parsing validates payloads; this keeps the lookup total for callers.
    }
  }
  return undefined;
}

function currentContentAuthoritySequence(events: readonly RunEvent[]) {
  const sequence = [...events]
    .reverse()
    .find((event) =>
      [
        "WORKER_COMPLETED",
        "WORKER_CONTINUATION_RECORDED",
        "DELIVERY_REMEDIATION_RECORDED",
      ].includes(event.type)
    )?.sequence;
  if (sequence === undefined)
    throw new Error("V2 proof requires a durable content-authority event.");
  return parseRunEventSequence(sequence);
}

function evidenceId(kind: string, fields: readonly unknown[]) {
  return makeProofEvidenceIdV2(
    Schema.decodeUnknownSync(
      Schema.Literals([
        "artifact",
        "browser",
        "command",
        "external-check",
        "human",
      ] as const)
    )(kind),
    fields
  );
}

function digest(domain: string, fields: readonly unknown[]) {
  return createHash("sha256").update(canonicalV1(domain, fields)).digest("hex");
}

function verificationRuntimeError(cause: unknown) {
  if (cause instanceof GaiaRuntimeError) return cause;
  const record =
    typeof cause === "object" && cause !== null
      ? (cause as Record<string, unknown>)
      : undefined;
  return makeRuntimeError({
    cause,
    code:
      typeof record?.["code"] === "string"
        ? record["code"]
        : "VerificationPersistenceFailure",
    message:
      typeof record?.["message"] === "string"
        ? record["message"]
        : "Gaia could not persist or execute claim verification.",
    recoverable: false,
  });
}

/** Permanent V1 path: vocabulary-only contracts remain explicitly unexecuted. */
function recordLegacyRunProofResult(
  runId: RunId,
  paths: RunPaths,
  options: ParsedRecordRunProofOptions
) {
  return withRunEventSerialization(
    paths,
    Effect.gen(function* () {
      const existingEvents = yield* readEvents(paths);
      const contractEvents = existingEvents.filter(
        (event) => event.type === "RUN_CONTRACT_RECORDED"
      );
      if (contractEvents.length !== 1)
        return yield* Effect.fail(
          makeRuntimeError({
            code: "RunContractMissingOrDuplicate",
            message:
              "Proof recording requires exactly one event-owned run contract.",
            recoverable: false,
          })
        );
      const contract = yield* Effect.try({
        catch: (cause) =>
          makeRuntimeError({
            cause,
            code: "RunContractInvalid",
            message: "Proof recording found an invalid run contract.",
            recoverable: false,
          }),
        try: () => parseRunContract(contractEvents[0]!.payload["contract"]),
      });
      if (contract.runId !== runId)
        return yield* Effect.fail(
          makeRuntimeError({
            code: "RunContractRunMismatch",
            message: "Proof recording contract belongs to another run.",
            recoverable: false,
          })
        );

      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        paths.verificationLog,
        "Recording run proof.\n",
        {
          flag: "a",
        }
      );
      const supplementalProtocolEvidence = [];
      if (options.requireLegacyWorkspaceMarker ?? true) {
        const exists = yield* fs.exists(paths.workspaceOutput);
        if (!exists)
          return yield* Effect.fail(
            makeRuntimeError({
              code: "VerificationArtifactMissing",
              message: "Expected workspace/output.txt to exist.",
              recoverable: true,
            })
          );
        const bytes = yield* fs.readFile(paths.workspaceOutput);
        if (!new TextDecoder().decode(bytes).includes(runId))
          return yield* Effect.fail(
            makeRuntimeError({
              code: "VerificationMarkerMissing",
              message: "Expected workspace/output.txt to include the run id.",
              recoverable: true,
            })
          );
        supplementalProtocolEvidence.push({
          artifactPath: runRelative(paths, paths.workspaceOutput),
          contentDigest: createHash("sha256").update(bytes).digest("hex"),
          kind: "framework-output-marker" as const,
        });
      }
      const observed = yield* observeWorkspaceStructuralDigest(paths.workspace);
      const sequence = parseRunEventSequence(
        (existingEvents.at(-1)?.sequence ?? 0) + 1
      );
      const result = makeRunProofResult({
        contract,
        observedTargetDigest: observed.digest,
        observedTargetObservation: observed.receipt,
        recordedBy: { runId, sequence, type: "RUN_PROOF_RESULT_RECORDED" },
        results: contract.proofClaims.map(unexecutedClaimResult),
        supplementalProtocolEvidence,
      });
      const event = makeRunEvent({
        payload: {
          result: encodeRunProofResultJson(result),
          verificationResultPath: runRelative(paths, paths.verificationResult),
        },
        runId,
        sequence,
        timestamp: new Date().toISOString(),
        type: "RUN_PROOF_RESULT_RECORDED",
      });
      yield* appendPreparedEventWithinSerialization(
        runId,
        paths,
        existingEvents,
        event
      );
      yield* fs.writeFileString(
        paths.verificationResult,
        `${JSON.stringify(encodeRunProofResultJson(result), null, 2)}\n`
      );
      return result;
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          makeRuntimeError({
            cause,
            code: "RunProofRecordFailed",
            message: "Gaia could not record the run proof result.",
            recoverable: true,
          })
        )
      )
    )
  );
}

function unexecutedClaimResult(claim: ProofClaimV1) {
  if (claim.kind === "human-judgment")
    return {
      claimId: claim.claimId,
      reason: "This proof claim requires explicit human judgment.",
      requiredAuthority: "human" as const,
      status: "requires-decision" as const,
    };
  return {
    claimId: claim.claimId,
    reason:
      "V1 proof vocabulary is permanent replay-only input and is never silently executed.",
    status: "not-run" as const,
  };
}
