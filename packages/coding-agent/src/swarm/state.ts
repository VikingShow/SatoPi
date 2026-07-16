/**
 * Filesystem state tracker for swarm pipeline execution.
 *
 * Persists pipeline and per-agent state to `.swarm_<name>/` in the workspace.
 * Supports resumability by loading state from disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ============================================================================
// State types
// ============================================================================

export type PipelineStatus = "idle" | "running" | "completed" | "failed" | "aborted";
export type AgentStatus = "pending" | "waiting" | "running" | "completed" | "failed";

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
}

// ============================================================================
// State tracker
// ============================================================================

export class StateTracker {
	#swarmDir: string;
	#state: SwarmState;

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
		};
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
	async registerAgent(name: string): Promise<void> {
		if (this.#state.agents[name]) return;
		this.#state.agents[name] = {
			name,
			status: "pending",
			iteration: 0,
			wave: 0,
			praiseCount: 0,
			criticismCount: 0,
			conflictCount: 0,
		};
		await this.#persist();
	}

	async updateAgent(name: string, update: Partial<AgentState>): Promise<void> {
		const agent = this.#state.agents[name];
		if (!agent) return;
		Object.assign(agent, update);
		await this.#persist();
	}

	/** Increment praise count for a set of workers. */
	async incrementPraise(workerIds: string[]): Promise<void> {
		for (const id of workerIds) {
			const agent = this.#state.agents[id];
			if (agent) agent.praiseCount++;
		}
		await this.#persist();
	}

	/** Increment criticism count for a set of workers. */
	async incrementCriticism(workerIds: string[]): Promise<void> {
		for (const id of workerIds) {
			const agent = this.#state.agents[id];
			if (agent) agent.criticismCount++;
		}
		await this.#persist();
	}

	/** Increment conflict count for a worker. */
	async incrementConflict(workerId: string): Promise<void> {
		const agent = this.#state.agents[workerId];
		if (agent) agent.conflictCount++;
		await this.#persist();
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

	/** Find the worst-scoring worker. */
	getWorstWorker(excludeIds?: string[]): string | null {
		let worstId: string | null = null;
		let worstScore = Infinity;
		const exclude = new Set(excludeIds ?? []);
		for (const [id, agent] of Object.entries(this.#state.agents)) {
			if (exclude.has(id)) continue;
			const score = agent.praiseCount - agent.criticismCount - agent.conflictCount;
			if (score < worstScore) {
				worstScore = score;
				worstId = id;
			}
		}
		return worstId;
	}

	async updatePipeline(update: Partial<SwarmState>): Promise<void> {
		Object.assign(this.#state, update);
		await this.#persist();
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

	async load(): Promise<SwarmState | null> {
		const statePath = path.join(this.#swarmDir, "state", "pipeline.json");
		try {
			const content = await Bun.file(statePath).text();
			this.#state = JSON.parse(content) as SwarmState;
			return this.#state;
		} catch {
			return null;
		}
	}

	async #persist(): Promise<void> {
		await Bun.write(path.join(this.#swarmDir, "state", "pipeline.json"), JSON.stringify(this.#state, null, 2));
	}
}
