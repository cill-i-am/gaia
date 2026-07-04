# Gaia

Gaia is a software-factory control plane. It coordinates work; it is not a
mega-agent that pretends to code, review, verify, and merge by itself.

Prototype 1 proves the smallest useful loop:

1. read a local Markdown spec;
2. create a durable run under `.gaia/runs/<run-id>/`;
3. replay and snapshot an explicit XState lifecycle;
4. write a worker plan and deterministic plan review;
5. execute a harness in an isolated workspace;
6. verify the worker artifact;
7. write deterministic evidence review;
8. write human and machine evidence reports;
9. resume from the authoritative event log.

## Scope

Prototype 1 deliberately excludes dedicated Codex/Claude/OpenCode workers,
Linear, worktrees, live reviewer threads, browser evidence,
dashboards, and merge automation. It does include deterministic local review
evidence, evidence-only GitHub PR publishing, workspace-change GitHub PR
publishing, and GitHub PR check inspection/recording.

See [`docs/prototype-1.md`](docs/prototype-1.md) for the detailed prototype
contract, event lifecycle, artifact format, and deferred work.
See [`docs/roadmap.md`](docs/roadmap.md) for the planned software-factory
slices.

## Commands

```sh
pnpm install
pnpm check
pnpm test
pnpm build

pnpm gaia run examples/specs/smoke.md
pnpm gaia run examples/specs/smoke.md --harness fake
pnpm gaia run examples/specs/smoke.md --harness process --harness-command node --harness-arg "$PWD/examples/harnesses/process-harness.mjs"
pnpm gaia run examples/specs/smoke.md --workspace-source .
pnpm gaia run examples/specs/smoke.md --json
pnpm gaia status
pnpm gaia list
pnpm gaia resume <run-id>
pnpm gaia publish-pr <run-id>
pnpm gaia publish-workspace-pr <run-id>
pnpm gaia pr-checks <pr-number-or-url>
pnpm gaia checks <run-id> <pr-number-or-url>
pnpm gaia checks <run-id> <pr-number-or-url> --wait
```

`pnpm gaia` resolves paths from the directory where the command was invoked and
stores generated run state in that directory's `.gaia/` folder.
`pnpm gaia publish-pr <run-id>` intentionally mutates GitHub state: it creates
an evidence branch, commits selected run evidence under `gaia-runs/<run-id>/`,
pushes it, opens a draft PR, and restores the original local branch.
`pnpm gaia publish-workspace-pr <run-id>` intentionally mutates GitHub state in
the same way, but first applies the run workspace to a
`gaia/<run-id>-workspace` branch. Gaia skips harness-declared workspace
artifacts such as `workspace/output.txt`, stages only source changes outside
`.gaia/` and `gaia-runs/`, then refuses to open the PR when the workspace has no
source changes.
`pnpm gaia pr-checks <pr-number-or-url>` reads GitHub PR checks and reports one
of `no-checks`, `pending`, `passed`, or `failed`.
`pnpm gaia checks <run-id> <pr-number-or-url>` records that check state under
the run's `github-checks/` evidence directory and appends it to the event log.
Use `--wait` to poll until checks are no longer pending before recording.

## Run Directory

Each run is stored relative to the current working directory:

```txt
.gaia/runs/run-V7kP9sQ2xY/
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
  github-checks/
    checks-<event-sequence>.json
```

`events.jsonl` is the source of truth. `snapshots.jsonl` is derived from replay
and exists for status/debugging.

`.gaia/latest` stores the latest run id so `gaia status` does not infer
chronology from random run ids.

## Architecture

```txt
apps/cli
  Effect CLI command surface.

packages/core
  Pure contracts: run ids, spec parsing, event and snapshot schemas, XState
  machine, replay rules, report models.

packages/runtime
  Effect-powered filesystem runtime: run creation, event store, harness port,
  worker planning, read-only review evidence, verifier, report writer, and
  command workflows.
```

## Deferred Roadmap

- dedicated Codex, Claude, OpenCode, or AI SDK HarnessAgent adapter;
- real target repo and git worktree execution;
- background GitHub check watching attached to Gaia runs;
- Linear issue intake and status sync;
- live reviewer/spec agent threads;
- skill bundle install and selection;
- CI watching;
- browser/e2e evidence capture;
- merge/deploy automation;
- SQLite or richer run index;
- dashboard/TUI;
- multi-harness support;
- cancellation and live-worker cleanup.
