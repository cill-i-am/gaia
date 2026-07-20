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
- Use Codex app thread tools for thread lifecycle: discover thread tools when
  they are not loaded, use `list_threads` when avoiding duplicate worker or
  reviewer threads, use `create_thread` for new user-visible threads, use
  `send_message_to_thread` for steering, and use `set_thread_archived` only
  after the thread is no longer needed.
- Before dispatching, check Linear comments/status, linked PRs, existing
  worker/reviewer threads, and active heartbeats. Reuse or steer an active owner
  instead of creating a duplicate worker for the same issue.
- Let the reviewer/spec thread stay mostly idle until the worker posts a plan or
  PR when there is nothing useful to inspect yet.
- The orchestrator may waive the reviewer/spec thread only for tiny or
  mechanical changes, and should record why.
- Use `automation_update` for heartbeat automations. Do not write raw automation
  directives by hand.

## Worktree Base Provenance

- Before every dispatch or base refresh, run `git fetch --prune origin`, require
  symbolic `refs/remotes/origin/HEAD` under `refs/remotes/origin/`, derive
  `origin/<default>`, and resolve its exact commit. Missing or invalid fetch,
  remote HEAD, commit, or merge-base evidence fails closed.
- For new lanes, create the worker and paired reviewer worktrees from that same
  exact commit. A local `main`, the coordinator's current `HEAD`, or handoff
  prose is not base evidence.
- For new lanes, dispatch Codex with
  `startingState: { type: "branch", branchName: "origin/<default>" }` and
  independently verify the created worktree against the recorded commit.
- For new lanes, the worker creates and owns its `codex/<issue>-<slug>` topic
  branch inside the pre-provisioned worktree. The reviewer remains detached and
  strictly read-only unless a narrower reviewed need explicitly changes that
  role.
- Before worker planning, reviewer plan review, or edits in new lanes, require
  an empty worktree plus proof that `HEAD == origin/<default> == merge-base` and
  ahead/behind is `0/0` after a fresh fetch. Record the fetch time and durable
  dispatch comment for the exact pair.
- An explicit resume/special-ref requires a durable issue/handoff comment. Its
  durable dispatch comment records the override ref, exact resumed HEAD,
  fetched remote-default ref/SHA, merge-base, ahead/behind, honest clean/dirty
  state, and fetch time. Prove the override ref resolves to the exact resumed
  HEAD. Non-zero or dirty evidence is assessed, not rewritten; it does not
  authorize reset, clean, merge, automatic rebase, force-move, or discard work.
  An unresolvable relationship fails closed.
- If `origin/<default>` advances before new-lane edit authority, hold both
  lanes. Follow `worktree-isolation` to incorporate the exact fresh commit with a
  non-destructive, reviewable operation, rerun relevant baselines, and repeat
  the plan/reviewer gate.

## Worker Rules

- Use a user-visible Codex worker thread for non-trivial implementation.
- For a new lane, use the exact-base worktree provisioned by the orchestrator and
  create the worker-owned topic branch there before planning. For an explicit
  resume/special-ref, preserve and prove the authorized ref/HEAD instead.
- Do not implement a new lane until the worker can report the isolated path,
  topic branch, fetched base commit, fetch time, durable dispatch comment,
  clean-state and equality proof, ahead/behind `0/0`, install result, and
  baseline check result or blocker. Apply the separate resume evidence above to
  explicit resumes/special refs.
- Read the live Linear issue, parent Project/PRD, blockers, and comments before
  planning. Handoff context is orientation only.
- Post a short plan before implementation.
- Proceed after posting the plan unless the issue, orchestrator, or risk level
  requires explicit plan approval.
- Address concrete in-scope reviewer comments directly during PR/CI watch.
- Stop for orchestrator input when reviewer feedback changes scope, product
  behavior, architecture, data shape, or requires judgment.
- Create follow-up Linear issues only for narrow, concrete work discovered
  during implementation or review. Link the source issue, explain why the work
  is out of scope, and leave prioritization to triage or the orchestrator.
- Do not create speculative backlog items.
- Run relevant checks before handing off.
- Use the in-app Browser for user-visible behavior where practical.
- Record evidence in the thread, Linear, and PR.

## Reviewer Rules

For new-lane reviews, the reviewer is detached and read-only. Before reviewing
the worker's plan, it independently proves its clean worktree is still at the
dispatched, freshly fetched `origin/<default>` commit with ahead/behind `0/0`.
For explicit resume/special-ref reviews, the reviewer remains read-only and
applies the override evidence above instead of requiring default-base equality
or `0/0`; it reports worker clean/dirty state without mutating it. Every reviewer
reads live Linear before reviewing the plan when possible and the final diff
before approval. Plan review should catch overcomplication, scope drift, or
missed constraints; it should not block normal AFK work unless approval was
explicitly required.

For user-visible changes, the reviewer should gather independent runtime
evidence with the in-app Browser, preview target, or a focused test subset when
practical. Use a cheap read-only subagent for this probe when useful. Check the
changed route or flow for console errors, failed critical requests, loading
state gaps, visible FOUC, layout shift, interaction jank, duplicate requests,
and double submissions. If runtime verification is not practical, state the
specific blocker or waiver.

Reviewer output must include:

- verdict: approve, approve with notes, changes requested, or blocked
- spec adherence
- simplicity and architecture
- standards and skills
- tests and verification
- runtime verification for user-visible changes, or not-run reason
- required fixes
- residual risks

Reviewers may leave GitHub PR review comments for concrete line-level findings.
They must still post the final verdict and summary in the reviewer thread. PR
comments carry code feedback, not merge authority or Linear state authority.

## Merge Authority

The orchestrator has final authority. Agents may merge only when that authority is delegated and all gates pass.

Required gates:

- acceptance criteria satisfied
- reviewer approved or explicitly waived by orchestrator
- CI green or failures explained and accepted
- Browser/preview or focused runtime evidence for user-visible changes,
  including obvious FOUC, jank, or double-submit risks when relevant
- no unresolved blockers or required PR comments
- no unapproved scope creep, destructive action, or provider mutation
