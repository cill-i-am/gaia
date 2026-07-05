# Harness Port

Gaia should be able to swap between popular coding harnesses without changing
the run lifecycle, event log, verifier, reports, or CLI shape.

The runtime owns one normalized harness port:

- `HarnessName` is a branded adapter selector parsed at the boundary.
- `HarnessRunRequest` is the serializable request shape Gaia sends to an
  adapter.
- `HarnessRunResult` is the serializable result shape Gaia persists as
  `worker-result.json`.
- `GaiaHarness` is the adapter interface.

The currently registered adapters are:

- `fake`, a deterministic in-process adapter for lifecycle tests;
- `codex`, a dedicated non-interactive Codex CLI adapter;
- `process`, a subprocess adapter for wrapper scripts around real harness CLIs.

## Adapter Boundary

Every real harness should be an adapter behind `GaiaHarness`.

Candidate adapters include:

- Codex;
- Claude;
- OpenCode;
- AI SDK HarnessAgent;
- any future best-in-class harness.

The Codex CLI adapter is specified in
[`codex-harness-adapter.md`](codex-harness-adapter.md). The minimum viable CLI
adapter exists; the heavier visible-session version remains deferred.

Adapters may use different SDKs, event streams, process models, auth, logs, and
native output formats internally. Those details must not leak into Gaia's core
run lifecycle. Each adapter translates its native execution model into:

- worker log text;
- workspace artifacts;
- `HarnessRunResult`;
- typed `GaiaRuntimeError` failures when expected problems occur.

## Rules

- Do not add harness-specific branches to `runSpecFile`.
- Do not persist SDK client objects, rich errors, functions, fibers, streams, or
  platform handles.
- Do not let an unregistered harness silently fall back to another adapter.
- Keep event payloads plain JSON.
- Keep adapter failures typed and safe to report.
- Add one adapter module per real harness once that harness is needed.

## Process Harness

The process harness is the first real external boundary. It runs one executable
with explicit repeated args, never through a shell string.

Use it like:

```sh
pnpm gaia run examples/specs/smoke.md \
  --harness process \
  --harness-command node \
  --harness-arg "$PWD/examples/harnesses/process-harness.mjs"
```

Gaia passes context through environment variables:

- `GAIA_RUN_ID`
- `GAIA_RESOLVED_SKILL_PATHS_JSON`
- `GAIA_SKILL_BUNDLE_PATH`
- `GAIA_SPEC_BODY`
- `GAIA_SPEC_TITLE`
- `GAIA_WORKER_LOG_PATH`
- `GAIA_WORKER_RESULT_PATH`
- `GAIA_WORKSPACE_OUTPUT_PATH`
- `GAIA_WORKSPACE_PATH`

The process writes workspace artifacts. Gaia captures stdout/stderr into
`worker.log`, then writes normalized `worker-result.json`.

## Codex Harness

The Codex harness owns the stable non-interactive local Codex path:

```sh
pnpm gaia run examples/specs/smoke.md --harness codex
```

Gaia runs `codex exec --json` against the isolated workspace with
`--skip-git-repo-check`, `--ephemeral`, and `--ignore-user-config`. It sends the
worker prompt on stdin, asks Codex to write Gaia's declared
`workspace/output.txt` artifact as `./output.txt` from inside the workspace,
requires that file to include the run id, captures stdout/stderr into
`worker.log`, stores the final Codex response in `codex-last-message.md`,
snapshots changed workspace files, and writes normalized `worker-result.json`.
The prompt includes `skill-bundle.json` plus any resolved local skill paths, so
the worker can load the available skill instructions without guessing where
they live.

Codex-specific flags are intentionally narrow:

- `--codex-command` overrides the executable command.
- `--codex-arg` passes repeated extra args to `codex exec`.
- `--codex-model` maps to `--model`.
- `--codex-profile` maps to `--profile`.
- `--codex-sandbox` supports `read-only` or `workspace-write`.
- `--codex-timeout-ms` overrides the default Codex subprocess timeout.

## Deferred Dedicated Harness Work

Visible Codex sessions, Claude, OpenCode, or AI SDK HarnessAgent adapters
should be added only once Gaia owns the relevant session, cancellation, log
streaming, and credential semantics.
