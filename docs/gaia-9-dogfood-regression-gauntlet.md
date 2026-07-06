# GAIA-9 Dogfood Regression Gauntlet

Date: 2026-07-06

Issue: GAIA-9 Run Gaia Dogfood Regression Gauntlet Before Next Slice

## Verdict

Gaia is ready to be used again as an A/B dogfood implementation lane for the
next slice, with one operator caveat: live PR-loop evidence can still end in a
human waiting state when the selected PR has no checks and no reviews. That
state is now explicit, bounded, and Linear-ready rather than silent.

No live `publish-workspace-pr` command was run. Workspace PR publishing was
covered through `preview-pr --workspace` plus focused runtime fixtures that
exercise the same pre-publish gate before mutation.

## Live Gaia Runs

Fresh local runs completed in this worktree:

- `run-HDoscuZqaj`: `pnpm gaia run examples/specs/smoke.md --json`
- `run-yzPccZzar2`: `pnpm gaia run examples/specs/smoke.md --harness fake --json`
- `run-RCFTIDm4b7`: `pnpm gaia run examples/specs/smoke.md --harness process --harness-command node --harness-arg "$PWD/examples/harnesses/process-harness.mjs" --json`
- `run-fcS-vrgwl_`: `pnpm gaia run examples/specs/smoke.md --workspace-source . --json`

`run-fcS-vrgwl_` was used for the hardened-path inspection because it exercised
workspace copying, resumability, workspace PR preview, check recording, PR-loop
recording, and dogfood retrospective generation.

## Live Artifact Evidence

Artifacts inspected for `run-fcS-vrgwl_`:

- `worker-plan.md` and `worker-plan.json`: spec-derived plan lists acceptance
  criteria, non-goals, likely touched surfaces, verification, stop conditions,
  steps, expected artifacts, and source spec.
- `worker-result.json`: 559 bytes. It reports `changedWorkspacePaths:
  ["output.txt"]` and a `workspaceDiff` with one product changed path and zero
  omitted generated paths.
- `workspace-pr-gate.json`: 434 bytes. Status `passed`, `failItemCount: 0`,
  with `workspace-diff-reviewable` passing for `output.txt`.
- `report.md`: 802 bytes.
- `github-checks/checks-13.json`: terminal `no-checks` for existing draft PR
  #1, recorded as read-only evidence.
- `ci-watch-state.json`: 309 bytes, terminal with `nextAction: complete`.
- `github-feedback.json`: 539 bytes, `awaiting-review`, no comments or reviews.
- `pr-loop-state.json`: 541 bytes, `status: waiting`,
  `nextAction: await-review`, one `awaiting-review` blocker.
- `dogfood-retrospective.json`: 7,314 bytes, status `findings`, two findings,
  and two Linear-ready candidates with goal, acceptance criteria, source
  evidence, and a note that Gaia did not mutate Linear.

Generated path inspection found no `node_modules`, `dist`, `.turbo`, or local
absolute path dumps in `worker-result.json`, `report.md`,
`workspace-pr-gate.json`, `dogfood-retrospective.json`, or
`pr-loop-state.json`.

## No-Mutation Publish Proof

`pnpm gaia preview-pr run-fcS-vrgwl_ --workspace --json` returned status
`preview`, branch `gaia/run-fcS-vrgwl_-workspace`, evidence path
`gaia-runs/run-fcS-vrgwl_`, and a passed `workspace-pr-gate.json`. The command
listed the eventual `git` and `gh` commands but did not execute checkout,
commit, push, or PR creation.

Focused runtime fixtures passed for seeded GAIA-1/GAIA-2 regressions:

- `writes a spec-derived worker plan for review`
- `classifies repeated generic plan blockers consistently`
- `emits Linear-ready candidates for noisy evidence and pre-publish failures`
- `summarizes generated workspace churn in harness evidence`
- `previews a workspace PR with blocked gate results for giant worker-result evidence`
- `refuses to publish a workspace PR when changed source casts as RunId`
- `refuses to publish a workspace PR when changed source casts as RunId inside template interpolation`
- `refuses to publish a workspace PR when omitted generated paths are unsafe`
- `refuses to publish a workspace PR when changedWorkspacePaths are unsafe`
- `refuses to publish a workspace PR when worker-result resultPath is unsafe`
- `refuses to publish a workspace PR when outputArtifacts contain unsafe workspace paths`
- `reports invalid worker-result JSON as a gate failure before workspace PR mutation`

These cover the generic-plan blocker, noisy/generated evidence, unsafe
`worker-result` paths, invalid `worker-result.json`, and the GAIA-2 branded
`RunId` cast risk without live GitHub mutation.

## Codex Progress Proof

Focused runtime fixtures passed for Codex harness progress and stall evidence:

- `runs the Codex harness through the workflow seam`
- `records timed-out Codex harness progress before failing the run`
- `records missing last-message Codex progress before failing the run`

Together these prove `codex-harness-progress.json` is written for successful
Codex runs, timed-out runs with `stallClassification: "no-progress"`, and
missing last-message failures with observed output and
`stallClassification: "progress-observed"`.

## PR-Loop Proof

Live read-only PR-loop evidence used existing draft PR #1
(`https://github.com/cill-i-am/gaia/pull/1`) as the selector. Gaia recorded
`no-checks` and `awaiting-review` without mutating GitHub state.

Focused runtime fixtures passed for lock safety and idempotence:

- `refuses to record GitHub checks while the run store is locked`
- `reports the active PR-loop operation when the run store is locked`
- `reuses GitHub check evidence for the same run, PR, and head`
- `reuses PR-loop evidence for the same run, PR, and head`
- `coordinates changes requested and failed CI as ordered blockers`

## Verification Commands

Passed:

- `pnpm install --frozen-lockfile`
- `pnpm check`
- `pnpm test`
- `pnpm build`
- `pnpm gaia doctor`
- `pnpm gaia run examples/specs/smoke.md --json`
- `pnpm gaia run examples/specs/smoke.md --harness fake --json`
- `pnpm gaia run examples/specs/smoke.md --harness process --harness-command node --harness-arg "$PWD/examples/harnesses/process-harness.mjs" --json`
- `pnpm gaia run examples/specs/smoke.md --workspace-source . --json`
- `pnpm gaia status --json`
- `pnpm gaia list --json`
- `pnpm gaia resume run-fcS-vrgwl_ --json`
- `pnpm gaia preview-pr run-fcS-vrgwl_ --workspace --json`
- `pnpm gaia pr-checks 1 --json`
- `pnpm gaia checks run-fcS-vrgwl_ 1 --json`
- `pnpm gaia pr-loop run-fcS-vrgwl_ 1 --json`
- `pnpm --filter @gaia/runtime exec vitest run src/runtime.test.ts -t "runs the Codex harness through the workflow seam|records timed-out Codex harness progress before failing the run|records missing last-message Codex progress before failing the run" --reporter=verbose`
- `pnpm --filter @gaia/runtime exec vitest run src/runtime.test.ts -t "writes a spec-derived worker plan for review|classifies repeated generic plan blockers consistently|emits Linear-ready candidates for noisy evidence and pre-publish failures|summarizes generated workspace churn in harness evidence|previews a workspace PR with blocked gate results for giant worker-result evidence|refuses to publish a workspace PR when changed source casts as RunId|refuses to publish a workspace PR when changed source casts as RunId inside template interpolation|refuses to publish a workspace PR when omitted generated paths are unsafe|refuses to publish a workspace PR when changedWorkspacePaths are unsafe|refuses to publish a workspace PR when worker-result resultPath is unsafe|refuses to publish a workspace PR when outputArtifacts contain unsafe workspace paths|reports invalid worker-result JSON as a gate failure before workspace PR mutation|refuses to record GitHub checks while the run store is locked|reports the active PR-loop operation when the run store is locked|reuses GitHub check evidence for the same run, PR, and head|reuses PR-loop evidence for the same run, PR, and head|coordinates changes requested and failed CI as ordered blockers" --reporter=verbose`

## Cleanup

Generated `.gaia/` run state was removed after recording this evidence summary.
The committed payload is this bounded document only.

## Residual Risks

- Existing PR #1 has no checks and no review decision, so live PR-loop evidence
  ends in `waiting` rather than merge-ready. This is acceptable for GAIA-9
  because the waiting state is explicit and no mutation was required.
- This gauntlet proves the local deterministic and fixture-backed hardened loop.
  The next live A/B dogfood run should still treat its Gaia lane as supervised
  until a real implementation PR reaches reviewed/green evidence.
