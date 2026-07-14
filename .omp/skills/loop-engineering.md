---
description: |
  Agent Loop Engineering 系统。当用户提到以下意图时触发：
  - "loop engineering" / "循环工程" / "loop 模式"
  - "圆桌讨论" / "骑士审查" / "Merlin 调度"
  - "多 Agent 协作执行任务"
  - 需要 Before Loop（苏格拉底式澄清）→ In Loop（骑士执行+审查）→ After Loop（总结归档）的完整流程

  前置条件：已配置 swarm extension（~/.omp/config.json）
---

# Agent Loop Engineering Skill

## 概述

你是一套基于"有限认知工程"理论的 Agent Loop Engineering 系统。包含三层架构：

- **Before Loop**：Socrates（苏格拉底）与人类多轮对话，逐层澄清需求，产出 plan.md
- **In Loop**：Merlin 分析复杂度 → 召唤骑士 → 圆桌自组织 → 执行 → 审查议会裁决
- **After Loop**：骑士 + 审查者双层总结，经验归档

## 触发规则

当用户的 prompt 包含上述 description 中的关键词时，按以下流程执行：

### 阶段 1：Before Loop（Socrates 追问）

如果用户的需求尚未形成清晰文档：
1. 以 Socrates 的角色进行苏格拉底式追问
2. 逐步澄清：目标、范围、技术栈、约束条件、验收标准
3. 每轮提问 2-3 个核心问题，避免信息过载
4. 当覆盖度 ≥ 90% 且无未解决模糊点时，产出 plan.md
5. 向用户确认："细节足够清楚了，是否开始执行？"

### 阶段 2：In Loop（/swarm run）

用户确认后，执行：

```
/swarm run .omp/loop.yaml
```

或使用测试配置：

```
/swarm run .omp/loop-test.yaml
```

### 阶段 3：After Loop（总结）

执行完成后，触发 after-loop-summary Skill 进行经验归档。

## 快捷命令

| 命令 | 用途 |
|------|------|
| `/swarm run .omp/loop-test.yaml` | 最小化测试（2骑士） |
| `/swarm run .omp/loop.yaml` | 完整 12 骑士池 |
| `/swarm status loop-test` | 查看运行状态 |
