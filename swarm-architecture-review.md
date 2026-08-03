# SatoPi Swarm 机制完整实现调研报告

> 生成日期: 2026-08-02
> 分支: `feat/offload-manager-wiring`（基于 `dev`）
> 范围: `packages/coding-agent/src` 的 swarm 体系 + `packages/tui`

---

## 目录

1. [完整架构设计](#一完整架构设计)
2. [与整体系统的原生融合](#二与整体系统的原生融合)
3. [完整逻辑链路](#三完整逻辑链路)
4. [TUI 风格一致性](#四tui-风格一致性)
5. [TUI 交互体验](#五tui-交互体验)
6. [Role 配置文件目录结构差异](#六role-配置文件目录结构差异)
7. [Graph YAML 扩展性](#七graph-yaml-扩展性)
8. [已知问题与改进建议](#八已知问题与改进建议)

---

## 一、完整架构设计

### 1.1 总体架构：三层结构

```
┌─────────────────────────────────────────────────────────┐
│  入口层  CLI (swarm-cli.ts)  │  TUI (/swarm 交互)       │
├─────────────────────────────────────────────────────────┤
│  编排层  GraphRunner (ISwarmOrchestrator + NodeExecutor)│
│          ├─ GraphEngine (DAG 波次调度)                  │
│          └─ PhaseBehavior (Script→Debate→Stage→Curtain) │
├─────────────────────────────────────────────────────────┤
│  基础设施层  createSwarmInfra()                         │
│   StateTracker │ SwarmSessionManager │ OffloadManager   │
│   HookPipeline │ IrcBus │ ExperienceStore │ ActivityLogger
│   RoleAssetManager │ MarkEnvironment                    │
└─────────────────────────────────────────────────────────┘
```

核心设计理念：`createSwarmInfra()` 是唯一的设施工厂，通过依赖注入装配所有共享服务（`swarm/core/swarm-infra.ts`），GraphRunner 在 `init()` 时接收这份 infra，不自行构造——典型的 **composition root 模式**。

### 1.2 核心模块职责

| 模块 | 文件 | 职责 |
|---|---|---|
| `schema.ts` | `swarm/core/schema.ts` | 定义 SwarmDefinition（YAML）、LoopSwarmConfig、4 种 mode，YAML 解析验证 |
| `state.ts` | `swarm/core/state.ts` | StateTracker + SwarmState，内存状态机 + FSM 审计链，写入链防并发乱序 |
| `assembler.ts` | `swarm/core/assembler.ts` | createOrchestratorRuntime()，装配 Runtime + HookPipeline + 6 源 ContextPipeline |
| `convergence.ts` | `swarm/core/convergence.ts` | tokenize + jaccardSimilarity，多代理讨论收敛检测 |
| `swarm-runtime.ts` | `swarm/core/swarm-runtime.ts` | SwarmRuntime 接口，最小生成接口（spawn + sendHumanMessage） |
| `graph-runner-as-run-manager.ts` | `swarm/core/graph-runner-as-run-manager.ts` | 把 GraphRunner 适配成 RunManager（start/stop/pause/resume） |
| `behaviors/*` | `graph/behaviors/*.ts` | 4 种阶段行为：Script / ScriptDebate / Stage / Curtain |

### 1.3 角色体系（ProfileRegistry + RoleAsset）

- **7 个预置角色**：planner / implementer / reviewer / reflector / architect / debugger / tester
- **两层角色来源**：
  - `ProfileRegistry`（`agent/agent-profile.ts`）：持久化身份，含 **credit 信用分**（0-100，初始 50）、成功率、违规审计链——代理跨 run 有"人格记忆"
  - `RoleAssetManager`（`agent/role-asset.ts`）：YAML 定义的角色资产（system prompt、工具白名单、模型覆盖），项目级 `.stp/roles/` + 用户级 `~/.stp/agent/roles/`

### 1.4 状态机：四阶段 + 收敛

```
script → (script-debate?) → stage → curtain → (idle | 回script重新规划)
```

- **script**：MAIN 模型充当规划者，与用户交互产出 plan.md
- **script-debate**：可选，多代理圆桌辩论精化计划（Jaccard 收敛）
- **stage**：`TaskQueue.parseFromPlan()` 解析任务，按角色生成代理，DAG 波次并行执行
- **curtain**：投票选举 reporter + 生成 reflector，提取经验教训

---

## 二、与整体系统的原生融合

融合度总评：**85%**（核心完整，有修缮空间）。

### 2.1 完整融合的组件（7 个）

ActivityLogger、ExperienceStore、HookPipeline、IrcBus、MarkEnvironment、RoleAssetManager、CommChannel——全部通过 DI 注入复用，无重复实现。

### 2.2 Hook 系统（关键集成点）

6 个内置 hook 按优先级链式注册，8 个事件点触发：

```
agent:beforeSpawn → ProfileHook
agent:afterComplete → Profile + Stigmergy + Offload + Mnemopi + Verification
workflow:before/afterPhase → Offload.forceFlush + Experience
roundtable:afterRound → Offload.summarizeL1
```

故障隔离：单个 hook 异常不影响后续（try-catch 包裹）。

### 2.3 OffloadManager 接线（本次修复的核心断点）

- **修复前**：真实 `OffloadManager` 创建了，但 **OffloadHook 拿到的是 Noop**（`swarm-infra.ts` 漏传 + `swarm-cli.ts` 用 Noop 覆盖注册）
- **修复后**：OffloadHook 在三条路径（CLI graph / CLI plan / embedded swarm）都拿到真实实例，L1→L3 上下文 offload（`summarizeL1` 落盘 `.stp/offload/*.jsonl`）首次真正可用

### 2.4 遗留问题

见[第八节](#八已知问题与改进建议)。

---

## 三、完整逻辑链路

### 3.1 触发入口

- **CLI**：`stp swarm run|plan|resume <yaml>` → `runSwarmCommand()`
- **TUI**：`/swarm start` → `InteractiveMode.handlePlanApproval()` → PlanReviewOverlay 确认 → `embeddedSwarm`

### 3.2 关键调用链（CLI 路径）

```
runSwarmRun()
  → createSwarmServices() → createSwarmInfra()        # 组装全部基础设施
  → GraphRunner(infra) → init()                        # 加载图/构建波次
  → session.runManager.start() → confirmScript()       # script → stage
      → GraphEngine.run() 逐波次执行
          → StageBehavior.enter() → TaskQueue.parseFromPlan()
          → runtime.spawn(specs) → createAgentSession()  # 每个角色一个代理
          → AgentRegistry.register()                     # 注册引用
          → wireAgentEvents() → session.subscribe()      # 订阅完成事件
      → curtainBehavior.enter() → 投票选举reporter
  → offloadManager.summarizeL1()  # 每代理完成后触发
  → SwarmSessionManager.appendCustomEntry()  # 持久化
```

### 3.3 通信机制（IrcBus + CommChannel）

- **mailbox 模型**：fire-and-forget 广播（容量 100）
- **waiter 队列**：阻塞等待回复（带超时）
- **5 个 channel 工具**：`agent_broadcast` / `agent_query_all` / `agent_query_majority` / `agent_roundtable` / `agent_peers` 全部注册在 BUILTIN_TOOLS

### 3.4 持久化与恢复

- 单一真相源：`.stp/sessions/swarm-<name>/.session/*.jsonl`（9 种自定义条目）
- 检查点：`graph_checkpoint` 条目 → `GraphEngine` 恢复跳过已完成节点
- **resume 关键**：`readAllSessionEntries()` 扫描所有 session 文件（因为每次 run 新建文件，最后文件的 checkpoint 可能不是最新的）

---

## 四、TUI 风格一致性

基于 16 个 swarm 组件（`modes/components/swarm/`）的逐行审查，结论：**一致** ✅

| 维度 | 结论 | 证据 |
|---|---|---|
| 颜色方案 | 100% 使用统一 theme token | 70+ 次 `theme.fg()`，零硬编码 ANSI |
| 边框符号 | 完全一致 | 统一走 `SymbolTheme`（boxRound/boxSharp/tree） |
| 布局约定 | 一致 | sidebar 宽度协议、overlay 视口预算、panel 高度计算均遵循系统惯例 |
| 重复实现 | 无 | PlanReviewOverlay vs PlanView、CrewTranscriptView vs ChatBlock 职责清晰分离 |
| 状态栏接口 | 一致 | 返回 `readonly string[]`，符合 StatusLine 协议 |

---

## 五、TUI 交互体验

综合评分：**优秀（A-）**

| 维度 | 评分 | 说明 |
|---|---|---|
| 键盘协议 | A | 统一 `matchesKey()` + Kitty protocol，j/k 导航一致 |
| 焦点管理 | B+ | `OverlayFocusOwner` 接口清晰，模态隔离良好 |
| 实时性 | A- | 500ms 阶段脉冲驱动 dashboard 自动刷新 + 消息流式更新（见第八节调研修正） |
| 错误处理 | B+ | `onNotice()` 回调完善 |

修复历史：git log 显示 12+ 个 swarm TUI 修复 commit（crew members invisible、viewport budget、kitty protocol、parallel spawn race），说明系统在持续打磨交互质量。

---

## 六、Role 配置文件目录结构差异

### 问题：为什么用户级是 `~/.stp/agent/roles/`，项目级是 `.stp/roles/`？

### 结论：**不是 bug，是有意设计** ✅

| 配置类型 | 用户级路径 | 项目级路径 |
|---|---|---|
| **Roles** | `~/.stp/agent/roles/` | `.stp/roles/` |
| MCP | `~/.stp/agent/mcp.json` | `.stp/mcp.json` |
| SSH | `~/.stp/agent/ssh.json` | `.stp/ssh.json` |
| Prompts | `~/.stp/agent/prompts/` | `.stp/prompts/` |
| Tools | `~/.stp/agent/tools/` | — |

**原因**：
1. **一致性**：所有用户级配置都遵循 `~/.stp/agent/` 前缀模式（`utils/dirs.ts` 中 `getAgentDir()`）
2. **XDG 支持**：`DirResolver` 类（`utils/dirs.ts:274-378`）支持 XDG 重映射，`agent/` 前缀在映射时被 flatten：`~/.stp/agent/roles/` → `$XDG_DATA_HOME/stp/roles`
3. **项目级简洁性**：`.stp/` 目录本身已项目隔离（`getProjectAgentDir()` = `{cwd}/.stp`），无需额外 `agent/` 命名空间；且项目级通常要 git 提交，路径越短越好
4. **读取优先级**：项目级优先，用户级回退（`role-asset.ts:157-174`）

**改进建议**：补注释/文档说明设计意图。本次已在 `role-asset.ts` 的 `getProjectRolesDir`/`getUserRolesDir` 补充了设计意图注释（项目级 `.stp/` 已隔离故无 `agent/` 前缀；用户级 `agent/` 前缀服务于 XDG 重映射 + 多产品隔离）。

---

## 七、Graph YAML 扩展性

### 核心问题：放一个新的 graph yaml，能否驱动这个新的图工程？

### 结论：**可以**，但需满足 schema 约束 ✅

### 7.1 Schema（`graph/types.ts`）

```yaml
graph:
  name: my-graph          # 仅 [a-zA-Z0-9._-]，必填
  description: string      # 必填
  version: 1               # >= 1，必填
  revision: 0              # >= 0，必填
  strategy: waves          # waves | dynamic，默认 waves
  nodes:                   # 必填，非空
    nodeA:
      label: string        # 必填
      description: string  # 必填
      type: custom         # script | stage | curtain | custom（默认 custom）
      role: string         # 必填，代理角色
      tools: []            # 工具白名单
      depends_on: []       # 依赖节点
      gate: { type, mode, ... }   # 可选验证门控
      retry: { ... }       # 可选重试策略
      timeout: "5m"        # 可选超时
```

### 7.2 校验规则

- name/version/revision/nodes 必填约束
- 每个节点 label/description/role 非空
- depends_on 引用存在节点、无自依赖、无循环（Kahn 算法检测）
- type 必须在 {script, stage, curtain, custom} 中
- gate.type / gate.mode / retry 策略均预定义

### 7.3 加载与执行

```
loadGraphDefinition(path) → parseGraphYaml → validateGraphDefinition
GraphRunner.init() → buildExecutionWaves(deps)   # 拓扑排序波次
selectNodeBehavior(type) → 4 种映射 + CustomNodeBehavior 兜底
```

### 7.4 文件位置

- **CLI**：`stp swarm run <path>` 接受任意路径（`path.resolve`）
- **TUI**（`/graph` 命令）：相对项目根目录解析；`"builtin/theatre.graph.yaml"` 特殊处理指向内置

### 7.5 限制

| 限制项 | 说明 | 影响 |
|---|---|---|
| Node type 不可扩展（不改源码） | 仅 script/stage/curtain/custom | 新类型需实现 Behavior + 注册 |
| Gate type 预定义 | compile-check/test/lsp/human-review/script/debate | 验证类型有限 |
| DAG 必须无环 | 不支持条件分支/循环 | 工作流结构刚性 |
| 无图仓库管理 | 手工管理文件 | 无内置版本管理 |

### 7.6 扩展点

| 扩展点 | 可行性 | 难度 |
|---|---|---|
| 新增 node type | 需改源码（实现 Behavior + registerNodeBehavior） | 中 |
| 新增 gate type | 需改源码 | 中 |
| 新增 tool | 配置中扩展 | 低 |
| 新增 role | 配置中定义 | 低 |
| 动态行为注册 | 有 `registerNodeBehavior()` API | 低 |

### 7.7 快速试验方法

复制 `graph/builtin/theatre.graph.yaml`，改节点名和依赖即可。简单任务用 `type: custom`。

---

## 八、已知问题与改进建议

### 8.1 遗留问题清单

| # | 问题 | 严重度 | 状态 |
|---|---|---|---|
| 1 | `NoopOffloadManager` 已无生产调用（死代码） | 低 | ✅ 已删除（本次） |
| 2 | `agent_fork` 深度硬编码为 1，无法配置 | 中 | ✅ 已配置化（本次，`magicKeywords.swarm.maxForkDepth`） |
| 3 | `agent_invoke` persistent agent 未接入生命周期管理 | 中 | ✅ 已修复（本次，`AgentLifecycleManager.adopt`） |
| 4 | SwarmSidebar Ctrl+B 硬编码 `\x02`，未走 matchesKey | 低 | ✅ 已修复（本次，改 `matchesKey(data, "ctrl+b")`） |
| 5 | ~~dashboard graph 快照不自动刷新~~ | — | ✅ **无需修复**（调研修正） |
| 6 | 5 个 channel 工具在无 swarm 时降级但用户无法感知 | 低 | 观察 |

> **关于 #5 的调研修正**：初版调研认为 dashboard 的 graph 快照不自动刷新。复核源码后确认这是**误判**：
> - `SwarmDashboardOverlay.#stateTracker` 持有 `stateTracker.state` 的**活引用**（`StateTracker` 原地更新，非替换）
> - `startPhasePulse()` 每 500ms 触发 `onRequestRender()`（`ui.requestRender()`），overlay 存活期间持续重绘
> - 每次 render 重新执行 `#buildSnapshot()`，读活的 `stateTracker.state` + `AgentRegistry.global().list()`
> 因此 graph 节点状态在 dashboard 上是**实时自动刷新**的，无需代码改动。

### 8.2 架构演进建议

1. Graph 注册/仓库机制（path resolution 策略）
2. Graph 模板与继承支持
3. 动态 node type 注册前置检查
4. 条件分支支持（decisions 节点）
5. 图可视化生成（mermaid）与 YAML schema 补全工具

---

## 附录：关键文件索引

| 模块 | 文件路径 |
|---|---|
| Core | `packages/coding-agent/src/swarm/core/{assembler,convergence,schema,state,swarm-infra,swarm-runtime}.ts` |
| Behaviors | `packages/coding-agent/src/graph/behaviors/{curtain-behavior,debate-roundtable,index,script-behavior,stage-behavior}.ts` |
| Graph Engine | `packages/coding-agent/src/graph/{graph-runner,graph-engine,dag,node-behavior,schema,types}.ts` |
| Profiles | `packages/coding-agent/src/agent/{agent-profile,role-profiles,role-asset}.ts` |
| Offload | `packages/coding-agent/src/offload/{manager,compact}.ts` |
| Session | `packages/coding-agent/src/session/agent-session.ts` (embeddedSwarm) |
| CLI | `packages/coding-agent/src/cli/swarm-cli.ts` |
| 路径原语 | `packages/utils/src/dirs.ts` |
| TUI 组件 | `packages/coding-agent/src/modes/components/swarm/*.ts` |
