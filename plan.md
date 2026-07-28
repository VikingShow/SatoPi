# Plan: Fix Persistent Agent Panel Visibility

## Overview

Persistent agents created by `agent_invoke` register in `AgentRegistry` but never trigger `SessionObserverRegistry` callbacks, so `#renderSubagentList()` never fires and the TUI panel stays invisible. Fix: subscribe to `AgentRegistry.onChange()` directly in `interactive-mode.ts` (not via SessionObserverRegistry — that keeps the observer focused on subagent EventBus channels), and update persistent agent status to idle after task completion.

## Phase 1: Wire AgentRegistry events into UI refresh

**Contract:** `interactive-mode.ts` subscribes to `AgentRegistry.onChange()`. When a persistent agent registers or changes status, `#scheduleObserverUiSync("lifecycle")` triggers, which calls `#renderSubagentList()` — which already reads from `AgentRegistry.global().list()`.

- [ ] **Task: Subscribe to AgentRegistry.onChange in interactive-mode setup**
  - Files: `packages/coding-agent/src/modes/interactive-mode.ts`
  - Change: After the existing `this.#observerRegistry.subscribeToEventBus(this.#eventBus)` call (~line 1040), add a direct `AgentRegistry.global().onChange()` subscription that filters for `ref.kind === "persistent"` and calls `this.#scheduleObserverUiSync("lifecycle")`. Store the unsubscribe function in the existing `#agentRegistryUnsubscribe` field (already declared at line 714). Update `dispose()` (~line 3767) to ensure unsubscription — the existing `this.#agentRegistryUnsubscribe?.()` call already handles this.
  - Acceptance: `bun check` passes; when a persistent agent registers via `agent_invoke`, `#renderSubagentList()` is called
  - Depends: none

## Phase 2: Fix persistent agent status lifecycle

**Contract:** `agent_invoke` updates `AgentRegistry` status to `"idle"` after session completes, emitting a `status_changed` event that triggers the subscription from Phase 1, causing the HUD to correctly hide completed persistent agents.

- [ ] **Task: Set idle status after persistent agent task completes**
  - Files: `packages/coding-agent/src/tools/agent-invoke.ts`
  - Change: After `session.wait()` returns (line 124, success path), call `registry.setStatus(agentId, "idle")` before `recordTaskCompleted`. In the catch block (line 158, error path), call `registry.setStatus(agentId, "idle")` after `recordTaskCompleted`. Both paths (`new session` and `existing idle session steer`) share the same try/catch, so one addition per branch covers both.
  - Acceptance: `bun check` passes; registry status transitions "running" → "idle" after task completion, which triggers the Phase 1 subscription to hide the panel
  - Depends: none
