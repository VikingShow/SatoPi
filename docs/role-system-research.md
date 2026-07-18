# Worker 多角色设计调研报告

> 日期: 2026-07-19
> 来源: Web 搜索 — Anthropic Claude Code, ICML/NeurIPS 2025, LangGraph, SWE-bench

---

## 关键发现

### 1. 混合协议优于纯固定和纯自主

**Dochkina et al. (2025)** 进行了 25,000 任务 × 8 LLM × 4-256 agent 的计算实验，核心发现:

| 协议类型 | 相对表现 |
|---------|---------|
| 纯集中式 (固定角色分配) | 基准 |
| 纯自主式 (完全自由) | -44% |
| **混合协议** (固定顺序 + 自主选角色) | **+14%** |

**结论**: 我们当前的设计方向是正确的 — 角色协商阶段是固定的（Round 0），但角色选择是自主的（worker 自己声明）。这正好是混合协议。

### 2. 动态角色涌现是真实现象

同一个研究中，仅 8 个 agent 自发涌现了 **5,006 个独特角色**。Agent 不会固守预定义角色 — 它们根据任务上下文创造复合角色。

**对 SatoPi 的启示**: 预定义的 5 个角色（architect, backend-dev, frontend-dev, code-reviewer, devops-engineer）只是起点。Worker 应该能够:
- 组合多个预定义角色的能力维度
- 或声明全新的复合角色（如 "api-designer + security-auditor"）

### 3. Claude Code: Hub-and-Spoke + Per-Agent Tool Filtering

Anthropic 的 sub-agent 设计:
- **YAML frontmatter** 定义 system prompt + tools + model
- **Per-agent tool filtering** 是社区最强烈需求（减少 token 消耗和决策瘫痪）
- **Flat hierarchy** — sub-agent 不能再委托（hub-and-spoke）

**对 SatoPi 的启示**: 我们的 `AgentDefinition.tools`/`blockedTools` 字段已经支持 per-agent tool filtering，这在行业中是领先的。

### 4. MorphAgent (ICML 2025): 两阶段动态角色演化

```
Profile Update Phase: 根据 3 个指标优化 agent 能力画像
Task Execution Phase: 根据反馈持续调整角色
```

这是最接近我们 "能力画像" 设想的学术实现。Agent 不是"选角色"，而是"声明能力维度"，然后在执行中动态调整。

### 5. Shapley-Coop (NeurIPS 2025): 公平贡献分配

使用 Shapley 值实现 self-interested agent 之间的自发合作。对于 SatoPi 的 Cloner 加权投票有直接参考价值 — 可以用 Shapley 值替代固定权重。

---

## 对 SatoPi 多角色设计的建议

基于调研，推荐**能力画像 (Capability Profile)** 模型:

### 模型设计

Worker 不选"角色"，而是声明**能力维度**:

```
Worker 声明:
  "I will cover: [backend implementation, API design, testing, security review]"

系统:
  1. 合并声明的能力维度的 guidelines
  2. tools = 所有维度声明的 tools 的并集
  3. system prompt = 主要维度的 prompt + 其他维度的 guidelines 追加
  4. Reviewer 检查: 该 worker 是否覆盖了其声明的维度
```

### 为什么能力画像优于角色加权

| 维度 | 角色权重模型 | 能力画像模型 |
|------|-----------|------------|
| **自然性** | 人工权重衰减（1.0 + 0.5 + 0.25） | 自我声明，无权重 |
| **灵活性** | 最多 2 个角色 | 无上限维度 |
| **与调研一致性** | 不匹配（5,006 自发角色无法预先定义） | 匹配（agent 自然产生复合角色） |
| **工具权限** | 主角色决定（副角色不改变 tools） | 所有维度取并集 |
| **Reviewer 可检查性** | 难（权重是主观的） | 易（"你声称覆盖了 testing，但没跑测试 → issue"） |

### 实现影响

对现有方案的改动:
1. `RoleAsset` 保留，但角色变成"建议的能力维度组合"而非"必须选的框"
2. 角色协商阶段: Worker 看到 plan + 可用能力维度列表 → 声明自己要覆盖的维度
3. 生成 Worker 时: system prompt 从所有声明维度合并，tools 取并集
4. Reviewer: 检查每个 worker 是否覆盖了其声明的维度

---

## Sources

- [Claude Code Sub-agents Documentation](https://code.claude.com/docs/en/sub-agents.md)
- [Anthropic Multi-Agent Research System](https://simonwillison.net/2025/Jun/14/multi-agent-research-system/)
- [Per-agent MCP Tool Filtering (GitHub Issue #4380)](https://github.com/anthropics/claude-code/issues/4380)
- [MorphAgent: Self-Evolving Profiles and Decentralized Collaboration (ICML 2025)](https://icml.cc/virtual/2025/49363)
- [Shapley-Coop: Credit Assignment for Emergent Cooperation (NeurIPS 2025)](https://neurips.cc/virtual/2025/loc/san-diego/poster/118868)
- [Drop the Hierarchy and Roles: How Self-Organizing LLM Agents Outperform](https://ar5iv.labs.arxiv.org/html/2603.28990)
- [LangGraph Agent Specialization Patterns](https://github.com/osok/agent-patterns/blob/main/docs/notes.md)
