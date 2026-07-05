# Gaia Findings Log

This log captures decisions, tradeoffs, verification, and deferred work as Gaia
moves through the roadmap slices.

## Slice 1: Local Run Lifecycle

Outcome: Gaia can create a durable local run, append `events.jsonl`, derive
snapshots, run a deterministic local harness, verify one artifact, write reports,
and resume completed runs by replaying the event log.

Findings:

- `events.jsonl` should stay the source of truth. Snapshots and reports are
  derived evidence.
- Keeping the first worker deterministic made lifecycle failures obvious.
- Random-looking run IDs are not chronological, so `.gaia/latest` is the right
  source for `gaia status`.

Verification:

- Core lifecycle tests.
- Runtime smoke tests.
- CLI smoke with `run`, `status`, `list`, `resume`, and JSON output.

## Slice 2: Workspace Preparation

Outcome: Gaia can prepare an empty run workspace or copy a local source
directory into the isolated run workspace with `--workspace-source <dir>`.

Findings:

- Workspace copying must skip `.git`, `.gaia`, `.turbo`, `coverage`, `dist`,
  and `node_modules`; copying those into every run is noisy and unsafe.
- `workspace-manifest.json` gives enough evidence for this slice without adding
  a database index.
- Real git clone/worktree support should remain separate from local directory
  copying.

Verification:

- Runtime test proves copied files arrive and generated directories are skipped.
- CLI smoke copied the Gaia repo into a run workspace and replayed cleanly.

## Slice 3: Harness Port

Outcome: Gaia has a normalized harness port with `HarnessRunRequest`,
`HarnessRunResult`, `GaiaHarness`, and branded `HarnessName`. The deterministic
`fake` adapter is the first registered harness.

Findings:

- Gaia's event log should not know vendor-specific Codex, Claude, OpenCode, or
  AI SDK details.
- Unknown harnesses must fail fast. Silent fallback would hide broken factory
  configuration.
- A normalized `worker-result.json` is enough for the verifier and report writer
  to stay harness-neutral.

Verification:

- Runtime test records normalized harness evidence for `fake`.
- Runtime test proves unknown harnesses return typed `UnknownHarness`.
- CLI smoke with `--harness fake`.

## Slice 3b: First Real Harness Adapter

Outcome: Gaia has a `process` harness adapter. It runs one explicit command with
repeated args, passes Gaia context through environment variables, captures
stdout/stderr into `worker.log`, and writes a normalized `HarnessRunResult`.

Findings:

- The process adapter is the right first real boundary because it can wrap local
  CLIs without committing Gaia to one vendor too early.
- Avoiding shell strings was worth it. `--harness-command` plus repeated
  `--harness-arg` keeps command invocation inspectable and avoids shell parsing.
- The adapter currently captures bounded stdout/stderr after process completion.
  Streaming logs and cancellation should be separate slices if needed.
- Dedicated Codex, Claude, OpenCode, or AI SDK adapters still need their own
  session and credential semantics. The process adapter is a bridge, not the
  final vendor integration.
- The first CLI failure smoke exposed that harness execution failures were
  escaping before Gaia appended `RUN_FAILED`. Harness failures now record a
  `runningWorker` failure event, preserving resumability and status inspection.

Verification:

- Runtime test executes a real Node subprocess through `runSpecFile`.
- Runtime test proves a non-zero process exit leaves the latest run in `failed`
  state.
- CLI smoke runs the checked-in example process harness.
- Unknown harness and missing process-command failures remain typed.

## Slice 4: Reviewer Spectrum

Outcome: Gaia now writes a `worker-plan` artifact, runs deterministic read-only
plan and evidence reviews, persists `plan-review.*` and `evidence-review.*`, and
records review events in the append-only lifecycle log.

Findings:

- A plan review should inspect an actual plan artifact. The first pass writes a
  small Gaia-owned `WorkerPlan` before worker execution so the review contract is
  real without requiring a live coding agent yet.
- Reviewers are evidence producers, not lifecycle owners. `REVIEW_STARTED` and
  `REVIEW_COMPLETED` replay without adding a new top-level run state.
- The evidence review parses Gaia's own structured artifacts instead of scanning
  arbitrary text. That keeps the boundary typed and makes future reviewer agents
  replaceable.
- The deterministic reviewer is intentionally not the final reviewer spectrum.
  Real Codex/Claude/OpenCode reviewer threads still need visible sessions,
  cancellation, read-only workspace enforcement, and reviewer/orchestrator
  authority rules.

Verification:

- Core test proves review events replay and expose plan/evidence review paths in
  snapshots.
- Runtime test proves normal runs produce worker-plan, plan-review, and
  evidence-review artifacts.
- Runtime reviewer parses workspace, worker, verification, and worker-plan JSON
  through schemas before approving.

## Slice 5: GitHub Pull Request Loop, First Pass

Outcome: Gaia can publish a completed run as a draft GitHub PR. It creates a
`gaia/<run-id>` branch, copies selected run evidence into `gaia-runs/<run-id>/`,
commits, pushes, opens a draft PR with the Gaia report as the body, and restores
the original local branch.

Findings:

- GitHub publishing is the first intentionally remote-mutating Gaia command, so
  it must be explicit. It is not part of ordinary smoke testing.
- The first implementation should publish evidence, not pretend the fake worker
  changed a real product repo. Real target-repo patch application belongs with
  worktree support.
- A clean-worktree guard is non-negotiable. Gaia refuses to create PR branches
  if local tracked changes are already present.
- The implementation uses a narrow command-runner seam around explicit `git` and
  `gh` commands. Tests use a recording runner instead of touching GitHub.
- Check watching remains deferred. The Gaia repo currently has no meaningful
  Actions checks to watch, and the check watcher should be a separate
  resumable/status-aware behavior.

Verification:

- Runtime test proves successful publish command sequencing through the command
  seam and checks copied evidence.
- Runtime test proves dirty worktrees fail with typed `GitWorktreeDirty`.
- `gh auth status` confirms the local environment can authenticate when live
  publish smoke is intentionally run.
- Live smoke opened draft PR
  [`#1`](https://github.com/cill-i-am/gaia/pull/1) from
  `gaia/run-oOQuNPaFbQ` to `main`, then restored the local checkout to `main`.

## Slice 5: GitHub Check Inspection

Outcome: Gaia can inspect GitHub PR checks with `gaia pr-checks` and normalize
GitHub output to `no-checks`, `pending`, `passed`, or `failed`.

Findings:

- `gh pr checks` treats "no checks reported" as a nonzero command result. Gaia
  now models command `exitCode` explicitly so that expected GitHub states do not
  have to masquerade as command defects.
- Publishing still requires zero-exit `git` and `gh` commands. Check inspection
  is the only current GitHub command path that intentionally interprets nonzero
  output as data.
- Unknown or non-passing check states are conservative: they become `failed`
  unless they are recognized pending or passing states.
- Durable polling is still separate from read-only inspection. The next check
  slice should attach check snapshots to a run and optionally poll until a
  terminal state.

Verification:

- Runtime tests cover `no-checks`, `pending`, `passed`, and `failed` through the
  recording GitHub command seam.
- Live smoke against draft PR
  [`#1`](https://github.com/cill-i-am/gaia/pull/1) returned
  `{"status":"no-checks"}`.

## Slice 5B: Run-Scoped GitHub Check Evidence

Outcome: Gaia can attach GitHub check evidence to a completed run with
`gaia checks <run-id> <pr>`, and can poll with `--wait` until checks are no
longer pending before recording the snapshot.

Findings:

- Check snapshots are evidence, not lifecycle work. `GITHUB_CHECKS_RECORDED`
  appends after completion and leaves the run state as `completed`.
- `events.jsonl` stays authoritative. Gaia writes the check snapshot file under
  `github-checks/checks-<event-sequence>.json` and records the relative path,
  PR selector, status, attempt count, and terminal flag in the event payload.
- `pr-checks` remains a read-only inspector. `checks` is the run-attaching
  command.
- `--wait` is bounded and command-driven. It is not a daemon, merge gate, or
  long-lived CI watcher.

Verification:

- Core tests cover replaying `GITHUB_CHECKS_RECORDED` after completion.
- Runtime tests cover writing a check snapshot, appending the event, and polling
  from `pending` to `passed` through the recording GitHub command seam.

## Slice 5C: Workspace Pull Request Publishing

Outcome: Gaia can publish a completed run workspace as a draft GitHub PR with
`gaia publish-workspace-pr <run-id>`. It creates a
`gaia/<run-id>-workspace` branch from the configured base, applies the run
workspace, mirrors source additions/edits/deletions outside `.gaia/` and
`gaia-runs/`, adds the same selected run evidence under `gaia-runs/<run-id>/`,
pushes the branch, opens a draft PR, and restores the original local branch.

Findings:

- The evidence-only `publish-pr` command remains useful and separate. A
  workspace PR has a stronger claim: it must contain source changes.
- Harness-owned workspace artifacts are not source changes. Gaia reads the
  harness result schema and skips artifacts declared under `workspace/*`, such
  as the current fake/process `workspace/output.txt` artifact.
- Git already owns source-diff truth. Gaia stages with pathspec exclusions and
  uses `git diff --cached --quiet` to distinguish "has source changes" from "no
  source changes" without parsing porcelain output.
- `gaia-runs/` is now excluded from workspace source copying so prior evidence
  PR artifacts do not become future worker input.
- This slice still uses the local run workspace. Real Codex/worktree execution
  remains the next major integration, not part of this no-harness pass.
- Parallel local runs can race on `.gaia/latest`. Run directories remain
  isolated, but latest-run convenience should get an explicit concurrency
  policy before Gaia drives multiple live workers at once.

Verification:

- Runtime test proves workspace PR command sequencing through the recording
  GitHub command seam.
- Runtime test proves Gaia applies changed workspace files, propagates deleted
  workspace files, skips the harness-owned output artifact from source
  application, and still preserves it in PR evidence.
- Runtime test proves unchanged workspaces fail with typed
  `WorkspacePrNoChanges`.

## Slice 6A: Run Store Concurrency Policy

Outcome: Gaia serializes local run-store mutations with `.gaia/lock`. New runs
and GitHub check snapshot recording acquire the lock before mutating `.gaia/`
and release it when the mutation finishes. If the lock already exists, Gaia
fails fast with recoverable `RunStoreLocked`.

Findings:

- This is intentionally smaller than SQLite, a durable scheduler, or a run
  index. The only current correctness problem is concurrent local mutation of
  `.gaia/latest` and event/check evidence.
- Read-only commands remain unlocked. They can inspect completed or partially
  written runs without becoming part of mutation sequencing.
- The lock is a local directory, so acquisition uses the filesystem's atomic
  directory creation behavior and stays portable enough for the current local
  prototype.
- Stale-lock recovery is deferred. If a process is killed while holding the
  lock, the user can inspect/remove `.gaia/lock`; Gaia should grow a safer
  recovery policy before background workers or daemons exist.

Verification:

- Runtime test proves successful runs remove `.gaia/lock`.
- Runtime test proves a pre-existing lock rejects new runs with
  `RunStoreLocked`.
- Runtime test proves GitHub check recording also respects the lock.

## Slice 6B: GitHub Publish Preflight

Outcome: Gaia can run `gaia preflight-github <run-id>` to verify GitHub publish
readiness without mutating local git state or GitHub. The same preflight now
runs before both `publish-pr` and `publish-workspace-pr`.

Findings:

- Preflight remains read-only. It does not fetch, checkout, commit, push, or
  open a PR.
- The checks are intentionally concrete: completed run, git repository, clean
  worktree, current branch, configured remote, remote base branch, and GitHub
  CLI authentication.
- Specific failure codes are more useful than a generic command failure for
  setup problems: for example `GitBaseBranchUnavailable`,
  `GitRemoteUnavailable`, and `GitHubAuthUnavailable`.
- Publish commands still run their mutating commands after preflight. Preflight
  is a safety gate, not a replacement for command error handling.

Verification:

- Runtime test proves successful preflight command sequencing through the
  recording GitHub command seam.
- Runtime test proves a missing remote base branch fails with
  `GitBaseBranchUnavailable`.
- Existing publish tests now prove preflight runs before mutating Git commands.

## Slice 6C: GitHub PR Dry-Run Preview

Outcome: Gaia can run `gaia preview-pr <run-id>` for evidence-only PRs and
`gaia preview-pr <run-id> --workspace` for workspace-change PRs. The command
runs GitHub preflight, then prints a typed preview with branch, base, remote,
evidence path, source-change claim, and the external commands Gaia would run.

Findings:

- Preview reuses preflight, so it catches setup issues while remaining
  read-only.
- Evidence-only previews claim `evidence-only` source changes and omit
  workspace staging commands.
- Workspace previews claim `workspace-required` and include the same source
  staging and `git diff --cached --quiet` commands Gaia uses to reject empty
  workspace PRs.
- The preview lists external `git`/`gh` commands. Filesystem operations such as
  copying evidence and applying a workspace are Gaia runtime behavior, not shell
  commands, so they are described by mode/source/evidence fields instead.

Verification:

- Runtime test proves evidence-only preview command shape.
- Runtime test proves workspace preview command shape includes source staging
  and cached diff checks.
- Runtime/CLI type checks passed after adding the command.

## Slice 6D: Process Harness Contract Enrichment

Outcome: Gaia now treats the local process harness as a stricter adapter
contract. Process runs receive `GAIA_HARNESS_CONTRACT_VERSION`, normalized
results include `exitCode` and `changedWorkspacePaths`, and Gaia validates
declared `workspace/*` output artifacts before verification.

Findings:

- The process harness is still a bridge, but it should fail like a real adapter.
  Missing declared artifacts now become typed Gaia runtime failures instead of
  later verifier surprises.
- Changed workspace paths are computed by hashing the isolated workspace before
  and after harness execution. This keeps the claim local and deterministic
  without parsing git output.
- The environment contract gives future Codex, Claude, OpenCode, or AI SDK
  adapters a clear minimum shape without coupling Gaia to one vendor yet.

Verification:

- Runtime test proves fake harness evidence includes changed workspace paths and
  exit evidence.
- Runtime test proves process harness evidence includes a generated workspace
  file, `output.txt`, and exit code `0`.
- Runtime/CLI type checks passed after adding the contract fields.

## Slice 6E: Skill Bundle Manifest

Outcome: Gaia can record a portable skill bundle manifest for a run with
`gaia run --skill-manifest <path>`. The manifest is normalized into
`skill-manifest.json`, selected skill names are surfaced in `report.json` and
`report.md`, and GitHub PR evidence copies the manifest with the rest of the
run artifacts.

Findings:

- This slice should record intent, not install tools. Automatic skill
  installation would add network, auth, and registry behavior before Gaia has a
  real worker harness to consume it.
- Pinned skills are part of reproducibility. Gaia rejects manifest entries that
  do not include either a `version` or `commit`.
- The manifest stays outside the lifecycle state machine for now. It is run
  evidence consumed by planning/reporting, not a new run state.

Verification:

- Runtime test proves a pinned skill manifest is written into run evidence and
  reflected in both report formats.
- Runtime test proves unpinned entries fail with typed
  `SkillManifestEntryUnpinned` and leave the run failed.
- Runtime/CLI type checks passed after adding the command flag and schema.

## Slice 6F: Browser Evidence Shape

Outcome: Gaia now writes a typed `browser-evidence.json` artifact for every
run. The current status is `not-collected`; the shape already reserves page
URLs, screenshot evidence, and console messages for future Browser/Chrome
automation.

Findings:

- Browser evidence should be a stable artifact before it is live automation.
  This keeps report and PR evidence layout stable when capture is introduced.
- Empty evidence is explicit, not absent. A missing browser artifact would make
  it hard to distinguish "not collected yet" from "Gaia failed to write the
  contract."
- Live browser control remains deferred. This slice adds no browser dependency,
  no screenshots, and no web navigation.

Verification:

- Runtime test parses `browser-evidence.json` through the exported Effect Schema
  codec and proves it records `not-collected` with no pages.
- Runtime test proves the report includes `browser-evidence.json`.
- Runtime/CLI type checks passed after adding the artifact.

## Slice 6G: CI Watcher Model

Outcome: Gaia now writes `ci-watch-state.json` whenever GitHub checks are
recorded. The state captures the latest check snapshot, status, terminal flag,
attempt count, and next action: `complete` for terminal states or `poll-again`
for pending checks after bounded waiting.

Findings:

- A background daemon should not invent its own memory-only truth. It should
  resume from event log plus `ci-watch-state.json`.
- `checks --wait` remains bounded and explicit. The new state model does not
  add daemon behavior, merge authority, or hidden polling.
- The event log now records the watch state path when available, while replay
  remains compatible with older `GITHUB_CHECKS_RECORDED` events that do not have
  that payload.

Verification:

- Core tests pass with optional watch-state replay payloads.
- Runtime test proves passed checks write `nextAction: "complete"`.
- Runtime test proves exhausted pending checks write `nextAction: "poll-again"`.
- Core/runtime/CLI type checks passed after adding the model.

## Slice 7: Codex Harness MVP

Outcome: Gaia now has a dedicated `codex` harness adapter behind the same
`GaiaHarness` port as `fake` and `process`. The adapter runs `codex exec
--json` against the isolated workspace, sends the Gaia worker prompt on stdin,
stores the final Codex response as `codex-last-message.md`, captures command
output in `worker.log`, snapshots changed workspace paths, and writes normalized
`worker-result.json`.

Findings:

- A dedicated adapter is cleaner than asking users to compose Codex through the
  generic process harness. Gaia owns the prompt, default sandbox policy,
  final-message path, and typed failure classification.
- The command-runner seam mirrors the GitHub publisher seam. Tests can verify
  command shape and artifacts without mocking modules or requiring a logged-in
  Codex binary in CI.
- The MVP should stay non-interactive. Visible Codex worker sessions, reviewer
  sessions, cancellation, and transcript/event parsing are still separate
  slices.
- The real Codex smoke exposed two contract issues tests alone did not catch:
  the installed Codex CLI no longer accepts `--ask-for-approval`, and agents can
  misread `workspace/output.txt` as a nested path when their cwd is already the
  workspace. Gaia now passes the current CLI flags and tells Codex to write
  `./output.txt`.
- Gaia should not inherit the operator's full Codex user config by default.
  The first real smoke loaded unrelated plugins/MCP servers and consumed a huge
  prompt context. The adapter now uses `--ignore-user-config` so Gaia owns the
  worker context deliberately.

Verification:

- Runtime test proves selecting `codex` without config fails with
  `CodexHarnessConfigMissing`.
- Runtime test proves a recording Codex runner receives the expected
  `codex exec --json --cd <workspace> ... -` command shape and completes a run.
- Runtime test proves non-zero Codex exit fails with `CodexCommandFailed` and
  leaves the run failed.
- Real local smoke against the installed Codex CLI completed a Gaia run,
  produced `workspace/output.txt`, stored `codex-last-message.md`, and verified
  normalized `worker-result.json`.
- Runtime/CLI type checks passed after adding the adapter and flags.

## Slice 8: Workspace PR Base Synchronization

Outcome: Gaia now refuses GitHub publish and preview preflight when local
`HEAD` does not match the configured remote base branch. This protects
workspace PRs from accidentally bundling local commits that have not landed on
trunk.

Findings:

- A clean worktree is not enough for a software-factory PR loop. During the
  real Codex workspace proof, local `main` was clean but ahead of
  `origin/main`. Publishing a workspace branch from `origin/main` would have
  included both the intended Codex workspace change and the unpushed local
  commits copied into the run workspace.
- The preflight remains read-only. Gaia uses `git ls-remote` for the remote
  base commit and `git rev-parse HEAD` for the local commit, then fails with
  `GitBaseBranchOutOfSync` when they differ.

Verification:

- Runtime test proves normal GitHub preflight includes the
  `base-synchronized` check.
- Runtime test proves divergent local/remote base state fails with
  `GitBaseBranchOutOfSync`.
- Real Codex workspace proof first produced a source change in an isolated
  workspace, then the synchronized-base guard prevented publishing until trunk
  was pushed.

## Slice 9: Real Workspace PR Loop And Codex Hardening

Outcome: Gaia proved the real workspace PR loop with Codex and now gives the
Codex subprocess an explicit timeout. A Codex-generated workspace change can be
previewed and published as a draft PR with Gaia evidence, and timed-out Codex
commands fail as `CodexCommandTimedOut` instead of being normalized as success.

Findings:

- The first publish attempt found a real Git pathspec bug: explicitly passing
  ignored `.gaia` pathspec exclusions to `git add` can make Git fail before
  staging source changes. Gaia now lets `.gitignore` exclude local run state and
  stages PR evidence separately.
- Harness hardening belongs before visible reviewer sessions. Reviewers are
  less useful if the worker adapter can hang forever or misclassify a killed
  subprocess.
- `--codex-timeout-ms` is a Gaia-owned setting, not a raw `codex exec`
  passthrough. This keeps the CLI override typed and visible in the harness
  config.

Verification:

- Real Codex workspace run `run-RBAWt0lqoP` opened draft PR
  `https://github.com/cill-i-am/gaia/pull/2`.
- Runtime test proves the node Codex command runner classifies a timed-out
  subprocess as `CodexCommandTimedOut`.
- Runtime test proves the workflow seam passes the branded timeout into the
  Codex command runner.

## Slice 10: Reviewer Port And Read-only Guard

Outcome: Gaia review execution is now an explicit `GaiaReviewer` port. The
deterministic reviewer remains the default implementation, but workflows can
inject a reviewer adapter without changing the lifecycle. Gaia snapshots the
isolated workspace before and after reviewer execution and fails the run if a
reviewer mutates source files.

Findings:

- The old deterministic reviewer was already an adapter in disguise. Making the
  port explicit gives the visible reviewer work a clean insertion point without
  changing the event log or report shape.
- Reviewer artifacts still live outside the isolated workspace, so the
  read-only guard can be strict about source mutation while still allowing Gaia
  to persist `plan-review.*` and `evidence-review.*`.
- Reusing the harness workspace snapshot logic keeps mutation semantics
  consistent across workers and reviewers: added files, deleted files, and
  content changes all count.
- This is the Phase 2 foundation, not the full visible reviewer spectrum. Codex
  reviewer sessions, session visibility, and reviewer transcript capture remain
  separate slices.

Verification:

- Runtime test proves a configured reviewer runs through the workflow seam and
  writes normal review evidence.
- Runtime test proves a reviewer that writes to the workspace fails with typed
  `ReviewerWorkspaceMutated` and leaves the run failed.

## Slice 11: Codex CLI Reviewer Adapter

Outcome: Gaia can run a read-only Codex reviewer with
`gaia run --reviewer codex`. The adapter reuses the existing Codex command-runner
seam, forces Codex sandbox mode to `read-only`, writes phase-specific
`*-codex-reviewer.log` and `*-codex-reviewer-last-message.md` artifacts, parses
the final reviewer decision, and records normal Gaia review evidence.

Findings:

- The reviewer adapter should be narrower than the worker harness. It accepts
  command/model/profile/timeout settings, but does not accept raw extra Codex
  args or sandbox overrides because the reviewer safety contract is read-only.
- The Codex reviewer returns a tiny structured Markdown contract:
  `Status: approved|blocked` plus `Summary: ...`. Gaia parses that boundary
  instead of treating arbitrary prose as a typed decision.
- Blocked reviews now stop the run with typed `ReviewBlocked`. That makes the
  plan reviewer meaningful before worker execution without giving reviewers
  merge authority.
- This is still not the final visible reviewer spectrum. The CLI adapter has no
  visible Codex thread id, side-chat support, or resumable session transcript.

Verification:

- Runtime test proves the Codex reviewer runs through the workflow seam with
  `codex exec --sandbox read-only`, writes logs/transcripts, and records
  review evidence.
- Runtime test proves a blocked plan review fails before `WORKER_STARTED`.

## Slice 12: Reviewer Session Evidence

Outcome: Gaia now writes typed reviewer session evidence for every review phase.
Each run records `plan-reviewer-session.json` and
`evidence-reviewer-session.json` alongside the normal review Markdown/JSON.
The artifact captures the reviewer adapter kind, session kind, decision status,
phase, reviewer name, and supporting paths such as Codex reviewer logs and
transcripts when available.

Findings:

- The CLI Codex reviewer is not the final visible reviewer thread, but it can
  still produce a stable session-shaped artifact. That gives visible sessions a
  contract to extend instead of forcing reports and event replay to learn a new
  shape later.
- Session evidence belongs at the reviewer port boundary. The workflow only
  knows where the artifact lives; deterministic, custom, and Codex reviewers
  can attach richer evidence without adding reviewer-specific branches to the
  run lifecycle.
- Durable events now include `reviewerSessionEvidencePath`, and replay exposes
  `planReviewerSessionPath` / `evidenceReviewerSessionPath` when present. The
  payload is optional so older run logs still replay cleanly.

Verification:

- Runtime test proves deterministic runs write typed reviewer session evidence
  and include it in the final report.
- Runtime test proves the Codex reviewer records command, cwd, log, transcript,
  and approved decision metadata.
- Runtime test proves blocked Codex plan reviews still write blocked session
  evidence before the run fails.
- Core replay test proves reviewer session paths are preserved in snapshots.

## Slice 13: Skill Bundle Resolution Contract

Outcome: Gaia now writes `skill-bundle.json` for every run. Empty manifests
produce an empty bundle, local skill entries resolve to checked directories with
`SKILL.md`, and external skill entries are preserved as `requires-install`
instead of being silently treated as available.

Findings:

- The recorded manifest and the resolved bundle are different artifacts. The
  manifest is the user's requested portable skill set; the bundle is Gaia's
  current ability to hand concrete skill paths to a worker.
- Local resolution is useful now and keeps the failure mode honest. A local
  entry with `sourceRepository: "local"` or `"file"` must point to a directory
  containing `SKILL.md`, otherwise the run fails before worker planning.
- External skill installation should remain a separate slice. Marking remote
  entries as `requires-install` gives the future installer a clear input
  without pretending remote skills are already available in worker context.

Verification:

- Runtime test proves external pinned manifest entries produce a
  `requires-install` bundle and still appear in reports.
- Runtime test proves local skill entries resolve to absolute local paths and
  produce a `ready` bundle.
- Runtime test proves missing local skill sources fail with typed
  `SkillBundleSourceUnavailable` before worker execution.

## Slice 14: Worker Skill Context

Outcome: Gaia now carries skill context into worker harness execution.
`HarnessRunRequest` includes the run's `skill-bundle.json` path and any resolved
local skill paths. Codex receives those values in its prompt, and process
harnesses receive `GAIA_SKILL_BUNDLE_PATH` plus
`GAIA_RESOLVED_SKILL_PATHS_JSON`.

Findings:

- Passing resolved paths through the harness request keeps `runSpecFile` from
  becoming Codex-specific. The runtime computes skill context once, then every
  adapter can translate it into its native prompt/env shape.
- The bundle path remains useful even when no local skills are resolved. It
  lets future workers and reviewers inspect whether a run had no skills or had
  external skills that still require installation.
- The prompt should be honest about availability. Local resolved skill paths
  are available now; external entries stay in `skill-bundle.json` until the
  installer/fetcher slice exists.

Verification:

- Runtime test proves Codex worker prompts include the skill bundle path and a
  resolved local skill path.
- Runtime test proves process harnesses receive the skill bundle environment
  contract.

## Slice 15: External Skill Bundle Installation

Outcome: Gaia now installs git-backed external skill manifest entries before
worker execution. A pinned external entry is cloned into the run's
`skill-sources` directory, checked out at its commit or version, validated for
`SKILL.md`, recorded as an `installed` bundle entry, and passed to workers as a
resolved skill path.

Findings:

- Per-run installs are intentionally boring. Gaia does not need a global cache
  or registry abstraction yet; the run directory is the evidence boundary and
  contains the exact checked-out source path the worker saw.
- The installer is a command-runner seam around `git clone` and `git checkout`.
  Tests can fake it without network access, while normal CLI runs use the local
  `git` binary.
- External `sourcePath` values must be relative to the checked-out repository.
  That keeps manifests portable and prevents a remote skill entry from pointing
  at arbitrary local filesystem paths.
- Unsupported repositories, failed install commands, missing source
  directories, and missing `SKILL.md` fail before worker execution with typed
  Gaia runtime errors.

Verification:

- Runtime test proves a pinned GitHub-style skill source installs into
  `skill-sources`, records an `installed` bundle, and appears in reports.
- Runtime test proves a failed install command fails the run before worker
  execution with typed `SkillBundleInstallCommandFailed`.
- Full `pnpm check`, `pnpm test`, and `pnpm build` passed after the slice.

## Slice 16: Explicit Browser Evidence Capture

Outcome: Gaia can now collect browser evidence for a completed run with
`gaia collect-browser-evidence <run-id> --url <http-url>`. The runtime captures
through a browser collector port, uses Playwright as the production adapter,
writes screenshot paths and console messages into `browser-evidence.json`, and
records a `BROWSER_EVIDENCE_RECORDED` event without changing the completed run
state.

Findings:

- Browser capture should not silently become a run gate yet. This slice makes
  capture explicit and durable, while leaving profile/check policy for a later
  slice.
- Failed capture is evidence, not absence. If the collector cannot launch or
  navigate, Gaia rewrites `browser-evidence.json` with `status: "failed"` and a
  safe diagnostic note.
- The collector is a real seam. Tests use a fake `BrowserEvidenceCollector`
  through the runtime interface; production uses Playwright behind the same
  contract.
- Screenshots live under the run directory's `browser/` folder, and GitHub
  evidence publishing copies that folder when present so screenshot references
  do not dangle.

Verification:

- Core replay test proves `BROWSER_EVIDENCE_RECORDED` enriches completed runs
  without changing their state.
- Runtime tests prove successful browser evidence collection updates
  `browser-evidence.json`, appends the event, and keeps resume working.
- Runtime tests prove failed collector output is recorded as `status: "failed"`
  evidence.

## Slice 17: Run-Integrated Browser Evidence Capture

Outcome: Gaia can now collect browser evidence during `gaia run` with
`--browser-url <http-url>`. The URL is parsed before worker execution, the
browser collector runs after harness verification, and
`BROWSER_EVIDENCE_RECORDED` lands before the evidence reviewer starts.

Findings:

- The explicit completed-run command and run-integrated path should share one
  recording helper. That keeps the event payload, failed-capture behavior, and
  artifact shape identical.
- The URL is command input, so it must parse before Gaia starts worker work.
  Invalid target URLs now fail fast instead of producing a half-useful run.
- Browser capture failure remains non-blocking. Gaia records
  `status: "failed"` browser evidence and lets the evidence reviewer/report
  reflect that fact. Turning that into a gate belongs to a future policy slice.
- Event replay needed to accept browser evidence while the run is in
  `reporting`, not only after completion, because integrated capture occurs
  before `REPORT_COMPLETED`.

Verification:

- Core replay test proves `BROWSER_EVIDENCE_RECORDED` can be replayed before
  report completion.
- Runtime test proves `runSpecFile` records browser evidence before evidence
  review when given a target URL.
- Runtime test proves integrated failed capture still leaves the run completed
  with failed browser evidence.

## Slice 18: Required Browser Evidence Policy

Outcome: Gaia now has an explicit required-browser-evidence check for
`gaia run`. By default, browser capture remains non-blocking evidence. When the
caller passes `--require-browser-evidence`, Gaia fails the run if the browser
evidence status is not `collected`.

Findings:

- The CLI flag is a friendly boundary, but the runtime uses a small domain
  policy value: `browserEvidenceRequirement: "optional" | "required"`. That
  avoids passing a vague mode boolean through workflow code.
- Required browser evidence should still record the failed browser artifact
  before failing the run. The event log then shows both facts: capture was
  attempted and the required check blocked completion.
- At this stage, missing `--browser-url` under the required policy was a
  command/config error, so Gaia failed fast before worker execution. Later
  target discovery moved this check after worker completion.
- The policy is intentionally narrow. It does not discover target URLs, invent
  profiles, or make visual-diff claims.

Verification:

- Runtime test proves required browser evidence completes when capture is
  collected.
- Runtime test proved required browser evidence failed fast without a target
  URL before target discovery existed.
- Runtime test proves failed required capture records `browser-evidence.json`,
  appends `BROWSER_EVIDENCE_RECORDED`, appends `RUN_FAILED`, and skips evidence
  review.

## Slice 19: Run Profiles And Browser Evidence Checks

Outcome: Gaia now resolves a typed run profile for every run and writes it to
`run-profile.json`. The default profile keeps browser evidence optional, while
the checked-in `frontend` profile requires successful browser evidence capture.

Findings:

- Profiles are configuration evidence, not lifecycle state. Gaia persists the
  resolved profile as an artifact and feeds it into the existing browser
  evidence policy instead of adding a new event or state transition.
- `--profile frontend` resolves to `profiles/frontend.json`; path-like values
  are treated as explicit JSON profile files. This keeps named profiles simple
  while still allowing experiments.
- Explicit `--require-browser-evidence` still works as an override for one-off
  runs, but profiles are the better operator-facing contract for repeatable run
  classes.
- Invalid profile JSON is a boundary/config failure and stops before worker
  execution.

Verification:

- Runtime test proves the default profile is written and included in reports.
- Runtime test proves a profile can require browser evidence and still complete
  when capture succeeds.
- Runtime test proves a profile-required browser URL fails when missing.
- Runtime test proves invalid profiles fail before worker execution.

## Slice 20: Browser Target URL Discovery

Outcome: Gaia now discovers the browser target for run-integrated evidence from
three typed sources: explicit CLI input, the run profile, then a worker-declared
harness result. The checked-in `frontend` profile carries a default local target
URL, so `gaia run --profile frontend` can enforce browser evidence without a
separate `--browser-url`.

Findings:

- Target URL discovery belongs in serializable contracts, not log scraping. Run
  profiles decode `browser.targetUrl`, and process harnesses can declare
  `{ "browserTargetUrl": "http://..." }` by writing JSON to
  `GAIA_WORKER_RESULT_PATH`.
- Explicit CLI input still wins. This keeps one-off reroutes simple without
  editing a shared profile.
- Required browser evidence can no longer always fail before worker execution,
  because the worker may be the source that discovers the target. Gaia now fails
  after worker completion and verification, before evidence review, if no
  target was provided or discovered.

Verification:

- Runtime test proves profile target URLs drive required browser evidence.
- Runtime test proves explicit `--browser-url` overrides a profile target.
- Runtime test proves a process harness declaration can supply the target URL.
- Runtime test proves required browser evidence with no target fails after
  worker completion and before evidence review.

## Slice 21: Preview Deployment Target Discovery

Outcome: Gaia now records preview deployment evidence separately from browser
evidence. A process harness can declare `previewDeploymentUrl`, Gaia validates
it as a branded HTTP/HTTPS URL, writes `preview-deployment.json`, appends
`PREVIEW_DEPLOYMENT_RECORDED`, and uses that URL as the browser evidence target
when no explicit CLI or profile target exists.

Findings:

- Preview deployment evidence should be a first-class artifact, not a log line
  or overloaded browser evidence note. This gives future real deployment
  adapters a stable place to report status and URL without changing browser
  capture.
- Target priority is now explicit CLI, profile, preview deployment, then direct
  harness browser target. That keeps operator intent first, repeatable profile
  defaults second, deployment reality third, and lower-level harness discovery
  last.
- Gaia still does not create preview deployments. The current slice proves the
  typed handoff from a harness that creates or discovers one.
- Invalid preview URLs fail as typed process harness declaration errors before
  Gaia can trust or publish the value.

Verification:

- Core replay test proves `PREVIEW_DEPLOYMENT_RECORDED` can enrich a run before
  verification/report completion.
- Runtime test proves preview deployment URLs drive required browser evidence
  before direct harness browser targets.
- Runtime test proves explicit `--browser-url` still overrides a preview
  deployment URL.
- Runtime test proves invalid preview deployment declarations fail with
  `ProcessHarnessDeclarationInvalid`.

## Slice 22: Resumable CI Watcher

Outcome: Gaia now has a bounded resumable CI watcher command. `gaia watch-ci
<run-id> <pr>` starts or continues watching a pull request's checks, records a
new check snapshot, and updates `ci-watch-state.json`. `gaia watch-ci <run-id>`
resumes from stored watch state. Terminal stored state returns without polling
GitHub again.

Findings:

- CI watching should build on the existing append-only event log and
  `ci-watch-state.json`, not in-memory process state. That makes restart/resume
  boring and inspectable.
- Failed checks are terminal but not operationally "complete" for agents.
  `ci-watch-state.json` now records `nextAction: "fix-failed-checks"` for
  failed checks, while passing/no-check states use `complete` and pending states
  use `poll-again`.
- The watcher remains an explicit bounded command. Gaia still avoids hidden
  global daemon state, unbounded polling, and merge authority.
- PR review/comment watching is related but separate. Mixing human feedback
  state into CI check state would make the watcher harder to reason about.

Verification:

- Runtime test proves `watchGitHubChecks` records failed checks and writes
  `nextAction: "fix-failed-checks"`.
- Runtime test proves `watchGitHubChecks` resumes a pending watch from
  `ci-watch-state.json`.
- Runtime test proves terminal watch state returns without another GitHub poll.
- Runtime test proves a run without watch state needs an explicit pull request
  selector before watching can start.

## Slice 23: GitHub PR Feedback Watcher

Outcome: Gaia now has `gaia watch-pr-feedback <run-id> <pr>`. The command reads
GitHub PR comments, latest reviews, review decision, and requested-reviewer
count through `gh pr view --json`, writes `github-feedback.json`, appends
`GITHUB_FEEDBACK_RECORDED`, and returns a next action for the operator or
implementation agent.

Findings:

- Human review feedback should stay separate from CI state. Failed checks point
  at `fix-failed-checks`; changes-requested reviews point at
  `address-review-comments`.
- `gh pr view --json` does not expose unresolved review-thread state. Gaia
  records that limitation in the artifact instead of pretending comments are
  unresolved threads.
- The first feedback watcher is single-shot and bounded, like the CI watcher.
  It is not a daemon, merge gate, or broad GitHub notification system.
- Classification is deliberately conservative: changes requested wins, then PR
  comments, then awaiting review, otherwise clear.

Verification:

- Core replay test proves `GITHUB_FEEDBACK_RECORDED` enriches completed runs
  without leaving the completed state.
- Runtime tests cover changes requested, comments-only, awaiting-review, clear,
  and invalid GitHub JSON through the recording command seam.
- CLI help smoke proves `watch-pr-feedback` exposes `<run-id> <pull-request>`
  and `--json`.

## Slice 24: GitHub PR Loop Coordinator

Outcome: Gaia now has `gaia pr-loop <run-id> <pr>`. The command records one
current CI snapshot, records one current PR feedback snapshot, writes
`pr-loop-state.json`, appends `GITHUB_PR_LOOP_RECORDED`, and returns a single
ordered next action for the operator or next worker run.

Findings:

- The combined PR loop should be an aggregate over durable CI and feedback
  artifacts, not a replacement for either artifact. Agents need the concise
  next action, but reviewers still need the underlying evidence.
- Changes-requested reviews should be first in the action order, even when CI
  also fails. Human feedback often explains the change that will fix or
  supersede the failing check, while the failed check remains a blocker in the
  same state file.
- Pending CI and awaiting review are waiting states, not failures. Gaia should
  keep them distinct from actionable blockers that need a worker.
- A clean PR loop returns `ready-for-merge-decision` rather than merging. This
  keeps orchestrator authority explicit.

Verification:

- Core replay test proves `GITHUB_PR_LOOP_RECORDED` enriches completed runs
  without leaving the completed state.
- Runtime tests cover ordered blockers for changes-requested plus failed CI,
  waiting state for pending CI plus required review, and clean ready state.
- CLI help smoke proves `pr-loop` exposes `<run-id> <pull-request>` and
  `--json`.

## Slice 25: Worker Remediation Handoff

Outcome: Gaia now has `gaia plan-remediation <run-id>`. The command reads a
blocked `pr-loop-state.json`, writes `remediation-spec.md`, appends
`GITHUB_REMEDIATION_SPEC_RECORDED`, and returns a typed summary pointing at the
generated spec.

Findings:

- Remediation should start as an explicit handoff artifact, not an automatic
  fix loop. This preserves operator authority and makes the next worker run
  inspectable before it starts.
- The handoff should refuse `waiting` and `ready` PR loops. Pending CI,
  awaiting review, and ready-for-merge decisions are not implementation work.
- Markdown is the right first artifact because the existing `gaia run
  <spec-file>` path can consume it without a special remediation runner.
- The generated spec should point to `pr-loop-state.json`, `github-feedback.json`,
  `github-checks/`, and original run evidence rather than copying all context
  into the prompt and making it stale.

Verification:

- Core replay test proves `GITHUB_REMEDIATION_SPEC_RECORDED` enriches completed
  runs without leaving the completed state.
- Runtime test proves blocked PR-loop state creates `remediation-spec.md` with
  ordered blockers and no auto-merge instruction.
- Runtime test proves waiting PR-loop state fails with `GitHubPrLoopNotBlocked`.
- CLI help smoke proves `plan-remediation` exposes `<run-id>` and `--json`.
