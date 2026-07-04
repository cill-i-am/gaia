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
