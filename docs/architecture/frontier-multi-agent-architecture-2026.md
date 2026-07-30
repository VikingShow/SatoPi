# 前沿多 Agent 编码系统架构 (2026)

> 调研日期: 2026-07-23
> 覆盖范围: Cursor, Anthropic Harness, OpenAI Codex, Factory AI, Claude Code, D3X, Swarm Skills

---

## 1. 共识架构: Orchestrator-Worker 模式

### 1.1 行业趋同

2026年，有影响力的多 Agent 编码系统全部采用**层级制 Orchestrator-Worker**：

| 系统 | 架构 | 协调方式 | Worker 关系 |
|---|---|---|---|
| **Cursor** | Planner → Worker → Judge | 任务队列，零 Worker 协调 | 完全独立，各自 push 到同一 git branch |
| **Factory AI** | Coordinator → 5 类 Droid | 结构化 handoff | 角色严格分离，从不交叉 |
| **Anthropic Harness** | Planner → Generator → Evaluator | Sprint contract 协商 | 3 agent GAN 循环 |
| **Claude Code** | Orchestrator → Sub-agents | 一次性 parent→child | 独立上下文窗口，只返回摘要 |
| **Codex** | Manager → 最多 8 Worker | Fan-out，独立上下文 | 互不可见 |

### 1.2 Cursor 的关键发现：平级协调失败

Cursor 在 2025-2026 年间尝试了**平级 peer-to-peer 协调**，结论是彻底失败：

> "Flat peer-to-peer coordination fails due to locking bottlenecks and risk-averse agent behavior."

| 失败模式 | 具体表现 |
|---|---|
| **锁瓶颈** | 20 个 agent 的实际吞吐量只有 2-3 个 |
| **风险规避** | 没有层级，agent 倾向小、安全的改动 |
| **责任缺失** | 没有 agent 承担端到端责任 |
| **乐观并发** | 替代锁但没解决深层协调问题 |

### 1.3 Cursor 的层级架构

```
Planner (GPT-5.2)
  ├── 持续探索代码库，创建任务
  ├── 可递归 spawn sub-planner
  └── 不做任何代码编写

Worker (低成本模型)
  ├── 无状态，取单一任务执行
  ├── 零交叉 Worker 协调
  └── 独立 push + 自行处理 merge conflict

Judge
  └── 每周期评估：CONTINUE / COMPLETE / ESCALATE / PIVOT
```

**成本发现（2026年7月）**：
- Planner (Opus 4.8) + Worker (Composer 2.5) → 成本降至 ~**1/8**
- Workers 消耗 69-90%+ 的总 token
- 异质模型策略是最重要的成本优化

### 1.4 Anthropic GAN Harness（最精炼的层级模式）

3 个 agent，每个只做一件事：

```
Planner: 1-4 句 prompt → 完整产品 spec
Generator + Evaluator: 每轮前谈判 "sprint contract"（定义"done"的标准）
Generator: 写代码
Evaluator: 用 Playwright 真实浏览器测试，对标尺打分
  ├── 打分维度: product depth, functionality, visual design, code quality
  └── 硬阈值: 不达标 → 详细反馈 → Generator 重试

结果: 6 小时自主 session 产出 full-stack 应用
Evaluator 抓住了 solo agent 漏掉的 bug
```

关键洞察：**Evaluator 不是 agent 审 agent 的代码——是 agent 操作真实浏览器产生确定性反馈。**

### 1.5 Factory AI: Coordinator + 5 类 Droid

| Droid | 职责 | 关键约束 |
|---|---|---|
| Code Droid | 实现，bug 修复，产 PR diff | 写代码 |
| Review Droid | 对标项目标准评估 | **从不写代码** |
| Test Droid | 写测试，跑回归 | 独立于 Code |
| Docs Droid | 更新文档和 changelog | 实现后触发 |
| Knowledge Droid | 跨 repo 索引记忆 | 跨 session 累积 |

Agent Arena 排名（众包 Elo，2025年12月）：
- Factory Droid: **1330** (第1)
- OpenAI Codex: 1301 (第2)
- Devin: 1263 (第3)
- Claude Code: 1242 (第4)

### 1.6 共识的六层架构

```
User/IDE/CLI
    ↓
Minimal System Prompt (identity, boundaries, reasoning posture)
    ↓
Context Manager (compact state, JIT retrieval, compaction/overflow)
    ↓
ReAct Execution Loop (think → tool/delegate → observe → update state)
    ↓
Tool Registry / MCP ← → Sub-Agent Orchestrator
    ↓
Host Runtime + Policy Layer (permissions, approvals, cost controls)
    ↓
OS-Level Sandbox (filesystem scope, network policy, process isolation)
```

系统提示词缩小，操作细节移到 tool registry、context manager 和 policy layer。**模型是架构内部的规划器和解释器，不是架构本身。**

---

## 2. 质量 Gate：阶段门控 + 确定性验证

### 2.1 三层通用质量 Gate

1. **Plan Approval** — agent 先写计划，获得批准后才编码
2. **Loop Guardrails** — `MAX_ITERATIONS=8` + 强制反思 prompt ("What failed? What specific change would fix it?")
3. **Dedicated @reviewer** — 只读，每次 TaskCompleted 自动触发

### 2.2 Harness 模式：Gated Pipeline

```
Plan → [Gate: spec approved] → Generate → [Gate: tests pass]
  → Evaluate → [Gate: criteria met] → Ship
       ↑                          │
       │    fail → remediate      │
       └──────────────────────────┘
```

每个阶段有独立上下文窗口。Evaluator 没写代码。Shipper 无法绕过 test gate。

---

## 3. 确定性验证 vs Agent 互审

### 3.1 Multi-Model Consensus Review 的局限

3 个不同模型的 Reviewer agent + 1 个 Consolidator。**但这是 agent 判断 agent output——LLM 最弱的领域。**

更有效的是 **Verifier agent**：
- 跑测试、lint、typecheck、build
- 不看代码，只看执行信号
- 返回 PASS / BLOCKED（非主观）

### 3.2 WarpGrep 的启示

专门的 code-search sub-agent 提升 SWE-Bench Pro +3.1 分，降低 17% 输入 token。

---

## 4. 设计 Patterns

### 4.1 Shared Ground Truth Injection
Orchestrator 一次性计算事实基线（文件列表、CLI 命令、schema），**逐字注入每个 sub-agent prompt**。消除 N 次冗余发现读取。

### 4.2 Pre-Filtered References via Frontmatter Paths
规则文件携带 `paths:` frontmatter glob pattern。Orchestrator 匹配修改文件，只传适用的规则。8 个 TS 测试文件 + 50 条规则 → 可能只匹配 3 条。

### 4.3 Adaptive Unified/Parallel Mode
总 token < ~100K → 一个 agent 看全貌。超过 → 独立并行 per-file agent。

### 4.4 Detection-Only Scope Boundary
Skill 显式声明 "only detects, does not fix"。无文件写入。输出总是 report。修复是单独的步骤。

### 4.5 Plans and Specs as Committed Artifacts
日期标记的 plan/spec markdown 对，committed 到 `.claude/plans/` 和 `.claude/specs/`。可 grep、可 diff、跨 session 可 resume。

---

## 5. 五个编排拓扑

| 模式 | 控制方式 | 最佳场景 |
|---|---|---|
| **Orchestrator-Worker** | 中央 delegation → workers | General decomposition with accountable synthesis |
| **Pipeline** | 阶段式顺序 handoff | 确定性工作流 |
| **Swarm** | 松散并行探索 | 宽代码库搜索、头脑风暴 |
| **Hierarchical** | 多级命令 (planner → leads → workers) | 跨抽象层的大工程 |
| **Mesh** | 侧向 peer 通信 | 批评网络 |

**生产中最有效的是 Hybrid**：顶层 Orchestrator-Worker + 层级角色 + swarm 式并行探索 + pipeline 式 governance。

---

## 6. Benchmark 数据

### SWE-Bench Pro (通过率，私有/copyleft 仓库)

| 系统 | 得分 |
|---|---|
| Claude Code + Opus 4.8 | **~69%** |
| Codex + GPT-5.5 | 58.6% |
| Simple Codex + GPT-5.3-Codex | 56.8% |
| Codex + WarpGrep | 59.1% |

### Terminal-Bench 2.0

| 系统 | 得分 |
|---|---|
| GPT-5.5 | **82.7%** |
| Simple Codex + GPT-5.3-Codex | 74.9% |
| Factory Droid + Opus 4.6 | 69.9% |
| Mux + GPT-5.3-Codex | 68.5% |

### Agent Arena (众包)

| 系统 | Elo |
|---|---|
| Factory Droid | 1330 |
| Codex | 1301 |
| Devin | 1263 |
| Claude Code | 1242 |

---

## 7. 规模成就

| 项目 | 代码量 | 持续时间 | 系统 |
|---|---|---|---|
| FastRender 浏览器 | 1M+ LoC, 1000 文件 | ~1 周 | Cursor |
| Solid → React 迁移 | +266K / -193K LoC | 3 周+ | Cursor |
| Java LSP | 550K LoC | 持续中 | Cursor |
| 视频渲染优化 (25x) | — | — | Cursor (已发布到生产) |
| Agentex | ~500 agents, 1601 PRs | 持续中 | Agentex |

---

## 8. D3X: 去中心化的替代方案

**D3X** (Rawlot & Ouarbya, 2026):
- 任务编译为 DAG，事件驱动调度
- **高达 4x 加速**，~83% token 节省 vs 顺序 ReAct
- 节点独立执行，只收 parent 摘要
- 显式定位为反对 OpenAI/Anthropic 的中心化方案

## 9. Model 路由策略 (2026 共识)

| 模型层 | 用途 |
|---|---|
| 最强模型 | 分解、冲突解决、集成、最终审查 |
| Opus/Sonnet | 安全审计、架构批评、复杂调试 |
| Sonnet (主力) | 代码审查、重构、调试、测试编写 |
| 便宜模型 | 独立任务执行 + 详细任务包 |

---

## 来源

- [Cursor: Scaling Multi-Agent Autonomous Coding Systems](https://cursor.com/cn/blog/scaling-agents)
- [Anthropic: Harness Design for Long-Running Application Development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [The Code Agent Orchestra — Addy Osmani](https://addyosmani.com/blog/code-agent-orchestra/)
- [Tembo: Multi-Agent Orchestration (2026)](https://www.tembo.io/blog/multi-agent-orchestration)
- [Tembo: Claude Code Subagents (2026)](https://www.tembo.io/blog/claude-code-subagents)
- [Factory Agent Arena](https://docs.factory.ai/benchmarks/agent-arena)
- [Cursor cost optimization (July 2026)](https://gigazine.net/gsc_news/en/20260721-agent-swarm-model-economics)
- [Morphllm: Codex vs Claude Code (July 2026)](https://www.morphllm.com/comparisons/codex-vs-claude-code)
- [D3X: Dependency Driven, Decentralised Execution](https://dl.acm.org/doi/10.1145/3787279.3787317)
- [WarpGrep: Code Search Subagent #1 on SWE-Bench Pro](https://www.ycombinator.com/launches/PZx-warpgrep-v2-code-search-subagent-1-on-swe-bench-pro)
