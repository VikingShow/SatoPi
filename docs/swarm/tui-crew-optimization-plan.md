# TUI Crew 模式优化计划

> 日期: 2026-07-31
> 状态: 已批准实施（Phase 0 文档 / Phase 1 Crew UI / Phase 2 链路补全）
> 依据: 三轮代码调研（slash 链路、魔法词机制、运行时链路、TUI 布局/焦点/输入）

## 1. 现状结论

| 问题 | 根因 | 证据 |
|------|------|------|
| 全屏只显示顶部小块 | `CrewTranscriptView.render()` 内容自适应（≈9 行 chrome + 最多 15 条消息）；overlay 引擎 `maxHeight` 只截断不撑满 | `crew-transcript-view.ts:83-177`;`packages/tui/src/tui.ts:2351-2419, 2491-2510` |
| 主输入框不可用 | `fullscreen: true` 触发 alt screen 只画 overlay；`showOverlay` 抢焦点且 `setFocus` 重定向；`handleInput` 吞掉全部按键 | `tui.ts:1348-1389, 2666-2682, 2316-2324`;`interactive-mode.ts:4811-4817` |
| crew 输入路由是死代码 | 路由已存在（`input-controller.ts:791→handleUserInput`），但 editor 在 alt screen 下不可见不可聚焦 | `input-controller.ts:791-797` |
| `DEBATING/CONVERGED` 假状态 | `converged:false / totalRounds:1` 创建时写死，`updateState()` 零调用者 | `swarm-mode-controller.ts:317-327` |
| 状态栏 `[main:running]-[scout:parked]-+1 more` | `#swarmAgentStatusText`，MAX_VISIBLE=3 | `status-line/component.ts:1156-1187` |
| Ctrl+B 是小框 | overlay 宽度 35% + 内容高度（≤20 行）+ 垂直居中 | `interactive-mode.ts:4742-4745`;`swarm-sidebar.ts` |
| Esc 判定脆弱 | 裸 `data === "\x1b"` 比较，kitty 下收到 `\x1b[27u` | `crew-transcript-view.ts:153`;`agent-transcript-viewer.ts:463` |
| `/graph theatre` 假 attach | `SwarmModeControllerDeps.orchestrator` 从未传入，只写 `crew.state.activeGraph` | `interactive-mode.ts:855-872` |
| Crew 成员能力受限 | 全员 `availableModels[0]` + 工具仅 read/grep/glob | `swarm-mode-controller.ts:443-467` |

## 2. 设计目标（用户确认）

- `/swarm start` = **human 直接参与的 crew 群聊**，默认无 graph；`swarm` 魔法词保持 graph 工作流（分工不变）。
- Crew 页面 = 普通聊天的延伸：transcript 占主体、底部复用主输入框（单 composer）、Ctrl+B 侧边栏全高承载成员管理。
- 状态栏只留摘要，agent 明细归 Ctrl+B / Ctrl+S。
- 文档：更新 AGENTS.md 为真实架构；归档过时设计文档。

## 3. 目标布局

```
┌──────────────────────────────────────────────┐
│ 状态栏: ◆ crew: name [3 agents] · 模型 · 路径… │
├───────────────────────┬──────────────────────┤
│ Crew Transcript 主体  │ Ctrl+B SwarmSidebar  │
│ Topic · Rounds: N     │ (40% 宽, 全高)        │
│ · X/Y replying        │ 成员树 · 加/删成员    │
│ 滚动消息流             │ unread dots          │
│ (j/k 滚动, 可回看)     │                      │
├───────────────────────┴──────────────────────┤
│ 主输入框 CustomEditor（复用, Enter → 群聊路由） │
└──────────────────────────────────────────────┘
```

## 4. Phase 1 — Crew 群聊 UI 改造（已实施）

### 4.1 布局：去 fullscreen + 撑满可用高度 + 滚动

- `interactive-mode.ts #mountCrewView`：去掉 `fullscreen: true`，普通 overlay（top-left / 100% / maxHeight 计算保留编辑器区）。
- `CrewTranscriptView.render()`：按 `process.stdout.rows` 预算高度 pad（fillHeight 先例 `session-selector.ts:956-960`），滚动窗口替代 `slice(-15)`，新增 `#scrollOffset` 与 `scrollBy()`。

### 4.2 输入：复用主输入框（单 composer）

- `CrewTranscriptView implements OverlayFocusOwner`（`tui.ts:184-188`），mount 后 `ui.setFocus(this.editor)`。
- 按键仲裁（先例 `agent-transcript-viewer.ts:442-491`）：编辑器为空时 Esc/j/k/f/t/r 归视图；非空时归编辑器。
- 输入链路零新代码：`input-controller.ts:791-796` 现有 crew 分支直接复活。

### 4.3 状态动态化

- `totalRounds` 动态：human 消息开启新一轮（round = max+1），agent 回复沿用该轮；每轮结束 `updateState({ totalRounds })`。
- `CONVERGED/DEBATING` 假 badge 改为成员活动状态：`Rounds: N · X/Y replying`（running 数来自 AgentRegistry）。

### 4.4 状态栏

- 删除 `#swarmAgentStatusText` 及调用点；保留 swarm 段（`◆ crew: name [N agents]` / phase + counts）与 `#subagentBadgeText`。
- `SwarmStatusBar` 不动（crew 模式 phase=idle 不显示，workflow 模式继续用）。

### 4.5 Ctrl+B 侧边栏

- fillHeight pad 到终端行数，`maxVisible` 由 `process.stdout.rows` 推导。
- 默认宽度 35%→40%，`MAX_SIDEBAR_WIDTH_PCT` 60，保留 Ctrl+←/→ 调整。

## 5. Phase 2 — 链路补全（后续）

| 项 | 现状 | 动作 |
|----|------|------|
| `/graph theatre` 假 attach | orchestrator 依赖未注入 | 真正注入接线，或临时明确报错，不假装成功 |
| Crew 成员能力 | 模型/工具受限 | 按 profile 分配模型；成员至少需要 edit/bash |
| 死代码清理 | stage-controller、role-roundtable、VerificationHook 导出、`swarm.engine` 死设置、`stp swarm resume` 占位、孤儿组件 | 按 refactoring-plan 剩余项逐条删除 |
| 魔法词链路缺陷 | 双 `beforeToolCall` 注册竞态、`#embeddedSwarm` 跨 run 复用 | 单例注册 + 每次 run 重建 bridge |

## 6. 验证

- `bun check` + swarm 相关测试（`swarm/__tests__/*`）。
- 手动 smoke：`/swarm start` → 选 2+ profiles → crew 视图铺满、主输入框可输入、Enter 后消息进 transcript、空编辑器 Esc 关闭、Ctrl+B 全高侧边栏、状态栏无 agent tree、kitty 下 Esc 正常。
- CHANGELOG 更新。
