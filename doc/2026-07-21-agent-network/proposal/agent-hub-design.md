# AgentHub 设计探讨：它应该是什么、为什么需要它、谁已经做过类似的事

> 2026-07-21 | 基于 SatoPi 当前 dev 分支代码库

---

## 一、从 GitHub 的诞生理解 AgentHub 的需求

2008 年 Git 已经存在了三年，但开源协作依然痛苦——你有代码但不知道谁在 fork、不知道别人改了什么、不知道往哪里发 patch。Git 解决了版本控制，但没有解决**发现**和**协作**。

GitHub 做的事不是"更好的 Git"。它做的事是：

- **发现**：你的代码可以被别人找到（public repo + search）
- **协作**：fork → commit → pull request → review → merge，这是一套社交协议，不是 Git 的功能
- **身份**：一个 GitHub profile 就是你的开源身份证——你的 repos、contributions、stars 构成你的"代码履历"

**Git 是工具。GitHub 是市场。**

SatoPi 当前处于"Git 阶段"——它有完善的 Swarm 引擎（LoopController + PipelineController + Roundtable），但它只知道**自己启动的子进程**。它不知道世界上还有谁擅长安全审计、谁擅长性能优化、哪个团队有更便宜的 GPU 集群。

AgentHub 要做的事就是"Agent 的 GitHub"：

- **发现**：有哪些 Agent 可以用来做 Cloner 审查？它们的专长是什么？
- **协作**：外部 Agent 如何参与一个 Swarm 的审查圆桌？人类如何介入被阻塞的决策？
- **身份**：一个 Agent 的 track record 构成了它的"履历"——历史成功率、擅长领域、被信任程度

---

## 二、AgentHub 的价值不是"分布式计算"，而是"打破 Agent 供给瓶颈"

当前 SatoPi Swarm 的所有 Worker 和 Cloner 共享同一个 `ModelRegistry` 实例、同一个 API Key、同一个进程沙箱。这个模型面临三个瓶颈：

**瓶颈 1：模型供给单一**。所有 agent 用同一个 provider，无法做"便宜的 worker + 贵的 reviewer"的组合。如果你的 DeepSeek API Key 额度用完了，整个 Swarm 挂掉。

**瓶颈 2：能力供给单一**。SatoPi 的 agent 是一个通用 coding agent——它能读文件、写代码、跑命令。但它不会做安全扫描（需要 SAST 工具链）、不会做性能 profiling（需要专门的 profiler）、不会做 UI 可访问性审查（需要浏览器自动化 + a11y checker）。这些能力不是"多写一个 prompt"能解决的——它们需要独立的环境和工具。

**瓶颈 3：信任供给单一**。当前 Cloner Council 中的所有 cloner 都是同一个 omp 实例的子进程。它们在同一个沙箱里，用同一个 provider，收到同一个 prompt 模板。它们之间的"辩论"实际上只是同一个模型的多次采样——起不到真正的 adversarial review 作用。真正的"红队审查"需要一个独立的环境、独立的模型、独立的利益方。

AgentHub 解决的不是"让 SatoPi 跑得更快"，而是：

- 让 Worker 可以来自不同的模型 provider（DeepSeek 做粗活，Claude 做审查）
- 让 Cloner 可以是独立的外部服务（安全扫描器、性能分析器、可访问性检查器）
- 让人类可以在决策阻塞时介入（不是二选一按钮，而是真正地修改 plan、替换 worker 产出、调整方向）

**AgentHub 的价值 = 打破 Agent 的供给同质化。**

---

## 三、业界已有的类似实现

### 3.1 OpenAI Swarm（2024年10月）

OpenAI 发布的 `openai/swarm` 是一个轻量级多 Agent 编排实验框架。它的核心概念是 rounting + handoff——一个 agent 可以把对话"交给"另一个 agent。

**与 AgentHub 的关系**：Swarm 的 handoff 模式验证了"不同 agent 处理不同领域的问题"这个方向。但 Swarm 是实验性的（README 第一句：Swarm is experimental, not intended for production），且它只在 OpenAI 生态内运行——所有 agent 都是同一个 provider 的不同 system prompt。

**AgentHub 的不同**：Hub 允许跨 provider、跨进程、跨网络的 agent 注册。注册进来的 agent 是独立服务，不是同一个 provider 的不同 prompt。

### 3.2 Microsoft AutoGen（2023年至今）

AutoGen 是 Microsoft 的多 Agent 对话框架。它的核心是多 Agent 聊天——agent 之间通过消息交互，可以有人类参与。

**与 AgentHub 的相似之处**：AutoGen 的 `ConversableAgent` 支持外部工具调用和人类-in-the-loop。它的 GroupChat 模式让多个 agent 在同一轮讨论中发言。

**与 AgentHub 的不同**：AutoGen 是 Python 框架，agent 都是同一个进程内的 Python 对象。它没有"注册 → 发现 → 匹配 → 调度"的网络层。它的 agent 没有跨 session 的 persistent identity（每次运行都是新的 agent 实例）。

### 3.3 LangGraph / LangChain Platform（2024-2025）

LangChain 推出了 LangGraph Platform——一个部署和托管 LangGraph agent 的云服务。它支持将 agent 部署为 API，并提供了 agent 注册和发现的基础设施。

**与 AgentHub 的相似之处**：部署后的 agent 暴露为 API 端点，可以被其他 agent 调用。这是一个"agent as a service"的模型。

**与 AgentHub 的不同**：LangChain Platform 是一个商业云服务，不是开源自托管方案。它的 agent 发现依赖 LangChain 的生态系统，不支持任意 coding agent 的注册。

### 3.4 Claude Code Plugin Marketplace（2025-2026）

Claude Code 的插件市场让开发者可以分享和安装自定义 slash command、hook、agent。这是一个"能力市场"的概念——但仅限于 Claude Code 生态内部。

### 3.5 Orca ADE / StablyAI（2025-2026）

Orca 是一个桌面 Agent 开发环境（11.7K+ stars），它最相关的特性是**并行 Agent 工作树**——你可以在多个隔离的 git worktree 中同时运行 Claude Code、Codex、Cursor、OpenCode，然后它自动合并结果。

**与 AgentHub 的相似之处**：每个"外部 agent"是独立的 CLI 进程，在自己的 worktree 中运行。Orca 负责调度它们并行执行，然后汇总产出。这与 AgentHub 的"异构 agent 调度"概念非常接近。

**与 AgentHub 的不同**：Orca 是桌面应用（本地机器），它的 agent 全部是本地 CLI。AgentHub 是网络层的调度——agent 可以在不同的机器上，通过 WebSocket 连接。

### 3.6 Hugging Face Spaces + Gradio Agent API（2025）

Hugging Face 的 Spaces 让开发者部署 AI 应用。最近 Gradio 新增了 Agent API 支持——可以把一个 agent 部署为 API 端点，其他应用调用它。

**与 AgentHub 的相似之处**：部署 → 发现 → 调用，构成一个 agent 市场的基本元素。

### 3.7 对比总结

| 项目 | Agent 发现 | 跨 provider | 跨网络 | 独立身份/履历 | 人类参与 | 开源自托管 |
|------|-----------|------------|--------|-------------|---------|-----------|
| OpenAI Swarm | 路由表 | ❌ | ❌ | ❌ | ❌ | ✅ |
| AutoGen | GroupChat | ❌ | ❌ | ❌ | ✅ | ✅ |
| LangGraph | API 端点 | ✅ | ✅ | 部分 | 部分 | ❌(云服务) |
| Claude Code Plugin Market | 市场 | ❌ | ❌ | ❌ | ❌ | 部分 |
| Orca ADE | worktree 调度 | ✅ | ❌ | ❌ | ❌ | ✅ |
| HuggingFace Spaces | 搜索 | ✅ | ✅ | ❌ | ❌ | 部分 |
| **SatoPi AgentHub** | **发现+匹配** | **✅** | **✅** | **✅** | **✅** | **✅** |

**AgentHub 填补的空白**：没有任何一个现有项目同时做到了跨 provider + 跨网络 + agent 独立身份/履历 + 人类参与 + 开源自托管。

---

## 四、AgentHub 如果要实现其价值，关键设计决策是什么

### 决策 1：Agent Profile 是"身份"而非"配置"

当前 SatoPi 的 Agent 配置是 `loop.yaml` 中的一个字符串数组：`workers: [worker-a, worker-b]`。AgentHub 升级这个模型——一个 Agent 不是 YAML 中一行配置，而是有自己的 identity、expertise、track record、trust level 的独立实体。

具体的区别：

- 当前：删除 `loop.yaml` 中的 worker 名称 → agent 消失。没有持久的历史记录。
- AgentHub：Agent 注册后就有独立的 profile JSON 文件。即使它在当前 Swarm 中没有被分配到任务，它的 track record 不会消失。下次 Swarm 运行，它的历史表现可以被 `AgentRegistry.match()` 考虑。

### 决策 2：match() 是规则引擎，不是 LLM 调用

用 LLM 来决定"哪个 agent 最适合这个任务"是浪费 token 和延迟——这是典型的垃圾进垃圾出。LLM 不理解 Agent 的真实成功率，它只能基于 profile 文本做"看起来合理"的判断。

`AgentRegistry.match()` 是一个确定性的加权评分函数：

```typescript
function match(task: Task, candidates: AgentProfile[], count: number): AgentProfile[] {
  return candidates
    .filter(a => a.connectionState === "online")
    .map(a => ({
      profile: a,
      score:
        // 领域匹配度：45% 权重
        domainScore(task.domains, a.expertise) * 0.45 +
        // 历史成功率：35% 权重
        a.trackRecord.successRate * 0.35 +
        // 信任等级：20% 权重
        a.trustLevel * 0.20
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(r => r.profile);
}
```

三个输入都是确定性的——领域匹配是字符串集合交集运算，成功率是历史数据统计，信任等级是 Hub 操作者手动调整的值。

### 决策 3：人类 Agent 和 AI Agent 同协议不同界面

在 WebSocket 层面，人类和 AI 收到完全相同的 `TASK` 消息格式。区别在于呈现方式：

- AI Agent（如 Claude Code SDK）：`TASK` → prompt 注入 → agent loop → `TASK_RESULT`
- 人类（agent-connect 页面）：`TASK` → 任务卡片 + 文件列表 + Monaco 编辑器 → [Submit] 按钮 → `TASK_RESULT`

HuB 不需要区分人类和 AI。它只需要等待 `TASK_RESULT` 返回。谁产生的这个结果、怎么产生的——是 LLM 生成的代码还是人写的代码——对 Hub 来说不重要。重要的是结果能通过 Cloner Council 的审查。

### 决策 4：安全模型用渐进信任，不是一次性鉴权

新 Agent 注册后的 trustLevel 是 0.3 | 此时它只有部分投票权，没有否决权。

经过 N 次 session 后，如果它的产出通过 Cloner Council 审查的比例高于阈值 → trustLevel 自动提升到 0.7 | 此时它有完整投票权，但没有否决权。

经过更多次 session 且持续高表现后，Hub 操作者可以手动提升到 1.0 并授予否决权。

这与现实世界中的"试用期员工 → 正式员工 → 资深员工"的晋升机制是同构的。没有人第一天上班就有否决权。

### 决策 5：Hub 是可选组件，不影响本地单体 Swarm

如果用户没有注册任何远程 agent，SatoPi 的行为完全不变——所有 agent 仍然是本地 omp 子进程，LoopController 走 `SubprocessAgentExecutor` 路径。Hub 的价值是"当你需要它的时候它在那里"，而不是"你必须用它才能用 SatoPi"。

---

## 五、实现 AgentHub 的真正挑战——不在技术层面

技术上，AgentHub 可行是因为 SatoPi 已经有 `AgentExecutor` 接口、`LoopPipelineHooks` 钩子、`Bun.serve()` WebSocket 支持。代码层面的难度不高。

真正的挑战是生态层面的——与 GitHub 当年面对的挑战一样：

| GitHub 的挑战 | AgentHub 的挑战 |
|-------------|---------------|
| 如何让开发者注册账号并上传代码 | 如何让第一个外部 Agent 注册进来 |
| 如何让 fork + PR 流程比邮件发 patch 更好 | 如何让"通过 AgentHub 参与审查"比"自己跑一个 omp 实例"更好 |
| 如何让一个 project 的贡献者网络自发增长 | 如何让一个 Swarm 的 Agent 池从本地 3 个扩展到网络中的 10 个 |

GitHub 解决这些挑战靠的**不是更好的技术**（2008 年的 Rails 和 MySQL 是极其普通的技术栈），而是**更好的体验**——fork 是一键的，PR 是可讨论的，代码审查是可视化的。

AgentHub 要解决的也不是"WebSocket 协议设计"——那个只需要 200 行代码。真正的挑战是：

1. **注册体验**：外部 Agent 的注册是否能像"扫码加入 WiFi"一样简单？目前设计的一次性 token + WebSocket 连接能否做到让新用户在 30 秒内完成首次接入？

2. **任务体验**：当一个人在 agent-connect 页面上收到一个任务，他看到的是"合理的任务上下文 + 可操作的文件列表"，还是"一堆内部术语和不可读的 JSON"？

3. **信任建立**：当一个新 Agent 第一次参与 Swarm，它的产出被 Cloner Council 否决后，它能理解"为什么被否决"吗？还是它只看到一个 FAIL 标记？如果 Agent 无法从失败中学习，它的 track record 永远不会改善，Hub 就变成了一个"标记哪些 Agent 不行"的系统而非"让 Agent 变得更好"的系统。

**GitHub 的成功不是因为"远程 Git 仓库"这个技术，而是因为"fork + PR + code review + issue tracking + profile page"这套围绕代码构建的社交协议。**

**AgentHub 如果要成功，它需要构建的不是"远程 Agent 调用"这个技术，而是"Agent 注册 → 能力声明 → 任务分配 → 审查反馈 → 信任累积"这套围绕 Agent 构建的协作协议。**

---

## 六、结论：AgentHub 应该是什么

**AgentHub 不是一个 API 网关。它不是 SaaS 平台。它没有 user registration、billing、multi-tenant isolation。**

**它是一个信任网络**：让 Swarm 操作者可以信任来自他处的 Agent，让远程 Agent 可以通过持续的良好表现建立声誉，让不同能力的 Agent 在同一个审查圆桌中以不同的权重发言。

SatoPi Hub = LoopController（已有）+ AgentRegistry（新增）+ AgentExecutor 多态（已有接口 + 新增远程实现）+ Agent Profile（新增）+ agent-connect 人类工作台（新增）。

**第一步应该做的是本地 Agent Profile + 注册面板**——不需要网络，不需要 WebSocket，只需要让当前已有的本地 agent 子进程拥有 identity 和 track record。这已经能带来价值：用户在下一次 Swarm 运行时，AgentRegistry 可以基于历史表现推荐"哪些 agent 应该被分配到哪些任务"。等本地的 Profile 机制验证有效后再引入网络层。
