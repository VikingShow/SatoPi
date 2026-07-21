/**
 * SwarmOffloadStore — append-only JSONL storage for agent offload entries.
 *
 * Each agent writes its offload entries to a dedicated JSONL file:
 *
 *   {swarmDir}/.omp/offload/{agentId}.jsonl
 *
 * Entries are written fire-and-forget (errors logged, not thrown) using
 * SessionStorage's `openWriter(path, { flags: "a" })` for O(1) append.
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { SessionStorage } from "../../session/session-storage";
import { getOffloadDir, getOffloadPath } from "./offload-paths";

// ============================================================================
// Types
// ============================================================================

export interface SwarmOffloadEntry {
	timestamp: string;           // ISO 8601
	agent_type: "worker" | "cloner" | "orchestrator";
	agent_id: string;            // "worker-a1", "cloner-guardian"
	iteration: number;
	phase_id?: string;           // L2 填充
	node_id?: string;            // L2 填充，如 "001-N1"
	task_call: string;           // 任务描述
	summary: string;             // LLM 生成，≤200 字
	score: number;               // 0-10
	result_ref?: string;         // artifact:// 引用
	dependencies?: string[];     // 依赖的其他 node_id
}

// ============================================================================
// SwarmOffloadStore
// ============================================================================

export class SwarmOffloadStore {
	readonly #swarmDir: string;
	readonly #storage: SessionStorage;

	constructor(swarmDir: string, storage: SessionStorage) {
		this.#swarmDir = swarmDir;
		this.#storage = storage;
	}

	// -- Path helpers ----------------------------------------------------------

	get swarmDir(): string {
		return this.#swarmDir;
	}

	get offloadDir(): string {
		return getOffloadDir(this.#swarmDir);
	}

	// -- Write ----------------------------------------------------------------

	/**
	 * Append a single offload entry to the agent's JSONL file.
	 *
	 * Uses {@link SessionStorage.openWriter} with `flags: "a"` for O(1) append.
	 * Write failures are logged at warn level but never thrown (fire-and-forget).
	 */
	async appendEntry(agentId: string, entry: SwarmOffloadEntry): Promise<void> {
		const filePath = getOffloadPath(this.#swarmDir, agentId);

		// Ensure parent directory exists synchronously (fast, no await needed).
		this.#storage.ensureDirSync(path.dirname(filePath));

		const writer = this.#storage.openWriter(filePath, { flags: "a" });
		try {
			await writer.append(JSON.stringify(entry) + "\n");
			await writer.flush();
		} catch (err) {
			logger.warn("[SwarmOffloadStore] Failed to append offload entry", {
				agentId,
				filePath,
				error: String(err),
			});
			// fire-and-forget — do not rethrow
		} finally {
			try {
				await writer.close();
			} catch {
				// Best-effort close; fd will be cleaned up by FinalizationRegistry.
			}
		}
	}

	// -- Read -----------------------------------------------------------------

	/**
	 * Read all offload entries for a single agent.
	 * Returns `[]` when the agent has no offload file.
	 */
	async readEntries(agentId: string): Promise<SwarmOffloadEntry[]> {
		const filePath = getOffloadPath(this.#swarmDir, agentId);
		return this.#readJsonlFile(filePath);
	}

	/**
	 * Read all offload entries from every agent, merged into one array.
	 */
	async readAllEntries(): Promise<SwarmOffloadEntry[]> {
		const agentIds = await this.listAgentIds();
		const results: SwarmOffloadEntry[] = [];
		for (const agentId of agentIds) {
			const entries = await this.readEntries(agentId);
			results.push(...entries);
		}
		return results;
	}

	// -- Listing --------------------------------------------------------------

	/**
	 * Return the set of agent IDs that have at least one offload file.
	 */
	async listAgentIds(): Promise<string[]> {
		const dir = getOffloadDir(this.#swarmDir);
		try {
			const exists = await this.#storage.exists(dir);
			if (!exists) return [];
		} catch {
			return [];
		}

		const files = this.#storage.listFilesSync(dir, "*.jsonl");
		return files.map((f) => path.basename(f, ".jsonl"));
	}

	// -- Clear ----------------------------------------------------------------

	/**
	 * Delete every offload JSONL file in the offload directory.
	 */
	async clear(): Promise<void> {
		const dir = getOffloadDir(this.#swarmDir);
		let files: string[];
		try {
			files = this.#storage.listFilesSync(dir, "*.jsonl");
		} catch {
			return; // directory doesn't exist — nothing to clear
		}

		for (const file of files) {
			try {
				await this.#storage.unlink(file);
			} catch (err) {
				logger.warn("[SwarmOffloadStore] Failed to delete offload file during clear", {
					file,
					error: String(err),
				});
			}
		}
	}

	// -- Internal helpers -----------------------------------------------------

	async #readJsonlFile(filePath: string): Promise<SwarmOffloadEntry[]> {
		try {
			const exists = await this.#storage.exists(filePath);
			if (!exists) return [];
		} catch {
			return [];
		}

		let text: string;
		try {
			text = await this.#storage.readText(filePath);
		} catch {
			return [];
		}

		if (!text.trim()) return [];

		const entries: SwarmOffloadEntry[] = [];
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				entries.push(JSON.parse(trimmed) as SwarmOffloadEntry);
			} catch {
				logger.warn("[SwarmOffloadStore] Skipping malformed JSONL line", {
					filePath,
					line: trimmed.slice(0, 200),
				});
			}
		}
		return entries;
	}
}
