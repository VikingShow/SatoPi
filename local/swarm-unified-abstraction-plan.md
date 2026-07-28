# SatoPi Swarm 统一抽象层 — 长期优化方案

**日期**: 2026-07-28  
**基于**: 6-agent 圆桌辩论裁定 + 源码审计  
**目标**: 将 legacy PhaseBehavior 全量迁移到 GraphEngine，使内置 theatre graph 和用户自定义 graph 通过同一抽象层执行

---

## 一、现状诊断

### 1.1 已有的正确抽象

```
                    ┌──────────────────────┐
                    │   NodeBehavior (I)    │  ← 图引擎通用接口
                    │ prepare/execute/      │
                    │ validate/cleanup      │
                    └──────┬───────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     CustomNodeBehavior  StageNodeBehavior  PhaseBehaviorNodeAdapter
     (✅ 完整)           (⚠️ 部分)          (✅ 完整但未接入)
                              │                    │
                              │            ┌───────┴───────┐
                              │            │  PhaseBehavior │  ← 遗留行为接口
                              │            │ enter/exit/    │
                              │            │ checkCompletion│
                              │            └───────┬───────┘
                              │        ┌───────────┼───────────┐
                              │   ScriptBehavior  StageBehavior CurtainBehavior
                              │   (✅ 完整实现)   (✅ 完整实现)  (✅ 完整实现)
```

**关键发现**: `PhaseBehaviorNodeAdapter` (280行, `phase-behavior-adapter.ts`) 已经完美桥接 `PhaseBehavior` → `NodeBehavior`。三个 `PhaseBehavior` 实现（ScriptBehavior, StageBehavior, CurtainBehavior）都是完整可用的。问题只在 `selectNodeBehavior()` 没有返回它们。

### 1.2 当前断点链

```
selectNodeBehavior("script")  → ScriptNodeBehavior  → CustomNodeBehavior 存根
selectNodeBehavior("curtain") → CurtainNodeBehavior  → CustomNodeBehavior 存根

PhaseBehaviorNodeAdapter(new ScriptBehavior())  ← 存在但从未被 selectNodeBehavior 返回
PhaseBehaviorNodeAdapter(new CurtainBehavior()) ← 同上
```

**根因**: `selectNodeBehavior()` 是一个无参数的纯工厂函数，无法获取构造 `PhaseBehaviorNodeAdapter` 所需的 `PhaseContext` 服务。

### 1.3 缺失的服务注入

`NodeContext` 当前有 11 个字段，但 `PhaseContext` 需要 12 个字段。差异：

| PhaseContext 字段 | NodeContext 对应 | 状态 |
|---|---|---|
| `fsm: WorkflowFsm` | ❌ 无 | 缺失 |
| `commBus: CommBus` | ❌ 无 (runtime 内部持有) | 需从 runtime 提取 |
| `runtime: AgentRuntime` | ✅ `runtime` | 已有 |
| `contextPipeline: ContextPipeline` | ❌ 无 | 缺失 |
| `hookPipeline: HookPipeline` | ❌ 无 | 缺失 |
| `stateTracker: StateTracker` | ✅ `stateTracker` (optional) | 已有 |
| `activityLogger: ActivityLogger` | ✅ `activityLogger` (optional) | 已有 |
| `workspace: string` | ✅ `workspace` | 已有 |
| `swarmDir: string` | ❌ 无 | 缺失 |
| `planContent?: string` | ❌ 无 | 需从 upstream 提取 |
| `loopConfig: LoopSwarmConfig` | ❌ 无 | 缺失 |
| `signal: AbortSignal` | ✅ `signal` | 已有 |

---

## 二、方案设计：三步统一

### 阶段 A: 统一工厂（~200行，1天）

**目标**: `selectNodeBehavior()` 可以返回真实的 `PhaseBehaviorNodeAdapter` 包装的 PhaseBehavior。

#### A1: 扩展 `selectNodeBehavior` 为工厂函数

```typescript
// 当前 (node-behavior.ts:461-472)
export function selectNodeBehavior(type?: string): NodeBehavior {
    switch (type) {
        case "script":  return new ScriptNodeBehavior();   // 存根!
        case "stage":   return new StageNodeBehavior();
        case "curtain": return new CurtainNodeBehavior();  // 存根!
        default:        return new CustomNodeBehavior();
    }
}

// 目标: 接受服务配置，对内置类型返回 PhaseBehaviorNodeAdapter
export interface NodeBehaviorFactoryConfig {
    runtime: AgentRuntime;
    fsm: WorkflowFsm;
    hookPipeline: HookPipeline;
    contextPipeline: ContextPipeline;
    workspace: string;
    swarmDir: string;
    loopConfig: LoopSwarmConfig;
    markEnvironment?: MarkEnvironment;
}

export function selectNodeBehavior(
    type: string | undefined,
    config: NodeBehaviorFactoryConfig,
): NodeBehavior {
    switch (type) {
        case "script":
            return new PhaseBehaviorNodeAdapter(
                new ScriptBehavior(), config
            );
        case "stage":
            return new PhaseBehaviorNodeAdapter(
                new StageBehavior(), config
            );
        case "curtain":
            return new PhaseBehaviorNodeAdapter(
                new CurtainBehavior(), config
            );
        default:
            return new CustomNodeBehavior();
    }
}
```

#### A2: 扩展 `PhaseBehaviorNodeAdapter` 接收服务配置

当前 adapter 通过 `execute(ctx)` 的 `ctx.phaseContext` 获取 PhaseContext。改为在构造时接收核心服务，`execute()` 时用 NodeContext 补充剩余字段拼装完整 PhaseContext：

```typescript
export class PhaseBehaviorNodeAdapter implements NodeBehavior {
    constructor(
        behavior: PhaseBehavior,
        private config: NodeBehaviorFactoryConfig,
    ) { ... }

    async execute(ctx: NodeContext, _prepared: PreparedNode): Promise<NodeResult> {
        // 从 NodeContext + 构造时 config 拼装完整 PhaseContext
        const phaseCtx: PhaseContext = {
            fsm: this.config.fsm,
            commBus: this.config.runtime.commBus,
            runtime: this.config.runtime,
            contextPipeline: this.config.contextPipeline,
            hookPipeline: this.config.hookPipeline,
            stateTracker: ctx.stateTracker!,
            activityLogger: ctx.activityLogger!,
            workspace: ctx.workspace,
            swarmDir: this.config.swarmDir,
            planContent: this.#extractPlanFromUpstream(ctx),
            loopConfig: this.config.loopConfig,
            signal: ctx.signal,
        };

        const result = await this.#behavior.enter(phaseCtx);
        // ... 同现有逻辑
    }
}
```

#### A3: 更新 `GraphRunner.confirmScript()` 传入 config

```typescript
// graph-runner.ts:221 — 当前
const behavior = selectNodeBehavior(node.type);

// 改为
const behavior = selectNodeBehavior(node.type, {
    runtime: this.#runtime,
    fsm: this.#fsm,
    hookPipeline: this.#hookPipeline,
    contextPipeline: this.#runtime.contextPipeline,
    workspace: this.#config.workspace,
    swarmDir: this.#swarmDir,
    loopConfig: defaultLoopConfig,
    markEnvironment: this.#markEnv,
});
```

#### A4: 删除存根类

完成 A1-A3 后，`ScriptNodeBehavior` 和 `CurtainNodeBehavior` 成为死代码，可以删除。`StageNodeBehavior` 保留作为不依赖 PhaseBehavior 的备选路径（当前已部分实现）。

### 阶段 B: 补齐缺失服务（~300行，1.5天）

**目标**: GraphRunner 和 EmbeddedSwarmBridge 路径都拥有完整的服务注入。

#### B1: 创建 MarkEnvironment 并接入 GraphRunner

```typescript
// graph-runner.ts init() 中新增
import { MarkEnvironment } from "../../coordination/mark-environment";

this.#markEnv = new MarkEnvironment();

// 注册 StigmergySource 到 ContextPipeline
this.#runtime.contextPipeline.register(
    new StigmergySource(this.#markEnv)
);
```

#### B2: 创建 MarkEnvironment 并接入 EmbeddedSwarmBridge

```typescript
// embedded-swarm-bridge.ts init() 中新增
this.#markEnv = new MarkEnvironment();
this.#runtime.contextPipeline.register(
    new StigmergySource(this.#markEnv)
);
```

#### B3: 创建 OffloadManager 并接入 EmbeddedSwarmBridge

```typescript
// embedded-swarm-bridge.ts init() 中新增
import { OffloadManager } from "../../offload/manager";

this.#offloadManager = new OffloadManager({
    storage: this.#sessionStorage,
    workspace: this.#config.workspace,
});

// 注册 OffloadSource 到 ContextPipeline
this.#runtime.contextPipeline.register(
    new OffloadSource(this.#offloadManager)
);

// 传入 registerBuiltinHooks
registerBuiltinHooks(this.#hookPipeline, {
    ...existingHooks,
    offloadManager: this.#offloadManager,
});
```

#### B4: 修复 ExperienceSource 阶段过滤

```typescript
// experience-source.ts:27-29 — 当前
appliesTo(phase: Chapter, _agentRole: string): boolean {
    return phase === "script" || phase === "script-debate";
}

// 改为 — 同时在 script 和 stage 阶段注入经验
appliesTo(phase: Chapter, _agentRole: string): boolean {
    return phase === "script" || phase === "script-debate" || phase === "stage";
}
```

#### B5: 补齐 NodeContext.experience 字段

```typescript
// graph-runner.ts:236 — 当前硬编码空字符串
experience: "",

// 改为 — 从 ExperienceStore 搜索
experience: this.#buildExperienceContext(node),
```

### 阶段 C: 管道整合（~200行，0.5天）

**目标**: 压缩(compaction)和卸载(offload)管道共享状态，不再独立运行。

#### C1: Compaction 感知 Offload

```typescript
// offload/compact.ts — compactContext() 当前接收空的 offload 摘要 Map
// 改为接受 OffloadManager，在实际压缩前查询最近摘要

export function compactContext(
    messages: AgentMessage[],
    offloadManager: OffloadManager,  // 新增参数
    config: CompactConfig,
): CompactResult {
    const summaries = offloadManager.getRecentSummaries(50);
    // 用 summaries 替换过时的 tool results（Mild tier）
    // 同现有 compactContext 逻辑，但 summaries 不再为空
}
```

#### C2: Offload 感知 Compaction 边界

```typescript
// offload/pipeline/pipeline.ts — 在 L2 合成时跳过已被 compaction 删除的消息
// 通过 shared CompactionState 传递 firstKeptEntryId
```

#### C3: 统一 Memory 写入路径

```typescript
// curtain/curtain-runner.ts — MultiLessonSink.fanOut() 后
// 同时触发 memories/index.ts 的 enqueueMemoryConsolidation()
// 确保 ExperienceStore 写入后立即同步到 memory_summary.md
```

---

## 三、整体架构（目标态）

```
                        ISwarmOrchestrator
                       ╱                  ╲
            EmbeddedSwarmBridge      GraphRunner
            (magic keyword)         (theatre graph)
                    │                      │
                    └──────────┬───────────┘
                               │
                    ┌──────────┴──────────┐
                    │  selectNodeBehavior  │  ← 统一工厂
                    │  (type, config)      │
                    └──────────┬──────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
     custom                script/stage/curtain
            │                  │
     CustomNodeBehavior  PhaseBehaviorNodeAdapter
     (完整)              │
                ┌────────┴────────┐
                │   PhaseBehavior  │
                │ enter/handle/    │
                │ check/exit       │
                └────────┬────────┘
                         │
            ┌────────────┼────────────┐
     ScriptBehavior  StageBehavior  CurtainBehavior
     (完整 planner)  (完整 worker)  (完整 reporter)

     ───────────────────────────────────────────
     所有节点类型共享同一 ContextPipeline:
     ┌─────────────────────────────────────────┐
     │ ContextPipeline                         │
     │  ├─ ExperienceSource (经验注入)          │
     │  ├─ StigmergySource  (环境信号)          │
     │  ├─ OffloadSource    (上下文摘要)        │
     │  ├─ MnemopiSource    (语义记忆)          │
     │  ├─ HindsightSource  (远程记忆)          │
     │  ├─ ProfileSource    (Agent画像)         │
     │  └─ RoleSource       (角色定义)          │
     └─────────────────────────────────────────┘
```

---

## 四、实施路线图

### Phase 1: 核心抽象统一（P0, ~200行, 1天）

| # | 任务 | 文件 | 行数 |
|---|------|------|------|
| 1.1 | 定义 `NodeBehaviorFactoryConfig` 接口 | `graph/node-behavior.ts` | ~15 |
| 1.2 | 扩展 `selectNodeBehavior()` 接受 config | `graph/node-behavior.ts` | ~20 |
| 1.3 | `PhaseBehaviorNodeAdapter` 接收构造时 config，`execute()` 拼装 PhaseContext | `graph/phase-behavior-adapter.ts` | ~60 |
| 1.4 | `GraphRunner.confirmScript()` 传入 config | `graph/graph-runner.ts` | ~20 |
| 1.5 | `GraphRunner.init()` 构建所需服务（WorkflowFsm, ContextPipeline引用等） | `graph/graph-runner.ts` | ~30 |
| 1.6 | 删除 `ScriptNodeBehavior` 类 | `graph/node-behavior.ts` | ~30 (删除) |
| 1.7 | 删除 `CurtainNodeBehavior` 类 | `graph/node-behavior.ts` | ~25 (删除) |
| 1.8 | 单元测试：验证 script/stage/curtain 节点通过 adapter 执行 | `graph/__tests__/` | ~40 |

**验证标准**: 内置 `theatre.graph.yaml` 的 script 节点通过 `PhaseBehaviorNodeAdapter(new ScriptBehavior())` 执行，产出真实 plan.md。

### Phase 2: 补齐缺失服务（P1, ~250行, 1.5天）

| # | 任务 | 文件 | 行数 |
|---|------|------|------|
| 2.1 | `MarkEnvironment` 创建 + 接入 GraphRunner | `graph/graph-runner.ts` | ~15 |
| 2.2 | `StigmergySource` 注册到 GraphRunner ContextPipeline | `graph/graph-runner.ts` | ~5 |
| 2.3 | `MarkEnvironment` 创建 + 接入 EmbeddedSwarmBridge | `core/embedded-swarm-bridge.ts` | ~15 |
| 2.4 | `OffloadManager` 创建 + 接入 EmbeddedSwarmBridge | `core/embedded-swarm-bridge.ts` | ~20 |
| 2.5 | `OffloadSource` 注册到 ContextPipeline | `core/assembler.ts` | ~8 |
| 2.6 | 修复 `ExperienceSource.appliesTo()` 覆盖 stage 阶段 | `context-manager/sources/experience-source.ts` | ~2 |
| 2.7 | NodeContext.experience 从 ExperienceStore 动态构建 | `graph/graph-runner.ts` | ~20 |
| 2.8 | ContextPipeline 通过 PhaseBehavior 的 contextPipeline 字段注入 | `graph/phase-behavior-adapter.ts` | ~10 |
| 2.9 | 集成测试：script→stage→curtain 全链路 | `graph/__tests__/` | ~150 |

**验证标准**: 完整 theatre graph 执行后，`agent` 的 system prompt 中包含 `<stigmergic_environment>` 块和 `<past_experience>` 块。

### Phase 3: 管道整合 + v3 路径修复（P2, ~250行, 1天）

| # | 任务 | 文件 | 行数 |
|---|------|------|------|
| 3.1 | `compactContext()` 接受 OffloadManager 参数 | `offload/compact.ts` | ~30 |
| 3.2 | CompactionState 共享 firstKeptEntryId 给 Offload | `offload/pipeline/pipeline.ts` | ~20 |
| 3.3 | CurtainRunner 后触发 memory consolidation | `curtain/curtain-runner.ts` | ~10 |
| 3.4 | v3 AgentRuntime.spawn() 传递 builtinToolNames | `agent-runtime/agent-launcher.ts` | ~30 |
| 3.5 | PipelineController 移除 `if (runtime)` 分支，统一走 v3 路径 | `core/pipeline.ts` | ~50 |
| 3.6 | SwarmRunner 构造时传入 runtime | `core/swarm-runner.ts` | ~15 |
| 3.7 | 删除 `runSubprocess` legacy 路径（确认无调用者后） | `task/executor.ts` | ~80 (删除) |

**验证标准**: CLI `swarm run` 不再走 runSubprocess，所有 agent spawn 通过 AgentRuntime.spawn() 携带完整工具。

### Phase 4: 配置层修复 + 去重（P3, ~100行, 0.5天）

| # | 任务 | 文件 | 行数 |
|---|------|------|------|
| 4.1 | `loadAgentsFromDir` 改为递归扫描子目录 | `task/discovery.ts` | ~15 |
| 4.2 | `GraphDefinition` schema 添加 `builtin?: boolean` 字段 | `graph/schema.ts` | ~5 |
| 4.3 | 统一 loop.yaml 和 .graph.yaml 的验证逻辑 | `core/schema.ts` + `graph/schema.ts` | ~40 |
| 4.4 | 清理 dead code: 未引用的 PhaseBehavior import | 多个文件 | ~20 |

---

## 五、风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| PhaseBehaviorNodeAdapter 的 execute() 是长时运行（等待人类输入）| 图引擎的 WaveScheduler 按 wave 并发，长时节点会阻塞整个 wave | Script 节点用 `timeout: "30m"` + `human-review` gate；考虑将长时节点标记为 `blocking: true` 让后续 wave 不等待 |
| StageController 和 CustomNodeBehavior 共用 AgentRuntime.spawn 时的工具冲突 | StageController 创建自己的 ToolSession，可能与 ContextPipeline 注入的工具列表重复 | 在 assembleAgentRuntime 中统一工具注册，StageController 只追加不覆盖 |
| MarkEnvironment 的数据结构在 graph 路径和 magic keyword 路径之间共享 | 两个路径可能并发操作同一个 MarkEnvironment 实例 | MarkEnvironment 已是线程安全的（内部 Map），但需确保 GraphRunner 和 EmbeddedSwarmBridge 不会同时存在 |
| 删除 ScriptNodeBehavior/CurtainNodeBehavior 可能影响现有测试 | 298个测试中引用这些类的测试会失败 | Phase 1.8 先更新测试再删除 |

---

## 六、验收标准

完成全部 4 个 Phase 后：

1. **图引擎通用性**: 任意 `.graph.yaml` 文件（无论使用 `type: custom/stage/script/curtain`）通过 GraphRunner 执行，行为与 node type 语义一致
2. **内置 graph 完整性**: `theatre.graph.yaml` 的 script → stage → curtain 全链路：planner agent 产出 plan.md → StageController 并行 worker → Reporter + Reflector 产出报告 + lessons
3. **端到端贯通**: 配置(.stp) → 上下文加载 → 压缩/卸载 → 环境mark → IRC通信 → 工具调用 → 经验记忆，全链路单次 run 可观测到数据流动
4. **Experience DB 有数据**: `.stp/experience/index.sqlite` lessons 表非空
5. **Agent prompt 包含 stigmergy**: agent 的 system prompt 末尾包含 `<stigmergic_environment>` XML
6. **legacy 路径移除**: `runSubprocess` 不再被 swarm 执行路径使用
7. **测试**: 所有已有测试通过，新增集成测试覆盖 graph 全链路

---

## 七、工作量汇总

| Phase | 新增行数 | 删除行数 | 净变化 | 工期 |
|-------|---------|---------|--------|------|
| Phase 1: 核心抽象统一 | ~185 | ~55 | ~130 | 1天 |
| Phase 2: 补齐缺失服务 | ~245 | ~5 | ~240 | 1.5天 |
| Phase 3: 管道整合 + v3修复 | ~155 | ~80 | ~75 | 1天 |
| Phase 4: 配置层修复 | ~85 | ~20 | ~65 | 0.5天 |
| **总计** | **~670** | **~160** | **~510** | **4天** |
