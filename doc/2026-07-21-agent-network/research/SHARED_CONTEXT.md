# DES MCP Server 项目共享上下文

> 生成时间：2026-05-19  
> 来源：Session `1f85ce5c-b352-49f5-b144-6642bf4c3b83`（CLI 对话，61轮用户交互）

---

## 一、项目概述

**DES MCP Server** 是一个为企业数据工程平台（DES）构建的 AI 工具服务，通过 MCP (Model Context Protocol) 协议暴露 DES 平台的能力给 AI Agent（CodeBuddy IDE / claude-internal）。

### 核心目标
- 让 AI Agent 通过自然语言调用 DES 平台功能（工作流管理、数据质量、SQL 管理、告警等）
- 注册到 SA-Market 平台 → CodeBuddy IDE Marketplace → 用户一键安装使用

### 机器环境

| 机器 | IP | 用途 |
|------|-----|------|
| MCP Server 机 | 21.214.42.15 | des-mcp-server 运行、claude-internal 测试 |
| 测试机 | 21.91.96.45 | des-plugin-s0~sr 实验目录、des-codebuddy-plugin 源码 |
| DES 后端 | 21.6.204.139:8080 | DES 平台后端服务 |

### 仓库结构（21.214.42.15）

- `/root/workspace/des-mcp-server/` — MCP Server 主仓库（含 master 和 experiment 版本）
- `/root/workspace/des-codebuddy-plugin/` — CodeBuddy IDE 插件仓库
- `/root/workspace/data-engineering-services/` — DES 后端仓库

---

## 二、已完成的核心工作

### 1. 工具合并（204 → 45，↓78%）

将原始 204 个细粒度工具按业务域合并为 45 个粗粒度工具：

| 文件 | 合并前 | 合并后 | 工具名 |
|------|--------|--------|--------|
| WorkflowTool | 43 | 7 | workflow, workflow_version, workflow_grant, workflow_check, workflow_export, schedule, workflow_task |
| DqcTool | 38 | 6 | dqc_ruleset, dqc_rule, dqc_rule_instance, dqc_rule_version, dqc_task_instance, dqc_query |
| SpaceTool | 26 | 3 | space, space_member, user_group |
| DatasourceTool | 22 | 3 | sr_datasource, biz_datasource, metadata |
| StarRocksOpsTool | 22 | 13 | sr_blacklist, sr_cur_query, sr_dynamic_param, sr_mv_task, sr_audit + 8个sr_resource_group |
| GitTool | 15 | 3 | git_project, git_file, git_grant |
| ResourceTool | 14 | 2 | cluster, resource_group |
| ExecutionTool | 13 | 3 | execution, execution_task, external_execution |
| AlertTool | 7 | 1 | alert_config |
| 元工具 | 4 | 4 | des_search_tools, des_get_tool_doc, des_route_intent, des_confirm_action |

**合并方式**：单入口 + action 参数（CRUD 操作合并为1个工具）

```java
@Tool(name = "sr_blacklist",
      description = "StarRocks SQL 黑名单管理。"
          + "action=list: 查询黑名单列表（需 datasourceId）"
          + "action=create: 添加黑名单规则...")
public String srBlacklist(String action, String datasourceId, String id, ...) {
    switch (action) { ... }
}
```

**分支**：`feature/tool-consolidation-phase1`，commit `293cd97`

### 2. 两阶段架构设计

**核心思路**：用户输入 → 关键词匹配确定业务域 → 只暴露该域 8-18 个工具 → LLM 精确选择

#### 方案对比（已完成实验验证）

| 方案 | 思路 | 准确率 | 状态 |
|------|------|--------|------|
| A（原始） | 暴露全部204工具 | ~28.9% | 基线 |
| B（合并后全量） | 暴露全部45工具 | 测试中 | L2多步推理差（4次超时） |
| C（动态裁剪） | 按域只暴露2-18工具 | **100%**（小测试4/4） | ✅ 验证通过 |
| D（测试脚本侧裁剪） | 测试时按题目关键词动态设置allowedTools | 100% | 实验用 |

#### 方案 C 实现细节

初始设计是用 HTTP Header `X-Des-Domain` 过滤 `tools/list` 返回子集，但发现：
- CodeBuddy/claude-internal 的 MCP 客户端**不支持**动态修改 Header
- 改为 **URL Path / 元工具 `des_set_domain`** 方式

### 3. 实验系统

- 实验报告 v1：`/root/test-results/experiment_report_v1.md`
- 实验报告 v2：`/root/test-results/experiment_report_v2.md`（13章，6方案设计）
- 测试集：63题，覆盖 L1(直接映射) L2(多步) L3(参数推理) L4(歧义) L5(越界)
- 评测使用 claude-internal（因 CodeBuddy token 不足）

### 4. 关键实验结论

- 工具合并 + 动态裁剪组合效果极佳：只暴露 2-12 个工具时 100% 路由正确
- KV cache 限制：全量暴露 195+ 工具时 OOM，证明动态裁剪是必须的
- 写操作安全门正常：合并后 create action 仍触发 `des_confirm_action`
- 中文触发词生效："慢查询"→ sr_cur_query，"审计日志"→ sr_audit

---

## 三、SA-Market 对接方案（最新进展）

### 背景

SA-Market 是内部 MCP 服务注册平台，注册后服务出现在 CodeBuddy IDE Marketplace。

### 注册流程
```
DES开发者 → SA-Market 注册（填太湖token + 工具描述）
→ SA-Market 生成 MCP endpoint → 注册到太湖平台
→ 出现在 CodeBuddy IDE 的 MCP Marketplace 中
→ 用户安装后通过 iOA 认证鉴权
```

### 四种注册方案对比

| 方案 | 注册工具数 | Agent行为 | 问题 |
|------|-----------|----------|------|
| A：单一 execute | 1 | 需多步发现命令 | LLM 看不到细粒度语义 |
| B：45个独立工具 | 45 | 直接从 description 选择 | token 占用大，可能超限 |
| C：按域分组注册多服务 | 每服务8-18个 | 精准 | 用户需安装多个服务 |
| **D（推荐）：SA-Market API + 1个execute + 3内置命令** | 1 | list→help→execute | 兼容平台、体验可接受 |

### 方案 D（推荐的 SA-Market 适配方案）

在 DES 后端新增一个 Controller 适配 SA-Market 的 API 服务类型：

```
POST /api/ai/cli/execute
Body: { "command": "sr_blacklist", "args": {"action": "list", "datasourceId": "xxx"} }

内置命令：
  - list：返回所有可用命令
  - help：查看命令详情
  - suggestion：根据用户 prompt 推荐 top4 命令
```

**鉴权**：太湖 token 统一鉴权（注册时填入），DES 端不需要额外做鉴权。

**实现方式**：DES 后端新增 Controller，直接调用现有 Service，不需要独立 MCP Server。

---

## 四、待办任务 / 决策点

| # | 任务 | 状态 | 说明 |
|---|------|------|------|
| 1 | 方案 B 全量测试（63题） | 🔄 进行中 | 后台运行，L2 表现差（多次超时） |
| 2 | 方案 C 全量测试 | ✅ 已完成 | 动态裁剪效果好 |
| 3 | SA-Market 对接方案设计 | ✅ 方案确定 | 方案 D（API服务 + execute），待实现 |
| 4 | DES 后端新增 Controller | ⏳ 待执行 | 分支 `feature/git-build-diff-republish` 基础上新建 mcp 分支 |
| 5 | KM 经验文章 | 🔄 撰写中 | 不暴露项目名、有深度思考 |
| 6 | 评价机制优化 | ⏳ 待执行 | 之前的评判标准需优化 |

---

## 五、关键文档位置

| 文档 | 路径 |
|------|------|
| 工具合并变更日志 | `des-mcp-server/docs/tool-consolidation-changelog.md` |
| 两阶段架构设计 | `des-mcp-server/docs/two-stage-architecture-design.md` |
| 方案 C 设计 | `des-mcp-server/docs/plan-c-tools-list-filter-design.md` |
| 实验报告 v2 | `/root/test-results/experiment_report_v2.md` |
| 会话摘要 | `/root/session_summary_20260518.md` |

---

## 六、关键设计决策记录

1. **为什么不直接用 MCP Server？** → SA-Market 对接发现直接在 DES 后端加 Controller 更简单，不需要独立部署 MCP Server
2. **为什么要动态裁剪？** → 实验证明全量暴露 45+ 工具时 LLM 路由准确率显著下降，且有 KV cache OOM 风险
3. **为什么用 action 参数合并？** → CRUD 操作语义相近，合并后 token 占用大幅减少且不影响准确率
4. **鉴权为什么不自己做？** → SA-Market + 太湖平台统一鉴权，注册时填入 token 即可
5. **为什么用 claude-internal 测试？** → CodeBuddy token 额度不足，临时替代

---

## 七、DES 后端连接信息

```
地址: 21.6.204.139:8080
用户: root
密码: Wikishao888
端口: 36000 (SSH)
分支: local/dos-fix（当前已切换）
新分支: 基于 feature/git-build-diff-republish 新建 mcp 分支
```
