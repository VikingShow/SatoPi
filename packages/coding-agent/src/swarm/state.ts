/**
 * In-memory state tracker for swarm pipeline execution.
 *
 * Persists state via SwarmSessionManager → session.jsonl (OH-MY-PI SessionManager).
 * Per-agent logs are still written to `.swarm_<name>/logs/` for forensic debugging.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SwarmSessionManager } from "./swarm-session-manager";

// ============================================================================
// State types
// ============================================================================

export type PipelineStatus = "idle" | "running" | "completed" | "failed" | "aborted";
export type AgentStatus = "pending" | "waiting" | "running" | "completed" | "failed";

/**
 * Loop phase — tracks the high-level workflow stage.
 * Drives the frontend UI state machine via SwarmState.loopPhase.
 */
export type LoopPhase =
	| "idle"
	| "before-loop-dialog"
	| "before-loop-debate"
	| "before-loop-confirm"
	| "running"
	| "paused"
	| "blocked"
	| "after-loop";

/**
 * To-Do item — a structured task parsed from plan.md.
 * Tracks real-time completion status during loop execution.
 */
export interface TodoItem {
	id: string;
	title: string;
	status: "pending" | "in_progress" | "completed";
	files?: string[];
	completedAt?: number;
}

export interface AgentState {
	name: string;
	status: AgentStatus;
	iteration: number;
	wave: number;
	startedAt?: number;
	completedAt?: number;
	error?: string;
	/** Quality tracking: cumulative praise count across loop runs. */
	praiseCount: number;
	/** Quality tracking: cumulative criticism count across loop runs. */
	criticismCount: number;
	/** Quality tracking: number of file conflicts this worker was involved in. */
	conflictCount: number;
	/** Mentor worker ID, set on scale-up for new workers. */
	mentorId?: string;
	/** Role override — "reviewer" when elected, undefined for normal workers. */
	role?: "reviewer";
	/** Model name assigned to this agent (from loop config or swarm definition). */
	modelName?: string;
	/** P7: AgentProfile ID — links to persistent identity / credit record. */
	profileId?: string;
	/** P7: Trust weight derived from profile credit score (0-1). */
	trustWeight?: number;
}

export interface SwarmState {
	name: string;
	status: PipelineStatus;
	mode: string;
	iteration: number;
	targetCount: number;
	agents: Record<string, AgentState>;
	startedAt: number;
	completedAt?: number;
	/** Loop-specific fields (set when mode === "loop") */
	loopIteration?: number;
	roundtablePhase?: string;
	reviewVerdict?: string;
	/** High-level workflow phase — drives frontend UI state machine. */
	loopPhase?: LoopPhase;
	/** To-Do items parsed from plan.md — tracked during loop execution. */
	todos?: TodoItem[];
	/** Cumulative input+output token usage across all agents in this run. */
	totalTokens?: number;
	/** Cumulative assistant API request count across all agents in this run. */
	totalRequests?: number;
}

// ============================================================================
// State tracker
// ============================================================================

export class StateTracker {
	#swarmDir: string;
	#state: SwarmState;
	/**
	 * Serialized write chain for session.jsonl persistence.
	 * All `#persist()` calls are chained on this promise so concurrent
	 * updates from parallel agent waves never interleave JSON writes.
	 */
	#writeChain: Promise<void> = Promise.resolve();
	/** Tracks whether a persist is already scheduled on the microtask queue. */
	#persistScheduled = false;
	/** OH-MY-PI SessionManager for dual-write persistence (optional). */
	#sessionManager: SwarmSessionManager | null = null;
	/**
	 * Optional real-time notification callback.  When set, every
	 * updateAgent() and updatePipeline() call fires this with a
	 * descriptive payload so the SSE broadcaster can push the state
	 * change to connected clients immediately — no polling delay.
	 */
	#onStateChange: ((event: { type: "agent_state" | "pipeline_state"; [key: string]: unknown }) => void) | null = null;

	constructor(workspaceDir: string, name: string) {
		this.#swarmDir = path.join(workspaceDir, `.swarm_${name}`);
		this.#state = {
			name,
			status: "idle",
			mode: "sequential",
			iteration: 0,
			targetCount: 1,
			agents: {},
			startedAt: Date.now(),
			loopPhase: "idle",
		};
	}

	/**
	 * Inject a SwarmSessionManager for dual-write persistence.
	 * When set, every state mutation is also written to session.jsonl.
	 */
	setSessionManager(sm: SwarmSessionManager): void {
		this.#sessionManager = sm;
	}

	/**
	 * Optional hook: called after every updateAgent / updatePipeline so
	 * the ActivityLogger can push real-time state updates via SSE.
	 */
	setStateChangeNotifier(fn: (event: { type: "agent_state" | "pipeline_state"; [key: string]: unknown }) => void): void {
		this.#onStateChange = fn;
	}

	get swarmDir(): string {
		return this.#swarmDir;
	}

	get state(): Readonly<SwarmState> {
		return this.#state;
	}

	async init(agentNames: string[], targetCount: number, mode: string): Promise<void> {
		await fs.mkdir(path.join(this.#swarmDir, "state"), { recursive: true });
		await fs.mkdir(path.join(this.#swarmDir, "logs"), { recursive: true });
		await fs.mkdir(path.join(this.#swarmDir, "context"), { recursive: true });

		this.#state.targetCount = targetCount;
		this.#state.mode = mode;
		this.#state.status = "running";
		this.#state.startedAt = Date.now();

		for (const name of agentNames) {
			this.#state.agents[name] = {
				name,
				status: "pending",
				iteration: 0,
				wave: 0,
				praiseCount: 0,
				criticismCount: 0,
				conflictCount: 0,
			};
		}

		await this.#persist();
	}

	/**
	 * Register a single agent at runtime (for loop mode where agents are
	 * created dynamically by LoopController, not from YAML).
	 * Idempotent — does nothing if the agent is already registered.
	 */
	async registerAgent(name: string, modelName?: string): Promise<void> {
		if (this.#state.agents[name]) return;
		this.#state.agents[name] = {
			name,
			status: "pending",
			iteration: 0,
			wave: 0,
			praiseCount: 0,
			criticismCount: 0,
			conflictCount: 0,
			modelName,
		};
		await this.#persist();
	}

	async updateAgent(name: string, update: Partial<AgentState>): Promise<void> {
		const agent = this.#state.agents[name];
		if (!agent) return;
		Object.assign(agent, update);
		await this.#persist();
		if (this.#onStateChange) {
			this.#onStateChange({
				type: "agent_state",
				worker: name,
				from: name,
				...update,
			});
		}
	}

	/** Increment praise count for a set of workers. */
	async incrementPraise(workerIds: string[]): Promise<void> {
		for (const id of workerIds) {
			const agent = this.#state.agents[id];
			if (agent) agent.praiseCount++;
		}
		await this.#persist();
		if (this.#onStateChange) {
			for (const id of workerIds) {
				const agent = this.#state.agents[id];
				if (agent) {
					this.#onStateChange({ type: "agent_state", worker: id, from: id, praiseCount: agent.praiseCount });
				}
			}
		}
	}

	/** Increment criticism count for a set of workers. */
	async incrementCriticism(workerIds: string[]): Promise<void> {
		for (const id of workerIds) {
			const agent = this.#state.agents[id];
			if (agent) agent.criticismCount++;
		}
		await this.#persist();
		if (this.#onStateChange) {
			for (const id of workerIds) {
				const agent = this.#state.agents[id];
				if (agent) {
					this.#onStateChange({ type: "agent_state", worker: id, from: id, criticismCount: agent.criticismCount });
				}
			}
		}
	}

	/** Increment conflict count for a worker. */
	async incrementConflict(workerId: string): Promise<void> {
		const agent = this.#state.agents[workerId];
		if (agent) agent.conflictCount++;
		await this.#persist();
		if (this.#onStateChange && agent) {
			this.#onStateChange({ type: "agent_state", worker: workerId, from: workerId, conflictCount: agent.conflictCount });
		}
	}

	/** Get a quality score for a worker (praise - criticism - conflictCount). */
	getWorkerScore(workerId: string): number {
		const agent = this.#state.agents[workerId];
		if (!agent) return 0;
		return agent.praiseCount - agent.criticismCount - agent.conflictCount;
	}

	/** Find the best-scoring worker (highest score), excluding given IDs. */
	getBestWorker(excludeIds?: string[]): string | null {
		let bestId: string | null = null;
		let bestScore = -Infinity;
		const exclude = new Set(excludeIds ?? []);
		for (const [id, agent] of Object.entries(this.#state.agents)) {
			if (exclude.has(id)) continue;
			const score = agent.praiseCount - agent.criticismCount - agent.conflictCount;
			if (score > bestScore) {
				bestScore = score;
				bestId = id;
			}
		}
		return bestId;
	}

	/**
	 * Find the worst-scoring worker.
	 * @param candidates — if provided, only search among these agent IDs.
	 *   If omitted, search all registered agents.
	 */
	getWorstWorker(candidates?: string[]): string | null {
		let worstId: string | null = null;
		let worstScore = Infinity;
		const candidateSet = candidates ? new Set(candidates) : null;
		for (const [id, agent] of Object.entries(this.#state.agents)) {
			if (candidateSet && !candidateSet.has(id)) continue;
			const score = agent.praiseCount - agent.criticismCount - agent.conflictCount;
			if (score < worstScore) {
				worstScore = score;
				worstId = id;
			}
		}
		return worstId;
	}

	/**
	 * Remove an agent from the state tracker (for loop mode scale-down).
	 * Prevents ID reuse from inheriting stale quality counters.
	 */
	async unregisterAgent(name: string): Promise<void> {
		delete this.#state.agents[name];
		await this.#persist();
	}

	/**
	 * Reset all agents to a clean state for retry.
	 * Clears status, iteration, timestamps, and quality counters so a
	 * fresh loop run starts from a clean slate.
	 */
	async resetAgentStatuses(): Promise<void> {
		for (const agent of Object.values(this.#state.agents)) {
			agent.status = "pending";
			agent.iteration = 0;
			agent.wave = 0;
			agent.startedAt = undefined;
			agent.completedAt = undefined;
			agent.error = undefined;
			agent.praiseCount = 0;
			agent.criticismCount = 0;
			agent.conflictCount = 0;
			agent.mentorId = undefined;
			agent.role = undefined;
		}
		this.#state.status = "running";
		this.#state.iteration = 0;
		this.#state.completedAt = undefined;
		await this.#persist();
	}

	async updatePipeline(update: Partial<SwarmState>): Promise<void> {
		Object.assign(this.#state, update);
		await this.#persist();
		if (this.#onStateChange) {
			const payload: Record<string, unknown> = { type: "pipeline_state" };
			if (update.loopIteration !== undefined) payload.loopIteration = update.loopIteration;
			if (update.roundtablePhase !== undefined) payload.roundtablePhase = update.roundtablePhase;
			if (update.todos !== undefined) payload.todos = update.todos;
			if (update.totalTokens !== undefined) payload.totalTokens = update.totalTokens;
			if (update.totalRequests !== undefined) payload.totalRequests = update.totalRequests;
			this.#onStateChange(payload as { type: "agent_state" | "pipeline_state"; [key: string]: unknown });
		}
	}

	async appendLog(agentName: string, message: string): Promise<void> {
		const logPath = path.join(this.#swarmDir, "logs", `${agentName}.log`);
		const timestamp = new Date().toISOString();
		await fs.appendFile(logPath, `[${timestamp}] ${message}\n`);
	}

	async appendOrchestratorLog(message: string): Promise<void> {
		const logPath = path.join(this.#swarmDir, "logs", "orchestrator.log");
		const timestamp = new Date().toISOString();
		await fs.appendFile(logPath, `[${timestamp}] ${message}\n`);
	}

	/**
	 * Persist the current in-memory state snapshot to session.jsonl via
	 * SwarmSessionManager.
	 *
	 * Uses a serialized write chain so concurrent updates from parallel
	 * agent waves are properly ordered. Rapid successive calls within
	 * the same microtask tick are coalesced into a single write.
	 *
	 * Returns the write chain promise so callers (e.g. tests) can await
	 * the actual write completion.
	 */
	async #persist(): Promise<void> {
		if (this.#persistScheduled) return;
		this.#persistScheduled = true;

		this.#writeChain = this.#writeChain.then(async () => {
			this.#persistScheduled = false;
			// Snapshot the state under the write chain so later mutations
			// queued behind us see fresh data.
			const snapshot = this.#state;
			try {
				this.#sessionManager?.logSwarmState(snapshot);
			} catch {
				// Swallow persist errors — we don't want state tracking
				// failures to crash the pipeline. The in-memory state is
				// still accurate for the current run.
			}
		});
		return this.#writeChain;
	}
}
