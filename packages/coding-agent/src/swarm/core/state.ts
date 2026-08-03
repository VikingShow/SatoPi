/**
 * In-memory state tracker for swarm pipeline execution.
 *
 * Persists state via SwarmSessionManager → session.jsonl (OH-MY-PI SessionManager).
 * Per-agent logs are still written to `.stp/sessions/swarm-<name>/logs/` for forensic debugging.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Chapter } from "../../types/chapter";
import type { SwarmSessionManager } from "../session/swarm-session-manager";

// ============================================================================
// Audit trail
// ============================================================================

/** A single FSM transition record for the audit trail. */
export interface TransitionRecord {
	from: Chapter;
	to: Chapter;
	reason?: string;
	iteration: number;
	timestamp: number;
}

// ============================================================================
// State types
// ============================================================================

export type PipelineStatus = "idle" | "running" | "completed" | "failed" | "aborted";
export type AgentStatus = "pending" | "waiting" | "running" | "completed" | "failed";

/**
 * Workflow phase — a string tag that identifies the current stage.
 *
 * Re-exported from src/types/chapter.ts for backward compatibility.
 * NEW CODE should import directly from "../../types/chapter".
 */
export type { Chapter } from "../../types/chapter";

/** Global swarm phase indicator — updated by WorkflowFSM on every transition. Read by TUI components. */
export let currentSwarmPhase: Chapter = "idle";
export function setCurrentSwarmPhase(phase: Chapter): void {
	currentSwarmPhase = phase;
}

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
	/** Mentor agent ID, set on scale-up for new agents. */
	mentorId?: string;
	/** Role override — "reviewer" when elected, undefined for normal agents. */
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
	/** Iteration counter (set during Stage phase). */
	loopIteration?: number;
	/** Sub-phase label string for UI display. */
	roundtablePhase?: string;
	/** Review verdict summary string. */
	reviewVerdict?: string;
	/** High-level workflow phase — drives frontend UI state machine. */
	phase?: Chapter;
	/** To-Do items parsed from plan.md — tracked during execution. */
	todos?: TodoItem[];
	/** Cumulative input+output token usage across all agents in this run. */
	totalTokens?: number;
	/** Cumulative assistant API request count across all agents in this run. */
	totalRequests?: number;
	/** Per-node cumulative token usage (nodeId → token count). */
	nodeTokens?: Record<string, number>;
	/** FSM transition audit trail — appended on every phase change. */
	transitionHistory?: TransitionRecord[];
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

	constructor(workspaceDir: string, name: string) {
		this.#swarmDir = path.join(workspaceDir, ".stp", "sessions", `swarm-${name}`);
		this.#state = {
			name,
			status: "idle",
			mode: "sequential",
			iteration: 0,
			targetCount: 1,
			agents: {},
			startedAt: Date.now(),
			phase: "idle",
			transitionHistory: [],
		};
	}

	/**
	 * Inject a SwarmSessionManager for dual-write persistence.
	 * When set, every state mutation is also written to session.jsonl.
	 */
	setSessionManager(sm: SwarmSessionManager): void {
		this.#sessionManager = sm;
	}

	get swarmDir(): string {
		return this.#swarmDir;
	}

	get state(): Readonly<SwarmState> {
		return this.#state;
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
			modelName,
		};
		await this.#persist();
	}

	async updateAgent(name: string, update: Partial<AgentState>): Promise<void> {
		const agent = this.#state.agents[name];
		if (!agent) return;
		Object.assign(agent, update);
		await this.#persist();
	}

	/**
	 * Find the most-productive worker (highest per-agent iteration count),
	 * excluding the given IDs. Iteration is the surviving per-agent work
	 * metric — the praise/criticism/conflict quality counters were removed.
	 */
	getBestAgent(excludeIds?: string[]): string | null {
		let bestId: string | null = null;
		let bestIteration = -Infinity;
		const exclude = new Set(excludeIds ?? []);
		for (const [id, agent] of Object.entries(this.#state.agents)) {
			if (exclude.has(id)) continue;
			if (agent.iteration > bestIteration) {
				bestIteration = agent.iteration;
				bestId = id;
			}
		}
		return bestId;
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
				await this.#sessionManager?.logSwarmState(snapshot);
			} catch {
				// Swallow persist errors — we don't want state tracking
				// failures to crash the pipeline. The in-memory state is
				// still accurate for the current run.
			}
		});
		return this.#writeChain;
	}
}
