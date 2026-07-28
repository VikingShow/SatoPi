# Plan: Swarm Architecture Audit — Dead Code, Redundancy, and Pattern Cleanup

## Overview
Audit of `packages/coding-agent/src/swarm/` (30k LOC, 80+ source files) against: dead code removal, redundancy consolidation, infrastructure merge opportunities, convention compliance, and code splitting. Identified 5 dead files, 7 dead exports, 3 execution engine overlaps, 2 duplicate Jaccard implementations, 47+ pattern violations.

## Phase 1: Dead Code Removal
**Contract:** No production code references removed files or exports. All tests for removed code are also cleaned up.

- [ ] **Task: Remove dead files and their test files**
  - Files: `packages/coding-agent/src/swarm/agent/agent-scaler.ts`, `packages/coding-agent/src/swarm/agent/index.ts`, `packages/coding-agent/src/swarm/core/convergence.ts`, `packages/coding-agent/src/swarm/core/blockage.ts`, `packages/coding-agent/src/swarm/render/index.ts`
  - Change: Delete the 5 dead files that have zero production consumers. Remove corresponding test files: `worker-scaler.test.ts`, `convergence.test.ts`, `blockage.test.ts`. Remove re-exports from `agent/index.ts` and `core/index.ts`.
  - Acceptance: `bun check` passes. `bun test src/swarm/__tests__/` has no broken import errors.

- [ ] **Task: Remove dead exports from alive files**
  - Files: `packages/coding-agent/src/swarm/core/services.ts`, `packages/coding-agent/src/swarm/core/dag.ts`, `packages/coding-agent/src/swarm/executor/executor.ts`, `packages/coding-agent/src/swarm/comm-bus/endpoint.ts`, `packages/coding-agent/src/swarm/comm-bus/vote.ts`, `packages/coding-agent/src/swarm/comm-bus/roundtable.ts`, `packages/coding-agent/src/swarm/stage/role-roundtable.ts`
  - Change: Remove `SwarmServices`, `SwarmAgentRunner`, `SwarmMessageBus` interfaces from services.ts. Remove `buildDependencyGraph` from dag.ts. Remove `executeSwarmAgent` from executor.ts. Remove `createEndpoint`, `CommEndpoint`, `EndpointCapability` from endpoint.ts. Remove `parseVote`, `runVote` from vote.ts. Remove `jaccardSimilarity` and `tokenize` from roundtable.ts. Remove `RoleRoundtable` deprecated class from role-roundtable.ts. Clean up index.ts barrel re-exports.
  - Acceptance: All removed symbols have zero production consumers (verified via grep). `bun check` passes.

## Phase 2: Redundancy Consolidation
**Contract:** Three execution engines reduced to two; duplicate Jaccard deduplicated; overlapping Stage implementations clarified.

- [ ] **Task: Merge duplicate Jaccard similarity implementations**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/index.ts`, `packages/coding-agent/src/swarm/comm-bus/roundtable.ts`
  - Change: The private `jaccardSimilarity()` in agent-runtime/index.ts (line 478) and the public one in comm-bus/roundtable.ts (line 103) are semantic duplicates. Extract one canonical `jaccardSimilarity` and `tokenize` into `packages/coding-agent/src/swarm/core/convergence.ts` (restore the file for this single purpose). Import from there in both callers. Delete the roundtable.ts public exports (already dead) and have roundtable.ts import from convergence.ts.
  - Acceptance: Single Jaccard implementation. Both AgentRuntime.spawnRoundtable and CommChannel.roundtable produce identical results. Tests pass.

- [ ] **Task: Deprecate PipelineController and SwarmRunner (legacy engines)**
  - Files: `packages/coding-agent/src/swarm/core/pipeline.ts`, `packages/coding-agent/src/swarm/core/swarm-runner.ts`
  - Change: Both are legacy execution engines now superseded by GraphRunner + PhaseBehavior. Add `@deprecated` JSDoc with migration notes. Move both into a `legacy/` subdirectory if they are still required by swarm-cli.ts. If swarm-cli.ts can be migrated to use GraphRunner directly, deprecate and schedule removal.
  - Acceptance: GraphRunner is the single graph execution path. SwarmRunner and PipelineController are clearly marked deprecated. No new import paths broken.
  - Depends: Merge duplicate Jaccard similarity implementations

- [ ] **Task: Consolidate StageController and StageBehavior**
  - Files: `packages/coding-agent/src/swarm/stage/stage-controller.ts`, `packages/coding-agent/src/swarm/behaviors/stage-behavior.ts`
  - Change: StageController (542 lines) and StageBehavior (238 lines) overlap in stage execution logic. StageBehavior wraps StageController via `createStageController`. Inline the orchestration logic from StageController into StageBehavior, or have StageController delegate to StageBehavior. The goal is one canonical path for stage execution.
  - Acceptance: Single stage execution path. Tests in `behaviors.test.ts` continue to pass. Deprecated paths preserved for backward compat with swarm-cli.ts.

## Phase 3: Infrastructure Merge
**Contract:** Swarm-specific infra moved closer to shared coding-agent infrastructure where appropriate; no feature regressions.

- [ ] **Task: Extract ActivityLogger event taxonomy into shared types**
  - Files: `packages/coding-agent/src/swarm/infra/activity-logger.ts`, new file `packages/coding-agent/src/session/activity-types.ts`
  - Change: Move `ActivityEventType`, event payload interfaces, and SSE broadcast types from activity-logger into a shared types module. ActivityLogger stays in swarm/ as the implementation, but the types become reusable by non-swarm sessions.
  - Acceptance: Types importable from `../session/activity-types`. No changes to ActivityLogger behavior.

- [ ] **Task: Merge SessionRegistry into coding-agent session infrastructure**
  - Files: `packages/coding-agent/src/swarm/session/session-registry.ts`, `packages/coding-agent/src/session/agent-session.ts`
  - Change: SessionRegistry manages per-session service graphs (AgentRuntime, CommBus, etc.). Since the main AgentSession already stores swarm state (`#embeddedSwarm`, `#swarmSession`), move SessionRegistry fields into AgentSession directly. Remove the separate registry module.
  - Acceptance: AgentSession is the single session state container. SessionRegistry removed. Tests pass.

## Phase 4: Convention Compliance
**Contract:** Swarm code follows AGENTS.md conventions: `#private`, no `ReturnType<>`, prompts in `.md`, no `any`, no dynamic imports, `Promise.withResolvers()`.

- [ ] **Task: Replace `private`/`protected` keywords with `#private`**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/index.ts`, `packages/coding-agent/src/swarm/agent-runtime/role-provider.ts`, `packages/coding-agent/src/swarm/core/pipeline.ts`, `packages/coding-agent/src/swarm/context-manager/context-pipeline.ts`, `packages/coding-agent/src/swarm/infra/activity-logger.ts`
  - Change: Convert all `private`/`protected` field and method declarations to ES `#private`. For `protected` members, create protected accessor methods or make them public with `@internal` JSDoc.
  - Acceptance: Zero `private`/`protected` keywords in swarm/ source files. Tests pass.

- [ ] **Task: Replace `ReturnType<>` with explicit types**
  - Files: `packages/coding-agent/src/swarm/core/workflow-fsm.ts`, `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`, `packages/coding-agent/src/swarm/executor/executor.ts`, `packages/coding-agent/src/swarm/curtain/curtain-runner.ts`, `packages/coding-agent/src/swarm/script/script-manager.ts`
  - Change: Replace instances of `ReturnType<typeof setTimeout>` with `Timer`, `ReturnType<typeof setInterval>` with `Timer`, `ReturnType<typeof createStageController>` with the actual `StageController` type, etc.
  - Acceptance: Zero `ReturnType<>` usages in swarm/ source files.

- [ ] **Task: Extract inline prompts into `.md` files**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/role-provider.ts`, `packages/coding-agent/src/swarm/script/debate-roundtable.ts`, `packages/coding-agent/src/swarm/curtain/curtain-runner.ts`
  - Change: Move inline system prompt strings and task prompt arrays into `.md` files under `swarm/prompts/`. Use Handlebars for dynamic content. Import via `import content from "./prompt.md" with { type: "text" }`.
  - Acceptance: Zero inline prompt strings > 2 lines in swarm/ source files. Prompts live in `.md` files.

- [ ] **Task: Replace `new Promise()` with `Promise.withResolvers()` and dynamic imports**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/agent-handle.ts`, `packages/coding-agent/src/swarm/curtain/curtain-runner.ts`, `packages/coding-agent/src/swarm/infra/create-mnemopi-client.ts`, `packages/coding-agent/src/swarm/agent-runtime/agent-spec.ts`
  - Change: Convert `new Promise(resolve => ...)` patterns to `Promise.withResolvers()`. Replace `await import(...)` with top-level imports where possible. For lazy-load patterns, use top-level dynamic `import()` at module scope.
  - Acceptance: Zero `new Promise(...)` in swarm/ source files. Zero inline dynamic imports.

- [ ] **Task: Remove `any` type assertions and add proper types**
  - Files: `packages/coding-agent/src/swarm/session/swarm-session-manager.ts`, any other files with `as any`
  - Change: Replace `(this.#session as any)` with typed accessor methods or proper type guards. Add missing type declarations.
  - Acceptance: Zero `any` type assertions in swarm/ source files.

## Phase 5: Code Splitting and Cleanup
**Contract:** Oversized files split; naming and barrel exports fixed.

- [ ] **Task: Split files exceeding 500 lines**
  - Files: `packages/coding-agent/src/swarm/graph/schema.ts` (874), `packages/coding-agent/src/swarm/curtain/experience.ts` (874), `packages/coding-agent/src/swarm/graph/gate-controller.ts` (643), `packages/coding-agent/src/swarm/core/schema.ts` (636), `packages/coding-agent/src/swarm/core/workflow-fsm.ts` (618), `packages/coding-agent/src/swarm/stage/stage-controller.ts` (541), `packages/coding-agent/src/swarm/core/pipeline.ts` (538), `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts` (507)
  - Change: For each file, extract cohesive sub-modules (types→types.ts, validation→validate.ts, strategies→strategies.ts). Keep the main file as a coordinator that imports from sub-modules.
  - Acceptance: No source file (excluding __tests__) exceeds 500 lines. All imports resolve correctly.

- [ ] **Task: Fix barrel exports to use `export *` pattern**
  - Files: All `index.ts` files under `packages/coding-agent/src/swarm/`
  - Change: Replace named re-exports (`export { Foo } from "./foo"`) with star re-exports (`export * from "./foo"`). Remove `export type { ... }` — types are inferred.
  - Acceptance: All barrel exports use `export *` pattern.

## Phase 6: Verification
**Contract:** Full test suite passes; `bun check` has zero new diagnostics.

- [ ] **Task: Run full test suite and fix regressions**
  - Files: `packages/coding-agent/src/swarm/__tests__/`
  - Change: Run `bun test src/swarm/__tests__/`. Fix any failures. Baseline: 611 pass, 3 fail (TUI color — pre-existing).
  - Acceptance: >= 611 tests pass. No new failures.

- [ ] **Task: Run bun check and biome lint**
  - Files: All changed files
  - Change: Run `bun check` in packages/coding-agent/. Fix any new errors.
  - Acceptance: Zero new biome errors or TS errors.
