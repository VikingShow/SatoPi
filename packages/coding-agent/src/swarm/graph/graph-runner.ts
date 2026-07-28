/**
 * GraphRunner — Thin adapter wrapping GraphEngine for ISwarmOrchestrator.
 *
 * Implements ISwarmOrchestrator and NodeExecutor.
 * DAG execution is delegated to GraphEngine; GraphRunner handles
 * per-node behavior lifecycle (prepare → execute → gate → cleanup)
 * and swarm lifecycle (FSM transitions, curtain pipeline).
 *
 * ## Lifecycle
 *   init() → parse graph → build waves → confirmScript():
 *     create GraphEngine → engine.run(this) → curtain → idle
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { ProfileRegistry } from "../../agent/agent-profile";
import { RoleAssetManager } from "../../agent/role-asset";
import type { CheckpointStore } from "../../graph/checkpoint";
import {
	GraphEngine,
	type GraphEngineConfig,
	type GraphRunResult,
	type NodeExecutionContext,
	type NodeExecutor,
} from "../../graph/graph-engine";
import type { GraphRunState } from "../../graph/types";
import { IrcBus } from "../../irc/bus";
import { AgentRegistry } from "../../registry/agent-registry";
import type { SingleResult } from "../../task";
import type { AgentRuntime } from "../agent-runtime";
import { createOrchestratorRuntime } from "../core/assembler";
import { buildExecutionWaves } from "../core/dag";
import type { ISwarmOrchestrator } from "../core/embedded-swarm-bridge";
import type { LoopSwarmConfig } from "../core/schema";
import type { Chapter, SwarmState } from "../core/state";
import { StateTracker } from "../core/state";
import { PHASES, WorkflowFsm } from "../core/workflow-fsm";
import { runCurtainPipeline } from "../curtain/curtain-runner";
import { ExperienceStore } from "../curtain/experience";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import { ActivityLogger } from "../infra/activity-logger";
import { SwarmSessionManager } from "../session/swarm-session-manager";
import { GateController } from "./gate-controller";
import { type NodeBehaviorFactoryConfig, selectNodeBehavior } from "./node-behavior";
import { type GraphDefinition, loadGraphDefinition, type NodeContext, type NodeResult } from "./schema";

export interface GraphRunnerConfig {
	workspace: string;
	graphPath: string;
	modelRegistry: ModelRegistry;
	settings: Settings;
	profileRegistry?: ProfileRegistry;
	maxWorkers?: number;
	maxRounds?: number;
	autoApplaud?: boolean;
	/** Active MMD content for MmdSource context injection. */
	activeMmd?: string;
}

export class GraphRunner implements ISwarmOrchestrator, NodeExecutor {
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
	#graphName!: string;
	#ircBus!: IrcBus;
	#swarmDir!: string;
	#loopConfig!: LoopSwarmConfig;

	constructor(config: GraphRunnerConfig) {
		this.#config = config;
	}

	async init(): Promise<void> {
		const { workspace, modelRegistry, settings, profileRegistry, activeMmd } = this.#config;
		this.#graphName = path.basename(this.#config.graphPath, ".graph.yaml");
		this.#swarmDir = path.join(workspace, ".stp", "sessions", `swarm-${this.#graphName}`);

		this.#graph = await loadGraphDefinition(this.#config.graphPath);

		await fs.mkdir(this.#swarmDir, { recursive: true });
		await fs.mkdir(path.join(this.#swarmDir, ".stp"), { recursive: true });

		this.#sessionManager = await SwarmSessionManager.create(this.#swarmDir);
		this.#stateTracker = new StateTracker(workspace, this.#graphName);
		this.#stateTracker.setSessionManager(this.#sessionManager);
		this.#activityLogger = new ActivityLogger(this.#swarmDir, this.#graphName);
		this.#activityLogger.setSessionManager(this.#sessionManager);
		this.#experienceStore = new ExperienceStore(workspace);
		await this.#experienceStore.init();

		const startPhase = this.#detectStartPhase();
		this.#fsm = new WorkflowFsm(this.#stateTracker, this.#activityLogger, startPhase);
		for (const def of PHASES) this.#fsm.registerPhase(def);

		this.#ircBus = IrcBus.global();

		// Default loop config for PhaseBehavior-backed nodes
		this.#loopConfig = {
			maxIterations: 5,
			autoRetry: true,
			humanEscalation: true,
			agents: { initial: 4, min: 1, max: 12, auto: true, maxRounds: 5, roundsConvergenceThreshold: 3 },
			debate: { enabled: true, maxRounds: 2 },
			planDebate: { enabled: true, agentCount: 2, maxRounds: 3, convergenceThreshold: 2 },
			convergenceThreshold: 2,
			iterationTimeoutMs: 300_000,
			enableDeliberation: true,
		};
		this.#roleAssetManager = new RoleAssetManager(workspace);
		await this.#roleAssetManager.init();
		// Create orchestrator runtime (MarkEnvironment + HookPipeline + builtins + AgentRuntime)
		const orch = createOrchestratorRuntime({
			modelRegistry,
			settings,
			activityLogger: this.#activityLogger,
			roleAssetManager: this.#roleAssetManager,
			experienceStore: this.#experienceStore,
			profileRegistry,
			ircBus: this.#ircBus,
			activeMmd,
		});
		this.#hookPipeline = orch.hookPipeline;
		this.#runtime = orch.runtime;

		this.#gateController = new GateController({ workspace });

		const deps = new Map<string, Set<string>>();
		for (const [id, node] of Object.entries(this.#graph.nodes)) {
			deps.set(id, new Set(node.depends_on ?? []));
		}
		this.#waves = buildExecutionWaves(deps);

		// Mark mode as graph for TUI dashboard rendering
		await this.#stateTracker.updatePipeline({ phase: "stage" }).catch(() => {});
		logger.info("[GraphRunner] Initialized", {
			graph: this.#graphName,
			nodes: Object.keys(this.#graph.nodes).length,
			waves: this.#waves.length,
		});
	}
	/**

	 * Auto-detect the FSM start phase from the graph's first wave.
	 * If the first node in the first wave has type "script", start in "script";
	 * otherwise default to "stage".
	 */
	#detectStartPhase(): Chapter {
		const firstWave = this.#waves[0];
		if (!firstWave || firstWave.length === 0) return "stage";
		const firstNodeId = firstWave[0];
		const firstNode = this.#graph.nodes[firstNodeId];
		if (firstNode?.type === "script") return "script";
		return "stage";
	}
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abortController?.abort();
		this.#applaudResolve?.();
		this.#gateController.removeAllListeners();
		try {
			this.#experienceStore.close();
		} catch {
			/* best-effort */
		}
		logger.info("[GraphRunner] Disposed");
	}

	onPlanUpdated(_content: string): void {}

	// =========================================================================
	// NodeExecutor — per-node behavior lifecycle (called by GraphEngine)
	// =========================================================================

	/**
	 * Execute a single graph node. GraphEngine calls this once per node
	 * during wave scheduling, providing upstream outputs and abort signal.
	 */
	async execute(nodeId: string, execCtx: NodeExecutionContext): Promise<NodeResult> {
		const node = this.#graph.nodes[nodeId];
		if (!node) return { nodeId, success: false, error: `Unknown node: ${nodeId}` };

		await this.#stateTracker.registerAgent(nodeId);
		await this.#stateTracker.updateAgent(nodeId, { status: "running" });

		const behaviorFactoryConfig: NodeBehaviorFactoryConfig = {
			runtime: this.#runtime,
			fsm: this.#fsm,
			hookPipeline: this.#hookPipeline,
			contextPipeline: this.#runtime.contextPipeline,
			workspace: this.#config.workspace,
			swarmDir: this.#swarmDir,
			loopConfig: this.#loopConfig,
		};
		const behavior = selectNodeBehavior(node.type, behaviorFactoryConfig);
		const ctx: NodeContext = {
			node: {
				id: nodeId,
				label: node.label,
				description: node.description,
				role: node.role,
				profileId: node.profile_id,
				tools: node.tools,
				type: node.type ?? "custom",
				dependsOn: node.depends_on ?? [],
			},
			workspace: this.#config.workspace,
			modelRegistry: this.#config.modelRegistry,
			settings: this.#config.settings,
			experience: "",
			signal: this.#abortController!.signal,
			upstreamOutputs: execCtx.upstreamOutputs,
			runtime: this.#runtime,
			agentRegistry: AgentRegistry.global(),
			roleAssetManager: this.#roleAssetManager,
			profileRegistry: this.#config.profileRegistry,
			stateTracker: this.#stateTracker,
			activityLogger: this.#activityLogger,
		};

		try {
			const prepared = await behavior.prepare(ctx);
			const behaviorResult = await behavior.execute(ctx, prepared);

			if (!node.gate) {
				await this.#stateTracker.updateAgent(nodeId, { status: "completed" });
				return { nodeId, success: behaviorResult.success, error: behaviorResult.error };
			}

			let lastGateResult = await this.#gateController.runGate(
				node,
				behaviorResult.output ?? "",
				behaviorResult.success,
			);
			let attempt = 0;
			while (!lastGateResult.passed) {
				const action = await this.#gateController.handleGateFailure(node, lastGateResult, attempt);
				if (action.type === "continue") {
					await this.#stateTracker.updateAgent(nodeId, { status: "completed" });
					return { nodeId, success: true };
				}
				if (action.type === "block") {
					await this.#stateTracker.updateAgent(nodeId, { status: "failed", error: action.reason });
					return { nodeId, success: false, error: action.reason };
				}
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, action.delayMs);
				await promise;
				lastGateResult = await this.#gateController.runGate(
					node,
					behaviorResult.output ?? "",
					behaviorResult.success,
				);
				attempt++;
			}
			if (lastGateResult.passed) {
				await this.#stateTracker.updateAgent(nodeId, { status: "completed" });
				return { nodeId, success: true };
			}
			return { nodeId, success: false, error: lastGateResult.errors.join("; ") };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await this.#stateTracker.updateAgent(nodeId, { status: "failed", error: msg });
			return { nodeId, success: false, error: msg };
		} finally {
			await behavior.cleanup(ctx);
		}
	}

	// =========================================================================
	// ISwarmOrchestrator — confirmScript delegates to GraphEngine
	// =========================================================================

	async confirmScript(): Promise<string[]> {
		await this.#fsm.transition("stage", { reason: "graph execution start" });
		this.#abortController = new AbortController();

		// Build CheckpointStore adapter wrapping SwarmSessionManager.
		const sessionManager = this.#sessionManager;
		const checkpointStore: CheckpointStore = {
			write(state): void {
				sessionManager.appendCustomEntry("graph_checkpoint", state);
			},
			async recover(graphName: string) {
				const raw = await SwarmSessionManager.readRawEntries(sessionManager.swarmDir);
				for (let i = raw.length - 1; i >= 0; i--) {
					const entry = raw[i];
					if (entry.type === "custom" && entry.customType === "graph_checkpoint") {
						const data = entry.data as Record<string, unknown> | undefined;
						if (data?.graphName === graphName) {
							return data as unknown as GraphRunState;
						}
					}
				}
				return null;
			},
		};

		const engineConfig: GraphEngineConfig = {
			graph: this.#graph,
			waves: this.#waves,
			checkpointStore,
			graphName: this.#graphName,
			abortSignal: this.#abortController.signal,
		};
		const engine = new GraphEngine(engineConfig);

		let result: GraphRunResult;
		try {
			result = await engine.run(this);
		} catch (err) {
			logger.error("[GraphRunner] GraphEngine execution failed", { error: String(err) });
			await this.#fsm.transition("blocked", { reason: String(err) }).catch(() => {});
			return [];
		}

		await this.#fsm.transition("curtain", { reason: "graph execution complete" });
		const allSucceeded = result.executionErrors.length === 0;

		// Build agentResults map for curtain pipeline from nodeResults.
		const agentResults = new Map<string, SingleResult[]>();
		for (const [nodeId, nodeResult] of result.nodeResults) {
			agentResults.set(nodeId, [
				{
					index: 0,
					id: nodeId,
					agent: nodeId,
					agentSource: "project",
					task: this.#graph.nodes[nodeId]?.description ?? "",
					exitCode: nodeResult.success ? 0 : 1,
					output: nodeResult.output ?? "",
					stderr: nodeResult.error ?? "",
					truncated: false,
					durationMs: 0,
					tokens: 0,
					requests: 0,
				},
			]);
		}

		await runCurtainPipeline(
			{
				status: allSucceeded ? "completed" : "failed",
				agentResults,
				errors: result.executionErrors,
				agents: result.agentsList,
				taskProgress: { total: result.totalNodes, completed: result.completedCount },
			},
			{
				workspace: this.#config.workspace,
				stateTracker: this.#stateTracker,
				activityLogger: this.#activityLogger,
				experienceStore: this.#experienceStore,
				loopConfig: null,
				modelRegistry: this.#config.modelRegistry,
				settings: this.#config.settings,
				ircBus: this.#runtime.ircBus,
				graphName: this.#graphName,
			},
		);
		await this.#fsm.transition("idle", { reason: "graph complete" });

		return [];
	}

	async steer(message: string): Promise<void> {
		await this.#runtime.ircBus.receiveFromHuman(message);
	}

	applaud(): void {
		this.#applaudResolve?.();
		this.#applaudResolve = null;
	}

	async pauseStage(): Promise<void> {
		this.#abortController?.abort();
		await this.#fsm.transition("paused", { reason: "human paused" });
	}

	get fsm(): WorkflowFsm {
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
		return this.#fsm?.phase ?? null;
	}
	get isRunning(): boolean {
		return !this.#disposed && (this.#fsm?.state.running ?? false);
	}

	get runtime(): AgentRuntime {
		return this.#runtime;
	}
	get graph(): GraphDefinition {
		return this.#graph;
	}
	get gateController(): GateController {
		return this.#gateController;
	}
}
