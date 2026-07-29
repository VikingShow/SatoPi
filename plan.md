# Plan: Split logger.ts + Replace Winston with Bun-native logging

## Overview
`packages/utils/src/logger.ts` (673 lines) fuses two unrelated concerns and pulls in heavy dependencies (`winston`, `winston-daily-rotate-file`). This plan extracts timing/span-tree code into `timing.ts`, then replaces Winston's ~200KB dependency tree with a ~150-line Bun-native implementation that uses `Bun.write`, `Bun.file`, and `Bun.gzipSync` for file rotation, console output, and JSON formatting — keeping the identical public API.

## Phase 1: Extract timing.ts
**Contract:** `timing.ts` exports `time`, `startTiming`, `endTiming`, `printTimings`, `shouldExitAfterTimings`, `openSpanPath`, `timingModeIncludes`, `recordModuleLoadSpan`. `logger.ts` re-exports all of them so existing `logger.time()` callsites are untouched.

- [ ] **Task: Create timing.ts**
  - Files: `packages/utils/src/timing.ts`
  - Change: Move all timing-related code from `logger.ts` into new `timing.ts`: `Span` interface, `ModuleTimingNode`, constants (`LOGGED_TIMING_THRESHOLD_MS`, `MODULE_LOAD_*`), `spanStorage`/`gRootSpan`/`gRecordTimings`, `time()`, `startTiming()`, `endTiming()`, `printTimings()`, `timingModeIncludes()`, `shouldExitAfterTimings()`, `openSpanPath()`, `recordModuleLoadSpan()`, and all private helpers (`shortenLoadPath`, `durationOf`, `selfTimeOf`, `fmtMs`, `isModuleLoadSpan`, `printSpan`, `printModuleLoadSummary`, `buildModuleTimingGraph`, `compareModuleNodes`, `renderModuleTimingNode`, `isParallel`). Import `startupMarker` from `./logger` and `drainModuleLoadEvents` from `./timing-buffer`.
  - Acceptance: `bun check` passes on `timing.ts`; file exports all 8 public timing functions; no winston imports.

- [ ] **Task: Slim logger.ts to logging-only + add timing re-exports**
  - Files: `packages/utils/src/logger.ts`
  - Change: Remove all timing/span code (lines ~209-673). Add `export * from "./timing"` at top (after imports). Keep: `ensureDir`, `jsonReplacer`, `logFormat`/`getLogFormat`, transport builders, `setTransports`, `error`/`warn`/`info`/`debug`, `startupMarker`. Remove imports only timing needed (`AsyncLocalStorage`, `isPromise`, `drainModuleLoadEvents`).
  - Acceptance: `bun check` passes; `logger.error/warn/info/debug/setTransports/startupMarker` still work; `logger.time/startTiming/printTimings` accessible via re-export.

## Phase 2: Replace Winston with Bun-native transports
**Contract:** Identical public API (`setTransports`, `error`, `warn`, `info`, `debug`, `startupMarker`). Same JSON format (`{"timestamp":"...","level":"...","pid":...,"message":"...",...metadata}`). Same file rotation behavior (daily, 10MB max, 5 files, gzipped archive). Console transport writes same JSON to stdout. No external dependencies.

- [ ] **Task: Rewrite logger.ts core with Bun-native transports**
  - Files: `packages/utils/src/logger.ts`
  - Change: Remove all winston imports and references. Implement:
    - `FileTransport`: on each write, open `stp.YYYY-MM-DD.log` in append mode via `Bun.file(path)` + `Bun.write`. Track current date and file size. When date changes OR size exceeds 10MB, rotate: close current, rename old to `stp.YYYY-MM-DD.N.log`, gzip with `Bun.gzipSync`, delete files beyond 5 (oldest by mtime). Use `fs.promises` for stat/rename/readdir/unlink.
    - `ConsoleTransport`: write JSON line to `process.stdout`.
    - `jsonReplacer` — keep existing; it already handles Error unwrapping correctly.
    - `formatEntry(level, message, context?)` — builds the same JSON structure winston's printf did: `{ timestamp, level, pid, message, ...flattened context }`.
    - Keep `setTransports()` API: `{ console?: boolean; file?: boolean | string }`. Rebuild transport list on change.
    - Keep `startupMarker()` — unchanged (it already uses raw `fs.writeSync(2)`).
  - Acceptance: `bun check` passes; `winston` and `winston-daily-rotate-file` no longer imported; `setTransports`, `error`, `warn`, `info`, `debug`, `startupMarker` all exported and functional.

- [ ] **Task: Remove winston dependencies from package.json**
  - Files: `packages/utils/package.json`
  - Change: Remove `"winston": "catalog:"` and `"winston-daily-rotate-file": "catalog:"` from `dependencies`.
  - Acceptance: `bun install` succeeds with no winston in `node_modules/@satopi/pi-utils` resolution; `bun check` passes.

## Phase 3: Update barrel and tests
**Contract:** `import { logger } from "@satopi/pi-utils"` and `import * as logger from "@satopi/pi-utils/logger"` both work for all logging + timing functions. New `import { timing } from "@satopi/pi-utils"` available.

- [ ] **Task: Update barrel index.ts**
  - Files: `packages/utils/src/index.ts`
  - Change: Add `export * as timing from "./timing"` after the existing `export * as logger from "./logger"` line.
  - Acceptance: `import { timing } from "@satopi/pi-utils"` works; `timing.time()` accessible.

- [ ] **Task: Update logger tests for Bun-native transports**
  - Files: `packages/utils/test/logger-startup.test.ts`, `packages/utils/test/logger-no-transports.test.ts`, `packages/utils/test/logger-error-serialization.test.ts`
  - Change:
    - `logger-startup.test.ts`: change `import * as logger from "@satopi/pi-utils/logger"` to `import * as timing from "@satopi/pi-utils/timing"`, update references (`logger.time` → `timing.time`, `logger.startTiming` → `timing.startTiming`, `logger.endTiming` → `timing.endTiming`, `logger.openSpanPath` → `timing.openSpanPath`). `startupMarker` still imports from `logger`.
    - `logger-no-transports.test.ts`: update to not depend on winston internals. Test that `setTransports({ file: false, console: false })` produces no output and no warnings. Test that re-enabling file transport resumes writing. Replace `omp.` prefix with `stp.` in filename filter if needed.
    - `logger-error-serialization.test.ts`: same pattern — test that error serialization works through Bun-native path. Replace `omp.` with `stp.` prefix if needed.
  - Acceptance: All three test files pass with `bun test`.

- [ ] **Task: Add timing.ts unit tests**
  - Files: `packages/utils/test/timing.test.ts` (new)
  - Change: Move timing-specific tests from `logger-startup.test.ts` (the `openSpanPath` tests). Add basic contract tests: `startTiming()` is idempotent, `time()` returns fn result, `time()` nests spans, `endTiming()` clears state, `printTimings()` output contains expected markers.
  - Acceptance: `bun test packages/utils/test/timing.test.ts` passes.

## Phase 4: Verify full integration
**Contract:** No breakage across the monorepo. All 262+ `logger.*` call sites continue to work. Deep imports from `@satopi/pi-utils/logger` still resolve both logging and timing functions.

- [ ] **Task: Run full verification**
  - Files: All packages
  - Change: Run `bun check` across the monorepo. Run full utils test suite (`bun test packages/utils/test/`). Verify deep imports work: `import { setTransports } from "@satopi/pi-utils/logger"` (used by `auth-broker-cli.ts`), `import * as logger from "@satopi/pi-utils/logger"` (used by 4 test files). Smoke test: `import { logger, timing } from "@satopi/pi-utils"` both resolve.
  - Acceptance: `bun check` passes repo-wide; all utils tests pass; all direct-logger-import consumers compile.
  - Depends: All Phase 1-3 tasks
