# SatoPi Swarm 长期规划方案（最终版）

> 基于 2026-07-27 代码审查 + 用户决策确认

## 用户决策

| 决策点 | 选择 | 影响 |
|--------|------|------|
| 交互界面 | CLI + TUI | 保留 `swarm-dashboard.ts`，ActivityLogger 保留回调机制供 TUI 订阅，删除 SSE/Web 相关死代码 |
| Script 阶段 | 本轮实现 | 实现 `stp swarm plan` 命令，修复 ScriptManager 语法错误 |
| IRC Bus | CLI 也需要 | CLI 模式创建 in-process IRC bus，Agent 间直接通信 + MarkEnvironment 间接通信 |
| 长期能力 | Agent 重试 + Fsm 验证 | 不做预算管理（satopi 已有 deadline + token tracking）；不做分布式扩展 |

## 预算管理说明

satopi 已有：
- **时间截止**：`AgentLoopConfig.deadline`（到时间点自动 abort）
- **用量追踪**：telemetry 的 `ChatUsageEvent` / `CostDelta`（每次 chat step 记录 token/cost）
- **速率限制**：Settings 中的 provider request limits

satopi **没有**：预算强制执行（"花完 $X 就停"）。但用户决策不做此能力，deadline 已足够防止运行失控。

---

## 架构目标

```
                    ┌──────────────────────────────────────────────────┐
                    │              SwarmServices (assembler)            │
                    │  统一装配所有服务，单一入口                         │
                    └──────────────┬───────────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
     ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
     │  Script 阶段     │ │  Stage 阶段      │ │  Curtain 阶段   │
     │  ScriptManager   │ │  StageController │ │  CurtainRunner  │
     │  (CLI 可交互)    │ │  (AgentRuntime)  │ │  (Reflection)    │
     └────────┬────────┘ └────────┬────────┘ └────────┬────────┘
              │                    │                    │
              ▼                    ▼                    ▼
     ┌──────────────────────────────────────────────────────────────┐
     │                    AgentRuntime (唯一 spawn 入口)              │
     │  spawn() → RoleProvider → ContextPipeline → AgentLauncher     │
     └───────────────────────────┬──────────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────────┐
              ▼                  ▼                      ▼
     ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
     │ Agent (进程内) │  │ CommBus + IRC     │  │ HookPipeline     │
     │ pi-agent-core │  │ Agent↔Agent 通信  │  │ 生命周期事件      │
     └──────────────┘  └──────────────────┘  └──────────────────┘
                                 │
              ┌──────────────────┼──────────────────────┐
              ▼                  ▼                      ▼
     ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
     │ OffloadMgr   │  │ MarkEnvironment  │  │ ProfileRegistry  │
     │ 上下文卸载    │  │ Stigmergic 信号  │  │ 持久化 Agent 身份 │
     └──────────────┘  └──────────────────┘  └──────────────────┘
```

### 核心原则

1. **单一执行路径**：AgentRuntime.spawn() 是唯一 spawn 入口，删除 SubprocessAgentExecutor
2. **依赖注入**：所有服务通过 SwarmServices 装配，无全局单例（MarkEnvironment 改为 per-session）
3. **三阶段完整可用**：Script（CLI 交互式）→ Stage（AgentRuntime 驱动）→ Curtain（反思 + 经验提取）
4. **TUI 实时渲染**：保留 swarm-dashboard.ts，ActivityLogger 回调驱动 TUI 更新
5. **IRC 必需**：CLI 模式也创建 in-process IRC bus
6. **不改基础库**：不改 satopi，不改 loop.yaml 格式，不影响单 Agent 模式

---

## Phase 1: 死代码清理 & 引用修复 [低风险]

### 1.1 修复 benchmark 的 broken imports
**文件**: `benchmarks/in-loop-runner.ts`
- `from "../packages/coding-agent/src/swarm/schema"` → `from "../packages/coding-agent/src/swarm/core/schema"`
- `from "../packages/coding-agent/src/swarm/state"` → `from "../packages/coding-agent/src/swarm/core/state"`
- `LoopController` → `SwarmRunner`，`LoopResult` → `StageResult`

### 1.2 清理 LoopController 残留引用（注释 + JSDoc）
**文件**: 约 10 个文件中的注释引用，改为 SwarmRunner/StageController

### 1.3 删除 AgentLauncher mock stub 回退路径
**文件**: `packages/coding-agent/src/swarm/agent-runtime/agent-launcher.ts`
- 删除 `#resolveToolInstances()` 中的 Path C（mock stubs，~line 442-463）
- 改为：无 `builtinToolNames` 时抛出明确错误

### 1.4 MarkEnvironment 去全局化
**文件**: `packages/coding-agent/src/coordination/mark-environment.ts`
- 删除 `static #global`、`static global()`、`static resetGlobalForTests()`
- 保留实例方法不变
- 更新所有 `MarkEnvironment.global()` 调用点为注入实例

### 1.5 删除 SSE/Web 死代码
**文件**:
- `packages/coding-agent/src/swarm/core/state.ts` — 删除 `#onStateChange` 和 `setStateChangeNotifier()`（从未被调用）
- `packages/coding-agent/src/swarm/hooks/activity-logger.ts` — JSDoc 移除"Pushed to MonitorServer via SSE"描述，改为"TUI callback + session.jsonl 双写"
- 保留 ActivityLogger 的回调机制（TUI 需要订阅）

### 1.6 删除 collab-web 中的 swarm 残留（如有）
**文件**: `packages/collab-web/src/`
- 如果没有 swarm 专用组件（确认无 Topology/PhasePipeline），则无需改动
- 如果 app.tsx 有 swarm 相关 import，清理

---

## Phase 2: 修复 ScriptManager + 实现 Script CLI [高风险]

### 2.1 修复 ScriptManager 语法错误
**文件**: `packages/coding-agent/src/swarm/script/script-manager.ts`

当前 `#runPlannerAgent()` 的 line 303-348 有语法错误（孤悬 else + 未声明 agentDef）。

修复方案：删除 dead else 分支，统一为 v3 路径：
```typescript
async #runPlannerAgent(): Promise<void> {
    this.#busy = true;
    const msgId = `planner-${Date.now()}`;

    try {
        const taskText = this.#buildTaskFromHistory();
        const loopConfig = await this.#readLoopConfig();
        const plannerRole = await this.#resolvePlannerRole();

        if (!this.#runtime) {
            throw new Error("AgentRuntime is required. Call setRuntime() before starting the planner.");
        }

        const [planner] = await this.#runtime.spawn([{
            id: this.#selectedAgentId ?? "planner",
            role: "planner",
            roleSource: plannerRole ? "library" : "inline",
            inline: !plannerRole ? {
                systemPrompt: this.#buildPlannerSystemPrompt(null),
                tools: ["write", "read", "grep", "glob", "bash"],
            } : undefined,
            task: taskText,
            modelPreference: "smartest",
        }]);

        const result = await planner.wait();
        const displayOutput = (result?.output ?? result) ?? "(no output)";

        // ... 后续逻辑不变（解析 Recommended/Estimated，更新 conversation，检查 plan.md mtime）
    } catch (err) { ... }
    finally { this.#busy = false; }
}
```

### 2.2 实现 `stp swarm plan` CLI 命令
**文件**: `packages/coding-agent/src/cli/swarm-cli.ts`

在 `runSwarmCommand()` 中添加 `plan` action 的真实实现（替换当前的 placeholder）：

```typescript
case "plan":
    return runSwarmPlan(cmd);
```

`runSwarmPlan()` 实现交互式规划：
1. 读取 loop.yaml 获取 swarm name + workspace
2. 调用 `assembleSwarmServices()` 装配服务（Phase 3）
3. 创建 ScriptManager 并注入 AgentRuntime
4. 启动 TUI 仪表盘（swarm-dashboard.ts）
5. 进入交互循环：
   - 用户输入 task → `scriptManager.start(task)`
   - 用户追加消息 → `scriptManager.sendMessage(text)`
   - 用户发起辩论 → `scriptManager.runDebate()`
   - 用户确认 → `scriptManager.confirm()` → 自动转入 Stage
6. Stage 完成后自动进入 Curtain

**交互方式**：
- 使用 readline 或 inquirer 实现 CLI 交互
- TUI 仪表盘通过 ActivityLogger 回调实时更新
- plan.md 内容通过文件监听（fs.watch）在 TUI 中展示

### 2.3 实现 `stp swarm run` 直通模式
**文件**: `packages/coding-agent/src/cli/swarm-cli.ts`

`run` action 跳过 Script 交互，直接读 plan.md → Stage → Curtain：
1. 如果没有 plan.md → 提示用户先 `stp swarm plan`
2. 如果有 plan.md → 直接 `assembleSwarmServices()` + `SwarmRunner.start()`

### 2.4 TUI 仪表盘集成
**文件**: `packages/coding-agent/src/swarm/tui/swarm-dashboard.ts`

确保 TUI 能订阅 ActivityLogger 事件：
```typescript
activityLogger.setCallback((entry: ActivityEntry) => {
    dashboard.handleActivity(entry);
});
```

TUI 显示内容：
- 当前 Phase（script / stage / curtain）
- Agent 列表 + 状态（pending / running / completed / failed）
- Task Queue 进度（total / completed / in-progress / blocked）
- 实时输出流（stream_delta / stream_end）
- Plan.md 内容预览（Script 阶段）

---

## Phase 3: 统一执行路径 — 接入 AgentRuntime v3 [高风险]

### 3.1 创建 SwarmServices 统一装配函数
**新文件**: `packages/coding-agent/src/swarm/core/assembler.ts`

```typescript
export interface SwarmServices {
    modelRegistry: ModelRegistry;
    settings: Settings;
    stateTracker: StateTracker;
    activityLogger: ActivityLogger;
    experienceStore: ExperienceStore;
    profileRegistry: ProfileRegistry;
    markEnvironment: MarkEnvironment;  // per-session 实例
    roleAssetManager: RoleAssetManager;
    hookPipeline: HookPipeline;
    fsm: WorkflowFsm;
    runtime: AgentRuntime;           // v3: 必须创建
    contextPipeline: ContextPipeline;
    commBus: CommBus;
    ircBus: IrcBus;                  // CLI 模式也创建 in-process IRC
    offloadManager: IOffloadManager;  // 真实 OffloadManager（非 Noop）
}

export async function assembleSwarmServices(opts: {
    workspace: string;
    yamlPath: string;
    authStorage: AuthStorage;
    swarmName: string;
}): Promise<SwarmServices> {
    // 1. 基础服务
    const settings = await Settings.init({ cwd: opts.workspace });
    const modelRegistry = new ModelRegistry(opts.authStorage);
    await modelRegistry.refresh("online-if-uncached");

    // 2. 持久化层
    const experienceStore = new ExperienceStore(opts.workspace);
    await experienceStore.init();
    const profileRegistry = ProfileRegistry.global();  // Profile 跨 session 共享是合理的
    const roleAssetManager = new RoleAssetManager(opts.workspace);
    await roleAssetManager.init();

    // 3. 协调层（per-session 实例）
    const markEnvironment = new MarkEnvironment();  // 非 global()

    // 4. IRC Bus（CLI 模式也创建 in-process）
    const ircBus = createInProcessIrcBus();

    // 5. CommBus
    const activityLogger = new ActivityLogger(swarmDir, opts.swarmName);
    const commBus = new CommBus(ircBus, activityLogger);

    // 6. StateTracker + FSM
    const stateTracker = new StateTracker(opts.workspace, opts.swarmName);
    const fsm = new WorkflowFsm(stateTracker, activityLogger, "idle");
    for (const def of PHASES) fsm.registerPhase(def);

    // 7. HookPipeline + OffloadManager
    const offloadManager = new OffloadManager(opts.workspace, opts.swarmName, opts.swarmName, storage);
    const hookPipeline = new HookPipeline();
    registerBuiltinHooks(hookPipeline, { offloadManager, profileRegistry });

    // 8. AgentRuntime v3
    const contextPipeline = new ContextPipeline();
    // 注册 sources: StigmergySource(markEnvironment), ProfileSource(profileRegistry),
    //              OffloadSource(offloadManager), ModeSource(loopConfig)
    contextPipeline.register(new StigmergyContextSource(markEnvironment));
    contextPipeline.register(new ProfileContextSource(profileRegistry));
    contextPipeline.register(new OffloadContextSource(offloadManager));

    const roleProvider = new RoleProvider(roleAssetManager);
    const launcher = new AgentLauncher(modelRegistry, settings, activityLogger);
    const runtime = new AgentRuntime({
        roleProvider, contextPipeline, launcher, commBus,
        hookPipeline, modelRegistry, settings, activityLogger,
    });

    return { ... };
}
```

### 3.2 简化 swarm-cli.ts
**文件**: `packages/coding-agent/src/cli/swarm-cli.ts`

`runSwarmRun()` 和 `runSwarmPlan()` 都简化为：
```typescript
const services = await assembleSwarmServices({ workspace: cwd, yamlPath, authStorage, swarmName });
const runner = new SwarmRunner({
    ...services,
    workspace: cwd,
    yamlPath,
    sessionManager: undefined,  // CLI 模式不持久化 session
});
await runner.start();
await runner.waitForCompletion();
```

### 3.3 StageController 移除 legacy 路径
**文件**: `packages/coding-agent/src/swarm/stage/stage-controller.ts`

- 删除 `#runAgent()` 中的 `else` legacy `streamAgentOutput()` 分支
- 删除 `import { streamAgentOutput }`
- 删除 `import { SubprocessAgentExecutor }`
- `#runtime` 从可选变为必须（constructor 断言）
- 修复 v3 路径的指标丢失：AgentHandle.wait() 返回真实 tokens/requests/durationMs

### 3.4 修复 StageController v3 路径指标
**文件**: `packages/coding-agent/src/swarm/agent-runtime/agent-handle.ts`

当前 `wait()` 返回的结果不包含 tokens/requests/durationMs。需要：
- Agent 完成后从 telemetry 提取累计 token usage
- 计算总 durationMs（从 spawn 到完成）
- 记录 API request count

### 3.5 删除 SubprocessAgentExecutor
**文件**: `packages/coding-agent/src/swarm/executor/executor.ts`
- 保留 `AgentExecutor` 接口（扩展点）
- 删除 `SubprocessAgentExecutor` 类
- 删除 `executeSwarmAgent()` 函数

### 3.6 实现 spawnRoundtable() 基础版本
**文件**: `packages/coding-agent/src/swarm/agent-runtime/index.ts`

替换空桩：
```typescript
async spawnRoundtable(specs: AgentSpec[], config: RoundtableConfig): Promise<RoundtableResult> {
    const handles = await this.spawn(specs);
    const responses: string[] = [];

    for (let round = 0; round < config.rounds; round++) {
        const roundResponses: string[] = [];
        for (let i = 0; i < handles.length; i++) {
            const result = await handles[i].wait();
            roundResponses.push((result?.output ?? String(result)) ?? "");
        }
        responses.push(...roundResponses);

        // 收敛检测（Jaccard 相似度）
        if (config.convergenceThreshold) {
            const sim = computeJaccard(roundResponses);
            if (sim > config.convergenceThreshold) {
                return { converged: true, rounds: round + 1, responses, finalPositions: roundResponses };
            }
        }
    }

    return { converged: false, rounds: config.rounds, responses, finalPositions: responses.slice(-specs.length) };
}
```

---

## Phase 4: IRC Bus CLI 集成 [中风险]

### 4.1 创建 in-process IRC Bus
**新文件**: `packages/coding-agent/src/swarm/comm-bus/in-process-irc.ts`

satopi 的 IrcBus 接口需要适配。CLI 模式下创建一个 in-process 实现：
```typescript
export function createInProcessIrcBus(): IrcBus {
    // 基于 EventEmitter 的 in-process IRC
    // 支持频道创建、消息广播、投票等
    // 不需要网络连接，纯内存
}
```

### 4.2 CommBus 适配
**文件**: `packages/coding-agent/src/swarm/comm-bus/comm-bus.ts`

确保 CommBus 在有 IrcBus 时使用 IRC，无 IrcBus 时降级为内存队列。当前代码已经有部分降级逻辑，需验证完整性。

### 4.3 StageController 角色协商接入 IRC
**文件**: `packages/coding-agent/src/swarm/stage/stage-controller.ts`

当前 `#assignRoles()` 中有 TODO（line 324-326）表示需要 roundtable 但未实现。接入 IRC 后：
```typescript
if (ircBus) {
    const channel = commBus.groupChannel("role-negotiation", candidates.map(c => c.agentId));
    // 发起角色协商，等待 agent 响应
    const assignments = await channel.negotiate(candidates, availableRoles);
    if (assignments) return assignments;
}
// 降级为算法分配
```

---

## Phase 5: Agent 重试与恢复 [中风险]

### 5.1 Task 重试机制
**文件**: `packages/coding-agent/src/swarm/executor/task-queue.ts`

```typescript
export interface Task {
    // ... existing fields
    retryCount?: number;
    maxRetries?: number;  // 默认 2
    lastError?: string;
    failedAt?: number;
}

// claim() 失败后，如果 retryCount < maxRetries，重新入队 ready
// 而非直接 block
complete(taskId: string): void { ... }
block(taskId: string, reason: string): void {
    const task = this.#tasks.get(taskId);
    if (task.retryCount < (task.maxRetries ?? 2)) {
        task.retryCount++;
        task.status = "ready";  // 重新入队
        task.lastError = reason;
        task.failedAt = Date.now();
    } else {
        task.status = "blocked";  // 超过重试次数
    }
}
```

### 5.2 超时 task 自动回放
**文件**: `packages/coding-agent/src/swarm/stage/stage-controller.ts`

在 `#runAgent()` 的 while 循环中添加超时检测：
```typescript
const CLAIM_TIMEOUT_MS = 300_000;  // 5 分钟

while (!signal?.aborted && !queue.isAllComplete) {
    const claim = queue.claim(agent.id, agent.role);
    if (!claim.ok) {
        // 检查 in-progress tasks 是否超时
        const stuck = queue.findStuckTasks(CLAIM_TIMEOUT_MS);
        for (const task of stuck) {
            queue.requeue(task.id);  // 超时 task 重新入队
            activityLogger.logBroadcast("system", `Task ${task.id} timed out, requeued`);
        }
        // ... existing deadlock detection
    }
}
```

### 5.3 Agent 级别错误恢复
**文件**: `packages/coding-agent/src/swarm/agent-runtime/agent-handle.ts`

Agent 崩溃后（非正常退出）：
- 记录错误到 ProfileRegistry（影响信用分）
- 释放该 Agent 持有的所有 RegionLock
- 清理 MarkEnvironment 中该 Agent 的 claim marks
- 通知 TaskQueue 该 Agent 的 in-progress tasks 重新入队

---

## Phase 6: WorkflowFsm 形式化验证 [低风险]

### 6.1 定义状态不变量
**新文件**: `packages/coding-agent/src/swarm/core/fsm-invariants.ts`

```typescript
/** 状态机不变量验证规则 */
export const FSM_INVARIANTS = {
    // 死锁检测：所有非终态都能到达 idle
    noDeadlock: (fsm: WorkflowFsm): boolean => {
        const reachable = bfsReachable(fsm, "idle");
        return reachable.has("idle");  // idle 是终态
    },

    // 活锁检测：不存在 A→B→A 的无限循环
    noLivelock: (fsm: WorkflowFsm): boolean => {
        return !hasTwoCycle(fsm);  // 无二元环
    },

    // 可达性：所有已注册状态都是可达的
    allReachable: (fsm: WorkflowFsm): boolean => {
        const reachable = bfsReachable(fsm, "idle");
        return fsm.allStates().every(s => reachable.has(s));
    },

    // 前置条件：每个 transition 的 guard 不自相矛盾
    validGuards: (fsm: WorkflowFsm): boolean => {
        return fsm.allTransitions().every(t => t.guard !== undefined);
    },
};
```

### 6.2 运行时不变量检查
**文件**: `packages/coding-agent/src/swarm/core/workflow-fsm.ts`

在 `registerPhase()` 后自动运行不变量检查：
```typescript
registerPhase(def: PhaseDef): void {
    // ... existing registration
    if (process.env.NODE_ENV !== "production") {
        const violations = checkInvariants(this);
        if (violations.length > 0) {
            logger.warn("[FSM] Invariant violations", { violations });
        }
    }
}
```

### 6.3 单元测试覆盖所有 transition
**文件**: `packages/coding-agent/src/swarm/__tests__/fsm-test.ts`

```typescript
describe("WorkflowFsm", () => {
    it("should reach idle from any state", () => {
        for (const state of fsm.allStates()) {
            expect(canReach(fsm, state, "idle")).toBe(true);
        }
    });

    it("should not have livelock cycles", () => {
        expect(hasLivelock(fsm)).toBe(false);
    });

    it("all transitions should have valid guards", () => {
        for (const t of fsm.allTransitions()) {
            expect(t.guard).toBeDefined();
        }
    });
});
```

---

## 实施顺序

| Phase | 内容 | 风险 | 预估时间 | 依赖 |
|-------|------|------|---------|------|
| P1 | 死代码清理 | 低 | 2h | 无 |
| P2 | ScriptManager 修复 + Script CLI | 高 | 4h | P1 |
| P3 | 统一执行路径 + AgentRuntime 接入 | 高 | 6h | P1 |
| P4 | IRC Bus CLI 集成 | 中 | 3h | P3 |
| P5 | Agent 重试与恢复 | 中 | 4h | P3 |
| P6 | WorkflowFsm 形式化验证 | 低 | 2h | P3 |

**P2 和 P3 可以并行**：P2 修复 ScriptManager 语法，P3 接入 AgentRuntime。两者完成后 P4 才能集成 IRC。

---

## 验证方案

### 单元测试
```bash
bun test packages/coding-agent/src/swarm/__tests__/
```
- 确保所有现有 test 通过
- 修复因 MarkEnvironment 去全局化而损坏的 test
- 新增 `assembler.test.ts` 验证服务装配
- 新增 `fsm-invariants.test.ts` 验证状态机

### 集成测试
```bash
# 1. Script 阶段
stp swarm plan .stp/loop-test.yaml
# 交互式输入 task → 生成 plan.md → debate → confirm

# 2. Stage 阶段
stp swarm run .stp/loop-test.yaml
# 直通模式：读 plan.md → Stage → Curtain

# 3. 完整流程
stp swarm plan .stp/loop-test.yaml
# plan → confirm → 自动 stage → curtain
```

### TUI 验证
```bash
stp swarm run .stp/loop-test.yaml --tui
# 应显示：Phase 进度、Agent 状态、Task Queue、实时输出
```

### 回归测试
```bash
bun test packages/coding-agent/test/
bun test packages/agent/test/
```

---

## 影响范围总结

| Phase | 新增文件 | 修改文件 | 删除内容 |
|-------|---------|---------|---------|
| P1 | 0 | ~12 | SSE 死代码、MarkEnvironment 单例、mock stubs |
| P2 | 0 | 2 (script-manager, swarm-cli) | dead else 分支 |
| P3 | 1 (assembler.ts) | 5 (swarm-cli, stage-controller, agent-handle, executor, agent-runtime) | SubprocessAgentExecutor, legacy streamAgentOutput 分支 |
| P4 | 1 (in-process-irc.ts) | 2 (comm-bus, stage-controller) | spawnRoundtable 空桩 |
| P5 | 1 (recovery.ts) | 2 (task-queue, stage-controller) | — |
| P6 | 1 (fsm-invariants.ts) | 1 (workflow-fsm) | — |

---

## 不做清单（明确排除）

| 项目 | 原因 |
|------|------|
| 预算管理 | satopi 已有 deadline + token tracking，足够防止失控 |
| 分布式扩展（RemoteAgentExecutor） | 当前规模不需要，>50 agent 时再考虑 |
| collab-web 恢复 | 已确认无 swarm web GUI |
| SSE 推送 | 已确认无 web GUI，TUI 用回调 |
| satopi 基础库修改 | 约束：不改基础库 |
| loop.yaml 格式变更 | 约束：不改配置格式 |
| 单 Agent 模式变更 | 约束：不影响现有单 Agent |

---

## 关键风险点

1. **P3 AgentLauncher 工具创建**：`builtinToolNames` 必须正确传入，否则 swarm agent 无工具可用。需验证 `createTools()` 在 swarm 上下文中能正确创建 read/write/bash 等工具。

2. **P2 ScriptManager 交互式 CLI**：需要处理 stdin 读取、TUI 渲染、plan.md 文件监听的并发问题。建议用 `readline.createInterface()` + `fs.watch()`。

3. **P3 AgentHandle 指标**：Agent 完成后需要从 telemetry 提取 token usage。需确认 satopi 的 `Agent` 类是否暴露了累计 usage 数据。

4. **P4 IRC Bus 适配**：satopi 的 IrcBus 接口可能假设了网络连接。in-process 实现需要完整模拟 IrcBus 的所有方法（channel 创建、消息广播、投票等）。

5. **P1 MarkEnvironment 去全局化**：需搜索所有 `MarkEnvironment.global()` 调用点，确保全部改为注入。测试代码可能也需要修改。
