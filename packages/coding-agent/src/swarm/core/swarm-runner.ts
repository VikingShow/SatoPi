/**
 * SwarmRunner — loop lifecycle orchestrator for a single swarm session.
 *
 * Implements {@link RunManager} to drive the full Script → Stage → Curtain
 * lifecycle. Extracted from the deleted monitor/standalone.ts with HTTP
 * dependencies removed. All services are injected via constructor.
 *
 * ## Lifecycle
 *   start() → parse loop.yaml → load plan.md → StageController → Curtain → done
 *   stop()  → abort stage
 *   pause() → abort (pause semantic is mid-stage abort)
 *   resume()→ not supported in loop mode (restart instead)
 */

import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ActivityLogger } from "../hooks/activity-logger";
import type { ExperienceStore } from "../curtain/experience";
import type { RunManager } from "../core/services";
import type { LoopSwarmConfig } from "../core/schema";
import { parseSwarmYaml, validateSwarmDefinition } from "../core/schema";
import type { StateTracker } from "../core/state";
import type { CurtainResult } from "../curtain/types";
import { createStageController, type StageResult } from "../stage/stage-controller";
import { createStageFeedback } from "../hooks/swarm-hooks";
import { runCurtainPipeline } from "../curtain/curtain-runner";
import { stampAndArchivePlanMd } from "../script";
import { getSessionPlanPath } from "../script/plan-paths";
import type { WorkflowFsm } from "../core/workflow-fsm";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import type { AgentRuntime } from "../agent-runtime";
import type { ProfileRegistry } from "../agent/agent-profile";
import type { MarkEnvironment } from "../coordination/mark-environment";
import type { RoleAssetManager } from "../agent/role-asset";
import type { SwarmSessionManager } from "../session/swarm-session-manager";

// ============================================================================
// SwarmRunner
// ============================================================================

export class SwarmRunner implements RunManager {
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
	#lastCurtainResult: CurtainResult | null = null;
	#loopConfig: LoopSwarmConfig | null = null;
	#profileRegistry: ProfileRegistry;
	#markEnvironment: MarkEnvironment;
	#roleAssetManager: RoleAssetManager;

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
	}

	setSessionManager(sm: SwarmSessionManager): void { this.#sessionManager = sm; }
	get isRunning(): boolean { return this.#running; }
	getLastCurtainResult(): CurtainResult | null { return this.#lastCurtainResult; }

	async start(agentCount?: number): Promise<{ success: boolean; error?: string }> {
		// Rotate session file so each Run gets a clean history slate.
		try { await this.#sessionManager?.rotate(); } catch { /* best-effort */ }

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
			});

			stage.run().then(async (result) => {
				logger.info("[SwarmRunner] Stage finished", { status: result.status });
				if (result.errors.length > 0) logger.info("[SwarmRunner] Stage errors", { errors: result.errors });
				await this.#runCurtainPipeline(result);
			}).catch((err) => {
				logger.error("[SwarmRunner] Stage failed", { error: String(err) });
			}).finally(() => {
				this.#running = false;
				this.#abortController = null;
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
		});
		if (result_) this.#lastCurtainResult = { ...result_, iterations: result_.totalTasks };
	}
}
