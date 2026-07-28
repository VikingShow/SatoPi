# Plan: Unify Agent Runtime — Single Creation Path + Persistent Agent Tool

## Overview
统一 SatoPi 的三套 Agent 创建机制（runSubprocess / AgentLauncher / GraphRunner nodes）为一个出口 `AgentRuntime.spawn(AgentSpec)`。AgentLauncher 改为调用 `createAgentSession()` 获得全部能力。Persistent agent = AgentSpec.profileId。新增 `agent_invoke` 工具让主 agent 可直接调用持久化 agent。Graph 节点通过 `GraphNode.profile_id` 引用持久化 agent。

## Phase 1: AgentLauncher 切换到 createAgentSession
**Contract:** AgentLauncher 内部不再 `new Agent()`，改为 `createAgentSession()`。对外接口不变。

- [ ] **Task: 添加 findOrCreateSession 到 AgentLauncher**
  - Files: `swarm/agent-runtime/agent-launcher.ts`
  - Change: 在 `launch()` 方法中，将 `new Agent({...})` 替换为 `createAgentSession({...})` 调用。从 `LaunchContext` 中提取需要的参数（modelRegistry, settings, cwd, signal），构建 AgentSession。AgentHandle 存储 AgentSession 而非裸 Agent。
  - Acceptance: AgentLauncher.launch() 返回的 AgentHandle 带有效 session（非 null）。原有 AgentLoopConfig hooks（transformContext, steeringMode, followUpMode, interruptMode, getApiKey）通过 AgentSession 的配置参数无损穿透。
  - Depends: none

- [ ] **Task: 扩展 LaunchContext 增加 session 所需参数**
  - Files: `swarm/agent-runtime/agent-launcher.ts`
  - Change: LaunchContext 新增可选字段：`sessionManager`（复用父 session 的 SessionManager）、`authStorage`、`parentTelemetry`、`skills`、`mcpManager`。当这些字段存在时，AgentLauncher 透传给 createAgentSession。
  - Acceptance: AgentLauncher 创建的 AgentSession 具有 MCP 工具代理、skills 注入、输出流、yield 协议。与 runSubprocess 创建的 session 能力等价。
  - Depends: none

- [ ] **Task: 验证 AgentLoopConfig hooks 穿透**
  - Files: `swarm/agent-runtime/agent-launcher.ts`, `session/agent-session.ts`
  - Change: 确认 AgentSession 的 `AgentSessionConfig` 接口支持 `transformContext`、`steeringMode`、`followUpMode`、`interruptMode` 覆盖。如需，在 `agent-session.ts` 的 `#createAgent` 方法中从 config 读取这些字段并传给 `new Agent({...})`。
  - Acceptance: AgentSession 内创建的 Agent 具有与当前 AgentLauncher 直接 `new Agent()` 相同的 AgentLoopConfig 行为。
  - Depends: "添加 findOrCreateSession 到 AgentLauncher"

## Phase 2: AgentRegistry 扩展 + agent_invoke 工具
**Contract:** 主 agent 可通过 `agent_invoke(profileId, task)` 调用持久化 agent。

- [ ] **Task: AgentRegistry 新增 findByProfileId 方法**
  - Files: `registry/agent-registry.ts`
  - Change: 新增 `findByProfileId(profileId: string): AgentRef | undefined` 方法，遍历内部 agents Map 返回第一个匹配 `ref.profileId === profileId` 的条目。
  - Acceptance: `AgentRegistry.global().findByProfileId("architect-v1")` 返回该持久化 agent 的 AgentRef 或 undefined。
  - Depends: none

- [ ] **Task: 新增 agent_invoke 工具**
  - Files: `tools/agent-invoke.ts`
  - Change: 创建新工具，注册到 `BUILTIN_TOOLS`。参数：`profileId: string`, `task: string`。实现逻辑：1) 通过 AgentRegistry.findByProfileId 查找；2) 如不存在或 idle，spawn 新 agent；3) 如 running，steer 任务；4) 等待 handle.wait() 返回结果。
  - Acceptance: 主 agent 在对话中说 `agent_invoke("architect-v1", "review this code")`，工具成功调用并返回结果。
  - Depends: "AgentRegistry 新增 findByProfileId 方法"

- [ ] **Task: AgentToolContext 扩展以访问 AgentRuntime**
  - Files: `tools/context.ts`
  - Change: AgentToolContext 新增 `agentRuntime?: AgentRuntime` 字段。在 `createTools()` 时从 session 注入。参考 `agent-fork-tool.ts` 的 `declare module` 模式。
  - Acceptance: agent_invoke 工具可通过 `context.agentRuntime.spawn()` 创建 agent。
  - Depends: none

## Phase 3: Graph 节点支持 persistent agent
**Contract:** 图的 YAML 节点可通过 `profile_id` 字段引用持久化 agent。

- [ ] **Task: GraphNode 新增 profile_id 字段**
  - Files: `swarm/graph/schema.ts`
  - Change: `GraphNode` 接口新增 `profile_id?: string`。YAML 解析器 `parseGraphYaml()` 读取此字段。`NodeDefinition`（NodeContext 使用的内部类型）同步新增。
  - Acceptance: `.graph.yaml` 中写 `profile_id: architect-v1` 可被正确解析。
  - Depends: none

- [ ] **Task: CustomNodeBehavior 支持 persistent agent 路由**
  - Files: `swarm/graph/node-behavior.ts`
  - Change: `CustomNodeBehavior.execute()` 中新增判断：若 `ctx.node.profileId` 存在，调用 `AgentRegistry.findByProfileId` 路由到持久化 agent（idle→spawn, running→steer），而非创建新的 ephemeral agent。NodeContext 新增 `agentRegistry` 字段。
  - Acceptance: 图节点 `profile_id: architect-v1` 执行时复用已有持久化 agent，而非创建新 agent。
  - Depends: "GraphNode 新增 profile_id 字段", "AgentRegistry 新增 findByProfileId 方法"

- [ ] **Task: NodeContext 新增 agentRegistry 字段**
  - Files: `swarm/graph/schema.ts`, `swarm/graph/graph-runner.ts`
  - Change: `NodeContext` 新增 `agentRegistry: AgentRegistry`。`GraphRunner.confirmScript()` 中 NodeContext 构造时传入 `AgentRegistry.global()`。
  - Acceptance: CustomNodeBehavior 可通过 `ctx.agentRegistry.findByProfileId()` 查找持久化 agent。
  - Depends: none

## Phase 4: 统一 SwarmRunner 和 GraphRunner 的 Agent 创建路径
**Contract:** 所有 agent 创建统一走 AgentRuntime.spawn()。删除 runSubprocess legacy 路径。

- [ ] **Task: executeSwarmAgent 改用 AgentRuntime.spawn**
  - Files: `swarm/executor/executor.ts`
  - Change: `executeSwarmAgent()` 不再调用 `runSubprocess()`，改为构造 AgentSpec 并调用 `AgentRuntime.spawn()`。保留 output streaming 包装层。
  - Acceptance: SwarmRunner 的 Stage 阶段 agent 通过 AgentRuntime.spawn() 创建，具备完整 AgentLoopConfig hooks。
  - Depends: "添加 findOrCreateSession 到 AgentLauncher"

- [ ] **Task: PipelineController 删除 legacy 分支**
  - Files: `swarm/core/pipeline.ts`
  - Change: 删除 `if (runtime)` 条件分支。`runtime` 变为必需参数。legacy `executeSwarmAgent` → `runSubprocess` 路径移除。
  - Acceptance: PipelineController 的 agent 执行统一走 AgentRuntime 路径。不再有代码路径分歧。
  - Depends: "executeSwarmAgent 改用 AgentRuntime.spawn"

- [ ] **Task: GraphRunner FSM 起始 phase 自动检测**
  - Files: `swarm/graph/graph-runner.ts`
  - Change: `init()` 中 `new WorkflowFsm(..., "stage")` 改为从 graph 的第一个 wave 节点类型自动检测。若第一个节点 type 为 "script" 则起始 phase 为 "script"。
  - Acceptance: 内置 theatre.graph.yaml 的 FSM 从 "script" 开始，而非硬编码 "stage"。
  - Depends: none

## Phase 5: Magic word 默认走 GraphRunner
**Contract:** 用户说 "swarm" 时，系统内部创建 GraphRunner 加载内置 theatre.graph.yaml，而非 EmbeddedSwarmBridge。

- [ ] **Task: agent-session 默认引擎切换为 graph**
  - Files: `session/agent-session.ts`
  - Change: `swarm.engine` 默认值从 `"legacy"` 改为 `"graph"`。GraphRunner 需要支持 interactive Script phase（human-review gate 等待用户确认）。
  - Acceptance: 用户在交互会话中说 "swarm" → GraphRunner 启动 → 内置 theatre.graph.yaml Script→Stage→Curtain 流程。
  - Depends: "GraphRunner FSM 起始 phase 自动检测"

- [ ] **Task: 废弃 EmbeddedSwarmBridge**
  - Files: `swarm/core/embedded-swarm-bridge.ts`
  - Change: 标记为 `@deprecated`。保留文件作为向后兼容 shim，内部委托给 GraphRunner。不再在新路径中使用。
  - Acceptance: 所有现有引用 EmbeddedSwarmBridge 的代码可编译通过。
  - Depends: "agent-session 默认引擎切换为 graph"

## Phase 6: 验证与清理
**Contract:** 全链路端到端测试 + 删除死代码。

- [ ] **Task: 端到端集成测试**
  - Files: `swarm/__tests__/unified-runtime-e2e.test.ts`
  - Change: 新增测试覆盖：AgentLauncher → createAgentSession 创建 agent 并 yield 结果；agent_invoke 工具调用持久化 agent；GraphRunner 节点通过 profile_id 引用持久化 agent；magic word → GraphRunner → theatre.graph.yaml 全链路。
  - Acceptance: 所有新测试通过。`FORCE_COLOR=1 bun test` 全绿。
  - Depends: "Phase 1-5 全部完成"

- [ ] **Task: 删除死代码**
  - Files: `swarm/core/embedded-swarm-bridge.ts`, `swarm/executor/executor.ts`, `swarm/core/pipeline.ts`
  - Change: 删除 EmbeddedSwarmBridge 中不再被引用的方法。删除 `executeSwarmAgent` 的 runSubprocess 调用。删除 `if (runtime)` legacy 分支残留代码。
  - Acceptance: `grep -r "runSubprocess" swarm/` 无 swarm agent 创建调用（仅保留 task tool 的合法调用）。
  - Depends: "端到端集成测试"
