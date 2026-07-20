# Agent Architecture Research Report
> 基于 /root/workspace/SatoPi 仓库 | 2026-07-21

## 1. 现有上下文管理 vs Offload — 互补不冲突

### ContextGuard（检测层）
- `context-guard.ts` — 纯函数，只做 token 计数 vs context window 对比
- 三级阈值：80%→warn / 90%→shouldCompact / 100%→exceeded
- **被动调用**，由调用方决定何时检查
- Offload 可以做 compression 动作，两者是"检测-动作"分工

### SwarmSessionManager（固化层）
- `session.jsonl` 统一持久化，CTX 枚举 8 种类型：SWARM_STATE/AGENT_STATE/ACTIVITY/PHASE/VERDICT/CONVERSATION/BEFORE_LOOP/CONVERSATION_SNAPSHOT
- `appendCustomEntry(type, data)` → JSONL 追加
- Offload 可以通过新增 CTX.OFFLOAD_ENTRY 或独立的 JSONL 文件持久化

### PipelineContext（传递层）
- `{ waves, totalTokens, totalRequests }` — 仅跨 wave 累计，不持久化
- Offload 是这一层的补充：把易失的 PipelineContext 中的关键信息抽出固化

## 2. Agent 生命周期 — 每次 Loop 新召唤

### Worker
- 创建：`loop-controller.ts` 每轮构建 prompt → `executeSwarmAgent()` → 返回 `SingleResult`
- 销毁：Worker 完成后进程退出，结果只在 `SingleResult` 中
- **丢失**：Worker 在上一轮迭代中学到的经验、发现的模式、试错的教训
- **没有跨迭代持久化**

### Cloner
- 创建：`roundtable.ts` → `ClonerCouncil.review()` → 多个 `executeSwarmAgent(ClonerPrompt)`
- 销毁：审查完成后返回 `ReviewVerdict`
- **丢失**：Cloner 的审查偏好、历史裁决模式

## 3. Agent 属性 — 当前非常薄

当前 Agent 的属性定义在：
- `schema.ts` — `LoopSwarmConfig.workers` 和 `.cloners` 只是字符串数组（Agent ID 列表）
- `role-asset.ts` — 角色定义（如 guardian/adversarial/security）
- Agent 没有 profile、没有 track record、没有 expertise 声明

## 4. 分工机制 — 简单

- Worker 分配基于 plan.md phase 任务，由 LoopController 决定
- Cloner Council 角色分配在 `roundtable.ts` 中，按预设角色列表轮值

