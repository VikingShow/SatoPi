/**
 * SwarmRunner — loop lifecycle orchestrator for a single swarm session.
 *
 * Implements {@link RunManager} to drive the full Script → Stage → Curtain
 * lifecycle. Extracted from the deleted monitor/standalone.ts with HTTP
 * dependencies removed. All services are injected via constructor.
 *
 * ## Lifecycle
 *   start() → parse swarm.yaml → load plan.md → StageController → Curtain → done
 *   stop()  → abort stage
 *   pause() → abort (pause semantic is mid-stage abort)
 *   resume()→ not supported in loop mode (restart instead)
 */

import * as fs from "node:fs/promises";
import { logger } from "@satopi/pi-utils";
import type { ProfileRegistry } from "../../agent/agent-profile";
import type { RoleAssetManager } from "../../agent/role-asset";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { MarkEnvironment } from "../../coordination";
import type { AgentRuntime } from "../agent-runtime";
import type { LoopSwarmConfig } from "../core/schema";
import { parseSwarmYaml, validateSwarmDefinition } from "../core/schema";
import type { RunManager } from "../core/services";
import type { Chapter, StateTracker, SwarmState } from "../core/state";
import type { WorkflowFsm } from "../core/workflow-fsm";
import { runCurtainPipeline } from "../curtain/curtain-runner";
import type { ExperienceStore } from "../curtain/experience";
import type { CurtainResult } from "../curtain/types";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import type { ActivityLogger } from "../infra/activity-logger";
import type { SwarmHindsightClient } from "../infra/hindsight-adapter";
import type { MnemopiClient } from "../infra/mnemopi-adapter";
import { createStageFeedback } from "../infra/swarm-hooks";
import { stampAndArchivePlanMd } from "../script";
import { getSessionPlanPath } from "../script/plan-paths";
import type { SwarmSessionManager } from "../session/swarm-session-manager";
import { createStageController, type StageResult } from "../stage/stage-controller";
import type { ISwarmOrchestrator } from "./embedded-swarm-bridge";

// ============================================================================
// SwarmRunner
// ============================================================================

/**
 * @deprecated Use {@link GraphRunner} instead.
 */
export class SwarmRunner implements RunManager, ISwarmOrchestrator {
	#abortController: AbortController | null = null;
	#modelRegistry: ModelRegistry;
	#settings: Settings;
	#workspace: string;
	#yamlPath: string;
	#stateTracker: StateTracker;
	#activityLogger: ActivityLogger;
	#experienceStore: ExperienceStore;
	#sessionManager: SwarmSessionManager | undefined;
	#running = false;
	#completionPromise = Promise.withResolvers<void>();
	#lastCurtainResult: CurtainResult | null = null;
	#loopConfig: LoopSwarmConfig | null = null;
	#profileRegistry: ProfileRegistry;
	#markEnvironment: MarkEnvironment;
	#roleAssetManager: RoleAssetManager;
	#hindsightClient: SwarmHindsightClient | null;
	#mnemopiClient: MnemopiClient | null;

	/** v3: Workflow FSM (per-session). */
	#fsm: WorkflowFsm | undefined;
	/** v3: Hook pipeline (per-session). */
	#hookPipeline: HookPipeline | undefined;
	/** v3: AgentRuntime (per-session). */
	#runtime: AgentRuntime | undefined;

	constructor(opts: {
		modelRegistry: ModelRegistry;
		settings: Settings;
		workspace: string;
		yamlPath: string;
		stateTracker: StateTracker;
		activityLogger: ActivityLogger;
		experienceStore: ExperienceStore;
		sessionManager?: SwarmSessionManager;
		profileRegistry: ProfileRegistry;
		markEnvironment: MarkEnvironment;
		roleAssetManager: RoleAssetManager;
		fsm?: WorkflowFsm;
		hookPipeline?: HookPipeline;
		runtime?: AgentRuntime;
		hindsightClient?: SwarmHindsightClient | null;
		mnemopiClient?: MnemopiClient | null;
	}) {
		this.#modelRegistry = opts.modelRegistry;
		this.#settings = opts.settings;
		this.#workspace = opts.workspace;
		this.#yamlPath = opts.yamlPath;
		this.#stateTracker = opts.stateTracker;
		this.#activityLogger = opts.activityLogger;
		this.#experienceStore = opts.experienceStore;
		this.#sessionManager = opts.sessionManager;
		this.#profileRegistry = opts.profileRegistry;
		this.#markEnvironment = opts.markEnvironment;
		this.#roleAssetManager = opts.roleAssetManager;
		this.#fsm = opts.fsm;
		this.#hookPipeline = opts.hookPipeline;
		this.#runtime = opts.runtime;
		this.#hindsightClient = opts.hindsightClient ?? null;
		this.#mnemopiClient = opts.mnemopiClient ?? null;
	}

	get isRunning(): boolean {
		return this.#running;
	}
	getLastCurtainResult(): CurtainResult | null {
		return this.#lastCurtainResult;
	}

	/** Wait for the full Stage → Curtain lifecycle to complete. */
	async waitForCompletion(): Promise<void> {
		return this.#completionPromise.promise;
	}

	async start(agentCount?: number): Promise<{ success: boolean; error?: string }> {
		// Resolve any old completion promise before replacing it so callers
		// waiting on a prior run don't hang forever.
		if (this.#completionPromise) {
			this.#completionPromise.resolve();
		}
		this.#completionPromise = Promise.withResolvers<void>();

		try {
			const content = await fs.readFile(this.#yamlPath, "utf-8");
			const def = parseSwarmYaml(content);
			const errors = validateSwarmDefinition(def);
			if (errors.length > 0) return { success: false, error: errors.join("; ") };
			if (!def.loopConfig) return { success: false, error: "Swarm is not in loop mode" };

			this.#loopConfig = def.loopConfig;
			await this.#stateTracker.updatePipeline({ phase: "stage", status: "running" });
			this.#activityLogger.logPhase("loop-start");

			// Read & stamp plan.md
			const planPath = getSessionPlanPath(this.#stateTracker.swarmDir);
			let planContent: string | undefined;
			try {
				planContent = await stampAndArchivePlanMd(this.#stateTracker.swarmDir, this.#workspace);
				logger.info("[SwarmRunner] plan.md loaded and stamped", { length: planContent?.length ?? 0 });
			} catch {
				try {
					planContent = await fs.readFile(planPath, "utf-8");
					logger.info("[SwarmRunner] plan.md loaded (unstamped fallback)", { length: planContent.length });
				} catch {
					logger.warn("[SwarmRunner] No plan.md found — workers will run without a plan");
				}
			}

			const agentNames = [...def.agents.keys()];
			await this.#stateTracker.init(agentNames, def.targetCount, def.mode);
			await this.#stateTracker.updatePipeline({ phase: "stage", status: "running" });

			this.#abortController = new AbortController();
			this.#running = true;
			logger.info("[SwarmRunner] Starting", { name: def.name, agentCount: agentNames.length });

			// StageController: task-queue-based, event-driven, agent selection
			const stageFeedback = createStageFeedback({
				enabled: def.loopConfig.stigmergy?.enabled ?? true,
				profileRegistry: this.#profileRegistry,
				markEnvironment: this.#markEnvironment,
			});

			const stage = createStageController({
				workspace: this.#workspace,
				swarmName: def.name,
				planContent: planContent ?? "",
				loopConfig: def.loopConfig,
				stateTracker: this.#stateTracker,
				activityLogger: this.#activityLogger,
				modelRegistry: this.#modelRegistry,
				settings: this.#settings,
				signal: this.#abortController.signal,
				profileRegistry: this.#profileRegistry,
				roleAssetManager: this.#roleAssetManager,
				callbacks: stageFeedback,
				agentCount,
				hookPipeline: this.#hookPipeline,
				fsm: this.#fsm,
				runtime: this.#runtime,
				ircBus: this.#runtime?.ircBus,
			});

			stage
				.run()
				.then(async result => {
					logger.info("[SwarmRunner] Stage finished", { status: result.status });
					if (result.errors.length > 0) logger.info("[SwarmRunner] Stage errors", { errors: result.errors });
					await this.#runCurtainPipeline(result);
				})
				.catch(err => {
					logger.error("[SwarmRunner] Stage failed", { error: String(err) });
				})
				.finally(() => {
					this.#running = false;
					this.#abortController = null;
					this.#completionPromise.resolve();
				});

			return { success: true };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	async stop(): Promise<{ success: boolean; error?: string }> {
		if (!this.#running) return { success: false, error: "No run in progress" };
		this.#abortController?.abort();
		this.#running = false;
		return { success: true };
	}

	async pause(): Promise<{ success: boolean; error?: string }> {
		if (!this.#running) return { success: false, error: "No run in progress" };
		this.#abortController?.abort();
		return { success: true };
	}

	async resume(): Promise<{ success: boolean; error?: string }> {
		return { success: false, error: "Resume not supported in Stage mode. Restart the run instead." };
	}

	async updatePlanAndContinue(_newPlan: string): Promise<{ success: boolean; error?: string }> {
		return { success: false, error: "Update-plan-and-continue not supported. Restart the run instead." };
	}

	resolveBlocker(decision: "continue" | "skip" | "abort"): boolean {
		if (decision === "abort") this.#abortController?.abort();
		return true;
	}

	async #runCurtainPipeline(result: StageResult): Promise<void> {
		const result_ = await runCurtainPipeline(result, {
			workspace: this.#workspace,
			stateTracker: this.#stateTracker,
			activityLogger: this.#activityLogger,
			experienceStore: this.#experienceStore,
			loopConfig: this.#loopConfig,
			modelRegistry: this.#modelRegistry,
			settings: this.#settings,
			roleAssetManager: this.#roleAssetManager,
			profileRegistry: this.#profileRegistry,
			ircBus: this.#runtime?.ircBus,
			hindsightClient: this.#hindsightClient,
			mnemopiClient: this.#mnemopiClient,
		});
		if (result_) this.#lastCurtainResult = { ...result_, iterations: result_.totalTasks };
	}

	// =====================================================================
	// ISwarmOrchestrator implementation
	// =====================================================================

	/** Initialize the orchestrator. Lightweight — heavy setup is in {@link start}. */
	async init(): Promise<void> {
		// SwarmRunner in CLI mode does its setup lazily in start().
		// This is a no-op for interface compatibility with EmbeddedSwarmBridge.
	}

	/** Tear down all services. Stops any in-progress run. */
	async dispose(): Promise<void> {
		if (this.#running) {
			this.#abortController?.abort();
		}
		this.#completionPromise.resolve();
	}

	/** Called when plan.md is written/updated by the agent. */
	onPlanUpdated(_content: string): void {
		// SwarmRunner in CLI mode reads plan.md from disk in start().
		// No-op for interface compatibility.
	}

	/**
	 * Validate the plan and prepare for Stage execution.
	 * In CLI mode this returns any issues found with the plan.
	 */
	async confirmScript(): Promise<string[]> {
		const issues: string[] = [];
		try {
			const planPath = getSessionPlanPath(this.#stateTracker.swarmDir);
			const content = await fs.readFile(planPath, "utf-8");
			if (content.trim().length < 50) {
				issues.push("Plan is too short — needs at least 50 characters.");
			}
		} catch {
			issues.push("No plan.md found. Create one before confirming the script.");
		}
		return issues;
	}

	/** Set agent type and count from plan review confirmation TUI. */
	setAgentConfig(_opts: { agentType?: "swift" | "persistent"; agentCount?: number }): void {
		// CLI-mode swarm runner uses its own agent count, not the TUI.
	}

	/** Route a human steering message to Stage workers. */
	async steer(message: string): Promise<void> {
		if (this.#runtime?.ircBus) {
			await this.#runtime.ircBus.receiveFromHuman(message);
		}
	}

	/** Complete the Curtain phase with human applaud. No-op in CLI mode. */
	applaud(): void {
		// CLI mode doesn't use human-decision flow for Curtain.
	}

	/** Pause the current stage by aborting via the abort controller. */
	async pauseStage(): Promise<void> {
		this.#abortController?.abort();
	}

	// ── Readonly accessors ──────────────────────────────────────────

	get fsm(): WorkflowFsm {
		if (!this.#fsm) throw new Error("WorkflowFsm not configured for this SwarmRunner");
		return this.#fsm;
	}

	get stateTracker(): StateTracker {
		return this.#stateTracker;
	}

	get activityLogger(): ActivityLogger {
		return this.#activityLogger;
	}

	get swarmState(): Readonly<SwarmState> {
		return this.#stateTracker.state;
	}

	get currentPhase(): Chapter | null {
		return this.#fsm?.phase ?? this.#stateTracker.state.phase ?? null;
	}

	get runtime(): AgentRuntime {
		if (!this.#runtime) throw new Error("AgentRuntime not configured for this SwarmRunner");
		return this.#runtime;
	}
}
