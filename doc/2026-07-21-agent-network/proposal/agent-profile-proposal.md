# Agent Profile 设计提案

## 当前状态 vs 目标

```
当前: Agent = "worker-a1" (纯字符串)
目标: Agent = AgentProfile { id, role, expertise, trackRecord, peers, ... }
```

## AgentProfile 完整 Schema

```typescript
interface AgentProfile {
  // ===== 身份标识 =====
  id: string;                    // "worker-api-expert" — 全局唯一
  displayName: string;           // "API Layer Expert"
  agentType: "worker" | "cloner" | "orchestrator" | "external";

  // ===== 能力声明 =====
  expertise: Expertise[];        // 擅长领域
  capabilities: Capability[];    // 工具/技能清单
  role: AgentRole;               // 在 Cloner Council 中的角色

  // ===== 履历 (跨 session 累积) =====
  trackRecord: TrackRecord;      // 历史表现统计
  experience: ExperienceEntry[]; // 关键经验条目（限量保留，如最近 50 条）

  // ===== 网络信息 =====
  origin: AgentOrigin;           // local | remote:{host}:{port}
  connectionState: ConnectionState;
  registrationTime: string;      // 首次注册时间

  // ===== 当前 Session 运行时状态 =====
  currentIteration: number;      // 当前迭代
  currentPhaseId?: string;       // 当前被分配的 phase
  contextDigest?: string;        // 最近一次 offload 摘要（≤500 字）
}
```

### 子类型详解

```typescript
interface Expertise {
  domain: string;               // "API Design", "Database Schema", "Auth", "Testing"
  level: "novice" | "proficient" | "expert" | "master";
  yearsOfExperience?: number;
  provenTasks: number;          // 已成功完成的相关任务数
}

interface Capability {
  tool: string;                 // "read_file", "execute_command", "write_code"
  proficiency: number;          // 0-10
  lastUsed?: string;            // ISO datetime
}

interface AgentRole {
  name: string;                 // "guardian" | "adversarial" | "security" | "performance" | "architecture"
  weight: number;               // 投票权重 (1-10)
  vetoPower: boolean;           // 是否有否决权
}

interface TrackRecord {
  totalSessions: number;        // 参与的总 session 数
  totalTasks: number;           // 执行的总任务数
  successRate: number;          // 0-1
  avgScore: number;             // 平均 Cloner 评分
  bestScore: number;            // 最高评分
  worstScore: number;           // 最低评分
  topDomains: string[];         // 表现最好的领域
  collaborationCount: Map<string, number>; // 与各 Agent 的协作次数
}

interface ExperienceEntry {
  timestamp: string;
  sessionId: string;
  task: string;                 // 任务描述
  outcome: "success" | "partial" | "failure";
  clonerScore: number;
  keyLearning: string;          // 关键教训（LLM 生成，≤100 字）
  domain: string;
}

type AgentOrigin = 
  | { type: "local" }
  | { type: "remote"; host: string; port: number; publicKey: string };

type ConnectionState = 
  | "online" | "offline" | "syncing" | "unregistered";
```

---

## 存储设计

```
.omp/
├── agents/                      # Agent Profile 持久化目录
│   ├── worker-api-expert.json   # 每个 Agent 一个 JSON 文件
│   ├── cloner-guardian.json
│   └── external-alice.json
├── offload/                     # (已有) Session 级 offload JSONL
├── mmds/                        # (已有) Mermaid 图
└── sessions/
    └── session.jsonl            # (已有) 统一 session 日志
```

Agent Profile JSON 文件结构：
```json
{
  "id": "worker-api-expert",
  "displayName": "API Layer Expert",
  "agentType": "worker",
  "expertise": [...],
  "trackRecord": { "totalSessions": 15, "successRate": 0.87 },
  "experience": [...],           // 最近 50 条
  "origin": { "type": "local" },
  "lastUpdated": "2026-07-20T10:00:00Z"
}
```

**写入策略**：
- `trackRecord` 在每次 `afterIteration` 中更新
- `experience` 通过 LLM 在执行后生成 `keyLearning`，追加并裁剪到 50 条
- 持久化走 `SessionStorage.writeTextAtomic()`，不阻塞 loop

---

## 生命周期

```
Agent Profile 生命周期 > Swarm Session 生命周期

创建  →  注册  →  多 Session 累积  →  退休
 │        │           │                  │
 │        │           └─ 每个 session    └─ 标记 inactive
 │        │              结束时更新       但保留历史
 │        │              trackRecord
 │        │
 │        └─ 对外部 agent: 网络注册 + 握手
 │
 └─ 首次使用或外部 agent 注册时创建
```

### 与现有 offload 的关系

```
Session Offload (JSONL)     Agent Profile (JSON)
───────────────────────     ─────────────────────
生命周期: session 内         生命周期: 跨 session
内容: 迭代级摘要             内容: 累积履历
用途: 当前循环内上下文注入    用途: 分工决策 + 经验传递
```

两者不冲突。`afterIteration` 同时写入两者：
1. L1→L2→L3 产出 → Session JSONL (已有)
2. trackRecord + experience → Agent Profile JSON (新增)

---

## 对 Cloner Council 分工的影响

有了 Agent Profile 后，Cloner Council 可以做基于履历的智能分工：

```typescript
// beforeClonerReview hook 中
function assignClonerRoles(phases: PlanPhase[], agents: AgentProfile[]): Map<string, string> {
  // 1. 按 expertise 匹配 phase
  // 2. 按 trackRecord.successRate 加权
  // 3. 上次失败的 agent 降权
  // 4. 输出: agentId → "review {phase.title}" 映射
}
```

---

## 分布式 Agent 网络架构

这是你提到的"其他人注册 agent 参与圆桌"的场景。架构如下：

### 注册协议

```
External Agent           SatoPi Hub (loop-controller)
     │                           │
     │── REGISTER ──────────────→│  { id, expertise, capabilities,
     │   (AgentProfile)          │    host:port, publicKey }
     │                           │
     │←── ACK ──────────────────│  { sessionId, assignedPhase, 
     │   (ACCEPTED/REJECTED)     │    currentMMD }
     │                           │
     │←── TASK ─────────────────│  { task, phaseContext, injectedMMD }
     │   (worker round)          │
     │                           │
     │── RESULT ────────────────→│  { SingleResult }
     │                           │
     │←── REVIEW_REQUEST ───────│  { workerOutputs[], historicalFindings }
     │   (cloner round)          │
     │                           │
     │── VERDICT ───────────────→│  { ReviewVerdict }
     │                           │
     │←── SYNC ─────────────────│  同步更新后的 AgentProfile + MMD
     │   (iteration end)        │
     │                           │
     │── BYE ───────────────────│  断开
     │                           │
```

### 数据同步策略

```
SatoPi Hub 侧保留：          External Agent 侧保留：
  - 完整的 AgentProfile       - 自己的 AgentProfile
  - 该 agent 参与的           - 自己产出的所有结果
    所有 session 记录         - 接收到的 MMD 视图
  - 全局 MMD 历史存档         - 与其他 agent 的协作摘要

重连时：
  1. External → Hub: [lastKnownStateHash, lastSessionId, lastIteration]
  2. Hub → External: delta(AgentProfile + missing MMD snapshots)
  3. 双方 merge, 以 Hub 为准（Hub 是 canonical source）
```

### 安全约束

- 注册需要 publicKey 验证身份
- 外部 agent 只能看到和自己 phase 相关的 MMD 子图（安全过滤）
- 投票权重受 trustLevel 影响（新注册 agent 权重低）
- 网络超时 → 降级为本地 fallback agent

---

## 实施路线图

| Phase | 内容 | 复杂度 |
|-------|------|--------|
| **Phase 6a** | AgentProfile 类型定义 + 本地持久化 + trackRecord 更新 | 低 (schema + store) |
| **Phase 6b** | Cloner Council 基于履历的智能分工 | 中 (注入逻辑) |
| **Phase 6c** | 外部 Agent 注册协议 + WebSocket transport | 高 (网络层) |
| **Phase 6d** | 双向数据同步 + 增量合并 | 高 (CRDT/merge) |
| **Phase 6e** | Agent 市场/发现服务 | 远期 |
