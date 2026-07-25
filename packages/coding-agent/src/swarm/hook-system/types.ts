/**
 * Hook System Types
 *
 * Defines the event taxonomy, registration interface, and context types
 * for the HookPipeline system. This is the Phase 1A foundation of the
 * swarm v3 unified architecture refactoring.
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
// Payload & Context
// ---------------------------------------------------------------------------

/**
 * Flexible event payload.
 *
 * Each event carries different data. Common keys include:
 * - `agentId` — the agent that triggered the event
 * - `phase` — the current workflow phase (mirrored in HookContext)
 * - `success` — boolean result for agent completion
 * - `error` — error description for onError events
 * - `message` — message content for communication events
 */
export interface HookPayload {
  [key: string]: unknown;
}

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
   * Hook handler.
   *
   * @param event  - The event being triggered.
   * @param payload - Event-specific payload.
   * @param ctx    - Shared service context.
   * @returns `void` to continue, `false` to short-circuit remaining hooks.
   */
  handler(
    event: HookEvent,
    payload: HookPayload,
    ctx: HookContext,
  ): Promise<void | boolean>;
}
