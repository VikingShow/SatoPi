/**
 * ActivityLogger — Unified event capture for swarm pipeline.
 *
 * Captures all IRC messages, phase transitions, verdicts, file conflicts,
 * scaling events, nominations, and crashes. Each event is:
 *   1. Appended to `.swarm_{name}/activity.jsonl` (permanent history)
 *   2. Pushed to MonitorServer via SSE (real-time GUI updates)
 *
 * All write operations are fire-and-forget — they never block the main loop.
 *
 * Each ActivityLogger is bound to a session name so the broadcaster can
 * route events to the correct SSE subscribers.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReviewVerdict } from "./roundtable";
import type { SwarmSessionManager } from "./swarm-session-manager";

// ============================================================================
// Types
// ============================================================================

export type ActivityEventType =
	| "broadcast"
	| "subgroup"
	| "steering"
	| "steering_ack"
	| "phase"
	| "convergence"
	| "verdict"
	| "conflict"
	| "scaling"
	| "nomination"
	| "crash"
	| "tool_call"
	| "error_flag"
	| "file_change"
	| "stream_start"
	| "stream_delta"
	| "stream_end";

export interface ActivityEntry {
	ts: number;
	type: ActivityEventType;
	from?: string;
	to?: string;
	body?: string;
	/** Phase-specific fields */
	phase?: string;
	round?: number;
	iteration?: number;
	/** Convergence-specific fields */
	scope?: string;
	jaccard?: number;
	converged?: boolean;
	/** Verdict-specific fields */
	passed?: boolean;
	approval?: number;
	total?: number;
	findings?: string[];
	disagreed?: boolean;
	praised?: string[];
	criticized?: string[];
	/** Conflict-specific fields */
	file?: string;
	writers?: string[];
	severity?: string;
	/** Scaling-specific fields */
	action?: string;
	worker?: string;
	reason?: string;
	/** Nomination-specific fields */
	elected?: string | null;
	votes?: Record<string, string[]>;
	/** Crash-specific fields */
	error?: string;
	/** Steering-ack fields (P2-3) */
	messageId?: string;
	acknowledgedBy?: string;
	/** Tool-call fields (P2-10) */
	toolName?: string;
	toolInput?: string;
	toolOutput?: string;
	toolError?: string;
	toolDurationMs?: number;
	/** Error-flag fields (P2-11) */
	errorFlag?: string;
	recoverable?: boolean;
	suggestion?: string;
}

// ============================================================================
// MonitorServer interface (forward declaration — avoids circular import)
// ============================================================================

export interface ActivityBroadcaster {
	broadcast(sessionName: string, entry: ActivityEntry): void;
}

// ============================================================================
// ActivityLogger
// ============================================================================

export class ActivityLogger {
	readonly #logPath: string;
	readonly #sessionName: string;
	#broadcaster: ActivityBroadcaster | null = null;
	#writeQueue: Promise<void> = Promise.resolve();
	#sessionManager: SwarmSessionManager | null = null;

	constructor(swarmDir: string, sessionName: string) {
		this.#logPath = path.join(swarmDir, "activity.jsonl");
		this.#sessionName = sessionName;
	}

	/**
	 * Inject a SwarmSessionManager for OH-MY-PI dual-write persistence.
	 * When set, all log events are also written to the SessionManager
	 * (session.jsonl) in parallel with the legacy activity.jsonl file.
	 */
	setSessionManager(sm: SwarmSessionManager): void {
		this.#sessionManager = sm;
	}

	/**
	 * Set the SSE broadcaster (MonitorServer). Once set, all events are also
	 * pushed to connected browser clients in real-time.
	 */
	setBroadcaster(broadcaster: ActivityBroadcaster): void {
		this.#broadcaster = broadcaster;
	}

	/**
	 * Core write method — appends to activity.jsonl, pushes to SSE, and
	 * (if connected) writes to SwarmSessionManager for unified persistence.
	 * Serialized via writeQueue to preserve event ordering.
	 * Fire-and-forget: callers never await this.
	 */
	private log(entry: ActivityEntry): void {
		this.#writeQueue = this.#writeQueue
			.then(async () => {
				// Legacy: append to activity.jsonl
				await fs.appendFile(this.#logPath, JSON.stringify(entry) + "\n");
				// OH-MY-PI: dual-write to session.jsonl
				this.#sessionManager?.logActivity(entry);
				// Push to SSE
				this.#broadcaster?.broadcast(this.#sessionName, entry);
			})
			.catch(() => {
				// Swallow errors — logging must never crash the loop
			});
	}

	// -- IRC messaging --------------------------------------------------------

	logBroadcast(from: string, body: string): void {
		this.log({ ts: Date.now(), type: "broadcast", from, to: "all", body });
	}

	logSubGroup(group: string, from: string, body: string): void {
		this.log({ ts: Date.now(), type: "subgroup", from, to: group, body });
	}

	logSteering(from: string, to: string, body: string): void {
		this.log({ ts: Date.now(), type: "steering", from, to, body });
	}

	// -- Phase transitions ----------------------------------------------------

	logPhase(phase: string, round?: number, iteration?: number): void {
		this.log({ ts: Date.now(), type: "phase", phase, round, iteration });
	}

	logConvergence(scope: string, jaccard: number, converged: boolean): void {
		this.log({ ts: Date.now(), type: "convergence", scope, jaccard, converged });
	}

	// -- Review & verdict -----------------------------------------------------

	logVerdict(verdict: ReviewVerdict): void {
		this.log({
			ts: Date.now(),
			type: "verdict",
			passed: verdict.passed,
			approval: verdict.approvalCount,
			total: verdict.totalCount,
			findings: verdict.findings,
			disagreed: verdict.disagreed,
			praised: verdict.praisedWorkers,
			criticized: verdict.criticizedWorkers,
		});
	}

	// -- File conflicts -------------------------------------------------------

	logConflict(file: string, writers: string[], severity: string): void {
		this.log({ ts: Date.now(), type: "conflict", file, writers, severity });
	}

	// -- Scaling --------------------------------------------------------------

	logScaling(action: "add" | "remove", worker: string, reason: string): void {
		this.log({ ts: Date.now(), type: "scaling", action, worker, reason });
	}

	// -- Nomination -----------------------------------------------------------

	logNomination(round: number, elected: string | null, votes: Record<string, string[]>): void {
		this.log({ ts: Date.now(), type: "nomination", round, elected, votes });
	}

	// -- Crash ----------------------------------------------------------------

	logCrash(worker: string, error: string): void {
		this.log({ ts: Date.now(), type: "crash", worker, error });
	}

	// -- Steering Ack (P2-3) -------------------------------------------------

	/** Logged when a worker agent acknowledges receipt of a steering message. */
	logSteeringAck(agentName: string, messageId: string): void {
		this.log({ ts: Date.now(), type: "steering_ack", from: agentName, messageId, acknowledgedBy: agentName });
	}

	// -- Tool Call (P2-10) ---------------------------------------------------

	/** Logged when a swarm agent executes a tool. */
	logToolCall(agentName: string, toolName: string, input?: string, output?: string, error?: string, durationMs?: number): void {
		this.log({ ts: Date.now(), type: "tool_call", worker: agentName, toolName, toolInput: input, toolOutput: output, toolError: error, toolDurationMs: durationMs });
	}

	// -- Error Flag (P2-11) --------------------------------------------------

	/** Logged when a provider-level error is classified with a bit flag. */
	logProviderError(agentName: string, errorFlag: string, message: string, recoverable: boolean, suggestion?: string): void {
		this.log({ ts: Date.now(), type: "error_flag", worker: agentName, errorFlag, body: message, recoverable, suggestion });
	}

	// -- File Change ---------------------------------------------------------

	/** Logged when a worker agent creates, modifies, or deletes a file. */
	logFileChange(agentName: string, file: string, action: "created" | "modified" | "deleted", linesChanged?: number): void {
		this.log({ ts: Date.now(), type: "file_change", worker: agentName, file, action, linesChanged });
	}

	// -- Streaming Delta (P3-1) ----------------------------------------------

	/** Start of a streaming response — frontend creates a placeholder bubble. */
	logStreamStart(msgId: string, from: string): void {
		this.log({ ts: Date.now(), type: "stream_start", messageId: msgId, from, body: "" });
	}

	/** Incremental text chunk — frontend appends to the streaming bubble. */
	logStreamDelta(msgId: string, from: string, delta: string): void {
		this.log({ ts: Date.now(), type: "stream_delta", messageId: msgId, from, body: delta });
	}

	/** End of a streaming response — frontend finalises the bubble. */
	logStreamEnd(msgId: string, from: string, finalBody: string): void {
		this.log({ ts: Date.now(), type: "stream_end", messageId: msgId, from, body: finalBody });
	}
}
