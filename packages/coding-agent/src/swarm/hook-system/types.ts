/**
 * Hook System Types
 *
 * Defines the event taxonomy, typed event payloads, registration interface,
 * and context types for the HookPipeline system. This is the Phase 1A
 * foundation of the swarm v3 unified architecture refactoring.
 *
 * Phase B2: HookPayload is now a typed discriminated union mapped by event
 * type, eliminating the `{ [key: string]: unknown }` index signature and
 * providing compile-time safety for hook implementations.
 *
 * @module hook-system/types
 */

import type { Chapter } from "../core/state";

// ---------------------------------------------------------------------------
// Event Taxonomy — all lifecycle events the pipeline can respond to
// ---------------------------------------------------------------------------

/**
 * All hook events covering the full swarm lifecycle.
 *
 * Workflow events: phase transitions and timeouts
 * Agent events: spawn, completion, error
 * Context events: injection and compaction lifecycle
 * Offload events: L1 summaries, flush operations
 * Communication events: messages and broadcasts
 * Roundtable events: debate rounds and convergence
 * Vote events: opinion gathering and tallying
 */
export type HookEvent =
	// Workflow phase lifecycle
	| "workflow:beforePhase"
	| "workflow:afterPhase"
	| "workflow:phaseTimeout"
	// Agent lifecycle
	| "agent:beforeSpawn"
	| "agent:afterSpawn"
	| "agent:afterComplete"
	| "agent:onError"
	// Context window management
	| "context:beforeInjection"
	| "context:afterInjection"
	| "context:beforeCompaction"
	| "context:afterCompaction"
	// Offload / persistence
	| "offload:afterL1"
	| "offload:beforeFlush"
	| "offload:afterFlush"
	// Communication bus
	| "comm:beforeMessage"
	| "comm:afterMessage"
	| "comm:beforeBroadcast"
	| "comm:afterBroadcast"
	// Roundtable / debate
	| "roundtable:beforeRound"
	| "roundtable:afterRound"
	| "roundtable:converged"
	// Voting / consensus
	| "vote:start"
	| "vote:tally"
	| "vote:result";

// ---------------------------------------------------------------------------
// Typed Event Payloads (Phase B2 — discriminated union)
// ---------------------------------------------------------------------------

/** Payload for agent:beforeSpawn — emitted before an agent is launched. */
export interface AgentBeforeSpawnPayload {
	agentId: string;
	role: string;
	task: string;
	/** Optional display name (falls back to agentId in profile-hook). */
	name?: string;
	/** Optional archetype label for profile classification. */
	archetype?: string;
	/** Optional plan summary for mnemopi recall. */
	planSummary?: string;
	/** Optional task summary for mnemopi recall. */
	taskSummary?: string;
}

/** Payload for agent:afterSpawn — emitted after successful agent launch. */
export interface AgentAfterSpawnPayload {
	agentId: string;
	role: string;
	/** The AgentHandle returned by AgentLauncher. */
	handle: unknown;
}

/** Payload for agent:afterComplete — emitted when an agent finishes a task. */
export interface AgentAfterCompletePayload {
	agentId: string;
	/** Whether the task succeeded (defaults to true in profile-hook). */
	success?: boolean;
	/** Optional path to the output artifact. */
	artifactPath?: string;
	/** Optional human-readable completion message. */
	message?: string;
	/** Optional L1 summary text for mnemopi storage. */
	summary?: string;
	/** Optional quality score for mnemopi storage. */
	score?: number;
	/** Optional task ID from the task queue. */
	taskId?: string;
	/** Optional raw result object from the agent. */
	result?: unknown;
}

/** Payload for agent:onError — emitted when an agent encounters an error. */
export interface AgentOnErrorPayload {
	agentId: string;
	/** Error message or description. */
	error: string;
}

/** Payload for workflow:beforePhase — emitted before a phase transition. */
export interface WorkflowBeforePhasePayload {
	/** Optional phase name. */
	phase?: string;
	/** Optional shell verification commands to run (verification-hook). */
	commands?: string[];
}

/** Payload for workflow:afterPhase — emitted after a phase completes. */
export interface WorkflowAfterPhasePayload {
	/** Optional list of agent IDs that participated in the phase. */
	agentIds?: string[];
	/** Optional session summary for experience persistence. */
	sessionSummary?: unknown;
	/** Optional run IDs to mark as referenced (experience store). */
	runIds?: string[];
}

/** Payload for workflow:phaseTimeout — emitted when a phase times out. */
export interface WorkflowPhaseTimeoutPayload {
	/** The phase that timed out. */
	phase?: string;
}

/** Payload for context events (injection / compaction lifecycle). */
export interface ContextLifecyclePayload {
	/** Optional agent ID associated with the context operation. */
	agentId?: string;
}

/** Payload for offload:afterL1 — emitted after an L1 summary is produced. */
export interface OffloadAfterL1Payload {
	/** The agent whose conversation was summarized. */
	agentId?: string;
}

/** Payload for offload:beforeFlush / offload:afterFlush. */
export interface OffloadFlushPayload {
	/** Optional experience entry to bridge to the experience store. */
	entry?: unknown;
	/** Optional run ID for tracing. */
	runId?: string;
}

/** Payload for communication events (messaging / broadcast). */
export interface CommPayload {
	/** Optional sender agent ID. */
	from?: string;
	/** Optional target agent ID (for direct messages). */
	to?: string;
	/** Optional message content. */
	message?: string;
}

/** Payload for roundtable:beforeRound. */
export interface RoundtableBeforeRoundPayload {
	/** Optional agent ID for the round participant. */
	agentId?: string;
	/** Optional round number. */
	round?: number;
}

/** Payload for roundtable:afterRound — emitted after a debate round. */
export interface RoundtableAfterRoundPayload {
	/** The agent whose round completed. */
	agentId: string;
}

/** Payload for roundtable:converged — emitted when debate reaches consensus. */
export interface RoundtableConvergedPayload {
	/** IDs of agents that participated in the converged debate. */
	agentIds?: string[];
}

/** Payload for vote events. */
export interface VotePayload {
	/** Optional agent IDs involved in the vote. */
	agentIds?: string[];
	/** Optional vote topic or question. */
	topic?: string;
}

// ---------------------------------------------------------------------------
// HookPayloadMap — maps every event to its typed payload
// ---------------------------------------------------------------------------

/**
 * Typed mapping from hook events to their expected payload shapes.
 *
 * Used by the generic {@link HookRegistration.handler} and
 * {@link HookPipeline.trigger} to provide compile-time type safety.
 *
 * Usage:
 * ```ts
 * // Handler receives correctly-typed payload based on the event switch:
 * handler<K extends HookEvent>(event: K, payload: HookPayloadMap[K], ctx) {
 *   if (event === "agent:beforeSpawn") {
 *     // payload is AgentBeforeSpawnPayload — agentId, role, task are all string
 *   }
 * }
 * ```
 */
export type HookPayloadMap = {
	"workflow:beforePhase": WorkflowBeforePhasePayload;
	"workflow:afterPhase": WorkflowAfterPhasePayload;
	"workflow:phaseTimeout": WorkflowPhaseTimeoutPayload;
	"agent:beforeSpawn": AgentBeforeSpawnPayload;
	"agent:afterSpawn": AgentAfterSpawnPayload;
	"agent:afterComplete": AgentAfterCompletePayload;
	"agent:onError": AgentOnErrorPayload;
	"context:beforeInjection": ContextLifecyclePayload;
	"context:afterInjection": ContextLifecyclePayload;
	"context:beforeCompaction": ContextLifecyclePayload;
	"context:afterCompaction": ContextLifecyclePayload;
	"offload:afterL1": OffloadAfterL1Payload;
	"offload:beforeFlush": OffloadFlushPayload;
	"offload:afterFlush": OffloadFlushPayload;
	"comm:beforeMessage": CommPayload;
	"comm:afterMessage": CommPayload;
	"comm:beforeBroadcast": CommPayload;
	"comm:afterBroadcast": CommPayload;
	"roundtable:beforeRound": RoundtableBeforeRoundPayload;
	"roundtable:afterRound": RoundtableAfterRoundPayload;
	"roundtable:converged": RoundtableConvergedPayload;
	"vote:start": VotePayload;
	"vote:tally": VotePayload;
	"vote:result": VotePayload;
};

// ---------------------------------------------------------------------------
// HookPayload — legacy union type (backward-compatible with Phase 1A)
// ---------------------------------------------------------------------------

/**
 * Legacy flexible event payload — union of all typed payloads.
 *
 * Prefer using {@link HookPayloadMap} with a specific event key for
 * compile-time safety. This union type exists for backward compatibility
 * with Phase 1A code that treats payloads as a bag of unknown values.
 */
export type HookPayload = HookPayloadMap[HookEvent];

// ---------------------------------------------------------------------------
// HookContext
// ---------------------------------------------------------------------------

/**
 * Shared service context available to all hooks during trigger.
 *
 * All fields are optional — not every service is wired in Phase 1A.
 * The index signature allows forward-compatible extension.
 */
export interface HookContext {
	/** Current workflow phase (used for phase-filtered hooks) */
	phase?: Chapter;
	/** The agent id associated with the current event */
	agentId?: string;
	/** FSM / state machine service (future) */
	fsm?: unknown;
	/** Communication bus (future) */
	commBus?: unknown;
	/** Runtime / execution environment (future) */
	runtime?: unknown;
	/** Context window manager (future) */
	contextManager?: unknown;
	/** State tracker for persistence (future) */
	stateTracker?: unknown;
	/** Activity logger for structured event logging */
	activityLogger?: unknown;
	/** Session registry (future) */
	sessionRegistry?: unknown;
	/** Forward-compatible extensions */
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * A hook registration — the contract between a hook implementation
 * and the HookPipeline.
 *
 * Hooks are sorted by `priority` (lowest runs first) and may optionally
 * restrict themselves to specific `phases`. Return `false` from the
 * handler to short-circuit remaining hooks for this trigger.
 *
 * Phase B2: the handler is generic over the event type, so payloads
 * are correctly typed based on the event being handled.
 */
export interface HookRegistration {
	/** Unique hook name (used for unregister / debugging) */
	readonly name: string;
	/** Execution order — lower values run first */
	readonly priority: number;
	/** Events this hook subscribes to */
	readonly events: HookEvent[];
	/** Optional phase filter — if set, the hook only fires during these phases */
	readonly phases?: Chapter[];
	/**
	 * Hook handler — generic over the triggered event.
	 *
	 * Use `switch (event)` to narrow the payload type:
	 * ```ts
	 * handler<K extends HookEvent>(event: K, payload: HookPayloadMap[K], ctx) {
	 *   switch (event) {
	 *     case "agent:beforeSpawn":
	 *       // payload is AgentBeforeSpawnPayload
	 *       break;
	 *   }
	 * }
	 * ```
	 *
	 * @param event   - The event being triggered.
	 * @param payload - Event-specific payload (typed via HookPayloadMap).
	 * @param ctx     - Shared service context.
	 * @returns `void` to continue, `false` to short-circuit remaining hooks.
	 */
	handler<K extends HookEvent>(event: K, payload: HookPayloadMap[K], ctx: HookContext): Promise<void | boolean>;
}
