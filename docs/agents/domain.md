# Domain Docs

Use domain docs to preserve product intent that should outlive one issue or PR.

## Where Durable Intent Lives

- Product goals and accepted behavior live in Linear Project or PRD documents.
- Gaia's holistic product direction lives in `docs/vision.md`; implementation
  slices belong in `docs/roadmap.md`, `docs/post-harness-roadmap.md`, Linear
  Projects/PRDs, or narrow phase specs.
- Gaia command authority and read-model decisions live in
  `docs/operator-model.md`.
- Architecture decisions with long-term consequences should get an ADR or durable doc.
- Repo instruction rules live in `AGENTS.md` at the nearest semantic scope.
- Feature-specific facts can live beside the feature when they are only useful there.

## Domain Doc Rules

- Keep product language separate from implementation chores.
- Name the user, actor, or system boundary involved.
- Record constraints and rejected alternatives when they explain future choices.
- Keep domain terms stable. Rename terms deliberately across docs, code, and issues.

## Avoid

- turning every small code change into an ADR
- burying durable product decisions only in PR comments
- copying the same intent across multiple docs
