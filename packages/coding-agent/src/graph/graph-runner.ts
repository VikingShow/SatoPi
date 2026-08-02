/**
 * GraphRunner — Sole ISwarmOrchestrator implementation.
 *
 * Supports two modes:
 *   1. Graph mode (graphPath provided) — loads a .graph.yaml, runs theatre graph
 *   2. Swarm keyword mode (graphPath absent) — dynamic plan.md lifecycle
 *
 * DAG execution is delegated to GraphEngine; GraphRunner handles
 * per-node behavior lifecycle (prepare → execute → gate → cleanup)
 * and swarm lifecycle (FSM transitions, curtain pipeline).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@satopi/pi-ai";
import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
import { logger } from "@satopi/pi-utils";
import type { ProfileRegistry } from "../agent/agent-profile";
import type { RoleAssetManager } from "../agent/role-asset";
import type { CommChannel } from "../comm/comm-channel";
import { MarkEnvironment } from "../coordination/mark-environment";
import type { ExperienceStore } from "../experience/experience";
import type { HookPipeline } from "../hooks/hook-pipeline";
import type { ActivityLogger } from "../infra/activity-logger";
import type { IrcBus } from "../irc/bus";
import type { IOffloadManager } from "../offload/manager";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { LoopSwarmConfig } from "../swarm/core/schema";
import type { Chapter, StateTracker, SwarmState } from "../swarm/core/state";
import type { SwarmInfra } from "../swarm/core/swarm-infra";
import type { SwarmRuntime } from "../swarm/core/swarm-runtime";
import type { SwarmSessionManager } from "../swarm/session/swarm-session-manager";
import { CurtainBehavior } from "./behaviors/curtain-behavior";
import type { DebateRoundtableResult } from "./behaviors/debate-roundtable";
import type { PhaseBehavior, PhaseContext } from "./behaviors/index";
import type { CheckpointStore } from "./checkpoint";
import { recoverState } from "./checkpoint";
import { buildExecutionWaves } from "./dag";
import { GateController } from "./gate-controller";
import { GraphEngine, type GraphEngineConfig, type NodeExecutionContext, type NodeExecutor } from "./graph-engine";
import { type NodeBehaviorFactoryConfig, selectNodeBehavior } from "./node-behavior";
import type { ISwarmOrchestrator } from "./orchestrator-interface";
import { PhaseBehaviorNodeAdapter } from "./phase-behavior-adapter";
import { getSessionPlanPath } from "./plan-paths";
import { type GraphDefinition, loadGraphDefinition, type NodeContext, type NodeResult } from "./schema";
import type { GraphRunState } from "./types";

/** Phases where the workflow is considered actively running. */
const ACTIVE_PHASES: Set<Chapter> = new Set(["script", "script-debate", "stage", "curtain"]);
// ============================================================================
// Types
// ============================================================================

export interface GraphRunnerConfig {
	workspace: string;
	/** Path to .graph.yaml file. Omit for swarm keyword (plan.md) mode. */
	graphPath?: string;
	modelRegistry: ModelRegistry;
	settings: Settings;
	profileRegistry?: ProfileRegistry;
	maxWorkers?: number;
	maxRounds?: number;
	autoApplaud?: boolean;
	/** Active MMD content for MmdSource context injection. */
	activeMmd?: string;
	/** Swarm directory path (for swarm keyword mode, auto-derived when graphPath present). */
	swarmDir?: string;
	/** Pre-built swarm infrastructure. Required — callers create via createSwarmInfra. */
	infra: SwarmInfra;
	/** Called on phase transitions. Callers wire to setCurrentSwarmPhase. */
	onPhaseChange?: (phase: Chapter) => void;
	/** Factory for debate roundtable instances during plan debate. */
	debateRoundtableFactory?: (config: {
		agentCount: number;
		maxRounds: number;
		convergenceThreshold: number;
		runtime: SwarmRuntime;
	}) => {
		debate(
			planContent: string,
			workspace: string,
			modelRegistry: ModelRegistry,
			settings: Settings,
		): Promise<DebateRoundtableResult>;
	};
	/** Reader for session.jsonl raw entries (used by checkpoint recovery). */
	readSessionEntries: () => Promise<Array<Record<string, unknown>>>;
}

// ============================================================================
// GraphRunner
// ============================================================================

export class GraphRunner implements ISwarmOrchestrator, NodeExecutor {
	readonly #config: GraphRunnerConfig;
	#phase: Chapter = "idle";
	#stateTracker!: StateTracker;
	#activityLogger!: ActivityLogger;
	#sessionManager!: SwarmSessionManager;
	#experienceStore!: ExperienceStore;
	#hookPipeline!: HookPipeline;
	#runtime!: SwarmRuntime;
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

	// ── Swarm keyword mode state ────────────────────────────────────────
	#planContent = "";
	#planReady = false;
	// Assigned during init() from infra.offloadManager.
	#offloadManager!: IOffloadManager;
	#markEnvironment: MarkEnvironment;

	// ── PhaseBehavior instances ─────────────────────────────────────────
	#curtainBehavior!: CurtainBehavior;
	#currentBehavior: PhaseBehavior | null = null;
	/** Active agent event unsubscriptions for the current phase. */
	#agentUnsubscribes: Array<() => void> = [];

	/** Whether confirmScript() has started Stage execution. */
	#graphStageStarted = false;
	/** Crew channel for phase transition broadcasts. */
	#crewChannel: CommChannel | null = null;
	/** Original onPhaseChange callback, preserved for restore on detach. */
	#originalOnPhaseChange: ((phase: Chapter) => void) | undefined;

	constructor(config: GraphRunnerConfig) {
		this.#config = config;
		this.#markEnvironment = new MarkEnvironment();
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	async init(): Promise<void> {
		const { workspace } = this.#config;
		const hasGraph = !!this.#config.graphPath;

		if (hasGraph) {
			this.#graphName = path.basename(this.#config.graphPath!, ".graph.yaml");
			this.#swarmDir = path.join(workspace, ".stp", "sessions", `swarm-${this.#graphName}`);

			// Load graph and compute execution waves
			this.#graph = await loadGraphDefinition(this.#config.graphPath!);
			const deps = new Map<string, Set<string>>();
			for (const [id, node] of Object.entries(this.#graph.nodes)) {
				deps.set(id, new Set(node.depends_on ?? []));
			}
			this.#waves = buildExecutionWaves(deps);
		} else {
			// Swarm keyword mode: no graph file
			const sessionId =
				this.#config.swarmDir?.split("/").pop()?.replace("swarm-", "") ?? crypto.randomUUID().slice(0, 8);
			this.#graphName = sessionId;
			this.#swarmDir = this.#config.swarmDir ?? path.join(workspace, ".stp", "sessions", `swarm-${sessionId}`);
			this.#graph = { name: sessionId, description: "", version: 1, revision: 1, nodes: {}, edges: [], hooks: [] };
			this.#waves = [];
		}

		const infra = this.#config.infra;

		this.#sessionManager = infra.sessionManager;
		this.#stateTracker = infra.stateTracker;
		this.#activityLogger = infra.activityLogger;
		this.#experienceStore = infra.experienceStore;
		this.#phase = infra.stateTracker.state.phase as Chapter;
		this.#hookPipeline = infra.hookPipeline;
		this.#runtime = infra.runtime;
		this.#roleAssetManager = infra.roleAssetManager;
		this.#ircBus = infra.ircBus;
		this.#markEnvironment = infra.markEnvironment;
		this.#offloadManager = infra.offloadManager;

		// Create CurtainBehavior for post-execution curtain phase
		this.#curtainBehavior = new CurtainBehavior();

		// Default loop config for PhaseBehavior-backed nodes
		this.#loopConfig = {
			maxIterations: 5,
			autoRetry: true,
			humanEscalation: true,
			agents: {
				initial: this.#config.maxWorkers ?? 4,
				min: 1,
				max: 12,
				auto: true,
				maxRounds: this.#config.maxRounds ?? 5,
				roundsConvergenceThreshold: 3,
			},
			debate: { enabled: true, maxRounds: 2 },
			planDebate: { enabled: true, agentCount: 2, maxRounds: 3, convergenceThreshold: 2 },
			convergenceThreshold: 2,
			iterationTimeoutMs: 300_000,
			enableDeliberation: true,
		};
		this.#gateController = new GateController({ workspace });

		if (hasGraph) {
			// Mark mode as graph for TUI dashboard rendering
			await this.#stateTracker
				.updatePipeline({ phase: "stage" })
				.catch(err => logger.error("StateTracker updatePipeline failed", { error: String(err) }));
			logger.info("[GraphRunner] Initialized (graph mode)", {
				graph: this.#graphName,
				nodes: Object.keys(this.#graph.nodes).length,
				waves: this.#waves.length,
			});
		} else {
			logger.info("[GraphRunner] Initialized (swarm keyword mode)", {
				sessionId: this.#graphName,
				swarmDir: this.#swarmDir,
			});
		}
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

				this.#phase = "idle";
				this.#config.onPhaseChange?.("idle");
				await this.#stateTracker.updatePipeline({ phase: "idle" }).catch(() => {});
				if (this.#crewChannel) {
					this.#crewChannel.send("system", "Phase: idle — Workflow complete");
				}
				this.#activityLogger.logPhase(
					"idle",
					undefined,
					undefined,
					"curtain",
					completion.message ?? "curtain complete",
				);
				return;
			}
			// Re-plan or unknown — go idle
			this.#phase = "idle";
			this.#config.onPhaseChange?.("idle");
			await this.#stateTracker.updatePipeline({ phase: "idle" }).catch(() => {});
			if (this.#crewChannel) {
				this.#crewChannel.send("system", "Phase: idle — Workflow complete");
			}
			return;
		}
	}

	// =========================================================================
	// NodeExecutor — per-node behavior lifecycle (called by GraphEngine)
	// =========================================================================

	/**
	 * Read recent lessons from the ExperienceStore and format them as a
	 * concatenated string for injection into the node's task prompt.
	 * Returns "" if the store is empty or uninitialized.
	 */
	#readExperience(): string {
		try {
			const lessons = this.#experienceStore.getRecentLessons(20);
			if (lessons.length === 0) return "";
			return lessons.map(l => `- [${l.lesson.type}] ${l.lesson.summary}`).join("\n");
		} catch {
			return "";
		}
	}
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
			hookPipeline: this.#hookPipeline,
			contextPipeline: this.#runtime.contextPipeline,
			workspace: this.#config.workspace,
			swarmDir: this.#swarmDir,
			loopConfig: this.#loopConfig,
			planContent: this.#planContent,
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
				subgraphPath: node.subgraph_path,
				loopOver: node.loop_over,
				loopBody: node.loop_body,
				loopMaxIterations: node.loop_max_iterations,
				loopBreakWhen: node.loop_break_when,
			},
			workspace: this.#config.workspace,
			modelRegistry: this.#config.modelRegistry,
			settings: this.#config.settings,
			experience: this.#readExperience(),
			signal: this.#abortController!.signal,
			upstreamOutputs: execCtx.upstreamOutputs,
			runtime: this.#runtime,
			agentRegistry: AgentRegistry.global(),
			roleAssetManager: this.#roleAssetManager,
			profileRegistry: this.#config.profileRegistry,
			stateTracker: this.#stateTracker,
			activityLogger: this.#activityLogger,
			executeNode: this,
			graphDir: this.#config.graphPath ? path.dirname(this.#config.graphPath) : this.#config.workspace,
		};

		try {
			const prepared = await behavior.prepare(ctx);
			const behaviorResult = await behavior.execute(ctx, prepared);

			// PhaseBehavior-backed nodes (script, stage, curtain) return
			// immediately from execute() but may spawn agents internally
			// that need time to complete.  Poll validate() (which calls
			// checkCompletion()) until the phase resolves or the signal
			// is aborted.
			const phaseAgents = "getAgents" in behavior ? (behavior as PhaseBehaviorNodeAdapter).getAgents() : [];
			if (phaseAgents.length > 0) {
				this.#wireAgentEvents(phaseAgents);
			}

			if (behavior instanceof PhaseBehaviorNodeAdapter) {
				while (!this.#abortController?.signal.aborted) {
					const gateResult = await behavior.validate(behaviorResult);
					if (gateResult.passed) break;
					await Bun.sleep(750);
				}
				this.#unwireAgentEvents();
			}

			if (!node.gate) {
				await this.#stateTracker.updateAgent(nodeId, { status: "completed" });
				return {
					nodeId,
					success: behaviorResult.success,
					output: behaviorResult.output,
					artifacts: behaviorResult.artifacts,
					error: behaviorResult.error,
				};
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
					return { nodeId, success: true, output: behaviorResult.output, artifacts: behaviorResult.artifacts };
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
				return { nodeId, success: true, output: behaviorResult.output, artifacts: behaviorResult.artifacts };
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

	// ── Plan management ────────────────────────────────────────────────────

	/** Called by agent-session when the agent writes/updates plan.md. */
	onPlanUpdated(content: string): void {
		this.#planContent = content;
		const planPath = getSessionPlanPath(this.#swarmDir);
		fs.mkdir(path.dirname(planPath), { recursive: true })
			.then(() => fs.writeFile(planPath, content, "utf-8"))
			.catch(err => logger.warn("[GraphRunner] Failed to persist plan.md", { error: String(err) }));
		const hasHeadings = /^#{1,3}\s+/m.test(content);
		const minLength = content.trim().length >= 200;
		this.#planReady = hasHeadings && minLength;
	}

	getPlanContent(): string {
		return this.#planContent;
	}

	/** Whether the plan is ready (has content and meets minimum structure). */
	isPlanReady(): boolean {
		return this.#planReady;
	}

	/** Set agent type and count from plan review confirmation TUI. */
	setAgentConfig(opts: { agentType?: "swift" | "main"; agentCount?: number }): void {
		if (opts.agentCount !== undefined && opts.agentCount >= 1) {
			this.#loopConfig.agents.initial = opts.agentCount;
		}
	}

	/**
	 * Run the plan debate and return structured results without affecting FSM state.
	 * Returns undefined when debate is not enabled.
	 */
	async debatePlan(planContent: string): Promise<DebateRoundtableResult | undefined> {
		const enableDebate = (this.#config.settings.get("magicKeywords.swarm.enableDebate") as boolean) ?? false;
		if (!enableDebate) return undefined;

		const factory = this.#config.debateRoundtableFactory;
		if (!factory) return undefined;

		const debate = factory({
			agentCount: 2,
			maxRounds: 2,
			convergenceThreshold: 2,
			runtime: this.#runtime,
		});
		try {
			return await debate.debate(
				planContent,
				this.#config.workspace,
				this.#config.modelRegistry,
				this.#config.settings,
			);
		} catch (err) {
			logger.warn("[GraphRunner] Plan debate failed, returning undefined", {
				error: String(err),
			});
			return undefined;
		}
	}

	async confirmScript(_opts?: { agentType?: "swift" | "main"; agentCount?: number }): Promise<string[]> {
		this.#phase = "stage";
		this.#config.onPhaseChange?.("stage");
		await this.#stateTracker.updatePipeline({ phase: "stage" }).catch(() => {});
		if (this.#crewChannel) {
			this.#crewChannel.send("system", "Phase: stage — Execution phase started — dispatching tasks");
		}
		this.#abortController = new AbortController();
		this.#graphStageStarted = true;

		// Build CheckpointStore adapter wrapping SwarmSessionManager.
		const sessionManager = this.#sessionManager;
		const readSessionEntries = this.#config.readSessionEntries;
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
				const raw = await readSessionEntries();
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
			this.#phase = "blocked";
			this.#config.onPhaseChange?.("blocked");
			await this.#stateTracker.updatePipeline({ phase: "blocked" }).catch(() => {});
			return [];
		}

		// Transition to curtain via CurtainBehavior lifecycle
		this.#phase = "curtain";
		this.#config.onPhaseChange?.("curtain");
		await this.#stateTracker.updatePipeline({ phase: "curtain" }).catch(() => {});
		if (this.#crewChannel) {
			this.#crewChannel.send("system", "Phase: curtain — Reflection phase started — summarizing delivery");
		}

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
		this.#phase = "paused";
		this.#config.onPhaseChange?.("paused");
		await this.#stateTracker.updatePipeline({ phase: "paused" }).catch(() => {});
	}

	async resumeGraphRun(): Promise<{ success: boolean; error?: string }> {
		// Verify a checkpoint exists to resume from.
		const checkpointState = await recoverState(this.#config.readSessionEntries, this.#graphName);
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

		this.#phase = "stage";
		this.#config.onPhaseChange?.("stage");
		await this.#stateTracker.updatePipeline({ phase: "stage" }).catch(() => {});
		this.#abortController = new AbortController();

		// Build CheckpointStore adapter wrapping SwarmSessionManager.
		const sessionManager = this.#sessionManager;
		const readSessionEntries = this.#config.readSessionEntries;
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
				const raw = await readSessionEntries();
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
			this.#phase = "blocked";
			this.#config.onPhaseChange?.("blocked");
			await this.#stateTracker.updatePipeline({ phase: "blocked" }).catch(() => {});
			return { success: false, error: String(err) };
		}

		// Transition to curtain via CurtainBehavior lifecycle
		this.#phase = "curtain";
		this.#config.onPhaseChange?.("curtain");
		await this.#stateTracker.updatePipeline({ phase: "curtain" }).catch(() => {});

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

	// ── Crew Integration ────────────────────────────────────────────────────

	// Attach a crew channel so that phase transitions are broadcast.
	attachCrew(crewId: string, channel: CommChannel): void {
		this.#crewChannel = channel;
		// Wrap the phase-change callback so transitions also broadcast to crew
		const original = this.#config.onPhaseChange;
		this.#originalOnPhaseChange = original;
		this.#config.onPhaseChange = (phase: Chapter) => {
			original?.(phase);
			channel.send("system", `[System] Graph phase → ${phase}`).catch(() => {});
		};
		logger.info("[GraphRunner] Crew attached", { crewId });
		// Broadcast initial phase
		channel.send("system", `[System] Graph attached — current phase: ${this.#phase}`).catch(() => {});
	}

	/** Detach the crew channel and restore original phase callback. */
	detachCrew(): void {
		if (this.#crewChannel) {
			this.#crewChannel.send("system", "[System] Graph execution disconnecting").catch(() => {});
			this.#crewChannel = null;
			// Restore the original callback
			if (this.#originalOnPhaseChange !== undefined) {
				this.#config.onPhaseChange = this.#originalOnPhaseChange;
				this.#originalOnPhaseChange = undefined;
			}
			logger.info("[GraphRunner] Crew detached");
		}
	}

	// ── Accessors ──────────────────────────────────────────────────────────

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
		return this.#phase;
	}
	get isRunning(): boolean {
		return !this.#disposed && ACTIVE_PHASES.has(this.#phase);
	}
	get stageStarted(): boolean {
		return this.#graphStageStarted;
	}

	get runtime(): SwarmRuntime {
		return this.#runtime;
	}
	get graph(): GraphDefinition {
		return this.#graph;
	}
	get gateController(): GateController {
		return this.#gateController;
	}
	get offloadManager(): IOffloadManager {
		return this.#offloadManager;
	}
	get markEnvironment(): MarkEnvironment {
		return this.#markEnvironment;
	}
}
