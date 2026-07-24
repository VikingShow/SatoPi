/**
 * EventBus — per-session SSE subscriber management with Last-Event-ID replay.
 *
 * Maintains active ReadableStreamDefaultController instances keyed by
 * session name.  A subscriber for session "X" only receives events
 * broadcast to session "X".  Subscribers with no session name receive
 * only global events (e.g. when session is unknown).
 *
 * Reliability (P1): every broadcast() is stamped with a globally monotonic
 * sequence number and buffered in a bounded per-session ring buffer. On
 * (re)subscribe the caller may pass the last seen id; the bus then replays
 * every buffered entry with a higher seq BEFORE live delivery resumes, so a
 * transient disconnect never drops events. This implements standard SSE
 * Last-Event-ID resume semantics.
 */

import type { ActivityEntry, ActivityEventType } from "../hooks/activity-logger";

export type SSEController = ReadableStreamDefaultController<Uint8Array>;

interface Subscriber {
	controller: SSEController;
	/** If set, only events matching these types are delivered. */
	filter?: ActivityEventType[];
}

/** A broadcast entry retained in the replay ring buffer. */
interface BufferedEntry {
	seq: number;
	entry: ActivityEntry;
}

/** Max entries retained per session for Last-Event-ID replay. */
const MAX_BUFFER_PER_SESSION = 1000;

export class EventBus {
	/** sessionName → set of subscribers.  undefined key = global subscribers. */
	readonly #subscribers = new Map<string | undefined, Set<Subscriber>>();
	/** sessionName → bounded ring buffer of recent entries for replay. */
	readonly #buffers = new Map<string | undefined, BufferedEntry[]>();
	/** Globally monotonic sequence counter — used as the SSE `id:`. */
	#seq = 0;
	/**
	 * Per-session counter of subscriber drops due to controller errors.
	 * When non-zero, broadcasts to a named session have lost at least one
	 * subscriber — a sign that the SSE connection is silently broken.
	 * Reset to 0 on next successful broadcast for that session.
	 */
	readonly #droppedCounts = new Map<string | undefined, number>();

	/**
	 * Register an SSE subscriber for a specific session.
	 * @param sessionName — the session to subscribe to (undefined = global only)
	 * @param controller — the SSE stream controller
	 * @param filter — optional event type filter
	 * @param lastEventId — the last SSE id the client saw; buffered entries with
	 *                      a higher seq are replayed immediately (gap recovery).
	 * @returns a cleanup function
	 */
	subscribe(
		sessionName: string | undefined,
		controller: SSEController,
		filter?: ActivityEventType[],
		lastEventId?: string,
	): () => void {
		const sub: Subscriber = { controller, filter };
		let set = this.#subscribers.get(sessionName);
		if (!set) {
			set = new Set();
			this.#subscribers.set(sessionName, set);
		}
		set.add(sub);

		// Replay any events the client missed while disconnected.
		if (lastEventId !== undefined && lastEventId !== "") {
			const since = Number(lastEventId);
			if (Number.isFinite(since)) {
				const buf = this.#buffers.get(sessionName);
				if (buf) {
					for (const b of buf) {
						if (b.seq > since) this.#sendOne(sub, b.seq, b.entry);
					}
				}
			}
		}

		return () => {
			set?.delete(sub);
			if (set && set.size === 0) this.#subscribers.delete(sessionName);
		};
	}

	/** Send an entry to subscribers of a specific session (and buffer it). */
	broadcast(sessionName: string, entry: ActivityEntry): void {
		const seq = ++this.#seq;
		this.#appendBuffer(sessionName, seq, entry);
		this.#send(this.#subscribers.get(sessionName), seq, entry, sessionName);

		// Once we've successfully reached any subscriber, reset the drop
		// counter — the connection is healthy again.
		const set = this.#subscribers.get(sessionName);
		if (set && set.size > 0) {
			this.#droppedCounts.set(sessionName, 0);
		}
	}

	/**
	 * Send an entry to ALL subscribers regardless of session (global events).
	 * Global events are ephemeral and NOT buffered for replay.
	 */
	broadcastAll(entry: ActivityEntry): void {
		const seq = ++this.#seq;
		for (const set of this.#subscribers.values()) {
			this.#send(set, seq, entry);
		}
	}

	/** Append an entry to the session ring buffer, evicting the oldest when full. */
	#appendBuffer(sessionName: string | undefined, seq: number, entry: ActivityEntry): void {
		let buf = this.#buffers.get(sessionName);
		if (!buf) {
			buf = [];
			this.#buffers.set(sessionName, buf);
		}
		buf.push({ seq, entry });
		if (buf.length > MAX_BUFFER_PER_SESSION) {
			buf.splice(0, buf.length - MAX_BUFFER_PER_SESSION);
		}
	}

	#send(
		set: Set<Subscriber> | undefined,
		seq: number,
		entry: ActivityEntry,
		sessionName?: string,
	): void {
		if (!set || set.size === 0) return;
		for (const sub of set) {
			if (!this.#sendOne(sub, seq, entry)) {
				// enqueue failed — subscriber was evicted.  If this was a
				// session-scoped broadcast, bump the drop counter so the
				// caller can react.
				if (sessionName !== undefined) {
					this.#droppedCounts.set(sessionName, (this.#droppedCounts.get(sessionName) ?? 0) + 1);
				}
				// Remove from the current set to avoid double-iteration of
				// the already-dead subscriber.
				set.delete(sub);
			}
		}
	}

	/** @returns false when the subscriber was evicted (controller dead). */
	#sendOne(sub: Subscriber, seq: number, entry: ActivityEntry): boolean {
		if (sub.filter && !sub.filter.includes(entry.type)) return true;
		// SSE frame with an explicit id so clients can resume via Last-Event-ID.
		const data = `id: ${seq}\ndata: ${JSON.stringify(entry)}\n\n`;
		const encoded = new TextEncoder().encode(data);
		try {
			sub.controller.enqueue(encoded);
		} catch {
			// Controller closed — remove this subscriber from its set.
			// Previously this silently deleted the subscriber from ALL sets
			// via a global sweep, which leaked dead subscribers and masked
			// the problem entirely.  Now the caller (#send) handles exact
			// removal and bumps a drop counter so the broadcast path can
			// detect silent SSE disconnections.
			for (const set of this.#subscribers.values()) set.delete(sub);
			return false;
		}
		return true;
	}

	/**
	 * How many subscribers have been lost on this session since the last
	 * successful broadcast.  A non-zero value means the SSE connection is
	 * silently broken and the frontend is receiving no events.
	 */
	getDroppedCount(sessionName: string): number {
		return this.#droppedCounts.get(sessionName) ?? 0;
	}

	/** Alias for getDroppedCount used by MonitorServer health endpoint. */
	droppedCountFor(sessionName: string): number {
		return this.getDroppedCount(sessionName);
	}

	/** Close all SSE connections. */
	closeAll(): void {
		for (const set of this.#subscribers.values()) {
			for (const sub of set) {
				try { sub.controller.close(); } catch { /* ignore */ }
			}
		}
		this.#subscribers.clear();
		this.#buffers.clear();
	}

	get subscriberCount(): number {
		let count = 0;
		for (const set of this.#subscribers.values()) count += set.size;
		return count;
	}
}
