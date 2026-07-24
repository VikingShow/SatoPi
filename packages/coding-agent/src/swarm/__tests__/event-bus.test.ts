/**
 * EventBus tests — Last-Event-ID replay + per-session isolation.
 */
import { describe, it, expect } from "bun:test";
import { EventBus } from "../monitor/event-bus";
import type { ActivityEntry } from "../hooks/activity-logger";

function fakeController() {
	const frames: string[] = [];
	const dec = new TextDecoder();
	const controller = {
		enqueue: (u8: Uint8Array) => frames.push(dec.decode(u8)),
		close: () => {},
	} as unknown as ReadableStreamDefaultController<Uint8Array>;
	return { frames, controller };
}

const entry = (type: string, body?: string): ActivityEntry =>
	({ ts: Date.now(), type, body }) as unknown as ActivityEntry;

describe("EventBus — Last-Event-ID replay", () => {
	it("emits SSE frames with an explicit id:", () => {
		const bus = new EventBus();
		const { frames, controller } = fakeController();
		bus.subscribe("s", controller);
		bus.broadcast("s", entry("broadcast", "hello"));
		expect(frames.length).toBe(1);
		expect(frames[0]).toContain("id: 1");
		expect(frames[0]).toContain('"body":"hello"');
	});

	it("replays only buffered entries with seq greater than lastEventId", () => {
		const bus = new EventBus();
		bus.broadcast("s", entry("broadcast", "a")); // seq 1
		bus.broadcast("s", entry("broadcast", "b")); // seq 2
		bus.broadcast("s", entry("broadcast", "c")); // seq 3

		const { frames, controller } = fakeController();
		bus.subscribe("s", controller, undefined, "1"); // want seq > 1 → b, c

		expect(frames.length).toBe(2);
		expect(frames[0]).toContain("id: 2");
		expect(frames[0]).toContain('"body":"b"');
		expect(frames[1]).toContain("id: 3");
		expect(frames[1]).toContain('"body":"c"');
	});

	it("does NOT replay when no lastEventId is provided", () => {
		const bus = new EventBus();
		bus.broadcast("s", entry("broadcast", "x"));
		const { frames, controller } = fakeController();
		bus.subscribe("s", controller);
		expect(frames.length).toBe(0);
	});

	it("continues live delivery after replay with monotonic ids", () => {
		const bus = new EventBus();
		bus.broadcast("s", entry("broadcast", "a")); // seq 1
		const { frames, controller } = fakeController();
		bus.subscribe("s", controller, undefined, "0"); // replay a (seq 1)
		bus.broadcast("s", entry("broadcast", "b")); // live seq 2
		expect(frames.length).toBe(2);
		expect(frames[0]).toContain("id: 1");
		expect(frames[1]).toContain("id: 2");
	});

	it("isolates replay per session", () => {
		const bus = new EventBus();
		bus.broadcast("s", entry("broadcast", "s-1")); // seq 1
		bus.broadcast("other", entry("broadcast", "o-1")); // seq 2
		bus.broadcast("s", entry("broadcast", "s-2")); // seq 3

		const { frames, controller } = fakeController();
		bus.subscribe("s", controller, undefined, "0"); // only session "s"
		expect(frames.length).toBe(2);
		expect(frames.every((f) => f.includes('"body":"s-'))).toBe(true);
	});

	it("respects event-type filters during replay and live delivery", () => {
		const bus = new EventBus();
		bus.broadcast("s", entry("broadcast", "keep")); // seq 1
		bus.broadcast("s", entry("phase", "drop")); // seq 2
		const { frames, controller } = fakeController();
		bus.subscribe("s", controller, ["broadcast"], "0");
		expect(frames.length).toBe(1);
		expect(frames[0]).toContain('"body":"keep"');
	});
});
