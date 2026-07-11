import { execFile } from "node:child_process";
import path from "node:path";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { Effect, FileSystem, Schema } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import type { DeliveryCleanupOwnershipProvenanceV1 } from "./delivery-cleanup-provenance.js";
import type { CleanupResourceAdapter, CleanupResourceInspection } from "./delivery-cleanup-resource-coordinator.js";
import { makeRuntimeError } from "./errors.js";
import { repositoryCommandEnvironment } from "./repository-command-environment.js";

const execFileAsync = promisify(execFile);
const OwnershipManifest = Schema.Struct({ baseRevision: Schema.NonEmptyString, repositoryCommonDir: Schema.NonEmptyString, repositoryRoot: Schema.NonEmptyString, remoteIdentity: Schema.NonEmptyString, token: Schema.NonEmptyString, version: Schema.Literal(1), workspaceCommonDir: Schema.NonEmptyString, workspaceRoot: Schema.NonEmptyString });
const parseManifest = Schema.decodeUnknownSync(OwnershipManifest);

export function makeGitCleanupResourceAdapter(options: { readonly beforeWorktreeRemove?: () => void } = {}): CleanupResourceAdapter {
  return {
    inspectBranch: (provenance) => inspectBranch(provenance).pipe(Effect.provide(NodeFileSystem.layer)),
    inspectWorktree: (provenance) => inspectWorktree(provenance).pipe(Effect.provide(NodeFileSystem.layer)),
    removeBranchCas: (provenance) => validatePrivateProvenance(provenance).pipe(Effect.andThen(runGit(provenance.repositoryRoot, ["update-ref", "-d", provenance.branchRef, provenance.expectedBranchOid])), Effect.asVoid, Effect.provide(NodeFileSystem.layer)),
    removeWorktree: (provenance) => validatePrivateProvenance(provenance).pipe(
      Effect.andThen(inspectWorktree(provenance)),
      Effect.flatMap((state) => state === "present" ? prepareWorktreeForRemoval(provenance).pipe(
        Effect.flatMap((preparedMode) => Effect.sync(() => options.beforeWorktreeRemove?.()).pipe(
          Effect.andThen(validatePreparedWorktreeForRemoval(provenance, preparedMode)),
          Effect.andThen(runGit(provenance.repositoryRoot, ["worktree", "remove", provenance.worktreePath])),
        )),
        Effect.asVoid,
      ) : Effect.void),
      Effect.provide(NodeFileSystem.layer),
    ),
  };
}

function validatePreparedWorktreeForRemoval(provenance: DeliveryCleanupOwnershipProvenanceV1, preparedMode: "authorizedDetach" | "expectedBranch") {
  return Effect.gen(function* () {
    yield* validatePrivateProvenance(provenance);
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(provenance.worktreePath)) || provenance.worktreePath === provenance.repositoryRoot) return yield* unsafe("Owned worktree is absent or primary before removal.");
    const [root, common, branch, head, tracked, untracked, registered, branchRef] = yield* Effect.all([
      runGit(provenance.worktreePath, ["rev-parse", "--show-toplevel"]),
      runGit(provenance.worktreePath, ["rev-parse", "--git-common-dir"]),
      runGitExit(provenance.worktreePath, ["symbolic-ref", "--quiet", "HEAD"]),
      runGit(provenance.worktreePath, ["rev-parse", "HEAD"]),
      runGitExit(provenance.worktreePath, ["diff-index", "--quiet", provenance.expectedBranchOid, "--"]),
      runGit(provenance.worktreePath, ["ls-files", "--others", "--exclude-standard"]),
      runGit(provenance.repositoryRoot, ["worktree", "list", "--porcelain"]),
      runGitExit(provenance.repositoryRoot, ["show-ref", "--verify", "--quiet", provenance.branchRef]),
    ]);
    const commonAbsolute = path.resolve(provenance.worktreePath, common.stdout.trim());
    const isExactlyRegistered = registered.stdout.split(/\r?\n/u).some((line) => line.startsWith("worktree ") && canonical(line.slice("worktree ".length)) === canonical(provenance.worktreePath));
    const isExpectedBranch = branch.exitCode === 0 && branch.stdout.trim() === provenance.branchRef;
    const isAuthorizedPreparedDetach = preparedMode === "authorizedDetach" && branch.exitCode !== 0 && branchRef.exitCode !== 0;
    const matchesPreparedMode = preparedMode === "expectedBranch" ? isExpectedBranch : isAuthorizedPreparedDetach;
    if (canonical(root.stdout.trim()) !== canonical(provenance.worktreePath) || canonical(commonAbsolute) !== canonical(provenance.worktreeCommonDir) || head.stdout.trim() !== provenance.expectedBranchOid || tracked.exitCode !== 0 || untracked.stdout.trim() !== "" || !isExactlyRegistered || !matchesPreparedMode) return yield* unsafe("Prepared worktree identity, registration, branch, OID, or clean state changed.");
  });
}

function prepareWorktreeForRemoval(provenance: DeliveryCleanupOwnershipProvenanceV1) {
  return runGitExit(provenance.repositoryRoot, ["show-ref", "--verify", "--quiet", provenance.branchRef]).pipe(
    Effect.flatMap((result) => result.exitCode === 0
      ? Effect.succeed("expectedBranch" as const)
      : runGit(provenance.worktreePath, ["checkout", "--detach", provenance.expectedBranchOid]).pipe(Effect.as("authorizedDetach" as const))),
  );
}

function inspectBranch(provenance: DeliveryCleanupOwnershipProvenanceV1): Effect.Effect<CleanupResourceInspection, unknown, FileSystem.FileSystem> {
  return validatePrivateProvenance(provenance).pipe(Effect.andThen(runGitExit(provenance.repositoryRoot, ["show-ref", "--verify", "--hash", provenance.branchRef])), Effect.flatMap((result) => {
    if (result.exitCode !== 0) return Effect.succeed("absent" as const);
    return result.stdout.trim() === provenance.expectedBranchOid ? Effect.succeed("present" as const) : unsafe("Owned branch OID changed.");
  }));
}

function inspectWorktree(provenance: DeliveryCleanupOwnershipProvenanceV1): Effect.Effect<CleanupResourceInspection, unknown, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    yield* validatePrivateProvenance(provenance);
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(provenance.worktreePath))) return "absent" as const;
    if (provenance.worktreePath === provenance.repositoryRoot) return yield* unsafe("Primary checkout cannot be cleaned.");
    const [root, common, branch, head, tracked, untracked] = yield* Effect.all([
      runGit(provenance.worktreePath, ["rev-parse", "--show-toplevel"]), runGit(provenance.worktreePath, ["rev-parse", "--git-common-dir"]), runGit(provenance.worktreePath, ["symbolic-ref", "--quiet", "HEAD"]), runGit(provenance.worktreePath, ["rev-parse", provenance.expectedBranchOid]), runGitExit(provenance.worktreePath, ["diff-index", "--quiet", provenance.expectedBranchOid, "--"]), runGit(provenance.worktreePath, ["ls-files", "--others", "--exclude-standard"]),
    ]);
    const commonAbsolute = path.resolve(provenance.worktreePath, common.stdout.trim());
    if (canonical(root.stdout.trim()) !== canonical(provenance.worktreePath) || canonical(commonAbsolute) !== canonical(provenance.worktreeCommonDir) || branch.stdout.trim() !== provenance.branchRef || head.stdout.trim() !== provenance.expectedBranchOid || tracked.exitCode !== 0 || untracked.stdout.trim() !== "") return yield* unsafe("Owned worktree identity, branch, OID, or clean state changed.");
    return "present" as const;
  });
}

function validatePrivateProvenance(provenance: DeliveryCleanupOwnershipProvenanceV1) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path.join(path.dirname(provenance.worktreePath), "delivery-ownership.json"));
    const manifest = parseManifest(JSON.parse(raw));
    if (manifest.token !== provenance.ownershipToken || canonical(manifest.repositoryRoot) !== canonical(provenance.repositoryRoot) || canonical(manifest.repositoryCommonDir) !== canonical(provenance.repositoryCommonDir) || canonical(manifest.workspaceRoot) !== canonical(provenance.worktreePath) || canonical(manifest.workspaceCommonDir) !== canonical(provenance.worktreeCommonDir)) return yield* unsafe("Private cleanup provenance no longer matches durable ownership.");
  });
}

function runGit(cwd: string, args: ReadonlyArray<string>) { return runGitExit(cwd, args).pipe(Effect.flatMap((result) => result.exitCode === 0 ? Effect.succeed(result) : unsafe("Owned git cleanup operation failed."))); }
function runGitExit(cwd: string, args: ReadonlyArray<string>) { return Effect.tryPromise({ try: async () => { try { const result = await execFileAsync("git", [...args], { cwd, env: repositoryCommandEnvironment(), maxBuffer: 1024 * 1024 }); return { exitCode: 0, stderr: result.stderr, stdout: result.stdout }; } catch (cause) { const error = cause as { code?: number; stderr?: string; stdout?: string }; return { exitCode: typeof error.code === "number" ? error.code : 1, stderr: String(error.stderr ?? ""), stdout: String(error.stdout ?? "") }; } }, catch: () => makeRuntimeError({ code: "DeliveryCleanupGitFailed", message: "Owned git cleanup operation failed.", recoverable: true }) }); }
function unsafe(message: string) { return Effect.fail(makeRuntimeError({ code: "DeliveryCleanupUnsafe", message, recoverable: true })); }
function canonical(value: string) { try { return realpathSync(value); } catch { return path.resolve(value); } }
