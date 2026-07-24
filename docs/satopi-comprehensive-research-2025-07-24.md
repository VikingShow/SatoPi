# SatoPi 项目全面深度调研报告

> **调研日期**: 2025-07-24
> **调研范围**: 完整项目（架构、Swarm 编排、上下文管理、Agent 通信、GUI/TUI、oh-my-pi 关系）
> **方法**: 源码级深度分析，覆盖 82 个 Swarm 文件及所有相关模块

---

## 目录

1. [项目概览](#一项目概览)
2. [Script → Stage → Curtain 三阶段生命周期](#二script--stage--curtain-三阶段生命周期)
3. [上下文卸载与 Mermaid 机制](#三上下文卸载context-offloading与-mermaid-机制)
4. [Agent 间通信机制](#四agent-间通信机制)
5. [Role 分配与 Agent Forking](#五role-分配与-agent-forking)
6. [Fork 自 oh-my-pi 的关系分析](#六fork-自-oh-my-pi-的关系分析)
7. [GUI 与 TUI 状态评估](#七gui-与-tui-状态评估)
8. [关键问题与差距总结](#八关键问题与差距总结)
9. [附录：关键文件索引](#附录关键文件索引)

---

## 一、项目概览

### 1.1 项目定位

SatoPi 是一个 **纵深扩展型 fork**，基于 [oh-my-pi](https://github.com/can1357/oh-my-pi) 构建。核心创新是将单 Agent 对话能力扩展为**多 Agent Swarm 编排系统**，引入了三阶段生命周期（Script/Stage/Curtain）、多 Agent 协作、上下文卸载、环境标记协调等机制。

### 1.2 技术栈

| 层级 | 技术 | 来源 |
|------|------|------|
| 运行时 | Bun (TypeScript 直执) | oh-my-pi 原装 |
| Agent 核心 | `packages/agent/` `packages/ai/` `packages/catalog/` | oh-my-pi 原装 |
| 原生层 | Rust (~55K 行): mnemopi, snapcompact, hashline | oh-my-pi 原装 |
| TUI | 差分渲染引擎 (~4000 行) | oh-my-pi 原装 |
| Python REPL | robomp | oh-my-pi 原装 |
| **Swarm 编排** | **82 个 TypeScript 文件** | **SatoPi 新增** |
| **GUI 监控面板** | React + Zustand + SSE | **SatoPi 新增** |
| **经验学习** | SQLite FTS5 + JSONL | **SatoPi 新增** |
| **Offload Pipeline** | Mermaid 图驱动上下文压缩 | **SatoPi 新增** |

### 1.3 核心目录结构

```
packages/
├── agent/          # oh-my-pi: Agent 核心运行时
├── ai/             # oh-my-pi: AI Provider 抽象
├── catalog/        # oh-my-pi: 工具/插件目录
├── coding-agent/   # oh-my-pi: Coding Agent（SatoPi 在此叠加 Swarm）
│   └── src/
│       ├── swarm/          # 🔥 SatoPi Swarm 编排核心（82 文件）
│       │   ├── script/     # Script 阶段
│       │   ├── stage/      # Stage 阶段
│       │   ├── monitor/    # Curtain 阶段
│       │   ├── offload/    # 上下文卸载管道
│       │   ├── channel/    # Agent 通信频道
│       │   ├── coordination/# 环境标记协调
│       │   ├── executor/   # 任务执行器（含 DAG）
│       │   └── agent/      # Agent 创建/选择/配置
│       ├── irc/            # IRC 通信总线
│       └── tools/          # Agent 工具（含 irc 工具）
├── swarm-gui/      # 🔥 SatoPi: Web 监控面板
├── swarm-extension/# 🔥 SatoPi: Swarm TUI 扩展
├── tui/            # oh-my-pi: 通用 TUI 框架
├── natives/        # oh-my-pi: Rust 原生模块
└── python/         # oh-my-pi: Python REPL
```

---

## 二、Script → Stage → Curtain 三阶段生命周期

### 2.1 Script 阶段（规划）

#### 2.1.1 核心流程

```
用户提交任务
  │
  ▼
ScriptManager.start()
  │ idle → script
  ▼
Planner Agent（统一 role=planner）
  │ Socratic 对话式规划
  │ 与用户反复交流，澄清需求
  ▼
生成 plan.md
  │ 包含 Task 列表（带 assignedRole 字段）
  │ 每 500ms 轮询检测 plan.md 是否就绪
  │
  ├─> [可选] DebateRoundtable
  │     │ 2-N 个 agent 多轮辩论
  │     │ Jaccard 相似度 >= 85% 收敛
  │     └─> 打磨 plan.md
  │
  ▼
用户确认 → script-confirm → stage
```

#### 2.1.2 已实现功能

| 功能 | 状态 | 文件 |
|------|:----:|------|
| Planner Agent 对话式规划 | ✅ | `script/script-manager.ts` |
| plan.md 自动生成 | ✅ | `script/script-manager.ts` |
| DebateRoundtable 多轮辩论 | ✅ | `script/debate-roundtable.ts` |
| Frontend ActionBar 修改 agentCount/reviewerCount | ✅ | `swarm-gui/` |
| 用户确认后进入 Stage | ✅ | `script/script-manager.ts` |

#### 2.1.3 与用户期望的差异

| 用户描述 | 实际实现 | 差距分析 |
|----------|---------|---------|
| "根据用户输入推荐具体 agent，用户筛选" | Script 阶段**只有一个 Planner agent**，无推荐逻辑 | Agent 推荐实际在 Stage 阶段入口（`agent-selector.ts`）完成，不是 Script 阶段。需在 Script 阶段加入 agent 推荐 UI 交互 |
| "不管最终是哪个 agent，role 都是 planner" | 当前统一为 planner ✅ | 一致 |

#### 2.1.4 plan.md 数据结构

```yaml
# plan.md 核心字段
tasks:
  - id: "task-1"
    title: "..."
    assignedRole: "worker" | "reviewer" | "cloner"
    dependsOn: ["task-0"]        # DAG 依赖关系
    estimatedHours: 2.5
    phase: "backend"
    details: "..."
    
metadata:
  totalEstimatedHours: 12
  recommendedAgentCount: 4
  parallelismLevel: "medium"
```

### 2.2 Stage 阶段（执行）

#### 2.2.1 核心流程

```
StageController.start()
  │
  ├─> TaskComplexityAnalyzer
  │     │ 分析 plan.md：并行度、代码面、安全标记
  │     └─> 估算 agent 数量 & 小时数
  │
  ├─> AgentSelector
  │     │ 评分：creditScore(0.4) + domainMatch(0.3)
  │     │       + successRate(0.2) + recency(0.1)
  │     │
  │     ├─> 已有 agent 够数 → 按评分筛选
  │     ├─> 已有 agent 不够 → 创建 agent-auto-N 补齐
  │     └─> 超出 → 按履历评分筛选
  │
  ├─> Role Assignment
  │     │ 先按 agent 偏好分配
  │     └─> round-robin 兜底
  │
  ├─> TaskQueue (DAG)
  │     │ 任务间 dependsOn 依赖
  │     │ pending → ready → in_progress → completed/blocked
  │     └─> 拓扑排序分 "wave"
  │
  ├─> PipelineController
  │     │ 同一 wave 内并行执行
  │     └─> Promise.all(agent waves)
  │
  └─> TodoTracker
        └─> 追踪 plan.md 中 TODO 完成状态
```

#### 2.2.2 Task DAG 实现

**文件**: `packages/coding-agent/src/swarm/executor/task-queue.ts`

```typescript
// DAG 核心数据结构
interface TaskNode {
  id: string;
  title: string;
  assignedRole: string;
  dependsOn: string[];        // 上游依赖
  status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'blocked';
  agentId?: string;
  // ...
}

// 执行策略：拓扑排序 → 分组 wave
// Wave 0: 无依赖的 task
// Wave 1: 仅依赖 Wave 0 的 task
// Wave 2: 仅依赖 Wave 0+1 的 task
// ...
// 同一 Wave 内: Promise.all() 并行执行
```

**DAG 的作用**：
1. 确保任务在依赖满足后才开始
2. 识别可并行执行的任务组（同一个 wave）
3. 在 Offload pipeline 中作为 Mermaid 图的骨架
4. 被 `PipelineController` 驱动实际执行

#### 2.2.3 并行执行机制

```typescript
// PipelineController 核心逻辑（简化）
async function executeWave(wave: TaskNode[]) {
  const promises = wave.map(async (task) => {
    const agent = getAgentForTask(task);
    // 每个 agent 独立进程/线程执行
    return agent.execute(task);
  });
  return Promise.all(promises); // 同 wave 内并行
}
```

#### 2.2.4 与用户期望的差异

| 用户描述 | 实际实现 | 严重程度 |
|----------|---------|:--------:|
| "agent 数量可在 confirm bar 中修改并成功传值" | confirm bar 有输入框，**`agentCount` 被发两次**，`reviewerCount` 丢失。且 StageController 不直接使用 confirm bar 值，而是重新从 plan 分析 | ⚠️ **Bug** |
| "agent 圆桌讨论自行分配 role" | **纯算法分配**（偏好 + round-robin），无 LLM 参与。代码有 roundtable 注释但未实现 | ❌ **未实现** |
| "单个 agent 可以 fork 出多个自己" | **无 forking 机制**。`agent-profile.ts` L8 明确声明"不做 Fork/Merge/Prune/Genesis" | ❌ **未实现** |
| "推选 reporter 向 human 汇报" | Reporter **硬编码创建**，非选举产生 | ❌ **未实现** |
| "human applaud → 结束 / 不满意 → planner 重新确认" | **无重试路径**。`applaudSignal` 是 AbortSignal 但从未被 wiring | ❌ **未实现** |

### 2.3 Curtain 阶段（收尾）

#### 2.3.1 核心流程

```
Stage 完成
  │
  ▼
CurtainRunner
  │
  ├─> Thread 1: Reporter Agent
  │     │ 硬编码创建（非选举）
  │     │ 读 workspace → 写摘要
  │     └─> 向用户汇报工作成果
  │
  └─> Thread 2: Reflection Pipeline
        │ 单 agent LLM 反思（cheap model）
        ├─> 提取 lessons
        ├─> 深度反思
        ├─> 写 ExperienceStore (SQLite FTS5 + JSONL)
        └─> 权重衰减 + 去重合并
  │
  ▼
用户 Applaud → curtain → idle
```

#### 2.3.2 ExperienceStore 设计

| 特性 | 实现 |
|------|------|
| 存储引擎 | SQLite FTS5（全文搜索）+ JSONL（持久化） |
| 去重 | Jaccard 相似度合并 |
| 权重衰减 | 时间衰减 + 使用频率加权 |
| 检索 | FTS5 关键词搜索 + 语义相似度 |

#### 2.3.3 GUI 支持

- `CurtainPanel` 组件：展示 reflections, lessons, stats
- `ApplaudButton`：用户点击后完成 Curtain

#### 2.3.4 与用户期望的差异

| 用户描述 | 实际实现 | 状态 |
|----------|---------|:----:|
| "所有 agent 圆桌会议，互相交流总结经验" | 单 agent LLM 反思（cheap model），非多 agent 圆桌 | ❌ **未实现** |
| "整理自己的履历" | Profile 定义了 DisplayInfo/CoreInfo 字段，但 Curtain 阶段**不调用**更新履历的逻辑 | ❌ **未实现** |
| "不可改的东西不能改" | 定义了 `DisplayInfo`(可改) vs `CoreInfo`(不可改) 两个接口，但 `CoreInfo` 边界尚未明确定义 | ⚠️ **设计阶段** |
| "agent 可联网搜索自我提升" | Curtain 中无 web search 接入 | ❌ **未实现** |

#### 2.3.5 Agent Profile 可修改字段设计

```typescript
// 当前设计定义（agent-profile.ts）
interface CoreInfo {
  // 不可修改的核心身份
  agentId: string;
  creationTimestamp: number;
  lineage: string[];        // 创建链（谁创建的）
  // 边界尚不明确...
}

interface DisplayInfo {
  // 可修改的展示信息
  displayName: string;
  avatar?: string;
  specialty?: string[];     // 专长领域
  description?: string;
  // ...
}

// 注意：Fork/Merge/Prune/Genesis 明确标记为"不做"
```

---

## 三、上下文卸载（Context Offloading）与 Mermaid 机制

### 3.1 设计来源

**直接参考 TencentDB-Agent-Memory**（位于 `/root/workspace/TencentDB-Agent-Memory/`）。

核心论文概念：**"符号化记忆"**——用 Mermaid 语法替代冗长的自然语言表示任务状态流。

**实验数据**（来自 TencentDB 论文）：
- Token 节省：**61.38%**
- Pass-rate 提升：**51.52%**

### 3.2 四层 Offload Pipeline

```
afterAgentRound (Worker Wave)
    │
    ├─> L1: WorkerSummarizer → ≤200 char summary → append JSONL
    │
afterReview (Cloner Wave)  
    │
    ├─> L1: Summarize cloner verdict → append JSONL
    │
afterIteration
    │
    ├─> L1.5: Deduplicator → 过滤低分噪音、去重、检测边界
    ├─> L2: PlanNodeAttributor → 映射到 plan.md phase node
    │         → MmdNode + MmdEdge
    └─> L3: MermaidSynthesizer → 生成 flowchart TD → 写 .mmd 文件
```

### 3.3 三层 MMD 注入策略

| Agent 类型 | 注入内容 | 用途 |
|-----------|---------|------|
| **Worker** | Local view: 只含自己负责的 phase + 上游已完成依赖 | 防止上下文迷失，聚焦当前任务 |
| **Cloner** | Global review view: 所有 Worker 执行节点 + 审查判定 | 全局审查，评估整体质量 |
| **LoopController** | Full view: 完整图 + 历史迭代存档 | 调度决策，检测瓶颈和阻塞 |

### 3.4 TencentDB vs SatoPi 设计差异

| 维度 | TencentDB | SatoPi |
|------|-----------|--------|
| 目标场景 | 单 agent 工具调用 | **多 agent swarm** |
| L1 摘要方式 | LLM 生成（远程后端） | **文本截断**（尚未接入 LLM） |
| MMD 粒度 | 单 agent 单视图 | **3 层**（Worker/Cloner/LoopController） |
| Plan 集成 | 无显式 phase | **plan.md 是 MMD 骨架** |
| Experience 桥接 | 无 | **内置** FTS5 + 权重衰减 |

### 3.5 与 oh-my-pi 原生 Compaction 的关系

oh-my-pi 有自己的 compaction 系统：

| 组件 | 功能 | 文件 |
|------|------|------|
| `shake.ts` | 手术式压缩：替换重工具结果为占位符 | `packages/agent/src/compaction/shake.ts` |
| `compaction.ts` | LLM 全量上下文化 | `packages/agent/src/compaction/compaction.ts` |
| `snapcompact` | Bitmap 压缩（Rust 原生） | `crates/snapcompact/` |

**关系总结**：两者是**互补的，不是替代**——
- oh-my-pi compaction → 单 agent session 级别压缩
- SatoPi offload → swarm 多 agent 级别压缩（Mermaid 图驱动）

### 3.6 当前实现状态

| 组件 | 状态 |
|------|:----:|
| WorkerSummarizer (L1) | ✅ 已实现（文本截断） |
| Cloner Verdict Summarizer (L1) | ✅ 已实现 |
| Deduplicator (L1.5) | ✅ 已实现 |
| PlanNodeAttributor (L2) | ✅ 已实现 |
| MermaidSynthesizer (L3) | ✅ 已实现 |
| 3 层 MMD 注入 | ✅ 已实现 |
| LLM 驱动的 L1 摘要 | ❌ 尚未接入 LLM（当前纯文本截断） |
| Experience 桥接 | ✅ 已实现 |

---

## 四、Agent 间通信机制

### 4.1 三层通信架构

```
┌─────────────────────────────────────────┐
│           AgentChannel (高层抽象)          │
│  broadcast / unicast / multicast         │
│  queryAll / queryAny / queryMajority     │
│  conductRoundtable                       │
├─────────────────────────────────────────┤
│              irc Tool (LLM 工具)           │
│  op: send / wait / inbox / list          │
│  支持 DM / broadcast / await reply       │
├─────────────────────────────────────────┤
│           IrcBus (进程级全局单例)          │
│  mailbox 模式 (cap: 100)                 │
│  自动 relay 到 Main session              │
│  回复线程 (replyTo)                       │
└─────────────────────────────────────────┘
```

### 4.2 IrcBus 详细设计

**文件**: `packages/coding-agent/src/irc/bus.ts` (415 行)

**核心概念**：Mailbox 模式——每个 agent 有独立邮箱。

```typescript
class IrcBus {
  static global(): IrcBus;  // 进程全局单例
  
  // 发送消息
  send(from: string, to: string, content: string, opts?: {
    replyTo?: string;       // 回复线程 ID
    broadcast?: boolean;    // 是否广播
    await?: boolean;        // 是否等待回复
  }): DeliveryStatus;       // injected | woken | revived | failed
  
  // 等待消息
  wait(agentId: string, opts?: {
    timeout?: number;
    signal?: AbortSignal;
    filter?: (msg) => boolean;
  }): Promise<Message>;
  
  // 自动 relay：子 agent 间通信推送到 Main agent session（人类可观测）
}
```

**关键特性**：
- 邮箱容量上限 100 条消息
- 支持 `injected`（注入到活跃 session）、`woken`（唤醒休眠 agent）、`revived`（恢复已卸载上下文）
- 自动 relay 机制确保所有通信对人类可见

### 4.3 IRC Tool 设计

**文件**: `packages/coding-agent/src/tools/irc.ts` (853 行)

| 操作 | 功能 | 示例 |
|------|------|------|
| `op: "send"` | 发送消息（DM/broadcast），可选 `await: true` 等回复 | `irc({op:"send", to:"worker-2", content:"...", await:true})` |
| `op: "wait"` | 阻塞等待消息 | `irc({op:"wait", timeout:30000})` |
| `op: "inbox"` | 查看/清空邮箱 | `irc({op:"inbox", clear:true})` |
| `op: "list"` | 列出所有 peer（状态、类型、未读数） | `irc({op:"list"})` |

### 4.4 AgentChannel 高层抽象

**文件**: `packages/coding-agent/src/swarm/channel/agent-channel.ts`

基于 IrcBus 的高级群聊抽象：

| 方法 | 功能 |
|------|------|
| `broadcast(msg)` | 向所有 agent 广播 |
| `unicast(target, msg)` | 点对点私聊 |
| `multicast(targets[], msg)` | 多播 |
| `queryAll(question)` | 询问所有 agent，收集全部回答 |
| `queryAny(question)` | 询问所有 agent，取第一个回答 |
| `queryMajority(question)` | 询问所有 agent，取多数回答 |
| `conductRoundtable(topic)` | 结构化多轮圆桌讨论 |

### 4.5 结论

IRC 已被设计为**三层架构**：工具层（irc tool）+ 传输层（IrcBus）+ 编排层（AgentChannel）。这个设计是合理且完整的。**无需将其变为抽象 tools**——当前的双重身份（既是 tool 又是 bus）已经覆盖了所有使用场景。

### 4.6 Environment Mark 机制（Stigmergic 协调）

#### 4.6.1 设计理念

**灵感来源**：Stigmergy（共识主动性）理论——蚂蚁群体通过改变共享环境间接通信，而非直接对话。

**学术引用**：Rodriguez 2026 研究论文，表明环境协调 vs 直接通信的**效率比为 32:1**。

#### 4.6.2 当前实现

**文件**: `packages/coding-agent/src/swarm/coordination/mark-environment.ts`

| 层 | 实现 | 状态 |
|----|------|:----:|
| `MarkStore` | 存储环境 marks（label + value + agentId + timestamp） | ✅ **已实现** |
| `GuardLayer` | 基于 mark 状态的访问控制 | ⚠️ **设计阶段** |
| `SignalAggregator` | marks 聚合与衰减 | ⚠️ **设计阶段** |

#### 4.6.3 设计文档

详细设计见 `docs/multi-agent-emergence-stigmergy-2026.md`。

**当前状态**：基础 MarkStore 已实现，GuardLayer 和 SignalAggregator 仍在设计文档阶段，**尚未完成代码实现**。

---

## 五、Role 分配与 Agent Forking

### 5.1 Role 分配机制（当前实现）

#### 5.1.1 算法流程

```
AgentSelector 选出 agent 池
  │
  ▼
Role Assignment
  │
  ├─> Step 1: 按 agent 偏好匹配
  │     │ agent.profile.preferredRoles ∩ plan.md requiredRoles
  │     └─> 匹配成功 → 分配
  │
  └─> Step 2: Round-robin 兜底
        │ 未分配 role 的 agent
        └─> 按剩余 role 列表轮询分配
```

#### 5.1.2 关键问题

1. **纯算法、无 LLM 参与**：代码中有 `// TODO: Roundtable for role assignment` 注释，但实现中完全没有 LLM 调用
2. **不支持用户期望的"agent 讨论分配 role"**
3. **Reporter role 硬编码**：不是在 agent 中选举，而是直接 `spawnSubAgent("reporter", role="reporter")`

### 5.2 Agent Forking（未实现）

**关键证据**：`agent-profile.ts` L8 明确声明：

```typescript
// 不做 Fork/Merge/Prune/Genesis
```

**`agent-scaler.ts` 的实际功能**：增删 agent 数量（创建新的 `agent-auto-N` 或删除），**不复制已有 agent 的状态和上下文**。

**用户期望**："单个 agent 觉得任务多，可以 fork 出多个自己并分配任务"——这需要：
1. 深拷贝 agent 的上下文/状态
2. 为 fork 出的实例分配子任务
3. 收集和合并 fork 结果

这三项**均未实现**。

### 5.3 Reporter Election（未实现）

当前 `curtain-runner.ts` 创建 Reporter 的方式：

```typescript
// 硬编码创建，非选举
const reporter = spawnSubAgent("reporter", {
  role: "reporter",
  // ...直接从系统配置读取
});
```

用户期望的"推选 reporter"需要：
1. Agent 之间投票/评估
2. 基于工作贡献、沟通能力等选举
3. Role 切换机制

**均未实现**。

### 5.4 Applaud/Dissatisfaction Loop（未实现）

**当前状态**：
- `applaudSignal` 类型是 `AbortSignal`，但在实际代码中**从未被 connect/wiring**
- Curtain 阶段完成后的唯一路径是 `curtain → idle`
- **无 "human 不满意 → planner 重新确认 → 更新 plan.md → 重新 stage" 的回退路径**

用户期望的 dissatisfaction loop 需要：
1. Curtain 阶段检测用户不满意的信号
2. 触发 Planner agent 介入
3. 与用户澄清不满意点
4. 更新 plan.md
5. 重新进入 Stage 阶段

**均未实现**。

---

## 六、Fork 自 oh-my-pi 的关系分析

### 6.1 复用情况矩阵

| 层级 | 模块 | oh-my-pi 原装 | SatoPi 新增 | 说明 |
|------|------|:-----------:|:--------:|------|
| **运行时** | `packages/agent/` | 100% | 0% | Agent 核心 |
| | `packages/ai/` | 100% | 0% | AI Provider |
| | `packages/catalog/` | 100% | 0% | 工具目录 |
| | `packages/utils/` | 100% | 0% | 工具函数 |
| **原生层** | `crates/mnemopi/` | 100% | 0% | 记忆后端 |
| | `crates/snapcompact/` | 100% | 0% | Bitmap 压缩 |
| | `crates/hashline/` | 100% | 0% | Hash 行缓存 |
| | ~55K 行 Rust | 100% | 0% | 全部原生模块 |
| **CLI/工具** | CLI 命令框架 | 100% | 0% | |
| | 工具系统 | 100% | 0% | |
| **TUI** | `packages/tui/` (~4000 行) | 100% | 0% | 差分渲染引擎 |
| **Python** | `python/robomp/` | 100% | 0% | |
| **记忆/压缩** | Compaction 系统 | 100% | 0% | `shake.ts`, `compaction.ts` |
| **Swarm 编排** | `packages/coding-agent/src/swarm/` (82 文件) | 0% | **100%** | 🔥 三阶段生命周期 |
| **Web 面板** | `packages/swarm-gui/` | 0% | **100%** | 🔥 React + Zustand |
| **Swarm 扩展** | `packages/swarm-extension/` | 0% | **100%** | 🔥 TUI 集成 |
| **经验学习** | Curtain + ExperienceStore | 0% | **100%** | 🔥 SQLite FTS5 |
| **Offload** | Offload Pipeline | 0% | **100%** | 🔥 Mermaid 驱动 |

### 6.2 架构风格一致性

#### ✅ 保持一致的设计模式

| 设计模式 | 说明 |
|----------|------|
| **Bun-first** | 运行时不编译，直接执行 TypeScript |
| **TypeScript + Rust + Python** | 三层技术栈 |
| `@oh-my-pi/*` scope | 统一的 npm scope |
| **YAML 配置驱动** | 所有配置通过 YAML 文件 |
| **Handlebars 模板 prompt** | Prompt 模板引擎 |
| **ES `#private` 字段** | 私有字段使用 JS 原生语法 |
| **Biome lint/format** | 统一代码风格 |
| **npm catalog 依赖管理** | 统一版本管理 |

#### ⚠️ 有意的架构分歧

详见 `docs/porting-from-pi-mono.md`：

| 差异点 | oh-my-pi | SatoPi | 原因 |
|--------|----------|--------|------|
| UI 架构 | `StatusLineComponent` | `FooterDataProvider` | Swarm 需要更复杂的状态展示 |
| Auth 存储 | `proper-lockfile` | `bun:sqlite` | 简化依赖 |
| Extension 加载 | `jiti` | 原生 `import()` | 利用 Bun 特性 |
| 多凭证认证 | 不支持 | 支持 | Swarm 多 agent 需要 |
| 能力发现 | 静态 | 基于 capability | 动态 agent 池 |

### 6.3 总体评价

SatoPi 是**纵深扩展型 fork**：
- **完整继承** oh-my-pi 的单 Agent 能力（运行时、工具、TUI、原生模块）
- **叠加全新**的多 Agent Swarm 编排层（三阶段生命周期 + Stigmergic 环境 + 存在性约束）
- **架构风格保持一致**（Bun-first、TS 直执、YAML 驱动）
- **理念转变**：从单 agent 对话 → 多 agent 协作
- **保持优雅**：与 oh-my-pi 设计风格一致，代码组织和模块划分清晰

---

## 七、GUI 与 TUI 状态评估

### 7.1 GUI (`swarm-gui`)

#### 7.1.1 功能覆盖（✅ 完整）

| 功能 | 状态 |
|------|:----:|
| **6 阶段渲染**：idle / script / script-debate / script-confirm / stage / curtain | ✅ |
| **8 种可视化**：Chat / Topology(React Flow+dagre) / Timeline / Files / Roles / Scaling / CommMatrix / Summary | ✅ |
| **SSE 实时推送** + REST API（30+ 端点） | ✅ |
| **Zustand 状态管理**（3 stores, 51KB swarm-store） | ✅ |
| CurtainPanel（reflections, lessons, stats, ApplaudButton） | ✅ |

#### 7.1.2 已知问题

| 问题 | 严重程度 | 详情 |
|------|:--------:|------|
| **confirm bar bug** | 🔴 高 | `agentCount` 被发送两次，`reviewerCount` 丢失 |
| **集成债务** | 🟡 中 | shadcn/ui 已安装但 0 个业务组件使用；i18n 初始化但 0 `useTranslation` 调用；theme CSS 变量未接入组件 |
| **轮询延迟** | 🟡 中 | agent 状态/分数通过 **5 秒轮询**，非 SSE 推送 |
| **测试覆盖不足** | 🟡 中 | 5 store tests + 5 component tests + 4 E2E specs（~7% 前端覆盖率，0% 组件测试） |
| **Topology 边限制** | 🟢 低 | 仅显示最后 50 个 activities |

### 7.2 TUI

#### 7.2.1 功能覆盖

| 功能 | 状态 |
|------|:----:|
| **差分渲染引擎** (~4000 行) | ✅ 完全实现 |
| **81 个测试文件**覆盖所有渲染细节 | ✅ |
| **组件库**：Box, Editor, Image, Markdown, ScrollView 等 | ✅ |
| **终端能力检测**：Kitty, iTerm2, Sixel | ✅ |
| **Swarm 扩展**：`/swarm run`, `/swarm status` 命令 | ✅ |
| Swarm 进度文本输出 (`renderSwarmProgress`) | ✅ |
| **多 agent 可视化专用 TUI**（类似 GUI 的 Topology/Timeline） | ❌ **不存在** |

#### 7.2.3 TUI vs GUI 差异

| 维度 | GUI | TUI |
|------|-----|-----|
| 用途 | 浏览器监控面板 | 终端交互式 coding |
| 通信方式 | HTTP/SSE → MonitorServer | 进程内直接调用 |
| 多 agent 可视化 | 8 种视图（Topology/Timeline 等） | 仅文本输出 |
| 阶段渲染 | 6 阶段全覆盖 | 基本的进度展示 |
| 交互性 | 高（点击、拖拽、缩放） | 中（Slash 命令） |

### 7.3 GUI-TUI 关系

**完全独立**——无共享状态、无同步问题。它们服务不同的使用场景：
- GUI：适合监控和可视化多 agent 协作过程
- TUI：适合终端中直接与 swarm 交互

---

## 八、关键问题与差距总结

### 8.1 问题汇总矩阵

| # | 用户期望 | 实际实现 | 严重程度 | 优先级 |
|---|---------|---------|:--------:|:------:|
| 1 | Script 阶段推荐 agent，用户筛选 | ❌ 只有一个 Planner；推荐在 Stage 阶段自动完成 | 中 | P1 |
| 2 | Agent 数量在 confirm bar 可修改并传值 | ⚠️ 有输入框但有 **confirm bar bug**（agentCount 发两次，reviewerCount 丢失） | 高 | **P0** |
| 3 | Agent 圆桌讨论分配 role | ❌ 纯算法分配，无 LLM 参与 | 高 | **P0** |
| 4 | Agent 可 fork 出多个自己 | ❌ 明确声明不做 Fork | 高 | **P0** |
| 5 | 推选 reporter 向 human 汇报 | ❌ Reporter 硬编码创建 | 中 | P1 |
| 6 | 不满意 → planner 重新确认 → 更新 plan | ❌ Curtain 无 dissatisfaction loop | 高 | **P0** |
| 7 | Curtain 圆桌会议总结经验 | ❌ 单 agent LLM 反思 | 中 | P1 |
| 8 | Agent 履历更新（限制可改字段） | ⚠️ Profile 定义了字段但 Curtain 不更新 | 中 | P1 |
| 9 | Agent 可联网搜索自我提升 | ❌ Curtain 中无 web search 接入 | 低 | P2 |
| 10 | GuardLayer + SignalAggregator | ⚠️ 仅设计文档，未实现代码 | 低 | P2 |
| 11 | L1 Offload 接入 LLM 摘要 | ⚠️ 当前仅文本截断 | 低 | P2 |
| 12 | TUI 多 agent 可视化 | ❌ 不存在 | 低 | P3 |

### 8.2 优先级说明

- **P0 (阻断性)**：影响核心用户流程，必须优先修复
- **P1 (重要)**：影响用户体验完整性
- **P2 (优化)**：增强功能
- **P3 (低优先级)**：锦上添花

### 8.3 推荐修复顺序

```
Phase 1 (P0 - 核心功能补全):
  1. 修复 confirm bar bug（agentCount/reviewerCount 传值）
  2. 实现 Stage 阶段的 agent 圆桌讨论分配 role
  3. 实现 Agent forking 机制
  4. 实现 dissatisfaction loop（不满意 → planner → 更新 plan → 重新 stage）

Phase 2 (P1 - 用户体验完善):
  5. Script 阶段加入 agent 推荐 UI
  6. 实现 Reporter 选举机制
  7. 实现 Curtain 多 agent 圆桌会议
  8. 实现 Agent 履历自动更新

Phase 3 (P2 - 增强):
  9. Curtain 接入 web search
  10. GuardLayer + SignalAggregator 代码实现
  11. Offload L1 接入 LLM

Phase 4 (P3 - 锦上添花):
  12. TUI 多 agent 可视化
```

---

## 附录：关键文件索引

### Swarm 编排核心

| 文件 | 行数 | 功能 |
|------|:----:|------|
| `packages/coding-agent/src/swarm/script/script-manager.ts` | ~350 | Script 阶段管理 |
| `packages/coding-agent/src/swarm/script/debate-roundtable.ts` | ~200 | 多轮辩论 |
| `packages/coding-agent/src/swarm/stage/stage-controller.ts` | ~500 | Stage 阶段编排 |
| `packages/coding-agent/src/swarm/stage/agent-selector.ts` | ~250 | Agent 评分选择 |
| `packages/coding-agent/src/swarm/stage/task-complexity-analyzer.ts` | ~200 | 任务复杂度分析 |
| `packages/coding-agent/src/swarm/executor/task-queue.ts` | ~300 | Task DAG |
| `packages/coding-agent/src/swarm/executor/todo-tracker.ts` | ~150 | TODO 追踪 |
| `packages/coding-agent/src/swarm/monitor/curtain-runner.ts` | ~400 | Curtain 阶段 |
| `packages/coding-agent/src/swarm/agent/agent-profile.ts` | ~200 | Agent 配置 |
| `packages/coding-agent/src/swarm/agent/agent-scaler.ts` | ~150 | Agent 数量管理 |
| `packages/coding-agent/src/swarm/agent/role-asset.ts` | ~100 | Role 定义 |

### 上下文卸载

| 文件 | 功能 |
|------|------|
| `packages/coding-agent/src/swarm/offload/worker-summarizer.ts` | L1: Worker 摘要 |
| `packages/coding-agent/src/swarm/offload/deduplicator.ts` | L1.5: 去重 |
| `packages/coding-agent/src/swarm/offload/plan-node-attributor.ts` | L2: Plan 映射 |
| `packages/coding-agent/src/swarm/offload/mermaid-synthesizer.ts` | L3: Mermaid 生成 |

### Agent 通信

| 文件 | 行数 | 功能 |
|------|:----:|------|
| `packages/coding-agent/src/irc/bus.ts` | 415 | IRC Bus（进程全局单例） |
| `packages/coding-agent/src/tools/irc.ts` | 853 | IRC Tool（LLM 可调用） |
| `packages/coding-agent/src/swarm/channel/agent-channel.ts` | ~300 | AgentChannel 高层抽象 |
| `packages/coding-agent/src/swarm/coordination/mark-environment.ts` | ~200 | Environment Mark |

### GUI

| 文件 | 行数 | 功能 |
|------|:----:|------|
| `packages/swarm-gui/src/stores/swarm-store.ts` | ~51KB | 核心状态管理 |
| `packages/swarm-gui/src/components/panels/CurtainPanel.tsx` | ~200 | Curtain 面板 |
| `packages/swarm-gui/src/App.tsx` | ~300 | 主入口 |

### 设计文档

| 文件 | 内容 |
|------|------|
| `docs/satopi-architecture-analysis.md` | 架构分析 |
| `docs/satopi-architecture-final-report.md` | 最终架构报告 |
| `docs/satopi-offload-deep-dive.md` | Offload 深度分析 |
| `docs/swarm-architecture-research.md` | Swarm 架构研究 |
| `docs/swarm-data-flow-analysis.md` | 数据流分析 |
| `docs/multi-agent-emergence-stigmergy-2026.md` | Stigmergy 协调设计 |
| `docs/frontier-multi-agent-architecture-2026.md` | 前沿多 agent 架构 |
| `docs/agent-existential-constraints-2026.md` | Agent 存在性约束 |
| `docs/porting-from-pi-mono.md` | oh-my-pi 迁移差异 |
| `docs/satopi-frontend-optimization-2025-07.md` | 前端优化计划 |
| `docs/satopi-v2-system-design.md` | V2 系统设计 |

---

> **报告完成时间**: 2025-07-24
> **调研方法**: 源码级分析，覆盖 82 个 Swarm 核心文件 + GUI/TUI + 通信模块 + oh-my-pi 对比
> **总代码审查量**: 约 15,000+ 行 TypeScript
