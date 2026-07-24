/**
 * SwarmStateMachine — explicit Chapter transition arbiter.
 *
 * ## Role: arbiter, NOT driver
 *
 * This machine does NOT drive execution. The long-running Stage phase in
 * StageController remains a command-style function that owns its own
 * event loop. Trying to invert control (state machine calls
 * `start runStage()`) is an impedance mismatch with a long-lived
 * imperative process and would let "phase" and "actual progress" drift apart.
 *
 * Instead this machine is the SINGLE place where:
 *  - a phase transition is validated against an explicit transition table
 *    (illegal transitions are reported, never silently applied),
 *  - the transition is broadcast ATOMICALLY (StateTracker + ActivityLogger +
 *    SSE happen in one step, closing the "state changed but not broadcast"
 *    gap that the scattered updatePipeline/logPhase calls left open),
 *  - onEnter / onExit / onError side effects are dispatched.
 *
 * StageController routes every `phase` change through `transition()`; the
 * suspension mechanics (checkPause / blockerResolver await) stay inside
 * the stage loop untouched.
 *
 * The backend is the SOLE authority for Chapter. The frontend must be a
 * pure projection of the phase broadcast here — it must not infer phase
 * locally.
 *
 * ## Lifecycle
 *
 *   idle → script → (script-debate) → script-confirm → stage ↔ (paused | blocked) → curtain → idle
 */
import type { Chapter } from "./state";

/** Terminal reason carried into the curtain / idle transition. */
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
	/** Current iteration (1-based) when known. */
	iteration?: number;
	/** Terminal status when entering curtain / idle after a run. */
	terminalStatus?: TerminalStatus;
	/** Marks a forced (escape-hatch) transition, e.g. hard abort/reset. */
	forced?: boolean;
}

export interface TransitionResult {
	ok: boolean;
	from: Chapter;
	to: Chapter;
	/** Present when ok === false. */
	reason?: string;
	/** True when to === from (idempotent no-op that still succeeds). */
	noop?: boolean;
}

/**
 * Explicit transition table — the single source of truth for legal moves.
 *
 * Lifecycle: idle → script ↔ script-debate ↔ script-confirm → stage ↔ (paused | blocked) → curtain → idle
 */
export const WORKFLOW_TRANSITIONS: Record<Chapter, Chapter[]> = {
	idle:                ["script", "stage"],
	script:              ["script-debate", "script-confirm", "idle"],
	"script-debate":     ["script-confirm", "script", "idle"],
	"script-confirm":    ["stage", "script", "script-debate", "idle"],
	stage:               ["paused", "blocked", "curtain"],
	paused:              ["stage", "curtain", "idle"],
	blocked:             ["stage", "curtain", "idle"],
	curtain:             ["idle", "stage"],
};

/** Pure predicate: is `from → to` a legal transition? (self-loops are legal no-ops) */
export function canTransition(from: Chapter, to: Chapter): boolean {
	if (from === to) return true;
	return (WORKFLOW_TRANSITIONS[from] ?? []).includes(to);
}

/** Side-effect hooks. All are optional and invoked defensively (errors isolated). */
export interface StateMachineHooks {
	/**
	 * Called AFTER a transition is accepted, with the new phase. This is the
	 * atomic broadcast point: implementers update StateTracker + ActivityLogger
	 * + SSE here in one step.
	 */
	onEnter?: (phase: Chapter, ctx: PhaseContext) => void | Promise<void>;
	/** Called just before leaving a phase (cleanup of intermediate state). */
	onExit?: (phase: Chapter, ctx: PhaseContext) => void | Promise<void>;
	/** Called when a transition is rejected or a hook throws. */
	onError?: (from: Chapter, to: Chapter, reason: string) => void;
}

export class SwarmStateMachine {
	#phase: Chapter;
	#hooks: StateMachineHooks;
	/** Active timed-transition timer (e.g. blocker auto-continue). */
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(initial: Chapter = "idle", hooks: StateMachineHooks = {}) {
		this.#phase = initial;
		this.#hooks = hooks;
	}

	get phase(): Chapter {
		return this.#phase;
	}

	/**
	 * Validate and apply a transition, dispatching onExit/onEnter.
	 *
	 * Policy: illegal transitions are REJECTED (phase unchanged) and reported
	 * via onError — we never throw, so a single bad transition cannot tear down
	 * the workflow. Use `force()` for legitimate escape hatches (hard abort/reset).
	 *
	 * Idempotent: `to === current` succeeds as a no-op WITHOUT firing
	 * onExit/onEnter again (avoids duplicate broadcasts).
	 */
	async transition(to: Chapter, ctx: PhaseContext = {}): Promise<TransitionResult> {
		const from = this.#phase;

		if (to === from) {
			return { ok: true, from, to, noop: true };
		}

		if (!canTransition(from, to)) {
			const reason = `Illegal Chapter transition: ${from} → ${to}`;
			this.#safeError(from, to, reason);
			return { ok: false, from, to, reason };
		}

		return this.#apply(from, to, ctx);
	}

	/**
	 * Force a transition regardless of the table (escape hatch).
	 * Used for hard abort / reset where any source phase must reach the target.
	 */
	async force(to: Chapter, ctx: PhaseContext = {}): Promise<TransitionResult> {
		const from = this.#phase;
		if (to === from) return { ok: true, from, to, noop: true };
		return this.#apply(from, to, { ...ctx, forced: true });
	}

	async #apply(from: Chapter, to: Chapter, ctx: PhaseContext): Promise<TransitionResult> {
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
	 * happens first. Models e.g. `blocked --(5min timeout)--> stage`
	 * (blocker auto-continue). The timer is cleared by any manual transition.
	 */
	scheduleTimed(to: Chapter, ms: number, ctx: PhaseContext = {}): void {
		this.#clearTimer();
		const armedFrom = this.#phase;
		this.#timer = setTimeout(() => {
			this.#timer = null;
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

	#safeError(from: Chapter, to: Chapter, reason: string): void {
		try {
			this.#hooks.onError?.(from, to, reason);
		} catch {
			// onError itself threw — swallow to preserve the "never crash" guarantee.
		}
	}
}
