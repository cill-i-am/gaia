# Post-Harness Roadmap

This roadmap starts after Gaia has a real Codex worker harness. The goal is to
keep Gaia moving toward a software factory without turning the control plane
into a hidden mega-agent.

The product north star is documented in [`vision.md`](vision.md). This roadmap
tracks the implementation slices that prepare the local-first control plane for
that server/dashboard/runner shape.

## Ordering Principles

- Ship one independently useful slice at a time.
- Keep the event log and run artifacts as the source of truth.
- Prefer visible worker and reviewer sessions over hidden automation.
- Keep orchestrator authority explicit for merge and deploy decisions.
- Do not add a daemon, dashboard, or integration until the local artifact model
  it consumes is stable.

## Phase 0: Codex Harness Adapter

Status: **Completed for the non-interactive CLI MVP**

Goal:

- Run a real Codex implementation worker through the existing `GaiaHarness`
  port.

Done when:

- `gaia run --harness codex` can execute Codex against the isolated run
  workspace.
- Codex output is persisted to `worker.log`.
- Gaia writes normalized `worker-result.json`.
- Changed workspace files and declared output artifacts are recorded.
- Existing verification, report writing, PR preview, and PR publishing continue
  to work without harness-specific branches in `runSpecFile`.

Spec:

- See [`codex-harness-adapter.md`](codex-harness-adapter.md).

Deferred from this phase:

- visible Codex worker sessions;
- session resume/cancellation;
- structured Codex event parsing beyond captured stdout/stderr.

## Phase 1: Real Workspace PR Loop

Status: **Completed**

Goal:

- Make Codex-produced source changes flow into the existing workspace PR path.

Build after:

- Codex harness MVP. This is now available.

Done when:

- A real Codex run can modify the isolated workspace.
- `publish-workspace-pr` opens a draft PR containing those source changes plus
  Gaia evidence.
- Gaia still rejects workspace PRs with no source changes.
- Harness-owned artifacts are not accidentally published as product source.

Non-goals:

- auto-merge;
- deployment;
- Linear sync.

## Phase 1.5: Codex Harness Hardening

Status: **Completed for subprocess timeout and typed timeout failure**

Goal:

- Make the non-interactive Codex CLI adapter safer before adding visible
  reviewer sessions.

Done when:

- Codex subprocesses have an explicit bounded lifetime.
- Timeout and process-level failures are classified as typed Gaia failures.
- The command-runner seam records enough evidence to diagnose failures without
  leaking operator secrets.
- CLI users can override safe defaults without raw `codex exec` argument hacks.

Non-goals:

- visible Codex worker sessions;
- reviewer worker sessions;
- automatic retries or resume.

## Phase 2: Visible Reviewer Spectrum

Status: **In progress: Codex CLI reviewer adapter and typed session evidence completed; visible sessions remain**

Goal:

- Add visible read-only reviewer/spec worker sessions that review the
  implementation worker plan and output.

Build after:

- Codex implementation runs can create source changes.

Done when:

- Non-trivial runs can create a read-only reviewer session.
- The reviewer checks the worker plan before implementation where practical.
- The reviewer checks the final diff/evidence after implementation.
- Reviewer artifacts are persisted as Gaia evidence.
- Reviewer agents cannot mutate the workspace. The runtime now enforces this
  for the reviewer port by snapshotting the isolated workspace before and after
  review.

Completed foundation:

- Review execution is now an explicit `GaiaReviewer` port.
- The deterministic reviewer remains the default implementation.
- Custom reviewers run through the same lifecycle events and artifacts.
- Workspace mutation by a reviewer fails the run with a typed Gaia error.
- `gaia run --reviewer codex` can run a Codex CLI reviewer in read-only mode.
- Codex reviewer transcripts and logs are persisted as run evidence.
- Reviewer session evidence is persisted as `plan-reviewer-session.json` and
  `evidence-reviewer-session.json`.
- A blocked plan review stops the run before worker execution.

Remaining:

- Visible Codex reviewer sessions with session/thread identifiers.
- Structured reviewer transcript capture beyond CLI stdout/stderr,
  last-message artifacts, and typed session metadata.
- Side-chat/resume semantics for reviewer sessions.

Non-goals:

- reviewer merge authority;
- hidden subagent-only review;
- broad policy engine.

## Phase 3: Skill Bundle Installation and Versioning

Status: **Completed for pinned local and git-backed skill sources**

Goal:

- Turn the recorded skill manifest into an installed, pinned worker context.

Build after:

- Codex worker prompt/context contract is stable.

Done when:

- Gaia can install or resolve each manifest entry before a worker starts.
- Installed skill source, version/commit, and local path are recorded.
- A missing or unpinned skill fails before worker execution.
- The worker prompt points to the resolved skill paths.

Completed foundation:

- Gaia writes `skill-bundle.json` for every run.
- Local manifest entries with `sourceRepository: "local"` or `"file"` resolve
  to checked skill directories containing `SKILL.md`.
- External git-backed manifest entries are cloned into the run directory,
  checked out at their pinned commit or version, and validated for `SKILL.md`.
- Missing local skill sources fail before worker execution.
- Unsupported repositories, failed installs, and missing installed skill
  directories fail before worker execution.
- Worker harnesses receive the skill bundle path and resolved skill paths.

Remaining:

- Registry-specific installers can be added when Gaia needs them.

Non-goals:

- registry abstraction beyond the sources Gaia actually needs;
- automatic upgrades.

## Phase 4: Live Browser Evidence Capture

Status: **Completed for explicit capture, run-integrated capture, required-evidence policy, profile-backed checks, and preview-deployment target discovery**

Goal:

- Populate the existing `browser-evidence.json` contract with screenshots,
  console evidence, and page URLs.

Build after:

- Real worker changes can be run in a representative local or preview target.

Done when:

- Gaia can run a read-only browser pass against a target URL.
- Screenshots are stored under the run directory.
- Console messages and page metadata are parsed into `browser-evidence.json`.
- Browser evidence is attached to reports and PR evidence.

Completed foundation:

- `gaia collect-browser-evidence <run-id> --url <http-url>` captures a
  completed run's target page through Playwright.
- `gaia run --browser-url <http-url>` captures browser evidence after
  verification and before the evidence reviewer runs.
- Browser screenshots are stored under the run directory's `browser/` folder.
- Console messages, page URL, screenshots, and failed-capture notes are written
  to `browser-evidence.json`.
- A `BROWSER_EVIDENCE_RECORDED` event enriches completed runs without changing
  their completed state, and can also be replayed while a run is still in the
  reporting phase.
- `gaia run --require-browser-evidence --browser-url <http-url>` fails the run
  if browser capture records anything other than `status: "collected"`.
- Run profiles are resolved into `run-profile.json`; `--profile frontend`
  requires browser evidence without relying on the one-off CLI flag and can
  provide a default browser target URL.
- Gaia resolves run-integrated browser targets from explicit `--browser-url`,
  then profile defaults, then preview deployment URLs, then worker-declared
  direct browser targets.
- Required browser evidence without any resolved target fails after worker
  completion and verification, before evidence review.
- Evidence publishing copies the `browser/` folder when screenshots exist.
- Process harnesses can declare a `previewDeploymentUrl` through
  `GAIA_WORKER_RESULT_PATH`; Gaia records it as `preview-deployment.json` and a
  `PREVIEW_DEPLOYMENT_RECORDED` event before browser evidence capture.

Non-goals:

- synthetic monitoring;
- visual diff infrastructure;
- creating real preview deployments;
- treating frontend route guards as security proof.

## Phase 5: CI Watcher

Status: **Completed for bounded resumable CLI watching**

Goal:

- Extend `ci-watch-state.json` into a resumable CI watcher.

Build after:

- Runs regularly open PRs with real checks to watch.

Done when:

- Gaia can resume pending watch state after process restart.
- It appends check snapshots over time.
- It stops when checks reach `no-checks`, `passed`, or `failed`.
- It never treats pending checks as passed.

Completed foundation:

- `gaia watch-ci <run-id> <pr>` starts a bounded check watch and records
  snapshots into the run.
- `gaia watch-ci <run-id>` resumes from `ci-watch-state.json`.
- Terminal stored state returns without polling GitHub again.
- Failed checks set `nextAction: "fix-failed-checks"` so the next agent move is
  explicit.

Non-goals:

- merge authority;
- unbounded polling;
- hidden global daemon state.
- PR review/comment watching. That belongs in a separate GitHub feedback
  watcher so CI state and human review state do not blur together.

## Phase 5.5: GitHub PR Feedback Watcher

Status: **Completed for bounded single-shot feedback recording**

Goal:

- Make human PR feedback visible to Gaia without mixing it into CI status.

Done when:

- Gaia can record PR comments, latest reviews, review decision, and requested
  reviewer count for a completed run.
- The artifact recommends a next action such as `address-review-comments`,
  `respond-to-comments`, `await-review`, or `complete`.
- The event log records feedback evidence without changing the completed run
  state.

Completed foundation:

- `gaia watch-pr-feedback <run-id> <pr>` writes `github-feedback.json`.
- `GITHUB_FEEDBACK_RECORDED` replays into run snapshots.
- Changes requested, comments-only, awaiting-review, and clear states are
  classified separately.
- Gaia records that unresolved review-thread state is not available from the
  current `gh pr view --json` source.

Non-goals:

- merge authority;
- comment posting;
- unresolved review-thread resolution;
- background GitHub notification watching.

## Phase 5.75: GitHub PR Loop Coordinator

Status: **Completed for single-shot CI and feedback coordination**

Goal:

- Combine CI state and human PR feedback into one ordered next action for an
  implementation or orchestration loop.

Build after:

- CI watch state and PR feedback artifacts exist.

Done when:

- Gaia records one current CI snapshot and one current PR feedback snapshot.
- Gaia writes `pr-loop-state.json` with status, blockers, and next action.
- Gaia appends `GITHUB_PR_LOOP_RECORDED` without leaving the completed run
  state.
- Changes-requested reviews outrank failed checks as the first action, while
  failed checks remain visible blockers.
- Pending CI and awaiting review are waiting states, not failures.
- A clean PR state returns `ready-for-merge-decision` without merging.

Completed foundation:

- `gaia pr-loop <run-id> <pr>` coordinates existing CI and feedback recorders.
- The PR-loop state is typed, serializable, and replayed through the run
  machine.
- The CLI supports human-readable and `--json` output.

Non-goals:

- auto-fixing code;
- auto-merging;
- hidden daemons;
- replacing CI or review artifacts with a lossy aggregate.

## Phase 5.9: Worker Remediation Handoff

Status: **Completed for explicit remediation spec creation**

Goal:

- Turn a blocked `pr-loop-state.json` into an explicit follow-up worker run or
  spec.

Build after:

- The PR-loop coordinator can produce stable next actions.

Done when:

- Gaia can create a remediation spec from a blocked PR loop.
- The remediation spec references the original run, PR, blockers, and relevant
  artifacts.
- The follow-up run remains visible and reviewable; no hidden auto-fix loop
  mutates a PR behind the operator's back.
- The orchestrator keeps final authority over whether the remediation run is
  started, published, or merged.

Completed foundation:

- `gaia plan-remediation <run-id>` reads `pr-loop-state.json` and writes
  `remediation-spec.md`.
- Gaia refuses remediation for `ready` or `waiting` PR loops.
- `GITHUB_REMEDIATION_SPEC_RECORDED` replays into run snapshots without
  changing completed state.
- The generated Markdown spec can be passed to `gaia run` later through the
  normal spec path.

Non-goals:

- automatically choosing arbitrary code changes from failing logs;
- merging after remediation;
- replacing human PR review conversation.

## Phase 5.95: PR Evidence Comments

Status: **Completed for timestamped Gaia evidence comments**

Goal:

- Publish a concise Gaia status/evidence comment to the GitHub PR.

Build after:

- The PR-loop coordinator and remediation handoff can explain what happened and
  what should happen next.

Done when:

- Gaia can create or update a PR comment that links the run report, CI snapshot,
  PR feedback artifact, PR-loop state, and remediation spec when present.
- The comment is idempotent for a run or clearly creates a new timestamped
  evidence comment.
- The comment does not replace durable artifacts in `.gaia/runs`.
- The command is explicit and bounded; it does not merge, approve, or dismiss
  review feedback.

Completed foundation:

- `gaia comment-pr <run-id> <pr>` writes `github-pr-comment.md`.
- The comment body references published Gaia evidence paths under
  `gaia-runs/<run-id>/`.
- The command posts through `gh pr comment <pr> --body-file <artifact>`.
- `GITHUB_PR_COMMENT_RECORDED` replays into run snapshots.
- The first version is deliberately timestamped, not idempotent, because Gaia
  does not yet own unresolved review-thread state.

Non-goals:

- unresolved review-thread resolution;
- comment spam;
- merge authority;
- replacing Linear or GitHub issue state.

## Product Track: Local Gaia Server

Status: **Later; do not start until the product-track slice is explicitly chosen**

Goal:

- Introduce `gaia server` as the local source-of-truth API while preserving the
  existing CLI behavior.

Build after:

- The local artifact model has enough stable concepts for runs, events,
  artifacts, PR loop state, and browser evidence.

Done when:

- A local server exposes run creation, run status, event reading/streaming, and
  artifact reading over typed API contracts.
- CLI commands can call the server where practical while direct local runtime
  commands remain usable during migration.
- Filesystem-backed `.gaia/runs` remains the storage adapter, not the public
  client contract.
- Tests prove CLI and API see the same run state.

Next product slices after that:

1. Local dashboard over the server API.
2. Harness account model for local installed auth.
3. Execution backend port for local shell versus trusted cloud runner.
4. Trusted cloud harness auth and artifact storage.
5. Hosted multi-user product shell.

Non-goals:

- dashboard-first rewrite;
- multi-tenant SaaS auth;
- cloud-only execution;
- moving workflow logic into the UI.

## Phase 6: Linear Issue Graph

Status: **Completed for local typed intake foundation**

Goal:

- Use Linear as the planning and blocker source of truth.

Build after:

- Real worker/reviewer loop is producing useful PRs.

Done when:

- Gaia can intake one Linear issue graph snapshot as run evidence.
- Linear blockers model issue dependencies.
- Gaia posts run, PR, and check status back to Linear.
- Human-readable decisions stay in Linear comments or linked docs.

Current behavior:

- `gaia linear-issue <run-id> <linear-issue-graph-file>` records one
  schema-validated Linear issue graph against a completed run.
- The graph preserves the primary issue plus `blockedBy` and `blocks`
  relationships using branded Linear issue identifiers.
- Gaia writes `linear-issue-graph.json` and appends
  `LINEAR_ISSUE_GRAPH_RECORDED`.

Deferred:

- live Linear API intake;
- status/comment sync back to Linear;
- generating the initial run spec directly from a Linear issue.

Non-goals:

- duplicate local labels;
- full portfolio management.

## Phase 7: Merge and Deployment Authority

Status: **Completed for explicit merge decision artifacts**

Goal:

- Let Gaia enforce evidence gates before merge/deploy decisions.

Build after:

- PRs, reviews, browser evidence, and CI watch state exist.

Done when:

- The orchestrator has final authority.
- Required checks are explicit and typed.
- Reviewer/spec evidence is required for non-trivial changes.
- Browser evidence is required only for changes that need it.
- Merge/deploy actions are explicit, logged, and recoverable.

Current behavior:

- `gaia merge-decision <run-id>` reads `pr-loop-state.json`, reviewer session
  evidence, run profile policy, and browser evidence.
- Gaia writes `merge-decision.json` and appends `MERGE_DECISION_RECORDED`.
- The decision is `approved` only when the PR loop is ready, checks passed,
  reviewer sessions approved, and required browser evidence is collected.
- The command recommends `merge-pr` or `resolve-blockers`; it does not merge,
  approve, comment, or deploy.

Deferred:

- actual GitHub merge execution;
- deployment execution;
- human override flows;
- deployment rollback/cleanup authority.

Non-goals:

- bypassing human override;
- equating frontend route guards or generated checks with security proof.

## Phase 8: Persistent Run Index and Operator UI

Goal:

- Make runs easier to inspect without replaying arbitrary directories every
  time.

Build after:

- The run lifecycle, PR loop, and watcher model are stable enough that operator
  ergonomics matter.

Done when:

- Gaia has a persistent run index, likely SQLite.
- The index is derived from or reconciled with the event log.
- A TUI or dashboard can inspect runs, pending actions, PRs, and evidence.

Non-goals:

- replacing the event log as source of truth;
- hiding failure evidence behind a UI-only state.

## Phase 9: Multi-Harness Support

Goal:

- Make Codex one adapter among several popular harnesses.

Build after:

- The Codex adapter proves the harness contract in real work.

Done when:

- Additional harnesses plug into the same normalized request/result contract.
- Gaia can compare harness capabilities without changing the run lifecycle.
- AI SDK HarnessAgent integration is evaluated against the proven adapter port.

Non-goals:

- abstracting over harnesses before at least two real adapters exist;
- lowering the contract to the weakest harness.

## Phase 10: Reusable Factory Templates

Goal:

- Package proven Gaia workflows into repeatable product factory templates.

Build after:

- The full loop can produce, review, PR, watch, and merge real changes.

Done when:

- New product repos can start from a small factory profile.
- Profiles declare required skills, checks, browser evidence needs, and deploy
  gates.
- Templates remain portable across the user's common stacks.

Non-goals:

- one universal app template;
- stack-specific rules inside the core Gaia lifecycle.
