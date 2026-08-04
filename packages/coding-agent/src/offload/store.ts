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
import { logger } from "@satopi/pi-utils";
import type { SessionStorage } from "../session/store/session-storage";
import { getAgentDataDir, getOffloadPath } from "./paths";

// ============================================================================
// Types
// ============================================================================

export interface OffloadEntry {
	timestamp: string; // ISO 8601
	agent_id: string; // "worker-a1", "cloner-guardian"
	iteration: number;
	phase_id?: string; // L2 填充
	node_id?: string; // L2 填充，如 "001-N1"
	task_call: string; // 任务描述
	summary: string; // LLM 生成，≤200 字
	score: number; // 0-10
	result_ref?: string; // artifact:// 引用
	dependencies?: string[]; // 依赖的其他 node_id
	source_offset?: number; // byte offset in JSONL for O(1) original retrieval
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

		// Record byte offset for O(1) original retrieval.
		let offset = 0;
		try {
			offset = (await this.#storage.readText(filePath)).length;
		} catch {
			// File doesn't exist yet — offset is 0.
		}
		entry.source_offset = offset;

		const writer = this.#storage.openWriter(filePath, { flags: "a" });
		try {
			await writer.append(`${JSON.stringify(entry)}\n`);
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
		return allEntries.filter(e => e.agent_id === agentId);
	}

	/**
	 * Read all offload entries from every agent, merged into one array.
	 */
	async readAllEntries(): Promise<OffloadEntry[]> {
		const sessionIds = await this.listAgentIds();
		const results: OffloadEntry[] = [];
		for (const sessionId of sessionIds) {
			const entries = await this.readAllFileEntries(sessionId);
			results.push(...entries);
		}
		return results;
	}

	/**
	 * Read every offload entry from a session file without agent_id filtering.
	 */
	async readAllFileEntries(sessionId: string): Promise<OffloadEntry[]> {
		const filePath = getOffloadPath(this.#workspace, this.#agentName, sessionId);
		return this.#readJsonlFile(filePath);
	}

	/**
	 * Read a single offload entry at a specific byte offset in the JSONL file.
	 *
	 * Reads the file from `offset` to the next newline, parses that line as
	 * JSON, and returns the entry. Returns `null` if the file doesn't exist,
	 * the offset is out of range, or the line can't be parsed.
	 */
	async readEntryAtOffset(sessionId: string, offset: number): Promise<OffloadEntry | null> {
		const filePath = getOffloadPath(this.#workspace, this.#agentName, sessionId);

		let text: string;
		try {
			text = await this.#storage.readText(filePath);
		} catch {
			return null;
		}

		if (offset >= text.length) return null;

		const fromOffset = text.slice(offset);
		const newlineIdx = fromOffset.indexOf("\n");
		const line = newlineIdx >= 0 ? fromOffset.slice(0, newlineIdx) : fromOffset;

		if (!line.trim()) return null;

		try {
			return JSON.parse(line) as OffloadEntry;
		} catch {
			logger.warn("[OffloadStore] Failed to parse entry at offset", {
				filePath,
				offset,
				line: line.slice(0, 200),
			});
			return null;
		}
	}

	// -- Listing --------------------------------------------------------------

	/**
	 * Return the set of session IDs that have at least one offload file.
	 */
	async listAgentIds(): Promise<string[]> {
		const dir = getAgentDataDir(this.#workspace, this.#agentName);
		// The listing itself is the source of truth: listFilesSync already
		// returns [] for a missing dir. A separate exists(dir) gate would break
		// storage backends that only track files (MemorySessionStorage has no
		// directory entries, so exists(dir) is always false there).
		let files: string[];
		try {
			files = this.#storage.listFilesSync(dir, "*.jsonl");
		} catch {
			return [];
		}
		// Files are named `offload-{sessionId}.jsonl`; strip the prefix so the
		// returned ids round-trip through getOffloadPath (which re-adds it).
		return files
			.map(f => path.basename(f, ".jsonl"))
			.map(id => (id.startsWith("offload-") ? id.slice("offload-".length) : id));
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
