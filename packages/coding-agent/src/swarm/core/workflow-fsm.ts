/**
 * WorkflowFSM — Unified phase state machine for SatoPi swarm.
 *
 * ## Role
 *
 * WorkflowFSM is the single authority for workflow phase transitions. It
 * delegates persistence to StateTracker and event logging to ActivityLogger.
 *
 * ## Lifecycle
 *
 *   idle → script → (script-debate) → script-confirm → stage ↔ (paused | blocked) → curtain → idle
 *
 * ## Validation
 *
 * Every transition is validated against the registered PhaseDefinition graph:
 *   1. Primary check: currentPhase.allowedTo must contain the target phase
 *   2. Secondary check: targetPhase.allowedFrom must contain the current phase
 *
 * Both checks must pass. Use `force()` to bypass validation for escape-hatch
 * transitions (abort/reset).
 *
 * ## Integration
 *
 * Provides `transition()` / `force()` / `phase` API, plus additional methods
 * for phase capability introspection and human-decision waiting.
 */

import type { HookPipeline } from "../hook-system/hook-pipeline";
import type { HookContext } from "../hook-system/types";
import type { ActivityLogger } from "../infra/activity-logger";
import type { Chapter, StateTracker } from "./state";

// ============================================================================
// Interfaces
// ============================================================================

/** Capability flags that vary by phase — guides UI and orchestrator behavior. */
export interface PhaseCapabilities {
	/** Whether multiple agents can run concurrently. */
	multiAgent: boolean;
	/** Whether roundtable discussions are supported. */
	roundtable: boolean;
	/** Whether voting is supported. */
	vote: boolean;
	/** Whether the offload pipeline is active. */
	offload: boolean;
	/** Whether context compaction is active. */
	compaction: boolean;
	/** Human interaction mode for this phase. */
	humanMode: "dialogue" | "observer" | "passive" | "none";
}

/** Full definition of a workflow phase including transition rules and capabilities. */
export interface PhaseDefinition {
	/** The phase identifier — reuses the existing Chapter type. */
	phase: Chapter;
	/** Which phases can transition TO this phase (inbound edges). */
	allowedFrom: Chapter[];
	/** Which phases this phase can transition TO (outbound edges). */
	allowedTo: Chapter[];
	/** Capability flags active during this phase. */
	capabilities: PhaseCapabilities;
	/** Default timeout before auto-transition (0 = no timeout). */
	defaultTimeoutMs: number;
	/** Optional explicit target for timed auto-transition. When set, overrides the
	 * default heuristic of picking the first allowedTo entry. */
	timedTransitionTarget?: Chapter;
}

/** Read-only snapshot of the current FSM state. */
export interface WorkflowState {
	/** Current workflow phase. */
	phase: Chapter;
	/** Human-readable sub-status (e.g. "generating script", "running wave 2"). */
	subStatus: string;
	/** Whether the workflow is actively executing. */
	running: boolean;
	/** Monotonic transition counter. */
	iteration: number;
	/** Timestamp (ms) when the current phase was entered. */
	phaseStartedAt: number;
	/** Capability flags for the current phase. */
	capabilities: PhaseCapabilities;
}

/** Result of a transition attempt. */
export interface TransitionResult {
	/** Whether the transition succeeded. */
	ok: boolean;
	/** Source phase before the transition. */
	from: Chapter;
	/** Target phase after the transition. */
	to: Chapter;
	/** Present when ok === false — describes why the transition was rejected. */
	reason?: string;
	/** True when to === from (idempotent no-op that still succeeds). */
	noop?: boolean;
}

/** Metadata carried with a transition request. */
export interface TransitionMeta {
	/** Human-readable reason for the transition. */
	reason?: string;
	/** Current iteration count (1-based). */
	iteration?: number;
	/** Terminal status when entering curtain / idle after a run. */
	terminalStatus?: string;
	/** Marks a forced (escape-hatch) transition. */
	forced?: boolean;
}

// ============================================================================
// Phase registry constant
// ============================================================================

/**
 * Standard phase definitions for the SatoPi workflow.
 *
 * Each phase declares its inbound (allowedFrom) and outbound (allowedTo) edges.
 * The graph invariant is: if A.allowedTo contains B, then B.allowedFrom must
 * contain A — validated by the PHASES integrity test.
 */
export const PHASES: PhaseDefinition[] = [
	{
		phase: "script",
		allowedFrom: ["idle", "script-debate", "script-confirm"],
		allowedTo: ["script-debate", "script-confirm", "idle"],
		capabilities: {
			multiAgent: false,
			roundtable: false,
			vote: false,
			offload: true,
			compaction: false,
			humanMode: "dialogue",
		},
		defaultTimeoutMs: 0,
	},
	{
		phase: "script-debate",
		allowedFrom: ["script", "script-confirm"],
		allowedTo: ["script-confirm", "script", "idle"],
		capabilities: {
			multiAgent: true,
			roundtable: true,
			vote: false,
			offload: true,
			compaction: false,
			humanMode: "observer",
		},
		defaultTimeoutMs: 300_000,
	},
	{
		phase: "script-confirm",
		allowedFrom: ["script", "script-debate"],
		allowedTo: ["stage", "script", "script-debate", "idle"],
		capabilities: {
			multiAgent: false,
			roundtable: false,
			vote: false,
			offload: false,
			compaction: false,
			humanMode: "dialogue",
		},
		defaultTimeoutMs: 0,
	},
	{
		phase: "stage",
		// Extra inbound edges beyond "script-confirm":
		//   idle → stage:    /swarm run <file.yaml> non-interactive mode — caller
		//                    supplies plan.md directly, skipping the Script phase.
		//   curtain → stage: loop-mode re-run — after a finished curtain, the
		//                    orchestrator starts a new Stage without resetting to idle.
		allowedFrom: ["script-confirm", "paused", "blocked", "idle", "curtain"],
		allowedTo: ["paused", "blocked", "curtain"],
		capabilities: {
			multiAgent: true,
			roundtable: true,
			vote: true,
			offload: true,
			compaction: true,
			humanMode: "observer",
		},
		defaultTimeoutMs: 0,
	},
	{
		phase: "paused",
		allowedFrom: ["stage"],
		allowedTo: ["stage", "curtain", "idle"],
		capabilities: {
			multiAgent: false,
			roundtable: false,
			vote: false,
			offload: false,
			compaction: false,
			humanMode: "dialogue",
		},
		defaultTimeoutMs: 0,
	},
	{
		phase: "blocked",
		allowedFrom: ["stage"],
		allowedTo: ["stage", "curtain", "idle"],
		capabilities: {
			multiAgent: false,
			roundtable: false,
			vote: false,
			offload: false,
			compaction: false,
			humanMode: "dialogue",
		},
		defaultTimeoutMs: 300_000,
	},
	{
		phase: "curtain",
		allowedFrom: ["stage", "paused", "blocked"],
		allowedTo: ["idle", "stage"],
		capabilities: {
			multiAgent: true,
			roundtable: false,
			vote: true,
			offload: true,
			compaction: false,
			humanMode: "passive",
		},
		defaultTimeoutMs: 120_000,
	},
	{
		phase: "idle",
		allowedFrom: ["script", "script-debate", "script-confirm", "curtain", "paused", "blocked"],
		allowedTo: ["script", "stage"],
		capabilities: {
			multiAgent: false,
			roundtable: false,
			vote: false,
			offload: false,
			compaction: false,
			humanMode: "none",
		},
		defaultTimeoutMs: 0,
	},
];

/** Phases where the workflow is considered actively running. */
const ACTIVE_PHASES: Set<Chapter> = new Set(["script", "script-debate", "stage", "curtain"]);

/** Default capabilities used when no phase definition is registered. */
const DEFAULT_CAPABILITIES: PhaseCapabilities = {
	multiAgent: false,
	roundtable: false,
	vote: false,
	offload: false,
	compaction: false,
	humanMode: "none",
};

// ============================================================================
// WorkflowFsm
// ============================================================================

/** Listener callback signature for phase change events. */
export type PhaseChangeListener = (event: { from: Chapter; to: Chapter; meta?: TransitionMeta }) => void;

/**
 * Unified workflow finite state machine.
 *
 * Delegates persistence to {@link StateTracker} and event logging to
 * {@link ActivityLogger}. Validates transitions against the registered
 * phase graph and broadcasts changes atomically.
 *
 * @example
 * ```ts
 * const fsm = new WorkflowFsm(stateTracker, activityLogger);
 * for (const def of PHASES) fsm.registerPhase(def);
 *
 * const result = await fsm.transition("script");
 * if (!result.ok) console.error(result.reason);
 * ```
 */
export class WorkflowFsm {
	/** Current phase. */
	#phase: Chapter;
	/** Human-readable sub-status label. */
	#subStatus: string;
	/** Whether the workflow is actively executing. */
	#running: boolean;
	/** Monotonic transition counter. */
	#iteration: number;
	/** Timestamp (ms) when the current phase was entered. */
	#phaseStartedAt: number;

	/** Registry of all known phases, keyed by phase identifier. */
	#phases: Map<Chapter, PhaseDefinition> = new Map();

	/** Registered phase-change listeners. */
	#listeners: Set<PhaseChangeListener> = new Set();

	/** Injected state tracker for persistence. */
	#stateTracker: StateTracker;

	/** Injected activity logger for event recording. */
	#activityLogger: ActivityLogger;

	/** Optional hook pipeline for lifecycle events. */
	#hookPipeline: HookPipeline | undefined;

	/** Pending human-decision resolver — set by waitForHumanDecision(). */
	#humanResolve: ((value: unknown) => void) | null = null;
	/** Pending human-decision rejecter — paired with #humanResolve for cancellation. */
	#humanReject: ((reason: Error) => void) | null = null;

	/** Active timed-transition timer handle. */
	#timer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * @param stateTracker  Existing StateTracker instance for persistence.
	 * @param activityLogger  Existing ActivityLogger instance for event recording.
	 * @param initialPhase  Starting phase (defaults to "idle").
	 */
	constructor(
		stateTracker: StateTracker,
		activityLogger: ActivityLogger,
		initialPhase: Chapter = "idle",
		hookPipeline?: HookPipeline,
	) {
		this.#stateTracker = stateTracker;
		this.#activityLogger = activityLogger;
		this.#hookPipeline = hookPipeline;
		this.#phase = initialPhase;
		this.#subStatus = "";
		this.#running = ACTIVE_PHASES.has(initialPhase);
		this.#iteration = 0;
		this.#phaseStartedAt = Date.now();
	}

	// -- Public accessors -------------------------------------------------------

	/** Read-only snapshot of the current FSM state. */
	get state(): WorkflowState {
		return {
			phase: this.#phase,
			subStatus: this.#subStatus,
			running: this.#running,
			iteration: this.#iteration,
			phaseStartedAt: this.#phaseStartedAt,
			capabilities: this.capabilities,
		};
	}

	/** Current workflow phase. */
	get phase(): Chapter {
		return this.#phase;
	}

	/** Capability flags for the current phase. */
	get capabilities(): PhaseCapabilities {
		const def = this.#phases.get(this.#phase);
		return def?.capabilities ?? DEFAULT_CAPABILITIES;
	}

	// -- Phase registry ---------------------------------------------------------

	/**
	 * Register a phase definition in the transition graph.
	 *
	 * Must be called for every phase before transitions involving that phase
	 * will be validated. Typically called in setup with the {@link PHASES} array.
	 */
	registerPhase(def: PhaseDefinition): void {
		this.#phases.set(def.phase, def);
	}

	// -- Transitions ------------------------------------------------------------

	/**
	 * Attempt a validated phase transition.
	 *
	 * Validation checks:
	 *   1. The target phase must be in the current phase's `allowedTo` set.
	 *   2. The current phase must be in the target phase's `allowedFrom` set.
	 *
	 * Both the current and target phases must be registered via {@link registerPhase}
	 * for validation to apply. If a phase is not registered, the corresponding
	 * check is skipped (allowing unregistered phases for escape hatches).
	 *
	 * Idempotent: `to === current` returns `{ ok: true, noop: true }` without
	 * firing side effects.
	 *
	 * @param to    Target phase.
	 * @param meta  Optional metadata (reason, iteration, terminalStatus).
	 * @returns A result indicating success, failure, or no-op.
	 */
	async transition(to: Chapter, meta: TransitionMeta = {}): Promise<TransitionResult> {
		const from = this.#phase;

		// Idempotent self-transition.
		if (to === from) {
			return { ok: true, from, to, noop: true };
		}

		// Validate against the phase graph.
		const currentDef = this.#phases.get(from);
		const targetDef = this.#phases.get(to);

		if (currentDef && !currentDef.allowedTo.includes(to)) {
			const reason = `Illegal Chapter transition: ${from} → ${to} (not in ${from}.allowedTo)`;
			return { ok: false, from, to, reason };
		}

		if (targetDef && !targetDef.allowedFrom.includes(from)) {
			const reason = `Illegal Chapter transition: ${from} → ${to} (not in ${to}.allowedFrom)`;
			return { ok: false, from, to, reason };
		}

		return this.#apply(from, to, meta);
	}

	/**
	 * Force a transition regardless of the phase graph (escape hatch).
	 *
	 * Used for hard abort / reset where any source phase must reach the target.
	 * Sets `forced: true` in the metadata before applying.
	 *
	 * @param to    Target phase.
	 * @param meta  Optional metadata.
	 * @returns A result indicating success, or no-op if self-transition.
	 */
	async force(to: Chapter, meta: TransitionMeta = {}): Promise<TransitionResult> {
		const from = this.#phase;
		if (to === from) {
			return { ok: true, from, to, noop: true };
		}
		return this.#apply(from, to, { ...meta, forced: true });
	}

	/** Internal apply — performs the actual phase change and all side effects. */
	async #apply(from: Chapter, to: Chapter, meta: TransitionMeta): Promise<TransitionResult> {
		// Cancel any pending timed transition.
		this.#clearTimer();

		// Update internal state.
		this.#phase = to;
		this.#subStatus = meta.reason ?? "";
		this.#running = ACTIVE_PHASES.has(to);
		this.#iteration = meta.iteration ?? this.#iteration + 1;
		this.#phaseStartedAt = Date.now();

		// Persist to StateTracker (fire-and-forget — non-blocking).
		this.#stateTracker.updatePipeline({ phase: to }).catch(() => {
			// Swallow persist errors — in-memory state is still accurate.
		});

		// Log the phase transition (fire-and-forget — non-blocking).
		try {
			this.#activityLogger.logPhase(to, undefined, this.#iteration);
		} catch {
			// Swallow logPhase errors — logging is best-effort and must not break the FSM.
		}

		// Notify listeners.
		const event = { from, to, meta };
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// Swallow listener errors — one bad listener must not crash the FSM.
			}
		}

		// Resolve any pending human-decision promise.
		if (this.#humanResolve) {
			const resolve = this.#humanResolve;
			this.#humanResolve = null;
			this.#humanReject = null;
			resolve(to);
		}

		// Arm auto-timeout if the new phase has a defaultTimeoutMs > 0.
		const targetDef = this.#phases.get(to);
		if (targetDef && targetDef.defaultTimeoutMs > 0) {
			this.#scheduleTimed(targetDef.defaultTimeoutMs);
		}

		return { ok: true, from, to };
	}

	// -- Human decision ---------------------------------------------------------

	/**
	 * Wait for a human decision (e.g. in blocked or confirm phases).
	 *
	 * Returns a promise that resolves with the next phase when a transition
	 * occurs, or rejects if the optional timeout expires.
	 *
	 * Only one waiter can be active at a time — calling this again while
	 * a previous waiter is pending will replace it.
	 *
	 * @param timeoutMs  Optional timeout in milliseconds (0 = no timeout).
	 * @returns A promise that resolves with the next Chapter on transition.
	 */
	async waitForHumanDecision<T = Chapter>(timeoutMs?: number): Promise<T> {
		// Cancel any previous waiter — reject the old promise with a cancellation
		// error so callers don't leave dangling promises that never settle.
		if (this.#humanReject) {
			const oldReject = this.#humanReject;
			this.#humanReject = null;
			this.#humanResolve = null;
			oldReject(new Error("Human decision cancelled: replaced by a new waiter"));
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		this.#humanResolve = resolve as (value: unknown) => void;
		this.#humanReject = reject as (reason: Error) => void;

		if (timeoutMs && timeoutMs > 0) {
			const capturedResolve = this.#humanResolve;
			setTimeout(() => {
				if (this.#humanResolve === capturedResolve) {
					this.#humanResolve = null;
					this.#humanReject = null;
					reject(new Error(`Human decision timed out after ${timeoutMs}ms`));
				}
			}, timeoutMs);
		}

		return promise;
	}

	// -- Listeners --------------------------------------------------------------

	/**
	 * Register a phase-change listener.
	 *
	 * Called synchronously after every successful transition with
	 * `{ from, to, meta }`.
	 *
	 * @param listener  Callback invoked on phase change.
	 * @returns An unsubscribe function — call it to remove the listener.
	 */
	onChange(listener: PhaseChangeListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	// -- Timed transitions ------------------------------------------------------

	/** Cancel any pending timed auto-transition. */
	cancelTimed(): void {
		this.#clearTimer();
	}

	/**
	 * Schedule an auto-transition after the phase's `defaultTimeoutMs`.
	 * The timer is armed when entering a phase with a positive defaultTimeout.
	 * Any manual transition before the timer fires cancels it.
	 */
	#scheduleTimed(ms: number): void {
		this.#clearTimer();
		const armedPhase = this.#phase;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			if (this.#phase !== armedPhase) return;

			const def = this.#phases.get(armedPhase);
			if (!def) return;

			// Hook: workflow:phaseTimeout
			if (this.#hookPipeline) {
				const ctx: HookContext = { phase: armedPhase };
				void this.#hookPipeline.trigger("workflow:phaseTimeout", { phase: armedPhase }, ctx);
			}

			// Use the explicit timedTransitionTarget if configured, otherwise pick
			// the first allowedTo that isn't the current phase.
			let to: Chapter | undefined;
			if (def.timedTransitionTarget) {
				to = def.timedTransitionTarget;
			} else {
				const targets = def.allowedTo.filter(p => p !== armedPhase);
				to = targets[0];
			}
			if (!to) return;

			void this.transition(to, {
				reason: `timed auto-transition after ${ms}ms`,
			});
		}, ms);
	}

	#clearTimer(): void {
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}

	// -- Lifecycle ---------------------------------------------------------------

	/**
	 * Dispose the FSM: clear the timer, unsubscribe all listeners, and reject
	 * any pending human-decision promise. After dispose the FSM must not be used.
	 */
	dispose(): void {
		this.#clearTimer();

		// Reject any pending human-decision promise.
		if (this.#humanReject) {
			const reject = this.#humanReject;
			this.#humanReject = null;
			this.#humanResolve = null;
			reject(new Error("WorkflowFsm disposed"));
		}

		// Clear all listeners.
		this.#listeners.clear();
	}
}
