# SatoPi 全面补齐清单

> 目标：从"优秀专业工程水准"升级到"业界顶级水平"
> 基准：对比 Cursor、Claude Code Web、Orca、Codeon、Juggler

---

## 缺口一：Worker 运行时输出浏览体验【最大差距】

### 1.1 Agent 执行时间轴

**现状**：Worker 输出在 ChatView 中以扁平消息流展示，无法按 Agent 分组、按时间轴浏览、按文件筛选。

**目标**：每个 Swarm 运行有一个时间轴视图，横向是时间，纵向是各 Agent 泳道。每次工具调用以颜色编码的色块显示（read=蓝、write=绿、bash=黄、edit=橙、error=红）。悬停显示工具输入/输出/耗时/token 消耗。

**实现**：
- 新增 `components/monitor/AgentTimeline.tsx`
- 数据来源：SSE 事件中已有的 `ActivityEntry` 字段（`from` + `ts` + `body`）
- 后端需补充：将 Worker 的工具调用记录为独立 SSE 事件类型 `tool_call`（含 `tool`/`file`/`duration`/`tokens` 字段）
- 使用 `d3-scale` 做时间轴映射，避免引入重型图表库

### 1.2 按 Agent 分组视图

**现状**：ChatView 中所有 Worker 消息混在一起，用 `from` 字段区分发送者。

**目标**：MonitorPage 新增 "By Agent" 视图标签，每个 Agent 一个可折叠区块，显示其全部输出。区块标题栏显示 Agent 名、状态、P/C/F 得分。支持一键展开/全部折叠。

**实现**：
- 修改 `MonitorPage.tsx`，在 viewMode 中新增 `"by-agent"` 选项
- 新增 `components/monitor/AgentOutputPanel.tsx`（虚拟滚动 group 列表）

### 1.3 代码 Diff 内联展示

**现状**：`DiffViewer` 组件存在但不与 ChatView 集成。Worker 的文件修改只以文本消息呈现，用户不知道具体改了哪些文件的哪些行。

**目标**：当 Worker 完成 `edit` 或 `write_file` 工具调用后，ChatView 中该工具调用卡片显示可展开的内联 Diff（使用 Monaco DiffEditor）。

**实现**：
- 后端 `activity-logger.ts` 新增 `logToolCall` 方法，推送 `tool_call` SSE 事件，携带 `{ tool, file, input, output, duration, tokens }`
- 前端 `swarm-store.ts` 新增 `toolCalls` 事件处理器
- 新增 `components/transcript/ToolCallCard.tsx`，对 `edit`/`write_file` 类型渲染内联 DiffViewer

### 1.4 文件变更跟踪面板

**现状**：`ContextPanel` 中有一个小型冲突展示，但不跟踪所有文件变更。

**目标**：新增一个 "Files" Tab，展示当前 Swarm 运行中所有被修改的文件列表，变更行数，最后修改者。点击文件打开 Diff 查看器。

**实现**：
- 扩展 `FileTracker` 后端通过 SSE 推送 `file_change` 事件
- 前端新增 `components/monitor/FileChangesPanel.tsx`

---

## 缺口二：测试覆盖【结构性风险】

### 2.1 前端单元测试

**当前覆盖率**：~7%（swarm-store、config-store、api-client、sse-client）。

**目标**：覆盖到 60%+（前端核心路径）。

| 待测试模块 | 测试内容 | 优先级 |
|-----------|---------|--------|
| `swarm-store.ts` | 扩展：pause/resume 状态转换、blocker 解决、AfterLoop 自动获取、SSE phase 事件全部分支 | P0 |
| `session-store.ts` | loadRuns、newSession、switchToSession、backToCurrent | P0 |
| `theme-store.ts` | dark/light/system 切换、localStorage 持久化 | P2 |
| `use-keybindings.ts` | Ctrl+Enter 发送、Escape 关闭、Ctrl+S 等组合键 | P2 |
| `PhasePipeline.tsx` | 各 LoopPhase 下的步骤状态计算 | P1 |
| `MonitorPage.tsx` | 各 LoopPhase 状态标签 + Pause/Resume/Stop 按钮渲染 | P1 |
| `ChatView.tsx` | canSend 逻辑、placeholder 各状态文案、虚拟滚动 | P1 |
| `ContextPanel.tsx` | Tab 切换、Agent 卡片、Verdict 展示 | P1 |
| `PlanViewer.tsx` | 编辑/预览切换、全屏模式、保存 | P2 |
| `AfterLoopPanel.tsx` | 经验分组、反思展示、统计数据 | P2 |
| `BlockerDialog.tsx` | 三种决策按钮、API 调用 | P1 |
| `ErrorBoundary.tsx` | 错误捕获后呈现 + 重试按钮 | P2 |

### 2.2 后端单元测试

**当前覆盖率**：~20%（10 个测试文件）。

**目标**：覆盖到 50%+。

| 待测试模块 | 测试内容 | 优先级 |
|-----------|---------|--------|
| `before-loop-manager.ts` | start → sendMessage → runDebate → confirm → cancel 完整生命周期 | P0 |
| `pipeline.ts` | 单 Wave、多 Wave、Wave 失败、abortAll、PipelineHooks 全部生命周期 | P0 |
| `role-asset.ts` | CRUD + 审批流程 + seedIfEmpty + 搜索 | P0 |
| `todo-tracker.ts` | parseFromPlan、complete、add、状态转换 | P1 |
| `after-loop/extractor.ts` | 规则引擎提取经验教训、统计计算 | P1 |
| `task-analyzer.ts` | 计划复杂度分析、auto scaling 推荐 | P1 |
| `file-tracker.ts` | 文件冲突检测、作者追踪 | P1 |
| `cloner-roundtable.ts` | 加权投票、否决权、一致性计算 | P1 |
| `before-loop.ts` | generatePlanningPrompt、stampAndArchivePlanMd | P2 |
| `loop-controller.ts` | 阻塞检测条件、收敛判定、VerdictAndScaling hook | P1 |

### 2.3 E2E 测试

**当前**：2 个 Playwright 文件（monitor.spec.ts 4 用例 + before-flow.spec.ts 1 用例）+ Bun API 测试 52 用例。

**目标**：覆盖关键端到端流程。

| 场景 | 描述 | 优先级 |
|------|------|--------|
| 完整 Swarm 生命周期 | idle → 输入任务 → Socrates 对话 → 点击 Debate → 点击 Confirm → 等待运行 → 发送 Steering → 停止 → After Loop 面板 | P0 |
| 阻塞流程 | Swarm 被阻塞 → BlockerDialog 出现 → Continue/Skip/Abort 各自验证 | P0 |
| 暂停/恢复 | 运行中点击 Pause → 点击 Resume | P1 |
| 配置持久化 | 修改 Worker 数量 + 模型 → 保存 → 刷新页面 → 验证值保持 | P1 |
| 历史会话查看 | 历史列表可见 → 点击切换 → 验证消息回放 → Back to live | P1 |
| Plan 编辑 | 打开 Plan 面板 → 切换到编辑模式 → 修改 → 保存 → 验证刷新 | P2 |
| 角色管理 | RoleBrowser 打开 → 搜索 → 展开 → 审批 → 创建新角色 | P2 |

---

## 缺口三：可访问性

### 3.1 键盘导航

**现状**：只有 5 个全局快捷键（`use-keybindings.ts`），且只在非输入框中生效。

**目标**：WCAG 2.1 AA 基础通过。

| 项 | 描述 | 优先级 |
|----|------|--------|
| Tab 焦点顺序 | 所有可交互元素有逻辑 Tab 顺序 | P1 |
| 焦点环 | `focus-visible:ring-2 ring-primary` 全局应用，当前已有 shadcn 提供基础 | P1 |
| 跳过导航 | 顶部加 skip-to-content 链接 | P2 |
| 键盘 Esc | Modal/Dialog 关闭（BlockerDialog 已有；Confirm Dialog 待补充） | P1 |
| aria-labels | 所有纯图标按钮添加 `aria-label`（Sidebar 已有 `title`，需确认全部覆盖） | P1 |
| 状态通知 | `aria-live="polite"` 区域用于 SSE 状态变化通知 | P2 |

### 3.2 色彩对比度

**现状**：`fg-faint (#525252)` 在暗色背景 `bg (#0A0A0A)` 上的对比度约 4.1:1，刚好不满足 WCAG AA 的 4.5:1。

**修复**：将 `fg-faint` 从 `#525252` 改为 `#737373`（对比度 4.6:1）。

### 3.3 减少动画

**现状**：有 `animate-spin`、`animate-pulse-ring` 动画。

**修复**：在 `globals.css` 添加 `@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation-duration: 0.01ms !important; } }`。

---

## 缺口四：Worker 运行时可视化增强

### 4.1 Agent 状态卡片增强

**现状**：`ContextPanel` 中 `WorkerCard` 显示 name + status dot + score（P/C/F）。

**目标**：增强到显示当前正在处理的文件和工具调用。例如："worker-1 · editing src/auth.ts"、"worker-2 · reading docs/api.md"。

**实现**：后端在 Worker 开始 tool call 时推送 `tool_call` SSE 事件。前端 swarm-store 维护一个 `Map<string, { tool: string; file?: string }>` ，Agent 卡片实时订阅。

### 4.2 文件变更数量徽章

**现状**：无。

**目标**：MonitorPage 顶栏显示 `N files changed` 徽章，用户一眼看到 Swarm 产生了多少文件变更。

**实现**：后端 `FileTracker` 通过 SSE 推送 `file_change` 事件，前端累计并展示。

---

## 缺口五：动效和微交互

### 5.1 页面过渡

**现状**：Config ↔ Monitor ↔ History 页面切换无过渡动画。

**目标**：添加 200ms fade-in 过渡。

**实现**：在 `<main>` 容器上添加 `animate-in fade-in-0 duration-200`（利用 Tailwind 4 内置动画类）。

### 5.2 消息气泡进场

**现状**：新消息直接出现，无动画。

**目标**：新消息从下方滑入 + 透明度淡入（200ms），类似聊天应用的体感。

**实现**：`MessageBubble` 添加 `animate-slide-in-from-bottom-2 fade-in-0 duration-200`。

### 5.3 Agent 拓扑图动效

**现状**：静态。

**目标**：活跃通信的边显示流动动画（`animate-dash-flow` 已有定义），新建/销毁 Agent 节点有缩放过渡。

**实现**：React Flow 边的 `animated: true` 已部分启用。需根据 Agent 活跃状态动态设置。

---

## 缺口六：部署和工程基础设施

### 6.1 Lighthouse 性能优化

| 项 | 描述 | 优先级 |
|----|------|--------|
| Monaco Editor 按需加载 | 已用 `React.lazy`，需确认 `DiffEditor` 也懒加载 | P1 |
| 图片优化 | favicon 用 SVG | P2 |
| Brotli 压缩 | Vite build 开启 brotli | P2 |
| Bundle 分析 | 添加 `rollup-plugin-visualizer` 可视化依赖体积 | P2 |

### 6.2 CI/CD

| 项 | 描述 | 优先级 |
|----|------|--------|
| GitHub Actions | PR 时运行 `tsc --noEmit` + `vitest` + `vite build` | P1 |
| 类型检查门禁 | 0 errors 才允许合并 | P1 |
| Playwright E2E | CI 中运行（需要后端启动） | P2 |

---

## 缺口七：文档和开发者体验

### 7.1 Storybook

**现状**：无。

**目标**：为核心 UI 组件建立 Storybook，便于独立开发和视觉审查。

**范围**：EmptyState、StatusBadge、PhasePipeline、ChatView、MonitorPage、BlockerDialog、ContextPanel。

### 7.2 API 文档

**现状**：后端 API 是无文档的，只能通过 `api-routes.ts` 阅读代码。

**目标**：在 `docs/api.md` 中列出所有端点、请求/响应格式。

---

## 优先级矩阵

| 优先级 | 缺口项 | 工作量 | 影响 |
|--------|-------|--------|------|
| P0 | Agent 执行时间轴 | 大（5-8天） | 核心体验质变 |
| P0 | 代码 Diff 内联展示 | 中（3-5天） | 核心体验质变 |
| P0 | 前端单元测试（swarm-store, session-store, monitor 组件） | 中（3-5天） | 降低回归风险 |
| P0 | 后端测试（before-loop-manager, pipeline, role-asset） | 中（3-5天） | 降低回归风险 |
| P0 | E2E 关键流程测试 | 中（3-5天） | 端到端保障 |
| P1 | 按 Agent 分组视图 | 小（2-3天） | 浏览体验 |
| P1 | 文件变更跟踪面板 | 小（2-3天） | 透明度 |
| P1 | 后端 tool_call SSE 事件 | 小（1-2天） | 下层基础设施 |
| P1 | Agent 状态卡片增强 | 小（1-2天） | 实时信息 |
| P1 | 键盘导航（Tab 焦点 + aria-labels） | 小（1-2天） | 可访问性 |
| P1 | GitHub Actions CI | 小（1天） | 工程质量 |
| P2 | 色彩对比度修复 | 小（0.5天） | 可访问性 |
| P2 | 减少动画媒体查询 | 小（0.5天） | 可访问性 |
| P2 | 页面过渡 + 消息气泡进场动画 | 小（1天） | 交互品质 |
| P2 | Lighthouse 优化 | 小（1天） | 性能 |
| P2 | Storybook | 中（3-5天） | 开发体验 |
| P2 | API 文档 | 小（1天） | 开发体验 |

## 总估算

| 类目 | P0 项 | P1 项 | P2 项 | 总人天 |
|------|-------|-------|-------|--------|
| Worker 输出体验 | 时间轴 + Diff | Agent 分组 + 文件面板 | - | 12-18天 |
| 测试覆盖 | 前端核心 + 后端核心 + E2E | - | 周边模块 | 9-15天 |
| 可访问性 | - | 键盘 + aria | 色彩 + 动画 | 2-4天 |
| 可视化增强 | - | 状态卡片 + 事件 | 拓扑图动效 | 3-5天 |
| 动效 | - | - | 过渡 + 进场 | 1天 |
| 基础设施 | - | CI | Lighthouse + Storybook + API 文档 | 3-6天 |
| **合计** | **15-23天** | **8-13天** | **7-12天** | **30-48天** |
