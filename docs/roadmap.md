# Gaia Roadmap

This roadmap preserves the path from local prototype to software factory. Each
slice should stay independently useful, testable, and reversible.

The holistic product direction lives in [`vision.md`](vision.md). Keep this
roadmap as the delivery ledger for thin, verifiable slices that move toward
that local-first software factory.

## Principles

- Keep Gaia as a control plane, not a mega-agent.
- Prove durable lifecycle contracts before adding smarter workers.
- Prefer visible worker threads and evidence over hidden automation.
- Keep the orchestrator in final authority for merge/deploy decisions.
- Make each slice small enough to review against the spec and skills.
- Do not add external integrations until the local seam they plug into is
  boring.

## Slice 1: Local Run Lifecycle

Status: **Done**

Prove the smallest local loop:

- read a Markdown spec;
- create `.gaia/runs/run-<id>/`;
- append `events.jsonl`;
- derive `snapshots.jsonl`;
- run a deterministic fake harness;
- verify one artifact;
- write `report.md` and `report.json`;
- resume completed runs by replaying events.

## Slice 2: Workspace Preparation

Status: **Done**

Add isolated run workspaces before real coding workers exist.

Target behavior:

- `gaia run` can prepare an empty workspace by default;
- `gaia run --workspace-source <dir>` can copy a local source directory into the
  run workspace;
- generated/heavy directories such as `.git`, `.gaia`, `node_modules`, `dist`,
  and `.turbo` are excluded;
- workspace preparation writes a manifest artifact;
- the `WORKSPACE_PREPARED` event records serializable workspace evidence;
- tests prove the copied workspace is isolated and resumable.

Non-goals:

- real git clone;
- branch creation;
- worktree management;
- target-repo mutation;
- AI worker execution.

## Slice 3: Harness Port

Status: **Done**

Introduce a tiny worker/harness seam while keeping the fake harness as one
adapter.

Completed behavior:

- define the worker input/output contract;
- keep run events independent of a specific harness vendor;
- add one deterministic adapter;
- persist worker logs and result artifacts consistently.

Non-goals:

- real external harness execution;
- reviewer workers;
- pull requests;
- multi-agent scheduling.

See [`harness-port.md`](harness-port.md) for the adapter contract and future
popular-harness integration rules.

## Slice 3b: First Real Harness Adapter

Status: **Done**

Add one real experimental adapter behind the harness port.

Completed behavior:

- add the `process` harness for local CLI/wrapper execution;
- keep the fake harness as the deterministic test adapter;
- persist native logs and normalized `HarnessRunResult` evidence;
- prove the adapter against a throwaway local workspace.

Non-goals:

- reviewer workers;
- pull requests;
- merge/deploy automation.

## Slice 4: Reviewer Spectrum

Status: **Done**

Add read-only spec/review worker threads that keep implementation workers honest.

Completed behavior:

- Gaia writes a worker plan artifact before harness execution;
- deterministic plan review parses the worker plan and workspace manifest before
  implementation;
- deterministic evidence review parses worker and verification artifacts after
  implementation;
- reviewer output is persisted as `plan-review.*` and `evidence-review.*`;
- reviewers only write review artifacts, not workspace files.

Non-goals:

- merge authority;
- broad policy engine;
- hidden subagent-only review.

## Slice 5: GitHub Pull Request Loop

Status: **Mostly Complete**

Connect local runs to GitHub once workspaces and worker evidence are stable.

Completed behavior:

- create a `gaia/<run-id>` branch from the configured base;
- copy selected run evidence into `gaia-runs/<run-id>/`;
- commit and push the evidence branch;
- open a draft PR with the Gaia report as the body;
- restore the original local branch;
- inspect PR checks and normalize them to `no-checks`, `pending`, `passed`, or
  `failed`;
- attach GitHub check-state snapshots to completed Gaia runs;
- poll GitHub checks on demand until they leave `pending`, with a bounded fixed
  interval;
- mirror a completed run workspace to a `gaia/<run-id>-workspace` branch;
- skip harness-declared workspace artifacts during source PR application;
- refuse workspace PRs when there are no source changes;
- record human PR feedback separately from CI state;
- coordinate CI and PR feedback into one ordered next action for the PR loop.

Remaining behavior:

- worker remediation handoff from the PR-loop next action into a follow-up run;
- attach richer report/evidence comments once PR comments are needed;
- connect a real Codex worker harness to the workspace loop.

Non-goals:

- auto-merge;
- deploy decisions;
- Linear sync.

## Slice 6: Linear Issue Graph

Use Linear as the planning and blocker source of truth.

Target behavior:

- intake one Linear issue as a Gaia spec;
- model blockers using Linear blockers;
- update run status back to Linear;
- keep human-readable decisions in issue comments/docs.

Non-goals:

- local duplicate label system;
- full portfolio management.

## Slice 7: Merge And Deployment Authority

Let Gaia enforce evidence gates before merging.

Target behavior:

- orchestrator has final authority;
- reviewer/spec evidence is required for non-trivial changes;
- checks must pass;
- browser/e2e evidence is attached when applicable;
- merge/deploy actions are explicit, logged, and recoverable.

Non-goals:

- bypassing human override;
- treating frontend route guards or generated checks as security proof.

## Future Slices

Prioritize no-harness slices in this order until a real Codex harness is
available:

1. **Run store concurrency policy**: completed. Gaia now uses `.gaia/lock` to
   serialize local run-store mutations.
2. **Repository preflight checks**: completed. `preflight-github` verifies clean
   worktree, git repository, current branch, remote, base branch, auth status,
   and completed-run readiness before PR publishing.
3. **Dry-run PR previews**: completed. `preview-pr` shows branch, base,
   evidence path, source-change claim, and exact external commands without
   mutating git or GitHub.
4. **Process harness contract enrichment**: completed. The process harness now
   has a versioned environment contract, validates declared workspace output
   artifacts, records changed workspace files, and persists exit evidence.
5. **Skill bundle manifest**: completed. `gaia run --skill-manifest <path>`
   records a normalized pinned manifest with source repo/path and version or
   commit, without installing skills automatically.
6. **Read-only browser evidence shape**: completed and extended. Runs now
   write typed `browser-evidence.json` with `not-collected` status, and the
   explicit `collect-browser-evidence` command can populate screenshots,
   console messages, or failed-capture evidence for completed runs. `gaia run
   --browser-url <url>` can also collect browser evidence before the evidence
   reviewer runs, and `--require-browser-evidence` turns failed browser capture
   into a run-blocking check. `gaia run --profile frontend` now applies that
   requirement and profile target through a checked-in profile, process
   harnesses can declare typed preview deployment targets, and explicit
   `--browser-url` can override the target for one-off runs.
7. **CI watcher model**: completed and extended. GitHub check recording now
   writes `ci-watch-state.json` with latest snapshot, status, terminal flag,
   and next action. `gaia watch-ci <run-id> [pr]` can start or resume bounded
   CI watching, appends snapshots over time, short-circuits terminal stored
   state, and marks failed checks with `nextAction: "fix-failed-checks"`.
8. **GitHub PR feedback watcher**: completed. `gaia watch-pr-feedback
   <run-id> <pr>` records PR comments, latest reviews, review decision, and
   requested-reviewer count in `github-feedback.json`, then recommends
   `address-review-comments`, `respond-to-comments`, `await-review`, or
   `complete`.
9. **GitHub PR loop coordinator**: completed. `gaia pr-loop <run-id> <pr>`
   records one CI snapshot and one PR feedback snapshot, writes
   `pr-loop-state.json`, appends `GITHUB_PR_LOOP_RECORDED`, and recommends the
   next ordered action without merging or fixing code itself.
10. **Worker remediation handoff**: next. Turn a blocked PR-loop state into a
   clear follow-up spec/run for the worker while preserving orchestrator final
   authority.
11. **Local Gaia server**: next product-track slice. Introduce `gaia server` as
   a local source-of-truth API over the existing filesystem-backed run store so
   the CLI and future dashboard can share state.

## Harness Slice

The Codex harness MVP is implemented. See
[`codex-harness-adapter.md`](codex-harness-adapter.md) for the implemented
minimum viable adapter and heavier visible-session design.

## Post-Harness Roadmap

The steps after harness integration are documented in
[`post-harness-roadmap.md`](post-harness-roadmap.md). In order, they are:

1. real workspace PR loop;
2. Codex harness hardening;
3. visible reviewer spectrum;
4. skill bundle installation and versioning;
5. live browser evidence capture;
6. CI watcher;
7. GitHub PR feedback watcher;
8. GitHub PR loop coordinator;
9. worker remediation handoff;
10. local Gaia server and dashboard foundation;
11. Linear issue graph;
12. merge and deployment authority;
13. persistent run index and operator UI;
14. multi-harness support;
15. reusable factory templates.
