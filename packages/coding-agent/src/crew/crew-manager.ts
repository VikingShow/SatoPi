/**
 * CrewManager — Lifecycle manager for agent group chats (crews).
 *
 * Each crew wraps a CommChannel for messaging and persists state as
 * JSON files in `crewsDir`.  Supports create, join, leave, dispose,
 * and restore-from-disk workflows.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, Snowflake } from "@satopi/pi-utils";
import { CommChannel } from "../comm/comm-channel";
import type { IrcBus } from "../irc/bus";
import type { HookPipeline } from "../hooks/hook-pipeline";
import type { ActivityLogger } from "../infra/activity-logger";

// ============================================================================
// Public types
// ============================================================================

export interface CrewMember {
	agentId: string;
	role: "member" | "observer";
}

export interface CrewState {
	id: string;
	name: string;
	members: CrewMember[];
	createdAt: number;
}

export interface CrewSummary {
	id: string;
	name: string;
	memberCount: number;
}

// ============================================================================
// CrewManager
// ============================================================================

export class CrewManager {
	readonly #crewsDir: string;
	readonly #ircBus: IrcBus;
	readonly #hookPipeline: HookPipeline | undefined;
	readonly #activityLogger: ActivityLogger | undefined;

	readonly #crews = new Map<string, { state: CrewState; channel: CommChannel }>();

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

	// ========================================================================
	// Public API
	// ========================================================================

	/** Create a new crew.  Human is always added as observer. */
	async createCrew(name: string, members: string[], agentCreated?: boolean): Promise<string> {
		const crewId = Snowflake.generate();

		const crewMembers: CrewMember[] = [];
		for (const agentId of members) {
			crewMembers.push({ agentId, role: "member" });
		}
		// Ensure human is not duplicated
		if (!crewMembers.some(m => m.agentId === "human")) {
			crewMembers.push({ agentId: "human", role: "observer" });
		}

		const state: CrewState = {
			id: crewId,
			name,
			members: crewMembers,
			createdAt: Date.now(),
		};

		const channel = new CommChannel(
			this.#ircBus,
			crewMembers.filter(m => m.role === "member").map(m => m.agentId),
			crewMembers.filter(m => m.role === "observer").map(m => m.agentId),
			this.#activityLogger,
			this.#hookPipeline,
		);

		this.#crews.set(crewId, { state, channel });

		// Persist
		await this.#save(crewId, state);

		if (agentCreated) {
			logger.info("[CrewManager] Agent-created crew", { crewId, name, memberCount: members.length });
		} else {
			logger.info("[CrewManager] Crew created", { crewId, name, memberCount: members.length });
		}

		return crewId;
	}

	/** Add an agent as a member. */
	async addMember(crewId: string, agentId: string): Promise<void> {
		const entry = this.#crews.get(crewId);
		if (!entry) throw new Error(`Crew "${crewId}" not found`);

		if (!entry.state.members.some(m => m.agentId === agentId)) {
			entry.state.members.push({ agentId, role: "member" });
			entry.channel.addMember(agentId);
			await this.#save(crewId, entry.state);
		}
	}

	/** Remove an agent from a crew. */
	async removeMember(crewId: string, agentId: string): Promise<void> {
		const entry = this.#crews.get(crewId);
		if (!entry) throw new Error(`Crew "${crewId}" not found`);

		entry.state.members = entry.state.members.filter(m => m.agentId !== agentId);
		entry.channel.removeMember(agentId);
		await this.#save(crewId, entry.state);
	}

	/** Look up a crew by id. */
	getCrew(crewId: string): { state: CrewState; channel: CommChannel } | undefined {
		return this.#crews.get(crewId);
	}

	/** List all active crews. */
	listCrews(): CrewSummary[] {
		const summaries: CrewSummary[] = [];
		for (const [id, entry] of this.#crews) {
			summaries.push({
				id,
				name: entry.state.name,
				memberCount: entry.state.members.length,
			});
		}
		return summaries;
	}

	/** Dispose a single crew and delete its persisted state. */
	async disposeCrew(crewId: string): Promise<void> {
		this.#crews.delete(crewId);
		try {
			await fs.unlink(this.#statePath(crewId));
		} catch {
			// File may not exist — that's fine.
		}
	}

	/** Restore all crews from disk. */
	async restore(): Promise<void> {
		try {
			await fs.mkdir(this.#crewsDir, { recursive: true });
			const entries = await fs.readdir(this.#crewsDir, { withFileTypes: true });
			const files = entries.filter(e => e.isFile() && e.name.endsWith(".json"));

			for (const file of files) {
				try {
					const raw = await fs.readFile(path.join(this.#crewsDir, file.name), "utf-8");
					const state: CrewState = JSON.parse(raw);

					if (!state.id || !state.members) continue; // skip corrupt

					const channel = new CommChannel(
						this.#ircBus,
						state.members.filter(m => m.role === "member").map(m => m.agentId),
						state.members.filter(m => m.role === "observer").map(m => m.agentId),
						this.#activityLogger,
						this.#hookPipeline,
					);

					this.#crews.set(state.id, { state, channel });
				} catch {
					logger.warn("[CrewManager] Failed to restore crew file", { file: file.name });
				}
			}

			logger.info("[CrewManager] Restored crews", { count: this.#crews.size });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.warn("[CrewManager] Failed to read crews directory", { error: String(err) });
			}
		}
	}

	/** Dispose all crews and remove persisted state files. */
	async disposeAll(): Promise<void> {
		for (const crewId of [...this.#crews.keys()]) {
			await this.disposeCrew(crewId);
		}
	}

	// ========================================================================
	// Internals
	// ========================================================================

	#statePath(crewId: string): string {
		return path.join(this.#crewsDir, `${crewId}.json`);
	}

	async #save(crewId: string, state: CrewState): Promise<void> {
		try {
			await fs.mkdir(this.#crewsDir, { recursive: true });
			await fs.writeFile(this.#statePath(crewId), JSON.stringify(state, null, 2), "utf-8");
		} catch (err) {
			logger.warn("[CrewManager] Failed to persist crew state", { crewId, error: String(err) });
		}
	}
}
