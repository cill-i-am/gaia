# Execution Policy

The orchestrator owns the work loop. Workers implement. Reviewers/spec agents verify.

## Roles

- `Orchestrator`: decomposes work, dispatches threads, owns final done/merge decision.
- `Worker`: implements one issue in an isolated worktree and produces a PR.
- `Reviewer/Spec`: read-only reviewer that checks spec adherence, simplicity, tests, and standards.
- `CI Watch`: monitors checks, PR comments, review state, and deployment previews.

## Dispatch Rules

- Create a user-visible worker thread for each non-trivial implementation issue.
- Create the paired user-visible reviewer/spec thread at the same dispatch time.
- Use Codex app thread tools for thread lifecycle: discover thread tools when they are not loaded, use `list_threads` when avoiding duplicate worker or reviewer threads, use `create_thread` for new user-visible threads, use `send_message_to_thread` for steering, and use `set_thread_archived` only after the thread is no longer needed.
- Before dispatching, check Linear comments/status, linked PRs, existing worker/reviewer threads, and active heartbeats. Reuse or steer an active owner instead of creating a duplicate worker for the same issue.
- Let the reviewer/spec thread stay mostly idle until the worker posts a plan or PR when there is nothing useful to inspect yet.
- The orchestrator may waive the reviewer/spec thread only for tiny or mechanical changes, and should record why.
- Use `automation_update` for heartbeat automations. Do not write raw automation directives by hand.

## Worktree Base Provenance

- Before every dispatch or base refresh, run `git fetch --prune origin`, require symbolic `refs/remotes/origin/HEAD` under `refs/remotes/origin/`, derive `origin/<default>`, and resolve its exact commit. Missing or invalid fetch, remote HEAD, commit, or merge-base evidence fails closed.
- For new lanes, create the worker and paired reviewer worktrees from that same exact commit. A local `main`, the coordinator's current `HEAD`, or handoff prose is not base evidence.
- For new lanes, dispatch Codex with `startingState: { type: "branch", branchName: "origin/<default>" }` and independently verify the created worktree against the recorded commit.
- For new lanes, the worker creates and owns its `codex/<issue>-<slug>` topic branch inside the pre-provisioned worktree. The reviewer remains detached and strictly read-only unless a narrower reviewed need explicitly changes that role.
- Before worker planning, reviewer plan review, or edits in new lanes, require an empty worktree plus proof that `HEAD == origin/<default> == merge-base` and ahead/behind is `0/0` after a fresh fetch. Record the fetch time and durable dispatch comment for the exact pair.
- An explicit resume/special-ref requires a durable issue/handoff comment. Its durable dispatch comment records the override ref, exact resumed HEAD, fetched remote-default ref/SHA, merge-base, ahead/behind, honest clean/dirty state, and fetch time. Prove the override ref resolves to the exact resumed HEAD. Non-zero or dirty evidence is assessed, not rewritten; it does not authorize reset, clean, merge, automatic rebase, force-move, or discard work. An unresolvable relationship fails closed.
- If `origin/<default>` advances before new-lane edit authority, hold both lanes. Follow `worktree-isolation` to incorporate the exact fresh commit with a non-destructive, reviewable operation, rerun relevant baselines, revalidate the existing plan against the fresh base, and repeat focused review for affected deltas. Replace the plan only if scope or acceptance criteria changed.

## Planning Lifecycle

- Default to one compact implementation plan and one independent plan review.
- If review requests changes, allow one targeted revision. Do not require a replacement plan unless product scope or acceptance criteria materially changed.
- Never start a third plan-review cycle automatically. Stop and request explicit human approval.
- Once the plan is safe enough for a small reversible slice, grant bounded edit authority and learn through executable code. High-risk planning should normally fit within approximately 60-90 minutes.
- Cover material architecture decisions, scope and explicit boundaries, the smallest end-to-end tracer, intended tests and verification, known risks, and deferred questions. Do not specify every table, query, retry, operation count, or hypothetical failure path.

## Finding Classification

Classify every plan-review and code-review finding as exactly one of:

- `pre-edit blocker`: evidence that a bounded reversible slice would be unsafe or likely encode the wrong product meaning, such as a missing product decision that changes acceptance criteria, unauthorized irreversible external action, unresolved destructive data/migration boundary, or no provider-free test seam.
- `pre-merge blocker`: concrete evidence of data loss or orphaned durable evidence, duplicate paid calls or uncontrolled retries, invalid migrations, privacy/credential/raw-provider-data leakage, incorrect lifecycle/public state, or direct failure of acceptance criteria.
- `deferred hardening`: useful non-blocking resilience, operability, observability, generalization, or cleanup work.
- `question`: unresolved intent or uncertainty that needs an answer but is not yet a proven blocker.

Among review findings, only a `pre-edit blocker` prevents implementation from beginning. Uncertainty alone is not one. Resolve `pre-merge blocker` findings before merge unless the orchestrator explicitly accepts the residual risk. Existing provenance, HITL, provider-authority, and destructive-action gates still apply.

## Scope And Evidence

- Issue acceptance criteria control scope. Reviewers must not silently expand an issue into unrelated production hardening.
- New rollout canaries, generalized schedulers, control-plane attestation, elaborate reconciliation systems, broad observability platforms, and similar hardening require orchestrator approval unless a failing tracer or acceptance criterion proves they are necessary.
- Route useful non-blocking work to an outcome-named follow-up issue.
- Prefer executable evidence: realistic migration fixtures, measured operation counts, provider-free fakes and outbound-call traps, crash/replay and lifecycle tests, and the smallest vertical tracer. Open a draft PR as soon as it works.
- After implementation starts, review the working diff, tests, runtime evidence, and focused deltas. Do not return to whole-package architecture review.

## Stall Detection

- Two plan-review cycles with no source diff or draft PR stop the planning loop and require human notification. Never commission another complete plan.
- Also notify when several hours pass after edit authority without a source diff, executable blocker, or draft PR.
- Report elapsed time and cycle evidence, current blocker classification, and the smallest available rescue tracer.

## Worker Rules

- Use a user-visible Codex worker thread for non-trivial implementation.
- For a new lane, use the exact-base worktree provisioned by the orchestrator and create the worker-owned topic branch there before planning. For an explicit resume/special-ref, preserve and prove the authorized ref/HEAD instead.
- Do not implement a new lane until the worker can report the isolated path, topic branch, fetched base commit, fetch time, durable dispatch comment, clean-state and equality proof, ahead/behind `0/0`, install result, and baseline check result or blocker. Apply the separate resume evidence above to explicit resumes/special refs.
- Read the live Linear issue, parent Project/PRD, blockers, and comments before planning. Handoff context is orientation only.
- Post one compact plan and obtain one independent review. Apply at most one targeted revision, then proceed with a bounded reversible slice unless a `pre-edit blocker` remains. A third cycle requires explicit human approval.
- Address concrete in-scope reviewer comments directly during PR/CI watch.
- Stop for orchestrator input when feedback materially changes product scope or acceptance criteria, reveals a `pre-edit blocker`, or exceeds worker authority. Address `pre-merge blocker` findings with targeted code/tests and route `deferred hardening` to follow-up work.
- Create follow-up Linear issues only for narrow, concrete work discovered during implementation or review. Link the source issue, explain why the work is out of scope, and leave prioritization to triage or the orchestrator.
- Do not create speculative backlog items.
- Run relevant checks before handing off.
- Use the in-app Browser for user-visible behavior where practical.
- Record evidence in the thread, Linear, and PR.

## Reviewer Rules

For new-lane reviews, the reviewer is detached and read-only. Before reviewing the worker's plan, it independently proves its clean worktree is still at the dispatched, freshly fetched `origin/<default>` commit with ahead/behind `0/0`. For explicit resume/special-ref reviews, the reviewer remains read-only and applies the override evidence above instead of requiring default-base equality or `0/0`; it reports worker clean/dirty state without mutating it. Every reviewer reads live Linear before reviewing the plan when possible and the final diff before approval. Plan review should catch overcomplication, scope drift, or missed constraints. It must classify every finding, request only targeted plan deltas, and release bounded edit authority when no `pre-edit blocker` remains. After edits, review the working diff and executable evidence rather than restarting architecture planning.

For user-visible changes, the reviewer should gather independent runtime evidence with the in-app Browser, preview target, or a focused test subset when practical. Use a cheap read-only subagent for this probe when useful. Check the changed route or flow for console errors, failed critical requests, loading state gaps, visible FOUC, layout shift, interaction jank, duplicate requests, and double submissions. If runtime verification is not practical, state the specific blocker or waiver.

Reviewer output must include:

- verdict: approve, approve with notes, changes requested, or blocked
- review phase: initial plan, targeted revision, or working diff
- edit authority: released, held for a `pre-edit blocker`, or awaiting human approval for a third cycle
- findings classified as `pre-edit blocker`, `pre-merge blocker`, `deferred hardening`, or `question`
- spec adherence
- simplicity and architecture
- standards and skills
- tests and verification
- runtime verification for user-visible changes, or not-run reason
- finding disposition and pre-merge resolution
- residual risks

Reviewers may leave GitHub PR review comments for concrete line-level findings. They must still post the final verdict and summary in the reviewer thread. PR comments carry code feedback, not merge authority or Linear state authority.

## Merge Authority

The orchestrator has final authority. Agents may merge only when that authority is delegated and all gates pass.

Required gates:

- acceptance criteria satisfied
- reviewer approved or explicitly waived by orchestrator
- CI green or failures explained and accepted
- Browser/preview or focused runtime evidence for user-visible changes, including obvious FOUC, jank, or double-submit risks when relevant
- no unresolved blockers or required PR comments
- no unapproved scope creep, destructive action, or provider mutation
