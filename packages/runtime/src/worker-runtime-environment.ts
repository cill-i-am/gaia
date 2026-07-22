import {
  GaiaRuntimeSourceIdentityV1,
  HarnessEnvironmentAssignmentV1,
  HarnessLaunchObservationV1,
  digestHarnessEnvironmentContract,
  type HarnessCapabilities,
  type HarnessProviderDescriptor,
  type HarnessSessionId,
} from "@gaia/core";
import {
  Config,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const BoundedText = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(4_096))
);
export const WorkerRuntimeProviderVersionSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(200)),
  Schema.brand("WorkerRuntimeProviderVersion")
);
export type WorkerRuntimeProviderVersion =
  typeof WorkerRuntimeProviderVersionSchema.Type;
export const parseWorkerRuntimeProviderVersion = Schema.decodeUnknownSync(
  WorkerRuntimeProviderVersionSchema
);

/** Immutable named configuration for the production worker runtime. */
export class WorkerRuntimeConfigValue extends Schema.Class<WorkerRuntimeConfigValue>(
  "WorkerRuntimeConfigValue"
)(
  {
    adapterVersion: Schema.NonEmptyString,
    codexArgs: Schema.Array(BoundedText).pipe(
      Schema.check(Schema.isMaxLength(16))
    ),
    codexCommand: BoundedText,
    codexModel: BoundedText,
    codexModelProvider: BoundedText,
    codexReasoningEffort: BoundedText,
    expectedRepositoryIdentity: BoundedText,
    originatorOverride: BoundedText,
    path: BoundedText,
    runtimeSourceRoot: BoundedText,
  },
  strict
) {}

/** Parsed worker configuration service; no ambient environment object enters. */
export class WorkerRuntimeConfig extends Context.Service<
  WorkerRuntimeConfig,
  WorkerRuntimeConfigValue
>()("@gaia/runtime/WorkerRuntimeConfig") {}

const parseWorkerRuntimeConfig = Schema.decodeUnknownSync(
  WorkerRuntimeConfigValue
);

/** Live named-config Layer for the production local worker. */
export const WorkerRuntimeConfigLive = Layer.effect(
  WorkerRuntimeConfig,
  Effect.gen(function* () {
    const values = yield* Config.all({
      adapterVersion: Config.string("GAIA_CODEX_ADAPTER_VERSION").pipe(
        Config.withDefault("1")
      ),
      codexArgs: Config.string("GAIA_CODEX_APP_SERVER_ARGS").pipe(
        Config.withDefault('["app-server","--listen","stdio://"]')
      ),
      codexCommand: Config.string("GAIA_CODEX_EXECUTABLE").pipe(
        Config.withDefault("codex")
      ),
      codexModel: Config.string("GAIA_CODEX_MODEL").pipe(
        Config.withDefault("gpt-5.6-codex")
      ),
      codexModelProvider: Config.string("GAIA_CODEX_MODEL_PROVIDER").pipe(
        Config.withDefault("openai")
      ),
      codexReasoningEffort: Config.string("GAIA_CODEX_REASONING_EFFORT").pipe(
        Config.withDefault("high")
      ),
      expectedRepositoryIdentity: Config.string(
        "GAIA_RUNTIME_REPOSITORY_IDENTITY"
      ).pipe(Config.withDefault("cill-i-am/gaia")),
      originatorOverride: Config.string(
        "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
      ).pipe(Config.withDefault("Codex Desktop")),
      path: Config.string("PATH"),
      runtimeSourceRoot: Config.string("GAIA_RUNTIME_SOURCE_ROOT").pipe(
        Config.withDefault(".")
      ),
    });
    const codexArgs = yield* Effect.try({
      try: () => JSON.parse(values.codexArgs),
      catch: () => new Error("Invalid Codex App Server argument config."),
    });
    return parseWorkerRuntimeConfig({ ...values, codexArgs });
  })
);

/** Safe typed failure from production runtime-source attestation. */
export class WorkerRuntimeEnvironmentError extends Schema.TaggedErrorClass<WorkerRuntimeEnvironmentError>()(
  "WorkerRuntimeEnvironmentError",
  {
    code: Schema.Literals([
      "commandFailed",
      "dirtySource",
      "repositoryMismatch",
      "revisionUnavailable",
      "topLevelMismatch",
    ] as const),
    message: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256))),
  }
) {}

/** Effect-owned proof service for exact clean Gaia runtime source identity. */
export class WorkerRuntimeEnvironmentService extends Context.Service<
  WorkerRuntimeEnvironmentService,
  {
    readonly assignment: (
      provider: HarnessProviderDescriptor,
      capabilities: HarnessCapabilities,
      providerVersion: WorkerRuntimeProviderVersion
    ) => Effect.Effect<
      HarnessEnvironmentAssignmentV1,
      WorkerRuntimeEnvironmentError
    >;
    readonly sourceIdentity: Effect.Effect<
      GaiaRuntimeSourceIdentityV1,
      WorkerRuntimeEnvironmentError
    >;
  }
>()("@gaia/runtime/WorkerRuntimeEnvironmentService") {}

/** Live clean-source proof and accepted-assignment Layer. */
export const WorkerRuntimeEnvironmentLive = Layer.effect(
  WorkerRuntimeEnvironmentService,
  Effect.gen(function* () {
    const config = yield* WorkerRuntimeConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runGit = (args: ReadonlyArray<string>) =>
      runBoundedCommand(spawner, "git", [
        "-C",
        config.runtimeSourceRoot,
        ...args,
      ]);
    const sourceIdentity = Effect.gen(function* () {
      const configuredRoot = yield* fs
        .realPath(config.runtimeSourceRoot)
        .pipe(Effect.mapError(() => environmentError("topLevelMismatch")));
      const rawTopLevel = yield* runGit(["rev-parse", "--show-toplevel"]);
      const topLevel = yield* fs
        .realPath(rawTopLevel.trim())
        .pipe(Effect.mapError(() => environmentError("topLevelMismatch")));
      if (path.normalize(topLevel) !== path.normalize(configuredRoot))
        return yield* Effect.fail(environmentError("topLevelMismatch"));

      const remote = yield* runGit(["config", "--get", "remote.origin.url"]);
      const repositoryIdentity = normalizeRepositoryIdentity(remote);
      if (repositoryIdentity !== config.expectedRepositoryIdentity)
        return yield* Effect.fail(environmentError("repositoryMismatch"));

      const revision = (yield* runGit([
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ])).trim();
      if (!/^[a-f0-9]{40}$/u.test(revision))
        return yield* Effect.fail(environmentError("revisionUnavailable"));

      const status = yield* runGit([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ]);
      if (status.length !== 0)
        return yield* Effect.fail(environmentError("dirtySource"));

      return GaiaRuntimeSourceIdentityV1.make({
        repositoryIdentity,
        revision,
        sourceState: "clean",
      });
    });
    return WorkerRuntimeEnvironmentService.of({
      assignment: (provider, capabilities, providerVersion) =>
        Effect.gen(function* () {
          const runtimeSource = yield* sourceIdentity;
          const stableWorkspaceAuthority = digestHarnessEnvironmentContract(
            "gaia.worker-workspace-authority.v1",
            [config.expectedRepositoryIdentity, ".gaia/runs/<runId>/workspace"]
          );
          const toolContractDigest = digestHarnessEnvironmentContract(
            "gaia.codex-harness-tool-contract.v1",
            [capabilities]
          );
          return HarnessEnvironmentAssignmentV1.make({
            adapter: {
              contractDigest: digestHarnessEnvironmentContract(
                "gaia.codex-app-server-adapter.v1",
                [config.adapterVersion, provider, capabilities]
              ),
              contractId: "gaia.codex-app-server",
              contractVersion: config.adapterVersion,
              providerNativeToolInventoryObservation: "notExposed",
              toolContractDigest,
            },
            authority: {
              approvalPolicy: "on-request",
              ephemeral: false,
              sandbox: "workspace-write",
              workspaceBindingDigest: stableWorkspaceAuthority,
            },
            effectDependencyEpoch: "4.0.0-beta.93",
            hostClass: "localGaiaServer",
            interfaceClass: "codexAppServerStdio",
            model: {
              id: config.codexModel,
              provider: config.codexModelProvider,
              reasoningEffort: config.codexReasoningEffort,
            },
            runtimeSource,
            version: 1,
          });
        }),
      sourceIdentity,
    });
  })
);

/** Scoped one-shot launch observation exchange keyed by one session attempt. */
export class HarnessLaunchObservationService extends Context.Service<
  HarnessLaunchObservationService,
  {
    readonly complete: (
      sessionId: HarnessSessionId,
      observation: HarnessLaunchObservationV1
    ) => Effect.Effect<void, HarnessLaunchObservationError>;
    readonly open: (
      sessionId: HarnessSessionId
    ) => Effect.Effect<void, HarnessLaunchObservationError>;
    readonly release: (sessionId: HarnessSessionId) => Effect.Effect<void>;
    readonly take: (
      sessionId: HarnessSessionId
    ) => Effect.Effect<
      HarnessLaunchObservationV1,
      HarnessLaunchObservationError
    >;
  }
>()("@gaia/runtime/HarnessLaunchObservationService") {}

/** Safe failure from a missing, duplicate, or released observation slot. */
export class HarnessLaunchObservationError extends Schema.TaggedErrorClass<HarnessLaunchObservationError>()(
  "HarnessLaunchObservationError",
  {
    message: Schema.Literal("Harness launch observation is unavailable."),
  }
) {}

/** Run-scoped one-shot observation service. */
export const HarnessLaunchObservationLive = Layer.effect(
  HarnessLaunchObservationService,
  Effect.gen(function* () {
    const slots = new Map<
      HarnessSessionId,
      Deferred.Deferred<
        HarnessLaunchObservationV1,
        HarnessLaunchObservationError
      >
    >();
    const unavailable = () =>
      new HarnessLaunchObservationError({
        message: "Harness launch observation is unavailable.",
      });
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        slots.values(),
        (slot) => Deferred.fail(slot, unavailable()),
        { discard: true }
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            slots.clear();
          })
        )
      )
    );
    return HarnessLaunchObservationService.of({
      complete: (sessionId, observation) =>
        Effect.gen(function* () {
          const slot = slots.get(sessionId);
          if (slot === undefined) return yield* Effect.fail(unavailable());
          const completed = yield* Deferred.succeed(slot, observation);
          if (!completed) return yield* Effect.fail(unavailable());
        }),
      open: (sessionId) =>
        Effect.gen(function* () {
          if (slots.has(sessionId)) return yield* Effect.fail(unavailable());
          slots.set(
            sessionId,
            yield* Deferred.make<
              HarnessLaunchObservationV1,
              HarnessLaunchObservationError
            >()
          );
        }),
      release: (sessionId) =>
        Effect.gen(function* () {
          const slot = slots.get(sessionId);
          slots.delete(sessionId);
          if (slot !== undefined) yield* Deferred.fail(slot, unavailable());
        }).pipe(Effect.asVoid),
      take: (sessionId) =>
        Effect.gen(function* () {
          const slot = slots.get(sessionId);
          if (slot === undefined) return yield* Effect.fail(unavailable());
          const observation = yield* Deferred.await(slot);
          slots.delete(sessionId);
          return observation;
        }),
    });
  })
);

function runBoundedCommand(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  args: ReadonlyArray<string>
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          stderr: "pipe",
          stdin: "ignore",
          stdout: "pipe",
        })
      );
      const observedBytes = yield* Ref.make(0);
      const collectBounded = (stream: Stream.Stream<Uint8Array, unknown>) =>
        Stream.runFoldEffect(
          stream,
          () => [] as Array<Uint8Array>,
          (chunks, chunk) =>
            Ref.modify(observedBytes, (current) => {
              const next = current + chunk.byteLength;
              return [next <= 65_536, next] as const;
            }).pipe(
              Effect.flatMap((withinLimit) =>
                withinLimit
                  ? Effect.succeed([...chunks, chunk])
                  : Effect.fail(environmentError("commandFailed"))
              )
            )
        ).pipe(Effect.map((chunks) => Buffer.concat(chunks).toString("utf8")));
      const stdoutFiber = yield* collectBounded(handle.stdout).pipe(
        Effect.forkScoped
      );
      const stderrFiber = yield* collectBounded(handle.stderr).pipe(
        Effect.forkScoped
      );
      const exitCode = yield* handle.exitCode;
      const stdout = yield* Fiber.join(stdoutFiber);
      const stderr = yield* Fiber.join(stderrFiber);
      if (Number(exitCode) !== 0)
        return yield* Effect.fail(environmentError("commandFailed"));
      return stdout;
    })
  ).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError(() => environmentError("commandFailed"))
  );
}

function normalizeRepositoryIdentity(raw: string) {
  const value = raw
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\.git$/u, "");
  const withoutScheme = value
    .replace(/^[a-z]+:\/\/(?:[^@/]+@)?[^/]+\//iu, "")
    .replace(/^[^@/]+@[^:]+:/u, "");
  const segments = withoutScheme.split("/").filter(Boolean);
  return segments.slice(-2).join("/");
}

function environmentError(code: WorkerRuntimeEnvironmentError["code"]) {
  return new WorkerRuntimeEnvironmentError({
    code,
    message: "Gaia runtime source identity could not be accepted.",
  });
}
