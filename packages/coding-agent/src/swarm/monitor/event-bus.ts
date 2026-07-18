/**
 * EventBus — SSE subscriber management.
 *
 * Maintains a set of active ReadableStreamDefaultController instances
 * (one per connected browser tab). When ActivityLogger emits an event,
 * it is serialized as an SSE message and enqueued to every subscriber.
 *
 * P4-3: Subscribers may optionally specify an event type filter to
 * receive only events of interest, reducing per-tab processing overhead.
 *
 * Disconnected/stale subscribers are silently removed.
 */

import type { ActivityEntry, ActivityEventType } from "../activity-logger";

export type SSEController = ReadableStreamDefaultController<Uint8Array>;

interface Subscriber {
	controller: SSEController;
	/** If set, only events matching these types are delivered. */
	filter?: ActivityEventType[];
}

export class EventBus {
	readonly #subscribers = new Set<Subscriber>();

	/**
	 * Register a new SSE subscriber.
	 * @param controller — the SSE stream controller
	 * @param filter — optional event type filter; when provided only matching events are delivered
	 * @returns a cleanup function
	 */
	subscribe(controller: SSEController, filter?: ActivityEventType[]): () => void {
		const sub: Subscriber = { controller, filter };
		this.#subscribers.add(sub);
		return () => this.#subscribers.delete(sub);
	}

	/** Push an activity entry to all connected clients, respecting per-subscriber filters. */
	broadcast(entry: ActivityEntry): void {
		const data = `data: ${JSON.stringify(entry)}\n\n`;
		const encoded = new TextEncoder().encode(data);
		for (const sub of this.#subscribers) {
			if (sub.filter && !sub.filter.includes(entry.type)) continue;
			try {
				sub.controller.enqueue(encoded);
			} catch {
				this.#subscribers.delete(sub);
			}
		}
	}

	/** Close all SSE connections (called on server shutdown). */
	closeAll(): void {
		for (const sub of this.#subscribers) {
			try {
				sub.controller.close();
			} catch {
				// ignore
			}
		}
		this.#subscribers.clear();
	}

	get subscriberCount(): number {
		return this.#subscribers.size;
	}
}
