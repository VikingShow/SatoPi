# SatoPi Swarm Full Bridge — 实现计划

> 状态: 进行中
> 启动: 2026-07-27

## 目标

让交互式 TUI 中的 `swarm` magic keyword 真正驱动 SwarmRunner 的完整生命周期（Script → Stage → Curtain），融合两条当前完全不交的路径。

## 现状

```
路径 A: magic keyword "swarm"
  用户输入 "swarm" → SWARM_NOTICE 注入 → agent 用 task 工具手动派发
  → 无状态机, 无 DAG 调度, 无经验积累, 纯 prompt 驱动

路径 B: SwarmRunner 三阶段 (stp swarm run)
  Script → Stage → Curtain, 完整的 WorkflowFSM + DAG + ExperienceStore
  → 但要走 CLI, 与 TUI 交互式会话割裂
```

## 基础设施状态

全部就绪，0 缺失：

- WorkflowFSM (`swarm/core/workflow-fsm.ts`)
- StageController (`swarm/stage/stage-controller.ts`)
- CurtainRunner (`swarm/curtain/curtain-runner.ts`)
- SwarmRunner (`swarm/core/swarm-runner.ts`)
- AgentRuntime (`swarm/agent-runtime/`)
- StateTracker (`swarm/core/state.ts`)
- ActivityLogger (`swarm/infra/activity-logger.ts`)
- SwarmSessionManager (`swarm/session/swarm-session-manager.ts`)
- ExperienceStore (`swarm/curtain/experience.ts`)
- HookPipeline (`swarm/hook-system/hook-pipeline.ts`)
- PhaseBehavior (`swarm/behaviors/`)
- RoleAssetManager (`agent/role-asset.ts`)
- DAG (`swarm/core/dag.ts`)
- TaskQueue (`swarm/executor/task-queue.ts`)
- SwarmDashboardOverlay / SwarmDashboardComponent / SwarmTuiBinding (`modes/components/swarm/`)
- MnemopiAdapter / HindsightAdapter (`swarm/infra/`)
- ScriptManager / ScriptPlanner (`swarm/script/`)

## 实现阶段

### Phase 1: 核心桥接

| Step | 文件 | 改动 | 产出 |
|---|---|---|---|
| 1 | `swarm/core/embedded-swarm-bridge.ts` (新) | ~350行 | 核心桥接器 |
| 2 | `session/agent-session.ts` | ~100行 | trigger bridge.init() on magic keyword |
| 3 | `prompts/system/swarm-notice.md` | ~80行重写 | agent 定位为 Script coordinator |
| 4 | `modes/interactive-mode.ts` | ~150行 | dashboard 接入真实状态 |
| 5 | `config/settings-schema.ts` | ~50行 | swarm 配置项 |

### Phase 2: 交互完善

| Step | 改动 | 产出 |
|---|---|---|
| 6 | dashboard + stage-controller | steering 消息路由到 worker |
| 7 | bridge + curtain-runner | applaud 机制 + 经验持久化 |
| 8 | debate-roundtable | 可选 plan debate |

### Phase 3: Theatre Graph (后续)

用户可定义的 DAG 工作流引擎，将硬编码三阶段泛化。
