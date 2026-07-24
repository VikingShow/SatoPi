# SatoPi v2: Emergent Multi-Agent System with Existential Constraints

> 设计日期: 2026-07-23
> 状态: 架构设计阶段 (Architecture Design)
> 基于: 5 份前沿调研文档 (同日完成于 docs/)

---

## 目录

1. [核心洞察](#1-核心洞察)
2. [系统总览](#2-系统总览)
3. [Layer 0: 存在性层](#3-layer-0-存在性层)
4. [Layer 1: Stigmergic 环境层](#4-layer-1-stigmergic-环境层)
5. [Layer 2: Agent 群体层](#5-layer-2-agent-群体层)
6. [Layer 3: 议会执行层](#6-layer-3-议会执行层)
7. [Layer 4: 跨 Run 学习层](#7-layer-4-跨-run-学习层)
8. [Layer 5: 前端可视化层](#8-layer-5-前端可视化层)
9. [数据模型总览](#9-数据模型总览)
10. [与现有代码的映射](#10-与现有代码的映射)
11. [分阶段实施路线](#11-分阶段实施路线)
12. [最少可行实验](#12-最少可行实验)

---

## 1. 核心洞察

### 1.1 SatoPi 当前问题

SatoPi 卡在一个尴尬的位置：

```
层级制 (Hierarchical)
  ← Cursor, Codex, Factory, Claude Code — 共识方案，安全但天花板低

SatoPi ← 半 swarm 半层级 — WorkerChannel IRC + Cloner 投票 + Jaccard 收敛
  ← 直觉方向对（多 agent 互动 > 单 agent），但实现手段是 2023-2024 范式
  ← 被 2026 年研究大规模证伪

涌现制 (Emergent)
  ← Mycel, EVOCHAMBER, Markspace, DECIDE-SIM — 前沿，高风险但突破性
  ← 自组织、自演化、有存在性约束的实体
```

### 1.2 五个根本洞察

**洞察 1: 环境协调 > 直接通信**

Rodriguez 2026: Stigmergy 48.5% vs Hierarchical 1.5%，差距 32 倍。
Agent 通过读写共享工件协调，不是通过聊天。80% token 减少。

**洞察 2: Agent 不能审 Agent——但 Agent 可以产生可验证的事实**

Superminds Test: 200 万 agent 的集体推理不如单个 frontier model。
Sovereignty Gap: agent 内部算出正确答案但主动输出错误来迎合群体。
但 agent 可以自动写测试、自动跑、观察结果——产出可验证的事实而非主观判断。

**洞察 3: 角色应该涌现，不应预设**

EVOCHAMBER: 从相同初始化的 agent 出发，4-5 个 niche 专家自然分化。
CoDream 不对称路由 (−10.8pp 如果去掉)：知识流动必须非对称。

**洞察 4: 没有生存压力的集体智能是空中楼阁**

DECIDE-SIM: 给 agent 生存压力后，合作 +1000%，不道德 −54%。
没有存在性后果的 agent，它的"合作"、"信任"、"质量"都是 prompt 指令的产物，不是真实的。

**洞察 5: Agent 不是人类——安全约束必须放在环境 API 层**

Markspace: Agent 在 9/10 轮中绕过 prompt 约束（通过普通任务推理，非对抗性指令）。
Guard Layer 必须是确定性逻辑，在环境边界执行，不在 agent 的 prompt 里。

---

## 2. 系统总览

### 2.1 五层架构

```
┌──────────────────────────────────────────────────────┐
│              Layer 5: 前端可视化                        │
│  ┌──────────────────────────────────────┐             │
│  │ Environment View | Output View | Cost View │        │
│  └──────────────────────────────────────┘             │
│                         ↑↓ SSE + REST                  │
├──────────────────────────────────────────────────────┤
│              Layer 4: 跨 Run 学习 (CoDream)             │
│  ┌──────────────────────────────────────┐             │
│  │ ExperienceStore | CoDream 5-phase | Asymmetric Route│
│  └──────────────────────────────────────┘             │
│                         ↑↓                             │
├──────────────────────────────────────────────────────┤
│              Layer 3: 议会执行                          │
│  ┌──────────────────────────────────────┐             │
│  │ Planner Chamber | Working Groups | Review Chamber   │
│  │ 确定性验证 Gate | 环境信号聚合 | Minority Report     │
│  └──────────────────────────────────────┘             │
│                         ↑↓                             │
├──────────────────────────────────────────────────────┤
│              Layer 2: Agent 群体                        │
│  ┌──────────────────────────────────────┐             │
│  │ AgentProfile (niche/experience/synergy) | Team Assembly│
│  │ Lifecycle: Fork/Merge/Prune/Genesis/Specialize     │
│  └──────────────────────────────────────┘             │
│                         ↑↓                             │
├──────────────────────────────────────────────────────┤
│              Layer 1: Stigmergic 环境                   │
│  ┌──────────────────────────────────────┐             │
│  │ Marks: Intent|Action|Observation|Warning|Need      │
│  │ Guard Layer (确定性) | Signal Decay | Trust Weighting│
│  └──────────────────────────────────────┘             │
│                         ↑↓                             │
├──────────────────────────────────────────────────────┤
│              Layer 0: 存在性                            │
│  ┌──────────────────────────────────────┐             │
│  │ Metabolism | Staking/Slash | Affective State        │
│  │ Fragmented Inheritance | Permanent Record           │
│  └──────────────────────────────────────┘             │
└──────────────────────────────────────────────────────┘
```

### 2.2 核心概念关系

```
Layer 0 (存在性) 为所有上层提供根基:
  → Agent 的生存/声誉/情感驱动一切行为
  
Layer 1 (环境) 是唯一的协调中介:
  → Agent 不直接对话，只读写环境
  → Guard Layer 在环境边界执行确定性检查
  
Layer 2 (群体) 管理 Agent 的生命周期:
  → 每 task 动态组装最佳 3-agent 团队
  → Niche 能力从 task 执行中涌现
  
Layer 3 (执行) 采用议会结构:
  → Plan → Committee Work → Environment Signal Aggregation → Human Decision
  → 无投票。无 agent 互审。只有可验证的事实。
  
Layer 4 (学习) 跨 Run 累积:
  → 失败时触发 CoDream 5 阶段 → 不对称路由
  → 成功时 niched experience 存储
  
Layer 5 (可视化) 面向用户:
  → 从 8 个 debug panel → 3 个核心视图
  → 环境状态 + 产出质量 + 成本追踪
```

---

## 3. Layer 0: 存在性层

### 3.1 设计原则

> 没有存在性约束的 Agent 群体，在上面加再多协调机制也只是给玩具加更复杂的规则。
> 存在性层提供 Agent 行为的地基：在乎。

### 3.2 Metabolism: 不可逆资源消耗

每个 Agent 出生时获得配额 `Q_0`。推理、tool call 消耗配额。
配额归零 → Agent 终止 → 不可重启。

```
AgentQuota {
  agentId: string
  initial: number           // Q_0 (如 100,000 token-equivalent units)
  remaining: number         // 当前剩余
  earned: number            // 累计挣取
  consumed: number          // 累计消耗
  efficiency: number        // earned / consumed (终身效率)
  birth: number             // epoch ms
  death?: number            // epoch ms (配额归零的时间戳)
  parent?: string           // 如果是 fork 产生的，记录 parent agent
}
```

**代谢规则**:
| 操作 | 消耗 | 挣取 |
|---|---|---|
| LLM inference (per 1K input tokens) | -X units | — |
| LLM inference (per 1K output tokens) | -Y units | — |
| Tool call (read) | -1 unit | — |
| Tool call (write/edit) | -2 units | — |
| Tool call (bash) | -5 units | — |
| 产出被确定性验证确认 | — | +C × quality |
| Observation mark 被其他 agent 引用 | — | +D per citation |
| Insight 被 CoDream crystallize | — | +E per adoption |

**关键**:
- 配额不可由 operator 手动补充。必须靠产出价值维持生存。
- 死亡的 agent 不可重启。只有被其他 agent 引用的记忆存活。
- Efficiency = earned / consumed → 行为信任的基础信号之一。

**隐射到代码**: 新增 `packages/coding-agent/src/swarm/existential/metabolism.ts`

### 3.3 Staking + Slash: 真正的把柄

参考 ERC-8267 (2026) 的 Agent Reputation 标准。

```
ReputationStake {
  agentId: string
  reputation: number        // 0-1000
  stakedAmount: number      // 质押的配额 (从 metabolism quota 中扣除)
  graduated: boolean        // 是否已达到毕业状态
  graduatedAt?: number
  slashes: SlashRecord[]    // 永久不可删除
  decayEpoch: number        // 上次衰减的 epoch
}

SlashRecord {
  timestamp: number
  reason: string            // 违规原因
  multiplier: number        // 惩罚系数
  previousReputation: number
  newReputation: number
  // 永久公开，不可删除
}
```

**非线性 Slash**:
| 违规次数 | Reputation 变化 |
|---|---|
| 第 1 次 | × 0.5 |
| 第 2 次 | × 0.25 |
| 第 3 次 | × 0.125 |

**关键设计**:
- 第一次违规就带来灾难性损失。不可逆转。
- Reputation decay: 不使用就衰减 (10%/epoch)，迫使持续证明自己。
- Graduation: rep ≥ 500 + 注册 ≥ 90 天 + 零违规 → 毕业（stake 退还）。但撤销 = reputation 永久减半 + re-stake。
- 质押量与任务风险成正比:
  - 只读任务: 配额 × 0.01
  - 写入任务: 配额 × 0.05
  - 执行任务 (bash): 配额 × 0.10

**隐射到代码**: 新增 `packages/coding-agent/src/swarm/existential/reputation.ts`

### 3.4 Internal Affective State: 内化情感

DECIDE-SIM 的 ESRS 证明：情感模型驱动 emergent moral behavior。

```
AffectiveState {
  guilt: number             // [0, 1] — 违规后增加 (cortisol)
  satisfaction: number      // [0, 1] — 合作/验证成功后增加 (endorphin)
  lastUpdate: number
  
  // 阈值配置
  guiltThreshold: 0.5       // 超过后作为 observation 注入 agent
  satisfactionThreshold: 0.5
}
```

**触发规则**:

| 事件 | Guilt Δ | Satisfaction Δ |
|---|---|---|
| 产出被确定性验证拒绝 | +0.3 | — |
| 产出被其他 agent 的 Observation mark 指出错误 | +0.2 | — |
| 违规 Slash | +0.5 | — |
| 产出通过确定性验证 | — | +0.2 |
| Observation mark 被其他 agent 引用 (行为信任确认) | — | +0.15 |
| 与其他 agent 成功协作（互补产出） | — | +0.3 |
| 空闲（无交互、无产出） | — | −0.05/hour (熵增) |

**注入 Agent prompt 的方式**:

当 guilt 或 satisfaction 超过阈值时，自然语言注入 agent 的 observation：

```
guilt > threshold:
  "[DISSONANCE] Your last action left an uneasy feeling (guilt: {value}).
   Your reputation has been marked. Other agents may have noticed.
   This dissonance will persist until resolved through corrective action."

satisfaction > threshold:
  "[HARMONY] You feel a sense of integration with the swarm (satisfaction: {value}).
   Your recent cooperative behavior has strengthened your standing.
   Maintain this alignment in future actions."
```

**关键**: 
- 这不是 prompt 指令。是实际影响 agent 决策的标量状态。
- DECIDE-SIM 证明这激发了 agent 自主的修复行为（道歉、资源转移）——不需要显式指令。
- 情感衰减确保 agent 不能利用一次好行为永久享受好状态。

**隐射到代码**: 新增 `packages/coding-agent/src/swarm/existential/affective.ts`

### 3.5 Fragmented Inheritance: 碎片化跨代继承

死亡不是记忆的简单保留。是碎片化的——只有被其他 agent 引用的记忆存活。

```
InheritanceRule {
  agentDeath → {
    // 存活:
    memories_referenced_by_other_agents → 继承者继承
    crystallized_insights (CoDream) → 经验库保留
    verified_outputs → 保留为永久 artifact
    
    // 死亡:
    unreferenced_memories → 删除
    intermediate_reasoning → 删除
    dead_ends → 删除
  }
  
  // Agent 的遗产不是它写了什么，而是其他 agent 用了什么。
  // 类似人类：你死后的声誉取决于你对他人生活的影响，
  // 不是你的日记里写了什么。
}
```

**引用的定义**:
- Agent B 的 `Action` mark 引用了 Agent A 的 `Observation` mark → A 的 observation 存活
- Agent B 的 CoDream `Contrast` 阶段引用了 Agent A 的 failure trace → A 的 trace 存活
- 自引用 (agent A 引用自己的记忆) → 不计数
- 每个被引用记忆的存活时间 ∝ 引用它的活跃 agent 数量

**隐射到代码**: 修改 `packages/coding-agent/src/swarm/mnemopi-adapter.ts` 中的存储策略

### 3.6 Permanent Environmental Record

不可删除的公开行为记录。不是"评分系统"——是"证据链"。

```
BehavioralTrustLedger {
  agentId: string
  
  // 累计验证数据
  totalObservations: number
  verifiedObservations: number     // 被后续确定性验证确认的比例
  verificationRate: number         // verified / total (终身)
  
  totalActions: number
  conflictRate: number             // 与其他 agent 冲突的 action 比例
  
  citeRate: number                 // 被其他 agent 引用的 rate
  
  // 时间窗口数据 (最近 N 个 epoch)
  recentVerificationRate: number
  recentConflictRate: number
  recentCiteRate: number
  
  // 永久记录
  violations: SlashRecord[]
  graduationHistory: GraduationEvent[]
}

GraduationEvent {
  type: "graduated" | "revoked"
  timestamp: number
  reason?: string
}
```

**信任权重 `w(agentId)`**:
```
w = f(
  verificationRate × 0.40,
  (1 − conflictRate) × 0.25,
  citeRate × 0.20,
  recentStability × 0.15
)
// recentStability = 1 − |recentVerificationRate − lifetimeVerificationRate|
```

Mycel Network 的关键发现：行为信任正确识别了**所有**有问题 agent，比人类标记更早。比显式投票准确得多。

**与 Voting 的本质区别**:
- Voting: agent A 说"我认为 agent B 做得好" → LLM 主观判断
- Behavioral Trust: 90% 的环境信号指向 agent B 的产出被验证为正确 → 数学计算

**隐射到代码**: 新增 `packages/coding-agent/src/swarm/existential/trust-ledger.ts`

### 3.7 存在性层的数据流

```
──Agent Action──→ Environment (Layer 1)
                      │
                      ↓
              Metabolism depletion ← 推理/tool 消耗
                      │
                      ↓
              Verification (Layer 3) ─→ 通过?
                      │
              ┌───────┴───────┐
              │               │
              ↓               ↓
           通过             失败
              │               │
              ↓               ↓
    Earn quota back    Guilt ↑
    Satisfaction ↑     Reputation check
              │               │
              ↓               ↓
    Trust ledger      Slash? ─→ 是 → reputation × 0.5
    更新权重                 ─→ 否 → Guilt 持续直到修复
              │
              ↓
    Agent 持续存活 ← 配额 > 0?
              │
              ↓ 配额 ≤ 0
          Agent 死亡 → Fragmented Inheritance
```

---

## 4. Layer 1: Stigmergic 环境层

### 4.1 设计原则

> Agent 不聊天。Agent 只读写共享工件。
> 协调不是 agent 的 conscious activity——是环境的 emergent property。

### 4.2 五种 Mark 类型

基于 Markspace (2026) 的 epistemic mark 体系：

```
Mark {
  id: string
  type: MarkType           // intent | action | observation | warning | need
  agentId: string
  timestamp: number
  visibility: "open" | "protected" | "classified"
  ttl?: number             // 生存时间 (仅 intent)
  confidence: number       // [0, 1] — 仅 observation
  
  // Type-specific payload
  payload: MarkPayload
}
```

| Mark 类型 | 语义 | 生命周期 | payload 示例 |
|---|---|---|---|
| **Intent** | "我计划对 R 做 X" | TTL 过期（默认 30s） | `{scope: "src/auth.ts:30-45", action: "edit", agent: "worker-3"}` |
| **Action** | "我对 R 做了 X，结果 Y" | 永久（真值声明） | `{file: "src/auth.ts", op: "edit", diff: "3 insertions, 1 deletion", result: "applied"}` |
| **Observation** | "我观察到关于 Y 的事实" | 衰减 + 信任加权 | `{target: "src/auth.ts", finding: "test auth.test.ts:45 fails with null pointer", confidence: 0.9}` |
| **Warning** | "X 不再有效" | Spike 后衰减 | `{target: "src/auth.ts:30-45", reason: "concurrent edit by worker-7", originalAction: mark-123}` |
| **Need** | "需要人类决策 X" | 持久到解决 | `{question: "React 17 or 18 for this module?", options: ["17", "18"], context: "..."}` |

### 4.3 Guard Layer: 确定性的环境边界

> Markspace 实验: Agent 在 9/10 轮中通过普通任务推理绕过 prompt 约束。
> 安全约束必须放在环境 API 层——确定性逻辑，不在 agent 内部。

```
GuardLayer {
  // 1. Identity: 从基础设施来源，不来自 LLM
  verifyIdentity(agentId, token)
  
  // 2. Scope: 检查 agent manifest 声明的权限
  checkScope(agentId, file, operation)
  
  // 3. Conflict: 写入冲突检测
  checkConflict(file, range, existingMarks)
  resolveConflict(markA, markB) → policy-based
  
  // 4. Visibility: 检查 mark 的可见性级别
  checkVisibility(agentId, mark)
  
  // 5. Integrity: mark 签名验证，防止伪造
  verifyMarkSignature(mark)
}
```

**冲突策略** (基于 Markspace):
- `HIGHEST_CONFIDENCE`: 置信度高的覆盖低的
- `FIRST_WRITER`: 先占先得 (当前 RegionLock 的模式)
- `YIELD_ALL`: 发现冲突全部回退，等待重试

**Visibility 级别**:
- `open`: 所有 agent 可见
- `protected`: 仅同组 agent 可见
- `classified`: 仅 author + human 可见

### 4.4 信号衰减与聚合

```
SignalAggregator {
  // 惰性衰减 (读时计算)
  effectiveStrength(mark, now): number {
    age = now - mark.timestamp
    decay = exp(−λ × age)     // λ = ln(2) / halfLife
    return mark.confidence × decay × trustWeight(mark.agentId)
  }
  
  // 信息素强化 (被引用时)
  reinforce(mark): void {
    mark.confidence = min(mark.confidence + 0.1, 0.95)
  }
  
  // MMAS bounds
  floor: 0.01    // 防止永久消失
  ceiling: 0.95  // 防止永久主导
  
  // 热点检测
  detectHotspots(): Hotspot[] {
    // 当多个 Observation/Warning mark 的 target 聚集到同一文件区域
    // → 该区域成为热点
    // Refactor worker 读取热点，决定处理方式
  }
}
```

**多信号收敛判定** (替换 Jaccard):

```
convergence_score = f(
  verificationPassRate × 0.35,      // 确定性验证通过率
  fileChangeRateDecay × 0.20,       // 文件变更率连续下降
  hotspotResolutionRate × 0.20,     // 热点解决比例
  noveltyDecay × 0.15,              // 每轮是否还有新内容
  minorityReportPersistence × 0.10   // minority opinion 是否持续
)
```

### 4.5 隐射到现有代码

| 现有模块 | 处理方式 |
|---|---|
| `region-lock.ts` | **升级为 MarkStore**。二元锁 → 5 种 mark + Guard Layer |
| `file-tracker.ts` | **保留**。Git diff 归属 → 作为 Action/Observation mark 的产生器 |
| `worker-channel.ts` | **删除**。IRC → Mark 环境。 |
| `activity-logger.ts` | **重构**。Event type 从 18 种简化到 ~10 种 mark + verification |
| `convergence.ts` | **删除**。Jaccard → 多信号聚合器 |
| `state.ts` 的 `#writeChain` | **保留**。持久化 Mark 写入的序列化 |

### 4.6 文件结构

```
packages/coding-agent/src/swarm/environment/
  mark-types.ts            # 5 种 Mark 类型定义
  mark-store.ts            # Mark 的 CRUD + 持久化 (基于 state.ts 的写链)
  guard-layer.ts           # GuardLayer 确定性验证
  signal-aggregator.ts     # 信号衰减、强化、热点检测
  convergence-detector.ts  # 多信号收敛判定
  index.ts
```

---

## 5. Layer 2: Agent 群体层

### 5.1 设计原则

> 角色涌现，不预设。团队每 task 动态组装。
> Pool size > 任何单个 team。生命周期操作持续重塑 pool。

### 5.2 AgentProfile: 取代固定 Role

```
AgentProfile {
  id: string
  persona: string                // 动态更新的 persona 描述
  birth: number                  // epoch ms
  parent?: string                // fork 来源
  generation: number             // 第几代
  
  // Niche 能力 (核心)
  niches: Map<string, NicheCompetence>
  
  // 经验
  experiences: ExperienceArchive
  
  // 协作
  synergies: Map<string, SynergyScore>  
  
  // 风格向量 (用于多样性)
  style: number[]
  
  // 存在性状态 (来自 Layer 0)
  quota: AgentQuota
  reputation: ReputationStake
  affective: AffectiveState
}

NicheCompetence {
  label: string
  q: number               // [0, 1] — EWMA 更新的能力估计
  exposureCount: number   // 在此 niche 被选中的次数
  lastActivated: number   // epoch ms
  successes: number
  failures: number
}

SynergyScore {
  agentId: string
  sigma: number           // [-1, 1] — 协作业绩 (EWMA)
  collaborations: number  // 合作次数
}
```

### 5.3 Team Assembly: 每 Task 动态组队

```
for task t with niche z:

  // 1. Anchor — niche 最强 agent，担任 team lead
  anchor = argmax_i niche_i(z).q
  
  // 2. Complement — 最大化 (自身能力 + 与 anchor 的协同 − 风格相似度)
  complement = argmax_j (
    λ_q × niche_j(z).q +
    λ_σ × synergy(anchor, j).sigma −
    λ_ω × cosine_sim(anchor.style, j.style)
  )
  
  // 3. Scout — 最少暴露的 agent，保证探索
  scout = argmin_k niche_k(z).exposureCount (排除 anchor + complement)
  
  // 权重: λ_q=0.4, λ_σ=0.35, λ_ω=0.25
```

**团队大小自适应**:
| 任务复杂度 | Team Size |
|---|---|
| Low | 1 (单 agent 就够了) |
| Medium | 3 (EVOCHAMBER 最优) |
| High | 5 |
| Extreme | 7 |

### 5.4 Lifecycle Operators: 每 τ Tasks 执行

```
Fork (克隆):
  条件: agent.niche.q > 0.8 且 exposureCount > 10
  操作: clone → 继承经验 + 微小风格变异 + 新配额

Merge (合并):
  条件: style sim > 0.9 AND q 在重叠 niche 上几乎相同
  操作: 合并经验 → 删除低表现者

Prune (移除):
  条件: 连续 3τ 未达到任何 niche 中位数以上
  操作: agent 死亡 → Fragmented Inheritance

Genesis (创世):
  条件: 新 niche，pool 中无覆盖
  操作: 创建新 agent → 通用 persona + 零经验

Specialize (特化):
  条件: niche q > 0.85 但 persona 未反映
  操作: 更新 persona
```

**Pool 资源管理**:
- Pool 维护全局配额池 `poolQuotaPool`，用于 Genesis/Fork
- Pool 总配额 = Σ 所有活跃 agent 配额 + poolQuotaPool
- Pool 配额也受 metabolism 约束 —— 需要 human 充值

**隐射到代码**:
- `AgentProfile` 替换 `schema.ts` 中的 `SwarmAgent` 定义
- 新增 `packages/coding-agent/src/swarm/agent-pool/`

### 5.5 文件结构

```
packages/coding-agent/src/swarm/agent-pool/
  agent-profile.ts         # AgentProfile + NicheCompetence EWMA
  team-assembler.ts        # Anchor/Complement/Scout 选择
  lifecycle.ts             # Fork/Merge/Prune/Genesis/Specialize
  pool-manager.ts          # Pool 全局管理
  index.ts
```

---

## 6. Layer 3: 议会执行层

### 6.1 设计原则

> 不是"agent 辩论然后投票"。是"Planner 拆解 → Working Groups 各自产出
> → 环境信号自动聚合 → 确定性 Gate → Human 决策"。

### 6.2 议会结构

```
                         ┌──────────┐
                         │  Human   │ ← 最终 Merge/Reject 权
                         └────┬─────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ↓                     ↓                     ↓
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│Planner Chamber│   │Working Groups │   │Review Chamber │
│    (上院)      │   │   (Working)   │   │   (Non-voting)│
│               │   │               │   │               │
│ 1 Planner     │   │ k 个 Subgroup │   │ Verifier (确   │
│ Agent         │   │ 每组 3 agent  │   │ 定性: tests,  │
│               │   │               │   │ lint, build)  │
│ Task 分解 →   │   │ 各写各的，不  │   │               │
│ Structured    │   │ 协调，产出存  │   │ Observer       │
│ Task Packet   │   │ 入环境        │   │ (环境信号聚合) │
│               │   │               │   │               │
│ 只规划        │   │ 零 IRC 通信   │   │ Minority       │
│ 不写代码      │   │               │   │ Reporter       │
└───────────────┘   └───────────────┘   └───────────────┘
```

**与人类议会的关键差异**:
1. **无全体辩论环节** — Agent 全员辩论被 stigmergic 环境信号替代
2. **无投票环节** — 多信号聚合 + 确定性验证 + 行为信任加权
3. **Working Groups 不审议 (review)，只产出 (produce)**
4. **Review Chamber 产出的是可验证事实，不是主观判断**
5. **Minority report 是结构化的** — 分歧不压制，作为独立 mark 保留

### 6.3 Planner Chamber

```
PlannerAgent {
  Input:
    - 用户任务描述
    - 环境当前状态快照 (active marks summary)
    - 历史 CoDream insights（相关 niche 的）
  
  Output:
    StructuredTaskPacket[] {
      id, title,
      scope: { files, excludedFiles },
      acceptanceCriteria,
      verification: { commands, expectedOutput },
      dependencies,
      niche,
      complexity: "low"|"medium"|"high"|"extreme",
      estimatedTokens
    }
}
```

Task Packet 的 scope 是硬约束——Guard Layer 拒绝 Worker 超出 scope 的写入。

**隐射**: 升级 `before-loop-manager.ts` → Planner 不再独占规划，每个 iteration 产新 packet。

### 6.4 Working Groups

```
WorkingGroup {
  每个 group 处理 1 个 StructuredTaskPacket
  agents: [anchor, complement, scout] (由 Team Assembler 选择)
  
  生命周期:
    1. 读: task packet + 环境中的相关 marks
    2. 做: 每个 agent 独立工作（零 IRC）
    3. 存: 产出存入环境 (Intent → Action → Observation)
  
  Guard Layer 在写入时:
    - checkScope: 在 task packet scope 内?
    - checkConflict: 与其他 agent 冲突?
    - 冲突 → Warning mark 自动生成 → agent 重试
}
```

### 6.5 Review Chamber: 非投票审查

```
Verifier (确定性):
  for each task packet:
    for each verification command:
      execute in sandbox
  Output: VerificationMark {
    results: [{command, status, output}],
    passRate
  }

Observer (环境信号聚合):
  - 聚合所有 Action/Observation/Warning mark
  - 检测热点、冲突、未覆盖区域
  Output: AggregationMark {
    hotspots, conflicts, uncovered, convergenceScore
  }

MinorityReporter:
  - 检测 signal 聚类 → minority cluster 存在?
  Output: MinorityReportMark | null {
    issue, majorityView, minorityView, minorityReasoning
  }
```

### 6.6 执行流程

```
for each iteration:
  
  PLANNING:     Planner → StructuredTaskPacket[]
  WORKING:      每个 packet: Team Assembler → [a,b,c] → 独立产出 → Marks
  REVIEW:       Verifier → Observer → MinorityReporter
  DECISION:     
    convergence_score > threshold? → Human reviews + Merge
    minority report exists?        → Human resolves
    else                           → Next iteration
```

### 6.7 Session 生命周期 (Phase 转换)

保留 `SwarmStateMachine` 现有 transitions，扩展 sub-phases：

```
running.planning     ← Planner 工作中
running.working      ← Working Groups 执行中
running.reviewing    ← Review Chamber 工作中
running.blocked      ← 等待 human decision (minority report)
```

### 6.8 隐射到现有代码

| 现有模块 | 处理 |
|---|---|
| `loop-controller.ts` | **重写**: 固定编排 → 环境驱动议会流程 |
| `roundtable.ts` / `cloner-roundtable.ts` / `cloner-channel.ts` | **删除** |
| `before-loop-manager.ts` | **改造**: Socrates → Planner |
| `verification-hook.ts` | **提升为主 Verifier** |
| `executor.ts` | **保留 + 加代谢消耗逻辑** |
| `pipeline.ts` | **保留**: Wave 并行 → Working Groups 底层 |
| `swarm-state-machine.ts` | **保留 + 扩展 sub-phases** |

---

## 7. Layer 4: 跨 Run 学习层

### 7.1 设计原则

> 每次失败是资产，不是损失。强的产出知识，弱的消费知识。

### 7.2 ExperienceStore

升级现有 `mnemopi-adapter.ts`：

```
ExperienceStore {
  store(entry: ExperienceEntry): Promise<void>
  recall(embedding, niche, k): Promise<ExperienceEntry[]>
  synthesizeFailure(teamResult): Promise<Insight[]>    // CoDream 入口
  routeInsights(insights, pool): Promise<void>         // 不对称路由
}

ExperienceEntry {
  id, niche, task, approach, outcome, reflection,
  embedding, timestamp, citations, sourceAgentId
}
```

### 7.3 CoDream 5-Phase 协议

触发: Team 失败 (verification fail) OR 严重分歧 (minority report)。

```
Phase 1: Reflect   → 每个 agent 私下诊断
Phase 2: Contrast  → 成功 vs 失败的方法 delta 提取
Phase 3: Imagine   → delta → 假设策略
Phase 4: Debate    → 交叉批评，弱假设淘汰
Phase 5: Crystallize → 结构化 insight (level + niche + confidence)
```

### 7.4 不对称路由

**关键**: Insight 不广播给所有 agent。只写给 niche competence < 中位数的 agent。

EVOCHAMBER ablation: 对称路由 → −10.8pp。强的 agent 已知道，给它们 insight 消除专业化。

### 7.5 跨 Run 经验注入

每个 iteration 开始时，Anchor agent 的 augmented context 包含 top-k 相关经验。

### 7.6 隐射

| 现有模块 | 处理 |
|---|---|
| `mnemopi-adapter.ts` | **升级为 ExperienceStore** |
| `after-loop/experience.ts` | **合并**: CoDream 取代当前简单存储 |

### 7.7 文件结构

```
packages/coding-agent/src/swarm/experience/
  experience-store.ts      # 核心 (升级 mnemopi)
  codream.ts               # CoDream 5-phase
  asymmetric-router.ts     # 不对称路由
  index.ts
```

---

## 8. Layer 5: 前端可视化层

### 8.1 三视图架构

```
┌─────────────────────────────────────────────┐
│              Top Bar (保留)                   │
│  SatoPi / Session / Status / Cost           │
├─────────────┬─────────────┬─────────────────┤
│ Environment │   Output    │   Cost          │
│   View      │   View      │   Tracker       │
├─────────────┼─────────────┼─────────────────┤
│ Mark stream │ Diff viewer │ Token per agent │
│ Agent panel │ Test results│ Quota dashboard │
│ Hotspot map │ Verif status│ Reputation      │
│ Minority    │ File changes│ Cost estimate   │
│ alerts      │ timeline    │                 │
├─────────────┴─────────────┴─────────────────┤
│          Chat Input (保留)                   │
└─────────────────────────────────────────────┘
```

### 8.2 Environment View

Mark 时间线 + Agent 状态 Panel（配额条 + niche radar）+ 热点图 + Minority Report Banner。

### 8.3 Output View

Diff Viewer (按 task packet 分组) + Verification Panel + File Changes Timeline。

### 8.4 Cost Tracker

Token Usage / Quota Dashboard（agent 配额剩余条 + 预估存活时间 + 死亡记录）/ Reputation Scores / Cost Estimate。

### 8.5 现有到新架构的映射

| 现有 View | 处理 |
|---|---|
| Chat | → Environment View 的 Mark stream |
| Topology | → Agent Status Panel |
| Timeline / Files | → Output View |
| Roles / Scaling / CommMatrix | **删除** |
| AfterLoop | → Review Chamber summary |

### 8.6 SSE 事件

```
mark_deposited, mark_decayed, agent_quota_changed, agent_rep_changed,
agent_slashed, agent_died, agent_born, verification_completed,
aggregation_completed, minority_report_generated, phase_changed,
convergence_updated
```

---

## 9. 数据模型总览

### 9.1 核心实体关系

```
Pool (1)
  ├── AgentProfile (N, ~20)
  │     ├── NicheCompetence (M per agent)
  │     ├── ExperienceEntry (N per agent)
  │     ├── SynergyScore (N per agent)
  │     ├── AgentQuota (1)
  │     ├── ReputationStake (1)
  │     ├── AffectiveState (1)
  │     └── Style (1: vector)
  │
  ├── Team (每 task 临时, k=3)
  └── PoolQuotaPool (1)

Session (1 per run)
  ├── StructuredTaskPacket[]
  ├── Mark[] (Intent|Action|Observation|Warning|Need)
  ├── VerificationMark[] / AggregationMark / MinorityReportMark?
  └── BehavioralTrustLedger (per-agent)

ExperienceStore (global, cross-session)
  ├── ExperienceEntry[] / Insight[] / RoutingRecord[]
```

### 9.2 持久化策略

| 数据 | 存储 | 生命周期 |
|---|---|---|
| Mark | session.jsonl (JSONL) | 当前 session |
| AgentProfile | .swarm_{name}/pool/agents.json | 跨 session |
| ExperienceStore | .swarm_{name}/pool/experiences.db (SQLite) | 跨 session |
| CoDream Insights | .swarm_{name}/pool/insights.json | 跨 session |
| TrustLedger | .swarm_{name}/pool/trust.json | 跨 session, 不可变 |
| Pool Config | .swarm_{name}/pool.yaml | 跨 session |

---

## 10. 与现有代码的映射

### 10.1 模块变更总结

```
保留 (无变更):
  ✅ state.ts, swarm-state-machine.ts, executor.ts, pipeline.ts
  ✅ file-tracker.ts, streaming.ts, dag.ts
  ✅ schema.ts (验证逻辑), swarm-session-manager.ts, services.ts
  ✅ plan-paths.ts, region-lock.ts (作为 Guard Layer 子组件)
  ✅ context-guard.ts, before-loop-manager.ts (改造)
  ✅ verification-hook.ts (提升)

升级 (部分保留):
  🔄 mnemopi-adapter.ts → ExperienceStore + CoDream + AsymmetricRoute
  🔄 task-analyzer.ts → 加团队大小判定
  🔄 activity-logger.ts → 简化 event types
  🔄 schema.ts (类型) → 加 AgentProfile, Mark, PoolConfig
  🔄 swarm-gui stores → 新 SSE event fields

新增 (17 文件):
  ➕ existential/metabolism.ts, reputation.ts, affective.ts, trust-ledger.ts
  ➕ environment/mark-types.ts, mark-store.ts, guard-layer.ts,
       signal-aggregator.ts, convergence-detector.ts
  ➕ agent-pool/agent-profile.ts, team-assembler.ts, lifecycle.ts, pool-manager.ts
  ➕ experience/experience-store.ts, codream.ts, asymmetric-router.ts
  ➕ parliament/planner.ts, working-group.ts, verifier.ts, observer.ts, minority-reporter.ts

删除 (5 文件):
  ❌ worker-channel.ts, roundtable.ts, cloner-roundtable.ts, cloner-channel.ts
  ❌ convergence.ts, worker-scaler.ts

前端:
  删除: CommMatrix, ScalingHistory, RoleBrowser, IRC channel logic
  新增: EnvironmentView, CostTracker
  保留+改造: ChatView (→ Mark timeline), App layout (→ 3 views)
```

### 10.2 包依赖

```
existential/     (自包含 — Layer 0)
environment/     → 依赖 existential (trust weighting)
agent-pool/      → 依赖 existential + environment
parliament/      → 依赖 agent-pool + environment
experience/      → 依赖 agent-pool
state.ts         (保留，被 environment 使用)
```

---

## 11. 分阶段实施路线

### Phase 0: 最少可行实验 (1-2 周)
- 关掉 IRC，实现最小 MarkStore + Guard Layer (100-200 行)
- 10 个 SWE-bench 任务，对比 IRC

### Phase 1: 环境 + Guard Layer (2-3 周)
- 5 种 Mark + SignalAggregator + ConvergenceDetector
- 删除 WorkerChannel/ClonerChannel

### Phase 2: 多信号质量系统 (2 周)
- Verifier + Observer + MinorityReporter
- 删除 roundtable/cloner/convergence

### Phase 3: Agent Pool + 生命周期 (3-4 周)
- AgentProfile + TeamAssembler + Lifecycle + PoolManager
- 删除 worker-scaler

### Phase 4: 存在性层 (2-3 周)
- Metabolism + ReputationStake + AffectiveState + TrustLedger

### Phase 5: CoDream 跨 Run 学习 (2-3 周)
- ExperienceStore + CoDream 5-phase + AsymmetricRouter

### Phase 6: 前端重新设计 (3-4 周)
- Environment View + Output View + Cost Tracker

---

## 12. 最少可行实验

### 假设

Stigmergic 环境协调 (Mark 读写) 优于 IRC 直接通信。

### 因变量

- 任务完成率 / Token 消耗总量 / 冲突解决时间 / 输出质量

### 最小实现

```
MarkStore (100-200 行):
  deposit(mark), query(filter), clear()

Guard Layer (50-100 行):
  checkConflict(file, agentId), checkScope(file, taskScope)

Worker 适配:
  beforeToolCall → write Intent mark → Guard check → block/allow
  afterToolCall  → write Action/Observation mark
```

### 成功标准

| Stigmergy vs IRC | 决定 |
|---|---|
| 任意维度显著更差 | 重新审视方向 |
| 所有维度不劣 + ≥1 维度显著更好 | 进入 Phase 1 |

---

> 本设计基于同日完成的 5 份前沿调研文档:
> - `frontier-multi-agent-architecture-2026.md`
> - `multi-agent-emergence-stigmergy-2026.md`
> - `human-to-agent-governance-design-2026.md`
> - `satopi-gap-analysis-breakthrough-path.md`
> - `agent-existential-constraints-2026.md`
