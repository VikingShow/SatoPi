/**
 * RegionLockManager — in-process file-region lock for swarm workers.
 *
 * Each session owns its own RegionLockManager instance. Workers in different
 * sessions cannot block each other's file edits.
 *
 * Lifecycle:
 * 1. Worker's beforeToolCall hook calls tryLock(file, agentId) before edit.
 * 2. If another worker holds a conflicting lock → blocked; hook returns
 *    { block: true, reason: "worker-N is editing file:line-range" }.
 * 3. Worker's afterToolCall hook calls release(file, agentId) after edit.
 * 4. releaseAll(agentId) cleans up on worker session teardown.
 *
 * Intent declaration (tier 1) is handled through structured IRC broadcasts
 * emitted by the lock manager so other workers can see who is editing what.
 */

// ============================================================================
// Types
// ============================================================================

export interface LockEntry {
	/** Worker that acquired this lock. */
	agentId: string;
	/** Locked file path (relative to workspace). */
	file: string;
	/** Optional line range (e.g. "5-20"). */
	range?: string;
	/** Acquired timestamp (ms). */
	acquiredAt: number;
}

export interface LockCheckResult {
	/** Whether this file is locked by another worker. */
	locked: boolean;
	/** The conflicting lock entry, if any. */
	entry?: LockEntry;
}

// ============================================================================
// RegionLockManager
// ============================================================================

export class RegionLockManager {
	// -------------------------------------------------------------------
	// Static singleton (for tests and global access)
	// -------------------------------------------------------------------

	static #instance: RegionLockManager | null = null;

	static create(): RegionLockManager {
		const mgr = new RegionLockManager();
		RegionLockManager.#instance = mgr;
		return mgr;
	}

	static global(): RegionLockManager {
		if (!RegionLockManager.#instance) {
			RegionLockManager.#instance = new RegionLockManager();
		}
		return RegionLockManager.#instance;
	}

	static reset(): void {
		RegionLockManager.#instance = null;
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	/** Active locks, keyed by normalized file path. One lock per file at a time. */
	readonly #locks = new Map<string, LockEntry>();

	// -------------------------------------------------------------------
	// Lock operations
	// -------------------------------------------------------------------

	/**
	 * Try to acquire a lock on `file` for `agentId`.
	 * Returns `true` if acquired, `false` if another worker already holds it.
	 *
	 * A worker re-acquiring a lock it already holds is a no-op (returns true,
	 * updates range).
	 */
	tryLock(agentId: string, file: string, range?: string): boolean {
		const normalized = this.#normalizePath(file);
		const existing = this.#locks.get(normalized);

		if (existing) {
			if (existing.agentId === agentId) {
				// Re-acquire — update range, no conflict
				existing.range = range ?? existing.range;
				existing.acquiredAt = Date.now();
				return true;
			}
			// Another worker holds the lock
			return false;
		}

		this.#locks.set(normalized, {
			agentId,
			file: normalized,
			range,
			acquiredAt: Date.now(),
		});
		return true;
	}

	/**
	 * Release a specific lock, only if held by `agentId`.
	 */
	release(agentId: string, file: string): void {
		const normalized = this.#normalizePath(file);
		const existing = this.#locks.get(normalized);
		if (existing && existing.agentId === agentId) {
			this.#locks.delete(normalized);
		}
	}

	/**
	 * Release all locks held by a worker. Called on session teardown.
	 */
	releaseAll(agentId: string): void {
		for (const [file, lock] of this.#locks) {
			if (lock.agentId === agentId) {
				this.#locks.delete(file);
			}
		}
	}

	/**
	 * Check if `file` is locked by someone other than `agentId`.
	 */
	checkLock(file: string, agentId: string): LockCheckResult {
		const normalized = this.#normalizePath(file);
		const existing = this.#locks.get(normalized);
		if (existing && existing.agentId !== agentId) {
			return { locked: true, entry: existing };
		}
		return { locked: false };
	}

	/**
	 * Return all active locks for diagnostics.
	 */
	getActiveLocks(): LockEntry[] {
		return [...this.#locks.values()];
	}

	/**
	 * Format a lock as a human-readable description.
	 */
	static describeLock(entry: LockEntry): string {
		const range = entry.range ? `:${entry.range}` : "";
		return `${entry.agentId} is editing ${entry.file}${range}`;
	}

	// -------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------

	/** Normalize a file path for consistent keying. */
	#normalizePath(file: string): string {
		// Strip leading ./ and normalize slashes
		return file.replace(/^\.\//, "").replace(/\/+/g, "/");
	}
}
