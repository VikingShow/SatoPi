# L3 Offload 模板截断限制

## 背景

SatoPi 的 Offload 管道分三层（L1/L2/L3），对比 TencentDB 的实现：

| 层级 | TencentDB | SatoPi | 说明 |
|------|-----------|--------|------|
| L1 | tool call 输入 | agent message 输入 | SatoPi 从 tool call 改为 agent message，适配通用 agent 架构 |
| L2 | 结构化摘要 | Mermaid 流程合成 | 两平台不同 |
| L3 | LLM 压缩 | **纯模板截断（200 字符）** | **差异点** |

## 问题

`AgentOffloadSummarizer.summarize()` 采用纯文本截断策略：
- 提取最后一条 assistant 消息
- 截取前 **200 字符**
- 对大型输出（> 2000 字符）仅标记 `artifact://` 引用

**典型问题场景**：当 agent 输出是工具调用结果（如 `{"files": [...], "errors":[]}` JSON blob），200 字符截断会产生无意义摘要：

```
{"files":["src/index.ts","src/utils.ts"],"errors":[],"warnings":[{"file":"...
```

这样的摘要不包含任何语义信息。

## 解决方案

当前已实现可选的 LLM 模式（`AgentOffloadSummarizer` 构造函数接受 `llm` 配置）：

```typescript
const summarizer = new AgentOffloadSummarizer({
  llm: { modelRegistry, settings }
});

// 当输出 > 500 字符或包含 JSON 时，自动使用 LLM 压缩
// 否则 fallback 到 200 字符截断
await summarizer.summarize(input);
```

### LLM 模式触发条件

- 输出文本长度 > **500 字符**
- 输出以 `{` 或 `[` 开头（疑似 JSON）

### LLM 摘要策略

- 使用轻量模型（如 `gpt-4o-mini`），maxTokens=200
- Prompt：提取完成内容、关键决策、错误/阻塞点
- 失败时自动 fallback 到文本截断

## 建议

- **默认关闭 LLM 模式**（成本考虑），通过 `constructor({ llm: ... })` 显式启用
- 适合在生产环境启用，避免工具调用输出的无意义摘要
- 对于纯自然语言输出，200 字符截断通常已足够
