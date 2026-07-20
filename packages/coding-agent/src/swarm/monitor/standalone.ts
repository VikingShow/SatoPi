/**
 * Standalone MonitorServer — real swarm backend with REST API + SSE.
 *
 * Bootstraps auth, ModelRegistry, Settings, ExperienceStore, and
 * RoleAssetManager as shared services.  Uses SessionRegistry to
 * create per-session service graphs (SwarmRunManager, BeforeLoopManager,
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
import { discoverAuthStorage } from "../../sdk";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { stampAndArchivePlanMd } from "../before-loop";
import { getSessionPlanPath } from "../plan-paths";
import { BeforeLoopManager } from "../before-loop-manager";
import { ExperienceStore } from "../after-loop";
import type { LoopResult } from "../loop-controller";
import type { LoopSwarmConfig } from "../schema";
import { RoleAssetManager } from "../role-asset";
import type { AfterLoopResult } from "./types";
import { runAfterLoopPipeline } from "./after-loop-runner";
import {
	SessionRegistry,
	type SharedServices,
	type SessionServices,
} from "../session-registry";

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

const DEFAULT_YAML = `name: SatoPi
mode: loop
workspace: .
agents: {}
targetCount: 1
loop:
  maxIterations: 10
  workers:
    initial: 3
    min: 1
    max: 10
    auto: false
  cloners:
    count: 2
  planDebate:
    enabled: true
    clonerCount: 2
    maxRounds: 2
    convergenceThreshold: 0.7
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
	#running = false;
	#lastAfterLoopResult: AfterLoopResult | null = null;
	#loopConfig: LoopSwarmConfig | null = null;

	constructor(opts: {
		modelRegistry: ModelRegistry;
		settings: Settings;
		workspace: string;
		yamlPath: string;
		stateTracker: StateTracker;
		activityLogger: ActivityLogger;
		experienceStore: ExperienceStore;
	}) {
		this.#modelRegistry = opts.modelRegistry;
		this.#settings = opts.settings;
		this.#workspace = opts.workspace;
		this.#yamlPath = opts.yamlPath;
		this.#stateTracker = opts.stateTracker;
		this.#activityLogger = opts.activityLogger;
		this.#experienceStore = opts.experienceStore;
	}

	get isRunning(): boolean { return this.#running; }
	getLastAfterLoopResult(): AfterLoopResult | null { return this.#lastAfterLoopResult; }

	async start(): Promise<{ success: boolean; error?: string }> {
		try {
			const content = await fs.readFile(this.#yamlPath, "utf-8");
			const def = parseSwarmYaml(content);
			const errors = validateSwarmDefinition(def);
			if (errors.length > 0) return { success: false, error: errors.join("; ") };
			if (!def.loopConfig) return { success: false, error: "Swarm is not in loop mode" };

			this.#loopConfig = def.loopConfig;
			await this.#stateTracker.updatePipeline({ loopPhase: "running", status: "running" });
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
			await this.#stateTracker.updatePipeline({ loopPhase: "running", status: "running" });

			this.#loopController = createLoopController(this.#stateTracker, {
				loopConfig: def.loopConfig,
				workspace: this.#workspace,
				activityLogger: this.#activityLogger,
			});

			this.#abortController = new AbortController();
			this.#running = true;
			logger.info("[RunManager] Starting swarm", { name: def.name, agentCount: agentNames.length });

			this.#loopController.runLoop({
				workspace: this.#workspace,
				modelRegistry: this.#modelRegistry,
				settings: this.#settings,
				signal: this.#abortController.signal,
				planContent,
			}).then(async (result) => {
				logger.info("[RunManager] Loop finished", { status: result.status, iterations: result.iterations });
				if (result.errors.length > 0) logger.info("[RunManager] Loop errors", { errors: result.errors });
				await this.#runAfterLoopPipeline(result);
			}).catch((err) => {
				logger.error("[RunManager] Loop failed", { error: String(err) });
			}).finally(() => {
				this.#running = false;
				this.#loopController = null;
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

	async #runAfterLoopPipeline(result: LoopResult): Promise<void> {
		const result_ = await runAfterLoopPipeline(result, {
			workspace: this.#workspace,
			stateTracker: this.#stateTracker,
			activityLogger: this.#activityLogger,
			experienceStore: this.#experienceStore,
			loopConfig: this.#loopConfig,
			modelRegistry: this.#modelRegistry,
			settings: this.#settings,
			loopController: this.#loopController!,
			abortController: this.#abortController,
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

	const runManager = new SwarmRunManager({
		modelRegistry: shared.modelRegistry,
		settings: shared.settings,
		workspace: shared.workspace,
		yamlPath: shared.yamlPath,
		stateTracker,
		activityLogger,
		experienceStore: shared.experienceStore,
	});

	const beforeLoopManager = new BeforeLoopManager({
		modelRegistry: shared.modelRegistry,
		settings: shared.settings,
		workspace: shared.workspace,
		swarmDir,
		yamlPath: shared.yamlPath,
		stateTracker,
		activityLogger,
		experienceStore: shared.experienceStore,
		runManager,
	});

	const steeringSink: SteeringSink = {
		steer(text: string): void {
			activityLogger.logSteering("operator", "all", text);
		},
	};

	return { name, swarmDir, stateTracker, activityLogger, runManager, beforeLoopManager, steeringSink };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
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

	const shared: SharedServices = {
		workspace: WORKSPACE_DIR,
		yamlPath: YAML_PATH,
		modelRegistry,
		settings,
		experienceStore,
		roleAssetManager,
	};

	// Create SessionRegistry and default session
	const registry = new SessionRegistry(shared, createSessionServices);
	const session = await registry.createSession(swarmName);

	// Start MonitorServer (receives the registry)
	const server = new MonitorServer(registry);
	const port = server.start(7878);

	// Wire ActivityLogger → SSE (for real-time GUI updates)
	session.activityLogger.setBroadcaster(server);

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
