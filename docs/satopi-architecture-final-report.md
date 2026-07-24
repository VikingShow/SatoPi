# SatoPi 架构全景 × 最终架构设计

> 日期: 2026-07-23
> 基于: 完整代码审计 (38 backend + 20 frontend + 16 test files)
> 不含中期过渡，直接到最终架构

---

## 目录

1. [当前架构 (代码实际状态)](#1-当前架构)
2. [决策点清单](#2-决策点)
3. [最终目标架构](#3-最终目标架构)
4. [各层实施片段](#4-各层实施规划)

---

## 1. 当前架构

### 1.1 后端模块关系 (从代码提取)

```
standalone.ts (入口)
  ├── ModelRegistry + Settings (来自 omp)
  ├── SessionRegistry
  │     └── per-session: StateTracker + ActivityLogger + SwarmSessionManager
  │                      + RunManager (LoopController 封装) + BeforeLoopManager
  └── MonitorServer (Bun.serve)
        ├── api-routes.ts — 30+ REST 端点
        ├── event-bus.ts — SSE per-session ring buffer (1000) + Last-Event-ID replay
        └── metrics.ts — Prometheus

SessionRegistry (session-registry.ts)
  └── createSession(name) → SessionServices {
        stateTracker: StateTracker
        activityLogger: ActivityLogger
        sessionManager: SwarmSessionManager
        runManager: { start(), stop(), pause(), resume(), resolveBlocker() }
        beforeLoopManager: BeforeLoopManager
        steeringSink: { steer() }
      }

LoopController (loop-controller.ts, 67KB)
  ├── extends PipelineController (pipeline.ts)
  ├── 依赖: WorkerChannel (IRC), ClonerCouncil (roundtable.ts), FileTracker,
  │         RegionLockManager, TodoTracker, VerificationHook, WorkerScaler
  ├── ConvergenceDetector (convergence.ts — Jaccard)
  └── BlockageEvaluator (blockage.ts — stagnation/deadlock)

ActivityLogger (activity-logger.ts)
  └── 17 event types: broadcast, subgroup, steering, phase, verdict, conflict,
       scaling, nomination, crash, stream_start/delta/end, deliberation_*,
       cloner_individual, file_coordination, agent_state, pipeline_state,
       tool_call, error_flag, file_change

PipelineController (pipeline.ts, 409 行)
  └── run() → for (iteration) → for (wave) → Promise.all(agent in wave)
      └── PipelineContext: { waves: WaveResult[], totalTokens, totalRequests }
      └── PipelineHooks: beforePipeline, afterPipeline, beforeIteration, etc.

SwarmStateMachine (swarm-state-machine.ts)
  └── 8 LOOP_PHASES, LOOP_TRANSITIONS table, scheduleTimed(), force()
```

### 1.2 前端模块关系 (从代码提取)

```
App.tsx
  ├── MonitorPage.tsx (8 view modes)
  │     ├── ChannelList (roundtable / subgroup / steering / deliberation / cloner / file)
  │     ├── ChatView (virtualized SSE message stream + streaming bubbles)
  │     ├── ContextPanel (Agents / Tasks / Plan tabs)
  │     ├── PhasePipeline (6-step pipeline: Plan→Refine→Work→Review→Blocked→Summary)
  │     ├── AgentTopology (React Flow + dagre)
  │     ├── AgentTimeline (tool call swimlanes)
  │     ├── FileChangesPanel
  │     ├── RoleBrowser (36KB — largest)
  │     ├── ScalingHistory
  │     ├── CommMatrix (heatmap)
  │     ├── AfterLoopPanel (collapsible stats + lessons)
  │     └── BlockerDialog (auto-continue countdown)
  ├── ConfigPage.tsx (Lazy)
  ├── HistoryPage.tsx (Lazy)
  └── SessionSwitcher.tsx

swarm-store.ts (53KB, Zustand)
  ├── State: swarmState, activities, channels, messages, activeChannelId,
  │          isConnected, connectionStatus, isRunning, loopPhase,
  │          beforeLoopState, todos, afterLoopResult, blockerContext,
  │          convergenceHistory, toolCalls, fileChanges
  ├── Actions: init, addActivity, refreshState, startRun, stopRun,
  │            pauseRun, resumeRun, sendSteering, resolveBlocker,
  │            switchToSession, startPlanning, confirmAndStart...
  └── SSE: on stream_start/delta/end → streaming bubbles
            on phase → AUTHORITATIVE_LOOP_PHASES adoption
            on agent_state/pipeline_state → real-time patch
            on convergence → convergenceHistory (max 20)
            on tool_call/file_change/error_flag → tracks

session-store.ts (6.6KB)
  └── activeSwarm, viewingSession, runs[]
  └── newSession() → create + switchToSession + deleteSession

config-store.ts (8.4KB)
  └── YAML ↔ Form serialization: parseYamlToForm + buildYaml
  └── Fields: workers, cloners, convergence, scaling, loop

channel-derivation.ts (4.9KB)
  └── deriveChannel(entry) → { channel, message }
  └── 7 channel types: roundtable, subgroup-*, steering-*, deliberation-r*,
       cloner-*, file-*, tool_call→roundtable
```

### 1.3 数据流 (代码实际路径)

```
Backend:
  loop-controller.ts:
    1. dispatch workers via executor.ts (runSubprocess)
    2. worker output → streaming.ts → ActivityLogger → SSE
    3. after round: worker output → FileTracker (git diff analysis)
    4. ClonerCouncil.review() → verdict → ActivityLogger.logVerdict
    5. ConvergenceDetector → jaccardSimilarity → ActivityLogger.logConvergence
    6. WorkerScaler.computeScaleDelta → ActivityLogger.logScaling
    7. BlockageEvaluator.evaluateBlockage → loop blocks

Frontend:
  swarm-store.ts:
    1. SSE events → addActivity() → deriveChannel() → channels, messages
    2. stream_start → create streaming bubble message
    3. stream_delta → RAF-coalesced batched append to bubble body
    4. stream_end → finalize bubble + attach thinking
    5. REST polling (5s) → refreshState() / refreshBeforeLoopState()
    6. User actions → api-client POST → backend → SSE broadcast back
```

---

## 2. 决策点

以下每个决策点是架构设计的分叉路口。每个决策有明确选项和理由。

### DP-1: 协调范式的根本选择

| 选项 | 描述 |
|---|---|
| A: IRC 直接通信 | 保留 WorkerChannel。Rodriguez 32:1 证伪。 |
| **B: Stigmergic 环境** | **Agent 不对话，只读写共享 Mark 环境。** |
| C: 混合 | 加复杂度而无法解决根本问题 |

**决策: B。** 32:1 的差距不是微调能弥补的。

---

### DP-2: 质量判定的主体

| 选项 | 描述 |
|---|---|
| A: Agent 审 Agent (Cloner 投票) | Superminds 证伪。Sovereignty Gap。 |
| **B: 确定性验证 + 环境信号 + 行为信任** | **Agent 产生可验证事实，不用主观判断。** |
| C: Human 审所有 | 不 scale |

**决策: B。** 行为信任从事实计算，不从投票产生。

---

### DP-3: 角色分配的来源

| 选项 | 描述 |
|---|---|
| A: YAML 预设 | EVOCHAMBER 证伪。 |
| **B: Task-driven 动态组队** | **每 task 选 Anchor/Complement/Scout，niche 从 task 执行中涌现。** |
| C: 单 Agent | 放弃 multi-agent 优势 |

**决策: B。** 预设角色消除自然分化。

---

### DP-4: 收敛判定

| 选项 | 描述 |
|---|---|
| A: Jaccard | Coupling Gain 证伪。 |
| **B: 多信号聚合** | **verification + file_change_decay + hotspot + novelty + minority。** |

**决策: B。** Jaccard 量的是"输出变相似"，不是"输出变正确"。

---

### DP-5: 存在性约束的深度

| 选项 | 描述 |
|---|---|
| A: 无约束 | Agent 不在乎任何事。 |
| **B: 有限配额 + 不可逆 Slash + 内化情感 + 碎片化继承** | **DECIDE-SIM: +1000% 合作。** |
| C: 可人为充值 | 弱化生存压力 |

**决策: B。** 没有存在性约束的集体智能是空中楼阁。

---

### DP-6: 记忆跨代连续性

| 选项 | 描述 |
|---|---|
| A: 完整保留 | 死亡没有代价。 |
| **B: 碎片化继承** | **只有被其他 agent 引用的记忆在 agent 死后存活。** |
| C: 完全清空 | 失去跨 run 学习 |

**决策: B。** Agent 死后声誉取决于被其他 agent 记住了什么。

---

### DP-7: 安全约束位置

| 选项 | 描述 |
|---|---|
| A: Prompt 层 | Markspace: agent 9/10 轮绕过。 |
| **B: 环境 API 层 Guard** | **确定性身份/scope/conflict 检查。** |

**决策: B。** Guard 必须是 agent 外部不可绕过的确定性逻辑。

---

### DP-8: 通信结构

| 选项 | 描述 |
|---|---|
| A: 自由文本 IRC | 高延迟，47.5pp channel framing gap。 |
| **B: 结构化 Mark 类型** | **Intent/Action/Observation/Warning/Need — 确定性解析。** |

**决策: B。** Mark schema 限制了 sycophancy 的攻击面。

---

### DP-9: 规划权

| 选项 | 描述 |
|---|---|
| A: 单一 Planner 独占 | 规划质量 = 单 agent 上限。 |
| **B: Planner + 环境反馈闭环** | **Worker Observation → Planner 修正。迭代闭环。** |

**决策: B。** 单一 Planner (最强模型) 是对的，但规划是迭代的。

---

### DP-10: CoDream

| 选项 | 描述 |
|---|---|
| A: 无跨 run 学习 | 失去累积。 |
| **B: Run 内轻量 + Run 后深度** | **Run 内: brief reflect (不增延迟)。Run 后: 完整 CoDream 5-phase。** |

**决策: B。** EVOCHAMBER −10.8pp if CoDream removed。

---

### DP-11: 前端信息架构

| 选项 | 描述 |
|---|---|
| A: 8 个 view mode | 大多为 debug panels。 |
| **B: 3 个核心视图** | **Environment / Output / Cost。** |

**决策: B。** 用户关心三件事: 进展 + 质量 + 成本。

---

## 3. 最终目标架构

### 3.1 五层全景

```
Layer 5: 前端 (Environment View / Output View / Cost Tracker)
Layer 4: 跨 Run 学习 (CoDream + Asymmetric Route + ExperienceStore)
Layer 3: 议会执行 (Planner → Working Groups → Verifier + Observer + Minority)
Layer 2: Agent 群体 (TeamAssembly per task + Lifecycle per τ epochs)
Layer 1: Stigmergic 环境 (MarkStore + GuardLayer + SignalAggregator + ConvergenceDetector)
Layer 0: 存在性 (Metabolism + Reputation + Affective + TrustLedger + Inheritance)
```

### 3.2 执行流程

```
Task Input
    │
    ▼
Planner Chamber (最强模型, 单 Agent)
    │ 产出: StructuredTaskPacket[] (scope, acceptanceCriteria, verification, niche, complexity)
    ▼
Team Assembler (per packet)
    │ Anchor(argmax niche_q) + Complement(max q+synergy−style_sim) + Scout(min exposure)
    ▼
Working Groups (parallel, per packet)
    │ 3 agents per group, 零直接通信
    │ 产出: Intent → Action → Observation marks → Environment
    ▼
Review Chamber
    ├── Verifier: bun test / tsc / Playwright → VerificationMark
    ├── Observer: 环境信号聚合 → AggregationMark + convergence_score
    └── MinorityReporter: signal 分歧检测 → MinorityReportMark | null
    ▼
Decision
    ├── convergence ≥ threshold → Human merges
    ├── minority report → Human resolves → next iteration
    └── else → next iteration
```

### 3.3 Agent 存在性生命周期

```
Genesis/Fork → Q₀ 配额, reputation=100, guilt=0
    │
Active → 每次 task: consume quota, earn on verification pass
    │            guilt/satisfaction 根据事件更新
    │
配额 → 0?  YES: DEATH (引用记忆存活, 其余删除, 不可重启)
     │
     NO
     │
Prune? YES: DEATH (连续 3τ < 中位数)
```

---

## 4. 各层实施规划

### 4.1 Layer 0: 存在性层

#### 4.1.1 `existential/metabolism.ts`

核心类型: AgentQuota { agentId, initial, remaining, earned, consumed, efficiency, birth, death?, parent? }

消耗率表 (可配置):
```
"inference:input": -1/1K tokens, "inference:output": -3/1K tokens
"tool:bash": -5, "tool:write": -2, "tool:edit": -2, "tool:read": -1
"verification:pass": +50 (主要挣取来源)
"observation:cited": +20, "insight:crystallized": +30
```

出口: MetabolismTracker { birth(), consume(), earn(), getQuota(), isAlive(), onDeath callback }

#### 4.1.2 `existential/reputation.ts`

核心类型: ReputationStake { reputation: 0-1000, stakedAmount, graduated, slashes: SlashRecord[](永久) }

Slash 乘数: [0.5, 0.25, 0.125] (非线性——第一次就是灾难性的)

出口: ReputationRegistry { register(), slash()→SlashRecord, decay(), graduate(), getSlashes() }

#### 4.1.3 `existential/affective.ts`

核心类型: AffectiveState { guilt: 0-1, satisfaction: 0-1 }

触发表: verification_failed→guilt+0.3, verification_passed→satisfaction+0.2, slashed→guilt+0.5, collaboration_success→satisfaction+0.3, idle_hour→satisfaction−0.05

出口: AffectiveRegister { applyTrigger(), buildInjection()→string|null }

#### 4.1.4 `existential/trust-ledger.ts`

核心类型: BehavioralTrustLedger { verificationRate, conflictRate, citeRate, recentWindow }

信任权重: w = verificationRate×0.40 + (1−conflictRate)×0.25 + citeRate×0.20 + recentStability×0.15

出口: TrustLedgerStore { recordObservation(), recordAction(), recordCitation(), getTrustWeight()→0-1 }

---

### 4.2 Layer 1: 环境层

#### 4.2.1 `environment/mark-types.ts`

Mark = { id, type: intent|action|observation|warning|need, agentId, timestamp, visibility: open|protected|classified, ttl?, confidence: 0-1, payload, references[], citedBy[] }

Mark 生命周期: Intent→Action 消费, Action 永存, Observation→decay→被引用 reinforce, Warning→spike→decay, Need→persist 到 resolved

#### 4.2.2 `environment/mark-store.ts`

出口: MarkStore { deposit(mark)→persist+SSE, query(filter)→Mark[], getEffectiveStrength(mark)→0-1, reinforce(markId) }

复用 state.ts 的写链模式 (序列化写入, microtask coalescing)

#### 4.2.3 `environment/guard-layer.ts`

出口: GuardLayer { checkIdentity(), checkScope(), checkConflict(), checkVisibility() }

冲突策略: first_writer | highest_confidence | yield_all (可配置)

#### 4.2.4 `environment/convergence-detector.ts`

convergence_score = verificationPassRate×0.35 + fileChangeRateDecay×0.20 + hotspotResolutionRate×0.20 + noveltyDecay×0.15 + (1−minorityPersistence)×0.10

---

### 4.3 Layer 2: 群体层

#### 4.3.1 `agent-pool/agent-profile.ts`

AgentProfile { id, persona, birth, parent?, generation, niches: Map<string, NicheCompetence>, synergies: Map<string, SynergyScore>, style: number[] }

NicheCompetence { label, q: 0-1 (EWMA), exposureCount, lastActivated, successes, failures }

更新: q ← (1−α)·q + α·(success?1:0), α=0.3

#### 4.3.2 `agent-pool/team-assembler.ts`

assembleTeam(pool, niche, complexity):

```
complexity="low"     → teamSize=1 (只用 anchor)
complexity="medium"  → 3 (anchor+complement+scout)
complexity="high"    → 5
complexity="extreme" → 7

Anchor     = argmax niche_q(niche)
Complement = argmax(0.4×q + 0.35×synergy − 0.25×style_sim)
Scout      = argmin exposureCount
```

#### 4.3.3 `agent-pool/lifecycle.ts`

LifecycleManager.runEpoch(pool):

```
Fork:      agent.q > 0.8 且 niches < 5 → 克隆
Merge:     style_sim > 0.9 且 q 几乎相同 → 合并
Prune:     连续 3τ < 中位数 → 淘汰 (触发 death)
Genesis:   新 niche 无覆盖 → 创世
Specialize: niche.q > 0.85 但 persona 未反映 → 更新 persona
```

---

### 4.4 Layer 3: 议会执行层

#### 4.4.1 `parliament/planner.ts`

PlannerAgent — 改造自 before-loop-manager.ts

- `plan(task, envSnapshot, relevantInsights)` → StructuredTaskPacket[]
- `revise(packets, observationMarks, aggregationMark)` → StructuredTaskPacket[]
- 使用最强模型 (planner MODEL role)
- 不做全生命周期规划——每次 iteration 产新 packets

StructuredTaskPacket = { id, title, scope{files, excludedFiles}, acceptanceCriteria[], verification{commands[], expectedOutput?}, dependencies[], niche, complexity, estimatedTokens }

#### 4.4.2 `parliament/working-group.ts`

WorkingGroupRunner — 基于 pipeline.ts Wave 并行 + executor.ts agent 执行

关键差异: 零 IRC

```
beforeToolCall hook:
  1. deposit Intent mark
  2. guardLayer.checkScope / checkConflict
  3. metabolism.consume()
  4. blocked? → return block reason → agent 自行调整

afterToolCall hook:
  1. deposit Action mark + Observation mark
  2. tool error? → guilt ↑
```

#### 4.4.3 `parliament/verifier.ts`

Verifier — 从 verification-hook.ts 升级为主 Gate

- 跑所有 packet.verification.commands
- 所有命令通过才算 pass
- 产出: VerificationMark (事实，非判断)

#### 4.4.4 `parliament/observer.ts`

Observer — 环境信号聚合

- 聚合所有 Action/Observation/Warning mark
- 检测 hotspots, conflicts, uncovered scope
- 计算 convergence_score
- 产出: AggregationMark

---

### 4.5 Layer 4: 学习层

#### 4.5.1 `experience/experience-store.ts`

ExperienceStore — 升级自 mnemopi-adapter.ts

- `store(entry)` → SQLite (bun:sqlite)
- `recall(embedding, niche, k)` → cosine similarity
- `synthesizeFailure(teamResult)` → CoDream 5-phase → insights
- `routeInsights(insights, pool)` → asymmetric route

#### 4.5.2 `experience/codream.ts`

CoDreamProtocol.execute(teamResult):

```
Phase 1: Reflect   → per-agent diagnosis
Phase 2: Contrast  → success vs failure delta
Phase 3: Imagine   → delta → hypotheses
Phase 4: Debate    → cross-critique, weak eliminated
Phase 5: Crystallize → { insight, level, niche, confidence, sourceAgents }
```

触发条件: team failure OR minority report generated

#### 4.5.3 `experience/asymmetric-router.ts`

routeInsights(insights, pool) → Map<agentId, insights[]>

关键: insight 只注入 niche competence < 中位数的 agent。对称路由 → −10.8pp。

---

### 4.6 前端变更

#### 组件映射

| 当前 | 目标 |
|---|---|
| MonitorPage (8 view modes) | 3 个固定面板 |
| ChatView (22KB, IRC) | MarkTimeline |
| ChannelList | 删除 |
| ContextPanel | AgentStatusPanel (quota bars + niche) |
| PhasePipeline | 保留 + 适配 new sub-phases |
| AgentTopology | 简化 → Environment View 子组件 |
| AgentTimeline → OutputView | 保留 |
| FileChangesPanel → OutputView | 保留 |
| CommMatrix | 删除 |
| ScalingHistory | 删除 |
| RoleBrowser (36KB) | Agent Profile 卡片列表 |
| **新增**: MarkTimeline, AgentQuotaBar, HotspotMap, MinorityAlert, CostDashboard, TrustScoreCard |

#### swarm-store.ts 变更

```
移除: channels, messages, activeChannelId, convergenceHistory, toolCalls
新增: marks[], agentProfiles[], agentQuotas, trustScores, hotspots[],
      aggregationMark, minorityReport, verificationResults[], costEstimate,
      convergenceScore

SSE 事件: mark_deposited, agent_quota_changed, agent_rep_changed,
          agent_slashed, agent_died, agent_born, verification_completed,
          aggregation_completed, minority_report_generated, convergence_updated,
          phase_changed, stream_start/delta/end (保留)
```

---

### 4.7 文件变更清单

```
保留 (无变更, 7):
  state.ts, swarm-state-machine.ts, executor.ts, pipeline.ts,
  file-tracker.ts, streaming.ts, dag.ts, context-guard.ts,
  plan-paths.ts, swarm-session-manager.ts, session-registry.ts, services.ts

升级 (部分保留, 7):
  mnemopi-adapter.ts → ExperienceStore
  verification-hook.ts → Verifier (主 Gate)
  before-loop-manager.ts → Planner (去独占)
  task-analyzer.ts → complexity assessment
  activity-logger.ts → 简化 event types
  schema.ts → 加 AgentProfile/Mark/PoolConfig 类型
  swarm-gui stores → 新 fields + SSE events

新增 (20):
  existential/: metabolism.ts, reputation.ts, affective.ts, trust-ledger.ts
  environment/: mark-types.ts, mark-store.ts, guard-layer.ts,
                signal-aggregator.ts, convergence-detector.ts
  agent-pool/: agent-profile.ts, team-assembler.ts, lifecycle.ts, pool-manager.ts
  experience/: experience-store.ts, codream.ts, asymmetric-router.ts
  parliament/: planner.ts, working-group.ts, verifier.ts, observer.ts, minority-reporter.ts

前端新增: MarkTimeline.tsx, AgentQuotaBar.tsx, HotspotMap.tsx,
          MinorityAlert.tsx, CostDashboard.tsx, TrustScoreCard.tsx

删除 (7):
  worker-channel.ts, cloner-channel.ts, roundtable.ts, cloner-roundtable.ts,
  convergence.ts, worker-scaler.ts, render.ts

前端删除: CommMatrix.tsx, ScalingHistory.tsx, ChannelList.tsx
```

---

### 4.8 层级依赖

```
existential/     ← 自包含 (Layer 0)
environment/     ← → existential
agent-pool/      ← → existential + environment
parliament/      ← → agent-pool + environment + existential
experience/      ← → agent-pool
```

每层可独立编译和测试。
