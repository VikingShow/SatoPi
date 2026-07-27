# Swarm Full Bridge + Theatre Graph — 进度追踪

> 开始: 2026-07-27
> 状态: Phase 1-2 完成, Phase 3 方案就绪

## Phase 1: 核心桥接 ✅
- [X] embedded-swarm-bridge.ts
- [X] agent-session.ts magic keyword 触发
- [X] swarm-notice.md 重写
- [X] interactive-mode.ts dashboard 接线
- [X] settings-schema.ts 配置项
- [X] 测试: 9/9 pass

## Phase 2: 交互完善 ✅
- [X] bridge.steer() → CommBus
- [X] SwarmDashboardOverlay onSteering
- [X] interactive-mode dashboard ↔ bridge 接线
- [X] applaud 关键词检测
- [X] auto-applaud 5min timeout
- [X] plan debate (enableDebate 设置)
- [X] 测试: 9/9 pass

## Phase 3: Theatre Graph — 方案就绪 ✅

5-agent 圆桌辩论完成，14/14 共识点收敛。9 项 ADR。

### 实现路线

| Phase | 内容 | 代码量 | 时间 |
|---|---|---|---|
| 0: Interface | ISwarmOrchestrator, settings flag, RunManager adapter | +80 / Δ30 | 0.5天 |
| 1: Engine | GraphRunner, NodeBehavior×4, GateController, checkpoint | +900 / Δ50 | 3天 |
| 2: Integrate | CLI compat, Mermaid compiler, TUI graph view, migration | +600 / Δ200 | 3天 |
| 3: Flip | 默认切换, @deprecated, 清理 | +50 / Δ100 | 0.5天 |
| **总计** | | **+1630 / Δ380** | **~7天** |

### 新增文件 (12个)
- `graph/schema.ts`, `graph/graph-runner.ts`, `graph/graph-executor.ts`
- `graph/node-behavior.ts`, `graph/gate-controller.ts`, `graph/phase-behavior-adapter.ts`
- `graph/mermaid-compiler.ts`, `graph/loop-converter.ts`, `graph/checkpoint.ts`
- `graph/context/upstream-output-source.ts`
- `modes/components/swarm/graph-view.ts`
- `.stp/graphs/builtin/theatre.graph.yaml`
