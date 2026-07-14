import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { IrcBus } from "../bus";
import type { IrcMessage } from "../bus";

describe("IrcBus - sendToGroup", () => {
	let bus: IrcBus;

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		bus = IrcBus.global();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
	});

	it("returns a map of receipts keyed by agent id", async () => {
		// sendToGroup delivers via send(), which resolves against AgentRegistry.
		// Without a real registry, sends will fail — but the method itself is
		// structurally correct (no throw before registry lookup).
		const result = await bus.sendToGroup(
			["agent-a", "agent-b"],
			{ from: "caller", body: "hello" },
		);
		expect(result).toBeInstanceOf(Map);
		expect(result.size).toBe(2);
		for (const [, receipt] of result) {
			expect(receipt.outcome).toBe("failed");
		}
	});

	it("handles empty agent list", async () => {
		const result = await bus.sendToGroup([], { from: "caller", body: "nobody" });
		expect(result.size).toBe(0);
	});
});

describe("IrcBus - collectResponses", () => {
	let bus: IrcBus;

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		bus = IrcBus.global();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
	});

	it("returns empty map when all recipients are unknown", async () => {
		const result = await bus.collectResponses(
			"caller",
			["ghost-a", "ghost-b"],
			{ from: "caller", body: "ping" },
			{},
			1000,
		);
		expect(result.size).toBe(0);
	});

	it("respects timeout (does not hang)", async () => {
		const start = Date.now();
		const result = await bus.collectResponses(
			"caller",
			["ghost"],
			{ from: "caller", body: "quick" },
			{},
			500,
		);
		expect(Date.now() - start).toBeLessThan(2000);
		expect(result.size).toBe(0);
	});

	it("honours AbortSignal", async () => {
		const controller = new AbortController();
		const promise = bus.collectResponses(
			"caller",
			["ghost"],
			{ from: "caller", body: "abort-me" },
			{},
			30_000,
			controller.signal,
		);
		controller.abort(new Error("test abort"));
		await promise; // should resolve/reject without hanging
	});
});
