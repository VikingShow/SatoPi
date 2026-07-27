/**
 * GraphRunner — Core orchestrator for Theatre Graph execution.
 *
 * Implements ISwarmOrchestrator so it's a drop-in replacement for
 * EmbeddedSwarmBridge in agent-session and the TUI.
 *
 * ## Lifecycle
 *   init() → parse graph → build waves → for each wave:
 *     spawn nodes → wait → run gates → handle failures
 *   → curtain → idle
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { ProfileRegistry } from "../../agent/agent-profile";
import { RoleAssetManager } from "../../agent/role-asset";
import type { AgentRuntime } from "../agent-runtime";
import { assembleAgentRuntime, type AssemblerOptions } from "../core/assembler";
import type { Chapter, SwarmState } from "../core/state";
import { StateTracker } from "../core/state";
import { WorkflowFsm, PHASES } from "../core/workflow-fsm";
import { runCurtainPipeline } from "../curtain/curtain-runner";
import { ExperienceStore } from "../curtain/experience";
import { HookPipeline } from "../hook-system/hook-pipeline";
import { registerBuiltinHooks } from "../hook-system/register-builtins";
import { ActivityLogger } from "../infra/activity-logger";
import { SwarmSessionManager } from "../session/swarm-session-manager";
import type { ISwarmOrchestrator } from "../core/embedded-swarm-bridge";
import { buildExecutionWaves } from "../core/dag";
import { loadGraphDefinition, type GraphDefinition, type NodeResult } from "./schema";
import { WaveScheduler, type SchedulingStrategy } from "./graph-executor";
import { CustomNodeBehavior } from "./node-behavior";
import { GateController } from "./gate-controller";

export interface GraphRunnerConfig {
	workspace: string;
	graphPath: string;
	modelRegistry: ModelRegistry;
	settings: Settings;
	profileRegistry?: ProfileRegistry;
	maxWorkers?: number;
	maxRounds?: number;
	autoApplaud?: boolean;
}

export class GraphRunner implements ISwarmOrchestrator {
	readonly #config: GraphRunnerConfig;
	#fsm!: WorkflowFsm;
	#stateTracker!: StateTracker;
	#activityLogger!: ActivityLogger;
	#sessionManager!: SwarmSessionManager;
	#experienceStore!: ExperienceStore;
	#hookPipeline!: HookPipeline;
	#runtime!: AgentRuntime;
	#graph!: GraphDefinition;
	#waves!: string[][];
	#abortController: AbortController | null = null;
	#disposed = false;
	#applaudResolve: (() => void) | null = null;
	#roleAssetManager!: RoleAssetManager;
	#gateController!: GateController;

	constructor(config: GraphRunnerConfig) {
		this.#config = config;
	}

	async init(): Promise<void> {
		const { workspace, modelRegistry, settings, profileRegistry } = this.#config;
		const graphName = path.basename(this.#config.graphPath, ".graph.yaml");
		const swarmDir = path.join(workspace, `.swarm_${graphName}`);

		this.#graph = await loadGraphDefinition(this.#config.graphPath);

		await fs.mkdir(swarmDir, { recursive: true });
		await fs.mkdir(path.join(swarmDir, ".stp"), { recursive: true });

		this.#sessionManager = await SwarmSessionManager.create(swarmDir);
		this.#stateTracker = new StateTracker(workspace, graphName);
		this.#stateTracker.setSessionManager(this.#sessionManager);
		this.#activityLogger = new ActivityLogger(swarmDir, graphName);
		this.#activityLogger.setSessionManager(this.#sessionManager);
		this.#experienceStore = new ExperienceStore(workspace);
		await this.#experienceStore.init();

		this.#fsm = new WorkflowFsm(this.#stateTracker, this.#activityLogger, "stage");
		for (const def of PHASES) this.#fsm.registerPhase(def);

		this.#hookPipeline = new HookPipeline();
		registerBuiltinHooks(this.#hookPipeline, { experienceStore: this.#experienceStore, profileRegistry });

		this.#roleAssetManager = new RoleAssetManager(workspace);
		await this.#roleAssetManager.init();
		this.#runtime = assembleAgentRuntime({
			modelRegistry, settings,
			activityLogger: this.#activityLogger,
			roleAssetManager: this.#roleAssetManager,
			hookPipeline: this.#hookPipeline,
			experienceStore: this.#experienceStore,
		});

		this.#gateController = new GateController({ workspace });

		const deps = new Map<string, Set<string>>();
		for (const [id, node] of Object.entries(this.#graph.nodes)) {
			deps.set(id, new Set(node.depends_on ?? []));
		}
		this.#waves = buildExecutionWaves(deps);

		// Mark mode as graph for TUI dashboard rendering
		await this.#stateTracker.updatePipeline({ phase: "stage" }).catch(() => {});
		logger.info("[GraphRunner] Initialized", {
			graph: graphName,
			nodes: Object.keys(this.#graph.nodes).length,
			waves: this.#waves.length,
		});
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abortController?.abort();
		this.#applaudResolve?.();
		this.#gateController.removeAllListeners();
		logger.info("[GraphRunner] Disposed");
	}

	onPlanUpdated(_content: string): void {}

	async confirmScript(): Promise<string[]> {
		await this.#fsm.transition("stage", { reason: "graph execution start" });
		this.#abortController = new AbortController();

		const graph = this.#graph;
		const stateTracker = this.#stateTracker;
		const workspace = this.#config.workspace;
		const modelRegistry = this.#config.modelRegistry;
		const settings = this.#config.settings;
		const abortSignal = this.#abortController.signal;
		const runtime = this.#runtime;
		const gateController = this.#gateController;

		const scheduler: SchedulingStrategy = new WaveScheduler();

		try {
			await scheduler.schedule(this.#waves, {
				async runNode(nodeId: string): Promise<NodeResult> {
					const node = graph.nodes[nodeId];
					if (!node) return { nodeId, success: false, error: `Unknown node: ${nodeId}` };

					await stateTracker.registerAgent(nodeId);
					await stateTracker.updateAgent(nodeId, { status: "running" });

					try {
						const behavior = new CustomNodeBehavior();
						const prepared = await behavior.prepare({
							node: {
								id: nodeId,
								label: node.label,
								description: node.description,
								role: node.role,
								tools: node.tools,
								type: node.type ?? "custom",
								dependsOn: node.depends_on ?? [],
							},
							workspace,
							modelRegistry,
							settings,
							upstreamOutputs: {},
							experience: "",
							signal: abortSignal,
							runtime,
						});

						const behaviorResult = await behavior.execute({
							node: {
								id: nodeId,
								label: node.label,
								description: node.description,
								role: node.role,
								tools: node.tools,
								type: node.type ?? "custom",
								dependsOn: node.depends_on ?? [],
							},
							workspace,
							modelRegistry,
							settings,
							upstreamOutputs: {},
							experience: "",
							signal: abortSignal,
							runtime,
						}, prepared);

						if (!node.gate) {
							await stateTracker.updateAgent(nodeId, { status: "completed" });
							return { nodeId, success: behaviorResult.success, error: behaviorResult.error };
						}

						const gateResult = await gateController.runGate(node, behaviorResult.output ?? "");
						if (gateResult.passed) {
							await stateTracker.updateAgent(nodeId, { status: "completed" });
							return { nodeId, success: true };
						}

						return { nodeId, success: false, error: gateResult.errors.join("; ") };
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						await stateTracker.updateAgent(nodeId, { status: "failed", error: msg });
						return { nodeId, success: false, error: msg };
					}
				},
				onNodeComplete(_nodeId, _result) {},
			});

			await this.#fsm.transition("curtain", { reason: "graph execution complete" });
			await runCurtainPipeline(
				{
					status: "completed", agentResults: new Map(), errors: [], agents: [],
					taskProgress: { total: Object.keys(this.#graph.nodes).length, completed: Object.keys(this.#graph.nodes).length },
				},
				{
					workspace, stateTracker: this.#stateTracker,
					activityLogger: this.#activityLogger,
					experienceStore: this.#experienceStore,
					loopConfig: null, modelRegistry, settings,
					commBus: this.#runtime.commBus,
				},
			);
			await this.#fsm.transition("idle", { reason: "graph complete" });
		} catch (err) {
			logger.error("[GraphRunner] Execution failed", { error: String(err) });
			await this.#fsm.transition("blocked", { reason: String(err) }).catch(() => {});
		}

		return [];
	}

	async steer(message: string): Promise<void> {
		await this.#runtime.commBus.receiveFromHuman(message);
	}

	applaud(): void {
		this.#applaudResolve?.();
		this.#applaudResolve = null;
	}

	async pauseStage(): Promise<void> {
		this.#abortController?.abort();
		await this.#fsm.transition("paused", { reason: "human paused" });
	}

	get fsm(): WorkflowFsm { return this.#fsm; }
	get stateTracker(): StateTracker { return this.#stateTracker; }
	get activityLogger(): ActivityLogger { return this.#activityLogger; }
	get swarmState(): Readonly<SwarmState> { return this.#stateTracker.state; }
	get currentPhase(): Chapter { return this.#fsm.phase; }
	get isRunning(): boolean { return !this.#disposed && this.#fsm.state.running; }
	get graph(): GraphDefinition { return this.#graph; }
	get gateController(): GateController { return this.#gateController; }
}
