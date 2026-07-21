# Worker Thread Template

Use this when dispatching a Codex worker thread.

## Mission

Implement Linear issue: `{ISSUE_ID}`.

## Required Context

- Project or PRD: `{PROJECT_OR_PRD}`
- Issue: `{ISSUE_LINK}`
- Fetched `origin/<default>` ref/SHA: `{DEFAULT_REF}` / `{BASE_SHA}`
- Fetch time: `{FETCH_TIME}`
- Durable dispatch comment: `{DISPATCH_COMMENT}`
- Codex new-lane
  `startingState: { type: "branch", branchName: "origin/<default>" }`:
  `{STARTING_STATE}`
- Lane mode: `new` or explicit resume/special-ref `{LANE_MODE}`
- Durable issue/handoff comment for any override: `{OVERRIDE_COMMENT}`
- Worker worktree: `{WORKTREE_PATH}`
- New-lane topic branch expectation: `codex/{ISSUE_ID}-{SLUG}`, created and owned
  by the worker; explicit resumes preserve `{OVERRIDE_REF}`
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
- For a new lane, use the orchestrator-provisioned worktree created from the
  exact dispatched base SHA and create and own the topic branch there. For an
  explicit resume/special-ref, preserve and prove the authorized ref/HEAD instead
  of running new-lane branch creation. Do not use local `main`, the coordinator's
  `HEAD`, or this handoff as base evidence.
- Before planning or editing, run `git fetch --prune origin`, require symbolic
  `refs/remotes/origin/HEAD` under `refs/remotes/origin/`, derive
  `origin/<default>`, and resolve the exact commit and merge-base. Missing or
  invalid provenance fails closed.
- For new lanes, report the isolated path, topic branch, fetch time, durable
  dispatch comment, fetched remote-default ref/SHA, empty worktree status, and
  prove
  `HEAD == origin/<default> == merge-base` with ahead/behind `0/0`, plus install
  and baseline results. Independently prove the created
  worktree matches the recorded
  `startingState: { type: "branch", branchName: "origin/<default>" }` commit.
- For an explicit resume/special-ref, report the override ref, exact resumed
  HEAD, fetched remote-default ref/SHA, merge-base, ahead/behind, honest
  clean/dirty state, fetch time, and durable dispatch comment. Prove the override
  ref resolves to the exact resumed HEAD. Non-zero or dirty state is evidence to
  assess. It does not authorize reset, clean, merge, automatic rebase,
  force-move, or discard work; stop if a required relationship is unresolvable
  so the resume fails closed.
- If `origin/<default>` advances before new-lane edit authority, hold work and
  notify the orchestrator. Refresh only through the non-destructive procedure in
  `worktree-isolation`, then rerun relevant baselines, revalidate the existing
  plan, and repeat focused review for affected deltas.
- Keep changes surgical and simple.
- Post one compact plan covering material architecture decisions, scope and
  explicit boundaries, the smallest end-to-end tracer, intended tests and
  verification, known risks, and deferred questions. Do not pre-specify every
  table, query, retry, operation count, or hypothetical failure path. Keep
  high-risk planning within approximately 60-90 minutes by default.
- Obtain one independent plan review. If changes are requested, make one targeted
  revision; replace the plan only if product scope or acceptance criteria changed.
- Never enter a third plan-review cycle without explicit human approval.
- Begin a bounded reversible slice once no `pre-edit blocker` remains. Build the
  smallest tracer, gather executable evidence, and open a draft PR when it works.
- Stop and report if scope or product intent is wrong.
- Use Linear blockers for dependency issues.
- Use Browser verification for user-visible changes where practical.

## Verification

Run relevant checks and report exact commands/results.

## Done Evidence

Report changed files, verification, PR link, preview link if any, and residual risks.
