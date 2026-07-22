# SatoPi 企业级审查与长期优化方案

> 审查日期：2026-07-21 ｜ 范围：`packages/swarm-gui`（前端）、`packages/coding-agent/src/swarm`（后端编排）、`packages/web`（pi-web 传输层）
> 目标：定位两个顽固缺陷的真根因并修复；对前端流式/Markdown、后端 pi-agent 哲学契合度、swarm 流程衔接与交互、agent 工程可靠性/可扩展性做多维度评估；给出对标业界的 P0–P3 分阶段路线图。

> **v2.1 后续审计更新（2026-07-21）**：本文档 §0-5 的评估在代码审计时是准确的。后续对 `packages/swarm-gui/src/` 的逐文件深度审计发现了额外的**集成债务**：shadcn/ui 9 组件已实现但 0 个被业务代码使用；i18n/theme/Monaco/ReactFlow/sonner/keyboard-shortcuts 依赖全部已安装但接入率 ~15%。这些发现已在 §6.2 P3 中补充。关于 `feat/p3-observability-tracing` 分支：经 `git diff` 验证，该分支内容提交 `22d717df8` 与 dev 已合并的 `c339e3587` 树内容完全相同，合并是 no-op，分支名承诺的可观测性工作实际未实现。

---

## 0. 结论速览（TL;DR）

| 维度 | 现状评级 | 关键问题 | 目标 |
|------|---------|---------|------|
| 传输层可靠性（SSE） | ⚠️ 不合格→已修 | `connect()` 不重置 `shouldReconnect`，首次切换后永久禁用重连 | 断线自愈 + Last-Event-ID 断点续传 |
| 右侧面板（Agents/Tasks/Plan） | ⚠️ 不合格→已修 | 面板显隐与 `swarmState` 强耦合，null 即消失 | 显隐与数据解耦，恒显 + 空态 |
| 前端流式渲染 | 🟡 中上 | 每 delta 一次全通道数组重建；虚拟列表动态高度抖动 | token 级批处理 + 稳定高度 |
| Markdown 渲染 | 🟢 良好 | shiki 异步首帧闪烁；无 KaTeX/mermaid | 增量高亮缓存 + 数学/图表 |
| 后端 pi 哲学契合 | 🟢 高度契合 | swarm = pi 三段循环的"分形"；每 worker 是完整 pi 子进程 | 保持，补充可观测性 |
| swarm 流程衔接 | 🟡 中上 | before→main→after 衔接顺滑，但错误路径/降级缺统一 | 状态机显式化 + 补偿 |
| 可靠性/可扩展性 | 🟡 中 | 执行器已抽象（可注入），但缺分布式/持久化编排 | 事件溯源 + 可插拔执行器 |

两个用户反馈的顽固 bug 已在本轮定位到**传输层/耦合层真根因**并修复，54 个前端单测全绿（含 3 个新增回归用例）。

---

## 1. 项目全貌阐述

### 1.1 定位

SatoPi 是在单体 "pi" coding agent（`oh-my-pi`）之上构建的**多智能体（swarm）协作系统**。核心理念：不改变 pi 单体智能体的本质，而是通过**编排机制**把多个完整的 pi 实例组织成一个自组织、可评审、可收敛的群体。

### 1.2 Monorepo 结构

```
packages/
├── coding-agent/       # 后端：Bun 运行时，swarm 编排引擎 + Monitor HTTP/SSE 服务
│   └── src/swarm/
│       ├── loop-controller.ts     # 主循环（worker 轮次 + 辩论 + cloner 评审 + 收敛/阻塞检测）
│       ├── pipeline.ts            # DAG 波次执行基类（wave 并行、iteration 串行、生命周期 hooks）
│       ├── before-loop-manager.ts # Socrates 规划对话状态机（before-loop）
│       ├── roundtable.ts          # ClonerCouncil：加权投票 + 否决评审
│       ├── worker-channel.ts      # IRC 群聊 + 评审提名/推举
│       ├── executor.ts            # ★ pi 基座桥接：executeSwarmAgent → runSubprocess
│       ├── state.ts               # StateTracker：内存 + 持久化状态
│       ├── activity-logger.ts     # 18 种事件 → session.jsonl + SSE 广播
│       ├── session-registry.ts    # 多会话隔离 + 共享服务
│       ├── region-lock.ts         # 文件区域级锁（防并发写冲突）
│       ├── after-loop/            # 学习管线（experience/extractor/reflector/summarizer）
│       ├── offload/               # 分层上下文卸载
│       └── monitor/
│           ├── server.ts          # Bun.serve()：SSE + REST，按 session 路由
│           ├── api-routes.ts      # 路由表（会话域 + 全局域）
│           └── event-bus.ts       # 按 session 名分发的 SSE 订阅总线
├── web/                # 共享 pi-web：SseClient（传输层）、shiki 高亮等
│   └── src/core/sse-client.ts     # ★ EventSource + 指数退避 + 心跳
└── swarm-gui/          # 前端：React + Zustand + Vite
    └── src/
        ├── App.tsx                 # 外壳：左会话列表 / 中聊天 / 右 ContextPanel + 连接状态
        ├── components/monitor/
        │   ├── ChatView.tsx        # 聊天/流式渲染（ReactMarkdown + shiki + react-virtual）
        │   ├── ContextPanel.tsx    # ★ 右侧 Agents/Tasks/Plan 面板
        │   ├── PlanViewer.tsx / TodoList.tsx / AfterLoopPanel.tsx
        ├── lib/sse-client.ts       # ★ 会话级 SSE 封装（setActiveSSESession）
        └── stores/
            ├── swarm-store.ts      # 主状态机（init/流式/refreshState）
            └── session-store.ts    # 会话持久化（persist）+ 同步订阅
```

### 1.3 运行时数据流

```
用户输入任务
   │
   ▼
[before-loop] Socrates 与用户对话澄清 → 生成 plan.md
   │  (BeforeLoopManager 状态机)
   ▼
[main-loop] LoopController.runLoop()
   │  ├─ TaskComplexityAnalyzer 依据 plan 动态定 worker 数/轮数/收敛阈值
   │  ├─ 每轮：#spawnWorkers() 并行跑 N 个 pi 子进程（runSubprocess）
   │  │        · RegionLock 三层文件锁协调并发写
   │  │        · WorkerChannel(IRC) 自组织协商 + 推举 reviewer
   │  ├─ 辩论阶段：Challenge → Rebuttal → Resolution（只读工具）
   │  ├─ 收敛检测：reviewer JSON 优先，回退 Jaccard 相似度
   │  ├─ 潜伏 cloner 门控：仅当 worker 内部未收敛才升级 ClonerCouncil 评审
   │  └─ 阻塞检测：停滞/崩溃死锁 → 暂停等用户裁决（5min 超时自动 continue）
   ▼
[after-loop] 经验抽取/反思/总结 → 沉淀到经验库
   │
   ▼
全程：ActivityLogger → session.jsonl + EventBus → SSE → 前端 store → UI
```

**关键事实（已验证）**：
- `executor.ts:184` `runSubprocess({...})` 直接调用 `@oh-my-pi/pi-coding-agent` 的 pi 基座。**每个 worker/cloner 都是一个完整的 pi agent 子进程**，拥有完整工具集与自身的 before/main/after 微循环。
- `server.ts:83-117` SSE 端点已支持 `Last-Event-ID` 头（line 85），握手回显该 id，但**后端并未据此重放漏发事件**——续传实际依赖前端 `getHistory(lastEventTs)`（见 §3.1 缺口）。
- `server.ts:199-204` 未知 session → **404**；`swarm-gui` 的 `api.getState()` 因此返回 null/抛错 → 正是右侧面板消失的上游触发点（§2.2）。

---

## 2. 两个顽固缺陷：真根因与修复

### 2.1 缺陷 A —— 启动后永久 "Disconnected / Reconnecting"

**真根因（传输层��此前从未触及）**
`packages/web/src/core/sse-client.ts`：
- `connect()` 内部**从不**重置 `this.shouldReconnect = true`；
- `disconnect()`（line 62）会把 `shouldReconnect` 设为 `false`；
- `swarm-gui/src/lib/sse-client.ts` 的 `setActiveSSESession()` 每次都执行 `disconnect() → setUrl() → connect()`。

因此**首次 `setActiveSSESession` 之后 `shouldReconnect` 永久为 false**。本地前后端启动时后端通常晚就绪数百 ms，首个 `EventSource` 触发 `onerror` → 关闭 → 因 `shouldReconnect=false` 不再重连 → 永久卡在 "Reconnecting"。此前多轮修复只改 `swarm-store` 里回调注册时机，**根本没碰传输层**，所以无效。

**修复**（已实施）
1. `connect()` 入口重新武装 `this.shouldReconnect = true`——显式 connect 永远代表"建立活链路"的意图，与 disconnect 的语义对称。
2. `setActiveSSESession()` 幂等化：目标 session 未变且已连接时短路返回，消除 `swarm-store.init` 与 `session-store.subscribe` 双重调用造成的重连抖动与事件缺口。

**回归测试**（新增，`lib/__tests__/sse-client.test.ts`）
- `re-arms auto-reconnect after a disconnect()→connect() cycle`：模拟 setActiveSSESession 后 onerror 仍能重连。
- `keeps reconnecting across repeated session switches`：连续多次切换后仍自愈。

### 2.2 缺陷 B —— 右侧 Agents/Tasks/Plan 面板消失

**真根因（耦合设计）**
`ContextPanel.tsx:42`（原）`if (!swarmState) return null;` —— **面板显隐与 `swarmState !== null` 完全强耦合**。`newSession`/`refreshState` 都补过守卫，但 `swarm-store.ts:247` 的 `init()` 里 `set({ swarmState: state, loopPhase: state.loopPhase })` **仍无 null 守卫**：新会话时后端 404 → `getState()` 返回空 → 覆盖为 null → 整块面板消失。同时 `state.loopPhase` 在 state 为 null 时还会抛异常。这是"打补丁不治本"。

**修复**（已实施）
1. **解耦** `ContextPanel`：删除 `return null`，改为**始终渲染面板外壳**，数据从 `swarmState?.agents ?? {}` 防御式派生；无 agent 时展示 "No active agents yet" 空态占位。
2. **双保险** `init()`：`set((prev) => ({ swarmState: state ?? prev.swarmState, loopPhase: state?.loopPhase ?? ... }))`——空值不再覆盖既有状态，`loopPhase` 用可选链避免抛错。

**回归测试**（新增，`stores/__tests__/swarm-store.test.ts`）
- `init does NOT overwrite swarmState when getState() resolves null (panel must not vanish)`：验证 getState 返回 null 时既有 swarmState 被保留、loopPhase 优雅回退。

> ✅ 全量前端测试：**5 files / 54 tests passed**（原 51 + 新增 3）。

---

## 3. 前端：流式输出与 Markdown 是否达企业级

### 3.1 现状

- **流式**：`stream_start`（建空气泡）→ `stream_delta`（追加 body）→ `stream_end`（定稿 + thinking 折叠）。历史回放 `fromHistory=true` 跳过 stream_*，依赖 broadcast，避免重复气泡。逻辑正确、边界覆盖到位（见 swarm-store 25 个测试）。
- **Markdown**：`ReactMarkdown + remarkGfm + 自定义 code 渲染 → shiki 异步高亮（有 codeCache）`；prose/表格/blockquote/链接齐全。
- **虚拟列表**：`@tanstack/react-virtual`，`estimateSize` 启发式（含 ``` 判断），`overscan=5`，`MemoMessageBubble` 记忆化。

### 3.2 企业级差距

| 差距 | 影响 | 参考最佳实践 |
|------|------|-------------|
| 每个 `stream_delta` 触发一次整通道数组重建（`addActivity` + messages Map 更新） | 高频 token 下主线程压力大、掉帧 | token 级 **批处理/节流**（rAF 或 16–33ms flush 缓冲区），Vercel AI SDK 的 `throttle` 思路 |
| 虚拟列表流式增长时动态高度靠估算 | 滚动抖动、锚点跳动 | 流式气泡固定/测量高度 + `measureElement`；底部自动吸附用 `overflow-anchor` |
| shiki 每块异步首帧闪烁 | 代码块先无色后高亮 | 预留高度占位 + 增量高亮缓存；或 `shiki` 同步 fine-grained bundle |
| 后端 SSE 未按 `Last-Event-ID` 重放，前端靠 `getHistory(ts)` 兜底 | 断线瞬间可能漏/重事件 | 后端做 **ring buffer + Last-Event-ID 断点续传**（标准 SSE 语义） |
| 无 KaTeX/mermaid、无消息级错误边界、重连 toast 未去重 | 数学/流程图无法渲染；异常连锁 | `remark-math + rehype-katex`、`react-error-boundary`、toast dedupe key |
| 无 e2e（仅单测） | 回归靠人工 | Playwright 覆盖"启动→连接→流式→切会话"关键路径 |

**评级**：Markdown 静态渲染 🟢 良好；流式在**高吞吐下的平滑度与断点续传**上尚未达企业级 🟡，需 §6 的 P1 优化。

---

## 4. 后端：是否契合 pi agent 设计哲学

**pi 单体哲学**：一个自治 agent，围绕 `before-loop（规划/澄清）→ main-loop（工具执行 + 自我验证）→ after-loop（反思/学习）` 的三段式循环，工具齐全、自我驱动。

**契合度评估：🟢 高度契合，且是"分形"式放大**
- **同构复用**：swarm 的 before/main/after 与 pi 完全同构——`BeforeLoopManager`（Socrates 规划）、`LoopController.runLoop`（主循环）、`after-loop/`（学习）。
- **基座不改**：`executor.ts` 通过 `runSubprocess` 复用完整 pi 基座，**每个 worker 本身就是一个完整 pi agent**（拥有自身三段循环与全工具）。swarm 只在"其上"编排，不侵入 pi 内核——符合"编排层与智能层分离"原则。
- **自我验证下沉**：`WORKER_SYSTEM_PROMPT` 强制 worker 跑测试（P0-5）、强制 Gap 检测（P0-E），把 pi 的"自我验证"理念放大为群体质量机制。
- **潜伏守护者**：cloner 只在 worker 内部无法收敛时才介入（latent gate，`loop-controller.ts:789`），呼应 pi"优先自治、必要才升级"的哲学。

**偏离点/风险**
- 主循环 `runLoop()` 单函数 ~740 行，职责密集（收敛/阻塞/缩放/快照/验证混在一起），**可测试性与可维护性**是主要债务（见 §5、§6-P2）。
- `pipeline.ts` 已抽象出干净的 wave/hook 基类，但 `LoopController` 未真正继承它、而是并行实现——存在两套编排范式，长期应统一。

---

## 5. swarm 流程衔接、交互与工程可靠性/可扩展性

### 5.1 流程能否自然衔接并正常运转

- **能，主路径顺滑**：before→main→after 由 StateTracker 的 `loopPhase` 串联，SSE 实时驱动前端，plan.md 作为跨阶段契约。动态 worker 缩放（GAP 2）、质量记账（praise/criticism/conflict）、快照回滚均已实现。
- **薄弱在错误/降级路径**：`converged_failed / converged_partial / escalated / aborted / blocked` 多状态散落在 runLoop 各分支，**缺一个显式状态机**统一转移与补偿；阻塞裁决 5min 超时自动 continue 是合理兜底，但缺前端强提示与审计。

### 5.2 用户交互可优化点

1. **连接状态语义细化**：目前二元 `Connected/Reconnecting`。建议区分 `connecting / live / reconnecting(n) / offline`，并展示"已加载 N 条漏发事件"（后端已有 getHistory）。
2. **面板恒显 + 阶段化空态**：已修复恒显；进一步按 `loopPhase` 给出"规划中/执行中/评审中"引导态，而非空白。
3. **阻塞裁决前置化**：blocked 时在聊天区插入醒目的 continue/skip/abort 行动卡片 + 倒计时，而非仅侧栏。
4. **plan 可编辑闭环**：`updatePlan` 后端已支持，前端应提供"暂停→编辑 plan→恢复"的显式交互。
5. **流式可中断**：steering/stop 已有 API，UI 应在流式气泡上提供"打断/追加指令"。

### 5.3 可靠性 / 可扩展性

**可扩展性 🟢 基础良好**
- `AgentExecutor` 接口（`executor.ts:42`）已把执行策略解耦——可注入远程/沙箱/mock 执行器，是走向分布式的关键抽象。
- `PipelineHooks/LoopPipelineHooks`（`pipeline.ts:98-134`）提供 12 个生命周期切点，扩展无需改内核。
- `SessionRegistry` 支持多会话隔离 + 共享服务。

**可靠性 🟡 中，需补齐**
- 状态仅"内存 + jsonl"，**无事件溯源/可重放**；进程重启后运行态恢复能力弱。
- SSE 无背压治理；EventBus 广播对慢订阅者无缓冲/丢弃策略。
- 缺统一的编排级重试/补偿（worker 崩溃计数已有，但无幂等重放）。
- 缺分布式锁（RegionLock 为进程内），多实例部署会失效。

---

## 6. 对标业界最佳实践 & 分阶段路线图

### 6.1 业界参考（已检索）

- **多智能体编排综述**（arXiv《The Orchestration of Multi-Agent Systems》）：系统可靠性主要来自**编排机制**（角色、协议、收敛判定），而非单体智能强弱——SatoPi 的 roundtable/cloner 门控方向正确。
- **协调模式选型**：Supervisor / Swarm / Pipeline / Roundtable 各有适用面；SatoPi 已融合 Swarm(自组织) + Roundtable(评审) + Pipeline(波次)，建议**显式命名并文档化选型边界**。
- **SSE 生产实践**（LLM 流式）：自动重连 + **Last-Event-ID 断点续传** + 心跳 + BFF 资源释放 + 背压，是流式聊天的事实标准。
- **前端流式渲染**：token 级节流/批处理（Vercel AI SDK `throttle`）、稳定虚拟列表高度、增量语法高亮，是避免掉帧的通行做法。

### 6.2 分阶段路线图

#### P0（本轮已完成）——止血：两个顽固缺陷真修复
- [x] 传输层 `shouldReconnect` 重新武装，恢复自动重连。
- [x] `setActiveSSESession` 幂等化，消除重连抖动。
- [x] `ContextPanel` 显隐与数据解耦 + 空态占位。
- [x] `init()` 状态空值双保险守卫。
- [x] 3 个回归单测，全量 54 测试通过。

#### P1（1–2 周）——流式与连接达企业级 ✅ 已完成（分支 `feat/p1-streaming-reliability`）
- [x] **后端 SSE Last-Event-ID 断点续传**：`EventBus` 加 per-session ring buffer（seq 单调递增 + `id:` 帧）；`subscribe(lastEventId)` 重放 seq 超过分；`server.ts` 兼容查询参数 `lastEventId` 与 `Last-Event-ID` 头；传输层 `SseClient` 记录并在重连 URL 追加 `lastEventId`，`setUrl` 时重置以防跨会话串位；前端移除 getHistory 二重适用（避免重复）。
- [x] **前端 token 级批处理**：`stream_delta` 进 rAF 缓冲，同源合并后每帧 flush 一次，其它事件先 flush 保序 → 重渲染由 O(tokens) 降到 O(frames)。
- [x] **虚拟列表稳定化**：`measureElement`（既有）+ stick-to-bottom（用户在底部时随流式增长跟随，滚上去看历史则不打扰）。
- [x] **连接状态语义细化**：`connecting/live/reconnecting` 三态 + 重连 toast 去重（`id:"sse-reconnect"`，仅 live→lost→live 提示）。
- [x] **消息级 ErrorBoundary**：单条消息渲染失败不再连累整列，降级展示原文。
- [ ] **KaTeX/mermaid（按需）**：因当前环境离线、缺 `remark-math`/`rehype-katex`/`katex` 依赖未启用，留作后续 `bun add remark-math rehype-katex katex` 后接入。

> 验证：前端 57 单测通过（含新增 transport `lastEventId`、`connectionStatus` 回归）；后端 `event-bus.test.ts` 6 用例通过（replay/隔离/过滤/单调 id）。

#### P2（3–5 周）——编排内核重构与流程状态机（分支 `feat/p2-orchestration-statemachine`，进行中）
- [x] **显式 LoopPhase 状态机**（`swarm-state-machine.ts`）：作为**仲裁层而非驱动层**落地——不反转 `runLoop` 的长跑命令式控制流，仅集中「转移表 + guard 校验 + onEnter 原子广播（StateTracker+ActivityLogger 一步）+ onError 审计 + timed transition」。补全了此前缺失的转移（before-loop-*→idle 取消、paused/blocked→after-loop 中止、after-loop→running 重试、blocked→running 超时自动 continue）。非法转移不抛异常，仅拒绝并审计（契合「优先自治、必要才升级」）。
- [x] **LoopController 相位改道**：`pause/resume/blocked/unblock` 全部经由 `#setLoopPhase → 状态机`，后端成为 LoopPhase 唯一权威。
- [x] **前端纯投影**：`swarm-store` 移除本地相位推断补丁（`refreshState` 的 blocked 守卫、`addActivity` 的 blocked/running 特判），改为直接采用后端下发的权威 phase 事件（`AUTHORITATIVE_LOOP_PHASES`）。
- [x] 单测：`swarm-state-machine.test.ts` 13 用例（合法/非法/幂等/force/timed/错误隔离）全绿；前端 57、后端 state 12、nomination 30、event-bus 6 全绿。
- [x] **runLoop 拆分为纯函数单元（第一批）**：抽取 `convergence.ts`（`extractRoundSummary/parseNomination/jaccardSimilarity/findingsSimilarity/parseRoundSummaryJson` + `RoundSummaryData`，收敛判定纯逻辑）、`worker-scaler.ts`（`computeScaleDelta` 缩放投票决策）、`blockage.ts`（`evaluateBlockage` 停滞/崩溃阈值判定）。均为 side-effect-free、行为等价，`runLoop` 相应内联逻辑改为调用。
- [x] **前端阻塞裁决倒计时**：`BlockerContext` 增加 `timeoutMs/deadline`，`BlockerDialog` 增加实时倒计时（mm:ss + 紧迫度进度条 + 自动 continue 说明）。
- [x] **前端 plan 编辑闭环**：`PlanViewer` 在运行中提示「先暂停再编辑」并提供 Pause 按钮；暂停中提供 Resume（有未保存变更时禁用，引导先保存），形成 暂停→编辑→保存→恢复 闭环。
- [x] 单测：新增 `convergence.test.ts`(15) / `worker-scaler.test.ts`(8) / `blockage.test.ts`(6)；相关后端 8 文件共 **102 通过 / 0 失败**；前端 **57 通过**；loop 集成 smoke 无回归。
- [x] **修复既有 `robustness.test.ts`**：`RegionLockManager` 静态 `create()/reset()` 已移除（现为 per-session 实例），测试更新为实例化 API + 新增 releaseAll/release 隔离用例 → 12 通过（原 11 失败清零）。
- [x] **runLoop executor 对齐 pipeline**：`#spawnWorkers` 改为经 `this.#executor.execute()`（AgentExecutor 接口）而非直接 `runSubprocess`。worker 定义通过 `SwarmAgent + agentOverrides.systemPrompt` 映射，`timeoutMs:0` 保留迭代级 signal 控制不变。自定义执行器（远程/沙箱/mock）现可真正介入 worker 生成。锁释放与崩溃跟踪保留在 Promise 链中。
- [x] **流式打断指示器**：ChatView 顶部增加 `loopPhase==="running"` 常驻横条——脉冲绿点 + "Swarm is working" + Stop 按钮（迭代边界中断）。与原有底部输入栏 Stop 按钮共存，确保滚动中始终可触达。
- [ ] （剩余）统一 `LoopController` 与 `PipelineController` 编排范式（LoopController 复用 wave/hook 基类）——已通过 executor 对齐大幅收窄差距，完整复用在 P3。

#### P3（6–10 周）——可靠性与可扩展性对齐分布式

> **v2.1 更新**：`feat/p3-observability-tracing` 分支经审计确认为空壳（内容提交与 dev 已合并的 c339e3587 树完全相同）。以下 P3 工作需从头实现。

- [ ] **事件溯源**：状态由 activity 事件流可重放重建，支持进程重启恢复运行态。
- [ ] **可插拔执行器落地**：基于已有 `AgentExecutor` 接口实现远程/沙箱执行器，验证多机 worker。
- [ ] **分布式锁**替换进程内 RegionLock（如 Redis/etcd），支撑多实例。
- [ ] **SSE 背压治理**：慢订阅者缓冲上限 + 丢弃/降采样策略。
- [ ] **e2e（Playwright）**覆盖：启动→连接→before-loop→流式→切会话→阻塞裁决全链路。
- [ ] **可观测性**（v2.1 细化）：
  - [ ] Prometheus `/metrics` 端点（新增 `prom-client` 依赖）：Counter（swarm_runs_total / agent_spawns_total / tool_calls_total / blocker_events_total）、Histogram（tool_call_duration / iteration_count / roundtable_duration）、Gauge（active_sessions / sse_subscribers）
  - [ ] 健康检查：`/health`（轻量）+ `/health/ready`（含依赖检查：StateTracker / ExperienceStore / ModelRegistry）
  - [ ] Request ID 中间件：`crypto.randomUUID()` 注入到每个请求的日志和错误响应中
  - [ ] Swarm 编排层 OTel spans 扩展：worker spawn / roundtable debate / convergence check（已有 2000+ 行 GenAI telemetry，需补编排层）
- [ ] **集成债务清偿**（v2.1 新增 — 不属于分布式但属于企业级就绪）：
  - [ ] shadcn/ui 9 组件接入业务代码（替换原生 HTML）
  - [ ] 主题 CSS 变量接入所有组件（替换硬编码 `bg-neutral-*` 等 232 处）
  - [ ] i18n `useTranslation` 接入 15 个组件 + 创建 zh.json
  - [ ] 键盘快捷键 `useGlobalKeybindings` 挂载到 App.tsx
  - [ ] 12 个组件补齐 loading/empty/error 三态 + ErrorBoundary 包裹
  - [ ] 前端组件渲染测试（@testing-library/react 已安装，0 个组件测试）

---

## 7. 附录：本轮改动文件清单

| 文件 | 改动 |
|------|------|
| `packages/web/src/core/sse-client.ts` | `connect()` 重新武装 `shouldReconnect`（真修复断连） |
| `packages/swarm-gui/src/lib/sse-client.ts` | `setActiveSSESession` 幂等化 |
| `packages/swarm-gui/src/components/monitor/ContextPanel.tsx` | 解耦显隐 + 空态占位 |
| `packages/swarm-gui/src/stores/swarm-store.ts` | `init()` 空值双保险守卫 |
| `packages/swarm-gui/src/lib/__tests__/sse-client.test.ts` | +2 重连回归用例 |
| `packages/swarm-gui/src/stores/__tests__/swarm-store.test.ts` | +1 面板不消失回归用例 |
