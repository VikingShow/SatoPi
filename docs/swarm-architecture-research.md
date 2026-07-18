# SatoPi Swarm 架构深度调研报告

> 日期: 2026-07-19
> 范围: 完整 swarm 子系统 (10 核心模块 + 8 辅助模块)
> 方法: 对标 Claude Code、LangGraph、SWE-bench、OpenAI Codex 前沿多 Agent 架构

---

## 一、当前能力全景

### 1.1 执行模式

| 模式 | 控制器 | 核心行为 |
|------|--------|---------|
| **pipeline** | PipelineController | DAG 波次执行，同波并行，异波串行 |
| **parallel** | PipelineController | 全部 Agent 单波并行 |
| **sequential** | PipelineController | 声明顺序逐一执行 |
| **loop** | LoopController | 多轮 worker + deliberation + cloner review + 动态伸缩 + 收敛检测 |

### 1.2 规划系统

- **Socrates 对话**: 多轮 Socratic 对话，工具受限（read/write_file/grep/find/glob），对话持久化，plan.md 自动检测
- **Cloner 辩论**: 2-3 个 cloner 实例多轮辩论，Jaccard 相似度收敛检测，最终合成最长输出

### 1.3 Worker 执行（Loop 模式）

- **三层嵌套**: 迭代 → 轮次 → deliberation 子轮（Challenge/Rebuttal/Resolution）
- **Reviewer 选举**: 全员提名 + 多数投票
- **Convergence 检测**: 结构化 `RoundSummaryData` 优先，Jaccard 回退
- **Deliberation**: 子轮中写/edit/bash 被限制，只允许只读 + IRC

### 1.4 质量控制

- **Cloner 审查**: 多数投票 PASS/FAIL，JSON verdict + 启发式回退解析
- **阻塞检测**: 3+ 轮停滞或 3+ 次 worker 崩溃 → 暂停 + 用户决定
- **文件冲突**: git-diff 检测 + worker 输出归属分析
- **收敛**: Jaccard 0.8+ 跨迭代停滞 → escalated/converged_failed

### 1.5 动态伸缩

- Cloner 建议 `worker_count_delta`
- 两级投票: 绝对多数 (≥2/3) + |delta|≥2 → 激进跳变；简单多数 → ±1
- 缩容时移除最低质量 worker（praise - criticism - conflict）

### 1.6 学习系统

- SQLite FTS5 + JSONL + Markdown 总结 + 原则提取
- 去重（Jaccard > 0.7）、衰减（-10%/run）、增强（+10%/引用）
- 中英文同义词扩展搜索
- 每 10 次运行 LLM 合成 wisdom principles

### 1.7 扩展接口

| 接口 | 位置 | 现状 |
|------|------|------|
| `AgentExecutor` | executor.ts | ✅ 已定义，但 LoopController 未使用 |
| `PipelineHooks` (8 hooks) | pipeline.ts | ✅ 已定义，但 loop 模式未调用 |
| `SwarmServices` | services.ts | ✅ 已定义，接口反转 |
| YAML hooks | schema.ts | ✅ 可配置 shell 命令 |
| `ActivityLogger` | activity-logger.ts | ✅ 14 种事件类型 |
| `AgentToolRestriction` | schema.ts | ✅ per-role 工具限制 |

---

## 二、架构设计评估

### 2.1 分层

**强分离**: 编排/执行/通信/持久化/配置 — 职责清晰

**不一致**: 
- `LoopController` 不继承 `PipelineController`，重写了整个迭代循环
- PipelineHooks 只在 `PipelineController.run()` 中调用，loop 模式完全绕过了 hooks
- Verification 在三处重复调用（loop-controller.ts:724, 820, 1009）— 代码重复

### 2.2 耦合

**高耦合**:
- `LoopController` 直接调用 `runSubprocess()`，绕过了 `AgentExecutor` 接口 — **最大架构缺陷**
- `IrcBus.global()` 硬编码在 `createLoopController` 中，无法注入 mock
- `FileTracker`、`TodoTracker`、`VerificationHook` 在 LoopController 构造函数内联创建，无 DI

**低耦合（设计良好）**:
- `AgentExecutor` / `SwarmServices` 接口定义干净
- `ActivityLogger` 可选注入
- `ModelRegistry` / `Settings` 透传，不存储为成员

### 2.3 状态管理

**优势**: 文件系统持久化 + 序列化写队列 + 微任务合并 + 可恢复
**缺陷**: 无快照/回滚、崩溃后无部分迭代恢复、resetAgentStatuses 丢失质量计数

### 2.4 错误处理 — 纵深防御

| 层级 | 机制 |
|------|------|
| 1 | Per-agent `Promise.allSettled` |
| 2 | Crashed → `[CRASHED]` 输出 stub |
| 3 | Lock cleanup 在 worker spawn error handler |
| 4 | Hook error 隔离（`invokeHook`） |
| 5 | Persist error 淹没 |
| 6 | 迭代超时（`AbortSignal.any`） |
| 7 | Blocker 超时（5 分钟 auto-continue） |
| 8 | LLM 失败回退 |

**缺陷**: 无 per-worker 超时、无熔断器模式、崩溃前部分输出丢失、verification 命令无超时

---

## 三、用户旅程评估

### 3.1 从任务到运行

```
用户输入任务 → Socrates 对话 → Cloner 辩论计划 → 确认 → Loop 启动
     ↓              ↓                ↓             ↓        ↓
  POST /start   多轮 SSE       SSE debate    POST     runLoop()
                plan-updated   events        /confirm
```

**持久化**: conversation.json + pipeline.json + plan.md

### 3.2 运行中反馈

- **实时 SSE**: 阶段转换、agent 输出、扩展事件、冲突、崩溃
- **进度追踪**: 迭代进度、per-agent 状态、TODO、质量指标
- **状态持久化**: 页面刷新后可恢复

### 3.3 用户干预

- **暂停/恢复**: pause/resume + updatePlan（暂停中修改计划）
- **阻塞解决**: continue/skip/abort，5 分钟自动降级
- **Cloner 引导**: 定向/广播 [CLONER STEERING]

### 3.4 运行后

- 可选 verification hook（阻塞/非阻塞模式）
- 多级 after-loop pipeline: 提取 → 反思 → 总结 → 保存 → 衰减
- 7 种最终状态: completed/failed/aborted/escalated/converged_failed/converged_partial

---

## 四、与前沿设计的差距

### 4.1 P0 — 关键差距（阻碍竞争力）

| # | 问题 | 对标 |
|---|------|------|
| 1 | **LoopController 不使用 AgentExecutor** — `#spawnWorkers()` 直接调用 `runSubprocess()`，绕过了整个执行器抽象 | Claude Code subagent fan-out |
| 2 | **Loop 模式不使用 PipelineHooks** — 8 个生命周期 hooks 在 loop 中完全被绕过 | LangGraph state-machine |
| 3 | **无对抗性审查** — Cloner 是合作型审查者，没有专门找漏洞的对抗角色 | Claude Code adversarial review |
| 4 | **无内联测试反馈** — Worker 执行中不能跑测试看结果，验证只在 loop 后 | SWE-bench top agents |

### 4.2 P1 — 高优先级差距

| # | 问题 | 对标 |
|---|------|------|
| 5 | **无形式化状态机** — 控制流是命令式的（if/return），难以添加条件分支或恢复 | LangGraph |
| 6 | **无结构化输出验证** — Cloner verdict 解析依赖启发式 regex，非 JSON Schema | OpenAI structured outputs |
| 7 | **Loop 模式无 DAG 执行** — `waitsFor`/`reportsTo` 存在但 loop 不使用 | 所有 DAG-based 编排 |
| 8 | **无工具调用优化/缓存** — 重复的工具调用不缓存，无跨迭代学习 | Moatless Tools |
| 9 | **无预算管理** — 无 token/成本上限，可能无限消耗 | Claude Code soft budget |

### 4.3 P2 — 中等差距

| # | 问题 |
|---|------|
| 10 | 无 Agent 预热 — 每轮启动新 subprocess |
| 11 | 无跨运行策略自适应 — 经验 store 有数据但不用来调优配置 |
| 12 | 无多模态支持 |
| 13 | 无 GitHub/PR 集成 |
| 14 | 无 worker 健康检查（可 hang 不 crash 不超时） |

### 4.4 P3 — 低优先级

| # | 问题 |
|---|------|
| 15 | 无策略 A/B 测试 |
| 16 | 无 Agent 模型多样性 |
| 17 | 无实时协作拓扑可视化 |
| 18 | 无跨部署联邦学习 |

---

## 五、Top 5 推荐行动（按投入产出比排序）

### #1: 将 AgentExecutor 接入 LoopController（P0，低成本）

**当前**: `LoopController.#spawnWorkers()` 直接调用 `runSubprocess()`
**方案**: 改为调用 `this.#executor.execute()`
**影响**: 解锁自定义执行、测试 mock、远程 agent — 不需要修改任何外部 API

### #2: 将 PipelineHooks 接入 LoopController（P0，中成本）

**当前**: hooks 只在 PipelineController.run() 中调用
**方案**: 在 LoopController.runLoop() 的相同生命周期点添加 hook 调用
**影响**: loop 模式获得与 pipeline 模式相同的扩展能力

### #3: 角色资产集成到 Worker 生成（P0，中成本）

**当前**: 所有 worker 使用相同的 `WORKER_SYSTEM_PROMPT`
**方案**: 当 cloner 建议角色时，从 RoleAssetManager 查找对应角色，注入其 system prompt + guidelines + tools
**影响**: 差异化 worker 能力，更接近真实团队协作

### #4: 添加对抗性审查角色（P0，中成本）

**当前**: 只有合作型 cloner
**方案**: 在 cloner 配置中添加 `adversarial` 标志，对抗性 cloner 的 prompt 专注于 "如何让输出失败"
**影响**: 显著提升输出质量和安全性

### #5: 为 Worker 添加内联测试反馈（P0，低成本）

**当前**: 测试验证只在 loop 后，非内联
**方案**: 确保 worker 有 `bash` 工具访问权，在 worker 系统 prompt 中添加 "在提交前运行测试" 的指导
**影响**: SWE-bench 风格的内联测试循环

---

## 六、下一步

以上 P0 问题（#1-#5）应在下一轮迭代中优先处理。每个问题可制定独立的实现计划，逐步在 `dev` 分支上完成。

关联文档: `docs/architecture-optimization-plan.md` (已完成 26/30 项)
