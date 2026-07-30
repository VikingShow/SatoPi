# Before-Loop 完整链路分析与问题梳理

## 一、完整链路

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Before-Loop 阶段                                 │
│                                                                          │
│  idle                                                                     │
│    │ 用户输入任务 → POST /before-loop/start                              │
│    ▼                                                                      │
│  before-loop-dialog                                                       │
│    │ start() → #runSocrates() → LLM 苏格拉底式对话                        │
│    │ Socrates 通过 write 工具写入 .omp/plan.md                            │
│    │ plan.md mtime 变化 → planReady=true → "plan-updated" phase          │
│    │                                                                      │
│    ├── 用户继续发消息 → sendMessage() → #runSocrates() 继续对话           │
│    │                                                                      │
│    ├── [Run Debate] ───────────────► before-loop-debate                   │
│    │   runDebate()                    Cloner Roundtable 多轮辩论           │
│    │                                  ↓                                   │
│    │                                  before-loop-confirm                  │
│    │                                  ↑ ── "Run Debate Again"             │
│    │                                                                      │
│    └── [Confirm & Start] ──────────► running                              │
│        confirm()                     RunManager.start() 启动循环           │
│                                      → 创建 workers + cloners             │
│                                      → Loop Engineering 执行              │
└──────────────────────────────────────────────────────────────────────────┘
```

### 各阶段状态流转

| 阶段 | 触发者 | 后端动作 | 前端可见 |
|------|--------|---------|---------|
| `idle` | 初始状态 | - | ChatView 底部显示 "New Task" 输入 |
| `before-loop-dialog` | 用户输入任务 | Socrates 对话流、写入 plan.md | 实时流式聊天 + 发送消息 |
| `before-loop-debate` | 点击 "Run Debate" | Cloner Roundtable 辩论 (异步) | 顶部 "Debating..." spinner |
| `before-loop-confirm` | 辩论完成 | plan.md 已精炼 | "Debate complete" 栏 + 按钮 |
| `running` | 点击 "Confirm & Start" | 创建 workers、启动循环 | 切换到运行态 UI |

---

## 二、plan.md 的写入时机

### 写入路径

1. **Socrates 的 system prompt**（`prompts/socrates.hbs:6`）明确指示：
   ```
   Once you have sufficient clarity, write a plan to .omp/plan.md
   ```

2. **BeforeLoopManager 检测时机**：每次 `#runSocrates()` 完成后，比较 plan.md 的 mtime：
   ```typescript
   const newMtime = await this.#getPlanMtime();
   if (newMtime > this.#planMtime) {
       this.#planReady = true;
       this.#activityLogger.logPhase("plan-updated");
   }
   ```

3. **触发的 UI 变化**：`plan-updated` phase 事件 → `planVersion++` → PlanViewer 自动刷新 → `refreshBeforeLoopState()` → `planReady=true` → ChatView 底部显示 "Run Debate" / "Confirm & Start" 按钮栏

### 问题

- **无写入进度可视化**：用户看不到 Socrates 正在 "写 plan.md"——只能等它完成对话后才知道 plan 已就绪
- **依赖 LLM 自觉执行**：如果 Socrates 忽略了 "write plan.md" 指令（或格式不对），plan 就永远不会被检测到，对话会陷入僵局

---

## 三、Debate / Confirm 弹窗条件

### 实际上不是弹窗，是 ChatView 底部的 Action Bar

```tsx
// ChatView.tsx:444
{((loopPhase === "before-loop-dialog" && planReady) || loopPhase === "before-loop-confirm") && !isBusy && (
    <div className="...bg-linear-to-r from-purple-950/30 to-blue-950/30">
        "Plan draft ready" / "Debate complete — plan refined"
        [Run Debate] [Confirm & Start]
    </div>
)}
```

### 出现条件

| 条件 | 说明 |
|------|------|
| `loopPhase === "before-loop-dialog"` | 用户已完成对话 |
| `planReady === true` | plan.md 已被 Socrates 写入 |
| `!isBusy` | Socrates 未在思考中 |
| **或** | |
| `loopPhase === "before-loop-confirm"` | 辩论已结束 |
| `!isBusy` | 未在处理中 |

### 刷新后行为

- `loopPhase` 通过 `StateTracker` 持久化到 `session.jsonl`，刷新后通过 `SwarmSessionManager.readLatestState()` 恢复
- `planReady` 是 BeforeLoopManager 的内存字段，**刷新后丢失**
- **planReady 通过 `getBeforeLoopState()` API 重新获取**——它检查 plan.md 是否存在来判断 `planReady`
- **实际效果**：刷新后按钮会重新出现（因为 plan.md 在磁盘上，`getBeforeLoopState()` 返回 `planReady: true`）

### 设计合理性

✅ 按钮出现条件合理——plan ready 且空闲时才显示操作选项  
⚠️ 缺点是 `planReady` 的判断依赖磁盘文件 mtime 检查，而非明确的事件驱动通知

---

## 四、Worker / Cloner 数量推荐

### 当前状态：**未实现可视化**

1. **规划阶段**：`generatePlanningPrompt()` 告诉 Socrates "提出 worker/cloner 数量建议"（`before-loop.ts:95-98`），但这些建议只是 Socrates 自然语言输出中的文本，没有被提取和展示

2. **配置界面**：`ConfigPage` 直接编辑 `loop.yaml` 中的 `workers.initial` 和 `cloners.count`，默认为 `3` 和 `2`

3. **用户看不到推荐弹窗的原因**：
   - 没有从 Socrates 回复中解析 "推荐 N workers, M cloners" 的代码
   - 没有专门的推荐展示 UI 组件
   - `BeforeLoopResult` 类型定义了 `proposedWorkerCount` 和 `proposedClonerCount`，但**从未被使用**

### 解决方案

**方案 A：解析 Socrates 输出中的推荐数量并展示**

在 `parseSocratesResponse()` 或 `BeforeLoopManager.#runSocrates()` 之后，用正则提取类似 "3 workers" 和 "2 cloners" 的文本，通过 SSE 事件推送到前端。

**方案 B：前端在 ChatView 中高亮数量建议**

当用户看到 Socrates 的回复中提及数量时，渲染为可点击的 "建议配置：3 workers / 2 cloners" 标签，点击后跳转到 ConfigPage。

**方案 C：在 Action Bar 中显示当前配置数量**

在 "Run Debate" 和 "Confirm & Start" 按钮旁边显示当前 `loop.yaml` 中配置的 worker 和 cloner 数量，让用户在启动前确认。

**推荐：B + C 组合**——在聊天中高亮建议（方案 B），在 Action Bar 显示实际配置数（方案 C）。

---

## 五、Debate 阶段可视化

### 当前状态：仅有一个 spinner

```tsx
// MonitorPage.tsx:200-205
{loopPhase === "before-loop-debate" && (
    <div className="flex items-center gap-1.5 ...">
        <Loader2 size={14} className="animate-spin" />
        Debating...
    </div>
)}
```

### 缺失的内容

1. **实时辩论进度**：当前 debate 在后台异步运行，前端只知道 "started" 和 "done"，中间的 cloner 轮次、收敛度等完全不透明
2. **辩论细节**：每个 cloner 的 verdict（PASS/FAIL）、findings、评分都通过 `ActivityLogger` 发出（`cloner_individual` 事件），但它们的 channel 只在 **running** 阶段有用，debate 阶段缺少专用视图
3. **收敛进度**：`convergence` 事件发出 `jaccard` 系数，前端有 `convergenceHistory` 存储，但没有在 debate 阶段展示

### 解决方案

**短期**：
- 在 debate spinner 旁显示当前轮次（如 "Debating... round 2/3"）
- 在 debate 期间实时显示 cloner verdict 进入 channel 列表

**长期**：
- 添加专用的 DebateProgress 组件，展示轮次进度条 + 各 cloner 投票状态
- 显示收敛度的实时趋势线（已有 convergenceHistory 数据，缺的是 UI）

---

## 六、Confirm 后的 Worker 创建可视化

### 当前状态：**无专用可视化**

`confirm()` → `RunManager.start()` 后的流程：

1. `PhasePipeline` 组件显示阶段流转："before-loop-confirm" → "running"
2. `ContextPanel` 的 Agents 标签开始显示 worker 卡片（当 swarmState 更新时）
3. `SwarmStore.refreshState()` 每 5 秒轮询 swarmState
4. `AgentTopology`（拓扑视图）显示 agent 节点

### 问题

- **创建过程无实时反馈**：从点击 "Confirm" 到看到第一个 worker 出现之间有延时，用户不知道发生了什么
- **轮询间隔 5 秒**：worker 创建后最多要等 5 秒才能在 ContextPanel 中出现
- **无 "workers created" 事件**：后端创建 worker 时没有发出专门的 SSE 事件

### 解决方案

**短期**：
- 在后端 `RunManager.start()` 中发出 `logBroadcast("system", "Creating N workers and M cloners...")` 和逐 worker 的 `logBroadcast("system", "Worker alpha started")`
- 前端监听这些 broadcast 消息并在聊天中显示

**长期**：
- 添加 `worker_spawned` SSE 事件类型，前端实时更新 AgentTopology 和 ContextPanel

---

## 七、ChatView 中用户可见的消息

### Before-loop 阶段

| 阶段 | 消息来源 | 消息类型 | 示例 |
|------|---------|---------|------|
| idle → dialog | `logPhase("before-loop-start")` | system | (ChatView 显示 system event) |
| dialog | `logBroadcast("operator", task)` | user message | "帮我做一个游戏" |
| dialog | Socrates stream_start/delta/end | AI bubble | "好的！你想做什么类型的游戏？" |
| dialog | `logPhase("plan-updated")` | system | planVersion++ |
| dialog | system broadcast | system | "Draft plan.md is ready..." |
| debate | `logPhase("debate-start")` | system | "Starting plan debate..." |
| debate | cloner_individual / convergence 事件 | per-channel | 进入 cloner/deliberation channel |
| debate done | `logPhase("debate-done")` | system | "Plan debate completed (refined)" |
| confirm | `logPhase("loop-start")` | system | Loop 启动 |

### Running 阶段

| 消息来源 | 消息类型 | Channel |
|---------|---------|---------|
| Worker broadcast | broadcast | Roundtable |
| Tool calls | tool_call | Roundtable (system style) |
| Verdict | verdict | Roundtable |
| File changes | file_change | 触发 FileChangesPanel |
| Scaling | scaling | Roundtable |
| Steering | steering | Roundtable 或 steering channel |

### 问题

1. **用户消息 echo**：`pushUserMessage()` 先乐观插入一条本地消息，然后 SSE 又回传一条 broadcast 事件 → 消息可能重复
2. **worker/cloner 数量建议只在聊天文本中**，没有结构化展示
3. **system 消息缺少分类**：所有 system 消息看起来一样，用户难以区分 "plan ready" 和 "debate start"

---

## 八、Channel 栏的创建条件

### 创建触发点

`deriveChannel()` 函数根据 `ActivityEntry.type` 创建 channel：

| 事件类型 | Channel ID | Channel 类型 | 触发时机 |
|---------|-----------|-------------|---------|
| `broadcast` | `roundtable` | roundtable | 任何时候（before-loop 和 running） |
| `subgroup` | `subgroup-{to}` | subgroup | running 阶段（worker 分组沟通） |
| `steering` (operator→all) | `roundtable` | roundtable | running 阶段 |
| `steering` (其他) | `steering-{from}-{to}` | steering | running 阶段 |
| `deliberation_challenge/rebuttal/ruling` | `deliberation-r{round}` | deliberation | debate 阶段 / running 阶段 |
| `cloner_individual` | `cloner-{from}` | cloner | debate 阶段 / running 阶段 |
| `file_coordination` | `file-{path}` | file | running 阶段 |
| `tool_call` | `roundtable` | roundtable | running 阶段 (显示为 system 消息) |

### Channel 分组（在 ChannelList 侧栏中）

| Group | Channel 类型 |
|-------|-------------|
| Active | roundtable, subgroup |
| Coordination | file |
| Review | deliberation, cloner, steering |

### 刷新后行为

- Channels 和 messages 存储在 `swarm-store.ts` Zustand state（`messages` Map + `channels` Map）中
- 刷新后 `init()` 调用 `api.getHistory()` → 遍历 entries → `addActivity(entry, true)` → **`deriveChannel()` 会被调用**，所有 channel 类型（roundtable、cloner、deliberation、steering、file）都能重建
- **实际效果**：刷新后 channel 列表和消息内容**完整恢复**，与刷新前一致

> 注：之前分析中称"非 roundtable channel 刷新后丢失"是**错误的**——`deriveChannel()` 在 `addActivity()` 的 standard message 路径中（line 728）对所有事件类型统一处理，history replay 同样走这个路径。

### 问题

1. **非 roundtable channel 刷新后消失**，历史无法回溯
2. **channel 创建时机不可控**——完全由 SSE 事件驱动，没有预先创建的机制
3. **debate 阶段的 cloner channel 在 debate 完成后很快被新事件覆盖**，用户来不及查看

### 解决方案

**短期**：
- `getHistory()` 回放时也回放非 broadcast 类型的事件，重建 channel 列表
- 在 debate 阶段自动聚焦到 cloner channel

**长期**：
- 将 channel 消息持久化到 session.jsonl（或独立的 channel 存储）
- 支持历史 channel 的归档和查看

---

## 九、解决方案汇总

| # | 问题 | 优先级 | 方案 |
|---|------|--------|------|
| 1 | plan.md 写入无进度可视化 | 中 | 写入前发 "Writing plan.md..." broadcast |
| 2 | Worker/cloner 推荐不可见 | 高 | ChatView 中解析并高亮推荐数 + Action Bar 显示实际配置数 |
| 3 | Debate 阶段无详细进度 | 高 | 轮次指示 + 实时 cloner channel 聚焦 |
| 4 | Confirm 后 worker 创建无反馈 | 中 | 发 "Creating N workers..." broadcast 事件 |
| 5 | planReady 依赖 mtime 检测不够可靠 | 低 | 已有 plan.md 轮询监控（500ms）作为增强 |
| 6 | 用户消息可能重复 | 低 | SSE echo 去重（对比 optimistic ID） |
| 8 | plan.md 写入时机依赖 LLM 自觉 | 中 | 添加 before-loop timeout 保底：N 轮对话后强制请求 plan |
