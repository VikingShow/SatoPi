# Plan: Swarm 优先改进路线图

## Overview
基于五维度设计评估报告（综合 6.5/10），按 P0→P1→P2 优先级修复 18 项问题。目标：P0 修复后达生产内部部署标准，P1 后达 7.5/10，P2 后达 8+/10。改进按跨维度依赖关系编排为 6 个 phase，phase 内任务可并行。

## Phase 1: P0 生产阻塞修复
**Contract:** 4 项相互独立的修复，完成后 swarm 可在内部生产部署

- [ ] **Task: 修复 confirmScript fire-and-forget abort chain**
  - Files: `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`
  - Change: `confirmScript()` 中 `#startStage()` 由 fire-and-forget 改为 await；或在 `dispose()` 中显式链接 stage 的 AbortController，确保 dispose 能真正中止运行中的 stage。当前问题：dispose 创建新 AbortController，stage 持有的是旧快照。
  - Acceptance: `bridge.dispose()` 后 stage 内所有 agent 被中止，无僵尸 agent 继续消费 API
  - Depends: —

- [ ] **Task: 修复 Checkpoint 写入静默失败**
  - Files: `packages/coding-agent/src/swarm/graph/checkpoint.ts`
  - Change: `writeCheckpoint()` 不再 fire-and-forget；追加写入失败时 propagate error 或至少 log error 级别；`recoverState()` 验证 JSON parse 成功并 log 损坏条目
  - Acceptance: 磁盘满时 checkpoint 写入失败被显式上报（logger.error），恢复时损坏行被 skip 并记录
  - Depends: —

- [ ] **Task: 显示 Swarm mode entry 状态**
  - Files: `packages/coding-agent/src/session/agent-session.ts`
  - Change: 当 `#initializeEmbeddedSwarm()` 完成后，注入一条可见系统消息到 chat：`"🐝 Swarm orchestration mode active — the agent will plan then ask for your approval."`。在 status line 添加 swarm 模式指示器
  - Acceptance: 用户输入 swarm 关键词后，chat 中可见模式进入确认消息
  - Depends: —

- [ ] **Task: 解耦 "Launch Stage" 字符串匹配**
  - Files: `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/prompts/system/swarm-notice.md`
  - Change: 将 `#swarmAfterToolCall` 中的 `selected.includes("Launch Stage")` 替换为类型化 intent。方案：扩展 ask 工具的 details 结构，添加 `intent?: "launch_stage" | "revise_plan" | "cancel"` 字段，swarm-notice.md 指示模型使用该字段
  - Acceptance: 模型输出 "Begin Execution" 或其他变体时仍能正确触发 Stage（不再依赖精确字符串匹配）
  - Depends: —

## Phase 2: P1 基础设施整合
**Contract:** 提取共享代码，消除重复，为后续修复提供统一基础。必须先于 Phase 3-4 完成

- [ ] **Task: 提取共享基础设施工厂 SwarmInfra**
  - Files: `packages/coding-agent/src/swarm/core/swarm-infra.ts`（新建）, `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`, `packages/coding-agent/src/swarm/graph/graph-runner.ts`
  - Change: 新建 `createSwarmInfra()` 工厂，将两个 orchestrator init() 中的 ~70 行重复初始化（SwarmSessionManager、StateTracker、ActivityLogger、ExperienceStore、WorkflowFSM、RoleAssetManager、LoopConfig）统一提取。EmbeddedSwarmBridge.init() 和 GraphRunner.init() 调用此工厂后各自追加特殊逻辑
  - Acceptance: 两个 init() 方法各减少 ~50 行，共享初始化逻辑只有一处
  - Depends: —

- [ ] **Task: 提取 Curtain 过渡 helper**
  - Files: `packages/coding-agent/src/swarm/core/curtain-transition.ts`（新建）, `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`, `packages/coding-agent/src/swarm/graph/graph-runner.ts`
  - Change: 新建 `transitionToCurtainAndIdle()` 函数，封装三处重复的 curtain pipeline 代码（构建 agentResults map、调用 runCurtainPipeline、FSM → idle）。三个调用点替换为一行函数调用
  - Acceptance: 三处 ~40 行代码块各缩减为 ~3 行函数调用
  - Depends: 提取共享基础设施工厂 SwarmInfra

## Phase 3: P1 错误处理全量修复
**Contract:** 替换所有无声错误吞噬为结构化遥测，消除 fire-and-forget 异步模式

- [ ] **Task: 替换全局 silent .catch(() => {}) 为遥测**
  - Files: `packages/coding-agent/src/swarm/stage/stage-controller.ts`, `packages/coding-agent/src/swarm/core/workflow-fsm.ts`, `packages/coding-agent/src/swarm/curtain/experience.ts`, `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`, `packages/coding-agent/src/swarm/behaviors/stage-behavior.ts`, `packages/coding-agent/src/swarm/executor/executor.ts`, `packages/coding-agent/src/swarm/script/script-manager.ts`
  - Change: 全量审查 swarm/ 目录下所有 `.catch(() => {})`（15+ 处）。每处替换为 logger.error 记录 + 递增错误计数器。在 StageResult 中新增 `degradedMode: string[]` 字段供调用方感知降级状态
  - Acceptance: 零 silent catch，所有错误至少 log 级别；`bun check` 通过
  - Depends: —

- [ ] **Task: 修复 void 触发的 async hooks**
  - Files: `packages/coding-agent/src/swarm/stage/stage-controller.ts`
  - Change: `void this.#opts.hookPipeline?.trigger(...)` 两处（line 530, 561）改为 `await` 或链式 `.catch(err => logger.error(...))`
  - Acceptance: hook pipeline 触发失败不被静默丢弃
  - Depends: —

- [ ] **Task: 添加 FSM 过渡历史审计 trail**
  - Files: `packages/coding-agent/src/swarm/core/workflow-fsm.ts`
  - Change: 在 `#apply()` 中每次过渡成功后调用 `this.#activityLogger.logPhase()` 记录 from→to + reason + iteration + timestamp。同步写入 StateTracker
  - Acceptance: 每次 FSM 过渡在 ActivityLogger 和 StateTracker 中有完整记录
  - Depends: —

- [ ] **Task: 修复 AgentLauncher 提前返回 session**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts`
  - Change: `launch()` 方法中 `#startAgent(session, spec).catch(...)` 改为 await；如果 `prompt()` 失败则 throw 而非返回僵尸 session
  - Acceptance: AgentLauncher.launch() 返回的 session 保证已成功启动，调用方不会收到永无输出的 session
  - Depends: —

## Phase 4: P2 架构清理
**Contract:** 开放扩展点注册机制，接线 PhaseBehavior 和 CommBus，补齐架构 spec 与实现的 gap

- [ ] **Task: 开放 Phase Registry（string-based Chapter）**
  - Files: `packages/coding-agent/src/swarm/core/state.ts`, `packages/coding-agent/src/swarm/core/workflow-fsm.ts`
  - Change: `Chapter` 从 closed union type 改为 `string`（或 branded type），新增 `PhaseRegistry` 类支持运行时注册。`selectNodeBehavior` switch 替换为 `Map<Chapter, NodeBehaviorFactory>`
  - Acceptance: 新增 phase 只需注册 PhaseDefinition + PhaseBehavior，不需修改 union type 和 switch
  - Depends: —

- [ ] **Task: 接线 PhaseBehavior 到 orchestrator**
  - Files: `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`, `packages/coding-agent/src/swarm/graph/graph-runner.ts`
  - Change: EmbeddedSwarmBridge.confirmScript() 和 GraphRunner.confirmScript() 中的内联 phase 逻辑委托给 PhaseBehavior.enter()/checkCompletion()/exit()。ScriptBehavior、StageBehavior、CurtainBehavior 已存在且已测试——只需接线
  - Acceptance: 两个 orchestrator 不再包含内联 phase 逻辑，全部委托给 PhaseBehavior
  - Depends: 开放 Phase Registry

- [ ] **Task: 接线 CommBus 到 AgentRuntime 热路径**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/index.ts`, `packages/coding-agent/src/swarm/comm-bus/`
  - Change: AgentRuntime 中的原始 IrcBus 队列（`#steeringQueues`、`#asideQueues`、`#followUpQueues`）替换为 CommChannel/directChannel/roundtable/vote 封装。CommBus 代码已存在——从 ghost layer 变为热路径
  - Acceptance: AgentRuntime 通过 CommBus 而非原始 IrcBus 路由消息；roundtable/vote 在 Stage 角色分配中使用 CommBus
  - Depends: —

- [ ] **Task: 添加 retry 耗尽后 circuit breaker**
  - Files: `packages/coding-agent/src/swarm/stage/stage-controller.ts`
  - Change: `#runAgent()` 中 retry 耗尽后不直接 block 任务，而是通过 FSM 进入 `blocked` 状态 + `waitForHumanDecision()`，向用户提供选项：retry with different model、skip task、abort pipeline
  - Acceptance: retry 耗尽后用户收到明确提示，可选择恢复路径；不再静默跳过任务
  - Depends: 替换全局 silent .catch

## Phase 5: P1/P2 用户体验提升
**Contract:** 改善 discoverability、feedback、validation 和成本透明度

- [ ] **Task: 替换 Applaud 为显式确认对话框**
  - Files: `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`
  - Change: Curtain 完成后不等待隐形 applaud 关键词，而是弹出 ask 对话框：`"Swarm execution complete. [View Summary] [Dismiss]"`。autoApplaud=true 时跳过。移除 5 分钟超时静默过渡
  - Acceptance: Curtain 完成后用户看到显式确认提示，不再需要猜测 applaud 关键词
  - Depends: —

- [ ] **Task: 增强 Plan 结构验证**
  - Files: `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`
  - Change: `confirmScript()` 验证从 heading+200 字符升级为：必须有 phase 标题、每个 task 必须有 Files/Change/Acceptance 字段。验证失败时在 plan review overlay 中显示具体错误而非仅 log
  - Acceptance: 不符合 schema 的 plan 被拒绝，错误信息显示在 TUI overlay 中
  - Depends: —

- [ ] **Task: Script phase 进度指示**
  - Files: `packages/coding-agent/src/session/agent-session.ts`, `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`
  - Change: `onPlanUpdated()` 回调触发时，通过 agent-session 注入可见状态更新到 chat：`"📋 Script phase: writing plan.md..."`。todos 更新时也发射状态
  - Acceptance: Script phase 执行期间 chat 中有可见进度提示
  - Depends: —

- [ ] **Task: Per-agent 执行超时**
  - Files: `packages/coding-agent/src/swarm/stage/stage-controller.ts`
  - Change: `#runAgent()` 中 `handle.wait()` 添加超时参数（默认 5 分钟，可配置）。超时时 abort agent 并 release 任务重试
  - Acceptance: 挂起的 agent 不会无限期阻塞 worker；超时后自动重试
  - Depends: —

## Phase 6: 类型安全与测试
**Contract:** 清理 `as unknown as` 强制转换，补充关键工厂函数测试

- [ ] **Task: 重构 hook handler 类型消除 as unknown as**
  - Files: `packages/coding-agent/src/swarm/hook-system/builtins/*.ts`, `packages/coding-agent/src/swarm/hook-system/types.ts`
  - Change: 将 `handler<K extends HookEvent>(event: K, payload: HookPayloadMap[K])` 签名改为 discriminated union：`handler(args: { event: "agent:beforeSpawn"; payload: AgentBeforeSpawnPayload } | { event: "agent:afterComplete"; payload: AgentAfterCompletePayload } | ...)`。消除 builtins 中所有 `as unknown as` 强制转换
  - Acceptance: 6 个 builtin hook 文件中零 `as unknown as`；`bun check` 通过
  - Depends: —

- [ ] **Task: 补充 assembleAgentRuntime 和 createTaskQueueFromPlan 测试**
  - Files: `packages/coding-agent/src/swarm/__tests__/assembler.test.ts`（新建）, `packages/coding-agent/src/swarm/__tests__/task-queue.test.ts`
  - Change: 为 `assembleAgentRuntime()` 添加测试：验证可选依赖（experienceStore/mnemopiClient 等）的四种组合（全有/全无/部分有）。为 `createTaskQueueFromPlan()` 添加测试：正常 plan、空 plan、格式错误 plan、单任务 plan、多任务 DAG plan
  - Acceptance: 两个工厂函数的测试覆盖核心路径和边界情况
  - Depends: —

## Phase 7: Script→Plan 统一 + TUI 补齐
**Contract:** 消除 swarm Script phase 与 orchestrate plan-review 的代码重复，补齐 roundtable/debate 的 TUI 渲染

- [ ] **Task: 统一 Script phase 使用 PlanReviewOverlay**
  - Files: `packages/coding-agent/src/modes/components/plan-review-overlay.ts`, `packages/coding-agent/src/modes/interactive-mode.ts`, `packages/coding-agent/src/swarm/script/script-manager.ts`
  - Change: swarm Script phase 的 plan review 当前通过 ask 工具弹出简单选项。替换为完整的 PlanReviewOverlay（TOC、section 编辑、annotation、agent-count slider），与 orchestrate 流程共享同一组件。ScriptManager 中的内联 plan 渲染逻辑删除
  - Acceptance: swarm Script phase 的 plan review 体验与 orchestrate 一致，共享 PlanReviewOverlay；ScriptManager 减少 ~100 行重复 plan 渲染代码
  - Depends: —

- [ ] **Task: 创建 Roundtable TUI 组件**
  - Files: `packages/coding-agent/src/modes/components/swarm/roundtable-view.ts`（新建）, `packages/coding-agent/src/modes/components/swarm/swarm-dashboard.ts`
  - Change: 新建 RoundtableView 组件，结构化渲染辩论/roundtable 过程：participant list（角色+立场摘要）、round counter（当前轮/总轮数）、convergence meter（Jaccard similarity 进度条）、position history（每轮各 agent 的立场摘要）。集成到 swarm dashboard 的 comm panel 区域。使用 swarmPanel 边框风格保持系统一致性
  - Acceptance: `/swarm` dashboard 在角色分配 roundtable 或 plan debate 期间显示结构化辩论视图，非纯文本消息列表
  - Depends: —

- [ ] **Task: 添加 Task 级进度面板到 Dashboard**
  - Files: `packages/coding-agent/src/modes/components/swarm/task-panel.ts`（新建）, `packages/coding-agent/src/modes/components/swarm/swarm-dashboard.ts`
  - Change: 新建 TaskPanel 组件，渲染 per-task 状态表：task ID、status icon（pending/claimed/running/done/blocked）、assigned agent、duration。底部显示 wave 完成百分比和 DAG 依赖简化图（`A → B → C` 表示法）。集成到 dashboard 双栏布局（agent panel 下方）
  - Acceptance: swarm dashboard 中可看到每个任务的实时状态和 wave 进度
  - Depends: —

- [ ] **Task: 删除 ScriptManager 遗留代码**
  - Files: `packages/coding-agent/src/swarm/script/script-manager.ts`, `packages/coding-agent/src/swarm/script/index.ts`
  - Change: ScriptManager（~500 行）功能已被 ScriptBehavior（~250 行）+ EmbeddedSwarmBridge 覆盖。迁移 ScriptManager 的独有逻辑（debate、plan poll）到 ScriptBehavior，删除 ScriptManager
  - Acceptance: ScriptManager 类被删除，所有引用迁移到 ScriptBehavior；`bun check` 通过
  - Depends: 统一 Script phase 使用 PlanReviewOverlay, 接线 PhaseBehavior 到 orchestrator

- [ ] **Task: 添加 Cost 估算显示**
  - Files: `packages/coding-agent/src/modes/components/swarm/cost-panel.ts`（新建）, `packages/coding-agent/src/modes/components/swarm/swarm-dashboard.ts`
  - Change: 数据管道已存在——`SwarmState.totalTokens`（state.ts:92）和 `PipelineContext.totalTokens`（pipeline.ts:494）已逐 wave 累加 token 用量，`context-panel.ts` 已显示 per-agent token 用量条。缺失的是：从 `totalTokens` → 查 model catalog pricing → 换算成本 → 显示。新建 CostPanel：读 totalTokens，通过 ModelRegistry 获取当前 model 的 input/output pricing，计算估算成本，显示在 dashboard 底部。PlanReviewOverlay 的 agent-count slider 旁显示预估
  - Acceptance: swarm dashboard 底部显示 `Tokens: 142K · Est: ~$0.42`；plan review 时 agent count 调整实时更新预估
  - Depends: —

## Phase 8: 深层优化（跨系统协调）
**Contract:** 修复跨 phase/跨模式的遗漏问题，提升整体一致性

- [ ] **Task: Swarm Dashboard 内嵌 Plan 内容视图**
  - Files: `packages/coding-agent/src/modes/components/swarm/plan-view.ts`（新建）, `packages/coding-agent/src/modes/components/swarm/swarm-dashboard.ts`
  - Change: 新建 PlanView 组件，在 dashboard 中渲染 plan.md 的结构化摘要（phase 标题 + task 列表），复用 PlanReviewOverlay 的 section parser（plan-toc.ts）。当前 dashboard 只显示 phase/agent/comm/context——plan 内容完全不可见
  - Acceptance: swarm dashboard 中可查看当前 plan 的 phase/task 结构
  - Depends: —

- [ ] **Task: Phase 进度条添加过渡动画和里程碑标记**
  - Files: `packages/coding-agent/src/modes/components/swarm/phase-view.ts`
  - Change: 当前 phase-view 是静态 8-phase 图标列表。改进：(1) 当前 phase 闪烁/脉冲效果（通过 TUI 的 invalidate 机制）(2) 已完成 phase 用 ✓ 标记 (3) 当前 phase 显示 elapsed duration (4) 宽度自适应时折叠已完成 phase 为省略号
  - Acceptance: phase 过渡有视觉反馈；长时间运行的 phase 显示 elapsed time
  - Depends: —

- [ ] **Task: Debate roundtable 结果回流到 PlanReviewOverlay**
  - Files: `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`, `packages/coding-agent/src/swarm/script/debate-roundtable.ts`
  - Change: 当 plan debate 启用并完成时，不仅自动覆盖 plan.md，还将 debate 摘要（每轮的关键分歧点、最终 convergence score、refined plan diff）注入 PlanReviewOverlay 的 annotation 区域，让用户看到辩论产出
  - Acceptance: plan debate 后用户在 plan review 中看到辩论摘要和变更 diff
  - Depends: 统一 Script phase 使用 PlanReviewOverlay, 创建 Roundtable TUI 组件
