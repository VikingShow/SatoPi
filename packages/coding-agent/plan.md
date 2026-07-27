# Plan: Swarm Full Bridge — Phase 2 (交互完善)

## Overview
在 Phase 1 核心桥接基础上，补全三个交互能力：human steering（用户在 Stage 中向 worker 发消息）、applaud 机制（用户确认 Curtain 完成）、可选 plan debate（Script 阶段多 agent 评审 plan）。

## Phase 1: Steering 消息路由
**Contract:** `EmbeddedSwarmBridge.steer()` 将人类消息通过 CommBus 路由到活跃 worker；`SwarmDashboardOverlay` 暴露 `onSteering` 回调。

- [ ] **Task: Implement bridge.steer()**
  - Files: `src/swarm/core/embedded-swarm-bridge.ts`
  - Change: 调用 `this.#runtime.commBus.receiveFromHuman(message)` 将消息广播给所有通过 CommBus 连接的 agent；如果活跃 worker 存在特定 agentId，通过 IrcBus 定向投递
  - Acceptance: `steer()` 调用后 ActivityLogger 记录 "human" broadcast；消息通过 IrcBus 到达 StageController 中的 worker

- [ ] **Task: Add onSteering callback to SwarmDashboardOverlay**
  - Files: `src/modes/components/swarm/swarm-dashboard-overlay.ts`
  - Change: 在 `SwarmDashboardOverlayDeps` 中增加可选 `onSteering?: (message: string) => void`；在 `handleInput` 中检测 `/` 键进入 steering 模式，捕获后续输入后调用 `onSteering`
  - Acceptance: 用户在 dashboard 中按 `/` 后输入消息 → `onSteering` 被调用

- [ ] **Task: Wire dashboard steering to bridge in interactive-mode**
  - Files: `src/modes/interactive-mode.ts`
  - Change: `showSwarmDashboard()` 中传入 `onSteering: (msg) => this.session.embeddedSwarm?.steer(msg)`
  - Acceptance: dashboard `/` 输入 → bridge.steer() → CommBus → worker 收到消息

## Phase 2: Applaud 机制
**Contract:** Curtain 阶段结束时等待用户 applaud；用户在 TUI 中输入 "applaud" / "👍" / "完成" 触发 `bridge.applaud()`，或在超时后 auto-applaud。

- [ ] **Task: Add applaud input detection to interactive-mode**
  - Files: `src/modes/interactive-mode.ts`
  - Change: 在消息提交前检查 bridge 是否在 "curtain" phase 且 awaiting applaud；匹配 applaud 关键词时调用 `bridge.applaud()` 并取消消息提交
  - Acceptance: 用户在 curtain 阶段输入 "applaud" → bridge.applaud() → Curtain 完成 → FSM 转 idle

- [ ] **Task: Add auto-applaud timeout to bridge**
  - Files: `src/swarm/core/embedded-swarm-bridge.ts`
  - Change: 在 `#runCurtain()` 中，当 `autoApplaud` 为 true 时，跳过 `await new Promise` 等待，直接完成 Curtain；可选：即使 `autoApplaud` 为 false，也设置超时 timer（默认 5 分钟）后自动 applaud
  - Acceptance: `autoApplaud: true` 时 Curtain 无阻塞完成；`false` 时超时后自动完成

- [ ] **Task: Add Curtain status to status line**
  - Files: `src/modes/interactive-mode.ts`
  - Change: `showSwarmDashboard()` 或状态栏更新时，当 bridge phase 为 "curtain" 时显示 `[🐝 Swarm: Curtain · awaiting applaud]`
  - Acceptance: 状态栏在 Curtain 阶段显示正确文字

## Phase 3: Plan Debate (可选)
**Contract:** Script 阶段用户确认 plan 后，可选启动 `DebateRoundtable` 多 agent 评审，收敛后再进入 Stage。

- [ ] **Task: Wire debate-roundtable into bridge.confirmScript()**
  - Files: `src/swarm/core/embedded-swarm-bridge.ts`
  - Change: 在 `confirmScript()` 中，检查 `settings.get("magicKeywords.swarm.enableDebate")`；如果启用，调用 `debatePlan(planContent)` → 用 `agent_fork` 或 `AgentRuntime.spawnRoundtable()` 启动 2-3 agent 评审 → 收敛后更新 plan.md → 继续 transition 到 stage
  - Acceptance: `enableDebate: true` 时确认 plan 后启动 debate；debate 收敛后自动进入 Stage；debate 失败时通知用户
  - Depends: Steering 消息路由
