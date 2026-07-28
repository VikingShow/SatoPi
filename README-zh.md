<p align="center">
  <img src="assets/hero.png" alt="SatoPi — Satori a team of Pi" width="320">
</p>

<p align="center">
  <strong>Satori a team of Pi</strong> — 多 Agent 群体协作系统，圆桌辩论驱动。
</p>

<p align="center">
  <a href="https://github.com/VikingShow/SatoPi"><img src="https://img.shields.io/badge/license-MIT-58A6FF?style=flat&colorA=222222" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

<p align="center">
  Fork 自 <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> — <em>目前能力最强的 Agent 终端。</em>
</p>

**40+** LLM 提供商 · **32** 个内置工具 · **14** 个 LSP 操作 · **28** 个 DAP 操作 · **~55k** 行 Rust 核心。

---

## SatoPi — Satori a team of Pi

**SatoPi**（悟り + Pi）— 「一群 Pi 智能体，通过集体思辨达成觉悟。」

名字捕捉了**悟り**（Satori，禅宗顿悟）的瞬间 — 一群 **Pi** 智能体通过结构化的圆桌辩论汇聚真理，如同群体智慧凝结为洞见。

Logo 三层含义：
- **圆（Circle）** — 圆桌会议与数学常数 π，核心的 Agent 运行时
- **金环（Golden ring）** — 涌现智慧之光
- **菩提葉（Bodhi leaf）** — 集体思辨中生长的觉悟

### 歌剧隐喻

SatoPi 将整个 Swarm 工作流建模为**三幕歌剧**：

```
Script（起草剧本）→ Stage（上台演出）→ Curtain（谢幕）
```

| 幕 | 阶段 | 描述 |
|----|------|------|
| **Script** 起草剧本 | `script` → `script-debate` → `script-confirm` | 苏格拉底式对话澄清任务需求，然后多 Agent 圆桌辩论将计划精炼到 `.stp/plan.md` |
| **Stage** 上台演出 | `stage` ⇄ `paused` / `blocked` | Agent 从 DAG 任务队列认领任务并行执行，通过 Stigmergy（环境标记）和 IRC（直接通信）协调 |
| **Curtain** 谢幕 | `curtain` → `idle` | 经验提取、根因分析、反思 — 经验教训持久化供后续运行使用 |

状态机严格执行此流转：`idle → script → script-debate → script-confirm → stage ⇄ (paused | blocked) → curtain → idle`。非法转换被拒绝 — 阶段权威仅存在于后端。

SatoPi 在 stp 之上扩展了多 Agent Swarm 架构：**script** 阶段通过苏格拉底对话与圆桌辩论完成规划，**stage** 阶段让 Agent 并行执行 DAG 任务队列，**curtain** 阶段进行复盘分析。

---

## 核心设计

### 生命周期状态机

整个 Swarm 运行由一个显式状态转换表控制。每次状态变更通过 `StateTracker` + `ActivityLogger` + SSE 原子广播，确保后端与前端的阶段永远一致。

```
idle          空闲，等待任务输入
script        起草剧本 — Planner 进行苏格拉底式对话
script-debate 辩论 — 多 Agent 圆桌辩论精炼计划
script-confirm 确认 — 计划已完成，等待人工确认
stage          上演 — Agent 并行执行 DAG 任务队列
paused         暂停 — 人工暂停
blocked        阻塞 — 检测到停滞/死锁，等待人工决策
curtain        谢幕 — 复盘分析
```

### Agent 身份与信用系统

每个 Agent 拥有**跨运行持久化的身份档案**（`AgentProfile`），包含：

- **身份信息**：profileId、名称、原型（architect / implementer / reviewer / debugger / tester）
- **能力画像**：擅长领域、领域熟练度 (0-1)、特殊技能
- **信用记录**：信用分（0-100，初始 50）、任务完成率、赞扬/批评次数、违规记录（不可逆审计链）
- **社会关系**：合作者列表、被引用记录
- **任务统计**：平均完成时间、按领域统计、角色表现

**信用评分规则：**

| 事件 | 分数变化 |
|------|---------|
| 成功完成任务 | +3 |
| Reviewer 赞扬 | +5 |
| Reviewer 批评 | -5 |
| 轻微违规 (minor) | -5 |
| 严重违规 (major) | -20 |
| 致命违规 (critical) | -50 |

违规记录只增不减，形成完整审计链。3 次以上违规触发选择评分 0.7 倍惩罚，并在 prompt 中注入 `RESTRICTED` 警告。

### Agent 选择算法

```
baseScore = creditScore/100 × 0.4 + domainMatch × 0.3 + successRate × 0.2 + recency × 0.1
finalScore = baseScore × violationPenalty
```

领域匹配覆盖 9 个领域（frontend、backend、typescript、rust、python、devops、testing、security、data），使用模糊关键词分析。选择时保证至少 2 种不同原型。如果 Agent 不够，自动创建新 Profile。

### DAG 任务队列

从 `plan.md` 解析结构化任务，构建 DAG 依赖图：

```
任务状态：pending → ready（依赖全满足）→ in_progress（被认领）→ completed
                                                           → blocked（可动态创建 fix 任务）
```

- DFS 循环检测 + 拓扑排序验证
- 原子认领（先到先得），支持角色匹配优先
- 最短任务优先排序
- 支持动态添加任务（如 Reviewer 创建的修复任务）

### Stigmergy 环境标记

受蚁群算法启发 — Agent 不直接通信，而是通过在共享环境中留下信号来间接协调。五种 Mark 类型：

| 类型 | 语义 | 默认 TTL |
|------|------|---------|
| `lock` | 锁定文件/资源 | — |
| `claim` | 声明任务/文件责任 | — |
| `signal` | 传递意图/状态 | 10 分钟 |
| `artifact` | 标记完成的工作产物 | 30 分钟 |
| `warning` | 潜在冲突/风险预警 | 60 分钟 |

Mark 不可变 — 一旦创建不可修改，只能由创建者 forceRemove 或自然过期。惰性衰减 — 过期 Mark 在查询时自动清理，零定时器开销。

### 上下文卸载管道（OffloadPipeline）

```
L1 (WorkerSummarizer)
  └─ 对每个 Agent 的每轮产出生成结构化摘要

L1.5 (Deduplicator)
  └─ 跨迭代去重 + 任务边界检测

L2 (PlanNodeAttributor)
  └─ 将去重后的摘要归因到 plan.md 的具体节点

L3 (MermaidSynthesizer)
  └─ 生成 Mermaid 上下文图谱，注入 Agent prompt
```

---

## 开发

### 环境要求

**bun ≥ 1.3.14** · Rust nightly-2026-04-29

### 初始安装

```sh
git clone https://github.com/VikingShow/SatoPi.git
cd SatoPi
bun setup          # 安装依赖 + 编译 Rust 原生插件 + 链接 CLI
```

### Swarm 后端（端口 7878）

```sh
cd packages/coding-agent
bun run src/swarm/monitor/standalone.ts [workspace-dir]
```

### Swarm 前端（端口 5173）

```sh
cd packages/swarm-gui
bun run dev        # Vite HMR 开发服务器
```

### stp CLI（从源码运行）

```sh
bun dev            # 交互式 TUI
bun dev -- -p "list .ts files"  # 单次提示
```

### 检查与测试

```sh
bun check          # TypeScript + Biome + Rust 类型检查
bun test           # 完整测试套件（本地模式）
bun lint           # 代码检查
bun fmt            # 代码格式化
```

### 原生模块重编译

```sh
bun run build:native   # 修改 Rust crate 后重新编译 N-API 插件
```

---

## Swarm 配置

编辑 `.swarm-workspace/loop.yaml`：

```yaml
swarm:
  name: demo-swarm              # Swarm 名称
  model: deepseek-v4-pro        # 所有 Agent 的默认模型
  mode: loop                    # pipeline | parallel | sequential | loop
  agents: {}                    # 必填（loop 模式可为空）
  max_iterations: 5             # 最大审查重试迭代次数
  convergence_threshold: 2      # 连续相同发现即停止
  iteration_timeout_ms: 300000  # 每次迭代超时（默认 5 分钟）

  stage:                        # Stage（执行）阶段配置
    initial: 3                  # 初始 Agent 数
    min: 1                      # 最少 Agent
    max: 10                     # 最多 Agent
    auto: false                 # 自动分析 plan.md 复杂度
    max_rounds: 5               # 每轮迭代的商议轮次

  plan_debate:                  # 计划辩论配置
    enabled: true
    agent_count: 2              # 辩论参与 Agent 数
    max_rounds: 3               # 最多辩论轮次
    convergence_threshold: 2    # 连续相似 ≥85% 即收敛

  verification:                 # 循环后验证命令
    commands: ["bun test", "tsc --noEmit"]
    blocking: true              # 失败则重新进入 stage 循环

  offload:                      # 上下文卸载管道（需主动开启）
    enabled: false
    l1_trigger_threshold: 4

  mnemopi:                      # 语义记忆引擎（需主动开启）
    enabled: false
    top_k: 5

  stigmergy:                    # Stigmergy 环境标记
    enabled: false
    signal_ttl_ms: 600000

  agent_restrictions:           # Agent 工具限制
    worker:
      allowed: [read, write, edit, bash]
    reviewer:
      blocked: [bash, write]
```

---

## Script 阶段（起草剧本）

*「演出前，先写好剧本。」*

1. **开始规划** — 在聊天框输入任务，Planner Agent 开始苏格拉底式对话
2. **计划成型** — 需求足够清晰后 Planner 将计划写入 `.stp/plan.md`
3. **运行辩论** — 多 Agent 圆桌辩论进行多轮精炼，Jaccard 相似度检测收敛（≥85%）
4. **确认并启动** — 确认后转入 stage 阶段，并行启动 Agent 执行 DAG 任务队列
5. **取消** — 随时可中止

## 模型配置

模型从 `loop.yaml` 的 `swarm.model` 读取，适用于所有 Agent（planner、worker、reviewer），可随时更换：

```sh
sed -i 's/model: .*/model: YOUR-MODEL/' .swarm-workspace/loop.yaml
# 然后重启后端
```

前端不硬编码任何模型，始终从后端读取。

## 热更新

- **前端**：Vite HMR 代码变更自动热更新
- **后端**：需要手动重启（`kill & re-run`）
- **loop.yaml**：每次 `start()` 重新读取，改配置无需重启

## 关键文件

| 文件 | 用途 |
|------|------|
| `packages/coding-agent/src/swarm/` | 后端 Swarm 逻辑（~80 个 .ts 文件，15 个子目录） |
| `packages/swarm-gui/src/` | React 前端（Zustand + Tailwind + SSE 实时流） |
| `.swarm-workspace/loop.yaml` | Swarm 配置 |
| `.stp/plan.md` | Script 阶段生成的执行计划 |

## 架构总览

```
packages/coding-agent/src/swarm/
├── core/           状态机、DAG、收敛检测、阻塞检测、Schema
├── monitor/        HTTP REST API + SSE 事件流（端口 7878）
├── agent/          Agent 身份档案、选择算法、自动扩缩、角色资产
├── executor/       Agent 执行器、DAG 任务队列
├── script/         Script 阶段：规划器、辩论圆桌、复杂度分析
├── stage/          Stage 阶段：StageController、角色协商
├── coordination/   Stigmergy 环境标记、区域锁、文件追踪
├── offload/        上下文卸载管道（L1→L1.5→L2→L3）
├── curtain/        复盘：经验提取、反思、根因分析
├── hooks/          生命周期钩子、ActivityLogger（24 种事件类型）
├── channel/        Agent 间通信频道
├── session/        多会话管理、JSONL 持久化
└── render/         流式输出渲染

packages/swarm-gui/src/
├── stores/         Zustand 状态管理（swarm/session/config-store）
├── components/     监控页面、聊天视图、任务列表、Agent 拓扑图、
│                   通信矩阵、上下文面板、复盘面板等
├── lib/            SSE 客户端、REST API 客户端、类型定义
└── i18n/           中英文国际化
```

---

## 安装 stp

**macOS · Linux**

```sh
curl -fsSL https://omp.sh/install | sh
```

**Homebrew**

```sh
brew install can1357/tap/omp
```

**Bun（推荐）**

```sh
bun install -g @oh-my-pi/pi-coding-agent
```

**Windows (PowerShell)**

```powershell
irm https://omp.sh/install.ps1 | iex
```

---

## License

MIT. See [LICENSE](LICENSE).

© 2025 Mario Zechner
© 2025-2026 Can Bölük
