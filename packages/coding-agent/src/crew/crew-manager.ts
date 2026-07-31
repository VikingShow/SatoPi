/**
 * CrewManager — Lifecycle manager for agent group chats (crews).
 *
 * Each crew wraps a CommChannel for messaging and persists state as
 * JSON files in `crewsDir`.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, Snowflake } from "@satopi/pi-utils";
import { CommChannel } from "../comm/comm-channel";
import type { HookPipeline } from "../hooks/hook-pipeline";
import type { ActivityLogger } from "../infra/activity-logger";
import type { IrcBus } from "../irc/bus";

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
	activeGraph?: { graphPath: string; phase: string };
}

export interface CrewSummary {
	id: string;
	name: string;
	memberCount: number;
}

// ============================================================================
// CrewManager
// ============================================================================

type CrewEntry = { state: CrewState; channel: CommChannel };

export class CrewManager {
	readonly #crewsDir: string;
	readonly #ircBus: IrcBus;
	readonly #hookPipeline: HookPipeline | undefined;
	readonly #activityLogger: ActivityLogger | undefined;
	readonly #crews = new Map<string, CrewEntry>();

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

	// -- create ---------------------------------------------------------------

	/** Create a new crew. Human is always auto-added as an observer. */
	async createCrew(name: string, members: string[], agentCreated?: boolean): Promise<string> {
		const crewId = Snowflake.next();
		const state = this.#makeState(crewId, name, members);
		const channel = this.#makeChannel(state.members, crewId);
		this.#crews.set(crewId, { state, channel });
		await this.#save(crewId, state);
		logger.info("[CrewManager] Crew created", {
			crewId,
			name,
			memberCount: members.length,
			agentCreated: !!agentCreated,
		});
		return crewId;
	}

	// -- membership -----------------------------------------------------------

	async addMember(crewId: string, agentId: string): Promise<void> {
		const entry = this.#mustGet(crewId);
		if (entry.state.members.some(m => m.agentId === agentId)) return;
		entry.state.members.push({ agentId, role: "member" });
		entry.channel.addMember(agentId);
		await this.#save(crewId, entry.state);
	}

	async removeMember(crewId: string, agentId: string): Promise<void> {
		const entry = this.#mustGet(crewId);
		entry.state.members = entry.state.members.filter(m => m.agentId !== agentId);
		entry.channel.removeMember(agentId);
		await this.#save(crewId, entry.state);
	}

	// -- lookup ---------------------------------------------------------------

	getCrew(crewId: string): CrewEntry | undefined {
		return this.#crews.get(crewId);
	}

	listCrews(): CrewSummary[] {
		const out: CrewSummary[] = [];
		for (const [id, e] of this.#crews) {
			out.push({ id, name: e.state.name, memberCount: e.state.members.length });
		}
		return out;
	}

	// -- lifecycle ------------------------------------------------------------

	async disposeCrew(crewId: string): Promise<void> {
		this.#crews.delete(crewId);
		try {
			await fs.unlink(path.join(this.#crewsDir, `${crewId}.json`));
		} catch {
			/* ok */
		}
	}

	async disposeAll(): Promise<void> {
		for (const crewId of [...this.#crews.keys()]) {
			await this.disposeCrew(crewId);
		}
	}

	/** Restore all crews from persisted JSON files. */
	async restore(): Promise<void> {
		try {
			await fs.mkdir(this.#crewsDir, { recursive: true });
			for (const f of await fs.readdir(this.#crewsDir)) {
				if (!f.endsWith(".json")) continue;
				try {
					const state: CrewState = JSON.parse(await fs.readFile(path.join(this.#crewsDir, f), "utf-8"));
					if (!state.id || !state.members) continue;
					this.#crews.set(state.id, {
						state,
						channel: this.#makeChannel(state.members, state.id),
					});
				} catch {
					/* skip corrupt files */
				}
			}
			logger.info("[CrewManager] Restored crews", { count: this.#crews.size });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.warn("[CrewManager] Failed to restore", { error: String(err) });
			}
		}
	}

	// ========================================================================
	// Internals
	// ========================================================================

	#mustGet(crewId: string): CrewEntry {
		const entry = this.#crews.get(crewId);
		if (!entry) throw new Error(`Crew "${crewId}" not found`);
		return entry;
	}

	#makeState(crewId: string, name: string, memberIds: string[]): CrewState {
		const members: CrewMember[] = memberIds.map(agentId => ({ agentId, role: "member" }));
		if (!members.some(m => m.agentId === "human")) {
			members.push({ agentId: "human", role: "observer" });
		}
		return { id: crewId, name, members, createdAt: Date.now() };
	}
	#makeChannel(members: CrewMember[], crewId: string): CommChannel {
		return new CommChannel(
			this.#ircBus,
			members.filter(m => m.role === "member").map(m => m.agentId),
			members.filter(m => m.role === "observer").map(m => m.agentId),
			this.#activityLogger,
			this.#hookPipeline,
			(from, body) => {
				this.persistMessage(crewId, from, body).catch(() => {});
			},
		);
	}

	/** Append a message to the crew's transcript JSONL file. */
	async persistMessage(crewId: string, from: string, body: string): Promise<void> {
		try {
			const line = `${JSON.stringify({ ts: Date.now(), from, body })}\n`;
			await fs.appendFile(path.join(this.#crewsDir, `${crewId}.jsonl`), line, "utf-8");
		} catch (err) {
			logger.warn("[CrewManager] Transcript persist failed", { crewId, error: String(err) });
		}
	}

	async #save(crewId: string, state: CrewState): Promise<void> {
		try {
			await fs.mkdir(this.#crewsDir, { recursive: true });
			await fs.writeFile(path.join(this.#crewsDir, `${crewId}.json`), JSON.stringify(state, null, 2), "utf-8");
		} catch (err) {
			logger.warn("[CrewManager] Persist failed", { crewId, error: String(err) });
		}
	}
}
