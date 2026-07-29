# Plan: Split Logger Module — Extract Timing/Spans

## Overview
`packages/utils/src/logger.ts` (673 lines, 22KB) mixes three concerns: winston-based logging, startup timing/span instrumentation, and module-load timing visualization. Extract timing/spans and module-load viz into a new `timing.ts`; slim `logger.ts` to pure logging with re-exports for backward compatibility. Zero consumer churn — all ~250+ `logger.*` call sites unchanged.

## Phase 1: Create `timing.ts`
**Contract:** `packages/utils/src/timing.ts` exports all timing/spans/module-viz symbols. `logger.ts` re-exports them unchanged.

- [ ] **Task: Create `timing.ts` with all timing/spans/module-viz code**
  - Files: `packages/utils/src/timing.ts`
  - Change: Extract from `logger.ts` lines 208–672 into a new module. Move: `Span` interface, `ModuleTimingNode` interface, all constants (`LOGGED_TIMING_THRESHOLD_MS`, `MODULE_LOAD_PREFIX`, `MODULE_LOAD_VERBOSE_TOP`, `MODULE_TREE_MAX_DEPTH`, `MODULE_TREE_ROOT_TOP`, `MODULE_TREE_CHILD_TOP`), module state (`spanStorage`, `gRootSpan`, `gRecordTimings`), public functions (`startTiming`, `endTiming`, `time`, `printTimings`, `timingModeIncludes`, `shouldExitAfterTimings`, `openSpanPath`, `recordModuleLoadSpan`, `startupMarker`), and all internal helpers (`durationOf`, `selfTimeOf`, `fmtMs`, `isParallel`, `shortenLoadPath`, `isModuleLoadSpan`, `spliceModuleLoadBuffer`, `printSpan`, `printModuleLoadSummary`, `buildModuleTimingGraph`, `compareModuleNodes`, `renderModuleTimingNode`). Imports: `AsyncLocalStorage` from `node:async_hooks`, `fs` from `node:fs`, `isPromise` from `node:util/types`, `drainModuleLoadEvents` from `./timing-buffer`. No logic changes — pure extraction.
  - Acceptance: `bun check` passes; no type errors from moved symbols.

## Phase 2: Slim `logger.ts`
**Contract:** `logger.ts` keeps winston setup + `error/warn/info/debug/setTransports`. Re-exports timing symbols so `import { logger } from "@satopi/pi-utils"` and `import * as logger from "@satopi/pi-utils/logger"` still expose `logger.time(...)`, `logger.startTiming()`, etc.

- [ ] **Task: Remove moved code from `logger.ts` and add re-exports**
  - Files: `packages/utils/src/logger.ts`
  - Change: Delete lines 208–672 (everything from `startupMarker` JSdoc through end). Remove unused imports (`AsyncLocalStorage`, `fs`, `isPromise`, `drainModuleLoadEvents`). Add `export { time, startTiming, endTiming, printTimings, timingModeIncludes, shouldExitAfterTimings, openSpanPath, recordModuleLoadSpan, startupMarker } from "./timing";`.
  - Acceptance: `logger.ts` is ~150 lines (lines 1–207 only, plus re-exports). `bun check` passes. `import { logger } from "@satopi/pi-utils"` still provides `logger.error/warn/info/debug/time/startTiming/endTiming/setTransports`.

## Phase 3: Verify
**Contract:** All existing tests pass; no consumer breakage; deep import path `@satopi/pi-utils/logger` still works.

- [ ] **Task: Run existing logger tests**
  - Files: `packages/utils/test/logger-startup.test.ts`, `packages/utils/test/logger-no-transports.test.ts`, `packages/utils/test/logger-error-serialization.test.ts`
  - Change: Run `bun test` on the logger test files. These import via `@satopi/pi-utils/logger` and exercise `logger.time`, `logger.startTiming`, `logger.openSpanPath`, `logger.endTiming`, `logger.setTransports`, `logger.error`, `logger.warn`, `logger.info`, `logger.debug`.
  - Acceptance: All 3 test files pass with zero changes.

- [ ] **Task: Verify type-check and module resolution**
  - Files: `packages/utils/src/index.ts`, `packages/utils/src/logger.ts`, `packages/utils/src/timing.ts`
  - Change: Run `bun check` in `packages/utils`. Confirm `@satopi/pi-utils/logger` deep import resolves and exports all expected symbols (including re-exported timing functions).
  - Acceptance: `bun check` passes with zero errors. No new warnings.
