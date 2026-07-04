# Prototype 1

Prototype 1 proves Gaia's smallest useful software-factory loop. It is a local
control-plane experiment, not the final factory.

The goal is to make the run lifecycle durable, inspectable, and easy to resume
before any real coding harness or external integration is introduced.

## What It Does

1. Reads a local Markdown spec.
2. Creates a run id with the format `run-<10 url-safe chars>`.
3. Stores all run state under `.gaia/runs/<run-id>/`.
4. Prepares an isolated workspace, optionally copied from a local source
   directory.
5. Appends lifecycle events to `events.jsonl`.
6. Writes derived snapshots to `snapshots.jsonl`.
7. Writes a worker plan artifact.
8. Records deterministic read-only plan review evidence.
9. Runs a deterministic fake harness through the harness port.
10. Verifies the fake harness's output artifact.
11. Records deterministic read-only evidence review output.
12. Writes `report.md` and `report.json`.
13. Resumes completed runs by replaying the event log.

## What It Does Not Do Yet

Prototype 1 intentionally excludes:

- real Codex, Claude, OpenCode, or AI SDK HarnessAgent workers;
- target repository checkout or worktree management;
- skill bundle installation/selection;
- live reviewer/spec worker threads;
- GitHub branches, commits, pull requests, checks, or merges;
- Linear issue intake or blocker graphs;
- browser or deployment evidence;
- SQLite run indexing;
- dashboard or TUI;
- cancellation of live external work;
- production-grade exit-code/process supervision.

Those pieces should land as separate slices after the local lifecycle contract
stays simple under tests.

## Packages

```txt
apps/cli
  Effect CLI command surface and output formatting.

packages/core
  Pure domain contracts: branded run ids, spec parsing, event schemas,
  XState lifecycle, replay, snapshots, and report schemas.

packages/runtime
  Effect filesystem runtime: path construction, event store, harness port,
  worker planning, read-only reviews, verifier, report writer, latest-run
  pointer, and command workflows.
```

The package boundary is intentional:

- `@gaia/core` has no filesystem dependency.
- `@gaia/runtime` has no command-line presentation concerns.
- `@gaia/cli` should not know how a run is executed internally.

## Commands

Install and verify:

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

Run the local loop:

```sh
pnpm gaia run examples/specs/smoke.md
pnpm gaia run examples/specs/smoke.md --harness fake
pnpm gaia run examples/specs/smoke.md --workspace-source .
pnpm gaia status
pnpm gaia list
pnpm gaia resume <run-id>
```

Machine-readable output:

```sh
pnpm gaia run examples/specs/smoke.md --json
pnpm gaia status <run-id> --json
pnpm gaia list --json
```

The `process` harness runs an external command without shell parsing:

```sh
pnpm gaia run examples/specs/smoke.md \
  --harness process \
  --harness-command node \
  --harness-arg "$PWD/examples/harnesses/process-harness.mjs"
```

When invoked through `pnpm gaia`, paths are resolved from the directory where the
user ran the command, not from `apps/cli`. Gaia uses `INIT_CWD` for that pnpm
case and falls back to `process.cwd()` when run directly.

## Run Storage

A completed run looks like this:

```txt
.gaia/
  latest
  runs/
    run-V7kP9sQ2xY/
      input.md
      events.jsonl
      snapshots.jsonl
      workspace-manifest.json
      worker-plan.md
      worker-plan.json
      plan-review.md
      plan-review.json
      workspace/
        output.txt
      worker.log
      worker-result.json
      verification.log
      verification-result.json
      evidence-review.md
      evidence-review.json
      report.md
      report.json
```

`events.jsonl` is the source of truth. Every line is a parsed `RunEvent`.

`snapshots.jsonl` is derived evidence. On load, Gaia replays the full event log
and verifies the latest snapshot's state and sequence match replay. If they do
not match, the run is treated as corrupt.

`.gaia/latest` stores the latest run id. This avoids pretending random Nano IDs
have chronological ordering.

`workspace-manifest.json` records the workspace source, copied file count,
skipped entries, and run-local workspace path. By default Gaia prepares an empty
workspace. With `--workspace-source <dir>`, Gaia copies a local directory into
the run workspace while excluding generated or heavy directories such as `.git`,
`.gaia`, `.turbo`, `coverage`, `dist`, and `node_modules`.

## Lifecycle

Prototype 1 uses an XState machine in `@gaia/core`.

| Event | Resulting intent |
| --- | --- |
| `RUN_CREATED` | Record the parsed spec location and move into workspace prep. |
| `WORKSPACE_PREPARED` | Record the run workspace path. |
| `REVIEW_STARTED` | Mark a read-only review phase as started. |
| `REVIEW_COMPLETED` | Record plan or evidence review output. |
| `WORKER_STARTED` | Mark that harness-backed worker execution began. |
| `WORKER_COMPLETED` | Record the normalized harness result path and move to verification. |
| `VERIFICATION_STARTED` | Mark that verification began. |
| `VERIFICATION_COMPLETED` | Record verification evidence and move to reporting. |
| `REPORT_STARTED` | Mark that report writing began. |
| `REPORT_COMPLETED` | Record report evidence and complete the run. |
| `RUN_FAILED` | Record a typed failure and move to failed. |

Resume is intentionally conservative. It replays completed runs and validates the
event/snapshot contract. It does not yet continue partial live work.

## Command Summary Shape

Human output is compact:

```txt
completed: run-V7kP9sQ2xY
state: completed
run: /absolute/path/.gaia/runs/run-V7kP9sQ2xY
report: /absolute/path/.gaia/runs/run-V7kP9sQ2xY/report.md
```

JSON output uses this shape:

```json
{
  "reportPath": "/absolute/path/.gaia/runs/run-V7kP9sQ2xY/report.md",
  "runDirectory": "/absolute/path/.gaia/runs/run-V7kP9sQ2xY",
  "runId": "run-V7kP9sQ2xY",
  "state": "completed",
  "status": "completed"
}
```

Runtime command failures render as:

```json
{
  "code": "NoRunsFound",
  "message": "No Gaia latest-run pointer found.",
  "recoverable": false,
  "status": "failed"
}
```

Effect CLI still owns parser/help/version failures before Gaia command handlers
run. A future process-management slice can standardize usage exit codes if that
matters for machine orchestration.

## Boundary And Type Safety

Boundary values are parsed before use:

- run ids are branded by `RunIdSchema`;
- harness names are branded by `HarnessNameSchema`;
- review phases are parsed by `ReviewPhaseSchema`;
- Markdown specs are parsed into `RunSpec`;
- event log lines are parsed as `RunEvent`;
- snapshots are parsed as `RunSnapshot`;
- worker plans are emitted through `WorkerPlan`;
- reviewer output is emitted through `ReviewResult`;
- reports are emitted through `RunReport`.

The runtime persists plain JSON values. It does not serialize rich errors,
functions, XState actors, Effect fibers, or platform services.

## Testing Expectations

Core tests cover:

- branded run id parsing;
- Markdown spec frontmatter parsing;
- lifecycle replay;
- review-event replay;
- out-of-order event rejection.

Runtime tests cover:

- creating a durable run with evidence;
- latest-run status through `.gaia/latest`;
- copying a local workspace source while excluding generated directories;
- worker plan, plan review, and evidence review artifacts;
- normalized harness evidence and unknown harness failures;
- verification failure when a worker artifact is missing.

Tests use temp run roots instead of the repository `.gaia/` directory.
