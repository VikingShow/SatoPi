# SatoPi 补齐方案：可复用资源与开源方案

## 第一部分：项目内可直接复用

### 1.1 collab-web 的 Tool Renderer 体系（最大资产）

位置：`packages/collab-web/src/tool-render/`

这是 omp 项目内置的专业工具渲染器库，32 种工具各有独立渲染器。每个渲染器遵循 Summary/Body 双组件模式——Summary 是一行摘要（用于消息气泡摘要），Body 是展开详情（用于点击展开后的完整视图）。

核心可复用模块：

| 模块 | 位置 | 描述 | 用在何处 |
|------|------|------|---------|
| `DiffBlock` | `parts.tsx:240` | 纯 CSS 的 unified diff 渲染，逐行着色（+/−/@@ hunk），支持折叠 | ChatView 中 Worker 文件修改的即时预览，比 Monaco DiffEditor 轻 100 倍 |
| `CodeBlock` | `parts.tsx:135` | 语法高亮代码块（hljs），支持行数限制 + 展开 | ChatView 中 Worker 生成的代码片段 |
| `Output` | `parts.tsx:106` | 多行输出文本展示，支持 plain/code 两种模式，行数裁剪 | Worker bash 命令输出、日志等 |
| `Badge` / `Badges` | `parts.tsx:13` | 行内标签（ok/err/warn/accent 四种语义色） | 工具调用摘要行：显示文件名、行数、退出码 |
| `PathText` | `parts.tsx:32` | 文件路径 + 行号范围（e.g. `src/auth.ts:42-58`） | 工具调用摘要行 |
| `ToolRenderer` 接口 | `types.ts` | `Summary` + `Body` 双组件契约 | 新工具渲染器的类型约束 |
| `resolveToolRenderer` | `registry.ts` | 按名称查找渲染器，未知回退到 generic JSON 渲染器 | 核心调度逻辑 |

**如何复用**：将整个 `tool-render/` 目录提取到 `packages/web/src/tool-render/`（共享核心包），添加一个 swarm 专用的 `tool_call` 渲染器。前端 swarm-gui 的 ChatView 中，消息气泡的 body 部分调用 `ToolCard` 组件（参考 `collab-web/src/components/transcript/ToolCard.tsx`），对不同类型的工具调用显示不同的可视化。

### 1.2 已有的 Monaco DiffEditor 封装

位置：`packages/swarm-gui/src/components/monitor/CodeEditor.tsx`

当前 `DiffViewer` 组件已经封装了 `@monaco-editor/react` 的 `DiffEditor`，支持：
- 懒加载（`React.lazy`）
- 自动语言检测（37 种扩展名映射）
- 原/改行数统计

**如何复用**：在 ChatView 消息气泡中，对 `edit` 和 `write_file` 类型的 tool_call 直接渲染内联 `DiffViewer`（传 `height="300px"`）。

### 1.3 Shiki 高亮器

位置：`packages/web/src/core/shiki.ts`

已支持 8 种语言缓存，可通过 `highlightCode(code, lang)` 一步调用。

### 1.4 已有的共享组件

| 组件 | 位置 | 用途 |
|------|------|------|
| `EmptyState` | `shared/EmptyState.tsx` | 时间轴空状态、文件变更为空等 |
| `SseClient<T>` | `web/src/core/sse-client.ts` | 新增 SSE 事件类型的基础设施 |
| `fetchJson<T>` | `web/src/core/fetch-wrapper.ts` | 新 API 调用 |
| `ErrorBoundary` | `components/ErrorBoundary.tsx` | 新组件错误兜底 |

### 1.5 后端已有的基础设施

| 模块 | 位置 | 描述 |
|------|------|------|
| `ActivityLogger` | `activity-logger.ts` | 已有 9 种事件类型，只需新增 `logToolCall` 方法 |
| `MonitorServer` / SSE | `monitor/server.ts` | 已有 SSE 推送通道，新事件类型自动广播 |
| `FileTracker` | `file-tracker.ts` | 已追踪文件修改者、冲突、路径，只需暴露 SSE 事件 |
| `StateTracker` | `state.ts` | 已有文件持久化 + REST 暴露 |

---

## 第二部分：外部可复用方案

### 2.1 AgentPrism（Agent 执行时间轴）

仓库：`evilmartians/agent-prism`  
npm：`agent-prism`  
许可：开源（MIT）

- React 19 + Tailwind 4，与 SatoPi 技术栈完全一致
- 专为 AI Agent trace 可视化设计，数据模型是 spans（含 name、duration、status、children）
- 核心组件：`TraceViewer`（列表 + 树形 + 详情面板三栏布局）、`Timeline`（横向甘特图）、`SpanDetails`（元数据展示）
- 状态：Alpha（API 可能变化），但 293 星且来自 Evil Martians（React 社区知名团队）

**集成方式**：后端推送 `tool_call` SSE 事件时携带 `{ name, tool, file, duration, tokens, status }`，前端收敛为 span 列表传入 `TraceViewer`。

### 2.2 railtracks-timeline（轻量替代 AgentPrism）

npm：`@railtownai/railtracks-timeline`  
许可：MIT

- React 18+，TypeScript，零依赖
- 两种模式：tree（层次化）和 flat（扁平时间线）
- 接口简单：传入 `AgentRun` 对象即可渲染

**集成方式**：如果 AgentPrism 过重或 API 不稳定，这作为轻量备选。

### 2.3 react-diff-viewer-continued（轻量 Diff 替代 Monaco）

npm：`react-diff-viewer-continued`（React 19 版 `react-diff-viewer-continued-react19`）

- 类 GitHub 风格，split 和 unified 两种视图
- 支持 word-level diff
- Monaco 之外的最流行选择

**判断：不引入。** 项目已有两套方案：Monaco `DiffEditor`（重量级精确 diff）和 collab-web `DiffBlock`（轻量级 CSS diff）。`react-diff-viewer-continued` 在两者之间，没有足够独特优势。

### 2.4 外部方案总结

| 方案 | 引入？ | 理由 |
|------|--------|------|
| AgentPrism | ✅ 引入 | 技术栈完全对齐，293 星，Evil Martians 出品，专为 AI agent trace 设计 |
| railtracks-timeline | ⬜ 备选 | 如果 AgentPrism 太重则用这个 |
| react-diff-viewer-continued | ❌ 不引入 | 已有 Monaco DiffEditor + collab-web DiffBlock 覆盖需求 |
| @monaco-editor/react | ✅ 已引入 | 项目已有，只需在 ChatView 中连线 |
| colab-web tool-render | ✅ 提取复用 | 提取 DiffBlock/CodeBlock/Badge 到 pi-web 共享核心 |

---

## 第三部分：具体执行方案

### Step 1：提取 collab-web tool-render 核心到 pi-web

**新建文件**：
```
packages/web/src/tool-render/
├── parts.tsx          ← 从 collab-web/src/tool-render/parts.tsx 提取
├── types.ts           ← 从 collab-web/src/tool-render/types.ts 提取
├── util.ts            ← 从 collab-web/src/tool-render/util.ts 提取（只提取 swarm-gui 需要的函数）
├── registry.ts        ← 精简版注册表（只注册 swarm 相关工具）
├── tool-render.css    ← 提取 tv-* CSS 类
└── ToolCard.tsx       ← 新组件：组合 Summary + Body + DiffBlock 的卡片
```

**提取后删除的内容**：collab-web 独有依赖（`HljsLike`、`ToolResultImage` 图片渲染、`AgentLink` 导航等）。

**为什么不全量引入**：collab-web 的 tool-render 依赖 `hljs`（highlight.js），而 swarm-gui 已用 `Shiki`。`DiffBlock` 是纯 CSS 不需要 hljs；`CodeBlock` 需要改写为 Shiki。保留结构、替换底层实现。

### Step 2：新增后端 tool_call SSE 事件

**修改文件**：`packages/coding-agent/src/swarm/activity-logger.ts`

新增方法：
```typescript
logToolCall(agent: string, tool: string, file?: string, 
  details?: { duration?: number; tokens?: number; exitCode?: number }): void {
  this.#emit({
    ts: Date.now(),
    type: "tool_call",
    from: agent,
    tool,
    file,
    ...details,
  });
}
```

新增 SSE 事件类型：`tool_call`（追加到 `ActivityEventType` 联合类型）。

### Step 3：新增 file_change SSE 事件

**修改文件**：`packages/coding-agent/src/swarm/activity-logger.ts`

新增方法：
```typescript
logFileChange(agent: string, file: string, action: "created" | "modified" | "deleted",
  linesChanged?: number): void {
  this.#emit({
    ts: Date.now(),
    type: "file_change",
    from: agent,
    file,
    action,
    linesChanged,
  });
}
```

### Step 4：前端 ChatView 嵌入工具调用卡片

**修改文件**：`packages/swarm-gui/src/components/monitor/ChatView.tsx`

在 `MessageBubble` 的 body 渲染中：如果消息中包含 `[tool_call]` 标记，渲染 `<ToolCard>` 组件，对 edit/write_file/grep/read/bash 等不同工具使用不同视觉呈现（文件名 + DiffBlock / CodeBlock / Output）。

### Step 5：新增 AgentTimeline 组件

**新建文件**：`packages/swarm-gui/src/components/monitor/AgentTimeline.tsx`

从 SSE `tool_call` 事件构建时间轴，按 Agent 分泳道。复用 AgentPrism 的 `TraceViewer` 组件（对接数据格式）。

### Step 6：新增 FileChangesPanel

**新建文件**：`packages/swarm-gui/src/components/monitor/FileChangesPanel.tsx`

从 SSE `file_change` 事件构建文件列表。添加到 ContextPanel 的新 Tab 或 MonitorPage 的新 viewMode。

### Step 7：补齐测试

按优先级执行上一份清单中的 P0/P1 测试计划。

---

## 第四部分：文件变更总览

```
新增:
  packages/web/src/tool-render/parts.tsx
  packages/web/src/tool-render/types.ts
  packages/web/src/tool-render/util.ts
  packages/web/src/tool-render/registry.ts
  packages/web/src/tool-render/tool-render.css
  packages/swarm-gui/src/components/transcript/ToolCard.tsx
  packages/swarm-gui/src/components/monitor/AgentTimeline.tsx
  packages/swarm-gui/src/components/monitor/FileChangesPanel.tsx

修改:
  packages/coding-agent/src/swarm/activity-logger.ts   (+logToolCall, +logFileChange)
  packages/coding-agent/src/swarm/file-tracker.ts       (调用 logFileChange)
  packages/coding-agent/src/swarm/monitor/standalone.ts (loop-controller 传 logToolCall)
  packages/swarm-gui/src/lib/types.ts                   (+ActivityEventType)
  packages/swarm-gui/src/stores/swarm-store.ts          (+toolCalls, +fileChanges)
  packages/swarm-gui/src/components/monitor/ChatView.tsx (嵌入 ToolCard)
  packages/swarm-gui/src/components/monitor/MonitorPage.tsx (+Timeline/ByAgent/Files viewModes)

外部依赖新增:
  agent-prism  (npm install agent-prism)
```
