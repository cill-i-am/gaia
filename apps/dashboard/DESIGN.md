---
version: alpha
name: Gaia Dashboard
description: Operator command center for inspecting local Gaia software-factory runs.
colors:
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  surface: "oklch(1 0 0)"
  surface-muted: "oklch(0.97 0 0)"
  surface-sidebar: "oklch(0.985 0 0)"
  border: "oklch(0.922 0 0)"
  ring: "oklch(0.708 0 0)"
  primary: "oklch(0.205 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  secondary: "oklch(0.97 0 0)"
  secondary-foreground: "oklch(0.205 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
typography:
  title:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0"
  panel-heading:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0"
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0"
  label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0.02em"
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  pill: "9999px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  panel: "20rem"
  event-strip: "10rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  badge-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
    height: "20px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "4px 10px"
    height: "32px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "12px"
---

# Design System: Gaia Dashboard

## 1. Overview

**Creative North Star: "The Factory Control Room"**

Gaia Dashboard is a compact command center for a local software factory. The
surface should feel precise, spatial, and trustworthy: a place where an operator
can see a run, inspect state-machine progress, scrub events, compare two runs,
and jump from a visible claim to its supporting evidence without the UI
inventing anything.

The system is intentionally restrained. It borrows Cloudflare's canvas
discipline for relationships, Linear and Codex's quiet operator density, and
v0's crisp component confidence, but it refuses generic SaaS dashboards,
decorative analytics, and placeholder theater. The design must make real run
state easier to understand; it must not simulate agent intelligence that the
public API does not expose.

**Key Characteristics:**

- Single-screen operator workspace: Run Console, Run Canvas, Evidence Studio,
  replay, compare, provenance, and live events stay connected.
- Neutral-first command surface with state-rich badges and focused interaction.
- Borders, tonal layers, and resize seams carry structure more than shadows.
- Canvas-first spatial reasoning, with compact cards and honest unavailable
  states.
- High density, low drama: every visible element should pay rent.

## 2. Colors

The palette is a restrained neutral control-room system: black ink, white
surfaces, pale tonal panels, and one destructive semantic red for true errors.

### Primary

- **Command Ink** (`primary`): the only primary action surface. Use it for the
  active provenance toggle, selected artifact chips, and actions that commit the
  operator's attention. Its rarity is the point.

### Secondary

- **Tonal Control** (`secondary`): the standard non-primary status surface for
  badges, selected-but-not-commanding states, and active tab panels.

### Neutral

- **Workspace White** (`background`, `surface`): the main canvas and panel
  field. It keeps dense data legible and avoids dark-mode theater.
- **Muted Instrument Layer** (`surface-muted`): low-emphasis zones such as
  canvas floor, empty-state icon wells, skeletons, and evidence source rows.
- **Console Rail** (`surface-sidebar`): the left run console surface. It is
  slightly separated from the main workspace but not decorative.
- **Precision Border** (`border`): the primary separator between console,
  canvas, studio, event strip, rows, and claim cards.
- **Soft Focus Ring** (`ring`): focus and active evidence affordance. It should
  be visible without becoming a glow effect.
- **Operator Gray** (`muted-foreground`): metadata, timestamps, helper text, and
  secondary labels. Use only where contrast stays comfortably readable.
- **Diagnostic Red** (`destructive`): error, unavailable API state, or destructive
  semantic emphasis only.

### Named Rules

**The Real Signal Rule.** Color marks state, selection, evidence, or failure.
Never use color as decoration.

**The One Accent Rule.** Command Ink is the accent. Do not add purple, blue, or
gradient accents to make the app feel more "AI".

## 3. Typography

**Display Font:** None.
**Body Font:** Geist Variable with `sans-serif` fallback.
**Label/Mono Font:** Geist Variable for labels; system monospace only inside
raw JSON/code evidence.

**Character:** The type system is product-native and compact. It uses one
well-tuned sans for headings, labels, buttons, and dense run data so the
operator can scan without switching visual languages.

### Hierarchy

- **Title** (600, 16px, 1.5): product title, selected run title, and primary
  run-row names.
- **Panel Heading** (600, 14px, 1.4): Run Canvas, Evidence Studio, replay, and
  compare headings.
- **Body** (400, 14px, 1.45): normal controls, row copy, source descriptions,
  and panel content.
- **Label** (500, 12px, 1.35, occasional uppercase): section labels, metadata,
  status captions, and compact control labels.
- **Data** (400, 12px, 1.5): raw JSON and payload inspection only.

### Named Rules

**The No Display Type Rule.** This is an operator tool, not a landing page.
Large display headlines and fluid hero typography are prohibited.

**The Label Discipline Rule.** Uppercase labels are allowed for small structural
headers only. They must not become decorative eyebrows.

## 4. Elevation

Depth is conveyed through tonal layers, borders, resize handles, selected states,
and focus rings. The default surface is flat. Shadows are rare and structural:
Base UI sheets may lift above the page, and active tabs or floating sidebars may
use a shallow `shadow-sm`, but command-center panels should not float as cards.

### Shadow Vocabulary

- **State Lift** (`shadow-sm`): active tabs or floating sidebar shells only.
- **Overlay Lift** (`shadow-lg`): mobile sheets and overlay surfaces only.
- **Focus Ring** (`ring: 3px color-mix...`): interactive focus, invalid input,
  and active evidence event state.

### Named Rules

**The Flat-By-Default Rule.** A panel at rest gets a border or tonal layer, not a
drop shadow.

**The No Ghost Card Rule.** Do not pair a one-pixel border with a soft decorative
shadow on dashboard panels.

## 5. Components

### Buttons

- **Shape:** gently curved operator controls (10px radius by default, 6-8px for
  extra-small controls).
- **Primary:** Command Ink background with white text, 32px height, compact
  horizontal padding. Use for current selection or primary action only.
- **Outline:** white background, Precision Border, foreground text, muted hover.
  This is the default utility/action button.
- **Secondary / Ghost / Destructive:** secondary stays tonal, ghost is hover-only,
  destructive uses transparent Diagnostic Red backgrounds. Never make inactive
  states saturated.
- **Hover / Focus:** hover is tonal, active nudges 1px, focus uses a visible
  three-pixel ring. Do not add animated choreography.

### Chips

- **Style:** pill badges at 20px height with 12px labels. Secondary badges mark
  supported/known states; outline badges mark counts, unavailable data, or
  secondary facts.
- **State:** badge variants must map to real status, health, evidence, or
  availability. A badge that does not encode a claim should be removed.

### Cards / Containers

- **Corner Style:** compact cards use 8px radius; larger empty states may use
  14px. Do not exceed this unless the element is a pill.
- **Background:** normal cards use Workspace White; contextual source rows can
  use Muted Instrument Layer at low opacity.
- **Shadow Strategy:** flat by default; use borders and tonal contrast.
- **Border:** one-pixel Precision Border is the standard container edge.
- **Internal Padding:** dense rows use 8px; evidence cards use 12px; empty states
  can use 24px.

### Inputs / Fields

- **Style:** 32px height, 10px radius, transparent or Workspace White background,
  one-pixel input border, compact 10px horizontal padding.
- **Focus:** border shifts to Soft Focus Ring and adds a three-pixel focus ring.
- **Error / Disabled:** invalid state uses Diagnostic Red; disabled state reduces
  opacity and keeps layout stable.

### Navigation

- **Run Console:** the left rail is a fixed 20rem command list on desktop and a
  stacked 34svh region on narrower screens.
- **Rows:** run rows are button-like list items, not cards. Active rows use the
  sidebar accent state and font weight; metadata stays secondary.
- **Tabs:** Evidence Studio tabs use the line variant, compact text, and a
  one-pixel active underline. Tab content should not shift panel geometry.
- **Responsive:** desktop uses resizable panels. Narrow viewports stack Console,
  top controls, Canvas, Evidence Studio, and Event Strip with vertical scroll,
  never horizontal overflow.

### Run Canvas

The React Flow canvas is the signature component. It should feel like a precise
system map: compact operational nodes, clear edges, muted canvas floor, and
selected/provenance states that reveal evidence without inventing relationships.
Unknown agent/thread relationships must be labelled unavailable rather than
faked.

### Evidence Studio

Evidence Studio is the proof surface. It uses tabs, scroll areas, claim cards,
source rows, and raw JSON blocks to connect visible dashboard claims to public
events, artifacts, reports, or API fields. Provenance actions must navigate to a
real supporting source.

## 6. Do's and Don'ts

### Do:

- **Do** keep the dashboard as a single-screen operator workspace.
- **Do** use the Run Canvas as the spatial center when relationship data exists.
- **Do** show unsupported or unavailable claims honestly.
- **Do** use badges only for real state, counts, evidence, health, or
  availability.
- **Do** preserve keyboard focus, visible rings, and WCAG AA text contrast.
- **Do** prefer dense rows, separators, and resizable panels over decorative
  cards.
- **Do** keep future harness selection visible as product direction without
  implementing fake controls before the API exists.

### Don't:

- **Don't** make this a generic SaaS dashboard.
- **Don't** create card soup.
- **Don't** show fake metrics, fake data, placeholder theater, or invented hidden
  agent state.
- **Don't** use terminal cosplay.
- **Don't** add redundant information just to fill space.
- **Don't** add gradient text, purple AI glow, glassmorphism, bokeh, or decorative
  grid backgrounds outside the actual canvas.
- **Don't** change server/API behavior during UI polish.
- **Don't** expose hidden `.gaia` state, private filesystem paths, or raw hidden
  reasoning as a visual shortcut.
