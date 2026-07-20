# Worker Thread Template

Use this when dispatching a Codex worker thread.

## Mission

Implement Linear issue: `{ISSUE_ID}`.

## Required Context

- Project or PRD: `{PROJECT_OR_PRD}`
- Issue: `{ISSUE_LINK}`
- Fetched `origin/<default>` ref/SHA: `{DEFAULT_REF}` / `{BASE_SHA}`
- Codex new-lane `startingState: origin/<default>`: `{STARTING_STATE}`
- Lane mode: `new` or explicit resume/special-ref `{LANE_MODE}`
- Durable issue/handoff comment for any override: `{OVERRIDE_COMMENT}`
- Worker worktree: `{WORKTREE_PATH}`
- Topic branch expectation: `codex/{ISSUE_ID}-{SLUG}`, created and owned by the worker
- Required skills: worker, worktree-isolation, `{SKILLS}`

## Scope

In scope:

- `{IN_SCOPE}`

Out of scope:

- `{OUT_OF_SCOPE}`

## Requirements

- Follow repo `AGENTS.md` and nested instructions.
- Read the live Linear issue, parent Project/PRD, blockers, and comments before
  planning. Treat this handoff as orientation only.
- Use the orchestrator-provisioned worktree created from the exact dispatched
  base SHA. Do not use local `main`, the coordinator's `HEAD`, or this handoff as
  base evidence.
- Create and own the topic branch inside that worktree.
- Before planning or editing, run `git fetch --prune origin`, require symbolic
  `refs/remotes/origin/HEAD` under `refs/remotes/origin/`, derive
  `origin/<default>`, and resolve the exact commit and merge-base. Missing or
  invalid provenance fails closed.
- For new lanes, report the isolated path, topic branch, fetched remote-default
  ref/SHA, empty worktree status, and prove
  `HEAD == origin/<default> == merge-base` with ahead/behind `0/0`, plus install
  and baseline results. Independently prove the created
  worktree matches the recorded `startingState: origin/<default>` commit.
- For an explicit resume/special-ref, report the override ref, exact resumed
  HEAD, fetched remote-default ref/SHA, merge-base, ahead/behind, honest
  clean/dirty state, fetch time, and durable dispatch comment. Prove the override
  ref resolves to the exact resumed HEAD. Non-zero or dirty state is evidence to
  assess. It does not authorize reset, clean, merge, automatic rebase,
  force-move, or discard work; stop if a required relationship is unresolvable
  so the resume fails closed.
- If `origin/<default>` advances before new-lane edit authority, hold work and
  notify the orchestrator. Refresh only through the non-destructive procedure in
  `worktree-isolation`, then rerun relevant baselines and repeat the
  plan/reviewer gate.
- Keep changes surgical and simple.
- Post a short plan before implementation.
- Proceed after posting the plan unless the issue or orchestrator explicitly
  requires plan approval.
- Stop and report if scope or product intent is wrong.
- Use Linear blockers for dependency issues.
- Use Browser verification for user-visible changes where practical.

## Verification

Run relevant checks and report exact commands/results.

## Done Evidence

Report changed files, verification, PR link, preview link if any, and residual risks.
