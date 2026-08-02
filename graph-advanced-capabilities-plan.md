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
