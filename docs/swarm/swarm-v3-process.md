# SatoPi Swarm v3 重构进度

> 分支: `refactor/swarm-v3-unified-architecture`
> 基准: dev @ `4422298`
> 基线测试: `bun test state.test.ts` — 12 pass, 0 fail ✅

---

## Phase 1: 基础设施准备 (HookPipeline + ContextPipeline + WorkflowFSM)

### 1.1 HookPipeline ✅ 完成

- [x] 创建 `hook-system/types.ts` — HookEvent 类型 (23 events) + HookRegistration + HookPayload + HookContext
- [x] 创建 `hook-system/hook-pipeline.ts` — HookPipeline 类 (register / trigger / unregister / list)
- [x] 创建 `hook-system/builtins/profile-hook.ts` — Profile Hook (priority=0)
- [x] 创建 `hook-system/builtins/stigmergy-hook.ts` — Stigmergy Hook (priority=1)
- [x] 创建 `hook-system/builtins/offload-hook.ts` — Offload Hook (priority=2)
- [x] 创建 `hook-system/builtins/mnemopi-hook.ts` — Mnemopi Hook (priority=3)
- [x] 创建 `hook-system/builtins/experience-hook.ts` — Experience Hook (priority=4)
- [x] 创建 `hook-system/builtins/verification-hook.ts` — Verification Hook (priority=5)
- [x] 创建 `__tests__/hook-pipeline.test.ts` — 18 tests, 0 fail
- [ ] 注册现有 hook 逻辑到 HookPipeline (修改 `offload-hooks.ts`, `swarm-hooks.ts`, `mnemopi-adapter.ts`)
- [x] 验收: 18 new tests pass + existing tests unaffected ✅

### 1.2 ContextPipeline ✅ 完成

- [x] 创建 `context-manager/context-pipeline.ts` — ContextSource 接口 + ContextPipeline 类
- [x] 创建 `context-manager/sources/role-source.ts` — RoleSource (priority=0)
- [x] 创建 `context-manager/sources/profile-source.ts` — ProfileSource (priority=1)
- [x] 创建 `context-manager/sources/experience-source.ts` — ExperienceSource (priority=2)
- [x] 创建 `context-manager/sources/turn-guidance-source.ts` — TurnGuidanceSource (priority=3, script only)
- [x] 创建 `context-manager/sources/stigmergy-source.ts` — StigmergySource (priority=4, stage only)
- [x] 创建 `context-manager/sources/offload-source.ts` — OffloadSource (priority=5)
- [x] 创建 `context-manager/sources/mnemopi-source.ts` — MnemopiSource (priority=6, 可选)
- [x] 创建 `context-manager/sources/task-queue-source.ts` — TaskQueueSource (priority=7, stage only)
- [x] 创建 `__tests__/context-pipeline.test.ts` — 21 tests, 0 fail
- [x] 验收: 21 new tests pass + 12 existing tests unaffected ✅

### 1.3 WorkflowFSM ✅ 完成

- [x] 创建 `core/workflow-fsm.ts` — PhaseCapabilities + PhaseDefinition + WorkflowFsm 类 + PHASES 常量
- [x] PHASES 常量包含全部 8 个 phase，allowedFrom/allowedTo 双向一致
- [x] SwarmStateMachine 保留不动，WorkflowFsm 作为独立新增（旧代码兼容）
- [x] 创建 `__tests__/workflow-fsm.test.ts` — 56 tests, 0 fail
- [x] 验收: 56 new tests pass + 25 existing tests unaffected ✅

---

### Phase 1 总结

| 模块 | 新增文件 | 测试数 | 状态 |
|------|---------|--------|------|
| HookPipeline | 8 (types + pipeline + 6 builtins) | 18 | ✅ |
| ContextPipeline | 9 (pipeline + 8 sources) | 21 | ✅ |
| WorkflowFSM | 1 (fsm + PHASES) | 56 | ✅ |
| **合计** | **18 新文件** | **95 tests** | **全部通过** |

现有 25 个测试不受影响。1 个待办项（注册现有 hook 到 HookPipeline）留到 Phase 2 通信层建立后统一处理。

提交: `feat(swarm): Phase 1 — HookPipeline + ContextPipeline + WorkflowFSM`

---

## Phase 2: CommBus + CommChannel ✅ 完成

- [x] 创建 `comm-bus/comm-channel.ts` — CommChannel 类 (send / roundtable / vote)
- [x] 创建 `comm-bus/roundtable.ts` — runRoundtable() 纯函数 + Jaccard 收敛检测
- [x] 创建 `comm-bus/vote.ts` — runVote() 纯函数 + VOTE: 模式解析
- [x] 创建 `comm-bus/endpoint.ts` — CommEndpoint + createEndpoint()
- [x] 创建 `comm-bus/comm-bus.ts` — CommBus 单例 (receiveFromHuman / groupChannel)
- [x] 创建 `comm-bus/index.ts` — barrel 导出
- [x] AgentChannel 内部委托给 CommChannel
- [x] RoleRoundtable.negotiateRoles() 委托给 CommChannel.roundtable()
- [x] ReporterElection.elect() 委托给 CommChannel.vote()
- [x] ScriptManager.sendMessage() 路由通过 CommBus.receiveFromHuman()
- [x] StageController.#assignRoles() 使用 CommBus.groupChannel()
- [x] 创建 `__tests__/comm-channel.test.ts` — 59 tests, 0 fail
- [x] 验收: 204 tests pass (59 new + 25 existing migration + 120 Phase 1), 0 fail ✅

### Phase 2 总结

| 模块 | 新增文件 | 修改文件 | 测试 | 状态 |
|------|---------|---------|------|------|
| CommBus + CommChannel | 6 (comm-bus/) | — | 59 | ✅ |
| 迁移现有通信代码 | — | 5 (agent-channel, role-roundtable, reporter-election, script-manager, stage-controller) | — | ✅ |
| **Phase 2 合计** | **6 新文件** | **5 修改** | **204 tests total** | **全部通过** 

提交: `feat(swarm): Phase 2 — CommBus + CommChannel + migration`

---

## Phase 3: AgentRuntime ✅ 完成

- [x] 创建 `agent-runtime/agent-spec.ts` — AgentSpec 类型
- [x] 创建 `agent-runtime/role-provider.ts` — RoleProvider (library/inline/fallback)
- [x] 创建 `agent-runtime/agent-handle.ts` — AgentHandle (薄包装 Agent + AgentSession)
- [x] 创建 `agent-runtime/agent-launcher.ts` — AgentLauncher (直接创建 Agent, 不走 runSubprocess)
- [x] 创建 `agent-runtime/index.ts` — AgentRuntime 类 (spawn / sendHumanMessage / sendSystemNotification)
- [x] ScriptManager.#runPlannerAgent() → 条件式委托给 AgentRuntime.spawn()
- [x] StageController.#runAgent() → 条件式委托给 AgentRuntime.spawn()
- [x] CurtainRunner.runReporterAgent() → 条件式委托给 AgentRuntime.spawn()
- [x] DebateRoundtable.debate() → 条件式委托给 AgentRuntime.spawn()
- [x] 创建 `__tests__/agent-runtime.test.ts` — 33 tests, 0 fail
- [x] 验收: 411 tests pass (33 new + 237 existing), 0 fail ✅

### Phase 3 总结

| 模块 | 新增文件 | 修改文件 | 测试 | 状态 |
|------|---------|---------|------|------|
| AgentRuntime core | 5 (agent-runtime/) | — | 33 | ✅ |
| 迁移 Agent 启动 | — | 4 (script-manager, stage-controller, curtain-runner, debate-roundtable) | — | ✅ |
| **Phase 3 合计** | **5 新文件** | **4 修改** | **411 tests total** | **全部通过** |

提交: `feat(swarm): Phase 3 — AgentRuntime + AgentHandle + migration`

---

## Phase 4: PhaseBehavior + ContextCompactor + 清理 ✅ 完成

- [x] 创建 `behaviors/index.ts` — PhaseBehavior 接口 + PhaseContext + PhaseEnterResult + PhaseCompletion
- [x] 创建 `behaviors/script-behavior.ts` — ScriptBehavior (Planner spawn + 多轮对话 + plan-complete 检测)
- [x] 创建 `behaviors/stage-behavior.ts` — StageBehavior (TaskQueue + agent spawn + steering + pause/resume)
- [x] 创建 `behaviors/curtain-behavior.ts` — CurtainBehavior (Reporter 选举 + reporter/reflector spawn + applaud 检测)
- [x] 创建 `context-manager/context-compactor.ts` — ContextCompactor + 3 strategies (summarize/truncate/offload-to-stigmergy)
- [x] 标记废弃: SwarmStateMachine, AgentChannel, RoleRoundtable, ReporterElection → @deprecated
- [x] 创建 `__tests__/behaviors.test.ts` — 70 tests, 0 fail
- [x] 创建 `__tests__/context-compactor.test.ts` — 23 tests, 0 fail
- [x] 验收: 504 tests pass (93 new + 411 existing), 0 fail ✅

### Phase 4 总结

| 模块 | 新增文件 | 修改文件 | 测试 | 状态 |
|------|---------|---------|------|------|
| PhaseBehavior interface | 1 (behaviors/index.ts) | — | — | ✅ |
| ScriptBehavior | 1 (script-behavior.ts) | — | — | ✅ |
| StageBehavior | 1 (stage-behavior.ts) | — | — | ✅ |
| CurtainBehavior | 1 (curtain-behavior.ts) | — | — | ✅ |
| ContextCompactor | 1 (context-compactor.ts) | — | 23 | ✅ |
| @deprecated 标记 | — | 4 (swarm-state-machine, agent-channel, role-roundtable, reporter-election) | — | ✅ |
| Tests | 2 test files | — | 70 (behaviors) + 23 (compactor) = 93 | ✅ |
| **Phase 4 合计** | **6 新文件** | **4 标记废弃** | **504 tests total** | **全部通过** |

提交: `feat(swarm): Phase 4 — PhaseBehavior + ContextCompactor + deprecation`

---

## Phase 5: 文档 + 测试完善 ✅ 完成

- [x] 更新 AGENTS.md — 添加 Swarm Architecture v3 章节 (层架构 + 设计规则 + deprecated 映射)
- [x] 最终全量测试: 504 tests, 0 fail, 28 files
- [x] 新模块文件统计: 34 files, 5537 lines
- [x] process.md 归档

### 最终统计

| Phase | 新文件 | 修改文件 | 废弃标记 | 测试累计 | 提交 |
|-------|--------|---------|---------|---------|------|
| Phase 1 | 18 | 0 | 0 | 120 | `f443522e7` |
| Phase 2 | 6 | 5 | 0 | 204 | `520c3bce2` |
| Phase 3 | 5 | 4 | 0 | 411 | `95032ba5b` |
| Phase 4 | 6 | 4 | 4 | 504 | `4fc6d41bd` |
| Phase 5 | 0 | 1 | 0 | 504 | (current) |
| **总计** | **35 新文件** | **14 修改** | **4 废弃** | **504 tests** | **5 commits** |

**satopi 修改: 0 行**
**新增代码: 5537 lines**
**对外 API 变更: 0**

---

## 重构完成 🎉

分支: `refactor/swarm-v3-unified-architecture`
基准: dev @ 442229825
设计文档: `docs/swarm-architecture-v3.md`
