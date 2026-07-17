/**
 * ActivityLogger — Unified event capture for swarm pipeline.
 *
 * Captures all IRC messages, phase transitions, verdicts, file conflicts,
 * scaling events, nominations, and crashes. Each event is:
 *   1. Appended to `.swarm_{name}/activity.jsonl` (permanent history)
 *   2. Pushed to MonitorServer via SSE (real-time GUI updates)
 *
 * All write operations are fire-and-forget — they never block the main loop.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReviewVerdict } from "./roundtable";

// ============================================================================
// Types
// ============================================================================

export type ActivityEventType =
	| "broadcast"
	| "subgroup"
	| "steering"
	| "phase"
	| "convergence"
	| "verdict"
	| "conflict"
	| "scaling"
	| "nomination"
	| "crash";

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
}

// ============================================================================
// MonitorServer interface (forward declaration — avoids circular import)
// ============================================================================

export interface ActivityBroadcaster {
	broadcast(entry: ActivityEntry): void;
}

// ============================================================================
// ActivityLogger
// ============================================================================

export class ActivityLogger {
	readonly #logPath: string;
	#broadcaster: ActivityBroadcaster | null = null;
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(swarmDir: string) {
		this.#logPath = path.join(swarmDir, "activity.jsonl");
	}

	/**
	 * Set the SSE broadcaster (MonitorServer). Once set, all events are also
	 * pushed to connected browser clients in real-time.
	 */
	setBroadcaster(broadcaster: ActivityBroadcaster): void {
		this.#broadcaster = broadcaster;
	}

	/**
	 * Core write method — appends to activity.jsonl and pushes to SSE.
	 * Serialized via writeQueue to preserve event ordering in the file.
	 * Fire-and-forget: callers never await this.
	 */
	private log(entry: ActivityEntry): void {
		this.#writeQueue = this.#writeQueue
			.then(() => fs.appendFile(this.#logPath, JSON.stringify(entry) + "\n"))
			.then(() => {
				this.#broadcaster?.broadcast(entry);
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
}
