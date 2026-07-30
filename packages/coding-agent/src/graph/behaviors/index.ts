/**
 * PhaseBehavior — Interface and context types for pluggable phase behaviors.
 *
 * Part of the swarm v3 unified architecture (Phase 4A).
 *
 * Each workflow phase (script, stage, curtain) is implemented as a
 * PhaseBehavior that wraps the phase-specific coordination logic. The
 * behaviors delegate to SwarmRuntime, IrcBus, HookPipeline, and
 * ContextPipeline for agent lifecycle and communication.
 */

import type { CommChannel } from "../../comm/comm-channel";
import type { ContextPipeline } from "../../context/context-pipeline";
import type { HookPipeline } from "../../hooks/hook-pipeline";
import type { ActivityLogger } from "../../infra/activity-logger";
import type { IrcBus } from "../../irc/bus";
import type { AgentSession } from "../../session/agent-session";
import type { LoopSwarmConfig } from "../../swarm/core/schema";
import type { Chapter, StateTracker } from "../../swarm/core/state";
import type { SwarmRuntime } from "../../swarm/core/swarm-runtime";

// ============================================================================
// PhaseContext
// ============================================================================

/**
 * Shared service context injected into every PhaseBehavior.enter() call.
 *
 * All six core services are provided so behaviors can spawn agents,
 * create communication channels, assemble context, trigger hooks, and
 * track state — without importing the concrete implementations directly.
 */
export interface PhaseContext {
	/** Communication bus — creates channels and routes messages. */
	ircBus: IrcBus;

	/** Agent runtime — spawns agents and delivers steering messages. */
	runtime: SwarmRuntime;

	/** Context pipeline — assembles agent context from registered sources. */
	contextPipeline: ContextPipeline;

	/** Hook pipeline — triggers lifecycle hooks at agent/phase boundaries. */
	hookPipeline: HookPipeline;

	/** State tracker — persists swarm pipeline state. */
	stateTracker: StateTracker;

	/** Activity logger — captures structured events for SSE + session.jsonl. */
	activityLogger: ActivityLogger;

	/** Absolute path to the project workspace directory. */
	workspace: string;

	/** Absolute path to the swarm workspace (.stp/sessions/swarm-<name>). */
	swarmDir: string;

	/** Raw plan content (markdown) — populated after Script phase. */
	planContent?: string;

	/** Loop-mode configuration — set when the swarm mode is "loop". */
	loopConfig: LoopSwarmConfig;

	/** AbortSignal for cooperative cancellation of long-running operations. */
	signal: AbortSignal;
}

// ============================================================================
// PhaseEnterResult
// ============================================================================

/**
 * Result returned by PhaseBehavior.enter().
 *
 * The orchestrator uses these handles and channels to wire up
 * event listeners and track agent lifecycle after the phase begins.
 */
export interface PhaseEnterResult {
	/** Agent sessions for all agents spawned during phase entry. */
	agents: AgentSession[];

	/** Communication channels created during phase entry. */
	channels: CommChannel[];

	/** Optional initial message to display in the UI. */
	initialUIMessage?: string;
}

// ============================================================================
// PhaseCompletion
// ============================================================================

/**
 * Result returned by PhaseBehavior.checkCompletion() when the phase
 * has finished and is ready to transition.
 *
 * Return `null` to indicate the phase is still running.
 */
export interface PhaseCompletion {
	/** The next workflow phase to transition to. */
	nextPhase: Chapter;

	/** Whether the human needs to applaud before transitioning. */
	needApplaud?: boolean;

	/** Whether the orchestrator should confirm before re-planning (re-plan gate). */
	needConfirmRetry?: boolean;

	/** Optional status message for the UI / activity log. */
	message?: string;
}

// ============================================================================
// PhaseBehavior
// ============================================================================

/**
 * Pluggable behavior contract for a single workflow phase.
 *
 * Each phase (script, stage, curtain) implements this interface.
 * The orchestrator calls the lifecycle methods in order:
 *
 *   1. enter(ctx) — set up agents, channels, and initial state
 *   2. handleHumanMessage(msg) — route human input (repeatable)
 *   3. handleAgentEvent(event) — react to agent lifecycle events (repeatable)
 *   4. checkCompletion() — poll whether the phase is finished (repeatable)
 *   5. exit() — tear down state
 *
 * Behaviors delegate to the injected services in PhaseContext rather
 * than importing concrete implementations (ScriptManager, StageController,
 * CurtainRunner) directly.
 */
export interface PhaseBehavior {
	/** The workflow phase this behavior handles. */
	readonly phase: Chapter;

	/**
	 * Called when the FSM enters this phase.
	 *
	 * Spawns initial agents, creates communication channels, and returns
	 * handles + channels so the orchestrator can wire up event listeners.
	 */
	enter(ctx: PhaseContext): Promise<PhaseEnterResult>;

	/**
	 * Called when a human message is received through the IrcBus.
	 *
	 * The behavior routes the message to the appropriate agent(s) —
	 * e.g. ScriptBehavior routes to the Planner, StageBehavior broadcasts
	 * as a steering directive to all workers.
	 */
	handleHumanMessage(msg: { from: string; body: string }, ctx: PhaseContext): Promise<void>;

	/**
	 * Called when an agent lifecycle event occurs.
	 *
	 * The HookPipeline handles low-level events (offload, profile,
	 * stigmergy) via agent:afterComplete.  This method handles higher-level
	 * coordination: conflict detection, task re-assignment, completion
	 * tracking.
	 */
	handleAgentEvent(event: { agentId: string; status: string; result?: unknown }, ctx: PhaseContext): Promise<void>;

	/**
	 * Check whether the phase is complete and ready to transition.
	 *
	 * Called periodically by the orchestrator.  Returns `null` while
	 * the phase is still running, or a PhaseCompletion with the next
	 * phase and any transition metadata.
	 */
	checkCompletion(ctx: PhaseContext): Promise<PhaseCompletion | null>;

	/**
	 * Called when the FSM exits this phase.
	 *
	 * Cleans up any internal state (agent handles, channels, timers).
	 * The orchestrator handles aborting any still-running agents before
	 * calling this method.
	 */
	exit(): Promise<void>;
}
