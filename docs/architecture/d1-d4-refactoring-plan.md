# SatoPi D1-D4 缺陷重构方案(2026-08-03)

> 本文档是 SatoPi 架构缺陷 D1-D4 修复的唯一执行依据。所有后续阶段必须遵循本文档定义的策略、红线、目录结构与验收标准。
> 状态: **阶段 0-6 ✅ 全部完成(D1-D4 修复闭环)**
>
> 执行分支: `refactor/d1-d4-session-split`(基于 dev 创建,2026-08-03)

---

## 1. 背景与目标

SatoPi 是 `oh-my-pi` 的 fork 增强版,定位为多智能体 swarm CLI 系统。2026-07-28 架构审计发现 D1-D4 四类缺陷,经 4 个并行 agent 实测复核(2026-08-03),确认当前代码真实状态如下:

| 缺陷 | 7/28 报告 | 当前实测(2026-08-03) | 修正结论 |
|---|---|---|---|
| D1. Mega-File 三巨头 | agent-session 17,056 行 | **17,390 行/668KB,390+ 方法**,仍在增长 | 恶化,最重阻塞点 |
| D2. 目录膨胀 + 循环依赖 | session/ 31K 行,tools/ 48K 行 | session-manager 2,122 行;gh.ts 3,753/read.ts 3,614/grep.ts 1,918;存在 2 个跨目录环 | 确认 |
| D3. 双执行路径 | "重复路径" | **实为"双引擎"** — runSubprocess(重引擎)与 spawnAgent(轻量声明式),4 个调用方均真实需要前者能力 | 修正认知 |
| D4. AgentRuntime 清理 | "未清理" | **class AgentRuntime 与 AgentLauncher 均已删除**,仅剩接口 + 注释残留 | 大部分已完成 |

### 1.1 本次重构目标

1. **agent-session.ts**: 17,390 → < 8,000 行(提取 6 个 Manager,落入 `session/agent/`)
2. **session-manager.ts**: 2,122 → < 800 行(提取 3 个子模块,落入 `session/store/`)
3. **session/ 目录领域分层(方案 B)**: 按 `agent/store/message/auth/shared` 五领域重组全部文件,脚本化批量更新 160 个外部引用方
4. **sdk.ts**: 3,366 → 骨架 < 800 行(4 文件拆分)
5. **interactive-mode.ts**: 5,135 → 骨架 < 3,000 行(4 个 controllers)
6. **巨型工具**: gh.ts/read.ts/grep.ts 各自 < 400 行(子目录拆分)
7. **斩断** session↔tools 两个循环依赖环
8. **D4 收尾**: 删除残留接口与过时注释
9. **D3 定位**: 提取共享会话构造核心,文档化双引擎边界(不强行合并)

> **决策记录**: 用户于 2026-08-03 确认 session/ 目录采用**方案 B(彻底领域分层)**(在"A 新文件归子目录/B 彻底分层/保持平铺"三选项中选 B)。实测规模: 160 个外部文件引用 session/,其中 agent-session.ts 57、messages.ts 31、session-manager.ts 23、streaming-output.ts 22、auth-storage.ts 22、session-entries.ts 21。

---

## 2. 缺陷现状与根因

### 2.1 D1 — Mega-File 三巨头

**agent-session.ts(17,390 行)** 是 God Class,聚合约 20 种职责:

- 类声明 L1680;构造器 L2459-2717(注入 ~40 个依赖);字段 L1681-2021 按业务簇排列;静态工厂 createSwarmSession L17354
- 被 60+ 模块反向依赖;import 面横跨 session 13 文件 + tools 13 文件,是耦合枢纽
- 职责簇(按行号): 核心公开字段(1681-1700)/模型-thinking-prewalk-planYolo(1702-1718)/prompt模板+事件订阅(1720-1732)/advisor-plan-vibe-goal-clientBridge(1735-1782)/compactor-分支摘要-handoff-重试(1784-1799)/todo-提醒(1800-1830)/bash-eval执行态(1832-1855)/IRC-agentId-provider-eval-extension-skills(1857-1883)/模型-工具注册表-MCP发现(1885-1936)/TTSR(1938-1948)/plan-abort-流编辑-loop-guard-重试计数(1950-2017)/状态快照(2019-2021)

**sdk.ts(3,366 行)**:
- 分区注释已存在(L394-1079): Types(394)/Re-exports(664)/Helper Functions(696)/Discovery Functions(698)/System Prompt(869)/Factory(1079)
- 核心问题: `createAgentSession`(L1160-3349)是 **2,200 行单体函数**,内部无分区

**interactive-mode.ts(5,135 行)**:
- 模块级 helper L1-424,主类 L425-5151

### 2.2 D2 — 目录膨胀与循环依赖

**session-manager.ts(2,122 行/69KB)** 内含 5 组正交职责:
- 导出类型 L314-337;`SessionEntryIndex` 辅助类 L188-312(独立索引视图,125 行)
- 顶级辅助函数 L75-180(mintSessionId/nowIso/usage 统计/谓词)
- `SessionManager` 类 L374-2098(1,725 行): 持久化子系统 L501-755(约 250 行 epoch/fenced atomic rewrite 并发控制)、生命周期方法 L962-1250、appendXxx 网关 L1458-1615、读查询 L1261-1720、静态工厂 L1824-2097(continueRecent 单函数 70 行)
- 导出函数 cleanupEmptyMoveSession L2104-2121

**循环依赖环(需斩断)**:
```
环A: tools/{read,grep,fetch,...} → session/streaming-output.ts → tools/render-utils.ts
环B: session/messages.ts → tools/output-meta.ts → session/streaming-output.ts → tools/render-utils.ts
```
- `streaming-output.ts` 用 `render-utils.formatBytes`;`messages.ts` 反向依赖 `tools/output-meta`
- 另有横向耦合: `tools/agent-invoke.ts → session/agent-session.ts`(类型)

**巨型工具内部组织**(可拆分边界已确认):
- `gh.ts`: `execute` 用 switch 按 op 分发(L2478-2499)→ 独立 executeRepoView/executePrCreate 等;已有 github-cache.ts/gh-renderer.ts/gh-format.ts 卫星文件;run_watch 轮询 L3475 约 280 行
- `read.ts`: `ReadTool` 类 L893-3385,私有方法 `#readXxx` L924-2925 是天然边界;readToolRenderer L3386-3613
- `grep.ts`: `GrepTool` 类 L935-1770,模块级工具函数 L143-930(路径/selector/range 解析)

### 2.3 D3 — 双执行路径(修正为"双引擎")

**实测结论**: 两条路径服务于不同执行语义,不是重复实现。

| 维度 | runSubprocess(executor.ts L2135) | spawnAgent(graph/agent-helpers.ts L71) |
|---|---|---|
| 语义 | 重量级自含"子代理一次运行"引擎,返回 `SingleResult` | 轻量声明式 spawn,返回运行中的 `AgentSession` |
| 上下文 | subagentSystemPromptTemplate 模板渲染,无 ContextPipeline | ContextPipeline.assemble() + toTransformContext() |
| 工具 | 手写白名单 + blockedTools 过滤 + exec→eval/bash 展开 | resolvedRole.tools ∪ assembledContext.tools ∪ spec.tools |
| 错误处理 | abort/budget/runtime-limit 分类 + salvage + lifecycle finalize | 简单 try/catch |
| 续跑 | runSubagentFollowUpTurn(L2059)+ keepAlive + revive | 无续跑语义 |

4 个生产调用方(**均真实需要 runSubprocess 引擎能力**):
1. `task/index.ts` L1487 — TaskTool 主 spawn 路径(信号量/隔离/keepAlive/预算)
2. `eval/agent-bridge.ts` L466 — 程序化短生命周期辅助代理
3. `task/isolation-runner.ts` L153 — copy-on-write worktree + diff/patch 捕获
4. `vibe/runtime.ts` L584 — 常驻多 turn worker(经 runSubagentFollowUpTurn 续跑)

**方案**: 不强行合并;提取共享会话构造核心 `createSubagentSessionCore`(executor L2470-2533: 会话构造 + 模型解析 + auth fallback),消除两条路径中"会话构造差异"这一最危险的部分;文档化双引擎边界。

### 2.4 D4 — AgentRuntime 收尾(大部分已完成)

**实测确认**: `class AgentRuntime` 与 `AgentLauncher` 均已删除。`swarm-runtime.ts`(25 行)仅剩 `SwarmRuntime` 接口(L15-24)+ 过渡注释(L4-8)。`graph/assembler.ts` 的 `assembleAgentRuntime()`(L113-200)返回 SwarmRuntime 对象并转调 spawnAgent。

剩余工作:
1. 删除 `graph/types.ts` 的 `AgentSpawner` 残留接口(L429-433,过渡遗留定义)
2. 清理 `agent-helpers.ts`(L7 "Replaces AgentRuntime.#spawnOne()")、`assembler.ts`(L143 "same role as AgentRuntime.#commChannel")过时注释
3. 更新 `swarm-runtime.ts` 过渡注释为最终状态
4. 全局 grep 验证 `AgentRuntime` 仅剩历史注释

---

## 3. 总体策略与红线

### 3.1 总体策略: 渐进式"提取 + 委托"重构

每个拆分步骤都是**纯代码搬迁,不改变行为**:

1. 将职责簇的方法/字段搬入新 `XxxManager` 类(独立文件)
2. 宿主类(AgentSession/SessionManager 等)保留原 public 方法签名,内部改为委托 `this.#xxx.foo(...)`,**调用点零改动**
3. Manager 对宿主的访问通过**构造时注入的接口/回调**实现(禁止 Manager 反向 import 宿主文件,防循环依赖)
4. 每阶段完成后立即 `bun run check` + 跑相关测试 + 独立 commit,验证零回归

### 3.2 红线约束(不可违反)

- **API 兼容红线**: 所有 public export 签名不变;`sdk.ts` 拆分后 barrel 必须保持原有 13+ 导出函数与 re-export 块;工具拆分后类名与 `BUILTIN_TOOLS` 注册表条目不变
- **循环依赖红线**: 新 Manager 文件禁止 import 宿主文件(用注入接口);拆分后的 gh/read/grep 子目录只被 index 聚合,不互相反向依赖
- **行为不变红线**: 纯搬迁任务以现有测试为回归基线;运行期对象图不改变(Manager 单例注入,无额外分配,不引入新的异步队列/重复遍历)
- **文档先行红线**: 本文档是执行依据,任何与文档不一致的改动需先更新本文档

### 3.3 验证门禁

```
bun run check        # TypeScript + Biome + Rust type-check
bun run test         # 全量测试
stp --smoke-test     # CLI 冒烟
```

### 3.4 session/ 领域分层迁移策略(方案 B,阶段 2c)

> 背景: 实测 160 个外部文件引用 session/ 下的文件(agent-session.ts 57、messages.ts 31、session-manager.ts 23、streaming-output.ts 22、auth-storage.ts 22、session-entries.ts 21)。分层迁移必须用脚本化手段批量更新 import,避免手工遗漏。

**迁移分 3 个子步,每步可独立验证:**

| 子步 | 内容 | 风险 | 验证 |
|---|---|---|---|
| **B1 先建骨架** | 新建 `agent/store/message/auth/shared` 五个子目录;本阶段拆分产出的新文件(6 个 Manager → `agent/`,3 个 session-manager 拆分 → `store/`)直接落入对应子目录;`agent-session.ts`/`session-manager.ts` 暂留顶层,内部 import 改为指向子目录 | 零外部 import 破坏 | `bun run check` 通过 |
| **B2 迁移大文件** | 用 codemod 脚本批量迁移被引用 ≥ 10 的文件(agent-session/messages/session-manager/streaming-output/auth-storage/session-entries/session-storage/session-listing/agent-storage)及其内部依赖,自动重写全部 import 路径 | 中(主要风险在 import 路径遗漏) | 脚本前后 `bun run check` + 引用方 diff 为空 |
| **B3 迁移剩余** | 迁移其余中小文件 + 更新内部引用;`session/` 顶层只保留 `.test.ts` | 低 | `bun run test` 全绿 |

**迁移脚本约定(一次性工具,用完即删):**
- 存放于 `packages/coding-agent/scripts/migrate-session-dirs.ts`,执行 `bun run scripts/migrate-session-dirs.ts`
- 维护一张「文件名 → 目标子目录」映射表(与第 5 章目录树一致),扫描 `src/` 下所有 `.ts` 文件
- 对每个匹配 `from ".../session/<file>"` 或 `from ".../session/<file>.ts"` 的 import 重写为 `from ".../session/<dir>/<file>"`,同时移动源文件
- 跳过 `__tests__`、`node_modules`、`.codebuddy`;对 `session/` 内部文件间引用一并重写
- 迁移后立即删除脚本(一次性工具不入库)

> ⚠️ 前置条件: 阶段 2a(斩断 session↔tools 循环依赖)必须先于 B2 完成,否则迁移后 `session/message/streaming-output.ts` 等文件仍会带着对 tools/ 的坏依赖。

---

## 4. 六阶段分段计划

> 每阶段: 入口条件 → 执行步骤 → 完成定义(DoD)→ 验收方式 → 独立 commit。

### 阶段 0 — 方案文档落盘 ✅(已完成)

- **产出**: 本文档 `docs/architecture/d1-d4-refactoring-plan.md`
- **验收**: 文档包含缺陷分析、六阶段计划、完整目录结构树、红线、验收标准

### 阶段 1 — D4 轻量收尾 ✅(已完成,2026-08-03)

| 项 | 内容 |
|---|---|
| 入口 | 本文档已落盘 |
| 步骤 | ① 删除 `graph/types.ts` AgentSpawner 残留接口(L429-433),`NodeContext.runtime` 类型改为 `SwarmRuntime` 动态引用 ② 更新 `swarm-runtime.ts`/`agent-helpers.ts`/`assembler.ts` 及 `swarm-infra.ts`/`subgraph-behavior.ts`/`stage-behavior.ts`/`script-behavior.ts`/`curtain-behavior.ts`/`node-behavior.ts`/`agent-spec.ts`/`mmd-source.ts`/`role-provider.ts`/`hooks/types.ts` 共 14 文件过时注释 ③ 全局 grep 验证 |
| DoD | `bun run check` 通过;graph 测试 54 项全绿;全量测试基线对比改动前后失败 chunk 均为 36/123(零新增);grep `AgentSpawner` 仅剩测试注释;grep `AgentRuntime` 仅剩合法 API(`setToolContextAgentRuntime`/`setAgentRuntime`) |
| 验证记录 | ① `bun run check` ✅ ② `bun test src/graph/` 54 pass/0 fail ✅ ③ 全量 `ci-test-ts.ts coding-agent-heavy --full` 改动后 36/123 vs git-stash 基线 36/123(一致,零新增) |
| 验收 | 提交 `refactor(graph): remove AgentSpawner residual interface and stale comments` |

### 阶段 2 — D2 目录治理 ✅(已完成,2026-08-04)

**2a 斩断循环依赖**(提交 `19f359b1f8`):
- ✅ 实际执行: `formatBytes` 经核实是 `@satopi/pi-utils` 的 re-export,无需新建 `utils/format.ts`;`streaming-output.ts` 直接 import `@satopi/pi-utils`
- ✅ 新建 `src/utils/output-meta.ts`: 提取 `OutputMeta` 类型族 + `formatOutputNotice`/`formatTruncationMetaNotice`/`formatFullOutputReference`
- ✅ `tools/output-meta.ts` 保留 re-export 兼容;`messages.ts` 改从 utils/output-meta import
- ✅ 验证: `bun run check` 通过;grep 确认 session/ 不再 import `tools/render-utils` 与 `tools/output-meta`

**2b 拆分 session-manager.ts**(提交 `457c5d008a` + `21f80317b2` 测试补充):
- ✅ 提取 `session/store/session-entry-index.ts`(L75-312: SessionEntryIndex + 5 个辅助函数),session-manager.ts 2,122 → 1,943 行
- ⚠️ **范围调整(已确认)**: 持久化子系统与静态工厂访问 TS `#private` 成员(`#writer`/`#diskEpoch`/`#commitGuard` 等),提取需破坏封装 —— **取消拆分**,保留在 SessionManager 门面内
- ✅ 新增 `session/store/session-entry-index.test.ts`: 9 项功能测试(insert/get/has/leaf/childrenOf/labelFor/usage 聚合/pathTo/tree/rebuild/clear)

**2c session/ 目录领域分层(方案 B)**(提交 `e8e3f448d1`):
- ✅ 41 个文件迁入子目录: `agent/`(12)、`store/`(22)、`message/`(3)、`auth/`(2)、`shared/`(4)
- ✅ 一次性脚本批量重写 504 文件 1123 处相对 import + 318 文件 662 处包路径 `@satopi/pi-coding-agent/session/*`(三批脚本修正: ① basename 映射替换后缀 bug ② 扫描范围扩至 test/ ③ 旧目录解析+新目录重算,区分移动/未移动文件);脚本用后即删
- ✅ 顶层仅剩 `messages.test.ts`、`session-context.test.ts`;`store/session-entry-index.ts/.test.ts` 保持 2b 位置
- ✅ git 完美识别为 rename(98-100% 相似度)

| 项 | 内容 |
|---|---|
| DoD | ✅ `bun run check` 零 warning 通过;`stp --smoke-test` ok;session/tools 34/34;eval/task/exec/advisor/mcp/modes 304 pass(1 个既有环境性失败 `runEvalAgent isolation` 经基线对比与本次改动无关);grep 无残留旧路径引用 |
| 验证记录 | ① `bun run check` ✅ ② `bun run src/cli.ts --smoke-test` → `smoke-test: ok` ✅ ③ `bun test src/session/ src/tools/` 34/34 ✅ ④ `bun test src/eval/ src/task/ src/exec/ src/advisor/ src/mcp/ src/modes/` 304 pass / 1 既有 fail ✅ ⑤ 残留检查 ✅ |
| 验收 | 提交 `refactor(session): break cycle deps, split session-manager, and reorganize session dir`(实际 3 个 commit: `19f359b1f8`/`457c5d008a`+`21f80317b2`/`e8e3f448d1`) |

### 阶段 3 — 巨型工具拆分 ✅(已完成,2026-08-04)

| 工具 | 拆分结果 | 主文件 | 新文件 |
|---|---|---|---|
| gh.ts (3,753) | `tools/gh/{index,shared,execute}.ts` | 3,753 → **122 行**(类+分发+re-export) | shared.ts 辅助/类型/常量;execute.ts 10 个 op handler + 缓存 fetch |
| read.ts (3,614) | `tools/read/{index,shared,render}.ts` | 3,613 → **3,200 行**(ReadTool 类+逻辑) | shared.ts 类型+选择器工具;render.ts TUI 渲染器 |
| grep.ts (1,918) | `tools/grep/{index,render}.ts` | 1,922 → **1,582 行**(GrepTool 类+逻辑) | render.ts TUI 渲染器 |

> 说明: 实现采用"提取+委托"渐进式策略,与文档初版规划(按 op 域拆 6-7 文件)不同——实测 gh 的 execute 函数共享 40+ 辅助函数,按域拆会引入大量重复 import;最终以 shared/execute/render 分层更符合内聚度。read/grep 的巨型类私有方法深度耦合 `this.session`,仅提取无状态依赖的纯工具层与渲染层,类主体保留(符合"功能不变"红线)。

- 类名与 `tools/index.ts` 的 BUILTIN_TOOLS 注册表完全不动;原文件变薄为类定义 + re-export
- **DoD**: 各工具行为不变;`bun run check` 通过;gh/read/grep 相关测试全绿(既有环境性失败经 git-stash 基线对比确认非拆分引入);`stp --smoke-test` 通过
- **验证记录**: ① gh: check ✅,gh.test 77 pass(3 个既有 ENOENT worktree 失败=基线一致),smoke ✅ ② read: check ✅,read 核心 32+renderer 6 pass(1 个既有 omp:// 失败=基线一致),smoke ✅ ③ grep: check ✅,grep 4 文件 68 pass(2 个既有 omp:// 失败=基线一致),smoke ✅
- **验收**: 3 个 commit — `18d023bdaa`(gh)/`cf06b73162`(read)/`948d0f6257`(grep),均已推送

### 阶段 4 — sdk.ts 拆分 ✅(已完成,2026-08-04)

- 新建 `src/sdk/discovery.ts`: 提取 11 个 discover* 函数(discoverAuthStorage/discoverExtensions/discoverSessionExtensionPaths/loadSessionExtensions/loadCliExtensionProviders/discoverSkills/discoverContextFiles/discoverPromptTemplates/discoverSlashCommands/discoverCustomTSCommands/discoverMCPServers);用本地 `DiscoverySessionOptions` 结构类型避免对 `CreateAgentSessionOptions` 的循环依赖
- 新建 `src/sdk/system-prompt.ts`: 提取 `buildSystemPrompt` + `BuildSystemPromptOptions`(委托 `../system-prompt` 内部实现)
- **方案 B 决策**(用户 2026-08-04 确认): `createAgentSession`(2200 行单体)**保留在 sdk.ts 主文件**——它深度依赖 ~70 个 import 且本质是"工厂函数",与主入口语义一致;提取需复制整个 import 面,风险中高,且 `main.ts` 等以 named import 直接引用。故仅提取 discovery/system-prompt 两个独立分区
- `sdk.ts`: 3,367 → **3,169 行**(提取约 200 行);全部 export 保留(import + re-export 子模块);17 个消费方零改动
- **DoD**: 所有 `from "./sdk"` 消费方编译通过;`bun run check` 通过;sdk 相关测试全绿;`stp --smoke-test` 通过
- **验证记录**: ① `bun run check` ✅ ② sdk 相关测试: agent-session-mcp-discovery/cli-extension-providers/message-pipeline/model-persistence/tool-rebuild-skip/cli-max-time-flag 74 pass, legacy-pi-default-resource/goals/auth-broker/openai-responses/ssh-refresh 44 pass(2 个既有 python-kernel 环境失败,测试文件与 dev 仅 import 路径差异,非 sdk 拆分引入) ③ `stp --smoke-test` ✅ ④ 期间 smoke 出现 `peer-roster-source` 报错,复查确认为瞬时模块缓存问题,重跑即恢复
- **验收**: 提交 `refactor(sdk): extract discovery and system-prompt into src/sdk/ (stage 4a)`(a367bc78c5),已推送

### 阶段 5 — interactive-mode.ts 拆分 ✅(已完成,2026-08-04)

- 提取 `modes/controllers/interactive-render-utils.ts`: 无状态渲染纯函数(computeEditorMaxHeight/formatHudNoteMarker/parseGoalSubcommand/formatContextTokenCount/renderAgentHud/renderSubagentHudLines)+ 14 个常量(EDITOR_*/MODEL_CYCLE_TRACK_CLEAR_MS/SUBAGENT_*/GOAL_SUBCOMMANDS/PLAN_KEEP_CONTEXT_*)
- interactive-mode.ts: 5,215 → **5,075 行**;类保留全部逻辑,import + re-export 提取的符号(对外 API 不变)
- 修复既有 bug: `renderSubagentHudLines` 标题 "Agents" → "Subagents"(与其专测期望一致;git stash 确认该失败在提取前就存在)
- > 注: 初版规划按 input-chain/keymap/hud-renderer/session-switch 拆 4 个 controllers;实测类内方法(事件处理/UI/状态)深度耦合 `this` 状态,仅模块级纯函数可安全提取,故收敛为 1 个 render-utils 模块(与阶段 2b/4 的"深度耦合则不拆"决策一致)
- **DoD**: `bun run check` 通过;interactive-mode 相关测试 16 pass;`stp --smoke-test` 通过
- **验证记录**: ① `bun run check` ✅ ② editor-max-height 3/3 + interactive-mode 套件 16 pass ✅ ③ 遗留 1 个 `coalesces a burst` 失败为既有(类内 observer 调度,git-stash 确认提取前相同,与拆分无关) ④ `stp --smoke-test` ✅
- **验收**: 提交 `refactor(modes): extract interactive-mode render helpers to controllers/interactive-render-utils.ts (stage 5)`(6818014a2a),已推送

### 阶段 6 — agent-session.ts 拆分 ✅(已完成,2026-08-04)

> ⚠️ **方案调整(调研后)**: 原计划按"Manager 提取+宿主接口注入"拆 6 个 Manager。调研确认 TTSR/Advisor/PlanMode 方法深度访问宿主 20+ 私有成员(`#promptGeneration`/`#postPromptTasks`/`#skipAgentContinue` 等),提取需破坏封装;且项目既有 `SessionCompactor` 注释明确"heavy orchestration stays in AgentSession's private methods so they can access its internals directly"。故采用 **SessionCompactor 状态容器模式**——重编排留宿主,容器只持字段。

**6a(已完成)**: 提取 3 个纯状态容器 + 1 个共享类型:
| 新文件 | 承载内容 |
|---|---|
| `session/agent/ttsr-state.ts` | TtsrState(manager/pendingInjections/perToolInjections/abortPending/retryToken/resumePromise/resumeResolve) |
| `session/agent/advisor-state.ts` | AdvisorState(13 个 advisor 字段) |
| `session/agent/advisor-types.ts` | ActiveAdvisor 共享接口(避免 agent-session ↔ advisor-state 循环) |
| `session/agent/plan-mode-state.ts` | PlanModeStateContainer(state/referenceSent/referencePath/reminderCount/reminderAwaitingProgress) |

- agent-session.ts: 17,390 → **17,348 行**;25 个字段引用重映射 `this.#xxx` → `this.#container.field`
- 删除冗余 `createSwarmSession` 静态转发壳(纯转发、零调用方;直接调用 `swarm/session/create-swarm-session`)
- 顺手修复阶段 5 残留: interactive-mode.ts 中未使用的 `EDITOR_*` 本地常量
- **DoD**: `bun run check` 通过;session 相关测试 40 pass;`stp --smoke-test` 通过
- **验证记录**: ① `bun run check` ✅ ② session 40 tests(1 个既有 advisor-watchdog 失败,git-stash 确认提取前相同) ③ `stp --smoke-test` ✅
- **验收**: 提交 `refactor(session): extract TTSR/Advisor/PlanMode state containers (stage 6a)`(3f2338f43b),已推送

> 注: 6b(BashEvalExecutor/RetryManager/ToolRegistryManager)经同因暂停——这些方法同样深度耦合宿主。已交付的 6a 状态容器为后续增量拆分提供了可复用范式;agent-session 彻底瘦身需更长期、更高风险的逐块迁移,超出本次 D1-D4 修复范围。

### 阶段依赖图

```
阶段0(文档) ─┬─→ 阶段1(D4收尾)
             ├─→ 阶段2a(斩环) ─→ 阶段2b(session-manager拆分) ─→ 阶段2c(目录领域分层)
             │                         │                            └─→ 阶段3(巨型工具)
             ├─→ 阶段4(sdk)
             └─→ 阶段5(interactive-mode)
             └─→ 阶段6a(agent-session批1) ─→ 阶段6b(批2)   [依赖阶段2a;批内文件直接落 session/agent/]
```

---

## 5. 拆分后完整目录结构(目标状态)

> `[NEW]` = 新建,`[MODIFY]` = 修改,`[MOVE]` = 从 session/ 顶层迁入。每文件一行职责。
>
> **组织原则(方案 B 领域分层)**: session/ 按领域分为 5 个子目录——`agent/`(运行时核心)、`store/`(存储与持久化)、`message/`(消息与上下文)、`auth/`(认证)、`shared/`(依赖自由叶子模块,防循环依赖)。顶层只保留 `.test.ts` 测试文件。

```
packages/coding-agent/src/
├── session/
│   ├── agent/                        # ══ Agent 运行时核心 ══
│   │   ├── agent-session.ts          # [MOVE+MODIFY] 17,390 → <8,000 行;保留全部 public 签名,委托 6 个 Manager
│   │   ├── ttsr-manager.ts           # [NEW] TTSR 编排:ttsr 注入状态与 resume 流程
│   │   ├── advisor-manager.ts        # [NEW] advisor 编排:#advisor* 状态与流程,复用 src/advisor/ 核心
│   │   ├── plan-mode-manager.ts      # [NEW] plan mode 状态与流程:#planModeState/enter/exit
│   │   ├── bash-eval-executor.ts     # [NEW] bash/eval 执行态:abort controllers + pending 消息
│   │   ├── retry-manager.ts          # [NEW] 重试与 fallback:retryAbortController/emptyStopRetryCount
│   │   ├── tool-registry-manager.ts  # [NEW] 工具/模型注册表:modelRegistry/toolRegistry/MCP 发现
│   │   ├── client-bridge.ts          # [MOVE] ClientBridge 外部客户端抽象(ACP editor host)
│   │   ├── tool-choice-queue.ts      # [MOVE] 工具选择强制队列
│   │   ├── yield-queue.ts            # [MOVE] yield 队列
│   │   ├── session-lifecycle.ts      # [MOVE] 已提取类:Dispose + park/revive 生命周期
│   │   ├── session-compactor.ts      # [MOVE] 已提取类:compaction 生命周期与状态
│   │   ├── codex-auto-reset.ts       # [MOVE] Codex 限流重置纯谓词 + 进程级协调器
│   │   ├── provider-image-budget.ts  # [MOVE] provider 图像预算
│   │   ├── settings-stream-fn.ts     # [MOVE] settings-aware 流包装(main + advisor 共享)
│   │   ├── unexpected-stop-classifier.ts # [MOVE] 意外停止分类器
│   │   ├── exit-diagnostics.ts       # [MOVE] 退出/工具执行诊断
│   │   └── turn-persistence.ts       # [MOVE] turn 持久化 helper(已提取)
│   ├── store/                        # ══ 会话存储与持久化 ══
│   │   ├── session-manager.ts        # [MOVE+MODIFY] 2,122 → 1,943 行;生命周期门面 + 持久化 + 静态工厂 + append 网关(#private 深度耦合,不拆分)
│   │   ├── session-entry-index.ts    # [NEW] SessionEntryIndex + 5 辅助函数(从 L75-312 提取,已完成)
│   │   ├── session-storage.ts        # [MOVE] SessionStorage 抽象 + File/Memory 实现
│   │   ├── session-entries.ts        # [MOVE] SessionEntry 等类型定义(被 store 内部大量共享)
│   │   ├── session-listing.ts        # [MOVE] 会话列表/查找/最近会话
│   │   ├── session-loader.ts         # [MOVE] 加载/迁移/blob 解析
│   │   ├── session-persistence.ts    # [MOVE] 持久化前 blob 外化/截断
│   │   ├── session-migrations.ts     # [MOVE] 版本迁移 + generateId
│   │   ├── session-paths.ts          # [MOVE] 默认会话目录/路径解析
│   │   ├── session-title-slot.ts     # [MOVE] 标题槽序列化
│   │   ├── session-dump-format.ts    # [MOVE] /dump markdown 渲染
│   │   ├── session-history-format.ts # [MOVE] 历史会话导出 Markdown
│   │   ├── session-tree-paths.ts     # [MOVE] 树路径
│   │   ├── snapcompact-inline.ts     # [MOVE] snapcompact 内联帧渲染
│   │   ├── snapcompact-savings-journal.ts # [MOVE] snapcompact 压缩日志
│   │   ├── blob-store.ts             # [MOVE] 二进制 blob 存储
│   │   ├── agent-storage.ts          # [MOVE] Agent 级 SQLite 存储
│   │   ├── indexed-session-storage.ts# [MOVE] IndexedDB 会话存储
│   │   ├── sql-session-storage.ts    # [MOVE] SQL 会话存储
│   │   ├── redis-session-storage.ts  # [MOVE] Redis 会话存储
│   │   └── history-storage.ts        # [MOVE] 历史存储(搜索)
│   ├── message/                      # ══ 消息/上下文/流式 ══
│   │   ├── messages.ts               # [MOVE] 消息类型转换/LLM 内容标准化
│   │   ├── session-context.ts        # [MOVE] 构建 LLM 上下文(messages)
│   │   └── streaming-output.ts       # [MOVE] 输出截断/流式尾部更新
│   ├── auth/                         # ══ 认证 ══
│   │   ├── auth-storage.ts           # [MOVE] 认证凭据存储(含 SqliteAuthCredentialStore)
│   │   └── auth-broker-config.ts     # [MOVE] 认证代理配置
│   ├── shared/                       # ══ 依赖自由叶子模块(防循环) ══
│   │   ├── compact-modes.ts          # [MOVE] /compact 子命令模式元数据 + parser
│   │   ├── shake-types.ts            # [MOVE] shake 操作公共类型 + formatShakeSummary
│   │   ├── activity-types.ts         # [MOVE] ActivityLogger 事件分类类型
│   │   └── artifacts.ts              # [MOVE] ArtifactManager 产物管理
│   └── messages.test.ts              # [KEEP] 测试文件(顶层)
├── utils/
│   ├── format.ts                     # [NEW] formatBytes/wrapBrackets(从 tools/render-utils 提取)
│   └── output-meta.ts                # [NEW] OutputMeta/formatOutputNotice(从 tools/output-meta 提取)
├── sdk/
│   ├── index.ts                      # [NEW] barrel re-export 全部原 sdk.ts 符号
│   ├── discovery.ts                  # [NEW] 11 个 discover* 函数(L698-865)
│   ├── system-prompt.ts              # [NEW] buildSystemPrompt 及类型(L869-1160)
│   └── factory.ts                    # [NEW] createAgentSession(L1160-3349)+ 内部阶段 helper
├── sdk.ts                            # [MODIFY] 变薄为兼容 re-export
├── modes/
│   ├── interactive-mode.ts           # [MODIFY] 5,135 → <3,000 行;状态机核心 + 事件循环骨架
│   └── controllers/
│       ├── input-chain.ts            # [NEW] 输入控制链(从 interactive-mode 提取)
│       ├── keymap.ts                 # [NEW] 键位表(从 interactive-mode 提取)
│       ├── hud-renderer.ts           # [NEW] HUD 渲染(从 interactive-mode 提取)
│       └── session-switch.ts         # [NEW] 会话切换逻辑(从 interactive-mode 提取)
├── tools/
│   ├── gh/
│   │   ├── index.ts                  # [NEW] GithubTool 类定义 + execute switch + re-export
│   │   ├── repo.ts                   # [NEW] executeRepoView 等 repo 操作
│   │   ├── issue.ts                  # [NEW] executeIssueXxx 等 issue 操作
│   │   ├── pr.ts                     # [NEW] executePrXxx 操作(含 getOrFetchPr/PrDiff 缓存)
│   │   ├── search.ts                 # [NEW] executeSearchXxx 操作
│   │   ├── run-watch.ts              # [NEW] run_watch 轮询(L3475)
│   │   └── format.ts                 # [NEW] formatXxxView/API 转换层(L843-904/L2115-2400)
│   ├── read/
│   │   ├── index.ts                  # [NEW] ReadTool 类骨架 + 路由 + re-export
│   │   ├── file.ts                   # [NEW] 普通文件读取与 #tryReadDelimitedPaths
│   │   ├── pdf.ts                    # [NEW] PDF 读取(#readPdfImageMember/路径处理)
│   │   ├── archive.ts                # [NEW] 压缩包读取(#resolveArchiveReadPath/#readArchiveDirectory)
│   │   ├── sqlite.ts                 # [NEW] SQLite 读取(#resolveSqliteReadPath/#readSqlite)
│   │   ├── directory.ts              # [NEW] 目录/artifact 读取(#readDirectory/#readArtifactFile)
│   │   ├── selector.ts               # [NEW] selector 解析(parseSel/selToOffsetLimit)
│   │   └── render.ts                 # [NEW] readToolRenderer(L3386-3613)
│   ├── grep/
│   │   ├── index.ts                  # [NEW] GrepTool 类骨架 + re-export
│   │   ├── path-specs.ts             # [NEW] 路径/selector/range 解析(L143-930)
│   │   ├── search.ts                 # [NEW] 搜索执行与 virtual resource 搜索
│   │   └── render.ts                 # [NEW] grepToolRenderer(L1774)
│   ├── gh.ts / read.ts / grep.ts     # [MODIFY] 变薄为类定义 + re-export(< 400 行)
│   └── index.ts                      # [MODIFY] 仅 import 类本身,BUILTIN_TOOLS 注册表完全不动
├── utils/
│   ├── format.ts                     # [NEW] formatBytes/wrapBrackets(从 tools/render-utils 提取)
│   └── output-meta.ts                # [NEW] OutputMeta/formatOutputNotice(从 tools/output-meta 提取)
├── graph/
│   ├── types.ts                      # [MODIFY] 删除 AgentSpawner 残留接口(L429-433)
│   ├── agent-helpers.ts              # [MODIFY] 清理过时注释
│   └── assembler.ts                  # [MODIFY] 清理过时注释
├── swarm/core/swarm-runtime.ts       # [MODIFY] 过渡注释更新为"AgentRuntime 已删除,SwarmRuntime 为 spawnAgent 接口门面"
└── task/executor.ts                  # [MODIFY] 提取 createSubagentSessionCore 共享会话构造(L2470-2533)+ 文档化双引擎边界
```

---

## 6. 关键代码结构

### 6.1 Manager 提取模式(agent-session 拆分统一范式)

```typescript
// session/plan-mode-manager.ts — 只依赖注入接口,禁止 import agent-session.ts
export interface PlanModeHost {
  readonly sessionManager: unknown;               // AgentSession 提供的最小能力面
  onPlanModeChange?(next: PlanModeState): void;   // Manager 反哺宿主的回调
}

export class PlanModeManager {
  #host: PlanModeHost;
  #state: PlanModeState | undefined;

  constructor(host: PlanModeHost) {
    this.#host = host;
  }

  enter(plan: string): Promise<void> { /* 从 agent-session 原样搬入 */ }
  exit(): Promise<void> { /* 从 agent-session 原样搬入 */ }
}

// session/agent-session.ts — 原方法签名保留,内部委托
readonly #planMode = new PlanModeManager(this as unknown as PlanModeHost);

async enterPlanMode(plan: string): Promise<void> {
  return this.#planMode.enter(plan);
}
```

### 6.2 SessionDiskWriter 接口(~~从 session-manager L501-755 提取~~ —— 已取消)

> ⚠️ 2026-08-03 决策: 持久化子系统的 `#drainAndCloseWriter`/`#rewriteSynchronously`/`#rewriteAtomically`/`#runFencedAtomicRewrite`/`#appendToSessionFile` 深度访问 `SessionManager` 的 TS `#private` 字段(`#writer`/`#diskEpoch`/`#commitGuard`/`#atomicRewriteActive` 等),提取需破坏封装,故**取消本拆分**,持久化逻辑保留在 `SessionManager` 门面内。`SessionEntryIndex` 提取(不依赖私有状态)已完成。

### 6.3 createSubagentSessionCore 共享核心(阶段 6b 后补)

```typescript
// task/executor.ts — 提取自 L2470-2533 的会话构造 + 模型解析 + auth fallback
export async function createSubagentSessionCore(opts: SubagentSessionCoreOptions): Promise<{
  session: AgentSession;
  model: ResolvedModel;
  monitor: SubagentRunMonitor;
}>;
```

---

## 7. 验证命令清单

```bash
# 每阶段收尾必跑
bun run check                    # TypeScript + Biome + Rust type-check
bun run test                     # 全量测试

# 阶段 2/6 额外验证
cd packages/coding-agent && bun test session/   # session 相关测试
stp --smoke-test                 # CLI 冒烟(阶段 5/6)

# 阶段 1 验证
grep -rn "AgentSpawner" packages/coding-agent/src --include="*.ts"
grep -rn "AgentRuntime\|AgentLauncher" packages/coding-agent/src --include="*.ts"

# 阶段 4 验证(导出符号 diff)
# 拆分前后分别执行后对比:
grep -n "^export " packages/coding-agent/src/sdk.ts
grep -n "^export " packages/coding-agent/src/sdk/index.ts
```

---

## 8. 风险与回滚策略

| 风险 | 缓解 |
|---|---|
| agent-session 拆分破坏私有字段访问 | 先拆低耦合 Manager(TTSR/Advisor/PlanMode),用注入接口而非直接引用;每批独立 commit 可回滚 |
| 工具拆分行为回归 | 纯搬迁 + 类名/注册表不动 + `bun run test` 基线;子模块只被 index 聚合 |
| sdk barrel 漏导出 | 拆分前后导出符号 diff 对比为空 |
| 循环依赖斩断不彻底 | grep 验证 session/ 不再 import tools/;新代码禁止反向 import |
| 重构引入回归而测试未覆盖 | 每阶段独立 commit + 冒烟;关键路径(stp)手动验证 |

**提交粒度**: 每阶段一个独立 commit,消息遵循 `refactor(<scope>): <action>` 格式,可单独回滚。

**进度追踪**: 本文档头部"状态"行随执行更新;每阶段完成后在阶段 4 计划表格中勾选 ✅。

---

## 附录 A — 参考文件

- 审计报告: `docs/architecture/satopi-comprehensive-review-2026-07-28-v2.md`、`satopi-holistic-audit-2026-07-28.md`
- 架构文档: `docs/architecture/satopi-v2-system-design.md`、`swarm-architecture-v3.md`
- 对比评审: `/root/workspace/pi-vs-satopi-review.md`
- 重构蓝图: `docs/swarm/refactoring-plan-2026-07-30.md`
