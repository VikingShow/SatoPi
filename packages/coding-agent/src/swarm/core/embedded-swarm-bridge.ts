/**
 * EmbeddedSwarmBridge — Bridges interactive agent session ↔ SwarmRunner lifecycle.
 *
 * Created by agent-session when the "swarm" magic keyword is detected.
 * Manages the full Script → Stage → Curtain lifecycle WITHIN an active
 * interactive session, with the human user as a first-class participant.
 *
 * ## Lifecycle
 *   init()           → creates all swarm services, FSM enters "script"
 *   onPlanUpdated()  → called when the agent writes plan.md
 *   confirmScript()  → validates plan, transitions to Stage
 *   steer()          → routes human steering to Stage workers
 *   applaud()        → completes Curtain, transitions to idle
 *   dispose()        → tears down all services
 *
 * ## Integration
 *   agent-session.ts  → creates bridge on magic keyword, calls init()
 *   interactive-mode.ts → reads bridge state for dashboard, status line
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { ProfileRegistry } from "../../agent/agent-profile";
import { RoleAssetManager, type RoleAssetManager as RoleAssetManagerType } from "../../agent/role-asset";
import type { AgentRuntime } from "../agent-runtime";
import { assembleAgentRuntime, type AssemblerOptions } from "./assembler";
import type { LoopSwarmConfig } from "./schema";
import { StateTracker, type Chapter } from "./state";
import { WorkflowFsm, PHASES } from "./workflow-fsm";
import { runCurtainPipeline, type CurtainResultData } from "../curtain/curtain-runner";
import { HookPipeline } from "../hook-system/hook-pipeline";
import { registerBuiltinHooks } from "../hook-system/register-builtins";
import { ActivityLogger } from "../infra/activity-logger";
import { ExperienceStore } from "../curtain/experience";
import { getSessionPlanPath } from "../script/plan-paths";
import { SwarmSessionManager } from "../session/swarm-session-manager";
import { createStageController, type StageResult } from "../stage/stage-controller";

// ============================================================================
// Types
// ============================================================================

export interface EmbeddedSwarmConfig {
	/** Project workspace directory. */
	workspace: string;
	/** Swarm work directory (auto-created as .swarm_{id}/). */
	swarmDir: string;
	/** Model registry for API key resolution. */
	modelRegistry: ModelRegistry;
	/** Settings for model and tool configuration. */
	settings: Settings;
	/** Optional role asset manager for role resolution (auto-created if omitted). */
	roleAssetManager?: RoleAssetManagerType;
	/** Optional profile registry for agent identity. */
	profileRegistry?: ProfileRegistry;
	/** Optional user-specified max worker count (default 4). */
	maxWorkers?: number;
	/** Optional user-specified max rounds (default 3). */
	maxRounds?: number;
	/** Whether to auto-applaud after Curtain (default: false). */
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
	status: string;
	output?: string;
	error?: string;
}

export type SwarmEventCallback = (event: SwarmPhaseEvent | SwarmAgentEvent) => void;

// ============================================================================
// EmbeddedSwarmBridge
// ============================================================================

export class EmbeddedSwarmBridge {
	readonly #config: EmbeddedSwarmConfig;
	#fsm!: WorkflowFsm;
	#stateTracker!: StateTracker;
	#activityLogger!: ActivityLogger;
	#sessionManager!: SwarmSessionManager;
	#experienceStore!: ExperienceStore;
	#hookPipeline!: HookPipeline;
	#runtime!: AgentRuntime;
	#stageController: ReturnType<typeof createStageController> | null = null;
	#planContent = "";
	#planReady = false;
	#listener: SwarmEventCallback;
	#abortController: AbortController | null = null;
	#loopConfig: LoopSwarmConfig;
	#disposed = false;
	/** Human-decision resolver for applaud flow. */
	#applaudResolve: (() => void) | null = null;

	constructor(config: EmbeddedSwarmConfig, listener: SwarmEventCallback) {
		this.#config = config;
		this.#listener = listener;
		this.#loopConfig = {
			maxIterations: config.maxRounds ?? 3,
			autoRetry: true,
			enableDeliberation: false,
			humanEscalation: true,
			agents: {
				initial: config.maxWorkers ?? 4,
				min: 1,
				max: config.maxWorkers ?? 4,
				auto: false,
				maxRounds: config.maxRounds ?? 3,
				roundsConvergenceThreshold: 2,
			},
			debate: { enabled: false, maxRounds: 2 },
			planDebate: { enabled: false, agentCount: 2, maxRounds: 2, convergenceThreshold: 2 },
			convergenceThreshold: 2,
			iterationTimeoutMs: 300_000,
		};
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	/** Initialize all swarm services. Called once after construction. */
	async init(): Promise<void> {
		const { workspace, swarmDir, modelRegistry, settings, profileRegistry } = this.#config;
		let { roleAssetManager } = this.#config;

		// 1. Create swarm workspace directories
		await fs.mkdir(swarmDir, { recursive: true });
		await fs.mkdir(path.join(swarmDir, ".stp"), { recursive: true });

		// 2. Create SwarmSessionManager for persistence
		this.#sessionManager = await SwarmSessionManager.create(swarmDir);

		// 3. Create StateTracker
		const swarmName = path.basename(swarmDir);
		this.#stateTracker = new StateTracker(workspace, swarmName);
		this.#stateTracker.setSessionManager(this.#sessionManager);

		// 4. Create ActivityLogger
		this.#activityLogger = new ActivityLogger(swarmDir, swarmName);
		this.#activityLogger.setSessionManager(this.#sessionManager);

		// 5. Create WorkflowFSM — start in "script" phase
		this.#fsm = new WorkflowFsm(this.#stateTracker, this.#activityLogger, "script");
		for (const def of PHASES) this.#fsm.registerPhase(def);

		// Subscribe to FSM phase changes → forward to listener
		this.#fsm.onChange(event => {
			this.#listener({
				phase: event.to,
				subStatus: event.meta?.reason ?? "",
			});
			// Persist phase in StateTracker
			this.#stateTracker.updatePipeline({ phase: event.to }).catch(() => {});
		});

		// 6. Create ExperienceStore
		this.#experienceStore = new ExperienceStore(workspace);
		await this.#experienceStore.init();

		// 7. Create HookPipeline
		this.#hookPipeline = new HookPipeline();
		registerBuiltinHooks(this.#hookPipeline, {
			experienceStore: this.#experienceStore,
			profileRegistry,
		});

		// 8. Auto-create RoleAssetManager if not provided
		if (!roleAssetManager) {
			roleAssetManager = new RoleAssetManager(workspace);
			await roleAssetManager.init();
		}

		// 9. Assemble AgentRuntime
		const assemblerOpts: AssemblerOptions = {
			modelRegistry,
			settings,
			activityLogger: this.#activityLogger,
			roleAssetManager,
			hookPipeline: this.#hookPipeline,
			experienceStore: this.#experienceStore,
		};
		this.#runtime = assembleAgentRuntime(assemblerOpts);

		// 10. Notify: script phase started
		this.#listener({ phase: "script", subStatus: "planning" });
		logger.info("[EmbeddedSwarmBridge] Initialized", { swarmDir, swarmName });
	}

	/** Tear down all services. Idempotent. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abortController?.abort();
		this.#applaudResolve?.();
		this.#stageController = null;
		this.#planContent = "";
		this.#planReady = false;
		logger.info("[EmbeddedSwarmBridge] Disposed");
	}

	// ── Script Phase ───────────────────────────────────────────────────────

	/** Called by agent-session when the agent writes/updates plan.md. */
	onPlanUpdated(content: string): void {
		this.#planContent = content;
		const hasHeadings = /^#{1,3}\s+/m.test(content);
		const minLength = content.trim().length >= 200;
		this.#planReady = hasHeadings && minLength;
		if (this.#planReady) {
			this.#listener({ phase: "script", subStatus: "plan ready for review" });
			logger.info("[EmbeddedSwarmBridge] Plan ready", { length: content.length });
		}
	}

	/** Get the current plan content. */
	getPlanContent(): string {
		return this.#planContent;
	}

	/** Is the plan ready? (has content and meets minimum structure). */
	isPlanReady(): boolean {
		return this.#planReady;
	}

	/**
	 * Validate the plan & transition to Stage.
	 * Returns validation errors as string[], or empty if valid.
	 */
	async confirmScript(): Promise<string[]> {
		const planPath = getSessionPlanPath(this.#config.swarmDir);

		// Re-read plan from disk
		let planContent: string;
		try {
			planContent = await fs.readFile(planPath, "utf-8");
		} catch {
			return ["plan.md not found — agent must write a plan before confirming"];
		}

		const errors: string[] = [];
		if (!/^#{1,3}\s+/m.test(planContent)) {
			errors.push("plan.md must contain at least one heading section");
		}
		if (planContent.trim().length < 200) {
			errors.push("plan.md is too short (< 200 chars) — plan appears incomplete");
		}
		if (errors.length > 0) return errors;

		this.#planContent = planContent;
		this.#planReady = true;

		// Transition: script → script-confirm
		const confirmResult = await this.#fsm.transition("script-confirm", {
			reason: "human confirmed plan",
		});
		if (!confirmResult.ok) return [confirmResult.reason ?? "FSM rejected script-confirm transition"];

		// Transition: script-confirm → stage
		const stageResult = await this.#fsm.transition("stage", {
			reason: "starting stage execution",
		});
		if (!stageResult.ok) return [stageResult.reason ?? "FSM rejected stage transition"];

		// Start stage asynchronously
		this.#startStage(planContent).catch(err => {
			logger.error("[EmbeddedSwarmBridge] Stage failed", { error: String(err) });
			this.#listener({ phase: "stage", subStatus: `stage failed: ${String(err)}` });
		});

		return [];
	}

	// ── Stage Phase ────────────────────────────────────────────────────────

	async #startStage(planContent: string): Promise<void> {
		const { workspace, modelRegistry, settings, profileRegistry } = this.#config;
		// roleAssetManager is guaranteed to exist after init()
		const roleAssetManager = this.#config.roleAssetManager!;
		const swarmName = this.#stateTracker.state.name;

		this.#abortController = new AbortController();

		this.#stageController = createStageController({
			workspace,
			swarmName,
			planContent,
			loopConfig: this.#loopConfig,
			stateTracker: this.#stateTracker,
			activityLogger: this.#activityLogger,
			modelRegistry,
			settings,
			signal: this.#abortController.signal,
			profileRegistry: profileRegistry!,
			roleAssetManager,
			runtime: this.#runtime,
			hookPipeline: this.#hookPipeline,
			fsm: this.#fsm,
			commBus: this.#runtime.commBus,
		});

		try {
			const result = await this.#stageController.run();
			logger.info("[EmbeddedSwarmBridge] Stage finished", { status: result.status });

			// Transition to curtain
			await this.#fsm.transition("curtain", {
				reason: "stage completed",
				terminalStatus: result.status,
			});

			await this.#runCurtain(result);
		} catch (err) {
			logger.error("[EmbeddedSwarmBridge] Stage error", { error: String(err) });
			if (!this.#disposed) {
				await this.#fsm.transition("blocked", { reason: `stage error: ${String(err)}` }).catch(() => {});
			}
		}
	}

	// ── Curtain Phase ──────────────────────────────────────────────────────

	async #runCurtain(result: StageResult): Promise<void> {
		const { workspace, modelRegistry, settings, profileRegistry } = this.#config;
		const roleAssetManager = this.#config.roleAssetManager;

		const curtainResult: CurtainResultData | null = await runCurtainPipeline(result, {
			workspace,
			stateTracker: this.#stateTracker,
			activityLogger: this.#activityLogger,
			experienceStore: this.#experienceStore,
			loopConfig: this.#loopConfig,
			modelRegistry,
			settings,
			roleAssetManager,
			profileRegistry,
			commBus: this.#runtime.commBus,
		});

		if (!this.#config.autoApplaud) {
			this.#listener({ phase: "curtain", subStatus: "awaiting applaud" });
			// Wait for human applaud
			await new Promise<void>(resolve => {
				this.#applaudResolve = resolve;
			});
		}

		await this.#fsm.transition("idle", { reason: "curtain complete" });
		this.#listener({
			phase: "idle",
			subStatus: "complete",
			progress: curtainResult
				? { totalTasks: curtainResult.totalTasks, completedTasks: curtainResult.totalTasks }
				: undefined,
		});
	}

	/** Complete the Curtain phase with human applaud. */
	applaud(): void {
		this.#applaudResolve?.();
		this.#applaudResolve = null;
	}

	// ── Steering ───────────────────────────────────────────────────────────

	/** Route a human steering message to the current workers. */
	async steer(_message: string): Promise<void> {
		// TODO: Route steering to active workers via CommBus
	}

	/** Pause the current stage. */
	async pauseStage(): Promise<void> {
		this.#abortController?.abort();
		await this.#fsm.transition("paused", { reason: "human paused stage" });
	}

	// ── Accessors ──────────────────────────────────────────────────────────

	get fsm(): WorkflowFsm {
		return this.#fsm;
	}

	get stateTracker(): StateTracker {
		return this.#stateTracker;
	}

	get activityLogger(): ActivityLogger {
		return this.#activityLogger;
	}

	get swarmState() {
		return this.#stateTracker.state;
	}

	get currentPhase(): Chapter {
		return this.#fsm.phase;
	}

	get isRunning(): boolean {
		return !this.#disposed && this.#fsm.state.running;
	}
}
