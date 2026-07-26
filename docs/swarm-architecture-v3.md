# SatoPi Swarm 统一架构 v3 — 完整重构方案

> 设计日期: 2026-07-25
> 合并 `unified-workflow-architecture-design.md` 与 `swarm-unified-architecture-refactor.md`，基于代码验证修正

---

## 目录

1. [oh-my-pi 基础设施全景](#1-oh-my-pi-基础设施全景)
2. [关键发现：AgentLoopConfig 注入点不可达](#2-关键发现agentloopconfig-注入点不可达)
3. [当前架构问题诊断](#3-当前架构问题诊断)
4. [设计原则](#4-设计原则)
5. [统一架构六层全景](#5-统一架构六层全景)
6. [Layer 0: WorkflowFSM](#6-layer-0-workflowfsm)
7. [Layer 1: AgentRuntime](#7-layer-1-agentruntime)
8. [Layer 2: CommBus](#8-layer-2-commbus)
9. [Layer 3: ContextManager](#9-layer-3-contextmanager)
10. [Layer 4: HookPipeline](#10-layer-4-hookpipeline)
11. [Layer 5: PhaseBehavior](#11-layer-5-phasebehavior)
12. [完整生命周期流程](#12-完整生命周期流程)
13. [分阶段实施路线图](#13-分阶段实施路线图)
14. [关键收益总结](#14-关键收益总结)

---

## 1. oh-my-pi 基础设施全景

### 1.1 包依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│  SatoPi Swarm Layer (packages/coding-agent/src/swarm/)     │
│  Multi-agent orchestration: Script / Stage / Curtain        │
└──────────────────────────┬──────────────────────────────────┘
                           │ depends on
┌──────────────────────────┼──────────────────────────────────┐
│  oh-my-pi Coding Agent (packages/coding-agent/src/)        │
│  AgentSession, AgentRegistry, IrcBus, ModelRegistry,       │
│  SessionStorage, EventBus, Task Executor, Tools             │
└──────────────────────────┬──────────────────────────────────┘
                           │ depends on
┌──────────────────────────┼──────────────────────────────────┐
│  oh-my-pi Agent Core (packages/agent/)                     │
│  Agent class, agentLoop, AgentTool, AgentToolContext,      │
│  AgentMessage, Compaction, Thinking, Telemetry              │
└──────────────────────────┬──────────────────────────────────┘
                           │ depends on
┌──────────────────────────┼──────────────────────────────────┐
│  oh-my-pi AI (packages/ai/)                                │
│  streamSimple, Model, Message, Provider, Auth, Streaming   │
└──────────────────────────┴──────────────────────────────────┘

Cross-cutting:
  pi-catalog   — Model catalog (bundled models, provider descriptors)
  pi-utils     — logger, Snowflake, prompt, escapeXml
  pi-natives   — Rust N-API addons (grep, text, shell, PTY)
  snapcompact  — Context compaction engine
```

### 1.2 关键基础设施清单

| 层级 | 组件 | 所在位置 | 职责 |
|------|------|---------|------|
| **LLM** | `streamSimple` / `completeSimple` | `pi-ai` | 流式/非流式 LLM 调用 |
| | `Model`, `ApiKey`, `Message` | `pi-ai` | 模型和消息类型 |
| **Agent Core** | `Agent` class + `agentLoop()` | `pi-agent-core` | 核心 agent loop |
| | `AgentTool`, `AgentToolContext` | `pi-agent-core` | 工具接口 + 上下文扩展声明 |
| | `AgentMessage`, `AgentState` | `pi-agent-core` | Agent 消息/状态类型 |
| | `AgentLoopConfig` | `pi-agent-core` | loop 配置：`transformContext`, `getSteeringMessages`, `getAsideMessages`, `getFollowUpMessages`, `hasSteeringMessages`, `hasIrcInterrupts`, `getApiKey`, `beforeToolCall`, `afterToolCall` |
| | `compact()`, `shouldCompact()` | `pi-agent-core/compaction` | 上下文压缩 |
| **Coding Agent** | `AgentSession` | `coding-agent/session` | Agent 生命周期: 持久化、压缩、bash、model switching |
| | `AgentRegistry` | `coding-agent/registry` | 进程全局 agent 注册表 (main + subagent) |
| | `AgentLifecycleManager` | `coding-agent/registry` | park / revive agent |
| | `IrcBus` | `coding-agent/irc` | 进程内 mailbox 总线: `send`, `wait`, `collectResponses`, `inbox` |
| | `ModelRegistry` + `Settings` | `coding-agent/config` | 模型注册 + API key + 全局配置 |
| | `AgentDefinition`, `SingleResult` | `coding-agent/task` | 任务类型定义 |
| | `EventBus` | `coding-agent/swarm/monitor` | pub/sub 事件总线 |
| | `SessionStorage` | `coding-agent/session` | 存储抽象 (文件/SQL/Redis) |
| | `runSubprocess()` | `coding-agent/task/executor` | 启动子进程 agent 的便捷函数 |
| | `streamAgentOutput()` | `coding-agent/swarm/render` | 启动 agent + SSE 流式输出 |
| | `ActivityLogger` | `coding-agent/swarm/hooks` | 事件日志 → SSE + session.jsonl |
| | `StateTracker` | `coding-agent/swarm/core` | 内存状态追踪 → session.jsonl |

### 1.3 oh-my-pi 已经提供的能力

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

## 2. 关键发现：AgentLoopConfig 注入点不可达

### 2.1 代码验证结果

通过搜索整个代码库，确认了以下事实：

```bash
# AgentLoopConfig hook 在 swarm 代码中的实际使用情况:
$ grep -rn "transformContext\|getSteeringMessages\|getAsideMessages\|getFollowUpMessages\|hasSteeringMessages\|hasIrcInterrupts" packages/coding-agent/src/swarm/

# 结果:
# - offload-agent-hooks.ts:  定义了 transformContext，但导出后未被任何调用方接入 AgentLoopConfig
# - executor.ts:             只用了 beforeToolCall / afterToolCall (通过 toolHooks)
# - 其他文件:                 零使用
```

### 2.2 根因

当前 SatoPi 所有 Agent 启动都通过 `runSubprocess()` 或其包装 (`streamAgentOutput`, `executeSwarmAgent`)。`runSubprocess()` 的 `ExecutorOptions` 接口 (`task/executor.ts:280`) **不暴露** `AgentLoopConfig` 的 `transformContext`、`getSteeringMessages`、`getAsideMessages`、`getFollowUpMessages`、`hasSteeringMessages`、`hasIrcInterrupts`。

这意味着：不是 SatoPi "选择不用"这些 hook，而是 **当前 API 根本传不进去**。

### 2.3 影响

```
当前架构:
  SatoPi → runSubprocess() → 内部创建 AgentSession → AgentLoopConfig
                                    ↑
                          transformContext / getSteeringMessages /
                          getAsideMessages / getFollowUpMessages
                          全部不可达

统一后 (方案 B):
  SatoPi → Agent + AgentSession (直接使用公开 API) → AgentLoopConfig
             ↑
          全部 6 个注入点可用
          ContextPipeline → transformContext
          Human steering  → getSteeringMessages
          系统通知        → getAsideMessages
          多轮对话        → getFollowUpMessages
```

`sdk.ts` 中大量使用 `Agent` + `AgentSession` 直接构造，这是 oh-my-pi 的合法公开 API。不需要修改 oh-my-pi 一行代码。

---

## 3. 当前架构问题诊断

### 3.1 现状：三套独立系统

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

### 3.2 七大分散问题

| 问题 | 表现 | 根因 |
|------|------|------|
| **状态机分散** | 4 处独立 phase 追踪 | 无统一 Workflow 级别状态抽象 |
| **Agent 启动分散** | 3 种启动方式 | 无统一 Agent Runtime |
| **通信分散** | Human 在 3 个 phase 有 3 种角色 | Human 和 Agent 不对等 |
| **上下文注入分散** | 6 种来源，4 处注入 | 无 ContextPipeline |
| **Offload 分散** | 仅 Stage 有 L1→L3 | Script/Curtain 无摘要机制 |
| **Hook 分散** | 4 套独立 hook/callback | 无法组合、无法排序 |
| **AgentLoopConfig 不可达** | 注入点被 runSubprocess 屏蔽 | 上下文注入只能内联拼装 |

### 3.3 oh-my-pi 能力未被充分利用

```
oh-my-pi 能力                       当前 SatoPi 使用情况
──────────────────────────────────  ────────────────────────
AgentLoopConfig.transformContext    ✗ 不可达 (runSubprocess 不暴露)
AgentLoopConfig.getSteeringMessages ✗ 不可达
AgentLoopConfig.getAsideMessages    ✗ 不可达
AgentLoopConfig.getFollowUpMessages ✗ 不可达
AgentLoopConfig.hasIrcInterrupts    ✗ 不可达
IrcBus.wait()                       部分使用 (仅 RoleRoundtable)
IrcBus.collectResponses()           部分使用
compact() / shouldCompact()         ✗ 未用 (snapcompact 独立调用)
```

---

## 4. 设计原则

### 4.1 核心原则

1. **`Agent` + `AgentSession` 是单个 Agent 的原子单元。** 不重新实现 agent loop，而是编排多个 Agent 实例。为访问 `AgentLoopConfig` 注入点，直接使用 `Agent`/`AgentSession` 公开 API（如同 `sdk.ts`），不经过 `runSubprocess()`。

2. **`IrcBus` 已经是完整 mailbox 总线。** `CommChannel` 是薄封装，增加 roundtable/vote 等高级通信模式，不替换底层传输。

3. **`AgentLoopConfig` 已提供所有注入点。** ContextPipeline 的产出通过 `transformContext` 注入；Human steering 通过 `getSteeringMessages` 注入；系统通知通过 `getAsideMessages` 注入；多轮对话通过 `getFollowUpMessages` 注入。

4. **`compact()` + `snapcompact` 已是成熟方案。** ContextCompactor 是对现有压缩策略的封装。

5. **oh-my-pi 类型不做修改。** `AgentDefinition`, `SingleResult`, `AgentMessage`, `AgentToolContext` 保持不变。

### 4.2 新增 vs 复用的边界

```
┌──────────────────────────────────────────────────────────────┐
│                      SatoPi 新增                              │
│                                                              │
│  WorkflowFsm         — 多 Phase 编排                          │
│  PhaseBehavior       — 每个 Phase 的行为定义                   │
│  HookPipeline        — 跨 Phase 的 Hook 编排                  │
│  ContextPipeline     — 上下文注入的管道化编排                   │
│  OffloadManager      — L1→L3 摘要流水线                        │
│  ContextCompactor    — 上下文压缩策略                           │
│  CommChannel         — roundtable / vote 等高级通信模式        │
│  AgentRuntime        — 多 Agent 并发 spawn 的编排器            │
│                                                              │
│  ═══════════════════════════════════════════════════════════  │
│                                                              │
│                      复用 oh-my-pi                             │
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
└──────────────────────────────────────────────────────────────┘
```

---

## 5. 统一架构六层全景

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
│  │  Profile(0) → Stigmergy(1) → Offload(2) → Mnemopi(3)      │  │
│  │  → Experience(4) → Verification(5)                         │  │
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
│  │  AgentSpec → ContextPipeline → AgentLoopConfig 组装        │  │
│  │  → Agent/AgentSession 直接创建 → AgentHandle              │  │
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
│  │ oh-my-pi Platform (不改动)                                 │  │
│  │  Agent + AgentSession    IrcBus + AgentRegistry           │  │
│  │  AgentLoopConfig         compact() + snapcompact          │  │
│  │  ModelRegistry + Settings  SessionStorage + EventBus      │  │
│  │  ActivityLogger + StateTracker                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 核心数据流

```
PhaseBehavior.enter()
  │
  ├─ 1. WorkflowFsm.transition(phase)  → StateTracker + ActivityLogger (复用)
  ├─ 2. HookPipeline.trigger("workflow:beforePhase") → 各 Hook 按 priority 执行
  │
  ├─ 3. 创建 CommChannel (基于 IrcBus)
  │      send → ircBus.send()  |  roundtable → ircBus.collectResponses() 循环
  │      vote → ircBus.collectResponses() + tally
  │
  ├─ 4. AgentRuntime.spawn(agentSpecs)
  │      ├─ ContextPipeline.assemble(spec, phase)
  │      │     → priority 排序的 ContextSource[] 管道
  │      │     → 产出 AgentLoopConfig.transformContext 实现
  │      │
  │      ├─ 组装完整 AgentLoopConfig:
  │      │     transformContext:       contextPipeline.toTransformContext()
  │      │     getSteeringMessages:    () → commBus.pendingHumanMessages()
  │      │     getAsideMessages:       () → commBus.pendingSystemNotifications()
  │      │     getFollowUpMessages:    () → commBus.pendingFollowUpMessages()
  │      │     getApiKey:              (model) → modelRegistry.resolver()  (透传)
  │      │     hasSteeringMessages:    () → commBus.hasPendingHumanMessages()
  │      │     hasIrcInterrupts:       () → commBus.hasPendingIrcMessages()
  │      │
  │      └─ 直接创建 Agent + AgentSession (oh-my-pi 公开 API)
  │           → AgentHandle 包装
  │
  ├─ 5. Agent 完成后 → HookPipeline.trigger("agent:afterComplete")
  │      [pri=0] Profile → [pri=1] Stigmergy → [pri=2] Offload
  │      → [pri=3] Mnemopi → [pri=4] Experience
  │
  └─ 6. checkCompletion() → FSM transition 到下一 phase
```

---

## 6. Layer 0: WorkflowFSM

### 6.1 设计目标

将当前 4 处独立的 phase 追踪统一为一个 WorkflowFSM。

### 6.2 核心接口

```typescript
// packages/coding-agent/src/swarm/core/workflow-fsm.ts

// 复用现有的 Chapter 类型 (state.ts)
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

/** Phase 定义 — 声明式 */
interface PhaseDefinition {
  phase: Chapter;
  allowedFrom: Chapter[];
  allowedTo: Chapter[];
  capabilities: PhaseCapabilities;
  defaultTimeoutMs: number;
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

### 6.3 Phase 注册

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
    // Extra inbound edges beyond "script-confirm":
    //   idle → stage:    /swarm run non-interactive mode (plan file provided directly)
    //   curtain → stage: loop-mode re-run without resetting to idle
    allowedFrom: ["script-confirm", "paused", "blocked", "idle", "curtain"],
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

### 6.4 替代关系

| 当前代码 | 统一后 |
|---------|--------|
| `swarm-state-machine.ts:101-203` `SwarmStateMachine` | `WorkflowFsm` |
| `script-manager.ts:68-69` `#phase` + `#busy` | `WorkflowFsm.state` |
| `curtain-runner.ts` 函数式无状态 | `WorkflowFsm` → CurtainBehavior |

---

## 7. Layer 1: AgentRuntime

### 7.1 设计目标

替代三种分散的 agent 启动方式。不经过 `runSubprocess()`，直接使用 `Agent` + `AgentSession` 公开 API，以访问完整的 `AgentLoopConfig` 注入点。

### 7.2 核心接口

```typescript
// packages/coding-agent/src/swarm/agent-runtime/index.ts

import { Agent } from "@oh-my-pi/pi-agent-core";              // 复用
import type { AgentLoopConfig } from "@oh-my-pi/pi-agent-core"; // 复用
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent"; // 复用
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";       // 复用

interface AgentSpec {
  id: string;
  role: string;
  roleSource: "library" | "profile" | "inline";
  inline?: { systemPrompt: string; tools: string[] };
  task: string;
  modelPreference?: "cheapest" | "smartest" | "role-default";
}

/** 对 oh-my-pi Agent 实例的薄包装 */
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
  async spawn(specs: AgentSpec[]): Promise<AgentHandle[]>;

  /** 启动 Roundtable */
  async spawnRoundtable(specs: AgentSpec[], config: RoundtableConfig): Promise<RoundtableResult>;
}
```

### 7.3 关键：不经过 runSubprocess()，直接使用 Agent + AgentSession

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
  │
  ├─ 4. 组装 AgentLoopConfig (直接使用 oh-my-pi 公开接口):
  │     {
  │       model: resolvedModel,
  │       tools: resolvedTools,
  │       systemPrompt: assembled.systemPrompt,
  │       transformContext:       contextPipeline.toTransformContext(assembled),
  │       getSteeringMessages:    () => commBus.pendingHumanMessages(agentId),
  │       getAsideMessages:       () => commBus.pendingSystemNotifications(agentId),
  │       getFollowUpMessages:    () => commBus.pendingFollowUpMessages(agentId),
  │       getApiKey:              (model) => modelRegistry.resolver(model, sessionId),
  │       hasSteeringMessages:    () => commBus.hasPendingHumanMessages(agentId),
  │       hasIrcInterrupts:       () => commBus.hasPendingIrcMessages(agentId),
  │     }
  │
  ├─ 5. 直接创建 Agent + AgentSession (如同 sdk.ts 的做法):
  │     agent = new Agent({ model, systemPrompt, tools })
  │     session = new AgentSession({ agent, ... })
  │     agent.start(task)  // 或 streamAgentOutput 的内部逻辑
  │
  └─ 6. 返回 AgentHandle
```

### 7.4 替代关系

| 当前代码 | 统一后 |
|---------|--------|
| `script-manager.ts:279-345` `#runPlannerAgent()` → `streamAgentOutput()` | `AgentRuntime.spawn([plannerSpec])` |
| `stage-controller.ts:351-441` `#runAgent()` → `AgentExecutor` + `runSubprocess()` | `AgentRuntime.spawn(workerSpecs)` |
| `curtain-runner.ts:205-269` `runReporterAgent()` → `streamAgentOutput()` | `AgentRuntime.spawn([reporterSpec])` |
| `debate-roundtable.ts:125-153` → `runSubprocess()` | `AgentRuntime.spawn(debaterSpecs)` |

---

## 8. Layer 2: CommBus

### 8.1 设计目标

Human 和 Agent 成为对等的通信端点。CommChannel 是对 IrcBus 的薄封装，增加 roundtable/vote 等高级通信模式。

### 8.2 核心接口

```typescript
// packages/coding-agent/src/swarm/comm-bus/index.ts

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

  registerAgent(id: string): CommEndpoint;

  // 通道工厂
  directChannel(a: string, b: string): CommChannel;              // 1:1
  groupChannel(name: string, members: string[]): CommChannel;     // N:N
  broadcastChannel(from: string): CommChannel;                    // 1:N

  // Human 输入入口
  receiveFromHuman(text: string, target?: string): Promise<void>;

  // 供 AgentLoopConfig 使用的查询方法
  pendingHumanMessages(agentId: string): AgentMessage[];
  pendingSystemNotifications(agentId: string): AgentMessage[];
  pendingFollowUpMessages(agentId: string): AgentMessage[];
  hasPendingHumanMessages(agentId: string): boolean;
  hasPendingIrcMessages(agentId: string): boolean;
}
```

### 8.3 通信模式矩阵

| Phase | Human 角色 | Human 能做什么 | Agent 间通信 | 底层传输 |
|-------|-----------|---------------|-------------|---------|
| **script** | dialogue | 与 Planner 1:1 对话 | 无 | `directChannel` → `ircBus.send()` + SSE relay |
| **script-debate** | observer | 观看辩论，不能发言 | roundtable | `groupChannel.roundtable()` → `ircBus.collectResponses()` |
| **stage** | observer | 观看 + steering broadcast | direct + roundtable + vote | `groupChannel` |
| **blocked** | dialogue | 决策交互 | 暂停中 | `WorkflowFsm.waitForHumanDecision()` |
| **curtain** | passive | 接收 reporter 输出 + applaud | vote (选举) | `groupChannel.vote()` + `pushToUI()` |

### 8.4 替代关系

| 当前代码 | 统一后 |
|---------|--------|
| `agent-channel.ts:39-220` `AgentChannel` | `CommChannel` |
| `role-roundtable.ts:50-210` `RoleRoundtable` | `CommChannel.roundtable()` |
| `reporter-election.ts:53-160` `ReporterElection` | `CommChannel.vote()` |
| `script-manager.ts:177-193` `sendMessage()` | `CommBus.receiveFromHuman()` |

---

## 9. Layer 3: ContextManager

### 9.1 架构总览

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
  ├── OffloadManager (产出方向: 从 Agent 产出生成摘要)
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

### 9.2 ContextPipeline

```typescript
// packages/coding-agent/src/swarm/context-manager/context-pipeline.ts

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
  injectedMessages?: AgentMessage[];  // oh-my-pi 原生类型
  tools?: string[];
}

class ContextPipeline {
  register(source: ContextSource): void;

  /** 管道式构建 */
  async assemble(spec: AgentSpec, phase: Chapter, base: BuildContext): Promise<AssembledContext>;

  /** 转化为 AgentLoopConfig.transformContext — 与 oh-my-pi 的集成点 */
  toTransformContext(assembled: AssembledContext): AgentLoopConfig["transformContext"];
}
```

### 9.3 OffloadManager

```typescript
class OffloadManager {
  // 内部持有 OffloadPipeline (复用现有 L1→L3 实现)
  // 每个 Phase 可独立配置 offload 级别:
  //   script:        L1 only
  //   script-debate: L1 only
  //   stage:         完整 L1→L3
  //   curtain:       L1 + ExperienceStore 桥接

  configurePhase(phase: Chapter, config: {
    l1TriggerThreshold: number;
    enableL2: boolean;
    enableL3: boolean;
    bridgeToExperience: boolean;
  }): void;

  async summarizeL1(agentId: string, result: SingleResult): Promise<void>;
  shouldFlush(phase: Chapter): boolean;
  async flush(phase: Chapter): Promise<L2L3Result>;

  getCurrentMmd(): string | null;
  getExperienceContext(agentId: string): string | null;
}
```

### 9.4 Offload 数据流

```
Agent 产出
  │
  ▼
L1: Summarize
  │ 策略: 文本截断 (≤200 字符) / LLM 压缩 (>500 字符或 JSON)
  │ 输入: AgentResult.output / AgentMessage[]
  │ 输出: OffloadEntry { agentId, summary, score, taskCall, turnIndex }
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
         │  → MmdInjector → 注入 Agent 上下文 (通过 ContextPipeline 的 OffloadSource)
         │
         └→ ExperienceStore 桥接
              → ExtractedLesson → SQLite + FTS5
              → Session 结束: bridgeSessionSummary + decayUnreferenced
```

### 9.5 ContextCompactor

```typescript
// packages/coding-agent/src/swarm/context-manager/context-compactor.ts

interface CompactionStrategy {
  readonly name: string;
  appliesTo(agent: AgentHandle, tokensUsed: number, budget: number): boolean;
  compact(agent: AgentHandle, history: AgentMessage[]): Promise<CompactedContext>;
}

interface CompactedContext {
  messages: AgentMessage[];         // 替换完整历史
  stigmergyMarks?: Mark[];          // 被压缩到环境的摘要
  offloadEntries?: OffloadEntry[];  // 被压缩到 offload 的摘要
}

class ContextCompactor {
  constructor(
    private strategies: CompactionStrategy[],
    private markEnv: MarkEnvironment,
    private offloadMgr: OffloadManager,
  ) {}

  async compactIfNeeded(agent: AgentHandle): Promise<CompactedContext | null>;

  /** 注册到 HookPipeline: 在 agent:beforeLaunch 时检查 */
  asHook(): HookRegistration;
}
```

---

## 10. Layer 4: HookPipeline

### 10.1 核心接口

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
  async trigger(event: HookEvent, payload: HookPayload, ctx: HookContext): Promise<void>;
}
```

### 10.2 内置 Hook 注册

```typescript
// priority=0: Profile Hook — 最早执行
{ name: "profile", priority: 0,
  events: ["agent:beforeSpawn", "agent:afterComplete", "workflow:afterPhase"] }

// priority=1: Stigmergy Hook — 环境信号
{ name: "stigmergy", priority: 1,
  events: ["agent:afterComplete", "agent:onError", "context:afterCompaction"] }

// priority=2: Offload Hook — 摘要 + Mermaid
{ name: "offload", priority: 2,
  events: ["agent:afterComplete", "workflow:beforePhase", "roundtable:afterRound"],
  phases: ["script", "script-debate", "stage", "curtain"] }

// priority=3: Mnemopi Hook — 语义记忆
{ name: "mnemopi", priority: 3,
  events: ["agent:beforeSpawn", "agent:afterComplete"] }

// priority=4: Experience Hook — 经验蒸馏
{ name: "experience", priority: 4,
  events: ["offload:afterFlush", "workflow:afterPhase"],
  phases: ["stage", "curtain"] }

// priority=5: Verification Hook — 确定性验证
{ name: "verification", priority: 5,
  events: ["workflow:beforePhase"], phases: ["curtain"] }
```

### 10.3 Hook 数据流

```
Agent 完成一次 Turn
  │
  ├─ HookPipeline.trigger("agent:afterComplete")
  │
  ├─ [pri=0] Profile Hook    → recordTaskCompleted
  ├─ [pri=1] Stigmergy Hook  → placeMark("artifact" | "warning")
  ├─ [pri=2] Offload Hook    → L1 summarize → store → if shouldFlush → L1.5→L2→L3
  ├─ [pri=3] Mnemopi Hook    → rememberIfHighScore
  └─ [pri=4] Experience Hook → bridgeToExperienceStore
```

---

## 11. Layer 5: PhaseBehavior

### 11.1 核心接口

```typescript
// packages/coding-agent/src/swarm/behaviors/index.ts

interface PhaseBehavior {
  readonly phase: Chapter;

  enter(ctx: PhaseContext): Promise<PhaseEnterResult>;
  handleHumanMessage(msg: CommEnvelope): Promise<void>;
  handleAgentEvent(event: AgentEvent): Promise<void>;
  checkCompletion(): Promise<PhaseCompletion | null>;
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

### 11.2 ScriptBehavior

```typescript
class ScriptBehavior implements PhaseBehavior {
  readonly phase = "script";

  async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
    // 1. Human ↔ Planner 直接通道
    const channel = ctx.commBus.directChannel("human", "planner");

    // 2. 启动 Planner — 统一接口
    const [planner] = await ctx.runtime.spawn([{
      id: "planner", role: "planner", roleSource: "library",
      task: ctx.planContent ?? ctx.initialTask, modelPreference: "smartest",
    }]);

    // ContextPipeline 自动应用:
    //   RoleSource → ProfileSource → ExperienceSource → TurnGuidanceSource
    // TurnGuidanceSource 自动检测 turn=1 → "只提问，不写 plan"

    // Planner 输出 → CommBus.pushToUI() → Human 看到

    // Human 回复 → CommBus.receiveFromHuman() → AgentLoopConfig.getFollowUpMessages
    //   → Planner 下一轮 Turn (ContextPipeline 自动更新 turn-guidance)

    return { agents: [planner], channels: [channel] };
  }

  async checkCompletion(): Promise<PhaseCompletion | null> {
    // Planner 输出含 "plan is complete" → 返回 completion
  }
}
```

### 11.3 StageBehavior

```typescript
class StageBehavior implements PhaseBehavior {
  readonly phase = "stage";

  async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
    // 1. swarm 通道 (Human 作为 observer)
    const channel = ctx.commBus.groupChannel("swarm",
      ["human", "agent-1", "agent-2", "agent-3"]);

    // 2. Role roundtable
    if (ctx.loopConfig.roundtable?.enabled) {
      await channel.roundtable("assign roles", { rounds: 2 });
    }

    // 3. 启动所有 worker
    const agents = await ctx.runtime.spawn(taskAssignments.map(t => ({
      id: t.agentId, role: t.role, roleSource: "library", task: t.taskDescription,
    })));

    // ContextPipeline: Role → Profile → Stigmergy → Offload(MMD) → Mnemopi → TaskQueue

    return { agents, channels: [channel] };
  }

  async handleHumanMessage(msg: CommEnvelope): Promise<void> {
    // Human steering → AgentLoopConfig.getSteeringMessages → 所有 agent 收到
    await ctx.commBus.groupChannel("swarm").send("human", msg.body, { type: "steering" });
  }

  async handleAgentEvent(event: AgentEvent): Promise<void> {
    // Agent 完成 → HookPipeline 自动触发 offload/profile/stigmergy
    // Agent 冲突 → CommChannel.roundtable() 协商
  }
}
```

### 11.4 CurtainBehavior

```typescript
class CurtainBehavior implements PhaseBehavior {
  readonly phase = "curtain";

  async enter(ctx: PhaseContext): Promise<PhaseEnterResult> {
    // 1. Reporter 选举
    const voteChannel = ctx.commBus.groupChannel("election", agentIds);
    const { winner } = await voteChannel.vote("elect reporter", agentIds, 15000);

    // 2. 并行启动 Reporter + Reflector
    const agents = await ctx.runtime.spawn([
      { id: winner, role: "reporter", roleSource: "library", task: reportTask },
      { id: "reflector", role: "reflector", roleSource: "library", task: reflectTask },
    ]);

    // HookPipeline 自动:
    //   offload: final flush + ExperienceStore 桥接
    //   profile: 更新 agent credit
    //   verification: 运行 test/lint/typecheck

    return { agents, channels: [voteChannel] };
  }
}
```

---

## 12. 完整生命周期流程

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
               Human↔Planner 1:1 对话

script-debate: groupChannel("debate", [d1, d2, d3, human])
               channel.roundtable("critique plan", { rounds: 3 })
               Human 作为 observer 旁观

stage:         groupChannel("swarm", [agent-1..4, human])
               Agent↔Agent: direct + broadcast
               Human→Agent: steering (via AgentLoopConfig.getSteeringMessages)
               Human→All: broadcast steering

curtain:       groupChannel("election", [agent-1..3])
               channel.vote("elect reporter")
               Reporter 输出 → pushToUI()


─── ContextPipeline (每个 Agent spawn 时构建) ───

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


─── HookPipeline (每个 Agent Turn 后触发) ───

agent:afterComplete →
  [pri=0] Profile Hook    → recordTaskCompleted
  [pri=1] Stigmergy Hook  → placeMark("artifact" | "warning")
  [pri=2] Offload Hook    → L1 summarize → store
                              → if shouldFlush → L1.5→L2→L3
  [pri=3] Mnemopi Hook    → rememberIfHighScore
  [pri=4] Experience Hook → bridgeToExperienceStore


─── 完整时序 ───

ScriptBehavior.enter()
  ├─ WorkflowFsm.transition("idle" → "script")
  ├─ HookPipeline.trigger("workflow:beforePhase")
  ├─ CommBus.directChannel("human", "planner")
  ├─ AgentRuntime.spawn([plannerSpec])
  │   ├─ HookPipeline.trigger("agent:beforeSpawn")
  │   ├─ ContextPipeline.assemble()
  │   │   RoleSource → ProfileSource → ExperienceSource → TurnGuidanceSource
  │   ├─ AgentLoopConfig 组装 → Agent + AgentSession 创建
  │   └─ Planner 输出 → CommBus.pushToUI()
  │
  ├─ Human 回复 → CommBus.receiveFromHuman()
  │   └─ AgentLoopConfig.getFollowUpMessages → Planner 继续
  │
  ├─ ...多轮苏格拉底式对话...
  │   每轮: HookPipeline.trigger("agent:afterComplete")
  │          → Profile Hook + Offload Hook (L1 summarize)
  │
  └─ Planner: "plan is complete" → checkCompletion() → script-confirm

Human 点 Debate:
  ├─ WorkflowFsm.transition("script-confirm" → "script-debate")
  ├─ groupChannel("debate", [d1, d2, d3, human])
  └─ channel.roundtable("critique plan", { rounds: 3 })
      ├─ Round 1..N: HookPipeline.trigger("roundtable:afterRound")
      │                → Offload Hook: L1 summarize
      └─ 收敛 → 写入 refined plan.md

Human 点 Confirm:
  ├─ WorkflowFsm.transition("script-confirm" → "stage")
  └─ StageBehavior.enter()
      ├─ groupChannel("swarm", [agent-1..4, human])
      ├─ channel.roundtable("assign roles")
      └─ AgentRuntime.spawn(workerSpecs)
          └─ ContextPipeline: Role→Profile→Stigmergy→Offload(MMD)→Mnemopi→TaskQueue

  Agent-1 完成任务:
      └─ HookPipeline.trigger("agent:afterComplete")
          ├─ Profile Hook     → recordTaskCompleted
          ├─ Stigmergy Hook   → placeMark("artifact")
          ├─ Offload Hook     → L1 summarize → if shouldFlush → L1.5→L2→L3
          ├─ Mnemopi Hook     → rememberIfHighScore
          └─ Experience Hook  → bridgeToExperienceStore

  Human 发送 steering:
      └─ CommBus → AgentLoopConfig.getSteeringMessages → 所有 agent 收到

  所有 task 完成:
      └─ WorkflowFsm.transition("stage" → "curtain")
          └─ HookPipeline.trigger("workflow:beforePhase")
              ├─ Offload Hook     → final forceFlush
              ├─ Experience Hook  → bridgeSessionSummary
              └─ Verification Hook → run tests/lint/typecheck

CurtainBehavior.enter():
  ├─ groupChannel("election", agentIds).vote("elect reporter")
  ├─ AgentRuntime.spawn([reporterSpec, reflectorSpec])
  │   ├─ Reporter → CommBus.pushToUI() → Human 看到总结
  │   └─ Reflector → DeepReflection → ExperienceStore
  └─ checkCompletion() → 等待 Applaud

Human Applaud:
  └─ WorkflowFsm.transition("curtain" → "idle")
      └─ HookPipeline.trigger("workflow:afterPhase")
          ├─ Profile Hook    → recordCollaboration
          └─ Experience Hook → archivePlan + decayUnreferenced

✅ Loop Run 完成
```

---

## 13. 分阶段实施路线图

### Phase 1: 基础设施准备（1-2 周）

**目标**: 建立 HookPipeline + ContextPipeline，不改变现有 Phase 代码。不修改 oh-my-pi。

#### Step 1.1: 创建 HookPipeline

```
文件: packages/coding-agent/src/swarm/hook-system/hook-pipeline.ts
       packages/coding-agent/src/swarm/hook-system/types.ts

内容:
  - HookEvent 类型定义 (20+ 事件)
  - HookRegistration 接口
  - HookPipeline 类 (register / trigger)
  - 单元测试: hook-pipeline.test.ts
    - 按 priority 排序执行
    - phase 过滤
    - 错误隔离 (一个 hook 失败不影响其他)

依赖: 无新依赖
```

#### Step 1.2: 创建 ContextPipeline

```
文件: packages/coding-agent/src/swarm/context-manager/context-pipeline.ts
       packages/coding-agent/src/swarm/context-manager/sources/*.ts

内容:
  - ContextSource 接口 + ContextFragment 类型
  - ContextPipeline 类 (register / assemble / toTransformContext)
  - 8 个内置 ContextSource:
    sources/role-source.ts          → roleAssetManager.get()
    sources/profile-source.ts       → profileRegistry.getPromptContext()
    sources/experience-source.ts    → experienceStore.search()
    sources/turn-guidance-source.ts → 回合感知 (script only)
    sources/stigmergy-source.ts     → markEnvironment.getContextForAgent()
    sources/offload-source.ts       → MMD 注入 + 经验检索
    sources/mnemopi-source.ts       → mnemopiClient.recall()
    sources/task-queue-source.ts    → taskQueue.formatForAgent()

依赖: roleAssetManager, profileRegistry, experienceStore, markEnvironment, offloadManager
```

#### Step 1.3: 创建 WorkflowFsm

```
文件: packages/coding-agent/src/swarm/core/workflow-fsm.ts

内容:
  - PhaseCapabilities 类型
  - PhaseDefinition 接口 + PHASES 常量
  - WorkflowFsm 类 (registerPhase / transition / force / onChange)
  - 内部委托给 StateTracker (复用)

集成:
  - SwarmStateMachine 内部委托给 WorkflowFsm (不改外部 API)
  - ScriptManager.#phase 改为读 WorkflowFsm.state.phase

单元测试: workflow-fsm.test.ts
  - 合法 transition
  - 非法 transition 被拒绝
  - force() 绕过校验
  - onChange 通知
```

#### Step 1.4: 注册现有 Hook 到 HookPipeline

```
修改: offload-hooks.ts → 注册为 HookPipeline 的 offload hook (priority=2)
      swarm-hooks.ts   → 注册为 profile hook (priority=0) + stigmergy hook (priority=1)
      mnemopi-adapter.ts → 注册为 mnemopi hook (priority=3)

现有触发点改为 HookPipeline.trigger():
  - afterAgentRound → "agent:afterComplete"
  - afterReview → "agent:afterComplete" (cloner)
  - afterIteration → "offload:afterFlush"
  - beforeAgentRound → "agent:beforeSpawn"
```

---

### Phase 2: CommBus + CommChannel（2-3 周）

**目标**: 统一通信层，替代 AgentChannel / RoleRoundtable / ReporterElection

#### Step 2.1: 创建 CommChannel (roundtable + vote)

```
文件: packages/coding-agent/src/swarm/comm-bus/channel.ts
       packages/coding-agent/src/swarm/comm-bus/roundtable.ts
       packages/coding-agent/src/swarm/comm-bus/vote.ts

内容:
  roundtable(topic, config):
    - 基于 ircBus.collectResponses() 的多轮循环
    - 收敛检测 (Jaccard 文本相似度 ≥ 0.85)
    - HookPipeline.trigger("roundtable:beforeRound") / "roundtable:afterRound"

  vote(question, candidates, timeoutMs):
    - 基于 ircBus.collectResponses() + tally
    - HookPipeline.trigger("vote:start") / "vote:tally" / "vote:result"

单元测试:
  - roundtable 收敛测试
  - vote tally 测试
  - 超时处理
```

#### Step 2.2: 创建 CommBus

```
文件: packages/coding-agent/src/swarm/comm-bus/index.ts
       packages/coding-agent/src/swarm/comm-bus/endpoint.ts

内容:
  - CommEndpoint 类 (id, kind, capabilities)
  - CommBus 类 (registerAgent / directChannel / groupChannel / broadcastChannel)
  - receiveFromHuman() — 统一 Human 消息入口
  - pendingHumanMessages() / pendingSystemNotifications() /
    pendingFollowUpMessages() / hasPendingHumanMessages() / hasPendingIrcMessages()
    — 供 AgentLoopConfig 使用

集成:
  - 创建 CommBus 实例时注入 IrcBus + AgentRegistry + ActivityLogger (全部复用)
```

#### Step 2.3: 迁移现有通信代码

```
替换:
  AgentChannel.broadcast/subGroup/interrupt  → CommChannel.send()
  RoleRoundtable.negotiateRoles()            → CommChannel.roundtable()
  ReporterElection.elect()                   → CommChannel.vote()

保留:
  agent-channel.ts — 标记 deprecated, 内部委托给 CommChannel
  role-roundtable.ts — 标记 deprecated, 内部委托给 CommChannel.roundtable()
  reporter-election.ts — 标记 deprecated, 内部委托给 CommChannel.vote()
```

---

### Phase 3: AgentRuntime (2-3 周)

**目标**: 统一 Agent 启动方式，直接使用 Agent + AgentSession 公开 API

#### Step 3.1: 创建 AgentRuntime

```
文件: packages/coding-agent/src/swarm/agent-runtime/index.ts
       packages/coding-agent/src/swarm/agent-runtime/agent-spec.ts
       packages/coding-agent/src/swarm/agent-runtime/agent-handle.ts
       packages/coding-agent/src/swarm/agent-runtime/role-provider.ts
       packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts

核心逻辑:
  spawn(specs):
    1. 对每个 spec: RoleProvider.resolve() → ResolvedRole
    2. HookPipeline.trigger("agent:beforeSpawn")
    3. ContextPipeline.assemble() → AssembledContext
    4. 组装 AgentLoopConfig (6 个注入点全部接入)
    5. 创建 Agent + AgentSession (直接使用 oh-my-pi 公开 API)
    6. agent.start(task) → 返回 AgentHandle

  关键: 不走 runSubprocess(), 直接创建 Agent/AgentSession
  (这是 sdk.ts 中的标准做法，不修改 oh-my-pi)

AgentHandle:
  - 包装 Agent + AgentSession
  - wait() → agent.waitForIdle() → 读取结果
  - send(msg) → agent.steer(msg) 或注入 followUp 消息队列
  - abort() → agent.abort()
  - outputStream() → agent.events() 的 AsyncIterable 包装

AgentLauncher:
  - 封装 Agent + AgentSession 的创建和配置
  - 复用 modelRegistry.resolver() 做 API key 解析
  - 复用 SessionStorage 做 session 持久化
```

#### Step 3.2: 迁移 Phase 的 Agent 启动

```
ScriptManager.#runPlannerAgent():
  当前: streamAgentOutput(opts, { agent: agentDef, task: taskText, ... })
  改为: AgentRuntime.spawn([{ id: "planner", role: "planner", ... }])

StageController.#runAgent():
  当前: AgentExecutor.execute() → runSubprocess()
  改为: AgentRuntime.spawn(workerSpecs)

CurtainRunner.runReporterAgent():
  当前: streamAgentOutput(opts, { agent: agentDef, task: task, ... })
  改为: AgentRuntime.spawn([{ id: winner, role: "reporter", ... }])

DebateRoundtable.debate():
  当前: Promise.allSettled(runSubprocess(...))
  改为: AgentRuntime.spawn(debaterSpecs)
```

---

### Phase 4: PhaseBehavior + 清理（2-3 周）

**目标**: 提取 PhaseBehavior 接口，清理废弃代码

#### Step 4.1: 创建 PhaseBehavior

```
文件: packages/coding-agent/src/swarm/behaviors/index.ts       (接口)
       packages/coding-agent/src/swarm/behaviors/script-behavior.ts
       packages/coding-agent/src/swarm/behaviors/stage-behavior.ts
       packages/coding-agent/src/swarm/behaviors/curtain-behavior.ts

每个 Behavior:
  - 实现 PhaseBehavior 接口 (enter / handleHumanMessage / handleAgentEvent / checkCompletion / exit)
  - 内部使用 AgentRuntime + CommBus + ContextManager + HookPipeline
  - ScriptManager / StageController / CurtainRunner 变为薄壳，委托给 Behavior

ScriptManager 的新角色:
  - loop.yaml 解析 (保留)
  - plan.md 路径管理 (保留)
  - 公共 API 不变 (start/sendMessage/runDebate/confirm/cancel)
  - 内部委托给 ScriptBehavior
```

#### Step 4.2: 清理废弃代码

```
删除/标记 deprecated:
  - SwarmStateMachine (swarm-state-machine.ts)   → WorkflowFsm 替代
  - AgentChannel (agent-channel.ts)              → CommChannel 替代
  - RoleRoundtable (role-roundtable.ts)          → CommChannel.roundtable() 替代
  - ReporterElection (reporter-election.ts)      → CommChannel.vote() 替代

保留但标记为内部实现:
  - offload-agent-hooks.ts  → 重构为 HookPipeline offload hook
  - offload-hooks.ts        → 重构为 HookPipeline offload hook
  - swarm-hooks.ts          → 重构为 HookPipeline profile + stigmergy hooks
  - mnemopi-adapter.ts      → 重构为 HookPipeline mnemopi hook
```

#### Step 4.3: 创建 ContextCompactor

```
文件: packages/coding-agent/src/swarm/context-manager/context-compactor.ts

内容:
  - CompactionStrategy 接口 (summarize / truncate / offload-to-stigmergy)
  - ContextCompactor 类 (compactIfNeeded / asHook)
  - 注册到 HookPipeline: agent:beforeLaunch 事件

集成:
  - 使用 oh-my-pi 的 compact() / shouldCompact() (复用)
  - 使用 snapcompact (复用)
  - 压缩后的摘要可注入 stigmergy 环境或 offload
```

---

### Phase 5: 前端适配 + 文档（1-2 周）

#### Step 5.1: Swarm GUI 适配

```
- 前端基于 WorkflowFsm.state 渲染，不再 infer phase
- Human 消息统一入口 CommBus.receiveFromHuman()
- SSE 事件仍由 ActivityLogger 产生 (不变)
```

#### Step 5.2: Collab 集成

```
- Guest 作为一个 CommEndpoint(kind="human")
- 能力由 PhaseCapabilities.humanMode 控制
```

#### Step 5.3: 文档

```
- 更新 AGENTS.md
- 每个新模块的 README / JSDoc
- 端到端集成测试
```

---

### 各 Phase 交付物总览

| Phase | 新增文件 | 修改文件 | 删除/废弃 | 净代码变化 |
|-------|---------|---------|----------|-----------|
| 1 | 4 (HookPipeline + ContextPipeline + WorkflowFsm + sources/) | 3 (offload-hooks, swarm-hooks, mnemopi-adapter) | 0 | +400 行 |
| 2 | 4 (CommBus + CommChannel + roundtable + vote) | 3 (agent-channel, role-roundtable, reporter-election) | 0 (标记 deprecated) | +350 行 |
| 3 | 5 (AgentRuntime + AgentHandle + AgentSpec + RoleProvider + AgentLauncher) | 4 (ScriptManager, StageController, CurtainRunner, DebateRoundtable) | 0 | +400 行 |
| 4 | 4 (3 Behaviors + ContextCompactor) | 0 | 4 (SwarmStateMachine, AgentChannel, RoleRoundtable, ReporterElection) | +200 行, -800 行 |
| 5 | 0 | 2 (前端 + Collab) | 0 | +50 行 |
| **总计** | **17 新文件** | **12 修改** | **4 废弃** | **+1400 / -800 = +600 净增** |

---

## 14. 关键收益总结

| 维度 | 当前 | 统一后 |
|------|------|--------|
| **状态管理** | 4 处独立 phase 追踪 | 1 个 WorkflowFsm，声明式注册 |
| **Agent 启动** | 3 种模式 | 1 个 AgentRuntime.spawn() |
| **AgentLoopConfig** | 6 个注入点不可达 | 6 个全部接入 |
| **通信** | Human 在 3 个 phase 有 3 种角色 | 对等的 CommEndpoint |
| **上下文注入** | 6 种来源，4 处注入 | ContextPipeline 管道 |
| **Offload** | 仅 Stage 有 | 所有 phase 可配置 |
| **Hook** | 4 套独立系统 | 1 个 HookPipeline |
| **上下文压缩** | 不存在统一策略 | ContextCompactor，3 种策略 |
| **oh-my-pi 修改** | — | **0 行** |
| **新增依赖** | — | **0** |
| **对外 API 变更** | — | **0** (ScriptManager/StageController 公共 API 不变) |
| **可测试性** | 每个组件需 mock 多个依赖 | 每层独立可测 |
| **可扩展性** | 新增 phase 需修改多处 | 注册 PhaseDefinition + PhaseBehavior 即可 |
