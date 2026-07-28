# SatoPi 全维度综合审视报告

> 日期: 2026-07-28
> 范围: 全量代码库（12 个 packages + 8 个 crates）
> 方法: 10 个并行 Agent 分别探查 10 个维度，主 Agent 交叉分析
> 基础: 已有 `satopi-comprehensive-review-2026-07-27.md`（swarm 专项）不复读

---

## 执行摘要

本次审视覆盖工程设计、架构设计、完全性、CLI 用户交互、TUI 一致性、测试策略、错误处理与资源管理、构建 CI、安全沙箱、文档 DX 共 10 个维度。发现 **5 个跨维度系统性问题**，按严重度排序：

| # | 系统性问题 | 严重度 | 影响维度 |
|---|-----------|--------|---------|
| 1 | **Mega-File 三巨头** — agent-session (655KB/17K行), sdk.ts (135KB/3.3K行), interactive-mode.ts (169KB/5K行) 形成维护瓶颈 | P1 | 工程、架构、TUI、测试 |
| 2 | **双执行路径未收敛** — v3 AgentRuntime.spawn vs legacy runSubprocess 并存，部分已迁移、部分仍在双轨 | P1 | 架构、完全性、测试 |
| 3 | **TUI 双主题体系** — 主 TUI (satopi.json) 与 Swarm Dashboard (chalk.hex) 使用独立的颜色/样式系统 | P2 | TUI、UX、架构 |
| 4 | **安全纵深不足** — 无 OS 级沙箱、明文凭证存储、prompt injection 向量未系统防护 | P2 | 安全、架构、资源 |
| 5 | **文档过剩但缺乏架构地图** — 100+ docs 文件但无 ARCHITECTURE.md，新开发者无导航 | P2 | 文档、架构、工程 |

---

## 第一章：各维度发现摘要

### 1.1 工程设计与代码质量（EngQualityScout）

**核心发现：**
- **agent-session.ts**（654.8KB, ~17,000行）：承担约 20 种职责（模型解析、compaction、bash 执行、session 持久化、advisor 管理、async job、plan mode、rate limit、LSP 集成…），是典型的上帝对象。前三提取目标：advisor 管理（~800行）、compaction 编排（~600行）、prewalk 编排（~250行）。
- **sdk.ts**（135KB, 3,283行）：集 barrel re-exporter、session 启动器、工具注册管道、MCP 生命周期、system prompt 构建于一身，无统一主题。
- **interactive-mode.ts**（168KB, 4,984行）：混合 TUI 初始化、输入控制链、loop-mode 状态机、goal-mode、session 切换、slash command、HUD 渲染、theme 管理等 ~10 种职责。
- **tools/ 目录 DRY 良好**：工具文件遵循一致的 `AgentTool` 接口模式，`#private` 字段使用规范。但 `read.ts`（3,614行）自身有结构膨胀。
- **AGENTS.md 合规度**：tools/ 目录 `#private` 完美遵守；`await import()` 多为合法 lazy-loading；barrel exports 模式基本合规。

**评级：** P1 — 三巨头文件阻碍所有后续重构。

### 1.2 架构设计（ArchScout）

**核心发现：**
- **子系统边界清晰**：session/ 独立核心，swarm/ 内部耦合但不引入 session/tools/modes，tools/ 是中央枢纽。
- **双路径状态**：stage/、script/、curtain/、core/pipeline/ 已迁至 AgentRuntime.spawn()；但 executor/ 默认走 runSubprocess（AgentRuntime 为可选覆盖）；render/streaming.ts 仅 legacy 路径。
- **oh-my-pi 耦合**：12 个 `@oh-my-pi/*` 依赖，其中 pi-utils 为高扇出工具包。
- **Rust-TS 桥接**：单 napi cdylib（pi-natives）封装 6 个内部 crate + ~40 个 vendored uutils，桥接层干净。
- **工具调用数据流**：LLM response → agent-session (tool_execution_start) → event-controller (ToolExecutionComponent) → 工具执行 → agent-session (tool_execution_end) → TUI 渲染，事件驱动管道清晰。
- **死引用**：`role-roundtable.ts` 引用了不存在的 `../comm-bus/roundtable` 模块。

**评级：** P1 — 架构骨架好，但双路径残留 + 三巨头的内部分解未完成。

### 1.3 完全性（CompletenessScout）

**核心发现：**
- **1 个明确 stub**：`runSwarmResume`（`cli/swarm-cli.ts:413`）打印 "not yet implemented" 即退出。
- **4 个 TODO/FIXME**：
  - graph-runner-as-run-manager.ts:15 — resume() 未实现
  - node-behavior.ts:201 — persistent agent IRC steering 未实现
  - stage-controller.ts:339 — roundtable role negotiation 未实现
  - role-provider.ts:73 — profile-based role source 未实现
- **2 个 schema-vs-code 断层**：`roundtablePrompt` 和 `agentTimeoutMs` 在 schema 中定义但代码从未消费。
- **1 个 dead export**：`getSessionStpDir`（plan-paths.ts:32）被导出但无 consumer。
- **collab-web** 无 swarm 专用组件。

**评级：** P2 — 存量的 stub/TODO 不多，但 profile-based role、roundtable negotiation、persistent agent steering 三个 TODO 是 swarm 核心能力缺口。

### 1.4 CLI 用户交互（UXCliScout）

**核心发现：**
- **32 个命令**，2 个别名，结构规范。
- **P1：Ctrl+C 键位冲突** — TUI 中用 Ctrl+C 做 copy，与终端默认的 SIGINT 语义冲突。
- **P2：`--json` flag 不一致** — 不同命令的 JSON 输出 flag 使用 `-j`、`--json` 或无，无统一规范。
- **P2：错误消息格式漂移** — 4 种以上前缀变体（`error:`、`[ERROR]`、`ERROR:`、无前缀），混用 stderr 和 stdout。
- **P2：无 `--quiet`/`--verbose` 统一 flag**。
- **P2：无共享进度指示器** — dry-balance-cli 有 spinner，但其他命令各自实现或缺失。
- **好消息**：全局 flag 解析（`--profile`、`--cwd`、`--model` 等）一致，Command class 模式的惰性加载规范。

**评级：** P2 — 功能表面完整，但 flag 命名和错误格式缺乏工程约束。

### 1.5 TUI 一致性（TuiScout）

**核心发现：**
- **Sanitization 覆盖率高（95%+）**：`replaceTabs`、`truncateToWidth`、`shortenPath` 在 37+ 处调用，无明显遗漏。
- **硬编码 ANSI escape**：8 个文件直接写 `\x1b[...`（segment-track、diff、welcome、user-message、status-line/*、move-overlay、collab-prompt-message），绕过主题抽象。
- **Swarm Dashboard 独立主题**：使用 `chalk.hex()` 构建，颜色值与 `satopi.json` 手动对齐但无机制保证一致。边框风格（sharp box-drawing）与主 TUI 的圆角风格不一致。
- **Component 模式偏重**：~49 个 Component class vs ~8 个纯函数，简单无状态渲染被迫走 class 模板。
- **工具 renderer 模式一致但细节分化**：统一的 `ToolRenderer` 接口，但 `framedBlock` vs `raw Text` 的包裹方式不一致，preview 常量部分重复定义。

**评级：** P2 — 双主题体系是最大结构性问题。

### 1.6 测试策略（TestingScout）

**核心发现：**
- **15/16 packages 有测试**：`packages/web` 缺失测试（且无 test script）。
- **零 `mock.module()` 违规** — 全局遵守 AGENTS.md 禁令。
- **强 spyOn 纪律**：`vi.spyOn()` + `vi.restoreAllMocks()` in `afterEach`。
- **大量真实对象集成测试**：~50+ 文件直接 `new Agent()` / `new AgentSession()`。
- **CI 分区合理**：`ci-test-ts.ts` 将 coding-agent 测试按路径+内容拆分为 5 个 bucket。
- **缺失**：无属性测试（property-based）、无混沌/错误注入测试。

**评级：** P2 — 覆盖广、纪律好，但缺 web 包测试 + 高级测试技术。

### 1.7 错误处理与资源管理（ErrorResourceScout）

**核心发现：**
- **总体纪律良好**：389+ 个 catch 块遵循分层模式（类型守卫 → 日志吞没 → 裸吞没）。
- **2 个无守卫 fire-and-forget IIFE**：`rpc-client.ts:273` (JSONL reader)、`bash-interactive.ts:333` (flushOutput)。
- **2 个隐式 AbortController 清理问题**：`collab/guest.ts:626`、`eval/kernel-base.ts:525`。
- **背压控制缺失**：SSE/JSONL/batch output 流无消费者信令，仅 `collab/relay-client.ts` 有 64KB 阈值 + drain timer。
- **agent-session.ts dispose 质量好**：~15 种资源类型按序清理，各有独立 try/catch 守卫。

**评级：** P2 — 基线好，少量泄漏点可修。

### 1.8 构建与 CI（BuildCiScout）

**核心发现：**
- **CI 完备**：`ci.yml` 14 个 job（native artifact cache、并行 TS test bucket、5 平台 binary release、完整 release chain）。
- **packages/web 无 test script**（P0 gap）。
- **packages/stats 无 test script**（P1 gap）。
- **Rust 测试折叠在 native build 中**，无独立 job。
- **binary-build.yml 与 ci.yml 有重复的 binary release job**。
- **Dockerfile 依赖 BuildKit 1.7-labs** (`COPY --parents`)。
- **Native addon 映射清晰**：pi-natives 为唯一 cdylib，依赖 6 个内部 crate + ~40 个 vendored uutils。

**评级：** P2 — 整体运转良好，web/stats 的测试缺口需补。

### 1.9 安全与沙箱（SecurityScout）

**核心发现：**
- **无 OS 级沙箱**：bash 工具依赖审批门控（CRITICAL_BASH_PATTERNS）+ 命令拦截器（bash-interceptor），但没有 seccomp/namespace/cgroup 隔离。
- **浏览器隔离**：Worker 线程级隔离（tab-supervisor），非进程级，`--no-sandbox` flag 在使用。
- **调试器**：DAP adapter 以子进程运行但无额外隔离。
- **明文凭证**：`SqliteAuthCredentialStore` 将 API key 和 OAuth token 明文存储在 SQLite 中。
- **Prompt injection 向量**：`auto-thinking/classifier.ts`、`autoresearch/index.ts`、`advisor/watchdog.ts` 通过 `prompt.render()` 将用户输入直接注入系统 prompt，无转义。
- **好消息**：审批门控（approval-gating）完善，bash 拦截器可配置，凭证轮换（round-robin）支持。

**评级：** P2 — 审批层好，纵深防御缺失。

### 1.10 文档与开发者体验（DocsDxScout）

**核心发现：**
- **15 个 package 全有 README**，质量高。
- **无 ARCHITECTURE.md**：最接近的替代品是 `docs/architecture-audit-2026-07-27.md`（问题清单），不是架构地图。
- **100+ docs 文件**，mtimestamp 集中在 1 天前（批量审计产物），时效性参差。
- **AGENTS.md 规则遵守**：`#private` 使用度 ~95%，barrel exports 模式基本合规。但 `await import()` 使用量大（虽合法）。
- **CONTRIBUTING.md** 极简（仅 vouch 流程），**DEVELOPMENT.md** 详实（11.8KB）。

**评级：** P2 — 文档量充足但缺少结构化导航入口。

---

## 第二章：系统性问题（跨维度）

### SP-1: Mega-File 三巨头 [P1]

| 文件 | 行数 | 职责数 | 阻塞维度 |
|------|------|--------|---------|
| `session/agent-session.ts` | ~17K | ~20 | 工程、架构、测试、资源 |
| `sdk.ts` | ~3.3K | ~5 | 工程、架构 |
| `modes/interactive-mode.ts` | ~5K | ~10 | 工程、架构、TUI、UX |

**跨维度影响：**
- **工程**：任何改动都需遍历巨型文件的上下文，新人上手成本极高。
- **测试**：agent-session 的单元测试必须 mock 大量无关依赖，真实对象集成测试权重过大。
- **TUI**：interactive-mode.ts 混合渲染逻辑与业务状态机，UI 改动牵一发而动全身。
- **架构**：三巨头形成事实上的"核心球"（big ball of mud core），违反单一职责。

**建议分解路径：**
1. `agent-session.ts` → advisor-runtime.ts + compaction-manager.ts + prewalk-orchestrator.ts（参考 swarm 长期规划 Phase 2.2）
2. `sdk.ts` → 拆分为 barrels/sdk-re-exports.ts + session/bootstrap.ts + tools/registration.ts + mcp/lifecycle.ts
3. `interactive-mode.ts` → 按模式拆分：loop-controller.ts + goal-controller.ts + slash-handler.ts + hud-renderer.ts

### SP-2: 双执行路径未收敛 [P1]

**现状矩阵：**

| 调用方 | 使用路径 | 状态 |
|--------|---------|------|
| `swarm/stage/stage-controller.ts` | AgentRuntime.spawn() | ✅ 已迁移 |
| `swarm/script/script-manager.ts` | AgentRuntime.spawn() | ✅ 已迁移 |
| `swarm/core/pipeline.ts` | AgentRuntime.spawn() | ✅ 已迁移 |
| `swarm/executor/executor.ts` | runSubprocess（默认） | ❌ legacy 优先 |
| `swarm/render/streaming.ts` | runSubprocess only | ❌ 仅 legacy |
| `swarm/script/debate-roundtable.ts` | 双轨（fallback） | ⚠️ 有条件双轨 |

**跨维度影响：**
- **架构**：两条路径的 context assembly、工具注入、错误处理各不相同，subtle bugs。
- **完全性**：render/streaming.ts 无 v3 路径，v3 agent 的流式输出不可见。
- **测试**：v3 路径的集成测试覆盖不足，legacy 路径的 e2e 依赖 runSubprocess。

### SP-3: TUI 双主题体系 [P2]

**主 TUI**：satopi.json → Theme interface → 动态主题切换

**Swarm Dashboard**：sato theme → chalk.hex() 包装 → 静态颜色

**不统一之处：**
- 边框风格：swarm 使用 `┌─┐│└┘`（sharp），主 TUI 使用 `╭─╮│╰╯`（round）
- 颜色源：swarm 绕过 Theme 接口，硬编码 hex 值
- 列宽自适应：swarm 手动 `width > 100 ? 60 : 0`，主 TUI 由引擎驱动

**跨维度影响：**
- **TUI**：每次主题变更需同步更新两个系统
- **UX**：半屏 dashboard 与全屏 TUI 视觉语言不一致
- **架构**：违反了"单一主题源"原则

### SP-4: 安全纵深不足 [P2]

**三层防御评估：**

| 层 | 现状 | 完备度 |
|----|------|--------|
| 审批门控 | CRITICAL_BASH_PATTERNS、bash-interceptor、approval tool | ✅ 强 |
| 进程隔离 | Worker 线程级（browser）、无隔离（bash）、子进程（debug） | ⚠️ 弱 |
| 数据保护 | SQLite 明文凭证、prompt 无转义注入用户内容 | ❌ 缺失 |

**跨维度影响：**
- **安全**：攻击面清晰，bash/browser/debug 均可直接操作文件系统
- **架构**：缺少安全边界抽象层，sandbox 机制混杂在各工具中
- **资源**：无隔离意味着一个工具的 OOM 可拖垮整个进程

### SP-5: 文档量过剩但架构地图缺失 [P2]

**现状：**
- 100+ docs 文件，但 95% 是审计/计划/分析产物（单次消耗）
- 无 `ARCHITECTURE.md` 描述子系统关系、数据流、边界
- 无包级别的职责说明文档
- `CONTRIBUTING.md` 仅覆盖 vouch 流程

**跨维度影响：**
- **文档**：有量无结构，搜索负担重
- **架构**：设计意图未固化为文档，依赖口头/代码传承
- **工程**：新开发者需从零阅读代码才能建立心智模型

---

## 第三章：优先级路线图

### 立即（P0 — 阻塞级）
无。当前无阻塞级问题。

### 短期（P1 — 1-2 周）

| 行动 | 关联 SP | 预估工时 |
|------|---------|---------|
| agent-session.ts 职责拆分（advisor + compaction + prewalk 提取） | SP-1 | 4h |
| sdk.ts 按关注点拆分 | SP-1 | 3h |
| executor.ts 默认切至 AgentRuntime.spawn，废弃 runSubprocess | SP-2 | 3h |
| render/streaming.ts 增加 v3 路径 | SP-2 | 2h |

### 中期（P2 — 2-4 周）

| 行动 | 关联 SP | 预估工时 |
|------|---------|---------|
| swarm dashboard 主题接入主 Theme 系统 | SP-3 | 4h |
| 硬编码 ANSI escape 替换为 Theme token | SP-3 | 2h |
| 后端 credential 加密（libsodium 或 OS keychain） | SP-4 | 3h |
| 用户内容注入系统 prompt 前增加 sanitize 层 | SP-4 | 1h |
| 编写 ARCHITECTURE.md | SP-5 | 3h |
| packages/web + packages/stats 补充 test script | — | 2h |
| CLI `--json` flag 统一 + 错误消息格式规范 | — | 2h |

### 长期（P3 — 1-3 月）

| 行动 | 关联 SP | 备注 |
|------|---------|------|
| interactive-mode.ts 按模式拆分 | SP-1 | 复杂度高，需充分回归 |
| OS 级沙箱（bubblewrap/firejail 集成） | SP-4 | 依赖部署环境 |
| 属性测试 + 混沌测试引入 | — | 先建框架，逐步覆盖 |
| prompt.render() 安全审计 + 模板引擎加固 | SP-4 | 需确定注入模型 |

---

## 附录 A：探查报告索引

| 报告 | 维度 | 产出形式 | 关键评级 |
|------|------|---------|---------|
| `agent://EngQualityScout` | 工程设计 | task output | P1 三巨头 |
| `agent://ArchScout` | 架构设计 | task output | P1 双路径 |
| `agent://CompletenessScout` | 完全性 | task output | P2 5个gap |
| `agent://UXCliScout` | CLI 交互 | task output | P1 键位冲突 |
| `agent://TuiScout` | TUI 一致性 | task output | P2 双主题 |
| `agent://TestingScout` | 测试策略 | task output | P2 缺web |
| `agent://ErrorResourceScout` | 错误/资源 | task output | P2 少数泄漏 |
| `agent://BuildCiScout` | 构建CI | task output | P2 缺test |
| `agent://SecurityScout` | 安全沙箱 | task output | P2 明文凭证 |
| `agent://DocsDxScout` | 文档DX | task output | P2 缺架构图 |

---

## 附录 B：已有相关文档

| 文档 | 作用 | 与本次报告关系 |
|------|------|-------------|
| `docs/satopi-comprehensive-review-2026-07-27.md` | swarm 专项深层审计（54 issue） | 互补 — 本次聚焦非 swarm 维度 |
| `docs/satopi-long-term-plan-2026-07-27.md` | swarm 六阶段路线图 | SP-1/SP-2 的部分行动已在此路线图中 |
| `docs/theatre-audit-report.md` | 嵌入式 swarm 执行链路审计 | 确认 swarm 端到端通路可用 |
| `docs/swarm-architecture-v3.md` | v3 六层统一架构设计文档 | SP-2 的收敛目标 |

---

## 附录 C：数据快照

| 指标 | 数值 |
|------|------|
| TypeScript 源文件总数 | ~1,500+ |
| 最大文件 (agent-session.ts) | 654.8KB / ~17,000 行 |
| 第二大文件 (interactive-mode.ts) | 168.7KB / ~5,000 行 |
| 第三大文件 (sdk.ts) | 135.1KB / ~3,283 行 |
| Packages 总数 | 16 |
| Rust crates 总数 | 8 (+ ~40 vendored uutils) |
| 测试目录数 | 15 (1 缺失: web) |
| mock.module 违规 | 0 |
| CLI 命令数 | 32 + 2 aliases |
| 硬编码 ANSI escape 文件 | 8 |
| 未守卫 fire-and-forget IIFE | 2 |
| oh-my-pi 直接依赖 | 12 |
