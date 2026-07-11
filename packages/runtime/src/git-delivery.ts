import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { Effect, FileSystem, Schema } from "effect";
import { makeRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";

const execFileAsync = promisify(execFile);

export type GitDeliveryCommandInput = {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
};

export type GitDeliveryCommandResult = {
  readonly stderr: string;
  readonly stdout: string;
};

export type GitDeliveryCommandRunner = (
  input: GitDeliveryCommandInput,
) => Effect.Effect<GitDeliveryCommandResult, unknown>;

export type DeliveryProvenance = {
  readonly baseBranch: string;
  readonly baseRevision: string;
  readonly headBranch: string;
  readonly mode: "pullRequest";
  readonly remote: string;
};

export const DeliveryProvenanceSchema = Schema.Struct({
  baseBranch: Schema.NonEmptyString,
  baseRevision: Schema.NonEmptyString,
  headBranch: Schema.NonEmptyString,
  mode: Schema.Literal("pullRequest"),
  remote: Schema.NonEmptyString,
});

export const parseDeliveryProvenance = Schema.decodeUnknownOption(
  DeliveryProvenanceSchema,
);

const DeliveryOwnershipManifest = Schema.Struct({
  baseRevision: Schema.NonEmptyString,
  repositoryCommonDir: Schema.NonEmptyString,
  repositoryRoot: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  version: Schema.Literal(1),
  workspaceCommonDir: Schema.NonEmptyString,
  workspaceRoot: Schema.NonEmptyString,
});

const parseDeliveryOwnershipManifest = Schema.decodeUnknownSync(
  DeliveryOwnershipManifest,
);

export type DeliveryWorkspaceOptions = {
  readonly commandRunner?: GitDeliveryCommandRunner;
  readonly rootDirectory: string;
};

const defaultRemote = "origin";
const defaultBaseBranch = "main";

export const nodeGitDeliveryCommandRunner: GitDeliveryCommandRunner = (input) =>
  Effect.tryPromise({
    try: async () => {
      const result = await execFileAsync("git", [...input.args], {
        cwd: input.cwd,
        maxBuffer: 1024 * 1024,
      });
      return { stderr: result.stderr, stdout: result.stdout };
    },
    catch: (cause) => cause,
  });

export function resolveDeliveryProvenance(
  runId: string,
  options: DeliveryWorkspaceOptions,
) {
  return Effect.gen(function* () {
    const runner = options.commandRunner ?? nodeGitDeliveryCommandRunner;
    yield* runGit(runner, options.rootDirectory, ["rev-parse", "--show-toplevel"]);
    yield* runGit(runner, options.rootDirectory, ["fetch", defaultRemote, defaultBaseBranch]);
    const baseRevision = (yield* runGit(runner, options.rootDirectory, [
      "rev-parse",
      `${defaultRemote}/${defaultBaseBranch}`,
    ])).stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(baseRevision)) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryBaseRevisionInvalid",
          message: "Gaia could not resolve an exact delivery base revision.",
          recoverable: true,
        }),
      );
    }
    return {
      baseBranch: defaultBaseBranch,
      baseRevision,
      headBranch: `gaia/${runId}`,
      mode: "pullRequest",
      remote: defaultRemote,
    } satisfies DeliveryProvenance;
  });
}

export function prepareDeliveryWorktree(input: {
  readonly options: DeliveryWorkspaceOptions;
  readonly paths: RunPaths;
  readonly provenance: DeliveryProvenance;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = input.options.commandRunner ?? nodeGitDeliveryCommandRunner;
    const exists = yield* fs.exists(input.paths.workspace);
    const expectedRepository = yield* repositoryIdentity(runner, input.options.rootDirectory);

    if (exists) {
      const manifest = yield* readOwnershipManifest(input.paths.deliveryOwnershipManifest);
      const head = (yield* runGit(runner, input.paths.workspace, [
        "rev-parse",
        "HEAD",
      ])).stdout.trim();
      const root = (yield* runGit(runner, input.paths.workspace, [
        "rev-parse",
        "--show-toplevel",
      ])).stdout.trim();
      const workspaceCommonDir = (yield* runGit(runner, input.paths.workspace, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ])).stdout.trim();
      if (
        head !== input.provenance.baseRevision ||
        root !== input.paths.workspace ||
        manifest.repositoryRoot !== expectedRepository.repositoryRoot ||
        manifest.repositoryCommonDir !== expectedRepository.repositoryCommonDir ||
        manifest.workspaceRoot !== input.paths.workspace ||
        manifest.workspaceCommonDir !== workspaceCommonDir ||
        manifest.baseRevision !== input.provenance.baseRevision ||
        manifest.token !== ownershipToken(input.provenance)
      ) {
        return yield* Effect.fail(
          makeRuntimeError({
            code: "DeliveryWorktreeIdentityMismatch",
            message: "Persisted delivery worktree does not match the accepted run identity.",
            recoverable: false,
          }),
        );
      }
      return;
    }

    yield* runGit(runner, input.options.rootDirectory, [
      "worktree",
      "add",
      "--detach",
      input.paths.workspace,
      input.provenance.baseRevision,
    ]);
    const workspaceIdentity = yield* repositoryIdentity(runner, input.paths.workspace);
    yield* fs.writeFileString(
      input.paths.deliveryOwnershipManifest,
      `${JSON.stringify({
        baseRevision: input.provenance.baseRevision,
        repositoryCommonDir: expectedRepository.repositoryCommonDir,
        repositoryRoot: expectedRepository.repositoryRoot,
        token: ownershipToken(input.provenance),
        version: 1,
        workspaceCommonDir: workspaceIdentity.repositoryCommonDir,
        workspaceRoot: workspaceIdentity.repositoryRoot,
      }, null, 2)}\n`,
    ).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "DeliveryOwnershipManifestWriteFailed",
          message: "Gaia could not persist delivery worktree ownership evidence.",
          recoverable: false,
        }),
      ),
    );
  });
}

export function isGitRepository(
  options: DeliveryWorkspaceOptions,
): Effect.Effect<boolean> {
  const runner = options.commandRunner ?? nodeGitDeliveryCommandRunner;
  return runGit(runner, options.rootDirectory, [
    "rev-parse",
    "--show-toplevel",
  ]).pipe(
    Effect.as(true),
    Effect.catchTags({
      GaiaRuntimeError: () => Effect.succeed(false),
    }),
  );
}

function runGit(
  runner: GitDeliveryCommandRunner,
  cwd: string,
  args: ReadonlyArray<string>,
) {
  return runner({ args, cwd }).pipe(
    Effect.mapError((cause) =>
      makeRuntimeError({
        cause,
        code: "DeliveryGitCommandFailed",
        message: "Gaia could not prepare the owned delivery worktree.",
        recoverable: true,
      }),
    ),
  );
}

function repositoryIdentity(
  runner: GitDeliveryCommandRunner,
  cwd: string,
) {
  return Effect.gen(function* () {
    const repositoryRoot = (yield* runGit(runner, cwd, [
      "rev-parse",
      "--show-toplevel",
    ])).stdout.trim();
    const repositoryCommonDir = (yield* runGit(runner, cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).stdout.trim();
    return { repositoryCommonDir, repositoryRoot };
  });
}

function readOwnershipManifest(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "DeliveryWorktreeIdentityMismatch",
          message: "Persisted delivery worktree is missing ownership evidence.",
          recoverable: false,
        }),
      ),
    );
    return yield* Effect.try({
      try: () => parseDeliveryOwnershipManifest(JSON.parse(text)),
      catch: (cause) =>
        makeRuntimeError({
          cause,
          code: "DeliveryWorktreeIdentityMismatch",
          message: "Persisted delivery worktree ownership evidence is invalid.",
          recoverable: false,
        }),
    });
  });
}

function ownershipToken(provenance: DeliveryProvenance) {
  return createHash("sha256")
    .update(`${provenance.remote}\0${provenance.baseBranch}\0${provenance.baseRevision}\0${provenance.headBranch}`)
    .digest("hex");
}
