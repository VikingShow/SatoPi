/**
 * GraphRunner — Thin adapter wrapping GraphEngine for ISwarmOrchestrator.
 *
 * Implements ISwarmOrchestrator and NodeExecutor.
 * DAG execution is delegated to GraphEngine; GraphRunner handles
 * per-node behavior lifecycle (prepare → execute → gate → cleanup)
 * and swarm lifecycle (FSM transitions, curtain pipeline).
 *
 * ## Lifecycle (PhaseBehavior-driven)
 *   init() → parse graph → build waves → confirmScript():
 *     create GraphEngine → engine.run(this) → CurtainBehavior → idle
 *
 * Per-node behaviors (script / stage / curtain) are driven by
 * PhaseBehaviorNodeAdapter inside GraphEngine.execute(). The
 * top-level CurtainBehavior in confirmScript() handles the
 * post-execution curtain phase when no dedicated curtain node exists.
 */

import * as path from "node:path";
import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
import type { AssistantMessage } from "@satopi/pi-ai";
import { logger } from "@satopi/pi-utils";
import type { ProfileRegistry } from "../../agent/agent-profile";
import type { RoleAssetManager } from "../../agent/role-asset";
import type { CheckpointStore } from "../../graph/checkpoint";
import {
	GraphEngine,
	type GraphEngineConfig,
	type NodeExecutionContext,
	type NodeExecutor,
} from "../../graph/graph-engine";
import type { GraphRunState } from "../../graph/types";
import type { IrcBus } from "../../irc/bus";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { AgentRuntime } from "../agent-runtime";
import { CurtainBehavior } from "../behaviors/curtain-behavior";
import type { PhaseBehavior, PhaseContext } from "../behaviors/index";
import type { ISwarmOrchestrator } from "../core/embedded-swarm-bridge";
import type { LoopSwarmConfig } from "../core/schema";
import { buildExecutionWaves } from "../core/dag";
import type { Chapter, StateTracker, SwarmState } from "../core/state";
import { createSwarmInfra } from "../core/swarm-infra";
import type { WorkflowFsm } from "../core/workflow-fsm";
import type { ExperienceStore } from "../../experience/experience";
import type { HookPipeline } from "../../hooks/hook-pipeline";
import type { ActivityLogger } from "../../infra/activity-logger";
import { SwarmSessionManager } from "../session/swarm-session-manager";
import { recoverState } from "./checkpoint";
import { GateController } from "./gate-controller";
import { type NodeBehaviorFactoryConfig, selectNodeBehavior } from "./node-behavior";
import { type GraphDefinition, loadGraphDefinition, type NodeContext, type NodeResult } from "./schema";

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// GraphRunner
// ============================================================================

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

	// ── PhaseBehavior instances ─────────────────────────────────────────
	#curtainBehavior!: CurtainBehavior;
	#currentBehavior: PhaseBehavior | null = null;
	/** Active agent event unsubscriptions for the current phase. */
	#agentUnsubscribes: Array<() => void> = [];

	constructor(config: GraphRunnerConfig) {
		this.#config = config;
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	async init(): Promise<void> {
		const { workspace, modelRegistry, settings, profileRegistry, activeMmd } = this.#config;
		this.#graphName = path.basename(this.#config.graphPath, ".graph.yaml");
		this.#swarmDir = path.join(workspace, ".stp", "sessions", `swarm-${this.#graphName}`);

		// Load graph and compute execution waves (needed for start-phase detection)
		this.#graph = await loadGraphDefinition(this.#config.graphPath);
		const deps = new Map<string, Set<string>>();
		for (const [id, node] of Object.entries(this.#graph.nodes)) {
			deps.set(id, new Set(node.depends_on ?? []));
		}
		this.#waves = buildExecutionWaves(deps);

		const infra = await createSwarmInfra({
			workspace,
			swarmDir: this.#swarmDir,
			swarmName: this.#graphName,
			modelRegistry,
			settings,
			profileRegistry,
			activeMmd,
			startPhase: this.#detectStartPhase(),
		});

		this.#sessionManager = infra.sessionManager;
		this.#stateTracker = infra.stateTracker;
		this.#activityLogger = infra.activityLogger;
		this.#fsm = infra.fsm;
		this.#experienceStore = infra.experienceStore;
		this.#hookPipeline = infra.hookPipeline;
		this.#runtime = infra.runtime;
		this.#roleAssetManager = infra.roleAssetManager;
		this.#ircBus = infra.ircBus;

		// Create CurtainBehavior for post-execution curtain phase
		this.#curtainBehavior = new CurtainBehavior();

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
		this.#gateController = new GateController({ workspace });

		// Mark mode as graph for TUI dashboard rendering
		await this.#stateTracker
			.updatePipeline({ phase: "stage" })
			.catch(err => logger.error("StateTracker updatePipeline failed", { error: String(err) }));
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
		// Exit current behavior
		if (this.#currentBehavior) {
			await this.#currentBehavior.exit().catch(() => {});
			this.#currentBehavior = null;
		}
		this.#unwireAgentEvents();
		try {
			this.#experienceStore.close();
		} catch {
			/* best-effort */
		}
		logger.info("[GraphRunner] Disposed");
	}

	// ── PhaseContext builder ───────────────────────────────────────────────

	#buildPhaseContext(planContent?: string): PhaseContext {
		return {
			fsm: this.#fsm,
			ircBus: this.#ircBus,
			runtime: this.#runtime,
			contextPipeline: this.#runtime.contextPipeline,
			hookPipeline: this.#hookPipeline,
			stateTracker: this.#stateTracker,
			activityLogger: this.#activityLogger,
			workspace: this.#config.workspace,
			swarmDir: this.#swarmDir,
			planContent: planContent ?? "",
			loopConfig: this.#loopConfig,
			signal: this.#abortController?.signal ?? new AbortController().signal,
		};
	}

	// ── Agent event wiring ─────────────────────────────────────────────────

	#wireAgentEvents(agents: AgentSession[]): void {
		this.#unwireAgentEvents();
		for (const agent of agents) {
			const unsub = agent.subscribe(event => {
				if (event.type === "agent_end") {
					const lastAssistant = [...event.messages]
						.reverse()
						.find((message): message is AssistantMessage => message.role === "assistant");
					const stopReason: string | undefined = lastAssistant?.stopReason;
					const status =
						stopReason === "aborted"
							? "aborted"
							: stopReason === "error" || stopReason === "max_turns"
								? "failed"
								: "completed";
					const ctx = this.#buildPhaseContext();
					this.#currentBehavior
						?.handleAgentEvent({ agentId: agent.id, status, result: event }, ctx)
						.catch(err => logger.error("handleAgentEvent failed", { error: String(err) }));
				}
			});
			this.#agentUnsubscribes.push(unsub);
		}
	}

	#unwireAgentEvents(): void {
		for (const unsub of this.#agentUnsubscribes) unsub();
		this.#agentUnsubscribes = [];
	}

	// ── Curtain lifecycle (synchronous — called within confirmScript) ──────

	/**
	 * Run the CurtainBehavior lifecycle to completion.
	 * Polls checkCompletion every 750ms until the curtain phase resolves.
	 */
	async #runCurtainLifecycle(ctx: PhaseContext): Promise<void> {
		const curtainCtx = ctx;

		while (!this.#disposed) {
			const { promise: pollPromise, resolve: pollResolve } = Promise.withResolvers<void>();
			const timer = setTimeout(pollResolve, 750);
			await pollPromise;
			clearTimeout(timer);

			if (this.#disposed) return;

			const completion = await this.#curtainBehavior.checkCompletion(curtainCtx);
			if (!completion) continue;

			// Curtain complete — exit behavior
			await this.#curtainBehavior
				.exit()
				.catch(err => logger.error("CurtainBehavior.exit failed", { error: String(err) }));
			this.#unwireAgentEvents();
			this.#currentBehavior = null;

			// Handle transition
			if (completion.nextPhase === "idle") {
				if (completion.needApplaud && !this.#config.autoApplaud) {
					const { promise: applaudPromise, resolve: applaudResolve } = Promise.withResolvers<void>();
					this.#applaudResolve = applaudResolve;
					const CURTAIN_TIMEOUT_MS = 300_000;
					const timeout = setTimeout(() => {
						if (this.#applaudResolve) {
							this.#applaudResolve();
							this.#applaudResolve = null;
						}
					}, CURTAIN_TIMEOUT_MS);
					await applaudPromise;
					clearTimeout(timeout);
					this.#applaudResolve = null;
				}

				await this.#fsm.transition("idle", {
					reason: completion.message ?? "curtain complete",
				});
				return;
			}

			// Re-plan or unknown — go idle
			await this.#fsm.transition("idle", { reason: completion.message ?? "curtain complete" }).catch(() => {});
			return;
		}
	}

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

	onPlanUpdated(_content: string): void {}

	getPlanContent(): string {
		return "";
	}

	// =========================================================================
	// ISwarmOrchestrator — confirmScript delegates to GraphEngine
	// =========================================================================

	/** Set agent type and count from plan review confirmation TUI. */
	setAgentConfig(_opts: { agentType?: "swift" | "persistent"; agentCount?: number }): void {
		// GraphRunner drives agent count from graph definition.
	}

	async confirmScript(_opts?: { agentType?: "swift" | "persistent"; agentCount?: number }): Promise<string[]> {
		await this.#fsm.transition("stage", { reason: "graph execution start" });
		this.#abortController = new AbortController();
		this.#graphStageStarted = true;

		// Build CheckpointStore adapter wrapping SwarmSessionManager.
		const sessionManager = this.#sessionManager;
		const checkpointStore: CheckpointStore = {
			write(state): boolean {
				try {
					sessionManager.appendCustomEntry("graph_checkpoint", state);
					return true;
				} catch (err) {
					logger.error("[GraphRunner] Failed to write checkpoint", {
						graphName: state.graphName,
						error: err instanceof Error ? err.message : String(err),
					});
					return false;
				}
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

		try {
			await engine.run(this);
		} catch (err) {
			logger.error("[GraphRunner] GraphEngine execution failed", { error: String(err) });
			await this.#fsm
				.transition("blocked", { reason: String(err) })
				.catch(err2 => logger.error("FSM transition failed during error recovery", { error: String(err2) }));
			return [];
		}

		// Transition to curtain via CurtainBehavior lifecycle
		await this.#fsm.transition("curtain", { reason: "graph execution complete" });

		const curtainCtx = this.#buildPhaseContext();
		const curtainEnterResult = await this.#curtainBehavior.enter(curtainCtx);
		this.#currentBehavior = this.#curtainBehavior;
		this.#wireAgentEvents(curtainEnterResult.agents);

		// If auto-applaud, immediately signal applaud
		if (this.#config.autoApplaud) {
			await this.#curtainBehavior.handleHumanMessage({ from: "human", body: "applaud" }, curtainCtx).catch(() => {});
		}

		// Run curtain lifecycle synchronously (blocking until curtain complete)
		await this.#runCurtainLifecycle(curtainCtx);

		return [];
	}

	async steer(message: string): Promise<void> {
		// Forward to current behavior if active
		if (this.#currentBehavior) {
			const ctx = this.#buildPhaseContext();
			await this.#currentBehavior.handleHumanMessage({ from: "human", body: message }, ctx);
		}
		// Also deliver via IrcBus for backward compat
		await this.#runtime.ircBus.receiveFromHuman(message);
	}

	applaud(): void {
		// Forward applaud to CurtainBehavior if active
		if (this.#currentBehavior === this.#curtainBehavior) {
			const ctx = this.#buildPhaseContext();
			this.#curtainBehavior
				.handleHumanMessage({ from: "human", body: "applaud" }, ctx)
				.catch(err => logger.error("CurtainBehavior applaud failed", { error: String(err) }));
		}
		this.#applaudResolve?.();
		this.#applaudResolve = null;
	}

	async pauseStage(): Promise<void> {
		this.#abortController?.abort();
		await this.#fsm.transition("paused", { reason: "human paused" });
	}

	async resumeGraphRun(): Promise<{ success: boolean; error?: string }> {
		// Verify a checkpoint exists to resume from.
		const checkpointState = await recoverState(this.#sessionManager, this.#graphName);
		if (!checkpointState) {
			return { success: false, error: "No checkpoint found — nothing to resume" };
		}
		if (checkpointState.status !== "running" && checkpointState.status !== "failed") {
			return { success: false, error: `Cannot resume: graph run status is "${checkpointState.status}"` };
		}

		logger.info("[GraphRunner] Resuming from checkpoint", {
			graphName: this.#graphName,
			completedNodes: Object.values(checkpointState.nodes).filter(n => n.status === "completed").length,
			currentWave: checkpointState.currentWave,
		});

		await this.#fsm.transition("stage", { reason: "graph resume from checkpoint" });
		this.#abortController = new AbortController();

		// Build CheckpointStore adapter wrapping SwarmSessionManager.
		const sessionManager = this.#sessionManager;
		const checkpointStore: CheckpointStore = {
			write(state): boolean {
				try {
					sessionManager.appendCustomEntry("graph_checkpoint", state);
					return true;
				} catch (err) {
					logger.error("[GraphRunner] Failed to write checkpoint", {
						graphName: state.graphName,
						error: err instanceof Error ? err.message : String(err),
					});
					return false;
				}
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

		try {
			await engine.run(this);
		} catch (err) {
			logger.error("[GraphRunner] GraphEngine resume execution failed", { error: String(err) });
			await this.#fsm
				.transition("blocked", { reason: String(err) })
				.catch(err2 => logger.error("FSM transition failed during error recovery", { error: String(err2) }));
			return { success: false, error: String(err) };
		}

		// Transition to curtain via CurtainBehavior lifecycle
		await this.#fsm.transition("curtain", { reason: "graph resume complete" });

		const curtainCtx = this.#buildPhaseContext();
		const curtainEnterResult = await this.#curtainBehavior.enter(curtainCtx);
		this.#currentBehavior = this.#curtainBehavior;
		this.#wireAgentEvents(curtainEnterResult.agents);

		if (this.#config.autoApplaud) {
			await this.#curtainBehavior.handleHumanMessage({ from: "human", body: "applaud" }, curtainCtx).catch(() => {});
		}

		await this.#runCurtainLifecycle(curtainCtx);

		return { success: true };
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
	get swarmState(): Readonly<SwarmState> {
		return this.#stateTracker.state;
	}
	get currentPhase(): Chapter | null {
		return this.#fsm?.phase ?? null;
	}
	get isRunning(): boolean {
		return !this.#disposed && (this.#fsm?.state.running ?? false);
	}
	/** Whether confirmScript() has started Stage execution. */
	#graphStageStarted = false;
	get stageStarted(): boolean {
		return this.#graphStageStarted;
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
