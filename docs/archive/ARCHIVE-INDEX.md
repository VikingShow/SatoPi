# 归档文档索引

> 归档日期: 2026-07-27
> 归档原因: 这些文档描述的项目状态已被后续 commits 实质性改变

---

## 已归档文档

| 文档 | 原日期 | 归档原因 |
|------|--------|---------|
| `satopi-architecture-analysis.md` | 2026-07-20 | 核心发现（AgentLoopConfig不可达、ContextCompactor冗余、MarkEnvironment未全局化、loop-controller.ts 67KB）已修复 |
| `satopi-architecture-final-report.md` | 2026-07-23 | 描述的架构组件已删除：swarm-gui（React+Zustand+SSE）、monitor server（Bun.serve+30 REST endpoints）、loop-controller.ts（67KB）、SwarmStateMachine 8 LOOP_PHASES |
| `satopi-comprehensive-research-2025-07-24.md` | 2025-07-24 | 一年前调研。swarm-gui、swarm-extension 已删除，三阶段生命周期已被 WorkflowFSM 取代 |
| `satopi-frontend-optimization-2025-07.md` | 2025-07 | swarm-gui 已于 2026-07 删除（commit 2247c6165） |
| `SatoPi前端长期战略优化方案.md` | 2026-07-17 | 以 swarm-gui 为核心的前端优化方案，swarm-gui 已删除 |
| `swarm-unified-architecture-refactor.md` | 2026-07-25 | 已合并入 swarm-architecture-v3.md，v3 已大部分实施 |
| `unified-workflow-architecture-design.md` | 2026-07-25 | 同上，被 swarm-architecture-v3.md 取代 |
| `satopi-architecture-debt.md` | 2026-07-20 | 5条债务中4条已改善/修复（DEBT-04静默失败仍存在） |
| `swarm-architecture-issues.md` | 2026-07-26 | 10个问题中8个已修复（ContextCompactor删除、Offload全局化、Profile offloadRefs、MarkEnvironment全局化等） |
| `L3-Offload-Template-Limitation.md` | — | L3截断问题已通过 offload/compact.ts LLM路径修复 |
| `satopi-offload-deep-dive.md` | 2026-07-20 | 描述旧 offload 架构（swarm/offload/），已重构到顶层 coding-agent/src/offload/ |

## 仍有效的文档（保留在 docs/）

| 文档 | 原因 |
|------|------|
| `swarm-architecture-v3.md` | v3 重构方案，已大部分实施完成 |
| `satopi-gap-analysis-breakthrough-path.md` | 范式级 Gap 分析（Cloner投票、Jaccard收敛、IRC vs Stigmergy）仍相关 |
| `satopi-v2-system-design.md` | Emergent Multi-Agent 五层架构设计，长期目标参考 |
| `satopi-phase4-5-design.md` | Phase 4&5 设计，部分已实施 |
| `SatoPi-strategic-roadmap.md` | 战略路线图 |

## 关键变更时间线

```
2026-07-20  架构调研 & 债务文档编写（5份文档）
2026-07-23  Gap分析 & v2 emergent架构设计（4份文档）
2026-07-25  Swarm v3 统一架构设计（3份文档合并）
2026-07-26  上下文管理系统调研 & 10问题清单
2026-07-26  → 实际实施开始 ←
            - Phase 1: HookPipeline + ContextPipeline + WorkflowFSM
            - Phase 2: CommBus + CommChannel
            - Phase 3: AgentRuntime + AgentHandle（绕过 runSubprocess）
            - Phase 4: PhaseBehavior + ContextCompactor 删除
            - Phase 5: MMD per-turn 注入 + L3 compact
            - Offload 从 swarm/ 移到顶层
            - MarkEnvironment 全局化 + auto-gated stigmergy
            - Profile offloadRefs + ProfileRegistry 全局化
            - swarm-gui 删除 + HTTP API 层删除
            - loop-controller.ts (67KB) 删除
            - omp → stp rebrand
2026-07-27  本归档
```
