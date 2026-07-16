/**
 * ClonerChannel — Cloner↔Cloner 可见通信层。
 *
 * 比 WorkerChannel 简单：cloner 之间完全透明广播，无秘密抄送。
 * WorkerChannel 保留 worker↔worker + secret CC cloner 的原有逻辑。
 */

import type { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";

// ============================================================================
// ClonerChannel
// ============================================================================

export class ClonerChannel {
	readonly #ircBus: IrcBus;
	readonly #cloners = new Set<string>();

	constructor(ircBus: IrcBus, clonerIds: string[]) {
		this.#ircBus = ircBus;
		for (const id of clonerIds) this.#cloners.add(id);
	}

	get cloners(): ReadonlySet<string> {
		return this.#cloners;
	}

	addCloner(agentId: string): void {
		this.#cloners.add(agentId);
	}

	removeCloner(agentId: string): void {
		this.#cloners.delete(agentId);
	}

	/**
	 * 向全体 cloner 广播（所有 cloner 可见，无秘密通道）。
	 */
	async broadcast(from: string, body: string): Promise<void> {
		const targets = [...this.#cloners].filter(id => id !== from);
		if (targets.length === 0) return;
		await this.#ircBus.sendToGroup(targets, { from, body });
	}
}
