# SatoPi Swarm 统一架构重构方案

> 设计日期: 2026-07-25
> 核心目标: 在复用 satopi 基础设施的前提下，统一 Script/Stage/Curtain 三阶段的共性抽象

---

## 目录

1. [satopi 基础设施全景](#1-satopi-基础设施全景)
2. [当前架构问题诊断](#2-当前架构问题诊断)
3. [设计原则：复用而非重写](#3-设计原则复用而非重写)
4. [统一后的架构分层](#4-统一后的架构分层)
5. [Layer 0: WorkflowFSM — 统一状态机](#5-layer-0-workflowfsm)
6. [Layer 1: AgentRuntime — 统一 Agent 运行时](#6-layer-1-agentruntime)
7. [Layer 2: CommBus — 统一通信层](#7-layer-2-commbus)
8. [Layer 3: ContextManager — 统一上下文管理](#8-layer-3-contextmanager)
9. [Layer 4: HookPipeline — 统一生命周期 Hook](#9-layer-4-hookpipeline)
10. [Layer 5: PhaseBehavior — 统一阶段行为](#10-layer-5-phasebehavior)
11. [完整生命周期流程](#11-完整生命周期流程)
12. [文件结构规划](#12-文件结构规划)
13. [迁移路径](#13-迁移路径)

---

## 1. satopi 基础设施全景

### 1.1 包依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│  SatoPi Swarm Layer (packages/coding-agent/src/swarm/)     │
│  Multi-agent orchestration: Script / Stage / Curtain        │
└──────────────────────────┬──────────────────────────────────┘
                           │ depends on
┌──────────────────────────┼──────────────────────────────────┐
│  satopi Coding Agent (packages/coding-agent/src/)        │
│  AgentSession, AgentRegistry, IrcBus, ModelRegistry,       │
│  SessionStorage, EventBus, Task Executor, Tools             │
└──────────────────────────┬──────────────────────────────────┘
                           │ depends on
┌──────────────────────────┼──────────────────────────────────┐
│  satopi Agent Core (packages/agent/)                     │
│  Agent class, agentLoop, AgentTool, AgentToolContext,      │
│  AgentMessage, Compaction, Thinking, Telemetry              │
└──────────────────────────┬──────────────────────────────────┘
                           │ depends on
┌──────────────────────────┼──────────────────────────────────┐
│  satopi AI (packages/ai/)                                │
│  streamSimple, Model, Message, Provider, Auth, Streaming   │
└──────────────────────────┴──────────────────────────────────┘

Cross-cutting:
  pi-catalog   — Model catalog (bundled models, provider descriptors)
  pi-utils     — logger, Snowflake, prompt, escapeXml
  pi-natives   — Rust N-API addons (grep, text, shell, PTY)
  snapcompact  — Context compaction engine
```

### 1.2 关键基础设施清单

| 层级 | 组件 | 职责 |
|------|------|------|
| **LLM** | `streamSimple` / `completeSimple` | 流式/非流式 LLM 调用 |
| | `Model`, `ApiKey`, `Message` | 模型和消息类型 |
| **Agent Core** | `Agent` class + `agentLoop()` | 核心 agent loop |
| | `AgentTool`, `AgentToolContext` | 工具接口 + 上下文扩展 |
| | `AgentMessage`, `AgentState` | Agent 消息/状态类型 |
| | `AgentLoopConfig` | loop 配置：`transformContext`, `getSteeringMessages`, `getAsideMessages`, `getFollowUpMessages` |
| | `compact()`, `shouldCompact()` | 上下文压缩 |
| **Coding Agent** | `AgentSession` | Agent 生命周期管理：持久化、压缩、bash、model switching |
| | `AgentRegistry` | 进程全局 agent 注册表（main + subagents） |
| | `AgentLifecycleManager` | park / revive agent |
| | `IrcBus` | 进程内全局 mailbox 总线：`send`, `wait`, `collectResponses` |
| | `ModelRegistry` + `Settings` | 模型注册 + API key + 全局配置 |
| | `AgentDefinition`, `SingleResult` | 任务类型定义 |
| | `EventBus` | pub/sub 事件总线 |
| | `SessionStorage` | 存储抽象（文件/SQL/Redis） |
| | `streamAgentOutput` | 启动 agent + 获取流式输出 |
| | `ActivityLogger` | 事件日志 → SSE + session.jsonl |
| | `StateTracker` | 内存状态追踪 → session.jsonl |

### 1.3 satopi 已经提供的能力

```
✅ Agent 生命周期管理    → Agent + AgentSession + AgentLifecycleManager
✅ Agent 间消息传递      → IrcBus (mailbox, send, wait, collectResponses)
✅ Agent 注册与发现      → AgentRegistry (global, register, listVisibleTo)
✅ 上下文管理           → AppendOnlyContextManager
✅ 上下文压缩           → compact() / shouldCompact() / prepareCompaction()
✅ Steering / Aside 消息 → AgentLoopConfig.getSteeringMessages / getAsideMessages
✅ 多轮对话             → AgentLoopConfig.getFollowUpMessages
✅ 模型选择与 API key   → ModelRegistry + Settings + model-resolver
✅ 工具系统             → AgentTool + AgentToolContext
✅ LLM 流式调用         → streamSimple / completeSimple
✅ Session 持久化       → SessionManager + SessionStorage
✅ 事件广播             → EventBus + ActivityLogger → SSE
```

---

## 2. 当前架构问题诊断

### 2.1 现状：三套独立的"状态机 + Agent + 通信 + 上下文"

```
ScriptManager          StageController         CurtainRunner
─────────────────────  ─────────────────────   ──────────────────
#phase (自管)          SwarmStateMachine       纯函数，无状态机
#busy (自管)           StateTracker
#conversation (自管)

Agent 启动:            Agent 启动:              Agent 启动:
streamAgentOutput()    AgentExecutor            streamAgentOutput()
内联 prompt 拼装       TaskQueue while loop     内联 prompt

通信:                  通信:                    通信:
Human↔Planner (SSE)    Agent↔Agent (IRC)        Agent↔Agent (IRC)
                       Human 观察 (relay)       Reporter 选举 (IRC)

角色注入:              角色注入:                角色注入:
resolvePlannerRole()   roleAssetMgr.get()       roleAssetMgr.get()
(硬编码 "planner")     (task.assignedRole)      (硬编码 name)

上下文:                上下文:                  上下文:
内联拼装               profileRegistry          几乎无
+ 回合感知             + stigmergyCtx
```

### 2.2 五大分散问题

| 问题 | 表现 | 根因 |
|------|------|------|
| **状态机分散** | `SwarmStateMachine` 仅在 Stage 使用；Script 自管 `#phase`/`#busy`；Curtain 无状态机 | 无统一的 Workflow 级别状态抽象 |
| **Agent 启动分散** | 三种启动方式：`streamAgentOutput` vs `AgentExecutor` vs `runSubprocess` | 无统一的 Agent Runtime |
| **通信分散** | Script: Human↔Planner 走 SSE+conversation；Stage: Agent↔Agent 走 IRC+AgentChannel；Curtain: 二者混用 | Human 和 Agent 不对等 |
| **角色注入分散** | 三处各自调用 `roleAssetManager.get()` + 各自 fallback | 无统一的 RoleProvider |
| **上下文构建分散** | Profile、Stigmergy、Experience、TurnGuidance、MMD、Mnemopi — 6 种来源，4 处注入 | 无 ContextPipeline |

### 2.3 satopi 能力未被充分利用

```
satopi 能力             当前 SatoPi 使用情况
────────────────────────  ────────────────────
AgentLoopConfig.transformContext    ✗ 未用（内联拼装 prompt）
AgentLoopConfig.getSteeringMessages ✗ 未用（手动调用 interrupt）
AgentLoopConfig.getAsideMessages    ✗ 未用
AgentLoopConfig.getFollowUpMessages ✗ 未用（Script 自建 #conversation）
IrcBus.wait()                       ✗ 未用（仅 RoleRoundtable 用）
IrcBus.collectResponses()           部分使用
compact() / shouldCompact()        ✗ 未用（snapcompact 独立调用）
```

---

## 3. 设计原则：复用而非重写

### 3.1 核心原则

1. **`Agent` + `AgentSession` 是单个 Agent 的原子单元。** SatoPi 不重新实现 agent loop，而是编排多个 Agent 实例。

2. **`IrcBus` 已经是完整的 mailbox 总线。** `CommBus` 是薄封装，增加 Human endpoint 和高级通信模式（roundtable/vote），不替换底层传输。

3. **`AgentLoopConfig` 已提供注入点。** 上下文注入通过 `transformContext` 实现；steering 通过 `getSteeringMessages` 实现；aside 通过 `getAsideMessages` 实现；多轮对话通过 `getFollowUpMessages` 实现。

4. **`compact()` + `snapcompact` 已是成熟方案。** ContextCompactor 是对现有压缩策略的封装，按 Phase 选择策略。

5. **satopi 类型不做修改。** `AgentDefinition`, `SingleResult`, `AgentMessage`, `AgentToolContext` 保持不变。

### 3.2 新增 vs 复用的边界

```
┌──────────────────────────────────────────────────────────────┐
│                      SatoPi 新增                              │
│                                                              │
│  WorkflowFsm         — 多 Phase 编排                          │
│  PhaseBehavior       — 每个 Phase 的行为定义                   │
│  HookPipeline        — 跨 Phase 的 Hook 编排                  │
│  ContextPipeline     — 上下文注入的管道化编排                   │
│  OffloadManager      — L1→L3 摘要流水线                        │
│  CommChannel         — roundtable / vote 等高级通信模式        │
│  AgentRuntime        — 多 Agent 并发 spawn 的编排器            │
│                                                              │
│  ═══════════════════════════════════════════════════════════  │
│                                                              │
│                      复用 satopi                             │
│                                                              │
│  Agent + AgentSession   — 单个 Agent 的执行                    │
│  IrcBus                 — 底层消息传输                         │
│  AgentRegistry          — Agent 注册与发现                     │
│  AgentLifecycleManager  — park / revive                       │
│  AgentLoopConfig        — transformContext / steering / aside │
│  compact()              — 上下文压缩                           │
│  ModelRegistry          — 模型管理                             │
│  Settings               — 配置管理                             │
│  SessionStorage         — 持久化                               │
│  EventBus               — 事件广播                             │
│  ActivityLogger         — 事件日志 → SSE                       │
│  StateTracker           — 状态追踪                             │
│  AgentToolContext       — 工具上下文                           │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. 统一后的架构分层

### 4.1 总览

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Layer 5: PhaseBehavior  (SatoPi 新增)                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                │
│  │ Script     │  │ Stage      │  │ Curtain    │                │
│  │ Behavior   │  │ Behavior   │  │ Behavior   │                │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘                │
│        └───────────────┼───────────────┘                        │
│                        │                                        │
│  ┌─────────────────────┼─────────────────────────────────────┐  │
│  │ Layer 4: HookPipeline  (SatoPi 新增)                       │  │
│  │  统一 4 套独立 hook 为 priority 排序的管道                    │  │
│  └─────────────────────┼─────────────────────────────────────┘  │
│                        │                                        │
│  ┌─────────────────────┼─────────────────────────────────────┐  │
│  │ Layer 3: ContextManager  (SatoPi 新增)                     │  │
│  │  ContextPipeline (注入) + OffloadManager (产出)             │  │
│  │  + ContextCompactor (压缩)                                  │  │
│  └─────────────────────┼─────────────────────────────────────┘  │
│                        │                                        │
│  ┌─────────────────────┼─────────────────────────────────────┐  │
│  │ Layer 2: CommBus  (SatoPi 新增，基于 IrcBus)               │  │
│  │  CommEndpoint (Human=Agent 对等) + CommChannel              │  │
│  │  (direct / group / broadcast / roundtable / vote)          │  │
│  └─────────────────────┼─────────────────────────────────────┘  │
│                        │                                        │
│  ┌─────────────────────┼─────────────────────────────────────┐  │
│  │ Layer 1: AgentRuntime  (SatoPi 新增，基于 AgentSession)    │  │
│  │  AgentSpec → RoleProvider → ContextPipeline                │  │
│  │  → AgentLoopConfig 组装 → AgentLauncher → AgentHandle     │  │
│  └─────────────────────┼─────────────────────────────────────┘  │
│                        │                                        │
│  ┌─────────────────────┼─────────────────────────────────────┐  │
│  │ Layer 0: WorkflowFSM  (SatoPi 新增，基于 StateTracker)     │  │
│  │  PhaseDefinition 声明式注册 + guarded transition           │  │
│  └─────────────────────┼─────────────────────────────────────┘  │
│                        │                                        │
│  ══════════════════════╪══════════════════════════════════════ │
│                        │                                        │
│  ┌─────────────────────┼─────────────────────────────────────┐  │
│  │ satopi Platform (不改动)                                 │  │
│  │                                                           │  │
│  │  Agent + AgentSession    IrcBus + AgentRegistry           │  │
│  │  AgentLoopConfig         compact() + snapcompact          │  │
│  │  ModelRegistry + Settings  SessionStorage + EventBus      │  │
│  │  ActivityLogger + StateTracker                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 核心数据流

```
PhaseBehavior.enter()
  │
  ├─ 1. WorkflowFsm.transition(phase)
  │      └→ StateTracker.updatePipeline({ phase })            // 复用
  │      └→ ActivityLogger.logPhase(phase)                     // 复用
  │
  ├─ 2. HookPipeline.trigger("workflow:beforePhase")
  │      └→ 各 Hook 按 priority 执行
  │
  ├─ 3. 创建 CommChannel (基于 IrcBus)
  │      └→ 薄封装: send → ircBus.send()
  │                roundtable → ircBus.collectResponses() 循环
  │                vote → ircBus.collectResponses() + tally
  │
  ├─ 4. AgentRuntime.spawn(agentSpecs)
  │      │
  │      ├─ 4a. ContextPipeline.assemble(spec, phase)
  │      │       └→ 管道式应用 ContextSource[]
  │      │       └→ 产出 AgentLoopConfig.transformContext 的实现
  │      │
  │      ├─ 4b. AgentLoopConfig 组装
  │      │       └→ transformContext: 上下文注入
  │      │       └→ getSteeringMessages: CommBus 中的 Human 消息
  │      │       └→ getAsideMessages: 系统通知
  │      │       └→ getFollowUpMessages: 多轮对话
  │      │       └→ getApiKey: modelRegistry.resolver() (透传)
  │      │
  │      └─ 4c. 创建 Agent 实例 (satopi)
  │             └→ agent = new Agent({ ...agentLoopConfig })
  │             └→ AgentHandle 包装
  │
  ├─ 5. Agent 完成后
  │      └→ HookPipeline.trigger("agent:afterComplete")
  │          ├─ Offload Hook: L1 summarize → SwarmOffloadStore
  │          └─ Profile Hook: recordTaskCompleted
  │
  └─ 6. checkCompletion() → FSM transition 到下一 phase
```

---

## 5. Layer 0: WorkflowFSM

### 5.1 设计目标

将当前 4 处独立的 phase 追踪统一为一个 WorkflowFSM。

### 5.2 核心接口

```typescript
// packages/coding-agent/src/swarm/core/workflow-fsm.ts

// 复用现有的 Chapter 类型
import type { Chapter } from "./state";

/** Phase 能力声明 */
interface PhaseCapabilities {
  multiAgent: boolean;       // 是否允许多 agent 并发
  roundtable: boolean;       // 是否支持 roundtable
  vote: boolean;             // 是否支持 vote
  offload: boolean;          // 是否启用 offload
  compaction: boolean;       // 是否启用上下文压缩
  humanMode: "dialogue" | "observer" | "passive" | "none";
}

/** Phase 定义 — 声明式、可测试、可扩展 */
interface PhaseDefinition {
  phase: Chapter;
  allowedFrom: Chapter[];
  allowedTo: Chapter[];
  capabilities: PhaseCapabilities;
  defaultTimeoutMs: number;  // 0 = 无超时
}

/** 统一工作流状态 */
interface WorkflowState {
  phase: Chapter;
  subStatus: string;
  participants: Map<string, ParticipantState>;
  running: boolean;
  iteration: number;
  phaseStartedAt: number;
  capabilities: PhaseCapabilities;
}

class WorkflowFsm {
  readonly state: WorkflowState;

  constructor(
    private stateTracker: StateTracker,        // 复用
    private activityLogger: ActivityLogger,    // 复用
  ) {}

  registerPhase(def: PhaseDefinition): void;

  async transition(to: Chapter): Promise<TransitionResult>;
  async force(to: Chapter): Promise<TransitionResult>;

  onChange(listener: (event: FsmEvent) => void): () => void;

  // Phase 切换时自动通知 CommBus 调整 Human 能力
  bindCommBus(bus: CommBus): void;
}
```

### 5.3 Phase 注册

```typescript
const PHASES: PhaseDefinition[] = [
  {
    phase: "script",
    allowedFrom: ["idle", "curtain"],
    allowedTo: ["script-debate", "script-confirm", "idle"],
    capabilities: {
      multiAgent: false, roundtable: false, vote: false,
      offload: true, compaction: false, humanMode: "dialogue",
    },
    defaultTimeoutMs: 0,
  },
  {
    phase: "script-debate",
    allowedFrom: ["script", "script-confirm"],
    allowedTo: ["script-confirm", "script", "idle"],
    capabilities: {
      multiAgent: true, roundtable: true, vote: false,
      offload: true, compaction: false, humanMode: "observer",
    },
    defaultTimeoutMs: 300_000,
  },
  {
    phase: "stage",
    allowedFrom: ["script-confirm", "paused", "blocked"],
    allowedTo: ["paused", "blocked", "curtain"],
    capabilities: {
      multiAgent: true, roundtable: true, vote: true,
      offload: true, compaction: true, humanMode: "observer",
    },
    defaultTimeoutMs: 0,
  },
  {
    phase: "curtain",
    allowedFrom: ["stage", "paused", "blocked"],
    allowedTo: ["idle", "stage"],
    capabilities: {
      multiAgent: true, roundtable: false, vote: true,
      offload: true, compaction: false, humanMode: "passive",
    },
    defaultTimeoutMs: 120_000,
  },
];
```

### 5.4 替代关系

| 当前代码 | 统一后 |
|---------|--------|
| `swarm-state-machine.ts:101-203` `SwarmStateMachine` | `WorkflowFsm` |
| `script-manager.ts:68-69` `#phase` + `#busy` | `WorkflowFsm.state` |
| `curtain-runner.ts` 函数式无状态 | `WorkflowFsm` → CurtainBehavior |

---

## 6. Layer 1: AgentRuntime

### 6.1 设计目标

替代三种分散的 agent 启动方式，提供统一的声明式接口。

### 6.2 核心接口

```typescript
// packages/coding-agent/src/swarm/agent-runtime/index.ts

import { Agent } from "@satopi/pi-agent-core";              // 复用
import type { AgentLoopConfig } from "@satopi/pi-agent-core"; // 复用
import type { AgentDefinition, SingleResult } from "@satopi/pi-coding-agent"; // 复用
import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";       // 复用

interface AgentSpec {
  id: string;
  role: string;
  roleSource: "library" | "profile" | "inline";
  inline?: { systemPrompt: string; tools: string[] };
  task: string;
  modelPreference?: "cheapest" | "smartest" | "role-default";
}

interface LaunchOptions {
  signal?: AbortSignal;
  keepAlive?: boolean;
  modelOverride?: string;
}

/** 对 satopi Agent 实例的薄包装 */
interface AgentHandle {
  readonly id: string;
  readonly role: string;
  readonly status: "running" | "completed" | "failed" | "aborted";

  wait(): Promise<SingleResult>;
  send(message: string): Promise<void>;
  abort(): void;
  outputStream(): AsyncIterable<string>;
}

class AgentRuntime {
  constructor(
    private modelRegistry: ModelRegistry,      // 复用
    private settings: Settings,                 // 复用
    private contextPipeline: ContextPipeline,   // 新增
    private commBus: CommBus,                   // 新增
    private activityLogger: ActivityLogger,     // 复用
  ) {}

  /** 声明式启动 agent(s) — 所有 Phase 统一入口 */
  async spawn(specs: AgentSpec[], opts?: LaunchOptions): Promise<AgentHandle[]>;

  /** 启动 Roundtable（多 agent 互相通信） */
  async spawnRoundtable(specs: AgentSpec[], config: RoundtableConfig): Promise<RoundtableResult>;
}
```

### 6.3 spawn() 内部流程

```
AgentRuntime.spawn([spec])
  │
  ├─ 1. RoleProvider.resolve(spec.role)
  │     → 查询 role library → fallback 内联 → ResolvedRole
  │
  ├─ 2. HookPipeline.trigger("agent:beforeSpawn")
  │
  ├─ 3. ContextPipeline.assemble(spec, phase, base) → AssembledContext
  │     → 管道式应用 ContextSource[] (priority 排序)
  │     → 产出 AgentLoopConfig.transformContext 实现
  │
  ├─ 4. 组装 AgentLoopConfig (satopi 原生接口):
  │     {
  │       model, tools,
  │       transformContext:       contextPipeline.toTransformContext(assembled),
  │       getSteeringMessages:    () => commBus.pendingHumanMessages(agentId),
  │       getAsideMessages:       () => commBus.pendingSystemNotifications(agentId),
  │       getFollowUpMessages:    () => commBus.pendingFollowUpMessages(agentId),
  │       getApiKey:              (model) => modelRegistry.resolver(model, sessionId),
  │       hasSteeringMessages:    () => commBus.hasPendingHumanMessages(agentId),
  │       hasIrcInterrupts:       () => commBus.hasPendingIrcMessages(agentId),
  │     }
  │
  ├─ 5. AgentLauncher.launch(spec, agentLoopConfig)
  │     → 创建 Agent + AgentSession (satopi)
  │     → 调用 agent.start(task) 或 streamAgentOutput()
  │
  └─ 6. 返回 AgentHandle
```

### 6.4 替代关系

| 当前代码 | 统一后 |
|---------|--------|
| `script-manager.ts:279-345` `#runPlannerAgent()` | `AgentRuntime.spawn([plannerSpec])` |
| `stage-controller.ts:351-441` `#runAgent()` | `AgentRuntime.spawn(workerSpecs)` |
| `curtain-runner.ts:205-269` `runReporterAgent()` | `AgentRuntime.spawn([reporterSpec])` |
| `debate-roundtable.ts:125-153` `Promise.allSettled(runSubprocess)` | `AgentRuntime.spawn(debaterSpecs)` |

---

## 7. Layer 2: CommBus

### 7.1 设计目标

Human 和 Agent 成为对等的通信端点。CommBus 是对 IrcBus + ActivityLogger 的薄封装。

### 7.2 核心接口

```typescript
// packages/coding-agent/src/swarm/comm-bus/index.ts

import { IrcBus } from "@satopi/pi-coding-agent/irc/bus";         // 复用
import { AgentRegistry } from "@satopi/pi-coding-agent/registry";  // 复用
import type { ActivityLogger } from "../hooks/activity-logger";      // 复用

// ── 通信端点 — Human 和 Agent 是同一种东西 ──
interface CommEndpoint {
  readonly id: string;
  readonly kind: "human" | "agent" | "system";
  readonly capabilities: Set<EndpointCapability>;
}
type EndpointCapability = "send" | "receive" | "broadcast" | "interrupt" | "vote" | "roundtable";

// ── 通信通道 ──
interface CommChannel {
  readonly id: string;
  readonly members: ReadonlySet<string>;

  // 基础通信 — 封装 IrcBus.send()
  send(from: string, body: string, opts?: SendOptions): Promise<void>;

  // 高级通信模式 — 封装 IrcBus.collectResponses()
  roundtable(topic: string, config: RoundtableConfig): Promise<RoundtableResult>;
  vote(question: string, candidates: string[], timeoutMs?: number): Promise<VoteResult>;

  subscribe(endpointId: string, handler: (msg: CommEnvelope) => void): () => void;
}

// ── 统一总线 ──
class CommBus {
  readonly human: CommEndpoint;
  readonly system: CommEndpoint;

  constructor(
    private ircBus: IrcBus,                    // 复用
    private registry: AgentRegistry,            // 复用
    private activityLogger: ActivityLogger,     // 复用
  ) {}

  registerAgent(id: string, capabilities?: EndpointCapability[]): CommEndpoint;

  // 通道工厂
  directChannel(a: string, b: string): CommChannel;              // 1:1
  groupChannel(name: string, members: string[]): CommChannel;     // N:N
  broadcastChannel(from: string): CommChannel;                    // 1:N

  // Human 输入入口（替代当前 REST sendMessage/steer）
  receiveFromHuman(text: string, target?: string): Promise<void>;

  // Phase 切换时自动调整 Human 能力
  setPhaseCapabilities(caps: PhaseCapabilities): void;
}
```

### 7.3 通信模式矩阵

| Phase | Human 角色 | Human 能做什么 | Agent 间通信 | 底层传输 |
|-------|-----------|---------------|-------------|---------|
| **script** | dialogue | 与 Planner 1:1 对话 | 无 | `directChannel` → `ircBus.send()` + SSE relay |
| **script-debate** | observer | 观看辩论，不能发言 | roundtable | `groupChannel.roundtable()` → `ircBus.collectResponses()` |
| **stage** | observer | 观看 + steering broadcast | direct + roundtable + vote | `groupChannel` |
| **blocked** | dialogue | 决策交互 | 暂停中 | `WorkflowFsm.waitForHumanDecision()` |
| **curtain** | passive | 接收 reporter 输出 + applaud | vote (选举) | `groupChannel.vote()` + `pushToUI()` |

### 7.4 替代关系

| 当前代码 | 统一后 |
|---------|--------|
| `agent-channel.ts:39-220` `AgentChannel` (broadcast/subGroup/interrupt) | `CommChannel` |
| `role-roundtable.ts:50-210` `RoleRoundtable.negotiateRoles()` | `CommChannel.roundtable()` |
| `reporter-election.ts:53-160` `ReporterElection.elect()` | `CommChannel.vote()` |
| `script-manager.ts:177-193` `sendMessage()` (REST → conversation) | `CommBus.receiveFromHuman()` |
| `irc/bus.ts` — 直接调用 `send()` / `collectResponses()` | 通过 `CommChannel` 间接调用 |

---

## 8. Layer 3: ContextManager

### 8.1 设计目标

将当前 6 种分散的上下文注入统一为 ContextPipeline；将 Offload L1→L3 流水线变为所有 Phase 可用；新增 ContextCompactor。

### 8.2 架构

```
ContextManager
  ├── ContextPipeline (注入方向)
  │     ├── RoleSource         (priority=0, 所有 phase)
  │     ├── ProfileSource      (priority=1, 所有 phase)
  │     ├── ExperienceSource   (priority=2, script/script-debate)
  │     ├── TurnGuidanceSource (priority=3, script only)
  │     ├── StigmergySource    (priority=4, stage only)
  │     ├── OffloadSource      (priority=5, stage/curtain)
  │     ├── MnemopiSource      (priority=6, 所有 phase, 可选)
  │     └── TaskQueueSource    (priority=7, stage only)
  │
  ├── OffloadManager (产出方向)
  │     ├── L1  Summarizer    (文本截断 / LLM 压缩)
  │     ├── L1.5 Deduplicator (Jaccard 去重)
  │     ├── L2  Attributor    (归因到 plan phase)
  │     └── L3  Synthesizer   (Mermaid + 经验蒸馏)
  │
  ├── ContextCompactor (压缩方向)
  │     ├── Strategy: summarize (保留语义)
  │     ├── Strategy: truncate (保留最近)
  │     └── Strategy: offload-to-stigmergy (长摘要→Mark)
  │
  └── ContextStore (存储方向)
        ├── SwarmOffloadStore → {agentId}.jsonl
        ├── ExperienceStore   → SQLite + FTS5
        └── Stigmergy (MarkEnvironment) → 内存 + 序列化
```

### 8.3 ContextPipeline 核心接口

```typescript
// packages/coding-agent/src/swarm/context-manager/context-pipeline.ts

import type { AgentMessage } from "@satopi/pi-agent-core";  // 复用
import type { Chapter } from "../core/state";                   // 复用

interface ContextSource {
  readonly name: string;
  readonly priority: number;

  /** 声明适用于哪些 Phase + Agent 角色组合 */
  appliesTo(phase: Chapter, agentRole: string, capabilities: PhaseCapabilities): boolean;

  /** 构建上下文片段 */
  build(spec: AgentSpec, base: BuildContext): Promise<ContextFragment>;
}

interface ContextFragment {
  systemPromptAddition?: string;
  taskPromptAddition?: string;
  injectedMessages?: AgentMessage[];  // satopi 原生类型
  tools?: string[];
}

class ContextPipeline {
  register(source: ContextSource): void;

  /** 管道式构建，返回可直接注入 AgentLoopConfig 的上下文 */
  async assemble(spec: AgentSpec, phase: Chapter, base: BuildContext): Promise<AssembledContext>;

  /** 转化为 AgentLoopConfig.transformContext — 与 satopi 的集成点 */
  toTransformContext(assembled: AssembledContext): AgentLoopConfig["transformContext"];
}
```

### 8.4 OffloadManager

```typescript
class OffloadManager {
  // 内部持有 OffloadPipeline (复用现有 L1→L3 实现)
  #pipeline: OffloadPipeline;
  #store: SwarmOffloadStore;

  // 每个 Phase 独立的 offload 级别
  configurePhase(phase: Chapter, config: {
    l1TriggerThreshold: number;
    enableL2: boolean;
    enableL3: boolean;
    bridgeToExperience: boolean;
  }): void;

  async summarizeL1(agentId: string, result: SingleResult): Promise<void>;
  shouldFlush(phase: Chapter): boolean;
  async flush(phase: Chapter): Promise<L2L3Result>;

  // 获取上下文供 ContextSource 注入
  getCurrentMmd(): string | null;
  getExperienceContext(agentId: string): string | null;
}
```

### 8.5 Offload 数据流

```
Agent 产出
  │
  ▼
L1: Summarize
  │ 策略: 文本截断 (≤200 字符) / LLM 压缩 (>500 字符或 JSON)
  │ 输入: AgentResult.output / AgentMessage[]
  │ 输出: OffloadEntry
  │
  ├──→ SwarmOffloadStore.appendEntry(agentId, entry)
  │      → {swarmDir}/.omp/offload/{agentId}.jsonl
  │
  ├──→ OffloadPipeline.#pendingL1.push(entry)
  │      │ 触发条件:
  │      │   - pendingCount >= l1TriggerThreshold
  │      │   - secondsSinceLastL2 >= l2TimeoutSeconds
  │      │   - Phase 结束 forceFlush
  │      ▼
  └──→ L1.5: Deduplicate (Jaccard 去重, 阈值 0.7)
         │
         ▼
       L2: Attribute (归因到 plan.md phase)
         │
         ▼
       L3: Mermaid Synthesize
         │  → MmdInjector → 注入 Agent 上下文
         │
         └→ ExperienceStore 桥接
              → ExtractedLesson → SQLite + FTS5
              → Session 结束: bridgeSessionSummary + decayUnreferenced
```

---

## 9. Layer 4: HookPipeline

### 9.1 设计目标

将当前 4 套独立的 hook/callback 系统统一为一个按 priority 排序的 HookPipeline。

### 9.2 核心接口

```typescript
// packages/coding-agent/src/swarm/hook-system/hook-pipeline.ts

type HookEvent =
  // Phase 生命周期
  | "workflow:beforePhase" | "workflow:afterPhase" | "workflow:phaseTimeout"
  // Agent 生命周期
  | "agent:beforeSpawn" | "agent:afterComplete" | "agent:onError"
  // 上下文生命周期
  | "context:beforeInjection" | "context:afterInjection"
  | "context:beforeCompaction" | "context:afterCompaction"
  // Offload 生命周期
  | "offload:afterL1" | "offload:beforeFlush" | "offload:afterFlush"
  // 通信生命周期
  | "comm:beforeMessage" | "comm:afterMessage"
  | "comm:beforeBroadcast" | "comm:afterBroadcast"
  // Roundtable / Vote
  | "roundtable:beforeRound" | "roundtable:afterRound" | "roundtable:converged"
  | "vote:start" | "vote:tally" | "vote:result"
  ;

interface HookRegistration {
  name: string;
  priority: number;          // 数字越小越先执行
  events: HookEvent[];
  phases?: Chapter[];        // 可选: 只在特定 phase 执行

  handler(event: HookEvent, payload: HookPayload, ctx: HookContext): Promise<void>;
}

class HookPipeline {
  register(hook: HookRegistration): void;
  unregister(name: string): void;

  /** 按 priority 排序，过滤 phase，依次执行 */
  async trigger(event: HookEvent, payload: HookPayload, ctx: HookContext): Promise<void>;
}
```

### 9.3 内置 Hook 注册

```typescript
// priority=0: Profile Hook — 最早执行，确保 profile 先更新
{ name: "profile", priority: 0,
  events: ["agent:beforeSpawn", "agent:afterComplete", "workflow:afterPhase"] }

// priority=1: Stigmergy Hook — 环境信号
{ name: "stigmergy", priority: 1,
  events: ["agent:afterComplete", "agent:onError", "context:afterCompaction"] }

// priority=2: Offload Hook — 摘要 + Mermaid
{ name: "offload", priority: 2,
  events: ["agent:afterComplete", "workflow:beforePhase", "roundtable:afterRound"],
  phases: ["script", "script-debate", "stage", "curtain"] }

// priority=3: Mnemopi Hook — 语义记忆召回
{ name: "mnemopi", priority: 3,
  events: ["agent:beforeSpawn", "agent:afterComplete"] }

// priority=4: Experience Hook — 经验蒸馏
{ name: "experience", priority: 4,
  events: ["offload:afterFlush", "workflow:afterPhase"],
  phases: ["stage", "curtain"] }

// priority=5: Verification Hook — 确定性验证
{ name: "verification", priority: 5,
  events: ["workflow:beforePhase"],
  phases: ["curtain"] }
```

### 9.4 Hook 数据流示例

```
Agent 完成一次 Turn
  │
  ├─ HookPipeline.trigger("agent:afterComplete")
  │
  ├─ [pri=0] Profile Hook
  │     → profileRegistry.recordTaskCompleted(agentId, success)
  │
  ├─ [pri=1] Stigmergy Hook
  │     → markEnvironment.placeMark({ type: "artifact", ... })
  │
  ├─ [pri=2] Offload Hook
  │     → OffloadManager.summarizeL1(agentId, result)
  │     → if shouldFlush → flush L1.5→L2→L3
  │
  ├─ [pri=3] Mnemopi Hook
  │     → if score >= threshold → client.remember(summary)
  │
  └─ [pri=4] Experience Hook
        → if offload was flushed → bridgeToExperienceStore()
```

### 9.5 替代关系

| 当前代码 | 统一后 |
|---------|--------|
| `pipeline.ts:116-152` `PipelineHooks` + `LoopPipelineHooks` | `HookPipeline.register()` |
| `offload-hooks.ts:94-335` `createOffloadHooks()` | offload hook (pri=2) |
| `swarm-hooks.ts:38-135` `createStageFeedback()` | profile hook (pri=0) + stigmergy hook (pri=1) |
| `mnemopi-adapter.ts:59-266` `SwarmMnemopiAdapter` | mnemopi hook (pri=3) |

---

## 10. Layer 5: PhaseBehavior

### 10.1 核心接口

```typescript
// packages/coding-agent/src/swarm/behaviors/index.ts

interface PhaseBehavior {
  readonly phase: Chapter;

  /** FSM 进入此 phase 时调用 */
  enter(ctx: PhaseContext): Promise<PhaseEnterResult>;

  /** 处理来自 CommBus 的 Human 消息 */
  handleHumanMessage(msg: CommEnvelope): Promise<void>;

  /** 处理 Agent 事件（完成、失败、请求帮助） */
  handleAgentEvent(event: AgentEvent): Promise<void>;

  /** 检查 phase 是否完成。null = 进行中 */
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
  workspace: string; swarmDir: string;
  planContent?: string; loopConfig: LoopSwarmConfig;
  signal: AbortSignal;
}
```

### 10.2 ScriptBehavior 示例

```typescript
class ScriptBehavior implements PhaseBehavior {
  readonly phase = "script";

  async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
    // 1. 创建 Human ↔ Planner 的直接通道
    const channel = ctx.commBus.directChannel("human", "planner");

    // 2. 启动 Planner — 统一接口
    const [planner] = await ctx.runtime.spawn([{
      id: "planner", role: "planner", roleSource: "library",
      task: ctx.planContent ?? ctx.initialTask, modelPreference: "smartest",
    }]);

    // ContextPipeline 内部自动应用:
    //   RoleSource → ProfileSource → ExperienceSource → TurnGuidanceSource
    // TurnGuidanceSource 自动检测 turn=1 → 注入 "只提问，不写 plan"

    // Planner 的输出流自动通过 CommBus.pushToUI() 到达 Human

    return { agents: [planner], channels: [channel] };
  }

  async handleHumanMessage(msg: CommEnvelope): Promise<void> {
    // 消息自动路由到 Planner (通过 AgentHandle.send())
    // ContextPipeline 在下一轮 Turn 自动更新 turn-guidance
  }

  async checkCompletion(): Promise<PhaseCompletion | null> {
    // Planner 发出 "plan is complete" → 返回 completion
  }
}
```

### 10.3 StageBehavior 示例

```typescript
class StageBehavior implements PhaseBehavior {
  readonly phase = "stage";

  async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
    // 1. 创建 swarm 通道
    const channel = ctx.commBus.groupChannel("swarm",
      ["human", "agent-1", "agent-2", "agent-3"]);

    // 2. Role roundtable (如果启用)
    if (ctx.loopConfig.roundtable?.enabled) {
      await channel.roundtable("assign roles", { rounds: 2 });
    }

    // 3. 启动所有 worker
    const agents = await ctx.runtime.spawn(taskAssignments.map(t => ({
      id: t.agentId, role: t.role, roleSource: "library", task: t.taskDescription,
    })));

    // ContextPipeline 自动应用:
    //   Role → Profile → Stigmergy → Offload(MMD) → Mnemopi → TaskQueue

    return { agents, channels: [channel] };
  }

  async handleHumanMessage(msg: CommEnvelope): Promise<void> {
    // Human steering → swarm channel → 所有 agent
    await ctx.commBus.groupChannel("swarm").send("human", msg.body, { type: "steering" });
  }

  async handleAgentEvent(event: AgentEvent): Promise<void> {
    // Agent 完成任务 → HookPipeline 自动触发 offload/profile/stigmergy
    // Agent 发现冲突 → 通过 swarmChannel.roundtable() 协商
  }
}
```

### 10.4 CurtainBehavior 示例

```typescript
class CurtainBehavior implements PhaseBehavior {
  readonly phase = "curtain";

  async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
    // 1. 选举 Reporter
    const voteChannel = ctx.commBus.groupChannel("election", agentIds);
    const { winner } = await voteChannel.vote("elect reporter", agentIds, 15000);

    // 2. 并行启动 Reporter + Reflector
    const agents = await ctx.runtime.spawn([
      { id: winner, role: "reporter", roleSource: "library", task: reportTask },
      { id: "reflector", role: "reflector", roleSource: "library", task: reflectTask },
    ]);

    // HookPipeline 自动:
    //   offload: final flush + ExperienceStore 桥接
    //   profile: 更新所有 agent credit
    //   verification: 运行 test/lint/typecheck

    return { agents, channels: [voteChannel] };
  }
}
```

---

## 11. 完整生命周期流程

```
Human: "/loopeng 实现用户认证系统"

WorkflowFsm: idle ──→ script ──→ script-debate ──→ script-confirm
                │         │            │                  │
                │         │            │                  └─ Human 点 Confirm
                │         │            └─ Human 点 Debate
                │         └─ Human 发送任务
                └─ 初始状态

              ──→ stage ──→ curtain ──→ idle
                     │          │
                     │          └─ Reporter 完成 + Human Applaud
                     └─ 所有 Task 完成


─── CommBus 通信 (始终在线) ───

script:        directChannel("human", "planner")
               Human 1:1 对话，Agent 回答

script-debate: groupChannel("debate", [d1, d2, d3, human])
               channel.roundtable("critique plan", { rounds: 3 })
               Human 作为 observer 旁观

stage:         groupChannel("swarm", [agent-1..4, human])
               Agent↔Agent: direct + broadcast
               Human→Agent: steering (type: "steering")
               Human→All: broadcast steering

curtain:       groupChannel("election", [agent-1..3])
               channel.vote("elect reporter")
               Reporter 输出 → pushToUI()


─── HookPipeline (每个 Agent Turn 后触发) ───

agent:afterComplete →
  [pri=0] Profile Hook    → recordTaskCompleted
  [pri=1] Stigmergy Hook  → placeMark("artifact" | "warning")
  [pri=2] Offload Hook    → L1 summarize → store
                              → if shouldFlush → L1.5→L2→L3
  [pri=3] Mnemopi Hook    → rememberIfHighScore
  [pri=4] Experience Hook → bridgeToExperienceStore


─── ContextPipeline (每个 Agent 启动时构建) ───

AgentRuntime.spawn() →
  [pri=0] RoleSource          → system prompt
  [pri=1] ProfileSource       → credit + preferences
  [pri=2] ExperienceSource    → past lessons (FTS5)
  [pri=3] TurnGuidanceSource  → "First turn: ASK only"
  [pri=4] StigmergySource     → environment marks
  [pri=5] OffloadSource       → MMD diagram
  [pri=6] MnemopiSource       → semantic recall
  [pri=7] TaskQueueSource     → queued tasks

  → AgentLoopConfig.transformContext 实现
```

---

## 12. 文件结构规划

```
packages/coding-agent/src/swarm/
├── core/
│   ├── workflow-fsm.ts             # NEW — WorkflowFsm + PhaseDefinition
│   ├── state.ts                     # (保留 — StateTracker, Chapter 类型)
│   ├── schema.ts                    # (保留)
│   └── pipeline.ts                  # (保留 — PipelineController)
│
├── agent-runtime/                   # NEW — Layer 1
│   ├── index.ts                     # AgentRuntime 统一入口
│   ├── agent-spec.ts                # AgentSpec 类型
│   ├── role-provider.ts             # RoleProvider → 封装 roleAssetManager
│   ├── agent-launcher.ts            # AgentLauncher → 封装 spawn 策略
│   └── agent-handle.ts              # AgentHandle 实现
│
├── comm-bus/                        # NEW — Layer 2
│   ├── index.ts                     # CommBus
│   ├── endpoint.ts                  # CommEndpoint
│   ├── channel.ts                   # CommChannel (direct/group/broadcast)
│   ├── roundtable.ts                # roundtable() 实现
│   └── vote.ts                      # vote() 实现
│
├── context-manager/                 # NEW — Layer 3
│   ├── index.ts                     # ContextManager 统一入口
│   ├── context-pipeline.ts          # ContextPipeline + ContextSource
│   ├── offload-manager.ts           # OffloadManager → 统一 L1→L3
│   ├── context-compactor.ts         # ContextCompactor → 压缩策略
│   └── sources/                     # 内置 ContextSource 实现
│       ├── role-source.ts
│       ├── profile-source.ts
│       ├── experience-source.ts
│       ├── turn-guidance-source.ts
│       ├── stigmergy-source.ts
│       ├── offload-source.ts
│       ├── mnemopi-source.ts
│       └── task-queue-source.ts
│
├── hook-system/                     # NEW — Layer 4
│   ├── index.ts                     # HookPipeline
│   ├── types.ts                     # HookEvent, HookRegistration
│   └── builtins/                    # 内置 Hook 实现
│       ├── profile-hook.ts
│       ├── stigmergy-hook.ts
│       ├── offload-hook.ts
│       ├── mnemopi-hook.ts
│       ├── experience-hook.ts
│       └── verification-hook.ts
│
├── behaviors/                       # NEW — Layer 5
│   ├── index.ts                     # PhaseBehavior 接口
│   ├── script-behavior.ts
│   ├── stage-behavior.ts
│   └── curtain-behavior.ts
│
├── offload/                         # (保留 — 作为 context-manager 的子模块)
│   ├── worker-summarizer.ts         # L1 Summarizer
│   ├── agent-offload-summarizer.ts  # 通用 Agent 摘要
│   ├── deduplicator.ts             # L1.5 Dedup
│   ├── plan-node-attributor.ts     # L2 Attribution
│   ├── mermaid-synthesizer.ts      # L3 Mermaid
│   ├── mmd-injector.ts             # MMD 注入
│   ├── offload-store.ts            # SwarmOffloadStore
│   └── offload-paths.ts            # 路径工具
│
├── channel/                         # (逐步废弃 → comm-bus/)
├── script/                          # (逐步废弃 → behaviors/script-behavior.ts)
├── stage/                           # (逐步废弃 → behaviors/stage-behavior.ts)
├── curtain/                         # (保留经验存储, 执行逻辑 → behaviors/)
├── coordination/                    # (保留: MarkEnvironment, RegionLock, FileTracker)
├── hooks/                           # (保留: ActivityLogger, hook 逻辑 → hook-system/)
├── monitor/                         # (保留: SSE 服务器, API routes)
└── session/                         # (保留: SessionRegistry, SwarmSessionManager)
```

---

## 13. 迁移路径

### Phase 1: 建立抽象层，不破坏现有功能（1-2 周）

```
1. 新增 WorkflowFsm
   - 创建 workflow-fsm.ts
   - 注册所有 PhaseDefinition
   - SwarmStateMachine 内部委托给 WorkflowFsm
   - ScriptManager.#phase 改为委托 WorkflowFsm.state

2. 新增 CommChannel
   - 创建 comm-bus/channel.ts
   - roundtable() 内部使用 IrcBus.collectResponses()
   - vote() 内部使用 IrcBus.collectResponses() + tally
   - AgentChannel / RoleRoundtable / ReporterElection 内部委托给 CommChannel

3. 新增 ContextPipeline
   - 创建 context-manager/context-pipeline.ts
   - 将现有的 6 种上下文注入改写为 ContextSource
   - 现有的内联 prompt 构建改为调用 ContextPipeline.assemble()
```

### Phase 2: 新增编排层，替换分散调用（2-3 周）

```
4. 新增 AgentRuntime
   - ScriptManager.#runPlannerAgent()    → AgentRuntime.spawn([plannerSpec])
   - StageController.#runAgent()         → AgentRuntime.spawn(workerSpecs)
   - CurtainRunner.runReporterAgent()    → AgentRuntime.spawn([reporterSpec])

5. 新增 HookPipeline
   - 将现有的 4 套 hook 注册到 HookPipeline
   - 现有的 Hook 触发点改为 HookPipeline.trigger()

6. 新增 PhaseBehavior
   - ScriptBehavior 包装 ScriptManager
   - StageBehavior 包装 StageController
   - CurtainBehavior 包装 CurtainRunner
```

### Phase 3: 清理废弃代码（1 周）

```
7. 删除重复实现
   - 删除 AgentChannel.broadcast/subGroup/interrupt       → CommChannel 已替代
   - 删除 RoleRoundtable.negotiateRoles()                  → CommChannel.roundtable() 已替代
   - 删除 ReporterElection.elect()                         → CommChannel.vote() 已替代
   - 删除 SwarmStateMachine                                → WorkflowFsm 已替代
   - 标记 ScriptManager / StageController / CurtainRunner 为 deprecated

8. 文档 + 测试
   - 更新 AGENTS.md
   - 添加各层单元测试
```

---

## 14. 关键指标

| 指标 | 当前 | 统一后 |
|------|------|--------|
| **SatoPi 新增代码** | — | ~1200 行（6 个新类） |
| **可删除的重复代码** | — | ~800 行 |
| **satopi 代码修改** | — | **0 行** |
| **新增依赖** | — | 0 |
| **对外 API 变更** | — | 0（ScriptManager/StageController/CurtainRunner 公共 API 不变） |
| **状态管理** | 4 处独立 phase 追踪 | 1 个 WorkflowFsm |
| **Agent 启动** | 3 种模式 | 1 个 AgentRuntime.spawn() |
| **通信** | Human 在 3 个 phase 有 3 种角色 | 对等的 CommEndpoint |
| **上下文注入** | 6 种来源，4 处注入 | ContextPipeline 管道 |
| **Offload** | 仅 Stage 有 | 所有 phase 可配置 |
| **Hook** | 4 套独立系统 | 1 个 HookPipeline |
| **可测试性** | 每个组件需 mock 多个依赖 | 每层独立可测 |
