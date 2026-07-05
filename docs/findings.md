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
- Real Codex workspace proof produced a source change in an isolated workspace;
  publishing is intentionally deferred until trunk synchronization is explicit.
