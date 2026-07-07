# Dashboard App Instructions

`apps/dashboard` is Gaia's local operator dashboard edge. Keep it as a thin
TanStack Start app over Gaia's public local-server API and reusable workspace
packages.

## Scope

- Compose the operator surface from shadcn/ui primitives and React Flow.
- Keep dashboard-specific state rebuildable in the client. Do not introduce
  hidden persistence or private filesystem reads.
- Treat all API responses as boundary input when live wiring is added. Parse
  them before carrying domain values inward.
- Use placeholders only for slices that are not implemented yet. Do not fake
  Codex thread internals, reviewer state, or live Gaia events.

## Current Boundary

GAIA-38 owns the static/function-light shell only: Run Console, Run Canvas,
Evidence Studio, and event strip. GAIA-39 owns Effect Query and local-server
client wiring.

Do not add server endpoints, server static serving, dashboard projection
endpoints, auth, SQLite, background daemons, queues, cancellation, global
streams, Last-Event-ID handling, live Linear sync, or merge automation unless a
future issue explicitly asks for that slice.
