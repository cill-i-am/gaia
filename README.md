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
Linear, GitHub PRs, worktrees, live reviewer threads, CI, browser evidence,
dashboards, and merge automation. It does include deterministic local review
evidence so the reviewer contract exists before real reviewer agents arrive.

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
```

`pnpm gaia` resolves paths from the directory where the command was invoked and
stores generated run state in that directory's `.gaia/` folder.

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
- GitHub branch and PR creation;
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
