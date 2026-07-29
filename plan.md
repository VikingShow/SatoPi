# Plan: Split `logger.ts` into focused modules

## Overview
Split `packages/utils/src/logger.ts` (~672 lines, three concerns) into three focused modules: core logging, timing/spans, and module-load analysis. The existing `logger` namespace stays backward-compatible via a barrel re-export — zero consumer changes required. Three test files validate each concern independently after the split.

## Phase 1: Extract core logging → `logger-core.ts`
**Contract:** Exports `error`, `warn`, `info`, `debug`, `setTransports`, `startupMarker`, `getWinstonLogger`, `buildTransports`, `makeFileTransport`, `makeConsoleTransport`, `ensureDir`, `jsonReplacer`, `getLogFormat`. Internal-only exports (getWinstonLogger/buildTransports) are used by tests — keep them exported but mark with `@internal`.

- [ ] **Task: Create `logger-core.ts` with core logging functions**
  - Files: `packages/utils/src/logger-core.ts`
  - Change: Extract lines 1–207 from `logger.ts` — imports (winston, winston-daily-rotate-file, fs, `getLogsDir` from `./dirs`), `ensureDir`, `jsonReplacer`, `getLogFormat`, `makeFileTransport`, `makeConsoleTransport`, `buildTransports`, `getWinstonLogger`, `setTransports`, `error`, `warn`, `info`, `debug`, `startupMarker`. Remove the `import { drainModuleLoadEvents } from "./timing-buffer"` (not needed here). Keep JSDoc and try/catch guards.
  - Acceptance: `bun check` passes; `logger-core.ts` has no imports from `./timing-buffer` or references to `Span`/`gRootSpan`/`gRecordTimings`

- [ ] **Task: Create `timing.ts` with span infrastructure**
  - Files: `packages/utils/src/timing.ts`
  - Change: Extract lines 209–433 from `logger.ts` — `LOGGED_TIMING_THRESHOLD_MS`, `Span` interface, `spanStorage`, `gRootSpan`, `gRecordTimings`, `timingModeIncludes`, `shouldExitAfterTimings`, `printTimings`, `startTiming`, `recordModuleLoadSpan`, `endTiming`, `openSpanPath`, `durationOf`, `selfTimeOf`, `fmtMs`. Import `startupMarker` from `./logger-core`, `drainModuleLoadEvents` from `./timing-buffer`. Import `AsyncLocalStorage` from `node:async_hooks`, `isPromise` from `node:util/types`.
  - Acceptance: `bun check` passes; `timing.ts` has no winston imports; `startupMarker` import resolves correctly

- [ ] **Task: Create `module-trace.ts` with module-load analysis**
  - Files: `packages/utils/src/module-trace.ts`
  - Change: Extract lines 441–611 from `logger.ts` — constants (`MODULE_LOAD_PREFIX`, `MODULE_LOAD_VERBOSE_TOP`, etc.), `ModuleTimingNode` interface, `isModuleLoadSpan`, `printSpan`, `printModuleLoadSummary`, `buildModuleTimingGraph`, `compareModuleNodes`, `renderModuleTimingNode`, `isParallel`. Import `Span`, `durationOf`, `fmtMs`, `LOGGED_TIMING_THRESHOLD_MS`, `timingModeIncludes` from `./timing`.
  - Acceptance: `bun check` passes; `module-trace.ts` has no winston imports; all function signatures match original

- [ ] **Task: Extract `time()` function into `timing.ts`**
  - Files: `packages/utils/src/timing.ts`
  - Change: Extract lines 613–673 (the `time()` overloaded function) from `logger.ts` into `timing.ts`. This function uses `startupMarker` (from `./logger-core`), `spanStorage`, `gRootSpan`, `gRecordTimings`, `Span`, `isPromise` — all now in the same module. Keep the three overload signatures and implementation.
  - Acceptance: `bun check` passes; `time()` in timing.ts is identical to original implementation; JSDoc preserved
  - Depends: Create `timing.ts` with span infrastructure

## Phase 2: Rewrite `logger.ts` as a barrel + update tests
**Contract:** `packages/utils/src/logger.ts` re-exports everything from `logger-core.ts`, `timing.ts`, `module-trace.ts` — the existing namespace shape is preserved exactly. All three test files pass.

- [ ] **Task: Rewrite `logger.ts` as a barrel re-export**
  - Files: `packages/utils/src/logger.ts`
  - Change: Replace the 672-line file with re-exports from the three new modules. Export `*` from `logger-core`, `timing`, and `module-trace` so the namespace retains every symbol. The `index.ts` line `export * as logger from "./logger"` picks up the new shape transparently.
  - Acceptance: Existing three test suites pass: `bun test -- packages/utils/test/logger-startup.test.ts packages/utils/test/logger-no-transports.test.ts packages/utils/test/logger-error-serialization.test.ts`

- [ ] **Task: Update test imports for `logger-startup.test.ts`**
  - Files: `packages/utils/test/logger-startup.test.ts`
  - Change: Change the direct import from `@satopi/pi-utils/logger` to import `startTiming`, `endTiming`, `time`, `openSpanPath` from `@satopi/pi-utils/timing`. This was the only test importing via the deep path; the namespace test (`logger-no-transports.test.ts`) already imports via the namespace and needs no changes.
  - Acceptance: `bun test -- packages/utils/test/logger-startup.test.ts` passes with new import paths
  - Depends: Rewrite `logger.ts` as a barrel re-export

## Phase 3: Verification
**Contract:** Full test suite for the utils package passes; no type errors.

- [ ] **Task: Run full utils test suite**
  - Files: `packages/utils/`
  - Change: Run `bun test --parallel` in `packages/utils/`. Verify all 38+ test files pass, including the three logger-specific test files. Run `bun check` to verify no type errors across the package.
  - Acceptance: All tests pass; `bun check` exits 0; no new lint warnings

- [ ] **Task: Verify cross-package consumers compile**
  - Files: `packages/coding-agent/`, `packages/ai/`, `packages/agent/`
  - Change: Run `bun check` in each package that imports from `@satopi/pi-utils` logger namespace. Verify `logger.time()`, `logger.error()`, `logger.startTiming()`, `logger.openSpanPath()` etc. still resolve correctly.
  - Acceptance: `bun check` passes in all three packages; no import errors
  - Depends: Run full utils test suite
