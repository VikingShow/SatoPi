# Swarm v3 架构问题 & 优化方案

> 2026-07-26 · 上下文管理系统调研 · 含 TencentDB Memory 源设计对比

---

## 问题总览

| # | 问题 | 严重度 | 工作量 |
|---|------|--------|--------|
| 1 | `ContextCompactor` 与 oh-my-pi compaction 冗余 | 高 | 小 |
| 2 | OffloadPipeline 仅 swarm 使用，无法服务非 swarm agent | 高 | 大 |
| 3 | Agent Profile 单文件多 agent，无 offload 引用 | 中 | 中 |
| 4 | MarkEnvironment 本可全局使用但未全局化 | 低 | 小 |
| 5 | Script 阶段仅单 agent，不支持多 agent 协作 | 中 | 中 |
| 6 | Offload 原文追溯不完整（L2/L3 无 result_ref） | 低 | 小 |
| 7 | ProfileRegistry 仅 swarm 创建，非 swarm agent 无持久身份 | 中 | 中 |
| 8 | Offload 层定义偏离 TencentDB 源设计 (L1/L1.5/L2/L3) | 高 | 大 |
| 9 | MMD 注入时机错误 (per-spawn 而非 per-turn) | 高 | 大 |
| 10 | 缺少 L3 三级上下文压缩 (Mild/Aggressive/Emergency) | 高 | 大 |

---

## 1. ContextCompactor 冗余

### 现状

| | oh-my-pi compaction | Swarm ContextCompactor |
|---|---|---|
| 策略 | 5 种（v2 streaming, shake, prune, snapcompact, branch-summarize） | 3 种（Summarize, Truncate, OffloadToStigmergy） |
| Token 计数 | `estimateTokens()` — 按消息类型精确（含 thinking, image, bash） | 无独立计数，用 `countTokens()` + 裸阈值 |
| 触发 | `shouldCompact()` — 基于 CompactionSettings 的阈值 | 各策略独立阈值（90%, 80%, 85%） |
| 集成 | `AgentSession` 中自动触发 | **从未接入生产路径** |
| 持久化 | `CompactionEntry` → session JSONL | `CompactedContext.stigmergyMark` → MarkEnvironment |

### 方案

1. **删除** `swarm/context-manager/context-compactor.ts`
2. 在所有 agent 创建时统一使用 oh-my-pi 的 `shouldCompact()` + `prepareCompaction()` + `compact()`
3. `StageBehavior` / `AgentHandle` 中调用，不是新的包装器

---

## 2. OffloadPipeline 全局化 + 目录统一

### 当前分散状态

```
{workspace}/
  profiles.json                 ← AgentProfile (所有 agent 一个文件)
  .swarm_{name}/
    .stp/
      session.jsonl             ← SwarmSessionManager
      offload/{agentId}.jsonl   ← SwarmOffloadStore
      mmd/                      ← MermaidSynthesizer
```

### 统一方案

将所有持久化文件收束到 `.omp/` 下：

```
{workspace}/
  .omp/
    profiles/                          ← AgentProfile (分文件)
      {profileId}.json
      _index.json
    offload/                           ← 上下文卸载 (全局)
      {agentName}/
        state.json                     ← 活跃 MMD, 计数器, L2 触发时间
        offload-{sessionId}.jsonl      ← 按 session 分隔
        refs/                          ← 完整 tool result 原文
        mmds/                          ← Mermaid 文件
    sessions/                          ← 所有 session (已存在)
      {sessionId}.jsonl
```

---

## 3. Agent Profile 改造

### 现状

```
{workspace}/profiles.json   ← 所有 agent 共一个文件
{
  "profileId": "worker-a1",
  ... (identity, expertise, credit, social, stats)
  -- 无 offloadRefs -- 无上下文历史引用
}
```

### 方案

#### A. 分文件存储

```
{workspace}/.omp/profiles/
  {profileId}.json     ← 每 agent 独立
  _index.json           ← 轻量索引 { profileId, archetype, score, lastActive }
```

#### B. 添加 offloadRefs

```typescript
interface AgentProfile {
  // ... 现有字段 ...
  offloadRefs: {
    l1History: Array<{
      timestamp: string;
      sessionDir: string;    // 指向某个 session 目录
      offloadPath: string;   // "{sessionDir}/.omp/offload/{agentId}.jsonl"
      entryIndex: number;    // JSONL 行号，O(1) 定位
      taskCall: string;
      score: number;
    }>;
    l2Attributions: Array<{
      nodeId: string;        // L2 分配的 MMD 节点 ID
      sessionDir: string;
      entryRange: [number, number];
    }>;
    l3GraphRefs: Array<{
      timestamp: string;
      mmdPath: string;
      nodeCount: number;
    }>;
  };
}
```

**履历查询流程**：
1. 看 `profile.offloadRefs.l1History` → 浏览摘要
2. 点击 → 按 `offloadPath` + `entryIndex` 读原文
3. 看 `l2Attributions` → 了解在 MMD 图的位置
4. 看 `l3GraphRefs` → 打开 Mermaid 图

---

## 4. MarkEnvironment 全局化

### 方案

提升到 `SharedServices`，所有 agent（swarm 或非 swarm）共享同一个。改动点数：2 行类型声明 + 1 行赋值。

```typescript
interface SharedServices {
  markEnvironment: MarkEnvironment;  // ← 新增
}
```

---

## 5. Script 阶段多 Agent 协作

### 方案

```typescript
const [dialoguer, planner, critic] = await ctx.runtime.spawn([
  { id: "dialoguer", role: "dialogue-agent",   task: "对话 human，不写 plan" },
  { id: "planner",   role: "plan-writer",      task: "只听不聊，写 plan.md" },
  { id: "critic",    role: "adversarial-analyst", task: "挑战性分析，写 critique.md" },
]);
```

- `dialoguer` 与 human 多轮对话
- `planner` 静默观察，产出 `plan.md`
- `critic` 静默观察，产出 `critique.md`
- 完成后进入 `script-debate` 合并

---

## 6. Offload 原文追溯

`SwarmOffloadEntry` 增加：

```typescript
interface SwarmOffloadEntry {
  // ... 现有字段 ...
  result_ref?: string;     // artifact:// URI → 完整输出 ← 已存在，补全 L2/L3
  source_offset?: number;  // JSONL 字节偏移 → O(1) 定位 ← 新增
}
```

---

## 7. ProfileRegistry 全局使用

从 `swarm-cli.ts` 的 factory 闭包中提升到通用 agent 会话创建路径。

---

## 8. TencentDB Memory 源设计对比 & 融合方案

> 基于对 `TencentDB-Agent-Memory/src/offload/` 完整源代码 + L1/L1.5/L2 Prompt 的阅读

### 8.1 层定义对比：SatoPi 偏离源设计

| 层级 | TencentDB (源设计) | SatoPi (当前) | 偏离程度 |
|------|--------------------|----------------|----------|
| **L0** | 原始 tool call/result 捕获 → `refs/*.md` 文件 | 不存在 | **缺失** |
| **L1** | 每个 ToolPair(tool call + result) → LLM 摘要 + replaceability score(0-10) | 每个 agent turn(AgentMessage[]) → 纯文本截断(200字) | **严重偏离** |
| **L1.5** | LLM 语义分析: 3步判断(recentMessages→currentMmd→availableMmds) → 输出 taskCompleted/isLongTask/isContinuation/newTaskLabel | 纯字符串去重(Deduplicator, cosine相似度) | **严重偏离** |
| **L2** | LLM 生成 Mermaid 图: write/replace 模式 + node_mapping 回填 + <=4000字优化 | PlanNodeAttributor 启发式归属到 plan.md 节点 | **偏离** |
| **L3** | Mild/Aggressive/Emergency 三级上下文实时替换 | MermaidSynthesizer(纯模板拼接生成 MMD 文件) | **完全偏离: L3应该是上下文替换** |
| **L4** | Skill 生成(从 MMD + offload 条目) | 不存在 | 暂不需要 |

### 8.2 SatoPi 偏离根源

1. **压缩单位错误**: 应按 tool call/result pair 压缩(TencentDB 的 `ToolPair`),不是 agent turn
2. **L3 角色错误**: L3 应该是运行时上下文替换(mild/aggressive/emergency),不是 Mermaid 图生成
3. **LLM 缺失**: L1/L1.5/L2 全部应该使用 LLM,而非纯文本/启发式方法
4. **MMD 注入时机错误**: 应该 per-turn(每个 user message 前),不是 per-spawn

### 8.3 融合后的正确四层架构

```
Code Block: context-offload-fusion
Title: 融合后的 Offload 四层架构

L0: Capture (新)
   每个 tool call + result -> 写入 .omp/offload/{agent}/refs/
   保留完整原文(MD 文件),供 L3 恢复

L1: LLM 摘要 (改造)
   输入: ToolPair[] (tool call + result 对)
   LLM: 轻量模型(gpt-4o-mini / deepseek-v3)
   输出: OffloadEntry { summary, score(0-10), result_ref }
   触发: pending tool pairs >= forceTriggerThreshold(4)
   失败降级: 3 次重试后 degraded entry(score=0)

L1.5: 任务边界检测 (改造)
   LLM: 3步分析 (recentMessages -> currentMmd -> availableMmds)
   输出: TaskJudgment { taskCompleted, isLongTask, isContinuation, newTaskLabel }
   短对话/闲聊 -> "short" 边界(不创建 MMD)
   新长任务 -> "long" 边界(创建新 MMD)
   任务延续 -> 复用旧 MMD 文件

L2: Mermaid 图合成 (改造)
   LLM: 生成 flowchart TD + semantic shapes
   模式: write(全量) / replace(行级 patch)
   输出: node_mapping(tool_call_id -> node_id) + 回填到 JSONL
   <=4000 字符优化 + 弹性节点聚合 + 墓碑节点
   触发: node_id=null >= l2NullThreshold OR 超时

L3: Compact Context (新 -- 核心)
   Mild:   tokens/contextWindow >= 0.5
   Aggressive: >= 0.85
   Emergency: >= 0.95
   快速重放路径: O(1) boundary fingerprint 跳过
```

### 8.4 TencentDB 的三级 L3 压缩 (SatoPi 完全缺失)

| 策略 | 触发条件 | 行为 |
|------|----------|------|
| Mild offload | tokens/contextWindow >= 0.5 | 替换非当前任务 tool result 为摘要 (XML 格式) |
| Aggressive delete | >= 0.85 | 删除最旧 N% 消息 (保护 MMD 注入 + tool-pair 安全) |
| Emergency compress | >= 0.95 | 删除直到 <= 0.6 (保留最小消息数) |

关键机制:
- Fast-path re-apply: 已 offload 的消息在 replay 时 O(1) 跳过
- Boundary fingerprint: 记录压缩边界,避免重复计算 tiktoken
- Tool-pair safety: 不破坏 tool_use/tool_result 配对
- MMD 保护: 压缩删除时不删除 MMD 注入消息

### 8.5 TencentDB 的 L2 Prompt 核心设计

```text
弹性聚合: LLM 自主决定节点拆合。连续相同意图的常规动作 -> 合并为宏观节点。
认知墓碑: 彻底走不通的死胡同 -> 建立 blocked 节点 ("不要再重复此操作")
Semantic shapes: 不同形状代表不同节点逻辑类型。让形状替你说话。
line-level replace: 不重写整个 MMD,只 patch 特定行范围 (start_line/end_line)
node_mapping 回填: 每个 tool_call_id 必须映射到一个 node_id,不允许遗漏
<=4000 字符预算: 各种整合手段压缩到 4000 字以内
```

### 8.6 MMD 注入改造

**当前 (错误)**:
```
Agent spawn -> ContextPipeline.assemble() -> OffloadSource -> 一次性 injectedMessages
```

**改造后 (正确)**:
```
AgentSession 每个 turn:
  before_prompt_build (full inject):
    1. injectMmdIntoMessages()
    2. 找到最近 user message 插入点
    3. 构建活跃 MMD 文本
    4. 检查 token 预算 (mmMaxRatio * contextWindow)

  after_tool_call (incremental):
    1. maybeUpdateMmdInMessages()
    2. fingerprint 对比,变化时重新注入
```

### 8.7 与 oh-my-pi 现有 Compaction 的融合

融合策略: L3 compact context 是 oh-my-pi compaction 的增强层,不是替代。

```
oh-my-pi compaction graph:
  prune (每次 turn)
    -> shake (tool output 过大)
      -> shouldCompact?
        -> YES: compact -> snapcompact/v2-streaming/branch-summarize
          -> L3: mild/aggressive/emergency (NEW)
        -> NO: continue
```

---

## 分阶段实施

| 阶段 | 内容 | 依赖 | 工作量 | 描述 |
|------|------|------|--------|------|
| **P0** | 删除 ContextCompactor + 统一路径到 `.omp/` | 无 | 小 | 删除死代码,统一直链 |
| **P0** | Profile 分文件 + offloadRefs | 无 | 中 | 为 offload 全局化打地基 |
| **P1** | L1 改为 per-ToolPair + LLM 摘要 | P0 | 中 | 对齐 TencentDB L1 |
| **P1** | L1.5 改为 LLM 任务边界检测 | P0 | 中 | 对齐 TencentDB L1.5 |
| **P1** | L2 改为 LLM Mermaid 生成 + replace 模式 | P0 | 大 | 对齐 TencentDB L2 |
| **P1** | L3 实现 Mild/Aggressive/Emergency 三级压缩 | P0+P1 | 大 | 核心新功能 |
| **P1** | MMD per-turn 注入 (非 per-spawn) | P0 | 中 | 对齐 TencentDB 注入时机 |
| **P1** | MarkEnvironment 全局化 | 无 | 微小 | 2 行改动 |
| **P2** | Script 阶段三 agent 协作 | 无 | 中 | 提升规划质量 |
| **P2** | Offload 原文追溯 (result_ref + 字节偏移) | P0 | 小 | 完善溯源 |
| **P2** | ProfileRegistry 全局使用 | P0 | 中 | 通用场景启用 |

---

## 关键设计原则 (从 TencentDB 采纳)

1. **Defense-in-depth**: 每层有独立的降级路径 (LLM 失败 -> degraded entry/fallback boundary)
2. **Immutable StorageContext**: 路径在 session 创建时冻结,不可被其他 session 影响
3. **Per-agent data dir, per-session JSONL**: agent 跨 session 共享 mmds/ 和 state.json
4. **Token 预算最小化**: MMD 注入受 `mmdMaxTokenRatio` 限制,不挤占主要的上下文窗口
5. **L1.5 门神**: task 生命周期由 LLM 判断 -- 完成/延续/新任务 -- 不是简单的字符串比较
6. **L2 Semantic shapes**: LLM 为不同操作类型选择不同 Mermaid 节点形状
7. **L2 Elastic aggregation**: LLM 自主合并连续同类操作,保持图表宏观克制
8. **L3 Tool-pair safety**: 压缩删除时不破坏 tool_use/tool_result 配对
