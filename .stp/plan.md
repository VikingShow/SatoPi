# Plan: AgentLauncher → createAgentSession（ContextPipeline Source 方案）

## Overview
AgentLauncher 不再手写 `new Agent({transformContext})`，改为调用 `createAgentSession()`。MMD 注入变为 ContextPipeline Source（`MmdSource`），L3 compact 由 createAgentSession 内置处理。AgentLauncher 只传配置，不拼回调。

## Phase 1: MMD → ContextPipeline Source
**Contract:** 新 `MmdSource` 注册到 ContextPipeline，MMD 变为 creation-time 注入。

- [ ] **Task: 新建 MmdSource**
  - Files: `swarm/context-manager/sources/mmd-source.ts`
  - Change: 新建文件，实现 `ContextSource` 接口。priority=3。`build()` 返回 `systemPromptAddition: activeMmd`（或 `injectedMessages`）。构造函数接受 `activeMmd: string`。参考 `offload-source.ts` 的模式。
  - Acceptance: `new MmdSource("...<mmd>...")` 可注册到 ContextPipeline。
  - Depends: none

- [ ] **Task: AgentLauncher 注册 MmdSource 到 ContextPipeline**
  - Files: `swarm/agent-runtime/agent-launcher.ts`, `swarm/core/assembler.ts`
  - Change: 在 `assembler.ts` 的 `assembleAgentRuntime()` 中，若 `LaunchContext` 有 `activeMmd`，则注册 `new MmdSource(ctx.activeMmd)` 到 ContextPipeline。 `AgentLauncher.launch()` 不再在 transformContext 中做 MMD splice 注入。
  - Acceptance: AgentLauncher 创建的 agent 的 system prompt 中包含 MMD 内容（通过 ContextPipeline → assembledContext）。
  - Depends: "新建 MmdSource"

## Phase 2: AgentLauncher 切换 createAgentSession
**Contract:** AgentLauncher 删除手写 transformContext，改用 createAgentSession。

- [ ] **Task: AgentLauncher.launch() 改用 createAgentSession**
  - Files: `swarm/agent-runtime/agent-launcher.ts`
  - Change: 删除 `new Agent({transformContext, steeringMode, ...})` 块（约 60 行）。改为调用 `createAgentSession({ model, systemPrompt, tools, offloadManager, contextWindow, ... })`。L3 compact 由 SDK 内置的 transformContext 处理（Phase1Sdk 已完成）。`AgentHandle` 传入真实 session。
  - Acceptance: AgentLauncher 创建的 agent 通过 AgentSession 运行，具备 L3 compact。AgentHandle.session 非 null。
  - Depends: "AgentLauncher 注册 MmdSource 到 ContextPipeline"

- [ ] **Task: AgentLauncher 清理 import 和 dead code**
  - Files: `swarm/agent-runtime/agent-launcher.ts`
  - Change: 删除不再使用的 import（`Agent`, `AgentMessage`, `Model`, `compactContext`, `DEFAULT_COMPACT_CONFIG`）。删除 `#startAgent` 中的 steering pre-load（AgentSession 已接管）。
  - Acceptance: `npx tsc --noEmit` 零新错误。
  - Depends: "AgentLauncher.launch() 改用 createAgentSession"

## Phase 3: 验证
**Contract:** 冒烟 + 全量回归。

- [ ] **Task: 端到端测试**
  - Files: `swarm/__tests__/agent-launcher-session.test.ts`
  - Change: 测试 AgentLauncher 通过 createAgentSession 创建 agent，验证 MMD 注入（通过 systemPrompt）、L3 compact 触发、AgentHandle.session 非 null。
  - Acceptance: `FORCE_COLOR=1 bun test` 全绿。
  - Depends: "Phase 2 全部完成"

- [ ] **Task: 全量回归**
  - Files: `swarm/__tests__/`
  - Change: 运行全量测试。
  - Acceptance: 567+ tests pass, 0 fail。
  - Depends: "端到端测试"
