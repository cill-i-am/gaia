# Product

## Register

product

## Users

Gaia Dashboard is for operators building, inspecting, and debugging Gaia's
local-first software factory. They are technical users who need to understand
what the factory is doing now, what a run has already done, which state machine
phase it is in, what each participating agent or harness lane appears to be
doing, and which events or artifacts support those claims.

The primary context is active local development and review. Users should be able
to move from run list to selected run to canvas node to supporting evidence
without leaving the command surface or trusting invented state.

## Product Purpose

Gaia Dashboard is the operator command center for the Gaia software factory. It
shows runs, selected run state, run state-machine progress, agent or harness
lanes where public data supports them, ordered events, artifacts, evidence,
provenance, replay position, and run-to-run comparison.

Success means the dashboard makes Gaia runs inspectable, trustworthy, and easy
to compare without replacing the server as the source of truth. The dashboard is
a client over the public LocalGaiaServerApi; it should not smuggle in private
filesystem reads, fake projections, or dashboard-owned workflow logic.

Future versions may create runs and select harnesses or harness roles for
planning, implementation, review, and related stages across Codex, Claude Code,
Cursor, Py, and other adapters. That future should be visible as a product
direction, but the current design authority is clear inspection over real data.

## Brand Personality

Precise, spatial, trustworthy.

The interface should feel like a high-signal command center: calm enough for
long debugging sessions, crisp enough to make dense run information scannable,
and spatial enough that relationships between orchestration, workers,
reviewers, events, and artifacts can be understood at a glance.

Reference energy:

- Cloudflare's canvas-style worker surfaces for spatial system composition.
- v0 and Linear agent surfaces for clean information density and confident UI
  restraint.
- Codex UI for quiet focus, legibility, and low-friction operator workflows.

## Anti-references

- No generic SaaS dashboard.
- No card soup.
- No fake metrics, fake data, placeholder theater, or invented hidden agent
  state.
- No terminal cosplay.
- No redundant information just to fill space.
- No overcomplicated control schemes when the existing run data already carries
  enough signal.
- No UI polish that changes server/API behavior or hides product gaps.

## Design Principles

- Command center, not dashboard template.
- Evidence before decoration.
- Spatial relationships earn the center of the screen.
- Dense information with low cognitive noise.
- Honest capability beats simulated intelligence.
- Preserve the single-screen flow: Run Console, Run Canvas, Evidence Studio,
  replay, compare, provenance, and live events should feel like parts of one
  operator workspace.

## Accessibility & Inclusion

Target WCAG AA contrast for text and controls. Controls should be keyboard
reachable, focus states visible, and status should never rely on color alone.
Motion should communicate state and respect reduced-motion preferences.

Responsive behavior must preserve access to the Run Console, Run Canvas,
Evidence Studio, replay scrubber, run compare workflow, provenance mode, and
live event strip on narrow viewports without horizontal overflow or clipped
content.
