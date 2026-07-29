# Plan: Refactor Logger Module

## Overview
Split `packages/utils/src/logger.ts` (673-line monolith) into focused modules under `packages/utils/src/logger/` while preserving the exact public API. The file currently mixes four concerns: winston-based structured logging, startup markers, a hierarchical timing/profiling system, and module-load timing rendering.

## Phase 1: Foundation — Extract Core Logging
**Contract:** `packages/utils/src/logger/core.ts` exports `error`, `warn`, `info`, `debug`, `setTransports` with identical signatures. Re-exported through `packages/utils/src/logger/index.ts`.

- [ ] **Task: Extract core logging to `logger/core.ts`**
  - Files: `packages/utils/src/logger/core.ts`, `packages/utils/src/logger.ts`
  - Change: Move winston setup (`getLogFormat`, `makeFileTransport`, `makeConsoleTransport`, `buildTransports`, `getWinstonLogger`), transport options, `setTransports`, and the four log functions (`error`, `warn`, `info`, `debug`) into `logger/core.ts`. Move `jsonReplacer` and `ensureDir` there too (internal). Remove moved code from `logger.ts`.
  - Acceptance: `bun check` passes; existing logger tests pass (`logger-error-serialization.test.ts`, `logger-no-transports.test.ts`).
  - Depends: none

- [ ] **Task: Extract startup marker to `logger/startup-marker.ts`**
  - Files: `packages/utils/src/logger/startup-marker.ts`, `packages/utils/src/logger.ts`
  - Change: Move `startupMarker` function into its own module. Uses `fs.writeSync(2, ...)` for synchronous stderr (deliberate — must survive event-loop stalls).
  - Acceptance: `bun check` passes; `logger-startup.test.ts` startup-marker tests pass.
  - Depends: none

## Phase 2: Extract Timing System
**Contract:** `packages/utils/src/logger/timing.ts` exports `time`, `startTiming`, `endTiming`, `printTimings`, `recordModuleLoadSpan`, `openSpanPath`, `timingModeIncludes`, `shouldExitAfterTimings` with identical signatures and behavior.

- [ ] **Task: Extract timing system to `logger/timing.ts`**
  - Files: `packages/utils/src/logger/timing.ts`, `packages/utils/src/logger.ts`
  - Change: Move `Span` interface, `spanStorage`, `gRootSpan`, `gRecordTimings`, `startTiming`, `endTiming`, `time` (all three overloads), `printTimings`, `recordModuleLoadSpan`, `openSpanPath`, `timingModeIncludes`, `shouldExitAfterTimings`, and all internal helpers (`printSpan`, `printModuleLoadSummary`, `buildModuleTimingGraph`, `renderModuleTimingNode`, `compareModuleNodes`, `isParallel`, `spliceModuleLoadBuffer`, `shortenLoadPath`, `durationOf`, `selfTimeOf`, `fmtMs`, `isModuleLoadSpan`, `ModuleTimingNode`). Keep `timing-buffer.ts` unchanged (its separation is intentional — avoids winston in the preload).
  - Acceptance: `bun check` passes; all `logger-startup.test.ts` timing tests pass (`time()` point/phase/fail/silent/promise/async nesting, `printTimings` output shape, `openSpanPath`, `timingModeIncludes`).
  - Depends: none

## Phase 3: Wire the Barrel and Finalize
**Contract:** `packages/utils/src/logger/index.ts` re-exports the identical public API surface that `packages/utils/src/logger.ts` exported before. `packages/utils/src/index.ts` continues `export * as logger from "./logger"` — the file resolution now hits `logger/index.ts` instead of `logger.ts`.

- [ ] **Task: Create barrel index and clean up**
  - Files: `packages/utils/src/logger/index.ts`, `packages/utils/src/logger.ts`
  - Change: Create `logger/index.ts` that re-exports all public symbols from `core.ts`, `startup-marker.ts`, and `timing.ts`. Delete the original `logger.ts` (or reduce to a re-export shim pointing at `./logger/index`). Update `packages/utils/src/index.ts` barrel if needed — it currently does `export * as logger from "./logger"` which Bun/node will resolve to `./logger/index.ts` automatically once `./logger.ts` becomes `./logger/index.ts`.
  - Acceptance: `bun check` passes; full logger test suite passes; `grep` confirms no stale direct imports of `./logger` (all consumers import `{ logger } from "@satopi/pi-utils"`).
  - Depends: Extract core logging to `logger/core.ts`, Extract startup marker to `logger/startup-marker.ts`, Extract timing system to `logger/timing.ts`

- [ ] **Task: Remove `fs.existsSync`/`fs.mkdirSync` anti-pattern**
  - Files: `packages/utils/src/logger/core.ts`
  - Change: Replace `ensureDir`'s `fs.existsSync(dir)` + `fs.mkdirSync(dir, { recursive: true })` with `fs.mkdirSync(dir, { recursive: true })` alone — `recursive: true` is a no-op when the directory already exists, so the `existsSync` check is redundant. This is still sync (required because `DailyRotateFile` constructor is sync), but removes the TOCTOU race and the double syscall.
  - Acceptance: `bun check` passes; logger tests pass; `logger-no-transports.test.ts` still cleans up its temp dir.
  - Depends: Extract core logging to `logger/core.ts`

## Phase 4: Verification
**Contract:** The refactored logger is a drop-in replacement — all 279+ call sites across the monorepo continue to work unchanged.

- [ ] **Task: Run full logger test suite and type-check**
  - Files: `packages/utils/test/logger*.test.ts`
  - Change: Run `bun test packages/utils/test/logger-startup.test.ts packages/utils/test/logger-no-transports.test.ts packages/utils/test/logger-error-serialization.test.ts` and `bun check`.
  - Acceptance: All tests pass; `bun check` zero errors.
  - Depends: Create barrel index and clean up, Remove `fs.existsSync`/`fs.mkdirSync` anti-pattern

- [ ] **Task: Smoke test: verify logger works at runtime**
  - Files: `packages/utils/src/logger/index.ts`
  - Change: Run a quick smoke script that imports `logger`, calls `logger.info("smoke")`, `logger.warn("smoke")`, `logger.error("smoke")`, `logger.debug("smoke")`, `logger.setTransports({ console: true, file: false })`, and verifies a log file is written.
  - Acceptance: Smoke script runs without errors; log file contains the expected entries.
  - Depends: Run full logger test suite and type-check
