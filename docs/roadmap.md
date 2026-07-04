# Gaia Roadmap

This roadmap preserves the path from local prototype to software factory. Each
slice should stay independently useful, testable, and reversible.

## Principles

- Keep Gaia as a control plane, not a mega-agent.
- Prove durable lifecycle contracts before adding smarter workers.
- Prefer visible worker threads and evidence over hidden automation.
- Keep the orchestrator in final authority for merge/deploy decisions.
- Make each slice small enough to review against the spec and skills.
- Do not add external integrations until the local seam they plug into is
  boring.

## Slice 1: Local Run Lifecycle

Status: **Done**

Prove the smallest local loop:

- read a Markdown spec;
- create `.gaia/runs/run-<id>/`;
- append `events.jsonl`;
- derive `snapshots.jsonl`;
- run a deterministic fake harness;
- verify one artifact;
- write `report.md` and `report.json`;
- resume completed runs by replaying events.

## Slice 2: Workspace Preparation

Status: **Done**

Add isolated run workspaces before real coding workers exist.

Target behavior:

- `gaia run` can prepare an empty workspace by default;
- `gaia run --workspace-source <dir>` can copy a local source directory into the
  run workspace;
- generated/heavy directories such as `.git`, `.gaia`, `node_modules`, `dist`,
  and `.turbo` are excluded;
- workspace preparation writes a manifest artifact;
- the `WORKSPACE_PREPARED` event records serializable workspace evidence;
- tests prove the copied workspace is isolated and resumable.

Non-goals:

- real git clone;
- branch creation;
- worktree management;
- target-repo mutation;
- AI worker execution.

## Slice 3: Harness Port

Status: **Done**

Introduce a tiny worker/harness seam while keeping the fake harness as one
adapter.

Completed behavior:

- define the worker input/output contract;
- keep run events independent of a specific harness vendor;
- add one deterministic adapter;
- persist worker logs and result artifacts consistently.

Non-goals:

- real external harness execution;
- reviewer workers;
- pull requests;
- multi-agent scheduling.

See [`harness-port.md`](harness-port.md) for the adapter contract and future
popular-harness integration rules.

## Slice 3b: First Real Harness Adapter

Status: **Next**

Add one real experimental adapter behind the harness port.

Target behavior:

- choose the first real harness path, such as Codex, Claude, OpenCode, or AI SDK
  HarnessAgent;
- keep the fake harness as the deterministic test adapter;
- persist native logs and normalized `HarnessRunResult` evidence;
- prove the adapter against a throwaway local workspace.

Non-goals:

- reviewer workers;
- pull requests;
- merge/deploy automation;

## Slice 4: Reviewer Spectrum

Add read-only spec/review worker threads that keep implementation workers honest.

Target behavior:

- reviewer can inspect worker plan before implementation;
- reviewer can inspect diff/evidence after implementation;
- reviewer output is persisted as evidence;
- reviewer never edits files.

Non-goals:

- merge authority;
- broad policy engine;
- hidden subagent-only review.

## Slice 5: GitHub Pull Request Loop

Connect local runs to GitHub once workspaces and worker evidence are stable.

Target behavior:

- create branch;
- commit worker output;
- push;
- open PR;
- watch checks;
- attach Gaia report/evidence.

Non-goals:

- auto-merge;
- deploy decisions;
- Linear sync.

## Slice 6: Linear Issue Graph

Use Linear as the planning and blocker source of truth.

Target behavior:

- intake one Linear issue as a Gaia spec;
- model blockers using Linear blockers;
- update run status back to Linear;
- keep human-readable decisions in issue comments/docs.

Non-goals:

- local duplicate label system;
- full portfolio management.

## Slice 7: Merge And Deployment Authority

Let Gaia enforce evidence gates before merging.

Target behavior:

- orchestrator has final authority;
- reviewer/spec evidence is required for non-trivial changes;
- checks must pass;
- browser/e2e evidence is attached when applicable;
- merge/deploy actions are explicit, logged, and recoverable.

Non-goals:

- bypassing human override;
- treating frontend route guards or generated checks as security proof.

## Future Slices

- persistent SQLite run index;
- dashboard or TUI;
- browser evidence capture;
- CI watcher;
- multi-harness support through AI SDK HarnessAgent;
- skill bundle installation and versioning;
- cancellation and cleanup for live workers;
- reusable factory templates for new products.
