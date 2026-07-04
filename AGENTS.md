# Agent Instructions

Gaia is a pnpm monorepo. Use `pnpm` for installs, scripts, workspace commands,
and one-off package execution. Do not use npm, yarn, or Bun unless the user asks.

## Repository Shape

- `apps/cli` owns the Effect CLI entrypoint and command output formatting.
- `packages/core` owns pure Gaia contracts: schemas, branded values, spec
  parsing, XState lifecycle, event replay, snapshots, and report models.
- `packages/runtime` owns the Effect filesystem runtime: durable run storage,
  event append/read, harness execution, verification, reporting, and command
  workflows.
- `docs/*` contains human and agent-facing design notes for the prototype.
- `.gaia/*` is generated local run state and must not be committed.

## Engineering Rules

- Keep the control plane boring, inspectable, and resumable.
- Prefer the smallest implementation that proves the current factory loop.
- Do not add real harnesses, GitHub, Linear, reviewers, dashboards, SQLite,
  auth, or merge automation unless the current task explicitly asks.
- Parse boundary input immediately with Effect Schema or the owning parser.
- Carry branded/domain values inward after parsing. Do not use casts to create
  brands.
- Treat `events.jsonl` as the authoritative run history. `snapshots.jsonl` and
  reports are derived evidence.
- Keep runtime payloads serializable. Do not persist class instances, errors,
  functions, clients, or platform handles.
- Expected runtime failures belong in Effect's typed error channel.
- Keep CLI handlers thin: parse command input, call `@gaia/runtime`, and render
  human or JSON output at the edge.

## Tooling

Run these before wrapping up changes that touch code:

```sh
pnpm check
pnpm test
pnpm build
```

For CLI behavior, also run a smoke pass:

```sh
pnpm gaia run examples/specs/smoke.md
pnpm gaia run examples/specs/smoke.md --harness fake
pnpm gaia run examples/specs/smoke.md --harness process --harness-command node --harness-arg "$PWD/examples/harnesses/process-harness.mjs"
pnpm gaia run examples/specs/smoke.md --workspace-source .
pnpm gaia status
pnpm gaia list
pnpm gaia resume <run-id>
pnpm gaia run examples/specs/smoke.md --json
```

Delete generated `.gaia/` run state after smoke testing unless the user asks to
keep it for inspection.

## Current Prototype Boundary

Prototype 1 is deliberately local and deterministic. It reads a Markdown spec,
creates a durable run directory, runs a fake harness, verifies one artifact,
writes reports, and can replay completed runs from the event log.

Anything involving real coding agents, worktrees, external services, browser
testing, reviewers, PRs, CI, or merge/deploy automation is a future slice.
