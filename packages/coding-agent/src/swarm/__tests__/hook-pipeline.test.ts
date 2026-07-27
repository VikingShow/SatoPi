/**
 * Unit tests for HookPipeline and shared hook utilities.
 *
 * Covers: priority ordering, phase filtering, error isolation,
 * short-circuit on false return, register/unregister, no-op
 * empty trigger, and resolveAgentId().
 *
 * @module __tests__/hook-pipeline.test
 */

import { describe, expect, it } from "bun:test";
import { HookPipeline } from "../hook-system/hook-pipeline";
import type { HookContext, HookEvent, HookPayloadMap, HookRegistration } from "../hook-system/types";
import { resolveAgentId } from "../hook-system/utils";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal HookContext with an optional phase. */
function ctx(phase?: string, extra?: Record<string, unknown>): HookContext {
	return { phase: phase as HookContext["phase"], ...extra };
}

/**
 * Create a simple test hook registration.
 *
 * @param name      - Unique hook name.
 * @param priority  - Execution priority (lower = earlier).
 * @param fn        - Handler function. If omitted, a no-op is used.
 * @param opts      - Optional events / phases override.
 */
function makeHook(
	name: string,
	priority: number,
	fn?: HookRegistration["handler"],
	opts?: { events?: HookEvent[]; phases?: string[] },
): HookRegistration {
	return {
		name,
		priority,
		events: opts?.events ?? ["agent:beforeSpawn"],
		phases: opts?.phases as HookRegistration["phases"],
		handler:
			fn ??
			(async () => {
				/* no-op */
			}),
	};
}

/**
 * Create a hook that records execution order into an array.
 *
 * @param name     - Unique hook name.
 * @param priority - Execution priority.
 * @param order    - Shared array to push into.
 * @param events   - Events to subscribe to.
 */
function makeRecordingHook(name: string, priority: number, order: string[], events?: HookEvent[]): HookRegistration {
	return {
		name,
		priority,
		events: events ?? ["agent:beforeSpawn"],
		handler: async () => {
			order.push(name);
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HookPipeline", () => {
	// -----------------------------------------------------------------------
	// Priority ordering
	// -----------------------------------------------------------------------

	describe("priority ordering", () => {
		it("executes hooks in ascending priority order", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			pipeline.register(makeRecordingHook("mid", 5, order));
			pipeline.register(makeRecordingHook("low", 10, order));
			pipeline.register(makeRecordingHook("high", 0, order));

			await pipeline.trigger("agent:beforeSpawn", { agentId: "a1", role: "worker", task: "test" }, ctx("script"));

			expect(order).toEqual(["high", "mid", "low"]);
		});

		it("handles hooks with equal priority (stable registration order)", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			pipeline.register(makeRecordingHook("a", 5, order));
			pipeline.register(makeRecordingHook("b", 5, order));
			pipeline.register(makeRecordingHook("c", 5, order));

			await pipeline.trigger("agent:beforeSpawn", { agentId: "a1", role: "worker", task: "test" }, ctx("script"));

			// All three executed
			expect(order).toContain("a");
			expect(order).toContain("b");
			expect(order).toContain("c");
			expect(order.length).toBe(3);
		});
	});

	// -----------------------------------------------------------------------
	// Phase filtering
	// -----------------------------------------------------------------------

	describe("phase filtering", () => {
		it("executes hooks only when the current phase matches", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			const withFilter = makeRecordingHook("filtered", 0, order, ["workflow:beforePhase"]);
			// Cast is needed because phases is a readonly string literal union
			(withFilter as { phases?: string[] }).phases = ["script", "curtain"];

			const noFilter = makeRecordingHook("unfiltered", 1, order, ["workflow:beforePhase"]);

			pipeline.register(withFilter);
			pipeline.register(noFilter);

			// Trigger in "stage" — only unfiltered hook should fire
			await pipeline.trigger("workflow:beforePhase", {} as HookPayloadMap["workflow:beforePhase"], ctx("stage"));
			expect(order).toEqual(["unfiltered"]);

			// Reset
			order.length = 0;

			// Trigger in "script" — both should fire (filtered in order)
			await pipeline.trigger("workflow:beforePhase", {} as HookPayloadMap["workflow:beforePhase"], ctx("script"));
			expect(order).toEqual(["filtered", "unfiltered"]);
		});

		it("skips hook when phase is undefined and hook has phase filter", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			const filteredHook = makeRecordingHook("filtered", 0, order, ["workflow:beforePhase"]);
			(filteredHook as { phases?: string[] }).phases = ["script"];

			pipeline.register(filteredHook);

			// Trigger without phase — hook should be skipped
			await pipeline.trigger("workflow:beforePhase", {} as HookPayloadMap["workflow:beforePhase"], ctx(undefined));

			expect(order).toEqual([]);
		});

		it("skips when phase filter is empty array", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			const hook: HookRegistration = {
				name: "empty-phase-filter",
				priority: 0,
				events: ["workflow:beforePhase"],
				phases: [],
				handler: async () => {
					order.push("empty-phase-filter");
				},
			};

			pipeline.register(hook);

			await pipeline.trigger("workflow:beforePhase", {} as HookPayloadMap["workflow:beforePhase"], ctx("script"));

			// Empty phases array should skip
			expect(order).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------
	// Error isolation
	// -----------------------------------------------------------------------

	describe("error isolation", () => {
		it("continues to next hook when a handler throws", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			pipeline.register(
				makeHook("throws", 0, async () => {
					throw new Error("boom");
				}),
			);
			pipeline.register(makeRecordingHook("survivor", 1, order));

			// Should not throw
			await pipeline.trigger("agent:beforeSpawn", { agentId: "a1", role: "worker", task: "test" }, ctx("script"));

			expect(order).toEqual(["survivor"]);
		});

		it("executes all non-throwing hooks despite multiple failures", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			pipeline.register(
				makeHook("fail-1", 0, async () => {
					throw new Error("fail 1");
				}),
			);
			pipeline.register(makeRecordingHook("ok-1", 1, order));
			pipeline.register(
				makeHook("fail-2", 2, async () => {
					throw new Error("fail 2");
				}),
			);
			pipeline.register(makeRecordingHook("ok-2", 3, order));

			await pipeline.trigger("agent:beforeSpawn", { agentId: "a1", role: "worker", task: "test" }, ctx("script"));

			expect(order).toEqual(["ok-1", "ok-2"]);
		});
	});

	// -----------------------------------------------------------------------
	// Return false (short-circuit)
	// -----------------------------------------------------------------------

	describe("short-circuit on return false", () => {
		it("stops remaining hooks when a handler returns false", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			pipeline.register(makeRecordingHook("first", 0, order));
			pipeline.register(makeHook("stopper", 1, async () => false));
			pipeline.register(makeRecordingHook("skipped", 2, order));

			await pipeline.trigger("agent:beforeSpawn", { agentId: "a1", role: "worker", task: "test" }, ctx("script"));

			expect(order).toEqual(["first"]);
			// "skipped" should NOT be in order
			expect(order).not.toContain("skipped");
		});

		it("does not short-circuit when handler returns true", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			pipeline.register(makeRecordingHook("first", 0, order));
			pipeline.register(makeHook("pass-through", 1, async () => true));
			pipeline.register(makeRecordingHook("second", 2, order));

			await pipeline.trigger("agent:beforeSpawn", { agentId: "a1", role: "worker", task: "test" }, ctx("script"));

			expect(order).toEqual(["first", "second"]);
		});
	});

	// -----------------------------------------------------------------------
	// Register / unregister
	// -----------------------------------------------------------------------

	describe("register / unregister", () => {
		it("registers hooks and lists them sorted by priority", () => {
			const pipeline = new HookPipeline();
			pipeline.register(makeHook("low", 100));
			pipeline.register(makeHook("high", 10));
			pipeline.register(makeHook("mid", 50));

			const hooks = pipeline.list();
			expect(hooks.length).toBe(3);
			expect(hooks[0].name).toBe("high");
			expect(hooks[1].name).toBe("mid");
			expect(hooks[2].name).toBe("low");
		});

		it("unregisters a hook by name", () => {
			const pipeline = new HookPipeline();
			pipeline.register(makeHook("keep", 0));
			pipeline.register(makeHook("remove", 1));

			pipeline.unregister("remove");

			const hooks = pipeline.list();
			expect(hooks.length).toBe(1);
			expect(hooks[0].name).toBe("keep");
		});

		it("unregister is a no-op for unknown names", () => {
			const pipeline = new HookPipeline();
			pipeline.register(makeHook("only", 0));

			pipeline.unregister("nonexistent");

			expect(pipeline.list().length).toBe(1);
		});

		it("overwrites hook with same name on re-register", () => {
			const pipeline = new HookPipeline();
			const first = makeHook("dup", 0, async () => {
				/* v1 */
			});
			const second = makeHook("dup", 99, async () => {
				/* v2 */
			});

			pipeline.register(first);
			pipeline.register(second);

			const hooks = pipeline.list();
			expect(hooks.length).toBe(1);
			expect(hooks[0].priority).toBe(99);
		});

		it("unregistered hooks do not fire on trigger", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			pipeline.register(makeRecordingHook("to-remove", 0, order));
			pipeline.register(makeRecordingHook("keeper", 1, order));

			pipeline.unregister("to-remove");

			await pipeline.trigger("agent:beforeSpawn", { agentId: "a1", role: "worker", task: "test" }, ctx("script"));

			expect(order).toEqual(["keeper"]);
			expect(order).not.toContain("to-remove");
		});
	});

	// -----------------------------------------------------------------------
	// Empty trigger (no-op)
	// -----------------------------------------------------------------------

	describe("empty trigger", () => {
		it("is a no-op when no hooks match the event", async () => {
			const pipeline = new HookPipeline();

			// Register a hook that listens for a different event
			pipeline.register(makeHook("other-event", 0));

			// Triggering an unmatched event should be a no-op
			await pipeline.trigger(
				"agent:afterComplete",
				{ agentId: "a1" } as HookPayloadMap["agent:afterComplete"],
				ctx("script"),
			);
			// No assertions needed — just ensuring no throw
		});

		it("is a no-op when no hooks are registered at all", async () => {
			const pipeline = new HookPipeline();

			await pipeline.trigger("agent:beforeSpawn", { agentId: "a1", role: "worker", task: "test" }, ctx("script"));
			// No assertions needed
		});

		it("list() returns empty array when no hooks registered", () => {
			const pipeline = new HookPipeline();
			expect(pipeline.list()).toEqual([]);
		});
	});

	// -----------------------------------------------------------------------
	// Event matching (integration)
	// -----------------------------------------------------------------------

	describe("event matching", () => {
		it("only fires hooks that subscribe to the triggered event", async () => {
			const pipeline = new HookPipeline();
			const order: string[] = [];

			pipeline.register(makeRecordingHook("spawn-only", 0, order, ["agent:beforeSpawn"]));
			pipeline.register(makeRecordingHook("complete-only", 1, order, ["agent:afterComplete"]));
			pipeline.register(makeRecordingHook("multi", 2, order, ["agent:beforeSpawn", "agent:afterComplete"]));

			// Trigger spawn
			await pipeline.trigger("agent:beforeSpawn", { agentId: "a1", role: "worker", task: "test" }, ctx("script"));
			expect(order).toEqual(["spawn-only", "multi"]);

			order.length = 0;

			// Trigger error — no hooks match
			await pipeline.trigger("agent:onError", { agentId: "a1", error: "test error" }, ctx("script"));
			expect(order).toEqual([]);
		});
	});
});

// ===========================================================================
// resolveAgentId tests (Phase B1)
// ===========================================================================

describe("resolveAgentId", () => {
	it("returns agentId from payload when it is a string", () => {
		const result = resolveAgentId({ agentId: "agent-1" }, { agentId: "agent-2" });
		expect(result).toBe("agent-1");
	});

	it("falls back to ctx.agentId when payload.agentId is not a string", () => {
		const result = resolveAgentId({ agentId: 42 }, { agentId: "ctx-agent" });
		expect(result).toBe("ctx-agent");
	});

	it("falls back to ctx.agentId when payload has no agentId", () => {
		const result = resolveAgentId({}, { agentId: "ctx-agent" });
		expect(result).toBe("ctx-agent");
	});

	it("returns undefined when neither source provides a string agentId", () => {
		const result = resolveAgentId({}, {});
		expect(result).toBeUndefined();
	});

	it("returns undefined when payload.agentId is null", () => {
		const result = resolveAgentId({ agentId: null }, {});
		expect(result).toBeUndefined();
	});

	it("returns undefined when both payload and ctx agentId are numbers", () => {
		const result = resolveAgentId({ agentId: 123 }, { agentId: 456 });
		expect(result).toBeUndefined();
	});

	it("returns undefined when ctx has no agentId and payload agentId is not string", () => {
		const result = resolveAgentId({ agentId: true }, {});
		expect(result).toBeUndefined();
	});

	it("returns undefined with empty objects for both arguments", () => {
		const result = resolveAgentId({}, {});
		expect(result).toBeUndefined();
	});

	it("prefers payload.agentId even when ctx also has agentId", () => {
		const result = resolveAgentId(
			{ agentId: "payload-agent" },
			{ agentId: "ctx-agent", phase: "stage" as HookContext["phase"] },
		);
		expect(result).toBe("payload-agent");
	});
});
