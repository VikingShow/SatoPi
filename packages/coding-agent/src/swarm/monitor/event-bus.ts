/**
 * EventBus — SSE subscriber management.
 *
 * Maintains a set of active ReadableStreamDefaultController instances
 * (one per connected browser tab). When ActivityLogger emits an event,
 * it is serialized as an SSE message and enqueued to every subscriber.
 *
 * Disconnected/stale subscribers are silently removed.
 */

import type { ActivityEntry } from "../activity-logger";

export type SSEController = ReadableStreamDefaultController<Uint8Array>;

export class EventBus {
	readonly #subscribers = new Set<SSEController>();

	/** Register a new SSE subscriber. Returns a cleanup function. */
	subscribe(controller: SSEController): () => void {
		this.#subscribers.add(controller);
		return () => this.#subscribers.delete(controller);
	}

	/** Push an activity entry to all connected clients. */
	broadcast(entry: ActivityEntry): void {
		const data = `data: ${JSON.stringify(entry)}\n\n`;
		const encoded = new TextEncoder().encode(data);
		for (const sub of this.#subscribers) {
			try {
				sub.enqueue(encoded);
			} catch {
				this.#subscribers.delete(sub);
			}
		}
	}

	/** Close all SSE connections (called on server shutdown). */
	closeAll(): void {
		for (const sub of this.#subscribers) {
			try {
				sub.close();
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
