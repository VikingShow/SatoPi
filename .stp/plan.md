# Plan: EmbeddedSwarmBridge 完整接入 + TUI 统一

## Overview
修复 EmbeddedSwarmBridge 的胶水代码阻断，在 plan 确认阶段加入 S/P-agent 选择和推荐数量滑块，将 Stage/Curtain 进度接入主 TUI 现有 HUD（直接复用 `renderSubagentHudLines`），无需新增函数或改面板风格。

## Phase 1: Bridge 胶水代码 — plan.md 写入监听 + 确认触发
**Contract:** `agent-session.ts` 中新增 plan-write hook 和 agent_ask hook，驱动 `EmbeddedSwarmBridge.onPlanUpdated()` 和 `confirmScript()`。

- [ ] **Task: 监听 write 工具写入 plan.md 并通知 bridge**
  - Files: `packages/coding-agent/src/session/agent-session.ts`
  - Change: 在 `#createMagicKeywordNotices` 中（约 8165 行），`#initializeEmbeddedSwarm()` 之后，注册 `beforeToolCall` hook：当 `toolName === "write"` 且 path 匹配 `plan.md` 时，调用 `bridge.onPlanUpdated(content)`。取 content 从 tool args 的 `content` 字段。
  - Acceptance: agent 调用 `write("plan.md", ...)` 后，bridge 的 `isPlanReady()` 返回 true，FSM 状态可观测到变化。
  - Depends: none

- [ ] **Task: 监听 agent_ask 返回 "Launch Stage" 并触发 confirmScript**
  - Files: `packages/coding-agent/src/session/agent-session.ts`
  - Change: 注册 `afterToolCall` hook：当 `toolName === "ask"` 且返回结果匹配 `"Launch Stage"` 时，调用 `bridge.confirmScript()`。同时从 ask 参数中提取 S/P-agent 选择和 agent count 传入。
  - Acceptance: 用户选择 Launch Stage 后，FSM 转换到 stage，TUI 状态栏显示 swarm 进度。
  - Depends: "监听 write 工具写入 plan.md 并通知 bridge"

## Phase 2: Plan 确认 TUI — S/P-agent 选择 + 推荐数量滑块
**Contract:** `PlanReviewOverlay` 扩展 radioGroup 字段，复用已有 slider 机制。

- [ ] **Task: 在 showPlanReview 中增加 S/P-agent 选择项**
  - Files: `packages/coding-agent/src/modes/components/plan-review-overlay.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`
  - Change: `PlanReviewOverlayOptions` 新增 `radioGroup?: { labels: string[]; selectedIndex: number }` 字段，渲染为 `●`/`○` 单选组（位于 plan 内容和 action buttons 之间）。swarm 路径传入 `["Swift agents (task)", "Persistent agents (agent_invoke)"]`，默认 0。
  - Acceptance: plan 确认页显示 agent 类型单选组，上下键切换，选中项实心圆点。
  - Depends: Phase 1

- [ ] **Task: 复用 slider 实现推荐 agent 数量选择**
  - Files: `packages/coding-agent/src/modes/components/plan-review-overlay.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`
  - Change: 利用已有的 `HookSelectorSlider` 字段。swarm 路径从 `TaskComplexityAnalyzer.analyze()` 获取推荐值，构建 segments `[推荐-2, 推荐-1, 推荐, 推荐+1, 推荐+2]`，传入 slider。渲染在 radioGroup 和 action buttons 之间。
  - Acceptance: slider 显示推荐值，可 ←→ 调整，与现有 model-tier slider 外观一致。
  - Depends: "在 showPlanReview 中增加 S/P-agent 选择项"

- [ ] **Task: confirmScript 传递用户选择的 agent 类型和数量**
  - Files: `packages/coding-agent/src/session/agent-session.ts`
  - Change: `afterToolCall` hook 解析 ask 返回的完整 payload，提取 agentType 和 agentCount，传入 `bridge.confirmScript({ agentType, agentCount })`。bridge 存入 `#loopConfig` 传给 StageController。
  - Acceptance: StageController 使用用户指定的数量和类型启动 agent。
  - Depends: "在 showPlanReview 中增加 S/P-agent 选择项", "监听 agent_ask 返回 Launch Stage 并触发 confirmScript"

## Phase 3: Stage/Curtain 实时进度接入主 TUI HUD
**Contract:** 直接复用 `renderSubagentHudLines()`（已有 P-agent `thinkingMedium`/S-agent `accent` 颜色区分），无新函数。

- [ ] **Task: Stage 进度注入 status bar**
  - Files: `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/modes/components/status-line.ts`
  - Change: `StatusLineComponent` 新增 `swarmStatus?: string`。bridge FSM 进入 stage 时，通过 `fsm.onChange` 更新 `swarmStatus = "🐝 Stage · Wave ${n}/${total}"`。Curtain 时显示 `"🐝 Curtain"`。
  - Acceptance: 编辑器上方 status bar 实时显示 stage/curtain 进度。
  - Depends: Phase 1

- [ ] **Task: Swarm agent 状态接入 renderSubagentHudLines**
  - Files: `packages/coding-agent/src/modes/interactive-mode.ts`
  - Change: `renderSubagentHudLines` 已从 `ObserverRegistry` 读取 session 列表，已区分 `isPersistent`（`thinkingMedium` 色 vs `accent` 色）。无需改动该函数。在 Stage 执行期间，swarm-launched agent 通过 `AgentRuntime.spawn()` 创建 session 后自动注册到 `AgentRegistry` → `ObserverRegistry`，HUD 自动更新。
  - Acceptance: Stage 启动后，主 TUI 的 "Agents" HUD 自动显示 swarm worker，P-agent 用 `thinkingMedium` 色，S-agent 用 `accent` 色，与现有 subagent HUD 完全一致。
  - Depends: Phase 1

- [ ] **Task: Curtain 摘要输出到聊天区**
  - Files: `packages/coding-agent/src/modes/interactive-mode.ts`
  - Change: bridge FSM 进入 curtain 后，监听 `CurtainRunner` reporter 完成事件。将摘要以系统消息追加到聊天区（`theme.fg("accent", title)` + `theme.fg("muted", body)`）。
  - Acceptance: Curtain 完成后聊天区自动显示交付总结。
  - Depends: Phase 1
