/**
 * WorkerChannel — Worker 群聊通信层。
 *
 * 基于 IrcBus 封装，提供：
 * - broadcast: 向全体 worker 广播（秘密抄送全体 cloner）
 * - sub-group: worker 之间拉小群协商
 * - interrupt: cloner 接入指导特定 worker
 * - monitoring: cloner 订阅所有 worker 消息流
 *
 * Worker 不知道 cloner 的存在 —— 所有 cloner 消息通过 suppressRelay 秘密送达。
 */

import type { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { ActivityLogger } from "./activity-logger";

// ============================================================================
// Types
// ============================================================================

export interface WorkerMessage {
	from: string;
	body: string;
	timestamp: number;
}

export interface WorkerChannelConfig {
	/** Initial worker agent IDs. */
	workers: string[];
	/** Cloner agent IDs (secret subscribers). */
	cloners: string[];
}

// ============================================================================
// Nomination types
// ============================================================================

export interface Nomination {
	/** Who made the nomination. */
	nominator: string;
	/** Who they nominated. */
	nominee: string;
}

export interface NominationResult {
	/** Elected worker ID, or null if no consensus. */
	elected: string | null;
	/** All nominations cast, grouped by nominee. */
	votes: Record<string, string[]>;
	round: number;
}

// ============================================================================
export class WorkerChannel {
	readonly #ircBus: IrcBus;
	readonly #workers = new Set<string>();
	readonly #cloners = new Set<string>();
	readonly #groups = new Map<string, Set<string>>();
	#nominationRound = 0;
	#nominations: Nomination[] = [];
	readonly #activityLogger?: ActivityLogger;

	constructor(ircBus: IrcBus, config: WorkerChannelConfig, activityLogger?: ActivityLogger) {
		this.#ircBus = ircBus;
		this.#activityLogger = activityLogger;
		for (const w of config.workers) this.#workers.add(w);
		for (const c of config.cloners) this.#cloners.add(c);
	}

	// -- lifecycle -------------------------------------------------------

	get workers(): ReadonlySet<string> {
		return this.#workers;
	}
	get cloners(): ReadonlySet<string> {
		return this.#cloners;
	}

	addWorker(agentId: string): void {
		this.#workers.add(agentId);
	}

	removeWorker(agentId: string): void {
		this.#workers.delete(agentId);
		// Remove from all subgroups
		for (const [, members] of this.#groups) {
			members.delete(agentId);
		}
	}

	// -- messaging -------------------------------------------------------

	/**
	 * Broadcast to ALL workers (visible) + secret-CC all cloners.
	 * Workers see the message as coming from `from`, addressed to the worker group.
	 * Cloners receive a copy silently.
	 */
	async broadcast(from: string, body: string): Promise<void> {
		this.#activityLogger?.logBroadcast(from, body);
		const workerList = [...this.#workers];

		// Send to all workers in parallel
		await Promise.all(workerList.map(to => this.#ircBus.send({ from, to, body })));

		// Secret CC to cloners — suppressed from UI relay
		await Promise.all([...this.#cloners].map(to => this.#ircBus.send({ from, to, body }, { suppressRelay: true })));
	}

	// -- sub-groups ------------------------------------------------------

	/**
	 * Create a named sub-group.
	 * Members are worker IDs; cloners automatically monitor all sub-groups.
	 */
	createSubGroup(name: string, members: string[]): void {
		// Validate members are workers
		const valid = members.filter(m => this.#workers.has(m));
		this.#groups.set(name, new Set(valid));
	}

	/**
	 * Send to a named sub-group. Members + all cloners receive it.
	 */
	async sendToSubGroup(groupName: string, from: string, body: string): Promise<void> {
		this.#activityLogger?.logSubGroup(groupName, from, body);
		const members = this.#groups.get(groupName);
		if (!members || members.size === 0) return;

		const memberList = [...members];
		await Promise.all(memberList.map(to => this.#ircBus.send({ from, to, body })));

		// Cloners monitor all sub-groups
		await Promise.all([...this.#cloners].map(to => this.#ircBus.send({ from, to, body }, { suppressRelay: true })));
	}

	addToSubGroup(groupName: string, workerId: string): void {
		if (!this.#workers.has(workerId)) return;
		const group = this.#groups.get(groupName);
		if (group) group.add(workerId);
	}

	removeFromSubGroup(groupName: string, workerId: string): void {
		this.#groups.get(groupName)?.delete(workerId);
	}

	// -- cloner interrupt ------------------------------------------------

	/**
	 * Cloner 介入指导一个 worker（steering）。
	 * Worker 收到高优先级消息，调整方向但不停止。
	 */
	async interrupt(clonerId: string, workerId: string, reason: string): Promise<void> {
		this.#activityLogger?.logSteering(clonerId, workerId, reason);
		await this.#ircBus.send({
			from: clonerId,
			to: workerId,
			body: `[CLONER STEERING] ${reason}`,
		});
	}

	async broadcastSteering(clonerId: string, body: string): Promise<void> {
		this.#activityLogger?.logSteering(clonerId, "all", body);
		await Promise.all(
			[...this.#workers].map(to => this.#ircBus.send({ from: clonerId, to, body: `[CLONER STEERING] ${body}` })),
		);
	}

	// -- nomination --------------------------------------------------------

	/**
	 * Start a new nomination round. Clears any previous nomination state.
	 * Workers are expected to produce `## Nomination` sections in their output
	 * for this round; those are collected and fed to {@link tally}.
	 */
	startNomination(round: number): void {
		this.#nominationRound = round;
		this.#nominations = [];
	}

	/** Record a nomination from a worker. Self-nominations are ignored. */
	processNomination(nominator: string, nominee: string): void {
		if (nominator === nominee) return;
		if (!this.#workers.has(nominator)) return;
		if (!this.#workers.has(nominee)) return;
		this.#nominations.push({ nominator, nominee });
	}

	/**
	 * Build a nomination prompt for workers at the start of a round.
	 * Injected into the worker task before execution begins.
	 */
	buildNominationPrompt(): string {
		const workerList = [...this.#workers].join(", ");
		return [
			`## Reviewer Election (Round ${this.#nominationRound})`,
			``,
			`At the END of your output, include a \`## Nomination\` section with ONE line:`,
			``,
			`\`\`\``,
			`## Nomination`,
			`nominated: <worker-id>`,
			`reason: <one sentence explaining why>`,
			`\`\`\``,
			``,
			`Available workers: ${workerList}`,
			`You may nominate any worker (including yourself).`,
			`The worker with the most nominations becomes the Reviewer for this round.`,
			`The Reviewer will NOT write code — they review all outputs and produce a Round Summary.`,
			`Choose the worker best suited to assess this round's work against the plan's acceptance criteria.`,
		].join("\n");
	}

	/**
	 * Tally nominations and elect a reviewer.
	 * Returns the elected worker ID, or null if no nominations were cast.
	 * Ties are broken by choosing the first nominee to reach the highest count.
	 */
	tally(): NominationResult {
		const votes: Record<string, string[]> = {};
		for (const nom of this.#nominations) {
			if (!votes[nom.nominee]) votes[nom.nominee] = [];
			votes[nom.nominee].push(nom.nominator);
		}

		let elected: string | null = null;
		let bestCount = 0;
		for (const [nominee, nominators] of Object.entries(votes)) {
			if (nominators.length > bestCount) {
				bestCount = nominators.length;
				elected = nominee;
			}
		}

		const result = {
			elected: bestCount > 0 ? elected : null,
			votes,
			round: this.#nominationRound,
		};
		this.#activityLogger?.logNomination(this.#nominationRound, result.elected, votes);
		return result;
	}

	/**
	 * Build the reviewer-specific system prompt suffix.
	 * Appended to the base WORKER_SYSTEM_PROMPT for the elected reviewer.
	 */
	static buildReviewerPrompt(): string {
		return [
			``,
			`## REVIEWER ROLE`,
			``,
			`You have been ELECTED as the Reviewer for this round. Your role is DIFFERENT from other workers:`,
			``,
			`WHAT YOU DO:`,
			`- Read EVERY worker's output (use read tool on workspace files they produced)`,
			`- Assess each output against plan.md acceptance criteria`,
			`- Identify conflicts between workers (same file, contradicting logic)`,
			`- Produce a structured Round Summary (format below)`,
			``,
			`WHAT YOU DO NOT DO:`,
			`- Do NOT write or edit code (no edit, write, or bash that modifies files)`,
			`- Do NOT produce your own implementation`,
			`- Your output IS the Round Summary — that is your deliverable`,
			``,
			`ROUND SUMMARY FORMAT (output this EXACTLY as a code block in your final message):`,
			``,
			`\`\`\`json`,
			`{`,
			`  "round": <number>,`,
			`  "reviewer": "<your-worker-id>",`,
			`  "accomplished": {`,
			`    "worker-1": "one-line summary of what they did",`,
			`    "worker-2": "one-line summary of what they did"`,
			`  },`,
			`  "issues": [`,
			`    {`,
			`      "severity": "blocker|major|minor",`,
			`      "workers": ["worker-1"],`,
			`      "file": "path/to/file",`,
			`      "description": "what's wrong",`,
			`      "resolution": "your ruling or suggested fix"`,
			`    }`,
			`  ],`,
			`  "remaining": ["task A", "task B"],`,
			`  "recommended_division": {`,
			`    "worker-1": "suggested next task"`,
			`  },`,
			`  "convergence_opinion": "converging|diverging|stalled"`,
			`}`,
			`\`\`\``,
		].join("\n");
	}
}
