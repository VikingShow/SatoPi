# SatoPi 综合调研分析报告

> 日期: 2026-07-27
> 范围: `realSatoPi/SatoPi` 全量代码审查
> 基础: 已有 54 issue 审计 (`architecture-audit-2026-07-27.md`) + 本次深度补充

---

## 执行摘要

本次调研在已有 54 个 issue 的基础上，对 SatoPi 项目的 swarm 子系统进行了更深层次的代码审查，覆盖工程设计、架构设计、用户交互三个长期优化维度，并给出了完整的 swarm 测试指南。

### 核心发现

| 维度 | 关键问题 | 严重度 |
|------|---------|--------|
| 设计缺陷补充 | 测试隔离假象、错误路径盲区、并发竞态窗口、资源生命周期缺口 | P1-P2 |
| 工程设计 | 双路径无收敛计划、agent-session.ts 上帝对象、依赖链脆弱 | 长期 |
| 架构设计 | 无分布式扩展、无预算管理、ContextCompactor 断线、oh-my-pi 紧耦合 | 长期 |
| 用户交互 | collab-web 非 swarm 专用、TUI 轮询延迟、幽灵字段、无运行回放 | 中期 |
| 测试现状 | 298 单测中 13 个因依赖缺失失败、无 e2e、无属性测试、无混沌测试 | 阻断 |

### v3 路径确认不可用

`AgentRuntime.spawnOne()` 构建的 `LaunchContext` **不传** `builtinToolNames` / `createToolSession` / `toolRegistry`，导致 `AgentLauncher.#resolveToolInstances()` 走 Path C（mock stubs）。所有工具返回 `"Tool ${name} executed (mock)"`。同时 `session` 传 `null`（`agent-launcher.ts:272`）。v3 路径从未端到端运行过。

---

## 第一章：设计缺陷审查（补充）

本章在已有 54 个 issue 基础上，补充审计中遗漏的设计缺陷，分为四个维度。

### 1.1 测试工程学缺陷

#### D-1: 测试因依赖缺失而失败（环境问题被当作代码问题）

- **文件**: `packages/coding-agent/src/swarm/__tests__/` 全部 25 个测试文件
- **现象**: 运行 `bun test packages/coding-agent/src/swarm/__tests__/` 时，298 个测试中 **13 个失败**，全部是模块解析错误：
  ```
  Cannot find module '@oh-my-pi/pi-utils' from '.../irc/bus.ts'
  Cannot find module '@oh-my-pi/pi-agent-core' from '.../agent-runtime.test.ts'
  Cannot find module '@oh-my-pi/pi-tui' from '.../index.ts'
  ```
- **根因**: 项目依赖 `@oh-my-pi/*` 系列包（catalog 版本 `16.5.0`），但未运行 `bun setup`（安装依赖 + 构建 Rust addon + link CLI + `scripts/link-omp.sh`）。测试在未完成初始化的环境中运行。
- **影响**: CI 环境必须先 `bun setup` 才能跑 swarm 测试；本地开发者首次 clone 后直接 `bun test` 会看到大量误报失败。
- **建议**: 在 `package.json` 的 `test` 脚本前增加 pre-check，或文档中明确标注前置步骤。

#### D-2: 298 单测全部是隔离测试，无集成验证

- **文件**: `swarm/__tests__/` 下 25 个文件
- **分析**:
  - `agent-runtime.test.ts` — 测试 `AgentRuntime.spawn()` 的参数传递和 hook 调用，但 mock 了 `AgentLauncher`、`ContextPipeline`、`HookPipeline`，从未验证真实 Agent 能否启动。
  - `executor.test.ts` — 测试 `executeSwarmAgent` 的超时/中止/错误路径，但 mock 了 `runSubprocess`。
  - `pipeline.test.ts` — 测试 `PipelineController` 的 wave 执行，但 mock 了 `executeSwarmAgent` 和 `AgentRuntime.spawn`。
  - `workflow-fsm.test.ts` — 测试 FSM 状态转换正确性，但不测试 FSM 与 StateTracker/ActivityLogger 的真实交互。
- **影响**: v3 路径的 mock stub 问题（P0-3）和 session 为空问题（P0-4）在单测中完全不可见，因为测试从未实例化真实的 `AgentLauncher`。
- **建议**: 增加至少一个 smoke-level 集成测试，使用真实的 `AgentLauncher` + 真实的 `ModelRegistry`（mock provider）验证 agent 能启动并产出输出。

#### D-3: 无属性测试（Property-Based Testing）

- **缺失场景**:
  - `WorkflowFsm` 的状态空间（8 个 phase × 允许转换边）适合属性测试：随机生成转换序列，验证不变量（如 "从 idle 出发，任何合法序列最终可回到 idle"）
  - `TaskQueue` 的依赖图计算适合属性测试：随机生成 DAG，验证 `#computeReady()` 的正确性
  - `Dag` 模块的拓扑排序适合属性测试：随机图，验证结果无前驱冲突
- **影响**: P0-9（blocked 活锁）和 P0-10（孤儿依赖）这类需要特定状态序列才触发的 bug，属性测试能自动发现。
- **建议**: 引入 `fast-check` 或 Bun 原生的 property test 支持。

#### D-4: 无混沌/错误注入测试

- **缺失场景**:
  - Agent 启动到一半进程被 kill（验证 `AgentRegistry.unregister` 清理）
  - SQLite 连接在写入中途被关闭（验证 `ExperienceStore` 恢复）
  - `runSubprocess` 返回非零退出码但 `output` 为空（验证错误传播）
  - 并发 `register()` 同一 agentId（验证 P1-4 修复后的覆盖逻辑）
  - `AbortController.abort()` 在 `runSubprocess` 内部 vs 外部触发（验证清理路径）
- **影响**: P0-9、P1-3、P1-5、P1-6 这类需要异常时序才暴露的 bug 无法被现有测试发现。

#### D-5: 测试覆盖率缺乏量化

- **现状**: 项目没有配置覆盖率工具（如 `c8` 或 `istanbul`），`bun test` 不输出覆盖率报告。
- **影响**: 无法判断 298 个测试是否覆盖了关键路径。特别是 `swarm/` 目录有 110 个 `.ts` 文件但只有 25 个测试文件，覆盖率可能低于 30%。
- **建议**: 在 `package.json` 中增加 `"test:coverage": "bun test --coverage"` 脚本，CI 中强制覆盖率门槛。

### 1.2 错误路径覆盖盲区

#### D-6: `AgentLauncher.#startAgent` 的 steerFeed 无限循环泄漏

- **文件**: `agent-launcher.ts:499-517`
- **代码**:
  ```ts
  let feedActive = true;
  const steerFeed = (async () => {
    while (feedActive && !signal?.aborted) {
      // ...
      await new Promise<void>(r => setTimeout(r, 1_000));
    }
  })();
  ```
- **问题**: `steerFeed` 是一个 fire-and-forget 的 async IIFE。如果 `agent.prompt()` 在 `finally` 中设置 `feedActive = false`，但 steerFeed 此刻正在 `setTimeout` 中等待，那么这个 Promise 会一直挂起到 setTimeout 唤醒后才检查 `feedActive`。如果 agent 在这 1 秒内崩溃且未被 catch，steerFeed 永远不会退出。
- **影响**: 每次 agent 崩溃可能泄漏一个 1 秒间隔的无限轮询 Promise。
- **严重度**: P2

#### D-7: `SwarmRunner.start()` 的 stage.run() catch 吞错误

- **文件**: `swarm-runner.ts:176-186`
- **代码**:
  ```ts
  stage.run().then(async (result) => {
    // ...
    await this.#runCurtainPipeline(result);
  }).catch((err) => {
    logger.error("[SwarmRunner] Stage failed", { error: String(err) });
  }).finally(() => {
    this.#running = false;
    this.#abortController = null;
    this.#completionPromise.resolve();
  });
  ```
- **问题**: `.catch` 只记录日志，不更新 `StateTracker` 状态。如果 stage 崩溃，`StateTracker` 仍然显示 `status: "running"`，前端永远看不到终止状态。
- **影响**: 前端 UI 在 stage 崩溃后显示"运行中"永不过期。
- **严重度**: P2

#### D-8: `ExperienceStore.init()` 的 FTS5 建表失败时静默降级

- **文件**: `curtain/experience.ts`（根据审计 P2-12）
- **问题**: FTS5 建表失败时 catch 返回降级模式，但 `ExperienceStore` 仍然接受写入调用。写入数据在 FTS5 不可用时只能全量扫描，性能骤降。
- **影响**: 大量 experience 数据积累后，FTS5 降级 → 查询超时 → curtain 阶段卡死。
- **严重度**: P2

#### D-9: `SessionRegistry.createSession()` 的 factory 异常未清理

- **文件**: `swarm/session/session-registry.ts`
- **问题**: `factory()` 内部创建 `StateTracker`、`ActivityLogger`、`SwarmRunner` 等对象。如果 factory 在中途抛异常（如 `HookPipeline` 注册失败），已创建的对象不会被清理。
- **影响**: 部分初始化的 session 残留在内存中，可能导致后续 `createSession` 调用因资源冲突而失败。
- **严重度**: P2

### 1.3 并发安全缺陷

#### D-10: `StateTracker.#writeChain` 的 promise 链无超时

- **文件**: `core/state.ts`
- **问题**: `#writeChain` 使用 promise 串联所有写操作。如果 `SwarmSessionManager.append()` 因 I/O 阻塞（如磁盘满），整个写链阻塞，后续所有 `updateAgent` / `updatePipeline` 调用堆积。
- **影响**: 一个 I/O 慢操作导致整个 swarm 状态更新冻结，agent 看不到状态变化，可能重复执行已完成任务。
- **严重度**: P2

#### D-11: `AgentRegistry.register()` 的 check-then-set 竞态

- **文件**: `registry/agent-registry.ts:105`
- **问题**: 即使 P1-4 修复了静默覆盖，`register()` 仍然存在 TOCTOU 竞态：检查旧 ref 存在 → dispose 旧 session → set 新 ref，这三步之间另一个并发 `register()` 可能插入，导致两次 dispose 或 ref 丢失。
- **影响**: 高并发 spawn 场景（>10 agent 同时注册）可能出现 ref 丢失。
- **严重度**: P2（在当前单进程 + CONCURRENCY_LIMIT=10 下不常见，但 scale 后必现）

#### D-12: `MarkEnvironment` 的 `#marks` Map 无并发保护

- **文件**: `coordination/mark-environment.ts`
- **问题**: `#marks` 是普通 `Map`，`place()` / `getSummary()` / `serialize()` 可能被并发调用（多个 agent 同时 place mark）。JavaScript 单线程下通常安全，但 `#decayExpired()` 在遍历过程中如果另一个 `place()` 修改 Map，可能抛 `ConcurrentModificationError`（Bun 的 Map 实现是否安全需验证）。
- **影响**: 高并发 mark 场景可能抛异常。
- **严重度**: P3

#### D-13: `RegionLockManager` 的 `acquire()` 无公平性保证

- **文件**: `coordination/region-lock.ts`
- **问题**: 当多个 agent 同时请求同一 region 的锁时，`acquire()` 使用 `Promise` resolve 队列，但无公平排队保证。某些 agent 可能持续被抢占（starvation）。
- **影响**: 某些 agent 永远获取不到文件锁，任务超时失败。
- **严重度**: P2

### 1.4 资源生命周期缺口

#### D-14: `ActivityLogger` 的 SSE stream 无背压控制

- **文件**: `hooks/activity-logger.ts:292-304`（审计 P3-9 提到绕过 `#writeQueue`）
- **补充问题**: 即使修复了 `#writeQueue` 绕过问题，SSE stream 本身无背压控制。如果前端消费慢，`ActivityLogger` 会持续向 stream 写入，导致内存中积压大量未发送的 SSE 事件。
- **影响**: 长时间运行的 swarm + 慢网络前端 → 内存逐渐增长 → OOM。
- **严重度**: P2

#### D-15: `AgentHandle.messages[]` 无上限（审计 P3-5 补充）

- **文件**: `agent-runtime/agent-handle.ts:281`
- **补充**: 不仅无上限，`messages[]` 还被 `outputStream()` 引用。如果 agent 产出大量消息（如长时间 bash 输出），内存中会保留完整历史。即使 `wait()` 返回后，`messages[]` 也不会被 GC（因为 handle 可能被 `#activeHandles` Map 持有引用）。
- **影响**: 长时间运行 + 高产出 agent → 内存泄漏。
- **严重度**: P2

#### D-16: `ProfileRegistry.global()` 的全局单例无清理

- **文件**: `agent/agent-profile.ts`
- **问题**: `ProfileRegistry.global()` 返回全局单例，持有所有 agent 的 profile JSON 数据。进程退出时不清理，如果有多个 swarm session 顺序运行，profile 数据累积。
- **影响**: 长期运行的开发环境（如 TUI 模式下多次运行 swarm）→ 内存缓慢增长。
- **严重度**: P3

#### D-17: `ExperienceStore` 的 SQLite WAL 文件无限增长

- **文件**: `curtain/experience.ts`
- **问题**: SQLite 使用 WAL 模式时，`-wal` 文件会持续增长，直到执行 checkpoint。`ExperienceStore` 从不主动 checkpoint，也没有 `PRAGMA wal_autocheckpoint` 配置。
- **影响**: 长时间运行后 `.swarm-workspace/experience.db-wal` 可能达到数百 MB，且读取性能下降。
- **严重度**: P3

---

## 第二章：工程设计长期优化建议

### 2.1 双执行路径收敛计划

#### 当前状况

| 路径 | 工具 | Session | 通信 | 使用方 |
|------|------|---------|------|--------|
| Legacy (`runSubprocess`) | 真实 | 真实 | IRC | StageController, ScriptManager, CurtainRunner, DebateRoundtable |
| v3 (`AgentRuntime.spawn`) | Mock stubs | null | CommBus | PhaseBehavior (ScriptBehavior, StageBehavior, CurtainBehavior) |

`PipelineController` 通过 `if (runtime) { v3 } else { legacy }` 选择路径。`SwarmRunner` 构造时 `runtime` 为 `undefined`（`swarm-cli.ts:122-135` 不传 `runtime`），因此 CLI 入口实际全部走 legacy。

#### 收敛建议：三阶段路线图

**阶段 1（短期）：补全 v3 路径的真实工具接入**

```
AgentRuntime.spawnOne()
  → 在构建 LaunchContext 时传入:
    - builtinToolNames: 从 ResolvedRole.tools 推导
    - createToolSession: 构建 MinimalToolSession
    - toolRegistry: 可选，从 AgentRegistry 全局获取
  → AgentLauncher.#resolveToolInstances() 走 Path A (createTools)
  → 移除 Path C (mock stubs)
```

**阶段 2（中期）：统一 session 管理**

```
AgentLauncher.launch()
  → 创建真实 AgentSession (替代 null)
  → 注册到 AgentRegistry
  → dispose 时调用 AgentSession.beginDispose()
```

**阶段 3（长期）：废弃 legacy 路径**

```
PipelineController.executeWaves()
  → 移除 if (runtime) 分支
  → 所有执行走 AgentRuntime.spawn()
  → executeSwarmAgent() 标记 @deprecated
  → ScriptManager / StageController / CurtainRunner 统一使用 PhaseBehavior
```

### 2.2 模块边界优化

#### 问题：`agent-session.ts` 上帝对象（3,254 行）

当前 `AgentSession` 承担了至少 13 个职责：

1. Agent 生命周期管理
2. Model resolution & service tier
3. Compaction（auto/manual/aggressive/shake/prune）
4. Bash 执行
5. Session 持久化 & 分支
6. Advisor 运行时管理（spawn/stop/reset/recorder feeds/context promotion）
7. Async job 管理
8. Plan mode 状态
9. Tool call loop 守卫
10. Rate limit & backoff
11. Append-only context 管理
12. SSE debug buffering
13. LSP 集成

#### 建议：按职责拆分为 5 个协作模块

```
agent-session.ts (协调者，~500行)
├── model-resolver.ts          (职责 2, 10)
├── compaction-manager.ts       (职责 3)
├── session-persistence.ts      (职责 5, 11)
├── advisor-runtime.ts          (职责 6)
└── tool-loop-guard.ts          (职责 9, 12)
```

**优先级**: P1（影响所有后续开发效率）

#### 问题：`swarm/` 目录模块边界模糊

```
swarm/
├── core/          ← SwarmRunner, PipelineController, WorkflowFsm, StateTracker, Schema
├── agent-runtime/ ← AgentRuntime, AgentLauncher, AgentHandle (v3 路径)
├── executor/      ← executeSwarmAgent, TaskQueue (legacy 路径)
├── behaviors/     ← PhaseBehavior (v3 桥接层)
├── stage/         ← StageController (使用 legacy)
├── script/        ← ScriptManager, DebateRoundtable (双路径)
├── curtain/       ← ExperienceStore, Extractor, CurtainRunner
├── session/       ← SwarmSessionManager, SessionRegistry
├── hook-system/   ← HookPipeline, builtin hooks
├── hooks/         ← ActivityLogger, swarm-hooks (非 hook-system 的一部分?)
├── comm-bus/      ← CommBus, IRC bus 封装
├── context-manager/ ← ContextPipeline, sources/
├── render/        ← streaming, TUI render helpers
├── tui/           ← SwarmDashboard, agent-panel, comm-panel, phase-view
└── prompts/       ← Swarm prompt templates
```

**问题**:
1. `hooks/` 和 `hook-system/` 边界不清 — `hooks/` 里有 `activity-logger.ts` 和 `swarm-hooks.ts`，`hook-system/` 里有 `hook-pipeline.ts` 和 `builtins/`。两者关系是什么？
2. `render/` 和 `tui/` 职责重叠 — `render/streaming.ts` 做 SSE 流式渲染，`tui/swarm-dashboard.ts` 做终端渲染。
3. `agent-runtime/` 和 `executor/` 是同一关注点（agent 执行）的两种实现，应该合并或明确标记为 v3 vs legacy。

**建议**: 增加 `ARCHITECTURE.md` 文档明确每个子目录的职责和边界。

### 2.3 依赖注入改进

#### 当前问题

`swarm-cli.ts` 的 `runSwarmRun()` 是一个 130 行的函数，手工 wire 了 8+ 个服务：

```ts
const authStorage = await discoverAuthStorage();
const settings = await Settings.init({ cwd });
const modelRegistry = new ModelRegistry(authStorage);
const experienceStore = new ExperienceStore(cwd);
const profileRegistry = ProfileRegistry.global();
const markEnvironment = new MarkEnvironment();
const roleAssetManager = new RoleAssetManager(cwd);
const hookPipeline = new HookPipeline();
registerBuiltinHooks(hookPipeline, { offloadManager: new NoopOffloadManager(), ... });
const runManager = new SwarmRunner({ ...12个参数... });
```

**问题**:
- 每新增一个服务需要修改 `runSwarmRun()`
- 测试需要 mock 12+ 个参数
- `NoopOffloadManager` 作为 placeholder 传入，真实 OffloadManager 永远不会被接入（因为 factory 闭包不更新）

**建议**: 引入 ServiceContainer 模式

```ts
interface SwarmServiceContainer {
  resolve<T>(token: ServiceToken<T>): T;
  register<T>(token: ServiceToken<T>, factory: (c: SwarmServiceContainer) => T): void;
}

// 使用
const container = createSwarmContainer({ cwd, yamlPath });
const runManager = container.resolve(SwarmRunner);
```

### 2.4 代码组织改进

#### D-18: `swarm-cli.ts` 的 `runSwarmPlan` 和 `runSwarmResume` 是空壳

- **文件**: `cli/swarm-cli.ts:209-221`
- **代码**:
  ```ts
  async function runSwarmPlan(cmd: SwarmCommandArgs): Promise<void> {
    process.stderr.write("plan mode not yet implemented\n");
    process.exitCode = 1;
  }
  async function runSwarmResume(cmd: SwarmCommandArgs): Promise<void> {
    process.stderr.write("resume not yet implemented\n");
    process.exitCode = 1;
  }
  ```
- **影响**: CLI 暴露了 `stp swarm plan` 和 `stp swarm resume` 命令，但两者都立即失败。用户体验差。
- **建议**: 要么实现，要么从 CLI 命令注册中移除。

#### D-19: `ScriptManager` 在 CLI 模式下是 placeholder

- **文件**: `cli/swarm-cli.ts:138-167`
- **问题**: CLI 模式下 `ScriptManager` 的所有方法返回 `{ success: false, error: "Script phase not available in CLI mode" }`。这意味着 CLI 模式下 **Script 阶段完全跳过**，直接进入 Stage 阶段。
- **影响**: 通过 CLI 运行 swarm 时，没有 plan.md 生成步骤（依赖外部提供 plan.md），也没有 script-debate / script-confirm 阶段。
- **建议**: 文档中明确标注 CLI 模式的限制；或实现 CLI 模式的 Script 阶段（通过交互式 prompt 或参数传入 plan 内容）。

#### D-20: 配置嵌套过深（审计 P3-1 补充）

- **文件**: `core/schema.ts:66-180`
- **补充分析**: `LoopSwarmConfig` 有 20+ 个嵌套配置项，其中存在隐式交互：
  - `workers.max` vs `cloners.count` — 两者都是 agent 数量，但语义不同（worker 执行任务，cloner 审查）
  - `plan_debate.enabled` vs `workers.initial` — 如果 plan_debate 启用但 workers.initial=0，plan 阶段无人执行
  - `max_iterations` vs `workers.max_rounds` — 两层循环边界，外层迭代 vs 内层轮次
- **建议**: 定义配置 schema 的不变量（如 `workers.initial <= workers.max`），在 `validateSwarmDefinition()` 中检查。

---

## 第三章：架构设计长期优化建议

### 3.1 分布式执行支持

#### 当前限制

所有 agent 在单进程内执行：
- Legacy 路径通过 `runSubprocess` 启动子进程（但仍是同一台机器）
- v3 路径通过 `new Agent({...})` 在进程内创建（共享 event loop）
- `CONCURRENCY_LIMIT = 10`（`pipeline.ts:19`）硬编码上限

#### 扩展瓶颈

| Agent 数量 | 瓶颈 | 表现 |
|-----------|------|------|
| 1-10 | 无 | 正常运行 |
| 10-50 | event loop 饱和 | agent 响应延迟增加 |
| 50-100 | 内存压力 | GC 频繁，延迟抖动 |
| 100+ | FD 耗尽 | 新 agent 无法启动 |

#### 建议：引入 RemoteAgentExecutor

```ts
// 扩展 AgentExecutor 接口
class RemoteAgentExecutor implements AgentExecutor {
  async execute(agent, index, options): Promise<SingleResult> {
    // 通过 HTTP/WebSocket 将任务发送到远程 worker
    const response = await this.#workerPool.dispatch({
      agent, task: agent.task, workspace: options.workspace,
    });
    return response;
  }
}

// Worker 端
class SwarmWorker {
  async handleTask(task: WorkerTask): Promise<SingleResult> {
    const result = await executeSwarmAgent(task.agent, task.index, task.options);
    return result;
  }
}
```

**优先级**: 长期（当前单机够用，但限制了 swarm 规模上限）

### 3.2 预算管理

#### 当前状态

**无任何预算/成本控制**：
- 无 token 上限：agent 可以无限调用 LLM API
- 无成本上限：无美元金额限制
- 无请求频率限制：无 QPS 控制
- `SwarmState.totalTokens` 和 `totalRequests` 只统计不限制

#### 建议：BudgetGuard 中间件

```ts
interface SwarmBudget {
  maxTokens: number;       // 总 token 上限
  maxCostUsd: number;     // 总成本上限（美元）
  maxRequests: number;    // 总 API 请求上限
  maxDurationMs: number;  // 总运行时间上限
}

class BudgetGuard {
  #spent = { tokens: 0, costUsd: 0, requests: 0, startedAt: Date.now() };
  
  check(agentResult: SingleResult): boolean {
    this.#spent.tokens += agentResult.tokens;
    this.#spent.requests += agentResult.requests;
    // 超预算时返回 false，PipelineController 中止后续 wave
    return this.#spent.tokens < this.#budget.maxTokens;
  }
}
```

**集成点**: `PipelineController` 的 `afterWave` hook。

**优先级**: 中期（当前无上限可能导致 API 账单失控）

### 3.3 ContextCompactor 接入

#### 当前状态

`offload/compact.ts` 存在 `compactContext()` 函数和 `DEFAULT_COMPACT_CONFIG`，支持 3 种策略。但：

1. `AgentLauncher.launch()` 中的 `transformContext` 只在 `ctx.offloadManager && ctx.contextWindow` 时调用 `compactContext()`（`agent-launcher.ts:228-238`）
2. `swarm-cli.ts` 创建 `NoopOffloadManager` 传入 factory，因此 `ctx.offloadManager` 永远是 `NoopOffloadManager`
3. `NoopOffloadManager` 的行为是什么？需要确认是否让 `ctx.offloadManager` 为 truthy

**结论**: ContextCompactor 在 CLI 模式下**未接入**。

#### 建议

1. 在 `swarm-cli.ts` 中用真实的 `OffloadManager`（backed by `SessionStorage`）替代 `NoopOffloadManager`
2. 在 `AgentRuntime.spawnOne()` 中设置 `ctx.contextWindow`（从 model 获取 context window 大小）
3. 在 `HookPipeline` 的 `context:beforeCompact` 事件中触发 ContextCompactor

**优先级**: 中期（影响长 context agent 的稳定性）

### 3.4 oh-my-pi 适配层

#### 当前耦合

SatoPi 直接依赖 `@oh-my-pi/*` 系列包的公开 API：

| SatoPi 模块 | 依赖的 oh-my-pi API |
|------------|-------------------|
| `agent-launcher.ts` | `Agent` class, `AgentLoopConfig`, `AgentTool`, `AgentMessage` |
| `executor.ts` | `runSubprocess()`, `AgentDefinition`, `SingleResult` |
| `swarm-cli.ts` | `ModelRegistry`, `Settings`, `discoverAuthStorage()` |
| `core/state.ts` | `SwarmSessionManager`（间接通过 pi-utils） |
| 全局 | `@oh-my-pi/pi-utils` 的 `logger` |

**风险**: oh-my-pi 版本升级（当前 `16.5.0`）如果改变公开 API，SatoPi 直接 break。当前 "0 行修改" 是优势但也是脆弱点。

#### 建议：引入适配层

```ts
// swarm/adapters/agent-adapter.ts
export interface IAgent {
  prompt(task: string): Promise<void>;
  steer(msg: AgentMessage): void;
  // ... 只暴露 SatoPi 需要的 API
}

export class OhMyPiAgentAdapter implements IAgent {
  #agent: Agent;
  // 包装 @oh-my-pi/pi-agent-core 的 Agent class
}
```

**优先级**: 长期（当前 oh-my-pi API 稳定，但升级时适配层可以隔离变更）

### 3.5 WorkflowFsm 形式化验证

#### 当前状态

`WorkflowFsm` 使用 `PHASES` 常量定义 8 个 phase 及其允许转换边。有 "integrity test" 验证图的对称性（`A.allowedTo` 包含 B ↔ `B.allowedFrom` 包含 A）。但：

1. **无死锁检测**: 未验证是否存在 phase A 只能到达 B，B 只能到达 A，形成死循环
2. **无活锁检测**: P0-9 证明了 blocked → stage → blocked 的活锁路径存在
3. **无可达性分析**: 未验证从 idle 出发能否到达所有 phase

#### 建议

1. **静态分析**: 编写脚本构建 phase 转换图，用图论算法检测：
   - 强连通分量（SCC）— 每个 SCC 内的 phase 可以互相到达
   - 死锁 phase — 出度为 0 的非终态 phase
   - 不可达 phase — 从 idle 出发无法到达的 phase

2. **运行时不变量**: 在 `WorkflowFsm.transition()` 中增加 debug 断言：
   ```ts
   // 开发模式下验证：从 idle 到当前 phase 的路径存在
   if (DEBUG) assert(isReachable("idle", this.#phase));
   ```

3. **TLA+ 规范**: 对 WorkflowFsm 编写 TLA+ specification，用 TLC model checker 验证关键属性。

**优先级**: 长期（当前 8 phase 简单可手动验证，但 phase 数量增加后必要）

---

## 第四章：用户交互长期优化建议

### 4.1 当前 UI 架构

SatoPi 有三个用户触点：

| 触点 | 技术 | 文件 | 实时性 |
|------|------|------|--------|
| CLI | stderr 文本 | `cli/swarm-cli.ts` | 事件完成后才输出 |
| TUI Dashboard | 终端渲染 | `swarm/tui/swarm-dashboard.ts` | 依赖 polling StateTracker |
| collab-web | WebSocket relay | `packages/collab-web/` | 实时（relay frame 推送） |

**重要发现**: `collab-web` **不是** swarm 专用 UI。它是通用的协作 web 客户端（用于 `@oh-my-pi/pi-wire` 协议），展示的是 AgentSession 的 transcript + agents，**不展示** swarm 特有的 phase pipeline、topology、wave 进度等信息。

swarm 的实时状态实际上通过 `ActivityLogger` → SSE 推送，但前端没有 swarm 专用的 SSE 消费组件。

### 4.2 TUI Dashboard 延迟问题

#### 当前数据流

```
StateTracker.updateAgent()
  → #persist() (写 SwarmSessionManager + 文件)
  → #onStateChange? (如果设置了回调)

SwarmDashboard (TUI)
  → 轮询 StateTracker.getState() (间隔未知，通常 1-5s)
  → 重新渲染 dashboard
```

**问题**: `StateTracker` 的 `#onStateChange` 回调机制存在但未在 TUI 中使用。TUI 依赖轮询获取状态，导致 5 秒级延迟。

#### 建议：事件驱动渲染

```ts
// TUI 侧
stateTracker.onStateChange((newState) => {
  renderDashboard(newState); // 增量渲染
});
```

### 4.3 幽灵字段修复

#### `SwarmState.totalTokens` 永远为 undefined

- **文件**: `core/state.ts:92`
- **问题**: `SwarmState` 定义了 `totalTokens?: number` 字段，但 `StateTracker` 从不设置此字段。token 统计只在 `PipelineController` 的 `PipelineContext.totalTokens` 中累加，不回写到 `SwarmState`。
- **影响**: 前端永远看到 `totalTokens: undefined`，无法显示 token 消耗。
- **修复**: 在 `PipelineController.afterWave` 中将 `pipelineCtx.totalTokens` 回写到 `StateTracker`。

#### `SwarmState.totalRequests` 同上

- 同 `totalTokens`，`totalRequests` 也只在 `PipelineContext` 中累加，不回写。

#### `roundtablePhase` 字符串匹配脆弱

- **文件**: `core/state.ts:84`
- **问题**: `roundtablePhase` 是字符串类型，前端通过字符串匹配判断当前 roundtable 阶段（如 `"round-1-generating"` / `"round-1-reviewing"`）。字符串格式无 schema 约束，修改一处需要同步改多处。
- **建议**: 改为 discriminated union：
  ```ts
  type RoundtablePhase =
    | { phase: "generating"; round: number }
    | { phase: "reviewing"; round: number }
    | { phase: "converged"; round: number; jaccard: number };
  ```

### 4.4 Topology 全量化

#### 当前状态

`ActivityLogger` 记录 agent 间通信（`broadcast` / `subgroup` / `steering` 事件），前端通过 SSE 接收最近 50 条 activities 构建 topology edges。

**问题**:
1. 只展示最近 50 条 → 历史通信模式丢失
2. 节点状态依赖轮询 → 5s 延迟
3. 边的权重（通信频率）不计算

#### 建议

1. **全量 topology 缓存**: `StateTracker` 维护 `Map<agentPair, communicationCount>`，每次通信事件更新
2. **节点状态 SSE 推送**: `StateTracker.updateAgent()` 触发 SSE 事件
3. **边的动态权重**: 通信频率 × 消息大小 → 边粗细

### 4.5 结构化 Phase 事件

#### 当前问题

`ActivityLogger.logPhase()` 接收字符串参数：

```ts
activityLogger.logPhase("loop-start");
activityLogger.logPhase("stage-wave-1");
activityLogger.logPhase("curtain-extract");
```

前端需要字符串匹配来判断当前 phase 子步骤，格式无保证。

#### 建议

```ts
interface PhaseEvent {
  phase: Chapter;           // "stage" | "curtain" | ...
  subPhase: string;         // "wave-1" | "extract" | "review"
  iteration?: number;
  waveIdx?: number;
  metadata?: Record<string, unknown>;
}

activityLogger.logPhase({
  phase: "stage",
  subPhase: "wave-1",
  waveIdx: 0,
  iteration: 1,
});
```

### 4.6 成本估算显示

#### 当前缺失

无任何成本估算 UI。用户无法知道当前 swarm 运行花费了多少美元。

#### 建议

1. `ModelRegistry` 增加每个 model 的 `pricePerMToken`（input/output 分别定价）
2. `StateTracker` 增加 `totalCostUsd` 字段
3. TUI / 前端显示：`Tokens: 1.2M | Cost: $3.45 | Requests: 89`

### 4.7 运行回放（Run Replay）

#### 当前缺失

swarm 运行结束后，只有 `session.jsonl` 记录了事件历史，但无法回放运行过程。

#### 建议

1. **事件日志格式标准化**: `session.jsonl` 中的每条记录包含 `ts`、`type`、`payload`
2. **回放工具**: `stp swarm replay <session-name>` — 按时间戳顺序重放事件，TUI/dashboard 实时渲染
3. **时间轴控制**: 支持暂停、快进、跳转到特定时间点

**优先级**: 长期（对调试和复盘非常有价值）

---

## 第五章：Swarm 测试完整指南

### 5.1 前置条件

#### 5.1.1 环境准备

```bash
# 1. Clone 仓库
git clone <repo-url> SatoPi
cd SatoPi

# 2. 安装 Bun 1.3.14
curl -fsSL https://bun.sh/install | bash
# 或使用 mise/asdf: mise install bun@1.3.14

# 3. 完整初始化（安装依赖 + 构建 Rust addon + link CLI + link oh-my-pi）
bun run setup
```

**关键**: `bun run setup` 会执行 `scripts/link-omp.sh`，将 `@oh-my-pi/*` 包 link 到本地 workspace。不执行此步骤会导致 swarm 测试全部因模块解析失败。

#### 5.1.2 API Key 配置

Swarm 需要 LLM provider 的 API key 才能运行。通过 `Settings` 配置：

```bash
# 方式 1: 环境变量
export OPENAI_API_KEY="sk-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# 方式 2: stp auth（交互式配置）
bun --cwd=packages/coding-agent src/cli.ts auth
# 然后选择 provider 并输入 key

# 方式 3: 配置文件
# 配置文件位置: ~/.config/stp/settings.json
{
  "providers": {
    "openai": { "apiKey": "sk-..." },
    "anthropic": { "apiKey": "sk-ant-..." }
  }
}
```

#### 5.1.3 ModelRegistry 验证

```bash
# 验证 model registry 能刷新并获取模型列表
bun --cwd=packages/coding-agent src/cli.ts stats
# 应输出可用模型列表
```

### 5.2 测试分层策略

#### Layer 1: 单元测试（已有）

```bash
# 运行 swarm 子系统的 298 个单元测试
cd /root/workspace/realSatoPi/SatoPi
bun test packages/coding-agent/src/swarm/__tests__/

# 预期: 285 pass, 13 fail (依赖缺失导致)
# 修复: 先 bun run setup，再运行
```

**覆盖范围**:
- `agent-runtime.test.ts` — AgentRuntime.spawn() 参数传递
- `executor.test.ts` — executeSwarmAgent 超时/中止
- `pipeline.test.ts` — PipelineController wave 执行
- `workflow-fsm.test.ts` — FSM 状态转换
- `state.test.ts` — StateTracker 持久化
- `behaviors.test.ts` — PhaseBehavior 桥接
- `robustness.test.ts` — 错误恢复
- ... 共 25 个测试文件

#### Layer 2: 集成测试（建议新增）

**测试目标**: 验证 v3 路径的 Agent 能真实启动并产出输出。

```ts
// 建议新增: swarm/__tests__/integration.test.ts
import { test, expect } from "bun:test";
import { AgentRuntime } from "../agent-runtime";
import { AgentLauncher } from "../agent-runtime/agent-launcher";

test("v3 agent produces real output", async () => {
  const launcher = new AgentLauncher(modelRegistry, settings, activityLogger);
  const runtime = new AgentRuntime({
    launcher,
    // ... 真实依赖
  });

  const [handle] = await runtime.spawn([{
    id: "test-agent",
    role: "developer",
    roleSource: "library",
    task: "Echo 'hello world'",
  }]);

  const result = await handle.wait();
  expect(result.output).toContain("hello");
  // 验证工具不是 mock
  expect(result.output).not.toContain("mock");
});
```

#### Layer 3: 端到端测试（建议新增）

**测试目标**: 验证完整 swarm 生命周期（Script → Stage → Curtain）。

```bash
# 建议新增脚本: scripts/swarm-e2e.sh
#!/bin/bash
set -euo pipefail

# 1. 准备 test workspace
mkdir -p /tmp/swarm-test-workspace
cd /tmp/swarm-test-workspace

# 2. 创建 minimal loop.yaml
cat > loop.yaml << 'EOF'
swarm:
  name: e2e-smoke-test
  workspace: .
  mode: loop
  max_iterations: 1
  auto_retry: false
  human_escalation: false
  workers:
    initial: 2
    min: 1
    max: 4
    max_rounds: 1
    rounds_convergence_threshold: 1
  plan_debate:
    enabled: false
  cloners:
    count: 1
  agents: {}
EOF

# 3. 创建 plan.md（CLI 模式下 Script 阶段跳过，需要手动提供）
echo "# Plan\n- [ ] Write hello.txt" > plan.md

# 4. 运行 swarm
bun --cwd=/root/workspace/realSatoPi/SatoPi/packages/coding-agent \
  src/cli.ts swarm run loop.yaml

# 5. 验证输出
test -f .swarm_e2e-smoke-test/session.jsonl
test -f .swarm_e2e-smoke-test/state.json
```

### 5.3 实际运行 Swarm

#### 5.3.1 使用内置 loop.yaml

项目内置了两个测试 YAML：

```bash
cd /root/workspace/realSatoPi/SatoPi

# 完整 loop engineering 配置
cat .stp/loop.yaml
# → 5 iterations, 4 initial workers, plan_debate enabled

# 精简测试配置
cat .stp/loop-test.yaml
# → 2 iterations, 4 initial workers, plan_debate enabled
```

#### 5.3.2 运行命令

```bash
# 方式 1: CLI 直接运行
bun --cwd=packages/coding-agent src/cli.ts swarm run .stp/loop-test.yaml

# 方式 2: 交互式 TUI 模式
bun --cwd=packages/coding-agent src/cli.ts
# 在 TUI 中输入: /swarm run .stp/loop-test.yaml

# 方式 3: npm script
bun run dev -- swarm run .stp/loop-test.yaml
```

#### 5.3.3 运行流程

```
1. parseSwarmYamlFile(yamlPath)
   → 解析 YAML，验证 swarm.name

2. 初始化共享服务
   → authStorage, settings, modelRegistry, experienceStore
   → profileRegistry, markEnvironment, roleAssetManager

3. SessionRegistry.createSession(swarmName)
   → factory 创建 StateTracker, ActivityLogger
   → factory 创建 SwarmRunner (runtime=undefined → legacy 路径)
   → factory 创建 placeholder ScriptManager (CLI 模式下 Script 不可用)

4. SwarmRunner.start()
   → 读取 YAML, 验证 loopConfig
   → 读取 plan.md (stampAndArchivePlanMd)
   → 创建 StageController (runtime=undefined → legacy 路径)
   → stage.run() 异步启动

5. StageController.run()
   → 构建 PipelineController (waves from DAG)
   → PipelineController.executeWaves()
   → 每个 wave: executeSwarmAgent() (legacy 路径)
     → runSubprocess() 启动子进程 agent
     → 子进程执行 agent.task
     → 返回 SingleResult

6. Stage 完成后
   → SwarmRunner.#runCurtainPipeline()
   → ExperienceStore 提取经验
   → 输出 CurtainResult

7. SwarmRunner.waitForCompletion() resolve
   → 输出结果摘要
```

### 5.4 预期行为

#### 成功运行

```
Starting swarm "loop-test"…
Swarm "loop-test" started, waiting for completion…
[Stage] Wave 1/1: [worker-1, worker-2, worker-3, worker-4]
[Stage] worker-1: completed (exit 0, 1.2k tokens)
[Stage] worker-2: completed (exit 0, 0.8k tokens)
[Stage] worker-3: completed (exit 0, 1.5k tokens)
[Stage] worker-4: completed (exit 0, 1.1k tokens)
[Curtain] Extracting experience...
Swarm "loop-test" completed: success
```

#### 运行后产物

```
.swarm-workspace/
├── .swarm_loop-test/           # swarm session 目录
│   ├── session.jsonl            # 完整事件历史
│   ├── state.json               # 最终状态快照
│   ├── context/                 # agent 上下文 artifacts
│   ├── logs/
│   │   ├── worker-1.log
│   │   ├── worker-2.log
│   │   └── orchestrator.log
│   └── experience.db            # SQLite 经验数据库
└── plan.md                      # 任务计划（stamped）
```

### 5.5 排障清单

#### 问题 1: `Cannot find module '@oh-my-pi/*'`

```
error: Cannot find module '@oh-my-pi/pi-utils' from '.../bus.ts'
```

**原因**: 未运行 `bun run setup`
**修复**:
```bash
bun run setup
# 如果只缺 oh-my-pi link:
sh scripts/link-omp.sh
```

#### 问题 2: `No models available in registry`

```
[AgentLauncher] No models available in registry
```

**原因**: API key 未配置或 ModelRegistry 刷新失败
**修复**:
```bash
# 检查 API key
bun --cwd=packages/coding-agent src/cli.ts auth

# 强制刷新 model registry
bun --cwd=packages/coding-agent src/cli.ts stats --refresh
```

#### 问题 3: `Swarm is not in loop mode`

**原因**: YAML 中 `mode` 不是 `loop`
**修复**: 确保 YAML 有 `swarm.mode: loop`

#### 问题 4: Stage 永远不结束（活锁）

**症状**: swarm 运行但永远不完成，agent 持续 sleep 1s 重试
**原因**: P0-9 的 blocked 活锁
**修复**: 设置 `max_iterations` 和 `workers.max_rounds` 限制；或 Ctrl+C 中止

#### 问题 5: `Script phase not available in CLI mode`

**原因**: CLI 模式下 ScriptManager 是 placeholder
**修复**: 预先创建 `plan.md` 放在 swarm workspace 目录；或使用 TUI 模式

#### 问题 6: v3 路径工具全部返回 mock

**症状**: agent 输出包含 `"Tool X executed (mock)"`
**原因**: `AgentRuntime.spawnOne()` 不传 `builtinToolNames` / `toolRegistry`（P0-3）
**当前状态**: CLI 入口不传 `runtime`，全部走 legacy 路径，不受此问题影响。仅 v3 路径有此问题。

#### 问题 7: SQLite 锁错误

```
SQLite3: database is locked
```

**原因**: 多个 swarm session 同时写入同一 ExperienceStore
**修复**: 确保 `cwd` 唯一；或设置 `busy_timeout`

#### 问题 8: 子进程 agent 崩溃但 swarm 继续

**原因**: `executeSwarmAgent` 的 catch 返回 `failResult` 而非 throw，PipelineController 继续 wave
**预期行为**: 这是设计如此——单个 agent 失败不阻止整个 wave
**查看**: 检查 `.swarm_*/logs/<agent-name>.log` 获取崩溃详情

### 5.6 测试配置参考

#### 最小化测试 YAML（无 LLM 依赖，仅验证框架）

```yaml
# .stp/loop-minimal.yaml
swarm:
  name: minimal-test
  workspace: ./test-workspace
  mode: loop
  max_iterations: 1
  auto_retry: false
  human_escalation: false
  workers:
    initial: 1
    min: 1
    max: 1
    max_rounds: 1
    rounds_convergence_threshold: 1
  plan_debate:
    enabled: false
  cloners:
    count: 1
  agents: {}
```

#### 仅测试单元测试（不需要 LLM）

```bash
cd /root/workspace/realSatoPi/SatoPi
bun run setup  # 前置
bun test packages/coding-agent/src/swarm/__tests__/

# 预期: 298 pass, 0 fail (依赖安装后)
```

#### 测试 TUI 渲染（不需要 LLM）

```bash
# TUI 渲染测试不调用 LLM，只验证渲染逻辑
bun test packages/coding-agent/src/swarm/__tests__/tui-panels.test.ts
bun test packages/coding-agent/src/swarm/__tests__/tui-phase-view.test.ts
bun test packages/coding-agent/src/swarm/__tests__/tui-theme.test.ts
```

### 5.7 CI 集成建议

当前 CI (`ci:test:smoke`) 只测 `--version` + `--help` + `--smoke-test`，**不覆盖 swarm**。

建议新增 CI job：

```yaml
# .github/workflows/ci.yml 新增
test_swarm_unit:
  name: Test Swarm (unit)
  runs-on: ubuntu-22.04
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
      with:
        bun-version: "1.3.14"
    - run: bun install
    - run: bun run build:native
    - run: sh scripts/link-omp.sh
    - run: bun test packages/coding-agent/src/swarm/__tests__/
```

**注意**: 不在 CI 中运行 e2e swarm 测试（需要真实 LLM API key + 消耗 token）。

---

## 附录 A：文件索引

### 核心架构文件

| 文件 | 行数 | 职责 |
|------|------|------|
| `swarm/core/swarm-runner.ts` | 234 | 顶层编排器 |
| `swarm/core/pipeline.ts` | ~564 | Wave 执行控制器 |
| `swarm/core/workflow-fsm.ts` | ~628 | Phase 状态机 |
| `swarm/core/state.ts` | ~397 | 内存状态追踪器 |
| `swarm/core/schema.ts` | ~180 | YAML 解析 + 类型定义 |
| `swarm/agent-runtime/index.ts` | 381 | v3 AgentRuntime |
| `swarm/agent-runtime/agent-launcher.ts` | 547 | v3 Agent 启动器 |
| `swarm/executor/executor.ts` | 275 | Legacy 执行器 |
| `swarm/executor/task-queue.ts` | ~212 | 任务队列 + 依赖图 |
| `session/agent-session.ts` | 3,254 | 上帝对象 |
| `cli/swarm-cli.ts` | 222 | CLI 入口 |

### 测试文件

| 文件 | 测试数 | 覆盖范围 |
|------|--------|---------|
| `agent-runtime.test.ts` | ~20 | AgentRuntime 参数传递 |
| `executor.test.ts` | ~15 | 超时/中止/错误路径 |
| `pipeline.test.ts` | ~15 | Wave 执行 |
| `workflow-fsm.test.ts` | ~25 | FSM 转换 |
| `state.test.ts` | ~15 | 持久化 |
| `behaviors.test.ts` | ~10 | PhaseBehavior 桥接 |
| `robustness.test.ts` | ~10 | 错误恢复 |
| ... 共 25 文件 | 298 总计 | 隔离单元测试 |

---

## 附录 B：已有审计文档索引

| 文档 | 位置 | 内容 |
|------|------|------|
| 架构审计 | `docs/architecture-audit-2026-07-27.md` | 54 个 issue（P0-P3） |
| v3 架构设计 | `docs/swarm-architecture-v3.md` | 六层统一架构方案 |
| v3 流程 | `docs/swarm-v3-process.md` | 实施流程 |
| 数据流分析 | `docs/swarm-data-flow-analysis.md` | 数据流图 |
| 架构研究 | `docs/swarm-architecture-research.md` | 前期调研 |
| 突破路径 | `docs/satopi-gap-analysis-breakthrough-path.md` | 差距分析 |
| 战略路线图 | `docs/SatoPi-strategic-roadmap.md` | 长期规划 |
| 架构优化计划 | `docs/architecture-optimization-plan.md` | 优化计划 |

---

## 总结

SatoPi 的 swarm 子系统在架构设计上具有前瞻性（六层统一架构、HookPipeline、ContextPipeline、CommBus），但当前处于 **v3 路径不可用、legacy 路径是唯一可用路径** 的过渡状态。主要风险点：

1. **短期**: 修复 v3 路径的 mock stub + session 为空问题，使其可端到端运行
2. **中期**: 收敛双路径、接入 ContextCompactor、增加预算管理、补全 e2e 测试
3. **长期**: 分布式执行、oh-my-pi 适配层、WorkflowFsm 形式化验证、运行回放

测试方面，当前只能通过 CLI 运行 legacy 路径的 swarm（`stp swarm run .stp/loop.yaml`），需要真实 LLM API key。298 个单元测试覆盖了隔离行为但无集成验证。建议增加分层测试策略（单元 → 集成 → e2e），并在 CI 中加入 swarm 单元测试 job。
