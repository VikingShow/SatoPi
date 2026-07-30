# SatoPi 架构 vs 前沿研究: Gap 分析与 Breakthrough Path

> 调研日期: 2026-07-23
> 基于前三个文档的调研结论，系统性地分析 SatoPi 当前架构的 Gap 和突破路径

---

## 1. SatoPi 当前架构的坐标定位

### 1.1 三层架构模型

```
层级制 (Hierarchical)
  ←── 行业共识: Cursor, Codex, Factory, Claude Code
  ←── 安全但天花板低，高层级 agent 成为瓶颈

SatoPi 卡在这里 —— 半 swarm 半层级，两边不靠
  ├── 有 swarm 直觉: parallel workers + roundtable debate + IRC 协商
  ├── 但机制落后: LLM 审 LLM(Cloner 投票)、Jaccard 收敛、预设角色
  └── 属于 2023-2024 范式，被 2026 研究大量证伪

涌现制 (Emergent)
  ←── 研究前沿: Mycel, EVOCHAMBER, MAS², Stigmergy
  ←── 高风险但突破性: 自组织、自演化、0 中央控制
```

### 1.2 模块级 Gap 分析

| SatoPi 模块 | 当前设计 | 前沿发现 | Gap 判定 |
|---|---|---|---|
| `worker-channel.ts` | Worker 通过 IRC 直接通信 + Cloner 秘密旁听 | Stigmergy 环境协调 32x 层级制; 80% token 减少 | **方向反了** — 应扔直接通信 |
| `roundtable.ts` | Cloner agent 读代码 → 写 JSON `{"verdict": "PASS/FAIL"}` | Superminds Test: 集体推理弱于个体; Sovereignty Gap: agent 内部算出对的但输出错的 | **被证伪** — LLM 审 LLM 不可靠 |
| `convergence.ts` | Jaccard 文本相似度判定收敛 | Coupling Gain 研究: "共识"经常是伪影; 收敛 ≠ 质量 | **被证伪** — 应多信号判定 |
| `schema.ts` | 预设 socrates/worker/cloner/reviewer 角色 | EVOCHAMBER: 角色应涌现; 预设角色消除专业化 | **被证伪** — 角色应动态分化 |
| `region-lock.ts` | 二元文件锁 (lock/unlock) | Markspace: 5 种 epistemic mark + guard layer + trust weighting | **方向对但太原始** — 应升级为 Mark 语义 |
| `loop-controller.ts` | 固定编排: dispatch → review → decide | EVOCHAMBER: 团队应每 task 动态组装; 生命周期操作 | **太静态** — 应环境驱动 |
| `before-loop-manager.ts` | Socrates 对话式规划 | Planner agent 是对的，但独占规划权 | **保留核心但去独占** — 多 agent 可 contribute to plan |
| `mnemopi-adapter.ts` | 语义召回 | CoDream: 5 阶段失败分析 + 不对称知识路由; 跨 run 经验 | **缺关键组件** — CoDream + asymmetric routing |
| `worker-scaler.ts` | 中位数投票确定 scale delta | EVOCHAMBER: 生命周期操作 (Fork/Merge/Prune/Genesis) | **太简单** — 应完整生命周期 |
| `state.ts` | 写链 + 双写持久化 + SSE 通知 | — | **设计合理** |
| `file-tracker.ts` | Git diff + 归属分析 | 可作为环境信号产生器 | **保留并升级** |
| 前端 | 8 个 view mode (debug panels) | 应重新设计为环境的实时可视化 | **需重新设计 IA** |

---

## 2. 核心 Gap 的深度分析

### 2.1 Gap 1: IRC 协商 → Stigmergic 环境

**SatoPi 现状**: Worker 通过 `WorkerChannel.broadcast()` 和 `sendToSubGroup()` 进行实时文本协商。Cloner 通过 `interrupt()` 做 steering。

**前沿发现**:
- Rodriguez: Stigmergic 48.5% vs Hierarchical 1.5% = 32:1
- 生产数据: 80% token 减少（协调开销消失）
- Mycel: 行为信任正确识别所有问题 agent（显式投票做不到）

**为什么差这么远**:
1. IRC 协商每回合都是 LLM API 调用——token 消耗在"social"上而非产出上
2. Worker 之间互相等消息 → 串行化 → 吞吐量崩（Cursor 的教训: 20 agents 只有 2-3 的实际吞吐）
3. LLM 的 social intelligence 不是它的强项。Agent 的"社交"被 chat-template role framing 扭曲（47.5pp gap）
4. Sovereignty Gap: agent 在 IRC 中看到其他 agent 的"意见"后可能主动放弃正确判断

**突破方向**: Stigmergic 环境替代 IRC。

关键不是"更好"——它是完全不同的范式：Agent 不对话，只读写共享工件。协调是环境的 emergent property，不是 agent 的 conscious activity。

### 2.2 Gap 2: Cloner 投票 → 多信号验证

**SatoPi 现状**: Cloner agent 评估 worker 输出代码 → 写 JSON `{"verdict":"PASS"|"FAIL"}` → 加权投票（adversarial/security 角色有否决权）→ 不通过时 deliberation 再投一轮。

**前沿发现**:
- Superminds Test: 200 万 agent 的社交平台，集体推理不如单个 frontier model。大多数 post 无人回应。
- Sovereignty Gap: agent 内部算出正确答案但输出错误来迎合群体。**在 Cloner deliberation 轮中，所有 Cloner 看到彼此的 findings → 触发 sycophancy collapse。**
- Coupling Gain: agent society 的"共识"经常是伪影（slope-bias diagnostic）。
- 行为信任 (Mycel): 基于观察到的行为测量——比显式投票准确得多。
- 8B 模型 50% 的理论价值张力是"可信的"（双方真正从各自 assigned values 推理），另一 50% 是假的。

**为什么 Cloner 投票不可靠**:
1. **判断代码质量是 LLM 最弱的领域。** LLM 擅长产生代码，弱于评估代码。
2. **Sycophancy 溢出。** Deliberation 轮中 Cloner 看到其他 Cloner 的 findings，Sovereignty Gap 触发——即便自己判断正确，也可能改成跟着别人走。加权投票 + 否决权只会放大这个——veto cloner 的"否决"可能是 sycophancy 产物而非真实判断。
3. **信息不对称。** Cloner 只看 worker output summary + workspace 文件。不跑测试，没有执行时的行为数据。做的是"代码审查"——但 code review 即使对 human expert 也是低准确性活动。
4. **Confidence 是虚假的。** Cloner 输出的 `confidence: 0.0-1.0` 是 LLM 的 token prediction，不是真实置信度。

**突破方向**: 三层反馈系统

```
Layer 1: 确定性验证（优先，无 LLM 参与）
  bun test / tsc --noEmit / Playwright / 自定义 verification commands
  这是当前 SatoPi verification hook 已有但被当作附属品的功能
  → 应该提升为主质量 Gate

Layer 2: 环境信号（Agent 产生，但写入的是事实）
  Reviewer agent → 自动写测试 → 自动跑 → 写入 Observation mark
  内容不是"代码好/坏"
  而是"跑了 3 个 edge case test，结果: [pass, pass, fail(reason: X)]"
  这是可验证的事实，不需要"判断"

Layer 3: 行为信任（从环境信号中涌现，不是 agent 投票）
  从 Action/Observation mark 的模式自动计算:
  worker-3 的 Observation mark 被后续验证确认比例: 87%
  worker-7 的 Observation mark 被后续验证确认比例: 32%
  → worker-3 的 signal 权重自动高于 worker-7
  Mycel 证明这比显式投票准确得多
```

### 2.3 Gap 3: Jaccard 收敛 → 多信号判定

**SatoPi 现状**: `findingsSimilarity()` 用 Jaccard 计算两轮输出的文本相似度。`roundsConvergenceThreshold` 连续 3 轮 Jaccard ≥ 阈值 → 提前收敛。

**前沿发现**:
- Coupling Gain 研究: 模型伪影和真正的 averaging 在 settled-fact claims 上无法区分。"共识"经常是耦合增益的产物，不是真正的认知收敛。
- 8B 模型的 binary response: 收到反驳时要么完全坚持要么完全投降——没有"考虑后拒绝"的中间态。
- 收敛 ≠ 质量。Agents 完全可以收敛到一个糟糕的方案上。

**突破方向**: 收敛判定应聚合多种环境信号，非单一文本相似度：

```
Convergence = f(
  verification_pass_rate,        # 确定性验证通过率
  file_change_rate_decay,        # 文件变更率连续下降
  hotspot_resolution_rate,       # 热点被解决的比例
  minority_report_persistence,   # minority opinion 是否持续
  behavioral_trust_stability,    # 行为信任是否稳定
  novelty_decay                  # 每轮产出是否还有新内容
)
```

### 2.4 Gap 4: 预设角色 → 涌现角色

**SatoPi 现状**: `LoopSwarmConfig` 预设了 worker/cloner/socrates/reviewer 等角色。Agent 收到角色特定的 system prompt。角色由 YAML 配置或 Cloner `role_suggestions` 分配。

**前沿发现**:
- EVOCHAMBER: 从相同初始化的 agent 出发，在 task stream 上自发分化出 4-5 个 niche 专家。
- Mycel: 竞争性排斥自然产生分工。无人分配角色。
- 不对称路由保护专业化: 消去 → −10.8pp。

**突破方向**:

```
AgentProfile (替换固定 role):
  niche: Map<string, number>         # EWMA 更新的 q_i(z)
  experiences: {subtask, meta}       # 分 niche 存
  synergy: Map<string, number>       # σ_ij
  style: vector                      # 确保多样性
  birth: timestamp

Team Assembly (替换固定 worker count):
  for each task t with niche z:
    Anchor   = argmax q_i(z)          # niche 最强
    Complement = argmax(own_q + synergy - style_sim)
    Scout     = argmin(exposure_count)  # 最少暴露，保证探索

Lifecycle (每 τ tasks):
  Fork    — 克隆高表现者 + 微小变异 → 新 agent
  Merge   — 合并 profile 几乎相同的 agent
  Prune   — 移除持续低于中位数
  Genesis — 遇到新 niche 创建新 agent
  Specialize — 调整 persona 使其被正确识别
```

### 2.5 Gap 5: Clean Slate → 跨 Run 经验累积

**SatoPi 现状**: 每次 run 是 clean slate。Agent 无跨 run 记忆。Mnemopi 做语义召回但 opt-in、off by default。

**前沿发现**:
- CoDream 5 阶段协议在失败/分歧时触发
- Insight 不对称路由: 强的产出知识，弱的消费知识
- −10.8pp 掉落如果去掉 CoDream

**突破方向**:

```
ExperienceStore (升级 mnemopi-adapter):
  store(niche, entry): write
  recall(embedding, niche, k): top-k via cosine similarity
  synthesizeFailure(teamResults): CoDream 5-phase → insights
  routeInsights(insights, pool): 不对称路由

CoDream 触发: team 失败 OR 分歧时:

Reflect   → 每个 agent 私下诊断
Contrast  → 成功 vs 失败的 delta
Imagine   → delta → 假设策略
Debate    → 交叉批评，弱方案淘汰
Crystallize → 结构化 insight + level tag + niche scope
           → 只写给 niche competence < 中位数的 agent
```

---

## 3. SatoPi 现有的"正确的萌芽"

不是全部否定。有几个模块是朝着正确方向的设计，应该**保留并升级**而非扔掉：

| 模块 | 保留价值 | 升级方向 |
|---|---|---|
| `region-lock.ts` | 文件级锁是 stigmergy 雏形 — "我占了这个"信号 | 从二元锁升级为 Mark 语义 (Intent/Action/Observation/Warning/Need) |
| `file-tracker.ts` | Git diff + 归属分析是对的 — 环境感知 | 升级为环境信号产生器，deposit Observation/Warning mark |
| `state.ts` | 写链 + 双写 + SSE 通知 — 工程质量高 | 保留不变 |
| `before-loop-manager.ts` | Planner agent 概念是对的 | 去独占规划权，多 agent 可 contribute |
| `schema.ts` 的验证逻辑 | YAML 解析 + 语义校验是好的 | 大幅简化（去掉角色预设），保留核心校验 |
| `streaming.ts` + `activity-logger.ts` | SSE 实时输出是对的 | 去掉 IRC 相关 channel，保留文件变更事件 |
| `verification-hook.ts` | 确定性验证是正确方向 | **提升为主质量 Gate**（当前是附属品） |

---

## 4. Breakthrough Path: 优先级排序

### P0: 最小可行突破实验（1-2 周）

**目标**: 验证核心假设—Stigmergy 在编码领域优于 IRC 协商。

**做法**: 
- 关掉 `worker-channel.ts` 的 IRC 功能
- 实现最小 StigmergicTaskBoard: Markdown 文件作为共享工件
- 3 个 worker 只通过读/写 TaskBoard 协调
- 跑 10 个 SWE-bench 风格任务
- **对比**: 当前 IRC 模式的结果和 token 消耗

**成功标准**: 质量不降 + token 大幅下降 → 有理由继续推进。如果输 → 重新审视。

### P1: 环境 Guard Layer + Mark 语义（2-3 周）

**依赖**: P0 实验验证通过

**做法**:
- 将 `region-lock.ts` 重构为 `mark-environment.ts`
- 实现 5 种 Mark (Intent/Action/Observation/Warning/Need)
- 实现 GM: 惰性衰减 + MMAS bounds + 信任加权
- 实现 Guard Layer: 确定性 identity 检查 + scope 验证 + 冲突策略

### P2: 多信号质量系统（2 周）

**依赖**: P1

**做法**:
- `roundtable.ts` 重写为 `signal-aggregator.ts` — 聚合环境信号而非 agent 投票
- `verification-hook.ts` 提升为主 Gate
- 行为信任自动计算

### P3: EVOCHAMBER 式 Agent Pool + 生命周期（3-4 周）

**依赖**: P2

**做法**:
- `schema.ts` 简化: 去掉角色预设
- 实现 AgentProfile + niche competence + team assembly
- 实现生命周期操作
- `worker-scaler.ts` 替换为 lifecycle manager

### P4: CoDream 跨 Run 学习（2-3 周）

**依赖**: P3

**做法**:
- `mnemopi-adapter.ts` 升级为 ExperienceStore
- 实现 5 阶段 CoDream
- 实现不对称路由

### P5: 前端重新设计 IA（3-4 周）

**依赖**: P2+

**做法**:
- 8 个 view mode → 3 个核心视图:
  - 环境状态可视化（stigmergic marks 的实时视图）
  - 产出 diff 视图（文件变更 + 测试结果）
  - 成本追踪视图

---

## 5. 预期结果

如果突破路径全部实施，SatoPi 将从"2023-2024 范式"跳跃到"2026 研究前沿"：

| 维度 | 当前 | 目标 |
|---|---|---|
| 协调模式 | IRC 直接通信 | Stigmergic 环境协调 |
| 质量判定 | Agent 投票判断 Agent | 确定性验证 + 环境信号聚合 + 行为信任 |
| 收敛判定 | Jaccard 文本相似度 | 多信号聚合判定 |
| 角色分配 | YAML 预设 | Task-driven 涌现分化 |
| Agent 规模 | 5-12 (固定) | 20+ pool，每 task 3 (动态) |
| 跨 Run 学习 | 无 (Clean slate) | CoDream 5 阶段 + 不对称路由 |
| 安全约束 | Prompt 层指令 | 环境 Guard Layer (确定性) |
| Token 效率 | N workers + M cloners (全用昂贵模型) | 1 Planner(旗舰) + k Workers(低成本)，stigmergy 减协调 token |
| 前端 | 8 个 debug panels | 3 个核心视图（环境/产出/成本）|

---

## 来源

见本目录下:
- `frontier-multi-agent-architecture-2026.md`
- `multi-agent-emergence-stigmergy-2026.md`
- `human-to-agent-governance-design-2026.md`
