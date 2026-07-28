# Plan: Native Swarm Primitives — AgentSession-Level Refactor (v3)

## Overview
将 swarm 能力从 `swarm/` 子系统下沉到 `AgentSession` 层。`Agent` 和 `AgentLoopConfig` 零变更。同时删除 `AgentHandle`（并入 `AgentSession`）、废弃 `AgentSpec`（统一为 `AgentSessionOptions`）、拆分 `AgentSession` 超大类。

## 关键设计决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | `persistent` 属于 Session 层 | 跨 session 身份连续性 = session 职责 |
| D2 | `Agent` / `AgentLoopConfig` 零变更 | 只管 loop，不管身份 |
| D3 | `ProfileRegistry` 拥有 profile | 跨 session 生命周期，AgentSession 只存 `persistentProfileId` 引用 |
| D4 | `RoleProvider` 移出 swarm | 角色解析是通用能力，非 swarm 专属 |
| D5 | `AgentHandle` 删除 | `AgentSession.wait()` 替代，减少中间层 |
| D6 | `AgentSpec` → `AgentSessionOptions` 统一 | 一条创建路径，AgentRuntime 内部翻译 |
| D7 | `MarkEnvironment` 始终创建 | stigmergy 是所有 session 的基础能力 |
| D8 | Mark 实时性 | lock 已实时（RegionLockManager），其余 turn 级延迟可接受 |
| D9 | `CommBus` 合并进 `IrcBus` | 薄封装不值得独立存在 |
| D10 | `GraphEngine` 独立 DAG 执行器 | 不绑定 swarm lifecycle |

---

## Phase 1: AgentSession 能力层

**Contract:** `AgentSession` 获得 `kind`, `persistentProfileId`, `markEnvironment`。`AgentSession.wait()` 替代 `AgentHandle`。

- [ ] **Task: 给 AgentSession 加 kind, persistentProfileId, markEnvironment, wait()**
  - Files: `packages/coding-agent/src/session/agent-session.ts`
  - Change: 加 `kind: AgentKind`（默认 `"sub"`）、`persistentProfileId?: string`、`markEnvironment: MarkEnvironment`（默认 `new MarkEnvironment()`）。加 `async wait(): Promise<SingleResult>`。加 `get profile(): AgentProfile | undefined` 委托给 `ProfileRegistry.global().get()`。
  - Acceptance: `session.markEnvironment` 始终可用。`session.profile` 可查询 persistent 身份。`session.wait()` 返回 agent 完成结果。

- [ ] **Task: 拆分 AgentSession — 提取 SessionCompactor**
  - Files: `packages/coding-agent/src/session/agent-session.ts`, 新文件 `packages/coding-agent/src/session/session-compactor.ts`
  - Change: 提取 `#compactContext`、`#shouldCompact`、压缩状态管理到 `SessionCompactor`。AgentSession 组合使用。
  - Acceptance: `SessionCompactor` 独立可测。AgentSession 减少 ~500 行。

- [ ] **Task: 拆分 AgentSession — 提取 SessionLifecycle**
  - Files: `packages/coding-agent/src/session/agent-session.ts`, 新文件 `packages/coding-agent/src/session/session-lifecycle.ts`
  - Change: 提取 `dispose()`、`beginDispose()`、park/revive 相关逻辑到 `SessionLifecycle`。AgentSession 组合使用。
  - Acceptance: `SessionLifecycle` 独立可测。AgentSession 减少 ~300 行。

---

## Phase 2: AgentHandle 删除 + AgentSpec 废弃

**Contract:** `AgentSession.wait()` 替代 `AgentHandle`。`AgentRuntime.spawn()` 接受 `AgentSessionOptions`。

- [ ] **Task: 删除 AgentHandle，迁移所有调用方到 AgentSession.wait()**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/agent-handle.ts`, 所有 import AgentHandle 的文件
  - Change: 删除 `AgentHandle` 类。`AgentRuntime.spawn()` 返回 `AgentSession[]`。所有 `handle.wait()` → `session.wait()`，`handle.send()` → `session.steer()`，`handle.abort()` → `session.abort()`。`AgentRegistry.setHandle()` → `AgentRegistry.attachSession()`。
  - Acceptance: 零 AgentHandle import。所有测试通过。

- [ ] **Task: AgentRuntime.spawn() 接受 AgentSessionOptions**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/index.ts`, `packages/coding-agent/src/swarm/agent-runtime/agent-spec.ts`
  - Change: `AgentRuntime.spawn()` 签名改为接受 `AgentSessionOptions[]`。内部映射旧的 `AgentSpec` 调用方。在 `agent-spec.ts` 加 `@deprecated`。更新 `agent_invoke`、`node-behavior`、`debate-roundtable` 等调用方直接传 `AgentSessionOptions`。
  - Acceptance: `AgentSpec` 标记 deprecated。新代码直接用 `AgentSessionOptions`。

---

## Phase 3: RoleProvider 移出 swarm + profile role 实现

**Contract:** `RoleProvider` 在 `packages/coding-agent/src/agent/`。`roleSource: 'profile'` 可用。

- [ ] **Task: 移动 RoleProvider 到共享位置**
  - Files: `packages/coding-agent/src/swarm/agent-runtime/role-provider.ts` → `packages/coding-agent/src/agent/role-provider.ts`
  - Change: 移动文件。更新所有 import。swarm 旧文件删除。
  - Acceptance: `RoleProvider` 可从 `packages/coding-agent/src/agent/role-provider` 导入。

- [ ] **Task: 实现 roleSource 'profile'**
  - Files: `packages/coding-agent/src/agent/role-provider.ts`, 新文件 `packages/coding-agent/src/swarm/prompts/role-profile.md`
  - Change: 加 `resolveFromProfile(profile: AgentProfile): ResolvedRole`。从 `AgentProfile` 读取 identity（name, archetype）、expertise（domains, proficiency）、credit（score, successRate）、offloadRefs（历史摘要）。用 Handlebars 模板生成系统提示词。按 proficiency 选择工具。修复 `AgentSpec` 类型——`roleSource === 'profile'` 时 `profileId` 必需（discriminated union）。
  - Acceptance: Persistent agent 的角色由履历塑造。类型安全。

---

## Phase 4: agent_invoke 全局可用

**Contract:** 不依赖 `AgentRuntime`，任何 session 可调用。

- [ ] **Task: agent_invoke 移除 AgentRuntime 依赖**
  - Files: `packages/coding-agent/src/tools/agent-invoke.ts`
  - Change: 移除 `context.agentRuntime` 检查。查找 `AgentRegistry` 中同 `profileId` 的 idle session → 复用 `session.prompt(task)` 或创建新 `AgentSession({ kind: "persistent", persistentProfileId: profileId })`。任务完成后自动调用 `ProfileRegistry.recordTaskCompleted()`。
  - Acceptance: 主 CLI session 中 `agent_invoke` 可用。Hidden 条件：当 `ProfileRegistry` 无已注册 profile 时隐藏。

---

## Phase 5: MarkEnvironment + Offload 会话级默认

**Contract:** 所有 session 有 stigmergy。Persistent session 自动 offload。

- [ ] **Task: createAgentSession 始终创建 MarkEnvironment**
  - Files: `packages/coding-agent/src/sdk.ts`
  - Change: `markEnvironment` 默认 `new MarkEnvironment()`。`afterToolCall` 无条件放置文件变更 mark。`StigmergySource` 注册到 `contextPipeline`（若提供）。
  - Acceptance: 所有 session 的 write/edit 留下 stigmergic mark。

- [ ] **Task: Persistent session 自动启用 OffloadManager**
  - Files: `packages/coding-agent/src/sdk.ts`
  - Change: `kind === "persistent"` 时创建 `OffloadManager`，注入 `transformContext`。offload refs 写入 `ProfileRegistry`。删除 swarm 中的重复 offload 设置。
  - Acceptance: Persistent session 自动 L1→L3 offload。

---

## Phase 6: CommBus → IrcBus 合并

**Contract:** `IrcBus` 获得 `receiveFromHuman` + `groupChannel`。`CommBus` 删除。

- [ ] **Task: IrcBus 加 receiveFromHuman + groupChannel**
  - Files: `packages/coding-agent/src/irc/bus.ts`
  - Change: 加入两个方法。`groupChannel` 返回 `CommChannel`（保留 comm-channel.ts）。
  - Acceptance: IrcBus 具备 CommBus 全部能力。

- [ ] **Task: 删除 CommBus，迁移消费者**
  - Files: `packages/coding-agent/src/swarm/comm-bus/comm-bus.ts`, 所有 import CommBus 的文件
  - Change: 删除 `CommBus` 类。`AgentRuntime`、`EmbeddedSwarmBridge`、`GraphRunner`、所有 behavior 改用 `IrcBus` 直接调用。
  - Acceptance: 零 CommBus import。所有通信功能正常。

---

## Phase 7: GraphEngine 独立

**Contract:** `GraphEngine` 独立于 swarm lifecycle。`GraphRunner` 变薄适配器。

- [ ] **Task: 从 GraphRunner 提取 GraphEngine**
  - Files: `packages/coding-agent/src/swarm/graph/graph-runner.ts`, 新文件 `packages/coding-agent/src/graph/graph-engine.ts`
  - Change: 提取 DAG 核心循环（WaveScheduler、节点执行、upstream 收集、gate 评估）到 `GraphEngine`。接受 `GraphDefinition` + `NodeExecutor` 接口。`GraphRunner` 实现 `NodeExecutor`，调用 `AgentRuntime.spawn()` 或直接 `createAgentSession()`。
  - Acceptance: `GraphEngine` 可独立使用，无 swarm 依赖。

- [ ] **Task: 图类型移到共享模块**
  - Files: `packages/coding-agent/src/swarm/graph/schema.ts` → `packages/coding-agent/src/graph/types.ts`
  - Change: 移动 `GraphDefinition`、`NodeDefinition`、`GateSpec`、`NodeContext`。swarm/graph 重新导出。
  - Acceptance: 图类型无需 swarm import。

---

## Phase 8: TUI 原生集成

**Contract:** 面板从 `AgentRegistry` + `AgentSession` 渲染，非 overlay。

- [ ] **Task: 面板改用 AgentRegistry + AgentSession 通用状态**
  - Files: `packages/coding-agent/src/modes/components/swarm/agent-panel.ts`, `context-panel.ts`
  - Change: Agent 状态从 `AgentRegistry.global().list()` 读。上下文从 `AgentSession` 读。保留 `StateTracker` 用于 swarm 编排指标（wave、iteration、praiseCount 等）的增强显示。
  - Acceptance: 面板在任何多 agent session 中正确渲染。

- [ ] **Task: Dashboard 内联，删除 overlay 模式**
  - Files: `packages/coding-agent/src/modes/components/swarm/swarm-dashboard-overlay.ts`, `interactive-mode.ts`
  - Change: `AgentRegistry.list().length > 1` 或 `GraphEngine` 活跃时，主 TUI 内联显示多 agent 面板。不再切换到独立 swarm overlay。保留 overlay 组件为可选（用户可手动切换）。
  - Acceptance: 多 agent 面板自动出现。单 agent session 不显示 panel。

---

## Phase 9: Verification

- [ ] **Task: 冒烟测试 — agent_invoke, agent://, graph execution, AgentHandle 迁移**
- [ ] **Task: 全量测试 + biome zero errors**
- [ ] **Task: 确认 AgentHandle 零残留、CommBus 零残留、AgentLoopConfig 零变更**
