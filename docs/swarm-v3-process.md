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

## Phase 2: CommBus + CommChannel

- [ ] 创建 `comm-bus/channel.ts` — CommChannel 类
- [ ] 创建 `comm-bus/roundtable.ts` — roundtable() 实现
- [ ] 创建 `comm-bus/vote.ts` — vote() 实现
- [ ] 创建 `comm-bus/endpoint.ts` — CommEndpoint 类
- [ ] 创建 `comm-bus/index.ts` — CommBus 类
- [ ] AgentChannel 内部委托给 CommChannel
- [ ] RoleRoundtable 内部委托给 CommChannel.roundtable()
- [ ] ReporterElection 内部委托给 CommChannel.vote()
- [ ] 创建测试文件
- [ ] 验收: `bun test comm-bus/` 全部通过 + 现有测试不受影响 ✅

---

## Phase 3: AgentRuntime

- [ ] 创建 `agent-runtime/agent-spec.ts` — AgentSpec 类型
- [ ] 创建 `agent-runtime/role-provider.ts` — RoleProvider
- [ ] 创建 `agent-runtime/agent-handle.ts` — AgentHandle
- [ ] 创建 `agent-runtime/agent-launcher.ts` — AgentLauncher
- [ ] 创建 `agent-runtime/index.ts` — AgentRuntime 类
- [ ] ScriptManager.#runPlannerAgent() → AgentRuntime.spawn()
- [ ] StageController.#runAgent() → AgentRuntime.spawn()
- [ ] CurtainRunner.runReporterAgent() → AgentRuntime.spawn()
- [ ] 创建测试文件
- [ ] 验收: `bun test agent-runtime/` 全部通过 + 现有测试不受影响 ✅

---

## Phase 4: PhaseBehavior + 清理

- [ ] 创建 `behaviors/index.ts` — PhaseBehavior 接口 + PhaseContext 类型
- [ ] 创建 `behaviors/script-behavior.ts` — ScriptBehavior
- [ ] 创建 `behaviors/stage-behavior.ts` — StageBehavior
- [ ] 创建 `behaviors/curtain-behavior.ts` — CurtainBehavior
- [ ] 创建 `context-manager/context-compactor.ts` — ContextCompactor
- [ ] 清理废弃代码: SwarmStateMachine, AgentChannel, RoleRoundtable, ReporterElection → deprecated
- [ ] 验收: 所有 Phase 通过 WorkflowFsm + PhaseBehavior 运行 ✅

---

## Phase 5: 文档 + 测试完善

- [ ] Swarm GUI 适配 (基于 WorkflowFsm.state 渲染)
- [ ] Collab 集成 (Guest as CommEndpoint)
- [ ] 端到端集成测试
- [ ] 更新 AGENTS.md
- [ ] 归档 process.md
