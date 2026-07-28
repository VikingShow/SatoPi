# Plan: Unify Swarm Dashboard & Agent Inline TUI onto System Primitives

## Overview
The swarm dashboard and persistent agent rendering use independent, duplicated rendering primitives (`panel-utils.ts`, `sato` standalone theme) instead of the system's shared TUI components (`framedBlock`, `renderStatusLine`, `theme`). Unify them onto the existing primitives, eliminate ~200 lines of dead weight, and give `agent_invoke` a real inline renderer with auto-collapse for space efficiency.

## Phase 1: Shared Rendering Contract — `SwarmPanelBlock`
**Contract:** A `framedBlock`-based panel renderer that wraps any content generator in the system's bordered-frame component, using `theme.boxRound` and `renderStatusLine`. Replaces `panel-utils.ts` entirely.

- [ ] **Task: Create `SwarmPanelBlock` shared component**
  - Files: `packages/coding-agent/src/modes/components/swarm/swarm-panel-block.ts` (new)
  - Change: Export `swarmPanel(title, contentFn, theme) => Component` — wraps `framedBlock` + `renderStatusLine` with `borderMuted` border color. Content function receives `{ innerWidth, theme }`. Box corners use system convention (`theme.boxRound`).
  - Acceptance: Unit test renders panel with "Persistent Agents" header, verifies `theme.boxRound` corners.

- [ ] **Task: Migrate `agent-panel.ts` to `SwarmPanelBlock`**
  - Files: `packages/coding-agent/src/modes/components/swarm/agent-panel.ts`
  - Change: Replace `makeHeader`/`makeFooter`/`padLine` with `swarmPanel`. Replace `sato` colors with `theme.fg()`. Replace hardcoded status glyphs with `formatStatusIcon`. Drop `formatAgentLine` padLine call.
  - Acceptance: Returns `Component`, not `string[]`. Same rows, sort order, reviewer footer. Rounded borders from `framedBlock`.

- [ ] **Task: Migrate `comm-panel.ts` to `SwarmPanelBlock`**
  - Files: `packages/coding-agent/src/modes/components/swarm/comm-panel.ts`
  - Change: `swarmPanel("Comm", (w) => renderCommRows(messages, w))`. Drop `makeHeader`/`makeFooter`/`padLine`.
  - Acceptance: Renders via `Component`. Same content, system-consistent border.

- [ ] **Task: Migrate `context-panel.ts` to `SwarmPanelBlock`**
  - Files: `packages/coding-agent/src/modes/components/swarm/context-panel.ts`
  - Change: `swarmPanel("Context", ...)`. Drop custom border helpers.
  - Acceptance: Renders via `Component`. Source list + agent context windows preserved.

- [ ] **Task: Migrate `graph-view.ts` to `SwarmPanelBlock`**
  - Files: `packages/coding-agent/src/modes/components/swarm/graph-view.ts`
  - Change: `swarmPanel("Theatre Graph", ...)`. Drop `makeHeader`/`makeFooter`/`padLine`.
  - Acceptance: Renders via `Component`. ASCII DAG preserved, border unified.

- [ ] **Task: Delete `panel-utils.ts` and `swarm-dashboard-component.ts`**
  - Files: `packages/coding-agent/src/modes/components/swarm/panel-utils.ts`, `packages/coding-agent/src/modes/components/swarm/swarm-dashboard-component.ts`
  - Change: Remove both files. `swarm-dashboard.ts` assembles panels as `Component[]`. Layout logic stays but works with `Component` children.
  - Acceptance: `bun check` passes. No references to deleted files.

## Phase 2: Delete `sato` — Panels Use `theme` Directly
**Contract:** All swarm panels read colors from `theme.fg()`. `sato` and `swarm/theme.ts` are DELETED entirely — no bridge, no rename, no partial keep. Swarm-specific colors mapped to standard theme tokens.

- [ ] **Task: Thread `theme` into swarm dashboard snapshot builder**
  - Files: `packages/coding-agent/src/modes/components/swarm/swarm-dashboard-overlay.ts`, `swarm-dashboard.ts`
  - Change: Add `theme: Theme` to `DashboardInput`. Overlay resolves theme from active TUI theme. Pass to `renderDashboard` → each panel renderer.
  - Acceptance: Dashboard honors theme changes. Light/dark switch updates dashboard without restart.

- [ ] **Task: Replace `sato` colors with `theme.fg()` in all swarm panels**
  - Files: `agent-panel.ts`, `comm-panel.ts`, `context-panel.ts`, `graph-view.ts`, `phase-view.ts` (all under `swarm/`)
  - Change: `sato.success()` → `theme.fg("success", ...)`, `sato.error()` → `theme.fg("error", ...)`, `sato.info()` → `theme.fg("accent", ...)`, `sato.dim()` → `theme.fg("dim", ...)`, `sato.muted()` → `theme.fg("muted", ...)`, `sato.purple()` → `theme.fg("accent", ...)`. Phase view maps phases to theme tokens.
  - Acceptance: No `sato` imports remain in any panel. All colors via `theme.fg()`.

- [ ] **Task: Delete `swarm/theme.ts` entirely**
  - Files: `packages/coding-agent/src/modes/components/swarm/theme.ts`
  - Change: Delete the entire file. Three content migrations: (1) `splash.ts` imports the system `PI_LOGO` from `welcome.ts` instead of `PI_LOGO_ASCII`. (2) `phaseColor()` logic inlined into `phase-view.ts` with `theme: Theme` parameter. (3) `PHASE_DISPLAY` deleted — unused duplicate of `phase-view.ts`'s own `PHASE_ICON` + `PHASE_LABEL`. `sato` / `createSatoFromTheme` / `chalk` import all deleted.
  - Acceptance: `bun check` passes. `swarm/theme.ts` gone. `splash.ts` renders same system PI logo as everywhere else. Zero swarm-specific theme files.

## Phase 3: Give `agent_invoke` an Inline Renderer + Status Bar Badge
**Contract:** Two display positions: (1) transcript inline frame with "Invoke Agent" header — mirrors task tool rendering exactly (same icons, same framed block, same collapse), and auto-dismisses 5s after the agent parks; (2) status bar badge showing "Persistent Agent: <name> <status>" when any persistent agent is running — replaces the generic `🤖 N agents` count for persistent agents.

### Position 1 — Transcript Inline Frame ("Invoke Agent")

Mirrors the `task` tool frame in every visual detail — icons (`formatStatusIcon`), border (`framedBlock` with `theme.boxRound`), status colors, expand/collapse. Header: "Invoke Agent · <profileId>". Content: profile credit score, task description, live output preview (tail 3 lines), yield tree. Four-phase lifecycle:

- **CALL**: Framed block with `[profileId]` badge + credit score + task. State = pending.
- **STREAMING**: Live updates via EventBus: spinner + tool count + token count + tail-3 output lines. Reuses `TASK_SUBAGENT_PROGRESS_CHANNEL` filtered by agent id, same `onProgress` pattern as `task/executor.ts`. State = running.
- **SETTLED**: Completion icon, duration, tool count, cost, output preview (collapsed), yield tree. Footer: "Dismissing — Agent Hub (Ctrl+S)". State = done.
- **DISMISSED (5s after settled)**: `render()` returns `[]` — zero-height, transcript gap closes. All data still in Agent Hub.

**Icons**: `formatStatusIcon("running", theme)` for spinner, `formatStatusIcon("done", theme)` for completion, `formatStatusIcon("error", theme)` for failure. Same `theme.styledSymbol("tool.task", "accent")` dispatch icon as task tool. Complete visual parity.

### Position 2 — Status Bar Badge ("Persistent Agent")


When any persistent agent is running, the status bar shows its name instead of the generic counter, using the same icon and style:

```
🤖 persist-scout running
```

When multiple persistent agents are running, fall back to count: `🤖 2 persistent agents`. When only task subagents are running, the existing `🤖 N agents` counter is shown unchanged. When nothing is running, nothing is shown.

**Implementation**: Same icon (`theme.icon.agents`), same colour (`statusLineSubagents`), same position (right side of status bar). Only the text changes — from count to name. `syncRunningSubagentBadge()` passes an optional persistent agent name to `statusLine.setSubagentCount(count, persistentName?)`.

- [ ] **Task: Add progress streaming to `agent-invoke.ts` execute()**
  - Change: After spawn, subscribe to the returned `session.subscribe()` directly — no EventBus, no SessionObserverRegistry, no new channels. Listen for `tool_execution_update` events to accumulate `AgentProgress` (tool count, tokens, recent output lines). Listen for `agent_end` to finalize. Emit partial `tool_result` signals and final `details` via tool session signal mechanism (same pattern as `task/executor.ts` `onProgress`). Return final `details` with `progress[]`, `results[]`, `profileId`, `displayName`, `kind`.
  - Acceptance: Partial results stream during execution via session-level subscription. Renderer receives live progress without any new infrastructure.

- [ ] **Task: Extract shared agent-rendering primitives from `task/render.ts`**
  - Files: `packages/coding-agent/src/task/render.ts`, `packages/coding-agent/src/tools/agent-render-utils.ts` (new)
  - Change: Move `renderAgentProgress`, `renderAgentResult`, `nestedMarkers`, `buildTreePrefix`, `formatTaskId`, `getStatusIcon`, `appendAgentStats`, `agentTypeBadge`, `orderProgressForDisplay`, `orderResultsForDisplay` into shared `agent-render-utils.ts`.
  - Acceptance: No duplicate logic. Existing task rendering unchanged.

- [ ] **Task: Create `agent-invoke-render.ts` — "Invoke Agent" frame with auto-dismiss**
  - Files: `packages/coding-agent/src/tools/agent-invoke-render.ts` (new)
  - Change: `renderCall` → `framedBlock` (header: "Invoke Agent · <profileId>", icon: `theme.styledSymbol("tool.task", "accent")`), showing profile badge, credit score, task, assignment. `renderResult` → `framedBlock` reusing shared primitives, with tail-3 output preview, yield tree. Footer after settled: "Dismissing — Agent Hub (Ctrl+S)". After 5s settled, `render()` returns `[]` (auto-dismiss). `mergeCallAndResult: true`.
  - Acceptance: Identical visual style to task tool frames. Auto-dismiss after 5s. Icons match exactly.

- [ ] **Task: Register `agent_invoke` in `toolRenderers`**
  - Files: `packages/coding-agent/src/tools/renderers.ts`
  - Change: Add `agent_invoke: agentInvokeRenderer` with `renderCall`, `renderResult`, `mergeCallAndResult: true`.
  - Acceptance: Inline frames render. Agent Hub and transcript show consistent status.

- [ ] **Task: Add persistent agent count to status bar badge**
  - Files: `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/modes/components/status-line/component.ts`, `packages/coding-agent/src/modes/running-subagent-badge.ts`
  - Change: Extend `syncRunningSubagentBadge()` to count running persistent agents and task subagents separately. Pass both counts to `statusLine.setSubagentCounts(persistentCount, subCount)`. `StatusLineComponent` renders: both > 0 → `🤖 Np·Ma` (compact combined); only persistent → `🤖 N pgent`; only subs → existing `🤖 N agents` (unchanged); neither → nothing.
  - Acceptance: `🤖 2p·3a` when both persistent and sub agents are running. `🤖 2 pgent` when only persistent. `🤖 3 agents` when only task subs. Same icon, same position, same color.

## Phase 4: Unify Swarm Agent Panel with Agent Hub
**Contract:** Swarm agent panel and Agent Hub share rendering primitives. Agent panel = compact read-only variant of Agent Hub table.

- [ ] **Task: Fix displayName overwrite bug in agent-launcher.ts**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts`
  - Change: Pass `agentDisplayName: spec.id` to `createAgentSession` (line 199). SDK fallback currently resolves to `"main"`, overwriting correct name set by `AgentRuntime` at `agent-runtime/index.ts:409`.
  - Acceptance: `AgentRegistry.global().get("planner")?.displayName === "planner"`.

- [ ] **Task: Extract `AgentRowRenderer` shared component from `agent-hub.ts` table**
  - Files: `packages/coding-agent/src/modes/components/agent-hub.ts`, `packages/coding-agent/src/modes/components/swarm/agent-panel.ts`
  - Change: Extract row rendering (status glyph + displayName + role badge + model badge + duration) using `formatStatusIcon` + `theme`. Swarm panel delegates to this, adding swarm enrichments via optional callback.
  - Acceptance: Same glyphs/colors in both views. New Hub field → auto in swarm panel.

- [ ] **Task: Make swarm agent panel header "Persistent Agents" via framedBlock**
  - Files: `packages/coding-agent/src/modes/components/swarm/agent-panel.ts`
  - Change: Header "Persistent Agents" + `[N agents, M running]` meta. Rows from shared `AgentRowRenderer` with `kind` badge (`[persistent]`/`[sub]`). Reviewer footer with verdict. Wrapped in `swarmPanel`.
  - Acceptance: Visual parity with Agent Hub. Swarm metrics preserved. `theme.boxRound` borders.

## Phase 5: Verification & Cleanup
**Contract:** All changes compile, tests pass, swarm dashboard shows "Persistent Agents" + kind badges, agent_invoke has inline frames with auto-collapse.

- [ ] **Task: Run `bun check` and fix type errors**
  - Files: All modified files
  - Change: Fix TypeScript errors from refactored imports, deleted modules, changed signatures.
  - Acceptance: `bun check` exits 0.

- [ ] **Task: Run existing swarm and task tests**
  - Files: `packages/coding-agent/src/swarm/__tests__/`, `packages/coding-agent/src/task/render.test.ts`
  - Change: Update expectations for `Component` return types and theme-based colors.
  - Acceptance: All tests pass. No coverage regression.

- [ ] **Task: Smoke test swarm dashboard rendering**
  - Files: N/A
  - Change: Verify `/swarm` overlay: all panels with correct borders/colors, "Persistent Agents" header, `kind` badges, layout at 50/80/120 cols.
  - Acceptance: Unified theme, rounded borders, correct header.

- [ ] **Task: Smoke test agent_invoke inline rendering + auto-collapse**
  - Files: N/A
  - Change: Trigger agent_invoke. Verify: profile badge + spinner + output + yield tree → auto-collapse at 30s → expand restores frame → Agent Hub consistency.
  - Acceptance: Inline TUI parity with task tool. Auto-collapse works.

- [ ] **Task: Clean up — remove dead code and update changelogs**
  - Files: `packages/coding-agent/CHANGELOG.md`
  - Change: Remove `panel-utils.ts`, `swarm-dashboard-component.ts`, `swarm/theme.ts` entirely. Changelog under `## [Unreleased]` → `### Changed`.
  - Acceptance: No dead imports. Changelog entry present.
