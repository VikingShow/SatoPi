# Plan: Wire MarkEnvironment into the Swarm Pipeline

## Overview
MarkEnvironment and StigmergySource/StigmergyHook are fully implemented and tested, but 3 call sites never pass `markEnvironment` to `registerBuiltinHooks()`, and the `assembler` never registers `StigmergySource` in the `ContextPipeline`. Fix all 4 breakpoints so stigmergic signals flow end-to-end.

## Phase 1: Wire markEnvironment to registerBuiltinHooks
**Contract:** `registerBuiltinHooks(pipeline, deps)` already accepts `markEnvironment` in `BuiltinHookDeps` — just not passed at 3 call sites. Adding it enables `StigmergyHook` registration (priority 1).

- [ ] **Task: Fix swarm-cli factory**
  - Files: `src/cli/swarm-cli.ts`
  - Change: In `createSwarmServices()` at line 116, add `markEnvironment: s.markEnvironment` to the `registerBuiltinHooks()` call. `s.markEnvironment` is already available via `SharedServices`.
  - Acceptance: `registerBuiltinHooks` receives `markEnvironment` in the factory path; no new TS errors.
  - Depends: none

- [ ] **Task: Fix EmbeddedSwarmBridge init**
  - Files: `src/swarm/core/embedded-swarm-bridge.ts`
  - Change: Import `MarkEnvironment` from `../../coordination`. In `init()`: create `const markEnv = new MarkEnvironment()` and store as `#markEnv` private field. Add `markEnvironment: markEnv` to `registerBuiltinHooks()` at line 201.
  - Acceptance: `EmbeddedSwarmBridge` owns a `MarkEnvironment` and passes it to `registerBuiltinHooks`; no new TS errors.
  - Depends: none

- [ ] **Task: Fix SessionRegistry re-registration**
  - Files: `src/swarm/session/session-registry.ts`
  - Change: At line 205, add `markEnvironment: this.#shared.markEnvironment` to `registerBuiltinHooks()` call (re-registration when upgrading from NoopOffloadManager to real OffloadManager). `this.#shared.markEnvironment` is already available via `SharedServices`.
  - Acceptance: `registerBuiltinHooks` receives `markEnvironment` during session creation; no new TS errors.
  - Depends: none

## Phase 2: Wire StigmergySource into ContextPipeline
**Contract:** `AssemblerOptions` gains optional `markEnvironment`; `assembleAgentRuntime` registers `StigmergySource` when provided; callers pass their `markEnvironment` instance.

- [ ] **Task: Add StigmergySource to assembler + update callers**
  - Files: `src/swarm/core/assembler.ts`, `src/cli/swarm-cli.ts`, `src/swarm/core/embedded-swarm-bridge.ts`
  - Change:
    1. **assembler.ts**: Import `StigmergySource` from `../context-manager/sources/stigmergy-source` and `MarkEnvironment` as type from `../../coordination`. Add `markEnvironment?: MarkEnvironment` to `AssemblerOptions`. After the HindsightSource registration (line 103), add: `if (opts.markEnvironment) { contextPipeline.register(new StigmergySource(opts.markEnvironment)); }`.
    2. **swarm-cli.ts**: At line 131, add `markEnvironment: s.markEnvironment` to `assembleAgentRuntime()` options.
    3. **embedded-swarm-bridge.ts**: At line 213, add `markEnvironment: this.#markEnv` to `assemblerOpts`.
  - Acceptance: `StigmergySource` is registered in the `ContextPipeline` when `markEnvironment` is provided; no new TS errors; all existing tests pass.
  - Depends: Phase 1 (needs the `#markEnv` field from EmbeddedSwarmBridge task)
