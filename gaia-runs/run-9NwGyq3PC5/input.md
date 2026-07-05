---
title: "GAIA-1: Expose Read-Only Local Run API From events.jsonl"
---

Implement Linear issue GAIA-1 in this workspace.

## Source Of Truth

- Linear issue: GAIA-1, "Expose Read-Only Local Run API From events.jsonl"
- Project/PRD: "Local Gaia API: Events-Backed Read Model"
- Paired read-only A/B reviewer thread: 019f3431-8522-7fe0-98d8-d2cf9e7a9ead
- Lane: B, Gaia-mediated implementation

## Goal

Expose a read-only local HTTP API over Gaia's existing `.gaia/runs` event-log
store without adding new durable state or changing existing CLI behavior.

## In Scope

- Create `apps/server` for the local API app.
- Use Effect v4.
- Add narrow `@gaia/runtime` read exports if needed.
- The server must not duplicate run-store readers.
- Serve exactly one Gaia root per process, defaulting to cwd, with an explicit
  root option if useful for tests or launch behavior.
- Bind to `127.0.0.1` by default.
- Implement these read-only endpoints:
  - `GET /runs`
  - `GET /runs/:id`
  - `GET /runs/:id/events`
  - `GET /runs/:id/artifacts/:artifactName`
- Use typed API envelopes or discriminated unions for success, partial success,
  diagnostics, and request-specific errors.
- Limit artifact reads to allowlisted text and JSON evidence.
- Add runtime contract tests for new read exports and HTTP boundary tests for
  API behavior.

## Out Of Scope

- Server-side run creation.
- CLI migration to server reads.
- Dashboard.
- SQLite or persistent run index.
- Auth or account model.
- Background daemon behavior.
- Live event streaming, WebSocket, or SSE.
- Cloud execution, cloud artifact storage, or execution backend abstraction.
- Live Linear sync.
- Generic file serving.
- Binary artifact serving, including screenshots.
- GAIA-2.

## Acceptance Criteria

- `apps/server` exists and exposes the read-only endpoints above.
- Endpoint responses are typed and JSON-safe.
- `GET /runs` returns valid run summaries plus typed diagnostics for invalid run
  directories instead of failing the entire list.
- `GET /runs/:id` fails clearly for a malformed or unreadable requested run.
- `GET /runs/:id/events` uses a light API envelope while keeping event items
  aligned with core `RunEvent`.
- Artifact reads are restricted to allowlisted text/JSON artifacts and cannot
  read arbitrary paths.
- Diagnostics expose only constrained public information: code, short message,
  recoverability, run id/path segment; no stacks or arbitrary file contents.
- Existing CLI behavior remains unchanged.
- New runtime read helpers, if any, are covered by runtime tests.
- HTTP boundary behavior is covered by server tests.

## Verification

Run focused tests while developing, then run:

- `pnpm check`
- `pnpm test`
- `pnpm build`

CLI smoke is not required unless CLI behavior changes.

## Gaia Worker Output

After implementation and verification, write `./output.txt` from the workspace
root with a concise summary of changed files, verification commands, and any
residual risk. Keep source changes narrow and do not coordinate implementation
details with Lane A except through public Linear/PR evidence.
