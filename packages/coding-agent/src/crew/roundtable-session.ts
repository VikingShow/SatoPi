/**
 * RoundtableSession — Multi-round structured discussion within a Crew.
 *
 * Agents participate in rounds, each round collects responses, and convergence
 * is detected via Jaccard text similarity (delegated to CommChannel.roundtable).
 *
 * ## Persistence
 *   Transcript: {swarm-dir}/roundtables/{id}.jsonl
 *   Includes: topic, round responses, convergence status, agent positions
 *
 * ## Usage
 *   const session = new RoundtableSession(crewManager, transcriptDir);
 *   const result = await session.run(topic, {
 *     rounds: 3,
 *     agentIds: ["architect", "reviewer"],
 *   });
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@satopi/pi-utils";
import type { CrewManager } from "./crew-manager";

// ============================================================================
// Types
// ============================================================================

export interface RoundtableConfig {
	/** Number of discussion rounds (default 3). */
	rounds?: number;
	/** Agent IDs participating (defaults to all crew members). */
	agentIds?: string[];
	/** Jaccard similarity threshold for convergence (default 0.85). */
	convergenceThreshold?: number;
	/** Consecutive rounds above threshold before early exit (default 2). */
	convergenceStreak?: number;
	/** Per-round timeout in ms (default 60s). */
	timeoutMs?: number;
}

export interface RoundtableResult {
	/** Whether convergence was reached. */
	converged: boolean;
	/** Number of rounds executed. */
	rounds: number;
	/** All response strings across all rounds. */
	responses: string[];
	/** Final positions from last round. */
	finalPositions: string[];
	/** Per-agent final positions. */
	agentPositions: Map<string, string>;
}

export interface RoundtableTranscript {
	id: string;
	topic: string;
	crewId: string;
	config: RoundtableConfig;
	result: RoundtableResult;
	startedAt: number;
	completedAt: number;
}

// ============================================================================
// RoundtableSession
// ============================================================================

export class RoundtableSession {
	readonly #crewManager: CrewManager;
	readonly #transcriptDir: string;
	#currentTranscript: RoundtableTranscript | null = null;

	constructor(crewManager: CrewManager, transcriptDir: string) {
		this.#crewManager = crewManager;
		this.#transcriptDir = transcriptDir;
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	/**
	 * Run a multi-round discussion within a crew.
	 *
	 * @param crewId The crew to run the roundtable in.
	 * @param topic The discussion topic/question.
	 * @param config Roundtable configuration.
	 */
	async run(crewId: string, topic: string, config: RoundtableConfig = {}): Promise<RoundtableResult> {
		const crew = this.#crewManager.getCrew(crewId);
		if (!crew) {
			throw new Error(`Crew "${crewId}" not found`);
		}

		const agentIds = config.agentIds ?? crew.state.members.map(m => m.agentId);
		const rounds = config.rounds ?? 3;

		const roundtableId = `roundtable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const startedAt = Date.now();

		logger.info("[RoundtableSession] Starting", {
			roundtableId,
			crewId,
			topic: topic.slice(0, 80),
			rounds,
			agentIds,
		});

		// Delegate to CommChannel.roundtable for the actual discussion
		const channelResult = await crew.channel.roundtable(topic, {
			rounds,
			timeoutMs: config.timeoutMs ?? 60_000,
			convergenceThreshold: config.convergenceThreshold,
			convergenceStreak: config.convergenceStreak,
			agentIds,
			phase: crew.state.activeGraph?.phase,
		});

		const result: RoundtableResult = {
			converged: channelResult.converged,
			rounds: channelResult.rounds,
			responses: channelResult.responses,
			finalPositions: channelResult.finalPositions,
			agentPositions: new Map(), // CommChannel doesn't provide per-agent mapping
		};

		// Persist transcript
		const transcript: RoundtableTranscript = {
			id: roundtableId,
			topic,
			crewId,
			config,
			result,
			startedAt,
			completedAt: Date.now(),
		};

		this.#currentTranscript = transcript;
		await this.#saveTranscript(transcript);

		logger.info("[RoundtableSession] Complete", {
			roundtableId,
			converged: result.converged,
			rounds: result.rounds,
		});

		return result;
	}

	/**
	 * Get the current (last completed) transcript.
	 */
	getTranscript(): RoundtableTranscript | null {
		return this.#currentTranscript;
	}

	// ==========================================================================
	// Persistence
	// ==========================================================================

	private transcriptPath(id: string): string {
		return path.join(this.#transcriptDir, `${id}.jsonl`);
	}

	async #saveTranscript(transcript: RoundtableTranscript): Promise<void> {
		try {
			await fs.mkdir(this.#transcriptDir, { recursive: true });
			const entry = {
				type: "roundtable",
				...transcript,
			};
			await fs.appendFile(this.transcriptPath(transcript.id), `${JSON.stringify(entry)}\n`, "utf-8");
		} catch (err) {
			logger.warn("[RoundtableSession] Failed to save transcript", { error: String(err) });
		}
	}

	/**
	 * Load a roundtable transcript from disk.
	 */
	async loadTranscript(id: string): Promise<RoundtableTranscript | null> {
		try {
			const raw = await fs.readFile(this.transcriptPath(id), "utf-8");
			const lines = raw.trim().split("\n");
			if (lines.length === 0) return null;
			const entry = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
			if (entry.type !== "roundtable") return null;
			return entry as unknown as RoundtableTranscript;
		} catch {
			return null;
		}
	}
}
