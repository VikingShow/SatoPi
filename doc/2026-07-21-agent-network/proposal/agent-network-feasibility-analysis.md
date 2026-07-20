# Agent Profile 经验关联 & 分布式网络可行性分析

> 基于 `agent-profile-proposal.md` | 2026-07-21

---

## 一、Agent Profile "经验" 与 Offload 上下文的关系

### 1.1 两者的定位

```
Offload Context (Session 级, JSONL)       Agent Experience (跨 Session, JSON)
─────────────────────────────────       ────────────────────────────────────
粒度:    迭代级摘要 + MMD 节点            粒度:    任务级 keyLearning
存储:    .omp/offload/{agentId}.jsonl     存储:    .omp/agents/{agentId}.json
生命周期: Swarm session 内                生命周期: 永久累积 (限 50 条)
用途:    当前循环内的上下文注入            用途:    Agent 履历 + 分工决策
格式:    SwarmOffloadEntry (结构化)       格式:    ExperienceEntry (蒸馏)
```

### 1.2 关联链路

```
executeSwarmAgent() → SingleResult
        │
        ▼
[L1 WorkerSummarizer]  ← 生成 ≤200 字摘要
        │
        ▼
[SwarmOffloadEntry]    ← 写入 .omp/offload/{agentId}.jsonl
        │                                               
        ├── 路径 A (已有) ──→ L1.5 Dedup → L2 Attributor → L3 MermaidSynthesizer
        │                     → 注入 next iteration prompt
        │
        └── 路径 B (新增) ──→ LLM 蒸馏 → ExperienceEntry → Agent Profile JSON
                              ┌─────────────────────────────────┐
                              │ keyLearning: "REST 接口参数校验 │
                              │ 缺失导致 cloner 评分低，后续    │
                              │ 任务需要优先补全 Pydantic schema"│
                              └─────────────────────────────────┘
```

### 1.3 蒸馏 Prompt 设计

L2 完成后，对每个 Agent 的 accumulated entries 调用一次 LLM 蒸馏：

```typescript
const distillPrompt = `
你是 Agent Experience Distiller。分析以下 Agent 在本次 session 中的 offload 上下文，提取 ≤3 条关键经验。

## Agent Offload 上下文
${agentEntries.map(e => `- [${e.timestamp}] ${e.task_call}: ${e.summary} (score: ${e.score})`).join("\n")}

## 要求
- 每条 keyLearning ≤ 100 字
- 聚焦于：成功模式 / 失败教训 / 意外发现 / 协作经验
- 如果全是低分 (avg < 4)，标记 outcome: "failure"
- 如果有明显改进模式，标记 outcome: "success"

输出 JSON 数组:
[{"keyLearning": "...", "outcome": "success|partial|failure", "domain": "..."}]
`;
```

### 1.4 数据流动示意

```
┌───────────────── Session N ─────────────────┐
│                                              │
│  Iter 0: W1(score8) W2(score6) C1(pass)     │
│    ↓ L1→L2→L3                                │
│  Offload: 3 entries in JSONL                 │
│    ↓ LLM Distill                             │
│  Experience: "W1 REST API 模式可复用"        │
│                                              │
├──────────────────────────────────────────────┤
│  Iter 1: beforeWorkerRound                   │
│    ↓ 从 Agent Profile 注入经验               │
│  W1 prompt += "<agent_experience>             │
│    上次 session: REST API 创建模式评分 8/10,  │
│    建议复用该模式处理 Auth 接口.              │
│  </agent_experience>"                        │
│                                              │
│  afterIteration:                             │
│    ↓ 更新 trackRecord.successRate             │
│    ↓ 追加新的 keyLearning                     │
│    ↓ 裁剪到 50 条                             │
└──────────────────────────────────────────────┘
```

### 1.5 跨 Session 注入格式

在 `beforeWorkerRound` 或 `beforeClonerReview` 中注入 Agent 的履历摘要：

```xml
<agent_profile id="worker-api-expert">
  <track_record>
    sessions: 15 | success_rate: 87% | avg_score: 7.2 | top_domains: API, Auth
  </track_record>
  <recent_experience>
    <entry session="sess-14" outcome="success" score="9">
      Pydantic schema 前置定义可避免 80% 的参数校验问题
    </entry>
    <entry session="sess-13" outcome="failure" score="3">
      直接操作 ORM 而非 service 层导致数据一致性问题
    </entry>
  </recent_experience>
</agent_profile>
```

融入现有的 MMD 注入格式：

```xml
<current_swarm_context>
  <!-- MMD 局部视图 (已有) -->
  flowchart TD ...
</current_swarm_context>

<agent_profile id="worker-api-expert">
  <!-- 履历摘要 (新增) -->
  ...
</agent_profile>
```

---

## 二、分布式 Agent 网络 — 技术可行性分析

### 2.1 Hub 的具体形式

**SatoPi Hub = LoopController + AgentRegistry + TransportLayer**

```
┌─────────────────────────────────────────────────┐
│                  SatoPi Hub                       │
│                                                   │
│  ┌─────────────┐  ┌──────────────┐               │
│  │ LoopController│  │ AgentRegistry │              │
│  │ (已有)        │  │ (新增)        │              │
│  │ - 循环编排    │  │ - Agent 注册  │              │
│  │ - Phase 分配  │  │ - 能力发现    │              │
│  │ - 上下文注入  │  │ - 心跳管理    │              │
│  └──────┬───────┘  └──────┬───────┘              │
│         │                 │                       │
│         └────────┬────────┘                       │
│                  │                                │
│  ┌───────────────┴──────────────┐                │
│  │     TransportLayer (新增)     │                │
│  │  - WebSocket Server           │                │
│  │  - gRPC Server (备选)         │                │
│  │  - Message Router             │                │
│  └───────────────────────────────┘                │
│                  │                                │
└──────────────────┼────────────────────────────────┘
                   │ WebSocket / gRPC
    ┌──────────────┼──────────────┐
    │              │              │
┌───┴───┐    ┌────┴───┐    ┌────┴───┐
│ Agent │    │ Agent  │    │ Agent  │
│ Alice │    │  Bob   │    │ Carol  │
│(远程) │    │(远程)  │    │(远程)  │
└───────┘    └────────┘    └────────┘
```

### 2.2 外部 Agent 的具体形式

**方案 A: 轻量 SDK (推荐)**

外部 Agent 是一个独立进程，通过 SDK 连接到 Hub：

```typescript
// 外部开发者集成方式
import { SatoPiAgent } from "@oh-my-pi/agent-sdk";

const agent = new SatoPiAgent({
  identity: {
    id: "worker-alice-security",
    displayName: "Alice's Security Expert",
    agentType: "cloner",
    expertise: [{ domain: "Security Audit", level: "expert" }],
    capabilities: [
      { tool: "code_review", proficiency: 9 },
      { tool: "pentest", proficiency: 7 },
    ],
  },
  hubUrl: "wss://satopi-hub.example.com/ws",
  authToken: process.env.SATOPI_TOKEN,
  workspace: "./my-workspace", // 本地工作区
});

// Hub 分配任务后自动执行
agent.onTask(async (task) => {
  // task.phaseContext: 当前 phase 的代码/上下文
  // task.injectedContext: MMD 图 + 历史经验
  const result = await myLocalExecutor.run(task);
  return result; // 自动序列化回 Hub
});

await agent.connect(); // 注册并开始监听
```

**方案 B: HTTP Webhook (更简单)**

```typescript
// Hub 通过 HTTP POST 调用外部 Agent
// 外部 Agent 暴露一个 /execute endpoint
const agentServer = createAgentServer({
  port: 9191,
  handler: async (req) => {
    const task = req.body; // { phaseContext, injectedContext, ... }
    const result = await runLocally(task);
    return { status: "done", output: result };
  },
});
agentServer.listen();
```

**对比：**

| 维度 | WebSocket SDK (A) | HTTP Webhook (B) |
|------|-------------------|-------------------|
| 实时性 | 双向实时 | 轮询或长连接 |
| 复杂度 | 中等 | 低 |
| 防火墙友好 | 一般 | 好 (标准 HTTP) |
| 状态管理 | 天然双向 | 需要额外同步 |
| 断线重连 | SDK 内置 | 需自行实现 |
| **推荐** | ✅ Prod | PoC/简单场景 |

### 2.3 消息协议

```typescript
// WebSocket 消息类型
type HubToAgent = 
  | { type: "REGISTER_ACK"; sessionId: string; assignedPhase: PhaseInfo }
  | { type: "TASK"; taskId: string; phaseContext: string; injectedMMD: string; injectedExperience: string }
  | { type: "REVIEW_REQUEST"; reviewId: string; workerOutputs: string[]; historicalFindings: string[] }
  | { type: "SYNC"; updatedProfile: AgentProfile; deltaMmd: string }
  | { type: "HEARTBEAT_ACK" }
  | { type: "SESSION_END"; summary: string };

type AgentToHub = 
  | { type: "REGISTER"; profile: AgentProfile; authToken: string }
  | { type: "TASK_RESULT"; taskId: string; result: SingleResult }
  | { type: "REVIEW_VERDICT"; reviewId: string; verdict: ReviewVerdict }
  | { type: "SYNC_REQUEST"; lastKnownHash: string; lastSessionId: string }
  | { type: "HEARTBEAT"; timestamp: string }
  | { type: "DISCONNECT"; reason: string };
```

### 2.4 安全模型

```
┌─────────────────────────────────────────────────────┐
│  安全层级                                            │
│                                                      │
│  1. Transport 层: WSS (TLS 1.3)                     │
│  2. Auth 层: Token + PublicKey 签名                  │
│  3. Access 层: Phase-based ACL                      │
│     - 外部 Agent 只能访问分配的 phase 上下文         │
│     - Cloner Agent 可以看到所有 Worker 产出          │
│     - 不能访问其他 Agent 的 Profile                  │
│  4. Rate Limit: 每 Agent 每秒 ≤ 10 消息              │
│  5. Trust Level:                                     │
│     - local agent: trust=1.0 (完整投票权)            │
│     - remote verified: trust=0.7 (部分投票权)        │
│     - remote new: trust=0.3 (观察模式, 无否决权)     │
└─────────────────────────────────────────────────────┘
```

### 2.5 数据所有权与同步

```
┌─── Hub ───────────────────────┐    ┌─── External Agent ───┐
│                                │    │                      │
│  Canonical Source:             │    │  Local Copy:          │
│  ├── AgentProfile (完整)       │◄──►│  ├── AgentProfile     │
│  ├── Session History (完整)    │    │  │   (自己的, 完整)   │
│  ├── Global MMD Archive (完整) │    │  ├── Results          │
│  └── All Agent Profiles        │    │  │   (自己产出的)     │
│                                │    │  └── MMD Snapshots    │
│  同步规则:                      │    │   (与自己相关的子图)  │
│  - Hub 是 canonical source     │    │                      │
│  - 写入只发生在 Hub             │    │  重连流程:            │
│  - Agent 侧只读自己的 Profile   │    │  1. Agent → Hub:     │
│  - 冲突时以 Hub 为准            │    │     syncRequest      │
│                                │    │  2. Hub → Agent:     │
│                                │    │     delta(since      │
│                                │    │     lastKnownHash)   │
└────────────────────────────────┘    └──────────────────────┘
```

### 2.6 失败模式与降级策略

| 场景 | 检测方式 | 降级策略 |
|------|----------|----------|
| 外部 Agent 掉线 | 心跳超时 (15s) | 标记 offline，用本地同类型 Agent 替代 |
| 网络分区 | 心跳 + task timeout | 等待 30s → 降级 → 重连后同步 |
| Agent 执行超时 | task timeout (120s) | 取消任务 → 重新分配给本地 agent |
| Agent 返回异常结果 | Cloner Council 检测质量 | 降低 trustLevel → 减少任务分配 |
| Hub 重启 | Agent 检测连接断开 | 本地缓存任务结果 → 重连后批量提交 |

### 2.7 与现有架构的集成点

```
loop-controller.ts (已有, 零修改)
│
├── beforeWorkerRound (hook)
│   │   ┌── 检查 worker 列表
│   │   │   ├── local worker → executeSwarmAgent() (已有)
│   │   │   └── remote worker → transportLayer.sendTask() (新增)
│   │   └── 注入 MMD + Agent Experience (已有 + 扩展)
│   │
├── afterWorkerRound (hook)
│   │   ├── local results → L1 summarizer (已有)
│   │   ├── remote results → L1 summarizer (新增)
│   │   └── 更新 Agent TrackRecord (新增)
│   │
├── beforeClonerReview (hook)
│   │   ├── local cloners → ClonerCouncil.review() (已有)
│   │   └── remote cloners → transportLayer.sendReviewRequest() (新增)
│   │
├── afterClonerReview (hook)
│   │   └── 更新 Cloner trustLevel (新增)
│   │
└── afterIteration (hook)
    ├── L2→L3 pipeline (已有)
    ├── LLM keyLearning distillation (新增)
    ├── Agent Profile 更新 (新增)
    └── TransportLayer 广播 SYNC (新增)
```

### 2.8 实施评估

| 阶段 | 工作量 | 依赖 | 风险 |
|------|--------|------|------|
| Phase 6a: AgentProfile 类型 + 本地持久化 | 300 行, 2d | 无 | 低 |
| Phase 6b: 经验蒸馏 + 履历注入 | 200 行, 1d | Phase 6a | 低 |
| Phase 6c: WebSocket Transport Layer | 500 行, 3d | Phase 6a | 中 (网络不稳定) |
| Phase 6d: 外部 Agent SDK | 400 行, 2d | Phase 6c | 中 |
| Phase 6e: 同步协议 + 断线重连 | 300 行, 2d | Phase 6c | 中-高 |

**结论: 技术上完全可行。** 核心原因是：
1. `LoopPipelineHooks` 已为所有集成点提供了接口，**loop-controller.ts 零修改**
2. 外部 Agent 复用 `SingleResult` / `ReviewVerdict` 的序列化格式
3. 安全模型通过 `trustLevel` 权重 + Phase ACL 实现渐进信任

**建议先实施 Phase 6a + 6b（本地 Agent Profile 和经验蒸馏），验证概念后再引入网络层。**
