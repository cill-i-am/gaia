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

Prototype 1 deliberately excludes visible Codex/Claude/OpenCode worker
threads, Linear, worktrees, live reviewer threads, browser evidence,
dashboards, and merge automation. It does include a non-interactive Codex CLI
harness, deterministic local review evidence, evidence-only GitHub PR
publishing, workspace-change GitHub PR publishing, and GitHub PR check
inspection/recording.

See [`docs/prototype-1.md`](docs/prototype-1.md) for the detailed prototype
contract, event lifecycle, artifact format, and deferred work.
See [`docs/roadmap.md`](docs/roadmap.md) for the planned software-factory
slices.
See [`docs/codex-harness-adapter.md`](docs/codex-harness-adapter.md) for the
implemented Codex harness spec and
[`docs/post-harness-roadmap.md`](docs/post-harness-roadmap.md) for the ordered
post-harness roadmap.

## Commands

```sh
pnpm install
pnpm check
pnpm test
pnpm build

pnpm gaia run examples/specs/smoke.md
pnpm gaia run examples/specs/smoke.md --harness fake
pnpm gaia run examples/specs/smoke.md --harness codex
pnpm gaia run examples/specs/smoke.md --harness process --harness-command node --harness-arg "$PWD/examples/harnesses/process-harness.mjs"
pnpm gaia run examples/specs/smoke.md --workspace-source .
pnpm gaia run examples/specs/smoke.md --skill-manifest ./skills.json
pnpm gaia run examples/specs/smoke.md --json
pnpm gaia status
pnpm gaia list
pnpm gaia resume <run-id>
pnpm gaia preflight-github <run-id>
pnpm gaia preview-pr <run-id>
pnpm gaia preview-pr <run-id> --workspace
pnpm gaia publish-pr <run-id>
pnpm gaia publish-workspace-pr <run-id>
pnpm gaia pr-checks <pr-number-or-url>
pnpm gaia checks <run-id> <pr-number-or-url>
pnpm gaia checks <run-id> <pr-number-or-url> --wait
```

## Repository Tooling

Ultracite provides Gaia's root Oxlint and Oxfmt presets. The canonical tooling
commands are:

```sh
pnpm lint
pnpm lint:audit
pnpm schema-contracts:audit
pnpm format
pnpm format:check
pnpm test:schema-contracts
pnpm test:tooling
pnpm tooling:doctor
```

`pnpm lint` is the green compatibility gate over Gaia-owned product source.
`pnpm lint:audit` runs the unsoftened preset over the same product directories;
it is intentionally non-gating and exits non-zero while inherited findings
remain. See [`docs/oxlint-compatibility.md`](docs/oxlint-compatibility.md) for
the individually measured rule profile and removal policy.

`pnpm test:schema-contracts` verifies Gaia's schema-first syntax rules and the
TypeScript-checker ownership proof. `pnpm schema-contracts:audit` reports the
current migration backlog from both engines and intentionally remains outside
`pnpm check`; it exits non-zero while findings remain. GAIA-104 owns source
remediation rather than this tooling slice.

Oxfmt owns formatting, import ordering, and Tailwind v4 class ordering. The
Tailwind sorter uses the dashboard stylesheet and recognizes `cn`, `clsx`, and
`cva`. `pnpm test:tooling` proves representative TypeScript/TSX imports and
Tailwind classes through the shipped CLI/config path, including second-run
idempotence.

Tracked `.agents/skills/**` files are vendored agent tooling and are outside
Gaia product lint/format ownership. Generated `.gaia/**`, `dist/**`, `.turbo/**`,
and `*.gen.*` outputs are also excluded.

`pnpm gaia` resolves paths from the directory where the command was invoked and
stores generated run state in that directory's `.gaia/` folder.
Gaia uses `.gaia/lock` to serialize local run-store mutations such as new runs
and check snapshot recording. Read-only commands can still inspect existing
runs, but mutating commands fail fast while another mutation is in progress.
`pnpm gaia preflight-github <run-id>` verifies that a completed run is ready
for GitHub publishing without mutating git or GitHub: git repo, clean worktree,
current branch, remote, base branch, local `HEAD` matching the remote base, and
GitHub CLI auth.
`pnpm gaia preview-pr <run-id>` runs the same read-only preflight and prints the
branch, evidence path, source-change claim, and external commands Gaia would run
for an evidence-only PR. Add `--workspace` to preview the workspace-change PR
path.
Harness results include the harness exit code and the workspace files that
changed during execution. Gaia also validates harness-declared `workspace/*`
output artifacts before the run can move into verification.
`pnpm gaia run --harness codex` executes `codex exec` against the isolated run
workspace with `--json`, `--skip-git-repo-check`, `--ephemeral`,
`--ignore-user-config`, `--sandbox workspace-write`, and
`--output-last-message <run>/codex-last-message.md`. Gaia asks Codex to write
the declared `workspace/output.txt` artifact as `./output.txt` from inside the
workspace. Use `--codex-command`, repeated `--codex-arg`, `--codex-model`,
`--codex-profile`, `--codex-sandbox`, and `--codex-timeout-ms` only when you
need to override those defaults.
`pnpm gaia run --skill-manifest <path>` records a pinned portable-skill
manifest as `skill-manifest.json` evidence. Gaia validates that every selected
skill has a source repository, source path, and either a version or commit. It
also writes `skill-bundle.json`: local skill sources are resolved and checked
for `SKILL.md`; external sources are marked as requiring installation. Worker
harnesses receive the bundle path and resolved local skill paths as part of
their execution context.
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
Each recording also writes `ci-watch-state.json` with the latest status,
terminal flag, last snapshot path, and next action (`complete` or
`poll-again`). This is the resumable model future background watching will use.

## Run Directory

Each run is stored relative to the current working directory:

```txt
.gaia/runs/run-V7kP9sQ2xY/
  input.md
  events.jsonl
  snapshots.jsonl
  workspace-manifest.json
  skill-manifest.json
  skill-bundle.json
  browser-evidence.json
  worker-plan.md
  worker-plan.json
  plan-review.md
  plan-review.json
  plan-reviewer-session.json
  workspace/
    output.txt
  codex-last-message.md  # Codex harness runs
  worker.log
  worker-result.json
  verification.log
  verification-result.json
  evidence-review.md
  evidence-review.json
  evidence-reviewer-session.json
  report.md
  report.json
  github-checks/
    checks-<event-sequence>.json
  ci-watch-state.json
```

`events.jsonl` is the source of truth. `snapshots.jsonl` is derived from replay
and exists for status/debugging.

`worker-result.json` is normalized harness evidence. It records the selected
harness, declared output artifacts, process exit code, and changed workspace
paths so future harness adapters can be compared through the same contract.

`browser-evidence.json` is a typed placeholder for future Browser/Chrome
automation. Prototype runs write `not-collected` evidence so reports and PRs
already have a stable artifact path before live capture is added.

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

- dedicated Claude, OpenCode, or AI SDK HarnessAgent adapters;
- visible Codex/Claude/OpenCode worker threads;
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
