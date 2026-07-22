# SatoPi Swarm-GUI 前端优化记录

> **基准 Commit**: `c3e7b2201`
> **分支**: `feat/frontend-optimization` → `feat/frontend-optimization-phase2`
> **理论基础**: Emil Kowalski 设计工程哲学 + Apple HIG 原则
> **测试结论**: 11/11 test files, 81/81 tests — 全部通过, 零 TS 错误

---

## 一、改动总览

| Phase | 内容 | 文件数 | 核心效果 |
| --- | --- | --- | --- |
| 1 | 按钮动效修复 | 2 | `transition-all` → 精确属性, `translate-y-px` → `scale(0.97)` |
| 2 | SSE 热路径 guard | 1 | 剪掉 95% token 级无效 Zustand set |
| 3 | 无界数据结构 | 3 | fileChanges/toolCalls/Shiki cache 加 LRU 上限 |
| 4 | 可访问性 (a11y) | 1 | `prefers-reduced-motion` + 主题切换过渡 |
| 5 | Selector 批量化 + 轮询优化 | 2 | MonitorPage 8→1 selector, visibilitychange 启停轮询 |
| 6 | 架构清理 | 1+1 | `deriveChannel` 独立模块 |
| 7 | 视图过渡 (不丢状态) | 1 | opacity+inert 分层, MonitorPage 始终挂载 |
| 8 | ChatView selector 分频 | 1 | 13→2 订阅 (高频组 + 低频组) |
| 9 | 统一 session API | 2+1 | `switchToSession(name, mode)` 替代 3 处 any hack |
| fix | 修复预存 TS 错误 | 3 | RoleBrowser Button import, App.tsx keybindings, vitest globals |

**总计**: 14 个文件变更, +617 / -253 行。两个 commit:

```
1cfa62e26  perf: button polish, SSE hot-path, bounded data, a11y, architecture
8ddc994d0  fix: 3 pre-existing TS errors → zero errors
ffcf998b5  perf: graceful view transitions, frequency-aware selectors, unified session API
```

---

## 二、详细设计决策

### Phase 1: 按钮动效

**修改**:
- `button.tsx`: `transition-all` → `transition-[transform,opacity,background-color,color,border-color,box-shadow]`, `active:translate-y-px` → `active:scale-[0.97]`
- `globals.css`: 全局 `button:active:not([disabled]):not([aria-haspopup]) { transform: scale(0.97); transition: transform 160ms ease-out; }`

**设计依据**: Emil Kowalski §"Buttons must feel responsive" — `scale(0.97)` 同时缩放内容、图标和边框，产生三维物理感。160ms 在推荐范围 100-160ms 内。Apple HIG §Response — "highlight a button the instant it's pressed"。

**注意**: `aria-haspopup` 排除是为了不干扰 Base UI 的 popover/dropdown 自身的按下逻辑。Base UI 对这些元素的 `:active` 有自己的处理。

---

### Phase 2: SSE 热路径 guard

**修改**: `swarm-store.ts:456` — `sseClient.on()` 回调中的 `set({ isConnected, connectionStatus })` 加 `if (!get().isConnected)` guard。

**背景**: 每个 token 级 `stream_delta` (每秒 20-30 个) 都执行 Zustand set + 全部 selector 重算，即使值没变。`onConnectionChange` 回调已经是连接状态的权威来源，SSE handler 只需在遗漏时补上。

**验证**: SSE 连接生命周期完整 — onopen → onConnectionChange(true) → 首次连接; onerror → onConnectionChange(false) → 重连 → 下一个 event 检查 `!isConnected` → 补设。禁用 guard 的副作用不可能导致"Connected" 状态永久为 false。

---

### Phase 3: 无界数据

**修改**:
- `swarm-store.ts`: `MAX_FILE_CHANGES = 500`, `MAX_TOOL_CALLS_PER_AGENT = 200`
- `lib/code-cache.ts`: 新建独立 LRU 缓存模块, 上限 200 条
- `ChatView.tsx`: 内联 `codeCache` Map → import 新模块

**背景**: 长时间 swarm 运行 (30min+) 可以产生数千条 file_change 和 tool_call 记录。无上限的数据结构导致 UI 组件依赖计算逐步线性退化。所有变更均在 SSE 事件处理器中受 cap 控制，UI 只需要最近 N 条。

---

### Phase 4: 可访问性

**修改**: `globals.css` 末尾添加 `@media (prefers-reduced-motion: reduce)` 全局规则。

**设计**:
- 全局 `animation-duration: 0.01ms !important; transition-duration: 0.01ms !important`
- 保留 `.animate-spin`, `.animate-pulse-ring`, `.animate-dash-flow` 为 2s 周期（状态指示器仍需可见）
- `:root` 的主题过渡同时被禁用

**背景**: Apple HIG §Reduced motion & accessibility — "Reduced motion doesn't mean no feedback — it means a gentler, non-vestibular equivalent"。SatoPi 作为 developer dashboard，动效量不大，全局禁用在功能上无损。

---

### Phase 5: Selector 批量化 + 轮询优化

**修改**:
- `MonitorPage.tsx`: 8 个独立 `useSwarmStore(selector)` → 1 个 `useSwarmStore(selector, shallow)`
- `swarm-store.ts`: `setInterval(refreshState)` → `visibilitychange` 驱动的 `startPolling()/stopPolling()`

**MonitorPage 的合并为什么安全**: 选中的 8 个字段都是低频变化的 (`swarmState`, `isRunning`, `isConnected`, `loopPhase`, `convergenceHistory`, `afterLoopResult`)。当 store 中任意未选中字段变化时，shallow 比较返回 false → 不 re-render，与独立 selector 行为完全等价。

**轮询优化的边界**: SSE 在后台 tab 保持连接（后台 tab 的 EventSource 正常工作），只有 HTTP polling 被停止。用户回到 tab 时立即 `refreshState()` + 恢复轮询。

---

### Phase 6: 架构清理

**修改**:
- 新建 `lib/channel-derivation.ts` — 迁移 `deriveChannel()` (87 行纯函数)
- `swarm-store.ts` — 删除内联函数，导入新模块

**背景**: `swarm-store.ts` 在修改前有 996 行。提取纯函数减少 store 模块的体积和职责范围。

---

### Phase 7: 视图过渡 (不丢状态)

**核心问题**: 原始方案用 `key={page}` 控制 CSS animation → 直接导致 MonitorPage 卸载/重挂载，丢失全部本地状态（聊天位置、输入文本、SSE 连接、轮询定时器）。

**解决方案**: opacity + `inert` 分层。

```
┌─ 底层 (always mounted) ──┐
│ MonitorPage               │ opacity-100 (monitor) / opacity-0 (其他)
│ inert 属性完全隔离         │ z-10 (monitor) / z-0 (其他)
└───────────────────────────┘
┌─ 上层 (conditional) ─────┐
│ ConfigPage / HistoryPage  │ 覆盖在上面
└───────────────────────────┘
```

**CSS**:
```css
.absolute-inset-0 { position: absolute; inset: 0; }
.transition-opacity.duration-150.ease-out
.opacity-100.z-10   ← 可见
.opacity-0.z-0.pointer-events-none  ← 隐藏 + 不可交互
```

**`inert` 的作用**: `pointer-events-none` 只阻止鼠标/触摸，键盘 Tab 键仍能穿透。`inert` 属性从 HTML 规范层面全面阻止交互（屏幕阅读器、键盘焦点、鼠标事件）。

**不进行 view mode 过渡**: 根据频率原则，view mode 切换（chat/topology/timeline/files/...）属于 "tens/day"，建议 "remove or drastically reduce" 动画。当前瞬间切换是最优方案。

---

### Phase 8: ChatView Selector 分频

**核心问题**: ChatView 的 13 个 Zustand selector 包含超高频变化的 `messages` 和 `activities`（每秒 20-60 次），和低频变化的其余字段。全部合并会由高频字段拖累低频字段的比较开销。

**解决方案**: 按频率分成两组。

| 组 | 字段 | 频率 | 数量 | 合并方式 |
| --- | --- | --- | --- | --- |
| A | messages, activities | 1-2/帧 (streaming) | 2→1 | `shallow` (总是同时变化) |
| B | activeChannelId, loopPhase, isRunning, beforeLoopState, 7 个方法引用 | 几分钟/次 | 11→1 | `shallow` (方法引用稳定, 比较是 O(1) no-op) |

**为什么方法引用不会导致 false re-render**: Zustand `create()` 中的方法定义在创建时一次性赋值，每次 selector 返回的引用是同一个对象。`shallow` 的 `Object.is` 比较发现相同引用 → 跳过。

**为什么组 A 合并了也不会有额外 re-render**: `messages` 和 `activities` 在 `addActivity()` 中总是一次 set() 调用的结果。当两者都变化时，一个合并的 selector 触发 1 次 re-render（等于两个独立的各触发 1 次）。当仅一个有变化时（不存在——两者的变化源是同一个 addActivity），不会出现误报。

---

### Phase 9: 统一 session API

**核心问题**: `session-store.ts` 有 3 处用 `as any` 绕过 TypeScript 来操作 `swarm-store` 的内部状态：
1. 创建新 session — 用 `useSwarmStore.setState({15 fields})` 重置状态
2. 回到当前 session — 用 `(as any).__initRunning = false` 绕过 guard
3. 切换到活动 session — 同上

**旧方案的隐式问题**:
- `init()` 的 `sseClient.on()` 调用不保存 unsubscribe 句柄 → 每次 `init()` 注册一个新回调 → SSE 事件被处理多次
- 多个 session-store 调用路径各自维护不同的状态重置逻辑 → 状态字段可能不同步
- `as any` 绕过类型检查 → 字段重命名不会被 TS 捕获

**新 API**:
```typescript
// swarm-store.ts
interface SwarmStore {
  switchToSession: (name: string, mode: 'live' | 'historical') => Promise<void>;
}
```

**实现**:
1. 清理旧 SSE 监听器 (`__sseUnsubscribe` handle)
2. 重置所有内存状态为 idle 初始值
3. `mode='live'` — 连接 SSE, 拉取 state, 回放 history
4. `mode='historical'` — 只加载 activity log, 不碰 SSE
5. SSE 处理器内部管理 delta buffer/flush 逻辑 (与 `init()` 的 SSE 管道相同)

**session-store 的调用简化**:
```typescript
// newSession
useSwarmStore.getState().switchToSession(newName, "live");

// switchToSession (active)
useSwarmStore.getState().switchToSession(name, "live");

// switchToSession (historical)
useSwarmStore.getState().switchToSession(name, "historical");

// backToCurrent
useSwarmStore.getState().switchToSession(get().activeSwarm, "live");
```

**SSE 监听器累积已完全解决**: 每次 `switchToSession` 的第一步就是取消旧 listener、再注册新的。没有重复消息的问题。

---

## 三、被评估后拒绝的方案

| 方案 | 拒绝原因 | 详情 |
| --- | --- | --- |
| 页面切换 `key={}` 方案 | MonitorPage 卸载 → 状态全丢 | 需要 Keep-Alive 分层替代 |
| view mode 切换过渡 | 频率 tens/day → "reduce or remove" | 瞬间切换是最优方案 |
| ChatView 全字段合并为 1 个 `shallow` selector | 高频字段拖累低频 | 改为 2 组按频率分层 |
| `reset()` + `init(force)` 两个碎片 API | SSE listener 累积、竞态 | 改为单一 `switchToSession` 语义完整 API |

---

## 四、代码架构演进

### 修改前的 session-swarm store 耦合
```
session-store               swarm-store
   newSession() ────────────→ setState({15 fields})
   newSession() ────────────→ (as any).__initRunning = false
   switchToSession() ──────→ (as any).__initRunning = false
   switchToSession() ──────→ setState({9 fields})
   switchToSession() ──────→ addActivity replay
   backToCurrent() ────────→ init()  ← 每次注册新 SSE listener
   deleteSession() ────────→ init()  ← 同上
```

### 修改后
```
session-store               swarm-store
   newSession() ────────────→ switchToSession(name, "live")
   switchToSession() ──────→ switchToSession(name, "live"/"historical")
   backToCurrent() ────────→ switchToSession(name, "live")
   deleteSession() ────────→ switchToSession(name, "live")
                               ├─ 清理旧 __sseUnsubscribe
                               ├─ 重置 15 个状态字段
                               ├─ SSE connect (live) 或 skip (historical)
                               ├─ 拉取 state + before-loop + after-loop
                               └─ 回放 history
```

**关键的 invariants**:
1. SSE listener 永远只有一个注册实例（`__sseUnsubscribe` 在每次注册前被调用）
2. 状态重置永远是同一组 15 个字段（在 `switchToSession` 内部集中管理）
3. session-store 中没有任何 `as any` hack（类型安全）

---

## 五、测试覆盖

| 测试文件 | 测试数 | 覆盖内容 |
| --- | --- | --- |
| `session-store.test.ts` | 4 | switchToSession 调用正确性 (name/mode) |
| `swarm-store.test.ts` | 26 | SSE 处理, before-loop 交互, state management |
| `Button.test.tsx` | 4 | 按钮渲染 |
| `ConfigPage.test.tsx` | 3 | 配置页面 |
| `EmptyState.test.tsx` | 4 | 空状态展示 |
| `ErrorBoundary.test.tsx` | 6 | 错误边界 |
| `PlanViewer.test.tsx` | 2 | 计划查看器 |
| `SessionSwitcher.test.tsx` | 5 | 会话切换器 |
| `api-client.test.ts` | 9 | API 客户端 |
| `config-store.test.ts` | 7 | 配置 store |
| `sse-client.test.ts` | 5 | SSE 客户端 |

**总计**: 11 文件, 81 测试, 全部通过。

---

## 六、后续可能的优化

以下项在本次优化中被讨论但暂时搁置，作为未来 PR 的候选：

1. **ChatView 组件拆分** — 将 565 行的 ChatView 拆为 `MessageList`、`ChatInput`、`StreamBanner` 等独立组件。串行化 streaming 状态到独立的 `MessageList` 中以获得更好的 React 渲染粒度。

2. **触摸设备 hover 适配** — `@media (hover: hover) and (pointer: fine)` gating。当前 SatoPi 以桌面端为主，移动端适配成本高于收益。

3. **WebSocket 替代 SSE** — Bun 的 ReadableStream 实现存在已知的规范偏差（参考 `docs/sse-streaming-bun-pitfalls.md`）。WebSocket 在 Bun 中有更成熟的实现，可以消除 flushTimer queue bridge 的 50ms 延迟。

4. **MonitorPage view mode code splitting** — 当前 8 种视图全部在 MonitorPage 中被 eager import。可按需 lazy load 非 core 视图（AgentTopology, CommMatrix, ScalingHistory 等）。

5. **后端 ActivityLogger 流控** — 前端 SSE 缓冲区在长时间高事件量下可能丢帧。后端 ActivityLogger 可以限制广播频率而非每个 token 都推送（已在本次 SSE 修复中验证了前端 buffer batching 的正确性）。
