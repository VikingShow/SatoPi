# SatoPi Swarm Magic-Keyword × SwarmRunner 融合方案

## 现状分析

### 两条完全不交的路径

```
路径 A: magic keyword "swarm"
  用户输入 "swarm" → agent-session 注入 SWARM_NOTICE (隐藏 system-notice)
  → 当前 agent 行为模式切换为 "swarm coordinator"
  → 用 task 工具派发子 agent，穷举/并行/逐 phase 验证
  → 无生命周期状态机，纯 prompt 驱动

路径 B: SwarmRunner 三阶段
  stp swarm run/plan → SwarmRunner → WorkflowFSM 状态机
  → Script(planner agent + debate) → Stage(StageController + PipelineController)
  → Curtain(CurtainRunner: reporter + reflection + applaud)
  → 独立的 AgentRuntime，独立的 session 持久化
```

### 关键差距

| 维度 | magic keyword | SwarmRunner |
|------|--------------|-------------|
| 状态机 | 无 | WorkflowFSM (7个phase, 形式化验证) |
| 子agent派发 | 当前agent调用`task`工具 | AgentRuntime.spawn() |
| 计划阶段 | prompt里的workflow指令 | ScriptManager + Planner agent + Debate |
| 执行阶段 | agent自己协调 | StageController + DAG TaskQueue |
| 收尾阶段 | agent自己验证 | CurtainRunner: reporter + reflection + lessons |
| TUI可见性 | 无特殊UI | /swarm dashboard overlay (只读) |
| 持久化 | 无 | SwarmSessionManager + session.jsonl |
| 经验积累 | 无 | ExperienceStore + Mnemopi + Hindsight |

---

## 融合设计：三个方案，从轻到重

### 方案1: Embed Runner (轻量推荐 ⭐)

**核心思路**: 让 magic keyword 触发的不仅是 prompt notice，还附加一个嵌入式的 `SwarmRunner` 实例。当前 agent 作为 "human-in-the-loop" 参与 Script 阶段，确认后启动 Stage → Curtain。

```
用户输入 "swarm 做一个完整重构"
  │
  ├─► SWARM_NOTICE 注入（保留，作为 agent 的行为指令）
  │
  └─► 新: 后台创建 EmbeddedSwarmSession
        │
        ├─► assembleAgentRuntime() 创建 AgentRuntime（复用当前 session 的
        │    modelRegistry, settings, authStorage）
        │
        ├─► 创建 WorkflowFSM（idle → script 初始状态）
        │
        ├─► Script 阶段: 当前 agent 自己充当 Planner
        │    - agent 按 SWARM_NOTICE 的 Ingest→Plan 流程
        │    - 生成 plan.md 写入临时 swarmDir
        │    - 用 todo 工具展示完整 phase 分解
        │    - 可选: 用 roundtable 多角度评审 plan
        │
        ├─► 用户确认（agent 在 chat 中展示 plan，用户回复确认）
        │    WorkflowFSM.transition("script-confirm") → "stage"
        │
        ├─► Stage 阶段: StageController 接管
        │    - 解析 plan.md → DAG TaskQueue
        │    - AgentRuntime.spawn() 并行派发 workers
        │    - 每个 worker 是独立子 agent, 不共享上下文
        │    - TUI 中实时显示 swarm dashboard overlay
        │
        └─► Curtain 阶段: CurtainRunner 接管
             - Reporter agent 生成交付总结
             - Reflection agents 提取经验 → ExperienceStore
             - 展示给用户确认
```

**需要改动的地方**:

1. **`agent-session.ts`** — `#createMagicKeywordNotices()` 中，当检测到 `swarm` 时，额外调用 `this.#prepareEmbeddedSwarm()`:
   - 创建临时 swarmDir (`.swarm_{sessionId}/`)
   - 构建 loop.yaml 默认配置（从 settings 读取）
   - 通过 `assembleAgentRuntime()` 创建 AgentRuntime
   - 创建 WorkflowFSM + StateTracker + ActivityLogger
   - 挂载到 session 的 `embeddedSwarm` 属性上

2. **`agent-session.ts`** — 新增 `#handleEmbeddedSwarmLifecycle()`:
   - 监听 agent turn 结束事件
   - 如果 WorkflowFSM 在 "script" 或 "script-confirm" 阶段，检查 plan.md 是否就绪
   - 如果 plan 就绪且用户确认，transition → stage，启动 StageController
   - 将 StageController 的事件流回灌到 agent 的 `pendingTools`/`streamingMessage`

3. **`modes/interactive-mode.ts`** — 增强 `showSwarmDashboard()`:
   - 从 session 读取 `embeddedSwarm` 状态
   - 传入真实的 `StateTracker` + `WorkflowFSM` 到 `SwarmDashboardOverlay`
   - 仪表盘现在显示真实的 swarm 运行状态

4. **`swarm/core/swarm-runner.ts`** — 提取 `EmbeddedSwarmRunner`:
   - 从 SwarmRunner 中提取纯 Stage + Curtain 逻辑（不含 CLI I/O）
   - 使 SwarmRunner 本身可嵌入 agent session

5. **`swarm-notice.md`** — 更新 prompt:
   - 明确告知 agent：当它完成 Plan 阶段后，Stage 和 Curtain 由系统自动接管
   - agent 的角色是确保 plan.md 的完整性和 todo 的穷举

**优点**:
- 改动量适中（~5个文件核心改动）
- 复用现有 SwarmRunner 全部基础设施
- magic keyword 的即时感保留（不需要用户切到 CLI）
- 三阶段生命周期完整运行

**缺点**:
- 当前 agent 的 turn 在 Stage 阶段被"挂起"（StageController 独立运行）
- 如果 Stage 失败，需要把控制权交还给 agent 修复 plan

---

### 方案2: Agent-as-Orchestrator (最轻量)

**核心思路**: 不改动 SwarmRunner 集成，而是在 SWARM_NOTICE 中增加更结构化的指令，让当前 agent 更严格地模拟三阶段行为。

```
SWARM_NOTICE 注入强化:
  │
  ├─► Script 阶段指令:
  │   - 必须先写 plan.md（用 write 工具）
  │   - 必须用 todo 列出完整的 phase 分解
  │   - 用户确认后才进入 Stage
  │
  ├─► Stage 阶段指令:
  │   - 严格按 plan.md 逐 phase 执行
  │   - 每个 phase: 并行派 task → 等待全部完成 → 验证 gate
  │   - 只有 gate 全绿才进入下一 phase
  │
  └─► Curtain 阶段指令:
       - 全量最终验证
       - 生成交付总结
       - 用 todo 标记所有项完成
```

**需要改动的地方**:

1. **`swarm-notice.md`** — 大幅重写:
   - 增加 Script/Stage/Curtain 三阶段的结构化定义
   - 增加 plan.md 的格式规范
   - 增加 gate 验证的具体步骤
   - 增加 phase 间不可跳过的硬性规则

2. **`agent-session.ts`** — 可选: 当检测到 `swarm` 且 plan.md 被写入时，自动高亮显示 dashboard overlay

**优点**:
- 零架构改动
- 快速可用
- 不增加系统复杂度

**缺点**:
- 本质上还是 prompt engineering，可靠性依赖模型遵循指令的能力
- 没有 WorkflowFSM 的强制状态转换
- 没有 StageController 的 DAG 调度和并发控制
- 没有 ExperienceStore 的经验积累
- 子 agent 仍是通用 task agent，不是 swarm 专用 workers

---

### 方案3: Full Bridge (重量级，长期方案)

**核心思路**: 在交互式 TUI 中，magic keyword 实际触发 `stp swarm plan` 的交互式 planner，用户和 planner 对话确认 plan 后，自动进入 Stage 和 Curtain。形成一个完整的端到端体验。

```
用户输入 "swarm 重构认证模块"
  │
  ├─► SWARM_NOTICE 注入
  │
  └─► 当前 agent turn 开始
        │
        ├─► agent 检测到 embedded swarm context
        │
        ├─► 以 Planner 角色进入 Script 阶段
        │   TUI 状态栏显示: [🐝 Swarm: Script]
        │
        ├─► agent 写 plan.md, 建 todo, 可发起 roundtable debate
        │   用户可以在 TUI 中看到 plan 的实时更新
        │
        ├─► agent 展示 plan 完成，等待用户确认
        │   用户按 Enter 确认 / 回复 "修正X" 继续迭代 / Esc 取消
        │
        ├─► WorkflowFSM: script-confirm → stage
        │   TUI 状态栏显示: [🐝 Swarm: Stage · Wave 2/5]
        │   全屏 swarm dashboard 自动打开
        │
        ├─► StageController 运行:
        │   - 每个 wave 的 agent 输出实时显示在 dashboard
        │   - 主 agent 可以发送 steering 消息给 worker
        │   - TUI 底部显示当前 wave 进度
        │
        ├─► WorkflowFSM: stage → curtain
        │   TUI 状态栏显示: [🐝 Swarm: Curtain]
        │
        ├─► CurtainRunner 运行:
        │   - Reporter agent 总结交付
        │   - Reflection agents 提取经验
        │   - 用户 Applaud 确认
        │
        └─► WorkflowFSM: curtain → idle
            主 agent 恢复普通模式，收到 swarm 结果摘要
```

**需要改动的地方**:

1. **`agent-session.ts`** — 新增 `EmbeddedSwarmSession`:
   - 完整的 swarm lifecycle 容器
   - 持有 WorkflowFSM, StateTracker, ActivityLogger, SwarmSessionManager, ExperienceStore
   - 提供 `start()`, `steer()`, `confirm()`, `cancel()`, `applaud()` API
   - 与 agent turn lifecycle 双向通信

2. **`modes/interactive-mode.ts`** — 新增 swarm lifecycle hooks:
   - `onSwarmPhaseChange(phase)` → 更新状态栏 + dashboard overlay
   - `onSwarmPlanReady(planContent)` → 展示 plan review overlay
   - `onSwarmStageProgress(wave, total)` → 更新 dashboard
   - `onSwarmCurtainComplete(result)` → 展示结果 summary

3. **`modes/components/swarm/swarm-dashboard-overlay.ts`** — 增强:
   - 实时 agent output streaming
   - Wave 进度条
   - 每个 agent 的 token 使用量
   - human steering 输入框

4. **`swarm/core/swarm-runner.ts`** — 重构为 `EmbeddedSwarmRunner`:
   - 去掉 CLI I/O 依赖
   - 增加 steering API（主 agent 可在 Stage 中发消息给 worker）
   - 增加 phase callback hooks

5. **`swarm/stage/stage-controller.ts`** — 增加 steering 支持:
   - 接收来自主 agent 的 steering 消息
   - 路由给当前活跃的 worker

6. **`swarm/curtain/curtain-runner.ts`** — 增加 applaud 机制:
   - 在 Curtain 末尾暂停，等待用户 applaud
   - 用户 applaud 后写入 ExperienceStore + Mnemopi

7. **`swarm-notice.md`** — 更新为 bridge-aware:
   - agent 知道它在 Script 阶段会收到一个 `embeddedSwarm` 上下文
   - agent 知道 plan 确认后，Stage/Curtain 由系统接管
   - agent 的角色是 Plan 质量把关，不是执行调度

8. **新文件 `swarm/core/embedded-swarm-bridge.ts`**:
   - EmbeddedSwarmSession 的创建和管理
   - agent session ↔ swarm session 的双向桥接
   - 事件转发: WorkflowFSM events → agent session events
   - Steering 转发: agent tool calls → worker agents

**优点**:
- 完整的端到端体验
- 真正融合了 magic keyword 的即时性和 SwarmRunner 的生命周期
- 状态机强制保障（不会出现 plan 未确认就直接执行）
- 经验积累可用（每次 swarm run 都会写 ExperienceStore + Mnemopi）
- dashboard 有真实数据源

**缺点**:
- 改动范围大（~10个文件核心改动 + 1个新文件）
- 需要仔细处理 agent session 和 swarm session 的生命周期同步
- 需要设计 human-in-the-loop 的确认/干预/取消机制

---

## 推荐路径

### 短期 (今天就可以做): 方案2

**只需改一个文件**: `swarm-notice.md`，加入更结构化的三阶段指令。

### 中期 (1-2天): 方案1

**核心改动**:
1. `agent-session.ts` — 检测 swarm keyword 时创建 `EmbeddedSwarmContext`
2. `swarm/core/embedded-swarm-runner.ts` — 提取 Stage + Curtain 纯逻辑
3. `modes/interactive-mode.ts` — dashboard 接入真实状态

这个方案真正让三阶段在 TUI 中运行，但保持 Script 阶段由 agent 自主完成（利用 SWARM_NOTICE 指令）。

### 长期: 方案3

在方案1的基础上迭代完善，加入:
- Script 阶段的 formal debate
- 用户在 Stage 阶段的实时 steering
- Curtain 阶段的 applaud + 经验持久化
- 完整的 phase-aware TUI overlay

---

## 关键设计决策

### 1. Script 阶段谁来写 plan？

| 选项 | 优点 | 缺点 |
|------|------|------|
| **当前 agent 写**（方案1） | 即时、自然、复用 SWARM_NOTICE | 质量依赖 prompt engineering，无 formal debate |
| **ScriptBehavior (Planner agent) 写**（方案3） | 独立 agent、可 debate、formal 质量 | 增加延迟、需要新的 TUI 交互模式 |

### 2. Stage 阶段如何保持 TUI 活跃？

当前交互式 TUI 的核心循环是 `getUserInput → prompt agent → render → getUserInput`。Stage 阶段是多 worker 并行执行，不需要用户输入。

**设计**: Stage 阶段，主 agent 进入 "observer" 模式。TUI 不等待用户输入，而是主动渲染 swarm dashboard overlay，每 100ms 轮询 StateTracker 更新状态。用户可以按 Esc 关闭 dashboard 回到正常模式，Stage 在后台继续运行。

### 3. 发生错误时怎么恢复？

- **Plan 阶段错误**（agent 写的 plan 有问题）: 用户直接纠正 agent，重新生成 plan.md
- **Stage 阶段错误**（某个 worker 失败）: StageController 已有 `retry with exponential backoff`，失败次数超限后 pause，把控制权交回主 agent
- **Curtain 阶段错误**（验证失败）: 回到 Stage 修复，或交回主 agent

### 4. 配置如何流动？

当前 `stp swarm run` 通过 `loop.yaml` 配置。在融合方案中，默认配置从 `settings` 读取，用户可以覆盖：
- `magicKeywords.swarm.maxWorkers` (default: 4)
- `magicKeywords.swarm.maxRounds` (default: 3)
- `magicKeywords.swarm.autoRetry` (default: true)

这避免了要求用户在 TUI 中手动写 YAML。

---

## 总结

| | 方案1 (Embed Runner) | 方案2 (Prompt Only) | 方案3 (Full Bridge) |
|---|---|---|---|
| 融合深度 | ⭐⭐⭐ 中等 | ⭐ 浅 | ⭐⭐⭐⭐⭐ 深 |
| 改动量 | ~5文件 | 1文件 | ~10文件+1新文件 |
| 状态机保障 | ✅ Stage + Curtain | ❌ 无 | ✅ 完整 |
| 经验积累 | ✅ CurtainRunner | ❌ | ✅ 完整 |
| Dashboard | ✅ 真实数据 | ❌ 空壳 | ✅ 真实+交互 |
| Human steering | ❌ | N/A | ✅ 可干预worker |
| 建议优先级 | 🥈 中期 | 🥇 短期 | 🥉 长期 |
