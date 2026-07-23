# SatoPi 渐进式披露索引 — 深层调研报告

> **日期**: 2026-07-20
> **调研范围**: TencentDB-Agent-Memory 完整 offload pipeline + SatoPi 可复用基础设施
> **目的**: 回答四个关键问题后更新实施计划

---

## 问题 1: 基础设施复用 —— SatoPi 已有的可复用模块

**结论: 不需要重新发明任何存储/IO 基础设施。所有底层能力已就绪。**

### 1.1 文件持久化

| SatoPi 可复用模块 | 文件 | 接口 | TencentDB 对应 |
|------------------|------|------|---------------|
| `SessionStorageWriter` | `session-storage.ts:88` | `append(line)`, `flush()`, `close()` | offload JSONL 追加写入 |
| `writeTextAtomic()` | `session-storage.ts:253` | 原子写入（temp file + rename + commitGuard） | MMD 文件安全写入 |
| `openWriter(path, {flags:"a"})` | `session-storage.ts:396` | 返回 Writer 实例 | 打开 offload.jsonl 追加写入 |
| `MemorySessionStorage` | `session-storage.ts:612` | 同接口，内存实现 | 单元测试用 |

**关键**: `SessionStorageWriter` 使用 `FinalizationRegistry` 管理 fd 生命周期，有错误累积和 finalization 清理，比手写 `fs.appendFile` 更健壮。

### 1.2 JSONL 解析

| 模块 | 文件 | 能力 |
|------|------|------|
| `readJsonl<T>(stream)` | `stream.ts:50` | 流式 JSONL 解析（Bun.JSONL.parseChunk） |
| `parseJsonlLenient<T>(buffer)` | `stream.ts:408` | 容错解析（跳过损坏行） |
| `ConcatSink` | `stream.ts:82` | 高效缓冲行读取 |

### 1.3 会话持久化

| 模块 | 文件 | 能力 |
|------|------|------|
| `SwarmSessionManager.appendCustomEntry()` | `swarm-session-manager.ts` | 带类型的自定义条目追加 |
| `SwarmSessionManager` CTX 常量 | `swarm-session-manager.ts:55` | 已有 SWARM_STATE/AGENT_STATE/ACTIVITY/PHASE/VERDICT |
| `SessionManager.rewriteEntries()` | `session-manager.ts` | 会话压缩重写 |
| `ArtifactManager.save()` | `artifacts.ts` | 大型内容存为 `artifact://` 引用 |

**新增 CTX 类型**（最小侵入）:
```typescript
export const CTX = {
  // ... existing ...
  OFFLOAD_ENTRY: "offload_entry" as const,  // 🆕
};
```

### 1.4 令牌管理

| 模块 | 接口 | 用途 |
|------|------|------|
| `ContextGuard.checkContextBudget({text, contextWindow})` | 令牌利用率检测 (80%/90%/100% 三级) | L3 压缩触发条件 |
| `guardTaskBudget(taskPieces, contextWindow, label)` | Worker/Cloner 上下文守卫 | 降级优先级决策 |
| `countTokens(text)` | 核心 token 计数 | L3 快照参考 |

### 1.5 Hook 系统

SatoPi 已有完整的 Pipeline Hook 系统 (`pipeline.ts:97-111`):

```typescript
interface PipelineHooks {
  beforePipeline?: (ctx) => Promise<void>;     // → 初始化 offload 存储
  beforeIteration?: (n, ctx) => Promise<boolean | void>; // → 注入 MMD 到 iteration 上下文
  afterIteration?: (n, ctx) => Promise<void>;   // → L2 节点归因触发
  beforeWave?: (idx, agents, ctx) => Promise<boolean | void>;  // → 注入 MMD 到 Wave agent
  afterWave?: (idx, waveResult, ctx) => Promise<void>;  // → 🆕 L1 摘要触发（最关键的插入点）
  afterPipeline?: (status, ctx) => Promise<void>;  // → L3 最终合成
  onHookError?: (name, err) => void;         // → 错误隔离
}
```

### 1.6 数据模型复用

| SatoPi 已有 | 可映射为 | 
|------------|---------|
| `StateTracker.state.agents[id].status` | Agent 执行状态（用于 L1.5 任务边界检测）|
| `WaveResult.results: Map<string, SingleResult>` | Agent 产出（用于 L1 摘要输入）|
| `PipelineContext.waves: WaveResult[]` | 跨 Wave 累积上下文（用于 MMD 节点归因）|
| `ClonerCouncil.ReviewVerdict` | 审查裁决（用于 MMD 节点状态判定）|
| `plan.md` 中的 phase 结构 | MMD 图的骨架（phase → 子任务 → 节点）|

### 1.7 不可复用的（需要新增）

| 需要新增 | 原因 |
|---------|------|
| Offload 专用 LLM 调用（轻量摘要模型） | SatoPi 的 LLM 调用是 agent 级别的全功能调用，需要一个轻量摘要调用 |
| L1.5 去重/任务边界检测逻辑 | 纯业务逻辑 |
| L2 节点归因 prompt 模板 | 纯业务逻辑 |
| MMD 注入到 agent context 的逻辑 | 需要理解 agent context 构建流程 |

---

## 问题 2: 卸载时机 —— 不仅限于 Worker

**TencentDB 关键发现**: offload 模块对**所有 agent 类型**生效（main/worker/subagent），但**存储隔离**（每个 agent 有独立的 offload.jsonl、mmds/、state.json）。

### TencentDB 的 6 个卸载触发点

| 触发点 | 触发频率 | Agent 范围 | 行为 |
|--------|---------|-----------|------|
| `after_tool_call` hook | 每次工具调用 | **所有 agent** | 收集 tool pair，达到阈值(4)后触发 L1 |
| `before_prompt_build` hook | 每次 prompt 构建 | **所有 agent** | 注入 active MMD，必要时 L3 压缩 |
| Context Engine `assemble()` | 每次新用户消息 | main agent | L1.5 去重+边界检测触发 |
| Context Engine `afterTurn()` | 每轮结束 | main agent | 清空剩余 tool pairs |
| L2 Scheduler | 每 5 秒轮询 | 独立于 hooks | 条件触发 L2 节点归因 |
| `before_agent_start` | agent 启动时 | **所有 agent** | L4 技能生成 |

### 映射到 SatoPi 的完整时机表

| SatoPi Agent 类型 | 卸载触发点 | 触发时机 | 卸载内容 |
|------------------|-----------|---------|---------|
| **Worker** (子进程 agent) | `afterWave` hook | Worker 子进程执行完成 | Worker 的 output (SingleResult) |
| **Worker** (子进程 agent) | `beforeWave` hook | Worker 启动前 | 注入当前 iteration 的 MMD 图 |
| **Cloner Council** | `afterWave` (审查 wave) | Cloner 审查完成 | 审查 verdict + findings |
| **Cloner Council** | `beforeWave` (审查 wave) | Cloner 启动前 | 注入 Worker 产出的 MMD 摘要 |
| **LoopController** (主 agent) | `afterIteration` hook | 一轮迭代完成 | phase 转换决策 + Socrates 对话摘要 |
| **LoopController** (主 agent) | `beforeIteration` hook | 新迭代开始前 | 注入上一轮合成的完整 MMD 图 |

### 架构示意

```
Iteration N:
┌───────────────────────────────────────────────────────────┐
│ beforeIteration hook                                      │
│   → 注入上一轮合成的 MMD 图到 PipelineContext              │
│                                                           │
│   Wave 0: Workers (并行)                                   │
│   ┌───────────────────────────────────────────────────┐   │
│   │ beforeWave hook → 注入 MMD 到每个 Worker taskPieces│   │
│   │ Worker #1 执行... Worker #N 执行...                │   │
│   │ afterWave hook → L1: 收集每个 Worker 产出 → 摘要   │   │
│   │   → 追加到 offload-worker-N.jsonl                  │   │
│   │   → 写入 refs/ 完整产出                             │   │
│   └───────────────────────────────────────────────────┘   │
│                                                           │
│   Wave 1: Cloner Council (并行)                            │
│   ┌───────────────────────────────────────────────────┐   │
│   │ beforeWave hook → 注入 Worker 产出 MMD 摘要        │   │
│   │ Cloner #1..K 审查...                               │   │
│   │ afterWave hook → L1: 收集审查 verdict → 摘要       │   │
│   │   → 追加到 offload-cloner.jsonl                    │   │
│   │   → 判定 MMD 节点状态 (done/failed/blocked)         │   │
│   └───────────────────────────────────────────────────┘   │
│                                                           │
│ afterIteration hook                                       │
│   → L2: 将 L1 条目归因到 plan.md phase 节点               │
│   → L3: 合并生成/更新 context-graph.mmd                    │
│   → L1.5: 去重 + 任务边界检测                              │
└───────────────────────────────────────────────────────────┘
```

### 关键洞察

1. **每个 Agent 类型的 offload 是隔离的**：Worker 的 offload 只记录 Worker 产出，Cloner 的只记录审查结果，LoopController 的只记录编排决策
2. **MMD 图是所有视角的合并视图**：L3 合成时会将本 iteration 所有 agent 的 L1 条目归因到同一个 MMD 图（以 plan.md 的 phase 结构为骨架）
3. **不同 agent 看到不同的 MMD**：Worker 注入的是精简版（只含自己负责的 phase 节点），Cloner 注入的是全视图（含所有 Worker 的执行状态）

---

## 问题 3: 卸载的上下文内容

### TencentDB 的卸载内容

```
工具调用输入:  tool_name, params, tool_call_id
工具调用输出:  完整 result 文本（可能数万 token）
       ↓
L1 摘要:       OffloadEntry { tool_call, summary (≤200字), score (0-10), result_ref }
L1.1 归档:     完整原始结果 → refs/{timestamp}.md
L3 压缩:       原消息替换为 "[Offloaded Tool Result | node: 001-N1]\nSummary: ..."
```

### SatoPi 对应卸载内容

#### 3.1 Worker Agent 卸载

| TencentDB 概念 | SatoPi 对应 | 具体内容 |
|---------------|------------|---------|
| tool_name | worker task 名称 | 从 plan.md 分配给 Worker 的子任务描述 |
| params | worker task 定义 | taskPieces[] 中的全部 prompt 片段 |
| tool_call_id | `{workerId}-{iteration}` | Worker 唯一标识 |
| result (full) | `SingleResult.output` | Worker 完整输出文本 + file changes |
| L1 summary | `{workerId} 完成了 {phase} 的 {子任务}：{核心成果}` | ≤200 字高密度摘要 |
| score | Cloner verdict 评分 | passCount/totalCount，转为 0-10 分 |
| result_ref | `artifact://` 引用 | 大型输出存为 artifact |

#### 3.2 Cloner Council 卸载

| TencentDB 概念 | SatoPi 对应 | 具体内容 |
|---------------|------------|---------|
| tool_name | cloner role（guardian/adversarial 等） | 审查角色名 |
| params | 审查配置 | workerOutput + planContent + previousFindings |
| result | `ReviewVerdict` | passed, approvalCount, findings[], workerCountSuggestions[] |
| L1 summary | `审查结论：{passed/failed} ({approvalCount}/{totalCount})，关键发现：{top findings}` | 审查结果摘要 |
| score | 基于 verdict 计算 | passed ? 8-10 : 1-4 |

#### 3.3 LoopController 卸载

| TencentDB 概念 | SatoPi 对应 | 具体内容 |
|---------------|------------|---------|
| tool_call | phase 转换决策 | `generateWorkers()` / `convergeLoop()` 调用 |
| result | 决策输出 | 生成的 workerIds[] / 收敛判定 + next actions |
| L1 summary | `Phase 转换：{from} → {to}，新增 {N} 个 Worker，收敛判定：{converged/diverged}` | 编排决策摘要 |

---

## 问题 4: Mermaid 图构造的是什么内容的图逻辑

### TencentDB 的 Mermaid 图本质

**核心定义**: "认知状态机"（cognitive state machine）—— 多步任务执行历史的图形化记录。

**节点语义**:
- 代表：聚合后的宏观认知步骤（可能合并多个工具调用）
- 非 1:1 对应工具调用（弹性聚合）
- status: done | doing | todo | blocked | paused
- 格式: `001-N1["Phase 1: Initial Setup<br/>status: done<br/>summary: ..."]`

**边语义**:
- 实线 `-->`：顺序执行流
- 带标签 `-->|label|`：条件跳转
- 虚线 `-.->`：参考/依赖关系

**核心用途**: **方向保持器** (direction-keeper) —— 让 LLM 在多轮对话中避免"迷路"，不重复已完成工作。

### SatoPi 的 Mermaid 图语义（升级版）

SatoPi 的 Mermaid 图不仅记录**执行历史**，还承载**多 Agent 协同状态**：

```
flowchart TD
    %% === Plan Phase 1: 基础设施 ===
    001-P1["Phase 1: API Infrastructure<br/>status: done<br/>summary: Worker #a1 完成 REST 层<br/>Worker #a2 完成数据库迁移"]
    
    %% === Plan Phase 2: 业务逻辑 ===
    001-P2["Phase 2: Business Logic<br/>status: doing<br/>summary: Worker #b1 实现 Auth 模块<br/>Worker #b2 实现 Payment 模块"]
    
    %% === Worker 间协作边 ===
    001-P1 -->|"REST API 已就绪"| 001-P2
    
    %% === 子任务节点（可选展开） ===
    001-P1 -->|"产出"| 001-N1["Auth 中间件<br/>status: done<br/>Cloner: 3/3 PASS"]
    001-P2 -->|"产出"| 001-N2["JWT 验证<br/>status: doing<br/>Cloner: 2/3 PASS, 1 FAIL"]
    
    %% === Cloner 审查节点 ===
    001-N1 -->|"审查通过"| 001-C1["Round 1 Review<br/>status: done<br/>3/3 PASS | findings: 0"]
    001-N2 -->|"审查分歧"| 001-C2["Round 1 Review<br/>status: blocked<br/>2/3 PASS | findings: JWT key rotation missing"]
    
    %% === 状态节点 ===
    001-C2 -.->|"重新分配"| 001-P2
    
    class 001-P1,001-N1,001-C1 done
    class 001-P2,001-N2 doing
    class 001-C2 blocked
```

**节点语义对比**:

| 维度 | TencentDB | SatoPi |
|------|-----------|--------|
| **Phase 节点** | 无显式 phase 概念 | plan.md 的顶层 phase（如 "API Infrastructure"）|
| **子任务节点** | 聚合的工具调用 | Worker 执行输出（可进一步聚合）|
| **审查节点** | 无 | Cloner Council verdict（pass/fail/findings）|
| **协作边** | 顺序执行 | Worker A→B 产出传递 / Worker→Cloner 审查流 |
| **状态来源** | LLM 自主推断 | Cloner Council 判定 + StateTracker |
| **注入粒度** | 每个 agent 看自己的 MMD | **分层注入**: Worker 看局部，Cloner 看全局，LoopController 看全景 |

**分层 MMD 注入策略**:

```
Worker 看到的 MMD（局部视图）:
  → 只含自己负责的 phase 节点 + 上游已完成的依赖节点
  → 不展示其他 Worker 的细节（避免信息过载）

Cloner 看到的 MMD（全局审查视图）:
  → 所有 Worker 的执行节点 + 审查 verdict 节点
  → 用于跨 Worker 一致性检查

LoopController 看到的 MMD（全景编排视图）:
  → 完整 MMD 图 + 历史迭代的 MMD 归档
  → 用于决策 phase 转换、收敛判定
```

---

## 更新后的实施计划

### 架构分层

```
┌────────────────────────────────────────────────────────────┐
│ OffloadPipeline（新增）                                      │
│ ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌─────────┐ │
│ │ L1 摘要   │→│ L1.5 去重 │→│ L2 节点归因   │→│L3 MMD合成│ │
│ │(afterWave)│  │(边界检测) │  │(afterItera.) │  │(合成触发)│ │
│ └──────────┘  └──────────┘  └──────────────┘  └─────────┘ │
└────────────────────────────────────────────────────────────┘
         ↑ 复用                              ↓ 输出
┌─────────────────────┐          ┌──────────────────────────┐
│ SatoPi 基础设施      │          │ 持久化层                   │
│ • SessionStorageWriter│         │ .swarm_{name}/.omp/       │
│ • SwarmSessionManager│          │   ├── offload/             │
│ • ContextGuard       │          │   │   ├── worker-a1.jsonl │
│ • PipelineHooks      │          │   │   ├── worker-a2.jsonl │
│ • ArtifactManager    │          │   │   ├── cloner-c1.jsonl │
│ • StateTracker       │          │   │   └── orchestrator.jsonl│
│ • WaveResult         │          │   ├── mmds/                │
└─────────────────────┘          │   │   └── context-graph.mmd│
                                  │   └── refs/                │
                                  └──────────────────────────┘
```

### Worktree 并行任务（更新后）

| # | Worktree | 模块 | 复用基础设施 | 核心工作 |
|---|----------|------|------------|---------|
| 1 | `offload-storage` | `SwarmOffloadStore` | `SessionStorageWriter.openWriter()`、`SwarmSessionManager.appendCustomEntry()`、`ArtifactManager` | 实现 offload JSONL 追加读写、refs/ 归档、按 phase_id/worker_id 查询接口（非重写，是包装已有存储层） |
| 2 | `offload-pipeline` | `OffloadPipeline` (L1+L1.5+L2) | `WaveResult`、`SingleResult`、`ReviewVerdict`、`PipelineHooks.afterWave` | L1: Worker 产出→L1 摘要；L1.5: 去重+边界检测；L2: 归因到 plan.md phase 节点 |
| 3 | `mermaid-synth` | `MermaidSynthesizer` (L3) + `ContextInjector` | `PipelineHooks.beforeWave`/`beforeIteration`、`PipelineContext` | 合成 .mmd 文件、分层注入（Worker 局部/Cloner 全局/LoopController 全景） |
| 4 | `integration` | 整合 + Hook 注册 + 设计文档 | 全部上述模块 | 修改 loop-controller.ts 注册 hooks、更新 schema、更新设计文档 |

### 关键设计决策

1. **不自己写文件 IO**：全部使用 `SessionStorageWriter` 和 `SwarmSessionManager`
2. **不自己写 token 计数**：使用 `ContextGuard.checkContextBudget()`
3. **不修改 agent context 构建核心路径**：通过 `PipelineHooks` 注入，保持 loop-controller 主路径干净
4. **MMD 注入用 CTX 条目**：在 session.jsonl 中插入 `CTX.OFFLOAD_ENTRY`，不破坏现有 session 结构
5. **分层 MMD 注入**: Worker 看局部、Cloner 看全局、LoopController 看全景 —— 不同 agent 类型看到不同粒度的 MMD
