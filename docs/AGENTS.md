# Docs Intent

`docs/*` contains product, architecture, roadmap, and findings documents. Docs
are allowed to describe future product direction, but implementation should
still move through thin, explicit slices.

## Docs Rules

- `vision.md` is the holistic product direction. Break it into phase specs and
  grill those specs before turning them into implementation.
- `roadmap.md` is the delivery ledger. Keep slices small, testable, and
  reversible.
- `findings.md` records completed slice outcomes and verification evidence.
  Append new findings instead of rewriting history unless the user asks.
- `operator-model.md` records command authority and read-model decisions. Keep
  server/API planning in phase specs rather than turning this doc into an API
  contract.
- `agents/*` contains the repo-local operating docs used by Linear-native agent
  skills. Refresh those files from the `linear-setup` bundled templates, then
  patch only stable Gaia-specific pointers. Keep live Linear team/status/label
  data in Linear, not in docs.
- Architecture docs should state tradeoffs and rejected options when they
  explain a durable decision.
