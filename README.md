# Gaia

Gaia is a software-factory control plane. It coordinates work; it is not a
mega-agent that pretends to code, review, verify, and merge by itself.

Prototype 1 proves the smallest useful loop:

1. read a local Markdown spec;
2. create a durable run under `.gaia/runs/<run-id>/`;
3. replay and snapshot an explicit XState lifecycle;
4. execute a deterministic fake harness in an isolated workspace;
5. verify the worker artifact;
6. write human and machine evidence reports;
7. resume from the authoritative event log.

## Scope

Prototype 1 deliberately excludes real coding harnesses, Linear, GitHub PRs,
worktrees, reviewers, CI, browser evidence, dashboards, and merge automation.
Those are future slices once the lifecycle contract is boring and inspectable.

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
  workspace/
    output.txt
  worker.log
  worker-result.json
  verification.log
  verification-result.json
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
  verifier, report writer, and command workflows.
```

## Deferred Roadmap

- real Codex, Claude, OpenCode, or AI SDK HarnessAgent adapter;
- real target repo and git worktree execution;
- GitHub branch and PR creation;
- Linear issue intake and status sync;
- reviewer/spec agent;
- skill bundle install and selection;
- CI watching;
- browser/e2e evidence capture;
- merge/deploy automation;
- SQLite or richer run index;
- dashboard/TUI;
- multi-harness support;
- cancellation and live-worker cleanup.
