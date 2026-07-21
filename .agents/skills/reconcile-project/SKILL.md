---
name: reconcile-project
description: Reconcile Linear project state. Use at the start of orchestration loops or when issues, PRs, blockers, CI status, worker evidence, or the parent PRD may be stale or drifted.
---

# Reconcile Project

Make Linear truthful before dispatching or accepting more work.

## Read

- Linear Project/PRD, parent/sub-Issue hierarchy, blockers, comments, assignees,
  statuses
- linked PRs and CI status
- worker/orchestrator evidence comments
- plan-review cycle count, edit-authority time, source-diff or draft-PR evidence,
  and any claimed executable blocker
- freshly fetched `origin/<default>` ref/SHA resolved through symbolic
  `refs/remotes/origin/HEAD`, plus active worker/reviewer worktree evidence
- relevant source or architecture docs when spec drift is suspected

## Checks

Find and repair or report:

- blocker completed but dependent issue still blocked
- issue marked ready for agent work but missing acceptance criteria or verification
- worker assigned but stale with no recent evidence
- proposed or active worktree was based on local `main`, coordinator `HEAD`,
  handoff prose, or an unfetched/stale remote ref
- `git fetch --prune origin` failed, `refs/remotes/origin/HEAD` is missing,
  non-symbolic, outside `refs/remotes/origin/`, or its exact commit or merge-base
  cannot be resolved; provenance fails closed
- new lanes do not share the same exact fetched `origin/<default>` base, the
  worker branch was not created from that base, or the reviewer is not
  detached/read-only
- new-lane pre-edit proof is missing its fetch time or durable dispatch comment,
  is dirty, has non-zero ahead/behind, or does not show
  `HEAD == origin/<default> == merge-base` with `0/0`
- the Codex
  `startingState: { type: "branch", branchName: "origin/<default>" }` used for a
  new dispatch is missing from durable evidence or the created lane was not
  independently verified
- an explicit resume/special-ref lacks a durable issue/handoff comment naming
  the override ref and durable dispatch comment, exact resumed HEAD, fetched
  remote-default ref/SHA, merge-base, ahead/behind, honest clean/dirty state,
  and fetch time, or does not prove the override ref resolves to the exact
  resumed HEAD; non-zero or dirty evidence is assessed rather than rewritten
- a resume used reset, clean, merge, automatic rebase, force-move, or discard as
  implied authority, or an unresolvable relationship did not fail closed
- `origin/<default>` advanced before edit authority without a held dispatch, clean
  non-destructive refresh, fresh baselines, existing-plan revalidation, and
  focused review of affected deltas
- a third plan-review cycle started without explicit human approval
- two plan-review cycles completed with no source diff or draft PR
- several hours passed after edit authority with no source diff, executable
  blocker, or draft PR
- a review finding lacks exactly one of `pre-edit blocker`, `pre-merge
  blocker`, `deferred hardening`, or `question`
- uncertainty or unrelated hardening was treated as a `pre-edit blocker`
- reviewer feedback silently expanded scope beyond acceptance criteria
- PR opened but Linear not linked
- PR merged but issue not moved to the completed/done state
- PR failed CI but no `ci-watch` is active
- issue marked completed/done without production-ready evidence
- parent PRD changed after issue dispatch
- issue scope no longer matches parent PRD or source reality
- Issue title describes an internal technical task rather than an observable
  outcome, or uses unexplained codebase shorthand
- delivery outcome is orphaned or attached to the wrong parent capability outcome
- parent outcome is marked done while children remain incomplete, or all children
  are done but the combined parent outcome has not been verified
- duplicate or obsolete issues

## Actions

Use Linear updates for durable state:

- add or correct blockers
- rename outcome-equivalent titles and correct parent/sub-Issue relations when
  scope and ownership are clearly unchanged; report ambiguity instead of silently
  changing product meaning
- move state to the live workflow equivalent of needs information, blocked,
  ready for agent work, in review, or completed
- add comments with evidence
- hold dispatch or edit authority when base provenance is stale or unproven; use
  `worktree-isolation` for exact fetched-base provisioning or refresh
- preserve explicit resume/special-ref state; do not treat fetch or override
  evidence as authority to rewrite history or the working tree
- mark obsolete issues with rationale
- trigger or recommend `ci-watch` for PRs with pending/failing CI
- stop stalled planning and notify the human with elapsed/cycle evidence, current
  classification, and the smallest rescue tracer; never commission another
  complete plan
- route useful non-blocking hardening to an outcome-named follow-up issue

Do not implement code. Do not close or mark done without evidence.

## Output

Report every touched item in exactly one bucket:

- `dispatchable`: issue is ready for an AFK worker and blockers are clear.
- `active-worker`: issue already has an active worker, reviewer, branch, PR, or
  heartbeat; include the owner, next check, planning cycle, edit authority, and
  executable evidence.
- `needs-ci-watch`: PR exists but checks, PR comments, review threads, or Linear
  comments still need monitoring.
- `blocked-hitl`: human decision, external provider state, credentials, or
  blocker relation prevents agent work.
- `ready-for-acceptance`: worker evidence exists and orchestrator gates should
  run.
- `inconsistent`: Linear, PR, worker evidence, or PRD state disagree; include
  the proposed correction or the update already made.

Completion criterion: Linear's outcome hierarchy, titles, blockers, and execution
state are truthful enough that the orchestrator can safely dispatch, steer,
accept, or pause each item without relying on stale handoff context.
