# SatoPi Theatre Graph — 最终设计方案

> 圆桌辩论: Architect, UXDesigner, RuntimeEngineer, DataArchitect, CompatEngineer
> 日期: 2026-07-27
> 共识: 14/14 点全部收敛

## 架构概览

```
                    ISwarmOrchestrator (Phase 0 提取)
                             │
              ┌──────────────┴──────────────┐
              │                             │
        SwarmRunner                  GraphRunner
        (legacy, 保留)               (新引擎)
                                             │
                              ┌──────────────┼──────────────┐
                              │              │              │
                        GraphExecutor   NodeBehavior    GateController
                        (waves|dynamic) (script/stage/   (compile/test/
                                        curtain/custom)  lsp/human)
```

**核心洞察**: WorkflowFSM 不需要改。它的 phase 图 (idle → stage → paused/blocked → curtain → idle) 是**通用执行生命周期**，不关心执行的是什么。GraphRunner 是 SwarmRunner 的即插即用替换。

---

## 9 项架构决策 (ADR)

### ADR-1: 执行策略
- `strategy: "waves"` (默认) — 拓扑排序 → 逐 wave 并行 → wave barrier
- `strategy: "dynamic"` (可选) — 信号量门控的就绪队列，`max_concurrency` 控制
- 复用现有 `buildExecutionWaves()` + `detectCycles()`

### ADR-2: FSM 集成
- WorkflowFSM **零改动**
- Macro-state: idle → stage → curtain → idle (FSM phases)
- Micro-state: "wave 2/5: 3 nodes running" (subStatus + StateTracker)

### ADR-3: 节点类型系统
- 四种类型: `script`, `stage`, `curtain`, `custom`
- `custom` 是默认值 — 普通用户不需要选类型
- 全部实现 `NodeBehavior` 接口 (prepare/execute/validate/cleanup)

### ADR-4: PhaseBehavior 兼容
- `PhaseBehaviorNodeAdapter` 包装现有 ScriptBehavior/StageBehavior/CurtainBehavior
- 现有行为**零改动**
- SwarmRunner 直接用 PhaseBehavior；GraphRunner 通过 adapter

### ADR-5: 图创作
- 两条路径: agent 写的 `.graph.yaml` (magic keyword) + Mermaid 编译的 `.graph.mermaid`
- Mermaid 是草图，YAML 是可执行规范
- Mermaid 编译器保留用户已设置的 YAML 字段，覆盖默认值
- **YAML 是唯一真实来源**

### ADR-6: 人类交互
- **Wave 级暂停** — 当前 wave 跑完 → 暂停 → 用户确认 gates → 下一 wave
- Gate 批量审查面板（per wave）: auto-passed 折叠，human-review 展开
- Ctrl+K = 紧急终止当前 wave

### ADR-7: Graph Schema
```typescript
interface GraphDefinition {
  name: string; description: string;
  version: number;       // schema parser contract
  revision: number;      // user iteration counter
  previous_revision?: number;
  strategy?: "waves" | "dynamic";
  max_concurrency?: number;
  nodes: Record<string, GraphNode>;
  edges?: GraphEdge[];
  hooks?: GraphHook[];
  defaults?: GraphDefaults;
}

interface GraphNode {
  label: string; description: string;
  type?: "script" | "stage" | "curtain" | "custom";  // default: custom
  role: string; tools: string[];
  depends_on: string[];
  outputs?: NodeOutput[];
  gate?: GateSpec;
  timeout?: string;           // "30m", "2h"
  retry?: RetrySpec;
  heavy?: boolean;            // 允许 agent_fork
  continue_on_failure?: boolean;
  context_sources?: string[]; // per-node context allowlist
  max_context_tokens?: number;
  profileId?: string;         // 显式绑定 AgentProfile
}

interface GraphEdge {
  from: string; to: string;
  artifacts?: string[];       // glob patterns
  label?: string;             // Mermaid edge label
}
```

### ADR-8: 持久化
- Checkpoint/resume **纳入 v1**
- 每个节点状态转换时写入 `session.jsonl`
- 崩溃恢复: 回放 session.jsonl → 重建 GraphRunState → 从最后未完成的 wave 恢复
- 运行开始时快照 graph YAML → 运行中编辑被忽略

### ADR-9: 迁移
4 阶段，一个 release 双引擎共存:
1. **Phase 0**: 提取 ISwarmOrchestrator 接口
2. **Phase 1**: GraphRunner 引擎 + 节点实现 + schema
3. **Phase 2**: CLI 兼容 + TUI + 转换 + 可靠性 (feature-flagged)
4. **Phase 3**: 默认切换 + legacy 移除

---

## .graph.yaml 磁盘布局

```
.stp/
├── graphs/                         # 图定义 (git tracked)
│   ├── builtin/
│   │   └── theatre.graph.yaml      # 内置三阶段图
│   └── my-workflow.graph.yaml      # 用户图
├── graph-runs/                     # 运行记录
│   └── <run-id>/
│       ├── snapshotted_graph.yaml  # 运行时的图快照
│       ├── session.jsonl           # GraphRunState 日志
│       └── node-outputs/           # 节点产物
└── experience/
    └── index.sqlite                # 经验库 (新增 graph_name, node_id, task_hash 列)
```

## 配置流动

```
.graph.yaml
  │
  ├─ Compile-Time Validator
  │   ├─ YAML 语法 + schema 校验
  │   ├─ 循环检测 (detectCycles)
  │   ├─ 角色可解析性 (RoleProvider)
  │   ├─ 工具可用性 (tool registry)
  │   └─ → GraphDefinition (validated)
  │
  └─ GraphRunner.run()
      │
      ├─ per node: ContextPipeline.build({
      │     node, upstreamOutputs, experience, hooks
      │   })
      │   ├─ UpstreamOutputSource (新) — 注入上游节点产物
      │   ├─ ExperienceSource — 按 graph_name/node_id/role 过滤
      │   ├─ MnemopiSource / HindsightSource — 可选
      │   └─ context_sources allowlist 控制
      │
      ├─ per node: HookPipeline.fire({
      │     "graph:node:beforeSpawn",
      │     "graph:node:afterComplete",
      │     "graph:node:gatePassed",
      │     "graph:node:gateFailed"
      │   })
      │
      ├─ per wave: GateController.runGates()
      │   ├─ compile-check / test / lsp / human-review / script
      │   ├─ human-review mode: always | on-failure | never
      │   └─ retry_strategy: immediate | fixup | human
      │
      └─ curtain: runCurtainPipeline()
          ├─ Reporter agent (election via CommBus.vote)
          ├─ Reflection agents → ExperienceStore
          └─ GraphRefiner (可选) → 更新 .graph.yaml
```

## TUI 可视化

```
┌─ Theatre Graph · Wave 2/3 ─────────────────────────────────┐
│                                                              │
│   Wave 1 ✓    Wave 2 ▶    Wave 3 ·                           │
│                                                              │
│   ┌──────────┐     ┌──────────┐                              │
│   │ backend  │     │ frontend │                              │
│   │  ✓ 1:05  │     │  ◌ 3:22  │                              │
│   └────┬─────┘     └────┬─────┘                              │
│        │audit.md        │ui.tsx                               │
│        └───────┬────────┘                                    │
│                ▼                                              │
│         ┌──────────┐                                         │
│         │ reviewer │  · pending                              │
│         └──────────┘                                         │
│                                                              │
└─ 5 nodes · 3/7 tasks · 12K tokens ──────────────────────────┘
```

---

## 实现路线

| Phase | 内容 | 新增代码 | 改动代码 | 时间 |
|---|---|---|---|---|
| **0: Interface** | ISwarmOrchestrator 提取, settings flag, RunManager adapter | ~80行 | ~30行 | 0.5天 |
| **1: Engine** | GraphDefinition schema, GraphRunner, GraphExecutor, NodeBehavior×4, GateController, PhaseBehaviorNodeAdapter, checkpoint/resume | ~900行 | ~50行 | 3天 |
| **2: Integrate** | CLI compat (swarm run --engine=graph), Mermaid compiler, loop.yaml converter, TUI graph view, token budget, compaction wiring, ExperienceStore migration | ~600行 | ~200行 | 3天 |
| **3: Flip** | 默认引擎切换, SwarmRunner @deprecated, 旧引擎保留一个 release, 清理 | ~50行 | ~100行 | 0.5天 |
| **总计** | | **~1630行** | **~380行** | **~7天** |

## 文件清单

### 新增
| 文件 | 行数 | 职责 |
|---|---|---|
| `graph/schema.ts` | ~180 | GraphDefinition types + YAML parser + compile-time validator |
| `graph/graph-runner.ts` | ~250 | 核心编排器: parse → waves → execute → curtain |
| `graph/graph-executor.ts` | ~150 | WaveScheduler + DynamicScheduler |
| `graph/node-behavior.ts` | ~120 | NodeBehavior interface + 4 implementations |
| `graph/gate-controller.ts` | ~120 | Gate 执行 + 重试 + 失败处理 |
| `graph/phase-behavior-adapter.ts` | ~80 | PhaseBehavior → NodeBehavior 包装器 |
| `graph/mermaid-compiler.ts` | ~150 | Mermaid flowchart → GraphDefinition |
| `graph/loop-converter.ts` | ~100 | loop.yaml → graph.yaml |
| `graph/checkpoint.ts` | ~80 | GraphRunState 序列化/恢复 |
| `graph/context/upstream-output-source.ts` | ~60 | 注入上游节点产物到下游 context |
| `modes/components/swarm/graph-view.ts` | ~200 | Mermaid-like ASCII DAG 渲染 |
| `.stp/graphs/builtin/theatre.graph.yaml` | ~80 | 内置三阶段图定义 |

### 修改
| 文件 | 改动 | 内容 |
|---|---|---|
| `agent-session.ts` | ~50行 | `#embeddedSwarm: ISwarmOrchestrator` |
| `interactive-mode.ts` | ~30行 | graph view 模式 + gate 面板 |
| `swarm-dashboard-overlay.ts` | ~40行 | 支持 graph view |
| `swarm-cli.ts` | ~40行 | `--engine=graph` flag |
| `settings-schema.ts` | ~20行 | `swarm.engine` 设置 |
| `state.ts` | ~20行 | `mode?: "graph"` 字段 |
| `experience.ts` | ~30行 | graph_name/node_id/task_hash 列 |
| `session/swarm-session-manager.ts` | ~20行 | GraphRunState entry type |
