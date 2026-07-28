# Plan: 修复 SP-2, SP-3, SP-5（不含 SP-1, SP-4）

## Overview
基于 `satopi-holistic-audit-2026-07-28.md`，修复 SP-2（双执行路径未收敛）、SP-3（TUI 双主题体系）、SP-5（文档架构地图缺失）。SP-1（Mega-File 三巨头）和 SP-4（安全纵深不足）按用户要求暂不修复。

## Phase 1: SP-2 — 双执行路径收敛
**Contract:** 删除 swarm 中所有 legacy `runSubprocess` 路径，统一为 `AgentRuntime.spawn()`。

- [ ] **Task: curtain-runner.ts 切换至 AgentRuntime.spawn**
  - Files: `packages/coding-agent/src/swarm/curtain/curtain-runner.ts`
  - Change: `curtain-runner.ts` 当前在 line 307 使用 `streamAgentOutput()`（runSubprocess 封装）运行 reporter agent。改为通过注入的 `AgentRuntime` 调用 `runtime.spawn()`。需在 CurtainRunner 构造函数中增加 `#runtime: AgentRuntime` 字段，spawn 时构造 AgentSpec（id、role、task），等待 handle.wait() 获取结果。删除 `streamAgentOutput` import。
  - Acceptance: curtain-runner 不再 import `streamAgentOutput` 或 `runSubprocess`。`bun check` 零新错误。
  - Depends: none

- [ ] **Task: debate-roundtable.ts 移除 runSubprocess 降级路径**
  - Files: `packages/coding-agent/src/swarm/script/debate-roundtable.ts`
  - Change: 删除 line 16 的 `import { runSubprocess }` 和 line 17 的 `import type { AgentDefinition }`。删除 line 172-195 的 `runSubprocess(...)` 降级分支。将 `DebateRoundtableConfig.runtime` 从可选改为必需，构造函数中直接断言 `this.#runtime` 非空。参考已有 line 133-165 的 v3 spawn 路径。
  - Acceptance: debate-roundtable 不再 import `runSubprocess` 或 `AgentDefinition`。`bun check` 零新错误。
  - Depends: none

- [ ] **Task: executor.ts 标记废弃，清理无用导出**
  - Files: `packages/coding-agent/src/swarm/executor/executor.ts`, `packages/coding-agent/src/swarm/executor/index.ts`
  - Change: `executeSwarmAgent` 函数和 `SubprocessAgentExecutor` 类添加 `/** @deprecated Use AgentRuntime.spawn() instead. */` JSDoc 注释。保留函数体不动（现有测试和可能的 SDK 消费者仍依赖）。从 `index.ts` barrel export 中移除已无消费方的 export（保留 `TaskQueue`、`TodoTracker`、`AgentExecutor` 接口）。
  - Acceptance: `bun check` 零新错误。已确认的消费者（curtain-runner、debate-roundtable）不再引用 legacy 路径。
  - Depends: "curtain-runner.ts 切换至 AgentRuntime.spawn", "debate-roundtable.ts 移除 runSubprocess 降级路径"

- [ ] **Task: render/streaming.ts 标记废弃**
  - Files: `packages/coding-agent/src/swarm/render/streaming.ts`
  - Change: `streamAgentOutput` 函数和 `createStreamProgressHandler` 函数添加 `/** @deprecated Use AgentRuntime.spawn() + AgentHandle.bridgeToolEvents() instead. */` JSDoc 注释。保留函数体不动（executor.ts 的 executeSwarmAgent 内部仍引用 `createStreamProgressHandler`）。
  - Acceptance: `bun check` 零新错误。streaming.ts 函数均标记 @deprecated。
  - Depends: "curtain-runner.ts 切换至 AgentRuntime.spawn"

## Phase 2: SP-3 — TUI 双主题统一
**Contract:** Swarm dashboard 主题接入主 TUI 的 Theme 系统，硬编码 ANSI escape 替换为 Theme token。

- [ ] **Task: swarm dashboard theme.ts 改为 Theme interface 薄封装**
  - Files: `packages/coding-agent/src/modes/components/swarm/theme.ts`, `packages/coding-agent/src/modes/theme/theme.ts`
  - Change: 将 `sato` 对象的 chalk.hex() 函数改为接收 `Theme` 参数的工厂函数。导出一个 `createSatoTheme(theme: Theme): SatoThemeColors`，内部从 `theme.fg`/`theme.bg` 等读取颜色，用 chalk 做包装。`sato` 保留为默认导出（用于不需要 theme 的场景），但增加 `createSatoFromTheme()` 作为推荐路径。保持向后兼容：现有所有 `sato.success("text")` 调用继续有效。
  - Acceptance: swarm dashboard 可通过传入 `Theme` 实例来使用主 TUI 的颜色系统。`bun check` 零新错误。现有 dashboard 渲染输出不变。
  - Depends: none

- [ ] **Task: 硬编码 ANSI escape 替换为 Theme token**
  - Files: `packages/coding-agent/src/modes/components/segment-track.ts`, `packages/coding-agent/src/modes/components/diff.ts`, `packages/coding-agent/src/modes/components/welcome.ts`, `packages/coding-agent/src/modes/components/user-message.ts`, `packages/coding-agent/src/modes/components/status-line/component.ts`
  - Change: 将 8 个文件中直接写的 `\x1b[...m` ANSI escape 序列替换为 `theme.fg(...)` / `theme.bg(...)` / `theme.bold(...)` 等调用。对于确实需要 raw escape 的性能关键路径（如 segment-track 的 powerline 渲染），保留但添加注释说明为何绕过 Theme。优先级：welcome.ts 的 `gradientEscape` → 改为 Theme 驱动渐变；diff.ts 的 DIM/DIM_OFF → `theme.muted()`；user-message.ts 的 bold/underline → `theme.bold()` / `theme.underline()`。
  - Acceptance: 8 个文件中的裸 `\x1b[` 字符串减少 ≥80%。`bun check` 零新错误。`bun test` 渲染相关测试通过。
  - Depends: none

## Phase 3: SP-5 — 文档补完
**Contract:** 编写 ARCHITECTURE.md 架构地图，增强 CONTRIBUTING.md。

- [ ] **Task: 编写 ARCHITECTURE.md**
  - Files: `ARCHITECTURE.md`（新建，项目根目录）
  - Change: 编写架构地图文档，包含：(1) 总体架构图（packages 依赖关系 mermaid 图）；(2) coding-agent 内部子系统划分（session → tools → swarm → modes → cli 数据流）；(3) Rust-TS 桥接说明（pi-natives → crates）；(4) 关键文件索引（agent-session.ts、sdk.ts、interactive-mode.ts 等大文件的作用说明）；(5) 开发工作流（setup → dev → test → build）。参考已有 `docs/swarm-architecture-v3.md` 中 v3 六层架构图。控制在 5-8KB。
  - Acceptance: `ARCHITECTURE.md` 存在于项目根目录，包含 mermaid 架构图、子系统说明、文件索引。`bun check` 不检查 .md 文件。
  - Depends: none

- [ ] **Task: 增强 CONTRIBUTING.md**
  - Files: `CONTRIBUTING.md`
  - Change: 在现有 vouch 流程外增加：(1) 本地开发环境搭建（bun setup 前置条件）；(2) 代码规范概览（引用 AGENTS.md 的关键规则：`#private`、barrel exports、prompt 文件规范）；(3) 测试运行方法（`bun test <package>`）；(4) 提交前检查清单（bun check + bun test）。控制在 2-3KB 增量。
  - Acceptance: CONTRIBUTING.md 包含开发环境搭建、代码规范引用、测试运行、提交前检查清单四个新章节。
  - Depends: none

## Phase 4: 验证
**Contract:** 全量测试 + 类型检查。

- [ ] **Task: 全量回归验证**
  - Files: `packages/coding-agent/src/swarm/__tests__/`, `packages/coding-agent/test/`
  - Change: 运行 `bun check` 类型检查，运行 `bun test packages/coding-agent/src/swarm/__tests__/` 全量 swarm 测试。验证无回归。debate-roundtable 和 curtain-runner 的测试如果依赖 mock runSubprocess，需同步更新 mock 为 AgentRuntime。
  - Acceptance: `bun check` 零新错误，`bun test packages/coding-agent/src/swarm/__tests__/` ≤ 原有 3 个 pre-existing 失败（tui-panels.test.ts ANSI 渲染）。
  - Depends: Phase 1 + Phase 2 + Phase 3 全部完成
