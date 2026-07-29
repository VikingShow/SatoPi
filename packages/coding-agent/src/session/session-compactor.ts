/**
 * SessionCompactor — Compaction lifecycle and state management extracted from AgentSession.
 *
 * Owns the compaction abort controllers and exposes the compaction surface.
 * AgentSession holds an instance and delegates to it for compaction state and
 * lifecycle, while the heavy orchestration (LLM calls, history rewriting) stays
 * in AgentSession's private methods so they can access its internals directly.
 */

import { shouldCompact } from "@satopi/pi-agent-core/compaction";

export { shouldCompact };

/**
 * Compaction state owned by the compactor module.
 * The session holds one instance and passes itself when invoking methods.
 */
export class SessionCompactor {
	#compactionAbortController: AbortController | undefined = undefined;
	#autoCompactionAbortController: AbortController | undefined = undefined;

	/** True when manual or auto compaction is in flight. */
	get isCompacting(): boolean {
		return this.#autoCompactionAbortController !== undefined || this.#compactionAbortController !== undefined;
	}

	/** True when a manual `/compact` is running. */
	get isManualCompacting(): boolean {
		return this.#compactionAbortController !== undefined;
	}

	/** Install a manual compaction controller. Rejects if already compacting. */
	beginManualCompaction(): AbortController {
		if (this.#compactionAbortController) {
			throw new Error("Compaction already in progress");
		}
		const controller = new AbortController();
		this.#compactionAbortController = controller;
		return controller;
	}

	/** Clear the manual compaction controller if it still matches. */
	endManualCompaction(controller: AbortController): void {
		if (this.#compactionAbortController === controller) {
			this.#compactionAbortController = undefined;
		}
	}

	/** Abort any in-flight auto-compaction and install a fresh controller. */
	beginAutoCompaction(): AbortController {
		this.#autoCompactionAbortController?.abort();
		const controller = new AbortController();
		this.#autoCompactionAbortController = controller;
		return controller;
	}

	/** Clear the auto-compaction controller if it still matches. */
	endAutoCompaction(controller: AbortController): void {
		if (this.#autoCompactionAbortController === controller) {
			this.#autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Abort all in-flight compactions (manual + auto).
	 * The handoff controller is also aborted here — callers pass it explicitly.
	 */
	abortAll(handoffController?: AbortController): void {
		this.#compactionAbortController?.abort();
		this.#autoCompactionAbortController?.abort();
		handoffController?.abort();
	}

	/** Abort only the auto-compaction controller (preserves manual compaction). */
	abortAuto(): void {
		this.#autoCompactionAbortController?.abort();
	}

	/** Reset all compaction state (used during full session teardown). */
	reset(): void {
		this.#compactionAbortController = undefined;
		this.#autoCompactionAbortController = undefined;
	}
}
