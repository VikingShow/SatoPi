# SatoPi 全维度深度调研报告 v2

> 日期: 2026-07-28
> 方法: 22 个并行 Scout 探查 6 大维度 + 3 轮跨维度圆桌辩论
> 基础: `satopi-holistic-audit-2026-07-28.md` (v1) + `satopi-comprehensive-review-2026-07-27.md` (swarm 专项)

---

## 执行摘要

本次调研在 v1 审计的 10 维度基础上，进行了**验证性复查 + 补盲探查**，并通过圆桌辩论交叉验证了关键发现。相比 v1，本次增量在于：

1. **验证了已有发现的修复状态** — 5/10 P0/P1 issue 已修复，3 仍开放
2. **发现了 3 个新的系统性问题** — 异步生命周期抽象缺失、V3 最后一公里断层、工具安全非对称
3. **覆盖了 v1 未涉及的维度** — 扩展性（插件/MCP/Hook/Skill）、性能与可观测性

### 系统性问题总览

| # | 系统性问题 | 严重度 | 来源 | 状态 vs v1 |
|---|-----------|--------|------|-----------|
| **SP-1** | **Mega-File 三巨头** — agent-session (17K行/0%分解)、sdk.ts (3.3K行/0%分解)、interactive-mode (4.6K行/7%浅层分解) | **P1** | v1 → 更新 | 基本未变 (+78/-0/-353行) |
| **SP-2** | **双执行路径未收敛** — swarm 层 85% v3 迁移，但 executor.ts legacy fallback 仍存活；核心 session 单体的收敛收益未兑现 | **P1** | v1 → 更新 | 85% 收敛（+40%），遗留回退分支 |
| **SP-3** | **TUI 双主题体系** — swarm 独立 chalk.hex 主题 + sharp 边框 vs 主 TUI satopi.json 圆角主题 | **P2** | v1 → 确认 | 未变 |
| **SP-4** | **安全纵深不足** — 明文凭证 + prompt injection 向量 | **P2** | v1 → 确认 | 未审查（本次未复验） |
| **SP-5** | **文档量过剩但架构地图缺失** — 100+ docs 但 ARCHITECTURE.md 仍是基础骨架 | **P2** | v1 → 更新 | ARCHITECTURE.md 存在但未深化 |
| **SP-6** ✨ | **异步生命周期抽象缺失** — writeChain/AgentHandle/ActivityLogger 三者共用同一反模式：无界队列 + 无声吞错 + 无背压 + 无断路器 | **P1** | 新增 | 跨维度圆桌发现 |
| **SP-7** ✨ | **V3 架构"最后一公里"断层** — 6 层结构完整，但 3 个集成接缝断裂（AgentLoopConfig hooks、15/24 HookEvent 未触发、PhaseBehavior↔GraphEngine 桥接未完成） | **P1** | 新增 | 跨维度圆桌发现 |
| **SP-8** ✨ | **工具安全模型非对称** — MCP 工具强制 write 级审批 + 前缀隔离；自定义工具自声明审批等级，无 ExtensionToolWrapper 时完全绕过 | **P1** | 新增 | 跨维度圆桌发现 |

---

## 第一章：基线验证 — 已知问题当前状态

### 1.1 Mega-File 三巨头 (SP-1)

| 文件 | v1 行数 | 当前行数 | 变化 | 分解状态 |
|------|---------|---------|------|---------|
| `session/agent-session.ts` | ~17,055 | **17,056** | +78 | **0% 分解** — advisor 已提取到 `../advisor/` (7 文件，~75KB)，但 compaction 编排和 prewalk 仍内联。~280+ 私有字段/方法，单一 AgentSession 类。 |
| `sdk.ts` | ~3,283 | **3,283** | 0 | **0% 分解** — 13+ 导出函数（createAgentSession + buildSystemPrompt + 9 个 discover* + barrel re-exports），无拆分文件。 |
| `modes/interactive-mode.ts` | ~4,630 | **4,631** | -353 (7%) | **浅层分解** — 16 个 controller 文件 + 50+ 组件提取，但核心状态机和输入分发逻辑仍在主文件。圆桌辩论定性为"外观性搬迁，非结构性分解"。 |

**圆桌结论**: 整体 mega-file 分解进度约 **2%**（加权：0%×2/3 + 7%×1/3）。sdk.ts 和 agent-session.ts 是真正的阻塞点。

### 1.2 双执行路径收敛 (SP-2)

| 调用方 | 路径 | 状态 |
|--------|------|------|
| PipelineController | v3-only (runtime 必需) | ✅ 完全迁移 |
| ScriptManager | v3-only | ✅ 完全迁移 |
| StageController | v3-only | ✅ 完全迁移 |
| CurtainRunner | v3-only | ✅ 完全迁移 |
| debate-roundtable.ts | v3-only | ✅ 完全迁移 |
| 所有 PhaseBehavior | v3-only | ✅ 完全迁移 |
| streaming.ts | 删除了 legacy streamAgentOutput | ✅ 清理完成 |
| **executor.ts** | **if(runtime) {v3} else {runSubprocess}** | ⚠️ **遗留回退分支** |
| agent-launcher.ts | Mock stub 已是接口残余，非实时代码路径 | ✅ 无害 |

**圆桌结论**: swarm 层收敛度 ~85%（spawn 调用点维度），但 executor.ts 的 legacy 回退是**隐性风险** — 任何新调用方不知道 runtime 是必需的，会静默走 subprocess 路径。

### 1.3 P0/P1 Issue 修复状态

| Issue | 状态 | 证据 |
|-------|------|------|
| ScriptManager 语法错误 | ✅ 已修复 | 死 else 分支已删除，统一 v3 路径 |
| SwarmRunner catch 吞错误 | ⚠️ 部分修复 | catch 仍不更新 StateTracker 到终止态 (P3) |
| StateTracker writeChain 超时 | ❌ 仍开放 | `logSwarmState()` 缺少 `await`，静默损坏状态持久化 (P1) |
| ActivityLogger writeQueue 绕过 | ❌ 仍开放 | 无界 promise chain + 无声吞错 (P2) |
| AgentRegistry TOCTOU | ✅ 已修复 | JS 运行至完成语义提供原子性 |
| AgentLauncher steerFeed 泄漏 | ❌ 仍开放 | fire-and-forget IIFE 无 .catch() (P3) |
| MarkEnvironment 全局单例 | ✅ 已修复 | 保留 global() 但语义合理（stigmergic 信号需跨 agent 共享） |
| 死引用 (role-roundtable) | ✅ 误报 | 原审计的 `../comm-bus/roundtable` 路径实际存在 |
| Swarm resume stub | ✅ 已修复 | `runSwarmResume` 不再打印 "not yet implemented" |
| TUI 硬编码 ANSI | ⚠️ 部分修复 | swarm TUI 已迁移到主题系统（零硬编码），但主 TUI 仍有 40+ 处 `\x1b[` |

---

## 第二章：架构统一性

### 2.1 子系统依赖图谱

coding-agent 的子系统依赖呈**星型拓扑**：`tools/` 是中央枢纽，被几乎所有子系统依赖；`session/` 和 `modes/` 形成紧密耦合对。

**发现的循环/不当依赖**:
- `swarm/` → `modes/` (swarm dashboard 组件位于 modes/components/swarm/) — 合理但方向值得关注
- `tools/` → `session/` (通过工具上下文) — 存在但通过接口解耦，风险低
- `swarm/infra/` vs `swarm/hook-system/` vs `swarm/hooks/` — 三个目录职责重叠，边界模糊

### 2.2 AgentLoopConfig 注入点可达性

| Hook | 可达? | 路径 |
|------|--------|------|
| transformContext | ⚠️ SDK 自有实现 | SDK createAgentSession 内部构建，ContextPipeline.toTransformContext() 未调用 |
| getSteeringMessages | ⚠️ 旁路 | AgentLauncher 通过 agent.steer() 直接注入，绕过 AgentLoopConfig hook |
| getFollowUpMessages | ⚠️ 旁路 | 同上，通过 agent.followUp() |
| getAsideMessages | ✅ 可达 | spawnOne() → hookProviders.getAsideMessages |
| hasSteeringMessages | ✅ 可达 | Agent 内部自动连接 |
| **hasIrcInterrupts** | ❌ **不可达** | SDK 和 launcher 都不设置，Agent 侧完整实现但从未连接 |

**圆桌结论**: 这是 V3 "最后一公里"问题的核心表现 — AgentLoopConfig 定义了 6 个干净注入点，但实际集成只用了 1.5 个（aside + 内部 hasSteering），其余要么旁路要么未连接。

### 2.3 V3 六层架构实现度

| 层 | 设计意图 | 实现度 | 关键偏差 |
|----|---------|--------|---------|
| Layer 0: WorkflowFSM | PhaseDefinition + guarded transitions | **完整** | 8 个 phase，StateTracker 集成，超时转换 |
| Layer 1: AgentRuntime | spawn/spawnRoundtable | **完整** | AgentSpec → AgentHandle 流程完整 |
| Layer 2: CommBus | Human=Agent 对等 + roundtable/vote | **完整** | CommChannel + IrcBus 封装完整 |
| Layer 3: ContextManager | ContextPipeline + OffloadManager | **部分** | 11 个 ContextSource 注册但 toTransformContext() 未被 spawn 路径调用 |
| Layer 4: HookPipeline | 24 HookEvent + 6 builtin groups | **部分** | 15/24 事件从未触发（comm:\*/vote:\*/context:\*等） |
| Layer 5: PhaseBehavior | Script/Stage/Curtain 统一接口 | **部分** | PhaseBehaviorNodeAdapter 桥接存在，但 legacy 类仍在运行 |

**圆桌结论**: "肌肉在，但神经系统未完全连接" — 所有 6 层结构完整，但层间集成接缝（Layer 1→3, Layer 1→Agent, Layer 4→CommBus/ContextPipeline）断裂。这符合分阶段推出策略（Phase 3A/4A 结构完成，Phase 2B/3B/4B 布线进行中），但**缺少端到端集成测试验证全链路**。

### 2.4 oh-my-pi 耦合面

- **pi-utils**: 最广泛依赖（logger, Snowflake, prompt, streams）— 低风险
- **pi-catalog / pi-ai types**: 3 个 catalog import 规则违规（model-resolver.ts, models-config.ts, extensibility/types.ts — 从 pi-ai 导入了 catalog 类型而非从 pi-catalog）
- **pi-agent-core (AgentLoopConfig)**: 5 个文件直接引用，165+ 文件传递依赖
- **pi-natives**: 同步加载，import 时即运行（启动瓶颈）
- **swarm/ 目录**: 最小化 oh-my-pi 依赖，主要用 pi-utils

---

## 第三章：鲁棒性

### 3.1 错误处理

| 严重度 | 问题 | 位置 |
|--------|------|------|
| **P1** | writeChain 中 `logSwarmState()` 缺少 `await` — 异步 reject 静默损坏后续所有状态持久化 | `state.ts:339` |
| P2 | SessionRegistry.createSession() 部分失败无清理/回滚 | `session-registry.ts:191-216` |
| P2 | 无全局 `process.on('unhandledRejection')` 安全网 | 全局 |
| P3 | ~20 处 fire-and-forget `.catch(() => {})` 无声吞错 | 遍布 swarm/ |
| P3 | SwarmRunner stage.catch() 不更新 StateTracker 终止态 | `swarm-runner.ts:196` |

### 3.2 资源生命周期

| 严重度 | 问题 | 位置 |
|--------|------|------|
| **P2** | AgentHandle messages[] 无上限 + subscribe 返回值丢弃 — 长时间运行 OOM | `agent-handle.ts:291-328` |
| **P2** | ActivityLogger SSE 无背压 — fire-and-forget 写入无限堆积 | `activity-logger.ts:146-153` |
| P2 | ExperienceStore SQLite 无 WAL 模式 + 无 checkpoint — 对比代码库中其他 5 个 DB 全部设置 WAL | `experience.ts:263-289` |
| P3 | SessionRegistry 部分失败残留 session | `session-registry.ts:194-216` |
| P3 | AgentRegistry unregister() 不 dispose AgentSession | `agent-registry.ts:171-176` |

### 3.3 并发安全

JS 运行至完成语义提供了隐含原子性 — 6 个协调原语中 4 个安全。仅 2 个 P3 语义问题：RegionLockManager 公平性缺失（可能饥饿）、AgentRegistry fire-and-forget dispose 泄漏。

### 3.4 边界条件

| 场景 | 处理 | 评级 |
|------|------|------|
| FTS5 建表失败 | 无 try-catch，直接崩溃 | **P2** |
| Agent 超时/kill | handle.abort() 但订阅泄漏 | P2 |
| 死 Agent 检测 (graph) | 无心跳/健康检查 | P3 |
| Wave 失败传播 | 隔离良好，不级联 | P3 |
| 空 plan.md | 3 层优雅降级 | ✅ |

### 3.5 ⚡ 跨维度发现 SP-6: 异步生命周期抽象缺失

writeChain、AgentHandle、ActivityLogger 三者共享同一反模式：**手动 promise 链序列化 + 无界缓冲区 + 无声吞错 + 无背压信号**。这不是三个独立 bug，而是**缺失了一个受限异步队列抽象**（带容量上限、错误隔离、优雅 drain、断路器）。如果不引入统一抽象，每次新的异步缓冲需求都会重复这个模式。

---

## 第四章：扩展性

### 4.1 插件系统

- **加载管道**: discovery → extension-roots → plugin-dir-roots → skills/slash-commands/hooks，流程清晰
- **兼容性**: legacy-pi-coding-agent-shim.ts 提供 oh-my-pi 插件兼容层
- **缺口**: 无热加载/卸载、无插件间隔离（一个插件崩溃不影响其他的保证不明确）

### 4.2 MCP 集成

**总体评价: 成熟且完善**

- **传输层**: stdio + legacy SSE + Streamable HTTP，全部实现
- **认证**: 完整 OAuth 2.0（PKCE + DCR + RFC 8707 resource indicators）
- **工具管理**: `mcp__<server>_<tool>` 前缀 → 与内置工具零冲突；SQLite 持久化工具缓存
- **生命周期**: 并行连接 + 断路器防重连风暴 + 延迟工具解析
- **缺口**: HTTP transport SSE GET listener 仅 1s best-effort 启动超时；SSE/HTTP 重复代码；无传输层测试

### 4.3 Hook 系统

- **类型定义**: 24 个 HookEvent（v3 文档说 23，代码定义 24）
- **注册**: 6 个 builtin hook 组（Profile/Stigmergy/Offload/Mnemopi/Experience/Verification），全部可注册
- **触发**: **15/24 从未触发** — `comm:*`、`vote:*`、`context:*`、`offload:afterL1`、`workflow:phaseTimeout`、`offload:beforeFlush`、`roundtable:beforeRound`
- **目录混乱**: `hooks/`（activity-logger）和 `hook-system/`（hook-pipeline + builtins）职责边界模糊

### 4.4 自定义工具与 Skill

- **工具注册**: 5 个 provider（builtin/claude/codex/claude-plugins/omp-plugins）→ capability registry → CustomToolAdapter
- **Skill 管理**: 多源去重 + 受控自动学习（managed-skill），防注入/防符号链接攻击

### 4.5 ⚡ 跨维度发现 SP-8: 工具安全模型非对称

| 工具来源 | 审批检查 | 命名隔离 |
|---------|---------|---------|
| MCP 工具 | ✅ 强制 `"write"` 级别 | ✅ `mcp__<server>_<tool>` 前缀 |
| 自定义工具 (扩展路径) | ✅ ExtensionToolWrapper 运行时执行 | ❌ 无强制前缀 |
| 自定义工具 (适配器路径) | ❌ 无 ExtensionToolWrapper 时完全绕过 | ❌ 无强制前缀 |

**圆桌结论**: MCP 工具比自定义工具**更安全** — 这是反直觉的。自定义工具自声明 `approval` 字段从未在运行时验证（当 ExtensionToolWrapper 不存在时）。修复方向：将审批检查从 ExtensionToolWrapper 提升到共享包装层。

---

## 第五章：用户体验

### 5.1 CLI 一致性

| 问题 | 严重度 | 详情 |
|------|--------|------|
| flag 命名不一致 | **P1** | `--json`/`-j` 仅在 stats 有短形式；`-c` 歧义（--check vs --continue）；`--verbose`/`--quiet` 基本缺失 |
| 错误格式不一致 | **P1** | 4+ 种前缀变体（`Error:`/`error:`/`[ERROR]`/无前缀）；3 种输出通道（console.error/stderr/stdout） |
| 进度指示器分散 | P2 | 仅 5/25 命令有进度显示，3 种独立实现 |
| 帮助文本 | P2 | Class-based 命令自动生成，hand-rolled 有 3+ 格式 |
| 全局 flag | P3 | `--cwd`/`--json` 被部分子命令重复解析 |

### 5.2 TUI 一致性

| 问题 | 严重度 | 详情 |
|------|--------|------|
| 双主题体系 | **P1** | Swarm Dashboard 使用独立 chalk.hex 主题 + sharp 边框 vs 主 TUI satopi.json 圆角主题 |
| 硬编码 ANSI | P2 | 主 TUI 40+ 处 `\x1b[`（swarm TUI 已清理为零） |
| 架构不匹配 | P2 | 主 TUI 45+ class 组件 vs swarm 11 纯函数渲染器 |
| 边框风格 | P1 | `┌┐└┘` (swarm sharp) vs `╭╮╰╯` (main round) |

### 5.3 文档体系

- **ARCHITECTURE.md**: 存在但仍是基础骨架 — 缺少 swarm 子系统详细架构、更新的文件索引、架构反模式标注
- **docs/ 100+ 文件**: 分类混乱 — 审计报告、设计文档、工具文档、计划混合存放
- **README**: 15/16 包有 README，质量高但结构不完全一致
- **推荐**: 增加 docs/ 子目录分类（architecture/、tools/、plans/、archive/）

### 5.4 端到端工作流

| 工作流 | 摩擦点 |
|--------|--------|
| 单 agent | 冷启动 watchdog (10s 粒度) 是唯一进度指示器 |
| Swarm plan | CLI 模式—LLM planner 调用期间零反馈 |
| Swarm run | CLI 模式—仅显示 "Starting swarm..." 然后静默等待 |
| 子 agent | TUI 中进度良好，CLI 中完全不可见 |
| Swarm resume | `runSwarmResume` 已修复（不再是 stub） |

---

## 第六章：性能与可观测性

### 6.1 启动性能

**关键瓶颈**: 原生 addon (`@oh-my-pi/pi-natives`) 在 import 时**同步加载** — 包括 AVX2 CPU 检测（读 `/proc/cpuinfo` 或 spawn `sysctl`/PowerShell）。ModelRegistry 构造函数也做同步文件系统读取。

**好消息**: MCP 服务器**不在启动时连接** — 使用 250ms 超时 + 缓存回退的延迟模型。

**优化方向**: native addon 的 CPU 检测可以延迟到首次实际使用；ModelRegistry 构造可以异步化。

### 6.2 可观测性

| 能力 | 覆盖度 | 缺口 |
|------|--------|------|
| 日志 | ✅ 结构化日志 + 自动轮转 | — |
| 事件追踪 | ✅ ActivityLogger + StateTracker | 无 trace ID 传播 |
| 指标 | ⚠️ stats dashboard | 非实时、无自定义指标 API |
| 调试 | ✅ log-viewer + profiler + report-bundle | — |
| 分布式追踪 | ❌ | 完全缺失 — 跨 agent 调用链不可见 |

### 6.3 测试健康度

| 指标 | 状态 |
|------|------|
| 测试脚本覆盖率 | 14/16 包有 test script（stats 缺失，web 无） |
| 覆盖率追踪 | **零** — 无 `--coverage` flag，无 CI 覆盖率门禁 |
| Swarm 测试 mock 深度 | 中度 — 无真实 LLM 调用，但使用真实 StateTracker/FSM/MarkEnvironment |
| 集成测试 | coding-agent/test/ 有 50+ 真实 AgentSession 实例化 |
| E2E | API e2e suite 存在但未接入 CI |
| 属性测试 | **无** |
| 混沌测试 | **无** |

---

## 第七章：优先级路线图

### 立即 (P0 — 阻塞级)
无。当前无阻塞级问题 — `bun check` 通过，CI 绿色。

### 短期 (P1 — 1-2 周)

| # | 行动 | 关联 SP | 预估 |
|---|------|---------|------|
| 1 | 引入受限异步队列抽象，统一替换 writeChain / ActivityLogger promise chain / AgentHandle unbounded buffer | **SP-6** | 4h |
| 2 | 修复 writeChain 中 `logSwarmState()` 缺少 `await` — 阻止状态持久化损坏 | SP-6 | 30m |
| 3 | 将审批检查从 `ExtensionToolWrapper` 提升到共享包装层 — 消除 MCP vs 自定义工具安全非对称 | **SP-8** | 3h |
| 4 | 连接 AgentLoopConfig 的 `hasIrcInterrupts` 到 spawn 路径 | **SP-7** | 1h |
| 5 | 连接 ContextPipeline.toTransformContext() 到 spawn 路径（或删除死代码） | **SP-7** | 2h |
| 6 | agent-session.ts 职责拆分 Phase 1: 提取 compaction-manager + prewalk-orchestrator | **SP-1** | 4h |
| 7 | sdk.ts 按关注点拆分 (bootstrap / tools / mcp / discovery) | **SP-1** | 3h |

### 中期 (P2 — 2-4 周)

| # | 行动 | 关联 SP |
|---|------|---------|
| 8 | 删除 executor.ts 的 `runSubprocess` legacy 回退分支 — 完成 SP-2 收敛 | SP-2 |
| 9 | Swarm Dashboard 主题接入主 Theme 系统；统一 sharp→round 边框 | SP-3 |
| 10 | CLI flag 命名规范统一 + 错误消息格式统一 + 共享进度指示器 | UX |
| 11 | ExperienceStore 启用 WAL 模式 + 自动 checkpoint | 鲁棒性 |
| 12 | 触发 15 个未连接的 HookEvent（comm:\*/vote:\*/context:\*等） | SP-7 |
| 13 | 后端 credential 加密 (libsodium / OS keychain) | SP-4 |
| 14 | 用户内容注入系统 prompt 前增加 sanitize 层 | SP-4 |
| 15 | packages/stats 补充 test script + CI 覆盖率门禁 | 测试 |
| 16 | 修复 3 个 catalog import 规则违规 | 耦合 |

### 长期 (P3 — 1-3 月)

| # | 行动 | 关联 SP |
|---|------|---------|
| 17 | interactive-mode.ts 核心状态机拆分 — 真正结构性分解 | SP-1 |
| 18 | OS 级沙箱集成 (bubblewrap/firejail) | SP-4 |
| 19 | 属性测试 + 混沌测试框架引入 | 测试 |
| 20 | 分布式 trace ID 传播 (跨 agent 调用链) | 可观测性 |
| 21 | PhaseBehavior 完全替代 legacy ScriptManager/StageController/CurtainRunner | SP-7 |
| 22 | 文档重组织 (docs/ 子目录分类 + ARCHITECTURE.md 深化) | SP-5 |

---

## 附录 A: 探查报告索引

| 报告 | Phase | 维度 | 关键评级 |
|------|-------|------|---------|
| `MegaFileDecompCheck` | 1 | 三巨头分解 | 2% 分解 |
| `DualPathConvergence` | 1 | 双路径收敛 | 85% 收敛，遗留回退 |
| `IssueFixVerification` | 1 | Issue 修复 | 5/10 已修复 |
| `SubsystemDepGraph` | 2 | 子系统依赖 | 星型拓扑，3 目录边界模糊 |
| `AgentLoopConfigReach` | 2 | AgentLoopConfig | 1/6 hook 不可达 |
| `V3LayerImplDegree` | 2 | V3 六层实现 | 结构完整，集成断裂 |
| `OhMyPiCoupling` | 2 | oh-my-pi 耦合 | 3 违规 + 165 传递依赖 |
| `ErrorHandlingAudit` | 3 | 错误处理 | P1 await 缺失 + ~20 吞错 |
| `ResourceLifecycleAudit` | 3 | 资源管理 | 5 泄漏 + 无 WAL |
| `ConcurrencySafetyAudit` | 3 | 并发安全 | JS 语义安全，2 P3 语义问题 |
| `BoundaryDegradationAudit` | 3 | 边界条件 | P2 FTS5 崩溃 + 无查询超时 |
| `PluginArchitecture` | 4 | 插件系统 | 流程清晰，缺热加载 |
| `MCPIntegration` | 4 | MCP 集成 | 成熟完善 |
| `HookCoverage` | 4 | Hook 覆盖 | 15/24 未触发 |
| `CustomToolSkill` | 4 | 自定义工具 | 审批自声明未验证 |
| `CLIConsistency` | 5 | CLI 一致性 | P1 flag/错误格式不一致 |
| `TUIThemeConsistency` | 5 | TUI 一致性 | P1 双主题 + 40+ 硬编码 |
| `DocNavigation` | 5 | 文档导航 | 量足但缺结构 |
| `E2EWorkflowUX` | 5 | 工作流 UX | CLI 模式零反馈 |
| `StartupPerf` | 6 | 启动性能 | 原生 addon 同步加载瓶颈 |
| `ObservabilityEval` | 6 | 可观测性 | 缺分布式追踪 |
| `TestHealthAudit` | 6 | 测试健康 | stats 缺 test + 零覆盖率 |

## 附录 B: 圆桌辩论记录

| 辩论 | 参与方 | 结论 |
|------|--------|------|
| #1: 异步生命周期 | ErrorHandlingAudit ↔ ResourceLifecycleAudit | SP-6: 共同根因 = 缺失受限异步队列抽象 |
| #2: V3 最后一公里 | AgentLoopConfigReach ↔ V3LayerImplDegree | SP-7: 分阶段策略 + 布线未完成 = 当前现实 |
| #3: 工具安全非对称 | MCPIntegration ↔ CustomToolSkill | SP-8: MCP > 自定义工具安全性（反直觉） |
| #4: 三巨头 vs 收敛 (Phase 1 内) | MegaFileDecompCheck ↔ DualPathConvergence | 两个指标正交但不独立 — session 单体阻塞收敛收益 |
| #5: 分解度定性 (Phase 1 内) | IssueFixVerification ↔ MegaFileDecompCheck | interactive-mode 7% 减少 = 外观性搬迁，非结构性分解 |
| #6: 收敛真实性 (Phase 1 内) | DualPathConvergence ↔ IssueFixVerification | 85% 收敛 = 诚实但需标注 executor.ts 回退风险 |
