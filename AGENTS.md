# Agent Instructions

Gaia is a pnpm monorepo for a local-first, cloud-ready software factory control
plane. Use `pnpm` for installs, scripts, workspace commands, and one-off package
execution. Do not use npm, yarn, or Bun unless the user asks.

## Intent Graph

`AGENTS.md` is the canonical instruction node for each scope. This repo does
not maintain `CLAUDE.md` mirrors by default; add agent-specific mirrors only if
the user introduces a real consumer that cannot read `AGENTS.md`.

- `apps/AGENTS.md` governs deployable/user-facing app entrypoints.
- `apps/cli/AGENTS.md` governs the Gaia CLI.
- `packages/AGENTS.md` governs reusable workspace packages.
- `packages/core/AGENTS.md` governs pure contracts and lifecycle state.
- `packages/runtime/AGENTS.md` governs Effect runtime workflows and artifacts.
- `docs/AGENTS.md` governs product, architecture, and findings documents.
- `examples/AGENTS.md` governs static demo fixtures.
- `profiles/AGENTS.md` governs run profile policy fixtures.

Keep new intent at the nearest semantic owner. Root rules are for repo-wide
constraints only; local nodes should refine them without copying them.

## Agent Skills

Linear-native agent workflows are documented under `docs/agents/`. Read
`docs/agents/README.md` before using `to-prd`, `to-issues`, `triage`,
`orchestrator`, `worker`, `production-ready`, or `ci-watch` in this repo.

Keep Linear teams, statuses, labels, Projects, Initiatives, and issue state in
Linear as the live source of truth. Do not copy that workspace metadata into
repo files as a second mapping; read it through the Linear connector when a
skill needs current state.

## Repository Invariants

- Keep the control plane boring, inspectable, and resumable.
- Prefer the smallest implementation that proves the current factory loop.
- Do not add new harness vendors, live Linear sync, live reviewer threads,
  dashboards, SQLite, auth, background daemons, server APIs, or merge automation
  unless the current task explicitly asks.
- Parse boundary input immediately with Effect Schema or the owning parser.
- Carry branded/domain values inward after parsing. Do not use casts to create
  brands.
- Treat `events.jsonl` as the authoritative run history. `snapshots.jsonl` and
  reports are derived evidence.
- Keep persisted/runtime payloads serializable. Do not persist class instances,
  errors, functions, clients, or platform handles.
- Expected runtime failures belong in Effect's typed error channel.
- `.gaia/*` is generated local run state and must not be committed.
- Build outputs such as `dist/*` and `.turbo/*` are generated artifacts; do not
  edit or commit them.

## Cross-Boundary Contracts

- CLI input crosses into `@gaia/runtime` as parsed command options, not as
  command-specific business logic inside the CLI.
- Runtime events cross into `@gaia/core` replay as serializable event payloads.
  Core owns the schemas and state transitions that prove those payloads are
  valid.
- External systems such as GitHub, browser automation, future Linear sync, and
  harness processes are runtime adapters. Keep their raw outputs at the
  boundary, normalize them into typed artifacts, then persist the normalized
  shape.
- Documentation can describe future slices, but code should only implement the
  current explicit slice. Vision work should be broken into phase specs and
  grilled before becoming implementation.

## Tooling

Run these before wrapping up changes that touch code:

```sh
pnpm check
pnpm test
pnpm build
```

For CLI behavior, also run a smoke pass:

```sh
pnpm gaia doctor
pnpm gaia run examples/specs/smoke.md
pnpm gaia run examples/specs/smoke.md --harness fake
pnpm gaia run examples/specs/smoke.md --harness process --harness-command node --harness-arg "$PWD/examples/harnesses/process-harness.mjs"
pnpm gaia run examples/specs/smoke.md --workspace-source .
pnpm gaia status
pnpm gaia list
pnpm gaia resume <run-id>
pnpm gaia run examples/specs/smoke.md --json
pnpm gaia pr-checks 1 --json
pnpm gaia checks <run-id> 1 --json
```

Delete generated `.gaia/` run state after smoke testing unless the user asks to
keep it for inspection.

`pnpm gaia publish-pr <run-id>` and
`pnpm gaia publish-workspace-pr <run-id>` create a real branch, commit, push,
and draft GitHub PR. Run them only when the task explicitly includes GitHub
publishing.

## Current Prototype Boundary

Prototype 1 is deliberately local-first and artifact-driven. It reads a
Markdown spec, creates a durable run directory, writes a worker plan, runs a
harness, records read-only review evidence, verifies artifacts, writes reports,
and can replay completed runs from the event log.

Explicit commands may attach browser evidence, GitHub check/feedback evidence,
Linear graph fixtures, and merge-decision evidence to a run. Anything involving
worktrees, live reviewer threads, dashboards, server APIs, background daemons,
or merge/deploy mutation is a future slice. Browser evidence collection exists
for explicit target URLs; do not add target discovery unless the task asks.
