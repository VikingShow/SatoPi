# Plan: 支持并发多 Session 的架构重构

## 目标

将当前的单 session 架构升级为支持多个 swarm session 并发运行，从 Before Loop 开始到 After Loop 结束的完整生命周期均可独立并行。

## 当前架构 vs 目标架构

```
当前（单 session）:
  workspace/                        workspace/
  ├── .omp/plan.md   ← 全局唯一     └── .swarm_SatoPi/     ← 只有一个活跃 session
  └── .swarm_SatoPi/

目标（并发多 session）:
  workspace/
  ├── .omp/plans/             ← 跨 session 共享（只读归档）
  ├── .omp/experience/        ← 跨 session 共享（经验积累）
  ├── loop.yaml               ← 跨 session 共享（全局配置）
  ├── .swarm_SatoPi/          ← Session A 独立
  │   ├── .omp/plan.md        ←   per-session plan
  │   ├── state/pipeline.json
  │   └── activity.jsonl
  └── .swarm_MyTask/          ← Session B 独立（并发）
      ├── .omp/plan.md        ←   per-session plan
      ├── state/pipeline.json
      └── activity.jsonl
```

## 修改范围总览

共涉及 **18 个文件**，分为 5 个 Phase。

---

## Phase 1: plan.md 路径 per-session 化

### 1.1 新建 `swarm/plan-paths.ts`

提取当前散落各处的 plan.md 路径拼接逻辑到一个统一模块：

```typescript
// 规范 plan.md 的单一事实来源
export function getSessionPlanPath(swarmDir: string): string {
  return path.join(swarmDir, ".omp", "plan.md");
}
export function getPlanArchiveDir(workspace: string): string {
  return path.join(workspace, ".omp", "plans");
}
```

### 1.2 修改 `before-loop.ts` — 3 个函数

| 函数 | 当前参数 | 改为 |
|------|---------|------|
| `planExists(workspace)` | `workspace` | `swarmDir` |
| `stampAndArchivePlanMd(workspace)` | `workspace` | `swarmDir` |
| `archivePlanForHistory(workspace)` | `workspace` | `swarmDir` |
| `runPlanDebate(draftPlan, workspace, ...)` | `workspace` | `swarmDir`（第2参数改语义） |
| `listArchivedPlans(workspace)` | 不变（读归档目录，仍然是 workspace 级别） | — |

所有函数内部改为调用 `getSessionPlanPath(swarmDir)`。

### 1.3 修改 `before-loop-manager.ts` — 2 处

- `#getPlanMtime()` — 当前读 `this.#workspace`，改为读 `this.#swarmDir`（新字段）
- `runDebate()` — 当前读 `this.#workspace`，改为读 `this.#swarmDir`
- 构造函数增加 `swarmDir` 参数

### 1.4 修改 `loop-controller.ts` — 2 处

- `updatePlan()`（line 402）— 当前写 `{workspace}/.omp/plan.md`，改为写 `{swarmDir}/.omp/plan.md`
- 构造函数 / `runLoop()` 增加 `swarmDir` 参数传递

### 1.5 修改 `api-routes.ts` — 2 个端点

- `GET /api/session/:name/plan` — 从 `ctx.session.planPath()` 读取
- `PUT /api/session/:name/plan` — 写入 `ctx.session.planPath()`

### 1.6 修改 `standalone.ts` — SwarmRunManager

- 构造函数增加 `swarmDir` 字段
- `start()` 内的 plan 读取路径从 `this.#workspace` 改为 `this.#swarmDir`

### 1.7 修改 `after-loop-runner.ts`

- `archivePlanForHistory` 调用改为传入 `swarmDir`

### 1.8 修改 `swarm-extension/src/extension.ts`

- `stampAndArchivePlanMd` 调用改为传入 `stateTracker.swarmDir`

### 1.9 修改 `before-loop.ts` — `generatePlanningPrompt()`

- Socrates prompt 中的路径提示（line 82）从 `{workspace}/.omp/plan.md` 改为 `{swarmDir}/.omp/plan.md`

**Phase 1 验证券**：所有路径调用方接受 `swarmDir` 而非 `workspace`，plan.md 文件物理上写入 `.swarm_X/.omp/plan.md`。

---

## Phase 2: RegionLockManager 去单例化

### 2.1 修改 `region-lock.ts`

- 删除 `static #instance` 和 `create()` / `global()` / `reset()` 静态方法
- 类保持不变（`#locks` Map 等实例字段已经是 per-instance 的）

### 2.2 修改 `loop-controller.ts`

- 当前 line 501: `const lockMgr = RegionLockManager.create()`
- 改为: `const lockMgr = new RegionLockManager()`
- RegionLockManager 实例随 LoopController 生命周期

### 2.3 修改 `swarm-extension/src/extension.ts`

- 删除 3 处 `RegionLockManager.reset()` 调用（line 412, 494, 505）
- 不再需要全局 reset

**Phase 2 验证券**：两个并发 session 的 worker 不会互相阻塞文件锁。

---

## Phase 3: SessionRegistry 核心实现

### 3.1 新建 `swarm/session-registry.ts`

```typescript
export interface SessionServices {
  name: string;
  swarmDir: string;
  stateTracker: StateTracker;
  activityLogger: ActivityLogger;
  beforeLoopManager: BeforeLoopManager;
  runManager: RunManager;
  abortController: AbortController;
  status: "idle" | "before-loop" | "running" | "blocked" | "after-loop" | "completed";
}

export interface SharedServices {
  workspace: string;
  yamlPath: string;
  experienceStore: ExperienceStore;
  roleAssetManager: RoleAssetManager;
  modelRegistry: ModelRegistry;
  settings: Settings;
}

export class SessionRegistry {
  #shared: SharedServices;
  #sessions: Map<string, SessionServices> = new Map();
  #maxConcurrent: number;

  constructor(shared: SharedServices, maxConcurrent?: number);

  canStart(): boolean;
  createSession(name: string): Promise<SessionServices>;
  getSession(name: string): SessionServices | undefined;
  getPlanPath(name: string): string;
  getPlanArchiveDir(): string;
  destroySession(name: string): Promise<void>;
  get activeSessions(): SessionServices[];
  get allSessions(): SessionServices[];
}
```

`createSession()` 负责创建完整的 per-session 服务图：
1. `await fs.mkdir(swarmDir, { recursive: true })`
2. `new StateTracker(workspace, name)`
3. `new ActivityLogger(swarmDir)`
4. `new SwarmRunManager({ workspace, yamlPath, stateTracker, activityLogger, experienceStore, modelRegistry, settings })`
5. `new BeforeLoopManager({ workspace, yamlPath, swarmDir, stateTracker, activityLogger, experienceStore, runManager, modelRegistry, settings })`
6. 返回 `SessionServices`

### 3.2 修改 `standalone.ts` — main()

- `main()` 内创建 `SessionRegistry` 替代手工构建所有对象
- MonitorServer 接收 `SessionRegistry` 而非单个 `StateTracker` / `RunManager`

### 3.3 修改 `swarm-extension/src/extension.ts` — handleRun()

- `handleRun()` 内通过 `SessionRegistry` 创建 session

**Phase 3 验证券**：可以通过调用 `registry.createSession("task1")` 和 `registry.createSession("task2")` 获得两个独立可用的服务图。

---

## Phase 4: MonitorServer 多 session 路由

### 4.1 修改 `monitor/server.ts`

- 构造函数改为接收 `SessionRegistry` 而非单个 `stateTracker` / `runManager` / `beforeLoopManager`
- 内部持有 `#registry: SessionRegistry`
- Fetch handler 中：
  - `GET /events?session=X` — 为指定 session 建立 SSE 流
  - `GET /api/session/:name/*` — 匹配 session-scoped 路由

### 4.2 修改 `monitor/event-bus.ts`

- `#subscribers` 改为 `Map<string, Set<Subscriber>>`（key = sessionName）
- `subscribe(sessionName, ...)` / `broadcast(sessionName, ...)` / `closeAll(sessionName?)`
- 向后兼容：未指定 sessionName 的广播发给所有订阅者（用于全局事件）

### 4.3 修改 `monitor/api-routes.ts` — 路由拆分

将现有路由分为两类：

**Session-scoped**（新前缀 `/api/session/:name/`）：
- `GET /api/session/:name/state`
- `GET /api/session/:name/config` / `PUT /api/session/:name/config`
- `GET /api/session/:name/plan` / `PUT /api/session/:name/plan`
- `GET /api/session/:name/plan/todos`
- `POST /api/session/:name/run/start|stop|pause|resume`
- `GET /api/session/:name/run/status`
- `POST /api/session/:name/run/steer`
- `POST /api/session/:name/run/resolve-blocker`
- `GET /api/session/:name/after-loop/summary`
- All `/api/before-loop/*`
- `GET /api/session/:name/history`
- `GET /api/terminal/connect?session=X` / `POST /api/terminal/input?session=X`

**Global / Workspace-scoped**（前缀不变）：
- `GET /api/runs` — 列出所有 session
- `GET /api/runs/:name/activity` — 历史 session 的 activity（只读）
- `GET /api/runs/:name` — 历史 session 元数据
- `GET /api/models` — 模型列表（共享）
- `GET/POST/PUT/DELETE /api/roles/*` — 角色库（共享）
- `GET /api/experience/*` — 经验存储（共享）

### 4.4 修改 `monitor/server.ts` — 路由匹配

在 fetch handler 中增加 Session 路由匹配：
```
if pathname starts with "/api/session/"
  → parse sessionName
  → lookup SessionServices from registry
  → construct per-session ApiRouteContext
  → dispatch to handler
```

**Phase 4 验证券**：GUI 通过 `/api/session/task1/run/start` 启动 session A，通过 `/api/session/task2/run/start` 启动 session B，SSE 分别订阅 `/events?session=task1` 和 `/events?session=task2`。

---

## Phase 5: 前端 GUI 适配

### 5.1 修改 `swarm-gui/src/lib/api-client.ts`

- 大部分端点路径加上 session 前缀
- 新增 `setActiveSession(name)` 方法，或直接在当前 active session 状态下自动拼接

### 5.2 修改 `swarm-gui/src/lib/sse-client.ts`

- EventSource URL 改为 `/events?session=${activeSession}`

### 5.3 修改 `swarm-gui/src/stores/swarm-store.ts`

- `init()` 不再假设只有一个活跃 session
- 通过 `GET /api/runs` 获取所有 session 列表
- 通过 `GET /api/session/:name/state` 获取特定 session 状态

### 5.4 修改 `swarm-gui/src/stores/session-store.ts`

- `newSession()` 创建新 session 后前端自动切换到新 session
- `switchToSession()` 支持切换到活跃 session（不只是只读历史）
- 区分"活跃 session"和"历史 session"的展示

**Phase 5 验证券**：GUI 侧栏显示多个活跃 session，每个可以独立点击进入查看 Before Loop / 运行状态，互不干扰。

---

## 修改文件清单

| Phase | 文件 | 改动类型 |
|-------|------|---------|
| 1 | `swarm/plan-paths.ts` | **新建** — plan 路径工具函数 |
| 1 | `swarm/before-loop.ts` | 改 — 5 个函数签名 |
| 1 | `swarm/before-loop-manager.ts` | 改 — 构造函数 + 2 处路径 |
| 1 | `swarm/loop-controller.ts` | 改 — 构造函数 + updatePlan |
| 1 | `swarm/monitor/api-routes.ts` | 改 — plan 端点 |
| 1 | `swarm/monitor/standalone.ts` | 改 — SwarmRunManager 构造函数 |
| 1 | `swarm/monitor/after-loop-runner.ts` | 改 — archive 调用 |
| 1 | `swarm-extension/src/extension.ts` | 改 — stamp 调用 |
| 2 | `swarm/region-lock.ts` | 改 — 去单例化 |
| 2 | `swarm/loop-controller.ts` | 改 — RegionLock 实例化 |
| 2 | `swarm-extension/src/extension.ts` | 改 — 删除 reset() |
| 3 | `swarm/session-registry.ts` | **新建** — 核心注册表 |
| 3 | `swarm/monitor/standalone.ts` | 改 — main() 用 Registry |
| 3 | `swarm-extension/src/extension.ts` | 改 — handleRun() 用 Registry |
| 4 | `swarm/monitor/server.ts` | 改 — 构造函数 + 路由 |
| 4 | `swarm/monitor/event-bus.ts` | 改 — namespace |
| 4 | `swarm/monitor/api-routes.ts` | 改 — 路由拆分 |
| 5 | `swarm-gui/src/lib/api-client.ts` | 改 — API 路径 |
| 5 | `swarm-gui/src/lib/sse-client.ts` | 改 — SSE URL |
| 5 | `swarm-gui/src/stores/swarm-store.ts` | 改 — 多 session 状态 |
| 5 | `swarm-gui/src/stores/session-store.ts` | 改 — 活跃 session 管理 |

共 **22 个文件**（2 新建，20 修改）。

---

## 风险和缓解

| 风险 | 缓解措施 |
|------|---------|
| Phase 1 路径变更导致 plan.md 丢失 | 首次启动时自动迁移旧路径的 plan.md 到新位置 |
| Phase 4 API 路径变更破坏前端 | Phase 5 同步进行，前后端一起改 |
| 并发 session 的资源竞争 | `#maxConcurrent` 限制（默认 3），可配置 |
| RegionLock 去单例后旧 worker hook 还在用全局引用 | `grep` 确认所有调用方已更新 |

---

## 执行顺序

Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

每个 Phase 独立可验证：
- Phase 1 完成：单 session 下 plan.md 路径正确
- Phase 2 完成：单 session 下文件锁行为不变
- Phase 3 完成：通过 Registry 创建/销毁 session 正常工作
- Phase 4 完成：API 路由正确分发到不同 session
- Phase 5 完成：GUI 完整支持多 session
