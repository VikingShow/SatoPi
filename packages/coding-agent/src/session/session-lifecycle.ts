/**
 * SessionLifecycle — Dispose and park/revive lifecycle extracted from AgentSession.
 *
 * Owns the `isDisposed` flag and the synchronous begin-of-dispose gate.
 * AgentSession holds an instance and delegates to it for lifecycle state.
 */

export class SessionLifecycle {
	#isDisposed = false;

	/** True once beginDispose() has been called. */
	get isDisposed(): boolean {
		return this.#isDisposed;
	}

	/**
	 * Synchronously mark the session as disposing so new work is rejected
	 * immediately. Idempotent.
	 *
	 * Callers that await other teardown before delegating to dispose() MUST
	 * call this before their first await.
	 */
	beginDispose(): void {
		this.#isDisposed = true;
	}

	/** Reset state (test-only). */
	reset(): void {
		this.#isDisposed = false;
	}
}
