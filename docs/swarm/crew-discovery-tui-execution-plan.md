# Crew 发现机制 + TUI 修复执行计划

> 日期: 2026-08-04
> 状态: 已批准实施（分支 `feat/crew-discovery-tui`，基线 `dev` @ `5f60b60182`）
> 依据: 四项只读调研（Ctrl+B 下边框、/swarm start agent 来源、crew 信息流 vs main session、agent 发现机制）
> 范围: `packages/coding-agent`（除 Phase A2 涉及 `packages/tui`）

## 1. 现状结论

| 问题 | 根因 | 证据 |
|------|------|------|
| Ctrl+B 侧边栏下边框不可见（修复后仍在） | 高度预算按"每行恰好一行"计算，69 列脚注提示行在 `contentWidth = width - 3` 下折行为两行（终端 ≤ ~180 列、默认 40% 宽度时必现）；面板超 `maxHeight` 后 overlay 引擎对非 bottom 锚点 `slice(0, maxHeight)` 砍掉末行（即下边框）；`termRows`（`process.stdout.rows \|\| 24`）与 `Terminal.rows`（in-band resize 时返回 `#reportedRows`）可能不一致 | `swarm-sidebar.ts:419,486,491`; `tui/output-block.ts:91,132`; `packages/tui/src/tui.ts:2376-2390,2505-2511`; `terminal.ts:1434-1437` |
| 测试未拦住 | border 测试在 width=120（提示行不折行）+ 极小 fixture 下渲染，且不经 overlay 引擎 clamp | `test/swarm-sidebar-history.test.ts:221-229` |
| crew 信息流不自然、排版差 | 扁平 string[] 流：无消息间隔、硬折行切词、长前缀挤压正文、`#contentBudget` 忽略 `#targetHeight`（多行编辑器时面板超预算被砍下边框，与上同源）、tool entry 与 `converged` 是死代码 | `crew-transcript-view.ts:325-329,366-378`; `interactive-mode.ts:4874-4906`; `swarm-mode-controller.ts:425,650-671` |
| /swarm start 无法新增 agent | 选择源是 `ProfileRegistry.list()`；无任何用户侧创建入口（无斜杠命令、无对话框入口），只有内置 7 角色种子 + graph 运行 hook 自动创建 + 手写 JSON | `swarm-mode-controller.ts:329-333`; `agent/agent-profile.ts:186-208`; `builtin-registry.ts:1226-1259` |
| 成员互相不知道对方存在 | spawn 时 prompt 只含自己 id，无 roster；`commChannel` 未接进 session 工具上下文（`agent_peers`/`agent_query_all` 等工具生产环境死代码）；crew 成员工具白名单无 irc/agent 工具 | `swarm-mode-controller.ts:603-615`; `tools/agent-channel-tools.ts:497-518`; `task/executor.ts:208-221`（唯一现存 roster 注入） |

可复用机制（不重造）：`runRoundtable` + Jaccard 收敛（`comm/roundtable.ts:82-213`）、`DebateRoundtable`（`graph/behaviors/debate-roundtable.ts:105-306`）、`WaveScheduler` 波内并行（`graph/graph-executor.ts:66-98`）、`TaskQueue` 认领/阻塞（`graph/task-queue.ts:60-200`）、`GateController` 门禁（`graph/gate-controller.ts`）、ContextPipeline 的 `systemPromptAddition` 机制（`context/sources/*`）。

死代码（禁止复活/复用）：`verification-hook.ts`、`crew/roundtable-session.ts`（无人 import，`agentPositions` 留空）。

## 2. 执行顺序与依赖

```
Phase A（下边框） ──┐
Phase B（crew 流） ──┼─→ Phase D（发现机制）─→ Phase E（并行/圆桌/交叉验证）
Phase C（档案管理） ─┘
```

A/B/C 互不依赖，可并行。D 依赖 B 的渲染模型（roster 注入 crew 上下文）与 C 的档案来源（成员=profile）。E 依赖 D（工具接线是圆桌/交叉验证的前置）。

## 3. Phase A — Ctrl+B 侧边栏下边框修复

目标：任意终端宽度/高度下，侧边栏面板 ≤ `maxHeight`，下边框恒可见。

改动点：

1. **A1. 内容 clamp + 自适应脚注**（`modes/components/swarm/swarm-sidebar.ts:481-493`）
   - 填充循环由"只补空行"改为"先 trim 到 `termRows - 4` 再补空行"（防 wrap 膨胀）。
   - 脚注提示行改为按 `innerWidth` 自适应：`hint = t.fg("dim", hintFor(innerWidth))`，窄宽度下只保留 `j/k Enter Esc ←→`，保证单行。
   - 树行渲染已按 `innerWidth - 20` 截断，确认无其它超宽行（`+N more`、spacer 均为短行）。
2. **A2.（可选）引擎侧兜底**（`packages/tui/src/tui.ts:2505-2511`）：非 bottom 锚点的截断改为"优先保底"（保留最后一行、裁顶部）——一行改动，能兜住所有 panel 类 overlay 的同类问题。风险：改变了现有 `slice(0, maxHeight)` 的语义，需确认无依赖"保顶"的既有 overlay（`swarm-dashboard`、plan-review 均为 top 锚点，行为不变）。
3. **A3. 测试补强**（`test/swarm-sidebar-history.test.ts`）
   - 新增用例：窄宽度（`render(40)`）+ 溢出树（> `termRows - 7` 行，触发 `+N more`）下，`lines.length <= termRows - 2` 且末行非空为 `╰/└`。
   - 新增用例：模拟引擎 clamp（对 render 结果执行与 `#compositeOverlaysIntoWindow` 相同的 slice 逻辑后，末行仍为下边框）——不依赖真实 TUI 实例。

验收：上述两个用例通过；`bun test test/swarm-sidebar-history.test.ts` 全绿；现有用例不回归。

## 4. Phase B — Crew 信息流重排

目标：crew 流达到 main session 的可读性基线（消息间隔、语义折行、块结构、高度预算对齐）。

改动点：

1. **B1. 块模型 + 垂直节奏**（`modes/components/swarm/crew-transcript-view.ts:126-215,332-378`）
   - 每条 entry 渲染为"1 行 header（时间 + R<n> + [agentId] 着色 tag）+ 正文块"，块间插入 1 空行（对齐 `transcript-container.ts:421-426` 的约定）。
   - `wrapBody` 换 `wrapTextWithAnsi`（语义折行，不切词）；`#entryLines` 的续行对齐保留。
   - 前缀缩短：时间戳改 `HH:MM`；窄宽度下省略 `R<n>`。
2. **B2. 高度预算对齐**（`crew-transcript-view.ts:325-329,206-209`）
   - `#contentBudget` 改用 host 传入的 `#targetHeight`（`interactive-mode.ts:4895-4897` 已 setTargetHeight），删掉与引擎不一致的 `getTerminalRows() - RESERVED_BOTTOM_ROWS` 估算；面板总行数恒 ≤ maxHeight（同 Phase A 机制，下边框问题一并消失）。
3. **B3. 清死代码**（`crew-transcript-view.ts:77,228-230,310-311,340-346`; `swarm-mode-controller.ts:425`）
   - 删除 `converged` 字段与 `#showTools` 切换 UI（tool entry 不产生，`t` 键无意义）；`kind:"tool"` 分支保留类型但注释标注"未启用"，或一并删除（与 `CrewTranscriptEntry` 一起）。
   - badge 行 `[tools]/[msg-only]` 片段删除。
4. **B4.（后续）tool 调用入流**：在 `#spawnCrewMembers` 的 `session.subscribe`（`swarm-mode-controller.ts:650-671`）中把 `tool_call`/`tool_result` 事件映射为 `kind:"tool"` entry。可选，单独小步，避免 B1-B3 范围膨胀。

测试：新增 `test/swarm/crew-transcript-view.test.ts`（或并入现有）：(a) 相邻 entry 恰隔 1 空行；(b) 长词正文不被硬切（无超宽行）；(c) 给定 `#targetHeight` 时面板总行数 ≤ target（下边框在场）；(d) `t` 键与 converged 相关渲染消失（若删）。

验收：`bun test` 相关文件全绿；手动 `stp` 起 crew 目视确认信息流节奏与 main session 一致。

## 5. Phase C — Agent 档案管理入口

目标：用户能在产品内新增/删除 `/swarm start` 可选的 agent，不再依赖手写 JSON 或改代码。

改动点：

1. **C1. 斜杠命令 `/profile`**（`slash-commands/`，参照 `builtin-registry.ts:1218-1259` 注册模式）
   - `/profile list`：列出当前 workspace 全部 profile（含 credit/archetype）。
   - `/profile create <name> [--archetype <t>] [--domains a,b]`：调 `ProfileRegistry.global().createProfile(...)`（`agent/agent-profile.ts:220-296`，id 由 name 生成，校验 `^[a-zA-Z0-9_-]+$`）并 `save(workspaceDir)`。
   - `/profile delete <id>`：删除 `<id>.json` + `_index.json` 条目（`save` 重写 index；需确认无运行中 crew 引用，或仅阻止删除）。
2. **C2. 对话框内"新建"入口**（`modes/components/swarm/profile-select-dialog.ts` + `swarm-mode-controller.ts:362-412`）：列表尾部加 `+ Create new agent` 行 → 复用 C1 的创建逻辑 → 刷新列表并预选。
3. **C3. 文档化格式 + 校验**：`AgentProfile` JSON 字段写进 plan 附录或代码注释；`deserialize` 对缺字段已有默认（`agent-profile.ts:600-606`），创建路径补一个 `validateProfile` 早失败。
4. **C4.（可选）per-profile 模型/提示**：`AgentProfile` 增加 `model?`/`systemPrompt?`，`#spawnCrewMembers`（`swarm-mode-controller.ts:571-614`）优先使用；同时把硬编码 prompt 模板移入 `prompts/`（repo 规则：prompts 必须 .md）。

测试：`ProfileRegistry` 层（create/delete/list 往返、非法 id 拒绝、credit 过滤逻辑）；斜杠命令层（mock registry，命令输出含新 profile）。

验收：`/profile create demo --archetype reviewer` 后 `/swarm start` 对话框出现 `demo`；删除后消失；无运行中引用时 delete 成功。

## 6. Phase D — 同伴发现机制

目标：crew/图 agent 知道自己与谁协作；`agent_peers`/`agent_query_all`/`agent_roundtable` 在生产环境可用。

改动点：

1. **D1. PeerRoster ContextSource**（新建 `context/sources/peer-roster-source.ts`，仿 `task-queue-source.ts` 结构）
   - 从 `AgentRegistry.global().list()` + 当前 crew 成员（`CrewManager` 或 `CommChannel.members`）生成 `<peer_roster>` XML（id、displayName、archetype、status）。
   - 注册进 `swarm/core/assembler.ts:117-134`（与现有 6 个 source 并列）；crew 成员 spawn 路径同样注入。
2. **D2. commChannel 接线**（`graph/agent-helpers.ts:70-274` + `swarm-mode-controller.ts:559-709`）
   - 把运行时 `CommChannel`（assembler 已创建，`assembler.ts:144-150`）经 `context.commChannel` 注入 session 工具上下文（复用 `tools/agent-channel-tools.ts:497-518` 的 `createAgentChannelTools` 逻辑，补全 `tools/index.ts:497-501` 注册的 4 个 agent-channel 工具的可用路径）。
   - crew 成员工具白名单加 `irc`、`agent_peers`（`swarm-mode-controller.ts:615`）。
3. **D3. prompt 补 roster**：crew 成员 prompt（`swarm-mode-controller.ts:603-614`）追加一行"当前 crew 成员：<peer_roster 摘要>"；prompt 模板同时按 C4 移入 .md。
4. **D4. 测试**：spawn 一个 crew 成员后 `agent_peers` 返回非空（含其它成员 id）；`agent_query_all` 往返成功；roster source 输出格式单测。

验收：成员 system prompt 含同伴 id；`agent_peers` 对成员返回真实 crew 名单；broadcast 可达全部成员。

## 7. Phase E — 并行执行 + 圆桌辩论 + 交叉验证

目标：多 agent 并行处理共享任务，可圆桌辩论收敛、可交叉验证彼此产出。

改动点：

1. **E1. 并行执行落地**（复用现成机制，接线为主）
   - `TaskQueueSource` 注册进生产 pipeline（`assembler.ts`）——工人能看到共享队列的"in progress (assigned to: X)"。
   - `graph-runner.ts:190-194` 已读 `magicKeywords.swarm.maxWorkers`；确认 `DynamicScheduler`（`graph-executor.ts:126+`）以 maxConcurrency 生效。
   - 新增 `graph/behaviors/cross-check-behavior.ts`（仿 `stage-behavior.ts:82-180`）：Stage 波后节点，对每个产出派 `reviewer`（`ROLE_TO_PROFILE` 已含 `reviewer: swarm-reviewer`，`stage-behavior.ts:46-54`）认领评审任务；不合格经 `TaskQueue.block()`（`task-queue.ts:137-152`）打回。
2. **E2. 圆桌辩论接线**
   - debate 节点接入 theatre 图：`graph-runner.ts:543-569` 已有 `enableDebate`（agentCount 2 / maxRounds 2）+ `debateRoundtableFactory` 已注入（`swarm-mode-controller.ts:246`）；补齐 `graph/builtin/theatre.graph.yaml` 的 Script→Debate→Stage 边。
   - `DebateRoundtable` 接受 crew channel：`finalPositions` 经已有 `onPlanUpdated` hook（`swarm-mode-controller.ts:678-693`）推进 plan.md 与 crew 视图。
   - 若走 crew 内圆桌：填充 `agentPositions`（按 sender 记录 `collectResponses` 结果）——`crew/roundtable-session.ts` 是死代码，此处改为在 `swarm-mode-controller` 直接调 `CommChannel.roundtable()`（`comm-channel.ts:209-221`）。
3. **E3. 交叉验证门禁**
   - 重节点挂 `gate-controller` 门禁（compile-check/test/lsp，pattern 见 `theatre.graph.yaml:67-72`）；失败走现有 retry/backoff → block/skip/human。
   - agent 层共识：worker 回合内用 `agent_query_all`/`agent_query_majority`（依赖 D2 接线）。
4. **E4. 测试**：`graph/__tests__/e2e-composition.test.ts` 模式新增一条 Script→Debate→Stage→CrossCheck 的端到端；断言 reviewer 打回不合格任务后重试路径；debate 收敛早退（Jaccard 阈值命中）。

验收：`stp swarm run` 或 `/swarm` 魔法词下，多 worker 并行、debate 收敛输出 finalPositions、reviewer 拦截缺陷产物；`bun test graph/*` 全绿。

## 8. 风险与注意

- Phase A2 改引擎截断语义前，先跑 `packages/tui` 全量测试；如无必要可跳过（A1 已根治本案例）。
- Phase B3 删 `converged`/tool-toggle 前 grep 引用（`swarm-dashboard-overlay`、`roundtable-view` 可能依赖 badge 状态）。
- Phase C 的 profile 删除需防运行中引用（crew 会话持有成员 id）；C1 命令输出走 `logger`/TUI notice，禁止 `console.log`（AGENTS.md 日志规则）。
- 所有 prompt 字符串移入 `prompts/*.md`（Handlebars 动态内容），遵守 repo prompts 规则。
- 每阶段独立提交，CHANGELOG 统一在 `## [Unreleased]` 追加条目（`packages/coding-agent/CHANGELOG.md`）。
- 全程只改 `~/workspace/realSatoPi/SatoPi-crew`（分支 `feat/crew-discovery-tui`），不触碰主 checkout 的未提交工作。
