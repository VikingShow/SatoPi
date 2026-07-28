# Plan: Phase 7 — GraphEngine Extraction + Graph Types Migration

## Overview
Extract a swarm-independent `GraphEngine` from `GraphRunner`, moving core DAG execution (wave scheduling, node loop, upstream collection, gate evaluation, retry, checkpointing) into `packages/coding-agent/src/graph/`. Migrate all graph type definitions from `swarm/graph/schema.ts` + `schema-gate.ts` to the shared `graph/types.ts`. `GraphRunner` becomes a thin adapter implementing the `NodeExecutor` interface.

## Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | `GraphEngine` takes `GraphDefinition` + `NodeExecutor` (no swarm deps) | Clean separation; testable without AgentRuntime/FSM |
| D2 | `NodeExecutor` interface has one method: `execute(node, ctx) → NodeResult` | Minimal contract; GraphRunner provides swarm wiring |
| D3 | `CheckpointStore` interface abstracts persistence | GraphEngine can checkpoint without SwarmSessionManager |
| D4 | `GateController` moves to `graph/` | Only depends on gate types + bash — no swarm deps |
| D5 | `WaveScheduler` / `DynamicScheduler` move to `graph/` | Only depends on `NodeResult` type — no swarm deps |
| D6 | `swarm/graph/schema.ts` becomes re-export barrel | Backward compat for all existing consumers |
| D7 | `NodeBehavior`, `NodeContext` stay in `swarm/graph/schema.ts` | These have AgentRuntime/StateTracker deps — they are swarm concepts |

---

## Phase 7A: Graph Type Foundation

**Contract:** `packages/coding-agent/src/graph/types.ts` exports all graph, gate, and checkpoint types with zero swarm imports.

- [ ] **Task: Create graph/types.ts — move all shared type definitions**
  - Files: `packages/coding-agent/src/graph/types.ts` (NEW)
  - Change: Move from `swarm/graph/schema.ts` (lines 1–256, 334–783): `NodeType`, `Strategy`, `NodeOutput`, `GraphNode`, `GraphEdge`, `GraphHook`, `GraphDefaults`, `GraphValidationError`, `GraphDefinition`, `NodeExecutionOutput`, `NodeDefinition`, `NodeResult`, `RawNodeOutput`, `RawGraphNode`, `RawGraphEdge`, `RawGraphHook`, `RawGraphDefaults`, `RawGraphDefinition`, validation constants, `normalizeNodeOutput`, `parseGraphYaml`, `validateGraphDefinition`, `buildGraphDependencyMap`, `loadGraphDefinition`. Move from `swarm/graph/schema-gate.ts` (all): `GateType`, `GateMode`, `RetryStrategy`, `RetryOnFailure`, `GateSpec`, `RetrySpec`, `GateResult`, `RawGateSpec`, `RawRetrySpec`, validation constants, `normalizeRetrySpec`, `normalizeGateSpec`. Move from `swarm/graph/checkpoint.ts` (types only, lines 27–57): `NodeStatus`, `GraphRunStatus`, `NodeRunState`, `GraphRunState`. Import `detectCycles` from `../swarm/core/dag` (this is the ONE remaining swarm import — acceptable since it's a pure DAG utility, or we extract it too).
  - Acceptance: `graph/types.ts` exports all above types and functions with zero `swarm/` imports (except `dag` utility). File is ~700 lines with clean sections.

---

## Phase 7B: Graph Support Modules

**Contract:** Three support modules moved to `graph/`, each with zero swarm imports.

- [ ] **Task: Create graph/graph-executor.ts — move WaveScheduler + DynamicScheduler**
  - Files: `packages/coding-agent/src/graph/graph-executor.ts` (NEW), `packages/coding-agent/src/swarm/graph/graph-executor.ts` (modify)
  - Change: Move entire file content from `swarm/graph/graph-executor.ts` to `graph/graph-executor.ts`. Update import: `NodeResult` from `./types` instead of `./schema`. Original file becomes re-export barrel: `export { WaveScheduler, DynamicScheduler, ... } from "../../graph/graph-executor"`.
  - Acceptance: `graph/graph-executor.ts` imports only from `./types`. `WaveScheduler` importable from both locations.

- [ ] **Task: Create graph/gate-controller.ts — move GateController**
  - Files: `packages/coding-agent/src/graph/gate-controller.ts` (NEW), `packages/coding-agent/src/swarm/graph/gate-controller.ts` (modify)
  - Change: Move entire file content from `swarm/graph/gate-controller.ts` to `graph/gate-controller.ts`. Update imports: gate types from `./types` instead of `./schema`. Original file becomes re-export barrel.
  - Acceptance: `graph/gate-controller.ts` imports only from `./types`, `node:events`, `@oh-my-pi/pi-utils`. `GateController` importable from both locations.

- [ ] **Task: Create graph/checkpoint.ts — CheckpointStore interface + move state types**
  - Files: `packages/coding-agent/src/graph/checkpoint.ts` (NEW), `packages/coding-agent/src/swarm/graph/checkpoint.ts` (modify)
  - Change: New file defines `CheckpointStore` interface: `save(state: GraphRunState): void` and `load(graphName: string): Promise<GraphRunState | null>`. Types already moved in Phase 7A — re-export from `./types`. Original `swarm/graph/checkpoint.ts` imports `CheckpointStore` + types from `../../graph/types`, keeps `SwarmSessionManager`-backed `writeCheckpoint`/`recoverState` as legacy helpers (or wraps them in `SwarmCheckpointStore implements CheckpointStore`).
  - Acceptance: `CheckpointStore` interface in `graph/checkpoint.ts`. `swarm/graph/checkpoint.ts` compiles with no type loss.

---

## Phase 7C: GraphEngine Core

**Contract:** `GraphEngine` class in `graph/graph-engine.ts` executes arbitrary DAGs with no swarm knowledge.

- [ ] **Task: Create graph/graph-engine.ts — NodeExecutor, GraphEngine, buildUpstreamOutputs**
  - Files: `packages/coding-agent/src/graph/graph-engine.ts` (NEW)
  - Change: Define `NodeExecutor` interface: `execute(node: NodeDefinition, ctx: NodeExecutionContext): Promise<NodeResult>`. Define `NodeExecutionContext`: `{ node: NodeDefinition; workspace: string; upstreamOutputs: Record<string, NodeExecutionOutput> }`. Define `GraphEngineConfig`: `{ graph: GraphDefinition; executor: NodeExecutor; workspace: string; maxWorkers?: number; checkpointStore?: CheckpointStore; gateController?: GateController }`. Implement `GraphEngine` class: `async run(): Promise<Map<string, NodeResult>>` — computes waves via `buildExecutionWaves` (import from `../swarm/core/dag`), creates `WaveScheduler`, iterates waves, calls `executor.execute()`, collects results, handles continueOnFailure, writes checkpoints. Move `buildUpstreamOutputs` helper from `graph-runner.ts:51-72`.
  - Acceptance: `GraphEngine` importable from `packages/coding-agent/src/graph/graph-engine` with zero swarm imports (only `dag` utility). TypeScript compiles.

---

## Phase 7D: Re-exports + GraphRunner Thin Adapter + Barrel

**Contract:** All `swarm/graph/` files re-export from `graph/`. `GraphRunner` uses `GraphEngine`. Backward compat preserved.

- [ ] **Task: Create graph/index.ts barrel + update swarm/graph/ re-exports**
  - Files: `packages/coding-agent/src/graph/index.ts` (NEW), `swarm/graph/schema.ts`, `swarm/graph/schema-gate.ts`, `swarm/graph/graph-executor.ts`, `swarm/graph/gate-controller.ts`
  - Change: Create `graph/index.ts` re-exporting from `./types`, `./graph-engine`, `./graph-executor`, `./gate-controller`, `./checkpoint`. In `swarm/graph/schema.ts`: remove moved code (lines 1–256, 334–783), replace with re-exports from `../../graph/types`; keep `NodeBehavior`, `NodeContext`, `RawNodeOutput`, `RawGraphNode`, etc. (lines 257–332, 334–395) — but wait, those raw types should move too. Actually keep only `NodeBehavior` + `NodeContext` which have swarm deps. Update `parseGraphYaml` import to `./schema-gate` → `../../graph/types`. Update `schema-gate.ts` → one-liner re-export from `../../graph/types`. Update `graph-executor.ts` → re-export from `../../graph/graph-executor`. Update `gate-controller.ts` → re-export from `../../graph/gate-controller`.
  - Acceptance: All existing `import { ... } from "./schema"` within `swarm/graph/` still resolve. `graph/index.ts` is a clean public API surface.

- [ ] **Task: Refactor GraphRunner to thin adapter using GraphEngine**
  - Files: `packages/coding-agent/src/swarm/graph/graph-runner.ts`
  - Change: `GraphRunner` keeps `ISwarmOrchestrator` interface, `WorkflowFsm`, `StateTracker`, `ActivityLogger`, `ExperienceStore`, `HookPipeline`, swarm lifecycle (`init`, `confirmScript`, `steer`, `applaud`, `pauseStage`). Implements `NodeExecutor`: `execute(node, ctx)` — selects `NodeBehavior`, builds full `NodeContext` (with runtime, stateTracker, etc.), calls `behavior.prepare/execute/cleanup`. `confirmScript()`: creates `GraphEngine` with `this` as `NodeExecutor`, calls `engine.run()`, then runs curtain pipeline. Removes: `buildUpstreamOutputs` (moved), direct `WaveScheduler` usage (delegated to GraphEngine), inline gate loop (delegated to GraphEngine via GateController). Keeps: FSM transitions, curtain pipeline, swarm session management.
  - Acceptance: `GraphRunner.confirmScript()` ≤ 80 lines. `GraphRunner.runNode()` is the `NodeExecutor.execute()` implementation. All GraphRunner tests pass.

---

## Phase 7E: Verification

- [ ] **Task: Update external imports + verify compilation and tests**
  - Files: `packages/coding-agent/src/slash-commands/builtin-registry.ts`, `packages/coding-agent/src/swarm/graph/loop-converter.ts`, `packages/coding-agent/src/swarm/graph/mermaid-compiler.ts`, `packages/coding-agent/src/swarm/graph/phase-behavior-adapter.ts`, `packages/coding-agent/src/swarm/graph/node-behavior.ts`, `packages/coding-agent/src/swarm/__tests__/graph-integration.test.ts`
  - Change: Update `builtin-registry.ts` (line 39): `import type { GraphDefinition } from "../swarm/graph/schema"` still works via re-export — verify. Update `loop-converter.ts`: gate type imports from `"./schema"` still work via re-export. Update `mermaid-compiler.ts`: `GraphDefinition, GraphEdge, GraphNode` from `"./schema"` still works. Update `phase-behavior-adapter.ts` and `node-behavior.ts`: `NodeContext, NodeBehavior, NodeResult` from `"./schema"` still works (kept in schema.ts). Run `bun check` for zero errors in changed files. Run `bun test` for `graph-integration.test.ts`.
  - Acceptance: `bun check` zero errors. `graph-integration.test.ts` passes. `GraphEngine` importable without swarm deps. `graph/types.ts` importable standalone.
