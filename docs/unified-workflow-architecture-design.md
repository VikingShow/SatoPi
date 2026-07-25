# SatoPi 统一工作流架构全景设计

> 设计日期: 2026-07-25
> 涵盖: 状态机、Agent 运行时、通信层、上下文管理（含 Offload/Hook/Compaction）、Phase 行为、协调层、持久化

---

## 目录

1. [现状问题全景诊断](#1-现状问题全景诊断)
2. [统一架构六层全景](#2-统一架构六层全景)
3. [Layer 0: WorkflowFSM — 统一状态机](#3-layer-0-workflowfsm)
4. [Layer 1: AgentRuntime — 统一 Agent 运行时](#4-layer-1-agentruntime)
5. [Layer 2: CommBus — 统一通信层](#5-layer-2-commbus)
6. [Layer 3: ContextManager — 统一上下文管理](#6-layer-3-contextmanager)
7. [Layer 4: HookSystem — 统一生命周期 Hook](#7-layer-4-hooksystem)
8. [Layer 5: PhaseBehavior — 统一阶段行为](#8-layer-5-phasebehavior)
9. [完整生命周期全景](#9-完整生命周期全景)
10. [迁移路径](#10-迁移路径)

---

## 1. 现状问题全景诊断

### 1.1 当前所有子系统的分散程度

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          当前架构 — 每个子系统各自分散                          │
│                                                                             │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│  │ ScriptManager        │  │ StageController      │  │ CurtainRunner    │  │
│  │  #phase (自管)       │  │  SwarmStateMachine   │  │  纯函数           │  │
│  │  #busy (自管)        │  │  StateTracker        │  │  无状态           │  │
│  │  #conversation (自管)│  │  transition()        │  │                  │  │
│  └──────────┬───────────┘  └──────────┬───────────┘  └────────┬─────────┘  │
│             │                         │                        │            │
│  ┌──────────┴─────────────────────────┴────────────────────────┴─────────┐  │
│  │ Agent 启动 (三种模式)                                                   │  │
│  │  Script: streamAgentOutput() — 单 agent，多轮对话                       │  │
│  │  Stage:  AgentExecutor.subprocess — 多 agent，TaskQueue while loop     │  │
│  │  Curtain: streamAgentOutput() + ReporterElection — 选举后启动           │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 通信 (三套机制)                                                         │  │
│  │  Script:  Human↔Planner → SSE + #conversation[]                        │  │
│  │  Stage:   Agent↔Agent  → IrcBus + AgentChannel                         │  │
│  │           Human→Agent → ActivityLogger relay (观察)                     │  │
│  │           Steering  → AgentChannel.interrupt/broadcastSteering         │  │
│  │  Curtain: Agent↔Agent → IrcBus + ReporterElection                      │  │
│  │           Reporter→Human → streamAgentOutput → SSE                      │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 上下文管理 (四处注入，四种方式)                                           │  │
│  │  1. ProfileRegistry.getPromptContext()  → Stage only                   │  │
│  │  2. MarkEnvironment.getContextForAgent() → Stage only (stigmergy)      │  │
│  │  3. ExperienceStore.search()            → Script only (planning)       │  │
│  │  4. Turn-aware guidance                 → Script only (硬编码)          │  │
│  │  5. MMD injection (offload-hooks)       → Stage only (via hooks)       │  │
│  │  6. MnemopiAdapter recall               → Stage only (via hooks)       │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ Offload (三阶段，只在 Stage)                                              │  │
│  │  L1 Summarize → L1.5 Dedup → L2 Attribution → L3 Mermaid               │  │
│  │  仅在 Stage 的 Wave/Iteration hook 中触发                                │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ Hook 系统 (两套独立)                                                     │  │
│  │  PipelineHooks / LoopPipelineHooks — 基础生命周期 hook                  │  │
│  │  OffloadHooks (createOffloadHooks)     — Offload 专用 hook              │  │
│  │  SwarmHooks (createStageFeedback)      — Stage 专用 callbacks          │  │
│  │  MnemopiAdapter                        — 语义记忆 hook                  │  │
│  │  Hook 之间相互不知道对方存在                                              │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 持久化 (三条路径)                                                        │  │
│  │  StateTracker → session.jsonl           (SwarmSessionManager)          │  │
│  │  SwarmOffloadStore → {agentId}.jsonl    (per-agent offload)            │  │
│  │  ExperienceStore → SQLite + FTS5        (经验积累)                       │  │
│  │  ActivityLogger → session.jsonl + SSE   (事件日志)                       │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心问题

| 维度 | 分散情况 |
|------|----------|
| **状态机** | 4 处独立的 phase 追踪（ScriptManager.#phase, StateTracker.phase, SwarmStateMachine, Pipeline 的 iteration loop） |
| **Agent 生命周期** | 3 种启动模式，3 种 role 注入位置，3 种上下文构建方式 |
| **通信** | Human 在 Script 是一等公民，在 Stage 是观察者，在 Curtain 是被动接收者 |
| **上下文注入** | 6 种上下文来源，分散在 4 个不同位置注入，无统一管道 |
| **Offload** | 仅 Stage 有 L1→L3 pipeline，Script 和 Curtain 无摘要机制 |
| **Hook** | 4 套独立的 hook/callback 系统，无法组合 |
| **持久化** | 3 条独立写入路径，无法统一查询 |

---

## 2. 统一架构六层全景

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     SatoPi 统一工作流架构 — 六层全景                            │
│                                                                              │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                                                                        │  │
│  │  Layer 5: PhaseBehavior                                                │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │  │
│  │  │ Script       │  │ Stage        │  │ Curtain      │                 │  │
│  │  │ Behavior     │  │ Behavior     │  │ Behavior     │                 │  │
│  │  │              │  │              │  │              │                 │  │
│  │  │ enter()      │  │ enter()      │  │ enter()      │                 │  │
│  │  │ handleMsg()  │  │ handleMsg()  │  │ handleMsg()  │                 │  │
│  │  │ checkDone()  │  │ checkDone()  │  │ checkDone()  │                 │  │
│  │  │ exit()       │  │ exit()       │  │ exit()       │                 │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                 │  │
│  │                                                                        │  │
│  │  所有 Phase 实现统一的 PhaseBehavior 接口                                │  │
│  │  每个 Phase 声明: multiAgent / roundtable / vote / offload 等能力        │  │
│  │                                                                        │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
│                                      │ 依赖                                  │
│  ┌───────────────────────────────────┼────────────────────────────────────┐  │
│  │                                   │                                    │  │
│  │  Layer 4: HookSystem — 统一生命周期 Hook                                │  │
│  │  ┌──────────────────────────────────────────────────────────────┐     │  │
│  │  │                    HookPipeline                              │     │  │
│  │  │                                                              │     │  │
│  │  │  beforePhase → afterPhase                                    │     │  │
│  │  │  beforeAgentSpawn → afterAgentComplete                       │     │  │
│  │  │  beforeContextInjection → afterContextInjection              │     │  │
│  │  │  beforeOffload → afterOffload                                │     │  │
│  │  │  beforeMessage → afterMessage                                │     │  │
│  │  │  onError                                                    │     │  │
│  │  │                                                              │     │  │
│  │  │  所有 Hook 注册到同一个 HookPipeline，按 priority 有序执行       │     │  │
│  │  └──────────────────────────────────────────────────────────────┘     │  │
│  │                                                                        │  │
│  │  内置 Hook 实现（注册到 HookPipeline）:                                  │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐       │  │
│  │  │ Offload    │ │ Experience │ │ Mnemopi    │ │ Verification │       │  │
│  │  │ Hook       │ │ Hook       │ │ Hook       │ │ Hook         │       │  │
│  │  │ (L1→L3)   │ │ (Store)    │ │ (Recall)   │ │ (Tests)      │       │  │
│  │  └────────────┘ └────────────┘ └────────────┘ └──────────────┘       │  │
│  │  ┌────────────┐ ┌────────────┐                                       │  │
│  │  │ Profile    │ │ Stigmergy  │                                       │  │
│  │  │ Hook       │ │ Hook       │                                       │  │
│  │  │ (Credit)   │ │ (Marks)    │                                       │  │
│  │  └────────────┘ └────────────┘                                       │  │
│  │                                                                        │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
│                                      │ 依赖                                  │
│  ┌───────────────────────────────────┼────────────────────────────────────┐  │
│  │                                   │                                    │  │
│  │  Layer 3: ContextManager — 统一上下文管理                               │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────┐     │  │
│  │  │                  ContextPipeline                              │     │  │
│  │  │                                                              │     │  │
│  │  │  ContextSource (priority-ordered pipeline):                  │     │  │
│  │  │                                                              │     │  │
│  │  │  priority=0  RoleSource         角色注入                      │     │  │
│  │  │  priority=1  ProfileSource      信用/偏好                     │     │  │
│  │  │  priority=2  ExperienceSource   历史经验 (FTS5 召回)          │     │  │
│  │  │  priority=3  TurnGuidanceSource 回合感知 (Script 专属)        │     │  │
│  │  │  priority=4  StigmergySource    环境信号 (Mark 查询)          │     │  │
│  │  │  priority=5  OffloadSource      MMD 注入 + 经验桥接           │     │  │
│  │  │  priority=6  MnemopiSource      语义记忆召回                  │     │  │
│  │  │  priority=7  TaskQueueSource    任务队列上下文 (Stage 专属)   │     │  │
│  │  │                                                              │     │  │
│  │  │  每个 ContextSource 声明:                                      │     │  │
│  │  │    - appliesTo(phase, agentRole) → boolean                   │     │  │
│  │  │    - build(spec, ctx) → ContextFragment                      │     │  │
│  │  └──────────────────────────────────────────────────────────────┘     │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────┐     │  │
│  │  │                  OffloadManager                               │     │  │
│  │  │                                                              │     │  │
│  │  │  统一 Offload 流水线，所有 Phase 可用:                          │     │  │
│  │  │                                                              │     │  │
│  │  │  Agent 产出 → L1 Summarize (截断/LLM)                         │     │  │
│  │  │            → L1.5 Dedup (Jaccard 去重)                        │     │  │
│  │  │            → L2 Attribution (归因到 plan phase)               │     │  │
│  │  │            → L3 Synthesis (Mermaid 生成)                      │     │  │
│  │  │                                                              │     │  │
│  │  │  触发策略: 阈值触发 / 超时触发 / Phase 结束强制 flush           │     │  │
│  │  │  存储: SwarmOffloadStore → {agentId}.jsonl                   │     │  │
│  │  └──────────────────────────────────────────────────────────────┘     │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────┐     │  │
│  │  │                  ContextCompactor                             │     │  │
│  │  │                                                              │     │  │
│  │  │  上下文窗口管理: 当 Agent 对话历史超过 token 预算时触发          │     │  │
│  │  │  策略: summarize / truncate / offload-to-stigmergy            │     │  │
│  │  └──────────────────────────────────────────────────────────────┘     │  │
│  │                                                                        │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
│                                      │ 依赖                                  │
│  ┌───────────────────────────────────┼────────────────────────────────────┐  │
│  │                                   │                                    │  │
│  │  Layer 2: CommBus — 统一通信层                                         │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────┐     │  │
│  │  │  CommEndpoint (Human 和 Agent 是对等的通信端点)                  │     │  │
│  │  │                                                              │     │  │
│  │  │  human ──┐                                                   │     │  │
│  │  │  agent-1 ─┤                                                   │     │  │
│  │  │  agent-2 ─┼── CommBus ── IrcBus (底层传输)                    │     │  │
│  │  │  agent-3 ─┤               SSE   (前端推送)                    │     │  │
│  │  │  system ──┘                                                   │     │  │
│  │  └──────────────────────────────────────────────────────────────┘     │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────┐     │  │
│  │  │  CommChannel (通信模式)                                        │     │  │
│  │  │                                                              │     │  │
│  │  │  directChannel("human", "planner")     → 1:1 对话             │     │  │
│  │  │  groupChannel("swarm", agents)          → N:N 群聊            │     │  │
│  │  │  broadcastChannel("human")              → 1:N 广播            │     │  │
│  │  │  channel.roundtable(topic, config)       → 结构化圆桌          │     │  │
│  │  │  channel.vote(question, candidates)      → 投票               │     │  │
│  │  └──────────────────────────────────────────────────────────────┘     │  │
│  │                                                                        │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
│                                      │ 依赖                                  │
│  ┌───────────────────────────────────┼────────────────────────────────────┐  │
│  │                                   │                                    │  │
│  │  Layer 1: AgentRuntime — 统一 Agent 运行时                             │  │
│  │                                                                        │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐    │  │
│  │  │ AgentSpec    │  │ RoleProvider │  │ AgentLauncher            │    │  │
│  │  │ (声明式描述)  │  │ (统一角色解析)│  │ (封装 spawn 策略)         │    │  │
│  │  └──────┬───────┘  └──────┬───────┘  └───────────┬──────────────┘    │  │
│  │         │                 │                      │                    │  │
│  │         └─────────┬───────┴──────────────────────┘                    │  │
│  │                   │                                                   │  │
│  │                   ▼                                                   │  │
│  │  AgentRuntime.spawn(specs) → AgentHandle[]                            │  │
│  │  AgentRuntime.spawnRoundtable(specs, config) → RoundtableResult       │  │
│  │                                                                        │  │
│  │  AgentHandle:                                                          │  │
│  │    .wait()     → AgentResult                                          │  │
│  │    .send(msg)  → 多轮对话注入                                          │  │
│  │    .abort()    → 中断                                                  │  │
│  │    .stream()   → AsyncIterable<string>                                │  │
│  │    .onContextCompact → 上下文压缩事件                                   │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
│                                      │ 依赖                                  │
│  ┌───────────────────────────────────┼────────────────────────────────────┐  │
│  │                                   │                                    │  │
│  │  Layer 0: WorkflowFSM — 统一状态机                                     │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────┐     │  │
│  │  │  PhaseDefinition (声明式)                                      │     │  │
│  │  │  - allowedTransitions                                          │     │  │
│  │  │  - participantRoles                                            │     │  │
│  │  │  - capabilities: { multiAgent, roundtable, vote, offload }     │     │  │
│  │  │  - timeout                                                     │     │  │
│  │  │  - onEnter / onExit                                            │     │  │
│  │  └──────────────────────────────────────────────────────────────┘     │  │
│  │                                                                        │  │
│  │  WorkflowFsm.transition(to) → TransitionResult                        │  │
│  │  WorkflowFsm.waitForHumanDecision() → Promise<T>                      │  │
│  │  WorkflowFsm.onChange(listener) → unsubscribe                          │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│                                                                              │
│  ═══════════════════════════════════════════════════════════════════════════ │
│                              Cross-cutting                                  │
│  ═══════════════════════════════════════════════════════════════════════════ │
│                                                                              │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐     │
│  │ StateTracker       │  │ ActivityLogger     │  │ SessionRegistry    │     │
│  │ - phase 追踪       │  │ - SSE 推送         │  │ - 多 session 管理   │     │
│  │ - agent 状态       │  │ - session.jsonl    │  │ - Collab 支持      │     │
│  │ - todo 进度        │  │ - UI relay         │  │                    │     │
│  └────────────────────┘  └────────────────────┘  └────────────────────┘     │
│                                                                              │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐     │
│  │ ExperienceStore    │  │ MarkEnvironment    │  │ RegionLockManager  │     │
│  │ - SQLite + FTS5    │  │ - Stigmergy marks  │  │ - 文件锁协调        │     │
│  │ - 权重衰减         │  │ - 惰性过期         │  │ - 冲突检测          │     │
│  │ - 原则蒸馏         │  │ - 分面查询         │  │                    │     │
│  └────────────────────┘  └────────────────────┘  └────────────────────┘     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Layer 0: WorkflowFSM — 统一状态机

### 3.1 设计目标

将当前 4 处独立的 phase 追踪（ScriptManager.#phase, StateTracker.phase, SwarmStateMachine, Pipeline iteration loop）统一为一个 WorkflowFSM。

### 3.2 核心接口

```typescript
// packages/coding-agent/src/swarm/core/workflow-fsm.ts

/** Phase 能力声明 */
interface PhaseCapabilities {
  /** 是否允许多 agent 并发 */
  multiAgent: boolean;
  /** 是否支持 roundtable */
  roundtable: boolean;
  /** 是否支持 vote */
  vote: boolean;
  /** 是否启用 offload */
  offload: boolean;
  /** 是否启用 context compaction */
  compaction: boolean;
  /** Human 通信模式 */
  humanMode: "dialogue" | "observer" | "passive" | "none";
}

/** Phase 定义 — 声明式、可测试、可扩展 */
interface PhaseDefinition {
  phase: WorkflowPhase;
  allowedFrom: WorkflowPhase[];
  allowedTo: WorkflowPhase[];
  capabilities: PhaseCapabilities;
  defaultTimeoutMs: number;          // 0 = 无超时
  onEnter?: (ctx: FsmContext) => Promise<void>;
  onExit?: (ctx: FsmContext) => Promise<void>;
}

/** 统一工作流状态 */
interface WorkflowState {
  phase: WorkflowPhase;
  subStatus: string;
  participants: Map<string, ParticipantState>;
  running: boolean;
  iteration: number;
  phaseStartedAt: number;
  // Phase 元数据（由 FSM 在 transition 时自动设置）
  capabilities: PhaseCapabilities;
}

class WorkflowFsm {
  readonly state: WorkflowState;

  // Phase 注册
  registerPhase(def: PhaseDefinition): void;

  // 受控转换 — 校验 guard + hooks
  transition(to: WorkflowPhase, meta?: TransitionMeta): Promise<TransitionResult>;

  // Human 交互等待 (blocked/confirm 等交互 phase)
  waitForHumanDecision<T>(timeoutMs?: number): Promise<T>;

  // 事件监听
  onChange(listener: (event: FsmEvent) => void): () => void;

  // 集成 CommBus — 当 phase 变化时自动调整 human 能力
  bindCommBus(bus: CommBus): void;
}
```

### 3.3 Phase 注册示例

```typescript
// 声明式注册 — 替代当前分散在多个文件中的 phase 逻辑
const PHASES: PhaseDefinition[] = [
  // ── Script: 单 agent + Human 对话模式 ──
  {
    phase: "script",
    allowedFrom: ["idle", "curtain"],
    allowedTo: ["script-debate", "script-confirm", "idle"],
    capabilities: {
      multiAgent: false,        // 单 Planner
      roundtable: false,        // 无 (debate 是单独的 sub-phase)
      vote: false,
      offload: true,            // 可以摘要 Planner 产出
      compaction: false,        // 对话历史天然增长，暂不压缩
      humanMode: "dialogue",    // Human 主动对话
    },
    defaultTimeoutMs: 0,        // 无超时
  },

  // ── Script-Debate: 多 agent + Human 观察 ──
  {
    phase: "script-debate",
    allowedFrom: ["script", "script-confirm"],
    allowedTo: ["script-confirm", "script", "idle"],
    capabilities: {
      multiAgent: true,         // 2-3 debater agent
      roundtable: true,         // 结构化辩论
      vote: false,
      offload: true,            // 摘要辩论产出
      compaction: false,
      humanMode: "observer",    // Human 旁观辩论
    },
    defaultTimeoutMs: 300_000,   // 5 分钟超时
  },

  // ── Stage: 多 agent + Human 观察 + steering ──
  {
    phase: "stage",
    allowedFrom: ["script-confirm", "paused", "blocked"],
    allowedTo: ["paused", "blocked", "curtain"],
    capabilities: {
      multiAgent: true,
      roundtable: true,
      vote: true,              // Reporter 选举等
      offload: true,           // 全 L1→L3 流水线
      compaction: true,        // Agent 上下文过长时触发
      humanMode: "observer",   // Human 观察 + steering interrupt
    },
    defaultTimeoutMs: 0,
  },

  // ── Curtain: 多 agent + Human 被动接收 ──
  {
    phase: "curtain",
    allowedFrom: ["stage", "paused", "blocked"],
    allowedTo: ["idle", "stage"],
    capabilities: {
      multiAgent: true,
      roundtable: false,
      vote: true,              // Reporter 选举
      offload: true,           // 最终摘要 + 经验蒸馏
      compaction: false,
      humanMode: "passive",    // Human 接收 reporter 输出
    },
    defaultTimeoutMs: 120_000,
  },
];
```

---

## 4. Layer 1: AgentRuntime — 统一 Agent 运行时

### 4.1 设计目标

替代三种分散的 agent 启动方式（`streamAgentOutput`, `AgentExecutor.subprocess`, `runSubprocess`），提供统一的声明式接口。

### 4.2 核心接口

```typescript
// packages/coding-agent/src/swarm/agent-runtime/index.ts

// ── AgentSpec: 声明式 Agent 描述 ──
interface AgentSpec {
  id: string;
  role: string;
  roleSource: "library" | "profile" | "inline";
  inline?: { systemPrompt: string; tools: string[] };
  task: string;
  modelPreference?: "cheapest" | "smartest" | "role-default";
}

// ── RoleProvider: 统一角色解析 ──
// (封装当前 roleAssetManager.get() 的三处重复调用)
interface RoleProvider {
  resolve(spec: AgentSpec): Promise<ResolvedRole>;
  list(filter?: RoleFilter): Promise<RoleAsset[]>;
}

// ── AgentLauncher: 统一启动策略 ──
interface AgentLauncher {
  launch(spec: AgentSpec, context: AssembledContext, opts: LaunchOptions): Promise<AgentHandle>;
}

interface LaunchOptions {
  signal?: AbortSignal;
  mode?: "inline" | "subprocess";   // 默认由 phase capabilities 决定
  keepAlive?: boolean;
  modelOverride?: string;
}

// ── AgentHandle: 对运行中 agent 的统一引用 ──
interface AgentHandle {
  readonly id: string;
  readonly role: string;
  readonly status: "running" | "completed" | "failed" | "aborted";

  wait(): Promise<AgentResult>;
  send(message: string): Promise<void>;
  abort(): void;
  outputStream(): AsyncIterable<string>;
  /** 订阅上下文压缩事件 */
  onContextCompact(handler: (info: CompactInfo) => void): () => void;
}

// ── AgentRuntime: 统一入口 ──
class AgentRuntime {
  constructor(
    private roleProvider: RoleProvider,
    private contextManager: ContextManager,
    private launcher: AgentLauncher,
    private commBus: CommBus,
    private hookPipeline: HookPipeline,
  ) {}

  /** 启动 agent(s) — 所有 phase 统一入口 */
  async spawn(specs: AgentSpec[], opts?: LaunchOptions): Promise<AgentHandle[]>;

  /** 启动 roundtable — agent 之间可以互相通信 */
  async spawnRoundtable(specs: AgentSpec[], config: RoundtableConfig): Promise<RoundtableResult>;

  /** 启动 vote session */
  async spawnVote(question: string, candidates: string[], participants: string[]): Promise<VoteResult>;
}
```

### 4.3 Agent 生命周期流程

```
AgentRuntime.spawn([spec])
  │
  ├─ 1. RoleProvider.resolve(spec)
  │     → 查询 role library → fallback 内联 → ResolvedRole
  │
  ├─ 2. HookPipeline.trigger("beforeAgentSpawn", { spec, role })
  │     → Offload Hook: 召回历史经验
  │     → Mnemopi Hook: 语义记忆注入
  │     → Profile Hook: 更新 agent 状态
  │
  ├─ 3. ContextManager.assemble(spec, phase, base)
  │     → ContextPipeline 管道式构建:
  │       Role → Profile → Experience → TurnGuidance → Stigmergy → Offload → Mnemopi → TaskQueue
  │     → AssembledContext { systemPrompt, taskPrompt, injectedContexts }
  │
  ├─ 4. HookPipeline.trigger("beforeAgentLaunch", { spec, context })
  │     → ContextCompactor: 检查 token 预算，必要时压缩
  │
  ├─ 5. AgentLauncher.launch(spec, context, opts)
  │     → 选择执行模式 (inline/subprocess)
  │     → 返回 AgentHandle
  │
  ├─ 6. AgentHandle.outputStream() 通过 CommBus 实时 relay 到 UI
  │
  ├─ 7. AgentHandle.wait() → AgentResult
  │
  ├─ 8. HookPipeline.trigger("afterAgentComplete", { spec, result })
  │     → Offload Hook: L1 摘要 → SwarmOffloadStore
  │     → Profile Hook: 更新信用分
  │     → Stigmergy Hook: 放置 artifact/warning mark
  │
  └─ 9. ContextCompactor: 如果 agent 是 long-running，异步压缩旧的上下文
```

---

## 5. Layer 2: CommBus — 统一通信层

### 5.1 核心设计

> **Human 和 Agent 是对等的 CommEndpoint。** 通信模式由 Phase 的 `humanMode` 控制。

### 5.2 核心接口

```typescript
// packages/coding-agent/src/swarm/comm-bus/index.ts

// ── 通信端点 ──
interface CommEndpoint {
  readonly id: string;
  readonly kind: "human" | "agent" | "system";
  readonly capabilities: Set<EndpointCapability>;  // send/receive/broadcast/interrupt/vote/roundtable
}

// ── 通信通道 ──
interface CommChannel {
  readonly id: string;
  readonly members: ReadonlySet<string>;

  // 基础通信
  send(from: string, body: string, opts?: SendOptions): Promise<void>;

  // 高级通信模式
  roundtable(topic: string, config: RoundtableConfig): Promise<RoundtableResult>;
  vote(question: string, candidates: string[], timeoutMs?: number): Promise<VoteResult>;

  // 订阅
  subscribe(endpointId: string, handler: (msg: CommEnvelope) => void): () => void;
}

// ── 统一总线 ──
class CommBus {
  readonly human: CommEndpoint;
  readonly system: CommEndpoint;

  // Agent 管理
  registerAgent(id: string, capabilities?: EndpointCapability[]): CommEndpoint;

  // 通道工厂 — 替代 IrcBus + AgentChannel 的分散 API
  directChannel(a: string, b: string): CommChannel;           // 1:1
  groupChannel(name: string, members: string[]): CommChannel;  // N:N
  broadcastChannel(from: string): CommChannel;                 // 1:N

  // Human UI 推送 — 替代 ActivityLogger → SSE
  pushToUI(event: UIEvent): void;

  // Human 输入入口 — 替代 REST sendMessage/steer
  receiveFromHuman(text: string, target?: CommunicatingTarget): Promise<void>;

  // Phase 切换时自动调整 Human 能力
  setPhaseCapabilities(caps: PhaseCapabilities): void;
}
```

### 5.3 通信模式矩阵

| Phase | Human 角色 | Human 能做什么 | Agent 间通信 | 底层传输 |
|-------|-----------|---------------|-------------|---------|
| **script** | dialogue | 与 Planner 1:1 对话 | 无 | CommBus.directChannel → IrcBus + SSE relay |
| **script-debate** | observer | 观看辩论，不能发言 | roundtable | CommBus.groupChannel.roundtable() |
| **stage** | observer | 观看 + steering broadcast | direct + roundtable + vote | CommBus.groupChannel + IrcBus |
| **blocked** | dialogue | 决策交互 | 暂停中 | CommBus.waitForHumanDecision() |
| **curtain** | passive | 接收 reporter 输出 + applaud | vote (选举) | CommBus.groupChannel.vote() + pushToUI |

---

## 6. Layer 3: ContextManager — 统一上下文管理

### 6.1 设计目标

将当前 6 种分散的上下文注入（Profile、Stigmergy、Experience、TurnGuidance、MMD、Mnemopi）统一为 ContextPipeline。同时将 Offload pipeline 统一定义为 ContextManager 的一个职责。

### 6.2 架构总览

```
ContextManager
  ├── ContextPipeline (注入方向: 构建 Agent 上下文)
  │     ├── RoleSource         (priority=0, 所有 phase)
  │     ├── ProfileSource      (priority=1, 所有 phase)
  │     ├── ExperienceSource   (priority=2, script/script-debate)
  │     ├── TurnGuidanceSource (priority=3, script only)
  │     ├── StigmergySource    (priority=4, stage only)
  │     ├── OffloadSource      (priority=5, stage/curtain)
  │     ├── MnemopiSource      (priority=6, 所有 phase, 可选)
  │     └── TaskQueueSource    (priority=7, stage only)
  │
  ├── OffloadPipeline (产出方向: 从 Agent 产出生成摘要)
  │     ├── L1  Summarizer    (文本截断 / LLM 压缩)
  │     ├── L1.5 Deduplicator (Jaccard 去重)
  │     ├── L2  Attributor    (归因到 plan phase)
  │     └── L3  Synthesizer   (Mermaid + 经验蒸馏)
  │
  ├── ContextCompactor (压缩方向: 当上下文超出 token 预算)
  │     ├── Strategy: summarize (保留语义)
  │     ├── Strategy: truncate (保留最近)
  │     └── Strategy: offload-to-stigmergy (长摘要→Mark)
  │
  └── ContextStore (存储方向)
        ├── SwarmOffloadStore → {agentId}.jsonl
        ├── ExperienceStore   → SQLite + FTS5
        └── Stigmergy (MarkEnvironment) → 内存 + 序列化
```

### 6.3 ContextPipeline 详细接口

```typescript
// packages/coding-agent/src/swarm/context-manager/context-pipeline.ts

interface ContextSource {
  readonly name: string;
  readonly priority: number;

  /** 声明适用于哪些 Phase + Agent 角色组合 */
  appliesTo(phase: WorkflowPhase, agentRole: string, capabilities: PhaseCapabilities): boolean;

  /** 构建上下文片段 */
  build(spec: AgentSpec, base: BuildContext): Promise<ContextFragment>;
}

interface BuildContext {
  taskDescription: string;
  workspace: string;
  swarmDir: string;
  planContent?: string;
  turnNumber: number;
  phase: WorkflowPhase;
  // 来自其他 source 的产出（后续 source 可以引用前面的产出）
  accumulated: Partial<AssembledContext>;
}

interface ContextFragment {
  systemPromptAddition?: string;
  taskPromptAddition?: string;
  injectedBlock?: { tag: string; content: string };  // e.g. <agent_experience>...</agent_experience>
  tools?: string[];
}

interface AssembledContext {
  systemPrompt: string;
  taskPrompt: string;
  tools: string[];
  injectedBlocks: Array<{ tag: string; content: string }>;
}
```

### 6.4 OffloadPipeline 统一设计

```
当前: Offload 仅在 Stage 的 Wave/Iteration hook 中触发
统一后: Offload 是 ContextManager 的职责，由 HookPipeline 驱动，所有 Phase 可用

触发点 (通过 HookPipeline):
  - afterAgentComplete:  每个 Agent 完成后触发 L1
  - beforePhaseTransition: Phase 结束时触发 L1.5→L2→L3 flush
  - onContextCompact:     上下文压缩时可选触发 L1

配置 (每个 Phase 可独立配置):
  Phase "script":          offload: true  → L1 only (摘要 Planner 对话)
  Phase "script-debate":   offload: true  → L1 only (摘要辩论观点)
  Phase "stage":           offload: true  → 完整 L1→L3 流水线
  Phase "curtain":         offload: true  → L1 + 经验蒸馏桥接
```

```typescript
// packages/coding-agent/src/swarm/context-manager/offload-manager.ts

interface OffloadConfig {
  enabled: boolean;
  /** 每个 Phase 的 offload 级别 */
  phases: Partial<Record<WorkflowPhase, {
    /** L1 触发阈值 (累积条目数) */
    l1TriggerThreshold: number;
    /** 是否启用 L2 归因 */
    enableL2: boolean;
    /** 是否启用 L3 Mermaid 合成 */
    enableL3: boolean;
    /** 是否启用 ExperienceStore 桥接 */
    bridgeToExperience: boolean;
  }>>;
}

class OffloadManager {
  // 从 AgentResult 生成 L1 摘要
  async summarizeL1(agentId: string, result: AgentResult, context: OffloadContext): Promise<OffloadEntry>;

  // 检查是否需要 flush L1.5→L2→L3
  shouldFlushL2(phase: WorkflowPhase): boolean;

  // 执行 L1.5→L2→L3
  async flushL2L3(phase: WorkflowPhase, planPhases: PlanPhase[]): Promise<L2L3Result>;

  // Phase 结束强制 flush
  async forceFlush(phase: WorkflowPhase, planPhases: PlanPhase[]): Promise<L2L3Result>;

  // 获取当前 MMD (供 ContextSource 注入)
  getCurrentMmd(): string | null;

  // 获取某 agent 的 experience context
  getExperienceContext(agentId: string): string | null;

  // 清空跨 phase 状态 (新 session 时)
  reset(): void;
}
```

### 6.5 ContextCompactor — 上下文压缩

```typescript
// packages/coding-agent/src/swarm/context-manager/context-compactor.ts

interface CompactionStrategy {
  readonly name: string;

  /** 判断是否适用 */
  appliesTo(agent: AgentHandle, tokensUsed: number, budget: number): boolean;

  /** 执行压缩 */
  compact(agent: AgentHandle, history: AgentMessage[]): Promise<CompactedContext>;
}

interface CompactedContext {
  /** 替换完整历史的消息列表（更短） */
  messages: AgentMessage[];
  /** 被压缩到 stigmergy 环境中的摘要 */
  stigmergyMarks?: Mark[];
  /** 被压缩到 offload 的摘要 */
  offloadEntries?: OffloadEntry[];
}

class ContextCompactor {
  constructor(
    private strategies: CompactionStrategy[],
    private markEnv: MarkEnvironment,
    private offloadMgr: OffloadManager,
  ) {}

  /** 检查并压缩 agent 的上下文 */
  async compactIfNeeded(agent: AgentHandle): Promise<CompactedContext | null>;

  /** 注册到 HookPipeline: 在 beforeAgentLaunch 时异步检查 */
  asHook(): HookRegistration;
}
```

---

## 7. Layer 4: HookSystem — 统一生命周期 Hook

### 7.1 设计目标

将当前 4 套独立的 hook/callback 系统（PipelineHooks、OffloadHooks、SwarmHooks/StageCallbacks、MnemopiAdapter）统一为一个 HookPipeline。所有 hook 按 priority 有序执行，可以跨 phase 和跨 hook 类型组合。

### 7.2 核心接口

```typescript
// packages/coding-agent/src/swarm/hook-system/hook-pipeline.ts

// ── 统一的 Hook 事件类型 ──
type HookEvent =
  // Phase 生命周期
  | "workflow:beforePhase"
  | "workflow:afterPhase"
  | "workflow:phaseTimeout"

  // Agent 生命周期
  | "agent:beforeSpawn"
  | "agent:afterSpawn"
  | "agent:beforeLaunch"
  | "agent:afterComplete"
  | "agent:onError"

  // 上下文生命周期
  | "context:beforeInjection"
  | "context:afterInjection"
  | "context:beforeCompaction"
  | "context:afterCompaction"

  // Offload 生命周期
  | "offload:afterL1"
  | "offload:beforeFlush"
  | "offload:afterFlush"

  // 通信生命周期
  | "comm:beforeMessage"
  | "comm:afterMessage"
  | "comm:beforeBroadcast"
  | "comm:afterBroadcast"
  | "comm:beforeRoundtable"
  | "comm:afterRoundtable"

  // Roundtable 生命周期
  | "roundtable:beforeRound"
  | "roundtable:afterRound"
  | "roundtable:converged"

  // Vote 生命周期
  | "vote:start"
  | "vote:tally"
  | "vote:result"
  ;

// ── Hook 注册 ──
interface HookRegistration {
  readonly name: string;
  readonly priority: number;          // 数字越小越先执行
  readonly events: HookEvent[];       // 关心的 hook 事件
  readonly phases?: WorkflowPhase[];   // 可选的 phase 过滤

  /** Hook 处理函数。返回 void 或 false（false 阻止后续同事件 hook 执行） */
  handler(event: HookEvent, payload: HookPayload): Promise<void | boolean>;
}

// ── Hook 系统需要的上下文 ──
interface HookContext {
  phase: WorkflowPhase;
  fsm: WorkflowFsm;
  commBus: CommBus;
  runtime: AgentRuntime;
  contextManager: ContextManager;
  stateTracker: StateTracker;
  activityLogger: ActivityLogger;
  sessionRegistry: SessionRegistry;
}

// ── HookPipeline ──
class HookPipeline {
  register(hook: HookRegistration): void;
  unregister(name: string): void;

  /** 同步触发 hook */
  async trigger(event: HookEvent, payload: HookPayload, ctx: HookContext): Promise<void>;

  /** 获取当前注册的所有 hook */
  list(): ReadonlyArray<HookRegistration>;
}
```

### 7.3 内置 Hook 注册

```typescript
// 注册顺序（priority 决定执行顺序）

// priority=0: Profile Hook — 最早执行，确保 profile 状态先更新
hookPipeline.register({
  name: "profile",
  priority: 0,
  events: ["agent:beforeSpawn", "agent:afterComplete", "workflow:afterPhase"],
  handler: async (event, payload, ctx) => {
    // agent:beforeSpawn → profileRegistry.getOrCreate()
    // agent:afterComplete → profileRegistry.recordTaskCompleted()
    // workflow:afterPhase  → profileRegistry.recordCollaboration()
  },
});

// priority=1: Stigmergy Hook
hookPipeline.register({
  name: "stigmergy",
  priority: 1,
  events: ["agent:afterComplete", "agent:onError", "context:afterCompaction"],
  handler: async (event, payload, ctx) => {
    // agent:afterComplete → placeMark("artifact")
    // agent:onError       → placeMark("warning")
    // context:afterCompaction → 将压缩后的摘要作为 mark 放置
  },
});

// priority=2: Offload Hook
hookPipeline.register({
  name: "offload",
  priority: 2,
  events: ["agent:afterComplete", "workflow:beforePhase", "roundtable:afterRound"],
  phases: ["script", "script-debate", "stage", "curtain"],
  handler: async (event, payload, ctx) => {
    // agent:afterComplete    → L1 summarize → SwarmOffloadStore
    // workflow:beforePhase   → forceFlush L1.5→L2→L3
    // roundtable:afterRound  → L1 summarize debate findings
  },
});

// priority=3: Mnemopi Hook (语义记忆)
hookPipeline.register({
  name: "mnemopi",
  priority: 3,
  events: ["agent:beforeSpawn", "agent:afterComplete"],
  handler: async (event, payload, ctx) => {
    // agent:beforeSpawn  → recall(query) → 注入上下文
    // agent:afterComplete → storeIfHighScore(summary)
  },
});

// priority=4: Experience Hook (经验蒸馏)
hookPipeline.register({
  name: "experience",
  priority: 4,
  events: ["offload:afterFlush", "workflow:afterPhase"],
  phases: ["stage", "curtain"],
  handler: async (event, payload, ctx) => {
    // offload:afterFlush → bridgeToExperienceStore()
    // workflow:afterPhase → bridgeSessionSummary() + decayUnreferenced()
  },
});

// priority=5: Verification Hook (确定性验证)
hookPipeline.register({
  name: "verification",
  priority: 5,
  events: ["workflow:beforePhase"],
  phases: ["curtain"],   // 只在进入 curtain 前跑验证
  handler: async (event, payload, ctx) => {
    // 运行 test/lint/typecheck 命令
    // 结果写入 activityLogger
  },
});
```

### 7.4 Hook 数据流全景

```
Agent 完成一次 Turn
  │
  ├─ HookPipeline.trigger("agent:afterComplete")
  │
  ├─ [priority=0] Profile Hook
  │     → profileRegistry.recordTaskCompleted(agentId, success)
  │
  ├─ [priority=1] Stigmergy Hook
  │     → markEnvironment.placeMark({ type: "artifact", ... })
  │     → markEnvironment.placeMark({ type: "warning", ... })  // if failed
  │
  ├─ [priority=2] Offload Hook
  │     → OffloadManager.summarizeL1(agentId, result)
  │     → SwarmOffloadStore.appendEntry(agentId, entry)
  │     → if (shouldFlush) → OffloadManager.flushL2L3()
  │         → Deduplicator → Attributor → MermaidSynthesizer
  │
  ├─ [priority=3] Mnemopi Hook
  │     → if (score >= threshold) → client.remember(summary)
  │
  └─ [priority=4] Experience Hook
        → if (offload was flushed) → bridgeToExperienceStore()
        → ExperienceStore.saveLesson()
```

---

## 8. Layer 5: PhaseBehavior — 统一阶段行为

### 8.1 核心接口

```typescript
// packages/coding-agent/src/swarm/behaviors/index.ts

interface PhaseBehavior {
  readonly phase: WorkflowPhase;

  /** FSM 进入此 phase 时调用 */
  enter(ctx: PhaseContext): Promise<PhaseEnterResult>;

  /** 处理来自 CommBus 的 Human 消息 */
  handleHumanMessage(msg: CommEnvelope): Promise<void>;

  /** 处理 Agent 事件（完成、失败、请求帮助等） */
  handleAgentEvent(event: AgentEvent): Promise<void>;

  /** 检查 phase 是否已完成。返回 null = 进行中 */
  checkCompletion(): Promise<PhaseCompletion | null>;

  /** FSM 离开此 phase 时调用 */
  exit(): Promise<void>;
}

interface PhaseContext {
  fsm: WorkflowFsm;
  commBus: CommBus;
  runtime: AgentRuntime;
  contextManager: ContextManager;
  hookPipeline: HookPipeline;
  stateTracker: StateTracker;
  activityLogger: ActivityLogger;
  workspace: string;
  swarmDir: string;
  planContent?: string;
  loopConfig: LoopSwarmConfig;
  signal: AbortSignal;
}

interface PhaseEnterResult {
  agents: AgentHandle[];
  channels: CommChannel[];
  /** Human 应该看到的初始消息 */
  initialUIMessage?: string;
}
```

### 8.2 ScriptBehavior 示例

```typescript
class ScriptBehavior implements PhaseBehavior {
  readonly phase = "script";

  async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
    // 1. 创建 Human ↔ Planner 的直接通道
    const channel = ctx.commBus.directChannel("human", "planner");

    // 2. 启动 Planner agent — 统一接口
    const [planner] = await ctx.runtime.spawn([{
      id: "planner",
      role: "planner",
      roleSource: "library",
      task: ctx.planContent ?? ctx.initialTask,
      modelPreference: "smartest",
    }]);

    // 3. ContextPipeline 在 spawn 内部自动构建:
    //    RoleSource → ProfileSource → ExperienceSource → TurnGuidanceSource
    //    TurnGuidanceSource 自动检测 turn=1 → 注入 "ask clarifying questions only"

    // 4. Planner 的第一条消息通过 CommBus 自动 relay 到 Human UI
    //    (AgentHandle.outputStream() → CommBus.pushToUI())

    // 5. Human 的回复自动路由到 handleHumanMessage()

    return { agents: [planner], channels: [channel] };
  }

  async handleHumanMessage(msg: CommEnvelope): Promise<void> {
    // HookPipeline 自动触发 "comm:beforeMessage" → 所有 hook 执行
    // 消息通过 CommBus.directChannel 自动投递给 Planner
    // ContextManager 在下一轮 Planner Turn 时自动更新 turn-guidance
  }

  async checkCompletion(): Promise<PhaseCompletion | null> {
    // Planner 的输出中包含 "plan is complete" 信号
    // → 返回 completion，FSM 自动 transition 到 script-confirm
  }
}
```

### 8.3 StageBehavior 示例

```typescript
class StageBehavior implements PhaseBehavior {
  readonly phase = "stage";

  async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
    // 1. 创建 swarm 通道
    const swarmChannel = ctx.commBus.groupChannel("swarm",
      ["human", "agent-1", "agent-2", "agent-3"]);

    // 2. Role roundtable (如果配置启用)
    if (ctx.loopConfig.roundtable?.enabled) {
      await swarmChannel.roundtable("assign roles", { rounds: 2 });
    }

    // 3. 解析 task DAG → 分配给 agent
    const taskAssignments = this.parseAndAssignTasks(ctx.planContent);

    // 4. 启动所有 agent — 统一接口
    const agents = await ctx.runtime.spawn(taskAssignments.map(t => ({
      id: t.agentId,
      role: t.role,
      roleSource: "library",
      task: t.taskDescription,
    })));

    // 5. ContextPipeline 在 spawn 内部自动构建，包含:
    //    Role → Profile → Stigmergy → Offload (MMD) → Mnemopi → TaskQueue

    return { agents, channels: [swarmChannel] };
  }

  async handleHumanMessage(msg: CommEnvelope): Promise<void> {
    // Human 的 steering 消息通过 swarm 通道广播
    // type: "steering" — agent 在下一个 step boundary 收到
    await ctx.commBus.groupChannel("swarm").send("human", msg.body, { type: "steering" });
  }

  async handleAgentEvent(event: AgentEvent): Promise<void> {
    // Agent 完成任务 → HookPipeline 自动触发 offload/profile/stigmergy
    // Agent 发现冲突 → 通过 swarmChannel 发起协商 roundtable
    // Agent 请求投票 → 通过 swarmChannel.vote()
  }

  async checkCompletion(): Promise<PhaseCompletion | null> {
    // 所有 task status → completed → 返回 completion
    // FSM 自动 transition 到 curtain
  }
}
```

### 8.4 CurtainBehavior 示例

```typescript
class CurtainBehavior implements PhaseBehavior {
  readonly phase = "curtain";

  async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
    // 1. 创建选举通道 → Reporter 选举
    const voteChannel = ctx.commBus.groupChannel("election", agentIds);
    const { winner } = await voteChannel.vote("elect reporter", agentIds, 15000);

    // 2. 并行启动 Reporter + Reflector
    const agents = await ctx.runtime.spawn([
      { id: winner, role: "reporter", roleSource: "library", task: this.buildReportTask() },
      { id: "reflector", role: "reflector", roleSource: "library", task: this.buildReflectTask() },
    ]);

    // 3. HookPipeline 在后台:
    //    - Offload Hook: L1→L3 final flush + ExperienceStore 桥接
    //    - Profile Hook: 更新所有 agent 的 credit
    //    - Verification Hook: 运行确定性验证命令

    return { agents, channels: [voteChannel] };
  }

  async checkCompletion(): Promise<PhaseCompletion | null> {
    // Reporter 完成 + Reflector 完成 → 返回 completion
    // → 等待 Human Applaud → FSM transition 到 idle
  }
}
```

---

## 9. 完整生命周期全景

### 9.1 一个 Loop Run 的完整时序

```
Human: "/loopeng 实现用户认证系统"
│
├─ WorkflowFsm.transition("idle" → "script")
│   ├─ HookPipeline.trigger("workflow:beforePhase", { from: "idle", to: "script" })
│   ├─ CommBus.setPhaseCapabilities({ humanMode: "dialogue", multiAgent: false })
│   ├─ PhaseDefinition["script"].onEnter()
│   └─ HookPipeline.trigger("workflow:afterPhase", { from: "idle", to: "script" })
│
├─ ScriptBehavior.enter()
│   ├─ CommBus.directChannel("human", "planner")
│   └─ AgentRuntime.spawn([plannerSpec])
│       ├─ HookPipeline.trigger("agent:beforeSpawn")  → Profile + Mnemopi 注入
│       ├─ ContextManager.assemble(spec, "script", base)
│       │   ├─ RoleSource.build()       → "You are a Planner..."
│       │   ├─ ProfileSource.build()    → "Your past work:..."
│       │   ├─ ExperienceSource.build() → "Relevant past lessons:..."
│       │   └─ TurnGuidanceSource.build() → "First turn: ASK questions only"
│       ├─ HookPipeline.trigger("agent:beforeLaunch")
│       └─ AgentLauncher.launch()
│           └─ AgentHandle → outputStream() → CommBus.pushToUI()
│
├─ Human 看到 Planner 的提问 → 回答
│   └─ CommBus.receiveFromHuman(text, "planner")
│       ├─ HookPipeline.trigger("comm:beforeMessage")
│       ├─ AgentHandle.send(text) → Planner 下一轮 Turn
│       │   └─ ContextManager → TurnGuidanceSource: "Continue confirming..."
│       └─ HookPipeline.trigger("comm:afterMessage")
│
├─ ...多轮苏格拉底式对话...
│   ├─ 每轮 Planner 产出后:
│   │   └─ HookPipeline.trigger("agent:afterComplete")
│   │       ├─ [pri=0] Profile Hook
│   │       └─ [pri=2] Offload Hook → L1 summarize Planner 对话
│   │
│   └─ Planner 发出 "plan is complete"
│       └─ ScriptBehavior.checkCompletion() → { nextPhase: "script-confirm" }
│
├─ Human 点 "Run Debate"
│   └─ WorkflowFsm.transition("script-confirm" → "script-debate")
│       ├─ CommBus.setPhaseCapabilities({ humanMode: "observer", multiAgent: true })
│       └─ HookPipeline.trigger("workflow:beforePhase")
│           └─ [pri=5] Verification Hook → (不适用，phase=script-debate)
│
│   └─ ScriptDebateBehavior.enter() (作为 ScriptBehavior 的子 behavior)
│       ├─ CommBus.groupChannel("debate", ["debater-1", "debater-2", "human"])
│       └─ channel.roundtable("critique plan", { rounds: 3 })
│           ├─ 每轮 Round:
│           │   ├─ HookPipeline.trigger("roundtable:beforeRound")
│           │   ├─ AgentRuntime.spawnRoundtable() → agent 并行产出
│           │   ├─ HookPipeline.trigger("roundtable:afterRound")
│           │   │   └─ [pri=2] Offload Hook → L1 summarize debate findings
│           │   └─ Jaccard 收敛检测
│           └─ 写入 refined plan.md
│
├─ Human 点 "Confirm & Start"
│   └─ WorkflowFsm.transition("script-confirm" → "stage")
│       ├─ CommBus.setPhaseCapabilities({ humanMode: "observer", multiAgent: true })
│       └─ HookPipeline.trigger("workflow:beforePhase")
│
├─ StageBehavior.enter()
│   ├─ CommBus.groupChannel("swarm", ["human", "agent-1", "agent-2", "agent-3"])
│   ├─ channel.roundtable("assign roles", { rounds: 2 })
│   │   └─ HookPipeline.trigger("roundtable:converged")
│   ├─ AgentRuntime.spawn([workerSpec1, workerSpec2, reviewerSpec])
│   │   └─ ContextManager.assemble() → Role + Profile + Stigmergy + Offload(MMD) + Mnemopi + TaskQueue
│   │
│   ├─ Agent-1 完成任务
│   │   └─ HookPipeline.trigger("agent:afterComplete")
│   │       ├─ [pri=0] Profile Hook → recordTaskCompleted
│   │       ├─ [pri=1] Stigmergy Hook → placeMark("artifact")
│   │       ├─ [pri=2] Offload Hook → L1 summarize → store
│   │       │   └─ if (pendingCount >= l1TriggerThreshold)
│   │       │       → L1.5 Dedup → L2 Attribution → L3 MermaidSynthesizer
│   │       ├─ [pri=3] Mnemopi Hook → rememberIfHighScore
│   │       └─ [pri=4] Experience Hook → bridgeToExperienceStore
│   │
│   ├─ Human 发送 steering: "请关注安全问题"
│   │   └─ HookPipeline.trigger("comm:beforeBroadcast")
│   │       └─ swarmChannel.send("human", msg, { type: "steering" }) → 所有 agent
│   │
│   ├─ Agent-2 和 Agent-3 产生文件冲突
│   │   └─ swarmChannel.roundtable("resolve conflict on auth.ts")
│   │       └─ HookPipeline.trigger("roundtable:converged")
│   │
│   ├─ 所有 tasks 完成
│   │   └─ StageBehavior.checkCompletion() → { nextPhase: "curtain" }
│   │
│   └─ WorkflowFsm.transition("stage" → "curtain")
│       └─ HookPipeline.trigger("workflow:beforePhase")
│           ├─ [pri=2] Offload Hook → forceFlush → 最终 L1→L3
│           ├─ [pri=4] Experience Hook → bridgeSessionSummary
│           └─ [pri=5] Verification Hook → run tests/lint/typecheck
│
├─ CurtainBehavior.enter()
│   ├─ CommBus.groupChannel("election", agentIds)
│   │   └─ channel.vote("elect reporter") → winner
│   │       └─ HookPipeline.trigger("vote:result")
│   ├─ AgentRuntime.spawn([reporterSpec, reflectorSpec])
│   │   ├─ Reporter → CommBus.pushToUI() → Human 看到总结
│   │   ├─ Reflector → DeepReflection (LLM) → ExperienceStore
│   │   └─ HookPipeline.trigger("agent:afterComplete")
│   │       └─ [pri=4] Experience Hook → decayUnreferenced()
│   │
│   └─ CurtainBehavior.checkCompletion() → { nextPhase: "idle", needApplaud: true }
│
├─ Human Applaud
│   └─ WorkflowFsm.transition("curtain" → "idle")
│       └─ HookPipeline.trigger("workflow:afterPhase")
│           ├─ [pri=0] Profile Hook → recordCollaboration
│           └─ [pri=4] Experience Hook → archivePlan
│
└─ ✅ Loop Run 完成
```

### 9.2 Offload 数据流详解

```
Agent 产出
  │
  ▼
L1: Summarize ──────────────────────────────────────────────────────────────
  │ 策略: 文本截断 (≤200 字符) / LLM 压缩 (>500 字符或 JSON)
  │ 输入: AgentResult.output / AgentMessage[]
  │ 输出: OffloadEntry { agentId, summary, score, taskCall, turnIndex }
  │
  ├──→ SwarmOffloadStore.appendEntry(agentId, entry)
  │      → {swarmDir}/.omp/offload/{agentId}.jsonl
  │
  ├──→ OffloadPipeline.#pendingL1.push(entry)
  │      │
  │      ├── 触发条件 1: pendingCount >= l1TriggerThreshold
  │      ├── 触发条件 2: secondsSinceLastL2 >= l2TimeoutSeconds
  │      └── 触发条件 3: Phase 结束 forceFlush
  │           │
  │           ▼
  └──→ L1.5: Deduplicate ──────────────────────────────────────────────────
         │ 策略: Jaccard 相似度 (阈值 0.7)
         │ 输入: 本次 L1 entries + 上次 dedup 后的 entries
         │ 输出: { kept, removed, boundary }
         │
         ▼
       L2: Attribute ───────────────────────────────────────────────────────
         │ 策略: 将 kept entries 归因到 plan.md 的 phase
         │ 输入: L1 entries + PlanPhase[] (从 plan.md 解析)
         │ 输出: { nodes, edges, entryNodeMap }
         │
         ├──→ 更新 SwarmOffloadStore (填充 phase_id, node_id)
         │
         ▼
       L3: Mermaid Synthesize ─────────────────────────────────────────────
         │ 策略: 将归因后的 nodes/edges 渲染为 Mermaid 图
         │ 输出: Mermaid 文本 → currentMmd
         │
         ├──→ MmdInjector.buildFullView()    → beforeIteration 注入
         ├──→ MmdInjector.buildWorkerView()  → beforeAgentRound 注入
         ├──→ MmdInjector.buildClonerView()  → beforeReview 注入
         │
         └──→ ExperienceStore 桥接
                │ 将 L1 entries 蒸馏为 ExtractedLesson
                │ → ExperienceStore.saveLesson()
                │ → SQLite (lessons table + FTS5 index)
                │ → jsonl (lessons.jsonl)
                │
                Session 结束时:
                ├── bridgeSessionSummary → 整体摘要写入
                └── decayUnreferenced → 未引用的 lesson 权重衰减 × 0.9
```

---

## 10. 迁移路径

### Phase 1: 建立抽象层（不破坏现有功能）

```
1. 创建 WorkflowFsm
   - 定义 PhaseDefinition + PhaseCapabilities 类型
   - 实现 transition() + onChange()
   - 现有 SwarmStateMachine 内部委托给 WorkflowFsm

2. 创建 AgentRuntime
   - RoleProvider 封装 roleAssetManager
   - ContextPipeline 封装现有的内联 prompt 构建
   - AgentLauncher 封装 streamAgentOutput / AgentExecutor
   - ScriptManager/StageController/CurtainRunner 内部切换

3. 创建 CommBus
   - CommEndpoint + CommChannel 封装 IrcBus + AgentChannel + ActivityLogger
   - Human endpoint 对接 SSE 推送
   - 现有代码通过 CommBus 发送消息

4. 创建 HookPipeline
   - 定义 HookEvent + HookRegistration
   - 将现有 PipelineHooks/OffloadHooks/SwarmHooks/MnemopiAdapter
     注册为 HookPipeline 的 hook
   - 现有触发点改为 HookPipeline.trigger()
```

### Phase 2: 提取 PhaseBehavior

```
5. 提取 ScriptBehavior / StageBehavior / CurtainBehavior
   - 每个实现 PhaseBehavior 接口
   - 内部使用 AgentRuntime + CommBus + HookPipeline
   - ScriptManager/StageController/CurtainRunner 变为薄壳
```

### Phase 3: 统一上下文管理

```
6. 提取 ContextManager
   - ContextPipeline 管道化所有 ContextSource
   - OffloadManager 统一 L1→L3 流水线
   - ContextCompactor 集成到 beforeAgentLaunch hook

7. 统一持久化
   - StateTracker 作为所有状态变更的唯一 sink
   - Offload + Experience + ActivityLog 都通过 StateTracker 背后的持久化层写入
```

### Phase 4: 前端适配

```
8. Swarm GUI 基于 WorkflowState 渲染
   - 不再 infer phase，直接消费 FSM state
   - Human 消息统一入口 CommBus.receiveFromHuman()

9. Collab 集成
   - Guest 作为一个 CommEndpoint(kind="human")
   - 能力由 PhaseCapabilities.humanMode 控制
```

---

## 11. 文件结构

```
packages/coding-agent/src/swarm/
├── core/
│   ├── workflow-fsm.ts            # WorkflowFsm + PhaseDefinition + PhaseCapabilities
│   ├── state.ts                    # StateTracker (保留, 作为 WorkflowFsm 的投影)
│   ├── schema.ts                   # (不变)
│   ├── pipeline.ts                 # PipelineController (保留, Stage sub-system)
│   └── convergence.ts             # (保留)
│
├── agent-runtime/                  # NEW — Layer 1
│   ├── index.ts                    # AgentRuntime
│   ├── agent-spec.ts               # AgentSpec 类型
│   ├── role-provider.ts            # RoleProvider → 封装 roleAssetManager
│   ├── agent-launcher.ts           # AgentLauncher → 封装 spawn 策略
│   └── agent-handle.ts             # AgentHandle 实现
│
├── comm-bus/                       # NEW — Layer 2
│   ├── index.ts                    # CommBus
│   ├── endpoint.ts                 # CommEndpoint
│   ├── channel.ts                  # CommChannel (direct/group/broadcast)
│   ├── roundtable.ts               # roundtable() 实现
│   ├── vote.ts                     # vote() 实现
│   └── transport.ts                # 底层 IrcBus + SSE 适配
│
├── context-manager/                # NEW — Layer 3
│   ├── index.ts                    # ContextManager 统一入口
│   ├── context-pipeline.ts         # ContextPipeline + ContextSource 接口
│   ├── offload-manager.ts          # OffloadManager → 统一 L1→L3
│   ├── context-compactor.ts        # ContextCompactor → 压缩策略
│   └── sources/                    # 内置 ContextSource 实现
│       ├── role-source.ts
│       ├── profile-source.ts
│       ├── experience-source.ts
│       ├── turn-guidance-source.ts
│       ├── stigmergy-source.ts
│       ├── offload-source.ts
│       ├── mnemopi-source.ts
│       └── task-queue-source.ts
│
├── hook-system/                    # NEW — Layer 4
│   ├── index.ts                    # HookPipeline
│   ├── types.ts                    # HookEvent, HookRegistration, HookPayload
│   └── builtins/                   # 内置 Hook 实现
│       ├── profile-hook.ts
│       ├── stigmergy-hook.ts
│       ├── offload-hook.ts
│       ├── mnemopi-hook.ts
│       ├── experience-hook.ts
│       └── verification-hook.ts
│
├── behaviors/                      # NEW — Layer 5
│   ├── index.ts                    # PhaseBehavior 接口 + PhaseContext
│   ├── script-behavior.ts
│   ├── stage-behavior.ts
│   └── curtain-behavior.ts
│
├── offload/                        # (保留, 作为 context-manager/offload-manager 的子模块)
│   ├── worker-summarizer.ts        # L1 Summarizer
│   ├── agent-offload-summarizer.ts # 通用 Agent 摘要
│   ├── deduplicator.ts            # L1.5 Dedup
│   ├── plan-node-attributor.ts    # L2 Attribution
│   ├── mermaid-synthesizer.ts     # L3 Mermaid
│   ├── mmd-injector.ts            # MMD 注入
│   ├── offload-store.ts           # SwarmOffloadStore
│   └── offload-paths.ts           # 路径工具
│
├── channel/                        # (保留, AgentChannel → 基于 CommBus 重写)
├── script/                         # (逐步废弃 → behaviors/script-behavior.ts)
├── stage/                          # (逐步废弃 → behaviors/stage-behavior.ts)
├── curtain/                        # (保留经验存储逻辑, 执行逻辑 → behaviors/curtain-behavior.ts)
├── coordination/                   # (保留: MarkEnvironment, RegionLock, FileTracker)
├── hooks/                          # (保留: ActivityLogger, 但 hook 逻辑 → hook-system/)
├── monitor/                        # (保留: SSE 服务器, API routes)
└── session/                        # (保留: SessionRegistry, SwarmSessionManager)
```

---

## 12. 关键收益总结

| 维度 | 当前 | 统一后 |
|------|------|--------|
| **状态管理** | 4 处独立 phase 追踪 | 1 个 WorkflowFsm，声明式注册 |
| **Agent 启动** | 3 种模式 | 1 个 AgentRuntime.spawn() |
| **通信** | Human 在 3 个 phase 有 3 种角色 | 对等的 CommEndpoint，humanMode 控制能力 |
| **上下文注入** | 6 种来源，4 处注入 | ContextPipeline，priority 排序的 source 管道 |
| **Offload** | 仅 Stage 有 | 所有 phase 可配置 offload 级别 |
| **Hook** | 4 套独立系统 | 1 个 HookPipeline，按 priority 组合 |
| **上下文压缩** | 不存在 | ContextCompactor，3 种压缩策略 |
| **Phase 能力** | 隐式（hardcode） | PhaseCapabilities 声明式 |
| **可测试性** | 每个组件需 mock 多个依赖 | 每层独立可测，Hook 可单独注册测试 |
| **可扩展性** | 新增 phase 需修改多处 | 注册 PhaseDefinition + PhaseBehavior 即可 |
