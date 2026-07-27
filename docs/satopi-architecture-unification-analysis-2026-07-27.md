# SatoPi 架构统一性分析与融合方案

> 日期: 2026-07-27
> 范围: 全量代码架构审查
> 主题: Agent 类型统一性、Script↔Plan-Mode 融合、Curtain↔Hindsight/Memories/Mnemopi 融合、Context 管道统一、TUI 接入评估

---

## 目录

1. [架构全景](#1-架构全景)
2. [Agent 类型与统一抽象层](#2-agent-类型与统一抽象层)
3. [Script ↔ Plan-Mode 融合分析](#3-script--plan-mode-融合分析)
4. [Curtain ↔ Hindsight 融合分析](#4-curtain--hindsight-融合分析)
5. [Memories / Mnemopi / Curtain 记忆系统分析](#5-memories--mnemopi--curtain-记忆系统分析)
6. [Context 统一管道分析](#6-context-统一管道分析)
7. [TUI 接入评估](#7-tui-接入评估)
8. [全局融合路线图与优先级](#8-全局融合路线图与优先级)

---

## 1. 架构全景

### 1.1 包依赖层次

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
│  Agent class, agentLoop, AgentTool, AgentLoopConfig,       │
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
  pi-tui       — Terminal UI library (differential rendering)
```

### 1.2 完整模块列表

| 域 | 位置 | 用途 |
|---|---|---|
| **Agent** | `packages/agent/` | Agent 运行时——agent loop、tool calling、message 类型 |
| **Session** | `packages/coding-agent/src/session/` | 会话生命周期：持久化、压缩、bash 执行、模型切换 |
| **Swarm** | `packages/coding-agent/src/swarm/` | 多 Agent 编排的 6 层统一架构 |
| **Context** | `packages/coding-agent/src/swarm/context-manager/` | 8 个优先级排序的 ContextSource 管道 + Offload L1→L3 |
| **Hook** | `packages/coding-agent/src/swarm/hook-system/` | 23 种事件的 priority 排序生命周期 Hook 管道 |
| **TUI** | `packages/tui/` + `coding-agent/src/tui/` + `swarm/tui/` | 终端 UI 渲染层 |
| **Tools** | `packages/coding-agent/src/tools/` | 32+ 内置工具：bash、browser、ast-edit、gh、fetch 等 |
| **Modes** | `packages/coding-agent/src/modes/` | I/O 抽象层——Interactive/Print mode、ACP、skill-command |
| **CLI & Commands** | `coding-agent/src/cli.ts` + `commands/` | 30+ CLI 命令入口 |
| **Task** | `packages/coding-agent/src/task/` | AgentDefinition、SingleResult、runSubprocess() |
| **Eval** | `packages/coding-agent/src/eval/` | JavaScript 求值上下文 |
| **Mnemopi** | `packages/mnemopi/` + `swarm/infra/mnemopi-adapter.ts` | 语义嵌入存储与检索 |
| **Memories** | `packages/coding-agent/src/memories/` | 双阶段 LLM 经验浓缩 |
| **Hindsight** | `packages/coding-agent/src/hindsight/` | 远程 API 长期记忆 + Mental Models |
| **Offload** | `packages/coding-agent/src/offload/` | L1→L3 摘要流水线 + Mermaid 合成 |
| **Config** | `packages/coding-agent/src/config/` + `config.ts` | Settings、ModelRegistry、API key |
| **Extensibility** | `packages/coding-agent/src/extensibility/` | 插件系统、custom commands/tools |
| **MCP** | `packages/coding-agent/src/mcp/` | Model Context Protocol 外部工具接入 |
| **Collab** | `packages/coding-agent/src/collab/` | WebSocket 实时协作 (host/guest + E2E encryption) |
| **SSH** | `packages/coding-agent/src/ssh/` | 远程执行、文件传输、SSHFS |
| **LSP & DAP** | `packages/coding-agent/src/lsp/` + `dap/` | Language Server (14 op) + Debug Adapter (28 op) |
| **Stats** | `packages/stats/` | 本地 SSE 遥测面板 |
| **Discovery** | `packages/coding-agent/src/discovery/` | 从外部工具配置自动导入 |
| **Auto-Research** | `packages/coding-agent/src/autoresearch/` | 研究任务多轮 Agent 循环 |
| **Plan-Mode** | `packages/coding-agent/src/plan-mode/` | 只读工作树 + local:// 规划 + 审批流程 |
| **Commit** | `packages/coding-agent/src/commit/` | 智能 commit message 生成 |
| **Export** | `packages/coding-agent/src/export/` | Session 导出 (HTML/share/TTSR) |
| **Advisor** | `packages/coding-agent/src/advisor/` | 主动提示 + emission guard + watchdog |
| **Vibe** | `packages/coding-agent/src/vibe/` | 运行时模式/氛围检测 |

### 1.3 Swarm 6 层架构（核心创新）

```
Layer 5: PhaseBehavior   → Script / Stage / Curtain 三幕歌剧
Layer 4: HookPipeline    → Profile→Stigmergy→Offload→Mnemopi→Experience→Verification
Layer 3: ContextManager  → ContextPipeline(8 Source) + OffloadManager + ContextCompactor
Layer 2: CommBus         → Human=Agent 对等端点, CommChannel(direct/group/broadcast/roundtable/vote)
Layer 1: AgentRuntime    → AgentSpec → Agent+AgentSession 直接创建 (不经过 runSubprocess)
Layer 0: WorkflowFSM     → idle→script→script-debate→script-confirm→stage↔paused↔blocked→curtain→idle
─────────────────────────────────────────────────────────────────────────────
oh-my-pi Platform(不动)  → Agent, AgentSession, IrcBus, AgentRegistry, ModelRegistry, compact()
```

### 1.4 WorkflowFSM 完整状态图

```
Phase              allowedFrom                            allowedTo
─────              ───────────                            ─────────
idle               script, script-debate, script-confirm, script, stage
                   curtain, paused, blocked

script             idle, script-debate, script-confirm    script-debate, script-confirm, idle

script-debate      script, script-confirm                 script-confirm, script, idle

script-confirm     script, script-debate                  stage, script, script-debate, idle

stage              script-confirm, paused, blocked,       paused, blocked, curtain
                   idle, curtain

paused             stage                                  stage, curtain, idle

blocked            stage                                  stage, curtain, idle

curtain            stage, paused, blocked                 idle, stage
```

每个 Phase 有独立的 Capability 声明：

| Phase | multiAgent | roundtable | vote | offload | compaction | humanMode |
|-------|-----------|------------|------|---------|------------|-----------|
| script | false | false | false | true | false | dialogue |
| script-debate | true | true | false | true | false | observer |
| script-confirm | false | false | false | false | false | dialogue |
| stage | true | true | true | true | true | observer |
| paused | false | false | false | false | false | dialogue |
| blocked | false | false | false | false | false | dialogue |
| curtain | true | false | true | true | false | passive |
| idle | false | false | false | false | false | none |

---

## 2. Agent 类型与统一抽象层

### 2.1 四种 Agent Kind

```typescript
// packages/coding-agent/src/registry/agent-registry.ts
export type AgentKind = "main" | "sub" | "advisor" | "persistent";
```

- **main**: 主 driving agent，用户直接交互
- **sub**: 通过 task tool 生成的 ephemereal 子 agent
- **advisor**: 被动 review/audit agent，不在 roster 中出现
- **persistent**: Swarm v3 跨 session agent，绑定 `AgentProfile` + role identity

Agent 状态：

```typescript
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
```

### 2.2 底层统一性：结论

**所有 agent 类型共享同一套底层基础设施**——`Agent` 类、`AgentSession`、`AgentRegistry`、`IrcBus/CommBus`、`AgentLoopConfig`。差异只在**编排层**。

```
                    Agent + AgentSession (同一底层)
                    ┌─────────────────────────────────┐
                    │  AgentLoopConfig (同一接口)      │
                    │  AgentRegistry (同一注册表)       │
                    │  IrcBus / CommBus (同一通信层)    │
                    │  ModelRegistry + Settings (共享)  │
                    │  AgentTool (同一工具系统)          │
                    └──────────────┬──────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
     ┌────▼─────┐          ┌──────▼──────┐          ┌──────▼──────┐
     │  main    │          │    sub      │          │ persistent  │
     │ (主Agent)│          │  (子Agent)  │          │ (Swarm P6+) │
     └────┬─────┘          └──────┬──────┘          └──────┬──────┘
          │                       │                        │
     context:                 context:                 context:
     buildSystemPrompt()      scoped subagent          ContextPipeline
     (静态, 全量)              template                (8 Source, 动态, phase-aware)
          │                       │                        │
     tools:                   tools:                   tools:
     全部 32+ 工具             白名单 (AgentDefinition    白名单 (RoleProvider
                              .tools + blockedTools)     + ContextPipeline.tools)
          │                       │                        │
     hooks:                   hooks:                   hooks:
     AgentSession             SubagentRunMonitor        HookPipeline
     .subscribe()             + beforeToolCall/         (Profile→Stigmergy→
                              afterToolCall              Offload→Mnemopi→
                                                         Experience→Verification)
          │                       │                        │
     lifecycle:               lifecycle:               lifecycle:
     AgentSession             被 AgentLifecycleManager  不被 AgentLifecycleManager
     自己管理                 管理 (TTL → parked)        管理 (kind === "persistent"
                                                        → lifecycle.ts:102 显式跳过)
```

### 2.3 关键差异表

| 维度 | main | sub | persistent (swarm) |
|------|------|-----|-------------------|
| **kind** | `"main"` | `"sub"` | `"persistent"` |
| **AgentSession** | ✅ 自己的 | ✅ 自己的（继承父级 resources） | ✅ 自己的（通过 AgentLauncher） |
| **AgentLoopConfig** | 完整配置 | `afterToolCall`/`beforeToolCall` | **全部 6 个注入点**：transformContext, getSteeringMessages, getAsideMessages, getFollowUpMessages, hasSteeringMessages, hasIrcInterrupts |
| **agentLoop** | ✅ 标准 loop | ✅ 标准 loop | ✅ 标准 loop（同一个） |
| **工具系统** | 全部 | 白名单（父级 MCP 代理） | 白名单（来自 RoleProvider + ContextPipeline） |
| **上下文组装** | `buildSystemPrompt()` 静态 | scoped subagent template | **ContextPipeline**（8 个 Source，优先级排序，phase-aware） |
| **Hook 系统** | AgentSession.subscribe() | SubagentRunMonitor | **HookPipeline**（6 优先级，23 种事件） |
| **通信** | TUI/IrcBus | 父级 eventBus channels | **CommBus**（direct/group/broadcast/roundtable/vote） |
| **压缩** | compact() | transformContext 透传 | **L3 compactContext()**（3 策略） |
| **生命周期管理** | AgentSession 自己 | AgentLifecycleManager（TTL → parked） | **不被 AgentLifecycleManager 管理**（显式跳过） |
| **持久化** | Session JSONL | Session JSONL（父级目录） | Session JSONL + **OffloadStore** + ExperienceStore |
| **Stigmergy** | ❌ | ❌ | ✅ MarkEnvironment（lock/claim/signal/artifact/warning） |

### 2.4 核心洞察

1. **底层 100% 相同**——所有 agent 最终都是 `new Agent(...) + new AgentSession(...)`。Swarm agent 不重新发明 agent loop，只是用 `AgentRuntime.spawn()` 编排多个实例。

2. **Swarm agent 是 AgentLoopConfig 的「最大用户」**——main/sub agent 的 AgentLoopConfig 注入点大多未被使用（尤其是 `transformContext`、`getSteeringMessages`、`getAsideMessages`），而 swarm agent 通过 ContextPipeline + CommBus 把全部 6 个注入点都打通了。这正是 v3 架构选 `Agent + AgentSession` 直接创建而非 `runSubprocess()` 的核心原因。

3. **Swarm agent 的 Hook 系统是附加层，不是替换层**——HookPipeline 是 SatoPi 新增的编排层，但 oh-my-pi 原有的 `AgentSession.subscribe()` 仍然在底层工作。HookPipeline 在 agent 级别（beforeSpawn/afterComplete），AgentSession 事件在 session 级别（agent_start/agent_end/tool_*）。

4. **`kind: "persistent"` 的关键语义**——不与 `"sub"` 的 parked 机制混淆。AgentLifecycleManager 显式跳过 persistent agent，因为它们的生命周期由 ProfileRegistry + SwarmSessionManager 管理，而不是简单的 TTL 驱逐。

---

## 3. Script ↔ Plan-Mode 融合分析

### 3.1 当前状态对比

| 维度 | Plan-Mode | Script Phase |
|------|-----------|-------------|
| **入口** | `/plan` command | `/swarm` → 自动进入 |
| **核心流程** | Agent 在只读模式下与用户对话 → 写 `local://<slug>-plan.md` → resolve 申请审批 → 审批后进入执行模式 | Planner agent 与用户苏格拉底式对话 → 写 `plan.md` → 可选 Debate → 用户点 Confirm → 进入 Stage |
| **产物** | `local://<slug>-plan.md`（artifact） | `.swarm_<name>/plan.md`（文件系统） |
| **状态机** | off → planning → approval → approved/paused | idle → script → script-debate → script-confirm → stage |
| **工具限制** | read-only 工作树（只允许 local://） | 无限制（Planner 全程可以写文件） |
| **多轮对话** | Human ↔ Agent（TUI 内） | Human ↔ Planner（SSE 流式输出） |
| **回合感知** | ❌ 无（只靠 system prompt 引导） | ✅ 显式 turn-guidance（T1: 只问不写，T2+: 增量写+问） |
| **辩论/批判** | ❌ 无 | ✅ Script-Debate（2-3 debater roundtable） |
| **审批机制** | `resolve { action: "apply" }` → InteractiveMode 弹出审批对话框，操作者选三种执行路径 | 用户点 "Confirm & Start" 按钮（或 `/swarm confirm`） |
| **上下文保留** | 三种选项：清空/压缩/保留 | 默认保留 |
| **与 Stage 的关系** | Plan 审批通过后 → 标准 agent 执行（非 swarm） | Script 确认后 → Swarm Stage（多 agent 并行） |
| **Model** | 自动切换到 plan model | 显式 `modelPreference: "smartest"` |
| **Agent 类型** | main agent（临时切换到 plan context） | 独立 Planner agent（可能是 profile agent 或默认 planner） |

### 3.2 语义重叠度：~70%

两者都是「先规划，后执行」的两阶段模式：
- Human ↔ Planner 多轮对话
- 产生 markdown plan 文件
- 用户确认后才进入执行
- 可以在规划期间中止/取消

### 3.3 关键差异

| Script Phase 有而 Plan-Mode 没有的 | Plan-Mode 有而 Script Phase 没有的 |
|------------------------------------|-------------------------------------|
| Debate（多 agent 批判计划） | 只读工作树保护（防止意外修改） |
| Turn-guidance（回合感知提示） | 三种上下文过渡策略（清空/压缩/保留） |
| Agent Profile 绑定 | `local://` artifact 协议 |
| 与 Stage/Curtain 的完整生命周期连接 | 暂停/恢复（paused state） |
| 经验检索（ExperienceStore → planner context） | 子 agent 计划引用（plan-handoff.ts） |
| Stigmergy/Offload/Mnemopi 上下文注入 | Compaction 保护（plan-protection.ts） |

### 3.4 融合方案：Plan-Mode 成为 Script Phase 的子模式

```
                     Script Phase (融合版)
                     ═══════════════════════

  entry: /plan          entry: /swarm         entry: /swarm run <file>
     │                      │                      │
     ▼                      ▼                      ▼
  ┌─────────────────────────────────────────────────────┐
  │              Script Phase                            │
  │                                                     │
  │  mode: "plan-only"   │  mode: "swarm-plan"         │
  │  (单 agent 规划)      │  (多 agent swarm 规划)       │
  │                      │                              │
  │  • 只读工作树         │  • 正常读写                   │
  │  • local:// artifact │  • .swarm/plan.md            │
  │  • 审批后 → 标准执行  │  • 审批后 → Stage             │
  │  • 可选 Debate        │  • 可选 Debate (默认)         │
  │                      │                              │
  │  共享:                                               │
  │  • TurnGuidanceSource (回合感知)                      │
  │  • ExperienceSource (经验注入)                        │
  │  • 审批机制 (resolve → 弹出对话框)                     │
  │  • 上下文过渡选项 (清空/压缩/保留)                      │
  │  • Compaction 保护 (plan-protection.ts)              │
  │  • 暂停/恢复 (paused → reentry)                       │
  └─────────────────────────────────────────────────────┘
                         │
                    Confirmed
                         │
              ┌──────────┴──────────┐
              │                     │
         plan-only              swarm-plan
              │                     │
              ▼                     ▼
       标准 Agent 执行         Stage Phase
       (有 Plan Reference)    (多 Agent 编排)
```

**具体融合点：**

1. **`PlanModeState` 成为 Script Phase 的子状态**——`mode: "plan-only" | "swarm-plan"` 区分行为
2. **TurnGuidanceSource 对所有模式生效**——即使 plan-only 也享受 T1 引导
3. **`PlanApprovalDetails` 统一审批流程**——无论哪种模式，审批都走同一个 `resolve → 弹出 → 选择上下文策略` 路径
4. **`plan-protection.ts` 用于所有模式**——plan-only 的只读执行+写保护，swarm-plan 的 compaction 保护
5. **ExperienceSource 注入统一**——planner 在所有模式下都能从过去的经验中学习
6. **Debate 对所有模式可选**——升级 plan-only 使其也能跑多 agent 批判
7. **`local://` 和 `.swarm/` 路径统一**——plan-only 也使用 ContextPipeline 组装，不硬编码路径

**不要融合的：**

- Plan-Mode 的上下文过渡策略（清空/压缩/保留）是 plan-mode 独有的 UX 决策，swarm 的 Script → Stage 总是保留上下文。可以将三种策略作为 **ScriptBehavior 的可配置项**，但保留各自的默认值。
- Plan-Mode 的暂停/恢复机制比 Script 的 cancel 更精细——应该向上兼容到 Script。
- Plan-Mode 不需要投票、选举、offload 等 Stage 阶段的能力。

---

## 4. Curtain ↔ Hindsight 融合分析

### 4.1 当前状态对比

| 维度 | Hindsight (主流程) | Curtain Phase (Swarm) |
|------|-------------------|----------------------|
| **触发时机** | 每 N 个 turn 的 `agent_end` | Stage 完成后一次性 |
| **输入** | 会话 transcript（user/assistant 消息） | StageResult（agent 输出、错误、迭代统计） |
| **处理方式** | `retain` → HTTP API → 服务端存储 + `recall` 检索 → 注入 `<memories>` | extractLessons（规则提取）+ reflectDeep（LLM 反思）+ 存 ExperienceStore（SQLite FTS5） |
| **存储** | 远程 Hindsight HTTP API | 本地 `.omp/experience/`（SQLite + FTS5 + JSONL） + `.swarm/summaries/` |
| **检索** | 语义检索（recall API）+ Mental Models（LLM 合成的长期摘要） | FTS5 全文搜索 + Jaccard 去重 + decayUnreferenced |
| **产物** | `<memories>` + `<mental_models>` block | CurtainResultData（reporter 总结 + lessons + deep reflection） |
| **跨 session** | ✅ 默认跨 session（远程 API） | ⚠️ 本地 JSONL/SQLite，不跨机器 |
| **Agent 参与** | ❌ 纯工具调用（recall/retain/reflect tools） | ✅ Reporter agent + Reflector agent + Vote 选举 |
| **人机交互** | 无（自动运行） | 用户 applaud 确认 + 可选 dissatisfaction → re-plan |
| **去重/衰减** | 服务端去重 | Jaccard（>0.7 阈值） + decayUnreferenced |
| **结构化** | Mental Models（User Preferences, Project Conventions, Project Decisions） | ExtractedLesson（error/success/insight/pattern/warning/reflection） |
| **与 Stage 关系** | 无直接关系（跟着 session 走） | 紧耦合——reporter 总结 stage 成果，reflector 从 stage 提取教训 |

### 4.2 语义重叠度：~50%

两者都：
- 从已完成的执行中提取持久化知识
- 涉及经验存储 + 未来检索
- LLM 参与的反思/合成步骤（Hindsight 的 reflect ↔ Curtain 的 reflectDeep）
- 存在去重/衰减机制

### 4.3 关键差异

| Curtain 有而 Hindsight 没有的 | Hindsight 有而 Curtain 没有的 |
|------------------------------|-------------------------------|
| 多 Agent 参与（Reporter + Reflector + Vote） | 跨 session 远程持久化 |
| Human 交互（applaud/disatisfaction） | 每 N turn 持续增量 retain |
| 结构化的 Stage 统计（iterations, reviewApprovalRatio, agentCount） | Mental Models（LLM 合成的长期总结） |
| Plan 归档 | `recall` 语义搜索（不仅是关键词匹配） |
| 本地 FTS5 全文搜索 | 跨项目的 bank 隔离（global/per-project/per-project-tagged） |
| 规则提取（extractLessons——确定性规则，不依赖 LLM） | 自动 recall 注入 `<memories>` block |

### 4.4 分层融合方案：不强行合并，建立数据桥接

Hindsight 和 Curtain 解决的是不同层次的记忆问题：

```
    ┌─────────────────────────────────────────┐
    │         Mental Models (长期摘要)          │  ← Hindsight 擅长
    │   User Preferences / Project Conventions │
    │   跨 session、跨机器、LLM 合成             │
    └─────────────────┬───────────────────────┘
                      │
    ┌─────────────────▼───────────────────────┐
    │         Recall (语义记忆)                │  ← Hindsight 擅长
    │   自动注入每轮上下文、语义检索             │
    │   跨 session、增量 retain                 │
    └─────────────────┬───────────────────────┘
                      │
    ┌─────────────────▼───────────────────────┐
    │      ExperienceStore (运行经验)          │  ← Curtain 擅长
    │   结构化教训、FTS5 搜索、Jaccard 去重      │
    │   单项目、本地、规则提取 + LLM 反思        │
    └─────────────────┬───────────────────────┘
                      │
    ┌─────────────────▼───────────────────────┐
    │      Curtain Reporter (运行总结)         │  ← Curtain 独有
    │   多 Agent 投票、Human Applaud、          │
    │   Report to Human、Plan 归档             │
    └─────────────────────────────────────────┘
```

**应该融合的点（数据桥接）：**

| 动作 | 优先级 | 说明 |
|------|--------|------|
| Curtain lessons → Hindsight `retainBatch()` | P1 | Curtain 完成后推送到远程 Hindsight bank，用 `retainTags: ["type:curtain", "project:xxx"]` 标记，实现跨 session 检索 |
| Hindsight recall → Curtain 上下文注入 | P1 | Curtain 的 Reflector agent 可调用 `recall` 工具从远程 bank 检索跨 session 的教训 |
| Curtain pattern → Mental Model 自动触发 | P2 | 同一类 error >3 次 → 触发 `createMentalModel`（如 "Common Build Failures"） |
| Curtain lessons → Mnemopi `rememberScoped()` | P1 | swarm 运行经验写入本地向量记忆，让 main agent 也能 recall |

**不要融合的：**

- Curtain 的「Reporter 选举 + Human Applaud」是 swarm 特有的 UX 模式，不适合塞进 Hindsight 的自动 recall/retain 循环
- Hindsight 的 Mental Models 通过远程 LLM API 生成长期摘要，模型选择、延迟容忍度与 Curtain 的 Reflector 完全不同

---

## 5. Memories / Mnemopi / Curtain 记忆系统分析

### 5.1 三个系统的本质定位

| 维度 | Memories | Mnemopi | Curtain ExperienceStore |
|------|----------|---------|------------------------|
| **记忆来源** | 普通 session（Human↔Agent 对话） | 所有 session（自动提取+工具调用） | Swarm 运行结果 |
| **记忆内容** | 项目知识、决策、惯例 | 语义事实、实体关系 | 运行教训（error/success/pattern） |
| **检索方式** | → MEMORY.md → 注入 system prompt | 语义向量搜索（embedding） | FTS5 关键词 + 同义词扩展 |
| **使用者** | main agent（system prompt 中展开） | 所有 agent（tool + auto-recall） | swarm agent（Script 阶段经验注入） |
| **存储粒度** | 合并后的全局摘要（~4-5K tokens） | per-fact 向量存储 | 结构化 lesson（run_id + type + tags） |
| **生命周期** | LLM 双阶段处理 → MEMORY.md | 自动 extract → working → 定期 consolidate | save → Jaccard dedup → decay |
| **User-facing** | ✅ `/memory` 命令 | ✅ `/memory` 命令 | ❌ 纯 swarm 内部 |
| **存储引擎** | SQLite + JSONL + MD | Per-bank SQLite（fastembed 子进程） | SQLite FTS5 + JSONL + MD |
| **去重** | Watermark-based | ID + content hash | Jaccard similarity (0.7 阈值) |
| **衰减** | 无（Phase 2 全量合并） | consolidation/sleep | 权重衰减（DECAY_FACTOR 0.9） |
| **编辑支持** | learned.md 编辑 | Full CRUD（update/forget/invalidate） | 不允许编辑 |

### 5.2 数据流图

```
┌─────────────────────────────────────────────────────────────┐
│                    User Turns (CLI)                          │
│              (stored in .stp/sessions/*.jsonl)               │
└──────────────────────┬──────────────────────────────────────┘
                       │
           ┌───────────┴───────────┐
           │                       │
      [MEMORIES]             [MNEMOPI]
      (Phase 1: Extract)     (Session State)
           │                       │
      Per-thread               Auto-learn
      session history          on agent_end
           │                       │
           ├─→ [Memory Startup]    ├─→ [Sessions Subscribe]
           │   (stage1 jobs)       │   - maybeRecallOnAgentStart()
           │   (stage2 global)     │   - maybeRetainOnAgentEnd()
           │                       │
      raw_memories.md         rememberScoped()
      memory_summary.md        recall results
      MEMORY.md                ┌─────────────────┐
      skills/                  │  Scoped Banks   │
      learned.md           project | global | both
           │               (per-project-tagged)
           └─→ [System Prompt Injection] ←┘
               (~4-5k tokens, buildMemoryToolDeveloperInstructions)

       [TOOLS]
       ├─ /memory retain  → learned.md write
       ├─ /memory recall  → MEMORIES or MNEMOPI search
       ├─ /memory reflect → semantic synthesis
       ├─ /memory edit    → mnemopi update/forget/invalidate
       └─ /memory clear   → wipe all + dispose()

───────────────────────────────────────────────────────────────
       [SWARM LOOP RUNS]
       (.omp/experience/)
───────────────────────────────────────────────────────────────
           │
    ┌──────┴──────┐
    │             │
[EXTRACTOR]  [REFLECTOR]
Pull lessons  Deep LLM
from stage    reflection
    │             │
    └──────┬──────┘
           │
    [EXPERIENCESTORE]
    ExperienceStore.saveLesson()
           │
    lessons table (FTS5)
    + dedup (Jaccard 0.7)
    + weight tracking
    + decay (unreferenced)
```

### 5.3 MemoryBackend 统一接口

三个系统都通过 `MemoryBackend` 接口暴露：

```typescript
export interface MemoryBackend {
  readonly id: MemoryBackendId;  // "off" | "local" | "hindsight" | "mnemopi"
  start(options: MemoryBackendStartOptions): void | Promise<void>;
  buildDeveloperInstructions(agentDir, settings, session?): Promise<string | undefined>;
  clear(agentDir, cwd, session?): Promise<void>;
  enqueue(agentDir, cwd, session?): Promise<void>;
  status?(context): Promise<MemoryBackendStatus>;
  search?(context, query, options?): Promise<MemoryBackendSearchResult>;
  save?(context, input): Promise<MemoryBackendSaveResult>;
  beforeAgentStartPrompt?(session, promptText): Promise<string | undefined>;
  preCompactionContext?(messages, settings, session?): Promise<string | undefined>;
}
```

### 5.4 融合方案：保持独立，建立桥接

**结论：不要强行融合为「一个系统」**——它们服务于不同抽象层次的记忆需求，强行合并会：
1. 把不同粒度的数据塞进同一个 schema
2. 让远程 API 依赖变成本地系统的瓶颈
3. 破坏各自独立的失败域

**应该在两个方面工作：**

#### 1. Curtain → Mnemopi/Hindsight 数据上推

```
Curtain 完成后:
  1. extractLessons() + reflectDeep() → ExtractedLesson[]
  2. saveLesson() → ExperienceStore (本地 FTS5，确定性)
  3. rememberScoped() → Mnemopi (本地向量，让普通 agent 能 recall)  ← 新增
  4. retainBatch() → Hindsight (远程，跨 session)  ← 新增
```

#### 2. Mnemopi/Hindsight → Curtain 上下文注入

```
Script Phase Planner 上下文组装:
  ContextPipeline.assemble()
    ├─ ExperienceSource → FTS5 search ExperienceStore  (已有)
    ├─ MnemopiSource   → semantic recall via Mnemopi   (已有，可选)
    └─ HindsightSource → recall via Hindsight API      ← 新增
```

#### 3. 各自的去重/衰减保持独立

| 系统 | 去重机制 | 为什么不同 |
|------|---------|-----------|
| Curtain ExperienceStore | Jaccard similarity (0.7) | Lesson 是结构化 JSON，summary 较短，Jaccard 最合适 |
| Mnemopi | ID + content hash | per-fact 向量存储，hash 去重简单可靠 |
| Memories | Watermark (按 thread updated_at) | 按 session 去重，避免重复处理同一会话 |

**不要统一到同一个去重机制**——强行统一只会让代码更复杂，不会有实际收益。

---

## 6. Context 统一管道分析

### 6.1 现状：两个半独立路径

```
═══════════════════════════════════════════════════════════════
  PATH A: Main Agent                           PATH B: Swarm Agent
  ═══════════════                              ═══════════════

  buildSystemPrompt()                          RoleProvider.resolve()
    ├─ SYSTEM.md walk-up                         ├─ role library → ResolvedRole
    ├─ 上下文文件 (AGENTS.md etc)                  │   (.systemPrompt + .guidelines + .tools)
    ├─ 技能/规则/工具库存                          │
    ├─ 环境信息 (CPU/GPU/OS)                      ├─ ContextPipeline.assemble()
    ├─ personality                                 │   8 个 ContextSource
    └─ workspace tree                              │   priority 排序执行
         │                                          │   → AssembledContext
         ▼                                          │      .systemPrompt
  Agent.systemPrompt = [blocks]                      │      .injectedMessages
         │                                           │      .tools
  transformContext:                                  │
    ├─ extensionRunner.emitContext()                 ▼
    ├─ wrapSteeringForModel()                AgentLauncher:
    └─ MarkEnvironment context                └─ #buildSystemPrompt(
         │                                            resolvedRole.systemPrompt
         ▼                                             + assembledContext.systemPrompt
  AgentLoopConfig.transformContext                     )
  (在 Agent.prompt() 每轮调用)                        └─ transformContext:
══════════════════════════════════════════              ├─ injectedMessages 预置
  PATH C: Hindsight/Mnemopi 旁路                       ├─ MMD per-turn 注入
  ════════════════════════════                         ├─ L3 compactContext
                                                       └─ steering feed (live poll)
  MemoryBackend.buildDeveloperInstructions()
    → `<memories>` + `<mental_models>` text       AgentLoopConfig.transformContext
    → 注入到 system prompt 末尾
                                                      steeringMode: "one-at-a-time"
  MemoryBackend.beforeAgentStartPrompt()         followUpMode: "one-at-a-time"
    → 首次 turn 的额外 recall 注入
                                                      getApiKey → ModelRegistry
  MemoryBackend.preCompactionContext()
    → 压缩时的语义 recall 辅助              AgentHandle (包装 Agent + AgentSession)
```

### 6.2 关键发现

1. **`transformContext` 是唯一的统一收敛点**——但只对 swarm path 真正有价值。Main agent 的 `transformContext` 只做 steering wrapping + markEnv 注入。

2. **System prompt 是两条完全分离的路径**——`buildSystemPrompt()` 和 `AgentLauncher.#buildSystemPrompt()` 没有任何共享代码。

3. **MemoryBackend 是第三条独立的注入通道**——`buildDeveloperInstructions()` 在 system prompt 组装完成后才被追加到末尾。

### 6.3 统一方案：ContextPipeline 作为所有 Agent 类型的统一上下文接口

```
ContextPipeline (统一入口)
│
├─ [pri=0]   RoleSource              (所有 agent 类型)
├─ [pri=1]   ProfileSource           (main + persistent)
├─ [pri=2]   EnvironmentSource       (所有——从 buildSystemPrompt 迁移)
├─ [pri=3]   SkillSource             (所有——从 buildSystemPrompt 迁移)
├─ [pri=4]   RuleSource              (所有——从 buildSystemPrompt 迁移)
├─ [pri=5]   WorkspaceTreeSource     (所有——从 buildSystemPrompt 迁移)
├─ [pri=6]   ExperienceSource        (script + script-debate)
├─ [pri=7]   TurnGuidanceSource      (script only)
├─ [pri=8]   StigmergySource         (stage only)
├─ [pri=9]   OffloadSource           (stage + curtain)
├─ [pri=10]  MnemopiSource           (所有，可选)
├─ [pri=11]  HindsightSource         (所有——从 buildDeveloperInstructions 迁移)
├─ [pri=12]  TaskQueueSource         (stage only)
│
→ ContextFragment {
    systemPromptAddition,
    taskPromptAddition,
    injectedMessages: AgentMessage[],
    tools: string[]
  }
→ AgentLoopConfig.transformContext
```

**具体步骤：**

#### Step 1：将 `buildSystemPrompt()` 内部转为 ContextSource 注册

```typescript
// system-prompt.ts 内部改造：
// 不再在 buildSystemPrompt() 中硬编码所有组装逻辑
// 而是注册一组 ContextSource，然后让 ContextPipeline 执行：

const mainAgentSources: ContextSource[] = [
  new SystemPromptTemplateSource(),    // 核心 system-prompt.md
  new ProjectContextFilesSource(),     // AGENTS.md, SYSTEM.md
  new SkillSource(),                   // 技能列表
  new RuleSource(),                    // 规则列表
  new PersonalitySource(),            // 人格配置
  new WorkspaceTreeSource(),          // 目录树
  new EnvironmentInfoSource(),        // CPU/GPU/OS
];
```

**收益**：Main agent 也能享受到 ContextPipeline 的优先级排序和 phase-aware 过滤。

#### Step 2：MemoryBackend → ContextSource 适配器

```typescript
// 不再用 buildDeveloperInstructions() 直接注入文本
// 而是将 MemoryBackend 包装为 ContextSource：

class HindsightContextSource implements ContextSource {
  name = "hindsight";
  priority = 11; // 最后注入

  async build(ctx): Promise<ContextFragment> {
    const instructions = await this.#backend.buildDeveloperInstructions(...);
    const recall = await this.#backend.beforeAgentStartPrompt(...);
    return {
      systemPromptAddition: [instructions, recall].filter(Boolean).join("\n\n"),
    };
  }
}
```

**收益**：Hindsight/Mnemopi/Memories 记忆注入变成 ContextPipeline 中的一个普通 Source，可以和其他 Source 一起排序、过滤、测试。

#### Step 3：Subagent executor 复用 ContextPipeline

```typescript
// executor.ts 中，不再硬编码 subagent 的 context 模板：
const assembled = await contextPipeline.assemble(
  { agentKind: "sub", role: agent.name },
  "idle",
  {
    scopedTools: agent.tools,
    blockedTools: agent.blockedTools,
  }
);
// ContextPipeline 自动跳过不适用于 sub 的 Source
// (如 TurnGuidanceSource, StigmergySource)
```

**收益**：Subagent 的上下文组装不再硬编码在 executor.ts 的千行函数中，而是通过可组合的 ContextSource 声明式配置。

---

## 7. TUI 接入评估

### 7.1 整体架构

```
StateTracker (状态)
  │
  ▼
ActivityLogger (事件→SSE)
  │
  ▼
TUI (渲染)
  ├─ pi-tui engine (通用差分渲染)
  ├─ swarm/tui/ (纯渲染函数，无状态)
  └─ modes/interactive-mode.ts (Component 树编排)
```

### 7.2 做对的部分 ✅

1. **纯渲染函数**——`swarm/tui/` 下的所有模块（agent-panel、comm-panel、context-panel、phase-view、splash、swarm-dashboard）只接收快照数据，返回 ANSI 字符串数组。零副作用，完全可测试。

2. **pi-tui 是通用引擎**——提供 Component 接口 + 差分渲染 + SGR 合并 + 终端能力检测，不耦合任何 swarm 业务逻辑。

3. **分层清晰**——`StateTracker` → `ActivityLogger` → SSE → TUI，各层通过不可变快照通信。

4. **Dashboard 响应式布局**——≥100 列双栏、≥60 列单栏、<60 列紧凑模式。

5. **Streaming output 有统一包装**——`swarm/render/streaming.ts` 的 `streamAgentOutput()` 解决了 ring-buffer 旋转导致的文本丢失。

### 7.3 需要改进的部分 ⚠

#### 问题 1：Swarm TUI 不是 pi-tui Component

当前手动拼接渲染：

```typescript
// swarm-dashboard.ts
const rows = [
  ...renderPhaseView(state, width),
  ...renderAgentPanel(state, width),
  ...
];
return rows; // string[]
```

**修复**：实现 `Component` 接口，享受差分重绘优化：

```typescript
class SwarmDashboard implements Component {
  render(width: number): readonly string[] { ... }
  invalidate(): void { ... }
}
```

#### 问题 2：没有声明式绑定层

当前 swarm TUI 依赖外部轮询 StateTracker 或 SSE 事件，没有声明式订阅：
- `WorkflowFsm.onChange` → phase-view 刷新
- `StateTracker` agent 更新 → agent-panel 刷新
- `CommBus` message → comm-panel 刷新

**修复**：创建 `SwarmTuiBinding`：

```typescript
class SwarmTuiBinding {
  #dashboard: DashboardComponent;
  constructor(fsm: WorkflowFsm, stateTracker: StateTracker, commBus: CommBus) {
    fsm.onChange(() => this.#dashboard.invalidate());
    // ... etc
  }
}
```

#### 问题 3：Comm/Context panel 缺少实时数据源

`CommPanelState` 和 `ContextPanelState` 当前是静态快照，没有自动更新机制。

#### 问题 4：Main TUI 和 Swarm TUI 互不知晓

两个完全分离的渲染通道在同一个 terminal 上各自工作，缺少声明式的视图切换机制。

### 7.4 改进优先级

| 改进点 | 优先级 | 工作量 | 收益 |
|--------|--------|--------|------|
| Swarm Dashboard 改为 pi-tui Component | P1 | 小 | 差分重绘优化、代码复用 |
| SwarmTuiBinding 声明式绑定 | P1 | 中 | 减少轮询、事件驱动更新 |
| ContextPanel 实时数据源 | P2 | 小 | CommBus/ContextPipeline 状态可视化 |
| Main ↔ Swarm 视图切换 | P2 | 中 | UX 平滑过渡 |

---

## 8. 全局融合路线图与优先级

### 原则

1. **不要为了「优雅」而强行合并语义不同的系统**
2. **优先建立清晰的数据桥接和统一的抽象接口**
3. **ContextPipeline 是唯一应该成为「统一入口」的地方**
4. **其他系统保持独立，通过 ContextPipeline 注入各自的数据**

### 路线图

```
P0 (立即) ─ 消除重复，建立一致性
  ├─ Script ↔ Plan-Mode 融合
  │   Plan-Mode 成为 Script 的 mode="plan-only"
  │   统一审批流程、回合感知、经验注入
  │
  └─ ContextPipeline 成为所有 agent 类型的统一上下文接口
      buildSystemPrompt() 内部转为 ContextSource 注册
      AgentLauncher 和 main agent 共享同一管道

P1 (短期) ─ 数据流动性，打通记忆系统
  ├─ Curtain → Mnemopi 桥接 (swarm lessons → rememberScoped)
  ├─ Curtain → Hindsight 桥接 (swarm summaries → retainBatch)
  ├─ ContextPipeline 扩展到 subagent executor
  ├─ Mnemopi/Hindsight → ContextSource 适配器
  └─ TUI Dashboard Component 化 + 声明式绑定

P2 (中期) ─ 体验完善与深度整合
  ├─ Curtain pattern → Mental Model 触发 (error > 3次 → createMentalModel)
  ├─ Hindsight recall → Curtain 上下文注入 (Reflector 可检索跨 session 教训)
  ├─ Main ↔ Swarm TUI 视图切换
  ├─ ContextPanel 实时数据源
  └─ Subagent context 自动继承父级 ContextPipeline 配置

P3 (长期) ─ 自适应与自动化
  ├─ Memories Phase 2 → ContextPipeline source
  ├─ 跨 session swarm 经验自动学习回路
  └─ 自适应 ContextPipeline（根据运行历史动态调整 Source 优先级/权重）
```

### 融合动作总表

| 融合线 | 融合方式 | 程度 | 优先级 |
|--------|---------|------|--------|
| **Script ↔ Plan-Mode** | 深度融合——Plan-Mode 成为 Script 的 mode | 🔴 合并 | P0 |
| **ContextPipeline 统一** | buildSystemPrompt → ContextSource，所有 agent 类型经过同一管道 | 🔴 合并 | P0 |
| **Curtain → Mnemopi** | 数据桥接——swarm lessons → rememberScoped | 🟡 桥接 | P1 |
| **Curtain → Hindsight** | 数据桥接——swarm summaries → retainBatch | 🟡 桥接 | P1 |
| **Mnemopi → ContextPipeline** | Mnemopi 成为 ContextSource（现在已有 MnemopiSource，扩展到所有 agent 类型） | 🟡 适配 | P1 |
| **Hindsight → ContextPipeline** | buildDeveloperInstructions → HindsightSource | 🟡 适配 | P1 |
| **Subagent → ContextPipeline** | executor 复用 ContextPipeline 替代硬编码模板 | 🟢 扩展 | P1 |
| **TUI → Component 模型** | swarm/tui/ 实现 pi-tui Component 接口 + 声明式绑定 | 🟢 重构 | P1 |
| **Curtain → Mental Model** | error >3次 → createMentalModel | 🔵 触发 | P2 |
| **Main ↔ Swarm TUI** | 声明式视图切换 | 🔵 新增 | P2 |
| **Memories Phase 2 → Pipeline** | 浓缩产物作为 ContextSource | ⚪ 整合 | P3 |

### 核心哲学

> **建立清晰的层次关系和单向数据流，让每个系统在自己擅长的层次上工作，同时让数据自由流动。ContextPipeline 是这个架构中唯一应该成为「统一入口」的地方。**
