import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { Data, Effect, FileSystem, Schema } from "effect";
import { makeRuntimeError } from "./errors.js";
import type { RunPaths } from "./paths.js";
import { repositoryCommandEnvironment } from "./repository-command-environment.js";

const execFileAsync = promisify(execFile);
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const LiteralBranchName = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(240)),
  Schema.check(Schema.isPattern(/^(?!-)(?!refs\/)(?!.*(?:\.\.|@\{|\/\/))(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9])$/u)),
);
const GaiaOwnedBranchName = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(240)),
  Schema.check(Schema.isPattern(/^gaia\/(?!-)(?!.*(?:\.\.|@\{|\/\/))(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9_-])$/u)),
);
const DeliveryRemoteName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)),
);

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

export class DeliveryAcceptanceProvenancePolicyV1 extends Schema.Class<DeliveryAcceptanceProvenancePolicyV1>(
  "DeliveryAcceptanceProvenancePolicyV1",
)({
  baseBranch: LiteralBranchName,
  headBranch: GaiaOwnedBranchName,
  remote: DeliveryRemoteName,
  version: Schema.Literal(1),
}, strict) {}

export const parseDeliveryAcceptanceProvenancePolicy = Schema.decodeUnknownSync(
  DeliveryAcceptanceProvenancePolicyV1,
);

export const DeliveryProvenanceSchema = Schema.Struct({
  baseBranch: LiteralBranchName,
  baseRevision: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  ),
  headBranch: GaiaOwnedBranchName,
  mode: Schema.Literal("pullRequest"),
  remote: DeliveryRemoteName,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (provenance) => provenance.baseBranch !== provenance.headBranch,
    ),
  ),
);

export const parseDeliveryProvenance = Schema.decodeUnknownOption(
  DeliveryProvenanceSchema,
);

const DeliveryOwnershipManifest = Schema.Struct({
  baseRevision: Schema.NonEmptyString,
  repositoryCommonDir: Schema.NonEmptyString,
  remoteIdentity: Schema.NonEmptyString,
  repositoryRoot: Schema.NonEmptyString,
  token: Schema.NonEmptyString,
  version: Schema.Literal(1),
  workspaceCommonDir: Schema.NonEmptyString,
  workspaceRoot: Schema.NonEmptyString,
});

const parseDeliveryOwnershipManifest = Schema.decodeUnknownSync(
  DeliveryOwnershipManifest,
);

const generatedRoots = new Set([
  ".gaia",
  ".turbo",
  "coverage",
  "dist",
  "gaia-runs",
  "node_modules",
]);

export type TrackedDeliveryPayloadFingerprint = {
  readonly trackedPayloadDigest: string;
  readonly trackedPayloadEntryCount: number;
};

export type DeliveryOwnedCleanupResult = {
  readonly branch: "absent" | "present";
  readonly worktree: "absent" | "present";
};
export class DeliveryOwnedCleanupPartial extends Data.TaggedError("DeliveryOwnedCleanupPartial")<{
  readonly branch: "absent" | "present";
  readonly message: string;
  readonly worktree: "absent" | "present";
}> {}

/** Remove only freshly re-proven run-owned resources, one resource at a time. */
export function cleanupOwnedDeliveryResources(input: {
  readonly branchName: string;
  readonly expectedBranchOid: string;
  readonly options: DeliveryWorkspaceOptions;
  readonly paths: RunPaths;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = input.options.commandRunner ?? nodeGitDeliveryCommandRunner;
    const raw = yield* fs.readFileString(input.paths.deliveryOwnershipManifest).pipe(
      Effect.mapError((cause) => makeRuntimeError({ cause, code: "DeliveryCleanupOwnershipUnavailable", message: "Durable worktree ownership evidence is unavailable.", recoverable: false })),
    );
    const manifest = parseDeliveryOwnershipManifest(JSON.parse(raw));
    const repository = yield* repositoryIdentity(runner, input.options.rootDirectory);
    if (repository.repositoryRoot !== manifest.repositoryRoot || repository.repositoryCommonDir !== manifest.repositoryCommonDir || manifest.workspaceRoot === manifest.repositoryRoot) {
      return yield* cleanupFailure("DeliveryCleanupOwnershipMismatch", "Cleanup provenance does not match the current non-primary repository.");
    }
    let worktree: "absent" | "present" = (yield* fs.exists(manifest.workspaceRoot)) ? "present" : "absent";
    const branchRef = `refs/heads/${input.branchName}`;
    let branch: "absent" | "present" = (yield* runGitExit(runner, input.options.rootDirectory, ["show-ref", "--verify", "--quiet", branchRef])) ? "present" : "absent";
    if (branch === "present") {
      const oid = (yield* runGit(runner, input.options.rootDirectory, ["rev-parse", branchRef])).stdout.trim();
      if (oid !== input.expectedBranchOid) return yield* cleanupFailure("DeliveryCleanupBranchMoved", "Owned local branch no longer points at the recorded expected head.");
    }
    if (worktree === "present") {
      const workspace = yield* repositoryIdentity(runner, manifest.workspaceRoot);
      const status = (yield* runGit(runner, manifest.workspaceRoot, ["status", "--porcelain"])).stdout;
      const branchName = (yield* runGit(runner, manifest.workspaceRoot, ["branch", "--show-current"])).stdout.trim();
      if (workspace.repositoryRoot !== manifest.workspaceRoot || workspace.repositoryCommonDir !== manifest.workspaceCommonDir || status.trim() !== "" || branchName !== input.branchName) {
        return yield* cleanupFailure("DeliveryCleanupUnsafe", "Owned worktree is dirty, mismatched, or no longer proves the recorded branch.");
      }
      yield* runGit(runner, input.options.rootDirectory, ["worktree", "remove", manifest.workspaceRoot]);
      worktree = "absent";
    }
    if (branch === "present") {
      const deletion = yield* Effect.exit(runGit(runner, input.options.rootDirectory, ["update-ref", "-d", branchRef, input.expectedBranchOid]));
      if (deletion._tag === "Failure") return yield* Effect.fail(new DeliveryOwnedCleanupPartial({ branch: "present", message: "Owned worktree was removed but exact branch CAS deletion failed.", worktree }));
      branch = "absent";
    }
    return { branch, worktree } satisfies DeliveryOwnedCleanupResult;
  });
}

function runGitExit(runner: GitDeliveryCommandRunner, cwd: string, args: ReadonlyArray<string>) {
  return Effect.exit(runner({ args, cwd })).pipe(Effect.map((exit) => exit._tag === "Success"));
}

function cleanupFailure(code: string, message: string) {
  return Effect.fail(makeRuntimeError({ code, message, recoverable: true }));
}

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
        env: repositoryCommandEnvironment(),
        maxBuffer: 1024 * 1024,
      });
      return { stderr: result.stderr, stdout: result.stdout };
    },
    catch: (cause) => cause,
  });

export function resolveDeliveryProvenance(
  runId: string,
  options: DeliveryWorkspaceOptions,
  acceptancePolicy?: unknown,
) {
  return Effect.gen(function* () {
    const policy = acceptancePolicy === undefined
      ? undefined
      : parseDeliveryAcceptanceProvenancePolicy(acceptancePolicy);
    const remote = policy?.remote ?? defaultRemote;
    const baseBranch = policy?.baseBranch ?? defaultBaseBranch;
    const headBranch = policy?.headBranch ?? `gaia/${runId}`;
    if (baseBranch === headBranch) {
      return yield* Effect.fail(makeRuntimeError({ code: "DeliveryProvenanceTopologyInvalid", message: "Delivery base and head branches must be distinct.", recoverable: false }));
    }
    const runner = options.commandRunner ?? nodeGitDeliveryCommandRunner;
    yield* runGit(runner, options.rootDirectory, ["rev-parse", "--show-toplevel"]);
    if (policy !== undefined) {
      yield* validateLiteralBranch(runner, options.rootDirectory, baseBranch);
      yield* validateLiteralBranch(runner, options.rootDirectory, headBranch);
      yield* runGit(runner, options.rootDirectory, ["remote", "get-url", "--", remote]);
      yield* runGit(runner, options.rootDirectory, ["fetch", "--no-tags", remote, `refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`]);
    } else {
      yield* runGit(runner, options.rootDirectory, ["fetch", defaultRemote, defaultBaseBranch]);
    }
    const baseRevision = (yield* runGit(runner, options.rootDirectory, [
      "rev-parse",
      ...(policy === undefined ? [`${defaultRemote}/${defaultBaseBranch}`] : ["--verify", `refs/remotes/${remote}/${baseBranch}^{commit}`]),
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
      baseBranch,
      baseRevision,
      headBranch,
      mode: "pullRequest",
      remote,
    } satisfies DeliveryProvenance;
  });
}

function validateLiteralBranch(runner: GitDeliveryCommandRunner, cwd: string, branch: string) {
  if (/\.\.|@\{|[~^:?*\[\\\s\u0000-\u001f\u007f]/u.test(branch) || branch.startsWith("-") || branch.startsWith("refs/") || branch.includes("//")) {
    return Effect.fail(makeRuntimeError({ code: "DeliveryBranchInvalid", message: "Delivery branch name is not a safe literal branch.", recoverable: false }));
  }
  return runGit(runner, cwd, ["check-ref-format", "--branch", branch]).pipe(Effect.asVoid);
}

/** Resolve a safe owner/repository tuple when the accepted remote is GitHub. */
export function resolveDeliveryGitHubRepository(
  options: DeliveryWorkspaceOptions,
  remote = defaultRemote,
) {
  const runner = options.commandRunner ?? nodeGitDeliveryCommandRunner;
  return runGit(runner, options.rootDirectory, ["remote", "get-url", remote]).pipe(
    Effect.map(({ stdout }) => {
      const raw = stdout.trim();
      try {
        const url = new URL(raw);
        const parts = stripGitSuffix(url.pathname).split("/").filter(Boolean);
        if (
          url.hostname.toLowerCase() !== "github.com" ||
          parts.length !== 2 ||
          !/^[A-Za-z0-9_.-]+$/u.test(parts[0] ?? "") ||
          !/^[A-Za-z0-9_.-]+$/u.test(parts[1] ?? "")
        ) {
          return undefined;
        }
        return `${parts[0]}/${parts[1]}`;
      } catch {
        const scp = /^(?:[^@\s]+@)?github\.com:([^/\s]+)\/([^/\s]+)$/u.exec(
          stripGitSuffix(raw),
        );
        return scp?.[1] === undefined || scp[2] === undefined
          ? undefined
          : `${scp[1]}/${scp[2]}`;
      }
    }),
  );
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
    const remoteIdentity = yield* repositoryRemoteIdentity(
      runner,
      input.options.rootDirectory,
      input.provenance.remote,
    );

    if (exists) {
      return yield* inspectDeliveryWorktreeOwnership({
        expectedHeads: [input.provenance.baseRevision],
        options: input.options,
        paths: input.paths,
        provenance: input.provenance,
      });
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
        remoteIdentity,
        token: ownershipToken(input.provenance, remoteIdentity),
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

/** Verify persisted worktree ownership while allowing only canonical lifecycle heads. */
export function inspectDeliveryWorktreeOwnership(input: {
  readonly expectedHeads: ReadonlyArray<string>;
  readonly options: DeliveryWorkspaceOptions;
  readonly paths: RunPaths;
  readonly provenance: DeliveryProvenance;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = input.options.commandRunner ?? nodeGitDeliveryCommandRunner;
    const expectedWorkspaceRoot = yield* fs.realPath(input.paths.workspace).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "DeliveryWorktreeIdentityMismatch",
          message: "Persisted delivery worktree path could not be resolved.",
          recoverable: false,
        }),
      ),
    );
    const expectedRepository = yield* repositoryIdentity(
      runner,
      input.options.rootDirectory,
    );
    const remoteIdentity = yield* repositoryRemoteIdentity(
      runner,
      input.options.rootDirectory,
      input.provenance.remote,
    );
    const manifest = yield* readOwnershipManifest(
      input.paths.deliveryOwnershipManifest,
    );
    const head = (yield* runGit(runner, input.paths.workspace, [
      "rev-parse",
      "HEAD",
    ])).stdout.trim();
    const root = (yield* runGit(runner, input.paths.workspace, [
      "rev-parse",
      "--show-toplevel",
    ])).stdout.trim();
    const canonicalRoot = yield* fs.realPath(root).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "DeliveryWorktreeIdentityMismatch",
          message: "Persisted delivery worktree root could not be resolved.",
          recoverable: false,
        }),
      ),
    );
    const canonicalManifestRoot = yield* fs.realPath(manifest.workspaceRoot).pipe(
      Effect.mapError((cause) =>
        makeRuntimeError({
          cause,
          code: "DeliveryWorktreeIdentityMismatch",
          message: "Persisted delivery ownership root could not be resolved.",
          recoverable: false,
        }),
      ),
    );
    const workspaceCommonDir = (yield* runGit(
      runner,
      input.paths.workspace,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )).stdout.trim();
    if (
      !input.expectedHeads.includes(head) ||
      canonicalRoot !== expectedWorkspaceRoot ||
      manifest.repositoryRoot !== expectedRepository.repositoryRoot ||
      manifest.repositoryCommonDir !== expectedRepository.repositoryCommonDir ||
      manifest.remoteIdentity !== remoteIdentity ||
      canonicalManifestRoot !== expectedWorkspaceRoot ||
      manifest.workspaceCommonDir !== workspaceCommonDir ||
      workspaceCommonDir !== expectedRepository.repositoryCommonDir ||
      manifest.baseRevision !== input.provenance.baseRevision ||
      manifest.token !== ownershipToken(input.provenance, remoteIdentity)
    ) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryWorktreeIdentityMismatch",
          message:
            "Persisted delivery worktree does not match the accepted run identity.",
          recoverable: false,
        }),
      );
    }
  });
}

/** Continuation-grade inspection proves immutable ownership and registration without requiring a clean payload diff. */
export function inspectContinuableDeliveryWorktreeOwnership(input: {
  readonly expectedHeads: ReadonlyArray<string>;
  readonly options: DeliveryWorkspaceOptions;
  readonly paths: RunPaths;
  readonly provenance: DeliveryProvenance;
}) {
  return Effect.gen(function* () {
    yield* inspectDeliveryWorktreeOwnership(input);
    const fs = yield* FileSystem.FileSystem;
    const runner = input.options.commandRunner ?? nodeGitDeliveryCommandRunner;
    const workspace = yield* fs.realPath(input.paths.workspace);
    const repository = yield* fs.realPath(input.options.rootDirectory);
    const inventory = (
      yield* runGit(runner, repository, [
        "worktree",
        "list",
        "--porcelain",
      ])
    ).stdout;
    const registrations = inventory
      .split(/\n\n/u)
      .filter((record) => record.split("\n")[0] === `worktree ${workspace}`);
    if (workspace === repository || registrations.length !== 1) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryWorktreeIdentityMismatch",
          message:
            "Persisted delivery worktree is not a registered, non-primary owned checkout.",
          recoverable: false,
        }),
      );
    }
  });
}

/** Retained-recovery inspection proves ownership and returns a privacy-safe stable tracked-payload fingerprint. */
export function inspectRetainedPayloadDeliveryWorktreeOwnership(input: {
  readonly expectedHeads: ReadonlyArray<string>;
  readonly options: DeliveryWorkspaceOptions;
  readonly paths: RunPaths;
  readonly provenance: DeliveryProvenance;
}): Effect.Effect<TrackedDeliveryPayloadFingerprint, unknown, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    yield* inspectContinuableDeliveryWorktreeOwnership(input);
    const runner = input.options.commandRunner ?? nodeGitDeliveryCommandRunner;
    const status = (yield* runGit(runner, input.paths.workspace, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ])).stdout;
    const entries = parsePorcelainStatus(status);
    if (entries.some(({ xy }) => isUntrackedStatus(xy))) {
      return yield* retainedPayloadFailure();
    }
    const trackedEntries = entries.filter(({ xy }) => !isUntrackedStatus(xy));
    if (trackedEntries.some(({ originalPath, path }) => pathHasGeneratedSegment(path) || (originalPath !== undefined && pathHasGeneratedSegment(originalPath)))) {
      return yield* retainedPayloadFailure();
    }
    const unstagedDiff = (yield* runGit(runner, input.paths.workspace, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--",
    ])).stdout;
    const stagedDiff = (yield* runGit(runner, input.paths.workspace, [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "HEAD",
      "--",
    ])).stdout;
    const canonical = {
      stagedDiff,
      status: trackedEntries
        .map(({ originalPath, path, xy }) => originalPath === undefined ? { path, xy } : { originalPath, path, xy })
        .toSorted((left, right) => `${left.path}\0${left.originalPath ?? ""}`.localeCompare(`${right.path}\0${right.originalPath ?? ""}`)),
      unstagedDiff,
      version: 1,
    };
    return {
      trackedPayloadDigest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
      trackedPayloadEntryCount: trackedEntries.length,
    };
  });
}

/** Recovery-grade inspection adds mutable cleanliness and registration checks to immutable ownership. */
export function inspectRecoverableDeliveryWorktreeOwnership(input: {
  readonly expectedHeads: ReadonlyArray<string>;
  readonly options: DeliveryWorkspaceOptions;
  readonly paths: RunPaths;
  readonly provenance: DeliveryProvenance;
}) {
  return Effect.gen(function* () {
    yield* inspectDeliveryWorktreeOwnership(input);
    const fs = yield* FileSystem.FileSystem;
    const runner = input.options.commandRunner ?? nodeGitDeliveryCommandRunner;
    const workspace = yield* fs.realPath(input.paths.workspace);
    const repository = yield* fs.realPath(input.options.rootDirectory);
    const status = (yield* runGit(runner, workspace, ["status", "--porcelain"])).stdout;
    const inventory = (yield* runGit(runner, repository, ["worktree", "list", "--porcelain"])).stdout;
    const registrations = inventory.split(/\n\n/u).filter((record) => record.split("\n")[0] === `worktree ${workspace}`);
    if (workspace === repository || status.trim() !== "" || registrations.length !== 1) {
      return yield* Effect.fail(makeRuntimeError({ code: "DeliveryWorktreeIdentityMismatch", message: "Persisted delivery worktree is not a clean, registered, non-primary owned checkout.", recoverable: false }));
    }
  });
}

function retainedPayloadFailure() {
  return Effect.fail(makeRuntimeError({
    code: "DeliveryWorktreeIdentityMismatch",
    message: "Persisted delivery worktree payload is not stable retained source payload.",
    recoverable: false,
  }));
}

function isUntrackedStatus(xy: string) {
  return xy === "??";
}

function pathHasGeneratedSegment(path: string) {
  return path.split("/").some((segment) => generatedRoots.has(segment));
}

function parsePorcelainStatus(raw: string) {
  const fields = raw.split("\0").filter((field) => field.length > 0);
  const entries: Array<{ readonly originalPath?: string; readonly path: string; readonly xy: string }> = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? "";
    const xy = field.slice(0, 2);
    const path = field.slice(3);
    if (path.length === 0) continue;
    if (xy.includes("R") || xy.includes("C")) {
      const originalPath = fields[index + 1];
      index++;
      entries.push(originalPath === undefined ? { path, xy } : { originalPath, path, xy });
    } else {
      entries.push({ path, xy });
    }
  }
  return entries;
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

function repositoryRemoteIdentity(
  runner: GitDeliveryCommandRunner,
  cwd: string,
  remote: string,
) {
  return Effect.gen(function* () {
    const raw = (
      yield* runGit(runner, cwd, ["remote", "get-url", remote])
    ).stdout.trim();
    if (raw.length === 0 || /[\u0000-\u001f\u007f]/u.test(raw)) {
      return yield* Effect.fail(
        makeRuntimeError({
          code: "DeliveryRemoteIdentityInvalid",
          message: "Gaia could not resolve a safe delivery remote identity.",
          recoverable: false,
        }),
      );
    }
    const scp = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/u.exec(raw);
    if (scp !== null) {
      return `ssh://${scp[1]}/${stripGitSuffix(scp[2] ?? "")}`;
    }
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${stripGitSuffix(url.pathname)}`;
    } catch {
      return stripGitSuffix(raw);
    }
  });
}

function stripGitSuffix(value: string) {
  return value.replace(/\/?\.git\/?$/u, "").replace(/\/$/u, "");
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

function ownershipToken(
  provenance: DeliveryProvenance,
  remoteIdentity: string,
) {
  return createHash("sha256")
    .update(`${remoteIdentity}\0${provenance.remote}\0${provenance.baseBranch}\0${provenance.baseRevision}\0${provenance.headBranch}`)
    .digest("hex");
}
