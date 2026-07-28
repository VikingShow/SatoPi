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
import type { ContextPipeline } from "../context-manager/context-pipeline";
import { IrcBus } from "../../irc/bus";
import { RoleAssetManager } from "../../agent/role-asset";
import type { AgentRuntime } from "../agent-runtime";
import { assembleAgentRuntime, type AssemblerOptions } from "../core/assembler";
import type { Chapter, SwarmState } from "../core/state";
import { StateTracker } from "../core/state";
import type { LoopSwarmConfig } from "../core/schema";
import { WorkflowFsm, PHASES } from "../core/workflow-fsm";
import { runCurtainPipeline } from "../curtain/curtain-runner";
import { ExperienceStore } from "../curtain/experience";
import { HookPipeline } from "../hook-system/hook-pipeline";
import { registerBuiltinHooks } from "../hook-system/register-builtins";
import { ActivityLogger } from "../infra/activity-logger";
import { SwarmSessionManager } from "../session/swarm-session-manager";
import type { ISwarmOrchestrator } from "../core/embedded-swarm-bridge";
import { buildExecutionWaves } from "../core/dag";
import { loadGraphDefinition, type GraphDefinition, type NodeContext, type NodeResult } from "./schema";
import { WaveScheduler, type SchedulingStrategy, type SchedulerNodeInfo } from "./graph-executor";
import { selectNodeBehavior, type NodeBehaviorFactoryConfig } from "./node-behavior";
import type { SingleResult } from "../../task";
import { GateController } from "./gate-controller";
import { writeCheckpoint, recoverState, type GraphRunState, type NodeRunState } from "./checkpoint";
import { MarkEnvironment } from "../../coordination/mark-environment";
import { StigmergySource } from "../context-manager/sources/stigmergy-source";

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
	#graphRunState!: GraphRunState;
	#markEnv!: MarkEnvironment;
	#graphName!: string;
	#ircBus!: IrcBus;
	#swarmDir!: string;
	#loopConfig!: LoopSwarmConfig;

	constructor(config: GraphRunnerConfig) {
		this.#config = config;
	}

	async init(): Promise<void> {
		const { workspace, modelRegistry, settings, profileRegistry } = this.#config;
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

		this.#fsm = new WorkflowFsm(this.#stateTracker, this.#activityLogger, "stage");
		for (const def of PHASES) this.#fsm.registerPhase(def);

		this.#hookPipeline = new HookPipeline();
		registerBuiltinHooks(this.#hookPipeline, { experienceStore: this.#experienceStore, profileRegistry });
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
		this.#runtime = assembleAgentRuntime({
			modelRegistry, settings,
			activityLogger: this.#activityLogger,
			roleAssetManager: this.#roleAssetManager,
			hookPipeline: this.#hookPipeline,
			ircBus: this.#ircBus,
			experienceStore: this.#experienceStore,
		});

		// Create MarkEnvironment for stigmergic coordination
		this.#markEnv = new MarkEnvironment();

		// Register StigmergySource so agents get environmental awareness
		this.#runtime.contextPipeline.register(
			new StigmergySource(this.#markEnv),
		);

		this.#gateController = new GateController({ workspace });

		const deps = new Map<string, Set<string>>();
		for (const [id, node] of Object.entries(this.#graph.nodes)) {
			deps.set(id, new Set(node.depends_on ?? []));
		}
		this.#waves = buildExecutionWaves(deps);

		// Build initial GraphRunState — all nodes start pending.
		const runId = `graph-${this.#graphName}-${Date.now()}`;
		const initialNodes: Record<string, { nodeId: string; status: "pending" }> = {};
		for (const nodeId of Object.keys(this.#graph.nodes)) {
			initialNodes[nodeId] = { nodeId, status: "pending" };
		}
		this.#graphRunState = {
			graphName: this.#graphName,
			runId,
			startedAt: Date.now(),
			nodes: initialNodes,
			currentWave: 0,
			status: "running",
		};

		// Check for an existing checkpoint — when found, restore prior wave progress.
		const priorCheckpoint = await recoverState(this.#sessionManager, this.#graphName);
		if (priorCheckpoint) {
			this.#graphRunState = priorCheckpoint;
			logger.info("[GraphRunner] Resuming from prior checkpoint", {
				runId,
				completedNodes: Object.values(priorCheckpoint.nodes).filter(n => n.status === "completed").length,
				currentWave: priorCheckpoint.currentWave,
			});
		} else {
			// Persist the initial state so it's available for the first wave.
			writeCheckpoint(this.#graphRunState, this.#sessionManager);
		}

		// Mark mode as graph for TUI dashboard rendering
		await this.#stateTracker.updatePipeline({ phase: "stage" }).catch(() => {});
		logger.info("[GraphRunner] Initialized", {
			graph: this.#graphName,
			nodes: Object.keys(this.#graph.nodes).length,
			waves: this.#waves.length,
		});
	}


	/** Update node status in GraphRunState and persist the checkpoint. */
	#updateCheckpoint(nodeId: string, status: NodeRunState["status"], error?: string): void {
		const prev = this.#graphRunState.nodes[nodeId];
		this.#graphRunState.nodes[nodeId] = {
			nodeId,
			status,
			startedAt: status === "running" ? Date.now() : prev?.startedAt,
			completedAt: (status === "completed" || status === "failed") ? Date.now() : undefined,
			...(error ? { error } : {}),
		};
		writeCheckpoint(this.#graphRunState, this.#sessionManager);
	}
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#abortController?.abort();
		this.#applaudResolve?.();
		this.#gateController.removeAllListeners();
		try { this.#experienceStore.close(); } catch { /* best-effort */ }
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
		const updateCheckpoint = this.#updateCheckpoint.bind(this);
		const profileRegistry = this.#config.profileRegistry;
		const roleAssetManager = this.#roleAssetManager;
		const activityLogger = this.#activityLogger;
		const hookPipeline = this.#hookPipeline;
		const fsm = this.#fsm;
		const swarmDir = this.#swarmDir;
		const loopConfig = this.#loopConfig;

		// Build SchedulerNodeInfo from graph nodes for continueOnFailure
		const nodeInfos: Record<string, SchedulerNodeInfo> = {};
		for (const [id, node] of Object.entries(graph.nodes)) {
			nodeInfos[id] = { continueOnFailure: node.continue_on_failure ?? false };
		}
		const scheduler: SchedulingStrategy = new WaveScheduler(nodeInfos);

		const totalNodes = Object.keys(graph.nodes).length;
		let completedCount = 0;
		const executionErrors: string[] = [];
		const agentsList: Array<{ id: string; role: string }> = [];
		const agentResultsMap = new Map<string, SingleResult[]>();
		try {
			await scheduler.schedule(this.#waves, {
				async runNode(nodeId: string): Promise<NodeResult> {
					const node = graph.nodes[nodeId];
					if (!node) return { nodeId, success: false, error: `Unknown node: ${nodeId}` };

					await stateTracker.registerAgent(nodeId);
					await stateTracker.updateAgent(nodeId, { status: "running" });
					updateCheckpoint(nodeId, "running");

					const behaviorFactoryConfig: NodeBehaviorFactoryConfig = {
						runtime,
						fsm,
						hookPipeline,
						contextPipeline: runtime.contextPipeline,
						workspace,
						swarmDir,
						loopConfig,
					};
					const behavior = selectNodeBehavior(node.type, behaviorFactoryConfig);
					const ctx: NodeContext = {
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
						roleAssetManager,
						profileRegistry,
						stateTracker,
						activityLogger,
					};

					try {
						const prepared = await behavior.prepare(ctx);
						const behaviorResult = await behavior.execute(ctx, prepared);

						if (!node.gate) {
							await stateTracker.updateAgent(nodeId, { status: "completed" });
							updateCheckpoint(nodeId, "completed");
							return { nodeId, success: behaviorResult.success, error: behaviorResult.error };
						}

						let lastGateResult = await gateController.runGate(
							node,
							behaviorResult.output ?? "",
							behaviorResult.success,
						);
						let attempt = 0;
						while (!lastGateResult.passed) {
							const action = await gateController.handleGateFailure(node, lastGateResult, attempt);
							if (action.type === "continue") {
								// Gate failure skipped by policy — proceed as passed.
								await stateTracker.updateAgent(nodeId, { status: "completed" });
								updateCheckpoint(nodeId, "completed");
								return { nodeId, success: true };
							}
							if (action.type === "block") {
								await stateTracker.updateAgent(nodeId, { status: "failed", error: action.reason });
								updateCheckpoint(nodeId, "failed", action.reason);
								return { nodeId, success: false, error: action.reason };
							}
							// retry: sleep, then re-run the gate
							const { promise, resolve } = Promise.withResolvers<void>();
							setTimeout(resolve, action.delayMs);
							await promise;
							lastGateResult = await gateController.runGate(
								node,
								behaviorResult.output ?? "",
								behaviorResult.success,
							);
							attempt++;
						}
						if (lastGateResult.passed) {
							await stateTracker.updateAgent(nodeId, { status: "completed" });
							updateCheckpoint(nodeId, "completed");
							return { nodeId, success: true };
						}
						return { nodeId, success: false, error: lastGateResult.errors.join("; ") };
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						await stateTracker.updateAgent(nodeId, { status: "failed", error: msg });
						updateCheckpoint(nodeId, "failed", msg);
						return { nodeId, success: false, error: msg };
					} finally {
						await behavior.cleanup(ctx);
					}
				},
				onNodeComplete(nodeId, result) {
					if (result.success) completedCount++;
					const node = graph.nodes[nodeId];
					if (node) agentsList.push({ id: nodeId, role: node.role });
					if (result.error) executionErrors.push(`${nodeId}: ${result.error}`);
					agentResultsMap.set(nodeId, [{
						index: 0,
						id: nodeId,
						agent: nodeId,
						agentSource: "project",
						task: node?.description ?? "",
						exitCode: result.success ? 0 : 1,
						output: result.output ?? "",
						stderr: result.error ?? "",
						truncated: false,
						durationMs: 0,
						tokens: 0,
						requests: 0,
					}]);
				},
			});

			await this.#fsm.transition("curtain", { reason: "graph execution complete" });
			const allSucceeded = executionErrors.length === 0;
			await runCurtainPipeline(
				{
					status: allSucceeded ? "completed" : "failed",
					agentResults: agentResultsMap,
					errors: executionErrors,
					agents: agentsList,
					taskProgress: { total: totalNodes, completed: completedCount },
				},
				{
					workspace, stateTracker: this.#stateTracker,
					activityLogger: this.#activityLogger,
					experienceStore: this.#experienceStore,
					loopConfig: null, modelRegistry, settings,
					commBus: this.#runtime.commBus,
					graphName: this.#graphName,
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
