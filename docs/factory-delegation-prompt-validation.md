# Factory Delegation Prompt Validation

Gaia factory lane prompts should be validated before dispatch. This checklist is
the human-readable companion to the typed
`FactoryDelegationPromptValidation` artifact in `@gaia/core`; existing repo
workflow docs and root `AGENTS.md` remain the canonical operating rules.

## Lane Roles

Every prompt must declare exactly one lane role:

- `direct-fallback`: a conventional implementation lane used as a fallback or
  comparison lane.
- `gaia-dogfood`: a Gaia-backed implementation lane that must capture dogfood
  evidence.
- `reviewer-spec`: a read-only reviewer/spec lane.
- `ci-watch`: a PR checks and comments watcher lane.
- `orchestrator`: a coordination lane that owns dispatch, comparison, and final
  acceptance.

## Checklist

Before dispatch, the orchestrator should record the validation result and block
the lane when any blocker appears.

- Confirm the declared lane role matches the prompt body.
- Confirm dogfood evidence requirements appear only on `gaia-dogfood` lanes.
- For `gaia-dogfood` lanes, require Gaia run IDs or run artifact evidence, a
  dogfood retrospective or factory-retro artifact, and promotion of selected
  evidence to Linear or PR text before cleanup.
- For A/B comparison lanes, require the base commit, isolated worktree and
  branch expectations, cleanup rules for generated `.gaia` state, and whether
  comparison waits for both PRs.
- Keep the validation output inspectable: lane role, status, version, and
  finding codes are suitable for Linear comments and PR evidence.

## Acceptance Examples

These examples are intentionally small so they can remain stable as the factory
loop evolves.

- A direct fallback prompt that asks for Gaia dogfood run IDs or a dogfood
  retrospective fails with
  `dogfood-requirement-on-non-dogfood-lane`.
- A Gaia dogfood prompt that does not ask for Gaia run IDs, a dogfood
  retrospective, or promoted Linear/PR evidence fails before dispatch.
- An A/B lane prompt without base commit, cleanup, or comparison-wait guidance
  fails before dispatch.
- A prompt whose body does not declare the selected role fails with
  `lane-role-missing`.
- A prompt with more than one `Lane role:` declaration fails with
  `lane-role-conflict`.

## Artifact Shape

```json
{
  "version": 1,
  "laneRole": "gaia-dogfood",
  "status": "failed",
  "findings": [
    {
      "code": "dogfood-run-evidence-missing",
      "severity": "blocker",
      "message": "Gaia dogfood lanes must require Gaia run IDs or run artifact evidence."
    }
  ]
}
```
