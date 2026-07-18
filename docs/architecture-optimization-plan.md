# SatoPi 架构优化长期规划

> 生成日期: 2026-07-19
> 最后更新: 2026-07-19
> 基于: 全项目深度架构审计 (7 个子系统并行分析)
> 范围: packages/agent, packages/ai, packages/coding-agent, packages/swarm-extension, packages/swarm-gui, packages/mnemopi, packages/snapcompact, packages/wire, packages/collab-web, packages/web, packages/natives, packages/hashline, packages/utils, packages/tui, crates/*

---

## 执行进度

### 概览

| 阶段 | 分支 | 状态 | 完成 | 延期 | 提交 | 日期 |
|------|------|------|------|------|------|------|
| **P0** | `fix/p0-robustness` | ✅ 完成 | 4/4 | 0 | `f994247` | 2026-07-19 |
| **P1** | `fix/p1-architecture-decoupling` | ✅ 完成 | 5/6 | **1** | `009378f` | 2026-07-19 |
| **P2** | — | ⬚ 待开始 | 0/11 | — | — | — |
| **P3+P4** | — | ⬚ 待开始 | 0/9 | — | — | — |

### ⚠️ 延期清单

> 延期项目不影响当前阶段完成状态，但需要后续独立追踪处理。

| 延期编号 | 所属阶段 | 问题 | 延期原因 | 建议时间 |
|---------|---------|------|---------|---------|
| **P1-1-DEFER** | P1 | Swarm 编排逻辑迁移到 `swarm-engine` 包 | 需更新 >20 文件 import 路径 + workspace 配置，应通过独立 CI 验证 | P3 完成后 |

---

### P0 完成详情 (2026-07-19)

**延期: 无** — 全部 4 项按计划完成。

| 编号 | 问题 | 修复文件 | 变更 |
|------|------|---------|------|
| ✅ P0-1 | Agent执行超时 | `executor.ts` | 新增 `timeoutMs` 选项 (默认5分钟), per-agent `AbortController`, 超时自动 CRASHED |
| ✅ P0-2 | Abort资源清理 | `pipeline.ts` + `executor.ts` | `onStarted` 回调注册 active controllers, `abortAll()` 方法, `finally` 清理 |
| ✅ P0-3 | 错误吞噬结果 | `pipeline.ts` | `#completedIterations` 计数器, catch 返回已累积结果 |
| ✅ P0-4 | 并发安全 | `state.ts` | 序列化 `#writeChain` promise 队列, 同 tick 合并写 |

**验证**: 133 测试全部通过, 零回归, 修改文件零类型错误

### P1 完成详情 (2026-07-19)

**延期: 1 项** — P1-1 因影响范围过大延期至后续独立分支。

| 编号 | 问题 | 状态 | 修复文件 | 变更 |
|------|------|------|---------|------|
| P1-1 | 编排逻辑包迁移 | ⏸️ **延期** | — | 见 [延期清单](#️-延期清单) |
| ✅ P1-2 | Executor接口抽象 | 完成 | `executor.ts` | `AgentExecutor` 接口 + `SubprocessAgentExecutor` 默认实现, `PipelineOptions.executor` 注入 |
| ✅ P1-5 | 工具权限可配置 | 完成 | `schema.ts` + `executor.ts` | `SwarmAgent.allowedTools`/`blockedTools` YAML解析 → `AgentDefinition` 传递 |
| ✅ P1-4 | Wave数据管道 | 完成 | `pipeline.ts` | `WaveResult` + `PipelineContext` 类型, 每 Wave 结果累积传递给下游 |
| ✅ P1-3 | 依赖注入 | 完成 | `pipeline.ts` | `PipelineHooks` 接口替换硬编码生命周期行为 |
| ✅ P1-6 | 条件分支 | 完成 | `pipeline.ts` | 7 个生命周期 hook: `beforePipeline`, `beforeIteration`, `afterIteration`, `beforeWave`, `afterWave`, `afterPipeline`, `onHookError` |

**验证**: 133 测试全部通过, 零回归, 修改文件零类型错误
**变更量**: 3 files, +224/-5 lines

---

## 总体评估

SatoPi 继承自 `oh-my-pi` (前身 `pi`)，拥有 6 年血统的生产级 Agent 运行时。**Agent 核心层（agent, ai, coding-agent CLI, natives, hashline, tui）极度成熟**，无 TODO/FIXME 标记，代码质量极高。

**SatoPi 的 Swarm 层（swarm-extension + swarm-gui）是在成熟单体上快速构建的 HTTP+React 壳**，功能完整但架构存在显著技术债务。前端仅消费了后端能力的约 30%。

```
                    鲁棒性  拓展性  模块化  低耦合  前端完整度
agent / ai          █████  █████  █████  █████    N/A
coding-agent (CLI)  ████▌  ████▌  ████   ████     N/A
swarm-extension     ███    ███    ██▌    ██▌      N/A
swarm-gui           ██▌    ███    ███▌   ███▌     ██▌
mnemopi / snapcompact ████ ████   ████▌  ████▌    N/A
pi-ast / natives    █████  █████  █████  █████    N/A
```

---

## 一、P0 — 鲁棒性关键缺陷 ✅ 已完成 (2026-07-19)

> 分支: `fix/p0-robustness` → 已合并到 `dev`

### P0-1: Swarm Agent 无执行超时机制 ✅

- **位置**: `packages/coding-agent/src/swarm/executor.ts:66-80`
- **问题**: `executeSwarmAgent` 调用 `runSubprocess()` 无 timeout 参数，Agent 可永久 hang
- **影响**: 单个 Worker/Cloner 挂死会阻塞整个 Wave，最终导致 Pipeline 彻底卡死
- **建议**: 为 `runSubprocess` 传入 `iterationTimeoutMs` 超时信号，超时后自动 kill 并标记 CRASHED

### P0-2: Abort 后无子进程资源清理 ✅

- **位置**: `packages/coding-agent/src/swarm/pipeline.ts:123-129`, `executor.ts:94-103`
- **问题**: Pipeline abort 或 executor catch 后，已启动的 `runSubprocess` 子进程没有清理机制。子进程可能继续运行消耗资源并持有文件锁
- **影响**: 多次 abort/restart 后资源泄露累积，可能耗尽 PTY 或文件描述符
- **建议**: 
  - PipelineController 维护 active subprocess 句柄集合
  - abort 时遍历所有活跃子进程发送 SIGTERM
  - 超时后 SIGKILL

### P0-3: PipelineController 致命错误吞噬已完成结果 ✅

- **位置**: `packages/coding-agent/src/swarm/pipeline.ts:123-129`
- **问题**: `catch(err)` 返回 `iterations: 0`，丢弃了故障前已成功完成的所有迭代结果
- **影响**: 运行 5 个迭代后第 6 个失败 → 前端显示 0 个迭代，5 个成功迭代的工作成果不可见
- **建议**: 在 catch 块中返回当前已累积的 `allResults` 和已完成的 `iterations` 计数

### P0-4: StateTracker 无并发安全保护 ✅

- **位置**: `packages/coding-agent/src/swarm/state.ts`
- **问题**: 同一 Wave 内多个 Agent 并行执行时，同时调用 `updateAgent()` / `appendLog()` 写入同一个 JSON 文件
- **影响**: 竞态条件导致状态丢失或 JSON 文件损坏
- **建议**: 
  - 引入 per-agent 独立日志文件
  - 或使用写队列（ActivityLogger 已有类似模式）序列化所有 StateTracker 写操作

---

## 二、P1 — 架构耦合与模块化问题 ✅ 已完成 (2026-07-19) | ⚠️ 1项延期

### P1-1: Swarm 编排逻辑放错包位置 ⏸️ **延期** (P1-1-DEFER)

- **位置**: `packages/coding-agent/src/swarm/` (dag.ts, pipeline.ts, executor.ts, schema.ts, state.ts, loop-controller.ts 等 ~5000 行)
- **问题**: 核心编排逻辑全部在 `coding-agent` 包内，而 `swarm-extension` 只是一个 500 行的 HTTP 薄包装。这违反了关注点分离原则
- **影响**:
  - `swarm-extension` 包名具有误导性（它不包含编排逻辑）
  - 编排逻辑与 CLI/TUI 代码耦合在同一包中
  - 无法独立测试、独立发布 swarm 引擎
- **建议**:
  ```
  packages/coding-agent/src/swarm/   →  packages/swarm-engine/src/
  packages/swarm-extension/          →  只保留 TUI 扩展注册 + CLI runner
  ```
  拆分后 `swarm-engine` 成为零 CLI 依赖的纯编排库，可独立测试和发布

### P1-2: Executor 硬编码依赖 runSubprocess ✅

- **位置**: `packages/coding-agent/src/swarm/executor.ts:16,66`
- **问题**: `executeSwarmAgent` 直接 import 和调用 `runSubprocess`，无法替换为其他 Agent 执行机制（如远程 Agent、HTTP Agent、WebSocket Agent）
- **影响**: 所有 Swarm Agent 必须在本地进程中以子进程方式运行
- **建议**: 抽象 `AgentExecutor` 接口，`runSubprocess` 作为默认实现，支持注入自定义 executor

### P1-3: 无依赖注入机制 ✅

- **位置**: 全局 — 所有 swarm 模块直接 import 依赖
- **问题**: 无 DI 容器或工厂模式，所有依赖在模块顶层静态绑定
- **影响**: 单元测试困难（必须 mock 整个模块），无法在运行时替换组件
- **建议**: 引入轻量 DI（如 `Awilix` 或手写工厂函数），至少对以下接口抽象：
  - `AgentExecutor` — Agent 执行
  - `StatePersistence` — 状态持久化
  - `EventBroadcaster` — 事件广播（已有 ActivityBroadcaster，但未广泛使用）
  - `FileSystem` — 文件操作（便于测试）

### P1-4: Wave 间无结构化数据传递 ✅

- **位置**: `packages/coding-agent/src/swarm/pipeline.ts:145-213`
- **问题**: Wave N 的产出只能通过文件系统共享给 Wave N+1，无结构化的数据管道。Agent 之间通过 IRC 广播文本通信，无法传递类型化数据
- **影响**: 下游 Agent 需要解析上游 Agent 的文本输出来提取结构化信息，不可靠
- **建议**: 
  - 引入 `WaveContext` 类型，在 Wave 间传递结构化的中间结果
  - 支持 Agent 声明 `produces: Artifact[]` 和 `consumes: Artifact[]`

### P1-5: 硬编码工具列表 — 已修复：工具权限现在可通过 YAML allowed_tools/blocked_tools 配置 ✅

- **位置**: `packages/coding-agent/src/swarm/executor.ts:39` (注释中)
- **问题**: Executor 注释写死工具列表 `bash, python, read, write, edit, grep, find, fetch, web_search, browser`，但实际不可配置
- **影响**: 无法为不同 Agent 角色精细控制工具权限（虽然 schema 有 `AgentToolRestriction`，但 executor 未使用）
- **建议**: 将 `agent.allowedTools` / `agent.blockedTools` 从 schema 传递到 `runSubprocess` 的 tool filter 参数

### P1-6: 缺少条件分支和动态流程控制 ✅

- **位置**: `packages/coding-agent/src/swarm/dag.ts` (DAG 是静态的)
- **问题**: Pipeline 不支持 "Agent A 成功则跳过 Agent B" 或 "Agent C 失败则重试 3 次" 等条件逻辑
- **影响**: 所有流程必须在 YAML 中预定义，无法适应动态执行结果
- **建议**: 
  - 引入 `ConditionalWave` 概念，支持基于上一 Wave 结果的条件分支
  - 或支持 `on_success` / `on_failure` 回调钩子

---

## 三、P2 — 前端接入 Gap

### 前端已接入后端但未实现 UI 的能力

#### P2-1: After-loop 总结无渲染组件

- **API**: `GET /api/after-loop/summary` ✅
- **Store**: `afterLoopResult` 状态 ✅
- **UI**: AfterLoopPanel 已存在 ✅ 但仅在 ContextPanel 中以折叠面板形式展示，无独立页面/路由
- **缺失**: 独立的全屏总结视图、总结历史浏览、总结导出

#### P2-2: Before-loop 历史无法浏览

- **API**: `GET /api/before-loop/history` ✅
- **API Client**: `getBeforeLoopHistory` ✅
- **UI**: ❌ 无任何组件调用此 API
- **影响**: 用户无法回顾之前的 Socrates 规划对话

#### P2-3: Steering 消息无实时反馈

- **API**: `POST /api/run/steer` ✅
- **问题**: 前端发送 steering 消息后使用乐观 UI 立即显示，但没有 "已送达" / "Agent 已读" 的状态反馈
- **建议**: SSE 事件中添加 `steering-ack` 事件类型，前端据此更新消息状态

#### P2-4: 人工升级无阻断点 UI

- **Config**: `loop.humanEscalation: true` ✅
- **后端**: `blocked` phase + BlockerDialog ✅
- **缺失**: 
  - 升级决策没有超时自动降级（如 5 分钟无人响应自动 continue）
  - 无升级通知（桌面通知/声音）

#### P2-5: 收敛度无实时可视化

- **Config**: `convergence.threshold: 0.85`, `convergence.approvalRatio: 0.67` ✅
- **后端**: Jaccard 相似度计算 ✅
- **UI**: ❌ 无收敛趋势图表
- **建议**: 在 PhasePipeline 或 ContextPanel 中添加收敛度折线图（每轮迭代的 Jaccard 值 + 审批通过率）

#### P2-6: Token 用量 / 成本完全不可见

- **数据**: `SingleResult.tokens` ✅, `run-collector.ts` 有完整 cost 追踪 ✅
- **UI**: ❌ 前端从不展示 token 用量或成本
- **影响**: 用户"盲飞"，无法评估 swarm 运行成本
- **建议**: 在 TopBar 或 ContextPanel 添加实时 token 计数器 + 估算成本

### 前端完全未接入的后端能力

#### P2-7: Session 时间旅行 / 分支

- **能力位置**: `packages/agent/src/compaction/entries.ts` — SessionEntry 支持 BranchSummary, Compaction 等
- **能力**: Agent 支持 session tree 分支、回退到 checkpoint、时间旅行
- **UI**: ❌ 完全无前端接入
- **建议**: 在 MonitorPage 添加 session tree 可视化组件，支持分支切换

#### P2-8: MnemoPi 记忆查询与管理

- **能力位置**: `packages/mnemopi/` — SQLite + FTS5 + 向量搜索记忆引擎，15+ MCP 工具
- **UI**: ❌ 完全无前端接入
- **建议**: 添加 Memory 管理页面 — 浏览/搜索/编辑/删除记忆条目

#### P2-9: 文件变更 Diff 可视化

- **能力位置**: `packages/hashline/` — 精确代码补丁，`diff-preview.ts`
- **UI**: ❌ Swarm GUI 无 diff 视图
- **建议**: 在 File conflict 报告中添加 Monaco DiffViewer 对比变更

#### P2-10: Agent Tool 调用详情

- **能力**: Agent 运行时记录完整的 tool-call / tool-result 对
- **UI**: ❌ 前端只能看到 Agent 最终文本输出，无法看到工具调用详情
- **建议**: 在 ChatView 中添加可展开的 tool call 卡片

#### P2-11: Provider 错误详情

- **能力位置**: `packages/ai/src/error/flags.ts` — 18 种错误分类
- **UI**: ❌ 前端只显示通用 "error" 文本
- **建议**: 错误消息中携带 error flag，前端根据 flag 类型显示不同的错误 UI 和恢复建议

---

## 四、P3 — 前端架构改进

### P3-1: 无路由系统

- **问题**: 单页应用，所有功能（Monitor, Config, History）通过 `page` 状态变量切换，无 URL 路由
- **影响**: 无法深度链接、无法浏览器前进/后退、刷新后丢失当前页面
- **建议**: 引入 `react-router` 或 `tanstack-router`

### P3-2: 测试覆盖极薄

- **单元测试**: 仅 6 个（config-store, swarm-store, api-client, sse-client 各 1 个文件）
- **E2E 测试**: 仅 5 个 Playwright 测试（页面加载、状态指示器、配置按钮、聊天输入）
- **缺失**: 组件测试、Store 集成测试、SSE 事件处理测试、错误路径测试
- **建议**: 至少覆盖核心 Store actions、ChatView 消息渲染、PhasePipeline 状态转换

### P3-3: SSE 重连无状态恢复

- **问题**: SSE 断开重连后，前端从空状态重新开始，丢失断开期间的事件
- **建议**: 
  - 后端 SSE 支持 `Last-Event-ID` header 恢复
  - 或前端在重连后调用 `GET /api/history?since=&lt;last_ts&gt;` 补充丢失的事件

### P3-4: 无虚拟滚动优化

- **位置**: ChatView 已使用 `@tanstack/react-virtual` ✅
- **问题**: 但 Activities 数组（ring buffer 500 条）和 Messages Map 无上限，长时间运行可能内存膨胀
- **建议**: 对历史消息做分页/懒加载，超过可视范围的消息卸载 DOM

### P3-5: 离线状态无 UI 反馈

- **问题**: SSE 断开后仅 TopBar 显示 "Disconnected"，无其他 UI 降级
- **建议**: 
  - 连接断开时显示全局 banner
  - 禁用 Start/Stop 等写操作按钮
  - 显示 "重连中..." 动画

---

## 五、Swarm 后端架构改进

### P4-1: 引入 Plugin/Hook 系统

- **现状**: Pipeline 生命周期（beforeIteration, afterWave, onConvergence, onBlockage 等）无扩展点
- **建议**: 定义 `SwarmHooks` 接口，允许用户在 YAML 中声明 hook 脚本或在代码中注册回调：
  ```typescript
  interface SwarmHooks {
    beforeIteration?: (ctx: IterationContext) => Promise<void>;
    afterWave?: (ctx: WaveContext) => Promise<void>;
    onConvergence?: (result: ConvergenceResult) => Promise<void>;
    onBlockage?: (ctx: BlockerContext) => Promise<BlockerResolution>;
    afterLoop?: (result: LoopResult) => Promise<void>;
  }
  ```

### P4-2: MonitorServer 端口范围可配置

- **位置**: `packages/coding-agent/src/swarm/monitor/server.ts`
- **问题**: 硬编码 7878-7887，不可配置
- **建议**: 支持 `PI_SWARM_PORT` 环境变量

### P4-3: SSE 事件无订阅过滤

- **位置**: `packages/coding-agent/src/swarm/monitor/event-bus.ts`
- **问题**: 所有订阅者收到所有事件，前端需要自行过滤
- **建议**: 支持按事件类型订阅，减少前端处理开销

### P4-4: ActivityLogger 的 broadcaster 只能设置一次

- **位置**: `packages/coding-agent/src/swarm/activity-logger.ts`
- **问题**: `setBroadcaster()` 只能调用一次，如果 MonitorServer 重启则无法重新注册
- **建议**: 支持替换 broadcaster

---

## 六、优先级排序与建议时间线

### 第一阶段 — 鲁棒性修复 (1-2 周)

| 编号 | 问题 | 影响范围 |
|------|------|---------|
| **P0-1** | Agent 执行超时 | 所有 swarm 运行 |
| **P0-2** | Abort 资源清理 | 所有 swarm 运行 |
| **P0-3** | 错误吞噬已完成结果 | Pipeline 可靠性 |
| **P0-4** | StateTracker 并发安全 | 并行 Wave 场景 |

### 第二阶段 — 架构解耦 (2-4 周)

| 编号 | 问题 | 影响范围 |
|------|------|---------|
| **P1-1** | Swarm 编排逻辑迁移到 swarm-engine | 包结构 |
| **P1-2** | Executor 接口抽象 | 可拓展性 |
| **P1-3** | 依赖注入 | 可测试性 |
| **P1-4** | Wave 间数据管道 | Agent 间通信 |
| **P1-5** | 工具权限可配置 | 安全性 |

### 第三阶段 — 前端能力补全 (4-8 周)

| 编号 | 问题 | 用户可见影响 |
|------|------|------------|
| **P2-6** | Token/成本展示 | 高 — 用户"盲飞" |
| **P2-10** | Tool 调用详情 | 高 — 调试体验 |
| **P2-5** | 收敛度可视化 | 中 — 运行透明度 |
| **P2-1** | After-loop 独立视图 | 中 |
| **P2-7** | Session 时间旅行 | 低 — 高级功能 |
| **P2-8** | 记忆管理 UI | 低 — 高级功能 |
| **P2-9** | Diff 可视化 | 中 |
| **P2-11** | Provider 错误详情 | 高 — 调试体验 |

### 第四阶段 — 前端基础设施 (4-6 周)

| 编号 | 问题 |
|------|------|
| **P3-1** | 路由系统 |
| **P3-2** | 测试覆盖 |
| **P3-3** | SSE 状态恢复 |
| **P3-5** | 离线 UI |

### 第五阶段 — 平台化能力 (6-12 周)

| 编号 | 问题 |
|------|------|
| **P4-1** | Plugin/Hook 系统 |
| **P1-6** | 条件分支流程 |
| **P4-2** | 端口可配置 |
| **P4-3** | SSE 订阅过滤 |

---

## 七、不紧急但值得关注

- **P3-4**: 内存膨胀 — 长期运行 swarm（>1000 轮迭代）时 activities ring buffer 可能需要更大或分页
- **P4-4**: ActivityLogger broadcaster 可替换性
- **ConfigPage** 中 `buildYaml()` 硬编码了 `agent_restrictions.socrates.allowed` 工具列表 — 应改为从表单可配置
- **ChatView** 乐观 UI 无 rollback — API 失败后消息仍显示在聊天中
- **HistoryPage** 的 `selectedRun` 依赖未实际过滤数据
- **未使用的 API 端点**: `getPlanTodos()`, `searchExperience()`, `getRecentLessons()`, `updateRole()`, `getRunMeta()` — 应实现 UI 或清理

---

## 八、架构亮点（保持并推广）

以下模式是项目中最优秀的设计，应在重构中保持并在 swarm 层推广：

1. **Agent 层的 Compaction 双层策略** — Shake（机械删除）+ Compaction（LLM 摘要）+ Branch Summary + SnapCompact 视觉压缩 — 业界顶级的上下文管理
2. **AI 层的 Bit-Flag 错误分类** — 18 种位掩码 + 80+ regex 覆盖 40+ provider 的错误文本 — 应该在 Swarm 层的错误处理中复用
3. **ActivityLogger 的序列化写队列** — `catch(() => {})` 确保日志失败不影响主流程 — 应该在 StateTracker 中采用
4. **Session Tree 架构** — 时间旅行/分支/回退 — 前端接入后将是差异化竞争力
5. **Rust Native 层的 N-API 桥接** — 高性能 grep/shell/AST/PTY — 无改进必要
6. **SnapshotStore 的 SeenLineAware 校验** — Haseline 层的"模型是否真的读过这些行"检查 — 值得在 Swarm Agent 间推广
