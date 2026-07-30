import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@satopi/pi-utils";
import { CommChannel } from "../comm/comm-channel";
import type { IrcBus } from "../irc/bus";
import type { HookPipeline } from "../hooks/hook-pipeline";
import type { ActivityLogger } from "../infra/activity-logger";

/**
 * CrewManager — Manages persistent agent group chats (crews).
 *
 * A Crew is a named subset of agents with a shared CommChannel.
 * Crews are persisted to disk and survive swarm restarts.
 * Human is auto-added as observer when a crew is created by an agent.
 *
 * ## Persistence
 *   Crew metadata: {swarm-dir}/crews/{crew-id}.json
 *   Crew transcript: {swarm-dir}/crews/{crew-id}.jsonl
 *
 * ## Lifecycle
 *   createCrew(name, members) → crewId
 *   addMember(crewId, agentId) → join notification
 *   removeMember(crewId, agentId) → leave notification
 *   getCrew(crewId) → crew state + channel
 *   listCrews() → all crew summaries


// ============================================================================
// Types
// ============================================================================

export interface CrewMember {
	agentId: string;
	joinedAt: number;
}

export interface CrewState {
	id: string;
	name: string;
	members: CrewMember[];
	createdAt: number;
	/** Whether this crew was created by an agent (auto-adds human as observer). */
	agentCreated: boolean;
}

export interface CrewSummary {
	id: string;
	name: string;
	memberCount: number;
	createdAt: number;
}

// ============================================================================
// CrewManager
// ============================================================================

export class CrewManager {
	readonly #crewsDir: string;
	readonly #ircBus: IrcBus;
	readonly #hookPipeline?: HookPipeline;
	readonly #activityLogger?: ActivityLogger;
	readonly #channels = new Map<string, CommChannel>();
	readonly #states = new Map<string, CrewState>();

	constructor(
		crewsDir: string,
		ircBus: IrcBus,
		opts?: { hookPipeline?: HookPipeline; activityLogger?: ActivityLogger },
	) {
		this.#crewsDir = crewsDir;
		this.#ircBus = ircBus;
		this.#hookPipeline = opts?.hookPipeline;
		this.#activityLogger = opts?.activityLogger;
	}

	// ==========================================================================
	// Persistence
	// ==========================================================================

	private crewPath(crewId: string): string {
		return path.join(this.#crewsDir, `${crewId}.json`);
	}

	private transcriptPath(crewId: string): string {
		return path.join(this.#crewsDir, `${crewId}.jsonl`);
	}

	async #saveState(crewId: string): Promise<void> {
		const state = this.#states.get(crewId);
		if (!state) return;
		await fs.mkdir(this.#crewsDir, { recursive: true });
		await fs.writeFile(this.crewPath(crewId), JSON.stringify(state, null, 2), "utf-8");
	}

	async #loadState(crewId: string): Promise<CrewState | null> {
		try {
			const raw = await fs.readFile(this.crewPath(crewId), "utf-8");
			return JSON.parse(raw) as CrewState;
		} catch {
			return null;
		}
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	/**
	 * Create a new crew.
	 *
	 * @param name Human-readable crew name.
	 * @param memberIds Initial agent members.
	 * @param agentCreated Whether this crew was created by an agent (default false).
	 *   When true, human is auto-added as observer.
	 * @returns The crew ID.
	 */
	async createCrew(name: string, memberIds: string[], agentCreated = false): Promise<string> {
		const crewId = `crew-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const now = Date.now();

		const state: CrewState = {
			id: crewId,
			name,
			members: memberIds.map(id => ({ agentId: id, joinedAt: now })),
			createdAt: now,
			agentCreated,
		};

		const observers = agentCreated ? ["human"] : [];
		const channel = new CommChannel(
			this.#ircBus,
			memberIds,
			observers,
			this.#activityLogger,
			this.#hookPipeline,
		);

		this.#states.set(crewId, state);
		this.#channels.set(crewId, channel);
		await this.#saveState(crewId);

		logger.info("[CrewManager] Crew created", { crewId, name, memberCount: memberIds.length, agentCreated });
		return crewId;
	}

	/**
	 * Add a member to an existing crew.
	 * Broadcasts a join notification to all members.
	 */
	async addMember(crewId: string, agentId: string): Promise<void> {
		const state = this.#states.get(crewId);
		const channel = this.#channels.get(crewId);
		if (!state || !channel) {
			throw new Error(`Crew "${crewId}" not found`);
		}

		if (state.members.some(m => m.agentId === agentId)) {
			return; // Already a member
		}

		state.members.push({ agentId, joinedAt: Date.now() });
		channel.addMember(agentId);
		await this.#saveState(crewId);

		logger.info("[CrewManager] Member added", { crewId, agentId });
	}

	/**
	 * Remove a member from a crew.
	 * Broadcasts a leave notification to remaining members.
	 */
	async removeMember(crewId: string, agentId: string): Promise<void> {
		const state = this.#states.get(crewId);
		const channel = this.#channels.get(crewId);
		if (!state || !channel) {
			throw new Error(`Crew "${crewId}" not found`);
		}

		state.members = state.members.filter(m => m.agentId !== agentId);
		channel.removeMember(agentId);
		await this.#saveState(crewId);

		logger.info("[CrewManager] Member removed", { crewId, agentId });
	}

	/**
	 * Get a crew's state and its CommChannel.
	 * Returns undefined if the crew doesn't exist.
	 */
	getCrew(crewId: string): { state: CrewState; channel: CommChannel } | undefined {
		const state = this.#states.get(crewId);
		const channel = this.#channels.get(crewId);
		if (!state || !channel) return undefined;
		return { state, channel };
	}

	/**
	 * List all crew summaries (for TUI sidebar).
	 */
	listCrews(): CrewSummary[] {
		return [...this.#states.values()].map(s => ({
			id: s.id,
			name: s.name,
			memberCount: s.members.length,
			createdAt: s.createdAt,
		}));
	}

	/**
	 * Dispose a crew — persist final transcript, clean up channel, remove from memory.
	 */
	async disposeCrew(crewId: string): Promise<void> {
		const channel = this.#channels.get(crewId);
		if (channel) {
			// Fire-and-forget broadcast final message
			channel.send("system", "[System] Crew has been disbanded.").catch(() => {});
			this.#channels.delete(crewId);
		}
		this.#states.delete(crewId);

		// Clean up persisted state
		try {
			await fs.unlink(this.crewPath(crewId));
		} catch {
			// File may not exist
		}

		logger.info("[CrewManager] Crew disposed", { crewId });
	}

	/**
	 * Restore crews from disk (called on swarm restart).
	 */
	async restore(): Promise<void> {
		try {
			await fs.mkdir(this.#crewsDir, { recursive: true });
			const files = await fs.readdir(this.#crewsDir);
			for (const file of files) {
				if (!file.endsWith(".json")) continue;
				const crewId = file.replace(".json", "");
				const state = await this.#loadState(crewId);
				if (!state) continue;

				const observers = state.agentCreated ? ["human"] : [];
				const channel = new CommChannel(
					this.#ircBus,
					state.members.map(m => m.agentId),
					observers,
					this.#activityLogger,
					this.#hookPipeline,
				);

				this.#states.set(crewId, state);
				this.#channels.set(crewId, channel);
			}
			logger.info("[CrewManager] Restored crews", { count: this.#states.size });
		} catch (err) {
			logger.warn("[CrewManager] Failed to restore crews", { error: String(err) });
		}
	}

	/**
	 * Dispose all crews.
	 */
	async disposeAll(): Promise<void> {
		const ids = [...this.#states.keys()];
		await Promise.all(ids.map(id => this.disposeCrew(id)));
	}
}
