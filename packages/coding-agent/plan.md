# Plan: Theatre Graph — 最终路线图 (圆桌辩论修订版)

## Overview
14 个原 task + 12 个辩论发现的新 task = **26 tasks, 5 phases, ~11 天**。
根据 4-agent 圆桌共识重新排序优先级。

## Phase 1: Fix Blockers (P0 — 必须先修)
**Contract:** 修复当前代码中已经存在的 bug，这些 bug 会让任何集成测试失败。

- [ ] **Task: WaveScheduler metadata wiring**
  - Files: `src/swarm/graph/graph-runner.ts`
  - Change: 传递 `SchedulerNodeInfo` 给 WaveScheduler/DynamicScheduler 构造函数。当前 `new WaveScheduler()` 无参数 → `continueOnFailure` 永远为 false
  - Acceptance: `continue_on_failure: true` 节点失败不阻塞 wave
  - Found by: RuntimeVerdict

- [ ] **Task: selectNodeBehavior() wiring**
  - Files: `src/swarm/graph/graph-runner.ts`
  - Change: `confirmScript()` 中用 `selectNodeBehavior(node.type)` 替代 `new CustomNodeBehavior()`。当前所有节点用同一 behavior
  - Acceptance: script→ScriptBehavior, stage→StageBehavior, curtain→CurtainBehavior
  - Found by: ArchVerdict

- [ ] **Task: Curtain pipeline stub data fix**
  - Files: `src/swarm/graph/graph-runner.ts`
  - Change: 传递真实 StageResult 给 `runCurtainPipeline()`，当前传空 stub。stage 完成后收集 agentResults
  - Acceptance: Curtain 阶段看到真实的 agent 结果和 task 统计
  - Found by: ArchVerdict

## Phase 2: StageController Integration (P0)
**Contract:** StageNodeBehavior 真正驱动 StageController 并行执行（不再是 CustomNodeBehavior 的 delegate）。

- [ ] **Task: Wire StageNodeBehavior to StageController**
  - Files: `src/swarm/graph/node-behavior.ts`
  - Change: StageNodeBehavior.execute() → createStageController(planContent, loopConfig, ...) → StageController.run()。从上游 script 节点获取 planContent
  - Acceptance: Stage 节点产生真实的并行 worker agent

- [ ] **Task: Wire IRCBus through GraphRunner**
  - Files: `src/swarm/graph/graph-runner.ts`
  - Change: 传递 IRCBus.global() → StageOptions.ircBus → 启用 CommChannel.roundtable + CommBus.vote
  - Acceptance: 圆桌角色分配 + reporter 选举

- [ ] **Task: Enable agent_fork + auto agent count**
  - Files: `src/swarm/graph/builtin/theatre.graph.yaml`, `src/swarm/graph/node-behavior.ts`
  - Change: stage node tools 包含 agent_fork；loopConfig.agents.auto = true
  - Acceptance: agent 可 fork；agent 数量自动推荐

- [ ] **Task: GateController retry loop wiring**
  - Files: `src/swarm/graph/graph-runner.ts`
  - Change: gate 失败后调用 handleGateFailure() → sleep → 重新执行 agent → 重新 run gate。循环直到成功、耗尽或人工决策
  - Acceptance: gate 失败自动重试而非立即终止
  - Found by: RuntimeVerdict, ArchVerdict

## Phase 3: Data + Reliability (P1)
**Contract:** Checkpoint 真正写入；graph 数据流正确作用域。

- [ ] **Task: Checkpoint write + resume wiring**
  - Files: `src/swarm/graph/graph-runner.ts`, `src/swarm/graph/checkpoint.ts`
  - Change: 构建 GraphRunState → 每个 node 状态转换时 writeCheckpoint() → init() 中调用 recoverState() 检查已存在的 checkpoint
  - Acceptance: 中断的 graph run 可从最后的 wave 恢复
  - Found by: DataVerdict, RuntimeVerdict

- [ ] **Task: ExperienceStore graph scoping (pipeline threading)**
  - Files: `src/swarm/graph/graph-runner.ts`, `src/swarm/curtain/curtain-runner.ts`, `src/swarm/curtain/lesson-sink.ts`, `src/swarm/curtain/experience.ts`
  - Change: GraphRunner 传 graphName → CurtainRunnerOpts → LessonSink.fanOut() → ExperienceStoreSink 填充 graph_name/node_id/task_hash
  - Acceptance: 按 graph_name 查询 lessons；INSERT 包含 graph 列
  - Found by: DataVerdict (scope: 4 files not 1)

- [ ] **Task: Token budget data model + tracking**
  - Files: `src/swarm/core/state.ts`, `src/swarm/graph/graph-runner.ts`
  - Change: SwarmState 增加 perNodeTokens 字段；NodeRunState 增加 tokenBudget/tokenUsed 字段；StageController 创建时从 graph node 的 max_context_tokens 设置预算
  - Acceptance: StateTracker 显示 per-node token 使用量

- [ ] **Task: Node output checkpointing for downstream replay**
  - Files: `src/swarm/graph/checkpoint.ts`, `src/swarm/graph/graph-runner.ts`
  - Change: NodeRunState 增加 outputs 字段；node 完成时保存 output refs；recoverState 恢复 outputs 供下游节点使用
  - Acceptance: Resume 后下游节点可读取上游产物
  - Found by: DataVerdict

- [ ] **Task: Per-node timeout + AbortSignal propagation**
  - Files: `src/swarm/graph/graph-runner.ts`, `src/swarm/graph/gate-controller.ts`
  - Change: node.timeout → AbortSignal.timeout → 传递给 agent + gate；gate command 接收 AbortSignal
  - Acceptance: 超时节点被 abort；gate 超时触发 human-review
  - Found by: RuntimeVerdict

## Phase 4: TUI + UX (P1)
**Contract:** Dashboard 显示 graph DAG；用户可交互。

- [ ] **Task: Populate graphView from GraphRunner state**
  - Files: `src/swarm/graph/graph-runner.ts`, `src/modes/components/swarm/swarm-dashboard-overlay.ts`
  - Change: mode="graph" 时 overlay 构建 graphView（节点→agent 映射 + DAG 拓扑 + 状态颜色）
  - Acceptance: Dashboard 渲染 ASCII DAG，节点颜色反映状态
  - Found by: UXVerdict

- [ ] **Task: Gate prompt UI (TUI gate panel)**
  - Files: `src/modes/components/swarm/swarm-dashboard-overlay.ts`, `src/swarm/graph/gate-controller.ts`
  - Change: GateController emit "human-review-request" → TUI 显示 gate prompt 面板 → 用户选择 → resolve
  - Acceptance: human-review gate 在 TUI 中弹出选项让用户选择
  - Found by: UXVerdict

- [ ] **Task: Register /graph slash commands**
  - Files: `src/slash-commands/builtin-registry.ts`
  - Change: `/graph run <name>`, `/graph list`, `/graph compile <mermaid>`
  - Acceptance: TUI 中可用 `/graph` 命令

- [ ] **Task: Graph authoring UX (Mermaid → YAML flow)**
  - Files: `src/swarm/graph/mermaid-compiler.ts`, `src/modes/interactive-mode.ts`
  - Change: 用户在 chat 中粘贴 Mermaid → 编译为 .graph.yaml → 询问是否运行
  - Acceptance: Mermaid 流程图直接变为可执行 graph
  - Found by: UXVerdict

- [ ] **Task: UpstreamOutputSource — edge dataflow**
  - Files: `src/swarm/graph/context/upstream-output-source.ts` (新)
  - Change: 新 ContextSource，从 GraphDefinition.edges 读取 artifact globs → 解析文件路径 → 注入下游节点 context
  - Acceptance: 下游节点自动看到上游产物摘要
  - Found by: ArchVerdict, DataArchitect

## Phase 5: Polish + Tests (P2)
**Contract:** 集成测试覆盖；安全加固。

- [ ] **Task: Loop converter integration test**
- [ ] **Task: Mermaid compiler integration test**
- [ ] **Task: Builtin theatre end-to-end test**
- [ ] **Task: Graph YAML validation hardening**（工具名、角色、超时格式）
- [ ] **Task: Graph YAML sandboxing**（gate command shell 注入防护）
- [ ] **Task: GraphRunState graphRevision safety check**（resume 时验证 graph 版本匹配）
