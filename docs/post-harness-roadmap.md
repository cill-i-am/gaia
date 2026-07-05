# Post-Harness Roadmap

This roadmap starts after Gaia has a real Codex worker harness. The goal is to
keep Gaia moving toward a software factory without turning the control plane
into a hidden mega-agent.

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

Status: **Completed for explicit and run-integrated target URL capture; gates remain**

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
- Evidence publishing copies the `browser/` folder when screenshots exist.

Remaining:

- Define profile/check policy for when failed browser evidence blocks a run.
- Add target URL discovery from worker output, preview deploys, or future
  profiles.

Non-goals:

- synthetic monitoring;
- visual diff infrastructure;
- treating frontend route guards as security proof.

## Phase 5: CI Watcher Daemon

Goal:

- Extend `ci-watch-state.json` into a resumable background watcher.

Build after:

- Runs regularly open PRs with real checks to watch.

Done when:

- Gaia can resume pending watch state after process restart.
- It appends check snapshots over time.
- It stops when checks reach `no-checks`, `passed`, or `failed`.
- It never treats pending checks as passed.

Non-goals:

- merge authority;
- unbounded polling;
- hidden global daemon state.

## Phase 6: Linear Issue Graph

Goal:

- Use Linear as the planning and blocker source of truth.

Build after:

- Real worker/reviewer loop is producing useful PRs.

Done when:

- Gaia can intake one Linear issue into a run spec.
- Linear blockers model issue dependencies.
- Gaia posts run, PR, and check status back to Linear.
- Human-readable decisions stay in Linear comments or linked docs.

Non-goals:

- duplicate local labels;
- full portfolio management.

## Phase 7: Merge and Deployment Authority

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
