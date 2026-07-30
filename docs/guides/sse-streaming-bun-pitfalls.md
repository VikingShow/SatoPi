# SSE 流式输出在 Bun 环境下的完整排查与修复

## 现象

SatoPi 前端在对话时**无法看到实时流式输出**，必须刷新页面才能看到内容。同时浏览器持续弹出 "Reconnecting" 弹窗，DevTools Network 标签显示：

```
GET /events?session=... net::ERR_INCOMPLETE_CHUNKED_ENCODING 200 (OK)
```

## 完整的数据链路

```
LLM Provider (DeepSeek)
  → stream:true SSE chunks
  → openai-completions.ts / readSseJson()
  → AgentSession text_delta events
  → executor.ts emitProgressNow() → onProgress(progress)
  → createStreamProgressHandler() → diff recentOutput
  → ActivityLogger.logStreamDelta(msgId, from, delta)
  → ActivityLogger.log()
    ├─ sessionManager.logActivity(entry)  → session.jsonl (持久化)
    └─ broadcaster.broadcast(sessionName, entry)  → SSE (实时)
  → MonitorServer.broadcast()
  → EventBus.broadcast() → #send() → #sendOne()
  → controller.enqueue(encoded)
  → Bun ReadableStream → HTTP Response
  → Browser EventSource → sse-client.ts → swarm-store.ts → React
```

## 根因深度分析：为什么会出现这个问题

### Bun ReadableStream 的规范偏离

SatoPi 从项目建立之初就基于 Bun 运行时（`Bun.serve()`、`Bun.file()` 等），不存在 Node.js 迁移的问题。问题根源在于 **Bun 自研的 ReadableStream 实现与 WHATWG 规范存在行为差异**。

#### WHATWG 规范 vs Bun 实际行为

WHATWG ReadableStream 规范规定：无论 `pull()` 是否 pending，只要调用 `controller.enqueue(data)`，数据就进入内部队列并应立即交付给消费者。数据流经 `pull()` 发起的 enqueue 和外部发起的 enqueue 应当等价处理。

Bun 的实际行为：

```typescript
// ✅ 正常 —— start() 闭包内调用 controller.enqueue()
start(controller) {
    setInterval(() => {
        controller.enqueue(keepaliveData);  // 浏览器收到 :keepalive
    }, 5000);
}

// ❌ 静默失败 —— 外部调用同一个 controller.enqueue()
// EventBus 从完全不同的调用栈调用 ↓
subscriber.controller.enqueue(eventData);  // enqueue() 不抛异常，浏览器收不到
```

区别在于 `enqueue()` 的**调用来源**。同一个 `ReadableStreamDefaultController` 对象：
- 在 `start()` 的 `setInterval` 回调中调用 → 数据交付到 HTTP 消费者
- 在 EventBus 的广播路径中调用 → 数据不交付，但也不报错

这暗示 Bun 的 ReadableStream 内部有某种**上下文追踪机制**：它只信任流自身的闭包链中发起的 `enqueue()`，外部的异步调用被忽略。这是一种**静默失败**——没有任何异常、任何错误码、"看起来一切正常"——只有抓包才能发现数据丢失。

#### Bun vs Node.js 在此场景下的表现差异

| 维度 | Node.js (V8) | Bun (JavaScriptCore) |
|------|-------------|---------------------|
| JS 引擎 | V8 | JavaScriptCore (WebKit) |
| ReadableStream | V8 内置，严格 WHATWG 规范 | Bun 自研实现（`zig` 编写） |
| 外部 enqueue 交付 | ✅ 按规范正常交付 | ❌ 静默不交付 |
| HTTP 服务模型 | `http.createServer` + `res.write()` | `Bun.serve()` + `Response(ReadableStream)` |
| SSE 的差异 | `res.writeHead()` + 持续 `res.write()` —— 无 ReadableStream 参与 | 必须返回 `Response(ReadableStream)` —— 必经 ReadableStream 层 |
| 此 bug 是否触发 | 不会（Node.js SSE 不经过 ReadableStream） | 会（Bun SSE 强制经过 ReadableStream） |

**关键点**：Node.js 的传统 SSE 实现使用 `http.ServerResponse.write()` 直接向 socket 写数据，完全不经过 ReadableStream 抽象层，因此根本不会遇到这个问题。Bun 的 `Bun.serve()` 模型要求所有响应体都以 `Response(ReadableStream)` 形式返回，SSE 被强制纳入 ReadableStream 管道，恰好撞上 Bun 的实现缺陷。

#### 为什么开发阶段未暴露

这个 bug 需要**同时满足三个条件**才会触发：

1. **SSE 端使用 `ReadableStream` + `pull()`** —— 这是 Bun HTTP 模型下保持 SSE 长连接的必然选择（否则 `ERR_INCOMPLETE_CHUNKED_ENCODING`）
2. **事件生产者与流的 `start()` 在不同的调用上下文中** —— SatoPi 的 EventBus 作为独立模块，从 Agent 进程的异步回调中广播事件，与 SSE 流的 `start()` 闭包完全解耦
3. **有足够多的流式事件需要实时推送** —— 仅在 Agent 产生 token 级 `stream_delta` 事件时才会触发高频 enqueue

在开发阶段，可能只在单会话、快速对话、或直接查看 session.jsonl 的场景下测试过。`setBroadcaster` 的错误（Bug 3/4）掩盖了 Bug 2——因为 broadcaster 为 null，根本没有调用到 EventBus 的广播路径，自然也看不到 Bun 的 enqueue 丢失问题。修复 Bug 3/4 后 Bug 2 才暴露出来。

### `setBroadcaster` 初始化代码的增长失控

第二个根因是**初始化代码的增长失控**。原始 `standalone.ts` 的启动流程：

```
创建 registry
创建默认 session          ← 只有这一个 session
创建 server
server.start()
session.activityLogger.setBroadcaster(server)  ← 仅对默认 session 调用
```

当时只有一个默认 session，`setBroadcaster` 调用它就能覆盖所有场景。之后两次功能迭代：

1. **历史 session 恢复**：新增了从磁盘扫描 `.swarm_*` 目录并 `createSession()` 的逻辑，但 `setBroadcaster` 调用未扩展
2. **API 新建 session**：新增了 `POST /api/sessions` 端点，但 `createSession()` 内部未自动注入 broadcaster

每次迭代都只在已有的单点调用上加功能，没有将其提升为 `SessionRegistry` 层面的生命周期钩子。这属于典型的"初始化脚本膨胀"反模式——当系统的创建路径从一个变成多个时，分散的初始化代码就会产生遗漏。

## 排查过程与发现的 4 个 Bug

### Bug 1：Bun ReadableStream 提前关闭 HTTP chunked 传输

**位置**：`packages/coding-agent/src/swarm/monitor/server.ts` — `/events` SSE 端点

**根因**：原始实现使用 `ReadableStream` + `start()` 方法，`start()` 同步返回后 Bun 判定流已结束，立即关闭 HTTP chunked 传输。客户端收到 `ERR_INCOMPLETE_CHUNKED_ENCODING`，SSE 连接持续断开重连。

**验证**：
```bash
# 修复前
curl -N http://host:7878/events?session=test
# 输出：: connected  立即 → curl: (18) transfer closed
```

**修复**：添加 `pull()` 方法，返回永不 resolve 的 Promise 告知 Bun 流仍存活。

```typescript
pull() {
    return new Promise(() => {});
}
```

### Bug 2：Bun ReadableStream 不交付外部 enqueue 的数据（核心问题）

**位置**：`packages/coding-agent/src/swarm/monitor/server.ts`

**根因**：Bug 1 的修复使连接保持存活，keepalive（`start()` 闭包内的 `setInterval`）能正常到达浏览器。但 EventBus 从**外部**调用 `controller.enqueue()` 时，Bun 的 `ReadableStream` 实现不会将这些数据交付给 HTTP 消费者——`enqueue()` 执行成功（不抛异常），但浏览器收不到任何 `data:` 帧。

**验证**：添加 server 端诊断日志，确认 `controller.enqueue()` 返回成功但浏览器 Network 标签只有 `: keepalive` 注释行。

**修复**：引入**队列桥接模式**，解耦外部推送与 Bun 交付。

```typescript
start(controller) {
    const msgQueue: Uint8Array[] = [];

    // Bridge: EventBus → msgQueue（不碰真实 controller）
    const bridge: SSEController = {
        enqueue(chunk: Uint8Array) { msgQueue.push(chunk); },
        close() { controller.close(); },
        error(e) { controller.error(e); },
        get desiredSize() { return controller.desiredSize; },
    };
    bus.subscribe(sessionName, bridge, ...);

    // flushTimer: 在 start() 闭包内排空 msgQueue → controller.enqueue()
    const flushTimer = setInterval(() => {
        while (msgQueue.length > 0) {
            controller.enqueue(msgQueue.shift()!);
        }
    }, 50);
},
pull() {
    // 自解 Promise：保持连接存活，不依赖外部唤醒
    return new Promise(r => setTimeout(r, 50));
},
```

**关键设计原则**：
- `pull()` 与 `flushTimer` **完全解耦**，无共享状态，无线程竞争
- `pull()` 仅负责防止 Bun 提前关闭连接
- `flushTimer` 负责实际数据交付，50ms 轮询延迟对文本流式传输不可感知

### Bug 3：历史恢复的 session 未设置 broadcaster

**位置**：`packages/coding-agent/src/swarm/monitor/standalone.ts`

**根因**：`standalone.ts` 启动时从磁盘恢复历史 session（如 `SatoPi-20260722-1555`），但仅对默认 session 调用了 `setBroadcaster(server)`。恢复的 session 的 `ActivityLogger.#broadcaster` 为 `null`，导致 `log()` 中 `this.#broadcaster?.broadcast(...)` 为空操作——事件写入 `session.jsonl` 但**不推送 SSE**。刷新页面后通过 `getHistory()` 从 JSONL 回放才能看到内容。

**验证**：对比 `loop.yaml`（`name: SatoPi`）与 workspace 下的 `.swarm_*` 目录（存在多个 session）。在 ActivityLogger 添加 `broadcaster` 存在性诊断日志。

**修复**（初版）：遍历所有 active sessions 设置 broadcaster。
```typescript
for (const s of registry.activeSessions) {
    s.activityLogger.setBroadcaster(server);
}
```

### Bug 4：API 新建的 session 未设置 broadcaster

**位置**：`packages/coding-agent/src/swarm/session-registry.ts`

**根因**：Bug 3 的修复只覆盖启动时已存在的 session。用户通过 UI 新建 session（触发 `POST /api/sessions` → `registry.createSession()`）时，新 session 的 ActivityLogger 仍未设置 broadcaster。症状与 Bug 3 一致。

**修复**：让 `SessionRegistry` 持有 broadcaster 引用，在 `createSession()` 中自动注入。

```typescript
// session-registry.ts
export class SessionRegistry {
    #broadcaster: ActivityBroadcaster | null = null;

    setBroadcaster(broadcaster: ActivityBroadcaster): void {
        this.#broadcaster = broadcaster;
    }

    async createSession(name: string): Promise<SessionServices> {
        // ... 创建 session ...
        if (this.#broadcaster) {
            services.activityLogger.setBroadcaster(this.#broadcaster);
        }
        // ...
    }
}

// standalone.ts — 调整启动顺序
const registry = new SessionRegistry(shared, createSessionServices);
const server = new MonitorServer(registry);
server.start(7878);
registry.setBroadcaster(server);   // ← 必须在 createSession 之前
const session = await registry.createSession(swarmName);
// 恢复历史 session（自动获得 broadcaster）
```

## 验证方法

```bash
# 1. 验证 SSE 连接稳定（无 transfer closed）
curl -N --max-time 10 http://host:7878/events?session=test
# 预期：输出 :connected 和 :keepalive，超时退出（exit 28），非 transfer closed（exit 18）

# 2. 验证 data 帧实时到达
curl -sS -N --max-time 40 "http://host:7878/events?session=SatoPi" > /tmp/sse.txt &
curl -X POST "http://host:7878/api/session/SatoPi/before-loop/start" \
  -H "Content-Type: application/json" -d '{"task":"say hello"}'
# 预期：/tmp/sse.txt 中包含 stream_start / stream_delta / stream_end 帧
grep -c "^data:" /tmp/sse.txt  # > 0

# 3. 验证 API 新建 session 也有广播
curl -X POST "http://host:7878/api/sessions" -H "Content-Type: application/json" \
  -d '{"name":"test-new"}'
# SSE subscribe test-new → start before-loop → 确认收到 data 帧
```

## 关键经验总结

1. **Bun 与 Node.js 的 ReadableStream 实现差异**：Bun 不完全兼容 WHATWG ReadableStream 规范中「pull() pending 时外部 enqueue() 应交付数据」的行为。需要将数据交付抽象到流自身的闭包上下文中。

2. **SSE 调试的分层诊断**：当实时推送失效时，逐层排查——LLM 输出 → Agent Session → ActivityLogger → broadcaster → EventBus → ReadableStream → HTTP → 浏览器。每层用独立的诊断日志缩小范围。

3. **session 生命周期与依赖注入**：broadcaster 这类"全局基础设施"应通过 Registry 统一管理，确保所有 session（无论创建时机）都自动获得注入，避免散落的 `setBroadcaster` 调用导致遗漏。

4. **自解耦的并发设计**：`pull()` + `flushTimer` 各自独立运作、无共享可变状态，比 `pull()` + `wakePull()` 的外部唤醒模式更可靠——后者在 Bun 的事件循环中会产生难以调试的时序竞争导致 reconnect。

## 修改文件清单

| 文件 | 修改内容 |
|------|---------|
| `packages/coding-agent/src/swarm/monitor/server.ts` | SSE 端点：flushTimer 队列桥接 + pull() 自解 Promise |
| `packages/coding-agent/src/swarm/monitor/standalone.ts` | 启动顺序调整：server→setBroadcaster→createSession |
| `packages/coding-agent/src/swarm/session-registry.ts` | 新增 `setBroadcaster()` + `createSession()` 自动注入 |
| `packages/coding-agent/src/swarm/monitor/event-bus.ts` | 导入 `SSEController` 类型导出（供 server.ts 使用） |
