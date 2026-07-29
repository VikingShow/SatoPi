# Swarm Profile 持久化 & 上下文卸载机制问题分析

> 分析日期: 2026-07-26  
> 范围: `packages/coding-agent/src/swarm/`  
> 关联文档: `docs/swarm-architecture-v3.md`（统一架构设计）

---

## 目录

1. [ProfileRegistry 持久化 Bug](#1-profileregistry-持久化-bug)
2. [上下文卸载机制问题](#2-上下文卸载机制问题)
3. [架构分层与生产未接入诊断](#3-架构分层与生产未接入诊断)
4. [修复优先级](#4-修复优先级)

---

## 1. ProfileRegistry 持久化 Bug

### 1.1 load/save 路径不一致

**文件**: `src/swarm/agent/agent-profile.ts`

```ts
// 第 502-512 行 — load
static async load(workspaceDir: string): Promise<ProfileRegistry> {
  const registry = new ProfileRegistry();
  try {
    const file = Bun.file(`${workspaceDir}/.swarm-workspace/profiles.json`);
    //                                                    ^^^^^^^^^^^^^^^^
    if (await file.exists()) {
      const data = await file.json();
      if (Array.isArray(data)) registry.deserialize(data);
    }
  } catch { /* first run — no profiles yet */ }
  return registry;
}

// 第 515-522 行 — save
async save(workspaceDir: string): Promise<void> {
  try {
    const path = `${workspaceDir}/profiles.json`;
    //                             ^^^^^^^^^^^^^^
    await Bun.write(path, JSON.stringify(this.serialize(), null, 2));
  } catch (err) {
    // Best-effort — never crash on persistence failure
  }
}
```

`workspaceDir` 由 `standalone.ts:51` 定义：

```ts
// standalone.ts:51
const WORKSPACE_DIR = path.resolve(process.cwd(), ".swarm-workspace");
```

**展开后的实际路径（以 `/home/user/project` 为例）**:

| 操作 | 解析路径 |
|---|---|
| `load(WORKSPACE_DIR)` | `/home/user/project/.swarm-workspace/.swarm-workspace/profiles.json` |
| `save(WORKSPACE_DIR)` | `/home/user/project/.swarm-workspace/profiles.json` |

**load 比 save 多了一层 `.swarm-workspace/`**，因为 load 在 `workspaceDir`（已包含 `.swarm-workspace/`）内部又拼接了 `.swarm-workspace/`。

**影响链**:

```
首次启动:
  ProfileRegistry.load(WORKSPACE_DIR)
    → Bun.file(".swarm-workspace/.swarm-workspace/profiles.json").exists()
    → false → 返回空 registry（无历史 profile）
  
  运行中 agent spawn:
    → getOrCreate({ profileId: "dev-agent", ... })
    → 创建新 profile（score=50 中性起步）
    → stage-controller 分配后 save()
    → 写入 .swarm-workspace/profiles.json ✅

第二次启动:
  ProfileRegistry.load(WORKSPACE_DIR)
    → Bun.file(".swarm-workspace/.swarm-workspace/profiles.json").exists()
    → false → 返回空 registry
    → 之前积累的信用分、违规历史、协作关系全部丢失 ❌
```

**调用 save 的所有位置**:

| 位置 | 文件 | 触发频率 |
|---|---|---|
| Agent 分配后 | `stage-controller.ts:210-211` | 每次 stage agent selection |
| API 手动触发 | `api-routes.ts:498-499` | 按需 |
| SIGINT/SIGTERM | `standalone.ts:456` | 进程退出时 |

每次 save 都写入正确的路径（外层），但 load 永远读不到。

**修复**: 将 load 路径与 save 对齐：

```patch
- const file = Bun.file(`${workspaceDir}/.swarm-workspace/profiles.json`);
+ const file = Bun.file(`${workspaceDir}/profiles.json`);
```

### 1.2 非原子写入

`save()` 直接 overwrite 目标文件：

```ts
// agent-profile.ts:517-518
const path = `${workspaceDir}/profiles.json`;
await Bun.write(path, JSON.stringify(this.serialize(), null, 2));
```

如果进程在 `Bun.write` 中途崩溃（OS kill、断电），`profiles.json` 可能被截断为不完整 JSON。下次 `load()` 时 `file.json()` 抛出解析异常，被 `catch {}` 吞掉，结果同样是返回空 registry → 全部 profile 丢失。

**对照**: `ExperienceStore`（同一 workspace 下的其他持久化组件）使用 **SQLite + WAL**，天然支持原子性和崩溃恢复。

**修复**:

```ts
const dir = workspaceDir;  // 已经是完整路径
const tmp = `${dir}/profiles.json.tmp`;
await Bun.write(tmp, JSON.stringify(this.serialize(), null, 2));
await fs.rename(tmp, `${dir}/profiles.json`);
```

`rename` 在同一文件系统内是原子的。

### 1.3 无 Schema 版本号

`AgentProfile` 接口没有 `version` 字段，`serialize()` 直接 `JSON.stringify` 整个对象图，`deserialize()` 直接做类型断言：

```ts
// agent-profile.ts:488-489
for (const snap of snapshots) {
  const p = snap as AgentProfile;
  // ...
}
```

如果 profile schema 演进（加字段、改名、改结构），旧 `profiles.json` 以不完整数据加载。例如未来加 `AgentProfile.credit.warnings: number` 字段后，旧 profile 中该字段为 `undefined`，运行时所有 `profile.credit.warnings` 访问都是 `undefined`，可能导致：
- 信用分排名的 `creditRankCache` key 不一致
- `getPromptContext()` 生成的 XML 中缺失字段

**建议**: `profiles.json` 顶层加 `version`，`deserialize` 按版本做 migration。

### 1.4 清理遗留 artifact

当前磁盘上存在两个 `profiles.json` 副本（bug 1.1 的副作用）：

```
.swarm-workspace/profiles.json             ← save 写入（正确）
.swarm-workspace/.swarm-workspace/          ← 嵌套目录（load 尝试读的位置）
  └── profiles.json                        ← 与上一层内容相同（巧合）
```

修复 1.1 后清理：

```sh
rm -rf .swarm-workspace/.swarm-workspace
```

---

## 2. 上下文卸载机制问题

### 2.1 架构总览

Swarm 中上下文管理设计为三层，但实现状态参差不齐：

```
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 1: ContextPipeline (context-manager/)                     │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Agent spawn 时按优先级注入上下文                              │ │
│ │                                                             │ │
│ │ Priority 0: role-source          — 角色 system prompt+tool  │ │
│ │ Priority 1: profile-source       — AgentProfile XML 块      │ │
│ │ Priority 2: experience-source    — ExperienceStore 经验      │ │
│ │ Priority 3: turn-guidance-source — 本轮转向指令              │ │
│ │ Priority 4: stigmergy-source     — MarkEnvironment 标记      │ │
│ │ Priority 5: offload-source       — 卸载 MMD+experience  ⚠   │ │
│ │ Priority 6: mnemopi-source       — 记忆召回命中              │ │
│ │ Priority 7: task-queue-source    — 待处理任务 DAG            │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ 状态: 完整实现 + 测试覆盖, 但 ⚠ 生产路径未接入 (见 §3)         │
└─────────────────────────────────────────────────────────────────┘
                            ↑ (v3 plan: injected)
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 2: HookPipeline (hook-system/)                            │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Agent 生命周期事件 → 触发副作用                               │ │
│ │                                                             │ │
│ │ Priority 0: profile-hook     — 信用分 CRUD                   │ │
│ │ Priority 1: stigmergy-hook   — 环境标记放置                  │ │
│ │ Priority 2: offload-hook     — L1 summarize + flush  ⚠       │ │
│ │ Priority 3: mnemopi-hook     — 记忆记录                       │ │
│ │ Priority 4: experience-hook  — 经验固化到 ExperienceStore    │ │
│ │ Priority 5: verification-hook — 输出验证                      │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ 状态: 已接入生产, 但 offload-hook 的 OffloadManager 为占位符   │
└─────────────────────────────────────────────────────────────────┘
                            ↑ 触发
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 3: ContextCompactor (context-manager/)                    │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Agent 内消息历史压缩                                          │ │
│ │                                                             │ │
│ │ OffloadToStigmergyStrategy (>80% budget) → stigmergy mark    │ │
│ │ SummarizeStrategy               (>90% budget) → summary 文本 │ │
│ │ TruncateStrategy                (>95% budget) → 截断丢弃     │ │
│ │                                                             │ │
│ │ ContextCompactor.createHook() — stub, handler 为空操作  ⚠    │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ 状态: 策略已实现, 但从未被触发（hook 是 stub）                   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 OffloadManager 在两个层面都是占位符

#### 2.2.1 Hook 层: offload-hook

`offload-hook.ts` 的 `OffloadManager` 接口：

```ts
// offload-hook.ts:26-31
export interface OffloadManager {
  /** Perform an L1 (lightweight) summarize for an agent's output. */
  summarizeL1(agentId: string, content: unknown): Promise<void>;
  /** Force-flush all pending offload data to persistent storage. */
  forceFlush(): Promise<void>;
}
```

这个接口只有两个方法签名，**没有实际实现类**。`createOffloadHook()` 接收这个接口并调用，但调用的是什么取决于调用者传入了什么。

**实际调用链** (`standalone.ts:316-320`):

```ts
const registeredHooks = registerBuiltinHooks(hookPipeline, {
  profileRegistry: shared.profileRegistry,
  markEnvironment,
  experienceStore: shared.experienceStore,
  // 注意: offloadManager 没有传入!
});
```

`register-builtins.ts:69-72` 的处理：

```ts
if (deps.offloadManager) {
  pipeline.register(createOffloadHook(deps.offloadManager));
  registered.push("offload-hook");
}
```

因为 `deps.offloadManager` 是 `undefined`，所以 **`offload-hook` 从未被注册到 HookPipeline**。

也就是说，以下事件发生时：

| 事件 | 预期行为 | 实际行为 |
|---|---|---|
| `agent:afterComplete` | `offloadManager.summarizeL1(agentId, payload)` | 无 hook 监听，空操作 |
| `workflow:beforePhase` | `offloadManager.forceFlush()` | 无 hook 监听，空操作 |
| `roundtable:afterRound` | `offloadManager.summarizeL1(agentId, payload)` | 无 hook 监听，空操作 |

打印日志中的 `registeredHooks` 为：`["profile-hook", "stigmergy-hook", "experience-hook"]`（三个 hook），缺少 `"offload-hook"`。

#### 2.2.2 Context 层: OffloadSource

`offload-source.ts` 的 OffloadManager 是另一个占位符接口：

```ts
// offload-source.ts:7-8
// OffloadManager does not exist yet — this source uses a placeholder interface.
// When OffloadManager is implemented, update the constructor to accept it.

// offload-source.ts:25-30
export interface OffloadManagerPlaceholder {
  getMmdContext?(agentId: string, taskDescription: string): Promise<string | null>;
  getExperienceContext?(agentId: string, taskDescription: string): Promise<string | null>;
}

// offload-source.ts:42
constructor(offloadManager: OffloadManagerPlaceholder | null = null) {
  this.#offloadManager = offloadManager;
}
```

两个问题：
1. 这个 `OffloadManagerPlaceholder` 接口与 `offload-hook.ts` 中的 `OffloadManager` 接口**完全不一样**（不同的方法名，不同的语义）——它们本应是同一个子系统，但定义了互不兼容的接口。
2. 构造时接受 `null`，`build()` 直接返回 `{}` —— **不注入任何卸载上下文**。

### 2.3 ContextCompactor 的 Hook 是 Stub

`context-compactor.ts` 定义了三种压缩策略（`SummarizeStrategy`、`TruncateStrategy`、`OffloadToStigmergyStrategy`），并有 `ContextCompactor` 聚合类：

```ts
// context-compactor.ts:127-166
export class ContextCompactor {
  private strategies: CompactionStrategy[] = [
    new OffloadToStigmergyStrategy(),  // >80% budget
    new SummarizeStrategy(),           // >90% budget
    new TruncateStrategy(),            // >95% budget
  ];

  async compactIfNeeded(messages: AgentMessage[], tokenBudget: number): Promise<CompactedContext> {
    // ... 按阈值尝试各策略
  }

  createHook() {
    return {
      name: "context-compactor",
      priority: 1,
      events: ["agent:beforeLaunch"],
      handler: async (event: string, payload: any) => {
        // This is a placeholder for future integration
      },
    };
  }
}
```

问题：
1. `compactIfNeeded()` 方法完整实现了压缩逻辑，但从**没有任何生产代码调用它**。
2. `createHook()` 返回一个 handler 为空的 hook —— 即使注册了也不会触发压缩。
3. 三种策略都依赖 token 计数（`tokensUsed > tokenBudget * threshold`），但没有地方实际传递 token 计数到这个 compactor。

### 2.4 Offload 链路的完整缺口

设计意图的完整卸载管道：

```
offload-hook (agent:afterComplete)
  → OffloadManager.summarizeL1()          ← 不存在
    → L2/L3 压缩                           ← 不存在
      → 存入 ExperienceStore / 其他存储      ← 不存在
        → offload-source.build()           ← 返回空（因 OffloadManager 未传入）
          → 注入 agent system prompt       ← 未注入
```

实际运行的唯一卸载相关路径：

```
experience-hook (curtain 阶段)
  → ExperienceStore (SQLite, 已实现)
    → experience-source.build() (priority 2)
      → 从 SQLite 读取历史经验
        → 注入 agent system prompt  ✅
```

**只有 experience-source 在工作**，且它直连 ExperienceStore，不经过任何卸载管道。这意味着：
- 卸载是**手动的**（curtain 阶段固化），而非**自动的**（基于 token 压力触发）
- 没有 L1/L2/L3 分层压缩
- 被卸载的内容不包含 MMD 架构图
- agent 的旧对话历史超过 token 预算时直接 truncate（由 satopi 底层处理），不会被结构化卸载

### 2.5 AgentProfile 信用分与上下文卸载无关联

`AgentProfile.credit.score` 用于两个地方：

**1. Agent 选择** (`agent-selector.ts:124-144`):

```ts
function computeAgentScore(profile, domainMatch, now): number {
  return (
    domainMatch * 0.4 +
    (profile.credit.score / 100) * 0.3 +    // ← 信用分影响选择权重
    computeRecency(profile.credit.lastActiveAt, now) * 0.15 +
    computeViolationPenalty(...) * 0.15
  );
}
```

**2. System prompt 注入标签** (`agent-profile.ts:397-424`):

```xml
<agent_profile id="bad-agent" score="18" archetype="implementer">
  ...
  ⚠ LOW CREDIT — behavior under heightened scrutiny
  🔒 RESTRICTED — 3+ violations on record, tool access may be limited
</agent_profile>
```

**信用分不影响**:
- 上下文卸载策略的选择（低分 agent 不会更激进地压缩）
- 可用的 token 预算大小
- 被卸载上下文保留的优先级
- 从 stigmergy 环境获取标记的权限

换句话说，`RESTRICTED` 标签只是文本提示，没有对应的工具访问控制或上下文限制实现。

---

## 3. 架构分层与生产未接入诊断

### 3.1 生产代码路径 vs v3 架构

`docs/swarm-architecture-v3.md` 定义了 6 层架构，其中 `ContextPipeline` 和 `AgentRuntime` 是核心组件。这些组件的**实现已完成且有测试覆盖**，但**未接入生产路径**。

**当前生产启动流程** (`standalone.ts`):

```
main()
  → ProfileRegistry.load(WORKSPACE_DIR)
  → ExperienceStore(WORKSPACE_DIR).init()
  → RoleAssetManager(WORKSPACE_DIR).init()
  → SessionRegistry.createSession(swarmName)
    → createSessionServices()
      → HookPipeline + registerBuiltinHooks()
      → SwarmRunManager(...)
          // 注意：没有 ContextPipeline，没有 AgentRuntime
  → SwarmRunManager.start()
    → createStageController(...)     ← 传统路径，直接调用 SubprocessAgentExecutor
      → stage.run()
```

**v3 设计路径** (未接入):

```
  → ContextPipeline (8 个 source 按 priority 注入)
    → AgentRuntime.spawn(AgentSpec)
      → AgentLauncher.launch()
        → AgentLoopConfig.transformContext  ← ContextPipeline 注入点
        → AgentLoopConfig.getSteeringMessages ← CommBus 注入点
```

关键对比：

| 组件 | 实现状态 | 测试 | 生产接入 |
|---|---|---|---|
| `ContextPipeline` | 完整 | `context-pipeline.test.ts` | ❌ 未接入 |
| `AgentRuntime` | 完整 | `agent-runtime.test.ts` | ❌ 未接入 |
| `AgentLauncher` | 完整 | 同上 | ❌ 未接入 |
| `AgentHandle` | 完整 | 同上 | ❌ 未接入 |
| `CommBus` | 完整 | 有测试 | ❌ 未接入 |
| `ContextCompactor` | 策略完整，hook stub | 无专门测试 | ❌ 未接入 |
| `OffloadManager` | 占位符接口 | — | ❌ 不存在 |
| `OffloadSource` | 占位符 | — | ❌ 不存在 |
| `ProfileRegistry` | 完整 | `agent-profile.test.ts` | ✅ 已接入 |
| `HookPipeline` | 完整 | `hook-pipeline.test.ts` | ✅ 已接入 |
| `StageController` | 完整（传统路径） | 集成测试 | ✅ 已接入 |

### 3.2 Agent 实际 spawn 路径

当前生产路径中，agent 实际通过 `StageController` → `SubprocessAgentExecutor` 启动子进程，而非 `AgentRuntime` → `AgentHandle`。这意味着：

- `AgentLoopConfig` 的 `transformContext`、`getSteeringMessages` 等 hook 点**不可达**
- `ContextPipeline` 的 8 个 source 的上下文注入**不会发生**
- `ProfileSource`（profile 上下文注入）虽然实现完整，但因为没有接入 `ContextPipeline`，**agent 实际收不到 `<agent_profile>` 块**

实际上 agent 获得的 system prompt 来自 `RoleAsset` YAML 文件 + `StageController` 手动拼接的 task description，不经过 `ContextPipeline`。

---

## 4. 修复优先级

| 优先级 | 问题 | 影响 | 修复方案 |
|---|---|---|---|
| **P0** | load/save 路径不一致 | 重启后所有 AgentProfile 丢失 | 改一行路径 |
| **P1** | 非原子写入 | 崩溃时 profiles.json 损坏 | tmp + rename |
| **P2** | v3 架构（ContextPipeline + AgentRuntime）未接入生产 | 8 种上下文源（profile、experience、stigmergy、offload...）不生效；agent 收不到信用分、经验、环境标记 | 将 `SwarmRunManager` 迁移到 `AgentRuntime` 路径 |
| **P3** | ContextCompactor hook stub | 长 agent 无上下文压缩，token 溢出 | 实现压缩触发逻辑，接入 satopi 的 `compact()`/`shouldCompact()` |
| **P4** | OffloadManager 两层占位符 | 无卸载上下文注入管道 | 实现 OffloadManager，统一 hook 层和 context 层的接口 |
| **P5** | Schema 版本号 | 未来 schema 迁移时数据丢失 | 加 `version` 字段 + migration |
