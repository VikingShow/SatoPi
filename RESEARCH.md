# SSE Streaming Pipeline: TUI vs Web & assistant-ui Evaluation

## 1. TUI StreamingRevealController — 复用可行性

### TUI 实现分析

pi-tui 的 `StreamingRevealController`（`packages/coding-agent/src/modes/controllers/streaming-reveal.ts`）提供以下核心能力：

- **渐进揭晓**：grapheme-by-grapheme 以 ~30fps 逐步显示已到达的完整文本
- **追赶机制**：8 帧内赶上最新的 streamed delta
- **Thinking 块控制**：运行时动态显示/折叠 thinking 块
- **Tool call 边界**：检测到 tool_call 块时立即完整渲染

### 关键视角：TUI vs Web 架构的根本差异

| 维度 | TUI (pi-tui) | Web (swarm-gui) |
|------|-------------|-----------------|
| 渲染引擎 | 终端差分渲染 (DEC 转义序列) | React DOM reconciliation |
| 组件模型 | `Component` 接口 + `setInterval` 定时器驱动 | React 组件树 + hooks + 虚拟 DOM |
| 流式数据源 | 进程内 `AgentSession` 事件订阅 | HTTP SSE (`text/event-stream`) |
| 文本处理 | 原始文本 + ANSI 转义码 | Markdown → HTML 渲染 |
| 性能策略 | 行缓冲区 + 差分更新 | Zustand 不可变状态 + React.memo |
| 缓存机制 | `BlockUnitCounter` 缓存 grapheme 计数 | `useMemo` + `memo()` 缓存 |

### 结论：复用不可行

`StreamingRevealController` 深度耦合了 pi-tui 的终端渲染层（`Component` 接口、`setInterval` 驱动、行缓冲区差分更新），与 React DOM 有架构层面的根本差异。强行复用需要：
1. 在 React 中模拟 Terminal 的行缓冲区模型 → 引入不必要的复杂度
2. 用 `requestAnimationFrame` 替代 `setInterval` → 重写渲染循环
3. 将 ANSI 渲染逻辑映射为 React 组件 → 重复造轮子

**建议**：保持当前 SSE pipeline，在前端用 Zustand 不可变状态 + React.memo 实现高效的流式更新。当前已修复 stream_start → stream_delta → stream_end 的完整数据流。

---

## 2. assistant-ui 迁移评估

### 2.1 项目概览

- **仓库**：[assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) · ~5k stars
- **文档**：[assistant-ui.com](https://www.assistant-ui.com/)
- **依赖**：React 18/19、Tailwind CSS、可选 shadcn/ui

### 2.2 核心能力 vs SatoPi 现状

| 能力 | assistant-ui 提供 | SatoPi 现状 | 迁移收益 |
|------|-------------------|-------------|----------|
| 流式 Markdown | Streamdown 组件（增量渲染） | react-markdown 全量渲染 | 大幅提升 |
| 代码块 | 内置 Shiki 高亮 + Copy | 自研 ShikiCodeBlock | 降低维护 |
| 自动滚动 | 内置 auto-scroll | 自定义 scrollRef | 减少代码 |
| 重试/编辑 | 内置 message actions | 无 | 新功能 |
| 键盘快捷键 | 内置 | 无 | UX 提升 |
| 附件/文件上传 | 内置 FileAttachment | 无 | 新功能 |
| 多模型切换 | 内置 ModelSelector | 自研 | 降低维护 |
| 主题 | shadcn/ui 兼容 | Tailwind 自定义 | 保持一致 |
| 状态管理 | 内置 Thread 状态 | Zustand | 需要重新设计 |

### 2.3 集成复杂度

#### 技术栈兼容性
- React：完全兼容
- Vite：完全兼容
- Tailwind CSS：完全兼容
- Zustand：需将现有状态迁移到 assistant-ui 的 `useLocalRuntime` 或自定义 runtime

#### 工作量评估

| 阶段 | 工作内容 | 预估时间 |
|------|----------|----------|
| Phase 1 | 安装 + 基础 ChatView 替换 | 1 天 |
| Phase 2 | SSE runtime 适配（对接 SatoPi 后端） | 1-2 天 |
| Phase 3 | 状态管理迁移（Zustand → assistant-ui Thread） | 1-2 天 |
| Phase 4 | 自定义组件集成（PlanViewer、TodoPanel 等） | 2-3 天 |
| Phase 5 | 样式调整（SatoPi 暗色主题） | 1 天 |
| **总计** | | **6-10 天** |

#### 风险点
1. **Streamdown 依赖**：assistant-ui 的 Streamdown 组件依赖其内部 runtime 协议，与 SSE 的适配需要自定义 `ModelContextProvider`
2. **消息格式**：SatoPi 的 `ChatMessage` 结构（`channelId`、`thinking`、`from`）需要映射到 assistant-ui 的 `Message` 模型
3. **多 Session**：SatoPi 的多 session 架构需要映射到 assistant-ui 的 `Thread` 概念
4. **PlanViewer 等自定义面板**：这些是 SatoPi 独有的 UI，不在 assistant-ui 覆盖范围内

### 2.4 推荐方案：渐进式集成

```
Phase 1（当前迭代）: 修复 SSE 管道 + stream_start 支持 ← 已完成
Phase 2（下个迭代）: 仅引入 Streamdown 替换 react-markdown（低风险，高收益）
Phase 3（后续）: 逐步引入 Message 组件替换 MessageBubble
Phase 4（远期）: 评估完整迁移 assistant-ui runtime（成本/收益权衡）
```

---

## 3. 当前 SSE Pipeline 架构

```
Backend                                Frontend
───────                                ────────
runSubprocess(parent)
  ├─ onProgress(progress)
  │   └─ recentOutput (8行ring buffer, newest first)
  │       └─ before-loop-manager
  │           └─ reverse + join("\n") + diff
  │               └─ logStreamDelta(msgId, from, delta)
  │                   └─ ActivityLogger.log()
  │                       ├─ SwarmSessionManager.logActivity()
  │                       │   └─ session.jsonl (持久化)
  │                       └─ EventBus.broadcast(sessionName, entry)
  │                           └─ MonitorServer SSE
  │                               └─ text/event-stream
  │                                   └─ SseClient.on(entry)
  │                                       └─ addActivity(entry)
  │                                           ├─ stream_start → 创建空bubble
  │                                           ├─ stream_delta → 追加文本
  │                                           ├─ stream_end   → 完成 + thinking
  │                                           └─ broadcast    → 最终消息
  ├─ result.output + result.thinking
  │   └─ logStreamEnd(msgId, from, finalBody, thinking)
  └─ result.output
      └─ conversation.push + saveConversation
          └─ session.jsonl (持久化)
```
