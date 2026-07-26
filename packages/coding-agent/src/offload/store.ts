/**
 * OffloadStore — append-only JSONL storage for agent offload entries.
 *
 * Each session writes its offload entries to a dedicated JSONL file:
 *
 *   {workspace}/.stp/offload/{agentName}/offload-{sessionId}.jsonl
 *
 * Entries are written fire-and-forget (errors logged, not thrown) using
 * SessionStorage's `openWriter(path, { flags: "a" })` for O(1) append.
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { SessionStorage } from "../session/session-storage"
import { getOffloadPath, getAgentDataDir } from "./paths"

// ============================================================================
// Types
// ============================================================================

export interface OffloadEntry {
	timestamp: string;           // ISO 8601
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
// OffloadStore
// ============================================================================

export class OffloadStore {
	readonly #workspace: string;
	readonly #agentName: string;
	readonly #storage: SessionStorage;

	constructor(workspace: string, agentName: string, storage: SessionStorage) {
		this.#workspace = workspace;
		this.#agentName = agentName;
		this.#storage = storage;
	}
	// -- Path helpers ----------------------------------------------------------

	get offloadDir(): string {
		return getAgentDataDir(this.#workspace, this.#agentName);
	}

	// -- Write ----------------------------------------------------------------

	/**
	 * Append a single offload entry to the session's JSONL file.
	 *
	 * Uses {@link SessionStorage.openWriter} with `flags: "a"` for O(1) append.
	 * Write failures are logged at warn level but never thrown (fire-and-forget).
	 */
	async appendEntry(agentId: string, sessionId: string, entry: OffloadEntry): Promise<void> {
		const filePath = getOffloadPath(this.#workspace, this.#agentName, sessionId);

		// Ensure parent directory exists synchronously (fast, no await needed).
		this.#storage.ensureDirSync(path.dirname(filePath));

		const writer = this.#storage.openWriter(filePath, { flags: "a" });
		try {
			await writer.append(JSON.stringify(entry) + "\n");
			await writer.flush();
		} catch (err) {
			logger.warn("[OffloadStore] Failed to append offload entry", {
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
	 * Read all offload entries for a single agent within a session.
	 * Returns `[]` when the session has no offload file.
	 */
	async readEntries(agentId: string, sessionId: string): Promise<OffloadEntry[]> {
		const filePath = getOffloadPath(this.#workspace, this.#agentName, sessionId);
		const allEntries = await this.#readJsonlFile(filePath);
		return allEntries.filter((e) => e.agent_id === agentId);
	}

	/**
	 * Read all offload entries from every agent, merged into one array.
	 */
	async readAllEntries(): Promise<OffloadEntry[]> {
		const sessionIds = await this.listAgentIds();
		const results: OffloadEntry[] = [];
		for (const sessionId of sessionIds) {
			const entries = await this.readEntries(sessionId, sessionId);
			results.push(...entries);
		}
		return results;
	}

	// -- Listing --------------------------------------------------------------

	/**
	 * Return the set of session IDs that have at least one offload file.
	 */
	async listAgentIds(): Promise<string[]> {
		const dir = getAgentDataDir(this.#workspace, this.#agentName);
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
	 * Delete every offload JSONL file in the agent's offload directory.
	 */
	async clear(): Promise<void> {
		const dir = getAgentDataDir(this.#workspace, this.#agentName);
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
				logger.warn("[OffloadStore] Failed to delete offload file during clear", {
					file,
					error: String(err),
				});
			}
		}
	}

	// -- Internal helpers -----------------------------------------------------

	async #readJsonlFile(filePath: string): Promise<OffloadEntry[]> {
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

		const entries: OffloadEntry[] = [];
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				entries.push(JSON.parse(trimmed) as OffloadEntry);
			} catch {
				logger.warn("[OffloadStore] Skipping malformed JSONL line", {
					filePath,
					line: trimmed.slice(0, 200),
				});
			}
		}
		return entries;
	}
}
