# GAIA-2 Remediation: Parse Server Read Boundaries

## Context

This remediation continues Gaia run `run-Tqmn1pn6dq`, which implemented GAIA-2
through the real Codex worker harness.

Use the current workspace source as the product source. Preserve the GAIA-2
scope and do not broaden behavior.

Paired read-only A/B reviewer thread for final handoff:
`019f3451-5d53-7d90-bb16-cf866a4aec55`.

## Required Fix

The generated server read client maps a server-provided `runId` into a
`RunId` using a TypeScript cast. This violates the repository rule:

> Carry branded/domain values inward after parsing. Do not use casts to create
> brands.

Fix `packages/runtime/src/server-read-client.ts` so server/API boundary values
are parsed with the owning parser, such as `parseRunId` from `@gaia/core`,
before calling runtime helpers like `makeRunPaths`.

## Desired Behavior

- Keep `--server-url` opt-in for `gaia list` and `gaia status`.
- Keep direct runtime reads as the default path.
- Keep existing server-unavailable behavior and wording.
- Keep parity tests passing.
- Add or adjust a test if needed to prove invalid server `runId` data fails as
  a typed recoverable server response/read error rather than escaping as a raw
  parser exception.
- Do not route mutation commands through the server.
- Do not add daemon auto-start, dashboard, SQLite/index, streaming, auth, run
  creation, binary artifact serving, or cloud/hosted behavior.

## Verification Required

Run:

```sh
pnpm check
pnpm test
pnpm build
```

Also run focused runtime/CLI checks if relevant.

## Handoff

Update `workspace/output.txt` with:

- The original implementation run id: `run-Tqmn1pn6dq`.
- This remediation run id.
- What changed.
- Verification results.
- Residual risks.
- Paired read-only A/B reviewer thread:
  `019f3451-5d53-7d90-bb16-cf866a4aec55`.
