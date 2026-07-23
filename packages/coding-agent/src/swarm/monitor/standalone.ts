/**
 * Standalone MonitorServer — real swarm backend with REST API + SSE.
 *
 * Bootstraps auth, ModelRegistry, Settings, ExperienceStore, and
 * RoleAssetManager as shared services.  Uses SessionRegistry to
 * create per-session service graphs (SwarmRunManager, ScriptManager,
 * ActivityLogger, etc.) on demand.
 *
 * Usage: bun run src/swarm/monitor/standalone.ts [workspace-dir]
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";
import { StateTracker } from "../state";
import { MonitorServer } from "./server";
import { ActivityLogger } from "../activity-logger";
import type { RunManager, SteeringSink } from "./api-routes";
import { parseSwarmYaml, validateSwarmDefinition } from "../schema";
import { createLoopController } from "../loop-controller";
import { createStageController } from "../stage/stage-controller";
import { discoverAuthStorage } from "../../sdk";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { stampAndArchivePlanMd } from "../script-planner";
import { getSessionPlanPath } from "../plan-paths";
import { ScriptManager } from "../script-manager";
import { ExperienceStore } from "../after-loop";
import type { LoopResult } from "../loop-controller";
import type { LoopSwarmConfig } from "../schema";
import type { SwarmSessionManager } from "../swarm-session-manager";
import { RoleAssetManager } from "../role-asset";
import type { AfterLoopResult } from "./types";
import { runCurtainPipeline } from "./curtain-runner";
import {
	SessionRegistry,
	type SharedServices,
	type SessionServices,
} from "../session-registry";
import { ProfileRegistry } from "../agent-profile";
import { MarkEnvironment } from "../mark-environment";
import { createSwarmHooks } from "../swarm-hooks";

// ============================================================================
// Workspace setup
// ============================================================================

const WORKSPACE_DIR = path.resolve(process.argv[2] ?? process.cwd(), ".swarm-workspace");
const DEFAULT_SWARM_NAME = "SatoPi";
const YAML_PATH = path.join(WORKSPACE_DIR, "loop.yaml");

async function resolveSwarmName(yamlPath: string): Promise<string> {
	try {
		const content = await fs.readFile(yamlPath, "utf-8");
		const def = parseSwarmYaml(content);
		return def.name || DEFAULT_SWARM_NAME;
	} catch {
		return DEFAULT_SWARM_NAME;
	}
}

const DEFAULT_YAML = `swarm:
  name: SatoPi
  mode: loop
  workspace: .
  target_count: 1
  max_iterations: 10
  agents:
    initial: 3
    min: 1
    max: 10
    auto: false
    reviewers: 2
  plan_debate:
    enabled: true
    agent_count: 2
    max_rounds: 2
    convergence_threshold: 0.7
`;

// ============================================================================
// SwarmRunManager — loop lifecycle for a single session
// ============================================================================

class SwarmRunManager implements RunManager {
	#loopController: ReturnType<typeof createLoopController> | null = null;
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
	#lastAfterLoopResult: AfterLoopResult | null = null;
	#loopConfig: LoopSwarmConfig | null = null;
	/** P7: Agent identity registry (workspace-scoped, shared). */
	#profileRegistry: ProfileRegistry;
	/** P7: Stigmergy mark environment (per-session). */
	#markEnvironment: MarkEnvironment;
	/** Role asset manager for role-based prompts and tools. */
	#roleAssetManager: RoleAssetManager;

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
	}


		setSessionManager(sm: SwarmSessionManager): void { this.#sessionManager = sm; }
	get isRunning(): boolean { return this.#running; }
	getLastAfterLoopResult(): AfterLoopResult | null { return this.#lastAfterLoopResult; }

	async start(): Promise<{ success: boolean; error?: string }> {

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

			// Read & stamp plan.md — per-session: {swarmDir}/.omp/plan.md
			const planPath = getSessionPlanPath(this.#stateTracker.swarmDir);
			let planContent: string | undefined;
			try {
				planContent = await stampAndArchivePlanMd(this.#stateTracker.swarmDir, this.#workspace);
				logger.info("[RunManager] plan.md loaded and stamped", { length: planContent.length });
			} catch {
				try {
					planContent = await fs.readFile(planPath, "utf-8");
					logger.info("[RunManager] plan.md loaded (unstamped fallback)", { length: planContent.length });
				} catch {
					logger.warn("[RunManager] No plan.md found — workers will run without a plan");
				}
			}

			const agentNames = [...def.agents.keys()];
			await this.#stateTracker.init(agentNames, def.targetCount, def.mode);
			await this.#stateTracker.updatePipeline({ phase: "stage", status: "running" });

			this.#abortController = new AbortController();
			this.#running = true;
			logger.info("[RunManager] Starting swarm", { name: def.name, agentCount: agentNames.length });

			// Choose execution engine:
			// - StageController (new): task-queue-based, event-driven, agent selection
			// - LoopController (legacy): iteration-based, round-robin
			const useStageController = planContent != null && planContent.length > 0;

			if (useStageController && planContent) {
				const stage = createStageController({
					workspace: this.#workspace,
					swarmName: def.name,
					planContent,
					loopConfig: def.loopConfig,
					stateTracker: this.#stateTracker,
					activityLogger: this.#activityLogger,
					modelRegistry: this.#modelRegistry,
					settings: this.#settings,
					signal: this.#abortController.signal,
					profileRegistry: this.#profileRegistry,
					roleAssetManager: this.#roleAssetManager,
				});

				stage.run().then(async (result) => {
					logger.info("[RunManager] Stage finished", { status: result.status });
					if (result.errors.length > 0) logger.info("[RunManager] Stage errors", { errors: result.errors });
					await this.#runCurtainPipeline({
						status: result.status === "completed" ? "completed" : "failed",
						iterations: 1,
						reviewVerdicts: [],
						errors: result.errors,
					});
				}).catch((err) => {
					logger.error("[RunManager] Stage failed", { error: String(err) });
				}).finally(() => {
					this.#running = false;
					this.#abortController = null;
				});
			} else {
				// Legacy LoopController fallback
				this.#loopController = createLoopController(this.#stateTracker, {
					loopConfig: def.loopConfig,
					workspace: this.#workspace,
					activityLogger: this.#activityLogger,
				});

				const swarmHooks = createSwarmHooks({
					enabled: this.#loopConfig.stigmergy?.enabled ?? false,
					profileRegistry: this.#profileRegistry,
					markEnvironment: this.#markEnvironment,
				});

				this.#loopController.runLoop({
					workspace: this.#workspace,
					modelRegistry: this.#modelRegistry,
					settings: this.#settings,
					signal: this.#abortController.signal,
					planContent,
					hooks: swarmHooks.hooks,
					getAgentContext: swarmHooks.context.getAgentContext,
				}).then(async (result) => {
					logger.info("[RunManager] Loop finished", { status: result.status, iterations: result.iterations });
					if (result.errors.length > 0) logger.info("[RunManager] Loop errors", { errors: result.errors });
					await this.#runCurtainPipeline(result);
				}).catch((err) => {
					logger.error("[RunManager] Loop failed", { error: String(err) });
				}).finally(() => {
					this.#running = false;
					this.#loopController = null;
					this.#abortController = null;
				});
			}

			return { success: true };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	async stop(): Promise<{ success: boolean; error?: string }> {
		if (!this.#running) return { success: false, error: "No run in progress" };
		this.#abortController?.abort();
		this.#running = false;
		logger.info("[RunManager] Stop signal sent");
		return { success: true };
	}

	async pause(): Promise<{ success: boolean; error?: string }> {
		if (!this.#loopController) return { success: false, error: "No loop controller available" };
		this.#loopController.pause();
		return { success: true };
	}

	async resume(): Promise<{ success: boolean; error?: string }> {
		if (!this.#loopController) return { success: false, error: "No loop controller available" };
		this.#loopController.resume();
		return { success: true };
	}

	async updatePlanAndContinue(newPlan: string): Promise<{ success: boolean; error?: string }> {
		if (!this.#loopController) return { success: false, error: "No loop controller available" };
		await this.#loopController.updatePlan(newPlan, this.#stateTracker.swarmDir);
		this.#loopController.resume();
		return { success: true };
	}

	resolveBlocker(decision: "continue" | "skip" | "abort"): boolean {
		return this.#loopController?.resolveBlocker(decision) ?? false;
	}

	async #runCurtainPipeline(result: LoopResult): Promise<void> {
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
		if (result_) this.#lastAfterLoopResult = result_;
	}
}

// ============================================================================
// Session factory
// ============================================================================

async function createSessionServices(
	shared: SharedServices,
	name: string,
	swarmDir: string,
): Promise<Omit<SessionServices, "abortController">> {
	const stateTracker = new StateTracker(shared.workspace, name);
	const activityLogger = new ActivityLogger(swarmDir, name);

	// Wire real-time state change notifications — every updateAgent /
	// updatePipeline call is pushed to SSE so the frontend reflects
	// agent status / scores / loop iteration / todos / token usage
	// without a 5s polling delay.
	stateTracker.setStateChangeNotifier((event) => {
		if (event.type === "agent_state") {
			activityLogger.logAgentState(event.agent as string, {
				status: event.status as string | undefined,
				iteration: event.iteration as number | undefined,
				praiseCount: event.praiseCount as number | undefined,
				criticismCount: event.criticismCount as number | undefined,
				conflictCount: event.conflictCount as number | undefined,
				role: event.role as string | undefined,
				modelName: event.modelName as string | undefined,
			});
		} else {
			activityLogger.logPipelineState({
				loopIteration: event.loopIteration as number | undefined,
				roundtablePhase: event.roundtablePhase as string | undefined,
				todos: event.todos as unknown[] | undefined,
				totalTokens: event.totalTokens as number | undefined,
				totalRequests: event.totalRequests as number | undefined,
			});
		}
	});

	const markEnvironment = new MarkEnvironment();

	const runManager = new SwarmRunManager({
		modelRegistry: shared.modelRegistry,
		settings: shared.settings,
		workspace: shared.workspace,
		yamlPath: shared.yamlPath,
		stateTracker,
		activityLogger,
		experienceStore: shared.experienceStore,
		profileRegistry: shared.profileRegistry,
		markEnvironment,
		roleAssetManager: shared.roleAssetManager,
	});

	const scriptManager = new ScriptManager({
		modelRegistry: shared.modelRegistry,
		settings: shared.settings,
		workspace: shared.workspace,
		swarmDir,
		yamlPath: shared.yamlPath,
		stateTracker,
		activityLogger,
		experienceStore: shared.experienceStore,
		runManager,
		profileRegistry: shared.profileRegistry,
		roleAssetManager: shared.roleAssetManager,
	});

	const steeringSink: SteeringSink = {
		steer(text: string): void {
			activityLogger.logSteering("operator", "all", text);
		},
	};

	return { name, swarmDir, stateTracker, activityLogger, runManager, scriptManager, steeringSink };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	if (process.env.OMP_CONSOLE_LOG) {
		logger.setTransports({ console: true, file: true });
	}

	await fs.mkdir(WORKSPACE_DIR, { recursive: true });
	try { await fs.access(YAML_PATH); } catch {
		await fs.writeFile(YAML_PATH, DEFAULT_YAML, "utf-8");
	}

	const swarmName = await resolveSwarmName(YAML_PATH);
	const swarmDir = path.join(WORKSPACE_DIR, `.swarm_${swarmName}`);
	await fs.mkdir(swarmDir, { recursive: true });

	logger.info("Bootstrapping auth and model registry...");
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated();

	logger.info("Initializing ExperienceStore...");
	const experienceStore = new ExperienceStore(WORKSPACE_DIR);
	await experienceStore.init();

	logger.info("Initializing RoleAssetManager...");
	const roleAssetManager = new RoleAssetManager(WORKSPACE_DIR);
	await roleAssetManager.init();
	const seeded = await roleAssetManager.seedIfEmpty();
	if (seeded > 0) logger.info(`Seeded ${seeded} built-in role assets`);

	logger.info("Initializing ProfileRegistry (Agent identity system)...");
	const profileRegistry = new ProfileRegistry();

	const shared: SharedServices = {
		workspace: WORKSPACE_DIR,
		yamlPath: YAML_PATH,
		modelRegistry,
		settings,
		experienceStore,
		roleAssetManager,
		profileRegistry,
	};

	// Create SessionRegistry.  We delay session creation until AFTER the
	// MonitorServer is started so the broadcaster can be auto-injected into
	// every session (including those created later via the REST API).
	const registry = new SessionRegistry(shared, createSessionServices);

	// Start MonitorServer first — we need the server instance to register
	// as the broadcaster before any sessions are created.
	const server = new MonitorServer(registry);
	const port = server.start(7878);

	// Register broadcaster with the registry.  From this point on, every
	// createSession() call automatically wires the SSE broadcaster.
	registry.setBroadcaster(server);

	// Now create sessions — broadcaster is auto-injected into each one.
	const session = await registry.createSession(swarmName);

	// Discover and restore sessions from previous runs.
	try {
		const entries = await fs.readdir(WORKSPACE_DIR);
		for (const entry of entries) {
			if (!entry.startsWith(".swarm_")) continue;
			const name = entry.replace(".swarm_", "");
			if (name === swarmName || registry.getSession(name)) continue;
			await registry.createSession(name);
			logger.info("Restored historical session", { name });
		}
	} catch { /* best-effort */ }

	logger.info([
		``,
		`┌──────────────────────────────────────────────────┐`,
		`│  SatoPi MonitorServer (multi-session backend)    │`,
		`│  Default session: ${swarmName.padEnd(33)}│`,
		`│  API:   http://0.0.0.0:${String(port).padEnd(24)}│`,
		`│  SSE:   http://0.0.0.0:${port}/events?session=${swarmName.padEnd(10)}│`,
		`│  State: http://0.0.0.0:${port}/api/session/${swarmName}/state│`,
		`│  YAML:  ${YAML_PATH.slice(0, 37).padEnd(37)}│`,
		`└──────────────────────────────────────────────────┘`,
	].join("\n"));

	const shutdown = () => {
		logger.info("Shutting down...");
		if (session.runManager.isRunning) session.runManager.stop().catch(() => {});
		registry.destroyAll().catch(() => {});
		server.stop();
		experienceStore.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	logger.error("Failed to start MonitorServer:", { error: String(err) });
	process.exit(1);
});
