import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryCleanupOwnershipProvenanceV1 } from "./delivery-cleanup-provenance.js";
import { coordinateBranchCleanup, coordinateWorktreeCleanup, makeInMemoryCleanupCheckpointStore } from "./delivery-cleanup-resource-coordinator.js";
import { makeGitCleanupResourceAdapter } from "./git-cleanup-resource-adapter.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true }); });

function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "gaia-93-cleanup-")); roots.push(root);
  const repo = path.join(root, "repo"); const runRoot = path.join(root, "run"); const workspace = path.join(runRoot, "workspace");
  mkdirSync(repo); mkdirSync(runRoot);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.email", "gaia@example.test"); git(repo, "config", "user.name", "Gaia Test");
  writeFileSync(path.join(repo, "base.txt"), "base\n"); git(repo, "add", "base.txt"); git(repo, "commit", "-m", "initial");
  const head = git(repo, "rev-parse", "HEAD"); const branch = "gaia/run-1234567890"; const unrelated = "keep/unrelated";
  git(repo, "branch", branch, head); git(repo, "branch", unrelated, head); git(repo, "worktree", "add", workspace, branch);
  const common = path.resolve(repo, git(repo, "rev-parse", "--git-common-dir")); const token = "private-token";
  writeFileSync(path.join(runRoot, "delivery-ownership.json"), JSON.stringify({ baseRevision: head, remoteIdentity: "local", repositoryCommonDir: common, repositoryRoot: repo, token, version: 1, workspaceCommonDir: common, workspaceRoot: workspace }));
  const provenance = DeliveryCleanupOwnershipProvenanceV1.make({ actionId: "cleanup-1", branchRef: `refs/heads/${branch}`, expectedBranchOid: head, mergeCommitSha: "b".repeat(40), ownershipDigest: "c".repeat(64), ownershipToken: token, payloadDigest: "d".repeat(64), repositoryCommonDir: common, repositoryRoot: repo, runId: "run-1234567890", version: 1, worktreeCommonDir: common, worktreePath: workspace });
  return { branch, head, provenance, repo, unrelated, workspace };
}
function snapshot(f: ReturnType<typeof setup>) { return { head: git(f.repo, "rev-parse", "main"), unrelated: git(f.repo, "rev-parse", f.unrelated) }; }
function expectPreserved(f: ReturnType<typeof setup>, before: ReturnType<typeof snapshot>) { expect(snapshot(f)).toEqual(before); }
async function clean(f: ReturnType<typeof setup>, seed: Parameters<typeof makeInMemoryCleanupCheckpointStore>[0] = []) {
  const memory = makeInMemoryCleanupCheckpointStore(seed); const adapter = makeGitCleanupResourceAdapter();
  await Effect.runPromise(coordinateWorktreeCleanup({ adapter, checkpointStore: memory.store, provenance: f.provenance }));
  await Effect.runPromise(coordinateBranchCleanup({ adapter, checkpointStore: memory.store, provenance: f.provenance }));
  return memory.checkpoints;
}

describe("git cleanup resource adapter integration", () => {
  it("removes present worktree and branch only after fresh absence proof", async () => { const f = setup(); const before = snapshot(f); const points = await clean(f); expect(points.filter(({ state }) => state === "absenceProven")).toHaveLength(2); expect(() => git(f.repo, "show-ref", "--verify", f.provenance.branchRef)).toThrow(); expectPreserved(f, before); });
  it("removes an exact branch when its worktree is already absent", async () => { const f = setup(); const before = snapshot(f); git(f.repo, "worktree", "remove", f.workspace); await clean(f); expect(() => git(f.repo, "show-ref", "--verify", f.provenance.branchRef)).toThrow(); expectPreserved(f, before); });
  it("removes a worktree when its branch ref is already absent", async () => { const f = setup(); const before = snapshot(f); git(f.repo, "update-ref", "-d", f.provenance.branchRef, f.head); await clean(f); expect(() => git(f.workspace, "rev-parse", "HEAD")).toThrow(); expectPreserved(f, before); });
  it("refuses a moved branch while preserving prior worktree absence proof", async () => { const f = setup(); const before = snapshot(f); git(f.repo, "worktree", "remove", f.workspace); writeFileSync(path.join(f.repo, "next.txt"), "next\n"); git(f.repo, "add", "next.txt"); git(f.repo, "commit", "-m", "next"); git(f.repo, "branch", "-f", f.branch, "HEAD"); const seed = [{ actionId: f.provenance.actionId, payloadDigest: f.provenance.payloadDigest, resource: "worktree" as const, state: "absenceProven" as const }]; await expect(Effect.runPromise(coordinateBranchCleanup({ adapter: makeGitCleanupResourceAdapter(), checkpointStore: makeInMemoryCleanupCheckpointStore(seed).store, provenance: f.provenance }))).rejects.toBeTruthy(); expect(git(f.repo, "rev-parse", f.branch)).not.toBe(f.head); expect(git(f.repo, "rev-parse", f.unrelated)).toBe(before.unrelated); });
  it("refuses a dirty worktree", async () => { const f = setup(); const before = snapshot(f); writeFileSync(path.join(f.workspace, "dirty.txt"), "dirty\n"); await expect(clean(f)).rejects.toBeTruthy(); expectPreserved(f, before); });
  it("fails closed when the worktree becomes dirty after coordinator inspection", async () => { const f = setup(); const before = snapshot(f); const raced = path.join(f.workspace, "raced.txt"); const adapter = makeGitCleanupResourceAdapter({ beforeWorktreeRemove: () => writeFileSync(raced, "preserve me\n") }); await expect(Effect.runPromise(coordinateWorktreeCleanup({ adapter, checkpointStore: makeInMemoryCleanupCheckpointStore().store, provenance: f.provenance }))).rejects.toBeTruthy(); expect(git(f.workspace, "branch", "--show-current")).toBe(f.branch); expectPreserved(f, before); });
  for (const [name, race] of [
    ["clean branch switch", (f: ReturnType<typeof setup>) => git(f.workspace, "switch", f.unrelated)],
    ["detached head", (f: ReturnType<typeof setup>) => git(f.workspace, "checkout", "--detach")],
    ["unapproved detach after branch deletion", (f: ReturnType<typeof setup>) => { git(f.repo, "update-ref", "-d", f.provenance.branchRef, f.head); git(f.workspace, "checkout", "--detach", f.head); }],
    ["head move", (f: ReturnType<typeof setup>) => { writeFileSync(path.join(f.workspace, "moved.txt"), "moved\n"); git(f.workspace, "add", "moved.txt"); git(f.workspace, "commit", "-m", "move owned head"); }],
    ["ownership manifest change", (f: ReturnType<typeof setup>) => writeFileSync(path.join(path.dirname(f.workspace), "delivery-ownership.json"), JSON.stringify({ baseRevision: f.head, remoteIdentity: "local", repositoryCommonDir: f.provenance.repositoryCommonDir, repositoryRoot: f.repo, token: "changed-token", version: 1, workspaceCommonDir: f.provenance.worktreeCommonDir, workspaceRoot: f.workspace }))],
    ["worktree re-registration", (f: ReturnType<typeof setup>) => { git(f.repo, "worktree", "remove", f.workspace); git(f.repo, "worktree", "add", "--detach", f.workspace, "main"); }],
  ] as const) {
    it(`refuses a ${name} race after coordinator inspection`, async () => { const f = setup(); const before = snapshot(f); const adapter = makeGitCleanupResourceAdapter({ beforeWorktreeRemove: () => race(f) }); await expect(Effect.runPromise(coordinateWorktreeCleanup({ adapter, checkpointStore: makeInMemoryCleanupCheckpointStore().store, provenance: f.provenance }))).rejects.toBeTruthy(); expect(() => git(f.workspace, "rev-parse", "--show-toplevel")).not.toThrow(); expectPreserved(f, before); });
  }
  it("refuses a detached worktree", async () => { const f = setup(); const before = snapshot(f); git(f.workspace, "checkout", "--detach"); await expect(clean(f)).rejects.toBeTruthy(); expectPreserved(f, before); });
  it("refuses the primary checkout", async () => { const f = setup(); const before = snapshot(f); const forged = DeliveryCleanupOwnershipProvenanceV1.make({ ...f.provenance, worktreePath: f.repo }); await expect(Effect.runPromise(coordinateWorktreeCleanup({ adapter: makeGitCleanupResourceAdapter(), checkpointStore: makeInMemoryCleanupCheckpointStore().store, provenance: forged }))).rejects.toBeTruthy(); expectPreserved(f, before); });
  it("refuses wrong identity and a recreated non-worktree path", async () => { const f = setup(); const before = snapshot(f); git(f.repo, "worktree", "remove", f.workspace); mkdirSync(f.workspace); await expect(clean(f)).rejects.toBeTruthy(); expectPreserved(f, before); });
  it("preserves an unrelated local branch", async () => { const f = setup(); const before = snapshot(f); await clean(f); expect(git(f.repo, "rev-parse", f.unrelated)).toBe(before.unrelated); expectPreserved(f, before); });
  it("proves both already absent idempotently", async () => { const f = setup(); const before = snapshot(f); git(f.repo, "worktree", "remove", f.workspace); git(f.repo, "update-ref", "-d", f.provenance.branchRef, f.head); const points = await clean(f); expect(points.filter(({ state }) => state === "absenceProven")).toHaveLength(2); expectPreserved(f, before); });
});
