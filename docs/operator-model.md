# Gaia Operator Model

This document records the operational decisions that are useful before the
local server/product phase. It is not a server API spec.

## Read Model

`events.jsonl` remains the source of truth for a run. Snapshots, reports, PR
loop state, browser evidence, Linear graphs, and merge decisions are derived or
attached evidence.

For the first local server/dashboard slice, prefer an in-memory run index
derived from the filesystem at startup and refreshed from run artifacts. Do not
introduce SQLite until the UI needs durable cross-run queries, pagination,
filtering, or fast incremental reconciliation.

Reasoning:

- the current run store is small and intentionally inspectable;
- replaying artifacts keeps the server honest about event-log authority;
- SQLite too early would create a second persistence concern before the product
  shape is proven.

## Command Authority Levels

Commands should make their authority obvious. A future UI or orchestrator should
surface the same levels.

| Level | Meaning | Current commands |
| --- | --- | --- |
| Read-only | Inspect local or external state without writing artifacts or mutating external systems. | `status`, `list`, `pr-checks`, `doctor` |
| Local artifact writing | Write `.gaia` run evidence only. | `run`, `resume`, `collect-browser-evidence`, `checks`, `watch-ci`, `watch-pr-feedback`, `pr-loop`, `plan-remediation`, `linear-issue`, `merge-decision` |
| External mutation | Mutate GitHub, but not merge or deploy. | `publish-pr`, `publish-workspace-pr`, `comment-pr` |
| Future destructive authority | Merge, deploy, destroy, rollback, or clean up remote resources. | Not implemented |

`merge-decision` intentionally returns `ready-to-merge`, not `merge-pr`. The
artifact records that Gaia's evidence gate is clear, but it does not perform
the merge.

## Demo Fixtures

Portable examples live under `examples/*`.

- `examples/specs/factory-demo.md` is a richer local run spec for demos.
- `examples/linear/issue-graph.json` can be attached with
  `gaia linear-issue <run-id> examples/linear/issue-graph.json`.
- `examples/github/pr-loop-state.ready.json` documents the shape of a clean PR
  loop state without requiring GitHub.

These fixtures are intentionally static. They make docs, tests, and demos easier
without becoming a second source of truth for real runs.
