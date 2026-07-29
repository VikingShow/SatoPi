# Plan: Unify Swarm Script Phase Plan Review

## Overview
Replace the swarm Script phase's simple `ask()` dialog with `PlanReviewOverlay`, the same component used by orchestrate/plan-mode plan review. The ask dialog in `extension-ui-controller` detects swarm intent and delegates to a new `showSwarmPlanReview` method on `InteractiveMode`.

## Phase 1: Add `showSwarmPlanReview` to InteractiveMode
**Contract:** `InteractiveModeContext` gets a new `showSwarmPlanReview` method

- [ ] **Task: Add showSwarmPlanReview method and context entry**
  - Files: `packages/coding-agent/src/modes/types.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`
  - Change: Add `showSwarmPlanReview(planContent: string, callback: (label: string) => void): Promise<void>` to `InteractiveModeContext` interface. Implement in `InteractiveMode` — reads plan content, shows PlanReviewOverlay with options `["Launch Stage", "Revise Plan", "Cancel"]`, includes agent-count slider and agent-type radioGroup (reusing logic from `handlePlanApproval`), calls confirmScript() on "Launch Stage", and invokes callback with the selected label.
  - Acceptance: `bun check` passes, method exists on both interface and class
  - Depends: none

## Phase 2: Wire showAskDialog to detect swarm intent
**Contract:** `extension-ui-controller.ts` delegates to `showSwarmPlanReview` when swarm intent detected

- [ ] **Task: Modify showAskDialog for swarm delegation**
  - Files: `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`
  - Change: In `showAskDialog`, after receiving questions, check if any question option has `intent: "launch_stage"` and `this.ctx.session.embeddedSwarm` is active. If so, read plan content from swarm bridge (`getPlanContent()`), then call `this.ctx.showSwarmPlanReview(planContent, callback)` where callback synthesizes an `ExtensionAskDialogResult` with the selected option. The ask tool returns normally.
  - Acceptance: `bun check` passes, swarm ask with launch_stage intent shows PlanReviewOverlay
  - Depends: Phase 1

## Phase 3: Clean up #swarmAfterToolCall
**Contract:** `confirmScript()` is now called from PlanReviewOverlay handler, not from the hook

- [ ] **Task: Remove direct confirmScript call from afterToolCall hook**
  - Files: `packages/coding-agent/src/session/agent-session.ts`
  - Change: In `#swarmAfterToolCall`, remove the direct `confirmScript()` call for "Launch Stage" (it's now handled by `showSwarmPlanReview`). Keep the hook for error display and backward compatibility with legacy string matching.
  - Acceptance: `bun check` passes, no double confirmScript invocation
  - Depends: Phase 2
