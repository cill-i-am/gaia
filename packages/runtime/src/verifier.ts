import { createHash } from "node:crypto";

import {
  encodeRunProofResultJson,
  makeRunEvent,
  makeRunProofResult,
  parseRunContract,
  parseRunEventSequence,
  type ProofClaimV1,
  type RunId,
} from "@gaia/core";
import { Effect, FileSystem } from "effect";

import { makeRuntimeError } from "./errors.js";
import {
  appendPreparedEventWithinSerialization,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import { runRelative, type RunPaths } from "./paths.js";
import { observeWorkspaceStructuralDigest } from "./workspace-snapshot.js";

/**
 * Record one contract-bound proof result. Sequence allocation, result/evidence
 * construction, validation, append, and projection write share one serialized
 * critical section so persisted evidence cannot bind a guessed event identity.
 */
export function recordRunProofResult(
  runId: RunId,
  paths: RunPaths,
  options: { readonly requireLegacyWorkspaceMarker?: boolean } = {}
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
      const requireLegacyWorkspaceMarker =
        options.requireLegacyWorkspaceMarker ?? true;
      const supplementalProtocolEvidence = [];
      if (requireLegacyWorkspaceMarker) {
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
        const output = new TextDecoder().decode(bytes);
        if (!output.includes(runId))
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
        recordedBy: {
          runId,
          sequence,
          type: "RUN_PROOF_RESULT_RECORDED",
        },
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
      yield* fs.writeFileString(
        paths.verificationLog,
        `Run proof aggregate: ${result.aggregate}.\n`,
        { flag: "a" }
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
  if (claim.kind === "human-judgment") {
    return {
      claimId: claim.claimId,
      reason: "This proof claim requires explicit human judgment.",
      requiredAuthority: "human" as const,
      status: "requires-decision" as const,
    };
  }
  return {
    claimId: claim.claimId,
    reason:
      "GAIA-144 defines proof vocabulary but does not execute or discover proof commands.",
    status: "not-run" as const,
  };
}
