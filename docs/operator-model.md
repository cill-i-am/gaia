# Gaia Operator Model

This document records the operational decisions that are useful before the
local server/product phase. It is not a server API spec.

## Read Model

`events.jsonl` remains the source of truth for a run. Snapshots, reports, PR
loop state, browser evidence, Linear graphs, and merge decisions are derived or
attached evidence.

For the first local server/dashboard slice, prefer an in-memory run index
derived from the filesystem at startup and refreshed from run artifacts. Do not
introduce SQLite until the UI needs durable cross-run queries, pagination,
filtering, or fast incremental reconciliation.

Reasoning:

- the current run store is small and intentionally inspectable;
- replaying artifacts keeps the server honest about event-log authority;
- SQLite too early would create a second persistence concern before the product
  shape is proven.

## Command Authority Levels

Commands should make their authority obvious. A future UI or orchestrator should
surface the same levels.

| Level | Meaning | Current commands |
| --- | --- | --- |
| Read-only | Inspect local or external state without writing artifacts or mutating external systems. | `status`, `list`, `pr-checks`, `doctor` |
| Local artifact writing | Write `.gaia` run evidence only. | `run`, `resume`, `collect-browser-evidence`, `checks`, `watch-ci`, `watch-pr-feedback`, `pr-loop`, `plan-remediation`, `linear-issue`, `merge-decision` |
| External mutation | Mutate GitHub, but not merge or deploy. | `publish-pr`, `publish-workspace-pr`, `comment-pr` |
| Future destructive authority | Merge, deploy, destroy, rollback, or clean up remote resources. | Not implemented |

`merge-decision` intentionally returns `ready-to-merge`, not `merge-pr`. The
artifact records that Gaia's evidence gate is clear, but it does not perform
the merge.

## Local Paired-Review Attestation

An explicit local-operator action may attest that a paired exact-head review
was approved when repository constraints make a GitHub approval impossible.
This is audited Gaia operator authority. It is not a GitHub approval, a live
Linear synchronization, external evidence verification, or verification of a
reviewer's identity.

The event log stores only a bounded Gaia evidence ID, an optional correlation
digest, and the exact run, immutable publication generation, current delivery
authority, pull-request tuple, head, and ready-confirmation binding. It does
not store provider URLs or IDs, review text, identities, local paths, or
session identifiers. A later confirmed remediation leaves the old attestation
as historical audit evidence but prevents its use for current readiness.

Strict review policy continues to accept GitHub `APPROVED`. GitHub
`CHANGES_REQUESTED` always blocks, and unknown review values fail closed. Only
an absent or `REVIEW_REQUIRED` aggregate decision may use a confirmed current
local attestation. Merge readiness records which source satisfied the policy,
and merge revalidates that exact source with fresh pull-request state before
recording merge intent.

## Claim Verification Authority

V2 claim verification is an explicit server action, not an implicit side
effect of reading a run. The public surface has exactly two mutations:
`startPostPublicationGeneration` and `reconcileOutcomeUnknown`. The server owns
the complete non-reentrant run epoch; the protocol client does not read or
append `.gaia` state and the dashboard gains no verification mutation.

The production executor may use only the checked-in claim-verification profile.
It cannot accept source-selected provider flags, images, policies, credentials,
network exceptions, absolute executables, or a host-process fallback. After a
provider dispatch becomes uncertain, Gaia records or reports that uncertainty
and requires an exact identity-bound reconciliation action. It does not retry
or redispatch the command.

This capability still grants no merge, deploy, daemon-policy, provider-config,
secret, or global cleanup authority. Those remain separate explicit operator
decisions.

## Demo Fixtures

Portable examples live under `examples/*`.

- `examples/specs/factory-demo.md` is a richer local run spec for demos.
- `examples/linear/issue-graph.json` can be attached with
  `gaia linear-issue <run-id> examples/linear/issue-graph.json`.
- `examples/github/pr-loop-state.ready.json` documents the shape of a clean PR
  loop state without requiring GitHub.

These fixtures are intentionally static. They make docs, tests, and demos easier
without becoming a second source of truth for real runs.
