# Plan: Refactor `packages/utils/src/logger.ts` — Split Logging & Timing

## Overview
`logger.ts` (673 lines) conflates three concerns: Winston-based structured logging, startup debug markers, and hierarchical performance timing with module-load graph rendering. Split it into focused modules while preserving the existing public API (`logger.*` namespace) and direct module-path imports (`@satopi/pi-utils/logger`).

## Phase 1: Extract Timing Module
**Contract:** New `timing.ts` exports every timing-related symbol currently in `logger.ts`; `logger.ts` re-exports them unchanged. No consumer sees a difference.

- [ ] **Task: Create `timing.ts` with all timing infrastructure**
  - Files: `packages/utils/src/timing.ts`
  - Change: Move Span interface, `time()`, `startTiming()`, `endTiming()`, `printTimings()`, `openSpanPath()`, `recordModuleLoadSpan()`, `timingModeIncludes()`, `shouldExitAfterTimings()`, `startupMarker()`, and all private helpers (durationOf, selfTimeOf, fmtMs, printSpan, printModuleLoadSummary, buildModuleTimingGraph, compareModuleNodes, renderModuleTimingNode, isParallel, spliceModuleLoadBuffer, shortenLoadPath, isModuleLoadSpan) from `logger.ts` into `timing.ts`. Also move `ModuleTimingNode` interface, module-load constants, and `LOGGED_TIMING_THRESHOLD_MS`.
  - Acceptance: `timing.ts` compiles independently; imports from `./timing-buffer` and `node:async_hooks` / `node:util/types` are correct.
  - Depends: none

- [ ] **Task: Re-export timing symbols from `logger.ts`**
  - Files: `packages/utils/src/logger.ts`
  - Change: Remove all moved code from `logger.ts`. Add `export * from "./timing"` so every timing export is still available under the `logger` namespace. Trim unused imports (`AsyncLocalStorage`, `isPromise`, `drainModuleLoadEvents`, `fs` used only by `ensureDir`/`startupMarker` — keep only what core logging needs).
  - Acceptance: `bun check` passes in `packages/utils`; `import * as logger from "@satopi/pi-utils/logger"` still exposes all timing symbols.
  - Depends: Create timing.ts

- [ ] **Task: Verify tests pass after split**
  - Files: `packages/utils/test/logger-startup.test.ts`, `packages/utils/test/logger-error-serialization.test.ts`, `packages/utils/test/logger-no-transports.test.ts`
  - Change: Run `bun test` in `packages/utils`. Existing tests import `logger` from the barrel or `@satopi/pi-utils/logger` — they must pass without modification. If any test needs a direct `timing` import path, update it.
  - Acceptance: All 3 logger test files pass; no regressions.
  - Depends: Re-export from logger.ts

## Phase 2: Cleanup & Verification
**Contract:** Cross-package consumers of `logger.time()`, `logger.error()`, etc. see zero behavior change.

- [ ] **Task: Verify cross-package consumers compile**
  - Files: `packages/coding-agent/src/main.ts`, `packages/coding-agent/src/sdk.ts`, `packages/coding-agent/src/system-prompt.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`
  - Change: Run `bun check` across the workspace. These files import `{ logger } from "@satopi/pi-utils"` and call `logger.error()`, `logger.time()`, `logger.startTiming()`, etc. — all must resolve.
  - Acceptance: `bun check` passes for the entire workspace; no TypeScript errors about missing exports.
  - Depends: Re-export from logger.ts

- [ ] **Task: Update CHANGELOG**
  - Files: `packages/utils/CHANGELOG.md`
  - Change: Add entry under `## [Unreleased]` → `### Changed` noting that `logger.ts` was split into `logging-core.ts` + `timing.ts` with backward-compatible re-exports.
  - Acceptance: Entry exists and is under correct section.
  - Depends: Verify cross-package consumers compile
