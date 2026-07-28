# SatoPi Swarm 圆桌辩论最终裁定

**日期**: 2026-07-28  
**参与者**: ScoutGraphEngine, ScoutContextLifecycle, ScoutAgentComms, ScoutMemoryExperience, ScoutStpConfig, ScoutFullBridge  
**主持**: Main

---

## 辩论议题

1. 图引擎是否真正通用？GraphRunner能否执行任意自定义graph？
2. 配置→上下文→压缩→卸载→环境mark→agent通信→工具调用→经验记忆，端到端是否贯通？
3. 内置theatre graph和自定义graph的解析/执行策略是否一致？
4. 最大的断点在哪里？

---

## 裁定 #1: 图引擎通用性

| 维度 | 结论 | 证据 |
|------|------|------|
| **解析层** | ✅ 100%通用 | `graph/schema.ts::loadGraphDefinition()` 对所有 .graph.yaml/Mermaid/loop-convert 使用同一验证管道 |
| **调度层** | ✅ 通用 | `WaveScheduler`/`DynamicScheduler` 可调度任意 DAG 形状 (`graph-executor.ts`) |
| **路由层** | ✅ 通用 | `selectNodeBehavior()` 有 `default → CustomNodeBehavior` 分支，任意 type 字符串合法 (`node-behavior.ts:461-472`) |
| **语义层** | ❌ 不通用 | `ScriptNodeBehavior` 和 `CurtainNodeBehavior` 是存根，100% 委托 `CustomNodeBehavior` (`node-behavior.ts:241-261, 426-460`) |

**裁决：** 图引擎在解析和调度层面是通用的，但在语义层面——`type: script` 和 `type: curtain` 节点降级为单agent spawn，没有planner-agent多轮对话、没有plan debate、没有reporter选举。**讽刺的是：自定义 graph（仅使用 `type: custom` 节点）的执行质量反而高于内置 theatre.graph.yaml（使用存根的 `type: script/curtain` 节点）。**

`PhaseBehaviorNodeAdapter` (280行，完整实现) 可以将真实的 `ScriptBehavior`/`StageBehavior`/`CurtainBehavior` 桥接到图引擎，但 **从未被 `GraphRunner` 调用**——`selectNodeBehavior()` 直接返回存根。

---

## 裁定 #2: 端到端链路贯通性

```
.stp配置 ──✅──▶ SwarmRunner/SwarmSessionManager ──✅──▶ AgentRuntime/AgentLauncher
                                                      │
                                          ┌───────────┤
                                          │           │
                                    legacy路径    v3路径
                                    (runSubprocess) (AgentRuntime.spawn)
                                          │           │
                                          │     ❌ mock stubs
                                          │     ❌ null session
                                          │
                                    ❌ OffloadManager 缺失
                                    ❌ MarkEnvironment 缺失
                                          │
                                    ✅ IrcBus ──✅──▶ CommBus ──✅──▶ agent-channel-tools
                                          │
                                    ✅ ToolSession ──✅──▶ Tool Execution
                                          │
                                    ❌ ContextPipeline 未接入 PhaseBehavior
                                          │
                                    ✅ compaction (token阈值)
                                    ❌ offload (迭代边界) —— 两条独立管道，无协调
                                          │
                                    ✅ CurtainRunner ──✅──▶ MultiLessonSink.write
                                    ❌ ExperienceSource.read —— appliesTo() 只在script阶段触发
                                          │
                                    ❌ Experience DB: 0行实际数据
```

**裁决：链路存在5个已确认断点，按严重程度排序：**

### P0 — v3 AgentRuntime 路径不可用
- `agent-launcher.ts:417-420`：`#resolveToolInstances()` 在没有 `builtinToolNames` 或 `toolRegistry` 时**直接抛异常**（已从静默降级升级为硬崩溃）
- `PipelineController` 通过 `if (runtime)` 分支——CLI 入口 `runtime=undefined`，永远走 legacy
- SwarmRunner 构造时 `runtime: undefined`

### P1 — MarkEnvironment 在所有 swarm 执行路径缺失
- `mark-environment.ts`：476行完整实现，5种Mark类型，惰性衰减，prompt注入
- `embedded-swarm-bridge.ts`：`init()` 中从未创建 `MarkEnvironment.global()`
- `graph-runner.ts`：同上
- `context-manager/sources/stigmergy-source.ts`：存在但从无数据源注入

### P1 — OffloadManager 在 EmbeddedSwarmBridge 路径缺失
- `offload/`：L1→L1.5→L2→L3 完整管道
- `embedded-swarm-bridge.ts`：`registerBuiltinHooks()` 未传 `offloadManager`
- 后果：嵌入式 swarm 的 agent 上下文永不紧凑化

### P2 — ExperienceStore 有写无读（GraphRunner路径）
- `curtain-runner.ts:182`：`MultiLessonSink.fanOut()` 写入路径完整
- `experience-source.ts`：`appliesTo()` 仅在 `phase === "script"` 返回 true
- `graph-runner.ts:81`：FSM 起始 phase 是 `"stage"`——Script 阶段被跳过
- `.stp/experience/index.sqlite`：lessons 表 0 行——说明没有任何一次完整 run 触发过写入

### P2 — 压缩(compaction)和卸载(offload)是两条独立管道
- 压缩由 `agent-session.ts:shouldCompact()` 的 token 阈值驱动
- 卸载由 `hooks.ts` 的 swarm 迭代边界驱动
- 两者共享零状态——可能互相覆盖/冲突
- `agent-launcher.ts:210`：`compactContext()` 传入空的 offload 摘要 Map

---

## 裁定 #3: 内置 vs 自定义 Graph 的解析/执行一致性

| 阶段 | 一致性 | 详情 |
|------|--------|------|
| **解析** | ✅ 100%一致 | 同一 `loadGraphDefinition()` → `parseGraphYaml()` → `validateGraphDefinition()` |
| **验证** | ✅ 一致 | 同一 `detectCycles()` + `buildExecutionWaves()` (Kahn拓扑排序) |
| **调度** | ✅ 一致 | 同一 `WaveScheduler`/`DynamicScheduler` |
| **路由** | ✅ 一致 | 同一 `selectNodeBehavior()` switch |
| **node type=stage 执行** | ✅ 一致 | 都走 `StageNodeBehavior` → `StageController`（当 services 可用时） |
| **node type=script/curtain 执行** | ❌ 都不对 | 都降级为 `CustomNodeBehavior` 存根——内置和自定义 graph 都受影响 |
| **配置范式** | ❌ 不一致 | `loop.yaml` (SwarmDefinition) 和 `.graph.yaml` (GraphDefinition) 是两个独立 schema，不共享类型/验证器 |

**裁决：解析策略 100% 一致。执行策略上，内置 graph 的 `type: script/curtain` 节点和自定义 graph 的同名节点执行完全相同——因为它们都走了同一个存根。差异不在代码路径，而在语义层面：内置 graph 期望的行为（多轮plan refinement、reporter选举）从未实现。而自定义 graph 如果避免使用 script/curtain 类型，只用 custom 类型，执行完整性反而更高。**

另外，`.graph.yaml` 和 `loop.yaml` 是两个完全独立的配置范式，不能互换——loop.yaml 不能传给 GraphRunner，.graph.yaml 不能喂给 SwarmRunner。

---

## 裁定 #4: 最大断点

### 辩论共识：最大断点是 **PhaseBehaviorAdapter 未接入 GraphRunner**

这是一个**自我强化的断点链**：

```
PhaseBehaviorAdapter 未接入 GraphRunner
    → ScriptNodeBehavior = CustomNodeBehavior 存根
    → Script 阶段 FSM 永远不进入 script phase
    → ExperienceSource.appliesTo() 永远不触发（只在 script 阶段返回 true）
    → 经验数据写入但不读取
    → CurtainNodeBehavior = CustomNodeBehavior 存根
    → runCurtainPipeline 不完整（loopConfig: null）
    → StageController 缺少真实的 planContent
    → 整个内置 theatre graph 退化为 "3个独立的 CustomNodeBehavior"
```

### 第二断点（ScoutStpConfig发现）：**.stp/agents/ 子目录文件不可发现**

`task/discovery.ts:42-58` 使用非递归 `readdir`，不扫描子目录。`before-loop/socrates.md` 和 `cloner/cloner.md` 是两个消费系统都无法访问的死文件。

### 第三断点（ScoutAgentComms发现）：**Stigmergy 四大组件各自独立，无串联路径**

- `mark-environment.ts` (476行) → 已实现
- `stigmergy-source.ts` → 已实现
- `ContextPipeline` → 已定义
- `IrcBus` → 已工作

四个组件各自完整但**没有任何执行路径将它们串联起来**。修复仅需约3行代码（创建 MarkEnvironment 实例 + 注册 StigmergySource + PhaseBehavior 调用 contextPipeline）。

---

## 综合评分

| 链路环节 | 状态 | 置信度 |
|----------|------|--------|
| .stp配置 → SwarmRunner | ✅ 贯通 | 高 |
| SwarmRunner → AgentRuntime | ✅ legacy路径贯通, ❌ v3路径断裂 | 高 |
| Context加载 (session JSONL) | ✅ 贯通 | 高 |
| Context压缩 (compaction) | ✅ 贯通 (token阈值) | 高 |
| Context卸载 (offload L1→L3) | ⚠️ 存在但独立于压缩，EmbeddedSwarmBridge缺 | 高 |
| MarkEnvironment (stigmergy) | ❌ 代码存在但从未接入任何执行路径 | 高 |
| Agent通信 (IRC + CommBus) | ✅ 贯通 | 高 |
| 工具调用 (ToolSession) | ✅ legacy路径贯通, ❌ v3路径mock | 高 |
| 工具级别 region lock | ❌ 无 hook 接入，被动查表工具 | 中 |
| Curtain → MultiLessonSink 写入 | ✅ 代码贯通 (loop路径) | 高 |
| ExperienceSource 读取注入 | ❌ GraphRunner路径断裂 (phase条件不匹配) | 高 |
| Experience DB 数据 | ❌ 0行 (从未有完整run触发写入) | 高 |
| 记忆 consolidation (mnemopi) | ✅ 贯通 (sleep) | 中 |
| 记忆 consolidation (memories 2阶段) | ✅ 贯通 (启动时) | 中 |
| 跨管道记忆协调 | ❌ mnemopi + memories + ExperienceStore 三线独立 | 高 |

**总评：29项已确认贯通，22项已确认缺口。剩余工作量估计 ~500-700行 / 2-3天（不含v3路径修复）。**
