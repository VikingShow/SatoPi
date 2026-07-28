# Plan: Phase 3 Splash + Phase 5 Persistent Agent Hub — swarm TUI unification

## Overview
Unify the swarm TUI dashboard components under the main Theme system (modes/theme/theme.ts). Phase 3 replaces the old 41‑col PI_LOGO_ASCII block‑art with the 19‑col gradientLogo(PI_LOGO). Phase 5 rewrites agent‑panel.ts to use DynamicBorder + theme.status.* glyphs, exports STATUS_GLYPH/STATUS_COLOR, and updates swarm‑dashboard.ts to import them in renderCompact — eliminating duplicated hardcoded glyph mappings.

## Phase 1: Splash screen unification (Phase 3)

**Contract:** splash.ts renders through gradientLogo; PI_LOGO_ASCII removed from swarm/theme.ts

- [ ] **Task: Remove PI_LOGO_ASCII from swarm/theme.ts**
  - Files: `packages/coding-agent/src/modes/components/swarm/theme.ts`
  - Change: Delete the `PI_LOGO_ASCII` export (lines 116‑127) and its section header comment. Add JSDoc `@deprecated` annotation on the `sato` object to mark it for eventual removal (all other swarm panels still use it).
  - Acceptance: `theme.ts` no longer exports `PI_LOGO_ASCII`; `sato` has a `@deprecated` JSDoc tag.

- [ ] **Task: Rewrite splash.ts to use gradientLogo(PI_LOGO) from welcome.ts**
  - Files: `packages/coding-agent/src/modes/components/swarm/splash.ts`
  - Change: Replace `import { PI_LOGO_ASCII, sato } from "./theme"` with `import { gradientLogo, PI_LOGO } from "../../components/welcome"` and `import { theme } from "../../theme/theme"`. Rewrite `renderSplash()` to use `gradientLogo(PI_LOGO, 0)` for the logo block centered in the box. Use `theme.fg("accent")` for border color, `theme.fg("accent")` for the "SatoPi" text, `theme.dim(...)` for tagline/logo lines. Replace hardcoded `sato.amber`/`sato.orange`/`sato.dim` references.
  - Acceptance: `bun check` passes. `renderSplash(width)` returns gradient‑colored π‑char art instead of block‑chars.

## Phase 2: agent‑panel.ts — theme system + DynamicBorder + exports

**Contract:** agent‑panel imports from the main theme (not sato), uses DynamicBorder for borders, exports STATUS_GLYPH/STATUS_COLOR

- [ ] **Task: Rewrite agent‑panel.ts imports and colour helpers**
  - Files: `packages/coding-agent/src/modes/components/swarm/agent-panel.ts`
  - Change:
    1. **Imports**: Replace `import { makeFooter, makeHeader, padLine } from "./panel-utils"` and `import { sato } from "./theme"` with `import { DynamicBorder } from "../../dynamic-border"` and `import { theme } from "../../theme/theme"`.
    2. **STATUS_GLYPH**: Replace hardcoded Unicode glyph strings with `theme.status.*` symbols:
       - `completed` → `theme.status.success` (was "✓")
       - `running` → `theme.status.running` (was "◌")
       - `waiting` → `theme.status.shadowed` (was "○")
       - `failed` → `theme.status.error` (was "✗")
       - `pending` → `theme.status.pending` (was "·")
       - `idle` → `theme.status.done` (was "✓")
       - `parked` → `theme.status.shadowed` (was "○")
       - `aborted` → `theme.status.aborted` (was "⊘")
    3. **STATUS_COLOR**: Replace `sato.*` with `theme.fg(…)`:
       - `completed` → `theme.fg("success")`
       - `running` → `theme.fg("accent")`
       - `waiting` → `theme.fg("warning")`
       - `failed` → `theme.fg("error")`
       - `pending` → `theme.fg("muted")`
       - `idle` → `theme.fg("success")`
       - `parked` → `theme.fg("muted")`
       - `aborted` → `theme.fg("error")`
    4. **Export** both `STATUS_GLYPH` and `STATUS_COLOR` (add `export` keyword).
    5. **Panel layout**: Replace `makeHeader("Agents", w)` / `makeFooter(w)` with `new DynamicBorder(...).render(w)[0]`. Replace `padLine(content, w)` with inline content using `theme.dim(content)` for overflow truncation or `theme.fg("border")(BOX.vertical)` border wrap. Use `theme.fg("accent")` for the title "Persistent Agent Hub".
    6. **All sato.* calls**: Convert systematically:
       - `sato.dim(text)` → `theme.fg("dim", text)` (for role badges, durations, ellipsis summaries)
       - `sato.muted(text)` → `theme.fg("muted", text)` (for swarm metrics)
       - `sato.success(text)` → `theme.fg("success", text)` (for idle status label)
       - `sato.info(text)` → `theme.fg("accent", text)` (for running status label)
       - `sato.danger(text)` → `theme.fg("error", text)` (for failed status text)
    7. **Panel title**: Change from "Agents" to "Persistent Agent Hub".
    8. **emptyPanel**: Replace box‑drawing with DynamicBorder pattern.
  - Acceptance: `bun check` passes. `renderAgentPanel()` produces lines with the new DynamicBorder‑based top/bottom separators. All status glyphs come from `theme.status.*` instead of hardcoded strings. `STATUS_GLYPH` and `STATUS_COLOR` are exported.

## Phase 3: swarm‑dashboard.ts — import shared glyph maps for compact mode

**Contract:** renderCompact uses the exported STATUS_GLYPH/STATUS_COLOR from agent‑panel.ts

- [ ] **Task: Update swarm‑dashboard.ts renderCompact**
  - Files: `packages/coding-agent/src/modes/components/swarm/swarm-dashboard.ts`
  - Change:
    1. **Import** `STATUS_GLYPH` and `STATUS_COLOR` from `"./agent-panel"`.
    2. Replace `import { sato } from "./theme"` with `import { theme } from "../../theme/theme"`.
    3. **renderCompact**: Replace the inline glyph‑mapping switch (`ref.status === "running" ? "◌" : ...`) with `STATUS_GLYPH[agent.status] ?? STATUS_GLYPH.idle` and `STATUS_COLOR[agent.status](glyph)` to produce coloured glyphs.
    4. Support all states (`idle`, `parked`, `waiting`, `failed`, `aborted`, `running`, `completed`, `pending`) via the shared maps.
    5. Replace `sato.dim(...)` with `theme.fg("dim", ...)` / `theme.dim(...)`.
  - Acceptance: Compact mode renders the same glyphs as full mode for the same status. `bun check` passes.

## Phase 4: Import cleanup across remaining swarm panels

**Contract:** All swarm panels use consistent theme imports; redundant re‑exports cleaned

- [ ] **Task: Update graph‑view.ts to use exported STATUS_GLYPH/STATUS_COLOR**
  - Files: `packages/coding-agent/src/modes/components/swarm/graph-view.ts`
  - Change: Remove private `STATUS_GLYPH` and `STATUS_COLOR` constants (lines 52‑70). Import them from `"./agent-panel"` instead. Add "skipped" → `STATUS_GLYPH.idle` mapping locally if needed (or extend agent‑panel's export to include "skipped"). Replace `sato.*` with `theme.fg(…)` / `theme.dim(…)`.
  - Acceptance: Graph view renders with the same glyphs as agent panel.

- [ ] **Task: Update comm‑panel.ts to use theme imports**
  - Files: `packages/coding-agent/src/modes/components/swarm/comm-panel.ts`
  - Change: Replace `import { sato } from "./theme"` with `import { theme } from "../../theme/theme"`. Replace `makeFooter, makeHeader, padLine` with `DynamicBorder` imports. All `sato.*` → `theme.fg(…)` / `theme.dim(…)`. Panel title "Comm".
  - Acceptance: Comm panel renders with DynamicBorder separators and theme‑colored content.

- [ ] **Task: Update context‑panel.ts to use theme imports**
  - Files: `packages/coding-agent/src/modes/components/swarm/context-panel.ts`
  - Change: Same pattern — replace `sato` with `theme`, replace `panel-utils` with `DynamicBorder`. All `sato.*` → `theme.fg(…)` / `theme.dim(…)`.
  - Acceptance: Context panel renders with DynamicBorder and theme colors.

- [ ] **Task: Update phase‑view.ts to use theme imports**
  - Files: `packages/coding-agent/src/modes/components/swarm/phase-view.ts`
  - Change: Replace `import { sato } from "./theme"` with `import { theme } from "../../theme/theme"`. All `sato.*` → `theme.fg(…)` / `theme.dim(…)`. Specifically:
    - `sato.bold(sato.amber(text))` → `theme.fg("accent", theme.bold(text))`
    - `sato.dim(text)` → `theme.fg("dim", text)`
    - `sato.amber(text)` → `theme.fg("accent", text)`
  - Acceptance: Phase lifecycle bar renders with theme accent/dim colors.

- [ ] **Task: Mark swarm/theme.ts sato as deprecated**
  - Files: `packages/coding-agent/src/modes/components/swarm/theme.ts`
  - Change: Add `@deprecated Use theme fg() from "../../theme/theme" instead.` JSDoc to the `sato` export. Keep the export for backward compat during transition.
  - Acceptance: JSDoc deprecation notice present.

## Verification

- [ ] **Task: Run bun check and fix type errors**
  - Files: _(all above)_
  - Change: Run `bun check` in the coding-agent package. Fix any type errors from changed imports, missing exports, or API mismatches.
  - Acceptance: `bun check` exits clean.
