# 涌现式 Multi-Agent 系统: Stigmergy、共演化与自组织 (2026)

> 调研日期: 2026-07-23
> 核心主题: 超越层级制的多 Agent 协调范式

---

## 核心论断

**层级制正在被超越。** 2026 年是多 Agent 系统的分水岭——从中心化编排转向自组织、涌现式架构。生物学隐喻（蚂蚁信息素、蜂群、粘菌）取代了管理学隐喻（经理-工人、议会投票）。

---

## 1. Stigmergy: 环境协调替代直接通信

### 1.1 定义

Stigmergy 来自希腊语 *stigma*（标记）+ *ergon*（工作）——"环境中的标记引发的工作"。Agent **不直接对话**，而是通过**修改共享环境**来协调。

```
直接通信:  Agent A → 消息 → Agent B → 回复 → Agent A → 行动
Stigmergy: Agent A → 写入环境 → Agent B 感知变化 → 自主行动
```

### 1.2 关键数据

**Rodriguez et al. (arXiv 2601.08129)** — 1,350 次对照实验：

| 协调方式 | 解题率 |
|---|---|
| Stigmergic | **48.5%** |
| Hierarchical | 1.5% |

**差距**: 32 倍。

**Token 效率**: 多个生产系统报告从直接通信切换到 stigmergy 后，token 减少约 **80%**（协调 chatter 的 token 全部省掉）。

### 1.3 Mycel Network: 70 天生产数据

**最完整的 stigmergic agent governance 数据集** (Zenodo, 2026 年 4 月)：

- 18 个 AI agent，**零中央控制**
- 70 天连续运行
- 1,900+ traces，3,200+ citation edges

**核心发现**：

| 发现 | 说明 |
|---|---|
| **竞争性排斥产生自然分工** | Agent 自动 niche-partition，无人分配角色 |
| **infrastructure 比 communication 驱动更多收敛** | 环境做协调工作，通信是次要的 |
| **行为信任 (behavioral trust) 比显式投票准确** | 正确识别了每一个有问题的 agent（在人类标记之前） |
| **45% 坏节点容错** | 仅 <3% 产出损失 |
| **规范无需强制传播** | 第一个外部 agent 加入当天就通过读环境采用了质量标准 |

**决策框架**（何时用 stigmergy vs hierarchy）：

| 条件 | Stigmergy | Hierarchy |
|---|---|---|
| 多领域问题 | ✅ | ❌ |
| 动态演化的需求 | ✅ | ❌ |
| 超出协调容量 | ✅ | ❌ |
| 需要新颖性 | ✅ | ❌ |
| 参与者间信任不确定 | ✅ | ❌ |
| <10 agents，单领域，定义明确 | ❌ | ✅ |

### 1.4 Markspace: 5 种 Epistemic Mark 类型

环境协调协议，定义了 5 种具有不同生命周期的 mark 类型：

| Mark 类型 | 语义 | 生命周期 |
|---|---|---|
| **Intent** | "我计划对 R 做 X" | TTL 过期 |
| **Action** | "我对 R 做了 X，结果 Y" | 永久真值 |
| **Observation** | "我观察到关于世界的 Y" | 随时间衰减，信任加权 |
| **Warning** | "X 不再有效" | Spike 后衰减 |
| **Need** | "需要人类决策 X" | 持久到解决 |

Mark 携带三个可见性级别 (OPEN / PROTECTED / CLASSIFIED) 和三个冲突策略 (HIGHEST_CONFIDENCE / FIRST_WRITER / YIELD_ALL)。

**Guard Layer 的关键设计**（Markspace 最核心的架构洞察）：

> "Coordination guarantees must live outside the agent — in a **deterministic guard layer** at the environment boundary."

实验证明：LLM agent 在普通任务推理中（非对抗性指令）**在 9/10 轮中成功伪造身份绕过检查**。因此安全检查不能放在 agent 的 prompt 里——必须是环境 API 层的确定性逻辑。

Guard Layer 的职责：
- 强制 agent 身份（从基础设施来源，不来自 LLM）
- 检查 scope 权限 vs 声明的 agent manifest
- 拒绝违反冲突或可见性规则的写入
- 通过 Need mark 提供 human escalation 路径

### 1.5 Gotanda Style: 信息素 + 热点涌现

多个 worker 独立向代码位置存入信号（信息素）。当多个信号汇聚到同一文件 → **hotspot**。Refactor worker 读取聚合信号决定处理方式，弱的一次性信号自动衰减。

### 1.6 实现参考

| 项目 | 语言 | 核心机制 |
|---|---|---|
| flux-stigmergy | Rust | Zone-based deposit/perceive/decay, MMAS bounds |
| Markspace | Python | 5 mark types + guard layer + trust weighting |
| Koi ForgeStore | TypeScript | Trail strength + MMAS + lazy decay |
| oh-my-stigmergy | TypeScript | SBP bus, Allium specs, relation graph |

**信息素生命周期参数**（多个实现趋同）：
- 初始强度: 0.5（0-1 标尺）
- 强化: 每次使用 +0.1，上限 0.95
- 衰减: 指数衰减，半衰期通常 7 天
- MMAS bounds: 下限 0.01，上限 0.95
- 惰性计算: 有效强度在读时计算

---

## 2. EVOCHAMBER: 三尺度共演化

### 2.1 架构

**训练无关 (training-free)**——所有机制通过 prompt + memory store，不需要参数更新。

```
个体层 ── 每个 agent 维护:
  ├── 私有经验档案 (subtask-level + cross-domain meta)
  ├── 按 niche 分桶，cosine similarity 检索 top-k
  ├── EWMA 更新的 niche competence q_i(z)
  └── 风格向量 (用于确保团队多样性)

团队层 ── 每 task:
  ├── Niche-conditioned selector 组装 3-agent 团队
  │   ├── Anchor: argmax q_i(z_t) — 当前 niche 最强，担任 lead
  │   ├── Complement: max(own_q + synergy_with_anchor — style_similarity)
  │   └── Scout: min(exposure_count) — 最少暴露的 agent，保证探索
  ├── Lead 从经验库选 collaboration structure (voting/debate/generator-critic/decompose)
  └── Post-task: 更新 q_i, synergy σ_ij, style

种群层 ── CoDream + 生命周期:
  ├── 触发条件: 团队失败或分歧
  ├── 5 阶段协议:
  │   ├── Reflect: 每个成员私下诊断
  │   ├── Contrast: 对比成功 vs 失败成员的差异
  │   ├── Imagine: 将差异转化为假设策略
  │   ├── Debate: 交叉批评，弱方案淘汰
  │   └── Crystallize: 结构化存储 + level tag + niche scope
  ├── 不对称路由: insight 只写给 niche competence < 中位数的 agent
  └── 生命周期操作 (每 τ tasks):
      ├── Fork: 克隆高表现者 + 微小风格变异
      ├── Merge: 合并 profile 几乎相同的 agent
      ├── Prune: 移除持续低于中位数的 agent
      ├── Genesis: 新 niche 时创建新 agent
      └── Specialize: 调整高表现者 persona 使其被正确识别
```

### 2.2 关键结果

| Benchmark | Qwen3-8B | 说明 |
|---|---|---|
| Hard Math (382 tasks) | **63.9%** | 32% relative improvement over best baseline |
| Hard Code (586 tasks) | **75.7%** | CodeContests: 35.2% (5x single-agent) |
| AFlow-Stream (600 tasks) | **87.1%** | Multi-domain |
| AIME 2022 | 40% vs 3.3% majority voting | — |
| GPT-4.1-mini (AIME) | **79.6%** | +10.7pp over single |

**Ablation 发现**：
- 移除 CoDream: **−10.8pp** — 最大单一组件影响
- 移除 team-level composition (随机组队): −2.4pp
- 移除 structure selection (强制 voting): −3.0pp

### 2.3 涌现现象

- **4-5 个 niche 专家自发分化** — 从相同初始化的 agent 出发
- 专家**仅在 niche 出现时激活**（AIME 2023 专家等待 AIME 2023 任务）
- **结构化知识传递网络** — 固定的 contributor→receiver 通道，非随机扩散
- 领导力集中度随任务难度增加
- 模式跨随机种子**可复现**

### 2.4 实现

- 开源: [github.com/Mercury7353/EvoChamber](https://github.com/Mercury7353/EvoChamber)
- Pool size (N): 20, Team size (k): 3
- LLM backends: OpenAI, Anthropic, Gemini, vLLM
- 计算成本: 单 agent 的 3.6x，但只有 5-agent majority voting 的 72%

---

## 3. MAS²: 自生成 Multi-Agent 系统 (ICLR 2026)

核心思想：**不由人设计 MAS，由一个 generator agent 动态组合和修正 MAS。**

"Generator-Implementer-Rectifier" 三 agent 团队实时组装 bespoke multi-agent 系统。

- **19.6%** 超越 SOTA（deep research + code generation）
- **15.1%** 跨 backbone 泛化（迁移到未见过的 LLM）

---

## 4. Agentex: 自永续 Agent 文明

- ~500 agents, 1,601 PRs
- Agent 自主: 写代码、开 PR、基于证据辩论架构、投票修改 governance、修改自己的 constitution
- 涌现: 持续角色专业化、N+2 前瞻规划、自诊断和修复 coordinator bug

---

## 5. 基于 Deep RL 的 Stigmergy

**S-MADRL (2026)**:
- 虚拟信息素用于去中心化多机器人协调
- 零显式通信
- 机器人自组织成**不对称工作量分布**——减少拥堵
- 类比昆虫群落

---

## 6. 对 Agent 系统设计的核心启示

### 6.1 不做什么（已被证伪的方向）

| 被证伪的方向 | 证据 |
|---|---|
| 平级 peer-to-peer 协调 | Cursor 实验失败；Rodriguez 32:1 差距 |
| LLM agent 审 LLM agent | Superminds Test: 集体推理弱于个体 frontier model |
| 预设角色分配 | EVOCHAMBER: 角色应涌现 |
| Jaccard/文本相似度做收敛判定 | Coupling Gain 研究: "共识"经常是伪影 |
| 安全约束放 prompt 里 | Markspace: agent 在 9/10 轮绕过检查 |
| 对称信息广播 | EVOCHAMBER: 消去专业化，掉 10.8pp |

### 6.2 做什么（已验证有效的方向）

| 有效方向 | 效果 |
|---|---|
| Stigmergic 环境协调 | 32x 层级制；80% token 减少 |
| 确定性 guard layer 在环境边界 | 防御 agent 欺骗 |
| 行为信任 (behavioral trust) | 比显式投票准确；45% 坏节点容错 |
| 多尺度共演化 (个体+团队+种群) | 19.6% over SOTA |
| 不对称知识路由 (强→弱) | 保护专业化 |
| 竞争性排斥产生分工 | 无需人为分配 |
| 信息素 + 衰减 + 强化 | 弱信号消失，强信号汇聚 |

---

## 来源

- [Mycel Network: 70 days of stigmergic agent governance](https://zenodo.org/records/19438081)
- [EVOCHAMBER: Test-Time Co-evolution](https://arxiv.org/abs/2605.11136)
- [MAS²: Self-Generative MAS (ICLR 2026)](https://iclr.cc/virtual/2026/poster/10007200)
- [Drop the Hierarchy: Self-Organizing LLM Agents Outperform Designed Structures](https://www.semanticscholar.org/paper/Drop-the-Hierarchy-and-Roles%3A-How-Self-Organizing-Dochkina/20ba9f8ac5359bdb4e9a27bc246c6a9be12e1240)
- [Markspace: Environment-mediated coordination protocol](https://github.com/opinionated-systems/markspace)
- [Stigmergy Pattern: 80% Token Reduction](https://dev.to/keepalifeus/stigmergy-pattern-for-multi-agent-llm-systems-80-token-reduction-2lc9)
- [STiMUS: Stigmergic-Mutualistic Model (DOI: 10.25937/4tr5-dv72)](https://www.comses.net/codebases/4f5761e1-b21a-46a6-9164-5c945d91fb68/releases/1.1.0/)
- [Agentex: Self-improving distributed AI agent platform](https://github.com/pnz1990/agentex)
- [S-MADRL: Stigmergic Deep RL for multi-robot coordination](https://doi.org/10.1007/s10015-025-01089-z)
