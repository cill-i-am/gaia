---
name: worktree-isolation
description: Git worktree isolation with exact fetched-remote base provenance for agent work. Use when creating, validating, refreshing, or handing off worker and read-only reviewer worktrees, feature branches, parallel implementation, or experiments that must not disturb the current workspace.
---

# Worktree Isolation

Use this skill when an orchestrator, worker, or reviewer needs an isolated
repository workspace. The goal is a clean, reproducible starting point with
provable remote ancestry, not clever branch management.

## Non-Negotiable Base

Never base new worker or reviewer worktrees on local `main`, the coordinator's
current `HEAD`, or a SHA copied from handoff prose. Before every dispatch or base
refresh, fetch the remote, resolve the symbolic remote default, and then resolve
its exact commit:

```sh
git fetch --prune origin || exit 1
remote_head=$(git symbolic-ref refs/remotes/origin/HEAD) || exit 1
case "$remote_head" in
  refs/remotes/origin/?*) ;;
  *) exit 1 ;;
esac
default_ref=${remote_head#refs/remotes/}
default_sha=$(git rev-parse --verify "${remote_head}^{commit}") || exit 1
printf '%s\n' "$default_ref" "$default_sha"
```

This derives an exact `origin/<default>` from `refs/remotes/origin/HEAD`; it does
not assume a branch name. If the fetch fails, the remote HEAD is missing, is not
symbolic, points outside `refs/remotes/origin/`, or the commit does not resolve,
provenance fails closed. Create both the worker and paired reviewer worktrees
from `default_sha`. A Codex thread tool may provision new lanes only with
`startingState: origin/<default>` and only when the created lane can be
independently verified against that recorded SHA. Otherwise, provision manually
or stop and report the missing capability.

## Coordinator Setup

1. **Confirm git state.** Run `git rev-parse --show-toplevel`,
   `git branch --show-current`, and `git status --short`. If the coordinator tree
   has unrelated changes, do not move or clean them. Its state is not the base.
2. **Choose the directory.** Prefer an existing ignored `.worktrees/`, then
   existing ignored `worktrees/`, then a global temp/worktree root outside the
   project. Read the nearest `AGENTS.md` for a local preference.
3. **Verify ignore safety.** For project-local directories, run
   `git check-ignore -q .worktrees` or `git check-ignore -q worktrees` before
   creating the worktree. If the chosen directory is not ignored, add the ignore
   entry as part of the normal change or choose an external directory.
4. **Fetch and resolve the base.** Run the commands in Non-Negotiable Base and
   record the fetch time, `remote_head`, exact `default_ref`, and `default_sha`.
   Do this once for the worker/reviewer pair so both start from identical remote
   provenance.
5. **Create detached worktrees.** Use the resolved SHA, not a symbolic local
   branch or the coordinator's `HEAD`:

   ```sh
   git worktree add --detach <worker-path> "$default_sha"
   git worktree add --detach <reviewer-path> "$default_sha"
   ```

6. **Hand off role ownership.** The worker creates and owns
   `codex/<issue-key>-<slug>` from its detached base. The paired reviewer remains
   detached and read-only unless a separately authorized narrower task changes
   that role.
7. **Install and verify baseline.** Follow repo instructions. In this bundle's
   default TypeScript projects, use pnpm. Run the smallest documented baseline
   check that proves the worktree starts usable.
8. **Report the handoff.** State both worktree paths, fetch time, fetched
   remote-default ref/SHA, worker branch expectation, reviewer detached/read-only
   state, install command, baseline command/result, and any setup blocker.

## Worker Activation

For a new lane, the worker, not the orchestrator or reviewer, creates the topic
branch inside the pre-provisioned worker worktree:

```sh
git switch -c codex/<issue-key>-<slug>
```

Do not create that branch from a local checkout and then attach a worktree to it.
The branch must begin at the fetched SHA already checked out in the worker
worktree. For an explicit resume/special-ref, preserve and prove the authorized
existing ref/HEAD instead; do not run the new-lane branch-creation command.

## Provenance Proof

Before planning, reviewing a plan, or editing, run this evidence set inside each
worktree after a fresh `git fetch --prune origin`:

```sh
git status --porcelain
git branch --show-current
git fetch --prune origin || exit 1
remote_head=$(git symbolic-ref refs/remotes/origin/HEAD) || exit 1
case "$remote_head" in
  refs/remotes/origin/?*) ;;
  *) exit 1 ;;
esac
default_ref=${remote_head#refs/remotes/}
default_sha=$(git rev-parse --verify "${remote_head}^{commit}") || exit 1
head_sha=$(git rev-parse --verify 'HEAD^{commit}') || exit 1
merge_base=$(git merge-base "$head_sha" "$default_sha") || exit 1
printf '%s\n' "$head_sha" "$default_ref" "$default_sha" "$merge_base"
git rev-list --left-right --count HEAD..."$default_ref"
```

Required result for new lanes:

- `git status --porcelain` is empty;
- worker branch is the expected `codex/<issue-key>-<slug>` and reviewer branch
  output is empty because the reviewer is detached;
- `HEAD == origin/<default> == merge-base` at the same exact SHA;
- ahead/behind is `0/0`.

Handoff prose, a local `main` pointer, or an earlier fetch log is never sufficient
evidence.

## Explicit Resume / Special-Ref Provenance

Existing issue branches or alternative start refs are not new lanes. Use one
only when an explicit resume/special-ref override is recorded in a durable
issue/handoff comment. After a fresh default resolution, record the override
ref, exact resumed HEAD, fetched remote-default ref/SHA, merge-base,
ahead/behind, honest clean/dirty state, fetch time, and durable dispatch comment.
Non-zero arithmetic or a dirty tree is evidence to assess, not automatic proof
of an invalid resume.

Prove that the override ref resolves to the exact resumed HEAD:

```sh
override_sha=$(git rev-parse --verify "${override_ref}^{commit}") || exit 1
head_sha=$(git rev-parse --verify 'HEAD^{commit}') || exit 1
test "$head_sha" = "$override_sha" || exit 1
resume_merge_base=$(git merge-base "$head_sha" "$default_sha") || exit 1
git rev-list --left-right --count HEAD..."$default_ref"
```

The override must name the intended ref and authority. If the override ref,
default ref, either exact commit, or their merge-base cannot be resolved, the
resume fails closed. An explicit resume does not authorize reset, clean, merge,
automatic rebase, force-move, or discard work. Stop and report the evidence
instead of rewriting it.

## Remote Advance Before Edit Authority

If a fresh fetch moves `origin/<default>` before a new lane has edit authority,
hold both lanes. When both worktrees are clean and the worker branch has no
divergent commits, incorporate the exact fresh SHA non-destructively:

```sh
git fetch --prune origin || exit 1
remote_head=$(git symbolic-ref refs/remotes/origin/HEAD) || exit 1
case "$remote_head" in
  refs/remotes/origin/?*) ;;
  *) exit 1 ;;
esac
fresh_default_ref=${remote_head#refs/remotes/}
fresh_base_sha=$(git rev-parse --verify "${remote_head}^{commit}") || exit 1

# Worker topic branch: fast-forward only.
git -C "<worker-path>" merge --ff-only "$fresh_base_sha" || exit 1

# Reviewer worktree: remain detached.
git -C "<reviewer-path>" switch --detach "$fresh_base_sha" || exit 1
```

If fetch, symbolic-ref validation, commit resolution, or either lane operation
fails, stop and report the divergence. Do not reset, force-move, or discard work.
After refresh, repeat the full provenance proof using `fresh_default_ref`,
dependency install when needed, relevant baselines, worker plan, and
reviewer/orchestrator gate before edits.

Completion criterion: both paths and the exact fetched `origin/<default>` SHA are
recorded; the worker owns a topic branch created from that SHA; the reviewer is
detached and read-only; new-lane clean/equality/ahead-behind proof passes; and
the relevant baseline has passed or a blocker is explicit. An explicit resume
instead has the complete override evidence above and no implicit mutation.

## Guardrails

- Do not create project-local worktrees in a tracked directory.
- Do not use local `main`, coordinator `HEAD`, or handoff prose as base evidence.
- Do not use `git reset --hard`, `git clean`, or checkout commands that would
  discard user changes unless the user explicitly asked for that operation.
- Do not continue implementation from a baseline that fails without reporting
  whether the failure is pre-existing.
- Do not run package managers other than pnpm in pnpm workspaces unless the repo
  explicitly uses a different manager.
- Do not treat the worktree as cleanup-safe until pushed branches, PRs,
  temporary files, and running processes have been accounted for.

## Cleanup

When a worker is done and the branch/PR no longer needs the local workspace:

```sh
git worktree remove <path>
git worktree prune
```

Only remove a worktree after confirming no uncommitted useful work remains in
that worktree.
