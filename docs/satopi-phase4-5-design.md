# SatoPi Phase 4 & 5 设计方案：语义记忆 + 渐进式披露 + Mermaid 上下文索引

> **创建日期**: 2026-07-20（初版）/ 2026-07-20（v2：整合 TencentDB Mermaid 机制深度调研）
> **来源**: satopi-architecture-analysis.md §5.4 改造路径评估 + TencentDB-Agent-Memory 完整 offload pipeline 分析
> **前置依赖**: Phase 1-3 已落地（ContextGuard / SwarmSessionManager / SessionRegistry）
> **深度调研报告**: satopi-offload-deep-dive.md（四大问题回答：基础设施复用/卸载时机/卸载内容/Mermaid 语义）

---

## 0. 关键调研结论（必读）

### 0.1 基础设施：不需要重新发明

SatoPi 已有完整的存储/IO/会话/令牌/Hook 基础设施，**Phase 4-5 全部是编排层逻辑**：

| 需要的能力 | SatoPi 已有 | 文件 | 操作 |
|-----------|------------|------|------|
| 追加写入 JSONL | `SessionStorageWriter.openWriter(path, "a")` | `session-storage.ts:396` | 直接复用 |
| 原子写入 .mmd | `SessionStorage.writeTextAtomic()` | `session-storage.ts:253` | 直接复用 |
| 自定义条目持久化 | `SwarmSessionManager.appendCustomEntry()` | `swarm-session-manager.ts` | 新增 CTX.OFFLOAD_ENTRY |
| 大型内容归档 | `ArtifactManager.save()` | `artifacts.ts` | 直接复用 |
| 令牌预算检测 | `ContextGuard.checkContextBudget()` | `context-guard.ts:77` | 直接复用 |
| 生命周期 Hook | `PipelineHooks` (6 个钩子) | `pipeline.ts:97-111` | 直接复用 |
| Agent 状态追踪 | `StateTracker` | `state.ts` | 直接复用 |
| 跨 Wave 上下文 | `WaveResult` + `PipelineContext` | `pipeline.ts:56-84` | 直接复用 |

### 0.2 卸载时机：所有 Agent 类型，不只是 Worker

TencentDB 的 offload 对 **所有 agent**（main/worker/subagent）生效，但存储隔离：

| SatoPi Agent | 卸载触发点 (Hook) | 卸载内容 | 存储文件 |
|-------------|-------------------|---------|---------|
| Worker | `afterWave` | Worker 产出 (SingleResult.output) | `offload/worker-{id}.jsonl` |
| Cloner Council | `afterWave` | 审查 verdict + findings | `offload/cloner-{id}.jsonl` |
| LoopController | `afterIteration` | Phase 转换决策 + Socrates 摘要 | `offload/orchestrator.jsonl` |

### 0.3 Mermaid 图：从"方向保持器"升级为"多 Agent 协同状态机"

| 维度 | TencentDB 原语义 | SatoPi 升级语义 |
|------|-----------------|---------------|
| 节点 | 聚合的工具调用步骤 | Phase / Worker 产出 / Cloner 裁决 三类节点 |
| 边 | 顺序流 + 依赖 | Worker→Cloner 审查流 + Worker A→B 产出传递 |
| 状态 | LLM 推断 | Cloner Council 判定（verified）|
| 注入粒度 | 每 agent 看自己的 | **分层**: Worker 局部 / Cloner 全局 / LoopController 全景 |

---

## Phase 4: mnemopi 语义召回整合

### 4.1 目标

将 mnemopi（项目已有的本地记忆引擎，SQLite + FTS5 + 向量 + Hybrid Search + MMR 重排）接入 Swarm 循环，替代当前纯文本拼接的上下文构建方式，让 Worker 和 Cloner 能按语义相似度检索历史经验。

### 4.2 当前状态 vs 目标状态

```
当前 (Phase 3 已落地):
┌─────────────────────────────────────────┐
│ Worker 上下文构建                          │
│                                          │
│  planContent (截断到 4000 char)           │
│  + feedbackBlock (最近 3 条 compacted)     │
│  + extraContext (前轮摘要, .join("\n"))   │
│  + deliberation peer outputs              │
│  + roleSuggestions                        │
│                                          │
│  全部是时间窗口内的字符串拼接，无语义检索     │
└─────────────────────────────────────────┘

目标 (Phase 4):
┌─────────────────────────────────────────┐
│ Worker 上下文构建                          │
│                                          │
│  planContent (截断, 同前)                 │
│  + feedbackBlock (最近 3 条, 同前)         │
│  + extraContext (前轮摘要, 同前)            │
│  + 🆕 relevantExperiences (mnemopi 召回)  │  ← 新增
│  + deliberation peer outputs              │
│  + roleSuggestions                        │
│                                          │
│  relevantExperiences = mnemopi.recall(    │
│      query = planContent + findings,      │
│      topK = 5,                            │
│      filters = { source: "swarm-experience" }
│  )                                        │
└─────────────────────────────────────────┘
```

### 4.3 集成点设计（3 个 hook 点）

#### Hook 1: Before-loop 经验注入（Socrates + Cloner Roundtable）

**位置**: `before-loop-manager.ts` 的 `#runSocrates()` 方法

**时机**: 生成 planning prompt 时，在 conversation history 之前注入

**实现**:

```typescript
// 在 #runSocrates() 中，taskText 构建处：
async #runSocrates(): Promise<void> {
    // ... existing code ...

    // 🆕 召回相关历史经验
    let experienceContext = "";
    if (this.#experienceStore) {
        const query = this.#taskDescription;
        const experiences = await this.#experienceStore.search(query, {
            topK: 5,
            minWeight: 0.3,       // 过滤低质量经验
            excludeCurrentRun: true,
        });
        if (experiences.length > 0) {
            experienceContext = [
                "## Relevant Past Experiences",
                "",
                ...experiences.map((e, i) =>
                    `### Experience ${i + 1} (run: ${e.runId}, relevance: ${e.rank.toFixed(2)})\n` +
                    `**Lesson**: ${e.lesson.summary}\n` +
                    `**Outcome**: ${e.lesson.outcome}\n` +
                    `**Key Insight**: ${e.lesson.insight}`
                ),
                "",
                "Consider these when planning. Avoid repeating past mistakes.",
                "",
            ].join("\n");
        }
    }

    const taskText = [
        experienceContext,           // ← 新增：在 conversation history 之前
        this.#buildTaskFromHistory(),
    ].filter(Boolean).join("\n");
    // ... rest of existing code ...
}
```

**mnemopi 集成细节**:
- 使用 `recallEnhanced(query, topK=5, { includeFacts: false, useMmr: true })`
- 过滤条件: `source = "swarm-experience"`, `memory_type = "loop-lesson"`
- 注入/存储时机: After-loop 的 `ExperienceStore` 在写入 `lessons.jsonl` 的同时调用 `mnemopi.remember()`

#### Hook 2: In-loop Worker 上下文增强

**位置**: `loop-controller.ts` 的 `#spawnWorkers()` 方法，在构建 `taskPieces[]` 之后、`guardTaskBudget()` 之前

**时机**: 每个 Worker 启动时，根据当前迭代的 findings + plan 搜索相关解决方案

**实现**:

```typescript
// 在 #spawnWorkers() 中，构建 taskPieces 之后:
const taskPieces = [
    `You are Worker ${i + 1} of ${workerIds.length}.`,
    // ... existing pieces ...
];

// 🆕 召回 Worker 相关的历史经验（如果配置了 mnemopi）
if (this.#mnemopi) {
    const recallQuery = [
        this.#planContent?.slice(0, 500) ?? "",
        feedbackBlock ?? "",
        roleSuggestions?.[id] ?? "",
    ].join(" ").slice(0, 800);  // 限制查询长度

    const relevant = await this.#mnemopi.recall(recallQuery, 5, {
        source: "swarm-worker-output",
        memoryType: "solution",
        ignoreSessionScope: true,   // 跨 session 召回
        useSynonyms: true,
        useMmr: true,
        updateRecallCounts: true,
    });

    if (relevant.length > 0) {
        const context = [
            "\n## 🔍 Related Solutions from Past Runs\n",
            ...relevant.map((r, i) =>
                `### ${i + 1}. ${r.source ?? "unknown"} (score: ${(r.score ?? 0).toFixed(2)})\n` +
                `\`\`\`\n${r.content}\n\`\`\``
            ),
        ].join("\n");
        taskPieces.push(context);
    }
}

// Guard（现在 taskPieces 可能更大了，ContextGuard 的 fallback 会处理）
const guard = guardTaskBudget(taskPieces, undefined, `Worker ${id}`);
// ... existing guard logic ...
```

#### Hook 3: Cloner 审查经验关联

**位置**: `roundtable.ts` 的 `ClonerCouncil.review()` 方法

**时机**: 构建 `reviewPrompt[]` 时，在 previousFindings 之后

**实现**:

```typescript
// 在 ClonerCouncil.review() 中:
const reviewPrompt = [
    `Review the output from iteration ${iteration + 1}.`,
    // ... existing pieces ...
];

// 🆕 召回类似历史 findings（如果配置了 mnemopi）
if (clonerMnemopi) {
    const similarFindings = await clonerMnemopi.recall(
        previousFindings?.join(" ") ?? workerOutput.slice(0, 500),
        3, {
            source: "swarm-cloner-finding",
            memoryType: "finding",
            ignoreSessionScope: true,
            useMmr: true,
        }
    );
    if (similarFindings.length > 0) {
        reviewPrompt.push(
            "\n## Similar Historical Findings",
            ...similarFindings.map((f, i) =>
                `- [Historical] ${f.content} (resolved: ${f.metadata_json?.resolved ? 'yes' : 'no'})`
            ),
        );
    }
}
```

### 4.4 After-loop 的经验存储（mnemopi 写入）

**位置**: `after-loop/experience.ts` 的 `ExperienceStore.addLesson()`

**变更**: 在写入 `lessons.jsonl` 的同时，调用 `mnemopi.remember()` 写入向量索引

```typescript
async addLesson(entry: ExperienceEntry): Promise<void> {
    // ... existing lesson.jsonl + sqlite FTS write ...

    // 🆕 写入 mnemopi 语义索引
    if (this.#mnemopi) {
        await this.#mnemopi.remember({
            text: entry.lesson.summary,
            metadata: {
                runId: entry.runId,
                outcome: entry.lesson.outcome,
                severity: entry.lesson.severity,
                category: entry.lesson.category,
            },
            memoryType: "loop-lesson",
            source: "swarm-experience",
            importance: entry.weight ?? 1.0,
            scope: "global",        // 跨 session 可检索
        });
    }
}
```

**Worker 输出归档**（可选，按需）:
```typescript
// 在 loop 结束后，将高质量 worker 输出写入 mnemopi
if (this.#mnemopi && result.status === "completed") {
    for (const r of workerResults) {
        const score = stateTracker.getWorkerScore(r.agent);
        if (score > 0) {  // 只归档表现好的 worker 输出
            await this.#mnemopi.remember({
                text: `Worker ${r.agent} solution: ${r.output.slice(0, 2000)}`,
                metadata: { workerId: r.agent, runId, iteration },
                memoryType: "solution",
                source: "swarm-worker-output",
                importance: Math.min(score / 10, 1.0),
                scope: "global",
            });
        }
    }
}
```

### 4.5 mnemopi 初始化 + 生命周期

**新增文件**: `packages/coding-agent/src/swarm/mnemopi-adapter.ts`

```typescript
import { Mnemopi } from "@oh-my-pi/mnemopi";
import type { RecallResult } from "@oh-my-pi/mnemopi";

export class SwarmMnemopiAdapter {
    readonly #mnemopi: Mnemopi;
    
    static async create(swarmDir: string): Promise<SwarmMnemopiAdapter> {
        const dbPath = path.join(swarmDir, ".omp", "memory.db");
        const mnemopi = await Mnemopi.open({
            dbPath,
            sessionId: `swarm-${path.basename(swarmDir)}`,
            embeddings: { /* 使用项目全局 embedding 配置 */ },
            reconcile: true,
        });
        return new SwarmMnemopiAdapter(mnemopi);
    }
    
    async recall(query: string, topK = 5, filters?: RecallFilters): Promise<RecallResult[]> {
        return this.#mnemopi.recall(query, topK, {
            source: filters?.source,      // "swarm-experience" | "swarm-worker-output" | "swarm-cloner-finding"
            memoryType: filters?.memoryType,
            ignoreSessionScope: filters?.crossSession ?? true,
            useSynonyms: true,
            useMmr: true,
            updateRecallCounts: true,
        });
    }
    
    async remember(input: RememberInput): Promise<void> {
        await this.#mnemopi.remember(input);
    }
    
    async close(): Promise<void> {
        await this.#mnemopi.close();
    }
}
```

**生命周期**: 在 `SessionRegistry.createSession()` 中创建，注入到 `SessionServices`:
```typescript
// session-registry.ts:createSession()
const mnemopi = await SwarmMnemopiAdapter.create(swarmDir);

const session: SessionServices = {
    ...services,
    abortController,
    sessionManager,
    mnemopi,            // ← 新增
};
```

### 4.6 改造量估算

| 文件 | 改动 | 行数 |
|------|------|------|
| `mnemopi-adapter.ts` | 新增 | ~80 |
| `before-loop-manager.ts` | 注入经验 context | +15 |
| `loop-controller.ts` (#spawnWorkers) | Worker 语义召回 | +20 |
| `roundtable.ts` (review) | Cloner 历史关联 | +15 |
| `after-loop/experience.ts` | mnemopi 双写 | +20 |
| `session-registry.ts` | 初始化和注入 | +15 |
| **合计** | | **~165 行** |

---

## Phase 5: 渐进式披露 + Swarm 级 L0-L3 记忆分层

### 5.1 目标

借鉴 TencentDB-Agent-Memory 的分层 prompt 注入和渐进式披露模式，让 Swarm 的上下文注入更加高效：

- **分层注入**：不同性质的信息注入到 prompt 的不同位置（system suffix vs user prefix），利用 LLM 的 prompt caching 降低重复成本
- **渐进式披露**：Worker 首次只接收核心 plan + 反馈，相关经验按需下钻

### 5.2 TencentDB 分层模型 → Swarm 映射

```
TencentDB-Agent-Memory           Swarm 映射
─────────────────────────        ──────────────────────────
L3 Persona (静态, system)  →     Swarm Persona (角色定义/工具限制/质量标准)
                                 注入位置: WORKER_SYSTEM_PROMPT 尾部
                                 
L2 Scene (动态, system)    →     Scene Context (plan.md + todos + file tree)
                                 注入位置: system prompt 后, 任务前
                                 更新频率: 每次 iteration 开始

L1 Memory (按需, user)     →     Semantic Episodes (mnemopi 召回)
                                 注入位置: Worker task 的 extraContext
                                 触发方式: Worker 通过 IRC 或 tool call 请求

L0 Raw (调试, 不注入)      →     session.jsonl (SwarmSessionManager)
                                 用途: 事后调试分析, 不进入 LLM context
```

### 5.3 分层 Prompt 注入设计

**当前**（Phase 3 状态）:
```text
System Prompt:
    WORKER_SYSTEM_PROMPT (静态, ~60行)
    + 无 persona 注入
    + 无 scene 注入

User/Task Prompt:
    全部一次性拼接: planContent + feedbackBlock + roleSuggestions + 
    nominationPrompt + extraContext + peer list + workspace path
```

**目标**（Phase 5）:
```text
System Prompt (可被 prompt caching 惠及):
    WORKER_SYSTEM_PROMPT (静态, 同前)
    + "\n## Swarm Persona\n"        ← L3: 静态 persona
    + "\n## Scene\n"                ← L2: 场景快照 (每次 iteration 更新)
      "Plan: {planSummary}"         ← plan.md truncated
      "Goals: {todosStatus}"        ← 当前 todo 状态
      "Peers: {peerList}"           ← worker 列表
      "Round: {iteration}/{maxIterations}"

User/Task Prompt (每次不同, prompt caching 不惠及):
    + "\n## This Round\n"           ← 本轮任务
      "Focus: {assignedArea}"
      "Feedback from Cloners: {feedbackBlock}"  ← compacted

    + "\n## Relevant Context\n"     ← L1: 按需注入 (mnemopi recall)
      "{relevantExperiences}"       ← 语义召回结果
    
    + "\n## Peer Deliberation\n"    ← 前轮讨论
      "{extraContext}"              ← round summary + peer outputs
```

**代码实现** (loop-controller.ts `#spawnWorkers()`):

```typescript
// 分层构建 system prompt
const systemPromptSuffix = buildSystemPromptSuffix({
    persona: this.#loopConfig.agentPersona?.[id] ?? DEFAULT_PERSONA,
    scene: {
        planSummary: this.#planContent?.slice(0, 1000) ?? "",
        todos: this.#stateTracker.state.todos
            ?.filter(t => t.status !== "completed")
            ?.map(t => `- [${t.status}] ${t.title}`)
            ?.join("\n") ?? "",
        peers: workerIds.filter(w => w !== id).join(", "),
        iteration: `${iter + 1}/${this.#loopConfig.maxIterations}`,
    },
});
agentDef.systemPrompt = [
    WORKER_SYSTEM_PROMPT,
    systemPromptSuffix,
].join("\n");

// 分层构建 task
const taskPieces = [
    `## This Round`,
    focusAssignment,            // "You are responsible for: ..."
    feedbackBlock ? `\n## Cloner Feedback\n${feedbackBlock}` : "",
];

// L1: 按需注入（可选，mnemopi 可用时）
if (this.#mnemopi) {
    const ctx = await this.#mnemopi.recall(
        `${this.#planContent?.slice(0, 300)} ${feedbackBlock ?? ""}`,
        3,
        { source: "swarm-worker-output", useMmr: true }
    );
    if (ctx.length > 0) {
        taskPieces.push(`\n## Relevant Past Solutions\n${formatContext(ctx)}`);
    }
}

taskPieces.push(
    `\n## Peer Deliberation\n${extraContext ?? "(first round, no prior outputs)"}`,
);

const guard = guardTaskBudget(taskPieces, contextWindow, `Worker ${id}`);
if (guard.exceeded) {
    // 渐进式降级: 先砍 L1, 再砍 deliberation
    taskPieces = taskPieces.filter(p => !p.startsWith("## Relevant Past Solutions"));
    // 如果还是超, 裁切 deliberation
    if (guardTaskBudget(taskPieces, contextWindow).exceeded) {
        taskPieces = taskPieces.filter(p => !p.startsWith("## Peer Deliberation"));
    }
}
```

### 5.4 渐进式披露的两种模式

#### 模式 A: Tool-call 驱动（Worker 主动下钻）

Worker 通过工具调用获取更多上下文，类似 TencentDB 的 Scene Navigation `read_file()`:

```text
Worker: "I need to understand the related past solutions for this auth issue"
    → tool_call: memory_search("auth JWT RS256 past solutions")
    → result: [3 relevant historical solutions]
    → Worker integrates and continues

Worker: "What files are in scope for my area?"
    → tool_call: file_tree(scope="auth/")
    → result: [list of files]
    → Worker proceeds with editing
```

**实现**: 注册 `memory_search` 和 `file_tree` 作为 worker 可用工具：

```typescript
// 在 agent tool definitions 中新增:
{
    name: "memory_search",
    description: "Search past swarm experiences for similar problems and solutions",
    parameters: {
        query: "string - natural language query",
        topK: "number - max results (default 3)",
    },
}
```

#### 模式 B: 事件驱动（自动注入触发）

当 Worker 遇到特定事件时，自动注入相关上下文：

| 触发事件 | 自动注入 |
|----------|---------|
| Worker 被 file lock 阻塞 | 注入: "This file was edited by worker-X in past run #42 with approach Y" |
| Worker 连续 2 次 FAIL | 注入: "Historical fix for similar failure: ..." |
| 新 worker 加入 (scale-up) | 注入: "mentor worker-Z's past solutions on this topic" |

**实现**: Worker crash/block/scale-up 事件触发 mnemopi 异步查询 → 结果通过 IRC steering message 推送给 Worker。

### 5.5 L0-L3 数据生命周期

```
┌──────────────────────────────────────────────────────────────┐
│                      After-Loop                               │
│                                                               │
│  原始输出 ──→ L0 session.jsonl (SwarmSessionManager, 已有)    │
│       │                                                       │
│       ├──→ L3 Persona 更新 (如果角色进化)                      │
│       │       存储在 .swarm_{name}/.omp/persona.yaml           │
│       │                                                       │
│       ├──→ L2 Scene 归档                                      │
│       │       plan.md → .omp/plans/plan-{runId}.md (已有)    │
│       │                                                        │
│       └──→ L1 Episodes 提取                                   │
│              extractor → summarizer → experience store        │
│              + 🆕 mnemopi.remember() 写入语义索引              │
│                                                               │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                      Before-Loop / In-Loop                    │
│                                                               │
│  L3 Persona ──→ 注入 system prompt suffix (静态, cached)      │
│  L2 Scene   ──→ 注入 system prompt (每 iteration 更新)        │
│  L1 Memory  ──→ 注入 user prompt (mnemopi 按需 recall)        │
│  L0 Raw     ──→ 不注入 (仅事后调试)                           │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### 5.6 改造量估算

| 子任务 | 文件 | 改动 | 行数 |
|--------|------|------|------|
| 分层 prompt 构建 | `loop-controller.ts` | prompt 构建逻辑拆分为 system/task 两层 | ~60 |
| L3 Persona 支持 | `loop-controller.ts` + YAML schema | agent persona 字段 + system suffix 注入 | ~30 |
| 渐进降级逻辑 | `loop-controller.ts` | ContextGuard exceeded 时按 (L1 → deliberation) 逐层砍 | ~20 |
| `memory_search` 工具 | 新增 `swarm/tools/memory-search.ts` | Worker 可用的 mnemopi 查询工具 | ~50 |
| 事件驱动注入 | `loop-controller.ts` (block/crash handler) | 阻塞/崩溃时自动召回相关经验 | ~30 |
| 降级文档 | README / 注释 | 渐进式降级策略说明 | ~30 |
| **合计** | | | **~220 行** |

---

## 两阶段依赖关系

```
Phase 4 (mnemopi)  ──────────→ Phase 5 (分层 + 渐进披露)
    │                                │
    │ mnemopi.recall() API           │ 依赖 mnemopi 提供的语义召回
    │ 提供基础语义检索能力             │ 才能实现 L1 按需注入
    │                                │
    └────────────────────────────────┘
```

Phase 4 是 Phase 5 的前置依赖：渐进式披露中的 L1 "按需语义召回" 需要等 mnemopi 集成完成后才能实现。

---

## 与已有代码的复用关系

| 新组件 | 复用的已有模块 | 复用方式 |
|--------|---------------|---------|
| `SwarmMnemopiAdapter` | `@oh-my-pi/mnemopi` 的 `Mnemopi`、`recall()`、`remember()` | 直接包装，不重写检索逻辑 |
| L3 Persona | YAML schema 中已有 `agentRestrictions`，扩展即可 | 在 loop.yaml 中新增 `persona` 字段 |
| L2 Scene | `StateTracker.state.todos`、`plan-paths.ts`、`planContent` | 已有数据源，只需重新组织注入位置 |
| L1 Memory recall | Phase 4 的 `SwarmMnemopiAdapter.recall()` | 直接调用 |
| 渐进降级 | `ContextGuard.guardTaskBudget()` (Phase 1 已落地) | 已有守卫，扩展降级优先级 |

不需要重新发明任何轮子。所有底层能力（token 计数、session 持久化、mnemopi 检索、plan 管理）均已就绪，Phase 4-5 主要工作是**编排层**的集成逻辑。

---

## Phase 5.5: Mermaid 渐进式披露索引（TencentDB Offload Pipeline 映射）

### 5.5.1 目标

借鉴 TencentDB-Agent-Memory 的完整四层 offload pipeline (L1→L1.5→L2→L3)，在 SatoPi 的 Swarm 循环中实现：

- **L1 工具摘要**: Worker/Cloner 完成产出后，LLM 生成高密度 JSON 摘要（≤200 字 + score 0-10）
- **L1.5 去重+边界检测**: 合并重复条目、检测任务完成/阻塞/phase 转换
- **L2 节点归因**: 将 L1 条目归因到 plan.md 的 phase 节点，建立 Mermaid 节点→Worker 产出的映射
- **L3 MMD 合成**: 合并多 Wave 的 L2 输出，生成/更新 `.omp/context-graph.mmd`

### 5.5.2 TencentDB Pipeline → SatoPi 完整映射

```
TencentDB 四层              SatoPi 对应实现
─────────────────────       ─────────────────────────────────
L1: 工具摘要                 afterWave hook → 收集 Worker/Cloner 产出
   tool_call → summary         SingleResult.output → OffloadEntry {worker_id, summary, score}
   阈值=4 触发 flush            阈值=当前 Wave 全部完成触发 flush

L1.5: 去重+边界检测           afterIteration hook → 跨 Worker 去重
   merge duplicates             去重相同 worker 连续重复产出
   task boundary detection      检测 Roundtable verdict 中的 phase 完成/阻塞
                               检测 loop-convergence → 任务完成边界

L2: 节点归因                  L2 调度器 (poll-based, afterIteration)
   条目→Mermaid 节点            将 L1 条目归因到 plan.md phase
   node_id 分配                 建议节点 (001-N1, 001-N2...)
   边关系提出                   Worker A→B 协作边 / Worker→Cloner 审查边

L3: MMD 合成                   afterIteration + beforeIteration
   合并多轮 L2 输出             合并多 Wave L2 归因结果
   生成/更新 .mmd                 写入 .omp/context-graph.mmd
   MMD 注入 agent context       分层注入 (详见 5.5.6)
```

### 5.5.3 核心数据结构

```typescript
// L1 产出：OffloadEntry（对应 TencentDB 的 OffloadEntry）
interface SwarmOffloadEntry {
  timestamp: string;           // ISO 8601
  agent_type: "worker" | "cloner" | "orchestrator";
  agent_id: string;            // "worker-a1", "cloner-guardian"
  iteration: number;
  phase_id?: string;           // 对应 plan.md 中的 phase（L2 填充）
  node_id?: string;            // MMD 节点 ID（L2 填充，如 "001-N1"）
  task_call: string;           // 任务描述（Worker: 分配的子任务, Cloner: 审查角色）
  summary: string;             // LLM 生成，≤200 字
  score: number;               // 0-10（Worker: Cloner 评分, Cloner: verdict score）
  result_ref?: string;         // artifact:// 引用（大型产出）
  dependencies?: string[];     // 依赖的其他 node_id（L2 填充）
}

// MMD 节点状态
type MmdNodeStatus = "done" | "doing" | "todo" | "blocked";

// 分层 MMD 视图
interface MmdView {
  agent_type: "worker" | "cloner" | "orchestrator";
  node_ids: string[];          // 该视图包含的节点 ID
  full_mmd: string;            // 完整 Mermaid flowchart
  summary_text: string;        // 文本摘要（fallback 用）
}
```

### 5.5.4 存储布局

```
.swarm_{name}/.omp/
├── plan.md                     # 已有：Plan 文件
├── sessions/                   # 已有：SwarmSessionManager
├── offload/                    # 🆕 卸载存储
│   ├── worker-a1.jsonl        # Worker #a1 的 L1 条目录
│   ├── worker-a2.jsonl        # Worker #a2 的 L1 条目录
│   ├── cloner-guardian.jsonl  # Cloner guardian 的审查记录
│   ├── cloner-adversarial.jsonl
│   ├── orchestrator.jsonl     # LoopController 的决策记录
│   └── merged.jsonl           # L2 合并后的归因条目
├── mmds/                       # 🆕 Mermaid 上下文图
│   └── context-graph.mmd      # 当前 iteration 的合成图
├── mmds-archive/               # 🆕 历史 MMD 归档
│   └── iter-001-context-graph.mmd
└── refs/                       # 🆕 完整产出归档
    └── {timestamp}.md          # 大型 Worker 产出的原始文本
```

### 5.5.5 四层 Pipeline 详细设计

#### L1: Worker/Cloner 产出摘要（afterWave hook）

**触发时机**: `afterWave` hook，每个 Wave 完成后

**输入**: `WaveResult.results: Map<string, SingleResult>`

**处理流程**:
```
Wave 完成 (Workers 全部返回 或 Cloners 全部完成)
  │
  ├→ 对每个 agent:
  │     ├→ 提取 output 文本
  │     ├→ 如果 output > 2000 tokens → 先写 ArtifactManager.save() → 得到 result_ref
  │     ├→ 调用轻量 LLM 摘要：
  │     │     prompt: "Summarize this agent output in ≤200 chars, focus on key actions and outcomes"
  │     │     input:  output.slice(0, 4000)  // 截断避免摘要 LLM 超预算
  │     ├→ 构造 OffloadEntry
  │     └→ SessionStorageWriter.append() 写入 offload/{agent_id}.jsonl
  │
  └→ 如果 pending 条目数 ≥ forceTriggerThreshold(4):
        └→ 触发 L1.5 去重（异步 fire-and-forget）
```

**关键设计**:
- 使用 `SessionStorageWriter.openWriter(path, {flags:"a"})` 追加写入（复用已有）
- 大型产出 (>2000 tokens) 通过 `ArtifactManager.save()` 存为 artifact（复用已有）
- 摘要 LLM 使用独立的轻量模型（如 DeepSeek V3 Lite），不与 Worker 主 LLM 竞争

#### L1.5: 去重 + 任务边界检测（afterIteration hook）

**触发时机**: `afterIteration` hook，每轮迭代完成后

**去重逻辑**:
- 同一个 worker 在连续 iteration 中产出完全相同的摘要 → 合并为一条，标注 `duplicate_of: prev_node_id`
- L1 score < 3 的条目 → 标记为 `noise`，不进入 L2

**边界检测逻辑**:
- Roundtable verdict 全部 PASS + todos 全部完成 → 标记 `task_boundary: "completed"`
- Roundtable verdict 中有 FAIL + 连续 N 轮未解决 → 标记 `task_boundary: "blocked"`
- LoopController 判定 convergence → 标记 `task_boundary: "converged"`
- plan.md 中所有 phase 标记完成 → 标记 `task_boundary: "session_end"`

#### L2: 节点归因（独立调度，afterIteration 内触发）

**触发条件**:
- L1.5 完成（去重+边界检测完成）
- null 条目数 ≥ `l2NullThreshold`(3) 或距上次 L2 ≥ `l2TimeoutSeconds`(120)

**归因逻辑**:
```
输入: L1 条目列表 + plan.md phase 结构 + 已有 MMD 节点

对每个 L1 条目:
  ├→ 匹配到 plan.md 中的 phase:
  │     ├→ 如果是 Worker 产出 → 归因到对应 phase 的子任务节点
  │     ├→ 如果是 Cloner 裁决 → 归因到审查节点（附加到被审查的 Worker 节点）
  │     └→ 如果是 LoopController 决策 → 归因到 phase 转换节点
  │
  ├→ 提出边关系:
  │     ├→ Worker A 产出引用了 Worker B 的文件 → 建立 B→A 协作边
  │     ├→ Worker 产出 → Cloner 审查 → 建立产出→审查边
  │     └→ Phase 依赖 → 建立 phase 间依赖边
  │
  └→ 分配 node_id: 如 "001-N1"（001=iteration, N1=节点序号）
```

**归因 Prompt 模板**:
```
## 任务
将以下 Agent 执行记录映射到 Plan 的 Phase 结构，生成 Mermaid flowchart TD。

## Plan 结构
{plan_md_phases}

## Agent 执行记录
{L1_entries_formatted}

## 已有 MMD 节点（增量归因）
{existing_mmd_nodes}

## 要求
1. 每个节点 ID 以 {mmd_prefix} 开头（如 {mmd_prefix}-N1）
2. 节点代表宏观步骤，可聚合多个 Agent 产出
3. 使用 status: done|doing|blocked 标注节点状态
4. 提出边关系：顺序边 (-->) 和依赖边 (-.->)
5. 每个节点必须有对应的 L1 条目来源（不允许编造）
```

#### L3: MMD 合成 + 分层注入

**合成时机**: L2 完成后，每次 iteration 结束时

**合成逻辑**:
```
输入: 历史 MMD (从 mmds-archive/) + 本轮 L2 输出

1. 合并 L2 节点到已有 MMD 图 → 更新节点状态
2. 移除过时的 blocked→done 转换边
3. 添加新的 iteration summary 节点
4. 写入 .omp/mmds/context-graph.mmd（当前活跃）
5. 归档到 .omp/mmds-archive/iter-{N}-context-graph.mmd
```

**MMD 节点格式示例**:
```
flowchart TD
    001-N1["Phase 1: API Layer<br/>status: done<br/>summary: Worker #a1 REST API (3/3 PASS)<br/>Worker #a2 GraphQL schema (3/3 PASS)"]
    001-N2["Phase 2: Auth Module<br/>status: doing<br/>summary: Worker #b1 JWT implementation (2/3 PASS)<br/>finding: missing key rotation"]
    001-N1 -->|"API 就绪"| 001-N2
    001-N2 -.->|"被审查"| 001-C1["Cloner Review<br/>Round 1: 2/3 PASS<br/>blocked: JWT rotation"]
    
    class 001-N1 done
    class 001-N2 doing
    class 001-C1 blocked
```

### 5.5.6 MMD 分层注入策略

不同 Agent 类型看到不同粒度的 MMD 图：

| Agent 类型 | 注入时机 (Hook) | MMD 视图 | 内容 |
|-----------|----------------|---------|------|
| **Worker** | `beforeWave` (Worker wave) | **局部视图** | 只含自己负责的 phase 节点 + 上游已完成依赖节点 |
| **Cloner Council** | `beforeWave` (Cloner wave) | **全局审查视图** | 所有 Worker 执行节点 + 本轮审查节点 + 历史 findings |
| **LoopController** | `beforeIteration` | **全景编排视图** | 完整 MMD 图 + 历史迭代归档引用 |

**注入格式**:
```xml
<current_swarm_context>
  <!-- Mermaid 上下文图（轻量骨架，始终保留） -->
  {mmd_fragment_for_this_agent}
</current_swarm_context>

<!-- worker 如需下钻，可引用 offload node_id -->
<!-- To see full details for node 001-N1, check .omp/offload/worker-a1.jsonl -->
```

**渐进式降级策略**（ContextGuard 超限时）:
```
优先级 1 (最后砍): Mermaid 图本身（核心骨架，永远保留）
优先级 2:        offload 引用列表
优先级 3:        历史 iteration MMD 归档引用
优先级 4 (最先砍): Worker 全量产出文本
优先级 5 (最先砍): peer deliberation 全量文本
```

### 5.5.7 改造量估算

| 子任务 | 文件 | 改动 | 行数 |
|--------|------|------|------|
| `SwarmOffloadStore` | 新增 `swarm/offload/store.ts` | JSONL 读写 + artifact 管理（包装已有） | ~120 |
| L1 摘要逻辑 | 新增 `swarm/offload/l1-summarizer.ts` | LLM 摘要调用 + OffloadEntry 构造 | ~80 |
| L1.5 去重+边界检测 | 新增 `swarm/offload/l15-dedup.ts` | 去重 + 边界检测 | ~60 |
| L2 节点归因 | 新增 `swarm/offload/l2-attributor.ts` | Prompt 构造 + MMD 节点生成 | ~100 |
| L3 MMD 合成 | 新增 `swarm/offload/l3-synthesizer.ts` | MMD 合并 + 文件写入 | ~80 |
| MMD 分层注入 | 新增 `swarm/offload/mmd-injector.ts` | 分层视图构建 + XML 标签注入 | ~70 |
| Offload Pipeline 编排 | 新增 `swarm/offload/pipeline.ts` | 四层 Pipeline 编排 + Hook 注册 | ~90 |
| Hook 注册 + 集成 | `loop-controller.ts` (修改) | 注册 PipelineHooks | ~30 |
| Schema 扩展 | `schema.ts` (修改) | Offload 配置字段 | ~20 |
| 设计文档更新 | `satopi-phase4-5-design.md` | 完整 Phase 5.5 文档 | 本文件 |
| **Phase 5.5 合计** | | | **~650 行** |
| Phase 4 (mnemopi) 合计 | | | **~165 行** |
| Phase 5 (分层 prompt) 合计 | | | **~220 行** |
| **全部合计** | | | **~1035 行** |

### 5.5.8 与其他 Phase 的依赖关系

```
Phase 1-3 (已落地) ──── 提供基础设施
    │
    ├──→ Phase 4 (mnemopi) ──── 提供语义召回能力 ──→ Phase 5 (分层注入)
    │                                                        │
    │                                                        └──→ Phase 5.5 (MMD 索引)
    │                                                              │
    │    ┌─────────────────────────────────────────────────────────┘
    │    │  依赖 mnemopi 召回作为 L1 上下文增强
    │    │  依赖 ContextGuard 作为渐进降级守卫
    │    │  依赖 SessionStorageWriter 作为持久化引擎
    │    │  依赖 PipelineHooks 作为生命周期插入点
    └────┘
```

Phase 5.5 是 Phase 5 的增强，可独立实施（不阻塞 Phase 5），但完整的"按需下钻"体验需要 Phase 4 (mnemopi) 的语义检索能力。

---

## Phase 5.5 实现总结（2026-07-20）

### 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `swarm/offload/offload-paths.ts` | 77 | `.omp/offload/` `.omp/mmds/` `.omp/refs/` 路径工具 |
| `swarm/offload/offload-store.ts` | 194 | `SwarmOffloadStore` — JSONL 追加读写 + 按 agentId 查询 |
| `swarm/offload/worker-summarizer.ts` | 106 | L1: Worker/Cloner 产出 → ≤200 字摘要（文本截取） |
| `swarm/offload/deduplicator.ts` | 132 | L1.5: 去重 + 噪声过滤(score<3) + ReviewVerdict 边界检测 |
| `swarm/offload/plan-node-attributor.ts` | 170 | L2: 条目→Mermaid node_id 归因 + 边关系提出 |
| `swarm/offload/offload-pipeline.ts` | 262 | L1→L1.5→L2 流水线编排器 |
| `swarm/offload/mermaid-synthesizer.ts` | 180 | L3: Mermaid flowchart TD 模板拼接 + `writeTextAtomic` 写入 |
| `swarm/offload/mmd-injector.ts` | 218 | 三种分层 MMD 视图构建（Worker局部/Cloner全局/全景） |
| `swarm/offload/offload-hooks.ts` | 309 | `createOffloadHooks()` — `LoopPipelineHooks` 接口实现 |
| `swarm/offload/index.ts` | 55 | Barrel 导出 |
| `swarm/mnemopi-adapter.ts` | 266 | Phase 4: `SwarmMnemopiAdapter` — 4 hook 点语义召回集成 |
| **合计** | **1969** | |

### 关键设计原则

1. **loop-controller.ts 零修改** — 全部通过 `LoopPipelineHooks` 接口注入
2. **基础设施零新增** — 复用 `SessionStorageWriter` / `writeTextAtomic` / `ArtifactManager`
3. **Mermaid 纯模板拼接** — 不调 LLM，O(n) < 1ms
4. **分层视图注入** — Worker 局部 / Cloner 全局 / LoopController 全景
5. **JSONL 追加写入 fire-and-forget** — 写入失败不阻塞 loop

### Hook 集成映射（loop-controller.ts 已有）

| Hook | 行号 | Offload 实现 |
|------|------|-------------|
| `beforePipeline` | 442 | 初始化 Store |
| `beforeIteration` | 511 | `MmdInjector.buildFullView()` |
| `beforeWorkerRound` | 599 | `MmdInjector.buildWorkerView()` |
| `afterWorkerRound` | 635 | L1 WorkerSummarizer → JSONL |
| `beforeClonerReview` | 859 | `MmdInjector.buildClonerView()` |
| `afterClonerReview` | 876 | L1 Cloner 摘要 → JSONL |
| `afterIteration` | 1108 | L1.5→L2→L3 流水线 |
| `afterPipeline` | 1133 | 清理 + 归档 |

### Schema 扩展

- `LoopSwarmConfig` 新增 `mnemopi?: MnemopiConfig` + `offload?: OffloadConfig`
- `resolveLoopConfig()` 新增默认值解析：`parseMnemopiConfig()` + `parseOffloadConfig()`

### YAML 配置示例

```yaml
offload:
  enabled: true
  l1_trigger_threshold: 4
  l2_null_threshold: 3
  l2_timeout_seconds: 120
  inject_mermaid: true

mnemopi:
  enabled: true
  top_k: 5
  deduplicate: true
  auto_store_threshold: 5
```
