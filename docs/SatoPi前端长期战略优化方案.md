# SatoPi 前端长期战略优化方案

> 制定日期：2026-07-17
> 目标：将 SatoPi 的 Web 前端从 MVP 阶段升级到业界顶级水平

---

## 一、现状基准

| 维度 | 当前状态 | 目标状态 |
|------|---------|---------|
| 前端代码量 | ~1,300 行，13 个源文件 | 15,000-20,000 行，80+ 源文件 |
| 测试覆盖 | 0% | 80%+（单元 60% + E2E 20% + 视觉回归 10%） |
| React 版本 | 18.3 | 19.2（对齐上游 omp） |
| Tailwind | 3.4 + 手写 CSS | 4.3 + shadcn/ui |
| 组件体系 | 纯手写 | shadcn/ui + Radix + 自定义 |
| 后端测试 | ✅ 已有 10 个 swarm 测试 | 扩展到 30+ 测试 |
| 包数量 | swarm-gui + collab-web（分离） | 统一 @oh-my-pi/pi-web（可独立发布的 SDK 包 + 内置 App） |

---

## 二、三阶段路线图

```

                         Phase 1            Phase 2              Phase 3
                    "基础现代化"        "体验升级"           "业界顶级"
                    6-8 周             8-12 周              12-16 周

  代码行数         1,300  → 5,000     5,000  → 12,000      12,000 → 20,000
  源文件            13  → 35            35  → 70              70 → 100+
  测试覆盖          0% → 40%          40% → 70%             70% → 85%
  组件库            手写 Tailwind     shadcn/ui 覆盖        Design System 成熟
  用户体验          基础可用           流畅专业              业界标杆
```

---

## 三、Phase 1：基础现代化（6-8 周）

### 3.1 技术栈升级（第 1 周）

```
React 18.3 → 19.2         # 对齐上游 omp，支持 Server Components 预备
Vite 5.3 → 6.x            # 更快的 HMR，更好的 CSS 处理
Tailwind 3.4 → 4.3        # CSS-first 配置，更小的 bundle
TypeScript 5.5 → 7.0      # 对齐上游类型系统
```

**风险点**：Tailwind 3→4 的配置迁移需要重写 `tailwind.config.ts` 为 CSS-based 配置。
**缓解**：TW4 提供了自动迁移工具，影响范围限于 swarm-gui 一个包。

### 3.2 引入 shadcn/ui 组件库（第 2 周）

**目标**：用 shadcn/ui 替换所有手写的按钮、输入框、卡片、对话框。

| 当前手写组件 | 替换为 |
|-------------|--------|
| 自定义按钮 | `shadcn/ui Button` + variants |
| 自定义输入框 | `shadcn/ui Input` + `Textarea` |
| 自定义卡片 | `shadcn/ui Card` |
| 自定义对话框 (BlockerDialog) | `shadcn/ui Dialog` + `AlertDialog` |
| 自定义 Toggle | `shadcn/ui Switch` |
| 自定义下拉 | `shadcn/ui Select` + `DropdownMenu` |
| 手写滚动条 | `shadcn/ui ScrollArea` |

**操作步骤**：
1. `npx shadcn-ui@latest init` 在 swarm-gui 中初始化
2. 逐个替换组件，每替换一个进行一次视觉回归对比
3. 统一 Design Tokens（颜色、字体、圆角、阴影）

### 3.3 引入代码语法高亮（第 2 周）

当前 Markdown 渲染中的代码块无语法高亮：

```tsx
// 当前
<pre><code>{code}</code></pre>

// 目标：Shiki 集成
import { codeToHtml } from "shiki";
```

**选择 Shiki 的理由**：
- 与 TextMate 语法兼容（VS Code 同款高亮引擎）
- 支持所有主流语言
- 暗色主题完整（与 SatoPi 暗色主题一致）
- 比 Prism 更准确

### 3.4 SSR 友好的 SSE 客户端（第 3 周）

当前 `SSEClient` 直连 `localhost:7878`，硬编码端口和路径：

```typescript
// 当前问题
const host = window.location.hostname;
return `http://${host}:7878/events`;

// 目标：相对路径 + 自动发现
const url = new URL("/events", window.location.origin);
// Vite proxy 在生产构建中处理路由
```

**改进**：
- 支持通过 Vite proxy 连接（开发模式已配置，但 SSE 绕过了）
- 添加心跳检测和自动重连状态指示器
- 支持 `EventSource` polyfill for 旧浏览器
- 添加事件类型过滤（按 ActivityEventType 过滤订阅）

### 3.5 测试基础设施（第 3-4 周）

**目标**：建立三层测试体系。

```
├── src/**/*.test.ts          # Vitest 单元测试（stores, lib）
├── src/**/*.test.tsx         # React Testing Library 组件测试
├── e2e/                      # Playwright E2E 测试
└── visual/                   # 视觉回归（可选，用 Chromatic 或 Percy）
```

**必须覆盖的测试**：

| 模块 | 测试内容 | 优先级 |
|------|---------|--------|
| `swarm-store.ts` | 消息处理、乐观更新、状态转换、SSE 事件分发 | 🔴 最高 |
| `api-client.ts` | Mock fetch，覆盖所有 API 端点 | 🔴 最高 |
| `sse-client.ts` | Mock EventSource，重连逻辑 | 🟡 高 |
| `MonitorPage.tsx` | 各 loopPhase 的渲染快照 | 🟡 高 |
| `ChatView.tsx` | 消息发送、三种输入模式切换 | 🟡 高 |
| `PlanViewer.tsx` | Markdown 编辑/预览切换、全屏 | 🟢 中 |
| `TodoList.tsx` | 折叠/展开、进度条计算 | 🟢 中 |
| `BlockerDialog.tsx` | 三种解决选项、API 调用 | 🟢 中 |

**后端测试补充**（Phase 1 可选）：

```
packages/coding-agent/src/swarm/__tests__/
  before-loop-manager.test.ts    # BeforeLoopManager 集成测试
  after-loop-pipeline.test.ts    # After Loop 管线测试
  monitor-api-routes.test.ts     # API 路由单元测试
  sse-event-serialization.test.ts # SSE 事件格式验证
```

### 3.6 移动端响应式基础（第 4 周）

```css
/* 添加基础断点 */
@layer base {
  /* 默认: Desktop (当前状态) */
  /* sm: Tablet — 单栏布局，侧边栏变成底部 TabBar */
  /* xs: Mobile — 精简视图，隐藏详细面板 */
}
```

**移动端布局策略**：

| 组件 | Desktop | Tablet | Mobile |
|------|---------|--------|--------|
| Sidebar | 固定左侧 | 底部 TabBar | 底部 TabBar |
| ChannelList + Chat + ContextPanel | 三栏 | Chat 全宽 + 抽屉式面板 | Chat 全宽 |
| ConfigPage | 表单 + YAML 预览 | 表单全宽 | 表单全宽 |
| PhasePipeline | 水平条 | 水平条（可滚动） | 水平条（精简文本） |

### 3.7 键盘快捷键（第 4 周）

```typescript
// 参考 omp TUI 的键位系统
const KEYBINDINGS = {
  "ctrl+k": "commandPalette",      // 命令面板（全局搜索）
  "ctrl+enter": "sendMessage",     // 发送消息
  "ctrl+1": "nav:monitor",         // 切换到 Monitor
  "ctrl+2": "nav:config",          // 切换到 Config
  "ctrl+3": "nav:history",         // 切换到 History
  "escape": "closeDialog",         // 关闭弹窗
  "ctrl+shift+p": "togglePlan",    // 切换计划面板
};
```

---

## 四、Phase 2：体验升级（8-12 周）

### 4.1 统一 Web 前端架构（第 5-6 周）

**核心决策**：将 `swarm-gui` 和 `collab-web` 合并为统一的 `@oh-my-pi/pi-web` 包。

**架构设计**：

```
packages/web/                         # 新包: @oh-my-pi/pi-web
├── package.json
├── src/
│   ├── core/                        # 可独立发布的 SDK
│   │   ├── client.ts               # 通用 GuestClient（从 collab-web 提取）
│   │   ├── sse-client.ts           # 通用 SSE 客户端
│   │   ├── stores/                 # 状态管理
│   │   │   ├── session-store.ts    # 通用 session store
│   │   │   ├── swarm-store.ts      # swarm 专用 store
│   │   │   └── config-store.ts     # 配置 store
│   │   ├── codec.ts                # 加密/解码（从 collab-web 提取）
│   │   └── types.ts                # 通用类型定义
│   │
│   ├── components/                  # 共享 UI 组件库
│   │   ├── ui/                     # shadcn/ui 组件
│   │   ├── chat/                   # 聊天相关
│   │   │   ├── ChatView.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   ├── Composer.tsx
│   │   │   └── ThinkingBlock.tsx
│   │   ├── transcript/             # session transcript
│   │   │   ├── Transcript.tsx
│   │   │   ├── ToolCard.tsx
│   │   │   └── Markdown.tsx
│   │   ├── editor/                 # 代码和文本编辑
│   │   │   ├── CodeEditor.tsx      # Monaco 封装
│   │   │   ├── DiffViewer.tsx
│   │   │   └── MarkdownEditor.tsx
│   │   ├── files/                  # 文件浏览
│   │   │   ├── FileTree.tsx
│   │   │   └── FilePreview.tsx
│   │   ├── terminal/               # 终端
│   │   │   └── Terminal.tsx        # xterm.js 封装
│   │   └── shell/                  # 应用壳
│   │       ├── AppShell.tsx        # 通用布局壳
│   │       ├── Sidebar.tsx
│   │       └── CommandPalette.tsx
│   │
│   ├── apps/                       # 应用入口
│   │   ├── swarm/                  # SatoPi Swarm 监控
│   │   │   ├── App.tsx
│   │   │   ├── monitor/
│   │   │   ├── config/
│   │   │   └── history/
│   │   └── collab/                 # omp 协作前端
│   │       ├── App.tsx
│   │       └── ...
│   │
│   └── styles/
│       ├── globals.css
│       └── tokens.css
```

**为什么合并**：
1. 两个 App 都需要 ChatView、Markdown、Transcript 组件
2. 都连接同一个后端（omp coding-agent）
3. 减少维护负担（一套组件，两个入口）
4. 代码量可减少 30-40%（消除重复逻辑）

### 4.2 Agent 拓扑图可视化（第 7-8 周）

使用 **React Flow** 或 **Cytoscape.js** 展示 Swarm 运行时的 Agent 关系图。

```typescript
// 节点定义
interface AgentNode {
  id: string;
  type: "socrates" | "cloner" | "worker" | "reviewer";
  status: AgentStatus;
  data: {
    name: string;
    score: number;
    iteration: number;
    modelName: string;
  };
}

// 边定义
interface AgentEdge {
  source: string;        // 消息发出者
  target: string;        // 消息接受者
  type: "message" | "mentor" | "review" | "conflict";
  animated: boolean;     // 活跃时动画
  label?: string;
}
```

**交互功能**：
- 节点点击 → 打开该 Agent 的详细面板（消息历史、文件变更）
- 边悬停 → 显示通信统计
- 拖拽布局 / 自动布局切换
- 时间轴回放（拖动时间滑块，回放 Swarm 状态演变）
- Worker 扩缩容动画（节点出现/消失的过渡效果）

### 4.3 内嵌代码编辑器（第 8-9 周）

**Monaco Editor 集成**：

```tsx
// packages/web/src/components/editor/CodeEditor.tsx
import Editor, { type OnMount } from "@monaco-editor/react";

export function CodeEditor({ value, language, path, onChange, readOnly }: Props) {
  // 1. 自动检测语言（从文件扩展名）
  // 2. 支持 Diff 模式（显示 Worker 修改前后的对比）
  // 3. LSP 诊断信息展示（如果有）
  // 4. 行内评论（Cloner Review 意见）
}
```

**核心场景**：
1. **Plan 编辑器升级**：将当前的 `<textarea>` 替换为 Monaco
2. **Diff 查看器**：在 Worker 产生文件变更后，显示 before/after diff
3. **代码审查面板**：Cloner Review 时可以高亮代码并添加行内评论
4. **文件浏览器**：点击文件直接在编辑器中打开（只读模式）

### 4.4 内嵌终端（第 9 周）

**xterm.js 集成**：

```tsx
// 使用 @xterm/xterm（omp 已依赖 @xterm/headless）
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
```

**功能**：
- 连接到 Swarm 运行所在目录的 shell
- 支持多个终端 tab
- Worker 的 bash 命令输出直接流式到对应终端面板
- 命令历史搜索

### 4.5 通知系统（第 10 周）

```typescript
// 三层通知
interface NotificationSystem {
  // 1. 浏览器 Notification API（桌面通知）
  desktop: {
    onRunComplete: () => void;    // Swarm 运行完成
    onBlocker: () => void;         // 需要人工干预
    onWorkerCrash: () => void;   // Worker 崩溃
  };
  
  // 2. In-app Toast（应用内提示）
  toast: {
    phaseChange: (phase: string) => void;
    planUpdated: () => void;
    agentScaled: (name: string) => void;
  };
  
  // 3. Sound（可选音效）
  sound: {
    onComplete: "complete.mp3";
    onError: "error.mp3";
  };
}
```

### 4.6 主题系统（第 10-11 周）

```css
/* Design Tokens → CSS Custom Properties */
:root {
  --color-bg: #0A0A0A;
  --color-bg-card: #141414;
  --color-primary: #F59E0B;
  /* ... */
}

/* 支持自定义主题 */
[data-theme="light"] { /* 亮色主题 */ }
[data-theme="tokyo-night"] { /* 预设主题 */ }
[data-theme="custom"] { /* 用户自定义 */ }
```

**通过 CSS 变量实现**，不引入 CSS-in-JS 运行时。参考 omp TUI 的既有多主题设计。

### 4.7 国际化 i18n（第 11 周）

使用 **i18next** + **react-i18next**：

- 默认英文
- Phase 2 支持中文（简体）
- 社区贡献日文、韩文
- 所有 UI 文案提取为 key

### 4.8 E2E 测试（第 11-12 周）

使用 **Playwright** 编写关键流程测试：

```typescript
// e2e/swarm-lifecycle.spec.ts
test("full swarm lifecycle", async ({ page }) => {
  // 1. 访问 Config 页面，修改参数，保存
  // 2. 切换到 Monitor，输入任务，开始 Before Loop
  // 3. 验证 Socrates 对话出现
  // 4. 点击 Run Debate，验证进入辩论阶段
  // 5. 点击 Confirm & Start，验证 Swarm 开始运行
  // 6. 验证 Agent 卡片出现和状态更新
  // 7. 等待运行完成，验证 After Loop 面板
});

// e2e/blocker-flow.spec.ts
test("blocker resolution flow", async ({ page }) => {
  // 模拟 Swarm 被阻塞
  // 验证 BlockerDialog 出现
  // 点击 Continue, Skip, Abort 各一次
});

// e2e/config-persistence.spec.ts  
test("config save and reload", async ({ page }) => {
  // 修改配置 → 保存 → 刷新页面 → 验证配置持久化
});
```

---

## 五、Phase 3：业界顶级（12-16 周）

### 5.1 多人实时协作（第 13-14 周）

**复用 omp collab 协议**（AES-256-GCM + Relay + WebSocket）：

```typescript
// 多人 Swarm 操作台
// - 多个用户同时观看同一个 Swarm 运行
// - 各自有独立的视图（频道选择、面板折叠状态）
// - 操作员权限控制（谁是当前操作员）
// - 聊天消息带用户头像
// - 光标位置同步（可选）
```

**实现路径**：
1. 复用 `packages/collab-web/src/lib/socket.ts` 的 WebSocket 客户端
2. 复用 `packages/collab-web/src/lib/codec.ts` 的加密层
3. 在 swarm-gui 的 Zustand store 上添加 remote actions 支持
4. 使用 CRDT (Yjs) 处理 Plan 编辑器的多人协作

### 5.2 Agent 执行时间轴（第 14-15 周）

受 **Codeon** 的 Agent Execution Timeline (AET) 启发：

```typescript
interface TimelineEvent {
  ts: number;
  agent: string;           // worker-1, cloner-2, etc.
  type: "tool-call" | "tool-result" | "thinking" | "message" | "error";
  tool?: string;           // read, write_file, bash, etc.
  file?: string;           // 操作的文件
  duration?: number;       // 工具调用耗时
  tokenCount?: number;     // token 消耗
  cost?: number;           // 成本（美元）
}
```

**可视化**：
- 水平甘特图式的时间轴
- 每个 Agent 一行
- 工具调用用色块表示（颜色按工具类型）
- 悬停显示详细信息（输入/输出/耗时/成本）
- 支持缩放和拖拽

### 5.3 DAG 任务依赖图（第 15 周）

利用后端已有的 `dag.ts` 模块：

```typescript
// 从 plan.md TodoItem[] 推导任务 DAG
// 可视化任务间的依赖关系
// 自动布局（Dagre）+ React Flow 渲染
```

### 5.4 性能优化（第 15-16 周）

| 优化项 | 技术方案 | 预期收益 |
|--------|---------|---------|
| 大消息列表虚拟滚动 | `@tanstack/react-virtual` | 1000+ 消息时滚动不掉帧 |
| Transcript 懒加载 | Intersection Observer + 分页 | 初始加载快 3x |
| 组件懒加载 | `React.lazy` + Suspense | 初始 bundle 减 40% |
| Markdown 渲染缓存 | `useMemo` + 内容哈希 | 重复渲染耗时减 80% |
| SSE 事件批量处理 | requestAnimationFrame 批量提交 | UI 线程阻塞减少 |
| Monaco Editor 按需加载 | 动态 import + Suspense | 首屏加载减 500KB |

### 5.5 可访问性（第 16 周）

**目标**：WCAG 2.1 AA 级别。

```typescript
// 使用 Radix UI 的 Accessibility 原语（shadcn/ui 已内建）
// - 焦点管理：Tab 键导航，焦点环可见
// - 屏幕阅读器：所有图标有 aria-label，状态变化有 aria-live 通知
// - 键盘操作：所有交互可用键盘完成
// - 色彩对比度：暗色主题下满足 4.5:1 最低对比度
// - 减少动画：prefers-reduced-motion 媒体查询
```

### 5.6 视觉回归测试（第 16 周）

```typescript
// 使用 Storybook + Chromatic 或 Percy
// 每个组件的主要状态都加入视觉测试
// PR 合并前自动对比截图差异
```

### 5.7 Plugin 系统（第 16 周+）

参考 omp 的 Extension 系统：

```typescript
// 前端插件接口
interface WebPlugin {
  id: string;
  name: string;
  // 注册自定义面板
  panels?: {
    id: string;
    title: string;
    component: React.ComponentType;
    position: "sidebar" | "main" | "context";
  }[];
  // 注册自定义工具渲染器
  toolRenderers?: Record<string, React.ComponentType<ToolRenderProps>>;
  // 注册自定义 Agent 节点样式
  agentNodeStyles?: Record<string, React.CSSProperties>;
  // 生命周期钩子
  onSwarmStateChange?: (state: SwarmState) => void;
  onActivityEvent?: (event: ActivityEntry) => void;
}
```

---

## 六、后端配套优化

### 6.1 API 增强

| 当前 | 目标 | 优先级 |
|------|------|--------|
| SSE 明文 JSON | WebSocket + 二进制协议 | 🟡 |
| 5s 轮询 state | 增量 state patch via SSE | 🟡 |
| 纯文件 state | SQLite state store (复用 bun:sqlite) | 🟢 |
| 模型列表硬编码 | 动态从 ModelRegistry 读取 | 🔴 |
| 无认证 | 可选的基础认证 / token 认证 | 🟡 |

### 6.2 测试扩展

```
packages/coding-agent/src/swarm/__tests__/
  新增:
  ├── before-loop-manager.test.ts
  ├── after-loop-pipeline.test.ts  
  ├── monitor-api-routes.test.ts
  ├── sse-event-serialization.test.ts
  ├── experience-store.test.ts
  └── todo-tracker.test.ts
```

---

## 七、可复用的开源项目集成计划

### 7.1 直接集成

| 开源项目 | 集成方式 | 阶段 | 价值 |
|---------|---------|------|------|
| **shadcn/ui** | 复制组件源码到项目 | Phase 1 | 组件一致性和可维护性 |
| **Monaco Editor** | npm 依赖 (`@monaco-editor/react`) | Phase 2 | 代码编辑和 Diff 查看 |
| **React Flow** | npm 依赖 (`@xyflow/react`) | Phase 2 | Agent 拓扑图可视化 |
| **xterm.js** | npm 依赖（omp 已有） | Phase 2 | 内嵌终端 |
| **i18next** | npm 依赖 | Phase 2 | 国际化 |
| **Yjs** | npm 依赖 | Phase 3 | 多人协作 CRDT |

### 7.2 参考设计

| 项目 | 借鉴内容 | 阶段 |
|------|---------|------|
| **Orca** (`Haroon966/Orca`) | 整体布局、终端面板、命令面板设计 | Phase 2 |
| **CopilotKit** | Chat UI 组件 API 设计 | Phase 1 |
| **Stratos** (`ContextSphere/stratos`) | 多 Agent 状态管理和 UI 分层 | Phase 2 |
| **ClawProwl** | Agent 可视化（3D/2D 概念参考） | Phase 3 |
| **RuFloUI** | Swarm 监控面板布局 | Phase 1 |
| **Codeon** | Agent 执行时间轴设计 | Phase 3 |
| **Juggler** | 会话树形导航概念 | Phase 3 |

### 7.3 不复用的理由

| 项目 | 不复用原因 |
|------|-----------|
| CopilotKit（完整集成） | 太重量级，与 omp 的轻量化哲学冲突 |
| StablyAI Orca | 桌面端 Electron，非 Web；且是独立产品非库 |
| PoolBot Office / ClawProwl 3D | 3D 办公室隐喻对开发者工具过于花哨，增加复杂度 |

---

## 八、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 上游 omp 大版本变更导致冲突 | 中 | 高 | 定期 rebase，保持与上游的差异最小化 |
| 合并 swarm-gui + collab-web 破坏现有功能 | 低 | 高 | 分步迁移，每步保持可工作状态 |
| shadcn/ui 升级 | 低 | 中 | 组件源码在项目中，可自行维护 |
| Monaco 体积过大 | 中 | 中 | 按需加载 + CDN + 可禁用的 feature flag |
| 多人协作安全 | 中 | 高 | 完全依赖 omp 的已验证加密协议 |
| 性能退化 | 低 | 中 | Bundle 分析 + Lighthouse CI 门禁 |

---

## 九、团队与投入估算

### 人员配置建议

| 角色 | 人数 | 投入阶段 |
|------|------|---------|
| 前端工程师（React/TypeScript） | 1-2 人 | 全程 |
| 全栈工程师（TypeScript/Bun） | 1 人 | Phase 2-3（API 增强） |
| UI/UX 设计师 | 0.5 人 | Phase 1-2 的组件设计指导 |
| QA/测试工程师 | 0.5 人 | Phase 2-3 |

### 总投入估算

| 阶段 | 人月 | 产出 |
|------|------|------|
| Phase 1 | 2-3 人月 | 现代化基础 + 测试体系 |
| Phase 2 | 4-5 人月 | 统一架构 + 核心功能 |
| Phase 3 | 5-6 人月 | 业界顶级体验 |
| **总计** | **11-14 人月** | |

---

## 十、成功指标

| KPI | 当前值 | Phase 1 目标 | Phase 2 目标 | Phase 3 目标 |
|-----|--------|-------------|-------------|-------------|
| 前端代码行数 | 1,300 | 5,000 | 12,000 | 20,000 |
| 测试覆盖率 | 0% | 40% | 70% | 85% |
| Lighthouse Performance | N/A | 90+ | 95+ | 98+ |
| Lighthouse Accessibility | N/A | 80+ | 90+ | 95+ (WCAG AA) |
| 首屏加载 (KB) | ~150KB | ~180KB | ~250KB (懒加载) | ~220KB |
| 支持语言数 | 1 (en) | 1 | 2 (en, zh) | 4+ |
| 端到端测试用例 | 0 | 5 | 15 | 30 |
| 社区贡献者 | 1 | 2-3 | 5+ | 10+ |
