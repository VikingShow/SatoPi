/**
 * SwarmStateMachine — explicit LoopPhase transition arbiter.
 *
 * ## Role: arbiter, NOT driver
 *
 * This machine does NOT drive execution. The long-running `runLoop()` in
 * LoopController remains a command-style function that owns its own
 * `for (iteration) { for (round) }` loop and its own `await` suspension
 * points (pause / blocker). Trying to invert control (state machine calls
 * `start runLoop()` on entry) is an impedance mismatch with a long-lived
 * imperative loop and would let "phase" and "actual progress" drift apart.
 *
 * Instead this machine is the SINGLE place where:
 *  - a phase transition is validated against an explicit transition table
 *    (illegal transitions are reported, never silently applied),
 *  - the transition is broadcast ATOMICALLY (StateTracker + ActivityLogger +
 *    SSE happen in one step, closing the "state changed but not broadcast"
 *    gap that the scattered updatePipeline/logPhase calls left open),
 *  - onEnter / onExit / onError side effects are dispatched.
 *
 * LoopController routes every `loopPhase` change through `transition()`; the
 * suspension mechanics (checkPause / blockerResolver await) stay inside
 * runLoop untouched.
 *
 * The backend is the SOLE authority for LoopPhase. The frontend must be a
 * pure projection of the phase broadcast here — it must not infer phase
 * locally.
 */
import type { LoopPhase } from "./state";

/** Terminal reason carried into the after-loop / idle transition. */
export type TerminalStatus =
	| "completed"
	| "failed"
	| "aborted"
	| "escalated"
	| "converged_failed"
	| "converged_partial";

/** Context passed to onEnter — lets a phase entry carry structured detail. */
export interface PhaseContext {
	/** Human-readable reason (e.g. blocker reason). */
	reason?: string;
	/** Current loop iteration (1-based) when known. */
	iteration?: number;
	/** Terminal status when entering after-loop / idle after a run. */
	terminalStatus?: TerminalStatus;
	/** Marks a forced (escape-hatch) transition, e.g. hard abort/reset. */
	forced?: boolean;
}

export interface TransitionResult {
	ok: boolean;
	from: LoopPhase;
	to: LoopPhase;
	/** Present when ok === false. */
	reason?: string;
	/** True when to === from (idempotent no-op that still succeeds). */
	noop?: boolean;
}

/**
 * Explicit transition table — the single source of truth for legal moves.
 *
 * Notes on completeness (deliberately covering the real branches that the
 * scattered code exercises today):
 *  - before-loop-* → idle          : cancelBeforeLoop() from any planning phase
 *  - running → after-loop           : normal completion AND non-abort terminal
 *                                     states (converged_failed/partial/escalated/
 *                                     failed) — the terminalStatus rides in
 *                                     PhaseContext so the reason is not lost.
 *  - paused → after-loop            : abort while paused
 *  - blocked → running              : unblock (also the target of the timed
 *                                     auto-continue transition)
 *  - blocked → after-loop           : abort from a blocker
 *  - after-loop → idle              : run finished, back to idle
 *  - after-loop → running           : retry a fresh run (resetAgentStatuses)
 */
export const LOOP_TRANSITIONS: Record<LoopPhase, LoopPhase[]> = {
	idle: ["before-loop-dialog", "running"],
	"before-loop-dialog": ["before-loop-debate", "before-loop-confirm", "idle"],
	"before-loop-debate": ["before-loop-confirm", "before-loop-dialog", "idle"],
	"before-loop-confirm": ["running", "before-loop-dialog", "before-loop-debate", "idle"],
	running: ["paused", "blocked", "after-loop"],
	paused: ["running", "after-loop", "idle"],
	blocked: ["running", "after-loop", "idle"],
	"after-loop": ["idle", "running"],
};

/** Pure predicate: is `from → to` a legal transition? (self-loops are legal no-ops) */
export function canTransition(from: LoopPhase, to: LoopPhase): boolean {
	if (from === to) return true;
	return (LOOP_TRANSITIONS[from] ?? []).includes(to);
}

/** Side-effect hooks. All are optional and invoked defensively (errors isolated). */
export interface StateMachineHooks {
	/**
	 * Called AFTER a transition is accepted, with the new phase. This is the
	 * atomic broadcast point: implementers update StateTracker + ActivityLogger
	 * + SSE here in one step.
	 */
	onEnter?: (phase: LoopPhase, ctx: PhaseContext) => void | Promise<void>;
	/** Called just before leaving a phase (cleanup of intermediate state). */
	onExit?: (phase: LoopPhase, ctx: PhaseContext) => void | Promise<void>;
	/** Called when a transition is rejected or a hook throws. */
	onError?: (from: LoopPhase, to: LoopPhase, reason: string) => void;
}

export class SwarmStateMachine {
	#phase: LoopPhase;
	#hooks: StateMachineHooks;
	/** Active timed-transition timer (e.g. blocker auto-continue). */
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(initial: LoopPhase = "idle", hooks: StateMachineHooks = {}) {
		this.#phase = initial;
		this.#hooks = hooks;
	}

	get phase(): LoopPhase {
		return this.#phase;
	}

	/**
	 * Validate and apply a transition, dispatching onExit/onEnter.
	 *
	 * Policy: illegal transitions are REJECTED (phase unchanged) and reported
	 * via onError — we never throw, so a single bad transition cannot tear down
	 * the loop. Use `force()` for legitimate escape hatches (hard abort/reset).
	 *
	 * Idempotent: `to === current` succeeds as a no-op WITHOUT firing
	 * onExit/onEnter again (avoids duplicate broadcasts).
	 */
	async transition(to: LoopPhase, ctx: PhaseContext = {}): Promise<TransitionResult> {
		const from = this.#phase;

		if (to === from) {
			return { ok: true, from, to, noop: true };
		}

		if (!canTransition(from, to)) {
			const reason = `Illegal LoopPhase transition: ${from} → ${to}`;
			this.#safeError(from, to, reason);
			return { ok: false, from, to, reason };
		}

		return this.#apply(from, to, ctx);
	}

	/**
	 * Force a transition regardless of the table (escape hatch).
	 * Used for hard abort / reset where any source phase must reach the target.
	 */
	async force(to: LoopPhase, ctx: PhaseContext = {}): Promise<TransitionResult> {
		const from = this.#phase;
		if (to === from) return { ok: true, from, to, noop: true };
		return this.#apply(from, to, { ...ctx, forced: true });
	}

	async #apply(from: LoopPhase, to: LoopPhase, ctx: PhaseContext): Promise<TransitionResult> {
		// Any pending timed transition is invalidated by an explicit move.
		this.#clearTimer();
		try {
			await this.#hooks.onExit?.(from, ctx);
		} catch (err) {
			this.#safeError(from, to, `onExit(${from}) threw: ${String(err)}`);
		}
		this.#phase = to;
		try {
			await this.#hooks.onEnter?.(to, ctx);
		} catch (err) {
			this.#safeError(from, to, `onEnter(${to}) threw: ${String(err)}`);
		}
		return { ok: true, from, to };
	}

	/**
	 * Schedule an automatic transition after `ms` unless a manual transition
	 * happens first. Models e.g. `blocked --(5min timeout)--> running`
	 * (blocker auto-continue). The timer is cleared by any manual transition.
	 */
	scheduleTimed(to: LoopPhase, ms: number, ctx: PhaseContext = {}): void {
		this.#clearTimer();
		const armedFrom = this.#phase;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			// Only fire if we are still in the phase we armed from.
			if (this.#phase === armedFrom) {
				void this.transition(to, { ...ctx, reason: ctx.reason ?? "timed auto-transition" });
			}
		}, ms);
	}

	/** Cancel any pending timed transition. */
	cancelTimed(): void {
		this.#clearTimer();
	}

	#clearTimer(): void {
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}

	#safeError(from: LoopPhase, to: LoopPhase, reason: string): void {
		try {
			this.#hooks.onError?.(from, to, reason);
		} catch {
			// onError itself threw — swallow to preserve the "never crash" guarantee.
		}
	}
}
