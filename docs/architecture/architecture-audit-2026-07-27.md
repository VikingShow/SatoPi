# SatoPi 架构审计报告 — 2026-07-27

基于对最新代码（Phase 4-6 + cleanup 提交后）的全面审计，覆盖 `swarm/`、`agent-runtime/`、`registry/`、`hook-system/`、`coordination/`、`context-manager/`、`comm-bus/`、`stage/`、`session/` 等全部子系统。

---

## P0 — 运行时崩溃 Bug（10 个）

### P0-1: `RoleSource.build()` — `fragment` 变量未声明（Phase 4 回归）

- **文件**: `packages/coding-agent/src/swarm/context-manager/sources/role-source.ts:33-37`
- **原因**: Commit `e2e60f8af` 修复 "RoleSource duplication bug" 时，删除了 `const fragment: ContextFragment = {};` 声明但保留了 `fragment.tools = ...` 和 `return fragment;` 引用
- **影响**: 任何有 tools 的 role 触发 `RoleSource.build()` 时抛出 `ReferenceError`。由于 RoleSource 是最高优先级 source（priority 0），每个 agent 每个 phase 都会调用，**必然崩溃**
- **修复**: 加回 `const fragment: ContextFragment = {};`

### P0-2: `AgentSpec` 接口缺少 `profileId` 字段

- **文件**: `packages/coding-agent/src/swarm/agent-runtime/agent-spec.ts:15-42` vs `agent-runtime/index.ts:328`
- **原因**: `AgentRuntime.spawnOne()` 访问 `spec.profileId`，但 `AgentSpec` 接口未定义该字段
- **影响**: `spec.profileId` 永远是 `undefined`，持久化 agent 注册代码路径**永远不会执行**
- **修复**: `AgentSpec` 接口加 `profileId?: string;`

### P0-3: `AgentLauncher` — 全部 Tool 是 Mock Stub

- **文件**: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts:154-165`
- **原因**: 所有 tool 的 `execute` 函数返回 `"Tool ${name} executed (mock)"`
- **影响**: 通过 v3 `AgentRuntime.spawn()` 启动的所有 agent **无法执行任何真实工具**（Read/Write/Bash/Grep 全部返回 mock 文本）
- **修复**: 需要设计决策 — 接入真实 tool 执行系统

### P0-4: `AgentLauncher` — `session` 为空对象

- **文件**: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts:229`
- **原因**: `const session = {}; // Placeholder`
- **影响**: `AgentRuntime.spawnOne()` 将此 `{}` 转型为 `AgentSession` 传给 `AgentRegistry.setSession()`。任何访问 `.dispose()` 等方法的代码抛出 `TypeError`
- **修复**: 需要设计决策 — 创建真正的 AgentSession 或调整接口

### P0-5: `ScriptManager.#abortController` 从未初始化

- **文件**: `packages/coding-agent/src/swarm/script/script-manager.ts:81, 283, 347, 377`
- **原因**: 字段声明为 `null`，在 `finally` 中重置为 `null`（line 377），但**整个文件中从未赋值 `new AbortController()`**
- **影响**: `cancel()` 完全失效 — `this.#abortController?.abort()` 永远是 no-op
- **修复**: 在 Planner 启动前加 `this.#abortController = new AbortController();`

### P0-6: `agent-profile.ts` — `profileId` 路径穿越

- **文件**: `packages/coding-agent/src/agent/agent-profile.ts:613`
- **原因**: `profileId` 未 sanitize 直接拼接到文件路径 `${profilesDir}/${p.profileId}.json`
- **影响**: `profileId = "../../etc/passwd"` 可写入任意文件
- **修复**: sanitize `profileId`，拒绝包含 `/`、`\`、`..` 的值

### P0-7: `executeSwarmAgent` — 自定义 Executor 无限递归

- **文件**: `packages/coding-agent/src/swarm/executor/executor.ts:130-131`
- **原因**: `options.executor !== defaultExecutor` 用引用相等判断。若传入 `new SubprocessAgentExecutor()`（非单例），`execute()` → `executeSwarmAgent()` → 再次 `execute()` → 无限递归 → 栈溢出
- **修复**: 用 constructor name 或 Symbol-branded guard 替代 reference equality

### P0-8: `RegionLockManager.create()` — 覆盖全局单例

- **文件**: `packages/coding-agent/src/coordination/region-lock.ts:51-54`
- **原因**: `create()` 同时设置 `RegionLockManager.#instance = mgr`，覆盖全局单例
- **影响**: 测试调用 `create()` 后，所有 `global()` 调用返回测试实例，测试间互相污染
- **修复**: `create()` 不应修改 `#instance`

### P0-9: `StageController` — 全部任务 blocked 时无限轮询活锁

- **文件**: `packages/coding-agent/src/swarm/stage/stage-controller.ts:389-394`
- **原因**: `queue.block()` 不传 `fixTask` 时，blocked 任务永不恢复 + ready queue 为空 + `isAllComplete` 永不为 true
- **影响**: 所有任务 blocked 时 agent 永远循环 sleep 1s 重试，无退出机制
- **修复**: 增加 blocked 任务超时或全部-blocked 检测

### P0-10: `TaskQueue.block()` — 孤儿依赖者

- **文件**: `packages/coding-agent/src/swarm/executor/task-queue.ts:197-212`
- **原因**: `#computeReady()` 只在有 `fixTask` 时调用。无 `fixTask` 时，已满足依赖的其他 pending 任务永远不被重新评估
- **影响**: blocked 任务的依赖者（可能已满足所有其他依赖）被永久卡在 pending 状态
- **修复**: `block()` 应始终调用 `#computeReady()`

---

## P1 — 严重设计缺陷（13 个）

### P1-1: 双重执行路径 — Legacy vs v3 AgentRuntime

- **文件**: `executor.ts` + `agent-runtime/` 全目录
- **问题**: 
  - Legacy（`runSubprocess` 子进程）完整但工具限制大
  - v3（`AgentRuntime` 进程内）工具全是 mock，`session` 为空对象
  - `StageController` 使用 legacy，`DebateRoundtable` 有分叉路径，`ScriptManager` 两套都支持
- **影响**: 两套半成品并存，无法判断哪个是真实路径
- **修复**: 需要全局设计决策 — 统一到一条路径

### P1-2: `agent-session.ts` — 16,978 行上帝对象

- **文件**: `packages/coding-agent/src/session/agent-session.ts`
- **问题**: 整个 agent 生命周期、消息处理、工具执行、compaction、provider 交互全在一个文件
- **影响**: 不可维护、不可测试、任何改动有不可预见副作用
- **修复**: **当前不修改**，需要专门的分解重构计划

### P1-3: `WorkflowFsm.waitForHumanDecision()` — Promise 泄漏

- **文件**: `packages/coding-agent/src/swarm/core/workflow-fsm.ts:506-508`
- **原因**: `this.#humanResolve = null;` 不先 reject 旧 Promise
- **影响**: 旧调用者永远挂起，内存泄漏
- **修复**: 覆盖前 reject 旧 Promise

### P1-4: `AgentRegistry.register()` — 重复 ID 静默覆盖

- **文件**: `packages/coding-agent/src/registry/agent-registry.ts:105`
- **原因**: `this.#refs.set(ref.id, ref)` 静默覆盖
- **影响**: 旧 ref 的 session 未被 dispose → 资源泄漏
- **修复**: 重复 ID 时先 unregister 旧 ref（含 session dispose）

### P1-5: `AgentLifecycleManager` — park/release/revive 状态不一致

- **文件**: `packages/coding-agent/src/registry/agent-lifecycle.ts:140-148, 209-222, 198-205, 79`
- **问题**: 多个路径存在状态分裂 bug：
  - `park()` 中途抛异常 → session 部分 dispose，status 未更新
  - `release()` 对未 adopt 的 agent dispose session 但 registry 残留引用
  - `revive()` 失败后 `#adopted` 残留 broken reviver
  - `global()` 忽略构造时传入的自定义 registry
- **修复**: 每个路径需要完整的状态回滚

### P1-6: `SwarmRunner.start()` — 再次调用 orphan 上一个 waitForCompletion()

- **文件**: `packages/coding-agent/src/swarm/core/swarm-runner.ts:110`
- **原因**: `this.#completionPromise = Promise.withResolvers<void>()` 替换旧 Promise 不 resolve
- **影响**: 旧 `waitForCompletion()` 调用者永远挂起
- **修复**: 替换前 resolve/reject 旧 Promise

### P1-7: `DebateRoundtable` v3 路径用 `Promise.all` 替代 `allSettled`

- **文件**: `packages/coding-agent/src/swarm/script/debate-roundtable.ts:148`
- **原因**: v3 路径用 `Promise.all`，fallback 路径用 `Promise.allSettled`
- **影响**: v3 路径一个 agent 失败 → 全部结果丢失
- **修复**: v3 路径改用 `Promise.allSettled`

### P1-8: `PipelineController` wave 无并发上限

- **文件**: `packages/coding-agent/src/swarm/core/pipeline.ts:352`
- **原因**: `Promise.all(wave.map(...))` 全部 agent 同时启动
- **影响**: 100 agent 同时启动耗尽系统资源（FD、内存）
- **修复**: 增加 p-limit 风格的并发上限

### P1-9: `ExperienceStore.close()` 永不调用 → SQLite 连接泄漏

- **文件**: `packages/coding-agent/src/swarm/curtain/experience.ts:813-816`
- **原因**: `close()` 方法存在但 Curtain pipeline 从不调用
- **影响**: SQLite 连接随进程生命周期泄漏
- **修复**: Curtain pipeline 结束时调用 `close()`

### P1-10: `agent-session.beginDispose()` — 异步 cleanup 前设 disposed

- **文件**: `packages/coding-agent/src/session/agent-session.ts:6117-6125`
- **原因**: `this.#isDisposed = true` 在 `#doDispose` 完成前设置
- **影响**: await gap 期间其他代码看到 `isDisposed=true` 但资源仍在半开状态
- **修复**: **当前不修改**（属于 agent-session.ts 大文件重构范围）

### P1-11: `SessionRegistry.forkSession()` — 丢弃 fork 结果

- **文件**: `packages/coding-agent/src/swarm/session/session-registry.ts:255`
- **原因**: `await parent.sessionManager.fork()` 返回值丢弃
- **影响**: 子 session 被独立创建（空历史），parent 的历史从未被 fork 继承
- **修复**: 使用 fork 返回的 session 路径创建子 session

### P1-12: `SwarmSessionManager.rotate()` — 部分失败导致 closed session

- **文件**: `packages/coding-agent/src/swarm/session/swarm-session-manager.ts:235-241`
- **原因**: `close()` 成功后 `create()` 失败 → 实例留下 closed `#session`
- **影响**: 后续任何操作崩溃
- **修复**: 增加 rollback 或 reopen 逻辑

### P1-13: 单行 JSON 损坏 → 全部 session 数据丢失

- **文件**: `packages/coding-agent/src/swarm/session/swarm-session-manager.ts:269-271`
- **原因**: `JSON.parse` 失败时 catch 返回 `[]`
- **影响**: 一行坏 JSON → 全部 session entries 丢失
- **修复**: 逐行 parse，跳过坏行

---

## P2 — 关键问题（14 个）

### P2-1: `HookPayload` 完全无类型（`[key: string]: unknown`）

- **文件**: `packages/coding-agent/src/swarm/hook-system/types.ts:75-77`
- **问题**: 所有 builtin hook 都在运行时做 `typeof payload.xxx === "string"` 检查，编译期零保障
- **修复**: 定义为 discriminated union 或使用 zod/arktype schema

### P2-2: `resolveAgentId()` 在 3 个 builtin hook 中重复实现

- **文件**: `profile-hook.ts:98-102`, `stigmergy-hook.ts:113-120`, `offload-hook.ts:102-109`
- **修复**: 抽取到共享工具模块

### P2-3: `sdk.ts` `afterToolCall` 对 subagent 硬编码 `agentId: "main"`

- **文件**: `packages/coding-agent/src/sdk.ts:2844`
- **问题**: stigmergy mark 身份错误 — 所有 subagent 的 tool call 都以 "main" 身份记录
- **修复**: 使用实际 agentId

### P2-4: `RegionLockManager` 锁永不过期 + 路径标准化不完整

- **文件**: `packages/coding-agent/src/coordination/region-lock.ts:86-108, 164-167`
- **问题**: 无 TTL、`#normalizePath` 不解析 `..` 和 `.`
- **修复**: 增加 TTL + 使用 `path.resolve`

### P2-5: `AgentLauncher.getApiKey` 静默吞错误 + `#startAgent` fire-and-forget

- **文件**: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts:214-217, 236, 343-387`
- **修复**: 加错误日志 + await `#startAgent` 的 Promise

### P2-6: `WorkflowFsm` timed transition 选第一个 target + `void` 吞失败

- **文件**: `packages/coding-agent/src/swarm/core/workflow-fsm.ts:565-571`
- **修复**: 允许配置 target + 处理失败

### P2-7: `PipelineController.afterPipeline` hook 在 fatal error 时不调用

- **文件**: `packages/coding-agent/src/swarm/core/pipeline.ts:294-308`
- **修复**: 在 catch 路径也调用 `afterPipeline`

### P2-8: `MarkEnvironment.getSummary()` 和 `serialize()` 包含过期 mark

- **文件**: `packages/coding-agent/src/coordination/mark-environment.ts:328-340, 358-375`
- **修复**: 调用前执行 `#decayExpired()`

### P2-9: `StageController` 双完成信号可能不一致

- **文件**: `packages/coding-agent/src/swarm/behaviors/stage-behavior.ts:289-336`
- **问题**: `#completedAgents`（事件驱动）vs `handle.status`（实时状态）可能分歧
- **修复**: 统一到单一数据源

### P2-10: `ScriptBehavior` 无 `"aborted"` status 处理

- **文件**: `packages/coding-agent/src/swarm/behaviors/script-behavior.ts:141-173`
- **问题**: Agent 被 abort 后 `handleAgentEvent` 不更新任何状态 → 永远不 completion
- **修复**: 增加 `"aborted"` case

### P2-11: `agent-profile.ts` atomic save 失败 + `deserialize` 不验证

- **文件**: `packages/coding-agent/src/agent/agent-profile.ts:546-561, 612-616`
- **修复**: atomic save 增加清理逻辑 + deserialize 验证必填字段

### P2-12: `ExperienceStore` FTS5 catch 吞掉致命 DB 错误

- **文件**: `packages/coding-agent/src/swarm/curtain/experience.ts:480-505`
- **修复**: 区分 FTS5 语法错误和致命 DB 错误

### P2-13: `WorkflowFsm` 无 `dispose()` 方法

- **文件**: `packages/coding-agent/src/swarm/core/workflow-fsm.ts:556`
- **问题**: timer 保持闭包阻止 GC
- **修复**: 增加 `dispose()` 清除 timer + listeners

### P2-14: `AgentLauncher` steering 消息只在 pre-load 注入一次

- **文件**: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts:222-224, 351-356`
- **问题**: pre-load 后无法推送后续人类消息到运行中 agent
- **修复**: 在 AgentLoopConfig 中注入 `getSteeringMessages` 回调

---

## P3 — 代码质量（17 个）

| # | 问题 | 文件 |
|---|---|---|
| P3-1 | `LoopSwarmConfig` 20+ 嵌套配置项，功能间隐式交互 | `core/schema.ts:66-180` |
| P3-2 | `StateTracker.#persist()` 共享引用快照 + 错误静默吞 | `core/state.ts:378-396` |
| P3-3 | `ScriptManager.parsePlannerResponse()` ~80 行死代码 | `script/script-manager.ts:464` |
| P3-4 | `extractor.ts` `parseFindingTags()` 死代码 | `curtain/extractor.ts:135-156` |
| P3-5 | `AgentHandle` 消息缓冲区 `messages[]` 无上限 | `agent-runtime/agent-handle.ts:281` |
| P3-6 | `ModeContextSource` idle/paused/blocked → "standalone" | `context-manager/sources/mode-source.ts:50-51` |
| P3-7 | 注释语言混用（中文/英文）| `swarm-hooks.ts`, `mark-environment.ts` |
| P3-8 | `PipelineController` dynamic agents `allResults.get()!.push()` NPE 风险 | `core/pipeline.ts:267` |
| P3-9 | `ActivityLogger` SSE stream 绕过 `#writeQueue` → 乱序 | `hooks/activity-logger.ts:292-304` |
| P3-10 | `irc.ts` `error === awaitCancelled` 引用相等可能失败 | `tools/irc.ts:252-263` |
| P3-11 | `conflict-detect.ts` 边界 echo trim 依赖 crude delimiter balance | `tools/conflict-detect.ts:403-446` |
| P3-12 | `mnemopi-adapter.ts` 32-bit hash 碰撞 → false dedup | `hooks/mnemopi-adapter.ts:248-256` |
| P3-13 | `DebateRoundtable` `#synthesizeFinalPlan` 选最长输出 | `script/debate-roundtable.ts:373-381` |
| P3-14 | `DebateRoundtable` `jaccardSimilarity` 两空 text 返回 1.0 | `script/debate-roundtable.ts:69` |
| P3-15 | `DebateRoundtable` similarity threshold 0.85 不可配置 | `script/debate-roundtable.ts:227` |
| P3-16 | `RoleProvider.modelRole` 永远 hardcode `"normal"` → 死字段 | `agent-runtime/role-provider.ts:93,118` |
| P3-17 | `AgentLifecycleManager.global()` 忽略构造时自定义 registry | `registry/agent-lifecycle.ts:79` |

---

## 汇总统计

| 严重度 | 数量 |
|---|---|
| P0 运行时崩溃 Bug | 10 |
| P1 严重设计缺陷 | 13 |
| P2 关键问题 | 14 |
| P3 代码质量 | 17 |
| **总计** | **54** |
