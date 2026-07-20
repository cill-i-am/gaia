import { createHash } from "node:crypto";

import {
  canonicalV1,
  ContentDigestSchema,
  DeliveryActionIdSchema,
  makeVerificationCommandRequestDigest,
  makeVerificationCommandReceiptDigest,
  makeVerificationReconciliationReceiptDigest,
  parseVerificationCommandReceipt,
  ProofClaimIdSchema,
  RunContractDigestSchema,
  RunContractIdSchema,
  RunContractIdV2Schema,
  RunEventSequenceSchema,
  RunIdSchema,
  RunRelativeArtifactPathSchema,
  StructuralDigestSchema,
  VerificationCleanupEvidenceV1,
  VerificationIdentityDigestSchema,
  VerificationReconciliationReceiptV1,
  VerificationSandboxNameSchema,
  VerificationSandboxUuidSchema,
  VerificationCommandRequestV1,
  type VerificationCommandReceipt,
} from "@gaia/core";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  Scope,
} from "effect";

import {
  DockerSandboxCli,
  type DockerSandboxCliService,
} from "./docker-sandbox-cli.js";
import { RuntimePathSchema, type RuntimePath } from "./paths.js";
import {
  type VerificationExecutionProfileV1,
  verificationExecutionProfileDigests,
} from "./verification-execution-profile.js";
import {
  observeWorkspaceStructuralDigest,
  WorkspaceStructuralObservationSchema,
} from "./workspace-snapshot.js";

const ObservedExitCodeSchema = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
);
const parseContentDigest = Schema.decodeUnknownSync(ContentDigestSchema);

/** Structural completion reported by the trusted Docker Sandbox CLI adapter. */
export const DockerSandboxExecOutcomeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("exited"),
    observedExitCode: ObservedExitCodeSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("hostSpawnFailure"),
    stage: Schema.Literals(["preflight", "dispatch"]),
  }),
]);

export type DockerSandboxExecOutcome =
  typeof DockerSandboxExecOutcomeSchema.Type;

export type DockerSandboxExecClassification =
  | {
      readonly status: "succeeded";
      readonly exitCode: 0;
      readonly observedProviderExitCode: 0;
    }
  | {
      readonly status: "nonZero";
      readonly exitCode: number;
      readonly observedProviderExitCode: number;
    }
  | {
      readonly status: "missingExecutable";
      readonly observedProviderExitCode: 127;
    }
  | {
      readonly status: "spawnFailed";
      readonly observedProviderExitCode: 126;
    }
  | {
      readonly kind: "providerFailure";
      readonly code: "VerificationProviderFailure";
      readonly observedProviderExitCode?: 125;
      readonly retryable: false;
    }
  | {
      readonly kind: "outcomeUnknown";
      readonly code: "VerificationCommandOutcomeUnknown";
      readonly retryable: false;
    };

const parseDockerSandboxExecOutcome = Schema.decodeUnknownSync(
  DockerSandboxExecOutcomeSchema,
  { onExcessProperty: "error" }
);

/**
 * Classify only structural provider completion data. The adapter intentionally
 * has no stderr input, so human-formatted provider output cannot affect the
 * durable command outcome.
 */
export function classifyDockerSandboxExecOutcome(
  input: DockerSandboxExecOutcome
): DockerSandboxExecClassification {
  const outcome = parseDockerSandboxExecOutcome(input);
  if (outcome.kind === "hostSpawnFailure") {
    return outcome.stage === "preflight"
      ? {
          code: "VerificationProviderFailure",
          kind: "providerFailure",
          retryable: false,
        }
      : {
          code: "VerificationCommandOutcomeUnknown",
          kind: "outcomeUnknown",
          retryable: false,
        };
  }
  if (outcome.observedExitCode === 0) {
    return {
      exitCode: 0,
      observedProviderExitCode: 0,
      status: "succeeded",
    };
  }
  if (outcome.observedExitCode === 125) {
    return {
      code: "VerificationProviderFailure",
      kind: "providerFailure",
      observedProviderExitCode: 125,
      retryable: false,
    };
  }
  if (outcome.observedExitCode === 126) {
    return {
      observedProviderExitCode: 126,
      status: "spawnFailed",
    };
  }
  if (outcome.observedExitCode === 127) {
    return {
      observedProviderExitCode: 127,
      status: "missingExecutable",
    };
  }
  return {
    exitCode: outcome.observedExitCode,
    observedProviderExitCode: outcome.observedExitCode,
    status: "nonZero",
  };
}

export class VerificationProviderFailure extends Schema.TaggedErrorClass<VerificationProviderFailure>()(
  "VerificationProviderFailure",
  {
    code: Schema.Literal("VerificationProviderFailure"),
    message: Schema.NonEmptyString,
    observedProviderExitCode: Schema.optionalKey(Schema.Literal(125)),
    recoverable: Schema.Literal(false),
  }
) {}

export class VerificationCommandOutcomeUnknown extends Schema.TaggedErrorClass<VerificationCommandOutcomeUnknown>()(
  "VerificationCommandOutcomeUnknown",
  {
    code: Schema.Literal("VerificationCommandOutcomeUnknown"),
    message: Schema.NonEmptyString,
    recoverable: Schema.Literal(false),
  }
) {}

const DockerSandboxCreatedIdentitySchema = Schema.Struct({
  sandboxName: VerificationSandboxNameSchema,
  sandboxUuid: VerificationSandboxUuidSchema,
});
type DockerSandboxCreatedIdentity = Schema.Schema.Type<
  typeof DockerSandboxCreatedIdentitySchema
>;
type OnDockerSandboxCreated = (
  created: DockerSandboxCreatedIdentity
) => Effect.Effect<
  void,
  VerificationCommandOutcomeUnknown,
  FileSystem.FileSystem | Path.Path
>;
const OnDockerSandboxCreatedSchema = Schema.declare<OnDockerSandboxCreated>(
  (input): input is OnDockerSandboxCreated => typeof input === "function"
);
const VerificationContractIdSchema = Schema.Union([
  RunContractIdSchema,
  RunContractIdV2Schema,
]);
export const DockerSandboxVerificationInvocationSchema = Schema.Struct({
  authorityDigest: VerificationIdentityDigestSchema,
  claimId: ProofClaimIdSchema,
  contractDigest: RunContractDigestSchema,
  contractId: VerificationContractIdSchema,
  executionEvidenceIdentityDigest: VerificationIdentityDigestSchema,
  generationSequence: RunEventSequenceSchema,
  onSandboxCreated: OnDockerSandboxCreatedSchema,
  request: VerificationCommandRequestV1,
  runId: RunIdSchema,
  sandboxName: VerificationSandboxNameSchema,
  stderrArtifactPath: RunRelativeArtifactPathSchema,
  stderrPath: RuntimePathSchema,
  stdoutArtifactPath: RunRelativeArtifactPathSchema,
  stdoutPath: RuntimePathSchema,
  targetDigest: StructuralDigestSchema,
  workspace: RuntimePathSchema,
});
export type DockerSandboxVerificationInvocation =
  typeof DockerSandboxVerificationInvocationSchema.Encoded;
type ParsedDockerSandboxVerificationInvocation =
  typeof DockerSandboxVerificationInvocationSchema.Type;

const StagedOutputEvidenceSchema = Schema.Struct({
  artifactPath: RunRelativeArtifactPathSchema,
  contentDigest: ContentDigestSchema,
  observedByteCount: Schema.Int,
  retainedByteCount: Schema.Int,
  truncated: Schema.Boolean,
});
type StagedOutputEvidence = Schema.Schema.Type<
  typeof StagedOutputEvidenceSchema
>;
export const StagedDockerSandboxVerificationReceiptSchema = Schema.Struct({
  cleanup: VerificationCleanupEvidenceV1,
  durationMs: Schema.Int,
  exitCode: Schema.optionalKey(Schema.Int),
  observedProviderExitCode: Schema.optionalKey(ObservedExitCodeSchema),
  sandboxUuid: VerificationSandboxUuidSchema,
  status: Schema.Literals([
    "succeeded",
    "nonZero",
    "timedOut",
    "interrupted",
    "outputLimitExceeded",
    "missingExecutable",
    "spawnFailed",
  ] as const),
  stderr: StagedOutputEvidenceSchema,
  stdout: StagedOutputEvidenceSchema,
  workspaceObservation: WorkspaceStructuralObservationSchema,
});
export type StagedDockerSandboxVerificationReceipt = Schema.Schema.Type<
  typeof StagedDockerSandboxVerificationReceiptSchema
>;

export type DockerSandboxVerificationError =
  | VerificationProviderFailure
  | VerificationCommandOutcomeUnknown;

export type DockerSandboxVerificationExecutorService = {
  readonly execute: (
    invocation: DockerSandboxVerificationInvocation
  ) => Effect.Effect<
    StagedDockerSandboxVerificationReceipt,
    DockerSandboxVerificationError,
    FileSystem.FileSystem | Path.Path | Scope.Scope
  >;
  readonly reconcile: (
    invocation: DockerSandboxVerificationReconciliationInvocation
  ) => Effect.Effect<
    typeof VerificationReconciliationReceiptV1.Type,
    DockerSandboxVerificationError
  >;
};

export const DockerSandboxVerificationReconciliationInvocationSchema =
  Schema.Struct({
    actionId: DeliveryActionIdSchema,
    claimId: ProofClaimIdSchema,
    contractDigest: RunContractDigestSchema,
    executionEvidenceIdentityDigest: VerificationIdentityDigestSchema,
    generationSequence: RunEventSequenceSchema,
    reason: Schema.Literals([
      "createdWithoutCommandStart",
      "commandStartOutcomeUnknown",
    ] as const),
    runId: RunIdSchema,
    sandboxName: VerificationSandboxNameSchema,
    sandboxUuid: VerificationSandboxUuidSchema,
  });
export type DockerSandboxVerificationReconciliationInvocation =
  typeof DockerSandboxVerificationReconciliationInvocationSchema.Encoded;
const parseDockerSandboxVerificationInvocation = Schema.decodeUnknownSync(
  DockerSandboxVerificationInvocationSchema
);
const parseDockerSandboxVerificationReconciliationInvocation =
  Schema.decodeUnknownSync(
    DockerSandboxVerificationReconciliationInvocationSchema
  );

export class DockerSandboxVerificationExecutor extends Context.Service<
  DockerSandboxVerificationExecutor,
  DockerSandboxVerificationExecutorService
>()("@gaia/runtime/DockerSandboxVerificationExecutor") {}

export function DockerSandboxVerificationExecutorLive(
  profile: VerificationExecutionProfileV1
) {
  return Layer.effect(
    DockerSandboxVerificationExecutor,
    Effect.gen(function* () {
      const cli = yield* DockerSandboxCli;
      return DockerSandboxVerificationExecutor.of({
        execute: (invocation) =>
          executeDockerSandboxVerification(invocation, cli, profile),
        reconcile: (invocation) =>
          reconcileDockerSandboxVerification(invocation, cli, profile),
      });
    })
  );
}

export function makeDockerSandboxVerificationExecutor(
  cli: DockerSandboxCliService,
  profile: VerificationExecutionProfileV1
) {
  return DockerSandboxVerificationExecutor.of({
    execute: (invocation) =>
      executeDockerSandboxVerification(invocation, cli, profile),
    reconcile: (invocation) =>
      reconcileDockerSandboxVerification(invocation, cli, profile),
  });
}

/** Reconcile only an exact prior identity; this path never creates or executes. */
export function reconcileDockerSandboxVerification(
  input: DockerSandboxVerificationReconciliationInvocation,
  cli: DockerSandboxCliService,
  profile: VerificationExecutionProfileV1
) {
  const invocation =
    parseDockerSandboxVerificationReconciliationInvocation(input);
  return Effect.gen(function* () {
    yield* preflight(cli, profile);
    let listCount = 1;
    let stopCount: 0 | 1 = 0;
    let removeCount: 0 | 1 = 0;
    let observations = yield* listSandboxes(cli, "preflight");
    const uuidObservation = observations.find(
      (entry) => entry.uuid === invocation.sandboxUuid
    );
    if (
      uuidObservation !== undefined &&
      uuidObservation.name !== invocation.sandboxName
    )
      return yield* outcomeUnknown(
        "The prior sandbox UUID is now bound to another name."
      );
    let exact = findSandbox(observations, invocation.sandboxName);
    if (exact !== undefined && exact.uuid !== invocation.sandboxUuid)
      return yield* outcomeUnknown(
        "The prior sandbox name is now bound to another UUID."
      );
    if (exact !== undefined) {
      if (exact.status !== "stopped") {
        const stopped = yield* cli
          .stop(invocation.sandboxName)
          .pipe(Effect.result);
        stopCount = 1;
        if (Result.isFailure(stopped) || stopped.success.exitCode !== 0)
          return yield* outcomeUnknown(
            "Exact sandbox stop could not be confirmed during reconciliation."
          );
        observations = yield* listSandboxes(cli, "dispatch");
        listCount += 1;
        exact = findSandbox(observations, invocation.sandboxName);
        if (
          exact?.uuid !== invocation.sandboxUuid ||
          exact.status !== "stopped"
        )
          return yield* outcomeUnknown(
            "Exact sandbox stop observation drifted during reconciliation."
          );
      }
      const removed = yield* cli
        .remove(invocation.sandboxName)
        .pipe(Effect.result);
      removeCount = 1;
      if (Result.isFailure(removed) || removed.success.exitCode !== 0)
        return yield* outcomeUnknown(
          "Exact sandbox removal could not be confirmed during reconciliation."
        );
    }
    const final = yield* listSandboxes(cli, "dispatch");
    listCount += 1;
    if (
      findSandbox(final, invocation.sandboxName) !== undefined ||
      final.some((entry) => entry.uuid === invocation.sandboxUuid)
    )
      return yield* outcomeUnknown(
        "Exact sandbox final absence could not be confirmed during reconciliation."
      );
    const base = {
      ...invocation,
      finalAbsenceConfirmed: true as const,
      operationCounts: {
        create: 0 as const,
        exec: 0 as const,
        list: listCount,
        redispatch: 0 as const,
        remove: removeCount,
        stop: stopCount,
      },
    };
    const receiptDigest = makeVerificationReconciliationReceiptDigest(base);
    return Schema.decodeUnknownSync(VerificationReconciliationReceiptV1)({
      ...base,
      receiptDigest,
    });
  });
}

export function executeDockerSandboxVerification(
  input: DockerSandboxVerificationInvocation,
  cli: DockerSandboxCliService,
  profile: VerificationExecutionProfileV1
): Effect.Effect<
  StagedDockerSandboxVerificationReceipt,
  DockerSandboxVerificationError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const invocation = parseDockerSandboxVerificationInvocation(input);
  return Effect.gen(function* () {
    yield* assertInvocationMatchesProfile(invocation, profile);
    yield* preflight(cli, profile);
    const initial = yield* listSandboxes(cli, "preflight");
    if (findSandbox(initial, invocation.sandboxName) !== undefined)
      return yield* providerFailure(
        "The deterministic verification sandbox name is already present."
      );

    const create = yield* cli
      .create({
        name: invocation.sandboxName,
        templateReference: profile.templateReference,
        workspace: invocation.workspace,
      })
      .pipe(Effect.result);
    if (Result.isFailure(create) || create.success.exitCode !== 0)
      return yield* outcomeUnknown(
        "Sandbox creation was dispatched but its outcome is not authoritative."
      );

    const afterCreate = yield* listSandboxes(cli, "dispatch");
    const created = findSandbox(afterCreate, invocation.sandboxName);
    if (created === undefined)
      return yield* outcomeUnknown(
        "Sandbox creation returned without an exact name and UUID observation."
      );
    let finalized = false;
    yield* Effect.addFinalizer(() =>
      finalized
        ? Effect.void
        : cleanupSandbox(cli, invocation.sandboxName, created.uuid).pipe(
            Effect.ignore
          )
    );
    yield* invocation.onSandboxCreated({
      sandboxName: invocation.sandboxName,
      sandboxUuid: created.uuid,
    });

    const startedAt = yield* Clock.currentTimeMillis;
    const executable = profile.executables[0].sandboxPath;
    const command = cli.execute({
      argv: [
        profile.credentials.environmentScrubExecutable,
        "-i",
        `PATH=${profile.credentials.minimalPath}`,
        executable,
        ...invocation.request.argv,
      ],
      name: invocation.sandboxName,
      workdir: invocation.workspace,
    });
    const attempted = yield* command.pipe(
      Effect.timeoutOption(invocation.request.timeoutMs),
      Effect.result
    );
    const finishedAt = yield* Clock.currentTimeMillis;

    const stoppedSandboxUuid = yield* stopSandbox(
      cli,
      invocation.sandboxName,
      created.uuid
    );
    const workspaceObservation = yield* observeWorkspaceStructuralDigest(
      invocation.workspace
    ).pipe(
      Effect.mapError(
        () =>
          new VerificationProviderFailure({
            code: "VerificationProviderFailure",
            message: "Post-stop no-follow workspace observation failed.",
            recoverable: false,
          })
      )
    );
    const cleanup = yield* removeSandbox(
      cli,
      invocation.sandboxName,
      created.uuid,
      stoppedSandboxUuid
    );
    finalized = true;

    if (Result.isFailure(attempted))
      return yield* outcomeUnknown(
        "Sandbox command dispatch lost structural provider acknowledgement."
      );
    const result = Option.getOrUndefined(attempted.success);
    const classification =
      result === undefined
        ? ({ status: "timedOut" } as const)
        : classifyDockerSandboxExecOutcome({
            kind: "exited",
            observedExitCode: result.exitCode,
          });
    if ("kind" in classification) {
      if (classification.kind === "providerFailure")
        return yield* Effect.fail(
          new VerificationProviderFailure({
            code: "VerificationProviderFailure",
            message:
              "The trusted environment scrub failed before command start.",
            ...(classification.observedProviderExitCode === undefined
              ? {}
              : {
                  observedProviderExitCode:
                    classification.observedProviderExitCode,
                }),
            recoverable: false,
          })
        );
      return yield* outcomeUnknown(
        "Sandbox command dispatch outcome is structurally unknown."
      );
    }

    const output = result ?? { exitCode: 0, stderr: "", stdout: "" };
    const totalBytes =
      Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr);
    const outputLimitExceeded =
      totalBytes > invocation.request.outputLimitBytes;
    const retained = retainCombinedOutput(
      output.stdout,
      output.stderr,
      invocation.request.outputLimitBytes
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFile(invocation.stdoutPath, retained.stdout);
    yield* fs.writeFile(invocation.stderrPath, retained.stderr);
    const stdout = outputEvidence(
      invocation.stdoutArtifactPath,
      Buffer.from(output.stdout),
      retained.stdout
    );
    const stderr = outputEvidence(
      invocation.stderrArtifactPath,
      Buffer.from(output.stderr),
      retained.stderr
    );
    return {
      cleanup,
      durationMs: Math.max(0, finishedAt - startedAt),
      ...(classification.status === "succeeded" ||
      classification.status === "nonZero"
        ? { exitCode: classification.exitCode }
        : {}),
      ...("observedProviderExitCode" in classification
        ? { observedProviderExitCode: classification.observedProviderExitCode }
        : {}),
      sandboxUuid: created.uuid,
      status: outputLimitExceeded
        ? ("outputLimitExceeded" as const)
        : classification.status,
      stderr,
      stdout,
      workspaceObservation,
    };
  }).pipe(
    Effect.catchTag("PlatformError", () =>
      providerFailure("Verification evidence files could not be persisted.")
    )
  );
}

export function finalizeDockerSandboxVerificationReceipt(
  input: DockerSandboxVerificationInvocation,
  staged: StagedDockerSandboxVerificationReceipt,
  profile: VerificationExecutionProfileV1,
  commandStartSequence: number,
  terminalSequence: number
): VerificationCommandReceipt {
  const invocation = parseDockerSandboxVerificationInvocation(input);
  const requestDigest = makeVerificationCommandRequestDigest(
    invocation.request
  );
  const profileDigests = verificationExecutionProfileDigests(profile);
  const environmentDigest = digest("gaia.verification-environment.v1", [
    profile.credentials.environmentScrubExecutable,
    profile.credentials.minimalPath,
  ]);
  const common = {
    argumentCount: invocation.request.argv.length,
    authorityDigest: invocation.authorityDigest,
    cleanup: staged.cleanup,
    claimId: invocation.claimId,
    commandIdentityDigest: digest("gaia.verification-command-identity.v1", [
      invocation.request.executableId,
      requestDigest,
    ]),
    commandStartSequence,
    contractDigest: invocation.contractDigest,
    contractId: invocation.contractId,
    credentialProfileDigest: profileDigests.credentialProfileDigest,
    durationMs: staged.durationMs,
    environmentDigest,
    executableId: invocation.request.executableId,
    executionEvidenceIdentityDigest: invocation.executionEvidenceIdentityDigest,
    executionProfileDigest: profileDigests.profileDigest,
    generationSequence: invocation.generationSequence,
    imageDigest: profile.imageDigest,
    network: invocation.request.network,
    policyDigest: profileDigests.policyDigest,
    providerBuild: profile.provider.build,
    providerId: profile.provider.providerId,
    providerVersion: profile.provider.version,
    requestDigest,
    runId: invocation.runId,
    sandboxName: invocation.sandboxName,
    sandboxUuid: staged.sandboxUuid,
    stderr: staged.stderr,
    stdout: staged.stdout,
    targetDigest: invocation.targetDigest,
    templateReference: profile.templateReference,
    terminalSequence,
    workspace: invocation.request.workingDirectory,
  };
  const variant =
    staged.status === "succeeded"
      ? { ...common, exitCode: 0, status: "succeeded" as const }
      : staged.status === "nonZero"
        ? {
            ...common,
            exitCode: staged.exitCode,
            status: "nonZero" as const,
          }
        : staged.status === "missingExecutable"
          ? {
              ...common,
              observedProviderExitCode: 127,
              status: "missingExecutable" as const,
            }
          : staged.status === "spawnFailed"
            ? {
                ...common,
                observedProviderExitCode: 126,
                spawnStage: "commandStart" as const,
                status: "spawnFailed" as const,
              }
            : { ...common, status: staged.status };
  const receiptDigest = makeVerificationCommandReceiptDigest(variant);
  return parseVerificationCommandReceipt({ ...variant, receiptDigest });
}

function assertInvocationMatchesProfile(
  invocation: ParsedDockerSandboxVerificationInvocation,
  profile: VerificationExecutionProfileV1
) {
  return Effect.try({
    catch: () =>
      new VerificationProviderFailure({
        code: "VerificationProviderFailure",
        message:
          "Verification request does not match the trusted execution profile.",
        recoverable: false,
      }),
    try: () => {
      const request = invocation.request;
      if (
        request.executableId !== profile.executables[0].executableId ||
        request.network !== profile.policy.network ||
        request.credentials !== profile.credentials.mode ||
        request.workspaceAccess !== "read-write" ||
        request.workingDirectory !== "."
      )
        throw new Error("Trusted execution profile mismatch.");
      makeVerificationCommandRequestDigest(request);
      verificationExecutionProfileDigests(profile);
    },
  });
}

function preflight(
  cli: DockerSandboxCliService,
  profile: VerificationExecutionProfileV1
) {
  return Effect.gen(function* () {
    const version = yield* cli.version.pipe(
      Effect.mapError(
        () =>
          new VerificationProviderFailure({
            code: "VerificationProviderFailure",
            message: "Pinned Docker Sandbox CLI is unavailable.",
            recoverable: false,
          })
      )
    );
    const expected = `sbx version: v${profile.provider.version} ${profile.provider.build}`;
    if (version.exitCode !== 0 || version.stdout.trim() !== expected)
      return yield* providerFailure(
        "Docker Sandbox CLI version or build does not match the trusted profile."
      );
    const policy = yield* cli.policyList.pipe(
      Effect.mapError(
        () =>
          new VerificationProviderFailure({
            code: "VerificationProviderFailure",
            message: "Docker Sandbox policy could not be inspected.",
            recoverable: false,
          })
      )
    );
    if (policy.exitCode !== 0 || !hasExactDenyAllNetworkPolicy(policy.stdout))
      return yield* providerFailure(
        "Docker Sandbox deny-all network policy is missing or drifted."
      );
  });
}

const SandboxObservationSchema = Schema.Struct({
  name: VerificationSandboxNameSchema,
  status: Schema.NonEmptyString,
  uuid: VerificationSandboxUuidSchema,
});
type SandboxObservation = Schema.Schema.Type<typeof SandboxObservationSchema>;
const SandboxListWireSchema = Schema.Struct({
  sandboxes: Schema.Array(
    Schema.Struct({
      id: Schema.optionalKey(VerificationSandboxUuidSchema),
      name: VerificationSandboxNameSchema,
      status: Schema.NonEmptyString,
      uuid: Schema.optionalKey(VerificationSandboxUuidSchema),
    })
  ),
});
const parseSandboxListWire = Schema.decodeUnknownSync(SandboxListWireSchema);
const DockerSandboxPolicyListSchema = Schema.Struct({
  rules: Schema.optionalKey(
    Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
  ),
});
const parseDockerSandboxPolicyList = Schema.decodeUnknownSync(
  DockerSandboxPolicyListSchema
);

function listSandboxes(
  cli: DockerSandboxCliService,
  stage: "preflight" | "dispatch"
) {
  return cli.list.pipe(
    Effect.mapError((error) =>
      stage === "preflight"
        ? new VerificationProviderFailure({
            code: "VerificationProviderFailure",
            message: "Docker Sandbox list preflight failed.",
            recoverable: false,
          })
        : new VerificationCommandOutcomeUnknown({
            code: "VerificationCommandOutcomeUnknown",
            message:
              "Docker Sandbox identity observation failed after dispatch.",
            recoverable: false,
          })
    ),
    Effect.flatMap((result) =>
      result.exitCode !== 0
        ? stage === "preflight"
          ? providerFailure("Docker Sandbox list preflight was rejected.")
          : outcomeUnknown("Docker Sandbox list failed after dispatch.")
        : Effect.try({
            catch: () =>
              stage === "preflight"
                ? new VerificationProviderFailure({
                    code: "VerificationProviderFailure",
                    message: "Docker Sandbox list returned malformed JSON.",
                    recoverable: false,
                  })
                : new VerificationCommandOutcomeUnknown({
                    code: "VerificationCommandOutcomeUnknown",
                    message:
                      "Docker Sandbox list was malformed after dispatch.",
                    recoverable: false,
                  }),
            try: () => parseSandboxList(result.stdout),
          })
    )
  );
}

function parseSandboxList(body: string): ReadonlyArray<SandboxObservation> {
  const parsed = parseSandboxListWire(JSON.parse(body));
  return parsed.sandboxes.map((value) => {
    const uuid = value.uuid ?? value.id;
    if (uuid === undefined)
      throw new Error("Sandbox identity fields are malformed.");
    return Schema.decodeUnknownSync(SandboxObservationSchema)({
      name: value.name,
      status: value.status,
      uuid,
    });
  });
}

function findSandbox(
  observations: ReadonlyArray<SandboxObservation>,
  name: string
) {
  const matches = observations.filter((entry) => entry.name === name);
  if (matches.length > 1) throw new Error("Sandbox name is not unique.");
  return matches[0];
}

function cleanupSandbox(
  cli: DockerSandboxCliService,
  name: string,
  uuid: string
): Effect.Effect<
  StagedDockerSandboxVerificationReceipt["cleanup"],
  DockerSandboxVerificationError
> {
  return Effect.gen(function* () {
    const stoppedSandboxUuid = yield* stopSandbox(cli, name, uuid);
    return yield* removeSandbox(cli, name, uuid, stoppedSandboxUuid);
  });
}

function stopSandbox(cli: DockerSandboxCliService, name: string, uuid: string) {
  return Effect.gen(function* () {
    const beforeStop = yield* listSandboxes(cli, "dispatch");
    const observed = findSandbox(beforeStop, name);
    if (observed?.uuid !== uuid)
      return yield* outcomeUnknown(
        "Sandbox name no longer resolves to the created UUID."
      );
    if (observed.status !== "stopped") {
      const stop = yield* cli.stop(name).pipe(Effect.result);
      if (Result.isFailure(stop) || stop.success.exitCode !== 0)
        return yield* outcomeUnknown("Sandbox stop outcome is unknown.");
    }
    const stoppedList = yield* listSandboxes(cli, "dispatch");
    const stopped = findSandbox(stoppedList, name);
    if (stopped?.uuid !== uuid || stopped.status !== "stopped")
      return yield* outcomeUnknown(
        "Sandbox stop could not be confirmed for the created UUID."
      );
    return uuid;
  });
}

function removeSandbox(
  cli: DockerSandboxCliService,
  name: string,
  uuid: string,
  stoppedSandboxUuid: string
) {
  return Effect.gen(function* () {
    const beforeRemove = yield* listSandboxes(cli, "dispatch");
    const stopped = findSandbox(beforeRemove, name);
    if (stopped?.uuid !== uuid || stopped.status !== "stopped")
      return yield* outcomeUnknown("Sandbox identity drifted before removal.");
    const remove = yield* cli.remove(name).pipe(Effect.result);
    if (Result.isFailure(remove) || remove.success.exitCode !== 0)
      return yield* outcomeUnknown("Sandbox removal outcome is unknown.");
    const finalList = yield* listSandboxes(cli, "dispatch");
    if (findSandbox(finalList, name) !== undefined)
      return yield* outcomeUnknown(
        "Sandbox final absence could not be confirmed."
      );
    return {
      finalAbsenceConfirmed: true as const,
      removedSandboxUuid: uuid,
      stoppedSandboxUuid,
    };
  });
}

function hasExactDenyAllNetworkPolicy(body: string) {
  const parsed = parseDockerSandboxPolicyList(JSON.parse(body));
  const activeNetwork = (parsed.rules ?? []).filter(
    (rule) => rule["resource_type"] === "network" && rule["status"] === "active"
  );
  return (
    activeNetwork.filter((rule) => rule["decision"] === "allow").length === 0 &&
    activeNetwork.some(
      (rule) =>
        rule["decision"] === "deny" &&
        Array.isArray(rule["resources"]) &&
        rule["resources"].length === 1 &&
        rule["resources"][0] === "**"
    )
  );
}

function outputEvidence(
  artifactPath: typeof RunRelativeArtifactPathSchema.Type,
  observed: Uint8Array,
  retained: Uint8Array
): StagedOutputEvidence {
  return {
    artifactPath,
    contentDigest: parseContentDigest(
      createHash("sha256").update(retained).digest("hex")
    ),
    observedByteCount: observed.byteLength,
    retainedByteCount: retained.byteLength,
    truncated: observed.byteLength !== retained.byteLength,
  };
}

function retainCombinedOutput(stdout: string, stderr: string, cap: number) {
  const stdoutBytes = Buffer.from(stdout);
  const retainedStdout = stdoutBytes.subarray(0, cap);
  const remaining = Math.max(0, cap - retainedStdout.byteLength);
  const retainedStderr = Buffer.from(stderr).subarray(0, remaining);
  return {
    stderr: retainedStderr,
    stdout: retainedStdout,
  };
}

function digest(domain: string, fields: readonly unknown[]) {
  return createHash("sha256").update(canonicalV1(domain, fields)).digest("hex");
}

function providerFailure(message: string) {
  return Effect.fail(
    new VerificationProviderFailure({
      code: "VerificationProviderFailure",
      message,
      recoverable: false,
    })
  );
}

function outcomeUnknown(message: string) {
  return Effect.fail(
    new VerificationCommandOutcomeUnknown({
      code: "VerificationCommandOutcomeUnknown",
      message,
      recoverable: false,
    })
  );
}
