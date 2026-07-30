# Plan: SatoPi Architecture Refactoring — Agent System, Graph Orchestration, Crew & TUI

## Overview
Unify the agent type system (eliminate `persistent`), restructure session persistence into a tree, eliminate redundant abstractions (PhaseOrchestrator, AgentRuntime, WorkflowFSM), merge graph modules, make GraphRunner the sole orchestration engine, introduce Crew and Roundtable as first-class concepts, and build a sidebar-based TUI with @mention interaction.

## Phase 1: Foundation — Docs & Hygiene
**Contract:** No code changes. Docs organized. Bad commit messages fixed.

- [ ] **Task: Sort ~100 docs into subdirectories**
  - Files: `docs/architecture/`, `docs/swarm/`, `docs/design/`, `docs/features/`, `docs/guides/`, `docs/natives/`, `docs/providers/`
  - Change: Create subdirectories. Move each doc into the appropriate category. Archive superseded docs (7 identified: old architecture analyses, superseded swarm plans, old theatre audits). Update `docs/archive/ARCHIVE-INDEX.md`. Create `docs/README.md` as navigation index.
  - Acceptance: `docs/` top-level contains only subdirectories + README. ARCHIVE-INDEX is current.

- [ ] **Task: Audit + fix 3 bad commit messages**
  - Files: Git history (message-only)
  - Change: Produce audit report at `docs/swarm/commit-hygiene-audit-2026-07-30.md`. Interactive rebase to reword: `0bcbf723c5` ("a"), `a9a5f78a89` (git status dump), `56e533b47b` (git status dump).
  - Acceptance: Clean commit history. `git diff ORIG_HEAD` empty. All 508 tests pass.

## Phase 2: Agent Type Simplification
**Contract:** `AgentKind` reduced to `"main" | "sub"`. `persistent` eliminated. `profileId` added to `main` agents (optional). `AgentLifecycleManager` manages all agents, policy determined by kind + profileId presence.

- [ ] **Task: Remove AgentKind "persistent" from type system**
  - Files: `packages/coding-agent/src/registry/agent-registry.ts`, `packages/coding-agent/src/sdk.ts`
  - Change:
    1. `AgentKind` type: remove `"persistent"` variant
    2. `AgentRef`: add optional `profileId?: string`
    3. `createAgentSession()`: `agentKind` parameter only accepts `"main" | "sub"`. Add optional `profileId` parameter.
    4. `agentKind` default logic unchanged (taskDepth > 0 → "sub", else "main")
  - Acceptance: TypeScript compiles. No `"persistent"` string literals in type positions.

- [ ] **Task: Update AgentLauncher to use agentKind "main" + profileId**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts`
  - Change:
    1. `createAgentSession({ agentKind: "persistent", persistentProfileId })` → `createAgentSession({ agentKind: "main", profileId })`
    2. Remove `persistentProfileId` references
  - Acceptance: Swarm agents spawn with `agentKind: "main"` + `profileId`. No `"persistent"` references.

- [ ] **Task: Remove AgentLifecycleManager guard for persistent agents**
  - Files: `packages/coding-agent/src/registry/agent-lifecycle.ts`
  - Change:
    1. Delete line 102: `if (ref?.kind === "persistent") return;`
    2. Add lifecycle policy logic: `main` agents with `profileId` → policy: explicit-dispose (no TTL, no auto-park). `sub` agents → policy: TTL-park (existing behavior). `main` agents without `profileId` → policy: TTL-park.
    3. `adopt()` accepts all non-MAIN_AGENT_ID agents
  - Acceptance: Swarm main agents can be adopted by AgentLifecycleManager. Park/revive works for agents with sessionFile. TTL parking only applies to sub agents and profileId-less main agents.

- [ ] **Task: Update all callers of AgentRuntime.spawn() for new agentKind**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/index.ts`, `packages/coding-agent/src/swarm/behaviors/*.ts`
  - Change: All `agentKind: "persistent"` → `agentKind: "main"`. All `persistentProfileId` → `profileId`.
  - Acceptance: Compiles. Tests pass. No "persistent" in swarm code.

## Phase 3: Session Tree Restructure
**Contract:** Agent sessions stored hierarchically under parent session. Subagents under `{parent}/{agent-id}.jsonl`. Swarm agent sessions under `{parent}/swarm-{name}/agents/{agent-id}.jsonl`. Crew transcripts under `{parent}/swarm-{name}/crews/{crew-id}.jsonl`.

- [ ] **Task: Define session directory layout constants**
  - Files: `packages/coding-agent/src/session/session-paths.ts` (new)
  - Change: Export path builders: `getAgentSessionPath(parentSessionFile, agentId)`, `getSwarmAgentsDir(parentSessionFile, swarmName)`, `getCrewTranscriptPath(parentSessionFile, swarmName, crewId)`.
  - Acceptance: Pure functions, well-tested with various inputs.

- [ ] **Task: Update subagent session file path in TaskTool**
  - Files: `packages/coding-agent/src/task/index.ts`, `packages/coding-agent/src/task/executor.ts`
  - Change: Replace `artifactsDir = sessionFile.slice(0, -6)` + `path.join(artifactsDir, id)` with `getAgentSessionPath(sessionFile, id)`. Create parent directory if needed.
  - Acceptance: Subagent sessions stored at `{parent-session-dir}/{agent-id}.jsonl`. Existing session files still readable (migration: move files). Tests pass.

- [ ] **Task: Update persistent/swarm agent session path**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/index.ts`, `packages/coding-agent/src/swarm/session/swarm-session-manager.ts`
  - Change: When AgentRuntime spawns an agent for a swarm, pass `sessionManager` with path pointing to `{swarm-dir}/agents/{agent-id}.jsonl`. SwarmSessionManager creates sessions at `{swarm-dir}/.session/swarm.jsonl`.
  - Acceptance: Swarm agent sessions nest under swarm directory. Flat `~/.stp/sessions/` no longer polluted with swarm agent files.

- [ ] **Task: Add parentSession reference to session header**
  - Files: `packages/coding-agent/src/session/session-manager.ts` (or the header write path in sdk.ts)
  - Change: When creating an agent session with a known parent, write `parentSession: parentSessionFile` into the session header. `SwarmSessionManager` also records `parentSession`.
  - Acceptance: Session tree navigable from disk metadata. `SessionSelector` can build tree from headers.

## Phase 4: Graph Module Merge
**Contract:** `src/graph/` and `src/swarm/graph/` merged into single `src/graph/`. No duplicate types. No cross-imports between graph and swarm.

- [ ] **Task: Merge src/graph/ types with src/swarm/graph/ schema**
  - Files: `packages/coding-agent/src/graph/types.ts`, `packages/coding-agent/src/swarm/graph/schema.ts`
  - Change:
    1. Move `GraphDefinition`, `GraphNode`, `GraphEdge`, `NodeType`, gate types from `swarm/graph/schema.ts` into `src/graph/types.ts`
    2. Remove `swarm/graph/schema.ts` re-exports — `src/graph/types.ts` is the single source of truth
    3. Fix the import violation: `src/graph/types.ts` currently imports `AgentRuntime` from swarm. Replace with interface `AgentSpawner` that AgentRuntime (while it still exists) or createAgentSession (after Phase 5) satisfies.
  - Acceptance: `src/graph/types.ts` has zero imports from `src/swarm/`. All graph types in one file.

- [ ] **Task: Merge GraphRunner into src/graph/**
  - Files: `packages/coding-agent/src/swarm/graph/graph-runner.ts` → `packages/coding-agent/src/graph/graph-runner.ts`
  - Change:
    1. Move `GraphRunner` class and its config to `src/graph/`
    2. Move `NodeBehavior` interface and implementations to `src/graph/behaviors/`
    3. Move `theatre.graph.yaml` to `src/graph/builtin/`
    4. Update all imports across the codebase
  - Acceptance: `src/swarm/graph/` directory deleted. All imports point to `src/graph/`.

- [ ] **Task: Merge PhaseBehavior implementations into NodeBehavior**
  - Files: `packages/coding-agent/src/swarm/behaviors/` → `packages/coding-agent/src/graph/behaviors/`
  - Change:
    1. Move `script-behavior.ts` → `src/graph/behaviors/script-node.ts`
    2. Move `stage-behavior.ts` → `src/graph/behaviors/stage-node.ts`
    3. Move `curtain-behavior.ts` → `src/graph/behaviors/curtain-node.ts`
    4. Adapt PhaseBehavior interface → NodeBehavior interface (they're structurally similar)
    5. Move `swarm/curtain/` (lesson-sink, summarizer, reflector) → `src/graph/behaviors/curtain/`
  - Acceptance: `src/swarm/behaviors/` deleted. GraphRunner uses NodeBehavior exclusively.

## Phase 5: Eliminate Redundant Abstractions
**Contract:** PhaseOrchestrator deleted. WorkflowFSM deleted. AgentRuntime + AgentLauncher deleted. GraphRunner becomes the sole orchestrator. All agent spawning goes through `createAgentSession()` directly.

- [ ] **Task: Eliminate AgentRuntime — decompose into direct calls**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/index.ts` (delete), `packages/coding-agent/src/graph/behaviors/*.ts`, `packages/coding-agent/src/graph/graph-runner.ts`
  - Change:
    1. `AgentRuntime.spawn(specs)` → GraphRunner calls `createAgentSession({ agentKind: "main", profileId: spec.profileId, ... })` directly for each spec
    2. `AgentRuntime.spawnRoundtable(specs)` → GraphRunner creates CommChannel, spawns agents, calls `channel.roundtable(topic)`
    3. `AgentRuntime.sendHumanMessage()` → `ircBus.send("human", agentId, text)` or `crewChannel.send("human", text)`
    4. `AgentRuntime.sendSystemNotification()` → `crewChannel.broadcast("[System] msg")`
    5. ContextPipeline assembly: GraphRunner calls `contextPipeline.assemble()` before each spawn
    6. HookPipeline triggers: GraphRunner calls `hookPipeline.trigger()` at spawn boundaries
    7. CommChannel wiring: GraphRunner creates per-crew CommChannels and adds spawned agents
  - Acceptance: `AgentRuntime` class deleted. All tests pass with direct createAgentSession calls. No functionality lost.

- [ ] **Task: Eliminate AgentLauncher**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts` (delete)
  - Change: Move model resolution and system-prompt building logic from AgentLauncher into helper functions in `src/graph/agent-helpers.ts`. Delete the class.
  - Acceptance: `AgentLauncher` deleted. Spawn logic lives in `src/graph/agent-helpers.ts`.

- [ ] **Task: Move AgentSpec to src/graph/**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/agent-spec.ts` → `packages/coding-agent/src/graph/agent-spec.ts`
  - Change: Move `AgentSpec` type. Update imports.
  - Acceptance: AgentSpec in graph module.

- [ ] **Task: Move RoleProfiles to src/agent/**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/role-profiles.ts` → `packages/coding-agent/src/agent/role-profiles.ts`
  - Change: Move role profile definitions. Update imports.
  - Acceptance: RoleProfiles accessible from infrastructure layer.

- [ ] **Task: Eliminate PhaseOrchestrator (EmbeddedSwarmBridge)**
  - Files: `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts` → delete, `packages/coding-agent/src/swarm/core/phase-orchestrator.ts` → delete
  - Change:
    1. `agent-session.ts`: replace `new EmbeddedSwarmBridge(...)` with `new GraphRunner({ graphPath: builtinTheatreGraph })`. Store as `this.#graphOrchestrator`.
    2. `interactive-mode.ts`: replace `swarmBridge.confirmScript()` with `graphOrchestrator.run()`. Replace `swarmBridge.onPlanUpdated()` with graph node output event. Replace `swarmBridge.applaud()` with `graphOrchestrator.sendGateResponse("curtain", "Applaud")`.
    3. `swarm-cli.ts`: replace `EmbeddedSwarmBridge` with `GraphRunner`.
    4. Delete `ISwarmOrchestrator` interface. GraphRunner's public API becomes the contract.
    5. Move plan validation (`validatePlanTasks`) to `src/graph/plan-validator.ts`.
    6. Move `createOrchestratorRuntime()` (assembler) logic into GraphRunner constructor or a `createGraphServices()` factory.
  - Acceptance: Zero references to EmbeddedSwarmBridge, PhaseOrchestrator, ISwarmOrchestrator. GraphRunner is the only orchestrator.

- [ ] **Task: Eliminate WorkflowFSM**
  - Files: `packages/coding-agent/src/swarm/core/workflow-fsm.ts` → delete
  - Change:
    1. Graph node status (`pending → running → complete → failed`) replaces FSM phases
    2. Phase transitions (script → stage → curtain) are implicit in DAG edge traversal
    3. StateTracker updates driven by GraphEngine node lifecycle events
    4. Remove all `fsm.transition()` calls
  - Acceptance: WorkflowFSM deleted. Graph node status is the state machine.

- [ ] **Task: Clean up src/swarm/ directory**
  - Files: Entire `src/swarm/` directory
  - Change:
    1. Delete: `core/` (PhaseOrchestrator, WorkflowFSM, assembler, state, services, dag, schema, verification-hook, convergence)
    2. Delete: `behaviors/` (moved to graph)
    3. Delete: `graph/` (merged)
    4. Delete: `agent-runtime/` (AgentRuntime + AgentLauncher eliminated)
    5. Delete: `comm-bus/` (empty, already migrated)
    6. Delete: `hook-system/` (empty, already migrated)
    7. Delete: `context-manager/` → move to `src/context/` (it's infrastructure, not swarm-specific)
    8. Delete: `executor/executor.ts` (AgentExecutor → move interface to `src/graph/`, default impl simplified)
    9. Keep: `executor/task-queue.ts` → move to `src/graph/`
    10. Keep: `executor/todo-tracker.ts` → audit for overlap with main session todo, merge or move to `src/graph/`
    11. Keep: `session/` → stays at `src/swarm/session/`
    12. Keep: `prompts/` → stays at `src/swarm/prompts/`
    13. Delete: `curtain/` (moved to graph/behaviors/curtain/)
    14. Delete: `script/` (debate-roundtable → move to `src/graph/`, plan-paths → move to `src/graph/`, task-analyzer → move to `src/graph/`)
    15. Delete: `stage/` (stage-controller → move to `src/graph/behaviors/stage/`, role-roundtable → redundant after CommChannel)
    16. Delete: `infra/` (already migrated to `src/infra/`)
  - Acceptance: `src/swarm/` contains only `session/` and `prompts/`. All other code lives in `src/graph/` or `src/` top-level infrastructure.

## Phase 6: Crew & Roundtable
**Contract:** Crew = persistent agent subset group chat. Roundtable = multi-round convergence discussion within a crew. Agent-create-crew tool available. Crew transcripts persisted to disk.

- [ ] **Task: Implement CrewManager**
  - Files: `packages/coding-agent/src/graph/crew/crew-manager.ts` (new)
  - Change:
    1. `CrewManager` class: `createCrew(name, members)`, `addMember(crewId, agentId)`, `removeMember(crewId, agentId)`, `getCrew(crewId)`, `listCrews()`
    2. Each crew owns a `CommChannel` for member communication
    3. Crew metadata persisted to `{swarm-dir}/crews/{crew-id}.json`
    4. Crew transcript persisted to `{swarm-dir}/crews/{crew-id}.jsonl`
    5. Human auto-added as observer on creation
  - Acceptance: Crews survive swarm restart. Transcripts replayable.

- [ ] **Task: Implement RoundtableSession**
  - Files: `packages/coding-agent/src/graph/crew/roundtable-session.ts` (new)
  - Change:
    1. `RoundtableSession` class: `start(topic, config)`, `addRound()`, `checkConvergence()`, `getTranscript()`
    2. Jaccard similarity convergence detection (reuse from CommChannel)
    3. Transcript persisted as interleaved view with agent tags
    4. Individual agent transcripts also saved to their own sessions
  - Acceptance: Roundtable starts, runs multiple rounds, converges, result persisted.

- [ ] **Task: Implement agent_create_crew tool**
  - Files: `packages/coding-agent/src/tools/agent-create-crew.ts` (new), `packages/coding-agent/src/tools/builtin-names.ts`
  - Change:
    1. Tool: `agent_create_crew({ members: string[], topic: string })` → creates crew, broadcasts join notification, returns crewId
    2. Add `"agent_create_crew"` to `BUILTIN_TOOL_NAMES`
    3. Also add `"agent_peers"` to `BUILTIN_TOOL_NAMES`
    4. Human auto-added as observer
  - Acceptance: Agent can create crew via tool call. Human sees new crew in TUI sidebar. All members notified.

- [ ] **Task: Add dynamic member join/leave notifications**
  - Files: `packages/coding-agent/src/comm/comm-channel.ts`
  - Change:
    1. `addMember(id)`: after adding, broadcast `[System] {id} has joined`
    2. `removeMember(id)`: before removing, broadcast `[System] {id} has left`
    3. `injectContext(id, summary)`: send a one-time context message to the new member only
  - Acceptance: Joining/leaving visible to all crew members. New members receive discussion context.

## Phase 7: TUI — Sidebar, @mention, Session Switching
**Contract:** TUI sidebar with session/agent/crew tree. @mention input (not slash command). Pull-based notifications. VS Code-style foldable sidebar. Default focus on main agent transcript.

- [ ] **Task: Implement sidebar component with agent/crew tree**
  - Files: `packages/coding-agent/src/modes/components/swarm-sidebar.ts` (new)
  - Change:
    1. Tree structure: Session → Agents + Swarms → Agents + Crews
    2. Agent status indicator (dot: idle/running/waiting/error)
    3. Crew expandable node showing members
    4. Keyboard navigation: `j/k` move, `Enter` select, `Space` multi-select
    5. `Ctrl+B` toggle sidebar visibility
    6. `Ctrl+←/→` resize sidebar width
  - Acceptance: Sidebar renders agent tree. Toggle and resize work. Selection highlights active agent.

- [ ] **Task: Implement @mention input**
  - Files: `packages/coding-agent/src/modes/components/mention-input.ts` (new), `packages/coding-agent/src/modes/interactive-mode.ts`
  - Change:
    1. `@` triggers floating agent list popup (fuzzy search)
    2. `@agent-name<Enter>` completes mention, message routes to that agent
    3. `@all` routes to all crew members
    4. Multiple `@agent1 @agent2` routes to selected subset
    5. No `@` prefix → message goes to current transcript's agent
  - Acceptance: Mention works with fuzzy completion. Message routing correct.

- [ ] **Task: Implement session/agent switching**
  - Files: `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/session/agent-session.ts`
  - Change:
    1. `session.switchAgent(agentId)` → main view renders target agent's transcript
    2. Agent continues running in background when not in view
    3. Sidebar dot indicates new output on non-visible agents
    4. Status line shows: `[swarm:stage] [agent-1: new]`
    5. `Tab` switches focus between sidebar and transcript
  - Acceptance: User can switch to any agent. Background agents keep running. Notifications visible.

- [ ] **Task: Implement crew/roundtable transcript views**
  - Files: `packages/coding-agent/src/modes/components/roundtable-view.ts` (new)
  - Change:
    1. Interleaved view: messages with colored agent tags, time-sorted
    2. Filter: `f` key toggles agent visibility filter popup
    3. Tool call toggle: `t` key switches between messages-only and messages+tools
    4. Round selector: view specific round of a roundtable
  - Acceptance: Crew transcript rendered with agent colors. Filter and tool-toggle work.

## Phase 8: Infrastructure Hardening
**Contract:** Remaining gaps closed. Dead code removed. Tool visibility fixed. Migration leftovers cleaned.

- [ ] **Task: Wire OffloadManager into GraphRunner**
  - Files: `packages/coding-agent/src/graph/graph-runner.ts`
  - Change: Create OffloadManager in GraphRunner constructor. Pass to ContextPipeline for L1→L3 offload in agent context.
  - Acceptance: Swarm agents receive `<offload_context>` in system prompt.

- [ ] **Task: Fix remaining channel tool visibility**
  - Files: `packages/coding-agent/src/tools/builtin-names.ts`
  - Change: Ensure `agent_peers` and `agent_create_crew` in BUILTIN_TOOL_NAMES. Document excluded tools.
  - Acceptance: Tools discoverable. No tool-not-found errors.

- [ ] **Task: Audit and merge TodoTracker**
  - Files: `packages/coding-agent/src/swarm/executor/todo-tracker.ts`, `packages/coding-agent/src/session/agent-session.ts`
  - Change: Check if swarm TodoTracker can reuse main session's `setTodoPhases()`. If format differs, write adapter. If identical, delete TodoTracker.
  - Acceptance: Single todo system. No duplicate logic.

- [ ] **Task: Clean migration leftover directories**
  - Files: `packages/coding-agent/src/swarm/comm-bus/`, `packages/coding-agent/src/swarm/hook-system/builtins/`
  - Change: `rm -rf` empty directories.
  - Acceptance: Directories deleted.

- [ ] **Task: Apply confirmed design decisions during implementation**
  - Files: Various — applied across Phase 5, 7, 8
  - Change:
    1. **MarkEnvironment**: held by GraphRunner. Each graph run gets its own instance. (✅ Confirmed)
    2. **ExperienceStore**: held by GraphRunner. Created in constructor, injected into curtain node. (✅ Confirmed)
    3. **SwarmSessionManager naming**: keep "Swarm" — user-facing term for multi-agent orchestration. (✅ Confirmed)
    4. **Swarm CLI**: keep `stp swarm run`. Internally delegates to GraphRunner. (✅ Confirmed)
    5. **ContextManager**: move `swarm/context-manager/` → `src/context/`. Before moving, audit: is the existing `ContextPipeline` capability complete, or does the existing `sdk.ts` / `agent-session.ts` already provide equivalent context assembly? If so, eliminate ContextManager entirely instead of moving it. (✅ Confirmed with audit gate)
    6. **DebateRoundtable**: becomes a graph node gate type (`gate: { type: debate }`). The `debatePlan()` method moves into script node behavior as a pre-stage gate. (✅ Confirmed)
    7. **Mnemopi / Hindsight**: no changes. Infrastructure layer, injected via GraphRunner constructor. (✅ Confirmed)
  - Acceptance: All decisions applied. ContextManager audit complete with decision documented.

## Phase 9: Verification & Cleanup

- [ ] **Task: Run full test suite**
  - Files: All test files under `packages/coding-agent/`
  - Change: `cd packages/coding-agent && bun test && bun run check`
  - Acceptance: 0 test failures. 0 TypeScript errors. Baseline tests adapted for new architecture.
  - Depends: All Phase 2-8 tasks

- [ ] **Task: Smoke test magic keyword swarm**
  - Files: N/A (manual)
  - Change: Trigger `swarm` keyword. Verify full lifecycle via GraphRunner: script → stage → curtain. Verify crew creation, roundtable, @mention, session switching, sidebar.
  - Acceptance: End-to-end swarm lifecycle works. All new features functional.

- [ ] **Task: Archive this plan**
  - Files: `plan.md` → `docs/swarm/refactoring-plan-2026-07-30.md`
  - Change: Move to docs. Clean working tree.
  - Acceptance: Plan archived. Git working tree clean (no untracked plan.md in root).
