/**
 * EventBus — per-session SSE subscriber management.
 *
 * Maintains active ReadableStreamDefaultController instances keyed by
 * session name.  A subscriber for session "X" only receives events
 * broadcast to session "X".  Subscribers with no session name receive
 * only global events (e.g. when session is unknown).
 */

import type { ActivityEntry, ActivityEventType } from "../activity-logger";

export type SSEController = ReadableStreamDefaultController<Uint8Array>;

interface Subscriber {
	controller: SSEController;
	/** If set, only events matching these types are delivered. */
	filter?: ActivityEventType[];
}

export class EventBus {
	/** sessionName → set of subscribers.  undefined key = global subscribers. */
	readonly #subscribers = new Map<string | undefined, Set<Subscriber>>();

	/**
	 * Register an SSE subscriber for a specific session.
	 * @param sessionName — the session to subscribe to (undefined = global only)
	 * @param controller — the SSE stream controller
	 * @param filter — optional event type filter
	 * @returns a cleanup function
	 */
	subscribe(
		sessionName: string | undefined,
		controller: SSEController,
		filter?: ActivityEventType[],
	): () => void {
		const sub: Subscriber = { controller, filter };
		let set = this.#subscribers.get(sessionName);
		if (!set) {
			set = new Set();
			this.#subscribers.set(sessionName, set);
		}
		set.add(sub);
		return () => {
			set?.delete(sub);
			if (set && set.size === 0) this.#subscribers.delete(sessionName);
		};
	}

	/** Send an entry to subscribers of a specific session. */
	broadcast(sessionName: string, entry: ActivityEntry): void {
		this.#send(this.#subscribers.get(sessionName), entry);
	}

	/** Send an entry to ALL subscribers regardless of session (global events). */
	broadcastAll(entry: ActivityEntry): void {
		for (const set of this.#subscribers.values()) {
			this.#send(set, entry);
		}
	}

	#send(set: Set<Subscriber> | undefined, entry: ActivityEntry): void {
		if (!set || set.size === 0) return;
		const data = `data: ${JSON.stringify(entry)}\n\n`;
		const encoded = new TextEncoder().encode(data);
		for (const sub of set) {
			if (sub.filter && !sub.filter.includes(entry.type)) continue;
			try {
				sub.controller.enqueue(encoded);
			} catch {
				set.delete(sub);
			}
		}
	}

	/** Close all SSE connections. */
	closeAll(): void {
		for (const set of this.#subscribers.values()) {
			for (const sub of set) {
				try { sub.controller.close(); } catch { /* ignore */ }
			}
		}
		this.#subscribers.clear();
	}

	get subscriberCount(): number {
		let count = 0;
		for (const set of this.#subscribers.values()) count += set.size;
		return count;
	}
}
