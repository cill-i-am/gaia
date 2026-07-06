# Apps Intent

`apps/*` contains user-facing entrypoints. Apps are edges over Gaia packages:
they translate operator input and output, but they do not own Gaia domain
contracts or runtime workflows.

## App Rules

- Keep app code thin. Push reusable workflow behavior into `@gaia/runtime` and
  reusable contracts into `@gaia/core`.
- App inputs are boundary input. Parse flags, paths, and options at the edge or
  pass them to the owning runtime parser immediately.
- App output formatting belongs at the app edge. Do not leak human-friendly
  strings into core contracts or runtime artifacts.
- Apps may depend on workspace packages. Workspace packages must not depend on
  apps.
