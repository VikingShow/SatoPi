# SatoPi 战略路线图

> Satori: a Team of Pi — 自组织 Swarm 多智能体工程系统  
> 文档版本：v2.1 ｜ 日期：2026-07-21（基于代码审计更新）

> **v2.1 更新说明**：本次更新基于对 `packages/swarm-gui/src/` 全量代码的逐文件审计，修正了 v2.0 中因文档先于代码完成而导致的多处过时描述。关键修正：ChatView 已使用 ReactMarkdown+remarkGfm+Shiki（非纯文本）；shadcn/ui 9 组件已实现但未接入业务代码；i18n/theme/Monaco/ReactFlow/sonner 依赖已安装但接入率低；前端测试 7 文件而非 2 文件。

---

## 一、当前状态总览

### 1.1 已完成的业界顶级能力

| 能力 | 对标 | 状态 |
|------|------|------|
| Cloner Roundtable 多轮计划辩论 | 业界唯一 | ✅ 已实现 |
| 自组织 Worker 群体（IRC 协商 + 选举） | Devin（单 Agent） | ✅ 已实现 |
| 经验增强规划（ExperienceStore） | Claude Code CLAUDE.md | ✅ 已实现 |
| After-loop 深度反思 | 无对标 | ✅ 已实现 |
| 任务复杂度分析（auto-sizing） | 无对标 | ✅ 已实现 |
| 文件区域锁（RegionLockManager） | 无对标 | ✅ 已实现 |

### 1.2 近期修复（v2.0）

| 修复项 | 问题 | 方案 |
|--------|------|------|
| 对话功能堵塞 | loop.yaml 缺少 `swarm:` 包装，parseSwarmYaml 抛错 | 重写 YAML + 延迟 phase 设置 |
| 模型下拉框 | `/api/models` 硬编码不可用模型 | 接入 ModelRegistry.getAvailable() |
| ConfigPage 表单 | loadConfig 不解析 YAML 回填 | 双向 YAML↔form 序列化 |
| React DOM 嵌套 | button 内嵌套 button | 改为 div+role=button |
| React key 重复 | 同一毫秒多条消息冲突 | 计数器+随机后缀 |
| 前端品牌名 | 显示 "demo-swarm" | 动态读取 YAML → "SatoPi" |
| Session 切换 | 无历史会话查看 | SessionSwitcher + 富元数据 API |
| 取消按钮位置 | 右上角 Send/Stop 分离 | 并入输入栏，按 phase 状态变化 |

### 1.3 当前待解决的基础问题

> **v2.1 更新**：以下问题状态基于 2026-07-21 代码审计。v2.0 标记的 4 个 P0/P1 中，2 个已修复、1 个部分修复、1 个仍待解决。

| 优先级 | 问题 | 影响 | 状态（v2.1） |
|--------|------|------|-------------|
| 🔴 P0 | plan.md 显示 404（页面无法展示计划） | 用户看不到生成的计划 | ⚠️ 部分修复：PlanViewer 有 404 错误态 + retry，但 Socrates 写入磁盘仍不稳定 |
| 🔴 P0 | Socrates 输出 JSON 而非调用 write_file | plan.md 从未真正写入磁盘 | ⚠️ 规划中：system prompt 调整方案已出，待实施 |
| 🟡 P1 | steering 输入在 running 阶段被禁用 | 用户无法在运行中干预 | ⚠️ 规划中：后端 API 已支持，前端 UI 待开放 |
| 🟡 P1 | ~~对话消息无格式处理（纯文本）~~ | ~~可读性差~~ | ✅ 已修复：ChatView 使用 ReactMarkdown + remarkGfm + Shiki 8 语言高亮 |
| 🟢 P2 | shadcn/ui 组件未接入业务代码 | 交互一致性差 | 🔲 已安装 9 组件，接入率 0%（v2.1 新发现） |
| 🟢 P2 | 主题 CSS 变量未接入业务组件 | light 模式不可用 | 🔲 theme-store + globals.css 已就位，组件用硬编码颜色（v2.1 新发现） |
| 🟢 P2 | i18n 未接入业务组件 | 无中文支持 | 🔲 i18next 已安装+初始化，useTranslation 调用 0 处（v2.1 新发现） |
| 🟢 P2 | 键盘快捷键未挂载 | 无 ctrl+enter/escape 等快捷键 | 🔲 use-keybindings.ts hook 已写，未 import（v2.1 新发现） |

### 1.4 当前测试覆盖

> **v2.1 更新**：基于实际测试文件统计。

| 层 | 框架 | 测试文件数 | 通过率 | 备注 |
|-----|------|-----------|--------|------|
| Backend (swarm) | Bun Test | ~1,090 文件 | ✅ 100% | 含 pi-coding-agent 500 + pi-ai 283 + pi-tui 81 等 |
| Backend (Rust) | cargo-nextest | 164+ | ✅ 100% | CI 未接入 |
| Frontend (stores/lib) | Vitest | 5 文件 | ✅ 100% | swarm-store(25) + session-store + config-store + api-client + sse-client |
| Frontend (components) | Vitest+RTL | 0 文件 | N/A | @testing-library/react 已安装但未使用 |
| E2E (browser) | Playwright | 2 specs | ⚠️ 环境问题 | monitor.spec + before-loop.spec |
| Python | pytest | 26 文件 | ✅ | mnemopi 模型测试 |

---

## 二、端到端测试体系

### 2.1 目标：每个端点 / 每个功能都有真实测试

当前 75 个 API 端点中只有 monitor-server 有后端测试。需要一个**分层测试套件**：

```
tests/
├── api/                    # REST API 契约测试（curl/bun）
│   ├── 01-state.test.ts    # GET /api/state, GET /api/run/status
│   ├── 02-config.test.ts   # GET|PUT /api/config
│   ├── 03-before-loop.test.ts  # POST start/message/debate/confirm/cancel
│   ├── 04-history.test.ts  # GET /api/history, /api/before-loop/history
│   ├── 05-runs.test.ts     # GET /api/runs, /api/runs/:name/activity
│   ├── 06-plan.test.ts     # GET|PUT /api/plan, GET /api/plan/todos
│   ├── 07-run-control.test.ts  # POST start/stop/pause/resume
│   ├── 08-steering.test.ts     # POST /api/run/steer
│   ├── 09-models.test.ts   # GET /api/models
│   ├── 10-experience.test.ts   # GET /api/experience/*
│   ├── 11-after-loop.test.ts   # GET /api/after-loop/summary
│   ├── 12-blocker.test.ts  # POST /api/run/resolve-blocker
│   └── 13-terminal.test.ts # GET /api/terminal/connect, POST /api/terminal/input
├── sse/                    # SSE 事件流测试
│   └── sse.test.ts         # 连接 → 发送消息 → 验证事件流
├── integration/            # 端到端工作流测试
│   ├── full-before-loop.test.ts   # idle → start → dialog → plan.md 写入
│   ├── full-debate-flow.test.ts   # dialog → debate → confirm
│   └── full-loop-flow.test.ts     # confirm → run → after-loop result
└── e2e/                    # 浏览器功能测试（Playwright）
    ├── monitor.spec.ts     # ✅ 已有
    ├── before-loop.spec.ts # ✅ 已有
    ├── chat-flow.spec.ts   # 🔲 新建：发送消息 → 看到回复
    ├── config-page.spec.ts # 🔲 新建：模型下拉框 → 保存 → YAML 预览更新
    └── session-switch.spec.ts  # 🔲 新建：切换会话 → 加载历史
```

### 2.2 测试沉淀机制

**方案：Bun Test 脚本 + package.json scripts**

```json
{
  "scripts": {
    "test": "bun test",
    "test:api": "bun test tests/api/",
    "test:api:01": "bun test tests/api/01-state.test.ts",
    "test:sse": "bun test tests/sse/",
    "test:integration": "bun test tests/integration/",
    "test:e2e": "playwright test",
    "test:all": "bun test && bun test tests/api/ && bun test tests/integration/ && playwright test",
    "test:ci": "bun test --coverage && playwright test"
  }
}
```

**核心原则**：
- 每个测试脚本独立可运行（不依赖启动顺序）
- API 测试直接请求 `http://localhost:7878`（不需要前端）
- 集成测试按工作流顺序编排，能验证完整业务链路
- CI 中自动运行 `test:ci`

### 2.3 实施步骤

| 步骤 | 内容 | 预计时间 |
|------|------|---------|
| Phase 1 | 编写 api/01-06 核心端点测试 | 1d |
| Phase 2 | 编写 sse + integration 工作流测试 | 1d |
| Phase 3 | 编写 e2e 浏览器测试（chat-flow, config-page） | 0.5d |
| Phase 4 | 配置 CI + coverage 门槛 | 0.5d |

---

## 三、消息格式处理管线审计

> **v2.1 更新**：v2.0 声称 ChatView 使用"纯文本 + 简单正则 parseCodeBlocks()"，实际代码审计发现 ChatView 的 MessageBody 组件已完整使用 ReactMarkdown + remarkGfm + Shiki。

### 3.1 当前状态（v2.1 代码实况）

| 组件 | 库 | 处理内容 | 状态 |
|------|-----|---------|------|
| PlanViewer | react-markdown + remark-gfm | plan.md 渲染（标题、列表、代码块、表格、checkbox） | ✅ 完整 |
| AfterLoopPanel | react-markdown + remark-gfm | After-loop 总结渲染 | ✅ 完整 |
| ChatView | react-markdown + remark-gfm + Shiki | **完整 Markdown 渲染** + 代码块语法高亮（8 语言） | ✅ 完整 |
| ChatView streaming | stream_start → stream_delta → stream_end | rAF 批处理 + auto-scroll 粘底 + 三点脉冲动画 | ✅ 完整 |
| ChatView 代码块 | ShikiCodeBlock 组件 | Copy 按钮 + 语言标签 + 8 语言语法高亮 | ✅ 完整 |
| ChatView 内联代码 | `<code className="bg-[#0d0d0d]">` | 内联代码样式 | ✅ 完整 |

### 3.2 缺失项

| 功能 | 状态 | 建议 |
|------|------|------|
| ~~Markdown 渲染（粗体/斜体/链接）~~ | ✅ 已实现（remarkGfm） | — |
| ~~内联代码~~ | ✅ 已实现 | — |
| ~~表格渲染~~ | ✅ 已实现（remarkGfm tables） | — |
| ~~列表渲染~~ | ✅ 已实现（remarkGfm lists） | — |
| ~~流式输出~~ | ✅ 已实现（rAF 批处理） | — |
| ~~图片渲染~~ | ✅ 已实现（`<a target="_blank">`） | — |
| KaTeX 数学公式 | ❌ 缺失 | `bun add remark-math rehype-katex katex` |
| Mermaid 流程图 | ❌ 缺失 | `bun add remark-mermaidjs` |
| 消息空态引导 | ❌ 缺失 | 无消息时显示"输入任务开始对话" |

### 3.3 改进方案

```tsx
// ChatView.tsx — MessageBody 改为
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function MessageBody({ body }: { body: string }) {
  // 纯文本消息保留原样，含代码块的启用 markdown 解析
  const hasCodeBlock = /```/.test(body);
  if (!hasCodeBlock) {
    return <span className="whitespace-pre-wrap">{body}</span>;
  }
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ inline, className, children, ...props }) {
            if (inline) return <code {...props}>{children}</code>;
            // 代码块复用现有 ShikiCodeBlock
            return <ShikiCodeBlock code={String(children)} lang={className?.replace("language-", "") ?? ""} />;
          }
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
```

**复用关系**：ChatView 复用 `react-markdown` + `remark-gfm`（PlanViewer 已安装），代码块委托给 `ShikiCodeBlock`（已有组件）。

---

## 四、plan.md 显示修复

### 4.1 问题分析

**症状**：页面显示 `Error: API error: 404 Not Found. Place plan.md in .omp/ directory.`

**根因链**：
1. `/api/plan` 检查三个候选路径（`api-routes.ts:238-253`）
2. 所有路径都不存在 → 因为 Socrates 未调用 `write_file` 工具
3. Socrates 输出了 JSON 格式的 plan，但包含在对话消息中，未写入磁盘

**修复**（两个层面）：

| 层 | 方案 |
|----|------|
| 治标 | 当 API 返回 404 时，PlanViewer 尝试从 conversation history 中提取 plan 内容 |
| 治本 | 修改 Socrates system prompt，要求必须调用 write_file 写入 .omp/plan.md |
| 兜底 | /api/plan 增加候选路径：`.swarm-workspace/.omp/plan.md`（workspaceDir 下） |

### 4.2 立即实施

```typescript
// api-routes.ts — 修复 plan 候选路径
"GET /api/plan": async (_req, ctx) => {
    // 先查 stateTracker 下的 swarmDir，再查 workspaceDir
    const candidates = [
        path.join(ctx.swarmDir, ".omp", "plan.md"),      // NEW: swarm 目录下
        path.join(ctx.workspaceDir, ".omp", "plan.md"),    // workspace 全局
        path.join(ctx.workspaceDir, "plan.md"),            // workspace 根
        path.join(ctx.swarmDir, "plan.md"),                // NEW: swarm 根
    ];
    for (const p of candidates) {
        try {
            const content = await Bun.file(p).text();
            return json({ content, path: p });
        } catch { /* try next */ }
    }
    return json({ content: "", error: "plan.md not found" }, 404);
}
```

同时更新 PlanViewer 前端：当 404 时展示"等待 Socrates 生成计划"的提示，而非错误。

---

## 五、角色资产库系统（Role Asset Library）

### 5.1 设计理念

**核心理念**：角色不是硬编码的，而是**可归档、可检索、可进化的资产**。

当前问题：workers 和 cloners 初始化时没有角色，每次 spawn 使用固定 system prompt。
目标：将每个角色定义为一个独立的资产文件，workers 在圆桌讨论中自主选择合适的角色。

### 5.2 资产文件结构

```
.omp/roles/                    # 角色资产库
├── index.yaml                  # 索引：所有角色的元数据
├── frontend-dev.yaml           # 前端开发角色
├── backend-dev.yaml            # 后端开发角色
├── code-reviewer.yaml          # 代码审查角色
├── test-engineer.yaml          # 测试工程师角色
├── architect.yaml              # 架构师角色
├── security-auditor.yaml       # 安全审计角色
├── performance-optimizer.yaml  # 性能优化角色
└── docs-writer.yaml            # 文档编写角色
```

### 5.3 角色文件格式

```yaml
# .omp/roles/frontend-dev.yaml
id: frontend-dev
name: "Frontend Developer"
version: 1
description: "React/TypeScript 前端开发专家，擅长组件设计、状态管理、UI/UX"
category: development
tags: [react, typescript, tailwind, vitest, storybook]

system_prompt: |
  You are a senior frontend developer specializing in React and TypeScript.
  
  Your responsibilities:
  1. Create reusable UI components with proper typing
  2. Implement responsive layouts using Tailwind CSS
  3. Write unit tests with Vitest
  4. Follow accessibility best practices (WCAG 2.1 AA)
  
  Guidelines:
  - Prefer functional components with hooks
  - Use React.memo for performance-critical components
  - Follow the project's existing patterns and conventions
  - Document any API surface or complex logic

tools:
  allowed: [read, write_file, bash, grep, find, glob]
  blocked: [edit]  # prefer write_file for full rewrites

dependencies: []

experience:
  total_rounds: 0
  success_rate: 0
  last_updated: null
  
approval_required: false  # 经验积累是否需要审核
```

### 5.4 Worker 角色选择流程

```
每轮 Workers 圆桌讨论开始前：

1. LoopController 从 .omp/roles/index.yaml 加载可用角色列表
2. 每个 Worker 收到角色列表 + 当前任务上下文
3. Worker 选择一个角色（输出 ### Role Selection: frontend-dev）
4. Loader 加载角色文件 .omp/roles/frontend-dev.yaml
5. 注入角色 system_prompt + tools 限制到 Worker spawn 参数
6. Worker 以选择的角色身份执行任务
```

### 5.5 经验积累与审核机制

**经验的来源**：
- After-loop pipeline 提取的 lessons（已有）
- Worker 每轮完成后的 self-reflection
- Cloner 审查中的 findings

**审核流程**：

```
Worker 完成一轮任务
    ↓
产出 experience_delta.yaml（本轮新增/修改的建议）
    ↓
提交到 .omp/roles/review-queue/{role_id}-{timestamp}.yaml
    ↓
下一轮 Cloner Council 审核（或人工审核）
    ↓                      ↓
Approved                  Rejected
    ↓                      ↓
合并到角色文件             存档到 .omp/roles/rejected/
+ version bump             + 拒绝原因
```

**审核规则**：
- Cloner 审核时自动对比新旧 system_prompt 的质量
- 工具权限变更必须经过人工审批
- 经验文件变更使用 diff 格式，可追溯

### 5.6 实现架构

```
packages/coding-agent/src/swarm/
├── role-asset/
│   ├── role-loader.ts         # RoleLoader: loadRole(id) → RoleAsset
│   ├── role-index.ts          # RoleIndex: 扫描 .omp/roles/ 构建索引
│   ├── role-selector.ts       # RoleSelector: Worker 匹配角色算法
│   ├── role-experience.ts     # RoleExperience: 经验积累与审核
│   └── role-schema.ts         # RoleAsset 类型定义与验证

packages/swarm-gui/src/
├── components/roles/
│   ├── RoleBrowser.tsx        # 角色浏览器：查看/搜索/过滤角色
│   ├── RoleEditor.tsx         # 角色编辑器：修改 system_prompt/tools
│   ├── RoleExperience.tsx     # 经验面板：查看角色的经验积累
│   └── RoleReviewQueue.tsx    # 审核队列：审批待合并的经验变更
```

### 5.7 与现有系统的集成

| 现有系统 | 集成方式 |
|---------|---------|
| LoopController | spawn worker 前调用 RoleLoader.loadRole(selectedRole) |
| BeforeLoopManager | Socrates 可推荐角色组合给用户 |
| ExperienceStore | 作为审核通过后的持久化后端 |
| ActivityLogger | 记录角色选择/切换事件 → SSE 推送前端 |
| VerificationHook | 角色经验变更前运行测试验证 |

---

## 六、实施优先级与排期

### Phase 1：基础修复（P0，1-2 天）

> **v2.1 更新**：任务 3 已完成，任务 1-2 部分完成，任务 4 待实施。

| # | 任务 | 预期产出 | 状态 |
|---|------|---------|------|
| 1 | 修复 plan.md 显示 404 | PlanViewer 正常显示 / API 路径修复 | ⚠️ 部分修复（PlanViewer 有 404 态，API 路径待扩展） |
| 2 | Socrates prompt 修复 | plan.md 写入磁盘 | ⚠️ 规划中 |
| 3 | ~~消息格式处理~~ | ~~ChatView 复用 react-markdown~~ | ✅ 已完成（ReactMarkdown + remarkGfm + Shiki） |
| 4 | steering 输入 enabled | 运行中可发送 steering 消息 | ⚠️ 规划中 |

### Phase 2：测试体系（P0，2-3 天）

> **v2.1 更新**：后端测试覆盖已远超目标。前端组件测试缺失（0 个）。

| # | 任务 | 预期产出 | 状态 |
|---|------|---------|------|
| 5 | API 契约测试（13 个端点） | tests/api/*.test.ts | ⚠️ 后端有 ~1,090 测试，前端 api-client 有 mock 测试 |
| 6 | SSE 事件流测试 | tests/sse/sse.test.ts | ✅ sse-client.test.ts 已有（含重连回归） |
| 7 | 集成工作流测试（3 条完整链路） | tests/integration/*.test.ts | 🔲 缺失 |
| 8 | E2E 浏览器测试补充 | tests/e2e/chat-flow.spec.ts 等 | ⚠️ 2 个 spec 已有，需扩展到 5+ |
| 9 | CI 配置 + coverage 门槛 | GitHub Actions / .github/workflows/* | ✅ 已有 ci.yml |
| 9a | **前端组件渲染测试**（v2.1 新增） | @testing-library/react 组件测试 | 🔲 0 个组件测试（@testing-library/react 已安装） |

### Phase 3：角色资产库（P1，5-7 天）

| # | 任务 | 预期产出 |
|---|------|---------|
| 10 | 角色资产 schema + 文件格式定义 | role-schema.ts |
| 11 | RoleLoader + RoleIndex | 加载/索引角色 |
| 12 | Worker 角色选择机制 | role-selector.ts |
| 13 | RoleExperience 经验积累 | 增量经验写入 |
| 14 | 审核流程（Cloner/人工） | RoleReviewQueue + API |
| 15 | 前端角色浏览器 + 编辑器 | RoleBrowser/RoleEditor/RoleExperience |
| 16 | 与 LoopController 集成 | worker spawn 前选角色 |

### Phase 4：战略优化（P1，3-5 天）

| # | 任务（来自已有计划） | 预期产出 |
|---|------|---------|
| 17 | 动态计划更新（Pause/Resume/Replan） | 已有 TODO |
| 18 | 验证钩子系统 | 已有 TODO |
| 19 | 细粒度 To-Do 追踪 | 已有 TODO |
| 20 | 对话历史持久化 | 已完成 ✅ |
| 21 | 配置即约束 | 已有 TODO |
| 22 | 阻塞处理机制 | 已有 TODO |

---

## 七、风险与依赖

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Model 行为不稳定（不调用工具） | plan.md 不生成 | system prompt 强化 + retry 机制 |
| 角色选择质量差 | 任务效率低 | 角色匹配算法 + 人工干预通道 |
| 经验积累质量不可控 | 角色资产退化 | 审核机制 + version history + rollback |
| E2E 测试环境不稳定 | CI 假阳性高 | 增加 retry + 语义化断言 |

---

## 附录 A：当前 API 端点清单（75 个）

| 方法 | 路径 | 类别 |
|------|------|------|
| GET | /api/state | State |
| GET,PUT | /api/config | Config |
| GET | /api/history | History |
| GET | /api/runs | Runs |
| GET | /api/runs/:name | Runs |
| GET | /api/runs/:name/activity | Runs |
| GET | /api/models | Models |
| GET,PUT | /api/plan | Plan |
| GET | /api/plan/todos | Plan |
| POST | /api/run/start | Run Control |
| POST | /api/run/stop | Run Control |
| POST | /api/run/pause | Run Control |
| POST | /api/run/resume | Run Control |
| GET | /api/run/status | Run Control |
| POST | /api/run/steer | Steering |
| POST | /api/run/resolve-blocker | Blocker |
| GET | /api/after-loop/summary | After Loop |
| GET | /api/experience* | Experience (3) |
| POST | /api/before-loop/start | Before Loop |
| POST | /api/before-loop/message | Before Loop |
| GET | /api/before-loop/state | Before Loop |
| GET | /api/before-loop/history | Before Loop |
| POST | /api/before-loop/debate | Before Loop |
| POST | /api/before-loop/confirm | Before Loop |
| POST | /api/before-loop/cancel | Before Loop |
| GET | /api/terminal/connect | Terminal |
| POST | /api/terminal/input | Terminal |
| GET | /events | SSE |

## 附录 B：当前组件清单（v2.1 更新 — 22 个）

| 组件 | 路径 | 说明 | 三态覆盖 | shadcn |
|------|------|------|---------|--------|
| ChatView | components/monitor/ChatView.tsx | 聊天界面（含虚拟滚动 + ReactMarkdown） | 🟡 缺空态 | ❌ |
| MonitorPage | components/monitor/MonitorPage.tsx | 主监控页 | 🟡 | ❌ |
| PlanViewer | components/monitor/PlanViewer.tsx | plan.md 查看/编辑（Monaco） | ✅ 完整 | ❌ |
| PhasePipeline | components/monitor/PhasePipeline.tsx | 流程阶段可视化 | 🟡 | ❌ |
| ChannelList | components/monitor/ChannelList.tsx | 频道列表 | 🟡 | ❌ |
| TodoList | components/monitor/TodoList.tsx | To-Do 追踪面板 | 🟡 | ❌ |
| BlockerDialog | components/monitor/BlockerDialog.tsx | 阻塞处理对话框 | 🟡 缺 ErrorBoundary | ❌ |
| AfterLoopPanel | components/monitor/AfterLoopPanel.tsx | After-loop 结果展示 | 🟡 缺加载态 | ❌ |
| SessionSwitcher | components/monitor/SessionSwitcher.tsx | 会话切换 | 🟡 | ❌ |
| ContextPanel | components/monitor/ContextPanel.tsx | 上下文面板 | 🟡 | ❌ |
| CodeEditor | components/monitor/CodeEditor.tsx | Monaco 编辑器 | 🟡 | ❌ |
| **AgentTopology** | components/monitor/AgentTopology.tsx | Agent 拓扑图（ReactFlow） | ✅ 完整 | ❌ |
| **AgentTimeline** | components/monitor/AgentTimeline.tsx | Agent 时间轴 | ✅ 完整 | ❌ |
| **FileChangesPanel** | components/monitor/FileChangesPanel.tsx | 文件变更面板 | 🟡 | ❌ |
| **RoleBrowser** | components/monitor/RoleBrowser.tsx | 角色浏览器 | 🟡 | ❌ |
| ConfigPage | components/config/ConfigPage.tsx | 配置编辑器 | 🟡 | ❌ |
| **HistoryPage** | components/history/HistoryPage.tsx | 历史会话页 | 🟡 | ❌ |
| Logo | components/common/Logo.tsx | 品牌 Logo | N/A | N/A |
| **EmptyState** | components/shared/EmptyState.tsx | 空态占位组件 | N/A | ❌ |
| **ErrorBoundary** | components/shared/ErrorBoundary.tsx | 共享错误边界 | N/A | ❌ |
| **Toaster** | (sonner) | Toast 通知（已挂载 App.tsx） | N/A | ✅ |
| **9 个 UI 组件** | components/ui/*.tsx | shadcn/ui 组件库 | N/A | ✅ 已实现 |

> **关键发现**：22 个组件中，仅 3 个（PlanViewer/AgentTopology/AgentTimeline）达到完整三态覆盖。0 个业务组件使用 shadcn/ui。
