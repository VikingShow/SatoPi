# SatoPi Graph 高级能力扩展：完整调研与实施方案

> 生成日期: 2026-08-02
> 分支: `feat/graph-advanced-capabilities`（基于 `feat/offload-manager-wiring`）
> 目标: 为 Theatre Graph 增加 **条件分支 / 子图 / 循环迭代** 三大能力

---

## 目录

1. [现状诊断](#一现状诊断)
2. [业界方案调研](#二业界方案调研)
3. [架构决策](#三架构决策)
4. [阶段一：条件分支](#四阶段一条件分支)
5. [阶段二：子图](#五阶段二子图)
6. [阶段三：循环迭代](#六阶段三循环迭代)
7. [测试策略](#七测试策略)
8. [风险与兼容性](#八风险与兼容性)

---

## 一、现状诊断

### 1.1 当前能力矩阵

| 能力 | 现状 | 说明 |
|---|---|---|
| 静态 DAG | ✅ 完整 | `depends_on`（显式）+ `edges`（隐式）双依赖体系 |
| 波次调度 | ✅ 完整 | `WaveScheduler`：拓扑排序波次，波内并行 |
| 动态调度 | ✅ **已实现未启用** | `DynamicScheduler`（graph-executor.ts:109-318）：信号量 + 就绪队列 + 级联唤醒 |
| Gate 验证 | ✅ 完整 | compile-check / test / lsp / human-review / script / debate |
| Checkpoint | ✅ 完整 | 每节点写完整快照，可恢复 |
| 条件分支 | ❌ 缺失 | 依赖静态，无运行时路由 |
| 子图 | ❌ 缺失 | mermaid-compiler 检测到子图但"扁平化"处理 |
| 循环/迭代 | ❌ 缺失 | 无 for-each / repeat 原语 |

### 1.2 关键发现

1. **`DynamicScheduler` 是金矿**：它已经有 `#isReady()`（依赖就绪检查）+ `#cascade`（级联唤醒）机制。条件分支的本质就是**在级联唤醒时按条件过滤下游节点**。这是最优雅的接入点，无需改静态波次。

2. **`NodeResult` 缺决策字段**：当前只有 `success/output/artifacts/error/agentResults`，没有 `exitCode`/`decisionPath`/`metadata`。路由函数需要决策依据。

3. **`GraphEdge` 缺条件字段**：`from/to/artifacts/label`，无 `condition`。

4. **checkpoint 不记分支**：`GraphRunState.nodes` 只记 status，不记"走了哪条边"。恢复时无法验证分支一致性。

5. **双依赖体系**：`buildGraphDependencyMap`（schema.ts:321-346）统一合并 `depends_on` + `edges`。

### 1.3 核心文件

| 文件 | 职责 |
|---|---|
| `graph/types.ts` | 所有类型定义 |
| `graph/schema.ts` | YAML 解析 + 校验 |
| `graph/graph-engine.ts` | DAG 执行（buildUpstreamOutputs + checkpoint） |
| `graph/graph-executor.ts` | WaveScheduler + DynamicScheduler |
| `graph/graph-runner.ts` | NodeExecutor + 节点生命周期 + gate |
| `graph/node-behavior.ts` | NodeBehavior 抽象 + CustomNodeBehavior |
| `graph/dag.ts` | buildExecutionWaves + detectCycles |
| `graph/mermaid-compiler.ts` | Graph ↔ Mermaid |
| `graph/gate-controller.ts` | Gate 验证系统 |

---

## 二、业界方案调研

调研了 LangGraph、n8n、Dify 三个代表性框架，提炼出**三个通用设计模式**：

### 2.1 条件边（Conditional Edges）

- **LangGraph**：`add_conditional_edges(router_fn, mapping)` — 路由函数读 state，返回下一节点名
- **n8n**：IF/Switch 节点 — 条件节点多输出口，数据按条件流向不同出口
- **Dify**：IF/ELSE 节点 — 多 exit 分支，自上而下匹配，default 兜底

**共同点**：条件边不是静态的，而是**运行时由路由函数/表达式决定**。

### 2.2 子图（Subgraphs）

- **LangGraph**：图作为节点嵌套，共享 schema 直接加，不同 schema 需 wrapper
- **n8n/Dify**：Sub-workflow 节点

**关键警示**（LangGraph）：子图有独立 checkpoint 命名空间，per-thread 子图**不能并行**。

### 2.3 循环/迭代（Loops）

- **n8n**：Loop Over Items，支持 batch size + rate limit
- **Dify**：Iteration 节点，`variables.item`/`variables.index`，并发执行

**共同点**：`max_iterations` + `break_condition` + 迭代变量注入。

---

## 三、架构决策

### 3.1 核心决策：基于 DynamicScheduler 扩展而非新写调度器

```
理由：
- DynamicScheduler 已有就绪队列 + 级联唤醒，是运行时调度的天然基础
- 条件分支 = 级联唤醒时按条件过滤下游
- 保留 WaveScheduler 作为向后兼容路径（无条件图仍走 waves）
- strategy: "dynamic" 字段已存在，正好激活它
```

### 3.2 条件表达式引擎：白名单 DSL，非任意 JS

```
安全性：不引入 Function()/eval（XSS/注入风险）
设计：受限表达式，仅支持：
  - 字段引用: ${nodeId}.success / ${nodeId}.output / ${nodeId}.exitCode
  - 运算符: == != > < >= <= contains startsWith endsWith isNull isNotNull
  - 逻辑: && || !
  - 字面量: string / number / boolean
解析：手写小型 parser（tokenize → AST → eval），或基于 JSON 结构条件
```

### 3.3 兼容性红线

```
- 无 routes/subgraph/loop 的现有 graph 行为完全不变
- strategy 默认仍为 "waves"，只有图声明 strategy: "dynamic" 或含条件边时才走动态调度
- GraphDefinition 所有新字段可选
```

---

## 四、阶段一：条件分支

### 4.1 Schema 扩展

**GraphNode 新增 `routes`**（types.ts）：

```typescript
export interface RouteCondition {
  /** 条件表达式，如 `${build}.exitCode == 0` */
  when: string;
  /** 目标节点 */
  to: string;
  /** 可视化标签 */
  label?: string;
}

export interface RouteSpec {
  /** 条件路由列表，自上而下匹配，首个命中生效 */
  conditions: RouteCondition[];
  /** 兜底目标（无条件命中时） */
  default?: string;
}
```

**GraphEdge 新增 `condition`**（types.ts）：

```typescript
export interface GraphEdge {
  from: string;
  to: string;
  artifacts?: string[];
  label?: string;
  /** 条件表达式：仅当为 true 时此边激活 */
  condition?: string;
}
```

**NodeResult 新增决策字段**（types.ts）：

```typescript
export interface NodeResult {
  nodeId: string;
  success: boolean;
  output?: string;
  artifacts?: string[];
  error?: string;
  agentResults?: Array<{ agentId: string; output: string; error?: string }>;
  /** 节点执行退出码（gate/命令产生） */
  exitCode?: number;
  /** 决策元数据：路由函数可读 */
  metadata?: Record<string, unknown>;
}
```

### 4.2 表达式引擎（新增文件 `graph/condition.ts`）

```
接口：
  evaluateCondition(expr: string, ctx: ConditionContext): boolean
  validateCondition(expr: string): string | null   // 语法校验，返回错误或 null

ConditionContext = Record<string, NodeExecutionOutput>  // 按 nodeId 索引

支持语法：
  ${build}.success
  ${build}.exitCode == 0
  ${build}.output contains "ERROR"
  (${build}.exitCode == 0) && ${test}.success
```

### 4.3 DynamicScheduler 增加条件路由

```
在 #cascade（graph-executor.ts:306-312）中：
  当节点完成时，检查其下游节点：
  - 若下游有依赖该节点，且存在 conditions 边：
    评估条件 → 命中则入队，未命中则跳过
  - 若下游无条件边：保持现有行为

在 #isReady 中：
  - 条件依赖的上游未满足条件时，节点保持 pending
  - 需要 tracking：哪些条件边已激活
```

### 4.4 schema.ts 校验增强

```
- 校验 routes 的 to 存在、无自环
- 校验条件表达式语法（validateCondition）
- 校验 default 目标存在
- 校验 edges 的 condition 语法
- routes/condition 依赖并入 buildGraphDependencyMap（循环检测覆盖）
```

### 4.5 checkpoint 增强

```
GraphRunState 新增：
  decisions?: Record<string, string>  // nodeId → 选择的 route 目标

恢复时：若节点已执行且其路由决策已记录，跳过下游未激活节点
```

### 4.6 mermaid-compiler 增强

```
graphToMermaid：
  - routes → 条件边标签 `--|if(cond)|`
  - GraphEdge.condition → 边标签
```

---

## 五、阶段二：子图

### 5.1 Schema 扩展

```yaml
nodes:
  ci-check:
    type: subgraph
    subgraph: "./ci-check.graph.yaml"     # 子图文件引用
    inputs:                               # 输入映射
      repo: "${build}.artifacts"
    outputs:                              # 输出映射
      passed: "${subgraph}.exitCode"
```

### 5.2 设计

- 新增 `SubgraphBehavior`：加载子图 → 建嵌套 GraphEngine → 边界状态转换
- 子图**串行**执行（LangGraph 警示：per-thread 子图不能并行）
- 子图 checkpoint 独立命名空间
- `registerNodeBehavior("subgraph", ...)` 注册

---

## 六、阶段三：循环迭代

### 6.1 Schema 扩展

```yaml
nodes:
  process-batch:
    type: loop
    over: "${upstream}.artifacts"
    body: { type: custom, role: worker }
    max_iterations: 10
    break_when: "${item}.passed"
```

### 6.2 设计

- 新增 `LoopBehavior`：迭代变量注入（item/index）
- 串行或并行（配置）
- `max_iterations` 循环保护 + 收敛检测（复用 convergence.ts 的 Jaccard）

---

## 七、测试策略

每阶段完成后：
1. **单元测试**：表达式引擎、schema 校验、路由决策
2. **集成测试**：用 mock graph 跑条件分支/子图/循环
3. **全量回归**：`bun run check:types` + biome + 全量测试
4. **验证后推送**：每阶段独立提交推送远端

---

## 八、风险与兼容性

| 风险 | 等级 | 缓解 |
|---|---|---|
| DynamicScheduler 改动影响面大 | 中 | 保留 WaveScheduler 默认路径，动态调度仅在声明时启用 |
| 条件表达式求值安全 | 中 | 白名单 DSL，禁任意 JS |
| 子图 checkpoint 冲突 | 高 | 子图独立命名空间 + 串行 |
| 恢复分支一致性 | 中 | decisions 记录 + 恢复时校验 |
| 向后兼容 | 低 | 所有新字段可选，旧图零改动 |

---

## 附录：实施顺序

```
阶段一（条件分支）: types → schema → condition.ts → graph-executor → graph-engine → checkpoint → mermaid → 测试
阶段二（子图）:     types → schema → subgraph-behavior → graph-engine 嵌套 → 测试
阶段三（循环）:     types → schema → loop-behavior → 测试
```

---

## 实施日志

### 阶段一：条件分支 ✅ 已完成（2026-08-02）

**已落地内容**：
1. **types.ts**：新增 `RouteSpec`/`RouteCondition`/`RouteDecision` 类型；`GraphNode.routes`、`GraphEdge.condition`、`NodeResult.exitCode`/`metadata`、`GraphRunState.decisions`
2. **condition.ts**（新文件）：安全的 DSL 条件表达式引擎（tokenize → parser → eval），支持 `${node}.field` 引用、比较/字符串/逻辑运算符、`isNull` 检查；`evaluateCondition` + `validateCondition`
3. **schema.ts**：解析 `routes`/`condition` 字段；校验 route target 存在、无自环、条件语法；`buildGraphDependencyMap` 并入 route targets（循环检测覆盖）
4. **graph-executor.ts**：`DynamicScheduler` 增加 `ConditionalGate` 支持——节点入队前检查条件门，不满足则标记 skipped；路由源失败不 abort（default 分支处理失败场景）；`#isReady` 对路由源失败的下游视为 ready
5. **graph-engine.ts**：`#usesConditionalRouting()` 检测是否需要动态调度；根据 strategy/routes/condition 选择 `DynamicScheduler`（含 gate + routeSources）或 `WaveScheduler`；`evaluateNodeRoutes` 计算路由决策并写入 checkpoint
6. **mermaid-compiler.ts**：`graphToMermaid` 渲染条件边（`|"if cond"|`）和 routes 边

**测试**：
- `condition.test.ts`：12 个表达式引擎测试
- `conditional-routing.test.ts`：7 个 schema + 动态调度集成测试（success 路由、default 路由、waves 兼容）
- 全量 graph+swarm：430 pass / 0 fail

**验证**：`bun run check:types` ✅，biome ✅（8 文件，1 无害 warning）

### 阶段二：子图 ✅ 已完成（2026-08-02）

**已落地内容**：
1. **types.ts**：`NodeType` 加 `"subgraph"`；`GraphNode.subgraph_path`；`NodeDefinition.subgraphPath`；`NodeContext.executeNode`（可选 executor，GraphRunner 注入）
2. **schema.ts**：`VALID_NODE_TYPES` 加 `subgraph`；解析 `subgraph_path`；校验 subgraph 节点必须有 `subgraph_path`
3. **subgraph-behavior.ts**（新文件）：`SubgraphNodeBehavior`——prepare 加载子图 yaml，execute 用嵌套 `GraphEngine` 执行子图；`SubgraphNodeExecutor` 实现子图节点执行（复用 `ctx.runtime.spawn`，支持嵌套子图递归）；子图用内存 checkpoint（随父节点完成）
4. **node-behavior.ts**：`behaviorRegistry` 注册 `subgraph` → `SubgraphNodeBehavior`
5. **graph-runner.ts**：`ctx.node` 组装加 `subgraphPath`；`ctx.executeNode = this`

**关键设计**：子图嵌套执行复用父级 `AgentSpawner`，子图内条件路由由嵌套 GraphEngine 自己处理；子图间共享全局单例（AgentRegistry/IrcBus/ProfileRegistry）无冲突。

**测试**：`subgraph.test.ts` 3 个测试（schema 解析、缺 subgraph_path 校验、嵌套执行端到端）
- 全量 graph+swarm：433 pass / 0 fail

### 阶段三：循环/迭代 ✅ 已完成（2026-08-02）

**已落地内容**：
1. **types.ts**：`NodeType` 加 `"loop"`；`GraphNode` 加 `loop_over`/`loop_body`/`loop_max_iterations`/`loop_break_when`/`loop_convergence_threshold`；`LoopBodySpec` 类型；`NodeDefinition` 加对应 camelCase 字段
2. **schema.ts**：`VALID_NODE_TYPES` 加 `loop`；解析循环字段；校验（loop_body 必须、body 仅 custom、max_iterations>=1、convergence 范围 [0,1]、break_when 语法）
3. **loop-node-behavior.ts**（新文件）：`LoopNodeBehavior`——解析迭代源（字面数组或 `${node}.field` 上游引用）、逐迭代执行 body（复用 `ctx.runtime.spawn`）、`loop_break_when` 条件终止、可选收敛检测（Jaccard）、聚合结果
4. **condition.ts**：field 引用支持 `${node.field}`（点内）和 `${node}.field`（点外）两种形式
5. **node-behavior.ts**：注册 `loop` → `LoopNodeBehavior`
6. **graph-runner.ts**：`ctx.node` 组装加循环字段

**关键设计**：循环是节点级行为，调度器透明（与阶段一/二一致）。body 注入 `loop.item`/`loop.index` 上下文。收敛检测默认关闭，仅显式配置 `loop_convergence_threshold` 时启用。

**测试**：`loop-node-behavior.test.ts` 8 个测试（schema 解析、缺 loop_body、max_iterations 校验、字面数组迭代、max 上限、break 条件、上游引用、失败传播）+ condition.test.ts 新增点内语法测试
- 全量 graph+swarm：442 pass / 0 fail

---

## 已知限制（审查后确认）

| # | 限制 | 说明 | 状态 |
|---|---|---|---|
| 1 | **条件图 checkpoint 恢复不完整** | 条件路由（DynamicScheduler）的 skipped/failed 节点状态和每个节点的 NodeResult 不持久化。恢复后条件节点重新评估，若上游结果无法重建可能误判。**需要状态重建（持久化 NodeResult）才能完整修复** | 已知，待 v2 |
| 2 | **loop body 仅支持 custom** | schema 校验 loop_body.type 只能是 custom。subgraph body 是 v2 特性 | 已知，v2 |
| 3 | **子图内不支持 script/stage/curtain** | 这些类型需要完整 swarm 基础设施，子图嵌套不携带。会明确报错而非静默 | 已修复（明确拒绝） |
| 4 | **条件表达式不支持数组索引** | `${node}.metadata.loopResults[0].success` 不支持。支持点链路径（`${node}.metadata.loopIterations`） | 点链已支持，数组索引待 v2 |
| 5 | **`and`/`or` 关键字被 tokenize 但未 parse** | tokenizer 识别 `and`/`or` 但 parser 只认 `&&`/`||`。使用 `and`/`or` 会报 "Unexpected trailing input" | 已确认，建议只用 `&&`/`||` |

---

## 审查修复日志（2026-08-02）

**修复的问题**：
1. **P0 子图内 loop 节点被当 custom 处理** → `SubgraphNodeExecutor.execute` 增加 loop 分支，委托 `LoopNodeBehavior`；script/stage/curtain 明确拒绝
2. **P0 子图路径解析基准错误** → 新增 `NodeContext.graphDir`，子图路径相对父图目录解析（GraphRunner 设置）
3. **P1 子图缺 metadata** → `SubgraphNodeBehavior.execute` 返回 `metadata`（subgraphName/completedCount/totalNodes/errorCount）
4. **P1 嵌套 NodeContext 缺字段** → `#buildNodeContext` 补 gate/timeout/loop 字段/ircBus/executeNode/graphDir
5. **P1 loop break_when 缺 metadata** → `evaluateLoopBreak` ctx 加 `metadata`
6. **P1 `buildUpstreamOutputs` 丢 metadata** → 有 metadata 时 result 变为 `{ output, ...metadata }`，下游可访问
7. **P1 loop_over 缺非空校验** → schema 校验 + `resolveIterationSource` 报错
8. **P1 `resolveIterationSource` 错误信息模糊** → 明确单引号/字符串 result 的错误
9. **P1 条件引擎不支持嵌套访问** → field 支持点链路径（`${node}.metadata.field`），resolveField 逐层深入
10. **P1 条件 gate `!anyEvaluable` 反向** → 改为恒 false（条件源未 settled 时节点不可达）
11. **P2 正则字符类范围错误** → `[a-zA-Z0-9_.-]` 修复为 `[a-zA-Z0-9_\-.]`
12. **P2 mermaid 不支持 subgraph/loop 形状** → SHAPE_MAP 加 `loop: ">]"`、`subgraph: "[/]"`

**新增测试**：
- `subgraph.test.ts`：子图内含 loop 节点执行
- `conditional-routing.test.ts`：routes 基于节点 metadata 路由
- `loop-node-behavior.test.ts`：metadata 暴露、break 引用 metadata
- `condition.test.ts`：点链路径 `${loop.item}`
