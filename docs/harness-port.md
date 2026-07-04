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
- `process`, a subprocess adapter for wrapper scripts around real harness CLIs.

## Adapter Boundary

Every real harness should be an adapter behind `GaiaHarness`.

Candidate adapters include:

- Codex;
- Claude;
- OpenCode;
- AI SDK HarnessAgent;
- any future best-in-class harness.

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
- `GAIA_SPEC_BODY`
- `GAIA_SPEC_TITLE`
- `GAIA_WORKER_LOG_PATH`
- `GAIA_WORKER_RESULT_PATH`
- `GAIA_WORKSPACE_OUTPUT_PATH`
- `GAIA_WORKSPACE_PATH`

The process writes workspace artifacts. Gaia captures stdout/stderr into
`worker.log`, then writes normalized `worker-result.json`.

## Deferred Dedicated Harness Work

Dedicated Codex, Claude, OpenCode, or AI SDK HarnessAgent adapters should be
added only once Gaia owns the relevant session, cancellation, log streaming, and
credential semantics.
