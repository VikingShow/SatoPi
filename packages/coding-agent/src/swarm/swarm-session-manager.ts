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
import { logger } from "@oh-my-pi/pi-utils";
import * as path from "node:path";
import * as fs from "node:fs/promises";
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
	CONVERSATION_SNAPSHOT: "conversation_snapshot" as const,
} as const;

// ============================================================================
// SwarmSessionManager
// ============================================================================

export class SwarmSessionManager {
	readonly #session: SessionManager;
	readonly #swarmDir: string;
	/** Session data dir: .swarm_{name}/.omp/sessions/ */
	readonly #sessionDir: string;

	private constructor(session: SessionManager, swarmDir: string, sessionDir: string) {
		this.#session = session;
		this.#swarmDir = swarmDir;
		this.#sessionDir = sessionDir;
	}

	/** The session dir under the swarm directory. */
	static sessionDir(swarmDir: string): string {
		return path.join(swarmDir, ".omp", "sessions");
	}

	// -- Factory --------------------------------------------------------------

	/** Create a new SwarmSessionManager. Forces session file creation in the swarm dir. */
	static async create(swarmDir: string): Promise<SwarmSessionManager> {
		const sessionDir = SwarmSessionManager.sessionDir(swarmDir);
		await fs.mkdir(sessionDir, { recursive: true });

		// SessionManager's lazy gate only creates files after an assistant
		// message. Since Swarm uses custom entries exclusively, we manually
		// bootstrap the session header file, then open it with SessionManager.
		const id = crypto.randomUUID();
		const timestamp = new Date().toISOString();
		const safeTs = timestamp.replace(/[:.]/g, "-");
		const filePath = path.join(sessionDir, `${safeTs}_${id}.jsonl`);

		// Write a standard OH-MY-PI session header (matches createEmptySessionFile format).
		const header = {
			type: "session",
			version: 1,
			id,
			timestamp,
			cwd: path.resolve(swarmDir),
		};
		await fs.writeFile(filePath, JSON.stringify(header) + "\n", "utf-8");

		const session = await SessionManager.open(filePath);
		logger.debug("[SwarmSessionManager] created", { swarmDir, filePath });
		return new SwarmSessionManager(session, swarmDir, sessionDir);
	}

	/** Open an existing session by file path. */
	static async open(filePath: string, swarmDir: string): Promise<SwarmSessionManager> {
		const session = await SessionManager.open(filePath);
		const sessionDir = path.dirname(filePath);
		return new SwarmSessionManager(session, swarmDir, sessionDir);
	}

	/** Open or create. */
	static async openOrCreate(swarmDir: string): Promise<SwarmSessionManager> {
		const sessionDir = SwarmSessionManager.sessionDir(swarmDir);
		try {
			const sessions = await SessionManager.list(swarmDir, sessionDir);
			if (sessions.length > 0) {
				// Open the most recently modified session
				sessions.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
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

	/** Append a single conversation turn (incremental — future use). */
	appendConversationTurn(role: "user" | "assistant", content: string): void {
		this.#session.appendCustomEntry(CTX.CONVERSATION, { ts: Date.now(), role, content });
	}

	/**
	 * Persist the full conversation history as a snapshot.
	 * Called by BeforeLoopManager after each turn mutation.
	 * This replaces the legacy conversation.json file.
	 */
	logConversationSnapshot(turns: Array<{ role: string; content: string }>): void {
		this.#session.appendCustomEntry(CTX.CONVERSATION_SNAPSHOT, { ts: Date.now(), turns });
	}

	// -- Lifecycle ------------------------------------------------------------

	async flush(): Promise<void> { await this.#session.flush(); }
	flushSync(): void { this.#session.flushSync(); }
	async close(): Promise<void> { await this.#session.close(); }

	// -- Static Query Helpers ------------------------------------------------

	/**
	 * Find the latest session file in the swarm's session directory.
	 * Returns the file path, or null if no sessions exist.
	 */
	static async findLatestSessionFile(swarmDir: string): Promise<string | null> {
		const sessionDir = SwarmSessionManager.sessionDir(swarmDir);
		try {
			const sessions = await SessionManager.list(swarmDir, sessionDir);
			if (sessions.length === 0) return null;
			sessions.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
			return sessions[0].path;
		} catch {
			return null;
		}
	}

	/**
	 * Read all raw entries from the swarm's latest session file.
	 * Each entry is a JSON line: { type: "custom", customType: "swarm_*", data: {...}, ... }.
	 */
	static async readRawEntries(swarmDir: string): Promise<Array<Record<string, unknown>>> {
		const filePath = await SwarmSessionManager.findLatestSessionFile(swarmDir);
		if (!filePath) return [];
		try {
			const content = await fs.readFile(filePath, "utf-8");
			return content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
		} catch {
			return [];
		}
	}

	/**
	 * Read all activity entries (customType === "swarm_activity") from the
	 * session file.  Returns the unwrapped data payloads.
	 */
	static async readActivityEntries(swarmDir: string): Promise<ActivityEntry[]> {
		const raw = await SwarmSessionManager.readRawEntries(swarmDir);
		return raw
			.filter(e => e.type === "custom" && e.customType === CTX.ACTIVITY)
			.map(e => e.data as ActivityEntry);
	}

	/**
	 * Read the most recent swarm state entry from the session file.
	 * Returns null if no state has been persisted yet.
	 */
	static async readLatestState(swarmDir: string): Promise<Partial<SwarmState> | null> {
		const raw = await SwarmSessionManager.readRawEntries(swarmDir);
		for (let i = raw.length - 1; i >= 0; i--) {
			const e = raw[i];
			if (e.type === "custom" && e.customType === CTX.SWARM_STATE) {
				return (e.data as Partial<SwarmState>) ?? null;
			}
		}
		return null;
	}

	/**
	 * Count all activity entries in the session file.
	 */
	static async countActivityEntries(swarmDir: string): Promise<number> {
		const entries = await SwarmSessionManager.readActivityEntries(swarmDir);
		return entries.length;
	}
}
