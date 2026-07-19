# Current Capabilities

This ledger is the routing source of truth for what the current Gaia product
implements. Historical prototype documents explain how a slice was built; they
do not override this ledger. Every classification is revision-specific and
must be refreshed when the cited owner changes materially.

## Classification

- `implemented`: the bounded claim exists in current source and focused tests.
- `partial`: a useful bounded slice exists, but the broader claim does not.
- `missing`: the named owning contract or behavior does not exist.
- `superseded`: current domain-owned contracts solve the need; do not add the
  older proposed shape.
- `historical-prototype`: the document describes an earlier product boundary
  and is retained as implementation history, not current routing guidance.

## Ledger

| Capability claim | State | Current evidence | Exact boundary |
| --- | --- | --- | --- |
| Append-only run truth and deterministic replay | implemented | [`packages/core/src/events.ts`](../packages/core/src/events.ts), [`packages/core/src/core.test.ts`](../packages/core/src/core.test.ts), [`packages/runtime/src/event-store.ts`](../packages/runtime/src/event-store.ts), [`packages/runtime/src/event-store.test.ts`](../packages/runtime/src/event-store.test.ts) | `events.jsonl` is authoritative; snapshots, reports, indexes, and UI reads are derived. |
| Provider-neutral harness sessions and capability qualification | implemented | [`packages/core/src/harness-session.ts`](../packages/core/src/harness-session.ts), [`packages/core/src/harness-session.test.ts`](../packages/core/src/harness-session.test.ts), [`packages/runtime/src/harness-provider-registry.test.ts`](../packages/runtime/src/harness-provider-registry.test.ts) | Preserve the existing session port; provider-native state is adapter-private. |
| Codex streaming, resumption, steering, interruption, and typed interactions | implemented | [`packages/runtime/src/codex-harness-provider.ts`](../packages/runtime/src/codex-harness-provider.ts), [`packages/runtime/src/codex-harness-provider.test.ts`](../packages/runtime/src/codex-harness-provider.test.ts), [`packages/runtime/src/codex-session-mapper.test.ts`](../packages/runtime/src/codex-session-mapper.test.ts) | This is session-scoped behavior, not durable run-wide pause, resume, or cancel. |
| Domain-owned operator actions, structural digests, receipts, and interaction resolution | implemented | [`packages/core/src/agent-session-api.ts`](../packages/core/src/agent-session-api.ts), [`packages/runtime/src/agent-session-runtime.ts`](../packages/runtime/src/agent-session-runtime.ts), [`packages/runtime/src/agent-session-runtime.test.ts`](../packages/runtime/src/agent-session-runtime.test.ts) | Consequential authority remains explicit; secrets are not part of durable structural digests. |
| Unknown external outcomes stop blind redispatch | implemented | [`packages/runtime/src/agent-session-runtime.ts`](../packages/runtime/src/agent-session-runtime.ts), [`packages/runtime/src/agent-session-runtime.test.ts`](../packages/runtime/src/agent-session-runtime.test.ts), [`packages/runtime/src/worker-recovery.test.ts`](../packages/runtime/src/worker-recovery.test.ts) | `outcomeUnknown` requires reconciliation; it is not a retry signal. |
| Local server, dashboard inspection, isolated delivery worktrees, and bounded delivery evidence | implemented | [`apps/server/src/api.ts`](../apps/server/src/api.ts), [`apps/server/src/api.test.ts`](../apps/server/src/api.test.ts), [`apps/dashboard/src/components/dashboard-shell.test.tsx`](../apps/dashboard/src/components/dashboard-shell.test.tsx), [`packages/runtime/src/server-workflows.test.ts`](../packages/runtime/src/server-workflows.test.ts) | These surfaces do not grant autonomous merge, deploy, or provider-mutation authority. |
| Schema-first and branded durable/public contracts | implemented | [`scripts/audit-schema-contracts.mjs`](../scripts/audit-schema-contracts.mjs), [`scripts/verify-schema-contract-rules.mjs`](../scripts/verify-schema-contract-rules.mjs), [`packages/core/src/core.test.ts`](../packages/core/src/core.test.ts) | Keep platform handles, functions, errors, clients, and Effect runtime values out of persisted payloads. |
| Worker recovery and continuation | partial | [`packages/core/src/worker-recovery.ts`](../packages/core/src/worker-recovery.ts), [`packages/core/src/worker-recovery.test.ts`](../packages/core/src/worker-recovery.test.ts), [`packages/runtime/src/worker-recovery.test.ts`](../packages/runtime/src/worker-recovery.test.ts) | Current action families are deliberately bounded; there is no general failure-digest repair engine. |
| Accepted-outcome and claim-matched verification | partial | [`packages/runtime/src/worker-plan.ts`](../packages/runtime/src/worker-plan.ts), [`packages/runtime/src/verifier.ts`](../packages/runtime/src/verifier.ts), [`packages/runtime/src/runtime.test.ts`](../packages/runtime/src/runtime.test.ts) | Planning records checks, but the verifier still proves legacy artifact integrity rather than every accepted outcome. `RunContract` and honest proof-result vocabulary belong to GAIA-144. |
| Effective model invocation and context evidence | partial | [`packages/runtime/src/source-planning-context.ts`](../packages/runtime/src/source-planning-context.ts), [`packages/runtime/src/worker-plan.ts`](../packages/runtime/src/worker-plan.ts), [`packages/runtime/src/runtime.test.ts`](../packages/runtime/src/runtime.test.ts), [`packages/runtime/src/interactive-harness.test.ts`](../packages/runtime/src/interactive-harness.test.ts) | Rich planning context exists, but no versioned invocation/context manifest proves the exact worker input or model identity. |
| Durable run-wide wait, pause, resume, and cancel | missing | [`packages/core/src/events.ts`](../packages/core/src/events.ts), [`packages/core/src/core.test.ts`](../packages/core/src/core.test.ts) | Session interaction, interruption, and continuation must not be described as run-wide lifecycle control. |
| Fixed-worker harness evaluation | missing | [`packages/core/src/factory-scorecard.ts`](../packages/core/src/factory-scorecard.ts), [`packages/core/src/core.test.ts`](../packages/core/src/core.test.ts) | The scorecard is a decision artifact, not a comparison contract over equivalent worker/context/authority epochs. |
| A second generic session abstraction, global `AgentDecision`, or generic action registry | superseded | [`packages/core/src/harness-session.ts`](../packages/core/src/harness-session.ts), [`packages/core/src/harness-session.test.ts`](../packages/core/src/harness-session.test.ts), [`packages/runtime/src/agent-session-runtime.test.ts`](../packages/runtime/src/agent-session-runtime.test.ts) | Extend provider-neutral sessions and domain-owned action families instead of adding parallel control paths. |
| Prototype 1 exclusions and phase-by-phase roadmap status | historical-prototype | [`docs/prototype-1.md`](prototype-1.md), [`docs/post-harness-roadmap.md`](post-harness-roadmap.md), [`docs/findings.md`](findings.md) | Use these for historical design evidence. Use this ledger for current routing and live Linear for current programme state. |

## Preservation Rules

- Keep `events.jsonl` as the only authoritative run history.
- Keep `@gaia/core` pure, deterministic, and serializable.
- Preserve provider-neutral sessions and capabilities, Codex wire parity,
  streamed and replayable events, domain-owned actions and receipts,
  interaction resolution, structural digests, `outcomeUnknown` no-redispatch,
  bounded recovery, and Schema-first branded contracts.
- When a later adapter fully supersedes an older path, delete the older path
  only after parity, replay, failure, and authority evidence pass at the new
  seam. Do not retain two active engines as a fallback.
- Do not infer authority from capability. Merge, deploy, destructive cleanup,
  and provider mutation remain explicitly authorized actions.

## Proof Boundary

This ledger classifies source and focused test evidence. It does not prove that
Gaia produces accepted factory outcomes. Dependency alignment, Effect-shaped
APIs, and green unit suites are inputs to later fixed-worker evaluation, not a
substitute for it.
