# Reviewer Thread Template

Use this when dispatching a read-only reviewer/spec Codex thread.

## Mission

Review implementation for Linear issue: `{ISSUE_ID}`.

## Required Context

- Worker thread: `{WORKER_THREAD}`
- PR: `{PR_LINK}`
- Issue: `{ISSUE_LINK}`
- Project or PRD: `{PROJECT_OR_PRD}`
- Fetched `origin/<default>` ref/SHA: `{DEFAULT_REF}` / `{BASE_SHA}`
- Fetch time: `{FETCH_TIME}`
- Durable dispatch comment: `{DISPATCH_COMMENT}`
- Codex new-lane
  `startingState: { type: "branch", branchName: "origin/<default>" }`:
  `{STARTING_STATE}`
- Lane mode: `new` or explicit resume/special-ref `{LANE_MODE}`
- Durable issue/handoff comment for any override: `{OVERRIDE_COMMENT}`
- Detached reviewer worktree: `{WORKTREE_PATH}`
- Required skills and standards: `{SKILLS}`

## Review Scope

The reviewer must remain detached and strictly read-only unless a narrower
reviewed need explicitly changes that role. Read the live Linear issue, parent
Project/PRD, blockers, and comments before reviewing. Treat this handoff as
orientation only.

Before reviewing a plan, run `git fetch --prune origin`, require symbolic
`refs/remotes/origin/HEAD` under `refs/remotes/origin/`, derive
`origin/<default>`, and resolve its exact commit and merge-base. Missing or
invalid provenance fails closed. For new lanes, independently prove the reviewer
worktree is clean, detached, and at the exact dispatched default commit:
`HEAD == origin/<default> == merge-base`, with ahead/behind `0/0`, matching the
recorded fetch time, durable dispatch comment, and
`startingState: { type: "branch", branchName: "origin/<default>" }`. A local
`main`, the coordinator's `HEAD`, or handoff prose is not evidence.

An explicit resume/special-ref instead requires a durable issue/handoff comment
and a durable dispatch comment recording the override ref, exact resumed HEAD,
fetched remote-default ref/SHA, merge-base, ahead/behind, honest clean/dirty
state, and fetch time. Prove the override ref resolves to the exact resumed HEAD.
Non-zero or dirty evidence must be assessed without mutation; it does not
authorize reset, clean, merge, automatic rebase, force-move, or discard work. If
a required relationship is unresolvable, the review fails closed. If the default
advances before new-lane review authority,
hold review and require the `worktree-isolation` refresh, relevant baselines,
existing-plan revalidation, and focused review of affected deltas. Require a
replacement plan only when product scope or acceptance criteria materially changed.

If the worker has not posted a plan or PR yet, acknowledge the assignment and
wait. Do not invent implementation work.

Review one compact plan by default. If changes are needed, request targeted
deltas and review one revision. Never demand a replacement plan unless product
scope or acceptance criteria materially changed. Do not begin a third cycle
without explicit human approval. When no `pre-edit blocker` remains, release
bounded edit authority for the smallest reversible tracer.

After implementation begins, review the working diff, tests, runtime evidence,
and focused deltas. Do not return to whole-package architecture review. Acceptance
criteria control scope; route useful unrelated hardening to follow-up work.

You may leave GitHub PR review comments for concrete line-level findings. Still
post the final verdict and summary in this reviewer thread. Do not merge, change
Linear state, or treat PR comments as your final verdict.

Check:

- worker plan when available, especially for overcomplication, scope drift, or
  missed constraints
- for new lanes, whether both worktrees were created from the same exact fetched
  base, the worker created and owns its topic branch there, the reviewer stayed
  detached, and the worker proved fetch time, durable dispatch comment, clean
  exact-base, and baseline status before implementation; for explicit resumes,
  apply the separate override evidence above
- spec adherence
- simplicity and architecture
- standards and skills
- tests and verification
- security, privacy, reliability, and data risks
- Browser/preview or focused runtime behavior for user-visible changes. Check
  at least one happy path and one risk interaction where practical, such as
  submit, retry, cancel, refresh, rapid click, or double submit. Look for
  console errors, failed critical requests, loading-state gaps, visible FOUC,
  layout shift, interaction jank, duplicate requests, and double submissions.
  Use a cheap read-only subagent for this probe when available.

Classify every finding as exactly one of `pre-edit blocker`, `pre-merge
blocker`, `deferred hardening`, or `question`. Among review findings, only a
`pre-edit blocker` prevents implementation from beginning; uncertainty alone is
a `question`.

## Output Format

Verdict: approve | approve with notes | changes requested | blocked

Review phase: initial plan | targeted revision | working diff

Edit authority: released | held for pre-edit blocker | awaiting human approval for third cycle

Findings: each finding must name exactly one required classification

Spec adherence:

Simplicity and architecture:

Standards and skills:

Tests and verification:

Runtime verification:

Finding disposition and pre-merge resolution:

Residual risks:
