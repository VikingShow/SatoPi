# Worker 多角色设计调研报告

> 日期: 2026-07-19 (2026 年 7 月)
> 来源: ASE 2025/2026, ICML 2026, NeurIPS 2025, Anthropic Claude Code, LangGraph, Zencoder

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

---

## 第二轮调研: 产出契约 + 缺失检测 + 激励机制 (2026-07-19)

### 验证结论: 三个设计全部被前沿实践确认

---

### 1. 产出契约 — ✅ 确认，是 2025-2026 主流范式

**核心证据**:

- **SEMAP** (APSEC 2025): "Explicit behavioral contract modeling" 作为多 Agent 协议的核心设计原则之一。协议驱动的多 Agent 工程方法，实现 **function-level 代码开发失败率降低 69.6%**。

- **VibeContract 范式** (2025): 将自然语言意图分解为显式任务序列，每层有 contract 定义预期输入/输出/约束/行为属性。Contracts 指导 LLM 进行测试、运行时验证和调试。

- **Specialists 框架** (xtrm-dev, 2025): 每个 specialist 只获得其角色需要的 context、tools 和 **output contract**，返回结构化证据而非对话文本。核心理念: "bead = problem + scope + success criteria + validation rules + dependencies + handoffs"。

- **CodeSignal Codex subagents** (2025): 强制 JSON 输出 contract — `{status, summary, findings, files_read, files_modified}`。根本原则: "If you plan to chain this result, don't accept 'helpful explanation' — accept parseable output."

**对 SatoPi 的启示**: 产出契约设计完全正确。关键差异化: SatoPi 的 contract 是**可协商的**（agent 可以提议修改），这比其他系统更先进。

---

### 2. 缺失检测 — ✅ 确认，是 Agent 失败的首要原因

**核心证据**:

- **Xie et al. (arXiv 2511.04064, 2025)**: 对端到端软件开发中 LLM agent 系统的基准研究表明，**首要瓶颈不是代码生成错误，而是需求遗漏和自验证不足**。SOTA agent 在挑战性基准上**仅满足约 50% 的需求**。

- **ASE 2025 论文**: 单 LLM 的缺失需求检测召回率仅 **0-52%**（即漏掉了一半以上的需求缺陷！）。三个互补 LLM 的 ensemble（DeepSeek Chat + GPT-4o Mini + Claude Sonnet 4）将召回率提升到 **75-100%**，建议可信度 95-100%。

- **ASE 2025 另一篇论文**: LLM 在**验证代码是否符合自然语言规范**时存在系统性失败 — 频繁将正确代码误判为"不满足需求"。更讽刺的是，**更复杂的 prompt（带解释和修改建议）导致更高的误判率**。

**对 SatoPi 的启示**: "Missing" 字段的强制要求完全正确。单 agent 无法可靠地自检遗漏 — 这就是为什么需要 Adversarial Cloner + Reviewer 双重检查。Survey 中 99% 的论文忽略了可审计性，而我们的审计日志设计正好填补了这个空白。

---

### 3. 激励机制 — ⚡ 部分确认，praise/criticism 是创新

**核心证据**:

- **MAPRO 框架** (2025): 将 prompt 优化形式化为跨整个多 agent 拓扑的联合推理问题，在节点和边上传播依赖和信用信号 — 实现协调的自改进而非孤立的局部优化。

- **Self-Reflection** (Chain 框架, Shinn et al. 2023): Agent 重访推理轨迹、识别错误、整合纠正反馈 — 作为隐式自我批评循环，提高鲁棒性和样本效率。

- **Multi-Agent Debate (DMAD)**: Agent 使用不同的推理方法，通过多元视角创造建设性批评，抵消"mental set"（过度依赖相似策略）。

- **显式 praise/criticism 机制**: 在已发表文献中**未被广泛记录**。大多数系统使用隐式反馈（自我反思、辩论、投票）而非显式的 praise/criticism 计数。

**对 SatoPi 的启示**: 我们的 praise/criticism 机制（Worker 发现缺失 → praise +1；没发现 → Reviewer 标记为 superficial review → criticize）在已发表文献中似乎**没有直接先例**。这是一个**差异化创新**。文献中大多是隐式反馈，我们是显式的可量化激励。值得保留。

---

### 4. 额外发现: 证据链 (Evidence Trails)

- **verify-agent-output skill** (agent-almanac, 2025): 定义了完整程序 — 执行前定义可检查的期望，执行中生成证据链（checksums, test results, timing），对外部锚点验证，运行 fidelity checks。核心原则: **"An agent cannot reliably verify its own compressed output."**

- **Zencoder Zenflow** (2025): "Multi-agent verification" — 不同的 AI 模型互相 critique 对方的工作（如 Claude 验证 OpenAI 生成的代码），消除盲点。

**对 SatoPi 的启示**: 产出契约不应只是声明，还应包含**执行中自动生成的证据链**。Worker 的 Round Summary 应该包含 test results、file hashes、timestamps — 这些是 Review 的 anchor points。

---

## 综合结论

| 设计 | 前沿验证 | 差异化程度 |
|------|---------|-----------|
| 产出契约 + 可验证字段 | ✅ 2025 主流范式 (SEMAP, VibeContract, Specialists) | 相同方向 — 但 SatoPi 的**可协商契约**更先进 |
| 强制 "Missing" 字段 | ✅ 填补了 Agent 失败的首要原因 (ASE 2025, Xie et al.) | 相同方向 — 但 SatoPi 的**multi-LLM ensemble 检测**独特 |
| Adversarial Cloner 专门找漏 | ✅ 已确认为必要 (Zenflow, CLEAR) | 领先 — 大多数系统没有专职的对抗性审查者 |
| Praise/Criticism 显式激励 | ⚡ 文献中无直接先例 | **创新** — 大多数系统使用隐式反馈 |
| 证据链 (Evidence Trails) | ✅ 新兴实践 (verify-agent-output, Zenflow) | 落地后领先 |

---

## Sources

- [Claude Code Sub-agents Documentation](https://code.claude.com/docs/en/sub-agents.md)
- [Anthropic Multi-Agent Research System](https://simonwillison.net/2025/Jun/14/multi-agent-research-system/)
- [Per-agent MCP Tool Filtering (GitHub Issue #4380)](https://github.com/anthropics/claude-code/issues/4380)
- [MorphAgent: Self-Evolving Profiles and Decentralized Collaboration (ICML 2025)](https://icml.cc/virtual/2025/49363)
- [Shapley-Coop: Credit Assignment for Emergent Cooperation (NeurIPS 2025)](https://neurips.cc/virtual/2025/loc/san-diego/poster/118868)
- [Drop the Hierarchy and Roles: How Self-Organizing LLM Agents Outperform](https://ar5iv.labs.arxiv.org/html/2603.28990)
- [LangGraph Agent Specialization Patterns](https://github.com/osok/agent-patterns/blob/main/docs/notes.md)
