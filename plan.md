# Plan: Delete unused swarm/splash.ts

## Overview
`swarm/splash.ts` (`renderSplash`) 已无 production 引用（之前被 setup wizard 使用，已移除）。删除文件及其测试，避免死代码。

## Phase 1: Delete dead code

- [ ] **Task: Remove swarm/splash.ts and its tests**
  - Files: `packages/coding-agent/src/modes/components/swarm/splash.ts`, `packages/coding-agent/src/swarm/__tests__/tui-theme.test.ts`
  - Change: Delete both files. No other files import `renderSplash` or reference `swarm/splash`.
  - Acceptance: `bun check` and `bun test` pass without the deleted files

## Phase 2: Verify

- [ ] **Task: Run full test suite**
  - Files: `packages/coding-agent/`
  - Change: Run `bun test`
  - Acceptance: No new failures from deleted files
  - Depends: Remove swarm/splash.ts and its tests
