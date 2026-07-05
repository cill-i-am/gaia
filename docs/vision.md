# Gaia Local-First Software Factory Plan

## 1. Product Thesis

Gaia should become a **software factory control plane**.

The core idea:

> Users describe work. Gaia turns that work into coordinated implementation, review, verification, browser evidence, and PR/deployment workflows using swappable AI harnesses and execution backends.

The important architectural decision is that Gaia should not be “a CLI that happens to grow a UI.” It should become:

```txt
Gaia Server/API = source of truth
CLI = terminal client
Dashboard = visual client
Runners = execution backends
Harnesses = AI/code agents
```

This gives us a clean path from:

```txt
local machine personal tool
  -> private cloud runner
  -> multi-user web product
```

without rewriting the core workflow.

---

## 2. Directional Decision

Build Gaia as:

> **Local-first control plane, cloud-ready execution architecture.**

Not local-only. Not cloud-first SaaS immediately.

### Why Local First

Local-first lets us prove the product loop quickly:

- use existing local Codex/Claude/Cursor auth
- avoid auth vault complexity on day one
- avoid multi-tenant security before workflow-market fit
- iterate on the dashboard/operator experience rapidly
- debug agent failures on the same machine
- keep the current CLI useful

### Why Cloud-Ready

We should avoid hardcoding assumptions that make cloud painful later.

Even in the local version, model these as explicit concepts:

- runs
- events
- artifacts
- workspaces
- harness accounts
- execution backends
- browser automation
- reviewers
- verification
- PR publishing

Local is just the first adapter.

---

## 3. Target Shape

```txt
                    +----------------+
                    |  Gaia Dashboard |
                    +--------+-------+
                             |
+------------+       +-------v--------+
|  Gaia CLI  +------->  Gaia Server   |
+------------+       |  API / SOT     |
                     +-------+--------+
                             |
          +------------------+------------------+
          |                  |                  |
+---------v------+  +--------v--------+  +------v-------+
| HarnessAdapter |  | ExecutionBackend|  | ArtifactStore|
+----------------+  +-----------------+  +--------------+
          |                  |                  |
   Codex / Claude     local / Vercel      local fs / R2
   Cursor / etc       Cloudflare          S3 / Blob
```

The server owns orchestration and state.

The CLI and dashboard call the server.

The runner/harness adapters do the actual work.

---

## 4. Server As Source Of Truth

The Gaia server should own:

- run creation
- event log
- current run state
- specs
- worker/reviewer dispatch
- artifact indexing
- browser evidence records
- verification results
- PR publishing state
- harness account references
- runner lifecycle
- approval gates

The current `.gaia/runs/*` artifact model is a good foundation. The local server can initially use local filesystem storage, but it should expose state through API contracts rather than requiring every client to read files directly.

### Local Server Mode

```sh
gaia server
```

Starts a local API server.

The CLI can either:

- auto-start it if missing, or
- connect to an existing server.

The dashboard connects to it over HTTP/WebSocket.

### Cloud Server Mode

Later, the same conceptual server runs as a hosted service with cloud-backed storage.

---

## 5. CLI Role

The CLI should remain permanently useful, but become a thin client over the Gaia server.

Examples:

```sh
gaia server
gaia run spec.md
gaia status run-abc123
gaia logs run-abc123
gaia events run-abc123 --json
gaia publish-pr run-abc123
gaia cancel run-abc123
gaia dashboard
```

In local mode, the CLI may start an embedded server and call it internally.

Over time, orchestration should move out of direct CLI command handlers and into the server/runtime application layer.

---

## 6. Dashboard Role

The dashboard is the operator surface.

It should make Gaia feel alive and inspectable:

- run queue
- run timeline
- worker status
- reviewer status
- current plan
- logs
- diffs
- artifacts
- browser evidence
- test results
- PR state
- approvals
- harness account setup
- runner health

The dashboard should not own workflow logic. It calls the server.

---

## 7. Pluggable Ports

“Pluggable” should mean **stable internal ports**, not a broad plugin marketplace yet.

Start with narrow interfaces derived from real Gaia needs.

### ExecutionBackend

Where work runs.

```txt
local-shell
vercel-sandbox
cloudflare-sandbox
```

Responsibilities:

- create isolated workspace
- mount or copy input files
- run commands
- stream logs
- collect outputs
- clean up compute
- preserve artifacts

### HarnessAdapter

Which AI coding tool does the work.

```txt
codex
claude-code
cursor
opencode
api-sdk-model
```

Responsibilities:

- receive spec/context
- receive skill paths
- run implementation or review
- emit logs/transcript
- write result contract
- declare changed files/artifacts

### ReviewerAdapter

Same harnesses, but in a read-only/reviewer role.

Responsibilities:

- review worker plan
- review final diff/evidence
- produce findings
- block if necessary
- never mutate workspace

### BrowserAutomation

Where browser checks run.

```txt
local-browser
cloudflare-browser-run
playwright-in-sandbox
```

Responsibilities:

- open app
- collect screenshots
- collect console errors
- verify simple flows
- store browser evidence

### ArtifactStore

Where run artifacts live.

```txt
local-fs
r2
s3
vercel-blob
```

Responsibilities:

- write artifacts
- read artifacts
- generate stable references
- keep large logs/screenshots out of DB

### AuthVault

Where harness credentials live.

```txt
local-fs/keychain
cloud-kms/encrypted-db
```

Responsibilities:

- store harness auth securely
- mount or inject auth into trusted runners
- support disconnect/delete
- avoid exposing secrets in logs/artifacts

### GitProvider

```txt
github
gitlab later
```

Responsibilities:

- create branches
- publish PRs
- inspect checks
- watch CI
- report status

### IssueTracker

```txt
linear
github-issues
none
```

Responsibilities:

- import issue/spec
- model blockers
- sync status
- post run/PR links

---

## 8. Harness Accounts

To productise “use your subscription,” Gaia needs a first-class `HarnessAccount`.

```txt
HarnessAccount
- id
- provider: codex | claude-code | cursor | opencode
- authMode: auth-json | oauth-token | api-key | user-api-key
- owner: user | org
- storageRef
- allowedExecutionBackends
- concurrencyPolicy
- lastVerifiedAt
- status
```

### Codex

Likely modes:

```txt
auth-json
access-token
api-key
```

For local-first, Codex can use local installed auth.

For cloud trusted runners, Gaia can mount a persisted `CODEX_HOME`.

### Claude Code

Likely modes:

```txt
CLAUDE_CODE_OAUTH_TOKEN
api-key
```

Claude Code looks especially clean because it supports a long-lived OAuth token flow for automation.

### Cursor

Likely modes:

```txt
user-api-key
cli-login-cache
```

Needs prototyping, but the model still fits.

---

## 9. Trusted Runner Model

For cloud execution, Gaia should use trusted private runners.

The runner is allowed to access user harness credentials because:

- Gaia controls the infrastructure
- Gaia controls lifecycle
- the runner is isolated per job
- untrusted code paths are restricted
- auth is mounted only when needed

### Runner Rules

- ephemeral workspace per run
- persistent auth mount per harness account
- no shared mutable workspace
- careful concurrency around auth refresh
- logs redacted
- run lifecycle fully recorded
- failed runs preserve evidence
- fork/untrusted PRs cannot access subscription auth

### Vercel Path

Vercel Sandbox is attractive for this:

```txt
Gaia Server
  -> Vercel Sandbox
       -> mounted CODEX_HOME / CLAUDE token / Cursor key
       -> ephemeral workspace
       -> command execution
       -> artifact upload
```

FUSE-backed storage makes persistent auth and artifacts feasible.

### Cloudflare Path

Cloudflare path:

```txt
Worker / Durable Object / Queue
  -> Cloudflare Sandbox SDK / Containers
       -> command execution
       -> R2 artifacts
  -> Browser Run for hosted browser checks
```

Cloudflare Browser Run can cover browser evidence without needing local browser state.

---

## 10. Local-First Implementation Plan

### Phase 1: Local Gaia Server

Goal:

- Move source-of-truth behavior behind a local server API.

Build:

- `gaia server`
- REST or RPC API for runs
- event stream endpoint
- artifact read endpoint
- CLI becomes a client where practical
- current filesystem-backed `.gaia/runs` remains storage

Done when:

- CLI can create/list/status runs via server
- dashboard can subscribe to run events
- existing CLI workflows still work

### Phase 2: Local Dashboard

Goal:

- Build the operator UI.

Build:

- run list
- run detail timeline
- logs/artifacts
- worker/reviewer status
- result summary
- PR/check status
- browser evidence display when available

Done when:

- local workflow is inspectable without tailing files
- user can start a run from UI
- user can inspect failure evidence from UI

### Phase 3: Harness Accounts, Local Mode

Goal:

- Model harness auth without cloud custody yet.

Build:

```txt
local Codex account
local Claude account
local Cursor account
```

These may initially just point to existing local auth.

Done when:

- user can select harness account per run
- Gaia records which account/harness was used
- no secrets are copied into run artifacts

### Phase 4: Cloud Execution Port

Goal:

- Add execution backend abstraction.

Build:

```txt
ExecutionBackend.localShell
ExecutionBackend.vercelSandbox or cloudflareSandbox
```

Done when:

- same run request can execute locally or in a sandbox
- artifacts come back through the same Gaia artifact model

### Phase 5: Trusted Cloud Harness Auth

Goal:

- Let cloud runners use user harness subscriptions.

Build:

- encrypted harness vault
- auth bootstrap flow
- persisted `CODEX_HOME` / Claude token / Cursor key
- runner auth mount
- concurrency policy
- disconnect/delete flow

Done when:

- user can connect a harness account
- cloud runner can execute using that account
- auth refresh persists safely
- logs/artifacts do not expose secrets

### Phase 6: Web Product

Goal:

- Hosted Gaia.

Build:

- user/org accounts
- project model
- cloud artifact store
- cloud DB
- runner queue
- billing/quotas if needed
- org-level harness accounts
- team visibility and approvals

---

## 11. Run Lifecycle

A run should stay boring and event-driven.

```txt
RUN_CREATED
WORKSPACE_PREPARED
SKILLS_RESOLVED
PLAN_REVIEW_STARTED
PLAN_REVIEW_COMPLETED
WORKER_STARTED
WORKER_COMPLETED
VERIFICATION_STARTED
VERIFICATION_COMPLETED
EVIDENCE_REVIEW_STARTED
EVIDENCE_REVIEW_COMPLETED
BROWSER_EVIDENCE_COLLECTED
PR_PUBLISHED
CI_WATCH_STARTED
CI_WATCH_COMPLETED
RUN_COMPLETED
```

Everything important should be reconstructable from the event log plus artifacts.

---

## 12. API Shape

Initial API can be small.

```txt
POST /runs
GET /runs
GET /runs/:id
GET /runs/:id/events
GET /runs/:id/events/stream
GET /runs/:id/artifacts/:artifact
POST /runs/:id/cancel
POST /runs/:id/publish-pr
```

Later:

```txt
GET /harness-accounts
POST /harness-accounts
DELETE /harness-accounts/:id
GET /execution-backends
POST /runs/:id/approve
POST /runs/:id/retry
```

---

## 13. Non-Goals For Now

Do not start with:

- multi-tenant SaaS auth
- billing
- hosted runner marketplace
- broad plugin marketplace
- complicated policy engine
- auto-merge
- dashboard-first rewrite
- cloud-only execution
- provider-specific abstractions leaking everywhere

---

## 14. Key Architectural Guardrails

- Server/API owns state.
- CLI and dashboard are clients.
- Local filesystem is an adapter, not the architecture.
- Harnesses are adapters.
- Execution backends are adapters.
- Artifact storage is an adapter.
- Auth custody is explicit.
- Every run is resumable or explainably failed.
- Every important action writes an event.
- Reviewer agents are read-only.
- Browser evidence is optional but first-class.
- Cloud trusted runners must never run untrusted code with user subscription auth mounted.
- Keep contracts small until real use forces expansion.

---

## 15. Recommended Next Step

The next real build step should be:

> **Introduce `gaia server` as the local source-of-truth API while preserving the existing CLI behavior.**

That unlocks the dashboard without prematurely solving cloud auth.

A good first slice:

```txt
1. Add server package/app.
2. Expose run creation and run status APIs.
3. Make CLI optionally call the server.
4. Add event stream endpoint.
5. Keep filesystem-backed run storage.
6. Add tests proving CLI and API see the same run state.
```

Then build the dashboard on top of that.

This gives us the clean local-first loop and the foundation for cloud runners later.