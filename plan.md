# Plan: Split monolithic logger.ts into log-core + timing

## Overview
Split `packages/utils/src/logger.ts` (673 lines) into two focused modules — `log-core.ts` (Winston-based logging) and `timing.ts` (span profiling) — under a `logger/` directory, with a thin backward-compatible shim preserving the existing namespace API and direct subpath imports.

## Phase 1: Extract log-core and timing modules
**Contract:** `logger/log-core.ts` exports logging functions; `logger/timing.ts` exports timing functions; `logger/index.ts` barrel re-exports both; `logger.ts` re-exports from `./logger/index.ts`.

- [ ] **Task: Create logger/log-core.ts with Winston logging**
  - Files: `packages/utils/src/logger/log-core.ts`
  - Change: Extract from `logger.ts`: `ensureDir`, `jsonReplacer`, `getLogFormat`, `makeFileTransport`, `makeConsoleTransport`, `buildTransports`, `getWinstonLogger`, `setTransports`, `error`, `warn`, `info`, `debug`, `startupMarker`, plus module-level state (`logFormat`, `transportOpts`, `winstonLogger`). Imports: `winston`, `winston-daily-rotate-file`, `getLogsDir` from `../dirs`. Export all public functions and `setTransports`. Keep internal helpers private (unexported).
  - Acceptance: File compiles; exports `error`, `warn`, `info`, `debug`, `setTransports`, `startupMarker`.

- [ ] **Task: Create logger/timing.ts with span profiling**
  - Files: `packages/utils/src/logger/timing.ts`
  - Change: Extract from `logger.ts`: `Span` interface, `ModuleTimingNode` interface, all timing constants, `spanStorage`, `gRootSpan`, `gRecordTimings`, `time`, `startTiming`, `endTiming`, `printTimings`, `openSpanPath`, `shouldExitAfterTimings`, `timingModeIncludes`, `recordModuleLoadSpan`, and all internal helpers (`spliceModuleLoadBuffer`, `shortenLoadPath`, `durationOf`, `selfTimeOf`, `fmtMs`, `isModuleLoadSpan`, `printSpan`, `printModuleLoadSummary`, `buildModuleTimingGraph`, `compareModuleNodes`, `renderModuleTimingNode`, `isParallel`). Import `startupMarker` from `./log-core`, `drainModuleLoadEvents` from `../timing-buffer`, `AsyncLocalStorage` from `node:async_hooks`, `isPromise` from `node:util/types`. Export only the public API functions.
  - Acceptance: File compiles; exports `time`, `startTiming`, `endTiming`, `printTimings`, `openSpanPath`, `shouldExitAfterTimings`, `timingModeIncludes`.

- [ ] **Task: Create logger/index.ts barrel and update logger.ts shim**
  - Files: `packages/utils/src/logger/index.ts`, `packages/utils/src/logger.ts`
  - Change: Create `logger/index.ts` with `export * from "./log-core"` and `export * from "./timing"`. Rewrite `logger.ts` to `export * from "./logger/index"` — a thin re-export shim preserving the `@satopi/pi-utils/logger` subpath resolution. The package barrel (`src/index.ts`) line `export * as logger from "./logger"` stays unchanged.
  - Acceptance: `import { logger } from "@satopi/pi-utils"` gives `logger.error()`, `logger.time()`, etc. `import { setTransports } from "@satopi/pi-utils/logger"` resolves. `import * as logger from "@satopi/pi-utils/logger"` gives full namespace.

## Phase 2: Verification
**Contract:** All existing tests pass, type check passes.

- [ ] **Task: Run tests and type check**
  - Files: `packages/utils/test/logger-startup.test.ts`, `packages/utils/test/logger-no-transports.test.ts`, `packages/utils/test/logger-error-serialization.test.ts`
  - Change: Run `bun test` in `packages/utils` and `bun check` across the workspace.
  - Acceptance: All 3 logger tests pass. `bun check` passes workspace-wide with no new errors.
  - Depends: Create logger/index.ts barrel and update logger.ts shim
