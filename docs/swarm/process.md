# SatoPi Architecture Audit — Fix Progress

## Audit Report: `docs/architecture-audit-2026-07-27.md`

---

## Phase 1: P0 Runtime Bug Fixes (10 issues)

### Phase 1a: Simple One-Line Fixes (no design decision needed)

- [x] **P0-1**: `RoleSource.build()` — add `const fragment: ContextFragment = {};`
  - File: `packages/coding-agent/src/swarm/context-manager/sources/role-source.ts:27`
  - Status: **DONE** (2026-07-27)
  - Decision: none needed

- [x] **P0-2**: `AgentSpec` — add `profileId?: string;`
  - File: `packages/coding-agent/src/swarm/agent-runtime/agent-spec.ts`
  - Status: **DONE** (2026-07-27)
  - Decision: none needed

- [x] **P0-5**: `ScriptManager.#abortController` — initialize before planner launch
  - File: `packages/coding-agent/src/swarm/script/script-manager.ts`
  - Status: **DONE** (2026-07-27)
  - Decision: none needed

- [x] **P0-6**: `agent-profile.ts` — sanitize `profileId` for path traversal
  - File: `packages/coding-agent/src/agent/agent-profile.ts:613`
  - Status: **DONE** (2026-07-27)
  - Changes: Added `SAFE_PROFILE_ID` regex, `requireSafeProfileId()` helper, validation at createProfile/load/save

- [x] **P0-8**: `RegionLockManager.create()` — don't set global singleton
  - File: `packages/coding-agent/src/coordination/region-lock.ts:51-54`
  - Status: **DONE** (2026-07-27)
  - Decision: none needed

### Phase 1b: Logic Fixes (need verification of intended behavior)

- [x] **P0-7**: `executeSwarmAgent` — prevent infinite recursion
  - File: `packages/coding-agent/src/swarm/executor/executor.ts:130-131`
  - Status: **DONE** (2026-07-27)
  - Changes: Replaced reference equality with `instanceof SubprocessAgentExecutor` check

- [x] **P0-9**: `StageController` — infinite polling when all tasks blocked
  - File: `packages/coding-agent/src/swarm/stage/stage-controller.ts:389-394`
  - Status: **DONE** (2026-07-27)
  - Changes: Added deadlock detector (3 consecutive empty polls with 0 in-progress → break)

- [x] **P0-10**: `TaskQueue.block()` — always call `#computeReady()`
  - File: `packages/coding-agent/src/swarm/executor/task-queue.ts:207`
  - Status: **DONE** (2026-07-27)
  - Changes: Moved `#computeReady()` outside `if (fixTask)` block

### Phase 1c: Architectural Decisions (design confirmed)

- [x] **P0-3**: `AgentLauncher` — all Tools are mock stubs
  - File: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts`
  - Status: **DONE** (2026-07-27)
  - Decision: Accept optional `toolRegistry` via LaunchContext. Real tools when available, error log when mock.
  - Changes: Added `toolRegistry?: Map<string, Tool>` to LaunchContext, `#resolveToolInstances()` method

- [x] **P0-4**: `AgentLauncher` — `session = {}` placeholder
  - File: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts:229`
  - Status: **DONE** (2026-07-27)
  - Decision: Make AgentHandle session nullable. AgentHandle never uses session internally; it's only a public getter.
  - Changes: `agent-handle.ts` session → `unknown | null`, `agent-launcher.ts` passes `null`, `agent-runtime/index.ts` removed `setSession` call

---

## Phase 2: P1 Design Defect Fixes (13 issues)

### Phase 2a: Clear Fixes

- [ ] **P1-3**: `WorkflowFsm.waitForHumanDecision()` — reject old promise before overwrite
- [ ] **P1-4**: `AgentRegistry.register()` — handle duplicate IDs
- [ ] **P1-6**: `SwarmRunner.start()` — resolve/reject old promise before overwrite
- [ ] **P1-7**: `DebateRoundtable` v3 path — use `Promise.allSettled`
- [ ] **P1-12**: `SwarmSessionManager.rotate()` — handle partial failure
- [ ] **P1-13**: Session JSON parse — skip bad lines, don't discard all

### Phase 2b: Need Design Discussion

- [ ] **P1-1**: Dual execution paths — needs global architectural decision
- [ ] **P1-5**: `AgentLifecycleManager` state consistency — multiple sub-issues
- [ ] **P1-8**: `PipelineController` concurrency cap — what limit?
- [ ] **P1-9**: `ExperienceStore.close()` — where to call it?
- [ ] **P1-11**: `SessionRegistry.forkSession()` — intended fork behavior?

### Phase 2c: Deferred (agent-session.ts refactor)

- [ ] **P1-2**: agent-session.ts 16,978 lines — needs dedicated refactor plan
- [ ] **P1-10**: beginDispose race — part of agent-session refactor

---

## Phase 3: P2 Key Issues (14 issues)

- [ ] **P2-2**: Extract shared `resolveAgentId()` helper
- [ ] **P2-4**: RegionLockManager TTL + path normalization
- [ ] **P2-5**: AgentLauncher error logging + await #startAgent
- [ ] **P2-6**: WorkflowFsm timed transition configurability
- [ ] **P2-7**: PipelineController afterPipeline on fatal error
- [ ] **P2-8**: MarkEnvironment decay before getSummary/serialize
- [ ] **P2-9**: StageController single completion signal
- [ ] **P2-10**: ScriptBehavior handle "aborted" status
- [ ] **P2-11**: agent-profile atomic save cleanup + deserialize validation
- [ ] **P2-12**: ExperienceStore FTS5 distinguish error types
- [ ] **P2-13**: WorkflowFsm dispose() method
- [ ] **P2-14**: AgentLauncher getSteeringMessages in AgentLoopConfig
- [ ] **P2-1**: HookPayload typed discriminated union
- [ ] **P2-3**: sdk.ts afterToolCall use actual agentId

---

## Phase 4: P3 Code Quality (17 issues)

Low priority, can be addressed incrementally. See audit report for full list.

---

## Deferred: Large File Refactors

These require dedicated planning and should NOT be done as part of this fix pass:

1. **agent-session.ts** (16,978 lines) — needs dedicated decomposition plan
2. **coding-agent monolithic package** (70+ directories) — needs package extraction plan
3. **LoopSwarmConfig explosion** (20+ options) — needs configuration redesign

---

## Phase A: Unified Execution Path (2026-07-27) ✅

- [x] **A1** (`agent-launcher.ts`): Unified tool creation via createTools() + builtinToolNames + createToolSession
- [x] **A2** (`pipeline.ts`): PipelineController v3 AgentRuntime.spawn() path + concurrency cap (10)
- [x] **A3** (`debate-roundtable.ts`): Unified Promise.allSettled in v3 path, preserved error info
- [x] **A4** (`script-manager.ts`, `stage-controller.ts`, `curtain-runner.ts`, `streaming.ts`): Legacy fallbacks deprecated

### Test Coverage Gaps Identified:
- No dedicated TaskQueue test file — P0-10 fix needs tests
- No PipelineController test file — A2 v3 path needs tests
- No StageController/ScriptManager/CurtainRunner tests
- DebateRoundtable has no tests

### Next: Phase B + Phase C (parallel)
