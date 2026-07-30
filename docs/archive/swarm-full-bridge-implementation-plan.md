# Scheme 3 (Full Bridge) — Complete Implementation Plan

## Architecture Overview

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                         TUI Interactive Session                                ║
║  ┌─────────────┐     ┌──────────────────┐     ┌─────────────────────────────┐ ║
║  │   Editor     │────▶│  agent-session   │────▶│  EmbeddedSwarmBridge         │ ║
║  │  (magic kw)  │     │  #createMagicK   │     │  (new file)                  │ ║
║  └─────────────┘     │  eywordNotices()  │     │                              │ ║
║                       └──────────────────┘     │  ┌─────────────────────────┐ │ ║
║                                                │  │ WorkflowFSM             │ │ ║
║  ┌─────────────┐     ┌──────────────────┐     │  │ idle→script→confirm→    │ │ ║
║  │ Swarm       │◀────│ interactive-mode │◀────│  │ stage→curtain→idle      │ │ ║
║  │ Dashboard   │     │ (phase-aware UI) │     │  └─────────────────────────┘ │ ║
║  │ Overlay     │     └──────────────────┘     │                              │ ║
║  └─────────────┘                              │  ┌─────────────────────────┐ │ ║
║                                                │  │ AgentRuntime            │ │ ║
║                                                │  │ .spawn() workers        │ │ ║
║                                                │  │ .spawnRoundtable()      │ │ ║
║                                                │  └─────────────────────────┘ │ ║
║                                                │                              │ ║
║                                                │  ┌─────────────────────────┐ │ ║
║                                                │  │ StageController         │ │ ║
║                                                │  │ + CurtainRunner         │ │ ║
║                                                │  └─────────────────────────┘ │ ║
║                                                └─────────────────────────────┘ ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

---

## Data Flow — Complete Turn-by-Turn Sequence

### Phase 0: User Types the Magic Keyword

```
User: "swarm 重构认证模块，分离 JWT 逻辑，增加 OAuth2 支持"

1. custom-editor.ts: hasMagicKeyword() → true
2. Editor paints "swarm" in blue→cyan gradient
3. User presses Enter

4. input-controller.ts → agent-session.ts
5. #createMagicKeywordNotices(text):
   - containsSwarm(text) → true
   - magicKeywords.enabled → true
   - magicKeywords.swarm → true
   → 注入 SWARM_NOTICE (原 swarm-notice.md 的指令)
   
   *** NEW: 同时触发 EmbeddedSwarmBridge.init() ***
```

### Phase 1: Script — Agent Plans

```
6. agent-session.ts: prompt() 带着 SWARM_NOTICE 发送给模型
7. 模型看到 SWARM_NOTICE 中的指令：
   - "你是 swarm coordinator"
   - "第一步: Ingest → Plan → 用 todo 列出完整 phase"
   - "第二步: 写 plan.md"
   - "第三步: 等待用户确认后进入 Stage"

8. Agent 回复:
   - 读取相关代码文件 (Ingest)
   - 用 todo 工具创建结构化的 phase 分解
   - 用 write 工具写入 plan.md

9. EmbeddedSwarmBridge 检测到 plan.md 被写入:
   - #pollPlanFile() 轮询 plan.md mtime 
   - 将 plan 内容推送至 SwarmDashboardOverlay 的 Plan Review 面板
   - TUI 状态栏显示: [🐝 Swarm: Script · plan ready for review]

10. Agent 展示 plan 给用户，并在回复末尾请求确认:
    "Plan is complete. Review the phases above and confirm to launch Stage."
```

### Phase 2: Human Confirms → Transition

```
11. Agent 在回复中调用 agent_ask("Ready to launch Stage?" options=["Confirm","Revise","Cancel"])
    或者: 用户直接回复 "确认" / "confirm" / "go ahead"

12. agent-session.ts 检测到用户的确认意图 (匹配关键词或 ask 工具结果):
    → EmbeddedSwarmBridge.confirmScript()

13. EmbeddedSwarmBridge.confirmScript():
    WorkflowFSM.transition("script-confirm")
    → 验证 plan.md 存在且格式有效
    → 如果配置了 debate，可先 transition → "script-debate"
    → WorkflowFSM.transition("stage")
    → 启动 StageController

14. TUI 状态栏: [🐝 Swarm: Stage · Wave 1/4]
    自动打开 Swarm Dashboard overlay
```

### Phase 3: Stage — Parallel Execution

```
15. StageController.run():
    a. 解析 plan.md → DAG TaskQueue
    b. 按 wave 组织 task (无依赖的 task 在同一 wave)
    c. 每个 wave: AgentRuntime.spawn(workers) 并行执行
    d. 每个 worker agent:
       - 独立的 Agent 实例 (独立 session)
       - 只给必要的工具 (write, edit, grep, bash for tests)
       - 接收自包含的 task 描述
       - 完成后返回结果
    e. Wave 完成后验证 gate (bun check / bun test / lsp diagnostics)
    f. 如果 gate 失败，spawn fix-up agents
    g. 进入下一 wave

16. Dashboard 实时更新:
    - StateTracker.updateAgent() → SwarmDashboardComponent.update()
    - 每 200ms 一个 render 帧，显示:
      · 当前 wave / 总 wave 数
      · 每个 worker 的状态 (pending/waiting/running/completed/failed)
      · 运行时长
      · Token 使用量

17. 用户可以在 Stage 中干预:
    - 在 dashboard 中按 / 输入 steering 消息
    - 消息通过 EmbeddedSwarmBridge.steer(msg) 路由到当前活跃 worker
    - 或者按 Esc 关闭 dashboard，在正常 chat 中发消息 steering
```

### Phase 4: Curtain — Closure & Learning

```
18. 所有 wave 完成 → StageController 返回 StageResult
    WorkflowFSM.transition("curtain")

19. CurtainRunner.run():
    Thread A: Reporter agent → 生成交付总结
    Thread B: Reflection agents → 提取经验教训
    → 写入 ExperienceStore (lessons.jsonl + FTS index)
    → 可选: 写入 Mnemopi (语义记忆)
    → 可选: 推送到 Hindsight (跨 session 经验)

20. TUI 状态栏: [🐝 Swarm: Curtain · awaiting applaud]

21. Reporter agent 输出展示在 chat 中:
    "✅ 重构完成: 3 个 phase, 12 个 task 全部通过
     - 提取 JWT 中间件 (3 files changed)
     - 实现 OAuth2 provider 接口 (5 files)
     - 单元测试覆盖 87%
    
     经验教训:
     1. OAuth2 state 参数需要 CSRF 保护 — 已添加
     2. JWT 过期刷新逻辑需要幂等 — 已在中间件中处理
     
     ✋ Applaud to complete the swarm run."

22. 用户 applaud (回复 "applaud" / "完成" / "👍") 或等待 auto-applaud 超时:
    CurtainRunner 完成 → WorkflowFSM.transition("idle")
    → 持久化 final state
    → 主 agent 恢复普通模式
```

---

## Detailed File Changes

### File 1 (NEW): `packages/coding-agent/src/swarm/core/embedded-swarm-bridge.ts`

This is the central orchestrator that bridges the TUI agent session with the SwarmRunner lifecycle.

```typescript
/**
 * EmbeddedSwarmBridge — Bridges interactive agent session ↔ SwarmRunner lifecycle.
 *
 * Created by agent-session when the "swarm" magic keyword is detected.
 * Manages the full Script → Stage → Curtain lifecycle WITHIN an active
 * interactive session, with the human user as a first-class participant.
 *
 * Lifecycle:
 *   init() → created, ready for Script phase
 *   onPlanUpdated(content) → called whenever the agent writes plan.md
 *   confirmScript() → validates plan, transitions to Stage
 *   steer(msg) → routes human steering to Stage workers
 *   applaud() → completes Curtain, transitions to idle
 */
```

**Key types:**

```typescript
export interface EmbeddedSwarmConfig {
  /** Project workspace directory. */
  workspace: string;
  /** Swarm work directory (auto-created in .swarm_{sessionId}/). */
  swarmDir: string;
  /** The parent agent session (for model/settings access). */
  parentSession: AgentSession;
  /** Optional user-specified max worker count. */
  maxWorkers?: number;
  /** Optional user-specified max rounds. */
  maxRounds?: number;
  /** Whether to auto-applaud after Curtain (default: false, wait for human). */
  autoApplaud?: boolean;
}

export interface SwarmPhaseEvent {
  phase: Chapter;
  subStatus: string;
  progress?: {
    currentWave?: number;
    totalWaves?: number;
    completedTasks?: number;
    totalTasks?: number;
  };
}

export interface SwarmAgentEvent {
  agentId: string;
  status: AgentStatus;
  output?: string;
  error?: string;
}

export type SwarmEventCallback = (event: SwarmPhaseEvent | SwarmAgentEvent) => void;

export class EmbeddedSwarmBridge {
  #config: EmbeddedSwarmConfig;
  #fsm: WorkflowFsm;
  #stateTracker: StateTracker;
  #activityLogger: ActivityLogger;
  #runtime: AgentRuntime;
  #hookPipeline: HookPipeline;
  #sessionManager: SwarmSessionManager | null = null;
  #stageController: StageController | null = null;
  #curtainRunner: CurtainRunner | null = null;
  #planContent: string = "";
  #planReady: boolean = false;
  #listener: SwarmEventCallback;
  #abortController: AbortController | null = null;
  #loopConfig: LoopSwarmConfig;

  constructor(config: EmbeddedSwarmConfig, listener: SwarmEventCallback);

  // ── Lifecycle ─────────────────────────────────────────────────

  /** Initialize all swarm services. Called once, right after construction. */
  async init(): Promise<void>;

  /** Tear down all services. Idempotent. */
  async dispose(): Promise<void>;

  // ── Script Phase ──────────────────────────────────────────────

  /** Called by agent-session when the agent writes/updates plan.md. */
  onPlanUpdated(content: string): void;

  /** Get the current plan content. */
  getPlanContent(): string;

  /** Is the plan ready? (has content and meets minimum structure). */
  isPlanReady(): boolean;

  /** 
   * Validate the plan & transition to Stage.
   * Returns validation errors as string[], or empty if valid.
   */
  async confirmScript(): Promise<string[]>;

  /**
   * Launch a debate among multiple Planner agents to refine the plan.
   * Returns the refined plan content.
   */
  async debatePlan(): Promise<string>;

  // ── Stage Phase ───────────────────────────────────────────────

  /** Route a human steering message to the current workers. */
  async steer(message: string): Promise<void>;

  /** Pause the current stage (e.g. for human review). */
  async pauseStage(): Promise<void>;

  /** Resume a paused stage. */
  async resumeStage(): Promise<void>;

  // ── Curtain Phase ─────────────────────────────────────────────

  /** Complete the Curtain phase with human applaud. */
  async applaud(): Promise<void>;

  // ── Accessors ─────────────────────────────────────────────────

  get fsm(): WorkflowFsm;
  get stateTracker(): StateTracker;
  get activityLogger(): ActivityLogger;
  get currentPhase(): Chapter;
  get swarmState(): SwarmState;
}
```

**Implementation sketch: `init()`**

```typescript
async init(): Promise<void> {
  // 1. Create swarm workspace directory
  await fs.mkdir(this.#config.swarmDir, { recursive: true });
  await fs.mkdir(path.join(this.#config.swarmDir, ".stp"), { recursive: true });
  await fs.mkdir(path.join(this.#config.swarmDir, "logs"), { recursive: true });

  // 2. Create SwarmSessionManager for persistence
  this.#sessionManager = await SwarmSessionManager.create(this.#config.swarmDir);

  // 3. Create StateTracker + inject session manager
  const swarmName = `swarm-${this.#config.parentSession.getSessionId?.() ?? crypto.randomUUID()}`;
  this.#stateTracker = new StateTracker(this.#config.workspace, swarmName);
  this.#stateTracker.setSessionManager(this.#sessionManager);

  // 4. Create ActivityLogger
  this.#activityLogger = new ActivityLogger(this.#config.swarmDir, swarmName);

  // 5. Create WorkflowFSM
  this.#fsm = new WorkflowFsm(this.#stateTracker, this.#activityLogger, "script");
  for (const def of PHASES) this.#fsm.registerPhase(def);

  // 6. Subscribe to FSM phase changes → forward to listener
  this.#fsm.onChange(event => {
    this.#listener({
      phase: event.to,
      subStatus: event.meta?.reason ?? "",
    });
  });

  // 7. Create service dependencies (reuse parent session's)
  const authStorage = this.#config.parentSession.authStorage;  // need to expose
  const modelRegistry = this.#config.parentSession.modelRegistry;  // need to expose
  const settings = this.#config.parentSession.settings;

  // 8. Create HookPipeline + register builtins
  this.#hookPipeline = new HookPipeline();
  registerBuiltinHooks(this.#hookPipeline, {
    offloadManager: new NoopOffloadManager(),
    experienceStore: this.#config.experienceStore,
  });

  // 9. Assemble AgentRuntime (reuse assembleAgentRuntime from assembler.ts)
  const ircBus = IrcBus.global();
  this.#runtime = assembleAgentRuntime({
    modelRegistry,
    settings,
    activityLogger: this.#activityLogger,
    roleAssetManager: this.#config.roleAssetManager,
    hookPipeline: this.#hookPipeline,
    ircBus,
    experienceStore: this.#config.experienceStore,
  });

  // 10. Build default loop config
  this.#loopConfig = {
    maxIterations: this.#config.maxRounds ?? 3,
    autoRetry: true,
    humanEscalation: true,
    agents: {
      initial: this.#config.maxWorkers ?? 4,
      min: 1,
      max: this.#config.maxWorkers ?? 4,
      maxRounds: this.#config.maxRounds ?? 3,
      roundsConvergenceThreshold: 2,
    },
    planDebate: { enabled: false, clonerCount: 2, maxRounds: 2, convergenceThreshold: 2 },
    cloners: { count: 4 },
    agentRestrictions: {},
  };

  // 11. Create CurtainRunner (ready, but not started yet)
  this.#curtainRunner = new CurtainRunner({
    workspace: this.#config.workspace,
    stateTracker: this.#stateTracker,
    activityLogger: this.#activityLogger,
    experienceStore: this.#config.experienceStore,
    loopConfig: this.#loopConfig,
    modelRegistry,
    settings,
    // applaudSignal will be set when Curtain starts
  });

  this.#listener({ phase: "script", subStatus: "planning" });
}
```

**Implementation sketch: `confirmScript()`**

```typescript
async confirmScript(): Promise<string[]> {
  // 1. Validate plan.md
  const planPath = getSessionPlanPath(this.#config.swarmDir);
  let planContent: string;
  try {
    planContent = await fs.readFile(planPath, "utf-8");
  } catch {
    return ["plan.md not found — agent must write a plan before confirming"];
  }

  // Basic structural validation
  const errors: string[] = [];
  if (!planContent.includes("## ") && !planContent.includes("# ")) {
    errors.push("plan.md must contain at least one heading section");
  }
  if (planContent.trim().length < 200) {
    errors.push("plan.md is too short (< 200 chars) — plan appears incomplete");
  }
  // TODO: more sophisticated validation (DAG check, file path references, etc.)
  if (errors.length > 0) return errors;

  this.#planContent = planContent;

  // 2. Transition to script-confirm
  const result = await this.#fsm.transition("script-confirm", {
    reason: "human confirmed plan",
  });
  if (!result.ok) return [result.reason ?? "FSM rejected script-confirm transition"];

  // 3. Transition to stage
  const stageResult = await this.#fsm.transition("stage", {
    reason: "starting stage execution",
  });
  if (!stageResult.ok) return [stageResult.reason ?? "FSM rejected stage transition"];

  // 4. Create and start StageController
  this.#abortController = new AbortController();
  this.#stageController = createStageController({
    workspace: this.#config.workspace,
    swarmName: this.#stateTracker.state.name,
    planContent: this.#planContent,
    loopConfig: this.#loopConfig,
    stateTracker: this.#stateTracker,
    activityLogger: this.#activityLogger,
    modelRegistry: this.#runtime.modelRegistry,  // need to expose
    settings: this.#config.parentSession.settings,
    signal: this.#abortController.signal,
    profileRegistry: this.#config.profileRegistry,
    roleAssetManager: this.#config.roleAssetManager,
    runtime: this.#runtime,
    hookPipeline: this.#hookPipeline,
  });

  // Start stage asynchronously — don't block
  this.#stageController.run()
    .then(async (stageResult) => {
      // Stage complete → transition to curtain
      await this.#fsm.transition("curtain", {
        reason: "stage completed",
        terminalStatus: stageResult.status,
      });
      // Run Curtain
      await this.#runCurtain(stageResult);
    })
    .catch(async (err) => {
      this.#listener({
        phase: "stage",
        subStatus: `stage failed: ${String(err)}`,
      });
    });

  return []; // no errors — stage started
}
```

---

### File 2: `packages/coding-agent/src/session/agent-session.ts`

**Changes needed:**

**2a. New imports:**
```typescript
import { EmbeddedSwarmBridge, type SwarmPhaseEvent, type SwarmAgentEvent } from "../swarm/core/embedded-swarm-bridge";
```

**2b. New private fields on AgentSession:**
```typescript
#embeddedSwarm: EmbeddedSwarmBridge | null = null;
```

**2c. Modify `#createMagicKeywordNotices()` (around line 7931):**
Before the existing `if (this.#magicKeywordEnabled("swarm") && containsSwarm(text))` block, add swarm bridge initialization:

```typescript
// Existing code:
if (this.#magicKeywordEnabled("swarm") && containsSwarm(text)) {
  keywordNotices.push({
    role: "custom",
    customType: "swarm-notice",
    content: SWARM_NOTICE,
    display: false,
    attribution: "user",
    timestamp,
  });
  
  // *** NEW: Initialize embedded swarm bridge ***
  if (!this.#embeddedSwarm) {
    this.#initializeEmbeddedSwarm().catch(err => {
      logger.error("Failed to init embedded swarm bridge", { error: String(err) });
    });
  }
}
```

**2d. New methods on AgentSession:**

```typescript
async #initializeEmbeddedSwarm(): Promise<void> {
  const sessionId = this.sessionId ?? crypto.randomUUID().slice(0, 8);
  const swarmDir = path.join(getProjectDir(), `.swarm_${sessionId}`);
  const experienceStore = new ExperienceStore(getProjectDir());
  await experienceStore.init();

  this.#embeddedSwarm = new EmbeddedSwarmBridge(
    {
      workspace: getProjectDir(),
      swarmDir,
      parentSession: this,
      experienceStore,
      roleAssetManager: this.#roleAssetManager,
      profileRegistry: this.#profileRegistry,
      maxWorkers: this.settings.get("magicKeywords.swarm.maxWorkers") ?? 4,
      maxRounds: this.settings.get("magicKeywords.swarm.maxRounds") ?? 3,
      autoApplaud: this.settings.get("magicKeywords.swarm.autoApplaud") ?? false,
    },
    (event) => {
      // Forward swarm events to registered listeners
      this.#notifySwarmListeners(event);
    },
  );

  await this.#embeddedSwarm.init();

  logger.info("[AgentSession] EmbeddedSwarmBridge initialized", {
    sessionId,
    swarmDir,
  });
}

// Need to listen for tool calls that write plan.md
// When the agent calls `write` and the path is "plan.md", notify the bridge
#onToolCallStarted(toolName: string, args: Record<string, unknown>): void {
  if (!this.#embeddedSwarm) return;
  
  // Check if agent is writing plan.md
  if (toolName === "write" && typeof args.file_path === "string") {
    const filePath = args.file_path as string;
    if (filePath.endsWith("plan.md") || filePath.endsWith("PLAN.md")) {
      const content = typeof args.content === "string" ? args.content : "";
      if (content) {
        this.#embeddedSwarm.onPlanUpdated(content);
      }
    }
  }
}

// Expose embedded swarm for interactive-mode
get embeddedSwarm(): EmbeddedSwarmBridge | null {
  return this.#embeddedSwarm;
}
```

**2e. New settings in schema:**

Add to `magicKeywords.swarm` group in `settings-schema.ts`:

```typescript
"magicKeywords.swarm.maxWorkers": {
  type: "number",
  default: 4,
  ui: {
    tab: "magic",
    group: "Swarm",
    label: "Max Workers",
    description: "Maximum parallel workers during Stage phase (1-12)",
  },
},
"magicKeywords.swarm.maxRounds": {
  type: "number",
  default: 3,
  ui: {
    tab: "magic",
    group: "Swarm",
    label: "Max Rounds",
    description: "Maximum retry rounds during Stage phase",
  },
},
"magicKeywords.swarm.autoApplaud": {
  type: "boolean",
  default: false,
  ui: {
    tab: "magic",
    group: "Swarm",
    label: "Auto Applaud",
    description: "Automatically complete Curtain without waiting for human applaud",
  },
},
"magicKeywords.swarm.enableDebate": {
  type: "boolean",
  default: false,
  ui: {
    tab: "magic",
    group: "Swarm",
    label: "Enable Plan Debate",
    description: "Run a multi-agent debate to refine the plan before confirming",
  },
},
```

---

### File 3: `packages/coding-agent/src/modes/interactive-mode.ts`

**Changes needed:**

**3a. New import:**
```typescript
import type { EmbeddedSwarmBridge, SwarmPhaseEvent, SwarmAgentEvent } from "../../swarm/core/embedded-swarm-bridge";
```

**3b. New fields:**
```typescript
#embeddedSwarm: EmbeddedSwarmBridge | null = null;
#swarmAutoOpenDashboard = false;
```

**3c. Enhance `showSwarmDashboard()` (around line 4296):**

Replace the current stub implementation with one that receives real swarm state:

```typescript
showSwarmDashboard(): void {
  // Toggle: close if already open
  if (this.#swarmDashboardOverlay) {
    this.#hideSwarmDashboard();
    return;
  }

  const swarm = this.#embeddedSwarm;
  
  const overlay = new SwarmDashboardOverlay({
    // *** NEW: pass real FSM and StateTracker when embedded swarm is active ***
    fsm: swarm?.fsm,
    stateTracker: swarm ? { state: swarm.swarmState } : undefined,
    activityLogger: swarm?.activityLogger,
  });

  overlay.onClose = () => this.#hideSwarmDashboard();
  overlay.onRequestRender = () => this.ui.requestRender();

  this.#swarmDashboardOverlay = overlay;
  this.#swarmDashboardHandle = this.ui.showOverlay(overlay, {
    anchor: "top-left",
    width: "100%",
    maxHeight: "100%",
    margin: 0,
    fullscreen: true,
  });
  this.ui.setFocus(overlay);
  this.ui.requestRender();

  // *** NEW: start polling for dashboard updates ***
  if (swarm) {
    this.#startSwarmDashboardPolling();
  }
}
```

**3d. New methods:**

```typescript
#swarmPollTimer?: ReturnType<typeof setInterval>;

#startSwarmDashboardPolling(): void {
  this.#stopSwarmDashboardPolling();
  // Poll at ~5fps — fast enough to feel live, slow enough to not burn CPU
  this.#swarmPollTimer = setInterval(() => {
    if (!this.#swarmDashboardOverlay || !this.#embeddedSwarm) {
      this.#stopSwarmDashboardPolling();
      return;
    }
    // Rebuild the snapshot and push to the component
    const snapshot = this.#buildSwarmDashboardSnapshot();
    // Access the internal component for live updates
    (this.#swarmDashboardOverlay as any).getComponent?.()?.update?.(snapshot);
    this.ui.requestRender();
  }, 200);
}

#stopSwarmDashboardPolling(): void {
  if (this.#swarmPollTimer) {
    clearInterval(this.#swarmPollTimer);
    this.#swarmPollTimer = undefined;
  }
}

#buildSwarmDashboardSnapshot(): DashboardInput {
  const tracker = this.#embeddedSwarm?.stateTracker;
  const swarm = tracker?.state ?? { /* default empty state */ };
  return {
    swarm,
    messages: [],  // TODO: reconstruct from ActivityLogger
    context: {     // TODO: populate from actual context state
      sources: [
        { name: "Mnemopi", active: false },
        { name: "Hindsight", active: false },
        { name: "Experience", active: true },
      ],
      l1PendingCount: 0,
      l2LastFlushSeconds: 0,
      l3Nodes: 0,
      l3Edges: 0,
      agents: Object.entries(swarm.agents ?? {}).map(([id, a]) => ({
        agentId: id,
        tokensUsed: 0,
        tokenBudget: 0,
      })),
    },
  };
}
```

**3e. Enhance `#handleGoalSessionEvent` or add new listener for swarm events:**

```typescript
// In init(), after the agent subscription is set up:
this.#eventBusUnsubscribers.push(
  this.session.onSwarmEvent?.((event: SwarmPhaseEvent | SwarmAgentEvent) => {
    this.#handleSwarmEvent(event);
  }) ?? (() => {}),
);

#handleSwarmEvent(event: SwarmPhaseEvent | SwarmAgentEvent): void {
  // Update status line
  if ("phase" in event) {
    this.statusLine.setSwarmPhase?.({
      phase: event.phase,
      subStatus: event.subStatus,
      progress: event.progress,
    });
    
    // Auto-open dashboard on stage start
    if (event.phase === "stage" && !this.#swarmDashboardOverlay) {
      this.showSwarmDashboard();
    }
    
    // Auto-close dashboard on idle
    if (event.phase === "idle" && this.#swarmDashboardOverlay) {
      this.#hideSwarmDashboard();
    }
  }
  
  this.ui.requestRender();
}
```

**3f. Wire up swarm session when detected:**

In the message/render pipeline, after `agent-session` sends a prompt that triggers swarm:

```typescript
// In the render loop or event handler, after the agent turn starts:
#syncEmbeddedSwarm(): void {
  const swarm = this.session.embeddedSwarm;
  if (swarm !== this.#embeddedSwarm) {
    this.#embeddedSwarm = swarm;
    if (swarm && this.#swarmDashboardOverlay) {
      // Re-create dashboard overlay with real data
      this.#hideSwarmDashboard();
      this.showSwarmDashboard();
    }
  }
}
```

---

### File 4: `packages/coding-agent/src/modes/components/swarm/swarm-dashboard-overlay.ts`

**Changes: Add a `getComponent()` accessor and enhance with live-update awareness:**

```typescript
export class SwarmDashboardOverlay implements Component {
  // ... existing code ...

  /** NEW: Expose the internal component for live updates from the polling loop. */
  getComponent(): SwarmDashboardComponent {
    return this.#component;
  }

  /** NEW: Get the binding for steering input. */
  getBinding(): SwarmTuiBinding {
    return this.#binding;
  }
}
```

**Also: Add keyboard shortcut for steering in the dashboard:**
```typescript
handleInput(data: string): void {
  if (data === "escape" || data === "q" || data === "\x1b") {
    this.onClose?.();
    return;
  }
  
  // NEW: "/" enters steering mode — capture next input as steering message
  if (data === "/" && this.#steeringEnabled) {
    this.#steeringActive = true;
    // TUI needs to enter text input mode...
    this.onRequestRender?.();
    return;
  }
}
```

---

### File 5: `packages/coding-agent/src/modes/types.ts`

**Add swarm phase to InteractiveModeContext:**

```typescript
export interface InteractiveModeContext {
  // ... existing ...
  showSwarmDashboard(): void;
  // NEW:
  get embeddedSwarm(): unknown | null;  // or import the type directly
}
```

---

### File 6: `packages/coding-agent/src/prompts/system/swarm-notice.md`

**Rewrite to be bridge-aware:**

```markdown
<system-notice>
The user's message above contains the **swarm** keyword. A SwarmRunner lifecycle
(Script → Stage → Curtain) has been initialized in the background. Your role is
the **Script phase coordinator**. Once you complete the plan and the user confirms,
Stage and Curtain run automatically via the SwarmRunner.

<role>
You are the Script phase coordinator. Your ONLY job is to produce a complete,
executable plan.md. You do NOT execute the plan yourself — the system's
StageController and CurtainRunner handle execution and verification.

Do the following in your turn:
1. **Ingest**: Read every relevant file mentioned in the request.
2. **Plan**: Write a complete plan.md with structured phases. Each phase lists
   parallelizable tasks. Each task specifies target files (≤3-5), the change to
   make, and acceptance criteria.
3. **Track**: Update `todo` with the full phase/task breakdown.
4. **Request Confirmation**: Summarize the plan and ask the user to confirm.
   Use `agent_ask` with options: "Launch Stage", "Revise Plan", "Cancel".

When the user confirms, the system automatically transitions to Stage.
</role>

<plan.md-format>
```markdown
# Swarm Plan: <title>

## Phase 1: <name>
- [ ] Task 1: <description>
  - Files: path/to/file1.ts, path/to/file2.ts
  - Acceptance: <criteria>
- [ ] Task 2: <description>
  - ...

## Phase 2: <name>
...
```
</plan.md-format>

<rules>
- Write the plan with `write` tool to `plan.md`.
- Each phase should be independently verifiable (has its own gate).
- Tasks within a phase MUST be parallelizable (no file overlap).
- If deployment/config changes are needed, include them as explicit phases.
</rules>
</system-notice>
```

---

### File 7: `packages/coding-agent/src/modes/components/status-line.ts` (minimal change)

**Add swarm phase display:**

```typescript
// New field on status line
#swarmPhase: { phase: string; subStatus: string } | undefined;

// New public method
setSwarmPhase(state: { phase: string; subStatus: string; progress?: { currentWave?: number; totalWaves?: number } } | undefined): void {
  this.#swarmPhase = state;
  this.invalidate();
}

// In the rendered output, when swarm is active:
// → [🐝 Swarm: Stage · Wave 2/5]
```

---

### File 8: `packages/coding-agent/src/swarm/core/swarm-runner.ts` (minimal refactor)

**Extract common logic that both standalone CLI and embedded mode share:**

Currently `SwarmRunner.start()` handles both:
- Reading plan.md
- Creating and running StageController
- Running Curtain after Stage completes

This logic should be extractable so `EmbeddedSwarmBridge` can reuse it without the CLI-specific parts (YAML parsing, stdin/stdout I/O).

No actual code changes needed — `SwarmRunner` already has the right abstractions. `EmbeddedSwarmBridge` just instantiates the same services directly (StageController, CurtainRunner) rather than going through `SwarmRunner`.

---

### File 9: `packages/coding-agent/src/agent/agent-profile.ts`

Expose authStorage and modelRegistry from the parent session:

Currently these are private fields on AgentSession. The EmbeddedSwarmBridge needs access to them to create AgentRuntime. Two options:

**Option A**: Expose getters on AgentSession:
```typescript
// In agent-session.ts
get authStorage(): AuthStorage { return this.#authStorage; }
get modelRegistry(): ModelRegistry { return this.#modelRegistry; }
```

**Option B**: Pass them explicitly when constructing EmbeddedSwarmBridge (cleaner, no API surface change to AgentSession).

---

### File 10 (NEW): `packages/coding-agent/src/swarm/core/__tests__/embedded-swarm-bridge.test.ts`

Test coverage for the bridge:
- `init()` creates all services without error
- `onPlanUpdated()` detects plan readiness correctly
- `confirmScript()` validates plan structure
- `confirmScript()` rejects invalid/missing plans
- FSM transitions are correct: script → script-confirm → stage → curtain → idle
- `dispose()` cleans up all resources
- Steering messages route to correct workers
- `applaud()` completes Curtain

---

## Key Design Decisions & Edge Cases

### 1. Plan Storage and Detection

The agent writes plan.md to the project root (or to `.swarm_{sessionId}/.stp/plan.md`). The bridge needs to detect this. Two approaches:

- **Polling (simpler)**: Set up a file watcher on `plan.md` in the project root. When mtime changes, read and call `onPlanUpdated()`.
- **Tool interception (more reliable)**: Hook into agent's tool call pipeline. When `write` is called with a path ending in `plan.md`, capture the content.

Recommend approach 1 (file watcher) because it handles the case where the agent writes plan.md indirectly (e.g. via `bash` script or `edit` tool).

### 2. Human Confirmation Protocol

How does the system know the user confirmed the plan?

- **Option A**: Parse user text for confirmation keywords ("确认", "confirm", "launch", "go ahead", "🚀", etc.)
- **Option B**: Use `agent_ask` tool — the agent explicitly asks, and the user picks from options
- **Option C**: Both — parse for keywords, AND require the agent to call `agent_ask`

Recommend Option C: The SWARM_NOTICE instructs the agent to call `agent_ask("Ready to launch?", ["Launch Stage", "Revise", "Cancel"])`. The input controller also watches for explicit confirm keywords as a fast path.

### 3. What Happens if the User Says "Revise"?

If the user picks "Revise" or types corrections:
- The main agent continues its turn (stays in Script phase)
- It reads the corrections and updates plan.md
- The cycle repeats until user confirms

This is already handled naturally by the normal agent conversation loop — no special FSM transition needed.

### 4. What Happens if Stage Fails?

Stage failures can be:
- **Worker failure** (retryable): StageController retries with exponential backoff (already implemented in P5)
- **Gate failure** (verification): StageController spawns fix-up agents
- **Fatal failure** (unrecoverable): StageController transitions to `paused` or `blocked`, the main agent resumes control, and the user can decide to fix and restart

### 5. Token Budget for Workers

Each worker in Stage needs a token budget. Embedding SwarmRunner in an interactive session means worker tokens share the parent session's billing.

Workers use `@slow` model (Opus-level) by default — this is expensive. Consider:
- Allow workers to use `@fast` by default with `@slow` for review/verification tasks
- Cap total worker tokens at `settings.magicKeywords.swarm.maxTokensPerRun` (default: unlimited)

### 6. Dashboard Polling vs Event-Driven Updates

Currently, `SwarmTuiBinding` subscribes to `WorkflowFsm.onChange()` for phase transitions, but not to StateTracker mutations. The polling loop (200ms) handles StateTracker updates. This is fine for a dashboard — 5fps is imperceptible.

When `SwarmTuiBinding` gains StateTracker subscriptions in the future, the polling can be removed and replaced with pure event-driven rendering.

### 7. Curtain Applaud Flow

The Curtain phase needs a human "applaud" signal. The CurtainRunner already has an `applaudSignal?: AbortSignal` parameter. Implementation:

```typescript
// In EmbeddedSwarmBridge:
async #runCurtain(stageResult: StageResult): Promise<void> {
  const applaudController = new AbortController();
  
  const curtainResult = await runCurtainPipeline(
    stageResult,
    {
      // ... curtain options ...
      applaudSignal: applaudController.signal,
    },
  );
  
  // If not auto-applauding, wait for human
  if (!this.#config.autoApplaud) {
    this.#listener({ phase: "curtain", subStatus: "awaiting applaud" });
    // Wait for applaud() to be called, which resolves the signal
  }
  
  await this.#fsm.transition("idle", { reason: "curtain complete" });
  this.#listener({ phase: "idle", subStatus: "complete" });
}
```

The user applauds by:
- Typing "applaud" / "👏" / "完成" in the editor
- Pressing a keybinding in the dashboard (e.g. Enter)
- Auto-applaud timeout after `magicKeywords.swarm.curtainTimeout` seconds

---

## Implementation Order

| Step | Files | Effort |
|------|-------|--------|
| 1 | `embedded-swarm-bridge.ts` (new) | Core bridge implementation | ~300 lines |
| 2 | `swarm-notice.md` | Rewrite for bridge-aware prompt | ~100 lines |
| 3 | `agent-session.ts` | Add bridge init + tool interception | ~80 lines |
| 4 | `settings-schema.ts` | Add 4 new settings | ~40 lines |
| 5 | `interactive-mode.ts` | Dashboard + status line wiring | ~120 lines |
| 6 | `swarm-dashboard-overlay.ts` | Steering + getComponent | ~30 lines |
| 7 | `status-line.ts` | Swarm phase display | ~30 lines |
| 8 | `agent-session.ts` | Expose authStorage/modelRegistry | ~10 lines |
| 9 | `settings-schema.ts` | Expose ProfileRegistry from session | ~10 lines |
| 10 | Tests | `embedded-swarm-bridge.test.ts` | ~200 lines |

---

## Summary

The full bridge (Scheme 3) is ~920 lines of new/modified code across 10 files. The core complexity is in `EmbeddedSwarmBridge` (~300 lines) which orchestrates the state machine, service assembly, and phase transitions. The TUI work (~180 lines) is straightforward because the dashboard components are already well-factored — they just need real data instead of stubs.

The key insight that makes this feasible: the PhaseBehavior interface (script-behavior, stage-behavior, curtain-behavior) already defines a clean contract for phase lifecycle. SwarmRunner already assembles the full service graph. The bridge just needs to wire them together in the context of an interactive session, with the human user participating through the normal chat flow rather than a CLI REPL.
