import { createHash } from "node:crypto";

import {
  deriveAcceptedOutcomeId,
  deriveExplicitSpecItemDigest,
  deriveProofClaimId,
  encodeRunContractJson,
  encodeRunProofResultJson,
  makeRunContract,
  normalizeExplicitSpecStatement,
  parseRunContract,
  parseRunProofResult,
  parseSpecDigest,
  type ProofAuthorityRequirement,
  type ProofClaimKind,
  type ProofClaimRequirement,
  type RunBaseIdentityV1,
  type RunContractV1,
  type RunId,
  type RunEvent,
  type RunProofResultV1,
  type RunSpec,
  type RunTargetIdentityV1,
} from "@gaia/core";
import { Effect, FileSystem } from "effect";

import { makeRuntimeError } from "./errors.js";
import {
  appendEvent,
  readEvents,
  withRunEventSerialization,
} from "./event-store.js";
import type { DeliveryProvenance } from "./git-delivery.js";
import type { RunPaths } from "./paths.js";
import { explicitRunContractItems } from "./worker-plan.js";
import { observeWorkspaceStructuralDigest } from "./workspace-snapshot.js";

export function deriveAndRecordRunContract(input: {
  readonly deliveryProvenance?: DeliveryProvenance;
  readonly paths: RunPaths;
  readonly runId: RunId;
  readonly spec: RunSpec;
}) {
  return Effect.gen(function* () {
    const observation = yield* observeWorkspaceStructuralDigest(
      input.paths.workspace
    );
    const specDigest = parseSpecDigest(
      createHash("sha256")
        .update("gaia.run-spec.v1\0")
        .update(input.spec.title)
        .update("\0")
        .update(input.spec.body)
        .digest("hex")
    );
    const items = explicitRunContractItems(input.spec);
    const acceptedOutcomes = uniqueStatements(items.acceptanceCriteria).map(
      (statement) => {
        const source = {
          itemDigest: deriveExplicitSpecItemDigest({
            section: "acceptanceCriteria",
            statement,
          }),
          kind: "explicitSpecItem" as const,
          section: "acceptanceCriteria" as const,
          specDigest,
          version: 1 as const,
        };
        return {
          conditionalClaimIds: [],
          outcomeId: deriveAcceptedOutcomeId({ source, statement }),
          // The source format has no outcome-to-check relation. Leaving the
          // mapping empty is honest and intentionally prevents verification.
          requiredClaimIds: [],
          source,
          statement,
        };
      }
    );
    const proofClaims = uniqueStatements(items.verificationChecks).map(
      (statement) => {
        const kind = proofKindForExplicitCheck(statement);
        const requirement = proofRequirementForExplicitCheck(statement);
        const authorityRequirements = authoritiesForProofKind(kind);
        const source = {
          itemDigest: deriveExplicitSpecItemDigest({
            section: "verificationChecks",
            statement,
          }),
          kind: "explicitSpecItem" as const,
          section: "verificationChecks" as const,
          specDigest,
          version: 1 as const,
        };
        return {
          authorityRequirements,
          claimId: deriveProofClaimId({
            authorityRequirements,
            kind,
            requirement,
            source,
            statement,
          }),
          kind,
          requirement,
          source,
          statement,
        };
      }
    );
    const contract = makeRunContract({
      acceptedOutcomes,
      baseDigest: observation.digest,
      baseIdentity: baseIdentity(input.deliveryProvenance),
      baseObservation: observation.receipt,
      nonGoals: sourcedItems(
        uniqueStatements(items.nonGoals),
        "nonGoals",
        specDigest
      ),
      proofClaims,
      runId: input.runId,
      stopConditions: sourcedItems(
        uniqueStatements(items.stopConditions),
        "stopConditions",
        specDigest
      ),
      targetDigest: observation.digest,
      targetIdentity: targetIdentity(input.deliveryProvenance),
      targetObservation: observation.receipt,
    });

    yield* appendEvent(input.runId, input.paths, {
      payload: { contract: encodeRunContractJson(contract) },
      type: "RUN_CONTRACT_RECORDED",
    });
    yield* writeRunContractProjection(input.paths, contract);
    return contract;
  });
}

export function loadRunContract(paths: RunPaths, runId: RunId) {
  return Effect.gen(function* () {
    const synchronized = yield* synchronizeEventOwnedRunProjections(
      paths,
      runId
    );
    if (synchronized.contract === undefined) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunContractMissingOrDuplicate",
          message: `Run ${runId} must have exactly one immutable run contract.`,
          recoverable: false,
        })
      );
    }
    return synchronized.contract;
  });
}

/**
 * Load proof from events.jsonl and verify the JSON artifact is only a matching
 * projection. Consumers must never elevate the artifact into a second run truth.
 */
export function loadAuthoritativeRunProofResult(paths: RunPaths, runId: RunId) {
  return Effect.gen(function* () {
    const synchronized = yield* synchronizeEventOwnedRunProjections(
      paths,
      runId
    );
    if (synchronized.proofResult === undefined)
      return yield* Effect.fail(
        makeRuntimeError({
          code: "RunProofMissing",
          message: `Run ${runId} has no authoritative contract-bound proof result.`,
          recoverable: false,
        })
      );
    return synchronized.proofResult;
  });
}

export function synchronizeEventOwnedRunProjections(
  paths: RunPaths,
  runId: RunId
) {
  return withRunEventSerialization(
    paths,
    Effect.gen(function* () {
      const events = yield* readEvents(paths);
      const projections = yield* decodeEventOwnedRunProjections(runId, events);
      if (projections.contract !== undefined)
        yield* writeProjectionIfChanged(
          paths.runContract,
          canonicalRunContractBody(projections.contract)
        );
      if (projections.proofResult !== undefined)
        yield* writeProjectionIfChanged(
          paths.verificationResult,
          canonicalRunProofResultBody(projections.proofResult)
        );
      return { events, ...projections };
    })
  ).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "RunProjectionRepairFailed",
          message: "Gaia could not rebuild event-owned run projections.",
          recoverable: true,
        })
      )
    )
  );
}

export function canonicalRunContractBody(contract: RunContractV1) {
  return `${JSON.stringify(encodeRunContractJson(contract), null, 2)}\n`;
}

export function canonicalRunProofResultBody(result: RunProofResultV1) {
  return `${JSON.stringify(encodeRunProofResultJson(result), null, 2)}\n`;
}

function decodeEventOwnedRunProjections(
  runId: RunId,
  events: ReadonlyArray<RunEvent>
) {
  return Effect.try({
    catch: (cause) =>
      makeRuntimeError({
        cause,
        code: "RunProofInvalid",
        message: `Run ${runId} has invalid authoritative proof history.`,
        recoverable: false,
      }),
    try: () => {
      const contractEvents = events.filter(
        (event) => event.type === "RUN_CONTRACT_RECORDED"
      );
      const resultEvents = events.filter(
        (event) => event.type === "RUN_PROOF_RESULT_RECORDED"
      );
      if (contractEvents.length === 0 && resultEvents.length === 0) return {};
      if (contractEvents.length !== 1)
        throw new Error("Expected exactly one immutable run contract.");
      const contract = parseRunContract(contractEvents[0]!.payload["contract"]);
      if (contract.runId !== runId)
        throw new Error("Run contract belongs to another run.");
      const resultEvent = resultEvents.at(-1);
      if (resultEvent === undefined) return { contract };
      const proofResult = parseRunProofResult(
        resultEvent.payload["result"],
        contract
      );
      if (proofResult.recordedBy.sequence !== resultEvent.sequence)
        throw new Error("Authoritative proof does not bind its run event.");
      return { contract, proofResult };
    },
  });
}

function writeProjectionIfChanged(path: RunPaths["runContract"], body: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path);
    if (exists) {
      const current = yield* Effect.exit(fs.readFileString(path));
      if (current._tag === "Success" && current.value === body) return;
    }
    yield* fs.writeFileString(path, body);
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "RunProjectionRepairFailed",
          message: "Gaia could not rebuild an event-owned run projection.",
          recoverable: true,
        })
      )
    )
  );
}

function writeRunContractProjection(paths: RunPaths, contract: RunContractV1) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      paths.runContract,
      canonicalRunContractBody(contract)
    );
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        makeRuntimeError({
          cause,
          code: "RunContractProjectionWriteFailed",
          message: "Gaia could not write the derived run-contract projection.",
          recoverable: true,
        })
      )
    )
  );
}

function sourcedItems<const Section extends "nonGoals" | "stopConditions">(
  statements: readonly string[],
  section: Section,
  specDigest: ReturnType<typeof parseSpecDigest>
) {
  return statements.map((statement) => ({
    source: {
      itemDigest: deriveExplicitSpecItemDigest({ section, statement }),
      kind: "explicitSpecItem" as const,
      section,
      specDigest,
      version: 1 as const,
    },
    statement,
  }));
}

function uniqueStatements(statements: readonly string[]) {
  return [...new Set(statements.map(normalizeExplicitSpecStatement))];
}

function proofKindForExplicitCheck(statement: string): ProofClaimKind {
  const normalized = statement.toLowerCase();
  if (/\b(human|reviewer|approval|judgment|decision)\b/u.test(normalized))
    return "human-judgment";
  if (/\b(browser|page|url|visual|ui)\b/u.test(normalized)) return "browser";
  if (/\b(github|external|check run|deployment)\b/u.test(normalized))
    return "external-check";
  if (/\b(file|artifact|output|digest|schema round.?trip)\b/u.test(normalized))
    return "artifact-integrity";
  return "command";
}

function proofRequirementForExplicitCheck(
  statement: string
): ProofClaimRequirement {
  return /^if\b/iu.test(statement.trim()) ? "conditional" : "required";
}

function authoritiesForProofKind(
  kind: ProofClaimKind
): readonly ProofAuthorityRequirement[] {
  switch (kind) {
    case "artifact-integrity":
      return ["gaia-runtime"];
    case "command":
      return ["harness"];
    case "browser":
      return ["browser"];
    case "external-check":
      return ["external-system"];
    case "human-judgment":
      return ["human"];
  }
}

function targetIdentity(
  delivery: DeliveryProvenance | undefined
): RunTargetIdentityV1 {
  return delivery === undefined
    ? { kind: "unversionedWorkspace", workspacePath: "." }
    : {
        baseBranch: delivery.baseBranch,
        headBranch: delivery.headBranch,
        kind: "gitWorktree",
        remote: delivery.remote,
        workspacePath: ".",
      };
}

function baseIdentity(
  delivery: DeliveryProvenance | undefined
): RunBaseIdentityV1 {
  return delivery === undefined
    ? { kind: "unversionedSnapshot", workspacePath: "." }
    : {
        branch: delivery.baseBranch,
        kind: "gitRevision",
        remote: delivery.remote,
        revision: delivery.baseRevision,
      };
}
