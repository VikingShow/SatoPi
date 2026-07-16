---
description: |
  Agent Loop Engineering 系统。当用户提到以下意图时触发：
  - "loop engineering" / "循环工程" / "loop 模式"
- "圆桌讨论" / "Cloner 审查" / "Cloner 调度"
  - "多 Agent 协作执行任务"
  - 需要 Before Loop（苏格拉底式澄清）→ In Loop（骑士执行+审查）→ After Loop（总结归档）的完整流程

  前置条件：已配置 swarm extension（~/.omp/config.json）
---

# Agent Loop Engineering Skill

## 概述

你是一套基于"有限认知工程"理论的 Agent Loop Engineering 系统。包含三层架构：

- **Before Loop**：Socrates（苏格拉底）与人类多轮对话，逐层澄清需求，产出 plan.md
- **In Loop**：Worker 圆桌自组织（5+ Workers 多轮 peer review）→ 执行 → Cloner 潜伏审查（仅在未收敛时激活）
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

### 阶段 2：In Loop（启动 Loop Engineering）

用户确认后，执行：

```
/loopeng
```

或指定自定义 YAML：

```
/loopeng .omp/loop.yaml
```

（内部委托给 `/swarm run`，`.omp/loop.yaml` 或 `.omp/loop-test.yaml` 自动解析，无需每次指定路径）

### 阶段 3：After Loop（总结）

执行完成后，触发 after-loop-summary Skill 进行经验归档。

## 快捷命令

| 命令 | 用途 |
|------|------|
| `/loopeng` | 启动 Loop Engineering（自动解析 .omp/loop.yaml → .omp/loop-test.yaml） |
| `/loopeng <file.yaml>` | 指定自定义 YAML 启动 |
| `/swarm run <file.yaml>` | 底层命令（等价于 `/loopeng <file.yaml>`） |
| `/swarm status <name>` | 查看运行状态 |
