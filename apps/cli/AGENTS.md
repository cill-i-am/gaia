# CLI Intent

`apps/cli` owns the Gaia command-line entrypoint and command output formatting.
The CLI is a terminal client for Gaia workflows, not the workflow owner.

## CLI Rules

- Keep command handlers thin: parse CLI arguments, call `@gaia/runtime`, then
  render human text or JSON.
- Every command that supports `--json` should return a parsed runtime summary
  directly enough that machines can consume it without scraping text.
- Human renderers should summarize runtime summaries; they should not re-derive
  state from files.
- Do not execute GitHub, browser, filesystem workflow, harness, or reviewer work
  directly in the CLI. Add or reuse a runtime function instead.
- Use `pnpm gaia <command>` for manual smoke testing from the repo root.

## Local Verification

For CLI changes, run the relevant command help or smoke path in addition to
package checks. Prefer focused command smoke before broad repo verification.
