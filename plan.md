# Plan: Fix Swarm v3 Wiring Gaps — agent://, agent_invoke, GraphRunner, and Stigmergy

## Overview
Fix six wiring gaps discovered in the swarm v3 architecture: (1) `agent://` URI resolution broken by missing protocol handler registration, (2) `agent_invoke` tool unconditionally exported but runtime only set in swarm sessions, (3) GraphRunner `upstreamOutputs: {}` hardcoded blocks wave-to-wave data flow, (4) EmbeddedSwarmBridge and GraphRunner share zero execution code, (5) StigmergySource not registered in the shared assembler, (6) legacy SwarmRunner not connected to ISwarmOrchestrator interface.

## Phase 1: Critical Bug Fixes (agent:// and agent_invoke)
**Contract:** `read agent://<id>` resolves correctly; `agent_invoke` works in swarm sessions and gracefully degrades in non-swarm sessions.

- [ ] **Task: Register AgentProtocolHandler in InternalUrlRouter**
  - Files: `packages/coding-agent/src/internal-urls/router.ts`
  - Change: Add `this.register(new AgentProtocolHandler());` in the `InternalUrlRouter` constructor, between existing register calls. `AgentProtocolHandler` is already imported at line 8.
  - Acceptance: `read agent://<id>` resolves agent output artifacts without error. Existing tests in `agent-protocol-nested.test.ts` and `agent-bridge.test.ts` continue to pass.

- [ ] **Task: Make agent_invoke gracefully degrade in non-swarm sessions**
  - Files: `packages/coding-agent/src/tools/agent-invoke.ts`, `packages/coding-agent/src/tools/index.ts`
  - Change: The tool currently errors when `context.agentRuntime` is undefined. Instead, use `loadMode: "discoverable"` and set a dynamic `hidden` flag based on runtime availability. When runtime is absent, the tool should be hidden from the model's tool list rather than erroring at call time.
  - Acceptance: `agent_invoke` is not offered to the model in non-swarm sessions. In swarm sessions (where `agentRuntime` is set), it works as before. Running `bun test src/swarm/__tests__/agent-invoke.test.ts` passes.

## Phase 2: GraphRunner Data Flow Fix (upstreamOutputs)
**Contract:** `NodeContext.upstreamOutputs` contains outputs from completed predecessor nodes, enabling downstream agents to consume upstream results.

- [ ] **Task: Populate upstreamOutputs from completed node results**
  - Files: `packages/coding-agent/src/swarm/graph/graph-runner.ts`
  - Change: Replace `upstreamOutputs: {}` hardcoded at line 296 with a map built from `agentResultsMap` entries for the current node's `depends_on`. Track per-node results in `agentResultsMap` as nodes complete, then for each new node, collect outputs of its declared dependencies into `upstreamOutputs`.
  - Acceptance: Downstream nodes receive upstream node outputs in `ctx.upstreamOutputs`. Run `bun test src/swarm/__tests__/unified-abstraction-e2e.test.ts` and verify no regressions.

## Phase 3: Stigmergy and Assembler Consistency
**Contract:** `assembleAgentRuntime()` registers StigmergySource consistently; both orchestrator paths use the same initialization.

- [ ] **Task: Register StigmergySource in assembler**
  - Files: `packages/coding-agent/src/swarm/core/assembler.ts`
  - Change: Add `MarkEnvironment` parameter to `AssemblerOptions`, create `MarkEnvironment` in assembler if provided, register `StigmergySource` in the context pipeline. Remove the duplicate `StigmergySource` registration from both `EmbeddedSwarmBridge` (line 241) and `GraphRunner` (line 141) — they should get it from the assembler.
  - Acceptance: `StigmergySource` is registered exactly once via `assembleAgentRuntime()`. Both orchestrators get stigmergic context for agents without manual registration. Existing tests pass.

- [ ] **Task: Remove duplicate StigmergySource registration from orchestrators**
  - Files: `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`, `packages/coding-agent/src/swarm/graph/graph-runner.ts`
  - Change: Delete the `new StigmergySource(this.#markEnv)` + `register()` lines from both files. The assembler now handles this.
  - Acceptance: No duplicate registration. Tests pass. Depends on "Register StigmergySource in assembler".

## Phase 4: Orchestrator Consolidation
**Contract:** EmbeddedSwarmBridge and GraphRunner share a common execution base; legacy SwarmRunner is wired or removed.

- [ ] **Task: Extract shared orchestrator logic into a base class or helper**
  - Files: `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`, `packages/coding-agent/src/swarm/graph/graph-runner.ts`, new file `packages/coding-agent/src/swarm/core/orchestrator-base.ts`
  - Change: Extract common setup (AgentRuntime assembly, HookPipeline registration, MarkEnvironment creation, ContextPipeline source registration) into a shared `createOrchestratorRuntime()` helper in `core/assembler.ts`. Both `EmbeddedSwarmBridge` and `GraphRunner` call this helper instead of duplicating setup.
  - Acceptance: Both orchestrators use identical initialization. No duplicated runtime assembly code. Tests pass for both paths.

- [ ] **Task: Wire SwarmRunner to ISwarmOrchestrator or deprecate it**
  - Files: `packages/coding-agent/src/swarm/core/swarm-runner.ts`
  - Change: Check if `SwarmRunner` is imported by any live code path. If unused, mark as `@deprecated` and add a comment pointing to `EmbeddedSwarmBridge`/`GraphRunner`. If used, implement `ISwarmOrchestrator` interface.
  - Acceptance: `SwarmRunner` either implements the interface or is clearly marked deprecated. No new regressions.

## Phase 5: Verification
**Contract:** Full test suite passes; smoke test confirms agent_invoke and agent:// resolution work end-to-end.

- [ ] **Task: Run full swarm test suite and fix regressions**
  - Files: `packages/coding-agent/src/swarm/__tests__/`
  - Change: Run `bun test src/swarm/__tests__/` and fix any failing tests. The 3 TUI ANSI color failures are pre-existing and out of scope.
  - Acceptance: 611+ tests pass, no new failures introduced by these changes.

- [ ] **Task: Run bun check for type errors**
  - Files: All changed files
  - Change: Run `bun check` in `packages/coding-agent/` and fix any type errors.
  - Acceptance: Zero type errors.
