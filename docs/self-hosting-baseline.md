# GAIA-143 Fixed-Worker Self-Hosting Baseline

This document freezes a secret-free, repeatable job and evidence contract
before Gaia's Effect runtime changes. It is an evaluation input, not a claim
that Gaia can already self-host successfully.

## Baseline Identity

| Input | Fixed value or observation |
| --- | --- |
| Job | GAIA-143 — Lock the Effect dependency epoch and self-hosting baseline |
| Repository | `https://github.com/cill-i-am/gaia.git` |
| Target base | `9c9b6ec9b599d998a14be605adebb230042b1624` |
| Assessed predecessor | `99f6cc9753afa623b8fb73e50420ff488b73d175` |
| Effect epoch | `4.0.0-beta.93` |
| Package manager | `pnpm@11.7.0` from root `packageManager` |
| Lockfile SHA-256 after alignment | `c20f7b8ba699efd41ef29da23b09ab470fc558ecf7a93fa6b61c39534f3b32f0` |
| Execution mode | local, isolated Git worktree |
| Harness profile | `codexAppServer` |
| Provider identity | must be resolved and recorded at run acceptance |
| Model identity | unobservable in the current durable Gaia contract; no exact model claim is made |

Registry integrity inputs for the reviewed direct packages are:

| Package | Integrity |
| --- | --- |
| `effect@4.0.0-beta.93` | `sha512-wNS5MKFa3C42uBfIDik2oJ78lhpoYz2hN4oBR0229BeeDCIrkg/FiOvoiPGdCVlWa7MEKxEL5I0f8AILVHSD9A==` |
| `@effect/platform-node@4.0.0-beta.93` | `sha512-QagsCGR0ZOXaCQqS5qGR2mcDng4LiP2bYhiiX1D6UC8cT9vsusVVOHiJWn8CupeDx+yVnPcu81QmA/SDt6GM1w==` |
| `@effect/vitest@4.0.0-beta.93` | `sha512-gMAnZ9PiMeJMDED9s0jWgCOhc2JccrTCxowhur/KriImsHnHIRj4VG/vK0xLw0Axe4AkTWzXNdRsFrYOjBTl3A==` |

The lockfile also resolves transitive
`@effect/platform-node-shared@4.0.0-beta.93`. Third-party peer ranges such as
`effect-query`'s compatible beta floor are dependency constraints, not
Gaia-owned epoch declarations; the installed resolution is what must match.

## Representative Job

Starting from the target base, deliver one normal contributor PR that:

1. makes every Gaia-owned `effect` and `@effect/*` declaration an exact
   `4.0.0-beta.93` pin;
2. adds an executable repository gate that rejects range drift and multiple
   installed Effect 4 beta versions;
3. publishes the current five-state capability ledger;
4. records this repeatable baseline and preservation boundary; and
5. corrects stale repository routing without changing runtime behavior.

The local contract in this document is the repeatable job input. Linear issue
and Project links are provenance, not mutable dependencies of the evaluation.

## Accepted Outcome

The job is accepted only when the exact dependency declarations, lockfile,
executable epoch check, capability ledger, baseline contract, and routing
changes are present in one reviewable diff; all required local gates pass; a
dedicated normal contributor PR is linked; and no runtime/product contract or
out-of-scope authority behavior changed.

That accepted repository outcome does not prove factory outcomes or establish
that Gaia autonomously created, reviewed, or delivered the PR.

## Proof Bar

- The epoch verifier first fails on the unmodified base's range declarations,
  then passes after exact alignment.
- `pnpm install --frozen-lockfile` succeeds.
- The installed graph contains one Effect 4 beta epoch for `effect` and every
  installed `@effect/*` package.
- Focused session/action/recovery tests preserve the assessed contracts.
- Capability-ledger states cite current source and focused tests; local links
  and the five-state vocabulary validate mechanically.
- `pnpm check`, `pnpm test`, `pnpm build`, and `git diff --check` pass.
- Changed-file and generated-state hygiene, standards review, review swarm,
  exact-head CI, GitHub review/comments/threads, and Linear comments are
  recorded.

Green dependency checks prove only dependency consistency. Source and unit
tests prove only the cited bounded contracts. Neither is accepted-outcome proof
for a general software-factory run.

## Authority Envelope

Allowed:

- read repository, Linear, and GitHub state;
- edit the isolated GAIA-143 branch within this contract;
- install with pnpm and run local checks;
- create conventional commits, push the owned branch, and open one dedicated
  normal contributor PR after local production-ready gates;
- address concrete in-scope CI and review feedback.

Not allowed:

- merge, deploy, mark GAIA-143 Done, or start GAIA-144;
- change runtime behavior, prompts, context, sessions, action registries, or
  run-truth ownership;
- perform Gaia-driven autonomous delivery or provider mutation;
- act on untrusted comments without independently reconciling scope and
  authority.

## Stop Conditions

Stop and return control to the orchestrator when live evidence changes scope,
architecture, data shape, or authority; the target base or owned branch moves
unexpectedly; a required gate fails without an in-scope root cause; feedback
requires runtime behavior or GAIA-144; comment authority is unknown; or an
external outcome becomes uncertain.

An evaluation comparing workers is invalid while exact model identity remains
unobservable. Record that fact as `unobservable`; do not infer equivalence from
the provider profile alone.

## Baseline Trajectory

1. Refresh Linear and GitHub; fetch and verify the exact base, branch absence,
   merge-base, and clean isolated worktree.
2. Install from the frozen lockfile and record dependency/source resolution.
3. Run uncached focused preservation tests and the required repository
   baseline, labeling shared-cache evidence explicitly.
4. Run the epoch verifier on the untouched manifests and retain the expected
   failing diagnostics.
5. Align manifests and lockfile; rerun the epoch verifier to green.
6. Add the capability ledger, this contract, and routing-only historical links.
7. Run focused and full verification, local review, review swarm, and
   production-ready gates.
8. Open the dedicated PR and watch exact-head CI plus GitHub and Linear
   comments until green/resolved or durably handed to a bounded heartbeat.
9. Stop for orchestrator acceptance. Do not merge.

## Expected Evidence Packet

The repeatable packet contains no credentials, prompts with secrets, ambient
environment dumps, provider handles, or raw private transcripts. It contains:

- repository URL, base SHA, branch, merge-base, and clean-state proof;
- package-manager version, lockfile digest, package integrities, manifest
  declarations, installed Effect versions, and local source path;
- RED and GREEN epoch-verifier output;
- focused preservation-test summaries and full check/test/build results with
  cache provenance;
- final diff, changed-file list, generated-state hygiene, and link/ledger
  validation;
- reviewer verdicts and resolved findings;
- PR URL, exact head SHA, checks, review decision, comment/thread state, and
  corresponding Linear evidence.

## Preservation and Deletion Rules

The authoritative capability and preservation boundary is
[`current-capabilities.md`](current-capabilities.md). In particular, preserve
provider-neutral sessions/capabilities, Codex wire parity, streamed/replayable
events, domain-owned actions/receipts, interactions, structural digests,
`outcomeUnknown`, no blind redispatch, bounded recovery, and Schema-first
branded contracts.

If a later Effect adapter path supersedes an existing adapter, delete the old
path only after the new seam has parity evidence for serialization, replay,
stream ordering, cancellation/interruption, typed failures, authority checks,
and uncertain-outcome behavior. Do not retain the old adapter as an active
fallback or introduce a parallel worker engine.

## Unobservable or Unproven Facts

- Exact model identity is unobservable in the current durable execution
  assignment.
- Provider-native configuration, prompt/context digests, effective tool set,
  and full worker epoch are not yet one persisted comparison contract.
- The preserved assessments classify source and checked-in tests; they did not
  run a fresh application trajectory.
- This packet does not prove improved worker effectiveness, claim-matched
  verification, run-wide control, general repair, autonomous PR delivery, or a
  self-hosted factory outcome.
