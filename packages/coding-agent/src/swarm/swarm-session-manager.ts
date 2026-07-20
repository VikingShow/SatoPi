/**
 * SwarmSessionManager — Swarm-specific wrapper around OH-MY-PI's SessionManager.
 *
 * ## Motivation
 *
 * OH-MY-PI's SessionManager provides a battle-tested session persistence layer
 * (FileSessionStorage, compaction, fork/rollback, buildSessionContext).  However
 * its entry types (Message, CustomEntry, CompactionEntry, ...) are generic.
 *
 * SwarmSessionManager wraps SessionManager with **domain-specific entry types**
 * that map Swarm's 18 ActivityEventTypes to typed custom entries.  This keeps
 * Swarm's existing event taxonomy while gaining SessionManager's persistence,
 * compaction, and context-building infrastructure.
 *
 * ## Persistence
 *
 * Each SwarmSessionManager creates a SessionManager with FileSessionStorage.
 * The session file lives at:
 *
 *   .swarm_{name}/.omp/session.jsonl
 *
 * This is the SINGLE source of truth for all session activity — replacing:
 *   - pipeline.json       (StateTracker)
 *   - activity.jsonl      (ActivityLogger)
 *   - conversation.json   (before-loop-manager)
 *
 * ## SSE Push
 *
 * SwarmSessionManager does NOT handle SSE — the existing EventBus + ActivityLogger
 * SSE path remains unchanged.  SwarmSessionManager is purely a **persistence layer**.
 *
 * ## Usage
 *
 * ```typescript
 * const sm = await SwarmSessionManager.create(swarmDir);
 * sm.logSwarmState({ status: "running", iteration: 1 });
 * sm.logActivity({ ts, type: "broadcast", from: "worker-1", body: "..." });
 * sm.logPhase("running");
 * sm.appendConversationTurn("user", "hello");
 * ```
 */

import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger } from "@oh-my-pi/pi-utils";
import type { ActivityEntry, ActivityEventType } from "./activity-logger";
import type { LoopPhase, PipelineStatus, SwarmState, AgentState } from "./state";

// ============================================================================
// Custom entry type tags
// ============================================================================

/** Entry type suffix for SessionManager.appendCustomEntry(). */
export const CTX = {
	SWARM_STATE:  "swarm_state"  as const,
	AGENT_STATE:  "agent_state"  as const,
	ACTIVITY:     "swarm_activity" as const,
	PHASE:        "swarm_phase"  as const,
	VERDICT:      "swarm_verdict" as const,
	CONVERSATION: "socrates_turn" as const,
	BEFORE_LOOP:  "before_loop_state" as const,
} as const;

// ============================================================================
// SwarmSessionManager
// ============================================================================

export class SwarmSessionManager {
	readonly #session: SessionManager;
	readonly #swarmDir: string;

	private constructor(session: SessionManager, swarmDir: string) {
		this.#session = session;
		this.#swarmDir = swarmDir;
	}

	// -- Factory --------------------------------------------------------------

	/** Create a new SwarmSessionManager bound to the swarm directory. */
	static async create(swarmDir: string): Promise<SwarmSessionManager> {
		const session = SessionManager.create(swarmDir);
		logger.debug("[SwarmSessionManager] created", { swarmDir });
		return new SwarmSessionManager(session, swarmDir);
	}

	/** Open an existing session by file path. */
	static async open(filePath: string, swarmDir: string): Promise<SwarmSessionManager> {
		const session = await SessionManager.open(filePath);
		return new SwarmSessionManager(session, swarmDir);
	}

	/** Open or create — convenience. */
	static async openOrCreate(swarmDir: string): Promise<SwarmSessionManager> {
		// Try to open existing session file at swarmDir/.omp/session.jsonl
		try {
			const sessions = await SessionManager.list(swarmDir);
			if (sessions.length > 0) {
				return SwarmSessionManager.open(sessions[0].path, swarmDir);
			}
		} catch {
			// first run — no sessions yet
		}
		return SwarmSessionManager.create(swarmDir);
	}

	// -- Accessors ------------------------------------------------------------

	get swarmDir(): string { return this.#swarmDir; }

	// -- Swarm State ----------------------------------------------------------

	/** Log a full swarm state snapshot (replaces pipeline.json). */
	logSwarmState(state: Partial<SwarmState> & { ts?: number }): void {
		this.#session.appendCustomEntry(CTX.SWARM_STATE, {
			ts: state.ts ?? Date.now(),
			name: state.name,
			status: state.status,
			mode: state.mode,
			iteration: state.iteration,
			agents: state.agents,
			loopPhase: state.loopPhase,
			todos: state.todos,
		});
	}

	/** Log an individual agent state change. */
	logAgentState(name: string, partial: Partial<AgentState>): void {
		this.#session.appendCustomEntry(CTX.AGENT_STATE, { ts: Date.now(), name, ...partial });
	}

	// -- Activity Events ------------------------------------------------------

	/** Log a single activity event (replaces activity.jsonl append). */
	logActivity(entry: ActivityEntry): void {
		this.#session.appendCustomEntry(CTX.ACTIVITY, entry);
	}

	/** Log a batch of activity events (e.g. from history replay). */
	logActivities(entries: ActivityEntry[]): void {
		for (const entry of entries) {
			this.logActivity(entry);
		}
	}

	// -- Phase Transition -----------------------------------------------------

	/** Log a loop phase transition. */
	logPhase(phase: LoopPhase): void {
		this.#session.appendCustomEntry(CTX.PHASE, { ts: Date.now(), phase });
	}

	// -- Verdict --------------------------------------------------------------

	/** Log a cloner review verdict. */
	logVerdict(verdict: {
		iteration: number;
		passed: boolean;
		approval: number;
		total: number;
		findings: string[];
	}): void {
		this.#session.appendCustomEntry(CTX.VERDICT, { ts: Date.now(), ...verdict });
	}

	// -- Socrates Conversation ------------------------------------------------

	/** Append a conversation turn (replaces conversation.json). */
	appendConversationTurn(role: "user" | "assistant", content: string): void {
		this.#session.appendCustomEntry(CTX.CONVERSATION, { ts: Date.now(), role, content });
	}

	// -- Lifecycle ------------------------------------------------------------

	async flush(): Promise<void> { await this.#session.flush(); }
	flushSync(): void { this.#session.flushSync(); }
	async close(): Promise<void> { await this.#session.close(); }
}
