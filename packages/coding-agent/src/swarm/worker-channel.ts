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

import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";

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
// WorkerChannel
// ============================================================================

export class WorkerChannel {
	readonly #ircBus: IrcBus;
	readonly #workers = new Set<string>();
	readonly #cloners = new Set<string>();
	readonly #groups = new Map<string, Set<string>>();

	constructor(ircBus: IrcBus, config: WorkerChannelConfig) {
		this.#ircBus = ircBus;
		for (const w of config.workers) this.#workers.add(w);
		for (const c of config.cloners) this.#cloners.add(c);
	}

	// -- lifecycle -------------------------------------------------------

	get workers(): ReadonlySet<string> { return this.#workers; }
	get cloners(): ReadonlySet<string> { return this.#cloners; }

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
		const message = { from, body, timestamp: Date.now() };
		const workerList = [...this.#workers];

		// Send to all workers in parallel
		await Promise.all(
			workerList.map((to) =>
				this.#ircBus.send({ from, to, body }),
			),
		);

		// Secret CC to cloners — suppressed from UI relay
		await Promise.all(
			[...this.#cloners].map((to) =>
				this.#ircBus.send({ from, to, body }, { suppressRelay: true }),
			),
		);
	}

	// -- sub-groups ------------------------------------------------------

	/**
	 * Create a named sub-group.
	 * Members are worker IDs; cloners automatically monitor all sub-groups.
	 */
	createSubGroup(name: string, members: string[]): void {
		// Validate members are workers
		const valid = members.filter((m) => this.#workers.has(m));
		this.#groups.set(name, new Set(valid));
	}

	/**
	 * Send to a named sub-group. Members + all cloners receive it.
	 */
	async sendToSubGroup(groupName: string, from: string, body: string): Promise<void> {
		const members = this.#groups.get(groupName);
		if (!members || members.size === 0) return;

		const memberList = [...members];
		await Promise.all(
			memberList.map((to) =>
				this.#ircBus.send({ from, to, body }),
			),
		);

		// Cloners monitor all sub-groups
		await Promise.all(
			[...this.#cloners].map((to) =>
				this.#ircBus.send({ from, to, body }, { suppressRelay: true }),
			),
		);
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
		await this.#ircBus.send({
			from: clonerId,
			to: workerId,
			body: `[CLONER STEERING] ${reason}`,
		});
	}

	/**
	 * Cloner 向全体 worker 广播指导。
	 */
	async broadcastSteering(clonerId: string, body: string): Promise<void> {
		await Promise.all(
			[...this.#workers].map((to) =>
				this.#ircBus.send({ from: clonerId, to, body: `[CLONER STEERING] ${body}` }),
			),
		);
	}
}
