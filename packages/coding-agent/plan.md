# Plan: Fix Theme Description, PI_LOGO Animation, Agent Panel, and All Type Errors

## Overview
Four independent issues: (1) "Match terminal" setup wizard description says "Satopi" but the preview may show a different theme like "Titanium"; (2) the setup splash animation shows a clipped large PI_LOGO fragment in its second frame on smaller terminals; (3) the swarm "Persistent Agents" panel shows "No agents" when subagents are running, because it filters to only `kind === "persistent"`; (4) 145 TypeScript errors across the codebase need complete resolution.

## Phase 1: Fix Theme Description Mismatch
**Contract:** The "Match terminal" option's description must match the default auto-detection theme. When the user has previously selected a non-default dark theme (e.g. Titanium), the description should reflect the actual auto-mapping, not hardcode "Satopi".

- [ ] **Task: Fix CURATED_ITEMS description in theme.ts**
  - Files: `src/modes/setup-wizard/scenes/theme.ts`
  - Change: Read `getCurrentThemeName()` at scene construction time to determine the actual auto-dark theme name. Update the `description` field of the "Match terminal" CURATED_ITEM to say `"${autoDarkName} in dark terminals, ${autoLightName} in light terminals"` instead of hardcoded `"Satopi in dark terminals, Light in light terminals"`.
  - Acceptance: The "Match terminal" description shows the actual theme names that auto-detection maps to, not a hardcoded string. If auto-dark is set to "titanium", the description says "Titanium in dark terminals".
  - Depends: none

- [ ] **Task: Fix default autoDarkTheme to match description**
  - Files: `src/modes/theme/theme.ts`
  - Change: At line 2220, change `autoDarkTheme = darkTheme ?? "dark"` to `autoDarkTheme = darkTheme ?? "satopi"` so the initial default matches what the setup wizard description claims. The `"satopi"` theme is built-in and is the intended brand default.
  - Acceptance: On first launch without any settings, `autoDarkTheme` is `"satopi"`, matching the setup wizard's "Satopi in dark terminals" description.
  - Depends: none

## Phase 2: Fix PI_LOGO Splash Animation Fragment
**Contract:** Remove the LARGE_LOGO path entirely — always render PI_LOGO at its native size. The gradientLogo renderer already scales to terminal width, so the 2x LARGE_LOGO provides no visual benefit and causes clipping on terminals with height 14-21. Also fix the phase transition flicker.

- [ ] **Task: Remove LARGE_LOGO, always use PI_LOGO**
  - Files: `src/modes/setup-wizard/scenes/splash.ts`
  - Change: Delete lines 8-15 (`LARGE_LOGO` definition). At line 45, replace `const art = height >= 14 ? LARGE_LOGO : PI_LOGO;` with `const art = PI_LOGO;`. Update the comment at line 43 from "fallback for windows too small" to reflect the unified path.
  - Acceptance: PI_LOGO renders at native 8-row size on all terminal heights. No clipping artifacts at any size. `LARGE_LOGO` symbol is removed from the codebase.
  - Depends: none

- [ ] **Task: Fix phase transition flicker in wizard-overlay.ts**
  - Files: `src/modes/setup-wizard/wizard-overlay.ts`
  - Change: In the `render()` method, when phase transitions from "splash" to "scene", ensure the first frame of the scene phase is rendered before swapping. Add a single-frame buffer: when `#phase` changes, render the new phase's content before marking the phase as active, so the terminal never sees an empty frame.
  - Acceptance: When pressing Enter to skip the splash, the transition to the first scene is visually seamless — no empty or partial frame is displayed.
  - Depends: none


## Phase 3: Fix Agent Panel — Restore All Agents View
**Contract:** Commit `6975394494` accidentally restricted the agent panel to only `kind === "persistent"` agents (adding a new `.filter()` and renaming the panel). Revert to the old behavior: show all agent kinds, title restored to `"Agents"`.

- [ ] **Task: Remove persistent-only filter, restore "Agents" title**
  - Files: `src/modes/components/swarm/agent-panel.ts`
  - Change: At line 71-72, remove `.filter(ref => ref.kind === "persistent")` from the `agentList` expression. At line 61, change the title from `"Persistent Agents"` back to `"Agents"`. Also update `buildAgentRefsFromSwarm` at line 268 to use `kind: "sub"` (the original value before the refactor).
  - Acceptance: The panel title reads "Agents". All registered agents (main, sub, persistent, advisor) appear in the panel. Subagents dispatched via `task` tool are visible.
  - Depends: none
## Phase 4: Fix All TypeScript Errors
**Contract:** `tsgo -p tsconfig.json --noEmit` must report 0 errors. All 145 existing errors resolved.

### 4A: Hook Return Type Mismatches
**Contract:** Hook handlers return `Promise<void>` but `HookHandler` type expects `Promise<boolean | undefined>`. Fix by changing hook implementations to return appropriate values, or fix the type definition.

- [ ] **Task: Fix hook handler return types in builtins**
  - Files: `src/swarm/hook-system/builtins/experience-hook.ts`, `src/swarm/hook-system/builtins/mnemopi-hook.ts`, `src/swarm/hook-system/builtins/profile-hook.ts`, `src/swarm/hook-system/builtins/offload-hook.ts`, `src/swarm/hook-system/builtins/stigmergy-hook.ts`
  - Change: Each hook's handler function signature has `: Promise<void>` but must return `Promise<boolean | undefined>`. Change every handler's return type annotation from `Promise<void>` to `Promise<void>` (keep as-is) but add `return;` (or `return undefined;`) at end of each handler. Alternatively, update the `HookHandler` type in `src/swarm/hook-system/types.ts` to accept `Promise<void>` as a valid return (make the boolean optional: `Promise<boolean | undefined | void>`).
  - Acceptance: No TS2322 errors on hook handlers.
  - Depends: none

- [ ] **Task: Fix payload property access in hook builtins**
  - Files: `src/swarm/hook-system/builtins/experience-hook.ts`, `src/swarm/hook-system/builtins/mnemopi-hook.ts`, `src/swarm/hook-system/builtins/profile-hook.ts`, `src/swarm/hook-system/builtins/stigmergy-hook.ts`
  - Change: The hook payload type is the full `HookPayloadMap[K]` union. Properties like `entry`, `runId`, `agentId`, `summary`, `score`, `name`, `archetype`, `agentIds`, `planSummary`, `taskSummary`, `success` don't exist on all union members. Add type-narrowing guards (e.g. `if ("agentId" in payload)` or `switch (event)` before destructuring) at each access site. For `extractAgentId` helper callers in profile-hook and stigmergy-hook, cast `payload` to `{ agentId?: string }` after a guard check since `CommPayload` lacks `agentId`.
  - Acceptance: No TS2339/TS2345 errors in hook builtins.
  - Depends: none

- [ ] **Task: Fix missing module import in profile-hook.ts**
  - Files: `src/swarm/hook-system/builtins/profile-hook.ts`
  - Change: Line 11 imports from `../../agent/agent-profile` which does not exist. Find the correct path for the `AgentProfile` type — likely `../../registry/agent-registry` or the swarm agent-spec. Replace the import with the correct path.
  - Acceptance: No TS2307 error for `agent-profile` module.
  - Depends: none

### 4B: Test Type Errors

- [ ] **Task: Add resetGlobalForTests to AgentRegistry**
  - Files: `src/registry/agent-registry.ts`, `test/**/*.test.ts` (all callers)
  - Change: Add a `static resetGlobalForTests(): void` method to `AgentRegistry` that resets the global singleton. This was used by ~20 test files and was likely removed during refactoring. Re-add it as a thin wrapper that clears the global instance, marked with `@internal` or a comment indicating it's for test use only.
  - Acceptance: No TS2339 errors for `resetGlobalForTests`. All affected tests pass `bun check` types.
  - Depends: none

- [ ] **Task: Fix agent-runtime.test.ts mock types**
  - Files: `src/swarm/__tests__/agent-runtime.test.ts`
  - Change: (1) Fix `mockSessionFactory` return type to match `CreateAgentSessionResult` (add missing `extensionsResult`, `setToolUIContext`, `eventBus`, `mcpManager` fields). (2) Fix `AgentSpec` union type issues — add proper discriminated unions with `roleSource` narrowing. (3) Fix `LaunchContext` usage where `cwd` is passed but not in the type — remove or type-cast. (4) Fix `assembledContext.systemPrompt` typing where `string | string[] | ((…) => …)` is assigned to `string[]` — add normalization.
  - Acceptance: No TS errors in `agent-runtime.test.ts`.
  - Depends: none

- [ ] **Task: Fix remaining test type errors**
  - Files: `test/internal-urls/memory-protocol.test.ts`, `test/vibe/vibe-runtime.test.ts`, `test/tui/hyperlink.test.ts`, `test/registry/agent-lifecycle.test.ts`, `src/graph/__tests__/smoke-phase9a.test.ts`, `src/swarm/__tests__/unified-abstraction-e2e.test.ts`, `src/swarm/__tests__/context-pipeline.test.ts`
  - Change: For each file: (a) `memory-protocol.test.ts` — fix `AgentRegistry.resetGlobalForTests` calls and any import issues. (b) `smoke-phase9a.test.ts` — fix `CheckpointStore` and `NodeExecutionContext` imports; fix `text` property access on union type; fix `InternalUrl` type mismatch with `scheme` property. (c) `unified-abstraction-e2e.test.ts` — fix object literal type mismatches in swarm config construction. (d) `context-pipeline.test.ts` — fix ContextSource registration type issues.
  - Acceptance: No TS errors in any test file.
  - Depends: Add resetGlobalForTests to AgentRegistry

### 4C: Source Type Errors

- [ ] **Task: Fix stage-controller.ts type errors**
  - Files: `src/swarm/stage/stage-controller.ts`
  - Change: Fix the 7 type errors — likely object literal mismatches in `AgentSpec` construction, missing required properties on spawn configs, or incorrect type narrowing on swarm state. Read the file to determine exact errors.
  - Acceptance: No TS errors in `stage-controller.ts`.
  - Depends: none

- [ ] **Task: Fix graph-engine.ts type error**
  - Files: `src/graph/graph-engine.ts`
  - Change: At line 318, fix `Record<string, { nodeId: string; status: string }>` to use `NodeStatus` type instead of `string` for the status field.
  - Acceptance: No TS2322 error at line 318.
  - Depends: none

- [ ] **Task: Fix remaining source errors**
  - Files: `src/cli/swarm-cli.ts`, `src/dap/config.ts`, `src/secrets/index.ts`
  - Change: (a) `swarm-cli.ts:242` — fix `null` assigned to `LoopSwarmConfig | undefined`, use `undefined` instead. (b) `dap/config.ts:4` — the `verbatimModuleSyntax` conflict with ambient const enums: add `// @ts-expect-error` or restructure the import. (c) `secrets/index.ts:21` — `CONFIG_DIR_NAME` is undefined; import from `@oh-my-pi/pi-utils` or define locally.
  - Acceptance: No TS errors in these files.
  - Depends: none

## Phase 5: Verification
**Contract:** All fixes compile cleanly and don't break existing behavior.

- [ ] **Task: Run full type check**
  - Files: `tsconfig.json`
  - Change: Run `bun run check:types` and confirm 0 errors.
  - Acceptance: `tsgo -p tsconfig.json --noEmit` exits 0.
  - Depends: Phase 4

- [ ] **Task: Run existing tests**
  - Files: `src/swarm/__tests__/**`, `test/**`
  - Change: Run `bun test` on affected test files to ensure no regressions.
  - Acceptance: All previously-passing tests still pass.
  - Depends: Phase 4

- [ ] **Task: Smoke test splash animation**
  - Files: `src/modes/setup-wizard/scenes/splash.ts`
  - Change: Manually verify the splash animation renders correctly at terminal heights 14-25 by running the setup wizard.
  - Acceptance: No clipped logo fragments visible at any terminal size.
  - Depends: Phase 2
