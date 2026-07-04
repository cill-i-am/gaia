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

The currently registered adapter is `fake`. It is deterministic and local. Its
job is to prove the contract before Gaia talks to real agent systems.

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

## Deferred Real Harness Work

The next slice should add the first real experimental adapter. That work should
decide whether Gaia talks to a harness through a local CLI process, a Codex
thread, AI SDK HarnessAgent, or another API. This document intentionally does
not choose that vendor yet.
