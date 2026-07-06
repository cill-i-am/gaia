# Runtime Intent

`packages/runtime` owns Gaia's Effect runtime workflows: durable run storage,
event append/read, worker planning, harness execution, read-only review
evidence, verification, reporting, GitHub evidence publishing, check/feedback
recording, browser evidence, Linear graph artifacts, merge decisions, doctor
checks, and command workflows.

## Runtime Rules

- Runtime is the owner for side effects. Filesystem, process execution, GitHub
  CLI calls, browser automation, and future external adapters belong here behind
  typed seams.
- Keep external raw output at the adapter boundary. Normalize it into parsed,
  branded, serializable artifacts before appending events or writing summaries.
- Use Effect for async workflows and expected failures. Expected operational
  failures should be `GaiaRuntimeError` or another typed error in the Effect
  error channel, not thrown exceptions.
- Persist evidence as files plus event pointers. `events.jsonl` is the source of
  truth; reports, snapshots, PR-loop state, browser evidence, and merge
  decisions are derived or attached evidence.
- Runtime functions should return typed summaries for CLI/UI clients. Do not
  make clients inspect internal files to learn workflow outcomes.
- Inject command runners, browser collectors, harnesses, reviewers, and external
  clients in tests. Do not require live GitHub, Codex, or browsers for unit
  coverage.
- Keep runtime payloads JSON-safe. Do not persist `Effect`, `Cause`, class
  instances, `Error`, functions, handles, clients, or platform resources.
