# Swarm CLI 原生集成 — 执行计划

## 目标

将 SatoPi swarm 多 Agent 编排从独立的 HTTP/GUI 系统改造为 CLI 原生功能，
支持魔法关键词、斜杠命令、CLI 子命令三种触发方式。

## 步骤

### P1: SwarmRunner 实现 RunManager
- [x] 新建 `src/swarm/core/swarm-runner.ts`
- [x] 从 SessionServices 注入依赖
- [x] 实现 start/stop/pause/resume/resolveBlocker
- [x] 编排 Script → Stage → Curtain 生命周期
- **状态**: done — commit `2247c61`

### P2: CLI 子命令 stp swarm
- [x] 新建 `src/cli/swarm-cli.ts`
- [x] 注册到 `cli-commands.ts` (`swarm run/plan/resume`)
- **状态**: done

### P3: swarm 魔法关键词
- [x] 在 `src/modes/magic-keywords.ts` 注册 `swarm`
- [x] 新建 `src/prompts/system/swarm-notice.md`
- [x] settings-schema 添加 `magicKeywords.swarm`
- **状态**: done

### P4: /swarm 内置斜杠命令
- [x] 注册到 `src/slash-commands/builtin-registry.ts`
- [x] 移除 `/loopeng`
- **状态**: done

### P5: swarm agent 加入 task tool
- [x] 在 `src/task/agents.ts` 添加 swarm agent 定义
- [x] 新建 `src/prompts/agents/swarm.md`
- **状态**: done

### P6: AgentHandle 事件暴露
- [x] AgentHandle 新增 `subscribe()` 方法
- [x] 新增 `bridgeToolEvents()` 桥接 AgentEvent → ActivityLogger
- **状态**: done

### P7: Dashboard 接入 TUI
- [ ] interactive-mode.ts 中检测 swarm session
- [ ] 活跃时在 Footer 上方渲染 Dashboard
- [ ] Dashboard 订阅 ActivityLogger 事件
- **状态**: P7/P9 merged — Dashboard components ready, wiring deferred

### P8: 清理
- [x] 删除 `packages/swarm-extension/`
- [x] 移除旧 `renderSwarmProgress()` (`render/render.ts`)
- [x] 移除 `/loopeng` 相关引用
- **状态**: done

### P9: 验证
- [x] typecheck 无新增错误
- [x] 236 swarm 核心测试通过
- [ ] `stp swarm run loop.yaml` 端到端验证
- **状态**: core verification done

## 文件变更汇总

| 新增 | 修改 | 删除 |
|---|---|---|
| `src/swarm/core/swarm-runner.ts` | `src/cli/cli-commands.ts` | `packages/swarm-extension/` |
| `src/cli/swarm-cli.ts` | `src/modes/magic-keywords.ts` | `src/swarm/render/render.ts` |
| `src/commands/swarm.ts` | `src/slash-commands/builtin-registry.ts` | |
| `src/prompts/system/swarm-notice.md` | `src/config/settings-schema.ts` | |
| `src/prompts/agents/swarm.md` | `src/task/agents.ts` | |
| `src/modes/swarm.ts` | `src/swarm/core/index.ts` | |
| | `src/swarm/agent-runtime/agent-handle.ts` | |
| | `src/swarm/core/services.ts` | |
| | `src/swarm/curtain/types.ts` | |
| | `src/swarm/curtain/curtain-runner.ts` | |

## 架构

```
stp swarm run loop.yaml
  └─ SwarmRunner
       ├─ parseSwarmYaml / validate
       ├─ ScriptManager → Planner Agent
       ├─ StageController → AgentRuntime.spawn(workers)
       └─ CurtainRunner → CurtainResult
```
