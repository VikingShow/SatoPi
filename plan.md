# Plan: Split `logger.ts` into `logger.ts` + `timing.ts`

## Overview
`packages/utils/src/logger.ts` (673 lines) mixes three concerns: winston-backed structured logging, startup timing/span instrumentation, and module-load timing rendering. Extract the timing/span subsystem into a sibling `timing.ts` while keeping `logger.ts` as the re-export hub — zero call-site changes, zero barrel changes, zero behavioral changes.

## Phase 1: Extract timing into `timing.ts`

**Contract:** `timing.ts` exports: `time`, `startTiming`, `endTiming`, `printTimings`, `openSpanPath`, `timingModeIncludes`, `shouldExitAfterTimings`, `recordModuleLoadSpan`. `logger.ts` re-exports all of them via `export * from "./timing"`. All private helpers (Span, intervals, module-load rendering, format/print utils) move to `timing.ts`. `logger.ts` retains: `error`, `warn`, `info`, `debug`, `startupMarker`, `setTransports`, and all winston infrastructure.

- [ ] **Task: Create `timing.ts` with all timing/span code**
  - Files: `packages/utils/src/timing.ts`
  - Change: Move lines 208–672 from `logger.ts` into a new `timing.ts`. This includes: `Span` interface, `spanStorage`/`gRootSpan`/`gRecordTimings` state, `time()`, `startTiming()`, `endTiming()`, `printTimings()`, `openSpanPath()`, `timingModeIncludes()`, `shouldExitAfterTimings()`, `recordModuleLoadSpan()`, `spliceModuleLoadBuffer()`, and all private helpers (`durationOf`, `selfTimeOf`, `fmtMs`, `isParallel`, `printSpan`, `printModuleLoadSummary`, `buildModuleTimingGraph`, `compareModuleNodes`, `renderModuleTimingNode`, `shortenLoadPath`, `isModuleLoadSpan`, module-load constants). Imports: `node:async_hooks` (AsyncLocalStorage), `node:util/types` (isPromise), `./timing-buffer` (drainModuleLoadEvents), `./logger` (startupMarker — used by `time()`). The `LOGGED_TIMING_THRESHOLD_MS` constant moves too.
  - Acceptance: `bun check` passes; `bun test packages/utils/test/logger-startup.test.ts` passes with zero changes to the test file.

- [ ] **Task: Trim `logger.ts` to winston-only + re-export**
  - Files: `packages/utils/src/logger.ts`
  - Change: Remove lines 208–672 (everything after `startupMarker` through end of file). Add `export * from "./timing"` at the bottom. Remove imports no longer needed: `node:async_hooks`, `node:util/types`, `./timing-buffer`. Keep: winston infrastructure, `error`/`warn`/`info`/`debug`, `startupMarker`, `setTransports`, all format/transport helpers.
  - Acceptance: `bun check` passes; all existing imports of `logger.time`, `logger.startTiming`, `logger.error`, etc. resolve without changes. `bun test packages/utils/test/logger-startup.test.ts` passes.

## Phase 2: Verification

- [ ] **Task: Run full test suite and type-check**
  - Files: `packages/utils/src/logger.ts`, `packages/utils/src/timing.ts`, `packages/utils/src/index.ts`
  - Change: No edits — verification only. Run `bun check` across the workspace, then `bun test` in `packages/utils/` and spot-check the coding-agent package.
  - Acceptance: Zero type errors. All existing tests pass. No import resolution errors. The logger namespace (`logger.error`, `logger.time`, etc.) resolves identically from all consumer packages.
  - Depends: Create `timing.ts`; Trim `logger.ts`
