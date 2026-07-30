# SatoPi 实时数据流与硬编码问题分析

> **分析日期**: 2026-07-22
> **范围**: `packages/coding-agent/src/swarm/` (后端) + `packages/swarm-gui/src/` (前端)
> **方法**: 逐文件、逐行审查 SSE 事件流、状态同步、UI 渲染路径

---

## 一、Worker 和 Cloner 的输出内容与逻辑

### 1.1 Worker 输出

Worker 是由 `executor.ts` 的 `executeSwarmAgent()` 生成的子进程。每个 worker 的**核心输出**是：

| 输出 | 产生方式 | 内容 |
| --- | --- | --- |
| **stream_delta** | Agent LLM 逐 token 生成 | 文本增量，每 token 触发一次 |
| **stream_start/stream_end** | Agent 会话开始/结束 | 流式标识、累积的完整文本 |
| **tool_call** | Agent 调用工具时 | 工具名、输入、输出、耗时、错误 |
| **file_change** | 工具执行完成后 | 文件名、操作(create/modify/delete)、行数变更 |

**关键点**：Worker 不知道自己在 "输出内容给前端"。所有广播**由基础设施自动生成**，不是 agent prompt 指示的行为。

### 1.2 EDIT/DONE 广播机制 — 用 Tool Hook 拦截

| **位置** | `loop-controller.ts` 的 `#buildLockHooks()` 方法 (行 1518-1588) |
| --- | --- |

**回答：是 TOOL-CALL-DRIVEN，不是 PROMPT-DRIVEN。**

```
Worker 调用 edit(file)
  → beforeToolCall hook 拦截
  → 检查锁 (lockMgr.tryLock)
  → 广播 "[EDITING] {worker} started editing {file}"
  → 执行 edit 工具
  → afterToolCall hook 拦截
  → 释放锁 (lockMgr.release)
  → 广播 "[DONE] {worker} finished editing {file}"
```

**广播代码** (`loop-controller.ts:1569`):
```typescript
void channel.broadcast(workerId, `[EDITING] ${workerId} started editing ${file}.`);
```

**锁冲突时** (`loop-controller.ts:1550-1553`):
```typescript
if (lockResult.kind === "conflict") {
  void channel.broadcast(workerId, `[BLOCKED] ${workerId} blocked on ${file} — held by ${lockResult.holder}.`);
}
```

### 1.3 能否通过监视工具调用来实现？

**完全可以。** 比监听 broadcast 文本更可靠。

当前 `loop-controller.ts:742` 已有：
```typescript
this.#activityLogger?.logToolCall(
  agentName, toolName, toolInput, output, durationMs, error, exitCode
);
```

这会发出 `tool_call` SSE 事件（type: "tool_call", worker, toolName, toolInput, toolOutput, toolDurationMs...），前端 `swarm-store.ts` 已在 SSE handler 中处理：

```typescript
// swarm-store.ts — SSE handler
if (entry.type === "tool_call" && entry.toolName) {
  // 填充 toolCalls Map（AgentTimeline 使用）
  // 长耗时工具 toast 通知
}
```

**更好做法**：根据 `tool_call` 事件的 `toolName` 区分：
- `toolName === "edit"` + `toolInput.file` → 可以推导出 "EDITING"
- `toolName === "edit"` + `toolDurationMs` → 推导出 "DONE"（tool_call 后继的处理）
- 不需要文本解析 `[EDITING]`/`[DONE]`，直接由 tool_call 结构数据驱动

### 1.4 Cloner 输出

| 输出 | 位置 | 内容 |
| --- | --- | --- |
| **cloner_individual** | `roundtable.ts:152-155` | 单个 cloner 的 PASS/FAIL + findings |
| **verdict** | `roundtable.ts:375-456` 聚合后广播 | 加权投票结果（passed, findings, praisedWorkers, criticizedWorkers） |
| **stream_delta** | cloner 自身的 LLM 输出 | 文本增量 |

Cloner 审查流程：
```
每个 cloner 子进程执行 → extractVerdict() 解析 JSON 输出
  → JSON 包含: { verdict: "PASS"/"FAIL", confidence, findings, worker_count_delta, praised_workers, criticized_workers }
  → 每个 cloner 的 verdict 独立广播 (logClonerIndividual)
  → 所有 cloner verdicts 汇总 → tallyVerdicts() (加权投票 + veto)
  → 最终 verdict 广播 (logVerdict)
  → StateTracker.incrementPraise/Criticism/Conflict 更新 agent scores
```

---

## 二、为什么进度栏、Agents、Topology 不实时更新

### 2.1 数据同步机制：两条路

```
路径 A — SSE 实时推送（高频）
  ActivityLogger → EventBus → ReadableStream → Browser EventSource
  事件类型: stream_delta, phase, verdict, file_change, tool_call,
            cloner_individual, convergence, steering_ack, error_flag, crash

路径 B — REST Polling 每 5s（低频）
  api.getState() → StateTracker.state()
  返回: 完整 SwarmState (agents, todos, loopIteration, roundtablePhase...)
```

### 2.2 每条 UI 数据从哪里来

| UI 元素 | 数据源 | 更新方式 | 实时？ |
| --- | --- | --- | --- |
| **PhasePipeline iter/maxIter** | `swarmState.loopIteration` / `swarmState.targetCount` | Polling (refreshState 每 5s) | ❌ 5s 延迟 |
| **PhasePipeline sub-step** | `swarmState.roundtablePhase` | Polling | ❌ 5s 延迟 |
| **Agents Panel scores** | `agent.praiseCount/criticismCount/conflictCount` | Polling (refreshState) | ❌ 5s 延迟 |
| **Agents Panel status** | `agent.status` | Polling | ❌ 5s 延迟 |
| **TodoList** | `swarmState.todos` | Polling + SSE `todo-updated` phase 事件触发 `refreshState()` | ⚠️ 100ms 延迟刷新 |
| **Topology nodes** | `swarmState.agents` | Polling (refreshState) | ❌ 5s 延迟 |
| **Topology edges** | `activities` (最近 50 条 broadcast/steering) | SSE 实时 | ✅ 实时 |
| **ChatView messages** | `messages` Map | SSE 实时 (stream_delta RAF 批量) | ✅ 实时 (1-2帧) |
| **FileChanges panel** | `fileChanges` 数组 | SSE 实时 (file_change 事件) | ✅ 实时 |
| **Tool calls (AgentTimeline)** | `toolCalls` Map | SSE 实时 (tool_call 事件) | ✅ 实时 |
| **Convergence trend** | `convergenceHistory` 数组 | SSE 实时 (convergence 事件) | ✅ 实时 |

### 2.3 根因

**PhasePipeline 的 iter/maxIter 和 agents 数据完全依赖 polling**。这只是架构决策，不是 bug — 这些数据的变更频率不高（迭代级、刷新级），5s polling 是合理的。

但是有两个问题：

1. **后端 `updateAgent` 不触发 SSE 事件** — `state.ts:178` 的 `updateAgent()` 只更新内存 + 持久化到 disk，不会调用 `activityLogger.logXxx()` 广播。所以 agent status 变更（pending→running→completed）**没有任何 SSE 事件可以触发前端即时更新**。前端只能在下一次 `refreshState()` (polling) 中拿到新值。

2. **后端 `updatePipeline` 也不触发 SSE 事件** — 同样的模式。`loopIteration` / `roundtablePhase` / `todos` 更新后直接写 session.jsonl，不经过 ActivityLogger → 没有 SSE 推送。

**这意味着**：PhasePipeline、Agents Panel、Topology nodes、TodoList 都只能在 polling 中更新。5s 延迟是**架构层面决定的**。

### 2.4 已有的勉强解决方案

frontend 中对 `todo-updated` phase 事件做了特殊处理：
```typescript
// swarm-store.ts — SSE handler
if (p === "todo-updated") {
  setTimeout(() => get().refreshState(), 100); // 100ms 后拉取
}
```
这是一个**workaround** — 后端通过 `logPhase("todo-updated")` 通知前端 "数据变了"，而不是直接推送数据。前端收到后立即 polling 刷新。延迟从 5s 降到 100ms。

同样的 workaround 用于 `plan-updated`。

---

## 三、硬编码问题清单

### 3.1 🔴 后端缺失字段 — 前端假字段

| **文件** | `packages/swarm-gui/src/lib/types.ts:98-100` |
| --- | --- |

```typescript
export interface SwarmState {
  // ...
  totalTokens?: number;    // ← 前端类型中有
  totalRequests?: number;  // ← 前端类型中有
}
```

**后端 `state.ts:66-83` 的 `SwarmState` 中没有这两个字段。**

```typescript
// 后端 SwarmState — 无 totalTokens, 无 totalRequests
export interface SwarmState {
  name: string;
  status: PipelineStatus;
  mode: string;
  iteration: number;
  targetCount: number;
  agents: Record<string, AgentState>;
  startedAt: number;
  completedAt?: number;
  loopIteration?: number;
  roundtablePhase?: string;
  reviewVerdict?: string;
  loopPhase?: LoopPhase;
  todos?: TodoItem[];
}
```

**MonitorPage.tsx:133-140** 中试图显示 token 统计：
```tsx
{(swarmState?.totalTokens ?? 0) > 0 && (
  <span>
    {formatTokens(swarmState!.totalTokens!)}
    {estimateCost(swarmState!.totalTokens!)}
  </span>
)}
```
由于后端从不设置这两个字段，条件永远为 `false` — token 统计永不显示。这是**静默失效**，不是硬编码 0。

### 3.2 🔴 AgentTopology — dagre 尺寸硬编码

| **文件** | `AgentTopology.tsx:48` |
| --- | --- |

```typescript
dagreGraph.setNode(node.id, { width: 180, height: 80 });
```

所有节点统一 180×80。长 agent 名导致文字溢出节点边框。应该根据节点 label 长度动态计算。

### 3.3 🔴 AgentTopology — edges 只看最近 50 条 activities

| **文件** | `AgentTopology.tsx:127` |
| --- | --- |

```typescript
const recent = activities.slice(-50);
```

长时间 swarm (50+ 轮迭代) 中，旧的连接信息全部丢失。应该从 `activities` 中按 type 过滤并去重保持全量，或至少增大到 200。

### 3.4 🟡 PhasePipeline — sub-step 靠字符串匹配

| **文件** | `PhasePipeline.tsx:34-46, 70-73` |
| --- | --- |

```typescript
subStepPatterns: [
  { match: "Workers executing", label: "Working" },
  { match: "Debate: challenging", label: "Challenging" },
  // ...
],

// 匹配逻辑：
if (phase.includes(p.match)) return p.label;
```

`roundtablePhase` 是一个自由文本字符串，前端用 `includes()` 匹配子串来推导当前 sub-step。如果后端改了 `roundtablePhase` 的文本（例如 "Workers executing tasks"），匹配就静默失效。

应该改为**结构化 phase 事件**。后端已经发出 `phase` 事件（`logPhase("workers", ...)`），前端不做文本匹配而用这些事件的 type 做状态机。

### 3.5 🟡 PhasePipeline — iter/maxIter 数据来源

| **文件** | `PhasePipeline.tsx:62-63` |
| --- | --- |

```typescript
const iter = swarmState?.loopIteration ?? 0;
const maxIter = swarmState?.targetCount ?? 0;
```

两个都来自 `swarmState`，通过 polling 更新。如果 `refreshState()` 在 `updatePipeline` 之后 4.9s 才执行，PhasePipeline 会显示 4.9s 前的旧值。这不是硬编码，是**架构级的延迟问题**。

### 3.6 🟡 ContextPanel — 显示 `#{agent.iteration}` 

| **文件** | `AgentTopology.tsx:91` |
| --- | --- |

```typescript
<span>#{data.iteration}</span>
```

节点的 iteration 数据来自 `swarmState.agents[name].iteration`。这个字段在 `updateAgent(id, { iteration: iter })` 后更新。但**前端只在 polling 时获取** — 当前迭代的所有 agent 从 `pending` 变为 `running` 时，`iteration` 字段的更新**最多延迟 5s**。

### 3.7 🟡 ContextPanel worker cards — score 计算

| **文件** | `ContextPanel.tsx:13` |
| --- | --- |

```typescript
const score = praise - criticism - conflict;
```

计算公式正确（与后端 `getWorkerScore()` 一致）。但 praise/criticism/conflict 的值来自 polling，不是实时的。在 cloner 刚发布 verdict 后，这些数值不会立即反映在前端 — 直到下次 poll。

### 3.8 🟢 MonitorPage worker count — 非硬编码

| **文件** | `MonitorPage.tsx:104` |
| --- | --- |

```typescript
{swarmState?.agents ? Object.keys(swarmState.agents).length : 0} workers
```

这是动态计算，但受 polling 延迟限制。

### 3.9 🟢 TodoList — 非硬编码

TodoList 读取 `swarmState.todos`，只在 polling 更新。后端 `todo-tracker.ts` 的进度计算是正确的（文件关联匹配），但前端不能实时看到。`todo-updated` phase 事件的 workaround 将延迟压到 100ms。

---

## 四、"1/1 tasks 不更新" — 原因分析

PhasePipeline 显示 `iter/maxIter`：

```
{iter}/{maxIter}     ← 对应 swarmState.loopIteration / swarmState.targetCount
```

`loopIteration` 在每个 loop iteration 开始时由后端设置：
```typescript
// loop-controller.ts:536
await this.#stateTracker.updatePipeline({ loopIteration: iter + 1, roundtablePhase: "Workers executing" });
```

前端通过**polling (refreshState 每 5s)** 获取此值。如果在 swarm 运行时看到 `1/1` 一直不变：

1. **swarm 只有 1 个 max iteration** — `targetCount = 1` 在 loop.yaml 中配置。这是正常行为（只有一轮迭代就结束）。
2. **loop 还在第 1 轮** — 每次迭代包含多个 worker wave 和多轮 review，持续时间很长。`loopIteration` 不变是因为当前迭代还在进行中，到下一轮迭代时才递增。
3. **polling 失败** — `refreshState()` 抛出异常，`swarmState` 没更新。检查浏览器 console 是否有 API 错误。

**结论**：`1/1` 不是硬编码。它反映了实际的 `loopIteration / targetCount`。问题是**这些数据只在 polling (5s 延迟) 中更新**。

---

## 五、所有问题的根源与解

### 根本问题：后端 `updatePipeline` / `updateAgent` 不触发 SSE 广播

```
当前架构:
  StateTracker.updatePipeline({ loopIteration: 2 })
    → Object.assign(state, { loopIteration: 2 })
    → await persist()  (写 session.jsonl)
    → 无广播！
  
  StateTracker.updateAgent("worker-1", { status: "running" })
    → Object.assign(agent, { status: "running" })
    → await persist()
    → 无广播！
```

**理想架构**：
```typescript
// StateTracker 应该接受 activityLogger 引用，自动广播状态变更
async updatePipeline(update: Partial<SwarmState>): Promise<void> {
  Object.assign(this.#state, update);
  await this.#persist();
  
  // 自动广播到 SSE
  if (update.loopIteration !== undefined) {
    this.#activityLogger?.logStateChange("loopIteration", update.loopIteration);
  }
  if (update.roundtablePhase !== undefined) {
    this.#activityLogger?.logPhase("roundtable-phase", update.roundtablePhase);
  }
}
```

### 最简解（最小侵入）：

在**现有的 SSE handler 中**，前端已经在处理 `phase` 事件后用 `refreshState()` 刷新。问题只是不是所有 state 变更都有对应的 phase 事件。

**在 `loop-controller.ts` 中**，每次 `updatePipeline` 或 `updateAgent` 后立即追加一条 SSE 通知（不需要改 StateTracker）：

```typescript
// 现有代码 — 已经有 logPhase 调用
await this.#stateTracker.updatePipeline({ loopIteration: iter + 1, roundtablePhase: "Workers executing" });
this.#activityLogger?.logPhase("workers", undefined, iter + 1);  // ← 这条已有

// 缺失的 — agent 状态变更时不触发任何 SSE 事件
await this.#stateTracker.updateAgent(id, { status: "running", iteration: iter });
// 这里缺少：this.#activityLogger?.logAgentState(id, "running", iter);
```

**另一种解 — 前端侧降 polling 延迟**：

将 `refreshState()` 的轮询间隔从 5s 降到 2s，代价是 2.5× 的 HTTP 请求。但对于开发者 dashboard（用户数 ≤ 1），这个代价完全可以忽略。

已在 Phase 6 修改中将轮询频率固定为 5s。改为 2s 只需要改一行数字。

---

## 六、前端所有依赖 polling 的 UI 列表

| UI 组件 | 字段 | 当前延迟 | 建议方案 |
| --- | --- | --- | --- |
| **PhasePipeline** | iter/maxIter | 5s | 后端每次更新 loopIteration 时发 `phase` 事件 + 前端 `refreshState()` |
| **PhasePipeline** | sub-step label | 5s | `roundtablePhase` 的更新需要 SSE 推送（已有 `logPhase`） |
| **ContextPanel agents** | status, score | 5s | 后端 `updateAgent` 后发 SSE 通知 + 前端 `refreshState()` |
| **ContextPanel tasks** | todo 进度 | 100ms | 已有 `todo-updated` workaround ✅ |
| **AgentTopology nodes** | 节点数据 | 5s | 同 ContextPanel agents |
| **MonitorPage token count** | totalTokens | 永不显示 | 后端需要维护并返回此字段 |

---

## 七、回答两个原始问题

> "worker写文件和完成文件后广播的EDIT和DONE 这里是通过什么方式实现的，是提示词吗"

**不是提示词。** 是通过 `loop-controller.ts` 的 `#buildLockHooks()` 方法中 `beforeToolCall`/`afterToolCall` 钩子**自动拦截工具调用**实现的。无论 agent 做什么，只要它调用了 edit/write/bash 等文件修改工具，基础设施自动广播。不需要 agent 自己输出 `[EDITING]`。

> "能否通过监视这个调用执行的情况来实现呢"

**可以，而且更好。** 后端已经有 `logToolCall()` 发出 `tool_call` SSE 事件。前端可以根据 `toolName` + `file` + `toolDurationMs` 结构化推导出 "EDITING"（tool 开始执行，duration 未知）和 "DONE"（tool 执行完成，duration 已知）。这比文本匹配 `[EDITING]`/`[DONE]` 更可靠。
