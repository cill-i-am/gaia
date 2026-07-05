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
5. Records a pinned portable-skill manifest when provided.
6. Writes typed browser evidence, starting as `not-collected`.
7. Appends lifecycle events to `events.jsonl`.
8. Writes derived snapshots to `snapshots.jsonl`.
9. Writes a worker plan artifact.
10. Records deterministic read-only plan review evidence.
11. Runs a deterministic fake harness through the harness port.
12. Verifies the fake harness's output artifact.
13. Records deterministic read-only evidence review output.
14. Writes `report.md` and `report.json`.
15. Resumes completed runs by replaying the event log.
16. Can publish completed run evidence as a draft GitHub PR.
17. Can publish completed run workspace changes as a draft GitHub PR.
18. Can inspect GitHub PR checks as `no-checks`, `pending`, `passed`, or
    `failed`.
19. Can record a GitHub check snapshot against a completed run, optionally
    polling until checks are no longer pending.
20. Writes resumable CI watch state whenever GitHub checks are recorded.
21. Can collect browser screenshot and console evidence for a completed run.

## What It Does Not Do Yet

Prototype 1 intentionally excludes:

- real Codex, Claude, OpenCode, or AI SDK HarnessAgent workers;
- target repository checkout or worktree management;
- skill bundle installation;
- live reviewer/spec worker threads;
- background GitHub check watching attached to runs or merges;
- Linear issue intake or blocker graphs;
- deployment evidence;
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
pnpm gaia run examples/specs/smoke.md --skill-manifest ./skills.json
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
pnpm gaia collect-browser-evidence <run-id> --url http://localhost:3000
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

Gaia passes a small environment contract to the process:

- `GAIA_HARNESS_CONTRACT_VERSION`
- `GAIA_RUN_ID`
- `GAIA_RESOLVED_SKILL_PATHS_JSON`
- `GAIA_SKILL_BUNDLE_PATH`
- `GAIA_SPEC_BODY`
- `GAIA_SPEC_TITLE`
- `GAIA_WORKER_LOG_PATH`
- `GAIA_WORKER_RESULT_PATH`
- `GAIA_WORKSPACE_OUTPUT_PATH`
- `GAIA_WORKSPACE_PATH`

The normalized worker result records the harness exit code, declared output
artifacts, and changed workspace paths. Gaia validates declared `workspace/*`
artifacts before verification so a harness cannot claim output it did not
produce.

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
```

`events.jsonl` is the source of truth. Every line is a parsed `RunEvent`.

`snapshots.jsonl` is derived evidence. On load, Gaia replays the full event log
and verifies the latest snapshot's state and sequence match replay. If they do
not match, the run is treated as corrupt.

`.gaia/latest` stores the latest run id. This avoids pretending random Nano IDs
have chronological ordering.

`.gaia/lock` is a local mutation lock. Gaia creates it before starting a new run
or recording GitHub check evidence, then removes it when the mutation finishes.
If it already exists, the mutating command fails with `RunStoreLocked`. This is
intentionally simple: it prevents local run-store races before Gaia has a
persistent index or live worker scheduler.

`workspace-manifest.json` records the workspace source, copied file count,
skipped entries, and run-local workspace path. By default Gaia prepares an empty
workspace. With `--workspace-source <dir>`, Gaia copies a local directory into
the run workspace while excluding generated or heavy directories such as `.git`,
`.gaia`, `.turbo`, `coverage`, `dist`, and `node_modules`.

`skill-manifest.json` records the portable skills selected for a run. Without
`--skill-manifest`, Gaia writes an empty manifest. With `--skill-manifest`, Gaia
normalizes this shape:

```json
{
  "skills": [
    {
      "name": "coding-standards",
      "sourceRepository": "github.com/example/skills",
      "sourcePath": "skills/coding-standards",
      "commit": "abc123"
    }
  ]
}
```

Every skill must include a `sourceRepository`, `sourcePath`, and either
`version` or `commit`. Gaia records the manifest and report selected skills.
It also writes `skill-bundle.json`: local entries with `sourceRepository:
"local"` or `"file"` are resolved relative to the manifest and must contain
`SKILL.md`; git-backed external entries are cloned into the run directory and
checked out at their pinned commit or version. Worker harnesses receive the
bundle path and resolved skill paths in their execution context.

`browser-evidence.json` records browser automation evidence. New runs start
with:

```json
{
  "notes": ["Browser automation is not collected for this run yet."],
  "pages": [],
  "status": "not-collected",
  "version": 1
}
```

`collect-browser-evidence` opens the provided URL with Playwright, captures a
full-page screenshot under `browser/`, records console messages, rewrites
`browser-evidence.json`, and appends a `BROWSER_EVIDENCE_RECORDED` event. If
capture is requested but the browser pass cannot run, Gaia writes `status:
"failed"` evidence instead of pretending the page was verified. Publishing run
evidence copies the `browser/` directory when screenshots exist.

`publish-pr` copies selected evidence into `gaia-runs/<run-id>/` on a new
`gaia/<run-id>` branch, commits it, pushes it, opens a draft GitHub PR, and
restores the original local branch. The command refuses to run with a dirty
worktree.

`preflight-github` checks whether a completed run can publish to GitHub without
mutating local git state or GitHub. It verifies the run is completed, the current
directory is a git repository, the worktree is clean, the checkout is on a
branch, the remote exists, the remote exposes the base branch, and `gh auth
status` succeeds. Both PR publishing commands run the same preflight before
mutating git.

`preview-pr` runs GitHub preflight and returns a read-only command preview. The
default mode previews an evidence-only PR. `--workspace` previews a
workspace-change PR, including the source staging and cached-diff commands Gaia
would run before committing. Preview output is evidence, not execution: it does
not fetch, checkout, stage, commit, push, or open a PR.

`publish-workspace-pr` applies the run workspace to a new
`gaia/<run-id>-workspace` branch before copying the same selected evidence into
`gaia-runs/<run-id>/`. It skips harness-declared workspace artifacts such as
`workspace/output.txt`, mirrors source additions/edits/deletions outside
`.gaia/` and `gaia-runs/`, and fails with `WorkspacePrNoChanges` when the run
workspace does not differ from the base branch. Use `publish-pr` for
evidence-only PRs.

`pr-checks` queries GitHub for a pull request's reported checks and normalizes
the result to one of four states: `no-checks`, `pending`, `passed`, or `failed`.
It is read-only and does not mutate the run log.

`checks` records a check snapshot against a completed Gaia run. Each snapshot is
written to `github-checks/checks-<event-sequence>.json`, then appended to
`events.jsonl` as `GITHUB_CHECKS_RECORDED`. By default it records the current
GitHub state once. With `--wait`, it polls on a bounded fixed interval until the
state is no longer `pending`, then records the final observed state. It is still
not a background watcher.

Each `checks` recording also writes `ci-watch-state.json`:

```json
{
  "attempts": 2,
  "lastSnapshotPath": "github-checks/checks-12.json",
  "lastStatus": "pending",
  "nextAction": "poll-again",
  "pr": "1",
  "runId": "run-V7kP9sQ2xY",
  "terminal": false,
  "updatedAt": "2026-07-04T00:00:00.000Z",
  "version": 1
}
```

`nextAction` is `complete` for terminal states and `poll-again` when bounded
waiting ends while checks are still pending. Future background CI watching
should resume from this artifact and the append-only event log rather than keep
hidden process memory as the source of truth.

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
| `GITHUB_CHECKS_RECORDED` | Attach GitHub check evidence to an already completed run. |
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
- GitHub check snapshots are emitted through `GitHubChecksSnapshot`.

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
- GitHub publishing command sequencing through a recording command runner;
- GitHub check-state classification through a recording command runner;
- run-scoped GitHub check snapshot recording and bounded wait polling;
- verification failure when a worker artifact is missing.

Tests use temp run roots instead of the repository `.gaia/` directory.
