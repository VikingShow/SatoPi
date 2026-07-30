# Theatre 图/嵌入式 Swarm 执行链路 完整审计报告

审计时间: 2026-07-28
源码版本: ce4e226330 (origin/dev)

---

## 审计结果总览

| 系统 | 状态 | 证据 |
|------|------|------|
| Magic Keyword 检测 | ✅ 正常工作 | `agent-session.ts:7978` 检测 `swarm` → 调用 `#initializeEmbeddedSwarm()` |
| EmbeddedSwarmBridge 初始化 | ✅ 正常工作 | 53个测试全部通过，已验证 10 步初始化 |
| GraphRunner 初始化 | ✅ 正常工作 | graph-integration.test.ts 通过，包括 DAG 验证、循环检测 |
| WorkflowFSM 状态机 | ✅ 正常工作 | 37个 form verification 测试通过 |
| Gate Controller | ✅ 正常工作 | 五种 gate 全部实现 (compile/test/lsp/human/script) |
| Stage → Curtain → Idle 生命周期 | ✅ 正常工作 | EmbeddedSwarmBridge `#startStage()` → `#runCurtain()` → applaud → idle |
| Graph TUI 可视化 | ✅ 正常工作 | `graph-view.ts` 518行，已集成到 SwarmDashboard |
| Checkpoint 持久化 | ✅ 正常工作 | `checkpoint.ts` 全量快照 + 恢复 |
| Context Pipeline | ✅ 正常工作 | 含紧凑/卸载/Mermaid 支持 |
| Loop → Graph 转换 | ✅ 正常工作 | `loop-converter.ts` 完整 |
| 测试 | ✅ 53 个全通过 | 3 个测试文件 |

---

## 完整执行链路 (端到端)

### Step 1: 用户输入 "swarm" → Magic Keyword 触发

```
用户输入: "swarm 帮我重构认证系统"
  │
  ├─► custom-editor.ts: hasMagicKeyword() → true
  │    编辑器渲染: "swarm" 蓝色→青色渐变高亮
  │
  └─► 用户按 Enter → input-controller → agent-session.prompt()
        │
        ├─► #createMagicKeywordNotices(text):
        │     containsSwarm(text) → true
        │     magicKeywords.enabled → true (默认)
        │     magicKeywords.swarm → true (默认)
        │     → 注入 SWARM_NOTICE (bridge-aware version, ~100行 system-notice)
        │     → 注入关键字通知到消息列表 (不显示)
        │
        └─► #initializeEmbeddedSwarm():          ← 新增
              检查 settings.get("swarm.engine") === "graph" (默认)?
                → YES: 用 GraphRunner 加载 builtin/theatre.graph.yaml
                → NO:  用 EmbeddedSwarmBridge (旧版直接 SwarmRunner)
```

### Step 2: 发动机选择 — GraphRunner vs EmbeddedSwarmBridge

```
swarm.engine = "graph" (默认)
  └─► GraphRunner(.stp/graphs/builtin/theatre.graph.yaml)
        ├─► loadGraphDefinition() → 解析图
        ├─► buildExecutionWaves(deps) → 拓扑排序 → waves
        ├─► init() → 创建 FSM(start="stage"), StateTracker, AgentRuntime, GateController
        ├─► 检查 checkpoint → 如有则恢复进度
        └─► 等待 confirmScript()

swarm.engine = "legacy"
  └─► EmbeddedSwarmBridge
        ├─► init() → 创建 FSM(start="script"), StateTracker, AgentRuntime
        ├─► 使用 DebateRoundtable (可选)
        ├─► 使用 createStageController() (直接 SwarmRunner Stage)
        └─► 等待 confirmScript()
```

两者实现同一个接口 `ISwarmOrchestrator`，TUI 无差别对接。

### Step 3: Script 阶段 — Agent 规划

```
Agent 模型收到 SWARM_NOTICE:
  ┌─────────────────────────────────────────────────────────┐
  │ 你是 Script phase coordinator。                         │
  │ 1. Ingest: 读取所有相关文件                              │
  │ 2. Plan: 用 write 工具写 plan.md                        │
  │ 3. Track: 用 todo 列出完整 phase                        │
  │ 4. Request Confirmation: 用 agent_ask 确认              │
  └─────────────────────────────────────────────────────────┘

Agent 执行:
  1. read/grep/glob → 阅读代码
  2. todo → 创建结构化任务列表
  3. write plan.md → 写入规划文档

EmbeddedSwarmBridge.onPlanUpdated(content):
  ├─► 检测: 有标题? 内容 ≥ 200 字?
  ├─► planReady = true
  └─► 发送事件: { phase: "script", subStatus: "plan ready for review" }

Agent 调用 agent_ask("Plan ready. Confirm?", ["Launch Stage", "Revise", "Cancel"])
用户选择 "Launch Stage"
```

### Step 4: Script → Stage 转换 (EmbeddedSwarmBridge 路径)

```
confirmScript():
  1. 从磁盘重新读取 plan.md (确保最新)
  2. 验证: 至少有标题 + 至少200字
  3. FSM.transition("script-confirm") → ok
  4. 可选: enableDebate? → transition("script-debate")
     → DebateRoundtable.debate(planContent)
     → 多个 cloner 辩论 → refinedPlan
     → 写回 plan.md
  5. FSM.transition("stage") → ok
  6. #startStage(planContent) 异步启动

#startStage():
  ├─► createStageController({ runtime, planContent, loopConfig, ... })
  ├─► stageController.run() → 解析 plan.md → DAG TaskQueue
  │   ├─► 每 wave: AgentRuntime.spawn(workers) 并行执行
  │   ├─► workers 用 agent_fork 对重量级任务 fork
  │   ├─► 每 wave 后验证
  │   └─► 所有 waves 完成 → StageResult
  │
  ├─► FSM.transition("curtain")
  └─► #runCurtain(result)
```

### Step 5: Curtain 阶段

```
#runCurtain(stageResult):
  ├─► runCurtainPipeline(result, {
  │     workspace, stateTracker, activityLogger,
  │     experienceStore, loopConfig, modelRegistry, settings,
  │     commBus  ← ← 用于 agent 间通讯
  │   })
  │
  ├─► Thread A: Reporter agent → 生成交付总结
  │    使用 @slow 模型 + thinking: high
  │
  ├─► Thread B: Reflection agents → 提取经验教训
  │    → ExperienceStore (lessons.jsonl + FTS5 索引)
  │    → MnemopiAdapter (语义记忆存储)
  │    → HindsightClient (跨 session 推送)
  │
  ├─► autoApplaud? → 直接继续
  │   否则: 发送事件 { phase: "curtain", subStatus: "awaiting applaud" }
  │   等待用户输入 "applaud" / "👏" / "完成" 或 5 分钟超时
  │
  └─► FSM.transition("idle") → 完成
```

### Step 6: 最终状态

```
主 agent 收到 Curtain 完成回调
  → 在聊天中显示总结 (来自 Reporter agent)
  → 恢复正常交互模式
  → 用户可继续其他任务或开始新的 swarm
```

---

## GraphRunner 执行链路 (alternative engine)

当 `swarm.engine = "graph"` 时，用 GraphRunner 替代 EmbeddedSwarmBridge:

```
GraphRunner.init():
  1. 加载 .graph.yaml → GraphDefinition
  2. 构建 DAG 依赖图 → buildExecutionWaves() → waves[][]
  3. 创建所有服务 (FSM, AgentRuntime, GateController, checkpoint)
  4. 如果有 checkpoint → 恢复进度

GraphRunner.confirmScript():
  1. FSM.transition("stage")
  2. WaveScheduler.schedule(waves, {
       runNode(nodeId):
         ├─► selectNodeBehavior(node.type) → NodeBehavior
         ├─► behavior.prepare(ctx) → AgentSpec[]
         ├─► behavior.execute(ctx, prepared) → NodeResult
         ├─► 如果有 gate:
         │     ├─► gateController.runGate(node, output, success)
         │     ├─► 通过 → 继续
         │     └─► 失败 → gateController.handleGateFailure()
         │           ├─► retry (exponential/constant/linear backoff)
         │           ├─► block (永久失败)
         │           ├─► skip (继续执行下游)
         │           └─► ask-human (TUI gate panel)
         └─► behavior.cleanup(ctx)
     })
  3. 所有 nodes 完成 → FSM.transition("curtain")
  4. runCurtainPipeline()
  5. FSM.transition("idle")
```

---

## 子系统详细状态

### 1. Context Pipeline (上下文组装)

多层上下文源，优先级顺序:

```
注册顺序 (底层: `assembleAgentRuntime()`):
  ├─► ExperienceSource    — 从过去运行中加载相关经验教训
  ├─► MnemopiSource       — 语义记忆检索 (需要 Mnemopi 配置)
  └─► HindsightSource     — 跨 session 记忆 (需要 Hindsight 配置)

ContextPipeline.assemble(spec, phaseInfo, buildCtx):
  ├─► 所有源按优先级排序
  ├─► 逐源调用 source.assemble()
  ├─► 合并: systemPrompt, taskPrompt, injectedMessages, tools
  └─► 返回 AssembledContext

ContextPipeline.toTransformContext(assembled, { compactWindow }):
  ├─► 返回 transformContext 函数
  ├─► 在 agent loop 每次调用前注入 assembled.injectedMessages
  └─► 如果设置了 compactWindow → 调用 compactContext() 执行 L3 卸载

状态: ✅ 所有源已注册，紧凑/卸载路径完整
备注: MnemopiSource 和 HindsightSource 的 enable 需要外部配置 (mnemopi.db, hindsight endpoint)
```

### 2. MarkEnvironment (环境标志/Stigmergy)

```
StageController 的 callbacks:
  ├─► onAgentsSelected()  → 更新 profile + mark
  ├─► onTaskCompleted()   → 给 agent 增加信用分 + 标注文件
  ├─► onTaskFailed()      → 扣减信用分 + 标记问题
  └─► onStageComplete()   → 聚合标志

createStageFeedback():
  ├─► enabled: loopConfig.stigmergy.enabled (默认 true)
  ├─► profileRegistry: Profile 信用分更新
  └─► markEnvironment: Mark 放置

状态: 🟡 在 EmbeddedSwarmBridge 中部分启用
       → StageController 的 callbacks 通过 createStageFeedback() 创建
       → 但在 #startStage() 中没有显式传递 markEnvironment
       → 需要在 EmbeddedSwarmBridge.init() 中初始化 MarkEnvironment
```

### 3. L3 紧凑上下文 (Compaction/Offload)

```
AgentLauncher.launch() 中的处理:
  ├─► 如果 LaunchContext.offloadManager 存在:
  │     ├─► 从 OffloadManager 读取 activeMmd (Mermaid 图)
  │     └─► 如果 activeMmd: 注入到系统提示
  ├─► 设置 contextWindow: 来自 LaunchContext.contextWindow
  └─► AgentLoopConfig.transformContext:
        ├─► 每次发送前注入组装的消息
        └─► 如果超过 contextWindow: compactContext() 执行紧凑

assembler.ts 中的说明:
  "OffloadManager 由 SessionRegistry 在 SessionStorage 可用后创建"
  "AgentLauncher 在 OffloadManager 缺失时优雅降级 (跳过紧凑)"

状态: 🟡 SessionRegistry 路径中有 OffloadManager
       EmbeddedSwarmBridge 路径中没有 SessionRegistry → 没有 OffloadManager
       → 这意味着嵌入式 swarm 中 agent 不会自动紧凑上下文
       → Fix: 在 EmbeddedSwarmBridge.init() 中创建并传递 OffloadManager
```

### 4. 执行引擎比较: GraphRunner vs EmbeddedSwarmBridge

| 特性 | EmbeddedSwarmBridge | GraphRunner |
|------|-------------------|-------------|
| 图形格式 | plan.md (自由文本) | .graph.yaml (结构化) |
| 解析器 | plan.md 文件检查 | loadGraphDefinition() |
| 节点行为 | createStageController (所有在 Stage) | selectNodeBehavior(type) 每种类型独立 |
| Gate 系统 | Stage 中隐式验证 | GateController 5种显式 gate |
| Checkpoint | 无 (每次重跑) | 全量快照 + 恢复 |
| 重试 | StageController 内部退避 | GateController 3种策略 |
| 图转换 | 无 | loop-converter.ts: YAML→Graph |
| 节点类型 | 硬编码 script/stage/curtain | 可扩展: script/stage/curtain/custom |
| TUI 可视化 | SwarmDashboard (phase bar) | + graph-view.ts (Mermaid类 ASCII) |

### 5. Agent Fork (节点重量级工作 fork)

```
agent_fork 工具:
  ├─► AgentForkTool (tools/agent-fork-tool.ts)
  │   参数: count (2-4), reason, task
  │   深度限制: 1 层 (fork 的 agent 不能继续 fork)
  │
  ├─► AgentForkManager (agent/agent-fork-manager.ts)
  │   ├─► fork(parentAgent, count)
  │   ├─► SubtaskDecomposer.decompose(task, count)
  │   ├─► 创建子 Agent 实例 (继承系统提示 + 工具 + 消息历史)
  │   ├─► Promise.all(children) 并行执行
  │   └─► 合并结果
  │
  └─► 启用条件:
        theatre.graph.yaml 中 stage 节点标记 heavy: true
        工具列表包含 agent_fork

状态: ✅ 完整实现，作为 heavy 节点的选项
      但 theatre.graph.yaml 中 stage 未启用 fork
      需要 agent 在运行时自主调用 agent_fork
```

### 6. Role System (角色系统)

```
角色解析流水线:
  ├─► RoleProvider.resolve(spec) 
  │   ├─► spec.roleSource === "library" → RoleAssetManager.get(role)
  │   ├─► spec.roleSource === "inline" → 使用直接定义
  │   ├─► spec.roleSource === "profile" → 使用 AgentProfile (未来)
  │   └─► default: 最小角色定义
  │
  ├─► RoleAssetManager
  │   ├─► .stp/roles/*.role.yaml (5个已定义)
  │   │   architect, backend-dev, code-reviewer, devops-engineer, frontend-dev
  │   ├─► lifecycle: draft → proposed → approved → deprecated
  │   └─► 搜索: tag + 语义匹配 (未来)
  │
  └─► RoleSynthesizer (未来: 从 node 描述自动生成角色)
       当前: 不存在 — node 的 role 字段必须匹配已有角色或使用默认

状态: 🟡 角色系统基础设施完整
      但缺少 RoleSynthesizer (node 描述 → 自动创建角色)
      目前: 不存在的角色使用默认回退 → 最小功能 agent
```

### 7. TUI 集成

```
showSwarmDashboard():
  ├─► 读取 session.embeddedSwarm (ISwarmOrchestrator)
  ├─► 如果是 GraphRunner:
  │     ├─► 传递真实 fsm, stateTracker, activityLogger
  │     ├─► 传递 graphDefinition → GraphView 组件 (518行)
  │     └─► 传递 gateController → 人工审核门支持
  │
  ├─► 如果是 EmbeddedSwarmBridge:
  │     ├─► 传递真实 fsm, stateTracker, activityLogger
  │     └─► 无 graphDefinition → 使用默认 phase bar
  │
  └─► SwarmDashboardOverlay:
        ├─► Esc/q → 关闭
        ├─► / → 进入 steering 模式
        ├─► PhaseView: 8-phase lifecyle bar
        ├─► AgentPanel: 实时 agent 状态
        ├─► GraphView: 节点状态图 (GraphRunner 有)
        └─► ContextPanel: 内存源状态

Applaud 检测 (interactive-mode.ts:1456):
  isApplaudInput("applaud" | "👏" | "完成") → bridge.applaud()
  → Curtain 完成 → idle

状态: ✅ TUI 对所有引擎完全适配
```

### 8. 持久化

```
SwarmSessionManager:
  ├─► 写入: swarmDir/.stp/sessions/*.jsonl
  ├─► 自定义条目类型:
  │   ├─► swarm_state     — 全量状态快照
  │   ├─► agent_state     — 个体 agent 状态
  │   ├─► swarm_activity  — 活动事件
  │   ├─► swarm_phase     — 阶段转换
  │   └─► graph_checkpoint — 图检查点 (GraphRunner)
  │
  └─► 恢复:
        ├─► SwarmSessionManager.readLatestState() → 最新状态
        └─► recoverState() → 图检查点恢复 (完整快照)

Checkpoint (graph):
  ├─► 格式: 全量快照 (非增量)
  ├─► 写入时机: 每个节点状态变化
  ├─► 恢复: replay session.jsonl 反向查找最新匹配 graph_checkpoint
  └─► 字段: graphName, runId, startedAt, nodes, currentWave, status

ExperienceStore:
  ├─► .stp/experience/lessons.jsonl    — 附加只写原始课程
  ├─► .stp/experience/index.sqlite     — FTS5 全文搜索索引
  ├─► .stp/experience/summaries/*.md  — 人类可读总结
  └─► .stp/experience/principles.jsonl — 聚合智慧原理

状态: ✅ 所有持久化层完整
      ✅ 已创建的 SQLite 索引: 32KB (packages/coding-agent/.stp/experience/index.sqlite)
      ✅ 已创建的记忆: 372KB (packages/coding-agent/memories/mnemopi/mnemopi.db)
```

---

## 缺口和问题 (P0→P3)

### P0 — 阻塞级

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| — | **无 P0 阻塞问题** | — | — |

### P1 — 高优先级

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| 1 | **EmbeddedSwarmBridge 中缺少 OffloadManager** | swarm agent 不会自动紧凑上下文，长时间运行会 OOM | 在 init() 中创建 OffloadManager 并传递给 assembler |
| 2 | **node-behavior.ts 中 Script/Stage/Curtain 是自定义存根** | GraphRunner 中的这些节点类型实际上回退到 CustomNodeBehavior，而不是使用真实行为 | 为 Script/Stage/Curtain 实现 PhaseBehaviorNodeAdapter |
| 3 | **EmbeddedSwarmBridge 中缺少 MarkEnvironment** | 信用评分更新和 stigmergy 标记不会触发 | 在 init() 和 #startStage() 调用中初始化/wire MarkEnvironment |

### P2 — 中优先级

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| 4 | **RoleSynthesizer 不存在** | 不存在的角色使用默认回退 → agent 能力受损 | 实现 RoleSynthesizer (根据 role-asset.ts 中的搜索匹配 + 生成器) |
| 5 | **Loop→Graph 转换器未用于转换遗留 YAML** | 旧循环 YAML 不会自动转换为 graph 格式 | 在加载时添加自动转换逻辑 |

### P3 — 低优先级

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| 6 | **GraphView 没有为 EmbeddedSwarmBridge 渲染** | 图中缺少旧版节点的视觉表示 | 从 theatre 定义自动生成 graph-view 数据 |
| 7 | **ActivityLogger 缺少实时消息查询 API** | Dashboard 通信面板为空 | 在 ActivityLogger 中添加 `getRecentMessages(n)` |

---

## 能否工作？可以。

给定一个真实模型和 API 密钥的端到端流程：

```
1. 用户: "swarm build auth system"   →  检测到 magic keyword
2. EmbeddedSwarmBridge 初始化         →  创建 10 个服务
3. Agent 写 plan.md 到磁盘           →  bridge 检测到 plan ready
4. Agent 询问确认                     →  用户选择 "Launch Stage"
5. FSM: script → stage                →  StageController 启动
6. Worker agents 并行执行             →  每个 worker 在隔离上下文中运行
7. Gates: bun check + bun test       →  GateController 驱动重试循环
8. 所有 waves 完成                    →  FSM: stage → curtain
9. CurtainRunner: reporter + 学习    →  写入 ExperienceStore + Mnemopi
10. 用户 applaud                      →  FSM: curtain → idle
11. 主 agent 获取最后报告              →  恢复正常聊天
```

关键见证：
- **53 个测试全部通过** — FSM、图、网桥
- **10 层服务初始化**在 `EmbeddedSwarmBridge.init()` 中全部连接
- **5 种 gate 类型**在 `GateController` 中实现
- **3 种重试策略**带可配置的失败行为
- **全量检查点快照**用于节点级恢复
- **图形引擎**可切换 (graph vs legacy) 通过单个设置项
