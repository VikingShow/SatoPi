/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`irc`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 *
 * **Instance injection is preferred** over the {@link global} singleton.
 * Create a fresh AgentRegistry per session to isolate registrations:
 *
 * ```ts
 * const registry = new AgentRegistry();            // preferred
 * const registry = AgentRegistry.global();         // backward compat
 * ```
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";

export const MAIN_AGENT_ID = "Main";

/**
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript — hidden from rosters.
 * - `persistent`: cross-session agent with AgentProfile + role identity.
 */
export type AgentKind = "main" | "sub" | "advisor" | "persistent";

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Associated AgentProfile (only for persistent agents). */
	profileId?: string;
	/** Current role name (only for persistent agents). */
	role?: string;
}

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
	/** Associated AgentProfile id (only for persistent agents). */
	profileId?: string;
	/** Current role name (only for persistent agents). */
	role?: string;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	/**
	 * Returns the process-global singleton. Prefer creating a fresh instance
	 * via `new AgentRegistry()` per session for isolation.
	 */
	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();

	register(input: RegisterInput): AgentRef {
		const existing = this.#refs.get(input.id);
		if (existing) {
			logger.warn("AgentRegistry.register: duplicate id — disposing old session", { id: input.id });
			if (existing.session) {
				existing.session.dispose().catch(err =>
					logger.warn("AgentRegistry.register: failed to dispose old session", { id: input.id, error: String(err) }),
				);
			}
			this.unregister(input.id);
		}

		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: now,
			lastActivity: now,
			profileId: input.profileId,
			role: input.role,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	/**
	 * Attach a live session to an already-registered agent.
	 * No-op when the agent is not found.
	 */
	setSession(id: string, session: AgentSession): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = session;
	}

	setStatus(id: string, status: AgentStatus): void {
		const ref = this.#refs.get(id);
		if (!ref || ref.status === status) return;
		ref.status = status;
		// Activity describes current work; it is meaningless once the agent
		// leaves `running`, so drop it to avoid showing stale work in rosters.
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
	}

	/**
	 * Record a short activity gist for the work-aware roster. Display-only and
	 * read on demand (`irc list`, peer roster), so it emits no event — keeping
	 * the per-tool-call update rate off the registry listener path (same as
	 * `attachSession`, which also bumps `lastActivity` without emitting). Only a
	 * `running` agent has current work: a heartbeat for any other status is
	 * dropped, so a late progress flush can't resurrect activity on a ref that
	 * `setStatus` just cleared. Every running heartbeat refreshes `lastActivity`
	 * — even when the gist text is unchanged — so the roster's "active … ago" and
	 * recency sort track real work, not just the last status change.
	 * The gist is normalized to one bounded line (`oneLineLabel`) so model-derived
	 * intent text can neither break the roster nor smuggle terminal escapes —
	 * every caller is safe without sanitizing at its own call site.
	 */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	attachSession(id: string, session: AgentSession, sessionFile?: string | null): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
	}

	detachSession(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		ref.session = null;
	}

	unregister(id: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	/**
	 * Find an agent by its persistent profile ID.
	 * Returns the first matching agent ref, or undefined if none found.
	 */
	findByProfileId(profileId: string): AgentRef | undefined {
		for (const ref of this.#refs.values()) {
			if (ref.profileId === profileId) return ref;
		}
		return undefined;
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Returns every alive agent (running | idle) except the caller. Advisor refs
	 * are observability-only transcripts, never peers, so they are excluded.
	 * Flat namespace: every other agent is visible.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => ref.id !== id && ref.kind !== "advisor" && (ref.status === "running" || ref.status === "idle"),
		);
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
