# SatoPi 架构债务文档

> **创建日期**: 2026-07-20
> **来源**: satopi-architecture-analysis.md（dev 分支变更分析 + 可复用性调研）
> **原则**: 记录当前设计中的已知重叠、未来合并方向、不做当前 PR 的阻塞项

---

## 债务清单

---

### DEBT-01: 双套 Session Registry 模式重叠

**严重程度**: 中

**涉及文件**:

| 文件 | 职责 |
|------|------|
| `packages/coding-agent/src/modes/session-observer-registry.ts` | **前端 UI 可见**的 session 列表：主 session + subagent session， EventBus 同步生命周期，供 Subagent HUD 渲染 |
| `packages/coding-agent/src/swarm/session-registry.ts` | **后端 swarm 执行** session 的服务图：每个 session 绑定 StateTracker + ActivityLogger + RunManager + BeforeLoopManager + SwarmSessionManager |

**重叠分析**:

```text
                    能力对比矩阵

                                        SessionObserverRegistry   SessionRegistry (新)
                                        (已有，219行)              (新增，193行)

Map<string, Session>    会话存储          ✅ Map<string,            ✅ Map<string,
                                        ObservableSession>        SessionServices>

生命周期查询              activeCount     ✅ getActiveSubagentCount()  ✅ activeCount getter
                        get sessions     ✅ getSessions()              ✅ activeSessions getter

事件监听                  onChange          ✅ onChange(cb) 观察者模式  ❌ 无
                        EventBus 集成      ✅ subscribeToEventBus()    ❌ 无

排序/分组               稳定排序          ✅ sortOrder + parentGroup  ❌ 无
                        主 session 锚定   ✅ setMainSession()         ❌ 无

销毁释放               dispose           ✅ dispose()                ✅ destroySession() / destroyAll()
                       reset             ✅ resetSessions()          ❌ 无

服务图绑定               DI 注入          ❌ 无                      ✅ SessionFactory 工厂 + SharedServices
```

**为何当前分开是合理的**:

- `SessionObserverRegistry` 管理的对象是 `ObservableSession { id, kind, label, status, sessionFile, progress }`，面向 UI 渲染
- `SessionRegistry` 管理的对象是 `SessionServices { stateTracker, activityLogger, runManager, ... }`，面向 swarm 执行引擎
- 两者的生命周期触发来源不同：UI 层由 EventBus 的 `TASK_SUBAGENT_LIFECYCLE_CHANNEL` 驱动，swarm 层由 `createSession()`/`destroySession()` 显式调用

**建议的合并方向**（未来迭代）:

```
                        SessionHub (统一基础设施)
                       /                         \
          ObservableSession                      SessionServices
          (UI 视图投影)                          (swarm 执行视图)
          
共享 Map<string, SessionIdOrKey>、生命周期事件总线、并发上限控制
各自维护私有视图数据
```

**当前避免的代价**:
- 强行合并会导致两个模块互相耦合：UI 渲染逻辑被 swarm 服务图拖累，swarm 执行逻辑被 UI 生命周期拖累
- 各自独立后，单一模块的变更不互相影响，符合 SRP

---

### DEBT-02: token 预算工具函数分散在多处

**严重程度**: 低

**涉及文件**:

| 文件 | 预算类型 | 输入 | 用途 |
|------|---------|------|------|
| `packages/agent/src/compaction/compaction.ts` | session 历史压缩触发 | `SessionEntry[]` 数组 + `Usage` | 决定是否触发 compaction |
| `packages/coding-agent/src/swarm/context-guard.ts` | prompt 预发送检查 | 原始文本 `string` + `contextWindow?` | 决定是否截断超限 task |
| `packages/agent/src/tokenizer.ts` | 基础计数 | `string \| string[]` | `countTokens()` 单一入口 |

**当前状态**: 全部共享 `countTokens()` 底层实现，阈值逻辑各自独立。不算重复，但散布在三处。

**建议的合并方向**（低优先级）:

在 `@oh-my-pi/pi-agent-core` 中提供一个统一的 `token-budget.ts` 模块，导出:
- `countTokens(text)` — 已有，保留不变
- `checkPromptBudget(text, window)` — 等价于当前的 `checkContextBudget()`
- `shouldCompact(entries, window, settings)` — 等价于当前的 `shouldCompact()`

这不影响当前功能，仅作为未来重构的统一出口。在 context-guard.ts 文件头注释中已标注与 compaction.ts 的关系。

---

### DEBT-03: clonerFeedbackHistory compaction 是纯文本截断而非语义摘要

**严重程度**: 低

**位置**: `loop-controller.ts:1048-1060`

**当前实现**:
```typescript
const MAX_FEEDBACK_ENTRIES = 3;
while (clonerFeedbackHistory.length > MAX_FEEDBACK_ENTRIES) {
    const oldest = clonerFeedbackHistory.shift()!;
    if (clonerFeedbackHistory[0]?.startsWith("[compacted]")) {
        clonerFeedbackHistory[0] = `[compacted] Previous rounds: ${oldest.slice(60)}...`;
    } else {
        clonerFeedbackHistory.unshift(`[compacted] ${oldest.slice(0, 120)}...`);
        break;
    }
}
```

**已知权衡**:

| 方案 | 延迟 | 信息损失 | 当前选择 | 原因 |
|------|------|---------|---------|------|
| 纯文本截断（当前） | 0ms | 高（只保留前 120 字符） | ✅ | Loop 热路径上不增加 LLM 调用 |
| LLM 摘要 | ~500ms | 低 | ❌ 未采用 | 每次迭代都触发摘要会显著拖慢 loop 节奏 |

**未来可选项**: 当 compaction 超过一定阈值（如累积 10+ 轮反馈）时，触发一次异步 LLM 摘要作为 `[compacted summary]` 替换当前截断文本。异步执行，不阻塞当前迭代。

---

### DEBT-04: StateTracker.persist() 优雅降级的静默失败

**严重程度**: 低

**位置**: `state.ts:312-330`

```typescript
async #persist(): Promise<void> {
    // ...
    this.#writeChain = this.#writeChain.then(async () => {
        const snapshot = this.#state;
        try {
            this.#sessionManager?.logSwarmState(snapshot);
        } catch {
            // Swallow persist errors — we don't want state tracking
            // failures to crash the pipeline.
        }
    });
}
```

**已知风险**: 当 `sessionManager` 为 null 或 `logSwarmState()` 持续失败时，没有告警或退路。内存状态准确但不持久，重启即丢失。

**当前可接受**: 因为 `SessionRegistry.createSession()` 会在 session 创建时注入 `sessionManager`，正常情况下不为 null。但需要关注边缘情况（`catch` 中的 `logger.warn` 提示已出现）。

**建议**: 在 `catch` 块中添加累计错误计数，当连续失败 5 次时触发 `logger.error`。

---

### DEBT-05: SessionManager session.jsonl header bootstrap 的手工拼接

**严重程度**: 低

**位置**: `swarm-session-manager.ts:97-110`

```typescript
const id = crypto.randomUUID();
const timestamp = new Date().toISOString();
const safeTs = timestamp.replace(/[:.]/g, "-");
const filePath = path.join(sessionDir, `${safeTs}_${id}.jsonl`);

const header = {
    type: "session",
    version: 1,
    id,
    timestamp,
    cwd: path.resolve(swarmDir),
};
await fs.writeFile(filePath, JSON.stringify(header) + "\n", "utf-8");
```

**已知原因**: `SessionManager` 的 lazy gate 只在首次 assistant message 后才创建文件，而 Swarm 只用 custom entries（无 message entries），所以必须手动创建 header。

**潜在风险**: 如果后续 OH-MY-PI 的 `SessionManager` 改变了 header 格式或文件命名规则，这里的硬编码会不同步。

**建议**: 在 OH-MY-PI 上游提 PR，让 `SessionManager` 暴露一个 `createEmpty(metadata)` 静态方法，避免下游手动拼接 header line。当前作为临时方案可以接受。

---

## 债务优先级汇总

| ID | 债务 | 严重度 | 建议时间线 | 改动量 |
|----|------|--------|-----------|--------|
| DEBT-01 | 双套 Session Registry | 中 | 下一大版本统一 | ~300 行 |
| DEBT-02 | token 预算散落三处 | 低 | 有空时重构 | ~50 行 |
| DEBT-03 | feedback compaction 纯截断 | 低 | 积累 10+ 轮时升级为异步 LLM 摘要 | ~100 行 |
| DEBT-04 | persist 静默失败 | 低 | 下一迭代修复 | ~5 行 |
| DEBT-05 | header 手工拼接 | 低 | 等 OH-MY-PI 上游暴露 API | ~20 行 |

---

## 结论

dev 分支新增代码整体质量良好，**没有发现"重新发明轮子"的严重问题**。上述债务主要是：

1. **设计取舍**（DEBT-01、DEBT-03）—— 各模块职责分离需要在未来统一，但当前分开是合理的
2. **上游依赖**（DEBT-02、DEBT-05）—— 需要 OH-MY-PI 基类暴露更多能力，临时方案可接受
3. **边缘处理**（DEBT-04）—— 轻微改进，容易修复

所有债务均不阻塞当前 PR，可在后续迭代中渐进式解决。
